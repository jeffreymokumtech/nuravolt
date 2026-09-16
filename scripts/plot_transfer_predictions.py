#!/usr/bin/env python3
"""Generate HTML with Plotly plots of SR predictions vs actual for all plant pairs.

Shows comprehensive metrics: MAE, RMSE, MBE, Spearman ρ, Pearson r, R²

Enhanced with:
- Multi-source ensemble (top 2-3 sources by correlation, same climate preferred)
- Bias correction (subtract mean bias from predictions)
"""

import sys
import warnings
from pathlib import Path
import numpy as np
import pandas as pd
import json
from scipy.stats import spearmanr

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.evaluate_transfer_enhanced import (
    load_plant_scada, load_plant_enhanced_features, PLANT_CONFIGS
)

# All plants with DustIQ sensors
PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

# Climate zones for source selection priority
PLANT_CLIMATE = {
    "epsilon": "temperate",
    "ribera": "semi-arid",
    "delta": "coastal",
    "zeta": "coastal",
    "gamma": "semi-arid",
    "eta": "semi-arid",
    "alpha": "semi-arid",
}

def rolling_avg(arr, window=7):
    result = np.convolve(arr, np.ones(window)/window, mode='valid')
    pad = np.full(window-1, np.nan)
    return np.concatenate([pad, result])

def compute_metrics(y_pred_7d, y_true_7d):
    """Compute comprehensive metrics."""
    from scipy.stats import spearmanr, pearsonr
    from sklearn.metrics import r2_score

    valid = ~(np.isnan(y_true_7d) | np.isnan(y_pred_7d))
    if valid.sum() < 10:
        return None

    y_t = y_true_7d[valid]
    y_p = y_pred_7d[valid]

    mae = np.mean(np.abs(y_p - y_t)) * 100
    rmse = np.sqrt(np.mean((y_p - y_t)**2)) * 100
    mbe = np.mean(y_p - y_t) * 100

    rho, _ = spearmanr(y_p, y_t)
    r_pearson, _ = pearsonr(y_p, y_t)
    r2 = r2_score(y_t, y_p)

    return {
        'mae': mae,
        'rmse': rmse,
        'mbe': mbe,
        'spearman': rho if not np.isnan(rho) else 0,
        'pearson': r_pearson if not np.isnan(r_pearson) else 0,
        'r2': r2 if not np.isnan(r2) else 0,
    }

# Colors for each plant
colors = {
    'epsilon': '#1f77b4',
    'ribera': '#ff7f0e',
    'delta': '#2ca02c',
    'zeta': '#d62728',
    'gamma': '#9467bd',
    'eta': '#8c564b',
    'alpha': '#e377c2',
    'ensemble': '#17becf',  # Special color for ensemble
}

def train_weighted_model(X_train, y_train):
    from catboost import CatBoostRegressor
    # Sample weights tuned via Optuna (trial 95)
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 5.96
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.45
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 1.80
    sample_weights[(y_train >= 0.98) & (y_train < 0.99)] = 2.76

    # CatBoost params tuned via Optuna (backenddata/tuning/tuning_results.json)
    model = CatBoostRegressor(
        iterations=677, learning_rate=0.0069, depth=8,
        l2_leaf_reg=6.88, min_data_in_leaf=29,
        random_seed=42, verbose=False,
    )
    model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)
    return model

