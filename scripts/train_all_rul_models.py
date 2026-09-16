#!/usr/bin/env python3
"""
Train All 7 RUL Models

Trains all 7 Remaining Useful Life (RUL) models:
1. string_degradation    - String performance decline
2. inverter_thermal      - Inverter overheating
3. module_degradation    - Module efficiency loss
4. thermal_hotspot       - Localized overheating
5. mismatch              - String imbalance
6. bypass_diode          - Diode stress
7. insulation            - Insulation resistance degradation

Uses:
- Lazzaretti dataset (515K samples) for models with matching features
- Synthetic label generation for all models
- Multi-horizon evaluation (1d, 3d, 7d, 14d, 30d)

Usage:
    python scripts/train_all_rul_models.py
    python scripts/train_all_rul_models.py --lazzaretti-path backenddata/datasets/lazzaretti/lazzaretti_faults.parquet
"""

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any

import numpy as np
import polars as pl
from sklearn.model_selection import train_test_split

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.fault.rul_models import (
    create_rul_model,
    ALL_RUL_CONFIGS,
    ALL_RUL_MODELS,
    RULModelConfig,
)
from nuravolt.fault.rul_evaluation import (
    MultiHorizonEvaluator,
    check_success_criteria,
    DEFAULT_HORIZONS,
)
from nuravolt.fault.features import PlantConfig


# =============================================================================
# Configuration
# =============================================================================

OUTPUT_DIR = Path("models/rul")

# All 7 RUL model types
RUL_TYPES = [
    "string_degradation",
    "inverter_thermal",
    "module_degradation",
    "thermal_hotspot",
    "mismatch",
    "bypass_diode",
    "insulation",
]

# Map RUL types to metric columns (where available in datasets)
METRIC_MAPPINGS = {
    "string_degradation": "string_current_cv",
    "inverter_thermal": "temp_rise",
    "module_degradation": "performance_ratio",
    "thermal_hotspot": "temp_delta_max",
    "mismatch": "string_balance_ratio",
    "bypass_diode": "hotspot_count",
    "insulation": "riso_value",
}

# Lazzaretti dataset column mappings
LAZZARETTI_COLUMNS = {
    "vdc1": "string_voltage_1",
    "vdc2": "string_voltage_2",
    "idc1": "string_current_1",
    "idc2": "string_current_2",
    "irr": "poa_irradiance",
    "pvt": "module_temp",
}

# Default Lazzaretti path
DEFAULT_LAZZARETTI_PATH = Path("backenddata/datasets/lazzaretti/lazzaretti_faults.parquet")


# =============================================================================
# Training Result
# =============================================================================

class RULTrainingResult:
    """Results from training an RUL model."""

    def __init__(
        self,
        fault_type: str,
        train_mae: float,
        val_mae: float,
        test_mae: float,
        test_rmse: float,
        test_median_ae: float,
        horizons: Dict[int, float],
        overestimate_rate: float,
        underestimate_rate: float,
        n_train: int,
        n_test: int,
        feature_importance: Dict[str, float],
        training_time: float,
        model_path: str,
        meets_criteria: bool,
        config: RULModelConfig,
    ):
        self.fault_type = fault_type
        self.train_mae = train_mae
        self.val_mae = val_mae
        self.test_mae = test_mae
        self.test_rmse = test_rmse
        self.test_median_ae = test_median_ae
        self.horizons = horizons
        self.overestimate_rate = overestimate_rate
        self.underestimate_rate = underestimate_rate
        self.n_train = n_train
        self.n_test = n_test
        self.feature_importance = feature_importance
        self.training_time = training_time
        self.model_path = model_path
        self.meets_criteria = meets_criteria
        self.config = config

    def to_dict(self) -> dict:
        return {
            "fault_type": self.fault_type,
            "display_name": self.config.display_name,
            "metrics": {
                "mae": round(self.test_mae, 2),
                "rmse": round(self.test_rmse, 2),
                "median_ae": round(self.test_median_ae, 2),
            },
            "horizons": {
                f"within_{h}d": round(v, 1)
                for h, v in self.horizons.items()
            },
            "operational": {
                "overestimate_rate": round(self.overestimate_rate, 1),
                "underestimate_rate": round(self.underestimate_rate, 1),
            },
            "samples": {
                "train": self.n_train,
                "test": self.n_test,
            },
            "training_time_seconds": round(self.training_time, 1),
            "model_path": self.model_path,
            "meets_criteria": self.meets_criteria,
        }


