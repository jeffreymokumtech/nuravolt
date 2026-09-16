"""The device dim is the only thing that makes the lake mean anything.

Bronze carries vendor strings: ``plant_ext_id``, ``device_ext_id``, and nothing
else. Which plant, which battery, which currency lives only in Postgres. These
tests pin two properties of the export:

  1. the canonical BESS id parser matches ``src/lib/services/cloud-connector.ts``
     character for character, including the malformed cases it refuses. A Python
     reader and a TypeScript writer that disagree about what ``BESS x.R-2`` means
     would attribute telemetry to a device nobody can find again;
  2. resolution is honest. A connection serving several plants, none of which
     claims the vendor id, yields ``plant_id = NULL`` and ``resolution =
     unresolved`` — never a plausible guess.

No database: ``build_dim_rows`` is pure and takes the four query results.
"""

import sys
from pathlib import Path

import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.lake.export_dim import (  # noqa: E402
    build_bess_device_id,
    build_dim_rows,
    is_bess_device_id,
    parse_bess_device_id,
    sanitize_bess_asset_token,
    write_snapshot,
)

DAY = "2026-07-20"
CONN = "conn-1"
PLANT_ID = "11111111-1111-1111-1111-111111111111"


# ---------------------------------------------------------------------------
# Canonical id parity with cloud-connector.ts
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "device_id,expected",
    [
        ("BESS athi-1", ("athi-1", None, None, None, None, "asset")),
        ("BESS athi-1.U-0", ("athi-1", 0, None, None, None, "unit")),
        ("BESS athi-1.U-0.R-3", ("athi-1", 0, 3, None, None, "rack")),
        ("BESS athi-1.U-1.R-3.M-12", ("athi-1", 1, 3, 12, None, "module")),
        ("BESS athi-1.U-1.R-3.M-12.C-7", ("athi-1", 1, 3, 12, 7, "cell")),
    ],
)
def test_parses_every_grain(device_id, expected):
    parsed = parse_bess_device_id(device_id)
    assert parsed is not None
    assert (
        parsed["asset"], parsed["unit"], parsed["rack"],
        parsed["module"], parsed["cell"], parsed["grain"],
    ) == expected


@pytest.mark.parametrize(
    "device_id",
    [
        "BESS athi-1.R-3",          # rack without its unit
        "BESS athi-1.U-0.M-2",      # module without its rack
        "BESS athi-1.U-0.R-1.C-4",  # cell without its module
        "BESS PLANT",               # PLANT is reserved for plant rollups
        "BESS ",                    # empty asset token
        "INV 01.032.MPPT-1",        # a PV id, not a BESS id
        "athi-1.U-0",               # missing the prefix
        "",
        None,
    ],
)
def test_refuses_malformed_ids(device_id):
    assert parse_bess_device_id(device_id) is None
    assert is_bess_device_id(device_id) is False


def test_build_round_trips_through_parse():
    device_id = build_bess_device_id("athi 1", unit=2, rack=5, module=9)
    assert device_id == "BESS athi 1.U-2.R-5.M-9"
    parsed = parse_bess_device_id(device_id)
    assert (parsed["asset"], parsed["unit"], parsed["rack"], parsed["module"]) == (
        "athi 1", 2, 5, 9,
    )


def test_build_refuses_a_gap_in_the_hierarchy():
    with pytest.raises(ValueError, match="gap"):
        build_bess_device_id("athi-1", rack=3)


def test_build_refuses_the_reserved_plant_token():
    with pytest.raises(ValueError, match="PLANT"):
        build_bess_device_id("PLANT")


def test_sanitize_matches_the_typescript_rules():
    assert sanitize_bess_asset_token("athi.1") == "athi-1"
    assert sanitize_bess_asset_token("  athi   1  ") == "athi 1"
    assert sanitize_bess_asset_token(None) == ""


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def plant(pid=PLANT_ID, slug="athi-storage", conn=CONN, ext="PLANT-A"):
    return {
        "id": pid,
        "slug": slug,
        "country": "KE",
        "currency": "KES",
        "asset_type": "BESS",
        "promoted_connection_id": conn,
        "promoted_plant_ext_id": ext,
    }


def device(device_ext_id, ext="PLANT-A", conn=CONN, device_type="battery"):
    return {
        "connection_id": conn,
        "plant_ext_id": ext,
        "device_ext_id": device_ext_id,
        "device_type": device_type,
    }


def bess_asset(aid="asset-1", pid=PLANT_ID, external="athi-1", name="Athi 1"):
    return {
        "id": aid,
        "plant_id": pid,
        "external_asset_id": external,
        "name": name,
        "chemistry": "LFP",
        "nominal_capacity_kwh": 200000,
        "nominal_power_kw": 50000,
        "rack_count": 12,
        "module_count": 240,
    }