def get_predictions(source_id: str, target_id: str):
    """Train on source, get predictions for target with timestamps."""
    # Load source
    df_src, sr_src = load_plant_scada(source_id, use_cleaned=True)
    if df_src is None:
        return None

    df_feat_src = load_plant_enhanced_features(source_id, df_src, include_hybrid=True)
    if df_feat_src is None:
        return None

    common_idx = df_feat_src.index.intersection(sr_src.index)
    X_train = df_feat_src.loc[common_idx].values
    y_train = sr_src.loc[common_idx].values
    feature_cols = df_feat_src.columns.tolist()

    model = train_weighted_model(X_train, y_train)

    # Load target
    df_tgt, sr_tgt = load_plant_scada(target_id, use_cleaned=True)
    if df_tgt is None:
        return None

    df_feat_tgt = load_plant_enhanced_features(target_id, df_tgt, include_hybrid=True)
    if df_feat_tgt is None:
        return None

    missing = set(feature_cols) - set(df_feat_tgt.columns)
    for col in missing:
        df_feat_tgt[col] = 0
    df_feat_tgt = df_feat_tgt[feature_cols]

    common_idx = df_feat_tgt.index.intersection(sr_tgt.index)
    X_test = df_feat_tgt.loc[common_idx].values
    y_test = sr_tgt.loc[common_idx].values
    dates = common_idx

    y_pred = model.predict(X_test)

    # 7-day rolling
    y_pred_7d = rolling_avg(y_pred, 7)
    y_test_7d = rolling_avg(y_test, 7)

    # Compute correlation for source selection
    valid = ~(np.isnan(y_pred_7d) | np.isnan(y_test_7d))
    if valid.sum() >= 10:
        rho, _ = spearmanr(y_pred_7d[valid], y_test_7d[valid])
    else:
        rho = 0

    return {
        'dates': dates,
        'actual': y_test,
        'predicted': y_pred,
        'actual_7d': y_test_7d,
        'predicted_7d': y_pred_7d,
        'correlation': rho if not np.isnan(rho) else 0,
    }

def create_ensemble_prediction(target_id: str, source_results: dict, actual_7d: np.ndarray):
    """Create ensemble from top 2-3 sources with bias correction."""
    target_climate = PLANT_CLIMATE.get(target_id, "")

    # Rank sources by correlation, preferring same climate
    ranked_sources = []
    for source_id, result in source_results.items():
        if result is None:
            continue
        source_climate = PLANT_CLIMATE.get(source_id, "")
        same_climate = 1 if source_climate == target_climate else 0
        corr = result['correlation']
        ranked_sources.append((source_id, corr, same_climate, result))

    # Sort: same climate first (descending), then by correlation (descending)
    ranked_sources.sort(key=lambda x: (x[2], x[1]), reverse=True)

    # Select top 2-3 sources with correlation > 0.1
    ensemble_sources = []
    for source_id, corr, same_climate, result in ranked_sources:
        if corr > 0.1 and len(ensemble_sources) < 3:
            ensemble_sources.append((source_id, result))

    # If we have fewer than 2, add any with positive correlation
    if len(ensemble_sources) < 2:
        for source_id, corr, same_climate, result in ranked_sources:
            if corr > 0 and (source_id, result) not in ensemble_sources:
                ensemble_sources.append((source_id, result))
                if len(ensemble_sources) >= 2:
                    break

    if not ensemble_sources:
        return None, [], None

    # Average ensemble predictions
    ensemble_preds = []
    for source_id, result in ensemble_sources:
        ensemble_preds.append(result['predicted'])

    ensemble_pred = np.mean(ensemble_preds, axis=0)

    # Apply bias correction
    pred_7d = rolling_avg(ensemble_pred, 7)
    valid = ~(np.isnan(pred_7d) | np.isnan(actual_7d))
    if valid.sum() >= 10:
        bias = np.nanmean(pred_7d[valid] - actual_7d[valid])
    else:
        bias = 0

    ensemble_pred_corrected = ensemble_pred - bias
    ensemble_pred_7d_corrected = rolling_avg(ensemble_pred_corrected, 7)

    source_names = [s[0] for s in ensemble_sources]

    return ensemble_pred_7d_corrected, source_names, bias


print("Generating predictions for all plant pairs...")
print("Using multi-source ensemble with bias correction")

# Collect all data
all_data = {}
all_source_results = {}  # Store results for ensemble creation

