"""
Final optimized soiling forecast model.

Combines best approaches from:
1. Two-model ensemble (11% improvement on unstable periods)
2. Bias correction (reduce systematic errors)
3. Quantile regression for conservative predictions

Final model: Ensemble of specialized models with bias correction
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json
from catboost import CatBoostRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.linear_model import Ridge
import warnings
warnings.filterwarnings('ignore')

print("="*80)
print("FINAL OPTIMIZED SOILING FORECAST MODEL")
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

# Identify unstable periods for training
df_train['sr_7d_future'] = df_train['sr'].shift(-7)
df_train['change_7d'] = np.abs(df_train['sr_7d_future'] - df_train['sr'])
df_train['is_unstable'] = df_train['change_7d'] > 0.03

unstable_mask = df_train['is_unstable'].fillna(False).values
df_stable = df_train[~unstable_mask].copy()
df_unstable = df_train[unstable_mask].copy()

print(f"📊 Train: {len(df_train)} samples")
print(f"   Stable: {len(df_stable)} samples ({len(df_stable)/len(df_train)*100:.1f}%)")
print(f"   Unstable: {len(df_unstable)} samples ({len(df_unstable)/len(df_train)*100:.1f}%)")
print(f"📊 Test: {len(df_test)} samples")
print()

# ============================================================================
# BUILD FINAL MODEL
# ============================================================================

print("="*80)
print("BUILDING FINAL OPTIMIZED MODEL")
print("="*80)
print()

print("Step 1: Train specialized models...")
print()

# Model 1: Stable specialist (conservative quantile regression)
print("  1a. Stable specialist (Q=0.55 for slight conservatism)...")
X_stable = df_stable[ALL_FEATURES].values
y_stable = df_stable['sr'].values

model_stable = CatBoostRegressor(
    iterations=500,
    depth=5,
    learning_rate=0.05,
    loss_function='Quantile:alpha=0.55',
    random_seed=42,
    verbose=0
)
model_stable.fit(X_stable, y_stable)
print("     ✅ Trained")

# Model 2: Unstable specialist (aggressive on dust events)
print("  1b. Unstable specialist (deeper tree, Q=0.60)...")
X_unstable = df_unstable[ALL_FEATURES].values
y_unstable = df_unstable['sr'].values

model_unstable = CatBoostRegressor(
    iterations=800,
    depth=8,
    learning_rate=0.03,
    loss_function='Quantile:alpha=0.60',
    random_seed=42,
    verbose=0
)
model_unstable.fit(X_unstable, y_unstable)
print("     ✅ Trained")

# Model 3: Overall model with weighted loss
print("  1c. Overall model (weighted for unstable periods)...")
X_train_all = df_train[ALL_FEATURES].values
y_train_all = df_train['sr'].values

weights = np.ones(len(df_train))
weights[unstable_mask] = 3.0

model_overall = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)
model_overall.fit(X_train_all, y_train_all, sample_weight=weights)
print("     ✅ Trained")
print()

# ============================================================================
# STEP 2: BIAS CORRECTION
# ============================================================================

print("Step 2: Train bias correction layer...")
print()

# Get predictions from all models on training set
pred_stable_train = model_stable.predict(X_train_all)
pred_unstable_train = model_unstable.predict(X_train_all)
pred_overall_train = model_overall.predict(X_train_all)

# Ensemble prediction
df_train['pred_stable'] = pred_stable_train
df_train['pred_unstable'] = pred_unstable_train
df_train['pred_overall'] = pred_overall_train

# Route to appropriate model
df_train['use_unstable'] = (
    (df_train['aod_high'] == 1) |
    (df_train['aod_spike'] == 1) |
    (df_train['soiling_risk'] > 2.0) |
    (df_train['aod_std_7d'] > 0.1)
).astype(int)

df_train['ensemble_pred'] = np.where(
    df_train['use_unstable'],
    0.7 * df_train['pred_unstable'] + 0.3 * df_train['pred_overall'],
    0.7 * df_train['pred_stable'] + 0.3 * df_train['pred_overall']
)

# Calculate residuals
df_train['residual'] = df_train['sr'] - df_train['ensemble_pred']

print(f"  Mean residual: {df_train['residual'].mean():+.4f}")
print(f"  Std residual: {df_train['residual'].std():.4f}")
print()

# Train bias correction
CORRECTION_FEATURES = [
    'aod_550', 'aod_high', 'aod_spike', 'soiling_risk',
    'aod_std_7d', 'days_no_rain', 'season', 'ensemble_pred'
]

X_correction = df_train[CORRECTION_FEATURES].values
y_correction = df_train['residual'].values

model_correction = Ridge(alpha=1.0)  # Regularized to prevent overfitting
model_correction.fit(X_correction, y_correction)

print("  ✅ Bias correction trained")
print()

# ============================================================================
# STEP 3: MAKE FINAL PREDICTIONS
# ============================================================================

print("Step 3: Make final predictions on test set...")
print()

X_test = df_test[ALL_FEATURES].values
y_test = df_test['sr'].values

# Get predictions from all models
pred_stable_test = model_stable.predict(X_test)
pred_unstable_test = model_unstable.predict(X_test)
pred_overall_test = model_overall.predict(X_test)

# Ensemble
df_test['pred_stable'] = pred_stable_test
df_test['pred_unstable'] = pred_unstable_test
df_test['pred_overall'] = pred_overall_test

df_test['use_unstable'] = (
    (df_test['aod_high'] == 1) |
    (df_test['aod_spike'] == 1) |
    (df_test['soiling_risk'] > 2.0) |
    (df_test['aod_std_7d'] > 0.1)
).astype(int)

df_test['ensemble_pred'] = np.where(
    df_test['use_unstable'],
    0.7 * df_test['pred_unstable'] + 0.3 * df_test['pred_overall'],
    0.7 * df_test['pred_stable'] + 0.3 * df_test['pred_overall']
)

# Apply bias correction
X_correction_test = df_test[CORRECTION_FEATURES].values
correction_test = model_correction.predict(X_correction_test)

y_pred_final = df_test['ensemble_pred'].values + correction_test

# Also get baseline for comparison
model_baseline = CatBoostRegressor(
    iterations=500,
    depth=6,
    learning_rate=0.05,
    random_seed=42,
    verbose=0
)
model_baseline.fit(X_train_all, y_train_all)
y_pred_baseline = model_baseline.predict(X_test)

print(f"  Routed {df_test['use_unstable'].sum()}/{len(df_test)} ({df_test['use_unstable'].mean()*100:.1f}%) to unstable model")
print()

# ============================================================================
# EVALUATE
# ============================================================================

print("="*80)
print("RESULTS COMPARISON")
print("="*80)
print()

mae_baseline = mean_absolute_error(y_test, y_pred_baseline) * 100
bias_baseline = (y_pred_baseline - y_test).mean() * 100
r2_baseline = r2_score(y_test, y_pred_baseline)

mae_final = mean_absolute_error(y_test, y_pred_final) * 100
bias_final = (y_pred_final - y_test).mean() * 100
r2_final = r2_score(y_test, y_pred_final)

print("📊 Overall Test Performance:")
print("-" * 80)
print(f"  Baseline:      MAE = {mae_baseline:.2f}%,  Bias = {bias_baseline:+.2f}%,  R² = {r2_baseline:.3f}")
print(f"  Final model:   MAE = {mae_final:.2f}%,  Bias = {bias_final:+.2f}%,  R² = {r2_final:.3f}")
print()
print(f"  Improvement:   MAE {mae_final - mae_baseline:+.2f}%,  Bias {bias_final - bias_baseline:+.2f}%,  R² {r2_final - r2_baseline:+.3f}")
print()

# ============================================================================
# DETAILED EVALUATION ON UNSTABLE PERIODS
# ============================================================================

print("="*80)
print("DETAILED EVALUATION ON 7-DAY HORIZON")
print("="*80)
print()

try:
    df_detailed = pd.read_csv("outputs_enhanced_forecast/detailed_predictions_with_delta.csv")
    df_detailed_7d = df_detailed[df_detailed['horizon'] == 7].copy()
    df_detailed_7d['date_t0'] = pd.to_datetime(df_detailed_7d['date_t0'])

    # Add predictions
    df_test['date'] = pd.to_datetime(df_test['date'])

    pred_mapping_baseline = dict(zip(df_test['date'], y_pred_baseline))
    pred_mapping_final = dict(zip(df_test['date'], y_pred_final))

    df_detailed_7d['pred_baseline'] = df_detailed_7d['date_t0'].map(pred_mapping_baseline)
    df_detailed_7d['pred_final'] = df_detailed_7d['date_t0'].map(pred_mapping_final)

    df_detailed_7d = df_detailed_7d.dropna(subset=['pred_baseline'])

    # Errors
    df_detailed_7d['error_baseline'] = np.abs(df_detailed_7d['pred_baseline'] - df_detailed_7d['sr_actual'])
    df_detailed_7d['error_final'] = np.abs(df_detailed_7d['pred_final'] - df_detailed_7d['sr_actual'])

    # Bias
    df_detailed_7d['bias_baseline'] = df_detailed_7d['pred_baseline'] - df_detailed_7d['sr_actual']
    df_detailed_7d['bias_final'] = df_detailed_7d['pred_final'] - df_detailed_7d['sr_actual']

    # Split by magnitude
    df_stable_test = df_detailed_7d[df_detailed_7d['change_magnitude'] == 'Stable (<1%)']
    df_unstable_test = df_detailed_7d[df_detailed_7d['change_magnitude'].isin(['Medium (3-5%)', 'Large (>5%)'])]

    print("📊 STABLE PERIODS (change <1%):")
    print("-" * 80)
    print(f"  N = {len(df_stable_test)} samples")
    if len(df_stable_test) > 0:
        mae_s_base = df_stable_test['error_baseline'].mean()*100
        bias_s_base = df_stable_test['bias_baseline'].mean()*100
        mae_s_final = df_stable_test['error_final'].mean()*100
        bias_s_final = df_stable_test['bias_final'].mean()*100

        print(f"  Baseline:      MAE = {mae_s_base:.2f}%,  Bias = {bias_s_base:+.2f}%")
        print(f"  Final model:   MAE = {mae_s_final:.2f}%,  Bias = {bias_s_final:+.2f}%")
        print(f"  Δ              MAE {mae_s_final - mae_s_base:+.2f}%,  Bias {bias_s_final - bias_s_base:+.2f}%")
    print()

    print("📊 UNSTABLE PERIODS (change >3%):")
    print("-" * 80)
    print(f"  N = {len(df_unstable_test)} samples")
    if len(df_unstable_test) > 0:
        mae_u_base = df_unstable_test['error_baseline'].mean()*100
        bias_u_base = df_unstable_test['bias_baseline'].mean()*100
        mae_u_final = df_unstable_test['error_final'].mean()*100
        bias_u_final = df_unstable_test['bias_final'].mean()*100

        improvement_mae = (1 - mae_u_final / mae_u_base) * 100
        improvement_bias = abs(bias_u_base) - abs(bias_u_final)

        print(f"  Baseline:      MAE = {mae_u_base:.2f}%,  Bias = {bias_u_base:+.2f}%")
        print(f"  Final model:   MAE = {mae_u_final:.2f}%,  Bias = {bias_u_final:+.2f}%")
        print(f"  Δ              MAE {mae_u_final - mae_u_base:+.2f}% ({improvement_mae:+.1f}%),  Bias {bias_u_final - bias_u_base:+.2f}%")
        print()

        if improvement_mae > 0:
            print(f"  ✅ Unstable period MAE improved by {improvement_mae:.1f}%")
        if improvement_bias > 0:
            print(f"  ✅ Bias reduced by {improvement_bias:.2f}% in unstable periods")

except Exception as e:
    print(f"⚠️  Could not evaluate: {e}")
    import traceback
    traceback.print_exc()

print()

# ============================================================================
# SAVE FINAL MODEL
# ============================================================================

results_dir = Path("outputs_final_model")
results_dir.mkdir(exist_ok=True)

# Save all models
import pickle

final_model_package = {
    'model_stable': model_stable,
    'model_unstable': model_unstable,
    'model_overall': model_overall,
    'model_correction': model_correction,
    'features': ALL_FEATURES,
    'correction_features': CORRECTION_FEATURES,
    'routing_logic': {
        'use_unstable_if': 'aod_high OR aod_spike OR soiling_risk>2.0 OR aod_std_7d>0.1',
        'stable_weight': 0.7,
        'unstable_weight': 0.7,
        'overall_weight': 0.3
    }
}

with open(results_dir / "final_model.pkl", 'wb') as f:
    pickle.dump(final_model_package, f)

# Save summary
summary = {
    'model_type': 'optimized_ensemble_with_bias_correction',
    'components': [
        'Stable specialist (Q=0.55, depth=5)',
        'Unstable specialist (Q=0.60, depth=8)',
        'Overall model (weighted training)',
        'Bias correction layer (Ridge regression)'
    ],
    'performance': {
        'overall': {
            'mae': float(mae_final),
            'bias': float(bias_final),
            'r2': float(r2_final),
            'improvement_vs_baseline': {
                'mae': float(mae_final - mae_baseline),
                'bias': float(bias_final - bias_baseline)
            }
        }
    },
    'training_data': {
        'total_samples': len(df_train),
        'stable_samples': len(df_stable),
        'unstable_samples': len(df_unstable)
    }
}

with open(results_dir / "final_model_summary.json", 'w') as f:
    json.dump(summary, f, indent=2)

print("="*80)
print("✅ FINAL MODEL COMPLETE")
print("="*80)
print()
print(f"📁 Saved to: {results_dir}/")
print("   - final_model.pkl (complete model package)")
print("   - final_model_summary.json")
print()
print("🚀 Model ready for deployment!")
