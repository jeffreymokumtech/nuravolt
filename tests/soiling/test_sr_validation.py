"""
Unit tests for physics-based SR validation (nuravolt/soiling/sr_validation.py).

Exercises the real validators against the shared synthetic sawtooth fixtures
(conftest.py): a 200-day plant SR series with heavy-rain resets at day offsets
60 and 140, plus matching rain history. Fixtures are always passed as copies —
several validators reassign ``.index`` on their inputs in place, and the
conftest fixtures are session-scoped and shared across test modules.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.sr_validation import (
    PhysicsValidationResults,
    comprehensive_physics_validation,
    validate_fleet_consistency,
    validate_monotonic_decay,
    validate_rain_resets,
    validate_sr_range,
)


# ---------------------------------------------------------------------------
# Module-local fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def monotone_decline_series(sr_series) -> pd.Series:
    """Same index and decay slope as the sawtooth, but NO rain resets."""
    n = len(sr_series)
    return pd.Series(0.995 - 0.0012 * np.arange(n), index=sr_series.index.copy())


@pytest.fixture()
def oscillating_series(sr_series) -> pd.Series:
    """Physically implausible SR: seeded random oscillation, big daily swings."""
    rng = np.random.default_rng(3)
    return pd.Series(rng.uniform(0.85, 1.0, len(sr_series)),
                     index=sr_series.index.copy())


@pytest.fixture()
def coherent_fleet(sr_series) -> dict:
    """5 inverters tracking the plant sawtooth with tiny stable offsets."""
    offsets = [-0.002, -0.001, 0.0, 0.001, 0.002]
    return {f"INV 01.{i + 1:03d}": sr_series + off
            for i, off in enumerate(offsets)}


@pytest.fixture()
def divergent_fleet(coherent_fleet, sr_series) -> dict:
    """Same fleet but one member is wildly off (-0.15 SR, a broken signal)."""
    fleet = dict(coherent_fleet)
    fleet["INV 01.005"] = sr_series - 0.15
    return fleet


# ---------------------------------------------------------------------------
# validate_sr_range
# ---------------------------------------------------------------------------

def test_range_flags_out_of_bounds_values():
    """A series containing 1.2 and 0.5 must be flagged (both out of [0.75, 1])."""
    sr = pd.Series([0.98, 1.2, 0.90, 0.5, 0.85])
    violations, rate = validate_sr_range(sr)

    assert violations == 2
    assert rate == pytest.approx(2 / 5)
    assert rate > 0


def test_range_passes_clean_sawtooth(sr_series):
    """The physics-plausible sawtooth (0.899..0.995) has zero violations."""
    violations, rate = validate_sr_range(sr_series.copy())

    assert violations == 0
    assert rate == 0.0


def test_range_respects_custom_bounds():
    """Custom sr_min/sr_max move the goalposts, not just the defaults."""
    sr = pd.Series([0.80, 0.90, 0.95])
    violations, rate = validate_sr_range(sr, sr_min=0.85, sr_max=0.92)

    assert violations == 2  # 0.80 below, 0.95 above
    assert rate == pytest.approx(2 / 3)


# ---------------------------------------------------------------------------
# validate_rain_resets
# ---------------------------------------------------------------------------

def test_rain_resets_score_high_on_sawtooth(sr_series, rain_df):
    """The sawtooth resets to 0.995 on both 22mm days -> perfect accuracy."""
    events, correct, accuracy = validate_rain_resets(sr_series.copy(), rain_df.copy())

    # Only the two engineered 22mm days cross the 10mm heavy-rain threshold
    # (background rain is capped at 4mm by the fixture).
    assert events == 2
    assert correct == 2
    assert accuracy == pytest.approx(1.0)


def test_rain_resets_score_low_on_non_resetting_series(monotone_decline_series, rain_df):
    """A monotone decline ignores the heavy rain -> no resets are credited."""
    events, correct, accuracy = validate_rain_resets(
        monotone_decline_series.copy(), rain_df.copy()
    )

    assert events == 2  # heavy-rain days still exist in the rain record
    assert correct == 0
    assert accuracy < 0.5


def test_rain_resets_no_heavy_rain_returns_zero_events(sr_series, rain_df):
    """With the threshold above every precipitation value there are no events."""
    events, correct, accuracy = validate_rain_resets(
        sr_series.copy(), rain_df.copy(), heavy_rain_threshold_mm=100.0
    )

    assert (events, correct, accuracy) == (0, 0, 0.0)


# ---------------------------------------------------------------------------
# validate_monotonic_decay
# ---------------------------------------------------------------------------

def test_monotonic_decay_passes_sawtooth_dry_stretches(sr_series, rain_df):
    """The dry stretch between the two rain events decays strictly -> no violations."""
    periods, violations, plausibility = validate_monotonic_decay(
        sr_series.copy(), rain_df.copy()
    )

    # Exactly one inter-rain period (between day offsets 60 and 140) at the
    # default 5mm threshold — background rain never exceeds 4mm.
    assert periods == 1
    assert violations == 0
    assert plausibility == pytest.approx(1.0)


def test_monotonic_decay_fails_oscillating_series(oscillating_series, rain_df):
    """Random oscillation has large SR increases everywhere -> flagged implausible."""
    periods, violations, plausibility = validate_monotonic_decay(
        oscillating_series.copy(), rain_df.copy()
    )

    assert periods >= 1
    assert violations >= 1
    assert plausibility < 0.5


def test_monotonic_decay_needs_two_rain_events(sr_series, rain_df):
    """Fewer than two rain events -> nothing to check, vacuously plausible."""
    periods, violations, plausibility = validate_monotonic_decay(
        sr_series.copy(), rain_df.copy(), rain_threshold_mm=100.0
    )

    assert (periods, violations, plausibility) == (0, 0, 1.0)


# ---------------------------------------------------------------------------
# validate_fleet_consistency
# ---------------------------------------------------------------------------

def test_fleet_consistency_distinguishes_coherent_from_divergent(
    coherent_fleet, divergent_fleet
):
    """Tight fleet scores near 1; a -0.15 SR outlier collapses the score."""
    coherent_std, coherent_score = validate_fleet_consistency(coherent_fleet)
    divergent_std, divergent_score = validate_fleet_consistency(divergent_fleet)

    # Coherent: cross-fleet daily std is exactly the std of the fixed offsets.
    assert coherent_std == pytest.approx(np.std([-0.002, -0.001, 0, 0.001, 0.002],
                                                ddof=1))
    assert coherent_score > 0.9

    # Divergent: std blows way past the 0.02 acceptance ceiling.
    assert divergent_std > 0.02
    assert divergent_score < 0.5
    assert divergent_score < coherent_score
    assert divergent_std > coherent_std


def test_fleet_consistency_perfect_uniformity_scores_one(sr_series):
    """Identical inverters -> zero std, perfect uniformity score."""
    fleet = {f"INV 01.{i:03d}": sr_series.copy() for i in range(1, 4)}
    mean_std, score = validate_fleet_consistency(fleet)

    assert mean_std == pytest.approx(0.0)
    assert score == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# comprehensive_physics_validation
# ---------------------------------------------------------------------------

def test_comprehensive_validation_populates_every_section(
    sr_series, rain_df, coherent_fleet
):
    """On the sawtooth inputs every check section is populated and passes."""
    results = comprehensive_physics_validation(
        sr_series.copy(), rain_df.copy(), coherent_fleet
    )

    assert isinstance(results, PhysicsValidationResults)

    # Range section
    assert results.total_predictions == len(sr_series)
    assert results.range_violations == 0
    assert results.range_violation_rate == 0.0

    # Rain reset section (the two 22mm days)
    assert results.heavy_rain_events == 2
    assert results.correct_rain_resets == 2
    assert results.rain_reset_accuracy == pytest.approx(1.0)

    # Decay section (one inter-rain dry stretch)
    assert results.decay_periods == 1
    assert results.decay_violations == 0
    assert results.decay_plausibility == pytest.approx(1.0)

    # Fleet section (real std from the offset fleet, not the 0.01 default)
    assert 0 < results.mean_fleet_std < 0.02
    assert results.uniformity_score > 0.9

    # Seasonal section: Jan-Jul 2024 window covers both winter and summer, and
    # the sawtooth is dirtier (lower SR) in summer as physics demands.
    assert results.summer_mean_sr < results.winter_mean_sr
    assert 0 < results.seasonal_ratio < 1

    # Overall verdict: everything passes on the engineered ground truth.
    assert results.overall_pass_rate == pytest.approx(1.0)
    assert results.is_physically_plausible is True


def test_comprehensive_validation_to_dict_sections(sr_series, rain_df, coherent_fleet):
    """to_dict() exposes all five sections plus the overall verdict."""
    results = comprehensive_physics_validation(
        sr_series.copy(), rain_df.copy(), coherent_fleet
    )
    d = results.to_dict()

    expected_sections = {"range_checks", "rain_reset", "decay_plausibility",
                         "fleet_uniformity", "seasonal_patterns", "overall"}
    assert expected_sections == set(d.keys())
    for section in expected_sections - {"overall"}:
        assert d[section]["pass"] is True
    assert d["overall"]["is_plausible"] is True


def test_comprehensive_validation_flags_broken_predictions(rain_df, sr_series):
    """A non-resetting, out-of-range series is judged NOT physically plausible."""
    n = len(sr_series)
    # Declines straight through the 0.75 floor and never resets on rain.
    broken = pd.Series(0.995 - 0.002 * np.arange(n), index=sr_series.index.copy())

    results = comprehensive_physics_validation(broken, rain_df.copy())

    assert results.range_violations > 0
    assert results.rain_reset_accuracy == 0.0
    assert results.overall_pass_rate < 0.9
    assert results.is_physically_plausible is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
