#!/usr/bin/env python3
"""
Enhanced Weather Features for Soiling Forecast

Fetches and adds:
- Wind speed & direction
- Humidity & dew point
- Temperature
- Solar radiation (GHI)

Compares baseline vs enhanced model performance.
"""

import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
import json
import warnings
import requests
from time import sleep
warnings.filterwarnings('ignore')

from catboost import CatBoostRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from scipy import stats

# Configuration
DATA_DIR = Path("public/data/soiling/ribera")
OUTPUT_DIR = Path("outputs_enhanced_forecast")
OUTPUT_DIR.mkdir(exist_ok=True)

# Ribera location
LATITUDE = 37.927
LONGITUDE = -1.233

print("=" * 80)
print("ENHANCED WEATHER FEATURES FOR SOILING FORECAST")
print("=" * 80)

# =============================================================================
# STEP 1: Load Existing Data
# =============================================================================
print("\n📂 Loading existing data...")

# Load DustIQ
with open(DATA_DIR / "dustiq_history.json", 'r') as f:
    dustiq_data = json.load(f)
df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])
df_dustiq = df_dustiq.rename(columns={'sr_dustiq': 'sr'})
df_dustiq = df_dustiq.sort_values('date').drop_duplicates('date')
print(f"  ✅ DustIQ: {len(df_dustiq)} days")

# Load rain
with open(DATA_DIR / "rain_history.json", 'r') as f:
    rain_data = json.load(f)
df_rain = pd.DataFrame(rain_data['daily_data'])
df_rain['date'] = pd.to_datetime(df_rain['date'])
df_rain = df_rain.sort_values('date').drop_duplicates('date')
print(f"  ✅ Rain: {len(df_rain)} days")

# Load AOD
with open(DATA_DIR / "aod_merged.json", 'r') as f:
    aod_data = json.load(f)
df_aod = pd.DataFrame(aod_data['daily_data'])
df_aod['date'] = pd.to_datetime(df_aod['date'])
df_aod = df_aod.sort_values('date').drop_duplicates('date')
print(f"  ✅ AOD: {len(df_aod)} days")

# Get date range
date_start = df_dustiq['date'].min()
date_end = df_dustiq['date'].max()
print(f"  Date range: {date_start.date()} to {date_end.date()}")

# =============================================================================
# STEP 2: Fetch Enhanced Weather from Open-Meteo
# =============================================================================
print("\n🌐 Fetching enhanced weather data from Open-Meteo...")

def fetch_openmeteo_archive(lat, lon, start_date, end_date):
    """Fetch historical weather from Open-Meteo Archive API."""

    url = "https://archive-api.open-meteo.com/v1/archive"

    weather_data = []

    # Split into yearly chunks to avoid hitting API limits
    current = pd.to_datetime(start_date)
    end = pd.to_datetime(end_date)

    while current < end:
        chunk_end = min(current + pd.DateOffset(days=365), end)

        params = {
            'latitude': lat,
            'longitude': lon,
            'start_date': current.strftime('%Y-%m-%d'),
            'end_date': chunk_end.strftime('%Y-%m-%d'),
            'daily': [
                'temperature_2m_mean',
                'temperature_2m_max',
                'temperature_2m_min',
                'relative_humidity_2m_mean',
                'dewpoint_2m_mean',
                'windspeed_10m_mean',
                'windspeed_10m_max',
                'winddirection_10m_dominant',
                'shortwave_radiation_sum',
                'precipitation_sum',
                'pressure_msl_mean'
            ],
            'timezone': 'UTC'
        }

        print(f"  Fetching {current.date()} to {chunk_end.date()}...", end=" ")

        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            if 'daily' in data:
                df_chunk = pd.DataFrame(data['daily'])
                df_chunk['time'] = pd.to_datetime(df_chunk['time'])
                weather_data.append(df_chunk)
                print(f"✅ {len(df_chunk)} days")
            else:
                print("⚠️ No data")

            sleep(1)  # Rate limiting

        except Exception as e:
            print(f"❌ Error: {e}")

        current = chunk_end

    if weather_data:
        df_weather = pd.concat(weather_data, ignore_index=True)
        df_weather = df_weather.rename(columns={'time': 'date'})
        return df_weather
    else:
        return None

# Check if already cached
cache_file = OUTPUT_DIR / 'openmeteo_weather_cache.parquet'
if cache_file.exists():
    print("  📦 Loading from cache...")
    df_weather = pd.read_parquet(cache_file)
