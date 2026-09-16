#!/usr/bin/env python3
"""
Evaluate Loss Disaggregation method for soiling estimation.

Compares the physics-based loss disaggregation (peeling) approach
against DustIQ ground truth soiling measurements.

Metrics:
- R², MAE, Correlation
- Directional accuracy (upward/downward movements)
- Rain cleaning detection accuracy
"""

import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import polars as pl

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))


# Plant configurations
PLANTS = {
    "epsilon": {
        "name": "Epsilon",
        "scada_path": "backenddata/scada/epsilon",
        "twins_path": "public/data/digitaltwin/epsilon",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
        "sl_col": "Epsilon: Meteo.DustIQ / Soiling Loss Sensor 1 (%)",
    },
    "ribera": {
        "name": "Ribera (ES)",
        "scada_path": "backenddata/scada/ribera",
        "twins_path": "public/data/digitaltwin/ribera",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Ribera (ES): DustIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "eta": {
        "name": "Eta (ES)",
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "sr_col": "Eta (ES): Dust_IQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Eta (ES): Dust_IQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "delta": {
        "name": "Delta (ES)",
        "scada_path": "backenddata/scada/delta",
        "twins_path": "public/data/digitaltwin/delta",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Delta (ES): DustIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "zeta": {
        "name": "Zeta (ES)",
        "scada_path": "backenddata/scada/zeta",
        "twins_path": "public/data/digitaltwin/zeta",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Zeta (ES): DUSTIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "gamma": {
        "name": "Gamma (ES)",
        "scada_path": "backenddata/scada/gamma",
        "twins_path": "public/data/digitaltwin/gamma",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
        "sl_col": "Gamma 1& 2 (ES): Dust_IQ / Soiling Loss Sensor 1 (%)",
    },
}


def find_column(df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
    """Find column matching any of the patterns, handling encoding issues."""
    for pattern in patterns:
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
            if pattern_clean in col_clean:
                return col
    return None


def calculate_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    """Calculate regression metrics."""
    mask = ~np.isnan(y_true) & ~np.isnan(y_pred)
    y_true, y_pred = y_true[mask], y_pred[mask]

    if len(y_true) < 10:
        return {"r2": np.nan, "mae": np.nan, "rmse": np.nan, "corr": np.nan, "n": len(y_true)}

    mae = np.mean(np.abs(y_true - y_pred))
    rmse = np.sqrt(np.mean((y_true - y_pred) ** 2))
    ss_res = np.sum((y_true - y_pred) ** 2)
    ss_tot = np.sum((y_true - np.mean(y_true)) ** 2)
    r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
    corr = np.corrcoef(y_true, y_pred)[0, 1] if len(y_true) > 1 else 0

    return {"r2": r2, "mae": mae, "rmse": rmse, "corr": corr, "n": len(y_true)}


def calculate_directional_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    """
    Calculate directional accuracy metrics.

    Checks if the model correctly predicts:
    - Downward movements (soiling accumulation: SR decreases)
    - Upward movements (cleaning events: SR increases)
    - Stable periods (no significant change)
    """
    mask = ~np.isnan(y_true) & ~np.isnan(y_pred)
    y_true, y_pred = y_true[mask], y_pred[mask]

    if len(y_true) < 10:
        return {
            "direction_accuracy": np.nan,
            "downward_accuracy": np.nan,
            "upward_accuracy": np.nan,
            "stable_accuracy": np.nan,
            "n_downward": 0,
            "n_upward": 0,
            "n_stable": 0,
        }

    # Calculate daily changes
    true_change = np.diff(y_true)
    pred_change = np.diff(y_pred)

    # Threshold for considering a change as "significant"
    # Typical soiling rate is 0.1-0.5% per day
    threshold = 0.002  # 0.2% change

    # Classify each day's change
    true_down = true_change < -threshold
    true_up = true_change > threshold
    true_stable = ~true_down & ~true_up

    pred_down = pred_change < -threshold
    pred_up = pred_change > threshold
    pred_stable = ~pred_down & ~pred_up

    # Calculate directional accuracy
    # Overall: same direction (or both stable)
    direction_match = (
        (true_down & pred_down) |
        (true_up & pred_up) |
        (true_stable & pred_stable)
    )
    direction_accuracy = np.mean(direction_match)

    # Downward accuracy: when true is down, is pred also down?
    n_true_down = np.sum(true_down)
    downward_accuracy = np.mean(pred_down[true_down]) if n_true_down > 0 else np.nan

    # Upward accuracy (cleaning detection): when true is up, is pred also up?
    n_true_up = np.sum(true_up)
    upward_accuracy = np.mean(pred_up[true_up]) if n_true_up > 0 else np.nan

    # Stable accuracy: when true is stable, is pred also stable?
    n_true_stable = np.sum(true_stable)
    stable_accuracy = np.mean(pred_stable[true_stable]) if n_true_stable > 0 else np.nan

    # Also track magnitude accuracy for movements
    # When there's a true movement, how well does pred magnitude match?
    if n_true_down > 0:
        down_magnitude_mae = np.mean(np.abs(true_change[true_down] - pred_change[true_down]))
    else:
        down_magnitude_mae = np.nan

    if n_true_up > 0:
        up_magnitude_mae = np.mean(np.abs(true_change[true_up] - pred_change[true_up]))
    else:
        up_magnitude_mae = np.nan

    return {
        "direction_accuracy": direction_accuracy,
        "downward_accuracy": downward_accuracy,  # Soiling accumulation detection
        "upward_accuracy": upward_accuracy,      # Cleaning event detection
        "stable_accuracy": stable_accuracy,
        "n_downward": int(n_true_down),
        "n_upward": int(n_true_up),
        "n_stable": int(n_true_stable),
        "down_magnitude_mae": down_magnitude_mae,
        "up_magnitude_mae": up_magnitude_mae,
    }


def find_inverter_columns(df: pl.DataFrame, inv_id: str) -> Dict[str, Optional[str]]:
    """Find power, irradiance, and temperature columns for an inverter."""
    result = {"power": None, "irradiance": None, "ambient_temp": None}

    for c in df.columns:
        c_lower = c.lower()
        if inv_id in c:
            # Power column for this inverter
            if 'p_ac' in c_lower or ('power' in c_lower and 'normalized' not in c_lower):
                result["power"] = c
        # Plant-level irradiance
        if 'irradiation_average' in c_lower or ('irradiance' in c_lower and 'plant' in c_lower):
            result["irradiance"] = c
        # Ambient temperature
        if 'ambient' in c_lower and ('temp' in c_lower or c.endswith(')')):
            if result["ambient_temp"] is None:
                result["ambient_temp"] = c

    return result


def run_loss_disaggregation(
    df: pl.DataFrame,
    twins_path: Path,
    max_inverters: int = 5,
) -> Optional[pl.DataFrame]:
    """
    Run loss disaggregation and return daily soiling estimates.

    Returns DataFrame with columns: date, loss_soiling_pct, sr_estimated
    """
    from nuravolt.digitaltwin.loss_disaggregator import LossDisaggregator

    # Create disaggregator
    plant_id = twins_path.name
    disaggregator = LossDisaggregator(
        plant_id=plant_id,
        twins_path=twins_path,
    )

    # Load twins
    n_twins = disaggregator.load_twins()
    if n_twins == 0:
        print(f"    No twins loaded for {plant_id}")
        return None

    print(f"    Loaded {n_twins} twins")

    # Get available inverter IDs
    inv_ids = list(disaggregator.twins.keys())[:max_inverters]

    # Find plant-level irradiance and ambient temp columns
    irr_col = None
    temp_col = None
    for c in df.columns:
        c_lower = c.lower()
        if ('irradiation_average' in c_lower or 'irradiance' in c_lower) and 'plant' in c_lower:
            irr_col = c
        if 'ambient' in c_lower and ('temp' in c_lower or c.endswith(')')):
            if temp_col is None:
                temp_col = c

    if not irr_col:
        print(f"    Could not find irradiance column")
        return None

    print(f"    Irradiance: {irr_col}")
    print(f"    Ambient: {temp_col}")

    # Collect daily results from each inverter
    all_daily_data = []
    success_count = 0

    for inv_id in inv_ids:
        try:
            # Find power column for this inverter
            power_col = None
            for c in df.columns:
                if inv_id in c and ('p_ac' in c.lower() or ('power' in c.lower() and 'normalized' not in c.lower())):
                    power_col = c
                    break

            if not power_col:
                print(f"      {inv_id}: No power column")
                continue

            # Create inverter-specific DataFrame with standardized names
            select_cols = [
                pl.col("timestamp"),
                pl.col(power_col).alias("power"),
                pl.col(irr_col).alias("irradiance"),
            ]
            if temp_col:
                select_cols.append(pl.col(temp_col).alias("ambient_temp"))
            else:
                select_cols.append(pl.lit(25.0).alias("ambient_temp"))

            df_inv = df.select(select_cols)

            # Filter to daytime with valid power
            df_inv = df_inv.filter(
                pl.col("irradiance") > 50,
                pl.col("power") > 0,
            )

            if len(df_inv) < 100:
                print(f"      {inv_id}: Insufficient daytime data")
                continue

            # Analyze this inverter
            daily_results = disaggregator.analyze_daily(
                df_inv, inv_id,
                power_col="power",
                irradiance_col="irradiance",
                ambient_temp_col="ambient_temp",
            )

            for summary in daily_results:
                all_daily_data.append({
                    "date": summary.date,
                    "inverter_id": inv_id,
                    "loss_soiling_pct": summary.loss_soiling_pct,
                    "loss_thermal_pct": summary.loss_thermal_pct,
                    "loss_shading_pct": summary.loss_shading_pct,
                    "loss_equipment_pct": summary.loss_equipment_pct,
                    "n_samples": summary.n_samples,
                })
            success_count += 1

        except Exception as e:
            print(f"      {inv_id}: Error - {str(e)[:60]}")

    print(f"    Successfully analyzed {success_count}/{len(inv_ids)} inverters")

    if not all_daily_data:
        return None

    df_daily = pl.DataFrame(all_daily_data)

    # Normalize date format (convert dots to dashes: 2022.01.01 -> 2022-01-01)
    df_daily = df_daily.with_columns([
        pl.col("date").str.replace_all(r"\.", "-").alias("date")
    ])

    # Aggregate across inverters (mean per day)
    df_agg = df_daily.group_by("date").agg([
        pl.col("loss_soiling_pct").mean().alias("loss_soiling_pct"),
        pl.col("loss_thermal_pct").mean().alias("loss_thermal_pct"),
        pl.col("loss_shading_pct").mean().alias("loss_shading_pct"),
        pl.col("loss_equipment_pct").mean().alias("loss_equipment_pct"),
        pl.col("n_samples").sum().alias("n_samples"),
        pl.col("inverter_id").n_unique().alias("n_inverters"),
    ]).sort("date")

    # Convert loss % to soiling ratio: SR = 1 - (loss / 100)
    # But cap at reasonable values
    df_agg = df_agg.with_columns([
        (1 - pl.col("loss_soiling_pct") / 100).clip(0.7, 1.02).alias("sr_estimated")
    ])

    return df_agg


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate loss disaggregation for a single plant."""

    print(f"\n{'='*60}")
    print(f"EVALUATING: {plant_id.upper()}")
    print(f"{'='*60}")

    result = {"plant_id": plant_id, "status": "unknown"}

    # Load SCADA data
    scada_path = Path(config["scada_path"])
    if not scada_path.exists():
        print(f"  ✗ SCADA path not found")
        result["status"] = "no_scada"
        return result

    parquet_files = list(scada_path.glob("*.parquet"))
    if not parquet_files:
        print(f"  ✗ No parquet files")
        result["status"] = "no_parquet"
        return result

    df = pl.read_parquet(parquet_files[0])
    print(f"  Loaded {len(df):,} rows")

    # Find DustIQ columns
    sr_col = find_column(df, [config.get("sr_col", ""), "soiling_ratio_sensor"])
    sl_col = find_column(df, [config.get("sl_col", ""), "soiling loss sensor"])

    print(f"  Soiling ratio col: {sr_col}")
    print(f"  Soiling loss col: {sl_col}")

    # Get DustIQ ground truth at daily level
    if sr_col and sr_col in df.columns:
        df = df.with_columns([
            (pl.col(sr_col) / 100).alias("sr_dustiq"),  # Convert % to fraction
        ])
    elif sl_col and sl_col in df.columns:
        df = df.with_columns([
            (1 - pl.col(sl_col) / 100).clip(0.5, 1.02).alias("sr_dustiq"),
        ])
    else:
        print(f"  ✗ No soiling ground truth column")
        result["status"] = "no_ground_truth"
        return result

    # Add date column
    df = df.with_columns([
        pl.col("timestamp").str.slice(0, 10).str.replace_all(r"\.", "-").alias("date")
    ])

    # Get daily DustIQ (mean per day, filtering valid values)
    df_dustiq_daily = df.filter(
        pl.col("sr_dustiq").is_not_null() &
        (pl.col("sr_dustiq") >= 0.7) &
        (pl.col("sr_dustiq") <= 1.02)
    ).group_by("date").agg([
        pl.col("sr_dustiq").mean().alias("sr_dustiq"),
        pl.len().alias("n_dustiq_samples"),
    ]).sort("date")

    print(f"  DustIQ daily samples: {len(df_dustiq_daily)}")

    # Check twins path
    twins_path = Path(config["twins_path"])
    if not twins_path.exists():
        print(f"  ✗ Twins path not found")
        result["status"] = "no_twins"
        return result

    # Run loss disaggregation
    print("\n  Running loss disaggregation...")
    df_disagg = run_loss_disaggregation(df, twins_path, max_inverters=5)

    if df_disagg is None:
        print(f"  ✗ Loss disaggregation failed")
        result["status"] = "disagg_failed"
        return result

    print(f"  Disaggregation days: {len(df_disagg)}")

    # Debug: show date ranges
    disagg_dates = df_disagg["date"].sort()
    dustiq_dates = df_dustiq_daily["date"].sort()
    print(f"    Disagg date range: {disagg_dates.head(1).to_list()[0]} to {disagg_dates.tail(1).to_list()[0]}")
    print(f"    DustIQ date range: {dustiq_dates.head(1).to_list()[0]} to {dustiq_dates.tail(1).to_list()[0]}")

    # Merge with DustIQ ground truth
    df_merged = df_disagg.join(df_dustiq_daily, on="date", how="inner")
    print(f"  Matched days: {len(df_merged)}")

    if len(df_merged) < 30:
        print(f"  ✗ Insufficient matched data")
        result["status"] = "insufficient_data"
        return result

    # Calculate metrics
    sr_true = df_merged["sr_dustiq"].to_numpy()
    sr_pred = df_merged["sr_estimated"].to_numpy()

    regression_metrics = calculate_metrics(sr_true, sr_pred)
    directional_metrics = calculate_directional_metrics(sr_true, sr_pred)

    print(f"\n  === REGRESSION METRICS ===")
    print(f"  R²:          {regression_metrics['r2']:.4f}")
    print(f"  MAE:         {regression_metrics['mae']:.4f} ({regression_metrics['mae']*100:.2f}%)")
    print(f"  RMSE:        {regression_metrics['rmse']:.4f}")
    print(f"  Correlation: {regression_metrics['corr']:.4f}")

    print(f"\n  === DIRECTIONAL METRICS ===")
    print(f"  Overall direction accuracy: {directional_metrics['direction_accuracy']*100:.1f}%")
    print(f"  Downward (soiling) accuracy: {directional_metrics['downward_accuracy']*100:.1f}% (n={directional_metrics['n_downward']})")
    print(f"  Upward (cleaning) accuracy: {directional_metrics['upward_accuracy']*100:.1f}% (n={directional_metrics['n_upward']})")
    print(f"  Stable period accuracy: {directional_metrics['stable_accuracy']*100:.1f}% (n={directional_metrics['n_stable']})")

    # Loss breakdown summary
    print(f"\n  === LOSS BREAKDOWN (avg) ===")
    print(f"  Soiling:   {df_disagg['loss_soiling_pct'].mean():.2f}%")
    print(f"  Thermal:   {df_disagg['loss_thermal_pct'].mean():.2f}%")
    print(f"  Shading:   {df_disagg['loss_shading_pct'].mean():.2f}%")
    print(f"  Equipment: {df_disagg['loss_equipment_pct'].mean():.2f}%")

    # Store results
    result["status"] = "success"
    result["n_days"] = len(df_merged)
    result.update({f"reg_{k}": float(v) if not np.isnan(v) else None for k, v in regression_metrics.items()})
    result.update({f"dir_{k}": float(v) if isinstance(v, float) and not np.isnan(v) else v for k, v in directional_metrics.items()})
    result["avg_loss_soiling_pct"] = float(df_disagg['loss_soiling_pct'].mean())
    result["avg_loss_thermal_pct"] = float(df_disagg['loss_thermal_pct'].mean())
    result["avg_loss_shading_pct"] = float(df_disagg['loss_shading_pct'].mean())
    result["avg_loss_equipment_pct"] = float(df_disagg['loss_equipment_pct'].mean())

    return result


def main():
    print("="*60)
    print("LOSS DISAGGREGATION EVALUATION")
    print("Comparing physics-based soiling estimation vs DustIQ")
    print("="*60)

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config)
        all_results.append(result)

    # Summary
    print("\n" + "="*70)
    print("SUMMARY - LOSS DISAGGREGATION vs DUSTIQ")
    print("="*70)

    print(f"\n{'Plant':<12} | {'Days':>5} | {'R²':>7} | {'MAE':>7} | {'Corr':>6} | {'Dir%':>5} | {'Down%':>5} | {'Up%':>5}")
    print("-" * 75)

    for r in all_results:
        if r["status"] == "success":
            print(f"{r['plant_id']:<12} | {r['n_days']:>5} | {r['reg_r2']:>7.3f} | {r['reg_mae']:>7.4f} | {r['reg_corr']:>6.3f} | {r['dir_direction_accuracy']*100:>5.1f} | {r['dir_downward_accuracy']*100:>5.1f} | {r['dir_upward_accuracy']*100:>5.1f}")
        else:
            print(f"{r['plant_id']:<12} | {'N/A':>5} | {'N/A':>7} | {'N/A':>7} | {'N/A':>6} | {'N/A':>5} | {'N/A':>5} | {'N/A':>5}  [{r['status']}]")

    # Save results
    output_path = Path("backenddata/outputs/dustiq_analysis/loss_disaggregation_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
