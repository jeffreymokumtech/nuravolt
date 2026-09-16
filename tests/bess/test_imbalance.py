"""
Tests for nuravolt.bess.imbalance.

Two tests in this file are not regression guards, they are design decisions
written down:

  test_mad_catches_the_rack_that_mean_and_std_hide
      a mean/standard deviation outlier test misses the rack that the
      median/MAD test catches, because the failing rack is inside its own
      dispersion estimate. If someone ever "simplifies" modified_z_scores back
      to mean and std, that test fails and explains why it should not have been
      done.

  test_spread_grain_catches_the_rack_the_level_grain_cannot_see
      the level detector and the spread detector are not redundant. A rack
      whose cells drift apart while its average stays with the fleet is
      invisible to the first and obvious to the second, which is why both
      grains exist.
"""

from datetime import datetime, timedelta

import numpy as np
import pytest

from nuravolt.bess.imbalance import (
    DEFAULT_OUTLIER_THRESHOLD,
    DWELL_UNRESOLVABLE,
    MEMBER_KIND_EXTREME,
    MIN_RACKS_FOR_OUTLIER,
    SPREAD_BASIS_EXTREMES,
    SPREAD_BASIS_MEMBERS,
    SUB_ASSET_UNAVAILABLE,
    TOO_FEW_SIBLINGS,
    DeviceSample,
    analyze_imbalance,
    classic_z_scores,
    imbalance_index,
    median_absolute_deviation,
    modified_z_scores,
)

# Seven racks running normally with realistic scatter, plus one at +6 C.
NORMAL_RACK_TEMPS_C = [28.0, 28.4, 27.8, 28.2, 28.1, 27.9, 28.3]
BAD_RACK_TEMP_C = 34.0
ONE_BAD_RACK = NORMAL_RACK_TEMPS_C + [BAD_RACK_TEMP_C]
BAD_INDEX = len(ONE_BAD_RACK) - 1

CLASSIC_Z_THRESHOLD = 3.0  # the conventional mean/std flag point


def test_mad_catches_the_rack_that_mean_and_std_hide():
    """
    THE design decision, pinned.

    One rack 6 C above its siblings. The standard deviation of the population is
    computed *including* that rack, so the outlier widens the band it is judged
    against and lands at |z| = 2.6, under the conventional 3.0 flag point: a
    mean/std test reports the pack as fine.

    The median and the MAD have a 50 percent breakdown point, so the same rack
    scores |mz| ~ 19.7 and is flagged an order of magnitude clear of 3.5.
    """
    classic = classic_z_scores(ONE_BAD_RACK)
    modified = modified_z_scores(ONE_BAD_RACK)

    # The mean/std test misses it.
    assert abs(classic[BAD_INDEX]) < CLASSIC_Z_THRESHOLD
    assert not (np.abs(classic) > CLASSIC_Z_THRESHOLD).any(), (
        "a mean/std test flags nothing here, which is exactly the failure mode "
        "this module exists to avoid"
    )

    # The MAD test catches it, and only it.
    assert abs(modified[BAD_INDEX]) > DEFAULT_OUTLIER_THRESHOLD
    flagged = np.where(np.abs(modified) > DEFAULT_OUTLIER_THRESHOLD)[0].tolist()
    assert flagged == [BAD_INDEX]

    # And the gap between the two verdicts is not marginal.
    assert abs(modified[BAD_INDEX]) > 5 * abs(classic[BAD_INDEX])


def test_modified_z_uses_median_and_mad():
    values = [10.0, 10.5, 11.0, 10.2, 30.0]
    med = float(np.median(values))
    mad = median_absolute_deviation(values)
    expected = 0.6745 * (30.0 - med) / mad
    assert modified_z_scores(values)[-1] == pytest.approx(expected)


def test_modified_z_falls_back_when_mad_is_zero():
    # More than half the population shares one value, so MAD is exactly 0.
    values = [5.0, 5.0, 5.0, 5.0, 5.0, 9.0]
    assert median_absolute_deviation(values) == 0.0
    scores = modified_z_scores(values)
    assert np.isfinite(scores).all()
    assert scores[-1] > 0


def test_modified_z_returns_nan_when_not_computable():
    assert np.isnan(modified_z_scores([7.0])).all()
    assert np.isnan(modified_z_scores([float("nan"), 3.0])).all()