else:
    df_weather = fetch_openmeteo_archive(LATITUDE, LONGITUDE, date_start, date_end)
    if df_weather is not None:
        df_weather.to_parquet(cache_file)
        print(f"  💾 Cached {len(df_weather)} days")

print(f"  ✅ Weather data: {len(df_weather)} days")

# =============================================================================
# STEP 3: Merge All Data and Calculate Baseline Features
# =============================================================================
print("\n🔧 Merging data and creating features...")

# Merge all data
df = df_dustiq[['date', 'sr']].copy()
df = df.merge(df_rain[['date', 'precipitation_mm']], on='date', how='left')

# Get AOD column
aod_cols = [c for c in df_aod.columns if 'aod' in c.lower() and c != 'date']
if aod_cols:
    aod_col = aod_cols[0]
    df = df.merge(df_aod[['date', aod_col]], on='date', how='left')
    df = df.rename(columns={aod_col: 'aod'})

# Merge weather
df = df.merge(df_weather, on='date', how='left')

# Fill missing
df['precipitation_mm'] = df['precipitation_mm'].fillna(0)
df['aod'] = df['aod'].fillna(df['aod'].median())

# Rename weather columns for clarity
weather_cols = {
    'temperature_2m_mean': 'temp_mean',
    'temperature_2m_max': 'temp_max',
    'temperature_2m_min': 'temp_min',
    'relative_humidity_2m_mean': 'humidity',
    'dewpoint_2m_mean': 'dewpoint',
    'windspeed_10m_mean': 'wind_speed',
    'windspeed_10m_max': 'wind_max',
    'winddirection_10m_dominant': 'wind_dir',
    'shortwave_radiation_sum': 'ghi_sum',
    'precipitation_sum': 'rain_openmeteo',
    'pressure_msl_mean': 'pressure'
}
df = df.rename(columns=weather_cols)

# Fill weather missing values
for col in weather_cols.values():
    if col in df.columns:
        df[col] = df[col].fillna(df[col].median())

print(f"  Merged dataset: {len(df)} days")

# =============================================================================
# STEP 4: Create BASELINE Features (original model)
# =============================================================================
print("\n📊 Creating BASELINE features...")

# Temporal
df['day_of_year'] = df['date'].dt.dayofyear
df['month'] = df['date'].dt.month
df['season'] = df['month'].map({12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1,
                                 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3})

# Rolling features (existing)
for window in [3, 7, 14, 21]:
    df[f'rain_{window}d'] = df['precipitation_mm'].rolling(window, min_periods=1).sum()
    df[f'aod_{window}d'] = df['aod'].rolling(window, min_periods=1).mean()

# Days since rain
df['days_no_rain'] = (df['precipitation_mm'] < 0.5).groupby(
    (df['precipitation_mm'] >= 0.5).cumsum()
).cumcount()

BASELINE_FEATURES = [
    'precipitation_mm', 'aod', 'day_of_year', 'month', 'season',
    'rain_3d', 'rain_7d', 'rain_14d', 'rain_21d',
    'aod_3d', 'aod_7d', 'aod_14d', 'aod_21d',
    'days_no_rain'
]
BASELINE_FEATURES = [f for f in BASELINE_FEATURES if f in df.columns]

print(f"  Baseline features: {len(BASELINE_FEATURES)}")

# =============================================================================
# STEP 5: Create ENHANCED Features
# =============================================================================
print("\n✨ Creating ENHANCED features...")

# Wind features
if 'wind_speed' in df.columns:
    df['wind_power'] = df['wind_speed'] ** 3  # Wind power law for erosion
    df['wind_max_ratio'] = df['wind_max'] / (df['wind_speed'] + 0.1)  # Gustiness
    df['high_wind_days_7d'] = (df['wind_speed'] > 5).rolling(7, min_periods=1).sum()

    # Wind direction bins (for Spain: S/SE winds from Sahara)
    df['wind_from_south'] = ((df['wind_dir'] >= 135) & (df['wind_dir'] <= 225)).astype(int)
    df['wind_from_sahara'] = ((df['wind_dir'] >= 90) & (df['wind_dir'] <= 180)).astype(int)

