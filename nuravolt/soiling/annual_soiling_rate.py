"""Annual (365-day) soiling rate forecast using seasonal patterns.

This module generates a year-long daily soiling rate forecast based on:
1. Monthly AOD climatology (from CAMS historical data)
2. Seasonal rainfall patterns (wet vs dry season)
3. Site-specific calibration from historical data

The output enables:
- Annual energy loss estimation
- Cleaning schedule optimization
- Financial forecasting for O&M budgets

Soiling rate varies seasonally:
- Dry season (May-Sep): 0.30-0.42 %/day
- Wet season (Oct-Apr): 0.08-0.18 %/day
"""

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .forecast_data import ForecastDataFetcher


@dataclass
class AnnualForecastDay:
    """Single day in annual forecast."""
    date: date
    day_of_year: int
    month: int

    # Soiling metrics
    soiling_rate_pct_day: float  # Expected soiling rate (%/day)
    sr_no_cleaning: float  # Expected SR without cleaning
    sr_with_recommended: float  # Expected SR with recommended cleaning

    # Environmental factors
    aod_expected: float
    rain_probability: float  # % chance of cleaning rain

    # Cleaning info
    is_cleaning_day: bool
    cleaning_reason: Optional[str] = None


@dataclass
class MonthlySummary:
    """Monthly summary for annual forecast."""
    month: int
    month_name: str
    soiling_rate_pct_day: float
    total_soiling_loss_pct: float
    rain_days_expected: float
    seasonal_factor: float
    avg_aod: float
    recommended_cleanings: int


@dataclass
class AnnualForecastResult:
    """Complete annual soiling rate forecast."""
    plant_id: str
    generated_at: datetime
    forecast_period_start: date
    forecast_period_end: date

    # Summary
    avg_soiling_rate_pct_day: float
    expected_annual_loss_pct: float
    expected_loss_with_cleaning_pct: float
    recommended_cleanings: int
    optimal_cleaning_months: List[str]

    # Monthly breakdown
    monthly_summary: List[MonthlySummary]

    # Daily forecast
    daily: List[AnnualForecastDay]

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "metadata": {
                "plant_id": self.plant_id,
                "generated_at": self.generated_at.isoformat(),
                "forecast_period": f"{self.forecast_period_start.isoformat()} to {self.forecast_period_end.isoformat()}",
            },
            "summary": {
                "avg_soiling_rate_pct_day": round(self.avg_soiling_rate_pct_day, 3),
                "expected_annual_loss_pct": round(self.expected_annual_loss_pct, 2),
                "expected_loss_with_cleaning_pct": round(self.expected_loss_with_cleaning_pct, 2),
                "recommended_cleanings": self.recommended_cleanings,
                "optimal_cleaning_months": self.optimal_cleaning_months,
            },
            "monthly_rates": [
                {
                    "month": m.month,
                    "month_name": m.month_name,
                    "soiling_rate_pct_day": round(m.soiling_rate_pct_day, 3),
                    "total_soiling_loss_pct": round(m.total_soiling_loss_pct, 2),
                    "rain_days_expected": round(m.rain_days_expected, 1),
                    "seasonal_factor": round(m.seasonal_factor, 2),
                    "avg_aod": round(m.avg_aod, 3),
                    "recommended_cleanings": m.recommended_cleanings,
                }
                for m in self.monthly_summary
            ],
            "daily": [
                {
                    "date": d.date.isoformat(),
                    "day_of_year": d.day_of_year,
                    "month": d.month,
                    "soiling_rate_pct_day": round(d.soiling_rate_pct_day, 3),
                    "sr_no_cleaning": round(d.sr_no_cleaning, 4),
                    "sr_with_recommended": round(d.sr_with_recommended, 4),
                    "aod_expected": round(d.aod_expected, 3),
                    "rain_probability": round(d.rain_probability, 1),
                    "is_cleaning_day": d.is_cleaning_day,
                    "cleaning_reason": d.cleaning_reason,
                }
                for d in self.daily
            ],
        }


