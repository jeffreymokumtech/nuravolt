"""Digital-twin validation metrics: capacity-normalised power/energy error.

Why not R-squared
-----------------
On a PV power time series roughly 95% of the variance is the diurnal and
seasonal cycle, which even a constant-efficiency straight line reproduces. That
makes R-squared both uninformative (0.95 is table stakes) and un-comparable
across plants, because it depends on the variance of the test window rather than
on model skill. The same effect running the other way is why an honest
per-inverter soiling holdout can read R-squared -8.37 at an operationally
excellent MAE of 0.0084 soiling ratio.

So the headline metrics here are capacity-normalised errors, the convention used
in IEA-PVPS and IEA-Wind Task 36 forecast benchmarking and the one an EPC or IPP
technical team will expect. R-squared is retained in the payload as a footnote.

Definitions, with y measured, y-hat predicted, P_ac the AC nameplate in kW, and
E-bar the mean measured daily energy over the *test* set:

    nMAE_cap  = mean(|y_hat - y|) / P_ac * 100      [% of AC nameplate]
    nRMSE_cap = sqrt(mean((y_hat - y)^2)) / P_ac * 100
    MBE_cap   = mean(y_hat - y) / P_ac * 100        [signed; never folded into MAE]
    nMAE_mean = mean(|E_hat - E|) / E_bar * 100     [% of mean daily energy]
    MBE_mean  = mean(E_hat - E) / E_bar * 100

Never mix the two normalisers in one table without labelling the column, which
is why ``normalizer`` and ``normalizer_value`` are required fields.

Physics vs ML
-------------
Every report carries the physics-only baseline alongside the hybrid result, plus
a naive baseline, so the question "is the ML actually earning its place over
plain physics?" is answered on the face of the artifact instead of being taken
on trust. ``uplift_vs_reference_pct`` is positive when the hybrid beats the reference.

The reference is named, not assumed. ``physics_only`` means the actual PVWatts
physics twin; ``irradiance_scaling`` means a plain least-squares line through
irradiance, fitted on the training window only. Those are different claims and
conflating them would overstate what has been demonstrated.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Sequence

# Normaliser identifiers. Kept as constants so a report can never carry a
# free-text normaliser that a reader has to guess at.
NORM_AC_CAPACITY = "ac_capacity_kw"
NORM_MEAN_DAILY_ENERGY = "mean_daily_energy_kwh"


@dataclass
class ErrorBlock:
    """One model's error against the same measured series."""

    label: str                    # "hybrid" | "physics_only" | "irradiance_scaling" | ...
    nmae_pct: float
    nrmse_pct: float
    mbe_pct: float
    r2: Optional[float] = None    # footnote only, never a headline

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "label": self.label,
            "nmae_pct": round(self.nmae_pct, 3),
            "nrmse_pct": round(self.nrmse_pct, 3),
            "mbe_pct": round(self.mbe_pct, 3),
        }
        if self.r2 is not None and math.isfinite(self.r2):
            out["r2_footnote_only"] = round(self.r2, 4)
        return out


@dataclass
class TwinReport:
    dataset: str
    n_samples: int
    normalizer: str               # NORM_AC_CAPACITY | NORM_MEAN_DAILY_ENERGY
    normalizer_value: float
    model: ErrorBlock             # the shipped hybrid model
    baselines: Dict[str, ErrorBlock] = field(default_factory=dict)
    reference_baseline: Optional[str] = None
    n_windows: Optional[int] = None
    retention: Dict[str, Any] = field(default_factory=dict)
    extras: Dict[str, Any] = field(default_factory=dict)

    @property
    def reference(self) -> Optional[ErrorBlock]:
        """The baseline the ML layer is judged against."""
        if self.reference_baseline:
            return self.baselines.get(self.reference_baseline)
        for label in ("physics_only", "irradiance_scaling"):
            if label in self.baselines:
                return self.baselines[label]
        return None

    @property
    def uplift_vs_reference_pct(self) -> Optional[float]:
        """Percent reduction in nMAE from the reference baseline to the model.

        Positive means the ML layer improves on the reference. Negative means it
        is making things worse, which is a result worth publishing too, and the
        reason this property exists at all.
        """
        ref = self.reference
        if ref is None or ref.nmae_pct == 0:
            return None
        return (ref.nmae_pct - self.model.nmae_pct) / ref.nmae_pct * 100

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "dataset": self.dataset,
            "n_samples": self.n_samples,
            "n_windows": self.n_windows,
            "normalizer": self.normalizer,
            "normalizer_value": round(self.normalizer_value, 3),
            # Headline fields, flattened so report._extract_headline can read them.
            "nmae_pct": round(self.model.nmae_pct, 3),
            "nrmse_pct": round(self.model.nrmse_pct, 3),
            "mbe_pct": round(self.model.mbe_pct, 3),
            "model": self.model.to_dict(),
            "baselines": {k: v.to_dict() for k, v in self.baselines.items()},
            "retention": self.retention,
            "extras": self.extras,
        }
        ref = self.reference
        if ref is not None:
            payload["reference_baseline"] = ref.label
            payload["reference_nmae_pct"] = round(ref.nmae_pct, 3)
            uplift = self.uplift_vs_reference_pct
            if uplift is not None:
                payload["uplift_vs_reference_pct"] = round(uplift, 2)
        return payload


