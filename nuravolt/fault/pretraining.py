"""
Fault Detection Foundation Model Pretraining

Trains two CatBoost classifiers for fault detection:
1. SystemLevelClassifier: Uses only system-level features (13 fault classes)
2. StringLevelClassifier: Uses system + string features (22 fault classes)

The models use plant-agnostic features so they can transfer to any plant.
"""

import pickle
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, Literal, Union, List, Tuple, Dict
import json

import numpy as np
import polars as pl
from catboost import CatBoostClassifier, Pool
from sklearn.model_selection import train_test_split, StratifiedKFold
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    accuracy_score,
    f1_score,
)


# Unified fault taxonomy
UNIFIED_FAULT_CLASSES = {
    0: {"name": "Normal", "type": "normal", "data_level": "system"},
    1: {"name": "String Open Circuit", "type": "reactive", "data_level": "string"},
    2: {"name": "String Short Circuit", "type": "reactive", "data_level": "string"},
    3: {"name": "String Degradation", "type": "predictive", "data_level": "string"},
    4: {"name": "Partial Shading/Soiling", "type": "predictive", "data_level": "system"},
    5: {"name": "Inverter Fault", "type": "reactive", "data_level": "system"},
    6: {"name": "Grid Fault", "type": "reactive", "data_level": "system"},
    7: {"name": "Sensor/Controller Fault", "type": "reactive", "data_level": "system"},
    8: {"name": "Array Fault", "type": "reactive", "data_level": "string"},
}

# System-level fault classes (detectable without string data)
SYSTEM_LEVEL_CLASSES = [0, 4, 5, 6, 7]

# String-level fault classes (require string data)
STRING_LEVEL_CLASSES = [0, 1, 2, 3, 4, 5, 6, 7, 8]


@dataclass
class PretrainingConfig:
    """Configuration for model pretraining."""

    # Model parameters
    iterations: int = 1000
    learning_rate: float = 0.05
    depth: int = 6
    l2_leaf_reg: float = 3.0
    random_seed: int = 42

    # Training parameters
    test_size: float = 0.2
    n_cv_folds: int = 5
    early_stopping_rounds: int = 50

    # Class balancing
    auto_class_weights: str = "Balanced"  # "Balanced" or "SqrtBalanced"

    # Feature selection
    system_features: List[str] = field(default_factory=lambda: [
        "dc_power_pu",
        "ac_power_pu",
        "power_ratio",
        "inverter_efficiency",
        "performance_ratio",
        "clearsky_ratio",
        "voltage_ratio",
        "current_ratio",
        "temp_rise",
        "temp_coefficient_factor",
        "irradiance_normalized",
    ])

    string_features: List[str] = field(default_factory=lambda: [
        "string_current_mean_pu",
        "string_current_cv",
        "string_current_min_ratio",
        "string_current_max_ratio",
        "string_current_skew",
        "strings_underperforming_pct",
        "worst_string_zscore",
        "string_voltage_cv",
        "string_voltage_min_ratio",
    ])


@dataclass
class TrainingResult:
    """Results from model training."""

    accuracy: float
    f1_macro: float
    f1_per_class: Dict[int, float]
    confusion_matrix: List[List[int]]
    classification_report: str
    feature_importance: Dict[str, float]
    training_time_seconds: float
    n_train_samples: int
    n_test_samples: int
    model_path: Optional[str] = None


