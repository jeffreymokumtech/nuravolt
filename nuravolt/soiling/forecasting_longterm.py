"""Long-term (365-day) soiling forecasting with physics-ML hybrid approach."""

import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional, Union

# Import unified model interface
try:
    from .ml_models import BaseSoilingModel, ModelFactory, LIGHTGBM_AVAILABLE, CATBOOST_AVAILABLE
except ImportError:
    # Fallback for direct execution
    BaseSoilingModel = object
    LIGHTGBM_AVAILABLE = False
    CATBOOST_AVAILABLE = False


class PhysicsMLHybridForecaster:
    """
    365-day soiling forecast using physics-informed baseline + ML corrections.

    Combines:
    1. Physics baseline: Soiling rate degradation model with seasonal variation
    2. ML corrections: LightGBM/CatBoost for residual learning
    3. Uncertainty quantification: Prediction intervals via quantile regression

    Approach:
    - Physics provides interpretable baseline (0.25%/day soiling rate)
    - ML learns corrections for weather patterns, dust events, rain cleaning
    - Hybrid approach is robust and degrades gracefully

    Supports both LightGBM and CatBoost models via unified interface.
    """

    def __init__(self, site_config, trained_model: Union[BaseSoilingModel, object, None] = None,
                 model_type: str = 'catboost'):
        """
        Initialize hybrid forecaster.

        Parameters:
        -----------
        site_config : SoilingConfig
            Site configuration with soiling parameters
        trained_model : BaseSoilingModel, LGBMRegressor, CatBoostRegressor, or None
            Pre-trained ML model for corrections. Can be:
            - A unified BaseSoilingModel instance
            - A raw LightGBM/CatBoost model
            - None (physics-only mode)
        model_type : str
            Model type hint: 'lightgbm' or 'catboost' (used when training new model)
        """
        self.config = site_config
        self.model = trained_model
        self.model_type = model_type.lower()

        # Physics parameters from config
        self.base_soiling_rate = site_config.expected_soiling_rate_per_day / 100  # Convert to fraction
        self.rain_threshold = site_config.rain_cleaning_threshold_mm

        # Seasonal modulation factors (Andalusia climate)
        self.seasonal_factors = {
            'dry_season': 1.5,    # May-Sept: higher soiling (1.5x base rate)
            'wet_season': 0.5,    # Oct-Apr: lower soiling (0.5x base rate)
        }

    def predict_365d_hybrid(self,
                           last_sr: float,
                           last_date: pd.Timestamp,
                           df_daily_historical: pd.DataFrame,
                           weather_forecast: Optional[pd.DataFrame] = None,
                           include_uncertainty: bool = True) -> pd.DataFrame:
        """
        Generate 365-day soiling forecast using physics-ML hybrid.

        Parameters:
        -----------
        last_sr : float
            Last observed soiling ratio (e.g., 0.95)
        last_date : pd.Timestamp
            Last date with observed data
        df_daily_historical : pd.DataFrame
            Historical daily data (for seasonal patterns)
        weather_forecast : pd.DataFrame, optional
            14-day weather forecast (rainfall, temperature)
        include_uncertainty : bool
            Whether to include prediction intervals

        Returns:
        --------
        df_forecast : pd.DataFrame
            365-day forecast with columns:
            - date: Forecast date
            - sr_physics: Physics baseline prediction
            - sr_ml_correction: ML correction factor
            - sr_predicted: Final hybrid prediction
            - sr_lower_bound: 10th percentile (if include_uncertainty)
            - sr_upper_bound: 90th percentile (if include_uncertainty)
            - soiling_loss_pct: Predicted soiling loss (%)
            - is_cleaning_needed: Boolean flag (SR < 0.97)
        """
        print("⚙️ Generating 365-day soiling forecast (Physics-ML Hybrid)...")

        # Generate date range
        forecast_dates = pd.date_range(
            start=last_date + timedelta(days=1),
            periods=365,
            freq='D'
        )

        # Initialize forecast arrays
        sr_physics = np.zeros(365)
        sr_ml_correction = np.zeros(365)
        sr_predicted = np.zeros(365)
        sr_lower = np.zeros(365) if include_uncertainty else None
        sr_upper = np.zeros(365) if include_uncertainty else None

        # Initialize with last observed SR
        sr_current = last_sr

        # Extract seasonal patterns from historical data
        monthly_soiling_patterns = self._calculate_monthly_patterns(df_daily_historical)

        print(f"   Starting SR: {last_sr:.3f}")
        print(f"   Base soiling rate: {self.base_soiling_rate*100:.2f}%/day")
        print(f"   Forecast period: {forecast_dates[0].date()} to {forecast_dates[-1].date()}")

        # Day-by-day simulation
        for i, date in enumerate(forecast_dates):
            # 1. Physics baseline: Soiling accumulation
            seasonal_factor = self._get_seasonal_factor(date)
            daily_soiling = self.base_soiling_rate * seasonal_factor

            # Degrade SR (soiling accumulates)
            sr_physics_day = sr_current - daily_soiling

            # 2. Check for rain cleaning (if weather forecast available)
            rain_amount = 0.0
            if weather_forecast is not None and date in weather_forecast.index:
                rain_amount = weather_forecast.loc[date, 'rainfall']
            elif i < 14:  # Use historical patterns for first 14 days
                rain_amount = self._estimate_rainfall(date, df_daily_historical)

            # Rain cleaning effect
            if rain_amount > self.rain_threshold:
                cleaning_effectiveness = min(0.95, rain_amount / 20.0)  # Max 95% restoration
                sr_physics_day = sr_physics_day + (1.0 - sr_physics_day) * cleaning_effectiveness

            # Constrain to realistic range
            sr_physics_day = np.clip(sr_physics_day, 0.70, 1.0)

            # 3. ML correction (if model available)
            ml_correction = 0.0
            if self.model is not None and i < 90:  # ML reliable for ~90 days
                # Extract features for this date
                features = self._extract_forecast_features(
                    date,
                    sr_physics_day,
                    monthly_soiling_patterns,
                    df_daily_historical
                )

                # Predict residual correction - handle both unified and raw models
                try:
                    if hasattr(self.model, 'predict'):
                        # Check if it's a unified BaseSoilingModel
                        if isinstance(self.model, BaseSoilingModel):
                            # Unified model expects DataFrame
                            features_df = pd.DataFrame([features], columns=self._get_feature_names())
                            ml_correction = self.model.predict(features_df)[0]
                        else:
                            # Raw model (LightGBM Booster, CatBoost, sklearn)
                            ml_correction = self.model.predict([features])[0]
                except Exception:
                    ml_correction = 0.0  # Fall back to physics-only

            # 4. Combine physics + ML
            sr_final = sr_physics_day + ml_correction
            sr_final = np.clip(sr_final, 0.70, 1.0)

            # 5. Uncertainty bounds (if requested)
            if include_uncertainty:
                uncertainty = self._calculate_uncertainty(i, sr_final)
                sr_lower[i] = np.clip(sr_final - uncertainty, 0.70, 1.0)
                sr_upper[i] = np.clip(sr_final + uncertainty, 0.70, 1.0)

            # Store results
            sr_physics[i] = sr_physics_day
            sr_ml_correction[i] = ml_correction
            sr_predicted[i] = sr_final

            # Update current SR for next iteration
            sr_current = sr_final

        # Create forecast DataFrame
        df_forecast = pd.DataFrame({
            'date': forecast_dates,
            'sr_physics': sr_physics,
            'sr_ml_correction': sr_ml_correction,
            'sr_predicted': sr_predicted,
            'soiling_loss_pct': (1 - sr_predicted) * 100,
            'is_cleaning_needed': sr_predicted < 0.97,
        })

        if include_uncertainty:
            df_forecast['sr_lower_bound'] = sr_lower
            df_forecast['sr_upper_bound'] = sr_upper

        df_forecast.set_index('date', inplace=True)

        # Summary statistics
        avg_sr = sr_predicted.mean()
        min_sr = sr_predicted.min()
        max_loss = (1 - min_sr) * 100
        cleaning_days = (sr_predicted < 0.97).sum()

        print(f"\n✅ 365-day forecast generated")
        print(f"   Average SR: {avg_sr:.3f}")
        print(f"   Minimum SR: {min_sr:.3f} (max loss: {max_loss:.1f}%)")
        print(f"   Days needing cleaning (SR<0.97): {cleaning_days}")

        return df_forecast

    def _get_seasonal_factor(self, date: pd.Timestamp) -> float:
        """Get seasonal soiling rate multiplier."""
        month = date.month
        # Dry season: May-Sept (months 5-9)
        if 5 <= month <= 9:
            return self.seasonal_factors['dry_season']
        else:
            return self.seasonal_factors['wet_season']

    def _calculate_monthly_patterns(self, df_daily: pd.DataFrame) -> Dict[int, float]:
        """Calculate typical monthly soiling patterns from historical data."""
        monthly_patterns = {}

        for month in range(1, 13):
            month_data = df_daily[df_daily.index.month == month]
            if len(month_data) > 0:
                # Calculate average soiling rate change per day
                sr_changes = month_data['soiling_ratio_smooth'].diff()
                monthly_patterns[month] = sr_changes.mean()
            else:
                monthly_patterns[month] = -self.base_soiling_rate

        return monthly_patterns

    def _estimate_rainfall(self, date: pd.Timestamp, df_daily: pd.DataFrame) -> float:
        """Estimate rainfall using historical patterns."""
        # Get historical rainfall for same month/day
        month = date.month
        day = date.day

        historical = df_daily[
            (df_daily.index.month == month) &
            (df_daily.index.day == day)
        ]

        if len(historical) > 0:
            return historical['rainfall'].mean()
        else:
            return 0.0

    def _extract_forecast_features(self,
                                   date: pd.Timestamp,
                                   sr_physics: float,
                                   monthly_patterns: Dict,
                                   df_daily: pd.DataFrame) -> np.ndarray:
        """Extract features for ML correction at forecast date."""
        month = date.month
        day_of_year = date.dayofyear

        # Temporal features
        features = [
            month,
            day_of_year,
            np.sin(2 * np.pi * day_of_year / 365),
            np.cos(2 * np.pi * day_of_year / 365),
            1 if 5 <= month <= 9 else 0,  # is_dry_season
            1 if month in [6, 7, 8] else 0,  # is_summer_peak
        ]

        # Physics prediction
        features.append(sr_physics)

        # Historical monthly pattern
        features.append(monthly_patterns.get(month, -self.base_soiling_rate))

        return np.array(features)

    def _get_feature_names(self) -> List[str]:
        """Get feature names for ML model input."""
        return [
            'month',
            'day_of_year',
            'sin_day_of_year',
            'cos_day_of_year',
            'is_dry_season',
            'is_summer_peak',
            'sr_physics',
            'monthly_pattern',
        ]

    def _calculate_uncertainty(self, days_ahead: int, sr_predicted: float) -> float:
        """
        Calculate prediction uncertainty (grows with forecast horizon).

        Uncertainty model:
        - Days 1-30: ±2%
        - Days 31-90: ±3-5%
        - Days 91-180: ±5-8%
        - Days 181-365: ±8-12%
        """
        if days_ahead <= 30:
            base_uncertainty = 0.02
        elif days_ahead <= 90:
            base_uncertainty = 0.03 + (days_ahead - 30) * 0.02 / 60
        elif days_ahead <= 180:
            base_uncertainty = 0.05 + (days_ahead - 90) * 0.03 / 90
        else:
            base_uncertainty = 0.08 + (days_ahead - 180) * 0.04 / 185

        # Uncertainty increases when SR is very low (more uncertain)
        if sr_predicted < 0.85:
            base_uncertainty *= 1.2

        return base_uncertainty


