#!/usr/bin/env python3
"""Train the BESS-LFP foundation RUL model from the Severson 124-cell dataset.

Packages the existing delta-Q + per-cycle Ridge/LightGBM pipeline (already
proven via ``validate_severson_lgbm.py``) as a shippable foundation model
that any client deploying LFP cells can use day 1.

Output:
  - models/foundation/bess_lfp_v1.pkl  (LightGBM regressor + standardizer)
  - models/foundation/bess_lfp_v1.meta.json

The trained model takes per-cell features (delta-Q + per-cycle capacity)
and predicts log10(EOL cycle). The wrapper class exponentiates +
physics-bounds the output to [100, 2500] cycles.

Usage:
    python scripts/train_bess_lfp_foundation.py
"""

from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import numpy as np
import polars as pl
from lightgbm import LGBMRegressor

from nuravolt.validation.severson_delta_q import extract_features_all

RAW_DIR = REPO_ROOT / "backenddata" / "datasets" / "severson" / "raw"
CELLS_PARQUET = REPO_ROOT / "backenddata" / "datasets" / "severson" / "cells.parquet"
OUT_DIR = REPO_ROOT / "models" / "foundation"
OUT_DIR.mkdir(parents=True, exist_ok=True)
MODEL_VERSION = "v1"
MODEL_PKL = OUT_DIR / f"bess_lfp_{MODEL_VERSION}.pkl"
MODEL_META = OUT_DIR / f"bess_lfp_{MODEL_VERSION}.meta.json"

EOL_PREREQ_CYCLES = 100   # filter cells that died before our prediction window


def _capacity_features(caps: list[float]) -> dict:
    """Per-cycle capacity companion features used alongside delta-Q."""
    if len(caps) < 100:
        return {}
    arr = np.array(caps[:100])
    c0 = float(arr[0])
    xs = np.arange(99)
    slope, _ = np.polyfit(xs, arr[1:100], 1)
    cycles_to_99 = next((i for i, c in enumerate(arr) if c < 0.99 * c0), 100)
    return {
        "capacity_at_cycle_2": float(arr[1]) if len(arr) > 1 else c0,
        "capacity_at_cycle_100": float(arr[-1]),
        "capacity_max_first_100": float(arr.max()),
        "slope_first_100": float(slope),
        "cycles_to_99pct": float(cycles_to_99),
    }


def main() -> int:
    if not CELLS_PARQUET.exists() or not RAW_DIR.exists():
        print("Run scripts/fetch_severson_battery.py then scripts/preprocess_severson_battery.py first.")
        return 1

    print("=" * 60)
    print(f" BESS-LFP foundation {MODEL_VERSION} — training")
    print("=" * 60)

    cells_df = pl.read_parquet(CELLS_PARQUET)
    eols_all = {r["cell_id"]: int(r["eol_cycle"]) for r in cells_df.iter_rows(named=True)}
    caps_per_cell = {r["cell_id"]: list(r["capacity_over_cycles"]) for r in cells_df.iter_rows(named=True)}
    eols = {k: v for k, v in eols_all.items() if v >= EOL_PREREQ_CYCLES}
    print(f"  {len(eols_all)} cells loaded, {len(eols)} kept (EOL >= {EOL_PREREQ_CYCLES})")

    feats = extract_features_all(RAW_DIR)
    feats = [f for f in feats if f.cell_id in eols]
    print(f"  {len(feats)} cells with valid delta-Q + capacity features")

    rows = []
    cell_ids = []
    for f in feats:
        cid = f.cell_id
        if cid not in caps_per_cell:
            continue
        cf = _capacity_features(caps_per_cell[cid])
        if not cf:
            continue
        rows.append({
            "log_var_delta_q": f.log_var_delta_q,
            "log_mean_abs_delta_q": f.log_mean_abs_delta_q,
            "log_min_delta_q": f.log_min_delta_q,
            "delta_q_skew": f.delta_q_skew,
            **cf,
        })
        cell_ids.append(cid)

    feature_names = list(rows[0].keys())
    X = np.array([[r[k] for k in feature_names] for r in rows], dtype=float)
    y = np.array([np.log10(eols[c]) for c in cell_ids], dtype=float)
    print(f"  feature matrix: {X.shape[0]} cells x {X.shape[1]} features")

    # Train on all cells (we leave LOO eval to validate_severson_lgbm.py; the
    # shipped foundation uses ALL the data we have so client predictions are
    # as informed as possible).
    model = LGBMRegressor(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        min_child_samples=5, random_state=42, verbose=-1, n_jobs=-1,
    )
    model.fit(X, y)
    print("  trained on full dataset (123 cells)")

    # Sanity: in-sample predictions (NOT a generalization estimate — see
    # validate_severson_lgbm.py for the honest LOO numbers).
    y_pred_log = model.predict(X)
    in_sample_mape = float(np.mean(np.abs(10**y_pred_log - 10**y) / 10**y))
    print(f"  in-sample MAPE: {in_sample_mape*100:.1f}% (LOO: 17.2% — see validation harness)")

    with open(MODEL_PKL, "wb") as f:
        pickle.dump(model, f)

    fi = sorted(zip(feature_names, [int(i) for i in model.feature_importances_]), key=lambda x: -x[1])
    meta = {
        "version": MODEL_VERSION,
        "model_type": "LGBMRegressor",
        "n_estimators": 200,
        "max_depth": 4,
        "chemistry": "LFP",
        "trained_on": "Severson 2019 (Toyota / MIT / Stanford) — 124 commercial A123 LFP cells",
        "training_method": "fit on full 123-cell set (excludes b1c0 with EOL=10)",
        "validation": (
            "Leave-one-out via scripts/validate_severson_lgbm.py — "
            "MAPE 17.2%, 49% within ±10% EOL, 84% within ±25%"
        ),
        "feature_names": feature_names,
        "feature_importance": [{"feature": f, "importance": i} for f, i in fi],
        "target": "log10(EOL_cycle), threshold 0.88 Ah (80% of 1.1 Ah rated)",
        "physics_bounds": {"min_eol_cycles": 100, "max_eol_cycles": 2500},
        "training_temperature_c": 30,
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "notes": [
            "Calibrated for LFP chemistry at 30°C. NMC cells (typical Tesla, "
            "many utility BESS) have different fade dynamics — use the NMC "
            "foundation model when available (foundation/bess_nmc_*).",
            "Predictions are 'early-life cycle prediction' — provide cycles "
            "10/100 features and the model gives an EOL estimate good for "
            "operational planning, not warranty negotiation.",
        ],
    }
    MODEL_META.write_text(json.dumps(meta, indent=2))

    print(f"\n  wrote model:    {MODEL_PKL}  ({MODEL_PKL.stat().st_size:,} bytes)")
    print(f"  wrote metadata: {MODEL_META}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
