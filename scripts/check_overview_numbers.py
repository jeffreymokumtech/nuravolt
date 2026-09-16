#!/usr/bin/env python3
"""Assert every number in docs/overviews/ against the artifact it came from.

WHY THIS EXISTS
---------------
``scripts/check_fabricated_metrics.py`` asks a weaker question: is this number
*annotated*? It accepts ``ACCURACY-OK:`` followed by any free text at all, so a
sincere annotation naming the wrong artifact, or an annotation whose artifact has
since moved, passes silently. That is how ``NuraVolt-Product-Catalog.pdf`` came to
headline "99.8% of PV faults correctly classified" -- a real number, from a real
artifact, describing a model nobody ships.

This checker asks the stronger question: does the artifact still say that? It
parses a machine-readable source expression out of each annotation, opens the
artifact, and compares. A claim that has drifted fails; a claim whose artifact has
been deleted fails; a number with no annotation at all fails.

The three source forms, all written after ``<-``:

    <!-- ACCURACY-OK: 48.8% <- bess/severson_lgbm.eol_within_10pct_fraction pct -->
    <!-- ACCURACY-OK: 34 fault types <- doc:docs/FAULT_COVERAGE.md -->
    <!-- ACCURACY-OK: no measured accuracy <- not-measured: no observed inverter failures -->

The first resolves a dotted key inside ``public/data/validation/<domain>/<name>.json``
and compares numerically, rounded to the precision the prose actually wrote. The
second asserts the literal appears verbatim in a generated document, which is how a
count that comes from ``render_fault_coverage_doc.py`` stays true. The third is an
explicit declaration that no number exists, for the sentences that say so and trip
the accuracy-word regex on their way past.

Coverage is the half that matters. Every line matching the same PATTERN that
``check_fabricated_metrics.py`` uses must carry an annotation, on its own line or
in the contiguous annotation block directly above it. So a new unsourced number
cannot be added to an overview without the build noticing.

Usage:
    python scripts/check_overview_numbers.py
    python scripts/check_overview_numbers.py --quiet     # failures only
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_fabricated_metrics import PATTERN  # noqa: E402  the identical claim regex

OVERVIEWS = Path("docs/overviews")
VALIDATION = Path("public/data/validation")

#: ``<!-- ACCURACY-OK: <literal> <- <source> -->``. The literal is prose, so it may
#: hold anything; the source is parsed.
ANNOTATION = re.compile(r"ACCURACY-OK:\s*(?P<literal>.+?)\s*<-\s*(?P<source>.+?)\s*(?:-->|$)")

#: ``domain/name.dotted.key [transform]``
ARTIFACT_REF = re.compile(
    r"^(?P<domain>[a-z_]+)/(?P<name>[a-z0-9_]+)\.(?P<key>[A-Za-z0-9_.]+)"
    r"(?:\s+(?P<transform>pct|pp|raw|abs|neg|millions|thousands))?$"
)

#: A number as prose writes one: 1.44, 48.8%, -0.032, 99,481, ~0.95, 5.95.
#:
#: The lookbehind is load-bearing. Without it the "1" in "F1" and the "2" in "R2"
#: parse as claims, and since rounding 0.983 to zero decimal places gives 1, the
#: annotation "F1 0.983" would verify against an artifact holding 0.983 by matching
#: the wrong digit -- a checker reporting OK while checking nothing.
NUMBER = re.compile(r"(?<![A-Za-z0-9])[-−]?\d[\d,]*(?:\.\d+)?")

TRANSFORMS = {
    "raw": lambda v: v,
    "pp": lambda v: v,
    "pct": lambda v: v * 100.0,
    "abs": abs,
    "neg": lambda v: -v,
    "millions": lambda v: v / 1_000_000.0,
    "thousands": lambda v: v / 1_000.0,
}


class ClaimError(Exception):
    """A claim could not be resolved. The message is the user-facing reason."""


def literal_numbers(literal: str) -> List[Decimal]:
    """Every number in the annotated literal, in the precision it was written.

    Decimal rather than float, so that "48.8" records one decimal place and
    "0.920" records three: the written precision is what the comparison rounds to,
    which is the only fair reading of a number someone chose how to write.
    """
    out: List[Decimal] = []
    for raw in NUMBER.findall(literal):
        try:
            out.append(Decimal(raw.replace(",", "").replace("\u2212", "-")))
        except InvalidOperation:
            continue
    return out


def all_numbers(literal: str) -> List[str]:
    return [n.replace("\u2212", "-") for n in NUMBER.findall(literal)]


def resolve_key(payload: Dict, dotted: str) -> float:
    node = payload
    for part in dotted.split("."):
        if isinstance(node, list):
            try:
                node = node[int(part)]
                continue
            except (ValueError, IndexError):
                raise ClaimError(f"index '{part}' out of range in list")
        if not isinstance(node, dict) or part not in node:
            available = ", ".join(sorted(node)[:8]) if isinstance(node, dict) else type(node).__name__
            raise ClaimError(f"key '{part}' not in artifact (has: {available})")
        node = node[part]
    if isinstance(node, bool) or not isinstance(node, (int, float)):
        raise ClaimError(f"'{dotted}' is {type(node).__name__}, not a number")
    return float(node)


def check_artifact(literal: str, ref: re.Match) -> str:
    domain, name = ref.group("domain"), ref.group("name")
    path = VALIDATION / domain / f"{name}.json"
    if not path.exists():
        raise ClaimError(f"no artifact at {path}")

    actual = TRANSFORMS[ref.group("transform") or "raw"](
        resolve_key(json.loads(path.read_text()), ref.group("key"))
    )

    candidates = literal_numbers(literal)
    if not candidates:
        raise ClaimError(f"annotation names {path} but the literal holds no number")

    # Any number in the literal may be the claim. Metric names carry digits of
    # their own ("macro F1 0.183", "R2 0.91") and a claim is often written beside
    # its sample size ("16.46% after 365 days"), so pinning the claim to a fixed
    # position in the string would reject correct annotations. Requiring one of
    # them to match is enough to catch drift, which is what this guards.
    for stated in candidates:
        # Compare at the precision the prose wrote. "0.92" and 0.9200001 agree;
        # "0.920" and 0.9195 do not. Half-up, because that is how a person rounds
        # by hand; half-even would reject 0.8865 written as 0.887.
        places = -stated.as_tuple().exponent
        quantum = Decimal(1).scaleb(-places)
        if Decimal(repr(actual)).quantize(quantum, rounding=ROUND_HALF_UP) == stated:
            return f"{path}:{ref.group('key')} = {stated}"

    shown = ", ".join(str(c) for c in candidates)
    raise ClaimError(f"says {shown}, artifact says {actual:.4g} ({path}:{ref.group('key')})")


def check_doc(literal: str, doc_path: str) -> str:
    """Assert every number in the literal appears verbatim in a generated document.

    Weaker than an artifact check by nature -- it proves the figure is present, not
    that it describes the same thing -- so it is for counts that come out of a
    generated doc (``render_fault_coverage_doc.py``) rather than out of a metric.
    """
    path = Path(doc_path)
    if not path.exists():
        raise ClaimError(f"no document at {path}")
    text = path.read_text()
    numbers = all_numbers(literal)
    if not numbers:
        raise ClaimError("doc reference needs at least one number in the literal")
    missing = [n for n in numbers if n not in text]
    if missing:
        raise ClaimError(f"{', '.join(missing)} does not appear in {path}")
    return f"{path} ({len(numbers)} figure(s))"


def check_claim(literal: str, source: str) -> str:
    """Return a human-readable provenance string, or raise ClaimError."""
    if source.startswith("not-measured"):
        reason = source.split(":", 1)[1].strip() if ":" in source else ""
        if not reason:
            raise ClaimError("not-measured needs a reason after the colon")
        return f"declared unmeasured — {reason}"
    if source.startswith("doc:"):
        return check_doc(literal, source[4:].strip().split()[0])
    ref = ARTIFACT_REF.match(source)
    if ref:
        return check_artifact(literal, ref)
    raise ClaimError(f"unparseable source '{source}'")


def annotation_block_above(lines: List[str], i: int) -> List[int]:
    """Line numbers of the contiguous annotation block ending just above line i."""
    out, j = [], i - 1
    while j >= 0 and "ACCURACY-OK:" in lines[j]:
        out.append(j)
        j -= 1
    return out


def check_file(path: Path, quiet: bool) -> Tuple[int, int, List[str]]:
    lines = path.read_text().splitlines()
    ok = fail = 0
    report: List[str] = []

    for i, line in enumerate(lines):
        for m in ANNOTATION.finditer(line):
            literal, source = m.group("literal"), m.group("source")
            try:
                where = check_claim(literal, source)
                ok += 1
                if not quiet:
                    report.append(f"    OK    {literal:<44} <- {where}")
            except ClaimError as exc:
                fail += 1
                report.append(f"    FAIL  {literal:<44} <- {exc}  [{path}:{i + 1}]")

    # Coverage: a claim-shaped line with no annotation above it or on it.
    for i, line in enumerate(lines):
        if "ACCURACY-OK:" in line or not PATTERN.search(line):
            continue
        if annotation_block_above(lines, i):
            continue
        fail += 1
        report.append(f"    FAIL  UNSOURCED number on this line          <- {path}:{i + 1}: {line.strip()[:80]}")

    return ok, fail, report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quiet", action="store_true", help="print failures only")
    args = ap.parse_args()

    if not OVERVIEWS.exists():
        print(f"no {OVERVIEWS}/ — nothing to check")
        return 0

    total_ok = total_fail = 0
    for path in sorted(OVERVIEWS.rglob("*.md")):
        ok, fail, report = check_file(path, args.quiet)
        total_ok += ok
        total_fail += fail
        if report:
            print(f"\n  {path}")
            print("\n".join(report))

    print(f"\n{total_ok} claim(s) verified against an artifact, {total_fail} failed.")
    if total_fail:
        print(
            "\nEvery number in docs/overviews/ must name where it came from:\n"
            "  <!-- ACCURACY-OK: 48.8% <- bess/severson_lgbm.eol_within_10pct_fraction pct -->\n"
            "  <!-- ACCURACY-OK: 34 fault types <- doc:docs/FAULT_COVERAGE.md -->\n"
            "  <!-- ACCURACY-OK: no measured accuracy <- not-measured: no observed failures -->\n"
        )
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
