"""
Analyze soiling forecast accuracy by magnitude of change from t=0.

This answers: Does the model forecast well when SR changes a lot vs when it's stable?
"""

import pandas as pd
import numpy as np
from pathlib import Path
import json

# Load the baseline results (better for 7-14d horizon)
results_dir = Path("outputs_enhanced_forecast")
results_file = results_dir / "baseline_vs_enhanced_results.csv"

print("="*80)
print("FORECAST ACCURACY BY CHANGE MAGNITUDE")
print("="*80)
print()

# Load results
df = pd.read_csv(results_file)

# Filter to baseline model only
df_base = df[df['model'] == 'baseline'].copy()

print(f"📊 Loaded {len(df_base)} forecasts from baseline model")
print()

# Calculate actual change from t=0 for each forecast
df_base['sr_change'] = df_base['sr_actual'] - df_base['sr_initial']
df_base['forecast_error'] = df_base['sr_pred'] - df_base['sr_actual']
df_base['abs_error'] = np.abs(df_base['forecast_error'])

# Create change magnitude bins
df_base['change_magnitude'] = pd.cut(
    np.abs(df_base['sr_change']),
    bins=[0, 0.01, 0.03, 0.05, 1.0],
    labels=['Stable (<1%)', 'Small (1-3%)', 'Medium (3-5%)', 'Large (>5%)']
)

# Also categorize by direction
df_base['change_direction'] = pd.cut(
    df_base['sr_change'],
    bins=[-1.0, -0.01, 0.01, 1.0],
    labels=['Cleaning (+)', 'Stable', 'Soiling (-)']
)

print("="*80)
print("ACCURACY BY CHANGE MAGNITUDE")
print("="*80)
print()

# Analyze by horizon and change magnitude
horizons = [1, 7, 14, 21, 28]

summary_results = []

for horizon in horizons:
    df_h = df_base[df_base['horizon'] == horizon].copy()

    print(f"📈 Horizon: {horizon}-day forecast")
    print("-" * 80)

    for magnitude in ['Stable (<1%)', 'Small (1-3%)', 'Medium (3-5%)', 'Large (>5%)']:
        df_mag = df_h[df_h['change_magnitude'] == magnitude]

        if len(df_mag) == 0:
            continue

        mae = df_mag['abs_error'].mean()
        rmse = np.sqrt((df_mag['forecast_error']**2).mean())

        # R² calculation
        ss_res = (df_mag['forecast_error']**2).sum()
        ss_tot = ((df_mag['sr_actual'] - df_mag['sr_actual'].mean())**2).sum()
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else -999

        # Bias (positive = overpredict, negative = underpredict)
        bias = df_mag['forecast_error'].mean()

        n = len(df_mag)
        pct = 100 * n / len(df_h)

        print(f"  {magnitude:20s} | N={n:4d} ({pct:4.1f}%) | MAE={mae:5.3f} | RMSE={rmse:5.3f} | R²={r2:6.3f} | Bias={bias:+6.3f}")

        summary_results.append({
            'horizon': horizon,
            'magnitude': magnitude,
            'n_samples': n,
            'pct_of_horizon': pct,
            'mae': mae,
            'rmse': rmse,
            'r2': r2,
            'bias': bias
        })

    print()

print("="*80)
print("ACCURACY BY CHANGE DIRECTION")
print("="*80)
print()

for horizon in horizons:
    df_h = df_base[df_base['horizon'] == horizon].copy()

    print(f"📈 Horizon: {horizon}-day forecast")
    print("-" * 80)

    for direction in ['Cleaning (+)', 'Stable', 'Soiling (-)']:
        df_dir = df_h[df_h['change_direction'] == direction]

        if len(df_dir) == 0:
            continue

        mae = df_dir['abs_error'].mean()
        bias = df_dir['forecast_error'].mean()
        r2 = 1 - ((df_dir['forecast_error']**2).sum() /
                  ((df_dir['sr_actual'] - df_dir['sr_actual'].mean())**2).sum())

        n = len(df_dir)
        pct = 100 * n / len(df_h)

        avg_change = df_dir['sr_change'].mean()

        print(f"  {direction:20s} | N={n:4d} ({pct:4.1f}%) | MAE={mae:5.3f} | R²={r2:6.3f} | Bias={bias:+6.3f} | Avg Δ={avg_change:+6.3f}")

    print()

print("="*80)
print("KEY INSIGHTS")
print("="*80)
print()

# Calculate correlation between change magnitude and error
for horizon in [7, 14]:  # Focus on key horizons
    df_h = df_base[df_base['horizon'] == horizon].copy()

    corr_change_error = df_h['sr_change'].abs().corr(df_h['abs_error'])
    corr_change_bias = df_h['sr_change'].corr(df_h['forecast_error'])

    print(f"📊 {horizon}-day horizon:")
    print(f"  Correlation(|change|, error): {corr_change_error:+.3f}")
    print(f"    → {'Higher' if corr_change_error > 0.3 else 'Moderate' if corr_change_error > 0.1 else 'Low'} correlation")
    print(f"  Correlation(change, bias): {corr_change_bias:+.3f}")
    print(f"    → Model {'underpredicts' if corr_change_bias < -0.1 else 'overpredicts' if corr_change_bias > 0.1 else 'unbiased'} during soiling")
    print()

# Find worst-case scenarios
print("⚠️  WORST-CASE SCENARIOS:")
print("-" * 80)

for horizon in [7, 14]:
    df_h = df_base[df_base['horizon'] == horizon].copy()

    # Large changes
    df_large = df_h[df_h['change_magnitude'].isin(['Medium (3-5%)', 'Large (>5%)'])]

    if len(df_large) > 0:
        mae_large = df_large['abs_error'].mean()
        mae_stable = df_h[df_h['change_magnitude'] == 'Stable (<1%)']['abs_error'].mean()

        degradation = (mae_large / mae_stable - 1) * 100 if mae_stable > 0 else 0

        print(f"{horizon}-day: MAE increases by {degradation:+.1f}% during large changes ({mae_stable:.3f} → {mae_large:.3f})")

print()

# Save detailed results
summary_df = pd.DataFrame(summary_results)
summary_df.to_csv(results_dir / "accuracy_by_change_magnitude.csv", index=False)

# Create JSON summary
summary_json = {
    'analysis_type': 'forecast_accuracy_by_change_magnitude',
    'key_findings': {
        '7d_stable_mae': float(summary_df[(summary_df['horizon']==7) & (summary_df['magnitude']=='Stable (<1%)')]['mae'].values[0]),
        '7d_large_mae': float(summary_df[(summary_df['horizon']==7) & (summary_df['magnitude'].isin(['Medium (3-5%)', 'Large (>5%)']))]['mae'].mean()),
        '14d_stable_mae': float(summary_df[(summary_df['horizon']==14) & (summary_df['magnitude']=='Stable (<1%)')]['mae'].values[0]),
        '14d_large_mae': float(summary_df[(summary_df['horizon']==14) & (summary_df['magnitude'].isin(['Medium (3-5%)', 'Large (>5%)']))]['mae'].mean()),
    },
    'by_horizon': summary_df.to_dict('records')
}

with open(results_dir / "accuracy_by_change_summary.json", 'w') as f:
    json.dump(summary_json, f, indent=2)

print("="*80)
print("✅ ANALYSIS COMPLETE")
print("="*80)
print()
print(f"📁 Results saved to: {results_dir}/")
print("   - accuracy_by_change_magnitude.csv")
print("   - accuracy_by_change_summary.json")
