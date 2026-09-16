#!/usr/bin/env python3
"""Which classifier produced each published fault number?

WHY THIS IS A SEPARATE ARTIFACT
-------------------------------
Three macro-F1 figures have been quoted together as if they were one detector
degrading across conditions:

    0.835  in-distribution, thresholds tuned on the dataset
    0.519  in-distribution, untuned physics defaults
    0.189  "a different plant architecture"

The first pair is a fair comparison. The third is not a comparison at all, and
the difference is not visible from the numbers -- you have to open three files to
see it. So it gets written down, by script, from the artifacts themselves.

Usage:
    python scripts/audit_classifier_provenance.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.report import write_report  # noqa: E402

PV = Path("public/data/validation/pv")

#: What each classifier can physically read. This is the fact that decides
#: whether a "cross-dataset" run was ever possible, and it is not recoverable
#: from the artifacts, so it is stated here.
REQUIRED_COLUMNS = {
    "pv_row_classifier (cascade surrogate)": [
        "poa_irradiance", "module_temp",
        "string_voltage_1", "string_voltage_2",
        "string_current_1", "string_current_2"],
    "pv_row_classifier_physics (config.py defaults only)": [
        "poa_irradiance", "module_temp",
        "string_voltage_1", "string_voltage_2",
        "string_current_1", "string_current_2"],
    "gpvs_row_classifier (cascade-aligned, GPVS-shape features)": [
        "Ipv", "Vpv", "Vdc", "dc_ratio"],
}

DATASET_COLUMNS = {
    "Lazzaretti": ["fault_class", "poa_irradiance", "module_temp",
                   "string_current_1", "string_current_2",
                   "string_voltage_1", "string_voltage_2"],
    "GPVS": ["Time", "Ipv", "Vpv", "Vdc", "ia", "ib", "ic",
             "va", "vb", "vc", "Iabc", "If", "Vabc", "Vf"],
}


def main() -> int:
    rows = []
    for stem in ("lazzaretti_holdout", "lazzaretti_physics_blind",
                 "gpvs_cross_dataset", "lazzaretti_lgbm"):
        f = PV / f"{stem}.json"
        if not f.exists():
            continue
        d = json.loads(f.read_text())
        extras = d.get("extras", {}) or {}
        rows.append({
            "artifact": f"pv/{stem}.json",
            "macro_f1": d.get("macro_f1"),
            "n_samples": d.get("n_samples"),
            "n_classes": len(d.get("classes", [])),
            "classifier": extras.get("classifier"),
            "thresholds_source": extras.get("thresholds_source"),
            "classes_with_zero_f1": sorted(
                k for k, v in (d.get("per_class") or {}).items() if v.get("f1") == 0.0
            ),
        })

    payload = {
        "dataset": "Provenance of the published PV fault classification numbers",
        "n_samples": sum(r["n_samples"] or 0 for r in rows),
        "artifacts": rows,
        "finding": (
            "The three headline numbers come from three DIFFERENT classifier "
            "implementations, not one detector under three conditions."
        ),
        "which_comparisons_are_valid": {
            "0.835_vs_0.519": (
                "VALID. Identical rows (the same load_lazzaretti call), identical "
                "5-class taxonomy, identical metric. The only thing that changes is "
                "which module's thresholds are used, so the 37.9% gap really is the "
                "cost of tuning thresholds on the data they are scored on."
            ),
            "0.519_vs_0.189": (
                "NOT VALID, on four counts at once. (1) Different classifier module: "
                "gpvs_row_classifier, which shares no code with the other two. "
                "(2) Disjoint input columns -- the Lazzaretti cascade reads per-string "
                "voltage and current plus irradiance; GPVS has none of those, only "
                "system-level Ipv/Vpv/Vdc and three-phase AC. The surrogate could not "
                "be run on GPVS even if someone wanted to. (3) Different taxonomy, 5 "
                "classes against 8, and five of the eight cannot be emitted by that "
                "classifier at all, so they score F1 0.000 and drag the unweighted "
                "macro mean down mechanically. (4) GPVS's own thresholds are fitted to "
                "GPVS percentiles, making 0.189 a second in-sample number rather than "
                "a transfer number."
            ),
        },
        "what_has_never_been_measured": (
            "How the tuned surrogate behaves on any dataset other than Lazzaretti. No "
            "second labelled dataset with per-string current, per-string voltage and "
            "irradiance exists in this repo. See pv/scale_transfer_lazzaretti.json for "
            "what could be measured instead."
        ),
        "classifier_required_columns": REQUIRED_COLUMNS,
        "dataset_available_columns": DATASET_COLUMNS,
        "superseded_by": (
            "nuravolt/validation/row_classifier.py -- one parameterised cascade. An "
            "artifact from it records the threshold set and the scale references by "
            "value, so this class of confusion cannot recur."
        ),
    }
    write_report("pv", "classifier_provenance", payload)

    print(f"{'artifact':<38}{'macro':>8}{'classes':>9}  classifier")
    for r in rows:
        print(f"{r['artifact']:<38}{r['macro_f1']:>8}{r['n_classes']:>9}  "
              f"{(r['classifier'] or 'unrecorded')[:52]}")
        if r["classes_with_zero_f1"]:
            print(f"{'':>55}F1 0.000: {', '.join(r['classes_with_zero_f1'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