def test_identical_population_scores_zero_not_nan():
    assert (modified_z_scores([12.0, 12.0, 12.0]) == 0.0).all()


# --- Dwell window ----------------------------------------------------------


def _rack_samples(bad_from: int, bad_to: int, *, n: int = 24, step_min: int = 5):
    """Eight racks at `step_min` cadence; R-8 runs hot for [bad_from, bad_to)."""
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = []
    for i in range(n):
        ts = t0 + timedelta(minutes=step_min * i)
        for j, base in enumerate(ONE_BAD_RACK[:-1] + [NORMAL_RACK_TEMPS_C[0]]):
            rack = f"R-{j + 1}"
            hot = rack == "R-8" and bad_from <= i < bad_to
            temp = base + (BAD_RACK_TEMP_C - NORMAL_RACK_TEMPS_C[0] if hot else 0.0)
            for member, offset in (("M1", 0.0), ("M2", 0.1)):
                samples.append(
                    DeviceSample(
                        timestamp=ts,
                        rack_id=rack,
                        member_id=member,
                        temperature_c=temp + offset,
                    )
                )
    return samples


def test_sustained_deviation_is_flagged():
    report = analyze_imbalance(
        "bess-1", _rack_samples(bad_from=5, bad_to=16), dwell_minutes=30
    )
    assert [o.rack_id for o in report.outliers] == ["R-8"]
    outlier = report.outliers[0]
    assert outlier.metric == "temperature"
    assert outlier.duration_minutes >= 30
    assert abs(outlier.modified_z) > DEFAULT_OUTLIER_THRESHOLD


def test_brief_deviation_is_not_flagged():
    # Same amplitude, 10 minutes instead of 50: below the dwell window.
    report = analyze_imbalance(
        "bess-1", _rack_samples(bad_from=5, bad_to=8), dwell_minutes=30
    )
    assert report.outliers == []
    # It was scoreable, so a clean run reports zero rather than "unknown".
    assert report.scoreable
    assert report.worst_modified_z == 0.0


# --- Availability, never a computed looking zero ----------------------------


def test_no_rack_telemetry_reports_unavailable_not_balanced():
    report = analyze_imbalance("bess-1", [])
    assert report.rack_count == 0
    assert not report.has_sub_asset_telemetry
    assert report.worst_modified_z is None
    assert all(a.reason == SUB_ASSET_UNAVAILABLE for a in report.availability)

    index = imbalance_index(report)
    assert index.available is False
    assert index.score is None
    assert index.reason == SUB_ASSET_UNAVAILABLE


def test_single_member_rack_reports_no_spread_rather_than_zero():
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = [
        DeviceSample(timestamp=t0, rack_id="R-1", member_id=None, temperature_c=28.0),
        DeviceSample(timestamp=t0, rack_id="R-2", member_id=None, temperature_c=28.4),
    ]
    report = analyze_imbalance("bess-1", samples)
    assert [r.temperature_spread_c for r in report.racks] == [None, None]
    within = [a for a in report.availability if a.grain == "within_rack"]
    assert all(a.available is False for a in within)
    assert all(a.reason == SUB_ASSET_UNAVAILABLE for a in within)
    # Two racks IS enough for an inter rack spread, and that one is measured.
    assert report.inter_rack_spread["temperature"] == pytest.approx(0.4)


def test_too_few_racks_to_score_says_so():
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = [
        DeviceSample(timestamp=t0, rack_id=f"R-{i}", member_id="M1", temperature_c=28.0)
        for i in range(1, MIN_RACKS_FOR_OUTLIER)
    ]
    report = analyze_imbalance("bess-1", samples)
    assert not report.scoreable
    index = imbalance_index(report)
    assert index.score is None
    assert index.reason == TOO_FEW_SIBLINGS


def test_metric_absent_from_the_feed_is_unavailable_not_zero():
    report = analyze_imbalance("bess-1", _rack_samples(bad_from=0, bad_to=0))
    voltage = [a for a in report.availability if a.metric == "voltage"]
    assert all(a.available is False for a in voltage)
    assert "voltage" not in report.inter_rack_spread
    assert all(r.voltage_spread_v is None for r in report.racks)


# --- Sub index -------------------------------------------------------------