# =============================================================================
# Data Preparation
# =============================================================================

def load_lazzaretti(path: Path) -> pl.DataFrame:
    """Load and prepare Lazzaretti dataset."""
    print(f"\nLoading Lazzaretti dataset from {path}")

    if not path.exists():
        print(f"  Dataset not found at {path}")
        return pl.DataFrame()

    # Try parquet first, then CSV
    if path.suffix == ".parquet":
        df = pl.read_parquet(path)
    else:
        df = pl.read_csv(path)

    print(f"  Loaded {len(df):,} samples")
    print(f"  Columns: {df.columns}")

    # Rename columns
    for old, new in LAZZARETTI_COLUMNS.items():
        if old in df.columns and new not in df.columns:
            df = df.rename({old: new})

    return df


def prepare_lazzaretti_features(df: pl.DataFrame) -> pl.DataFrame:
    """Compute features from Lazzaretti data."""
    print("\n  Computing features from Lazzaretti data...")

    # System specifications
    rated_power_kw = 5.0

    # String current statistics
    if "string_current_1" in df.columns and "string_current_2" in df.columns:
        df = df.with_columns([
            ((pl.col("string_current_1") + pl.col("string_current_2")) / 2).alias("string_current_mean"),
        ])

        # String current CV (coefficient of variation)
        df = df.with_columns([
            (
                ((pl.col("string_current_1") - pl.col("string_current_mean")).abs() +
                 (pl.col("string_current_2") - pl.col("string_current_mean")).abs()) /
                (2 * pl.col("string_current_mean") + 1e-6)
            ).alias("string_current_cv"),
        ])

        # String min/max ratios
        df = df.with_columns([
            (pl.min_horizontal("string_current_1", "string_current_2") /
             (pl.col("string_current_mean") + 1e-6)).alias("string_current_min_ratio"),
            (pl.max_horizontal("string_current_1", "string_current_2") /
             (pl.col("string_current_mean") + 1e-6)).alias("string_current_max_ratio"),
        ])

        # String balance ratio (min/max)
        df = df.with_columns([
            (pl.min_horizontal("string_current_1", "string_current_2") /
             (pl.max_horizontal("string_current_1", "string_current_2") + 1e-6)).alias("string_balance_ratio"),
        ])

    # Power calculation
    if "string_voltage_1" in df.columns and "string_current_1" in df.columns:
        df = df.with_columns([
            ((pl.col("string_voltage_1") * pl.col("string_current_1") +
              pl.col("string_voltage_2") * pl.col("string_current_2")) / 1000).alias("dc_power_kw"),
        ])

        df = df.with_columns([
            (pl.col("dc_power_kw") / rated_power_kw).clip(0, 1.5).alias("dc_power_pu"),
        ])

    # Irradiance normalization
    if "poa_irradiance" in df.columns:
        df = df.with_columns([
            (pl.col("poa_irradiance") / 1000).alias("irradiance_normalized"),
        ])

        # Performance ratio
        if "dc_power_pu" in df.columns:
            df = df.with_columns([
                (pl.col("dc_power_pu") / (pl.col("irradiance_normalized") + 1e-6))
                .clip(0, 1.5).alias("performance_ratio"),
            ])

    # Temperature features
    if "module_temp" in df.columns:
        # Estimate ambient temperature from irradiance
        df = df.with_columns([
            (pl.col("module_temp") - pl.col("poa_irradiance") / 100 * 0.5).alias("ambient_temp_est"),
        ])

        df = df.with_columns([
            (pl.col("module_temp") - pl.col("ambient_temp_est")).alias("temp_rise"),
        ])

        # Temperature delta max (proxy for hotspots - use CV of module temps)
        # With single sensor, use temp rise as proxy
        df = df.with_columns([
            (pl.col("temp_rise") * 1.2).alias("temp_delta_max"),  # Scaled estimate
        ])

    # Synthetic features for models without direct data
    n = len(df)

    # Hotspot count (synthetic - based on temperature and current imbalance)
    if "temp_rise" in df.columns and "string_current_cv" in df.columns:
        df = df.with_columns([
            (
                (pl.col("temp_rise") / 10 + pl.col("string_current_cv") * 10)
                .round(0).cast(pl.Int32).clip(0, 10)
            ).alias("hotspot_count"),
        ])
    else:
        df = df.with_columns([
            pl.lit(0).alias("hotspot_count"),
        ])

    # Insulation resistance (synthetic - based on humidity/temperature proxy)
    # IEC 62446: Riso > 40 MΩ/kWp is acceptable
    if "module_temp" in df.columns:
        # Higher temp = lower insulation (simplified model)
        df = df.with_columns([
            (100 - pl.col("module_temp") * 0.5 + np.random.normal(0, 5, n)).clip(20, 200).alias("riso_value"),
        ])
    else:
        df = df.with_columns([
            pl.lit(100.0).alias("riso_value"),  # Default healthy value
        ])

    # AC power (proxy from DC with 95% efficiency)
    if "dc_power_pu" in df.columns:
        df = df.with_columns([
            (pl.col("dc_power_pu") * 0.95).alias("ac_power_pu"),
        ])

    # =========================================================================
    # Additional features for thermal_hotspot model
    # =========================================================================
    if "temp_rise" in df.columns:
        # temp_delta is same as temp_rise (module - ambient)
        df = df.with_columns([
            pl.col("temp_rise").alias("temp_delta"),
        ])

        # Synthetic trend features (approximate with scaled noise)
        df = df.with_columns([
            (pl.col("temp_delta") * 0.1 + pl.Series("_n1", np.random.normal(0, 0.5, n))).alias("temp_delta_trend_7d"),
            (pl.col("temp_delta") * 1.1 + pl.Series("_n2", np.random.uniform(0, 2, n))).alias("temp_delta_95th_7d"),
            (pl.col("temp_delta") * 1.15 + pl.Series("_n3", np.random.uniform(0, 3, n))).alias("temp_delta_max_7d"),
        ])

    if "dc_power_pu" in df.columns:
        df = df.with_columns([
            pl.col("dc_power_pu").alias("power_pu"),
        ])

    if "ambient_temp_est" in df.columns:
        df = df.with_columns([
            pl.col("ambient_temp_est").alias("ambient_temp"),
        ])

    # =========================================================================
    # Additional features for insulation model
    # =========================================================================
    if "riso_value" in df.columns:
        # Synthetic trend (slight degradation over time)
        df = df.with_columns([
            pl.Series("riso_trend_30d", np.random.normal(-0.5, 0.3, n)),
        ])

    # Humidity proxy (based on temperature - higher temp often means lower humidity)
    if "module_temp" in df.columns:
        df = df.with_columns([
            (80 - pl.col("module_temp") * 0.5 + pl.Series("_h", np.random.normal(0, 10, n))).clip(20, 95).alias("humidity_avg_7d"),
        ])
    else:
        df = df.with_columns([
            pl.lit(50.0).alias("humidity_avg_7d"),
        ])

    # Temperature cycles (synthetic - based on temp variance)
    if "module_temp" in df.columns:
        df = df.with_columns([
            (pl.col("module_temp").abs() / 10 + pl.Series("_tc", np.random.uniform(0, 5, n))).round(0).cast(pl.Int32).clip(0, 30).alias("temp_cycles_30d"),
        ])
    else:
        df = df.with_columns([
            pl.lit(10).alias("temp_cycles_30d"),
        ])

    # Age (synthetic - random 0-25 years)
    df = df.with_columns([
        pl.Series("age_years", np.random.uniform(0.5, 20, n)),
    ])

    # =========================================================================
    # Additional features for module_degradation model
    # =========================================================================
    if "performance_ratio" in df.columns:
        df = df.with_columns([
            pl.Series("pr_trend_30d", np.random.normal(-0.001, 0.0005, n)),
            pl.Series("efficiency_trend_30d", np.random.normal(-0.0005, 0.0003, n)),
            pl.Series("pr_acceleration_7d", np.random.normal(0, 0.0002, n)),
        ])

    print(f"  Created features: {[c for c in df.columns if c not in LAZZARETTI_COLUMNS.values()]}")

    return df


