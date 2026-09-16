"""
Per-Inverter Soiling Ratio Training Pipeline

This module provides end-to-end training pipelines for per-inverter SR models:
1. DustIQ variant: Uses DustIQ sensor data as ground truth
2. Pseudo variant: Uses rain+AOD+PR-derived pseudo-labels

Author: NuraVolt Team
"""

import numpy as np
import pandas as pd
import json
import yaml
import logging
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Literal
from datetime import datetime

from .sr_ml_model import (
    PerInverterSRModel,
    PerInverterModelConfig,
    SoilingRatioModelConfig,
    evaluate_model
)
from .sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation
from .sr_per_inverter_features import (
    PerInverterFeatureEngineer,
    create_per_inverter_training_data
)
from .sr_pseudo_labels import (
    SoilingPseudoLabelGenerator,
    PseudoLabelConfig
)

logger = logging.getLogger(__name__)


@dataclass
class TrainingDataPaths:
    """Paths to training data files."""
    rain_csv: Path                # Daily rain data
    aod_csv: Optional[Path]       # AOD/dust data
    pr_parquet: Path              # Per-inverter PR data
    inverter_json: Path           # Inverter metadata (all_inverters.json)
    dustiq_csv: Optional[Path]    # DustIQ ground truth (if available)


@dataclass
class TrainingResult:
    """Container for training results."""
    model: PerInverterSRModel
    metrics: Dict[str, float]
    validation_results: Dict[str, any]
    training_duration_seconds: float
    output_path: Path


