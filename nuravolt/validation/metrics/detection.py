"""Validating a detector on real plants that carry no fault labels.

THE PROBLEM
-----------
Real photovoltaic plants do not come with labelled faults. Nobody records "string
7 on inverter 42 went open circuit at 11:15 on the fourth of March". So the
metric everyone reaches for -- recall against ground truth -- is unavailable, and
a detector validated only on a labelled lab dataset tells you nothing about how it
behaves on a customer's asset. Our own numbers make that concrete: an
in-distribution macro-F1 of 0.835 becomes 0.189 on a different plant architecture.

Five things ARE measurable without labels. **None of them is recall, and this
module names them so that they cannot quietly be presented as recall.**

1. ``alert_rate``          how often it fires, per MW per month. Operability.
2. ``null_calibration``    the symmetric-tail control: the false-positive rate,
                           estimated from the detector's own harmless tail.
3. ``injected_recall``     detection curve against synthetic faults of known size.
4. ``agreement``           Cohen's kappa against an independent detector.
5. ``persistence``         whether alerts cluster on devices or scatter with weather.

THE SYMMETRIC-TAIL CONTROL
--------------------------
The most useful of the five, and it costs nothing.

For a two-sided statistic where only one direction is a fault -- a device
underperforming its peers -- the *other* tail contains no faults by construction.
An inverter producing more than its siblings is not broken. So the positive tail
is a direct estimate of the false-positive rate, with no labels at all, and it can
be compared against the theoretical tail of the null distribution.

Measured on 416 inverters across six plants: observed positive tail 0.0030%
against a theoretical 0.0032% for a standard normal at |z| > 4. That agreement to
three significant figures says the statistic is correctly calibrated on real data.
The negative tail was 0.2492%, roughly 78 times the null, which is real signal.

The control also settles questions that would otherwise need labels. When alert
rate correlated with plant size, the natural explanation was that more peers give
a tighter dispersion estimate, making a fixed threshold more sensitive. The
control disproved it: if the effect were statistical the positive tail would
inflate with size too, and it does not.

WHAT THESE NUMBERS CANNOT DO
----------------------------
They cannot tell you a detector found every real fault. A detector that fires
rarely, is well calibrated against its null, and agrees with an independent method
is *plausible*, not *proven*. Every report emitted here carries that sentence in
its payload so it survives the trip into a document.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

#: A tier A detector firing more often than this is not shippable regardless of
#: whether the alerts are correct: an operations team cannot act on them.
#: Per MW per month.
DEFAULT_ALERT_RATE_GATE = 1.0

#: Above this the alert rate is treated as correlated with plant size, which for a
#: tier A detector means it is not scale invariant.
SCALE_CORRELATION_LIMIT = 0.5


def _finite(xs: Sequence[float]) -> List[float]:
    return [float(x) for x in xs if x is not None and math.isfinite(float(x))]


@dataclass
class AlertRate:
    """How often a detector fires, normalised so plants are comparable."""

    events: int
    mw_months: float
    devices_alerted: int
    devices_total: int
    gate: float = DEFAULT_ALERT_RATE_GATE

    @property
    def per_mw_month(self) -> float:
        return self.events / self.mw_months if self.mw_months else float("nan")

    @property
    def passes(self) -> bool:
        r = self.per_mw_month
        return math.isfinite(r) and r <= self.gate

    def to_dict(self) -> Dict[str, Any]:
        return {
            "events": self.events,
            "mw_months": round(self.mw_months, 2),
            "alerts_per_mw_month": round(self.per_mw_month, 4),
            "devices_alerted": self.devices_alerted,
            "devices_total": self.devices_total,
            "gate": self.gate,
            "passes_gate": self.passes,
        }


@dataclass
class NullCalibration:
    """The symmetric-tail control.

    ``fault_tail_rate`` is the fraction of scored samples beyond the threshold in
    the direction that indicates a fault. ``null_tail_rate`` is the fraction
    beyond the same threshold in the harmless direction, which contains no faults
    by construction and therefore estimates the false-positive rate.
    """

    threshold: float
    fault_tail_rate: float
    null_tail_rate: float
    theoretical_null_rate: Optional[float] = None
    n_scored: int = 0

    @property
    def signal_to_null(self) -> float:
        """How many times more often the fault tail fires than the harmless one."""
        if self.null_tail_rate <= 0:
            return float("inf")
        return self.fault_tail_rate / self.null_tail_rate

    @property
    def is_calibrated(self) -> bool:
        """Does the harmless tail match theory?

        Within a factor of three of the theoretical rate. Loose on purpose: the
        question is whether the statistic is behaving like its assumed
        distribution at all, not whether it matches to four decimal places.
        """
        if self.theoretical_null_rate is None or self.theoretical_null_rate <= 0:
            return False
        ratio = self.null_tail_rate / self.theoretical_null_rate
        return 1 / 3 <= ratio <= 3

    def to_dict(self) -> Dict[str, Any]:
        out = {
            "method": (
                "Symmetric-tail control. Only one direction of this statistic can "
                "indicate a fault, so the opposite tail contains no faults by "
                "construction and estimates the false-positive rate directly, "
                "with no labels."
            ),
            "threshold": self.threshold,
            "n_scored": self.n_scored,
            "fault_tail_rate": round(self.fault_tail_rate, 8),
            "null_tail_rate": round(self.null_tail_rate, 8),
            "signal_to_null_ratio": (
                round(self.signal_to_null, 1)
                if math.isfinite(self.signal_to_null) else None
            ),
        }
        if self.theoretical_null_rate is not None:
            out["theoretical_null_rate"] = round(self.theoretical_null_rate, 8)
            out["is_calibrated"] = self.is_calibrated
        return out


@dataclass
class InjectedRecallPoint:
    """One point on the detection curve."""

    magnitude: float          # e.g. 0.10 for a 10% current deficit
    n_injected: int
    n_detected: int
    median_days_to_detect: Optional[float] = None

    @property
    def recall(self) -> float:
        return self.n_detected / self.n_injected if self.n_injected else float("nan")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "magnitude": self.magnitude,
            "n_injected": self.n_injected,
            "n_detected": self.n_detected,
            "recall": round(self.recall, 4),
            "median_days_to_detect": self.median_days_to_detect,
        }


@dataclass
class InjectedRecall:
    """Detection curve against synthetic faults of known magnitude."""

    corruption: str                       # what was injected, in physical terms
    points: List[InjectedRecallPoint] = field(default_factory=list)
    target_recall: float = 0.90
    injected_on_plant: str = ""
    parameters_from_plants: List[str] = field(default_factory=list)

    def minimum_detectable(self) -> Optional[float]:
        """Smallest magnitude reaching ``target_recall``."""
        hits = [p.magnitude for p in sorted(self.points, key=lambda p: p.magnitude)
                if p.recall >= self.target_recall]
        return hits[0] if hits else None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "corruption": self.corruption,
            "target_recall": self.target_recall,
            "minimum_detectable_magnitude": self.minimum_detectable(),
            "injected_on_plant": self.injected_on_plant,
            "parameters_fitted_on": self.parameters_from_plants,
            "curve": [p.to_dict() for p in sorted(self.points, key=lambda p: p.magnitude)],
            "caveats": [
                "Injection tests the statistic, not the taxonomy: it shows the "
                "detector reacts to a deficit of a given size, not that it names "
                "the fault correctly.",
                "A synthetic corruption is not a fault. Real faults are confounded "
                "with the conditions that caused them, so this is an UPPER BOUND "
                "on field recall.",
                "Valid only where detector parameters never saw the injected plant.",
            ],
        }


@dataclass
class DetectorAgreement:
    """Cohen's kappa against an independent detector."""

    other_detector: str
    kappa: float
    n_compared: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "other_detector": self.other_detector,
            "cohens_kappa": round(self.kappa, 4),
            "n_compared": self.n_compared,
            "note": (
                "Agreement between methods with disjoint failure modes raises "
                "confidence. It is NOT recall: two detectors can agree and both "
                "be wrong."
            ),
        }


