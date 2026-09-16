"""
BESS Cycling Analysis Module

Rainflow cycle counting and stress-weighted equivalent full cycle (EFC) calculation
following ASTM E1049 methodology.

Reference: ASTM E1049-85 Standard Practices for Cycle Counting in Fatigue Analysis
"""

from dataclasses import dataclass, field
from datetime import datetime, date
from typing import List, Optional, Tuple
import numpy as np

try:
    import polars as pl
except ImportError:
    pl = None

from nuravolt.bess.config import CyclingAnalysisConfig, CycleRecord


@dataclass
class RainflowCycle:
    """A single cycle identified by rainflow counting."""
    range: float      # Depth of discharge (0-1)
    mean: float       # Mean SoC during cycle
    count: float      # Cycle count (0.5 or 1.0)
    start_idx: int    # Start index in time series
    end_idx: int      # End index in time series
    stress: float = 0.0  # Weighted stress factor


@dataclass
class DailyCycleMetrics:
    """Aggregated cycling metrics for a single day."""
    date: date
    energy_in_kwh: float
    energy_out_kwh: float
    equivalent_full_cycles: float
    stress_weighted_cycles: float
    avg_dod: float
    max_dod: float
    avg_c_rate: float
    max_c_rate: float
    avg_temp_c: float
    max_temp_c: float
    # None when the day's energy balance cannot support a physical figure (for
    # example a day that only discharged stored energy). Absent, not zero, and
    # never a stand-in constant.
    round_trip_efficiency: Optional[float]
    high_soc_hours: float
    high_temp_hours: float
    rainflow_cycles: List[RainflowCycle] = field(default_factory=list)


