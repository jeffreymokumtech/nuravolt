"""
Fault Detection Configuration

Configurable thresholds for rule-based fault detection.
All thresholds have sensible defaults calibrated for typical utility-scale plants.
"""

from dataclasses import dataclass, field
from typing import Optional, Union
import json
from pathlib import Path


@dataclass
class InverterThresholds:
    """Thresholds for inverter-level fault detection."""

    # Minimum irradiance to consider daylight (W/m2)
    min_daylight_irradiance: float = 100.0

    # Duration (minutes) before confirming inverter offline
    offline_duration_min: int = 15

    # Clipping detection: DC/AC power ratio threshold
    clipping_power_ratio: float = 1.05

    # Maximum inverter temperature before warning (C)
    max_inverter_temp: float = 65.0

    #: What the inverter temperature channel actually MEASURES. One of
    #: ``"cabinet"``, ``"heatsink"`` or None.
    #:
    #: This matters because the datasheet number is a rated AMBIENT and the
    #: channel is usually neither. On delta the Huawei SUN2000-60KTL
    #: ``/ Temperature`` channel has a 95th percentile of 78.2 C in normal
    #: operation, well above the 60 C rated ambient plus any plausible cabinet
    #: allowance -- because it is a heatsink reading, and heatsinks are supposed
    #: to run hot. Comparing it to an ambient rating fired on 16.7% of intervals,
    #: 167 times the plausible bound.
    #:
    #: When this is None the absolute test DECLINES rather than guessing, and the
    #: peer-relative test in ``detect_plant_level`` carries the detection: an
    #: inverter whose cooling has degraded runs hot against the siblings sharing
    #: its ambient, whatever the channel is wired to.
    temp_channel_semantics: Optional[str] = None

    #: Degrees C above the sibling median before a peer-relative overtemperature
    #: is worth raising. The z carries the statistical portability; this exists
    #: only so a striking but trivial difference is not dispatched.
    peer_temp_excess_c: float = 8.0

    #: Floor on the sibling MAD, in C. Below roughly this, sensor resolution and
    #: quantisation dominate and the z stops meaning anything.
    peer_temp_mad_floor_c: float = 1.5

    #: Consecutive intervals a thermal excess must hold. Cooling degradation is a
    #: standing condition; a single hot sample is telemetry noise.
    peer_temp_dwell_intervals: int = 8

    #: Peer-relative inverter underperformance: output ratio to the sibling
    #: median below which a machine is deficient.
    peer_underperf_ratio_max: float = 0.90

    #: Modified z the same deficit must also clear. Held at 4.0 rather than the
    #: Iglewicz-Hoaglin 3.5 because 4.0 is the value the published fleet null
    #: calibration was measured at (pv/peer_inverter_underperformance_fleet.json:
    #: symmetric-tail false-positive rate 8.8e-06 against a 3.2e-05 theoretical).
    #: Changing it silently would orphan that evidence.
    peer_underperf_z_max: float = -4.0

    #: Consecutive intervals the deficit must hold: two hours at 15-minute data.
    peer_underperf_dwell_intervals: int = 8

    # Maximum module temperature before warning (C)
    max_module_temp: float = 85.0