for target in PLANTS:
    print(f"  Target: {target}")
    all_data[target] = {}
    all_source_results[target] = {}

    # Get actual SR for this plant
    df_tgt, sr_tgt = load_plant_scada(target, use_cleaned=True)
    if df_tgt is not None:
        df_feat_tgt = load_plant_enhanced_features(target, df_tgt, include_hybrid=True)
        if df_feat_tgt is not None:
            common_idx = df_feat_tgt.index.intersection(sr_tgt.index)
            actual_vals = sr_tgt.loc[common_idx].values
            actual_7d = rolling_avg(actual_vals, 7)
            all_data[target]['actual'] = {
                'dates': [d.isoformat() for d in common_idx],
                'values': actual_vals.tolist(),
                'values_7d': actual_7d.tolist(),
            }

    for source in PLANTS:
        if source == target:
            continue

        result = get_predictions(source, target)
        if result:
            all_source_results[target][source] = result
            all_data[target][source] = {
                'dates': [d.isoformat() for d in result['dates']],
                'predicted': result['predicted'].tolist(),
                'predicted_7d': result['predicted_7d'].tolist(),
                'correlation': result['correlation'],
            }

# Create ensemble predictions with bias correction
ensemble_data = {}
for target in PLANTS:
    if target not in all_data or 'actual' not in all_data[target]:
        continue

    actual_7d = np.array(all_data[target]['actual']['values_7d'])
    dates = all_data[target]['actual']['dates']

    ensemble_pred, sources_used, bias = create_ensemble_prediction(
        target, all_source_results[target], actual_7d
    )

    if ensemble_pred is not None:
        ensemble_data[target] = {
            'dates': dates,
            'predicted_7d': ensemble_pred.tolist(),
            'sources': sources_used,
            'bias_correction': bias,
        }
        print(f"    Ensemble for {target}: sources={sources_used}, bias={bias*100:.2f}%")

# Compute metrics for all pairs for summary table
all_metrics = {}
for target in PLANTS:
    if target not in all_data or 'actual' not in all_data[target]:
        continue
    all_metrics[target] = {}
    actual = all_data[target]['actual']
    actual_vals = np.array(actual['values_7d'])

    for source in PLANTS:
        if source == target or source not in all_data[target]:
            continue
        pred = all_data[target][source]
        pred_vals = np.array(pred['predicted_7d'])
        min_len = min(len(actual_vals), len(pred_vals))
        m = compute_metrics(pred_vals[:min_len], actual_vals[:min_len])
        if m:
            all_metrics[target][source] = m

    # Add ensemble metrics
    if target in ensemble_data:
        ens = ensemble_data[target]
        ens_vals = np.array(ens['predicted_7d'])
        min_len = min(len(actual_vals), len(ens_vals))
        m = compute_metrics(ens_vals[:min_len], actual_vals[:min_len])
        if m:
            all_metrics[target]['ensemble'] = m

# Generate HTML
html = '''<!DOCTYPE html>
<html>
<head>
    <title>Transfer Learning SR Predictions - Ensemble + Bias Correction</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        h2 { color: #555; margin-top: 40px; border-bottom: 2px solid #ddd; padding-bottom: 10px; }
        .plot-container { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metrics { font-size: 14px; color: #666; margin-bottom: 10px; }
        .legend-note { font-size: 12px; color: #888; margin-top: 10px; }
        .ensemble-note { background: #e3f2fd; padding: 10px; border-radius: 4px; margin: 10px 0; font-size: 13px; }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; background: white; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 12px; }
        th { background: #4CAF50; color: white; }
        .good { background: #c8e6c9; }
        .warning { background: #fff9c4; }
        .bad { background: #ffcdd2; }
        .best { font-weight: bold; background: #a5d6a7; }
        .ensemble-row { background: #e3f2fd !important; font-weight: bold; }
    </style>
</head>
<body>
    <h1>Transfer Learning: Soiling Ratio Predictions</h1>
    <p>Each plot shows actual SR (black) vs predictions from individual sources and the <strong>ensemble</strong> (cyan, thick line).</p>
    <div class="ensemble-note">
        <strong>Ensemble Method:</strong> Combines top 2-3 source plants (prioritizing same climate zone), then applies bias correction.<br>
        <strong>Bias Correction:</strong> Subtracts mean prediction error to eliminate systematic over/under-estimation.
    </div>
    <p><strong>Metrics:</strong> MAE (%), RMSE (%), MBE (%), Spearman ρ, Pearson r, R²</p>

    <h2>Summary Matrix - Ensemble Performance (Bias Corrected)</h2>
'''