def test_flagged_rack_lands_on_the_alert_floor_or_below():
    report = analyze_imbalance(
        "bess-1", _rack_samples(bad_from=5, bad_to=16), dwell_minutes=30
    )
    index = imbalance_index(report)
    assert index.available
    # 60 is the MODERATE band floor and the alert threshold; a flagged rack must
    # not sit above it.
    assert index.score < 60


def test_clean_pack_with_real_rack_telemetry_scores_full_marks():
    report = analyze_imbalance(
        "bess-1", _rack_samples(bad_from=0, bad_to=0), dwell_minutes=30
    )
    index = imbalance_index(report)
    assert index.available
    assert index.score == 100
    assert index.inputs["rack_count"] == 8


# --- Extremes as members ----------------------------------------------------

CELL_V_MAX = 3.352
CELL_V_MIN = 3.298


def _extremes_samples(*, n: int = 12, step_min: int = 5):
    """
    Three racks reporting what a BMS cloud API actually streams: the cell
    voltage max and min across the rack, and nothing in between.
    """
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = []
    for i in range(n):
        ts = t0 + timedelta(minutes=step_min * i)
        for j in range(3):
            rack = f"R-{j + 1}"
            for member, value in (
                ("#Vmax", CELL_V_MAX + 0.001 * j),
                ("#Vmin", CELL_V_MIN + 0.001 * j),
            ):
                samples.append(
                    DeviceSample(
                        timestamp=ts,
                        rack_id=rack,
                        member_id=member,
                        member_kind=MEMBER_KIND_EXTREME,
                        voltage_v=value,
                    )
                )
    return samples


def test_two_extremes_give_the_spread_exactly():
    """
    max minus min over two members IS the reported delta, so a BMS that streams
    only its extremes needs no new maths, only an honest label.
    """
    report = analyze_imbalance("bess-1", _extremes_samples())
    rack = report.racks[0]

    # Bit for bit the same subtraction, not an approximation of it.
    assert rack.voltage_spread_v == CELL_V_MAX - CELL_V_MIN

    # And the caption stays honest: two members here are the two edges of a
    # rack of hundreds of cells, not a rack containing two modules.
    assert rack.member_count == 2
    assert rack.spread_basis == SPREAD_BASIS_EXTREMES
    within = [
        a
        for a in report.availability
        if a.grain == "within_rack" and a.metric == "voltage"
    ]
    assert [a.member_basis for a in within] == [SPREAD_BASIS_EXTREMES]


def test_spread_is_instantaneous_and_not_the_day_envelope():
    """
    SPREAD_DEFINITION, pinned with the number that separates the two candidates.

    One rack, two members, 0.5 C apart at every instant, both drifting 4 C over
    the morning. The spread of that rack is 0.5 C: at no moment were its cells
    more than half a degree apart.

    The day envelope (the day's hottest reading minus the day's coldest, which
    is what a naive SQL max minus min computes) says 4.5 C, nine times larger,
    by subtracting the coolest cell at dawn from the hottest at noon. On a
    battery cycling twice a day the same mistake on SoC over reads by the whole
    swing. Both numbers are computable and they must never share a column name.
    """
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = []
    for i in range(12):
        base = 30.0 + 4.0 * (i / 11.0)
        for member, offset in (("M1", 0.0), ("M2", 0.5)):
            samples.append(
                DeviceSample(
                    timestamp=t0 + timedelta(minutes=5 * i),
                    rack_id="R-1",
                    member_id=member,
                    temperature_c=base + offset,
                )
            )

    report = analyze_imbalance("bess-1", samples)
    assert report.racks[0].temperature_spread_c == pytest.approx(0.5)

    envelope = max(s.temperature_c for s in samples) - min(
        s.temperature_c for s in samples
    )
    assert envelope == pytest.approx(4.5)


# --- The spread grain, which is the whole point -----------------------------

RACK_COUNT = 16
WIDENING_RACK = "R-07"
NORMAL_SPREAD_V = 0.018
WIDENED_SPREAD_V = 0.060