@dataclass
class StringThresholds:
    """Thresholds for string-level fault detection."""

    # Minimum current to consider string active (A) - Updated to reduce false positives
    min_active_current: float = 0.5

    # Minimum reference current for other strings (A)
    min_reference_current: float = 1.0

    # Duration (minutes) before confirming string fault - Updated for stricter detection
    fault_duration_min: int = 30

    # Minimum irradiance to consider daylight for string detection (W/m²)
    min_daylight_irradiance: float = 200.0

    # Voltage ratio threshold for short circuit detection
    short_circuit_voltage_ratio: float = 0.7

    # Current spike multiplier for short circuit detection
    short_circuit_current_spike: float = 1.5

    #: Tier A, dimensionless. A string carrying less than this share of its
    #: siblings' median current is open. Replaces the absolute
    #: ``min_active_current`` / ``min_reference_current`` pair, whose amp values
    #: were a property of one array and fired on up to 103.5% of daylight
    #: intervals on real plants.
    open_circuit_ratio_max: float = 0.05

    #: Tier A, dimensionless. The sibling group must be producing at least this
    #: share of its own observed maximum before any string is judged against it.
    #: Replaces gating on an absolute reference current.
    min_group_activity_fraction: float = 0.15

    #: Flag level for the modified z-score of a string against its siblings.
    #: Iglewicz and Hoaglin, ASTM E178 / NIST e-Handbook 1.3.5.17. Published
    #: statistical practice rather than a value fitted on our data, which is what
    #: keeps this detector tier A: there is no threshold here to get wrong on the
    #: next plant.
    peer_z_flag: float = 3.5

    #: Per-unit output the sibling median must reach before any comparison is
    #: made. Dimensionless because the channels are self-normalised first, so it
    #: is not an irradiance threshold wearing a disguise.
    #:
    #: 0.50, raised from 0.15 on evidence. At 0.15 the rule was firing on ROW
    #: SHADING, not open circuits: on zeta the trip rate was 7.3% at 08:00,
    #: 7.6% at 09:00 and 7.7% at 15:00 against 1.6% at midday -- a 4.7x
    #: morning-and-afternoon excess. A disconnected string does not reconnect at
    #: noon and disconnect again at 15:00; low sun putting one string behind the
    #: row in front does exactly that.
    #:
    #: Requiring the siblings to be at half capacity before judging anything means
    #: the sun is high enough that inter-row shading has cleared. Sweeping the
    #: gate, the morning/noon excess falls 4.7x -> 1.9x -> 0.0x at 0.15, 0.30 and
    #: 0.50, and the overall trip rate falls 3.67% -> 0.99%. The shading signature
    #: disappears exactly where the physics says it should.
    #:
    #: The cost is not detecting an open circuit while the array is below half
    #: output. A genuinely open string is open at midday too.
    min_peer_output_pu: float = 0.50

    #: Consecutive daylight intervals a string must stay open before it is one.
    #: A single interval at zero is a comms dropout or a sampling artifact; a
    #: genuinely open string is open on the next interval too.
    open_circuit_dwell_intervals: int = 4


@dataclass
class TrackerThresholds:
    """Thresholds for tracker fault detection."""

    # Maximum deviation from optimal angle (degrees)
    max_angle_deviation: float = 10.0

    # Minimum angle variation to consider tracker moving (degrees)
    min_angle_variation: float = 0.1

    # Duration (minutes) before confirming tracker stuck
    stuck_duration_min: int = 30


@dataclass
class GridThresholds:
    """Thresholds for grid-related fault detection."""

    # Nominal grid frequency (Hz) - 50 for EU/Asia, 60 for Americas
    nominal_frequency: float = 50.0

    # Frequency deviation tolerance (Hz)
    frequency_tolerance: float = 0.5

    # Nominal grid voltage (V) - typically 400V for 3-phase LV
    nominal_voltage: float = 400.0

    # Voltage sag threshold (fraction of nominal)
    voltage_sag_threshold: float = 0.9

    # Voltage swell threshold (fraction of nominal)
    voltage_swell_threshold: float = 1.1


@dataclass
class CommunicationThresholds:
    """Thresholds for communication/data quality detection."""

    # Duration (minutes) before confirming communication loss
    loss_duration_min: int = 15

    # Maximum acceptable data gap (minutes)
    max_data_gap_min: int = 30

    #: A channel null for more than this share of the whole record was never
    #: configured on this plant, and its absence is a commissioning fact rather
    #: than a communication fault. Excluding it is the same principle that stops
    #: an unwired string input being reported as an open circuit for five years.
    unconfigured_null_share: float = 0.95

    #: Within a window, the share of samples one channel must be missing before it
    #: counts as having dropped out.
    partial_loss_null_share: float = 0.50

    #: ...while the channels that are still reporting miss no more than this.
    #: The pair is what makes the loss PARTIAL rather than a plant-wide outage,
    #: which _detect_communication_loss already covers.
    partial_healthy_null_share: float = 0.10


