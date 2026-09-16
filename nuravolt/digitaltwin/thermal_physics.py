#!/usr/bin/env python3
"""
Thermal Physics & Component Degradation Models

Physics-based models for inverter thermal behavior and component life prediction:
- Arrhenius degradation for capacitor ESR
- Coffin-Manson thermal cycling for IGBT/MOSFET
- Thermal stress accumulation
- Remaining useful life (RUL) estimation

References:
- IEC 61709: Electronic components - Reliability - Reference conditions
- MIL-HDBK-217F: Reliability prediction of electronic equipment
- Arrhenius equation: k = A × exp(-Ea/(kB×T))
- Coffin-Manson: Nf = C × (ΔT)^-n
"""

import logging
from dataclasses import dataclass
from typing import Optional

import numpy as np
import polars as pl

logger = logging.getLogger(__name__)


# ============================================================================
# Physical Constants
# ============================================================================

# Boltzmann constant (eV/K)
KB = 8.617333262e-5

# Typical activation energies for electronic components
EA_CAPACITOR_ESR = 0.7  # eV - Capacitor ESR degradation
EA_IGBT_JUNCTION = 0.5  # eV - IGBT junction degradation


# ============================================================================
# Configuration Dataclasses
# ============================================================================


@dataclass
class CapacitorConfig:
    """
    Capacitor degradation model configuration.

    Attributes:
        rated_temp_c: Rated operating temperature (°C)
        rated_esr_ohm: Initial ESR at rated conditions (Ω)
        failure_esr_multiplier: ESR multiplier for failure threshold (typical: 3x)
        activation_energy_ev: Activation energy for ESR degradation (eV)
    """
    rated_temp_c: float = 85.0
    rated_esr_ohm: float = 0.1
    failure_esr_multiplier: float = 3.0
    activation_energy_ev: float = EA_CAPACITOR_ESR


@dataclass
class IGBTConfig:
    """
    IGBT/MOSFET thermal cycling degradation configuration.

    Attributes:
        rated_temp_c: Rated junction temperature (°C)
        max_safe_temp_c: Maximum safe junction temperature (°C)
        coffin_manson_c: Coffin-Manson constant
        coffin_manson_n: Coffin-Manson exponent (typical: 5-9)
        activation_energy_ev: Activation energy for junction degradation (eV)
    """
    rated_temp_c: float = 150.0
    max_safe_temp_c: float = 175.0
    coffin_manson_c: float = 1e9
    coffin_manson_n: float = 6.0
    activation_energy_ev: float = EA_IGBT_JUNCTION


@dataclass
class ThermalStressConfig:
    """
    Thermal stress accumulation configuration.

    Attributes:
        cycle_threshold_c: Minimum ΔT to count as thermal cycle (°C)
        high_stress_threshold_c: Temperature above rated for high stress tracking (°C)
        sampling_interval_hours: Data sampling interval (hours)
    """
    cycle_threshold_c: float = 10.0
    high_stress_threshold_c: float = 5.0  # Above rated temp
    sampling_interval_hours: float = 1.0


# ============================================================================
# Arrhenius Degradation Model
# ============================================================================


class ArrheniusLifeModel:
    """
    Arrhenius-based component life prediction model.

    Uses Arrhenius equation to predict acceleration factor based on
    operating temperature relative to rated conditions.

    Acceleration Factor (AF):
        AF = exp((Ea/kB) × (1/T_rated - 1/T_stress))

    Where:
        Ea = activation energy (eV)
        kB = Boltzmann constant (eV/K)
        T_rated = rated temperature (K)
        T_stress = stress temperature (K)

    Remaining life:
        L_remaining = L_rated / AF
    """

    def __init__(
        self,
        rated_temp_c: float,
        activation_energy_ev: float,
        rated_lifetime_hours: float = 100000.0,
    ):
        """
        Initialize Arrhenius life model.

        Args:
            rated_temp_c: Rated operating temperature (°C)
            activation_energy_ev: Activation energy (eV)
            rated_lifetime_hours: Expected lifetime at rated conditions (hours)
        """
        self.rated_temp_c = rated_temp_c
        self.rated_temp_k = rated_temp_c + 273.15
        self.activation_energy_ev = activation_energy_ev
        self.rated_lifetime_hours = rated_lifetime_hours

    def acceleration_factor(self, stress_temp_c: float) -> float:
        """
        Calculate acceleration factor for given stress temperature.

        Args:
            stress_temp_c: Operating temperature (°C)

        Returns:
            Acceleration factor (AF >= 1.0)
        """
        stress_temp_k = stress_temp_c + 273.15

        # Arrhenius equation
        exponent = (self.activation_energy_ev / KB) * (
            1.0 / self.rated_temp_k - 1.0 / stress_temp_k
        )

        af = np.exp(exponent)

        # AF should be >= 1.0 (stress accelerates degradation)
        return max(1.0, af)

    def remaining_life_hours(
        self,
        thermal_history_c: np.ndarray,
        operating_hours: float,
    ) -> float:
        """
        Estimate remaining useful life based on thermal history.

        Args:
            thermal_history_c: Array of historical temperatures (°C)
            operating_hours: Total operating hours for this history

        Returns:
            Estimated remaining life (hours)
        """
        # Calculate mean acceleration factor across history
        af_history = np.array([
            self.acceleration_factor(temp)
            for temp in thermal_history_c
        ])

        mean_af = np.mean(af_history)

        # Equivalent hours at rated conditions
        equivalent_hours = operating_hours * mean_af

        # Remaining life
        remaining = self.rated_lifetime_hours - equivalent_hours

        return max(0.0, remaining)

    def rul_days(
        self,
        thermal_history_c: np.ndarray,
        operating_hours: float,
        hours_per_day: float = 8.0,
    ) -> float:
        """
        Estimate remaining useful life in days.

        Args:
            thermal_history_c: Array of historical temperatures (°C)
            operating_hours: Total operating hours for this history
            hours_per_day: Operating hours per day (default: 8h for solar)

        Returns:
            Estimated RUL in days
        """
        rul_hours = self.remaining_life_hours(thermal_history_c, operating_hours)
        return rul_hours / hours_per_day


