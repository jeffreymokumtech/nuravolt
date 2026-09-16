#!/usr/bin/env python3
"""Validate BESS RUL models against labeled public datasets.

Currently supports:
    severson  — Severson / Toyota / MIT-Stanford LFP cycling dataset
    nasa      — NASA Ames PCoE Battery Aging Dataset
    multistage — Multi-Stage BESS Aging Dataset (Goldsworthy et al. 2024)

All three are public but distributed via JS-rendered web UIs without
curlable URLs. Each adapter raises FileNotFoundError with manual-fetch
instructions when the underlying data isn't on disk; this script then
emits a "pending fetch" report so the overall summary reflects status.

Usage:
    python scripts/validate_bess_rul.py             # all
    python scripts/validate_bess_rul.py severson    # subset
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nuravolt.validation.adapters.severson import load_severson
from nuravolt.validation.adapters.nasa_pcoe import load_nasa_pcoe
from nuravolt.validation.metrics.rul import compute_rul_report
from nuravolt.validation.report import write_report


#: Cap an extrapolated prediction at this multiple of the window the predictor
#: actually observed. The previous clamp was ``len(capacity) * 3``, a multiple of
#: the ANSWER, which leaked the label into every long extrapolation. A multiple of
#: the observed window uses only what the predictor legitimately has.
_MAX_HORIZON_MULTIPLE = 10


def _predict_eol_from_capacity_curve(
    capacity: list[float],
    threshold_ah: float | None = None,
    threshold_fraction: float = 0.70,
    prediction_window: int = 50,
    fade_onset_fraction: float | None = 0.97,
    recent_slope_window: int | None = None,
) -> int | None:
    """Predict EOL via linear extrapolation from the onset of meaningful fade.

    Naive first-N-cycle extrapolation fails on LFP cells which exhibit a
    pronounced "knee" — early cycles show ~zero fade, so the linear slope
    is meaningless. This baseline instead waits until capacity has dropped
    to ``fade_onset_fraction × initial`` (e.g. 97%), then fits a line over
    the next ``prediction_window`` cycles.

    For NASA's NMC cells which fade roughly linearly from cycle 0, the
    onset triggers in the first cycle and we get the same behaviour as
    the simple first-N approach. For LFP cells the onset triggers later
    where there's real signal to fit.

    Args:
        capacity: per-cycle discharge capacity (Ah)
        threshold_ah: absolute EOL threshold (e.g. 1.4 for NASA). If None,
            uses ``threshold_fraction × initial``.
        threshold_fraction: fallback for relative threshold.
        prediction_window: number of cycles after fade onset to fit.
        fade_onset_fraction: trigger fade-onset when capacity drops below
            this fraction of initial.

    Returns:
        Predicted end-of-life cycle, or **None when no prediction is possible**.

    WHY None AND NOT ``len(capacity)``
    ----------------------------------
    Every failure path here used to ``return None``. For a cell that has
    been run to end of life, ``len(capacity)`` IS the label. So the baseline was
    handed the answer whenever it could not compute one, and those returns scored
    as perfect predictions.

    The effect was not marginal. On the NASA set, 7 of 13 cells returned the label
    exactly, which is 78% of everything counted as "within 10%". On Severson it was
    4 of 4: the baseline's entire apparent skill was leakage, and its true score is
    zero. A published comparison against our own model was therefore flattering the
    baseline with our own ground truth.

    A baseline that cannot make a prediction must abstain and be counted as
    abstaining. Coverage is then reported alongside accuracy, so a method that only
    answers on easy cells cannot hide behind a high score on the few it attempts.
    """
    if not capacity:
        return None

    c0 = capacity[0]
    threshold = threshold_ah if threshold_ah is not None else threshold_fraction * c0

    if fade_onset_fraction is None:
        # First-N-cycles strategy — appropriate for cells with monotonic
        # early fade (e.g. NASA NMC).
        for i, c in enumerate(capacity[:prediction_window]):
            if c < threshold:
                return i
        onset_idx = 0
    else:
        # Fade-onset strategy — appropriate for LFP cells where early
        # cycles show ~zero fade and the slope only becomes meaningful
        # after the knee.
        onset_threshold = fade_onset_fraction * c0
        onset_idx = next((i for i, c in enumerate(capacity) if c < onset_threshold), None)
        if onset_idx is None:
            return None
        if capacity[onset_idx] < threshold:
            return onset_idx

    # Define the prediction window after onset
    end_idx = min(onset_idx + prediction_window, len(capacity))
    full_window = capacity[onset_idx:end_idx]
    if len(full_window) < 3:
        return None

    import numpy as np

    if fade_onset_fraction is not None:
        # Quadratic fit captures LFP knee acceleration: capacity ≈ a + bx + cx²
        # where c < 0 means accelerating fade. Solve a + bx + cx² = threshold.
        ys = np.array(full_window)
        xs = np.arange(len(ys))
        try:
            coeffs = np.polyfit(xs, ys, deg=2)  # [c, b, a]
            c, b, a = coeffs
        except Exception:
            return None

        # Solve quadratic for x where capacity = threshold:
        #   c x² + b x + (a - threshold) = 0
        target_a = a - threshold
        disc = b * b - 4 * c * target_a
        if disc < 0 or c == 0:
            # Fall back to linear slope from last quarter of window
            recent = ys[-max(10, len(ys) // 4):]
            rx = np.arange(len(recent))
            slope, intercept = np.polyfit(rx, recent, deg=1)
            if slope >= 0:
                return None
            rel_predicted = (threshold - intercept) / slope
            anchor = onset_idx + (len(ys) - len(recent))
            return max(end_idx, min(_MAX_HORIZON_MULTIPLE * end_idx, anchor + int(rel_predicted)))

        # Take the root that's beyond the current window (forward-in-time)
        sqrt_disc = disc ** 0.5
        x1 = (-b + sqrt_disc) / (2 * c)
        x2 = (-b - sqrt_disc) / (2 * c)
        candidates = [x for x in (x1, x2) if x > len(ys)]
        if not candidates:
            return None
        rel_predicted = min(candidates)
        predicted = onset_idx + int(rel_predicted)
        return max(end_idx, min(_MAX_HORIZON_MULTIPLE * end_idx, predicted))

    # NASA / linear path (unchanged behaviour)
    n = len(full_window)
    xs = list(range(n))
    x_mean = sum(xs) / n
    y_mean = sum(full_window) / n
    cov = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, full_window))
    var = sum((x - x_mean) ** 2 for x in xs)
    slope = cov / var if var > 0 else 0
    intercept = y_mean - slope * x_mean
    if slope >= 0:
        return None
    rel_predicted = (threshold - intercept) / slope
    predicted = onset_idx + int(rel_predicted)
    return max(end_idx, min(_MAX_HORIZON_MULTIPLE * end_idx, predicted))


def _validate_dataset(name: str, loader, dataset_label: str) -> dict:
    print(f"\n── {dataset_label} ──")
    try:
        cells = loader()
    except FileNotFoundError as e:
        print(f"  ⏸  data not yet fetched")
        for line in str(e).splitlines():
            print(f"     {line}")
        payload = {
            "dataset": dataset_label,
            "status": "pending_manual_fetch",
            "reason": str(e),
            "n_samples": 0,
        }
        write_report("bess", name, payload)
        return payload

    # NASA: EOL at 1.4 Ah (70% of 2.0 Ah rated), short lifetimes (96-168 cycles)
    #        → predict from first 50 cycles, absolute threshold 1.4
    # Severson: EOL at 0.88 Ah (80% of 1.1 Ah rated), long lifetimes (100-2300)
    #        → predict from first 100 cycles, threshold from initial × 0.80
    # Per-dataset strategy:
    #   NASA NMC fades roughly linearly from cycle 0 → first-N linear fit works
    #   Severson LFP has knee point → fade-onset + RECENT-slope (post-knee).
    #     Using the last 50 cycles of a 200-cycle post-onset window captures
    #     the post-knee acceleration that average-slope misses.
    is_nasa = "NASA" in dataset_label
    threshold_ah = 1.4 if is_nasa else None
    prediction_window = 50 if is_nasa else 200
    fade_onset = None if is_nasa else 0.97
    recent_window = None if is_nasa else 50

    pairs = []
    abstained: list = []
    observed: list = []
    for cell in cells:
        actual = cell.eol_cycle
        predicted = _predict_eol_from_capacity_curve(
            cell.capacity_over_cycles,
            threshold_ah=threshold_ah,
            threshold_fraction=0.80,
            prediction_window=prediction_window,
            fade_onset_fraction=fade_onset,
            recent_slope_window=recent_window,
        )
        # A cell whose capacity crosses the threshold INSIDE the window the
        # predictor is allowed to see has not been predicted, it has been watched.
        # On NASA this is 9 of 13 cells, and 7 of the 9 scored "within 10%" were
        # cells the predictor simply saw die. Scoring those as prediction skill
        # inflates the result and is why NASA read 69% when genuine forward
        # prediction succeeded on 2 of 13.
        observation_horizon = prediction_window
        if actual is not None and actual <= observation_horizon:
            observed.append({
                "cell_id": getattr(cell, "cell_id", getattr(cell, "battery_id", "?")),
                "actual_eol": actual,
                "reason": f"EOL at cycle {actual} is inside the {observation_horizon}-cycle window",
            })
            continue

        if predicted is None:
            # The baseline abstained. Recording it as a pair would mean inventing
            # a number; recording len(capacity) -- as this file used to -- means
            # handing it the label. Count it and exclude it from scoring.
            abstained.append(getattr(cell, "cell_id", getattr(cell, "battery_id", "?")))
            continue
        pairs.append({
            "cell_id": getattr(cell, "cell_id", getattr(cell, "battery_id", "?")),
            "actual_eol": actual,
            "predicted_eol": predicted,
        })

    n_total = len(cells)
    n_forecastable = n_total - len(observed)
    coverage = len(pairs) / n_forecastable if n_forecastable else 0.0
    if observed:
        print(f"  {len(observed)}/{n_total} cells reach EOL inside the "
              f"{prediction_window}-cycle observation window: observed, not predicted, excluded")
    if abstained:
        print(f"  baseline abstained on {len(abstained)}/{n_forecastable} forecastable cells")
    print(f"  scoring {len(pairs)} genuinely forward-predicted cells "
          f"(coverage {coverage:.0%} of forecastable)")

    if not pairs:
        payload = {
            "dataset": dataset_label,
            "status": "no_prediction_possible",
            "n_samples": 0,
            "n_cells": n_total,
            "coverage": 0.0,
            "abstained_cells": abstained,
            "note": ("The baseline could not produce a single prediction without "
                     "being handed the label. It has no measurable skill on this "
                     "dataset."),
        }
        write_report("bess", name, payload)
        return payload

    report = compute_rul_report(
        dataset=dataset_label,
        pairs=pairs,
        extras={
            "prediction_method": f"linear extrapolation from first {prediction_window} cycles",
            "eol_threshold_ah": threshold_ah,
            "eol_threshold_fraction": 0.80 if not is_nasa else None,
            "n_cells": len(cells),
            "n_cells_scored": len(pairs),
            "n_cells_abstained": len(abstained),
            "n_cells_observed_not_predicted": len(observed),
            "cells_observed_not_predicted": observed,
            "n_cells_forecastable": n_forecastable,
            "coverage_of_forecastable": round(coverage, 4),
            "scoring_note": (
                "Scored only on cells whose EOL lies BEYOND the observation window "
                "(otherwise the predictor watches the cell die rather than "
                "predicting it) AND where the baseline produced a prediction. "
                "It previously returned len(capacity) on every failure path, which "
                "for a run-to-failure cell IS the label; those returns scored as "
                "perfect. Coverage is published so a method that only answers on "
                "easy cells cannot hide behind a high score."
            ),
            "note": (
                "Naive linear-fit baseline. Severson 2019 Nature Energy paper "
                "achieved ~9% MAPE using delta-Q featurization; this is the "
                "much-simpler floor."
            ),
        },
    )
    payload = report.to_dict()
    out_path = write_report("bess", name, payload)
    print(
        f"  ✓ {report.n_cells} cells, "
        f"MAPE {report.mape*100:.1f}%, "
        f"within ±10%: {report.eol_within_10pct_fraction*100:.0f}%, "
        f"within ±25%: {report.eol_within_25pct_fraction*100:.0f}%"
    )
    print(f"  → {out_path}")
    return payload


DATASETS = {
    "severson":  (load_severson,  "Severson MIT-Stanford LFP (124 cells)"),
    "nasa":      (load_nasa_pcoe, "NASA Ames PCoE Battery Aging (4 cells)"),
}


def main() -> int:
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    chosen = argv if argv else list(DATASETS.keys())
    chosen = [d for d in chosen if d in DATASETS]
    if not chosen:
        print(f"Unknown dataset(s). Available: {list(DATASETS.keys())}")
        return 1

    print("=" * 60)
    print("BESS RUL validation — capacity-fade EOL prediction vs ground truth")
    print("=" * 60)
    print(f"Datasets: {chosen}")

    for name in chosen:
        loader, label = DATASETS[name]
        _validate_dataset(name, loader, label)

    print(f"\n{'=' * 60}\nDone\n{'=' * 60}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
