"""
Tests for the state of safety composite and the thermal monitor's guard rails.

The worst-of test documents why the composite is not a weighted sum: it asserts
that the arithmetic mean of the same four sub indices would have banded the
asset LOW while worst-of bands it CRITICAL.
"""

from datetime import datetime, timedelta

import numpy as np
import pytest

from nuravolt.bess.thermal_monitor import (
    SAFETY_RUBRIC,
    InsufficientBaselineError,
    SafetySubIndex,
    ThermalAnomalyDetector,
    ThermalRuleBasedMonitor,
    ThermalThresholds,
    band_for_score,
    combine_state_of_safety,
    dwell_exposure_index,
    protection_status_index,
    safety_disclosure,
    thermal_margin_index,
)

# The exact sentence every surface must publish. Kept literal here so a reword
# in either the Python or the TypeScript copy (src/lib/alerts/evaluate.ts,
# bessSafetyDisclosure) fails a test instead of drifting quietly.
EXPECTED_DISCLOSURE_15_MIN = (
    "State of safety is a trend and margin indicator computed from 15 minute "
    "cloud telemetry. It is not a protection system and must not be relied on "
    "for emergency response. Your BMS and fire detection system are."
)


def test_disclosure_wording_is_exact():
    assert safety_disclosure(15) == EXPECTED_DISCLOSURE_15_MIN
    assert "periodic cloud telemetry" in safety_disclosure(None)
    for text in (safety_disclosure(15), safety_disclosure(None)):
        assert "—" not in text and "–" not in text and " - " not in text


# --- Worst-of -------------------------------------------------------------


def _idx(name: str, score: int) -> SafetySubIndex:
    return SafetySubIndex(name=name, score=score, available=True)


def test_worst_of_does_not_let_three_healthy_indices_dilute_a_critical_one():
    subs = [
        _idx("thermal_margin", 12),
        _idx("imbalance", 100),
        _idx("dwell_exposure", 100),
        _idx("protection_status", 100),
    ]
    sos = combine_state_of_safety(subs, interval_minutes=15)

    assert sos.score == 12
    assert sos.band == "CRITICAL"
    assert sos.limiting_index == "thermal_margin"

    # The decision, stated: a weighted sum would have said the opposite.
    weighted = sum(s.score for s in subs) / len(subs)
    assert weighted == 78.0
    assert band_for_score(weighted) == "MODERATE"
    assert band_for_score(sos.score) == "CRITICAL"


def test_unavailable_sub_index_is_excluded_not_scored_full_marks():
    subs = [
        _idx("thermal_margin", 90),
        SafetySubIndex(
            name="imbalance",
            score=None,
            available=False,
            reason="Requires rack level telemetry, connect your BMS to enable",
        ),
    ]
    sos = combine_state_of_safety(subs, interval_minutes=15)
    assert sos.score == 90
    assert sos.limiting_index == "thermal_margin"
    assert sos.unavailable == ["imbalance"]


def test_nothing_measurable_is_unknown_not_a_reassuring_number():
    subs = [
        SafetySubIndex(name="thermal_margin", score=None, available=False, reason="x"),
        SafetySubIndex(name="imbalance", score=None, available=False, reason="y"),
    ]
    sos = combine_state_of_safety(subs)
    assert sos.score is None
    assert sos.band == "UNKNOWN"
    assert sos.limiting_index is None
    assert sos.disclosure


def test_rubric_is_published_with_the_result():
    sos = combine_state_of_safety([_idx("thermal_margin", 70)], interval_minutes=5)
    payload = sos.to_dict()
    assert payload["rubric"]["combination"] == "worst_of"
    assert "bands" in payload["rubric"]
    assert set(SAFETY_RUBRIC["sub_indices"]) == {
        "thermal_margin",
        "imbalance",
        "dwell_exposure",
        "protection_status",
    }
    assert payload["sub_indices"][0]["band"] == "MODERATE"


# --- Sub indices ----------------------------------------------------------


