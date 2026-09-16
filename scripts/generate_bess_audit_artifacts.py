#!/usr/bin/env python3
"""Generate live BESS audit artifacts (warranty dossier + optimizer audit) for
DB-backed BESS/HYBRID plants and persist them to AnalysisArtifact, with the
rendered PDFs uploaded to S3.

Telemetry source is the MODELLED dispatch twin (no BMS telemetry exists for
DB plants): hourly power/SoC/price series are reconstructed from
BessDispatchSchedule, so every payload carries
{"telemetry_source": "modelled_dispatch_twin", "provisional": true} and the
UI must render the provisional banner. The optimizer audit is therefore a
STRATEGY BENCHMARK — the platform's dispatch vs per-day perfect foresight on
the same real day-ahead prices — never a claim about measured plant behaviour.

Usage:
    python scripts/generate_bess_audit_artifacts.py --plant region_a-storage
    python scripts/generate_bess_audit_artifacts.py --all [--days 120] [--skip-pdf] [--dry-run]

Prod: export the prod DATABASE_URL explicitly. Runs weekly via
.github/workflows/bess-audit.yml.
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.bess.config import BessAssetConfig, BessChemistry, WarrantyTermsConfig  # noqa: E402
from nuravolt.bess.dossier import build_warranty_dossier  # noqa: E402
from nuravolt.bess.optimizer_audit import AuditAssetSpec, run_optimizer_audit  # noqa: E402
from nuravolt.bess.report_generator import (  # noqa: E402
    generate_optimizer_audit_pdf,
    generate_warranty_dossier_pdf,
)

MODEL_VERSION = "bess-audit-v1"
S3_BUCKET = os.environ.get("LAKE_BUCKET", "nuravolt-lake")


def clean_dsn(dsn: str) -> str:
    parts = urlsplit(dsn)
    keep = [(k, v) for k, v in parse_qsl(parts.query)
            if k in ("sslmode", "sslrootcert", "sslcert", "sslkey", "options")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(keep), parts.fragment))


def jsonable(obj):
    """Round-trip through json to normalize numpy/dates for the Json column.
    NaN/Infinity become null — Python's json emits bare NaN literals that
    Postgres jsonb rejects."""
    return json.loads(json.dumps(obj, default=str), parse_constant=lambda _: None)


def fetch_plants(conn, ident, all_bess):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if all_bess:
            cur.execute(
                'SELECT id, slug, name FROM "Plant" '
                "WHERE asset_type IN ('BESS', 'HYBRID') ORDER BY slug"
            )
            return list(cur.fetchall())
        cur.execute(
            'SELECT id, slug, name FROM "Plant" WHERE id::text = %s OR slug = %s',
            (ident, ident),
        )
        row = cur.fetchone()
        if not row:
            sys.exit(f"plant not found: {ident}")
        return [row]


def fetch_primary_asset(conn, plant_id):
    """The /bess page and the unified API serve the first asset by creation —
    the audit artifact mirrors that choice."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT * FROM "BessAsset" WHERE plant_id = %s ORDER BY created_at ASC LIMIT 1',
            (plant_id,),
        )
        return cur.fetchone()


def fetch_terms(conn, asset_id):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "BessWarrantyTerms" WHERE asset_id = %s', (asset_id,))
        return cur.fetchone()


def fetch_capacity_tests(conn, asset_id):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT test_date, measured_capacity_kwh, soh_result, test_type '
            'FROM "BessCapacityTest" WHERE asset_id = %s ORDER BY test_date',
            (asset_id,),
        )
        return [
            {
                "test_date": r["test_date"].isoformat(),
                "measured_capacity_kwh": float(r["measured_capacity_kwh"]),
                "soh_result": float(r["soh_result"]),
                "test_type": r["test_type"],
            }
            for r in cur.fetchall()
        ]


