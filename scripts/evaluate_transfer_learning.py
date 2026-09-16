#!/usr/bin/env python3
"""
Transfer Learning Evaluation for Soiling Prediction.

Trains a foundation model on source plants with good soiling variation
(zeta + epsilon) and evaluates transfer to all plants.

Compares:
1. Same-plant training (80/20 split on each plant)
2. Transfer learning (train on source, test on target)

Uses cleaned DustIQ data and all available data sources.
"""

import json
import sys
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import polars as pl

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))


# Source plants for training (best soiling variation)
SOURCE_PLANTS = ["zeta", "epsilon"]

# All plants for evaluation
ALL_PLANTS = ["epsilon", "ribera", "eta", "delta", "zeta", "gamma", "alpha"]

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
        "sr_col_cleaned": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)_cleaned",
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
        "sr_col_cleaned": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "eta": {
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "rain_path": "public/data/soiling/eta/rain_history.json",
        "aod_path": "public/data/soiling/eta/aod_history.json",
        "weather_path": "public/data/soiling/eta/weather_extended.json",
        "irr_col": "Eta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Eta (ES): Temperatur MC / Ambient (°C)",
        "sr_col": "Eta (ES): Dust_IQ.01 / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Eta (ES): Dust_IQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
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
        "sr_col_cleaned": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
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
        "sr_col_cleaned": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
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
        "sr_col_cleaned": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)_cleaned",
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
        "sr_col_cleaned": "Alpha (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
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


def extract_twin_features(df: pl.DataFrame, twins_path: Path, irr_col: str, temp_col: str) -> pl.DataFrame:
    """Extract twin features."""
    from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    if not meta_files:
        return df

    inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files][:10]

    feature_cols = [
        'T_expected', 'temp_deviation',
        'I_expected', 'current_cv', 'current_imbalance_ratio',
        'V_expected', 'voltage_cv',
        'power_loss_pct',
    ]

    for col in feature_cols:
        if col not in df.columns:
            df = df.with_columns(pl.lit(None).cast(pl.Float64).alias(col))

    for inv_id in inv_ids[:3]:
        try:
            factory = MultiSignalTwinFactory.load(twins_path, inv_id)
            if factory is None:
                continue

            for i in range(min(100, len(df))):
                row = df.row(i, named=True)
                irr = row.get(irr_col)
                temp = row.get(temp_col)

                if irr is None or temp is None or irr < 100:
                    continue

                try:
                    predictions = factory.predict_all({'irradiance': irr, 'temperature': temp})

                    for col in feature_cols:
                        if col in predictions and predictions[col] is not None:
                            df = df.with_columns(
                                pl.when(pl.arange(0, len(df)) == i)
                                .then(predictions[col])
                                .otherwise(pl.col(col))
                                .alias(col)
                            )
                except:
                    pass

            break

        except Exception as e:
            continue

    return df


def rolling_avg(arr: np.ndarray, window: int) -> np.ndarray:
    """Calculate rolling average."""
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


