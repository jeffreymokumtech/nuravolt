"""
Physics-Only Feature Engineering for Digital Twin Models

Generates features from environmental conditions and solar geometry ONLY.
Explicitly excludes any power-derived features to prevent data leakage.

PROHIBITED Features (will cause data leakage):
- P(t-1), P(t-2), ... any lagged power
- Rolling mean/std of power
- Cumulative energy
- Any feature derived from measured power

ALLOWED Features:
- Irradiance (GHI, POA, DNI)
- Temperature (ambient, cell, module)
- Wind speed
- Solar geometry (zenith, azimuth, air mass)
- Clear sky index
- Temporal encodings
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
import logging
import math

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# Try importing pvlib for solar calculations
try:
    import pvlib
    from pvlib import solarposition, atmosphere, irradiance
    PVLIB_AVAILABLE = True
except ImportError:
    PVLIB_AVAILABLE = False
    logger.warning("pvlib not available, some solar features will be simplified")


@dataclass
class LocationParams:
    """Location parameters for solar calculations."""
    latitude: float = 0.0
    longitude: float = 0.0
    altitude: float = 0.0           # meters above sea level
    timezone: str = 'UTC'
    tilt: float = 0.0               # Array tilt angle (degrees)
    azimuth: float = 180.0          # Array azimuth (degrees, 180 = south)


@dataclass
class ModuleParams:
    """PV module parameters."""
    gamma_pdc: float = -0.004       # Temperature coefficient (%/°C), typically -0.4% for c-Si
    t_noct: float = 45.0            # Nominal operating cell temperature (°C)
    a: float = -3.47                # Sandia cell temp coefficient
    b: float = -0.0594              # Sandia cell temp coefficient (wind)
    delta_t: float = 3.0            # Cell-module temp difference


@dataclass
class FeatureEngConfig:
    """Configuration for feature engineering."""
    # Auto-detection thresholds
    wind_availability_threshold: float = 0.7    # Min non-null ratio for wind data

    # Feature groups to generate
    generate_solar_geometry: bool = True
    generate_irradiance_features: bool = True
    generate_temperature_features: bool = True
    generate_temporal_encoding: bool = True
    generate_angle_features: bool = True

    # Defaults when data unavailable
    default_wind_speed: float = 1.0             # m/s


class PhysicsFeatureEngineer:
    """
    Physics-only feature engineering for solar PV digital twins.

    Generates features exclusively from environmental conditions and
    calculated solar geometry. NO power-derived features are allowed.
    """

    # Features that are PROHIBITED (will raise error if requested)
    PROHIBITED_FEATURES = {
        'power_lag', 'power_lag_1', 'power_lag_2', 'power_lag_3',
        'power_rolling_mean', 'power_rolling_std', 'power_rolling_max',
        'power_change_rate', 'power_diff', 'power_pct_change',
        'cumulative_energy', 'energy_cumsum',
        'performance_ratio',  # This is derived from power!
    }

    # Allowed feature groups
    ALLOWED_FEATURE_GROUPS = [
        'solar_geometry',     # Sun position, air mass
        'irradiance',         # GHI, POA, clear sky index
        'temperature',        # Ambient, cell temperature
        'temporal',           # Cyclical time encodings
        'angle',              # AOI, IAM
    ]

    def __init__(
        self,
        location: Optional[LocationParams] = None,
        module: Optional[ModuleParams] = None,
        config: Optional[FeatureEngConfig] = None,
    ):
        """
        Initialize physics feature engineer.

        Parameters:
        -----------
        location : LocationParams
            Location parameters (lat, lon, etc.)
        module : ModuleParams
            Module parameters (temperature coefficients)
        config : FeatureEngConfig
            Configuration options
        """
        self.location = location or LocationParams()
        self.module = module or ModuleParams()
        self.config = config or FeatureEngConfig()

        # Track which features were generated
        self._generated_features: List[str] = []
        self._wind_available: bool = False

    def _validate_no_power_features(self, df: pd.DataFrame) -> None:
        """
        Validate that no power-derived features are being used.

        Raises ValueError if any prohibited features are detected.
        """
        columns = set(df.columns)
        prohibited = columns.intersection(self.PROHIBITED_FEATURES)

        if prohibited:
            raise ValueError(
                f"PROHIBITED power-derived features detected: {prohibited}. "
                f"These features cause data leakage and must be removed."
            )

        # Also check for patterns
        for col in columns:
            col_lower = col.lower()
            if 'power_lag' in col_lower or 'power_rolling' in col_lower:
                raise ValueError(
                    f"Power-derived feature detected: '{col}'. "
                    f"Remove all lagged/rolling power features."
                )

    def _check_wind_availability(self, df: pd.DataFrame, wind_col: str) -> bool:
        """
        Check if wind data is available and sufficient.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        wind_col : str
            Wind speed column name

        Returns:
        --------
        bool
            True if wind data is usable
        """
        if wind_col not in df.columns:
            return False

        non_null_ratio = df[wind_col].notna().mean()
        self._wind_available = non_null_ratio >= self.config.wind_availability_threshold

        if self._wind_available:
            logger.info(f"Wind data available ({100*non_null_ratio:.1f}% non-null)")
        else:
            logger.info(f"Wind data insufficient ({100*non_null_ratio:.1f}% non-null), using default")

        return self._wind_available

    def generate_solar_geometry(
        self,
        df: pd.DataFrame,
    ) -> pd.DataFrame:
        """
        Generate solar geometry features using pvlib or fallback.

        Features generated:
        - sun_zenith: Solar zenith angle (degrees)
        - sun_elevation: Solar elevation angle (degrees)
        - sun_azimuth: Solar azimuth angle (degrees)
        - air_mass: Atmospheric air mass
        - extraterrestrial_radiation: TOA irradiance (W/m²)

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with datetime index

        Returns:
        --------
        pd.DataFrame
            Data with solar geometry features added
        """
        df = df.copy()

        if not isinstance(df.index, pd.DatetimeIndex):
            logger.warning("Non-datetime index, skipping solar geometry")
            return df

        times = df.index

        if PVLIB_AVAILABLE and self.location.latitude != 0:
            # Use pvlib for accurate calculations
            sol_pos = solarposition.get_solarposition(
                times,
                self.location.latitude,
                self.location.longitude,
                altitude=self.location.altitude,
            )

            df['sun_zenith'] = sol_pos['zenith'].values
            df['sun_elevation'] = sol_pos['elevation'].values
            df['sun_azimuth'] = sol_pos['azimuth'].values

            # Air mass
            df['air_mass'] = atmosphere.get_relative_airmass(sol_pos['apparent_zenith'])
            df['air_mass'] = df['air_mass'].clip(upper=40)  # Cap extreme values

            # Extraterrestrial radiation
            dni_extra = irradiance.get_extra_radiation(times)
            df['extraterrestrial_dni'] = dni_extra

            logger.debug("Generated solar geometry features using pvlib")

        else:
            # Simplified calculations without pvlib
            # Day of year
            doy = times.dayofyear

            # Solar declination (approximate)
            declination = 23.45 * np.sin(np.radians((284 + doy) * 360 / 365))
            df['solar_declination'] = declination

            # Hour angle (approximate)
            hour = times.hour + times.minute / 60
            hour_angle = 15 * (hour - 12)  # Degrees

            # Solar elevation (simplified, assumes lat 0)
            lat_rad = np.radians(self.location.latitude)
            decl_rad = np.radians(declination)
            hour_rad = np.radians(hour_angle)

            elevation = np.degrees(np.arcsin(
                np.sin(lat_rad) * np.sin(decl_rad) +
                np.cos(lat_rad) * np.cos(decl_rad) * np.cos(hour_rad)
            ))

            df['sun_elevation'] = np.maximum(elevation, 0)
            df['sun_zenith'] = 90 - df['sun_elevation']

            # Simplified air mass
            df['air_mass'] = np.where(
                df['sun_elevation'] > 0,
                1 / np.cos(np.radians(df['sun_zenith'].values)).clip(min=0.01),
                40
            ).clip(max=40)

            logger.debug("Generated solar geometry features using simplified calculations")

        self._generated_features.extend([
            'sun_zenith', 'sun_elevation', 'sun_azimuth', 'air_mass'
        ])

        return df

    def generate_irradiance_features(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
    ) -> pd.DataFrame:
        """
        Generate irradiance-based features.

        Features generated:
        - normalized_irradiance: G / 1000 (fraction of STC)
        - clear_sky_index: G_measured / G_clearsky
        - ghi_variability: Rolling std of irradiance (cloud indicator)

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        irradiance_col : str
            Irradiance column name

        Returns:
        --------
        pd.DataFrame
            Data with irradiance features added
        """
        df = df.copy()

        if irradiance_col not in df.columns:
            logger.warning(f"Irradiance column '{irradiance_col}' not found")
            return df

        irr = df[irradiance_col]

        # Normalized irradiance
        df['normalized_irradiance'] = irr / 1000.0

        # Clear sky index (if we can calculate clear sky)
        if PVLIB_AVAILABLE and 'sun_zenith' in df.columns and self.location.latitude != 0:
            try:
                # Calculate clear sky GHI
                times = df.index if isinstance(df.index, pd.DatetimeIndex) else pd.to_datetime(df.index)

                clearsky = pvlib.clearsky.ineichen(
                    apparent_zenith=df['sun_zenith'],
                    airmass_absolute=df['air_mass'] * (1 - self.location.altitude/10000),
                    linke_turbidity=3.0,  # Typical value
                    altitude=self.location.altitude,
                    dni_extra=df.get('extraterrestrial_dni', 1361.0),
                )

                ghi_clearsky = clearsky['ghi']
                df['clear_sky_index'] = np.where(
                    ghi_clearsky > 50,
                    irr / ghi_clearsky,
                    np.nan
                ).clip(0, 1.5)

            except Exception as e:
                logger.debug(f"Could not calculate clear sky index: {e}")
                df['clear_sky_index'] = np.nan
        else:
            df['clear_sky_index'] = np.nan

        # Irradiance variability (10-minute rolling std)
        if isinstance(df.index, pd.DatetimeIndex):
            irr_mean = irr.rolling('10min', min_periods=3).mean()
            irr_std = irr.rolling('10min', min_periods=3).std()
            df['ghi_variability'] = np.where(irr_mean > 50, irr_std / irr_mean, 0)
        else:
            # Fallback to sample-based rolling
            irr_mean = irr.rolling(10, min_periods=3).mean()
            irr_std = irr.rolling(10, min_periods=3).std()
            df['ghi_variability'] = np.where(irr_mean > 50, irr_std / irr_mean, 0)

        self._generated_features.extend([
            'normalized_irradiance', 'clear_sky_index', 'ghi_variability'
        ])

        return df

    def generate_temperature_features(
        self,
        df: pd.DataFrame,
        temperature_col: str = 'temperature',
        irradiance_col: str = 'irradiance',
        wind_col: Optional[str] = 'wind_speed',
    ) -> pd.DataFrame:
        """
        Generate temperature-related features.

        Features generated:
        - t_cell_estimated: Estimated cell temperature (Sandia model)
        - delta_t_stc: Temperature deviation from STC (25°C)
        - temp_efficiency_factor: Temperature derating factor

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        temperature_col : str
            Ambient temperature column name
        irradiance_col : str
            Irradiance column name
        wind_col : str
            Wind speed column name (optional)

        Returns:
        --------
        pd.DataFrame
            Data with temperature features added
        """
        df = df.copy()

        if temperature_col not in df.columns:
            logger.warning(f"Temperature column '{temperature_col}' not found")
            return df

        t_amb = df[temperature_col].values
        g_poa = df[irradiance_col].values if irradiance_col in df.columns else np.zeros(len(df))

        # Check wind availability
        if wind_col and self._check_wind_availability(df, wind_col):
            wind = df[wind_col].fillna(self.config.default_wind_speed).values
        else:
            wind = np.full(len(df), self.config.default_wind_speed)

        # Cell temperature using Sandia model
        # T_cell = G_poa * exp(a + b * wind_speed) + T_amb
        a = self.module.a
        b = self.module.b

        t_cell = g_poa * np.exp(a + b * wind) + t_amb
        df['t_cell_estimated'] = t_cell

        # Temperature deviation from STC (25°C)
        df['delta_t_stc'] = t_cell - 25.0

        # Temperature efficiency factor
        # P = P_stc * (1 + gamma * (T_cell - 25))
        df['temp_efficiency_factor'] = 1 + self.module.gamma_pdc * (t_cell - 25)

        self._generated_features.extend([
            't_cell_estimated', 'delta_t_stc', 'temp_efficiency_factor'
        ])

        return df

    def generate_temporal_features(
        self,
        df: pd.DataFrame,
    ) -> pd.DataFrame:
        """
        Generate cyclical temporal features.

        Features generated:
        - hour_sin, hour_cos: Cyclical hour encoding
        - doy_sin, doy_cos: Cyclical day-of-year encoding
        - month: Month of year (1-12)

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with datetime index

        Returns:
        --------
        pd.DataFrame
            Data with temporal features added
        """
        df = df.copy()

        if not isinstance(df.index, pd.DatetimeIndex):
            logger.warning("Non-datetime index, skipping temporal features")
            return df

        times = df.index

        # Cyclical hour encoding
        hour = times.hour + times.minute / 60
        df['hour_sin'] = np.sin(2 * np.pi * hour / 24)
        df['hour_cos'] = np.cos(2 * np.pi * hour / 24)

        # Cyclical day-of-year encoding
        doy = times.dayofyear
        df['doy_sin'] = np.sin(2 * np.pi * doy / 365)
        df['doy_cos'] = np.cos(2 * np.pi * doy / 365)

        # Month (useful for seasonal patterns)
        df['month'] = times.month

        self._generated_features.extend([
            'hour_sin', 'hour_cos', 'doy_sin', 'doy_cos', 'month'
        ])

        return df

    def generate_angle_features(
        self,
        df: pd.DataFrame,
    ) -> pd.DataFrame:
        """
        Generate angle of incidence features.

        Features generated:
        - aoi: Angle of incidence (degrees)
        - iam: Incidence angle modifier (ASHRAE)
        - effective_irradiance: POA * IAM

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with solar geometry

        Returns:
        --------
        pd.DataFrame
            Data with angle features added
        """
        df = df.copy()

        if 'sun_zenith' not in df.columns or 'sun_azimuth' not in df.columns:
            logger.debug("Solar geometry not available for angle features")
            return df

        if PVLIB_AVAILABLE:
            try:
                # Angle of incidence
                aoi = irradiance.aoi(
                    self.location.tilt,
                    self.location.azimuth,
                    df['sun_zenith'],
                    df['sun_azimuth']
                )
                df['aoi'] = aoi

                # Incidence angle modifier (ASHRAE model)
                iam = pvlib.iam.ashrae(aoi, b=0.05)
                df['iam'] = iam

                # Effective irradiance
                if 'normalized_irradiance' in df.columns:
                    df['effective_irradiance'] = df['normalized_irradiance'] * df['iam']

                self._generated_features.extend(['aoi', 'iam', 'effective_irradiance'])

            except Exception as e:
                logger.debug(f"Could not calculate angle features: {e}")

        return df

    def generate_all_features(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
        temperature_col: str = 'temperature',
        wind_col: Optional[str] = 'wind_speed',
    ) -> pd.DataFrame:
        """
        Generate all physics features.

        This is the main entry point for feature engineering.
        Generates all configured feature groups and validates
        that no power-derived features are present.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with datetime index
        irradiance_col : str
            Irradiance column name
        temperature_col : str
            Ambient temperature column name
        wind_col : str
            Wind speed column name (optional)

        Returns:
        --------
        pd.DataFrame
            Data with all physics features added
        """
        logger.info(f"Generating physics features for {len(df)} samples")

        # Reset generated features list
        self._generated_features = []

        # Validate no power features in input
        self._validate_no_power_features(df)

        df = df.copy()

        # Check wind availability once
        if wind_col:
            self._check_wind_availability(df, wind_col)

        # Generate features in order (some depend on others)
        if self.config.generate_solar_geometry:
            df = self.generate_solar_geometry(df)

        if self.config.generate_irradiance_features:
            df = self.generate_irradiance_features(df, irradiance_col)

        if self.config.generate_temperature_features:
            df = self.generate_temperature_features(
                df, temperature_col, irradiance_col, wind_col
            )

        if self.config.generate_temporal_encoding:
            df = self.generate_temporal_features(df)

        if self.config.generate_angle_features:
            df = self.generate_angle_features(df)

        logger.info(f"Generated {len(self._generated_features)} physics features")

        return df

    def get_feature_columns(self) -> List[str]:
        """
        Get list of generated feature columns.

        Returns:
        --------
        List[str]
            Feature column names
        """
        return self._generated_features.copy()

    def get_ml_ready_features(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
    ) -> Tuple[pd.DataFrame, List[str]]:
        """
        Get feature matrix ready for ML model training.

        Returns DataFrame with only feature columns (no target).

        Parameters:
        -----------
        df : pd.DataFrame
            Data with all features
        irradiance_col : str
            Original irradiance column (always included)

        Returns:
        --------
        Tuple[pd.DataFrame, List[str]]
            (Feature matrix, feature column names)
        """
        # Base features always included
        feature_cols = [irradiance_col] if irradiance_col in df.columns else []

        # Add generated features
        feature_cols.extend([
            col for col in self._generated_features
            if col in df.columns
        ])

        # Remove duplicates while preserving order
        feature_cols = list(dict.fromkeys(feature_cols))

        # Create feature matrix
        X = df[feature_cols].copy()

        # Drop columns that are entirely NaN (e.g. clear_sky_index without pvlib location)
        all_nan_cols = [c for c in X.columns if X[c].isna().all()]
        if all_nan_cols:
            logger.debug(f"Dropping all-NaN feature columns: {all_nan_cols}")
            X = X.drop(columns=all_nan_cols)
            feature_cols = [c for c in feature_cols if c not in all_nan_cols]

        return X, feature_cols


def create_physics_engineer(
    latitude: float = 0.0,
    longitude: float = 0.0,
    altitude: float = 0.0,
    tilt: float = 0.0,
    azimuth: float = 180.0,
    gamma_pdc: float = -0.004,
) -> PhysicsFeatureEngineer:
    """
    Create a physics feature engineer with location and module parameters.

    Parameters:
    -----------
    latitude : float
        Location latitude (degrees)
    longitude : float
        Location longitude (degrees)
    altitude : float
        Altitude above sea level (meters)
    tilt : float
        Array tilt angle (degrees)
    azimuth : float
        Array azimuth (degrees, 180 = south)
    gamma_pdc : float
        Temperature coefficient (%/°C)

    Returns:
    --------
    PhysicsFeatureEngineer
        Configured feature engineer
    """
    location = LocationParams(
        latitude=latitude,
        longitude=longitude,
        altitude=altitude,
        tilt=tilt,
        azimuth=azimuth,
    )

    module = ModuleParams(gamma_pdc=gamma_pdc)

    return PhysicsFeatureEngineer(location=location, module=module)
