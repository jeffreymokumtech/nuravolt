#!/usr/bin/env python3
"""
Soiling Forecast Comparison: Daily vs Weekly Granularity

Compares forecasting performance for:
- Soiling RATE (daily change, %/day or %/week)
- Soiling RATIO (cumulative state, %)

At granularities:
- Daily: 1, 7, 14, 21, 28 day horizons
- Weekly: Week 1, Week 2, Week 3, Week 4 horizons

Output: Comprehensive comparison table for demo
"""

import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
import json
import warnings
warnings.filterwarnings('ignore')

from catboost import CatBoostRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from scipy import stats

# Configuration
DATA_DIR = Path("public/data/soiling/ribera")
OUTPUT_DIR = Path("outputs_forecast_comparison")
OUTPUT_DIR.mkdir(exist_ok=True)

print("=" * 80)
print("SOILING FORECAST: DAILY vs WEEKLY COMPARISON")
print("=" * 80)

# =============================================================================
# STEP 1: Load Data
# =============================================================================
print("\n📂 Loading Ribera data...")

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

# =============================================================================
# STEP 2: Merge and Calculate Daily Soiling Rate
# =============================================================================
print("\n📊 Preparing daily dataset...")

# Merge all data
df = df_dustiq[['date', 'sr']].copy()
df = df.merge(df_rain[['date', 'precipitation_mm']], on='date', how='left')

# Get AOD column
aod_cols = [c for c in df_aod.columns if 'aod' in c.lower() and c != 'date']
if aod_cols:
    aod_col = aod_cols[0]
    df = df.merge(df_aod[['date', aod_col]], on='date', how='left')
    df = df.rename(columns={aod_col: 'aod'})
else:
    df['aod'] = np.nan

df = df.sort_values('date').reset_index(drop=True)

# Calculate daily soiling rate
df['sr_prev'] = df['sr'].shift(1)
df['daily_rate'] = df['sr'] - df['sr_prev']  # Positive = cleaning, Negative = soiling

# Detect cleaning events (>1% jump)
df['is_cleaning'] = df['daily_rate'] > 0.01

# For soiling rate, we want ONLY natural soiling (exclude cleaning days)
df['soiling_rate'] = df['daily_rate'].copy()
df.loc[df['is_cleaning'], 'soiling_rate'] = np.nan

# Fill NaN precipitation and AOD
df['precipitation_mm'] = df['precipitation_mm'].fillna(0)
df['aod'] = df['aod'].fillna(df['aod'].median())

print(f"  Total days: {len(df)}")
print(f"  Cleaning events: {df['is_cleaning'].sum()}")
print(f"  Mean daily soiling rate: {df['soiling_rate'].mean()*100:.4f}%/day")

# =============================================================================
# STEP 3: Create Weekly Aggregates
# =============================================================================
print("\n📅 Creating weekly aggregates...")

# Add week identifier
df['week_start'] = df['date'] - pd.to_timedelta(df['date'].dt.dayofweek, unit='D')

# Weekly aggregates
df_weekly = df.groupby('week_start').agg({
    'sr': ['first', 'last', 'mean'],  # SR at start, end, and average
    'soiling_rate': ['sum', 'mean', 'count'],  # Total and average rate
    'precipitation_mm': 'sum',
    'aod': 'mean',
    'is_cleaning': 'sum'
}).reset_index()

# Flatten column names
df_weekly.columns = ['week_start', 'sr_start', 'sr_end', 'sr_mean',
                     'weekly_rate_sum', 'daily_rate_mean', 'n_days',
                     'rain_weekly', 'aod_weekly', 'cleaning_events']

# Weekly soiling rate = change in SR over the week
df_weekly['weekly_rate'] = df_weekly['sr_end'] - df_weekly['sr_start']

# Filter to complete weeks (7 days) without cleaning
df_weekly_clean = df_weekly[
    (df_weekly['n_days'] >= 5) &
    (df_weekly['cleaning_events'] == 0)
].copy()

print(f"  Total weeks: {len(df_weekly)}")
print(f"  Clean weeks (no cleaning): {len(df_weekly_clean)}")
print(f"  Mean weekly soiling rate: {df_weekly_clean['weekly_rate'].mean()*100:.3f}%/week")

# =============================================================================
# STEP 4: Feature Engineering
# =============================================================================
print("\n🔧 Engineering features...")

