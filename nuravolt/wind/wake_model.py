"""
Wake Effect Modeling Module

Wind farm wake modeling for power production estimation and layout optimization.
Supports simple Jensen model and integration with FLORIS/PyWake for production use.

Reference: Jensen/Park model, Bastankhah Gaussian model
"""

from dataclasses import dataclass
from typing import Optional, Callable, List
import numpy as np


@dataclass
class TurbinePosition:
    """Wind turbine position in farm coordinates"""
    x: float  # meters (East)
    y: float  # meters (North)
    hub_height: float = 90.0  # meters
    rotor_diameter: float = 126.0  # meters
    turbine_id: str = ""


@dataclass
class WakeResult:
    """Result from wake calculation"""
    total_power_kw: float
    turbine_powers: List[float]
    wake_losses_pct: float
    effective_wind_speeds: List[float]
    no_wake_power_kw: float


class SimpleJensenWake:
    """
    Jensen/Park wake model - simplest analytical wake model.

    Good for quick estimates, educational purposes, and when
    PyWake/FLORIS are not available.

    The model assumes a top-hat velocity deficit profile that
    expands linearly downstream.

    Example:
        wake = SimpleJensenWake(wake_decay=0.04)
        deficit = wake.velocity_deficit(
            x_downstream=500,  # meters
            rotor_diameter=126
        )
        wake_speed = freestream * (1 - deficit)
    """

    def __init__(self, wake_decay: float = 0.04):
        """
        Args:
            wake_decay: Wake expansion coefficient
                - Offshore: ~0.04 (lower turbulence)
                - Onshore: ~0.075 (higher turbulence)
        """
        self.k = wake_decay

    def velocity_deficit(
        self,
        x_downstream: float,
        rotor_diameter: float,
        thrust_coefficient: float = 0.8
    ) -> float:
        """
        Calculate velocity deficit at distance x downstream.

        Args:
            x_downstream: Distance downstream in meters
            rotor_diameter: Rotor diameter in meters
            thrust_coefficient: Turbine thrust coefficient (0.8 typical)

        Returns:
            Deficit ratio (0-1), multiply by freestream to get wake speed reduction
        """
        if x_downstream <= 0:
            return 0.0

        # Wake diameter expands linearly
        wake_diameter = rotor_diameter + 2 * self.k * x_downstream

        # Jensen velocity deficit formula
        deficit = (
            (1 - np.sqrt(1 - thrust_coefficient))
            * (rotor_diameter / wake_diameter) ** 2
        )

        return float(min(deficit, 1.0))

    def wake_speed(
        self,
        freestream_speed: float,
        x_downstream: float,
        rotor_diameter: float,
        thrust_coefficient: float = 0.8
    ) -> float:
        """
        Calculate wind speed in wake.

        Args:
            freestream_speed: Undisturbed wind speed (m/s)
            x_downstream: Distance downstream (m)
            rotor_diameter: Rotor diameter (m)
            thrust_coefficient: Turbine thrust coefficient

        Returns:
            Wind speed in wake (m/s)
        """
        deficit = self.velocity_deficit(
            x_downstream, rotor_diameter, thrust_coefficient
        )
        return freestream_speed * (1 - deficit)

    def wake_radius(
        self,
        x_downstream: float,
        rotor_diameter: float
    ) -> float:
        """
        Calculate wake radius at given downstream distance.

        Args:
            x_downstream: Distance downstream (m)
            rotor_diameter: Rotor diameter (m)

        Returns:
            Wake radius (m)
        """
        return rotor_diameter / 2 + self.k * x_downstream


