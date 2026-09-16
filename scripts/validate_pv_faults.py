#!/usr/bin/env python3
"""Validate PV fault detection logic against labeled public datasets.

Loads each requested dataset, runs the cascade-aligned row-level classifier
(``nuravolt/validation/pv_row_classifier.py`` — surrogate for the production
cascade), computes per-class precision/recall/F1 + confusion matrix, and
writes a JSON report under ``backenddata/validation/pv/{dataset}.json``.

Usage:
    python scripts/validate_pv_faults.py                    # all available
    python scripts/validate_pv_faults.py lazzaretti         # single dataset
    python scripts/validate_pv_faults.py lazzaretti gpvs    # subset

Datasets:
    lazzaretti   — UTFPR PV Fault Dataset (CC BY 4.0, 5 classes)
    gpvs         — GPVS-Faults (Mendeley, 5 fault families) [Phase J2]
    sandia_sat   — Sandia tracker faults 2023 (CC0) [Phase J2]
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
from nuravolt.validation.pv_row_classifier import classify_dataframe
from nuravolt.validation.report import write_report


def _run_lazzaretti(sample_n: int | None = None) -> dict:
    """Validate against the Lazzaretti held-out test split."""
    print("\n── Lazzaretti / UTFPR PV Fault Dataset ──")
    t0 = time.time()
    split = load_lazzaretti(split="test", test_fraction=0.20, daylight_only=True, sample_n=sample_n)
    load_t = time.time() - t0
    print(f"  loaded {split.n_rows:,} held-out samples (daylight only) in {load_t:.1f}s")

    t0 = time.time()
    preds = classify_dataframe(split.signals)
    pred_t = time.time() - t0
    print(f"  classified in {pred_t:.1f}s ({split.n_rows / pred_t:,.0f} rows/s)")

    y_true = split.label_names.to_list()
    y_pred = preds.to_list()

    class_order = list(LAZZARETTI_CLASS_NAMES.values())
    report = compute_report(
        y_true=y_true,
        y_pred=y_pred,
        classes=class_order,
        dataset="Lazzaretti (test split, daylight only)",
        extras={
            "split": "test",
            "test_fraction": 0.20,
            "daylight_filter_w_m2": 200.0,
            "classifier": "pv_row_classifier (cascade surrogate)",
            # This said "nuravolt/fault/rule_based.py + rul_models.py", which was
            # not true: pv_row_classifier imports nothing from rule_based and
            # carries its own constants, several openly fitted to this dataset's
            # own percentiles. The artifact was corrected by hand once and this
            # line silently reverted it on the next run, along with the two keys
            # below. Emitting them from the script is what makes the correction
            # survive a re-run.
            "thresholds_source": "nuravolt/validation/pv_row_classifier.py (NOT the shipped detector)",
            "provenance_correction": (
                "This field previously read 'nuravolt/fault/rule_based.py + "
                "rul_models.py'. That was wrong. pv_row_classifier.py imports nothing "
                "from rule_based.py and carries its own constants, several of which are "
                "openly fitted to this dataset's own percentiles -- its comments read "
                "'observed p75 for open class is 0.532' and 'observed p25 for short is "
                "0.246'. So this number measures a surrogate, tuned on the data it is "
                "scored on, and NOT the code that ships."
            ),
            "shipped_detector_scores": (
                "See pv/shipped_detector_lazzaretti.json for the actual "
                "RuleBasedFaultDetector on the same dataset."
            ),
            "superseded_by": (
                "nuravolt/validation/row_classifier.py with thresholds=TUNED_LAZZARETTI "
                "and refs=LAZZARETTI_REFS, which reproduces this artifact row for row."
            ),
            "load_time_s": round(load_t, 1),
            "predict_time_s": round(pred_t, 1),
        },
    )
    payload = report.to_dict()
    out_path = write_report("pv", "lazzaretti_holdout", payload)

    print(f"\n  Macro F1: {report.macro_f1:.3f}   Weighted F1: {report.weighted_f1:.3f}   Accuracy: {report.accuracy:.3f}")
    print(f"\n{format_confusion_matrix_ascii(report)}")
    print(f"\n  → {out_path}")
    return payload


# Datasets registry — Phase J2/J3/J4 will add gpvs, sandia_sat, etc.
DATASETS = {
    "lazzaretti": _run_lazzaretti,
}


def main() -> int:
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    sample_n = None
    for a in sys.argv[1:]:
        if a.startswith("--sample="):
            sample_n = int(a.split("=", 1)[1])

    chosen = argv if argv else list(DATASETS.keys())
    chosen = [d for d in chosen if d in DATASETS]
    if not chosen:
        print(f"Unknown dataset(s). Available: {list(DATASETS.keys())}")
        return 1

    print("=" * 60)
    print("PV fault validation — cascade detection logic vs labeled ground truth")
    print("=" * 60)
    print(f"Datasets: {chosen}")
    if sample_n:
        print(f"Sample: {sample_n:,} rows per dataset (for fast iteration)")

    for name in chosen:
        try:
            DATASETS[name](sample_n=sample_n) if name == "lazzaretti" else DATASETS[name]()
        except FileNotFoundError as e:
            print(f"\n  ✗ {name}: {e}")
        except Exception as e:
            print(f"\n  ✗ {name}: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()

    print(f"\n{'=' * 60}\nDone\n{'=' * 60}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
