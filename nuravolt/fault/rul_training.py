"""
RUL Model Training Pipeline

Train all 3 RUL models (string degradation, inverter thermal, module degradation)
from labeled data using synthetic RUL labels.
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
import json
import numpy as np
import polars as pl
from sklearn.model_selection import train_test_split

from .rul_labels import (
    RULLabelGenerator,
    STRING_DEGRADATION_CONFIG,
    INVERTER_THERMAL_CONFIG,
    MODULE_DEGRADATION_CONFIG,
    create_rul_labels_for_training,
)
from .rul_models import (
    RULStringDegradationModel,
    RULInverterThermalModel,
    RULModuleDegradationModel,
    BaseRULModel,
    create_rul_model,
)
from .features import PlantAgnosticFeatureEngine, PlantConfig
from .rul_evaluation import (
    MultiHorizonEvaluator,
    MultiHorizonResult,
    check_success_criteria,
    DEFAULT_HORIZONS,
)


@dataclass
class RULTrainingConfig:
    """Configuration for RUL model training."""

    # Data split
    test_size: float = 0.2
    val_size: float = 0.1  # From training set
    random_seed: int = 42

    # Training parameters
    min_samples_per_fault: int = 1000
    max_samples_per_fault: int = 100000

    # Label generation
    use_synthetic_labels: bool = True


@dataclass
class RULTrainingResult:
    """Results from training an RUL model."""

    fault_type: str
    train_mae: float
    val_mae: float
    test_mae: float

    # Multi-horizon metrics (replaces single within_3_days)
    test_within_1d: float  # % within 1 day
    test_within_3d: float  # % within 3 days
    test_within_7d: float  # % within 7 days
    test_within_14d: float  # % within 14 days
    test_within_30d: float  # % within 30 days

    # Additional metrics
    test_rmse: float
    test_median_ae: float
    overestimate_rate: float  # % predictions > actual
    underestimate_rate: float  # % predictions < actual

    n_train_samples: int
    n_test_samples: int
    feature_importance: dict[str, float]
    training_time_seconds: float
    model_path: str

    # Success criteria check
    meets_criteria: bool = False
    criteria_details: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "fault_type": self.fault_type,
            "mae": round(self.test_mae, 4),
            "rmse": round(self.test_rmse, 4),
            "median_ae": round(self.test_median_ae, 4),
            "horizons": {
                "within_1d": round(self.test_within_1d, 2),
                "within_3d": round(self.test_within_3d, 2),
                "within_7d": round(self.test_within_7d, 2),
                "within_14d": round(self.test_within_14d, 2),
                "within_30d": round(self.test_within_30d, 2),
            },
            "operational": {
                "overestimate_rate": round(self.overestimate_rate, 2),
                "underestimate_rate": round(self.underestimate_rate, 2),
            },
            "samples": {
                "train": self.n_train_samples,
                "test": self.n_test_samples,
            },
            "model_path": self.model_path,
            "meets_criteria": self.meets_criteria,
        }


class RULTrainingPipeline:
    """
    Train RUL models from labeled data.

    Workflow:
    1. Load and prepare data
    2. Generate synthetic RUL labels
    3. Compute features (including RUL temporal features)
    4. Train model with early stopping
    5. Evaluate and save
    """

    def __init__(self, config: Optional[RULTrainingConfig] = None):
        self.config = config or RULTrainingConfig()

    def prepare_training_data(
        self,
        df: pl.DataFrame,
        fault_type: str,
        metric_col: str,
        plant_config: Optional[PlantConfig] = None,
    ) -> tuple[np.ndarray, np.ndarray, list[str]]:
        """
        Prepare training data for a specific fault type.

        Args:
            df: Input DataFrame
            fault_type: Type of fault to train for
            metric_col: Column containing the metric to monitor
            plant_config: Plant configuration for feature engineering

        Returns:
            Tuple of (X, y, feature_names)
        """
        # Create default plant config if not provided
        if plant_config is None:
            plant_config = PlantConfig(
                rated_dc_power_kw=1000.0,  # Default
                rated_ac_power_kw=900.0,
            )

        # Generate synthetic RUL labels
        df_labeled = create_rul_labels_for_training(
            df, fault_type, metric_col
        )

        # Compute features (including RUL temporal features)
        engine = PlantAgnosticFeatureEngine(plant_config)
        df_features = engine.transform(
            df_labeled,
            include_temporal=True,
            include_rul_features=True,
        )

        # Get model to know required features
        model = create_rul_model(fault_type)
        feature_cols = model.feature_columns

        # Check which features are available
        available_features = [c for c in feature_cols if c in df_features.columns]

        if len(available_features) < 2:
            raise ValueError(
                f"Not enough features available for {fault_type}. "
                f"Required: {feature_cols}, Available: {available_features}"
            )

        # Extract features and labels
        X = df_features.select(available_features).to_numpy()
        y = df_features["days_to_fault"].to_numpy()

        # Remove samples with NaN
        valid_mask = ~(np.isnan(X).any(axis=1) | np.isnan(y))
        X = X[valid_mask]
        y = y[valid_mask]

        return X, y, available_features

    def train_single_model(
        self,
        df: pl.DataFrame,
        fault_type: str,
        metric_col: str,
        output_dir: Path,
        plant_config: Optional[PlantConfig] = None,
    ) -> RULTrainingResult:
        """
        Train a single RUL model.

        Args:
            df: Training data
            fault_type: Type of fault
            metric_col: Metric column
            output_dir: Directory to save model
            plant_config: Plant configuration

        Returns:
            Training result
        """
        import time
        start_time = time.time()

        print(f"\nTraining RUL model for: {fault_type}")
        print("-" * 40)

        # Prepare data
        X, y, feature_names = self.prepare_training_data(
            df, fault_type, metric_col, plant_config
        )

        print(f"  Samples: {len(X):,}")
        print(f"  Features: {len(feature_names)}")
        print(f"  Label range: {y.min():.1f} - {y.max():.1f} days")

        # Cap samples
        if len(X) > self.config.max_samples_per_fault:
            indices = np.random.choice(len(X), self.config.max_samples_per_fault, replace=False)
            X = X[indices]
            y = y[indices]
            print(f"  Sampled to {len(X):,} samples")

        # Split data
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=self.config.test_size, random_state=self.config.random_seed
        )

        X_train, X_val, y_train, y_val = train_test_split(
            X_train, y_train, test_size=self.config.val_size, random_state=self.config.random_seed
        )

        print(f"  Train: {len(X_train):,}, Val: {len(X_val):,}, Test: {len(X_test):,}")

        # Create and train model
        model = create_rul_model(fault_type)
        metrics = model.train(X_train, y_train, X_val, y_val)

        # Evaluate on test set using multi-horizon evaluator
        y_test_pred = model.predict(X_test)

        evaluator = MultiHorizonEvaluator()
        eval_result = evaluator.evaluate(y_test, y_test_pred)

        # Print multi-horizon results
        print(f"\n  TEST SET EVALUATION")
        print(f"  {'-' * 36}")
        print(f"  MAE:        {eval_result.mae:.2f} days")
        print(f"  RMSE:       {eval_result.rmse:.2f} days")
        print(f"  Median AE:  {eval_result.median_ae:.2f} days")
        print(f"\n  HORIZON ACCURACY")
        for horizon in sorted(eval_result.horizon_metrics.keys()):
            pct = eval_result.horizon_metrics[horizon].accuracy_pct
            bar = "#" * int(pct / 5)
            print(f"  Within {horizon:2d}d: {pct:5.1f}% {bar}")
        print(f"\n  OPERATIONAL")
        print(f"  Overestimate:  {eval_result.overestimate_rate:.1f}%")
        print(f"  Underestimate: {eval_result.underestimate_rate:.1f}%")

        # Check success criteria
        meets_criteria, criteria_details = check_success_criteria(fault_type, eval_result)
        if meets_criteria:
            print(f"\n  SUCCESS: Model meets all criteria")
        else:
            print(f"\n  WARNING: Model does not meet all criteria")

        # Save model
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        model_path = output_dir / f"rul_{fault_type}.pkl"
        model.save(model_path)
        print(f"\n  Saved to: {model_path}")

        training_time = time.time() - start_time

        return RULTrainingResult(
            fault_type=fault_type,
            train_mae=metrics["train_mae"],
            val_mae=metrics.get("val_mae", 0),
            test_mae=eval_result.mae,
            test_within_1d=eval_result.within(1),
            test_within_3d=eval_result.within(3),
            test_within_7d=eval_result.within(7),
            test_within_14d=eval_result.within(14),
            test_within_30d=eval_result.within(30),
            test_rmse=eval_result.rmse,
            test_median_ae=eval_result.median_ae,
            overestimate_rate=eval_result.overestimate_rate,
            underestimate_rate=eval_result.underestimate_rate,
            n_train_samples=len(X_train),
            n_test_samples=len(X_test),
            feature_importance=model.get_feature_importance(),
            training_time_seconds=training_time,
            model_path=str(model_path),
            meets_criteria=meets_criteria,
            criteria_details=criteria_details,
        )


def train_all_rul_models(
    data_path: str,
    output_dir: str = "models/rul",
    plant_config: Optional[PlantConfig] = None,
) -> dict:
    """
    Train all 3 RUL models from data.

    Args:
        data_path: Path to training data (parquet file)
        output_dir: Directory to save models
        plant_config: Plant configuration

    Returns:
        Dictionary with training results for each model
    """
    print("=" * 60)
    print("RUL MODEL TRAINING PIPELINE")
    print("=" * 60)

    # Load data
    print(f"\nLoading data from {data_path}...")
    df = pl.read_parquet(data_path)
    print(f"  Loaded {len(df):,} samples")

    pipeline = RULTrainingPipeline()
    output_path = Path(output_dir)

    results = {}

    # Define fault types and their metric columns
    # Note: These mappings depend on your data schema
    fault_configs = [
        ("string_degradation", "string_current_cv"),
        ("inverter_thermal", "temp_rise"),
        ("module_degradation", "performance_ratio"),
    ]

    for fault_type, metric_col in fault_configs:
        if metric_col not in df.columns:
            print(f"\nSkipping {fault_type}: metric column '{metric_col}' not found")
            continue

        try:
            result = pipeline.train_single_model(
                df, fault_type, metric_col, output_path, plant_config
            )
            results[fault_type] = result
        except Exception as e:
            print(f"\nError training {fault_type}: {e}")
            continue

    # Save summary with multi-horizon metrics
    summary_path = output_path / "training_summary.json"
    summary = {
        "timestamp": datetime.now().isoformat(),
        "data_path": str(data_path),
        "n_models_trained": len(results),
        "evaluation_horizons": DEFAULT_HORIZONS,
        "results": {k: v.to_dict() for k, v in results.items()},
    }

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    # Print comparison table
    print(f"\n{'=' * 80}")
    print("TRAINING COMPLETE - MULTI-HORIZON SUMMARY")
    print("=" * 80)
    print(f"\n{'Model':<25} {'MAE':>7} {'W/1d':>7} {'W/3d':>7} {'W/7d':>7} {'W/14d':>7} {'W/30d':>7}")
    print("-" * 80)
    for name, result in results.items():
        print(f"{name:<25} {result.test_mae:>6.2f}d {result.test_within_1d:>6.1f}% "
              f"{result.test_within_3d:>6.1f}% {result.test_within_7d:>6.1f}% "
              f"{result.test_within_14d:>6.1f}% {result.test_within_30d:>6.1f}%")
    print("=" * 80)
    print(f"\nModels saved to: {output_path}")
    print(f"Summary saved to: {summary_path}")

    return results


def train_from_lazzaretti(
    lazzaretti_path: str,
    output_dir: str = "models/rul",
) -> dict:
    """
    Train RUL models specifically from Lazzaretti dataset.

    Args:
        lazzaretti_path: Path to Lazzaretti parquet file
        output_dir: Directory to save models

    Returns:
        Training results
    """
    import time

    print("=" * 60)
    print("TRAINING RUL MODELS FROM LAZZARETTI DATASET")
    print("=" * 60)

    # Load Lazzaretti data
    df = pl.read_parquet(lazzaretti_path)
    print(f"Loaded {len(df):,} samples from Lazzaretti")

    # Lazzaretti columns:
    # - fault_class (0=normal, 1=short, 2=degradation, 3=open, 4=shading)
    # - poa_irradiance, module_temp
    # - string_current_1, string_current_2, string_voltage_1, string_voltage_2

    # Compute string CV from string currents
    df = df.with_columns([
        ((pl.col("string_current_1") + pl.col("string_current_2")) / 2).alias("string_current_mean"),
    ])

    df = df.with_columns([
        (
            ((pl.col("string_current_1") - pl.col("string_current_mean")).abs() +
             (pl.col("string_current_2") - pl.col("string_current_mean")).abs()) /
            (2 * pl.col("string_current_mean") + 1e-6)
        ).alias("string_current_cv"),
    ])

    # Compute simple performance ratio proxy
    # (actual power / expected power based on irradiance)
    df = df.with_columns([
        (
            (pl.col("string_current_1") * pl.col("string_voltage_1") +
             pl.col("string_current_2") * pl.col("string_voltage_2")) /
            (pl.col("poa_irradiance") + 1e-6) / 10  # Normalize
        ).clip(0, 1.5).alias("performance_ratio"),
    ])

    # Compute temperature rise (module - ambient approximation)
    # Lazzaretti only has module_temp, estimate ambient from irradiance
    df = df.with_columns([
        (pl.col("module_temp") - pl.col("poa_irradiance") / 100 * 0.5).alias("ambient_temp_est"),
    ])

    df = df.with_columns([
        (pl.col("module_temp") - pl.col("ambient_temp_est")).alias("temp_rise"),
    ])

    # Add irradiance normalization
    df = df.with_columns([
        (pl.col("poa_irradiance") / 1000).alias("irradiance_normalized"),
    ])

    # Add string min/max ratios
    df = df.with_columns([
        (pl.min_horizontal(pl.col("string_current_1"), pl.col("string_current_2")) /
         (pl.col("string_current_mean") + 1e-6)).alias("string_current_min_ratio"),
        (pl.max_horizontal(pl.col("string_current_1"), pl.col("string_current_2")) /
         (pl.col("string_current_mean") + 1e-6)).alias("string_current_max_ratio"),
    ])

    # Add ac_power_pu proxy
    df = df.with_columns([
        ((pl.col("string_current_1") * pl.col("string_voltage_1") +
          pl.col("string_current_2") * pl.col("string_voltage_2")) / 5000).clip(0, 1.5).alias("ac_power_pu"),
    ])

    print(f"Computed features. Columns: {df.columns}")

    # Create output directory
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Create default plant config
    plant_config = PlantConfig(
        rated_dc_power_kw=5.0,  # Lazzaretti is 5 kW
        rated_ac_power_kw=4.5,
        n_strings=2,
    )

    # Train models directly with prepared data
    pipeline = RULTrainingPipeline()
    results = {}

    # Define fault types and their metric columns (now available)
    fault_configs = [
        ("string_degradation", "string_current_cv"),
        ("inverter_thermal", "temp_rise"),
        ("module_degradation", "performance_ratio"),
    ]

    for fault_type, metric_col in fault_configs:
        if metric_col not in df.columns:
            print(f"\nSkipping {fault_type}: metric column '{metric_col}' not found")
            continue

        try:
            result = pipeline.train_single_model(
                df, fault_type, metric_col, output_path, plant_config
            )
            results[fault_type] = result
        except Exception as e:
            print(f"\nError training {fault_type}: {e}")
            import traceback
            traceback.print_exc()
            continue

    # Save summary with multi-horizon metrics
    summary_path = output_path / "training_summary.json"
    summary = {
        "timestamp": datetime.now().isoformat(),
        "data_path": str(lazzaretti_path),
        "n_models_trained": len(results),
        "evaluation_horizons": DEFAULT_HORIZONS,
        "results": {k: v.to_dict() for k, v in results.items()},
    }

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    # Print comparison table
    print(f"\n{'=' * 80}")
    print("TRAINING COMPLETE - MULTI-HORIZON SUMMARY")
    print("=" * 80)
    print(f"\n{'Model':<25} {'MAE':>7} {'W/1d':>7} {'W/3d':>7} {'W/7d':>7} {'W/14d':>7} {'W/30d':>7}")
    print("-" * 80)
    for name, result in results.items():
        print(f"{name:<25} {result.test_mae:>6.2f}d {result.test_within_1d:>6.1f}% "
              f"{result.test_within_3d:>6.1f}% {result.test_within_7d:>6.1f}% "
              f"{result.test_within_14d:>6.1f}% {result.test_within_30d:>6.1f}%")
    print("=" * 80)
    print(f"\nModels saved to: {output_path}")

    return results


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python -m nuravolt.fault.rul_training <data_path> [output_dir]")
        sys.exit(1)

    data_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "models/rul"

    train_all_rul_models(data_path, output_dir)
