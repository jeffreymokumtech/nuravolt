#!/usr/bin/env python3
"""
Simple evaluation of soiling prediction using twin features from each plant.

Uses the pre-trained twins to extract features directly from SCADA data,
then trains CatBoost to predict soiling ratio.
"""

import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import polars as pl

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))


# Plant configurations with correct column mappings
PLANTS = {
    "epsilon": {
        "name": "Epsilon",
        "scada_path": "backenddata/scada/epsilon",
        "twins_path": "public/data/digitaltwin/epsilon",
        "irr_col": "Epsilon: Plant / Irradiation_average (W/m²)",
        "temp_col": "Epsilon: Temperatur Sensor 1 / Ambient (°C)",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
        "sl_col": "Epsilon: Meteo.DustIQ / Soiling Loss Sensor 1 (%)",
    },
    "ribera": {
        "name": "Ribera (ES)",
        "scada_path": "backenddata/scada/ribera",
        "twins_path": "public/data/digitaltwin/ribera",
        "irr_col": "Ribera (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Ribera (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Ribera (ES): DustIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "eta": {
        "name": "Eta (ES)",
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "irr_col": "Eta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Eta (ES): Temperatur MC / Ambient (°C)",
        "sr_col": "Eta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Eta (ES): DustIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "delta": {
        "name": "Delta (ES)",
        "scada_path": "backenddata/scada/delta",
        "twins_path": "public/data/digitaltwin/delta",
        "irr_col": "Delta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Delta (ES): zbloxx 407 / Ambient",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Delta (ES): DustIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "zeta": {
        "name": "Zeta (ES)",
        "scada_path": "backenddata/scada/zeta",
        "twins_path": "public/data/digitaltwin/zeta",
        "irr_col": "Zeta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Zeta (ES): Meteo.Z.bloxx407 / temperature_internal (°C)",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
        "sl_col": "Zeta (ES): DUSTIQ.01 / Soiling Loss Sensor 1 (%)",
    },
    "gamma": {
        "name": "Gamma (ES)",
        "scada_path": "backenddata/scada/gamma",
        "twins_path": "public/data/digitaltwin/gamma",
        "irr_col": "Gamma 1& 2 (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Gamma 1& 2 (ES): zbloxx 407 / temperature_internal (°C)",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
        "sl_col": "Gamma 1& 2 (ES): Dust_IQ / Soiling Loss Sensor 1 (%)",
    },
}


def find_column(df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
    """Find column matching any of the patterns, handling encoding issues."""
    for pattern in patterns:
        # Normalize pattern - remove degree symbol variations
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '').replace('�c', '')
            if pattern_clean in col_clean:
                return col
    return None


def find_dc_current_columns(df: pl.DataFrame, inv_id: str) -> List[str]:
    """Find DC current columns for an inverter, handling different naming conventions."""
    cols = []
    for c in df.columns:
        if inv_id in c:
            # Match: I_DC, I_DC_1, I_DC_SUM, Input_current_01, IDC_1, etc.
            c_lower = c.lower()
            if 'i_dc' in c_lower or 'input_current' in c_lower or 'idc' in c_lower:
                cols.append(c)
    return sorted(cols)


def find_dc_voltage_columns(df: pl.DataFrame, inv_id: str) -> List[str]:
    """Find DC voltage columns for an inverter, handling different naming conventions."""
    cols = []
    for c in df.columns:
        if inv_id in c:
            # Match: U_DC, U_MPPT, Input_voltage, UDC, etc.
            c_lower = c.lower()
            if 'u_dc' in c_lower or 'u_mppt' in c_lower or 'input_voltage' in c_lower or 'udc' in c_lower:
                cols.append(c)
    return sorted(cols)


def extract_twin_features(
    df: pl.DataFrame,
    twins_path: Path,
    irr_col: str,
    temp_col: str,
    max_inverters: int = 10,
) -> pl.DataFrame:
    """Extract twin features from SCADA data - per-row predictions."""
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    # Load available twins
    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    if not meta_files:
        print(f"    No twins found in {twins_path}")
        return df

    inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:max_inverters]
    print(f"    Loading {len(inv_ids)} twins...")

    # Collect per-row predictions from each inverter
    all_predictions = []
    # Extended feature list including all twin outputs
    feature_cols = [
        # Temperature twin
        'T_expected', 'temp_deviation',
        # Current twin
        'I_expected', 'current_cv', 'current_imbalance_ratio', 'current_loss_pct', 'current_mean', 'current_total',
        # Voltage twin
        'V_expected', 'voltage_cv', 'voltage_deviation', 'voltage_loss_pct', 'voltage_mean',
        # Power
        'power_loss_pct', 'P_expected',
    ]

    for inv_id in inv_ids:
        try:
            twin = MultiSignalTwinFactory.load(twins_path, inv_id)

            # Prepare data with required column names
            select_cols = ['timestamp']

            if irr_col in df.columns:
                select_cols.append(pl.col(irr_col).alias('irradiance'))
            else:
                continue

            if temp_col in df.columns:
                select_cols.append(pl.col(temp_col).alias('ambient_temp'))
            else:
                for c in df.columns:
                    if 'ambient' in c.lower():
                        select_cols.append(pl.col(c).alias('ambient_temp'))
                        break
                else:
                    select_cols.append(pl.lit(25.0).alias('ambient_temp'))

            # Find inverter-specific columns using robust matching
            inv_temp_col = None
            inv_power_col = None
            for c in df.columns:
                if inv_id in c:
                    c_lower = c.lower()
                    if 'temp' in c_lower or 'temperature' in c_lower:
                        if inv_temp_col is None:
                            inv_temp_col = c
                    elif 'power' in c_lower or 'p_ac' in c_lower:
                        if inv_power_col is None:
                            inv_power_col = c

            # Use new helper functions for DC current/voltage columns
            dc_current_cols = find_dc_current_columns(df, inv_id)
            dc_voltage_cols = find_dc_voltage_columns(df, inv_id)

            # Debug output for first inverter
            if inv_id == inv_ids[0]:
                print(f"      Sample inv {inv_id}: {len(dc_current_cols)} curr cols, {len(dc_voltage_cols)} volt cols")

            if inv_temp_col:
                select_cols.append(pl.col(inv_temp_col).alias('inverter_temp'))
            if inv_power_col:
                select_cols.append(pl.col(inv_power_col).alias('power'))
            for i, c in enumerate(dc_current_cols[:12]):
                select_cols.append(pl.col(c).alias(f'dc_current_{i+1}'))
            for i, c in enumerate(dc_voltage_cols[:12]):
                select_cols.append(pl.col(c).alias(f'dc_voltage_{i+1}'))

            inv_df = df.select(select_cols)

            # Prepare aliased column names for current/voltage
            current_col_names = [f'dc_current_{i+1}' for i in range(min(len(dc_current_cols), 12))]
            voltage_col_names = [f'dc_voltage_{i+1}' for i in range(min(len(dc_voltage_cols), 12))]

            # Run twin prediction - explicitly pass current/voltage columns
            result = twin.predict(
                inv_df,
                irradiance_col='irradiance',
                ambient_temp_col='ambient_temp',
                current_cols=current_col_names if current_col_names else None,
                voltage_cols=voltage_col_names if voltage_col_names else None,
                power_col='power' if inv_power_col else None,
                auto_detect_columns=False,  # Don't auto-detect since we're explicit
            )

            # Extract just the feature columns we need
            pred_cols = ['timestamp'] + [c for c in feature_cols if c in result.columns]
            if len(pred_cols) > 1:
                inv_preds = result.select(pred_cols)
                all_predictions.append(inv_preds)

        except Exception as e:
            print(f"      {inv_id}: Error - {str(e)[:50]}")

    if not all_predictions:
        print("    No twin features extracted")
        return df

    # Average predictions across inverters (per timestamp)
    print(f"    Averaging predictions from {len(all_predictions)} inverters...")

    # All prediction dataframes should have same length as input df
    n_rows = len(df)

    # For each feature, compute mean across all inverters and add to df
    added_feats = []
    for feat in feature_cols:
        feat_arrays = []
        for pred_df in all_predictions:
            if feat in pred_df.columns and len(pred_df) == n_rows:
                feat_arrays.append(pred_df[feat].to_numpy())

        if feat_arrays:
            # Stack and compute mean per row, handling NaNs
            stacked = np.column_stack(feat_arrays)
            mean_vals = np.nanmean(stacked, axis=1)
            df = df.with_columns(
                pl.Series(feat, mean_vals)
            )
            added_feats.append(feat)

    print(f"    Added {len(added_feats)} twin feature columns: {added_feats}")

    return df


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate soiling prediction for a single plant."""

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

    # Find columns
    irr_col = find_column(df, [config.get("irr_col", ""), "irradiation_average", "irradiance"])
    temp_col = find_column(df, [config.get("temp_col", ""), "ambient", "temperature"])
    sr_col = find_column(df, [config.get("sr_col", ""), "soiling_ratio_sensor"])
    sl_col = find_column(df, [config.get("sl_col", ""), "soiling loss sensor"])

    print(f"  Irradiance: {irr_col}")
    print(f"  Ambient temp: {temp_col}")
    print(f"  Soiling ratio: {sr_col}")
    print(f"  Soiling loss: {sl_col}")

    if not irr_col:
        print(f"  ✗ Missing irradiance column")
        result["status"] = "missing_irradiance"
        return result

    # Check twins path
    twins_path = Path(config["twins_path"])
    if not twins_path.exists():
        print(f"  ✗ Twins path not found")
        result["status"] = "no_twins"
        return result

    # Extract twin features
    print("\n  Extracting twin features...")
    df_with_features = extract_twin_features(df, twins_path, irr_col, temp_col, max_inverters=10)

    # Get soiling ground truth
    if sr_col and sr_col in df.columns:
        # Soiling ratio is in percentage (90-100%), convert to fraction (0.9-1.0)
        df_with_features = df_with_features.with_columns(
            (pl.col(sr_col) / 100).alias('sr_dustiq')
        )
    elif sl_col and sl_col in df.columns:
        # Convert loss to ratio: SR = 1 - (loss / 100)
        df_with_features = df_with_features.with_columns(
            (1 - pl.col(sl_col) / 100).clip(0.5, 1.02).alias('sr_dustiq')
        )
    else:
        print(f"  ✗ No soiling ground truth column")
        result["status"] = "no_ground_truth"
        return result

    # Filter to daytime with valid data (SR as fraction 0.7-1.02)
    df_valid = df_with_features.filter(
        pl.col('sr_dustiq').is_not_null() &
        (pl.col('sr_dustiq') >= 0.7) &
        (pl.col('sr_dustiq') <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    print(f"  Valid samples: {len(df_valid):,}")

    if len(df_valid) < 1000:
        print(f"  ✗ Insufficient valid data")
        result["status"] = "insufficient_data"
        return result

    # Aggregate to daily
    df_valid = df_valid.with_columns(
        pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
    )

    # Get twin feature columns (the actual twin outputs like T_expected, temp_deviation, etc.)
    twin_feat_cols = ['T_expected', 'temp_deviation', 'I_expected', 'current_cv',
                      'current_imbalance_ratio', 'V_expected', 'voltage_cv',
                      'power_loss_pct', 'P_expected']
    twin_feat_cols = [c for c in twin_feat_cols if c in df_valid.columns]

    # Add irradiance and temp as features too
    other_cols = []
    if irr_col in df_valid.columns:
        other_cols.append(irr_col)
    if temp_col and temp_col in df_valid.columns:
        other_cols.append(temp_col)

    all_feature_cols = twin_feat_cols + other_cols
    print(f"  Feature columns: {len(all_feature_cols)} ({len(twin_feat_cols)} twin + {len(other_cols)} other)")

    # Daily aggregation - compute mean, std, min, max for each feature
    agg_exprs = [
        pl.col('sr_dustiq').mean().alias('sr_dustiq'),
        pl.len().alias('n_samples'),
    ]
    for col in all_feature_cols:
        if col in df_valid.columns:
            agg_exprs.extend([
                pl.col(col).mean().alias(f'{col}_mean'),
                pl.col(col).std().alias(f'{col}_std'),
                pl.col(col).min().alias(f'{col}_min'),
                pl.col(col).max().alias(f'{col}_max'),
            ])

    df_daily = df_valid.group_by('date').agg(agg_exprs).sort('date')

    print(f"  Daily samples: {len(df_daily)}")

    # Prepare for ML - get all aggregated feature columns
    feature_cols_daily = [c for c in df_daily.columns
                         if c.endswith('_mean') or c.endswith('_std') or c.endswith('_min') or c.endswith('_max')]

    # Filter to columns with actual data (not all null)
    feature_cols_daily = [c for c in feature_cols_daily
                         if c in df_daily.columns and not df_daily[c].is_null().all()]

    print(f"  ML features: {len(feature_cols_daily)}")

    if len(feature_cols_daily) < 3:
        print(f"  ✗ Not enough features")
        result["status"] = "insufficient_features"
        return result

    # Train/test split (80/20)
    n_train = int(len(df_daily) * 0.8)
    df_train = df_daily.head(n_train)
    df_test = df_daily.tail(len(df_daily) - n_train)

    print(f"  Train: {len(df_train)}, Test: {len(df_test)}")

    # Prepare data
    X_train = df_train.select(feature_cols_daily).to_pandas().values
    y_train = df_train['sr_dustiq'].to_numpy()
    X_test = df_test.select(feature_cols_daily).to_pandas().values
    y_test = df_test['sr_dustiq'].to_numpy()

    # Handle NaN
    for i in range(X_train.shape[1]):
        col_median = np.nanmedian(X_train[:, i])
        if np.isnan(col_median):
            col_median = 0
        X_train[np.isnan(X_train[:, i]), i] = col_median
        X_test[np.isnan(X_test[:, i]), i] = col_median

    # Train CatBoost
    try:
        from catboost import CatBoostRegressor

        model = CatBoostRegressor(
            iterations=500,
            learning_rate=0.05,
            depth=6,
            l2_leaf_reg=3.0,
            random_seed=42,
            verbose=False,
            early_stopping_rounds=50,
        )

        model.fit(X_train, y_train, eval_set=(X_test, y_test), verbose=False)

        # Predictions
        y_pred_train = model.predict(X_train)
        y_pred_test = model.predict(X_test)

        # Metrics
        def calc_metrics(y_true, y_pred):
            mae = np.mean(np.abs(y_true - y_pred))
            ss_res = np.sum((y_true - y_pred) ** 2)
            ss_tot = np.sum((y_true - np.mean(y_true)) ** 2)
            r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
            corr = np.corrcoef(y_true, y_pred)[0, 1] if len(y_true) > 1 else 0
            return {"mae": mae, "r2": r2, "corr": corr}

        # Apply 7-day rolling average to predictions
        def rolling_avg(arr, window=7):
            """Apply rolling average with min_periods=1."""
            result = np.zeros_like(arr)
            for i in range(len(arr)):
                start = max(0, i - window + 1)
                result[i] = np.mean(arr[start:i+1])
            return result

        y_pred_test_7d = rolling_avg(y_pred_test, 7)
        y_test_7d = rolling_avg(y_test, 7)

        train_metrics = calc_metrics(y_train, y_pred_train)
        test_metrics = calc_metrics(y_test, y_pred_test)
        test_metrics_7d = calc_metrics(y_test_7d, y_pred_test_7d)

        print(f"\n  === RESULTS ===")
        print(f"  Train:      R²={train_metrics['r2']:.4f}, MAE={train_metrics['mae']:.4f}, Corr={train_metrics['corr']:.4f}")
        print(f"  Test Daily: R²={test_metrics['r2']:.4f}, MAE={test_metrics['mae']:.4f}, Corr={test_metrics['corr']:.4f}")
        print(f"  Test 7-day: R²={test_metrics_7d['r2']:.4f}, MAE={test_metrics_7d['mae']:.4f}, Corr={test_metrics_7d['corr']:.4f}")

        # Feature importance
        importance = model.get_feature_importance()
        feat_imp = sorted(zip(feature_cols_daily, importance), key=lambda x: -x[1])

        print(f"\n  Top Features:")
        for fname, imp in feat_imp[:10]:
            print(f"    {fname}: {imp:.1f}")

        result["status"] = "success"
        result["n_train"] = len(df_train)
        result["n_test"] = len(df_test)
        result["n_features"] = len(feature_cols_daily)
        result["train_r2"] = float(train_metrics["r2"])
        result["train_mae"] = float(train_metrics["mae"])
        result["test_r2"] = float(test_metrics["r2"])
        result["test_mae"] = float(test_metrics["mae"])
        result["test_corr"] = float(test_metrics["corr"])
        # 7-day rolling average metrics
        result["test_r2_7d"] = float(test_metrics_7d["r2"])
        result["test_mae_7d"] = float(test_metrics_7d["mae"])
        result["test_corr_7d"] = float(test_metrics_7d["corr"])
        result["top_features"] = [(f, float(i)) for f, i in feat_imp[:10]]

    except ImportError:
        print("  ✗ CatBoost not available")
        result["status"] = "no_catboost"
    except Exception as e:
        import traceback
        print(f"  ✗ Error: {e}")
        traceback.print_exc()
        result["status"] = "error"
        result["error"] = str(e)

    return result


def main():
    print("="*60)
    print("TWIN FEATURES EVALUATION - SIMPLE VERSION")
    print("Using twin features from each plant's own digital twins")
    print("="*60)

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config)
        all_results.append(result)

    # Summary
    print("\n" + "="*90)
    print("SUMMARY - Daily vs 7-Day Rolling Average")
    print("="*90)
    print(f"{'Plant':<12} | {'Train R²':>9} | {'Daily R²':>9} | {'7d R²':>9} | {'Daily MAE':>10} | {'7d MAE':>9} | {'7d Corr':>8}")
    print("-" * 90)

    for r in all_results:
        if r["status"] == "success":
            print(f"{r['plant_id']:<12} | {r['train_r2']:>9.4f} | {r['test_r2']:>9.4f} | {r.get('test_r2_7d', 0):>9.4f} | {r['test_mae']:>10.4f} | {r.get('test_mae_7d', 0):>9.4f} | {r.get('test_corr_7d', 0):>8.4f}")
        else:
            print(f"{r['plant_id']:<12} | {'N/A':>9} | {'N/A':>9} | {'N/A':>9} | {'N/A':>10} | {'N/A':>9} | {'N/A':>8}")

    # Save results
    output_path = Path("backenddata/outputs/dustiq_analysis/twin_features_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
