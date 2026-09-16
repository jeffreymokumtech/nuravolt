#!/usr/bin/env python3
"""
Evaluate soiling prediction with MAE metric and SR-level buckets.

Buckets by actual SR level:
- >98%: Clean panels
- 95-98%: Light soiling
- 90-95%: Moderate soiling
- 80-90%: Heavy soiling

NO DUSTIQ FEATURES AS INPUT - only physics/weather/twin features.
"""

import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import polars as pl
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))


PLANTS = {
    "epsilon": {
        "name": "Epsilon",
        "scada_path": "backenddata/scada/epsilon",
        "twins_path": "public/data/digitaltwin/epsilon",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
    },
    "ribera": {
        "name": "Ribera (ES)",
        "scada_path": "backenddata/scada/ribera",
        "twins_path": "public/data/digitaltwin/ribera",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "eta": {
        "name": "Eta (ES)",
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "sr_col": "Eta (ES): Dust_IQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "delta": {
        "name": "Delta (ES)",
        "scada_path": "backenddata/scada/delta",
        "twins_path": "public/data/digitaltwin/delta",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "zeta": {
        "name": "Zeta (ES)",
        "scada_path": "backenddata/scada/zeta",
        "twins_path": "public/data/digitaltwin/zeta",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "gamma": {
        "name": "Gamma (ES)",
        "scada_path": "backenddata/scada/gamma",
        "twins_path": "public/data/digitaltwin/gamma",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
    },
}

# SR buckets (as ratios, not percentages)
BUCKETS = [
    (">98%", 0.98, 1.02),
    ("95-98%", 0.95, 0.98),
    ("90-95%", 0.90, 0.95),
    ("80-90%", 0.80, 0.90),
]


def find_column(df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
    """Find column matching patterns."""
    for pattern in patterns:
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
            if pattern_clean in col_clean:
                return col
    return None


def extract_features(
    df: pl.DataFrame,
    twins_path: Path,
    irr_col: str,
    temp_col: Optional[str],
    sr_col: str,
    max_inverters: int = 5,
) -> Optional[pl.DataFrame]:
    """Extract features - same as before but streamlined."""
    from nuravolt.digitaltwin.loss_disaggregator import LossDisaggregator
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    plant_id = twins_path.name
    disaggregator = LossDisaggregator(plant_id=plant_id, twins_path=twins_path)

    n_twins = disaggregator.load_twins()
    if n_twins == 0:
        return None

    inv_ids = list(disaggregator.twins.keys())[:max_inverters]

    # Loss disaggregation
    loss_data = []
    for inv_id in inv_ids:
        try:
            power_col = None
            for c in df.columns:
                if inv_id in c and ('p_ac' in c.lower() or ('power' in c.lower() and 'normalized' not in c.lower())):
                    power_col = c
                    break

            if not power_col:
                continue

            select_cols = [
                pl.col("timestamp"),
                pl.col(power_col).alias("power"),
                pl.col(irr_col).alias("irradiance"),
            ]
            if temp_col and temp_col in df.columns:
                select_cols.append(pl.col(temp_col).alias("ambient_temp"))
            else:
                select_cols.append(pl.lit(25.0).alias("ambient_temp"))

            df_inv = df.select(select_cols).filter(
                pl.col("irradiance") > 50,
                pl.col("power") > 0,
            )

            if len(df_inv) < 100:
                continue

            daily_results = disaggregator.analyze_daily(
                df_inv, inv_id,
                power_col="power",
                irradiance_col="irradiance",
                ambient_temp_col="ambient_temp",
            )

            for summary in daily_results:
                d = summary.to_dict()
                d["date"] = d["date"].replace(".", "-")
                loss_data.append(d)

        except Exception:
            pass

    if not loss_data:
        return None

    df_loss = pl.DataFrame(loss_data)
    df_loss_agg = df_loss.group_by("date").agg([
        pl.col("loss_thermal_pct").mean(),
        pl.col("loss_shading_pct").mean(),
        pl.col("loss_equipment_pct").mean(),
        pl.col("loss_soiling_pct").mean(),
        pl.col("loss_total_pct").mean(),
        pl.col("energy_expected_kwh").sum(),
        pl.col("energy_actual_kwh").sum(),
    ]).sort("date")

    # Twin features
    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    twin_inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:max_inverters]

    feature_cols = [
        'T_expected', 'temp_deviation',
        'I_expected', 'current_cv', 'current_loss_pct',
        'V_expected', 'voltage_cv', 'voltage_deviation', 'voltage_loss_pct',
        'power_loss_pct', 'P_expected',
    ]

    all_twin_preds = []
    for inv_id in twin_inv_ids:
        try:
            twin = MultiSignalTwinFactory.load(twins_path, inv_id)

            select_cols = ['timestamp']
            if irr_col in df.columns:
                select_cols.append(pl.col(irr_col).alias('irradiance'))
            if temp_col and temp_col in df.columns:
                select_cols.append(pl.col(temp_col).alias('ambient_temp'))
            else:
                select_cols.append(pl.lit(25.0).alias('ambient_temp'))

            dc_current_cols = []
            dc_voltage_cols = []
            inv_power_col = None
            for c in df.columns:
                if inv_id in c:
                    c_lower = c.lower()
                    if 'i_dc' in c_lower or 'input_current' in c_lower:
                        dc_current_cols.append(c)
                    elif 'u_dc' in c_lower or 'u_mppt' in c_lower or 'input_voltage' in c_lower:
                        dc_voltage_cols.append(c)
                    elif 'p_ac' in c_lower:
                        inv_power_col = c

            for i, c in enumerate(sorted(dc_current_cols)[:12]):
                select_cols.append(pl.col(c).alias(f'dc_current_{i+1}'))
            for i, c in enumerate(sorted(dc_voltage_cols)[:12]):
                select_cols.append(pl.col(c).alias(f'dc_voltage_{i+1}'))
            if inv_power_col:
                select_cols.append(pl.col(inv_power_col).alias('power'))

            inv_df = df.select(select_cols)

            current_col_names = [f'dc_current_{i+1}' for i in range(min(len(dc_current_cols), 12))]
            voltage_col_names = [f'dc_voltage_{i+1}' for i in range(min(len(dc_voltage_cols), 12))]

            result = twin.predict(
                inv_df,
                irradiance_col='irradiance',
                ambient_temp_col='ambient_temp',
                current_cols=current_col_names if current_col_names else None,
                voltage_cols=voltage_col_names if voltage_col_names else None,
                power_col='power' if inv_power_col else None,
                auto_detect_columns=False,
            )

            pred_cols = ['timestamp'] + [c for c in feature_cols if c in result.columns]
            if len(pred_cols) > 1:
                all_twin_preds.append(result.select(pred_cols))

        except Exception:
            pass

    # Average twin features
    df_with_twins = df.clone()
    n_rows = len(df_with_twins)

    for feat in feature_cols:
        feat_arrays = []
        for pred_df in all_twin_preds:
            if feat in pred_df.columns and len(pred_df) == n_rows:
                feat_arrays.append(pred_df[feat].to_numpy())
        if feat_arrays:
            stacked = np.column_stack(feat_arrays)
            mean_vals = np.nanmean(stacked, axis=1)
            df_with_twins = df_with_twins.with_columns(pl.Series(f"twin_{feat}", mean_vals))

    # Add date and SR
    df_with_twins = df_with_twins.with_columns([
        pl.col("timestamp").str.slice(0, 10).str.replace_all(r"\.", "-").alias("date"),
        (pl.col(sr_col) / 100).alias("sr_dustiq"),
    ])

    # Filter valid
    df_valid = df_with_twins.filter(
        pl.col("sr_dustiq").is_not_null() &
        (pl.col("sr_dustiq") >= 0.7) &
        (pl.col("sr_dustiq") <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    # Daily aggregation
    twin_agg_cols = [c for c in df_valid.columns if c.startswith("twin_")]

    agg_exprs = [
        pl.col("sr_dustiq").mean().alias("sr_dustiq"),
        pl.len().alias("n_samples"),
        pl.col(irr_col).mean().alias("irr_mean"),
        pl.col(irr_col).sum().alias("irr_sum"),
    ]

    if temp_col and temp_col in df_valid.columns:
        agg_exprs.extend([
            pl.col(temp_col).mean().alias("temp_mean"),
            (pl.col(temp_col).max() - pl.col(temp_col).min()).alias("temp_range"),
        ])

    for col in twin_agg_cols:
        if col in df_valid.columns:
            agg_exprs.extend([
                pl.col(col).mean().alias(f"{col}_mean"),
                pl.col(col).std().alias(f"{col}_std"),
            ])

    df_daily = df_valid.group_by("date").agg(agg_exprs).sort("date")
    df_daily = df_daily.join(df_loss_agg, on="date", how="left")

    # Create targets
    df_daily = df_daily.with_columns([
        pl.col("sr_dustiq").shift(1).alias("_sr_prev"),
    ])
    df_daily = df_daily.with_columns([
        (pl.col("sr_dustiq") - pl.col("_sr_prev")).alias("delta_sr"),
        pl.col("sr_dustiq").rolling_mean(window_size=7).alias("sr_7d_avg"),
    ])

    # Temporal features (allowed)
    df_daily = df_daily.with_columns([
        pl.col("date").str.to_datetime("%Y-%m-%d").dt.ordinal_day().alias("day_of_year"),
        pl.col("date").str.to_datetime("%Y-%m-%d").dt.month().alias("month"),
    ])

    # Lagged features (weather/physics only - no DustIQ)
    df_daily = df_daily.with_columns([
        pl.col("irr_sum").shift(1).alias("irr_sum_prev1"),
        pl.col("irr_sum").rolling_sum(window_size=7).alias("irr_sum_7d"),
    ])

    if "temp_mean" in df_daily.columns:
        df_daily = df_daily.with_columns([
            pl.col("temp_mean").shift(1).alias("temp_mean_prev1"),
            pl.col("temp_mean").rolling_mean(window_size=7).alias("temp_mean_7d"),
        ])

    if "loss_soiling_pct" in df_daily.columns:
        df_daily = df_daily.with_columns([
            pl.col("loss_soiling_pct").shift(1).alias("loss_soiling_prev1"),
            pl.col("loss_soiling_pct").rolling_mean(window_size=7).alias("loss_soiling_7d"),
            pl.col("loss_total_pct").rolling_mean(window_size=7).alias("loss_total_7d"),
        ])

    # Lagged twin features
    twin_mean_cols = [c for c in df_daily.columns if c.startswith("twin_") and c.endswith("_mean")]
    for col in twin_mean_cols[:3]:
        df_daily = df_daily.with_columns([
            pl.col(col).rolling_mean(window_size=7).alias(f"{col}_7d"),
        ])

    df_daily = df_daily.filter(
        pl.col("delta_sr").is_not_null() &
        pl.col("sr_7d_avg").is_not_null()
    )

    return df_daily


def get_bucket_mask(sr_values: np.ndarray, low: float, high: float) -> np.ndarray:
    """Get boolean mask for SR values in bucket range."""
    return (sr_values >= low) & (sr_values < high)


def evaluate_with_buckets(
    X: np.ndarray,
    y: np.ndarray,
    sr_levels: np.ndarray,
    target_name: str,
    feature_cols: List[str]
) -> dict:
    """Evaluate target with MAE overall and per bucket."""
    from catboost import CatBoostRegressor

    result = {"target": target_name}

    # Handle NaN in features
    for i in range(X.shape[1]):
        col_median = np.nanmedian(X[:, i])
        if np.isnan(col_median):
            col_median = 0
        X[np.isnan(X[:, i]), i] = col_median

    # Handle NaN in target
    valid_mask = ~np.isnan(y) & ~np.isnan(sr_levels)
    X_valid = X[valid_mask]
    y_valid = y[valid_mask]
    sr_valid = sr_levels[valid_mask]

    if len(y_valid) < 100:
        result["status"] = "insufficient_samples"
        return result

    # Model
    model = CatBoostRegressor(
        iterations=200,
        learning_rate=0.03,
        depth=4,
        l2_leaf_reg=10.0,
        min_data_in_leaf=30,
        random_seed=42,
        verbose=False,
    )

    # Time-series CV with predictions stored
    tscv = TimeSeriesSplit(n_splits=5)
    all_y_true = []
    all_y_pred = []
    all_sr = []

    for train_idx, test_idx in tscv.split(X_valid):
        X_train, X_test = X_valid[train_idx], X_valid[test_idx]
        y_train, y_test = y_valid[train_idx], y_valid[test_idx]
        sr_test = sr_valid[test_idx]

        model.fit(X_train, y_train, verbose=False)
        y_pred = model.predict(X_test)

        all_y_true.extend(y_test)
        all_y_pred.extend(y_pred)
        all_sr.extend(sr_test)

    all_y_true = np.array(all_y_true)
    all_y_pred = np.array(all_y_pred)
    all_sr = np.array(all_sr)

    # Overall MAE
    overall_mae = mean_absolute_error(all_y_true, all_y_pred)

    # Bucket MAEs
    bucket_results = {}
    for bucket_name, low, high in BUCKETS:
        mask = get_bucket_mask(all_sr, low, high)
        n_samples = np.sum(mask)
        if n_samples >= 10:
            bucket_mae = mean_absolute_error(all_y_true[mask], all_y_pred[mask])
            bucket_results[bucket_name] = {
                "mae": float(bucket_mae),
                "n": int(n_samples),
                "pct": float(n_samples / len(all_sr) * 100),
            }
        else:
            bucket_results[bucket_name] = {
                "mae": None,
                "n": int(n_samples),
                "pct": float(n_samples / len(all_sr) * 100),
            }

    # Direction accuracy (for change target)
    dir_metrics = {}
    if target_name == "change":
        threshold = 0.001
        same_sign = ((all_y_true > threshold) & (all_y_pred > threshold)) | \
                    ((all_y_true < -threshold) & (all_y_pred < -threshold)) | \
                    ((np.abs(all_y_true) <= threshold) & (np.abs(all_y_pred) <= threshold))
        dir_metrics["correct_sign"] = float(np.mean(same_sign))

        true_down = all_y_true < -threshold
        if np.sum(true_down) > 5:
            dir_metrics["down_detected"] = float(np.mean(all_y_pred[true_down] < 0))
            dir_metrics["n_down"] = int(np.sum(true_down))

        true_up = all_y_true > threshold
        if np.sum(true_up) > 5:
            dir_metrics["up_detected"] = float(np.mean(all_y_pred[true_up] > 0))
            dir_metrics["n_up"] = int(np.sum(true_up))

    # Feature importance
    model.fit(X_valid, y_valid, verbose=False)
    importance = model.get_feature_importance()
    feat_imp = sorted(zip(feature_cols, importance), key=lambda x: -x[1])

    result["status"] = "success"
    result["n_samples"] = len(all_y_true)
    result["overall_mae"] = float(overall_mae)
    result["buckets"] = bucket_results
    result["direction"] = dir_metrics
    result["top_features"] = [(f, float(i)) for f, i in feat_imp[:10]]

    return result


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate all targets for a plant with bucket analysis."""

    print(f"\n{'='*80}")
    print(f"EVALUATING: {plant_id.upper()}")
    print(f"{'='*80}")

    result = {"plant_id": plant_id, "status": "unknown"}

    scada_path = Path(config["scada_path"])
    twins_path = Path(config["twins_path"])

    if not scada_path.exists() or not twins_path.exists():
        result["status"] = "missing_paths"
        return result

    parquet_files = list(scada_path.glob("*.parquet"))
    if not parquet_files:
        result["status"] = "no_data"
        return result

    df = pl.read_parquet(parquet_files[0])
    print(f"  Loaded {len(df):,} rows")

    sr_col = find_column(df, [config.get("sr_col", ""), "soiling_ratio_sensor"])
    irr_col = find_column(df, ["irradiation_average", "irradiance"])
    temp_col = find_column(df, ["ambient"])

    if not sr_col:
        result["status"] = "no_sr_column"
        return result

    # Extract features
    print("  Extracting features...")
    df_daily = extract_features(df, twins_path, irr_col, temp_col, sr_col, max_inverters=5)

    if df_daily is None or len(df_daily) < 100:
        result["status"] = "feature_extraction_failed"
        return result

    print(f"  Daily samples: {len(df_daily)}")

    # Show SR distribution
    sr_values = df_daily["sr_dustiq"].to_numpy()
    print(f"  SR distribution:")
    for bucket_name, low, high in BUCKETS:
        n = np.sum((sr_values >= low) & (sr_values < high))
        pct = n / len(sr_values) * 100
        print(f"    {bucket_name}: {n:>5} days ({pct:>5.1f}%)")

    # Prepare features
    exclude_cols = ['date', 'n_samples', 'sr_dustiq', 'delta_sr', 'sr_7d_avg', '_sr_prev']
    feature_cols = [c for c in df_daily.columns
                    if c not in exclude_cols
                    and df_daily[c].dtype in [pl.Float64, pl.Float32, pl.Int64, pl.Int32, pl.Int16, pl.Int8]
                    and not df_daily[c].is_null().all()]

    print(f"  Features: {len(feature_cols)}")

    X = df_daily.select(feature_cols).to_pandas().values
    sr_levels = df_daily["sr_dustiq"].to_numpy()

    # Three targets
    targets = {
        "level": df_daily["sr_dustiq"].to_numpy(),
        "change": df_daily["delta_sr"].to_numpy(),
        "rolling_7d": df_daily["sr_7d_avg"].to_numpy(),
    }

    result["status"] = "success"
    result["n_days"] = len(df_daily)
    result["targets"] = {}

    for target_name, y in targets.items():
        print(f"\n  --- {target_name.upper()} ---")

        target_result = evaluate_with_buckets(X.copy(), y.copy(), sr_levels.copy(), target_name, feature_cols)
        result["targets"][target_name] = target_result

        if target_result.get("status") == "success":
            # Convert MAE to percentage points for display
            mae_pct = target_result['overall_mae'] * 100
            print(f"  Overall MAE: {mae_pct:.2f}%")

            print(f"  Per-bucket MAE:")
            for bucket_name, _, _ in BUCKETS:
                b = target_result['buckets'].get(bucket_name, {})
                if b.get('mae') is not None:
                    bucket_mae_pct = b['mae'] * 100
                    print(f"    {bucket_name}: {bucket_mae_pct:.2f}% (n={b['n']})")
                else:
                    print(f"    {bucket_name}: N/A (n={b.get('n', 0)})")

            if target_name == "change" and target_result.get("direction"):
                d = target_result["direction"]
                if d.get("correct_sign"):
                    print(f"  Direction: {d['correct_sign']*100:.1f}% correct")
                if d.get("down_detected"):
                    print(f"  Soiling:   {d['down_detected']*100:.1f}% detected")

    return result


def main():
    print("="*80)
    print("SOILING PREDICTION - MAE WITH SR-LEVEL BUCKETS")
    print("NO DUSTIQ FEATURES AS INPUT")
    print("="*80)

    all_results = []

    for plant_id, config in PLANTS.items():
        try:
            result = evaluate_plant(plant_id, config)
            all_results.append(result)
        except Exception as e:
            import traceback
            print(f"  Error: {e}")
            traceback.print_exc()
            all_results.append({"plant_id": plant_id, "status": "error", "error": str(e)})

    # Summary tables
    print("\n" + "="*120)
    print("SUMMARY - MAE (in percentage points) by Target and SR Bucket")
    print("="*120)

    # Table for LEVEL target
    print("\n### LEVEL (predict absolute SR) ###")
    print(f"{'Plant':<12} | {'Days':>5} | {'Overall':>8} | {'>98%':>8} | {'95-98%':>8} | {'90-95%':>8} | {'80-90%':>8}")
    print("-" * 85)

    for r in all_results:
        if r["status"] == "success" and "level" in r.get("targets", {}):
            t = r["targets"]["level"]
            if t.get("status") == "success":
                overall = f"{t['overall_mae']*100:.2f}%"
                buckets = []
                for bname, _, _ in BUCKETS:
                    b = t['buckets'].get(bname, {})
                    if b.get('mae') is not None:
                        buckets.append(f"{b['mae']*100:.2f}%")
                    else:
                        buckets.append("N/A")
                print(f"{r['plant_id']:<12} | {r['n_days']:>5} | {overall:>8} | {buckets[0]:>8} | {buckets[1]:>8} | {buckets[2]:>8} | {buckets[3]:>8}")

    # Table for CHANGE target
    print("\n### CHANGE (predict daily delta) ###")
    print(f"{'Plant':<12} | {'Days':>5} | {'Overall':>8} | {'>98%':>8} | {'95-98%':>8} | {'90-95%':>8} | {'80-90%':>8} | {'Dir%':>6} | {'Soil%':>6}")
    print("-" * 110)

    for r in all_results:
        if r["status"] == "success" and "change" in r.get("targets", {}):
            t = r["targets"]["change"]
            if t.get("status") == "success":
                overall = f"{t['overall_mae']*100:.2f}%"
                buckets = []
                for bname, _, _ in BUCKETS:
                    b = t['buckets'].get(bname, {})
                    if b.get('mae') is not None:
                        buckets.append(f"{b['mae']*100:.2f}%")
                    else:
                        buckets.append("N/A")

                d = t.get("direction", {})
                dir_pct = f"{d['correct_sign']*100:.1f}" if d.get('correct_sign') else "N/A"
                soil_pct = f"{d['down_detected']*100:.1f}" if d.get('down_detected') else "N/A"

                print(f"{r['plant_id']:<12} | {r['n_days']:>5} | {overall:>8} | {buckets[0]:>8} | {buckets[1]:>8} | {buckets[2]:>8} | {buckets[3]:>8} | {dir_pct:>6} | {soil_pct:>6}")

    # Table for ROLLING target
    print("\n### ROLLING 7-DAY (predict 7-day average SR) ###")
    print(f"{'Plant':<12} | {'Days':>5} | {'Overall':>8} | {'>98%':>8} | {'95-98%':>8} | {'90-95%':>8} | {'80-90%':>8}")
    print("-" * 85)

    for r in all_results:
        if r["status"] == "success" and "rolling_7d" in r.get("targets", {}):
            t = r["targets"]["rolling_7d"]
            if t.get("status") == "success":
                overall = f"{t['overall_mae']*100:.2f}%"
                buckets = []
                for bname, _, _ in BUCKETS:
                    b = t['buckets'].get(bname, {})
                    if b.get('mae') is not None:
                        buckets.append(f"{b['mae']*100:.2f}%")
                    else:
                        buckets.append("N/A")
                print(f"{r['plant_id']:<12} | {r['n_days']:>5} | {overall:>8} | {buckets[0]:>8} | {buckets[1]:>8} | {buckets[2]:>8} | {buckets[3]:>8}")

    print("\nNote: MAE shown as percentage points (e.g., 1.00% means ±0.01 SR error)")
    print("Buckets based on actual SR level at prediction time")

    # Save
    output_path = Path("backenddata/outputs/dustiq_analysis/mae_bucket_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
