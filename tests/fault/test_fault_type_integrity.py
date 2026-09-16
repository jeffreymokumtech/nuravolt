"""Structural guards on the FaultType enum and the detector surface.

These exist because two defect classes shipped undetected and both would have
been caught here in milliseconds:

1. ``rule_based.py`` referenced ``FaultType.STRING_DEGRADATION``,
   ``FaultType.INVERTER_FAILURE`` and ``FaultType.COOLING_DEGRADATION``, none of
   which were members. Any code path reaching those lines raised AttributeError.
2. Four members (``DC_LINK_CAPACITOR_AGING``, ``INVERTER_COOLING_DEGRADATION``,
   ``MODULE_CURRENT_DEGRADATION``, ``MODULE_VOLTAGE_DROP``) had no construction
   site anywhere, while customer-facing documents described them as live.

The second is a *documentation* hazard more than a code one, so it is reported
as an explicit allow-list rather than a hard failure: a member may legitimately
be defined ahead of its detector, but it must be declared here, which makes the
gap visible to whoever next writes a capability claim.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from nuravolt.fault.rule_based import FaultType

RULE_BASED = Path(__file__).resolve().parents[2] / "nuravolt" / "fault" / "rule_based.py"

#: Members that are defined but deliberately have no emit site yet. Every entry
#: needs a reason, and NOTHING in a customer-facing document may describe an
#: entry here as live.
KNOWN_NOT_YET_EMITTED = {
    "DC_LINK_CAPACITOR_AGING": "detector not written; emits only once the component-life model runs",
    "MODULE_CURRENT_DEGRADATION": "superseded by the planned peer-relative string deficit rule",
    "MODULE_VOLTAGE_DROP": "superseded by the planned peer-relative string voltage rule",
}


def _source() -> str:
    return RULE_BASED.read_text()


def test_every_faulttype_reference_resolves():
    """No ``FaultType.X`` in the module may name a non-member."""
    referenced = set(re.findall(r"FaultType\.([A-Z_]+)", _source()))
    members = {m.name for m in FaultType}
    dangling = sorted(referenced - members)
    assert not dangling, (
        f"rule_based.py references FaultType members that do not exist: {dangling}. "
        f"These raise AttributeError at runtime on any path that reaches them."
    )


def test_faultalert_constructions_use_real_fields():
    """Every ``FaultAlert(...)`` call must use fields that exist on the dataclass."""
    from nuravolt.fault.rule_based import FaultAlert

    valid = set(FaultAlert.__dataclass_fields__)
    tree = ast.parse(_source())
    bad: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not (isinstance(node.func, ast.Name) and node.func.id == "FaultAlert"):
            continue
        for kw in node.keywords:
            if kw.arg is not None and kw.arg not in valid:
                bad.append((node.lineno, kw.arg))
    assert not bad, (
        f"FaultAlert constructed with unknown keyword(s): {bad}. "
        f"Valid fields are {sorted(valid)}."
    )


def test_emit_sites_are_declared():
    """Members with no construction site must be on the allow-list, with a reason."""
    src = _source()
    members = {m.name for m in FaultType}
    # Count references outside the enum definition block itself.
    enum_block = re.search(r"class FaultType.*?(?=\nclass )", src, re.S).group(0)
    body = src.replace(enum_block, "")
    emitted = {name for name in members if f"FaultType.{name}" in body}

    not_emitted = members - emitted
    undeclared = sorted(not_emitted - set(KNOWN_NOT_YET_EMITTED))
    assert not undeclared, (
        f"FaultType members with no emit site and no declared reason: {undeclared}. "
        f"Add a detector, or add them to KNOWN_NOT_YET_EMITTED with a reason -- and "
        f"do not describe them as live in any document."
    )

    stale = sorted(set(KNOWN_NOT_YET_EMITTED) & emitted)
    assert not stale, (
        f"These are on the not-yet-emitted allow-list but now DO have an emit site: "
        f"{stale}. Remove them from KNOWN_NOT_YET_EMITTED and update the docs."
    )


@pytest.mark.parametrize("name", sorted(KNOWN_NOT_YET_EMITTED))
def test_allowlist_entries_are_real_members(name):
    assert name in {m.name for m in FaultType}