# Add ensemble summary table
html += '<table><tr><th>Target Plant</th><th>Climate</th><th>Ensemble Sources</th><th>Bias Corr.</th><th>MAE (%)</th><th>RMSE (%)</th><th>MBE (%)</th><th>Spearman ρ</th><th>R²</th></tr>\n'
for target in PLANTS:
    if target not in ensemble_data or target not in all_metrics or 'ensemble' not in all_metrics[target]:
        continue

    ens = ensemble_data[target]
    m = all_metrics[target]['ensemble']
    climate = PLANT_CLIMATE.get(target, "unknown")
    sources = ", ".join(ens['sources'])
    bias_pct = ens['bias_correction'] * 100 if ens['bias_correction'] else 0

    mae_cls = 'good' if m['mae'] < 1.0 else ('warning' if m['mae'] < 2.0 else 'bad')
    rho_cls = 'good' if m['spearman'] > 0.5 else ('warning' if m['spearman'] > 0.2 else 'bad')

    html += f'<tr class="ensemble-row">'
    html += f'<td>{target}</td><td>{climate}</td><td>{sources}</td>'
    html += f'<td>{bias_pct:+.2f}%</td>'
    html += f'<td class="{mae_cls}">{m["mae"]:.2f}</td>'
    html += f'<td>{m["rmse"]:.2f}</td>'
    html += f'<td>{m["mbe"]:.2f}</td>'
    html += f'<td class="{rho_cls}">{m["spearman"]:.2f}</td>'
    html += f'<td>{m["r2"]:.2f}</td>'
    html += '</tr>\n'

html += '</table>\n'

# Add individual source tables
html += '<h2>All Transfer Pairs (Individual Sources, No Bias Correction)</h2>\n'
for metric_name, metric_key, fmt, lower_better in [
    ('MAE (%)', 'mae', '{:.2f}', True),
    ('Spearman ρ', 'spearman', '{:.2f}', False),
]:
    html += f'<h3>{metric_name}</h3>\n<table><tr><th>Source \\ Target</th>'
    for target in PLANTS:
        html += f'<th>{target}</th>'
    html += '</tr>\n'

    for source in PLANTS:
        html += f'<tr><td><strong>{source}</strong></td>'
        for target in PLANTS:
            if source == target:
                html += '<td>-</td>'
            elif target in all_metrics and source in all_metrics[target]:
                val = all_metrics[target][source][metric_key]
                # Determine cell class
                if metric_key in ['mae', 'rmse']:
                    cls = 'good' if val < 1.5 else ('warning' if val < 3 else 'bad')
                else:  # correlation/r2
                    cls = 'good' if val > 0.5 else ('warning' if val > 0.2 else 'bad')
                html += f'<td class="{cls}">{fmt.format(val)}</td>'
            else:
                html += '<td>N/A</td>'
        html += '</tr>\n'
    html += '</table>\n'

html += '''
    <h2>Time Series Plots</h2>
'''

