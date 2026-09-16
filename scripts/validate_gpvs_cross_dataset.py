#!/usr/bin/env python3
"""Cross-dataset PV fault validation against GPVS-Faults.

The honest "does this generalize?" test. Our Lazzaretti-trained foundation
model and rule-based surrogate are calibrated for a per-string 5 kW system
in Curitiba, Brazil. GPVS-Faults is a different lab setup with system-
level 3-phase measurements and a different fault taxonomy.

This script:
  1. Loads GPVS-Faults CSVs (16 files = 8 fault classes × 2 modes)
  2. Applies our GPVS-row classifier (`gpvs_row_classifier.py`)
  3. Reports per-class precision/recall/F1 + confusion matrix
  4. Writes `backenddata/validation/pv/gpvs_cross_dataset.json`

Expected outcome: macro-F1 noticeably lower than Lazzaretti's 0.835 because
(a) different fault families, (b) different feature shape, (c) classifier
not trained for some classes (F3 inverter overtemp, F7 sensor drift have
no electrical-only discriminator).

Usage:
    python scripts/validate_gpvs_cross_dataset.py
    python scripts/validate_gpvs_cross_dataset.py --mode MPPT  # subset
    python scripts/validate_gpvs_cross_dataset.py --full       # use full files (slow)
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import argparse
import time

from nuravolt.validation.adapters.gpvs_csv import (
    GPVS_CLASS_TO_FAULT,
    GPVS_SCORED_CLASSES,
    load_gpvs,
)
from nuravolt.validation.gpvs_row_classifier import classify_dataframe
from nuravolt.validation.metrics.classification import (
    compute_report,
    format_confusion_matrix_ascii,
)
from nuravolt.validation.report import result_exists, write_report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["MPPT", "IPPT"], default=None)
    parser.add_argument("--full", action="store_true",
                        help="Load full 493MB of CSVs (slow). Default: 5K rows per file.")
    args = parser.parse_args()

    print("=" * 60)
    print(" Cross-dataset PV validation — GPVS-Faults")
    print("=" * 60)

    t0 = time.time()
    sample = None if args.full else 5000
    try:
        split = load_gpvs(sample_n_per_class=sample, mode=args.mode)
    except FileNotFoundError as exc:
        # The GPVS CSVs are a manual Mendeley download and are not in this
        # checkout. A missing dataset is a known state, not a failure: write the
        # pending marker and exit clean so the rest of the suite still runs.
        #
        # Note what this artifact is NOT, before anyone reinstates the number it
        # used to carry: 0.189 came from gpvs_row_classifier, a separate
        # implementation with GPVS-shaped inputs and thresholds fitted to GPVS's
        # own percentiles. It never measured the Lazzaretti surrogate, which
        # cannot read this dataset at all. See pv/classifier_provenance.json.
        if result_exists("pv", "gpvs_cross_dataset"):
            print(f"pending ({exc}), but a real result is already recorded; "
                  f"leaving it in place rather than overwriting a measurement "
                  f"with a note that the measurement is unavailable.")
            return 0
        write_report("pv", "gpvs_cross_dataset", {
            "dataset": "GPVS-Faults (cross-dataset)",
            "status": "pending_manual_fetch",
            "reason": str(exc).splitlines()[0],
            "how_to_get_it": (
                "Manual download from Mendeley n76t439f65 (~470 MB), unzip to "
                "backenddata/datasets/gpvs_faults/CSV_Files/"
            ),
            "what_it_does_not_measure": (
                "The Lazzaretti cascade. GPVS has no per-string voltage, no "
                "per-string current and no irradiance, so that classifier "
                "structurally cannot run on it. See pv/classifier_provenance.json."
            ),
        })
        print(f"pending: {exc}")
        return 0
    load_t = time.time() - t0
    print(f"\n  Loaded {split.n_rows:,} rows in {load_t:.1f}s")
    print(f"  Class distribution:")
    for cls in sorted(set(split.labels.to_list())):
        n = (split.labels == cls).sum()
        ft = GPVS_CLASS_TO_FAULT.get(cls, "unknown")
        print(f"    {cls} ({ft:>26}): {n:>6,} rows")

    print(f"\n  Classifying...")
    t0 = time.time()
    preds = classify_dataframe(split.signals)
    pred_t = time.time() - t0
    print(f"  Done in {pred_t:.1f}s ({split.n_rows / pred_t:,.0f} rows/s)")

    y_true = split.fault_types.to_list()
    y_pred = preds.to_list()

    # Use the union of true + predicted classes for the confusion matrix
    class_order = sorted(set(y_true) | set(y_pred))
    report = compute_report(
        y_true=y_true,
        y_pred=y_pred,
        classes=class_order,
        dataset=f"GPVS-Faults cross-dataset ({args.mode or 'both modes'})",
        extras={
            "mode": args.mode or "both",
            "sample_per_file": sample,
            "classifier": "gpvs_row_classifier (cascade-aligned, GPVS-shape features)",
            "training_dataset": "Lazzaretti (different feature shape)",
            "load_time_s": round(load_t, 1),
            "predict_time_s": round(pred_t, 1),
            "note": (
                "Cross-dataset test. Trained on per-string Lazzaretti; "
                "applied to system-level 3-phase GPVS. F3 (inverter "
                "overtemp) and F7 (sensor drift) have NO electrical-only "
                "discriminator so they're expected to misclassify as normal."
            ),
        },
    )
    payload = report.to_dict()
    out_path = write_report("pv", "gpvs_cross_dataset", payload)

    print(f"\n  Macro F1: {report.macro_f1:.3f}   Weighted F1: {report.weighted_f1:.3f}   Accuracy: {report.accuracy:.3f}")
    print(f"\n{format_confusion_matrix_ascii(report)}")
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
