#!/usr/bin/env python
"""Plant-agnostic analytics onboarding (cold start).

Triggered by .github/workflows/plant-onboarding.yml (workflow_dispatch from
POST /api/plants) or run locally:

    python nuravolt/pipeline/onboard_plant.py --plant-id <uuid-or-slug> [--job-id <AnalyticsJob uuid>]

Cold-start policy (founder decision, 2026-07-05):
  - Digital twin: physics/foundation based, available day one.
  - Soiling: transfer estimate from the nearest / most similar climate zone
    (ClimatePrior from nuravolt.soiling.climate_regions), labeled provisional.

What it does:
  1. Load the Plant row (uuid or slug) from Postgres via DATABASE_URL.
  2. Mark the AnalyticsJob row running (creates one when --job-id is absent).
  3. Build a 365-day provisional soiling-ratio forecast from the plant's
     climate prior: monthly soiling rates accumulate, expected rain days
     partially reset the ratio, floors keep it physical.
  4. Upsert the forecast into analysis_results (domain='soiling',
     model_version='coldstart-v1', confidence=0.5) — the same rows the
     dashboard soiling routes already read.
  5. Flip Plant.status ONBOARDING -> TRAINING and mark the job succeeded.

No hardcoded plant ids. Idempotent: re-running refreshes the forecast.

--incremental (nightly refresh, not a cold start)
------------------------------------------------
The nightly sweep re-runs this script for every plant. For a plant that is
already OPERATIONAL, a full cold start is wrong: the coldstart soiling curve
and the demo synthesizers would overwrite output that later stages produced.
`--incremental` keeps the refresh arms (twin, quality analytics, power
forecast, battery) and skips the cold-start-only ones (coldstart soiling
forecast, fault synthesis, soiling stream synthesis, status transitions).

The battery arm branches on the asset's telemetry regime either way: the
modelled twin runs over the pre-connection window only, and the measured
materializer owns everything from `first_measured_date` on. See
`nuravolt/pipeline/bess_measured.py`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

try:  # optional in CI images until installed
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env")
except Exception:  # noqa: BLE001
    pass

import psycopg2  # noqa: E402
import psycopg2.extras  # noqa: E402

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402
from nuravolt.pipeline.twin import generate_twin  # noqa: E402
from nuravolt.soiling.climate_regions import prior_for_plant  # noqa: E402

MODEL_VERSION = "coldstart-v1"
FORECAST_DAYS = 365
SR_FLOOR = 0.80  # provisional forecasts never claim worse than 20% soiling loss
RAIN_RESET_SR = 0.995  # a rain day lifts SR back close to clean
CONFIDENCE = 0.5


def _connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")
    return psycopg2.connect(dsn)


def load_plant(conn, plant_ref: str) -> Optional[Dict[str, Any]]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            # `country` matters: it is what routes the battery twin to its
            # bidding zone (GB half-hourly sterling vs Iberian hourly euro).
            # Without it every plant silently priced as ES.
            'SELECT id, slug, name, latitude, longitude, capacity_mw, status, asset_type, country '
            'FROM "Plant" WHERE id = %s OR slug = %s LIMIT 1',
            (plant_ref, plant_ref),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def upsert_job(
    conn,
    job_id: Optional[str],
    plant_id: str,
    status: str,
    *,
    error: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
    finished: bool = False,
) -> str:
    github_run_id = os.environ.get("GITHUB_RUN_ID")
    with conn.cursor() as cur:
        if job_id is None:
            job_id = str(uuid.uuid4())
            cur.execute(
                'INSERT INTO "AnalyticsJob" (id, plant_id, job_type, status, github_run_id, detail) '
                "VALUES (%s, %s, 'onboarding', %s, %s, %s)",
                (job_id, plant_id, status, github_run_id, json.dumps(detail) if detail else None),
            )
        else:
            cur.execute(
                'UPDATE "AnalyticsJob" SET status = %s, error = %s, '
                "detail = COALESCE(%s::jsonb, detail), github_run_id = COALESCE(%s, github_run_id), "
                "finished_at = CASE WHEN %s THEN NOW() ELSE finished_at END WHERE id = %s",
                (
                    status,
                    error,
                    json.dumps(detail) if detail else None,
                    github_run_id,
                    finished,
                    job_id,
                ),
            )
    conn.commit()
    return job_id


def build_coldstart_forecast(
    plant_slug: str, latitude: float, longitude: float, days: int = FORECAST_DAYS
) -> List[Dict[str, Any]]:
    """Daily SR curve from the climate-zone transfer prior.

    Monthly soiling rates accumulate day by day; expected rain days (spread
    evenly through each month) lift the ratio back toward clean. This is the
    documented nearest-climate-analog transfer, not a plant-trained model —
    hence coldstart model_version + low confidence.
    """
    prior = prior_for_plant(plant_slug, latitude=latitude, longitude=longitude)

    records: List[Dict[str, Any]] = []
    sr = 1.0
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    for day_offset in range(days):
        day = start + timedelta(days=day_offset)
        month = day.month
        # ClimatePrior rates are % per day (e.g. 0.186 %/day) — convert to fraction.
        daily_rate = float(prior.soiling_rate_for_month(month)) / 100.0
        rain_days = float(prior.rain_days_for_month(month))
        days_in_month = 30.4

        # Rain event on average every days_in_month/rain_days days.
        rain_today = rain_days > 0 and (day_offset % max(1, round(days_in_month / rain_days)) == 0) and day_offset > 0

        if rain_today:
            sr = max(sr, RAIN_RESET_SR - 0.01)  # partial clean
        sr = max(SR_FLOOR, sr - daily_rate)

        spread = 0.03 + 0.02 * (day_offset / days)  # widening provisional bounds
        ts = day.isoformat()
        records.extend(
            [
                {"time": ts, "metric": "soiling_ratio", "value": round(sr, 5), "confidence": CONFIDENCE},
                {"time": ts, "metric": "soiling_ratio_lower", "value": round(max(SR_FLOOR - 0.05, sr - spread), 5), "confidence": CONFIDENCE},
                {"time": ts, "metric": "soiling_ratio_upper", "value": round(min(1.0, sr + spread), 5), "confidence": CONFIDENCE},
                {"time": ts, "metric": "soiling_loss_pct", "value": round((1.0 - sr) * 100.0, 4), "confidence": CONFIDENCE},
            ]
        )
    return records


def run_bess_arm(conn, plant: Dict[str, Any], *, days: int, incremental: bool) -> Dict[str, Any]:
    """Battery twin, branched explicitly on the asset's telemetry regime.

    Two writers, one calendar, no overlap:
      - the modelled dispatch twin runs over the pre-connection window and stops
        the day before `first_measured_date`;
      - the measured materializer turns the published daily gold into the same
        relational tables from `first_measured_date` on.

    Both arms are non-fatal, as the battery arm has always been: a plant must
    still finish onboarding when a price feed or the lake is unavailable.
    """
    from nuravolt.pipeline.bess_assets import ensure_bess_asset
    from nuravolt.pipeline.bess_measured import materialize_measured_bess, regime_from_asset

    asset = ensure_bess_asset(conn, plant)
    regime = regime_from_asset(asset)
    out: Dict[str, Any] = {"asset_id": asset["id"], "regime": regime.as_dict()}
    if regime.note:
        print(f"[onboard] bess regime: {regime.note}", file=sys.stderr)

    # Modelled arm. Skipped entirely when measured telemetry owns every day.
    today = datetime.now(timezone.utc).date()
    if regime.owns_modelled(today) or regime.first_measured_date:
        try:
            from nuravolt.pipeline.bess_intelligence import synthesize_bess_history

            out["modelled"] = synthesize_bess_history(conn, plant, days=days)
            print(
                f"[onboard] bess modelled: soh={out['modelled'].get('soh')} "
                f"(prices={out['modelled'].get('price_source')}, "
                f"window={out['modelled'].get('modelled_window')})"
            )
        except Exception as exc:  # noqa: BLE001
            out["modelled"] = {"error": str(exc)[:500]}
            print(f"[onboard] bess modelled failed (non-fatal): {exc}", file=sys.stderr)
    else:
        out["modelled"] = {"skipped": "measured telemetry owns the whole window"}

    # Measured arm. A no-op for an asset that has never had a connection.
    if regime.has_measured:
        try:
            from nuravolt.pipeline.bess_measured import DEFAULT_MODEL_VERSION

            since = None
            if incremental:
                # Nightly refresh only needs to re-materialize the recent tail;
                # earlier days are already upserted under the same keys.
                since = today - timedelta(days=max(7, min(days, 35)))
            out["measured"] = materialize_measured_bess(conn, plant, since=since)
            print(
                f"[onboard] bess measured: {out['measured'].get('days_measured', 0)} day(s) "
                f"from {DEFAULT_MODEL_VERSION} "
                f"({out['measured'].get('skipped') or out['measured'].get('last_day')})"
            )
        except Exception as exc:  # noqa: BLE001
            out["measured"] = {"error": str(exc)[:500]}
            print(f"[onboard] bess measured failed (non-fatal): {exc}", file=sys.stderr)

        # Sub asset (rack) grain, from silver rather than from the daily gold:
        # imbalance needs the timestamp axis and the simultaneous siblings that a
        # daily rollup has already collapsed. Two days back so a run just after
        # midnight still sees a complete partition. Non-fatal like its
        # neighbours: a plant must finish onboarding when the lake is not built.
        try:
            from nuravolt.pipeline.bess_measured import materialize_measured_imbalance

            out["imbalance"] = materialize_measured_imbalance(conn, plant, days=2)
            print(
                f"[onboard] bess imbalance: "
                f"{out['imbalance'].get('skipped') or out['imbalance'].get('day_analysed')} "
                f"(racks={(out['imbalance'].get('imbalance') or {}).get('racks', 0)})"
            )
        except Exception as exc:  # noqa: BLE001
            out["imbalance"] = {"error": str(exc)[:500]}
            print(f"[onboard] bess imbalance failed (non-fatal): {exc}", file=sys.stderr)

        # Revenue assurance: the three-lane ledger (measured / declared /
        # benchmark) the revenue route serves. Without this the route's DB
        # branch returns empty lanes and null KPIs for every real plant, since
        # assure_bess_revenue previously had no caller at all. Non-fatal like
        # its neighbours: a price-fetch failure must not block onboarding.
        try:
            from nuravolt.pipeline.bess_revenue_assurance import assure_bess_revenue

            out["revenue_assurance"] = assure_bess_revenue(conn, plant)
            ra = out["revenue_assurance"]
            ra_note = ra.get("skipped") or f"{len(ra.get('assets') or [])} asset(s)"
            print(f"[onboard] bess revenue assurance: {ra_note}")
        except Exception as exc:  # noqa: BLE001
            out["revenue_assurance"] = {"error": str(exc)[:500]}
            print(f"[onboard] bess revenue assurance failed (non-fatal): {exc}", file=sys.stderr)
    return out


def set_plant_status(conn, plant_id: str, from_status: str, to_status: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "Plant" SET status = %s::"PlantStatus", updated_at = NOW() '
            "WHERE id = %s AND status = %s::\"PlantStatus\"",
            (to_status, plant_id, from_status),
        )
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description="Cold-start analytics onboarding for one plant")
    parser.add_argument("--plant-id", required=True, help="Plant uuid or slug")
    parser.add_argument("--job-id", help="Existing AnalyticsJob id to update (created by the API trigger)")
    parser.add_argument("--days", type=int, default=FORECAST_DAYS)
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Nightly refresh: skip the cold-start-only arms (coldstart soiling forecast, "
        "fault and soiling-stream synthesis, status transitions) and refresh the rest",
    )
    args = parser.parse_args()

    conn = _connect()
    plant = load_plant(conn, args.plant_id)
    if not plant:
        print(f"Plant not found: {args.plant_id}", file=sys.stderr)
        return 1

    job_id = upsert_job(conn, args.job_id, plant["id"], "running")
    print(f"[onboard] plant={plant['slug']} ({plant['id']}) job={job_id}")

    try:
        lat = float(plant["latitude"])
        lon = float(plant["longitude"])
        asset_type = str(plant.get("asset_type") or "PV")
        has_pv = asset_type in ("PV", "HYBRID")
        has_bess = asset_type in ("BESS", "HYBRID")

        incremental = bool(args.incremental)
        if incremental:
            print("[onboard] incremental refresh: cold-start arms skipped")

        written = 0
        # The coldstart curve is the cold start. Re-running it nightly on an
        # OPERATIONAL plant would overwrite whatever later stages produced,
        # which is exactly what the nightly docstring warned about.
        if has_pv and not incremental:
            records = build_coldstart_forecast(plant["slug"], lat, lon, days=args.days)
            writer = TimeseriesWriter()
            # Deterministic run_id so re-runs upsert the same rows instead of
            # accumulating duplicates under new run ids.
            run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"coldstart:{plant['id']}"))
            written = writer.write_analysis_results(
                plant_id=plant["id"],
                domain="soiling",
                records=records,
                model_version=MODEL_VERSION,
                run_id=run_id,
            )
            print(f"[onboard] wrote {written} analysis_results rows (soiling, {MODEL_VERSION})")

        # Digital twin: physics predictions day one, residuals against the
        # plant's own measurements once data lands. Weather hiccups must not
        # block onboarding — record the error and let the nightly sweep retry.
        twin_summary: Dict[str, Any] = {}
        if has_pv:
            try:
                twin_summary = generate_twin(conn, plant["id"], days=30)
                print(
                    f"[onboard] twin: {twin_summary.get('rows_written', 0)} rows "
                    f"(actual_days={twin_summary.get('actual_days')}, calibrated={twin_summary.get('calibrated')})"
                )
            except Exception as twin_exc:  # noqa: BLE001
                twin_summary = {"error": str(twin_exc)[:500]}
                print(f"[onboard] twin generation failed (non-fatal): {twin_exc}", file=sys.stderr)

            # Enhanced fault telemetry (RUL/cascade/health) synthesized from the
            # plant's own per-inverter soiling — populates the faults console
            # beyond the live twin classifications. Cold start only: these are
            # synthesizers, and re-running them nightly would overwrite live
            # output the same way the coldstart curve would. Non-fatal.
            if not incremental:
                try:
                    from nuravolt.pipeline.faults_synth import synthesize_faults

                    fsum = synthesize_faults(conn, plant["id"])
                    print(f"[onboard] faults: {fsum.get('faults', 0)} synthesized (health={fsum.get('health')})")
                except Exception as f_exc:  # noqa: BLE001
                    print(f"[onboard] faults synthesis failed (non-fatal): {f_exc}", file=sys.stderr)

                # Multi-source soiling streams (dust/AOD/DustIQ/ML history) for the
                # Data Explorer — synthesized/labeled for demo plants. Non-fatal.
                try:
                    from nuravolt.pipeline.soiling_streams import synthesize_soiling_streams

                    ssum = synthesize_soiling_streams(conn, plant["id"])
                    print(f"[onboard] soiling streams: {ssum.get('days', 0)} days synthesized")
                except Exception as s_exc:  # noqa: BLE001
                    print(f"[onboard] soiling streams synthesis failed (non-fatal): {s_exc}", file=sys.stderr)

            # Data-quality analytics artifacts for the DQ hub's Irradiance /
            # Spatial / Correlation tabs (measured data vs Open-Meteo
            # reference, zone CV, source correlation). Each generator skips
            # itself when its inputs are missing. Non-fatal.
            try:
                from nuravolt.pipeline.quality_analytics import (
                    generate_quality_correlation,
                    generate_quality_irradiance,
                    generate_quality_spatial,
                )

                qsum = generate_quality_irradiance(conn, plant["id"])
                if qsum.get("skipped"):
                    print(f"[onboard] quality irradiance: skipped ({qsum['skipped']})")
                else:
                    print(
                        f"[onboard] quality irradiance: r={qsum.get('correlation')} "
                        f"({qsum.get('samples')} samples vs {qsum.get('reference')})"
                    )
                ssp = generate_quality_spatial(conn, plant["id"])
                if ssp.get("skipped"):
                    print(f"[onboard] quality spatial: skipped ({ssp['skipped']})")
                else:
                    print(
                        f"[onboard] quality spatial: {ssp.get('zones')} zones, "
                        f"{ssp.get('days')} days, uniformity {ssp.get('uniformity_pct')}%"
                    )
                sco = generate_quality_correlation(conn, plant["id"])
                if sco.get("skipped"):
                    print(f"[onboard] quality correlation: skipped ({sco['skipped']})")
                else:
                    print(
                        f"[onboard] quality correlation: {sco.get('days')} days "
                        f"({sco.get('uniform_days')} uniform), {sco.get('zones')} zones"
                    )
            except Exception as q_exc:  # noqa: BLE001
                print(f"[onboard] quality analytics failed (non-fatal): {q_exc}", file=sys.stderr)

            # 7-day physics power forecast (Open-Meteo forecast API + PVWatts
            # twin models) for the overview panel. Weather/network hiccups must
            # not block onboarding. Non-fatal.
            try:
                from nuravolt.pipeline.power_forecast import generate_power_forecast

                pf_sum = generate_power_forecast(conn, plant["id"])
                print(f"[onboard] power forecast: {pf_sum.get('rows_written', 0)} rows")
            except Exception as pf_exc:  # noqa: BLE001
                print(f"[onboard] power forecast failed (non-fatal): {pf_exc}", file=sys.stderr)

        # Battery: modelled twin over the pre-connection window, measured
        # materializer over everything from first_measured_date on.
        bess_summary: Dict[str, Any] = {}
        if has_bess:
            bess_summary = run_bess_arm(
                conn, plant,
                days=args.days if args.days <= 60 else 30,
                incremental=incremental,
            )

        if not incremental:
            set_plant_status(conn, plant["id"], "ONBOARDING", "TRAINING")
            # Calibrated twin = plant-specific model => the plant graduates.
            # Pure-BESS plants graduate once their asset history exists.
            if twin_summary.get("calibrated") or (not has_pv and bess_summary.get("asset_id")):
                set_plant_status(conn, plant["id"], "TRAINING", "OPERATIONAL")

        upsert_job(
            conn,
            job_id,
            plant["id"],
            "succeeded",
            detail={
                "rows_written": written,
                "model_version": MODEL_VERSION,
                "days": args.days,
                "mode": "incremental" if incremental else "coldstart",
                "twin": twin_summary or None,
                "bess": bess_summary or None,
            },
            finished=True,
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        upsert_job(conn, job_id, plant["id"], "failed", error=str(exc)[:1000], finished=True)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
