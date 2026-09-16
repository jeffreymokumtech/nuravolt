#!/usr/bin/env python3
"""Blind cross-distribution validation of the physics-only rule classifier.

Uses ``nuravolt/validation/pv_row_classifier_physics.py`` which has thresholds
derived ONLY from production config.py defaults (never tuned to any dataset's
distribution).

Tests on:
- Lazzaretti (per-string shape) → first honest F1 number for our production
  physics rules on Lazzaretti
- GPVS (Lazzaretti-impossible — different feature shape — skipped here)

The Lazzaretti score here is the honest "what does our production rule
cascade actually score, with zero distribution leakage?" number. Compare
to the tuned-surrogate 0.835 to see how much of that was tuning.

Usage:
    python scripts/validate_pv_physics_blind.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nuravolt.validation.adapters.lazzaretti import (
    LAZZARETTI_CLASS_NAMES,
    load_lazzaretti,
)
from nuravolt.validation.metrics.classification import (
    compute_report,
    format_confusion_matrix_ascii,
)
from nuravolt.validation.pv_row_classifier_physics import classify_dataframe
from nuravolt.validation.report import write_report


def main() -> int:
    print("=" * 60)
    print(" PV physics-only rule classifier — blind cross-distribution test")
    print("=" * 60)
    print(" Thresholds: ONLY from nuravolt/fault/config.py defaults (never dataset-tuned)")

    print("\n── Lazzaretti (held-out 20%, daylight only) ──")
    t0 = time.time()
    split = load_lazzaretti(split="test", test_fraction=0.20, daylight_only=True)
    load_t = time.time() - t0
    print(f"  loaded {split.n_rows:,} samples in {load_t:.1f}s")

    t0 = time.time()
    preds = classify_dataframe(split.signals)
    pred_t = time.time() - t0
    print(f"  classified in {pred_t:.1f}s")

    y_true = split.label_names.to_list()
    y_pred = preds.to_list()

    class_order = list(LAZZARETTI_CLASS_NAMES.values())
    report = compute_report(
        y_true=y_true,
        y_pred=y_pred,
        classes=class_order,
        dataset="Lazzaretti (physics-only blind baseline)",
        extras={
            "classifier": "pv_row_classifier_physics (config.py defaults only)",
            "thresholds_source": "nuravolt/fault/config.py — production manufacturer/physics defaults, NEVER tuned to any dataset",
            "comparison_baseline": (
                "vs pv_row_classifier.py (tuned surrogate) which scored 0.835 macro-F1. "
                "The gap between this score and 0.835 represents the tuning headroom — "
                "i.e. what we gained from looking at Lazzaretti's per-class percentile statistics."
            ),
        },
    )
    payload = report.to_dict()
    out_path = write_report("pv", "lazzaretti_physics_blind", payload)

    print(f"\n  Macro F1: {report.macro_f1:.3f}   Weighted F1: {report.weighted_f1:.3f}   Accuracy: {report.accuracy:.3f}")
    print(f"\n{format_confusion_matrix_ascii(report)}")
    print(f"\n  → {out_path}")

    print("\n  Per-class breakdown:")
    for cls, m in report.per_class.items():
        print(f"    {cls:>20}: P={m['precision']:.3f}  R={m['recall']:.3f}  F1={m['f1']:.3f}  (n={m['support']})")

    print(f"\n  vs tuned surrogate (0.835 macro-F1): delta = {report.macro_f1 - 0.835:+.3f}")
    print(f"  This delta is the 'tuning headroom' — what we get by looking at the dataset's stats.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
