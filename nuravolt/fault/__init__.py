"""
NuraVolt Fault Detection Module

Comprehensive fault detection for solar PV systems with:
- Rule-based detection for 10+ reactive fault types (no ML required)
- ML-based detection with foundation models for 22+ fault classes
- RUL (Remaining Useful Life) prediction for predictive maintenance
- Plant-agnostic features that transfer across any plant configuration

Usage:
    # Rule-based detection (immediate deployment)
    from nuravolt.fault import RuleBasedFaultDetector, FaultDetectionConfig

    config = FaultDetectionConfig()
    detector = RuleBasedFaultDetector(config)
    result = detector.detect_all(df)

    # ML-based detection (after pretraining)
    from nuravolt.fault import FaultClassifier, PlantAgnosticFeatureEngine, PlantConfig

    # Create features
    plant_config = PlantConfig(rated_dc_power_kw=1000, rated_ac_power_kw=900)
    feature_engine = PlantAgnosticFeatureEngine(plant_config)
    features_df = feature_engine.transform(raw_df)

    # Load pretrained model
    classifier = FaultClassifier.load("models/fault_classifier_system_level.pkl")
    predictions = classifier.predict(features_df)

    # RUL prediction (predictive maintenance)
    from nuravolt.fault import RULPredictor

    predictor = RULPredictor("models/rul")
    schedule = predictor.get_maintenance_schedule(df)
    print(schedule.urgent)  # Actions needed within 3 days
"""

__version__ = "1.8.0"

# Rule-based detection
from .rule_based import (
    RuleBasedFaultDetector,
    FaultType,
    FaultSeverity,
    FaultAlert,
    BatchDetectionResult,
)

# Configuration
from .config import (
    FaultDetectionConfig,
    InverterThresholds,
    StringThresholds,
    TrackerThresholds,
    GridThresholds,
    CommunicationThresholds,
    # v1.4 - New threshold categories
    MPPTThresholds,
    EfficiencyThresholds,
    ThermalTwinThresholds,
    SensorHealthThresholds,
    SoilingThresholds,
    CurtailmentThresholds,
    ModuleHealthThresholds,
    VegetationShadingThresholds,
    DCVoltageThresholds,
)

# Digital Twins (v1.4)
from .digital_twins import (
    InverterThermalTwin,
    ThermalStatus,
    ThermalAnomalyResult,
    TwinTrainingMetrics,
)

# Plant-agnostic features
from .features import (
    PlantAgnosticFeatureEngine,
    PlantConfig,
    FeatureSet,
    create_feature_engine_from_metadata,
)

# ML-based classification
from .pretraining import (
    FaultClassifier,
    FaultDatasetLoader,
    PretrainingConfig,
    TrainingResult,
    pretrain_foundation_models,
    UNIFIED_FAULT_CLASSES,
    SYSTEM_LEVEL_CLASSES,
    STRING_LEVEL_CLASSES,
)

# RUL (Remaining Useful Life) prediction
from .rul_labels import (
    RULLabelGenerator,
    RULLabelConfig,
    create_rul_labels_for_training,
)

from .rul_models import (
    RULPrediction,
    RULModelConfig,
    BaseRULModel,
    RULStringDegradationModel,
    RULInverterThermalModel,
    RULModuleDegradationModel,
    # New models (v0.4.0)
    RULThermalHotspotModel,
    RULMismatchModel,
    RULBypassDiodeModel,
    RULInsulationModel,
    # Model utilities
    create_rul_model,
    list_available_models,
    get_model_config,
    ALL_RUL_CONFIGS,
    ALL_RUL_MODELS,
)

# PVDAQ data loader for thermal models
from .data_pvdaq import (
    PVDAQLoader,
    PVDAQSystemConfig,
    SYSTEMS_WITH_THERMAL,
    list_systems_with_thermal,
    download_pvdaq_sample,
)

from .rul_training import (
    RULTrainingPipeline,
    RULTrainingConfig,
    RULTrainingResult,
    train_all_rul_models,
)

# Multi-horizon evaluation
from .rul_evaluation import (
    MultiHorizonEvaluator,
    MultiHorizonResult,
    HorizonMetrics,
    evaluate_rul_model,
    check_success_criteria,
    SUCCESS_CRITERIA,
    DEFAULT_HORIZONS,
)

from .rul_predictor import (
    RULPredictor,
    MaintenanceAction,
    MaintenanceSchedule,
    create_predictor,
)

# Unified Predictive Maintenance Pipeline (v1.5)
from .predictive_maintenance import (
    PredictiveMaintenancePipeline,
    PredictiveMaintenanceResult,
    ClassifiedFault,
    create_pipeline,
    analyze_plant,
)

# Maintenance Schedule Optimizer (v1.6)
from .maintenance_scheduler import (
    MaintenanceScheduleOptimizer,
    MaintenanceTask,
    ScheduledMaintenance,
    ScheduleResult,
    ScheduleMetrics,
    PlantInfo,
    create_ticket_payload,
)

from .scheduler_config import (
    SchedulerConfig,
    REPAIR_COSTS,
    REPAIR_HOURS,
    DAILY_ENERGY_LOSS_KWH_PER_MW,
    FAULT_SEVERITY,
    get_repair_cost,
    get_repair_hours,
    get_fault_severity,
    calculate_revenue_at_risk,
    calculate_priority_score,
)

