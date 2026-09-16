#!/usr/bin/env python3
"""Test pairwise transfer between plants with detailed metrics."""

import sys
import warnings
from pathlib import Path
import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.evaluate_transfer_enhanced import (
    load_plant_scada, load_plant_enhanced_features, 
    SR_BINS, PLANT_CONFIGS
)

# Plants with decent data
PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma"]

def rolling_avg(arr, window=7):
    """Compute rolling average."""
    result = np.convolve(arr, np.ones(window)/window, mode='valid')
    # Pad beginning to match length
    pad = np.full(window-1, np.nan)
    return np.concatenate([pad, result])

def evaluate_detailed(model, X_test, y_test):
    """Evaluate with MAE, MBE, and worst errors by SR bin."""
    y_pred = model.predict(X_test)
    
    # 7-day rolling
    y_pred_7d = rolling_avg(y_pred, 7)
    y_test_7d = rolling_avg(y_test, 7)
    
    # Remove NaN from rolling
    valid = ~(np.isnan(y_pred_7d) | np.isnan(y_test_7d))
    y_pred_7d = y_pred_7d[valid]
    y_test_7d = y_test_7d[valid]
    
    errors_7d = y_pred_7d - y_test_7d  # positive = overprediction (predicts dirtier)
    
    # Overall metrics
    mae_7d = np.mean(np.abs(errors_7d))
    mbe_7d = np.mean(errors_7d)  # positive = model predicts dirtier than actual
    worst_over = np.max(errors_7d)  # worst overprediction
    worst_under = np.min(errors_7d)  # worst underprediction
    
    # By SR bin
    bins_result = {}
    for low, high, label in SR_BINS:
        mask = (y_test_7d >= low) & (y_test_7d < high)
        if mask.sum() > 0:
            bin_errors = errors_7d[mask]
            bins_result[label] = {
                "mae": float(np.mean(np.abs(bin_errors))),
                "mbe": float(np.mean(bin_errors)),
                "worst_over": float(np.max(bin_errors)),
                "worst_under": float(np.min(bin_errors)),
                "count": int(mask.sum()),
            }
    
    return {
        "mae_7d": float(mae_7d),
        "mbe_7d": float(mbe_7d),
        "worst_over": float(worst_over),
        "worst_under": float(worst_under),
        "bins": bins_result,
    }

def train_weighted_model(X_train, y_train):
    """Train CatBoost with dirty-day weighting."""
    from catboost import CatBoostRegressor
    
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 10.0
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.0
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 3.0
    sample_weights[(y_train >= 0.98) & (y_train < 0.99)] = 2.0
    
    model = CatBoostRegressor(
        iterations=300, learning_rate=0.02, depth=4,
        l2_leaf_reg=10.0, min_data_in_leaf=20,
        random_seed=42, verbose=False,
    )
    model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)
    return model

def evaluate_pair(source_id: str, target_id: str):
    """Train on source, evaluate on target."""
    # Load source
    df_src, sr_src = load_plant_scada(source_id, use_cleaned=True)
    if df_src is None:
        return None
    
    df_feat_src = load_plant_enhanced_features(source_id, df_src, include_hybrid=True)
    if df_feat_src is None:
        return None
    
    # Align
    common_idx = df_feat_src.index.intersection(sr_src.index)
    X_train = df_feat_src.loc[common_idx].values
    y_train = sr_src.loc[common_idx].values
    feature_cols = df_feat_src.columns.tolist()
    
    # Train
    model = train_weighted_model(X_train, y_train)
    
    # Load target
    df_tgt, sr_tgt = load_plant_scada(target_id, use_cleaned=True)
    if df_tgt is None:
        return None
    
    df_feat_tgt = load_plant_enhanced_features(target_id, df_tgt, include_hybrid=True)
    if df_feat_tgt is None:
        return None
    
    # Align target features to source features
    missing = set(feature_cols) - set(df_feat_tgt.columns)
    for col in missing:
        df_feat_tgt[col] = 0
    df_feat_tgt = df_feat_tgt[feature_cols]
    
    common_idx = df_feat_tgt.index.intersection(sr_tgt.index)
    X_test = df_feat_tgt.loc[common_idx].values
    y_test = sr_tgt.loc[common_idx].values
    
    # Evaluate
    result = evaluate_detailed(model, X_test, y_test)
    return result

