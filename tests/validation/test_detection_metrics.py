"""Label-free detection metrics.

The properties pinned here are the ones that stop a label-free number being
mistaken for recall, and the ones that make the symmetric-tail control trustworthy.
"""

from __future__ import annotations

import math
import random

import pytest

from nuravolt.validation.metrics.detection import (
    AlertRate,
    DetectionReport,
    DetectorAgreement,
    InjectedRecall,
    InjectedRecallPoint,
    compute_null_calibration,
    compute_scale_invariance,
    normal_tail,
)


class TestNullCalibration:
    def test_a_clean_normal_population_matches_theory(self):
        """The whole method rests on this: the harmless tail should match the null."""
        rng = random.Random(0)
        scores = [rng.gauss(0, 1) for _ in range(400_000)]
        cal = compute_null_calibration(scores, 3.0, theoretical_null_rate=normal_tail(3.0))
        assert cal.is_calibrated
        assert cal.null_tail_rate == pytest.approx(normal_tail(3.0), rel=0.35)

    def test_detects_a_one_sided_signal(self):
        """Inject genuine underperformance; only the fault tail should inflate."""
        rng = random.Random(1)
        scores = [rng.gauss(0, 1) for _ in range(100_000)]
        scores += [rng.gauss(-8, 1) for _ in range(500)]
        cal = compute_null_calibration(scores, 4.0, theoretical_null_rate=normal_tail(4.0))
        assert cal.fault_tail_rate > 50 * max(cal.null_tail_rate, 1e-9)
        assert cal.signal_to_null > 50

    def test_a_miscalibrated_statistic_is_caught(self):
        """A heavy-tailed statistic inflates BOTH tails, and that must show."""
        rng = random.Random(2)
        scores = [rng.gauss(0, 1) * rng.choice([1, 1, 1, 6]) for _ in range(200_000)]
        cal = compute_null_calibration(scores, 4.0, theoretical_null_rate=normal_tail(4.0))
        assert not cal.is_calibrated, (
            f"null tail {cal.null_tail_rate:.2e} vs theory {normal_tail(4.0):.2e} "
            f"should have been flagged as miscalibrated"
        )

    def test_theoretical_tail_matches_the_published_number(self):
        """Guards the figure quoted in docs/MODEL_ACCURACY_METHODS.md."""
        assert normal_tail(4.0) == pytest.approx(3.167e-05, rel=1e-3)

    def test_empty_input_raises_rather_than_reporting_zero(self):
        with pytest.raises(ValueError, match="refusing"):
            compute_null_calibration([float("nan")] * 10, 4.0)

    def test_direction_is_explicit(self):
        rng = random.Random(3)
        scores = [rng.gauss(0, 1) for _ in range(50_000)] + [9.0] * 200
        neg = compute_null_calibration(scores, 4.0, fault_direction="negative")
        pos = compute_null_calibration(scores, 4.0, fault_direction="positive")
        assert pos.fault_tail_rate > neg.fault_tail_rate
        with pytest.raises(ValueError):
            compute_null_calibration(scores, 4.0, fault_direction="sideways")


class TestAlertRate:
    def test_gate(self):
        assert AlertRate(events=10, mw_months=100, devices_alerted=3, devices_total=50).passes
        assert not AlertRate(events=500, mw_months=100, devices_alerted=3, devices_total=50).passes

    def test_zero_mw_months_is_nan_not_zero(self):
        r = AlertRate(events=5, mw_months=0, devices_alerted=1, devices_total=1)
        assert math.isnan(r.per_mw_month)
        assert not r.passes, "an unmeasurable rate must not pass the gate"


class TestInjectedRecall:
    def test_minimum_detectable_is_the_smallest_magnitude_reaching_target(self):
        ir = InjectedRecall(corruption="string current x(1-d)", points=[
            InjectedRecallPoint(0.05, 100, 40),
            InjectedRecallPoint(0.10, 100, 92),
            InjectedRecallPoint(0.20, 100, 100),
        ])
        assert ir.minimum_detectable() == 0.10

    def test_none_when_target_never_reached(self):
        ir = InjectedRecall(corruption="x", points=[InjectedRecallPoint(0.5, 100, 10)])
        assert ir.minimum_detectable() is None

    def test_caveats_travel_with_the_number(self):
        d = InjectedRecall(corruption="x", points=[InjectedRecallPoint(0.1, 10, 10)]).to_dict()
        assert any("UPPER BOUND" in c for c in d["caveats"])


class TestScaleInvariance:
    def test_uncorrelated_passes(self):
        r = compute_scale_invariance([28, 30, 43, 45, 120, 150], [0.5, 0.4, 0.6, 0.45, 0.5, 0.55])
        assert r["passes"]

    def test_monotone_correlation_fails(self):
        r = compute_scale_invariance([28, 30, 43, 45, 120, 150], [0.1, 0.2, 0.3, 0.4, 0.9, 1.7])
        assert not r["passes"]
        assert r["spearman_size_vs_alert_rate"] == pytest.approx(1.0)

    def test_too_few_plants_says_so(self):
        assert compute_scale_invariance([1, 2], [1, 2])["computable"] is False


class TestReportContract:
    def test_disclaimer_is_always_present(self):
        d = DetectionReport(detector="x", tier="A", n_devices=10).to_dict()
        assert "is recall" in d["what_this_is_not"]
        assert d["what_this_is_not"].startswith("None of these")

    def test_tier_a_parameter_budget_is_enforced(self):
        ok = DetectionReport(detector="x", tier="A", n_devices=1,
                             parameters={"a": 1.0, "b": 2.0, "c": 3.0})
        too_many = DetectionReport(detector="x", tier="A", n_devices=1,
                                   parameters={"a": 1.0, "b": 2.0, "c": 3.0, "d": 4.0})
        assert ok.parameter_budget_ok()
        assert not too_many.parameter_budget_ok()
        assert DetectionReport(detector="x", tier="C", n_devices=1,
                               parameters={f"p{i}": float(i) for i in range(9)}).parameter_budget_ok()

    def test_agreement_is_not_labelled_as_recall(self):
        d = DetectorAgreement(other_detector="twin_residual", kappa=0.6, n_compared=100).to_dict()
        assert "NOT recall" in d["note"]