# ============================================================================
# Capacitor ESR Degradation Model
# ============================================================================


class CapacitorESRModel:
    """
    Capacitor ESR degradation model using Arrhenius equation.

    ESR increases with temperature stress and operating time:
        ESR(t) = ESR_0 × exp(α×t)

    Where α depends on temperature via Arrhenius:
        α(T) = A × exp(-Ea/(kB×T))
    """

    def __init__(self, config: CapacitorConfig):
        """Initialize capacitor degradation model."""
        self.config = config
        self.arrhenius = ArrheniusLifeModel(
            rated_temp_c=config.rated_temp_c,
            activation_energy_ev=config.activation_energy_ev,
            rated_lifetime_hours=100000.0,  # Typical DC-link cap lifetime
        )

    def current_esr(
        self,
        thermal_history_c: np.ndarray,
        operating_hours: float,
    ) -> float:
        """
        Estimate current ESR based on thermal history.

        Args:
            thermal_history_c: Historical temperature profile (°C)
            operating_hours: Total operating hours

        Returns:
            Estimated current ESR (Ω)
        """
        mean_af = np.mean([
            self.arrhenius.acceleration_factor(temp)
            for temp in thermal_history_c
        ])

        # ESR growth proportional to equivalent aging
        equivalent_hours = operating_hours * mean_af
        esr_growth = 1.0 + (equivalent_hours / self.arrhenius.rated_lifetime_hours) * (
            self.config.failure_esr_multiplier - 1.0
        )

        return self.config.rated_esr_ohm * esr_growth

    def rul_days(
        self,
        thermal_history_c: np.ndarray,
        operating_hours: float,
        hours_per_day: float = 8.0,
    ) -> float:
        """
        Estimate days until ESR exceeds failure threshold.

        Args:
            thermal_history_c: Historical temperature profile (°C)
            operating_hours: Total operating hours
            hours_per_day: Operating hours per day

        Returns:
            Estimated RUL in days
        """
        current_esr = self.current_esr(thermal_history_c, operating_hours)
        failure_esr = self.config.rated_esr_ohm * self.config.failure_esr_multiplier

        if current_esr >= failure_esr:
            return 0.0

        # Use Arrhenius model for remaining life
        return self.arrhenius.rul_days(
            thermal_history_c,
            operating_hours,
            hours_per_day,
        )


# ============================================================================
# IGBT Thermal Cycling Model
# ============================================================================


