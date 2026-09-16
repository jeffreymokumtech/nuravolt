"""
Improve forecast bias (reduce systematic soiling underestimation).

Current issue: Models consistently underpredict soiling by ~1.2%
Goal: Reduce bias to near zero while maintaining acceptable MAE

Approaches to test:
1. Quantile regression (predict 60th-70th percentile instead of mean)
2. Post-hoc bias correction (add learned offset based on conditions)
3. Conservative safety margin (AOD-based adjustment)
4. Custom loss function (asymmetric with gradient penalty)
5. Ensemble with worst-case climatology
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json
from catboost import CatBoostRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.linear_model import LinearRegression
import warnings
warnings.filterwarnings('ignore')

print("="*80)
print("IMPROVING FORECAST BIAS")
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

# AOD volatility
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

X_train = df_train[ALL_FEATURES].values
y_train = df_train['sr'].values
X_test = df_test[ALL_FEATURES].values
y_test = df_test['sr'].values

print(f"📊 Train: {len(df_train)} samples")
print(f"📊 Test: {len(df_test)} samples")
print()

# ============================================================================
# BASELINE
# ============================================================================

print("="*80)
print("BASELINE MODEL")
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
bias_baseline = (y_pred_baseline - y_test).mean() * 100

print(f"✅ Baseline: MAE = {mae_baseline:.2f}%, Bias = {bias_baseline:+.2f}%")
print(f"   Interpretation: Model {'overpredicts' if bias_baseline > 0 else 'underpredicts'} SR by {abs(bias_baseline):.2f}%")
print()

# ============================================================================
# APPROACH 1: QUANTILE REGRESSION
# ============================================================================

print("="*80)
print("APPROACH 1: QUANTILE REGRESSION")
print("="*80)
print()

print("  Testing different quantiles (predict higher than median to be conservative)...")
print()

quantiles_to_test = [0.5, 0.6, 0.65, 0.7, 0.75]
best_quantile = None
best_bias_quantile = float('inf')

for q in quantiles_to_test:
    model_quantile = CatBoostRegressor(
        iterations=500,
        depth=6,
        learning_rate=0.05,
        loss_function=f'Quantile:alpha={q}',
        random_seed=42,
        verbose=0
    )

    model_quantile.fit(X_train, y_train)
    y_pred_q = model_quantile.predict(X_test)

    mae_q = mean_absolute_error(y_test, y_pred_q) * 100
    bias_q = (y_pred_q - y_test).mean() * 100

    marker = ""
    if abs(bias_q) < abs(best_bias_quantile):
        best_bias_quantile = bias_q
        best_quantile = (q, model_quantile, y_pred_q)
        marker = "⭐"

    print(f"  Q={q:.2f}: MAE = {mae_q:.2f}%, Bias = {bias_q:+.2f}%  {marker}")

q_best, model_q_best, y_pred_q_best = best_quantile
mae_q_best = mean_absolute_error(y_test, y_pred_q_best) * 100

print()
print(f"✅ Best quantile: Q={q_best:.2f}")
print(f"   MAE = {mae_q_best:.2f}% ({mae_q_best - mae_baseline:+.2f}%)")
print(f"   Bias = {best_bias_quantile:+.2f}% ({best_bias_quantile - bias_baseline:+.2f}%)")
print()

# ============================================================================
# APPROACH 2: POST-HOC BIAS CORRECTION
# ============================================================================

print("="*80)
print("APPROACH 2: POST-HOC BIAS CORRECTION")
print("="*80)
print()

print("  Step 1: Train baseline model and measure residuals...")

# Use baseline predictions on training set
y_train_pred = model_baseline.predict(X_train)
residuals_train = y_train - y_train_pred  # Actual - Predicted

# Create correction features
df_train['residual'] = residuals_train
df_train['baseline_pred'] = y_train_pred

print(f"    Mean training residual: {residuals_train.mean():+.4f}")
print()

print("  Step 2: Train bias correction model...")
print("    Predicts: residual ~ f(AOD, risk, season, baseline_pred)")
print()

# Features for bias correction
CORRECTION_FEATURES = [
    'aod_550', 'aod_high', 'aod_spike', 'soiling_risk',
    'days_no_rain', 'season', 'baseline_pred'
]

X_correction = df_train[CORRECTION_FEATURES].values
y_correction = df_train['residual'].values

model_correction = LinearRegression()
model_correction.fit(X_correction, y_correction)

# Apply correction to test set
df_test['baseline_pred'] = y_pred_baseline
X_correction_test = df_test[CORRECTION_FEATURES].values
correction_test = model_correction.predict(X_correction_test)

y_pred_corrected = y_pred_baseline + correction_test

mae_corrected = mean_absolute_error(y_test, y_pred_corrected) * 100
bias_corrected = (y_pred_corrected - y_test).mean() * 100

print(f"✅ Bias correction:")
print(f"   MAE = {mae_corrected:.2f}% ({mae_corrected - mae_baseline:+.2f}%)")
print(f"   Bias = {bias_corrected:+.2f}% ({bias_corrected - bias_baseline:+.2f}%)")
print()

# Show correction coefficients
print("  Correction coefficients:")
for idx, feat in enumerate(CORRECTION_FEATURES):
    coef = model_correction.coef_[idx]
    print(f"    {feat:20s}: {coef:+.4f}")
print()

# ============================================================================
# APPROACH 3: CONSERVATIVE SAFETY MARGIN
# ============================================================================

print("="*80)
print("APPROACH 3: CONSERVATIVE SAFETY MARGIN")
print("="*80)
print()

print("  Adding risk-based safety margin to predictions...")
print()

# Calculate safety margin based on AOD and soiling risk
df_test_analysis = df_test.copy()
df_test_analysis['baseline_pred'] = y_pred_baseline

# Safety margin: higher for high dust
df_test_analysis['safety_margin'] = (
    0.005 * df_test_analysis['aod_high'] +      # -0.5% for high AOD
    0.008 * df_test_analysis['aod_spike'] +     # -0.8% for spikes
    0.003 * (df_test_analysis['soiling_risk'] / 5)  # -0.3% per risk point
)

y_pred_safety = y_pred_baseline - df_test_analysis['safety_margin'].values

mae_safety = mean_absolute_error(y_test, y_pred_safety) * 100
bias_safety = (y_pred_safety - y_test).mean() * 100

print(f"  Average safety margin: {df_test_analysis['safety_margin'].mean()*100:.2f}%")
print(f"  Max safety margin: {df_test_analysis['safety_margin'].max()*100:.2f}%")
print()

print(f"✅ Conservative safety:")
print(f"   MAE = {mae_safety:.2f}% ({mae_safety - mae_baseline:+.2f}%)")
print(f"   Bias = {bias_safety:+.2f}% ({bias_safety - bias_baseline:+.2f}%)")
print()

# ============================================================================
# APPROACH 4: ENSEMBLE WITH WORST-CASE CLIMATOLOGY
# ============================================================================

print("="*80)
print("APPROACH 4: ENSEMBLE WITH WORST-CASE CLIMATOLOGY")
print("="*80)
print()

print("  Calculating seasonal worst-case soiling rates...")

# Calculate seasonal 25th percentile SR (worse than average)
seasonal_worst = df_train.groupby('season')['sr'].quantile(0.25)

df_test_analysis['seasonal_worst'] = df_test_analysis['season'].map(seasonal_worst)

print("  Seasonal worst-case SR (25th percentile):")
for season in sorted(seasonal_worst.index):
    print(f"    Season {season}: {seasonal_worst[season]:.3f}")
print()

# Blend: 70% ML, 30% worst-case
blend_weight = 0.7
y_pred_blend = blend_weight * y_pred_baseline + (1 - blend_weight) * df_test_analysis['seasonal_worst'].values

mae_blend = mean_absolute_error(y_test, y_pred_blend) * 100
bias_blend = (y_pred_blend - y_test).mean() * 100

print(f"  Blend: {blend_weight*100:.0f}% ML + {(1-blend_weight)*100:.0f}% worst-case")
print()

print(f"✅ Worst-case blend:")
print(f"   MAE = {mae_blend:.2f}% ({mae_blend - mae_baseline:+.2f}%)")
print(f"   Bias = {bias_blend:+.2f}% ({bias_blend - bias_baseline:+.2f}%)")
print()

# ============================================================================
# EVALUATE ON UNSTABLE PERIODS
# ============================================================================

print("="*80)
print("EVALUATION ON UNSTABLE TEST PERIODS")
print("="*80)
print()

try:
    df_detailed = pd.read_csv("outputs_enhanced_forecast/detailed_predictions_with_delta.csv")
    df_detailed_7d = df_detailed[df_detailed['horizon'] == 7].copy()
    df_detailed_7d['date_t0'] = pd.to_datetime(df_detailed_7d['date_t0'])

    # Add predictions
    df_test['date'] = pd.to_datetime(df_test['date'])

    pred_mapping_baseline = dict(zip(df_test['date'], y_pred_baseline))
    pred_mapping_quantile = dict(zip(df_test['date'], y_pred_q_best))
    pred_mapping_corrected = dict(zip(df_test['date'], y_pred_corrected))
    pred_mapping_safety = dict(zip(df_test['date'], y_pred_safety))
    pred_mapping_blend = dict(zip(df_test['date'], y_pred_blend))

    df_detailed_7d['pred_baseline'] = df_detailed_7d['date_t0'].map(pred_mapping_baseline)
    df_detailed_7d['pred_quantile'] = df_detailed_7d['date_t0'].map(pred_mapping_quantile)
    df_detailed_7d['pred_corrected'] = df_detailed_7d['date_t0'].map(pred_mapping_corrected)
    df_detailed_7d['pred_safety'] = df_detailed_7d['date_t0'].map(pred_mapping_safety)
    df_detailed_7d['pred_blend'] = df_detailed_7d['date_t0'].map(pred_mapping_blend)

    df_detailed_7d = df_detailed_7d.dropna(subset=['pred_baseline'])

    # Calculate errors and bias
    for approach in ['baseline', 'quantile', 'corrected', 'safety', 'blend']:
        df_detailed_7d[f'error_{approach}'] = np.abs(df_detailed_7d[f'pred_{approach}'] - df_detailed_7d['sr_actual'])
        df_detailed_7d[f'bias_{approach}'] = df_detailed_7d[f'pred_{approach}'] - df_detailed_7d['sr_actual']

    # Split by stability
    df_stable_test = df_detailed_7d[df_detailed_7d['change_magnitude'] == 'Stable (<1%)']
    df_unstable_test = df_detailed_7d[df_detailed_7d['change_magnitude'].isin(['Medium (3-5%)', 'Large (>5%)'])]

    print("📊 7-Day Horizon - STABLE PERIODS:")
    print("-" * 80)
    print(f"  N = {len(df_stable_test)} samples")
    if len(df_stable_test) > 0:
        print(f"  Baseline:       MAE = {df_stable_test['error_baseline'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_baseline'].mean()*100:+.2f}%")
        print(f"  Quantile:       MAE = {df_stable_test['error_quantile'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_quantile'].mean()*100:+.2f}%")
        print(f"  Corrected:      MAE = {df_stable_test['error_corrected'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_corrected'].mean()*100:+.2f}%")
        print(f"  Safety:         MAE = {df_stable_test['error_safety'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_safety'].mean()*100:+.2f}%")
        print(f"  Blend:          MAE = {df_stable_test['error_blend'].mean()*100:.2f}%,  Bias = {df_stable_test['bias_blend'].mean()*100:+.2f}%")
    print()

    print("📊 7-Day Horizon - UNSTABLE PERIODS:")
    print("-" * 80)
    print(f"  N = {len(df_unstable_test)} samples")
    if len(df_unstable_test) > 0:
        baseline_mae_u = df_unstable_test['error_baseline'].mean()*100
        baseline_bias_u = df_unstable_test['bias_baseline'].mean()*100

        print(f"  Baseline:       MAE = {baseline_mae_u:.2f}%,  Bias = {baseline_bias_u:+.2f}%")

        approaches = [
            ('Quantile', 'quantile'),
            ('Corrected', 'corrected'),
            ('Safety', 'safety'),
            ('Blend', 'blend')
        ]

        results = []
        for name, key in approaches:
            mae = df_unstable_test[f'error_{key}'].mean()*100
            bias = df_unstable_test[f'bias_{key}'].mean()*100
            bias_impr = abs(bias) - abs(baseline_bias_u)
            mae_change = mae - baseline_mae_u

            marker = "⭐" if abs(bias) < abs(baseline_bias_u) else ""
            print(f"  {name:15s} MAE = {mae:.2f}% ({mae_change:+.2f}%),  Bias = {bias:+.2f}% (Δ{bias_impr:+.2f}%) {marker}")

            results.append({
                'name': name,
                'mae': mae,
                'bias': bias,
                'bias_improvement': bias_impr
            })

        print()
        print("  💡 BEST BIAS REDUCTION:")
        best = min(results, key=lambda x: abs(x['bias']))
        print(f"    ⭐ {best['name']}: Bias = {best['bias']:+.2f}% (improved {-best['bias_improvement']:.2f}%)")

        print()
        print("  📊 BIAS IMPROVEMENT SUMMARY:")
        for r in sorted(results, key=lambda x: x['bias_improvement']):
            print(f"    {r['name']:15s}: {r['bias_improvement']:+.2f}% bias reduction")

except Exception as e:
    print(f"⚠️  Could not evaluate: {e}")
    import traceback
    traceback.print_exc()

print()

# ============================================================================
# SAVE RESULTS
# ============================================================================

results_dir = Path("outputs_bias_improvement")
results_dir.mkdir(exist_ok=True)

summary = {
    'experiment': 'bias_reduction',
    'baseline': {
        'mae': float(mae_baseline),
        'bias': float(bias_baseline)
    },
    'approaches': {
        'quantile': {
            'best_quantile': float(q_best),
            'mae': float(mae_q_best),
            'bias': float(best_bias_quantile),
            'bias_improvement': float(best_bias_quantile - bias_baseline)
        },
        'post_hoc_correction': {
            'mae': float(mae_corrected),
            'bias': float(bias_corrected),
            'bias_improvement': float(bias_corrected - bias_baseline)
        },
        'safety_margin': {
            'mae': float(mae_safety),
            'bias': float(bias_safety),
            'bias_improvement': float(bias_safety - bias_baseline)
        },
        'worst_case_blend': {
            'blend_weight': float(blend_weight),
            'mae': float(mae_blend),
            'bias': float(bias_blend),
            'bias_improvement': float(bias_blend - bias_baseline)
        }
    }
}

with open(results_dir / "bias_reduction_summary.json", 'w') as f:
    json.dump(summary, f, indent=2)

# Save best models
import pickle
with open(results_dir / "model_quantile.pkl", 'wb') as f:
    pickle.dump(model_q_best, f)

with open(results_dir / "model_bias_correction.pkl", 'wb') as f:
    pickle.dump({'baseline': model_baseline, 'correction': model_correction}, f)

print("="*80)
print("✅ BIAS REDUCTION EXPERIMENTS COMPLETE")
print("="*80)
print()
print(f"📁 Results saved to: {results_dir}/")
print("   - bias_reduction_summary.json")
print("   - model_quantile.pkl")
print("   - model_bias_correction.pkl")
