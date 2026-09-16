"""Optimal cleaning schedule optimizer for 365-day forecasts."""

import numpy as np
import pandas as pd
import sys
from typing import Dict, List, Tuple, Optional
from itertools import combinations
from datetime import timedelta

from .forecasting_longterm import simulate_cleaning_scenarios
from .forecast_optimizer import calculate_forecast_driven_cost_benefit


class CleaningScheduleOptimizer:
    """
    Find optimal cleaning schedule for 365-day forecast horizon.

    Uses exhaustive search with summer peak prioritization to find
    the cleaning schedule that maximizes net benefit (revenue - cost).

    Approach:
    1. Generate candidate cleaning dates (every 7-14 days)
    2. Test combinations (1 cleaning: 52 scenarios, 2 cleanings: top combos, etc.)
    3. Simulate energy recovery for each scenario
    4. Apply summer weighting (June-August cleanings worth 1.5x)
    5. Rank by ROI and net benefit
    """

    def __init__(self, site_config):
        """
        Initialize optimizer.

        Parameters:
        -----------
        site_config : SoilingConfig
            Site configuration with economic parameters
        """
        self.config = site_config
        self.capacity_MW = site_config.capacity_MW
        self.ppa_rate = site_config.electricity_rate_per_MWh
        self.cleaning_cost_per_MW = site_config.cleaning_cost_per_MW
        self.min_days_between = site_config.min_days_between  # Default: 14 days

    def optimize_schedule_365d(self,
                               df_ml_forecast: pd.DataFrame,
                               df_aod_forecast: Optional[pd.DataFrame] = None,
                               df_rain_forecast: Optional[pd.DataFrame] = None,
                               min_cleanings: int = 1,
                               max_cleanings: int = 5,
                               prioritize_summer: bool = True,
                               max_scenarios_per_count: int = 1000) -> Dict:
        """
        Find optimal cleaning schedule using forecast-driven optimization.

        Parameters:
        -----------
        df_ml_forecast : pd.DataFrame
            365-day ML forecast with columns: date, sr_predicted, energy_if_clean_MWh, etc.
            Index should be datetime
        df_aod_forecast : pd.DataFrame, optional
            5-day AOD forecast with columns: date, aod_550nm_mean
        df_rain_forecast : pd.DataFrame, optional
            16-day rain forecast with columns: date, precipitation_mm, precipitation_probability
        min_cleanings : int
            Minimum number of cleanings to consider (default: 1)
        max_cleanings : int
            Maximum number of cleanings to consider (default: 5)
        prioritize_summer : bool
            Weight summer cleanings 1.5x (default: True)
        max_scenarios_per_count : int
            Max scenarios to test per cleaning count (default: 1000)

        Returns:
        --------
        dict
            Optimization results with keys:
            - optimal_schedule: dict with best scenario details
            - all_scenarios: DataFrame with all tested scenarios
            - comparison_table: DataFrame comparing 1-5 cleaning options
        """
        import sys
        print("⚙️ Optimizing cleaning schedule for 365 days...", file=sys.stderr)
        print(f"   Testing {min_cleanings}-{max_cleanings} cleanings per year", file=sys.stderr)
        print(f"   Summer prioritization: {'ON' if prioritize_summer else 'OFF'}", file=sys.stderr)
        print(f"   Min days between cleanings: {self.min_days_between}", file=sys.stderr)

        # Check forecast availability
        has_aod = df_aod_forecast is not None and len(df_aod_forecast) > 0
        has_rain = df_rain_forecast is not None and len(df_rain_forecast) > 0
        print(f"   Forecast mode: ML + {'AOD ' if has_aod else ''}{'Rain' if has_rain else ''}", file=sys.stderr)

        # Generate candidate cleaning dates
        candidate_dates = self._generate_candidate_dates(
            df_ml_forecast,
            df_aod_forecast,
            prioritize_summer=prioritize_summer
        )

        print(f"   Generated {len(candidate_dates)} candidate cleaning dates", file=sys.stderr)

        # Test all scenarios
        all_scenarios = []

        for n_cleanings in range(min_cleanings, max_cleanings + 1):
            print(f"\n🔍 Testing {n_cleanings} cleaning(s)...", file=sys.stderr)

            # Generate combinations
            if n_cleanings == 1:
                # Test all single dates
                combos = [[date] for date in candidate_dates]
            else:
                # Generate combinations with spacing constraint
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
                    df_ml_forecast,
                    df_aod_forecast,
                    df_rain_forecast
                )
                all_scenarios.append(scenario)

                # Progress indicator
                if (i + 1) % 100 == 0:
                    print(f"   Tested {i+1}/{len(combos)} scenarios...", end='\r', file=sys.stderr)

            print(f"   ✅ Completed {len(combos)} scenarios", file=sys.stderr)

        # Convert to DataFrame
        df_scenarios = pd.DataFrame(all_scenarios)

        # Sort by net benefit
        df_scenarios = df_scenarios.sort_values('net_benefit_EUR', ascending=False)

        # Best scenario
        best = df_scenarios.iloc[0].to_dict()

        # Comparison table (best of each cleaning count)
        comparison_rows = []
        for n in range(min_cleanings, max_cleanings + 1):
            best_n = df_scenarios[df_scenarios['n_cleanings'] == n].iloc[0]
            comparison_rows.append(best_n.to_dict())
        df_comparison = pd.DataFrame(comparison_rows)

        print(f"\n✅ Optimization complete!", file=sys.stderr)
        print(f"   Best strategy: {best['n_cleanings']} cleanings", file=sys.stderr)
        print(f"   Net benefit: €{best['net_benefit_EUR']:,.0f}", file=sys.stderr)
        print(f"   ROI: {best['roi_pct']:.0f}%", file=sys.stderr)
        # Convert timestamps to strings for printing
        date_strs = [d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else str(d) for d in best['cleaning_dates']]
        print(f"   Dates: {', '.join(date_strs)}", file=sys.stderr)

        return {
            'optimal_schedule': best,
            'all_scenarios': df_scenarios,
            'comparison_table': df_comparison
        }

    def _generate_candidate_dates(self,
                                  df_ml_forecast: pd.DataFrame,
                                  df_aod_forecast: Optional[pd.DataFrame] = None,
                                  prioritize_summer: bool = True) -> List[pd.Timestamp]:
        """
        Generate smart candidate cleaning dates using ML predictions and forecasts.

        Strategy:
        1. Base candidates: Every 7-14 days (seasonal if prioritize_summer=True)
        2. ML-predicted SR drops: Add candidates 3 days before SR < 0.97
        3. High AOD periods: Avoid cleanings before dust storms (if AOD forecast available)

        Returns:
        --------
        List[pd.Timestamp]
            Candidate cleaning dates
        """
        candidates = set()  # Use set to avoid duplicates

        # Start 14 days after first date (allow initial soiling accumulation)
        start_date = df_ml_forecast.index[0] + timedelta(days=14)
        end_date = df_ml_forecast.index[-1] - timedelta(days=14)  # Don't clean at very end

        # 1. Base candidates (seasonal spacing)
        if prioritize_summer:
            # Every 7 days in summer (May-Sept), every 14 days in winter
            current = start_date
            while current <= end_date:
                month = current.month
                if 5 <= month <= 9:  # Summer
                    interval = 7
                else:  # Winter
                    interval = 14

                candidates.add(current)
                current += timedelta(days=interval)
        else:
            # Uniform spacing: every 7 days
            current = start_date
            while current <= end_date:
                candidates.add(current)
                current += timedelta(days=7)

        # 2. ML-predicted SR local minima: Add candidates at lowest predicted SR points
        # Strategy: Find local minima in SR prediction (lowest soiling accumulation points)
        sr_threshold = 0.97

        # Add candidates 3 days before SR < threshold (original logic)
        for idx in range(3, len(df_ml_forecast)):
            current_sr = df_ml_forecast.iloc[idx]['sr_predicted']
            prev_sr = df_ml_forecast.iloc[idx-1]['sr_predicted']

            # If SR about to drop below threshold, add cleaning candidate 3 days before
            if current_sr < sr_threshold and prev_sr >= sr_threshold:
                candidate_date = df_ml_forecast.index[idx] - timedelta(days=3)
                if start_date <= candidate_date <= end_date:
                    candidates.add(candidate_date)

        # NEW: Find local minima (lowest SR points) for optimal cleaning timing
        # Rationale: Cleaning when SR is at its lowest maximizes energy recovery
        # because the SR jump from cleaning (to 0.95-1.0) is largest at lowest points
        # Use 7-day rolling window to find local minima
        window_size = 7
        sr_series = df_ml_forecast['sr_predicted']

        local_minima_count = 0
        for idx in range(window_size, len(df_ml_forecast) - window_size):
            current_sr = sr_series.iloc[idx]

            # Check if this is a local minimum (lowest in ±7 day window)
            is_local_min = True
            for offset in range(-window_size, window_size + 1):
                if offset == 0:
                    continue
                neighbor_sr = sr_series.iloc[idx + offset]
                if neighbor_sr < current_sr:
                    is_local_min = False
                    break

            # If local minimum and below threshold, add as candidate
            # This ensures we're cleaning at predicted lowest SR points to maximize benefit
            if is_local_min and current_sr < sr_threshold:
                candidate_date = df_ml_forecast.index[idx]
                if start_date <= candidate_date <= end_date:
                    candidates.add(candidate_date)
                    local_minima_count += 1
                    if local_minima_count <= 5:  # Print first 5 local minima
                        print(f"   Found local minimum: {candidate_date.date()} (SR={current_sr:.4f})", file=sys.stderr)

        print(f"   Found {local_minima_count} local minima below {sr_threshold}", file=sys.stderr)


        # 3. High AOD avoidance: Remove candidates followed by high dust
        if df_aod_forecast is not None and len(df_aod_forecast) > 0:
            # Calculate baseline AOD (mean of historical data)
            historical_soiling = df_ml_forecast['soiling_loss_pct'].mean()
            baseline_aod = 0.05 + (historical_soiling / 10.0) * 0.20

            # Remove candidates followed by high AOD (>0.15 above baseline)
            candidates_to_remove = set()
            for candidate in candidates:
                # Check 3-7 days after cleaning for high AOD
                check_start = candidate + timedelta(days=3)
                check_end = candidate + timedelta(days=7)

                for aod_date in df_aod_forecast.index:
                    if check_start <= aod_date <= check_end:
                        aod_value = df_aod_forecast.loc[aod_date, 'aod_550nm_mean']
                        if aod_value > baseline_aod + 0.15:  # High dust expected
                            candidates_to_remove.add(candidate)
                            break

            candidates -= candidates_to_remove

        return sorted(list(candidates))

    def _generate_valid_combinations(self,
                                     candidate_dates: List[pd.Timestamp],
                                     n_cleanings: int,
                                     max_scenarios: int) -> List[List[str]]:
        """
        Generate valid combinations of cleaning dates.

        Two regimes:
        1. Small search space (C(N, k) ≲ 5×max_scenarios): exhaustive lex
           enumeration with spacing filter — fully covers the space.
        2. Large search space: uniform random sampling across all subsets,
           with dedupe. Avoids the lex bias the old code had, where the
           first 1500 valid combos were all "earliest-month" cleanings and
           the optimizer never even considered Aug-Dec cadences.

        Sample size hits `max_scenarios` either way; in the small regime
        we exhaust earlier.
        """
        import math
        import random

        if len(candidate_dates) < n_cleanings:
            return []

        # Estimate the search space size cheaply.
        try:
            total = math.comb(len(candidate_dates), n_cleanings)
        except (OverflowError, ValueError):
            total = 10 ** 18  # treat as "huge"

        valid_combos: List[List[str]] = []
        min_days = self.min_days_between

        # --- Fast path: exhaustive lex enumeration ---------------------------
        if total <= max_scenarios * 5:
            for combo in combinations(candidate_dates, n_cleanings):
                valid = True
                for i in range(len(combo) - 1):
                    if (combo[i + 1] - combo[i]).days < min_days:
                        valid = False
                        break
                if valid:
                    valid_combos.append([d.strftime('%Y-%m-%d') for d in combo])
                    if len(valid_combos) >= max_scenarios:
                        break
            return valid_combos

        # --- Sampling path: uniform random subsets ---------------------------
        rng = random.Random(20260618)  # seeded for reproducibility
        seen: set = set()
        max_attempts = max_scenarios * 60  # safety cap
        attempts = 0
        candidates_list = list(candidate_dates)
        while len(valid_combos) < max_scenarios and attempts < max_attempts:
            attempts += 1
            sampled = sorted(rng.sample(candidates_list, n_cleanings))
            key = tuple(d.toordinal() for d in sampled)
            if key in seen:
                continue
            seen.add(key)
            valid = True
            for i in range(len(sampled) - 1):
                if (sampled[i + 1] - sampled[i]).days < min_days:
                    valid = False
                    break
            if valid:
                valid_combos.append([d.strftime('%Y-%m-%d') for d in sampled])

        return valid_combos

    def _evaluate_scenario(self,
                          cleaning_dates: List[str],
                          df_ml_forecast: pd.DataFrame,
                          df_aod_forecast: Optional[pd.DataFrame],
                          df_rain_forecast: Optional[pd.DataFrame]) -> Dict:
        """
        Evaluate a single cleaning scenario using forecast-driven algorithm.

        Uses ML predictions + AOD/rain forecasts for accurate cost/benefit calculation.

        Parameters:
        -----------
        cleaning_dates : List[str]
            Cleaning dates in YYYY-MM-DD format
        df_ml_forecast : pd.DataFrame
            365-day ML forecast with sr_predicted, energy_if_clean_MWh, etc.
        df_aod_forecast : pd.DataFrame, optional
            5-day AOD forecast
        df_rain_forecast : pd.DataFrame, optional
            16-day rain forecast

        Returns:
        --------
        dict
            Scenario evaluation with keys:
            - cleaning_dates, n_cleanings
            - energy_recovered_MWh, revenue_recovered_EUR
            - cleaning_cost_EUR, net_benefit_EUR, roi_pct
            - avg_sr_with_cleaning, avg_sr_without_cleaning
        """
        # Build parameters dict for forecast optimizer
        parameters = {
            'capacity_MW': self.capacity_MW,
            'cleaning_cost_per_MW': self.cleaning_cost_per_MW,
            'electricity_rate_per_MWh': self.ppa_rate,
        }

        # Call forecast-driven cost/benefit calculator
        result = calculate_forecast_driven_cost_benefit(
            cleaning_dates=cleaning_dates,
            df_ml_forecast=df_ml_forecast,
            df_aod_forecast=df_aod_forecast,
            df_rain_forecast=df_rain_forecast,
            parameters=parameters
        )

        # Rename keys to match expected output format
        return {
            'cleaning_dates': result['cleaning_dates'],
            'n_cleanings': result['n_cleanings'],
            'energy_recovered_MWh': result['energy_recovered_MWh'],
            'revenue_recovered_EUR': result['revenue_recovered_EUR'],
            'cleaning_cost_EUR': result['cleaning_cost_EUR'],
            'net_benefit_EUR': result['net_benefit_EUR'],
            'roi_pct': result['roi_pct'],
            'avg_sr': result['avg_sr_with_cleaning'],
            'avg_sr_with_cleaning': result['avg_sr_with_cleaning'],
            'avg_sr_without_cleaning': result['avg_sr_without_cleaning'],
        }

    def generate_scenario_comparison(self,
                                    optimization_results: Dict,
                                    save_path: Optional[str] = None) -> pd.DataFrame:
        """
        Generate comparison table of different cleaning strategies.

        Returns DataFrame with columns:
        - Strategy (1-5 cleanings)
        - Dates
        - Energy Recovered (MWh)
        - Revenue Recovered (€)
        - Cleaning Cost (€)
        - Net Benefit (€)
        - ROI (%)
        """
        df_comparison = optimization_results['comparison_table'].copy()

        # Format for display
        df_display = pd.DataFrame({
            'Strategy': [f"{int(row['n_cleanings'])} cleaning(s)" for _, row in df_comparison.iterrows()],
            'Dates': [', '.join([str(d)[:10] if not isinstance(d, str) else d for d in row['cleaning_dates']]) for _, row in df_comparison.iterrows()],
            'Energy Recovered (MWh)': df_comparison['energy_recovered_MWh'].round(0),
            'Revenue Recovered (€)': df_comparison['revenue_recovered_EUR'].round(0),
            'Cleaning Cost (€)': df_comparison['cleaning_cost_EUR'].round(0),
            'Net Benefit (€)': df_comparison['net_benefit_EUR'].round(0),
            'ROI (%)': df_comparison['roi_pct'].round(0),
            'Avg SR': df_comparison['avg_sr'].round(3),
        })

        if save_path:
            df_display.to_csv(save_path, index=False)
            print(f"💾 Saved comparison table to {save_path}", file=sys.stderr)

        return df_display

    def simulate_operator_proposal(self,
                                  optimization_results: Dict,
                                  df_ml_forecast: pd.DataFrame) -> Dict:
        """
        Generate operator proposal with key metrics and recommendations.

        Parameters:
        -----------
        optimization_results : dict
            Results from optimize_schedule_365d
        df_ml_forecast : pd.DataFrame
            365-day ML forecast

        Returns:
        --------
        dict
            Proposal with keys:
            - executive_summary
            - optimal_schedule
            - financial_analysis
            - technical_details
            - recommendations
        """
        best = optimization_results['optimal_schedule']
        comparison = optimization_results['comparison_table']

        # Executive summary
        exec_summary = {
            'plant_capacity_MW': self.capacity_MW,
            'forecast_period': f"{df_ml_forecast.index[0].date()} to {df_ml_forecast.index[-1].date()}",
            'recommended_cleanings': int(best['n_cleanings']),
            'expected_net_benefit_EUR': float(best['net_benefit_EUR']),
            'expected_roi_pct': float(best['roi_pct']),
        }

        # Financial analysis
        baseline_revenue = (df_ml_forecast['energy_with_soiling_MWh'] * self.ppa_rate).sum()
        financial = {
            'baseline_revenue_EUR': float(baseline_revenue),
            'optimized_revenue_EUR': float(baseline_revenue + best['revenue_recovered_EUR']),
            'cleaning_investment_EUR': float(best['cleaning_cost_EUR']),
            'net_benefit_EUR': float(best['net_benefit_EUR']),
            'payback_days': float(best['cleaning_cost_EUR'] / (best['revenue_recovered_EUR'] / 365)) if best['revenue_recovered_EUR'] > 0 else 999,
        }

        # Technical details
        technical = {
            'avg_soiling_ratio_baseline': float(best.get('avg_sr_without_cleaning', df_ml_forecast['sr_predicted'].mean())),
            'avg_soiling_ratio_optimized': float(best.get('avg_sr_with_cleaning', best['avg_sr'])),
            'energy_recovered_MWh': float(best['energy_recovered_MWh']),
            'avg_soiling_loss_baseline_pct': float((1 - best.get('avg_sr_without_cleaning', df_ml_forecast['sr_predicted'].mean())) * 100),
            'avg_soiling_loss_optimized_pct': float((1 - best.get('avg_sr_with_cleaning', best['avg_sr'])) * 100),
        }

        # Recommendations
        recommendations = []

        # Summer focus
        summer_dates = [d for d in best['cleaning_dates'] if pd.Timestamp(d).month in [6, 7, 8]]
        if len(summer_dates) > 0:
            recommendations.append(
                f"Summer focus: {len(summer_dates)}/{best['n_cleanings']} cleanings scheduled "
                f"in high-irradiance months (June-August) for maximum impact."
            )

        # Spacing
        dates = [pd.Timestamp(d) for d in best['cleaning_dates']]
        if len(dates) > 1:
            avg_spacing = np.mean([(dates[i+1] - dates[i]).days for i in range(len(dates)-1)])
            recommendations.append(
                f"Optimal spacing: Cleanings spaced {avg_spacing:.0f} days apart on average."
            )

        # ROI comparison
        if len(comparison) > 1:
            second_best = comparison.iloc[1]
            recommendations.append(
                f"Alternative: {int(second_best['n_cleanings'])} cleanings yields "
                f"€{second_best['net_benefit_EUR']:,.0f} benefit "
                f"({second_best['roi_pct']:.0f}% ROI), "
                f"€{abs(best['net_benefit_EUR'] - second_best['net_benefit_EUR']):,.0f} less than optimal."
            )

        return {
            'executive_summary': exec_summary,
            'optimal_schedule': best,
            'financial_analysis': financial,
            'technical_details': technical,
            'recommendations': recommendations,
        }
