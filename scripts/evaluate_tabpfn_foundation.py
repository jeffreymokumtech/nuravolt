#!/usr/bin/env python3
"""TabPFN Foundation Model Evaluation (LOPO).

Same LOPO setup as train_foundation_model_leak_free.py but using TabPFN v2
(transformer-based tabular foundation model) instead of CatBoost.

TabPFN v2 license: Apache 2.0 (commercial use OK).
TabPFN 2.5 license: Non-commercial only — NOT used here.

When testing on plant X, ZERO data from plant X is used in training.
"""

import sys
import warnings
import json
from pathlib import Path
from datetime import datetime
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pearsonr
from sklearn.metrics import r2_score

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

# Reuse data loading from the CatBoost foundation model script
from scripts.train_foundation_model_leak_free import (
    PLANTS, PLANT_CLIMATE, PLANT_LOCATIONS, CLIMATE_ENCODING,
    load_plant_data, load_multiple_plants,
    rolling_avg, compute_metrics,
)


MAX_TRAIN_SAMPLES = 3000  # TabPFN v2 is slow on CPU with >3K samples


def _subsample_stratified(X_df, y, max_n, seed=42):
    """Stratified subsample preserving low-SR distribution."""
    if len(y) <= max_n:
        return X_df, y
    rng = np.random.RandomState(seed)
    idx = np.arange(len(y))
    # Keep all low-SR (< 0.95), subsample high-SR
    low_mask = y < 0.95
    idx_low = idx[low_mask]
    idx_high = idx[~low_mask]
    n_keep_low = min(len(idx_low), max_n)
    n_keep_high = max_n - n_keep_low
    if n_keep_low < len(idx_low):
        idx_low = rng.choice(idx_low, size=n_keep_low, replace=False)
    if n_keep_high > 0 and len(idx_high) > 0:
        n_keep_high = min(n_keep_high, len(idx_high))
        idx_high = rng.choice(idx_high, size=n_keep_high, replace=False)
    else:
        idx_high = np.array([], dtype=int)
    idx_keep = np.sort(np.concatenate([idx_low, idx_high]))
    return X_df.iloc[idx_keep], y[idx_keep]


def train_tabpfn_model(X_train_df, y_train):
    """Train TabPFN v2 regressor."""
    import time
    from tabpfn import TabPFNRegressor
    from tabpfn.constants import ModelVersion

    # Ensure numeric, fill NaN
    X_train_df = X_train_df.copy()
    for col in X_train_df.columns:
        X_train_df[col] = pd.to_numeric(X_train_df[col], errors='coerce')
    X_train_df = X_train_df.fillna(0)

    # TabPFN v2: Apache 2.0 license (commercial OK)
    # v2.5 is non-commercial (gated on HuggingFace) — do NOT use
    # Subsample for CPU feasibility
    if len(y_train) > MAX_TRAIN_SAMPLES:
        print(f"    Subsampling {len(y_train)} → {MAX_TRAIN_SAMPLES} for CPU feasibility",
              flush=True)
        X_train_df, y_train = _subsample_stratified(
            X_train_df, y_train, MAX_TRAIN_SAMPLES
        )
        print(f"    Actual subsample: {len(y_train)} samples", flush=True)

    model = TabPFNRegressor.create_default_for_version(ModelVersion.V2)
    t0 = time.time()
    print(f"    Fitting TabPFN on {len(y_train)} samples...", flush=True)
    model.fit(X_train_df.values, y_train)
    print(f"    Fit completed in {time.time()-t0:.1f}s", flush=True)
    return model


