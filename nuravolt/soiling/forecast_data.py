"""Weather and AOD forecast data fetching for soiling predictions.

This module provides real-time forecast data from:
1. Open-Meteo: 7-day weather forecast (precipitation, temperature, humidity, wind)
2. CAMS ADS: 5-day AOD forecast (total AOD, dust AOD)
3. Seasonal climatology: Extended forecasts using historical patterns

Forecast accuracy (based on CAMS validation studies):
- Days 1-3: High reliability (r > 0.80)
- Days 4-7: Moderate reliability (r ~ 0.65-0.80)
- Days 8+: Use climatology/seasonal patterns
"""

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests


def _get_cache_dir() -> Path:
    """Get or create cache directory for forecast data."""
    cache_dir = Path.home() / '.nuravolt' / 'cache' / 'forecast'
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _get_cache_key(prefix: str, **kwargs) -> str:
    """Generate cache key from parameters."""
    key_str = f"{prefix}_" + "_".join(f"{k}={v}" for k, v in sorted(kwargs.items()))
    return hashlib.md5(key_str.encode()).hexdigest()


@dataclass
class ForecastConfig:
    """Configuration for forecast data fetching."""
    latitude: float
    longitude: float
    timezone: str = "Europe/Madrid"

    # Cache settings
    use_cache: bool = True
    cache_ttl_hours: int = 6  # Refresh forecasts every 6 hours

    # Open-Meteo settings
    openmeteo_days: int = 7

    # CAMS settings (via Open-Meteo CAMS API - no key required)
    cams_days: int = 5


