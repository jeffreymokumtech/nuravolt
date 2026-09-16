"""
Plant-Level Digital Twin Factory

Trains a single hybrid (Physics + ML) model for an entire plant with
inverter_id as a categorical feature. This approach:
- Reduces 150 per-inverter models to 1 plant model
- Enables cross-inverter learning and generalization
- Provides per-inverter predictions for underperformer detection
- Produces standardized JSON output for dashboards

Architecture:
    P_expected = P_physics + CatBoost(features, inverter_id)

Usage:
    from nuravolt.digitaltwin import PlantLevelFactory, PlantConfig

    config = PlantConfig.from_yaml("plant_configs/alpha1.yaml")
    factory = PlantLevelFactory(config)
    result = factory.train()
    factory.export_json()
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Union

import numpy as np
import pandas as pd
import polars as pl
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from .data_transformer import (
    WideToLongTransformer,
    add_temporal_features,
    filter_training_period,
    rename_columns_for_training,
)
from .feature_engineering import PhysicsFeatureEngineer, LocationParams
from .dashboard_aggregator import DashboardAggregator
from .normal_data_filter import NormalDataFilter, FilterConfig, FilterResult
from .physics_model import PVWattsPhysicsModel, SystemParams
from .plant_config import PlantConfig

logger = logging.getLogger(__name__)


@dataclass
class InverterMetrics:
    """Per-inverter performance metrics."""
    inverter_id: str
    group_id: str
    r2: float
    mae_kw: float
    rmse_kw: float
    n_samples: int
    success: bool = True
    error_message: Optional[str] = None


@dataclass
class PlantTrainingResult:
    """Result of plant-level model training."""
    plant_id: str
    plant_name: str
    success: bool
    model_type: str = "PlantLevel (Physics + CatBoost)"

    # Plant-level metrics
    plant_r2: float = 0.0
    plant_mae_kw: float = 0.0
    physics_only_r2: float = 0.0

    # Per-inverter metrics
    inverter_metrics: dict[str, InverterMetrics] = field(default_factory=dict)

    # Training info
    n_inverters: int = 0
    n_training_samples: int = 0
    n_validation_samples: int = 0
    training_period_start: Optional[str] = None
    training_period_end: Optional[str] = None
    training_time_s: float = 0.0

    # Features used
    feature_names: list[str] = field(default_factory=list)
    cat_features: list[str] = field(default_factory=list)

    # Errors
    error_message: Optional[str] = None

    @property
    def avg_r2(self) -> float:
        """Average R² across successful inverters."""
        successful = [m for m in self.inverter_metrics.values() if m.success]
        if not successful:
            return 0.0
        return np.mean([m.r2 for m in successful])

    @property
    def avg_mae_kw(self) -> float:
        """Average MAE across successful inverters."""
        successful = [m for m in self.inverter_metrics.values() if m.success]
        if not successful:
            return 0.0
        return np.mean([m.mae_kw for m in successful])


class PlantLevelFactory:
    """
    Factory for training plant-level hybrid digital twin models.

    This factory trains a single CatBoost model for the entire plant,
    using inverter_id as a categorical feature. The hybrid approach
    combines physics predictions (PVWatts) with ML residual learning.
    """

    def __init__(self, config: PlantConfig):
        """
        Initialize factory with plant configuration.

        Args:
            config: PlantConfig instance
        """
        self.config = config

        # Get inverter capacity from config (assumes uniform inverters)
        inverter_kw = 60.0  # Default
        if config.components.groups and config.components.groups[0].inverters:
            inverter_kw = config.components.groups[0].inverters[0].nominal_kw

        # Initialize physics model with correct capacity
        self.physics_model = PVWattsPhysicsModel(
            system=SystemParams(
                capacity_kw=inverter_kw,
                latitude=config.location.latitude,
                longitude=config.location.longitude,
                altitude=config.location.altitude,
                tilt=config.array.tilt,
                azimuth=config.array.azimuth,
                gamma_pdc=config.array.gamma_pdc,
            )
        )

        # Initialize feature engineer
        self.feature_engineer = PhysicsFeatureEngineer(
            location=LocationParams(
                latitude=config.location.latitude,
                longitude=config.location.longitude,
                altitude=config.location.altitude,
            )
        )

        # Data transformer
        self.transformer = WideToLongTransformer(config)

        # Normal data filter for enhanced selection
        self.normal_filter: Optional[NormalDataFilter] = None
        if config.training.use_enhanced_selection:
            filter_config = FilterConfig(
                min_irradiance=config.training.min_irradiance,
                pr_min=config.training.min_pr,
                pr_max=1.05,
            )
            self.normal_filter = NormalDataFilter(
                config=filter_config,
                p_rated=1.0,  # Data is normalized (kW/kWp), so p_rated=1
            )

        # Model and results
        self.model = None
        self.result: Optional[PlantTrainingResult] = None

        # Output directory
        self.output_dir = config.output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def train(self, df_wide: Optional[pd.DataFrame] = None) -> PlantTrainingResult:
        """
        Train plant-level hybrid model.

        Args:
            df_wide: Optional pre-loaded wide-format DataFrame.
                     If None, loads from config.data.source_path.

        Returns:
            PlantTrainingResult with metrics and status
        """
        start_time = datetime.now()

        # Check if per-inverter mode is enabled
        if self.config.training.per_inverter:
            logger.info(f"Training PER-INVERTER models for {self.config.plant_name}")
            return self._train_per_inverter(df_wide)

        logger.info(f"Training plant-level model for {self.config.plant_name}")

        try:
            # Step 1: Load data if not provided
            if df_wide is None:
                df_wide = self._load_data()

            # Step 2: Rename columns to standard names
            df_wide = rename_columns_for_training(df_wide, self.config)

            # Keep full SCADA timeline for residual export (training may be time-limited).
            df_wide_full = df_wide

            # Step 2b: Trim the *wide* data for training BEFORE wide->long melt to avoid OOM.
            ts_col = self.config.data.timestamp_column or "timestamp"
            if self.config.training.max_years is not None and ts_col in df_wide.columns:
                start_date = pd.to_datetime(df_wide[ts_col]).min()
                cutoff_date = start_date + pd.Timedelta(days=int(self.config.training.max_years * 365))
                df_wide = df_wide[pd.to_datetime(df_wide[ts_col]) <= cutoff_date].copy()
                logger.info(
                    f"Training period (wide): {start_date} to {cutoff_date} "
                    f"(max_years={self.config.training.max_years})"
                )

            # Step 3: Transform to long format
            transform_result = self.transformer.transform(df_wide)
            df_long = transform_result.df_long
            logger.info(f"Transformed to long format: {transform_result.n_rows:,} rows, "
                       f"{transform_result.n_inverters} inverters")

            # Step 4: Filter to training period
            df_long = filter_training_period(df_long, self.config.training.max_years)
            logger.info(f"Training period (long): {df_long['timestamp'].min()} to {df_long['timestamp'].max()}")

            # Step 5: Add temporal features
            df_long = add_temporal_features(df_long)

            # Step 6: Generate physics predictions
            df_long = self._add_physics_predictions(df_long)

            # Step 7: Filter valid data (daytime, reasonable PR) - for training only
            df_long = self._filter_valid_data(df_long)
            logger.info(f"After filtering: {len(df_long):,} samples")

            # Step 8: Prepare features for training
            X_train, X_val, y_train, y_val, feature_names, cat_features = self._prepare_features(df_long)

            # Step 9: Train CatBoost model
            self.model = self._train_catboost(X_train, X_val, y_train, y_val, cat_features)

            # Step 10: Calculate metrics
            y_pred_train = self.model.predict(X_train)
            y_pred_val = self.model.predict(X_val)

            plant_r2 = r2_score(y_val, y_pred_val)
            plant_mae = mean_absolute_error(y_val, y_pred_val)

            # Physics-only R² (for comparison)
            physics_only_r2 = r2_score(
                df_long.loc[X_val.index, "power"],
                df_long.loc[X_val.index, "physics_power"]
            ) if "physics_power" in df_long.columns else 0.0

            logger.info(f"Plant R²: {plant_r2:.4f}, MAE: {plant_mae:.4f} kW/kWp")
            logger.info(f"Physics-only R²: {physics_only_r2:.4f}")

            # Step 11: Calculate per-inverter metrics
            inverter_metrics = self._calculate_per_inverter_metrics(
                df_long, X_val, y_val, y_pred_val
            )

            # Step 12: Create result
            training_time = (datetime.now() - start_time).total_seconds()

            self.result = PlantTrainingResult(
                plant_id=self.config.plant_id,
                plant_name=self.config.plant_name,
                success=True,
                plant_r2=plant_r2,
                plant_mae_kw=plant_mae,
                physics_only_r2=physics_only_r2,
                inverter_metrics=inverter_metrics,
                n_inverters=transform_result.n_inverters,
                n_training_samples=len(X_train),
                n_validation_samples=len(X_val),
                training_period_start=str(df_long["timestamp"].min()),
                training_period_end=str(df_long["timestamp"].max()),
                training_time_s=training_time,
                feature_names=feature_names,
                cat_features=cat_features,
            )

            # Step 13: Save model and export JSON
            if self.config.output.save_models:
                self._save_model()
            if self.config.output.save_json:
                self.export_json()
            if self.config.output.save_quality_report:
                self._save_quality_report()

            # Step 14: Export residuals CSVs for heatmap (use FULL data, not filtered)
            if self.config.training.export_residuals:
                n_exported = self.export_residuals_from_wide(df_wide_full)
                logger.info(f"Exported {n_exported} residuals CSVs to {self.output_dir}")

                # Step 15: Regenerate dashboard JSON files from residuals
                logger.info("Regenerating dashboard data from residuals...")
                try:
                    aggregator = DashboardAggregator(self.output_dir)
                    agg_results = aggregator.aggregate_all()
                    if agg_results.get("errors"):
                        for err in agg_results["errors"]:
                            logger.warning(f"Dashboard aggregation warning: {err}")
                    logger.info("Dashboard data regenerated successfully")
                except Exception as e:
                    logger.warning(f"Dashboard aggregation failed (non-fatal): {e}")

            logger.info(f"Training complete in {training_time:.1f}s")
            return self.result

        except Exception as e:
            logger.error(f"Training failed: {e}")
            self.result = PlantTrainingResult(
                plant_id=self.config.plant_id,
                plant_name=self.config.plant_name,
                success=False,
                error_message=str(e),
            )
            return self.result

    def _load_data(self) -> pd.DataFrame:
        """Load data using Polars lazy API with column filtering for memory efficiency."""
        source_path = Path(self.config.data.source_path)
        if not source_path.exists():
            raise FileNotFoundError(f"Data file not found: {source_path}")

        logger.info(f"Loading data from {source_path} (Polars streaming with column selection)")

        # Scan parquet in lazy mode
        lf = pl.scan_parquet(source_path)

        # Identify which columns we actually need BEFORE loading
        # This dramatically reduces memory by not loading unnecessary columns
        ts_col = self.config.data.timestamp_column

        # Get list of columns we need
        needed_cols = [ts_col]

        # Add weather/plant-level columns (only if they exist in the data)
        # Get all available columns to check existence
        all_columns = lf.collect_schema().names()

        # Add each weather column if it exists in the data
        if self.config.data.columns.irradiance and self.config.data.columns.irradiance in all_columns:
            needed_cols.append(self.config.data.columns.irradiance)
        if self.config.data.columns.ambient_temp and self.config.data.columns.ambient_temp in all_columns:
            needed_cols.append(self.config.data.columns.ambient_temp)
        if self.config.data.columns.module_temp and self.config.data.columns.module_temp in all_columns:
            needed_cols.append(self.config.data.columns.module_temp)
        if self.config.data.columns.wind_speed and self.config.data.columns.wind_speed in all_columns:
            needed_cols.append(self.config.data.columns.wind_speed)
        if self.config.data.columns.humidity and self.config.data.columns.humidity in all_columns:
            needed_cols.append(self.config.data.columns.humidity)

        # Add inverter power columns matching pattern
        import re
        pattern = re.compile(self.config.data.inverter_pattern)
        inverter_cols = [col for col in all_columns if pattern.search(col)]
        needed_cols.extend(inverter_cols)

        # Select only needed columns in lazy mode
        lf = lf.select(needed_cols)
        logger.info(f"Reduced from {len(all_columns)} to {len(needed_cols)} columns (timestamp + weather + {len(inverter_cols)} inverters)")

        # Parse timestamp in lazy mode
        if self.config.data.timestamp_format:
            lf = lf.with_columns(
                pl.col(ts_col).str.strptime(pl.Datetime, format=self.config.data.timestamp_format)
            )
        else:
            lf = lf.with_columns(
                pl.col(ts_col).str.strptime(pl.Datetime)
            )

        # NOW collect to pandas with only needed columns
        df = lf.collect().to_pandas()
        logger.info(f"Loaded {len(df):,} rows x {len(df.columns)} columns")
        return df

    def _add_physics_predictions(self, df_long: pd.DataFrame) -> pd.DataFrame:
        """Add physics-based power predictions using vectorized operations."""
        df = df_long.copy()

        # Use the physics model's DataFrame-based predict method
        # Map column names to what the physics model expects
        physics_power = self.physics_model.predict(
            df,
            irradiance_col="irradiance",
            temperature_col="ambient_temp",
            wind_col="wind_speed" if "wind_speed" in df.columns else None,
        )

        # Normalize physics power to kW/kWp (since data is normalized power)
        # Physics model outputs absolute kW, divide by capacity to get normalized
        capacity_kw = self.physics_model.system.capacity_kw
        if capacity_kw > 0:
            physics_power = physics_power / capacity_kw

        df["physics_power"] = physics_power

        # Calculate residual (what ML needs to learn)
        df["residual"] = df["power"] - df["physics_power"]

        return df

    def _filter_valid_data(self, df_long: pd.DataFrame) -> pd.DataFrame:
        """
        Filter to valid training data.

        Uses enhanced multi-stage filtering when config.training.use_enhanced_selection
        is True, otherwise falls back to basic PR-based filtering.

        Enhanced filtering includes:
        - Physics bounds (hard constraints)
        - PR envelope filtering (rolling statistics)
        - Variability filtering (remove cloud transients)
        - Iterative outlier removal (IsolationForest on residuals)
        - Clustering-based filtering (DBSCAN for dense regions)
        """
        df = df_long.copy()

        # Remove rows with missing values
        required_cols = ["power", "irradiance", "ambient_temp", "physics_power"]
        for col in required_cols:
            if col in df.columns:
                df = df[df[col].notna()]

        # Use enhanced filtering if enabled
        if self.normal_filter is not None and len(df) > 100:
            logger.info("Applying enhanced multi-stage data filtering...")

            # Set timestamp as index for the filter (required for rolling calculations)
            df_indexed = df.set_index("timestamp") if "timestamp" in df.columns else df

            # Apply multi-stage filtering
            filter_result: FilterResult = self.normal_filter.select_normal_training_data(
                df_indexed,
                irradiance_col="irradiance",
                power_col="power",
                temperature_col="ambient_temp" if "ambient_temp" in df_indexed.columns else None,
                apply_variability=True,
                apply_clustering=len(df_indexed) > 500,
            )

            # Apply the filter mask
            df_filtered = df_indexed[filter_result.mask]

            # Log filtering statistics
            logger.info(f"Enhanced filter retention: {filter_result.retention_ratio:.1%} "
                       f"({filter_result.n_filtered:,}/{filter_result.n_original:,} samples)")
            for method, stats in filter_result.method_stats.items():
                logger.debug(f"  {method}: kept {stats['kept']:,}, removed {stats['removed']:,}")

            # Reset index back to column
            df = df_filtered.reset_index()
        else:
            # Fallback: basic filtering (minimum irradiance and PR bounds)
            logger.info("Using basic PR-based filtering...")

            # Minimum irradiance filter (daytime only)
            if "irradiance" in df.columns:
                df = df[df["irradiance"] >= self.config.training.min_irradiance]

            # Performance ratio filter (remove unrealistic values)
            if "irradiance" in df.columns and "power" in df.columns:
                # PR = power / (irradiance / 1000)
                df["pr"] = df["power"] / (df["irradiance"] / 1000 + 1e-6)
                df = df[(df["pr"] >= self.config.training.min_pr) & (df["pr"] <= 1.2)]
                df = df.drop(columns=["pr"])

        return df

    def _prepare_features(
        self,
        df_long: pd.DataFrame,
    ) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.Series, list[str], list[str]]:
        """
        Prepare features for CatBoost training.

        Returns:
            X_train, X_val, y_train, y_val, feature_names, cat_features
        """
        # Define feature columns (physics features, temporal features, categorical)
        feature_cols = [
            # Physics-based features
            "irradiance",
            "ambient_temp",
            "physics_power",
            # Temporal features
            "hour_sin", "hour_cos",
            "doy_sin", "doy_cos",
            # Categorical features
            "inverter_id",
        ]

        # Add optional features if present
        optional_cols = ["module_temp", "wind_speed", "solar_elevation", "solar_azimuth", "humidity"]
        for col in optional_cols:
            if col in df_long.columns and df_long[col].notna().sum() > len(df_long) * 0.5:
                feature_cols.append(col)

        # Filter to available columns
        available_cols = [c for c in feature_cols if c in df_long.columns]

        # Categorical features for CatBoost
        cat_features = ["inverter_id"]
        if "group_id" in df_long.columns:
            available_cols.append("group_id")
            cat_features.append("group_id")

        # Prepare X and y
        X = df_long[available_cols].copy()
        y = df_long["power"].copy()  # Target: actual power (hybrid learns full prediction)

        # Train/validation split (RANDOM - appropriate for non-temporal model)
        # This model has no lags/forecasting - it predicts based on current conditions only
        # Random split ensures train/val see similar distributions of irradiance, temp, etc.
        X_train, X_val, y_train, y_val = train_test_split(
            X, y,
            test_size=self.config.training.validation_split,
            random_state=42,  # Reproducibility
            shuffle=True,     # Random split, not time-based
        )

        # Get feature names (excluding categorical for reporting)
        numeric_features = [c for c in available_cols if c not in cat_features]

        return X_train, X_val, y_train, y_val, numeric_features, cat_features

    def _train_catboost(
        self,
        X_train: pd.DataFrame,
        X_val: pd.DataFrame,
        y_train: pd.Series,
        y_val: pd.Series,
        cat_features: list[str],
    ):
        """Train CatBoost model."""
        try:
            from catboost import CatBoostRegressor, Pool
        except ImportError:
            raise ImportError("CatBoost required. Install with: pip install catboost")

        params = self.config.model.catboost_params

        model = CatBoostRegressor(
            iterations=params.iterations,
            depth=params.depth,
            learning_rate=params.learning_rate,
            l2_leaf_reg=params.l2_leaf_reg,
            random_seed=params.random_seed,
            early_stopping_rounds=params.early_stopping_rounds,
            verbose=params.verbose,
            cat_features=cat_features,
        )

        # Create pools
        train_pool = Pool(X_train, y_train, cat_features=cat_features)
        val_pool = Pool(X_val, y_val, cat_features=cat_features)

        # Train
        model.fit(train_pool, eval_set=val_pool, use_best_model=True)

        logger.info(f"CatBoost trained: {model.best_iteration_} iterations")
        return model

    def _train_per_inverter(self, df_wide: Optional[pd.DataFrame] = None) -> PlantTrainingResult:
        """
        Train separate CatBoost models for each inverter.

        Uses the same filtering pipeline as plant-level training (NormalDataFilter),
        but trains 150 separate models instead of one with inverter_id as categorical.

        Args:
            df_wide: Optional pre-loaded wide-format DataFrame.

        Returns:
            PlantTrainingResult with per-inverter metrics
        """
        try:
            from catboost import CatBoostRegressor, Pool
        except ImportError:
            raise ImportError("CatBoost required. Install with: pip install catboost")

        start_time = datetime.now()

        try:
            # Steps 1-6: Same data preparation as plant-level training
            if df_wide is None:
                df_wide = self._load_data()

            df_wide = rename_columns_for_training(df_wide, self.config)

            transform_result = self.transformer.transform(df_wide)
            df_long = transform_result.df_long
            logger.info(f"Transformed to long format: {transform_result.n_rows:,} rows, "
                       f"{transform_result.n_inverters} inverters")

            df_long = filter_training_period(df_long, self.config.training.max_years)
            logger.info(f"Training period: {df_long['timestamp'].min()} to {df_long['timestamp'].max()}")

            df_long = add_temporal_features(df_long)
            df_long = self._add_physics_predictions(df_long)

            # Store full data BEFORE filtering (for complete residuals export)
            df_long_full = df_long.copy()

            # Step 7: Apply SAME filtering as plant-level (NormalDataFilter)
            df_long = self._filter_valid_data(df_long)
            logger.info(f"After filtering: {len(df_long):,} samples")

            # Step 8: Train individual models per inverter
            inverter_ids = df_long["inverter_id"].unique()
            n_inverters = len(inverter_ids)
            logger.info(f"Training {n_inverters} separate CatBoost models...")

            # Feature columns (WITHOUT inverter_id - it's a single inverter)
            feature_cols = [
                "irradiance",
                "ambient_temp",
                "physics_power",
                "hour_sin", "hour_cos",
                "doy_sin", "doy_cos",
            ]
            optional_cols = ["module_temp", "wind_speed", "solar_elevation", "solar_azimuth", "humidity"]
            for col in optional_cols:
                if col in df_long.columns and df_long[col].notna().sum() > len(df_long) * 0.5:
                    feature_cols.append(col)

            available_cols = [c for c in feature_cols if c in df_long.columns]
            params = self.config.model.catboost_params

            # Storage for models and metrics
            models = {}
            inverter_metrics = {}
            all_predictions = []
            total_train_samples = 0
            total_val_samples = 0

            for i, inv_id in enumerate(inverter_ids):
                inv_data = df_long[df_long["inverter_id"] == inv_id].copy()

                if len(inv_data) < self.config.training.min_training_samples:
                    logger.warning(f"Skipping {inv_id}: only {len(inv_data)} samples")
                    inverter_metrics[str(inv_id)] = InverterMetrics(
                        inverter_id=str(inv_id),
                        group_id=self.transformer.get_group_id(str(inv_id)),
                        r2=0.0, mae_kw=0.0, rmse_kw=0.0,
                        n_samples=len(inv_data),
                        success=False,
                        error_message="Insufficient training samples",
                    )
                    continue

                X = inv_data[available_cols]
                y = inv_data["power"]

                # Random train/val split (same as plant-level)
                X_train, X_val, y_train, y_val = train_test_split(
                    X, y,
                    test_size=self.config.training.validation_split,
                    random_state=42,
                    shuffle=True,
                )

                total_train_samples += len(X_train)
                total_val_samples += len(X_val)

                # Train CatBoost for this inverter
                model = CatBoostRegressor(
                    iterations=params.iterations,
                    depth=params.depth,
                    learning_rate=params.learning_rate,
                    l2_leaf_reg=params.l2_leaf_reg,
                    random_seed=params.random_seed,
                    early_stopping_rounds=params.early_stopping_rounds,
                    verbose=0,  # Quiet mode for per-inverter
                )

                train_pool = Pool(X_train, y_train)
                val_pool = Pool(X_val, y_val)
                model.fit(train_pool, eval_set=val_pool, use_best_model=True)

                # Calculate metrics
                y_pred = model.predict(X_val)
                r2 = r2_score(y_val, y_pred)
                mae = mean_absolute_error(y_val, y_pred)
                rmse = np.sqrt(np.mean((y_val - y_pred) ** 2))

                models[str(inv_id)] = model
                inverter_metrics[str(inv_id)] = InverterMetrics(
                    inverter_id=str(inv_id),
                    group_id=self.transformer.get_group_id(str(inv_id)),
                    r2=float(r2),
                    mae_kw=float(mae),
                    rmse_kw=float(rmse),
                    n_samples=len(inv_data),
                    success=r2 >= self.config.quality.min_r2,
                )

                # Store predictions for residuals export
                inv_full = df_long_full[df_long_full["inverter_id"] == inv_id].copy()
                X_full = inv_full[available_cols]
                inv_full["predicted_power"] = model.predict(X_full)
                all_predictions.append(inv_full)

                if (i + 1) % 25 == 0:
                    logger.info(f"Trained {i + 1}/{n_inverters} inverters...")

            logger.info(f"Completed training {len(models)} individual models")

            # Calculate aggregate metrics
            successful = [m for m in inverter_metrics.values() if m.success]
            avg_r2 = np.mean([m.r2 for m in successful]) if successful else 0.0
            avg_mae = np.mean([m.mae_kw for m in successful]) if successful else 0.0

            logger.info(f"Avg R² (per-inverter): {avg_r2:.4f}, Avg MAE: {avg_mae:.4f} kW/kWp")

            # Calculate physics-only R² for comparison
            physics_only_r2 = r2_score(
                df_long["power"],
                df_long["physics_power"]
            ) if "physics_power" in df_long.columns else 0.0
            logger.info(f"Physics-only R²: {physics_only_r2:.4f}")

            # Create result
            training_time = (datetime.now() - start_time).total_seconds()

            self.result = PlantTrainingResult(
                plant_id=self.config.plant_id,
                plant_name=self.config.plant_name,
                success=True,
                model_type="PerInverter (Physics + CatBoost x N)",
                plant_r2=avg_r2,
                plant_mae_kw=avg_mae,
                physics_only_r2=physics_only_r2,
                inverter_metrics=inverter_metrics,
                n_inverters=n_inverters,
                n_training_samples=total_train_samples,
                n_validation_samples=total_val_samples,
                training_period_start=str(df_long["timestamp"].min()),
                training_period_end=str(df_long["timestamp"].max()),
                training_time_s=training_time,
                feature_names=available_cols,
                cat_features=[],  # No categorical features in per-inverter mode
            )

            # Store models for potential later use
            self._per_inverter_models = models

            # Save individual models
            if self.config.output.save_models:
                models_dir = self.output_dir / "models" / "per_inverter"
                models_dir.mkdir(parents=True, exist_ok=True)
                for inv_id, model in models.items():
                    inv_safe = str(inv_id).replace(" ", "_").replace(".", "_")
                    model_path = models_dir / f"{inv_safe}.cbm"
                    model.save_model(str(model_path))
                logger.info(f"Saved {len(models)} models to {models_dir}")

            # Export JSON
            if self.config.output.save_json:
                self.export_json()

            # Export quality report
            if self.config.output.save_quality_report:
                self._save_quality_report()

            # Export residuals CSVs
            if self.config.training.export_residuals and all_predictions:
                df_predictions = pd.concat(all_predictions, ignore_index=True)
                n_exported = self._export_per_inverter_residuals(df_predictions)
                logger.info(f"Exported {n_exported} residuals CSVs to {self.output_dir}")

                # Regenerate dashboard data
                logger.info("Regenerating dashboard data from residuals...")
                try:
                    aggregator = DashboardAggregator(self.output_dir)
                    aggregator.aggregate_all()
                    logger.info("Dashboard data regenerated successfully")
                except Exception as e:
                    logger.warning(f"Dashboard aggregation failed (non-fatal): {e}")

            logger.info(f"Per-inverter training complete in {training_time:.1f}s")
            return self.result

        except Exception as e:
            logger.error(f"Per-inverter training failed: {e}")
            import traceback
            traceback.print_exc()
            self.result = PlantTrainingResult(
                plant_id=self.config.plant_id,
                plant_name=self.config.plant_name,
                success=False,
                error_message=str(e),
            )
            return self.result

    def _export_per_inverter_residuals(
        self,
        df_predictions: pd.DataFrame,
        min_expected_power: float = 0.10,
    ) -> int:
        """Export residuals CSVs for per-inverter mode."""
        residuals_dir = self.output_dir
        residuals_dir.mkdir(parents=True, exist_ok=True)

        exported_count = 0
        for inv_id in df_predictions["inverter_id"].unique():
            inv_data = df_predictions[df_predictions["inverter_id"] == inv_id].copy()

            if len(inv_data) < 10:
                continue

            # Zero out nighttime/low-light periods
            is_nighttime = inv_data["predicted_power"] < min_expected_power
            inv_data.loc[is_nighttime, "predicted_power"] = 0.0

            actual = inv_data["power"].values
            expected = inv_data["predicted_power"].values
            residual = expected - actual

            safe_expected = np.where(expected > 0, expected, 1.0)
            loss_pct = np.where(
                expected > 0,
                (expected - actual) / safe_expected * 100,
                0.0
            )

            residuals_df = pd.DataFrame({
                "timestamp": inv_data["timestamp"].values,
                "actual": actual,
                "expected": expected,
                "residual": residual,
                "loss_pct": loss_pct,
                "irradiance": inv_data["irradiance"].values if "irradiance" in inv_data.columns else None,
            })

            residuals_df = residuals_df.sort_values("timestamp")
            inv_safe = str(inv_id).replace(" ", "_").replace(".", "_")
            csv_path = residuals_dir / f"residuals_{inv_safe}.csv"
            residuals_df.to_csv(csv_path, index=False)
            exported_count += 1

        return exported_count

    def _calculate_per_inverter_metrics(
        self,
        df_long: pd.DataFrame,
        X_val: pd.DataFrame,
        y_val: pd.Series,
        y_pred_val: np.ndarray,
    ) -> dict[str, InverterMetrics]:
        """Calculate metrics for each inverter."""
        metrics = {}

        # Get inverter_id for validation set
        val_inverter_ids = X_val["inverter_id"].values

        for inv_id in df_long["inverter_id"].unique():
            mask = val_inverter_ids == inv_id

            if mask.sum() < 10:  # Skip if too few samples
                metrics[str(inv_id)] = InverterMetrics(
                    inverter_id=str(inv_id),
                    group_id=self.transformer.get_group_id(str(inv_id)),
                    r2=0.0,
                    mae_kw=0.0,
                    rmse_kw=0.0,
                    n_samples=int(mask.sum()),
                    success=False,
                    error_message="Insufficient validation samples",
                )
                continue

            y_true_inv = y_val.values[mask]
            y_pred_inv = y_pred_val[mask]

            r2 = r2_score(y_true_inv, y_pred_inv)
            mae = mean_absolute_error(y_true_inv, y_pred_inv)
            rmse = np.sqrt(np.mean((y_true_inv - y_pred_inv) ** 2))

            metrics[str(inv_id)] = InverterMetrics(
                inverter_id=str(inv_id),
                group_id=self.transformer.get_group_id(str(inv_id)),
                r2=float(r2),
                mae_kw=float(mae),
                rmse_kw=float(rmse),
                n_samples=int(mask.sum()),
                success=r2 >= self.config.quality.min_r2,
            )

        return metrics

    def _save_model(self) -> None:
        """Save trained model to disk."""
        if self.model is None:
            return

        model_path = self.output_dir / "models" / f"{self.config.plant_id}_plant_model.cbm"
        model_path.parent.mkdir(parents=True, exist_ok=True)
        self.model.save_model(str(model_path))
        logger.info(f"Model saved to {model_path}")

    def export_json(self) -> Path:
        """
        Export training results to dashboard-compatible JSON.

        Returns:
            Path to exported JSON file
        """
        if self.result is None:
            raise ValueError("No training result available. Run train() first.")

        output = {
            "generatedAt": datetime.now().isoformat(),
            "plantId": self.result.plant_id,
            "plantName": self.result.plant_name,
            "modelType": self.result.model_type,
            "config": {
                "maxYears": self.config.training.max_years,
                "minPR": self.config.training.min_pr,
                "useCatBoost": self.config.model.use_catboost,
                "minR2": self.config.quality.min_r2,
                "useEnhancedSelection": self.config.training.use_enhanced_selection,
            },
            "statistics": {
                "totalInverters": self.result.n_inverters,
                "successful": sum(1 for m in self.result.inverter_metrics.values() if m.success),
                "failed": sum(1 for m in self.result.inverter_metrics.values() if not m.success),
                "totalTime_s": round(self.result.training_time_s, 2),
                "avgR2": round(self.result.avg_r2, 4),
                "avgMAE_kW": round(self.result.avg_mae_kw, 4),
                "plantModelR2": round(self.result.plant_r2, 4),
                "physicsOnlyR2": round(self.result.physics_only_r2, 4),
            },
            "trainingPeriod": {
                "start": self.result.training_period_start,
                "end": self.result.training_period_end,
            },
            "hybridConfig": {
                "modelType": "PlantLevel (Physics + ML)",
                "physicsModel": "PVWatts",
                "mlModel": "CatBoost",
                "physicsParams": {
                    "latitude": self.config.location.latitude,
                    "longitude": self.config.location.longitude,
                    "tilt": self.config.array.tilt,
                    "azimuth": self.config.array.azimuth,
                    "gamma_pdc": self.config.array.gamma_pdc,
                },
                "categoricalFeature": "inverter_id",
            },
            "inverters": {
                inv_id: {
                    "inverterId": m.inverter_id,
                    "groupId": m.group_id,
                    "success": m.success,
                    "metrics": {
                        "r2": round(m.r2, 4),
                        "mae_kW": round(m.mae_kw, 4),
                        "rmse_kW": round(m.rmse_kw, 4),
                    },
                    "nSamples": m.n_samples,
                    "nominalPower_kW": self._get_nominal_power(m.inverter_id),
                }
                for inv_id, m in self.result.inverter_metrics.items()
            },
        }

        # Save JSON
        json_path = self.output_dir / "digital_twins_summary.json"
        with open(json_path, "w") as f:
            json.dump(output, f, indent=2)

        logger.info(f"JSON exported to {json_path}")
        return json_path

    def _get_nominal_power(self, inverter_id: str) -> float:
        """Get nominal power for inverter from config."""
        spec = self.config.components.get_inverter_spec(inverter_id)
        if spec:
            return spec.nominal_kw
        return 60.0  # Default

    def _save_quality_report(self) -> None:
        """Save quality report as CSV."""
        if self.result is None:
            return

        rows = []
        for inv_id, m in self.result.inverter_metrics.items():
            rows.append({
                "inverter_id": m.inverter_id,
                "group_id": m.group_id,
                "r2": m.r2,
                "mae_kw": m.mae_kw,
                "rmse_kw": m.rmse_kw,
                "n_samples": m.n_samples,
                "success": m.success,
                "error_message": m.error_message,
            })

        df = pd.DataFrame(rows)
        report_path = self.output_dir / "quality_report.csv"
        df.to_csv(report_path, index=False)
        logger.info(f"Quality report saved to {report_path}")

    def export_residuals_csv(
        self,
        df_long: pd.DataFrame,
        min_expected_power: float = 0.10,
    ) -> int:
        """
        Export per-inverter residuals CSVs for timeline heatmap.

        Creates: {output_dir}/residuals_INV_XX_XXX.csv
        Columns: timestamp, actual, expected, residual, loss_pct

        Args:
            df_long: Long-format DataFrame with predictions
            min_expected_power: Minimum expected power (kW/kWp) to include.
                              Filters out nighttime data where physics model
                              outputs small baseline values (~0.04-0.05).

        Returns:
            Number of CSVs exported
        """
        if self.model is None:
            raise ValueError("Model not trained. Run train() first.")

        try:
            from catboost import Pool
        except ImportError:
            raise ImportError("CatBoost required for predictions")

        df = df_long.copy()

        # Add predictions if not present
        if "predicted_power" not in df.columns:
            # Reconstruct feature list in SAME ORDER as training
            # Must match _prepare_features order exactly
            feature_cols = [
                "irradiance",
                "ambient_temp",
                "physics_power",
                "hour_sin", "hour_cos",
                "doy_sin", "doy_cos",
                "inverter_id",
            ]
            # Add optional features in same order as training
            optional_cols = ["module_temp", "wind_speed", "solar_elevation", "solar_azimuth", "humidity"]
            for col in optional_cols:
                if col in df.columns and df[col].notna().sum() > len(df) * 0.5:
                    feature_cols.append(col)
            # Add group_id last (if present)
            if "group_id" in df.columns:
                feature_cols.append("group_id")

            # Filter to available columns (maintain order)
            available_cols = [c for c in feature_cols if c in df.columns]
            X = df[available_cols]

            # Use Pool with cat_features for correct prediction
            cat_features = [c for c in self.result.cat_features if c in available_cols]
            pred_pool = Pool(X, cat_features=cat_features)
            df["predicted_power"] = self.model.predict(pred_pool)

        # Create residuals directory
        residuals_dir = self.output_dir
        residuals_dir.mkdir(parents=True, exist_ok=True)

        exported_count = 0
        inverter_ids = df["inverter_id"].unique()

        for inv_id in inverter_ids:
            inv_data = df[df["inverter_id"] == inv_id].copy()

            if len(inv_data) < 10:
                continue

            # Zero out nighttime/low-light periods instead of filtering
            # This keeps continuous data for charts (no gaps between days)
            # Physics model outputs ~0.04-0.05 kW/kWp baseline even at night
            inv_data = inv_data.copy()
            is_nighttime = inv_data["predicted_power"] < min_expected_power
            inv_data.loc[is_nighttime, "predicted_power"] = 0.0

            # Calculate residuals
            actual = inv_data["power"].values
            expected = inv_data["predicted_power"].values
            residual = expected - actual

            # Calculate loss percentage (handle expected = 0 at night)
            # Use safe division to avoid numpy warnings
            safe_expected = np.where(expected > 0, expected, 1.0)  # Avoid division by zero
            loss_pct = np.where(
                expected > 0,
                (expected - actual) / safe_expected * 100,
                0.0  # No loss during nighttime (expected = 0)
            )

            # Create residuals DataFrame
            # Include irradiance for prediction-side filtering (only filter by irradiance > 0)
            residuals_df = pd.DataFrame({
                "timestamp": inv_data["timestamp"].values,
                "actual": actual,
                "expected": expected,
                "residual": residual,
                "loss_pct": loss_pct,
                "irradiance": inv_data["irradiance"].values if "irradiance" in inv_data.columns else None,
            })

            # Sort by timestamp
            residuals_df = residuals_df.sort_values("timestamp")

            # Generate filename (replace spaces and dots with underscores)
            inv_safe = str(inv_id).replace(" ", "_").replace(".", "_")
            csv_path = residuals_dir / f"residuals_{inv_safe}.csv"

            # Save CSV
            residuals_df.to_csv(csv_path, index=False)
            exported_count += 1

        logger.info(f"Exported {exported_count} residuals CSVs to {residuals_dir}")
        return exported_count

    def export_residuals_from_wide(
        self,
        df_wide: pd.DataFrame,
        min_expected_power: float = 0.10,
        write_parquet: bool = True,
    ) -> int:
        """
        Export per-inverter residual files for the FULL SCADA timeline without
        materializing a full long-format dataframe (prevents OOM).

        Output schema matches the residuals CSV files used by the frontend:
        timestamp, actual, expected, residual, loss_pct, irradiance (+ parquet mirror).
        """
        if self.model is None or self.result is None:
            raise ValueError("Model not trained. Run train() first.")

        try:
            from catboost import Pool
        except ImportError:
            raise ImportError("CatBoost required for predictions")

        import polars as pl

        df = df_wide.copy()

        ts_col = self.config.data.timestamp_column or "timestamp"
        if ts_col not in df.columns:
            raise ValueError(f"Timestamp column '{ts_col}' not found in wide data")
        df[ts_col] = pd.to_datetime(df[ts_col])

        # Identify inverter columns
        _, inverter_cols = self.transformer.identify_columns(df)
        if not inverter_cols:
            raise ValueError("No inverter columns found in wide data")

        # Build shared feature frame (plant-level, per timestamp)
        base = pd.DataFrame({"timestamp": df[ts_col]})
        for col in ["irradiance", "ambient_temp", "module_temp", "wind_speed", "solar_elevation", "solar_azimuth", "humidity"]:
            if col in df.columns:
                base[col] = df[col]

        # Temporal features used by the model
        base = add_temporal_features(base)

        # Physics predictions (do NOT call _add_physics_predictions, it requires 'power')
        physics_power = self.physics_model.predict(
            base,
            irradiance_col="irradiance",
            temperature_col="ambient_temp",
            wind_col="wind_speed" if "wind_speed" in base.columns else None,
        )
        capacity_kw = self.physics_model.system.capacity_kw
        if capacity_kw > 0:
            physics_power = physics_power / capacity_kw
        base["physics_power"] = physics_power

        # Determine optional feature columns to include (same heuristic as export_residuals_csv)
        optional_cols = ["module_temp", "wind_speed", "solar_elevation", "solar_azimuth", "humidity"]
        available_optional = [c for c in optional_cols if c in base.columns and base[c].notna().sum() > len(base) * 0.5]

        residuals_dir = self.output_dir
        residuals_dir.mkdir(parents=True, exist_ok=True)

        exported_count = 0
        for raw_col in sorted(inverter_cols):
            inv_id = self.transformer.extract_inverter_id(raw_col)
            if not inv_id:
                continue

            inv_frame = base.copy()
            inv_frame["power"] = df[raw_col].values
            inv_frame["inverter_id"] = inv_id
            inv_frame["group_id"] = self.transformer.get_group_id(inv_id)

            # Build feature list in SAME ORDER as training (matches export_residuals_csv)
            feature_cols = [
                "irradiance",
                "ambient_temp",
                "physics_power",
                "hour_sin", "hour_cos",
                "doy_sin", "doy_cos",
                "inverter_id",
            ]
            for c in available_optional:
                feature_cols.append(c)
            feature_cols.append("group_id")

            available_cols = [c for c in feature_cols if c in inv_frame.columns]
            X = inv_frame[available_cols]
            cat_features = [c for c in self.result.cat_features if c in available_cols]
            pred_pool = Pool(X, cat_features=cat_features)
            predicted = np.asarray(self.model.predict(pred_pool), dtype=float)

            # Zero out nighttime/low-light periods (continuous charts)
            predicted[predicted < min_expected_power] = 0.0

            actual = inv_frame["power"].to_numpy(dtype=float)
            expected = predicted
            residual = expected - actual

            safe_expected = np.where(expected > 0, expected, 1.0)
            loss_pct = np.where(
                expected > 0,
                (expected - actual) / safe_expected * 100,
                0.0,
            )

            residuals_df = pd.DataFrame({
                "timestamp": inv_frame["timestamp"].values,
                "actual": actual,
                "expected": expected,
                "residual": residual,
                "loss_pct": loss_pct,
                "irradiance": inv_frame["irradiance"].values if "irradiance" in inv_frame.columns else None,
            }).sort_values("timestamp")

            inv_safe = str(inv_id).replace(" ", "_").replace(".", "_")
            csv_path = residuals_dir / f"residuals_{inv_safe}.csv"
            residuals_df.to_csv(csv_path, index=False)

            if write_parquet:
                parquet_path = residuals_dir / f"residuals_{inv_safe}.parquet"
                pl.from_pandas(residuals_df).write_parquet(parquet_path, compression="zstd")

            exported_count += 1

        logger.info(f"Exported {exported_count} residuals files to {residuals_dir}")
        return exported_count

    def predict(self, df_long: pd.DataFrame) -> pd.DataFrame:
        """
        Make predictions for new data.

        Args:
            df_long: Long-format DataFrame with features

        Returns:
            DataFrame with predictions added
        """
        if self.model is None:
            raise ValueError("Model not trained. Run train() first.")

        df = df_long.copy()

        # Add physics predictions if not present
        if "physics_power" not in df.columns:
            df = self._add_physics_predictions(df)

        # Add temporal features if not present
        if "hour_sin" not in df.columns:
            df = add_temporal_features(df)

        # Prepare features
        feature_cols = self.result.feature_names + self.result.cat_features
        available_cols = [c for c in feature_cols if c in df.columns]
        X = df[available_cols]

        # Predict
        df["predicted_power"] = self.model.predict(X)
        df["prediction_error"] = df["power"] - df["predicted_power"]

        return df


def train_plant_model(
    plant_id: Optional[str] = None,
    config_path: Union[str, Path, None] = None,
    config_dir: Union[str, Path] = "plant_configs",
) -> PlantTrainingResult:
    """
    Convenience function to train a plant model.

    Args:
        plant_id: Plant identifier (loads from plant_configs/{plant_id}.yaml)
        config_path: Direct path to config YAML file
        config_dir: Directory containing plant config files

    Returns:
        PlantTrainingResult
    """
    from .plant_config import PlantConfig, load_plant_config

    if config_path:
        config = PlantConfig.from_yaml(config_path)
    elif plant_id:
        config = load_plant_config(plant_id, config_dir)
    else:
        raise ValueError("Either plant_id or config_path must be provided")

    factory = PlantLevelFactory(config)
    return factory.train()