def load_plant_data(plant_id: str, use_cleaned: bool = True) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    """Load and prepare data for a single plant."""
    config = PLANTS[plant_id]
    scada_path = Path(config["scada_path"])

    # Try cleaned file first
    if use_cleaned:
        cleaned_file = scada_path / f"{plant_id}_cleaned.parquet"
        if cleaned_file.exists():
            df = pl.read_parquet(cleaned_file)
            sr_col = config.get("sr_col_cleaned", config["sr_col"])
        else:
            parquet_files = list(scada_path.glob("*.parquet"))
            df = pl.read_parquet(parquet_files[0])
            sr_col = config["sr_col"]
    else:
        parquet_files = list(scada_path.glob("*.parquet"))
        df = pl.read_parquet(parquet_files[0])
        sr_col = config["sr_col"]

    irr_col = find_column(df, [config.get("irr_col", ""), "irradiation_average"])
    temp_col = find_column(df, [config.get("temp_col", ""), "ambient"])
    sr_col_found = find_column(df, [sr_col, config["sr_col"], "soiling_ratio"])

    if not irr_col or not sr_col_found:
        return None, None, []

    # Load external data
    rain_data = load_json_data(Path(config.get("rain_path", "")))
    aod_data = load_json_data(Path(config.get("aod_path", "")))
    weather_data = load_json_data(Path(config.get("weather_path", "")))

    # Extract twin features
    twins_path = Path(config["twins_path"])
    df = extract_twin_features(df, twins_path, irr_col, temp_col)

    # Convert SR to ratio
    df = df.with_columns((pl.col(sr_col_found) / 100).alias('sr_dustiq'))

    # Filter valid data
    df_valid = df.filter(
        pl.col('sr_dustiq').is_not_null() &
        (pl.col('sr_dustiq') >= 0.7) &
        (pl.col('sr_dustiq') <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    if len(df_valid) < 100:
        return None, None, []

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

    # Add external features
    if rain_data:
        df_rain = pl.DataFrame(rain_data.get('daily_data', []))
        rain_features = create_rain_features(df_rain, dates)
        for feat_name, feat_vals in rain_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    if aod_data:
        aod_features = create_aod_features(aod_data, dates)
        for feat_name, feat_vals in aod_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    if weather_data:
        weather_features = create_weather_features(weather_data, dates)
        for feat_name, feat_vals in weather_features.items():
            df_daily = df_daily.with_columns(pl.Series(feat_name, feat_vals))

    # Add temporal features
    df_daily = df_daily.with_columns([
        pl.col('date').str.slice(5, 2).cast(pl.Int32).alias('month'),
    ])

    # Get feature columns
    feature_cols = [c for c in df_daily.columns
                    if c.endswith('_mean') or c.endswith('_std') or
                    c in ['days_since_rain', 'rainfall_7d', 'rainfall_14d', 'rainfall_30d',
                          'pm10_mean', 'pm2p5_mean', 'dust_mean', 'pm10_7d_avg',
                          'humidity_mean', 'humidity_min', 'dewpoint_mean',
                          'wind_speed_max', 'wind_speed_mean', 'dew_cleaning',
                          'dust_transport_risk', 'month']]
    feature_cols = [c for c in feature_cols
                    if c in df_daily.columns and not df_daily[c].is_null().all()]

    # Prepare arrays
    X = df_daily.select(feature_cols).to_pandas().values
    y = df_daily['sr_dustiq'].to_numpy()

    # Handle NaN
    for i in range(X.shape[1]):
        col_median = np.nanmedian(X[:, i])
        if np.isnan(col_median):
            col_median = 0
        X[np.isnan(X[:, i]), i] = col_median

    return X, y, feature_cols


def evaluate_with_model(model, X_test: np.ndarray, y_test: np.ndarray) -> dict:
    """Evaluate model on test data."""
    y_pred = model.predict(X_test)

    # 7-day rolling average
    y_pred_7d = rolling_avg(y_pred, 7)
    y_test_7d = rolling_avg(y_test, 7)

    mae = np.mean(np.abs(y_test - y_pred))
    mae_7d = np.mean(np.abs(y_test_7d - y_pred_7d))
    corr = np.corrcoef(y_test, y_pred)[0, 1] if len(y_test) > 1 else 0

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

    return {
        "mae": float(mae),
        "mae_7d": float(mae_7d),
        "corr": float(corr),
        "mae_by_bin": mae_by_bin,
        "n_test": len(y_test),
    }


def main():
    print(f"\n{'='*70}")
    print(f"TRANSFER LEARNING EVALUATION")
    print(f"Source plants: {', '.join(SOURCE_PLANTS)}")
    print(f"Generated: {datetime.now().isoformat()}")
    print(f"{'='*70}")

    # Load and combine source plant data
    print(f"\n--- Loading Source Plant Data ---")
    X_train_list = []
    y_train_list = []
    feature_cols = None

    for source_plant in SOURCE_PLANTS:
        X, y, cols = load_plant_data(source_plant, use_cleaned=True)
        if X is not None:
            print(f"  {source_plant}: {len(y)} days, {len(cols)} features")
            X_train_list.append(X)
            y_train_list.append(y)
            if feature_cols is None:
                feature_cols = cols
        else:
            print(f"  {source_plant}: FAILED to load")

    if len(X_train_list) == 0:
        print("ERROR: No source plant data loaded")
        return

    # Combine source data
    X_train = np.vstack(X_train_list)
    y_train = np.concatenate(y_train_list)
    print(f"\n  Combined training data: {len(y_train)} days")

    # SR distribution in training data
    below_95 = (y_train < 0.95).sum()
    in_90_95 = ((y_train >= 0.90) & (y_train < 0.95)).sum()
    print(f"  Days < 95%: {below_95}, Days 90-95%: {in_90_95}")

    # Train foundation model
    print(f"\n--- Training Foundation Model ---")
    from catboost import CatBoostRegressor

    foundation_model = CatBoostRegressor(
        iterations=300,
        learning_rate=0.02,
        depth=4,
        l2_leaf_reg=10.0,
        min_data_in_leaf=20,
        random_seed=42,
        verbose=False,
    )
    foundation_model.fit(X_train, y_train, verbose=False)
    print(f"  Foundation model trained")

    # Feature importance
    importance = foundation_model.get_feature_importance()
    feat_imp = sorted(zip(feature_cols, importance), key=lambda x: -x[1])
    print(f"\n  Top 5 Features:")
    for fname, imp in feat_imp[:5]:
        print(f"    {fname}: {imp:.1f}")

    # Evaluate on all plants
    print(f"\n{'='*70}")
    print(f"EVALUATION RESULTS")
    print(f"{'='*70}")

    results = {}

    for plant_id in ALL_PLANTS:
        print(f"\n--- {plant_id.upper()} ---")

        X, y, cols = load_plant_data(plant_id, use_cleaned=True)
        if X is None:
            print(f"  FAILED to load data")
            continue

        # Align feature columns
        if len(cols) != len(feature_cols):
            print(f"  Feature mismatch: {len(cols)} vs {len(feature_cols)}")
            # Try to align by padding/truncating
            if len(cols) < len(feature_cols):
                # Pad with zeros
                diff = len(feature_cols) - len(cols)
                X = np.hstack([X, np.zeros((len(X), diff))])
            else:
                X = X[:, :len(feature_cols)]

        # Same-plant evaluation (80/20 split)
        n_train_sp = int(len(X) * 0.8)
        X_train_sp, X_test_sp = X[:n_train_sp], X[n_train_sp:]
        y_train_sp, y_test_sp = y[:n_train_sp], y[n_train_sp:]

        same_plant_model = CatBoostRegressor(
            iterations=200,
            learning_rate=0.02,
            depth=3,
            l2_leaf_reg=15.0,
            min_data_in_leaf=30,
            random_seed=42,
            verbose=False,
        )
        same_plant_model.fit(X_train_sp, y_train_sp, verbose=False)
        same_plant_result = evaluate_with_model(same_plant_model, X_test_sp, y_test_sp)

        # Transfer learning evaluation (use last 20% as test)
        X_test_tf = X[n_train_sp:]
        y_test_tf = y[n_train_sp:]
        transfer_result = evaluate_with_model(foundation_model, X_test_tf, y_test_tf)

        # Compare
        is_source = plant_id in SOURCE_PLANTS
        improvement = (same_plant_result['mae_7d'] - transfer_result['mae_7d']) / same_plant_result['mae_7d'] * 100

        print(f"  Days: {len(y)}, Test: {len(y_test_sp)}")
        print(f"  Same-plant 7d MAE: {same_plant_result['mae_7d']*100:.2f}%")
        print(f"  Transfer 7d MAE:   {transfer_result['mae_7d']*100:.2f}% {'(source plant)' if is_source else ''}")
        print(f"  Improvement:       {improvement:+.1f}%")

        # MAE by bin comparison
        print(f"\n  MAE by SR bin (Same-plant → Transfer):")
        for label in ["90-95%", "95-98%", "98-99%", ">99%"]:
            sp_data = same_plant_result['mae_by_bin'].get(label, {})
            tf_data = transfer_result['mae_by_bin'].get(label, {})
            sp_mae = sp_data.get('mae')
            tf_mae = tf_data.get('mae')
            count = sp_data.get('count', 0)

            if count > 0 and sp_mae is not None and tf_mae is not None:
                change = "↓" if tf_mae < sp_mae else "↑"
                print(f"    {label}: {sp_mae*100:.2f}% → {tf_mae*100:.2f}% {change} ({count} days)")
            elif count > 0:
                print(f"    {label}: N/A ({count} days)")

        results[plant_id] = {
            "is_source": is_source,
            "n_days": len(y),
            "same_plant": same_plant_result,
            "transfer": transfer_result,
            "improvement_pct": improvement,
        }

    # Summary table
    print(f"\n{'='*70}")
    print(f"SUMMARY: Same-Plant vs Transfer Learning (7-day MAE)")
    print(f"{'='*70}")
    print(f"{'Plant':<15} {'Same-Plant':<12} {'Transfer':<12} {'Change':<10} {'Source?'}")
    print(f"{'-'*60}")

    for plant_id in ALL_PLANTS:
        if plant_id not in results:
            continue
        r = results[plant_id]
        sp_mae = r['same_plant']['mae_7d'] * 100
        tf_mae = r['transfer']['mae_7d'] * 100
        change = r['improvement_pct']
        is_source = "Yes" if r['is_source'] else "No"

        change_str = f"{change:+.1f}%" if change != 0 else "0%"
        print(f"{plant_id:<15} {sp_mae:.2f}%{'':<6} {tf_mae:.2f}%{'':<6} {change_str:<10} {is_source}")

    # Save results
    output_path = Path("backenddata/outputs/transfer_learning_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump({
            "source_plants": SOURCE_PLANTS,
            "generated_at": datetime.now().isoformat(),
            "results": results,
        }, f, indent=2)
    print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
