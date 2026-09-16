#!/usr/bin/env python3
"""Backfill the trained ML digital twin's history into a plant's analysis_results.

The prod showcase plant `ribera-solar` (the Ribera donor's public alias)
carries only ~30 days of synthetic physics-twin rows (model_version
'physics-v1', refreshed nightly). But the donor's *trained hybrid* twin
(CatBoost + physics, plantModelR2 0.9806) has ~5 years of 15-minute
predictions on disk as public/data/digitaltwin/ribera/residuals_INV_*.parquet
(120 inverters, per-unit of 60 kW nominal, 2020-10 -> 2025-12-14). This script
replays that history into the DB so the flagship plant shows the ML twin for
its past and physics for the live tail.

Design (see the plan for full rationale):
  - Map the 120 donor inverters (5 per prod inverter) -> INV-01..INV-24 @300 kW
    (24 x 300 kW = 120 x 60 kW = 7.2 MW, exact). Absolute kW = per-unit x 60.
  - Shift donor timestamps +1 calendar YEAR (season-correct). Timestamps are
    UTC (donor peaks at hour 12 year-round) -- attach tzinfo=UTC, never
    localize (twin.py stores true UTC too).
  - DROP Feb-29 rows BEFORE shifting: +1y saturates 2024-02-29 -> 2025-02-28,
    which would collide with the shifted 2024-02-28 inside one upsert batch
    ("ON CONFLICT cannot affect row a second time" -- a hard failure).
  - SEAM: cut everything to `time < seam` where
    seam = min(date_trunc('day', MIN(time)) over ALL the plant's digitaltwin
    rows, today). Disjoint from the nightly physics window -> no run_id
    collision, no doubled rows. A day-boundary cut also prevents an ML daily
    row (12:00 UTC) landing on the same stamp as a physics daily row.
  - Fresh deterministic run_id = uuid5("ml-backfill:{plant_id}") and
    model_version 'hybrid-catboost-v1' -> visibly not physics, rollback via
    DELETE ... WHERE run_id = <that>.
  - PRE-WRITE ASSERTION: zero digitaltwin rows exist before the seam under any
    OTHER run_id (reads never filter by run_id, so an overlap would double the
    summed series / MWh). Abort otherwise.
  - Write PLANT hourly (daylight only) + per-device daily (12:00 UTC), mirroring
    nuravolt/pipeline/twin.py row semantics exactly, in per-calendar-month
    commit batches (avoids the compressed-chunk OOM class documented in
    scripts/aggregate_twins_to_db.py). Refresh analysis_daily over the range.

WARNING (also noted in nuravolt/pipeline/twin.py): never run
generate_twin(days>30) on a plant that carries this backfill -- physics would
write into ML territory under the physics run_id, producing duplicate
timestamps across run_ids and 2x MWh on those days. onboard_plant.py hardcodes
days=30 today.

Usage:
    python scripts/backfill_ml_twin_history.py --plant ribera-solar [--dry-run]
    python scripts/backfill_ml_twin_history.py --plant ribera --dry-run   # local dev

Prod: export the prod DATABASE_URL explicitly, dry-run first, then verify with
direct psql (never trust the script output alone).
"""

import argparse
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl
import psycopg2
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402

MODEL_VERSION = "hybrid-catboost-v1"
NOMINAL_KW = 60.0          # donor per-unit nominal (per-unit values are fractions of this)
DEFAULT_ARCHIVE = PROJECT_ROOT / "public/data/digitaltwin/ribera"


def resolve_plant(conn, ident: str) -> str:
    with conn.cursor() as cur:
        cur.execute('SELECT id FROM "Plant" WHERE id::text = %s OR slug = %s', (ident, ident))
        row = cur.fetchone()
    if not row:
        sys.exit(f"plant not found: {ident}")
    return str(row[0])


def plant_inverter_ids(conn, plant_id: str) -> list:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT i.external_id FROM "Inverter" i '
            'JOIN "InverterGroup" g ON g.id = i.group_id '
            'WHERE g.plant_id = %s ORDER BY i.external_id',
            (plant_id,),
        )
        return [r[0] for r in cur.fetchall()]


PHYSICS_MODEL_VERSION = "physics-v1"


