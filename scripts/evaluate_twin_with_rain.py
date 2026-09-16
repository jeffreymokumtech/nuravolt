#!/usr/bin/env python3
"""
Improved soiling prediction using twin features + rain data.

Key improvements:
1. Rain data for cleaning event prediction
2. Stronger regularization to prevent overfitting
3. Time-series cross-validation
4. NO DustIQ-derived features (transfer learning safe)
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


def load_rain_data(rain_path: Path) -> Optional[pl.DataFrame]:
    """Load rain history data."""
    if not rain_path.exists():
        return None

    with open(rain_path) as f:
        data = json.load(f)

    daily_data = data.get("daily_data", [])
    if not daily_data:
        return None

    df = pl.DataFrame(daily_data)
    return df


def create_rain_features(df_rain: pl.DataFrame, dates: list) -> Dict[str, np.ndarray]:
    """Create rain-based features aligned to SCADA dates.

    Key features:
    - days_since_rain: Days since last cleaning rain (>5mm)
    - rainfall_7d: Rolling 7-day precipitation
    - rainfall_14d: Rolling 14-day precipitation
    - rainfall_30d: Rolling 30-day precipitation
    - rain_days_7d: Number of rain days in last 7 days
    """
    features = {}

    # Convert dates to set for O(1) lookup
    date_to_idx = {str(d): i for i, d in enumerate(dates)}
    n_days = len(dates)

    # Initialize arrays
    days_since_rain = np.full(n_days, np.nan)
    rainfall_7d = np.full(n_days, np.nan)
    rainfall_14d = np.full(n_days, np.nan)
    rainfall_30d = np.full(n_days, np.nan)
    rain_days_7d = np.full(n_days, np.nan)
    is_cleaning_day = np.zeros(n_days)

    # Build rain lookup by date
    rain_by_date = {}
    for row in df_rain.iter_rows(named=True):
        rain_by_date[row['date']] = {
            'precip': row.get('precipitation_mm', 0) or 0,
            'is_cleaning': row.get('is_cleaning_event', False),
        }

    # Calculate features for each day
    for i, date in enumerate(dates):
        date_str = str(date)

        # Days since rain (look backwards)
        days_count = 0
        for back in range(min(i+1, 180)):  # Look back up to 180 days
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

        # Rolling sums
        precip_7d = 0
        precip_14d = 0
        precip_30d = 0
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
                if back < 30:
                    precip_30d += precip

        rainfall_7d[i] = precip_7d
        rainfall_14d[i] = precip_14d
        rainfall_30d[i] = precip_30d
        rain_days_7d[i] = rain_count_7d

        # Is today a cleaning day?
        if date_str in rain_by_date:
            is_cleaning_day[i] = 1 if rain_by_date[date_str]['is_cleaning'] else 0

    features['days_since_rain'] = days_since_rain
    features['rainfall_7d'] = rainfall_7d
    features['rainfall_14d'] = rainfall_14d
    features['rainfall_30d'] = rainfall_30d
    features['rain_days_7d'] = rain_days_7d
    features['is_cleaning_day'] = is_cleaning_day

    return features


def find_column(df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
    """Find column matching any pattern."""
    for pattern in patterns:
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '')
            if pattern_clean in col_clean:
                return col
    return None


def find_dc_columns(df: pl.DataFrame, inv_id: str, col_type: str) -> List[str]:
    """Find DC current or voltage columns for an inverter."""
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


def extract_twin_features(
    df: pl.DataFrame,
    twins_path: Path,
    irr_col: str,
    temp_col: str,
    max_inverters: int = 10,
) -> pl.DataFrame:
    """Extract twin features - same as original but condensed."""
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    if not meta_files:
        return df

    inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:max_inverters]
    print(f"    Loading {len(inv_ids)} twins...")

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

        except Exception as e:
            pass

    if not all_predictions:
        return df

    n_rows = len(df)
    added_feats = []
    for feat in feature_cols:
        feat_arrays = []
        for pred_df in all_predictions:
            if feat in pred_df.columns and len(pred_df) == n_rows:
                feat_arrays.append(pred_df[feat].to_numpy())

        if feat_arrays:
            stacked = np.column_stack(feat_arrays)
            mean_vals = np.nanmean(stacked, axis=1)
            df = df.with_columns(pl.Series(feat, mean_vals))
            added_feats.append(feat)

    print(f"    Added {len(added_feats)} twin features")
    return df


def calc_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """Calculate regression metrics."""
    mae = np.mean(np.abs(y_true - y_pred))
    ss_res = np.sum((y_true - y_pred) ** 2)
    ss_tot = np.sum((y_true - np.mean(y_true)) ** 2)
    r2 = 1 - (ss_res / ss_tot) if ss_tot > 1e-10 else 0
    corr = np.corrcoef(y_true, y_pred)[0, 1] if len(y_true) > 1 else 0
    rmse = np.sqrt(np.mean((y_true - y_pred) ** 2))
    return {"mae": mae, "r2": r2, "corr": corr, "rmse": rmse}


def rolling_avg(arr: np.ndarray, window: int = 7) -> np.ndarray:
    """Apply rolling average."""
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


def time_series_cv(X: np.ndarray, y: np.ndarray, n_splits: int = 5) -> List[Tuple[np.ndarray, np.ndarray]]:
    """Time-series cross-validation splits."""
    n = len(X)
    fold_size = n // (n_splits + 1)

    splits = []
    for i in range(n_splits):
        train_end = fold_size * (i + 2)
        test_start = train_end
        test_end = min(train_end + fold_size, n)

        train_idx = np.arange(0, train_end)
        test_idx = np.arange(test_start, test_end)

        if len(test_idx) > 10:  # At least 10 samples in test
            splits.append((train_idx, test_idx))

    return splits


def evaluate_plant(plant_id: str, config: dict) -> dict:
    """Evaluate soiling prediction with rain data."""

    print(f"\n{'='*60}")
    print(f"EVALUATING: {plant_id.upper()} (with rain features)")
    print(f"{'='*60}")

    result = {"plant_id": plant_id, "status": "unknown"}

    # Load SCADA data
    scada_path = Path(config["scada_path"])
    if not scada_path.exists():
        result["status"] = "no_scada"
        return result

    parquet_files = list(scada_path.glob("*.parquet"))
    if not parquet_files:
        result["status"] = "no_parquet"
        return result

    df = pl.read_parquet(parquet_files[0])
    print(f"  Loaded {len(df):,} rows")

    # Find columns
    irr_col = find_column(df, [config.get("irr_col", ""), "irradiation_average"])
    temp_col = find_column(df, [config.get("temp_col", ""), "ambient"])
    sr_col = find_column(df, [config.get("sr_col", ""), "soiling_ratio_sensor"])

    if not irr_col or not sr_col:
        result["status"] = "missing_columns"
        return result

    # Load rain data
    rain_path = Path(config.get("rain_path", ""))
    df_rain = load_rain_data(rain_path)
    has_rain = df_rain is not None
    print(f"  Rain data: {'✓ loaded' if has_rain else '✗ not found'}")

    # Check twins path
    twins_path = Path(config["twins_path"])

    # Extract twin features
    print("  Extracting twin features...")
    df = extract_twin_features(df, twins_path, irr_col, temp_col, max_inverters=10)

    # Convert SR to fraction
    df = df.with_columns(
        (pl.col(sr_col) / 100).alias('sr_dustiq')
    )

    # Filter valid data (daytime, reasonable SR range)
    df_valid = df.filter(
        pl.col('sr_dustiq').is_not_null() &
        (pl.col('sr_dustiq') >= 0.7) &
        (pl.col('sr_dustiq') <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    print(f"  Valid samples: {len(df_valid):,}")

    if len(df_valid) < 1000:
        result["status"] = "insufficient_data"
        return result

    # Daily aggregation
    df_valid = df_valid.with_columns(
        pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
    )

    # Twin feature columns
    twin_feat_cols = ['T_expected', 'temp_deviation', 'I_expected', 'current_cv',
                      'current_imbalance_ratio', 'V_expected', 'voltage_cv',
                      'power_loss_pct', 'P_expected']
    twin_feat_cols = [c for c in twin_feat_cols if c in df_valid.columns]

    # Other columns (irradiance, temp)
    other_cols = []
    if irr_col in df_valid.columns:
        other_cols.append(irr_col)
    if temp_col and temp_col in df_valid.columns:
        other_cols.append(temp_col)

    all_feature_cols = twin_feat_cols + other_cols

    # Daily aggregation
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
    print(f"  Daily samples: {len(df_daily)}")

    # Add rain features
    if has_rain:
        dates = df_daily['date'].to_list()
        rain_features = create_rain_features(df_rain, dates)
        for feat_name, feat_vals in rain_features.items():
            df_daily = df_daily.with_columns(
                pl.Series(feat_name, feat_vals)
            )
        print(f"  Added {len(rain_features)} rain features")

    # Add temporal features (month, day of year - for seasonality)
    df_daily = df_daily.with_columns([
        pl.col('date').str.slice(5, 2).cast(pl.Int32).alias('month'),
        pl.col('date').str.slice(8, 2).cast(pl.Int32).alias('day'),
    ])

    # Get all feature columns
    feature_cols_daily = [c for c in df_daily.columns
                         if c.endswith('_mean') or c.endswith('_std') or
                         c in ['days_since_rain', 'rainfall_7d', 'rainfall_14d',
                               'rainfall_30d', 'rain_days_7d', 'is_cleaning_day',
                               'month', 'day']]

    # Filter valid columns
    feature_cols_daily = [c for c in feature_cols_daily
                         if c in df_daily.columns and not df_daily[c].is_null().all()]

    print(f"  Total features: {len(feature_cols_daily)}")

    if len(feature_cols_daily) < 3:
        result["status"] = "insufficient_features"
        return result

    # Prepare data
    X = df_daily.select(feature_cols_daily).to_pandas().values
    y = df_daily['sr_dustiq'].to_numpy()

    # Handle NaN
    for i in range(X.shape[1]):
        col_median = np.nanmedian(X[:, i])
        if np.isnan(col_median):
            col_median = 0
        X[np.isnan(X[:, i]), i] = col_median

    # Train/test split (80/20, time-ordered)
    n_train = int(len(X) * 0.8)
    X_train, X_test = X[:n_train], X[n_train:]
    y_train, y_test = y[:n_train], y[n_train:]

    print(f"  Train: {len(X_train)}, Test: {len(X_test)}")

    # Train with stronger regularization
    try:
        from catboost import CatBoostRegressor

        # More aggressive regularization to prevent overfitting
        model = CatBoostRegressor(
            iterations=300,  # Reduced
            learning_rate=0.03,  # Lower
            depth=4,  # Shallower
            l2_leaf_reg=10.0,  # Higher regularization
            min_data_in_leaf=20,  # More samples per leaf
            random_seed=42,
            verbose=False,
            early_stopping_rounds=30,
        )

        model.fit(X_train, y_train, eval_set=(X_test, y_test), verbose=False)

        # Predictions
        y_pred_train = model.predict(X_train)
        y_pred_test = model.predict(X_test)

        # 7-day rolling average
        y_pred_test_7d = rolling_avg(y_pred_test, 7)
        y_test_7d = rolling_avg(y_test, 7)

        train_metrics = calc_metrics(y_train, y_pred_train)
        test_metrics = calc_metrics(y_test, y_pred_test)
        test_metrics_7d = calc_metrics(y_test_7d, y_pred_test_7d)

        print(f"\n  === RESULTS ===")
        print(f"  Train:      R²={train_metrics['r2']:.4f}, MAE={train_metrics['mae']*100:.2f}%")
        print(f"  Test Daily: R²={test_metrics['r2']:.4f}, MAE={test_metrics['mae']*100:.2f}%")
        print(f"  Test 7-day: R²={test_metrics_7d['r2']:.4f}, MAE={test_metrics_7d['mae']*100:.2f}%")

        # Feature importance
        importance = model.get_feature_importance()
        feat_imp = sorted(zip(feature_cols_daily, importance), key=lambda x: -x[1])

        print(f"\n  Top Features:")
        for fname, imp in feat_imp[:8]:
            print(f"    {fname}: {imp:.1f}")

        # Cross-validation for more robust estimate
        ts_splits = time_series_cv(X, y, n_splits=4)
        cv_scores = []
        for train_idx, test_idx in ts_splits:
            cv_model = CatBoostRegressor(
                iterations=200, learning_rate=0.03, depth=4,
                l2_leaf_reg=10.0, min_data_in_leaf=20,
                random_seed=42, verbose=False
            )
            cv_model.fit(X[train_idx], y[train_idx], verbose=False)
            cv_pred = cv_model.predict(X[test_idx])
            cv_metrics = calc_metrics(y[test_idx], cv_pred)
            cv_scores.append(cv_metrics['r2'])

        cv_mean = np.mean(cv_scores)
        cv_std = np.std(cv_scores)
        print(f"\n  Time-Series CV: R²={cv_mean:.4f} ± {cv_std:.4f}")

        result["status"] = "success"
        result["n_train"] = len(X_train)
        result["n_test"] = len(X_test)
        result["n_features"] = len(feature_cols_daily)
        result["has_rain"] = has_rain
        result["train_r2"] = float(train_metrics["r2"])
        result["train_mae"] = float(train_metrics["mae"])
        result["test_r2"] = float(test_metrics["r2"])
        result["test_mae"] = float(test_metrics["mae"])
        result["test_corr"] = float(test_metrics["corr"])
        result["test_r2_7d"] = float(test_metrics_7d["r2"])
        result["test_mae_7d"] = float(test_metrics_7d["mae"])
        result["test_corr_7d"] = float(test_metrics_7d["corr"])
        result["cv_r2_mean"] = float(cv_mean)
        result["cv_r2_std"] = float(cv_std)
        result["top_features"] = [(f, float(i)) for f, i in feat_imp[:10]]

    except ImportError:
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
    print("SOILING PREDICTION WITH RAIN DATA")
    print("="*60)
    print("Features: Twin outputs + Weather + Rain (NO DustIQ history)")
    print("Regularization: Strong (depth=4, l2=10, min_leaf=20)")

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config)
        all_results.append(result)

    # Summary table
    print("\n" + "="*100)
    print("SUMMARY")
    print("="*100)
    print(f"{'Plant':<12} | {'Rain':>4} | {'Train R²':>9} | {'Test R²':>8} | {'7d R²':>8} | {'CV R²':>12} | {'7d MAE':>9}")
    print("-" * 100)

    for r in all_results:
        if r["status"] == "success":
            rain_str = "✓" if r.get("has_rain") else "✗"
            cv_str = f"{r.get('cv_r2_mean', 0):.3f}±{r.get('cv_r2_std', 0):.3f}"
            print(f"{r['plant_id']:<12} | {rain_str:>4} | {r['train_r2']:>9.4f} | {r['test_r2']:>8.4f} | {r.get('test_r2_7d', 0):>8.4f} | {cv_str:>12} | {r.get('test_mae_7d', 0)*100:>8.2f}%")
        else:
            print(f"{r['plant_id']:<12} | {'N/A':>4} | {'N/A':>9} | {'N/A':>8} | {'N/A':>8} | {'N/A':>12} | Status: {r['status']}")

    # Save results
    output_path = Path("backenddata/outputs/dustiq_analysis/twin_rain_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
