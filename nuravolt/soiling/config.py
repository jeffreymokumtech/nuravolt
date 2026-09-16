"""Configuration for solar PV soiling analysis."""

from dataclasses import dataclass, field
from typing import Dict, Any


# Alpha1 9MW solar plant (Andalusia, Spain)
# Source: Plant_meta.csv (Plant ID: 461)
SITE_CONFIG = {
    'name': 'Alpha1 (ES)',
    'plant_id': 461,
    'latitude': 38,      # Degrees north
    'longitude': -4,     # Degrees west
    'elevation': 450,         # Meters above sea level (estimated for Andalusia)
    'timezone': 'Europe/Madrid',
    'capacity_MW': 9.0,       # Nominal capacity
    'capacity_installed_MW': 11.797,  # Installed capacity
    'tilt': 20,               # Panel tilt angle
    'azimuth': 180,           # South-facing
    'orientation': 'Landscape',
    
    # Economic parameters (Spain)
    'cleaning_cost_per_MW': 600,           # €600/MW per cleaning
    'electricity_rate_per_MWh': 65,        # €65/MWh (Spanish PPA average)
    'avg_sun_hours_per_day': 6.5,          # Andalusia average
    
    # Soiling characteristics (Andalusia)
    'expected_soiling_rate_per_day': 0.25, # 0.25%/day (0.15-0.35% range)
    'rain_cleaning_threshold_mm': 10,      # Rain >10mm = 90-95% cleaning
    'rain_partial_threshold_mm': 2,        # Rain 2-10mm = 50-80% cleaning
    
    # Climate: Mediterranean semi-arid (Köppen: BSk/Csa)
    'climate_zone': 'Mediterranean semi-arid',
    'climate_koppen': 'BSk/Csa',
}

# Note: pvlib Location object is created in the pipeline
# to avoid import issues during package initialization


@dataclass
class SoilingConfig:
    """Configuration class for soiling analysis."""

    name: str
    plant_id: int
    latitude: float
    longitude: float
    elevation: float
    timezone: str
    capacity_MW: float
    capacity_installed_MW: float
    tilt: float
    azimuth: float
    orientation: str = "Landscape"

    # Economic parameters
    cleaning_cost_per_MW: float = 600.0
    electricity_rate_per_MWh: float = 65.0
    avg_sun_hours_per_day: float = 6.5

    # Soiling characteristics
    expected_soiling_rate_per_day: float = 0.25
    rain_cleaning_threshold_mm: float = 10.0

    # Cleaning schedule optimization parameters
    cleaning_threshold_sr: float = 0.97  # SR < 0.97 = 3% loss
    min_days_between: int = 14  # Minimum days between cleanings

    @classmethod
    def from_dict(cls, config_dict: Dict[str, Any]) -> 'SoilingConfig':
        """Create config from dictionary."""
        return cls(**{k: v for k, v in config_dict.items() if k in cls.__annotations__})

    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary."""
        return self.__dict__
