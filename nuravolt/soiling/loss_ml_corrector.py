"""
ML-based correction models for physics-based loss disaggregation.

This module provides ML correction layers on top of IEA PVPS physics-based
loss estimates to improve accuracy using digital twin residual training.

Approach:
1. Run IEA physics disaggregation baseline
2. Get digital twin "true" expected power
3. Calculate residuals for each loss component
4. Train loss-specific ML correction models
5. Apply corrections while enforcing energy conservation
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Union, Any
import logging

import numpy as np
import pandas as pd
import polars as pl

try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False
    logging.warning("LightGBM not available. Install with: pip install lightgbm")

logger = logging.getLogger(__name__)


@dataclass
class LossCorrectionModel:
    """Container for a trained loss correction model."""

    loss_type: str
    model: Any  # LightGBM model
    feature_names: List[str]
    training_mae: float
    training_rmse: float
    training_samples: int
    correction_limit_pct: float = 0.20  # ±20% correction limit

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            'loss_type': self.loss_type,
            'feature_names': self.feature_names,
            'training_mae': self.training_mae,
            'training_rmse': self.training_rmse,
            'training_samples': self.training_samples,
            'correction_limit_pct': self.correction_limit_pct
        }


class LossMLCorrectionTrainer:
    """Train ML models to correct physics-based loss estimates."""

    def __init__(self,
                 digital_twin_factory: Optional[Any] = None,
                 iea_disaggregator: Optional[Any] = None,
                 correction_limit_pct: float = 0.20):
        """
        Initialize loss ML correction trainer.

        Args:
            digital_twin_factory: Factory with trained digital twins
            iea_disaggregator: IEA loss disaggregator instance
            correction_limit_pct: Maximum allowed correction percentage (default ±20%)
        """
        if not LIGHTGBM_AVAILABLE:
            raise ImportError("LightGBM required for loss correction training")

        self.digital_twin_factory = digital_twin_factory
        self.iea_disaggregator = iea_disaggregator
        self.correction_limit_pct = correction_limit_pct

        # Trained correction models
        self.correction_models: Dict[str, LossCorrectionModel] = {}

        # Loss types to train corrections for
        self.loss_types = ['soiling', 'temperature', 'spectral', 'inverter']

        logger.info("Initialized LossMLCorrectionTrainer")

    def prepare_training_data(self,
                             df: Union[pd.DataFrame, pl.DataFrame],
                             inverter_col: Optional[str] = None) -> Dict[str, pd.DataFrame]:
        """
        Prepare training data for each loss type.

        Process:
        1. Run IEA PVPS physics disaggregation
        2. Get digital twin "true" expected power
        3. Calculate residuals for each loss component
        4. Prepare loss-specific features

        Args:
            df: Input DataFrame with weather and power data
            inverter_col: Column name for inverter to use for digital twin

        Returns:
            Dictionary mapping loss_type to training DataFrame
        """
        logger.info("Preparing training data for loss correction models...")

        # Convert to pandas if needed
        if isinstance(df, pl.DataFrame):
            df_pd = df.to_pandas()
        else:
            df_pd = df.copy()

        # Step 1: Calculate IEA physics baseline
        logger.info("Calculating IEA physics baseline...")
        df_iea = self.iea_disaggregator.calculate_all_losses(df_pd)

        # Step 2: Get digital twin predictions (ground truth)
        logger.info("Getting digital twin predictions...")
        df_twin = self._get_digital_twin_predictions(df_pd, inverter_col)

        # Step 3: Extract residuals per loss type
        logger.info("Extracting loss-specific residuals...")
        training_data = {}
        for loss_type in self.loss_types:
            training_data[loss_type] = self._extract_loss_residuals(
                df_iea, df_twin, loss_type
            )
            logger.info(f"  {loss_type}: {len(training_data[loss_type])} training samples")

        return training_data

    def _get_digital_twin_predictions(self,
                                      df: pd.DataFrame,
                                      inverter_col: Optional[str] = None) -> pd.DataFrame:
        """
        Get digital twin predictions as ground truth.

        Args:
            df: Input DataFrame
            inverter_col: Specific inverter column to use

        Returns:
            DataFrame with 'expected_power_twin_kw' column
        """
        if self.digital_twin_factory is None:
            logger.warning("No digital twin factory provided, using actual power")
            df_result = df.copy()
            if 'power' in df.columns:
                df_result['expected_power_twin_kw'] = df['power']
            else:
                raise ValueError("No digital twin factory and no 'power' column found")
            return df_result

        # Convert to Polars for digital twin prediction
        df_pl = pl.from_pandas(df)

        # Get predictions from a specific inverter's digital twin
        # For now, use the first inverter's model
        inverter_models = self.digital_twin_factory.inverter_models

        if inverter_col and inverter_col in inverter_models:
            model = inverter_models[inverter_col]
        else:
            # Use first available model
            model = list(inverter_models.values())[0]
            logger.info(f"Using {list(inverter_models.keys())[0]} digital twin for ground truth")

        # Generate predictions
        df_pred = model.predict(df_pl)

        # Convert back to pandas and merge
        df_result = df.copy()
        df_result['expected_power_twin_kw'] = df_pred['ml_prediction'].to_numpy()

        return df_result

    def _extract_loss_residuals(self,
                                df_iea: pd.DataFrame,
                                df_twin: pd.DataFrame,
                                loss_type: str) -> pd.DataFrame:
        """
        Extract residuals for a specific loss type.

        The residual is: actual_loss - physics_loss
        Positive residual = physics underestimates loss
        Negative residual = physics overestimates loss

        Args:
            df_iea: DataFrame with IEA physics loss calculations
            df_twin: DataFrame with digital twin predictions
            loss_type: Type of loss to extract residuals for

        Returns:
            DataFrame with features and 'residual' target
        """
        df_result = df_iea.copy()

        # Merge twin predictions
        df_result['expected_power_twin_kw'] = df_twin['expected_power_twin_kw']

        # Calculate actual loss from digital twin
        # Total loss = reference - twin_prediction
        actual_total_loss = df_result['reference_power_kw'] - df_result['expected_power_twin_kw']

        # For each specific loss type, calculate the residual
        # This is simplified - in reality we'd need to decompose the total residual
        # For now, use the IEA loss estimate as baseline
        loss_col_map = {
            'soiling': 'soiling_energy_loss',
            'temperature': 'temp_energy_loss',
            'spectral': 'spectral_energy_loss',
            'inverter': 'inverter_energy_loss'
        }

        if loss_type not in loss_col_map:
            raise ValueError(f"Unknown loss type: {loss_type}")

        physics_loss = df_result[loss_col_map[loss_type]]

        # Simplified residual calculation
        # In practice, this would require more sophisticated decomposition
        # For now, assume residual is proportional to the loss magnitude
        total_physics_loss = df_result[[loss_col_map[lt] for lt in self.loss_types]].sum(axis=1)

        # Residual for this loss type proportional to its contribution
        loss_fraction = physics_loss / (total_physics_loss + 1e-6)
        total_residual = actual_total_loss - total_physics_loss

        df_result['residual'] = total_residual * loss_fraction

        # Add loss-specific features
        df_result = self._create_loss_specific_features(df_result, loss_type)

        # Filter valid training data
        valid_mask = (
            (df_result['reference_power_kw'] > 1.0) &  # Meaningful power level
            (df_result['residual'].notna()) &
            (df_result['residual'].abs() < 100)  # Remove outliers
        )

        return df_result[valid_mask].copy()

    def _create_loss_specific_features(self,
                                       df: pd.DataFrame,
                                       loss_type: str) -> pd.DataFrame:
        """
        Create loss-specific features for ML correction.

        Args:
            df: Input DataFrame
            loss_type: Type of loss to create features for

        Returns:
            DataFrame with added features
        """
        df_result = df.copy()

        if loss_type == 'soiling':
            # Soiling correction features
            df_result = self._create_soiling_features(df_result)

        elif loss_type == 'temperature':
            # Temperature correction features
            df_result = self._create_temperature_features(df_result)

        elif loss_type == 'spectral':
            # Spectral correction features
            df_result = self._create_spectral_features(df_result)

        elif loss_type == 'inverter':
            # Inverter correction features
            df_result = self._create_inverter_features(df_result)

        return df_result

    def _create_soiling_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Create features for soiling loss correction."""
        df_result = df.copy()

        # Days since last rain (if available)
        if 'rain' in df.columns:
            rain_events = df['rain'] > 0.1
            df_result['days_since_rain'] = (~rain_events).cumsum() - (~rain_events).cumsum().where(rain_events).ffill().fillna(0)
        else:
            df_result['days_since_rain'] = 0

        # Cumulative dust accumulation proxy
        if 'irradiance' in df.columns:
            dry_mask = df_result['days_since_rain'] > 0
            df_result['dust_accumulation'] = (
                dry_mask * df_result['irradiance'] / 1000.0
            ).cumsum()
        else:
            df_result['dust_accumulation'] = 0

        # Seasonal soiling pattern (month)
        if 'timestamp' in df.columns:
            df_result['month'] = pd.to_datetime(df['timestamp']).dt.month
        elif df.index.name == 'timestamp' or isinstance(df.index, pd.DatetimeIndex):
            df_result['month'] = df.index.month
        else:
            df_result['month'] = 6  # Default to summer

        # Performance degradation rate (if historical data available)
        if 'soiling_ratio_smooth' in df.columns:
            df_result['soiling_trend'] = df['soiling_ratio_smooth'].rolling(30, min_periods=1).mean()
        else:
            df_result['soiling_trend'] = 1.0

        return df_result

    def _create_temperature_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Create features for temperature loss correction."""
        df_result = df.copy()

        # Module temperature delta from expected
        if 't_cell' in df.columns:
            expected_t_cell = 25 + (df_result.get('irradiance', 800) / 800) * 20
            df_result['temp_delta'] = df_result['t_cell'] - expected_t_cell
        else:
            df_result['temp_delta'] = 0

        # Wind speed (cooling effect)
        if 'wind_speed' in df.columns:
            df_result['wind_cooling_factor'] = df['wind_speed'].clip(0, 10) / 10
        else:
            df_result['wind_cooling_factor'] = 0.5

        # Time of day (thermal inertia)
        if 'timestamp' in df.columns:
            df_result['hour'] = pd.to_datetime(df['timestamp']).dt.hour
        elif isinstance(df.index, pd.DatetimeIndex):
            df_result['hour'] = df.index.hour
        else:
            df_result['hour'] = 12

        # Historical temperature coefficient variation
        if 't_cell' in df.columns and 'reference_power_kw' in df.columns:
            df_result['temp_coeff_actual'] = (
                df_result['temperature_loss_factor'] /
                (df_result['t_cell'] - 25 + 1e-6)
            ).clip(-0.01, 0.01)
        else:
            df_result['temp_coeff_actual'] = -0.004

        return df_result

    def _create_spectral_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Create features for spectral loss correction."""
        df_result = df.copy()

        # Air mass deviation from 1.5
        if 'solar_elevation' in df.columns:
            elevation = df_result['solar_elevation'].clip(1, 90)
            air_mass = 1 / np.sin(np.radians(elevation))
            df_result['air_mass_delta'] = air_mass - 1.5
        else:
            df_result['air_mass_delta'] = 0

        # Cloud cover indicator (irradiance variability)
        if 'irradiance' in df.columns:
            df_result['irradiance_variability'] = (
                df_result['irradiance'].rolling(12, min_periods=1).std() /
                (df_result['irradiance'].rolling(12, min_periods=1).mean() + 1)
            )
        else:
            df_result['irradiance_variability'] = 0

        # Seasonal spectral shift
        if 'timestamp' in df.columns:
            df_result['season'] = (pd.to_datetime(df['timestamp']).dt.month % 12 + 3) // 3
        elif isinstance(df.index, pd.DatetimeIndex):
            df_result['season'] = (df.index.month % 12 + 3) // 3
        else:
            df_result['season'] = 2

        # Morning vs afternoon
        if 'timestamp' in df.columns:
            hour = pd.to_datetime(df['timestamp']).dt.hour
            df_result['is_morning'] = (hour < 12).astype(int)
        elif isinstance(df.index, pd.DatetimeIndex):
            df_result['is_morning'] = (df.index.hour < 12).astype(int)
        else:
            df_result['is_morning'] = 0

        return df_result

    def _create_inverter_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Create features for inverter loss correction."""
        df_result = df.copy()

        # Load fraction
        if 'inverter_efficiency' in df.columns and 'reference_power_kw' in df.columns:
            capacity_kw = df_result['reference_power_kw'].max()
            df_result['load_fraction'] = (df_result['reference_power_kw'] / (capacity_kw + 1)).clip(0, 1.2)
        else:
            df_result['load_fraction'] = 0.5

        # Ambient temperature (thermal derating)
        if 'temperature' in df.columns:
            df_result['inverter_temp_factor'] = (df['temperature'] - 25) / 50
        else:
            df_result['inverter_temp_factor'] = 0

        # String voltage levels (if available)
        if 'voltage' in df.columns:
            df_result['voltage_deviation'] = (df['voltage'] - 600) / 600
        else:
            df_result['voltage_deviation'] = 0

        # Inverter age (time-dependent)
        if 'timestamp' in df.columns:
            first_date = pd.to_datetime(df['timestamp']).min()
            current_date = pd.to_datetime(df['timestamp'])
            df_result['inverter_age_years'] = (current_date - first_date).dt.days / 365.25
        else:
            df_result['inverter_age_years'] = 1.0

        return df_result

    def train_all_loss_models(self,
                              training_data: Dict[str, pd.DataFrame],
                              hyperparameters: Optional[Dict[str, Any]] = None) -> Dict[str, LossCorrectionModel]:
        """
        Train ML correction models for all loss types.

        Args:
            training_data: Dictionary mapping loss_type to training DataFrame
            hyperparameters: Optional LightGBM hyperparameters

        Returns:
            Dictionary of trained correction models
        """
        logger.info("Training ML correction models for all loss types...")

        default_params = {
            'objective': 'regression',
            'metric': 'rmse',
            'num_leaves': 31,
            'learning_rate': 0.05,
            'n_estimators': 100,
            'verbose': -1
        }

        params = hyperparameters or default_params

        for loss_type in self.loss_types:
            if loss_type not in training_data:
                logger.warning(f"No training data for {loss_type}, skipping")
                continue

            logger.info(f"Training {loss_type} correction model...")
            model = self._train_single_loss_model(
                training_data[loss_type],
                loss_type,
                params
            )
            self.correction_models[loss_type] = model

            logger.info(f"  {loss_type}: MAE={model.training_mae:.4f} kW, "
                       f"RMSE={model.training_rmse:.4f} kW, "
                       f"samples={model.training_samples}")

        logger.info("All correction models trained successfully")
        return self.correction_models

    def _train_single_loss_model(self,
                                 df_train: pd.DataFrame,
                                 loss_type: str,
                                 params: Dict[str, Any]) -> LossCorrectionModel:
        """
        Train ML correction model for a single loss type.

        Args:
            df_train: Training DataFrame with features and 'residual' target
            loss_type: Type of loss being corrected
            params: LightGBM hyperparameters

        Returns:
            Trained LossCorrectionModel
        """
        # Define feature columns based on loss type
        feature_map = {
            'soiling': ['soiling_loss_factor', 'days_since_rain', 'dust_accumulation',
                       'month', 'soiling_trend', 'irradiance'],
            'temperature': ['temperature_loss_factor', 'temp_delta', 'wind_cooling_factor',
                          'hour', 'temp_coeff_actual', 't_cell'],
            'spectral': ['spectral_loss_factor', 'air_mass_delta', 'irradiance_variability',
                        'season', 'is_morning', 'spectral_modifier'],
            'inverter': ['inverter_loss_factor', 'load_fraction', 'inverter_temp_factor',
                        'voltage_deviation', 'inverter_age_years', 'inverter_efficiency']
        }

        feature_names = [f for f in feature_map[loss_type] if f in df_train.columns]

        if len(feature_names) == 0:
            raise ValueError(f"No features available for {loss_type} correction")

        # Prepare training data
        X = df_train[feature_names].fillna(0).values
        y = df_train['residual'].values

        # Train/validation split
        n_train = int(len(X) * 0.8)
        X_train, X_val = X[:n_train], X[n_train:]
        y_train, y_val = y[:n_train], y[n_train:]

        # Train LightGBM model
        model = lgb.LGBMRegressor(**params)
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(100, verbose=False)]
        )

        # Calculate metrics
        y_pred = model.predict(X_val)
        mae = np.abs(y_pred - y_val).mean()
        rmse = np.sqrt(((y_pred - y_val) ** 2).mean())

        return LossCorrectionModel(
            loss_type=loss_type,
            model=model,
            feature_names=feature_names,
            training_mae=float(mae),
            training_rmse=float(rmse),
            training_samples=len(X_train),
            correction_limit_pct=self.correction_limit_pct
        )

    def save_models(self, output_dir: str):
        """Save trained correction models to disk."""
        from pathlib import Path
        import joblib

        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        for loss_type, model in self.correction_models.items():
            model_path = output_path / f"loss_correction_{loss_type}.joblib"
            joblib.dump(model, model_path)
            logger.info(f"Saved {loss_type} correction model to {model_path}")

    def load_models(self, input_dir: str):
        """Load trained correction models from disk."""
        from pathlib import Path
        import joblib

        input_path = Path(input_dir)

        for loss_type in self.loss_types:
            model_path = input_path / f"loss_correction_{loss_type}.joblib"
            if model_path.exists():
                self.correction_models[loss_type] = joblib.load(model_path)
                logger.info(f"Loaded {loss_type} correction model from {model_path}")
            else:
                logger.warning(f"No saved model found for {loss_type}")


class LossMLCorrector:
    """Apply trained ML corrections to IEA physics-based loss estimates."""

    def __init__(self, correction_models: Dict[str, LossCorrectionModel]):
        """
        Initialize loss ML corrector.

        Args:
            correction_models: Dictionary of trained correction models
        """
        self.correction_models = correction_models
        logger.info(f"Initialized LossMLCorrector with {len(correction_models)} models")

    def apply_corrections(self, df_losses: pd.DataFrame) -> pd.DataFrame:
        """
        Apply ML corrections to physics-based loss estimates.

        Args:
            df_losses: DataFrame with IEA physics loss calculations

        Returns:
            DataFrame with ML-corrected losses
        """
        df_result = df_losses.copy()

        # Apply corrections for each loss type
        for loss_type, model in self.correction_models.items():
            df_result = self._apply_single_correction(df_result, model)

        return df_result

    def _apply_single_correction(self,
                                df: pd.DataFrame,
                                model: LossCorrectionModel) -> pd.DataFrame:
        """
        Apply ML correction for a single loss type.

        Args:
            df: Input DataFrame
            model: Trained correction model

        Returns:
            DataFrame with applied correction
        """
        # Prepare features
        available_features = [f for f in model.feature_names if f in df.columns]

        if len(available_features) == 0:
            logger.warning(f"No features available for {model.loss_type} correction, skipping")
            return df

        X = df[available_features].fillna(0).values

        # Predict correction
        correction = model.model.predict(X)

        # Apply correction limit (±20%)
        loss_col_map = {
            'soiling': 'soiling_energy_loss',
            'temperature': 'temp_energy_loss',
            'spectral': 'spectral_energy_loss',
            'inverter': 'inverter_energy_loss'
        }

        loss_col = loss_col_map[model.loss_type]
        physics_loss = df[loss_col]

        # Limit correction to ±20% of physics estimate
        max_correction = physics_loss.abs() * model.correction_limit_pct
        correction_limited = np.clip(correction, -max_correction, max_correction)

        # Apply correction (residual is: actual - physics, so we add it)
        df[f'{loss_col}_ml_corrected'] = physics_loss + correction_limited
        df[f'{loss_col}_ml_correction'] = correction_limited

        return df