def evaluate_on_target(target_plant: str):
    """LOPO: Train TabPFN on all plants EXCEPT target, test on target."""
    print(f"\n{'='*60}", flush=True)
    print(f"Target: {target_plant.upper()} ({PLANT_CLIMATE[target_plant]})", flush=True)
    print(f"{'='*60}", flush=True)

    train_plants = [p for p in PLANTS if p != target_plant]
    print(f"Training on: {', '.join(train_plants)}", flush=True)

    # Load training data (6 plants, NO target plant)
    X_train, y_train, _, _ = load_multiple_plants(train_plants)
    if X_train is None:
        print("ERROR: Could not load training data")
        return None

    print(f"Training samples: {len(y_train)} (from {len(train_plants)} plants)")
    print(f"Features ({len(X_train.columns)}): {list(X_train.columns)[:10]}...")

    # Load test data (target plant ONLY)
    X_test, y_test, dates_test = load_plant_data(target_plant)
    if X_test is None:
        print("ERROR: Could not load test data")
        return None

    # Ensure numeric
    X_test = X_test.copy()
    for col in X_test.columns:
        X_test[col] = pd.to_numeric(X_test[col], errors='coerce')
    X_test = X_test.fillna(0)

    # Align columns
    for col in set(X_train.columns) - set(X_test.columns):
        X_test[col] = 0
    X_test = X_test[X_train.columns]

    print(f"Test samples: {len(y_test)}")

    # Train TabPFN
    model = train_tabpfn_model(X_train, y_train)

    # Predict
    y_pred = model.predict(X_test.values)

    # Compute metrics
    metrics = compute_metrics(y_pred, y_test)

    if metrics:
        print(f"\n--- RESULTS ---")
        print(f"MAE:      {metrics['mae']:.2f}%")
        print(f"RMSE:     {metrics['rmse']:.2f}%")
        print(f"MBE:      {metrics['mbe']:+.2f}%")
        print(f"Spearman: {metrics['spearman']:.3f}")
        print(f"Pearson:  {metrics['pearson']:.3f}")
        print(f"R²:       {metrics['r2']:.3f}")

    return {
        'target_plant': target_plant,
        'climate': PLANT_CLIMATE[target_plant],
        'train_plants': train_plants,
        'n_train': len(y_train),
        'n_test': len(y_test),
        'n_features': len(X_train.columns),
        'features': list(X_train.columns),
        'metrics': metrics,
        'predictions': {
            'dates': [str(d) for d in dates_test],
            'actual': y_test.tolist(),
            'predicted': y_pred.tolist(),
        }
    }


def main():
    """Run TabPFN LOPO evaluation."""
    print("=" * 70)
    print("TABPFN FOUNDATION MODEL EVALUATION (LOPO)")
    print("=" * 70)
    print("\nModel: TabPFN v2 (Apache 2.0 license)")
    print("Same features and LOPO setup as CatBoost foundation model.")
    print("When testing on plant X, ZERO data from plant X is used.\n")

    results = {}
    for target in PLANTS:
        result = evaluate_on_target(target)
        if result:
            results[target] = result

    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY (TabPFN LOPO)")
    print("=" * 70)
    print(f"\n{'Plant':<15} {'Climate':<12} {'MAE (%)':<10} {'MBE (%)':<10} {'ρ':<8} {'R²':<8}")
    print("-" * 65)

    for plant, r in results.items():
        m = r['metrics']
        print(f"{plant:<15} {r['climate']:<12} {m['mae']:<10.2f} {m['mbe']:<+10.2f} {m['spearman']:<8.3f} {m['r2']:<8.3f}")

    # Compare with CatBoost
    catboost_path = Path('backenddata/foundation_model/leak_free_results.json')
    if catboost_path.exists():
        print("\n" + "=" * 70)
        print("COMPARISON: TabPFN vs CatBoost (MAE loss)")
        print("=" * 70)
        with open(catboost_path) as f:
            cb_data = json.load(f)

        print(f"\n{'Plant':<15} {'TabPFN MAE':<12} {'CatBoost MAE':<14} {'TabPFN ρ':<10} {'CatBoost ρ':<10} {'Winner':<10}")
        print("-" * 75)
        for plant in PLANTS:
            if plant in results and plant in cb_data.get('results', {}):
                tp = results[plant]['metrics']
                cb = cb_data['results'][plant]['metrics']
                winner = "TabPFN" if tp['mae'] < cb['mae'] else "CatBoost"
                print(f"{plant:<15} {tp['mae']:<12.2f} {cb['mae']:<14.2f} {tp['spearman']:<10.3f} {cb['spearman']:<10.3f} {winner}")

    # Save results
    output_dir = Path('backenddata/foundation_model')
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / 'tabpfn_results.json'
    feature_list = list(results.values())[0]['features'] if results else []
    with open(output_path, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'description': 'TabPFN v2 foundation model (LOPO, same features as CatBoost)',
            'model': 'TabPFN v2 (Apache 2.0)',
            'n_features': len(feature_list),
            'features': feature_list,
            'results': results,
        }, f, indent=2)
    print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
