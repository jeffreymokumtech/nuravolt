#!/usr/bin/env python3
"""
Vectorised replacement for the build_db_aggregates step of
train_hierarchical_twins.py.

Reads the per-plant hourly parquet outputs that the trainer already wrote to
disk and produces the daily/hourly aggregates the API expects in
analysis_results, using pandas vector ops + psycopg2 execute_values bulk
insert. Avoids the iterrows/Timestamp.__hash__ hot loop that grinds for an
hour at this scale.

Usage:
    python scripts/aggregate_twins_to_db.py --plant ribera

Skips string_current by default — the upstream parquet for that one is stale
on the local copy. Pass --include-strings if you have a fresh string parquet.
"""

import argparse
import os
import sys
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Dict, List

import pandas as pd
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402

PLANTS = {
    "ribera": "eb47ddda-0961-40b8-965a-80271b41e33f",
    "alpha":  "ee0f71ae-b431-4956-8ace-fa535d263151",
}


def operating_mask(df: pd.DataFrame, actual_metric: str, threshold: float = 5.0) -> pd.DataFrame:
    """Build a (time, device_id) -> is_operating frame from the `_actual` series.

    Twin "predicted" series often run continuously (the model has an opinion
    even at night) while "actual" goes to zero whenever the inverter is idle.
    Aggregating both raw produces a chart artifact: predicted reads as a flat
    daytime baseline, actual reads as ~daylight-fraction × baseline.

    The fix: define an operating-hour set from where `actual >= threshold`,
    then aggregate predicted/actual/residual over that same hour set so both
    series describe "the inverter while running".
    """
    a = df[df["metric"] == actual_metric][["time", "device_id", "value"]].copy()
    a["time"] = pd.to_datetime(a["time"]).dt.floor("h")
    a["is_operating"] = a["value"].abs() >= threshold
    return a[["time", "device_id", "is_operating"]].drop_duplicates(["time", "device_id"])


def long_daily(
    df: pd.DataFrame,
    metrics_keep: List[str],
    how: str = "mean",
    actual_metric: str | None = None,
    op_threshold: float = 5.0,
) -> pd.DataFrame:
    """Aggregate a long-format (time, device_id, metric, value) dataframe to daily.

    If `actual_metric` is given, restricts aggregation to operating hours —
    timestamps where that metric's value is >= `op_threshold` for that device.
    """
    df = df[df["metric"].isin(metrics_keep)].copy()
    df["time"] = pd.to_datetime(df["time"]).dt.floor("h")

    if actual_metric and actual_metric in metrics_keep:
        op = operating_mask(df, actual_metric, op_threshold)
        before = len(df)
        df = df.merge(op, on=["time", "device_id"], how="left")
        df = df[df["is_operating"].fillna(False)].drop(columns=["is_operating"])
        print(f"    operating-hour filter: {len(df):,} / {before:,} rows kept "
              f"({100 * len(df) / before:.1f}%)")

    df["date"] = df["time"].dt.normalize()
    grp = df.groupby(["date", "device_id", "metric"], observed=True)["value"]
    daily = (grp.mean() if how == "mean" else grp.sum()).reset_index()
    daily = daily.rename(columns={"date": "time"})
    return daily


def plant_hourly_sum(df: pd.DataFrame, metrics_keep: List[str]) -> pd.DataFrame:
    df = df[df["metric"].isin(metrics_keep)].copy()
    df["time"] = pd.to_datetime(df["time"]).dt.floor("h")
    grp = df.groupby(["time", "metric"], observed=True)["value"].sum().reset_index()
    grp["device_id"] = "PLANT"
    return grp[["time", "device_id", "metric", "value"]]


def normalise_voltage_metric(m: str) -> str:
    # mppt_1_voltage_actual -> voltage_dc_actual
    return m.replace("_actual", "_actual").split("voltage_")[-1] and {
        "actual":   "voltage_dc_actual",
        "predicted":"voltage_dc_predicted",
        "residual": "voltage_dc_residual",
    }.get(m.rsplit("_", 1)[-1], m)


def parent_inverter(dev: str) -> str:
    # "INV 01.032.MPPT-1" -> "INV 01.032"
    return dev.rsplit(".", 1)[0]


