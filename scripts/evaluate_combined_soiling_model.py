#!/usr/bin/env python3
"""
Combined Soiling Model Evaluation.

Combines:
1. Loss disaggregation features (thermal, shading, equipment, soiling residual)
2. Twin features (current_cv, voltage_cv, temp_deviation, etc.)
3. Weather/temporal features

Uses proper cross-validation to prevent overfitting:
- TimeSeriesSplit for temporal validation
- Shuffle k-fold for comparison
- Heavy regularization

Reports comprehensive metrics including directional accuracy.
"""

import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import polars as pl
from sklearn.model_selection import TimeSeriesSplit, KFold, cross_val_predict
from sklearn.metrics import r2_score, mean_absolute_error

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))


# Plant configurations
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
    """Find column matching any of the patterns."""
    for pattern in patterns:
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
            if pattern_clean in col_clean:
                return col
    return None


def extract_loss_disaggregation_features(
    df: pl.DataFrame,
    twins_path: Path,
    max_inverters: int = 5,
) -> Optional[pl.DataFrame]:
    """
    Extract all loss disaggregation features as daily values.

    Returns DataFrame with columns:
    - date
    - loss_thermal_pct, loss_shading_pct, loss_curtailment_pct,
      loss_clipping_pct, loss_equipment_pct, loss_soiling_pct
    - hours_curtailed, hours_clipping, hours_shading
    - avg_current_cv, avg_temp_deviation
    - energy_expected_kwh, energy_actual_kwh
    """
    from nuravolt.digitaltwin.loss_disaggregator import LossDisaggregator

    plant_id = twins_path.name
    disaggregator = LossDisaggregator(plant_id=plant_id, twins_path=twins_path)

    n_twins = disaggregator.load_twins()
    if n_twins == 0:
        return None

    inv_ids = list(disaggregator.twins.keys())[:max_inverters]

    # Find columns
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
        return None

    all_daily_data = []

    for inv_id in inv_ids:
        try:
            # Find power column
            power_col = None
            for c in df.columns:
                if inv_id in c and ('p_ac' in c.lower() or ('power' in c.lower() and 'normalized' not in c.lower())):
                    power_col = c
                    break

            if not power_col:
                continue

            # Create inverter DataFrame
            select_cols = [
                pl.col("timestamp"),
                pl.col(power_col).alias("power"),
                pl.col(irr_col).alias("irradiance"),
            ]
            if temp_col:
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
                all_daily_data.append(d)

        except Exception as e:
            pass

    if not all_daily_data:
        return None

    df_daily = pl.DataFrame(all_daily_data)

    # Aggregate across inverters
    agg_cols = [
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
        pl.col("avg_current_cv").mean(),
        pl.col("avg_temp_deviation").mean(),
        pl.col("energy_expected_kwh").sum(),
        pl.col("energy_actual_kwh").sum(),
        pl.col("n_samples").sum(),
    ]

    df_agg = df_daily.group_by("date").agg(agg_cols).sort("date")

    return df_agg


def extract_twin_features(
    df: pl.DataFrame,
    twins_path: Path,
    irr_col: str,
    temp_col: Optional[str],
    max_inverters: int = 5,
) -> pl.DataFrame:
    """Extract twin prediction features (T_expected, current_cv, voltage_cv, etc.)."""
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    if not meta_files:
        return df

    inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:max_inverters]

    feature_cols = [
        'T_expected', 'temp_deviation',
        'I_expected', 'current_cv', 'current_imbalance_ratio', 'current_loss_pct',
        'V_expected', 'voltage_cv', 'voltage_deviation', 'voltage_loss_pct',
        'power_loss_pct', 'P_expected',
    ]

    all_predictions = []

    for inv_id in inv_ids:
        try:
            twin = MultiSignalTwinFactory.load(twins_path, inv_id)

            select_cols = ['timestamp']
            if irr_col in df.columns:
                select_cols.append(pl.col(irr_col).alias('irradiance'))
            else:
                continue

            if temp_col and temp_col in df.columns:
                select_cols.append(pl.col(temp_col).alias('ambient_temp'))
            else:
                select_cols.append(pl.lit(25.0).alias('ambient_temp'))

            # Find DC columns
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
                all_predictions.append(result.select(pred_cols))

        except Exception:
            pass

    if not all_predictions:
        return df

    n_rows = len(df)
    for feat in feature_cols:
        feat_arrays = []
        for pred_df in all_predictions:
            if feat in pred_df.columns and len(pred_df) == n_rows:
                feat_arrays.append(pred_df[feat].to_numpy())

        if feat_arrays:
            stacked = np.column_stack(feat_arrays)
            mean_vals = np.nanmean(stacked, axis=1)
            df = df.with_columns(pl.Series(feat, mean_vals))

    return df


