#!/usr/bin/env python3
"""
Evaluate two-stage transfer learning with SAT adjustments.

Stage 1: Universal transfer model (NO SAT features) - captures transferable patterns
Stage 2: Local SAT adjustment - uses target plant's SAT features

Adjustment Methods:
A. Weighted Blend: α × SR_universal + (1-α) × calibrate(sat_sr_raw)
B. Residual Correction: SR_universal + β × (sat_sr_raw - mean(sat_sr_raw))
C. Trend Matching: Adjust SR_universal trend using sat_sr_trend_7d
"""

import sys
import warnings
from pathlib import Path
import numpy as np
import pandas as pd
import json
from datetime import datetime
from typing import Dict, Tuple, Optional

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from scipy.stats import spearmanr, pearsonr
from catboost import CatBoostRegressor

from scripts.evaluate_transfer_enhanced import (
    load_plant_scada, load_plant_enhanced_features, PLANT_CONFIGS
)

# Plants with DustIQ
PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

# Plant metadata
PLANT_METADATA = {
    "epsilon": {"climate": "temperate", "coastal": False, "country": "Austria"},
    "ribera": {"climate": "semi-arid", "coastal": False, "country": "Spain"},
    "delta": {"climate": "coastal", "coastal": True, "country": "Spain-Region C"},
    "zeta": {"climate": "coastal", "coastal": True, "country": "Spain-Region C"},
    "gamma": {"climate": "semi-arid", "coastal": False, "country": "Spain"},
    "eta": {"climate": "semi-arid", "coastal": False, "country": "Spain"},
    "alpha": {"climate": "semi-arid", "coastal": False, "country": "Spain"},
}


def rolling_avg(arr, window=7):
    """7-day rolling average."""
    result = np.zeros_like(arr, dtype=float)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


def compute_metrics(y_pred: np.ndarray, y_true: np.ndarray) -> Dict:
    """Compute comprehensive metrics."""
    y_pred_7d = rolling_avg(y_pred, 7)
    y_true_7d = rolling_avg(y_true, 7)

    valid = ~(np.isnan(y_true_7d) | np.isnan(y_pred_7d))
    if valid.sum() < 10:
        return None

    y_p = y_pred_7d[valid]
    y_t = y_true_7d[valid]

    mae = np.mean(np.abs(y_p - y_t))
    mbe = np.mean(y_p - y_t)
    rho, _ = spearmanr(y_p, y_t)

    return {
        'mae': float(mae),
        'mbe': float(mbe),
        'rho': float(rho) if not np.isnan(rho) else 0.0,
        'n': int(valid.sum()),
    }


def load_sat_features(plant_id: str) -> Optional[pd.DataFrame]:
    """Load SAT features for a plant."""
    path = Path(f"backenddata/models/soiling_aware_twin/{plant_id}_daily_hybrid.parquet")
    if not path.exists():
        return None

    df = pd.read_parquet(path)

    # Compute derived features
    df['sr_raw'] = df['p_actual'] / df['p_physics'].clip(lower=1)
    df['sr_trend_7d'] = df['sr_raw'].diff(7) / 7

    return df


def get_universal_features(df_features: pd.DataFrame) -> pd.DataFrame:
    """Extract only universal features (exclude sat_* features)."""
    sat_cols = [c for c in df_features.columns if c.startswith('sat_')]
    universal_cols = [c for c in df_features.columns if c not in sat_cols]
    return df_features[universal_cols]