def _drifting_spread_samples(*, n: int = 12, step_min: int = 5, widen: bool = True):
    """
    Sixteen racks whose cell to cell spread sits at 18 mV +/- 4 mV. Rack 7's
    spread widens to 60 mV while its midpoint stays exactly where the fleet's
    is, which is what a developing weak cell looks like from the outside.
    """
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = []
    for i in range(n):
        ts = t0 + timedelta(minutes=step_min * i)
        for k in range(RACK_COUNT):
            rack = f"R-{k + 1:02d}"
            midpoint = 3.300 + 0.002 * (k % 5)
            spread = NORMAL_SPREAD_V + 0.002 * ((k % 5) - 2)
            if widen and rack == WIDENING_RACK:
                spread = WIDENED_SPREAD_V
            for member, value in (
                ("#Vmax", midpoint + spread / 2.0),
                ("#Vmin", midpoint - spread / 2.0),
            ):
                samples.append(
                    DeviceSample(
                        timestamp=ts,
                        rack_id=rack,
                        member_id=member,
                        member_kind=MEMBER_KIND_EXTREME,
                        voltage_v=value,
                    )
                )
    return samples


def test_spread_grain_catches_the_rack_the_level_grain_cannot_see():
    """
    THE second design decision, pinned.

    Rack 7's cells are 60 mV apart while its siblings sit at 18 mV. Its
    midpoint is inside the fleet's own scatter, so comparing rack levels
    against sibling levels finds nothing at all: the level detector runs, has
    a full population of 16 racks, and correctly reports no outlier.

    Running the identical statistic over each rack's within rack spread flags
    rack 7 at roughly 9 modified z, more than twice the flag point. Delete the
    spread grain and this failure becomes invisible until a cell vents.
    """
    report = analyze_imbalance("bess-1", _drifting_spread_samples(), dwell_minutes=30)

    # The level grain ran on a full population, and honestly found nothing.
    level = [
        a
        for a in report.availability
        if a.grain == "outlier" and a.metric == "voltage"
    ]
    assert [a.available for a in level] == [True]
    assert [o for o in report.outliers if o.metric == "voltage"] == []

    # The spread grain caught it, and only it.
    spread = [o for o in report.outliers if o.metric == "voltage_spread"]
    assert [o.rack_id for o in spread] == [WIDENING_RACK]
    assert abs(spread[0].modified_z) > 2 * DEFAULT_OUTLIER_THRESHOLD
    assert spread[0].duration_minutes >= 30
    assert spread[0].unit == "V"
    assert spread[0].observed_value == pytest.approx(WIDENED_SPREAD_V)
    assert spread[0].sibling_median == pytest.approx(NORMAL_SPREAD_V)

    # And the sub index reacts to it: a finding no index can see is not a
    # finding.
    index = imbalance_index(report)
    assert index.available
    assert index.score < 60
    assert index.inputs["worst_within_rack_spread"]["voltage"] == pytest.approx(
        WIDENED_SPREAD_V
    )
    assert index.inputs["spread_basis"] == SPREAD_BASIS_EXTREMES
    assert index.inputs["racks_reporting_extremes"] == RACK_COUNT


def test_a_fleet_of_equally_wide_racks_is_not_an_outlier():
    """Wide is not the same as diverging. Sixteen racks at 14 to 22 mV are fine."""
    report = analyze_imbalance(
        "bess-1", _drifting_spread_samples(widen=False), dwell_minutes=30
    )
    assert report.outliers == []
    assert report.scoreable
    assert imbalance_index(report).score == 100


# --- Timestamp alignment ----------------------------------------------------


def _jittered(samples, *, seconds: int = 7):
    """
    Re-stamp a fixture so no two racks share a timestamp, the way real vendor
    polls arrive: a deterministic offset in [-seconds, +seconds] per rack per
    sample.
    """
    out = []
    stamps = sorted({s.timestamp for s in samples})
    index = {ts: i for i, ts in enumerate(stamps)}
    for s in samples:
        i = index[s.timestamp]
        rack_n = int(s.rack_id.split("-")[-1])
        offset = ((i * 13 + rack_n * 7) % (2 * seconds + 1)) - seconds
        out.append(
            DeviceSample(
                timestamp=s.timestamp + timedelta(seconds=offset),
                rack_id=s.rack_id,
                member_id=s.member_id,
                member_kind=s.member_kind,
                temperature_c=s.temperature_c,
                voltage_v=s.voltage_v,
                soc=s.soc,
            )
        )
    return out


