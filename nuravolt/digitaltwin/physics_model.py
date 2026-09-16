"""
PVWatts Physics Model for Solar PV Digital Twins

Implements physics-based power prediction using PVWatts methodology
with Sandia cell temperature model.

The physics model answers: "What power SHOULD this inverter produce
given current conditions?" based on:
- Irradiance (GHI or POA)
- Ambient temperature
- Wind speed (optional)
- System parameters (capacity, tilt, azimuth, etc.)

NO power lag features are used - this is a pure physics model.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple, Union
import logging
import json
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class CalibrationScaleError(ValueError):
    """Physics calibration factor implies a unit mismatch, not a model error.

    Raised by :meth:`PVWattsPhysicsModel.calibrate` when the measured-vs-predicted
    ratio falls outside [0.5, 1.5]. Callers that can tolerate an uncalibrated
    model should catch this explicitly rather than relying on a silent fallback.
    """

# Try importing pvlib for advanced calculations
try:
    import pvlib
    from pvlib import pvsystem, inverter, temperature
    PVLIB_AVAILABLE = True
except ImportError:
    PVLIB_AVAILABLE = False
    logger.warning("pvlib not available, using simplified physics model")


@dataclass
class SystemParams:
    """PV system parameters for physics model."""
    # System capacity
    capacity_kw: float = 100.0          # DC nameplate capacity (kW)

    # Location
    latitude: float = 0.0
    longitude: float = 0.0
    altitude: float = 0.0               # meters

    # Array configuration
    tilt: float = 0.0                   # degrees from horizontal
    azimuth: float = 180.0              # degrees, 180 = south

    # Module parameters
    module_type: str = 'monocrystalline'  # or 'polycrystalline', 'thin_film'
    gamma_pdc: float = -0.004           # Temperature coefficient (%/°C)
    t_noct: float = 45.0                # Nominal operating cell temp (°C)

    # Cell temperature model parameters (Sandia)
    a: float = -3.47                    # Glass/cell/glass
    b: float = -0.0594                  # Wind coefficient
    delta_t: float = 3.0                # Cell-module temp difference

    # Inverter parameters
    inverter_efficiency: float = 0.96   # Peak efficiency
    dc_ac_ratio: float = 1.2            # DC/AC sizing ratio

    # System losses (fraction)
    soiling_loss: float = 0.02          # 2% typical
    shading_loss: float = 0.01          # 1% typical
    mismatch_loss: float = 0.02         # 2% typical
    wiring_loss: float = 0.02           # 2% typical
    availability_loss: float = 0.01     # 1% typical

    @property
    def total_losses(self) -> float:
        """Calculate total system losses."""
        return (
            self.soiling_loss +
            self.shading_loss +
            self.mismatch_loss +
            self.wiring_loss +
            self.availability_loss
        )

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> 'SystemParams':
        """Create from dictionary."""
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class InverterParams:
    """Inverter efficiency model parameters (Sandia/CEC model)."""
    pdc0: float = 100.0                 # DC power rating (kW)
    eta_inv_nom: float = 0.96           # Nominal efficiency
    eta_inv_ref: float = 0.9637         # Reference efficiency

    # Sandia inverter model coefficients (typical)
    c0: float = -4.35e-5                # Self-consumption coefficient
    c1: float = -2.11e-4                # Linear efficiency coefficient
    c2: float = 8.97e-4                 # Quadratic efficiency coefficient
    c3: float = -2.45e-4                # Cubic efficiency coefficient


class PVWattsPhysicsModel:
    """
    PVWatts-style physics model for expected power prediction.

    Predicts AC power output based on:
    - Plane-of-array irradiance
    - Cell temperature (calculated from ambient + irradiance + wind)
    - System parameters and losses

    This is a pure physics model with NO power-derived features.
    """

    def __init__(
        self,
        system: Optional[SystemParams] = None,
        inverter: Optional[InverterParams] = None,
        calibration_factor: float = 1.0,
    ):
        """
        Initialize PVWatts physics model.

        Parameters:
        -----------
        system : SystemParams
            PV system parameters
        inverter : InverterParams
            Inverter efficiency parameters
        calibration_factor : float
            Site-specific calibration factor (from historical data)
        """
        self.system = system or SystemParams()
        self.inverter = inverter or InverterParams(pdc0=self.system.capacity_kw)
        self.calibration_factor = calibration_factor

        # Update inverter rating to match system
        if self.inverter.pdc0 != self.system.capacity_kw:
            self.inverter.pdc0 = self.system.capacity_kw

    def calculate_cell_temperature(
        self,
        poa_irradiance: np.ndarray,
        ambient_temp: np.ndarray,
        wind_speed: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """
        Calculate cell temperature using Sandia model.

        T_cell = G_poa * exp(a + b * wind_speed) + T_amb

        Parameters:
        -----------
        poa_irradiance : np.ndarray
            Plane-of-array irradiance (W/m²)
        ambient_temp : np.ndarray
            Ambient temperature (°C)
        wind_speed : np.ndarray
            Wind speed at module height (m/s)

        Returns:
        --------
        np.ndarray
            Cell temperature (°C)
        """
        poa = np.asarray(poa_irradiance)
        t_amb = np.asarray(ambient_temp)

        if wind_speed is None:
            wind = np.ones_like(poa)  # Default 1 m/s
        else:
            wind = np.asarray(wind_speed)

        # Sandia cell temperature model
        a = self.system.a
        b = self.system.b

        t_cell = poa * np.exp(a + b * wind) + t_amb + self.system.delta_t

        return t_cell

    def calculate_cell_temperature_noct(
        self,
        poa_irradiance: np.ndarray,
        ambient_temp: np.ndarray,
    ) -> np.ndarray:
        """
        Calculate cell temperature using simple NOCT model.

        T_cell = T_amb + (G_poa / 800) * (T_noct - 20)

        Parameters:
        -----------
        poa_irradiance : np.ndarray
            Plane-of-array irradiance (W/m²)
        ambient_temp : np.ndarray
            Ambient temperature (°C)

        Returns:
        --------
        np.ndarray
            Cell temperature (°C)
        """
        poa = np.asarray(poa_irradiance)
        t_amb = np.asarray(ambient_temp)

        t_cell = t_amb + (poa / 800) * (self.system.t_noct - 20)

        return t_cell

    def calculate_dc_power(
        self,
        poa_irradiance: np.ndarray,
        cell_temperature: np.ndarray,
    ) -> np.ndarray:
        """
        Calculate DC power at maximum power point.

        For irradiance >= 125 W/m²:
            P_dc = (G / 1000) * P_stc * [1 + γ * (T_cell - 25)]

        For irradiance < 125 W/m² (low light):
            P_dc = 0.5 * (G / 1000) * P_stc * [1 + γ * (T_cell - 25)]

        Parameters:
        -----------
        poa_irradiance : np.ndarray
            Plane-of-array irradiance (W/m²)
        cell_temperature : np.ndarray
            Cell temperature (°C)

        Returns:
        --------
        np.ndarray
            DC power (kW)
        """
        poa = np.asarray(poa_irradiance)
        t_cell = np.asarray(cell_temperature)

        # Temperature correction factor
        temp_factor = 1 + self.system.gamma_pdc * (t_cell - 25)

        # Normalized irradiance
        g_norm = poa / 1000.0

        # DC power with low-light efficiency reduction
        p_dc = np.where(
            poa >= 125,
            g_norm * self.system.capacity_kw * temp_factor,
            0.5 * g_norm * self.system.capacity_kw * temp_factor
        )

        # Apply system losses
        p_dc = p_dc * (1 - self.system.total_losses)

        # Non-negative
        p_dc = np.maximum(p_dc, 0)

        return p_dc

    def calculate_inverter_efficiency(
        self,
        p_dc: np.ndarray,
    ) -> np.ndarray:
        """
        Calculate inverter efficiency using Sandia model.

        Parameters:
        -----------
        p_dc : np.ndarray
            DC power input to inverter (kW)

        Returns:
        --------
        np.ndarray
            Inverter efficiency (0-1)
        """
        p_dc = np.asarray(p_dc)

        # Normalized power
        p_norm = p_dc / self.inverter.pdc0

        # Sandia inverter model
        # η = η_nom * (1 + c0*(1-p) + c1*(1-p)² + c2*p + c3*p²)
        c0 = self.inverter.c0
        c1 = self.inverter.c1
        c2 = self.inverter.c2
        c3 = self.inverter.c3

        eta_correction = (
            1 +
            c0 * (1 - p_norm) +
            c1 * (1 - p_norm) ** 2 +
            c2 * p_norm +
            c3 * p_norm ** 2
        )

        eta = self.inverter.eta_inv_nom * eta_correction

        # Clamp efficiency
        eta = np.clip(eta, 0.0, 0.99)

        # Zero efficiency at very low power
        eta = np.where(p_norm < 0.01, 0.0, eta)

        return eta

    def calculate_ac_power(
        self,
        p_dc: np.ndarray,
    ) -> np.ndarray:
        """
        Calculate AC power output.

        Parameters:
        -----------
        p_dc : np.ndarray
            DC power (kW)

        Returns:
        --------
        np.ndarray
            AC power (kW)
        """
        p_dc = np.asarray(p_dc)

        # Get inverter efficiency
        eta_inv = self.calculate_inverter_efficiency(p_dc)

        # AC power
        p_ac = p_dc * eta_inv

        # Clip to AC rating
        ac_rating = self.system.capacity_kw / self.system.dc_ac_ratio
        p_ac = np.minimum(p_ac, ac_rating)

        # Non-negative
        p_ac = np.maximum(p_ac, 0)

        return p_ac

    def predict(
        self,
        df: pd.DataFrame,
        irradiance_col: str = 'irradiance',
        temperature_col: str = 'temperature',
        wind_col: Optional[str] = 'wind_speed',
        return_components: bool = False,
    ) -> Union[np.ndarray, Dict[str, np.ndarray]]:
        """
        Predict expected AC power.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with irradiance and temperature
        irradiance_col : str
            Irradiance column name
        temperature_col : str
            Ambient temperature column name
        wind_col : str
            Wind speed column name (optional)
        return_components : bool
            If True, return dict with intermediate calculations

        Returns:
        --------
        np.ndarray or Dict
            Predicted AC power (kW), or dict with components
        """
        # Get input arrays
        poa = df[irradiance_col].values if irradiance_col in df.columns else np.zeros(len(df))
        t_amb = df[temperature_col].values if temperature_col in df.columns else np.full(len(df), 25.0)

        if wind_col and wind_col in df.columns:
            wind = df[wind_col].fillna(1.0).values
        else:
            wind = None

        # Calculate cell temperature
        if wind is not None:
            t_cell = self.calculate_cell_temperature(poa, t_amb, wind)
        else:
            t_cell = self.calculate_cell_temperature_noct(poa, t_amb)

        # Calculate DC power
        p_dc = self.calculate_dc_power(poa, t_cell)

        # Calculate AC power
        p_ac = self.calculate_ac_power(p_dc)

        # Apply calibration factor
        p_ac = p_ac * self.calibration_factor

        if return_components:
            return {
                'p_ac': p_ac,
                'p_dc': p_dc,
                't_cell': t_cell,
                'poa': poa,
                't_amb': t_amb,
            }

        return p_ac

    def calibrate(
        self,
        df: pd.DataFrame,
        power_col: str = 'power',
        irradiance_col: str = 'irradiance',
        temperature_col: str = 'temperature',
        min_irradiance: float = 200.0,
        max_irradiance: float = 1000.0,
    ) -> float:
        """
        Calibrate model to measured data.

        Finds a calibration factor to match measured performance.

        Parameters:
        -----------
        df : pd.DataFrame
            Historical data with measured power
        power_col : str
            Measured power column
        irradiance_col : str
            Irradiance column
        temperature_col : str
            Temperature column
        min_irradiance : float
            Minimum irradiance for calibration (W/m²)
        max_irradiance : float
            Maximum irradiance for calibration (W/m²)

        Returns:
        --------
        float
            Calibration factor
        """
        # Filter to good conditions
        irr = df[irradiance_col].values
        mask = (irr >= min_irradiance) & (irr <= max_irradiance)

        if mask.sum() < 100:
            logger.warning("Not enough data for calibration")
            return 1.0

        # Predict with uncalibrated model
        old_calibration = self.calibration_factor
        self.calibration_factor = 1.0

        p_pred = self.predict(df[mask], irradiance_col, temperature_col)
        p_actual = df[mask][power_col].values

        # Calculate calibration factor
        # Simple ratio of sums (robust to outliers)
        with np.errstate(divide='ignore', invalid='ignore'):
            factor = np.sum(p_actual[p_pred > 0]) / np.sum(p_pred[p_pred > 0])

        # Sanity check.
        #
        # A calibration factor far from 1.0 is almost never a model-quality
        # problem -- it means `power_col` and `capacity_kw` are expressed in
        # different units (e.g. a per-unit kW/kWp column scored against a
        # physics model built at plant nameplate kW). Silently resetting to
        # 1.0 here is what let eight `hybrid_model_metrics.json` artifacts
        # ship with physics_r2 of roughly -13,000: the reset hid a ~0.02
        # factor, so the ML learned the physics curve as a "residual" and
        # every downstream accuracy number was meaningless. Fail loudly.
        if np.isnan(factor) or not (0.5 <= factor <= 1.5):
            self.calibration_factor = old_calibration
            raise CalibrationScaleError(
                f"Calibration factor {factor:.4g} is outside [0.5, 1.5]. "
                f"This almost always means the measured power column "
                f"({power_col!r}, median {np.nanmedian(p_actual):.4g}) and "
                f"capacity_kw={self.system.capacity_kw} disagree on units -- "
                f"check for a per-unit (kW/kWp) column being scored against a "
                f"nameplate-kW physics model. Refusing to fall back to 1.0."
            )

        logger.info(f"Calibration factor: {factor:.4f}")
        self.calibration_factor = factor

        return factor

    def get_theoretical_max(
        self,
        irradiance: np.ndarray,
    ) -> np.ndarray:
        """
        Get theoretical maximum power for given irradiance.

        Parameters:
        -----------
        irradiance : np.ndarray
            Irradiance (W/m²)

        Returns:
        --------
        np.ndarray
            Theoretical maximum power (kW)
        """
        g = np.asarray(irradiance)
        return (g / 1000) * self.system.capacity_kw * self.system.inverter_efficiency

    def to_dict(self) -> Dict[str, Any]:
        """Export model parameters to dictionary."""
        return {
            'system': {
                'capacity_kw': self.system.capacity_kw,
                'latitude': self.system.latitude,
                'longitude': self.system.longitude,
                'tilt': self.system.tilt,
                'azimuth': self.system.azimuth,
                'gamma_pdc': self.system.gamma_pdc,
                't_noct': self.system.t_noct,
                'total_losses': self.system.total_losses,
            },
            'inverter': {
                'pdc0': self.inverter.pdc0,
                'eta_inv_nom': self.inverter.eta_inv_nom,
            },
            'calibration_factor': self.calibration_factor,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> 'PVWattsPhysicsModel':
        """Create model from dictionary."""
        system = SystemParams.from_dict(d.get('system', {}))
        inverter = InverterParams(**d.get('inverter', {}))
        calibration = d.get('calibration_factor', 1.0)

        return cls(system=system, inverter=inverter, calibration_factor=calibration)


def create_physics_model(
    capacity_kw: float,
    latitude: float = 0.0,
    longitude: float = 0.0,
    tilt: float = 0.0,
    azimuth: float = 180.0,
    gamma_pdc: float = -0.004,
) -> PVWattsPhysicsModel:
    """
    Create a physics model with given parameters.

    Parameters:
    -----------
    capacity_kw : float
        DC nameplate capacity (kW)
    latitude : float
        Location latitude
    longitude : float
        Location longitude
    tilt : float
        Array tilt angle (degrees)
    azimuth : float
        Array azimuth (degrees, 180 = south)
    gamma_pdc : float
        Temperature coefficient (%/°C)

    Returns:
    --------
    PVWattsPhysicsModel
        Configured physics model
    """
    system = SystemParams(
        capacity_kw=capacity_kw,
        latitude=latitude,
        longitude=longitude,
        tilt=tilt,
        azimuth=azimuth,
        gamma_pdc=gamma_pdc,
    )

    return PVWattsPhysicsModel(system=system)


def estimate_system_params(
    df: pd.DataFrame,
    power_col: str = 'power',
    irradiance_col: str = 'irradiance',
) -> SystemParams:
    """
    Estimate system parameters from historical data.

    Parameters:
    -----------
    df : pd.DataFrame
        Historical data
    power_col : str
        Power column name
    irradiance_col : str
        Irradiance column name

    Returns:
    --------
    SystemParams
        Estimated parameters
    """
    # Estimate capacity from max power
    max_power = df[power_col].max()

    # At high irradiance, assume ~90% of capacity
    high_irr_mask = df[irradiance_col] > 900
    if high_irr_mask.sum() > 0:
        capacity_kw = df[high_irr_mask][power_col].quantile(0.95) / 0.9
    else:
        capacity_kw = max_power / 0.85

    logger.info(f"Estimated capacity: {capacity_kw:.1f} kW")

    return SystemParams(capacity_kw=capacity_kw)