def dispatch_rows_to_telemetry(rows) -> pd.DataFrame:
    """Pure transform: dispatch-schedule rows (oldest first) → telemetry frame
    at each row's own settlement resolution. Sign convention: positive power =
    discharge (the dossier pipeline's contract); charge stored as negative
    power is normalized. Prices are the real day-ahead curves the optimizer
    ran on.

    Slots are stepped by the row's resolution_minutes, never assumed hourly:
    Iberian days now clear at the 15 minute MTU (96 slots) and GB at 30
    minutes (48 slots), and building datetime(..., hour=slot) crashed at slot
    24 with "hour must be in 0..23". Rows written before the column existed
    fall back to inferring the resolution from the slot count.

    The whole frame is emitted at ONE resolution, the finest any row carries,
    with coarser rows held constant across their sub-slots. This is not
    cosmetic: nuravolt/bess/optimizer_audit.py derives a single dt_hours from
    the median index step, so a frame mixing 60 and 15 minute days mis-sizes
    the minority resolution's energy by 4x and the capture ratio comes out as
    nonsense (measured: -13.77 against the 0.62 the revenue-assurance path
    computes for the same asset). Holding an hourly slot constant over its
    quarter-hours is exactly what an hourly schedule means, so no energy or
    price information is invented by the upsample.
    """

    def _row_resolution(r) -> int:
        n_slots = min(len(r["charge_schedule_kw"] or []), len(r["discharge_schedule_kw"] or []))
        if not n_slots:
            return 0
        res_min = int(r.get("resolution_minutes") or 0)
        if res_min <= 0 or 1440 % res_min:
            # Infer from the slot count when the column is absent or junk; a
            # day whose slots do not tile 24 hours is skipped rather than
            # timestamped wrongly.
            if 1440 % n_slots:
                return 0
            res_min = 1440 // n_slots
        return res_min

    resolutions = [m for m in (_row_resolution(r) for r in rows) if m > 0]
    if not resolutions:
        return pd.DataFrame([])
    finest = min(resolutions)

    records = []
    for r in rows:
        res_min = _row_resolution(r)
        if res_min == 0:
            continue
        day = r["schedule_date"]
        charge = r["charge_schedule_kw"] or []
        discharge = r["discharge_schedule_kw"] or []
        soc = r["soc_schedule"] or []
        price = r["price_forecast"] or []
        n_slots = min(len(charge), len(discharge))
        repeat = res_min // finest
        day_start = datetime(day.year, day.month, day.day)
        for slot in range(n_slots):
            ch = float(charge[slot])
            dis = float(discharge[slot])
            charge_kw = abs(ch) if ch < 0 else ch
            power = dis - charge_kw
            soc_v = float(soc[slot]) if slot < len(soc) else None
            price_v = float(price[slot]) if slot < len(price) else None
            for sub in range(repeat):
                records.append(
                    {
                        "timestamp": day_start
                        + timedelta(minutes=slot * res_min + sub * finest),
                        "power_kw": power,
                        "soc": soc_v,
                        "price_eur_mwh": price_v,
                    }
                )
    return pd.DataFrame(records)


def reconstruct_telemetry(conn, asset_id, days):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT schedule_date, charge_schedule_kw, discharge_schedule_kw, '
            '       soc_schedule, price_forecast, resolution_minutes, currency '
            'FROM "BessDispatchSchedule" WHERE asset_id = %s '
            "ORDER BY schedule_date DESC LIMIT %s",
            (asset_id, days),
        )
        rows = list(cur.fetchall())
    rows.reverse()
    # The newest row's settlement currency is the asset's: a GB battery clears
    # in GBP and its audit must never be printed or persisted under EUR.
    currency = str(rows[-1].get("currency") or "EUR") if rows else "EUR"
    return dispatch_rows_to_telemetry(rows), currency


def build_terms_config(terms_row):
    if not terms_row:
        return None
    kwargs = {
        "capacity_guarantee_pct": float(terms_row["capacity_guarantee_pct"]),
        "warranty_years": int(terms_row["warranty_years"]),
    }
    optional = {
        "max_cycles": ("max_cycles", int),
        "max_throughput_mwh": ("max_throughput_mwh", float),
        "min_rte": ("min_rte", float),
        "max_avg_soc": ("max_avg_soc", float),
        "min_soc": ("min_soc", float),
        "soc_hold_limit_hours": ("soc_hold_limit_hours", int),
        "operating_temp_min_c": ("operating_temp_min_c", float),
        "operating_temp_max_c": ("operating_temp_max_c", float),
        "temp_violation_minutes": ("temp_violation_minutes", int),
    }
    for attr, (col, cast) in optional.items():
        if terms_row.get(col) is not None:
            kwargs[attr] = cast(terms_row[col])
    return WarrantyTermsConfig(**kwargs)