def generate_synthetic_rul_labels(
    df: pl.DataFrame,
    fault_type: str,
    metric_col: str,
    config: RULModelConfig,
) -> pl.DataFrame:
    """Generate synthetic RUL labels for training."""
    threshold = config.threshold
    max_days = float(config.max_horizon_days)

    if metric_col not in df.columns:
        print(f"    Warning: Metric column '{metric_col}' not found for {fault_type}")
        # Create default labels
        return df.with_columns([
            pl.lit(max_days).alias("days_to_fault"),
        ])

    # Determine if higher values are worse (use config)
    higher_is_worse = config.higher_is_worse

    if higher_is_worse:
        # Higher values = closer to threshold = lower RUL
        # e.g., temp_rise, string_current_cv, hotspot_count
        df = df.with_columns([
            pl.when(pl.col(metric_col) >= threshold)
            .then(0.0)
            .otherwise(
                ((threshold - pl.col(metric_col)) / threshold * max_days).clip(0, max_days)
            )
            .alias("days_to_fault")
        ])
    else:
        # Lower values = closer to threshold = lower RUL
        # e.g., performance_ratio, string_balance_ratio, riso_value
        max_val = df[metric_col].max()
        df = df.with_columns([
            pl.when(pl.col(metric_col) <= threshold)
            .then(0.0)
            .otherwise(
                ((pl.col(metric_col) - threshold) / (max_val - threshold + 1e-6) * max_days).clip(0, max_days)
            )
            .alias("days_to_fault")
        ])

    # Add some noise for realism
    noise = np.random.normal(0, max_days * 0.1, len(df))
    df = df.with_columns([
        (pl.col("days_to_fault") + pl.Series("_noise", noise)).clip(0, max_days).alias("days_to_fault")
    ])

    return df


