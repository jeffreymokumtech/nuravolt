"""
Unit tests for cleaning-event detection (nuravolt/soiling/event_detection.py).

Builds the daily df the detectors expect (``soiling_ratio_smooth`` +
``rainfall``, date-indexed) from the shared conftest sawtooth: heavy-rain
resets at day offsets 60 and 140 (22mm), background rain always < 5mm. The
detectors mutate their input frames in place (documented behavior), so every
test gets a freshly built frame.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.event_detection import (
    detect_cleaning_events,
    detect_cleaning_events_hybrid,
    get_cleaning_dates,
)

MANUAL_BUMP_OFFSET = 100  # dry day where we engineer a manual-cleaning jump


# ---------------------------------------------------------------------------
# Module-local fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def reset_dates(rain_df) -> list:
    """The engineered heavy-rain (natural cleaning) dates, from the fixture."""
    return list(pd.to_datetime(rain_df.loc[rain_df["is_cleaning_event"], "date"]))


@pytest.fixture()
def df_daily(sr_series, rain_df) -> pd.DataFrame:
    """Fresh daily frame in the detector's schema (detectors mutate in place)."""
    return pd.DataFrame(
        {
            "soiling_ratio_smooth": sr_series.to_numpy(copy=True),
            "rainfall": rain_df["precipitation_mm"].to_numpy(copy=True),
        },
        index=sr_series.index.copy(),
    )


@pytest.fixture()
def df_daily_with_manual(df_daily) -> pd.DataFrame:
    """df_daily plus an engineered +0.07 SR jump on a dry day (manual clean).

    The bump persists until the next rain reset so only one jump is created;
    the day-140 rain reset still produces a >0.02 SR jump afterwards.
    """
    bumped = df_daily.copy()
    bumped.iloc[MANUAL_BUMP_OFFSET:140,
                bumped.columns.get_loc("soiling_ratio_smooth")] += 0.07
    return bumped


@pytest.fixture()
def df_pd(sr_series) -> pd.DataFrame:
    """15-minute power frame for the power-based/hybrid detector.

    Power tracks the daily SR exactly (power = SR * 200 kW at a constant
    800 W/m2 clearsky POA window), so normalized power carries the same
    cleaning jumps as the SR series.
    """
    idx, vals = [], []
    for date, sr in sr_series.items():
        times = pd.date_range(date + pd.Timedelta(hours=10), periods=16, freq="15min")
        idx.extend(times)
        vals.extend([sr] * 16)
    vals = np.asarray(vals)
    return pd.DataFrame(
        {
            "power_inverter": vals * 200.0,
            "power_janitza": vals * 200.0,
            "poa_clearsky": 800.0,
        },
        index=pd.DatetimeIndex(idx),
    )


def _within_days(date, targets, tolerance_days=2):
    """True if ``date`` is within +/-tolerance_days of any target date."""
    return any(abs((date - t).days) <= tolerance_days for t in targets)


# ---------------------------------------------------------------------------
# detect_cleaning_events
# ---------------------------------------------------------------------------

def test_rain_cleanings_land_on_engineered_resets(df_daily, reset_dates):
    """Detected rain cleanings sit within +/-2 days of both 22mm reset days."""
    out = detect_cleaning_events(df_daily)

    detected = list(out.index[out["is_rain_cleaning"]])
    assert len(detected) == 2

    # Every detection is near an engineered reset...
    for date in detected:
        assert _within_days(date, reset_dates), f"spurious detection at {date}"
    # ...and every engineered reset was found.
    for reset in reset_dates:
        assert _within_days(reset, detected), f"missed reset at {reset}"


def test_no_manual_cleanings_on_rain_only_sawtooth(df_daily):
    """Both SR jumps coincide with 22mm rain -> zero manual cleanings, and the
    slow dry-day decay (-0.0012/day) never trips either detector."""
    out = detect_cleaning_events(df_daily)

    assert out["is_manual_cleaning"].sum() == 0
    # Only the two rain resets are flagged at all.
    assert (out["is_manual_cleaning"] | out["is_rain_cleaning"]).sum() == 2


