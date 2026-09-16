"""
Base interfaces for cleaning schedule optimization.

Provides abstract classes and data structures used across all optimizer types.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Any
import pandas as pd


@dataclass
class CleaningRecommendation:
    """
    Single cleaning recommendation with cost/benefit analysis.

    Attributes:
        date: Recommended cleaning date
        zone_id: Zone identifier (None for plant-level)
        zone_name: Human-readable zone name
        priority: Urgency level ('urgent', 'high', 'medium', 'low')
        expected_benefit_EUR: Estimated energy recovery value
        cleaning_cost_EUR: Estimated cleaning cost
        net_benefit_EUR: Expected profit (benefit - cost)
        confidence: Confidence score (0-1)
        sr_before: Estimated soiling ratio before cleaning
        sr_after: Expected soiling ratio after cleaning (typically 0.98-1.0)
        reason: Explanation for recommendation
        weather_risk: Weather-related risk factors
    """
    date: pd.Timestamp
    zone_id: Optional[str] = None
    zone_name: Optional[str] = None
    priority: str = 'medium'  # 'urgent' | 'high' | 'medium' | 'low'
    expected_benefit_EUR: float = 0.0
    cleaning_cost_EUR: float = 0.0
    net_benefit_EUR: float = 0.0
    confidence: float = 0.7
    sr_before: Optional[float] = None
    sr_after: float = 0.98
    reason: str = ''
    weather_risk: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'date': self.date.isoformat() if isinstance(self.date, pd.Timestamp) else str(self.date),
            'zone_id': self.zone_id,
            'zone_name': self.zone_name,
            'priority': self.priority,
            'expected_benefit_EUR': round(self.expected_benefit_EUR, 2),
            'cleaning_cost_EUR': round(self.cleaning_cost_EUR, 2),
            'net_benefit_EUR': round(self.net_benefit_EUR, 2),
            'confidence': round(self.confidence, 3),
            'sr_before': round(self.sr_before, 4) if self.sr_before else None,
            'sr_after': round(self.sr_after, 4),
            'reason': self.reason,
            'weather_risk': self.weather_risk,
        }


@dataclass
class ScheduleResult:
    """
    Complete cleaning schedule optimization result.

    Attributes:
        recommendations: Ordered list of cleaning recommendations
        total_benefit_EUR: Sum of expected benefits
        total_cost_EUR: Sum of cleaning costs
        net_benefit_EUR: Total profit (benefit - cost)
        roi_pct: Return on investment percentage
        horizon_days: Optimization horizon in days
        optimizer_type: Type of optimizer used ('short_term', 'long_term', 'zone')
        metadata: Additional optimizer-specific data
    """
    recommendations: List[CleaningRecommendation] = field(default_factory=list)
    total_benefit_EUR: float = 0.0
    total_cost_EUR: float = 0.0
    net_benefit_EUR: float = 0.0
    roi_pct: float = 0.0
    horizon_days: int = 90
    optimizer_type: str = 'unified'
    avg_sr_baseline: float = 0.0
    avg_sr_optimized: float = 0.0
    energy_recovered_MWh: float = 0.0
    created_at: datetime = field(default_factory=datetime.now)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'recommendations': [r.to_dict() for r in self.recommendations],
            'summary': {
                'total_benefit_EUR': round(self.total_benefit_EUR, 2),
                'total_cost_EUR': round(self.total_cost_EUR, 2),
                'net_benefit_EUR': round(self.net_benefit_EUR, 2),
                'roi_pct': round(self.roi_pct, 1),
                'n_cleanings': len(self.recommendations),
            },
            'horizon_days': self.horizon_days,
            'optimizer_type': self.optimizer_type,
            'performance': {
                'avg_sr_baseline': round(self.avg_sr_baseline, 4),
                'avg_sr_optimized': round(self.avg_sr_optimized, 4),
                'energy_recovered_MWh': round(self.energy_recovered_MWh, 2),
            },
            'created_at': self.created_at.isoformat(),
            'metadata': self.metadata,
        }


@dataclass
class ZoneScheduleResult:
    """
    Zone-level cleaning schedule result.

    Attributes:
        zone_id: Zone identifier
        zone_name: Human-readable zone name
        schedule: Cleaning schedule for this zone
        zone_metrics: Zone-specific performance metrics
    """
    zone_id: str
    zone_name: str
    schedule: ScheduleResult
    zone_metrics: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'zone_id': self.zone_id,
            'zone_name': self.zone_name,
            'schedule': self.schedule.to_dict(),
            'zone_metrics': self.zone_metrics,
        }


@dataclass
class CrewAssignment:
    """
    Crew routing assignment for a cleaning day.

    Attributes:
        date: Cleaning date
        zones: List of zones to clean (in order)
        total_area_m2: Total area to clean
        estimated_duration_hours: Estimated time required
        crew_size: Number of crew members needed
    """
    date: pd.Timestamp
    zones: List[str] = field(default_factory=list)
    total_area_m2: float = 0.0
    estimated_duration_hours: float = 0.0
    crew_size: int = 2

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'date': self.date.isoformat() if isinstance(self.date, pd.Timestamp) else str(self.date),
            'zones': self.zones,
            'total_area_m2': round(self.total_area_m2, 1),
            'estimated_duration_hours': round(self.estimated_duration_hours, 1),
            'crew_size': self.crew_size,
        }


class CleaningOptimizer(ABC):
    """
    Abstract base class for cleaning schedule optimizers.

    Subclasses implement specific optimization strategies:
    - ShortTermOptimizer: 30-90 day tactical optimization
    - LongTermOptimizer: 365 day strategic optimization
    - ZoneOptimizer: Zone-aware scheduling
    """

    def __init__(self, site_config):
        """
        Initialize optimizer with site configuration.

        Parameters:
            site_config: SoilingConfig with plant parameters including:
                - capacity_MW
                - cleaning_cost_per_MW
                - electricity_rate_per_MWh
                - min_days_between (cleanings)
        """
        self.config = site_config
        self.capacity_MW = site_config.capacity_MW
        self.cleaning_cost_per_MW = site_config.cleaning_cost_per_MW
        self.ppa_rate = site_config.electricity_rate_per_MWh
        self.min_days_between = getattr(site_config, 'min_days_between', 14)

    @abstractmethod
    def optimize(
        self,
        df_forecast: pd.DataFrame,
        horizon_days: int,
        **kwargs
    ) -> ScheduleResult:
        """
        Optimize cleaning schedule for given horizon.

        Parameters:
            df_forecast: Forecast DataFrame with columns:
                - date (index): Forecast dates
                - sr_predicted: Predicted soiling ratio
                - energy_if_clean_MWh: Energy if panels were clean
            horizon_days: Number of days to optimize
            **kwargs: Optimizer-specific parameters

        Returns:
            ScheduleResult with optimized cleaning recommendations
        """
        pass

    def _calculate_cleaning_cost(self, n_cleanings: int = 1) -> float:
        """Calculate total cleaning cost."""
        return n_cleanings * self.capacity_MW * self.cleaning_cost_per_MW

    def _calculate_energy_recovery(
        self,
        sr_before: float,
        sr_after: float,
        days_until_next: int,
        avg_daily_energy: float,
        soiling_rate: float = 0.002
    ) -> float:
        """
        Estimate energy recovered from a single cleaning.

        Parameters:
            sr_before: Soiling ratio before cleaning
            sr_after: Soiling ratio after cleaning (typically 0.98)
            days_until_next: Days until next cleaning or end of horizon
            avg_daily_energy: Average daily energy production (MWh)
            soiling_rate: Daily soiling rate (default 0.2%/day)

        Returns:
            Estimated energy recovery in MWh
        """
        # Immediate SR improvement
        sr_jump = sr_after - sr_before

        # Calculate area under curve (trapezoidal)
        # Without cleaning: SR continues to degrade
        # With cleaning: SR resets to sr_after, then degrades
        energy_without = 0.0
        energy_with = 0.0
        sr_current = sr_before

        for day in range(days_until_next):
            # Without cleaning
            energy_without += avg_daily_energy * sr_current
            sr_current = max(0.85, sr_current - soiling_rate)

        sr_current = sr_after
        for day in range(days_until_next):
            # With cleaning
            energy_with += avg_daily_energy * sr_current
            sr_current = max(0.85, sr_current - soiling_rate)

        return energy_with - energy_without

    def _get_priority(self, sr: float, days_since_cleaning: int = 0) -> str:
        """
        Determine cleaning priority based on soiling ratio.

        Thresholds:
        - urgent: SR < 0.90 (10%+ loss)
        - high: SR < 0.93 (7%+ loss)
        - medium: SR < 0.96 (4%+ loss)
        - low: SR >= 0.96 (<4% loss)
        """
        if sr < 0.90:
            return 'urgent'
        elif sr < 0.93:
            return 'high'
        elif sr < 0.96:
            return 'medium'
        else:
            return 'low'


# Priority ordering for sorting
PRIORITY_ORDER = {
    'urgent': 0,
    'high': 1,
    'medium': 2,
    'low': 3,
}


def sort_by_priority(recommendations: List[CleaningRecommendation]) -> List[CleaningRecommendation]:
    """Sort recommendations by priority (urgent first), then by date."""
    return sorted(
        recommendations,
        key=lambda r: (PRIORITY_ORDER.get(r.priority, 99), r.date)
    )
