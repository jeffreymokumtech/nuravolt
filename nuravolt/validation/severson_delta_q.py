"""Severson delta-Q featurization — the actual published-baseline approach.

From Severson et al. 2019 (Nature Energy):
    "Variance of ΔQ_{100-10}(V) is the single most predictive feature for
    cycle life — R² = 0.86 on the validation batch, with a simple linear
    model on log(var) → log(cycle life)."

Implementation:
    1. For each cell, extract the (voltage, capacity) trajectory of the
       discharge phase at cycle 100 and cycle 10.
    2. Interpolate Q(V) onto a fixed voltage grid (3.5V → 2.0V, 1000 pts).
    3. Compute ΔQ(V) = Q_100(V) - Q_10(V).
    4. Feature: log10(var(ΔQ)).
    5. Predict log10(EOL) via Ridge regression on this feature (+ a few
       small companion features).

Why this works (per the paper): cycles 100 and 10 are both early in the
cell's life — capacity has barely faded so per-cycle EOL is unobservable.
But the SHAPE of the voltage-vs-capacity curve at cycle 100 already
contains information about the internal resistance growth that ultimately
drives the knee point. Cells that will have a knee soon show subtle
voltage-curve distortions early.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Tuple

import numpy as np
import polars as pl


VOLTAGE_GRID = np.linspace(2.0, 3.5, 1000)  # standard Severson grid


@dataclass
class DeltaQFeatures:
    cell_id: str
    log_var_delta_q: float
    log_mean_abs_delta_q: float
    log_min_delta_q: float
    delta_q_skew: float
    n_valid_points: int


def extract_features_for_cell(
    raw_parquet: Path,
    early_cycle: int = 10,
    late_cycle: int = 100,
    voltage_grid: np.ndarray = VOLTAGE_GRID,
) -> Optional[DeltaQFeatures]:
    """Extract delta-Q features from one cell's raw timeseries parquet."""
    df = pl.read_parquet(raw_parquet).filter(pl.col("step_id") == "discharge")
    if df.is_empty():
        return None

    def _q_at_voltage_grid(cycle_num: int) -> Optional[np.ndarray]:
        c = df.filter(pl.col("cycle_number") == cycle_num)
        if len(c) < 50:
            return None
        v = c["voltage_V"].to_numpy()
        q = c["capacity_Ah"].to_numpy()
        # np.interp wants ascending x — sort
        idx = np.argsort(v)
        v_sorted = v[idx]
        q_sorted = q[idx]
        # Deduplicate near-identical voltages (interp requires monotonic)
        keep = np.concatenate(([True], np.diff(v_sorted) > 1e-6))
        v_sorted = v_sorted[keep]
        q_sorted = q_sorted[keep]
        if len(v_sorted) < 50:
            return None
        # Interpolate Q at the standard voltage grid; values outside the
        # cell's observed voltage range get NaN (don't extrapolate).
        return np.interp(voltage_grid, v_sorted, q_sorted, left=np.nan, right=np.nan)

    q_early = _q_at_voltage_grid(early_cycle)
    q_late = _q_at_voltage_grid(late_cycle)
    if q_early is None or q_late is None:
        return None

    delta_q = q_late - q_early
    valid = ~np.isnan(delta_q)
    if valid.sum() < 100:
        return None

    dq = delta_q[valid]

    # Severson's headline feature — clip variance floor to avoid log(0)
    var_dq = max(float(np.var(dq)), 1e-12)
    mean_abs = max(float(np.mean(np.abs(dq))), 1e-12)
    min_dq = max(float(abs(np.min(dq))), 1e-12)

    # Skew
    mean_dq = float(np.mean(dq))
    std_dq = max(float(np.std(dq)), 1e-12)
    skew = float(np.mean(((dq - mean_dq) / std_dq) ** 3))

    return DeltaQFeatures(
        cell_id=raw_parquet.stem,
        log_var_delta_q=float(np.log10(var_dq)),
        log_mean_abs_delta_q=float(np.log10(mean_abs)),
        log_min_delta_q=float(np.log10(min_dq)),
        delta_q_skew=skew,
        n_valid_points=int(valid.sum()),
    )


def extract_features_all(raw_dir: Path) -> list[DeltaQFeatures]:
    """Process every raw cell parquet under ``raw_dir``."""
    out = []
    for fp in sorted(raw_dir.glob("*.parquet")):
        feats = extract_features_for_cell(fp)
        if feats is not None:
            out.append(feats)
    return out


def ridge_loo_predict(
    features: list[DeltaQFeatures],
    eols: dict[str, int],
    alpha: float = 1.0,
    eol_lower_bound: int = 100,
    eol_upper_bound: int = 2500,
) -> list[dict]:
    """Leave-one-out Ridge regression: for each cell, train on the other
    N-1 cells and predict its EOL. Returns per-cell prediction records.

    Target: log10(EOL_cycle). Features: 4 delta-Q descriptors.
    Predictions are de-logged before reporting.
    """
    feature_names = ["log_var_delta_q", "log_mean_abs_delta_q",
                     "log_min_delta_q", "delta_q_skew"]

    X = np.array([[getattr(f, k) for k in feature_names] for f in features])
    y = np.array([np.log10(max(eols[f.cell_id], 1)) for f in features])

    # Standardize features (mean 0, std 1) — Ridge sensitive to scale
    mu = X.mean(axis=0)
    sigma = X.std(axis=0) + 1e-12

    n = len(features)
    predictions = []
    for i in range(n):
        # Leave-one-out
        mask = np.arange(n) != i
        X_train = (X[mask] - mu) / sigma
        y_train = y[mask]
        x_test = (X[i] - mu) / sigma

        # Ridge: w = (X'X + αI)⁻¹ X'y, add intercept column
        X_aug = np.column_stack([np.ones(len(X_train)), X_train])
        d = X_aug.shape[1]
        A = X_aug.T @ X_aug + alpha * np.eye(d)
        A[0, 0] -= alpha  # don't regularize intercept
        try:
            w = np.linalg.solve(A, X_aug.T @ y_train)
        except np.linalg.LinAlgError:
            w = np.linalg.pinv(A) @ (X_aug.T @ y_train)

        x_test_aug = np.concatenate([[1.0], x_test])
        y_pred_log = float(x_test_aug @ w)
        # Bound prediction to physically plausible range (LFP cycling lives
        # ~100-2500 cycles in this dataset).
        predicted = int(min(eol_upper_bound, max(eol_lower_bound, 10 ** y_pred_log)))
        predictions.append({
            "cell_id": features[i].cell_id,
            "actual_eol": int(eols[features[i].cell_id]),
            "predicted_eol": predicted,
            "log_var_delta_q": features[i].log_var_delta_q,
        })

    return predictions