# Humidity & dew features
if 'humidity' in df.columns:
    df['humidity_aod'] = df['humidity'] * df['aod']  # Hygroscopic growth
    df['humidity_high'] = (df['humidity'] > 70).astype(int)

    # Dew point depression (temp - dewpoint)
    if 'dewpoint' in df.columns:
        df['dew_depression'] = df['temp_mean'] - df['dewpoint']
        df['dew_likely'] = (df['dew_depression'] < 2).astype(int)  # Dew formation

# Temperature features
if 'temp_mean' in df.columns:
    df['temp_range'] = df['temp_max'] - df['temp_min']  # Thermal cycling

    # Estimate panel temperature from ambient + solar radiation
    if 'ghi_sum' in df.columns:
        # Convert GHI sum (Wh/m²) to average (W/m²), assume 10h day
        df['ghi_avg'] = df['ghi_sum'] / 10
        # Panel temp boost: roughly +0.03°C per W/m² above ambient
        df['panel_temp_est'] = df['temp_mean'] + (df['ghi_avg'] / 800) * 25
        df['panel_hot'] = (df['panel_temp_est'] > 50).astype(int)

# Solar radiation features
if 'ghi_sum' in df.columns:
    df['ghi_rolling_7d'] = df['ghi_sum'].rolling(7, min_periods=1).mean()
    df['clear_sky_ratio'] = df['ghi_sum'] / (df['ghi_rolling_7d'] + 1)  # Indicates dust

# Enhanced AOD features
df['aod_change'] = df['aod'].diff()
df['aod_spike'] = ((df['aod'] > 0.3) & (df['aod_change'] > 0.1)).astype(int)
df['aod_persistence'] = (df['aod'] > 0.2).rolling(7, min_periods=1).sum()

# Rain microstructure
df['heavy_rain'] = (df['precipitation_mm'] > 5).astype(int)
df['heavy_rain_7d'] = df['heavy_rain'].rolling(7, min_periods=1).sum()
df['rain_after_dust'] = df['precipitation_mm'] * df['aod'].shift(1)

# Interaction terms
df['wind_aod'] = df['wind_speed'] * df['aod'] if 'wind_speed' in df.columns else 0
df['wind_no_rain'] = df['wind_speed'] * df['days_no_rain'] if 'wind_speed' in df.columns else 0

ENHANCED_FEATURES = BASELINE_FEATURES + [
    # Wind
    'wind_speed', 'wind_power', 'wind_max', 'wind_max_ratio',
    'high_wind_days_7d', 'wind_from_south', 'wind_from_sahara',
    # Humidity/Dew
    'humidity', 'humidity_aod', 'humidity_high',
    'dewpoint', 'dew_depression', 'dew_likely',
    # Temperature
    'temp_mean', 'temp_max', 'temp_min', 'temp_range',
    'panel_temp_est', 'panel_hot',
    # Solar
    'ghi_sum', 'ghi_avg', 'ghi_rolling_7d', 'clear_sky_ratio',
    # Enhanced AOD
    'aod_change', 'aod_spike', 'aod_persistence',
    # Rain microstructure
    'heavy_rain', 'heavy_rain_7d', 'rain_after_dust',
    # Interactions
    'wind_aod', 'wind_no_rain',
    # Atmospheric
    'pressure'
]

# Keep only features that exist
ENHANCED_FEATURES = [f for f in ENHANCED_FEATURES if f in df.columns]

# Fill any remaining NaN
for col in ENHANCED_FEATURES:
    df[col] = df[col].fillna(df[col].median() if df[col].dtype in ['float64', 'int64'] else 0)

print(f"  Enhanced features: {len(ENHANCED_FEATURES)} (added {len(ENHANCED_FEATURES) - len(BASELINE_FEATURES)})")

# =============================================================================
# STEP 6: Train/Test Split
# =============================================================================
print("\n📊 Splitting train/test...")

# Use last year for testing
test_start = df['date'].max() - pd.Timedelta(days=365)
df_train = df[df['date'] < test_start].copy()
df_test = df[df['date'] >= test_start].copy()

print(f"  Train: {len(df_train)} days ({df_train['date'].min().date()} to {df_train['date'].max().date()})")
print(f"  Test: {len(df_test)} days ({df_test['date'].min().date()} to {df_test['date'].max().date()})")

# =============================================================================
# STEP 7: Train BASELINE Model
# =============================================================================
print("\n🚀 Training BASELINE model...")

X_train_base = df_train[BASELINE_FEATURES].fillna(0)
y_train = df_train['sr'].dropna()
X_train_base = X_train_base.loc[y_train.index]