def test_jittered_polls_are_aligned_before_scoring():
    """
    Vendor polls are not synchronised. Without alignment every timestamp holds
    exactly one rack, the modified z score has no population, and the detector
    reports itself available while never firing: a silent false clean.

    The alignment must also be to the NEAREST bucket rather than the floor.
    Vendors poll on the clock, so the nominal instants sit on the boundaries and
    an early poll floors into the previous bucket, away from its own siblings.
    That is why this test compares against the unjittered result rather than
    merely checking that something was flagged: with a floor, the same fixture
    still flags R-8 but reports 30 minutes of a 50 minute event, because the
    sustained run keeps breaking where the hot rack lands one bucket early.
    """
    clean = analyze_imbalance(
        "bess-1", _rack_samples(bad_from=5, bad_to=16), dwell_minutes=30
    )
    samples = _jittered(_rack_samples(bad_from=5, bad_to=16))
    assert len({s.timestamp for s in samples}) > 24, "fixture must be jittered"

    report = analyze_imbalance("bess-1", samples, dwell_minutes=30)
    assert report.alignment_seconds == 300
    assert report.alignment_basis == "inferred_from_cadence"
    assert [o.rack_id for o in report.outliers] == ["R-8"]
    assert report.outliers[0].duration_minutes == clean.outliers[0].duration_minutes
    assert report.outliers[0].duration_minutes == 50


def test_alignment_finer_than_the_feed_reproduces_the_silent_false_clean():
    """
    The bug this alignment exists to close, pinned by asking for it explicitly.

    Snapped to one second buckets, the same jittered samples never share a
    timestamp, so every cross rack population has one member, every score is
    nan, and the report says "available, nothing found" about a rack running
    6 C hot for 50 minutes.
    """
    samples = _jittered(_rack_samples(bad_from=5, bad_to=16))
    report = analyze_imbalance("bess-1", samples, dwell_minutes=30, align_seconds=1)

    assert report.alignment_seconds == 1
    assert report.alignment_basis == "explicit"
    assert report.outliers == []
    assert report.scoreable, (
        "this is the shape of the bug: scoring reports itself available and "
        "finds nothing, which reads as a healthy pack"
    )
    assert imbalance_index(report).score == 100


# --- Dwell resolvability ----------------------------------------------------


def test_a_feed_too_coarse_for_the_dwell_says_so_rather_than_flagging():
    """
    A 30 minute feed gives two samples across a 30 minute dwell window. Two
    points cannot show that anything persisted, so the sustained grains report
    themselves unresolvable. Neither a flag nor a clean bill of health.
    """
    report = analyze_imbalance(
        "bess-1",
        _rack_samples(bad_from=2, bad_to=6, n=8, step_min=30),
        dwell_minutes=30,
    )
    assert report.cadence_seconds == 1800
    assert report.outliers == []
    assert not report.scoreable

    temperature = [
        a
        for a in report.availability
        if a.grain in ("outlier", "spread_outlier") and a.metric == "temperature"
    ]
    assert len(temperature) == 2
    assert all(a.available is False for a in temperature)
    assert all(a.reason == DWELL_UNRESOLVABLE for a in temperature)

    index = imbalance_index(report)
    assert index.available is False
    assert index.score is None
    assert index.reason == DWELL_UNRESOLVABLE
    assert report.worst_modified_z is None


def test_module_members_report_the_members_basis():
    report = analyze_imbalance("bess-1", _rack_samples(bad_from=0, bad_to=0))
    assert all(r.spread_basis == SPREAD_BASIS_MEMBERS for r in report.racks)
    assert imbalance_index(report).inputs["racks_reporting_extremes"] == 0


def test_soc_divergence_is_measured_against_the_sibling_median():
    t0 = datetime(2026, 7, 1, 6, 0)
    samples = []
    for rack, soc in [("R-1", 0.50), ("R-2", 0.51), ("R-3", 0.49), ("R-4", 0.30)]:
        samples.append(
            DeviceSample(timestamp=t0, rack_id=rack, member_id="M1", soc=soc)
        )
    report = analyze_imbalance("bess-1", samples)
    by_rack = {r.rack_id: r for r in report.racks}
    # Siblings of R-4 are 0.50, 0.51, 0.49 -> median 0.50 -> -20 percentage points.
    assert by_rack["R-4"].soc_divergence_pp == pytest.approx(-20.0)
    assert report.inter_rack_spread["soc"] == pytest.approx(21.0)