class FaultDatasetLoader:
    """
    Load and unify fault datasets for training.

    Combines GPVS-Faults and Lazzaretti datasets into unified format.
    """

    def __init__(self, data_dirs: Dict[str, str]):
        """
        Initialize loader with dataset directories.

        Args:
            data_dirs: Dictionary mapping dataset names to paths
                       e.g., {"gpvs": "datasets/labeled/gpvs_faults/parquet",
                              "lazzaretti": "datasets/labeled/lazzaretti"}
        """
        self.data_dirs = data_dirs

    def load_unified_dataset(
        self,
        include_string_features: bool = True,
    ) -> Tuple[pl.DataFrame, List[str]]:
        """
        Load and unify all available datasets.

        Args:
            include_string_features: Whether to include string-level features

        Returns:
            Tuple of (unified DataFrame, list of feature columns)
        """
        datasets = []

        # Load GPVS-Faults if available
        if "gpvs" in self.data_dirs:
            try:
                gpvs_df = self._load_gpvs()
                datasets.append(gpvs_df)
                print(f"Loaded GPVS-Faults: {len(gpvs_df):,} samples")
            except Exception as e:
                print(f"Could not load GPVS-Faults: {e}")

        # Load Lazzaretti if available
        if "lazzaretti" in self.data_dirs:
            try:
                lazz_df = self._load_lazzaretti()
                datasets.append(lazz_df)
                print(f"Loaded Lazzaretti: {len(lazz_df):,} samples")
            except Exception as e:
                print(f"Could not load Lazzaretti: {e}")

        if not datasets:
            raise ValueError("No datasets could be loaded")

        # Combine datasets
        # Find common columns
        common_cols = set(datasets[0].columns)
        for df in datasets[1:]:
            common_cols &= set(df.columns)

        # Select common columns and concatenate
        unified = pl.concat([df.select(sorted(common_cols)) for df in datasets])

        print(f"\nUnified dataset: {len(unified):,} samples")
        print(f"Columns: {sorted(common_cols)}")

        # Determine feature columns
        feature_cols = [c for c in unified.columns if c not in ["fault_class", "dataset_source"]]

        return unified, feature_cols

    def _load_gpvs(self) -> pl.DataFrame:
        """Load GPVS-Faults dataset with unified schema."""
        data_path = Path(self.data_dirs["gpvs"])

        # Try combined file
        combined_file = data_path / "gpvs_faults_combined.parquet"
        if combined_file.exists():
            df = pl.read_parquet(combined_file)
        else:
            # Load individual files
            parquet_files = list(data_path.glob("F*.parquet"))
            if not parquet_files:
                raise FileNotFoundError(f"No GPVS parquet files in {data_path}")
            df = pl.concat([pl.read_parquet(f) for f in parquet_files])

        # Map to unified fault classes
        gpvs_mapping = {
            0: 0,  # Normal
            1: 8,  # Array fault
            2: 8,  # Array fault
            3: 5,  # Inverter fault
            4: 5,  # Inverter fault
            5: 6,  # Grid fault
            6: 6,  # Grid fault
            7: 7,  # Sensor/controller fault
        }

        df = df.with_columns([
            pl.col("fault_class").replace(gpvs_mapping).alias("fault_class"),
            pl.lit("gpvs").alias("dataset_source"),
        ])

        # Create normalized features from raw data
        df = self._create_features_gpvs(df)

        return df

    def _load_lazzaretti(self) -> pl.DataFrame:
        """Load Lazzaretti dataset with unified schema."""
        data_path = Path(self.data_dirs["lazzaretti"])

        parquet_file = data_path / "lazzaretti_faults.parquet"
        if parquet_file.exists():
            df = pl.read_parquet(parquet_file)
        else:
            csv_file = data_path / "dataset.csv"
            if csv_file.exists():
                df = pl.read_csv(csv_file)
            else:
                raise FileNotFoundError(f"No Lazzaretti data in {data_path}")

        # Map to unified fault classes
        lazz_mapping = {
            0: 0,  # Normal
            1: 2,  # Short circuit
            2: 3,  # Degradation
            3: 1,  # Open circuit
            4: 4,  # Partial shading
        }

        df = df.with_columns([
            pl.col("fault_class").replace(lazz_mapping).alias("fault_class"),
            pl.lit("lazzaretti").alias("dataset_source"),
        ])

        # Create normalized features
        df = self._create_features_lazzaretti(df)

        return df

    def _create_features_gpvs(self, df: pl.DataFrame) -> pl.DataFrame:
        """Create normalized features from GPVS raw data."""
        # GPVS has: pv_current, pv_voltage, dc_bus_voltage, ac currents/voltages

        features = df.with_columns([
            # Power features (normalized to reasonable scale)
            (pl.col("pv_current") * pl.col("pv_voltage") / 1000).alias("dc_power_pu"),
            (pl.col("ac_current_magnitude") * pl.col("ac_voltage_magnitude") / 1000).alias("ac_power_pu"),
        ])

        # Add derived features
        features = features.with_columns([
            (pl.col("ac_power_pu") / (pl.col("dc_power_pu") + 1e-6)).clip(0, 1.1).alias("power_ratio"),
            (pl.col("dc_bus_voltage") / (pl.col("pv_voltage") + 1e-6)).alias("voltage_ratio"),
        ])

        # Normalize to 0-1 range using rolling statistics
        for col in ["dc_power_pu", "ac_power_pu"]:
            features = features.with_columns([
                (pl.col(col) / (pl.col(col).rolling_max(100) + 1e-6)).alias(col)
            ])

        return features

    def _create_features_lazzaretti(self, df: pl.DataFrame) -> pl.DataFrame:
        """Create normalized features from Lazzaretti raw data."""
        # Lazzaretti has: string_voltage_1/2, string_current_1/2, poa_irradiance, module_temp

        # System specifications
        rated_power_kw = 5.0

        features = df

        # Rename if needed
        col_map = {
            "vdc1": "string_voltage_1",
            "vdc2": "string_voltage_2",
            "idc1": "string_current_1",
            "idc2": "string_current_2",
            "irr": "poa_irradiance",
            "pvt": "module_temp",
        }
        for old, new in col_map.items():
            if old in features.columns and new not in features.columns:
                features = features.rename({old: new})

        # Calculate string-level features
        if "string_current_1" in features.columns and "string_current_2" in features.columns:
            features = features.with_columns([
                # Current statistics
                ((pl.col("string_current_1") + pl.col("string_current_2")) / 2).alias("_i_mean"),
                (pl.col("string_current_1") - pl.col("string_current_2")).abs().alias("_i_diff"),
            ])

            features = features.with_columns([
                # Coefficient of variation
                (pl.col("_i_diff") / (pl.col("_i_mean") + 1e-6)).alias("string_current_cv"),
                # Min/max ratios
                (pl.min_horizontal("string_current_1", "string_current_2") /
                 (pl.col("_i_mean") + 1e-6)).alias("string_current_min_ratio"),
                (pl.max_horizontal("string_current_1", "string_current_2") /
                 (pl.col("_i_mean") + 1e-6)).alias("string_current_max_ratio"),
            ])

            features = features.drop(["_i_mean", "_i_diff"])

        # Calculate power features
        if "string_voltage_1" in features.columns and "string_current_1" in features.columns:
            features = features.with_columns([
                ((pl.col("string_voltage_1") * pl.col("string_current_1") +
                  pl.col("string_voltage_2") * pl.col("string_current_2")) / 1000 / rated_power_kw)
                .alias("dc_power_pu"),
            ])

        # Irradiance feature
        if "poa_irradiance" in features.columns:
            features = features.with_columns([
                (pl.col("poa_irradiance") / 1000).alias("irradiance_normalized"),
            ])

            # Performance ratio approximation
            if "dc_power_pu" in features.columns:
                features = features.with_columns([
                    (pl.col("dc_power_pu") / (pl.col("irradiance_normalized") + 1e-6))
                    .clip(0, 1.5).alias("performance_ratio"),
                ])

        return features


