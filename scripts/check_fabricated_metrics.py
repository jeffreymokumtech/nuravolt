#!/usr/bin/env python3
"""Fail the build if an accuracy number appears without a validation artifact.

This exists because it already happened. `src/utils/modelAccuracyData.ts` was a
hardcoded "generates realistic validation metrics for PDF export" module, and
`sales-assets/CAPABILITIES_OVERVIEW.md` shipped a predictive-model table copied
verbatim from the design targets in `nuravolt/fault/rul_evaluation.py`. Both read
as measured performance. Neither was.

The rule: an accuracy-shaped claim lives in `docs/MODEL_ACCURACY.md`, which is
generated from `public/data/validation/summary.json`. Everywhere else, a number
next to an accuracy word needs an explicit opt-out comment saying why.

Opt out on a case-by-case basis with the marker ``ACCURACY-OK:`` followed by a
reason on the same line or the line above.

Usage:
    python scripts/check_fabricated_metrics.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import List, Tuple

# Where accuracy claims are allowed to live.
ALLOWED = {
    Path("docs/MODEL_ACCURACY.md"),
    # The methods companion. Every figure in it is either quoted from an artifact
    # under public/data/validation/ or explicitly labelled as an investigation
    # measurement, and it exists precisely to explain where the numbers come from.
    Path("docs/MODEL_ACCURACY_METHODS.md"),
    # Transfer-versus-tuning companion. Same contract: every figure is quoted from
    # an artifact under public/data/validation/ or explicitly marked not measured.
    Path("docs/TRANSFER_AND_TUNING.md"),
    Path("scripts/check_fabricated_metrics.py"),
    Path("scripts/render_model_accuracy_doc.py"),
}

# Trees that ship to customers or render in the product.
SCAN_DIRS = [Path("src"), Path("sales-assets"), Path("docs")]
# ``.html`` is here because leaving it out cost us: sales-assets/nuravolt-catalog.html
# is the source of the flagship product-catalog PDF, and it headlined "99.8% of PV
# faults correctly classified" -- a real number, from a real artifact, describing a
# model nobody ships -- entirely invisible to this scan.
SCAN_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".md", ".html"}

# Directories that are inputs or generated output, not authored claims.
SKIP_PARTS = {"node_modules", ".next", "dist", "build", "__pycache__"}

ACCURACY_WORDS = (
    r"accuracy|precision|recall|f1[\s_-]?score|macro[\s_-]?f1|"
    r"detection[\s_-]?rate|false[\s_-]?positive|confidence[\s_-]?interval|"
    r"\bmae\b|\brmse\b|\bmape\b|\bnmae\b|r\^?2|r²|r[\s_-]?squared|skill[\s_-]?score"
)

# An accuracy word within ~60 chars of a percentage or a 0.xx figure.
PATTERN = re.compile(
    rf"(?i)(?:({ACCURACY_WORDS})[^\n]{{0,60}}?(\d+\.?\d*\s*%|0\.\d{{2,}})"
    rf"|(\d+\.?\d*\s*%|0\.\d{{2,}})[^\n]{{0,60}}?({ACCURACY_WORDS}))"
)

OPT_OUT = re.compile(r"ACCURACY-OK:")


def scan(path: Path) -> List[Tuple[int, str]]:
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []

    hits: List[Tuple[int, str]] = []
    for i, line in enumerate(lines, start=1):
        if not PATTERN.search(line):
            continue
        if OPT_OUT.search(line):
            continue
        if i >= 2 and OPT_OUT.search(lines[i - 2]):
            continue
        hits.append((i, line.strip()[:150]))
    return hits


def main() -> int:
    findings: List[Tuple[Path, int, str]] = []
    for root in SCAN_DIRS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.suffix not in SCAN_SUFFIXES or not path.is_file():
                continue
            if SKIP_PARTS & set(path.parts) or path in ALLOWED:
                continue
            for lineno, text in scan(path):
                findings.append((path, lineno, text))

    if not findings:
        print("check_fabricated_metrics: OK, no unsourced accuracy claims")
        return 0

    print(
        f"check_fabricated_metrics: {len(findings)} accuracy claim(s) outside "
        f"docs/MODEL_ACCURACY.md\n",
        file=sys.stderr,
    )
    for path, lineno, text in findings:
        print(f"  {path}:{lineno}: {text}", file=sys.stderr)
    print(
        "\nEvery accuracy number must trace to a committed artifact under\n"
        "public/data/validation/ and appear in docs/MODEL_ACCURACY.md.\n"
        "If a line here is legitimate (a glossary entry, a threshold, a config\n"
        "value), annotate it with 'ACCURACY-OK: <reason>' on the same line or\n"
        "the line above.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
