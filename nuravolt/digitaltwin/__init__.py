"""
Digital Twin Module for Solar PV Systems

Provides physics-informed hybrid digital twins for solar PV performance modeling:
- Plant-level models with inverter_id as categorical feature (NEW)
- Per-inverter hybrid models (Physics + ML)
- Physics-only features (NO power lags to prevent data leakage)
- Multi-stage normal data filtering for clean training sets
- 24-hour smoothed anomaly detection
- Dashboard-compatible JSON export

The hybrid approach (P_expected = P_physics + f_ML) is more robust than
pure ML because physics generalizes immediately to new plants while
ML only learns site-specific corrections.

Usage (Plant-Level - Recommended):
    from nuravolt.digitaltwin import PlantConfig, PlantLevelFactory

    # Load plant configuration from YAML
    config = PlantConfig.from_yaml("plant_configs/alpha1.yaml")

    # Train single plant model with inverter_id as categorical
    factory = PlantLevelFactory(config)
    result = factory.train()

    # Or use CLI: python scripts/train_plant_model.py --plant-id alpha1

Usage (Per-Inverter - Legacy):
    from nuravolt.digitaltwin import (
        HybridDigitalTwinFactory,
        HybridFactoryConfig,
        create_hybrid_factory,
    )

    # Create hybrid digital twins for all inverters
    factory = create_hybrid_factory(
        latitude=37.5,
        longitude=-121.9,
        tilt=25.0,
        azimuth=180.0,
        output_dir="public/data/digital_twins"
    )
    results = factory.create_all_twins(df)
"""

__version__ = "0.4.0"

# NOTE: This package previously imported many heavy modules at import time (some
# of which pull optional dependencies like LightGBM/Matplotlib).
# That made it hard to run lightweight utilities (e.g. dashboard aggregation)
# in constrained environments. We now lazy-load public symbols on demand.

from importlib import import_module

_ATTR_TO_MODULE: dict[str, str] = {
    # Core Model
    "CatBoostDigitalTwin": ".catboost_model",
    "FeatureConfig": ".catboost_model",
    "ModelMetrics": ".catboost_model",
    # Data Selection
    "DigitalTwinDataSelector": ".data_selector",
    "EnhancedDataSelector": ".data_selector",
    "SelectionCriteria": ".data_selector",
    "SelectionResult": ".data_selector",
    "identify_training_columns": ".data_selector",
    "extract_inverter_id": ".data_selector",
    "create_enhanced_selector": ".data_selector",
    # Factory
    "DigitalTwinFactory": ".factory",
    "FactoryConfig": ".factory",
    "InverterResult": ".factory",
    "HybridDigitalTwinFactory": ".factory",
    "HybridFactoryConfig": ".factory",
    "create_hybrid_factory": ".factory",
    # Anomaly Detection
    "SmoothedAnomalyDetector": ".anomaly_detector",
    "AnomalyConfig": ".anomaly_detector",
    "AnomalyPeriod": ".anomaly_detector",
    "InverterAnomalyResult": ".anomaly_detector",
    # Physics Model
    "PVWattsPhysicsModel": ".physics_model",
    "SystemParams": ".physics_model",
    "InverterParams": ".physics_model",
    "create_physics_model": ".physics_model",
    "estimate_system_params": ".physics_model",
    # Hybrid Model
    "HybridPhysicsMLModel": ".hybrid_model",
    "HybridModelMetrics": ".hybrid_model",
    "HybridModelConfig": ".hybrid_model",
    "create_hybrid_model": ".hybrid_model",
    # Feature Engineering
    "PhysicsFeatureEngineer": ".feature_engineering",
    "LocationParams": ".feature_engineering",
    "ModuleParams": ".feature_engineering",
    "FeatureEngConfig": ".feature_engineering",
    "create_physics_engineer": ".feature_engineering",
    # Normal Data Filter
    "NormalDataFilter": ".normal_data_filter",
    "FilterConfig": ".normal_data_filter",
    "FilterResult": ".normal_data_filter",
    "create_normal_filter": ".normal_data_filter",
    # Validation
    "NormalDataValidator": ".validation",
    "PhysicsComplianceValidator": ".validation",
    "ModelQualityValidator": ".validation",
    "ValidationResult": ".validation",
    "validate_complete_model": ".validation",
    "summarize_validation": ".validation",
    # Plant-Level Config
    "PlantConfig": ".plant_config",
    "LocationConfig": ".plant_config",
    "ArrayConfig": ".plant_config",
    "CapacityConfig": ".plant_config",
    "DataConfig": ".plant_config",
    "ColumnMapping": ".plant_config",
    "TrainingConfig": ".plant_config",
    "ModelConfig": ".plant_config",
    "QualityConfig": ".plant_config",
    "OutputConfig": ".plant_config",
    "ComponentsConfig": ".plant_config",
    "GroupSpec": ".plant_config",
    "InverterSpec": ".plant_config",
    "load_plant_config": ".plant_config",
    "list_available_plants": ".plant_config",
    # Data Transformer
    "WideToLongTransformer": ".data_transformer",
    "TransformResult": ".data_transformer",
    "rename_columns_for_training": ".data_transformer",
    "load_and_transform": ".data_transformer",
    "filter_training_period": ".data_transformer",
    "add_temporal_features": ".data_transformer",
    # Plant-Level Factory
    "PlantLevelFactory": ".plant_factory",
    "PlantTrainingResult": ".plant_factory",
    "InverterMetrics": ".plant_factory",
    "train_plant_model": ".plant_factory",
    # String-Level Twins
    "StringPerformanceTwin": ".string_twin",
    "StringTwinThresholds": ".string_twin",
    "StringTwinMetrics": ".string_twin",
    "StringAnomalyResult": ".string_twin",
    "StringAnomalyType": ".string_twin",
    "StringAnomalySeverity": ".string_twin",
    # String Twin Factory
    "StringTwinFactory": ".string_factory",
    "StringFactoryConfig": ".string_factory",
    "StringResult": ".string_factory",
    "create_string_factory": ".string_factory",
    # String Feature Engineering
    "StringFeatureEngineer": ".string_features",
    "calculate_string_relative_features": ".string_features",
}

__all__ = list(_ATTR_TO_MODULE.keys())


def __getattr__(name: str):
    if name in _ATTR_TO_MODULE:
        module = import_module(_ATTR_TO_MODULE[name], __name__)
        attr = getattr(module, name)
        globals()[name] = attr
        return attr
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