def calculate_directional_metrics(y_true: np.ndarray, y_pred: np.ndarray, threshold: float = 0.002):
    """Calculate directional accuracy metrics."""
    mask = ~np.isnan(y_true) & ~np.isnan(y_pred)
    y_true, y_pred = y_true[mask], y_pred[mask]

    if len(y_true) < 10:
        return {"dir_acc": np.nan, "down_acc": np.nan, "up_acc": np.nan}

    true_change = np.diff(y_true)
    pred_change = np.diff(y_pred)

    true_down = true_change < -threshold
    true_up = true_change > threshold
    pred_down = pred_change < -threshold
    pred_up = pred_change > threshold

    n_down = np.sum(true_down)
    n_up = np.sum(true_up)

    down_acc = np.mean(pred_down[true_down]) if n_down > 0 else np.nan
    up_acc = np.mean(pred_up[true_up]) if n_up > 0 else np.nan

    # Overall directional accuracy
    same_sign = (true_change * pred_change) > 0
    dir_acc = np.mean(same_sign)

    return {"dir_acc": dir_acc, "down_acc": down_acc, "up_acc": up_acc, "n_down": n_down, "n_up": n_up}


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate combined model for a single plant."""

    print(f"\n{'='*70}")
    print(f"EVALUATING: {plant_id.upper()}")
    print(f"{'='*70}")

    result = {"plant_id": plant_id, "status": "unknown"}

    # Load data
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

    # Find columns
    sr_col = find_column(df, [config.get("sr_col", ""), "soiling_ratio_sensor"])
    irr_col = find_column(df, ["irradiation_average", "irradiance"])
    temp_col = find_column(df, ["ambient"])

    if not sr_col:
        result["status"] = "no_sr_column"
        return result

    print(f"  SR col: {sr_col}")
    print(f"  Irr col: {irr_col}")

    # === STEP 1: Extract loss disaggregation features ===
    print("\n  Step 1: Extracting loss disaggregation features...")
    df_loss = extract_loss_disaggregation_features(df, twins_path, max_inverters=5)

    if df_loss is None or len(df_loss) < 100:
        print("    ✗ Loss disaggregation failed")
        df_loss = pl.DataFrame({"date": []})
    else:
        print(f"    ✓ {len(df_loss)} days with loss features")

    # === STEP 2: Extract twin features ===
    print("\n  Step 2: Extracting twin features...")
    df_with_twins = extract_twin_features(df, twins_path, irr_col, temp_col, max_inverters=5)

    twin_cols = ['T_expected', 'temp_deviation', 'I_expected', 'current_cv',
                 'current_imbalance_ratio', 'V_expected', 'voltage_cv', 'power_loss_pct']
    twin_cols = [c for c in twin_cols if c in df_with_twins.columns]
    print(f"    ✓ {len(twin_cols)} twin feature columns")

    # === STEP 3: Prepare daily dataset ===
    print("\n  Step 3: Building daily dataset...")

    # Add date and SR to twin data
    df_with_twins = df_with_twins.with_columns([
        pl.col("timestamp").str.slice(0, 10).str.replace_all(r"\.", "-").alias("date"),
        (pl.col(sr_col) / 100).alias("sr_dustiq"),
    ])

    # Filter valid SR and irradiance
    df_valid = df_with_twins.filter(
        pl.col("sr_dustiq").is_not_null() &
        (pl.col("sr_dustiq") >= 0.7) &
        (pl.col("sr_dustiq") <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    # Daily aggregation of twin features
    agg_exprs = [
        pl.col("sr_dustiq").mean().alias("sr_dustiq"),
        pl.len().alias("n_samples"),
    ]

    # Add irradiance and temp stats
    if irr_col:
        agg_exprs.extend([
            pl.col(irr_col).mean().alias("irr_mean"),
            pl.col(irr_col).max().alias("irr_max"),
            pl.col(irr_col).std().alias("irr_std"),
        ])
    if temp_col and temp_col in df_valid.columns:
        agg_exprs.extend([
            pl.col(temp_col).mean().alias("temp_mean"),
            pl.col(temp_col).max().alias("temp_max"),
            pl.col(temp_col).min().alias("temp_min"),
        ])

    # Add twin feature stats
    for col in twin_cols:
        if col in df_valid.columns:
            agg_exprs.extend([
                pl.col(col).mean().alias(f"{col}_mean"),
                pl.col(col).std().alias(f"{col}_std"),
                pl.col(col).max().alias(f"{col}_max"),
                pl.col(col).min().alias(f"{col}_min"),
            ])

    df_daily_twins = df_valid.group_by("date").agg(agg_exprs).sort("date")

    # Merge with loss disaggregation features
    if len(df_loss) > 0 and "date" in df_loss.columns:
        df_daily = df_daily_twins.join(df_loss, on="date", how="left")
    else:
        df_daily = df_daily_twins

    print(f"    ✓ {len(df_daily)} daily samples")

    if len(df_daily) < 100:
        result["status"] = "insufficient_data"
        return result

    # === STEP 4: Prepare features for ML ===
    print("\n  Step 4: Preparing ML features...")

    # Get all numeric feature columns (excluding date and target)
    feature_cols = [c for c in df_daily.columns
                    if c not in ['date', 'sr_dustiq', 'n_samples', 'inverter_id']
                    and df_daily[c].dtype in [pl.Float64, pl.Float32, pl.Int64, pl.Int32]]

    # Filter out columns that are all null
    feature_cols = [c for c in feature_cols if not df_daily[c].is_null().all()]

    print(f"    Features: {len(feature_cols)}")

    # Prepare X and y
    X = df_daily.select(feature_cols).to_pandas().values
    y = df_daily["sr_dustiq"].to_numpy()

    # Handle NaN in features
    for i in range(X.shape[1]):
        col_median = np.nanmedian(X[:, i])
        if np.isnan(col_median):
            col_median = 0
        X[np.isnan(X[:, i]), i] = col_median

    # Remove samples with NaN target
    valid_mask = ~np.isnan(y)
    X = X[valid_mask]
    y = y[valid_mask]

    print(f"    Valid samples: {len(y)}")

    if len(y) < 100:
        result["status"] = "insufficient_valid_samples"
        return result

    # === STEP 5: Train with cross-validation ===
    print("\n  Step 5: Training with cross-validation...")

    try:
        from catboost import CatBoostRegressor

        # Use TimeSeriesSplit to respect temporal order
        tscv = TimeSeriesSplit(n_splits=5)

        # Also test with shuffled k-fold for comparison
        kfold = KFold(n_splits=5, shuffle=True, random_state=42)

        # Model with stronger regularization to prevent overfitting
        model = CatBoostRegressor(
            iterations=300,
            learning_rate=0.03,
            depth=4,  # Shallower trees
            l2_leaf_reg=10.0,  # More regularization
            min_data_in_leaf=20,  # More samples per leaf
            random_seed=42,
            verbose=False,
        )

        # === Cross-validation with TimeSeriesSplit ===
        ts_r2_scores = []
        ts_mae_scores = []
        ts_predictions = np.full(len(y), np.nan)

        for fold, (train_idx, test_idx) in enumerate(tscv.split(X)):
            X_train, X_test = X[train_idx], X[test_idx]
            y_train, y_test = y[train_idx], y[test_idx]

            model.fit(X_train, y_train, verbose=False)
            y_pred = model.predict(X_test)

            ts_r2_scores.append(r2_score(y_test, y_pred))
            ts_mae_scores.append(mean_absolute_error(y_test, y_pred))
            ts_predictions[test_idx] = y_pred

        ts_r2_mean = np.mean(ts_r2_scores)
        ts_mae_mean = np.mean(ts_mae_scores)

        print(f"\n  === TIME-SERIES CV (5-fold) ===")
        print(f"  R² per fold: {[f'{r:.3f}' for r in ts_r2_scores]}")
        print(f"  R² mean: {ts_r2_mean:.4f} ± {np.std(ts_r2_scores):.4f}")
        print(f"  MAE mean: {ts_mae_mean:.4f} ({ts_mae_mean*100:.2f}%)")

        # === Cross-validation with Shuffled K-Fold ===
        kf_r2_scores = []
        kf_mae_scores = []

        for train_idx, test_idx in kfold.split(X):
            X_train, X_test = X[train_idx], X[test_idx]
            y_train, y_test = y[train_idx], y[test_idx]

            model.fit(X_train, y_train, verbose=False)
            y_pred = model.predict(X_test)

            kf_r2_scores.append(r2_score(y_test, y_pred))
            kf_mae_scores.append(mean_absolute_error(y_test, y_pred))

        kf_r2_mean = np.mean(kf_r2_scores)
        kf_mae_mean = np.mean(kf_mae_scores)

        print(f"\n  === SHUFFLED K-FOLD CV (5-fold) ===")
        print(f"  R² per fold: {[f'{r:.3f}' for r in kf_r2_scores]}")
        print(f"  R² mean: {kf_r2_mean:.4f} ± {np.std(kf_r2_scores):.4f}")
        print(f"  MAE mean: {kf_mae_mean:.4f} ({kf_mae_mean*100:.2f}%)")

        # === Directional accuracy from TS predictions ===
        valid_ts_mask = ~np.isnan(ts_predictions)
        if np.sum(valid_ts_mask) > 50:
            dir_metrics = calculate_directional_metrics(y[valid_ts_mask], ts_predictions[valid_ts_mask])
            print(f"\n  === DIRECTIONAL METRICS (from TS CV) ===")
            print(f"  Direction accuracy: {dir_metrics['dir_acc']*100:.1f}%")
            print(f"  Downward (soiling) accuracy: {dir_metrics['down_acc']*100:.1f}% (n={dir_metrics['n_down']})")
            print(f"  Upward (cleaning) accuracy: {dir_metrics['up_acc']*100:.1f}% (n={dir_metrics['n_up']})")
        else:
            dir_metrics = {"dir_acc": np.nan, "down_acc": np.nan, "up_acc": np.nan}

        # === Feature importance (train on full data) ===
        model.fit(X, y, verbose=False)
        importance = model.get_feature_importance()
        feat_imp = sorted(zip(feature_cols, importance), key=lambda x: -x[1])

        print(f"\n  === TOP FEATURES ===")
        for fname, imp in feat_imp[:15]:
            print(f"    {fname}: {imp:.1f}")

        # Store results
        result["status"] = "success"
        result["n_days"] = len(y)
        result["n_features"] = len(feature_cols)
        result["ts_r2_mean"] = float(ts_r2_mean)
        result["ts_r2_std"] = float(np.std(ts_r2_scores))
        result["ts_mae_mean"] = float(ts_mae_mean)
        result["kf_r2_mean"] = float(kf_r2_mean)
        result["kf_r2_std"] = float(np.std(kf_r2_scores))
        result["kf_mae_mean"] = float(kf_mae_mean)
        result["dir_acc"] = float(dir_metrics["dir_acc"]) if not np.isnan(dir_metrics["dir_acc"]) else None
        result["down_acc"] = float(dir_metrics["down_acc"]) if not np.isnan(dir_metrics["down_acc"]) else None
        result["up_acc"] = float(dir_metrics["up_acc"]) if not np.isnan(dir_metrics["up_acc"]) else None
        result["top_features"] = [(f, float(i)) for f, i in feat_imp[:10]]

    except Exception as e:
        import traceback
        print(f"  ✗ Error: {e}")
        traceback.print_exc()
        result["status"] = "error"
        result["error"] = str(e)

    return result


def main():
    print("="*70)
    print("COMBINED SOILING MODEL EVALUATION")
    print("Loss Disaggregation + Twin Features with Proper CV")
    print("="*70)

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config)
        all_results.append(result)

    # Summary
    print("\n" + "="*80)
    print("SUMMARY")
    print("="*80)

    print(f"\n{'Plant':<12} | {'Days':>5} | {'TS-CV R²':>10} | {'KF-CV R²':>10} | {'MAE':>8} | {'Dir%':>6} | {'Down%':>6} | {'Up%':>6}")
    print("-" * 85)

    for r in all_results:
        if r["status"] == "success":
            ts_r2 = f"{r['ts_r2_mean']:.3f}±{r['ts_r2_std']:.2f}"
            kf_r2 = f"{r['kf_r2_mean']:.3f}±{r['kf_r2_std']:.2f}"
            dir_acc = f"{r['dir_acc']*100:.1f}" if r.get('dir_acc') else "N/A"
            down_acc = f"{r['down_acc']*100:.1f}" if r.get('down_acc') else "N/A"
            up_acc = f"{r['up_acc']*100:.1f}" if r.get('up_acc') else "N/A"
            print(f"{r['plant_id']:<12} | {r['n_days']:>5} | {ts_r2:>10} | {kf_r2:>10} | {r['ts_mae_mean']:>8.4f} | {dir_acc:>6} | {down_acc:>6} | {up_acc:>6}")
        else:
            print(f"{r['plant_id']:<12} | {'N/A':>5} | {'N/A':>10} | {'N/A':>10} | {'N/A':>8} | {'N/A':>6} | {'N/A':>6} | {'N/A':>6}  [{r['status']}]")

    print("\nTS-CV = TimeSeriesSplit (respects temporal order)")
    print("KF-CV = Shuffled K-Fold (treats days as independent)")
    print("Large gap between KF and TS suggests temporal patterns/overfitting")

    # Save results
    output_path = Path("backenddata/outputs/dustiq_analysis/combined_model_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
