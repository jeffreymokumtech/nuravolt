"""
Tests for nuravolt.bess.rack_samples.

The adapter is a pivot, so most of it is uninteresting. Its three refusals are
not, and each one has a test here because each one is a way to be confidently
wrong about a battery:

  the SoC scale        a percentage carried across as a fraction reports a real
                       3 point divergence as 300 points
  pack voltage         mixing a series string into cell voltage fabricates a
                       cell to cell spread of hundreds of volts
  extremes are edges   a rack that reported one scalar has not reported a
                       spread of zero, it has not reported a spread
"""

from datetime import datetime, timedelta

import pytest

from nuravolt.bess.imbalance import (
    MEMBER_KIND_DEVICE,
    MEMBER_KIND_EXTREME,
    MEMBER_KIND_RACK,
    SPREAD_BASIS_EXTREMES,
    SPREAD_BASIS_MEMBERS,
    analyze_imbalance,
)
from nuravolt.bess.rack_samples import (
    SOC_PERCENT_TO_FRACTION,
    rack_samples_from_silver,
)

T0 = datetime(2026, 7, 1, 6, 0)


def _row(rack, metric, value, *, grain="rack", device=None, ts=T0):
    """One silver_bess_telemetry row, in the columns the adapter reads."""
    return {
        "rack_device_id": rack,
        "canonical_device_id": device or rack,
        "device_grain": grain,
        "ts": ts,
        "metric": metric,
        "value_canonical": value,
    }


# --- Refusal 1: the SoC scale ----------------------------------------------


def test_soc_percentage_becomes_a_fraction_exactly_once():
    """
    Silver emits SoC in percent, DeviceSample.soc is a fraction, and imbalance
    multiplies by 100 to display. Miss the divisor and a 3 percentage point
    divergence between racks is reported as 300 percentage points: not a
    rounding error, a factor of one hundred, and one that reads as a pack
    tearing itself apart.
    """
    rows = [
        _row("R-1", "bess_soc_rack", 50.0),
        _row("R-2", "bess_soc_rack", 50.0),
        _row("R-3", "bess_soc_rack", 50.0),
        _row("R-4", "bess_soc_rack", 53.0),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)

    assert diagnostics["soc_scale_applied"] == SOC_PERCENT_TO_FRACTION
    assert diagnostics["soc_suspect_already_fraction"] is False
    assert [s.soc for s in samples] == [0.50, 0.50, 0.50, 0.53]

    report = analyze_imbalance("bess-1", samples)
    by_rack = {r.rack_id: r for r in report.racks}
    assert by_rack["R-4"].soc_divergence_pp == pytest.approx(3.0)
    assert report.inter_rack_spread["soc"] == pytest.approx(3.0)


def test_a_soc_feed_that_is_already_a_fraction_is_flagged_not_corrected():
    """
    The heuristic reports a suspicion and changes nothing. Silently switching
    scale on a guess is how a 100x error stops being debuggable.
    """
    rows = [
        _row("R-1", "bess_soc_rack", 0.50),
        _row("R-2", "bess_soc_rack", 0.53),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)
    assert diagnostics["soc_suspect_already_fraction"] is True
    assert samples[0].soc == pytest.approx(0.005)


# --- Refusal 2: pack voltage is never cell voltage --------------------------


def test_pack_voltage_is_dropped_and_counted():
    """
    A 780 V string next to 3.3 V cells would produce a "cell to cell spread" of
    776 V. Dropped, and counted, because a silent drop is indistinguishable
    from a vendor that never sent the tag.
    """
    rows = [
        _row("R-1", "bess_voltage_cell_max", 3.32),
        _row("R-1", "bess_voltage_cell_min", 3.26),
        _row("R-1", "bess_voltage_pack", 780.0),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)

    assert all(s.voltage_v < 4.0 for s in samples)
    assert diagnostics["metrics_ignored"]["bess_voltage_pack"] == 1
    assert "bess_voltage_pack" not in diagnostics["metrics_seen"]

    report = analyze_imbalance("bess-1", samples)
    assert report.racks[0].voltage_spread_v == pytest.approx(0.06)


# --- Refusal 3: extremes are edges, a scalar is not a spread ----------------


def test_rack_scalar_reports_no_spread_rather_than_zero():
    """
    One number is one number. A rack reporting a single cell temperature and no
    children and no max/min pair has not measured a spread, and 0.0 there would
    read as a perfectly balanced rack.
    """
    rows = [
        _row("R-1", "bess_temp_cell", 31.0),
        _row("R-2", "bess_temp_cell", 31.4),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)

    assert [s.member_kind for s in samples] == [MEMBER_KIND_RACK, MEMBER_KIND_RACK]
    assert all(s.member_id is None for s in samples)
    assert diagnostics["basis_per_rack"] == {"R-1": "rack", "R-2": "rack"}

    report = analyze_imbalance("bess-1", samples)
    assert [r.temperature_spread_c for r in report.racks] == [None, None]
    assert all(r.spread_basis is None for r in report.racks)
    # The inter rack view is still measurable, and is measured.
    assert report.inter_rack_spread["temperature"] == pytest.approx(0.4)