model_baseline = CatBoostRegressor(
    iterations=1500,
    learning_rate=0.03,
    depth=6,
    l2_leaf_reg=5.0,
    loss_function='MAE',
    random_seed=42,
    verbose=False
)

model_baseline.fit(X_train_base, y_train)
print(f"  ✅ Trained on {len(X_train_base)} samples")

# =============================================================================
# STEP 8: Train ENHANCED Model
# =============================================================================
print("\n✨ Training ENHANCED model...")

X_train_enh = df_train[ENHANCED_FEATURES].fillna(0)
X_train_enh = X_train_enh.loc[y_train.index]

model_enhanced = CatBoostRegressor(
    iterations=1500,
    learning_rate=0.03,
    depth=6,
    l2_leaf_reg=5.0,
    loss_function='MAE',
    random_seed=42,
    verbose=False
)

model_enhanced.fit(X_train_enh, y_train)
print(f"  ✅ Trained on {len(X_train_enh)} samples")

# =============================================================================
# STEP 9: Evaluate Both Models at Multiple Horizons
# =============================================================================
print("\n" + "=" * 80)
print("COMPARISON: BASELINE vs ENHANCED")
print("=" * 80)

def evaluate_model(df_data, model, features, horizons=[1, 7, 14, 21, 28]):
    """Evaluate model at multiple forecast horizons."""
    results = []

    test_start_idx = len(df_data) - 365

    for horizon in horizons:
        actuals = []
        predictions = []

        for i in range(test_start_idx, len(df_data)):
            forecast_idx = i - horizon

            if forecast_idx < 30:
                continue

            # Get features from forecast date
            X = df_data.iloc[forecast_idx:forecast_idx+1][features].fillna(0)

            # Get actual SR at target date
            actual = df_data.iloc[i]['sr']

            if pd.isna(actual):
                continue

            # Predict
            pred = model.predict(X)[0]

            actuals.append(actual)
            predictions.append(pred)

        if len(actuals) < 10:
            continue

        actuals = np.array(actuals)
        predictions = np.array(predictions)

        mae = mean_absolute_error(actuals, predictions)
        rmse = np.sqrt(np.mean((predictions - actuals) ** 2))
        r2 = r2_score(actuals, predictions)
        corr = np.corrcoef(actuals, predictions)[0, 1] if len(actuals) > 2 else 0

        results.append({
            'horizon_days': horizon,
            'n_samples': len(actuals),
            'mae': mae,
            'rmse': rmse,
            'r2': r2,
            'correlation': corr
        })

    return pd.DataFrame(results)

# Evaluate both models
print("\n📈 Evaluating BASELINE model...")
results_baseline = evaluate_model(df, model_baseline, BASELINE_FEATURES)
results_baseline['model'] = 'Baseline'

print("\n📈 Evaluating ENHANCED model...")
results_enhanced = evaluate_model(df, model_enhanced, ENHANCED_FEATURES)
results_enhanced['model'] = 'Enhanced'

# Combine results
df_results = pd.concat([results_baseline, results_enhanced], ignore_index=True)

# =============================================================================
# STEP 10: Display Comparison
# =============================================================================
print("\n" + "=" * 80)
print("RESULTS COMPARISON")
print("=" * 80)

print("\n📊 Soiling Ratio Forecast Accuracy")
print("-" * 100)
print(f"{'Horizon':<10} {'Model':<12} {'MAE (%)':<15} {'RMSE (%)':<15} {'R²':<10} {'Corr':<10} {'N':<8}")
print("-" * 100)

for horizon in [1, 7, 14, 21, 28]:
    base_row = results_baseline[results_baseline['horizon_days'] == horizon]
    enh_row = results_enhanced[results_enhanced['horizon_days'] == horizon]

    if len(base_row) > 0:
        b = base_row.iloc[0]
        print(f"{horizon}d{'':<6} {'Baseline':<12} {b['mae']*100:<15.3f} {b['rmse']*100:<15.3f} {b['r2']:<10.3f} {b['correlation']:<10.3f} {b['n_samples']:<8}")

    if len(enh_row) > 0:
        e = enh_row.iloc[0]
        print(f"{'':<10} {'Enhanced':<12} {e['mae']*100:<15.3f} {e['rmse']*100:<15.3f} {e['r2']:<10.3f} {e['correlation']:<10.3f} {e['n_samples']:<8}")

        # Calculate improvement
        if len(base_row) > 0:
            mae_improve = ((b['mae'] - e['mae']) / b['mae']) * 100
            r2_improve = e['r2'] - b['r2']
            print(f"{'':<10} {'→ Improve':<12} {mae_improve:+.1f}%{'':<9} {'':<15} {r2_improve:+.3f}{'':<5}")

    print("-" * 100)