# =============================================================================
# Training Pipeline
# =============================================================================

def train_single_model(
    df: pl.DataFrame,
    fault_type: str,
    output_dir: Path,
    test_size: float = 0.2,
    val_size: float = 0.1,
) -> Optional[RULTrainingResult]:
    """Train a single RUL model."""
    start_time = time.time()

    config = ALL_RUL_CONFIGS[fault_type]
    metric_col = METRIC_MAPPINGS.get(fault_type, "string_current_cv")

    print(f"\n{'=' * 60}")
    print(f"Training: {config.display_name} ({fault_type})")
    print(f"{'=' * 60}")
    print(f"  Metric: {metric_col}")
    print(f"  Threshold: {config.threshold} {config.unit}")
    print(f"  Max horizon: {config.max_horizon_days} days")

    # Generate labels
    df_labeled = generate_synthetic_rul_labels(df, fault_type, metric_col, config)

    # Create model
    model = create_rul_model(fault_type)
    feature_cols = model.feature_columns

    # Check available features
    available_features = [c for c in feature_cols if c in df_labeled.columns]

    if len(available_features) < 2:
        print(f"  Skipping: Not enough features. Need {feature_cols}, have {available_features}")
        return None

    print(f"  Features: {len(available_features)}/{len(feature_cols)}")

    # Prepare training data
    X = df_labeled.select(available_features).to_numpy()
    y = df_labeled["days_to_fault"].to_numpy()

    # Remove NaN/inf
    valid_mask = ~(np.isnan(X).any(axis=1) | np.isnan(y) | np.isinf(X).any(axis=1) | np.isinf(y))
    X = X[valid_mask]
    y = y[valid_mask]

    if len(X) < 1000:
        print(f"  Skipping: Not enough valid samples ({len(X)})")
        return None

    print(f"  Valid samples: {len(X):,}")
    print(f"  Label range: {y.min():.1f} - {y.max():.1f} days")

    # Split data
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_train, y_train, test_size=val_size, random_state=42
    )

    print(f"  Train: {len(X_train):,}, Val: {len(X_val):,}, Test: {len(X_test):,}")

    # Train model
    print("\n  Training...")
    metrics = model.train(X_train, y_train, X_val, y_val)

    # Evaluate
    print("\n  Evaluating...")
    y_pred = model.predict(X_test)

    evaluator = MultiHorizonEvaluator()
    eval_result = evaluator.evaluate(y_test, y_pred)

    # Print results
    print(f"\n  TEST RESULTS")
    print(f"  {'-' * 40}")
    print(f"  MAE:        {eval_result.mae:.2f} days")
    print(f"  RMSE:       {eval_result.rmse:.2f} days")
    print(f"  Median AE:  {eval_result.median_ae:.2f} days")
    print(f"\n  HORIZON ACCURACY")
    for horizon in sorted(eval_result.horizon_metrics.keys()):
        pct = eval_result.horizon_metrics[horizon].accuracy_pct
        bar = "#" * int(pct / 5)
        print(f"    Within {horizon:2d}d: {pct:5.1f}% {bar}")
    print(f"\n  OPERATIONAL")
    print(f"    Overestimate:  {eval_result.overestimate_rate:.1f}%")
    print(f"    Underestimate: {eval_result.underestimate_rate:.1f}%")

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

    training_time = time.time() - start_time

    # Create result
    horizons = {h: eval_result.within(h) for h in DEFAULT_HORIZONS}

    return RULTrainingResult(
        fault_type=fault_type,
        train_mae=metrics.get("train_mae", 0),
        val_mae=metrics.get("val_mae", 0),
        test_mae=eval_result.mae,
        test_rmse=eval_result.rmse,
        test_median_ae=eval_result.median_ae,
        horizons=horizons,
        overestimate_rate=eval_result.overestimate_rate,
        underestimate_rate=eval_result.underestimate_rate,
        n_train=len(X_train),
        n_test=len(X_test),
        feature_importance=model.get_feature_importance(),
        training_time=training_time,
        model_path=str(model_path),
        meets_criteria=meets_criteria,
        config=config,
    )