@dataclass
class MPPTThresholds:
    """Thresholds for MPPT/PV-side fault detection."""

    # Coefficient of variation threshold for MPPT imbalance warning
    imbalance_cv_warning: float = 0.15

    # Coefficient of variation threshold for MPPT imbalance critical
    imbalance_cv_critical: float = 0.25

    # Voltage oscillation amplitude threshold for hunting detection (V)
    hunting_oscillation_threshold: float = 5.0

    # Number of oscillations per hour to trigger hunting fault
    hunting_count_per_hour: int = 10

    # Single MPPT output threshold as fraction of expected
    string_mismatch_threshold: float = 0.85

    #: Tier A, dimensionless. Intervals a deficit must persist before it counts.
    #: 8 intervals is two hours at 15-minute data. Passing cloud shadow crosses a
    #: large array in minutes; a mismatched string does not move. Without this the
    #: rule was active on up to 68% of daylight intervals.
    mismatch_dwell_intervals: int = 8

    #: Gap tolerated inside one CHRONIC event, in minutes. Seven days by default.
    #:
    #: This is an ALERTING policy, not a detection property. It changes how the
    #: same per-interval decisions are bundled into alerts, and nothing about what
    #: the detector decides. A standing condition -- a string 20% down for years --
    #: should be one alert that stays open, not a fresh one every sunrise; with the
    #: old 60-minute gap it produced tens of thousands.
    #:
    #: Set it small when measuring DETECTION quality against labelled data, so the
    #: score reflects the decisions rather than the bundling. Production keeps the
    #: long default. Conflating the two is how a 98% cut in alert volume can look
    #: like a collapse in F1.
    chronic_event_gap_minutes: int = 7 * 24 * 60

    #: Flag level for the modified z-score of an MPPT against its siblings.
    #: Iglewicz and Hoaglin, ASTM E178. See StringThresholds.peer_z_flag.
    peer_z_flag: float = 3.5

    #: Per-unit output the sibling median must reach before comparing.
    min_peer_output_pu: float = 0.15


@dataclass
class EfficiencyThresholds:
    """Thresholds for inverter efficiency degradation detection."""

    # Minimum efficiency before warning (fraction, 0.92 = 92%)
    min_efficiency_warning: float = 0.92

    # Minimum efficiency before critical (fraction)
    min_efficiency_critical: float = 0.88

    # Weekly decline rate threshold (fraction, 0.005 = 0.5%/week)
    efficiency_decline_rate: float = 0.005

    # Minimum power for efficiency calculation (fraction of rated)
    min_power_for_efficiency: float = 0.20


@dataclass
class ThermalTwinThresholds:
    """Thresholds for thermal digital twin anomaly detection."""

    # Temperature residual warning threshold (°C)
    warning_residual: float = 5.0

    # Temperature residual critical threshold (°C)
    critical_residual: float = 10.0

    # Minimum samples required for anomaly detection
    min_samples_for_detection: int = 6

    # Consecutive anomalies before alerting
    consecutive_anomalies_required: int = 3


@dataclass
class SensorHealthThresholds:
    """Thresholds for sensor health and data quality detection."""

    # Standard deviation threshold for frozen sensor detection
    frozen_std_threshold: float = 0.01

    # Duration (minutes) before confirming frozen sensor
    frozen_duration_min: int = 30

    # Irradiance sensor drift threshold (fraction from clearsky)
    irradiance_drift_threshold: float = 0.05

    # Minimum observations for drift detection
    drift_observation_window: int = 48


@dataclass
class SoilingThresholds:
    """Thresholds for soiling detection."""

    # PR threshold below which soiling is suspected (fraction)
    pr_soiling_threshold: float = 0.95

    # Clearsky ratio tolerance for clear conditions
    clearsky_ratio_tolerance: float = 0.02

    # Minimum irradiance for soiling detection (W/m²)
    min_irradiance_for_soiling: float = 400.0


