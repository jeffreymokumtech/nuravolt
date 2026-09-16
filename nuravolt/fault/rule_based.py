"""
Rule-Based Fault Detection

Threshold-based fault detection for immediate client deployment, in batch
(hourly) processing mode.

No accuracy figure is quoted here on purpose. Measured performance lives in
``docs/MODEL_ACCURACY.md``, generated from the committed artifacts under
``public/data/validation/``. The honest headline is that these rules score
macro-F1 0.835 in-distribution with thresholds tuned on that dataset, 0.519
with untuned physics defaults, and 0.189 across plant architectures -- so
roughly a third of the in-distribution score is threshold fitting rather than
detection skill.
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, TYPE_CHECKING
import re

import polars as pl

from .config import FaultDetectionConfig
from .peer_stats import peer_deficit, sibling_scores_wide, sustained

if TYPE_CHECKING:  # pragma: no cover - annotation only
    from .topology import PlantTopology

#: Horizon the component-life alerts are graded against, in days. Alerts tier at
#: 15 / 7 / 2 days remaining; this is the outermost of those for the `threshold`
#: field on the emitted alert.
RUL_ALERT_HORIZON_DAYS = 15.0

logger = logging.getLogger(__name__)


#: Scale factor making the median absolute deviation a consistent estimator of
#: sigma for normally distributed data (Iglewicz and Hoaglin, ASTM 1993).
_MAD_TO_SIGMA = 1.4826

#: Gap tolerated inside one CHRONIC event, in minutes. Seven days.
#:
#: A degraded string, a mismatched channel or a soiled array is a standing
#: condition, not a series of daily incidents. With the default 60-minute gap
#: every sunset closed the event and every sunrise opened a new one, so a single
#: string that has been 20% down for five years produced tens of thousands of
#: alerts. That is the same physical fact reported over and over.
#:
#: Chronic detectors therefore tolerate a week-long gap, which absorbs nights,
#: weather and short recoveries, and yields one alert that stays open for as long
#: as the condition lasts. Acute faults -- an inverter tripping offline, a grid
#: excursion -- keep the short gap, because there each occurrence really is a
#: separate event.
#: Default only; the live value is FaultDetectionConfig.mppt.chronic_event_gap_minutes.
CHRONIC_EVENT_GAP_MINUTES = 7 * 24 * 60



def _populated_columns(df: pl.DataFrame, cols: list, min_share: float = 0.20) -> list:
    """Drop channels that never carried current: empty sockets, not faults.

    Inverters are routinely installed with spare string inputs. On one real plant
    an inverter exposes 18 inputs of which input 18 reads a maximum of 0.18 A and
    sits at zero 99.6% of the time: it was never connected. Every string rule then
    flagged it as open circuit on every daylight interval for five years, which is
    why `string_open_circuit` was active on 95.8% of intervals there.

    An unpopulated input is not a fault and must be excluded before any sibling
    comparison, otherwise it also drags the very median the other strings are
    judged against.

    The test is relative -- a channel must have reached ``min_share`` of the best
    sibling's maximum at some point in the record -- so it carries no absolute
    current and works on a 3 A residential string and a 15 A utility one alike.
    """
    present = [c for c in cols if c in df.columns]
    if len(present) < 2:
        return present
    peaks = {}
    for c in present:
        col = df[c].drop_nulls()
        peaks[c] = float(col.max()) if len(col) else 0.0
    best = max(peaks.values()) if peaks else 0.0
    if best <= 0:
        return present
    live = [c for c in present if peaks[c] >= best * min_share]
    dropped = len(present) - len(live)
    if dropped:
        logger.info(
            "excluding %d unpopulated channel(s) of %d from sibling comparison "
            "(never exceeded %.0f%% of the best sibling's peak)",
            dropped, len(present), min_share * 100,
        )
    return live if len(live) >= 2 else present



def _self_normalised(df: pl.DataFrame, cols: list, quantile: float = 0.99) -> tuple:
    """Scale every channel by its own capacity before comparing channels.

    WHY THIS IS NECESSARY
    ---------------------
    Inverter string inputs do not all carry the same number of strings. On one
    real plant a single inverter has inputs peaking at 9.8 A alongside inputs
    peaking at 28.7 A and 19.1 A: some inputs have two or three strings paralleled
    into them, some have one. That is a wiring choice, not a fault.

    Comparing raw currents across such inputs flags the single-string inputs
    permanently, because they legitimately carry a third of what their neighbours
    do. It is a large part of why ``string_mismatch_coarse`` was active on up to
    68% of daylight intervals and ``string_open_circuit`` on up to 96%.

    Dividing each channel by its own high quantile removes the wiring factor
    entirely: every healthy channel then reads about 1.0 at full output regardless
    of how many strings feed it, and a channel that has genuinely lost output
    reads low against its own history rather than against its neighbours' wiring.

    The 99th percentile rather than the maximum, so one spike does not set the
    scale. Self-referential and dimensionless, so nothing here ports badly.

    Returns:
        (frame with added normalised columns, list of the new column names)
    """
    present = [c for c in cols if c in df.columns]
    if not present:
        return df, []
    exprs, names = [], []
    for i, c in enumerate(present):
        col = df[c].drop_nulls()
        peak = float(col.quantile(quantile)) if len(col) else 0.0
        name = f"_sn_{i}"
        names.append(name)
        exprs.append(
            (pl.col(c) / peak).alias(name) if peak > 0 else pl.lit(None).alias(name)
        )
    return df.with_columns(exprs), names


def _median_horizontal(cols) -> pl.Expr:
    """Row-wise median across columns.

    Polars has no ``median_horizontal``. This is the idiom already used in
    ``nuravolt/fault/features.py`` for the same purpose.

    The median rather than the mean is load bearing wherever a device is scored
    against its siblings: a mean is dragged toward the very outlier the rule
    exists to find, so the worse a string gets the more it lowers the bar it is
    judged against. The median has a 50 percent breakdown point.
    """
    return pl.concat_list(cols).list.eval(pl.element().median()).list.first()


class FaultType(Enum):
    """Fault types detectable by rule-based methods."""

    # Inverter faults
    INVERTER_OFFLINE = "inverter_offline"
    INVERTER_CLIPPING = "inverter_clipping"
    INVERTER_OVERTEMPERATURE = "inverter_overtemperature"
    # v1.4 - New inverter faults
    INVERTER_EFFICIENCY_DEGRADATION = "inverter_efficiency_degradation"
    DC_LINK_CAPACITOR_AGING = "dc_link_capacitor_aging"
    DC_OVERVOLTAGE = "dc_overvoltage"
    DC_UNDERVOLTAGE = "dc_undervoltage"
    INVERTER_COOLING_DEGRADATION = "inverter_cooling_degradation"
    INVERTER_UNDERPERFORMANCE_PEER = "inverter_underperformance_peer"

    # String faults
    STRING_OPEN_CIRCUIT = "string_open_circuit"
    STRING_SHORT_CIRCUIT = "string_short_circuit"
    # v1.4 - New string/MPPT faults
    STRING_MISMATCH_COARSE = "string_mismatch_coarse"
    STRING_DEGRADATION = "string_degradation"
    MPPT_IMBALANCE = "mppt_imbalance"
    MPPT_HUNTING = "mppt_hunting"

    # Tracker faults
    TRACKER_STUCK = "tracker_stuck"
    TRACKER_MISALIGNED = "tracker_misaligned"

    # Grid faults
    GRID_FREQUENCY_LOW = "grid_frequency_low"
    GRID_FREQUENCY_HIGH = "grid_frequency_high"
    GRID_VOLTAGE_SAG = "grid_voltage_sag"
    GRID_VOLTAGE_SWELL = "grid_voltage_swell"
    # v1.4 - New grid/curtailment faults
    GRID_CURTAILMENT = "grid_curtailment"
    EXPORT_CAP_ACTIVE = "export_cap_active"

    # Module faults
    MODULE_OVERTEMPERATURE = "module_overtemperature"
    # v1.4 - New module faults
    MODULE_CURRENT_DEGRADATION = "module_current_degradation"
    MODULE_VOLTAGE_DROP = "module_voltage_drop"
    BYPASS_DIODE_ACTIVE = "bypass_diode_active"

    # Communication faults
    COMMUNICATION_LOSS = "communication_loss"
    # v1.4 - New communication/sensor faults
    COMMUNICATION_PARTIAL = "communication_partial"
    SENSOR_FROZEN = "sensor_frozen"
    IRRADIANCE_SENSOR_DRIFT = "irradiance_sensor_drift"

    # v1.4 - Plant-level soft faults
    SOILING_DETECTED = "soiling_detected"
    VEGETATION_SHADING = "vegetation_shading"
    INSULATION_RESISTANCE_LOW = "insulation_resistance_low"


class FaultSeverity(Enum):
    """Fault severity levels."""

    INFO = "info"  # Informational, no immediate action needed
    WARNING = "warning"  # Should be investigated soon
    CRITICAL = "critical"  # Requires immediate attention


@dataclass
class FaultAlert:
    """Represents a detected fault."""

    fault_type: FaultType
    severity: FaultSeverity
    timestamp_start: datetime
    timestamp_end: Optional[datetime] = None
    inverter_id: Optional[str] = None
    string_id: Optional[str] = None
    value: Optional[float] = None
    threshold: Optional[float] = None
    message: str = ""
    duration_minutes: Optional[float] = None
    affected_records: int = 0
    # Loss computation metadata
    loss_method: Optional[str] = None  # "reactive_factor", "physics_model", "digital_twin", "rul_prediction"
    loss_formula: Optional[str] = None  # Human-readable formula
    loss_factors: Optional[dict] = None  # Contributing factors as dict
    expected_value: Optional[float] = None  # Expected value for comparison
    actual_value: Optional[float] = None  # Actual measured value

    def to_dict(self) -> dict:
        """Convert alert to dictionary for JSON serialization."""
        def format_ts(ts):
            if ts is None:
                return None
            if hasattr(ts, "isoformat"):
                return ts.isoformat()
            return str(ts)

        return {
            "fault_type": self.fault_type.value,
            "severity": self.severity.value,
            "timestamp_start": format_ts(self.timestamp_start),
            "timestamp_end": format_ts(self.timestamp_end),
            "inverter_id": self.inverter_id,
            "string_id": self.string_id,
            "value": self.value,
            "threshold": self.threshold,
            "message": self.message,
            "duration_minutes": self.duration_minutes,
            "affected_records": self.affected_records,
            "loss_method": self.loss_method,
            "loss_formula": self.loss_formula,
            "loss_factors": self.loss_factors,
            "expected_value": self.expected_value,
            "actual_value": self.actual_value,
        }


@dataclass
class MPPTColumnMapping:
    """Discovered MPPT column mapping for one inverter (v1.5)."""

    inverter_id: str
    current_cols: list[str]  # Input_current_01, Input_current_02, ...
    voltage_cols: list[str]  # U_DC_1, U_DC_2, ...
    n_mppts: int

    def get_paired_columns(self) -> list[tuple[str, str]]:
        """Return (current_col, voltage_col) pairs for power calculation.

        Handles numbering mismatch: Input_current_01 pairs with U_DC_1
        """
        if len(self.voltage_cols) == 1:
            # Shared voltage bus (PVDAQ style)
            return [(c, self.voltage_cols[0]) for c in self.current_cols]
        else:
            # Per-MPPT voltage (Alpha style)
            # Match by index position (current_cols and voltage_cols are pre-sorted)
            return list(zip(self.current_cols, self.voltage_cols[:len(self.current_cols)]))


@dataclass
class BatchDetectionResult:
    """Results from a batch fault detection run."""

    alerts: list[FaultAlert] = field(default_factory=list)
    timestamp_start: Optional[datetime] = None
    timestamp_end: Optional[datetime] = None
    records_processed: int = 0
    detection_time_ms: float = 0.0

    @property
    def n_alerts(self) -> int:
        return len(self.alerts)

    @property
    def n_critical(self) -> int:
        return sum(1 for a in self.alerts if a.severity == FaultSeverity.CRITICAL)

    @property
    def n_warning(self) -> int:
        return sum(1 for a in self.alerts if a.severity == FaultSeverity.WARNING)

    def to_dict(self) -> dict:
        """Convert result to dictionary for JSON serialization."""
        return {
            "summary": {
                "n_alerts": self.n_alerts,
                "n_critical": self.n_critical,
                "n_warning": self.n_warning,
                "records_processed": self.records_processed,
                "detection_time_ms": self.detection_time_ms,
            },
            "time_range": {
                "start": self.timestamp_start.isoformat() if self.timestamp_start else None,
                "end": self.timestamp_end.isoformat() if self.timestamp_end else None,
            },
            "alerts": [a.to_dict() for a in self.alerts],
        }

    def get_alerts_by_severity(self, severity: FaultSeverity) -> list[FaultAlert]:
        """Get alerts filtered by severity."""
        return [a for a in self.alerts if a.severity == severity]

    def get_alerts_by_type(self, fault_type: FaultType) -> list[FaultAlert]:
        """Get alerts filtered by fault type."""
        return [a for a in self.alerts if a.fault_type == fault_type]


class RuleBasedFaultDetector:
    """
    Rule-based fault detection using configurable thresholds.

    Detects 10+ fault types with 90-99% accuracy:
    - Inverter offline, clipping, overtemperature
    - String open circuit, short circuit
    - Tracker stuck, misaligned
    - Grid frequency/voltage issues
    - Communication loss

    Example usage:
        config = FaultDetectionConfig()
        detector = RuleBasedFaultDetector(config)

        # Run hourly batch detection
        result = detector.detect_all(df)

        # Get critical alerts
        critical = result.get_alerts_by_severity(FaultSeverity.CRITICAL)
    """

    def __init__(
        self,
        config: Optional[FaultDetectionConfig] = None,
        component_type: Optional[str] = None,
    ):
        """
        Initialize detector with configuration.

        Args:
            config: Fault detection configuration. Uses defaults if not provided.
            component_type: the device model as recorded in the plant metadata, e.g.
                ``"SUN 2000 - 60 KTL"``. Detectors anchored to a manufacturer
                specification look the model up here and DECLINE TO RUN when it is
                absent, rather than substituting a fleet default. That is deliberate:
                the previous flat 65 C inverter limit sat above the rated envelope of
                the inverter running most of our reference fleet.
        """
        self.config = config or FaultDetectionConfig()
        self._timestamp_col = "timestamp"
        self._component_type = component_type

    def _filter_daylight_only(
        self, df: pl.DataFrame, irradiance_col: str = "irradiance", threshold: float = 200.0
    ) -> pl.DataFrame:
        """
        Filter DataFrame to only include daylight hours.

        This helper method removes nighttime data to prevent false positive fault detections
        during periods when solar production is naturally low or zero.

        Args:
            df: Input DataFrame with timestamp and irradiance columns
            irradiance_col: Column name for irradiance data (default: "irradiance")
            threshold: Minimum irradiance threshold in W/m² (default: 200.0)

        Returns:
            Filtered DataFrame with only daylight records (irradiance > threshold)

        Example:
            >>> df_daylight = self._filter_daylight_only(df, irradiance_col="poa_irradiance", threshold=200.0)
            >>> # Process only daylight data to avoid false positives at dawn/dusk
        """
        if irradiance_col not in df.columns:
            # Try to find irradiance column with different naming
            irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi", "poa"])
            if irradiance_col is None:
                # No irradiance data available, return original DataFrame
                return df

        # Filter to daylight only
        daylight_df = df.filter(pl.col(irradiance_col) > threshold)

        return daylight_df

    def _group_into_discrete_events(
        self,
        df: pl.DataFrame,
        gap_threshold_minutes: int = 60,
        min_records_per_event: int = 2,
    ) -> list[tuple[datetime, datetime, int]]:
        """
        Group qualifying fault records into discrete events based on time gaps.

        Instead of creating one giant alert spanning all occurrences, this groups
        consecutive records into separate events. A new event starts when there's
        a gap > gap_threshold_minutes between records.

        Args:
            df: DataFrame with qualifying fault records (must have timestamp column)
            gap_threshold_minutes: Max gap between records to be same event (default 60 min)
            min_records_per_event: Minimum records to constitute a valid event (default 2)

        Returns:
            List of (start_time, end_time, record_count) tuples for each discrete event
        """
        if df.is_empty() or self._timestamp_col not in df.columns:
            return []

        # Sort by timestamp and get as list
        timestamps = df.sort(self._timestamp_col)[self._timestamp_col].to_list()

        if len(timestamps) < min_records_per_event:
            return []

        events = []
        event_start = timestamps[0]
        event_end = timestamps[0]
        event_count = 1

        for i in range(1, len(timestamps)):
            current_ts = timestamps[i]
            prev_ts = timestamps[i - 1]

            # Calculate gap in minutes - handle different timestamp types
            try:
                if hasattr(current_ts, 'timestamp') and hasattr(prev_ts, 'timestamp'):
                    # Python datetime objects
                    gap_minutes = (current_ts.timestamp() - prev_ts.timestamp()) / 60
                elif hasattr(current_ts, '__sub__'):
                    # Polars datetime or timedelta-capable objects
                    delta = current_ts - prev_ts
                    # Handle timedelta result
                    if hasattr(delta, 'total_seconds'):
                        gap_minutes = delta.total_seconds() / 60
                    elif hasattr(delta, 'seconds'):
                        gap_minutes = (delta.days * 86400 + delta.seconds) / 60
                    else:
                        # Polars returns microseconds for datetime subtraction
                        gap_minutes = delta / 60_000_000  # microseconds to minutes
                else:
                    # Unknown type - assume large gap to split events
                    gap_minutes = gap_threshold_minutes + 1
            except Exception:
                # On any error, assume large gap to be safe
                gap_minutes = gap_threshold_minutes + 1

            if gap_minutes <= gap_threshold_minutes:
                # Continue current event
                event_end = current_ts
                event_count += 1
            else:
                # Gap too large - save current event if valid, start new one
                if event_count >= min_records_per_event:
                    events.append((event_start, event_end, event_count))

                # Start new event
                event_start = current_ts
                event_end = current_ts
                event_count = 1

        # Don't forget the last event
        if event_count >= min_records_per_event:
            events.append((event_start, event_end, event_count))

        return events

    def detect_all(
        self,
        df: pl.DataFrame,
        timestamp_col: str = "timestamp",
        residuals_dir: Optional[Path] = None,
        thermal_residuals_dir: Optional[Path] = None,
        string_residuals_dir: Optional[Path] = None,
        thermal_rul_dir: Optional[Path] = None,
    ) -> BatchDetectionResult:
        """
        Run all fault detections on the input data.

        Args:
            df: Input DataFrame with sensor data
            timestamp_col: Name of timestamp column
            residuals_dir: Optional directory containing power residuals Parquet files
                (e.g., residuals_INV_*.parquet) for digital twin string underperformance detection
            thermal_residuals_dir: Optional directory containing thermal residuals Parquet files
                (e.g., residuals_INV_*_thermal.parquet) for digital twin cooling degradation detection
            string_residuals_dir: Optional directory containing string-level residuals Parquet files
                (e.g., residuals_INV_01.001_string_01.parquet) for digital twin string mismatch detection
            thermal_rul_dir: Optional directory containing trained EnhancedThermalTwin models
                (e.g., thermal_INV_*.pkl) for component life prediction and RUL warnings

        Returns:
            BatchDetectionResult with all detected faults
        """
        import time

        start_time = time.time()
        self._timestamp_col = timestamp_col
        self._residuals_dir = residuals_dir  # Store for use in detection methods

        alerts: list[FaultAlert] = []

        # Run all detection methods
        alerts.extend(self._detect_inverter_offline(df))
        alerts.extend(self._detect_inverter_clipping(df))
        alerts.extend(self._detect_string_open_circuit(df))
        alerts.extend(self._detect_string_short_circuit(df))
        alerts.extend(self._detect_tracker_stuck(df))
        alerts.extend(self._detect_tracker_misaligned(df))
        alerts.extend(self._detect_grid_frequency(df))
        alerts.extend(self._detect_grid_voltage(df))
        alerts.extend(self._detect_overtemperature(df))
        alerts.extend(self._detect_communication_loss(df))

        # v1.4 - New detection methods (Phase 2)
        alerts.extend(self._detect_inverter_efficiency_degradation(df))
        alerts.extend(self._detect_mppt_imbalance(df))
        alerts.extend(self._detect_sensor_frozen(df))
        alerts.extend(self._detect_soiling(df))
        alerts.extend(self._detect_grid_curtailment(df))

        # v1.4 - Additional detection methods (Phase 4)
        alerts.extend(self._detect_dc_voltage_envelope(df))
        alerts.extend(self._detect_mppt_hunting(df))
        alerts.extend(self._detect_string_mismatch_coarse(df))
        alerts.extend(self._detect_bypass_diode(df))
        alerts.extend(self._detect_insulation_resistance(df))
        alerts.extend(self._detect_irradiance_sensor_drift(df))
        alerts.extend(self._detect_vegetation_shading(df))
        alerts.extend(self._detect_communication_partial(df))

        # Digital twin-based detection methods (optional)
        if residuals_dir and residuals_dir.exists():
            # Process all residuals files in directory
            for residuals_file in residuals_dir.glob("residuals_*.parquet"):
                # Skip thermal residuals files (handled separately)
                if "_thermal" not in residuals_file.stem:
                    alerts.extend(self._detect_string_underperformance_dt(residuals_file))

        if thermal_residuals_dir and thermal_residuals_dir.exists():
            # Process all thermal residuals files
            for thermal_file in thermal_residuals_dir.glob("residuals_*_thermal.parquet"):
                alerts.extend(self._detect_inverter_cooling_degradation_dt(thermal_file))

        # String-level digital twin detection (new in Phase 1.5)
        if string_residuals_dir and string_residuals_dir.exists():
            # Process all string residuals files
            for string_file in string_residuals_dir.glob("residuals_INV_*.parquet"):
                alerts.extend(self._detect_string_mismatch_dt(string_file))

        # Thermal RUL-based detection (new in Phase 2.1)
        if thermal_rul_dir and thermal_rul_dir.exists():
            # Process thermal twin models for RUL prediction
            alerts.extend(self._detect_thermal_stress_rul(df, thermal_rul_dir))

        # Build result
        result = BatchDetectionResult(
            alerts=alerts,
            records_processed=len(df),
            detection_time_ms=(time.time() - start_time) * 1000,
        )

        # Set time range
        if timestamp_col in df.columns and len(df) > 0:
            timestamps = df[timestamp_col].to_list()
            result.timestamp_start = min(timestamps)
            result.timestamp_end = max(timestamps)

        return result

    def detect_plant_level(
        self,
        df: pl.DataFrame,
        topology: "PlantTopology",
        *,
        power_for: Optional[dict] = None,
        temperature_for: Optional[dict] = None,
        normalizers: Optional[dict] = None,
        level: str = "inverter_within_bus",
        timestamp_col: str = "timestamp",
    ) -> list[FaultAlert]:
        """Run the rules that need to see MORE THAN ONE DEVICE at a time.

        WHY THIS ENTRY POINT HAD TO EXIST
        ---------------------------------
        ``scripts/run_fault_detection.py`` slices a single inverter's columns and
        renames them before calling :meth:`detect_all`. The detector structurally
        could not see a sibling machine, so every inverter-grain rule had to be
        absolute -- a temperature limit, a power threshold, a voltage window. The
        repo's own artifacts show the cost: the same rule set scores macro-F1
        0.835 in-distribution with thresholds fitted to that dataset, 0.519 with
        untuned physics defaults and 0.189 on a different plant architecture.
        Roughly a third of the in-distribution score was threshold fitting.

        A peer statistic has no portable constant in it. Irradiance, ambient
        temperature, soiling, plant size, module orientation and inverter vendor
        all cancel, because every sibling on the bus meets the same conditions at
        the same instant. The only parameters left are a flag level taken from
        published statistical practice and a dwell window.

        Args:
            topology: from ``parse_component_meta``; supplies the peer groups and
                the nameplate class check that stops a 60 kW machine being scored
                against a 1.5 MW one.
            power_for: device id -> AC power column. Enables peer underperformance.
            temperature_for: device id -> temperature column. Enables peer
                overtemperature, which is what actually catches degraded cooling:
                a blocked filter shows as one machine hot against the siblings
                sharing its ambient, at any ambient, on any plant.
            normalizers: device id -> nameplate kW, for the power comparison. Omit
                when the power columns are already per-unit.
        """
        alerts: list[FaultAlert] = []
        # Event grouping reads this off the instance, as it does in detect_all.
        self._timestamp_col = timestamp_col

        if power_for:
            alerts.extend(self._detect_peer_underperformance(
                df, topology, power_for, normalizers=normalizers,
                level=level, timestamp_col=timestamp_col,
            ))
        if temperature_for:
            alerts.extend(self._detect_peer_overtemperature(
                df, topology, temperature_for,
                level=level, timestamp_col=timestamp_col,
            ))
        return alerts

    def _detect_peer_underperformance(
        self, df, topology, power_for, *, normalizers=None,
        level="inverter_within_bus", timestamp_col="timestamp",
    ) -> list[FaultAlert]:
        """One inverter below the siblings on its bus, sustained."""
        from nuravolt.fault.peer_stats import MIN_PEERS

        cfg = self.config.inverter
        alerts: list[FaultAlert] = []

        for group in topology.usable_peer_groups(level, min_members=MIN_PEERS).values():
            cols = {d: power_for[d] for d in group.population
                    if d in power_for and power_for[d] in df.columns}
            if len(cols) < MIN_PEERS:
                # Loud, because a silent skip here is indistinguishable from a
                # healthy plant. The usual cause is metadata ids and telemetry
                # tokens disagreeing; see topology.resolve_device_columns.
                logger.info(
                    "peer power: bus %s has %d of %d devices mapped to a "
                    "column, below the %d needed; not scored",
                    group.key, len(cols), len(group.population), MIN_PEERS,
                )
                continue

            work = df.select([timestamp_col] + list(cols.values()))
            pu = {}
            for d, col in cols.items():
                scale = (normalizers or {}).get(d)
                name = f"__pu__{d}"
                work = work.with_columns(
                    (pl.col(col) / float(scale)).alias(name) if scale else pl.col(col).alias(name)
                )
                pu[d] = name

            # One shared pass. Scoring each device separately is O(N^2) per row
            # and does not finish on a 150-inverter plant; see sibling_scores_wide.
            scored, mapping = sibling_scores_wide(work, list(pu.values()))

            for d in group.scored:
                if d not in pu:
                    continue
                rc, zc, _ = mapping[pu[d]]
                tripped = sustained(
                    pl.col(rc).is_not_null()
                    & (pl.col(rc) < cfg.peer_underperf_ratio_max)
                    & (pl.col(zc).is_null() | (pl.col(zc) < cfg.peer_underperf_z_max)),
                    cfg.peer_underperf_dwell_intervals,
                )
                hits = scored.filter(tripped)
                if hits.is_empty():
                    continue
                events = self._group_into_discrete_events(
                    hits,
                    gap_threshold_minutes=self.config.mppt.chronic_event_gap_minutes,
                    min_records_per_event=cfg.peer_underperf_dwell_intervals,
                )
                ratio = hits[rc].mean()
                for start, end, n in events:
                    alerts.append(FaultAlert(
                        fault_type=FaultType.INVERTER_UNDERPERFORMANCE_PEER,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=start,
                        timestamp_end=end,
                        inverter_id=d,
                        value=float(ratio) if ratio is not None else 0.0,
                        threshold=cfg.peer_underperf_ratio_max,
                        message=(
                            f"Inverter {d} at {float(ratio):.0%} of the median of its "
                            f"{len(cols) - 1} peers on bus {group.key}, sustained"
                        ),
                        affected_records=n,
                    ))
        return alerts

    def _detect_peer_overtemperature(
        self, df, topology, temperature_for, *,
        level="inverter_within_bus", timestamp_col="timestamp",
    ) -> list[FaultAlert]:
        """One inverter hotter than the siblings sharing its ambient.

        This is the test the absolute limit could never be. Whether 78 C is hot
        depends entirely on what the machines beside it are reading at that
        instant, and no datasheet number knows that.
        """
        from nuravolt.fault.peer_stats import MIN_PEERS

        cfg = self.config.inverter
        alerts: list[FaultAlert] = []

        for group in topology.usable_peer_groups(level, min_members=MIN_PEERS).values():
            cols = {d: temperature_for[d] for d in group.population
                    if d in temperature_for and temperature_for[d] in df.columns}
            if len(cols) < MIN_PEERS:
                # Loud, because a silent skip here is indistinguishable from a
                # healthy plant. The usual cause is metadata ids and telemetry
                # tokens disagreeing; see topology.resolve_device_columns.
                logger.info(
                    "peer temperature: bus %s has %d of %d devices mapped to a "
                    "column, below the %d needed; not scored",
                    group.key, len(cols), len(group.population), MIN_PEERS,
                )
                continue
            work = df.select([timestamp_col] + list(cols.values()))

            scored, mapping = sibling_scores_wide(
                work, list(cols.values()),
                mad_floor=cfg.peer_temp_mad_floor_c,
                # Temperature has no meaningful "is it generating" floor: a cooling
                # fault is most visible at load but the comparison is valid at any
                # ambient, so the gate is disabled rather than borrowed from power.
                min_centre=float("-inf"),
            )

            for d in group.scored:
                if d not in cols:
                    continue
                _, zc, dc = mapping[cols[d]]
                tripped = sustained(
                    pl.col(dc).is_not_null()
                    & (pl.col(dc) >= cfg.peer_temp_excess_c)
                    & (pl.col(zc).is_null() | (pl.col(zc) > self.config.string.peer_z_flag)),
                    cfg.peer_temp_dwell_intervals,
                )
                hits = scored.filter(tripped)
                if hits.is_empty():
                    continue
                events = self._group_into_discrete_events(
                    hits,
                    gap_threshold_minutes=self.config.mppt.chronic_event_gap_minutes,
                    min_records_per_event=cfg.peer_temp_dwell_intervals,
                )
                delta = hits[dc].mean()
                for start, end, n in events:
                    alerts.append(FaultAlert(
                        fault_type=FaultType.INVERTER_OVERTEMPERATURE,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=start,
                        timestamp_end=end,
                        inverter_id=d,
                        value=float(delta) if delta is not None else 0.0,
                        threshold=cfg.peer_temp_excess_c,
                        message=(
                            f"Inverter {d} running {float(delta):.1f}C above the median "
                            f"of its {len(cols) - 1} peers on bus {group.key}, sustained: "
                            f"cooling degradation"
                        ),
                        affected_records=n,
                    ))
        return alerts

    def _try_load_residuals_for_offline(self, df: pl.DataFrame) -> Optional[pl.DataFrame]:
        """Try to load residuals file for offline detection."""
        from pathlib import Path

        if not hasattr(self, '_residuals_dir') or not self._residuals_dir:
            return None

        # Extract inverter ID if available in df
        if "inverter_id" in df.columns:
            inverter_id = df["inverter_id"][0]
        elif hasattr(self, '_current_inverter_id'):
            inverter_id = self._current_inverter_id
        else:
            return None

        # Normalize inverter ID for filename (e.g., "INV 01.001" -> "INV_01_001")
        normalized_id = inverter_id.replace(" ", "_").replace(".", "_").replace("-", "_")

        # Try multiple file patterns
        patterns = [
            f"residuals_{normalized_id}.csv",
            f"residuals_{normalized_id}.parquet",
            f"residuals_{inverter_id}.csv",
            f"residuals_{inverter_id}.parquet",
        ]

        for pattern in patterns:
            residuals_path = Path(self._residuals_dir) / pattern
            if residuals_path.exists():
                try:
                    if residuals_path.suffix == ".csv":
                        residuals_df = pl.read_csv(residuals_path)
                    else:
                        residuals_df = pl.read_parquet(residuals_path)

                    # Ensure timestamp column is datetime (if string, parse it)
                    if "timestamp" in residuals_df.columns:
                        timestamp_dtype = residuals_df["timestamp"].dtype
                        if timestamp_dtype == pl.Utf8 or timestamp_dtype == pl.String:
                            residuals_df = residuals_df.with_columns(
                                pl.col("timestamp").str.strptime(pl.Datetime, "%Y-%m-%d %H:%M:%S").alias("timestamp")
                            )

                    return residuals_df
                except Exception as e:
                    # Debug: print error
                    print(f"  Warning: Failed to load {residuals_path.name}: {e}")
                    continue

        return None

    def _detect_inverter_offline(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect inverters producing zero power during daylight using digital twin residuals.

        Logic: actual ≈ 0 when expected > threshold (PR-based detection)
        Uses DT residuals: actual < 0.01, expected > 0.3, loss_pct > 98%

        Conservative detection to avoid false positives:
        - Tighter threshold: actual < 0.01 (nearly zero production)
        - Higher expected: > 0.3 (clear production expected)
        - Higher loss: > 98% (near-total loss)
        - Focus on recent data: last 30 days only
        - Longer sequences: minimum 4 consecutive records (1 hour)
        """
        alerts = []
        cfg = self.config.inverter

        # Check if this is a residuals dataframe (has actual, expected, loss_pct columns)
        has_actual = "actual" in df.columns
        has_expected = "expected" in df.columns
        has_loss_pct = "loss_pct" in df.columns
        has_irradiance = self._find_column(df, ["poa_irradiance", "irradiance", "ghi", "poa"]) is not None

        # Try loading residuals from residuals_dir if not in df
        if not (has_actual and has_expected and has_loss_pct) and hasattr(self, '_residuals_dir') and self._residuals_dir:
            residuals_df = self._try_load_residuals_for_offline(df)
            if residuals_df is not None:
                # Use loaded residuals instead
                df = residuals_df
                has_actual = "actual" in df.columns
                has_expected = "expected" in df.columns
                has_loss_pct = "loss_pct" in df.columns
                has_irradiance = self._find_column(df, ["poa_irradiance", "irradiance", "ghi", "poa"]) is not None

        if not (has_actual and has_expected and has_loss_pct and has_irradiance):
            # Fall back to raw power-based detection if residuals not available
            return self._detect_inverter_offline_raw_power(df)

        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi", "poa"])

        # Focus on recent data only (last 30 days) to detect current issues, not historical
        if self._timestamp_col in df.columns:
            df = df.sort(self._timestamp_col)
            df = df.tail(30 * 96)  # ~30 days of 15-min data

        # Filter to significant daylight (>200 W/m² to avoid sunrise/sunset)
        significant_daylight = df.filter(pl.col(irradiance_col) > 200)

        if len(significant_daylight) == 0:
            return alerts

        # Detect offline with CONSERVATIVE thresholds:
        # - actual < 0.01 (nearly zero, not just low)
        # - expected > 0.3 (clear production expected)
        # - loss_pct > 98% (near-total loss)
        offline_conditions = significant_daylight.filter(
            (pl.col("actual") < 0.01) &
            (pl.col("expected") > 0.3) &
            (pl.col("loss_pct") > 98)
        )

        if len(offline_conditions) == 0:
            return alerts

        # IMPORTANT: Skip if this looks like a fleet-wide outage or data quality issue
        # If >5% of daylight records show "offline", it's likely not an individual inverter fault
        # but rather grid outages, maintenance, or data collection issues affecting multiple inverters
        offline_ratio = len(offline_conditions) / len(significant_daylight)
        if offline_ratio > 0.05:
            # Too many offline records relative to daylight = skip
            # Real individual inverter failures are rare and isolated, not 5%+ of operation
            return alerts

        # Find continuous offline sequences
        timestamps = offline_conditions[self._timestamp_col].to_list()
        actual_values = offline_conditions["actual"].to_list()
        expected_values = offline_conditions["expected"].to_list()
        loss_pct_values = offline_conditions["loss_pct"].to_list()
        irradiance_values = offline_conditions[irradiance_col].to_list()

        # Group consecutive timestamps (15-min intervals)
        continuous_sequences = []
        current_sequence = []

        for i in range(len(timestamps)):
            if i == 0:
                current_sequence = [i]
            else:
                # Check if timestamps are consecutive (within 20 minutes)
                time_diff = (timestamps[i] - timestamps[i-1]).total_seconds() / 60
                if time_diff <= 20:
                    current_sequence.append(i)
                else:
                    # End of sequence
                    if len(current_sequence) > 0:
                        continuous_sequences.append(current_sequence)
                    current_sequence = [i]

        # Don't forget last sequence
        if len(current_sequence) > 0:
            continuous_sequences.append(current_sequence)

        # Create alerts for sequences >= 1 hour (4 data points) to avoid false positives
        # This ensures we're detecting sustained offline periods, not brief glitches
        min_sequence_length = max(4, cfg.offline_duration_min // 15)

        for sequence in continuous_sequences:
            if len(sequence) >= min_sequence_length:
                seq_timestamps = [timestamps[i] for i in sequence]
                seq_actual = [actual_values[i] for i in sequence]
                seq_expected = [expected_values[i] for i in sequence]
                seq_loss = [loss_pct_values[i] for i in sequence]
                seq_irradiance = [irradiance_values[i] for i in sequence]

                mean_actual = sum(seq_actual) / len(seq_actual)
                mean_expected = sum(seq_expected) / len(seq_expected)
                mean_loss = sum(seq_loss) / len(seq_loss)
                mean_irradiance = sum(seq_irradiance) / len(seq_irradiance)

                # Extract inverter ID from context if available
                inverter_id = "unknown"
                if hasattr(self, '_current_inverter_id'):
                    inverter_id = self._current_inverter_id

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.INVERTER_OFFLINE,
                        severity=FaultSeverity.CRITICAL,
                        timestamp_start=min(seq_timestamps),
                        timestamp_end=max(seq_timestamps),
                        inverter_id=inverter_id,
                        value=mean_actual,
                        threshold=0.05,
                        message=f"Inverter offline: actual={mean_actual:.3f} vs expected={mean_expected:.3f} ({mean_loss:.1f}% loss, irradiance={mean_irradiance:.0f} W/m²)",
                        affected_records=len(sequence),
                    )
                )

        return alerts

    def _detect_inverter_offline_raw_power(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Fallback: Detect offline using raw power data when residuals not available.

        This is the legacy method, only used when DT residuals are not available.
        """
        alerts = []
        cfg = self.config.inverter

        # Find columns
        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi", "poa"])
        if irradiance_col is None:
            return alerts

        # Find AC power columns (one per inverter)
        ac_power_cols = self._find_columns_matching(df, ["ac_power", "ac_kw", "power_ac"])

        if not ac_power_cols:
            # Try single system-level AC power
            ac_col = self._find_column(df, ["ac_power", "power_ac", "ac_kw"])
            if ac_col:
                ac_power_cols = [ac_col]

        if not ac_power_cols:
            return alerts

        # Filter to significant daylight (>200 W/m²)
        significant_daylight = df.filter(pl.col(irradiance_col) > 200)

        if len(significant_daylight) == 0:
            return alerts

        # Check each inverter
        for ac_col in ac_power_cols:
            offline_mask = significant_daylight.select(pl.col(ac_col) <= 0.01).to_series()

            if not offline_mask.any():
                continue

            timestamps = significant_daylight[self._timestamp_col].to_list()
            offline_flags = offline_mask.to_list()

            # Find continuous sequences
            continuous_sequences = []
            current_sequence = []

            for i, (ts, is_offline) in enumerate(zip(timestamps, offline_flags)):
                if is_offline:
                    current_sequence.append(i)
                else:
                    if len(current_sequence) > 0:
                        continuous_sequences.append(current_sequence)
                        current_sequence = []

            if len(current_sequence) > 0:
                continuous_sequences.append(current_sequence)

            # Create alerts for sequences >= 30 minutes
            n_required = max(2, cfg.offline_duration_min // 15)

            for sequence in continuous_sequences:
                if len(sequence) >= n_required:
                    seq_timestamps = [timestamps[i] for i in sequence]

                    alerts.append(
                        FaultAlert(
                            fault_type=FaultType.INVERTER_OFFLINE,
                            severity=FaultSeverity.CRITICAL,
                            timestamp_start=min(seq_timestamps),
                            timestamp_end=max(seq_timestamps),
                            inverter_id=ac_col,
                            value=0.0,
                            threshold=0.01,
                            message=f"Inverter {ac_col} offline during daylight (raw power detection)",
                            affected_records=len(sequence),
                        )
                    )

        return alerts

    def _detect_inverter_clipping(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect inverter power clipping.

        Logic: AC power at rated capacity while DC power > AC * threshold
        """
        alerts = []
        cfg = self.config.inverter

        if self.config.rated_ac_power_kw is None:
            return alerts

        ac_col = self._find_column(df, ["ac_power", "power_ac", "ac_kw"])
        dc_col = self._find_column(df, ["dc_power", "power_dc", "dc_kw"])

        if ac_col is None or dc_col is None:
            return alerts

        rated_ac = self.config.rated_ac_power_kw

        # Clipping: AC near rated AND DC significantly higher
        clipping = df.filter(
            (pl.col(ac_col) > 0.95 * rated_ac)
            & (pl.col(dc_col) > pl.col(ac_col) * cfg.clipping_power_ratio)
        )

        if len(clipping) > 0:
            timestamps = clipping[self._timestamp_col].to_list()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.INVERTER_CLIPPING,
                    severity=FaultSeverity.INFO,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=clipping[dc_col].mean(),
                    threshold=rated_ac * cfg.clipping_power_ratio,
                    message=f"Inverter clipping detected: DC power exceeds AC capacity",
                    affected_records=len(clipping),
                )
            )

        return alerts

    def _detect_string_open_circuit(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect string open circuit faults (daylight hours only).

        Logic: One string current = 0 while other strings > threshold
        Updated: Groups into discrete events instead of one giant spanning alert
        """
        alerts = []
        cfg = self.config.string

        # Find string current columns
        string_current_cols = self._find_columns_matching(
            df, ["string_current", "idc", "i_string", "current_string"]
        )

        string_current_cols = _populated_columns(df, string_current_cols)
        if len(string_current_cols) < 2:
            return alerts

        # STEP 1: Apply daylight filtering first to avoid false positives
        df_daylight = self._filter_daylight_only(df, threshold=cfg.min_daylight_irradiance)

        if df_daylight.is_empty():
            return alerts

        # Check each string against its siblings, RELATIVELY.
        #
        # The previous test was absolute: this string below 0.5 A while the MEAN of
        # the others is above 1.0 A. Two things were wrong with it on real plants.
        #
        # Those amp values are a property of one particular array. On four real
        # plants the rule fired on up to 103.5% of daylight device-intervals, i.e.
        # continuously and on overlapping strings, at 207 times any plausible base
        # rate. A string genuinely open-circuits rarely; it cannot be open on every
        # interval of a five-year record.
        #
        # And the reference was a MEAN, which the failing string itself drags down.
        # With 12 strings on an inverter, one at zero pulls the mean by 8%; several
        # failing together pull it enough to hide each other. The median does not
        # move.
        #
        # The replacement is a peer statistic with no absolute current anywhere in
        # it, so the same rule works on a 3 A residential string and a 15 A utility
        # one. Three parts, all dimensionless:
        #
        #   1. each input divided by its own 99th percentile, so an input with three
        #      strings paralleled into it becomes comparable to one with a single
        #      string;
        #   2. a ratio to the LEAVE-ONE-OUT median of its siblings, so the channel
        #      under test never contributes to the reference it is judged against;
        #   3. the modified z-score of the same comparison, which asks whether that
        #      shortfall is large against how much these siblings normally differ. A
        #      0.04 ratio is unremarkable on an array whose strings routinely spread
        #      that far, and damning on one where they track within 2%.
        #
        # Both must trip, and stay tripped. That conjunction is the point: the ratio
        # alone is noisy at low output, the z alone explodes on a uniform fleet, and
        # neither on its own survives a plant it was not tuned on.
        df_daylight, norm_cols = _self_normalised(df_daylight, string_current_cols)
        if len(norm_cols) < 2:
            return alerts

        for col, norm in zip(string_current_cols, norm_cols):
            # Leave-one-out: the channel under test never contributes to the
            # median it is judged against. With four inputs and one dead, an
            # all-columns median already contains the dead channel and has been
            # pulled toward it.
            df_check, tripped = peer_deficit(
                df_daylight, norm, norm_cols,
                ratio_max=cfg.open_circuit_ratio_max,
                z_max=-cfg.peer_z_flag,
                min_consecutive=cfg.open_circuit_dwell_intervals,
                min_centre=cfg.min_peer_output_pu,
            )
            open_circuit = df_check.filter(tripped)

            # Group into discrete events (chronic gap: an open string stays open)
            events = self._group_into_discrete_events(
                open_circuit,
                gap_threshold_minutes=self.config.mppt.chronic_event_gap_minutes,
                min_records_per_event=max(2, cfg.fault_duration_min // 15)
            )

            # Create alert for each discrete event
            for event_start, event_end, record_count in events:
                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.STRING_OPEN_CIRCUIT,
                        severity=FaultSeverity.CRITICAL,
                        timestamp_start=event_start,
                        timestamp_end=event_end,
                        string_id=col,
                        value=0.0,
                        threshold=cfg.open_circuit_ratio_max,
                        message=(
                            f"String {col} carrying under "
                            f"{cfg.open_circuit_ratio_max:.0%} of its siblings' median "
                            f"current for {cfg.open_circuit_dwell_intervals}+ consecutive "
                            f"daylight intervals: open circuit"
                        ),
                        affected_records=record_count,
                    )
                )

        return alerts

    def _detect_string_short_circuit(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect string short circuit faults (daylight hours only).

        Logic: Voltage collapse (< 70% expected) with current spike
        Updated: Groups into discrete events instead of one giant spanning alert
        """
        alerts = []
        cfg = self.config.string

        # Find string voltage and current columns
        voltage_cols = self._find_columns_matching(df, ["string_voltage", "vdc", "v_string"])
        current_cols = self._find_columns_matching(df, ["string_current", "idc", "i_string"])

        if not voltage_cols or not current_cols:
            return alerts

        # Use first voltage column for simplicity (could expand to per-string)
        v_col = voltage_cols[0]
        i_col = current_cols[0] if current_cols else None

        if v_col is None:
            return alerts

        # STEP 1: Apply daylight filtering first
        df_daylight = self._filter_daylight_only(df, threshold=cfg.min_daylight_irradiance)

        if df_daylight.is_empty():
            return alerts

        # Calculate expected voltage (rolling median)
        df_check = df_daylight.with_columns(
            pl.col(v_col).rolling_median(window_size=12).alias("_v_expected")  # 1-hour window
        )

        # Short circuit: voltage < 70% of expected
        short_circuit = df_check.filter(
            (pl.col("_v_expected").is_not_null())
            & (pl.col(v_col) < pl.col("_v_expected") * cfg.short_circuit_voltage_ratio)
        )

        # Group into discrete events
        events = self._group_into_discrete_events(
            short_circuit,
            gap_threshold_minutes=60,
            min_records_per_event=2
        )

        # Create alert for each discrete event
        for event_start, event_end, record_count in events:
            alerts.append(
                FaultAlert(
                    fault_type=FaultType.STRING_SHORT_CIRCUIT,
                    severity=FaultSeverity.CRITICAL,
                    timestamp_start=event_start,
                    timestamp_end=event_end,
                    string_id=v_col,
                    value=short_circuit[v_col].mean() if len(short_circuit) > 0 else None,
                    threshold=cfg.short_circuit_voltage_ratio,
                    message=f"String voltage collapse detected: voltage < {cfg.short_circuit_voltage_ratio * 100:.0f}% of expected",
                    affected_records=record_count,
                )
            )

        return alerts

    def _detect_string_underperformance_dt(
        self, residuals_path: Path
    ) -> list[FaultAlert]:
        """
        Detect string underperformance using digital twin power residuals.

        Uses actual vs. expected power from digital twin models to identify
        sustained underperformance patterns that indicate degradation or faults.

        Args:
            residuals_path: Path to CSV file with columns:
                - timestamp: datetime
                - actual: actual power (kW)
                - expected: expected power from digital twin (kW)
                - residual: actual - expected (kW)
                - loss_pct: percentage power loss
                - irradiance: irradiance (W/m²)

        Returns:
            List of fault alerts for string underperformance
        """
        alerts = []

        try:
            # Load residuals Parquet
            if not residuals_path.exists():
                return alerts

            df = pl.read_parquet(residuals_path)

            # Validate required columns
            required_cols = ["timestamp", "loss_pct", "irradiance"]
            if not all(col in df.columns for col in required_cols):
                return alerts

            # Apply daylight filtering
            cfg = self.config.string
            df_daylight = df.filter(pl.col("irradiance") > cfg.min_daylight_irradiance)

            if df_daylight.is_empty():
                return alerts

            # Detect sustained underperformance (loss > 10% for 24+ hours)
            underperforming = df_daylight.filter(pl.col("loss_pct") > 10.0)

            if underperforming.is_empty():
                return alerts

            # Group consecutive periods
            # Add time difference column to identify gaps
            underperforming = underperforming.sort("timestamp").with_columns(
                pl.col("timestamp").diff().alias("time_diff")
            )

            # Identify period starts (gaps > 1 hour indicate new period)
            underperforming = underperforming.with_columns(
                (
                    (pl.col("time_diff").is_null())
                    | (pl.col("time_diff") > pl.duration(hours=1))
                ).alias("is_period_start")
            )

            # Assign period IDs
            underperforming = underperforming.with_columns(
                pl.col("is_period_start").cum_sum().alias("period_id")
            )

            # Group by period and calculate statistics
            periods = underperforming.group_by("period_id").agg(
                [
                    pl.col("timestamp").min().alias("start_time"),
                    pl.col("timestamp").max().alias("end_time"),
                    pl.col("loss_pct").mean().alias("avg_loss_pct"),
                    pl.col("loss_pct").max().alias("max_loss_pct"),
                    pl.count().alias("record_count"),
                ]
            )

            # Filter periods with 24+ hours of data (288+ records at 5-min resolution)
            min_records = 288  # 24 hours * 12 records/hour
            significant_periods = periods.filter(pl.col("record_count") >= min_records)

            # Create fault alerts for each significant period
            for row in significant_periods.iter_rows(named=True):
                # Extract equipment ID from path (e.g., residuals_INV-01.045.parquet)
                equipment_id = residuals_path.stem.replace("residuals_", "")

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.STRING_DEGRADATION,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=row["start_time"],
                        timestamp_end=row["end_time"],
                        string_id=equipment_id,
                        value=row["avg_loss_pct"],
                        threshold=10.0,
                        message=f"Digital twin detected sustained string underperformance: {row['avg_loss_pct']:.1f}% average loss over {row['record_count'] / 12:.1f} hours (max: {row['max_loss_pct']:.1f}%)",
                        affected_records=row["record_count"],
                    )
                )

        except Exception as e:
            # Log error but don't fail entire detection
            print(f"Error detecting string underperformance from {residuals_path}: {e}")

        return alerts

    def _detect_inverter_cooling_degradation_dt(
        self, residuals_path: Path
    ) -> list[FaultAlert]:
        """
        Detect inverter cooling system degradation using digital twin thermal residuals.

        Uses thermal twin models to identify sustained temperature deviations that
        indicate cooling system degradation or failure.

        Args:
            residuals_path: Path to CSV file with columns:
                - timestamp: datetime
                - actual_temp: actual inverter temperature (°C)
                - expected_temp: expected temp from thermal twin (°C)
                - thermal_residual: actual_temp - expected_temp (°C)
                - irradiance: irradiance (W/m²)
                - ambient_temp: ambient temperature (°C)

        Returns:
            List of fault alerts for cooling degradation
        """
        alerts = []

        try:
            # Load thermal residuals Parquet
            if not residuals_path.exists():
                return alerts

            df = pl.read_parquet(residuals_path)

            # Validate required columns
            required_cols = ["timestamp", "thermal_residual", "irradiance"]
            if not all(col in df.columns for col in required_cols):
                return alerts

            # Apply daylight filtering
            cfg = self.config.inverter
            df_daylight = df.filter(pl.col("irradiance") > cfg.min_daylight_irradiance)

            if df_daylight.is_empty():
                return alerts

            # Detect sustained cooling degradation (thermal residual > 5°C for 48+ hours)
            cooling_degraded = df_daylight.filter(pl.col("thermal_residual") > 5.0)

            if cooling_degraded.is_empty():
                return alerts

            # Group consecutive periods
            cooling_degraded = cooling_degraded.sort("timestamp").with_columns(
                pl.col("timestamp").diff().alias("time_diff")
            )

            # Identify period starts (gaps > 1 hour)
            cooling_degraded = cooling_degraded.with_columns(
                (
                    (pl.col("time_diff").is_null())
                    | (pl.col("time_diff") > pl.duration(hours=1))
                ).alias("is_period_start")
            )

            # Assign period IDs
            cooling_degraded = cooling_degraded.with_columns(
                pl.col("is_period_start").cum_sum().alias("period_id")
            )

            # Group by period and calculate statistics
            periods = cooling_degraded.group_by("period_id").agg(
                [
                    pl.col("timestamp").min().alias("start_time"),
                    pl.col("timestamp").max().alias("end_time"),
                    pl.col("thermal_residual").mean().alias("avg_residual"),
                    pl.col("thermal_residual").max().alias("max_residual"),
                    pl.count().alias("record_count"),
                ]
            )

            # Filter periods with 48+ hours of data (576+ records at 5-min resolution)
            min_records = 576  # 48 hours * 12 records/hour
            significant_periods = periods.filter(pl.col("record_count") >= min_records)

            # Create fault alerts for each significant period
            for row in significant_periods.iter_rows(named=True):
                # Extract equipment ID from path
                equipment_id = residuals_path.stem.replace("residuals_", "").replace(
                    "_thermal", ""
                )

                # Determine severity based on residual magnitude
                avg_residual = row["avg_residual"]
                if avg_residual > 10.0:
                    severity = FaultSeverity.CRITICAL
                elif avg_residual > 7.5:
                    severity = FaultSeverity.WARNING
                else:
                    severity = FaultSeverity.INFO

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.INVERTER_OVERTEMPERATURE,
                        severity=severity,
                        timestamp_start=row["start_time"],
                        timestamp_end=row["end_time"],
                        inverter_id=equipment_id,
                        value=row["avg_residual"],
                        threshold=5.0,
                        message=f"Digital twin detected cooling system degradation: inverter running {row['avg_residual']:.1f}°C hotter than expected for {row['record_count'] / 12:.1f} hours (max: {row['max_residual']:.1f}°C). Cooling system may need inspection.",
                        affected_records=row["record_count"],
                    )
                )

        except Exception as e:
            # Log error but don't fail entire detection
            print(
                f"Error detecting cooling degradation from {residuals_path}: {e}"
            )

        return alerts

    def _detect_thermal_stress_rul(
        self, df: pl.DataFrame, model_dir: Path
    ) -> list[FaultAlert]:
        """
        Detect thermal stress and predict component failures using RUL estimation.

        Loads trained EnhancedThermalTwin models and estimates remaining useful life
        for capacitors and IGBTs based on thermal stress accumulation.

        Provides predictive alerts with 5-15 day advance warning:
        - Early Warning (7-15 days): RUL < 15 days
        - Critical Warning (2-7 days): RUL < 7 days
        - Imminent Failure (<2 days): RUL < 2 days

        Args:
            df: Input DataFrame with temperature and operating data
            model_dir: Directory containing trained thermal twin models (*.pkl)

        Returns:
            List of fault alerts for thermal stress and low RUL
        """
        alerts = []

        try:
            # Import EnhancedThermalTwin here to avoid circular imports
            from nuravolt.fault.digital_twins import EnhancedThermalTwin

            # Find all thermal twin models
            model_files = list(model_dir.glob("thermal_INV_*.pkl"))

            if not model_files:
                return alerts

            for model_path in model_files:
                try:
                    # Load enhanced thermal twin
                    twin = EnhancedThermalTwin.load_enhanced(model_path)

                    # Get inverter temperature data from df
                    # Try to find matching temperature column
                    inv_id = model_path.stem.replace("thermal_", "")
                    # Build pattern outside f-string to avoid backslash issue
                    inv_pattern = inv_id.replace("_", r"[_\s]+")
                    temp_pattern = rf'{inv_pattern}.*(?:temp|temperature|cabinet)'

                    import re
                    temp_cols = [
                        c for c in df.columns
                        if re.search(temp_pattern, c, re.IGNORECASE)
                    ]

                    if not temp_cols:
                        continue

                    # Create input dataframe with temperature column
                    inv_df = df.select([
                        "timestamp",
                        temp_cols[0],
                    ]).rename({temp_cols[0]: "inverter_temperature"})

                    # Estimate RUL
                    rul_result = twin.estimate_rul(inv_df, temp_col="inverter_temperature")

                    if not rul_result:
                        continue

                    # Generate alerts based on RUL thresholds
                    min_rul = rul_result.min_rul_days

                    # Imminent failure (<2 days)
                    if min_rul < 2.0:
                        severity = FaultSeverity.CRITICAL
                        description = (
                            f"IMMINENT THERMAL FAILURE: RUL < 2 days. "
                            f"Capacitor: {rul_result.capacitor_rul.rul_days:.1f}d, "
                            f"IGBT: {rul_result.igbt_rul.rul_days:.1f}d. "
                            f"Component health: Cap={rul_result.capacitor_rul.current_health*100:.0f}%, "
                            f"IGBT={rul_result.igbt_rul.current_health*100:.0f}%. "
                            f"IMMEDIATE REPLACEMENT REQUIRED."
                        )
                        alerts.append(
                            FaultAlert(
                                fault_type=FaultType.INVERTER_OFFLINE,
                                severity=severity,
                                inverter_id=inv_id,
                                message=description,
                                timestamp_start=rul_result.timestamp,
                                value=min_rul,
                                threshold=RUL_ALERT_HORIZON_DAYS,
                                loss_method="rul_prediction",
                                loss_factors={
                                    "capacitor_rul_days": rul_result.capacitor_rul.rul_days,
                                    "igbt_rul_days": rul_result.igbt_rul.rul_days,
                                    "capacitor_health": rul_result.capacitor_rul.current_health,
                                    "igbt_health": rul_result.igbt_rul.current_health,
                                    "thermal_cycles": rul_result.thermal_stress_metrics.get("thermal_cycles_count", 0),
                                },
                            )
                        )

                    # Critical warning (2-7 days)
                    elif min_rul < 7.0:
                        severity = FaultSeverity.CRITICAL
                        description = (
                            f"Critical thermal stress: RUL = {min_rul:.1f} days. "
                            f"Capacitor: {rul_result.capacitor_rul.rul_days:.1f}d, "
                            f"IGBT: {rul_result.igbt_rul.rul_days:.1f}d. "
                            f"Component health: Cap={rul_result.capacitor_rul.current_health*100:.0f}%, "
                            f"IGBT={rul_result.igbt_rul.current_health*100:.0f}%. "
                            f"Schedule replacement within 7 days."
                        )
                        alerts.append(
                            FaultAlert(
                                fault_type=FaultType.INVERTER_COOLING_DEGRADATION,
                                severity=severity,
                                inverter_id=inv_id,
                                message=description,
                                timestamp_start=rul_result.timestamp,
                                value=min_rul,
                                threshold=RUL_ALERT_HORIZON_DAYS,
                                loss_method="rul_prediction",
                                loss_factors={
                                    "capacitor_rul_days": rul_result.capacitor_rul.rul_days,
                                    "igbt_rul_days": rul_result.igbt_rul.rul_days,
                                    "capacitor_health": rul_result.capacitor_rul.current_health,
                                    "igbt_health": rul_result.igbt_rul.current_health,
                                    "thermal_cycles": rul_result.thermal_stress_metrics.get("thermal_cycles_count", 0),
                                },
                            )
                        )

                    # Early warning (7-15 days)
                    elif min_rul < 15.0:
                        severity = FaultSeverity.WARNING
                        description = (
                            f"Thermal degradation detected: RUL = {min_rul:.1f} days. "
                            f"Capacitor: {rul_result.capacitor_rul.rul_days:.1f}d, "
                            f"IGBT: {rul_result.igbt_rul.rul_days:.1f}d. "
                            f"Component health: Cap={rul_result.capacitor_rul.current_health*100:.0f}%, "
                            f"IGBT={rul_result.igbt_rul.current_health*100:.0f}%. "
                            f"Plan maintenance within 15 days."
                        )
                        alerts.append(
                            FaultAlert(
                                fault_type=FaultType.INVERTER_COOLING_DEGRADATION,
                                severity=severity,
                                inverter_id=inv_id,
                                message=description,
                                timestamp_start=rul_result.timestamp,
                                value=min_rul,
                                threshold=RUL_ALERT_HORIZON_DAYS,
                                loss_method="rul_prediction",
                                loss_factors={
                                    "capacitor_rul_days": rul_result.capacitor_rul.rul_days,
                                    "igbt_rul_days": rul_result.igbt_rul.rul_days,
                                    "capacitor_health": rul_result.capacitor_rul.current_health,
                                    "igbt_health": rul_result.igbt_rul.current_health,
                                    "thermal_cycles": rul_result.thermal_stress_metrics.get("thermal_cycles_count", 0),
                                },
                            )
                        )

                except Exception as e:
                    # Log error but continue with other models
                    print(f"Error processing RUL for {model_path.name}: {e}")
                    continue

        except Exception as e:
            # Log error but don't fail entire detection
            print(f"Error in thermal RUL detection: {e}")

        return alerts

    def _detect_string_mismatch_dt(
        self, residuals_path: Path
    ) -> list[FaultAlert]:
        """
        Detect string-level mismatch and degradation using string-level digital twin residuals.

        Uses string twin models to identify strings underperforming relative to expected current.
        Detects:
        - Mismatch: One string consistently underperforms vs expected
        - Degradation: Gradual decline in string performance over time
        - Partial shading: Time-of-day patterns in residuals

        Args:
            residuals_path: Path to CSV file with columns:
                - timestamp: datetime
                - I_string_expected: expected current from twin (A)
                - string_current: actual string current (A)
                - string_residual: actual - expected (A)
                - string_residual_pct: (actual - expected) / expected * 100
                - irradiance: irradiance (W/m²) (optional)

        Returns:
            List of fault alerts for string mismatch
        """
        alerts = []

        try:
            # Load string residuals Parquet
            if not residuals_path.exists():
                return alerts

            df = pl.read_parquet(residuals_path)

            # Validate required columns
            required_cols = ["timestamp", "string_residual_pct"]
            if not all(col in df.columns for col in required_cols):
                return alerts

            # Apply daylight filtering if irradiance available
            cfg = self.config.string
            if "irradiance" in df.columns:
                df_daylight = df.filter(pl.col("irradiance") > cfg.min_daylight_irradiance)
            else:
                df_daylight = df

            if df_daylight.is_empty():
                return alerts

            # Detect sustained mismatch (underperformance > 15% for 30+ minutes)
            # Negative residual_pct means underperformance
            mismatched = df_daylight.filter(pl.col("string_residual_pct") < -15.0)

            if mismatched.is_empty():
                return alerts

            # Group consecutive periods
            mismatched = mismatched.sort("timestamp").with_columns(
                pl.col("timestamp").diff().alias("time_diff")
            )

            # Identify period starts (gaps > 30 minutes)
            mismatched = mismatched.with_columns(
                (
                    (pl.col("time_diff").is_null())
                    | (pl.col("time_diff") > pl.duration(minutes=30))
                ).alias("is_period_start")
            )

            # Assign period IDs
            mismatched = mismatched.with_columns(
                pl.col("is_period_start").cum_sum().alias("period_id")
            )

            # Group by period and calculate statistics
            periods = mismatched.group_by("period_id").agg(
                [
                    pl.col("timestamp").min().alias("start_time"),
                    pl.col("timestamp").max().alias("end_time"),
                    pl.col("string_residual_pct").mean().alias("avg_residual_pct"),
                    pl.col("string_residual_pct").min().alias("min_residual_pct"),
                    pl.count().alias("record_count"),
                ]
            )

            # Filter periods with 30+ minutes of data (6+ records at 5-min resolution)
            min_records = 6  # 30 minutes at 5-min resolution
            significant_periods = periods.filter(pl.col("record_count") >= min_records)

            # Create fault alerts for each significant period
            for row in significant_periods.iter_rows(named=True):
                # Extract string ID from path (e.g., residuals_INV_01.001_string_01.parquet)
                equipment_id = residuals_path.stem.replace("residuals_", "")

                # Parse string_id from equipment_id
                # Format: INV_01.001_string_01
                if "_string_" in equipment_id:
                    parts = equipment_id.split("_string_")
                    inverter_id = parts[0]
                    string_id = equipment_id
                else:
                    inverter_id = equipment_id
                    string_id = equipment_id

                # Determine severity based on residual magnitude
                avg_residual_pct = abs(row["avg_residual_pct"])
                if avg_residual_pct > 25.0:
                    severity = FaultSeverity.CRITICAL
                    fault_description = "severe mismatch"
                elif avg_residual_pct > 20.0:
                    severity = FaultSeverity.WARNING
                    fault_description = "moderate mismatch"
                else:
                    severity = FaultSeverity.INFO
                    fault_description = "minor mismatch"

                # Calculate duration
                duration_min = row["record_count"] * 5.0  # Assuming 5-min resolution

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.STRING_MISMATCH_COARSE,
                        severity=severity,
                        timestamp_start=row["start_time"],
                        timestamp_end=row["end_time"],
                        inverter_id=inverter_id,
                        string_id=string_id,
                        value=row["avg_residual_pct"],
                        threshold=-15.0,
                        message=f"Digital twin detected string {fault_description}: string performing {avg_residual_pct:.1f}% below expected for {duration_min:.0f} minutes (worst: {abs(row['min_residual_pct']):.1f}%). Possible causes: partial shading, soiling, or string degradation.",
                        affected_records=row["record_count"],
                        duration_minutes=duration_min,
                        loss_method="digital_twin",
                        expected_value=None,  # Would need to load from residuals
                        actual_value=None,
                    )
                )

        except Exception as e:
            # Log error but don't fail entire detection
            print(
                f"Error detecting string mismatch from {residuals_path}: {e}"
            )

        return alerts

    def _detect_tracker_stuck(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect tracker stuck faults.

        Logic: Tracker angle unchanged for extended period during daylight
        """
        alerts = []
        cfg = self.config.tracker

        # Find tracker angle column
        tracker_col = self._find_column(
            df, ["tracker_angle", "tracker_azimuth", "tracker_position", "tilt_angle"]
        )
        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi"])

        if tracker_col is None:
            return alerts

        # Filter to daylight if irradiance available
        if irradiance_col:
            df_check = df.filter(
                pl.col(irradiance_col) > self.config.inverter.min_daylight_irradiance
            )
        else:
            df_check = df

        if len(df_check) == 0:
            return alerts

        # Calculate rolling standard deviation of angle
        window_size = max(1, cfg.stuck_duration_min // 5)  # Convert to records

        df_check = df_check.with_columns(
            pl.col(tracker_col).rolling_std(window_size=window_size).alias("_angle_std")
        )

        # Stuck: very low variation in angle
        stuck = df_check.filter(
            (pl.col("_angle_std").is_not_null())
            & (pl.col("_angle_std") < cfg.min_angle_variation)
        )

        if len(stuck) >= window_size:
            timestamps = stuck[self._timestamp_col].to_list()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.TRACKER_STUCK,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=stuck[tracker_col].mean() if len(stuck) > 0 else None,
                    threshold=cfg.min_angle_variation,
                    message=f"Tracker appears stuck at {stuck[tracker_col].mean():.1f}° for > {cfg.stuck_duration_min} minutes",
                    affected_records=len(stuck),
                )
            )

        return alerts

    def _detect_tracker_misaligned(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect tracker misalignment.

        Logic: Tracker angle deviates significantly from optimal
        Note: Requires solar position calculation or optimal angle column
        """
        alerts = []
        cfg = self.config.tracker

        tracker_col = self._find_column(
            df, ["tracker_angle", "tracker_azimuth", "tracker_position"]
        )
        optimal_col = self._find_column(df, ["optimal_angle", "solar_elevation", "sun_elevation"])

        if tracker_col is None or optimal_col is None:
            return alerts

        # Calculate deviation from optimal
        df_check = df.with_columns(
            (pl.col(tracker_col) - pl.col(optimal_col)).abs().alias("_angle_deviation")
        )

        # Misaligned: deviation > threshold
        misaligned = df_check.filter(pl.col("_angle_deviation") > cfg.max_angle_deviation)

        if len(misaligned) > 0:
            timestamps = misaligned[self._timestamp_col].to_list()
            avg_deviation = misaligned["_angle_deviation"].mean()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.TRACKER_MISALIGNED,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=avg_deviation,
                    threshold=cfg.max_angle_deviation,
                    message=f"Tracker misaligned by avg {avg_deviation:.1f}° from optimal",
                    affected_records=len(misaligned),
                )
            )

        return alerts

    def _detect_grid_frequency(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect grid frequency excursions.

        Logic: Frequency outside nominal ± tolerance
        """
        alerts = []
        cfg = self.config.grid

        freq_col = self._find_column(df, ["grid_frequency", "frequency", "ac_frequency", "freq"])

        if freq_col is None:
            return alerts

        low_threshold = cfg.nominal_frequency - cfg.frequency_tolerance
        high_threshold = cfg.nominal_frequency + cfg.frequency_tolerance

        # Low frequency
        freq_low = df.filter(pl.col(freq_col) < low_threshold)
        if len(freq_low) > 0:
            timestamps = freq_low[self._timestamp_col].to_list()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.GRID_FREQUENCY_LOW,
                    severity=FaultSeverity.CRITICAL,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=freq_low[freq_col].min(),
                    threshold=low_threshold,
                    message=f"Grid underfrequency: {freq_low[freq_col].min():.2f} Hz (< {low_threshold} Hz)",
                    affected_records=len(freq_low),
                )
            )

        # High frequency
        freq_high = df.filter(pl.col(freq_col) > high_threshold)
        if len(freq_high) > 0:
            timestamps = freq_high[self._timestamp_col].to_list()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.GRID_FREQUENCY_HIGH,
                    severity=FaultSeverity.CRITICAL,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=freq_high[freq_col].max(),
                    threshold=high_threshold,
                    message=f"Grid overfrequency: {freq_high[freq_col].max():.2f} Hz (> {high_threshold} Hz)",
                    affected_records=len(freq_high),
                )
            )

        return alerts

    def _detect_grid_voltage(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect grid voltage sags and swells.

        Logic: Voltage outside nominal * sag/swell thresholds
        """
        alerts = []
        cfg = self.config.grid

        voltage_col = self._find_column(df, ["grid_voltage", "ac_voltage", "voltage_ac", "vac"])

        if voltage_col is None:
            return alerts

        sag_threshold = cfg.nominal_voltage * cfg.voltage_sag_threshold
        swell_threshold = cfg.nominal_voltage * cfg.voltage_swell_threshold

        # Voltage sag
        sag = df.filter(pl.col(voltage_col) < sag_threshold)
        if len(sag) > 0:
            timestamps = sag[self._timestamp_col].to_list()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.GRID_VOLTAGE_SAG,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=sag[voltage_col].min(),
                    threshold=sag_threshold,
                    message=f"Grid voltage sag: {sag[voltage_col].min():.1f}V (< {sag_threshold:.0f}V)",
                    affected_records=len(sag),
                )
            )

        # Voltage swell
        swell = df.filter(pl.col(voltage_col) > swell_threshold)
        if len(swell) > 0:
            timestamps = swell[self._timestamp_col].to_list()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.GRID_VOLTAGE_SWELL,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=swell[voltage_col].max(),
                    threshold=swell_threshold,
                    message=f"Grid voltage swell: {swell[voltage_col].max():.1f}V (> {swell_threshold:.0f}V)",
                    affected_records=len(swell),
                )
            )

        return alerts

    #: Cabinet air runs hotter than the ambient air the datasheet rates. This is
    #: the allowance added to a datasheet AMBIENT rating to obtain a CABINET limit.
    #: It is an engineering judgement, stated here rather than buried in a
    #: threshold, and it is the one number in this path that is not from a
    #: manufacturer. Sensitivity to it should be reported alongside any result.
    CABINET_OVER_AMBIENT_C = 15.0

    def _inverter_temp_limit(self) -> tuple:
        """The cabinet temperature limit, from the datasheet where we have one.

        The previous threshold was a flat 65 C. The SUN2000-60KTL, which runs
        roughly 340 of the 452 inverters in our reference fleet, is rated to 60 C
        AMBIENT and begins derating at 45 C. So 65 C sat above the machine's rated
        envelope, and on real plants the rule fired up to 329 times its plausible
        base rate.

        The datasheet numbers are ambient and the signal is cabinet, so they cannot
        be substituted directly. We take the rated maximum ambient and add a stated
        cabinet allowance. Returns (limit, provenance) or (None, reason) when no
        datasheet is available, in which case the caller must decline.
        """
        from nuravolt.fault.device_specs import lookup

        model = getattr(self, "_component_type", None)
        spec = lookup(model) if model else None
        if spec is None or not spec.has_thermal:
            return None, "no datasheet"

        if spec.max_operating_temp_c is not None:
            limit = spec.max_operating_temp_c + self.CABINET_OVER_AMBIENT_C
            return limit, (
                f"{spec.model}: {spec.max_operating_temp_c:.0f}C rated ambient "
                f"+{self.CABINET_OVER_AMBIENT_C:.0f}C cabinet allowance"
            )
        limit = spec.derating_start_temp_c + self.CABINET_OVER_AMBIENT_C
        return limit, f"{spec.model}: derating onset +cabinet allowance"

    def _detect_overtemperature(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect module and inverter overtemperature conditions.
        """
        alerts = []
        cfg = self.config.inverter

        # Module temperature
        module_temp_col = self._find_column(
            df, ["module_temp", "module_temperature", "cell_temp", "panel_temp"]
        )

        if module_temp_col:
            hot = df.filter(pl.col(module_temp_col) > cfg.max_module_temp)

            if len(hot) > 0:
                timestamps = hot[self._timestamp_col].to_list()

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.MODULE_OVERTEMPERATURE,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=min(timestamps),
                        timestamp_end=max(timestamps),
                        value=hot[module_temp_col].max(),
                        threshold=cfg.max_module_temp,
                        message=f"Module overtemperature: {hot[module_temp_col].max():.1f}°C (> {cfg.max_module_temp}°C)",
                        affected_records=len(hot),
                    )
                )

        # Inverter temperature
        inverter_temp_col = self._find_column(
            df, ["inverter_temp", "inverter_temperature", "cabinet_temp"]
        )

        if inverter_temp_col:
            # The datasheet number is a rated AMBIENT; this channel is usually a
            # heatsink or internal reading, and heatsinks are meant to run hot.
            # Without a declaration of what the channel measures the comparison is
            # between two different quantities, so we decline it. See
            # InverterThresholds.temp_channel_semantics -- and note the
            # peer-relative test in detect_plant_level still covers this failure
            # mode, without needing to know the channel's provenance at all.
            if cfg.temp_channel_semantics not in ("cabinet", "ambient"):
                logger.info(
                    "overtemperature: inverter temperature channel %r has "
                    "undeclared semantics (temp_channel_semantics=%r); the "
                    "datasheet limit is a rated ambient and cannot be compared to "
                    "an unknown reading. Declining the absolute test; peer-relative "
                    "thermal detection is unaffected.",
                    inverter_temp_col, cfg.temp_channel_semantics,
                )
                return alerts

            limit, source = self._inverter_temp_limit()
            if limit is None:
                logger.info(
                    "overtemperature: no datasheet thermal rating for device model "
                    "%r; skipping the inverter check rather than substituting a "
                    "fleet default.", getattr(self, "_component_type", None)
                )
                return alerts
            hot = df.filter(pl.col(inverter_temp_col) > limit)

            if len(hot) > 0:
                timestamps = hot[self._timestamp_col].to_list()

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.INVERTER_OVERTEMPERATURE,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=min(timestamps),
                        timestamp_end=max(timestamps),
                        inverter_id=inverter_temp_col,
                        value=hot[inverter_temp_col].max(),
                        threshold=limit,
                        message=f"Inverter overtemperature: {hot[inverter_temp_col].max():.1f}°C (> {limit:.0f}°C, {source})",
                        affected_records=len(hot),
                    )
                )

        return alerts

    def _detect_communication_loss(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect communication/data gaps.

        Logic: Gap between consecutive timestamps > threshold
        """
        alerts = []
        cfg = self.config.communication

        if self._timestamp_col not in df.columns or len(df) < 2:
            return alerts

        # Sort by timestamp and calculate gaps
        df_sorted = df.sort(self._timestamp_col)
        timestamps = df_sorted[self._timestamp_col].to_list()

        # Find gaps
        max_gap_minutes = cfg.loss_duration_min
        gaps = []

        # Convert string timestamps to datetime if needed
        def parse_timestamp(ts):
            if hasattr(ts, "timestamp"):
                return ts
            elif isinstance(ts, str):
                # Try common formats
                for fmt in ["%Y.%m.%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M"]:
                    try:
                        return datetime.strptime(ts, fmt)
                    except ValueError:
                        continue
                return None
            return ts

        parsed_timestamps = [parse_timestamp(ts) for ts in timestamps]

        for i in range(1, len(parsed_timestamps)):
            ts_curr = parsed_timestamps[i]
            ts_prev = parsed_timestamps[i - 1]

            if ts_curr is None or ts_prev is None:
                continue

            if hasattr(ts_curr, "timestamp") or isinstance(ts_curr, datetime):
                # datetime objects
                gap_seconds = (ts_curr - ts_prev).total_seconds()
            elif isinstance(ts_curr, (int, float)):
                # Numeric timestamps in seconds
                gap_seconds = ts_curr - ts_prev
            else:
                continue

            gap_minutes = gap_seconds / 60

            if gap_minutes > max_gap_minutes:
                gaps.append(
                    {
                        "start": timestamps[i - 1],
                        "end": timestamps[i],
                        "gap_minutes": gap_minutes,
                    }
                )

        for gap in gaps:
            alerts.append(
                FaultAlert(
                    fault_type=FaultType.COMMUNICATION_LOSS,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=gap["start"],
                    timestamp_end=gap["end"],
                    value=gap["gap_minutes"],
                    threshold=max_gap_minutes,
                    message=f"Data gap of {gap['gap_minutes']:.0f} minutes detected",
                    duration_minutes=gap["gap_minutes"],
                    affected_records=0,
                )
            )

        return alerts

    # ========================================================================
    # v1.4 - New Detection Methods
    # ========================================================================

    def _detect_inverter_efficiency_degradation(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect inverter efficiency degradation.

        Logic: η = P_AC / P_DC; trigger if η < threshold or declining trend
        """
        alerts = []
        cfg = self.config.efficiency

        ac_col = self._find_column(df, ["ac_power", "power_ac", "ac_kw"])
        dc_col = self._find_column(df, ["dc_power", "power_dc", "dc_kw"])

        if ac_col is None or dc_col is None:
            return alerts

        # Filter for sufficient power (avoid division issues at low power)
        min_power = (self.config.rated_dc_power_kw or 100.0) * cfg.min_power_for_efficiency
        df_check = df.filter(pl.col(dc_col) > min_power)

        if len(df_check) == 0:
            return alerts

        # Calculate efficiency
        df_check = df_check.with_columns(
            (pl.col(ac_col) / pl.col(dc_col)).alias("_efficiency")
        )

        # Filter valid efficiency range (0-1)
        df_check = df_check.filter(
            (pl.col("_efficiency") > 0) & (pl.col("_efficiency") <= 1.0)
        )

        if len(df_check) == 0:
            return alerts

        avg_efficiency = df_check["_efficiency"].mean()

        # Check against threshold
        if avg_efficiency < cfg.min_efficiency_warning:
            timestamps = df_check[self._timestamp_col].to_list()
            severity = (
                FaultSeverity.CRITICAL
                if avg_efficiency < cfg.min_efficiency_critical
                else FaultSeverity.WARNING
            )

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.INVERTER_EFFICIENCY_DEGRADATION,
                    severity=severity,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=avg_efficiency,
                    threshold=cfg.min_efficiency_warning,
                    message=f"Inverter efficiency degradation: {avg_efficiency * 100:.1f}% (< {cfg.min_efficiency_warning * 100:.0f}%)",
                    affected_records=len(df_check),
                )
            )

        return alerts

    def _detect_mppt_imbalance(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect MPPT power imbalance.

        Logic: Coefficient of variation across MPPTs > threshold

        v1.5: Supports Alpha/PVDAQ formats by computing power from I×V.
        """
        alerts = []
        cfg = self.config.mppt

        # First, try pre-computed power columns (backward compatible)
        mppt_cols = self._find_columns_matching(
            df, ["mppt_power", "p_mppt", "mppt_dc", "dc_power_mppt"]
        )

        if len(mppt_cols) >= 2:
            # Use pre-computed power columns
            return self._run_mppt_imbalance_detection(df, mppt_cols, None, cfg)

        # No pre-computed power - try to discover and compute from I×V
        mappings = self._discover_mppt_columns(df)

        if not mappings:
            return alerts

        # Process each inverter separately
        for inv_id, mapping in mappings.items():
            if mapping.n_mppts < 2:
                continue  # Need at least 2 MPPTs to calculate imbalance

            # Compute power columns for this inverter
            df_inv = self._compute_mppt_power(df, mapping)

            # Get the computed power column names
            power_cols = [
                f"_mppt_power_{inv_id}_{i}"
                for i in range(1, mapping.n_mppts + 1)
                if f"_mppt_power_{inv_id}_{i}" in df_inv.columns
            ]

            if len(power_cols) < 2:
                continue

            # Run imbalance detection for this inverter
            inv_alerts = self._run_mppt_imbalance_detection(
                df_inv, power_cols, inv_id, cfg
            )
            alerts.extend(inv_alerts)

        return alerts

    def _run_mppt_imbalance_detection(
        self,
        df: pl.DataFrame,
        mppt_cols: list[str],
        inverter_id: Optional[str],
        cfg,
    ) -> list[FaultAlert]:
        """Core imbalance detection logic (extracted for reuse)."""
        alerts = []

        mppt_cols = _populated_columns(df, mppt_cols)
        if len(mppt_cols) < 2:
            return alerts

        # Filter to daylight
        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi"])
        if irradiance_col:
            df_check = df.filter(
                pl.col(irradiance_col) > self.config.inverter.min_daylight_irradiance
            )
        else:
            df_check = df

        if len(df_check) == 0:
            return alerts

        # Robust dispersion, not (max - min) / (2 * mean).
        #
        # The previous statistic was described as a coefficient-of-variation proxy
        # but is neither a CV nor robust. Its numerator is the full range, so ONE
        # dead MPPT sets it single-handedly, and its denominator is a mean that the
        # same dead MPPT drags down. Both effects push the same way, which is why
        # the rule was active on up to 44% of daylight intervals on real plants,
        # nine times any plausible base rate.
        #
        # The replacement is the median absolute deviation over the sibling median,
        # scaled to be comparable to a standard deviation for normally distributed
        # data (Iglewicz and Hoaglin, ASTM 1993). Median and MAD have a 50 percent
        # breakdown point, so a failing MPPT moves neither. Still dimensionless, so
        # the threshold ports unchanged.
        df_check, norm_cols = _self_normalised(df_check, mppt_cols)
        if len(norm_cols) < 2:
            return alerts
        df_check = df_check.with_columns(
            _median_horizontal(norm_cols).alias("_mppt_median")
        )
        df_check = df_check.with_columns(
            _median_horizontal(
                [(pl.col(c) - pl.col("_mppt_median")).abs().alias(f"_ad_{i}")
                 for i, c in enumerate(norm_cols)]
            ).alias("_mppt_mad")
        )
        df_check = df_check.with_columns(
            pl.when(pl.col("_mppt_median") > 0)
            .then(_MAD_TO_SIGMA * pl.col("_mppt_mad") / pl.col("_mppt_median"))
            .otherwise(None)
            .alias("_mppt_cv")
        )

        # Filter for significant imbalance
        imbalanced = df_check.filter(
            (pl.col("_mppt_cv").is_not_null())
            & (pl.col("_mppt_cv") > cfg.imbalance_cv_warning)
            & (pl.col("_mppt_median") > 0)  # Only when producing
        )

        # Group into discrete events
        events = self._group_into_discrete_events(
            imbalanced,
            gap_threshold_minutes=self.config.mppt.chronic_event_gap_minutes,
            min_records_per_event=4  # At least 1 hour of imbalance
        )

        avg_cv = imbalanced["_mppt_cv"].mean() if len(imbalanced) > 0 else 0

        for event_start, event_end, record_count in events:
            severity = (
                FaultSeverity.CRITICAL
                if avg_cv > cfg.imbalance_cv_critical
                else FaultSeverity.WARNING
            )

            inv_msg = f" (INV {inverter_id})" if inverter_id else ""

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.MPPT_IMBALANCE,
                    severity=severity,
                    timestamp_start=event_start,
                    timestamp_end=event_end,
                    inverter_id=inverter_id,
                    value=avg_cv,
                    threshold=cfg.imbalance_cv_warning,
                    message=f"MPPT power imbalance{inv_msg}: CV = {avg_cv * 100:.1f}% (> {cfg.imbalance_cv_warning * 100:.0f}%)",
                    affected_records=record_count,
                )
            )

        return alerts

    def _detect_sensor_frozen(self, df: pl.DataFrame) -> list[FaultAlert]:
        """Detect a sensor that has stopped changing.

        THE RULE THIS REPLACES FIRED ON SUNSET
        ---------------------------------------
        The previous logic was ``rolling_std(value) < 0.01``, ungated. Plane-of-array
        irradiance sits at exactly zero every night, so the standard deviation is
        exactly zero and the condition is guaranteed. Measured on real plant data:
        **70,581 of 70,581 firings were at irradiance at or below 1 W/m2** -- every
        single one. Across four plants it produced up to 384 alerts per MW per month
        and was the highest-firing rule in the system.

        Two things were wrong and both are fixed here.

        **It was not gated to the period when the signal should be changing.** A
        sensor reading a constant zero at night is working correctly. Each signal now
        declares the condition under which it is expected to vary, and is only judged
        then.

        **The threshold was scale dependent.** ``std < 0.01`` means something quite
        different for irradiance in W/m2 (range 0-1200), a temperature in Celsius
        (range -10 to 90) and a power factor (range -1 to 1). A single absolute
        constant cannot serve all three. The test is now the run length of *exactly
        identical consecutive values*, which is unit free: a real sensor with any
        noise at all does not repeat a float exactly for hours, and a stuck one
        repeats it forever. That makes this rule tier A -- there is no constant to
        port to the next plant.
        """
        alerts = []
        cfg = self.config.sensor_health

        # (column, display name, the condition under which this signal SHOULD vary)
        sensor_patterns = [
            ("poa_irradiance", "POA irradiance", "daylight"),
            ("ambient_temp", "Ambient temperature", "always"),
            ("module_temp", "Module temperature", "always"),
            ("wind_speed", "Wind speed", "always"),
        ]

        window_size = max(1, cfg.frozen_duration_min // 5)  # Records per window

        irradiance_col = self._find_column(
            df, ["poa_irradiance", "irradiance", "ghi", "poa"]
        )

        for col_pattern, display_name, varies_when in sensor_patterns:
            col = self._find_column(df, [col_pattern])
            if col is None:
                continue

            scope = df
            if varies_when == "daylight":
                if irradiance_col is None:
                    # Without an irradiance reference we cannot tell night from a
                    # stuck sensor, so we decline rather than guess.
                    continue
                scope = df.filter(
                    pl.col(irradiance_col) > self.config.inverter.min_daylight_irradiance
                )
                if len(scope) < window_size:
                    continue

            # Run length of EXACTLY identical consecutive values. Unit free, so the
            # same test works for W/m2, degrees C and a dimensionless power factor.
            df_check = scope.with_columns(
                (pl.col(col) != pl.col(col).shift(1)).fill_null(True).cum_sum().alias("_run_id")
            )
            df_check = df_check.with_columns(
                pl.len().over("_run_id").alias("_run_len")
            )

            frozen = df_check.filter(pl.col("_run_len") >= window_size)

            # Group into discrete events
            events = self._group_into_discrete_events(
                frozen, gap_threshold_minutes=60, min_records_per_event=window_size
            )

            frozen_value = frozen[col].mean() if len(frozen) > 0 else None

            for event_start, event_end, record_count in events:
                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.SENSOR_FROZEN,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=event_start,
                        timestamp_end=event_end,
                        value=frozen_value,
                        threshold=float(window_size),
                        message=(
                            f"{display_name} sensor stuck at {frozen_value:.2f} for "
                            f"{record_count} consecutive identical readings "
                            f"(> {cfg.frozen_duration_min} min)"
                        ),
                        affected_records=record_count,
                    )
                )

        return alerts

    def _detect_soiling(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect soiling from PR depression under clear conditions.

        Logic: PR < threshold AND clearsky_ratio ≈ 1.0 (clear conditions)
        """
        alerts = []
        cfg = self.config.soiling

        # Need AC power, irradiance, and ideally clearsky irradiance
        ac_col = self._find_column(df, ["ac_power", "power_ac", "ac_kw"])
        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi"])
        clearsky_col = self._find_column(df, ["clearsky_ghi", "ghi_clearsky", "clearsky_irradiance"])

        if ac_col is None or irradiance_col is None:
            return alerts

        # Filter to sufficient irradiance
        df_check = df.filter(pl.col(irradiance_col) > cfg.min_irradiance_for_soiling)

        if len(df_check) == 0:
            return alerts

        # Calculate PR (simplified: AC / (rated_AC * G / 1000))
        rated_ac = self.config.rated_ac_power_kw or 1000.0  # Default if not set
        df_check = df_check.with_columns(
            (pl.col(ac_col) / (rated_ac * pl.col(irradiance_col) / 1000)).alias("_pr")
        )

        # If clearsky available, filter to clear conditions
        if clearsky_col:
            df_check = df_check.with_columns(
                (pl.col(irradiance_col) / pl.col(clearsky_col)).alias("_clearsky_ratio")
            )
            # Clear conditions: ratio close to 1.0
            df_check = df_check.filter(
                (pl.col("_clearsky_ratio") > 1.0 - cfg.clearsky_ratio_tolerance)
                & (pl.col("_clearsky_ratio") < 1.0 + cfg.clearsky_ratio_tolerance)
            )

        if len(df_check) == 0:
            return alerts

        # Filter valid PR range
        df_check = df_check.filter(
            (pl.col("_pr") > 0) & (pl.col("_pr") < 1.2)
        )

        # Check for low PR indicating soiling
        low_pr = df_check.filter(pl.col("_pr") < cfg.pr_soiling_threshold)

        if len(low_pr) > 0:
            timestamps = low_pr[self._timestamp_col].to_list()
            avg_pr = low_pr["_pr"].mean()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.SOILING_DETECTED,
                    severity=FaultSeverity.INFO,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=avg_pr,
                    threshold=cfg.pr_soiling_threshold,
                    message=f"Soiling suspected: PR = {avg_pr * 100:.1f}% under clear conditions (< {cfg.pr_soiling_threshold * 100:.0f}%)",
                    affected_records=len(low_pr),
                )
            )

        return alerts

    def _detect_grid_curtailment(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect grid curtailment events.

        Logic: Power reduction during high frequency OR export at rated limit
        """
        alerts = []
        cfg = self.config.curtailment

        ac_col = self._find_column(df, ["ac_power", "power_ac", "ac_kw"])
        freq_col = self._find_column(df, ["grid_frequency", "frequency", "ac_frequency"])

        if ac_col is None:
            return alerts

        rated_ac = self.config.rated_ac_power_kw

        # Check frequency-triggered curtailment
        if freq_col is not None:
            nominal = self.config.grid.nominal_frequency
            curtail_freq = nominal + cfg.frequency_curtailment_offset

            freq_curtailed = df.filter(
                (pl.col(freq_col) > curtail_freq)
                & (pl.col(ac_col) > 0)  # Only when producing
            )

            if len(freq_curtailed) >= max(1, cfg.curtailment_duration_min // 5):
                timestamps = freq_curtailed[self._timestamp_col].to_list()

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.GRID_CURTAILMENT,
                        severity=FaultSeverity.INFO,
                        timestamp_start=min(timestamps),
                        timestamp_end=max(timestamps),
                        value=freq_curtailed[freq_col].max(),
                        threshold=curtail_freq,
                        message=f"Grid frequency curtailment active: freq > {curtail_freq:.1f} Hz",
                        affected_records=len(freq_curtailed),
                    )
                )

        # Check export cap (power stuck at limit)
        if rated_ac is not None:
            export_limit = rated_ac * cfg.export_cap_fraction

            # Power consistently at or just below limit
            at_cap = df.filter(
                (pl.col(ac_col) > export_limit * 0.99)
                & (pl.col(ac_col) < export_limit * 1.01)
            )

            # Need sustained period at cap
            window_size = max(1, cfg.curtailment_duration_min // 5)
            if len(at_cap) >= window_size:
                timestamps = at_cap[self._timestamp_col].to_list()

                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.EXPORT_CAP_ACTIVE,
                        severity=FaultSeverity.INFO,
                        timestamp_start=min(timestamps),
                        timestamp_end=max(timestamps),
                        value=at_cap[ac_col].mean(),
                        threshold=export_limit,
                        message=f"Export cap active: power at {export_limit:.0f} kW limit",
                        affected_records=len(at_cap),
                    )
                )

        return alerts

    # ========================================================================
    # v1.4 - Phase 4 Detection Methods
    # ========================================================================

    def _detect_dc_voltage_envelope(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect DC voltage envelope violations (over/under voltage).

        Logic: DC voltage near MPPT limits for sustained period
        """
        alerts = []
        cfg = self.config.dc_voltage

        dc_voltage_col = self._find_column(df, ["dc_voltage", "vdc", "v_dc", "string_voltage"])

        if dc_voltage_col is None:
            return alerts

        # Need rated DC voltage to calculate limits
        # The MPPT window must come from the inverter datasheet. It used to be
        # estimated as ``max(V) * 1.1`` whenever ``rated_dc_voltage_v`` was unset,
        # which is always -- nothing in the repo populates it. That estimate put
        # the undervoltage limit at ``max(V) * 1.155``, above every observed
        # sample, so DC_UNDERVOLTAGE fired on essentially every non-zero daylight
        # record while DC_OVERVOLTAGE could never fire at all. Refuse to guess.
        rated_voltage = self.config.rated_dc_voltage_v
        if rated_voltage is None:
            logger.warning(
                "dc_voltage_envelope: no rated_dc_voltage_v configured; skipping. "
                "Set it from the inverter datasheet MPPT window (e.g. Huawei "
                "SUN2000-60KTL: 200-1000 V operating, 1100 V max input). This "
                "detector will not estimate the limit from the data."
            )
            return alerts

        # Margins are symmetric fractions of rated. The previous code read
        # upper = rated * 0.95 and lower = rated * 1.05, putting the "lower"
        # limit above the "upper" one so that any voltage between them tripped
        # BOTH faults simultaneously.
        margin = abs(1.0 - cfg.upper_margin)
        upper_limit = rated_voltage * (1.0 + margin)
        lower_limit = rated_voltage * (1.0 - margin)

        window_size = max(1, cfg.fault_duration_min // 5)

        # DC Overvoltage - group into discrete events
        overvoltage = df.filter(pl.col(dc_voltage_col) > upper_limit)
        events = self._group_into_discrete_events(
            overvoltage, gap_threshold_minutes=60, min_records_per_event=window_size
        )
        max_voltage = overvoltage[dc_voltage_col].max() if len(overvoltage) > 0 else 0

        for event_start, event_end, record_count in events:
            alerts.append(
                FaultAlert(
                    fault_type=FaultType.DC_OVERVOLTAGE,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=event_start,
                    timestamp_end=event_end,
                    value=max_voltage,
                    threshold=upper_limit,
                    message=f"DC overvoltage: {max_voltage:.1f}V > {upper_limit:.0f}V (MPPT upper limit)",
                    affected_records=record_count,
                )
            )

        # DC Undervoltage - group into discrete events
        undervoltage = df.filter(
            (pl.col(dc_voltage_col) < lower_limit)
            & (pl.col(dc_voltage_col) > 0)  # Exclude zero (offline)
        )
        events = self._group_into_discrete_events(
            undervoltage, gap_threshold_minutes=60, min_records_per_event=window_size
        )
        min_voltage = undervoltage[dc_voltage_col].min() if len(undervoltage) > 0 else 0

        for event_start, event_end, record_count in events:
            alerts.append(
                FaultAlert(
                    fault_type=FaultType.DC_UNDERVOLTAGE,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=event_start,
                    timestamp_end=event_end,
                    value=min_voltage,
                    threshold=lower_limit,
                    message=f"DC undervoltage: {min_voltage:.1f}V < {lower_limit:.0f}V (MPPT lower limit)",
                    affected_records=record_count,
                )
            )

        return alerts

    def _detect_mppt_hunting(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect MPPT hunting/instability.

        Logic: Rapid oscillations in DC voltage indicating unstable tracking

        v1.5: Supports per-MPPT voltage columns (U_DC_1, U_DC_2, etc.).
        """
        alerts = []
        cfg = self.config.mppt

        if len(df) < 12:
            return alerts

        # Try single DC voltage first (backward compatible)
        dc_voltage_col = self._find_column(df, ["dc_voltage", "vdc", "v_dc"])

        if dc_voltage_col is not None:
            return self._run_mppt_hunting_detection(df, dc_voltage_col, None, cfg)

        # Try to discover per-MPPT voltage columns
        mappings = self._discover_mppt_columns(df)

        for inv_id, mapping in mappings.items():
            for volt_col in mapping.voltage_cols:
                if volt_col in df.columns:
                    inv_alerts = self._run_mppt_hunting_detection(
                        df, volt_col, inv_id, cfg
                    )
                    alerts.extend(inv_alerts)

        return alerts

    def _run_mppt_hunting_detection(
        self,
        df: pl.DataFrame,
        voltage_col: str,
        inverter_id: Optional[str],
        cfg,
    ) -> list[FaultAlert]:
        """Core hunting detection logic."""
        alerts = []

        if len(df) < 12:
            return alerts

        # Calculate rate of change (derivative)
        df_check = df.with_columns([
            pl.col(voltage_col).diff().alias("_dv"),
            pl.col(voltage_col).diff().abs().alias("_dv_abs"),
        ])

        # Count sign changes (oscillations) in rolling window
        # Each sign change in derivative indicates direction reversal
        window_size = 12  # 1 hour at 5-min intervals

        df_check = df_check.with_columns([
            (pl.col("_dv") > 0).cast(pl.Int32).alias("_sign"),
        ])

        df_check = df_check.with_columns([
            pl.col("_sign").diff().abs().rolling_sum(window_size=window_size).alias("_oscillations"),
            pl.col("_dv_abs").rolling_mean(window_size=window_size).alias("_avg_amplitude"),
        ])

        # Hunting: many oscillations with significant amplitude
        hunting = df_check.filter(
            (pl.col("_oscillations").is_not_null())
            & (pl.col("_oscillations") > cfg.hunting_count_per_hour)
            & (pl.col("_avg_amplitude") > cfg.hunting_oscillation_threshold)
        )

        if len(hunting) > 0:
            timestamps = hunting[self._timestamp_col].to_list()
            avg_oscillations = hunting["_oscillations"].mean()

            inv_msg = f" (INV {inverter_id})" if inverter_id else ""

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.MPPT_HUNTING,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    inverter_id=inverter_id,
                    value=avg_oscillations,
                    threshold=float(cfg.hunting_count_per_hour),
                    message=f"MPPT hunting{inv_msg}: {avg_oscillations:.0f} oscillations/hour (> {cfg.hunting_count_per_hour})",
                    affected_records=len(hunting),
                )
            )

        return alerts

    def _detect_string_mismatch_coarse(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect coarse string mismatch (single MPPT significantly underperforming).

        Logic: One MPPT < 85% of expected while others normal

        v1.5: Supports Alpha/PVDAQ format by computing power from I×V.
        """
        alerts = []
        cfg = self.config.mppt

        # Try pre-computed MPPT power columns first (backward compatible)
        mppt_cols = self._find_columns_matching(
            df, ["mppt_power", "p_mppt", "mppt_dc", "dc_power_mppt"]
        )

        df_work = df

        # v1.5: If no pre-computed power, discover and compute from I×V
        if len(mppt_cols) < 2:
            discovered = self._discover_mppt_columns(df)
            if discovered:
                # Compute power and use computed columns
                for inv_id, mapping in discovered.items():
                    df_work = self._compute_mppt_power(df_work, mapping)

                # Use computed power columns
                mppt_cols = [c for c in df_work.columns if c.startswith("_mppt_power_")]

        if len(mppt_cols) < 2:
            return alerts

        # Run the core detection logic
        return self._run_string_mismatch_detection(df_work, mppt_cols, cfg)

    def _run_string_mismatch_detection(
        self,
        df: pl.DataFrame,
        mppt_cols: list[str],
        cfg,
    ) -> list[FaultAlert]:
        """Core string mismatch detection logic (v1.5 refactor)."""
        alerts = []

        mppt_cols = _populated_columns(df, mppt_cols)
        if len(mppt_cols) < 2:
            return alerts

        # Filter to daylight
        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi"])
        if irradiance_col:
            df_check = df.filter(
                pl.col(irradiance_col) > self.config.inverter.min_daylight_irradiance
            )
        else:
            df_check = df

        if len(df_check) == 0:
            return alerts

        # Compare each MPPT to the sibling MEDIAN, and require the deficit to be
        # sustained rather than instantaneous.
        #
        # The previous test was a ratio to the sibling MEAN, at a flat 0.85. On real
        # plants it was active on up to 68% of daylight intervals, fourteen times any
        # plausible base rate. Two causes. The mean is pulled down by the very MPPT
        # being judged, so on an inverter with a genuinely weak channel every other
        # channel looks fine and the weak one looks less weak than it is. And a
        # single interval below 0.85 raised an event, so passing cloud shadow across
        # a large array generated alerts continuously.
        #
        # Nor does a flat 0.85 survive a change of plant. On an array whose
        # channels track within 2% a ratio of 0.84 is a screaming anomaly; on one
        # whose channels legitimately spread by 20% -- different tilts, different
        # string counts, a hedge on one side -- it is Tuesday. Only the sibling
        # DISPERSION distinguishes the two, so the ratio now has to clear the
        # modified z-score as well before anything is raised.
        df_check, norm_cols = _self_normalised(df_check, mppt_cols)
        if len(norm_cols) < 2:
            return alerts

        for col, norm in zip(mppt_cols, norm_cols):
            df_scored, tripped = peer_deficit(
                df_check, norm, norm_cols,
                ratio_max=cfg.string_mismatch_threshold,
                z_max=-cfg.peer_z_flag,
                min_consecutive=cfg.mismatch_dwell_intervals,
                min_centre=cfg.min_peer_output_pu,
            )
            mismatch = df_scored.filter(tripped).rename({"_peer_ratio": "_ratio"})

            # Group into discrete events
            events = self._group_into_discrete_events(
                mismatch,
                gap_threshold_minutes=self.config.mppt.chronic_event_gap_minutes,
                min_records_per_event=4,
            )

            avg_ratio = mismatch["_ratio"].mean() if len(mismatch) > 0 else 0

            # Extract MPPT/inverter ID for cleaner messages
            display_id = col
            if col.startswith("_mppt_power_"):
                parts = col.replace("_mppt_power_", "").split("_")
                if len(parts) >= 2:
                    display_id = f"INV {parts[0]} MPPT {parts[1]}"

            for event_start, event_end, record_count in events:
                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.STRING_MISMATCH_COARSE,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=event_start,
                        timestamp_end=event_end,
                        string_id=col,
                        value=avg_ratio,
                        threshold=cfg.string_mismatch_threshold,
                        message=f"String mismatch: {display_id} at {avg_ratio * 100:.0f}% of expected (< {cfg.string_mismatch_threshold * 100:.0f}%)",
                        affected_records=record_count,
                    )
                )

        return alerts

    def _detect_bypass_diode(self, df: pl.DataFrame) -> list[FaultAlert]:
        """Detect a bypass diode conducting on one string.

        WHAT THE PREVIOUS RULE ACTUALLY MEASURED
        ----------------------------------------
        It took the first difference of one string's voltage and fired whenever a
        consecutive pair of samples fell by between 10 and 30 volts. Normal MPPT
        tracking moves string voltage by that much between samples all day, so the
        rule fired on 14.6 to 16.0 percent of daylight intervals across three real
        plants -- roughly 32 times the plausible bound for a failure mode that is
        supposed to be uncommon. It was detecting the maximum power point tracker
        doing its job.

        WHAT A CONDUCTING DIODE ACTUALLY LOOKS LIKE
        -------------------------------------------
        A bypass diode shorts out one substring, so the affected string loses a
        known fraction of its cells and keeps producing on the rest. Three
        consequences, and the rewrite uses all three:

        **It is a LEVEL, not an event.** The string sits low for as long as the
        diode conducts. A first difference sees only the instant of the transition
        and then goes blind, which is why the old rule needed the transition to be
        large and still could not tell it from tracking noise.

        **It is DIFFERENTIAL.** Sibling strings on the same inverter see the same
        irradiance, the same temperature and the same tracking commands. Whatever
        moves them together is not a diode. Only the deficit against the sibling
        median is.

        **It has a CHARACTERISTIC DEPTH.** One diode spans 20 cells of a 60-cell
        module, so it removes 1/(3M) of an M-module string's voltage. That gives a
        band of about 1% to 10% for one to three diodes across realistic string
        lengths -- derived from module construction, dimensionless, and portable.
        A deficit deeper than the band is not a diode; it is mismatch or an open
        string, and those rules claim it instead. That is why this test is a band
        rather than a threshold, and it is what stops this rule and the mismatch
        rule from both firing on the same fault.
        """
        alerts = []
        cfg = self.config.module_health

        voltage_cols = self._find_columns_matching(
            df, ["string_voltage", "vdc", "v_string", "dc_voltage"]
        )
        voltage_cols = _populated_columns(df, voltage_cols)
        if len(voltage_cols) < 2:
            # With one string there is no sibling to compare against, and an
            # absolute voltage test is exactly what failed here. Decline.
            return alerts

        df_daylight = self._filter_daylight_only(
            df, threshold=self.config.inverter.min_daylight_irradiance
        )
        if df_daylight.is_empty():
            return alerts

        # Normalise each string by its own MEDIAN operating voltage rather than a
        # high quantile: the diode deficit is defined against where the string
        # normally sits, and a string with more modules in series legitimately
        # runs higher than its neighbour.
        df_daylight, norm_cols = _self_normalised(df_daylight, voltage_cols, quantile=0.5)
        if len(norm_cols) < 2:
            return alerts

        for col, norm in zip(voltage_cols, norm_cols):
            df_scored, tripped = peer_deficit(
                df_daylight, norm, norm_cols,
                ratio_max=1.0 - cfg.bypass_diode_deficit_pu_min,
                ratio_min=1.0 - cfg.bypass_diode_deficit_pu_max,
                z_max=-self.config.string.peer_z_flag,
                min_consecutive=cfg.bypass_diode_dwell_intervals,
                mad_floor=cfg.bypass_diode_mad_floor_pu,
                min_centre=self.config.string.min_peer_output_pu,
            )
            conducting = df_scored.filter(tripped)
            if conducting.is_empty():
                continue

            events = self._group_into_discrete_events(
                conducting,
                gap_threshold_minutes=self.config.mppt.chronic_event_gap_minutes,
                min_records_per_event=cfg.bypass_diode_dwell_intervals,
            )

            avg_ratio = conducting["_peer_ratio"].mean()
            deficit = (1.0 - avg_ratio) if avg_ratio is not None else 0.0

            for event_start, event_end, record_count in events:
                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.BYPASS_DIODE_ACTIVE,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=event_start,
                        timestamp_end=event_end,
                        string_id=col,
                        value=deficit,
                        threshold=cfg.bypass_diode_deficit_pu_min,
                        message=(
                            f"String {col} holding {deficit:.1%} below its siblings' "
                            f"median voltage, within the one-to-three bypass diode "
                            f"band, for {record_count} intervals"
                        ),
                        affected_records=record_count,
                    )
                )

        return alerts

    def _detect_insulation_resistance(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect low insulation resistance (Riso).

        Logic: Riso < threshold per IEC 62446
        """
        alerts = []
        cfg = self.config.module_health

        riso_col = self._find_column(df, ["riso", "insulation_resistance", "r_iso", "iso_resistance"])

        if riso_col is None:
            return alerts

        # Critical: < 0.5 MΩ
        critical = df.filter(pl.col(riso_col) < cfg.insulation_resistance_critical)
        if len(critical) > 0:
            timestamps = critical[self._timestamp_col].to_list()
            min_riso = critical[riso_col].min()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.INSULATION_RESISTANCE_LOW,
                    severity=FaultSeverity.CRITICAL,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=min_riso,
                    threshold=cfg.insulation_resistance_critical,
                    message=f"Critical insulation fault: Riso = {min_riso:.2f} MΩ (< {cfg.insulation_resistance_critical} MΩ)",
                    affected_records=len(critical),
                )
            )
            return alerts  # Don't double-report warning if critical

        # Warning: < 1.0 MΩ
        warning = df.filter(pl.col(riso_col) < cfg.insulation_resistance_warning)
        if len(warning) > 0:
            timestamps = warning[self._timestamp_col].to_list()
            min_riso = warning[riso_col].min()

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.INSULATION_RESISTANCE_LOW,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=min_riso,
                    threshold=cfg.insulation_resistance_warning,
                    message=f"Low insulation resistance: Riso = {min_riso:.2f} MΩ (< {cfg.insulation_resistance_warning} MΩ)",
                    affected_records=len(warning),
                )
            )

        return alerts

    def _detect_irradiance_sensor_drift(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect irradiance sensor drift from clearsky reference.

        Logic: Consistent deviation from clearsky GHI > threshold
        """
        alerts = []
        cfg = self.config.sensor_health

        measured_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi"])
        clearsky_col = self._find_column(df, ["clearsky_ghi", "ghi_clearsky", "clearsky_irradiance"])

        if measured_col is None or clearsky_col is None:
            return alerts

        # Calculate ratio to clearsky
        df_check = df.with_columns([
            (pl.col(measured_col) / pl.col(clearsky_col)).alias("_clearsky_ratio"),
        ])

        # Filter to high irradiance (clearer comparison)
        df_check = df_check.filter(
            (pl.col(clearsky_col) > 400)  # Only when significant clearsky
            & (pl.col("_clearsky_ratio").is_not_null())
        )

        if len(df_check) < cfg.drift_observation_window:
            return alerts

        # Check for consistent drift
        avg_ratio = df_check["_clearsky_ratio"].mean()
        drift = abs(1.0 - avg_ratio)

        if drift > cfg.irradiance_drift_threshold:
            timestamps = df_check[self._timestamp_col].to_list()

            direction = "high" if avg_ratio > 1.0 else "low"

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.IRRADIANCE_SENSOR_DRIFT,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=avg_ratio,
                    threshold=1.0 + cfg.irradiance_drift_threshold,
                    message=f"Irradiance sensor drift: reading {drift * 100:.1f}% {direction} vs clearsky",
                    affected_records=len(df_check),
                )
            )

        return alerts

    def _detect_vegetation_shading(self, df: pl.DataFrame) -> list[FaultAlert]:
        """
        Detect vegetation shading from AM/PM asymmetry.

        Logic: Consistent power difference between morning and afternoon
        """
        alerts = []
        cfg = self.config.vegetation

        ac_col = self._find_column(df, ["ac_power", "power_ac", "ac_kw"])
        irradiance_col = self._find_column(df, ["poa_irradiance", "irradiance", "ghi"])
        ts_col = self._find_column(df, ["timestamp", "datetime", "time"])

        if ac_col is None or ts_col is None:
            return alerts

        # Need to extract hour from timestamp
        try:
            df_check = df.with_columns([
                pl.col(ts_col).dt.hour().alias("_hour"),
            ])
        except Exception:
            return alerts  # Can't parse timestamps

        # Filter to daylight hours with sufficient irradiance
        if irradiance_col:
            df_check = df_check.filter(pl.col(irradiance_col) > cfg.min_irradiance)

        if len(df_check) == 0:
            return alerts

        # Split into AM (6-11) and PM (13-18)
        am_data = df_check.filter((pl.col("_hour") >= 6) & (pl.col("_hour") <= 11))
        pm_data = df_check.filter((pl.col("_hour") >= 13) & (pl.col("_hour") <= 18))

        if len(am_data) < 10 or len(pm_data) < 10:
            return alerts

        am_mean = am_data[ac_col].mean()
        pm_mean = pm_data[ac_col].mean()

        if am_mean is None or pm_mean is None or am_mean == 0:
            return alerts

        # Calculate asymmetry
        asymmetry = abs(am_mean - pm_mean) / max(am_mean, pm_mean)

        if asymmetry > cfg.asymmetry_threshold:
            timestamps = df_check[self._timestamp_col].to_list()

            lower_period = "AM" if am_mean < pm_mean else "PM"

            alerts.append(
                FaultAlert(
                    fault_type=FaultType.VEGETATION_SHADING,
                    severity=FaultSeverity.WARNING,
                    timestamp_start=min(timestamps),
                    timestamp_end=max(timestamps),
                    value=asymmetry,
                    threshold=cfg.asymmetry_threshold,
                    message=f"Possible vegetation shading: {asymmetry * 100:.1f}% AM/PM asymmetry ({lower_period} reduced)",
                    affected_records=len(df_check),
                )
            )

        return alerts

    def _detect_communication_partial(self, df: pl.DataFrame) -> list[FaultAlert]:
        """Detect some channels dropping out while their siblings keep reporting.

        WHAT THE PREVIOUS RULE MEASURED
        -------------------------------
        The whole-record null percentage of each channel, once, and then a single
        alert spanning the entire record. That is a data-coverage census, not a
        fault detector, and it has two consequences.

        A plant that simply does not instrument a channel -- gamma reports no
        inverter cabinet temperature at all -- scores 100% null on it forever and
        was permanently in alarm. The rule was active on 30.6% of that plant's
        intervals, six times its plausible bound, for a condition that is a fact
        about the commissioning drawing rather than an event anyone can action.

        And because the alert spanned the whole record, a channel that genuinely
        dropped out for one afternoon produced the same alert as one that was never
        wired: no start, no end, nothing to dispatch anyone to.

        WHAT THIS DETECTS INSTEAD
        -------------------------
        A channel that WAS reporting and stopped, while its siblings carried on.
        Both halves matter. The "was reporting" half excludes the unconfigured
        channel. The "while its siblings carried on" half is what makes the loss
        partial -- when everything stops at once that is a plant-wide outage, which
        ``_detect_communication_loss`` already covers, and reporting it twice under
        two names helps nobody.
        """
        alerts = []
        cfg = self.config.communication

        # DEVICE-LOCAL channels only. Irradiance is deliberately absent: it comes
        # from one or two plant pyranometers shared by every inverter, and this
        # detector runs once per inverter. On eta the reference pyranometer is
        # 7.3% null against 0.5% for the inverter channels, so including it turned
        # a single sensor outage into 28 identical alerts and put the rule at 4.5
        # times its plausible bound. One plant-wide event must not be multiplied by
        # the inverter count.
        #
        # The pyranometer is not thereby unmonitored -- sensor_frozen and
        # irradiance_sensor_drift cover it, once, at the plant level where it
        # belongs.
        sensor_cols = [
            self._find_column(df, ["ac_power", "power_ac"]),
            self._find_column(df, ["dc_power", "power_dc"]),
            self._find_column(df, ["inverter_temp", "inverter_temperature"]),
        ]
        sensor_cols = [c for c in dict.fromkeys(sensor_cols) if c is not None]
        if len(sensor_cols) < 2 or len(df) == 0:
            return alerts

        # Drop channels this plant never instrumented. Their absence is a
        # commissioning fact, not a fault, and including them would also poison
        # the "healthy siblings" reference below.
        configured = []
        for col in sensor_cols:
            share = df[col].null_count() / len(df)
            if share > cfg.unconfigured_null_share:
                logger.info(
                    "communication_partial: %s is %.0f%% null across the whole "
                    "record; treating it as never configured on this plant rather "
                    "than as a permanent fault", col, share * 100,
                )
                continue
            configured.append(col)

        if len(configured) < 2:
            return alerts

        window = max(2, cfg.loss_duration_min // 5)
        work = df.with_columns([
            pl.col(c).is_null().cast(pl.Float64)
            .rolling_mean(window_size=window)
            .alias(f"_nullrate_{i}")
            for i, c in enumerate(configured)
        ])

        for i, col in enumerate(configured):
            others = [f"_nullrate_{j}" for j in range(len(configured)) if j != i]
            scoped = work.with_columns(
                _median_horizontal(others).alias("_peer_nullrate")
            )
            dropped = scoped.filter(
                (pl.col(f"_nullrate_{i}") >= cfg.partial_loss_null_share)
                & (pl.col("_peer_nullrate") <= cfg.partial_healthy_null_share)
            )
            if dropped.is_empty():
                continue

            events = self._group_into_discrete_events(
                dropped,
                gap_threshold_minutes=cfg.max_data_gap_min,
                min_records_per_event=window,
            )
            for event_start, event_end, record_count in events:
                alerts.append(
                    FaultAlert(
                        fault_type=FaultType.COMMUNICATION_PARTIAL,
                        severity=FaultSeverity.WARNING,
                        timestamp_start=event_start,
                        timestamp_end=event_end,
                        value=float(record_count),
                        threshold=cfg.partial_loss_null_share,
                        message=(
                            f"{col} stopped reporting for {record_count} intervals "
                            f"while the other channels continued"
                        ),
                        affected_records=record_count,
                    )
                )

        return alerts

    def _find_column(self, df: pl.DataFrame, patterns: list[str]) -> Optional[str]:
        """Find first column matching any pattern (case-insensitive)."""
        df_cols_lower = {c.lower(): c for c in df.columns}

        for pattern in patterns:
            pattern_lower = pattern.lower()

            # Exact match
            if pattern_lower in df_cols_lower:
                return df_cols_lower[pattern_lower]

            # Partial match
            for col_lower, col_original in df_cols_lower.items():
                if pattern_lower in col_lower:
                    return col_original

        return None

    def _find_columns_matching(self, df: pl.DataFrame, patterns: list[str]) -> list[str]:
        """Find all columns matching any pattern."""
        matches = []

        for col in df.columns:
            col_lower = col.lower()
            for pattern in patterns:
                if pattern.lower() in col_lower:
                    matches.append(col)
                    break

        return matches

    # v1.5 - MPPT column discovery for Alpha/PVDAQ formats

    def _discover_mppt_columns(
        self,
        df: pl.DataFrame,
        inverter_filter: Optional[str] = None,
    ) -> dict[str, MPPTColumnMapping]:
        """
        Discover MPPT current/voltage columns from DataFrame.

        Supports multiple data formats:
        1. Alpha format: "INV XX.YYY / Input_current_NN", "INV XX.YYY / U_DC_N"
        2. PVDAQ format: "sos-XX-YYY-inv1-cmbZZ-a__XXXXX", "sos-XX-YYY-inv1-dc-v__XXXXX"
        3. Simple format: "mppt_current_N", "mppt_voltage_N" or "string_current_N"

        Args:
            df: Input DataFrame
            inverter_filter: Optional inverter ID to filter (e.g., "01.001")

        Returns:
            Dict mapping inverter_id -> MPPTColumnMapping
        """
        mappings: dict[str, MPPTColumnMapping] = {}

        # Pattern 1: Alpha format
        # "Alpha (ES): INV 01.001 / Input_current_01 (A)"
        # "Alpha (ES): INV 01.001 / U_DC_1 (V)"
        alpha_current_pattern = re.compile(
            r'INV\s*(\d+\.\d+).*?Input_current_(\d+)',
            re.IGNORECASE
        )
        alpha_voltage_pattern = re.compile(
            r'INV\s*(\d+\.\d+).*?U_DC_(\d+)',
            re.IGNORECASE
        )

        # Pattern 2: PVDAQ format
        # "sos-01-001-inv1-cmb01-a__147309" (combiner current)
        # "sos-01-001-inv1-dc-v__146000" (DC voltage, shared)
        pvdaq_current_pattern = re.compile(
            r'sos-(\d+-\d+)-inv(\d+)-cmb(\d+)-a',
            re.IGNORECASE
        )
        pvdaq_voltage_pattern = re.compile(
            r'sos-(\d+-\d+)-inv(\d+)-dc-v',
            re.IGNORECASE
        )

        # Pattern 3: Simple format
        # "mppt_current_1", "string_current_1", "mppt_voltage_1"
        simple_current_pattern = re.compile(
            r'(?:mppt|string)_current_(\d+)',
            re.IGNORECASE
        )
        simple_voltage_pattern = re.compile(
            r'(?:mppt|string)_voltage_(\d+)',
            re.IGNORECASE
        )

        # Temporary storage for column discovery
        inverter_currents: dict[str, dict[int, str]] = {}
        inverter_voltages: dict[str, dict[int, str]] = {}

        for col in df.columns:
            # Try Alpha format - Current
            match = alpha_current_pattern.search(col)
            if match:
                inv_id = match.group(1)
                mppt_num = int(match.group(2))
                if inv_id not in inverter_currents:
                    inverter_currents[inv_id] = {}
                inverter_currents[inv_id][mppt_num] = col
                continue

            # Try Alpha format - Voltage
            match = alpha_voltage_pattern.search(col)
            if match:
                inv_id = match.group(1)
                mppt_num = int(match.group(2))
                if inv_id not in inverter_voltages:
                    inverter_voltages[inv_id] = {}
                inverter_voltages[inv_id][mppt_num] = col
                continue

            # Try PVDAQ format - Current
            match = pvdaq_current_pattern.search(col)
            if match:
                site_id = match.group(1)
                inv_num = match.group(2)
                cmb_num = int(match.group(3))
                inv_id = f"{site_id}-inv{inv_num}"
                if inv_id not in inverter_currents:
                    inverter_currents[inv_id] = {}
                inverter_currents[inv_id][cmb_num] = col
                continue

            # Try PVDAQ format - Voltage (shared per inverter)
            match = pvdaq_voltage_pattern.search(col)
            if match:
                site_id = match.group(1)
                inv_num = match.group(2)
                inv_id = f"{site_id}-inv{inv_num}"
                if inv_id not in inverter_voltages:
                    inverter_voltages[inv_id] = {}
                inverter_voltages[inv_id][0] = col  # Shared voltage
                continue

            # Try simple format - Current
            match = simple_current_pattern.search(col)
            if match:
                mppt_num = int(match.group(1))
                inv_id = "default"
                if inv_id not in inverter_currents:
                    inverter_currents[inv_id] = {}
                inverter_currents[inv_id][mppt_num] = col
                continue

            # Try simple format - Voltage
            match = simple_voltage_pattern.search(col)
            if match:
                mppt_num = int(match.group(1))
                inv_id = "default"
                if inv_id not in inverter_voltages:
                    inverter_voltages[inv_id] = {}
                inverter_voltages[inv_id][mppt_num] = col
                continue

        # Build mappings
        for inv_id in inverter_currents:
            if inverter_filter and inv_id != inverter_filter:
                continue

            curr_dict = inverter_currents[inv_id]
            volt_dict = inverter_voltages.get(inv_id, {})

            if not volt_dict:
                continue  # Need voltage to compute power

            # Sort by MPPT number to ensure proper pairing
            sorted_currents = [curr_dict[k] for k in sorted(curr_dict.keys())]
            sorted_voltages = [volt_dict[k] for k in sorted(volt_dict.keys())]

            mappings[inv_id] = MPPTColumnMapping(
                inverter_id=inv_id,
                current_cols=sorted_currents,
                voltage_cols=sorted_voltages,
                n_mppts=len(sorted_currents),
            )

        return mappings

    def _compute_mppt_power(
        self,
        df: pl.DataFrame,
        mapping: MPPTColumnMapping,
    ) -> pl.DataFrame:
        """
        Compute MPPT power columns from current and voltage.

        Power = Current × Voltage (P = I × V), converted to kW.

        Args:
            df: Input DataFrame
            mapping: MPPT column mapping for one inverter

        Returns:
            DataFrame with added _mppt_power_{inv}_{n} columns
        """
        pairs = mapping.get_paired_columns()
        power_exprs = []

        for i, (curr_col, volt_col) in enumerate(pairs, start=1):
            if curr_col in df.columns and volt_col in df.columns:
                # P = I × V, convert W to kW
                power_col_name = f"_mppt_power_{mapping.inverter_id}_{i}"
                power_expr = (
                    pl.col(curr_col) * pl.col(volt_col) / 1000.0
                ).alias(power_col_name)
                power_exprs.append(power_expr)

        if power_exprs:
            df = df.with_columns(power_exprs)

        return df