class AnnualSoilingRateForecast:
    """Generate 365-day daily soiling rate forecast.

    Uses monthly climatology to predict:
    - Daily soiling rates based on AOD patterns
    - Rain cleaning probability
    - Optimal cleaning schedule

    The model accounts for:
    - Saharan dust intrusions (peaks in May-Sep)
    - Mediterranean wet/dry season patterns
    - Rain-based natural cleaning events

    Example
    -------
    >>> forecaster = AnnualSoilingRateForecast(
    ...     latitude=37.5,
    ...     longitude=-6,
    ...     plant_id="alpha1"
    ... )
    >>> result = forecaster.generate_forecast()
    >>> print(f"Annual loss: {result.expected_annual_loss_pct:.1f}%")
    """

    # Cleaning thresholds
    SR_CLEANING_THRESHOLD = 0.95  # Clean when SR drops below 95%
    RAIN_CLEANING_THRESHOLD = 5.0  # mm for effective cleaning
    RAIN_RECOVERY_FACTOR = 0.85  # 85% SR restoration from rain

    # Optimal cleaning months (before dry season peak)
    OPTIMAL_CLEANING_MONTHS = [3, 6, 9, 12]  # March, June, September, December

    # Month names
    MONTH_NAMES = [
        "", "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ]

    def __init__(
        self,
        latitude: float,
        longitude: float,
        plant_id: str = "unknown",
        base_soiling_rate: float = 0.0025,  # 0.25%/day baseline
        site_calibration_factor: float = 1.0
    ):
        """Initialize annual forecast generator.

        Parameters
        ----------
        latitude, longitude : float
            Plant coordinates
        plant_id : str
            Plant identifier
        base_soiling_rate : float
            Base soiling rate in decimal (0.0025 = 0.25%/day)
        site_calibration_factor : float
            Site-specific multiplier (1.0 = use defaults)
        """
        self.latitude = latitude
        self.longitude = longitude
        self.plant_id = plant_id
        self.base_soiling_rate = base_soiling_rate
        self.site_calibration_factor = site_calibration_factor

        # Initialize data fetcher for climatology
        self.data_fetcher = ForecastDataFetcher(
            latitude=latitude,
            longitude=longitude
        )

    def generate_forecast(
        self,
        start_date: Optional[date] = None,
        include_cleaning_schedule: bool = True,
        cleanings_per_year: int = 4
    ) -> AnnualForecastResult:
        """Generate 365-day soiling rate forecast.

        Parameters
        ----------
        start_date : date, optional
            Forecast start date (default: today)
        include_cleaning_schedule : bool
            Whether to include recommended cleaning dates
        cleanings_per_year : int
            Target number of cleanings (default: 4)

        Returns
        -------
        AnnualForecastResult
            Complete annual forecast with daily rates and monthly summaries
        """
        if start_date is None:
            start_date = datetime.now().date()

        print(f"📅 Generating 365-day soiling rate forecast for {self.plant_id}...")
        print(f"   Start date: {start_date}")

        # Get seasonal climatology
        df_climate = self.data_fetcher.get_seasonal_climate(
            start_date=start_date,
            days=365
        )

        # Generate daily forecasts
        daily_forecasts = self._generate_daily_forecasts(
            df_climate=df_climate,
            start_date=start_date
        )

        # Calculate cleaning schedule if requested
        if include_cleaning_schedule:
            daily_forecasts = self._apply_cleaning_schedule(
                daily_forecasts=daily_forecasts,
                cleanings_per_year=cleanings_per_year
            )

        # Generate monthly summaries
        monthly_summaries = self._generate_monthly_summaries(
            daily_forecasts=daily_forecasts,
            df_climate=df_climate
        )

        # Calculate annual metrics
        avg_soiling_rate = np.mean([d.soiling_rate_pct_day for d in daily_forecasts])
        min_sr_no_clean = min(d.sr_no_cleaning for d in daily_forecasts)
        min_sr_with_clean = min(d.sr_with_recommended for d in daily_forecasts)

        # Expected annual loss (integral of soiling over time)
        expected_loss_no_clean = self._calculate_annual_loss(
            [d.sr_no_cleaning for d in daily_forecasts]
        )
        expected_loss_with_clean = self._calculate_annual_loss(
            [d.sr_with_recommended for d in daily_forecasts]
        )

        # Count cleaning events
        cleaning_days = [d for d in daily_forecasts if d.is_cleaning_day and d.cleaning_reason != 'rain']
        recommended_cleanings = len(cleaning_days)

        # Get optimal cleaning months
        optimal_months = self._get_optimal_cleaning_months(monthly_summaries)

        result = AnnualForecastResult(
            plant_id=self.plant_id,
            generated_at=datetime.now(),
            forecast_period_start=start_date,
            forecast_period_end=start_date + timedelta(days=364),
            avg_soiling_rate_pct_day=avg_soiling_rate,
            expected_annual_loss_pct=expected_loss_no_clean,
            expected_loss_with_cleaning_pct=expected_loss_with_clean,
            recommended_cleanings=recommended_cleanings,
            optimal_cleaning_months=optimal_months,
            monthly_summary=monthly_summaries,
            daily=daily_forecasts,
        )

        print(f"✅ Annual forecast generated")
        print(f"   Average soiling rate: {avg_soiling_rate:.3f} %/day")
        print(f"   Expected loss (no cleaning): {expected_loss_no_clean:.1f}%")
        print(f"   Expected loss (with {recommended_cleanings} cleanings): {expected_loss_with_clean:.1f}%")
        print(f"   Optimal cleaning months: {', '.join(optimal_months)}")

        return result

    def _generate_daily_forecasts(
        self,
        df_climate: pd.DataFrame,
        start_date: date
    ) -> List[AnnualForecastDay]:
        """Generate daily soiling rate forecasts."""
        daily_forecasts = []
        current_sr = 1.0  # Start clean

        for i, (idx, row) in enumerate(df_climate.iterrows()):
            forecast_date = start_date + timedelta(days=i)
            day_of_year = forecast_date.timetuple().tm_yday
            month = forecast_date.month

            # Get soiling rate from climatology
            soiling_rate = row['soiling_rate_pct_day'] * self.site_calibration_factor

            # Get environmental factors
            aod_expected = row['aod_climatology']
            rain_prob = row['rain_probability']

            # Calculate SR without cleaning
            daily_loss = soiling_rate / 100  # Convert to decimal
            new_sr = current_sr - daily_loss

            # Check for probabilistic rain cleaning
            is_rain_cleaning = False
            if rain_prob > 30:  # >30% chance of significant rain
                # Partial recovery based on probability
                rain_recovery = (rain_prob / 100) * self.RAIN_RECOVERY_FACTOR * 0.5
                new_sr = new_sr + (1.0 - new_sr) * rain_recovery
                is_rain_cleaning = rain_prob > 50  # Mark as cleaning if >50% chance

            new_sr = np.clip(new_sr, 0.70, 1.0)

            daily_forecasts.append(AnnualForecastDay(
                date=forecast_date,
                day_of_year=day_of_year,
                month=month,
                soiling_rate_pct_day=soiling_rate,
                sr_no_cleaning=new_sr,
                sr_with_recommended=new_sr,  # Will be updated by cleaning schedule
                aod_expected=aod_expected,
                rain_probability=rain_prob,
                is_cleaning_day=is_rain_cleaning,
                cleaning_reason='rain' if is_rain_cleaning else None,
            ))

            current_sr = new_sr

        return daily_forecasts

    def _apply_cleaning_schedule(
        self,
        daily_forecasts: List[AnnualForecastDay],
        cleanings_per_year: int
    ) -> List[AnnualForecastDay]:
        """Apply recommended cleaning schedule to forecasts."""
        # Calculate cleaning interval
        days_per_cleaning = 365 // cleanings_per_year

        # Find optimal cleaning dates (before SR drops below threshold)
        cleaning_dates = []
        current_sr = 1.0

        for i, day in enumerate(daily_forecasts):
            # Update current SR
            current_sr = day.sr_no_cleaning

            # Check if cleaning needed
            days_since_cleaning = i - (cleaning_dates[-1] if cleaning_dates else -1)
            needs_cleaning = (
                current_sr < self.SR_CLEANING_THRESHOLD and
                days_since_cleaning >= days_per_cleaning // 2  # Minimum interval
            )

            # Or scheduled interval reached
            scheduled_cleaning = days_since_cleaning >= days_per_cleaning

            if needs_cleaning or (scheduled_cleaning and len(cleaning_dates) < cleanings_per_year):
                # Prefer cleaning at end of month
                if day.date.day >= 20 or needs_cleaning:
                    cleaning_dates.append(i)
                    current_sr = 0.98  # Reset to near-clean

        # Apply cleaning schedule to with_recommended SR
        current_sr = 1.0
        for i, day in enumerate(daily_forecasts):
            # Apply daily soiling
            daily_loss = day.soiling_rate_pct_day / 100
            current_sr = current_sr - daily_loss

            # Check for rain cleaning (already marked)
            if day.is_cleaning_day and day.cleaning_reason == 'rain':
                current_sr = current_sr + (1.0 - current_sr) * self.RAIN_RECOVERY_FACTOR * 0.5

            # Check for scheduled cleaning
            if i in cleaning_dates:
                current_sr = 0.98  # Restore to near-clean
                day.is_cleaning_day = True
                day.cleaning_reason = 'scheduled'

            current_sr = np.clip(current_sr, 0.70, 1.0)
            day.sr_with_recommended = current_sr

        return daily_forecasts

    def _generate_monthly_summaries(
        self,
        daily_forecasts: List[AnnualForecastDay],
        df_climate: pd.DataFrame
    ) -> List[MonthlySummary]:
        """Generate monthly summary statistics."""
        monthly_summaries = []

        # Group by month
        monthly_data = {}
        for day in daily_forecasts:
            month = day.month
            if month not in monthly_data:
                monthly_data[month] = []
            monthly_data[month].append(day)

        for month in range(1, 13):
            if month not in monthly_data:
                continue

            days = monthly_data[month]

            avg_soiling_rate = np.mean([d.soiling_rate_pct_day for d in days])
            total_loss = sum([d.soiling_rate_pct_day for d in days]) / 100 * 100  # % loss
            rain_days = sum([1 for d in days if d.rain_probability > 50])
            avg_aod = np.mean([d.aod_expected for d in days])

            # Seasonal factor from climatology
            month_climate = self.data_fetcher.get_seasonal_climate(
                start_date=date(2025, month, 15),
                days=1
            )
            seasonal_factor = month_climate.iloc[0]['seasonal_factor'] if len(month_climate) > 0 else 1.0

            # Count cleanings in month
            cleanings = sum([1 for d in days if d.is_cleaning_day and d.cleaning_reason != 'rain'])

            monthly_summaries.append(MonthlySummary(
                month=month,
                month_name=self.MONTH_NAMES[month],
                soiling_rate_pct_day=avg_soiling_rate,
                total_soiling_loss_pct=total_loss,
                rain_days_expected=rain_days,
                seasonal_factor=seasonal_factor,
                avg_aod=avg_aod,
                recommended_cleanings=cleanings,
            ))

        return monthly_summaries

    def _calculate_annual_loss(self, sr_values: List[float]) -> float:
        """Calculate annual energy loss from SR trajectory."""
        # Average SR over the year
        avg_sr = np.mean(sr_values)
        # Loss = 1 - average SR
        return (1.0 - avg_sr) * 100

    def _get_optimal_cleaning_months(
        self,
        monthly_summaries: List[MonthlySummary]
    ) -> List[str]:
        """Determine optimal cleaning months based on soiling patterns."""
        # Sort months by soiling rate (descending)
        sorted_months = sorted(
            monthly_summaries,
            key=lambda m: m.soiling_rate_pct_day,
            reverse=True
        )

        # Take top 4 months with highest soiling
        optimal = []
        for month in sorted_months[:4]:
            # Clean before the month starts (previous month)
            clean_month = month.month - 1 if month.month > 1 else 12
            optimal.append(self.MONTH_NAMES[clean_month])

        return sorted(set(optimal))


def generate_annual_forecast_json(
    plant_id: str,
    latitude: float,
    longitude: float,
    output_path: Optional[str] = None,
    cleanings_per_year: int = 4
) -> Dict:
    """Generate annual soiling rate forecast and save to JSON.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    latitude, longitude : float
        Plant coordinates
    output_path : str, optional
        Output file path
    cleanings_per_year : int
        Number of recommended cleanings (default: 4)

    Returns
    -------
    Dict
        Forecast data as dictionary
    """
    forecaster = AnnualSoilingRateForecast(
        latitude=latitude,
        longitude=longitude,
        plant_id=plant_id
    )

    result = forecaster.generate_forecast(cleanings_per_year=cleanings_per_year)
    data = result.to_dict()

    if output_path:
        output_path = Path(output_path)
    else:
        project_root = Path(__file__).parent.parent.parent
        output_path = project_root / 'public' / 'data' / 'soiling' / plant_id / 'annual_soiling_forecast.json'

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"💾 Annual forecast saved to: {output_path}")

    return data