class IGBTThermalCyclingModel:
    """
    IGBT/MOSFET thermal cycling degradation model.

    Uses Coffin-Manson equation for cycles-to-failure:
        Nf = C × (ΔT)^-n

    Where:
        Nf = cycles to failure
        C = material constant
        ΔT = temperature swing (°C)
        n = exponent (typical: 5-9)
    """

    def __init__(self, config: IGBTConfig):
        """Initialize IGBT thermal cycling model."""
        self.config = config

    def cycles_to_failure(self, delta_t_c: float) -> float:
        """
        Calculate cycles to failure for given temperature swing.

        Args:
            delta_t_c: Temperature swing magnitude (°C)

        Returns:
            Estimated cycles to failure
        """
        if delta_t_c <= 0:
            return np.inf

        # Coffin-Manson equation
        nf = self.config.coffin_manson_c * (delta_t_c ** -self.config.coffin_manson_n)

        return nf

    def damage_per_cycle(self, delta_t_c: float) -> float:
        """
        Calculate damage accumulation per cycle (Miner's rule).

        Args:
            delta_t_c: Temperature swing magnitude (°C)

        Returns:
            Damage fraction (0-1)
        """
        nf = self.cycles_to_failure(delta_t_c)

        if nf == np.inf:
            return 0.0

        return 1.0 / nf

    def total_damage(
        self,
        thermal_cycles: list[float],
    ) -> float:
        """
        Calculate total accumulated damage from thermal cycling.

        Args:
            thermal_cycles: List of ΔT values for each cycle (°C)

        Returns:
            Total damage (1.0 = failure)
        """
        damage = sum(
            self.damage_per_cycle(delta_t)
            for delta_t in thermal_cycles
        )

        return damage

    def rul_days(
        self,
        thermal_cycles: list[float],
        operating_days: float,
    ) -> float:
        """
        Estimate remaining useful life in days.

        Args:
            thermal_cycles: Historical thermal cycles (°C)
            operating_days: Days over which cycles occurred

        Returns:
            Estimated RUL in days
        """
        current_damage = self.total_damage(thermal_cycles)

        if current_damage >= 1.0:
            return 0.0

        # Remaining damage capacity
        remaining_damage = 1.0 - current_damage

        # Average damage rate per day
        damage_per_day = current_damage / operating_days if operating_days > 0 else 0.0

        if damage_per_day <= 0:
            return np.inf

        # Days until failure
        return remaining_damage / damage_per_day


# ============================================================================
# Thermal Stress Accumulator
# ============================================================================


class ThermalStressAccumulator:
    """
    Accumulate and track thermal stress metrics over time.

    Tracks:
    - Thermal cycling events (ΔT > threshold)
    - High temperature exposure (T > rated + margin)
    - Cumulative thermal stress index
    """

    def __init__(self, config: ThermalStressConfig):
        """Initialize thermal stress accumulator."""
        self.config = config
        self.thermal_cycles: list[float] = []
        self.high_temp_hours: float = 0.0
        self.total_hours: float = 0.0

    def detect_cycles(
        self,
        temperature_series: np.ndarray,
    ) -> list[float]:
        """
        Detect thermal cycles using rainflow counting approximation.

        Simplified approach: Find local minima and maxima, calculate ΔT.

        Args:
            temperature_series: Time series of temperatures (°C)

        Returns:
            List of ΔT values for detected cycles
        """
        if len(temperature_series) < 3:
            return []

        cycles = []

        # Find local extrema
        diff = np.diff(temperature_series)
        sign_changes = np.diff(np.sign(diff))

        extrema_idx = np.where(sign_changes != 0)[0] + 1
        extrema_temps = temperature_series[extrema_idx]

        # Pair consecutive extrema as half-cycles
        for i in range(len(extrema_temps) - 1):
            delta_t = abs(extrema_temps[i+1] - extrema_temps[i])

            if delta_t >= self.config.cycle_threshold_c:
                cycles.append(delta_t)

        return cycles

    def update(
        self,
        temperature_series: np.ndarray,
        rated_temp_c: float,
    ) -> dict:
        """
        Update stress accumulator with new temperature data.

        Args:
            temperature_series: Temperature time series (°C)
            rated_temp_c: Rated component temperature (°C)

        Returns:
            dict with stress metrics
        """
        # Detect new thermal cycles
        new_cycles = self.detect_cycles(temperature_series)
        self.thermal_cycles.extend(new_cycles)

        # Track high temperature exposure
        high_temp_threshold = rated_temp_c + self.config.high_stress_threshold_c
        high_temp_samples = np.sum(temperature_series > high_temp_threshold)
        high_temp_hours = high_temp_samples * self.config.sampling_interval_hours
        self.high_temp_hours += high_temp_hours

        # Update total operating hours
        self.total_hours += len(temperature_series) * self.config.sampling_interval_hours

        return {
            "thermal_cycles_count": len(self.thermal_cycles),
            "max_cycle_delta_t": max(self.thermal_cycles) if self.thermal_cycles else 0.0,
            "high_temp_hours": self.high_temp_hours,
            "total_hours": self.total_hours,
            "high_temp_fraction": self.high_temp_hours / self.total_hours if self.total_hours > 0 else 0.0,
        }

    def get_metrics(self) -> dict:
        """
        Get current thermal stress metrics.

        Returns:
            dict with accumulated metrics
        """
        return {
            "thermal_cycles_count": len(self.thermal_cycles),
            "thermal_cycles": self.thermal_cycles.copy(),
            "max_cycle_delta_t": max(self.thermal_cycles) if self.thermal_cycles else 0.0,
            "mean_cycle_delta_t": np.mean(self.thermal_cycles) if self.thermal_cycles else 0.0,
            "high_temp_hours": self.high_temp_hours,
            "total_hours": self.total_hours,
            "high_temp_fraction": self.high_temp_hours / self.total_hours if self.total_hours > 0 else 0.0,
        }
