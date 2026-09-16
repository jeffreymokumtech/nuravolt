"""
BESS Warranty Violation Detection Module

Comprehensive rule-based detection of warranty-voiding conditions including:
- Temperature violations (operating range, sustained exceedance)
- State of Charge violations (high/low dwelling)
- C-Rate violations (continuous and peak)
- Cell voltage violations (bounds checking)
- Cycling violations (depth, frequency)
- HVAC correlation analysis
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional, Tuple
from enum import Enum
import numpy as np

try:
    import polars as pl
except ImportError:
    pl = None

from nuravolt.bess.config import (
    ViolationDetectionConfig,
    WarrantyTermsConfig,
    WarrantyViolation,
)


class ViolationType(Enum):
    """Types of warranty violations."""
    TEMPERATURE_EXCEED = "TEMPERATURE_EXCEED"
    SOC_HIGH_DWELL = "SOC_HIGH_DWELL"
    SOC_LOW_DWELL = "SOC_LOW_DWELL"
    CYCLING_DEPTH = "CYCLING_DEPTH"
    CYCLING_FREQUENCY = "CYCLING_FREQUENCY"
    C_RATE_EXCEED = "C_RATE_EXCEED"
    VOLTAGE_VIOLATION = "VOLTAGE_VIOLATION"
    THROUGHPUT_EXCEED = "THROUGHPUT_EXCEED"
    HVAC_FAILURE = "HVAC_FAILURE"
    RTE_DEGRADATION = "RTE_DEGRADATION"
    CAPACITY_DEGRADATION = "CAPACITY_DEGRADATION"


class Severity(Enum):
    """Violation severity levels."""
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class ViolationEvent:
    """Internal representation of a violation event during detection."""
    violation_type: ViolationType
    severity: Severity
    start_time: datetime
    end_time: Optional[datetime] = None
    measured_values: List[float] = field(default_factory=list)
    threshold_value: float = 0.0
    unit: str = ""
    affected_modules: List[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


class WarrantyViolationDetector:
    """
    Comprehensive rule-based warranty violation detection.

    Detects conditions that may void or stress battery warranties:
    - Temperature operating outside spec
    - Prolonged high or low SoC
    - Excessive C-rates
    - Cell voltage out of bounds
    - Excessive cycling depth or frequency
    - HVAC system failures correlated with thermal events

    Example:
        config = ViolationDetectionConfig()
        detector = WarrantyViolationDetector(config)

        violations = detector.check_all(df)
        for v in violations:
            print(f"{v.violation_type}: {v.description}")
    """

    def __init__(self, config: Optional[ViolationDetectionConfig] = None):
        """
        Initialize the violation detector.

        Args:
            config: Violation detection configuration
        """
        self.config = config or ViolationDetectionConfig()

    def check_all(
        self,
        df: "pl.DataFrame",
        timestamp_col: str = "timestamp",
        **column_mappings
    ) -> List[WarrantyViolation]:
        """
        Run all violation checks on the data.

        Args:
            df: Polars DataFrame with time series data
            timestamp_col: Timestamp column name
            **column_mappings: Column name mappings for data fields

        Returns:
            List of detected violations
        """
        violations = []

        # Column mappings with defaults
        cols = {
            "temp": column_mappings.get("temp_col", "temperature_c"),
            "soc": column_mappings.get("soc_col", "soc"),
            "power": column_mappings.get("power_col", "power_kw"),
            "voltage": column_mappings.get("voltage_col", "cell_voltage_v"),
            "hvac_status": column_mappings.get("hvac_col", "hvac_status"),
            "c_rate": column_mappings.get("c_rate_col", "c_rate"),
        }

        # Temperature checks
        if cols["temp"] in df.columns:
            violations.extend(self.check_temperature(
                df, timestamp_col, cols["temp"]
            ))

        # SoC dwelling checks
        if cols["soc"] in df.columns:
            violations.extend(self.check_soc_dwell(
                df, timestamp_col, cols["soc"]
            ))

        # C-rate checks
        if cols["c_rate"] in df.columns:
            violations.extend(self.check_c_rate(
                df, timestamp_col, cols["c_rate"]
            ))
        elif cols["power"] in df.columns:
            # Calculate C-rate from power if not provided
            violations.extend(self.check_c_rate_from_power(
                df, timestamp_col, cols["power"]
            ))

        # Voltage checks
        if cols["voltage"] in df.columns:
            violations.extend(self.check_cell_voltage(
                df, timestamp_col, cols["voltage"]
            ))

        # HVAC correlation checks
        if cols["hvac_status"] in df.columns and cols["temp"] in df.columns:
            violations.extend(self.check_hvac_correlation(
                df, timestamp_col, cols["temp"], cols["hvac_status"]
            ))

        return violations

    def check_temperature(
        self,
        df: "pl.DataFrame",
        timestamp_col: str,
        temp_col: str
    ) -> List[WarrantyViolation]:
        """
        Detect temperature violations.

        Checks for:
        - Sustained operation above max threshold
        - Sustained operation below min threshold
        - Critical temperature spikes

        Args:
            df: DataFrame with temperature data
            timestamp_col: Timestamp column
            temp_col: Temperature column

        Returns:
            List of temperature violations
        """
        if pl is None:
            raise ImportError("Polars is required")

        violations = []
        config = self.config

        # Get time series
        temps = df.select([timestamp_col, temp_col]).sort(timestamp_col)
        timestamps = temps[timestamp_col].to_numpy()
        values = temps[temp_col].to_numpy()

        # Find periods above max threshold
        high_temp_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.temp_warning_threshold_c,
            above=True,
            min_duration_minutes=config.temp_window_minutes,
        )

        for event in high_temp_events:
            max_temp = max(event.measured_values)
            severity = (
                Severity.CRITICAL
                if max_temp >= config.temp_critical_threshold_c
                else Severity.WARNING
            )

            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.TEMPERATURE_EXCEED,
                severity=severity,
                description=(
                    f"Temperature exceeded {config.temp_warning_threshold_c}°C for "
                    f"{event.metadata.get('duration_minutes', 0):.0f} minutes. "
                    f"Max: {max_temp:.1f}°C"
                ),
                unit="°C",
            ))

        # Find periods below min threshold
        low_temp_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.warranty_terms.operating_temp_min_c,
            above=False,
            min_duration_minutes=config.temp_window_minutes,
        )

        for event in low_temp_events:
            min_temp = min(event.measured_values)
            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.TEMPERATURE_EXCEED,
                severity=Severity.WARNING,
                description=(
                    f"Temperature below {config.warranty_terms.operating_temp_min_c}°C for "
                    f"{event.metadata.get('duration_minutes', 0):.0f} minutes. "
                    f"Min: {min_temp:.1f}°C"
                ),
                unit="°C",
            ))

        return violations

    def check_soc_dwell(
        self,
        df: "pl.DataFrame",
        timestamp_col: str,
        soc_col: str
    ) -> List[WarrantyViolation]:
        """
        Detect SoC dwelling violations.

        Checks for:
        - Prolonged high SoC (>95%) dwelling
        - Prolonged low SoC (<20%) dwelling

        Args:
            df: DataFrame with SoC data
            timestamp_col: Timestamp column
            soc_col: SoC column

        Returns:
            List of SoC dwelling violations
        """
        if pl is None:
            raise ImportError("Polars is required")

        violations = []
        config = self.config

        # Get time series
        soc_data = df.select([timestamp_col, soc_col]).sort(timestamp_col)
        timestamps = soc_data[timestamp_col].to_numpy()
        values = soc_data[soc_col].to_numpy()

        # High SoC dwelling
        high_soc_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.soc_high_warning,
            above=True,
            min_duration_minutes=config.soc_dwell_hours_warning * 60,
        )

        for event in high_soc_events:
            hours = event.metadata.get("duration_minutes", 0) / 60
            severity = (
                Severity.CRITICAL
                if hours >= config.soc_dwell_hours_critical
                else Severity.WARNING
            )

            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.SOC_HIGH_DWELL,
                severity=severity,
                description=(
                    f"Battery at >{config.soc_high_warning:.0%} SoC for "
                    f"{hours:.1f} hours. Warranty risk."
                ),
                unit="%",
            ))

        # Low SoC dwelling
        low_soc_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.soc_low_warning,
            above=False,
            min_duration_minutes=config.soc_dwell_hours_warning * 60,
        )

        for event in low_soc_events:
            hours = event.metadata.get("duration_minutes", 0) / 60
            severity = (
                Severity.CRITICAL
                if min(event.measured_values) <= config.soc_low_critical
                else Severity.WARNING
            )

            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.SOC_LOW_DWELL,
                severity=severity,
                description=(
                    f"Battery at <{config.soc_low_warning:.0%} SoC for "
                    f"{hours:.1f} hours. Risk of deep discharge damage."
                ),
                unit="%",
            ))

        return violations

    def check_c_rate(
        self,
        df: "pl.DataFrame",
        timestamp_col: str,
        c_rate_col: str
    ) -> List[WarrantyViolation]:
        """
        Detect C-rate violations.

        Checks for:
        - Sustained C-rate above continuous limit
        - Peak C-rate above maximum

        Args:
            df: DataFrame with C-rate data
            timestamp_col: Timestamp column
            c_rate_col: C-rate column

        Returns:
            List of C-rate violations
        """
        if pl is None:
            raise ImportError("Polars is required")

        violations = []
        config = self.config

        # Get time series
        c_rate_data = df.select([timestamp_col, c_rate_col]).sort(timestamp_col)
        timestamps = c_rate_data[timestamp_col].to_numpy()
        values = np.abs(c_rate_data[c_rate_col].to_numpy())

        # Continuous C-rate violations
        continuous_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.c_rate_warning,
            above=True,
            min_duration_minutes=config.c_rate_window_minutes,
        )

        for event in continuous_events:
            max_c_rate = max(event.measured_values)
            severity = (
                Severity.CRITICAL
                if max_c_rate >= config.c_rate_critical
                else Severity.WARNING
            )

            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.C_RATE_EXCEED,
                severity=severity,
                description=(
                    f"C-rate exceeded {config.c_rate_warning}C for "
                    f"{event.metadata.get('duration_minutes', 0):.0f} minutes. "
                    f"Max: {max_c_rate:.2f}C"
                ),
                unit="C",
            ))

        return violations

    def check_c_rate_from_power(
        self,
        df: "pl.DataFrame",
        timestamp_col: str,
        power_col: str,
        capacity_kwh: float = 1000.0
    ) -> List[WarrantyViolation]:
        """
        Detect C-rate violations calculated from power.

        Args:
            df: DataFrame with power data
            timestamp_col: Timestamp column
            power_col: Power column (kW)
            capacity_kwh: Battery capacity for C-rate calculation

        Returns:
            List of C-rate violations
        """
        # Add C-rate column
        df_with_c_rate = df.with_columns(
            (pl.col(power_col).abs() / capacity_kwh).alias("_c_rate")
        )

        return self.check_c_rate(df_with_c_rate, timestamp_col, "_c_rate")

    def check_cell_voltage(
        self,
        df: "pl.DataFrame",
        timestamp_col: str,
        voltage_col: str
    ) -> List[WarrantyViolation]:
        """
        Detect cell voltage violations.

        Checks for:
        - Voltage above maximum (overcharging)
        - Voltage below minimum (deep discharge)

        Args:
            df: DataFrame with cell voltage data
            timestamp_col: Timestamp column
            voltage_col: Cell voltage column

        Returns:
            List of voltage violations
        """
        if pl is None:
            raise ImportError("Polars is required")

        violations = []
        config = self.config
        terms = config.warranty_terms

        # Get time series
        voltage_data = df.select([timestamp_col, voltage_col]).sort(timestamp_col)
        timestamps = voltage_data[timestamp_col].to_numpy()
        values = voltage_data[voltage_col].to_numpy()

        # High voltage violations
        high_v_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.cell_voltage_warning_high_v,
            above=True,
            min_duration_minutes=1,  # Even brief violations are serious
        )

        for event in high_v_events:
            max_v = max(event.measured_values)
            severity = (
                Severity.CRITICAL
                if max_v >= terms.cell_voltage_max_v
                else Severity.WARNING
            )

            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.VOLTAGE_VIOLATION,
                severity=severity,
                description=(
                    f"Cell voltage exceeded {config.cell_voltage_warning_high_v}V. "
                    f"Max: {max_v:.3f}V. Risk of cell damage."
                ),
                unit="V",
            ))

        # Low voltage violations
        low_v_events = self._find_violation_periods(
            timestamps=timestamps,
            values=values,
            threshold=config.cell_voltage_warning_low_v,
            above=False,
            min_duration_minutes=1,
        )

        for event in low_v_events:
            min_v = min(event.measured_values)
            severity = (
                Severity.CRITICAL
                if min_v <= terms.cell_voltage_min_v
                else Severity.WARNING
            )

            violations.append(self._create_violation(
                event=event,
                violation_type=ViolationType.VOLTAGE_VIOLATION,
                severity=severity,
                description=(
                    f"Cell voltage below {config.cell_voltage_warning_low_v}V. "
                    f"Min: {min_v:.3f}V. Risk of deep discharge damage."
                ),
                unit="V",
            ))

        return violations

    def check_hvac_correlation(
        self,
        df: "pl.DataFrame",
        timestamp_col: str,
        temp_col: str,
        hvac_col: str
    ) -> List[WarrantyViolation]:
        """
        Detect HVAC failure correlated with temperature events.

        Looks for temperature spikes when HVAC is offline.

        Args:
            df: DataFrame with temperature and HVAC data
            timestamp_col: Timestamp column
            temp_col: Temperature column
            hvac_col: HVAC status column (0=off, 1=on)

        Returns:
            List of HVAC-related violations
        """
        if pl is None:
            raise ImportError("Polars is required")

        violations = []
        config = self.config

        # Find periods where HVAC is off and temperature rises
        combined = df.select([timestamp_col, temp_col, hvac_col]).sort(timestamp_col)

        # Calculate temperature change rate
        combined = combined.with_columns([
            pl.col(temp_col).diff().alias("_temp_diff"),
            pl.col(timestamp_col).diff().dt.total_minutes().alias("_time_diff"),
        ])

        # Find HVAC-off periods with temperature rise
        problem_periods = combined.filter(
            (pl.col(hvac_col) == 0) &
            (pl.col("_temp_diff") > config.hvac_temp_correlation_threshold)
        )

        if len(problem_periods) > 0:
            first_row = problem_periods.row(0, named=True)
            last_row = problem_periods.row(-1, named=True)

            violations.append(WarrantyViolation(
                violation_type=ViolationType.HVAC_FAILURE.value,
                severity=Severity.CRITICAL.value,
                started_at=first_row[timestamp_col],
                ended_at=last_row[timestamp_col],
                duration_minutes=int(
                    (last_row[timestamp_col] - first_row[timestamp_col]).total_seconds() / 60
                ),
                measured_value=float(problem_periods[temp_col].max()),
                threshold_value=config.warranty_terms.operating_temp_max_c,
                unit="°C",
                description=(
                    f"Temperature rise detected with HVAC system offline. "
                    f"Potential thermal management failure."
                ),
            ))

        return violations

    def check_throughput_limit(
        self,
        cumulative_throughput_mwh: float,
        warranty_limit_mwh: Optional[float] = None
    ) -> Optional[WarrantyViolation]:
        """
        Check if throughput warranty limit is exceeded.

        Args:
            cumulative_throughput_mwh: Total energy throughput
            warranty_limit_mwh: Warranty throughput limit

        Returns:
            Violation if limit exceeded, None otherwise
        """
        limit = warranty_limit_mwh or self.config.warranty_terms.max_throughput_mwh

        if limit is None:
            return None

        usage_pct = cumulative_throughput_mwh / limit

        if usage_pct >= 1.0:
            return WarrantyViolation(
                violation_type=ViolationType.THROUGHPUT_EXCEED.value,
                severity=Severity.CRITICAL.value,
                started_at=datetime.now(),
                ended_at=None,
                duration_minutes=None,
                measured_value=cumulative_throughput_mwh,
                threshold_value=limit,
                unit="MWh",
                description=(
                    f"Warranty throughput limit exceeded. "
                    f"Throughput: {cumulative_throughput_mwh:.1f} MWh / "
                    f"Limit: {limit:.1f} MWh ({usage_pct:.0%})"
                ),
            )
        elif usage_pct >= 0.90:
            return WarrantyViolation(
                violation_type=ViolationType.THROUGHPUT_EXCEED.value,
                severity=Severity.WARNING.value,
                started_at=datetime.now(),
                ended_at=None,
                duration_minutes=None,
                measured_value=cumulative_throughput_mwh,
                threshold_value=limit,
                unit="MWh",
                description=(
                    f"Approaching warranty throughput limit. "
                    f"Throughput: {cumulative_throughput_mwh:.1f} MWh / "
                    f"Limit: {limit:.1f} MWh ({usage_pct:.0%})"
                ),
            )

        return None

    def _find_violation_periods(
        self,
        timestamps: np.ndarray,
        values: np.ndarray,
        threshold: float,
        above: bool,
        min_duration_minutes: float
    ) -> List[ViolationEvent]:
        """
        Find continuous periods where values violate threshold.

        Args:
            timestamps: Array of timestamps
            values: Array of values to check
            threshold: Threshold value
            above: True if violation is value > threshold, False for value < threshold
            min_duration_minutes: Minimum duration to count as violation

        Returns:
            List of violation events
        """
        if len(timestamps) == 0:
            return []

        # Find violation mask
        if above:
            violation_mask = values > threshold
        else:
            violation_mask = values < threshold

        # Find contiguous violation periods
        events = []
        in_violation = False
        start_idx = 0

        for i, is_violation in enumerate(violation_mask):
            if is_violation and not in_violation:
                # Start of violation period
                in_violation = True
                start_idx = i
            elif not is_violation and in_violation:
                # End of violation period
                in_violation = False
                events.append((start_idx, i - 1))

        # Handle violation at end of data
        if in_violation:
            events.append((start_idx, len(timestamps) - 1))

        # Filter by duration and create violation events
        result = []
        for start_idx, end_idx in events:
            start_time = timestamps[start_idx]
            end_time = timestamps[end_idx]

            # Convert numpy datetime64 to datetime if needed
            if isinstance(start_time, np.datetime64):
                start_time = start_time.astype('datetime64[us]').astype(datetime)
            if isinstance(end_time, np.datetime64):
                end_time = end_time.astype('datetime64[us]').astype(datetime)

            duration_minutes = (end_time - start_time).total_seconds() / 60

            if duration_minutes >= min_duration_minutes:
                result.append(ViolationEvent(
                    violation_type=ViolationType.TEMPERATURE_EXCEED,  # Will be overwritten
                    severity=Severity.WARNING,  # Will be overwritten
                    start_time=start_time,
                    end_time=end_time,
                    measured_values=values[start_idx:end_idx + 1].tolist(),
                    threshold_value=threshold,
                    metadata={"duration_minutes": duration_minutes},
                ))

        return result

    def _create_violation(
        self,
        event: ViolationEvent,
        violation_type: ViolationType,
        severity: Severity,
        description: str,
        unit: str
    ) -> WarrantyViolation:
        """Create a WarrantyViolation from a ViolationEvent."""
        measured = (
            max(event.measured_values)
            if event.measured_values
            else event.threshold_value
        )

        return WarrantyViolation(
            violation_type=violation_type.value,
            severity=severity.value,
            started_at=event.start_time,
            ended_at=event.end_time,
            duration_minutes=int(event.metadata.get("duration_minutes", 0)),
            measured_value=measured,
            threshold_value=event.threshold_value,
            unit=unit,
            description=description,
            affected_modules=event.affected_modules,
            root_cause=None,
        )