def train_universal_model(source_id: str) -> Tuple[Optional[CatBoostRegressor], Optional[list]]:
    """Train transfer model on source plant WITHOUT SAT features."""
    df_src, sr_src = load_plant_scada(source_id, use_cleaned=True)
    if df_src is None:
        return None, None

    # Load features and exclude SAT features
    df_feat_src = load_plant_enhanced_features(source_id, df_src, include_hybrid=True)
    if df_feat_src is None:
        return None, None

    df_feat_universal = get_universal_features(df_feat_src)

    common_idx = df_feat_universal.index.intersection(sr_src.index)
    X_train = df_feat_universal.loc[common_idx].values
    y_train = sr_src.loc[common_idx].values
    feature_names = df_feat_universal.columns.tolist()

    # Handle NaN
    X_train = np.nan_to_num(X_train, nan=0.0)
    valid = ~np.isnan(y_train) & (y_train >= 0.5) & (y_train <= 1.05)
    X_train, y_train = X_train[valid], y_train[valid]

    if len(y_train) < 50:
        return None, None

    # Sample weighting for dirty days
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 10.0
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.0
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 3.0

    model = CatBoostRegressor(
        iterations=300, learning_rate=0.02, depth=4,
        l2_leaf_reg=10.0, min_data_in_leaf=20,
        random_seed=42, verbose=False,
    )
    model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)

    return model, feature_names


def predict_universal(model: CatBoostRegressor, feature_names: list,
                      target_id: str) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[pd.DatetimeIndex]]:
    """Get universal predictions for target plant (no SAT features)."""
    df_tgt, sr_tgt = load_plant_scada(target_id, use_cleaned=True)
    if df_tgt is None:
        return None, None, None

    df_feat_tgt = load_plant_enhanced_features(target_id, df_tgt, include_hybrid=True)
    if df_feat_tgt is None:
        return None, None, None

    df_feat_universal = get_universal_features(df_feat_tgt)

    common_idx = df_feat_universal.index.intersection(sr_tgt.index)
    X_test = df_feat_universal.loc[common_idx].values
    y_test = sr_tgt.loc[common_idx].values

    # Handle NaN and align features
    X_test = np.nan_to_num(X_test, nan=0.0)

    # Align feature dimensions
    if X_test.shape[1] != len(feature_names):
        if X_test.shape[1] < len(feature_names):
            diff = len(feature_names) - X_test.shape[1]
            X_test = np.hstack([X_test, np.zeros((len(X_test), diff))])
        else:
            X_test = X_test[:, :len(feature_names)]

    valid = ~np.isnan(y_test) & (y_test >= 0.5) & (y_test <= 1.05)
    X_test, y_test = X_test[valid], y_test[valid]
    common_idx = common_idx[valid]

    y_pred = model.predict(X_test)

    return y_pred, y_test, common_idx


# =============================================================================
# ADJUSTMENT METHODS
# =============================================================================

def adjust_option_a(sr_universal: np.ndarray, sat_sr_raw: np.ndarray,
                    alpha: float = 0.6) -> np.ndarray:
    """
    Option A: Weighted Blend
    SR_final = α × SR_universal + (1-α) × calibrate(sat_sr_raw)
    """
    # Calibrate sat_sr_raw using P95 anchor
    p95 = np.nanpercentile(sat_sr_raw, 95)
    sat_calibrated = sat_sr_raw + (0.995 - p95)
    sat_calibrated = np.clip(sat_calibrated, 0.85, 1.02)

    # Weighted blend
    sr_final = alpha * sr_universal + (1 - alpha) * sat_calibrated
    return np.clip(sr_final, 0.85, 1.02)


def adjust_option_b(sr_universal: np.ndarray, sat_sr_raw: np.ndarray,
                    beta: float = 0.5) -> np.ndarray:
    """
    Option B: Residual Correction
    SR_final = SR_universal + β × (sat_sr_raw - mean(sat_sr_raw))
    Uses SAT deviation from its mean as correction signal
    """
    sat_mean = np.nanmean(sat_sr_raw)
    sat_deviation = sat_sr_raw - sat_mean

    sr_final = sr_universal + beta * sat_deviation
    return np.clip(sr_final, 0.85, 1.02)