def train_all_models(
    lazzaretti_path: Optional[Path] = None,
    output_dir: Path = OUTPUT_DIR,
) -> Dict[str, RULTrainingResult]:
    """Train all 7 RUL models."""
    print("=" * 70)
    print("RUL MODEL TRAINING - ALL 7 FAULT TYPES")
    print("=" * 70)
    print(f"\nOutput directory: {output_dir}")

    # Load and prepare data
    if lazzaretti_path is None:
        lazzaretti_path = DEFAULT_LAZZARETTI_PATH

    df = load_lazzaretti(lazzaretti_path)

    if df.height == 0:
        print("\nNo data loaded. Please provide a valid dataset path.")
        return {}

    df = prepare_lazzaretti_features(df)

    # Train each model
    results: Dict[str, RULTrainingResult] = {}

    for fault_type in RUL_TYPES:
        try:
            result = train_single_model(df, fault_type, output_dir)
            if result:
                results[fault_type] = result
        except Exception as e:
            print(f"\n  Error training {fault_type}: {e}")
            import traceback
            traceback.print_exc()

    # Save summary
    summary = {
        "timestamp": datetime.now().isoformat(),
        "data_source": str(lazzaretti_path),
        "n_samples": len(df),
        "n_models_trained": len(results),
        "n_models_failed": len(RUL_TYPES) - len(results),
        "evaluation_horizons": DEFAULT_HORIZONS,
        "models": {k: v.to_dict() for k, v in results.items()},
    }

    summary_path = output_dir / "training_summary.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    # Print final summary
    print("\n" + "=" * 80)
    print("TRAINING COMPLETE - MULTI-HORIZON SUMMARY")
    print("=" * 80)
    print(f"\n{'Model':<25} {'MAE':>7} {'W/1d':>7} {'W/3d':>7} {'W/7d':>7} {'W/14d':>7} {'W/30d':>7} {'Pass':>6}")
    print("-" * 80)

    for fault_type in RUL_TYPES:
        if fault_type in results:
            r = results[fault_type]
            status = "✅" if r.meets_criteria else "⚠️"
            print(
                f"{fault_type:<25} "
                f"{r.test_mae:>6.1f}d "
                f"{r.horizons.get(1, 0):>6.1f}% "
                f"{r.horizons.get(3, 0):>6.1f}% "
                f"{r.horizons.get(7, 0):>6.1f}% "
                f"{r.horizons.get(14, 0):>6.1f}% "
                f"{r.horizons.get(30, 0):>6.1f}% "
                f"{status:>6}"
            )
        else:
            print(f"{fault_type:<25} {'SKIPPED':^60}")

    print("=" * 80)
    print(f"\nModels saved to: {output_dir}")
    print(f"Summary saved to: {summary_path}")

    # Generate markdown report
    report_path = output_dir / "training_report.md"
    generate_report(results, summary, report_path)
    print(f"Report saved to: {report_path}")

    return results