# Summary statistics
print("\n🎯 SUMMARY STATISTICS")
print("-" * 70)

for model_name in ['Baseline', 'Enhanced']:
    model_data = df_results[df_results['model'] == model_name]

    # Focus on 7-14 day horizons (sweet spot)
    sweet_spot = model_data[model_data['horizon_days'].isin([7, 14])]

    if len(sweet_spot) > 0:
        avg_mae = sweet_spot['mae'].mean() * 100
        avg_r2 = sweet_spot['r2'].mean()
        avg_corr = sweet_spot['correlation'].mean()

        print(f"{model_name:12}: MAE={avg_mae:.3f}%, R²={avg_r2:.3f}, Corr={avg_corr:.3f} (7-14d avg)")

# Calculate overall improvement
base_sweet = results_baseline[results_baseline['horizon_days'].isin([7, 14])]
enh_sweet = results_enhanced[results_enhanced['horizon_days'].isin([7, 14])]

if len(base_sweet) > 0 and len(enh_sweet) > 0:
    mae_improve = ((base_sweet['mae'].mean() - enh_sweet['mae'].mean()) / base_sweet['mae'].mean()) * 100
    r2_improve = enh_sweet['r2'].mean() - base_sweet['r2'].mean()

    print(f"\n{'Overall (7-14d):':12} MAE {mae_improve:+.1f}%, R² {r2_improve:+.3f}")

# =============================================================================
# STEP 11: Feature Importance Comparison
# =============================================================================
print("\n" + "=" * 80)
print("FEATURE IMPORTANCE")
print("=" * 80)

print("\n📊 Top 15 Features in ENHANCED Model:")
print("-" * 50)

feat_imp_enh = pd.DataFrame({
    'feature': ENHANCED_FEATURES,
    'importance': model_enhanced.feature_importances_
}).sort_values('importance', ascending=False)

print(feat_imp_enh.head(15).to_string(index=False))

# Identify new features in top 15
new_features = set(ENHANCED_FEATURES) - set(BASELINE_FEATURES)
top_new_features = feat_imp_enh[feat_imp_enh['feature'].isin(new_features)].head(10)

print("\n✨ Top NEW Features:")
print("-" * 50)
print(top_new_features.to_string(index=False))

# =============================================================================
# STEP 12: Save Results
# =============================================================================
print("\n" + "=" * 80)
print("SAVING RESULTS")
print("=" * 80)

# Save comparison results
df_results.to_csv(OUTPUT_DIR / 'baseline_vs_enhanced_results.csv', index=False)

# Save feature importances
feat_imp_enh.to_csv(OUTPUT_DIR / 'enhanced_feature_importances.csv', index=False)

# Save models
import pickle
with open(OUTPUT_DIR / 'model_baseline.pkl', 'wb') as f:
    pickle.dump(model_baseline, f)
with open(OUTPUT_DIR / 'model_enhanced.pkl', 'wb') as f:
    pickle.dump(model_enhanced, f)

# Save summary report
summary = {
    'timestamp': datetime.now().isoformat(),
    'baseline': {
        'n_features': len(BASELINE_FEATURES),
        'features': BASELINE_FEATURES
    },
    'enhanced': {
        'n_features': len(ENHANCED_FEATURES),
        'features': ENHANCED_FEATURES,
        'new_features': list(new_features)
    },
    'results': df_results.to_dict('records')
}

with open(OUTPUT_DIR / 'comparison_summary.json', 'w') as f:
    json.dump(summary, f, indent=2, default=str)

print(f"\n✅ Results saved to: {OUTPUT_DIR}/")
print(f"   - baseline_vs_enhanced_results.csv")
print(f"   - enhanced_feature_importances.csv")
print(f"   - model_baseline.pkl, model_enhanced.pkl")
print(f"   - comparison_summary.json")

print("\n" + "=" * 80)
print("✅ ENHANCED FORECAST COMPARISON COMPLETE")
print("=" * 80)
