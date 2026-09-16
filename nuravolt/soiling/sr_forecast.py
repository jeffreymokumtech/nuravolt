"""Short-term (30-day) soiling ratio forecast using ML + seasonal patterns.

This module generates soiling ratio forecasts:
- Days 1-7: ML model predictions using real weather/AOD forecast data
- Days 8-30: Physics-based decay model with seasonal patterns

The ML model was trained on DustIQ ground truth data and uses features
from weather, AOD, and PR data.

Forecast accuracy expectations:
- Days 1-3: ±0.5% SR (high confidence)
- Days 4-7: ±1.0% SR (moderate confidence)
- Days 8-14: ±2.0% SR (lower confidence, seasonal patterns)
- Days 15-30: ±3.0% SR (climatology-based)
"""

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .forecast_data import ForecastDataFetcher
from .sr_ml_features import PlantLocation, SoilingRatioFeatureEngineer
from .sr_ml_model import SoilingRatioModel


@dataclass
class ForecastDay:
    """Single day forecast result."""
    date: date
    day: int  # Day number (1-30)
    sr_forecast: float
    sr_lower_95: float
    sr_upper_95: float
    soiling_rate_pct: float  # Daily soiling rate %/day
    method: str  # 'ml_forecast' or 'seasonal_pattern'
    confidence: str  # 'high', 'moderate', 'low'

    # Optional forecast inputs
    precipitation_forecast_mm: Optional[float] = None
    aod_forecast: Optional[float] = None
    rain_probability: Optional[float] = None


@dataclass
class ForecastResult:
    """Complete forecast result."""
    plant_id: str
    generated_at: datetime
    model_info: Dict
    current_sr: float

    # Forecast periods
    ml_period_end: date  # End of ML forecast period (day 7)
    seasonal_period_end: date  # End of full forecast (day 30)

    # Daily forecasts
    daily: List[ForecastDay]

    # Summary metrics
    min_sr_forecast: float = 0.0
    max_soiling_loss_pct: float = 0.0
    cleaning_recommendation: Optional[str] = None
    rain_cleaning_expected: bool = False
    days_until_rain: Optional[int] = None

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "metadata": {
                "plant_id": self.plant_id,
                "generated_at": self.generated_at.isoformat(),
                "current_sr": self.current_sr,
                "model_info": self.model_info,
            },
            "forecast": {
                "period": {
                    "ml_days": 7,
                    "seasonal_days": 23,
                    "total_days": 30,
                    "ml_period_end": self.ml_period_end.isoformat(),
                    "seasonal_period_end": self.seasonal_period_end.isoformat(),
                },
                "summary": {
                    "min_sr_forecast": round(self.min_sr_forecast, 4),
                    "max_soiling_loss_pct": round(self.max_soiling_loss_pct, 2),
                    "rain_cleaning_expected": self.rain_cleaning_expected,
                    "days_until_rain": self.days_until_rain,
                    "cleaning_recommendation": self.cleaning_recommendation,
                },
                "daily": [
                    {
                        "date": d.date.isoformat(),
                        "day": d.day,
                        "sr_forecast": round(d.sr_forecast, 4),
                        "sr_lower_95": round(d.sr_lower_95, 4),
                        "sr_upper_95": round(d.sr_upper_95, 4),
                        "soiling_rate_pct": round(d.soiling_rate_pct, 3),
                        "method": d.method,
                        "confidence": d.confidence,
                        "precipitation_forecast_mm": round(d.precipitation_forecast_mm, 1) if d.precipitation_forecast_mm else None,
                        "aod_forecast": round(d.aod_forecast, 3) if d.aod_forecast else None,
                        "rain_probability": round(d.rain_probability, 1) if d.rain_probability else None,
                    }
                    for d in self.daily
                ],
            },
        }


