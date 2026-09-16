#!/usr/bin/env python3
"""
Evaluate THREE soiling prediction targets - NO DUSTIQ FEATURES AS INPUT.

Targets:
1. LEVEL: Predict absolute SR value (sr_dustiq)
2. CHANGE: Predict daily change (delta_sr = today - yesterday)
3. ROLLING: Predict 7-day rolling average SR

All use ONLY features available without DustIQ sensors:
  - Weather features (irradiance, temperature)
  - Loss disaggregation features (physics-based)
  - Digital twin features (model-based)
  - Temporal features (calendar-based)
"""

import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import polars as pl
from sklearn.model_selection import TimeSeriesSplit, KFold
from sklearn.metrics import r2_score, mean_absolute_error

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
    """Extract all features and create daily dataset with multiple targets."""
    from nuravolt.digitaltwin.loss_disaggregator import LossDisaggregator
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    # === Part 1: Loss disaggregation features ===
    plant_id = twins_path.name
    disaggregator = LossDisaggregator(plant_id=plant_id, twins_path=twins_path)

    n_twins = disaggregator.load_twins()
    if n_twins == 0:
        return None

    inv_ids = list(disaggregator.twins.keys())[:max_inverters]

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

    # Aggregate loss features by date
    df_loss_agg = df_loss.group_by("date").agg([
        pl.col("loss_thermal_pct").mean(),
        pl.col("loss_shading_pct").mean(),
        pl.col("loss_curtailment_pct").mean(),
        pl.col("loss_clipping_pct").mean(),
        pl.col("loss_equipment_pct").mean(),
        pl.col("loss_soiling_pct").mean(),
        pl.col("loss_total_pct").mean(),
        pl.col("hours_curtailed").mean(),
        pl.col("hours_clipping").mean(),
        pl.col("hours_shading").mean(),
        pl.col("avg_current_cv").mean().alias("disagg_current_cv"),
        pl.col("avg_temp_deviation").mean().alias("disagg_temp_deviation"),
        pl.col("energy_expected_kwh").sum(),
        pl.col("energy_actual_kwh").sum(),
    ]).sort("date")

    # === Part 2: Twin features ===
    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    twin_inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:max_inverters]

    feature_cols = [
        'T_expected', 'temp_deviation',
        'I_expected', 'current_cv', 'current_imbalance_ratio', 'current_loss_pct',
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

    # Average twin features across inverters
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

    # === Part 3: Daily aggregation ===
    twin_agg_cols = [c for c in df_valid.columns if c.startswith("twin_")]

    agg_exprs = [
        pl.col("sr_dustiq").mean().alias("sr_dustiq"),
        pl.len().alias("n_samples"),
    ]

    # Irradiance stats
    agg_exprs.extend([
        pl.col(irr_col).mean().alias("irr_mean"),
        pl.col(irr_col).max().alias("irr_max"),
        pl.col(irr_col).std().alias("irr_std"),
        pl.col(irr_col).sum().alias("irr_sum"),
    ])

    # Temperature stats
    if temp_col and temp_col in df_valid.columns:
        agg_exprs.extend([
            pl.col(temp_col).mean().alias("temp_mean"),
            pl.col(temp_col).max().alias("temp_max"),
            pl.col(temp_col).min().alias("temp_min"),
            (pl.col(temp_col).max() - pl.col(temp_col).min()).alias("temp_range"),
        ])

    # Twin feature stats
    for col in twin_agg_cols:
        if col in df_valid.columns:
            agg_exprs.extend([
                pl.col(col).mean().alias(f"{col}_mean"),
                pl.col(col).std().alias(f"{col}_std"),
            ])

    df_daily = df_valid.group_by("date").agg(agg_exprs).sort("date")

    # Merge with loss features
    df_daily = df_daily.join(df_loss_agg, on="date", how="left")

    # === Part 4: Create ALL targets ===
    df_daily = df_daily.sort("date")

    # TARGET 1: Level (sr_dustiq) - already exists

    # TARGET 2: Change (delta_sr)
    df_daily = df_daily.with_columns([
        pl.col("sr_dustiq").shift(1).alias("_sr_prev"),
    ])
    df_daily = df_daily.with_columns([
        (pl.col("sr_dustiq") - pl.col("_sr_prev")).alias("delta_sr"),
    ])

    # TARGET 3: Rolling 7-day average
    df_daily = df_daily.with_columns([
        pl.col("sr_dustiq").rolling_mean(window_size=7).alias("sr_7d_avg"),
    ])

    # === Part 5: Add INPUT features (NO DUSTIQ!) ===
    # Temporal features
    df_daily = df_daily.with_columns([
        pl.col("date").str.to_datetime("%Y-%m-%d").dt.ordinal_day().alias("day_of_year"),
        pl.col("date").str.to_datetime("%Y-%m-%d").dt.month().alias("month"),
    ])

    # Lagged weather features
    df_daily = df_daily.with_columns([
        pl.col("irr_sum").shift(1).alias("irr_sum_prev1"),
        pl.col("irr_sum").shift(2).alias("irr_sum_prev2"),
        pl.col("irr_sum").rolling_sum(window_size=7).alias("irr_sum_7d"),
        pl.col("irr_mean").shift(1).alias("irr_mean_prev1"),
    ])

    if "temp_mean" in df_daily.columns:
        df_daily = df_daily.with_columns([
            pl.col("temp_mean").shift(1).alias("temp_mean_prev1"),
            pl.col("temp_range").shift(1).alias("temp_range_prev1"),
            pl.col("temp_mean").rolling_mean(window_size=7).alias("temp_mean_7d"),
        ])

    # Lagged loss features (physics-based, OK to use)
    if "loss_soiling_pct" in df_daily.columns:
        df_daily = df_daily.with_columns([
            pl.col("loss_soiling_pct").shift(1).alias("loss_soiling_prev1"),
            pl.col("loss_soiling_pct").rolling_mean(window_size=3).alias("loss_soiling_3d"),
            pl.col("loss_soiling_pct").rolling_mean(window_size=7).alias("loss_soiling_7d"),
            pl.col("loss_total_pct").shift(1).alias("loss_total_prev1"),
            pl.col("loss_total_pct").rolling_mean(window_size=7).alias("loss_total_7d"),
        ])

    # Lagged twin features (model-based, OK to use)
    twin_mean_cols = [c for c in df_daily.columns if c.startswith("twin_") and c.endswith("_mean")]
    for col in twin_mean_cols[:5]:  # Top 5 twin features
        df_daily = df_daily.with_columns([
            pl.col(col).shift(1).alias(f"{col}_prev1"),
            pl.col(col).rolling_mean(window_size=7).alias(f"{col}_7d"),
        ])

    # Remove rows without all targets
    df_daily = df_daily.filter(
        pl.col("delta_sr").is_not_null() &
        pl.col("sr_7d_avg").is_not_null()
    )

    return df_daily


def calculate_direction_accuracy(y_true: np.ndarray, y_pred: np.ndarray, threshold: float = 0.001):
    """Calculate directional accuracy."""
    mask = ~np.isnan(y_true) & ~np.isnan(y_pred)
    y_true, y_pred = y_true[mask], y_pred[mask]

    if len(y_true) < 10:
        return {"correct_sign": np.nan, "down_detected": np.nan, "up_detected": np.nan}

    # For change predictions
    same_sign = ((y_true > threshold) & (y_pred > threshold)) | \
                ((y_true < -threshold) & (y_pred < -threshold)) | \
                ((np.abs(y_true) <= threshold) & (np.abs(y_pred) <= threshold))
    correct_sign = np.mean(same_sign)

    true_down = y_true < -threshold
    down_detected = np.mean(y_pred[true_down] < 0) if np.sum(true_down) > 5 else np.nan

    true_up = y_true > threshold
    up_detected = np.mean(y_pred[true_up] > 0) if np.sum(true_up) > 5 else np.nan

    return {
        "correct_sign": correct_sign,
        "down_detected": down_detected,
        "up_detected": up_detected,
        "n_down": int(np.sum(true_down)),
        "n_up": int(np.sum(true_up)),
    }


def evaluate_target(X: np.ndarray, y: np.ndarray, target_name: str, feature_cols: List[str]) -> dict:
    """Evaluate a single target with both CV methods."""
    from catboost import CatBoostRegressor

    result = {"target": target_name}

    # Handle NaN in features
    for i in range(X.shape[1]):
        col_median = np.nanmedian(X[:, i])
        if np.isnan(col_median):
            col_median = 0
        X[np.isnan(X[:, i]), i] = col_median

    # Handle NaN in target
    valid_mask = ~np.isnan(y)
    X_valid = X[valid_mask]
    y_valid = y[valid_mask]

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

    # Time-series CV
    tscv = TimeSeriesSplit(n_splits=5)
    ts_r2_scores = []
    ts_mae_scores = []
    ts_predictions = np.full(len(y_valid), np.nan)

    for fold, (train_idx, test_idx) in enumerate(tscv.split(X_valid)):
        X_train, X_test = X_valid[train_idx], X_valid[test_idx]
        y_train, y_test = y_valid[train_idx], y_valid[test_idx]

        model.fit(X_train, y_train, verbose=False)
        y_pred = model.predict(X_test)

        ts_r2_scores.append(r2_score(y_test, y_pred))
        ts_mae_scores.append(mean_absolute_error(y_test, y_pred))
        ts_predictions[test_idx] = y_pred

    # K-Fold CV
    kfold = KFold(n_splits=5, shuffle=True, random_state=42)
    kf_r2_scores = []

    for train_idx, test_idx in kfold.split(X_valid):
        X_train, X_test = X_valid[train_idx], X_valid[test_idx]
        y_train, y_test = y_valid[train_idx], y_valid[test_idx]

        model.fit(X_train, y_train, verbose=False)
        y_pred = model.predict(X_test)
        kf_r2_scores.append(r2_score(y_test, y_pred))

    # Feature importance
    model.fit(X_valid, y_valid, verbose=False)
    importance = model.get_feature_importance()
    feat_imp = sorted(zip(feature_cols, importance), key=lambda x: -x[1])

    # Direction accuracy (for change target)
    dir_metrics = {}
    if target_name == "change":
        valid_ts_mask = ~np.isnan(ts_predictions)
        if np.sum(valid_ts_mask) > 50:
            dir_metrics = calculate_direction_accuracy(y_valid[valid_ts_mask], ts_predictions[valid_ts_mask])

    result["status"] = "success"
    result["n_samples"] = len(y_valid)
    result["target_mean"] = float(np.mean(y_valid))
    result["target_std"] = float(np.std(y_valid))
    result["ts_r2_mean"] = float(np.mean(ts_r2_scores))
    result["ts_r2_std"] = float(np.std(ts_r2_scores))
    result["ts_mae_mean"] = float(np.mean(ts_mae_scores))
    result["kf_r2_mean"] = float(np.mean(kf_r2_scores))
    result["kf_r2_std"] = float(np.std(kf_r2_scores))
    result["top_features"] = [(f, float(i)) for f, i in feat_imp[:10]]
    result["direction"] = dir_metrics

    return result


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate all three targets for a single plant."""

    print(f"\n{'='*70}")
    print(f"EVALUATING: {plant_id.upper()}")
    print(f"{'='*70}")

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

    print(f"  SR col: {sr_col}")

    # Extract features
    print("  Extracting features...")
    df_daily = extract_features(df, twins_path, irr_col, temp_col, sr_col, max_inverters=5)

    if df_daily is None or len(df_daily) < 100:
        result["status"] = "feature_extraction_failed"
        return result

    print(f"  Daily samples: {len(df_daily)}")

    # Prepare features - EXCLUDE ALL DUSTIQ-DERIVED COLUMNS
    exclude_cols = [
        'date', 'n_samples',
        # Targets (DustIQ-derived)
        'sr_dustiq', 'delta_sr', 'sr_7d_avg', '_sr_prev',
    ]

    feature_cols = [c for c in df_daily.columns
                    if c not in exclude_cols
                    and df_daily[c].dtype in [pl.Float64, pl.Float32, pl.Int64, pl.Int32, pl.Int16, pl.Int8]
                    and not df_daily[c].is_null().all()]

    print(f"  Features: {len(feature_cols)}")

    X = df_daily.select(feature_cols).to_pandas().values

    # Three targets
    targets = {
        "level": df_daily["sr_dustiq"].to_numpy(),
        "change": df_daily["delta_sr"].to_numpy(),
        "rolling_7d": df_daily["sr_7d_avg"].to_numpy(),
    }

    result["status"] = "success"
    result["n_days"] = len(df_daily)
    result["n_features"] = len(feature_cols)
    result["targets"] = {}

    for target_name, y in targets.items():
        print(f"\n  --- Target: {target_name.upper()} ---")
        print(f"  Stats: mean={np.nanmean(y):.4f}, std={np.nanstd(y):.4f}")

        target_result = evaluate_target(X.copy(), y.copy(), target_name, feature_cols)
        result["targets"][target_name] = target_result

        if target_result.get("status") == "success":
            print(f"  Time-Series CV R²: {target_result['ts_r2_mean']:.3f} ± {target_result['ts_r2_std']:.3f}")
            print(f"  K-Fold CV R²:      {target_result['kf_r2_mean']:.3f} ± {target_result['kf_r2_std']:.3f}")
            print(f"  MAE:               {target_result['ts_mae_mean']:.5f}")

            if target_name == "change" and target_result.get("direction"):
                d = target_result["direction"]
                if d.get("correct_sign"):
                    print(f"  Direction correct: {d['correct_sign']*100:.1f}%")
                if d.get("down_detected"):
                    print(f"  Soiling detected:  {d['down_detected']*100:.1f}% (n={d.get('n_down', 0)})")
                if d.get("up_detected"):
                    print(f"  Cleaning detected: {d['up_detected']*100:.1f}% (n={d.get('n_up', 0)})")

            print(f"  Top features: {[f[0] for f in target_result['top_features'][:5]]}")

    return result


def main():
    print("="*70)
    print("SOILING PREDICTION - THREE TARGETS COMPARISON")
    print("NO DUSTIQ FEATURES AS INPUT")
    print("="*70)

    all_results = []

    for plant_id, config in PLANTS.items():
        try:
            result = evaluate_plant(plant_id, config)
            all_results.append(result)
        except Exception as e:
            print(f"  Error: {e}")
            all_results.append({"plant_id": plant_id, "status": "error", "error": str(e)})

    # Summary table
    print("\n" + "="*100)
    print("SUMMARY - Time-Series CV R² (honest out-of-sample performance)")
    print("="*100)

    print(f"\n{'Plant':<12} | {'Days':>5} | {'LEVEL R²':>12} | {'CHANGE R²':>12} | {'ROLL-7D R²':>12} | {'Dir%':>6} | {'Soil%':>6}")
    print("-" * 100)

    for r in all_results:
        if r["status"] == "success":
            level_r2 = r["targets"]["level"].get("ts_r2_mean", np.nan)
            change_r2 = r["targets"]["change"].get("ts_r2_mean", np.nan)
            roll_r2 = r["targets"]["rolling_7d"].get("ts_r2_mean", np.nan)

            dir_pct = r["targets"]["change"].get("direction", {}).get("correct_sign", np.nan)
            soil_pct = r["targets"]["change"].get("direction", {}).get("down_detected", np.nan)

            level_str = f"{level_r2:.3f}" if not np.isnan(level_r2) else "N/A"
            change_str = f"{change_r2:.3f}" if not np.isnan(change_r2) else "N/A"
            roll_str = f"{roll_r2:.3f}" if not np.isnan(roll_r2) else "N/A"
            dir_str = f"{dir_pct*100:.1f}" if dir_pct and not np.isnan(dir_pct) else "N/A"
            soil_str = f"{soil_pct*100:.1f}" if soil_pct and not np.isnan(soil_pct) else "N/A"

            print(f"{r['plant_id']:<12} | {r['n_days']:>5} | {level_str:>12} | {change_str:>12} | {roll_str:>12} | {dir_str:>6} | {soil_str:>6}")
        else:
            print(f"{r['plant_id']:<12} | {'N/A':>5} | {'N/A':>12} | {'N/A':>12} | {'N/A':>12} | {'N/A':>6} | {'N/A':>6}  [{r['status']}]")

    print("\nLEVEL = Predict absolute SR value")
    print("CHANGE = Predict daily change (delta_sr)")
    print("ROLL-7D = Predict 7-day rolling average SR")
    print("Dir% = Correctly predicted direction of change")
    print("Soil% = When SR decreased, predicted decrease")

    # Save
    output_path = Path("backenddata/outputs/dustiq_analysis/three_targets_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