class FaultClassifier:
    """
    CatBoost classifier for fault detection.

    Two variants:
    - system_level: Uses only system-level features, detects 5 fault classes
    - string_level: Uses system + string features, detects 9 fault classes
    """

    def __init__(
        self,
        model_type: Literal["system_level", "string_level"] = "system_level",
        config: Optional[PretrainingConfig] = None,
    ):
        """
        Initialize classifier.

        Args:
            model_type: "system_level" or "string_level"
            config: Training configuration
        """
        self.model_type = model_type
        self.config = config or PretrainingConfig()
        self.model: Optional[CatBoostClassifier] = None
        self.feature_names: List[str] = []
        self.class_names: Dict[int, str] = {}
        self._is_trained = False

    def get_features(self) -> List[str]:
        """Get feature names for this model type."""
        if self.model_type == "system_level":
            return self.config.system_features
        else:
            return self.config.system_features + self.config.string_features

    def get_classes(self) -> List[int]:
        """Get fault classes for this model type."""
        if self.model_type == "system_level":
            return SYSTEM_LEVEL_CLASSES
        else:
            return STRING_LEVEL_CLASSES

    def train(
        self,
        X: Union[np.ndarray, pl.DataFrame],
        y: Union[np.ndarray, pl.Series],
        feature_names: Optional[List[str]] = None,
    ) -> TrainingResult:
        """
        Train the classifier.

        Args:
            X: Feature matrix
            y: Target labels
            feature_names: Names of features

        Returns:
            TrainingResult with metrics and artifacts
        """
        import time
        start_time = time.time()

        # Convert to numpy if needed
        if isinstance(X, pl.DataFrame):
            if feature_names is None:
                feature_names = X.columns
            X = X.to_numpy()

        if isinstance(y, pl.Series):
            y = y.to_numpy()

        self.feature_names = feature_names or [f"feature_{i}" for i in range(X.shape[1])]

        # Filter to valid classes for this model type
        valid_classes = self.get_classes()
        mask = np.isin(y, valid_classes)
        X = X[mask]
        y = y[mask]

        print(f"\nTraining {self.model_type} classifier")
        print(f"  Samples: {len(y):,}")
        print(f"  Features: {len(self.feature_names)}")
        print(f"  Classes: {valid_classes}")

        # Train/test split
        X_train, X_test, y_train, y_test = train_test_split(
            X, y,
            test_size=self.config.test_size,
            random_state=self.config.random_seed,
            stratify=y,
        )

        # Create CatBoost model
        self.model = CatBoostClassifier(
            iterations=self.config.iterations,
            learning_rate=self.config.learning_rate,
            depth=self.config.depth,
            l2_leaf_reg=self.config.l2_leaf_reg,
            random_seed=self.config.random_seed,
            auto_class_weights=self.config.auto_class_weights,
            verbose=100,
            early_stopping_rounds=self.config.early_stopping_rounds,
        )

        # Create pools
        train_pool = Pool(X_train, y_train, feature_names=self.feature_names)
        test_pool = Pool(X_test, y_test, feature_names=self.feature_names)

        # Train
        self.model.fit(train_pool, eval_set=test_pool, use_best_model=True)
        self._is_trained = True

        # Evaluate
        y_pred = self.model.predict(X_test)

        accuracy = accuracy_score(y_test, y_pred)
        f1_macro = f1_score(y_test, y_pred, average="macro")

        # Per-class F1
        f1_per_class = {}
        for cls in valid_classes:
            mask = y_test == cls
            if mask.sum() > 0:
                f1_per_class[cls] = f1_score(y_test == cls, y_pred == cls)

        # Confusion matrix
        cm = confusion_matrix(y_test, y_pred).tolist()

        # Classification report
        report = classification_report(y_test, y_pred)

        # Feature importance
        importance = dict(zip(
            self.feature_names,
            self.model.get_feature_importance().tolist()
        ))
        importance = dict(sorted(importance.items(), key=lambda x: -x[1]))

        training_time = time.time() - start_time

        print(f"\n  Accuracy: {accuracy:.4f}")
        print(f"  F1 (macro): {f1_macro:.4f}")
        print(f"  Training time: {training_time:.1f}s")

        return TrainingResult(
            accuracy=accuracy,
            f1_macro=f1_macro,
            f1_per_class=f1_per_class,
            confusion_matrix=cm,
            classification_report=report,
            feature_importance=importance,
            training_time_seconds=training_time,
            n_train_samples=len(y_train),
            n_test_samples=len(y_test),
        )

    def predict(self, X: Union[np.ndarray, pl.DataFrame]) -> np.ndarray:
        """Predict fault classes."""
        if not self._is_trained:
            raise ValueError("Model not trained. Call train() first.")

        if isinstance(X, pl.DataFrame):
            X = X.to_numpy()

        return self.model.predict(X)

    def predict_proba(self, X: Union[np.ndarray, pl.DataFrame]) -> np.ndarray:
        """Predict fault class probabilities."""
        if not self._is_trained:
            raise ValueError("Model not trained. Call train() first.")

        if isinstance(X, pl.DataFrame):
            X = X.to_numpy()

        return self.model.predict_proba(X)

    def save(self, path: str) -> None:
        """Save model to pickle file."""
        if not self._is_trained:
            raise ValueError("Model not trained. Call train() first.")

        model_data = {
            "model": self.model,
            "model_type": self.model_type,
            "feature_names": self.feature_names,
            "class_names": self.class_names,
            "config": self.config,
            "timestamp": datetime.now().isoformat(),
        }

        with open(path, "wb") as f:
            pickle.dump(model_data, f)

        print(f"Model saved to {path}")

    @classmethod
    def load(cls, path: str) -> "FaultClassifier":
        """Load model from pickle file."""
        with open(path, "rb") as f:
            model_data = pickle.load(f)

        instance = cls(
            model_type=model_data["model_type"],
            config=model_data.get("config"),
        )
        instance.model = model_data["model"]
        instance.feature_names = model_data["feature_names"]
        instance.class_names = model_data.get("class_names", {})
        instance._is_trained = True

        return instance