class SoilingRatioForecaster:
    """Generate short-term (30-day) soiling ratio forecast.

    Uses a two-phase approach:
    1. Days 1-7: ML model with real weather/AOD forecast data
    2. Days 8-30: Physics decay model with seasonal patterns

    The ML model was trained on historical DustIQ data and captures
    the relationship between environmental factors and soiling.

    Example
    -------
    >>> forecaster = SoilingRatioForecaster(
    ...     model_path="models/soiling/sr_model_alpha1.pkl",
    ...     latitude=37.45,
    ...     longitude=-6.14
    ... )
    >>> result = forecaster.forecast(current_sr=0.985)
    >>> print(f"7-day SR: {result.daily[6].sr_forecast:.3f}")
    """

    # Confidence intervals by forecast horizon (95% CI half-width)
    CONFIDENCE_INTERVALS = {
        (1, 3): 0.005,    # Days 1-3: ±0.5%
        (4, 7): 0.010,    # Days 4-7: ±1.0%
        (8, 14): 0.020,   # Days 8-14: ±2.0%
        (15, 30): 0.030,  # Days 15-30: ±3.0%
    }

    # Soiling rate decay parameters (from ALPHA1 analysis)
    BASE_SOILING_RATE = 0.0025  # 0.25%/day base rate
    RAIN_CLEANING_THRESHOLD = 5.0  # mm for effective cleaning
    RAIN_RECOVERY_FACTOR = 0.90  # 90% restoration efficiency

    def __init__(
        self,
        model_path: str,
        latitude: float,
        longitude: float,
        timezone: str = "Europe/Madrid",
        plant_id: str = "unknown"
    ):
        """Initialize forecaster.

        Parameters
        ----------
        model_path : str
            Path to trained SoilingRatioModel pickle file
        latitude, longitude : float
            Plant coordinates
        timezone : str
            Plant timezone (default: Europe/Madrid)
        plant_id : str
            Plant identifier for output
        """
        self.model_path = Path(model_path)
        self.latitude = latitude
        self.longitude = longitude
        self.timezone = timezone
        self.plant_id = plant_id

        # Load model
        if self.model_path.exists():
            self.model = SoilingRatioModel.load(self.model_path)
            print(f"✅ Loaded SR model from {self.model_path}")
        else:
            print(f"⚠️ Model not found at {self.model_path}, using physics-only mode")
            self.model = None

        # Initialize data fetcher and feature engineer
        self.data_fetcher = ForecastDataFetcher(
            latitude=latitude,
            longitude=longitude,
            timezone=timezone
        )
        self.location = PlantLocation(latitude=latitude, longitude=longitude)
        self.feature_engineer = SoilingRatioFeatureEngineer(self.location)

    def forecast(
        self,
        current_sr: float = 1.0,
        days: int = 30,
        df_pr_recent: Optional[pd.DataFrame] = None,
        df_weather_historical: Optional[pd.DataFrame] = None,
        last_cleaning_date: Optional[pd.Timestamp] = None
    ) -> ForecastResult:
        """Generate SR forecast.

        Parameters
        ----------
        current_sr : float
            Current soiling ratio (default: 1.0 = clean)
        days : int
            Total forecast days (default: 30)
        df_pr_recent : pd.DataFrame, optional
            Recent PR data (last 30 days) for feature generation
        df_weather_historical : pd.DataFrame, optional
            Recent weather data (last 30 days) for rolling features
        last_cleaning_date : pd.Timestamp, optional
            Date of last cleaning event

        Returns
        -------
        ForecastResult
            Complete forecast with daily predictions and confidence intervals
        """
        print(f"🔮 Generating {days}-day SR forecast for {self.plant_id}...")
        print(f"   Current SR: {current_sr:.3f}")

        # Fetch forecast data
        df_weather = self.data_fetcher.fetch_weather_forecast(days=7)
        df_aod = self.data_fetcher.fetch_aod_forecast(days=5)
        df_climate = self.data_fetcher.get_seasonal_climate(days=days)

        print(f"   Weather forecast: {len(df_weather)} days")
        print(f"   AOD forecast: {len(df_aod)} days")

        # Phase 1: ML-based forecast (days 1-7)
        ml_days = min(7, days)
        ml_forecasts = self._forecast_ml_period(
            current_sr=current_sr,
            df_weather=df_weather,
            df_aod=df_aod,
            df_pr_recent=df_pr_recent,
            df_weather_historical=df_weather_historical,
            last_cleaning_date=last_cleaning_date,
            days=ml_days
        )

        # Phase 2: Seasonal pattern forecast (days 8-30)
        seasonal_days = days - ml_days
        if seasonal_days > 0:
            # Start from end of ML forecast
            start_sr = ml_forecasts[-1].sr_forecast if ml_forecasts else current_sr
            start_date = ml_forecasts[-1].date if ml_forecasts else datetime.now().date()

            seasonal_forecasts = self._forecast_seasonal_period(
                start_sr=start_sr,
                start_date=start_date,
                df_climate=df_climate,
                days=seasonal_days,
                day_offset=ml_days
            )
        else:
            seasonal_forecasts = []

        # Combine forecasts
        all_forecasts = ml_forecasts + seasonal_forecasts

        # Check for rain cleaning
        rain_cleaning_expected = False
        days_until_rain = None
        for i, forecast in enumerate(all_forecasts):
            if forecast.precipitation_forecast_mm and forecast.precipitation_forecast_mm >= self.RAIN_CLEANING_THRESHOLD:
                rain_cleaning_expected = True
                days_until_rain = i + 1
                break

        # Generate cleaning recommendation
        min_sr = min(f.sr_forecast for f in all_forecasts) if all_forecasts else current_sr
        cleaning_recommendation = self._generate_cleaning_recommendation(
            min_sr=min_sr,
            rain_cleaning_expected=rain_cleaning_expected,
            days_until_rain=days_until_rain
        )

        # Build result
        result = ForecastResult(
            plant_id=self.plant_id,
            generated_at=datetime.now(),
            model_info={
                "model_path": str(self.model_path),
                "model_available": self.model is not None,
                "validation_mae": self.model.metadata.validation_mae if self.model and self.model.metadata else None,
            },
            current_sr=current_sr,
            ml_period_end=ml_forecasts[-1].date if ml_forecasts else datetime.now().date(),
            seasonal_period_end=all_forecasts[-1].date if all_forecasts else datetime.now().date(),
            daily=all_forecasts,
            min_sr_forecast=min_sr,
            max_soiling_loss_pct=(1.0 - min_sr) * 100,
            cleaning_recommendation=cleaning_recommendation,
            rain_cleaning_expected=rain_cleaning_expected,
            days_until_rain=days_until_rain,
        )

        print(f"✅ Forecast generated: {len(all_forecasts)} days")
        print(f"   Min SR: {min_sr:.3f} (max loss: {(1-min_sr)*100:.1f}%)")
        if rain_cleaning_expected:
            print(f"   Rain cleaning expected in {days_until_rain} day(s)")

        return result

    def _forecast_ml_period(
        self,
        current_sr: float,
        df_weather: pd.DataFrame,
        df_aod: pd.DataFrame,
        df_pr_recent: Optional[pd.DataFrame],
        df_weather_historical: Optional[pd.DataFrame],
        last_cleaning_date: Optional[pd.Timestamp],
        days: int
    ) -> List[ForecastDay]:
        """Generate ML-based forecast for days 1-7."""
        forecasts = []

        if self.model is None:
            # Physics-only fallback
            return self._forecast_physics_only(
                current_sr=current_sr,
                df_weather=df_weather,
                days=days,
                method="physics_fallback"
            )

        # Generate forecast features
        df_weather_subset = df_weather.iloc[:days]

        try:
            X_forecast = self.feature_engineer.generate_forecast_features(
                df_weather_forecast=df_weather_subset,
                df_aod_forecast=df_aod,
                df_pr_recent=df_pr_recent,
                df_weather_historical=df_weather_historical,
                current_sr=current_sr,
                last_cleaning_date=last_cleaning_date
            )

            # Get ML predictions
            sr_predictions = self.model.predict(X_forecast)

            # Generate daily forecasts
            for i, (date, sr_pred) in enumerate(zip(X_forecast.index, sr_predictions)):
                day_num = i + 1

                # Get confidence interval
                ci_half = self._get_confidence_interval(day_num)

                # Get weather data for this day
                precip = df_weather.loc[date, 'precipitation_mm'] if date in df_weather.index else None
                precip_prob = df_weather.loc[date, 'precipitation_probability'] if 'precipitation_probability' in df_weather.columns and date in df_weather.index else None
                aod = df_aod.loc[date, 'aod_550nm'] if date in df_aod.index else None

                # Apply rain cleaning if predicted
                if precip and precip >= self.RAIN_CLEANING_THRESHOLD:
                    sr_pred = sr_pred + (1.0 - sr_pred) * self.RAIN_RECOVERY_FACTOR
                    sr_pred = min(sr_pred, 1.0)

                # Clip to valid range
                sr_pred = np.clip(sr_pred, 0.70, 1.0)

                # Calculate daily soiling rate
                if i == 0:
                    soiling_rate = (current_sr - sr_pred) * 100
                else:
                    prev_sr = forecasts[-1].sr_forecast
                    soiling_rate = (prev_sr - sr_pred) * 100

                # Determine confidence level
                if day_num <= 3:
                    confidence = "high"
                elif day_num <= 7:
                    confidence = "moderate"
                else:
                    confidence = "low"

                forecasts.append(ForecastDay(
                    date=date.date() if hasattr(date, 'date') else date,
                    day=day_num,
                    sr_forecast=float(sr_pred),
                    sr_lower_95=float(np.clip(sr_pred - ci_half, 0.70, 1.0)),
                    sr_upper_95=float(np.clip(sr_pred + ci_half, 0.70, 1.0)),
                    soiling_rate_pct=max(0, soiling_rate),
                    method="ml_forecast",
                    confidence=confidence,
                    precipitation_forecast_mm=float(precip) if precip else None,
                    aod_forecast=float(aod) if aod else None,
                    rain_probability=float(precip_prob) if precip_prob else None,
                ))

        except Exception as e:
            print(f"⚠️ ML forecast failed: {e}, using physics fallback")
            return self._forecast_physics_only(
                current_sr=current_sr,
                df_weather=df_weather,
                days=days,
                method="physics_fallback"
            )

        return forecasts

    def _forecast_seasonal_period(
        self,
        start_sr: float,
        start_date: date,
        df_climate: pd.DataFrame,
        days: int,
        day_offset: int
    ) -> List[ForecastDay]:
        """Generate seasonal pattern forecast for days 8-30."""
        forecasts = []
        current_sr = start_sr

        for i in range(days):
            day_num = day_offset + i + 1
            forecast_date = start_date + timedelta(days=i + 1)

            # Get seasonal data
            if forecast_date in df_climate.index:
                climate_row = df_climate.loc[forecast_date]
                soiling_rate = climate_row['soiling_rate_pct_day'] / 100  # Convert to decimal
                rain_prob = climate_row['rain_probability']
                seasonal_factor = climate_row['seasonal_factor']
            else:
                # Use default values
                soiling_rate = self.BASE_SOILING_RATE
                rain_prob = 15.0
                seasonal_factor = 1.0

            # Apply daily soiling
            daily_decay = soiling_rate * seasonal_factor
            new_sr = current_sr - daily_decay

            # Probabilistic rain cleaning
            if rain_prob > 30:  # >30% rain probability
                # Partial recovery based on probability
                recovery_factor = (rain_prob / 100) * self.RAIN_RECOVERY_FACTOR * 0.5
                new_sr = new_sr + (1.0 - new_sr) * recovery_factor

            # Clip to valid range
            new_sr = np.clip(new_sr, 0.70, 1.0)

            # Get confidence interval
            ci_half = self._get_confidence_interval(day_num)

            forecasts.append(ForecastDay(
                date=forecast_date,
                day=day_num,
                sr_forecast=float(new_sr),
                sr_lower_95=float(np.clip(new_sr - ci_half, 0.70, 1.0)),
                sr_upper_95=float(np.clip(new_sr + ci_half, 0.70, 1.0)),
                soiling_rate_pct=float(daily_decay * 100),
                method="seasonal_pattern",
                confidence="low",
                precipitation_forecast_mm=None,
                aod_forecast=None,
                rain_probability=float(rain_prob),
            ))

            current_sr = new_sr

        return forecasts

    def _forecast_physics_only(
        self,
        current_sr: float,
        df_weather: pd.DataFrame,
        days: int,
        method: str
    ) -> List[ForecastDay]:
        """Generate physics-only forecast when ML is unavailable."""
        forecasts = []
        sr = current_sr

        for i in range(days):
            day_num = i + 1
            forecast_date = df_weather.index[i] if i < len(df_weather) else datetime.now().date() + timedelta(days=i)

            # Get precipitation if available
            precip = df_weather.loc[forecast_date, 'precipitation_mm'] if forecast_date in df_weather.index else 0

            # Apply physics decay
            month = forecast_date.month if hasattr(forecast_date, 'month') else datetime.now().month
            seasonal_factor = self._get_seasonal_factor(month)
            daily_decay = self.BASE_SOILING_RATE * seasonal_factor

            new_sr = sr - daily_decay

            # Rain cleaning
            if precip >= self.RAIN_CLEANING_THRESHOLD:
                new_sr = new_sr + (1.0 - new_sr) * self.RAIN_RECOVERY_FACTOR

            new_sr = np.clip(new_sr, 0.70, 1.0)

            ci_half = self._get_confidence_interval(day_num)

            forecasts.append(ForecastDay(
                date=forecast_date.date() if hasattr(forecast_date, 'date') else forecast_date,
                day=day_num,
                sr_forecast=float(new_sr),
                sr_lower_95=float(np.clip(new_sr - ci_half, 0.70, 1.0)),
                sr_upper_95=float(np.clip(new_sr + ci_half, 0.70, 1.0)),
                soiling_rate_pct=float(daily_decay * 100),
                method=method,
                confidence="moderate" if day_num <= 3 else "low",
                precipitation_forecast_mm=float(precip) if precip else None,
            ))

            sr = new_sr

        return forecasts

    def _get_confidence_interval(self, day_num: int) -> float:
        """Get 95% CI half-width for given forecast day."""
        for (day_start, day_end), ci_half in self.CONFIDENCE_INTERVALS.items():
            if day_start <= day_num <= day_end:
                return ci_half
        return 0.030  # Default for beyond day 30

    def _get_seasonal_factor(self, month: int) -> float:
        """Get seasonal soiling rate multiplier."""
        # Higher soiling in dry months (May-Sep)
        seasonal_factors = {
            1: 0.5, 2: 0.6, 3: 0.8, 4: 1.0,
            5: 1.3, 6: 1.6, 7: 1.8, 8: 1.7,
            9: 1.2, 10: 0.7, 11: 0.5, 12: 0.4,
        }
        return seasonal_factors.get(month, 1.0)

    def _generate_cleaning_recommendation(
        self,
        min_sr: float,
        rain_cleaning_expected: bool,
        days_until_rain: Optional[int]
    ) -> str:
        """Generate cleaning recommendation based on forecast."""
        max_loss = (1.0 - min_sr) * 100

        if max_loss < 2.0:
            return "No cleaning needed - minimal soiling expected"
        elif max_loss < 4.0:
            if rain_cleaning_expected and days_until_rain and days_until_rain <= 7:
                return f"Wait for rain cleaning in ~{days_until_rain} day(s)"
            else:
                return "Consider cleaning if no rain expected within 7 days"
        elif max_loss < 6.0:
            if rain_cleaning_expected and days_until_rain and days_until_rain <= 5:
                return f"Rain cleaning expected in ~{days_until_rain} day(s) - monitor"
            else:
                return "Schedule cleaning within 7-10 days"
        else:
            return "Cleaning recommended soon - significant soiling expected"


def generate_forecast_json(
    plant_id: str,
    model_path: str,
    latitude: float,
    longitude: float,
    current_sr: float = 1.0,
    output_path: Optional[str] = None
) -> Dict:
    """Generate SR forecast and save to JSON.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    model_path : str
        Path to trained model
    latitude, longitude : float
        Plant coordinates
    current_sr : float
        Current soiling ratio (default: 1.0)
    output_path : str, optional
        Output file path (default: creates in public/data/soiling/{plant_id}/)

    Returns
    -------
    Dict
        Forecast data as dictionary
    """
    forecaster = SoilingRatioForecaster(
        model_path=model_path,
        latitude=latitude,
        longitude=longitude,
        plant_id=plant_id
    )

    result = forecaster.forecast(current_sr=current_sr)
    data = result.to_dict()

    if output_path:
        output_path = Path(output_path)
    else:
        project_root = Path(__file__).parent.parent.parent
        output_path = project_root / 'public' / 'data' / 'soiling' / plant_id / 'sr_forecast.json'

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"💾 Forecast saved to: {output_path}")

    return data
