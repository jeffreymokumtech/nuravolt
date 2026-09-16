"""Classification metrics for fault-detection validation.

Computes confusion matrix, per-class precision/recall/F1, macro/micro/
weighted F1 — no sklearn dependency, plain numpy + python.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence


@dataclass
class ClassificationReport:
    """Full classification metrics for one dataset / one detector pass."""

    dataset: str
    n_samples: int
    classes: List[str]
    confusion_matrix: List[List[int]]   # rows = true class, cols = predicted
    per_class: Dict[str, Dict[str, float]]  # class -> {precision, recall, f1, support}
    macro_f1: float
    weighted_f1: float
    accuracy: float
    extras: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dataset": self.dataset,
            "n_samples": self.n_samples,
            "classes": self.classes,
            "confusion_matrix": self.confusion_matrix,
            "per_class": self.per_class,
            "macro_f1": round(self.macro_f1, 4),
            "weighted_f1": round(self.weighted_f1, 4),
            "accuracy": round(self.accuracy, 4),
            "extras": self.extras,
        }


def compute_report(
    y_true: Sequence[str],
    y_pred: Sequence[str],
    classes: Sequence[str],
    dataset: str,
    extras: Dict[str, Any] | None = None,
) -> ClassificationReport:
    """Build a ClassificationReport from aligned label sequences.

    Args:
        y_true: ground-truth labels (strings)
        y_pred: predicted labels (strings)
        classes: ordered list of all class names — defines confusion-matrix
            row/col order and ensures classes with zero support still appear
        dataset: dataset name for the report header
        extras: arbitrary metadata to attach (sample counts, thresholds used)

    Returns:
        Filled-in ClassificationReport.
    """
    y_true = list(y_true)
    y_pred = list(y_pred)
    classes = list(classes)
    assert len(y_true) == len(y_pred), "y_true and y_pred must align"
    n = len(y_true)

    # Confusion matrix
    idx = {c: i for i, c in enumerate(classes)}
    cm = [[0] * len(classes) for _ in classes]
    dropped_true: Dict[str, int] = {}
    dropped_pred: Dict[str, int] = {}
    for t, p in zip(y_true, y_pred):
        ti, pi = idx.get(t), idx.get(p)
        if ti is None or pi is None:
            # Out-of-taxonomy rows are skipped rather than crashing, but they are
            # COUNTED. Silently dropping them while still dividing accuracy by the
            # full n understates accuracy by an unstated amount, and a taxonomy
            # mismatch -- the exact defect that made a cross-dataset comparison
            # look like a transfer measurement -- then leaves no trace at all.
            if ti is None:
                dropped_true[t] = dropped_true.get(t, 0) + 1
            if pi is None:
                dropped_pred[p] = dropped_pred.get(p, 0) + 1
            continue
        cm[ti][pi] += 1

    n_scored = sum(sum(row) for row in cm)

    # Per-class P / R / F1
    per_class: Dict[str, Dict[str, float]] = {}
    for i, c in enumerate(classes):
        tp = cm[i][i]
        fp = sum(cm[j][i] for j in range(len(classes)) if j != i)
        fn = sum(cm[i][j] for j in range(len(classes)) if j != i)
        support = tp + fn
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        per_class[c] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": support,
        }

    # Aggregate F1s
    f1s = [per_class[c]["f1"] for c in classes]
    macro_f1 = sum(f1s) / len(f1s) if f1s else 0.0
    total_support = sum(per_class[c]["support"] for c in classes)
    weighted_f1 = (
        sum(per_class[c]["f1"] * per_class[c]["support"] for c in classes) / total_support
        if total_support > 0
        else 0.0
    )

    # Accuracy
    correct = sum(cm[i][i] for i in range(len(classes)))
    # Denominator stays the rows HANDED IN, not the rows scored. Two reasons:
    # changing it would silently move every published accuracy figure, and
    # counting an out-of-taxonomy row as wrong is the conservative reading -- the
    # classifier did not get it right. The discrepancy is reported in extras
    # instead of being resolved quietly in either direction.
    accuracy = correct / n if n > 0 else 0.0

    return ClassificationReport(
        dataset=dataset,
        n_samples=n,
        classes=classes,
        confusion_matrix=cm,
        per_class=per_class,
        macro_f1=macro_f1,
        weighted_f1=weighted_f1,
        accuracy=accuracy,
        extras={
            **(extras or {}),
            # Present only when rows were actually dropped, so the common case is
            # unchanged and a taxonomy mismatch is impossible to miss.
            **({
                "rows_outside_taxonomy": {
                    "n_handed_in": n,
                    "n_scored": n_scored,
                    "unrecognised_true_labels": dropped_true,
                    "unrecognised_predicted_labels": dropped_pred,
                    "note": (
                        "These rows were excluded from the confusion matrix but are "
                        "still in the accuracy denominator, so they count as wrong. A "
                        "non-empty entry here means the "
                        "label vocabulary of the data and of the classifier disagree, "
                        "and any macro average below is over the classifier's "
                        "vocabulary, not the data's."
                    ),
                }
            } if n_scored != n else {}),
        },
    )


def format_confusion_matrix_ascii(report: ClassificationReport) -> str:
    """Pretty-print confusion matrix for CLI output."""
    classes = report.classes
    cm = report.confusion_matrix
    cell_w = max(8, max(len(c) for c in classes) + 1)
    rows = []
    # Header
    rows.append(" " * (cell_w + 4) + "PREDICTED")
    rows.append(
        " " * (cell_w + 2) + " ".join(f"{c[:cell_w-1]:>{cell_w}}" for c in classes)
    )
    rows.append("TRUE" + " " * cell_w + "-" * (len(classes) * (cell_w + 1)))
    for i, c in enumerate(classes):
        cells = " ".join(f"{cm[i][j]:>{cell_w}}" for j in range(len(classes)))
        rows.append(f"{c[:cell_w-1]:>{cell_w + 2}}  {cells}")
    return "\n".join(rows)
