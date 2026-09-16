"""The client-facing overviews may not carry a number no artifact supports.

`docs/overviews/` is what goes to a prospect. Every figure in it is annotated with
the artifact it came from, and `scripts/check_overview_numbers.py` resolves each
annotation against `public/data/validation/`. This pins that guard so a validation
re-run that moves a number breaks the build rather than quietly leaving a stale
figure in a document someone is about to email.

The catalog PDF headlining "99.8% of PV faults correctly classified" is the failure
this prevents: a real number, from a real artifact, describing a model nobody ships.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
CHECKER = REPO / "scripts" / "check_overview_numbers.py"
OVERVIEWS = REPO / "docs" / "overviews"


def run_checker(cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CHECKER), "--quiet"],
        cwd=cwd, capture_output=True, text=True,
    )


def test_every_published_overview_number_resolves():
    result = run_checker(REPO)
    assert result.returncode == 0, (
        "docs/overviews/ carries a number that does not match its artifact:\n"
        f"{result.stdout}{result.stderr}"
    )


def test_the_checker_catches_a_drifted_number(tmp_path):
    """A number that no longer matches its artifact must fail, not pass quietly."""
    sandbox = tmp_path / "repo"
    (sandbox / "docs" / "overviews").mkdir(parents=True)
    (sandbox / "public" / "data" / "validation" / "bess").mkdir(parents=True)
    (sandbox / "public" / "data" / "validation" / "bess" / "demo.json").write_text(
        json.dumps({"eol_within_10pct_fraction": 0.488})
    )
    (sandbox / "docs" / "overviews" / "drift.md").write_text(
        "<!-- ACCURACY-OK: 99.9% <- bess/demo.eol_within_10pct_fraction pct -->\n"
        "Our accuracy is 99.9%.\n"
    )
    result = run_checker(sandbox)
    assert result.returncode == 1
    assert "99.9" in result.stdout and "48.8" in result.stdout


def test_the_checker_catches_an_unannotated_number(tmp_path):
    """Coverage is the half that matters: a bare claim must not slip through."""
    sandbox = tmp_path / "repo"
    (sandbox / "docs" / "overviews").mkdir(parents=True)
    (sandbox / "public" / "data" / "validation").mkdir(parents=True)
    (sandbox / "docs" / "overviews" / "bare.md").write_text(
        "We reach a detection accuracy of 97%.\n"
    )
    result = run_checker(sandbox)
    assert result.returncode == 1
    assert "UNSOURCED" in result.stdout


def test_a_metric_name_digit_is_not_read_as_the_claim(tmp_path):
    """"F1 0.983" must verify against 0.983, never against the 1 in "F1".

    Rounding 0.983 to zero decimal places gives 1, so a parser that treats every
    digit in the literal as a candidate reports OK while checking nothing. This is
    a real bug that was live in this checker for one iteration.
    """
    sandbox = tmp_path / "repo"
    (sandbox / "docs" / "overviews").mkdir(parents=True)
    (sandbox / "public" / "data" / "validation" / "pv").mkdir(parents=True)
    (sandbox / "public" / "data" / "validation" / "pv" / "demo.json").write_text(
        json.dumps({"f1": 0.983})
    )
    (sandbox / "docs" / "overviews" / "wrong.md").write_text(
        "<!-- ACCURACY-OK: F1 0.111 <- pv/demo.f1 -->\n"
        "Its F1 accuracy is 0.111.\n"
    )
    result = run_checker(sandbox)
    assert result.returncode == 1, (
        "a wrong F1 verified anyway, which means the '1' in 'F1' was read as the claim:\n"
        f"{result.stdout}"
    )


@pytest.mark.parametrize("name", [
    "01-soiling", "02-fault-detection", "03-inverter-health-rul",
    "04-battery-bess", "05-digital-twin", "06-forecasting-and-data-quality",
    "NuraVolt-Model-Overview",
])
def test_each_overview_states_what_it_does_not_claim(name):
    """Every overview carries its limits. A page with only good news is a red flag."""
    text = (OVERVIEWS / f"{name}.md").read_text().lower()
    assert "do not claim" in text or "not measured" in text or "no measured" in text


def test_the_pdf_renderer_strips_source_annotations():
    """A rendered overview must not print its own provenance comments.

    markdown-it with ``html=False`` *escapes* raw HTML rather than dropping it, so
    an un-stripped ``<!-- ACCURACY-OK: ... -->`` renders verbatim. That shipped
    once: a battery one-pager went out with every table row preceded by its own
    source annotation in the body text.
    """
    sys.path.insert(0, str(REPO / "scripts"))
    from render_sales_pdf import COMMENT

    source = "<!-- ACCURACY-OK: 48.8% <- bess/x.y pct -->\nOur model reaches 48.8%.\n"
    assert "ACCURACY-OK" not in COMMENT.sub("", source)
    assert "Our model reaches 48.8%." in COMMENT.sub("", source)
