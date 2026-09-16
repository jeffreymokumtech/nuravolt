#!/usr/bin/env python3
"""
Hyperparameter Tuning for Transfer Learning SR Prediction.

Uses Optuna to find optimal CatBoost hyperparameters and sample weights
that maximize Spearman correlation (ρ) with DustIQ ground truth.

Cross-validates on climate-appropriate source→target pairs:
- Semi-arid: gamma, ribera, eta, alpha
- Coastal: delta, zeta
- Temperate: epsilon

Usage:
    python scripts/tune_transfer_hyperparams.py
    python scripts/tune_transfer_hyperparams.py --n-trials 200 --timeout 7200
    python scripts/tune_transfer_hyperparams.py --resume
"""

import argparse
import json
import sys
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    import optuna
    from optuna.samplers import TPESampler
    from optuna.pruners import MedianPruner
except ImportError:
    print("Please install optuna: pip install optuna")
    sys.exit(1)

from catboost import CatBoostRegressor
from scipy.stats import spearmanr

from scripts.evaluate_transfer_enhanced import (
    load_plant_scada,
    load_plant_enhanced_features,
    SR_BINS,
)


# ============================================================================
# Configuration
# ============================================================================

# All plants with DustIQ
ALL_PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

# Climate classification
PLANT_CLIMATE = {
    "epsilon": "temperate",     # Austria
    "ribera": "semi-arid",  # Southern Europe
    "gamma": "semi-arid",   # Region B, Spain
    "delta": "coastal",     # Region C
    "zeta": "coastal",  # Region C
    "eta": "semi-arid",   # Region E, Spain
    "alpha": "semi-arid",   # Andalusia, Spain
}

# Cross-validation pairs: (target, source) using climate similarity
CV_PAIRS = [
    # Semi-arid → Semi-arid (within climate)
    ("ribera", "gamma"),
    ("eta", "gamma"),
    ("alpha", "gamma"),
    ("gamma", "ribera"),  # Bidirectional check
    # Coastal → Coastal (within climate)
    ("zeta", "delta"),
    ("delta", "zeta"),
    # Cross-climate (temperate from semi-arid)
    ("epsilon", "alpha"),
]

# Current baseline parameters
BASELINE_PARAMS = {
    "iterations": 300,
    "learning_rate": 0.02,
    "depth": 4,
    "l2_leaf_reg": 10.0,
    "min_data_in_leaf": 20,
}

BASELINE_WEIGHTS = {
    "very_dirty": 10.0,  # SR < 90%
    "dirty": 5.0,        # 90-95%
    "moderate": 3.0,     # 95-98%
    "light": 2.0,        # 98-99%
}


# ============================================================================
# Data Loading Cache
# ============================================================================

_DATA_CACHE: Dict[str, Tuple[pd.DataFrame, pd.Series, pd.DataFrame]] = {}


def load_plant_data(plant_id: str) -> Tuple[Optional[pd.DataFrame], Optional[pd.Series], Optional[pd.DataFrame]]:
    """Load and cache plant data (SCADA + features)."""
    if plant_id in _DATA_CACHE:
        return _DATA_CACHE[plant_id]

    df_scada, sr_target = load_plant_scada(plant_id, use_cleaned=True)
    if df_scada is None:
        _DATA_CACHE[plant_id] = (None, None, None)
        return None, None, None

    # NOTE: include_soiling_twin=False for transfer learning
    df_features = load_plant_enhanced_features(
        plant_id, df_scada,
        include_hybrid=True,
        include_soiling_twin=False
    )

    _DATA_CACHE[plant_id] = (df_scada, sr_target, df_features)
    return df_scada, sr_target, df_features


def rolling_avg(arr: np.ndarray, window: int) -> np.ndarray:
    """Calculate rolling average."""
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


# ============================================================================
# Model Training & Evaluation
# ============================================================================