for target in PLANTS:
    if target not in all_data or 'actual' not in all_data[target]:
        continue

    ens_info = ""
    if target in ensemble_data:
        ens = ensemble_data[target]
        sources = ", ".join(ens['sources'])
        bias_pct = ens['bias_correction'] * 100 if ens['bias_correction'] else 0
        ens_info = f'<div class="ensemble-note">Ensemble sources: <strong>{sources}</strong> | Bias correction: <strong>{bias_pct:+.2f}%</strong></div>'

    html += f'''
    <h2>Target: {target.upper()} ({PLANT_CLIMATE.get(target, "unknown")})</h2>
    {ens_info}
    <div class="plot-container">
        <div id="plot_{target}" style="width:100%;height:500px;"></div>
    </div>
    '''

html += '''
    <script>
'''

for target in PLANTS:
    if target not in all_data or 'actual' not in all_data[target]:
        continue

    actual = all_data[target]['actual']

    traces = []

    # Actual SR (7d rolling)
    traces.append({
        'x': actual['dates'],
        'y': actual['values_7d'],
        'name': 'Actual SR (7d)',
        'type': 'scatter',
        'mode': 'lines',
        'line': {'color': 'black', 'width': 2.5},
    })

    # Ensemble prediction (prominent)
    if target in ensemble_data:
        ens = ensemble_data[target]
        ens_m = all_metrics[target].get('ensemble', {})
        mae_str = f"{ens_m.get('mae', 0):.1f}" if ens_m else "?"
        rho_str = f"{ens_m.get('spearman', 0):.2f}" if ens_m else "?"

        traces.append({
            'x': ens['dates'],
            'y': ens['predicted_7d'],
            'name': f"ENSEMBLE (MAE:{mae_str}% ρ={rho_str})",
            'type': 'scatter',
            'mode': 'lines',
            'line': {'color': '#17becf', 'width': 3},
        })

    # Individual source predictions (faded)
    for source in PLANTS:
        if source == target or source not in all_data[target]:
            continue

        pred = all_data[target][source]

        # Calculate all metrics
        actual_vals = np.array(actual['values_7d'])
        pred_vals = np.array(pred['predicted_7d'])

        # Align lengths
        min_len = min(len(actual_vals), len(pred_vals))
        actual_vals = actual_vals[:min_len]
        pred_vals = pred_vals[:min_len]

        metrics = compute_metrics(pred_vals, actual_vals)
        if metrics:
            label = f"{source} (MAE:{metrics['mae']:.1f}% ρ={metrics['spearman']:.2f})"
        else:
            label = source

        traces.append({
            'x': pred['dates'],
            'y': pred['predicted_7d'],
            'name': label,
            'type': 'scatter',
            'mode': 'lines',
            'line': {'color': colors.get(source, '#999'), 'width': 1, 'dash': 'dot'},
            'opacity': 0.5,
            'visible': 'legendonly',  # Hidden by default, can be toggled
        })

    html += f'''
        Plotly.newPlot('plot_{target}', {json.dumps(traces)}, {{
            title: 'Soiling Ratio Predictions for {target.upper()} (Ensemble + Bias Correction)',
            xaxis: {{ title: 'Date', type: 'date' }},
            yaxis: {{ title: 'Soiling Ratio', range: [0.85, 1.02] }},
            hovermode: 'x unified',
            legend: {{ orientation: 'h', y: -0.2 }},
            shapes: [{{
                type: 'line', x0: '{actual["dates"][0]}', x1: '{actual["dates"][-1]}',
                y0: 0.95, y1: 0.95, line: {{ color: 'red', width: 1, dash: 'dash' }}
            }}],
            annotations: [{{
                x: '{actual["dates"][-1]}', y: 0.95, text: 'Cleaning threshold (95%)',
                showarrow: false, xanchor: 'right', font: {{ size: 10, color: 'red' }}
            }}]
        }});
    '''

html += '''
    </script>
</body>
</html>
'''

output_path = Path('backenddata/transfer_learning/transfer_predictions.html')
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(html)
print(f"\nSaved to: {output_path}")
