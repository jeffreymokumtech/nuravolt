"""
Wind Energy Analytics Module

Comprehensive wind turbine and farm monitoring, performance analysis,
and predictive maintenance capabilities.

Key capabilities:
- Power curve analysis (analog to PV Performance Ratio)
- Gearbox/bearing predictive maintenance via Normal Behavior Modeling
- Wake effect modeling for farm-level optimization
- SCADA-based anomaly detection
- CARE dataset processing for real-world demo data
"""

# Power Curve Analysis
from nuravolt.wind.power_curve import (
    PowerCurveAnalyzer,
    PowerCurveAnomalyDetector,
    BinMethodAnalyzer,
    TurbineSpecs,
    PerformanceResult,
)

# Gearbox & Drivetrain Monitoring
from nuravolt.wind.gearbox_monitor import (
    GearboxNBMModel,
    MultiComponentMonitor,
    TrendAnalyzer,
    GearboxHealth,
    NBMConfig,
)

# Wake Effect Modeling
from nuravolt.wind.wake_model import (
    WakeFarmModel,
    WakeAwareForecaster,
    SimpleJensenWake,
    TurbinePosition,
    WakeResult,
    create_simple_power_curve,
)

# CARE Dataset Processing
from nuravolt.wind.care_processor import (
    CAREDataLoader,
    CAREColumnMapper,
    CAREDemoGenerator,
    LabeledFaultEvent,
    CAREDatasetInfo,
    COLUMN_MAPPING_HINTS,
)

__all__ = [
    # Power Curve
    "PowerCurveAnalyzer",
    "PowerCurveAnomalyDetector",
    "BinMethodAnalyzer",
    "TurbineSpecs",
    "PerformanceResult",
    # Gearbox Monitoring
    "GearboxNBMModel",
    "MultiComponentMonitor",
    "TrendAnalyzer",
    "GearboxHealth",
    "NBMConfig",
    # Wake Modeling
    "WakeFarmModel",
    "WakeAwareForecaster",
    "SimpleJensenWake",
    "TurbinePosition",
    "WakeResult",
    "create_simple_power_curve",
    # CARE Dataset Processing
    "CAREDataLoader",
    "CAREColumnMapper",
    "CAREDemoGenerator",
    "LabeledFaultEvent",
    "CAREDatasetInfo",
    "COLUMN_MAPPING_HINTS",
]