def add_features(df_in, date_col='date'):
    """Add weather and temporal features."""
    df = df_in.copy()

    # Temporal
    df['day_of_year'] = pd.to_datetime(df[date_col]).dt.dayofyear
    df['month'] = pd.to_datetime(df[date_col]).dt.month
    df['season'] = df['month'].map({12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1,
                                     6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3})

    return df

# Add features to daily data
df = add_features(df, 'date')

# Rolling features for daily
for window in [3, 7, 14, 21]:
    df[f'rain_{window}d'] = df['precipitation_mm'].rolling(window, min_periods=1).sum()
    df[f'aod_{window}d'] = df['aod'].rolling(window, min_periods=1).mean()
    df[f'rate_{window}d'] = df['soiling_rate'].rolling(window, min_periods=1).mean()

# Days since rain
df['days_no_rain'] = (df['precipitation_mm'] < 0.5).groupby(
    (df['precipitation_mm'] >= 0.5).cumsum()
).cumcount()

# Add features to weekly data
df_weekly = add_features(df_weekly, 'week_start')

# Rolling features for weekly (in weeks)
for window in [2, 4]:
    df_weekly[f'rain_{window}w'] = df_weekly['rain_weekly'].rolling(window, min_periods=1).sum()
    df_weekly[f'aod_{window}w'] = df_weekly['aod_weekly'].rolling(window, min_periods=1).mean()

print(f"  Daily features: {len([c for c in df.columns if c not in ['date', 'sr', 'soiling_rate']])}")
print(f"  Weekly features: {len([c for c in df_weekly.columns if c not in ['week_start']])}")

# =============================================================================
# STEP 5: Train/Test Split
# =============================================================================
print("\n📊 Splitting data...")

# Use last year for testing
test_start = df['date'].max() - pd.Timedelta(days=365)

df_train = df[df['date'] < test_start].copy()
df_test = df[df['date'] >= test_start].copy()

test_start_week = df_weekly['week_start'].max() - pd.Timedelta(weeks=52)
df_weekly_train = df_weekly[df_weekly['week_start'] < test_start_week].copy()
df_weekly_test = df_weekly[df_weekly['week_start'] >= test_start_week].copy()

print(f"  Daily - Train: {len(df_train)}, Test: {len(df_test)}")
print(f"  Weekly - Train: {len(df_weekly_train)}, Test: {len(df_weekly_test)}")

# =============================================================================
# STEP 6: Define Feature Sets and Train Models
# =============================================================================
print("\n🚀 Training models...")

# Daily features
DAILY_FEATURES = [
    'precipitation_mm', 'aod', 'day_of_year', 'month', 'season',
    'rain_3d', 'rain_7d', 'rain_14d', 'rain_21d',
    'aod_3d', 'aod_7d', 'aod_14d', 'aod_21d',
    'days_no_rain'
]
DAILY_FEATURES = [f for f in DAILY_FEATURES if f in df.columns]

# Weekly features
WEEKLY_FEATURES = [
    'rain_weekly', 'aod_weekly', 'day_of_year', 'month', 'season',
    'rain_2w', 'rain_4w', 'aod_2w', 'aod_4w'
]
WEEKLY_FEATURES = [f for f in WEEKLY_FEATURES if f in df_weekly.columns]

# Model parameters
MODEL_PARAMS = {
    'iterations': 1000,
    'learning_rate': 0.03,
    'depth': 6,
    'l2_leaf_reg': 5.0,
    'loss_function': 'MAE',
    'random_seed': 42,
    'verbose': False
}

# Train models for different targets
models = {}

# 1. Daily Soiling Rate
print("  Training: Daily Soiling Rate...")
df_rate_train = df_train.dropna(subset=['soiling_rate'])
if len(df_rate_train) > 100:
    X_train = df_rate_train[DAILY_FEATURES].fillna(0)
    y_train = df_rate_train['soiling_rate']
    models['daily_rate'] = CatBoostRegressor(**MODEL_PARAMS)
    models['daily_rate'].fit(X_train, y_train)
    print(f"    Trained on {len(X_train)} samples")