def generate_report(
    results: Dict[str, RULTrainingResult],
    summary: dict,
    path: Path,
):
    """Generate markdown training report."""
    lines = []

    lines.append("# RUL Model Training Report\n")
    lines.append(f"*Generated: {summary['timestamp']}*\n")

    lines.append("## Summary\n")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Data source | {summary['data_source']} |")
    lines.append(f"| Total samples | {summary['n_samples']:,} |")
    lines.append(f"| Models trained | {summary['n_models_trained']} |")
    lines.append(f"| Models failed | {summary['n_models_failed']} |")
    lines.append("")

    lines.append("## Model Performance\n")
    lines.append("| Model | MAE | W/3d | W/7d | W/30d | Status |")
    lines.append("|-------|-----|------|------|-------|--------|")

    for fault_type in RUL_TYPES:
        if fault_type in results:
            r = results[fault_type]
            status = "✅ Pass" if r.meets_criteria else "⚠️ Warn"
            lines.append(
                f"| {r.config.display_name} | "
                f"{r.test_mae:.1f}d | "
                f"{r.horizons.get(3, 0):.0f}% | "
                f"{r.horizons.get(7, 0):.0f}% | "
                f"{r.horizons.get(30, 0):.0f}% | "
                f"{status} |"
            )
        else:
            lines.append(f"| {fault_type} | - | - | - | - | ❌ Skipped |")

    lines.append("")

    # Per-model details
    for fault_type, r in results.items():
        lines.append(f"## {r.config.display_name}\n")
        lines.append(f"- **Threshold**: {r.config.threshold} {r.config.unit}")
        lines.append(f"- **Max horizon**: {r.config.max_horizon_days} days")
        lines.append(f"- **Training samples**: {r.n_train:,}")
        lines.append(f"- **Test samples**: {r.n_test:,}")
        lines.append(f"- **Training time**: {r.training_time:.1f}s")
        lines.append(f"- **Model path**: `{r.model_path}`")
        lines.append("")

        lines.append("### Metrics")
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| MAE | {r.test_mae:.2f} days |")
        lines.append(f"| RMSE | {r.test_rmse:.2f} days |")
        lines.append(f"| Median AE | {r.test_median_ae:.2f} days |")
        lines.append(f"| Overestimate rate | {r.overestimate_rate:.1f}% |")
        lines.append(f"| Underestimate rate | {r.underestimate_rate:.1f}% |")
        lines.append("")

        lines.append("### Feature Importance (Top 5)")
        sorted_fi = sorted(r.feature_importance.items(), key=lambda x: -x[1])[:5]
        for fname, importance in sorted_fi:
            lines.append(f"- {fname}: {importance:.1f}%")
        lines.append("")

    with open(path, "w") as f:
        f.write("\n".join(lines))


# =============================================================================
# Main
# =============================================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Train all 7 RUL models")
    parser.add_argument(
        "--lazzaretti-path",
        type=Path,
        default=DEFAULT_LAZZARETTI_PATH,
        help="Path to Lazzaretti dataset",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Output directory for models",
    )

    args = parser.parse_args()

    results = train_all_models(args.lazzaretti_path, args.output_dir)

    # Return exit code based on success
    if len(results) >= 3:  # At least 3 models trained
        return 0
    else:
        return 1


if __name__ == "__main__":
    sys.exit(main())
