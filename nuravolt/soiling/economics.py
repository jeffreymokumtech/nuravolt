"""Economic analysis and cleaning schedule optimization."""

from dataclasses import dataclass, asdict
import pandas as pd


@dataclass
class CleaningEconomics:
    """
    Runtime-adjustable economic parameters for cleaning optimization.

    This class makes economic parameters easily adjustable for interactive
    schedule optimization and sensitivity analysis.

    Attributes:
    -----------
    capacity_MW : float
        Plant capacity in megawatts
    cleaning_cost_per_MW : float
        Cost to clean per MW (€/MW)
    electricity_rate_per_MWh : float
        Electricity selling price (€/MWh)
    avg_sun_hours_per_day : float
        Average sun hours per day (for revenue calculation)
    cleaning_threshold_sr : float
        Soiling ratio threshold to trigger cleaning (0.97 = 3% loss)
    min_days_between : int
        Minimum days between cleanings
    rain_avoid_days : int
        Days to look ahead for rain avoidance
    rain_threshold_mm : float
        Rainfall threshold to skip cleaning (mm)
    """
    capacity_MW: float = 9.0
    cleaning_cost_per_MW: float = 600.0
    electricity_rate_per_MWh: float = 65.0
    avg_sun_hours_per_day: float = 6.5
    cleaning_threshold_sr: float = 0.97
    min_days_between: int = 14
    rain_avoid_days: int = 7
    rain_threshold_mm: float = 10.0

    def to_dict(self):
        """Convert to dictionary for serialization."""
        return asdict(self)

    def update(self, **kwargs):
        """Update parameters at runtime."""
        for key, value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)
            else:
                raise ValueError(f"Unknown parameter: {key}")

    @property
    def cleaning_cost_total(self):
        """Total cost per cleaning."""
        return self.capacity_MW * self.cleaning_cost_per_MW

    @property
    def daily_revenue_clean(self):
        """Daily revenue when panels are clean."""
        daily_generation_MWh = self.capacity_MW * self.avg_sun_hours_per_day
        return daily_generation_MWh * self.electricity_rate_per_MWh


def calculate_breakeven_days(soiling_loss_pct, capacity_MW, cleaning_cost_per_MW,
                              electricity_rate, sun_hours_per_day):
    """
    Calculate break-even period for cleaning at given soiling loss level.

    The break-even period is when cumulative revenue loss equals cleaning cost.

    Parameters:
    -----------
    soiling_loss_pct : float
        Soiling loss percentage (e.g., 3.0 for 3%)
    capacity_MW : float
        Plant capacity in MW
    cleaning_cost_per_MW : float
        Cost per MW to clean panels (€/MW)
    electricity_rate : float
        Electricity rate (€/MWh)
    sun_hours_per_day : float
        Average sun hours per day

    Returns:
    --------
    tuple : (breakeven_days, daily_revenue_loss)
        - breakeven_days: Days until cleaning pays for itself
        - daily_revenue_loss: Daily revenue loss at given soiling level (€)

    Example:
    --------
    >>> days, loss = calculate_breakeven_days(
    ...     soiling_loss_pct=3.0,
    ...     capacity_MW=9.0,
    ...     cleaning_cost_per_MW=600,
    ...     electricity_rate=65,
    ...     sun_hours_per_day=5.5
    ... )
    >>> print(f"Break-even: {days:.1f} days, Daily loss: €{loss:,.0f}")
    """
    # Calculate costs
    cleaning_cost_total = capacity_MW * cleaning_cost_per_MW
    daily_generation_clean_MWh = capacity_MW * sun_hours_per_day
    daily_revenue_clean = daily_generation_clean_MWh * electricity_rate

    # Calculate daily revenue loss at given soiling level
    daily_revenue_loss = daily_revenue_clean * (soiling_loss_pct / 100)

    # Break-even: when cumulative loss equals cleaning cost
    breakeven_days = cleaning_cost_total / daily_revenue_loss

    return breakeven_days, daily_revenue_loss