@dataclass
class CurtailmentThresholds:
    """Thresholds for grid curtailment and export limitation detection."""

    # Frequency threshold for frequency-triggered curtailment (Hz above nominal)
    frequency_curtailment_offset: float = 0.3

    # Minimum duration (minutes) for curtailment confirmation
    curtailment_duration_min: int = 5

    # Export cap detection: fraction of rated power
    export_cap_fraction: float = 0.95


@dataclass
class ModuleHealthThresholds:
    """Thresholds for module-level health detection."""

    # Bypass diode voltage step detection (V)
    #: Tier B, dimensionless. The voltage a string loses when ONE bypass diode
    #: conducts, as a fraction of the string's own operating voltage.
    #:
    #: A diode spans one substring: 20 cells of a 60-cell module. A string of M
    #: modules carries 60*M cells, so one conducting diode removes 1/(3*M) of the
    #: string voltage -- 3.3% at M=10, 1.1% at M=30. Three diodes, a whole module
    #: bypassed, removes 1/M: 10% down to 3.3%. The band below therefore spans one
    #: diode on a long string to three on a short one, and is derived from module
    #: construction rather than fitted to any plant.
    #:
    #: Anything DEEPER than the band is not a diode -- it is mismatch, shading or
    #: an open string, and those rules should claim it. Anything shallower is
    #: noise. This is why the test is a band and not a threshold.
    #:
    #: MEASURED LIMIT: the lower edge is 0.03, not the 0.011 the physics allows,
    #: because a single diode is not detectable in this telemetry. Sampled on
    #: delta, the dispersion between HEALTHY MPPT inputs on one inverter has a
    #: median MAD of 0.0038 per-unit and a p90 of 0.0103 -- so a one-diode deficit
    #: of 1.1% sits inside the normal spread and no threshold separates them. That
    #: is a property of the signal available, not of the rule: U_DC is reported per
    #: MPPT INPUT, and separate inputs are not clamped to a common voltage. Strings
    #: paralleled INSIDE one input do share a voltage, but that is not measured.
    #:
    #: So the rule claims what the data supports: three diodes, or a whole module
    #: bypassed. Detecting a single diode needs string-level voltage behind one
    #: MPPT, which no connector here provides.
    #: The BINDING constraint is the dispersion floor, not the physics. With a
    #: MAD floor of 0.010 the modified z only reaches the 3.5 flag at a deficit of
    #: 0.010 * 3.5 / 0.6745 = 5.19%, so a band starting below that would state a
    #: claim the z gate silently refuses to honour. 0.06 is the first honest edge:
    #: roughly a fully bypassed module on a 20-module string. An invariant test
    #: keeps the two in step.
    bypass_diode_deficit_pu_min: float = 0.06
    bypass_diode_deficit_pu_max: float = 0.15

    #: Consecutive intervals the deficit must hold. A diode conducts for as long
    #: as whatever shades or damages that substring persists, which is minutes at
    #: the very least. A one-interval dip is not a diode.
    bypass_diode_dwell_intervals: int = 4

    #: Floor on the sibling MAD for the voltage comparison, in per-unit.
    #:
    #: Deliberately an order of magnitude below the 0.02 used for currents, and
    #: the reason is physical: paralleled strings on one MPPT input are clamped to
    #: the same voltage by the tracker itself, so their dispersion is genuinely
    #: tiny, whereas their currents differ with soiling, shading and string count.
    #:
    #: Set from the MEASURED p90 of healthy cross-MPPT dispersion (0.0103 on
    #: delta), rounded to 0.010, rather than from an assumption. An earlier
    #: value of 0.002 was justified on the theory that paralleled strings share a
    #: voltage -- true within one MPPT input, false between them, which is what
    #: this comparison actually spans. That error put the rule at 9 to 11 times its
    #: plausible bound on two plants.
    #:
    #: It must also stay below the band's lower edge or the z gate becomes an
    #: unconditional veto and the fault is undetectable by construction. With the
    #: band starting at 0.03 that holds; a test pins it.
    bypass_diode_mad_floor_pu: float = 0.010

    #: Retained: the pre-2026-08 absolute test compared consecutive-sample voltage
    #: DIFFERENCES against these volt values. On real plants that fired on 15 to 16
    #: percent of daylight intervals, 32 times the plausible bound, because normal
    #: MPPT tracking moves string voltage by tens of volts between samples. Kept
    #: only so existing serialised configs still load.
    bypass_diode_voltage_step: float = 10.0

    # Maximum voltage step to consider bypass (V, not whole string open)
    bypass_diode_max_voltage_step: float = 30.0

    # Insulation resistance warning threshold (MΩ) - IEC 62446
    insulation_resistance_warning: float = 1.0

    # Insulation resistance critical threshold (MΩ)
    insulation_resistance_critical: float = 0.5