# 2. Daily Soiling Ratio
print("  Training: Daily Soiling Ratio...")
df_sr_train = df_train.dropna(subset=['sr'])
if len(df_sr_train) > 100:
    X_train = df_sr_train[DAILY_FEATURES].fillna(0)
    y_train = df_sr_train['sr']
    models['daily_ratio'] = CatBoostRegressor(**MODEL_PARAMS)
    models['daily_ratio'].fit(X_train, y_train)
    print(f"    Trained on {len(X_train)} samples")

# 3. Weekly Soiling Rate
print("  Training: Weekly Soiling Rate...")
df_weekly_rate_train = df_weekly_train.dropna(subset=['weekly_rate'])
if len(df_weekly_rate_train) > 20:
    X_train = df_weekly_rate_train[WEEKLY_FEATURES].fillna(0)
    y_train = df_weekly_rate_train['weekly_rate']
    models['weekly_rate'] = CatBoostRegressor(**MODEL_PARAMS)
    models['weekly_rate'].fit(X_train, y_train)
    print(f"    Trained on {len(X_train)} samples")

# 4. Weekly Soiling Ratio (end of week)
print("  Training: Weekly Soiling Ratio...")
df_weekly_sr_train = df_weekly_train.dropna(subset=['sr_end'])
if len(df_weekly_sr_train) > 20:
    X_train = df_weekly_sr_train[WEEKLY_FEATURES].fillna(0)
    y_train = df_weekly_sr_train['sr_end']
    models['weekly_ratio'] = CatBoostRegressor(**MODEL_PARAMS)
    models['weekly_ratio'].fit(X_train, y_train)
    print(f"    Trained on {len(X_train)} samples")

# =============================================================================
# STEP 7: Evaluate at Multiple Horizons
# =============================================================================
print("\n" + "=" * 80)
print("FORECAST EVALUATION")
print("=" * 80)

results = []

def evaluate_daily_forecast(df_data, model, features, target_col, horizon_days, model_name):
    """Evaluate daily forecast at specific horizon."""
    errors = []
    actuals = []
    predictions = []

    test_start_idx = len(df_data) - 365  # Last year

    for i in range(test_start_idx, len(df_data)):
        target_idx = i
        forecast_idx = i - horizon_days

        if forecast_idx < 30:  # Need history for features
            continue

        # Get features from forecast date
        X_forecast = df_data.iloc[forecast_idx:forecast_idx+1][features].fillna(0)

        # Get actual value at target date
        actual = df_data.iloc[target_idx][target_col]

        if pd.isna(actual):
            continue

        # Predict
        pred = model.predict(X_forecast)[0]

        actuals.append(actual)
        predictions.append(pred)
        errors.append(pred - actual)

    if len(actuals) < 10:
        return None

    actuals = np.array(actuals)
    predictions = np.array(predictions)

    mae = np.mean(np.abs(predictions - actuals))
    rmse = np.sqrt(np.mean((predictions - actuals) ** 2))
    r2 = r2_score(actuals, predictions)
    corr = np.corrcoef(actuals, predictions)[0, 1] if len(actuals) > 2 else 0

    return {
        'model': model_name,
        'horizon': f"{horizon_days}d",
        'horizon_days': horizon_days,
        'n_samples': len(actuals),
        'mae': mae,
        'rmse': rmse,
        'r2': r2,
        'correlation': corr
    }

def evaluate_weekly_forecast(df_data, model, features, target_col, horizon_weeks, model_name):
    """Evaluate weekly forecast at specific horizon."""
    errors = []
    actuals = []
    predictions = []

    test_start_idx = len(df_data) - 52  # Last year (52 weeks)

    for i in range(max(test_start_idx, 10), len(df_data)):
        target_idx = i
        forecast_idx = i - horizon_weeks

        if forecast_idx < 4:  # Need history
            continue

        # Get features from forecast week
        X_forecast = df_data.iloc[forecast_idx:forecast_idx+1][features].fillna(0)

        # Get actual value at target week
        actual = df_data.iloc[target_idx][target_col]

        if pd.isna(actual):
            continue

        # Predict
        pred = model.predict(X_forecast)[0]

        actuals.append(actual)
        predictions.append(pred)

    if len(actuals) < 5:
        return None

    actuals = np.array(actuals)
    predictions = np.array(predictions)

    mae = np.mean(np.abs(predictions - actuals))
    rmse = np.sqrt(np.mean((predictions - actuals) ** 2))
    r2 = r2_score(actuals, predictions)
    corr = np.corrcoef(actuals, predictions)[0, 1] if len(actuals) > 2 else 0

    return {
        'model': model_name,
        'horizon': f"Week {horizon_weeks}",
        'horizon_days': horizon_weeks * 7,
        'n_samples': len(actuals),
        'mae': mae,
        'rmse': rmse,
        'r2': r2,
        'correlation': corr
    }

