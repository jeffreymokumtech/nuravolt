#!/usr/bin/env python3
"""Foundation Model for Soiling Ratio Prediction with Climate Categorical Feature.

Trains a single model on ALL plants together, using climate as a categorical feature.
Uses Leave-One-Plant-Out (LOPO) cross-validation to evaluate generalization.

Benefits over transfer learning:
- Larger training set (6 plants vs 1)
- Model learns shared patterns across all climates
- Climate feature allows differentiation
- More robust generalization
"""

import sys
import warnings
import json
import pickle
from pathlib import Path
from datetime import datetime
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pearsonr
from sklearn.metrics import r2_score

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.evaluate_transfer_enhanced import (
    load_plant_scada, load_plant_enhanced_features, PLANT_CONFIGS
)

# All plants with DustIQ sensors
PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

# Climate zones
PLANT_CLIMATE = {
    "epsilon": "temperate",
    "ribera": "semi-arid",
    "delta": "coastal",
    "zeta": "coastal",
    "gamma": "semi-arid",
    "eta": "semi-arid",
    "alpha": "semi-arid",
}

# Climate encoding for CatBoost
CLIMATE_ENCODING = {
    "temperate": 0,
    "coastal": 1,
    "semi-arid": 2,
}


def rolling_avg(arr, window=7):
    """Compute rolling average with NaN padding at start."""
    result = np.convolve(arr, np.ones(window)/window, mode='valid')
    pad = np.full(window-1, np.nan)
    return np.concatenate([pad, result])


def get_sample_weights(y_train):
    """Get sample weights tuned via Optuna (trial 95)."""
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 5.96       # Very dirty
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.45   # Dirty
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 1.80   # Moderate
    sample_weights[(y_train >= 0.98) & (y_train < 0.99)] = 2.76   # Light
    return sample_weights


def compute_metrics(y_pred, y_true, prefix=""):
    """Compute comprehensive metrics."""
    # 7-day rolling averages
    y_pred_7d = rolling_avg(y_pred, 7)
    y_true_7d = rolling_avg(y_true, 7)

    valid = ~(np.isnan(y_pred_7d) | np.isnan(y_true_7d))
    if valid.sum() < 10:
        return None

    y_p = y_pred_7d[valid]
    y_t = y_true_7d[valid]

    mae = np.mean(np.abs(y_p - y_t)) * 100
    rmse = np.sqrt(np.mean((y_p - y_t)**2)) * 100
    mbe = np.mean(y_p - y_t) * 100
    rho, _ = spearmanr(y_p, y_t)
    r_pearson, _ = pearsonr(y_p, y_t)
    r2 = r2_score(y_t, y_p)

    return {
        f'{prefix}mae': mae,
        f'{prefix}rmse': rmse,
        f'{prefix}mbe': mbe,
        f'{prefix}spearman': rho if not np.isnan(rho) else 0,
        f'{prefix}pearson': r_pearson if not np.isnan(r_pearson) else 0,
        f'{prefix}r2': r2 if not np.isnan(r2) else 0,
    }


def load_plant_data(plant_id: str, feature_cols: list = None):
    """Load features and SR for a single plant, adding climate column."""
    df_scada, sr = load_plant_scada(plant_id, use_cleaned=True)
    if df_scada is None:
        return None, None, None

    df_feat = load_plant_enhanced_features(plant_id, df_scada, include_hybrid=True)
    if df_feat is None:
        return None, None, None

    # Add climate as encoded integer
    climate = PLANT_CLIMATE[plant_id]
    df_feat['climate'] = CLIMATE_ENCODING[climate]

    # Align with SR
    common_idx = df_feat.index.intersection(sr.index)
    df_feat = df_feat.loc[common_idx]
    y = sr.loc[common_idx].values

    # If feature_cols specified, align columns
    if feature_cols is not None:
        missing = set(feature_cols) - set(df_feat.columns)
        for col in missing:
            df_feat[col] = 0
        df_feat = df_feat[feature_cols]

    return df_feat, y, common_idx


def load_multiple_plants(plant_ids: list, feature_cols: list = None):
    """Load and combine data from multiple plants."""
    all_X = []
    all_y = []
    all_dates = []
    all_plant_ids = []

    for plant_id in plant_ids:
        df_feat, y, dates = load_plant_data(plant_id, feature_cols)
        if df_feat is not None:
            all_X.append(df_feat)
            all_y.append(y)
            all_dates.extend(dates)
            all_plant_ids.extend([plant_id] * len(y))

    if not all_X:
        return None, None, None, None

    X_combined = pd.concat(all_X, ignore_index=True)
    y_combined = np.concatenate(all_y)

    return X_combined, y_combined, all_dates, all_plant_ids


