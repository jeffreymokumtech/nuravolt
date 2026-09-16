#!/usr/bin/env python3
"""LightGBM benchmark for PV fault classification on Lazzaretti.

This is the *upper-bound* benchmark: what's achievable on this dataset
with a state-of-the-art tabular ML model, NOT a validation of our
production rules. Run alongside ``validate_pv_faults.py`` to compare:

    rule-based surrogate (mirrors our production thresholds): macro-F1 0.835
    LightGBM upper bound (this script):                       macro-F1 ~0.95+

The gap shows how much headroom the production rule-based detector
trades for interpretability + zero-training-data deployment.

Pipeline:
    1. Load Lazzaretti, daylight-filter, 80/20 deterministic split.
    2. Engineer derived features (i_imbalance, v_imbalance, current_ratio,
       voltage spreads) — same features used by the row classifier.
    3. Train LGBMClassifier with class_weight='balanced' on train split.
    4. Predict + score on test split. Confusion matrix, per-class F1.

Usage:
    python scripts/validate_pv_lgbm.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import numpy as np
import polars as pl
from lightgbm import LGBMClassifier

from nuravolt.validation.adapters.lazzaretti import (
    LAZZARETTI_CLASS_NAMES,
    load_lazzaretti,
)
from nuravolt.validation.metrics.classification import (
    compute_report,
    format_confusion_matrix_ascii,
)
from nuravolt.validation.report import write_report


def _engineer(df: pl.DataFrame) -> pl.DataFrame:
    """Add the same derived features used by the rule-based classifier."""
    return df.with_columns([
        ((pl.col("string_current_1") + pl.col("string_current_2")) / 2).alias("i_mean"),
        ((pl.col("string_current_1") - pl.col("string_current_2")).abs() /
            ((pl.col("string_current_1") + pl.col("string_current_2")) / 2 + 1e-6)).alias("i_imbalance"),
        ((pl.col("string_voltage_1") - pl.col("string_voltage_2")).abs() /
            ((pl.col("string_voltage_1") + pl.col("string_voltage_2")) / 2 + 1e-6)).alias("v_imbalance"),
        ((pl.col("string_voltage_1").clip(0) + pl.col("string_voltage_2").clip(0)) / 2).alias("v_mean"),
        (((pl.col("string_current_1") + pl.col("string_current_2")) / 2) /
            (pl.col("poa_irradiance") * 0.009 + 1e-6)).alias("current_ratio"),
    ])


def main() -> int:
    print("=" * 60)
    print("PV LightGBM benchmark — upper bound on Lazzaretti")
    print("=" * 60)

    print("\n  loading + splitting...")
    train_split = load_lazzaretti(split="train", test_fraction=0.20, daylight_only=True)
    test_split = load_lazzaretti(split="test", test_fraction=0.20, daylight_only=True)
    print(f"  train: {train_split.n_rows:,} rows | test: {test_split.n_rows:,} rows")

    X_train = _engineer(train_split.signals)
    X_test = _engineer(test_split.signals)
    y_train = train_split.labels.to_numpy()
    y_test = test_split.label_names.to_list()

    print("\n  training LGBMClassifier...")
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
    clf.fit(X_train.to_pandas(), y_train)
    train_t = time.time() - t0
    print(f"  trained in {train_t:.1f}s")

    print("\n  predicting...")
    t0 = time.time()
    preds_int = clf.predict(X_test.to_pandas())
    pred_t = time.time() - t0
    preds = [LAZZARETTI_CLASS_NAMES[int(p)] for p in preds_int]
    print(f"  predicted in {pred_t:.1f}s ({len(preds) / pred_t:,.0f} rows/s)")

    class_order = list(LAZZARETTI_CLASS_NAMES.values())
    report = compute_report(
        y_true=y_test,
        y_pred=preds,
        classes=class_order,
        dataset="Lazzaretti (test split, daylight only) — LGBM",
        extras={
            "model": "LightGBM (200 trees, depth 8, balanced weights)",
            "features": list(X_train.columns),
            "split": "test (last 20%)",
            "train_time_s": round(train_t, 1),
            "predict_time_s": round(pred_t, 1),
            "note": ("Upper-bound benchmark — Lazzaretti was the source for "
                     "our production rule training intuition, so this gives "
                     "the achievable ceiling with SOTA tabular ML. Compare to "
                     "lazzaretti_holdout.json (rule-based macro-F1) for the "
                     "interpretability vs accuracy trade-off."),
        },
    )
    payload = report.to_dict()

    # Feature importances
    feature_importance = sorted(
        zip(X_train.columns, clf.feature_importances_),
        key=lambda x: -x[1],
    )
    payload["feature_importance"] = [
        {"feature": f, "importance": int(i)} for f, i in feature_importance
    ]

    out_path = write_report("pv", "lazzaretti_lgbm", payload)
    print(f"\n  Macro F1: {report.macro_f1:.3f}   Weighted F1: {report.weighted_f1:.3f}   Accuracy: {report.accuracy:.3f}")
    print(f"\n{format_confusion_matrix_ascii(report)}")
    print(f"\n  Feature importance:")
    for f, i in feature_importance:
        print(f"    {f:<22s} {i}")
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