class ForecastDataFetcher:
    """Fetch weather and AOD forecast data for soiling predictions.

    Uses Open-Meteo for weather and CAMS air quality forecasts.
    Both APIs are free and require no API key.

    Example
    -------
    >>> fetcher = ForecastDataFetcher(latitude=37.5, longitude=-6)
    >>> df_weather = fetcher.fetch_weather_forecast()
    >>> df_aod = fetcher.fetch_aod_forecast()
    >>> df_climate = fetcher.get_seasonal_climate(days=365)
    """

    # Monthly AOD climatology for Spain/Mediterranean (based on CAMS 2020-2024 data)
    # Values represent typical total AOD at 550nm
    MONTHLY_AOD_CLIMATOLOGY = {
        1: {"aod_mean": 0.10, "aod_std": 0.05, "dust_fraction": 0.15},   # Jan: Low, wet
        2: {"aod_mean": 0.11, "aod_std": 0.06, "dust_fraction": 0.18},   # Feb: Low
        3: {"aod_mean": 0.14, "aod_std": 0.08, "dust_fraction": 0.25},   # Mar: Sahara dust begins
        4: {"aod_mean": 0.18, "aod_std": 0.10, "dust_fraction": 0.35},   # Apr: Dust events
        5: {"aod_mean": 0.22, "aod_std": 0.12, "dust_fraction": 0.40},   # May: Peak dust
        6: {"aod_mean": 0.25, "aod_std": 0.14, "dust_fraction": 0.45},   # Jun: Peak dust
        7: {"aod_mean": 0.28, "aod_std": 0.15, "dust_fraction": 0.50},   # Jul: Peak dust + dry
        8: {"aod_mean": 0.26, "aod_std": 0.14, "dust_fraction": 0.48},   # Aug: High dust
        9: {"aod_mean": 0.20, "aod_std": 0.11, "dust_fraction": 0.38},   # Sep: Dust declining
        10: {"aod_mean": 0.15, "aod_std": 0.08, "dust_fraction": 0.28},  # Oct: Moderate
        11: {"aod_mean": 0.11, "aod_std": 0.06, "dust_fraction": 0.18},  # Nov: Low
        12: {"aod_mean": 0.09, "aod_std": 0.04, "dust_fraction": 0.12},  # Dec: Low, wet
    }

    # Monthly rainfall probability (based on ALPHA1 historical data)
    MONTHLY_RAIN_PROBABILITY = {
        1: {"rain_days": 8, "avg_daily_mm": 2.5, "heavy_rain_prob": 0.10},
        2: {"rain_days": 7, "avg_daily_mm": 2.2, "heavy_rain_prob": 0.08},
        3: {"rain_days": 6, "avg_daily_mm": 2.0, "heavy_rain_prob": 0.08},
        4: {"rain_days": 7, "avg_daily_mm": 2.3, "heavy_rain_prob": 0.10},
        5: {"rain_days": 5, "avg_daily_mm": 1.5, "heavy_rain_prob": 0.06},
        6: {"rain_days": 2, "avg_daily_mm": 0.4, "heavy_rain_prob": 0.02},
        7: {"rain_days": 1, "avg_daily_mm": 0.1, "heavy_rain_prob": 0.01},
        8: {"rain_days": 1, "avg_daily_mm": 0.2, "heavy_rain_prob": 0.01},
        9: {"rain_days": 3, "avg_daily_mm": 1.0, "heavy_rain_prob": 0.04},
        10: {"rain_days": 7, "avg_daily_mm": 2.5, "heavy_rain_prob": 0.12},
        11: {"rain_days": 8, "avg_daily_mm": 3.0, "heavy_rain_prob": 0.15},
        12: {"rain_days": 9, "avg_daily_mm": 3.2, "heavy_rain_prob": 0.12},
    }

    # Monthly soiling rates (%/day) based on ALPHA1 analysis
    # Higher in dry months (May-Sep), lower in wet months (Oct-Apr)
    MONTHLY_SOILING_RATES = {
        1: {"rate_pct_day": 0.10, "rate_std": 0.05},   # Wet season
        2: {"rate_pct_day": 0.12, "rate_std": 0.05},
        3: {"rate_pct_day": 0.18, "rate_std": 0.07},   # Transition
        4: {"rate_pct_day": 0.22, "rate_std": 0.08},
        5: {"rate_pct_day": 0.30, "rate_std": 0.10},   # Dry season begins
        6: {"rate_pct_day": 0.38, "rate_std": 0.12},   # Peak soiling
        7: {"rate_pct_day": 0.42, "rate_std": 0.14},   # Peak soiling
        8: {"rate_pct_day": 0.40, "rate_std": 0.13},
        9: {"rate_pct_day": 0.28, "rate_std": 0.10},   # Transition
        10: {"rate_pct_day": 0.15, "rate_std": 0.06},  # Wet season
        11: {"rate_pct_day": 0.10, "rate_std": 0.05},
        12: {"rate_pct_day": 0.08, "rate_std": 0.04},
    }

    def __init__(
        self,
        latitude: float,
        longitude: float,
        timezone: str = "Europe/Madrid",
        use_cache: bool = True,
        cache_ttl_hours: int = 6
    ):
        """Initialize forecast data fetcher.

        Parameters
        ----------
        latitude : float
            Plant latitude
        longitude : float
            Plant longitude
        timezone : str
            Timezone string (default: Europe/Madrid)
        use_cache : bool
            Whether to cache forecast data (default: True)
        cache_ttl_hours : int
            Cache time-to-live in hours (default: 6)
        """
        self.latitude = latitude
        self.longitude = longitude
        self.timezone = timezone
        self.use_cache = use_cache
        self.cache_ttl_hours = cache_ttl_hours

    def fetch_weather_forecast(self, days: int = 7) -> pd.DataFrame:
        """Fetch Open-Meteo weather forecast.

        Parameters
        ----------
        days : int
            Number of forecast days (1-16, default: 7)

        Returns
        -------
        pd.DataFrame
            Daily weather forecast with columns:
            - date: Forecast date
            - precipitation_mm: Expected precipitation (mm)
            - precipitation_probability: Probability of precipitation (0-100)
            - temperature_max: Maximum temperature (°C)
            - temperature_min: Minimum temperature (°C)
            - humidity_mean: Mean relative humidity (%)
            - wind_speed_max: Maximum wind speed (m/s)
        """
        # Check cache
        if self.use_cache:
            cached = self._get_cached_forecast('weather', days)
            if cached is not None:
                return cached

        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "daily": [
                "precipitation_sum",
                "precipitation_probability_max",
                "temperature_2m_max",
                "temperature_2m_min",
                "relative_humidity_2m_mean",
                "wind_speed_10m_max",
            ],
            "timezone": self.timezone,
            "forecast_days": min(days, 16),  # Open-Meteo max is 16 days
        }

        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            df = pd.DataFrame({
                "date": pd.to_datetime(data["daily"]["time"]),
                "precipitation_mm": data["daily"]["precipitation_sum"],
                "precipitation_probability": data["daily"]["precipitation_probability_max"],
                "temperature_max": data["daily"]["temperature_2m_max"],
                "temperature_min": data["daily"]["temperature_2m_min"],
                "humidity_mean": data["daily"]["relative_humidity_2m_mean"],
                "wind_speed_max": data["daily"]["wind_speed_10m_max"],
            })

            df = df.set_index("date")

            # Cache the result
            if self.use_cache:
                self._cache_forecast(df, 'weather', days)

            return df

        except requests.RequestException as e:
            print(f"Warning: Weather forecast fetch failed: {e}")
            return self._generate_fallback_weather_forecast(days)

    def fetch_aod_forecast(self, days: int = 5) -> pd.DataFrame:
        """Fetch CAMS air quality forecast via Open-Meteo.

        Uses Open-Meteo's air quality API which proxies CAMS data.
        No API key required.

        Parameters
        ----------
        days : int
            Number of forecast days (1-5, default: 5)

        Returns
        -------
        pd.DataFrame
            Daily AOD forecast with columns:
            - date: Forecast date
            - aod_550nm: Total aerosol optical depth at 550nm
            - dust_aod_550nm: Dust AOD (estimated)
            - pm10: PM10 concentration (μg/m³)
            - pm2p5: PM2.5 concentration (μg/m³)
        """
        # Check cache
        if self.use_cache:
            cached = self._get_cached_forecast('aod', days)
            if cached is not None:
                return cached

        url = "https://air-quality-api.open-meteo.com/v1/air-quality"
        params = {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "hourly": [
                "pm10",
                "pm2_5",
                "aerosol_optical_depth",
                "dust",
            ],
            "timezone": self.timezone,
            "forecast_days": min(days, 5),
        }

        try:
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            # Convert hourly to daily
            df_hourly = pd.DataFrame({
                "timestamp": pd.to_datetime(data["hourly"]["time"]),
                "aod_550nm": data["hourly"]["aerosol_optical_depth"],
                "dust": data["hourly"].get("dust", [None] * len(data["hourly"]["time"])),
                "pm10": data["hourly"]["pm10"],
                "pm2p5": data["hourly"]["pm2_5"],
            })

            df_hourly["date"] = df_hourly["timestamp"].dt.date

            # Aggregate to daily (daytime average: 6am-6pm)
            df_hourly["hour"] = df_hourly["timestamp"].dt.hour
            df_daytime = df_hourly[(df_hourly["hour"] >= 6) & (df_hourly["hour"] <= 18)]

            df_daily = df_daytime.groupby("date").agg({
                "aod_550nm": "mean",
                "dust": "mean",
                "pm10": "mean",
                "pm2p5": "mean",
            }).reset_index()

            df_daily["date"] = pd.to_datetime(df_daily["date"])

            # Estimate dust AOD from dust concentration if available
            # Relationship: dust_aod ≈ dust_concentration / 1000 (rough approximation)
            if df_daily["dust"].notna().any():
                df_daily["dust_aod_550nm"] = df_daily["dust"] / 1000.0
            else:
                # Estimate dust fraction from monthly climatology
                month = datetime.now().month
                dust_fraction = self.MONTHLY_AOD_CLIMATOLOGY[month]["dust_fraction"]
                df_daily["dust_aod_550nm"] = df_daily["aod_550nm"] * dust_fraction

            df_daily = df_daily.drop(columns=["dust"], errors="ignore")
            df_daily = df_daily.set_index("date")

            # Cache the result
            if self.use_cache:
                self._cache_forecast(df_daily, 'aod', days)

            return df_daily

        except requests.RequestException as e:
            print(f"Warning: AOD forecast fetch failed: {e}")
            return self._generate_fallback_aod_forecast(days)

    def get_seasonal_climate(
        self,
        start_date: Optional[date] = None,
        days: int = 365
    ) -> pd.DataFrame:
        """Get seasonal climatology for extended forecasts.

        Uses monthly climatological data for forecasts beyond
        the reliable forecast horizon (>7 days for weather, >5 for AOD).

        Parameters
        ----------
        start_date : date, optional
            Start date for climatology (default: today)
        days : int
            Number of days (default: 365)

        Returns
        -------
        pd.DataFrame
            Daily climatology with columns:
            - date: Date
            - aod_climatology: Expected AOD
            - dust_aod_climatology: Expected dust AOD
            - rain_probability: Probability of cleaning rain (%)
            - soiling_rate_pct_day: Expected soiling rate (%/day)
            - seasonal_factor: Seasonal adjustment factor (1.0 = average)
        """
        if start_date is None:
            start_date = datetime.now().date()

        dates = [start_date + timedelta(days=i) for i in range(days)]

        data = []
        for d in dates:
            month = d.month
            aod_clim = self.MONTHLY_AOD_CLIMATOLOGY[month]
            rain_clim = self.MONTHLY_RAIN_PROBABILITY[month]
            soil_clim = self.MONTHLY_SOILING_RATES[month]

            # Daily rain probability from monthly rain days
            rain_prob = rain_clim["rain_days"] / 30.0  # Approximate monthly days

            # Seasonal factor (1.0 = annual average)
            avg_soiling_rate = np.mean([v["rate_pct_day"] for v in self.MONTHLY_SOILING_RATES.values()])
            seasonal_factor = soil_clim["rate_pct_day"] / avg_soiling_rate

            data.append({
                "date": d,
                "aod_climatology": aod_clim["aod_mean"],
                "aod_std": aod_clim["aod_std"],
                "dust_aod_climatology": aod_clim["aod_mean"] * aod_clim["dust_fraction"],
                "rain_probability": rain_prob * 100,
                "heavy_rain_prob": rain_clim["heavy_rain_prob"] * 100,
                "expected_rain_mm": rain_clim["avg_daily_mm"],
                "soiling_rate_pct_day": soil_clim["rate_pct_day"],
                "soiling_rate_std": soil_clim["rate_std"],
                "seasonal_factor": seasonal_factor,
            })

        df = pd.DataFrame(data)
        df = df.set_index("date")

        return df

    def fetch_combined_forecast(self, short_term_days: int = 7) -> pd.DataFrame:
        """Fetch combined weather + AOD forecast.

        Merges weather and AOD forecasts into a single DataFrame.

        Parameters
        ----------
        short_term_days : int
            Days of short-term forecast (default: 7)

        Returns
        -------
        pd.DataFrame
            Combined forecast with all weather and AOD columns
        """
        df_weather = self.fetch_weather_forecast(days=short_term_days)
        df_aod = self.fetch_aod_forecast(days=min(short_term_days, 5))

        # Merge on date
        df_combined = df_weather.join(df_aod, how="left")

        # Fill missing AOD days (6-7) with climatology
        for idx in df_combined.index:
            if pd.isna(df_combined.loc[idx, "aod_550nm"]):
                month = idx.month
                df_combined.loc[idx, "aod_550nm"] = self.MONTHLY_AOD_CLIMATOLOGY[month]["aod_mean"]
                df_combined.loc[idx, "dust_aod_550nm"] = (
                    self.MONTHLY_AOD_CLIMATOLOGY[month]["aod_mean"] *
                    self.MONTHLY_AOD_CLIMATOLOGY[month]["dust_fraction"]
                )
                df_combined.loc[idx, "pm10"] = 25.0  # Typical background
                df_combined.loc[idx, "pm2p5"] = 12.0

        return df_combined

    def _get_cached_forecast(self, forecast_type: str, days: int) -> Optional[pd.DataFrame]:
        """Get cached forecast if still valid."""
        cache_dir = _get_cache_dir()
        cache_key = _get_cache_key(
            forecast_type,
            lat=round(self.latitude, 2),
            lon=round(self.longitude, 2),
            days=days
        )
        cache_file = cache_dir / f"{cache_key}.json"

        if cache_file.exists():
            # Check cache age
            cache_age = datetime.now() - datetime.fromtimestamp(cache_file.stat().st_mtime)
            if cache_age < timedelta(hours=self.cache_ttl_hours):
                try:
                    with open(cache_file, 'r') as f:
                        data = json.load(f)
                    df = pd.DataFrame(data)
                    df['date'] = pd.to_datetime(df['date'])
                    df = df.set_index('date')
                    return df
                except Exception:
                    pass  # Cache corrupted, fetch fresh

        return None

    def _cache_forecast(self, df: pd.DataFrame, forecast_type: str, days: int):
        """Cache forecast data."""
        cache_dir = _get_cache_dir()
        cache_key = _get_cache_key(
            forecast_type,
            lat=round(self.latitude, 2),
            lon=round(self.longitude, 2),
            days=days
        )
        cache_file = cache_dir / f"{cache_key}.json"

        try:
            df_copy = df.reset_index()
            df_copy['date'] = df_copy['date'].dt.strftime('%Y-%m-%d')
            with open(cache_file, 'w') as f:
                json.dump(df_copy.to_dict(orient='records'), f)
        except Exception as e:
            print(f"Warning: Failed to cache forecast: {e}")

    def _generate_fallback_weather_forecast(self, days: int) -> pd.DataFrame:
        """Generate fallback weather forecast from climatology."""
        today = datetime.now().date()
        dates = [today + timedelta(days=i) for i in range(days)]

        data = []
        for d in dates:
            month = d.month
            rain_clim = self.MONTHLY_RAIN_PROBABILITY[month]

            # Probabilistic rain generation
            rain_prob = rain_clim["rain_days"] / 30.0
            has_rain = np.random.random() < rain_prob

            if has_rain:
                # Generate rain amount (exponential distribution)
                rain_mm = np.random.exponential(rain_clim["avg_daily_mm"] * 2)
                precip_prob = 80 + np.random.randint(0, 20)
            else:
                rain_mm = 0.0
                precip_prob = np.random.randint(0, 30)

            data.append({
                "date": d,
                "precipitation_mm": round(rain_mm, 1),
                "precipitation_probability": precip_prob,
                "temperature_max": 15 + month * 1.5 + np.random.normal(0, 3),
                "temperature_min": 5 + month * 1.2 + np.random.normal(0, 2),
                "humidity_mean": 60 - month * 2 + np.random.normal(0, 10),
                "wind_speed_max": 5 + np.random.exponential(3),
            })

        df = pd.DataFrame(data)
        df = df.set_index("date")
        return df

    def _generate_fallback_aod_forecast(self, days: int) -> pd.DataFrame:
        """Generate fallback AOD forecast from climatology."""
        today = datetime.now().date()
        dates = [today + timedelta(days=i) for i in range(days)]

        data = []
        for d in dates:
            month = d.month
            aod_clim = self.MONTHLY_AOD_CLIMATOLOGY[month]

            # Add random variation
            aod = np.clip(
                np.random.normal(aod_clim["aod_mean"], aod_clim["aod_std"] / 2),
                0.02, 0.8
            )

            data.append({
                "date": d,
                "aod_550nm": round(aod, 3),
                "dust_aod_550nm": round(aod * aod_clim["dust_fraction"], 3),
                "pm10": round(20 + aod * 100 + np.random.normal(0, 5), 1),
                "pm2p5": round(10 + aod * 50 + np.random.normal(0, 3), 1),
            })

        df = pd.DataFrame(data)
        df = df.set_index("date")
        return df