def train_foundation_model(X_train_df, y_train, climate_col_name='climate'):
    """Train CatBoost with climate as categorical feature."""
    from catboost import CatBoostRegressor, Pool

    sample_weights = get_sample_weights(y_train)

    # Ensure climate column is integer type for CatBoost categorical handling
    X_train_df = X_train_df.copy()
    X_train_df[climate_col_name] = X_train_df[climate_col_name].astype(int)

    # Create CatBoost Pool with categorical feature specified
    train_pool = Pool(
        data=X_train_df,
        label=y_train,
        weight=sample_weights,
        cat_features=[climate_col_name],
    )

    # CatBoost params tuned via Optuna (backenddata/tuning/tuning_results.json)
    model = CatBoostRegressor(
        iterations=677,
        learning_rate=0.0069,
        depth=8,
        l2_leaf_reg=6.88,
        min_data_in_leaf=29,
        random_seed=42,
        verbose=False,
    )
    model.fit(train_pool, verbose=False)
    return model


def leave_one_plant_out_cv():
    """Perform Leave-One-Plant-Out cross-validation."""
    print("\n" + "="*60)
    print("Foundation Model: Leave-One-Plant-Out Cross-Validation")
    print("="*60)

    results = {}

    # First, get feature columns from first plant to ensure consistency
    df_feat_ref, _, _ = load_plant_data(PLANTS[0])
    if df_feat_ref is None:
        print("ERROR: Could not load reference plant data")
        return None, None

    feature_cols = df_feat_ref.columns.tolist()
    climate_col_idx = feature_cols.index('climate')
    print(f"\nFeature columns: {len(feature_cols)} (climate at index {climate_col_idx})")

    all_predictions = {}

    for target_plant in PLANTS:
        print(f"\n--- Target: {target_plant} ({PLANT_CLIMATE[target_plant]}) ---")

        # Train on all plants except target
        train_plants = [p for p in PLANTS if p != target_plant]
        print(f"  Training on: {', '.join(train_plants)}")

        X_train, y_train, _, _ = load_multiple_plants(train_plants, feature_cols)
        if X_train is None:
            print(f"  ERROR: Could not load training data")
            continue

        print(f"  Training samples: {len(y_train)}")

        # Load test data (target plant)
        X_test, y_test, dates_test, _ = load_multiple_plants([target_plant], feature_cols)
        if X_test is None:
            print(f"  ERROR: Could not load test data")
            continue

        print(f"  Test samples: {len(y_test)}")

        # Train model (pass DataFrame directly for categorical support)
        model = train_foundation_model(X_train, y_train, climate_col_name='climate')

        # Predict (ensure climate is int for prediction too)
        X_test_copy = X_test.copy()
        X_test_copy['climate'] = X_test_copy['climate'].astype(int)
        y_pred = model.predict(X_test_copy)

        # Compute metrics BEFORE bias correction
        metrics_raw = compute_metrics(y_pred, y_test, prefix="raw_")

        # Apply bias correction
        pred_7d = rolling_avg(y_pred, 7)
        actual_7d = rolling_avg(y_test, 7)
        valid = ~(np.isnan(pred_7d) | np.isnan(actual_7d))
        bias = np.nanmean(pred_7d[valid] - actual_7d[valid])

        y_pred_corrected = y_pred - bias

        # Compute metrics AFTER bias correction
        metrics_corrected = compute_metrics(y_pred_corrected, y_test, prefix="")

        if metrics_corrected:
            results[target_plant] = {
                'climate': PLANT_CLIMATE[target_plant],
                'n_train': len(y_train),
                'n_test': len(y_test),
                'bias_correction': float(bias),
                **metrics_raw,
                **metrics_corrected,
            }

            print(f"  Bias correction: {bias*100:+.2f}%")
            print(f"  MAE: {metrics_corrected['mae']:.2f}% (raw: {metrics_raw['raw_mae']:.2f}%)")
            print(f"  Spearman ρ: {metrics_corrected['spearman']:.3f}")
            print(f"  MBE: {metrics_corrected['mbe']:.2f}%")

            all_predictions[target_plant] = {
                'dates': [str(d) for d in dates_test],
                'actual': y_test.tolist(),
                'predicted': y_pred.tolist(),
                'predicted_corrected': y_pred_corrected.tolist(),
            }

    return results, all_predictions, feature_cols


