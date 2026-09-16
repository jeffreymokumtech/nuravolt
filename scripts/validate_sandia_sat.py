#!/usr/bin/env python3
"""Score the cascade on a SECOND real rig, and pre-register what we expect.

WHAT THIS CAN AND CANNOT MEASURE
--------------------------------
Sandia's fault vocabulary is TRACKER faults; the cascade's is string faults. So
this is **not** a like-for-like transfer F1 for open circuit, short circuit,
shading and degradation. Claiming otherwise would repeat the exact error that
made "the same rule set scores 0.189" wrong.

What it does give, and what nothing else available gives:

**A labelled false-positive rate on a second rig.** Sandia's ``no_fault`` rows
are known-healthy on hardware that is not Lazzaretti. Every non-normal verdict on
those rows is a false positive, counted, with no vocabulary matching needed.

**First labelled ground truth for the tracker detectors.** ``TRACKER_STUCK`` and
``TRACKER_MISALIGNED`` ship today with no validation of any kind.

THE PREDICTION, REGISTERED BEFORE THE DATA ARRIVES
--------------------------------------------------
Six CS3U-355PB-AG in series put Vmp near 238 V. The un-normalised cascade treats
"below 245 V" as short circuit and "below 260 V" as degradation, because those
literals were Lazzaretti's operating point. **Sandia's healthy operating voltage
sits inside the cascade's fault band**, so the fixed-reference run should
misclassify a large share of known-healthy rows, and the self-normalised run
should not.

If that does not happen, the normalisation story is wrong and this artifact will
say so. A prediction that cannot fail is not evidence.

Usage:
    python scripts/fetch_sandia_sat.py && python scripts/validate_sandia_sat.py
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.report import result_exists, write_report  # noqa: E402
from nuravolt.validation.row_classifier import (  # noqa: E402
    CLASS_NAMES,
    LAZZARETTI_REFS,
    TUNED_LAZZARETTI,
    ScaleRefs,
    classify,
)

#: Datasheet figures for the rig, so the prediction above is checkable.
MODULE = "Canadian Solar CS3U-355PB-AG"
MODULES_IN_SERIES = 6
MODULE_VMP_V = 39.7
MODULE_IMP_A = 8.95

PREDICTION = (
    f"{MODULES_IN_SERIES} x {MODULE} in series gives Vmp near "
    f"{MODULES_IN_SERIES * MODULE_VMP_V:.0f} V. The un-normalised cascade calls "
    f"below 245 V short circuit and below 260 V degradation, both being "
    f"Lazzaretti's operating point hard-coded. So this rig's HEALTHY voltage sits "
    f"inside the fault band, and the fixed-reference run is expected to "
    f"misclassify a large share of known-healthy rows while the self-normalised "
    f"run is not. Registered before the data was in hand."
)


def _pending(reason: str) -> int:
    if result_exists("pv", "sandia_sat_transfer"):
        print(f"pending ({reason}), but a real result exists; not overwriting it.")
        return 0
    write_report("pv", "sandia_sat_transfer", {
        "dataset": "Sandia SAT tracker faults (second real rig)",
        "status": "pending_manual_fetch",
        "reason": reason,
        "why_it_matters": (
            "The only rig in reach whose physical configuration is documented, and "
            "the only chance at a labelled false-positive rate on hardware that is "
            "not Lazzaretti."
        ),
        "registered_prediction": PREDICTION,
        "how_to_get_it": "python scripts/fetch_sandia_sat.py (prints manual steps)",
    })
    print(f"pending: {reason}")
    return 0


def main() -> int:
    try:
        from nuravolt.validation.adapters.sandia_sat import load_sandia_sat
    except ImportError as exc:
        return _pending(f"adapter unavailable: {exc}")

    try:
        split = load_sandia_sat()
    except FileNotFoundError as exc:
        return _pending(str(exc).splitlines()[0])
    except Exception as exc:  # noqa: BLE001 - adapter label map is known-provisional
        return _pending(f"{exc.__class__.__name__}: {exc}")

    sig = split.signals
    v_cols = [c for c in sig.columns if c.startswith("string_voltage_")]
    i_cols = [c for c in sig.columns if c.startswith("string_current_")]
    if len(v_cols) < 2 or len(i_cols) < 2 or "poa_irradiance" not in sig.columns:
        return _pending(
            f"channel shape incompatible: found {len(v_cols)} string_voltage_N and "
            f"{len(i_cols)} string_current_N columns, irradiance "
            f"{'present' if 'poa_irradiance' in sig.columns else 'absent'}. The "
            f"cascade needs 2+ of each plus irradiance. Columns: {sorted(sig.columns)}"
        )

    truth = split.label_names.to_list()
    healthy = [k for k, t in enumerate(truth) if t in ("normal", "no_fault")]
    if not healthy:
        return _pending(f"no healthy rows to measure against; labels seen: "
                        f"{sorted(set(truth))}")

    nameplate = ScaleRefs.from_nameplate(
        modules_in_series=MODULES_IN_SERIES, module_vmp_v=MODULE_VMP_V,
        strings_in_parallel=1, module_imp_a=MODULE_IMP_A)
    estimated = ScaleRefs.from_data(sig, voltage_cols=v_cols, current_cols=i_cols)

    out = {}
    for mode, refs in (("fixed_lazzaretti", LAZZARETTI_REFS),
                       ("nameplate", nameplate),
                       ("self_normalised", estimated)):
        preds = classify(sig, TUNED_LAZZARETTI, refs).to_list()
        on_healthy = Counter(preds[k] for k in healthy)
        fp = 1.0 - on_healthy.get("normal", 0) / len(healthy)
        out[mode] = {
            "scale_refs": refs.to_dict(),
            "false_positive_rate_on_healthy_rows": round(fp, 6),
            "verdicts_on_healthy_rows": {k: on_healthy.get(k, 0) for k in CLASS_NAMES},
            "class_mix_all_rows": {
                k: round(Counter(preds).get(k, 0) / len(preds), 6) for k in CLASS_NAMES},
        }

    fixed_fp = out["fixed_lazzaretti"]["false_positive_rate_on_healthy_rows"]
    norm_fp = out["self_normalised"]["false_positive_rate_on_healthy_rows"]
    payload = {
        "dataset": "Sandia SAT tracker faults (second real rig)",
        "n_samples": len(sig),
        "n_healthy_rows": len(healthy),
        "rig": {"module": MODULE, "modules_in_series": MODULES_IN_SERIES,
                "strings": 2, "kwp": 4.26, "site": "Albuquerque NM"},
        "by_scale_reference": out,
        "registered_prediction": PREDICTION,
        "prediction_outcome": (
            "CONFIRMED" if fixed_fp > norm_fp + 0.10 else
            "NOT CONFIRMED -- the normalisation story does not hold here"
        ),
        "measures": (
            "False-positive rate on rows labelled healthy. NOT a transfer F1 for the "
            "cascade's fault classes: this rig's fault vocabulary is tracker faults, "
            "which the cascade does not emit."
        ),
        "label_map_caveat": (
            "nuravolt/validation/adapters/sandia_sat.py describes its own class map as "
            "placeholders pending the real CSV structure. Verify it against the "
            "downloaded columns before quoting anything class-specific."
        ),
    }
    write_report("pv", "sandia_sat_transfer", payload)

    print(f"rows {len(sig):,}, healthy {len(healthy):,}")
    for mode, m in out.items():
        print(f"  {mode:<18} FP on healthy {m['false_positive_rate_on_healthy_rows']:.2%}"
              f"   v_ref {m['scale_refs']['v_ref_v']} V")
    print(f"prediction: {payload['prediction_outcome']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