def test_thermal_margin_spans_warning_to_critical():
    th = ThermalThresholds()  # warning 45, critical 60
    assert thermal_margin_index(40.0).score == 100
    assert thermal_margin_index(45.0).score == 100
    assert thermal_margin_index(52.5).score == 50
    assert thermal_margin_index(60.0).score == 0
    assert thermal_margin_index(75.0).score == 0
    assert thermal_margin_index(52.5).inputs["temp_critical_c"] == th.temp_critical


def test_thermal_margin_takes_the_worse_of_temperature_and_rate():
    index = thermal_margin_index(30.0, max_rate_c_per_min=3.0)
    assert index.inputs["limiting_component"] == "rate"
    assert index.score == 50


def test_thermal_margin_without_a_temperature_channel_is_unavailable():
    index = thermal_margin_index(None)
    assert index.available is False
    assert index.score is None


def test_dwell_exposure_merges_overlapping_events():
    t0 = datetime(2026, 7, 1)
    events = [
        ("TEMPERATURE_EXCEED", t0, t0 + timedelta(hours=6)),
        ("SOC_HIGH_DWELL", t0 + timedelta(hours=3), t0 + timedelta(hours=9)),
        # Not a safety exposure type: warranty economics, ignored here.
        ("THROUGHPUT_EXCEED", t0, t0 + timedelta(hours=24)),
    ]
    index = dwell_exposure_index(events, window_hours=24)
    assert index.inputs["exposed_minutes"] == pytest.approx(9 * 60)
    assert index.score == 62  # 1 - 9/24


def test_dwell_exposure_without_a_window_is_unavailable():
    assert dwell_exposure_index([], window_hours=None).available is False


def test_protection_status_without_channels_is_unavailable():
    index = protection_status_index()
    assert index.available is False
    assert index.score is None
    assert "cannot be read" in index.reason


def test_protection_status_bands():
    healthy = protection_status_index(hvac_failures=0, hvac_channel_present=True)
    alarmed = protection_status_index(
        hvac_failures=0, alarm_codes=["E-204"], alarm_channel_present=True
    )
    failed = protection_status_index(hvac_failures=1, hvac_channel_present=True)
    assert healthy.score == 100
    assert alarmed.score == 30
    assert failed.score == 0


# --- Thermal monitor guard rails ------------------------------------------


def test_anomaly_detector_refuses_to_fit_on_too_little_history():
    detector = ThermalAnomalyDetector(min_baseline_samples=500)
    with pytest.raises(InsufficientBaselineError) as exc:
        detector.fit_baseline(np.random.default_rng(0).normal(size=(120, 5)))
    assert "500" in str(exc.value)
    assert detector.is_fitted is False


def test_anomaly_detector_fits_once_the_floor_is_met():
    detector = ThermalAnomalyDetector(min_baseline_samples=100)
    data = np.random.default_rng(0).normal(size=(400, 5))
    data[7, 2] = np.nan  # unusable row, must not count toward the floor
    detector.fit_baseline(data)
    assert detector.is_fitted
    assert detector.baseline_stats["n_samples"] == 399
    assert detector.baseline_stats["dropped_rows"] == 1


def test_detect_rejects_a_feature_count_the_baseline_never_saw():
    detector = ThermalAnomalyDetector(min_baseline_samples=50)
    detector.fit_baseline(np.random.default_rng(1).normal(size=(100, 5)))
    with pytest.raises(ValueError):
        detector.detect(np.zeros(3))


def test_unmeasured_gradient_is_none_not_zero():
    monitor = ThermalRuleBasedMonitor()
    alert = monitor.check_cell({"temperature": 30.0}, grain="pack")
    assert alert.temp_gradient is None
    assert alert.temp_rate is None
    assert alert.grain == "pack"
    assert alert.level == "normal"


def test_pack_check_reports_grain_and_refuses_a_one_member_spread():
    monitor = ThermalRuleBasedMonitor()
    single = monitor.check_pack([{"temperature": 30.0}], grain="pack")
    assert single["temp_spread"] is None
    assert single["grain"] == "pack"

    pair = monitor.check_pack(
        [{"temperature": 30.0}, {"temperature": 34.0}], grain="module"
    )
    assert pair["temp_spread"] == 4.0
    assert pair["member_count"] == 2