def compute_sample_weights(y: np.ndarray, weight_config: Dict[str, float]) -> np.ndarray:
    """Compute sample weights based on SR bins."""
    weights = np.ones(len(y))
    weights[y < 0.90] = weight_config.get("very_dirty", 10.0)
    weights[(y >= 0.90) & (y < 0.95)] = weight_config.get("dirty", 5.0)
    weights[(y >= 0.95) & (y < 0.98)] = weight_config.get("moderate", 3.0)
    weights[(y >= 0.98) & (y < 0.99)] = weight_config.get("light", 2.0)
    return weights


def evaluate_transfer_pair(
    source_plant: str,
    target_plant: str,
    model_params: Dict,
    weight_config: Dict[str, float],
) -> Tuple[float, float, float]:
    """
    Evaluate transfer learning from source to target plant.

    Returns:
        Tuple[float, float, float]: (spearman_rho, mae, mbe)
    """
    # Load source data
    _, sr_src, df_feat_src = load_plant_data(source_plant)
    if df_feat_src is None or sr_src is None:
        return 0.0, 1.0, 0.0

    # Load target data
    _, sr_tgt, df_feat_tgt = load_plant_data(target_plant)
    if df_feat_tgt is None or sr_tgt is None:
        return 0.0, 1.0, 0.0

    # Align source features and target
    common_src = df_feat_src.index.intersection(sr_src.index)
    X_src = df_feat_src.loc[common_src].values
    y_src = sr_src.loc[common_src].values

    common_tgt = df_feat_tgt.index.intersection(sr_tgt.index)
    X_tgt = df_feat_tgt.loc[common_tgt].values
    y_tgt = sr_tgt.loc[common_tgt].values

    # Handle NaN
    X_src = np.nan_to_num(X_src, nan=0.0)
    X_tgt = np.nan_to_num(X_tgt, nan=0.0)

    # Filter valid SR values
    valid_src = ~np.isnan(y_src) & (y_src >= 0.5) & (y_src <= 1.05)
    X_src = X_src[valid_src]
    y_src = y_src[valid_src]

    valid_tgt = ~np.isnan(y_tgt) & (y_tgt >= 0.5) & (y_tgt <= 1.05)
    X_tgt = X_tgt[valid_tgt]
    y_tgt = y_tgt[valid_tgt]

    if len(y_src) < 50 or len(y_tgt) < 30:
        return 0.0, 1.0, 0.0

    # Align feature dimensions
    n_feat_src = X_src.shape[1]
    n_feat_tgt = X_tgt.shape[1]
    if n_feat_src != n_feat_tgt:
        n_common = min(n_feat_src, n_feat_tgt)
        X_src = X_src[:, :n_common]
        X_tgt = X_tgt[:, :n_common]

    # Compute sample weights
    sample_weights = compute_sample_weights(y_src, weight_config)

    # Train model
    model = CatBoostRegressor(
        **model_params,
        random_seed=42,
        verbose=False,
    )
    model.fit(X_src, y_src, sample_weight=sample_weights, verbose=False)

    # Predict on target
    y_pred = model.predict(X_tgt)

    # Apply 7-day rolling average
    y_pred_7d = rolling_avg(y_pred, 7)
    y_tgt_7d = rolling_avg(y_tgt, 7)

    # Compute metrics
    rho, _ = spearmanr(y_pred_7d, y_tgt_7d, nan_policy='omit')
    mae = np.mean(np.abs(y_pred_7d - y_tgt_7d))
    mbe = np.mean(y_pred_7d - y_tgt_7d)  # + = predicts cleaner, - = predicts dirtier

    if np.isnan(rho):
        rho = 0.0

    return rho, mae, mbe


# ============================================================================
# Optuna Objective
# ============================================================================

