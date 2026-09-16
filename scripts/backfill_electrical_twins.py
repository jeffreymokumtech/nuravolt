#!/usr/bin/env python3
"""Backfill REAL electrical digital twins (temperature / DC current / DC voltage)
from the bronze lakehouse into a plant's analysis_results.

Replaces the fabricated `electrical-synth-v1` channels (scripts/synth_electrical_twins.py
runs a closed-form physics formula off the power number — BOTH predicted and
"actual" are synthetic, so the residual is meaningless) with the genuine
measured-vs-modeled twins that already live in bronze:

    bronze.twin_temperature_<plant>    per-inverter  temperature_{actual,predicted,residual}
    bronze.twin_string_current_<plant> per-string    current_dc_{actual,predicted,residual}
    bronze.twin_mppt_voltage_<plant>   per-MPPT       mppt_N_voltage_{actual,predicted,residual}

`_actual` is measured SCADA reshaped to tidy hourly form, `_predicted` is the
physics-ML twin expectation, `_residual = actual - predicted`. Hourly,
2021-10-01 -> 2025-12-14 for Ribera (flagship `ribera-solar`).

Alignment with the existing power channel (the load-bearing correctness point):
  - The prod power_ac channel is the ML history (`hybrid-catboost-v1`, written by
    scripts/backfill_ml_twin_history.py) shifted +1 CALENDAR YEAR so the ~5-year
    donor history abuts the live physics tail. Electrical rows MUST land on the
    SAME device_ids and the SAME dates or the panels won't overlay. So we apply
    the identical +1y shift (Feb-29 dropped BEFORE shifting to avoid leap
    saturation) and map bronze's 120 physical inverters onto the prod inverter
    set (INV-01..24) 5:1, in sorted order — exactly as the power backfill did.
  - Bronze device_id `INV 01.032` (space+dot, 120 inverters); prod
    analysis_results device_id `INV-NN` (hyphen, 24 inverters). units_per = 120/24 = 5.

No seam entanglement: the nightly physics twin (twin.py) writes only `power_ac_*`,
never electrical metrics, so electrical twins have NOTHING to collide with in the
live tail. We therefore write real electrical right up to `today` (bronze shifted
+1y reaches 2026-12-14, capped at today), which FILLS the default 30-day view
with real data — unlike power, electrical has no physics tail to fence off.

Aggregation (per prod inverter, per day, daytime hours 05-18 UTC — matches the
pipeline's daylight window and dodges the dawn/dusk ramp artifacts):
  - temperature: mean across the 5 physical inverters (operating cabinet temp).
  - current_dc:  SUM across a physical inverter's 12 strings, then SUM across the
                 5 physical inverters (an INV-NN is 5 x 60 kW = 300 kW, ~500 A).
  - voltage_dc:  MEAN across a physical inverter's 6 MPPTs, then MEAN across the 5
                 (parallel strings sit at ~the same DC voltage; route documents
                 voltage_dc = "mean DC voltage across MPPTs").
  `actual` is emitted only when the WHOLE aggregate reported (all strings/MPPTs of
  all 5 physical inverters) so a partial-fleet actual vs a full-fleet prediction
  never fabricates a phantom residual. `predicted` is emitted whenever the twin
  predicted (it always does in daylight).

Provenance: rows tagged model_version='multi-signal-v1' (physics-ML hybrid, the
multi_signal_twin family), deterministic run_id = uuid5("electrical-backfill:{plant_id}").
The fake `electrical-synth-v1` rows are DELETED FIRST (before writing real ones):
they overlap the real rows in (device, day, metric) under a different run_id, and
reads never filter by run_id, so leaving both would SUM them -> doubled channels.
Rollback = DELETE ... WHERE model_version='multi-signal-v1' AND run_id=<that>.

Usage:
    LAKE_ENV=prod LAKE_BUCKET=nuravolt-lake \
      python scripts/backfill_electrical_twins.py --plant ribera-solar --dry-run
    (then drop --dry-run; export the prod DATABASE_URL explicitly and verify with psql)

Reads bronze via nuravolt/lake (DuckDB over Iceberg/Glue); needs AWS creds in the
env (loaded from .env). Prod DATABASE_URL for the writes.
"""

import argparse
import os
import sys
import uuid
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402

