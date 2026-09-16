"""
Data Quality Module for NuraVolt Soiling Analysis.

Provides spatial uniformity detection, irradiance quality checking,
and data source correlation analysis for solar PV plants.
"""

from .spatial_uniformity import (
    calculate_spatial_uniformity,
    detect_non_uniform_periods,
    get_zone_mapping,
)

from .irradiance_quality import (
    fetch_open_meteo_irradiance,
    compare_irradiance_sources,
    calculate_quality_metrics,
)

from .correlation_analysis import (
    analyze_data_source_correlation,
    calculate_zone_correlations,
    generate_recommendations,
)

__all__ = [
    # Spatial uniformity
    'calculate_spatial_uniformity',
    'detect_non_uniform_periods',
    'get_zone_mapping',
    # Irradiance quality
    'fetch_open_meteo_irradiance',
    'compare_irradiance_sources',
    'calculate_quality_metrics',
    # Correlation analysis
    'analyze_data_source_correlation',
    'calculate_zone_correlations',
    'generate_recommendations',
]
