"""
Unified cleaning scheduler.

Orchestrates short-term, long-term, and zone-aware optimization
with automatic horizon-based strategy selection.
"""

import sys
from datetime import timedelta
from typing import Dict, List, Optional, Any, Literal
import pandas as pd

from .base import ScheduleResult, ZoneScheduleResult, CrewAssignment
from .short_term import ShortTermOptimizer
from .long_term import LongTermOptimizer
from .zone_optimizer import ZoneOptimizer


HorizonType = Literal[30, 90, 365]


class UnifiedScheduler:
    """
    Unified cleaning schedule optimizer.

    Automatically selects optimization strategy based on:
    - Horizon length (30d = tactical, 90d = planning, 365d = strategic)
    - Zone availability (uses zone optimizer if SR data provided)
    - Weather data availability (rain/AOD forecasts)

    Usage:
        from nuravolt.soiling.cleaning import UnifiedScheduler

        scheduler = UnifiedScheduler(site_config)

        # Plant-level optimization
        result = scheduler.optimize(df_forecast, horizon=90)

        # Zone-level optimization
        result = scheduler.optimize(df_forecast, horizon=90, sr_data=df_sr, zone_level=True)

        # Get zone-by-zone breakdown
        zone_results = scheduler.optimize_zones(df_forecast, df_sr, horizon=90)
    """

    def __init__(self, site_config):
        """
        Initialize unified scheduler.

        Parameters:
            site_config: SoilingConfig with plant parameters including:
                - capacity_MW
                - cleaning_cost_per_MW
                - electricity_rate_per_MWh
                - min_days_between (optional, default 14)
        """
        self.config = site_config
        self.short_term = ShortTermOptimizer(site_config)
        self.long_term = LongTermOptimizer(site_config)
        self.zone_optimizer = ZoneOptimizer(site_config)

    def optimize(
        self,
        df_forecast: pd.DataFrame,
        horizon: HorizonType = 90,
        sr_data: Optional[pd.DataFrame] = None,
        zone_level: bool = False,
        df_rain_forecast: Optional[pd.DataFrame] = None,
        df_aod_forecast: Optional[pd.DataFrame] = None,
        **kwargs
    ) -> ScheduleResult:
        """
        Optimize cleaning schedule with automatic strategy selection.

        Parameters:
            df_forecast: ML forecast with sr_predicted, energy_if_clean_MWh
            horizon: Planning horizon (30, 90, or 365 days)
            sr_data: Historical SR data for zone detection (optional)
            zone_level: Use zone-aware optimization if True
            df_rain_forecast: Rain forecast for timing (optional)
            df_aod_forecast: AOD forecast for dust avoidance (optional)
            **kwargs: Additional optimizer-specific parameters

        Returns:
            ScheduleResult with optimized cleaning recommendations
        """
        print(f"🗓️ Unified Scheduler: {horizon}d horizon, zone_level={zone_level}", file=sys.stderr)

        # Select strategy based on horizon and zone availability
        if zone_level and sr_data is not None:
            # Zone-aware optimization
            result = self.zone_optimizer.optimize(
                df_forecast=df_forecast,
                horizon_days=horizon,
                sr_data=sr_data,
                **kwargs
            )
        elif horizon <= 90:
            # Short-term tactical
            result = self.short_term.optimize(
                df_forecast=df_forecast,
                horizon_days=horizon,
                df_rain_forecast=df_rain_forecast,
                df_aod_forecast=df_aod_forecast,
                **kwargs
            )
        else:
            # Long-term strategic
            result = self.long_term.optimize(
                df_forecast=df_forecast,
                horizon_days=horizon,
                df_rain_forecast=df_rain_forecast,
                df_aod_forecast=df_aod_forecast,
                **kwargs
            )

        return result

    def optimize_zones(
        self,
        df_forecast: pd.DataFrame,
        sr_data: pd.DataFrame,
        horizon: HorizonType = 90,
        **kwargs
    ) -> List[ZoneScheduleResult]:
        """
        Get individual zone schedules for per-zone display.

        Parameters:
            df_forecast: ML forecast
            sr_data: SR data with inverter columns
            horizon: Planning horizon

        Returns:
            List of ZoneScheduleResult, sorted by priority
        """
        return self.zone_optimizer.optimize_zones(
            df_forecast=df_forecast,
            sr_data=sr_data,
            horizon_days=horizon,
            **kwargs
        )

    def optimize_with_crew_routing(
        self,
        df_forecast: pd.DataFrame,
        sr_data: pd.DataFrame,
        horizon: HorizonType = 90,
        crew_size: int = 2,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Optimize zones and generate crew routing.

        Returns:
            Dict with 'schedule', 'zones', and 'crew_assignments'
        """
        # Get zone schedules
        zone_results = self.optimize_zones(df_forecast, sr_data, horizon, **kwargs)

        # Optimize crew routing
        crew_assignments = self.zone_optimizer.optimize_crew_routing(
            zone_results,
            crew_size=crew_size
        )

        # Aggregate schedule
        schedule = self.optimize(
            df_forecast,
            horizon=horizon,
            sr_data=sr_data,
            zone_level=True,
            **kwargs
        )

        return {
            'schedule': schedule.to_dict(),
            'zones': [z.to_dict() for z in zone_results],
            'crew_assignments': [a.to_dict() for a in crew_assignments],
        }

    def get_horizon_description(self, horizon: HorizonType) -> Dict[str, str]:
        """Get description of optimization strategy for a horizon."""
        descriptions = {
            30: {
                'mode': 'Tactical',
                'focus': 'Weather-sensitive scheduling, urgent cleanings',
                'features': [
                    'Rain deferral (wait after forecasted rain)',
                    'AOD avoidance (skip dusty periods)',
                    'Urgent detection (SR < 90%)',
                    'Crew availability (weekday preference)',
                ],
                'confidence': 'High (short-term forecasts more accurate)',
            },
            90: {
                'mode': 'Planning',
                'focus': 'Seasonal patterns, budget cycles',
                'features': [
                    'Seasonal SR pattern integration',
                    'Budget-aware scheduling',
                    'Zone-level optimization',
                    'Weather forecast integration',
                ],
                'confidence': 'Medium (moderate forecast uncertainty)',
            },
            365: {
                'mode': 'Strategic',
                'focus': 'Annual ROI optimization',
                'features': [
                    'Summer peak prioritization (May-Sept)',
                    'Multi-cleaning combination testing',
                    'Annual budget allocation',
                    'Long-term ROI optimization',
                ],
                'confidence': 'Lower (long-term forecast uncertainty)',
            },
        }
        return descriptions.get(horizon, descriptions[90])

    def compare_horizons(
        self,
        df_forecast: pd.DataFrame,
        sr_data: Optional[pd.DataFrame] = None,
        **kwargs
    ) -> Dict[str, ScheduleResult]:
        """
        Run optimization for all horizons for comparison.

        Returns dict with keys '30d', '90d', '365d'.
        """
        results = {}

        for horizon in [30, 90, 365]:
            result = self.optimize(
                df_forecast=df_forecast,
                horizon=horizon,
                sr_data=sr_data,
                zone_level=sr_data is not None,
                **kwargs
            )
            results[f'{horizon}d'] = result

        return results

    def get_summary(self, result: ScheduleResult) -> Dict[str, Any]:
        """
        Generate human-readable summary of optimization result.

        Returns:
            Dict with executive summary, recommendations, and financial analysis
        """
        n_cleanings = len(result.recommendations)

        # Group by priority
        by_priority = {'urgent': [], 'high': [], 'medium': [], 'low': []}
        for rec in result.recommendations:
            by_priority[rec.priority].append(rec)

        # Financial summary
        financial = {
            'total_investment_EUR': round(result.total_cost_EUR, 2),
            'expected_return_EUR': round(result.total_benefit_EUR, 2),
            'net_benefit_EUR': round(result.net_benefit_EUR, 2),
            'roi_pct': round(result.roi_pct, 1),
            'payback_days': round(
                result.total_cost_EUR / (result.total_benefit_EUR / result.horizon_days)
                if result.total_benefit_EUR > 0 else 999,
                0
            ),
        }

        # Recommendations by priority
        priority_summary = {
            priority: {
                'count': len(recs),
                'dates': [r.date.strftime('%Y-%m-%d') for r in recs],
            }
            for priority, recs in by_priority.items()
            if len(recs) > 0
        }

        # Top recommendation
        top_rec = None
        if result.recommendations:
            r = result.recommendations[0]
            top_rec = {
                'date': r.date.strftime('%Y-%m-%d'),
                'zone': r.zone_name or 'Plant-wide',
                'priority': r.priority,
                'reason': r.reason,
            }

        return {
            'horizon_days': result.horizon_days,
            'optimizer_type': result.optimizer_type,
            'n_cleanings': n_cleanings,
            'financial': financial,
            'priority_breakdown': priority_summary,
            'top_recommendation': top_rec,
            'performance': {
                'avg_sr_baseline': round(result.avg_sr_baseline, 4),
                'avg_sr_optimized': round(result.avg_sr_optimized, 4),
                'energy_recovered_MWh': round(result.energy_recovered_MWh, 2),
            },
        }


def create_scheduler(site_config) -> UnifiedScheduler:
    """Factory function to create a unified scheduler."""
    return UnifiedScheduler(site_config)
