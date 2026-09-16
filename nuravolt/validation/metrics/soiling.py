"""Soiling validation metrics — daily/monthly RMSE on predicted vs ground-truth SR."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass
class SoilingReport:
    dataset: str
    n_days: int
    rmse: float                 # on daily SR (0-1)
    mae: float
    monthly_loss_predicted: float    # mean monthly SR loss (1 - sr)
    monthly_loss_actual: float
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dataset": self.dataset,
            "n_samples": self.n_days,
            "n_days": self.n_days,
            "rmse": round(self.rmse, 4),
            "mae": round(self.mae, 4),
            "monthly_loss_predicted_pct": round(self.monthly_loss_predicted * 100, 2),
            "monthly_loss_actual_pct": round(self.monthly_loss_actual * 100, 2),
            "extras": self.extras,
        }


def compute_soiling_report(
    dataset: str,
    actual_sr: List[float],
    predicted_sr: List[float],
    extras: Dict[str, Any] | None = None,
) -> SoilingReport:
    n = len(actual_sr)
    if n == 0 or len(predicted_sr) != n:
        raise ValueError("actual_sr and predicted_sr must be non-empty and aligned")

    diffs = [(a - p) for a, p in zip(actual_sr, predicted_sr)]
    mae = sum(abs(d) for d in diffs) / n
    rmse = (sum(d ** 2 for d in diffs) / n) ** 0.5

    loss_actual = sum(1 - a for a in actual_sr) / n
    loss_predicted = sum(1 - p for p in predicted_sr) / n

    return SoilingReport(
        dataset=dataset,
        n_days=n,
        rmse=rmse,
        mae=mae,
        monthly_loss_predicted=loss_predicted,
        monthly_loss_actual=loss_actual,
        extras=extras or {},
    )
