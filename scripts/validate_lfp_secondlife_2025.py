#!/usr/bin/env python3
"""Validate naive LFP RUL baseline against the 2025 second-life LFP dataset.

Phase N-6. We have 20 Graphite/LFP 18650 cells from the Recherche Data
Gouv dataset (DOI 10.57745/OLBXKT) with per-checkpoint capacity + EOL.
This is a DIFFERENT cell vendor + cycling protocol from Severson's A123
cells. Validates whether our naive linear-extrapolation baseline transfers
to a different LFP cohort.

We can't run bess_lfp_v1 (LightGBM) here because the summary file lacks
per-timestep voltage curves needed for delta-Q featurization. Per-cell
ZIPs (1.2 GB each, 24 GB total) would give that — manual fetch decision.

What we test: take each cell's capacity trajectory, apply our linear
extrapolator (same as scripts/validate_bess_rul.py), compare predicted
EOL to observed. Honest expectation: linear works for monotonic LFP fade
but may miss the knee point that distinguishes Severson cells.

Usage:
    python scripts/validate_lfp_secondlife_2025.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import numpy as np
import polars as pl

from nuravolt.validation.metrics.rul import compute_rul_report
from nuravolt.validation.report import write_report

CELLS_PARQUET = REPO_ROOT / "backenddata" / "datasets" / "lfp_secondlife_2025" / "cells_summary.parquet"

EOL_THRESHOLD_AH = 0.88   # 80% of 1.1 Ah


#: A hard physical ceiling, not a bound derived from the observed labels.
_MAX_PLAUSIBLE_CYCLES = 20000


def _predict_eol_linear_from_checkpoints(
    cycles: list[int], capacities: list[float]
) -> int | None:
    """Linear extrapolation EOL from the first 25% of checkpoints.

    Adapted from scripts/validate_bess_rul.py — but works on irregular
    cycle checkpoints (not consecutive cycles) since this dataset only has
    33-67 characterization checkpoints per cell.

    Returns None when no prediction is possible. The failure paths used to
    return ``cycles[-1]`` or ``max(cycles)``, the cell's last observed
    checkpoint, which for a run-to-failure cell sits next to the label. The
    sibling validator had the same defect in a starker form and it inflated a
    published figure, so the pattern is removed here too even though this
    dataset's artifact shows no exact label returns.
    """
    if len(cycles) < 4:
        return None
    n_early = max(4, len(cycles) // 4)
    xs = np.array(cycles[:n_early], dtype=float)
    ys = np.array(capacities[:n_early], dtype=float)
    if len(xs) < 2:
        return None
    slope, intercept = np.polyfit(xs, ys, 1)
    if slope >= 0:
        return None
    predicted = (EOL_THRESHOLD_AH - intercept) / slope
    # Bound only by physics, not by this dataset's observed EOL range. The old
    # bound cited "observed EOL 500-1100", which is the answer.
    if predicted <= 0:
        return None
    return int(min(_MAX_PLAUSIBLE_CYCLES, max(1, predicted)))


def main() -> int:
    if not CELLS_PARQUET.exists():
        print(f"Missing {CELLS_PARQUET}")
        print(f"  Run: python scripts/preprocess_lfp_secondlife_2025.py")
        return 1

    print("=" * 60)
    print(" LFP second-life 2025 — naive baseline cross-dataset")
    print("=" * 60)

    df = pl.read_parquet(CELLS_PARQUET)
    print(f"\n  loaded {len(df)} cells")

    pairs = []
    for row in df.iter_rows(named=True):
        if not row.get("reached_eol"):
            continue   # skip cells that didn't reach EOL — can't validate
        cycles = list(row["checkpoint_cycles"])
        capacities = list(row["checkpoint_capacities_ah"])
        predicted = _predict_eol_linear_from_checkpoints(cycles, capacities)
        if predicted is None:
            continue
        pairs.append({
            "cell_id": row["cell_id"],
            "actual_eol": row["eol_cycle"],
            "predicted_eol": predicted,
        })

    if not pairs:
        print("  no cells with observed EOL — can't validate")
        return 1

    report = compute_rul_report(
        dataset="LFP second-life 2025 (Recherche Data Gouv, 20 cells)",
        pairs=pairs,
        extras={
            "method": "linear extrapolation from first 25% of checkpoints",
            "eol_threshold_ah": EOL_THRESHOLD_AH,
            "source": "DOI 10.57745/OLBXKT (extractedData.mat summary file only)",
            "n_cells_total": int(len(df)),
            "n_cells_reached_eol": len(pairs),
            "note": (
                "Cross-dataset baseline test. Different cell vendor than Severson "
                "(this dataset uses different LFP cycling protocol). Linear "
                "extrapolation only — bess_lfp_v1 LightGBM model requires per-"
                "timestep voltage curves not in the summary file."
            ),
        },
    )

    print(f"\n  {report.n_cells} cells with observed EOL")
    print(f"    MAPE: {report.mape*100:.1f}%")
    print(f"    Within ±10%: {report.eol_within_10pct_fraction*100:.0f}%")
    print(f"    Within ±25%: {report.eol_within_25pct_fraction*100:.0f}%")
    print(f"    RMSE: {report.rmse_cycles:.0f} cycles")
    print(f"\n  Per-cell predictions:")
    for p in report.predictions[:10]:
        print(f"    {p['cell_id']:>8}: actual={p['actual_eol']:>5}  predicted={p['predicted_eol']:>5}  err={p['error_pct']*100:>5.1f}%")

    payload = report.to_dict()
    out_path = write_report("bess", "lfp_secondlife_2025", payload)
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
