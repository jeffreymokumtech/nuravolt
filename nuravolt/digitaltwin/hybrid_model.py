"""
Hybrid Physics-ML Model for Solar PV Digital Twins

Combines physics-based predictions with ML residual learning:
    P_expected = P_physics + f_ML(features)

The physics model provides:
- Baseline prediction from solar physics
- Generalization to new plants immediately
- Interpretability of predictions

The ML model learns:
- Site-specific deviations from physics
- Soiling baseline
- Local shading patterns
- Inverter-specific characteristics

This architecture is more robust than pure ML because:
1. Physics model generalizes to new conditions
2. ML only learns the smaller residual (easier problem)
3. More robust to distribution shift in weather
4. Interpretable: can see if physics or ML is wrong
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple, Union
from pathlib import Path
import logging
import pickle
import json
import time
from datetime import datetime

import numpy as np
import pandas as pd

from .physics_model import PVWattsPhysicsModel, SystemParams, create_physics_model
from .feature_engineering import (
    PhysicsFeatureEngineer,
    LocationParams,
    ModuleParams,
    create_physics_engineer,
)

logger = logging.getLogger(__name__)

# Try importing CatBoost/LightGBM
try:
    from catboost import CatBoostRegressor, Pool
    CATBOOST_AVAILABLE = True
except ImportError:
    CATBOOST_AVAILABLE = False

try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False


@dataclass
class HybridModelMetrics:
    """Metrics for hybrid model evaluation."""
    # Overall metrics
    r2: float = 0.0
    mae: float = 0.0
    rmse: float = 0.0
    mape: float = 0.0

    # Component metrics
    physics_r2: float = 0.0
    physics_mae: float = 0.0
    ml_r2: float = 0.0
    ml_mae: float = 0.0

    # Training info
    training_samples: int = 0
    validation_samples: int = 0
    training_time_s: float = 0.0
    calibration_factor: float = 1.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            'r2': round(self.r2, 4),
            'mae_kW': round(self.mae, 2),
            'rmse_kW': round(self.rmse, 2),
            'mape_pct': round(self.mape * 100, 2),
            'physics_r2': round(self.physics_r2, 4),
            'physics_mae_kW': round(self.physics_mae, 2),
            'ml_r2': round(self.ml_r2, 4),
            'ml_mae_kW': round(self.ml_mae, 2),
            'trainingSamples': self.training_samples,
            'validationSamples': self.validation_samples,
            'trainingTime_s': round(self.training_time_s, 2),
            'calibrationFactor': round(self.calibration_factor, 4),
        }

    @property
    def improvement_over_physics(self) -> float:
        """Calculate improvement over physics-only model."""
        if self.physics_mae > 0:
            return (self.physics_mae - self.mae) / self.physics_mae
        return 0.0


@dataclass
class HybridModelConfig:
    """Configuration for hybrid model training."""
    # Model selection
    use_catboost: bool = True               # Use CatBoost (fallback to LightGBM)

    # CatBoost parameters
    catboost_params: Dict[str, Any] = field(default_factory=lambda: {
        'iterations': 1000,
        'learning_rate': 0.05,
        'depth': 6,
        'l2_leaf_reg': 3,
        'random_seed': 42,
        'early_stopping_rounds': 100,
        'verbose': False,
        'loss_function': 'RMSE',
    })

    # LightGBM parameters
    lightgbm_params: Dict[str, Any] = field(default_factory=lambda: {
        'objective': 'regression',
        'metric': 'rmse',
        'learning_rate': 0.05,
        'num_leaves': 31,
        'max_depth': 6,
        'n_estimators': 1000,
        'early_stopping_rounds': 100,
        'verbose': -1,
        'random_state': 42,
    })

    # Training parameters
    validation_split: float = 0.2           # Validation fraction
    min_training_samples: int = 100         # Minimum samples required

    # Physics model calibration
    calibrate_physics: bool = True          # Calibrate physics to data
    min_calibration_irradiance: float = 200.0
    max_calibration_irradiance: float = 1000.0


class HybridPhysicsMLModel:
    """
    Hybrid model combining physics and ML for power prediction.

    Architecture:
        P_expected = P_physics + Δ_ML

    The physics model (PVWatts) provides baseline predictions.
    The ML model (CatBoost/LightGBM) learns residual corrections.
    """

    def __init__(
        self,
        inverter_id: str,
        physics_model: Optional[PVWattsPhysicsModel] = None,
        feature_engineer: Optional[PhysicsFeatureEngineer] = None,
        config: Optional[HybridModelConfig] = None,
    ):
        """
        Initialize hybrid model.

        Parameters:
        -----------
        inverter_id : str
            Unique identifier for this inverter
        physics_model : PVWattsPhysicsModel
            Physics model instance (created if None)
        feature_engineer : PhysicsFeatureEngineer
            Feature engineer instance (created if None)
        config : HybridModelConfig
            Model configuration
        """
        self.inverter_id = inverter_id
        self.config = config or HybridModelConfig()

        # Physics model
        self.physics_model = physics_model or PVWattsPhysicsModel()

        # Feature engineer
        self.feature_engineer = feature_engineer or PhysicsFeatureEngineer()

        # Initialize ML model
        self._init_ml_model()

        # State
        self.is_trained = False
        self.metrics = HybridModelMetrics()
        self.feature_columns: List[str] = []
        self.feature_importance: Dict[str, float] = {}
        self.training_period: Optional[Tuple[str, str]] = None
        self.created_at: str = datetime.now().isoformat()

    def _init_ml_model(self) -> None:
        """Initialize the ML model for residual learning."""
        use_catboost = self.config.use_catboost and CATBOOST_AVAILABLE

        if use_catboost:
            self.ml_model = CatBoostRegressor(**self.config.catboost_params)
            self.ml_type = 'CatBoost'
        elif LIGHTGBM_AVAILABLE:
            self.ml_model = lgb.LGBMRegressor(**self.config.lightgbm_params)
            self.ml_type = 'LightGBM'
        else:
            raise ImportError("Neither CatBoost nor LightGBM available")

        logger.info(f"Initialized {self.ml_type} for residual learning")

    def train(
        self,
        df: pd.DataFrame,
        power_col: str = 'power',
        irradiance_col: str = 'irradiance',
        temperature_col: str = 'temperature',
        wind_col: Optional[str] = 'wind_speed',
    ) -> HybridModelMetrics:
        """
        Train the hybrid model.

        Steps:
        1. Generate physics features (NO power lags)
        2. Calculate physics model predictions
        3. Calibrate physics model to data
        4. Calculate residuals: actual - physics
        5. Train ML model on residuals

        Parameters:
        -----------
        df : pd.DataFrame
            Training data with datetime index
        power_col : str
            Target power column name
        irradiance_col : str
            Irradiance column name
        temperature_col : str
            Temperature column name
        wind_col : str
            Wind speed column name (optional)

        Returns:
        --------
        HybridModelMetrics
            Training metrics
        """
        start_time = time.time()

        logger.info(f"Training hybrid model for {self.inverter_id} with {len(df)} samples")

        # Validate input
        if len(df) < self.config.min_training_samples:
            raise ValueError(f"Insufficient training data: {len(df)} < {self.config.min_training_samples}")

        if power_col not in df.columns:
            raise ValueError(f"Power column '{power_col}' not found")

        df = df.copy()

        # Step 1: Generate physics features
        logger.info("Generating physics features...")
        df = self.feature_engineer.generate_all_features(
            df,
            irradiance_col=irradiance_col,
            temperature_col=temperature_col,
            wind_col=wind_col,
        )

        # Step 2: Get physics predictions
        logger.info("Calculating physics predictions...")
        p_physics = self.physics_model.predict(
            df,
            irradiance_col=irradiance_col,
            temperature_col=temperature_col,
            wind_col=wind_col,
        )
        df['p_physics'] = p_physics

        # Step 3: Calibrate physics model
        if self.config.calibrate_physics:
            logger.info("Calibrating physics model...")
            self.physics_model.calibrate(
                df,
                power_col=power_col,
                irradiance_col=irradiance_col,
                temperature_col=temperature_col,
                min_irradiance=self.config.min_calibration_irradiance,
                max_irradiance=self.config.max_calibration_irradiance,
            )

            # Recalculate with calibration
            p_physics = self.physics_model.predict(
                df,
                irradiance_col=irradiance_col,
                temperature_col=temperature_col,
                wind_col=wind_col,
            )
            df['p_physics'] = p_physics

        # Step 4: Calculate residuals
        y = df[power_col].values
        residuals = y - p_physics
        df['residual'] = residuals

        # Step 5: Prepare features for ML
        X, self.feature_columns = self.feature_engineer.get_ml_ready_features(
            df, irradiance_col
        )

        # Add physics prediction as feature for ML (optional, helps with calibration)
        # X['p_physics'] = p_physics
        # self.feature_columns.append('p_physics')

        # Handle NaN values
        valid_mask = ~(X.isna().any(axis=1) | np.isnan(residuals))
        X_clean = X[valid_mask]
        residuals_clean = residuals[valid_mask]
        y_clean = y[valid_mask]
        p_physics_clean = p_physics[valid_mask]

        logger.info(f"Training with {len(X_clean)} valid samples")

        # Train/validation split (temporal)
        split_idx = int(len(X_clean) * (1 - self.config.validation_split))
        X_train = X_clean.iloc[:split_idx]
        X_val = X_clean.iloc[split_idx:]
        residuals_train = residuals_clean[:split_idx]
        residuals_val = residuals_clean[split_idx:]
        y_val = y_clean[split_idx:]
        p_physics_val = p_physics_clean[split_idx:]

        # Train ML model on residuals
        logger.info(f"Training {self.ml_type} on residuals...")
        if self.ml_type == 'CatBoost':
            train_pool = Pool(X_train, residuals_train)
            val_pool = Pool(X_val, residuals_val)
            self.ml_model.fit(train_pool, eval_set=val_pool, use_best_model=True)
        else:
            self.ml_model.fit(
                X_train, residuals_train,
                eval_set=[(X_val, residuals_val)],
            )

        # Get feature importance
        if self.ml_type == 'CatBoost':
            importances = self.ml_model.get_feature_importance()
        else:
            importances = self.ml_model.feature_importances_

        self.feature_importance = dict(zip(self.feature_columns, importances))

        # Calculate metrics
        self.metrics = self._calculate_metrics(
            X_val, residuals_val, y_val, p_physics_val,
            len(X_train), len(X_val),
            time.time() - start_time
        )

        # Store training period
        if isinstance(df.index, pd.DatetimeIndex):
            self.training_period = (
                str(df.index.min())[:10],
                str(df.index.max())[:10]
            )

        self.is_trained = True

        logger.info(
            f"Training complete: R²={self.metrics.r2:.4f}, MAE={self.metrics.mae:.2f} kW "
            f"(improvement over physics: {100*self.metrics.improvement_over_physics:.1f}%)"
        )

        return self.metrics

    def _calculate_metrics(
        self,
        X_val: pd.DataFrame,
        residuals_val: np.ndarray,
        y_val: np.ndarray,
        p_physics_val: np.ndarray,
        n_train: int,
        n_val: int,
        training_time: float,
    ) -> HybridModelMetrics:
        """Calculate comprehensive metrics."""
        # ML predictions (residual)
        delta_ml = self.ml_model.predict(X_val)

        # Hybrid predictions
        y_pred = p_physics_val + delta_ml

        # Clip to non-negative
        y_pred = np.maximum(y_pred, 0)

        # Overall metrics
        ss_res = np.sum((y_val - y_pred) ** 2)
        ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        mae = np.mean(np.abs(y_val - y_pred))
        rmse = np.sqrt(np.mean((y_val - y_pred) ** 2))

        # MAPE (excluding near-zero)
        mask = np.abs(y_val) > 0.01
        if mask.any():
            mape = np.mean(np.abs((y_val[mask] - y_pred[mask]) / y_val[mask]))
        else:
            mape = 0.0

        # Physics-only metrics
        ss_res_phys = np.sum((y_val - p_physics_val) ** 2)
        physics_r2 = 1 - (ss_res_phys / ss_tot) if ss_tot > 0 else 0
        physics_mae = np.mean(np.abs(y_val - p_physics_val))

        # ML residual metrics
        ss_res_ml = np.sum((residuals_val - delta_ml) ** 2)
        ss_tot_ml = np.sum((residuals_val - np.mean(residuals_val)) ** 2)
        ml_r2 = 1 - (ss_res_ml / ss_tot_ml) if ss_tot_ml > 0 else 0
        ml_mae = np.mean(np.abs(residuals_val - delta_ml))

        return HybridModelMetrics(
            r2=r2,
            mae=mae,
            rmse=rmse,
            mape=mape,
            physics_r2=physics_r2,
            physics_mae=physics_mae,
            ml_r2=ml_r2,
            ml_mae=ml_mae,
            training_samples=n_train,
            validation_samples=n_val,
            training_time_s=training_time,
            calibration_factor=self.physics_model.calibration_factor,
        )

    def predict(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
        temperature_col: str = 'temperature',
        wind_col: Optional[str] = 'wind_speed',
        return_components: bool = False,
    ) -> Union[np.ndarray, Dict[str, np.ndarray]]:
        """
        Predict expected power.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        irradiance_col : str
            Irradiance column name
        temperature_col : str
            Temperature column name
        wind_col : str
            Wind speed column name
        return_components : bool
            If True, return dict with physics and ML components

        Returns:
        --------
        np.ndarray or Dict
            Predicted power (kW), or dict with components
        """
        if not self.is_trained:
            raise ValueError("Model not trained. Call train() first.")

        df = df.copy()

        # Generate features
        df = self.feature_engineer.generate_all_features(
            df,
            irradiance_col=irradiance_col,
            temperature_col=temperature_col,
            wind_col=wind_col,
        )

        # Physics prediction
        p_physics = self.physics_model.predict(
            df,
            irradiance_col=irradiance_col,
            temperature_col=temperature_col,
            wind_col=wind_col,
        )

        # ML residual prediction
        X, _ = self.feature_engineer.get_ml_ready_features(df, irradiance_col)

        # Handle missing features
        missing_features = set(self.feature_columns) - set(X.columns)
        for feat in missing_features:
            X[feat] = 0

        X = X[self.feature_columns]

        # Handle NaN
        valid_mask = ~X.isna().any(axis=1)
        delta_ml = np.zeros(len(df))
        if valid_mask.any():
            delta_ml[valid_mask] = self.ml_model.predict(X[valid_mask])

        # Hybrid prediction
        y_pred = p_physics + delta_ml

        # Clip to non-negative
        y_pred = np.maximum(y_pred, 0)

        if return_components:
            return {
                'p_expected': y_pred,
                'p_physics': p_physics,
                'delta_ml': delta_ml,
            }

        return y_pred

    def calculate_residuals(
        self,
        df: pd.DataFrame,
        power_col: str = 'power',
        irradiance_col: str = 'irradiance',
        temperature_col: str = 'temperature',
        wind_col: Optional[str] = 'wind_speed',
    ) -> pd.DataFrame:
        """
        Calculate residuals for anomaly detection.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with actual power
        power_col : str
            Actual power column

        Returns:
        --------
        pd.DataFrame
            DataFrame with expected, actual, residual columns
        """
        components = self.predict(
            df,
            irradiance_col=irradiance_col,
            temperature_col=temperature_col,
            wind_col=wind_col,
            return_components=True,
        )

        actual = df[power_col].values
        expected = components['p_expected']
        residual = actual - expected

        # Relative residual
        with np.errstate(divide='ignore', invalid='ignore'):
            relative = np.where(expected > 0.01, residual / expected, 0)

        result = pd.DataFrame({
            'expected_kW': expected,
            'actual_kW': actual,
            'residual_kW': residual,
            'relative_residual': relative,
            'p_physics': components['p_physics'],
            'delta_ml': components['delta_ml'],
        }, index=df.index if hasattr(df, 'index') else None)

        return result

    def save(self, filepath: str) -> None:
        """Save model to file."""
        filepath = Path(filepath)
        filepath.parent.mkdir(parents=True, exist_ok=True)

        model_data = {
            'inverter_id': self.inverter_id,
            'ml_type': self.ml_type,
            'ml_model': self.ml_model,
            'physics_model': self.physics_model.to_dict(),
            'feature_columns': self.feature_columns,
            'feature_importance': self.feature_importance,
            'is_trained': self.is_trained,
            'metrics': self.metrics.to_dict(),
            'training_period': self.training_period,
            'created_at': self.created_at,
            'config': {
                'use_catboost': self.config.use_catboost,
                'validation_split': self.config.validation_split,
            },
        }

        with open(filepath, 'wb') as f:
            pickle.dump(model_data, f)

        logger.info(f"Saved hybrid model to {filepath}")

    @classmethod
    def load(cls, filepath: str) -> 'HybridPhysicsMLModel':
        """Load model from file."""
        with open(filepath, 'rb') as f:
            data = pickle.load(f)

        # Create instance
        physics_model = PVWattsPhysicsModel.from_dict(data['physics_model'])

        instance = cls(
            inverter_id=data['inverter_id'],
            physics_model=physics_model,
        )

        # Restore state
        instance.ml_model = data['ml_model']
        instance.ml_type = data['ml_type']
        instance.feature_columns = data['feature_columns']
        instance.feature_importance = data['feature_importance']
        instance.is_trained = data['is_trained']
        instance.training_period = data.get('training_period')
        instance.created_at = data.get('created_at')

        # Restore metrics
        metrics_dict = data.get('metrics', {})
        instance.metrics = HybridModelMetrics(
            r2=metrics_dict.get('r2', 0),
            mae=metrics_dict.get('mae_kW', 0),
            rmse=metrics_dict.get('rmse_kW', 0),
            mape=metrics_dict.get('mape_pct', 0) / 100,
            physics_r2=metrics_dict.get('physics_r2', 0),
            physics_mae=metrics_dict.get('physics_mae_kW', 0),
            ml_r2=metrics_dict.get('ml_r2', 0),
            ml_mae=metrics_dict.get('ml_mae_kW', 0),
            training_samples=metrics_dict.get('trainingSamples', 0),
            validation_samples=metrics_dict.get('validationSamples', 0),
            training_time_s=metrics_dict.get('trainingTime_s', 0),
            calibration_factor=metrics_dict.get('calibrationFactor', 1.0),
        )

        logger.info(f"Loaded hybrid model from {filepath}")
        return instance

    def to_json_summary(self) -> Dict[str, Any]:
        """Export model summary as JSON-serializable dict."""
        return {
            'inverterId': self.inverter_id,
            'modelType': f'Hybrid (Physics + {self.ml_type})',
            'isTrained': self.is_trained,
            'trainingPeriod': {
                'start': self.training_period[0] if self.training_period else None,
                'end': self.training_period[1] if self.training_period else None,
            },
            'features': self.feature_columns,
            'metrics': self.metrics.to_dict(),
            'improvementOverPhysics': round(self.metrics.improvement_over_physics * 100, 1),
            'featureImportance': {
                k: round(v, 4) for k, v in sorted(
                    self.feature_importance.items(),
                    key=lambda x: x[1],
                    reverse=True
                )[:10]
            },
            'physicsModel': self.physics_model.to_dict(),
            'createdAt': self.created_at,
        }


def create_hybrid_model(
    inverter_id: str,
    capacity_kw: float,
    latitude: float = 0.0,
    longitude: float = 0.0,
    tilt: float = 0.0,
    azimuth: float = 180.0,
    use_catboost: bool = True,
) -> HybridPhysicsMLModel:
    """
    Create a hybrid model with given parameters.

    Parameters:
    -----------
    inverter_id : str
        Inverter identifier
    capacity_kw : float
        DC nameplate capacity
    latitude, longitude : float
        Location coordinates
    tilt, azimuth : float
        Array orientation
    use_catboost : bool
        Use CatBoost (vs LightGBM)

    Returns:
    --------
    HybridPhysicsMLModel
        Configured hybrid model
    """
    physics_model = create_physics_model(
        capacity_kw=capacity_kw,
        latitude=latitude,
        longitude=longitude,
        tilt=tilt,
        azimuth=azimuth,
    )

    feature_engineer = create_physics_engineer(
        latitude=latitude,
        longitude=longitude,
        tilt=tilt,
        azimuth=azimuth,
    )

    config = HybridModelConfig(use_catboost=use_catboost)

    return HybridPhysicsMLModel(
        inverter_id=inverter_id,
        physics_model=physics_model,
        feature_engineer=feature_engineer,
        config=config,
    )
