#!/usr/bin/env python3
"""
Soiling prediction using ALL available data sources:
- Digital Twin features (power loss, current CV, etc.)
- Rain data (days since rain, rolling precipitation)
- AOD/Dust data (PM10, PM2.5, dust concentration)
- Extended Weather (humidity, wind, dewpoint)

NO DustIQ-derived features (transfer learning safe)
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


PLANTS = {
    "epsilon": {
        "scada_path": "backenddata/scada/epsilon",
        "twins_path": "public/data/digitaltwin/epsilon",
        "rain_path": "public/data/soiling/epsilon/rain_history.json",
        "aod_path": "public/data/soiling/epsilon/aod_history.json",
        "weather_path": "public/data/soiling/epsilon/weather_extended.json",
        "irr_col": "Epsilon: Plant / Irradiation_average (W/m²)",
        "temp_col": "Epsilon: Temperatur Sensor 1 / Ambient (°C)",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
    },
    "ribera": {
        "scada_path": "backenddata/scada/ribera",
        "twins_path": "public/data/digitaltwin/ribera",
        "rain_path": "public/data/soiling/ribera/rain_history.json",
        "aod_path": "public/data/soiling/ribera/aod_history.json",
        "weather_path": "public/data/soiling/ribera/weather_extended.json",
        "irr_col": "Ribera (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Ribera (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "eta": {
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "rain_path": "public/data/soiling/eta/rain_history.json",
        "aod_path": "public/data/soiling/eta/aod_history.json",
        "weather_path": "public/data/soiling/eta/weather_extended.json",
        "irr_col": "Eta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Eta (ES): Temperatur MC / Ambient (°C)",
        "sr_col": "Eta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "delta": {
        "scada_path": "backenddata/scada/delta",
        "twins_path": "public/data/digitaltwin/delta",
        "rain_path": "public/data/soiling/delta/rain_history.json",
        "aod_path": "public/data/soiling/delta/aod_history.json",
        "weather_path": "public/data/soiling/delta/weather_extended.json",
        "irr_col": "Delta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Delta (ES): zbloxx 407 / Ambient",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "zeta": {
        "scada_path": "backenddata/scada/zeta",
        "twins_path": "public/data/digitaltwin/zeta",
        "rain_path": "public/data/soiling/zeta/rain_history.json",
        "aod_path": "public/data/soiling/zeta/aod_history.json",
        "weather_path": "public/data/soiling/zeta/weather_extended.json",
        "irr_col": "Zeta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Zeta (ES): Meteo.Z.bloxx407 / temperature_internal (°C)",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "gamma": {
        "scada_path": "backenddata/scada/gamma",
        "twins_path": "public/data/digitaltwin/gamma",
        "rain_path": "public/data/soiling/gamma/rain_history.json",
        "aod_path": "public/data/soiling/gamma/aod_history.json",
        "weather_path": "public/data/soiling/gamma/weather_extended.json",
        "irr_col": "Gamma 1& 2 (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Gamma 1& 2 (ES): zbloxx 407 / temperature_internal (°C)",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
    },
    "alpha": {
        "scada_path": "backenddata/scada/alpha",
        "twins_path": "public/data/digitaltwin/alpha",
        "rain_path": "public/data/soiling/alpha/rain_history.json",
        "aod_path": "public/data/soiling/alpha/aod_history.json",
        "weather_path": "public/data/soiling/alpha/weather_extended.json",
        "irr_col": "Alpha (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Alpha (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Alpha (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
}

SR_BINS = [
    (0.70, 0.90, "<90%"),
    (0.90, 0.95, "90-95%"),
    (0.95, 0.98, "95-98%"),
    (0.98, 0.99, "98-99%"),
    (0.99, 1.02, ">99%"),
]


def load_json_data(path: Path) -> Optional[dict]:
    """Load JSON data file."""
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def create_rain_features(df_rain: pl.DataFrame, dates: list) -> Dict[str, np.ndarray]:
    """Create rain-based features."""
    n_days = len(dates)
    features = {k: np.full(n_days, np.nan) for k in
                ['days_since_rain', 'rainfall_7d', 'rainfall_14d', 'rainfall_30d']}

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
            if str(check_date) in rain_by_date and rain_by_date[str(check_date)]['is_cleaning']:
                features['days_since_rain'][i] = days_count
                break
            days_count += 1
        else:
            features['days_since_rain'][i] = days_count

        p7 = p14 = p30 = 0
        for back in range(min(i+1, 30)):
            check_str = str(dates[i - back]) if i - back >= 0 else None
            if check_str and check_str in rain_by_date:
                p = rain_by_date[check_str]['precip']
                if back < 7: p7 += p
                if back < 14: p14 += p
                p30 += p
        features['rainfall_7d'][i] = p7
        features['rainfall_14d'][i] = p14
        features['rainfall_30d'][i] = p30

    return features


def create_aod_features(aod_data: dict, dates: list) -> Dict[str, np.ndarray]:
    """Create AOD/dust features."""
    n_days = len(dates)
    features = {k: np.full(n_days, np.nan) for k in
                ['pm10_mean', 'pm2p5_mean', 'dust_mean', 'pm10_7d_avg']}

    aod_by_date = {}
    for row in aod_data.get('daily_data', []):
        aod_by_date[row['date']] = row

    for i, date in enumerate(dates):
        date_str = str(date)
        if date_str in aod_by_date:
            d = aod_by_date[date_str]
            features['pm10_mean'][i] = d.get('pm10_mean')
            features['pm2p5_mean'][i] = d.get('pm2p5_mean')
            features['dust_mean'][i] = d.get('dust_mean')

        # 7-day PM10 average
        pm10_vals = []
        for back in range(min(i+1, 7)):
            check_str = str(dates[i - back]) if i - back >= 0 else None
            if check_str and check_str in aod_by_date:
                pm = aod_by_date[check_str].get('pm10_mean')
                if pm is not None:
                    pm10_vals.append(pm)
        if pm10_vals:
            features['pm10_7d_avg'][i] = np.mean(pm10_vals)

    return features


def create_weather_features(weather_data: dict, dates: list) -> Dict[str, np.ndarray]:
    """Create extended weather features."""
    n_days = len(dates)
    features = {k: np.full(n_days, np.nan) for k in
                ['humidity_mean', 'humidity_min', 'dewpoint_mean', 'wind_speed_max',
                 'wind_speed_mean', 'dew_cleaning', 'dust_transport_risk']}

    weather_by_date = {}
    for row in weather_data.get('daily_data', []):
        weather_by_date[row['date']] = row

    for i, date in enumerate(dates):
        date_str = str(date)
        if date_str in weather_by_date:
            d = weather_by_date[date_str]
            features['humidity_mean'][i] = d.get('relative_humidity_mean')
            features['humidity_min'][i] = d.get('relative_humidity_min')
            features['dewpoint_mean'][i] = d.get('dewpoint_mean')
            features['wind_speed_max'][i] = d.get('wind_speed_max')
            features['wind_speed_mean'][i] = d.get('wind_speed_mean')
            features['dew_cleaning'][i] = 1 if d.get('dew_cleaning_likely') else 0
            features['dust_transport_risk'][i] = 1 if d.get('dust_transport_risk') else 0

    return features


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
            if col_type == 'current' and ('i_dc' in c_lower or 'input_current' in c_lower or 'idc' in c_lower):
                cols.append(c)
            elif col_type == 'voltage' and ('u_dc' in c_lower or 'u_mppt' in c_lower or 'input_voltage' in c_lower):
                cols.append(c)
    return sorted(cols)


def extract_twin_features(df: pl.DataFrame, twins_path: Path, irr_col: str, temp_col: str) -> pl.DataFrame:
    """Extract twin features."""
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    if not meta_files:
        return df

    inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:10]

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
    """Evaluate with all available sources."""

    print(f"\n{'='*60}")
    print(f"{plant_id.upper()}")
    print(f"{'='*60}")

    result = {"plant_id": plant_id, "status": "unknown", "sources_used": []}

    # Load SCADA
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

    result["sources_used"].append("scada")

    # Load external data sources
    rain_data = load_json_data(Path(config.get("rain_path", "")))
    aod_data = load_json_data(Path(config.get("aod_path", "")))
    weather_data = load_json_data(Path(config.get("weather_path", "")))

    if rain_data:
        result["sources_used"].append("rain")
    if aod_data:
        result["sources_used"].append("aod")
    if weather_data:
        result["sources_used"].append("weather")

    # Extract twin features
    twins_path = Path(config["twins_path"])
    df = extract_twin_features(df, twins_path, irr_col, temp_col)
    result["sources_used"].append("twin")

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

    other_cols = [c for c in [irr_col, temp_col] if c and c in df_valid.columns]
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
    dates = df_daily['date'].to_list()

    # Add rain features
    if rain_data:
        df_rain = pl.DataFrame(rain_data.get('daily_data', []))
        rain_features = create_rain_features(df_rain, dates)
        for feat_name, feat_vals in rain_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    # Add AOD features
    if aod_data:
        aod_features = create_aod_features(aod_data, dates)
        for feat_name, feat_vals in aod_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    # Add weather features
    if weather_data:
        weather_features = create_weather_features(weather_data, dates)
        for feat_name, feat_vals in weather_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    # Add temporal features
    df_daily = df_daily.with_columns([
        pl.col('date').str.slice(5, 2).cast(pl.Int32).alias('month'),
    ])

    # Get feature columns
    feature_cols_daily = [c for c in df_daily.columns
                         if c.endswith('_mean') or c.endswith('_std') or
                         c in ['days_since_rain', 'rainfall_7d', 'rainfall_14d', 'rainfall_30d',
                               'pm10_mean', 'pm2p5_mean', 'dust_mean', 'pm10_7d_avg',
                               'humidity_mean', 'humidity_min', 'dewpoint_mean',
                               'wind_speed_max', 'wind_speed_mean', 'dew_cleaning',
                               'dust_transport_risk', 'month']]
    feature_cols_daily = [c for c in feature_cols_daily
                         if c in df_daily.columns and not df_daily[c].is_null().all()]

    print(f"  Sources: {', '.join(result['sources_used'])}")
    print(f"  Features: {len(feature_cols_daily)}")

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

    test_std = np.std(y_test)

    try:
        from catboost import CatBoostRegressor

        model = CatBoostRegressor(
            iterations=200,
            learning_rate=0.02,
            depth=3,
            l2_leaf_reg=15.0,
            min_data_in_leaf=30,
            random_seed=42,
            verbose=False,
        )

        model.fit(X_train, y_train, verbose=False)
        y_pred_test = model.predict(X_test)

        # 7-day rolling average
        y_pred_7d = rolling_avg(y_pred_test, 7)
        y_test_7d = rolling_avg(y_test, 7)

        mae = np.mean(np.abs(y_test - y_pred_test))
        mae_7d = np.mean(np.abs(y_test_7d - y_pred_7d))
        corr = np.corrcoef(y_test, y_pred_test)[0, 1]

        # MAE by bin
        mae_by_bin = {}
        for low, high, label in SR_BINS:
            mask = (y_test_7d >= low) & (y_test_7d < high)
            count = np.sum(mask)
            if count > 0:
                bin_mae = np.mean(np.abs(y_test_7d[mask] - y_pred_7d[mask]))
                mae_by_bin[label] = {"count": int(count), "mae": float(bin_mae)}
            else:
                mae_by_bin[label] = {"count": 0, "mae": None}

        # Feature importance
        importance = model.get_feature_importance()
        feat_imp = sorted(zip(feature_cols_daily, importance), key=lambda x: -x[1])

        print(f"\n  7d MAE: {mae_7d*100:.2f}%, Corr: {corr:.3f}")
        print(f"\n  MAE by bin:")
        for label, data in mae_by_bin.items():
            if data["count"] > 0:
                print(f"    {label}: {data['mae']*100:.2f}% ({data['count']} days)")

        print(f"\n  Top Features:")
        for fname, imp in feat_imp[:5]:
            print(f"    {fname}: {imp:.1f}")

        result["status"] = "success"
        result["n_features"] = len(feature_cols_daily)
        result["mae"] = float(mae)
        result["mae_7d"] = float(mae_7d)
        result["corr"] = float(corr)
        result["mae_by_bin"] = mae_by_bin
        result["top_features"] = [(f, float(i)) for f, i in feat_imp[:10]]

    except Exception as e:
        import traceback
        print(f"  Error: {e}")
        traceback.print_exc()
        result["status"] = "error"

    return result


def main():
    print("="*70)
    print("SOILING PREDICTION - ALL DATA SOURCES")
    print("="*70)
    print("Sources: Twin + Rain + AOD/Dust + Extended Weather")

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config)
        all_results.append(result)

    # Summary
    print("\n" + "="*100)
    print("SUMMARY - 7d MAE by SR Bin")
    print("="*100)

    header = f"{'Plant':<12} | {'Sources':>6}"
    for _, _, label in SR_BINS:
        header += f" | {label:>8}"
    header += f" | {'Overall':>8}"
    print(header)
    print("-" * 100)

    for r in all_results:
        if r["status"] == "success":
            row = f"{r['plant_id']:<12} | {len(r['sources_used']):>6}"
            for _, _, label in SR_BINS:
                bin_data = r["mae_by_bin"].get(label, {})
                if bin_data.get("mae") is not None:
                    row += f" | {bin_data['mae']*100:>7.2f}%"
                else:
                    row += f" | {'N/A':>8}"
            row += f" | {r['mae_7d']*100:>7.2f}%"
            print(row)

    # Save
    output_path = Path("backenddata/outputs/dustiq_analysis/all_sources_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)

    print(f"\n✓ Saved to {output_path}")


if __name__ == "__main__":
    main()