def to_records(df: pd.DataFrame, plant_id: str, aggregation: str, confidence: float = 0.0) -> List[dict]:
    """Convert a long-format daily/hourly dataframe to the dict shape
    TimeseriesWriter.write_analysis_results expects."""
    if df.empty:
        return []
    df = df.dropna(subset=["value"]).copy()
    times = df["time"].dt.to_pydatetime()
    metric_meta = {"aggregation": aggregation}
    out = [
        {
            "time": t,
            "device_id": str(d),
            "metric": str(m),
            "value": float(v),
            "confidence": float(confidence),
            "metadata": metric_meta,
        }
        for t, d, m, v in zip(times, df["device_id"], df["metric"], df["value"])
    ]
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plant", required=True, choices=list(PLANTS))
    parser.add_argument("--include-strings", action="store_true",
                        help="Also aggregate string_current_hourly.parquet (skipped by default)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Aggregate only, don't write to DB")
    args = parser.parse_args()

    load_dotenv()
    plant_id = PLANTS[args.plant]
    twin_dir = Path(f"backenddata/twins/{plant_id}")

    if not twin_dir.exists():
        print(f"No twin directory at {twin_dir}", file=sys.stderr)
        return 1

    all_records: List[dict] = []

    # === POWER ===
    power_path = twin_dir / "power_hourly.parquet"
    if power_path.exists():
        print(f"Reading {power_path.name}…")
        pdf = pd.read_parquet(power_path)
        print(f"  rows={len(pdf):,}  devices={pdf.device_id.nunique()}")

        metrics = ["power_ac_predicted", "power_ac_actual", "power_ac_residual"]

        print("  PLANT hourly sum…")
        plant_hr = plant_hourly_sum(pdf, metrics)
        recs = to_records(plant_hr, plant_id, "plant_hourly_sum")
        print(f"    {len(recs):,} plant-hour records")
        all_records.extend(recs)

        print("  Per-inverter daily mean (operating hours)…")
        inv_daily = long_daily(pdf, metrics, how="mean", actual_metric="power_ac_actual")
        recs = to_records(inv_daily, plant_id, "inverter_daily_avg")
        print(f"    {len(recs):,} inverter-day records")
        all_records.extend(recs)
        del pdf, plant_hr, inv_daily

    # === TEMPERATURE ===
    temp_path = twin_dir / "temperature_hourly.parquet"
    if temp_path.exists():
        print(f"Reading {temp_path.name}…")
        tdf = pd.read_parquet(temp_path)
        print(f"  rows={len(tdf):,}  devices={tdf.device_id.nunique()}")

        metrics = ["temperature_predicted", "temperature_actual", "temperature_residual"]
        print("  Per-inverter daily mean (operating hours)…")
        td = long_daily(tdf, metrics, how="mean", actual_metric="temperature_actual")
        recs = to_records(td, plant_id, "inverter_daily_avg")
        print(f"    {len(recs):,} temperature records")
        all_records.extend(recs)
        del tdf, td

    # === VOLTAGE (MPPT mean -> inverter level) ===
    volt_path = twin_dir / "mppt_voltage_hourly.parquet"
    if volt_path.exists():
        print(f"Reading {volt_path.name}…")
        vdf = pd.read_parquet(volt_path)
        print(f"  rows={len(vdf):,}  devices={vdf.device_id.nunique()}")

        # Keep only the three MPPT voltage metric families
        keep = vdf["metric"].str.match(r"mppt_\d+_voltage_(actual|predicted|residual)")
        vdf = vdf[keep].copy()

        # Map MPPT-specific metric to canonical voltage_dc_*
        suffix = vdf["metric"].str.extract(r"_(actual|predicted|residual)$")[0]
        vdf["metric"] = "voltage_dc_" + suffix
        # Keep MPPT-level device_id for the operating filter (each MPPT
        # has its own idle/operating pattern); collapse to parent inverter
        # only after filtering.
        vdf["mppt_device"] = vdf["device_id"]
        vdf["time"] = pd.to_datetime(vdf["time"]).dt.floor("h")

        # Operating filter at MPPT level: keep only (time, mppt_device) rows
        # where this MPPT's actual voltage was non-zero.
        op = vdf[vdf["metric"] == "voltage_dc_actual"][["time", "mppt_device", "value"]].copy()
        op["is_operating"] = op["value"].abs() >= 5.0
        op = op[["time", "mppt_device", "is_operating"]].drop_duplicates(["time", "mppt_device"])

        before = len(vdf)
        vdf = vdf.merge(op, on=["time", "mppt_device"], how="left")
        vdf = vdf[vdf["is_operating"].fillna(False)].drop(columns=["is_operating"])
        print(f"  operating-hour filter at MPPT level: "
              f"{len(vdf):,} / {before:,} rows kept ({100 * len(vdf) / before:.1f}%)")

        # Now collapse to parent inverter and daily mean
        vdf["device_id"] = vdf["mppt_device"].map(parent_inverter)
        vdf["date"] = vdf["time"].dt.normalize()
        print("  Per-inverter daily mean across MPPTs (operating hours)…")
        v_daily = (vdf.groupby(["date", "device_id", "metric"], observed=True)["value"]
                       .mean()
                       .reset_index()
                       .rename(columns={"date": "time"}))
        recs = to_records(v_daily, plant_id, "inverter_daily_mppt_mean")
        print(f"    {len(recs):,} voltage records")
        all_records.extend(recs)
        del vdf, v_daily

    # === STRING CURRENT (optional) ===
    if args.include_strings:
        str_path = twin_dir / "string_current_hourly.parquet"
        if str_path.exists():
            print(f"Reading {str_path.name}…")
            sdf = pd.read_parquet(str_path)
            print(f"  rows={len(sdf):,}  devices={sdf.device_id.nunique()}")

            keep = sdf["metric"].str.contains(r"current_dc_(actual|predicted|residual)$")
            sdf = sdf[keep].copy()
            # device "INV X.YYY.STR-N" -> "INV X.YYY"
            sdf["device_id"] = sdf["device_id"].apply(
                lambda d: ".".join(d.split(".")[:2]) if d.count(".") >= 2 else d
            )
            print("  Per-inverter daily sum across strings then mean across hours…")
            sdf["date"] = pd.to_datetime(sdf["time"]).dt.normalize()
            # Sum strings within an inverter at each hour, then mean across hours of the day
            hourly = (sdf.groupby(["time", "device_id", "metric"], observed=True)["value"]
                          .sum().reset_index())
            hourly["date"] = pd.to_datetime(hourly["time"]).dt.normalize()
            s_daily = (hourly.groupby(["date", "device_id", "metric"], observed=True)["value"]
                              .mean().reset_index().rename(columns={"date": "time"}))
            recs = to_records(s_daily, plant_id, "inverter_daily_sum_then_mean")
            print(f"    {len(recs):,} current records")
            all_records.extend(recs)

    print(f"\nTotal records to write: {len(all_records):,}")

    if args.dry_run:
        print("Dry-run: skipping DB write.")
        return 0

    if not all_records:
        print("Nothing to write.")
        return 0

    print("Writing to analysis_results…")
    writer = TimeseriesWriter()

    # Wipe any prior digitaltwin rows for this plant before re-inserting —
    # without this, each rerun lays down a fresh run_id and the API would see
    # overlapping series.
    #
    # DELETE on a *compressed* hypertable decompresses every chunk the predicate
    # touches. The (plant_id, domain) predicate spans the full history, so a
    # single statement decompresses the entire table at once — which OOMed the
    # box once the cap was lifted (the previous version did
    # `SET max_tuples_decompressed_per_dml_transaction = 0`). drop_chunks() is no
    # help here: chunks are shared across every plant and domain, so dropping by
    # time would delete unrelated rows.
    #
    # Instead, keep the decompression cap at its protective default and delete in
    # bounded time windows, committing after each so decompressed buffers are
    # released before the next window. Memory stays flat regardless of fleet size.
    # (If a window ever trips the cap, narrow DELETE_WINDOW_DAYS — a loud, safe
    # error beats a silent OOM.)
    DELETE_WINDOW_DAYS = 7  # aligns with the analysis_results chunk interval
    writer.conn.autocommit = False
    with writer.conn.cursor() as cur:
        cur.execute(
            "SELECT min(time), max(time) FROM analysis_results "
            "WHERE plant_id = %s::uuid AND domain = 'digitaltwin';",
            (plant_id,),
        )
        lo, hi = cur.fetchone()

    deleted = 0
    if lo is not None:
        window = timedelta(days=DELETE_WINDOW_DAYS)
        start = lo
        while start <= hi:
            end = start + window
            with writer.conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM analysis_results "
                    "WHERE plant_id = %s::uuid AND domain = 'digitaltwin' "
                    "AND time >= %s AND time < %s;",
                    (plant_id, start, end),
                )
                deleted += cur.rowcount
            writer.conn.commit()
            start = end
    print(f"  Wiped {deleted:,} prior digitaltwin rows for {args.plant}")

    run_id = str(uuid.uuid4())
    written = writer.write_analysis_results(
        plant_id, "digitaltwin", all_records,
        model_version="hierarchical_v10_vectorised",
        run_id=run_id,
    )
    print(f"  Wrote {written:,} rows (run_id={run_id})")

    print("Refreshing analysis_daily continuous aggregate…")
    writer.conn.autocommit = True
    with writer.conn.cursor() as cur:
        cur.execute("CALL refresh_continuous_aggregate('analysis_daily', '2020-01-01', '2027-01-01');")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
