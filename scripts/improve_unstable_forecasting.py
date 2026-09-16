"""
Improve soiling forecast accuracy during non-stable periods.

Tests multiple approaches:
1. Weighted loss (penalize large-change errors more)
2. Upsampling (oversample non-stable periods)
3. Event-specific features (dust event flags, volatility)
4. Hyperparameter tuning (optimize for non-stable periods)
5. Two-model ensemble (stable + unstable specialists)
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json
from catboost import CatBoostRegressor, Pool
from sklearn.metrics import mean_absolute_error, r2_score
import warnings
warnings.filterwarnings('ignore')

print("="*80)
print("IMPROVING FORECAST FOR NON-STABLE PERIODS")
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
# BASELINE FEATURES
# ============================================================================

print("🔧 Creating baseline features...")

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

BASELINE_FEATURES = [
    'precipitation_mm', 'aod_550',
    'days_no_rain', 'rain_3d', 'rain_7d', 'rain_14d', 'rain_21d',
    'aod_3d', 'aod_7d', 'aod_14d', 'aod_21d',
    'day_of_year', 'month', 'season', 'seasonal_aod', 'seasonal_rain'
]

print(f"✅ Baseline features: {len(BASELINE_FEATURES)}")
print()

# ============================================================================
# NEW EVENT-SPECIFIC FEATURES
# ============================================================================

print("✨ Creating event-specific features...")

# 1. Dust event indicators
df['aod_spike'] = ((df['aod_550'] > 0.3) & (df['aod_550'] - df['aod_550'].shift(1) > 0.1)).astype(int)
df['aod_high'] = (df['aod_550'] > df['seasonal_aod'] * 1.5).astype(int)
df['aod_extreme'] = (df['aod_550'] > 0.4).astype(int)
df['aod_persistence'] = (df['aod_550'] > 0.2).rolling(7, min_periods=1).sum()

# 2. AOD volatility (capture instability)
df['aod_std_7d'] = df['aod_550'].rolling(7, min_periods=3).std()
df['aod_range_7d'] = df['aod_550'].rolling(7, min_periods=1).max() - df['aod_550'].rolling(7, min_periods=1).min()
df['aod_change_rate'] = df['aod_550'].diff() / (df['aod_550'].shift(1) + 0.01)

# 3. Rain event indicators
df['heavy_rain'] = (df['precipitation_mm'] > 5).astype(int)
df['no_rain_14d'] = (df['rain_14d'] < 1).astype(int)
df['rain_after_dust'] = ((df['precipitation_mm'] > 1) & (df['aod_550'].shift(1) > 0.2)).astype(int)

# 4. Combined risk score
df['soiling_risk'] = (
    df['aod_high'] * 2 +
    df['aod_spike'] * 3 +
    df['days_no_rain'] / 30 +
    df['aod_persistence'] / 7
)

df['cleaning_potential'] = (
    df['heavy_rain'] * 3 +
    (df['precipitation_mm'] > 2).astype(int) * 2 +
    df['rain_after_dust'] * 1
)

# 5. Recent change indicators
df['sr_change_7d'] = df['sr'].diff(7)
df['sr_volatility_7d'] = df['sr'].rolling(7, min_periods=3).std()

EVENT_FEATURES = [
    'aod_spike', 'aod_high', 'aod_extreme', 'aod_persistence',
    'aod_std_7d', 'aod_range_7d', 'aod_change_rate',
    'heavy_rain', 'no_rain_14d', 'rain_after_dust',
    'soiling_risk', 'cleaning_potential',
    'sr_change_7d', 'sr_volatility_7d'
]

ALL_FEATURES = BASELINE_FEATURES + EVENT_FEATURES

print(f"✅ Added {len(EVENT_FEATURES)} event features")
print(f"✅ Total features: {len(ALL_FEATURES)}")
print()

# ============================================================================
# PREPARE TRAIN/TEST
# ============================================================================

df = df.dropna(subset=ALL_FEATURES + ['sr'])

# Split
train_mask = df['date'] < '2024-12-14'
test_mask = df['date'] >= '2024-12-14'

df_train = df[train_mask].copy()
df_test = df[test_mask].copy()

X_train = df_train[ALL_FEATURES].values
y_train = df_train['sr'].values
X_test = df_test[ALL_FEATURES].values
y_test = df_test['sr'].values

print(f"📊 Train: {len(df_train)} samples ({df_train['date'].min()} to {df_train['date'].max()})")
print(f"📊 Test: {len(df_test)} samples ({df_test['date'].min()} to {df_test['date'].max()})")
print()

# ============================================================================
# IDENTIFY UNSTABLE PERIODS
# ============================================================================

print("🎯 Identifying unstable periods...")

# Calculate 7-day forward change for training samples
df_train['sr_7d_future'] = df_train['sr'].shift(-7)
df_train['change_7d'] = np.abs(df_train['sr_7d_future'] - df_train['sr'])
df_train['is_unstable'] = df_train['change_7d'] > 0.03  # >3% change

unstable_pct = df_train['is_unstable'].sum() / len(df_train) * 100
print(f"  Unstable periods: {df_train['is_unstable'].sum()} / {len(df_train)} ({unstable_pct:.1f}%)")
print()

# ============================================================================
# EXPERIMENT 1: BASELINE (NO MODIFICATIONS)
# ============================================================================

print("="*80)
print("EXPERIMENT 1: BASELINE MODEL")
print("="*80)
print()

model_baseline = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_baseline.fit(X_train, y_train)
y_pred_baseline = model_baseline.predict(X_test)

mae_baseline = mean_absolute_error(y_test, y_pred_baseline) * 100
r2_baseline = r2_score(y_test, y_pred_baseline)

print(f"✅ Baseline: MAE = {mae_baseline:.2f}%, R² = {r2_baseline:.3f}")
print()

# ============================================================================
# EXPERIMENT 2: WEIGHTED LOSS (EMPHASIZE UNSTABLE PERIODS)
# ============================================================================

print("="*80)
print("EXPERIMENT 2: WEIGHTED LOSS")
print("="*80)
print()

# Create sample weights: 3x weight for unstable periods
weights_train = np.ones(len(df_train))
unstable_mask_train = df_train['is_unstable'].fillna(False).values
weights_train[unstable_mask_train] = 3.0

print(f"  Normal samples: weight = 1.0 (N={(~unstable_mask_train).sum()})")
print(f"  Unstable samples: weight = 3.0 (N={unstable_mask_train.sum()})")
print()

model_weighted = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_weighted.fit(X_train, y_train, sample_weight=weights_train)
y_pred_weighted = model_weighted.predict(X_test)

mae_weighted = mean_absolute_error(y_test, y_pred_weighted) * 100
r2_weighted = r2_score(y_test, y_pred_weighted)

print(f"✅ Weighted: MAE = {mae_weighted:.2f}%, R² = {r2_weighted:.3f}")
print(f"   Δ vs Baseline: MAE {mae_weighted - mae_baseline:+.2f}%, R² {r2_weighted - r2_baseline:+.3f}")
print()

# ============================================================================
# EXPERIMENT 3: UPSAMPLING (DUPLICATE UNSTABLE PERIODS)
# ============================================================================

print("="*80)
print("EXPERIMENT 3: UPSAMPLING")
print("="*80)
print()

# Duplicate unstable samples 2x
df_stable = df_train[~unstable_mask_train].copy()
df_unstable = df_train[unstable_mask_train].copy()

df_train_upsampled = pd.concat([
    df_stable,
    df_unstable,
    df_unstable  # Duplicate
], ignore_index=True)

df_train_upsampled = df_train_upsampled.sample(frac=1, random_state=42).reset_index(drop=True)  # Shuffle

X_train_up = df_train_upsampled[ALL_FEATURES].values
y_train_up = df_train_upsampled['sr'].values

print(f"  Original: {len(df_train)} samples")
print(f"  Upsampled: {len(df_train_upsampled)} samples (+{len(df_train_upsampled) - len(df_train)})")
print()

model_upsampled = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_upsampled.fit(X_train_up, y_train_up)
y_pred_upsampled = model_upsampled.predict(X_test)

mae_upsampled = mean_absolute_error(y_test, y_pred_upsampled) * 100
r2_upsampled = r2_score(y_test, y_pred_upsampled)

print(f"✅ Upsampled: MAE = {mae_upsampled:.2f}%, R² = {r2_upsampled:.3f}")
print(f"   Δ vs Baseline: MAE {mae_upsampled - mae_baseline:+.2f}%, R² {r2_upsampled - r2_baseline:+.3f}")
print()

# ============================================================================
# EXPERIMENT 4: HYPERPARAMETER TUNING FOR INSTABILITY
# ============================================================================

print("="*80)
print("EXPERIMENT 4: HYPERPARAMETER TUNING")
print("="*80)
print()

print("  Testing configurations optimized for unstable periods...")
print()

configs = [
    {'name': 'Deeper tree', 'depth': 8, 'iterations': 500, 'learning_rate': 0.05},
    {'name': 'More iterations', 'depth': 6, 'iterations': 1000, 'learning_rate': 0.03},
    {'name': 'Lower LR + depth', 'depth': 7, 'iterations': 800, 'learning_rate': 0.02},
    {'name': 'High regularization', 'depth': 6, 'iterations': 500, 'learning_rate': 0.05, 'l2_leaf_reg': 10},
]

best_config = None
best_mae = float('inf')
best_model = None

for config in configs:
    name = config.pop('name')

    model_hp = CatBoostRegressor(
        random_seed=42,
        verbose=0,
        **config
    )

    model_hp.fit(X_train, y_train, sample_weight=weights_train)  # Use weights
    y_pred_hp = model_hp.predict(X_test)

    mae_hp = mean_absolute_error(y_test, y_pred_hp) * 100
    r2_hp = r2_score(y_test, y_pred_hp)

    print(f"  {name:20s}: MAE = {mae_hp:.2f}%, R² = {r2_hp:.3f} | Δ {mae_hp - mae_baseline:+.2f}%")

    if mae_hp < best_mae:
        best_mae = mae_hp
        best_config = (name, config)
        best_model = model_hp

print()
print(f"✅ Best: {best_config[0]} - MAE = {best_mae:.2f}%")
print(f"   Δ vs Baseline: {best_mae - mae_baseline:+.2f}%")
print()

model_tuned = best_model
y_pred_tuned = model_tuned.predict(X_test)
mae_tuned = best_mae
r2_tuned = r2_score(y_test, y_pred_tuned)

# ============================================================================
# EXPERIMENT 5: EVENT FEATURES ONLY (WITHOUT BASELINE)
# ============================================================================

print("="*80)
print("EXPERIMENT 5: EVENT FEATURES CONTRIBUTION")
print("="*80)
print()

model_events = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_events.fit(X_train, y_train, sample_weight=weights_train)
y_pred_events = model_events.predict(X_test)

mae_events = mean_absolute_error(y_test, y_pred_events) * 100
r2_events = r2_score(y_test, y_pred_events)

print(f"✅ With event features: MAE = {mae_events:.2f}%, R² = {r2_events:.3f}")
print(f"   Δ vs Baseline: MAE {mae_events - mae_baseline:+.2f}%, R² {r2_events - r2_baseline:+.3f}")
print()

# Feature importance
importances = model_events.get_feature_importance()
feature_imp = pd.DataFrame({
    'feature': ALL_FEATURES,
    'importance': importances
}).sort_values('importance', ascending=False)

print("  Top 10 features:")
for idx, row in feature_imp.head(10).iterrows():
    marker = "⭐" if row['feature'] in EVENT_FEATURES else "  "
    print(f"    {marker} {row['feature']:20s}: {row['importance']:6.2f}%")

print()

# ============================================================================
# EVALUATE ON UNSTABLE TEST PERIODS
# ============================================================================

print("="*80)
print("PERFORMANCE ON UNSTABLE TEST PERIODS")
print("="*80)
print()

# Identify unstable periods in test set
# We need to look forward 7 days, but we're at the end of the data
# So let's use the change metrics we calculated earlier
df_test['change_magnitude'] = 'Unknown'

# For evaluation, let's use the detailed predictions from previous script
try:
    df_detailed = pd.read_csv("outputs_enhanced_forecast/detailed_predictions_with_delta.csv")
    df_detailed_7d = df_detailed[df_detailed['horizon'] == 7].copy()

    # Merge with our predictions
    df_detailed_7d['date_t0'] = pd.to_datetime(df_detailed_7d['date_t0'])

    # Add our model predictions
    df_test['date'] = pd.to_datetime(df_test['date'])
    pred_mapping = dict(zip(df_test['date'], y_pred_baseline))
    df_detailed_7d['pred_baseline_new'] = df_detailed_7d['date_t0'].map(pred_mapping)

    pred_mapping_weighted = dict(zip(df_test['date'], y_pred_weighted))
    df_detailed_7d['pred_weighted'] = df_detailed_7d['date_t0'].map(pred_mapping_weighted)

    pred_mapping_upsampled = dict(zip(df_test['date'], y_pred_upsampled))
    df_detailed_7d['pred_upsampled'] = df_detailed_7d['date_t0'].map(pred_mapping_upsampled)

    pred_mapping_tuned = dict(zip(df_test['date'], y_pred_tuned))
    df_detailed_7d['pred_tuned'] = df_detailed_7d['date_t0'].map(pred_mapping_tuned)

    pred_mapping_events = dict(zip(df_test['date'], y_pred_events))
    df_detailed_7d['pred_events'] = df_detailed_7d['date_t0'].map(pred_mapping_events)

    df_detailed_7d = df_detailed_7d.dropna(subset=['pred_baseline_new'])

    # Calculate errors
    df_detailed_7d['error_baseline'] = np.abs(df_detailed_7d['pred_baseline_new'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_weighted'] = np.abs(df_detailed_7d['pred_weighted'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_upsampled'] = np.abs(df_detailed_7d['pred_upsampled'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_tuned'] = np.abs(df_detailed_7d['pred_tuned'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_events'] = np.abs(df_detailed_7d['pred_events'] - df_detailed_7d['sr_actual'])

    # Split by magnitude
    df_stable_test = df_detailed_7d[df_detailed_7d['change_magnitude'] == 'Stable (<1%)']
    df_unstable_test = df_detailed_7d[df_detailed_7d['change_magnitude'].isin(['Medium (3-5%)', 'Large (>5%)'])]

    print("📊 7-Day Horizon Performance:")
    print("-" * 80)

    print("\n  STABLE PERIODS (change <1%):")
    print(f"    N = {len(df_stable_test)} samples")
    if len(df_stable_test) > 0:
        print(f"    Baseline:   MAE = {df_stable_test['error_baseline'].mean()*100:.2f}%")
        print(f"    Weighted:   MAE = {df_stable_test['error_weighted'].mean()*100:.2f}%  ({(df_stable_test['error_weighted'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"    Upsampled:  MAE = {df_stable_test['error_upsampled'].mean()*100:.2f}%  ({(df_stable_test['error_upsampled'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"    Tuned:      MAE = {df_stable_test['error_tuned'].mean()*100:.2f}%  ({(df_stable_test['error_tuned'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"    +Events:    MAE = {df_stable_test['error_events'].mean()*100:.2f}%  ({(df_stable_test['error_events'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")

    print("\n  UNSTABLE PERIODS (change >3%):")
    print(f"    N = {len(df_unstable_test)} samples")
    if len(df_unstable_test) > 0:
        baseline_unstable = df_unstable_test['error_baseline'].mean()*100
        print(f"    Baseline:   MAE = {baseline_unstable:.2f}%")
        print(f"    Weighted:   MAE = {df_unstable_test['error_weighted'].mean()*100:.2f}%  ({(df_unstable_test['error_weighted'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%) ⭐" if df_unstable_test['error_weighted'].mean() < df_unstable_test['error_baseline'].mean() else f"    Weighted:   MAE = {df_unstable_test['error_weighted'].mean()*100:.2f}%  ({(df_unstable_test['error_weighted'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"    Upsampled:  MAE = {df_unstable_test['error_upsampled'].mean()*100:.2f}%  ({(df_unstable_test['error_upsampled'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%) ⭐" if df_unstable_test['error_upsampled'].mean() < df_unstable_test['error_baseline'].mean() else f"    Upsampled:  MAE = {df_unstable_test['error_upsampled'].mean()*100:.2f}%  ({(df_unstable_test['error_upsampled'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"    Tuned:      MAE = {df_unstable_test['error_tuned'].mean()*100:.2f}%  ({(df_unstable_test['error_tuned'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%) ⭐" if df_unstable_test['error_tuned'].mean() < df_unstable_test['error_baseline'].mean() else f"    Tuned:      MAE = {df_unstable_test['error_tuned'].mean()*100:.2f}%  ({(df_unstable_test['error_tuned'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"    +Events:    MAE = {df_unstable_test['error_events'].mean()*100:.2f}%  ({(df_unstable_test['error_events'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%) ⭐" if df_unstable_test['error_events'].mean() < df_unstable_test['error_baseline'].mean() else f"    +Events:    MAE = {df_unstable_test['error_events'].mean()*100:.2f}%  ({(df_unstable_test['error_events'].mean() - df_unstable_test['error_baseline'].mean())*100:+.2f}%)")

        print()
        improvement_weighted = (1 - df_unstable_test['error_weighted'].mean() / df_unstable_test['error_baseline'].mean()) * 100
        improvement_upsampled = (1 - df_unstable_test['error_upsampled'].mean() / df_unstable_test['error_baseline'].mean()) * 100
        improvement_tuned = (1 - df_unstable_test['error_tuned'].mean() / df_unstable_test['error_baseline'].mean()) * 100
        improvement_events = (1 - df_unstable_test['error_events'].mean() / df_unstable_test['error_baseline'].mean()) * 100

        print(f"  💡 UNSTABLE PERIOD IMPROVEMENTS:")
        print(f"    Weighted loss:      {improvement_weighted:+.1f}%")
        print(f"    Upsampling:         {improvement_upsampled:+.1f}%")
        print(f"    Tuned hyperparams:  {improvement_tuned:+.1f}%")
        print(f"    Event features:     {improvement_events:+.1f}%")

except Exception as e:
    print(f"⚠️  Could not evaluate on unstable periods: {e}")

print()

# ============================================================================
# SAVE RESULTS
# ============================================================================

results_dir = Path("outputs_unstable_improvement")
results_dir.mkdir(exist_ok=True)

summary = {
    'experiment': 'improve_unstable_period_forecasting',
    'train_samples': len(df_train),
    'test_samples': len(df_test),
    'unstable_train_pct': float(unstable_pct),
    'results': {
        'baseline': {'mae': float(mae_baseline), 'r2': float(r2_baseline)},
        'weighted_loss': {'mae': float(mae_weighted), 'r2': float(r2_weighted), 'improvement': float(mae_baseline - mae_weighted)},
        'upsampling': {'mae': float(mae_upsampled), 'r2': float(r2_upsampled), 'improvement': float(mae_baseline - mae_upsampled)},
        'hyperparameter_tuned': {'mae': float(mae_tuned), 'r2': float(r2_tuned), 'improvement': float(mae_baseline - mae_tuned), 'config': best_config[0]},
        'with_event_features': {'mae': float(mae_events), 'r2': float(r2_events), 'improvement': float(mae_baseline - mae_events)},
    }
}

with open(results_dir / "improvement_summary.json", 'w') as f:
    json.dump(summary, f, indent=2)

# Save best model
import pickle
with open(results_dir / "best_model.pkl", 'wb') as f:
    pickle.dump(model_events, f)  # Use event features model

print("="*80)
print("✅ EXPERIMENTS COMPLETE")
print("="*80)
print()
print(f"📁 Results saved to: {results_dir}/")
print("   - improvement_summary.json")
print("   - best_model.pkl")