class PerInverterSRTrainer:
    """
    End-to-end training pipeline for per-inverter SR models.

    Supports two variants:
    - DustIQ: Uses sensor ground truth
    - Pseudo: Uses derived pseudo-labels from rain+AOD+PR
    """

    def __init__(
        self,
        plant_id: str,
        data_paths: TrainingDataPaths,
        output_dir: Path,
        config: Optional[PerInverterModelConfig] = None
    ):
        """
        Initialize trainer.

        Parameters
        ----------
        plant_id : str
            Plant identifier (e.g., "alpha1")
        data_paths : TrainingDataPaths
            Paths to all required data files
        output_dir : Path
            Directory for model outputs
        config : PerInverterModelConfig, optional
            Training configuration
        """
        self.plant_id = plant_id
        self.data_paths = data_paths
        self.output_dir = Path(output_dir)
        self.config = config or PerInverterModelConfig()

        # Load plant configuration for location data
        location = self._load_plant_location()

        # Initialize components
        self.feature_engineer = SoilingRatioFeatureEngineer(location=location)
        self.per_inverter_fe = PerInverterFeatureEngineer()
        self.pseudo_label_gen = SoilingPseudoLabelGenerator()

        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def _load_plant_location(self) -> PlantLocation:
        """Load plant location from config file."""
        config_path = Path('plant_configs') / f'{self.plant_id}.yaml'

        if not config_path.exists():
            # Fallback to default location if config not found
            logger.warning(f"Plant config not found: {config_path}. Using default location.")
            return PlantLocation(
                latitude=40.0,
                longitude=-4.0,
                elevation_m=0.0,
                climate_zone="mediterranean",
                distance_to_coast_km=50.0
            )

        with open(config_path) as f:
            config = yaml.safe_load(f)

        location_data = config.get('location', {})
        return PlantLocation(
            latitude=location_data.get('latitude', 40.0),
            longitude=location_data.get('longitude', -4.0),
            elevation_m=location_data.get('elevation', 0.0),
            climate_zone=location_data.get('climate_zone', 'mediterranean'),
            distance_to_coast_km=location_data.get('distance_to_coast_km', 50.0)
        )

    def train(
        self,
        variant: Literal["dustiq", "pseudo"] = "pseudo",
        test_size: float = 0.2,
        verbose: bool = True
    ) -> TrainingResult:
        """
        Train per-inverter SR model.

        Parameters
        ----------
        variant : str
            "dustiq" for sensor-based, "pseudo" for rain+AOD+PR-based
        test_size : float
            Fraction of data for testing (temporal split)
        verbose : bool
            Print training progress

        Returns
        -------
        TrainingResult
            Trained model and metrics
        """
        start_time = datetime.now()
        logger.info(f"Starting {variant} training for {self.plant_id}")

        # Update config variant
        self.config.variant = variant

        # Step 1: Load and prepare data
        if verbose:
            print(f"\n{'='*60}")
            print(f"Per-Inverter SR Training ({variant.upper()} variant)")
            print(f"Plant: {self.plant_id}")
            print(f"{'='*60}\n")
            print("Step 1: Loading data...")

        df_rain, df_aod, df_pr_features, df_inverter_pr = self._load_data()

        # Step 2: Generate plant-level features
        if verbose:
            print("Step 2: Generating plant-level features...")

        df_plant_features = self._create_plant_features(df_rain, df_aod)

        # Step 3: Load inverter metadata
        if verbose:
            print("Step 3: Loading inverter metadata...")

        self.per_inverter_fe.load_inverter_metadata(
            all_inverters_path=str(self.data_paths.inverter_json)
        )
        n_inverters = len(self.per_inverter_fe.inverter_metadata)
        if verbose:
            print(f"  Found {n_inverters} inverters")

        # Step 4: Expand to per-inverter features
        if verbose:
            print("Step 4: Expanding to per-inverter features...")

        df_expanded = self.per_inverter_fe.expand_to_per_inverter(
            df_plant_features=df_plant_features,
            df_inverter_pr=df_inverter_pr
        )

        # Reset index to make date and inverter_id available as columns
        df_expanded = df_expanded.reset_index()

        if verbose:
            print(f"  Expanded dataset: {len(df_expanded)} rows")
            print(f"  Features: {len(df_expanded.columns)} columns")

        # Step 5: Generate training targets
        if verbose:
            print(f"Step 5: Generating {variant} targets...")

        if variant == "dustiq":
            df_targets = self._load_dustiq_targets()
        else:
            df_targets = self._generate_pseudo_labels(df_rain, df_pr_features, df_aod)

        if verbose:
            print(f"  Target samples: {len(df_targets)}")

        # Step 6: Merge features and targets
        if verbose:
            print("Step 6: Merging features and targets...")

        df_training = self._merge_features_targets(df_expanded, df_targets, variant)

        if verbose:
            print(f"  Training samples: {len(df_training)}")

        # Step 7: Split into train/test
        if verbose:
            print("Step 7: Splitting train/test...")

        X_train, X_test, y_train, y_test, inv_train, inv_test = self._split_data(
            df_training, test_size
        )

        if verbose:
            print(f"  Training: {len(X_train)} samples")
            print(f"  Testing: {len(X_test)} samples")

        # Step 8: Train model
        if verbose:
            print("\nStep 8: Training model...")

        model = PerInverterSRModel(self.config)
        model.fit_per_inverter(
            X_train=X_train,
            y_train=y_train,
            inverter_ids=inv_train,
            plant_id=self.plant_id,
            verbose=verbose
        )

        # Step 9: Evaluate on test set
        if verbose:
            print("\nStep 9: Evaluating model...")

        metrics = evaluate_model(model, X_test, y_test)

        if verbose:
            print(f"\n  Test Metrics:")
            print(f"    MAE:  {metrics['mae']:.4f}")
            print(f"    RMSE: {metrics['rmse']:.4f}")
            print(f"    R²:   {metrics['r2']:.4f}")
            print(f"    Bias: {metrics['bias']:.4f}")

        # Step 10: Validate predictions
        if verbose:
            print("\nStep 10: Validating predictions...")

        test_dates = df_training.loc[X_test.index, 'date']
        predictions = model.predict_per_inverter(X_test, inv_test, test_dates)

        rain_for_validation = df_rain.rename(columns={
            'precipitation_sum': 'precipitation_mm'
        }) if 'precipitation_sum' in df_rain.columns else df_rain

        validation_results = model.validate_predictions(predictions, rain_for_validation)

        if verbose:
            print(f"  Validation: {'PASSED' if validation_results['is_valid'] else 'ISSUES FOUND'}")
            if validation_results['issues']:
                for issue in validation_results['issues']:
                    print(f"    - {issue}")

        # Step 11: Save model
        if verbose:
            print("\nStep 11: Saving model...")

        model_filename = f"sr_model_{variant}_{self.plant_id}.pkl"
        model_path = self.output_dir / model_filename
        model.save(model_path)

        # Calculate training duration
        duration = (datetime.now() - start_time).total_seconds()

        if verbose:
            print(f"\n{'='*60}")
            print(f"Training complete!")
            print(f"  Duration: {duration:.1f} seconds")
            print(f"  Model saved to: {model_path}")
            print(f"{'='*60}\n")

        return TrainingResult(
            model=model,
            metrics=metrics,
            validation_results=validation_results,
            training_duration_seconds=duration,
            output_path=model_path
        )

    def _load_data(self) -> Tuple[pd.DataFrame, Optional[pd.DataFrame], pd.DataFrame, pd.DataFrame]:
        """Load all required data files."""
        # Load rain data
        df_rain = pd.read_csv(self.data_paths.rain_csv)
        df_rain['date'] = pd.to_datetime(df_rain['date'])
        logger.info(f"Loaded rain data: {len(df_rain)} days")

        # Load AOD data (optional)
        df_aod = None
        if self.data_paths.aod_csv and self.data_paths.aod_csv.exists():
            df_aod = pd.read_csv(self.data_paths.aod_csv)
            df_aod['date'] = pd.to_datetime(df_aod['date'])
            logger.info(f"Loaded AOD data: {len(df_aod)} days")

        # Load PR parquet (per-inverter PR data)
        df_pr = pd.read_parquet(self.data_paths.pr_parquet)

        # Normalize column names (handle both camelCase and snake_case)
        if 'inverterId' in df_pr.columns:
            df_pr = df_pr.rename(columns={'inverterId': 'inverter_id'})

        logger.info(f"Loaded PR data: {len(df_pr)} rows")

        # Extract plant-level PR features (mean across inverters)
        df_pr_features = df_pr.groupby('date').agg({
            'pr': ['mean', 'std', 'min', 'max']
        }).reset_index()
        df_pr_features.columns = ['date', 'pr_mean', 'pr_std', 'pr_min', 'pr_max']
        df_pr_features['pr'] = df_pr_features['pr_mean']

        # Per-inverter PR for inverter features
        df_inverter_pr = df_pr[['date', 'inverter_id', 'pr']].copy()

        return df_rain, df_aod, df_pr_features, df_inverter_pr

    def _create_plant_features(
        self,
        df_rain: pd.DataFrame,
        df_aod: Optional[pd.DataFrame]
    ) -> pd.DataFrame:
        """Create plant-level features."""
        # Prepare rain features
        rain_col = 'precipitation_sum' if 'precipitation_sum' in df_rain.columns else 'precipitation_mm'
        df_rain_prep = df_rain[['date', rain_col]].rename(columns={rain_col: 'precipitation_mm'})

        # Generate rain features (returns dict)
        rain_feature_dict = self.feature_engineer._create_rainfall_features(df_rain_prep)

        # Convert to DataFrame with date column
        df_rain_features = pd.DataFrame(rain_feature_dict)
        df_rain_features['date'] = df_rain_prep['date'].values

        # Merge AOD if available
        if df_aod is not None:
            df_rain_features = df_rain_features.merge(df_aod, on='date', how='left')

            # Create AOD features
            for col in ['aod_550', 'dust_aod']:
                if col in df_rain_features.columns:
                    for window in [7, 14, 30]:
                        df_rain_features[f'{col}_mean_{window}d'] = (
                            df_rain_features[col].rolling(window, min_periods=1).mean()
                        )

        # Add temporal features
        df_rain_features['day_of_year'] = df_rain_features['date'].dt.dayofyear
        df_rain_features['month'] = df_rain_features['date'].dt.month
        df_rain_features['day_of_year_sin'] = np.sin(2 * np.pi * df_rain_features['day_of_year'] / 365)
        df_rain_features['day_of_year_cos'] = np.cos(2 * np.pi * df_rain_features['day_of_year'] / 365)
        df_rain_features['month_sin'] = np.sin(2 * np.pi * df_rain_features['month'] / 12)
        df_rain_features['month_cos'] = np.cos(2 * np.pi * df_rain_features['month'] / 12)

        # Dry season indicator (plant-specific, can be configured)
        df_rain_features['is_dry_season'] = df_rain_features['month'].isin([5, 6, 7, 8, 9]).astype(int)

        # Set date as index for expand_to_per_inverter compatibility
        df_rain_features = df_rain_features.set_index('date')

        return df_rain_features

    def _load_dustiq_targets(self) -> pd.DataFrame:
        """Load DustIQ sensor ground truth (supports CSV and JSON formats)."""
        if not self.data_paths.dustiq_csv or not self.data_paths.dustiq_csv.exists():
            raise FileNotFoundError(
                f"DustIQ data not found: {self.data_paths.dustiq_csv}. "
                "Use 'pseudo' variant for plants without DustIQ sensors."
            )

        # Load data based on file extension
        dustiq_path = self.data_paths.dustiq_csv
        if dustiq_path.suffix.lower() == '.json':
            # Load JSON format (new format from onboarding)
            import json
            with open(dustiq_path) as f:
                data = json.load(f)
            df = pd.DataFrame(data['daily_data'])
        else:
            # Load CSV format (legacy format)
            df = pd.read_csv(dustiq_path)

        df['date'] = pd.to_datetime(df['date'])

        # Ensure SR column exists
        if 'sr_dustiq' not in df.columns and 'soiling_ratio' in df.columns:
            df['sr_dustiq'] = df['soiling_ratio']

        df['sr_target'] = df['sr_dustiq']
        df['confidence'] = 1.0  # Full confidence for sensor data
        df['method'] = 'dustiq'

        return df[['date', 'sr_target', 'confidence', 'method']]

    def _generate_pseudo_labels(
        self,
        df_rain: pd.DataFrame,
        df_pr: pd.DataFrame,
        df_aod: Optional[pd.DataFrame]
    ) -> pd.DataFrame:
        """Generate pseudo-labels from rain+AOD+PR patterns."""
        # Prepare rain data
        rain_col = 'precipitation_sum' if 'precipitation_sum' in df_rain.columns else 'precipitation_mm'
        df_rain_prep = df_rain[['date', rain_col]].rename(columns={rain_col: 'precipitation_mm'})

        # Generate pseudo-labels
        df_labels = self.pseudo_label_gen.generate_labels(
            df_rain=df_rain_prep,
            df_pr=df_pr[['date', 'pr']].drop_duplicates(),
            df_aod=df_aod,
            method='combined'
        )

        # Validate labels
        df_labels, validation_metrics = self.pseudo_label_gen.validate_labels(
            df_labels,
            df_pr[['date', 'pr']].drop_duplicates()
        )

        logger.info(f"Pseudo-label validation: {validation_metrics}")

        # Filter by minimum confidence
        min_conf = self.config.min_confidence_for_training
        df_labels = df_labels[df_labels['confidence'] >= min_conf].copy()

        # Rename for consistency
        df_labels['sr_target'] = df_labels['sr_pseudo']

        return df_labels[['date', 'sr_target', 'confidence', 'method', 'is_anchor']]

    def _merge_features_targets(
        self,
        df_features: pd.DataFrame,
        df_targets: pd.DataFrame,
        variant: str
    ) -> pd.DataFrame:
        """Merge features with targets."""
        # The expanded features have one row per (date, inverter)
        # Targets are at plant level (one row per date)

        # Merge on date
        df_merged = df_features.merge(
            df_targets,
            on='date',
            how='inner'
        )

        # Filter invalid rows
        df_merged = df_merged[df_merged['sr_target'].notna()]
        df_merged = df_merged[df_merged['sr_target'] >= self.config.base_config.min_sr]
        df_merged = df_merged[df_merged['sr_target'] <= self.config.base_config.max_sr]

        logger.info(f"Merged dataset: {len(df_merged)} samples")

        return df_merged

    def _split_data(
        self,
        df: pd.DataFrame,
        test_size: float
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.Series, pd.Series, pd.Series]:
        """
        Split data into train/test with temporal split.

        Returns features, targets, and inverter IDs for both sets.
        """
        # Sort by date for temporal split
        df = df.sort_values('date')

        # Find split point
        unique_dates = df['date'].unique()
        split_idx = int(len(unique_dates) * (1 - test_size))
        split_date = unique_dates[split_idx]

        # Split
        train_mask = df['date'] < split_date
        test_mask = df['date'] >= split_date

        df_train = df[train_mask]
        df_test = df[test_mask]

        # Separate features, targets, and inverter IDs
        target_cols = ['sr_target', 'confidence', 'method', 'date', 'inverter_id']
        if 'is_anchor' in df.columns:
            target_cols.append('is_anchor')

        feature_cols = [c for c in df.columns if c not in target_cols]

        X_train = df_train[feature_cols]
        X_test = df_test[feature_cols]
        y_train = df_train['sr_target']
        y_test = df_test['sr_target']
        inv_train = df_train['inverter_id']
        inv_test = df_test['inverter_id']

        return X_train, X_test, y_train, y_test, inv_train, inv_test


