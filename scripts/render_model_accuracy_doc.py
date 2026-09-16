#!/usr/bin/env python3
"""Generate ``docs/MODEL_ACCURACY.md`` from the committed validation artifacts.

The rule this file exists to enforce: **a number with no source artifact does not
go on a spec sheet.** Every row is rendered from
``public/data/validation/summary.json`` and carries the path of the JSON it came
from, so anyone can check it. Nothing here is hand-typed.

Usage:
    python scripts/render_model_accuracy_doc.py            # write the doc
    python scripts/render_model_accuracy_doc.py --check    # fail if stale (CI)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

SUMMARY = Path("public/data/validation/summary.json")
OUT = Path("docs/MODEL_ACCURACY.md")
#: Artifacts hold per-class detail that summary.json does not carry, so the
#: per-fault tables read them directly.
VALIDATION_ROOT = Path("public/data/validation")

DOMAIN_TITLES = {
    "twin": "Digital twin (expected vs actual power)",
    "soiling": "Soiling",
    "pv": "PV fault detection and degradation",
    "forecast": "Forecasting",
    "bess": "Battery (BESS)",
}
DOMAIN_ORDER = ["twin", "soiling", "forecast", "pv", "bess"]

# Plain-English rendering of the honesty tag. The tag is the single most
# important column here: it is what separates "we scored ourselves on our own
# training data" from "we scored ourselves on a site we had never seen".
BASIS = {
    "walk_forward_oos": (
        "Walk-forward out-of-sample",
        "Refit on an expanding history, scored only on the next unseen window. "
        "This is what the model does in production.",
    ),
    "cross_plant_transfer": (
        "Cross-plant, unseen site",
        "Trained on other plants entirely and scored on a site the model had "
        "never seen. This is the day-one number for a new customer.",
    ),
    "cross_dist": (
        "Cross-dataset",
        "Scored on a different dataset than anything used in training or tuning.",
    ),
    "synthetic_perturbation": (
        "Synthetic perturbation",
        "The same labelled dataset with its voltage and current channels rescaled "
        "to imitate a rig built with a different number of modules in series and "
        "strings in parallel. Isolates scale, holding physics and labels fixed. "
        "Necessary for transfer, not sufficient: fill factor, series resistance "
        "and temperature coefficient are not scale factors.",
    ),
    "provenance_audit": (
        "Provenance audit",
        "Not a score. A record of which implementation produced which published "
        "number, and which comparisons between them are legitimate.",
    ),
    "ground_truth_measurement": (
        "Ground-truth measurement",
        "Compared against an independent reference measurement.",
    ),
    "literature_comparison": (
        "Literature comparison",
        "Compared against published field results rather than a held-out split.",
    ),
    "literature_vs_observed": (
        "Literature vs observed gap",
        "A deliberate check of where our published prior disagrees with observation.",
    ),
    "physics_check": (
        "Physics check",
        "First-principles and lookup only. No model is trained, so there is "
        "nothing to overfit.",
    ),
    "operability_no_labels": (
        "Operability, unlabelled",
        "Measured on real plants that carry no fault labels. This says how often "
        "the detector fires per MW per month, not how many real faults it caught. "
        "It is a shipping gate, not an accuracy figure.",
    ),
    "transfer_readiness": (
        "Transfer readiness",
        "Which climate regimes we consider ourselves entitled to quote a number "
        "for at all.",
    ),
    "in_dist_train_test_split": (
        "In-distribution split",
        "A random split of one dataset. Flattering; treat as an upper bound, "
        "not as field performance.",
    ),
    "in_dist_tuned_thresholds": (
        "In-distribution, tuned",
        "Held-out rows, but thresholds were tuned on the same dataset.",
    ),
    "in_dist_no_tuning": (
        "In-distribution, untuned",
        "Same dataset, but with thresholds that never saw it. The honest "
        "untuned baseline.",
    ),
    "in_dist_loo": (
        "Leave-one-out",
        "Each subject held out in turn from the same dataset.",
    ),
    "in_dist_shipped_code": (
        "In-distribution, shipped code",
        "Held-out rows of one dataset, scored by running the detector that "
        "actually ships rather than a research surrogate written to match it. "
        "It has its own basis because it is the only in-distribution row that "
        "measures the product: the surrogate scores are upper bounds on the "
        "approach, this is the code a customer receives.",
    ),
    "untagged": ("Untagged", "No honesty tag recorded. Do not quote."),
}

GLOSSARY = """\
## Abbreviations

Every abbreviation used in this document, spelled out once:

