#!/usr/bin/env python3
"""Train BESS-NMC LightGBM foundation from NASA per-cycle voltage curves.

Phase N-4. Replaces the deterministic linear-extrapolation `bess_nmc_v1`
with an actual LightGBM trained on delta-Q + per-cycle capacity features.

Process:
  1. Walk NASA .mat files, extract delta-Q features at cycles 10/100 via
     `nuravolt/validation/nasa_delta_q.py`
  2. Merge with per-cycle capacity series from `cells.parquet` (which the
     preprocessor already produces) → companion features
  3. Train LightGBM with leave-one-out evaluation
  4. Save the trained model as the new `bess_nmc_v1.pkl` (LGBM version)

Usage:
    python scripts/train_bess_nmc_foundation_lgbm.py
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

from nuravolt.validation.nasa_delta_q import extract_features_all

NASA_ROOT = REPO_ROOT / "backenddata" / "datasets" / "nasa_pcoe"
NASA_DATA_ROOT = NASA_ROOT / "5. Battery Data Set"
CELLS_PARQUET = NASA_ROOT / "batteries.parquet"

OUT_DIR = REPO_ROOT / "models" / "foundation"
MODEL_VERSION = "v1"
MODEL_PKL = OUT_DIR / f"bess_nmc_{MODEL_VERSION}.pkl"
MODEL_META = OUT_DIR / f"bess_nmc_{MODEL_VERSION}.meta.json"

EOL_THRESHOLD_AH = 1.4   # 70% of 2.0 Ah NMC convention
EOL_PREREQ_CYCLES = 100  # cells that died before cycle 100 can't be tested


def _capacity_features(caps: list[float]) -> dict:
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
    if not CELLS_PARQUET.exists():
        print(f"Missing {CELLS_PARQUET}. Run scripts/preprocess_nasa_pcoe.py first.")
        return 1
    if not NASA_DATA_ROOT.exists():
        print(f"Missing {NASA_DATA_ROOT}.")
        return 1

    print("=" * 60)
    print(f" BESS-NMC foundation {MODEL_VERSION} — LightGBM upgrade")
    print("=" * 60)

    # Ground truth EOL per cell
    cells_df = pl.read_parquet(CELLS_PARQUET)
    cells_df = cells_df.unique(subset=["battery_id"], keep="first")
    eols_all = {row["battery_id"]: int(row["eol_cycle"]) for row in cells_df.iter_rows(named=True)}
    caps_per_cell = {row["battery_id"]: list(row["capacity_over_cycles"]) for row in cells_df.iter_rows(named=True)}
    eols = {k: v for k, v in eols_all.items() if v >= EOL_PREREQ_CYCLES}
    print(f"  {len(eols_all)} cells total, {len(eols)} kept (EOL ≥ {EOL_PREREQ_CYCLES})")

    print(f"  extracting delta-Q features from NASA .mat files...")
    feats = extract_features_all(NASA_DATA_ROOT)
    # Dedup by cell_id (.mat files appear in multiple extracted folders)
    seen = set()
    feats_unique = []
    for f in feats:
        if f.cell_id in seen:
            continue
        seen.add(f.cell_id)
        feats_unique.append(f)
    feats = feats_unique
    print(f"  {len(feats)} unique cells produced delta-Q features (some discarded if <100 discharge cycles)")
    feats = [f for f in feats if f.cell_id in eols]
    print(f"  {len(feats)} usable after EOL filter")

    if len(feats) < 5:
        print("  too few cells for training — skipping")
        return 1

    rows = []
    valid_cells = []
    for f in feats:
        cf = _capacity_features(caps_per_cell[f.cell_id])
        if not cf:
            continue
        rows.append({
            "log_var_delta_q": f.log_var_delta_q,
            "log_mean_abs_delta_q": f.log_mean_abs_delta_q,
            "log_min_delta_q": f.log_min_delta_q,
            "delta_q_skew": f.delta_q_skew,
            **cf,
        })
        valid_cells.append(f.cell_id)

    feature_names = list(rows[0].keys())
    X = np.array([[r[k] for k in feature_names] for r in rows], dtype=float)
    y = np.array([np.log10(eols[c]) for c in valid_cells], dtype=float)
    print(f"  feature matrix: {X.shape[0]} cells × {X.shape[1]} features")

    # Leave-one-out evaluation
    print(f"  running LOO with LightGBM (n={len(valid_cells)})...")
    predictions = []
    for i in range(len(valid_cells)):
        mask = np.arange(len(valid_cells)) != i
        m = LGBMRegressor(n_estimators=200, max_depth=4, learning_rate=0.05,
                          min_child_samples=2, random_state=42, verbose=-1, n_jobs=-1)
        m.fit(X[mask], y[mask])
        y_pred_log = float(m.predict(X[i:i+1])[0])
        predicted = int(min(2500, max(50, 10 ** y_pred_log)))
        actual = eols[valid_cells[i]]
        predictions.append({
            "cell_id": valid_cells[i],
            "actual_eol": actual,
            "predicted_eol": predicted,
            "err_pct": abs(predicted - actual) / actual,
        })

    errs = [p["err_pct"] for p in predictions]
    mape = float(np.mean(errs))
    within_10 = sum(1 for e in errs if e <= 0.10) / len(errs)
    within_25 = sum(1 for e in errs if e <= 0.25) / len(errs)
    rmse = float(np.sqrt(np.mean([(p["predicted_eol"] - p["actual_eol"])**2 for p in predictions])))
    print(f"\n  LOO results:")
    print(f"    MAPE: {mape*100:.1f}%")
    print(f"    Within ±10%: {within_10*100:.0f}%")
    print(f"    Within ±25%: {within_25*100:.0f}%")
    print(f"    RMSE: {rmse:.0f} cycles")

    # Train final model on all cells for the shipped artifact
    full_model = LGBMRegressor(n_estimators=200, max_depth=4, learning_rate=0.05,
                               min_child_samples=2, random_state=42, verbose=-1, n_jobs=-1)
    full_model.fit(X, y)

    with open(MODEL_PKL, "wb") as f:
        pickle.dump(full_model, f)

    fi = sorted(zip(feature_names, [int(i) for i in full_model.feature_importances_]),
                key=lambda x: -x[1])
    meta = {
        "version": MODEL_VERSION,
        "model_type": "LGBMRegressor",
        "chemistry": "NMC",
        "trained_on": f"NASA PCoE — {len(valid_cells)} cells with extractable delta-Q features",
        "training_method": "delta-Q featurization at cycles 10/100 + per-cycle capacity (mirrors Severson 2019 method, adapted for NMC voltage range 2.7-4.1V)",
        "validation": (
            f"Leave-one-out: MAPE {mape*100:.1f}%, "
            f"{within_10*100:.0f}% within ±10%, {within_25*100:.0f}% within ±25%, "
            f"RMSE {rmse:.0f} cycles"
        ),
        "feature_names": feature_names,
        "feature_importance": [{"feature": f, "importance": i} for f, i in fi],
        "target": "log10(EOL_cycle), threshold 1.4 Ah (70% of 2.0 Ah NMC convention)",
        "physics_bounds": {"min_eol_cycles": 50, "max_eol_cycles": 2500},
        "training_temperature_c": 24,
        "loo_predictions": predictions[:30],   # cap for size
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "notes": [
            "Replaces the linear-extrapolation baseline (also v1, 29.5% MAPE).",
            f"Trained on {len(valid_cells)} cells vs Severson's 123 — data-limited so LOO MAPE expected higher than LFP's 17%.",
            "Voltage grid 2.7-4.1V tuned for NMC (LFP uses 2.0-3.5V).",
        ],
    }
    MODEL_META.write_text(json.dumps(meta, indent=2))

    print(f"\n  wrote model:    {MODEL_PKL}  ({MODEL_PKL.stat().st_size:,} bytes)")
    print(f"  wrote metadata: {MODEL_META}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
