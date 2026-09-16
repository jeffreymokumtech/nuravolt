#!/usr/bin/env python3
"""
Full pipeline test: SCADA → Twins → Disaggregation → DustIQ Comparison.

Tests the complete loss disaggregation workflow using real SCADA data.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.loss_disaggregator import LossDisaggregator
from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory


def detect_columns(df: pl.DataFrame, plant_id: str) -> dict:
    """Auto-detect column names for a plant."""
    cols = df.columns

    # Find irradiance column
    irr_candidates = [c for c in cols if any(x in c.lower() for x in ['irrad', 'radiation', 'ghi', 'poa'])]
    irr_col = next((c for c in irr_candidates if 'average' in c.lower() or 'pyran' in c.lower()),
                   irr_candidates[0] if irr_candidates else None)

    # Find ambient temp column
    temp_candidates = [c for c in cols if 'ambient' in c.lower() or 'umgebung' in c.lower()]
    ambient_col = temp_candidates[0] if temp_candidates else None

    # Find module temp column
    mod_temp_candidates = [c for c in cols if 'module' in c.lower() and 'temp' in c.lower()]
    module_temp_col = mod_temp_candidates[0] if mod_temp_candidates else None

    # Find power column
    power_candidates = [c for c in cols if 'power' in c.lower() and 'plant' in c.lower()]
    power_col = power_candidates[0] if power_candidates else None

    # Find DustIQ column
    dustiq_candidates = [c for c in cols if 'dustiq' in c.lower() and 'soiling' in c.lower()]
    dustiq_col = dustiq_candidates[0] if dustiq_candidates else None

    # Find inverter columns (DC current, voltage, temp, power)
    inverter_patterns = {}
    inv_prefixes = set()
    for c in cols:
        if 'INV' in c or 'inv' in c.lower():
            # Extract inverter ID
            parts = c.split('/')
            if len(parts) >= 2:
                prefix = parts[0].strip()
                inv_prefixes.add(prefix)

    for prefix in inv_prefixes:
        inv_id = prefix.split(':')[-1].strip() if ':' in prefix else prefix
        # Keep original format with spaces (matches twin file names)

        # Find columns for this inverter
        inv_cols = [c for c in cols if prefix in c]

        current_col = next((c for c in inv_cols if 'I_DC' in c or 'current' in c.lower()), None)
        voltage_col = next((c for c in inv_cols if 'U_DC' in c or 'voltage' in c.lower()), None)
        temp_col = next((c for c in inv_cols if 'temp' in c.lower()), None)
        pwr_col = next((c for c in inv_cols if 'power' in c.lower() or 'P_AC' in c), None)

        if current_col or voltage_col:
            inverter_patterns[inv_id] = {
                'current': current_col,
                'voltage': voltage_col,
                'temperature': temp_col,
                'power': pwr_col,
            }

    return {
        'irradiance': irr_col,
        'ambient_temp': ambient_col,
        'module_temp': module_temp_col,
        'power': power_col,
        'dustiq': dustiq_col,
        'inverters': inverter_patterns,
    }


def run_disaggregation_test(plant_id: str, n_days: int = 90) -> dict:
    """Run full disaggregation pipeline for a plant."""
    print(f"\n{'='*70}")
    print(f"FULL PIPELINE TEST: {plant_id.upper()}")
    print(f"{'='*70}")

    # Load SCADA data
    scada_path = Path(f"backenddata/scada/{plant_id}")
    parquet_files = list(scada_path.glob("*.parquet"))

    if not parquet_files:
        print(f"  No SCADA data found")
        return {"status": "no_scada"}

    df = pl.read_parquet(parquet_files[0])
    print(f"  Loaded {len(df):,} rows")

    # Detect columns
    col_map = detect_columns(df, plant_id)
    print(f"  Irradiance: {col_map['irradiance']}")
    print(f"  Ambient temp: {col_map['ambient_temp']}")
    print(f"  DustIQ: {col_map['dustiq']}")
    print(f"  Inverters detected: {len(col_map['inverters'])}")

    if not col_map['irradiance'] or not col_map['ambient_temp']:
        print("  Missing required columns")
        return {"status": "missing_columns"}

    # Check if twins exist
    twins_path = Path(f"public/data/digitaltwin/{plant_id}")
    if not twins_path.exists():
        print(f"  No twins found")
        return {"status": "no_twins"}

    # Load DustIQ ground truth
    dustiq_path = Path(f"public/data/soiling/{plant_id}/dustiq_history.json")
    if dustiq_path.exists():
        with open(dustiq_path) as f:
            dustiq_data = json.load(f)
        dustiq_daily = dustiq_data.get("daily_data", [])
        print(f"  DustIQ history: {len(dustiq_daily)} days")
    else:
        dustiq_daily = []
        print("  No DustIQ history file")

    # Initialize disaggregator
    disaggregator = LossDisaggregator(
        plant_id=plant_id,
        twins_path=twins_path,
    )

    # Sample inverters
    sample_inv_ids = list(col_map['inverters'].keys())[:5]

    try:
        n_loaded = disaggregator.load_twins(sample_inv_ids)
        print(f"  Loaded {n_loaded} twins")
    except Exception as e:
        print(f"  Failed to load twins: {e}")
        return {"status": "twin_load_failed", "error": str(e)}

    # Filter to recent data with good irradiance
    df_recent = df.filter(
        pl.col(col_map['irradiance']).is_not_null() &
        (pl.col(col_map['irradiance']) > 100)
    ).tail(n_days * 96)  # ~96 points per day at 15-min resolution

    print(f"  Analyzing {len(df_recent):,} rows ({n_days} days)")

    # For each inverter, compute disaggregation
    all_daily_summaries = {}

    for inv_id in sample_inv_ids[:3]:  # Test with 3 inverters
        inv_cols = col_map['inverters'].get(inv_id, {})
        if not inv_cols.get('current') and not inv_cols.get('voltage'):
            continue

        print(f"\n  Analyzing inverter: {inv_id}")

        # Prepare data for this inverter - collect all columns we need first
        select_cols = [
            'timestamp',
            pl.col(col_map['irradiance']).alias('irradiance'),
        ]

        if col_map['ambient_temp'] and col_map['ambient_temp'] in df_recent.columns:
            select_cols.append(pl.col(col_map['ambient_temp']).alias('ambient_temp'))
        else:
            select_cols.append(pl.lit(25.0).alias('ambient_temp'))

        if inv_cols.get('current') and inv_cols['current'] in df_recent.columns:
            select_cols.append(pl.col(inv_cols['current']).alias('dc_current'))
        if inv_cols.get('voltage') and inv_cols['voltage'] in df_recent.columns:
            select_cols.append(pl.col(inv_cols['voltage']).alias('dc_voltage'))
        if inv_cols.get('power') and inv_cols['power'] in df_recent.columns:
            select_cols.append(pl.col(inv_cols['power']).alias('power'))

        inv_df = df_recent.select(select_cols)

        # Run disaggregation - analyze_inverter returns a DataFrame
        try:
            df_disagg = disaggregator.analyze_inverter(
                inv_df,
                inv_id,
                power_col='power' if 'power' in inv_df.columns else None,
                irradiance_col='irradiance',
                ambient_temp_col='ambient_temp',
                use_twins=True,
            )

            if df_disagg is not None and len(df_disagg) > 0:
                # Add date column and aggregate to daily
                # Convert "2022.01.01 00:00" to "2022-01-01"
                df_disagg = df_disagg.with_columns([
                    pl.col("timestamp").str.slice(0, 10).str.replace_all(r"\.", "-").alias("date")
                ])

                # Aggregate by day
                df_daily = df_disagg.group_by("date").agg([
                    pl.col("loss_soiling_pct").mean().alias("loss_soiling_pct"),
                    pl.col("loss_thermal_pct").mean().alias("loss_thermal_pct"),
                    pl.col("loss_shading_pct").mean().alias("loss_shading_pct"),
                    pl.col("power_expected").sum().alias("energy_expected"),
                    pl.col("power_actual").sum().alias("energy_actual"),
                    pl.len().alias("n_samples"),
                ]).sort("date")

                all_daily_summaries[inv_id] = df_daily
                print(f"    Got {len(df_daily)} daily summaries")
        except Exception as e:
            import traceback
            print(f"    Error: {e}")
            traceback.print_exc()

    if not all_daily_summaries:
        print("  No disaggregation results")
        return {"status": "no_results"}

    # Aggregate across inverters and compute rolling soiling estimates
    print("\n  Computing rolling soiling estimates...")

    # Collect all daily soiling estimates from DataFrames
    daily_soiling = []
    for inv_id, df_inv in all_daily_summaries.items():
        if isinstance(df_inv, pl.DataFrame):
            for row in df_inv.iter_rows(named=True):
                daily_soiling.append({
                    "date": row.get("date", ""),
                    "soiling_loss_pct": row.get("loss_soiling_pct", 0),
                    "inverter": inv_id,
                })

    if not daily_soiling:
        print("  No daily soiling data")
        return {"status": "no_daily_data"}

    df_soiling = pl.DataFrame(daily_soiling)

    # Average across inverters per day
    df_daily_avg = df_soiling.group_by("date").agg([
        pl.col("soiling_loss_pct").mean().alias("soiling_loss_pct"),
    ]).sort("date")

    # Convert to soiling ratio and compute rolling averages
    df_daily_avg = df_daily_avg.with_columns([
        (1 - pl.col("soiling_loss_pct") / 100).clip(0.7, 1.0).alias("sr_daily")
    ])

    df_daily_avg = df_daily_avg.with_columns([
        pl.col("sr_daily").rolling_mean(window_size=3, min_samples=1).alias("sr_3d"),
        pl.col("sr_daily").rolling_mean(window_size=7, min_samples=2).alias("sr_7d"),
        pl.col("sr_daily").rolling_mean(window_size=14, min_samples=3).alias("sr_14d"),
    ])

    print(f"  Got {len(df_daily_avg)} days of disaggregated soiling")
    print(f"  Avg SR (daily): {df_daily_avg['sr_daily'].mean():.4f}")
    print(f"  Avg SR (7-day): {df_daily_avg['sr_7d'].mean():.4f}")

    # Compare with DustIQ
    if dustiq_daily:
        print("\n  Comparing with DustIQ ground truth...")

        # Convert DustIQ to DataFrame
        df_dustiq = pl.DataFrame(dustiq_daily)

        # Find SR column
        sr_col = next((c for c in df_dustiq.columns if 'sr_dustiq' in c.lower() or 'soiling_ratio' in c.lower()), None)
        if sr_col:
            df_dustiq = df_dustiq.with_columns(pl.col(sr_col).alias("sr_ground_truth"))
        else:
            print("  No SR column in DustIQ data")
            return {"status": "no_dustiq_sr", "disaggregation": df_daily_avg.to_dicts()}

        # Join on date
        df_compare = df_daily_avg.join(
            df_dustiq.select(["date", "sr_ground_truth"]),
            on="date",
            how="inner"
        )

        print(f"  Matched {len(df_compare)} days")

        if len(df_compare) < 10:
            print("  Not enough matching days")
            return {"status": "insufficient_matches", "n_matches": len(df_compare)}

        # Filter to valid DustIQ values
        df_compare = df_compare.filter(
            (pl.col("sr_ground_truth") >= 0.7) &
            (pl.col("sr_ground_truth") <= 1.02)
        )

        print(f"  After filtering: {len(df_compare)} days")

        # Compute metrics for each rolling window
        results = {"metrics": {}}

        for sr_col_name, label in [
            ("sr_daily", "daily"),
            ("sr_3d", "3-day"),
            ("sr_7d", "7-day"),
            ("sr_14d", "14-day"),
        ]:
            sr_est = df_compare[sr_col_name].drop_nulls().to_numpy()
            sr_true = df_compare["sr_ground_truth"].to_numpy()[:len(sr_est)]

            if len(sr_est) < 10:
                continue

            mae = float(np.mean(np.abs(sr_est - sr_true)))
            bias = float(np.mean(sr_est - sr_true))
            rmse = float(np.sqrt(np.mean((sr_est - sr_true) ** 2)))

            if np.std(sr_est) > 0 and np.std(sr_true) > 0:
                corr = float(np.corrcoef(sr_est, sr_true)[0, 1])
            else:
                corr = 0.0

            # R² calculation
            ss_res = np.sum((sr_true - sr_est) ** 2)
            ss_tot = np.sum((sr_true - np.mean(sr_true)) ** 2)
            r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

            results["metrics"][label] = {
                "mae": round(mae, 4),
                "rmse": round(rmse, 4),
                "bias": round(bias, 4),
                "correlation": round(corr, 3),
                "r2": round(r2, 3),
                "n_samples": len(sr_est),
            }

            print(f"    {label:>8}: MAE={mae:.4f}, R²={r2:.3f}, Corr={corr:.3f}")

        # Check during actual soiling events (SR < 0.98)
        df_soiling_events = df_compare.filter(pl.col("sr_ground_truth") < 0.98)
        if len(df_soiling_events) >= 5:
            print(f"\n  During soiling events (SR < 0.98): {len(df_soiling_events)} days")

            sr_est = df_soiling_events["sr_7d"].drop_nulls().to_numpy()
            sr_true = df_soiling_events["sr_ground_truth"].to_numpy()[:len(sr_est)]

            if len(sr_est) >= 5 and np.std(sr_true) > 0.001:
                ss_res = np.sum((sr_true - sr_est) ** 2)
                ss_tot = np.sum((sr_true - np.mean(sr_true)) ** 2)
                r2_soiling = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
                mae_soiling = float(np.mean(np.abs(sr_est - sr_true)))

                print(f"    7-day avg: MAE={mae_soiling:.4f}, R²={r2_soiling:.3f}")
                results["soiling_events"] = {
                    "n_days": len(df_soiling_events),
                    "mae": round(mae_soiling, 4),
                    "r2": round(r2_soiling, 3),
                }

        return {
            "status": "success",
            "plant_id": plant_id,
            "n_inverters_analyzed": len(all_daily_summaries),
            "n_days": len(df_daily_avg),
            "n_matched": len(df_compare),
            "metrics": results.get("metrics", {}),
            "soiling_events": results.get("soiling_events"),
        }

    return {
        "status": "no_dustiq_comparison",
        "disaggregation": df_daily_avg.to_dicts()[:10],
    }


def main():
    """Run full pipeline test on all plants."""
    print("\n" + "="*70)
    print("FULL DISAGGREGATION PIPELINE TEST")
    print("SCADA → Twins → Loss Decomposition → DustIQ Validation")
    print("="*70)

    plants = ["epsilon", "alpha", "ribera", "eta", "zeta", "delta", "gamma"]

    all_results = []

    for plant_id in plants:
        result = run_disaggregation_test(plant_id, n_days=180)
        all_results.append(result)

        if result.get("status") != "success":
            print(f"\n  Status: {result.get('status')}")

    # Summary
    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"{'Plant':<15} | {'Status':<12} | {'MAE 7d':<10} | {'R² 7d':<10} | {'Soiling R²':<10}")
    print("-"*70)

    for r in all_results:
        plant = r.get("plant_id", "unknown")
        status = r.get("status", "error")

        if status == "success" and r.get("metrics"):
            m = r["metrics"].get("7-day", {})
            mae = f"{m.get('mae', 0):.4f}"
            r2 = f"{m.get('r2', 0):.3f}"

            soiling_events = r.get("soiling_events")
            if soiling_events is not None:
                soiling_r2 = soiling_events.get("r2", None)
                soiling_str = f"{soiling_r2:.3f}" if soiling_r2 is not None else "N/A"
            else:
                soiling_str = "N/A"
        else:
            mae = r2 = soiling_str = "N/A"

        print(f"{plant:<15} | {status:<12} | {mae:<10} | {r2:<10} | {soiling_str:<10}")

    # Save results
    output_path = Path("public/data/digitaltwin/full_pipeline_test.json")
    with open(output_path, "w") as f:
        json.dump({
            "test_date": datetime.now().isoformat(),
            "results": all_results,
        }, f, indent=2, default=str)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
