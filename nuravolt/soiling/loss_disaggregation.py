"""
IEA PVPS Task 13 compliant loss disaggregation for solar PV systems.

This module provides comprehensive loss breakdown following the IEA sequential
subtraction method, separating losses into:
- Soiling (controllable)
- Temperature (weather-dependent)
- Spectral (weather-dependent)
- Inverter efficiency (equipment)
- Wiring/BOP (fixed system losses)
- Degradation (time-dependent)
- Curtailment (external/grid)

Reference: IEA PVPS Task 13, IEC 61853-3
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Union, Tuple
from pathlib import Path

import numpy as np
import pandas as pd


# Physical constants for loss calculations
PHYSICS_CONSTANTS = {
    # Temperature coefficients
    'gamma_pmax': -0.004,       # -0.4%/°C power temperature coefficient (mono-Si)
    'T_stc': 25.0,              # STC temperature (°C)
    'T_noct': 45.0,             # Nominal Operating Cell Temperature (°C)
    'G_stc': 1000.0,            # STC irradiance (W/m²)

    # Module characteristics
    'eta_stc': 0.20,            # STC module efficiency (20% typical for mono-Si)
    'degradation_rate': 0.005,  # 0.5%/year annual degradation

    # System losses
    'wiring_bop_loss': 0.02,    # 2% wiring/BOP fixed loss
}

# Inverter efficiency curve (load fraction -> efficiency)
INVERTER_EFFICIENCY_CURVE = {
    0.05: 0.88,   # 5% load
    0.10: 0.92,   # 10% load
    0.20: 0.96,   # 20% load
    0.30: 0.975,  # 30% load
    0.50: 0.985,  # 50% load (peak efficiency)
    0.75: 0.98,   # 75% load
    1.00: 0.97,   # 100% load
    1.10: 0.95,   # 110% load (clipping)
}


# =============================================================================
# Adaptive Rain Cleaning Model
# =============================================================================

@dataclass
class RainCleaningConfig:
    """Configuration for adaptive rain cleaning model.

    Models rain cleaning efficacy based on:
    - Rain amount and intensity
    - Module tilt angle (steeper = better runoff)
    - Dust cementation (time since last rain)
    - Pre-rain soiling level (heavily soiled needs more rain)

    Reference: Ilse et al. (2019), IEA PVPS Task 13 Report T13-12:2022
    """

    # Module tilt angle in degrees (steeper = better cleaning)
    tilt_angle: float = 25.0

    # Rain thresholds (mm)
    min_rain_mm: float = 2.0      # Below this, no cleaning effect
    full_clean_mm: float = 15.0   # Approximate saturation point

    # Time-based factors
    cementation_start_days: int = 14  # Days after which dust starts to cement
    cementation_rate: float = 0.015   # Additional resistance per day after start

    # Cleaning recovery
    max_sr_after_rain: float = 1.0    # Maximum SR after cleaning (capped)
    typical_sr_after_heavy: float = 0.995  # Typical SR after >15mm rain


def estimate_post_rain_sr(
    rain_mm: float,
    pre_rain_sr: float,
    tilt_angle: float = 25.0,
    days_since_rain: int = 0,
    rain_intensity_mm_hr: Optional[float] = None,
    config: Optional[RainCleaningConfig] = None,
) -> float:
    """Estimate soiling ratio after a rain event.

    Adaptive model that accounts for:
    - Rain amount (saturates around 15mm)
    - Module tilt angle (steeper = better runoff and cleaning)
    - Dust cementation (dust hardens over time without rain)
    - Rain intensity (heavy bursts clean better than drizzle)
    - Pre-rain soiling level (heavily soiled panels need more rain)

    Args:
        rain_mm: Rainfall amount in mm
        pre_rain_sr: Soiling ratio before rain event (0.7-1.0)
        tilt_angle: Module tilt angle in degrees
        days_since_rain: Days since last significant rain event
        rain_intensity_mm_hr: Optional rainfall intensity (mm/hour)
        config: Optional configuration override

    Returns:
        Estimated post-rain soiling ratio (0.7-1.0)

    Example:
        >>> estimate_post_rain_sr(rain_mm=12, pre_rain_sr=0.88, tilt_angle=25)
        0.978  # Near-complete cleaning

        >>> estimate_post_rain_sr(rain_mm=3, pre_rain_sr=0.92, tilt_angle=10)
        0.942  # Partial cleaning, shallow tilt reduces efficacy

        >>> estimate_post_rain_sr(rain_mm=8, pre_rain_sr=0.80, days_since_rain=30)
        0.851  # Cemented dust reduces cleaning efficacy
    """
    cfg = config or RainCleaningConfig()

    # No effect below minimum threshold
    if rain_mm < cfg.min_rain_mm:
        return pre_rain_sr

    # 1. Base cleaning potential (exponential saturation around 15mm)
    # This follows empirical observations: most cleaning occurs in first 10mm
    cleaning_potential = 1 - np.exp(-rain_mm / 8.0)

    # 2. Tilt adjustment (steeper = better runoff and mechanical cleaning)
    # 70% effectiveness at 0° (flat), 100% at 30°+
    tilt_factor = 0.7 + 0.3 * min(tilt_angle / 30.0, 1.0)

    # 3. Cementation factor (dust hardens over extended dry periods)
    # After 14+ days, dust becomes increasingly difficult to wash off
    if days_since_rain > cfg.cementation_start_days:
        cementation = 1.0 + cfg.cementation_rate * (days_since_rain - cfg.cementation_start_days)
    else:
        cementation = 1.0

    # 4. Intensity boost (heavy rain bursts provide mechanical cleaning action)
    # Light drizzle redistributes dust more than it removes it
    if rain_intensity_mm_hr is not None and rain_intensity_mm_hr > 10:
        intensity_boost = 1.1  # 10% bonus for heavy rain
    elif rain_intensity_mm_hr is not None and rain_intensity_mm_hr < 2:
        intensity_boost = 0.85  # Penalty for very light rain
    else:
        intensity_boost = 1.0

    # 5. Soiling resistance (heavily soiled panels need more rain to clean)
    # Below SR=0.95, dust layer is thicker and harder to remove
    if pre_rain_sr < 0.95:
        soiling_resistance = 1.0 + 0.5 * (0.95 - pre_rain_sr)
    else:
        soiling_resistance = 1.0

    # Calculate effective cleaning fraction
    effective_cleaning = (
        cleaning_potential * tilt_factor * intensity_boost
        / (cementation * soiling_resistance)
    )
    effective_cleaning = min(effective_cleaning, 1.0)  # Cap at 100%

    # SR improvement = fraction of soiling that gets removed
    soiling_before = 1.0 - pre_rain_sr  # How dirty was it?
    soiling_removed = soiling_before * effective_cleaning
    new_sr = pre_rain_sr + soiling_removed

    # Apply physical limits
    return float(min(cfg.max_sr_after_rain, max(0.7, new_sr)))


def simulate_sr_with_rain(
    dates: pd.DatetimeIndex,
    rain_mm: pd.Series,
    base_decay_rate: float = 0.002,
    tilt_angle: float = 25.0,
    initial_sr: float = 1.0,
    rain_intensity: Optional[pd.Series] = None,
    config: Optional[RainCleaningConfig] = None,
) -> pd.Series:
    """Simulate soiling ratio evolution with rain cleaning events.

    Forward-simulates SR from an initial value, applying:
    - Daily decay from dust accumulation
    - Rain cleaning events using adaptive model

    Args:
        dates: Date index for simulation
        rain_mm: Daily rainfall amounts (mm)
        base_decay_rate: SR decay per day without rain (default 0.2%/day)
        tilt_angle: Module tilt angle in degrees
        initial_sr: Starting soiling ratio
        rain_intensity: Optional rainfall intensity (mm/hour per day)
        config: Optional configuration override

    Returns:
        Simulated daily soiling ratio series

    Example:
        >>> dates = pd.date_range('2024-01-01', periods=30, freq='D')
        >>> rain = pd.Series([0]*10 + [12] + [0]*19, index=dates)
        >>> sr = simulate_sr_with_rain(dates, rain)
        # SR decays for 10 days, jumps up after rain, then decays again
    """
    cfg = config or RainCleaningConfig()

    sr_values = []
    current_sr = initial_sr
    days_since_rain = 0

    for i, date in enumerate(dates):
        daily_rain = rain_mm.get(date, 0)
        intensity = rain_intensity.get(date) if rain_intensity is not None else None

        if daily_rain >= cfg.min_rain_mm:
            # Rain event: apply cleaning model
            current_sr = estimate_post_rain_sr(
                rain_mm=daily_rain,
                pre_rain_sr=current_sr,
                tilt_angle=tilt_angle,
                days_since_rain=days_since_rain,
                rain_intensity_mm_hr=intensity,
                config=cfg,
            )
            days_since_rain = 0
        else:
            # No rain: apply decay
            current_sr = max(0.7, current_sr - base_decay_rate)
            days_since_rain += 1

        sr_values.append(current_sr)

    return pd.Series(sr_values, index=dates, name='sr_simulated')


@dataclass
class LossComponents:
    """Container for disaggregated loss values."""

    # Individual loss percentages (as fraction, e.g., 0.05 = 5%)
    soiling_loss_pct: float = 0.0
    temperature_loss_pct: float = 0.0
    spectral_loss_pct: float = 0.0
    inverter_loss_pct: float = 0.0
    wiring_bop_loss_pct: float = 0.0
    degradation_loss_pct: float = 0.0
    curtailment_loss_pct: float = 0.0

    # Aggregate metrics
    total_loss_pct: float = 0.0
    controllable_loss_pct: float = 0.0  # Soiling only
    uncontrollable_loss_pct: float = 0.0

    # Energy values (kWh or MWh depending on context)
    reference_energy: float = 0.0
    net_energy: float = 0.0
    energy_loss_total: float = 0.0

    # Energy losses by category
    soiling_energy_loss: float = 0.0
    temperature_energy_loss: float = 0.0
    spectral_energy_loss: float = 0.0
    inverter_energy_loss: float = 0.0
    wiring_bop_energy_loss: float = 0.0
    degradation_energy_loss: float = 0.0
    curtailment_energy_loss: float = 0.0

    # Metadata
    aggregation_period: str = 'annual'
    start_date: Optional[str] = None
    end_date: Optional[str] = None

    def __post_init__(self):
        """Calculate derived fields."""
        self.controllable_loss_pct = self.soiling_loss_pct
        self.uncontrollable_loss_pct = (
            self.temperature_loss_pct +
            self.spectral_loss_pct +
            self.inverter_loss_pct +
            self.wiring_bop_loss_pct +
            self.degradation_loss_pct +
            self.curtailment_loss_pct
        )
        self.total_loss_pct = self.controllable_loss_pct + self.uncontrollable_loss_pct
        self.energy_loss_total = self.reference_energy - self.net_energy

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'loss_percentages': {
                'soiling': round(self.soiling_loss_pct * 100, 2),
                'temperature': round(self.temperature_loss_pct * 100, 2),
                'spectral': round(self.spectral_loss_pct * 100, 2),
                'inverter': round(self.inverter_loss_pct * 100, 2),
                'wiring_bop': round(self.wiring_bop_loss_pct * 100, 2),
                'degradation': round(self.degradation_loss_pct * 100, 2),
                'curtailment': round(self.curtailment_loss_pct * 100, 2),
                'total': round(self.total_loss_pct * 100, 2),
                'controllable': round(self.controllable_loss_pct * 100, 2),
                'uncontrollable': round(self.uncontrollable_loss_pct * 100, 2),
            },
            'energy': {
                'reference_MWh': round(self.reference_energy / 1000, 2),
                'net_MWh': round(self.net_energy / 1000, 2),
                'total_loss_MWh': round(self.energy_loss_total / 1000, 2),
            },
            'energy_losses_MWh': {
                'soiling': round(self.soiling_energy_loss / 1000, 2),
                'temperature': round(self.temperature_energy_loss / 1000, 2),
                'spectral': round(self.spectral_energy_loss / 1000, 2),
                'inverter': round(self.inverter_energy_loss / 1000, 2),
                'wiring_bop': round(self.wiring_bop_energy_loss / 1000, 2),
                'degradation': round(self.degradation_energy_loss / 1000, 2),
                'curtailment': round(self.curtailment_energy_loss / 1000, 2),
            },
            'metadata': {
                'aggregation_period': self.aggregation_period,
                'start_date': self.start_date,
                'end_date': self.end_date,
            }
        }

    def to_table(self) -> pd.DataFrame:
        """Convert to DataFrame for reporting."""
        data = {
            'Loss Category': [
                'Temperature', 'Spectral', 'Soiling', 'Inverter Efficiency',
                'Wiring/BOP', 'Degradation', 'Curtailment', 'TOTAL'
            ],
            'Loss (%)': [
                round(self.temperature_loss_pct * 100, 2),
                round(self.spectral_loss_pct * 100, 2),
                round(self.soiling_loss_pct * 100, 2),
                round(self.inverter_loss_pct * 100, 2),
                round(self.wiring_bop_loss_pct * 100, 2),
                round(self.degradation_loss_pct * 100, 2),
                round(self.curtailment_loss_pct * 100, 2),
                round(self.total_loss_pct * 100, 2),
            ],
            'Energy Loss (MWh)': [
                round(self.temperature_energy_loss / 1000, 1),
                round(self.spectral_energy_loss / 1000, 1),
                round(self.soiling_energy_loss / 1000, 1),
                round(self.inverter_energy_loss / 1000, 1),
                round(self.wiring_bop_energy_loss / 1000, 1),
                round(self.degradation_energy_loss / 1000, 1),
                round(self.curtailment_energy_loss / 1000, 1),
                round(self.energy_loss_total / 1000, 1),
            ],
            'Controllable': [
                'Partially', 'No', 'Yes', 'No', 'No', 'No', 'External', '-'
            ]
        }
        return pd.DataFrame(data)


class CurtailmentLoader:
    """
    Load and integrate DV/EVU curtailment data.

    DV (Dynamic Value) / EVU (Expected Value Unit) represent grid curtailment:
    - 100 = no curtailment (full generation allowed)
    - 0 = full curtailment (no generation allowed)
    - Values between represent partial curtailment percentage
    """

    def __init__(self, dv_col: str = 'dv_value', timestamp_col: str = 'timestamp'):
        """
        Initialize curtailment loader.

        Parameters:
        -----------
        dv_col : str
            Column name for DV/EVU values (default: 'dv_value')
        timestamp_col : str
            Column name for timestamp (default: 'timestamp')
        """
        self.dv_col = dv_col
        self.timestamp_col = timestamp_col

    def load_curtailment_file(
        self,
        filepath: Union[str, Path],
        timestamp_col: Optional[str] = None,
        value_col: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Load curtailment data from CSV or Parquet file.

        Parameters:
        -----------
        filepath : str or Path
            Path to curtailment data file (CSV, Parquet, or Excel)
        timestamp_col : str, optional
            Override default timestamp column name
        value_col : str, optional
            Override default DV value column name

        Returns:
        --------
        pd.DataFrame
            DataFrame with 'timestamp' and 'curtailment_factor' columns
            curtailment_factor = 1 - (dv_value / 100)
        """
        filepath = Path(filepath)
        ts_col = timestamp_col or self.timestamp_col
        dv_col = value_col or self.dv_col

        # Load based on file extension
        if filepath.suffix == '.parquet':
            df = pd.read_parquet(filepath)
        elif filepath.suffix in ['.csv', '.txt']:
            df = pd.read_csv(filepath, parse_dates=[ts_col])
        elif filepath.suffix in ['.xlsx', '.xls']:
            df = pd.read_excel(filepath, parse_dates=[ts_col])
        else:
            raise ValueError(f"Unsupported file format: {filepath.suffix}")

        # Validate required columns
        if ts_col not in df.columns:
            # Try to find timestamp column
            ts_candidates = ['timestamp', 'datetime', 'time', 'date', 'Timestamp']
            for candidate in ts_candidates:
                if candidate in df.columns:
                    ts_col = candidate
                    break
            else:
                raise ValueError(f"Timestamp column '{ts_col}' not found. Available: {df.columns.tolist()}")

        if dv_col not in df.columns:
            # Try to find DV column
            dv_candidates = ['dv_value', 'dv', 'evu', 'curtailment', 'availability', 'DV', 'EVU']
            for candidate in dv_candidates:
                if candidate in df.columns:
                    dv_col = candidate
                    break
            else:
                raise ValueError(f"DV/EVU column '{dv_col}' not found. Available: {df.columns.tolist()}")

        # Create standardized output
        result = pd.DataFrame({
            'timestamp': pd.to_datetime(df[ts_col]),
            'dv_value': df[dv_col].astype(float)
        })

        # Validate DV values are in expected range
        if result['dv_value'].min() < 0 or result['dv_value'].max() > 100:
            print(f"⚠️  Warning: DV values outside 0-100 range detected")
            print(f"   Range: {result['dv_value'].min():.1f} - {result['dv_value'].max():.1f}")
            result['dv_value'] = result['dv_value'].clip(0, 100)

        # Calculate curtailment factor (0 = no curtailment, 1 = full curtailment)
        result['curtailment_factor'] = 1 - (result['dv_value'] / 100)

        # Set timestamp as index
        result = result.set_index('timestamp').sort_index()

        print(f"✅ Loaded curtailment data: {len(result)} records")
        print(f"   Period: {result.index.min()} to {result.index.max()}")
        print(f"   Curtailment events: {(result['curtailment_factor'] > 0).sum()} "
              f"({(result['curtailment_factor'] > 0).mean()*100:.1f}%)")

        return result

    def merge_with_production(
        self,
        df_production: pd.DataFrame,
        df_curtailment: pd.DataFrame,
        method: str = 'nearest'
    ) -> pd.DataFrame:
        """
        Merge curtailment data with production data using timestamp alignment.

        Parameters:
        -----------
        df_production : pd.DataFrame
            Production data with timestamp index
        df_curtailment : pd.DataFrame
            Curtailment data from load_curtailment_file()
        method : str
            Merge method: 'nearest', 'ffill', 'bfill'

        Returns:
        --------
        pd.DataFrame
            Production data with added curtailment columns
        """
        # Ensure both have datetime index
        if not isinstance(df_production.index, pd.DatetimeIndex):
            if 'timestamp' in df_production.columns:
                df_production = df_production.set_index('timestamp')
            else:
                raise ValueError("Production data must have timestamp index or column")

        # Resample curtailment to match production frequency
        freq = pd.infer_freq(df_production.index[:100])
        if freq is None:
            freq = '15min'  # Default assumption

        # Merge using merge_asof for time alignment
        result = df_production.copy()

        if method == 'nearest':
            result = pd.merge_asof(
                result.reset_index(),
                df_curtailment[['dv_value', 'curtailment_factor']].reset_index(),
                on='timestamp',
                direction='nearest',
                tolerance=pd.Timedelta('1H')
            ).set_index('timestamp')
        else:
            # Reindex and fill
            curtailment_reindexed = df_curtailment.reindex(
                df_production.index,
                method=method
            )
            result['dv_value'] = curtailment_reindexed['dv_value']
            result['curtailment_factor'] = curtailment_reindexed['curtailment_factor']

        # Fill missing values with 100 (no curtailment)
        result['dv_value'] = result['dv_value'].fillna(100.0)
        result['curtailment_factor'] = result['curtailment_factor'].fillna(0.0)

        print(f"✅ Merged curtailment data")
        print(f"   Curtailed periods: {(result['curtailment_factor'] > 0).sum()} "
              f"({(result['curtailment_factor'] > 0).mean()*100:.1f}%)")

        return result