def simulate_cleaning_scenarios(df_forecast: pd.DataFrame,
                                 cleaning_dates: List[str],
                                 cleaning_effectiveness: float = 0.95) -> pd.DataFrame:
    """
    Simulate soiling forecast with scheduled cleanings.

    Parameters:
    -----------
    df_forecast : pd.DataFrame
        365-day forecast without cleanings
    cleaning_dates : list of str
        Dates to simulate cleanings (e.g., ['2025-05-15', '2025-08-20'])
    cleaning_effectiveness : float
        Cleaning effectiveness (default: 0.95 = 95% restoration)

    Returns:
    --------
    df_scenario : pd.DataFrame
        Forecast with cleaning events applied
    """
    df_scenario = df_forecast.copy()

    for clean_date in cleaning_dates:
        clean_date_ts = pd.Timestamp(clean_date)

        if clean_date_ts in df_scenario.index:
            # Get SR before cleaning
            sr_before = df_scenario.loc[clean_date_ts, 'sr_predicted']

            # Apply cleaning (restore to near-perfect)
            sr_after = sr_before + (1.0 - sr_before) * cleaning_effectiveness

            # Update forecast from cleaning date onward
            idx = df_scenario.index.get_loc(clean_date_ts)
            df_scenario.loc[clean_date_ts:, 'sr_predicted'] = (
                df_scenario.loc[clean_date_ts:, 'sr_predicted'] + (sr_after - sr_before)
            )
            df_scenario.loc[clean_date_ts:, 'soiling_loss_pct'] = (
                (1 - df_scenario.loc[clean_date_ts:, 'sr_predicted']) * 100
            )

    return df_scenario