def train_full_model(feature_cols):
    """Train model on ALL plants for production use."""
    print("\n" + "="*60)
    print("Training Full Foundation Model (All Plants)")
    print("="*60)

    X_all, y_all, _, _ = load_multiple_plants(PLANTS, feature_cols)
    if X_all is None:
        return None, None

    print(f"Total training samples: {len(y_all)}")

    model = train_foundation_model(X_all, y_all, climate_col_name='climate')

    # Get feature importance
    importance = model.get_feature_importance()
    feature_importance = pd.DataFrame({
        'feature': feature_cols,
        'importance': importance
    }).sort_values('importance', ascending=False)

    return model, feature_importance


def generate_html_report(results, predictions, feature_importance, output_path):
    """Generate interactive HTML report with Plotly."""
    import json

    html = '''<!DOCTYPE html>
<html>
<head>
    <title>Foundation Model - Climate Categorical</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        h2 { color: #555; margin-top: 40px; border-bottom: 2px solid #ddd; padding-bottom: 10px; }
        .summary { background: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .plot-container { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; background: white; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: center; }
        th { background: #2196F3; color: white; }
        .good { background: #c8e6c9; }
        .warning { background: #fff9c4; }
        .bad { background: #ffcdd2; }
    </style>
</head>
<body>
    <h1>Foundation Model: Soiling Ratio Prediction with Climate Feature</h1>

    <div class="summary">
        <strong>Approach:</strong> Single model trained on ALL plants together with climate as a categorical feature.<br>
        <strong>Evaluation:</strong> Leave-One-Plant-Out cross-validation (train on 6 plants, test on 1).<br>
        <strong>Climate Categories:</strong> temperate (0), coastal (1), semi-arid (2)
    </div>

    <h2>LOPO Cross-Validation Results</h2>
    <table>
        <tr>
            <th>Target Plant</th>
            <th>Climate</th>
            <th>Test Days</th>
            <th>Bias Corr.</th>
            <th>MAE (%)</th>
            <th>RMSE (%)</th>
            <th>MBE (%)</th>
            <th>Spearman ρ</th>
            <th>R²</th>
        </tr>
'''

    for plant, r in results.items():
        mae_cls = 'good' if r['mae'] < 1.0 else ('warning' if r['mae'] < 2.0 else 'bad')
        rho_cls = 'good' if r['spearman'] > 0.5 else ('warning' if r['spearman'] > 0.2 else 'bad')

        html += f'''<tr>
            <td><strong>{plant}</strong></td>
            <td>{r['climate']}</td>
            <td>{r['n_test']}</td>
            <td>{r['bias_correction']*100:+.2f}%</td>
            <td class="{mae_cls}">{r['mae']:.2f}</td>
            <td>{r['rmse']:.2f}</td>
            <td>{r['mbe']:.2f}</td>
            <td class="{rho_cls}">{r['spearman']:.2f}</td>
            <td>{r['r2']:.2f}</td>
        </tr>'''

    # Summary row
    mean_mae = np.mean([r['mae'] for r in results.values()])
    mean_rho = np.mean([r['spearman'] for r in results.values()])
    mean_r2 = np.mean([r['r2'] for r in results.values()])

    html += f'''<tr style="background: #e3f2fd; font-weight: bold;">
        <td colspan="4">MEAN</td>
        <td>{mean_mae:.2f}</td>
        <td></td>
        <td></td>
        <td>{mean_rho:.2f}</td>
        <td>{mean_r2:.2f}</td>
    </tr>
    </table>'''

    # Feature importance
    html += '''
    <h2>Top 15 Feature Importance</h2>
    <table>
        <tr><th>Rank</th><th>Feature</th><th>Importance</th></tr>
'''
    for i, (_, row) in enumerate(feature_importance.head(15).iterrows()):
        html += f'<tr><td>{i+1}</td><td>{row["feature"]}</td><td>{row["importance"]:.2f}</td></tr>'
    html += '</table>'

    # Time series plots
    html += '''
    <h2>Time Series Plots</h2>
'''

    colors = {
        'epsilon': '#1f77b4', 'ribera': '#ff7f0e', 'delta': '#2ca02c',
        'zeta': '#d62728', 'gamma': '#9467bd', 'eta': '#8c564b', 'alpha': '#e377c2'
    }

    for plant in PLANTS:
        if plant not in predictions:
            continue

        pred = predictions[plant]
        r = results[plant]

        html += f'''
    <h3>{plant.upper()} ({r['climate']})</h3>
    <div class="plot-container">
        <div id="plot_{plant}" style="width:100%;height:400px;"></div>
    </div>
'''

    html += '''<script>'''

    for plant in PLANTS:
        if plant not in predictions:
            continue

        pred = predictions[plant]
        actual_7d = rolling_avg(np.array(pred['actual']), 7).tolist()
        pred_7d = rolling_avg(np.array(pred['predicted_corrected']), 7).tolist()

        r = results[plant]

        traces = [
            {
                'x': pred['dates'],
                'y': actual_7d,
                'name': 'Actual SR (7d)',
                'type': 'scatter',
                'mode': 'lines',
                'line': {'color': 'black', 'width': 2},
            },
            {
                'x': pred['dates'],
                'y': pred_7d,
                'name': f"Foundation Model (MAE:{r['mae']:.1f}% ρ={r['spearman']:.2f})",
                'type': 'scatter',
                'mode': 'lines',
                'line': {'color': '#2196F3', 'width': 2},
            }
        ]

        html += f'''
        Plotly.newPlot('plot_{plant}', {json.dumps(traces)}, {{
            title: '{plant.upper()} - Foundation Model Prediction',
            xaxis: {{ title: 'Date', type: 'date' }},
            yaxis: {{ title: 'Soiling Ratio', range: [0.85, 1.02] }},
            hovermode: 'x unified',
            shapes: [{{
                type: 'line', x0: '{pred["dates"][0]}', x1: '{pred["dates"][-1]}',
                y0: 0.95, y1: 0.95, line: {{ color: 'red', width: 1, dash: 'dash' }}
            }}]
        }});
'''

    html += '''</script>
</body>
</html>'''

    Path(output_path).write_text(html)
    print(f"\nHTML report saved to: {output_path}")


