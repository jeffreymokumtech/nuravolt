#!/usr/bin/env python3
"""
Retrain RUL Models with Real SCADA Data

Retrains string_degradation and mismatch models using real plant SCADA data
instead of Lazzaretti to fix distribution mismatch issues.

Usage:
    python scripts/retrain_rul_with_real_data.py
"""

import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import polars as pl
from sklearn.model_selection import train_test_split

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.fault.rul_models import (
    create_rul_model,
    ALL_RUL_CONFIGS,
    RULModelConfig,
)
from nuravolt.fault.rul_evaluation import (
    MultiHorizonEvaluator,
    check_success_criteria,
    DEFAULT_HORIZONS,
)


# =============================================================================
# Configuration
# =============================================================================

PLANTS = [
    "alpha",
    "ribera",
    "eta",
    "epsilon",
    "gamma",
    "delta",
    "zeta",
]

PLANT_RATED_POWER = {
    "alpha": 10000,
    "ribera": 3000,
    "eta": 2500,
    "epsilon": 1500,
    "gamma": 2000,
    "delta": 1500,
    "zeta": 1200,
}

SCADA_BASE = Path("backenddata/scada")
OUTPUT_DIR = Path("models/rul")

# Models to retrain with real data
MODELS_TO_RETRAIN = ["string_degradation", "mismatch"]


# =============================================================================
# Feature Engineering (same as transfer test)
# =============================================================================

def discover_columns(df: pl.DataFrame) -> Dict[str, List[str]]:
    """Discover available column types in SCADA data."""
    cols = df.columns

    discovered = {
        "timestamp": [],
        "ac_power": [],
        "dc_current": [],
        "dc_voltage": [],
        "temperature": [],
        "irradiance": [],
    }

    for col in cols:
        col_lower = col.lower()

        if "timestamp" in col_lower or col == "Timestamp":
            discovered["timestamp"].append(col)
        if "p_ac" in col_lower or ("power" in col_lower and "ac" in col_lower):
            discovered["ac_power"].append(col)
        if "input_current" in col_lower or "i_dc" in col_lower:
            discovered["dc_current"].append(col)
        if "u_dc" in col_lower or "v_dc" in col_lower:
            discovered["dc_voltage"].append(col)
        if "temperature" in col_lower or "temp" in col_lower:
            discovered["temperature"].append(col)
        if "irradiation" in col_lower or "irradiance" in col_lower:
            discovered["irradiance"].append(col)

    return discovered


def compute_features_from_scada(
    df: pl.DataFrame,
    plant_id: str,
    rated_power_kw: float,
) -> pl.DataFrame:
    """Compute standardized features from raw SCADA data."""
    discovered = discover_columns(df)
    n = len(df)
    features = {}

    # Irradiance
    if discovered["irradiance"]:
        irr_col = discovered["irradiance"][0]
        irr_values = df[irr_col].fill_null(0).to_numpy()
        features["irradiance_normalized"] = np.clip(irr_values / 1000, 0, 1.5)
    else:
        features["irradiance_normalized"] = np.full(n, 0.5)

    # Temperature
    if discovered["temperature"]:
        temp_col = discovered["temperature"][0]
        module_temp = df[temp_col].fill_null(25).to_numpy()
        features["module_temp"] = module_temp
        ambient_temp = module_temp - features["irradiance_normalized"] * 15
        features["ambient_temp"] = ambient_temp
    else:
        features["module_temp"] = np.full(n, 35.0)

    # String current features
    if discovered["dc_current"] and len(discovered["dc_current"]) >= 2:
        currents = []
        for col in discovered["dc_current"]:
            curr = df[col].fill_null(0).to_numpy()
            currents.append(curr)

        currents = np.array(currents)
        string_mean = np.mean(currents, axis=0)
        string_std = np.std(currents, axis=0)
        string_min = np.min(currents, axis=0)
        string_max = np.max(currents, axis=0)

        # Coefficient of variation - THE KEY METRIC
        features["string_current_cv"] = np.where(
            string_mean > 0.1,
            string_std / string_mean,
            0.0
        )

        features["string_current_min_ratio"] = np.where(
            string_mean > 0.1,
            string_min / string_mean,
            1.0
        )
        features["string_current_max_ratio"] = np.where(
            string_mean > 0.1,
            string_max / string_mean,
            1.0
        )

        # Balance ratio for mismatch
        features["string_balance_ratio"] = np.where(
            string_max > 0.1,
            string_min / string_max,
            1.0
        )
        features["worst_string_ratio"] = features["string_balance_ratio"]

        # Trend features (simplified)
        features["string_cv_trend_7d"] = features["string_current_cv"] * 0.02
        features["string_ratio_trend_7d"] = np.full(n, -0.0005)
        features["string_power_cv"] = features["string_current_cv"]
        features["string_power_range"] = string_max - string_min
    else:
        # Defaults if no string data
        features["string_current_cv"] = np.full(n, 0.05)
        features["string_current_min_ratio"] = np.full(n, 0.95)
        features["string_current_max_ratio"] = np.full(n, 1.05)
        features["string_balance_ratio"] = np.full(n, 0.95)
        features["worst_string_ratio"] = np.full(n, 0.95)
        features["string_cv_trend_7d"] = np.full(n, 0.001)
        features["string_ratio_trend_7d"] = np.full(n, -0.0005)
        features["string_power_cv"] = np.full(n, 0.05)
        features["string_power_range"] = np.full(n, 1.0)

    return pl.DataFrame(features)