def format_pct(val, width=6, sign=False):
    """Format percentage."""
    if val is None:
        return "N/A".rjust(width)
    pct = val * 100
    if sign:
        return f"{pct:+{width}.2f}%"
    return f"{pct:{width}.2f}%"

print("=" * 100)
print("PAIRWISE TRANSFER EVALUATION - DETAILED METRICS")
print("MBE: + means model predicts DIRTIER than actual (overpredicts soiling)")
print("     - means model predicts CLEANER than actual (underpredicts soiling)")
print("=" * 100)

# Store results
results = {}

for target in PLANTS:
    print(f"\n{'='*100}")
    print(f"TARGET: {target.upper()}")
    print(f"{'='*100}")
    
    results[target] = {}
    
    for source in PLANTS:
        if source == target:
            continue
        
        r = evaluate_pair(source, target)
        if r is None:
            continue
        
        results[target][source] = r
        
        print(f"\n  Source: {source.upper()}")
        print(f"  Overall: MAE={format_pct(r['mae_7d'])}, MBE={format_pct(r['mbe_7d'], sign=True)}, "
              f"Worst: {format_pct(r['worst_under'], sign=True)} to {format_pct(r['worst_over'], sign=True)}")
        
        # Bin details
        print(f"  {'Bin':<10} {'Days':>6} {'MAE':>8} {'MBE':>9} {'Worst Under':>12} {'Worst Over':>12}")
        print(f"  {'-'*58}")
        for label in ["<90%", "90-95%", "95-98%", "98-99%", ">99%"]:
            b = r['bins'].get(label)
            if b and b['count'] > 0:
                print(f"  {label:<10} {b['count']:>6} {format_pct(b['mae']):>8} {format_pct(b['mbe'], sign=True):>9} "
                      f"{format_pct(b['worst_under'], sign=True):>12} {format_pct(b['worst_over'], sign=True):>12}")

# Summary matrices
print(f"\n{'='*100}")
print("SUMMARY MATRICES")
print(f"{'='*100}")

# MAE Matrix
print(f"\n--- MAE Matrix (rows=source → cols=target) ---")
print(f"{'Source↓':<14}", end="")
for t in PLANTS:
    print(f"{t:>14}", end="")
print()
for s in PLANTS:
    print(f"{s:<14}", end="")
    for t in PLANTS:
        if s == t:
            print(f"{'---':>14}", end="")
        elif t in results and s in results[t]:
            print(f"{format_pct(results[t][s]['mae_7d']):>14}", end="")
        else:
            print(f"{'N/A':>14}", end="")
    print()

# MBE Matrix
print(f"\n--- MBE Matrix (+ = predicts dirtier) ---")
print(f"{'Source↓':<14}", end="")
for t in PLANTS:
    print(f"{t:>14}", end="")
print()
for s in PLANTS:
    print(f"{s:<14}", end="")
    for t in PLANTS:
        if s == t:
            print(f"{'---':>14}", end="")
        elif t in results and s in results[t]:
            print(f"{format_pct(results[t][s]['mbe_7d'], sign=True):>14}", end="")
        else:
            print(f"{'N/A':>14}", end="")
    print()

# Best source for each target with full details
print(f"\n{'='*100}")
print("BEST SOURCE FOR EACH TARGET (by overall MAE)")
print(f"{'='*100}")

for target in PLANTS:
    if target not in results or not results[target]:
        continue
    
    # Sort by MAE
    sorted_sources = sorted(results[target].items(), key=lambda x: x[1]['mae_7d'])
    best_src, best_r = sorted_sources[0]
    
    print(f"\n{target.upper()} ← {best_src.upper()}")
    print(f"  Overall: MAE={format_pct(best_r['mae_7d'])}, MBE={format_pct(best_r['mbe_7d'], sign=True)}")
    print(f"  Worst errors: {format_pct(best_r['worst_under'], sign=True)} to {format_pct(best_r['worst_over'], sign=True)}")
    print(f"  By bin:")
    for label in ["<90%", "90-95%", "95-98%", "98-99%", ">99%"]:
        b = best_r['bins'].get(label)
        if b and b['count'] > 0:
            print(f"    {label:<8}: MAE={format_pct(b['mae'])}, MBE={format_pct(b['mbe'], sign=True)}, "
                  f"worst=[{format_pct(b['worst_under'], sign=True)}, {format_pct(b['worst_over'], sign=True)}] ({b['count']} days)")
