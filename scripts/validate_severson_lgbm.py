#!/usr/bin/env python3
"""LightGBM regressor benchmark for Severson cycle-life prediction.

Extends the delta-Q baseline with:
  - The 4 core delta-Q features (var, mean_abs, min, skew)
  - Companion features extracted from the per-cycle Qd series:
      * capacity_at_cycle_2 (initial)
      * capacity_at_cycle_100 (early fade signal)
      * mean_slope_first_100 (rough fade rate)
      * max_capacity (peak observed — captures formation effects)
      * cycles_to_99pct (when did first significant fade start)
  - LightGBM regressor (gradient boosted trees) replaces Ridge

Same leave-one-out protocol as the Ridge variant, target log10(EOL).

Usage:
    python scripts/validate_severson_lgbm.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import numpy as np
import polars as pl
from lightgbm import LGBMRegressor

from nuravolt.validation.severson_delta_q import extract_features_all
from nuravolt.validation.metrics.rul import compute_rul_report
from nuravolt.validation.report import write_report


RAW_DIR = REPO_ROOT / "backenddata" / "datasets" / "severson" / "raw"
CELLS_PARQUET = REPO_ROOT / "backenddata" / "datasets" / "severson" / "cells.parquet"

EOL_PREREQ_CYCLES = 100  # filter cells that died before feature-extraction window


def _capacity_features(caps: list[float]) -> dict:
    """Companion features from the per-cycle discharge capacity series."""
    if len(caps) < 100:
        return {}
    caps_arr = np.array(caps[:100])
    cap_2 = float(caps_arr[1]) if len(caps_arr) > 1 else float(caps_arr[0])
    cap_100 = float(caps_arr[-1])
    cap_max = float(caps_arr.max())
    # Linear slope cycles 2-100
    xs = np.arange(99)
    slope, intercept = np.polyfit(xs, caps_arr[1:100], 1)
    # First cycle below 99% of initial
    c0 = caps_arr[0]
    cycles_to_99pct = next((i for i, c in enumerate(caps_arr) if c < 0.99 * c0), 100)
    return {
        "capacity_at_cycle_2": cap_2,
        "capacity_at_cycle_100": cap_100,
        "capacity_max_first_100": cap_max,
        "slope_first_100": float(slope),
        "cycles_to_99pct": float(cycles_to_99pct),
    }


def main() -> int:
    print("=" * 60)
    print("Severson LightGBM regressor — delta-Q + companion features")
    print("=" * 60)

    if not CELLS_PARQUET.exists():
        print(f"Missing {CELLS_PARQUET}. Run scripts/preprocess_severson_battery.py first.")
        return 1

    cells_df = pl.read_parquet(CELLS_PARQUET)
    eols_all = {row["cell_id"]: int(row["eol_cycle"]) for row in cells_df.iter_rows(named=True)}
    caps_per_cell = {row["cell_id"]: list(row["capacity_over_cycles"]) for row in cells_df.iter_rows(named=True)}
    eols = {k: v for k, v in eols_all.items() if v >= EOL_PREREQ_CYCLES}
    print(f"  {len(eols_all)} cells total, {len(eols)} kept (EOL ≥ {EOL_PREREQ_CYCLES})")

    print(f"  extracting delta-Q features from {RAW_DIR}...")
    delta_q_features = extract_features_all(RAW_DIR)
    delta_q_features = [f for f in delta_q_features if f.cell_id in eols]
    print(f"  {len(delta_q_features)} cells with valid delta-Q features")

    # Build feature matrix
    rows = []
    valid_cells = []
    for f in delta_q_features:
        cell_id = f.cell_id
        if cell_id not in caps_per_cell:
            continue
        cap_feats = _capacity_features(caps_per_cell[cell_id])
        if not cap_feats:
            continue
        row = {
            "log_var_delta_q": f.log_var_delta_q,
            "log_mean_abs_delta_q": f.log_mean_abs_delta_q,
            "log_min_delta_q": f.log_min_delta_q,
            "delta_q_skew": f.delta_q_skew,
            **cap_feats,
        }
        rows.append(row)
        valid_cells.append(cell_id)

    X = np.array([[r[k] for k in rows[0].keys()] for r in rows])
    feature_names = list(rows[0].keys())
    y = np.array([np.log10(eols[c]) for c in valid_cells])
    print(f"  feature matrix: {X.shape[0]} cells × {X.shape[1]} features")

    # Leave-one-out LightGBM
    n = len(valid_cells)
    predictions = []
    print(f"  fitting {n} LightGBM models (leave-one-out)...")
    for i in range(n):
        mask = np.arange(n) != i
        model = LGBMRegressor(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            min_child_samples=5,
            random_state=42,
            verbose=-1,
            n_jobs=-1,
        )
        model.fit(X[mask], y[mask])
        y_pred_log = float(model.predict(X[i:i+1])[0])
        predicted = int(min(2500, max(100, 10 ** y_pred_log)))
        predictions.append({
            "cell_id": valid_cells[i],
            "actual_eol": eols[valid_cells[i]],
            "predicted_eol": predicted,
        })

    pairs = predictions
    report = compute_rul_report(
        dataset="Severson MIT-Stanford LFP (LightGBM delta-Q + companions)",
        pairs=pairs,
        extras={
            "model": "LGBMRegressor (200 trees, depth 4, min_child=5)",
            "features": feature_names,
            "validation": "leave-one-out cross-validation",
            "n_cells": n,
            "note": ("LightGBM with delta-Q + per-cycle capacity features. "
                     "Compare to Ridge baseline at severson_delta_q.json."),
        },
    )
    payload = report.to_dict()
    out_path = write_report("bess", "severson_lgbm", payload)
    print(
        f"\n  ✓ {report.n_cells} cells, "
        f"MAPE {report.mape*100:.1f}%, "
        f"within ±10%: {report.eol_within_10pct_fraction*100:.0f}%, "
        f"within ±25%: {report.eol_within_25pct_fraction*100:.0f}%, "
        f"RMSE {report.rmse_cycles:.0f} cycles"
    )
    print(f"  → {out_path}")

    # Feature importance from a full-data model
    full_model = LGBMRegressor(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        min_child_samples=5, random_state=42, verbose=-1, n_jobs=-1,
    )
    full_model.fit(X, y)
    fi = sorted(zip(feature_names, full_model.feature_importances_), key=lambda x: -x[1])
    print(f"\n  Feature importance (full-data model):")
    for f, i in fi:
        print(f"    {f:<28s} {i}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