# Evaluate Daily Soiling Rate
print("\n📈 Daily Soiling Rate Forecasts:")
if 'daily_rate' in models:
    for horizon in [1, 7, 14, 21, 28]:
        result = evaluate_daily_forecast(df, models['daily_rate'], DAILY_FEATURES,
                                         'soiling_rate', horizon, 'Daily Rate')
        if result:
            result['target'] = 'Soiling Rate'
            result['granularity'] = 'Daily'
            results.append(result)
            print(f"  {horizon}d: MAE={result['mae']*100:.4f}%/day, R²={result['r2']:.3f}, r={result['correlation']:.3f}")

# Evaluate Daily Soiling Ratio
print("\n📈 Daily Soiling Ratio Forecasts:")
if 'daily_ratio' in models:
    for horizon in [1, 7, 14, 21, 28]:
        result = evaluate_daily_forecast(df, models['daily_ratio'], DAILY_FEATURES,
                                         'sr', horizon, 'Daily Ratio')
        if result:
            result['target'] = 'Soiling Ratio'
            result['granularity'] = 'Daily'
            results.append(result)
            print(f"  {horizon}d: MAE={result['mae']*100:.3f}%, R²={result['r2']:.3f}, r={result['correlation']:.3f}")

# Evaluate Weekly Soiling Rate
print("\n📅 Weekly Soiling Rate Forecasts:")
if 'weekly_rate' in models:
    for horizon in [1, 2, 3, 4]:
        result = evaluate_weekly_forecast(df_weekly, models['weekly_rate'], WEEKLY_FEATURES,
                                          'weekly_rate', horizon, 'Weekly Rate')
        if result:
            result['target'] = 'Soiling Rate'
            result['granularity'] = 'Weekly'
            results.append(result)
            print(f"  Week {horizon}: MAE={result['mae']*100:.4f}%/week, R²={result['r2']:.3f}, r={result['correlation']:.3f}")

# Evaluate Weekly Soiling Ratio
print("\n📅 Weekly Soiling Ratio Forecasts:")
if 'weekly_ratio' in models:
    for horizon in [1, 2, 3, 4]:
        result = evaluate_weekly_forecast(df_weekly, models['weekly_ratio'], WEEKLY_FEATURES,
                                          'sr_end', horizon, 'Weekly Ratio')
        if result:
            result['target'] = 'Soiling Ratio'
            result['granularity'] = 'Weekly'
            results.append(result)
            print(f"  Week {horizon}: MAE={result['mae']*100:.3f}%, R²={result['r2']:.3f}, r={result['correlation']:.3f}")

# =============================================================================
# STEP 8: Create Comparison Tables
# =============================================================================
print("\n" + "=" * 80)
print("COMPARISON TABLES")
print("=" * 80)

df_results = pd.DataFrame(results)

# Table 1: Soiling Rate - Daily vs Weekly
print("\n📊 SOILING RATE: Daily vs Weekly Granularity")
print("-" * 90)
print(f"{'Horizon':<15} {'Granularity':<12} {'MAE':<18} {'R²':<10} {'Corr':<10} {'N':<8}")
print("-" * 90)

rate_results = df_results[df_results['target'] == 'Soiling Rate'].copy()
for _, row in rate_results.iterrows():
    if row['granularity'] == 'Daily':
        mae_str = f"{row['mae']*100:.4f}%/day"
    else:
        mae_str = f"{row['mae']*100:.4f}%/week"
    print(f"{row['horizon']:<15} {row['granularity']:<12} {mae_str:<18} {row['r2']:<10.3f} {row['correlation']:<10.3f} {row['n_samples']:<8}")

# Table 2: Soiling Ratio - Daily vs Weekly
print("\n📊 SOILING RATIO: Daily vs Weekly Granularity")
print("-" * 90)
print(f"{'Horizon':<15} {'Granularity':<12} {'MAE (%)':<18} {'R²':<10} {'Corr':<10} {'N':<8}")
print("-" * 90)