def adjust_option_c(sr_universal: np.ndarray, sat_sr_raw: np.ndarray,
                    sat_sr_trend: np.ndarray, gamma: float = 3.0) -> np.ndarray:
    """
    Option C: Trend Matching
    Adjust SR_universal trend using sat_sr_trend_7d
    If SAT shows faster soiling (negative trend), steepen the prediction
    """
    # Compute universal trend
    sr_trend_universal = np.zeros_like(sr_universal)
    sr_trend_universal[7:] = (sr_universal[7:] - sr_universal[:-7]) / 7

    # SAT trend (already computed as diff(7)/7)
    sat_trend = np.nan_to_num(sat_sr_trend, nan=0.0)

    # Trend difference: if SAT trend is more negative, we need to adjust down
    trend_diff = sat_trend - sr_trend_universal

    # Apply cumulative adjustment based on trend difference
    sr_final = sr_universal.copy()
    for i in range(1, len(sr_final)):
        sr_final[i] = sr_final[i-1] + sr_trend_universal[i] + gamma * trend_diff[i]

    # Re-anchor to keep mean similar to universal
    sr_final = sr_final - (np.nanmean(sr_final) - np.nanmean(sr_universal))

    return np.clip(sr_final, 0.85, 1.02)


def evaluate_all_methods(source_id: str, target_id: str) -> Dict:
    """Evaluate all adjustment methods for a source-target pair."""
    results = {
        'source': source_id,
        'target': target_id,
        'methods': {}
    }

    # Train universal model on source
    model, feature_names = train_universal_model(source_id)
    if model is None:
        return results

    # Get universal predictions on target
    sr_universal, y_true, idx = predict_universal(model, feature_names, target_id)
    if sr_universal is None:
        return results

    # Evaluate Stage 1 (universal only)
    metrics = compute_metrics(sr_universal, y_true)
    if metrics:
        results['methods']['stage1_universal'] = metrics
        print(f"    Stage 1 (universal): MAE={metrics['mae']*100:.2f}%, ρ={metrics['rho']:.3f}")

    # Load target's SAT features
    df_sat = load_sat_features(target_id)
    if df_sat is None:
        print(f"    No SAT features for {target_id}")
        return results

    # Align SAT features to prediction index
    df_sat_aligned = df_sat.reindex(idx)
    sat_sr_raw = df_sat_aligned['sr_raw'].values
    sat_sr_trend = df_sat_aligned['sr_trend_7d'].values if 'sr_trend_7d' in df_sat_aligned.columns else np.zeros_like(sat_sr_raw)

    # Handle NaN in SAT features
    sat_sr_raw = np.nan_to_num(sat_sr_raw, nan=np.nanmean(sat_sr_raw))
    sat_sr_trend = np.nan_to_num(sat_sr_trend, nan=0.0)

    # Option A: Weighted Blend (try different alphas)
    for alpha in [0.4, 0.5, 0.6, 0.7]:
        sr_adjusted = adjust_option_a(sr_universal, sat_sr_raw, alpha=alpha)
        metrics = compute_metrics(sr_adjusted, y_true)
        if metrics:
            key = f'option_a_alpha{alpha}'
            results['methods'][key] = metrics
            if alpha == 0.6:  # Default
                print(f"    Option A (α={alpha}): MAE={metrics['mae']*100:.2f}%, ρ={metrics['rho']:.3f}")

    # Option B: Residual Correction (try different betas)
    for beta in [0.3, 0.5, 0.7, 1.0]:
        sr_adjusted = adjust_option_b(sr_universal, sat_sr_raw, beta=beta)
        metrics = compute_metrics(sr_adjusted, y_true)
        if metrics:
            key = f'option_b_beta{beta}'
            results['methods'][key] = metrics
            if beta == 0.5:  # Default
                print(f"    Option B (β={beta}): MAE={metrics['mae']*100:.2f}%, ρ={metrics['rho']:.3f}")

    # Option C: Trend Matching (try different gammas)
    for gamma in [1.0, 3.0, 5.0]:
        sr_adjusted = adjust_option_c(sr_universal, sat_sr_raw, sat_sr_trend, gamma=gamma)
        metrics = compute_metrics(sr_adjusted, y_true)
        if metrics:
            key = f'option_c_gamma{gamma}'
            results['methods'][key] = metrics
            if gamma == 3.0:  # Default
                print(f"    Option C (γ={gamma}): MAE={metrics['mae']*100:.2f}%, ρ={metrics['rho']:.3f}")

    # Also evaluate raw SAT as baseline
    sat_calibrated = sat_sr_raw + (0.995 - np.nanpercentile(sat_sr_raw, 95))
    sat_calibrated = np.clip(sat_calibrated, 0.85, 1.02)
    metrics = compute_metrics(sat_calibrated, y_true)
    if metrics:
        results['methods']['sat_only_calibrated'] = metrics
        print(f"    SAT only (calibrated): MAE={metrics['mae']*100:.2f}%, ρ={metrics['rho']:.3f}")

    return results