def upload_pdf(local_path: Path, key: str) -> bool:
    try:
        import boto3

        boto3.client("s3", region_name=os.environ.get("AWS_REGION", "eu-west-1")).upload_file(
            str(local_path), S3_BUCKET, key, ExtraArgs={"ContentType": "application/pdf"}
        )
        return True
    except Exception as exc:  # noqa: BLE001 — PDF upload is best-effort
        print(f"  ! PDF upload failed for {key}: {exc}")
        return False


def upsert_artifact(conn, plant_id, kind, payload, dry_run):
    if dry_run:
        print(f"  dry-run: would upsert {kind} ({len(json.dumps(payload))} bytes)")
        return
    with conn.cursor() as cur:
        cur.execute(
            'INSERT INTO "AnalysisArtifact" (id, plant_id, kind, payload, source, model_version, generated_at, updated_at) '
            "VALUES (gen_random_uuid(), %s, %s, %s, 'computed', %s, NOW(), NOW()) "
            'ON CONFLICT (plant_id, kind) DO UPDATE SET '
            "payload = EXCLUDED.payload, source = 'computed', "
            "model_version = EXCLUDED.model_version, generated_at = NOW(), updated_at = NOW()",
            (plant_id, kind, json.dumps(payload), MODEL_VERSION),
        )
    conn.commit()


