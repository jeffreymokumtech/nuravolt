"""
Soiling Intelligence Module

Comprehensive soiling detection, forecasting, and cleaning optimization
for solar PV systems.
"""

# Core pipeline
from nuravolt.soiling.pipeline import SoilingIntelligencePipeline

# Configuration
from nuravolt.soiling.config import SoilingConfig, SITE_CONFIG

# Data acquisition
from nuravolt.soiling.data_acquisition import (
    download_cams_aerosol_data,
    download_nasa_power_weather,
)

# Calculations
from nuravolt.soiling.clearsky import calculate_clearsky_poa
from nuravolt.soiling.soiling_ratio import calculate_soiling_ratio

# Event detection
from nuravolt.soiling.event_detection import (
    detect_cleaning_events,
    get_cleaning_dates,
    print_cleaning_summary,
)

# Feature engineering
from nuravolt.soiling.features import (
    create_historical_soiling_features,
    create_weather_features,
    create_temporal_physics_features,
    create_all_features,
)

# Forecasting
from nuravolt.soiling.forecasting import (
    prepare_training_data,
    train_lightgbm_model,
    evaluate_model,
    get_feature_importance,
    predict_soiling,
)

# SR ML Model (DustIQ-trained, transfer learning)
from nuravolt.soiling.sr_ml_features import (
    SoilingRatioFeatureEngineer,
    PlantLocation,
    create_sr_features_from_json,
)
from nuravolt.soiling.sr_ml_model import (
    SoilingRatioModel,
    SoilingRatioModelConfig,
    evaluate_model as evaluate_sr_model,
)
from nuravolt.soiling.sr_ml_training import (
    SoilingRatioTrainer,
    train_foundation_model,
)
from nuravolt.soiling.sr_transfer_learning import (
    PseudoLabelGenerator,
    SemiSupervisedSRTrainer,
    transfer_model_to_plant,
)

# ML Models (unified interface)
from nuravolt.soiling.ml_models import (
    ModelFactory,
    ModelComparator,
    LightGBMSoilingModel,
    CatBoostSoilingModel,
    compare_models,
    LIGHTGBM_AVAILABLE,
    CATBOOST_AVAILABLE,
)

# Long-term forecasting
from nuravolt.soiling.forecasting_longterm import (
    PhysicsMLHybridForecaster,
    simulate_cleaning_scenarios,
)

# Financial forecasting
from nuravolt.soiling.financial_forecast import FinancialForecaster

# Schedule optimization
from nuravolt.soiling.schedule_optimizer import CleaningScheduleOptimizer

# 365-day visualizations
from nuravolt.soiling.visualizations_365d import Forecast365Visualizer

# IEA Loss Disaggregation
from nuravolt.soiling.loss_disaggregation import (
    IEALossDisaggregator,
    CurtailmentLoader,
    LossComponents,
    PHYSICS_CONSTANTS,
    INVERTER_EFFICIENCY_CURVE,
)

# Economics
from nuravolt.soiling.economics import (
    calculate_breakeven_days,
    print_breakeven_analysis,
    optimize_cleaning_schedule,
    print_cleaning_schedule,
    calculate_roi_analysis,
)

# Visualization
from nuravolt.soiling.visualization import (
    plot_soiling_detection,
    plot_cleaning_events,
    plot_forecast,
    plot_dashboard,
    plot_roi_comparison,
)

# Per-Inverter Analysis
from nuravolt.soiling.per_inverter_analysis import (
    PerInverterSoilingAnalyzer,
    InverterSoilingMetrics,
    FleetSoilingSummary,
)

# ECharts Configuration Generator
from nuravolt.soiling.echarts_generator import EChartsConfigGenerator

# Spatial Soiling Model (non-uniform soiling)
from nuravolt.soiling.spatial_soiling import (
    SpatialSoilingModel,
    SpatialSoilingConfig,
    SoilingZone,
)

# Data Quality Hub
from nuravolt.soiling.data_quality import (
    # Spatial uniformity
    calculate_spatial_uniformity,
    detect_non_uniform_periods,
    get_zone_mapping,
    # Irradiance quality
    fetch_open_meteo_irradiance,
    compare_irradiance_sources,
    calculate_quality_metrics,
    # Correlation analysis
    analyze_data_source_correlation,
    calculate_zone_correlations,
    generate_recommendations,
)

__all__ = [
    # Pipeline
    "SoilingIntelligencePipeline",
    # Configuration
    "SoilingConfig",
    "SITE_CONFIG",
    # Data acquisition
    "download_cams_aerosol_data",
    "download_nasa_power_weather",
    # Calculations
    "calculate_clearsky_poa",
    "calculate_soiling_ratio",
    # Event detection
    "detect_cleaning_events",
    "get_cleaning_dates",
    "print_cleaning_summary",
    # Features
    "create_historical_soiling_features",
    "create_weather_features",
    "create_temporal_physics_features",
    "create_all_features",
    # Forecasting
    "prepare_training_data",
    "train_lightgbm_model",
    "evaluate_model",
    "get_feature_importance",
    "predict_soiling",
    # ML Models
    "ModelFactory",
    "ModelComparator",
    "LightGBMSoilingModel",
    "CatBoostSoilingModel",
    "compare_models",
    "LIGHTGBM_AVAILABLE",
    "CATBOOST_AVAILABLE",
    # Long-term forecasting
    "PhysicsMLHybridForecaster",
    "simulate_cleaning_scenarios",
    "FinancialForecaster",
    "CleaningScheduleOptimizer",
    "Forecast365Visualizer",
    # Loss Disaggregation
    "IEALossDisaggregator",
    "CurtailmentLoader",
    "LossComponents",
    "PHYSICS_CONSTANTS",
    "INVERTER_EFFICIENCY_CURVE",
    # Economics
    "calculate_breakeven_days",
    "print_breakeven_analysis",
    "optimize_cleaning_schedule",
    "print_cleaning_schedule",
    "calculate_roi_analysis",
    # Visualization
    "plot_soiling_detection",
    "plot_cleaning_events",
    "plot_forecast",
    "plot_dashboard",
    "plot_roi_comparison",
    # Per-Inverter Analysis
    "PerInverterSoilingAnalyzer",
    "InverterSoilingMetrics",
    "FleetSoilingSummary",
    "EChartsConfigGenerator",
    # Spatial Soiling Model
    "SpatialSoilingModel",
    "SpatialSoilingConfig",
    "SoilingZone",
    # Data Quality Hub
    "calculate_spatial_uniformity",
    "detect_non_uniform_periods",
    "get_zone_mapping",
    "fetch_open_meteo_irradiance",
    "compare_irradiance_sources",
    "calculate_quality_metrics",
    "analyze_data_source_correlation",
    "calculate_zone_correlations",
    "generate_recommendations",
]