def seam_and_guard(conn, plant_id: str, explicit_seam: datetime | None) -> datetime:
    """Return the seam (UTC midnight): ML history occupies strictly before it.

    Anchored to the LIVE PHYSICS TAIL (model_version='physics-v1'), NOT to a
    MIN over all digitaltwin rows. Anchoring to the physics tail is what makes
    this both safe and re-runnable:
      - It is UNAFFECTED by this backfill's own rows, so a rerun (or a resume
        after a crash mid-write) recomputes the SAME seam and re-upserts the
        missing months idempotently (a MIN-over-everything seam would collapse
        onto the earliest backfilled day and write nothing / leave a gap).
      - ML writes (< seam) are then disjoint from the nightly physics window
        (>= seam) at every timestamp, so reads that ignore run_id never sum two
        series -> no doubled MWh.

    The guard is now LIVE (not vacuous): it counts any NON-ML digitaltwin row in
    the range the backfill is about to fill [.. , seam). A stale e2e-seed row or
    an older backfill under a different tag sitting before the physics window
    would be summed with our rows -> abort so the operator investigates.
    """
    today_mid = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT date_trunc('day', MIN(time)) FROM analysis_results "
            "WHERE plant_id = %s::uuid AND domain = 'digitaltwin' AND model_version = %s",
            (plant_id, PHYSICS_MODEL_VERSION),
        )
        first_physics = cur.fetchone()[0]

    if explicit_seam is not None:
        seam = explicit_seam
    elif first_physics is not None:
        seam = first_physics
    else:
        sys.exit(
            "ABORT: no physics-v1 twin rows for this plant, so the seam is unknown. "
            "Pass --seam YYYY-MM-DD explicitly. (A fresh plant with an implicit "
            "seam=today would double 30 days of MWh the moment physics onboards it.)"
        )
    seam = min(seam, today_mid)  # never write into the future

    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM analysis_results "
            "WHERE plant_id = %s::uuid AND domain = 'digitaltwin' "
            "AND time < %s AND model_version IS DISTINCT FROM %s",
            (plant_id, seam, MODEL_VERSION),
        )
        stragglers = cur.fetchone()[0]
    if stragglers:
        sys.exit(
            f"ABORT: {stragglers} non-ML digitaltwin rows exist before the seam "
            f"({seam.date()}); they would be summed with the backfill (doubled series). "
            "Investigate before backfilling."
        )
    return seam