def fetch_forecast_for_plant(
    latitude: float,
    longitude: float,
    short_term_days: int = 7,
    extended_days: int = 30
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Convenience function to fetch all forecast data for a plant.

    Parameters
    ----------
    latitude, longitude : float
        Plant coordinates
    short_term_days : int
        Days of weather/AOD forecast (default: 7)
    extended_days : int
        Days of climatology-based forecast (default: 30)

    Returns
    -------
    df_short_term : pd.DataFrame
        Short-term forecast with actual weather/AOD predictions
    df_extended : pd.DataFrame
        Extended forecast with climatological patterns
    """
    fetcher = ForecastDataFetcher(latitude, longitude)

    # Short-term: Real forecasts
    df_short_term = fetcher.fetch_combined_forecast(short_term_days)

    # Extended: Climatology starting after short-term
    start_extended = datetime.now().date() + timedelta(days=short_term_days)
    df_extended = fetcher.get_seasonal_climate(
        start_date=start_extended,
        days=extended_days - short_term_days
    )

    return df_short_term, df_extended


def load_optimization_forecasts(plant_id: str, data_dir: Optional[Path] = None) -> Dict[str, pd.DataFrame]:
    """
    Load all forecast data for cleaning schedule optimization.

    Loads three forecast types from public data directory:
    1. ML forecast (365 days) - Primary soiling predictions
    2. AOD forecast (5 days) - Dust exposure risk
    3. Rain forecast (16 days) - Natural cleaning and deferral logic

    Parameters
    ----------
    plant_id : str
        Plant identifier (e.g., 'alpha1', 'eta', 'ribera')
    data_dir : Path, optional
        Base data directory. If None, uses 'public/data/soiling'

    Returns
    -------
    dict
        Dictionary with keys 'ml', 'aod', 'rain' containing DataFrames
        Each DataFrame is indexed by date for fast lookups

    Raises
    ------
    FileNotFoundError
        If ML forecast file not found (required)
    ValueError
        If ML forecast has invalid format

    Example
    -------
    >>> forecasts = load_optimization_forecasts('alpha1')
    >>> df_ml = forecasts['ml']
    >>> df_aod = forecasts.get('aod')  # May be None
    >>> df_rain = forecasts.get('rain')  # May be None
    """
    if data_dir is None:
        # Default to public/data/soiling directory
        data_dir = Path(__file__).parent.parent.parent / 'public' / 'data' / 'soiling' / plant_id
    else:
        data_dir = Path(data_dir) / plant_id

    forecasts = {}

    # 1. Load ML forecast (365 days) - REQUIRED
    ml_path = data_dir / 'ml_forecast_365d.json'
    if not ml_path.exists():
        raise FileNotFoundError(
            f'ML forecast not found: {ml_path}\n'
            f'Please generate ML forecast using scripts/generate_ml_cleaning_forecast.py'
        )

    with open(ml_path, 'r') as f:
        ml_data = json.load(f)

    # Handle different JSON structures
    if 'forecasts' in ml_data:
        ml_records = ml_data['forecasts']
    elif 'daily_forecasts' in ml_data:
        ml_records = ml_data['daily_forecasts']
    elif isinstance(ml_data, list):
        ml_records = ml_data
    else:
        raise ValueError(f'Invalid ML forecast JSON structure in {ml_path}')

    df_ml = pd.DataFrame(ml_records)
    df_ml['date'] = pd.to_datetime(df_ml['date'])
    df_ml = df_ml.set_index('date')
    forecasts['ml'] = df_ml

    # 2. Load AOD forecast (5 days) - OPTIONAL
    aod_path = data_dir / 'aod_forecast.json'
    if aod_path.exists():
        try:
            with open(aod_path, 'r') as f:
                aod_data = json.load(f)

            # Handle different JSON structures
            if 'daily_forecast' in aod_data:
                aod_records = aod_data['daily_forecast']
            elif isinstance(aod_data, list):
                aod_records = aod_data
            else:
                aod_records = []

            if aod_records:
                df_aod = pd.DataFrame(aod_records)
                df_aod['date'] = pd.to_datetime(df_aod['date'])
                df_aod = df_aod.set_index('date')
                forecasts['aod'] = df_aod
            else:
                print(f'Warning: Empty AOD forecast in {aod_path}')
                forecasts['aod'] = None
        except Exception as e:
            print(f'Warning: Failed to load AOD forecast from {aod_path}: {e}')
            forecasts['aod'] = None
    else:
        print(f'Info: AOD forecast not found at {aod_path} (optional)')
        forecasts['aod'] = None

    # 3. Load rain forecast (16 days) - OPTIONAL
    rain_path = data_dir / 'rain_forecast.json'
    if rain_path.exists():
        try:
            with open(rain_path, 'r') as f:
                rain_data = json.load(f)

            # Handle different JSON structures
            if 'daily_forecast' in rain_data:
                rain_records = rain_data['daily_forecast']
            elif isinstance(rain_data, list):
                rain_records = rain_data
            else:
                rain_records = []

            if rain_records:
                df_rain = pd.DataFrame(rain_records)
                df_rain['date'] = pd.to_datetime(df_rain['date'])
                df_rain = df_rain.set_index('date')
                forecasts['rain'] = df_rain
            else:
                print(f'Warning: Empty rain forecast in {rain_path}')
                forecasts['rain'] = None
        except Exception as e:
            print(f'Warning: Failed to load rain forecast from {rain_path}: {e}')
            forecasts['rain'] = None
    else:
        print(f'Info: Rain forecast not found at {rain_path} (optional)')
        forecasts['rain'] = None

    return forecasts