# BESS predictive fault detection (v1.8)
from .bess_rul_models import (
    RULCapacityFadeModel,
    RULThermalStressModel,
    RULCycleLifeModel,
    RULRteDecayModel,
    RULCellImbalanceModel,
    ALL_BESS_RUL_MODELS,
    create_bess_rul_model,
)

from .bess_fault_detector import BessFaultDetector

# Fleet-based fault detection (v1.7 - soiling vs equipment separation)
from .fleet_fault_detector import (
    FleetFaultDetector,
    FaultDetectionConfig as FleetFaultConfig,
    FleetDeviationResult,
    RainResponseResult,
    LossType,
    compute_fleet_cv,
    FleetAnalysisResult,
    analyze_fleet_with_fault_separation,
)

__all__ = [
    # Version
    "__version__",
    # Rule-based
    "RuleBasedFaultDetector",
    "FaultType",
    "FaultSeverity",
    "FaultAlert",
    "BatchDetectionResult",
    # Config
    "FaultDetectionConfig",
    "InverterThresholds",
    "StringThresholds",
    "TrackerThresholds",
    "GridThresholds",
    "CommunicationThresholds",
    # v1.4 - New threshold categories
    "MPPTThresholds",
    "EfficiencyThresholds",
    "ThermalTwinThresholds",
    "SensorHealthThresholds",
    "SoilingThresholds",
    "CurtailmentThresholds",
    "ModuleHealthThresholds",
    "VegetationShadingThresholds",
    "DCVoltageThresholds",
    # Digital Twins (v1.4)
    "InverterThermalTwin",
    "ThermalStatus",
    "ThermalAnomalyResult",
    "TwinTrainingMetrics",
    # Features
    "PlantAgnosticFeatureEngine",
    "PlantConfig",
    "FeatureSet",
    "create_feature_engine_from_metadata",
    # ML Classification
    "FaultClassifier",
    "FaultDatasetLoader",
    "PretrainingConfig",
    "TrainingResult",
    "pretrain_foundation_models",
    "UNIFIED_FAULT_CLASSES",
    "SYSTEM_LEVEL_CLASSES",
    "STRING_LEVEL_CLASSES",
    # RUL (Predictive Maintenance)
    "RULLabelGenerator",
    "RULLabelConfig",
    "create_rul_labels_for_training",
    "RULPrediction",
    "RULModelConfig",
    "BaseRULModel",
    "RULStringDegradationModel",
    "RULInverterThermalModel",
    "RULModuleDegradationModel",
    # New models (v0.4.0)
    "RULThermalHotspotModel",
    "RULMismatchModel",
    "RULBypassDiodeModel",
    "RULInsulationModel",
    # Model utilities
    "create_rul_model",
    "list_available_models",
    "get_model_config",
    "ALL_RUL_CONFIGS",
    "ALL_RUL_MODELS",
    # PVDAQ loader
    "PVDAQLoader",
    "PVDAQSystemConfig",
    "SYSTEMS_WITH_THERMAL",
    "list_systems_with_thermal",
    "download_pvdaq_sample",
    # Training
    "RULTrainingPipeline",
    "RULTrainingConfig",
    "RULTrainingResult",
    "train_all_rul_models",
    # Multi-horizon evaluation
    "MultiHorizonEvaluator",
    "MultiHorizonResult",
    "HorizonMetrics",
    "evaluate_rul_model",
    "check_success_criteria",
    "SUCCESS_CRITERIA",
    "DEFAULT_HORIZONS",
    # Predictor
    "RULPredictor",
    "MaintenanceAction",
    "MaintenanceSchedule",
    "create_predictor",
    # Unified Predictive Maintenance (v1.5)
    "PredictiveMaintenancePipeline",
    "PredictiveMaintenanceResult",
    "ClassifiedFault",
    "create_pipeline",
    "analyze_plant",
    # Maintenance Schedule Optimizer (v1.6)
    "MaintenanceScheduleOptimizer",
    "MaintenanceTask",
    "ScheduledMaintenance",
    "ScheduleResult",
    "ScheduleMetrics",
    "PlantInfo",
    "create_ticket_payload",
    "SchedulerConfig",
    "REPAIR_COSTS",
    "REPAIR_HOURS",
    "DAILY_ENERGY_LOSS_KWH_PER_MW",
    "FAULT_SEVERITY",
    "get_repair_cost",
    "get_repair_hours",
    "get_fault_severity",
    "calculate_revenue_at_risk",
    "calculate_priority_score",
    # BESS predictive fault detection (v1.8)
    "RULCapacityFadeModel",
    "RULThermalStressModel",
    "RULCycleLifeModel",
    "RULRteDecayModel",
    "RULCellImbalanceModel",
    "ALL_BESS_RUL_MODELS",
    "create_bess_rul_model",
    "BessFaultDetector",
    # Fleet-based fault detection (v1.7)
    "FleetFaultDetector",
    "FleetFaultConfig",
    "FleetDeviationResult",
    "RainResponseResult",
    "LossType",
    "compute_fleet_cv",
    "FleetAnalysisResult",
    "analyze_fleet_with_fault_separation",
]
