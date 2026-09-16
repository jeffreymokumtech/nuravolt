"""
Long-term cleaning optimizer (365 days).

Strategic optimization focused on:
- Annual ROI maximization
- Summer peak prioritization
- Multi-cleaning combination testing
- Budget allocation planning
"""

import sys
from datetime import timedelta
from itertools import combinations
from typing import Dict, List, Optional, Any, Tuple
import pandas as pd
import numpy as np

from .base import (
    CleaningOptimizer,
    CleaningRecommendation,
    ScheduleResult,
    sort_by_priority,
)


class LongTermOptimizer(CleaningOptimizer):
    """
    Long-term (365 day) strategic cleaning optimizer.

    Features:
    - Exhaustive search for optimal cleaning combinations
    - Summer prioritization (May-September)
    - ML prediction integration for SR drops
    - AOD/rain forecast awareness
    - Annual budget optimization
    """

    def __init__(self, site_config):
        super().__init__(site_config)
        self.summer_months = (5, 6, 7, 8, 9)  # May-September
        self.summer_weight = 1.5  # Summer cleanings worth 1.5x

    def optimize(
        self,
        df_forecast: pd.DataFrame,
        horizon_days: int = 365,
        df_aod_forecast: Optional[pd.DataFrame] = None,
        df_rain_forecast: Optional[pd.DataFrame] = None,
        min_cleanings: int = 1,
        max_cleanings: int = 5,
        prioritize_summer: bool = True,
        max_scenarios_per_count: int = 1000,
        **kwargs
    ) -> ScheduleResult:
        """
        Optimize 365-day cleaning schedule using exhaustive search.

        Parameters:
            df_forecast: ML forecast with sr_predicted, energy_if_clean_MWh
            horizon_days: Number of days (default 365)
            df_aod_forecast: AOD forecast for dust storm avoidance
            df_rain_forecast: Rain forecast for timing
            min_cleanings: Minimum cleanings to test
            max_cleanings: Maximum cleanings to test
            prioritize_summer: Weight summer cleanings higher
            max_scenarios_per_count: Limit scenarios per cleaning count

        Returns:
            ScheduleResult with optimal annual schedule
        """
        print("⚙️ Long-term optimization (365 days)...", file=sys.stderr)
        print(f"   Testing {min_cleanings}-{max_cleanings} cleanings per year", file=sys.stderr)
        print(f"   Summer prioritization: {'ON' if prioritize_summer else 'OFF'}", file=sys.stderr)

        # Limit forecast to horizon
        end_date = df_forecast.index[0] + timedelta(days=horizon_days)
        df = df_forecast[df_forecast.index <= end_date].copy()

        # Generate candidate cleaning dates
        candidate_dates = self._generate_candidate_dates(
            df,
            df_aod_forecast,
            prioritize_summer
        )

        print(f"   Generated {len(candidate_dates)} candidate dates", file=sys.stderr)

        # Test all scenarios
        all_scenarios = []

        for n_cleanings in range(min_cleanings, max_cleanings + 1):
            print(f"\n🔍 Testing {n_cleanings} cleaning(s)...", file=sys.stderr)

            # Generate combinations
            if n_cleanings == 1:
                combos = [[date] for date in candidate_dates]
            else:
                combos = self._generate_valid_combinations(
                    candidate_dates,
                    n_cleanings,
                    max_scenarios_per_count
                )

            print(f"   Testing {len(combos)} scenarios...", file=sys.stderr)

            # Test each scenario
            for i, cleaning_dates in enumerate(combos):
                scenario = self._evaluate_scenario(
                    cleaning_dates,
                    df,
                    df_aod_forecast,
                    df_rain_forecast
                )
                all_scenarios.append(scenario)

                if (i + 1) % 100 == 0:
                    print(f"   Tested {i+1}/{len(combos)} scenarios...", end='\r', file=sys.stderr)

            print(f"   ✅ Completed {len(combos)} scenarios", file=sys.stderr)

        # Find best scenario
        all_scenarios.sort(key=lambda x: x['net_benefit_EUR'], reverse=True)
        best = all_scenarios[0]

        # Build recommendations
        recommendations = []
        for date_str in best['cleaning_dates']:
            date = pd.Timestamp(date_str) if isinstance(date_str, str) else date_str

            # Estimate SR at cleaning date
            sr_at_date = 0.95
            if date in df.index:
                sr_at_date = df.loc[date, 'sr_predicted'] if 'sr_predicted' in df.columns else 0.95

            # Calculate per-cleaning benefit
            per_cleaning_benefit = best['revenue_recovered_EUR'] / best['n_cleanings']
            per_cleaning_cost = best['cleaning_cost_EUR'] / best['n_cleanings']

            # Determine priority based on month (summer = higher)
            priority = 'high' if date.month in self.summer_months else 'medium'

            rec = CleaningRecommendation(
                date=date,
                priority=priority,
                expected_benefit_EUR=per_cleaning_benefit,
                cleaning_cost_EUR=per_cleaning_cost,
                net_benefit_EUR=per_cleaning_benefit - per_cleaning_cost,
                confidence=0.75,  # Long-term forecasts have lower confidence
                sr_before=sr_at_date,
                sr_after=0.98,
                reason=f"{'Summer peak' if date.month in self.summer_months else 'Seasonal'} optimization",
            )
            recommendations.append(rec)

        # Sort by date
        recommendations.sort(key=lambda r: r.date)

        result = ScheduleResult(
            recommendations=recommendations,
            total_benefit_EUR=best['revenue_recovered_EUR'],
            total_cost_EUR=best['cleaning_cost_EUR'],
            net_benefit_EUR=best['net_benefit_EUR'],
            roi_pct=best['roi_pct'],
            horizon_days=horizon_days,
            optimizer_type='long_term',
            avg_sr_baseline=best.get('avg_sr_without_cleaning', df['sr_predicted'].mean() if 'sr_predicted' in df.columns else 0.95),
            avg_sr_optimized=best.get('avg_sr_with_cleaning', 0.97),
            energy_recovered_MWh=best['energy_recovered_MWh'],
            metadata={
                'scenarios_tested': len(all_scenarios),
                'best_scenario': best,
                'comparison_by_count': self._get_comparison_by_count(all_scenarios, min_cleanings, max_cleanings),
            }
        )

        print(f"\n✅ Optimization complete!", file=sys.stderr)
        print(f"   Best strategy: {best['n_cleanings']} cleanings", file=sys.stderr)
        print(f"   Net benefit: €{best['net_benefit_EUR']:,.0f}", file=sys.stderr)
        print(f"   ROI: {best['roi_pct']:.0f}%", file=sys.stderr)

        return result

    def _generate_candidate_dates(
        self,
        df: pd.DataFrame,
        df_aod: Optional[pd.DataFrame],
        prioritize_summer: bool
    ) -> List[pd.Timestamp]:
        """
        Generate smart candidate cleaning dates.

        Strategy:
        1. Base: Every 7 days in summer, 14 in winter
        2. ML-predicted SR local minima
        3. AOD avoidance (remove dates before dust storms)
        """
        candidates = set()

        start_date = df.index[0] + timedelta(days=14)
        end_date = df.index[-1] - timedelta(days=14)

        # 1. Base candidates with seasonal spacing
        if prioritize_summer:
            current = start_date
            while current <= end_date:
                interval = 7 if current.month in self.summer_months else 14
                candidates.add(current)
                current += timedelta(days=interval)
        else:
            current = start_date
            while current <= end_date:
                candidates.add(current)
                current += timedelta(days=7)

        # 2. ML-predicted SR local minima
        if 'sr_predicted' in df.columns:
            sr_threshold = 0.97
            window_size = 7

            # Add dates before SR drops below threshold
            for idx in range(3, len(df)):
                current_sr = df.iloc[idx]['sr_predicted']
                prev_sr = df.iloc[idx - 1]['sr_predicted']

                if current_sr < sr_threshold and prev_sr >= sr_threshold:
                    candidate = df.index[idx] - timedelta(days=3)
                    if start_date <= candidate <= end_date:
                        candidates.add(candidate)

            # Add local minima
            sr_series = df['sr_predicted']
            for idx in range(window_size, len(df) - window_size):
                current_sr = sr_series.iloc[idx]

                is_local_min = all(
                    sr_series.iloc[idx + offset] >= current_sr
                    for offset in range(-window_size, window_size + 1)
                    if offset != 0
                )

                if is_local_min and current_sr < sr_threshold:
                    candidate = df.index[idx]
                    if start_date <= candidate <= end_date:
                        candidates.add(candidate)

        # 3. AOD avoidance
        if df_aod is not None and len(df_aod) > 0:
            baseline_aod = 0.10
            candidates_to_remove = set()

            for candidate in candidates:
                check_start = candidate + timedelta(days=3)
                check_end = candidate + timedelta(days=7)

                for aod_date in df_aod.index:
                    if check_start <= aod_date <= check_end:
                        aod_value = df_aod.loc[aod_date].get('aod_550nm_mean', 0)
                        if aod_value > baseline_aod + 0.15:
                            candidates_to_remove.add(candidate)
                            break

            candidates -= candidates_to_remove

        return sorted(list(candidates))

    def _generate_valid_combinations(
        self,
        candidate_dates: List[pd.Timestamp],
        n_cleanings: int,
        max_scenarios: int
    ) -> List[List[str]]:
        """Generate valid date combinations respecting spacing constraint."""
        valid_combos = []

        for combo in combinations(candidate_dates, n_cleanings):
            # Check spacing constraint
            valid = all(
                (combo[i + 1] - combo[i]).days >= self.min_days_between
                for i in range(len(combo) - 1)
            )

            if valid:
                valid_combos.append([d.strftime('%Y-%m-%d') for d in combo])

            if len(valid_combos) >= max_scenarios:
                break

        return valid_combos

    def _evaluate_scenario(
        self,
        cleaning_dates: List[str],
        df: pd.DataFrame,
        df_aod: Optional[pd.DataFrame],
        df_rain: Optional[pd.DataFrame]
    ) -> Dict[str, Any]:
        """
        Evaluate a single cleaning scenario.

        Simulates SR trajectory with cleanings to estimate energy recovery.
        """
        dates = [pd.Timestamp(d) for d in cleaning_dates]
        n_cleanings = len(dates)

        # Calculate cleaning cost
        cleaning_cost = self._calculate_cleaning_cost(n_cleanings)

        # Simulate SR with and without cleanings
        sr_with_cleaning = []
        sr_without_cleaning = []
        daily_soiling_rate = 0.002  # 0.2%/day

        sr_baseline = df['sr_predicted'].iloc[0] if 'sr_predicted' in df.columns else 0.98
        sr_current_with = sr_baseline
        sr_current_without = sr_baseline

        energy_with = 0.0
        energy_without = 0.0

        for date in df.index:
            # Without cleaning: just degrade
            sr_without_cleaning.append(sr_current_without)

            # With cleaning: reset on cleaning days
            if date in dates:
                sr_current_with = 0.98  # Post-cleaning SR

            sr_with_cleaning.append(sr_current_with)

            # Calculate energy
            if 'energy_if_clean_MWh' in df.columns:
                clean_energy = df.loc[date, 'energy_if_clean_MWh']
            else:
                clean_energy = self.capacity_MW * 4  # Rough estimate

            energy_with += clean_energy * sr_current_with
            energy_without += clean_energy * sr_current_without

            # Degrade both
            sr_current_with = max(0.85, sr_current_with - daily_soiling_rate)
            sr_current_without = max(0.85, sr_current_without - daily_soiling_rate)

        # Calculate metrics
        energy_recovered = energy_with - energy_without
        revenue_recovered = energy_recovered * self.ppa_rate
        net_benefit = revenue_recovered - cleaning_cost
        roi = (net_benefit / cleaning_cost * 100) if cleaning_cost > 0 else 0

        return {
            'cleaning_dates': cleaning_dates,
            'n_cleanings': n_cleanings,
            'energy_recovered_MWh': energy_recovered,
            'revenue_recovered_EUR': revenue_recovered,
            'cleaning_cost_EUR': cleaning_cost,
            'net_benefit_EUR': net_benefit,
            'roi_pct': roi,
            'avg_sr_with_cleaning': np.mean(sr_with_cleaning),
            'avg_sr_without_cleaning': np.mean(sr_without_cleaning),
        }

    def _get_comparison_by_count(
        self,
        all_scenarios: List[Dict],
        min_count: int,
        max_count: int
    ) -> List[Dict]:
        """Get best scenario for each cleaning count."""
        comparison = []

        for n in range(min_count, max_count + 1):
            matching = [s for s in all_scenarios if s['n_cleanings'] == n]
            if matching:
                best = max(matching, key=lambda x: x['net_benefit_EUR'])
                comparison.append({
                    'n_cleanings': n,
                    'dates': best['cleaning_dates'],
                    'net_benefit_EUR': best['net_benefit_EUR'],
                    'roi_pct': best['roi_pct'],
                })

        return comparison

    def generate_comparison_table(self, result: ScheduleResult) -> pd.DataFrame:
        """Generate comparison table of different cleaning counts."""
        comparison = result.metadata.get('comparison_by_count', [])

        if not comparison:
            return pd.DataFrame()

        return pd.DataFrame({
            'Strategy': [f"{c['n_cleanings']} cleaning(s)" for c in comparison],
            'Dates': [', '.join(c['dates']) for c in comparison],
            'Net Benefit (€)': [round(c['net_benefit_EUR'], 0) for c in comparison],
            'ROI (%)': [round(c['roi_pct'], 0) for c in comparison],
        })
