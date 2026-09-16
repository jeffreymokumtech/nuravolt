"""RUL prediction metrics — comparing predicted EOL to actual EOL.

Used by the BESS validation script to score each cell-level prediction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass
class RulReport:
    dataset: str
    n_cells: int
    predictions: List[Dict[str, Any]]   # per-cell: {cell_id, actual_eol, predicted_eol, error_pct}
    mape: float                          # mean absolute percentage error
    rmse_cycles: float
    eol_within_10pct_fraction: float
    eol_within_25pct_fraction: float
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dataset": self.dataset,
            "n_samples": self.n_cells,
            "n_cells": self.n_cells,
            "predictions": self.predictions,
            "mape": round(self.mape, 4),
            "rmse_cycles": round(self.rmse_cycles, 1),
            "eol_within_10pct_fraction": round(self.eol_within_10pct_fraction, 3),
            "eol_within_25pct_fraction": round(self.eol_within_25pct_fraction, 3),
            "extras": self.extras,
        }


def compute_rul_report(
    dataset: str,
    pairs: List[Dict[str, Any]],   # each: {cell_id, actual_eol, predicted_eol}
    extras: Dict[str, Any] | None = None,
) -> RulReport:
    """Build a RulReport from a list of (actual, predicted) EOL pairs."""
    n = len(pairs)
    if n == 0:
        return RulReport(
            dataset=dataset,
            n_cells=0,
            predictions=[],
            mape=0.0,
            rmse_cycles=0.0,
            eol_within_10pct_fraction=0.0,
            eol_within_25pct_fraction=0.0,
            extras=extras or {},
        )

    enriched = []
    abs_errors = []
    pct_errors = []
    within10 = 0
    within25 = 0
    for p in pairs:
        actual = float(p["actual_eol"])
        predicted = float(p["predicted_eol"])
        err = predicted - actual
        pct = abs(err) / actual if actual > 0 else 0
        enriched.append({
            "cell_id": p.get("cell_id"),
            "actual_eol": actual,
            "predicted_eol": predicted,
            "error_cycles": round(err, 1),
            "error_pct": round(pct, 3),
        })
        abs_errors.append(err ** 2)
        pct_errors.append(pct)
        if pct <= 0.10:
            within10 += 1
        if pct <= 0.25:
            within25 += 1

    rmse = (sum(abs_errors) / n) ** 0.5
    mape = sum(pct_errors) / n
    return RulReport(
        dataset=dataset,
        n_cells=n,
        predictions=enriched,
        mape=mape,
        rmse_cycles=rmse,
        eol_within_10pct_fraction=within10 / n,
        eol_within_25pct_fraction=within25 / n,
        extras=extras or {},
    )