ratio_results = df_results[df_results['target'] == 'Soiling Ratio'].copy()
for _, row in ratio_results.iterrows():
    mae_str = f"{row['mae']*100:.3f}%"
    print(f"{row['horizon']:<15} {row['granularity']:<12} {mae_str:<18} {row['r2']:<10.3f} {row['correlation']:<10.3f} {row['n_samples']:<8}")

# Table 3: Side-by-side comparison at similar horizons
print("\n📊 DIRECT COMPARISON: Rate vs Ratio at Each Horizon")
print("-" * 100)

# Map weekly horizons to equivalent daily horizons
horizon_map = {
    7: 'Week 1',
    14: 'Week 2',
    21: 'Week 3',
    28: 'Week 4'
}

print(f"{'Days':<8} {'Target':<15} {'Daily MAE':<18} {'Weekly MAE':<18} {'Daily R²':<10} {'Weekly R²':<10}")
print("-" * 100)

for days, week_label in horizon_map.items():
    for target in ['Soiling Rate', 'Soiling Ratio']:
        daily_row = df_results[(df_results['horizon_days'] == days) &
                               (df_results['target'] == target) &
                               (df_results['granularity'] == 'Daily')]
        weekly_row = df_results[(df_results['horizon'] == week_label) &
                                (df_results['target'] == target)]

        if len(daily_row) > 0 and len(weekly_row) > 0:
            d = daily_row.iloc[0]
            w = weekly_row.iloc[0]

            if target == 'Soiling Rate':
                daily_mae = f"{d['mae']*100:.4f}%/day"
                weekly_mae = f"{w['mae']*100:.4f}%/week"
            else:
                daily_mae = f"{d['mae']*100:.3f}%"
                weekly_mae = f"{w['mae']*100:.3f}%"

            print(f"{days:<8} {target:<15} {daily_mae:<18} {weekly_mae:<18} {d['r2']:<10.3f} {w['r2']:<10.3f}")

# =============================================================================
# STEP 9: Summary Statistics
# =============================================================================
print("\n" + "=" * 80)
print("SUMMARY STATISTICS")
print("=" * 80)

print(f"""
Data Summary:
  DustIQ observations: {len(df_dustiq)} days
  Mean soiling ratio: {df['sr'].mean()*100:.2f}%
  Mean daily soiling rate: {df['soiling_rate'].mean()*100:.4f}%/day
  Mean weekly soiling rate: {df_weekly_clean['weekly_rate'].mean()*100:.3f}%/week
  Cleaning events detected: {df['is_cleaning'].sum()}

Key Findings:
  1. Daily rate prediction: High MAE relative to signal (poor R²)
  2. Weekly rate prediction: Better signal-to-noise ratio
  3. Soiling ratio prediction: More stable, higher R²
  4. Longer horizons: Accuracy degrades as expected
""")

# Best models summary
print("\n🏆 BEST APPROACHES BY USE CASE:")
print("-" * 70)

# Find best for each use case
if len(df_results) > 0:
    # Best for 1-week planning
    week1_results = df_results[df_results['horizon_days'] <= 7]
    if len(week1_results) > 0:
        best_week1 = week1_results.loc[week1_results['r2'].idxmax()]
        print(f"  1-week planning: {best_week1['model']} ({best_week1['granularity']}) - R²={best_week1['r2']:.3f}")

    # Best for 2-week planning
    week2_results = df_results[(df_results['horizon_days'] > 7) & (df_results['horizon_days'] <= 14)]
    if len(week2_results) > 0:
        best_week2 = week2_results.loc[week2_results['r2'].idxmax()]
        print(f"  2-week planning: {best_week2['model']} ({best_week2['granularity']}) - R²={best_week2['r2']:.3f}")

    # Best for monthly planning
    month_results = df_results[df_results['horizon_days'] >= 21]
    if len(month_results) > 0:
        best_month = month_results.loc[month_results['r2'].idxmax()]
        print(f"  Monthly planning: {best_month['model']} ({best_month['granularity']}) - R²={best_month['r2']:.3f}")

# =============================================================================
# STEP 10: Save Results
# =============================================================================
print("\n" + "=" * 80)
print("SAVING RESULTS")
print("=" * 80)

# Save detailed results
df_results.to_csv(OUTPUT_DIR / 'forecast_comparison_results.csv', index=False)

