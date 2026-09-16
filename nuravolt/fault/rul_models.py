"""
RUL (Remaining Useful Life) Prediction Models

Per-fault-type regression models that predict "days till fault X".

Models:
- RULStringDegradationModel: Days till string CV > 25%
- RULInverterThermalModel: Days till inverter > 65°C
- RULModuleDegradationModel: Days till PR < 75%
"""

import pickle
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Literal
import numpy as np
import polars as pl

try:
    from catboost import CatBoostRegressor
    HAS_CATBOOST = True
except ImportError:
    HAS_CATBOOST = False


@dataclass
class RULPrediction:
    """A single RUL prediction result."""

    fault_type: str
    days_to_fault: float
    confidence: float  # 0-1, based on prediction variance or model confidence
    threshold: float
    current_value: Optional[float] = None
    trend: Optional[float] = None  # Daily trend (negative = degrading)
    is_urgent: bool = False  # True if days_to_fault < 3

    def __post_init__(self):
        self.is_urgent = self.days_to_fault < 3

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "fault_type": self.fault_type,
            "days_to_fault": round(self.days_to_fault, 1),
            "confidence": round(self.confidence, 2),
            "threshold": self.threshold,
            "current_value": round(self.current_value, 3) if self.current_value else None,
            "trend": round(self.trend, 4) if self.trend else None,
            "is_urgent": self.is_urgent,
        }


@dataclass
class RULModelConfig:
    """Configuration for RUL model."""

    fault_type: str
    display_name: str
    threshold: float
    unit: str
    max_horizon_days: int
    higher_is_worse: bool  # True if increasing metric indicates degradation

    # Feature columns
    primary_feature: str  # Main metric being tracked
    trend_feature: str  # 7-day trend feature
    additional_features: list[str] = field(default_factory=list)

    # Model parameters
    iterations: int = 500
    learning_rate: float = 0.05
    depth: int = 6


# Pre-defined configurations for each fault type
STRING_DEGRADATION_CONFIG = RULModelConfig(
    fault_type="string_degradation",
    display_name="String Degradation",
    threshold=0.25,  # CV > 25%
    unit="CV",
    max_horizon_days=14,
    higher_is_worse=True,
    primary_feature="string_current_cv",
    trend_feature="string_cv_trend_7d",
    additional_features=[
        "string_current_min_ratio",
        "string_current_max_ratio",
        "irradiance_normalized",
        "module_temp",
    ],
)

INVERTER_THERMAL_CONFIG = RULModelConfig(
    fault_type="inverter_thermal",
    display_name="Inverter Overtemperature",
    threshold=65.0,  # °C
    unit="°C",
    max_horizon_days=10,
    higher_is_worse=True,
    primary_feature="temp_rise",  # Use temp_rise as proxy when inverter_temp unavailable
    trend_feature="temp_rise_trend_7d",
    additional_features=[
        "ambient_temp",
        "ac_power_pu",
        "irradiance_normalized",
    ],
)

MODULE_DEGRADATION_CONFIG = RULModelConfig(
    fault_type="module_degradation",
    display_name="Module Degradation",
    threshold=0.75,  # PR < 75%
    unit="PR",
    max_horizon_days=90,
    higher_is_worse=False,  # Lower PR is worse
    primary_feature="performance_ratio",
    trend_feature="pr_trend_30d",
    additional_features=[
        "efficiency_trend_30d",
        "pr_acceleration_7d",
        "module_temp",
        "irradiance_normalized",
    ],
)


# ============================================================================
# NEW MODEL CONFIGURATIONS (v0.4.0)
# ============================================================================

THERMAL_HOTSPOT_CONFIG = RULModelConfig(
    fault_type="thermal_hotspot",
    display_name="Thermal Hotspot Risk",
    threshold=25.0,  # temp_delta > 25°C sustained
    unit="°C",
    max_horizon_days=10,
    higher_is_worse=True,
    primary_feature="temp_delta",  # module_temp - ambient_temp
    trend_feature="temp_delta_trend_7d",
    additional_features=[
        "temp_delta_95th_7d",
        "temp_delta_max_7d",
        "power_pu",
        "irradiance_normalized",
        "ambient_temp",
    ],
)

