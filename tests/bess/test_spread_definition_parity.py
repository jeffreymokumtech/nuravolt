"""
One definition of spread, proved on one fixture, in both engines.

Two implementations of "rack spread" existed and disagreed. nuravolt/bess/
imbalance.py computed the instantaneous spread and took the worst over the
window; dbt_project/models/gold/gold_bess_rack_daily.sql computed the day
envelope. They published under the SAME column names, `voltage_spread_v` and
`temp_spread_c`, which is precisely why nobody noticed: the two numbers are
different quantities and the envelope is systematically larger.

This test does three things, and the second is the point:

  1. asserts the warehouse's instantaneous number equals the Python one, per
     rack, to 1e-9 -- one definition, two engines, same answer;
  2. asserts the envelope EXCEEDS the instantaneous number on at least one rack,
     which is the proof that they were never the same number and that sharing a
     name was the bug. The fixture is built so the gap is a factor of nine;
  3. asserts SPREAD_DEFINITION appears verbatim in the model and in its
     schema.yml, so editing the constant without editing the SQL fails here
     rather than in a customer's safety report.

The SQL is READ OUT OF THE MODEL FILE and its dbt macros substituted, never
copied, so this test cannot drift away from the model it claims to check.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path

import pytest

duckdb = pytest.importorskip("duckdb")

from nuravolt.bess.imbalance import (  # noqa: E402
    SIBLING_CENTRE,
    SPREAD_DEFINITION,
    analyze_imbalance,
)
from nuravolt.bess.rack_samples import rack_samples_from_silver  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
MODEL_PATH = REPO / "dbt_project" / "models" / "gold" / "gold_bess_rack_daily.sql"
SCHEMA_PATH = REPO / "dbt_project" / "models" / "gold" / "schema.yml"

PLANT_ID = "11111111-1111-1111-1111-111111111111"
ASSET_ID = "22222222-2222-2222-2222-222222222222"
ASSET_TOKEN = "PARITY-1"
DAY = datetime(2026, 7, 1)
CADENCE = timedelta(minutes=5)
INSTANTS = 20

#: Racks 1 to 4 report the two edges a BMS streams; rack 5 reports real cell
#: children. Both bases have to survive the same definition.
EXTREME_RACKS = (1, 2, 3, 4)
CHILD_RACK = 5
CHILD_CELLS = 3

#: Rack-level offsets so no two racks are identical.
TEMP_RACK_OFFSET = {1: 0.0, 2: 0.1, 3: 0.2, 4: 0.3}
#: Each rack's steady cell-to-cell voltage spread, in V.
VOLTAGE_BASE_GAP = {1: 0.0100, 2: 0.0120, 3: 0.0140, 4: 0.0400}
#: One instant per rack where that spread widens, so max, p95 and mean differ.
VOLTAGE_EXCURSION = 0.0200
#: SoC offset per rack, in percentage points. Rack 5 also drifts away over the
#: day, so its worst divergence sits at a single unambiguous instant.
SOC_RACK_OFFSET = {1: 0.0, 2: 0.4, 3: -0.3, 4: 0.8, 5: -1.5}
SOC_DRIFT_PER_INSTANT = -0.1


def _rack_id(rack_no: int) -> str:
    return f"BESS {ASSET_TOKEN}.U-1.R-{rack_no}"


def _row(rack_no, ts, metric, value, *, grain="rack", device=None):
    """One silver_bess_telemetry row, in the columns both engines read."""
    rack = _rack_id(rack_no)
    return {
        "plant_id": PLANT_ID,
        "plant_slug": "parity-plant",
        "bess_asset_id": ASSET_ID,
        "rack_device_id": rack,
        "unit_no": 1,
        "rack_no": rack_no,
        "day": ts.date(),
        "ts": ts,
        "canonical_device_id": device or rack,
        "device_grain": grain,
        "metric": metric,
        "value_canonical": value,
    }


def _fixture_rows():
    """
    540 silver rows over one day: 5 racks x 20 instants.

    The extremes are DELIBERATELY NON-COINCIDENT. Every rack's pack swings
    (a sawtooth twice over the window, which is what a cycling battery does)
    while the separation inside the rack stays narrow, so:

        instantaneous  max over t of (max member - min member)  = 0.5 C
        envelope       max over everything - min over everything = 4.5 C

    A factor of nine between two numbers that used to share a column name.

    Timestamps sit exactly on five minute boundaries so imbalance.py's cadence
    snapping is the identity here and cannot be confused with a parity failure.
    That is a property of this fixture, not a claim about real feeds.
    """
    rows = []
    for i in range(INSTANTS):
        ts = DAY + i * CADENCE
        # Sawtooth: 0.0 -> 4.0 -> 0.0 -> 4.0 over the window.
        swing = 0.5 * (i % 9)

        for rack_no in EXTREME_RACKS:
            t_min = 20.0 + swing + TEMP_RACK_OFFSET[rack_no]
            rows.append(_row(rack_no, ts, "bess_temp_cell_min", t_min))
            rows.append(_row(rack_no, ts, "bess_temp_cell_max", t_min + 0.5))

            v_min = 3.2000 + 0.0100 * (i % 9)
            gap = VOLTAGE_BASE_GAP[rack_no]
            if i == 3 + rack_no:
                gap += VOLTAGE_EXCURSION
            rows.append(_row(rack_no, ts, "bess_voltage_cell_min", v_min))
            rows.append(_row(rack_no, ts, "bess_voltage_cell_max", v_min + gap))

        # The rack that streams real children: three cells, one of which takes
        # a single-instant excursion.
        for cell in range(1, CHILD_CELLS + 1):
            device = f"{_rack_id(CHILD_RACK)}.M-1.C-{cell}"
            t_offset = {1: 0.0, 2: 0.20, 3: 0.35}[cell]
            v_offset = {1: 0.0, 2: 0.0050, 3: 0.0090}[cell]
            if cell == 3 and i == 7:
                v_offset += 0.0060
            rows.append(
                _row(
                    CHILD_RACK, ts, "bess_temp_cell", 20.0 + swing + t_offset,
                    grain="cell", device=device,
                )
            )
            rows.append(
                _row(
                    CHILD_RACK, ts, "bess_voltage_cell", 3.2500 + 0.0100 * (i % 9) + v_offset,
                    grain="cell", device=device,
                )
            )

        for rack_no in (*EXTREME_RACKS, CHILD_RACK):
            soc = 50.0 + 0.5 * i + SOC_RACK_OFFSET[rack_no]
            if rack_no == CHILD_RACK:
                soc += SOC_DRIFT_PER_INSTANT * i
            rows.append(_row(rack_no, ts, "bess_soc_rack", soc))

    return rows


def _render_model_sql() -> str:
    """
    The model's own SQL with its dbt macros substituted.

    Read from disk on purpose. A copy of the SQL in this file would let the
    model and the test that proves the model drift apart, which is the same
    class of failure this whole test exists to close.
    """
    sql = MODEL_PATH.read_text()

    # The config block is dbt materialization, not logic: it says where the
    # Parquet lands, which an in-memory fixture has no use for.
    start = sql.index("{{ config(")
    end = sql.index(") }}", start) + len(") }}")
    sql = sql[:start] + sql[end:]

    sql = sql.replace("{{ ref('silver_bess_telemetry') }}", "silver_bess_telemetry")

    leftover = re.findall(r"\{\{.*?\}\}", sql, flags=re.S)
    assert not leftover, (
        "gold_bess_rack_daily.sql grew a dbt macro this test does not "
        f"substitute: {leftover}. Teach _render_model_sql about it rather than "
        "letting the parity test silently run different SQL from the model."
    )
    return sql


def _load(rows):
    """Fixture rows into DuckDB in the silver column shape."""
    con = duckdb.connect()
    con.execute(
        """
        create table silver_bess_telemetry (
            plant_id            varchar,
            plant_slug          varchar,
            bess_asset_id       varchar,
            rack_device_id      varchar,
            unit_no             integer,
            rack_no             integer,
            day                 date,
            ts                  timestamp,
            canonical_device_id varchar,
            device_grain        varchar,
            metric              varchar,
            value_canonical     double
        )
        """
    )
    con.executemany(
        "insert into silver_bess_telemetry values (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                r["plant_id"], r["plant_slug"], r["bess_asset_id"], r["rack_device_id"],
                r["unit_no"], r["rack_no"], r["day"], r["ts"], r["canonical_device_id"],
                r["device_grain"], r["metric"], r["value_canonical"],
            )
            for r in rows
        ],
    )
    return con


@pytest.fixture(scope="module")
def both_engines():
    """The same rows through the warehouse and through imbalance.py."""
    rows = _fixture_rows()

    con = _load(rows)
    cursor = con.execute(_render_model_sql())
    columns = [d[0] for d in cursor.description]
    gold = {r[columns.index("device_id")]: dict(zip(columns, r)) for r in cursor.fetchall()}

    samples, diagnostics = rack_samples_from_silver(rows)
    report = analyze_imbalance(ASSET_ID, samples)
    python = {r.rack_id: r for r in report.racks}

    return {
        "rows": rows,
        "columns": columns,
        "gold": gold,
        "python": python,
        "report": report,
        "diagnostics": diagnostics,
    }


def test_fixture_reaches_both_engines(both_engines):
    """Guard: a fixture that silently reached neither engine proves nothing."""
    assert len(both_engines["rows"]) == 540
    assert set(both_engines["gold"]) == {_rack_id(k) for k in (1, 2, 3, 4, 5)}
    assert set(both_engines["python"]) == set(both_engines["gold"])
    assert both_engines["diagnostics"]["racks"] == 5
    assert both_engines["report"].alignment_seconds == 300


def test_bare_spread_names_are_gone(both_engines):
    """
    `voltage_spread_v` and `temp_spread_c` are imbalance.py's names for the
    instantaneous number. The model must never publish the envelope under them
    again, which is how the two definitions drifted apart unnoticed.
    """
    columns = set(both_engines["columns"])
    assert "voltage_spread_v" not in columns
    assert "temp_spread_c" not in columns
    assert {"voltage_spread_max_v", "temp_spread_max_c"} <= columns
    assert {"voltage_spread_envelope_v", "temp_spread_envelope_c"} <= columns


@pytest.mark.parametrize("rack_no", (1, 2, 3, 4, 5))
def test_instantaneous_spread_matches_imbalance_py(both_engines, rack_no):
    """
    The warehouse number IS the Python number. One definition, two engines.
    """
    rack = _rack_id(rack_no)
    sql = both_engines["gold"][rack]
    py = both_engines["python"][rack]

    assert py.voltage_spread_v is not None
    assert py.temperature_spread_c is not None

    assert sql["voltage_spread_max_v"] == pytest.approx(py.voltage_spread_v, abs=1e-9)
    assert sql["temp_spread_max_c"] == pytest.approx(py.temperature_spread_c, abs=1e-9)


@pytest.mark.parametrize("rack_no", (1, 2, 3, 4, 5))
def test_envelope_is_a_different_number(both_engines, rack_no):
    """
    The envelope over reads, always in the same direction, and the fixture makes
    the gap large. If these ever came out equal for every rack, this fixture
    would have stopped discriminating and test_instantaneous_spread_matches
    would be proving nothing.
    """
    sql = both_engines["gold"][_rack_id(rack_no)]

    # Containment: an instantaneous spread is a max over pairs the envelope also
    # spans, so it can never exceed it.
    assert sql["temp_spread_max_c"] <= sql["temp_spread_envelope_c"] + 1e-9
    assert sql["voltage_spread_max_v"] <= sql["voltage_spread_envelope_v"] + 1e-9

    # And on this fixture it is strictly smaller, on every rack and both metrics.
    assert sql["temp_spread_max_c"] < sql["temp_spread_envelope_c"]
    assert sql["voltage_spread_max_v"] < sql["voltage_spread_envelope_v"]


def test_envelope_over_reads_by_a_factor_of_nine(both_engines):
    """
    The discriminating case, stated as numbers rather than as an inequality:
    a rack whose cells sit 0.5 C apart all day, inside a pack that swings 4 C,
    reads as 4.5 C of imbalance under the envelope. Nine times the truth.
    """
    sql = both_engines["gold"][_rack_id(1)]
    py = both_engines["python"][_rack_id(1)]

    assert sql["temp_spread_max_c"] == pytest.approx(0.5, abs=1e-9)
    assert py.temperature_spread_c == pytest.approx(0.5, abs=1e-9)
    assert sql["temp_spread_envelope_c"] == pytest.approx(4.5, abs=1e-9)
    assert sql["temp_spread_envelope_c"] / sql["temp_spread_max_c"] == pytest.approx(9.0, abs=1e-9)


@pytest.mark.parametrize("rack_no", (1, 2, 3, 4, 5))
def test_soc_divergence_uses_the_sibling_median(both_engines, rack_no):
    """
    imbalance.py's SIBLING_CENTRE is the median of the OTHER racks. A mean, or a
    median that counts the rack in its own reference, both let a diverging rack
    drag the centre toward itself.
    """
    assert SIBLING_CENTRE == "median"

    rack = _rack_id(rack_no)
    sql = both_engines["gold"][rack]
    py = both_engines["python"][rack]

    assert py.soc_divergence_pp is not None
    assert sql["soc_divergence_from_sibling_median_pct"] == pytest.approx(
        py.soc_divergence_pp, abs=1e-9
    )


def test_sibling_median_is_not_the_asset_mean(both_engines):
    """
    The centre this model used to use was the asset mean of rack means, and on
    this fixture it gives a visibly different answer for the drifting rack. The
    two are not interchangeable, which is why the column was renamed rather than
    quietly recomputed.
    """
    sql = both_engines["gold"][_rack_id(CHILD_RACK)]
    divergence = sql["soc_divergence_from_sibling_median_pct"]

    # Rack 5 ends the day 3.6 points below its siblings' median.
    assert divergence == pytest.approx(-3.6, abs=1e-9)

    # The old centre, this rack's day mean minus the asset's day mean of rack
    # means, reads 2.14 against the same rack-day. It under reports by 40
    # percent, in the direction that matters: a mean is dragged toward the
    # diverging rack by the diverging rack.
    means = {
        rack: sum(
            r["value_canonical"]
            for r in both_engines["rows"]
            if r["rack_device_id"] == rack and r["metric"] == "bess_soc_rack"
        )
        / INSTANTS
        for rack in both_engines["gold"]
    }
    asset_mean = sum(means.values()) / len(means)
    old_style = means[_rack_id(CHILD_RACK)] - asset_mean

    assert old_style == pytest.approx(-2.14, abs=1e-9)
    assert abs(old_style) < abs(divergence)


def test_single_reporting_rack_yields_null_not_zero():
    """
    A rack with no sibling has nothing to diverge from. Null, never 0.0: a zero
    there reads as "balanced", which is the strongest possible claim from the
    weakest possible evidence.
    """
    ts = DAY
    rows = [
        _row(1, ts, "bess_soc_rack", 61.0),
        _row(1, ts + CADENCE, "bess_soc_rack", 62.0),
    ]
    con = _load(rows)
    cursor = con.execute(_render_model_sql())
    columns = [d[0] for d in cursor.description]
    row = dict(zip(columns, cursor.fetchone()))

    assert row["soc_divergence_from_sibling_median_pct"] is None
    # And no spread was measurable either: one scalar is not a population.
    assert row["voltage_spread_max_v"] is None
    assert row["temp_spread_max_c"] is None
    assert row["voltage_spread_instants"] == 0
    assert row["spread_basis"] is None

    samples, _ = rack_samples_from_silver(rows)
    py = analyze_imbalance(ASSET_ID, samples).racks[0]
    assert py.soc_divergence_pp is None
    assert py.voltage_spread_v is None
    assert py.spread_basis is None


def test_spread_basis_matches_imbalance_py(both_engines):
    """
    Two members on the 'extremes' basis is a rack reporting its two edges, not a
    rack with two modules. Both engines must say which.
    """
    for rack_no in EXTREME_RACKS:
        rack = _rack_id(rack_no)
        assert both_engines["gold"][rack]["spread_basis"] == "extremes"
        assert both_engines["python"][rack].spread_basis == "extremes"

    rack = _rack_id(CHILD_RACK)
    assert both_engines["gold"][rack]["spread_basis"] == "members"
    assert both_engines["python"][rack].spread_basis == "members"


def test_p95_and_mean_sit_under_the_max(both_engines):
    """
    p95 exists so one bad sample does not own the day. On the fixture exactly one
    instant per rack widens, so the max is above both the p95 and the mean.
    """
    for rack_no in EXTREME_RACKS:
        sql = both_engines["gold"][_rack_id(rack_no)]
        assert sql["voltage_spread_instants"] == INSTANTS
        assert sql["voltage_spread_mean_v"] < sql["voltage_spread_max_v"]
        assert sql["voltage_spread_p95_v"] < sql["voltage_spread_max_v"]
        assert sql["voltage_spread_mean_v"] <= sql["voltage_spread_p95_v"]
        assert sql["voltage_spread_max_v"] == pytest.approx(
            VOLTAGE_BASE_GAP[rack_no] + VOLTAGE_EXCURSION, abs=1e-9
        )


def _collapse(text: str) -> str:
    """Comment markers and line wrapping removed, so a quote can be compared."""
    return " ".join(text.replace("--", " ").split())


def test_definition_is_quoted_where_it_is_implemented():
    """
    The constant is the definition of record. A model that implements it without
    quoting it is one edit away from drifting again, and the drift is invisible
    because both numbers look plausible.
    """
    assert _collapse(SPREAD_DEFINITION) in _collapse(MODEL_PATH.read_text())
    assert _collapse(SPREAD_DEFINITION) in _collapse(SCHEMA_PATH.read_text())
    assert "imbalance.py" in MODEL_PATH.read_text()
    assert "SIBLING_CENTRE" in _collapse(SCHEMA_PATH.read_text())