| Short form | Means | In plain terms |
|---|---|---|
| **nMAE** | normalised mean absolute error | Average size of the error, expressed as a percentage of a stated reference (nameplate capacity, or mean daily energy) so it is comparable between plants of different sizes. |
| **nRMSE** | normalised root mean squared error | Like nMAE but penalises large misses more heavily. Always at least as large as nMAE. |
| **MBE** | mean bias error | The *signed* average error. Positive means we over-predict. Bias and accuracy are reported separately and never folded together. |
| **MAE** | mean absolute error | Average size of the error in the target's own units. |
| **MAPE** | mean absolute percentage error | Average error as a percentage of each individual value. Unstable near zero, so it is not used as a headline here. |
| **R²** | coefficient of determination | Share of variance explained. Reported in the JSON as a footnote only: on a solar power time series roughly 95% of the variance is just the day/night cycle, so a high R² is table stakes and a low one can coexist with an excellent error. |
| **SR** | soiling ratio | Actual output divided by clean-panel output. 0.98 means dirt is costing 2%. |
| **pp** | percentage points | The unit for a soiling-ratio error. "1 pp" means the SR estimate was off by 0.01. |
| **IWSR** | insolation-weighted soiling ratio | Annual soiling ratio weighted by how much sunlight each day carried, i.e. what soiling actually costs you in energy. |
| **POA** | plane of array | Irradiance measured in the plane the modules actually sit in, rather than horizontally. |
| **PR** | performance ratio | Measured output divided by the output the irradiance and nameplate say you should have got. |
| **RUL** | remaining useful life | How long until an asset crosses a defined engineering limit. |
| **EOL** | end of life | The cycle or date at which a battery cell reaches its capacity threshold. |
| **NWP** | numerical weather prediction | A real weather forecast model run, as opposed to a reanalysis of what already happened. |
| **LOO** | leave-one-out | Validation where each subject is held out in turn. |
| **F1 / macro-F1** | F1 score | Balance of precision and recall. "Macro" averages across classes equally, so a rare fault type counts as much as a common one. |
| **Spearman** | Spearman rank correlation | Whether the ordering is right, ignoring the absolute scale. Useful when a model ranks assets correctly but its absolute numbers are uncalibrated. |
| **Skill score** | skill score vs a baseline | `1 - nMAE_model / nMAE_baseline`. Above 0 the model beats the baseline; at or below 0 it does not, and should not ship. |
| **Persistence** | persistence baseline | The cheapest defensible forecast: "same as yesterday". The reference every forecast is measured against. |
"""


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:,.3f}".rstrip("0").rstrip(".")
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _physics_cell(entry: Dict[str, Any]) -> str:
    """Reference baseline and the ML uplift over it, where both exist."""
    ref = entry.get("reference_nmae_pct")
    if ref is None:
        return "—"
    # The key can be present AND null, so .get()'s default never fires.
    label = entry.get("reference_baseline") or "baseline"
    uplift = entry.get("uplift_vs_reference_pct")
    if uplift is None:
        return f"{label} {ref:.2f}%"
    verdict = "ML helps" if uplift > 0 else "**ML does not help**"
    return f"{label} {ref:.2f}% → {uplift:+.0f}% ({verdict})"



def _per_fault_tables(datasets: Dict[str, Any]) -> List[str]:
    """One precision/recall/F1 table per classification artifact.

    A macro-F1 is an average over classes, and an average hides exactly the thing
    an operator needs to know: WHICH faults this detector actually finds. The
    per-class numbers have always been computed and stored; they were simply
    never rendered. Two decompositions are added alongside them.

    **Detected-classes macro** re-averages over only the classes the detector
    ever predicts. ``compute_report`` averages in classes with F1 0.000 that the
    detector structurally cannot emit, so an all-class macro is part detection
    quality and part coverage. Separating them is the difference between "this
    detector is poor" and "this detector addresses three of eight fault types".

    **Never detected** lists classes that are present in the data and score F1
    exactly 0.000. That is the single most actionable line here.
    """
    out: List[str] = ["## Per fault: precision, recall, F1", ""]
    out += [
        "Read this before the macro number above it. `Support` is how many rows of",
        "that class the test set actually held; a class with small support carries a",
        "noisy F1 and should not be quoted alone.",
        "",
    ]
    any_rendered = False
    for domain in sorted(datasets):
        for name in sorted(datasets[domain]):
            path = VALIDATION_ROOT / domain / f"{name}.json"
            if not path.exists():
                continue
            try:
                d = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            per = d.get("per_class")
            if not per:
                continue
            any_rendered = True
            entry = datasets[domain][name]
            tag = entry.get("distribution_relationship", "untagged")
            basis, _ = BASIS.get(tag, (tag, ""))
            out.append(f"### `{domain}/{name}` — {basis}")
            out.append("")
            out.append("| Fault | Precision | Recall | F1 | Support |")
            out.append("|---|---|---|---|---|")
            f1s, detected, dead = [], [], []
            for cls, m in per.items():
                f1, sup = m.get("f1", 0.0), m.get("support", 0)
                f1s.append(f1)
                if m.get("precision", 0.0) > 0 or m.get("recall", 0.0) > 0:
                    detected.append(f1)
                elif sup:
                    dead.append(cls)
                out.append(f"| `{cls}` | {m.get('precision', 0.0):.3f} | "
                           f"{m.get('recall', 0.0):.3f} | {f1:.3f} | {sup:,} |")
            out.append("")
            macro_all = sum(f1s) / len(f1s) if f1s else 0.0
            bits = [f"macro-F1 over all {len(f1s)} classes **{macro_all:.3f}**"]
            if detected and len(detected) != len(f1s):
                bits.append(f"over the {len(detected)} it ever predicts "
                            f"**{sum(detected) / len(detected):.3f}**")
            out.append(" · ".join(bits))
            if dead:
                out.append("")
                out.append(f"**Never detected** (present in the data, F1 exactly 0.000): "
                           f"{', '.join('`' + c + '`' for c in dead)}.")
            out.append("")
    return out if any_rendered else []


def render(summary: Dict[str, Any]) -> str:
    gen = summary.get("generated_at", "unknown")
    totals = summary.get("totals", {})

    lines: List[str] = [
        "# Model accuracy",
        "",
        "> **This file is generated.** Run `python scripts/render_model_accuracy_doc.py`",
        "> to rebuild it from `public/data/validation/summary.json`. Do not edit it by",
        "> hand, and do not quote a number anywhere (sales asset, spec sheet, proposal)",
        "> that does not appear here with a source path. A number with no artifact",
        "> behind it does not go on a spec sheet.",
        "",
        f"Generated: `{gen}` · {totals.get('datasets', 0)} datasets · "
        f"{totals.get('samples', 0):,} samples",
        "",
        "## How to read this",
        "",
        "The **Basis** column matters more than the number next to it. It says how the",
        "score was earned: on a site the model had never seen, on a held-out slice of",
        "its own training data, or against a published reference. An in-distribution",
        "score and a cross-plant score are not comparable, and we do not present them",
        "as though they were.",
        "",
        "The **Reference baseline** column is the same metric computed for a simpler",
        "model on the identical sample, and the arrow is what the machine learning",
        "adds over it. It answers the question a technical buyer asks first: is the",
        "ML earning its place, or is it decoration? Where it is not earning its",
        "place we say so, in this table, rather than leaving the comparison out.",
        "",
        "`irradiance_scaling` is a least-squares line through irradiance, fitted on",
        "the training window only. `physics_only` is the PVWatts physics twin.",
        "`physics_perfect_irradiance` is an oracle: physics fed the *observed*",
        "weather, which no real forecast can match, shown to separate weather",
        "uncertainty from model error.",
        "",
    ]

    datasets = summary.get("datasets", {})
    ordered = [d for d in DOMAIN_ORDER if d in datasets]
    ordered += [d for d in datasets if d not in DOMAIN_ORDER]

    for domain in ordered:
        lines.append(f"## {DOMAIN_TITLES.get(domain, domain.title())}")
        lines.append("")
        lines.append("| Result | n | Basis | Reference baseline → ML uplift | Source |")
        lines.append("|---|---|---|---|---|")
        pending = []
        for name, entry in sorted(datasets[domain].items()):
            # A placeholder is not a result. Route it to its own list rather than
            # rendering "harness ready, implementation pending" as a finding.
            if str(entry.get("status", "")).startswith(("pending", "no_prediction")):
                pending.append((name, entry))
                continue
            tag = entry.get("distribution_relationship", "untagged")
            basis, _ = BASIS.get(tag, (tag, ""))
            # Escape the pipe rather than truncating at it. Splitting on " | "
            # silently discarded everything after the separator, which is where
            # several artifacts put their null calibration and their failed
            # checks -- the evidence, thrown away by the renderer.
            headline = entry.get("headline", "—").replace(" | ", " · ").replace("|", "\\|")
            src = f"`public/data/validation/{domain}/{name}.json`"
            lines.append(
                f"| {headline} | {_fmt(entry.get('n_samples'))} | {basis} | "
                f"{_physics_cell(entry)} | {src} |"
            )
        lines.append("")
        if pending:
            lines.append(f"*Planned, not yet run: "
                         f"{', '.join('`' + n + '`' for n, _ in pending)}.*")
            lines.append("")

    lines += _per_fault_tables(datasets)

    lines.append("## What each basis means")
    lines.append("")
    lines.append("| Basis | What it means |")
    lines.append("|---|---|")
    used = {
        e.get("distribution_relationship", "untagged")
        for d in datasets.values()
        for e in d.values()
    }
    for tag in sorted(used):
        basis, expl = BASIS.get(tag, (tag, "No description recorded."))
        lines.append(f"| **{basis}** | {expl} |")
    lines.append("")
    lines.append(GLOSSARY)

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the doc is stale relative to summary.json",
    )
    args = ap.parse_args()

    if not SUMMARY.exists():
        print(f"missing {SUMMARY}; run scripts/validate_all.py first", file=sys.stderr)
        return 1

    body = render(json.loads(SUMMARY.read_text()))

    if args.check:
        if not OUT.exists():
            print(f"{OUT} does not exist; run without --check", file=sys.stderr)
            return 1
        # Ignore the generated-at line, which changes on every harness run.
        def strip(t: str) -> str:
            return "\n".join(l for l in t.splitlines() if not l.startswith("Generated:"))
        if strip(OUT.read_text()) != strip(body):
            print(
                f"{OUT} is stale relative to {SUMMARY}. "
                f"Run: python scripts/render_model_accuracy_doc.py",
                file=sys.stderr,
            )
            return 1
        print(f"{OUT} is up to date")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body)
    print(f"wrote {OUT} ({len(body):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