def process_plant(conn, plant, days, skip_pdf, dry_run):
    asset = fetch_primary_asset(conn, plant["id"])
    if not asset:
        print(f"{plant['slug']}: no BESS assets — skipped")
        return

    telemetry, settlement_currency = reconstruct_telemetry(conn, asset["id"], days)
    if telemetry.empty or len(telemetry) < 24 * 14:
        print(f"{plant['slug']}: <14 days of dispatch history — skipped")
        return

    terms_row = fetch_terms(conn, asset["id"])
    tests = fetch_capacity_tests(conn, asset["id"])
    try:
        chemistry = BessChemistry(asset["chemistry"])
    except ValueError:
        chemistry = BessChemistry.LFP

    # psycopg2 returns DATE columns as datetime.date; the pipeline subtracts
    # them from datetimes, so promote.
    installed = asset["installation_date"]
    if installed is not None and not isinstance(installed, datetime):
        installed = datetime(installed.year, installed.month, installed.day)

    asset_cfg = BessAssetConfig(
        asset_id=asset["external_asset_id"],
        plant_id=plant["slug"],
        name=asset["name"] or asset["external_asset_id"],
        chemistry=chemistry,
        nominal_capacity_kwh=float(asset["nominal_capacity_kwh"]),
        nominal_power_kw=float(asset["nominal_power_kw"]),
        installation_date=installed,
        manufacturer=asset["manufacturer"],
        model=asset["model"],
    )

    price_source = "day_ahead_stored"
    meta = asset.get("metadata") or {}
    if isinstance(meta, dict) and meta.get("price_source"):
        price_source = str(meta["price_source"])
    provenance = {
        "telemetry_source": "modelled_dispatch_twin",
        "provisional": True,
        "price_source": price_source,
        "asset_id": asset["external_asset_id"],
        "asset_db_id": asset["id"],
        "days": int(telemetry["timestamp"].dt.date.nunique()),
        "generated_by": MODEL_VERSION,
    }

    # ── Warranty dossier ────────────────────────────────────────────────
    dossier = build_warranty_dossier(
        telemetry=telemetry[["timestamp", "power_kw", "soc"]],
        asset=asset_cfg,
        terms=build_terms_config(terms_row),
        capacity_tests=tests or None,
    )
    dossier["provenance"] = provenance
    dossier["evidence"]["methodology"] = (
        dossier["evidence"].get("methodology", "")
        + " Telemetry is the platform's modelled dispatch twin reconstructed from "
        "stored dispatch schedules (no BMS telemetry connected); capacity tests "
        "and warranty terms are database records."
    )

    # ── Optimizer audit (strategy benchmark) ────────────────────────────
    prices = (
        telemetry[["timestamp", "price_eur_mwh"]]
        .dropna()
        .rename(columns={"price_eur_mwh": "price_eur_mwh"})
        .set_index("timestamp")
    )
    prices.attrs["price_source"] = price_source
    prices.attrs["zone"] = meta.get("zone", "ES") if isinstance(meta, dict) else "ES"
    tele_indexed = telemetry.set_index("timestamp")

    spec = AuditAssetSpec(
        capacity_kwh=float(asset["nominal_capacity_kwh"]),
        max_power_kw=float(asset["nominal_power_kw"]),
        asset_name=asset_cfg.name,
    )
    audit = run_optimizer_audit(tele_indexed, prices, spec, power_col="power_kw", soc_col="soc")
    audit_dict = audit.to_dict()
    audit_dict.setdefault("summary", {})["currency"] = settlement_currency
    dossier["currency"] = settlement_currency
    audit_dict["provenance"] = {
        **provenance,
        "framing": (
            "Strategy benchmark: the platform's modelled dispatch vs per-day "
            "perfect foresight on the same day-ahead prices. Not a measurement "
            "of plant hardware behaviour."
        ),
    }

    # ── PDFs to S3 ──────────────────────────────────────────────────────
    if not skip_pdf and not dry_run:
        with tempfile.TemporaryDirectory() as tmp:
            dossier_pdf = Path(tmp) / "warranty_dossier.pdf"
            audit_pdf = Path(tmp) / "optimizer_audit.pdf"
            try:
                generate_warranty_dossier_pdf(dossier, dossier_pdf)
                key = f"audit/{plant['slug']}/warranty_degradation_dossier.pdf"
                if upload_pdf(dossier_pdf, key):
                    dossier["pdf_s3_key"] = key
            except Exception as exc:  # noqa: BLE001
                print(f"  ! dossier PDF failed: {exc}")
            try:
                generate_optimizer_audit_pdf(audit_dict, audit_pdf)
                key = f"audit/{plant['slug']}/optimizer_performance_audit.pdf"
                if upload_pdf(audit_pdf, key):
                    audit_dict["pdf_s3_key"] = key
            except Exception as exc:  # noqa: BLE001
                print(f"  ! audit PDF failed: {exc}")

    upsert_artifact(conn, plant["id"], "bess_warranty_dossier", jsonable(dossier), dry_run)
    upsert_artifact(conn, plant["id"], "bess_optimizer_audit", jsonable(audit_dict), dry_run)

    hs = dossier.get("health_score", {})
    summ = audit_dict.get("summary", {})
    print(
        f"{plant['slug']}: dossier health={hs.get('score')} violations={len(dossier.get('violations', []))} | "
        f"audit capture={summ.get('capture_ratio')} gap_eur={summ.get('revenue_gap_eur')} "
        f"days={summ.get('days_analyzed', '?')} skipped={summ.get('days_skipped', '?')}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", help="plant slug or uuid")
    ap.add_argument("--all", action="store_true", help="every BESS/HYBRID plant")
    ap.add_argument("--days", type=int, default=120, help="dispatch-history depth (default 120)")
    ap.add_argument("--skip-pdf", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.plant and not args.all:
        sys.exit("pass --plant <slug> or --all")

    load_dotenv(PROJECT_ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    conn = psycopg2.connect(clean_dsn(dsn))
    try:
        for plant in fetch_plants(conn, args.plant, args.all):
            try:
                process_plant(conn, plant, args.days, args.skip_pdf, args.dry_run)
            except Exception as exc:  # noqa: BLE001 — one plant must not kill the run
                conn.rollback()
                print(f"{plant['slug']}: FAILED — {exc}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