def create_objective(cv_pairs: List[Tuple[str, str]]):
    """Create objective function with specified CV pairs."""

    def objective(trial: optuna.Trial) -> float:
        """Optuna objective function."""

        # Sample hyperparameters
        model_params = {
            "iterations": trial.suggest_int("iterations", 100, 1000),
            "learning_rate": trial.suggest_float("learning_rate", 0.005, 0.1, log=True),
            "depth": trial.suggest_int("depth", 3, 8),
            "l2_leaf_reg": trial.suggest_float("l2_leaf_reg", 1.0, 30.0, log=True),
            "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 5, 50),
        }

        # Sample weight parameters
        weight_config = {
            "very_dirty": trial.suggest_float("weight_very_dirty", 5.0, 20.0),
            "dirty": trial.suggest_float("weight_dirty", 2.0, 10.0),
            "moderate": trial.suggest_float("weight_moderate", 1.0, 5.0),
            "light": trial.suggest_float("weight_light", 1.0, 3.0),
        }

        # Evaluate on all CV pairs
        correlations = []
        mbes = []

        for target, source in cv_pairs:
            rho, mae, mbe = evaluate_transfer_pair(source, target, model_params, weight_config)
            correlations.append(rho)
            mbes.append(mbe)

            # Report intermediate value for pruning
            trial.report(-np.mean(correlations), len(correlations))

            if trial.should_prune():
                raise optuna.TrialPruned()

        mean_rho = np.mean(correlations)
        mean_mbe = np.mean(mbes)

        # Penalty for non-conservative predictions (positive MBE = predicts cleaner than actual)
        # Conservative predictions (negative MBE) are acceptable
        penalty = max(0, mean_mbe * 10)

        # Return negative correlation (minimize) + penalty
        return -mean_rho + penalty

    return objective


# ============================================================================
# Report Generation
# ============================================================================

def evaluate_baseline() -> Dict:
    """Evaluate baseline parameters on all CV pairs."""
    results = {}

    for target, source in CV_PAIRS:
        rho, mae, mbe = evaluate_transfer_pair(source, target, BASELINE_PARAMS, BASELINE_WEIGHTS)
        results[f"{source}→{target}"] = {
            "rho": rho,
            "mae": mae,
            "mbe": mbe,
        }

    mean_rho = np.mean([r["rho"] for r in results.values()])
    mean_mae = np.mean([r["mae"] for r in results.values()])
    mean_mbe = np.mean([r["mbe"] for r in results.values()])

    return {
        "per_pair": results,
        "mean_rho": mean_rho,
        "mean_mae": mean_mae,
        "mean_mbe": mean_mbe,
    }


def evaluate_tuned(best_params: Dict) -> Dict:
    """Evaluate tuned parameters on all CV pairs."""
    # Split params into model params and weight config
    model_params = {
        "iterations": best_params["iterations"],
        "learning_rate": best_params["learning_rate"],
        "depth": best_params["depth"],
        "l2_leaf_reg": best_params["l2_leaf_reg"],
        "min_data_in_leaf": best_params["min_data_in_leaf"],
    }

    weight_config = {
        "very_dirty": best_params["weight_very_dirty"],
        "dirty": best_params["weight_dirty"],
        "moderate": best_params["weight_moderate"],
        "light": best_params["weight_light"],
    }

    results = {}

    for target, source in CV_PAIRS:
        rho, mae, mbe = evaluate_transfer_pair(source, target, model_params, weight_config)
        results[f"{source}→{target}"] = {
            "rho": rho,
            "mae": mae,
            "mbe": mbe,
        }

    mean_rho = np.mean([r["rho"] for r in results.values()])
    mean_mae = np.mean([r["mae"] for r in results.values()])
    mean_mbe = np.mean([r["mbe"] for r in results.values()])

    return {
        "per_pair": results,
        "mean_rho": mean_rho,
        "mean_mae": mean_mae,
        "mean_mbe": mean_mbe,
    }