def print_breakeven_analysis(site_config):
    """
    Print comprehensive break-even analysis for different soiling levels.

    Parameters:
    -----------
    site_config : dict or SoilingConfig
        Site configuration with economic parameters
    """
    print("⚙️ Calculating economic break-even for cleaning decisions...")

    # Extract parameters
    if hasattr(site_config, '__dict__'):
        capacity_MW = site_config.capacity_MW
        cleaning_cost_per_MW = site_config.cleaning_cost_per_MW
        electricity_rate = site_config.electricity_rate_per_MWh
        sun_hours_per_day = site_config.avg_sun_hours_per_day
    else:
        capacity_MW = site_config['capacity_MW']
        cleaning_cost_per_MW = site_config['cleaning_cost_per_MW']
        electricity_rate = site_config['electricity_rate_per_MWh']
        sun_hours_per_day = site_config['avg_sun_hours_per_day']

    # Calculate costs
    cleaning_cost_total = capacity_MW * cleaning_cost_per_MW
    daily_generation_clean_MWh = capacity_MW * sun_hours_per_day
    daily_revenue_clean = daily_generation_clean_MWh * electricity_rate

    print("\n💰 Site Economics:")
    print(f"   Cleaning cost: €{cleaning_cost_total:,.0f} per cleaning")
    print(f"   Daily generation (clean): {daily_generation_clean_MWh:.1f} MWh")
    print(f"   Daily revenue (clean): €{daily_revenue_clean:,.0f}")

    # Calculate for different soiling loss levels
    soiling_levels = [1, 2, 3, 4, 5]
    print("\n📊 Break-even analysis:")
    for loss_pct in soiling_levels:
        days, daily_loss = calculate_breakeven_days(
            loss_pct, capacity_MW, cleaning_cost_per_MW,
            electricity_rate, sun_hours_per_day
        )
        print(f"\n   {loss_pct}% soiling loss:")
        print(f"      Daily revenue loss: €{daily_loss:,.0f}")
        print(f"      Break-even: {days:.1f} days")

    # Recommended cleaning threshold: 3% loss (SR < 0.97)
    recommended_loss_pct = 3
    recommended_breakeven_days, recommended_daily_loss = calculate_breakeven_days(
        recommended_loss_pct, capacity_MW, cleaning_cost_per_MW,
        electricity_rate, sun_hours_per_day
    )

    print(f"\n✅ Recommended cleaning threshold: {recommended_loss_pct}% loss (SR < 0.97)")
    print(f"   Break-even period: {recommended_breakeven_days:.1f} days")
    print(f"   Daily revenue loss at threshold: €{recommended_daily_loss:,.0f}")


def optimize_cleaning_schedule(df_daily, y_pred, cleaning_threshold_sr=0.97,
                                min_days_between=14, rain_avoid_days=7):
    """
    Generate optimal weather-aware cleaning schedule.

    Uses ML forecast to predict when cleaning is needed, while avoiding
    cleanings right before rain events.

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily data with rainfall column
    y_pred : numpy.ndarray
        Predicted soiling ratios (7-day ahead)
    cleaning_threshold_sr : float
        SR threshold to trigger cleaning (default: 0.97)
    min_days_between : int
        Minimum days between cleanings (default: 14)
    rain_avoid_days : int
        Days ahead to check for rain (default: 7)

    Returns:
    --------
    list of dict
        Cleaning schedule with dates, predicted SR, and reasoning

    Algorithm:
    ----------
    1. Check if forecast SR < threshold
    2. Ensure min_days_between since last cleaning
    3. Check for rain in next rain_avoid_days
    4. If rain expected >10mm, skip cleaning (nature cleans for free)
    5. Otherwise, schedule cleaning
    """
    print("⚙️ Generating optimal cleaning schedule...")

    schedule = []
    last_cleaning_date = None

    for i, date in enumerate(df_daily.index):
        # Skip if too soon after last cleaning
        if last_cleaning_date and (date - last_cleaning_date).days < min_days_between:
            continue

        # Check predicted SR for next 7 days
        if i + 7 < len(y_pred):
            sr_forecast_7d = y_pred[i]
        else:
            continue

        # Trigger cleaning if forecast SR < threshold
        if sr_forecast_7d < cleaning_threshold_sr:
            # Check for rain in next 7 days (avoid pre-rain cleaning)
            rain_ahead = df_daily['rainfall'].iloc[i:i+rain_avoid_days].sum()

            if rain_ahead < 10:  # < 10mm expected rain
                schedule.append({
                    'date': date,
                    'predicted_sr_7d': sr_forecast_7d,
                    'predicted_loss_pct': (1 - sr_forecast_7d) * 100,
                    'rain_forecast_7d': rain_ahead,
                    'reason': 'Forecast SR < 0.97',
                })
                last_cleaning_date = date
            else:
                # Rain expected - skip cleaning (nature will clean for free)
                schedule.append({
                    'date': date,
                    'predicted_sr_7d': sr_forecast_7d,
                    'predicted_loss_pct': (1 - sr_forecast_7d) * 100,
                    'rain_forecast_7d': rain_ahead,
                    'reason': f'SKIP: Rain expected ({rain_ahead:.1f}mm)',
                })

    return schedule