@dataclass
class VegetationShadingThresholds:
    """Thresholds for vegetation shading detection."""

    # AM/PM asymmetry threshold (fraction)
    asymmetry_threshold: float = 0.10

    # Minimum days of trending asymmetry
    trending_days: int = 7

    # Minimum irradiance for asymmetry calculation (W/m²)
    min_irradiance: float = 200.0


@dataclass
class DCVoltageThresholds:
    """Thresholds for DC voltage envelope violations."""

    # MPPT upper voltage margin (fraction)
    upper_margin: float = 0.95

    # MPPT lower voltage margin (fraction)
    lower_margin: float = 1.05

    # Duration (minutes) for voltage fault confirmation
    fault_duration_min: int = 5


@dataclass
class FaultDetectionConfig:
    """
    Complete configuration for rule-based fault detection.

    Example usage:
        config = FaultDetectionConfig()
        config.grid.nominal_frequency = 60.0  # For US plants
        config.save("plant_config.json")

        # Load from file
        config = FaultDetectionConfig.load("plant_config.json")
    """

    inverter: InverterThresholds = field(default_factory=InverterThresholds)
    string: StringThresholds = field(default_factory=StringThresholds)
    tracker: TrackerThresholds = field(default_factory=TrackerThresholds)
    grid: GridThresholds = field(default_factory=GridThresholds)
    communication: CommunicationThresholds = field(default_factory=CommunicationThresholds)

    # v1.4 - New threshold categories
    mppt: MPPTThresholds = field(default_factory=MPPTThresholds)
    efficiency: EfficiencyThresholds = field(default_factory=EfficiencyThresholds)
    thermal_twin: ThermalTwinThresholds = field(default_factory=ThermalTwinThresholds)
    sensor_health: SensorHealthThresholds = field(default_factory=SensorHealthThresholds)
    soiling: SoilingThresholds = field(default_factory=SoilingThresholds)
    curtailment: CurtailmentThresholds = field(default_factory=CurtailmentThresholds)
    module_health: ModuleHealthThresholds = field(default_factory=ModuleHealthThresholds)
    vegetation: VegetationShadingThresholds = field(default_factory=VegetationShadingThresholds)
    dc_voltage: DCVoltageThresholds = field(default_factory=DCVoltageThresholds)

    # Plant-specific parameters (must be set for each plant)
    rated_dc_power_kw: Optional[float] = None
    rated_ac_power_kw: Optional[float] = None
    rated_dc_voltage_v: Optional[float] = None
    n_strings: Optional[int] = None

    # Batch processing settings
    batch_interval_hours: float = 1.0

    def apply_overrides(self, overrides: dict) -> "FaultDetectionConfig":
        """Apply per-plant threshold overrides (typically from the LLM tuner).

        ``overrides`` shape: ``{section: {field: value}}`` — matches the
        ``TunerResult.overrides_dict`` from ``nuravolt/llm/threshold_tuner.py``.

        Silently ignores:
          - section keys that don't exist on this config (e.g. typo)
          - field names that don't exist on the section (e.g. tuner schema drift)
          - non-numeric values where a number is expected

        Mutates ``self`` in place AND returns self for chaining.
        """
        if not overrides:
            return self
        for section_name, field_overrides in overrides.items():
            section_obj = getattr(self, section_name, None)
            if section_obj is None:
                continue
            for field_name, value in field_overrides.items():
                if not hasattr(section_obj, field_name):
                    continue
                # Preserve original type — coerce floats to int if the
                # default was int
                current = getattr(section_obj, field_name)
                try:
                    coerced = int(value) if isinstance(current, int) and not isinstance(current, bool) else float(value)
                except (TypeError, ValueError):
                    continue
                setattr(section_obj, field_name, coerced)
        return self

    def to_dict(self) -> dict:
        """Convert config to dictionary for JSON serialization."""
        return {
            "inverter": {
                "min_daylight_irradiance": self.inverter.min_daylight_irradiance,
                "offline_duration_min": self.inverter.offline_duration_min,
                "clipping_power_ratio": self.inverter.clipping_power_ratio,
                "max_inverter_temp": self.inverter.max_inverter_temp,
                "max_module_temp": self.inverter.max_module_temp,
            },
            "string": {
                "min_active_current": self.string.min_active_current,
                "min_reference_current": self.string.min_reference_current,
                "fault_duration_min": self.string.fault_duration_min,
                "min_daylight_irradiance": self.string.min_daylight_irradiance,
                "short_circuit_voltage_ratio": self.string.short_circuit_voltage_ratio,
                "short_circuit_current_spike": self.string.short_circuit_current_spike,
            },
            "tracker": {
                "max_angle_deviation": self.tracker.max_angle_deviation,
                "min_angle_variation": self.tracker.min_angle_variation,
                "stuck_duration_min": self.tracker.stuck_duration_min,
            },
            "grid": {
                "nominal_frequency": self.grid.nominal_frequency,
                "frequency_tolerance": self.grid.frequency_tolerance,
                "nominal_voltage": self.grid.nominal_voltage,
                "voltage_sag_threshold": self.grid.voltage_sag_threshold,
                "voltage_swell_threshold": self.grid.voltage_swell_threshold,
            },
            "communication": {
                "loss_duration_min": self.communication.loss_duration_min,
                "max_data_gap_min": self.communication.max_data_gap_min,
            },
            # v1.4 - New threshold categories
            "mppt": {
                "imbalance_cv_warning": self.mppt.imbalance_cv_warning,
                "imbalance_cv_critical": self.mppt.imbalance_cv_critical,
                "hunting_oscillation_threshold": self.mppt.hunting_oscillation_threshold,
                "hunting_count_per_hour": self.mppt.hunting_count_per_hour,
                "string_mismatch_threshold": self.mppt.string_mismatch_threshold,
            },
            "efficiency": {
                "min_efficiency_warning": self.efficiency.min_efficiency_warning,
                "min_efficiency_critical": self.efficiency.min_efficiency_critical,
                "efficiency_decline_rate": self.efficiency.efficiency_decline_rate,
                "min_power_for_efficiency": self.efficiency.min_power_for_efficiency,
            },
            "thermal_twin": {
                "warning_residual": self.thermal_twin.warning_residual,
                "critical_residual": self.thermal_twin.critical_residual,
                "min_samples_for_detection": self.thermal_twin.min_samples_for_detection,
                "consecutive_anomalies_required": self.thermal_twin.consecutive_anomalies_required,
            },
            "sensor_health": {
                "frozen_std_threshold": self.sensor_health.frozen_std_threshold,
                "frozen_duration_min": self.sensor_health.frozen_duration_min,
                "irradiance_drift_threshold": self.sensor_health.irradiance_drift_threshold,
                "drift_observation_window": self.sensor_health.drift_observation_window,
            },
            "soiling": {
                "pr_soiling_threshold": self.soiling.pr_soiling_threshold,
                "clearsky_ratio_tolerance": self.soiling.clearsky_ratio_tolerance,
                "min_irradiance_for_soiling": self.soiling.min_irradiance_for_soiling,
            },
            "curtailment": {
                "frequency_curtailment_offset": self.curtailment.frequency_curtailment_offset,
                "curtailment_duration_min": self.curtailment.curtailment_duration_min,
                "export_cap_fraction": self.curtailment.export_cap_fraction,
            },
            "module_health": {
                "bypass_diode_voltage_step": self.module_health.bypass_diode_voltage_step,
                "bypass_diode_max_voltage_step": self.module_health.bypass_diode_max_voltage_step,
                "insulation_resistance_warning": self.module_health.insulation_resistance_warning,
                "insulation_resistance_critical": self.module_health.insulation_resistance_critical,
            },
            "vegetation": {
                "asymmetry_threshold": self.vegetation.asymmetry_threshold,
                "trending_days": self.vegetation.trending_days,
                "min_irradiance": self.vegetation.min_irradiance,
            },
            "dc_voltage": {
                "upper_margin": self.dc_voltage.upper_margin,
                "lower_margin": self.dc_voltage.lower_margin,
                "fault_duration_min": self.dc_voltage.fault_duration_min,
            },
            "plant": {
                "rated_dc_power_kw": self.rated_dc_power_kw,
                "rated_ac_power_kw": self.rated_ac_power_kw,
                "rated_dc_voltage_v": self.rated_dc_voltage_v,
                "n_strings": self.n_strings,
            },
            "batch_interval_hours": self.batch_interval_hours,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "FaultDetectionConfig":
        """Create config from dictionary."""
        config = cls()

        if "inverter" in data:
            inv = data["inverter"]
            config.inverter = InverterThresholds(
                min_daylight_irradiance=inv.get("min_daylight_irradiance", 100.0),
                offline_duration_min=inv.get("offline_duration_min", 15),
                clipping_power_ratio=inv.get("clipping_power_ratio", 1.05),
                max_inverter_temp=inv.get("max_inverter_temp", 65.0),
                max_module_temp=inv.get("max_module_temp", 85.0),
            )

        if "string" in data:
            s = data["string"]
            config.string = StringThresholds(
                min_active_current=s.get("min_active_current", 0.5),
                min_reference_current=s.get("min_reference_current", 1.0),
                fault_duration_min=s.get("fault_duration_min", 30),
                min_daylight_irradiance=s.get("min_daylight_irradiance", 200.0),
                short_circuit_voltage_ratio=s.get("short_circuit_voltage_ratio", 0.7),
                short_circuit_current_spike=s.get("short_circuit_current_spike", 1.5),
            )

        if "tracker" in data:
            t = data["tracker"]
            config.tracker = TrackerThresholds(
                max_angle_deviation=t.get("max_angle_deviation", 10.0),
                min_angle_variation=t.get("min_angle_variation", 0.1),
                stuck_duration_min=t.get("stuck_duration_min", 30),
            )

        if "grid" in data:
            g = data["grid"]
            config.grid = GridThresholds(
                nominal_frequency=g.get("nominal_frequency", 50.0),
                frequency_tolerance=g.get("frequency_tolerance", 0.5),
                nominal_voltage=g.get("nominal_voltage", 400.0),
                voltage_sag_threshold=g.get("voltage_sag_threshold", 0.9),
                voltage_swell_threshold=g.get("voltage_swell_threshold", 1.1),
            )

        if "communication" in data:
            c = data["communication"]
            config.communication = CommunicationThresholds(
                loss_duration_min=c.get("loss_duration_min", 15),
                max_data_gap_min=c.get("max_data_gap_min", 30),
            )

        # v1.4 - New threshold categories
        if "mppt" in data:
            m = data["mppt"]
            config.mppt = MPPTThresholds(
                imbalance_cv_warning=m.get("imbalance_cv_warning", 0.15),
                imbalance_cv_critical=m.get("imbalance_cv_critical", 0.25),
                hunting_oscillation_threshold=m.get("hunting_oscillation_threshold", 5.0),
                hunting_count_per_hour=m.get("hunting_count_per_hour", 10),
                string_mismatch_threshold=m.get("string_mismatch_threshold", 0.85),
            )

        if "efficiency" in data:
            e = data["efficiency"]
            config.efficiency = EfficiencyThresholds(
                min_efficiency_warning=e.get("min_efficiency_warning", 0.92),
                min_efficiency_critical=e.get("min_efficiency_critical", 0.88),
                efficiency_decline_rate=e.get("efficiency_decline_rate", 0.005),
                min_power_for_efficiency=e.get("min_power_for_efficiency", 0.20),
            )

        if "thermal_twin" in data:
            tt = data["thermal_twin"]
            config.thermal_twin = ThermalTwinThresholds(
                warning_residual=tt.get("warning_residual", 5.0),
                critical_residual=tt.get("critical_residual", 10.0),
                min_samples_for_detection=tt.get("min_samples_for_detection", 6),
                consecutive_anomalies_required=tt.get("consecutive_anomalies_required", 3),
            )

        if "sensor_health" in data:
            sh = data["sensor_health"]
            config.sensor_health = SensorHealthThresholds(
                frozen_std_threshold=sh.get("frozen_std_threshold", 0.01),
                frozen_duration_min=sh.get("frozen_duration_min", 30),
                irradiance_drift_threshold=sh.get("irradiance_drift_threshold", 0.05),
                drift_observation_window=sh.get("drift_observation_window", 48),
            )

        if "soiling" in data:
            so = data["soiling"]
            config.soiling = SoilingThresholds(
                pr_soiling_threshold=so.get("pr_soiling_threshold", 0.95),
                clearsky_ratio_tolerance=so.get("clearsky_ratio_tolerance", 0.02),
                min_irradiance_for_soiling=so.get("min_irradiance_for_soiling", 400.0),
            )

        if "curtailment" in data:
            cu = data["curtailment"]
            config.curtailment = CurtailmentThresholds(
                frequency_curtailment_offset=cu.get("frequency_curtailment_offset", 0.3),
                curtailment_duration_min=cu.get("curtailment_duration_min", 5),
                export_cap_fraction=cu.get("export_cap_fraction", 0.95),
            )

        if "module_health" in data:
            mh = data["module_health"]
            config.module_health = ModuleHealthThresholds(
                bypass_diode_voltage_step=mh.get("bypass_diode_voltage_step", 10.0),
                bypass_diode_max_voltage_step=mh.get("bypass_diode_max_voltage_step", 30.0),
                insulation_resistance_warning=mh.get("insulation_resistance_warning", 1.0),
                insulation_resistance_critical=mh.get("insulation_resistance_critical", 0.5),
            )

        if "vegetation" in data:
            v = data["vegetation"]
            config.vegetation = VegetationShadingThresholds(
                asymmetry_threshold=v.get("asymmetry_threshold", 0.10),
                trending_days=v.get("trending_days", 7),
                min_irradiance=v.get("min_irradiance", 200.0),
            )

        if "dc_voltage" in data:
            dv = data["dc_voltage"]
            config.dc_voltage = DCVoltageThresholds(
                upper_margin=dv.get("upper_margin", 0.95),
                lower_margin=dv.get("lower_margin", 1.05),
                fault_duration_min=dv.get("fault_duration_min", 5),
            )

        if "plant" in data:
            p = data["plant"]
            config.rated_dc_power_kw = p.get("rated_dc_power_kw")
            config.rated_ac_power_kw = p.get("rated_ac_power_kw")
            config.rated_dc_voltage_v = p.get("rated_dc_voltage_v")
            config.n_strings = p.get("n_strings")

        config.batch_interval_hours = data.get("batch_interval_hours", 1.0)

        return config

    def save(self, path: Union[str, Path]) -> None:
        """Save config to JSON file."""
        path = Path(path)
        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "FaultDetectionConfig":
        """Load config from JSON file."""
        path = Path(path)
        with open(path) as f:
            data = json.load(f)
        return cls.from_dict(data)

    @classmethod
    def for_us_plant(cls) -> "FaultDetectionConfig":
        """Create config with US defaults (60Hz grid)."""
        config = cls()
        config.grid.nominal_frequency = 60.0
        config.grid.frequency_tolerance = 0.5
        return config

    @classmethod
    def for_eu_plant(cls) -> "FaultDetectionConfig":
        """Create config with EU defaults (50Hz grid)."""
        config = cls()
        config.grid.nominal_frequency = 50.0
        config.grid.frequency_tolerance = 0.5
        return config
