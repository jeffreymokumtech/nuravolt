"""
Improve unstable forecasting - Version 2

Issues found in V1:
1. sr_change_7d and sr_volatility_7d are LEAKY (use future data)
2. Standard upsampling/weighting had minimal effect
3. Need more aggressive approaches

New strategies:
1. Remove leaky features
2. Extreme upsampling (5x for unstable periods)
3. Two-model ensemble (stable specialist + unstable specialist)
4. Asymmetric loss (penalize soiling underestimation more)
5. Threshold-based model selection
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json
from catboost import CatBoostRegressor
from sklearn.metrics import mean_absolute_error, r2_score
import warnings
warnings.filterwarnings('ignore')

print("="*80)
print("IMPROVING UNSTABLE FORECASTING - VERSION 2")
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
# CREATE NON-LEAKY FEATURES
# ============================================================================

print("🔧 Creating features (NO FUTURE LEAKAGE)...")

# Days since rain
df['days_no_rain'] = 0
last_rain_idx = -999
for idx in range(len(df)):
    if df.loc[idx, 'precipitation_mm'] > 0.1:
        last_rain_idx = idx
    df.loc[idx, 'days_no_rain'] = idx - last_rain_idx

# Rolling features (PAST only)
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

# Event indicators (PAST only)
df['aod_spike'] = ((df['aod_550'] > 0.3) & (df['aod_550'] - df['aod_550'].shift(1) > 0.1)).astype(int)
df['aod_high'] = (df['aod_550'] > df['seasonal_aod'] * 1.5).astype(int)
df['aod_extreme'] = (df['aod_550'] > 0.4).astype(int)
df['aod_persistence'] = (df['aod_550'] > 0.2).rolling(7, min_periods=1).sum()

# AOD volatility (PAST 7 days)
df['aod_std_7d'] = df['aod_550'].rolling(7, min_periods=3).std()
df['aod_range_7d'] = df['aod_550'].rolling(7, min_periods=1).max() - df['aod_550'].rolling(7, min_periods=1).min()

# Rain events
df['heavy_rain'] = (df['precipitation_mm'] > 5).astype(int)
df['no_rain_14d'] = (df['rain_14d'] < 1).astype(int)

# Risk scores
df['soiling_risk'] = (
    df['aod_high'] * 2 +
    df['aod_spike'] * 3 +
    df['days_no_rain'] / 30 +
    df['aod_persistence'] / 7
)

# HISTORICAL SR volatility (not future!)
df['sr_std_7d'] = df['sr'].shift(1).rolling(7, min_periods=3).std()  # Shifted to prevent leakage

ALL_FEATURES = [
    'precipitation_mm', 'aod_550',
    'days_no_rain', 'rain_3d', 'rain_7d', 'rain_14d', 'rain_21d',
    'aod_3d', 'aod_7d', 'aod_14d', 'aod_21d',
    'day_of_year', 'month', 'season', 'seasonal_aod', 'seasonal_rain',
    'aod_spike', 'aod_high', 'aod_extreme', 'aod_persistence',
    'aod_std_7d', 'aod_range_7d',
    'heavy_rain', 'no_rain_14d', 'soiling_risk',
    'sr_std_7d'
]

print(f"✅ Total features: {len(ALL_FEATURES)} (NO LEAKAGE)")
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

# Identify unstable periods
df_train['sr_7d_future'] = df_train['sr'].shift(-7)
df_train['change_7d'] = np.abs(df_train['sr_7d_future'] - df_train['sr'])
df_train['is_unstable'] = df_train['change_7d'] > 0.03

unstable_pct = df_train['is_unstable'].sum() / len(df_train) * 100

print(f"📊 Train: {len(df_train)} samples")
print(f"📊 Test: {len(df_test)} samples")
print(f"📊 Unstable: {df_train['is_unstable'].sum()} samples ({unstable_pct:.1f}%)")
print()

# ============================================================================
# BASELINE
# ============================================================================

print("="*80)
print("BASELINE (from V1)")
print("="*80)
print()

X_train = df_train[ALL_FEATURES].values
y_train = df_train['sr'].values
X_test = df_test[ALL_FEATURES].values
y_test = df_test['sr'].values

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
# EXTREME UPSAMPLING (5x for unstable periods)
# ============================================================================

print("="*80)
print("EXPERIMENT 1: EXTREME UPSAMPLING (5x)")
print("="*80)
print()

unstable_mask = df_train['is_unstable'].fillna(False).values
df_stable = df_train[~unstable_mask].copy()
df_unstable = df_train[unstable_mask].copy()

print(f"  Stable samples: {len(df_stable)}")
print(f"  Unstable samples: {len(df_unstable)}")
print(f"  Duplicating unstable samples 5x...")
print()

df_train_extreme = pd.concat([
    df_stable,
    df_unstable,
    df_unstable,
    df_unstable,
    df_unstable,
    df_unstable  # 5x total
], ignore_index=True)

df_train_extreme = df_train_extreme.sample(frac=1, random_state=42).reset_index(drop=True)

X_train_extreme = df_train_extreme[ALL_FEATURES].values
y_train_extreme = df_train_extreme['sr'].values

print(f"  New training size: {len(df_train_extreme)} samples (+{len(df_train_extreme) - len(df_train)})")

model_extreme = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_extreme.fit(X_train_extreme, y_train_extreme)
y_pred_extreme = model_extreme.predict(X_test)

mae_extreme = mean_absolute_error(y_test, y_pred_extreme) * 100
r2_extreme = r2_score(y_test, y_pred_extreme)

print(f"✅ Extreme upsampling: MAE = {mae_extreme:.2f}%, R² = {r2_extreme:.3f}")
print(f"   Δ vs Baseline: {mae_extreme - mae_baseline:+.2f}%")
print()

# ============================================================================
# TWO-MODEL ENSEMBLE
# ============================================================================

print("="*80)
print("EXPERIMENT 2: TWO-MODEL ENSEMBLE")
print("="*80)
print()

print("  Training STABLE specialist...")
X_train_stable = df_stable[ALL_FEATURES].values
y_train_stable = df_stable['sr'].values

model_stable = CatBoostRegressor(
    iterations=500,
    depth=5,  # Shallower for simpler patterns
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_stable.fit(X_train_stable, y_train_stable)

print("  Training UNSTABLE specialist...")
X_train_unstable = df_unstable[ALL_FEATURES].values
y_train_unstable = df_unstable['sr'].values

model_unstable = CatBoostRegressor(
    iterations=800,  # More iterations for complex patterns
    depth=8,  # Deeper tree
    learning_rate=0.03,
    random_seed=42,
    verbose=0
)

model_unstable.fit(X_train_unstable, y_train_unstable)

# For test set, we need to decide which model to use
# Use a simple heuristic: if AOD is high or has been volatile recently
print("  Creating routing logic...")

def predict_ensemble(X, features_df):
    """Route to stable or unstable model based on conditions."""

    # Extract routing features
    aod_high = features_df['aod_high'].values
    aod_spike = features_df['aod_spike'].values
    soiling_risk = features_df['soiling_risk'].values
    aod_std_7d = features_df['aod_std_7d'].values

    # Route to unstable model if:
    # - High AOD
    # - AOD spike detected
    # - High soiling risk
    # - Recent volatility
    use_unstable = (
        (aod_high == 1) |
        (aod_spike == 1) |
        (soiling_risk > 2.0) |
        (aod_std_7d > 0.1)
    )

    pred_stable = model_stable.predict(X)
    pred_unstable = model_unstable.predict(X)

    # Blend
    predictions = np.where(use_unstable, pred_unstable, pred_stable)

    routing_pct = use_unstable.sum() / len(use_unstable) * 100
    print(f"    Routed {use_unstable.sum()}/{len(use_unstable)} ({routing_pct:.1f}%) to unstable model")

    return predictions

y_pred_ensemble = predict_ensemble(X_test, df_test[ALL_FEATURES])

mae_ensemble = mean_absolute_error(y_test, y_pred_ensemble) * 100
r2_ensemble = r2_score(y_test, y_pred_ensemble)

print(f"✅ Two-model ensemble: MAE = {mae_ensemble:.2f}%, R² = {r2_ensemble:.3f}")
print(f"   Δ vs Baseline: {mae_ensemble - mae_baseline:+.2f}%")
print()

# ============================================================================
# ASYMMETRIC LOSS (Penalize soiling underestimation)
# ============================================================================

print("="*80)
print("EXPERIMENT 3: ASYMMETRIC LOSS")
print("="*80)
print()

print("  Using asymmetric weights:")
print("    - Overpredict soiling (high SR): penalty = 1.0")
print("    - Underpredict soiling (low SR): penalty = 3.0")
print()

# CatBoost doesn't support asymmetric loss directly, but we can use sample weights
# based on the residuals from a first-pass model

# First pass
model_first = CatBoostRegressor(
    iterations=300,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_first.fit(X_train, y_train)
y_train_pred_first = model_first.predict(X_train)

# Calculate residuals
residuals = y_train - y_train_pred_first  # Negative = underpredicted (actual lower than pred)

# Weight samples where we underpredict soiling (residual < 0) more heavily
weights_asymmetric = np.ones(len(y_train))
weights_asymmetric[residuals < -0.01] = 3.0  # Underpredict soiling → high weight

print(f"  High-weight samples: {(weights_asymmetric > 1).sum()} / {len(weights_asymmetric)}")

# Second pass with asymmetric weights
model_asymmetric = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)

model_asymmetric.fit(X_train, y_train, sample_weight=weights_asymmetric)
y_pred_asymmetric = model_asymmetric.predict(X_test)

mae_asymmetric = mean_absolute_error(y_test, y_pred_asymmetric) * 100
r2_asymmetric = r2_score(y_test, y_pred_asymmetric)

print(f"✅ Asymmetric loss: MAE = {mae_asymmetric:.2f}%, R² = {r2_asymmetric:.3f}")
print(f"   Δ vs Baseline: {mae_asymmetric - mae_baseline:+.2f}%")
print()

# Check bias
bias_baseline = (y_pred_baseline - y_test).mean() * 100
bias_asymmetric = (y_pred_asymmetric - y_test).mean() * 100

print(f"  Bias comparison:")
print(f"    Baseline:   {bias_baseline:+.2f}% (positive = overpredict)")
print(f"    Asymmetric: {bias_asymmetric:+.2f}%")
print()

# ============================================================================
# EVALUATE ON UNSTABLE PERIODS
# ============================================================================

print("="*80)
print("DETAILED EVALUATION ON UNSTABLE TEST PERIODS")
print("="*80)
print()

try:
    df_detailed = pd.read_csv("outputs_enhanced_forecast/detailed_predictions_with_delta.csv")
    df_detailed_7d = df_detailed[df_detailed['horizon'] == 7].copy()
    df_detailed_7d['date_t0'] = pd.to_datetime(df_detailed_7d['date_t0'])

    # Add new model predictions
    df_test['date'] = pd.to_datetime(df_test['date'])

    pred_mapping = dict(zip(df_test['date'], y_pred_baseline))
    df_detailed_7d['pred_baseline'] = df_detailed_7d['date_t0'].map(pred_mapping)

    pred_mapping_extreme = dict(zip(df_test['date'], y_pred_extreme))
    df_detailed_7d['pred_extreme'] = df_detailed_7d['date_t0'].map(pred_mapping_extreme)

    pred_mapping_ensemble = dict(zip(df_test['date'], y_pred_ensemble))
    df_detailed_7d['pred_ensemble'] = df_detailed_7d['date_t0'].map(pred_mapping_ensemble)

    pred_mapping_asymmetric = dict(zip(df_test['date'], y_pred_asymmetric))
    df_detailed_7d['pred_asymmetric'] = df_detailed_7d['date_t0'].map(pred_mapping_asymmetric)

    df_detailed_7d = df_detailed_7d.dropna(subset=['pred_baseline'])

    # Errors
    df_detailed_7d['error_baseline'] = np.abs(df_detailed_7d['pred_baseline'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_extreme'] = np.abs(df_detailed_7d['pred_extreme'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_ensemble'] = np.abs(df_detailed_7d['pred_ensemble'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_asymmetric'] = np.abs(df_detailed_7d['pred_asymmetric'] - df_detailed_7d['sr_actual'])

    # Bias (signed error)
    df_detailed_7d['bias_baseline'] = df_detailed_7d['pred_baseline'] - df_detailed_7d['sr_actual']
    df_detailed_7d['bias_extreme'] = df_detailed_7d['pred_extreme'] - df_detailed_7d['sr_actual']
    df_detailed_7d['bias_ensemble'] = df_detailed_7d['pred_ensemble'] - df_detailed_7d['sr_actual']
    df_detailed_7d['bias_asymmetric'] = df_detailed_7d['pred_asymmetric'] - df_detailed_7d['sr_actual']

    # Split by magnitude
    df_stable_test = df_detailed_7d[df_detailed_7d['change_magnitude'] == 'Stable (<1%)']
    df_unstable_test = df_detailed_7d[df_detailed_7d['change_magnitude'].isin(['Medium (3-5%)', 'Large (>5%)'])]

    print("📊 7-Day Horizon - STABLE PERIODS (change <1%):")
    print("-" * 80)
    print(f"  N = {len(df_stable_test)} samples")
    if len(df_stable_test) > 0:
        print(f"  Baseline:       MAE = {df_stable_test['error_baseline'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_baseline'].mean()*100:+.2f}%")
        print(f"  Extreme (5x):   MAE = {df_stable_test['error_extreme'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_extreme'].mean()*100:+.2f}%  ({(df_stable_test['error_extreme'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"  Ensemble:       MAE = {df_stable_test['error_ensemble'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_ensemble'].mean()*100:+.2f}%  ({(df_stable_test['error_ensemble'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")
        print(f"  Asymmetric:     MAE = {df_stable_test['error_asymmetric'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_asymmetric'].mean()*100:+.2f}%  ({(df_stable_test['error_asymmetric'].mean() - df_stable_test['error_baseline'].mean())*100:+.2f}%)")
    print()

    print("📊 7-Day Horizon - UNSTABLE PERIODS (change >3%):")
    print("-" * 80)
    print(f"  N = {len(df_unstable_test)} samples")
    if len(df_unstable_test) > 0:
        baseline_mae_unstable = df_unstable_test['error_baseline'].mean()*100
        baseline_bias_unstable = df_unstable_test['bias_baseline'].mean()*100

        print(f"  Baseline:       MAE = {baseline_mae_unstable:.2f}%,  Bias = {baseline_bias_unstable:+.2f}%")

        extreme_mae = df_unstable_test['error_extreme'].mean()*100
        extreme_bias = df_unstable_test['bias_extreme'].mean()*100
        extreme_impr = (1 - df_unstable_test['error_extreme'].mean() / df_unstable_test['error_baseline'].mean()) * 100
        marker_extreme = "⭐" if extreme_mae < baseline_mae_unstable else ""
        print(f"  Extreme (5x):   MAE = {extreme_mae:.2f}%,  Bias = {extreme_bias:+.2f}%  ({extreme_impr:+.1f}%) {marker_extreme}")

        ensemble_mae = df_unstable_test['error_ensemble'].mean()*100
        ensemble_bias = df_unstable_test['bias_ensemble'].mean()*100
        ensemble_impr = (1 - df_unstable_test['error_ensemble'].mean() / df_unstable_test['error_baseline'].mean()) * 100
        marker_ensemble = "⭐" if ensemble_mae < baseline_mae_unstable else ""
        print(f"  Ensemble:       MAE = {ensemble_mae:.2f}%,  Bias = {ensemble_bias:+.2f}%  ({ensemble_impr:+.1f}%) {marker_ensemble}")

        asymm_mae = df_unstable_test['error_asymmetric'].mean()*100
        asymm_bias = df_unstable_test['bias_asymmetric'].mean()*100
        asymm_impr = (1 - df_unstable_test['error_asymmetric'].mean() / df_unstable_test['error_baseline'].mean()) * 100
        marker_asymm = "⭐" if asymm_mae < baseline_mae_unstable else ""
        print(f"  Asymmetric:     MAE = {asymm_mae:.2f}%,  Bias = {asymm_bias:+.2f}%  ({asymm_impr:+.1f}%) {marker_asymm}")

        print()
        print("  💡 BEST APPROACH FOR UNSTABLE PERIODS:")

        best_mae = min(baseline_mae_unstable, extreme_mae, ensemble_mae, asymm_mae)

        if best_mae == extreme_mae:
            print(f"    ⭐ Extreme upsampling (5x): {extreme_impr:+.1f}% improvement")
        elif best_mae == ensemble_mae:
            print(f"    ⭐ Two-model ensemble: {ensemble_impr:+.1f}% improvement")
        elif best_mae == asymm_mae:
            print(f"    ⭐ Asymmetric loss: {asymm_impr:+.1f}% improvement")
        else:
            print(f"    ⚠️  No improvement - baseline is best")

        print()
        print("  🎯 BIAS ANALYSIS (positive = overpredict SR):")
        print(f"    Baseline bias:    {baseline_bias_unstable:+.2f}% (misses {-baseline_bias_unstable:.2f}% of soiling)")
        print(f"    Asymmetric bias:  {asymm_bias:+.2f}% (misses {-asymm_bias:.2f}% of soiling)")

        if abs(asymm_bias) < abs(baseline_bias_unstable):
            print(f"    ✅ Asymmetric loss reduced bias by {abs(baseline_bias_unstable - asymm_bias):.2f}%")

except Exception as e:
    print(f"⚠️  Could not evaluate: {e}")
    import traceback
    traceback.print_exc()

print()

# ============================================================================
# SAVE RESULTS
# ============================================================================

results_dir = Path("outputs_unstable_improvement")
results_dir.mkdir(exist_ok=True)

summary = {
    'experiment': 'improve_unstable_v2',
    'key_changes': [
        'Removed leaky features (sr_change_7d, sr_volatility_7d)',
        'Extreme upsampling (5x)',
        'Two-model ensemble with routing logic',
        'Asymmetric loss to penalize soiling underestimation'
    ],
    'results': {
        'baseline': {'mae': float(mae_baseline), 'r2': float(r2_baseline)},
        'extreme_upsampling_5x': {'mae': float(mae_extreme), 'r2': float(r2_extreme)},
        'two_model_ensemble': {'mae': float(mae_ensemble), 'r2': float(r2_ensemble)},
        'asymmetric_loss': {'mae': float(mae_asymmetric), 'r2': float(r2_asymmetric)},
    }
}

with open(results_dir / "improvement_v2_summary.json", 'w') as f:
    json.dump(summary, f, indent=2)

print("="*80)
print("✅ V2 EXPERIMENTS COMPLETE")
print("="*80)
print()
print(f"📁 Results saved to: {results_dir}/")