MODEL_VERSION = "multi-signal-v1"
SYNTH_MODEL_VERSION = "electrical-synth-v1"
DAY_LO, DAY_HI = 5, 18  # daytime UTC hour window (inclusive), matches twin.py daylight

# Per-channel config. `bronze_suffix` names the plant partition of the bronze
# table. `sub_agg` collapses sub-devices (strings/MPPTs) to a physical inverter;
# `prod_agg` collapses the 5 physical inverters to one prod inverter.
CHANNELS = {
    "temperature": {
        "table": "bronze.twin_temperature_{plant}",
        "phys_expr": "device_id",                       # device IS the inverter
        "kind_expr": "replace(metric, 'temperature_', '')",
        "metric_filter": "metric IN ('temperature_actual','temperature_predicted')",
        "sub_agg": "avg",   # n_sub = 1, avg == identity
        "prod_agg": "avg",
        "out_metric": "temperature",
    },
    "current_dc": {
        "table": "bronze.twin_string_current_{plant}",
        "phys_expr": "split_part(device_id, '.STR-', 1)",
        "kind_expr": "replace(metric, 'current_dc_', '')",
        "metric_filter": "metric IN ('current_dc_actual','current_dc_predicted')",
        "sub_agg": "sum",   # sum across strings
        "prod_agg": "sum",  # sum across the 5 physical inverters
        "out_metric": "current_dc",
    },
    "voltage_dc": {
        "table": "bronze.twin_mppt_voltage_{plant}",
        "phys_expr": "split_part(device_id, '.MPPT-', 1)",
        "kind_expr": "CASE WHEN metric LIKE '%_actual' THEN 'actual' "
                     "WHEN metric LIKE '%_predicted' THEN 'predicted' END",
        "metric_filter": "(metric LIKE 'mppt_%_voltage_actual' OR metric LIKE 'mppt_%_voltage_predicted')",
        "sub_agg": "avg",   # mean across MPPTs
        "prod_agg": "avg",  # mean across the 5 physical inverters
        "out_metric": "voltage_dc",
    },
}


def resolve_plant(conn, ident: str) -> str:
    with conn.cursor() as cur:
        cur.execute('SELECT id FROM "Plant" WHERE id::text = %s OR slug = %s', (ident, ident))
        row = cur.fetchone()
    if not row:
        sys.exit(f"plant not found: {ident}")
    return str(row[0])