def refresh_daily_aggregate(conn, lo: datetime, hi: datetime) -> None:
    """Refresh analysis_daily per calendar year over [lo, hi] (autocommit).

    No-op off TimescaleDB (local dev is plain Postgres where analysis_daily is
    a live view — no continuous aggregate to refresh), mirroring
    nuravolt/pipeline/twin.py._refresh_daily_aggregate.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
        if not cur.fetchone():
            print("  (plain Postgres — analysis_daily is a live view, no refresh needed)")
            return
    conn.rollback()  # refresh must run outside any open transaction
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


def unit_hourly(path: Path) -> pl.DataFrame:
    """Reduce one donor 15-min file to hourly means in absolute kW.

    Returns columns: hour (naive UTC), pred, act, n_act.
    Drops Feb-29 and shifts +1 calendar year.
    """
    df = pl.read_parquet(path)
    if df["timestamp"].dtype == pl.Utf8:
        df = df.with_columns(pl.col("timestamp").str.to_datetime())
    # Drop Feb-29 BEFORE the +1y shift (leap saturation would collide).
    df = df.filter(~((pl.col("timestamp").dt.month() == 2) & (pl.col("timestamp").dt.day() == 29)))
    df = df.with_columns(pl.col("timestamp").dt.offset_by("1y").alias("timestamp"))
    df = df.with_columns([
        (pl.col("expected") * NOMINAL_KW).alias("pred"),
        (pl.col("actual") * NOMINAL_KW).alias("act"),
        pl.col("timestamp").dt.truncate("1h").alias("hour"),
    ])
    return df.group_by("hour").agg([
        pl.col("pred").mean().alias("pred"),
        pl.col("act").filter(pl.col("act").is_not_null()).mean().alias("act"),
        pl.col("act").is_not_null().sum().alias("n_act"),
    ])


def device_hourly(unit_frames: list) -> pl.DataFrame:
    """Aggregate N unit-hourly frames into one plant-inverter hourly frame.

    A device reports an hour only when ALL its donor units reported it (so the
    per-device actual is a true full sum, not a partial). Columns:
    hour, pred, dev_act (null unless reported), reported.
    """
    n_units = len(unit_frames)
    stacked = pl.concat(unit_frames)
    dev = stacked.group_by("hour").agg([
        pl.col("pred").sum().alias("pred"),
        pl.col("act").sum().alias("act"),
        (pl.col("n_act") > 0).sum().alias("units_reported"),
    ])
    dev = dev.with_columns((pl.col("units_reported") >= n_units).alias("reported"))
    return dev.with_columns(
        pl.when(pl.col("reported")).then(pl.col("act")).otherwise(None).alias("dev_act")
    ).select(["hour", "pred", "dev_act", "reported"])


def build_records(device_frames: dict, plant_id: str):
    """Assemble PLANT hourly + per-device daily records (mirrors twin.py)."""
    # ---- PLANT hourly (sum across devices) ----
    tagged = [df.with_columns(pl.lit(dev).alias("device_id")) for dev, df in device_frames.items()]
    alldev = pl.concat(tagged)
    plant = alldev.group_by("hour").agg([
        pl.col("pred").sum().alias("plant_pred"),
        pl.col("dev_act").sum().alias("plant_act"),      # null dev_act skipped
        pl.col("reported").sum().alias("n_reporting"),
    ]).sort("hour")

    n_devices = len(device_frames)
    hourly_records = []
    for r in plant.iter_rows(named=True):
        t = r["hour"].replace(tzinfo=timezone.utc)
        plant_pred = r["plant_pred"] or 0.0
        if plant_pred <= 1:
            continue  # daylight-ish gate (twin.py line 181)
        hourly_records.append({"time": t, "device_id": "PLANT",
                               "metric": "power_ac_predicted", "value": round(plant_pred, 3)})
        # Only emit PLANT actual/residual when the WHOLE fleet reported (twin.py
        # lines 187-189): a partial-fleet actual vs a full-fleet prediction would
        # fabricate a phantom loss.
        if r["n_reporting"] == n_devices:
            plant_act = r["plant_act"] or 0.0
            hourly_records.append({"time": t, "device_id": "PLANT",
                                   "metric": "power_ac_actual", "value": round(plant_act, 3)})
            hourly_records.append({"time": t, "device_id": "PLANT",
                                   "metric": "power_ac_residual", "value": round(plant_act - plant_pred, 3)})

    # ---- per-device daily (12:00 UTC, means over daylight/reported hours) ----
    daily_records = []
    for dev, df in device_frames.items():
        # All three means are gated on the DAYLIGHT hours (pred>1), mirroring
        # twin.py: it accumulates act and pred_matched only inside `if pred>1`.
        # Donor `actual` is non-null (~0) at night, so `reported` is True at
        # night too; without the pred>1 gate those near-zero night actuals fold
        # into act_daily while pred_daily excludes them -> a phantom daily loss.
        d = df.with_columns(pl.col("hour").dt.date().alias("date")).group_by("date").agg([
            pl.col("pred").filter(pl.col("pred") > 1).mean().alias("pred_daily"),
            pl.col("dev_act").filter(pl.col("reported") & (pl.col("pred") > 1)).mean().alias("act_daily"),
            # predicted mean over exactly the reported daylight hours (twin.py pred_matched)
            pl.col("pred").filter(pl.col("reported") & (pl.col("pred") > 1)).mean().alias("pred_matched"),
        ]).sort("date")
        for r in d.iter_rows(named=True):
            if r["pred_daily"] is None:
                continue
            t = datetime(r["date"].year, r["date"].month, r["date"].day, 12, tzinfo=timezone.utc)
            daily_records.append({"time": t, "device_id": dev,
                                  "metric": "power_ac_predicted", "value": round(r["pred_daily"], 3)})
            if r["act_daily"] is not None and r["pred_matched"] is not None:
                daily_records.append({"time": t, "device_id": dev,
                                      "metric": "power_ac_actual", "value": round(r["act_daily"], 3)})
                daily_records.append({"time": t, "device_id": dev, "metric": "power_ac_residual",
                                      "value": round(r["act_daily"] - r["pred_matched"], 3)})

    return hourly_records, daily_records


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", required=True, help="plant slug or uuid")
    ap.add_argument("--archive", default=str(DEFAULT_ARCHIVE), help="donor residuals dir")
    ap.add_argument("--days", type=int, default=None, help="limit history depth (days back from seam)")
    ap.add_argument("--seam", default=None,
                    help="explicit seam YYYY-MM-DD (ML history is written strictly before it). "
                         "Required for plants with no physics-v1 tail yet.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    explicit_seam = None
    if args.seam:
        explicit_seam = datetime.strptime(args.seam, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    load_dotenv(PROJECT_ROOT / ".env")  # does not override an exported DATABASE_URL
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    files = sorted(Path(args.archive).glob("residuals_*.parquet"))
    if not files:
        sys.exit(f"no donor residual files in {args.archive}")

    conn = psycopg2.connect(dsn)
    plant_id = resolve_plant(conn, args.plant)
    inv_ids = plant_inverter_ids(conn, plant_id)
    n_inv = len(inv_ids)
    if n_inv == 0:
        sys.exit("plant has no inverters")

    # Donor units per plant inverter is topology-dependent: prod ribera-solar is
    # 24 inverters @ 300 kW -> 120/24 = 5 donor units (60 kW) each; the local
    # donor plant is 120 inverters @ 60 kW -> 1:1. Derive it so the summed
    # per-inverter power always scales to the plant's real nominal.
    units_per = max(1, len(files) // n_inv)
    n_mapped = min(n_inv, len(files) // units_per)
    if n_mapped < n_inv:
        print(f"  note: {len(files)} donor files / {units_per} per inverter only covers "
              f"{n_mapped} of {n_inv} inverters")

    ml_run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ml-backfill:{plant_id}"))
    seam = seam_and_guard(conn, plant_id, explicit_seam)
    depth_floor = seam - timedelta(days=args.days) if args.days else None
    print(f"plant {args.plant} ({plant_id}) — {n_inv} inverters, {units_per} donor unit(s) each, "
          f"seam < {seam.date()}, run_id={ml_run_id}")

    # Build device frames: `units_per` donor units -> one plant inverter, in order.
    device_frames = {}
    for k in range(n_mapped):
        chunk = files[k * units_per:(k + 1) * units_per]
        if len(chunk) < units_per:
            break
        unit_frames = [unit_hourly(f) for f in chunk]
        device_frames[inv_ids[k]] = device_hourly(unit_frames)
    print(f"  aggregated {len(device_frames) * units_per} donor units "
          f"into {len(device_frames)} inverters")

    hourly_records, daily_records = build_records(device_frames, plant_id)

    # Seam + optional depth cut (single `time < seam` handles hourly and the
    # 12:00 daily rows uniformly).
    def keep(rec):
        if rec["time"] >= seam:
            return False
        if depth_floor and rec["time"] < depth_floor:
            return False
        return True

    hourly_records = [r for r in hourly_records if keep(r)]
    daily_records = [r for r in daily_records if keep(r)]
    all_records = hourly_records + daily_records
    if not all_records:
        sys.exit("no records to write after seam/depth cut")

    times = [r["time"] for r in all_records]
    lo, hi = min(times), max(times)
    print(f"  {len(hourly_records):,} PLANT-hourly + {len(daily_records):,} device-daily rows, "
          f"{lo.date()} -> {hi.date()}")

    # Seam-continuity eyeball: last 5 ML plant-daily predicted (summed devices).
    ml_daily_plant = defaultdict(float)
    for r in daily_records:
        if r["device_id"] != "PLANT" and r["metric"] == "power_ac_predicted":
            ml_daily_plant[r["time"].date()] += r["value"]
    tail = sorted(ml_daily_plant.items())[-5:]
    print("  ML plant-daily predicted (last 5 days before seam):")
    for d, kw in tail:
        print(f"    {d}: {kw/1000:.2f} MW")

    if args.dry_run:
        print(f"[dry-run] would upsert {len(all_records):,} rows tagged {MODEL_VERSION}")
        conn.close()
        return

    # Write in per-calendar-month slices (one commit each) to keep decompression
    # buffers bounded on compressed hypertables.
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

    # Refresh analysis_daily so daily/weekly/monthly views see the backfill (the
    # CAGG policy only refreshes a trailing window). Scope to the WRITTEN range
    # and split per calendar year: a single monolithic multi-year refresh can
    # time out, and a per-year loop lets a re-run repair whatever a prior crash
    # left un-materialized (raw rows are committed per month above, so a rerun
    # re-upserts + re-refreshes idempotently).
    refresh_daily_aggregate(writer.conn, lo, hi)
    writer.close()
    conn.close()
    print("Done. Refreshed analysis_daily.")


if __name__ == "__main__":
    main()