class WakeFarmModel:
    """
    Wind farm wake model for multi-turbine arrays.

    Calculates effective wind speeds and power production accounting
    for wake interactions between turbines.

    Supports multiple backends:
    - 'simple': Built-in Jensen model (no dependencies)
    - 'floris': NREL FLORIS (pip install floris)
    - 'pywake': DTU PyWake (pip install py_wake)

    Example:
        positions = [
            TurbinePosition(x=0, y=0, turbine_id='T1'),
            TurbinePosition(x=500, y=0, turbine_id='T2'),
            TurbinePosition(x=1000, y=0, turbine_id='T3'),
        ]

        farm = WakeFarmModel(positions)

        def power_curve(ws):
            # Cubic relationship below rated
            return min(3000, 0.5 * 1.225 * 12469 * ws**3 / 1000)

        result = farm.calculate_farm_power(
            wind_speed=10.0,
            wind_direction=270,  # West wind
            turbine_power_curve=power_curve
        )
        print(f"Wake losses: {result.wake_losses_pct:.1f}%")
    """

    def __init__(
        self,
        turbine_positions: List[TurbinePosition],
        backend: str = 'simple',
        wake_decay: float = 0.04
    ):
        """
        Initialize farm wake model.

        Args:
            turbine_positions: List of turbine positions
            backend: 'simple', 'floris', or 'pywake'
            wake_decay: Wake decay coefficient (for simple backend)
        """
        self.positions = turbine_positions
        self.x = np.array([t.x for t in turbine_positions])
        self.y = np.array([t.y for t in turbine_positions])
        self.n_turbines = len(turbine_positions)

        self.backend = backend
        self.wake_model = SimpleJensenWake(wake_decay=wake_decay)

        # Check for external backends
        self._floris = None
        self._pywake = None

        if backend == 'floris':
            try:
                from floris import FlorisModel
                self._floris = FlorisModel
            except ImportError:
                raise ImportError(
                    "FLORIS not available. Install with: pip install floris"
                )
        elif backend == 'pywake':
            try:
                import py_wake
                self._pywake = py_wake
            except ImportError:
                raise ImportError(
                    "PyWake not available. Install with: pip install py_wake"
                )

    def calculate_farm_power(
        self,
        wind_speed: float,
        wind_direction: float,
        turbine_power_curve: Callable[[float], float],
        thrust_coefficient: float = 0.8
    ) -> WakeResult:
        """
        Calculate total farm power accounting for wakes.

        Args:
            wind_speed: Freestream wind speed (m/s)
            wind_direction: Wind direction in degrees (0=North, 90=East, 270=West)
            turbine_power_curve: Function that takes wind speed, returns power (kW)
            thrust_coefficient: Turbine thrust coefficient

        Returns:
            WakeResult with powers, losses, and effective speeds
        """
        if self.backend == 'simple':
            return self._simple_power(
                wind_speed, wind_direction,
                turbine_power_curve, thrust_coefficient
            )
        elif self.backend == 'floris':
            return self._floris_power(
                wind_speed, wind_direction, turbine_power_curve
            )
        elif self.backend == 'pywake':
            return self._pywake_power(
                wind_speed, wind_direction, turbine_power_curve
            )

    def _simple_power(
        self,
        wind_speed: float,
        wind_direction: float,
        power_curve: Callable[[float], float],
        thrust_coefficient: float
    ) -> WakeResult:
        """
        Calculate power using built-in Jensen wake model.

        Uses sum-of-squares wake superposition for multiple wakes.
        """
        # Convert wind direction to radians (meteorological convention)
        # Wind FROM direction, so add 180 to get flow direction
        flow_direction = (wind_direction + 180) % 360
        wind_rad = np.radians(flow_direction)

        # Get representative rotor diameter
        rotor_d = self.positions[0].rotor_diameter

        # Sort turbines by position along wind direction (upstream first)
        # Project positions onto wind direction axis
        proj = self.x * np.cos(wind_rad) + self.y * np.sin(wind_rad)
        order = np.argsort(proj)  # Upstream to downstream

        effective_speeds = np.full(self.n_turbines, wind_speed)

        # Calculate wake effects
        for i, upstream_idx in enumerate(order[:-1]):
            for downstream_idx in order[i + 1:]:
                # Vector from upstream to downstream
                dx = self.x[downstream_idx] - self.x[upstream_idx]
                dy = self.y[downstream_idx] - self.y[upstream_idx]

                # Distance along wind direction
                x_along = dx * np.cos(wind_rad) + dy * np.sin(wind_rad)

                if x_along > 0:  # Is downstream
                    # Lateral distance (perpendicular to wind)
                    y_perp = abs(-dx * np.sin(wind_rad) + dy * np.cos(wind_rad))

                    # Check if downstream turbine is in wake zone
                    wake_radius = self.wake_model.wake_radius(x_along, rotor_d)

                    if y_perp < wake_radius + rotor_d / 2:
                        # Calculate overlap fraction (simplified)
                        overlap = max(0, 1 - y_perp / (wake_radius + rotor_d / 2))

                        deficit = self.wake_model.velocity_deficit(
                            x_along, rotor_d, thrust_coefficient
                        ) * overlap

                        # Wake superposition (sum of squares)
                        current_deficit = 1 - effective_speeds[downstream_idx] / wind_speed
                        combined_deficit = np.sqrt(current_deficit ** 2 + deficit ** 2)
                        effective_speeds[downstream_idx] = wind_speed * (1 - combined_deficit)

        # Calculate power for each turbine
        turbine_powers = [power_curve(ws) for ws in effective_speeds]
        total_power = sum(turbine_powers)

        # No-wake reference
        no_wake_power = self.n_turbines * power_curve(wind_speed)
        wake_loss_pct = (
            (no_wake_power - total_power) / no_wake_power * 100
            if no_wake_power > 0 else 0
        )

        return WakeResult(
            total_power_kw=total_power,
            turbine_powers=turbine_powers,
            wake_losses_pct=wake_loss_pct,
            effective_wind_speeds=effective_speeds.tolist(),
            no_wake_power_kw=no_wake_power
        )

    def _floris_power(
        self,
        wind_speed: float,
        wind_direction: float,
        power_curve: Callable[[float], float]
    ) -> WakeResult:
        """
        Calculate power using FLORIS (requires installation).
        """
        # Placeholder - would use FLORIS API
        raise NotImplementedError(
            "FLORIS integration requires configuration. "
            "Use 'simple' backend or configure FLORIS separately."
        )

    def _pywake_power(
        self,
        wind_speed: float,
        wind_direction: float,
        power_curve: Callable[[float], float]
    ) -> WakeResult:
        """
        Calculate power using PyWake (requires installation).
        """
        # Placeholder - would use PyWake API
        raise NotImplementedError(
            "PyWake integration requires configuration. "
            "Use 'simple' backend or configure PyWake separately."
        )

    def calculate_direction_sweep(
        self,
        wind_speed: float,
        directions: np.ndarray,
        power_curve: Callable[[float], float]
    ) -> dict:
        """
        Calculate wake losses across all wind directions.

        Useful for understanding how farm layout performs
        under different wind conditions.

        Args:
            wind_speed: Wind speed for analysis
            directions: Array of wind directions (degrees)
            power_curve: Power curve function

        Returns:
            Dict with losses by direction
        """
        results = {}

        for direction in directions:
            result = self.calculate_farm_power(
                wind_speed, direction, power_curve
            )
            results[float(direction)] = {
                'wake_losses_pct': result.wake_losses_pct,
                'total_power_kw': result.total_power_kw,
                'effective_speeds': result.effective_wind_speeds
            }

        return {
            'direction_sweep': results,
            'avg_wake_loss': np.mean([r['wake_losses_pct'] for r in results.values()]),
            'max_wake_loss': max([r['wake_losses_pct'] for r in results.values()]),
            'min_wake_loss': min([r['wake_losses_pct'] for r in results.values()])
        }


