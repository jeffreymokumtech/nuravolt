"""
The BESS grain boundary, asserted rather than described.

Cell grain is addressable and deliberately unbuilt: a cell id parses and
resolves, and then `silver_bess_telemetry` attributes it up to its rack and
drops its identity. Nothing below rack is modelled, published or served. The
reasoning, the vendor evidence and the confidence caveats live in
docs/BESS_GRAIN_POLICY.md.

These tests exist because the boundary is invisible in any single file. Adding a
`gold_bess_cell_daily.sql`, or a `bess_voltage_cell_7` enum member, is a small
and locally sensible edit that quietly reverses a decision. Every assertion
below carries a message naming the decision and pointing at the policy, so a
failure explains itself instead of looking like a bug.
"""

import csv
import re
from pathlib import Path

from nuravolt.bess.imbalance import MEMBER_KIND_EXTREME
from nuravolt.bess.rack_samples import EXTREME_MEMBERS
from nuravolt.lake.export_dim import build_bess_device_id, parse_bess_device_id

REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY = "docs/BESS_GRAIN_POLICY.md"

SILVER_SQL = REPO_ROOT / "dbt_project" / "models" / "silver" / "silver_bess_telemetry.sql"
SEED_CSV = REPO_ROOT / "dbt_project" / "seeds" / "bess_metric_alias.csv"
PRISMA_SCHEMA = REPO_ROOT / "prisma" / "schema.prisma"

#: A metric name carrying a device index. Identity belongs in device_ext_id; a
#: metric name that carries it multiplies the DataFieldType enum by the cell
#: count instead of adding one member.
IDENTITY_IN_METRIC_NAME = re.compile(r"_(cell|module|rack)_\d+")


def _data_field_type_members():
    """The DataFieldType enum members, read out of the Prisma schema."""
    text = PRISMA_SCHEMA.read_text()
    start = text.index("enum DataFieldType {")
    body = text[start + len("enum DataFieldType {") : text.index("}", start)]
    members = []
    for line in body.splitlines():
        line = line.split("//", 1)[0].strip()
        if line:
            members.append(line)
    return members


def _seed_rows():
    with SEED_CSV.open(newline="") as handle:
        return list(csv.DictReader(handle))


def test_cell_id_parses_and_its_rack_prefix_rebuilds():
    """A cell id is addressable, and its rack is recoverable from the parse.

    This is the half of the policy that is NOT a refusal: the convention goes
    all the way down, so an on-premises collector on the local bus would need a
    new gold model, not a redesign of the id space.
    """
    cell_id = "BESS athi-1.U-1.R-3.M-2.C-7"
    parsed = parse_bess_device_id(cell_id)

    assert parsed is not None, (
        f"{cell_id!r} must parse: cell grain is addressable by design, only "
        f"unbuilt downstream. See {POLICY}."
    )
    assert parsed["grain"] == "cell", (
        f"{cell_id!r} must parse to grain 'cell', got {parsed['grain']!r}. The "
        f"five-level convention is deliberate. See {POLICY}."
    )

    rack_id = build_bess_device_id(parsed["asset"], parsed["unit"], parsed["rack"])
    assert rack_id == "BESS athi-1.U-1.R-3", (
        f"a cell's rack must rebuild exactly from its parsed parts, got "
        f"{rack_id!r}. silver_bess_telemetry attributes every sub-rack row to "
        f"this id, so a mismatch mis-attributes telemetry. See {POLICY}."
    )
    assert cell_id.startswith(rack_id + "."), (
        f"{rack_id!r} must be a literal prefix of {cell_id!r}: the asset token "
        f"cannot contain a '.', which is what makes the reconstruction exact "
        f"rather than a guess. See {POLICY}."
    )