def train_per_inverter_model(
    plant_id: str,
    data_dir: Path,
    output_dir: Path,
    variant: Literal["dustiq", "pseudo"] = "pseudo",
    verbose: bool = True
) -> TrainingResult:
    """
    Convenience function to train a per-inverter SR model.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    data_dir : Path
        Directory containing all data files
    output_dir : Path
        Directory for model outputs
    variant : str
        "dustiq" or "pseudo"
    verbose : bool
        Print progress

    Returns
    -------
    TrainingResult
        Training result with model and metrics
    """
    data_dir = Path(data_dir)
    output_dir = Path(output_dir)

    # Build data paths
    data_paths = TrainingDataPaths(
        rain_csv=data_dir / f"{plant_id}_rain_history.csv",
        aod_csv=data_dir / f"{plant_id}_aod_history.csv",
        pr_parquet=data_dir / f"{plant_id}_pr_daily.parquet",
        inverter_json=data_dir / f"{plant_id}" / "per_inverter" / "all_inverters.json",
        dustiq_csv=data_dir / f"{plant_id}_dustiq.csv" if variant == "dustiq" else None
    )

    # Create trainer and run
    trainer = PerInverterSRTrainer(
        plant_id=plant_id,
        data_paths=data_paths,
        output_dir=output_dir
    )

    return trainer.train(variant=variant, verbose=verbose)
