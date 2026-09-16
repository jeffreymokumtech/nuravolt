"""
Zone-aware cleaning optimizer.

Integrates with quality/zone_detection.py to provide:
- Per-zone soiling analysis
- Zone-specific cleaning schedules
- Crew routing optimization
- Priority ordering by zone health
"""

import sys
from datetime import timedelta
from typing import Dict, List, Optional, Any
import pandas as pd
import numpy as np

from .base import (
    CleaningOptimizer,
    CleaningRecommendation,
    ScheduleResult,
    ZoneScheduleResult,
    CrewAssignment,
    sort_by_priority,
    PRIORITY_ORDER,
)
from ..quality.zone_detection import ZoneDetector, ZoneAnalyzer, SoilingZone


class ZoneOptimizer(CleaningOptimizer):
    """
    Zone-aware cleaning schedule optimizer.

    Features:
    - Auto-detects zones from inverter naming patterns
    - Calculates per-zone soiling rates
    - Generates zone-specific cleaning schedules
    - Optimizes crew routing between zones
    - Priority ordering (worst zones first)
    """

    def __init__(self, site_config):
        super().__init__(site_config)
        self.zone_detector = ZoneDetector()
        self.zone_analyzer = None  # Created per-analysis

    def optimize(
        self,
        df_forecast: pd.DataFrame,
        horizon_days: int = 90,
        sr_data: Optional[pd.DataFrame] = None,
        zones: Optional[List[SoilingZone]] = None,
        **kwargs
    ) -> ScheduleResult:
        """
        Optimize cleaning schedule with zone awareness.

        Parameters:
            df_forecast: ML forecast (used for timing optimization)
            horizon_days: Planning horizon
            sr_data: Historical SR data with inverter columns (for zone detection)
            zones: Pre-defined zones (if None, auto-detects)

        Returns:
            ScheduleResult with zone-aware recommendations
        """
        print(f"⚙️ Zone-aware optimization ({horizon_days} days)...", file=sys.stderr)

        # Detect zones if not provided
        if zones is None and sr_data is not None:
            zones = self._detect_zones(sr_data)
        elif zones is None:
            # Fall back to plant-level optimization
            print("   ⚠️ No SR data for zone detection, using plant-level", file=sys.stderr)
            return self._plant_level_optimization(df_forecast, horizon_days)

        print(f"   Found {len(zones)} zones", file=sys.stderr)

        # Analyze each zone
        zone_schedules = []
        all_recommendations = []

        for zone in zones:
            zone_schedule = self._optimize_zone(
                zone,
                df_forecast,
                sr_data,
                horizon_days
            )
            zone_schedules.append(zone_schedule)
            all_recommendations.extend(zone_schedule.schedule.recommendations)

        # Aggregate metrics
        total_benefit = sum(z.schedule.total_benefit_EUR for z in zone_schedules)
        total_cost = sum(z.schedule.total_cost_EUR for z in zone_schedules)
        net_benefit = total_benefit - total_cost
        roi = (net_benefit / total_cost * 100) if total_cost > 0 else 0

        # Sort recommendations by priority and date
        all_recommendations = sort_by_priority(all_recommendations)

        result = ScheduleResult(
            recommendations=all_recommendations,
            total_benefit_EUR=total_benefit,
            total_cost_EUR=total_cost,
            net_benefit_EUR=net_benefit,
            roi_pct=roi,
            horizon_days=horizon_days,
            optimizer_type='zone',
            metadata={
                'n_zones': len(zones),
                'zone_schedules': [z.to_dict() for z in zone_schedules],
            }
        )

        print(f"   ✅ Generated {len(all_recommendations)} zone-based recommendations", file=sys.stderr)
        print(f"   Net benefit: €{net_benefit:,.0f} (ROI: {roi:.0f}%)", file=sys.stderr)

        return result

    def optimize_zones(
        self,
        df_forecast: pd.DataFrame,
        sr_data: pd.DataFrame,
        horizon_days: int = 90,
        zones: Optional[List[SoilingZone]] = None
    ) -> List[ZoneScheduleResult]:
        """
        Get individual zone schedules (not aggregated).

        Returns list of ZoneScheduleResult for per-zone display.
        """
        if zones is None:
            zones = self._detect_zones(sr_data)

        zone_schedules = []
        for zone in zones:
            zone_schedule = self._optimize_zone(zone, df_forecast, sr_data, horizon_days)
            zone_schedules.append(zone_schedule)

        # Sort by priority (worst zones first)
        zone_schedules.sort(
            key=lambda z: (
                PRIORITY_ORDER.get(z.zone_metrics.get('cleaning_priority', 'low'), 3),
                -z.zone_metrics.get('avg_loss_pct', 0)
            )
        )

        return zone_schedules

    def _detect_zones(self, sr_data: pd.DataFrame) -> List[SoilingZone]:
        """Detect zones from SR data columns."""
        # Extract inverter columns (exclude date, timestamp, etc.)
        exclude_cols = {'date', 'timestamp', 'datetime', 'index'}
        inverter_cols = [
            col for col in sr_data.columns
            if col.lower() not in exclude_cols and not col.startswith('_')
        ]

        zones = self.zone_detector.detect_zones(inverter_cols)
        return zones

    def _optimize_zone(
        self,
        zone: SoilingZone,
        df_forecast: pd.DataFrame,
        sr_data: Optional[pd.DataFrame],
        horizon_days: int
    ) -> ZoneScheduleResult:
        """
        Optimize cleaning schedule for a single zone.
        """
        # Calculate zone-specific metrics
        zone_metrics = self._calculate_zone_metrics(zone, sr_data)

        # Determine cleaning priority
        avg_sr = zone_metrics.get('avg_sr', 0.95)
        priority = self._get_zone_priority(avg_sr, zone_metrics.get('soiling_rate', 0.002))

        # Generate recommendations for this zone
        recommendations = []

        # If zone needs cleaning based on current SR
        if priority in ('urgent', 'high'):
            # Recommend immediate cleaning
            rec = CleaningRecommendation(
                date=pd.Timestamp.now() + timedelta(days=3),
                zone_id=zone.zone_id,
                zone_name=zone.zone_name,
                priority=priority,
                expected_benefit_EUR=self._estimate_zone_benefit(zone_metrics),
                cleaning_cost_EUR=self._estimate_zone_cost(zone),
                confidence=0.80,
                sr_before=avg_sr,
                sr_after=0.98,
                reason=f"{zone.zone_name}: SR at {avg_sr:.1%}, {priority} priority",
            )
            rec.net_benefit_EUR = rec.expected_benefit_EUR - rec.cleaning_cost_EUR
            recommendations.append(rec)

        # Add scheduled maintenance cleanings
        if horizon_days >= 30:
            # Calculate optimal cleaning interval for zone
            interval = self._calculate_optimal_interval(zone_metrics)

            current_date = pd.Timestamp.now() + timedelta(days=interval)
            end_date = pd.Timestamp.now() + timedelta(days=horizon_days)

            while current_date < end_date:
                rec = CleaningRecommendation(
                    date=current_date,
                    zone_id=zone.zone_id,
                    zone_name=zone.zone_name,
                    priority='medium',
                    expected_benefit_EUR=self._estimate_zone_benefit(zone_metrics) * 0.8,
                    cleaning_cost_EUR=self._estimate_zone_cost(zone),
                    confidence=0.70,
                    sr_before=0.95,  # Estimated
                    sr_after=0.98,
                    reason=f"{zone.zone_name}: Scheduled maintenance",
                )
                rec.net_benefit_EUR = rec.expected_benefit_EUR - rec.cleaning_cost_EUR
                recommendations.append(rec)
                current_date += timedelta(days=interval)

        # Build zone schedule
        total_benefit = sum(r.expected_benefit_EUR for r in recommendations)
        total_cost = sum(r.cleaning_cost_EUR for r in recommendations)

        schedule = ScheduleResult(
            recommendations=recommendations,
            total_benefit_EUR=total_benefit,
            total_cost_EUR=total_cost,
            net_benefit_EUR=total_benefit - total_cost,
            roi_pct=(total_benefit - total_cost) / total_cost * 100 if total_cost > 0 else 0,
            horizon_days=horizon_days,
            optimizer_type='zone',
            avg_sr_baseline=avg_sr,
            avg_sr_optimized=0.97,
        )

        return ZoneScheduleResult(
            zone_id=zone.zone_id,
            zone_name=zone.zone_name,
            schedule=schedule,
            zone_metrics={
                'avg_sr': avg_sr,
                'avg_loss_pct': (1 - avg_sr) * 100,
                'cleaning_priority': priority,
                'inverter_count': zone.inverter_count,
                'soiling_rate': zone_metrics.get('soiling_rate', 0.002),
                'optimal_interval_days': self._calculate_optimal_interval(zone_metrics),
            }
        )

    def _calculate_zone_metrics(
        self,
        zone: SoilingZone,
        sr_data: Optional[pd.DataFrame]
    ) -> Dict[str, float]:
        """Calculate soiling metrics for a zone."""
        if sr_data is None or len(zone.inverters) == 0:
            return {
                'avg_sr': 0.95,
                'std_sr': 0.02,
                'min_sr': 0.90,
                'max_sr': 0.99,
                'soiling_rate': 0.002,
            }

        # Get columns for this zone's inverters
        zone_cols = [c for c in sr_data.columns if c in zone.inverters]

        if len(zone_cols) == 0:
            return {
                'avg_sr': 0.95,
                'std_sr': 0.02,
                'min_sr': 0.90,
                'max_sr': 0.99,
                'soiling_rate': 0.002,
            }

        zone_data = sr_data[zone_cols]

        # Calculate metrics
        avg_sr = zone_data.mean().mean()
        std_sr = zone_data.std().mean()
        min_sr = zone_data.min().min()
        max_sr = zone_data.max().max()

        # Estimate soiling rate from data
        if len(zone_data) > 7:
            daily_changes = zone_data.diff().mean().mean()
            soiling_rate = abs(daily_changes) if daily_changes < 0 else 0.002
        else:
            soiling_rate = 0.002

        return {
            'avg_sr': float(avg_sr),
            'std_sr': float(std_sr),
            'min_sr': float(min_sr),
            'max_sr': float(max_sr),
            'soiling_rate': float(soiling_rate),
        }

    def _get_zone_priority(self, avg_sr: float, soiling_rate: float) -> str:
        """Determine cleaning priority for a zone."""
        # Adjust thresholds based on soiling rate
        if avg_sr < 0.90 or soiling_rate > 0.005:
            return 'urgent'
        elif avg_sr < 0.93 or soiling_rate > 0.003:
            return 'high'
        elif avg_sr < 0.96:
            return 'medium'
        else:
            return 'low'

    def _calculate_optimal_interval(self, zone_metrics: Dict) -> int:
        """
        Calculate optimal cleaning interval for a zone.

        Based on soiling rate and cost/benefit analysis.
        """
        soiling_rate = zone_metrics.get('soiling_rate', 0.002)

        # Higher soiling rate = more frequent cleaning
        if soiling_rate > 0.004:
            return 21  # 3 weeks
        elif soiling_rate > 0.002:
            return 30  # 1 month
        elif soiling_rate > 0.001:
            return 45  # 6 weeks
        else:
            return 60  # 2 months

    def _estimate_zone_benefit(self, zone_metrics: Dict) -> float:
        """Estimate cleaning benefit for a zone."""
        avg_sr = zone_metrics.get('avg_sr', 0.95)
        sr_improvement = 0.98 - avg_sr

        # Rough estimate: improvement * capacity * days * rate
        daily_energy = self.capacity_MW * 4  # ~4 MWh/MW/day
        benefit_days = 30  # Assume benefit lasts ~30 days
        energy_recovered = sr_improvement * daily_energy * benefit_days

        return energy_recovered * self.ppa_rate

    def _estimate_zone_cost(self, zone: SoilingZone) -> float:
        """Estimate cleaning cost for a zone."""
        # Scale cost by zone size relative to plant
        zone_fraction = zone.inverter_count / max(zone.inverter_count * 2, 1)
        return self.capacity_MW * self.cleaning_cost_per_MW * zone_fraction

    def _plant_level_optimization(
        self,
        df_forecast: pd.DataFrame,
        horizon_days: int
    ) -> ScheduleResult:
        """Fallback to plant-level when no zone data available."""
        # Simple recommendation based on forecast
        recommendations = []

        if 'sr_predicted' in df_forecast.columns:
            # Find dates where SR is low
            low_sr_dates = df_forecast[df_forecast['sr_predicted'] < 0.95].index

            if len(low_sr_dates) > 0:
                # Recommend cleaning at first low SR date
                rec = CleaningRecommendation(
                    date=low_sr_dates[0],
                    priority='medium',
                    expected_benefit_EUR=self.capacity_MW * 500,  # Rough estimate
                    cleaning_cost_EUR=self._calculate_cleaning_cost(1),
                    confidence=0.70,
                    reason="Plant-level: SR predicted below 95%",
                )
                rec.net_benefit_EUR = rec.expected_benefit_EUR - rec.cleaning_cost_EUR
                recommendations.append(rec)

        total_benefit = sum(r.expected_benefit_EUR for r in recommendations)
        total_cost = sum(r.cleaning_cost_EUR for r in recommendations)

        return ScheduleResult(
            recommendations=recommendations,
            total_benefit_EUR=total_benefit,
            total_cost_EUR=total_cost,
            net_benefit_EUR=total_benefit - total_cost,
            roi_pct=(total_benefit - total_cost) / total_cost * 100 if total_cost > 0 else 0,
            horizon_days=horizon_days,
            optimizer_type='zone',
            metadata={'fallback': 'plant_level', 'reason': 'No SR data for zone detection'}
        )

    def optimize_crew_routing(
        self,
        zone_schedules: List[ZoneScheduleResult],
        crew_size: int = 2,
        max_zones_per_day: int = 3
    ) -> List[CrewAssignment]:
        """
        Optimize crew routing across zones.

        Groups zone cleanings into daily crew assignments.
        """
        # Collect all recommendations with dates
        all_recs = []
        for zs in zone_schedules:
            for rec in zs.schedule.recommendations:
                all_recs.append({
                    'date': rec.date,
                    'zone_id': rec.zone_id,
                    'zone_name': rec.zone_name,
                    'priority': rec.priority,
                })

        # Group by date
        by_date = {}
        for rec in all_recs:
            date_key = rec['date'].date() if hasattr(rec['date'], 'date') else rec['date']
            if date_key not in by_date:
                by_date[date_key] = []
            by_date[date_key].append(rec)

        # Create crew assignments
        assignments = []
        for date, recs in sorted(by_date.items()):
            # Limit zones per day
            day_zones = recs[:max_zones_per_day]

            assignment = CrewAssignment(
                date=pd.Timestamp(date),
                zones=[r['zone_name'] for r in day_zones],
                estimated_duration_hours=len(day_zones) * 2,  # 2 hours per zone
                crew_size=crew_size,
            )
            assignments.append(assignment)

        return assignments
