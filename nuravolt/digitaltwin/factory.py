"""
Digital Twin Factory for Solar PV Plants

Orchestrates creation of CatBoost digital twins for all inverters:
- Automatic data selection (first 3 years, PR > 10%)
- Batch parallel processing
- Model validation and quality assurance
- JSON export for dashboard consumption

Usage:
    from nuravolt.digitaltwin import DigitalTwinFactory, FactoryConfig

    factory = DigitalTwinFactory(
        config=FactoryConfig(max_years=3.0, min_pr=0.10),
        output_dir="public/data/digital_twins"
    )
    results = factory.create_all_twins(df)
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path
from datetime import datetime
import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import multiprocessing

import numpy as np
import pandas as pd

from .catboost_model import CatBoostDigitalTwin, FeatureConfig, ModelMetrics
from .data_selector import (
    DigitalTwinDataSelector,
    SelectionCriteria,
    SelectionResult,
    identify_training_columns,
    extract_inverter_id,
)

logger = logging.getLogger(__name__)


@dataclass
class FactoryConfig:
    """Configuration for digital twin factory."""
    # Data selection
    max_years: float = 3.0              # Training period (first N years)
    min_pr: float = 0.10                # Minimum PR for training data
    min_irradiance: float = 50.0        # Minimum irradiance (W/m²)
    ensure_seasonal_balance: bool = True

    # Model training
    use_catboost: bool = True           # Use CatBoost (else LightGBM)
    min_training_samples: int = 500     # Minimum samples per inverter
    validation_split: float = 0.2       # Validation fraction
    model_params: Optional[Dict[str, Any]] = None  # Model hyperparameters dict
    enable_hyperparameter_tuning: bool = False  # Enable automatic hyperparameter tuning
    tuning_search_space: Optional[Dict[str, list]] = None  # Search space for tuning
    tuning_n_trials: int = 20           # Number of trials for hyperparameter tuning

    # Processing
    max_workers: int = field(default_factory=lambda: min(4, multiprocessing.cpu_count()))
    batch_size: int = 30                # Inverters per batch

    # Quality thresholds
    min_r2: float = 0.70                # Minimum R² for valid model
    max_mae_kw: float = 50.0            # Maximum MAE (kW) for valid model

    # Output
    save_models: bool = True            # Save model pickle files
    save_json: bool = True              # Export JSON for dashboard
    verbose: bool = True

    # Weather fallback (used only when no on-site irradiance column exists;
    # requires latitude/longitude — see nuravolt/weather/fallback.py)
    enable_weather_fallback: bool = True
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    tilt: Optional[float] = None        # array tilt (deg); heuristic if None
    azimuth: Optional[float] = None     # pvlib convention, 180 = south
    timezone: str = "auto"              # IANA tz of the SCADA timestamps


@dataclass
class InverterResult:
    """Result for single inverter model creation."""
    inverter_id: str
    group_id: str
    success: bool = False
    metrics: Optional[ModelMetrics] = None
    model: Optional[CatBoostDigitalTwin] = None
    training_samples: int = 0
    training_timestamps: List[str] = field(default_factory=list)  # List of timestamps used for training
    training_period: Optional[Tuple[str, str]] = None
    error_message: Optional[str] = None
    processing_time_s: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """Convert to JSON-serializable dict."""
        return {
            "inverterId": self.inverter_id,
            "groupId": self.group_id,
            "success": self.success,
            "metrics": self.metrics.to_dict() if self.metrics else None,
            "trainingSamples": self.training_samples,
            "trainingPeriod": {
                "start": self.training_period[0] if self.training_period else None,
                "end": self.training_period[1] if self.training_period else None,
            },
            "errorMessage": self.error_message,
            "processingTime_s": round(self.processing_time_s, 2),
        }


class DigitalTwinFactory:
    """
    Factory for creating digital twins for all inverters in a plant.

    Features:
    - Automatic column detection (inverters, irradiance, temperature)
    - Training data selection (first 3 years, PR > 10%)
    - Parallel batch processing
    - Model validation and quality control
    - JSON export for dashboard visualization
    """

    def __init__(
        self,
        config: Optional[FactoryConfig] = None,
        output_dir: str = "public/data/digital_twins",
    ):
        """
        Initialize factory.

        Parameters:
        -----------
        config : FactoryConfig
            Factory configuration
        output_dir : str
            Output directory for models and JSON
        """
        self.config = config or FactoryConfig()
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Data selector
        self.data_selector = DigitalTwinDataSelector(
            criteria=SelectionCriteria(
                max_years=self.config.max_years,
                min_pr=self.config.min_pr,
                min_irradiance=self.config.min_irradiance,
                ensure_seasonal_balance=self.config.ensure_seasonal_balance,
            )
        )

        # Results storage
        self.results: Dict[str, InverterResult] = {}
        self.column_mapping: Dict[str, Any] = {}

        # Statistics
        self.stats = {
            "start_time": None,
            "end_time": None,
            "total_inverters": 0,
            "successful": 0,
            "failed": 0,
            "skipped": 0,
        }

    def create_all_twins(
        self,
        df: pd.DataFrame,
        inverter_limit: Optional[int] = None,
        inverter_filter: Optional[List[str]] = None,
    ) -> Dict[str, InverterResult]:
        """
        Create digital twins for all inverters.

        Parameters:
        -----------
        df : pd.DataFrame
            Full dataset with all inverter columns
        inverter_limit : int
            Maximum number of inverters to process (for testing)
        inverter_filter : List[str]
            Specific inverter columns to process

        Returns:
        --------
        Dict[str, InverterResult]
            Results keyed by inverter ID
        """
        self.stats["start_time"] = datetime.now()
        logger.info("Starting digital twin factory...")

        # Identify columns
        self.column_mapping = identify_training_columns(df)
        inverter_cols = self.column_mapping["inverter_columns"]
        irradiance_col = self.column_mapping["irradiance_column"]

        if not inverter_cols:
            raise ValueError("No inverter columns found in DataFrame")

        # Ensure datetime index (needed before any weather-fallback alignment)
        if "timestamp" in df.columns:
            df = df.set_index("timestamp")
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)

        if not irradiance_col:
            df, fallback_meta = self._apply_weather_fallback(df)
            if fallback_meta is None:
                raise ValueError(
                    "No irradiance column found in DataFrame and weather fallback "
                    "unavailable — set FactoryConfig.latitude/longitude to enable "
                    "satellite-derived irradiance (nuravolt/weather)"
                )
            # Re-detect so injected irradiance/ambient-temp columns are picked up
            self.column_mapping = identify_training_columns(df)
            irradiance_col = self.column_mapping["irradiance_column"]
            self.column_mapping["data_provenance"] = fallback_meta
            self.stats["irradiance_source"] = fallback_meta["source"]
        else:
            self.stats["irradiance_source"] = "onsite"

        logger.info(f"Found {len(inverter_cols)} inverters, irradiance: {irradiance_col} "
                    f"(source: {self.stats['irradiance_source']})")

        # Apply filters
        if inverter_filter:
            inverter_cols = [c for c in inverter_cols if c in inverter_filter]

        if inverter_limit:
            inverter_cols = inverter_cols[:inverter_limit]

        self.stats["total_inverters"] = len(inverter_cols)
        logger.info(f"Processing {len(inverter_cols)} inverters")

        # Process in batches
        batches = [
            inverter_cols[i:i + self.config.batch_size]
            for i in range(0, len(inverter_cols), self.config.batch_size)
        ]

        return self._run_batches(df, batches, irradiance_col)

    def _apply_weather_fallback(self, df: pd.DataFrame):
        """Inject satellite/model irradiance when no on-site sensor column exists.

        Returns (df, provenance) — provenance is None when the fallback is
        disabled, unconfigured (no lat/lon), or failed; callers decide whether
        that is fatal.
        """
        cfg = self.config
        if not cfg.enable_weather_fallback or cfg.latitude is None or cfg.longitude is None:
            return df, None
        try:
            from nuravolt.weather import ensure_irradiance
            # fleet-mean power lets the fallback auto-detect logger clock
            # offsets (SCADA fixed standard time vs modeled DST local time)
            inverter_cols = (self.column_mapping or {}).get("inverter_columns") or []
            reference = df[inverter_cols].mean(axis=1) if inverter_cols else None
            df, provenance = ensure_irradiance(
                df, cfg.latitude, cfg.longitude,
                tilt=cfg.tilt, azimuth=cfg.azimuth, timezone=cfg.timezone,
                align_reference=reference,
            )
        except Exception as exc:
            logger.warning(f"Weather fallback failed: {exc}")
            return df, None
        logger.warning(
            "No on-site irradiance column — using %s fallback irradiance "
            "(plane=%s, confidence=%.2f, coverage=%.0f%%)",
            provenance["source"], provenance["irradiance_plane"],
            provenance["confidence"], 100 * provenance["coverage"],
        )
        return df, provenance

    def _run_batches(
        self,
        df: pd.DataFrame,
        batches: List[List[str]],
        irradiance_col: str,
    ) -> Dict[str, InverterResult]:

        for batch_idx, batch in enumerate(batches):
            logger.info(f"Processing batch {batch_idx + 1}/{len(batches)} "
                       f"({len(batch)} inverters)")

            if self.config.max_workers > 1:
                batch_results = self._process_batch_parallel(df, batch, irradiance_col)
            else:
                batch_results = self._process_batch_sequential(df, batch, irradiance_col)

            self.results.update(batch_results)

            # Progress logging
            successful = sum(1 for r in batch_results.values() if r.success)
            logger.info(f"Batch {batch_idx + 1}: {successful}/{len(batch)} successful")

        # Calculate final stats
        self._calculate_stats()

        # Export results
        if self.config.save_json:
            self._export_json()

        logger.info(f"Factory complete: {self.stats['successful']} successful, "
                   f"{self.stats['failed']} failed, {self.stats['skipped']} skipped")

        return self.results

    def _process_batch_parallel(
        self,
        df: pd.DataFrame,
        inverter_cols: List[str],
        irradiance_col: str,
    ) -> Dict[str, InverterResult]:
        """Process batch of inverters in parallel."""
        results = {}

        with ThreadPoolExecutor(max_workers=self.config.max_workers) as executor:
            futures = {
                executor.submit(
                    self._create_single_twin,
                    df, inv_col, irradiance_col
                ): inv_col
                for inv_col in inverter_cols
            }

            for future in as_completed(futures):
                inv_col = futures[future]
                try:
                    result = future.result(timeout=300)
                    results[result.inverter_id] = result
                except Exception as e:
                    inv_id, group_id = extract_inverter_id(inv_col)
                    logger.error(f"Error processing {inv_id}: {e}")
                    results[inv_id] = InverterResult(
                        inverter_id=inv_id,
                        group_id=group_id,
                        success=False,
                        error_message=str(e),
                    )

        return results

    def _process_batch_sequential(
        self,
        df: pd.DataFrame,
        inverter_cols: List[str],
        irradiance_col: str,
    ) -> Dict[str, InverterResult]:
        """Process batch of inverters sequentially."""
        results = {}

        for inv_col in inverter_cols:
            try:
                result = self._create_single_twin(df, inv_col, irradiance_col)
                results[result.inverter_id] = result
            except Exception as e:
                inv_id, group_id = extract_inverter_id(inv_col)
                logger.error(f"Error processing {inv_id}: {e}")
                results[inv_id] = InverterResult(
                    inverter_id=inv_id,
                    group_id=group_id,
                    success=False,
                    error_message=str(e),
                )

        return results

    def _create_single_twin(
        self,
        df: pd.DataFrame,
        inverter_col: str,
        irradiance_col: str,
    ) -> InverterResult:
        """Create digital twin for single inverter."""
        import time
        start_time = time.time()

        inv_id, group_id = extract_inverter_id(inverter_col)
        result = InverterResult(inverter_id=inv_id, group_id=group_id)

        try:
            # Select training data
            selection = self.data_selector.select_for_inverter(
                df=df,
                inverter_col=inverter_col,
                irradiance_col=irradiance_col,
            )

            if selection.n_samples < self.config.min_training_samples:
                result.error_message = f"Insufficient data: {selection.n_samples} samples"
                result.training_samples = selection.n_samples
                return result

            result.training_samples = selection.n_samples
            result.training_period = selection.date_range

            # Capture training timestamps for visualization
            if hasattr(selection.df.index, 'strftime'):
                # DatetimeIndex - convert to ISO format strings
                result.training_timestamps = selection.df.index.strftime('%Y-%m-%d %H:%M:%S').tolist()
            else:
                logger.warning(f"No datetime index found for {inv_id}, timestamps not captured")

            # Prepare features
            train_df = selection.df.copy()

            # Add temporal features
            if isinstance(train_df.index, pd.DatetimeIndex):
                train_df["day_of_year"] = train_df.index.dayofyear
                train_df["hour_of_day"] = train_df.index.hour + train_df.index.minute / 60
                train_df["month"] = train_df.index.month

            # Add temperature features if available
            ambient_col = self.column_mapping.get("ambient_temp_column")
            module_col = self.column_mapping.get("module_temp_column")

            if ambient_col and ambient_col in df.columns:
                train_df["ambient_temp"] = df.loc[train_df.index, ambient_col]
            if module_col and module_col in df.columns:
                train_df["module_temp"] = df.loc[train_df.index, module_col]

            # Add irradiance as feature
            train_df["irradiance"] = df.loc[train_df.index, irradiance_col]

            # Target variable
            y = train_df[inverter_col]

            # Drop target from features
            X = train_df.drop(columns=[inverter_col], errors="ignore")

            # Remove non-feature columns
            drop_cols = ["calculated_pr", "quality_score"]
            X = X.drop(columns=[c for c in drop_cols if c in X.columns], errors="ignore")

            # Hyperparameter tuning if enabled
            model_params = self.config.model_params
            if self.config.enable_hyperparameter_tuning and self.config.tuning_search_space:
                from sklearn.model_selection import train_test_split
                from sklearn.metrics import r2_score
                import random

                logger.info(f"{inv_id}: Running hyperparameter tuning ({self.config.tuning_n_trials} trials)...")

                # Split data for tuning
                X_train, X_val, y_train, y_val = train_test_split(
                    X, y,
                    test_size=self.config.validation_split,
                    random_state=42,
                    shuffle=True
                )

                # Random search for best hyperparameters
                best_score = -float('inf')
                best_params = self.config.model_params.copy()

                for trial in range(self.config.tuning_n_trials):
                    # Sample random params from search space
                    trial_params = self.config.model_params.copy()
                    for param, values in self.config.tuning_search_space.items():
                        trial_params[param] = random.choice(values)

                    try:
                        # Create temporary model with trial params
                        temp_model = CatBoostDigitalTwin(
                            inverter_id=f"{inv_id}_trial{trial}",
                            use_catboost=self.config.use_catboost,
                            params=trial_params,
                        )

                        # Train with validation
                        temp_model.train(X_train, y_train, X_val, y_val)

                        # Evaluate on validation set
                        y_pred = temp_model.predict(X_val)
                        score = r2_score(y_val, y_pred)

                        if score > best_score:
                            best_score = score
                            best_params = trial_params.copy()
                            logger.info(f"{inv_id}: Trial {trial+1}/{self.config.tuning_n_trials} - New best R²={score:.4f}")
                        else:
                            logger.debug(f"{inv_id}: Trial {trial+1}/{self.config.tuning_n_trials} - R²={score:.4f}")

                    except Exception as e:
                        logger.warning(f"{inv_id}: Trial {trial+1} failed: {e}")
                        continue

                logger.info(f"{inv_id}: Best params found (R²={best_score:.4f}): {best_params}")
                model_params = best_params

            # Train final model with best params
            model = CatBoostDigitalTwin(
                inverter_id=inv_id,
                use_catboost=self.config.use_catboost,
                params=model_params,
            )

            # Train on all data (or with validation split if not tuning)
            if self.config.enable_hyperparameter_tuning:
                # Already tuned, train on all data
                metrics = model.train(X, y)
            else:
                # No tuning, optionally use validation split
                if self.config.validation_split > 0 and self.config.validation_split < 0.5:
                    from sklearn.model_selection import train_test_split
                    X_train, X_val, y_train, y_val = train_test_split(
                        X, y,
                        test_size=self.config.validation_split,
                        random_state=42,
                        shuffle=True
                    )
                    metrics = model.train(X_train, y_train, X_val, y_val)
                else:
                    metrics = model.train(X, y)
            result.metrics = metrics
            result.model = model

            # Validate model quality
            if metrics.r2 < self.config.min_r2:
                result.error_message = f"R² too low: {metrics.r2:.3f} < {self.config.min_r2}"
                result.success = False
            elif metrics.mae > self.config.max_mae_kw:
                result.error_message = f"MAE too high: {metrics.mae:.1f} > {self.config.max_mae_kw}"
                result.success = False
            else:
                result.success = True

                # Save model if successful
                if self.config.save_models:
                    model_path = self.output_dir / "models" / f"{inv_id.replace(' ', '_')}.pkl"
                    model_path.parent.mkdir(exist_ok=True)
                    model.save(str(model_path))

        except Exception as e:
            result.error_message = str(e)
            logger.error(f"Failed to create twin for {inv_id}: {e}")

        result.processing_time_s = time.time() - start_time
        return result

    def _calculate_stats(self) -> None:
        """Calculate final processing statistics."""
        self.stats["end_time"] = datetime.now()

        for result in self.results.values():
            if result.success:
                self.stats["successful"] += 1
            elif result.training_samples < self.config.min_training_samples:
                self.stats["skipped"] += 1
            else:
                self.stats["failed"] += 1

        duration = (self.stats["end_time"] - self.stats["start_time"]).total_seconds()
        self.stats["total_time_s"] = duration

        # Average metrics for successful models
        successful_results = [r for r in self.results.values() if r.success and r.metrics]
        if successful_results:
            self.stats["avg_r2"] = np.mean([r.metrics.r2 for r in successful_results])
            self.stats["avg_mae"] = np.mean([r.metrics.mae for r in successful_results])

    def _export_json(self) -> None:
        """Export results to JSON for dashboard consumption."""
        # Main summary
        summary = {
            "generatedAt": datetime.now().isoformat(),
            "config": {
                "maxYears": self.config.max_years,
                "minPR": self.config.min_pr,
                "useCatBoost": self.config.use_catboost,
                "minR2": self.config.min_r2,
            },
            "statistics": {
                "totalInverters": self.stats["total_inverters"],
                "successful": self.stats["successful"],
                "failed": self.stats["failed"],
                "skipped": self.stats["skipped"],
                "totalTime_s": self.stats.get("total_time_s", 0),
                "avgR2": round(self.stats.get("avg_r2", 0), 4),
                "avgMAE_kW": round(self.stats.get("avg_mae", 0), 2),
            },
            "trainingPeriod": self._get_training_period_range(),
        }

        # Per-inverter results
        inverter_results = {}
        for inv_id, result in self.results.items():
            inverter_results[inv_id] = result.to_dict()

        # Export files
        summary_path = self.output_dir / "digital_twins_summary.json"
        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2)

        results_path = self.output_dir / "digital_twins_results.json"
        with open(results_path, "w") as f:
            json.dump(inverter_results, f, indent=2)

        # Export combined for dashboard
        dashboard_data = {
            **summary,
            "inverters": inverter_results,
        }
        dashboard_path = self.output_dir / "digital_twins.json"
        with open(dashboard_path, "w") as f:
            json.dump(dashboard_data, f, indent=2)

        # Export individual training timestamp CSV files for each inverter
        timestamp_count = 0
        for inv_id, result in self.results.items():
            if result.success and result.training_timestamps:
                # Create safe filename
                inv_safe = inv_id.replace(" ", "_").replace(".", "_")
                timestamps_file = self.output_dir / f"training_timestamps_{inv_safe}.csv"

                # Save timestamps to CSV
                pd.DataFrame({'timestamp': result.training_timestamps}).to_csv(
                    timestamps_file, index=False
                )
                timestamp_count += 1

        if timestamp_count > 0:
            logger.info(f"Exported {timestamp_count} training timestamp CSV files to {self.output_dir}")

        logger.info(f"Exported JSON to {self.output_dir}")

    def _get_training_period_range(self) -> Dict[str, str]:
        """Get overall training period range."""
        starts = []
        ends = []
        for result in self.results.values():
            if result.training_period:
                starts.append(result.training_period[0])
                ends.append(result.training_period[1])

        return {
            "start": min(starts) if starts else None,
            "end": max(ends) if ends else None,
        }

    def get_successful_models(self) -> Dict[str, CatBoostDigitalTwin]:
        """Get all successfully trained models."""
        return {
            inv_id: result.model
            for inv_id, result in self.results.items()
            if result.success and result.model
        }

    def get_quality_report(self) -> pd.DataFrame:
        """Get DataFrame with quality metrics for all inverters."""
        records = []
        for inv_id, result in self.results.items():
            record = {
                "inverter_id": inv_id,
                "group_id": result.group_id,
                "success": result.success,
                "training_samples": result.training_samples,
                "r2": result.metrics.r2 if result.metrics else None,
                "mae_kw": result.metrics.mae if result.metrics else None,
                "rmse_kw": result.metrics.rmse if result.metrics else None,
                "processing_time_s": result.processing_time_s,
                "error": result.error_message,
            }
            records.append(record)

        return pd.DataFrame(records).sort_values("r2", ascending=False)


# ==============================================================================
# Hybrid Model Factory (Physics + ML)
# ==============================================================================


@dataclass
class HybridFactoryConfig(FactoryConfig):
    """Extended configuration for hybrid model factory."""
    # Physics model parameters
    latitude: float = 0.0               # Plant latitude
    longitude: float = 0.0              # Plant longitude
    altitude: float = 0.0               # Altitude (meters)
    tilt: float = 0.0                   # Array tilt (degrees)
    azimuth: float = 180.0              # Array azimuth (180 = south)
    gamma_pdc: float = -0.004           # Temperature coefficient (%/°C)

    # Hybrid model settings
    calibrate_physics: bool = True      # Calibrate physics model to data
    use_enhanced_selection: bool = True  # Use enhanced data selection with normal filtering


class HybridDigitalTwinFactory(DigitalTwinFactory):
    """
    Factory for creating hybrid physics-ML digital twins.

    Uses physics-based predictions as baseline with ML residual learning.
    This approach is more robust to weather distribution shifts and
    generalizes better to new conditions.
    """

    def __init__(
        self,
        config: Optional[HybridFactoryConfig] = None,
        output_dir: str = "public/data/digital_twins",
    ):
        """
        Initialize hybrid factory.

        Parameters:
        -----------
        config : HybridFactoryConfig
            Factory configuration
        output_dir : str
            Output directory for models and JSON
        """
        self.hybrid_config = config or HybridFactoryConfig()

        # Initialize parent with standard config
        super().__init__(config=self.hybrid_config, output_dir=output_dir)

        # Override data selector with enhanced version if enabled
        if self.hybrid_config.use_enhanced_selection:
            try:
                from .data_selector import EnhancedDataSelector, SelectionCriteria

                self.data_selector = EnhancedDataSelector(
                    criteria=SelectionCriteria(
                        max_years=self.hybrid_config.max_years,
                        min_pr=self.hybrid_config.min_pr,
                        min_irradiance=self.hybrid_config.min_irradiance,
                        ensure_seasonal_balance=self.hybrid_config.ensure_seasonal_balance,
                    ),
                    apply_normal_filter=True,
                )
                logger.info("Using enhanced data selector with normal data filtering")
            except ImportError:
                logger.warning("Enhanced selector not available, using standard")

    def _create_single_twin(
        self,
        df: pd.DataFrame,
        inverter_col: str,
        irradiance_col: str,
    ) -> InverterResult:
        """Create hybrid digital twin for single inverter."""
        import time
        start_time = time.time()

        inv_id, group_id = extract_inverter_id(inverter_col)
        result = InverterResult(inverter_id=inv_id, group_id=group_id)

        try:
            # Try to import hybrid model
            from .hybrid_model import HybridPhysicsMLModel, create_hybrid_model
            from .feature_engineering import create_physics_engineer
            from .physics_model import create_physics_model

            # Estimate capacity from data
            max_power = df[inverter_col].max()
            estimated_capacity = max_power / 0.85 if max_power > 0 else 100.0

            # Update data selector with capacity
            self.data_selector.nominal_power_kw = estimated_capacity

            # Select training data (with enhanced filtering if enabled)
            ambient_col = self.column_mapping.get("ambient_temp_column")
            selection = self.data_selector.select_training_data(
                df=df,
                power_col=inverter_col,
                irradiance_col=irradiance_col,
                temperature_col=ambient_col,
            )

            if selection.n_samples < self.config.min_training_samples:
                result.error_message = f"Insufficient data: {selection.n_samples} samples"
                result.training_samples = selection.n_samples
                return result

            result.training_samples = selection.n_samples
            result.training_period = selection.date_range

            # Capture training timestamps
            if hasattr(selection.df.index, 'strftime'):
                result.training_timestamps = selection.df.index.strftime('%Y-%m-%d %H:%M:%S').tolist()

            # Prepare training data
            train_df = selection.df.copy()

            # Map columns
            train_df['irradiance'] = df.loc[train_df.index, irradiance_col]
            train_df['power'] = df.loc[train_df.index, inverter_col]

            if ambient_col and ambient_col in df.columns:
                train_df['temperature'] = df.loc[train_df.index, ambient_col]
            else:
                train_df['temperature'] = 25.0  # Default

            # Create hybrid model
            model = create_hybrid_model(
                inverter_id=inv_id,
                capacity_kw=estimated_capacity,
                latitude=self.hybrid_config.latitude,
                longitude=self.hybrid_config.longitude,
                tilt=self.hybrid_config.tilt,
                azimuth=self.hybrid_config.azimuth,
                use_catboost=self.hybrid_config.use_catboost,
            )

            # Train hybrid model
            metrics = model.train(
                train_df,
                power_col='power',
                irradiance_col='irradiance',
                temperature_col='temperature',
            )

            # Convert metrics to ModelMetrics for compatibility
            result.metrics = ModelMetrics(
                r2=metrics.r2,
                mae=metrics.mae,
                rmse=metrics.rmse,
                mape=metrics.mape,
                training_samples=metrics.training_samples,
                validation_samples=metrics.validation_samples,
                training_time_s=metrics.training_time_s,
            )

            # Validate model quality
            if metrics.r2 < self.config.min_r2:
                result.error_message = f"R² too low: {metrics.r2:.3f} < {self.config.min_r2}"
                result.success = False
            elif metrics.mae > self.config.max_mae_kw:
                result.error_message = f"MAE too high: {metrics.mae:.1f} > {self.config.max_mae_kw}"
                result.success = False
            else:
                result.success = True

                # Save model if successful
                if self.config.save_models:
                    model_path = self.output_dir / "models" / f"{inv_id.replace(' ', '_')}_hybrid.pkl"
                    model_path.parent.mkdir(exist_ok=True)
                    model.save(str(model_path))

                # Store model reference (using model attribute for compatibility)
                result.model = model  # type: ignore

            logger.info(
                f"{inv_id}: R²={metrics.r2:.4f}, MAE={metrics.mae:.2f} kW "
                f"(physics improvement: {100*metrics.improvement_over_physics:.1f}%)"
            )

        except ImportError as e:
            logger.warning(f"Hybrid model not available, falling back to standard: {e}")
            return super()._create_single_twin(df, inverter_col, irradiance_col)

        except Exception as e:
            result.error_message = str(e)
            logger.error(f"Failed to create hybrid twin for {inv_id}: {e}")

        result.processing_time_s = time.time() - start_time
        return result

    def _export_json(self) -> None:
        """Export results with hybrid model information."""
        # Call parent export
        super()._export_json()

        # Add hybrid-specific summary
        hybrid_summary = {
            "modelType": "Hybrid (Physics + ML)",
            "physicsModel": "PVWatts",
            "mlModel": "CatBoost" if self.hybrid_config.use_catboost else "LightGBM",
            "physicsParams": {
                "latitude": self.hybrid_config.latitude,
                "longitude": self.hybrid_config.longitude,
                "tilt": self.hybrid_config.tilt,
                "azimuth": self.hybrid_config.azimuth,
                "gamma_pdc": self.hybrid_config.gamma_pdc,
            },
            "enhancedSelection": self.hybrid_config.use_enhanced_selection,
        }

        # Update summary file
        summary_path = self.output_dir / "digital_twins_summary.json"
        with open(summary_path, "r") as f:
            summary = json.load(f)

        summary["hybridConfig"] = hybrid_summary

        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2)


def create_hybrid_factory(
    output_dir: str = "public/data/digital_twins",
    latitude: float = 0.0,
    longitude: float = 0.0,
    tilt: float = 0.0,
    azimuth: float = 180.0,
    max_years: float = 3.0,
    use_catboost: bool = True,
) -> HybridDigitalTwinFactory:
    """
    Create a hybrid digital twin factory with sensible defaults.

    Parameters:
    -----------
    output_dir : str
        Output directory for models and JSON
    latitude, longitude : float
        Plant location
    tilt, azimuth : float
        Array orientation
    max_years : float
        Training data period
    use_catboost : bool
        Use CatBoost (vs LightGBM)

    Returns:
    --------
    HybridDigitalTwinFactory
        Configured factory
    """
    config = HybridFactoryConfig(
        latitude=latitude,
        longitude=longitude,
        tilt=tilt,
        azimuth=azimuth,
        max_years=max_years,
        use_catboost=use_catboost,
    )

    return HybridDigitalTwinFactory(config=config, output_dir=output_dir)