def pretrain_foundation_models(
    data_dirs: Dict[str, str],
    output_dir: str = "models/fault_detection",
    config: Optional[PretrainingConfig] = None,
) -> dict:
    """
    Pretrain both system-level and string-level fault classifiers.

    Args:
        data_dirs: Dataset directories
        output_dir: Directory to save trained models
        config: Training configuration

    Returns:
        Dictionary with training results
    """
    config = config or PretrainingConfig()
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("FAULT DETECTION FOUNDATION MODEL PRETRAINING")
    print("=" * 60)

    # Load datasets
    print("\nLoading datasets...")
    loader = FaultDatasetLoader(data_dirs)

    try:
        df, feature_cols = loader.load_unified_dataset()
    except Exception as e:
        print(f"Error loading datasets: {e}")
        return {"status": "error", "message": str(e)}

    # Print class distribution
    print("\nClass distribution:")
    class_counts = df.group_by("fault_class").len().sort("fault_class")
    for row in class_counts.iter_rows():
        fault_class, count = row
        fault_name = UNIFIED_FAULT_CLASSES.get(fault_class, {}).get("name", "Unknown")
        print(f"  Class {fault_class} ({fault_name}): {count:,} samples")

    results = {}

    # Train system-level model
    print("\n" + "=" * 60)
    print("TRAINING SYSTEM-LEVEL MODEL")
    print("=" * 60)

    system_classifier = FaultClassifier("system_level", config)
    system_features = [f for f in system_classifier.get_features() if f in df.columns]

    if system_features:
        X_system = df.select(system_features)
        y = df["fault_class"]

        system_result = system_classifier.train(X_system, y, system_features)

        # Save model
        system_model_path = output_path / "fault_classifier_system_level.pkl"
        system_classifier.save(str(system_model_path))
        system_result.model_path = str(system_model_path)

        results["system_level"] = system_result
    else:
        print("  No system features available, skipping system-level model")

    # Train string-level model
    print("\n" + "=" * 60)
    print("TRAINING STRING-LEVEL MODEL")
    print("=" * 60)

    string_classifier = FaultClassifier("string_level", config)
    string_features = [f for f in string_classifier.get_features() if f in df.columns]

    if string_features and len(string_features) > len(system_features):
        X_string = df.select(string_features)
        y = df["fault_class"]

        string_result = string_classifier.train(X_string, y, string_features)

        # Save model
        string_model_path = output_path / "fault_classifier_string_level.pkl"
        string_classifier.save(str(string_model_path))
        string_result.model_path = str(string_model_path)

        results["string_level"] = string_result
    else:
        print("  No additional string features available, skipping string-level model")

    # Save training summary
    summary = {
        "timestamp": datetime.now().isoformat(),
        "datasets": list(data_dirs.keys()),
        "total_samples": len(df),
        "system_level": {
            "accuracy": results.get("system_level", {}).accuracy if "system_level" in results else None,
            "f1_macro": results.get("system_level", {}).f1_macro if "system_level" in results else None,
            "model_path": results.get("system_level", {}).model_path if "system_level" in results else None,
        } if "system_level" in results else None,
        "string_level": {
            "accuracy": results.get("string_level", {}).accuracy if "string_level" in results else None,
            "f1_macro": results.get("string_level", {}).f1_macro if "string_level" in results else None,
            "model_path": results.get("string_level", {}).model_path if "string_level" in results else None,
        } if "string_level" in results else None,
    }

    with open(output_path / "training_summary.json", "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print("\n" + "=" * 60)
    print("TRAINING COMPLETE")
    print("=" * 60)
    print(f"Models saved to: {output_path}")

    return results


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Pretrain fault detection models")
    parser.add_argument("--gpvs-dir", default="datasets/labeled/gpvs_faults/parquet",
                        help="GPVS-Faults data directory")
    parser.add_argument("--lazzaretti-dir", default="datasets/labeled/lazzaretti",
                        help="Lazzaretti data directory")
    parser.add_argument("--output-dir", default="models/fault_detection",
                        help="Output directory for models")
    parser.add_argument("--iterations", type=int, default=1000, help="Training iterations")
    parser.add_argument("--learning-rate", type=float, default=0.05, help="Learning rate")

    args = parser.parse_args()

    data_dirs = {
        "gpvs": args.gpvs_dir,
        "lazzaretti": args.lazzaretti_dir,
    }

    config = PretrainingConfig(
        iterations=args.iterations,
        learning_rate=args.learning_rate,
    )

    results = pretrain_foundation_models(data_dirs, args.output_dir, config)
