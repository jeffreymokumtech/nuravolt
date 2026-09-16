#!/usr/bin/env python3
"""Score the SHIPPED rule detector on labelled public data.

WHY THIS DID NOT ALREADY EXIST
------------------------------
The published macro-F1 of 0.835 does not measure the code that ships. It measures
``nuravolt/validation/pv_row_classifier.py``, a separate implementation that
imports nothing from ``nuravolt/fault/rule_based.py`` and carries its own
thresholds. Those thresholds are openly fitted to the dataset they are then scored
on -- the source comments read "observed p75 for open class is 0.532",
"observed p25 for short is 0.246". Meanwhile the artifact records
``"thresholds_source": "nuravolt/fault/rule_based.py + rul_models.py"``, which is
not true.

So changes to the shipped detector -- including the ones that cut its alert volume
on real plants by 77% -- move the published F1 by exactly nothing, because that
number was never measuring them.

This script closes the gap: it runs ``RuleBasedFaultDetector`` itself.

WHAT IT CAN AND CANNOT MEASURE
------------------------------
Two honest limits, both stated in the emitted artifact.

Lazzaretti has **no time axis** -- no timestamp, no sequence, no system id, just
independent labelled snapshots. The detector is built for time series with event
grouping and dwell windows, so a synthetic timestamp is supplied and the row order
is taken as given. Rules that depend on persistence are therefore evaluated on an
ordering that carries no real meaning.

The shipped rule set addresses **2 of the 5 Lazzaretti classes**. There is a rule
for string open circuit and one for string short circuit; there is none that emits
for degradation, and partial shading is only detectable through a
morning-versus-afternoon asymmetry that needs a real clock. Macro-F1 across all
five classes is therefore capped near 0.4 by coverage alone, and reporting it
without that context would be misleading in the other direction.

Usage:
    python scripts/validate_shipped_detector.py
    python scripts/validate_shipped_detector.py --tag before_fixes
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path
from typing import Dict

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.fault.config import FaultDetectionConfig  # noqa: E402
from nuravolt.fault.rule_based import FaultType, RuleBasedFaultDetector  # noqa: E402
from nuravolt.validation.metrics.classification import compute_report  # noqa: E402
from nuravolt.validation.report import write_report  # noqa: E402

DATA = Path("backenddata/datasets/lazzaretti/lazzaretti_faults.parquet")

CLASS_NAMES = {0: "normal", 1: "short_circuit", 2: "degradation",
               3: "open_circuit", 4: "partial_shading"}

#: Which shipped FaultType corresponds to which labelled class.
FAULT_TO_CLASS = {
    FaultType.STRING_SHORT_CIRCUIT: 1,
    FaultType.STRING_OPEN_CIRCUIT: 3,
    FaultType.MODULE_CURRENT_DEGRADATION: 2,
    FaultType.VEGETATION_SHADING: 4,
}

#: Classes no shipped rule can emit for. Stated rather than silently scored as 0.
UNADDRESSED = {2: "no rule emits MODULE_CURRENT_DEGRADATION",
               4: "partial shading needs a real clock for AM/PM asymmetry"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tag", default="")
    ap.add_argument("--max-rows", type=int, default=200_000)
    ap.add_argument("--event-gap-minutes", type=int, default=60,
                    help="event grouping gap; keep short here so the score "
                         "measures detection rather than alert bundling")
    ap.add_argument("--dwell-intervals", type=int, default=None,
                    help="override every persistence window. Lazzaretti has no "
                         "time axis, so a dwell requirement cannot be satisfied "
                         "on it by construction; pass 1 to isolate that effect.")
    args = ap.parse_args()

    if not DATA.exists():
        write_report("pv", "shipped_detector_lazzaretti", {
            "dataset": "Shipped rule detector on Lazzaretti",
            "status": "pending_manual_fetch",
            "reason": f"{DATA} not present"})
        print(f"missing {DATA}")
        return 0

    df = pl.read_parquet(DATA)
    if len(df) > args.max_rows:
        df = df.sample(n=args.max_rows, seed=0, shuffle=False)
    y_true = df["fault_class"].to_list()

    # Synthetic 5-minute clock. The dataset has no time axis; see the docstring.
    t0 = dt.datetime(2024, 6, 1, 6, 0)
    work = df.with_columns(
        pl.Series("timestamp", [t0 + dt.timedelta(minutes=5 * i) for i in range(len(df))])
    )

    cfg = FaultDetectionConfig.for_eu_plant()
    # Measure DETECTION, not alert bundling. Chronic grouping is an alerting
    # policy: with the production seven-day gap, two events span nearly the whole
    # synthetic clock and every row inside them is marked a fault, which crushes
    # precision without a single per-interval decision having changed. A short gap
    # makes the score reflect the decisions.
    cfg.mppt.chronic_event_gap_minutes = args.event_gap_minutes

    if args.dwell_intervals is not None:
        # Persistence is the single biggest contributor to the alert-volume cut on
        # real plants, and this dataset cannot express it: the rows are unordered
        # independent snapshots with a synthetic clock bolted on. Scoring with and
        # without it separates "the detector got worse" from "the benchmark cannot
        # represent what the detector requires".
        cfg.string.open_circuit_dwell_intervals = args.dwell_intervals
        cfg.mppt.mismatch_dwell_intervals = args.dwell_intervals
        cfg.module_health.bypass_diode_dwell_intervals = args.dwell_intervals
    detector = RuleBasedFaultDetector(cfg)
    result = detector.detect_all(work)

    # Map each alert back to the rows it covers.
    idx_of = {t: i for i, t in enumerate(work["timestamp"].to_list())}
    y_pred = np.zeros(len(df), dtype=int)
    emitted: Dict[str, int] = {}
    for a in result.alerts:
        cls = FAULT_TO_CLASS.get(a.fault_type)
        emitted[a.fault_type.value] = emitted.get(a.fault_type.value, 0) + 1
        if cls is None:
            continue
        s = idx_of.get(a.timestamp_start)
        e = idx_of.get(a.timestamp_end, s)
        if s is None:
            continue
        y_pred[s:(e or s) + 1] = cls

    names = [CLASS_NAMES[i] for i in range(5)]
    rep = compute_report(
        y_true=[CLASS_NAMES[c] for c in y_true],
        y_pred=[CLASS_NAMES[c] for c in y_pred.tolist()],
        classes=names,
        dataset="Lazzaretti (shipped RuleBasedFaultDetector)",
    )
    payload = rep.to_dict()
    addressable = [c for c in range(5) if c not in UNADDRESSED]
    per = payload.get("per_class", {})
    f1s = [per.get(CLASS_NAMES[c], {}).get("f1", 0.0) for c in addressable]
    payload["macro_f1_addressable_classes_only"] = round(float(np.mean(f1s)), 4)
    payload["addressable_classes"] = [CLASS_NAMES[c] for c in addressable]
    payload["unaddressed_classes"] = {CLASS_NAMES[c]: r for c, r in UNADDRESSED.items()}
    payload["alerts_emitted_by_type"] = emitted
    payload["measures"] = "nuravolt/fault/rule_based.py::RuleBasedFaultDetector, the shipped code"
    payload["event_gap_minutes"] = args.event_gap_minutes
    payload["dwell_intervals_override"] = args.dwell_intervals
    payload["grouping_note"] = (
        "Scored with a short event gap so the result reflects per-interval "
        "decisions. Production uses a seven-day chronic gap, which changes "
        "alert VOLUME and nothing about detection."
    )
    payload["not_comparable_to"] = (
        "pv/lazzaretti_holdout.json, which scores "
        "nuravolt/validation/pv_row_classifier.py -- a separate implementation with "
        "its own thresholds fitted to this dataset's own percentiles. That artifact "
        "records thresholds_source as rule_based.py, which is incorrect."
    )
    payload["persistence_note"] = (
        "The shipped rules require a deficit to persist for several consecutive "
        "intervals. This dataset is a set of unordered independent snapshots with "
        "a synthetic clock bolted on, so a persistence requirement cannot be "
        "satisfied on it by construction. Scoring with --dwell-intervals 1 "
        "isolates the effect: the per-interval decisions are identical, and the "
        "difference between the two artifacts is entirely the dwell gate, which "
        "this benchmark cannot represent and which is what removes the false "
        "positives on real plants."
    )
    payload["limitations"] = [
        "Lazzaretti has no time axis; a synthetic 5-minute clock is supplied, so "
        "any rule depending on persistence is evaluated on a meaningless ordering.",
        "The shipped rule set addresses 2 of 5 classes, so all-class macro-F1 is "
        "capped near 0.4 by coverage alone.",
    ]
    name = f"shipped_detector_lazzaretti{('_' + args.tag) if args.tag else ''}"
    write_report("pv", name, payload)

    print(f"rows scored: {len(df):,}")
    print(f"alerts emitted: {emitted or 'none'}")
    print(f"macro-F1 (all 5 classes):        {payload['macro_f1']:.4f}")
    print(f"macro-F1 (2 addressable classes): {payload['macro_f1_addressable_classes_only']:.4f}")
    for c in range(5):
        m = per.get(CLASS_NAMES[c], {})
        note = "  <- no rule emits for this class" if c in UNADDRESSED else ""
        print(f"   {CLASS_NAMES[c]:<18} P {m.get('precision', 0):.3f}  "
              f"R {m.get('recall', 0):.3f}  F1 {m.get('f1', 0):.3f}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