def main():
    """Main entry point."""
    print("="*60)
    print("Foundation Model with Climate Categorical Feature")
    print("="*60)
    print(f"\nPlants: {', '.join(PLANTS)}")
    print(f"Climates: {set(PLANT_CLIMATE.values())}")

    # Run LOPO cross-validation
    results, predictions, feature_cols = leave_one_plant_out_cv()

    if results is None:
        print("ERROR: LOPO evaluation failed")
        return

    # Train full model on all plants
    full_model, feature_importance = train_full_model(feature_cols)

    # Create output directory
    output_dir = Path('backenddata/foundation_model')
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save results
    results_path = output_dir / 'foundation_model_results.json'
    with open(results_path, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'plants': PLANTS,
            'climate_encoding': CLIMATE_ENCODING,
            'results': results,
            'summary': {
                'mean_mae': np.mean([r['mae'] for r in results.values()]),
                'mean_spearman': np.mean([r['spearman'] for r in results.values()]),
                'mean_r2': np.mean([r['r2'] for r in results.values()]),
            }
        }, f, indent=2)
    print(f"\nResults saved to: {results_path}")

    # Save feature importance
    importance_path = output_dir / 'feature_importance.csv'
    feature_importance.to_csv(importance_path, index=False)
    print(f"Feature importance saved to: {importance_path}")

    # Save full model
    model_path = output_dir / 'foundation_model.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump({
            'model': full_model,
            'feature_cols': feature_cols,
            'climate_encoding': CLIMATE_ENCODING,
        }, f)
    print(f"Model saved to: {model_path}")

    # Generate HTML report
    html_path = output_dir / 'foundation_predictions.html'
    generate_html_report(results, predictions, feature_importance, html_path)

    # Print summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"\n{'Plant':<15} {'Climate':<12} {'MAE (%)':<10} {'ρ':<8} {'R²':<8}")
    print("-"*55)
    for plant, r in results.items():
        print(f"{plant:<15} {r['climate']:<12} {r['mae']:<10.2f} {r['spearman']:<8.2f} {r['r2']:<8.2f}")

    mean_mae = np.mean([r['mae'] for r in results.values()])
    mean_rho = np.mean([r['spearman'] for r in results.values()])
    mean_r2 = np.mean([r['r2'] for r in results.values()])
    print("-"*55)
    print(f"{'MEAN':<15} {'':<12} {mean_mae:<10.2f} {mean_rho:<8.2f} {mean_r2:<8.2f}")


if __name__ == "__main__":
    main()
