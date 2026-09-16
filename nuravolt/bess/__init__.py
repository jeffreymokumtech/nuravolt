"""
Battery Energy Storage System (BESS) Analytics Module

Comprehensive battery monitoring, optimization, and predictive maintenance
for grid-scale and commercial energy storage systems.

Key capabilities:
- State of Health (SoH) estimation with physics-informed ML
- Charge/discharge dispatch optimization (LP/MILP)
- Thermal runaway early warning
- Warranty compliance tracking and violation detection
- Degradation modeling and RUL prediction
- Rainflow cycle counting for warranty budgeting
- Degradation-aware arbitrage optimization
"""

# Dispatch Optimization (No ML required)
from nuravolt.bess.dispatch_optimizer import (
    BESSDispatchOptimizer,
    MPCDispatcher,
    DispatchResult,
)

# State of Health Estimation
from nuravolt.bess.soh_estimator import (
    SoHEstimator,
    BatteryFeatures,
    SoHEstimatorConfig,
)

# Thermal Monitoring & Runaway Prediction
from nuravolt.bess.thermal_monitor import (
    ThermalRuleBasedMonitor,
    ThermalAnomalyDetector,
    ThermalResidualMonitor,
    ThermalThresholds,
)

# Warranty Tracking & Compliance
from nuravolt.bess.warranty_tracker import (
    WarrantyTracker,
    WarrantyTerms,
    WarrantyStatus,
    EmpiricalDegradationModel,
)

# Configuration
from nuravolt.bess.config import (
    BessChemistry,
    BessAssetConfig,
    WarrantyTermsConfig,
    ViolationDetectionConfig,
    CyclingAnalysisConfig,
    ArbitrageConfig,
    DegradationModelConfig,
    BESSPipelineConfig,
    WarrantyViolation,
    CycleRecord,
    WarrantyHealthScore,
    DispatchSchedule as DispatchScheduleResult,
    BESSAnalysisResult,
)

# Warranty Violation Detection
from nuravolt.bess.warranty_violation_detector import (
    WarrantyViolationDetector,
    ViolationType,
    Severity,
)

# Cycling Analysis
from nuravolt.bess.cycling_analysis import (
    RainflowCycleCounter,
    CyclingAnalyzer,
    RainflowCycle,
    DailyCycleMetrics,
)

# Degradation-Aware Arbitrage
from nuravolt.bess.arbitrage_optimizer import (
    DegradationAwareArbitrage,
    DegradationCostCalculator,
    CycleCost,
    ArbitrageOpportunity,
)

# Sub asset imbalance (rack, module, cell grain)
from nuravolt.bess.imbalance import (
    DeviceSample,
    ImbalanceMetric,
    ImbalanceOutlier,
    ImbalanceReport,
    MetricAvailability,
    RackDayImbalance,
    analyze_imbalance,
    imbalance_index,
    ALIGNMENT_RULE,
    DWELL_UNRESOLVABLE,
    MEMBER_KIND_DEVICE,
    MEMBER_KIND_EXTREME,
    MEMBER_KIND_RACK,
    SIBLING_CENTRE,
    SPREAD_BASIS_EXTREMES,
    SPREAD_BASIS_MEMBERS,
    SPREAD_BASIS_MIXED,
    SPREAD_DEFINITION,
    SUB_ASSET_UNAVAILABLE,
    TOO_FEW_SIBLINGS,
)
from nuravolt.bess.rack_samples import rack_samples_from_silver

# Pipeline
from nuravolt.bess.pipeline import BESSIntelligencePipeline

__all__ = [
    # Dispatch Optimization
    "BESSDispatchOptimizer",
    "MPCDispatcher",
    "DispatchResult",
    # SoH Estimation
    "SoHEstimator",
    "BatteryFeatures",
    "SoHEstimatorConfig",
    # Thermal Monitoring
    "ThermalRuleBasedMonitor",
    "ThermalAnomalyDetector",
    "ThermalResidualMonitor",
    "ThermalThresholds",
    # Warranty Tracking
    "WarrantyTracker",
    "WarrantyTerms",
    "WarrantyStatus",
    "EmpiricalDegradationModel",
    # Configuration
    "BessChemistry",
    "BessAssetConfig",
    "WarrantyTermsConfig",
    "ViolationDetectionConfig",
    "CyclingAnalysisConfig",
    "ArbitrageConfig",
    "DegradationModelConfig",
    "BESSPipelineConfig",
    # Result Types
    "WarrantyViolation",
    "CycleRecord",
    "WarrantyHealthScore",
    "DispatchScheduleResult",
    "BESSAnalysisResult",
    # Violation Detection
    "WarrantyViolationDetector",
    "ViolationType",
    "Severity",
    # Cycling Analysis
    "RainflowCycleCounter",
    "CyclingAnalyzer",
    "RainflowCycle",
    "DailyCycleMetrics",
    # Arbitrage Optimization
    "DegradationAwareArbitrage",
    "DegradationCostCalculator",
    "CycleCost",
    "ArbitrageOpportunity",
    # Sub asset imbalance
    "DeviceSample",
    "ImbalanceMetric",
    "ImbalanceOutlier",
    "ImbalanceReport",
    "MetricAvailability",
    "RackDayImbalance",
    "analyze_imbalance",
    "imbalance_index",
    "rack_samples_from_silver",
    # Imbalance policy constants. SPREAD_DEFINITION and SIBLING_CENTRE are the
    # definitions of record: the warehouse quotes them rather than restating
    # them, so the two planes cannot drift apart.
    "SPREAD_DEFINITION",
    "SIBLING_CENTRE",
    "ALIGNMENT_RULE",
    "MEMBER_KIND_DEVICE",
    "MEMBER_KIND_EXTREME",
    "MEMBER_KIND_RACK",
    "SPREAD_BASIS_EXTREMES",
    "SPREAD_BASIS_MEMBERS",
    "SPREAD_BASIS_MIXED",
    "SUB_ASSET_UNAVAILABLE",
    "TOO_FEW_SIBLINGS",
    "DWELL_UNRESOLVABLE",
    # Pipeline
    "BESSIntelligencePipeline",
]