class WakeAwareForecaster:
    """
    Wind power forecasting accounting for wake effects.

    Combines wind forecast with wake model to predict farm output
    more accurately than simple aggregation.

    Example:
        forecaster = WakeAwareForecaster(farm_model, power_curve)

        # Get wind forecast
        ws_forecast = np.array([8, 9, 10, 11, 10, 9])  # m/s
        wd_forecast = np.array([270, 270, 280, 280, 290, 270])  # degrees

        result = forecaster.forecast_farm_power(ws_forecast, wd_forecast)
        print(f"Forecast power: {result['power_forecast']}")
    """

    def __init__(
        self,
        wake_model: WakeFarmModel,
        power_curve: Callable[[float], float]
    ):
        """
        Args:
            wake_model: Configured WakeFarmModel
            power_curve: Turbine power curve function
        """
        self.wake_model = wake_model
        self.power_curve = power_curve

    def forecast_farm_power(
        self,
        wind_speed_forecast: np.ndarray,
        wind_direction_forecast: np.ndarray
    ) -> dict:
        """
        Forecast farm power for each timestep.

        Args:
            wind_speed_forecast: Wind speed forecast (m/s)
            wind_direction_forecast: Wind direction forecast (degrees)

        Returns:
            Dict with power forecast and wake losses
        """
        powers = []
        wake_losses = []
        no_wake_powers = []

        for ws, wd in zip(wind_speed_forecast, wind_direction_forecast):
            result = self.wake_model.calculate_farm_power(
                ws, wd, self.power_curve
            )
            powers.append(result.total_power_kw)
            wake_losses.append(result.wake_losses_pct)
            no_wake_powers.append(result.no_wake_power_kw)

        return {
            'power_forecast': np.array(powers),
            'wake_losses_forecast': np.array(wake_losses),
            'no_wake_power': np.array(no_wake_powers),
            'avg_wake_loss': float(np.mean(wake_losses)),
            'total_energy_kwh': float(np.sum(powers)),  # Assuming hourly timesteps
            'wake_loss_energy_kwh': float(np.sum(no_wake_powers) - np.sum(powers))
        }


def create_simple_power_curve(rated_power_kw: float) -> Callable[[float], float]:
    """
    Create a simple power curve function for testing.

    Uses cubic power law below rated wind speed.

    Args:
        rated_power_kw: Rated turbine power

    Returns:
        Power curve function
    """
    def power_curve(wind_speed: float) -> float:
        if wind_speed < 3:  # Below cut-in
            return 0
        elif wind_speed > 25:  # Above cut-out
            return 0
        elif wind_speed > 12:  # Above rated
            return rated_power_kw
        else:
            # Cubic relationship (simplified)
            # P = 0.5 * rho * A * Cp * v^3
            # Normalized to rated power at rated speed
            return rated_power_kw * (wind_speed / 12) ** 3

    return power_curve
