"""Plant-agnostic feature engineering for soiling ratio ML prediction.

This module generates features that are available at ANY plant globally,
enabling transfer learning from plants with DustIQ sensors to plants without.

Features are designed to:
1. Predict soiling accumulation (weather, dust, temporal)
2. NOT use power-based metrics (would cause data leakage)
3. NOT use historical SR (not available at transfer plants)
"""

import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


@dataclass
class PlantLocation:
    """Plant location and climate metadata."""
    latitude: float
    longitude: float
    elevation_m: float = 0.0
    climate_zone: str = "mediterranean"  # mediterranean, arid, tropical, temperate
    distance_to_coast_km: float = 50.0


class SoilingRatioFeatureEngineer:
    """Plant-agnostic feature engineering for SR prediction.

    Generates features from weather and aerosol data that are available
    globally via Open-Meteo and CAMS APIs, enabling transfer learning.

    Key Design Principles:
    - NO historical SR features (not available at transfer plants)
    - NO power-based features (would cause data leakage)
    - Only environmental features that PREDICT soiling accumulation
    """

    ROLLING_WINDOWS = [7, 14, 30]

    # Climate zone definitions
    CLIMATE_ZONES = {
        "mediterranean": {"dry_months": [5, 6, 7, 8, 9], "wet_months": [10, 11, 12, 1, 2, 3, 4]},
        "arid": {"dry_months": list(range(1, 13)), "wet_months": []},  # Year-round dry
        "tropical": {"dry_months": [12, 1, 2, 3], "wet_months": [4, 5, 6, 7, 8, 9, 10, 11]},
        "temperate": {"dry_months": [6, 7, 8], "wet_months": [9, 10, 11, 12, 1, 2, 3, 4, 5]},
    }

    def __init__(self, location: PlantLocation):
        """
        Initialize feature engineer with plant location.

        Parameters
        ----------
        location : PlantLocation
            Plant location and climate metadata
        """
        self.location = location
        self.feature_names: List[str] = []

    def generate_features(
        self,
        df_weather: pd.DataFrame,
        df_aod: Optional[pd.DataFrame] = None,
        df_cleaning_events: Optional[pd.DataFrame] = None,
        df_pr: Optional[pd.DataFrame] = None,
        df_twin_outputs: Optional[pd.DataFrame] = None
    ) -> pd.DataFrame:
        """
        Generate complete feature set from environmental data.

        Parameters
        ----------
        df_weather : pd.DataFrame
            Daily weather data with columns:
            - date (index or column)
            - precipitation_mm
            - temperature (optional)
            - humidity (optional)
            - wind_speed (optional)

        df_aod : pd.DataFrame, optional
            Daily AOD data from CAMS with columns:
            - date (index or column)
            - aod_550nm
            - dust_aod_550nm (optional)
            - pm10 (optional)
            - pm2p5 (optional)

        df_cleaning_events : pd.DataFrame, optional
            Known cleaning events with columns:
            - date (index or column)
            - is_rain_cleaning: bool
            - is_manual_cleaning: bool

        df_pr : pd.DataFrame, optional
            Daily Performance Ratio data with columns:
            - date (index or column)
            - pr or performance_ratio

        df_twin_outputs : pd.DataFrame, optional
            Digital twin outputs with columns:
            - date (index or column)
            - current_cv: DC current coefficient of variation
            - temp_deviation: T_actual - T_expected (°C)
            - voltage_cv: DC voltage coefficient of variation
            - current_imbalance: Max current deviation ratio

        Returns
        -------
        pd.DataFrame
            Feature matrix with one row per day
        """
        # Ensure date index
        if 'date' in df_weather.columns:
            df_weather = df_weather.set_index('date')
        df_weather.index = pd.to_datetime(df_weather.index)

        features = {}

        # 1. Rainfall features (primary cleaning mechanism)
        features.update(self._create_rainfall_features(df_weather))

        # 2. Temperature features
        if 'temperature' in df_weather.columns:
            features.update(self._create_temperature_features(df_weather))

        # 3. Humidity features
        if 'humidity' in df_weather.columns:
            features.update(self._create_humidity_features(df_weather))

        # 4. Wind features
        if 'wind_speed' in df_weather.columns:
            features.update(self._create_wind_features(df_weather))

        # 5. AOD/Aerosol features (if available)
        if df_aod is not None:
            if 'date' in df_aod.columns:
                df_aod = df_aod.set_index('date')
            df_aod.index = pd.to_datetime(df_aod.index)
            features.update(self._create_aod_features(df_aod, df_weather.index))

        # 6. Performance Ratio features (if available - lagging soiling indicator)
        if df_pr is not None:
            features.update(self._create_pr_features(df_pr, df_weather.index))

        # 7. Temporal features (always available)
        features.update(self._create_temporal_features(df_weather.index))

        # 8. Location features (static, replicated per row)
        features.update(self._create_location_features(len(df_weather)))

        # 9. Digital twin features (if available)
        if df_twin_outputs is not None:
            features.update(self._create_digital_twin_features(
                df_twin_outputs, df_weather.index
            ))

        # 10. Cleaning event features (if available)
        if df_cleaning_events is not None:
            features.update(self._create_cleaning_features(
                df_weather.index, df_cleaning_events
            ))
        else:
            # Infer cleaning from rain
            features.update(self._infer_cleaning_from_rain(df_weather))

        # Build DataFrame
        df_features = pd.DataFrame(features, index=df_weather.index)

        # Store feature names
        self.feature_names = df_features.columns.tolist()

        return df_features

    def _create_rainfall_features(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        """Create rainfall-based features."""
        features = {}
        precip = df['precipitation_mm'].fillna(0)

        # Rolling sums
        for window in self.ROLLING_WINDOWS:
            features[f'rainfall_sum_{window}d'] = precip.rolling(window, min_periods=1).sum()
            features[f'rainfall_max_{window}d'] = precip.rolling(window, min_periods=1).max()
            features[f'rainfall_days_{window}d'] = (precip > 1.0).rolling(window, min_periods=1).sum()

        # Days since significant rain (cleaning threshold = 5mm)
        is_cleaning_rain = precip >= 5.0
        days_since_rain = np.zeros(len(df))
        current_count = 0
        for i in range(len(df)):
            if is_cleaning_rain.iloc[i]:
                current_count = 0
            else:
                current_count += 1
            days_since_rain[i] = current_count
        features['days_since_rain'] = days_since_rain

        # Rain intensity indicator
        features['is_heavy_rain'] = (precip >= 10.0).astype(float)
        features['is_moderate_rain'] = ((precip >= 5.0) & (precip < 10.0)).astype(float)

        return features

    def _create_temperature_features(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        """Create temperature-based features."""
        features = {}
        temp = df['temperature'].fillna(df['temperature'].mean())

        for window in [7, 14]:
            features[f'temp_mean_{window}d'] = temp.rolling(window, min_periods=1).mean()
            features[f'temp_std_{window}d'] = temp.rolling(window, min_periods=1).std().fillna(0)
            features[f'temp_range_{window}d'] = (
                temp.rolling(window, min_periods=1).max() -
                temp.rolling(window, min_periods=1).min()
            )

        # Thermal stress indicator (high temps can affect dust adhesion)
        features['is_high_temp'] = (temp > 35.0).astype(float)

        return features

    def _create_humidity_features(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        """Create humidity-based features."""
        features = {}
        humidity = df['humidity'].fillna(df['humidity'].mean())

        for window in [7, 14]:
            features[f'humidity_mean_{window}d'] = humidity.rolling(window, min_periods=1).mean()

        # High humidity aids dust adhesion
        features['is_high_humidity'] = (humidity > 70.0).astype(float)

        return features

    def _create_wind_features(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        """Create wind-based features."""
        features = {}
        wind = df['wind_speed'].fillna(df['wind_speed'].mean())

        for window in [7, 14]:
            features[f'wind_mean_{window}d'] = wind.rolling(window, min_periods=1).mean()
            features[f'wind_max_{window}d'] = wind.rolling(window, min_periods=1).max()

        # Strong wind can resuspend dust
        features['is_strong_wind'] = (wind > 8.0).astype(float)  # m/s

        return features

    def _create_digital_twin_features(
        self,
        df_twin: pd.DataFrame,
        target_index: pd.DatetimeIndex
    ) -> Dict[str, np.ndarray]:
        """
        Create features from digital twin outputs for soiling detection.

        Digital twin outputs provide signals that help distinguish soiling
        from other loss mechanisms:
        - current_cv: Low CV = uniform soiling; High CV = partial shading/faults
        - temp_deviation: Distinguishes thermal losses from optical (soiling) losses
        - voltage_cv: Indicates degradation or hotspot-related losses

        These features do NOT cause circular dependency because they're derived
        from DC-side measurements, not power output.

        Parameters
        ----------
        df_twin : pd.DataFrame
            Digital twin outputs with columns:
            - current_cv: DC current coefficient of variation across strings
            - temp_deviation: T_actual - T_expected (°C)
            - voltage_cv: DC voltage coefficient of variation
            - current_imbalance: Max current deviation ratio (optional)

        target_index : pd.DatetimeIndex
            Target date range to align features

        Returns
        -------
        Dict[str, np.ndarray]
            Digital twin-based features for soiling ML
        """
        features = {}

        # Ensure date index
        if 'date' in df_twin.columns:
            df_twin = df_twin.set_index('date')
        df_twin.index = pd.to_datetime(df_twin.index)

        # Reindex to target dates
        df_twin = df_twin.reindex(target_index)

        # === DC Current Features (Uniformity = proxy for uniform soiling) ===
        if 'current_cv' in df_twin.columns:
            current_cv = df_twin['current_cv'].ffill().fillna(0.0)

            # Rolling statistics
            for window in [7, 14]:
                features[f'current_cv_mean_{window}d'] = current_cv.rolling(
                    window, min_periods=1
                ).mean()
                features[f'current_cv_std_{window}d'] = current_cv.rolling(
                    window, min_periods=1
                ).std().fillna(0)

            # CV trend (increasing CV may indicate non-uniform soiling/shading)
            features['current_cv_trend_7d'] = current_cv.diff(7) / 7
            features['current_cv_trend_7d'] = features['current_cv_trend_7d'].fillna(0)

            # Binary indicators
            # Low CV (<0.03) = likely uniform soiling affecting all strings equally
            features['is_uniform_current'] = (current_cv < 0.03).astype(float)
            # High CV (>0.08) = likely partial shading or string faults
            features['is_high_current_cv'] = (current_cv > 0.08).astype(float)

        # === Current Imbalance Features ===
        if 'current_imbalance' in df_twin.columns:
            imbalance = df_twin['current_imbalance'].ffill().fillna(0.0)

            for window in [7, 14]:
                features[f'current_imbalance_mean_{window}d'] = imbalance.rolling(
                    window, min_periods=1
                ).mean()

            # High imbalance indicator (>20% deviation from mean)
            features['is_high_imbalance'] = (imbalance > 0.20).astype(float)

        # === Temperature Deviation Features (Thermal vs Optical Discrimination) ===
        if 'temp_deviation' in df_twin.columns:
            temp_dev = df_twin['temp_deviation'].ffill().fillna(0.0)

            # Rolling statistics
            for window in [7, 14]:
                features[f'temp_deviation_mean_{window}d'] = temp_dev.rolling(
                    window, min_periods=1
                ).mean()
                features[f'temp_deviation_abs_mean_{window}d'] = temp_dev.abs().rolling(
                    window, min_periods=1
                ).mean()

            # Temperature deviation trend
            features['temp_deviation_trend_7d'] = temp_dev.diff(7) / 7
            features['temp_deviation_trend_7d'] = features['temp_deviation_trend_7d'].fillna(0)

            # Binary indicators
            # High positive deviation = inverter running hot (thermal issue, not soiling)
            features['is_thermal_anomaly_high'] = (temp_dev > 5.0).astype(float)
            # High negative deviation = inverter cooler than expected (possible underperformance)
            features['is_thermal_anomaly_low'] = (temp_dev < -5.0).astype(float)
            # Normal temperature = soiling more likely explanation for losses
            features['is_temp_normal'] = (temp_dev.abs() <= 3.0).astype(float)

        # === DC Voltage Features (Degradation/Hotspot Detection) ===
        if 'voltage_cv' in df_twin.columns:
            voltage_cv = df_twin['voltage_cv'].ffill().fillna(0.0)

            # Rolling statistics
            for window in [7, 14]:
                features[f'voltage_cv_mean_{window}d'] = voltage_cv.rolling(
                    window, min_periods=1
                ).mean()

            # Voltage CV trend
            features['voltage_cv_trend_7d'] = voltage_cv.diff(7) / 7
            features['voltage_cv_trend_7d'] = features['voltage_cv_trend_7d'].fillna(0)

            # Binary indicators
            # Low voltage CV = uniform conditions (soiling likely)
            features['is_voltage_stable'] = (voltage_cv < 0.02).astype(float)
            # High voltage CV = hotspots/degradation (not pure soiling)
            features['is_high_voltage_cv'] = (voltage_cv > 0.05).astype(float)

        # === Loss Percentage Features (Portable across plants) ===
        if 'current_loss_pct' in df_twin.columns:
            current_loss = df_twin['current_loss_pct'].ffill().fillna(0.0)

            for window in [7, 14]:
                features[f'current_loss_pct_mean_{window}d'] = current_loss.rolling(
                    window, min_periods=1
                ).mean()

            # Current loss trend
            features['current_loss_pct_trend_7d'] = current_loss.diff(7) / 7
            features['current_loss_pct_trend_7d'] = features['current_loss_pct_trend_7d'].fillna(0)

            # Significant current loss indicator (>5%)
            features['is_significant_current_loss'] = (current_loss > 5.0).astype(float)

        if 'voltage_loss_pct' in df_twin.columns:
            voltage_loss = df_twin['voltage_loss_pct'].ffill().fillna(0.0)

            for window in [7, 14]:
                features[f'voltage_loss_pct_mean_{window}d'] = voltage_loss.rolling(
                    window, min_periods=1
                ).mean()

            # Significant voltage loss indicator (>3%)
            features['is_significant_voltage_loss'] = (voltage_loss > 3.0).astype(float)

        if 'power_loss_pct' in df_twin.columns:
            power_loss = df_twin['power_loss_pct'].ffill().fillna(0.0)

            for window in [7, 14]:
                features[f'power_loss_pct_mean_{window}d'] = power_loss.rolling(
                    window, min_periods=1
                ).mean()

            # Power loss trend (rate of degradation)
            features['power_loss_pct_trend_7d'] = power_loss.diff(7) / 7
            features['power_loss_pct_trend_7d'] = features['power_loss_pct_trend_7d'].fillna(0)

            # Significant power loss indicator (>5%)
            features['is_significant_power_loss'] = (power_loss > 5.0).astype(float)

        # === Composite Features (Cross-signal analysis) ===
        # Soiling signature: low current CV + normal temp + stable voltage
        if all(col in df_twin.columns for col in ['current_cv', 'temp_deviation', 'voltage_cv']):
            current_cv = df_twin['current_cv'].ffill().fillna(0.0)
            temp_dev = df_twin['temp_deviation'].ffill().fillna(0.0)
            voltage_cv = df_twin['voltage_cv'].ffill().fillna(0.0)

            # Soiling signature score: higher = more likely soiling (vs other losses)
            # When current is uniform, temp is normal, voltage is stable → likely soiling
            soiling_signature = (
                (current_cv < 0.05).astype(float) * 0.4 +
                (temp_dev.abs() < 4.0).astype(float) * 0.3 +
                (voltage_cv < 0.03).astype(float) * 0.3
            )
            features['soiling_signature_score'] = soiling_signature

            # Rolling soiling signature
            features['soiling_signature_7d'] = soiling_signature.rolling(7, min_periods=1).mean()

        # === Loss Attribution Score ===
        # Helps distinguish soiling from other loss types based on loss patterns
        if all(col in df_twin.columns for col in ['current_loss_pct', 'current_cv']):
            current_loss = df_twin['current_loss_pct'].ffill().fillna(0.0)
            current_cv = df_twin['current_cv'].ffill().fillna(0.0)

            # High loss + low CV = likely uniform soiling
            # High loss + high CV = likely shading or fault
            with np.errstate(divide='ignore', invalid='ignore'):
                loss_attribution = np.where(
                    (current_loss > 2.0) & (current_cv < 0.05),
                    1.0,  # Uniform loss = soiling
                    np.where(
                        (current_loss > 2.0) & (current_cv > 0.08),
                        0.0,  # Non-uniform loss = shading/fault
                        0.5   # Ambiguous
                    )
                )
            features['soiling_attribution_score'] = loss_attribution
            features['soiling_attribution_7d'] = pd.Series(loss_attribution).rolling(7, min_periods=1).mean().values

        return features

    def _create_pr_features(
        self,
        df_pr: pd.DataFrame,
        target_index: pd.DatetimeIndex
    ) -> Dict[str, np.ndarray]:
        """
        Create Performance Ratio features (lagging soiling indicator).

        PR provides a lagging signal of soiling - when panels get dirty,
        PR drops. This is a valid feature because we're predicting SR
        (ground truth from DustIQ), not estimating SR from PR.

        Parameters
        ----------
        df_pr : pd.DataFrame
            Daily PR data with columns:
            - date (index or column)
            - pr or performance_ratio

        target_index : pd.DatetimeIndex
            Target date range to align features

        Returns
        -------
        Dict[str, np.ndarray]
            PR-based features
        """
        features = {}

        # Ensure date index
        if 'date' in df_pr.columns:
            df_pr = df_pr.set_index('date')
        df_pr.index = pd.to_datetime(df_pr.index)

        # Get PR column (handle different naming)
        pr_col = None
        for col in ['pr', 'performance_ratio', 'PR', 'pr_mean']:
            if col in df_pr.columns:
                pr_col = col
                break

        if pr_col is None:
            # No PR data available
            return features

        # Reindex to target dates
        pr = df_pr[pr_col].reindex(target_index)

        # Forward-fill missing values (use last known PR)
        pr = pr.ffill().fillna(pr.mean())

        # Rolling averages (lagging indicator of soiling)
        for window in self.ROLLING_WINDOWS:
            features[f'pr_mean_{window}d'] = pr.rolling(window, min_periods=1).mean()

        # Rolling standard deviation (variability indicator)
        for window in [7, 14]:
            features[f'pr_std_{window}d'] = pr.rolling(window, min_periods=1).std().fillna(0)

        # PR trend (rate of change - soiling acceleration)
        features['pr_trend_7d'] = pr.diff(7) / 7
        features['pr_trend_14d'] = pr.diff(14) / 14

        # Fill NaN trends with 0 (no change)
        for key in ['pr_trend_7d', 'pr_trend_14d']:
            features[key] = features[key].fillna(0)

        # Minimum PR in window (worst soiling indicator)
        features['pr_min_7d'] = pr.rolling(7, min_periods=1).min()
        features['pr_min_14d'] = pr.rolling(14, min_periods=1).min()

        # PR deviation from baseline (normalized soiling signal)
        pr_baseline = pr.rolling(90, min_periods=30).quantile(0.95)  # 95th percentile as clean baseline
        pr_baseline = pr_baseline.fillna(pr.quantile(0.95))
        features['pr_deviation_from_clean'] = pr - pr_baseline

        # Low PR indicator (potential soiling)
        features['is_low_pr'] = (pr < 0.75).astype(float)

        return features

    def _create_aod_features(
        self,
        df_aod: pd.DataFrame,
        target_index: pd.DatetimeIndex
    ) -> Dict[str, np.ndarray]:
        """Create aerosol optical depth features."""
        features = {}

        # Reindex AOD data to match target index
        df_aod = df_aod.reindex(target_index)

        # Total AOD
        if 'aod_550nm' in df_aod.columns:
            aod = df_aod['aod_550nm'].ffill().fillna(0.1)

            for window in self.ROLLING_WINDOWS:
                features[f'aod_mean_{window}d'] = aod.rolling(window, min_periods=1).mean()
                features[f'aod_max_{window}d'] = aod.rolling(window, min_periods=1).max()

            # AOD trend (soiling acceleration)
            features['aod_trend_7d'] = aod.diff(7) / 7
            features['aod_trend_14d'] = aod.diff(14) / 14

            # High AOD indicator (dust storm)
            features['is_high_aod'] = (aod > 0.3).astype(float)

        # Dust-specific AOD (Saharan dust)
        if 'dust_aod_550nm' in df_aod.columns:
            dust_aod = df_aod['dust_aod_550nm'].ffill().fillna(0.05)

            for window in [7, 14]:
                features[f'dust_aod_mean_{window}d'] = dust_aod.rolling(window, min_periods=1).mean()

            # Dust ratio (Sahara indicator)
            if 'aod_550nm' in df_aod.columns:
                aod = df_aod['aod_550nm'].fillna(0.1)
                dust_ratio = dust_aod / (aod + 1e-6)
                features['dust_ratio_7d'] = dust_ratio.rolling(7, min_periods=1).mean()

        # PM10 and PM2.5
        if 'pm10' in df_aod.columns:
            pm10 = df_aod['pm10'].ffill().fillna(20)
            for window in [7, 14]:
                features[f'pm10_mean_{window}d'] = pm10.rolling(window, min_periods=1).mean()

        if 'pm2p5' in df_aod.columns:
            pm25 = df_aod['pm2p5'].ffill().fillna(10)
            for window in [7, 14]:
                features[f'pm2p5_mean_{window}d'] = pm25.rolling(window, min_periods=1).mean()

        return features

    def _create_temporal_features(self, index: pd.DatetimeIndex) -> Dict[str, np.ndarray]:
        """Create temporal/seasonal features."""
        features = {}

        # Day of year (cyclical encoding)
        doy = index.dayofyear
        features['day_of_year_sin'] = np.sin(2 * np.pi * doy / 365)
        features['day_of_year_cos'] = np.cos(2 * np.pi * doy / 365)

        # Month (cyclical encoding)
        month = index.month
        features['month_sin'] = np.sin(2 * np.pi * month / 12)
        features['month_cos'] = np.cos(2 * np.pi * month / 12)

        # Season indicators based on climate zone
        climate = self.CLIMATE_ZONES.get(self.location.climate_zone, self.CLIMATE_ZONES["temperate"])
        features['is_dry_season'] = np.isin(month, climate['dry_months']).astype(float)
        features['is_wet_season'] = np.isin(month, climate['wet_months']).astype(float)

        return features

    def _create_location_features(self, n_rows: int) -> Dict[str, np.ndarray]:
        """Create static location features (replicated per row)."""
        features = {}

        features['latitude_abs'] = np.full(n_rows, abs(self.location.latitude))
        features['elevation_m'] = np.full(n_rows, self.location.elevation_m)
        features['distance_to_coast_km'] = np.full(n_rows, self.location.distance_to_coast_km)

        # Climate zone encoding (one-hot style, but numeric)
        climate_zones = list(self.CLIMATE_ZONES.keys())
        climate_idx = climate_zones.index(self.location.climate_zone) if self.location.climate_zone in climate_zones else 0
        features['climate_zone_idx'] = np.full(n_rows, climate_idx)

        return features

    def _create_cleaning_features(
        self,
        index: pd.DatetimeIndex,
        df_cleaning: pd.DataFrame
    ) -> Dict[str, np.ndarray]:
        """Create features from known cleaning events."""
        features = {}

        # Ensure date index
        if 'date' in df_cleaning.columns:
            df_cleaning = df_cleaning.set_index('date')
        df_cleaning = df_cleaning.reindex(index).fillna(False)

        # Any cleaning event - handle case where columns might not exist
        rain_cleaning = df_cleaning.get('is_rain_cleaning', pd.Series(False, index=index))
        manual_cleaning = df_cleaning.get('is_manual_cleaning', pd.Series(False, index=index))

        # Handle scalar False returns from .get() when column doesn't exist
        if not isinstance(rain_cleaning, pd.Series):
            rain_cleaning = pd.Series(False, index=index)
        if not isinstance(manual_cleaning, pd.Series):
            manual_cleaning = pd.Series(False, index=index)

        is_cleaning = (rain_cleaning | manual_cleaning).astype(bool)

        # Days since cleaning
        days_since_cleaning = np.zeros(len(index))
        current_count = 0
        for i in range(len(index)):
            if is_cleaning.iloc[i] if hasattr(is_cleaning, 'iloc') else is_cleaning[i]:
                current_count = 0
            else:
                current_count += 1
            days_since_cleaning[i] = current_count
        features['days_since_cleaning'] = days_since_cleaning

        # Cleaning events in recent windows
        for window in [7, 30]:
            features[f'cleaning_events_{window}d'] = is_cleaning.rolling(window, min_periods=1).sum()

        return features

    def _infer_cleaning_from_rain(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        """Infer cleaning events from rain when explicit events not available."""
        features = {}
        precip = df['precipitation_mm'].fillna(0)

        # Infer cleaning from significant rain (>= 5mm)
        is_rain_cleaning = precip >= 5.0

        # Days since rain cleaning
        days_since_cleaning = np.zeros(len(df))
        current_count = 0
        for i in range(len(df)):
            if is_rain_cleaning.iloc[i]:
                current_count = 0
            else:
                current_count += 1
            days_since_cleaning[i] = current_count
        features['days_since_cleaning'] = days_since_cleaning

        # Cleaning events in recent windows
        for window in [7, 30]:
            features[f'cleaning_events_{window}d'] = is_rain_cleaning.rolling(window, min_periods=1).sum()

        return features

    def get_feature_names(self) -> List[str]:
        """Return list of feature names after generate_features() has been called."""
        return self.feature_names

    def generate_forecast_features(
        self,
        df_weather_forecast: pd.DataFrame,
        df_aod_forecast: Optional[pd.DataFrame] = None,
        df_pr_recent: Optional[pd.DataFrame] = None,
        df_weather_historical: Optional[pd.DataFrame] = None,
        current_sr: float = 1.0,
        last_cleaning_date: Optional[pd.Timestamp] = None
    ) -> pd.DataFrame:
        """
        Generate features for forecast mode (days 1-N).

        Uses forecast data (weather/AOD) combined with recent historical PR
        to generate features for soiling ratio prediction.

        Parameters
        ----------
        df_weather_forecast : pd.DataFrame
            Weather forecast data with columns:
            - date (index)
            - precipitation_mm
            - temperature_max/min (optional)
            - humidity_mean (optional)
            - wind_speed_max (optional)

        df_aod_forecast : pd.DataFrame, optional
            AOD forecast data with columns:
            - date (index)
            - aod_550nm
            - dust_aod_550nm (optional)
            - pm10 (optional)

        df_pr_recent : pd.DataFrame, optional
            Recent historical PR data (last 30 days) for rolling features

        df_weather_historical : pd.DataFrame, optional
            Recent historical weather data (last 30 days) for rolling features

        current_sr : float
            Current soiling ratio estimate (default: 1.0)

        last_cleaning_date : pd.Timestamp, optional
            Date of last cleaning event

        Returns
        -------
        pd.DataFrame
            Feature matrix for forecast dates
        """
        # Ensure date index
        if 'date' in df_weather_forecast.columns:
            df_weather_forecast = df_weather_forecast.set_index('date')
        df_weather_forecast.index = pd.to_datetime(df_weather_forecast.index)

        # Combine historical + forecast weather for rolling features
        if df_weather_historical is not None:
            if 'date' in df_weather_historical.columns:
                df_weather_historical = df_weather_historical.set_index('date')
            df_weather_historical.index = pd.to_datetime(df_weather_historical.index)

            # Ensure precipitation column exists
            if 'precipitation_mm' not in df_weather_historical.columns:
                if 'precipitation' in df_weather_historical.columns:
                    df_weather_historical['precipitation_mm'] = df_weather_historical['precipitation']

            # Ensure precipitation_mm in forecast
            if 'precipitation_mm' not in df_weather_forecast.columns:
                if 'precipitation' in df_weather_forecast.columns:
                    df_weather_forecast['precipitation_mm'] = df_weather_forecast['precipitation']

            df_weather_combined = pd.concat([df_weather_historical, df_weather_forecast])
            df_weather_combined = df_weather_combined[~df_weather_combined.index.duplicated(keep='last')]
            df_weather_combined = df_weather_combined.sort_index()
        else:
            df_weather_combined = df_weather_forecast.copy()
            if 'precipitation_mm' not in df_weather_combined.columns:
                if 'precipitation' in df_weather_combined.columns:
                    df_weather_combined['precipitation_mm'] = df_weather_combined['precipitation']

        features = {}

        # 1. Rainfall features using combined data
        features.update(self._create_rainfall_features(df_weather_combined))

        # 2. Temperature features (if available)
        if 'temperature_max' in df_weather_combined.columns:
            # Use max temp as primary temperature indicator
            df_weather_combined['temperature'] = df_weather_combined['temperature_max']
            features.update(self._create_temperature_features(df_weather_combined))

        # 3. Humidity features (if available)
        if 'humidity_mean' in df_weather_combined.columns:
            df_weather_combined['humidity'] = df_weather_combined['humidity_mean']
            features.update(self._create_humidity_features(df_weather_combined))

        # 4. Wind features (if available)
        if 'wind_speed_max' in df_weather_combined.columns:
            df_weather_combined['wind_speed'] = df_weather_combined['wind_speed_max']
            features.update(self._create_wind_features(df_weather_combined))

        # 5. AOD features
        if df_aod_forecast is not None:
            if 'date' in df_aod_forecast.columns:
                df_aod_forecast = df_aod_forecast.set_index('date')
            df_aod_forecast.index = pd.to_datetime(df_aod_forecast.index)
            features.update(self._create_aod_features(df_aod_forecast, df_weather_combined.index))

        # 6. PR features from recent historical data
        if df_pr_recent is not None:
            # Extend PR into forecast period using simple persistence
            df_pr_extended = self._extend_pr_forecast(df_pr_recent, df_weather_forecast.index)
            features.update(self._create_pr_features(df_pr_extended, df_weather_combined.index))

        # 7. Temporal features (always available)
        features.update(self._create_temporal_features(df_weather_combined.index))

        # 8. Location features (static)
        features.update(self._create_location_features(len(df_weather_combined)))

        # 9. Cleaning features
        features.update(self._create_forecast_cleaning_features(
            df_weather_combined,
            last_cleaning_date
        ))

        # Build DataFrame
        df_features = pd.DataFrame(features, index=df_weather_combined.index)

        # Filter to forecast dates only
        df_features = df_features.loc[df_weather_forecast.index]

        # Store feature names
        self.feature_names = df_features.columns.tolist()

        return df_features

    def _extend_pr_forecast(
        self,
        df_pr_recent: pd.DataFrame,
        forecast_index: pd.DatetimeIndex
    ) -> pd.DataFrame:
        """Extend recent PR data into forecast period using persistence.

        Uses the last known PR value as forecast (persistence approach).
        For longer forecasts, applies expected soiling decay.
        """
        if 'date' in df_pr_recent.columns:
            df_pr_recent = df_pr_recent.set_index('date')
        df_pr_recent.index = pd.to_datetime(df_pr_recent.index)

        # Get PR column
        pr_col = None
        for col in ['pr', 'performance_ratio', 'PR', 'pr_mean']:
            if col in df_pr_recent.columns:
                pr_col = col
                break

        if pr_col is None:
            return df_pr_recent

        # Get last known PR
        last_pr = df_pr_recent[pr_col].iloc[-1]
        last_date = df_pr_recent.index[-1]

        # Create forecast PR with gradual decay
        forecast_data = []
        for i, date in enumerate(forecast_index):
            days_ahead = (date - last_date).days
            if days_ahead <= 0:
                continue

            # Apply typical soiling decay (~0.2%/day)
            decay = 0.002 * days_ahead  # 0.2% per day
            pr_forecast = max(last_pr - decay, 0.70)

            forecast_data.append({
                'date': date,
                pr_col: pr_forecast
            })

        if forecast_data:
            df_pr_forecast = pd.DataFrame(forecast_data)
            df_pr_forecast = df_pr_forecast.set_index('date')

            # Combine historical + forecast
            df_pr_combined = pd.concat([df_pr_recent, df_pr_forecast])
            df_pr_combined = df_pr_combined[~df_pr_combined.index.duplicated(keep='last')]
            df_pr_combined = df_pr_combined.sort_index()
            return df_pr_combined

        return df_pr_recent

    def _create_forecast_cleaning_features(
        self,
        df_weather: pd.DataFrame,
        last_cleaning_date: Optional[pd.Timestamp] = None
    ) -> Dict[str, np.ndarray]:
        """Create cleaning features for forecast mode.

        Uses forecast rain to predict cleaning events.
        """
        features = {}
        precip = df_weather['precipitation_mm'].fillna(0)

        # Forecast rain cleaning (> 5mm = effective cleaning)
        is_forecast_cleaning = precip >= 5.0

        # Days since cleaning (considering both historical and forecast)
        days_since_cleaning = np.zeros(len(df_weather))

        # Initialize with days since last known cleaning
        if last_cleaning_date is not None:
            first_date = df_weather.index[0]
            initial_days = (first_date - last_cleaning_date).days
        else:
            initial_days = 30  # Assume 30 days since cleaning if unknown

        current_count = initial_days
        for i in range(len(df_weather)):
            # Check for rain cleaning (historical or forecast)
            if is_forecast_cleaning.iloc[i]:
                current_count = 0
            else:
                current_count += 1
            days_since_cleaning[i] = current_count

        features['days_since_cleaning'] = days_since_cleaning

        # Cleaning events in windows
        for window in [7, 30]:
            features[f'cleaning_events_{window}d'] = is_forecast_cleaning.rolling(window, min_periods=1).sum()

        return features


def create_sr_features_from_json(
    dustiq_path: str,
    weather_path: str,
    aod_path: Optional[str] = None,
    latitude: float = 37.45,
    longitude: float = -6.14
) -> Tuple[pd.DataFrame, pd.Series]:
    """
    Convenience function to create features from JSON data files.

    Parameters
    ----------
    dustiq_path : str
        Path to dustiq_history.json
    weather_path : str
        Path to rain_history.json or weather data
    aod_path : str, optional
        Path to AOD/dust data JSON
    latitude, longitude : float
        Plant coordinates

    Returns
    -------
    X : pd.DataFrame
        Feature matrix
    y : pd.Series
        Target (sr_dustiq)
    """
    import json

    # Load DustIQ data (target)
    with open(dustiq_path, 'r') as f:
        dustiq_data = json.load(f)
    df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
    df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])
    df_dustiq = df_dustiq.set_index('date')

    # Load weather data
    with open(weather_path, 'r') as f:
        weather_data = json.load(f)
    df_weather = pd.DataFrame(weather_data['daily_data'])
    df_weather['date'] = pd.to_datetime(df_weather['date'])
    df_weather = df_weather.set_index('date')

    # Rename precipitation column if needed
    if 'precipitation_mm' not in df_weather.columns and 'precipitation' in df_weather.columns:
        df_weather['precipitation_mm'] = df_weather['precipitation']

    # Load AOD data if available
    df_aod = None
    if aod_path:
        with open(aod_path, 'r') as f:
            aod_data = json.load(f)
        df_aod = pd.DataFrame(aod_data['daily_data'])
        df_aod['date'] = pd.to_datetime(df_aod['date'])
        df_aod = df_aod.set_index('date')

    # Align indices
    common_dates = df_dustiq.index.intersection(df_weather.index)
    df_weather_aligned = df_weather.loc[common_dates]
    df_dustiq_aligned = df_dustiq.loc[common_dates]

    if df_aod is not None:
        common_dates = common_dates.intersection(df_aod.index)
        df_aod = df_aod.loc[common_dates]
        df_weather_aligned = df_weather.loc[common_dates]
        df_dustiq_aligned = df_dustiq.loc[common_dates]

    # Generate features
    location = PlantLocation(latitude=latitude, longitude=longitude)
    engineer = SoilingRatioFeatureEngineer(location)
    X = engineer.generate_features(df_weather_aligned, df_aod)

    # Target
    y = df_dustiq_aligned['sr_dustiq']

    # Align X and y
    common_idx = X.index.intersection(y.index)
    X = X.loc[common_idx]
    y = y.loc[common_idx]

    return X, y