class IEALossDisaggregator:
    """
    IEA PVPS Task 13 compliant loss disaggregation engine.

    Uses the sequential loss subtraction method to calculate individual
    loss components from reference energy to net output.

    Reference: IEA PVPS Task 13 Report T13-11:2021
    """

    def __init__(
        self,
        site_config: Any,
        system_age_years: float = 1.0,
        module_type: str = 'mono-Si',
        curtailment_data: Optional[pd.DataFrame] = None
    ):
        """
        Initialize loss disaggregator.

        Parameters:
        -----------
        site_config : SoilingConfig or dict
            Site configuration with capacity, location, etc.
        system_age_years : float
            Age of the system in years (for degradation calculation)
        module_type : str
            Module technology: 'mono-Si', 'poly-Si', 'CdTe', 'CIGS'
        curtailment_data : pd.DataFrame, optional
            Pre-loaded curtailment data
        """
        if hasattr(site_config, 'to_dict'):
            self.config = site_config.to_dict()
        elif isinstance(site_config, dict):
            self.config = site_config
        else:
            self.config = dict(site_config)

        self.system_age_years = system_age_years
        self.module_type = module_type
        self.curtailment_data = curtailment_data

        # Set temperature coefficient based on module type
        self.gamma = self._get_temp_coefficient(module_type)

        # Results storage
        self.df_losses: Optional[pd.DataFrame] = None
        self.loss_summary: Optional[LossComponents] = None

    def _get_temp_coefficient(self, module_type: str) -> float:
        """Get temperature coefficient for module type."""
        coefficients = {
            'mono-Si': -0.004,   # -0.4%/°C
            'poly-Si': -0.004,   # -0.4%/°C
            'CdTe': -0.0025,     # -0.25%/°C
            'CIGS': -0.0035,     # -0.35%/°C
        }
        return coefficients.get(module_type, -0.004)

    def calculate_cell_temperature(
        self,
        t_ambient: pd.Series,
        g_poa: pd.Series,
        wind_speed: Optional[pd.Series] = None
    ) -> pd.Series:
        """
        Calculate cell temperature using SAPM model.

        T_cell = T_amb + (G_poa / 800) * (T_noct - 20)

        Parameters:
        -----------
        t_ambient : pd.Series
            Ambient temperature (°C)
        g_poa : pd.Series
            Plane-of-array irradiance (W/m²)
        wind_speed : pd.Series, optional
            Wind speed (m/s) for cooling adjustment

        Returns:
        --------
        pd.Series
            Cell temperature (°C)
        """
        t_noct = PHYSICS_CONSTANTS['T_noct']

        # Basic NOCT model
        t_cell = t_ambient + (g_poa / 800) * (t_noct - 20)

        # Wind cooling adjustment if available
        if wind_speed is not None:
            # Reduce temperature rise by ~4% per m/s wind
            cooling_factor = 1 - 0.04 * wind_speed.clip(0, 10)
            t_cell = t_ambient + (g_poa / 800) * (t_noct - 20) * cooling_factor

        return t_cell

    def calculate_spectral_modifier(self, air_mass: pd.Series) -> pd.Series:
        """
        Calculate spectral modifier based on air mass.

        Uses simplified IEC 61853-3 model for crystalline silicon.

        Parameters:
        -----------
        air_mass : pd.Series
            Air mass values

        Returns:
        --------
        pd.Series
            Spectral modifier (0.95-1.0 typical)
        """
        # Simplified spectral model
        # At AM=1.5 (STC): modifier = 1.0
        # At higher AM: slight loss due to red-shifted spectrum
        modifier = pd.Series(1.0, index=air_mass.index)

        # Apply correction for AM > 1.5
        high_am_mask = air_mass > 1.5
        modifier[high_am_mask] = 0.99 - 0.01 * (air_mass[high_am_mask] - 1.5).clip(0, 3)

        # Low AM (morning/evening): slight gain due to blue-rich spectrum
        low_am_mask = air_mass < 1.5
        modifier[low_am_mask] = 1.0 + 0.005 * (1.5 - air_mass[low_am_mask]).clip(0, 0.5)

        return modifier.clip(0.95, 1.02)

    def calculate_inverter_efficiency(self, load_fraction: pd.Series) -> pd.Series:
        """
        Calculate inverter efficiency based on load fraction.

        Uses interpolated efficiency curve.

        Parameters:
        -----------
        load_fraction : pd.Series
            Load as fraction of inverter rating (0-1+)

        Returns:
        --------
        pd.Series
            Inverter efficiency (0.88-0.985)
        """
        load_points = np.array(list(INVERTER_EFFICIENCY_CURVE.keys()))
        eff_points = np.array(list(INVERTER_EFFICIENCY_CURVE.values()))

        # Interpolate efficiency
        efficiency = np.interp(
            load_fraction.clip(0.05, 1.1),
            load_points,
            eff_points
        )

        return pd.Series(efficiency, index=load_fraction.index)

    def calculate_all_losses(
        self,
        df: pd.DataFrame,
        poa_col: str = 'poa_actual',
        poa_clearsky_col: str = 'poa_clearsky',
        t_ambient_col: str = 'temperature',
        t_module_col: Optional[str] = None,
        power_col: Optional[str] = None,
        sr_col: str = 'soiling_ratio_smooth',
        air_mass_col: Optional[str] = None,
        wind_col: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Calculate all loss components for input data.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with required columns
        poa_col : str
            POA irradiance column
        poa_clearsky_col : str
            Clear-sky POA column
        t_ambient_col : str
            Ambient temperature column
        t_module_col : str, optional
            Module temperature column (if available)
        power_col : str, optional
            Actual power output column
        sr_col : str
            Soiling ratio column
        air_mass_col : str, optional
            Air mass column
        wind_col : str, optional
            Wind speed column

        Returns:
        --------
        pd.DataFrame
            Input data with added loss columns
        """
        result = df.copy()

        # Get capacity
        capacity_kw = self.config.get('capacity_MW', 9.0) * 1000

        # --- Step 1: Reference Energy (Theoretical Maximum) ---
        # E_ref = G_poa * A_eff * eta_stc (simplified as G_poa * capacity * eta_stc / G_stc)
        g_stc = PHYSICS_CONSTANTS['G_stc']
        eta_stc = PHYSICS_CONSTANTS['eta_stc']

        result['reference_power_kw'] = (
            result[poa_col].fillna(0) / g_stc * capacity_kw
        )

        # --- Step 2: Temperature Loss ---
        t_stc = PHYSICS_CONSTANTS['T_stc']

        if t_module_col and t_module_col in result.columns:
            t_cell = result[t_module_col]
        elif t_ambient_col in result.columns:
            wind = result[wind_col] if wind_col and wind_col in result.columns else None
            t_cell = self.calculate_cell_temperature(
                result[t_ambient_col],
                result[poa_col],
                wind
            )
        else:
            # Assume 35°C average cell temperature if no data
            t_cell = pd.Series(35.0, index=result.index)

        result['t_cell'] = t_cell
        result['temperature_loss_factor'] = (self.gamma * (t_cell - t_stc)).clip(-0.2, 0.1)

        # --- Step 3: Spectral Loss ---
        if air_mass_col and air_mass_col in result.columns:
            air_mass = result[air_mass_col]
        else:
            # Estimate air mass from solar elevation if available
            if 'solar_elevation' in result.columns:
                elevation = result['solar_elevation'].clip(1, 90)
                air_mass = 1 / np.sin(np.radians(elevation))
            else:
                air_mass = pd.Series(1.5, index=result.index)  # Default to AM1.5

        result['spectral_modifier'] = self.calculate_spectral_modifier(air_mass)
        result['spectral_loss_factor'] = 1 - result['spectral_modifier']

        # --- Step 4: Soiling Loss ---
        if sr_col in result.columns:
            sr = result[sr_col].fillna(1.0)
        elif 'soiling_ratio' in result.columns:
            sr = result['soiling_ratio'].fillna(1.0)
        else:
            sr = pd.Series(1.0, index=result.index)

        result['soiling_loss_factor'] = (1 - sr).clip(0, 0.5)

        # --- Step 5: Inverter Efficiency Loss ---
        if power_col and power_col in result.columns:
            load_fraction = result[power_col] / capacity_kw
        else:
            # Estimate load from irradiance
            load_fraction = result[poa_col] / g_stc

        result['inverter_efficiency'] = self.calculate_inverter_efficiency(load_fraction)
        result['inverter_loss_factor'] = 1 - result['inverter_efficiency']

        # --- Step 6: Wiring/BOP Loss (Fixed) ---
        result['wiring_bop_loss_factor'] = PHYSICS_CONSTANTS['wiring_bop_loss']

        # --- Step 7: Degradation Loss ---
        degradation_rate = PHYSICS_CONSTANTS['degradation_rate']
        result['degradation_loss_factor'] = self.system_age_years * degradation_rate

        # --- Step 8: Curtailment Loss ---
        if self.curtailment_data is not None:
            result = self._merge_curtailment(result)
        elif 'curtailment_factor' in result.columns:
            pass  # Already has curtailment
        elif 'dv_value' in result.columns:
            result['curtailment_factor'] = 1 - (result['dv_value'] / 100)
        else:
            result['curtailment_factor'] = 0.0

        result['curtailment_loss_factor'] = result['curtailment_factor'].fillna(0.0)

        # --- Calculate Sequential Energy Losses ---
        # Start with reference and subtract losses in sequence
        e_ref = result['reference_power_kw']

        # After temperature
        e_after_temp = e_ref * (1 + result['temperature_loss_factor'])  # Note: gamma is negative
        result['temp_energy_loss'] = e_ref - e_after_temp

        # After spectral
        e_after_spectral = e_after_temp * result['spectral_modifier']
        result['spectral_energy_loss'] = e_after_temp - e_after_spectral

        # After soiling
        e_after_soiling = e_after_spectral * (1 - result['soiling_loss_factor'])
        result['soiling_energy_loss'] = e_after_spectral - e_after_soiling

        # After inverter
        e_after_inverter = e_after_soiling * result['inverter_efficiency']
        result['inverter_energy_loss'] = e_after_soiling - e_after_inverter

        # After wiring/BOP
        e_after_wiring = e_after_inverter * (1 - result['wiring_bop_loss_factor'])
        result['wiring_energy_loss'] = e_after_inverter - e_after_wiring

        # After degradation
        e_after_degradation = e_after_wiring * (1 - result['degradation_loss_factor'])
        result['degradation_energy_loss'] = e_after_wiring - e_after_degradation

        # After curtailment
        e_net = e_after_degradation * (1 - result['curtailment_loss_factor'])
        result['curtailment_energy_loss'] = e_after_degradation - e_net

        result['net_power_kw'] = e_net
        result['total_loss_kw'] = e_ref - e_net

        self.df_losses = result

        print(f"✅ Loss disaggregation calculated for {len(result)} records")

        return result

    def _merge_curtailment(self, df: pd.DataFrame) -> pd.DataFrame:
        """Merge pre-loaded curtailment data."""
        loader = CurtailmentLoader()
        return loader.merge_with_production(df, self.curtailment_data)

    def get_loss_waterfall(
        self,
        aggregation: str = 'annual',
        df: Optional[pd.DataFrame] = None
    ) -> LossComponents:
        """
        Get aggregated loss waterfall data.

        Parameters:
        -----------
        aggregation : str
            Aggregation period: 'hourly', 'daily', 'monthly', 'annual'
        df : pd.DataFrame, optional
            Data to aggregate (uses self.df_losses if not provided)

        Returns:
        --------
        LossComponents
            Aggregated loss components
        """
        if df is None:
            if self.df_losses is None:
                raise ValueError("No loss data available. Run calculate_all_losses() first.")
            df = self.df_losses

        # Calculate total energy values (kWh)
        # Assuming 15-min data: kW * 0.25h = kWh
        time_factor = 0.25  # 15-min intervals

        ref_energy = (df['reference_power_kw'] * time_factor).sum()
        net_energy = (df['net_power_kw'] * time_factor).sum()

        # Individual energy losses
        temp_loss = (df['temp_energy_loss'].clip(lower=0) * time_factor).sum()
        spectral_loss = (df['spectral_energy_loss'].clip(lower=0) * time_factor).sum()
        soiling_loss = (df['soiling_energy_loss'].clip(lower=0) * time_factor).sum()
        inverter_loss = (df['inverter_energy_loss'].clip(lower=0) * time_factor).sum()
        wiring_loss = (df['wiring_energy_loss'].clip(lower=0) * time_factor).sum()
        degradation_loss = (df['degradation_energy_loss'].clip(lower=0) * time_factor).sum()
        curtailment_loss = (df['curtailment_energy_loss'].clip(lower=0) * time_factor).sum()

        # Calculate percentages (relative to reference)
        if ref_energy > 0:
            temp_pct = temp_loss / ref_energy
            spectral_pct = spectral_loss / ref_energy
            soiling_pct = soiling_loss / ref_energy
            inverter_pct = inverter_loss / ref_energy
            wiring_pct = wiring_loss / ref_energy
            degradation_pct = degradation_loss / ref_energy
            curtailment_pct = curtailment_loss / ref_energy
        else:
            temp_pct = spectral_pct = soiling_pct = 0.0
            inverter_pct = wiring_pct = degradation_pct = curtailment_pct = 0.0

        # Get date range
        if hasattr(df.index, 'min'):
            start_date = str(df.index.min())[:10]
            end_date = str(df.index.max())[:10]
        else:
            start_date = end_date = None

        self.loss_summary = LossComponents(
            soiling_loss_pct=soiling_pct,
            temperature_loss_pct=temp_pct,
            spectral_loss_pct=spectral_pct,
            inverter_loss_pct=inverter_pct,
            wiring_bop_loss_pct=wiring_pct,
            degradation_loss_pct=degradation_pct,
            curtailment_loss_pct=curtailment_pct,
            reference_energy=ref_energy,
            net_energy=net_energy,
            soiling_energy_loss=soiling_loss,
            temperature_energy_loss=temp_loss,
            spectral_energy_loss=spectral_loss,
            inverter_energy_loss=inverter_loss,
            wiring_bop_energy_loss=wiring_loss,
            degradation_energy_loss=degradation_loss,
            curtailment_energy_loss=curtailment_loss,
            aggregation_period=aggregation,
            start_date=start_date,
            end_date=end_date,
        )

        return self.loss_summary

    def generate_loss_summary(self) -> Dict[str, Any]:
        """
        Generate comprehensive loss summary for reporting.

        Returns:
        --------
        Dict
            Summary dictionary for JSON/report generation
        """
        if self.loss_summary is None:
            self.get_loss_waterfall()

        summary = self.loss_summary.to_dict()

        # Add insights
        summary['insights'] = {
            'controllable_loss_pct': round(self.loss_summary.controllable_loss_pct * 100, 2),
            'primary_loss': self._identify_primary_loss(),
            'recommendations': self._generate_recommendations(),
        }

        return summary

    def _identify_primary_loss(self) -> str:
        """Identify the largest loss category."""
        if self.loss_summary is None:
            return 'unknown'

        losses = {
            'soiling': self.loss_summary.soiling_loss_pct,
            'temperature': self.loss_summary.temperature_loss_pct,
            'spectral': self.loss_summary.spectral_loss_pct,
            'inverter': self.loss_summary.inverter_loss_pct,
            'curtailment': self.loss_summary.curtailment_loss_pct,
        }

        return max(losses, key=losses.get)

    def _generate_recommendations(self) -> List[str]:
        """Generate actionable recommendations based on losses."""
        recommendations = []

        if self.loss_summary is None:
            return recommendations

        if self.loss_summary.soiling_loss_pct > 0.03:
            recommendations.append(
                f"High soiling losses ({self.loss_summary.soiling_loss_pct*100:.1f}%): "
                "Consider increasing cleaning frequency"
            )

        if self.loss_summary.curtailment_loss_pct > 0.02:
            recommendations.append(
                f"Significant curtailment ({self.loss_summary.curtailment_loss_pct*100:.1f}%): "
                "Review grid connection capacity or battery storage"
            )

        if self.loss_summary.temperature_loss_pct > 0.05:
            recommendations.append(
                f"High temperature losses ({self.loss_summary.temperature_loss_pct*100:.1f}%): "
                "Consider improved ventilation or module cooling"
            )

        if self.loss_summary.inverter_loss_pct > 0.03:
            recommendations.append(
                f"Inverter losses above typical ({self.loss_summary.inverter_loss_pct*100:.1f}%): "
                "Check inverter sizing and operating conditions"
            )

        if not recommendations:
            recommendations.append("System operating within expected loss parameters")

        return recommendations

    def get_monthly_losses(self) -> pd.DataFrame:
        """
        Get monthly breakdown of losses.

        Returns:
        --------
        pd.DataFrame
            Monthly loss summary
        """
        if self.df_losses is None:
            raise ValueError("No loss data available. Run calculate_all_losses() first.")

        df = self.df_losses.copy()
        df['month'] = df.index.to_period('M')

        time_factor = 0.25  # 15-min intervals

        monthly = df.groupby('month').agg({
            'reference_power_kw': lambda x: (x * time_factor).sum(),
            'net_power_kw': lambda x: (x * time_factor).sum(),
            'temp_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
            'spectral_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
            'soiling_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
            'inverter_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
            'wiring_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
            'degradation_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
            'curtailment_energy_loss': lambda x: (x.clip(lower=0) * time_factor).sum(),
        }).rename(columns={
            'reference_power_kw': 'reference_energy_kwh',
            'net_power_kw': 'net_energy_kwh',
            'temp_energy_loss': 'temp_loss_kwh',
            'spectral_energy_loss': 'spectral_loss_kwh',
            'soiling_energy_loss': 'soiling_loss_kwh',
            'inverter_energy_loss': 'inverter_loss_kwh',
            'wiring_energy_loss': 'wiring_loss_kwh',
            'degradation_energy_loss': 'degradation_loss_kwh',
            'curtailment_energy_loss': 'curtailment_loss_kwh',
        })

        monthly.index = monthly.index.astype(str)

        return monthly

    # =========================================================================
    # Enhanced methods for smart soiling estimation without DustIQ
    # =========================================================================

    def identify_rain_reset_points(
        self,
        rainfall_data: pd.Series,
        heavy_threshold_mm: float = 10.0,
        moderate_threshold_mm: float = 5.0,
    ) -> pd.DataFrame:
        """
        Find heavy rain events where SR should reset to ~1.0.

        Rain events serve as "anchor points" for soiling ratio calibration
        since heavy rain cleans panels and resets SR close to 1.0.

        Parameters:
        -----------
        rainfall_data : pd.Series
            Daily rainfall in mm, indexed by date
        heavy_threshold_mm : float
            Rainfall threshold for SR=1.0 reset (default 10mm)
        moderate_threshold_mm : float
            Rainfall threshold for partial reset (default 5mm)

        Returns:
        --------
        pd.DataFrame
            Rain anchor points with columns:
            - date: Rain event date
            - rainfall_mm: Rainfall amount
            - anchor_sr: Expected SR after rain (0.995-1.0)
            - confidence: Confidence in anchor (0.7-1.0)
        """
        anchors = []

        for date, rain_mm in rainfall_data.items():
            if rain_mm >= heavy_threshold_mm:
                # Heavy rain: high confidence SR reset
                anchors.append({
                    'date': date,
                    'rainfall_mm': float(rain_mm),
                    'anchor_sr': 0.995,  # Not quite 1.0 due to some residual
                    'confidence': 0.95,
                    'event_type': 'heavy_rain',
                })
            elif rain_mm >= moderate_threshold_mm:
                # Moderate rain: partial reset
                anchors.append({
                    'date': date,
                    'rainfall_mm': float(rain_mm),
                    'anchor_sr': 0.98,  # Partial cleaning
                    'confidence': 0.7,
                    'event_type': 'moderate_rain',
                })

        if not anchors:
            return pd.DataFrame(columns=['date', 'rainfall_mm', 'anchor_sr', 'confidence', 'event_type'])

        df_anchors = pd.DataFrame(anchors)
        df_anchors['date'] = pd.to_datetime(df_anchors['date'])

        print(f"  Identified {len(anchors)} rain anchor points")
        print(f"    Heavy rain (>{heavy_threshold_mm}mm): {(df_anchors['event_type'] == 'heavy_rain').sum()}")
        print(f"    Moderate rain (>{moderate_threshold_mm}mm): {(df_anchors['event_type'] == 'moderate_rain').sum()}")

        return df_anchors

    def calibrate_with_rain_anchors(
        self,
        sr_estimate: pd.Series,
        rain_anchors: pd.DataFrame,
        decay_rate_per_day: float = 0.002,
    ) -> pd.Series:
        """
        Adjust SR estimates using rain reset anchor points.

        After heavy rain, SR should be near 1.0 and then decay gradually
        due to dust accumulation. This method constrains the SR estimate
        based on known rain events.

        Parameters:
        -----------
        sr_estimate : pd.Series
            Initial SR estimates (e.g., from foundation model or disaggregation)
        rain_anchors : pd.DataFrame
            Rain anchor points from identify_rain_reset_points()
        decay_rate_per_day : float
            SR decay rate per day without rain (default 0.002 = 0.2%/day)

        Returns:
        --------
        pd.Series
            Calibrated SR estimates
        """
        if rain_anchors.empty:
            print("  No rain anchors available, returning original estimate")
            return sr_estimate

        sr_calibrated = sr_estimate.copy()

        # Sort anchors by date
        rain_anchors = rain_anchors.sort_values('date')

        # For each day, find the most recent rain anchor and apply decay
        for date in sr_calibrated.index:
            # Find most recent rain before or on this date
            prior_anchors = rain_anchors[rain_anchors['date'] <= date]

            if prior_anchors.empty:
                continue

            latest_anchor = prior_anchors.iloc[-1]
            days_since_rain = (pd.to_datetime(date) - latest_anchor['date']).days

            if days_since_rain < 0:
                continue

            # Calculate expected SR based on decay from anchor
            expected_sr = latest_anchor['anchor_sr'] - (decay_rate_per_day * days_since_rain)
            expected_sr = max(0.7, expected_sr)  # Floor at 0.7

            # Apply constraint: SR cannot be higher than decayed anchor value
            # (panels can only get dirtier without rain)
            if sr_calibrated.loc[date] > expected_sr:
                sr_calibrated.loc[date] = expected_sr

        # Smooth to remove discontinuities
        sr_calibrated = sr_calibrated.rolling(window=3, center=True, min_periods=1).mean()

        print(f"  Rain-calibrated SR: mean adjustment = {(sr_calibrated - sr_estimate).mean():.4f}")

        return sr_calibrated

    def enforce_fleet_consistency(
        self,
        inverter_sr_estimates: Dict[str, pd.Series],
        method: str = 'median',
        outlier_threshold: float = 0.05,
    ) -> Tuple[pd.Series, Dict[str, pd.Series]]:
        """
        Ensure soiling estimate is consistent across inverters.

        Soiling affects the entire array similarly (it's a site-level phenomenon),
        so inverter-level SR estimates should be similar. Large deviations suggest
        other issues (shading, equipment problems) not soiling.

        Parameters:
        -----------
        inverter_sr_estimates : Dict[str, pd.Series]
            SR estimates per inverter, keyed by inverter ID
        method : str
            Aggregation method: 'median' (robust), 'mean', 'min' (conservative)
        outlier_threshold : float
            Deviation threshold for flagging outliers (default 5%)

        Returns:
        --------
        Tuple[pd.Series, Dict[str, pd.Series]]
            (fleet_sr, outlier_flags_per_inverter)
        """
        if not inverter_sr_estimates:
            raise ValueError("No inverter SR estimates provided")

        # Align all series to common index
        common_index = None
        for sr in inverter_sr_estimates.values():
            if common_index is None:
                common_index = sr.index
            else:
                common_index = common_index.intersection(sr.index)

        # Stack all inverter estimates
        sr_matrix = pd.DataFrame({
            inv_id: sr.loc[common_index]
            for inv_id, sr in inverter_sr_estimates.items()
        })

        # Calculate fleet-level SR
        if method == 'median':
            fleet_sr = sr_matrix.median(axis=1)
        elif method == 'mean':
            fleet_sr = sr_matrix.mean(axis=1)
        elif method == 'min':
            fleet_sr = sr_matrix.min(axis=1)  # Most conservative
        else:
            fleet_sr = sr_matrix.median(axis=1)

        # Identify outliers (inverters with SR significantly different from fleet)
        outlier_flags = {}
        for inv_id in sr_matrix.columns:
            deviation = sr_matrix[inv_id] - fleet_sr
            outlier_flags[inv_id] = (deviation.abs() > outlier_threshold).astype(int)

        # Count outliers
        n_outliers = sum(flags.sum() for flags in outlier_flags.values())
        total_points = len(common_index) * len(sr_matrix.columns)

        print(f"  Fleet consistency analysis:")
        print(f"    Inverters: {len(sr_matrix.columns)}")
        print(f"    Fleet SR range: [{fleet_sr.min():.3f}, {fleet_sr.max():.3f}]")
        print(f"    Outlier points: {n_outliers}/{total_points} ({n_outliers/total_points*100:.1f}%)")

        return fleet_sr, outlier_flags

    def separate_soiling_from_shading(
        self,
        performance_ratio: pd.Series,
        timestamps: pd.DatetimeIndex,
        min_daily_pattern_strength: float = 0.02,
    ) -> Tuple[pd.Series, pd.Series]:
        """
        Separate soiling losses from shading losses using time-of-day patterns.

        Shading has a strong time-of-day signature (morning/evening dips),
        while soiling is relatively constant throughout the day.

        Parameters:
        -----------
        performance_ratio : pd.Series
            Performance ratio (actual/expected power), sub-daily resolution
        timestamps : pd.DatetimeIndex
            Timestamps for the performance ratio data
        min_daily_pattern_strength : float
            Minimum amplitude of daily pattern to attribute to shading

        Returns:
        --------
        Tuple[pd.Series, pd.Series]
            (soiling_loss, shading_loss) as fractions
        """
        df = pd.DataFrame({
            'pr': performance_ratio,
            'hour': timestamps.hour,
            'date': timestamps.date,
        }, index=timestamps)

        # Calculate daily mean PR (soiling baseline)
        daily_mean_pr = df.groupby('date')['pr'].mean()

        # Calculate hourly deviations from daily mean (shading pattern)
        hourly_pr = df.groupby('hour')['pr'].mean()
        hourly_deviation = hourly_pr - hourly_pr.mean()

        # Shading pattern: morning/evening dips relative to midday
        # Strong shading shows low PR in early morning and late afternoon
        midday_hours = [10, 11, 12, 13, 14]
        edge_hours = [7, 8, 17, 18]

        if all(h in hourly_pr.index for h in midday_hours + edge_hours):
            midday_pr = hourly_pr.loc[midday_hours].mean()
            edge_pr = hourly_pr.loc[edge_hours].mean()
            daily_pattern_amplitude = midday_pr - edge_pr
        else:
            daily_pattern_amplitude = 0.0

        # Separate losses
        if daily_pattern_amplitude > min_daily_pattern_strength:
            # Shading detected: attribute time-varying component to shading
            shading_loss_pattern = (hourly_deviation.clip(upper=0).abs())  # Only dips
            avg_shading_loss = shading_loss_pattern.mean()

            # Remaining uniform loss is soiling + degradation
            soiling_loss = (1 - daily_mean_pr) - avg_shading_loss
            soiling_loss = soiling_loss.clip(lower=0)

            # Broadcast to full resolution
            shading_loss = df['hour'].map(shading_loss_pattern).fillna(0)
            soiling_loss_full = pd.Series(
                df.groupby('date')['pr'].transform('mean').rsub(1) - shading_loss,
                index=timestamps
            ).clip(lower=0)
        else:
            # No significant shading pattern: all loss attributed to soiling
            shading_loss = pd.Series(0.0, index=timestamps)
            soiling_loss_full = (1 - performance_ratio).clip(lower=0)

        print(f"  Soiling vs Shading separation:")
        print(f"    Daily pattern amplitude: {daily_pattern_amplitude:.3f}")
        print(f"    Avg soiling loss: {soiling_loss_full.mean():.3f}")
        print(f"    Avg shading loss: {shading_loss.mean():.3f}")

        return soiling_loss_full, shading_loss

    def estimate_soiling_without_dustiq(
        self,
        df: pd.DataFrame,
        rainfall_col: str = 'rainfall_mm',
        pr_col: str = 'performance_ratio',
        inverter_cols: Optional[List[str]] = None,
        use_rain_calibration: bool = True,
        use_fleet_consistency: bool = True,
        use_shading_separation: bool = True,
    ) -> pd.DataFrame:
        """
        Comprehensive soiling estimation for plants without DustIQ sensors.

        Combines multiple methods:
        1. Loss disaggregation to isolate soiling component
        2. Rain calibration anchors for SR reset points
        3. Fleet consistency to remove inverter-specific issues
        4. Shading separation to isolate uniform soiling loss

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with power, irradiance, temperature, rainfall
        rainfall_col : str
            Column name for daily rainfall (mm)
        pr_col : str
            Column name for performance ratio
        inverter_cols : List[str], optional
            Column names for per-inverter power (for fleet consistency)
        use_rain_calibration : bool
            Apply rain-based SR anchoring
        use_fleet_consistency : bool
            Apply multi-inverter consistency check
        use_shading_separation : bool
            Separate shading from soiling losses

        Returns:
        --------
        pd.DataFrame
            Input data with added columns:
            - soiling_ratio_estimated: Estimated SR
            - soiling_confidence: Confidence level
            - soiling_method: Method used for estimation
        """
        result = df.copy()

        # Step 1: Initial SR estimate from loss disaggregation
        # Start with 1 - soiling_loss_factor
        if 'soiling_loss_factor' in result.columns:
            sr_initial = 1 - result['soiling_loss_factor']
        elif pr_col in result.columns:
            # Use PR as initial estimate (crude but better than nothing)
            sr_initial = result[pr_col].clip(0.7, 1.0)
        else:
            sr_initial = pd.Series(0.95, index=result.index)

        sr_estimate = sr_initial.copy()
        method = "disaggregation"

        # Step 2: Rain calibration
        if use_rain_calibration and rainfall_col in result.columns:
            # Aggregate to daily for rain anchor identification
            daily_rain = result[rainfall_col].resample('D').sum()
            rain_anchors = self.identify_rain_reset_points(daily_rain)

            if not rain_anchors.empty:
                # Resample SR to daily, calibrate, then broadcast back
                sr_daily = sr_estimate.resample('D').mean()
                sr_daily_calibrated = self.calibrate_with_rain_anchors(sr_daily, rain_anchors)

                # Broadcast daily calibrated SR back to sub-daily
                sr_estimate = sr_daily_calibrated.reindex(result.index, method='ffill')
                method = "rain_calibrated"

        # Step 3: Fleet consistency (if per-inverter data available)
        if use_fleet_consistency and inverter_cols:
            # Calculate SR per inverter
            inverter_sr = {}
            for col in inverter_cols:
                if col in result.columns:
                    # Simple PR-based SR estimate per inverter
                    inverter_sr[col] = result[col].clip(0.7, 1.0)

            if len(inverter_sr) > 1:
                fleet_sr, outlier_flags = self.enforce_fleet_consistency(inverter_sr)
                sr_estimate = fleet_sr
                result['soiling_outlier_flag'] = 0
                for inv_id, flags in outlier_flags.items():
                    result['soiling_outlier_flag'] += flags
                method = "fleet_consistent"

        # Step 4: Shading separation
        if use_shading_separation and pr_col in result.columns:
            soiling_loss, shading_loss = self.separate_soiling_from_shading(
                result[pr_col],
                result.index,
            )
            # Update SR estimate using isolated soiling component
            sr_from_separation = (1 - soiling_loss).clip(0.7, 1.0)

            # Blend with previous estimate (weighted average)
            sr_estimate = 0.7 * sr_estimate + 0.3 * sr_from_separation
            result['shading_loss'] = shading_loss
            method = "shading_separated"

        # Store results
        result['soiling_ratio_estimated'] = sr_estimate.clip(0.7, 1.0)
        result['soiling_confidence'] = 0.7  # Moderate confidence without DustIQ
        result['soiling_method'] = method

        print(f"\n  Soiling estimation complete:")
        print(f"    Method: {method}")
        print(f"    SR range: [{result['soiling_ratio_estimated'].min():.3f}, "
              f"{result['soiling_ratio_estimated'].max():.3f}]")
        print(f"    Mean SR: {result['soiling_ratio_estimated'].mean():.3f}")

        return result