class RainflowCycleCounter:
    """
    ASTM E1049 rainflow counting for battery SoC time series.

    The rainflow algorithm identifies full and partial cycles from
    an irregular time series of state of charge values.

    Example:
        counter = RainflowCycleCounter()
        cycles = counter.count_cycles(soc_array)
        efc = counter.calculate_equivalent_full_cycles(cycles)
    """

    def __init__(self, config: Optional[CyclingAnalysisConfig] = None):
        """
        Initialize the rainflow counter.

        Args:
            config: Cycling analysis configuration
        """
        self.config = config or CyclingAnalysisConfig()

    def count_cycles(self, soc: np.ndarray) -> List[RainflowCycle]:
        """
        Perform rainflow cycle counting on SoC time series.

        Uses the four-point rainflow algorithm (ASTM E1049).

        Args:
            soc: Array of state of charge values (0-1)

        Returns:
            List of identified cycles
        """
        if len(soc) < 4:
            return []

        # Extract turning points (local minima and maxima)
        turning_points, indices = self._extract_turning_points(soc)

        # Two turning points are enough. The four-point rule belongs to the
        # closed-cycle matcher below, but the residual handler after it counts
        # unclosed swings as half cycles and only needs a pair. A day
        # that charges once and discharges once has exactly three turning
        # points (start, peak, end), so the old guard returned before that
        # handler and reported ZERO cycles and zero depth of discharge for a
        # full-depth swing. On the modelled year that read as 0.09 equivalent
        # cycles per day against a real mean daily swing of 0.50.
        if len(turning_points) < 2:
            return []

        cycles = []
        points = list(turning_points)
        point_indices = list(indices)

        # Four-point rainflow algorithm
        while len(points) >= 4:
            # Get four consecutive points
            s1, s2, s3, s4 = points[:4]
            i1, i2, i3, i4 = point_indices[:4]

            # Calculate ranges
            range_inner = abs(s3 - s2)
            range_outer_left = abs(s2 - s1)
            range_outer_right = abs(s4 - s3)

            # Check if inner range is contained
            if range_inner <= range_outer_left and range_inner <= range_outer_right:
                # Found a full cycle
                cycle = RainflowCycle(
                    range=range_inner,
                    mean=(s2 + s3) / 2,
                    count=1.0,
                    start_idx=i2,
                    end_idx=i3,
                )

                # Only count if above minimum threshold
                if cycle.range >= self.config.min_cycle_depth:
                    cycles.append(cycle)

                # Remove inner points
                points.pop(1)
                points.pop(1)
                point_indices.pop(1)
                point_indices.pop(1)
            else:
                # Move window forward
                points.pop(0)
                point_indices.pop(0)

        # Handle residual (unclosed cycles) as half cycles
        if len(points) >= 2:
            for i in range(len(points) - 1):
                cycle_range = abs(points[i + 1] - points[i])
                if cycle_range >= self.config.min_cycle_depth:
                    cycles.append(RainflowCycle(
                        range=cycle_range,
                        mean=(points[i] + points[i + 1]) / 2,
                        count=0.5,  # Half cycle for residual
                        start_idx=point_indices[i],
                        end_idx=point_indices[i + 1],
                    ))

        return cycles

    def _extract_turning_points(
        self,
        soc: np.ndarray
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Extract local minima and maxima from SoC time series.

        Args:
            soc: Array of SoC values

        Returns:
            Tuple of (turning_point_values, turning_point_indices)
        """
        if len(soc) < 3:
            return np.array([]), np.array([])

        # Find local extrema
        diff = np.diff(soc)
        sign_changes = np.diff(np.sign(diff))

        # Indices where sign changes (extrema)
        extrema_idx = np.where(sign_changes != 0)[0] + 1

        # Include first and last points
        indices = np.concatenate([[0], extrema_idx, [len(soc) - 1]])
        values = soc[indices]

        # Remove consecutive duplicates (within hysteresis)
        mask = np.abs(np.diff(values, prepend=values[0] - 1)) > self.config.hysteresis
        mask[0] = True  # Always keep first

        return values[mask], indices[mask]

    def calculate_equivalent_full_cycles(
        self,
        cycles: List[RainflowCycle],
        reference_dod: Optional[float] = None
    ) -> float:
        """
        Calculate equivalent full cycles from rainflow cycles.

        EFC = sum(count_i * (DoD_i / reference_DoD))

        Args:
            cycles: List of identified cycles
            reference_dod: Reference DoD for equivalence (default: config value)

        Returns:
            Equivalent full cycles
        """
        ref_dod = reference_dod or self.config.reference_dod

        efc = sum(
            cycle.count * (cycle.range / ref_dod)
            for cycle in cycles
        )

        return efc

    def calculate_stress_weighted_cycles(
        self,
        cycles: List[RainflowCycle],
        avg_temp_c: float = 25.0,
        avg_c_rate: float = 0.5
    ) -> float:
        """
        Calculate stress-weighted equivalent cycles.

        Accounts for DoD, temperature, and C-rate stress factors.

        Args:
            cycles: List of identified cycles
            avg_temp_c: Average temperature during cycling
            avg_c_rate: Average C-rate during cycling

        Returns:
            Stress-weighted equivalent cycles
        """
        config = self.config

        weighted_cycles = 0.0

        for cycle in cycles:
            # DoD stress (exponential)
            dod_stress = (cycle.range / config.reference_dod) ** config.dod_stress_exponent

            # Temperature stress (linear above reference)
            temp_stress = 1 + config.temp_stress_factor * max(
                0, avg_temp_c - config.reference_temp_c
            )

            # C-rate stress (linear above reference)
            c_rate_stress = 1 + config.c_rate_stress_factor * max(
                0, avg_c_rate - config.reference_c_rate
            )

            # Combined stress
            total_stress = dod_stress * temp_stress * c_rate_stress

            # Store stress on cycle object
            cycle.stress = total_stress

            weighted_cycles += cycle.count * total_stress

        return weighted_cycles


class CyclingAnalyzer:
    """
    High-level cycling analysis for BESS operational data.

    Combines rainflow counting with daily aggregation and
    cumulative tracking.
    """

    def __init__(
        self,
        config: Optional[CyclingAnalysisConfig] = None,
        nominal_capacity_kwh: float = 1000.0
    ):
        """
        Initialize the cycling analyzer.

        Args:
            config: Cycling analysis configuration
            nominal_capacity_kwh: Battery nominal capacity
        """
        self.config = config or CyclingAnalysisConfig()
        self.nominal_capacity = nominal_capacity_kwh
        self.rainflow = RainflowCycleCounter(config)

    def analyze_daily(
        self,
        df: "pl.DataFrame",
        date_col: str = "timestamp",
        soc_col: str = "soc",
        power_col: str = "power_kw",
        temp_col: Optional[str] = "temperature_c",
        high_soc_threshold: float = 0.95,
        high_temp_threshold: float = 35.0
    ) -> List[DailyCycleMetrics]:
        """
        Analyze cycling metrics aggregated by day.

        Args:
            df: Polars DataFrame with time series data
            date_col: Timestamp column name
            soc_col: State of charge column name
            power_col: Power column name (positive=discharge, negative=charge)
            temp_col: Temperature column name (optional)
            high_soc_threshold: Threshold for high SoC hours
            high_temp_threshold: Threshold for high temperature hours

        Returns:
            List of daily cycling metrics
        """
        if pl is None:
            raise ImportError("Polars is required for cycling analysis")

        # Ensure timestamp column is datetime
        df = df.with_columns(pl.col(date_col).cast(pl.Datetime))

        # Add date column for grouping
        df = df.with_columns(pl.col(date_col).dt.date().alias("_date"))

        # Group by date
        daily_groups = df.group_by("_date").agg([
            pl.col(soc_col).alias("soc_values"),
            pl.col(power_col).alias("power_values"),
            pl.col(temp_col).alias("temp_values") if temp_col else pl.lit(25.0).alias("temp_values"),
            pl.count().alias("n_samples"),
        ])

        results = []

        for row in daily_groups.iter_rows(named=True):
            day_date = row["_date"]
            soc_values = np.array(row["soc_values"])
            power_values = np.array(row["power_values"])
            temp_values = np.array(row["temp_values"]) if temp_col else np.full_like(soc_values, 25.0)
            n_samples = row["n_samples"]

            # Calculate time resolution (assume uniform sampling)
            hours_per_sample = 24.0 / n_samples if n_samples > 0 else 1.0

            # Rainflow cycle counting
            cycles = self.rainflow.count_cycles(soc_values)

            # Equivalent full cycles
            efc = self.rainflow.calculate_equivalent_full_cycles(cycles)

            # Average conditions
            avg_temp = float(np.nanmean(temp_values))
            max_temp = float(np.nanmax(temp_values)) if len(temp_values) > 0 else 25.0

            # C-rate calculation
            c_rates = np.abs(power_values) / self.nominal_capacity
            avg_c_rate = float(np.nanmean(c_rates))
            max_c_rate = float(np.nanmax(c_rates)) if len(c_rates) > 0 else 0.0

            # Stress-weighted cycles
            swc = self.rainflow.calculate_stress_weighted_cycles(
                cycles, avg_temp, avg_c_rate
            )

            # Energy calculations
            charge_mask = power_values < 0
            discharge_mask = power_values > 0

            energy_in = float(np.abs(power_values[charge_mask]).sum() * hours_per_sample)
            energy_out = float(power_values[discharge_mask].sum() * hours_per_sample)

            # Round-trip efficiency, as an energy balance rather than a bare
            # out/in ratio.
            #
            # A calendar day is not a closed system: state of charge carries
            # across midnight. A battery that charges late on one day and
            # discharges early the next shows output it did not take in that
            # day, and out/in then exceeds 1. On a real modelled year this
            # produced 46 impossible days out of 396, a 110% average and a 600%
            # maximum, with days reading energy_in = 0 and energy_out = 7.5 MWh.
            # Round-trip efficiency above 100% is energy from nowhere, and it is
            # the kind of number that discredits every other figure on the page.
            #
            # Energy released from storage over the day is (soc_start - soc_end)
            # x usable capacity, and belongs in the denominator alongside what
            # was charged. When the balance still cannot be formed, the honest
            # answer is None: this codebase does not substitute a plausible
            # constant for a measurement it does not have.
            stored_released = 0.0
            if len(soc_values) >= 2:
                stored_released = (
                    float(soc_values[0]) - float(soc_values[-1])
                ) * self.nominal_capacity
            energy_available = energy_in + max(0.0, stored_released)

            # Both directions are required: round-trip efficiency describes a
            # charge followed by a discharge, so a day that only discharged
            # stored energy has no round trip to measure and reports None.
            rte: Optional[float] = None
            if energy_in > 0 and energy_out > 0 and energy_available > 0:
                candidate = energy_out / energy_available
                # Leave a little headroom for rounding on the SoC trace, but
                # never publish a value above unity.
                rte = min(candidate, 1.0) if candidate <= 1.0 + 1e-6 else None

            # DoD statistics
            dods = [c.range for c in cycles] if cycles else [0.0]
            avg_dod = float(np.mean(dods))
            max_dod = float(np.max(dods)) if dods else 0.0

            # High SoC hours
            high_soc_samples = np.sum(soc_values > high_soc_threshold)
            high_soc_hours = float(high_soc_samples * hours_per_sample)

            # High temperature hours
            high_temp_samples = np.sum(temp_values > high_temp_threshold)
            high_temp_hours = float(high_temp_samples * hours_per_sample)

            results.append(DailyCycleMetrics(
                date=day_date,
                energy_in_kwh=energy_in,
                energy_out_kwh=energy_out,
                equivalent_full_cycles=efc,
                stress_weighted_cycles=swc,
                avg_dod=avg_dod,
                max_dod=max_dod,
                avg_c_rate=avg_c_rate,
                max_c_rate=max_c_rate,
                avg_temp_c=avg_temp,
                max_temp_c=max_temp,
                round_trip_efficiency=rte,
                high_soc_hours=high_soc_hours,
                high_temp_hours=high_temp_hours,
                rainflow_cycles=cycles,
            ))

        return sorted(results, key=lambda x: x.date)

    def calculate_cumulative_metrics(
        self,
        daily_metrics: List[DailyCycleMetrics]
    ) -> dict:
        """
        Calculate cumulative cycling metrics from daily data.

        Args:
            daily_metrics: List of daily cycling metrics

        Returns:
            Dictionary of cumulative metrics
        """
        if not daily_metrics:
            return {
                "total_cycles": 0.0,
                "total_stress_weighted_cycles": 0.0,
                "total_throughput_kwh": 0.0,
                "total_high_soc_hours": 0.0,
                "total_high_temp_hours": 0.0,
                "avg_rte": 0.0,
                "avg_dod": 0.0,
                "avg_c_rate": 0.0,
            }

        total_energy_in = sum(d.energy_in_kwh for d in daily_metrics)
        total_energy_out = sum(d.energy_out_kwh for d in daily_metrics)

        return {
            "total_cycles": sum(d.equivalent_full_cycles for d in daily_metrics),
            "total_stress_weighted_cycles": sum(d.stress_weighted_cycles for d in daily_metrics),
            "total_throughput_kwh": total_energy_in + total_energy_out,
            "total_high_soc_hours": sum(d.high_soc_hours for d in daily_metrics),
            "total_high_temp_hours": sum(d.high_temp_hours for d in daily_metrics),
            "avg_rte": total_energy_out / total_energy_in if total_energy_in > 0 else 0.0,
            "avg_dod": float(np.mean([d.avg_dod for d in daily_metrics])),
            "avg_c_rate": float(np.mean([d.avg_c_rate for d in daily_metrics])),
        }

    def to_cycle_records(
        self,
        daily_metrics: List[DailyCycleMetrics]
    ) -> List[CycleRecord]:
        """
        Convert daily metrics to CycleRecord dataclass format.

        Args:
            daily_metrics: List of daily cycling metrics

        Returns:
            List of CycleRecord objects
        """
        return [
            CycleRecord(
                date=datetime.combine(m.date, datetime.min.time()),
                energy_in_kwh=m.energy_in_kwh,
                energy_out_kwh=m.energy_out_kwh,
                equivalent_cycles=m.equivalent_full_cycles,
                avg_dod=m.avg_dod,
                avg_c_rate=m.avg_c_rate,
                avg_temp_c=m.avg_temp_c,
                round_trip_efficiency=m.round_trip_efficiency,
                stress_weighted_cycles=m.stress_weighted_cycles,
                rainflow_cycles=[
                    {
                        "range": c.range,
                        "mean": c.mean,
                        "count": c.count,
                        "stress": c.stress,
                    }
                    for c in m.rainflow_cycles
                ],
            )
            for m in daily_metrics
        ]