def test_sr_change_column_is_daily_diff(df_daily, sr_series):
    """The added sr_change column is the day-over-day diff of the smooth SR."""
    out = detect_cleaning_events(df_daily)

    expected = sr_series.diff()
    pd.testing.assert_series_equal(
        out["sr_change"], expected, check_names=False
    )


def test_manual_cleaning_detected_on_dry_sr_jump(df_daily_with_manual, sr_series):
    """A +0.07 SR jump on a dry day is classified manual, not rain."""
    out = detect_cleaning_events(df_daily_with_manual)

    manual_dates = list(out.index[out["is_manual_cleaning"]])
    expected_date = sr_series.index[MANUAL_BUMP_OFFSET]
    assert manual_dates == [expected_date]
    # The bump day must not double-count as rain cleaning (rainfall < 10mm).
    assert not out.loc[expected_date, "is_rain_cleaning"]
    # The two rain resets are still detected alongside it.
    assert out["is_rain_cleaning"].sum() == 2


# ---------------------------------------------------------------------------
# get_cleaning_dates
# ---------------------------------------------------------------------------

def test_get_cleaning_dates_respects_max_results(df_daily_with_manual):
    """max_results truncates; all returned dates exist in the input index."""
    out = detect_cleaning_events(df_daily_with_manual)

    all_events = get_cleaning_dates(out, event_type="all", max_results=10)
    assert len(all_events) == 3  # 2 rain resets + 1 manual bump

    capped = get_cleaning_dates(out, event_type="all", max_results=2)
    assert len(capped) == 2
    # Truncation keeps the earliest events, in order.
    assert [e["date"] for e in capped] == [e["date"] for e in all_events[:2]]

    for event in all_events:
        assert event["date"] in out.index


def test_get_cleaning_dates_filters_by_type_and_reports_gain(
    df_daily_with_manual, reset_dates, sr_series
):
    """Type filter separates rain from manual; SR gain fields are consistent."""
    out = detect_cleaning_events(df_daily_with_manual)

    rain_events = get_cleaning_dates(out, event_type="rain", max_results=10)
    assert [e["date"] for e in rain_events] == reset_dates

    manual_events = get_cleaning_dates(out, event_type="manual", max_results=10)
    assert [e["date"] for e in manual_events] == [sr_series.index[MANUAL_BUMP_OFFSET]]

    for event in rain_events + manual_events:
        assert event["sr_after"] > event["sr_before"]
        assert event["sr_gain_pct"] == pytest.approx(
            (event["sr_after"] - event["sr_before"]) * 100
        )
        assert event["sr_gain_pct"] > 2.0  # every engineered jump is >= 0.02 SR


# ---------------------------------------------------------------------------
# detect_cleaning_events_hybrid
# ---------------------------------------------------------------------------

def test_hybrid_consistent_with_simple_on_clean_synthetic(
    df_pd, df_daily, reset_dates
):
    """With power tracking SR exactly, both methods agree everywhere: the
    hybrid rain flags equal the SR-only flags and land on the resets."""
    out = detect_cleaning_events_hybrid(df_pd, df_daily)

    # Rain cleanings: SR method, power method, and hybrid union all agree.
    assert out["is_rain_cleaning_hybrid"].equals(out["is_rain_cleaning"])
    assert out["is_rain_cleaning_hybrid"].equals(out["is_rain_cleaning_power"])

    detected = list(out.index[out["is_rain_cleaning_hybrid"]])
    assert len(detected) == 2
    for date in detected:
        assert _within_days(date, reset_dates)

    # No manual cleanings exist in this scenario by either method.
    assert out["is_manual_cleaning_hybrid"].sum() == 0
    # Confidence is only assigned to manual detections -> all 'none' here.
    assert set(out["manual_cleaning_confidence"].unique()) == {"none"}


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
