"""
Thermal Monitoring and Runaway Prediction Module

Multi-tier approach for battery thermal safety:
- Tier 1: Rule-based thresholds (no ML)
- Tier 2: Statistical anomaly detection (light ML)
- Tier 3: Deep learning prediction (LSTM)

Transfer pattern from: nuravolt/digitaltwin/anomaly_detector.py

WHAT WORKS AT WHICH GRAIN
-------------------------
Asset grain, works from an OEM cloud API today: absolute temperature thresholds
and rate of change. ``check_cell`` does not care that its input is a pack, and
labels its own output with the grain it was given so nothing downstream can
mistake a pack average for a cell reading.

Sub asset grain, needs rack level telemetry: temperature and voltage spread
across modules, and SoC divergence between racks. Those live in
``nuravolt.bess.imbalance``. Where the data is absent the answer is
"requires rack level telemetry", never a zero.

WHAT THIS IS NOT
----------------
Cloud poll cadence is 5 to 15 minutes. Thermal runaway propagates in seconds to
minutes. Everything here is a trend and margin indicator; ``safety_disclosure``
carries the exact wording every surface must publish alongside it.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple
import numpy as np


# --- Disclosure ------------------------------------------------------------

#: Canonical disclosure. Exported so the API, the UI and the PDF report share
#: one wording instead of each paraphrasing it. Formatted with the telemetry
#: interval so the reader can see how coarse the input actually is.
SAFETY_DISCLOSURE_TEMPLATE = (
    "State of safety is a trend and margin indicator computed from {interval} "
    "cloud telemetry. It is not a protection system and must not be relied on "
    "for emergency response. Your BMS and fire detection system are."
)


def safety_disclosure(interval_minutes: Optional[float] = None) -> str:
    """
    The disclosure string, with the poll cadence filled in.

    Pass None when the cadence is unknown; the sentence stays true rather than
    naming an interval we cannot evidence.
    """
    if interval_minutes is None or not np.isfinite(interval_minutes) or interval_minutes <= 0:
        interval = "periodic"
    elif float(interval_minutes).is_integer():
        interval = f"{int(interval_minutes)} minute"
    else:
        interval = f"{interval_minutes:g} minute"
    return SAFETY_DISCLOSURE_TEMPLATE.format(interval=interval)


@dataclass
class ThermalThresholds:
    """Configurable thermal thresholds"""
    temp_warning: float = 45.0        # °C - Warning threshold
    temp_critical: float = 60.0       # °C - Critical threshold
    temp_rate_warning: float = 1.0    # °C/min - Rate of change
    temp_rate_critical: float = 5.0   # °C/min - Critical rate
    temp_gradient: float = 5.0        # °C - Max cell-to-cell difference
    voltage_deviation: float = 0.05   # 5% from expected


@dataclass
class ThermalAlert:
    """
    Thermal alert result.

    `temp_rate` and `temp_gradient` are Optional and stay None when the caller
    did not supply them. A zero would read as "measured, and flat", which is the
    opposite of what an absent channel means.
    """
    level: str  # 'normal', 'warning', 'critical'
    reasons: list
    temperature: float
    temp_rate: Optional[float] = None
    temp_gradient: Optional[float] = None
    recommended_action: str = ""
    #: 'cell' | 'module' | 'rack' | 'pack' | 'asset' - what was actually read.
    grain: str = "cell"


class ThermalRuleBasedMonitor:
    """
    Tier 1: Simple threshold-based thermal monitoring.
    No ML required - immediate deployment.

    Example:
        monitor = ThermalRuleBasedMonitor()
        alert = monitor.check_cell({
            'temperature': 55.0,
            'temp_rate': 0.5,
            'temp_gradient': 3.0,
            'voltage': 3.65
        })
        if alert.level == 'critical':
            trigger_emergency_shutdown()
    """

    def __init__(self, thresholds: Optional[ThermalThresholds] = None):
        self.thresholds = thresholds or ThermalThresholds()

    def check_cell(self, cell_data: dict, grain: str = "cell") -> ThermalAlert:
        """
        Check one thermal reading for anomalies.

        The absolute and rate checks are grain agnostic: a pack or container
        temperature from an OEM cloud API is a valid input and is what most
        assets can actually supply. Pass `grain` so the result says what it read.

        Args:
            cell_data: Dict with 'temperature', and optionally 'temp_rate',
                      'temp_gradient', 'voltage', 'expected_voltage'. Keys that
                      are absent are treated as unmeasured, not as zero.
            grain: 'cell' | 'module' | 'rack' | 'pack' | 'asset'

        Returns:
            ThermalAlert with level and reasons
        """
        alerts = []
        level = 'normal'
        temp = cell_data.get('temperature', 0)
        temp_rate = cell_data.get('temp_rate')
        temp_gradient = cell_data.get('temp_gradient')

        # Temperature absolute checks
        if temp > self.thresholds.temp_critical:
            alerts.append(f'CRITICAL: Temperature {temp:.1f}°C exceeds {self.thresholds.temp_critical}°C')
            level = 'critical'
        elif temp > self.thresholds.temp_warning:
            alerts.append(f'WARNING: Temperature {temp:.1f}°C exceeds {self.thresholds.temp_warning}°C')
            if level != 'critical':
                level = 'warning'

        # Temperature rate checks (skipped entirely when unmeasured)
        if temp_rate is not None:
            if temp_rate > self.thresholds.temp_rate_critical:
                alerts.append(f'CRITICAL: Rapid temperature rise {temp_rate:.2f}°C/min')
                level = 'critical'
            elif temp_rate > self.thresholds.temp_rate_warning:
                alerts.append(f'WARNING: Temperature rising at {temp_rate:.2f}°C/min')
                if level != 'critical':
                    level = 'warning'

        # Spread across the members of whatever was read. Only meaningful at
        # sub asset grain, and only when the caller measured it: an absent
        # gradient means no rack telemetry, not a gradient of zero.
        if temp_gradient is not None:
            if temp_gradient > self.thresholds.temp_gradient:
                alerts.append(f'WARNING: Temperature imbalance {temp_gradient:.1f}°C')
                if level == 'normal':
                    level = 'warning'

        # Voltage deviation (optional)
        if 'voltage' in cell_data and 'expected_voltage' in cell_data:
            deviation = abs(cell_data['voltage'] - cell_data['expected_voltage'])
            deviation_pct = deviation / cell_data['expected_voltage']
            if deviation_pct > self.thresholds.voltage_deviation:
                alerts.append(f'WARNING: Voltage deviation {deviation_pct:.1%}')
                if level == 'normal':
                    level = 'warning'

        # Determine recommended action
        if level == 'critical':
            action = "IMMEDIATE: Reduce power, activate cooling, prepare for shutdown"
        elif level == 'warning':
            action = "MONITOR: Increase monitoring frequency, prepare contingency"
        else:
            action = "NORMAL: Continue standard monitoring"

        return ThermalAlert(
            level=level,
            reasons=alerts,
            temperature=temp,
            temp_rate=temp_rate,
            temp_gradient=temp_gradient,
            recommended_action=action,
            grain=grain,
        )

    def check_pack(self, pack_data: list, grain: str = "cell") -> dict:
        """
        Check every member of a pack.

        Args:
            pack_data: List of member data dicts
            grain: grain of each member reading

        Returns:
            Pack-level thermal status
        """
        cell_alerts = [self.check_cell(cell, grain=grain) for cell in pack_data]

        # Find worst case
        critical_count = sum(1 for a in cell_alerts if a.level == 'critical')
        warning_count = sum(1 for a in cell_alerts if a.level == 'warning')

        if critical_count > 0:
            pack_level = 'critical'
        elif warning_count > 0:
            pack_level = 'warning'
        else:
            pack_level = 'normal'

        temps = [cell.get('temperature') for cell in pack_data]
        temps = [t for t in temps if t is not None]

        # A spread needs two members. One reading is one reading, not a spread
        # of zero, so it reports None and the UI says why.
        spread = max(temps) - min(temps) if len(temps) >= 2 else None

        return {
            'pack_level': pack_level,
            'grain': grain,
            'member_count': len(temps),
            'critical_cells': critical_count,
            'warning_cells': warning_count,
            'max_temp': max(temps) if temps else None,
            'min_temp': min(temps) if temps else None,
            'temp_spread': spread,
            'cell_alerts': cell_alerts
        }


class InsufficientBaselineError(ValueError):
    """
    Raised when there is not enough history to learn a rack's normal behaviour.

    Refusing to fit is the point. An Isolation Forest fitted on a handful of
    samples produces a confident looking decision boundary drawn around noise,
    and every downstream surface then reports anomaly scores it has no business
    reporting. Failing loudly here keeps that out of the product.
    """


#: Policy default, not a measured constant. At a 15 minute cloud cadence 500
#: samples is roughly five days, which is the shortest window that spans several
#: full diurnal temperature swings and several charge/discharge cycles. Below
#: that the baseline is describing one day's weather, not the rack.
MIN_BASELINE_SAMPLES = 500


class ThermalAnomalyDetector:
    """
    Tier 2: Statistical anomaly detection for thermal patterns.
    Uses Isolation Forest for unsupervised detection.

    Fit one detector per rack: a fleet-wide baseline learns the average rack and
    then calls the one genuinely different rack normal.

    Example:
        detector = ThermalAnomalyDetector()
        try:
            detector.fit_baseline(historical_data)  # 2D array
        except InsufficientBaselineError as exc:
            skip_rack(str(exc))   # do not fit on noise

        result = detector.detect(current_data)
        if result['is_anomaly']:
            investigate_cell(result['top_contributor'])
    """

    def __init__(
        self,
        contamination: float = 0.01,
        min_baseline_samples: int = MIN_BASELINE_SAMPLES,
    ):
        """
        Args:
            contamination: Expected fraction of anomalies (0-1)
            min_baseline_samples: Refuse to fit below this many samples
        """
        self.contamination = contamination
        self.min_baseline_samples = min_baseline_samples
        self.isolation_forest = None
        self.baseline_stats = None
        self.is_fitted = False

        try:
            from sklearn.ensemble import IsolationForest
            self._IsolationForest = IsolationForest
        except ImportError:
            raise ImportError(
                "scikit-learn required for anomaly detection. "
                "Install with: pip install scikit-learn"
            )

    def fit_baseline(self, historical_data: np.ndarray):
        """
        Learn normal operating patterns from historical data.

        Args:
            historical_data: 2D array (n_samples, n_features)
                Features: [temp, temp_rate, voltage, current, temp_gradient]

        Raises:
            InsufficientBaselineError: fewer than `min_baseline_samples` usable
                rows. The detector stays unfitted; callers must handle the rack
                as "not yet baselined" rather than as "normal".
        """
        data = np.atleast_2d(np.asarray(historical_data, dtype=float))
        if data.ndim != 2:
            raise ValueError("historical_data must be 2D (n_samples, n_features)")

        # Rows carrying a nan cannot train anything; drop them before counting
        # so the sample floor is a floor on usable data.
        usable = data[np.isfinite(data).all(axis=1)]
        n_usable = len(usable)
        if n_usable < self.min_baseline_samples:
            raise InsufficientBaselineError(
                f"Baseline needs at least {self.min_baseline_samples} usable samples, "
                f"got {n_usable}. Not fitting: an anomaly model trained on this "
                "little history reports noise as signal."
            )

        self.isolation_forest = self._IsolationForest(
            contamination=self.contamination,
            random_state=42,
            n_jobs=-1
        )
        self.isolation_forest.fit(usable)

        self.baseline_stats = {
            'mean': usable.mean(axis=0),
            'std': usable.std(axis=0),
            'n_samples': n_usable,
            'n_features': usable.shape[1],
            'dropped_rows': len(data) - n_usable,
        }
        self.is_fitted = True

    def detect(self, current_data: np.ndarray) -> dict:
        """
        Detect anomalies in current data.

        Args:
            current_data: 1D array of current features

        Returns:
            Dict with anomaly score, z-scores, and top contributor
        """
        if not self.is_fitted:
            raise ValueError("Model not fitted. Call fit_baseline() first.")

        current_data = np.atleast_2d(np.asarray(current_data, dtype=float))
        expected = self.baseline_stats.get('n_features')
        if expected is not None and current_data.shape[1] != expected:
            raise ValueError(
                f"Baseline was fitted on {expected} features, got "
                f"{current_data.shape[1]}"
            )

        # Isolation Forest score (-1 = anomaly, 1 = normal)
        if_score = self.isolation_forest.decision_function(current_data)[0]

        # Z-score for interpretability
        z_scores = (current_data[0] - self.baseline_stats['mean']) / (
            self.baseline_stats['std'] + 1e-8
        )

        feature_names = ['temp', 'temp_rate', 'voltage', 'current', 'gradient']
        if len(z_scores) > len(feature_names):
            feature_names = [f'feature_{i}' for i in range(len(z_scores))]

        return {
            'anomaly_score': float(-if_score),  # Higher = more anomalous
            'is_anomaly': if_score < 0,
            'z_scores': dict(zip(feature_names[:len(z_scores)], z_scores)),
            'top_contributor': feature_names[np.argmax(np.abs(z_scores))],
            'max_z_score': float(np.max(np.abs(z_scores)))
        }


class ThermalResidualMonitor:
    """
    Tier 3: Deep learning prediction residual monitoring.
    Compares predicted vs actual temperature; large residual = anomaly.

    Requires PyTorch for LSTM model.

    Example:
        # Train LSTM predictor on normal data
        predictor = LSTMThermalPredictor()
        predictor.fit(normal_sequences, normal_temperatures)

        # Monitor in production
        monitor = ThermalResidualMonitor(predictor)
        result = monitor.check(recent_sequence, actual_temp)
        if result['warning_level'] == 'critical':
            trigger_alert()
    """

    def __init__(
        self,
        predictor=None,
        threshold_sigma: float = 3.0
    ):
        """
        Args:
            predictor: Trained temperature prediction model
            threshold_sigma: Z-score threshold for anomaly
        """
        self.predictor = predictor
        self.threshold = threshold_sigma
        self.residual_history = []
        self.running_mean = 0.0
        self.running_std = 1.0
        self.n_samples = 0

    def check(
        self,
        recent_data: np.ndarray,
        actual_temp: float
    ) -> dict:
        """
        Compare predicted vs actual temperature.

        Args:
            recent_data: Recent feature sequence for prediction
            actual_temp: Actual observed temperature

        Returns:
            Dict with prediction, residual, and warning level
        """
        if self.predictor is None:
            # Without predictor, use simple moving average
            predicted = self.running_mean
        else:
            predicted = float(self.predictor.predict(recent_data))

        residual = actual_temp - predicted
        self.residual_history.append(residual)

        # Update running statistics
        self.n_samples += 1
        if self.n_samples > 1:
            old_mean = self.running_mean
            self.running_mean += (residual - old_mean) / self.n_samples
            self.running_std = np.sqrt(
                ((self.n_samples - 2) * self.running_std ** 2
                 + (residual - old_mean) * (residual - self.running_mean))
                / (self.n_samples - 1)
            )

        # Calculate z-score
        if self.running_std > 0 and self.n_samples > 10:
            z_score = (residual - self.running_mean) / self.running_std
        else:
            z_score = 0

        # Determine warning level
        if abs(z_score) > 5:
            warning_level = 'critical'
        elif abs(z_score) > self.threshold:
            warning_level = 'warning'
        else:
            warning_level = 'normal'

        return {
            'predicted_temp': predicted,
            'actual_temp': actual_temp,
            'residual': residual,
            'z_score': float(z_score),
            'is_anomaly': abs(z_score) > self.threshold,
            'warning_level': warning_level,
            'n_samples': self.n_samples
        }

    def reset(self):
        """Reset residual history and running stats"""
        self.residual_history = []
        self.running_mean = 0.0
        self.running_std = 1.0
        self.n_samples = 0


# ---------------------------------------------------------------------------
# State of safety
# ---------------------------------------------------------------------------
#
# State of safety is deliberately NOT a new opaque composite. It mirrors the
# transparency of the warranty health score in nuravolt.bess.pipeline (explicit
# weights, published bands) but combines its parts with worst-of instead of a
# weighted sum.
#
# WHY WORST-OF AND NOT A WEIGHTED SUM: safety does not average. A rack two
# degrees from its critical limit is an emergency whether or not the SoC dwell,
# the imbalance and the HVAC status are all perfect. Under a weighted sum three
# healthy sub indices would dilute one critical thermal margin into a
# comfortable looking number, which is precisely the failure mode that gets
# people hurt. Worst-of makes the weakest link the answer, and names it.
#
# Each sub index is 0 to 100 and carries its own inputs and its own scoring
# method, so the UI can publish the rubric the same way it publishes the health
# score breakdown. A sub index with no data reports available=False with a
# reason; it is never scored 100 for lack of evidence, and it is excluded from
# the worst-of rather than silently propping the composite up.

#: Same bands as the warranty health score, so the two read consistently.
SAFETY_BANDS: Tuple[Tuple[int, str], ...] = ((80, "LOW"), (60, "MODERATE"), (40, "HIGH"))
SAFETY_BAND_FLOOR = "CRITICAL"
SAFETY_BAND_UNKNOWN = "UNKNOWN"


def band_for_score(score: Optional[float]) -> str:
    """Risk band for a 0 to 100 sub index or composite."""
    if score is None:
        return SAFETY_BAND_UNKNOWN
    for floor, label in SAFETY_BANDS:
        if score >= floor:
            return label
    return SAFETY_BAND_FLOOR


@dataclass
class SafetySubIndex:
    """One 0 to 100 component of state of safety, with its own inputs."""

    name: str
    score: Optional[int]
    available: bool
    reason: Optional[str] = None
    inputs: Dict[str, Any] = field(default_factory=dict)
    method: str = ""

    @property
    def band(self) -> str:
        return band_for_score(self.score)


@dataclass
class StateOfSafety:
    """Worst-of composite over the available sub indices."""

    score: Optional[int]
    band: str
    limiting_index: Optional[str]
    sub_indices: List[SafetySubIndex]
    disclosure: str
    rubric: Dict[str, Any] = field(default_factory=dict)
    computed_at: Optional[datetime] = None

    @property
    def unavailable(self) -> List[str]:
        return [s.name for s in self.sub_indices if not s.available]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "score": self.score,
            "band": self.band,
            "limiting_index": self.limiting_index,
            "disclosure": self.disclosure,
            "computed_at": (
                self.computed_at.isoformat() if self.computed_at else None
            ),
            "sub_indices": [
                {
                    "name": s.name,
                    "score": s.score,
                    "band": s.band,
                    "available": s.available,
                    "reason": s.reason,
                    "method": s.method,
                    "inputs": s.inputs,
                }
                for s in self.sub_indices
            ],
            "unavailable": self.unavailable,
            "rubric": self.rubric,
        }


THERMAL_MARGIN_METHOD = (
    "Worst of absolute temperature and rate of change against the configured "
    "thresholds. 100 at or below the warning threshold, 0 at or above the "
    "critical threshold, linear between."
)
DWELL_EXPOSURE_METHOD = (
    "Share of the analysis window spent outside the safe operating envelope, "
    "with overlapping events merged. 100 at no exposure, 0 at full window "
    "exposure."
)
PROTECTION_STATUS_METHOD = (
    "Protection channel status. 100 when HVAC reports healthy and no alarm "
    "codes are present, 30 when the BMS raises an alarm code, 0 when a thermal "
    "management failure is detected."
)

SAFETY_RUBRIC: Dict[str, Any] = {
    "combination": "worst_of",
    "combination_rationale": (
        "Safety does not average. A critical thermal margin must not be diluted "
        "by three healthy sub indices, so the composite is the weakest sub "
        "index and names which one it is."
    ),
    "bands": {
        "LOW": ">= 80",
        "MODERATE": "60 to 79",
        "HIGH": "40 to 59",
        "CRITICAL": "< 40",
        "UNKNOWN": "no sub index had data",
    },
    "sub_indices": {
        "thermal_margin": THERMAL_MARGIN_METHOD,
        "imbalance": (
            "Worst sustained modified z score across racks, on the median and "
            "the MAD, over two grains: each rack's level against its siblings, "
            "and each rack's within rack spread against its siblings. The "
            "spread grain is what catches a rack whose cells are drifting "
            "apart while its average stays with the fleet. See "
            "nuravolt.bess.imbalance."
        ),
        "dwell_exposure": DWELL_EXPOSURE_METHOD,
        "protection_status": PROTECTION_STATUS_METHOD,
    },
    "unavailable_handling": (
        "A sub index with no data is reported unavailable and excluded from the "
        "worst-of. It is never scored 100 for lack of evidence."
    ),
}

#: Warranty violation types that represent time outside the safe envelope.
DWELL_EXPOSURE_TYPES = (
    "TEMPERATURE_EXCEED",
    "SOC_HIGH_DWELL",
    "SOC_LOW_DWELL",
    "VOLTAGE_VIOLATION",
    "C_RATE_EXCEED",
)


def _linear_index(value: float, good: float, bad: float) -> float:
    """100 at or beyond `good`, 0 at or beyond `bad`, linear between."""
    if bad == good:
        return 0.0 if value >= bad else 100.0
    frac = (value - good) / (bad - good)
    return float(min(100.0, max(0.0, 100.0 * (1.0 - frac))))


def thermal_margin_index(
    max_temp_c: Optional[float],
    max_rate_c_per_min: Optional[float] = None,
    thresholds: Optional[ThermalThresholds] = None,
) -> SafetySubIndex:
    """
    Headroom between the hottest reading and its critical limit.

    Works at asset grain: a pack or container temperature from an OEM cloud API
    is a valid input. Rate of change is folded in when the caller measured it
    and simply left out when it did not.
    """
    th = thresholds or ThermalThresholds()
    inputs: Dict[str, Any] = {
        "max_temp_c": max_temp_c,
        "max_rate_c_per_min": max_rate_c_per_min,
        "temp_warning_c": th.temp_warning,
        "temp_critical_c": th.temp_critical,
        "rate_warning_c_per_min": th.temp_rate_warning,
        "rate_critical_c_per_min": th.temp_rate_critical,
    }

    if max_temp_c is None or not np.isfinite(max_temp_c):
        return SafetySubIndex(
            name="thermal_margin",
            score=None,
            available=False,
            reason="No temperature channel on this asset",
            inputs=inputs,
            method=THERMAL_MARGIN_METHOD,
        )

    parts = {"temperature": _linear_index(float(max_temp_c), th.temp_warning, th.temp_critical)}
    if max_rate_c_per_min is not None and np.isfinite(max_rate_c_per_min):
        parts["rate"] = _linear_index(
            float(max_rate_c_per_min), th.temp_rate_warning, th.temp_rate_critical
        )

    limiting = min(parts, key=lambda k: parts[k])
    inputs["components"] = {k: int(round(v)) for k, v in parts.items()}
    inputs["limiting_component"] = limiting
    return SafetySubIndex(
        name="thermal_margin",
        score=int(round(parts[limiting])),
        available=True,
        inputs=inputs,
        method=THERMAL_MARGIN_METHOD,
    )


def _merged_minutes(intervals: Sequence[Tuple[datetime, datetime]]) -> float:
    """Total minutes covered by the union of the intervals."""
    spans = sorted(
        (s, e) for s, e in intervals if s is not None and e is not None and e > s
    )
    total = 0.0
    cur_start: Optional[datetime] = None
    cur_end: Optional[datetime] = None
    for start, end in spans:
        if cur_end is None or start > cur_end:
            if cur_end is not None:
                total += (cur_end - cur_start).total_seconds() / 60.0
            cur_start, cur_end = start, end
        elif end > cur_end:
            cur_end = end
    if cur_end is not None:
        total += (cur_end - cur_start).total_seconds() / 60.0
    return total


def dwell_exposure_index(
    events: Sequence[Tuple[str, datetime, datetime]],
    window_hours: Optional[float],
) -> SafetySubIndex:
    """
    How much of the analysis window the asset spent outside its safe envelope.

    Args:
        events: (violation_type, started_at, ended_at) tuples. Only the types in
            DWELL_EXPOSURE_TYPES count; the rest are warranty economics, not
            safety.
        window_hours: length of the analysed window.
    """
    inputs: Dict[str, Any] = {
        "window_hours": window_hours,
        "counted_types": list(DWELL_EXPOSURE_TYPES),
    }
    if not window_hours or not np.isfinite(window_hours) or window_hours <= 0:
        return SafetySubIndex(
            name="dwell_exposure",
            score=None,
            available=False,
            reason="No analysed window to measure exposure against",
            inputs=inputs,
            method=DWELL_EXPOSURE_METHOD,
        )

    relevant = [
        (start, end)
        for kind, start, end in events
        if kind in DWELL_EXPOSURE_TYPES and start is not None and end is not None
    ]
    exposed_minutes = _merged_minutes(relevant)
    window_minutes = window_hours * 60.0
    fraction = min(1.0, exposed_minutes / window_minutes)

    inputs["events_counted"] = len(relevant)
    inputs["exposed_minutes"] = round(exposed_minutes, 1)
    inputs["exposed_fraction"] = round(fraction, 4)
    return SafetySubIndex(
        name="dwell_exposure",
        score=int(round(100.0 * (1.0 - fraction))),
        available=True,
        inputs=inputs,
        method=DWELL_EXPOSURE_METHOD,
    )


def protection_status_index(
    hvac_failures: Optional[int] = None,
    alarm_codes: Optional[Sequence[str]] = None,
    hvac_channel_present: bool = False,
    alarm_channel_present: bool = False,
) -> SafetySubIndex:
    """
    Status of the systems that are actually protecting the asset.

    Unavailable when neither an HVAC status channel nor an alarm code channel is
    connected. That absence is reported, not scored: a battery with no HVAC
    telemetry is not a battery with healthy HVAC.
    """
    codes = list(alarm_codes or [])
    inputs: Dict[str, Any] = {
        "hvac_channel_present": hvac_channel_present,
        "alarm_channel_present": alarm_channel_present,
        "hvac_failures": hvac_failures,
        "alarm_codes": codes,
    }
    if not hvac_channel_present and not alarm_channel_present:
        return SafetySubIndex(
            name="protection_status",
            score=None,
            available=False,
            reason=(
                "No HVAC status or alarm code channel connected, protection "
                "status cannot be read"
            ),
            inputs=inputs,
            method=PROTECTION_STATUS_METHOD,
        )

    if hvac_failures:
        score = 0
    elif codes:
        score = 30
    else:
        score = 100
    return SafetySubIndex(
        name="protection_status",
        score=score,
        available=True,
        inputs=inputs,
        method=PROTECTION_STATUS_METHOD,
    )


def combine_state_of_safety(
    sub_indices: Sequence[SafetySubIndex],
    *,
    interval_minutes: Optional[float] = None,
    computed_at: Optional[datetime] = None,
) -> StateOfSafety:
    """Worst-of over the sub indices that actually had data."""
    scored = [s for s in sub_indices if s.available and s.score is not None]
    if not scored:
        return StateOfSafety(
            score=None,
            band=SAFETY_BAND_UNKNOWN,
            limiting_index=None,
            sub_indices=list(sub_indices),
            disclosure=safety_disclosure(interval_minutes),
            rubric=SAFETY_RUBRIC,
            computed_at=computed_at,
        )

    worst = min(scored, key=lambda s: s.score)
    return StateOfSafety(
        score=worst.score,
        band=band_for_score(worst.score),
        limiting_index=worst.name,
        sub_indices=list(sub_indices),
        disclosure=safety_disclosure(interval_minutes),
        rubric=SAFETY_RUBRIC,
        computed_at=computed_at,
    )