def print_cleaning_schedule(schedule, X_test):
    """
    Print formatted cleaning schedule summary.

    Parameters:
    -----------
    schedule : list of dict
        Cleaning schedule from optimize_cleaning_schedule()
    X_test : pandas.DataFrame
        Test set for date range reference
    """
    # Filter to actual cleanings (not skipped)
    cleanings_scheduled = [s for s in schedule if not s['reason'].startswith('SKIP')]
    cleanings_avoided = [s for s in schedule if s['reason'].startswith('SKIP')]

    print(f"\n✅ Optimal cleaning schedule generated")
    print(f"\n📅 Test period: {X_test.index[0].strftime('%Y-%m-%d')} to {X_test.index[-1].strftime('%Y-%m-%d')}")
    print(f"   Duration: {(X_test.index[-1] - X_test.index[0]).days} days")
    print(f"\n🧹 Scheduled cleanings: {len(cleanings_scheduled)}")
    print(f"⏭️ Avoided (pre-rain): {len(cleanings_avoided)}")

    print("\n📋 Scheduled cleaning dates:")
    for i, cleaning in enumerate(cleanings_scheduled[:5], 1):  # Show first 5
        print(f"   {i}. {cleaning['date'].strftime('%Y-%m-%d')}: "
              f"Predicted SR={cleaning['predicted_sr_7d']:.3f} "
              f"({cleaning['predicted_loss_pct']:.1f}% loss)")

    if len(cleanings_scheduled) > 5:
        print(f"   ... and {len(cleanings_scheduled) - 5} more")

    print("\n⏭️ Avoided cleanings (rain expected):")
    for i, cleaning in enumerate(cleanings_avoided[:3], 1):  # Show first 3
        print(f"   {i}. {cleaning['date'].strftime('%Y-%m-%d')}: "
              f"{cleaning['reason']}")


