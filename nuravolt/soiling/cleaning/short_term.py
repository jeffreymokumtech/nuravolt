"""
Short-term cleaning optimizer (30-90 days).

Tactical optimization focused on:
- Weather-sensitive scheduling (rain deferral)
- Crew availability constraints
- Urgent cleaning detection
- AOD/dust storm avoidance
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
    sort_by_priority,
)


class ShortTermOptimizer(CleaningOptimizer):
    """
    Short-term (30-90 day) tactical cleaning optimizer.

    Features:
    - Rain deferral: Delays cleaning 1-3 days after forecasted rain
    - AOD avoidance: Avoids cleaning before dust storms
    - Urgent detection: Identifies panels needing immediate attention
    - Weekend scheduling: Optional crew availability constraints
    """

    def __init__(self, site_config):
        super().__init__(site_config)
        self.rain_deferral_days = 2  # Wait N days after rain
        self.aod_threshold = 0.2  # Avoid cleaning if AOD > threshold
        self.urgent_sr_threshold = 0.90  # SR below this = urgent
        self.high_sr_threshold = 0.93
        self.medium_sr_threshold = 0.96

    def optimize(
        self,
        df_forecast: pd.DataFrame,
        horizon_days: int = 90,
        df_rain_forecast: Optional[pd.DataFrame] = None,
        df_aod_forecast: Optional[pd.DataFrame] = None,
        prefer_weekdays: bool = True,
        max_cleanings: int = 3,
        **kwargs
    ) -> ScheduleResult:
        """
        Optimize short-term cleaning schedule.

        Parameters:
            df_forecast: ML forecast with sr_predicted, energy_if_clean_MWh
            horizon_days: 30-90 days (default 90)
            df_rain_forecast: Rain forecast (date, precipitation_mm, probability)
            df_aod_forecast: AOD forecast (date, aod_550nm_mean)
            prefer_weekdays: Prefer Monday-Friday for crew availability
            max_cleanings: Maximum number of cleanings in horizon

        Returns:
            ScheduleResult with tactical cleaning recommendations
        """
        print(f"⚙️ Short-term optimization ({horizon_days} days)...", file=sys.stderr)

        # Limit forecast to horizon
        end_date = df_forecast.index[0] + timedelta(days=horizon_days)
        df = df_forecast[df_forecast.index <= end_date].copy()

        if len(df) == 0:
            return ScheduleResult(
                horizon_days=horizon_days,
                optimizer_type='short_term',
                metadata={'error': 'No forecast data available'}
            )

        # Find candidate cleaning dates
        candidates = self._find_candidates(
            df,
            df_rain_forecast,
            df_aod_forecast,
            prefer_weekdays
        )

        print(f"   Found {len(candidates)} candidate dates", file=sys.stderr)

        # Score and rank candidates
        scored_candidates = self._score_candidates(
            candidates,
            df,
            df_rain_forecast,
            df_aod_forecast
        )

        # Select best dates respecting constraints
        selected = self._select_best_dates(
            scored_candidates,
            max_cleanings,
            self.min_days_between
        )

        # Build recommendations
        recommendations = []
        total_benefit = 0.0
        total_cost = 0.0

        for i, candidate in enumerate(selected):
            # Calculate days until next cleaning or end
            if i + 1 < len(selected):
                days_until_next = (selected[i + 1]['date'] - candidate['date']).days
            else:
                days_until_next = (end_date - candidate['date']).days

            # Estimate energy recovery
            avg_daily_energy = df['energy_if_clean_MWh'].mean() if 'energy_if_clean_MWh' in df.columns else self.capacity_MW * 4
            energy_recovered = self._calculate_energy_recovery(
                sr_before=candidate['sr'],
                sr_after=0.98,
                days_until_next=days_until_next,
                avg_daily_energy=avg_daily_energy
            )

            benefit = energy_recovered * self.ppa_rate
            cost = self._calculate_cleaning_cost(1)
            net_benefit = benefit - cost

            total_benefit += benefit
            total_cost += cost

            rec = CleaningRecommendation(
                date=candidate['date'],
                priority=candidate['priority'],
                expected_benefit_EUR=benefit,
                cleaning_cost_EUR=cost,
                net_benefit_EUR=net_benefit,
                confidence=candidate['score'],
                sr_before=candidate['sr'],
                sr_after=0.98,
                reason=candidate['reason'],
                weather_risk=candidate.get('weather_risk'),
            )
            recommendations.append(rec)

        # Sort by priority
        recommendations = sort_by_priority(recommendations)

        # Calculate summary metrics
        net_benefit = total_benefit - total_cost
        roi_pct = (net_benefit / total_cost * 100) if total_cost > 0 else 0

        result = ScheduleResult(
            recommendations=recommendations,
            total_benefit_EUR=total_benefit,
            total_cost_EUR=total_cost,
            net_benefit_EUR=net_benefit,
            roi_pct=roi_pct,
            horizon_days=horizon_days,
            optimizer_type='short_term',
            avg_sr_baseline=df['sr_predicted'].mean() if 'sr_predicted' in df.columns else 0.95,
            avg_sr_optimized=0.97,  # Estimated with cleanings
            energy_recovered_MWh=sum(r.expected_benefit_EUR / self.ppa_rate for r in recommendations),
            metadata={
                'candidates_found': len(candidates),
                'candidates_selected': len(selected),
                'rain_deferral_applied': df_rain_forecast is not None,
                'aod_avoidance_applied': df_aod_forecast is not None,
            }
        )

        print(f"   ✅ Recommended {len(recommendations)} cleanings", file=sys.stderr)
        print(f"   Net benefit: €{net_benefit:,.0f} (ROI: {roi_pct:.0f}%)", file=sys.stderr)

        return result

    def _find_candidates(
        self,
        df: pd.DataFrame,
        df_rain: Optional[pd.DataFrame],
        df_aod: Optional[pd.DataFrame],
        prefer_weekdays: bool
    ) -> List[Dict[str, Any]]:
        """
        Find candidate cleaning dates based on SR and weather.

        Strategy:
        1. Identify dates where SR is predicted to drop
        2. Apply rain deferral window
        3. Avoid high AOD periods
        4. Optionally prefer weekdays
        """
        candidates = []
        sr_col = 'sr_predicted' if 'sr_predicted' in df.columns else None

        if sr_col is None:
            # No SR prediction, use weekly intervals
            for i in range(7, len(df), 7):
                candidates.append({
                    'date': df.index[i],
                    'sr': 0.95,
                    'priority': 'medium',
                    'reason': 'Regular maintenance interval',
                })
            return candidates

        # Build rain blackout dates
        rain_blackout = set()
        if df_rain is not None and len(df_rain) > 0:
            for idx in df_rain.index:
                precip = df_rain.loc[idx].get('precipitation_mm', 0)
                prob = df_rain.loc[idx].get('precipitation_probability', 0)
                if precip > 1.0 or prob > 0.5:
                    # Blackout: rain day + N days after
                    for offset in range(self.rain_deferral_days + 1):
                        blackout_date = idx + timedelta(days=offset)
                        rain_blackout.add(blackout_date.date() if hasattr(blackout_date, 'date') else blackout_date)

        # Build AOD warning dates
        aod_warning = set()
        if df_aod is not None and len(df_aod) > 0:
            for idx in df_aod.index:
                aod = df_aod.loc[idx].get('aod_550nm_mean', 0)
                if aod > self.aod_threshold:
                    # Warning: avoid cleaning 3 days before high AOD
                    for offset in range(-3, 1):
                        warning_date = idx + timedelta(days=offset)
                        aod_warning.add(warning_date.date() if hasattr(warning_date, 'date') else warning_date)

        # Find SR local minima and threshold crossings
        for i in range(3, len(df) - 3):
            date = df.index[i]
            date_key = date.date() if hasattr(date, 'date') else date
            sr = df.iloc[i][sr_col]

            # Skip if in rain blackout
            if date_key in rain_blackout:
                continue

            # Skip weekends if preferred
            if prefer_weekdays and hasattr(date, 'dayofweek') and date.dayofweek >= 5:
                continue

            # Determine priority and reason
            priority = self._get_priority(sr)
            reason = ''
            weather_risk = None

            # Check for AOD warning
            if date_key in aod_warning:
                weather_risk = 'High dust expected within 3 days'

            # Urgent: SR below threshold
            if sr < self.urgent_sr_threshold:
                reason = f'Urgent: SR at {sr:.1%} (>{(1-sr)*100:.0f}% loss)'
                candidates.append({
                    'date': date,
                    'sr': sr,
                    'priority': 'urgent',
                    'reason': reason,
                    'weather_risk': weather_risk,
                })
                continue

            # High priority: SR dropping below high threshold
            if sr < self.high_sr_threshold:
                reason = f'High priority: SR at {sr:.1%}'
                candidates.append({
                    'date': date,
                    'sr': sr,
                    'priority': 'high',
                    'reason': reason,
                    'weather_risk': weather_risk,
                })
                continue

            # Check for local minimum (good cleaning point)
            window = 3
            if i >= window and i < len(df) - window:
                is_local_min = True
                for j in range(-window, window + 1):
                    if j == 0:
                        continue
                    if df.iloc[i + j][sr_col] < sr:
                        is_local_min = False
                        break

                if is_local_min and sr < self.medium_sr_threshold:
                    reason = f'Local minimum SR: {sr:.1%}'
                    candidates.append({
                        'date': date,
                        'sr': sr,
                        'priority': priority,
                        'reason': reason,
                        'weather_risk': weather_risk,
                    })

        return candidates

    def _score_candidates(
        self,
        candidates: List[Dict],
        df: pd.DataFrame,
        df_rain: Optional[pd.DataFrame],
        df_aod: Optional[pd.DataFrame]
    ) -> List[Dict]:
        """
        Score candidates based on multiple factors.

        Scoring factors:
        - SR level (lower SR = higher benefit)
        - Weather risk (rain/dust)
        - Day of week preference
        - Distance from recent rain
        """
        for candidate in candidates:
            score = 0.5  # Base score

            # SR factor (lower SR = more urgent, higher score)
            sr = candidate['sr']
            if sr < 0.90:
                score += 0.3
            elif sr < 0.93:
                score += 0.2
            elif sr < 0.96:
                score += 0.1

            # Weather risk penalty
            if candidate.get('weather_risk'):
                score -= 0.15

            # Day of week bonus (weekdays preferred)
            date = candidate['date']
            if hasattr(date, 'dayofweek') and date.dayofweek < 5:
                score += 0.05

            candidate['score'] = min(1.0, max(0.0, score))

        # Sort by score descending
        return sorted(candidates, key=lambda x: x['score'], reverse=True)

    def _select_best_dates(
        self,
        scored_candidates: List[Dict],
        max_cleanings: int,
        min_days_between: int
    ) -> List[Dict]:
        """
        Select best cleaning dates respecting spacing constraint.

        Greedy selection: Pick highest-scored candidates that don't
        violate minimum spacing.
        """
        selected = []

        for candidate in scored_candidates:
            if len(selected) >= max_cleanings:
                break

            # Check spacing constraint
            valid = True
            for existing in selected:
                days_between = abs((candidate['date'] - existing['date']).days)
                if days_between < min_days_between:
                    valid = False
                    break

            if valid:
                selected.append(candidate)

        # Sort by date for output
        return sorted(selected, key=lambda x: x['date'])

    def get_urgent_cleanings(
        self,
        df_forecast: pd.DataFrame,
        horizon_days: int = 14
    ) -> List[CleaningRecommendation]:
        """
        Quick check for urgent cleaning needs (next 2 weeks).

        Returns only urgent/high priority recommendations.
        """
        result = self.optimize(df_forecast, horizon_days=horizon_days, max_cleanings=5)
        return [r for r in result.recommendations if r.priority in ('urgent', 'high')]
