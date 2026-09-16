#!/usr/bin/env python3
"""
Final soiling prediction evaluation with appropriate metrics.

Key improvements:
1. Use MAE as primary metric (stable for all plants)
2. Only report R² for plants with sufficient test variance
3. Add soiling detection accuracy (precision/recall)
4. Use rain features for cleaning event prediction
5. NO DustIQ-derived features (transfer learning safe)
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


# Plant configurations
PLANTS = {
    "epsilon": {
        "name": "Epsilon",
        "scada_path": "backenddata/scada/epsilon",
        "twins_path": "public/data/digitaltwin/epsilon",
        "rain_path": "public/data/soiling/epsilon/rain_history.json",
        "irr_col": "Epsilon: Plant / Irradiation_average (W/m²)",
        "temp_col": "Epsilon: Temperatur Sensor 1 / Ambient (°C)",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
    },
    "ribera": {
        "name": "Ribera (ES)",
        "scada_path": "backenddata/scada/ribera",
        "twins_path": "public/data/digitaltwin/ribera",
        "rain_path": "public/data/soiling/ribera/rain_history.json",
        "irr_col": "Ribera (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Ribera (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "eta": {
        "name": "Eta (ES)",
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "rain_path": "public/data/soiling/eta/rain_history.json",
        "irr_col": "Eta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Eta (ES): Temperatur MC / Ambient (°C)",
        "sr_col": "Eta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "delta": {
        "name": "Delta (ES)",
        "scada_path": "backenddata/scada/delta",
        "twins_path": "public/data/digitaltwin/delta",
        "rain_path": "public/data/soiling/delta/rain_history.json",
        "irr_col": "Delta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Delta (ES): zbloxx 407 / Ambient",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "zeta": {
        "name": "Zeta (ES)",
        "scada_path": "backenddata/scada/zeta",
        "twins_path": "public/data/digitaltwin/zeta",
        "rain_path": "public/data/soiling/zeta/rain_history.json",
        "irr_col": "Zeta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Zeta (ES): Meteo.Z.bloxx407 / temperature_internal (°C)",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "gamma": {
        "name": "Gamma (ES)",
        "scada_path": "backenddata/scada/gamma",
        "twins_path": "public/data/digitaltwin/gamma",
        "rain_path": "public/data/soiling/gamma/rain_history.json",
        "irr_col": "Gamma 1& 2 (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Gamma 1& 2 (ES): zbloxx 407 / temperature_internal (°C)",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
    },
    "alpha": {
        "name": "Alpha (ES)",
        "scada_path": "backenddata/scada/alpha",
        "twins_path": "public/data/digitaltwin/alpha",
        "rain_path": "public/data/soiling/alpha/rain_history.json",
        "irr_col": "Alpha (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Alpha (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Alpha (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
}

# Minimum std in test set for R² to be valid
MIN_STD_FOR_R2 = 0.005  # 0.5%


def load_rain_data(rain_path: Path) -> Optional[pl.DataFrame]:
    """Load rain history data."""
    if not rain_path.exists():
        return None
    with open(rain_path) as f:
        data = json.load(f)
    daily_data = data.get("daily_data", [])
    if not daily_data:
        return None
    return pl.DataFrame(daily_data)


def create_rain_features(df_rain: pl.DataFrame, dates: list) -> Dict[str, np.ndarray]:
    """Create rain-based features."""
    n_days = len(dates)

    days_since_rain = np.full(n_days, np.nan)
    rainfall_7d = np.full(n_days, np.nan)
    rainfall_14d = np.full(n_days, np.nan)
    rainfall_30d = np.full(n_days, np.nan)
    rain_days_7d = np.full(n_days, np.nan)

    rain_by_date = {}
    for row in df_rain.iter_rows(named=True):
        rain_by_date[row['date']] = {
            'precip': row.get('precipitation_mm', 0) or 0,
            'is_cleaning': row.get('is_cleaning_event', False),
        }

    for i, date in enumerate(dates):
        date_str = str(date)

        days_count = 0
        for back in range(min(i+1, 180)):
            check_date = dates[i - back] if i - back >= 0 else None
            if check_date is None:
                break
            check_str = str(check_date)
            if check_str in rain_by_date and rain_by_date[check_str]['is_cleaning']:
                days_since_rain[i] = days_count
                break
            days_count += 1
        else:
            days_since_rain[i] = days_count

        precip_7d = precip_14d = precip_30d = 0
        rain_count_7d = 0

        for back in range(min(i+1, 30)):
            check_idx = i - back
            if check_idx < 0:
                break
            check_str = str(dates[check_idx])
            if check_str in rain_by_date:
                precip = rain_by_date[check_str]['precip']
                if back < 7:
                    precip_7d += precip
                    if precip > 1:
                        rain_count_7d += 1
                if back < 14:
                    precip_14d += precip
                precip_30d += precip

        rainfall_7d[i] = precip_7d
        rainfall_14d[i] = precip_14d
        rainfall_30d[i] = precip_30d
        rain_days_7d[i] = rain_count_7d

    return {
        'days_since_rain': days_since_rain,
        'rainfall_7d': rainfall_7d,
        'rainfall_14d': rainfall_14d,
        'rainfall_30d': rainfall_30d,
        'rain_days_7d': rain_days_7d,
    }


def find_column(df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
    for pattern in patterns:
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '')
            if pattern_clean in col_clean:
                return col
    return None


def find_dc_columns(df: pl.DataFrame, inv_id: str, col_type: str) -> List[str]:
    cols = []
    for c in df.columns:
        if inv_id in c:
            c_lower = c.lower()
            if col_type == 'current':
                if 'i_dc' in c_lower or 'input_current' in c_lower or 'idc' in c_lower:
                    cols.append(c)
            elif col_type == 'voltage':
                if 'u_dc' in c_lower or 'u_mppt' in c_lower or 'input_voltage' in c_lower:
                    cols.append(c)
    return sorted(cols)


def extract_twin_features(df: pl.DataFrame, twins_path: Path, irr_col: str, temp_col: str, max_inv: int = 10) -> pl.DataFrame:
    """Extract twin features from SCADA."""
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    if not meta_files:
        return df

    inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:max_inv]

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

            if temp_col in df.columns:
                select_cols.append(pl.col(temp_col).alias('ambient_temp'))
            else:
                for c in df.columns:
                    if 'ambient' in c.lower():
                        select_cols.append(pl.col(c).alias('ambient_temp'))
                        break
                else:
                    select_cols.append(pl.lit(25.0).alias('ambient_temp'))

            inv_temp_col = inv_power_col = None
            for c in df.columns:
                if inv_id in c:
                    c_lower = c.lower()
                    if 'temp' in c_lower and inv_temp_col is None:
                        inv_temp_col = c
                    elif ('power' in c_lower or 'p_ac' in c_lower) and inv_power_col is None:
                        inv_power_col = c

            dc_current_cols = find_dc_columns(df, inv_id, 'current')
            dc_voltage_cols = find_dc_columns(df, inv_id, 'voltage')

            if inv_temp_col:
                select_cols.append(pl.col(inv_temp_col).alias('inverter_temp'))
            if inv_power_col:
                select_cols.append(pl.col(inv_power_col).alias('power'))
            for i, c in enumerate(dc_current_cols[:12]):
                select_cols.append(pl.col(c).alias(f'dc_current_{i+1}'))
            for i, c in enumerate(dc_voltage_cols[:12]):
                select_cols.append(pl.col(c).alias(f'dc_voltage_{i+1}'))

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


def rolling_avg(arr: np.ndarray, window: int = 7) -> np.ndarray:
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate with appropriate metrics."""

    print(f"\n{'='*60}")
    print(f"{plant_id.upper()}")
    print(f"{'='*60}")

    result = {"plant_id": plant_id, "status": "unknown"}

    # Load data
    scada_path = Path(config["scada_path"])
    parquet_files = list(scada_path.glob("*.parquet"))
    if not parquet_files:
        result["status"] = "no_data"
        return result

    df = pl.read_parquet(parquet_files[0])

    irr_col = find_column(df, [config.get("irr_col", ""), "irradiation_average"])
    temp_col = find_column(df, [config.get("temp_col", ""), "ambient"])
    sr_col = find_column(df, [config.get("sr_col", ""), "soiling_ratio_sensor"])

    if not irr_col or not sr_col:
        result["status"] = "missing_columns"
        return result

    # Load rain data
    rain_path = Path(config.get("rain_path", ""))
    df_rain = load_rain_data(rain_path)

    # Extract twin features
    twins_path = Path(config["twins_path"])
    df = extract_twin_features(df, twins_path, irr_col, temp_col)

    # Convert SR
    df = df.with_columns((pl.col(sr_col) / 100).alias('sr_dustiq'))

    # Filter valid
    df_valid = df.filter(
        pl.col('sr_dustiq').is_not_null() &
        (pl.col('sr_dustiq') >= 0.7) &
        (pl.col('sr_dustiq') <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    if len(df_valid) < 1000:
        result["status"] = "insufficient_data"
        return result

    # Daily aggregation
    df_valid = df_valid.with_columns(
        pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
    )

    twin_feat_cols = ['T_expected', 'temp_deviation', 'I_expected', 'current_cv',
                      'current_imbalance_ratio', 'V_expected', 'voltage_cv', 'power_loss_pct']
    twin_feat_cols = [c for c in twin_feat_cols if c in df_valid.columns]

    other_cols = []
    if irr_col in df_valid.columns:
        other_cols.append(irr_col)
    if temp_col and temp_col in df_valid.columns:
        other_cols.append(temp_col)

    all_feature_cols = twin_feat_cols + other_cols

    agg_exprs = [
        pl.col('sr_dustiq').mean().alias('sr_dustiq'),
        pl.len().alias('n_samples'),
    ]
    for col in all_feature_cols:
        if col in df_valid.columns:
            agg_exprs.extend([
                pl.col(col).mean().alias(f'{col}_mean'),
                pl.col(col).std().alias(f'{col}_std'),
            ])

    df_daily = df_valid.group_by('date').agg(agg_exprs).sort('date')

    # Add rain features
    if df_rain is not None:
        dates = df_daily['date'].to_list()
        rain_features = create_rain_features(df_rain, dates)
        for feat_name, feat_vals in rain_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    # Add temporal features
    df_daily = df_daily.with_columns([
        pl.col('date').str.slice(5, 2).cast(pl.Int32).alias('month'),
    ])

    # Get feature columns
    feature_cols_daily = [c for c in df_daily.columns
                         if c.endswith('_mean') or c.endswith('_std') or
                         c in ['days_since_rain', 'rainfall_7d', 'rainfall_14d',
                               'rainfall_30d', 'rain_days_7d', 'month']]
    feature_cols_daily = [c for c in feature_cols_daily
                         if c in df_daily.columns and not df_daily[c].is_null().all()]

    # Prepare data
    X = df_daily.select(feature_cols_daily).to_pandas().values
    y = df_daily['sr_dustiq'].to_numpy()

    # Handle NaN
    for i in range(X.shape[1]):
        col_median = np.nanmedian(X[:, i])
        if np.isnan(col_median):
            col_median = 0
        X[np.isnan(X[:, i]), i] = col_median

    # Train/test split
    n_train = int(len(X) * 0.8)
    X_train, X_test = X[:n_train], X[n_train:]
    y_train, y_test = y[:n_train], y[n_train:]

    # Calculate test set statistics
    test_std = np.std(y_test)
    test_mean = np.mean(y_test)
    soiled_test = np.sum(y_test < 0.99)
    soiled_pct = soiled_test / len(y_test) * 100

    print(f"  Train: {len(X_train)} days, Test: {len(X_test)} days")
    print(f"  Test std: {test_std*100:.3f}%, Soiled: {soiled_pct:.1f}%")

    r2_valid = test_std >= MIN_STD_FOR_R2
    if not r2_valid:
        print(f"  ⚠ Test variance too low for R² ({test_std*100:.3f}% < {MIN_STD_FOR_R2*100}%)")

    try:
        from catboost import CatBoostRegressor

        # Strong regularization
        model = CatBoostRegressor(
            iterations=200,
            learning_rate=0.02,
            depth=3,  # Very shallow
            l2_leaf_reg=15.0,  # Strong regularization
            min_data_in_leaf=30,
            random_seed=42,
            verbose=False,
        )

        model.fit(X_train, y_train, verbose=False)

        y_pred_test = model.predict(X_test)

        # 7-day rolling average
        y_pred_7d = rolling_avg(y_pred_test, 7)
        y_test_7d = rolling_avg(y_test, 7)

        # Metrics
        mae = np.mean(np.abs(y_test - y_pred_test))
        mae_7d = np.mean(np.abs(y_test_7d - y_pred_7d))
        rmse = np.sqrt(np.mean((y_test - y_pred_test) ** 2))
        corr = np.corrcoef(y_test, y_pred_test)[0, 1]

        # R² (only if valid)
        if r2_valid:
            ss_res = np.sum((y_test - y_pred_test) ** 2)
            ss_tot = np.sum((y_test - np.mean(y_test)) ** 2)
            r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0

            ss_res_7d = np.sum((y_test_7d - y_pred_7d) ** 2)
            ss_tot_7d = np.sum((y_test_7d - np.mean(y_test_7d)) ** 2)
            r2_7d = 1 - ss_res_7d / ss_tot_7d if ss_tot_7d > 0 else 0
        else:
            r2 = None
            r2_7d = None

        # Detection metrics (can we detect soiling events?)
        is_soiled_actual = y_test < 0.99
        is_soiled_pred = y_pred_test < 0.99

        if np.sum(is_soiled_actual) > 0:
            tp = np.sum(is_soiled_actual & is_soiled_pred)
            fp = np.sum(~is_soiled_actual & is_soiled_pred)
            fn = np.sum(is_soiled_actual & ~is_soiled_pred)

            precision = tp / (tp + fp) if (tp + fp) > 0 else 0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0
            f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
        else:
            precision = recall = f1 = None

        print(f"\n  === RESULTS ===")
        print(f"  MAE (daily):  {mae*100:.2f}%")
        print(f"  MAE (7-day):  {mae_7d*100:.2f}%")
        print(f"  RMSE:         {rmse*100:.2f}%")
        print(f"  Correlation:  {corr:.3f}")
        if r2_valid:
            print(f"  R² (daily):   {r2:.4f}")
            print(f"  R² (7-day):   {r2_7d:.4f}")
        else:
            print(f"  R²: N/A (insufficient test variance)")

        if precision is not None:
            print(f"\n  Detection (soiling <99%):")
            print(f"    Precision: {precision:.2f}")
            print(f"    Recall:    {recall:.2f}")
            print(f"    F1:        {f1:.2f}")

        # Feature importance
        importance = model.get_feature_importance()
        feat_imp = sorted(zip(feature_cols_daily, importance), key=lambda x: -x[1])

        print(f"\n  Top Features:")
        for fname, imp in feat_imp[:5]:
            print(f"    {fname}: {imp:.1f}")

        result["status"] = "success"
        result["n_train"] = len(X_train)
        result["n_test"] = len(X_test)
        result["test_std"] = float(test_std)
        result["soiled_pct"] = float(soiled_pct)
        result["mae"] = float(mae)
        result["mae_7d"] = float(mae_7d)
        result["rmse"] = float(rmse)
        result["corr"] = float(corr)
        result["r2_valid"] = bool(r2_valid)
        if r2_valid:
            result["r2"] = float(r2)
            result["r2_7d"] = float(r2_7d)
        if precision is not None:
            result["precision"] = float(precision)
            result["recall"] = float(recall)
            result["f1"] = float(f1)
        result["top_features"] = [(f, float(i)) for f, i in feat_imp[:5]]

    except Exception as e:
        import traceback
        print(f"  Error: {e}")
        traceback.print_exc()
        result["status"] = "error"
        result["error"] = str(e)

    return result


def main():
    print("="*70)
    print("SOILING PREDICTION - FINAL EVALUATION")
    print("="*70)
    print("Features: Twin + Weather + Rain (transfer learning safe)")
    print("Metrics: MAE (primary), R² only when valid, Detection accuracy")

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config)
        all_results.append(result)

    # Summary
    print("\n" + "="*100)
    print("SUMMARY")
    print("="*100)
    print(f"{'Plant':<12} | {'Test Std':>8} | {'MAE':>7} | {'7d MAE':>7} | {'Corr':>5} | {'R²':>8} | {'F1':>5} | Note")
    print("-" * 100)

    for r in all_results:
        if r["status"] == "success":
            r2_str = f"{r.get('r2_7d', 0):.3f}" if r.get('r2_valid') else "N/A"
            f1_str = f"{r.get('f1', 0):.2f}" if r.get('f1') is not None else "N/A"

            note = ""
            if not r.get('r2_valid'):
                note = "Clean (low variance)"
            elif r.get('r2_7d', 0) < 0:
                note = "Distribution shift"
            elif r.get('r2_7d', 0) > 0.5:
                note = "✓ Good"

            print(f"{r['plant_id']:<12} | {r['test_std']*100:>7.2f}% | {r['mae']*100:>6.2f}% | {r['mae_7d']*100:>6.2f}% | {r['corr']:>5.2f} | {r2_str:>8} | {f1_str:>5} | {note}")
        else:
            print(f"{r['plant_id']:<12} | Status: {r['status']}")

    print("\n" + "="*70)
    print("INTERPRETATION:")
    print("="*70)
    print("• MAE: Absolute prediction error (lower is better)")
    print("• R²: Only valid for plants with test_std > 0.5%")
    print("• F1: Soiling detection accuracy (1.0 = perfect)")
    print("• 'Clean' plants have MAE < 1% which is operationally acceptable")

    # Save
    output_path = Path("backenddata/outputs/dustiq_analysis/final_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\n✓ Saved to {output_path}")


if __name__ == "__main__":
    main()