def main():
    print("=" * 80)
    print("TWO-STAGE TRANSFER LEARNING WITH SAT ADJUSTMENTS")
    print("=" * 80)
    print()
    print("Stage 1: Universal model (NO SAT features)")
    print("Stage 2: Local SAT adjustment (Options A, B, C)")
    print()

    all_results = {}

    # Evaluate key transfer pairs
    transfer_pairs = [
        ("gamma", "ribera"),   # User's focus
        ("delta", "ribera"),   # Previous best
        ("delta", "zeta"), # Coastal to coastal
        ("zeta", "delta"), # Coastal to coastal
        ("alpha", "ribera"),   # Semi-arid to semi-arid
        ("alpha", "eta"),    # Semi-arid to semi-arid
        ("delta", "alpha"),    # Best universal donor
        ("gamma", "epsilon"),      # Semi-arid to temperate
        ("alpha", "epsilon"),      # Semi-arid to temperate
    ]

    for source_id, target_id in transfer_pairs:
        print(f"\n{'='*60}")
        print(f"SOURCE: {source_id} → TARGET: {target_id}")
        print(f"  {PLANT_METADATA[source_id]['climate']} → {PLANT_METADATA[target_id]['climate']}")
        print(f"{'='*60}")

        results = evaluate_all_methods(source_id, target_id)
        all_results[f"{source_id}_to_{target_id}"] = results

    # Summary analysis
    print("\n" + "=" * 80)
    print("SUMMARY: BEST METHOD PER TRANSFER PAIR")
    print("=" * 80)
    print(f"\n{'Source→Target':<25} {'Stage1 ρ':<10} {'Best Method':<20} {'Best ρ':<10} {'Δρ':<10}")
    print("-" * 80)

    for pair_key, results in all_results.items():
        methods = results.get('methods', {})
        if not methods:
            continue

        stage1_rho = methods.get('stage1_universal', {}).get('rho', 0)

        # Find best method
        best_method = None
        best_rho = -999
        for method, metrics in methods.items():
            if method != 'stage1_universal' and metrics.get('rho', 0) > best_rho:
                best_rho = metrics['rho']
                best_method = method

        delta = best_rho - stage1_rho if best_method else 0
        source, target = results['source'], results['target']

        print(f"{source}→{target:<15} {stage1_rho:>8.3f}   {best_method or 'N/A':<20} {best_rho:>8.3f}   {delta:>+8.3f}")

    # Detailed analysis
    print("\n" + "=" * 80)
    print("ANALYSIS: WHEN DOES EACH METHOD WORK BEST?")
    print("=" * 80)

    # Count wins per method
    method_wins = {}
    for pair_key, results in all_results.items():
        methods = results.get('methods', {})
        if not methods:
            continue

        stage1_rho = methods.get('stage1_universal', {}).get('rho', 0)

        for method, metrics in methods.items():
            if method == 'stage1_universal':
                continue
            if metrics.get('rho', 0) > stage1_rho:
                base_method = method.split('_')[0] + '_' + method.split('_')[1]
                method_wins[base_method] = method_wins.get(base_method, 0) + 1

    print("\nMethod improvement frequency (when method beats Stage 1):")
    for method, wins in sorted(method_wins.items(), key=lambda x: -x[1]):
        print(f"  {method}: {wins} pairs")

    # Save results
    output_dir = Path("backenddata/transfer_learning")
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = output_dir / f"sat_adjustment_evaluation_{timestamp}.json"

    with open(output_file, 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\nResults saved to: {output_file}")

    # Final conclusions
    print("\n" + "=" * 80)
    print("CONCLUSIONS")
    print("=" * 80)

    return all_results


if __name__ == "__main__":
    results = main()