def generate_report(study: optuna.Study, output_dir: Path):
    """Generate comprehensive tuning report."""

    best_params = study.best_params
    best_value = -study.best_value  # Convert back to positive correlation

    print("\n" + "="*60)
    print("HYPERPARAMETER TUNING RESULTS")
    print("="*60)

    # Evaluate baseline
    print("\nEvaluating baseline parameters...")
    baseline_results = evaluate_baseline()

    # Evaluate tuned
    print("Evaluating tuned parameters...")
    tuned_results = evaluate_tuned(best_params)

    # Calculate improvement
    improvement_rho = (tuned_results["mean_rho"] - baseline_results["mean_rho"]) / max(0.001, abs(baseline_results["mean_rho"])) * 100
    improvement_mae = (baseline_results["mean_mae"] - tuned_results["mean_mae"]) / max(0.001, baseline_results["mean_mae"]) * 100

    # Print summary
    print(f"\n{'Metric':<20} {'Baseline':<15} {'Tuned':<15} {'Improvement':<15}")
    print("-"*65)
    print(f"{'Mean ρ':<20} {baseline_results['mean_rho']:.4f}         {tuned_results['mean_rho']:.4f}         {improvement_rho:+.1f}%")
    print(f"{'Mean MAE':<20} {baseline_results['mean_mae']:.4f}         {tuned_results['mean_mae']:.4f}         {improvement_mae:+.1f}%")
    print(f"{'Mean MBE':<20} {baseline_results['mean_mbe']:.4f}         {tuned_results['mean_mbe']:.4f}")

    # Print best parameters
    print("\n" + "-"*60)
    print("BEST CATBOOST PARAMETERS:")
    print("-"*60)
    print(f"  iterations:      {best_params['iterations']:<10} (baseline: {BASELINE_PARAMS['iterations']})")
    print(f"  learning_rate:   {best_params['learning_rate']:.4f}     (baseline: {BASELINE_PARAMS['learning_rate']})")
    print(f"  depth:           {best_params['depth']:<10} (baseline: {BASELINE_PARAMS['depth']})")
    print(f"  l2_leaf_reg:     {best_params['l2_leaf_reg']:.4f}     (baseline: {BASELINE_PARAMS['l2_leaf_reg']})")
    print(f"  min_data_in_leaf: {best_params['min_data_in_leaf']:<10} (baseline: {BASELINE_PARAMS['min_data_in_leaf']})")

    print("\nBEST SAMPLE WEIGHTS:")
    print("-"*60)
    print(f"  SR < 90% (very_dirty): {best_params['weight_very_dirty']:.2f}  (baseline: {BASELINE_WEIGHTS['very_dirty']})")
    print(f"  90-95% (dirty):        {best_params['weight_dirty']:.2f}  (baseline: {BASELINE_WEIGHTS['dirty']})")
    print(f"  95-98% (moderate):     {best_params['weight_moderate']:.2f}  (baseline: {BASELINE_WEIGHTS['moderate']})")
    print(f"  98-99% (light):        {best_params['weight_light']:.2f}  (baseline: {BASELINE_WEIGHTS['light']})")

    # Print per-pair results
    print("\n" + "-"*60)
    print("PER-PAIR COMPARISON (Baseline vs Tuned):")
    print("-"*60)
    print(f"{'Pair':<25} {'Baseline ρ':<12} {'Tuned ρ':<12} {'Δρ':<10}")
    print("-"*60)

    for pair in baseline_results["per_pair"]:
        b_rho = baseline_results["per_pair"][pair]["rho"]
        t_rho = tuned_results["per_pair"][pair]["rho"]
        delta = t_rho - b_rho
        marker = "↑" if delta > 0 else ("↓" if delta < 0 else "=")
        print(f"{pair:<25} {b_rho:.4f}       {t_rho:.4f}       {delta:+.4f} {marker}")

    # Build report dict
    report = {
        "timestamp": datetime.now().isoformat(),
        "n_trials": len(study.trials),
        "best_trial": study.best_trial.number,
        "best_value": best_value,
        "best_params": {
            "catboost": {
                "iterations": best_params["iterations"],
                "learning_rate": best_params["learning_rate"],
                "depth": best_params["depth"],
                "l2_leaf_reg": best_params["l2_leaf_reg"],
                "min_data_in_leaf": best_params["min_data_in_leaf"],
            },
            "sample_weights": {
                "very_dirty": best_params["weight_very_dirty"],
                "dirty": best_params["weight_dirty"],
                "moderate": best_params["weight_moderate"],
                "light": best_params["weight_light"],
            },
        },
        "baseline": {
            "params": BASELINE_PARAMS,
            "weights": BASELINE_WEIGHTS,
            "results": baseline_results,
        },
        "tuned_results": tuned_results,
        "improvement": {
            "rho_pct": improvement_rho,
            "mae_pct": improvement_mae,
        },
    }

    # Save JSON report
    json_path = output_dir / "tuning_results.json"
    with open(json_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nResults saved to: {json_path}")

    # Save baseline comparison CSV
    csv_data = []
    for pair in baseline_results["per_pair"]:
        csv_data.append({
            "pair": pair,
            "baseline_rho": baseline_results["per_pair"][pair]["rho"],
            "baseline_mae": baseline_results["per_pair"][pair]["mae"],
            "baseline_mbe": baseline_results["per_pair"][pair]["mbe"],
            "tuned_rho": tuned_results["per_pair"][pair]["rho"],
            "tuned_mae": tuned_results["per_pair"][pair]["mae"],
            "tuned_mbe": tuned_results["per_pair"][pair]["mbe"],
        })

    csv_path = output_dir / "baseline_comparison.csv"
    pd.DataFrame(csv_data).to_csv(csv_path, index=False)
    print(f"Comparison saved to: {csv_path}")

    return report


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Hyperparameter tuning for transfer learning SR prediction"
    )
    parser.add_argument(
        "--n-trials", type=int, default=100,
        help="Number of Optuna trials (default: 100)"
    )
    parser.add_argument(
        "--timeout", type=int, default=3600,
        help="Timeout in seconds (default: 3600 = 1 hour)"
    )
    parser.add_argument(
        "--output-dir", type=str, default="backenddata/tuning",
        help="Output directory (default: backenddata/tuning)"
    )
    parser.add_argument(
        "--study-name", type=str, default="transfer_sr_tuning",
        help="Optuna study name (default: transfer_sr_tuning)"
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Resume from previous study (if exists)"
    )
    parser.add_argument(
        "--quick", action="store_true",
        help="Quick test with 10 trials"
    )
    args = parser.parse_args()

    # Output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Override for quick test
    n_trials = 10 if args.quick else args.n_trials
    timeout = 300 if args.quick else args.timeout

    print("="*60)
    print("TRANSFER LEARNING HYPERPARAMETER TUNING")
    print("="*60)
    print(f"Trials: {n_trials}")
    print(f"Timeout: {timeout}s")
    print(f"CV Pairs: {len(CV_PAIRS)}")
    for target, source in CV_PAIRS:
        print(f"  {source} → {target}")
    print("="*60)

    # Pre-load all plant data
    print("\nLoading plant data...")
    plants_needed = set()
    for target, source in CV_PAIRS:
        plants_needed.add(target)
        plants_needed.add(source)

    for plant in plants_needed:
        print(f"  Loading {plant}...")
        load_plant_data(plant)

    # Create or load study
    storage_path = output_dir / f"{args.study_name}.db"
    storage = f"sqlite:///{storage_path}"

    if args.resume and storage_path.exists():
        print(f"\nResuming study from: {storage_path}")
        study = optuna.load_study(
            study_name=args.study_name,
            storage=storage,
        )
        print(f"Previous trials: {len(study.trials)}")
    else:
        print("\nCreating new study...")
        study = optuna.create_study(
            study_name=args.study_name,
            direction="minimize",  # We minimize negative correlation
            sampler=TPESampler(seed=42),
            pruner=MedianPruner(n_startup_trials=10, n_warmup_steps=3),
            storage=storage,
            load_if_exists=True,
        )

    # Run optimization
    print(f"\nStarting optimization ({n_trials} trials, {timeout}s timeout)...")

    objective = create_objective(CV_PAIRS)

    study.optimize(
        objective,
        n_trials=n_trials,
        timeout=timeout,
        show_progress_bar=True,
        gc_after_trial=True,
    )

    # Generate report
    generate_report(study, output_dir)

    print("\n" + "="*60)
    print("TUNING COMPLETE")
    print("="*60)
    print(f"Best mean ρ: {-study.best_value:.4f}")
    print(f"Study saved to: {storage_path}")


if __name__ == "__main__":
    main()
