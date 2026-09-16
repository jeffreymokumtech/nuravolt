#!/usr/bin/env python3
"""Does the fault cascade survive a rig of a different size?

WHY A PERTURBATION TEST AND NOT A SECOND DATASET
------------------------------------------------
The obvious experiment -- run the classifier on another labelled plant -- cannot
be done today. The published "cross-architecture" number came from a different
classifier on GPVS, which has no per-string channels and no irradiance at all, so
this cascade structurally cannot read it; and GPVS is no longer on disk. See
``pv/classifier_provenance.json``.

What CAN be isolated exactly is the thing normalisation is supposed to fix. A rig
differs from Lazzaretti's first of all in how it is BUILT: modules in series set
the voltage scale, strings in parallel set the current scale. Scaling Lazzaretti's
voltage and current channels reproduces that difference while holding the physics,
the labels and the fault signatures fixed. Any change in score is then attributable
to scale alone, with nothing else moving.

k_v = 0.75 is a 6-module string where Lazzaretti has 8; k_v = 1.5 is 12. k_i = 2 is
two strings paralleled into one input instead of one.

WHAT THIS DOES NOT SHOW
-----------------------
That the classifier will transfer. Real rigs also differ in fill factor, series
resistance, temperature coefficient and sensor placement, and none of those is a
scale factor. Invariance here is **necessary but not sufficient**. It proves a
specific defect is gone, not that the detector is portable.

Usage:
    python scripts/validate_scale_transfer.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.adapters.lazzaretti import load_lazzaretti  # noqa: E402
from nuravolt.validation.metrics.classification import compute_report  # noqa: E402
from nuravolt.validation.report import write_report  # noqa: E402
from nuravolt.validation.row_classifier import (  # noqa: E402
    CLASS_NAMES,
    LAZZARETTI_REFS,
    TUNED_LAZZARETTI,
    ScaleRefs,
    classify,
    parameter_record,
)

#: (k_v, k_i, what a real rig with this geometry would be)
GRID = [
    (1.00, 1.0, "Lazzaretti as built"),
    (0.75, 1.0, "6 modules in series instead of 8"),
    (0.50, 1.0, "4 modules in series"),
    (1.50, 1.0, "12 modules in series"),
    (2.00, 1.0, "16 modules in series"),
    (1.00, 2.0, "two strings paralleled per input"),
    (1.00, 0.5, "half the string current"),
    (0.75, 2.0, "6 modules, two strings paralleled"),
]


def main() -> int:
    split = load_lazzaretti(split="test", test_fraction=0.20, daylight_only=True)
    sig, truth = split.signals, split.label_names.to_list()
    v_cols = [c for c in sig.columns if c.startswith("string_voltage_")]
    i_cols = [c for c in sig.columns if c.startswith("string_current_")]

    def score(frame, refs):
        preds = classify(frame, TUNED_LAZZARETTI, refs).to_list()
        rep = compute_report(truth, preds, list(CLASS_NAMES), "scale_transfer").to_dict()
        return rep

    rows = []
    for k_v, k_i, meaning in GRID:
        frame = sig.with_columns(
            [pl.col(c) * k_v for c in v_cols] + [pl.col(c) * k_i for c in i_cols]
        )
        fixed = score(frame, LAZZARETTI_REFS)
        auto_refs = ScaleRefs.from_data(frame, voltage_cols=v_cols, current_cols=i_cols)
        adapted = score(frame, auto_refs)
        rows.append({
            "k_v": k_v, "k_i": k_i, "geometry": meaning,
            "fixed_refs": {"macro_f1": fixed["macro_f1"],
                           "per_class": {k: v for k, v in fixed["per_class"].items()}},
            "self_normalised_refs": {"macro_f1": adapted["macro_f1"],
                                     "scale_refs": auto_refs.to_dict(),
                                     "per_class": {k: v for k, v in adapted["per_class"].items()}},
        })

    base_fixed = rows[0]["fixed_refs"]["macro_f1"]
    base_norm = rows[0]["self_normalised_refs"]["macro_f1"]
    worst_fixed = min(r["fixed_refs"]["macro_f1"] for r in rows)
    norm_spread = (max(r["self_normalised_refs"]["macro_f1"] for r in rows)
                   - min(r["self_normalised_refs"]["macro_f1"] for r in rows))
    dead = sorted({
        cls for r in rows for cls, m in r["fixed_refs"]["per_class"].items()
        if m["f1"] == 0.0 and m["support"] > 0
    })

    payload = {
        "dataset": "Lazzaretti under rig-geometry perturbation",
        "n_samples": len(sig),
        "classes": list(CLASS_NAMES),
        "parameters": parameter_record(TUNED_LAZZARETTI, LAZZARETTI_REFS),
        "grid": rows,
        "headline_macro_f1_unnormalised_worst": worst_fixed,
        "headline_macro_f1_normalised_spread": round(norm_spread, 6),
        "baseline_unperturbed": {"fixed_refs": base_fixed, "self_normalised": base_norm},
        "cost_of_unsupervised_calibration": round(base_fixed - base_norm, 4),
        "classes_that_die_under_perturbation": dead,
        "method": (
            "Lazzaretti's voltage channels scaled by k_v and current channels by k_i, "
            "reproducing a rig with a different number of modules in series and strings "
            "in parallel. Irradiance is NOT scaled: it is the same sun. Labels are "
            "untouched, so per-fault precision, recall and F1 remain computable and any "
            "change is attributable to scale alone."
        ),
        "what_this_does_not_show": (
            "That the classifier transfers. Real rigs also differ in fill factor, series "
            "resistance, temperature coefficient and sensor placement, none of which is a "
            "scale factor. Invariance here is necessary, not sufficient."
        ),
        "interpretation": (
            f"With the scale references fixed -- which is what ships today -- macro-F1 "
            f"falls from {base_fixed:.4f} to {worst_fixed:.4f}, and {len(dead)} classes "
            f"reach F1 exactly 0.000 on a rig that differs only in size. With references "
            f"estimated from the target record itself, using no labels, the score is "
            f"invariant to within {norm_spread:.6f} across the whole grid. The price of "
            f"estimating the reference rather than being told it is "
            f"{base_fixed - base_norm:.4f} macro-F1."
        ),
    }
    write_report("pv", "scale_transfer_lazzaretti", payload)

    print(f"{'k_v':>5}{'k_i':>5}  {'geometry':<38}{'fixed':>8}{'normalised':>12}")
    for r in rows:
        print(f"{r['k_v']:>5}{r['k_i']:>5}  {r['geometry']:<38}"
              f"{r['fixed_refs']['macro_f1']:>8.4f}"
              f"{r['self_normalised_refs']['macro_f1']:>12.4f}")
    print(f"\nunnormalised worst: {worst_fixed:.4f}   normalised spread: {norm_spread:.6f}")
    print(f"classes reaching F1 0.000 under perturbation: {dead or 'none'}")
    print(f"cost of unsupervised calibration: {base_fixed - base_norm:.4f} macro-F1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
