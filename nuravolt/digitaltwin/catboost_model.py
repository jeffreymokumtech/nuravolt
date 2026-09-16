"""
CatBoost Digital Twin Model for Solar PV Inverters

Provides CatBoost-based regression models for predicting expected power output
given environmental conditions. Trained on high-quality historical data from
early plant operation (first 2 years, PR > 10%).

Features:
- Robust to outliers (common in solar data)
- Fast inference for real-time monitoring
- Feature importance for interpretability
- Save/load for deployment
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path
import json
import pickle
from datetime import datetime
import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Try importing CatBoost, fall back to LightGBM if not available
try:
    from catboost import CatBoostRegressor, Pool
    CATBOOST_AVAILABLE = True
except ImportError:
    CATBOOST_AVAILABLE = False
    logger.warning("CatBoost not available, will use LightGBM fallback")

try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False


@dataclass
class ModelMetrics:
    """Metrics from model training/validation."""
    r2: float = 0.0
    mae: float = 0.0
    rmse: float = 0.0
    mape: float = 0.0
    training_samples: int = 0
    validation_samples: int = 0
    training_time_s: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "r2": round(self.r2, 4),
            "mae_kW": round(self.mae, 2),
            "rmse_kW": round(self.rmse, 2),
            "mape_pct": round(self.mape * 100, 2),
            "trainingSamples": self.training_samples,
            "validationSamples": self.validation_samples,
            "trainingTime_s": round(self.training_time_s, 2),
        }


@dataclass
class FeatureConfig:
    """Configuration for model features.

    IMPORTANT: This configuration uses physics-only features.
    Power-derived features (lags, rolling stats) are PROHIBITED
    to prevent data leakage in digital twin predictions.
    """
    # Core environmental features
    core_features: List[str] = field(default_factory=lambda: [
        'irradiance',        # POA irradiance (W/m²)
        'ambient_temp',      # Ambient temperature (°C)
        'module_temp',       # Module temperature (°C)
    ])

    # Temporal features (cyclical encoding preferred)
    temporal_features: List[str] = field(default_factory=lambda: [
        'day_of_year',       # 1-365
        'hour_of_day',       # 0-23
        'month',             # 1-12
        'hour_sin',          # sin(2π * hour / 24)
        'hour_cos',          # cos(2π * hour / 24)
        'doy_sin',           # sin(2π * doy / 365)
        'doy_cos',           # cos(2π * doy / 365)
    ])

    # Solar geometry features
    solar_features: List[str] = field(default_factory=lambda: [
        'solar_elevation',   # Sun elevation angle (degrees)
        'solar_azimuth',     # Sun azimuth angle (degrees)
        'sun_zenith',        # Sun zenith angle (degrees)
        'air_mass',          # Air mass factor
    ])

    # Derived features (physics-based only)
    derived_features: List[str] = field(default_factory=lambda: [
        'clearness_index',   # kt = GHI / extraterrestrial
        'clear_sky_index',   # GHI / GHI_clearsky
        'temp_delta',        # module_temp - ambient_temp
        't_cell_estimated',  # Estimated cell temperature
        'temp_efficiency_factor',  # Temperature derating
        'normalized_irradiance',   # G / 1000
    ])

    # PROHIBITED features (will cause data leakage)
    # These are listed for documentation and validation only
    prohibited_features: List[str] = field(default_factory=lambda: [
        'power_lag', 'power_lag_1', 'power_lag_2', 'power_lag_3',
        'power_rolling_mean', 'power_rolling_std', 'power_rolling_max',
        'power_change_rate', 'power_diff', 'power_pct_change',
        'cumulative_energy', 'energy_cumsum',
        'performance_ratio',  # Derived from power!
    ])

    @property
    def all_features(self) -> List[str]:
        """Get all configured features (physics-only)."""
        return (
            self.core_features +
            self.temporal_features +
            self.solar_features +
            self.derived_features
        )

    def validate_no_power_features(self, features: List[str]) -> None:
        """Validate that no prohibited power features are present."""
        prohibited = set(features) & set(self.prohibited_features)
        if prohibited:
            raise ValueError(
                f"Prohibited power-derived features detected: {prohibited}. "
                f"These cause data leakage. Use physics-only features."
            )


class CatBoostDigitalTwin:
    """
    CatBoost-based digital twin for solar PV inverter.

    Predicts expected power output given environmental conditions,
    enabling anomaly detection by comparing expected vs actual power.
    """

    # Default CatBoost hyperparameters optimized for solar data
    DEFAULT_PARAMS = {
        'iterations': 1000,
        'learning_rate': 0.05,
        'depth': 6,
        'l2_leaf_reg': 3,
        'random_seed': 42,
        'early_stopping_rounds': 100,
        'verbose': False,
        'loss_function': 'RMSE',
        'eval_metric': 'RMSE',
    }

    # LightGBM fallback parameters
    LIGHTGBM_PARAMS = {
        'objective': 'regression',
        'metric': 'rmse',
        'learning_rate': 0.05,
        'num_leaves': 31,
        'max_depth': 6,
        'n_estimators': 1000,
        'early_stopping_rounds': 100,
        'verbose': -1,
        'random_state': 42,
    }

    def __init__(
        self,
        inverter_id: str,
        feature_config: Optional[FeatureConfig] = None,
        params: Optional[Dict[str, Any]] = None,
        use_catboost: bool = True,
    ):
        """
        Initialize CatBoost digital twin.

        Parameters:
        -----------
        inverter_id : str
            Unique identifier for this inverter
        feature_config : FeatureConfig
            Feature configuration (uses default if None)
        params : Dict
            Model hyperparameters (uses defaults if None)
        use_catboost : bool
            Use CatBoost if available, else LightGBM
        """
        self.inverter_id = inverter_id
        self.feature_config = feature_config or FeatureConfig()

        # Determine which library to use
        self.use_catboost = use_catboost and CATBOOST_AVAILABLE
        if use_catboost and not CATBOOST_AVAILABLE:
            if LIGHTGBM_AVAILABLE:
                logger.warning(f"{inverter_id}: CatBoost not available, using LightGBM")
                self.use_catboost = False
            else:
                raise ImportError("Neither CatBoost nor LightGBM available")

        # Initialize model
        if self.use_catboost:
            self.params = {**self.DEFAULT_PARAMS, **(params or {})}
            self.model = CatBoostRegressor(**self.params)
        else:
            self.params = {**self.LIGHTGBM_PARAMS, **(params or {})}
            self.model = lgb.LGBMRegressor(**self.params)

        # State
        self.is_trained = False
        self.metrics = ModelMetrics()
        self.feature_importance: Dict[str, float] = {}
        self.training_period: Optional[Tuple[str, str]] = None
        self.created_at: str = datetime.now().isoformat()

        logger.info(f"Initialized {'CatBoost' if self.use_catboost else 'LightGBM'} "
                   f"digital twin for {inverter_id}")

    def _prepare_features(
        self,
        df: pd.DataFrame,
        feature_cols: Optional[List[str]] = None
    ) -> pd.DataFrame:
        """
        Prepare feature matrix from DataFrame.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with potential feature columns
        feature_cols : List[str]
            Specific features to use (uses config if None)

        Returns:
        --------
        pd.DataFrame
            Feature matrix ready for model
        """
        if feature_cols is None:
            feature_cols = self.feature_config.all_features

        # Find available features
        available = [col for col in feature_cols if col in df.columns]
        missing = set(feature_cols) - set(available)

        if missing:
            logger.debug(f"Missing features (will be created or skipped): {missing}")

        # Create derived features if needed
        df = df.copy()

        # Temperature delta
        if 'temp_delta' in feature_cols and 'temp_delta' not in df.columns:
            if 'module_temp' in df.columns and 'ambient_temp' in df.columns:
                df['temp_delta'] = df['module_temp'] - df['ambient_temp']
                available.append('temp_delta')

        # Temporal features from index
        if isinstance(df.index, pd.DatetimeIndex):
            if 'day_of_year' in feature_cols and 'day_of_year' not in df.columns:
                df['day_of_year'] = df.index.dayofyear
                available.append('day_of_year')
            if 'hour_of_day' in feature_cols and 'hour_of_day' not in df.columns:
                df['hour_of_day'] = df.index.hour + df.index.minute / 60
                available.append('hour_of_day')
            if 'month' in feature_cols and 'month' not in df.columns:
                df['month'] = df.index.month
                available.append('month')

        # Return available features
        available = list(dict.fromkeys(available))  # Preserve order, remove duplicates

        if len(available) == 0:
            raise ValueError("No features available for model training")

        self._feature_columns = available
        return df[available]

    def train(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_val: Optional[pd.DataFrame] = None,
        y_val: Optional[pd.Series] = None,
        feature_cols: Optional[List[str]] = None,
    ) -> ModelMetrics:
        """
        Train the digital twin model.

        Parameters:
        -----------
        X_train : pd.DataFrame
            Training features
        y_train : pd.Series
            Training target (power output)
        X_val : pd.DataFrame
            Validation features (optional, uses 20% split if None)
        y_val : pd.Series
            Validation target
        feature_cols : List[str]
            Feature columns to use

        Returns:
        --------
        ModelMetrics
            Training and validation metrics
        """
        import time
        start_time = time.time()

        logger.info(f"Training digital twin for {self.inverter_id} "
                   f"with {len(X_train)} samples")

        # Prepare features
        X_train_prep = self._prepare_features(X_train, feature_cols)

        # Handle validation split
        if X_val is None or y_val is None:
            # Use last 20% as validation (temporal split)
            split_idx = int(len(X_train_prep) * 0.8)
            X_val_prep = X_train_prep.iloc[split_idx:]
            y_val_split = y_train.iloc[split_idx:]
            X_train_prep = X_train_prep.iloc[:split_idx]
            y_train = y_train.iloc[:split_idx]
        else:
            X_val_prep = self._prepare_features(X_val, feature_cols)
            y_val_split = y_val

        # Drop NaN values
        train_mask = ~(X_train_prep.isna().any(axis=1) | y_train.isna())
        val_mask = ~(X_val_prep.isna().any(axis=1) | y_val_split.isna())

        X_train_clean = X_train_prep[train_mask]
        y_train_clean = y_train[train_mask]
        X_val_clean = X_val_prep[val_mask]
        y_val_clean = y_val_split[val_mask]

        logger.info(f"Training with {len(X_train_clean)} samples, "
                   f"validating with {len(X_val_clean)} samples")

        # Train model
        if self.use_catboost:
            train_pool = Pool(X_train_clean, y_train_clean)
            val_pool = Pool(X_val_clean, y_val_clean)
            self.model.fit(train_pool, eval_set=val_pool, use_best_model=True)
        else:
            self.model.fit(
                X_train_clean, y_train_clean,
                eval_set=[(X_val_clean, y_val_clean)],
            )

        self.is_trained = True

        # Calculate metrics
        y_pred_val = self.model.predict(X_val_clean)
        self.metrics = self._calculate_metrics(
            y_val_clean.values, y_pred_val,
            len(X_train_clean), len(X_val_clean),
            time.time() - start_time
        )

        # Feature importance
        if self.use_catboost:
            importances = self.model.get_feature_importance()
        else:
            importances = self.model.feature_importances_

        self.feature_importance = dict(zip(self._feature_columns, importances))

        # Store training period
        if isinstance(X_train.index, pd.DatetimeIndex):
            self.training_period = (
                str(X_train.index.min())[:10],
                str(X_train.index.max())[:10]
            )

        logger.info(f"Training complete: R²={self.metrics.r2:.4f}, "
                   f"MAE={self.metrics.mae:.2f} kW")

        return self.metrics

    def _calculate_metrics(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        n_train: int,
        n_val: int,
        training_time: float
    ) -> ModelMetrics:
        """Calculate model performance metrics."""
        # Avoid division by zero
        y_true = np.asarray(y_true)
        y_pred = np.asarray(y_pred)

        # R² score
        ss_res = np.sum((y_true - y_pred) ** 2)
        ss_tot = np.sum((y_true - np.mean(y_true)) ** 2)
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # MAE
        mae = np.mean(np.abs(y_true - y_pred))

        # RMSE
        rmse = np.sqrt(np.mean((y_true - y_pred) ** 2))

        # MAPE (excluding near-zero values)
        mask = np.abs(y_true) > 0.01
        if mask.any():
            mape = np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask]))
        else:
            mape = 0.0

        return ModelMetrics(
            r2=r2,
            mae=mae,
            rmse=rmse,
            mape=mape,
            training_samples=n_train,
            validation_samples=n_val,
            training_time_s=training_time
        )

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        """
        Predict expected power output.

        Parameters:
        -----------
        X : pd.DataFrame
            Input features

        Returns:
        --------
        np.ndarray
            Predicted power output (kW)
        """
        if not self.is_trained:
            raise ValueError("Model not trained. Call train() first.")

        X_prep = self._prepare_features(X)

        # Handle missing values
        valid_mask = ~X_prep.isna().any(axis=1)
        predictions = np.full(len(X_prep), np.nan)

        if valid_mask.any():
            predictions[valid_mask] = self.model.predict(X_prep[valid_mask])

        # Clip to non-negative (power can't be negative)
        predictions = np.clip(predictions, 0, None)

        return predictions

    def calculate_residuals(
        self,
        X: pd.DataFrame,
        y_actual: pd.Series
    ) -> pd.DataFrame:
        """
        Calculate residuals (actual - expected) for anomaly detection.

        Parameters:
        -----------
        X : pd.DataFrame
            Input features
        y_actual : pd.Series
            Actual power output

        Returns:
        --------
        pd.DataFrame
            DataFrame with expected, actual, residual, and relative_residual
        """
        expected = self.predict(X)
        actual = y_actual.values
        residual = actual - expected

        # Relative residual (avoid division by zero)
        relative = np.where(
            expected > 0.01,
            residual / expected,
            0.0
        )

        result = pd.DataFrame({
            'expected_kW': expected,
            'actual_kW': actual,
            'residual_kW': residual,
            'relative_residual': relative,
        }, index=X.index if hasattr(X, 'index') else None)

        return result

    def save(self, filepath: str) -> None:
        """Save model to file."""
        filepath = Path(filepath)
        filepath.parent.mkdir(parents=True, exist_ok=True)

        # Save model object
        model_data = {
            'inverter_id': self.inverter_id,
            'use_catboost': self.use_catboost,
            'params': self.params,
            'feature_config': self.feature_config,
            'feature_columns': getattr(self, '_feature_columns', []),
            'is_trained': self.is_trained,
            'metrics': self.metrics.to_dict(),
            'feature_importance': self.feature_importance,
            'training_period': self.training_period,
            'created_at': self.created_at,
        }

        # Save as pickle (includes trained model)
        with open(filepath, 'wb') as f:
            pickle.dump({
                'model': self.model,
                'metadata': model_data
            }, f)

        logger.info(f"Saved model to {filepath}")

    @classmethod
    def load(cls, filepath: str) -> 'CatBoostDigitalTwin':
        """Load model from file."""
        with open(filepath, 'rb') as f:
            data = pickle.load(f)

        metadata = data['metadata']

        # Create instance
        instance = cls(
            inverter_id=metadata['inverter_id'],
            feature_config=metadata.get('feature_config'),
            use_catboost=metadata.get('use_catboost', True)
        )

        # Restore state
        instance.model = data['model']
        instance._feature_columns = metadata.get('feature_columns', [])
        instance.is_trained = metadata.get('is_trained', True)
        instance.feature_importance = metadata.get('feature_importance', {})
        instance.training_period = metadata.get('training_period')
        instance.created_at = metadata.get('created_at')

        # Restore metrics
        metrics_dict = metadata.get('metrics', {})
        instance.metrics = ModelMetrics(
            r2=metrics_dict.get('r2', 0),
            mae=metrics_dict.get('mae_kW', 0),
            rmse=metrics_dict.get('rmse_kW', 0),
            mape=metrics_dict.get('mape_pct', 0) / 100,
            training_samples=metrics_dict.get('trainingSamples', 0),
            validation_samples=metrics_dict.get('validationSamples', 0),
            training_time_s=metrics_dict.get('trainingTime_s', 0),
        )

        logger.info(f"Loaded model from {filepath}")
        return instance

    def to_json_summary(self) -> Dict[str, Any]:
        """Export model summary as JSON-serializable dict."""
        return {
            'inverterId': self.inverter_id,
            'modelType': 'CatBoost' if self.use_catboost else 'LightGBM',
            'isTrained': self.is_trained,
            'trainingPeriod': {
                'start': self.training_period[0] if self.training_period else None,
                'end': self.training_period[1] if self.training_period else None,
            },
            'features': getattr(self, '_feature_columns', []),
            'metrics': self.metrics.to_dict(),
            'featureImportance': {
                k: round(v, 4) for k, v in sorted(
                    self.feature_importance.items(),
                    key=lambda x: x[1],
                    reverse=True
                )[:10]  # Top 10 features
            },
            'createdAt': self.created_at,
        }