def _finite_pairs(actual: Sequence[float], predicted: Sequence[float]):
    if len(actual) != len(predicted):
        raise ValueError("actual and predicted must be aligned")
    pairs = [
        (float(a), float(p))
        for a, p in zip(actual, predicted)
        if a is not None and p is not None
        and math.isfinite(float(a)) and math.isfinite(float(p))
    ]
    if not pairs:
        raise ValueError("no finite (actual, predicted) pairs")
    return pairs


def compute_error_block(
    label: str,
    actual: Sequence[float],
    predicted: Sequence[float],
    normalizer_value: float,
) -> ErrorBlock:
    """Capacity- (or mean-energy-) normalised error for one model."""
    if normalizer_value <= 0:
        raise ValueError(f"normalizer_value must be positive, got {normalizer_value}")

    pairs = _finite_pairs(actual, predicted)
    n = len(pairs)
    diffs = [p - a for a, p in pairs]

    mae = sum(abs(d) for d in diffs) / n
    rmse = math.sqrt(sum(d * d for d in diffs) / n)
    mbe = sum(diffs) / n

    ys = [a for a, _ in pairs]
    y_bar = sum(ys) / n
    ss_tot = sum((y - y_bar) ** 2 for y in ys)
    r2 = 1.0 - (sum(d * d for d in diffs) / ss_tot) if ss_tot > 0 else None

    return ErrorBlock(
        label=label,
        nmae_pct=mae / normalizer_value * 100,
        nrmse_pct=rmse / normalizer_value * 100,
        mbe_pct=mbe / normalizer_value * 100,
        r2=r2,
    )


def compute_twin_report(
    dataset: str,
    actual: Sequence[float],
    predicted: Sequence[float],
    normalizer: str,
    normalizer_value: float,
    baselines: Optional[Dict[str, Sequence[float]]] = None,
    reference_baseline: Optional[str] = None,
    n_windows: Optional[int] = None,
    retention: Optional[Dict[str, Any]] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> TwinReport:
    """Build a twin report from one measured series and one or more predictions.

    Args:
        actual: measured power (kW) or daily energy (kWh).
        predicted: the shipped hybrid model's prediction, aligned to ``actual``.
        normalizer: NORM_AC_CAPACITY or NORM_MEAN_DAILY_ENERGY.
        normalizer_value: AC nameplate in kW, or test-set mean daily energy in kWh.
        baselines: label -> prediction series. ``physics_only`` is reserved for
            the actual physics twin; ``irradiance_scaling`` for a fitted
            irradiance line. Whichever is named in ``reference_baseline`` (or the
            first of those two present) is what the ML uplift is measured against.
        retention: filter accounting (n_raw, n_after_*, retention_pct,
            availability_excluded_pct). Publish it; a headline error number
            without a retention figure can hide arbitrarily much.
    """
    if normalizer not in (NORM_AC_CAPACITY, NORM_MEAN_DAILY_ENERGY):
        raise ValueError(
            f"normalizer must be {NORM_AC_CAPACITY!r} or {NORM_MEAN_DAILY_ENERGY!r}, "
            f"got {normalizer!r}"
        )

    model = compute_error_block("hybrid", actual, predicted, normalizer_value)
    blocks = {
        label: compute_error_block(label, actual, series, normalizer_value)
        for label, series in (baselines or {}).items()
    }

    return TwinReport(
        dataset=dataset,
        n_samples=len(_finite_pairs(actual, predicted)),
        normalizer=normalizer,
        normalizer_value=normalizer_value,
        model=model,
        baselines=blocks,
        reference_baseline=reference_baseline,
        n_windows=n_windows,
        retention=retention or {},
        extras=extras or {},
    )
