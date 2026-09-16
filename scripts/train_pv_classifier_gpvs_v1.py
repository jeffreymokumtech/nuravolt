#!/usr/bin/env python3
"""Train the PV-classifier GPVS-shape companion model.

Phase N-2. `pv_classifier_v1` only handles Lazzaretti's per-string feature
shape. Many real client systems report system-level 3-phase AC + DC bus
(GPVS shape). This trains a second LightGBM on GPVS features so the
router can dispatch by data shape.

Inputs: GPVS-Faults CSVs already on disk + engineered features from
`gpvs_csv.py:_engineer_features` (ac_current_imbalance, ac_voltage_imbalance,
dc_ratio, pv_power + raw Ipv/Vpv/Vdc).

Output:
  - models/foundation/pv_classifier_gpvs_v1.pkl  (LGBMClassifier)
  - models/foundation/pv_classifier_gpvs_v1.meta.json

Validation: 80/20 stratified split, class_weight='balanced' for the
temporal-event imbalance (most rows in any fault file are "normal" by
appearance — fault occurs only in some moments of the 100kHz stream).

Usage:
    python scripts/train_pv_classifier_gpvs_v1.py
"""

from __future__ import annotations

import json
import pickle
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import numpy as np
from lightgbm import LGBMClassifier
from sklearn.model_selection import train_test_split

from nuravolt.validation.adapters.gpvs_csv import GPVS_CLASS_TO_FAULT, load_gpvs
from nuravolt.validation.metrics.classification import compute_report

OUT_DIR = REPO_ROOT / "models" / "foundation"
OUT_DIR.mkdir(parents=True, exist_ok=True)
MODEL_VERSION = "v1"
MODEL_PKL = OUT_DIR / f"pv_classifier_gpvs_{MODEL_VERSION}.pkl"
MODEL_META = OUT_DIR / f"pv_classifier_gpvs_{MODEL_VERSION}.meta.json"

FEATURES = [
    "Ipv", "Vpv", "Vdc",
    "ac_current_imbalance", "ac_voltage_imbalance",
    "dc_ratio", "pv_power",
]


def main() -> int:
    print("=" * 60)
    print(f" PV classifier GPVS-shape {MODEL_VERSION} — training")
    print("=" * 60)

    # Use a larger sample for proper training — 20K per file × 16 files = 320K rows
    split = load_gpvs(sample_n_per_class=20000)
    print(f"\n  loaded {split.n_rows:,} rows total")

    X = split.signals.select(FEATURES).to_numpy()
    y = np.array(split.labels.to_list())   # class labels F0-F7

    # GPVS-class → integer encoding (F0=0, F1=1, ..., F7=7)
    label_to_int = {f"F{i}": i for i in range(8)}
    y_int = np.array([label_to_int[str(c)] for c in y])

    X_train, X_test, y_train, y_test, y_train_str, y_test_str = train_test_split(
        X, y_int, y, test_size=0.20, random_state=42, stratify=y_int,
    )
    print(f"  train: {len(X_train):,} | test: {len(X_test):,}")

    print("\n  training LGBMClassifier (class_weight='balanced')...")
    t0 = time.time()
    clf = LGBMClassifier(
        n_estimators=200,
        max_depth=8,
        learning_rate=0.05,
        class_weight="balanced",
        random_state=42,
        verbose=-1,
        n_jobs=-1,
    )
    clf.fit(X_train, y_train)
    train_t = time.time() - t0
    print(f"  trained in {train_t:.1f}s")

    preds_int = clf.predict(X_test)
    preds_class = [f"F{int(i)}" for i in preds_int]
    preds_fault = [GPVS_CLASS_TO_FAULT.get(c, "unknown") for c in preds_class]
    y_test_fault = [GPVS_CLASS_TO_FAULT.get(str(c), "unknown") for c in y_test_str]
    class_order = sorted(set(y_test_fault) | set(preds_fault))

    report = compute_report(
        y_true=y_test_fault,
        y_pred=preds_fault,
        classes=class_order,
        dataset="GPVS held-out (LightGBM in-domain)",
        extras={
            "model": "LGBMClassifier(200,8,balanced)",
            "features": FEATURES,
            "train_rows": len(X_train),
            "test_rows": len(X_test),
            "train_time_s": round(train_t, 1),
            "note": (
                "In-domain test on GPVS. Cross-test against Lazzaretti is in "
                "scripts/validate_pv_lgbm_cross.py — expected to fail because "
                "Lazzaretti's fault families differ (per-string vs system-level)."
            ),
        },
    )
    print(f"\n  Macro F1: {report.macro_f1:.3f}  Weighted F1: {report.weighted_f1:.3f}  Accuracy: {report.accuracy:.3f}")
    for cls, m in report.per_class.items():
        print(f"    {cls:>30}: P={m['precision']:.3f} R={m['recall']:.3f} F1={m['f1']:.3f} (n={m['support']})")

    with open(MODEL_PKL, "wb") as f:
        pickle.dump(clf, f)
    fi = sorted(zip(FEATURES, [int(i) for i in clf.feature_importances_]), key=lambda x: -x[1])
    meta = {
        "version": MODEL_VERSION,
        "model_type": "LGBMClassifier",
        "feature_shape": "gpvs_system_level_3phase",
        "n_estimators": 200,
        "max_depth": 8,
        "trained_on": "GPVS-Faults — 8 fault classes × 2 modes (MPPT + IPPT), 320K rows",
        "feature_names": FEATURES,
        "class_names": [GPVS_CLASS_TO_FAULT[f"F{i}"] for i in range(8)],
        "gpvs_class_to_fault": GPVS_CLASS_TO_FAULT,
        "feature_importance": [{"feature": f, "importance": i} for f, i in fi],
        "test_metrics": {
            "macro_f1": report.macro_f1,
            "weighted_f1": report.weighted_f1,
            "accuracy": report.accuracy,
            "per_class": report.per_class,
        },
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "notes": [
            "Companion to pv_classifier_v1 (per-string Lazzaretti shape). "
            "Use pv_router.py to dispatch by which feature columns are "
            "present in the client's data.",
            "Fault families differ from Lazzaretti — cross-dataset transfer "
            "is intentionally not expected.",
        ],
    }
    MODEL_META.write_text(json.dumps(meta, indent=2))

    print(f"\n  wrote model:    {MODEL_PKL}  ({MODEL_PKL.stat().st_size:,} bytes)")
    print(f"  wrote metadata: {MODEL_META}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
