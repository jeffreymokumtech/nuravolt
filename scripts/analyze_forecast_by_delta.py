"""
Analyze soiling forecast accuracy by magnitude of change from t=0.

Re-loads data and re-evaluates the baseline model for detailed analysis.
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json
import pickle

print("="*80)
print("FORECAST ACCURACY BY CHANGE MAGNITUDE")
print("="*80)
print()

# Load the baseline model
results_dir = Path("outputs_enhanced_forecast")
model_file = results_dir / "model_baseline.pkl"

with open(model_file, 'rb') as f:
    model = pickle.load(f)

print(f"✅ Loaded baseline model")
print()

# Re-load the data that was used for training
print("📂 Loading data...")

# Load DustIQ
with open("public/data/soiling/ribera/dustiq_history.json", 'r') as f:
    dustiq_data = json.load(f)
df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])
df_dustiq = df_dustiq.rename(columns={'sr_dustiq': 'sr'})

# Load rain
with open("public/data/soiling/ribera/rain_history.json", 'r') as f:
    rain_data = json.load(f)
df_rain = pd.DataFrame(rain_data['daily_data'])
df_rain['date'] = pd.to_datetime(df_rain['date'])

# Load AOD
with open("public/data/soiling/ribera/aod_merged.json", 'r') as f:
    aod_data = json.load(f)
df_aod = pd.DataFrame(aod_data['daily_data'])
df_aod['date'] = pd.to_datetime(df_aod['date'])
if 'aod' in df_aod.columns:
    df_aod = df_aod.rename(columns={'aod': 'aod_550'})
elif 'aod_550nm' in df_aod.columns:
    df_aod = df_aod.rename(columns={'aod_550nm': 'aod_550'})

# Merge
df = df_dustiq.merge(df_rain, on='date', how='left')
df = df.merge(df_aod, on='date', how='left')
df = df.sort_values('date').reset_index(drop=True)

# Create baseline features (matching the training)
df['days_no_rain'] = 0
last_rain_idx = -999
for idx in range(len(df)):
    if df.loc[idx, 'precipitation_mm'] > 0.1:
        last_rain_idx = idx
    df.loc[idx, 'days_no_rain'] = idx - last_rain_idx

# Rolling features
df['rain_3d'] = df['precipitation_mm'].rolling(3, min_periods=1).sum()
df['rain_7d'] = df['precipitation_mm'].rolling(7, min_periods=1).sum()
df['rain_14d'] = df['precipitation_mm'].rolling(14, min_periods=1).sum()
df['rain_21d'] = df['precipitation_mm'].rolling(21, min_periods=1).sum()

df['aod_3d'] = df['aod_550'].rolling(3, min_periods=1).mean()
df['aod_7d'] = df['aod_550'].rolling(7, min_periods=1).mean()
df['aod_14d'] = df['aod_550'].rolling(14, min_periods=1).mean()
df['aod_21d'] = df['aod_550'].rolling(21, min_periods=1).mean()

# Temporal features
df['day_of_year'] = df['date'].dt.dayofyear
df['month'] = df['date'].dt.month
df['season'] = (df['month'] % 12 + 3) // 3

# Seasonal averages
seasonal_aod = df.groupby('season')['aod_550'].transform('mean')
seasonal_rain = df.groupby('season')['precipitation_mm'].transform('mean')
df['seasonal_aod'] = seasonal_aod
df['seasonal_rain'] = seasonal_rain

BASELINE_FEATURES = [
    'precipitation_mm', 'aod_550',
    'days_no_rain', 'rain_3d', 'rain_7d', 'rain_14d', 'rain_21d',
    'aod_3d', 'aod_7d', 'aod_14d', 'aod_21d',
    'day_of_year', 'month', 'season', 'seasonal_aod', 'seasonal_rain'
]

# Filter to test period
df_test = df[df['date'] >= '2024-12-14'].copy()
df_test = df_test.dropna(subset=BASELINE_FEATURES + ['sr'])

print(f"📊 Loaded {len(df_test)} test samples")
print(f"📅 Test period: {df_test['date'].min()} to {df_test['date'].max()}")
print()

print("🔮 Making predictions for different horizons...")
print()

# For each test sample, make predictions at different horizons
horizons = [1, 7, 14, 21, 28]
all_predictions = []

for idx, row in df_test.iterrows():
    t0_date = row['date']
    sr_t0 = row['sr']

    for horizon in horizons:
        target_date = t0_date + pd.Timedelta(days=horizon)

        # Find the actual SR at target date
        future_row = df_test[df_test['date'] == target_date]

        if len(future_row) == 0:
            continue

        sr_actual = future_row['sr'].values[0]

        # Make prediction using features at t0
        X_pred = row[BASELINE_FEATURES].values.reshape(1, -1)
        sr_pred = model.predict(X_pred)[0]

        all_predictions.append({
            'date_t0': t0_date,
            'date_target': target_date,
            'horizon': horizon,
            'sr_t0': sr_t0,
            'sr_actual': sr_actual,
            'sr_pred': sr_pred,
            'sr_change': sr_actual - sr_t0,
            'forecast_error': sr_pred - sr_actual,
            'abs_error': abs(sr_pred - sr_actual)
        })

df_pred = pd.DataFrame(all_predictions)

print(f"✅ Generated {len(df_pred)} predictions across {len(horizons)} horizons")
print()

# Categorize by change magnitude
df_pred['change_magnitude'] = pd.cut(
    np.abs(df_pred['sr_change']),
    bins=[0, 0.01, 0.03, 0.05, 1.0],
    labels=['Stable (<1%)', 'Small (1-3%)', 'Medium (3-5%)', 'Large (>5%)']
)

# Categorize by direction
df_pred['change_direction'] = pd.cut(
    df_pred['sr_change'],
    bins=[-1.0, -0.01, 0.01, 1.0],
    labels=['Cleaning (+)', 'Stable', 'Soiling (-)']
)

print("="*80)
print("ACCURACY BY CHANGE MAGNITUDE")
print("="*80)
print()

summary_results = []

for horizon in horizons:
    df_h = df_pred[df_pred['horizon'] == horizon].copy()

    print(f"📈 Horizon: {horizon}-day forecast")
    print("-" * 80)

    for magnitude in ['Stable (<1%)', 'Small (1-3%)', 'Medium (3-5%)', 'Large (>5%)']:
        df_mag = df_h[df_h['change_magnitude'] == magnitude]

        if len(df_mag) == 0:
            continue

        mae = df_mag['abs_error'].mean() * 100  # Convert to percentage
        rmse = np.sqrt((df_mag['forecast_error']**2).mean()) * 100

        # R² calculation
        ss_res = (df_mag['forecast_error']**2).sum()
        ss_tot = ((df_mag['sr_actual'] - df_mag['sr_actual'].mean())**2).sum()
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else -999

        # Bias (positive = overpredict, negative = underpredict)
        bias = df_mag['forecast_error'].mean() * 100

        n = len(df_mag)
        pct = 100 * n / len(df_h)

        # Average change in this category
        avg_change = df_mag['sr_change'].mean() * 100

        print(f"  {magnitude:20s} | N={n:4d} ({pct:4.1f}%) | MAE={mae:5.2f}% | R²={r2:6.3f} | Bias={bias:+5.2f}% | Avg Δ={avg_change:+5.2f}%")

        summary_results.append({
            'horizon': horizon,
            'magnitude': magnitude,
            'n_samples': n,
            'pct_of_horizon': pct,
            'mae_pct': mae,
            'rmse_pct': rmse,
            'r2': r2,
            'bias_pct': bias,
            'avg_change_pct': avg_change
        })

    print()

print("="*80)
print("ACCURACY BY CHANGE DIRECTION")
print("="*80)
print()

for horizon in horizons:
    df_h = df_pred[df_pred['horizon'] == horizon].copy()

    print(f"📈 Horizon: {horizon}-day forecast")
    print("-" * 80)

    for direction in ['Cleaning (+)', 'Stable', 'Soiling (-)']:
        df_dir = df_h[df_h['change_direction'] == direction]

        if len(df_dir) == 0:
            continue

        mae = df_dir['abs_error'].mean() * 100
        bias = df_dir['forecast_error'].mean() * 100
        r2 = 1 - ((df_dir['forecast_error']**2).sum() /
                  ((df_dir['sr_actual'] - df_dir['sr_actual'].mean())**2).sum())

        n = len(df_dir)
        pct = 100 * n / len(df_h)

        avg_change = df_dir['sr_change'].mean() * 100

        print(f"  {direction:20s} | N={n:4d} ({pct:4.1f}%) | MAE={mae:5.2f}% | R²={r2:6.3f} | Bias={bias:+5.2f}% | Avg Δ={avg_change:+5.2f}%")

    print()

print("="*80)
print("KEY INSIGHTS")
print("="*80)
print()

# Calculate correlation between change magnitude and error
for horizon in [7, 14]:  # Focus on key horizons
    df_h = df_pred[df_pred['horizon'] == horizon].copy()

    corr_change_error = df_h['sr_change'].abs().corr(df_h['abs_error'])
    corr_change_bias = df_h['sr_change'].corr(df_h['forecast_error'])

    print(f"📊 {horizon}-day horizon:")
    print(f"  Correlation(|change|, error): {corr_change_error:+.3f}")
    if corr_change_error > 0.3:
        print(f"    ⚠️  STRONG: Errors increase significantly during large changes")
    elif corr_change_error > 0.1:
        print(f"    ⚡ MODERATE: Some degradation during large changes")
    else:
        print(f"    ✅ LOW: Model performs consistently regardless of change magnitude")

    print(f"  Correlation(change, bias): {corr_change_bias:+.3f}")
    if corr_change_bias < -0.2:
        print(f"    ⚠️  Model UNDERPREDICTS during soiling (misses dust events)")
    elif corr_change_bias > 0.2:
        print(f"    ⚠️  Model OVERPREDICTS during soiling")
    else:
        print(f"    ✅ Model is UNBIASED")
    print()

# Find worst-case scenarios
print("⚠️  WORST-CASE SCENARIOS:")
print("-" * 80)

for horizon in [7, 14]:
    df_h = df_pred[df_pred['horizon'] == horizon].copy()

    # Stable periods
    df_stable = df_h[df_h['change_magnitude'] == 'Stable (<1%)']
    mae_stable = df_stable['abs_error'].mean() * 100 if len(df_stable) > 0 else 0

    # Large changes
    df_large = df_h[df_h['change_magnitude'].isin(['Medium (3-5%)', 'Large (>5%)'])]
    mae_large = df_large['abs_error'].mean() * 100 if len(df_large) > 0 else 0

    if mae_stable > 0 and mae_large > 0:
        degradation = (mae_large / mae_stable - 1) * 100
        print(f"{horizon:2d}-day: MAE increases by {degradation:+5.1f}% during large changes ({mae_stable:.2f}% → {mae_large:.2f}%)")

print()

# Example worst predictions
print("💥 WORST PREDICTIONS (Top 10 errors at 7-day horizon):")
print("-" * 80)
df_7d = df_pred[df_pred['horizon'] == 7].nlargest(10, 'abs_error')
for _, row in df_7d.iterrows():
    print(f"  {row['date_t0'].strftime('%Y-%m-%d')}: SR {row['sr_t0']:.3f} → {row['sr_actual']:.3f} (Δ={row['sr_change']*100:+5.2f}%), "
          f"Pred {row['sr_pred']:.3f}, Error={row['abs_error']*100:5.2f}%")

print()

# Save detailed results
df_pred.to_csv(results_dir / "detailed_predictions_with_delta.csv", index=False)

summary_df = pd.DataFrame(summary_results)
summary_df.to_csv(results_dir / "accuracy_by_change_magnitude.csv", index=False)

# Create JSON summary
summary_json = {
    'analysis_type': 'forecast_accuracy_by_change_magnitude',
    'test_period': {
        'start': str(df_pred['date_t0'].min()),
        'end': str(df_pred['date_target'].max()),
        'n_predictions': len(df_pred)
    },
    'key_findings': {},
    'by_horizon': summary_df.to_dict('records')
}

# Add key metrics
for horizon in [7, 14]:
    df_h = df_pred[df_pred['horizon'] == horizon]

    stable_mae = summary_df[(summary_df['horizon']==horizon) &
                            (summary_df['magnitude']=='Stable (<1%)')]['mae_pct'].values
    large_mae = summary_df[(summary_df['horizon']==horizon) &
                           (summary_df['magnitude'].isin(['Medium (3-5%)', 'Large (>5%)']))]['mae_pct'].mean()

    summary_json['key_findings'][f'{horizon}d_stable_mae'] = float(stable_mae[0]) if len(stable_mae) > 0 else None
    summary_json['key_findings'][f'{horizon}d_large_mae'] = float(large_mae)

    corr = df_h['sr_change'].abs().corr(df_h['abs_error'])
    summary_json['key_findings'][f'{horizon}d_correlation_change_error'] = float(corr)

with open(results_dir / "accuracy_by_change_summary.json", 'w') as f:
    json.dump(summary_json, f, indent=2)

print("="*80)
print("✅ ANALYSIS COMPLETE")
print("="*80)
print()
print(f"📁 Results saved to: {results_dir}/")
print("   - detailed_predictions_with_delta.csv (all individual predictions)")
print("   - accuracy_by_change_magnitude.csv (summary by magnitude)")
print("   - accuracy_by_change_summary.json (key metrics)")