# =============================================================================
# Data Loading
# =============================================================================

def load_all_plants_data(days_per_plant: int = 90) -> pl.DataFrame:
    """Load and combine SCADA data from all plants."""
    print("\nLoading SCADA data from all plants...")

    all_features = []

    for plant_id in PLANTS:
        scada_dir = SCADA_BASE / plant_id
        if not scada_dir.exists():
            print(f"  {plant_id}: No data directory")
            continue

        parquet_files = sorted(scada_dir.glob("*.parquet"))
        if not parquet_files:
            print(f"  {plant_id}: No parquet files")
            continue

        # Load recent files
        dfs = []
        for pf in parquet_files[-days_per_plant:]:
            try:
                df = pl.read_parquet(pf)
                dfs.append(df)
            except Exception:
                continue

        if not dfs:
            print(f"  {plant_id}: Load failed")
            continue

        df = pl.concat(dfs, how="diagonal")
        rated_power = PLANT_RATED_POWER.get(plant_id, 1000)

        # Compute features
        features_df = compute_features_from_scada(df, plant_id, rated_power)
        features_df = features_df.with_columns(pl.lit(plant_id).alias("plant_id"))

        all_features.append(features_df)
        print(f"  {plant_id}: {len(features_df):,} samples")

    if not all_features:
        return pl.DataFrame()

    combined = pl.concat(all_features, how="diagonal")
    print(f"\nTotal: {len(combined):,} samples from {len(all_features)} plants")

    return combined


# =============================================================================
# Label Generation with Real Data Statistics
# =============================================================================

def generate_labels_from_real_data(
    df: pl.DataFrame,
    fault_type: str,
    config: RULModelConfig,
) -> pl.DataFrame:
    """
    Generate RUL labels using real data distribution.

    Key difference from Lazzaretti training:
    - Use actual percentiles from real data to set thresholds
    - This ensures the model learns from realistic feature distributions
    """
    metric_col = {
        "string_degradation": "string_current_cv",
        "mismatch": "string_balance_ratio",
    }.get(fault_type)

    if metric_col not in df.columns:
        print(f"  Warning: {metric_col} not in data")
        return df.with_columns(pl.lit(config.max_horizon_days).alias("days_to_fault"))

    values = df[metric_col].to_numpy()
    valid_mask = ~np.isnan(values) & ~np.isinf(values)
    valid_values = values[valid_mask]

    if len(valid_values) == 0:
        return df.with_columns(pl.lit(config.max_horizon_days).alias("days_to_fault"))

    # Use real data statistics to set thresholds
    if fault_type == "string_degradation":
        # Higher CV = worse
        # Use 95th percentile as "fault threshold" instead of fixed 0.25
        p50 = np.percentile(valid_values, 50)
        p95 = np.percentile(valid_values, 95)
        p99 = np.percentile(valid_values, 99)

        print(f"  Real data CV: p50={p50:.3f}, p95={p95:.3f}, p99={p99:.3f}")

        # Threshold = 95th percentile (top 5% are "degraded")
        threshold = max(p95, 0.15)  # At least 0.15

        # Generate labels: distance from threshold determines RUL
        max_days = float(config.max_horizon_days)

        days_to_fault = np.where(
            values >= threshold,
            0.0,  # Already at/above threshold
            ((threshold - values) / threshold * max_days).clip(0, max_days)
        )

    elif fault_type == "mismatch":
        # Lower ratio = worse
        p5 = np.percentile(valid_values, 5)
        p50 = np.percentile(valid_values, 50)

        print(f"  Real data balance: p5={p5:.3f}, p50={p50:.3f}")

        # Threshold = 5th percentile (bottom 5% are "mismatched")
        threshold = min(p5, 0.90)  # At most 0.90

        max_days = float(config.max_horizon_days)
        max_val = 1.0  # Perfect balance

        days_to_fault = np.where(
            values <= threshold,
            0.0,  # Already at/below threshold
            ((values - threshold) / (max_val - threshold + 1e-6) * max_days).clip(0, max_days)
        )

    # Add noise for realism
    noise = np.random.normal(0, max_days * 0.05, len(df))
    days_to_fault = np.clip(days_to_fault + noise, 0, max_days)

    return df.with_columns(pl.Series("days_to_fault", days_to_fault))


# =============================================================================
# Training
# =============================================================================