def test_promoted_plant_resolves_exactly():
    rows = build_dim_rows(DAY, [plant()], [], [device("BESS athi-1.U-0.R-2")], [bess_asset()])

    assert len(rows) == 1
    row = rows[0]
    assert row["resolution"] == "promoted_from"
    assert row["plant_id"] == PLANT_ID
    assert row["plant_slug"] == "athi-storage"
    assert row["country"] == "KE"
    assert row["currency"] == "KES"
    assert row["device_grain"] == "rack"
    assert row["rack_no"] == 2
    assert row["bess_asset_id"] == "asset-1"
    assert row["asset_match"] == "external_id"
    assert row["nominal_capacity_kwh"] == 200000
    assert row["dt"] == DAY


def test_sole_data_source_plant_resolves_by_elimination():
    unpromoted = plant(conn=None, ext=None)
    rows = build_dim_rows(
        DAY,
        [unpromoted],
        [{"plant_id": PLANT_ID, "connection_id": CONN}],
        [device("BESS athi-1")],
        [bess_asset()],
    )

    assert rows[0]["resolution"] == "data_source_sole"
    assert rows[0]["plant_id"] == PLANT_ID


def test_ambiguous_connection_stays_unresolved():
    """Two plants on one connection and no promotion stamp: refuse to guess."""
    a = plant(pid="p-a", slug="a", conn=None, ext=None)
    b = plant(pid="p-b", slug="b", conn=None, ext=None)
    rows = build_dim_rows(
        DAY,
        [a, b],
        [{"plant_id": "p-a", "connection_id": CONN}, {"plant_id": "p-b", "connection_id": CONN}],
        [device("BESS athi-1")],
        [],
    )

    assert rows[0]["resolution"] == "unresolved"
    assert rows[0]["plant_id"] is None
    assert rows[0]["plant_slug"] is None
    assert rows[0]["bess_asset_id"] is None


def test_promotion_wins_over_a_sole_data_source():
    right = plant(pid="p-right", slug="right", conn=CONN, ext="PLANT-A")
    wrong = plant(pid="p-wrong", slug="wrong", conn=None, ext=None)
    rows = build_dim_rows(
        DAY,
        [right, wrong],
        [{"plant_id": "p-wrong", "connection_id": CONN}],
        [device("BESS athi-1", ext="PLANT-A")],
        [],
    )

    assert rows[0]["plant_id"] == "p-right"
    assert rows[0]["resolution"] == "promoted_from"


def test_non_bess_devices_carry_no_canonical_id():
    rows = build_dim_rows(
        DAY, [plant()], [], [device("INV 01.032", device_type="string_inverter")], [bess_asset()]
    )

    row = rows[0]
    assert row["canonical_device_id"] is None
    assert row["device_grain"] is None
    assert row["bess_asset_id"] is None
    assert row["asset_match"] == "none"
    assert row["plant_id"] == PLANT_ID  # the plant still resolves


def test_asset_match_by_name_is_labelled_as_such():
    """Two assets, so a match can only come from the name, not from elimination."""
    rows = build_dim_rows(
        DAY, [plant()], [], [device("BESS Athi 1")],
        [
            bess_asset(aid="a1", external="ATH-0001", name="Athi 1"),
            bess_asset(aid="a2", external="ATH-0002", name="Athi 2"),
        ],
    )

    assert rows[0]["bess_asset_id"] == "a1"
    assert rows[0]["asset_match"] == "name"


def test_external_id_match_beats_a_name_match():
    rows = build_dim_rows(
        DAY, [plant()], [], [device("BESS ATH-0002")],
        [
            bess_asset(aid="a1", external="ATH-0001", name="ATH-0002"),
            bess_asset(aid="a2", external="ATH-0002", name="Athi 2"),
        ],
    )

    assert rows[0]["bess_asset_id"] == "a2"
    assert rows[0]["asset_match"] == "external_id"


def test_sole_asset_match_is_labelled_separately():
    rows = build_dim_rows(
        DAY, [plant()], [], [device("BESS unknown-token")],
        [bess_asset(external="ATH-0001", name="Athi 1")],
    )

    assert rows[0]["bess_asset_id"] == "asset-1"
    assert rows[0]["asset_match"] == "sole_asset"


def test_two_assets_and_an_unknown_token_matches_nothing():
    rows = build_dim_rows(
        DAY, [plant()], [], [device("BESS unknown-token")],
        [bess_asset(aid="a1", external="ATH-1"), bess_asset(aid="a2", external="ATH-2")],
    )

    assert rows[0]["bess_asset_id"] is None
    assert rows[0]["asset_match"] == "none"


def test_devices_without_a_connection_are_dropped():
    rows = build_dim_rows(DAY, [plant()], [], [device("BESS athi-1", conn=None)], [])
    assert rows == []


# ---------------------------------------------------------------------------
# Snapshot file
# ---------------------------------------------------------------------------


def test_snapshot_is_written_hive_partitioned_and_self_describing(tmp_path):
    rows = build_dim_rows(DAY, [plant()], [], [device("BESS athi-1.U-0")], [bess_asset()])

    key = write_snapshot(rows, DAY, str(tmp_path / "device_map"))

    assert key.endswith(f"dt={DAY}/part-0.parquet")
    table = pq.ParquetFile(key).read()
    assert {str(v) for v in table.column("dt").to_pylist()} == {DAY}
    assert table.column("plant_slug").to_pylist() == ["athi-storage"]
    assert "resolution" in table.column_names