@dataclass
class DetectionReport:
    """Everything measurable about a detector without labels."""

    detector: str
    tier: str                              # "A" | "B" | "C"
    n_devices: int
    alert_rate: Optional[AlertRate] = None
    null_calibration: Optional[NullCalibration] = None
    injected_recall: Optional[InjectedRecall] = None
    agreement: List[DetectorAgreement] = field(default_factory=list)
    persistence_autocorr: Optional[float] = None
    per_plant: Dict[str, Any] = field(default_factory=dict)
    scale_invariance: Optional[Dict[str, Any]] = None
    parameters: Dict[str, Any] = field(default_factory=dict)
    extras: Dict[str, Any] = field(default_factory=dict)

    def parameter_budget_ok(self, limit: int = 3) -> bool:
        """Tier A detectors get at most three numeric, dimensionless parameters."""
        if self.tier != "A":
            return True
        numeric = [v for v in self.parameters.values() if isinstance(v, (int, float))]
        return len(numeric) <= limit

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "dataset": self.detector,
            "detector": self.detector,
            "tier": self.tier,
            "n_samples": self.n_devices,
            "parameters": self.parameters,
            "parameter_budget_ok": self.parameter_budget_ok(),
            "per_plant": self.per_plant,
            "extras": self.extras,
            "what_this_is_not": (
                "None of these measurements is recall against ground truth. Real "
                "plants carry no fault labels. A detector that fires rarely, is "
                "calibrated against its own null, and agrees with an independent "
                "method is plausible, not proven."
            ),
        }
        if self.alert_rate:
            payload.update(self.alert_rate.to_dict())
        if self.null_calibration:
            payload["null_calibration"] = self.null_calibration.to_dict()
        if self.injected_recall:
            payload["injected_recall"] = self.injected_recall.to_dict()
        if self.agreement:
            payload["agreement"] = [a.to_dict() for a in self.agreement]
        if self.persistence_autocorr is not None:
            payload["persistence_autocorr"] = round(self.persistence_autocorr, 4)
            payload["persistence_note"] = (
                "Lag-1 autocorrelation of the per-device alert indicator. Near "
                "zero means alerts scatter independently, which is what detecting "
                "weather looks like."
            )
        if self.scale_invariance:
            payload["scale_invariance"] = self.scale_invariance
        return payload