MISMATCH_CONFIG = RULModelConfig(
    fault_type="mismatch",
    display_name="String Mismatch",
    threshold=0.85,  # worst_string_ratio < 85%
    unit="ratio",
    max_horizon_days=14,
    higher_is_worse=False,  # Lower ratio is worse
    primary_feature="worst_string_ratio",  # min(string_powers) / mean(string_powers)
    trend_feature="string_ratio_trend_7d",
    additional_features=[
        "string_power_cv",
        "string_power_range",
        "irradiance_normalized",
        "module_temp",
    ],
)

BYPASS_DIODE_CONFIG = RULModelConfig(
    fault_type="bypass_diode",
    display_name="Bypass Diode Stress",
    threshold=3,  # hotspot_count > 3
    unit="count",
    max_horizon_days=7,
    higher_is_worse=True,
    primary_feature="hotspot_count",  # Cells > mean + 2σ
    trend_feature="hotspot_trend_7d",
    additional_features=[
        "cell_temp_variance",
        "max_cell_delta",
        "irradiance_normalized",
    ],
)

INSULATION_CONFIG = RULModelConfig(
    fault_type="insulation",
    display_name="Insulation Degradation",
    threshold=40.0,  # Riso < 40 MΩ/kWp (IEC 62446)
    unit="MΩ/kWp",
    max_horizon_days=90,
    higher_is_worse=False,  # Lower Riso is worse
    primary_feature="riso_value",  # Insulation resistance
    trend_feature="riso_trend_30d",
    additional_features=[
        "humidity_avg_7d",
        "temp_cycles_30d",
        "age_years",
    ],
)


# All available configs
ALL_RUL_CONFIGS = {
    "string_degradation": STRING_DEGRADATION_CONFIG,
    "inverter_thermal": INVERTER_THERMAL_CONFIG,
    "module_degradation": MODULE_DEGRADATION_CONFIG,
    "thermal_hotspot": THERMAL_HOTSPOT_CONFIG,
    "mismatch": MISMATCH_CONFIG,
    "bypass_diode": BYPASS_DIODE_CONFIG,
    "insulation": INSULATION_CONFIG,
}


