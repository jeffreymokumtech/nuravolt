"""
Base classes for the Soiling Ratio estimation system.

This module defines the abstract interfaces for the 5-layer SR estimation hierarchy:
1. DustIQ Sensor (Layer 1) - Direct measurement, highest confidence
2. Same-Plant ML (Layer 2) - Trained on historical DustIQ data
3. Transfer Learning (Layer 3) - From similar plants with DustIQ
4. Foundation Model (Layer 4) - Global model trained on all DustIQ plants
5. Loss Disaggregation (Layer 5) - Physics-based SCADA-only estimation
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import IntEnum
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


class EstimationLayer(IntEnum):
    """SR estimation layer hierarchy with priority order."""
    DUSTIQ = 1           # Direct sensor measurement
    SAME_PLANT_ML = 2    # ML trained on plant's own DustIQ history
    TRANSFER = 3         # Transfer learning from similar plant
    FOUNDATION = 4       # Global foundation model
    DISAGGREGATION = 5   # Physics-based loss disaggregation


# Confidence levels by layer (0-100 scale)
LAYER_CONFIDENCE = {
    EstimationLayer.DUSTIQ: 95,
    EstimationLayer.SAME_PLANT_ML: 85,
    EstimationLayer.TRANSFER: 75,
    EstimationLayer.FOUNDATION: 65,
    EstimationLayer.DISAGGREGATION: 55,
}


# Minimum data requirements by layer
LAYER_DATA_REQUIREMENTS = {
    EstimationLayer.DUSTIQ: {
        "description": "Live DustIQ sensor data",
        "min_days": 1,
    },
    EstimationLayer.SAME_PLANT_ML: {
        "description": "Historical DustIQ + weather data",
        "min_days": 90,
        "recommended_days": 365,
    },
    EstimationLayer.TRANSFER: {
        "description": "Weather data + source plant DustIQ",
        "min_days": 30,
        "min_similarity": 0.6,
    },
    EstimationLayer.FOUNDATION: {
        "description": "Weather + AOD data",
        "min_days": 14,
    },
    EstimationLayer.DISAGGREGATION: {
        "description": "SCADA power data only",
        "min_days": 7,
    },
}


@dataclass
class SREstimationResult:
    """Result from a soiling ratio estimation.

    Contains the estimated SR values, confidence scores, method metadata,
    and validation information.
    """

    # Core estimation results
    sr_values: pd.Series  # Soiling ratio values indexed by date
    confidence: pd.Series  # Confidence scores (0-100) indexed by date

    # Method identification
    method: str           # Method name (e.g., "dustiq", "same_plant_ml")
    layer: EstimationLayer  # Layer number (1-5)

    # Additional metadata
    metadata: Dict[str, Any] = field(default_factory=dict)

    # Validation metrics (if available)
    validation_mae: Optional[float] = None
    validation_rmse: Optional[float] = None
    validation_r2: Optional[float] = None
    validation_bias: Optional[float] = None

    # Source information
    source_plant: Optional[str] = None  # For transfer learning
    model_version: Optional[str] = None
    estimated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "sr_values": self.sr_values.to_dict() if hasattr(self.sr_values, 'to_dict') else {},
            "confidence": self.confidence.to_dict() if hasattr(self.confidence, 'to_dict') else {},
            "method": self.method,
            "layer": int(self.layer),
            "layer_name": self.layer.name,
            "metadata": self.metadata,
            "validation": {
                "mae": self.validation_mae,
                "rmse": self.validation_rmse,
                "r2": self.validation_r2,
                "bias": self.validation_bias,
            },
            "source_plant": self.source_plant,
            "model_version": self.model_version,
            "estimated_at": self.estimated_at,
        }

    @property
    def avg_confidence(self) -> float:
        """Average confidence score."""
        if len(self.confidence) == 0:
            return 0.0
        return float(self.confidence.mean())

    @property
    def avg_sr(self) -> float:
        """Average soiling ratio."""
        if len(self.sr_values) == 0:
            return 1.0
        return float(self.sr_values.mean())

    @property
    def current_sr(self) -> float:
        """Most recent soiling ratio value."""
        if len(self.sr_values) == 0:
            return 1.0
        return float(self.sr_values.iloc[-1])

    @property
    def estimated_loss_pct(self) -> float:
        """Estimated soiling loss percentage (1 - current_sr)."""
        return (1 - self.current_sr) * 100


@dataclass
class MethodAvailability:
    """Describes availability status of an SR estimation method for a plant."""

    method: str
    layer: EstimationLayer
    is_available: bool
    reason: str
    confidence: int  # Expected confidence if used (0-100)

    # For transfer learning
    source_plant: Optional[str] = None
    similarity_score: Optional[float] = None

    # Data availability
    data_days_available: int = 0
    data_days_required: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "method": self.method,
            "layer": int(self.layer),
            "layer_name": self.layer.name,
            "is_available": self.is_available,
            "reason": self.reason,
            "confidence": self.confidence,
            "source_plant": self.source_plant,
            "similarity_score": self.similarity_score,
            "data_days_available": self.data_days_available,
            "data_days_required": self.data_days_required,
        }


class SREstimator(ABC):
    """Abstract base class for all SR estimation methods.

    Each layer in the SR estimation hierarchy implements this interface,
    providing a consistent API for checking availability and running estimation.
    """

    @property
    @abstractmethod
    def layer(self) -> EstimationLayer:
        """Return the layer number for this estimator."""
        pass

    @property
    @abstractmethod
    def method_name(self) -> str:
        """Return the method name (e.g., 'dustiq', 'same_plant_ml')."""
        pass

    @property
    def base_confidence(self) -> int:
        """Return the base confidence level for this layer."""
        return LAYER_CONFIDENCE.get(self.layer, 50)

    @abstractmethod
    def check_availability(self, plant_id: str) -> MethodAvailability:
        """Check if this estimation method is available for the given plant.

        Parameters
        ----------
        plant_id : str
            Plant identifier

        Returns
        -------
        MethodAvailability
            Availability status with reason and expected confidence
        """
        pass

    @abstractmethod
    def estimate(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> SREstimationResult:
        """Estimate soiling ratio for the given plant and date range.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        start_date : str, optional
            Start date (YYYY-MM-DD). If None, uses earliest available data.
        end_date : str, optional
            End date (YYYY-MM-DD). If None, uses latest available data.

        Returns
        -------
        SREstimationResult
            Estimation results with SR values, confidence, and metadata

        Raises
        ------
        ValueError
            If estimation method is not available for this plant
        """
        pass

    def validate(
        self,
        plant_id: str,
        ground_truth: pd.Series,
    ) -> Dict[str, float]:
        """Validate estimation against ground truth data.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        ground_truth : pd.Series
            Ground truth SR values indexed by date

        Returns
        -------
        dict
            Validation metrics (MAE, RMSE, R2, bias)
        """
        # Get estimation for the same period
        start_date = ground_truth.index.min().strftime("%Y-%m-%d")
        end_date = ground_truth.index.max().strftime("%Y-%m-%d")

        result = self.estimate(plant_id, start_date, end_date)

        # Align predictions with ground truth
        pred = result.sr_values.reindex(ground_truth.index)
        actual = ground_truth.loc[pred.dropna().index]
        pred = pred.dropna()

        if len(pred) == 0:
            return {"mae": np.nan, "rmse": np.nan, "r2": np.nan, "bias": np.nan}

        # Calculate metrics
        errors = pred - actual
        mae = np.abs(errors).mean()
        rmse = np.sqrt((errors ** 2).mean())
        bias = errors.mean()

        ss_res = ((actual - pred) ** 2).sum()
        ss_tot = ((actual - actual.mean()) ** 2).sum()
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        return {
            "mae": float(mae),
            "rmse": float(rmse),
            "r2": float(r2),
            "bias": float(bias),
            "n_samples": len(pred),
        }


def create_confidence_series(
    dates: pd.DatetimeIndex,
    base_confidence: int,
    adjustments: Optional[Dict[str, float]] = None,
) -> pd.Series:
    """Create a confidence series with optional date-based adjustments.

    Parameters
    ----------
    dates : pd.DatetimeIndex
        Dates for the series
    base_confidence : int
        Base confidence level (0-100)
    adjustments : dict, optional
        Date-based adjustments (date_str -> confidence_delta)

    Returns
    -------
    pd.Series
        Confidence values indexed by date
    """
    confidence = pd.Series(base_confidence, index=dates, dtype=float)

    if adjustments:
        for date_str, delta in adjustments.items():
            if date_str in confidence.index:
                confidence.loc[date_str] = max(0, min(100, base_confidence + delta))

    return confidence
