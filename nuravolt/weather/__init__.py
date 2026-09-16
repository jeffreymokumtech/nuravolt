"""
Weather/irradiance fallback for plants without on-site sensors.

Resolution chain: on-site sensor column -> Open-Meteo archive (satellite/
reanalysis GHI/DNI/DHI + ambient temp + wind) -> pvlib clearsky last resort.

Entry points:
    ensure_irradiance(df, lat, lon, ...)      pandas DataFrame in/out
    fallback_columns_for_index(index, ...)    aligned columns for any index
    get_fallback_weather(lat, lon, ...)       standalone fetch (onboarding)
"""

from .fallback import (
    CONFIDENCE,
    FallbackWeather,
    default_array_geometry,
    ensure_irradiance,
    fallback_columns_for_index,
    fetch_open_meteo_weather,
    get_fallback_weather,
)

__all__ = [
    "CONFIDENCE",
    "FallbackWeather",
    "default_array_geometry",
    "ensure_irradiance",
    "fallback_columns_for_index",
    "fetch_open_meteo_weather",
    "get_fallback_weather",
]
