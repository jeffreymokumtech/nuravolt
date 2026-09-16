#!/usr/bin/env python3
"""
Generate plant-level daily power summary from digital twin residuals.
Aggregates all inverter predictions to create expected vs actual power chart data.
"""

import os
import json
from datetime import datetime
import polars as pl
from pathlib import Path

def generate_plant_daily_power(plant_id: str, data_dir: str, output_dir: str, days_limit: int = 10):
    """Generate plant-level 3-hourly power summary from inverter residuals."""

    dt_path = Path(data_dir) / "digitaltwin" / plant_id

    # Find all residuals parquet files
    parquet_files = list(dt_path.glob("residuals_*.parquet"))

    if not parquet_files:
        print(f"No parquet files found for {plant_id}, trying CSV...")
        csv_files = list(dt_path.glob("residuals_*.csv"))
        if not csv_files:
            print(f"No residuals files found for {plant_id}")
            return None
        parquet_files = csv_files

    print(f"Found {len(parquet_files)} inverter files for {plant_id}")

    # Load and combine all inverter data
    dfs = []
    for f in parquet_files:
        inverter_id = f.stem.replace("residuals_", "")
        try:
            if f.suffix == ".parquet":
                df = pl.read_parquet(f)
            else:
                df = pl.read_csv(f)

            # Ensure timestamp is datetime
            if df["timestamp"].dtype == pl.Utf8:
                df = df.with_columns(pl.col("timestamp").str.to_datetime())

            # Add inverter_id column
            df = df.with_columns(pl.lit(inverter_id).alias("inverter_id"))
            dfs.append(df)
        except Exception as e:
            print(f"  Error loading {f.name}: {e}")
            continue

    if not dfs:
        print(f"No valid data loaded for {plant_id}")
        return None

    # Combine all inverters
    combined = pl.concat(dfs)

    # Get the date range
    max_ts = combined["timestamp"].max()
    min_ts = combined["timestamp"].min()

    # Filter to last N days
    from datetime import timedelta
    cutoff_ts = max_ts - timedelta(days=days_limit)
    combined = combined.filter(pl.col("timestamp") >= cutoff_ts)

    # Create 3-hour buckets
    combined = combined.with_columns([
        pl.col("timestamp").dt.date().alias("date"),
        (pl.col("timestamp").dt.hour() // 3 * 3).alias("hour_bucket"),
    ])

    # Create datetime string for the 3-hour bucket
    combined = combined.with_columns(
        (pl.col("timestamp").dt.strftime("%Y-%m-%d ") +
         pl.col("hour_bucket").cast(pl.Utf8).str.zfill(2) + pl.lit(":00")).alias("bucket_ts")
    )

    # Aggregate by 3-hour bucket - sum actual and expected across all inverters
    # Include all hours (not just daytime) so we see zeros at night
    hourly = (
        combined
        .group_by("bucket_ts")
        .agg([
            pl.col("actual").sum().fill_null(0).alias("actual_kw"),
            pl.col("expected").sum().fill_null(0).alias("expected_kw"),
            pl.col("residual").sum().fill_null(0).alias("residual_kw"),
            pl.col("irradiance").mean().alias("avg_irradiance"),
            pl.col("inverter_id").n_unique().alias("inverters_reporting"),
        ])
        .sort("bucket_ts")
    )

    # Convert kW to MWh for 3-hour period
    # Each 15-min reading is kW, we have 12 readings per 3-hour bucket
    # Sum of kW readings / 4 (to get kWh per reading) / 1000 = MWh
    hourly = hourly.with_columns([
        (pl.col("actual_kw") / 4 / 1000).alias("actual_mwh"),
        (pl.col("expected_kw") / 4 / 1000).alias("expected_mwh"),
        (pl.col("residual_kw") / 4 / 1000).alias("residual_mwh"),
    ])

    # Calculate loss percentage (handle division by zero)
    hourly = hourly.with_columns([
        pl.when(pl.col("expected_mwh") > 0.001)
        .then((pl.col("expected_mwh") - pl.col("actual_mwh")) / pl.col("expected_mwh") * 100)
        .otherwise(0.0)
        .alias("loss_pct")
    ])

    recent_daily = hourly

    # Convert to list of dicts for JSON
    records = recent_daily.to_dicts()

    # Rename bucket_ts to date for frontend compatibility
    for r in records:
        r["date"] = r.pop("bucket_ts", r.get("date", ""))

    # Calculate summary stats
    total_actual = recent_daily["actual_mwh"].sum()
    total_expected = recent_daily["expected_mwh"].sum()

    # Filter valid loss_pct values (not null, not infinite)
    valid_loss = recent_daily.filter(
        pl.col("loss_pct").is_not_null() &
        pl.col("loss_pct").is_finite()
    )
    avg_loss_pct = valid_loss["loss_pct"].mean() if len(valid_loss) > 0 else 0

    # Clean records - replace null/infinite with 0
    for r in records:
        for key in ['actual_mwh', 'expected_mwh', 'residual_mwh', 'loss_pct']:
            if key in r and (r[key] is None or (isinstance(r[key], float) and (r[key] != r[key] or abs(r[key]) == float('inf')))):
                r[key] = 0.0

    output = {
        "metadata": {
            "plant_id": plant_id,
            "generated_at": datetime.now().isoformat(),
            "data_start": str(cutoff_ts.date()) if cutoff_ts else str(min_ts.date()),
            "data_end": str(max_ts.date()) if max_ts else "",
            "days_shown": days_limit,
            "data_points": len(records),
            "resolution": "3-hourly",
            "total_inverters": len(parquet_files),
        },
        "summary": {
            "total_expected_mwh": round(total_expected, 2) if total_expected and total_expected == total_expected else 0,
            "total_actual_mwh": round(total_actual, 2) if total_actual and total_actual == total_actual else 0,
            "total_loss_mwh": round(total_expected - total_actual, 2) if total_expected and total_actual else 0,
            "avg_loss_pct": round(avg_loss_pct, 2) if avg_loss_pct and avg_loss_pct == avg_loss_pct else 0,
        },
        "daily": records,
    }

    # Write output
    output_path = Path(output_dir) / "digitaltwin" / plant_id / "plant_daily_power.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"Wrote {output_path}")
    print(f"  Period: {cutoff_ts.date() if cutoff_ts else min_ts.date()} to {max_ts.date() if max_ts else 'N/A'}")
    print(f"  Days: {len(records)}")
    print(f"  Total Expected: {total_expected:.1f} MWh")
    print(f"  Total Actual: {total_actual:.1f} MWh")
    print(f"  Avg Loss: {avg_loss_pct:.2f}%")

    return output


def generate_plant_power_history(plant_id: str, data_dir: str, output_dir: str, days_limit: int = 400):
    """Deep history companion to plant_daily_power.json.

    Emits plant_power_history.json: ~13 months of daily predicted/actual
    (avg kW during operating hours + integrated MWh) plus a 90-day 3-hourly
    tail, aggregated from the per-inverter twin residual files. Daily rows
    match the /api/digitaltwin/[plantId]/summary DB-branch semantics so the
    route's fixture fallback can serve them in the identical shape.

    Memory-safe: each residual file is reduced to daily aggregates before
    concatenation (alpha has 150 inverters x ~182k rows).

    The residual archives store power in per-unit of inverter nominal; the
    donor fleet is uniformly 60 kW nominal (ml_plant_summary capacity_MW /
    inverter count = 60 kW for alpha 9.0/150, ribera 7.2/120, eta
    1.68/28), so values are scaled to real kW here.
    """
    from datetime import timedelta

    NOMINAL_KW = 60.0

    dt_path = Path(data_dir) / "digitaltwin" / plant_id
    files = list(dt_path.glob("residuals_*.parquet")) or list(dt_path.glob("residuals_*.csv"))
    if not files:
        print(f"No residuals files found for {plant_id}")
        return None

    print(f"Found {len(files)} inverter files for {plant_id}")

    # Some plants (showcase specimens) ship residual archives for a subset of
    # the fleet; extrapolate plant totals to the full inverter count so the
    # chart shows plant-scale power, not subset-scale.
    fleet_scale = 1.0
    total_inverters = len(files)
    base_meta_path = dt_path / "plant_daily_power.json"
    if base_meta_path.exists():
        try:
            base_meta = json.loads(base_meta_path.read_text())["metadata"]
            declared = int(base_meta.get("total_inverters") or 0)
            if declared > len(files):
                fleet_scale = declared / len(files)
                total_inverters = declared
                print(f"  Extrapolating {len(files)} archived inverters to fleet of {declared} (x{fleet_scale:.1f})")
        except Exception:
            pass

    daily_frames = []
    tail_frames = []
    global_max = None

    for f in files:
        try:
            df = pl.read_parquet(f) if f.suffix == ".parquet" else pl.read_csv(f)
            if df["timestamp"].dtype == pl.Utf8:
                df = df.with_columns(pl.col("timestamp").str.to_datetime())
            df = df.with_columns([
                (pl.col("expected") * NOMINAL_KW * fleet_scale).alias("expected"),
                (pl.col("actual") * NOMINAL_KW * fleet_scale).alias("actual"),
                (pl.col("residual") * NOMINAL_KW * fleet_scale).alias("residual"),
            ])
        except Exception as e:
            print(f"  Error loading {f.name}: {e}")
            continue

        # Sample interval (hours) — residuals are 15-min but don't assume.
        diffs = df["timestamp"].diff().drop_nulls().dt.total_minutes()
        dt_hours = (diffs.median() or 15.0) / 60.0

        file_max = df["timestamp"].max()
        global_max = file_max if global_max is None else max(global_max, file_max)

        # Operating mask: daylight samples where the twin expects production.
        op = df.filter((pl.col("expected") > 1.0) | (pl.col("actual") > 1.0))
        daily = (
            op.group_by(pl.col("timestamp").dt.date().alias("date"))
            .agg([
                (pl.col("expected").sum() * dt_hours).alias("expected_kwh"),
                (pl.col("actual").sum() * dt_hours).alias("actual_kwh"),
                (pl.len() * dt_hours).alias("op_hours"),
            ])
        )
        daily_frames.append(daily)

        # Keep a generous raw tail for the 3-hourly recent series; trimmed to
        # the global 90-day window after all files are read.
        tail = df.filter(pl.col("timestamp") >= file_max - timedelta(days=100))
        tail_frames.append(tail.select(["timestamp", "actual", "expected", "residual"]))

    if not daily_frames:
        print(f"No valid data loaded for {plant_id}")
        return None

    cutoff_date = (global_max - timedelta(days=days_limit)).date()

    plant_daily = (
        pl.concat(daily_frames)
        .group_by("date")
        .agg([
            pl.col("expected_kwh").sum().alias("expected_kwh"),
            pl.col("actual_kwh").sum().alias("actual_kwh"),
            pl.col("op_hours").max().alias("op_hours"),
        ])
        .filter(pl.col("date") >= cutoff_date)
        .sort("date")
    )

    daily_records = []
    for r in plant_daily.to_dicts():
        op_hours = r["op_hours"] or 0
        pred_mwh = (r["expected_kwh"] or 0) / 1000
        act_mwh = (r["actual_kwh"] or 0) / 1000
        pred_kw = (pred_mwh * 1000 / op_hours) if op_hours > 0.5 else 0
        act_kw = (act_mwh * 1000 / op_hours) if op_hours > 0.5 else 0
        loss = ((pred_mwh - act_mwh) / pred_mwh * 100) if pred_mwh > 0.05 else None
        daily_records.append({
            "date": str(r["date"]),
            "predicted_kw": round(pred_kw, 1),
            "actual_kw": round(act_kw, 1),
            "residual_kw": round(act_kw - pred_kw, 1),
            "loss_pct": round(loss, 2) if loss is not None else None,
            "predicted_mwh": round(pred_mwh, 3),
            "actual_mwh": round(act_mwh, 3),
        })

    # 90-day 3-hourly tail: mean kW per inverter per bucket, summed across
    # inverters. All hours included so nights render as zeros.
    recent_cut = global_max - timedelta(days=90)
    tail = pl.concat(tail_frames).filter(pl.col("timestamp") >= recent_cut)
    tail = tail.with_columns(
        (pl.col("timestamp").dt.strftime("%Y-%m-%d ")
         + (pl.col("timestamp").dt.hour() // 3 * 3).cast(pl.Utf8).str.zfill(2)
         + pl.lit(":00")).alias("bucket_ts")
    )
    recent = (
        tail.group_by("bucket_ts")
        .agg([
            pl.col("actual").sum().alias("actual_sum"),
            pl.col("expected").sum().alias("expected_sum"),
            pl.col("residual").sum().alias("residual_sum"),
            pl.len().alias("samples"),
        ])
        .sort("bucket_ts")
    )
    n_inverters = len(files)
    recent_records = []
    for r in recent.to_dicts():
        # samples = inverters x readings-per-bucket; per-bucket mean kW x inverters
        per_reading = r["samples"] / n_inverters if n_inverters else 1
        scale = 1 / per_reading if per_reading > 0 else 0
        recent_records.append({
            "timestamp": r["bucket_ts"],
            "predicted_kw": round((r["expected_sum"] or 0) * scale, 1),
            "actual_kw": round((r["actual_sum"] or 0) * scale, 1),
            "residual_kw": round((r["residual_sum"] or 0) * scale, 1),
        })

    output = {
        "metadata": {
            "plant_id": plant_id,
            "generated_at": datetime.now().isoformat(),
            "data_start": daily_records[0]["date"] if daily_records else "",
            "data_end": daily_records[-1]["date"] if daily_records else "",
            "days": len(daily_records),
            "resolution": "daily + 3-hourly tail",
            "source": "twin_residuals" if fleet_scale == 1.0 else "twin_residuals (fleet-extrapolated)",
            "total_inverters": total_inverters,
        },
        "daily": daily_records,
        "recent": recent_records,
    }

    output_path = Path(output_dir) / "digitaltwin" / plant_id / "plant_power_history.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=1, default=str)
    print(f"Wrote {output_path} ({len(daily_records)} daily, {len(recent_records)} recent)")
    return output


def synth_power_history(plant_id: str, data_dir: str, output_dir: str, days_limit: int = 400):
    """Seasonal extrapolation of the 10-day plant_daily_power.json for demo
    plants that have no residual archives. Deterministic per plant (seeded),
    physically shaped: shared weather on predicted+actual, slow soiling drift
    with cleaning resets on the loss.
    """
    import math
    import random
    from datetime import timedelta, date as date_cls

    base_path = Path(data_dir) / "digitaltwin" / plant_id / "plant_daily_power.json"
    if not base_path.exists():
        print(f"No plant_daily_power.json for {plant_id}; cannot synthesize")
        return None
    base = json.loads(base_path.read_text())
    days_shown = base["metadata"].get("days_shown", 10) or 10
    total_expected = base["summary"].get("total_expected_mwh", 0) or 0
    data_end_s = base["metadata"].get("data_end", "")
    if not data_end_s or total_expected <= 0:
        print(f"Unusable base file for {plant_id}")
        return None
    data_end = date_cls.fromisoformat(data_end_s[:10])
    daily_base_mwh = total_expected / days_shown

    rng = random.Random(f"power-history-{plant_id}")
    # De-seasonalize the base: the 10-day sample sits at some point of the
    # year; scale so the annual mean matches the observed sample.
    end_doy = data_end.timetuple().tm_yday
    seasonal_at_end = 1 + 0.45 * math.cos(2 * math.pi * (end_doy - 172) / 365)
    annual_base = daily_base_mwh / max(0.4, seasonal_at_end)

    weather = 1.0
    loss = 2.0 + rng.random() * 2
    daily_records = []
    for i in range(days_limit, 0, -1):
        d = data_end - timedelta(days=i - 1)
        doy = d.timetuple().tm_yday
        seasonal = 1 + 0.45 * math.cos(2 * math.pi * (doy - 172) / 365)
        weather = max(0.5, min(1.15, 0.6 * weather + 0.4 + rng.gauss(0, 0.09)))
        # Soiling accumulates slowly; rain/cleaning resets a few times a year.
        loss = min(9.5, loss + 0.035 + rng.gauss(0, 0.05))
        if rng.random() < 0.012:
            loss = 1.0 + rng.random() * 1.5
        pred_mwh = annual_base * seasonal * weather
        act_mwh = pred_mwh * (1 - loss / 100)
        op_hours = 9 + 3.5 * math.cos(2 * math.pi * (doy - 172) / 365)
        pred_kw = pred_mwh * 1000 / op_hours
        act_kw = act_mwh * 1000 / op_hours
        daily_records.append({
            "date": d.isoformat(),
            "predicted_kw": round(pred_kw, 1),
            "actual_kw": round(act_kw, 1),
            "residual_kw": round(act_kw - pred_kw, 1),
            "loss_pct": round(loss, 2),
            "predicted_mwh": round(pred_mwh, 3),
            "actual_mwh": round(act_mwh, 3),
        })

    # 3-hourly tail: daylight bell over the last 90 synthetic days.
    recent_records = []
    for rec in daily_records[-90:]:
        d = date_cls.fromisoformat(rec["date"])
        for hour in range(0, 24, 3):
            # Bell centred on 13:00 local; ~zero outside daylight.
            x = (hour + 1.5 - 13) / 4.5
            bell = math.exp(-x * x)
            if bell < 0.02:
                bell = 0.0
            pred_kw = rec["predicted_kw"] * bell * (1 + rng.gauss(0, 0.03))
            act_kw = pred_kw * (1 - rec["loss_pct"] / 100)
            recent_records.append({
                "timestamp": f"{d.isoformat()} {hour:02d}:00",
                "predicted_kw": round(max(0, pred_kw), 1),
                "actual_kw": round(max(0, act_kw), 1),
                "residual_kw": round(max(0, act_kw) - max(0, pred_kw), 1),
            })

    output = {
        "metadata": {
            "plant_id": plant_id,
            "generated_at": datetime.now().isoformat(),
            "data_start": daily_records[0]["date"],
            "data_end": daily_records[-1]["date"],
            "days": len(daily_records),
            "resolution": "daily + 3-hourly tail",
            "source": "synth_extrapolation",
            "total_inverters": base["metadata"].get("total_inverters", 0),
        },
        "daily": daily_records,
        "recent": recent_records,
    }
    output_path = Path(output_dir) / "digitaltwin" / plant_id / "plant_power_history.json"
    with open(output_path, "w") as f:
        json.dump(output, f, indent=1, default=str)
    print(f"Wrote {output_path} (synth, {len(daily_records)} daily)")
    return output


# Plants with real per-inverter residual archives vs. demo plants that only
# carry the 10-day summary (extrapolated with --synth semantics).
RESIDUAL_PLANTS = ["alpha", "eta", "ribera"]
SYNTH_PLANTS = ["gamma", "theta"]


def main():
    # Base paths
    data_dir = "<repo>/public/data"
    output_dir = data_dir

    for plant_id in RESIDUAL_PLANTS:
        print(f"\n{'='*60}\nProcessing {plant_id}\n{'='*60}")
        try:
            generate_plant_daily_power(plant_id, data_dir, output_dir, days_limit=10)
            generate_plant_power_history(plant_id, data_dir, output_dir, days_limit=400)
        except Exception as e:
            print(f"Error processing {plant_id}: {e}")
            import traceback
            traceback.print_exc()

    for plant_id in SYNTH_PLANTS:
        print(f"\n{'='*60}\nSynthesizing {plant_id}\n{'='*60}")
        try:
            synth_power_history(plant_id, data_dir, output_dir, days_limit=400)
        except Exception as e:
            print(f"Error synthesizing {plant_id}: {e}")
            import traceback
            traceback.print_exc()


if __name__ == "__main__":
    main()