class BaseRULModel(ABC):
    """
    Base class for RUL prediction models.

    All RUL models predict days_to_fault as a regression target.
    """

    def __init__(self, config: RULModelConfig):
        self.config = config
        self.model = None
        self._is_trained = False

    @property
    def feature_columns(self) -> list[str]:
        """Get all feature columns used by this model."""
        features = [self.config.primary_feature, self.config.trend_feature]
        features.extend(self.config.additional_features)
        return features

    @abstractmethod
    def train(self, X: np.ndarray, y: np.ndarray) -> dict:
        """Train the model. Returns training metrics."""
        pass

    @abstractmethod
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Predict days_to_fault for input samples."""
        pass

    def predict_from_df(self, df: pl.DataFrame) -> list[RULPrediction]:
        """
        Predict RUL from a DataFrame.

        Args:
            df: DataFrame with required feature columns

        Returns:
            List of RULPrediction objects
        """
        # Check required features
        missing = [c for c in self.feature_columns if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required columns: {missing}")

        # Extract features
        X = df.select(self.feature_columns).to_numpy()

        # Get predictions
        days_to_fault = self.predict(X)

        # Get current values and trends for context
        current_values = df[self.config.primary_feature].to_numpy()
        trends = df[self.config.trend_feature].to_numpy() if self.config.trend_feature in df.columns else None

        # Create predictions
        predictions = []
        for i in range(len(df)):
            pred = RULPrediction(
                fault_type=self.config.fault_type,
                days_to_fault=float(days_to_fault[i]),
                confidence=self._estimate_confidence(days_to_fault[i], current_values[i]),
                threshold=self.config.threshold,
                current_value=float(current_values[i]) if not np.isnan(current_values[i]) else None,
                trend=float(trends[i]) if trends is not None and not np.isnan(trends[i]) else None,
            )
            predictions.append(pred)

        return predictions

    def _estimate_confidence(self, days_pred: float, current_value: float) -> float:
        """
        Estimate prediction confidence.

        Higher confidence when:
        - Closer to threshold (more data points in training)
        - Shorter horizon (less uncertainty)
        """
        # Distance-based confidence
        if self.config.higher_is_worse:
            distance_to_threshold = self.config.threshold - current_value
            if distance_to_threshold <= 0:
                return 0.95  # Already at threshold
        else:
            distance_to_threshold = current_value - self.config.threshold
            if distance_to_threshold <= 0:
                return 0.95

        # Normalize distance (0 = at threshold, 1 = far from threshold)
        max_distance = self.config.threshold  # Approximate
        normalized_distance = min(1.0, distance_to_threshold / max_distance)

        # Horizon-based confidence (shorter = more confident)
        horizon_factor = 1.0 - (days_pred / self.config.max_horizon_days) * 0.3

        # Combine factors
        confidence = (1.0 - normalized_distance * 0.4) * horizon_factor
        return max(0.3, min(0.95, confidence))

    def save(self, path: Path):
        """Save model to pickle file."""
        with open(path, "wb") as f:
            pickle.dump({
                "config": self.config,
                "model": self.model,
                "is_trained": self._is_trained,
            }, f)

    @classmethod
    def load(cls, path: Path) -> "BaseRULModel":
        """Load model from pickle file."""
        with open(path, "rb") as f:
            data = pickle.load(f)

        # Try creating instance without config first (for subclasses with no args)
        # Fall back to passing config for generic BaseRULModel usage
        import inspect
        sig = inspect.signature(cls.__init__)
        params = [p for p in sig.parameters.values() if p.name != 'self']

        if len(params) == 0 or all(p.default is not inspect.Parameter.empty for p in params):
            # Subclass with no required args (e.g., RULThermalHotspotModel)
            instance = cls()
            instance.config = data["config"]  # Override with saved config
        else:
            # Generic class requiring config
            instance = cls(data["config"])

        instance.model = data["model"]
        instance._is_trained = data["is_trained"]
        return instance


class CatBoostRULModel(BaseRULModel):
    """RUL model using CatBoost regressor."""

    def __init__(self, config: RULModelConfig):
        super().__init__(config)
        if not HAS_CATBOOST:
            raise ImportError("CatBoost not installed. Run: pip install catboost")

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        X_val: Optional[np.ndarray] = None,
        y_val: Optional[np.ndarray] = None,
    ) -> dict:
        """
        Train CatBoost regressor.

        Args:
            X: Training features (n_samples, n_features)
            y: Training labels (days_to_fault)
            X_val: Validation features (optional)
            y_val: Validation labels (optional)

        Returns:
            Training metrics
        """
        self.model = CatBoostRegressor(
            iterations=self.config.iterations,
            learning_rate=self.config.learning_rate,
            depth=self.config.depth,
            loss_function="MAE",  # More robust to outliers than RMSE
            random_seed=42,
            verbose=False,
            early_stopping_rounds=50 if X_val is not None else None,
        )

        eval_set = (X_val, y_val) if X_val is not None else None
        self.model.fit(X, y, eval_set=eval_set, verbose=100)

        self._is_trained = True

        # Compute metrics
        y_pred = self.predict(X)
        train_mae = np.mean(np.abs(y - y_pred))
        train_rmse = np.sqrt(np.mean((y - y_pred) ** 2))

        metrics = {
            "train_mae": train_mae,
            "train_rmse": train_rmse,
            "n_samples": len(y),
        }

        if X_val is not None:
            y_val_pred = self.predict(X_val)
            metrics["val_mae"] = np.mean(np.abs(y_val - y_val_pred))
            metrics["val_rmse"] = np.sqrt(np.mean((y_val - y_val_pred) ** 2))
            metrics["val_within_3_days"] = np.mean(np.abs(y_val - y_val_pred) <= 3) * 100

        return metrics

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Predict days_to_fault."""
        if not self._is_trained:
            raise RuntimeError("Model not trained. Call train() first.")

        predictions = self.model.predict(X)

        # Clip to valid range
        predictions = np.clip(predictions, 0, self.config.max_horizon_days)

        return predictions

    def get_feature_importance(self) -> dict[str, float]:
        """Get feature importance scores."""
        if not self._is_trained:
            return {}

        importance = self.model.get_feature_importance()
        return dict(zip(self.feature_columns, importance))


class RULStringDegradationModel(CatBoostRULModel):
    """Predict days until string CV exceeds threshold (25%)."""

    def __init__(self):
        super().__init__(STRING_DEGRADATION_CONFIG)


