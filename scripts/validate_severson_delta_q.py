#!/usr/bin/env python3
"""Validate Severson LFP cycle life with the published delta-Q model.

Pipeline:
    1. Load preprocessed cells.parquet (for ground-truth EOL).
    2. Walk every raw cell parquet, extract delta-Q features at cycles 10/100.
    3. Leave-one-out Ridge regression predicts log(EOL) per cell.
    4. Compare predicted vs actual EOL → metrics + report JSON.

Beats the naive linear baseline by capturing voltage-curve information that
cycle-aggregate capacity throws away.

Usage:
    python scripts/validate_severson_delta_q.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import polars as pl

from nuravolt.validation.severson_delta_q import extract_features_all, ridge_loo_predict
from nuravolt.validation.metrics.rul import compute_rul_report
from nuravolt.validation.report import write_report


RAW_DIR = REPO_ROOT / "backenddata" / "datasets" / "severson" / "raw"
CELLS_PARQUET = REPO_ROOT / "backenddata" / "datasets" / "severson" / "cells.parquet"


def main() -> int:
    if not CELLS_PARQUET.exists():
        print(f"Missing {CELLS_PARQUET}. Run scripts/preprocess_severson_battery.py first.")
        return 1
    if not RAW_DIR.exists() or not any(RAW_DIR.glob("*.parquet")):
        print(f"No raw cell parquets in {RAW_DIR}. Run scripts/fetch_severson_battery.py first.")
        return 1

    print("=" * 60)
    print("Severson delta-Q model — leave-one-out Ridge regression")
    print("=" * 60)

    # Ground truth EOL per cell. Filter out cells where EOL < 100 — these
    # reached the capacity threshold before our prediction window even ends,
    # so cycle-10/100 delta-Q features can't represent their failure mode
    # (the cell was already broken). Severson 2019 follows the same convention.
    EOL_PREREQ_CYCLES = 100
    cells_df = pl.read_parquet(CELLS_PARQUET)
    eols_all = {row["cell_id"]: int(row["eol_cycle"]) for row in cells_df.iter_rows(named=True)}
    eols = {k: v for k, v in eols_all.items() if v >= EOL_PREREQ_CYCLES}
    print(f"  {len(eols_all)} cells total, {len(eols)} kept (EOL ≥ {EOL_PREREQ_CYCLES} cycles)")

    # Extract delta-Q features for every cell
    print(f"  extracting delta-Q features from {RAW_DIR}...")
    features = extract_features_all(RAW_DIR)
    features = [f for f in features if f.cell_id in eols]
    print(f"  {len(features)} cells with valid features (cycles 10 + 100 present)")

    if len(features) < 5:
        print("  too few cells for leave-one-out — need at least 5.")
        return 1

    # Leave-one-out Ridge prediction
    predictions = ridge_loo_predict(features, eols, alpha=5.0)

    # Score
    pairs = [
        {"cell_id": p["cell_id"], "actual_eol": p["actual_eol"], "predicted_eol": p["predicted_eol"]}
        for p in predictions
    ]
    report = compute_rul_report(
        dataset="Severson MIT-Stanford LFP (delta-Q Ridge)",
        pairs=pairs,
        extras={
            "model": "Ridge regression on delta-Q features (Severson 2019)",
            "features": ["log_var_delta_q", "log_mean_abs_delta_q",
                         "log_min_delta_q", "delta_q_skew"],
            "cycles_used": [10, 100],
            "validation": "leave-one-out cross-validation",
            "ridge_alpha": 5.0,
            "n_cells": len(features),
            "reference": ("Severson et al. 2019 Nature Energy — single-feature "
                          "Ridge (log_var_delta_q only) achieved ~9% MAPE on the "
                          "primary test batch with 41 training cells."),
        },
    )
    payload = report.to_dict()
    out_path = write_report("bess", "severson_delta_q", payload)

    print(
        f"\n  ✓ {report.n_cells} cells, "
        f"MAPE {report.mape*100:.1f}%, "
        f"within ±10%: {report.eol_within_10pct_fraction*100:.0f}%, "
        f"within ±25%: {report.eol_within_25pct_fraction*100:.0f}%"
    )
    print(f"  → {out_path}")

    # Per-cell detail
    print(f"\n{'cell':<8} {'actual':<8} {'predicted':<10} {'err_pct':<8} {'log_var_dq':<12}")
    for p in sorted(predictions, key=lambda x: x["cell_id"]):
        err = abs(p["predicted_eol"] - p["actual_eol"]) / p["actual_eol"] * 100
        print(
            f"{p['cell_id']:<8} {p['actual_eol']:<8} {p['predicted_eol']:<10} "
            f"{err:<8.1f} {p['log_var_delta_q']:<12.3f}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
