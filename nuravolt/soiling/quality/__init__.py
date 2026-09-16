"""
Quality Analysis Module for Solar PV Soiling.

This module provides zone detection and analysis capabilities:
- Auto-detection of inverter zones from naming patterns
- Zone-level soiling ratio estimation
- Zone performance comparison
- Cleaning recommendations
"""

from .zone_detection import (
    SoilingZone,
    ZonePerformance,
    ZoneAnalysisResult,
    ZoneDetector,
    ZoneAnalyzer,
    detect_and_analyze_zones,
    DEFAULT_ZONE_PATTERNS,
)

__all__ = [
    'SoilingZone',
    'ZonePerformance',
    'ZoneAnalysisResult',
    'ZoneDetector',
    'ZoneAnalyzer',
    'detect_and_analyze_zones',
    'DEFAULT_ZONE_PATTERNS',
]