class RULInverterThermalModel(CatBoostRULModel):
    """Predict days until inverter overtemperature (65°C)."""

    def __init__(self):
        super().__init__(INVERTER_THERMAL_CONFIG)


class RULModuleDegradationModel(CatBoostRULModel):
    """Predict days until PR drops below threshold (75%)."""

    def __init__(self):
        super().__init__(MODULE_DEGRADATION_CONFIG)


# ============================================================================
# NEW MODEL CLASSES (v0.4.0)
# ============================================================================

class RULThermalHotspotModel(CatBoostRULModel):
    """
    Predict days until thermal hotspot risk.

    Thermal hotspots occur when temp_delta (module - ambient) exceeds
    threshold for sustained period, indicating:
    - Cell degradation / hot spots
    - Poor ventilation / soiling
    - Bypass diode activation

    Requires PVDAQ or similar data with ambient_temp and module_temp.
    """

    def __init__(self):
        super().__init__(THERMAL_HOTSPOT_CONFIG)


class RULMismatchModel(CatBoostRULModel):
    """
    Predict days until string mismatch exceeds threshold.

    String mismatch indicates degradation or failure of one string
    relative to parallel strings, caused by:
    - Partial shading on one string
    - String-level degradation
    - Connector/wiring issues
    - Module failures within string

    Requires string-level power/current measurements.
    """

    def __init__(self):
        super().__init__(MISMATCH_CONFIG)


class RULBypassDiodeModel(CatBoostRULModel):
    """
    Predict days until bypass diode stress.

    Bypass diodes activate during cell mismatch, causing localized
    heating that can be detected via:
    - Thermal imaging (IR cameras)
    - Cell temperature variance
    - Hotspot counting

    Requires thermal imaging data (Infrared Solar Modules dataset).
    """

    def __init__(self):
        super().__init__(BYPASS_DIODE_CONFIG)


class RULInsulationModel(CatBoostRULModel):
    """
    Predict days until insulation degradation (Riso < 40 MΩ/kWp).

    Insulation resistance (Riso) degrades over time due to:
    - Moisture ingress
    - Backsheet degradation
    - Thermal cycling
    - UV exposure

    Per IEC 62446, Riso < 40 MΩ/kWp indicates ground fault risk.
    Requires Riso measurements (Backsheet degradation dataset).
    """

    def __init__(self):
        super().__init__(INSULATION_CONFIG)


# All model classes
ALL_RUL_MODELS = {
    "string_degradation": RULStringDegradationModel,
    "inverter_thermal": RULInverterThermalModel,
    "module_degradation": RULModuleDegradationModel,
    "thermal_hotspot": RULThermalHotspotModel,
    "mismatch": RULMismatchModel,
    "bypass_diode": RULBypassDiodeModel,
    "insulation": RULInsulationModel,
}


# Factory function
def create_rul_model(fault_type: str) -> BaseRULModel:
    """
    Create an RUL model for a specific fault type.

    Args:
        fault_type: Type of fault to predict. Options:
            - string_degradation: Days till string CV > 25%
            - inverter_thermal: Days till inverter > 65°C
            - module_degradation: Days till PR < 75%
            - thermal_hotspot: Days till temp_delta > 25°C (NEW)
            - mismatch: Days till string ratio < 85% (NEW)
            - bypass_diode: Days till hotspot_count > 3 (NEW)
            - insulation: Days till Riso < 40 MΩ/kWp (NEW)

    Returns:
        Configured RUL model instance

    Example:
        model = create_rul_model("thermal_hotspot")
        model.train(X_train, y_train, X_val, y_val)
        predictions = model.predict(X_test)
    """
    if fault_type not in ALL_RUL_MODELS:
        raise ValueError(
            f"Unknown fault type: {fault_type}. "
            f"Options: {list(ALL_RUL_MODELS.keys())}"
        )

    return ALL_RUL_MODELS[fault_type]()


def list_available_models() -> list[str]:
    """Get list of available RUL model types."""
    return list(ALL_RUL_MODELS.keys())


def get_model_config(fault_type: str) -> RULModelConfig:
    """Get configuration for a model type."""
    if fault_type not in ALL_RUL_CONFIGS:
        raise ValueError(f"Unknown fault type: {fault_type}")
    return ALL_RUL_CONFIGS[fault_type]