def test_extremes_give_the_exact_delta():
    v_max, v_min = 3.352, 3.298
    rows = [
        _row("R-1", "bess_voltage_cell_max", v_max),
        _row("R-1", "bess_voltage_cell_min", v_min),
        _row("R-1", "bess_temp_cell_max", 32.4),
        _row("R-1", "bess_temp_cell_min", 30.9),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)

    assert sorted(s.member_id for s in samples) == ["#Tmax", "#Tmin", "#Vmax", "#Vmin"]
    assert all(s.member_kind == MEMBER_KIND_EXTREME for s in samples)
    assert diagnostics["basis_per_rack"] == {"R-1": SPREAD_BASIS_EXTREMES}

    report = analyze_imbalance("bess-1", samples)
    rack = report.racks[0]
    assert rack.voltage_spread_v == v_max - v_min
    assert rack.temperature_spread_c == pytest.approx(1.5)
    # Four members here are two pairs of edges, and the basis says so. Without
    # it a caption would claim four modules are reporting.
    assert rack.member_count == 4
    assert rack.spread_basis == SPREAD_BASIS_EXTREMES


# --- Mixed racks: children beat the edges -----------------------------------


def test_a_rack_with_children_ignores_its_own_extremes():
    """
    An extreme is a summary OF the children. Keeping both would put the
    population's own max and min back into the population, tightening the MAD
    around values that are duplicates of ones already there.
    """
    rows = [
        _row("R-1", "bess_voltage_cell_max", 3.32),
        _row("R-1", "bess_voltage_cell_min", 3.26),
    ]
    for i, v in enumerate([3.26, 3.29, 3.32], start=1):
        rows.append(
            _row("R-1", "bess_voltage_cell", v, grain="module", device=f"R-1.M-{i}")
        )
    samples, diagnostics = rack_samples_from_silver(rows)

    assert [s.member_kind for s in samples] == [MEMBER_KIND_DEVICE] * 3
    assert sorted(s.member_id for s in samples) == ["R-1.M-1", "R-1.M-2", "R-1.M-3"]
    assert diagnostics["basis_per_rack"] == {"R-1": SPREAD_BASIS_MEMBERS}
    assert diagnostics["dropped"]["extremes_superseded_by_children"] == 2
    assert diagnostics["metrics_ignored"]["bess_voltage_cell_max"] == 1

    report = analyze_imbalance("bess-1", samples)
    rack = report.racks[0]
    assert rack.member_count == 3
    assert rack.spread_basis == SPREAD_BASIS_MEMBERS
    assert rack.voltage_spread_v == pytest.approx(0.06)


def test_children_of_one_rack_do_not_suppress_another_racks_extremes():
    rows = [
        _row("R-1", "bess_voltage_cell", 3.26, grain="module", device="R-1.M-1"),
        _row("R-1", "bess_voltage_cell", 3.32, grain="module", device="R-1.M-2"),
        _row("R-2", "bess_voltage_cell_max", 3.33),
        _row("R-2", "bess_voltage_cell_min", 3.25),
    ]
    _, diagnostics = rack_samples_from_silver(rows)
    assert diagnostics["basis_per_rack"] == {
        "R-1": SPREAD_BASIS_MEMBERS,
        "R-2": SPREAD_BASIS_EXTREMES,
    }


# --- Rows that cannot be attributed ----------------------------------------


def test_rows_without_a_rack_or_a_value_are_dropped_and_counted():
    rows = [
        _row(None, "bess_soc", 50.0, grain="asset"),
        _row("R-1", "bess_temp_cell_max", None),
        _row("R-1", "bess_rte", 0.87),
        _row("R-1", "bess_temp_cell_max", 32.0),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)

    assert len(samples) == 1
    assert diagnostics["rows_in"] == 4
    assert diagnostics["samples_out"] == 1
    assert diagnostics["dropped"]["no_rack_device_id"] == 1
    assert diagnostics["dropped"]["no_canonical_value"] == 1
    assert diagnostics["metrics_ignored"]["bess_rte"] == 1
    assert diagnostics["racks"] == 1


def test_one_sample_per_member_per_instant_across_metrics():
    """Temperature and voltage for one module at one instant are one sample."""
    rows = [
        _row("R-1", "bess_temp_cell", 31.0, grain="module", device="R-1.M-1"),
        _row("R-1", "bess_voltage_cell", 3.30, grain="module", device="R-1.M-1"),
        _row("R-1", "bess_temp_cell", 31.6, grain="module", device="R-1.M-2"),
        _row("R-1", "bess_voltage_cell", 3.26, grain="module", device="R-1.M-2"),
    ]
    samples, _ = rack_samples_from_silver(rows)
    assert len(samples) == 2
    assert [(s.temperature_c, s.voltage_v) for s in samples] == [
        (31.0, 3.30),
        (31.6, 3.26),
    ]


def test_timestamps_are_carried_through_as_instants():
    rows = [
        _row("R-1", "bess_temp_cell_max", 31.0, ts=T0),
        _row("R-1", "bess_temp_cell_min", 30.0, ts=T0),
        _row("R-1", "bess_temp_cell_max", 33.0, ts=T0 + timedelta(minutes=5)),
        _row("R-1", "bess_temp_cell_min", 30.0, ts=T0 + timedelta(minutes=5)),
    ]
    samples, _ = rack_samples_from_silver(rows)
    assert sorted({s.timestamp for s in samples}) == [T0, T0 + timedelta(minutes=5)]

    # The worst instantaneous spread, not the envelope of the whole window.
    report = analyze_imbalance("bess-1", samples)
    assert report.racks[0].temperature_spread_c == pytest.approx(3.0)


def test_iso_string_timestamps_are_accepted():
    rows = [
        _row("R-1", "bess_temp_cell_max", 31.0, ts="2026-07-01T06:00:00Z"),
        _row("R-1", "bess_temp_cell_min", 30.0, ts="2026-07-01T06:00:00Z"),
    ]
    samples, diagnostics = rack_samples_from_silver(rows)
    assert diagnostics["samples_out"] == 2
    assert samples[0].timestamp.year == 2026
