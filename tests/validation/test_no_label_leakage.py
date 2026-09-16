"""No predictor may return its own label more often than chance.

This test exists because the same defect shipped twice, in two files, and both
times it inflated a published figure that reached a customer document.

**Remaining-useful-life models.** The training label was a closed-form invertible
function of one of each model's own input columns. The arithmetic tell was exact:
for `insulation`, max_days=90 gives injected noise sigma 9.0, so a perfect
inverter of that function scores MAE = 9*sqrt(2/pi) = 7.18. The reported MAE was
7.18. Four models were withdrawn.

**Battery end-of-life baseline.** `scripts/validate_bess_rul.py` returned
`len(capacity)` on six failure paths. For a cell run to end of life that IS the
label. On NASA, 7 of 13 cells returned it exactly; on Severson, 4 of 4 of the
cells counted "within 10%" were label returns, so the baseline's entire apparent
skill was leakage and its true score was zero.

A published comparison against our own model was therefore flattering the
baseline with our own ground truth, which made our model look worse than it is.

The check is cheap and it generalises: for any artifact carrying (actual,
predicted) pairs, an exact tie is either a coincidence or a leak, and too many
exact ties is a leak.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

import pytest

VALIDATION = Path(__file__).resolve().parents[2] / "public" / "data" / "validation"

#: Above this share of exact ties we treat the predictor as reading its label.
#: Genuine ties happen: integer cycle counts collide. A quarter is generous.
MAX_EXACT_TIE_FRACTION = 0.25


def _artifacts_with_predictions() -> List[tuple]:
    out = []
    for path in sorted(VALIDATION.rglob("*.json")):
        if path.name == "summary.json":
            continue
        try:
            doc = json.loads(path.read_text())
        except Exception:
            continue
        preds = doc.get("predictions")
        if not isinstance(preds, list) or not preds:
            continue
        pairs = [
            (p["actual_eol"], p["predicted_eol"])
            for p in preds
            if isinstance(p, dict)
            and p.get("actual_eol") is not None
            and p.get("predicted_eol") is not None
        ]
        if pairs:
            out.append((path.relative_to(VALIDATION).as_posix(), pairs))
    return out


def test_there_is_something_to_check():
    """Guard the guard: a passing suite must not be an empty one."""
    found = _artifacts_with_predictions()
    assert found, (
        f"no artifact under {VALIDATION} exposes (actual, predicted) pairs. "
        f"This test would pass vacuously, which is how the original defect "
        f"survived. Either the artifacts moved or the key names changed."
    )


@pytest.mark.parametrize("name,pairs", _artifacts_with_predictions(),
                         ids=lambda v: v if isinstance(v, str) else "")
def test_predictor_does_not_return_its_label(name, pairs):
    exact = sum(1 for a, p in pairs if a == p)
    fraction = exact / len(pairs)
    assert fraction <= MAX_EXACT_TIE_FRACTION, (
        f"{name}: {exact}/{len(pairs)} predictions ({fraction:.0%}) exactly equal "
        f"their label. That is the signature of a predictor reading the answer on "
        f"a failure path, which is what `return len(capacity)` did in "
        f"scripts/validate_bess_rul.py. Make the predictor abstain instead, and "
        f"count the abstentions."
    )


@pytest.mark.parametrize("name,pairs", _artifacts_with_predictions(),
                         ids=lambda v: v if isinstance(v, str) else "")
def test_success_is_not_mostly_exact_ties(name, pairs):
    """A weaker leak: few ties overall, but they carry the headline.

    On Severson the baseline had 4 exact ties out of 124 cells, which is only 3%
    and passes the test above. But all 4 were the entire set of cells counted
    "within 10%", so 100% of its reported skill was leakage.
    """
    within10 = [(a, p) for a, p in pairs if a and abs(p - a) / a <= 0.10]
    if len(within10) < 3:
        pytest.skip("too few successes to assess")
    exact = sum(1 for a, p in within10 if a == p)
    fraction = exact / len(within10)
    assert fraction <= 0.5, (
        f"{name}: {exact}/{len(within10)} of the predictions counted 'within 10%' "
        f"are exact label returns ({fraction:.0%}). The headline is carried by "
        f"leakage even though the overall tie rate looks acceptable."
    )