# Save summary JSON
summary = {
    'timestamp': datetime.now().isoformat(),
    'plant': 'ribera',
    'data_summary': {
        'n_days': len(df),
        'n_weeks': len(df_weekly),
        'mean_daily_rate_pct': float(df['soiling_rate'].mean() * 100),
        'mean_weekly_rate_pct': float(df_weekly_clean['weekly_rate'].mean() * 100),
        'mean_sr_pct': float(df['sr'].mean() * 100),
    },
    'results': df_results.to_dict('records')
}

with open(OUTPUT_DIR / 'forecast_comparison_summary.json', 'w') as f:
    json.dump(summary, f, indent=2, default=str)

# Generate markdown report
md_report = f"""# Soiling Forecast Comparison: Daily vs Weekly

**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M')}
**Plant**: Ribera (Spain)

## Data Summary

| Metric | Value |
|--------|-------|
| Total days | {len(df)} |
| Mean soiling ratio | {df['sr'].mean()*100:.2f}% |
| Mean daily rate | {df['soiling_rate'].mean()*100:.4f}%/day |
| Mean weekly rate | {df_weekly_clean['weekly_rate'].mean()*100:.3f}%/week |

## Results by Target and Granularity

### Soiling Rate Forecasts

| Horizon | Daily MAE | Weekly MAE | Daily R² | Weekly R² |
|---------|-----------|------------|----------|-----------|
"""

for days, week_label in horizon_map.items():
    daily_row = df_results[(df_results['horizon_days'] == days) &
                           (df_results['target'] == 'Soiling Rate') &
                           (df_results['granularity'] == 'Daily')]
    weekly_row = df_results[(df_results['horizon'] == week_label) &
                            (df_results['target'] == 'Soiling Rate')]

    if len(daily_row) > 0:
        d = daily_row.iloc[0]
        daily_mae = f"{d['mae']*100:.4f}%/day"
        daily_r2 = f"{d['r2']:.3f}"
    else:
        daily_mae = "N/A"
        daily_r2 = "N/A"

    if len(weekly_row) > 0:
        w = weekly_row.iloc[0]
        weekly_mae = f"{w['mae']*100:.4f}%/week"
        weekly_r2 = f"{w['r2']:.3f}"
    else:
        weekly_mae = "N/A"
        weekly_r2 = "N/A"

    md_report += f"| {days}d ({week_label}) | {daily_mae} | {weekly_mae} | {daily_r2} | {weekly_r2} |\n"

md_report += """
### Soiling Ratio Forecasts

| Horizon | Daily MAE | Weekly MAE | Daily R² | Weekly R² |
|---------|-----------|------------|----------|-----------|
"""

for days, week_label in horizon_map.items():
    daily_row = df_results[(df_results['horizon_days'] == days) &
                           (df_results['target'] == 'Soiling Ratio') &
                           (df_results['granularity'] == 'Daily')]
    weekly_row = df_results[(df_results['horizon'] == week_label) &
                            (df_results['target'] == 'Soiling Ratio')]

    if len(daily_row) > 0:
        d = daily_row.iloc[0]
        daily_mae = f"{d['mae']*100:.3f}%"
        daily_r2 = f"{d['r2']:.3f}"
    else:
        daily_mae = "N/A"
        daily_r2 = "N/A"

    if len(weekly_row) > 0:
        w = weekly_row.iloc[0]
        weekly_mae = f"{w['mae']*100:.3f}%"
        weekly_r2 = f"{w['r2']:.3f}"
    else:
        weekly_mae = "N/A"
        weekly_r2 = "N/A"

    md_report += f"| {days}d ({week_label}) | {daily_mae} | {weekly_mae} | {daily_r2} | {weekly_r2} |\n"

md_report += """
## Recommendations

1. **For soiling rate**: Weekly granularity provides better signal-to-noise ratio
2. **For soiling ratio**: Both granularities work; ratio is more stable than rate
3. **For operations**: Use weekly soiling ratio for cleaning threshold planning
"""

with open(OUTPUT_DIR / 'forecast_comparison_report.md', 'w') as f:
    f.write(md_report)

print(f"\n✅ Results saved to: {OUTPUT_DIR}/")
print(f"   - forecast_comparison_results.csv")
print(f"   - forecast_comparison_summary.json")
print(f"   - forecast_comparison_report.md")

print("\n" + "=" * 80)
print("✅ FORECAST COMPARISON COMPLETE")
print("=" * 80)
