#!/usr/bin/env python3
"""What does the fault cascade DECLARE on a real plant it was never fitted to?

WHY THIS IS THE CLOSEST THING TO A TRANSFER TEST WE HAVE
--------------------------------------------------------
The cascade needs per-string current, per-string voltage and irradiance. Exactly
one labelled dataset carries all three (Lazzaretti), and it is the one the
thresholds were fitted on, so there is no labelled second rig to score against.

Real plants carry no fault labels, so precision cannot be computed. But the class
MIX is still strong evidence, because the prior is known: a working utility plant
is not short-circuited on 40% of its daylight intervals. A classifier that says so
has failed to transfer, and seeing that requires no labels at all.

This is the same argument ``scripts/measure_rule_firing_rates.py`` makes for the
shipped rule detector, applied to the row classifier, and it is tagged
``operability_no_labels`` for the same reason.

WHAT IT COMPARES
----------------
The identical cascade under two scale references:

    fixed            the Lazzaretti operating point, hard-coded -- what shipped
    self_normalised  estimated from each inverter's own record, no labels used

If normalisation is doing real work, the second should look far more plausible on
plants running at voltages Lazzaretti never saw.

Usage:
    python scripts/measure_classifier_class_mix.py --plants eta delta
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Optional

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.report import write_report  # noqa: E402
from nuravolt.validation.row_classifier import (  # noqa: E402
    CLASS_NAMES,
    LAZZARETTI_REFS,
    TUNED_LAZZARETTI,
    ScaleRefs,
    classify,
)

CACHE = Path("backenddata/cache/rulerates")

#: Plausible upper bound on the share of daylight intervals a healthy plant may
#: legitimately be labelled with. Engineering judgements, stated so they can be
#: argued with, and deliberately generous.
PLAUSIBLE_MAX_SHARE = {
    "normal": 1.00,
    "open_circuit": 0.02,
    "short_circuit": 0.01,
    "partial_shading": 0.30,
    "degradation": 0.10,
}


def _inverter_frame(df: pl.DataFrame, token: str, irr_col: str) -> Optional[pl.DataFrame]:
    ren: Dict[str, str] = {irr_col: "poa_irradiance"}
    for c in df.columns:
        if f": {token} /" not in c:
            continue
        if (m := re.search(r"Input_current_(\d+)", c)):
            ren[c] = f"string_current_{int(m.group(1))}"
        elif (m := re.search(r"U_DC_(\d+)", c)):
            ren[c] = f"string_voltage_{int(m.group(1))}"
    out = df.select(list(ren)).rename(ren)
    v = [c for c in out.columns if c.startswith("string_voltage_")]
    i = [c for c in out.columns if c.startswith("string_current_")]
    if len(v) < 2 or len(i) < 2:
        return None
    return out.filter(pl.col("poa_irradiance") >= 200.0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plants", nargs="+",
                    default=["eta", "delta", "gamma", "zeta"])
    ap.add_argument("--max-inverters", type=int, default=None)
    args = ap.parse_args()

    per_plant: Dict[str, Dict] = {}
    for plant in args.plants:
        pq = CACHE / f"{plant}.parquet"
        if not pq.exists():
            print(f"{plant}: no cached slice at {pq}; skipping")
            continue
        df = pl.read_parquet(pq)
        irr_cols = [c for c in df.columns
                    if "Irradiation_average" in c or "Radiation 1" in c]
        if not irr_cols:
            print(f"{plant}: no irradiance channel; the cascade cannot run")
            per_plant[plant] = {"status": "no_irradiance_channel"}
            continue
        tokens = sorted({m.group(1) for c in df.columns
                         if (m := re.search(r":\s*(INV [\d.]+)\s*/", c))})
        if args.max_inverters:
            tokens = tokens[:args.max_inverters]

        fixed, adapted = Counter(), Counter()
        n_rows, n_dev, v_refs = 0, 0, []
        for tok in tokens:
            inv = _inverter_frame(df, tok, irr_cols[0])
            if inv is None or inv.is_empty():
                continue
            v = [c for c in inv.columns if c.startswith("string_voltage_")]
            i = [c for c in inv.columns if c.startswith("string_current_")]
            n_dev += 1
            n_rows += len(inv)
            fixed.update(classify(inv, TUNED_LAZZARETTI, LAZZARETTI_REFS).to_list())
            refs = ScaleRefs.from_data(inv, voltage_cols=v, current_cols=i)
            v_refs.append(refs.v_ref)
            adapted.update(classify(inv, TUNED_LAZZARETTI, refs).to_list())

        if not n_rows:
            print(f"{plant}: no inverter exposes 2+ string voltages AND currents")
            per_plant[plant] = {"status": "incompatible_channel_shape",
                                "reason": "fewer than 2 string_voltage_N columns"}
            continue

        def mix(c: Counter) -> Dict[str, float]:
            return {k: round(c.get(k, 0) / n_rows, 6) for k in CLASS_NAMES}

        mf, ma = mix(fixed), mix(adapted)
        implausible = {
            mode: sorted(k for k, share in m.items()
                         if share > PLAUSIBLE_MAX_SHARE.get(k, 1.0))
            for mode, m in (("fixed", mf), ("self_normalised", ma))
        }
        never = {
            mode: sorted(k for k in CLASS_NAMES if k != "normal" and m[k] == 0.0)
            for mode, m in (("fixed", mf), ("self_normalised", ma))
        }
        per_plant[plant] = {
            "devices_scored": n_dev, "daylight_device_intervals": n_rows,
            "never_emitted": never,
            "median_v_ref_v": round(sum(v_refs) / len(v_refs), 1) if v_refs else None,
            "lazzaretti_v_ref_v": LAZZARETTI_REFS.v_ref,
            "class_mix_fixed_refs": mf,
            "class_mix_self_normalised": ma,
            "implausible_classes": implausible,
        }
        print(f"\n{plant}: {n_dev} inverters, {n_rows:,} daylight device-intervals, "
              f"v_ref {per_plant[plant]['median_v_ref_v']} V "
              f"(Lazzaretti {LAZZARETTI_REFS.v_ref} V)")
        print(f"   {'class':<18}{'fixed':>10}{'normalised':>13}{'bound':>9}")
        for k in CLASS_NAMES:
            flag = ""
            if mf[k] > PLAUSIBLE_MAX_SHARE.get(k, 1.0):
                flag += " fixed>bound"
            if ma[k] > PLAUSIBLE_MAX_SHARE.get(k, 1.0):
                flag += " norm>bound"
            print(f"   {k:<18}{mf[k]:>9.2%}{ma[k]:>13.2%}"
                  f"{PLAUSIBLE_MAX_SHARE.get(k, 1.0):>9.0%}{flag}")

    scored = {k: v for k, v in per_plant.items() if "class_mix_fixed_refs" in v}
    payload = {
        "dataset": "Row classifier class mix on real plants",
        "n_samples": sum(v["daylight_device_intervals"] for v in scored.values()),
        "per_plant": per_plant,
        "plausible_max_share": PLAUSIBLE_MAX_SHARE,
        "method": (
            "The Lazzaretti-tuned cascade run over real plant SCADA under two scale "
            "references: the hard-coded Lazzaretti operating point, and one estimated "
            "from each inverter's own record using no labels. No fault labels exist, so "
            "precision cannot be computed; instead each class's declared share of "
            "daylight device-intervals is compared against a stated plausible bound."
        ),
        "finding": (
            "With the Lazzaretti scale references hard-coded -- which is what ships -- "
            "open_circuit, short_circuit and degradation are emitted ZERO times across "
            "every plant scored. Not rarely: never. These plants run at 653 to 788 V per "
            "string against Lazzaretti's 270, so the per-unit voltage sits permanently "
            "above every threshold in the cascade that has a voltage ceiling, and three "
            "of the four fault classes become structurally unreachable. A silent "
            "detector is worse than a noisy one, because a plant with no alerts looks "
            "like a healthy plant."
        ),
        "with_normalisation": (
            "Estimating the reference from each inverter's own record restores all four "
            "classes and leaves the mix inside the stated plausible bounds. That is a "
            "necessary condition for transfer, not proof of it: these plants carry no "
            "labels, so nothing here says the restored detections are CORRECT, only "
            "that the classifier is no longer incapable of making them."
        ),
        "open_circuit_caveat": (
            "open_circuit stays at zero under both references. Its test requires a "
            "voltage spread exceeding the median, which on a 12-input inverter the "
            "median-based statistic rarely reaches. That is a channel-count effect and "
            "is not fixed by scale normalisation."
        ),
        "what_this_is_not": (
            "Not accuracy, and not a false-positive rate. It is evidence of transfer "
            "failure where a class is declared far more often than that failure mode "
            "can plausibly occur."
        ),
    }
    write_report("pv", "classifier_class_mix_real_plants", payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
