"""
Unified cleaning optimization subpackage.

Provides multi-horizon cleaning schedule optimization with zone support.

Horizons:
- 30 days: Tactical (weather-sensitive, crew availability)
- 90 days: Planning (seasonal patterns, budget cycles)
- 365 days: Strategic (annual ROI optimization)

Usage:
    from nuravolt.soiling.cleaning import UnifiedScheduler

    scheduler = UnifiedScheduler(site_config)
    result = scheduler.optimize(horizon=90, zone_level=True)
"""

from .base import (
    CleaningRecommendation,
    ScheduleResult,
    ZoneScheduleResult,
    CleaningOptimizer,
)
from .short_term import ShortTermOptimizer
from .long_term import LongTermOptimizer
from .zone_optimizer import ZoneOptimizer
from .unified import UnifiedScheduler

__all__ = [
    # Data classes
    'CleaningRecommendation',
    'ScheduleResult',
    'ZoneScheduleResult',
    # Optimizers
    'CleaningOptimizer',
    'ShortTermOptimizer',
    'LongTermOptimizer',
    'ZoneOptimizer',
    'UnifiedScheduler',
]