def test_silver_attributes_to_rack_and_builds_no_deeper_id():
    """Silver stops at rack. Deeper rows are attributed, never re-identified."""
    sql = SILVER_SQL.read_text()

    assert "rack_device_id" in sql, (
        f"silver_bess_telemetry must build rack_device_id: it is the grain the "
        f"whole imbalance chain keys on. See {POLICY}."
    )
    for forbidden in ("module_device_id", "cell_device_id"):
        assert forbidden not in sql, (
            f"silver_bess_telemetry must NOT build {forbidden}: cell and module "
            f"grain are addressable but deliberately unbuilt downstream, and a "
            f"column nothing consumes becomes a column somebody trusts. "
            f"See {POLICY}."
        )


def test_no_gold_model_below_rack_grain():
    """No per-cell or per-module gold. Rack is the floor of the serving stack."""
    offenders = [
        str(path.relative_to(REPO_ROOT))
        for path in REPO_ROOT.rglob("gold_bess_*_daily.sql")
        if re.fullmatch(r"gold_bess_(cell|module)_daily\.sql", path.name)
    ]
    assert not offenders, (
        f"found gold below rack grain: {offenders}. Per-cell buys culprit "
        f"localisation and distribution shape, not detection, and the vendor "
        f"clouds do not carry the data. This is a decision, not a gap. "
        f"See {POLICY}."
    )


def test_identity_never_lives_in_a_metric_name():
    """A device index in a metric name blows the enum up combinatorially."""
    offenders = [
        member
        for member in _data_field_type_members()
        if IDENTITY_IN_METRIC_NAME.search(member)
    ]
    assert not offenders, (
        f"DataFieldType members carry a device index: {offenders}. Identity "
        f"lives in device_ext_id, never in the metric name, or the enum "
        f"multiplies by the cell count instead of gaining one member. "
        f"See {POLICY}."
    )

    seed_offenders = sorted(
        {
            value
            for row in _seed_rows()
            for value in (row["raw_metric"], row["canonical_metric"])
            if IDENTITY_IN_METRIC_NAME.search(value or "")
        }
    )
    assert not seed_offenders, (
        f"bess_metric_alias seeds a metric name carrying a device index: "
        f"{seed_offenders}. The alias seed is the easiest place to smuggle one "
        f"in, because it needs no code deploy. See {POLICY}."
    )


def test_cell_extremes_are_seeded_and_read_as_extreme_members():
    """The extremes ARE the imbalance signal, so the chain must be unbroken."""
    rows = _seed_rows()
    identity = {
        row["raw_metric"]
        for row in rows
        if row["raw_metric"] == row["canonical_metric"]
    }

    for metric in ("bess_voltage_cell_max", "bess_voltage_cell_min"):
        assert metric in identity, (
            f"{metric} must be an identity row in bess_metric_alias, otherwise "
            f"silver drops it and the rack spread has no basis at all. ΔV from "
            f"the two edges is the primary imbalance indicator and is exact, "
            f"not an approximation. See {POLICY}."
        )
        assert metric in EXTREME_MEMBERS, (
            f"{metric} must map to an extreme member in "
            f"nuravolt/bess/rack_samples.py, or a rack reporting only its edges "
            f"produces no spread. See {POLICY}."
        )

    max_member, max_field = EXTREME_MEMBERS["bess_voltage_cell_max"]
    min_member, min_field = EXTREME_MEMBERS["bess_voltage_cell_min"]
    assert max_field == min_field == "voltage_v", (
        f"the cell voltage extremes must land on the same DeviceSample field, "
        f"got {max_field!r} and {min_field!r}: max minus min over two members "
        f"is only ΔV if both are the same quantity. See {POLICY}."
    )
    assert max_member != min_member, (
        f"the cell voltage extremes must be two distinct members, got "
        f"{max_member!r} twice: one member is not a spread. See {POLICY}."
    )
    assert MEMBER_KIND_EXTREME == "extreme", (
        f"MEMBER_KIND_EXTREME is {MEMBER_KIND_EXTREME!r}. The label is what "
        f"stops a rack holding several hundred cells and reporting two of them "
        f"from presenting as '2 modules reporting'. See {POLICY}."
    )
