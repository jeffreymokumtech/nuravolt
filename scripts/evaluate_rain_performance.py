"""
Evaluate how well the model predicts rain effects on soiling.

Rain has complex effects:
1. Heavy rain (>5mm) → Cleaning effect (SR increases)
2. Light rain + dust → Mud/cementing (SR decreases more)
3. No rain → Gradual dust accumulation (SR decreases slowly)

Questions to answer:
- Does model predict cleaning after rain?
- Does it capture rain-after-dust mud effect?
- How accurate are predictions 1-3 days after rain events?
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json
import pickle
from sklearn.metrics import mean_absolute_error

print("="*80)
print("EVALUATING RAIN EFFECT PREDICTIONS")
print("="*80)
print()

# ============================================================================
# LOAD DATA
# ============================================================================

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

print(f"✅ Loaded {len(df)} days of data")
print()

# ============================================================================
# CREATE FEATURES
# ============================================================================

print("🔧 Creating features...")

# Days since rain
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

# Event indicators
df['aod_spike'] = ((df['aod_550'] > 0.3) & (df['aod_550'] - df['aod_550'].shift(1) > 0.1)).astype(int)
df['aod_high'] = (df['aod_550'] > df['seasonal_aod'] * 1.5).astype(int)
df['aod_extreme'] = (df['aod_550'] > 0.4).astype(int)
df['aod_persistence'] = (df['aod_550'] > 0.2).rolling(7, min_periods=1).sum()
df['aod_std_7d'] = df['aod_550'].rolling(7, min_periods=3).std()
df['aod_range_7d'] = df['aod_550'].rolling(7, min_periods=1).max() - df['aod_550'].rolling(7, min_periods=1).min()

df['heavy_rain'] = (df['precipitation_mm'] > 5).astype(int)
df['no_rain_14d'] = (df['rain_14d'] < 1).astype(int)

# Risk scores
df['soiling_risk'] = (
    df['aod_high'] * 2 +
    df['aod_spike'] * 3 +
    df['days_no_rain'] / 30 +
    df['aod_persistence'] / 7
)

ALL_FEATURES = [
    'precipitation_mm', 'aod_550',
    'days_no_rain', 'rain_3d', 'rain_7d', 'rain_14d', 'rain_21d',
    'aod_3d', 'aod_7d', 'aod_14d', 'aod_21d',
    'day_of_year', 'month', 'season', 'seasonal_aod', 'seasonal_rain',
    'aod_spike', 'aod_high', 'aod_extreme', 'aod_persistence',
    'aod_std_7d', 'aod_range_7d',
    'heavy_rain', 'no_rain_14d', 'soiling_risk'
]

df = df.dropna(subset=ALL_FEATURES + ['sr'])
df = df.reset_index(drop=True)  # Reset index to 0-based sequential

print(f"✅ Total features: {len(ALL_FEATURES)}")
print()

# ============================================================================
# IDENTIFY RAIN EVENTS
# ============================================================================

print("🌧️  Identifying rain events and their effects...")
print()

# Categorize by rain intensity
df['rain_category'] = pd.cut(
    df['precipitation_mm'],
    bins=[0, 0.1, 2, 5, 100],
    labels=['No rain', 'Light (0.1-2mm)', 'Moderate (2-5mm)', 'Heavy (>5mm)'],
    include_lowest=True
)

# Detect SR increases (cleaning events)
df['sr_change_1d'] = df['sr'].diff(1)
df['is_cleaning'] = df['sr_change_1d'] > 0.01  # >1% increase

# Classify days by rain context
df['rain_context'] = 'Dry'
df.loc[df['precipitation_mm'] > 0.1, 'rain_context'] = 'Rain day'
df.loc[(df['precipitation_mm'] > 0.1) & (df['aod_550'] > 0.2), 'rain_context'] = 'Rain + Dust'
df.loc[(df['precipitation_mm'] == 0) & (df['rain_7d'] > 5), 'rain_context'] = 'Post-rain (1-7d)'

# Days since last rain event
df['days_since_heavy_rain'] = 999
last_heavy_rain = -999
for idx in range(len(df)):
    if df.loc[idx, 'precipitation_mm'] > 5:
        last_heavy_rain = idx
    df.loc[idx, 'days_since_heavy_rain'] = idx - last_heavy_rain

# Summary statistics
print("📊 Rain Event Statistics:")
print("-" * 80)
print(f"  Total days: {len(df)}")
print(f"  No rain: {(df['precipitation_mm'] == 0).sum()} ({(df['precipitation_mm'] == 0).sum()/len(df)*100:.1f}%)")
print(f"  Light rain (0.1-2mm): {((df['precipitation_mm'] > 0.1) & (df['precipitation_mm'] <= 2)).sum()} days")
print(f"  Moderate rain (2-5mm): {((df['precipitation_mm'] > 2) & (df['precipitation_mm'] <= 5)).sum()} days")
print(f"  Heavy rain (>5mm): {(df['precipitation_mm'] > 5).sum()} days")
print()
print(f"  Cleaning events (SR increase >1%): {df['is_cleaning'].sum()} days")
print(f"  Rain + high dust days: {((df['precipitation_mm'] > 0.1) & (df['aod_550'] > 0.2)).sum()} days")
print()

# ============================================================================
# LOAD MODEL AND MAKE PREDICTIONS
# ============================================================================

print("🔮 Loading model and making predictions...")

# Split
train_mask = df['date'] < '2024-12-14'
test_mask = df['date'] >= '2024-12-14'

df_train = df[train_mask].copy()
df_test = df[test_mask].copy()

X_train = df_train[ALL_FEATURES].values
y_train = df_train['sr'].values
X_test = df_test[ALL_FEATURES].values
y_test = df_test['sr'].values

# Train baseline model
from catboost import CatBoostRegressor

model = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model.fit(X_train, y_train)
y_pred_test = model.predict(X_test)

df_test['sr_pred'] = y_pred_test
df_test['error'] = np.abs(y_test - y_pred_test)
df_test['residual'] = y_test - y_pred_test  # Positive = underpredicted

print("✅ Model trained and predictions made")
print()

# ============================================================================
# EVALUATE BY RAIN CONTEXT
# ============================================================================

print("="*80)
print("PERFORMANCE BY RAIN CONTEXT")
print("="*80)
print()

contexts = ['Dry', 'Rain day', 'Rain + Dust', 'Post-rain (1-7d)']

for context in contexts:
    df_context = df_test[df_test['rain_context'] == context]

    if len(df_context) == 0:
        continue

    mae = df_context['error'].mean() * 100
    bias = df_context['residual'].mean() * 100
    n = len(df_context)
    pct = n / len(df_test) * 100

    print(f"📊 {context:25s}")
    print(f"   N = {n:3d} ({pct:4.1f}%),  MAE = {mae:.2f}%,  Bias = {bias:+.2f}%")

    # Show interpretation
    if 'Rain' in context and bias < -0.5:
        print(f"   ⚠️  Model OVERPREDICTS SR (expects more cleaning than occurs)")
    elif 'Rain' in context and bias > 0.5:
        print(f"   ⚠️  Model UNDERPREDICTS SR (misses cleaning effect)")

    print()

# ============================================================================
# EVALUATE CLEANING EVENT PREDICTION
# ============================================================================

print("="*80)
print("CLEANING EVENT PREDICTION")
print("="*80)
print()

# Find cleaning events in test set
df_cleaning = df_test[df_test['is_cleaning']].copy()

if len(df_cleaning) > 0:
    print(f"📈 Cleaning events in test set: {len(df_cleaning)}")
    print()

    # Did rain cause the cleaning?
    df_cleaning['rain_1d_ago'] = df_cleaning['precipitation_mm'].shift(1)
    df_cleaning['rain_caused'] = df_cleaning['precipitation_mm'] > 0.1

    rain_cleaned = df_cleaning['rain_caused'].sum()
    other_cleaned = (~df_cleaning['rain_caused']).sum()

    print(f"  Rain-caused cleaning: {rain_cleaned}")
    print(f"  Other cleaning: {other_cleaned}")
    print()

    # Model performance on cleaning events
    mae_cleaning = df_cleaning['error'].mean() * 100
    bias_cleaning = df_cleaning['residual'].mean() * 100

    print(f"  Model performance on cleaning events:")
    print(f"    MAE = {mae_cleaning:.2f}%")
    print(f"    Bias = {bias_cleaning:+.2f}%")

    if bias_cleaning > 1.0:
        print(f"    ⚠️  Model significantly UNDERPREDICTS SR during cleaning")
        print(f"        (Predicts lower than actual - misses cleaning effect)")
    elif bias_cleaning < -1.0:
        print(f"    ⚠️  Model significantly OVERPREDICTS SR during cleaning")
        print(f"        (Predicts higher than actual - expects too much cleaning)")

    print()

    # Show worst cleaning predictions
    print("  💥 Worst cleaning event predictions:")
    worst_cleaning = df_cleaning.nlargest(5, 'error')[['date', 'precipitation_mm', 'sr', 'sr_pred', 'error', 'sr_change_1d']]
    for _, row in worst_cleaning.iterrows():
        print(f"    {row['date'].strftime('%Y-%m-%d')}: Rain={row['precipitation_mm']:.1f}mm, SR {row['sr']:.3f} (pred {row['sr_pred']:.3f}), Change={row['sr_change_1d']*100:+.1f}%, Error={row['error']*100:.1f}%")

else:
    print("⚠️  No cleaning events detected in test set")

print()

# ============================================================================
# EVALUATE POST-RAIN PERFORMANCE
# ============================================================================

print("="*80)
print("PERFORMANCE AFTER RAIN EVENTS")
print("="*80)
print()

# Group by days since heavy rain
df_test['days_since_heavy_bin'] = pd.cut(
    df_test['days_since_heavy_rain'],
    bins=[0, 1, 3, 7, 14, 999],
    labels=['0-1d after', '1-3d after', '3-7d after', '7-14d after', '>14d after'],
    include_lowest=True
)

print("📊 Performance by days since heavy rain (>5mm):")
print("-" * 80)

for period in ['0-1d after', '1-3d after', '3-7d after', '7-14d after', '>14d after']:
    df_period = df_test[df_test['days_since_heavy_bin'] == period]

    if len(df_period) == 0:
        continue

    mae = df_period['error'].mean() * 100
    bias = df_period['residual'].mean() * 100
    n = len(df_period)

    print(f"  {period:15s}: N={n:3d},  MAE = {mae:.2f}%,  Bias = {bias:+.2f}%")

print()

# ============================================================================
# RAIN + DUST INTERACTION
# ============================================================================

print("="*80)
print("RAIN + DUST INTERACTION (MUD EFFECT)")
print("="*80)
print()

# Find days with rain after high dust
df_test['rain_after_dust'] = (
    (df_test['precipitation_mm'] > 0.1) &
    (df_test['aod_550'].shift(1) > 0.2)
)

df_rain_dust = df_test[df_test['rain_after_dust']]

if len(df_rain_dust) > 0:
    print(f"📊 Rain-after-dust events: {len(df_rain_dust)}")
    print()

    # Did SR increase or decrease?
    sr_increased = (df_rain_dust['sr_change_1d'] > 0).sum()
    sr_decreased = (df_rain_dust['sr_change_1d'] < -0.01).sum()
    sr_stable = ((df_rain_dust['sr_change_1d'] >= -0.01) & (df_rain_dust['sr_change_1d'] <= 0)).sum()

    print(f"  SR increased (cleaned): {sr_increased} events")
    print(f"  SR decreased (mud?): {sr_decreased} events")
    print(f"  SR stable: {sr_stable} events")
    print()

    # Model performance
    mae_rain_dust = df_rain_dust['error'].mean() * 100
    bias_rain_dust = df_rain_dust['residual'].mean() * 100

    print(f"  Model performance on rain+dust:")
    print(f"    MAE = {mae_rain_dust:.2f}%")
    print(f"    Bias = {bias_rain_dust:+.2f}%")

    if bias_rain_dust > 0.5:
        print(f"    ⚠️  Model UNDERPREDICTS cleaning effect even with dust")
    elif bias_rain_dust < -0.5:
        print(f"    ℹ️  Model correctly expects reduced/no cleaning with dust")

    print()
else:
    print("⚠️  No rain-after-dust events in test set")
    print()

# ============================================================================
# FEATURE IMPORTANCE FOR RAIN
# ============================================================================

print("="*80)
print("RAIN FEATURE IMPORTANCE")
print("="*80)
print()

importances = model.get_feature_importance()
feature_imp = pd.DataFrame({
    'feature': ALL_FEATURES,
    'importance': importances
}).sort_values('importance', ascending=False)

rain_features = feature_imp[feature_imp['feature'].str.contains('rain|precipitation')]

print("📊 Rain-related feature importance:")
print("-" * 80)
for idx, row in rain_features.iterrows():
    print(f"  {row['feature']:25s}: {row['importance']:6.2f}%")

print()

total_rain_importance = rain_features['importance'].sum()
total_aod_importance = feature_imp[feature_imp['feature'].str.contains('aod')]['importance'].sum()

print(f"  Total rain importance: {total_rain_importance:.1f}%")
print(f"  Total AOD importance: {total_aod_importance:.1f}%")
print()

if total_rain_importance < 20:
    print("  ⚠️  Rain features have low importance (<20%)")
    print("      Model may not capture rain effects well")
elif total_rain_importance < total_aod_importance / 2:
    print("  ℹ️  Rain less important than dust (expected for Mediterranean climate)")
else:
    print("  ✅ Rain features have reasonable importance")

print()

# ============================================================================
# SAVE RESULTS
# ============================================================================

results_dir = Path("outputs_rain_evaluation")
results_dir.mkdir(exist_ok=True)

summary = {
    'rain_statistics': {
        'total_days': len(df),
        'no_rain_days': int((df['precipitation_mm'] == 0).sum()),
        'light_rain_days': int(((df['precipitation_mm'] > 0.1) & (df['precipitation_mm'] <= 2)).sum()),
        'moderate_rain_days': int(((df['precipitation_mm'] > 2) & (df['precipitation_mm'] <= 5)).sum()),
        'heavy_rain_days': int((df['precipitation_mm'] > 5).sum()),
        'cleaning_events': int(df['is_cleaning'].sum()),
        'rain_after_dust_events': int(((df['precipitation_mm'] > 0.1) & (df['aod_550'].shift(1) > 0.2)).sum())
    },
    'test_set_performance': {
        'overall_mae': float(df_test['error'].mean() * 100),
        'overall_bias': float(df_test['residual'].mean() * 100)
    },
    'rain_feature_importance': {
        'total_rain_importance': float(total_rain_importance),
        'total_aod_importance': float(total_aod_importance),
        'rain_features': rain_features.to_dict('records')
    }
}

with open(results_dir / "rain_evaluation_summary.json", 'w') as f:
    json.dump(summary, f, indent=2)

# Save detailed test predictions
df_test[['date', 'precipitation_mm', 'aod_550', 'sr', 'sr_pred', 'error', 'residual',
         'rain_category', 'rain_context', 'is_cleaning']].to_csv(
    results_dir / "test_predictions_with_rain.csv", index=False
)

print("="*80)
print("✅ RAIN EVALUATION COMPLETE")
print("="*80)
print()
print(f"📁 Results saved to: {results_dir}/")
print("   - rain_evaluation_summary.json")
print("   - test_predictions_with_rain.csv")
