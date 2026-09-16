"""Forecast validation metrics: normalised error plus skill score vs a baseline.

A forecast error on its own says almost nothing, because it is dominated by how
variable the site is. The number that means something is the *skill score*: how
much better the model is than the cheapest defensible alternative.

    SS = 1 - nMAE_model / nMAE_baseline

    SS  > 0   model beats the baseline
    SS == 0   model is worth exactly as much as guessing "same as yesterday"
    SS  < 0   the baseline is better, and the model should not be shipped

Both terms must be computed over the *identical* filtered sample, otherwise the
score is meaningless. ``compute_forecast_report`` enforces that by taking both
series at once rather than accepting a pre-computed baseline figure.

Standard baselines
------------------
``persistence``   yesterday's value repeated. The universal reference.
``climatology``   the day-of-year mean from the training period.
``physics_only``  the physics twin driven by observed irradiance. Included so
                  the physics-vs-ML question is answered on the artifact.

Abbreviations used in the payload: nMAE is normalised mean absolute error,
MBE is mean bias error, NWP is numerical weather prediction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Sequence

from nuravolt.validation.metrics.twin import ErrorBlock, compute_error_block

# Normaliser identifiers, mirroring metrics.twin.
NORM_MEAN = "mean_measured"           # % of the test-set mean of the target
NORM_CAPACITY = "capacity_per_period"  # % of nameplate x period length


@dataclass
class ForecastReport:
    dataset: str
    n_samples: int
    horizon_hours: float
    normalizer: str
    normalizer_value: float
    model: ErrorBlock
    baselines: Dict[str, ErrorBlock] = field(default_factory=dict)
    primary_baseline: str = "persistence"
    driver: str = "endogenous"        # "endogenous" | "nwp" | "observed_irradiance"
    n_windows: Optional[int] = None
    retention: Dict[str, Any] = field(default_factory=dict)
    extras: Dict[str, Any] = field(default_factory=dict)

    @property
    def skill_score(self) -> Optional[float]:
        base = self.baselines.get(self.primary_baseline)
        if base is None or base.nmae_pct == 0:
            return None
        return 1.0 - (self.model.nmae_pct / base.nmae_pct)

    def to_dict(self) -> Dict[str, Any]:
        base = self.baselines.get(self.primary_baseline)
        payload: Dict[str, Any] = {
            "dataset": self.dataset,
            "n_samples": self.n_samples,
            "n_windows": self.n_windows,
            "horizon_hours": self.horizon_hours,
            "driver": self.driver,
            "normalizer": self.normalizer,
            "normalizer_value": round(self.normalizer_value, 3),
            "nmae_pct": round(self.model.nmae_pct, 3),
            "mbe_pct": round(self.model.mbe_pct, 3),
            "baseline": self.primary_baseline,
            "model": self.model.to_dict(),
            "baselines": {k: v.to_dict() for k, v in self.baselines.items()},
            "retention": self.retention,
            "extras": self.extras,
        }
        if base is not None:
            payload["baseline_nmae_pct"] = round(base.nmae_pct, 3)
        ss = self.skill_score
        if ss is not None:
            payload["skill_score"] = round(ss, 4)
        for label in ("physics_only", "physics_perfect_irradiance"):
            block = self.baselines.get(label)
            if block is None:
                continue
            payload["reference_baseline"] = label
            payload["reference_nmae_pct"] = round(block.nmae_pct, 3)
            if block.nmae_pct:
                payload["uplift_vs_reference_pct"] = round(
                    (block.nmae_pct - self.model.nmae_pct) / block.nmae_pct * 100, 2
                )
            break
        return payload


def compute_forecast_report(
    dataset: str,
    actual: Sequence[float],
    predicted: Sequence[float],
    baselines: Dict[str, Sequence[float]],
    horizon_hours: float,
    normalizer: str = NORM_MEAN,
    normalizer_value: Optional[float] = None,
    primary_baseline: str = "persistence",
    driver: str = "endogenous",
    n_windows: Optional[int] = None,
    retention: Optional[Dict[str, Any]] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> ForecastReport:
    """Score a forecast against its baselines over one identical sample.

    ``normalizer_value`` defaults to the mean of ``actual`` when ``normalizer``
    is NORM_MEAN, which is the right choice for energy targets. Pass it
    explicitly (nameplate x period length) for NORM_CAPACITY.
    """
    if primary_baseline not in baselines:
        raise ValueError(
            f"primary_baseline {primary_baseline!r} missing from baselines "
            f"{sorted(baselines)}. A forecast number without its baseline is "
            f"not publishable."
        )
    for label, series in baselines.items():
        if len(series) != len(actual):
            raise ValueError(
                f"baseline {label!r} has {len(series)} points but actual has "
                f"{len(actual)}; skill score requires an identical sample"
            )

    finite = [float(a) for a in actual if a is not None and math.isfinite(float(a))]
    if normalizer_value is None:
        if normalizer != NORM_MEAN:
            raise ValueError("normalizer_value is required unless normalizer is NORM_MEAN")
        normalizer_value = sum(finite) / len(finite)

    model = compute_error_block("model", actual, predicted, normalizer_value)
    blocks = {
        label: compute_error_block(label, actual, series, normalizer_value)
        for label, series in baselines.items()
    }

    return ForecastReport(
        dataset=dataset,
        n_samples=len(finite),
        horizon_hours=horizon_hours,
        normalizer=normalizer,
        normalizer_value=normalizer_value,
        model=model,
        baselines=blocks,
        primary_baseline=primary_baseline,
        driver=driver,
        n_windows=n_windows,
        retention=retention or {},
        extras=extras or {},
    )