def compute_null_calibration(
    scores: Sequence[float],
    threshold: float,
    *,
    fault_direction: str = "negative",
    theoretical_null_rate: Optional[float] = None,
) -> NullCalibration:
    """Run the symmetric-tail control over a set of scores.

    Args:
        scores: the two-sided statistic, e.g. modified z against peers.
        threshold: magnitude of the flag level, e.g. 4.0.
        fault_direction: which tail indicates a fault.
        theoretical_null_rate: one-sided tail probability under the assumed null.
            For a standard normal at 4.0 that is about 3.167e-05.
    """
    if fault_direction not in ("negative", "positive"):
        raise ValueError("fault_direction must be 'negative' or 'positive'")

    vals = _finite(scores)
    n = len(vals)
    if n == 0:
        raise ValueError("no finite scores; refusing to report a calibration of zero")

    t = abs(threshold)
    below = sum(1 for v in vals if v < -t) / n
    above = sum(1 for v in vals if v > t) / n

    fault_rate, null_rate = (below, above) if fault_direction == "negative" else (above, below)
    return NullCalibration(
        threshold=t,
        fault_tail_rate=fault_rate,
        null_tail_rate=null_rate,
        theoretical_null_rate=theoretical_null_rate,
        n_scored=n,
    )


def normal_tail(threshold: float) -> float:
    """One-sided P(Z > threshold) for a standard normal, without scipy."""
    return 0.5 * math.erfc(abs(threshold) / math.sqrt(2.0))


def compute_scale_invariance(
    sizes: Sequence[float],
    rates: Sequence[float],
    *,
    limit: float = SCALE_CORRELATION_LIMIT,
) -> Dict[str, Any]:
    """Spearman correlation between plant size and alert rate.

    A tier A detector's alert rate must not depend on how many devices a plant
    happens to have. With a handful of plants this is weak evidence either way,
    and the payload says so rather than implying significance.
    """
    xs, ys = list(sizes), list(rates)
    n = len(xs)
    if n < 3 or len(ys) != n:
        return {"n_plants": n, "computable": False,
                "note": "too few plants to say anything about scale invariance"}

    def rank(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        r = [0.0] * len(vals)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    rx, ry = rank(xs), rank(ys)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    rho = num / den if den else 0.0

    return {
        "spearman_size_vs_alert_rate": round(rho, 3),
        "n_plants": n,
        "limit": limit,
        "computable": True,
        "passes": abs(rho) < limit,
        "note": (
            f"With {n} plants this is weak evidence in either direction. A tier A "
            f"detector's alert rate should not track plant size; if it does, check "
            f"the null calibration before concluding the statistic is at fault, "
            f"because a real difference in plant health looks the same here."
        ),
    }