def prod_power_inverters(conn, plant_id: str) -> list:
    """The device_ids that the power_ac channel actually uses (INV-NN), sorted.

    Ground truth for the target topology — the electrical rows must land on
    exactly this set so the panels overlay the power twin.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT device_id FROM analysis_results "
            "WHERE plant_id = %s AND domain = 'digitaltwin' "
            "AND metric = 'power_ac_predicted' AND device_id <> 'PLANT' "
            "ORDER BY device_id",
            (plant_id,),
        )
        return [r[0] for r in cur.fetchall()]


def build_channel_sql(src: str, cfg: dict, units_per: int) -> str:
    """DuckDB SQL: bronze hourly -> (prod_idx, orig_date, predicted, actual).

    prod_idx is 1-based (1..n_prod); the caller maps it to the real INV-NN id.
    `actual` is non-null only when the full aggregate reported that day.
    """
    phys = cfg["phys_expr"]
    return f"""
    WITH base AS (
        SELECT time, {phys} AS phys, {cfg['kind_expr']} AS kind, value
        FROM iceberg_scan('{src}')
        WHERE extract('hour' FROM time) BETWEEN {DAY_LO} AND {DAY_HI}
          AND NOT (extract('month' FROM time) = 2 AND extract('day' FROM time) = 29)
          AND {cfg['metric_filter']}
    ),
    n AS (SELECT COUNT(DISTINCT phys) AS n_phys FROM base),
    -- expected sub-devices per physical inverter (12 strings / 6 MPPTs / 1)
    subn AS (
        SELECT phys, COUNT(DISTINCT device_id) AS n_sub
        FROM (SELECT {phys} AS phys, device_id FROM iceberg_scan('{src}')) GROUP BY phys
    ),
    sub_hour AS (  -- collapse sub-devices to a physical inverter, per hour
        SELECT b.time, b.phys,
               {cfg['sub_agg']}(value) FILTER (WHERE kind = 'predicted') AS pred,
               {cfg['sub_agg']}(value) FILTER (WHERE kind = 'actual')    AS act,
               COUNT(*) FILTER (WHERE kind = 'actual')                    AS nact,
               COUNT(*) FILTER (WHERE kind = 'predicted')                 AS npred,
               ANY_VALUE(s.n_sub)                                         AS n_sub
        FROM base b JOIN subn s ON s.phys = b.phys
        GROUP BY b.time, b.phys
    ),
    map AS (  -- 120 physical inverters -> prod index 1..n_prod, sorted order, {units_per}:1
        SELECT phys,
               CAST(floor((ROW_NUMBER() OVER (ORDER BY phys) - 1) / {units_per}.0) AS INT) + 1 AS prod_idx
        FROM (SELECT DISTINCT phys FROM base)
    ),
    prod_hour AS (  -- collapse the {units_per} physical inverters to one prod inverter, per hour
        SELECT sh.time, m.prod_idx,
               {cfg['prod_agg']}(sh.pred) AS pred,
               {cfg['prod_agg']}(CASE WHEN sh.nact = sh.n_sub THEN sh.act END) AS act,
               COUNT(*) FILTER (WHERE sh.nact = sh.n_sub) AS nphys_full,
               COUNT(*) AS nphys
        FROM sub_hour sh JOIN map m ON m.phys = sh.phys
        GROUP BY sh.time, m.prod_idx
    )
    SELECT prod_idx,
           CAST(time AS DATE) AS d,
           avg(pred) AS predicted,
           avg(CASE WHEN nphys_full = nphys THEN act END) AS actual
    FROM prod_hour
    GROUP BY prod_idx, CAST(time AS DATE)
    ORDER BY prod_idx, d
    """


def shift_year(d: date) -> date:
    """+1 calendar year (Feb-29 already filtered upstream, so always valid)."""
    return date(d.year + 1, d.month, d.day)


def refresh_daily_aggregate(conn, lo: datetime, hi: datetime) -> None:
    """Refresh analysis_daily per calendar year (no-op off TimescaleDB)."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
        if not cur.fetchone():
            print("  (plain Postgres — analysis_daily is a live view, no refresh needed)")
            return
    conn.rollback()
    old = conn.autocommit
    conn.autocommit = True
    try:
        for year in range(lo.year, hi.year + 1):
            with conn.cursor() as cur:
                cur.execute(
                    "CALL refresh_continuous_aggregate('analysis_daily', %s, %s)",
                    (f"{year}-01-01", f"{year + 1}-01-01"),
                )
    finally:
        conn.autocommit = old


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", required=True, help="plant slug or uuid")
    ap.add_argument("--bronze-plant", default="ribera",
                    help="bronze table plant partition suffix (default ribera)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-synth", action="store_true",
                    help="do NOT delete the electrical-synth-v1 rows (debug only — leaves "
                         "both series, which DOUBLES the channels on read)")
    args = ap.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")  # AWS creds + local DATABASE_URL; won't override exported DSN
    os.environ.setdefault("LAKE_ENV", "prod")
    os.environ.setdefault("LAKE_BUCKET", "nuravolt-lake")
    os.environ.setdefault("AWS_REGION", "eu-west-1")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    # Lazy imports so --help works without AWS / duckdb.
    from nuravolt.lake.catalog import get_catalog
    from nuravolt.lake import _duckdb_iceberg_connection

    conn = psycopg2.connect(dsn)
    plant_id = resolve_plant(conn, args.plant)
    inv_ids = prod_power_inverters(conn, plant_id)
    n_prod = len(inv_ids)
    if n_prod == 0:
        sys.exit("no power_ac_predicted device rows for this plant — run the power backfill first")
    ml_run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"electrical-backfill:{plant_id}"))
    today_mid = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    print(f"plant {args.plant} ({plant_id}) — {n_prod} prod inverters "
          f"[{inv_ids[0]}..{inv_ids[-1]}], run_id={ml_run_id}")

    cat = get_catalog()

    # Build all records across the three channels.
    all_records = []
    for chan, cfg in CHANNELS.items():
        table_id = cfg["table"].format(plant=args.bronze_plant)
        try:
            tbl = cat.load_table(table_id)
        except Exception as e:
            sys.exit(f"cannot load {table_id}: {e!r}")
        src = tbl.metadata_location

        # n_phys / units_per from the actual bronze cardinality.
        con = _duckdb_iceberg_connection(s3=src.startswith("s3://"))
        try:
            n_phys = con.execute(
                f"SELECT COUNT(DISTINCT {cfg['phys_expr']}) FROM iceberg_scan('{src}')"
            ).fetchone()[0]
            units_per = max(1, n_phys // n_prod)
            if n_phys != n_prod * units_per:
                print(f"  WARN {chan}: {n_phys} physical inverters not divisible by "
                      f"{n_prod} prod ({units_per}:1) — trailing inverters unmapped")
            print(f"  {chan}: {table_id} — {n_phys} physical -> {n_prod} prod ({units_per}:1); aggregating…")
            rows = con.execute(build_channel_sql(src, cfg, units_per)).fetchall()
        finally:
            con.close()

        out = cfg["out_metric"]
        n_out = 0
        for prod_idx, d, predicted, actual in rows:
            if prod_idx < 1 or prod_idx > n_prod:
                continue  # unmapped trailing physical inverter
            dev = inv_ids[prod_idx - 1]
            sd = shift_year(d)                       # +1 calendar year (season-correct)
            t = datetime(sd.year, sd.month, sd.day, 12, tzinfo=timezone.utc)
            if t >= today_mid:                        # never write into the future
                continue
            if predicted is None:
                continue
            all_records.append({"time": t, "device_id": dev,
                                "metric": f"{out}_predicted", "value": round(float(predicted), 3)})
            if actual is not None:
                all_records.append({"time": t, "device_id": dev,
                                    "metric": f"{out}_actual", "value": round(float(actual), 3)})
                all_records.append({"time": t, "device_id": dev, "metric": f"{out}_residual",
                                    "value": round(float(actual) - float(predicted), 3)})
            n_out += 1
        print(f"    -> {n_out} device-days for {out}")

    if not all_records:
        sys.exit("no records built — check bronze coverage")

    times = [r["time"] for r in all_records]
    lo, hi = min(times), max(times)
    by_metric = defaultdict(int)
    for r in all_records:
        by_metric[r["metric"]] += 1
    print(f"\n  {len(all_records):,} rows, {lo.date()} -> {hi.date()}")
    for m in sorted(by_metric):
        print(f"    {m}: {by_metric[m]:,}")

    # Continuity eyeball: last 3 device-days for INV-01 per channel.
    sample_dev = inv_ids[0]
    for out in ("temperature", "current_dc", "voltage_dc"):
        pts = sorted(
            (r["time"].date(), r["value"]) for r in all_records
            if r["device_id"] == sample_dev and r["metric"] == f"{out}_predicted"
        )[-3:]
        print(f"  {sample_dev} {out}_predicted (last 3): " +
              ", ".join(f"{d}={v:.1f}" for d, v in pts))

    if args.dry_run:
        print(f"\n[dry-run] would DELETE {SYNTH_MODEL_VERSION} rows then upsert "
              f"{len(all_records):,} rows tagged {MODEL_VERSION}")
        conn.close()
        return

    # DELETE the fabricated synth channels FIRST — they overlap the real rows in
    # (device, day, metric) under a different run_id; keeping both would sum the
    # two series on read (reads ignore run_id) -> doubled channels.
    if not args.keep_synth:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM analysis_results WHERE plant_id = %s AND domain = 'digitaltwin' "
                "AND model_version = %s",
                (plant_id, SYNTH_MODEL_VERSION),
            )
            print(f"  deleted {cur.rowcount:,} {SYNTH_MODEL_VERSION} rows")
        conn.commit()

    # Write in per-calendar-month slices (one commit each).
    by_month = defaultdict(list)
    for r in all_records:
        by_month[(r["time"].year, r["time"].month)].append(r)
    writer = TimeseriesWriter(dsn=dsn)
    total = 0
    for ym in sorted(by_month):
        total += writer.write_analysis_results(
            plant_id, "digitaltwin", by_month[ym],
            model_version=MODEL_VERSION, run_id=ml_run_id,
        )
    print(f"  upserted {total:,} rows tagged {MODEL_VERSION}")
    refresh_daily_aggregate(writer.conn, lo, hi)
    writer.close()
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