def train_model_with_real_data(
    df: pl.DataFrame,
    fault_type: str,
    output_dir: Path,
) -> Dict:
    """Train a single RUL model with real SCADA data."""
    start_time = time.time()

    config = ALL_RUL_CONFIGS[fault_type]

    print(f"\n{'=' * 60}")
    print(f"Training: {config.display_name} ({fault_type}) with REAL DATA")
    print(f"{'=' * 60}")

    # Generate labels using real data statistics
    df_labeled = generate_labels_from_real_data(df, fault_type, config)

    # Create model and get feature columns
    model = create_rul_model(fault_type)
    feature_cols = model.feature_columns

    # Check available features
    available = [c for c in feature_cols if c in df_labeled.columns]
    print(f"  Features: {len(available)}/{len(feature_cols)}: {available}")

    if len(available) < 2:
        print(f"  Skipping: Not enough features")
        return {"status": "skip", "reason": "insufficient_features"}

    # Prepare data
    X = df_labeled.select(available).to_numpy()
    y = df_labeled["days_to_fault"].to_numpy()

    # Remove NaN/inf
    valid_mask = ~(np.isnan(X).any(axis=1) | np.isnan(y) | np.isinf(X).any(axis=1))
    X = X[valid_mask]
    y = y[valid_mask]

    print(f"  Valid samples: {len(X):,}")
    print(f"  Label range: {y.min():.1f} - {y.max():.1f} days")
    print(f"  Label distribution: p25={np.percentile(y,25):.1f}, p50={np.percentile(y,50):.1f}, p75={np.percentile(y,75):.1f}")

    if len(X) < 1000:
        print(f"  Skipping: Not enough samples")
        return {"status": "skip", "reason": "insufficient_samples"}

    # Split data
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_train, y_train, test_size=0.1, random_state=42
    )

    print(f"  Train: {len(X_train):,}, Val: {len(X_val):,}, Test: {len(X_test):,}")

    # Train
    print("\n  Training...")
    metrics = model.train(X_train, y_train, X_val, y_val)

    # Evaluate
    print("\n  Evaluating...")
    y_pred = model.predict(X_test)

    evaluator = MultiHorizonEvaluator()
    eval_result = evaluator.evaluate(y_test, y_pred)

    # Print results
    print(f"\n  TEST RESULTS (Real Data)")
    print(f"  {'-' * 40}")
    print(f"  MAE:        {eval_result.mae:.2f} days")
    print(f"  RMSE:       {eval_result.rmse:.2f} days")
    print(f"  Median AE:  {eval_result.median_ae:.2f} days")
    print(f"\n  HORIZON ACCURACY")
    for horizon in sorted(eval_result.horizon_metrics.keys()):
        pct = eval_result.horizon_metrics[horizon].accuracy_pct
        bar = "#" * int(pct / 5)
        print(f"    Within {horizon:2d}d: {pct:5.1f}% {bar}")

    # Check criteria
    meets_criteria, _ = check_success_criteria(fault_type, eval_result)
    if meets_criteria:
        print(f"\n  ✅ PASS: Model meets success criteria")
    else:
        print(f"\n  ⚠️  WARN: Model does not meet all criteria")

    # Save model
    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / f"rul_{fault_type}.pkl"
    model.save(model_path)
    print(f"\n  Saved: {model_path}")

    return {
        "status": "ok",
        "mae": eval_result.mae,
        "rmse": eval_result.rmse,
        "horizons": {h: eval_result.within(h) for h in DEFAULT_HORIZONS},
        "training_time": time.time() - start_time,
        "meets_criteria": meets_criteria,
    }


# =============================================================================
# Main
# =============================================================================

def main():
    print("\n" + "=" * 70)
    print("RETRAIN RUL MODELS WITH REAL SCADA DATA")
    print("=" * 70)
    print(f"Models to retrain: {MODELS_TO_RETRAIN}")

    # Load all plant data
    df = load_all_plants_data(days_per_plant=90)

    if len(df) == 0:
        print("\nNo data loaded!")
        return 1

    # Show feature statistics
    print("\n" + "-" * 50)
    print("REAL DATA FEATURE STATISTICS")
    print("-" * 50)

    for col in ["string_current_cv", "string_balance_ratio"]:
        if col in df.columns:
            values = df[col].drop_nulls().to_numpy()
            print(f"\n{col}:")
            print(f"  Count: {len(values):,}")
            print(f"  Mean:  {np.mean(values):.4f}")
            print(f"  Std:   {np.std(values):.4f}")
            print(f"  Min:   {np.min(values):.4f}")
            print(f"  P5:    {np.percentile(values, 5):.4f}")
            print(f"  P50:   {np.percentile(values, 50):.4f}")
            print(f"  P95:   {np.percentile(values, 95):.4f}")
            print(f"  Max:   {np.max(values):.4f}")

    # Train each model
    results = {}
    for fault_type in MODELS_TO_RETRAIN:
        result = train_model_with_real_data(df, fault_type, OUTPUT_DIR)
        results[fault_type] = result

    # Summary
    print("\n" + "=" * 70)
    print("RETRAINING COMPLETE")
    print("=" * 70)

    for fault_type, result in results.items():
        if result["status"] == "ok":
            status = "✅" if result["meets_criteria"] else "⚠️"
            print(f"  {fault_type}: {status} MAE={result['mae']:.2f}d, W/7d={result['horizons'][7]:.1f}%")
        else:
            print(f"  {fault_type}: ❌ {result.get('reason', 'failed')}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