def calculate_roi_analysis(site_config, cleanings_scheduled, cleanings_avoided,
                            X_test, baseline_avg_loss_pct=4.5, optimized_avg_loss_pct=3.8,
                            implementation_cost=15000):
    """
    Calculate comprehensive ROI analysis for soiling intelligence system.

    Parameters:
    -----------
    site_config : dict or SoilingConfig
        Site configuration with economic parameters
    cleanings_scheduled : list
        Scheduled cleanings from optimization
    cleanings_avoided : list
        Cleanings avoided due to rain
    X_test : pandas.DataFrame
        Test period data
    baseline_avg_loss_pct : float
        Average soiling loss without optimization (default: 4.5%)
    optimized_avg_loss_pct : float
        Average soiling loss with optimization (default: 3.8%)
    implementation_cost : float
        One-time implementation cost (€, default: 15000)

    Returns:
    --------
    dict
        ROI metrics including annual savings, payback period, and ROI percentages
    """
    print("\n💰 ROI Analysis for Soiling Intelligence")
    print("=" * 70)

    # Extract parameters
    if hasattr(site_config, '__dict__'):
        capacity_MW = site_config.capacity_MW
        cleaning_cost_per_MW = site_config.cleaning_cost_per_MW
        electricity_rate = site_config.electricity_rate_per_MWh
        sun_hours_per_day = site_config.avg_sun_hours_per_day
    else:
        capacity_MW = site_config['capacity_MW']
        cleaning_cost_per_MW = site_config['cleaning_cost_per_MW']
        electricity_rate = site_config['electricity_rate_per_MWh']
        sun_hours_per_day = site_config['avg_sun_hours_per_day']

    cleaning_cost_total = capacity_MW * cleaning_cost_per_MW
    daily_generation_clean_MWh = capacity_MW * sun_hours_per_day
    daily_revenue_clean = daily_generation_clean_MWh * electricity_rate

    # Annual projections
    test_days = (X_test.index[-1] - X_test.index[0]).days
    annual_baseline_cleanings = 12  # Every 30 days
    annual_optimized_cleanings = int(len(cleanings_scheduled) * (365 / test_days))
    annual_avoided_pre_rain = len(cleanings_avoided) * (365 / test_days)

    # Costs
    annual_baseline_cost = annual_baseline_cleanings * cleaning_cost_total
    annual_optimized_cost = annual_optimized_cleanings * cleaning_cost_total
    annual_cleaning_savings = annual_baseline_cost - annual_optimized_cost

    # Revenue improvements (better soiling management)
    revenue_improvement_pct = baseline_avg_loss_pct - optimized_avg_loss_pct
    annual_revenue_clean = daily_revenue_clean * 365
    annual_revenue_improvement = annual_revenue_clean * (revenue_improvement_pct / 100)

    # Total annual benefit
    total_annual_benefit = annual_cleaning_savings + annual_revenue_improvement

    # Payback period
    payback_months = (implementation_cost / total_annual_benefit) * 12

    # Print results
    print("\n📊 BASELINE (Fixed Schedule - Every 30 Days)")
    print(f"   Annual cleanings: {annual_baseline_cleanings}")
    print(f"   Annual cost: €{annual_baseline_cost:,.0f}")
    print(f"   Average soiling loss: {baseline_avg_loss_pct}%")

    print("\n✨ OPTIMIZED (ML-Driven Schedule)")
    print(f"   Annual cleanings: {annual_optimized_cleanings}")
    print(f"   Avoided pre-rain cleanings: {annual_avoided_pre_rain:.1f}")
    print(f"   Annual cost: €{annual_optimized_cost:,.0f}")
    print(f"   Average soiling loss: {optimized_avg_loss_pct}%")

    print("\n💵 ANNUAL SAVINGS")
    print(f"   Cleaning cost savings: €{annual_cleaning_savings:,.0f}")
    print(f"   Revenue improvement: €{annual_revenue_improvement:,.0f}")
    print(f"   ─────────────────────────────")
    print(f"   TOTAL ANNUAL BENEFIT: €{total_annual_benefit:,.0f}")

    print("\n🎯 PAYBACK ANALYSIS")
    print(f"   Implementation cost: €{implementation_cost:,.0f}")
    print(f"   Payback period: {payback_months:.1f} months")
    print(f"   ROI (Year 1): {((total_annual_benefit - implementation_cost) / implementation_cost * 100):.0f}%")
    print(f"   ROI (Year 2+): {(total_annual_benefit / implementation_cost * 100):.0f}%")

    print("\n🌟 KEY OUTCOMES")
    print(f"   ✅ Reduce cleaning frequency by {annual_baseline_cleanings - annual_optimized_cleanings} cleanings/year")
    print(f"   ✅ Avoid €{annual_avoided_pre_rain * cleaning_cost_total:,.0f} in wasted pre-rain cleanings")
    print(f"   ✅ Improve plant performance by {revenue_improvement_pct:.1f}%")
    print(f"   ✅ System pays for itself in {payback_months:.1f} months")
    print(f"   ✅ Net savings (Year 1): €{total_annual_benefit - implementation_cost:,.0f}")
    print(f"   ✅ Net savings (Years 2+): €{total_annual_benefit:,.0f}/year")

    return {
        'annual_baseline_cleanings': annual_baseline_cleanings,
        'annual_optimized_cleanings': annual_optimized_cleanings,
        'annual_avoided_pre_rain': annual_avoided_pre_rain,
        'annual_cleaning_savings': annual_cleaning_savings,
        'annual_revenue_improvement': annual_revenue_improvement,
        'total_annual_benefit': total_annual_benefit,
        'implementation_cost': implementation_cost,
        'payback_months': payback_months,
        'roi_year1_pct': ((total_annual_benefit - implementation_cost) / implementation_cost * 100),
        'roi_year2plus_pct': (total_annual_benefit / implementation_cost * 100),
    }
