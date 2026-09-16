"""
Soiling Ratio Estimation Package - 5-Layer Hierarchical System.

This package provides a production-ready layered SR estimation system
with automatic method selection based on data availability.

Layers (in priority order):
1. DustIQ Sensor (95% confidence) - Direct measurement
2. Same-Plant ML (85% confidence) - Trained on plant's DustIQ
3. Transfer Learning (75% confidence) - From similar plant
4. Foundation Model (65% confidence) - Global model
5. Loss Disaggregation (55% confidence) - Physics-based

Quick Start:
    from nuravolt.soiling.estimation import SRMethodSelector

    # Auto-select best method
    selector = SRMethodSelector()
    result = selector.estimate("ribera")
    print(f"SR: {result.current_sr:.3f} (method: {result.method})")

    # Check all available methods
    availabilities = selector.get_availability("ribera")
    for a in availabilities:
        print(f"  {a.method}: {'YES' if a.is_available else 'NO'} ({a.reason})")

    # Force specific method
    result = selector.estimate("ribera", method_override="transfer")

    # Compare all methods
    comparison = selector.compare_methods("ribera")
"""

# Base classes
from .base import (
    EstimationLayer,
    SREstimationResult,
    SREstimator,
    MethodAvailability,
    LAYER_CONFIDENCE,
    LAYER_DATA_REQUIREMENTS,
    create_confidence_series,
)

# Layer estimators
from .layer1_dustiq import DustIQEstimator
from .layer2_same_plant_ml import SamePlantMLEstimator
from .layer3_transfer import TransferLearningEstimator
from .layer4_foundation import FoundationModelEstimator
from .layer5_disaggregation import LossDisaggregationEstimator

# Similarity scoring
from .similarity import (
    PlantClimateProfile,
    PlantSimilarityScorer,
    PLANT_PROFILES,
    get_validated_transfer_source,
    MIN_SIMILARITY,
    RECOMMENDED_SIMILARITY,
    MAX_ACCEPTABLE_MAE,
)

# Transfer performance registry
from .transfer_performance_registry import (
    TransferPerformanceRegistry,
    TransferResult,
    get_registry,
    get_best_transfer_source,
    get_transfer_mae,
)

# Calibration utilities (rain anchors, fleet CV)
from .calibration import (
    RainAnchorConfig,
    RainAnchor,
    FleetCVConfig,
    FleetCVFeatures,
    identify_rain_anchors,
    calibrate_with_rain_anchors,
    compute_fleet_cv_features,
    load_fleet_cv_from_scada,
    add_fleet_cv_to_features,
)

# Method selector
from .method_selector import SRMethodSelector, MethodSelectionResult


__all__ = [
    # Enums and constants
    "EstimationLayer",
    "LAYER_CONFIDENCE",
    "LAYER_DATA_REQUIREMENTS",
    "MIN_SIMILARITY",
    "RECOMMENDED_SIMILARITY",
    "MAX_ACCEPTABLE_MAE",
    # Base classes
    "SREstimationResult",
    "SREstimator",
    "MethodAvailability",
    "create_confidence_series",
    # Layer estimators
    "DustIQEstimator",
    "SamePlantMLEstimator",
    "TransferLearningEstimator",
    "FoundationModelEstimator",
    "LossDisaggregationEstimator",
    # Similarity
    "PlantClimateProfile",
    "PlantSimilarityScorer",
    "PLANT_PROFILES",
    "get_validated_transfer_source",
    # Transfer performance registry
    "TransferPerformanceRegistry",
    "TransferResult",
    "get_registry",
    "get_best_transfer_source",
    "get_transfer_mae",
    # Calibration utilities
    "RainAnchorConfig",
    "RainAnchor",
    "FleetCVConfig",
    "FleetCVFeatures",
    "identify_rain_anchors",
    "calibrate_with_rain_anchors",
    "compute_fleet_cv_features",
    "load_fleet_cv_from_scada",
    "add_fleet_cv_to_features",
    # Method selector
    "SRMethodSelector",
    "MethodSelectionResult",
]
