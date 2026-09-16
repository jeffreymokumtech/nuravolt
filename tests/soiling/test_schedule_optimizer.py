"""
Tests for the 365-day cleaning schedule optimizer.

Exercises CleaningScheduleOptimizer.optimize_schedule_365d against a
synthetic-but-physical 365-day ML forecast (declining SR sawtooth with two
heavy-rain resets) and asserts real correctness properties of the returned
schedule: date ordering, min-day spacing, horizon containment, cleaning-count
bounds, economic self-consistency, do-nothing dominance, and electricity-rate
monotonicity.

The scenario search is deliberately kept small (max 3 cleanings, 60 sampled
scenarios per count) so the whole module runs in seconds while still driving
the real optimizer + forecast_optimizer cost/benefit engine end to end.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.config import SITE_CONFIG, SoilingConfig
from nuravolt.soiling.forecast_optimizer import calculate_forecast_driven_cost_benefit
from nuravolt.soiling.schedule_optimizer import CleaningScheduleOptimizer

HORIZON_DAYS = 365
FORECAST_START = pd.Timestamp("2025-01-01")
RESET_OFFSETS = [120, 240]  # heavy-rain resets within the horizon
START_SR = 0.99
DECAY_PER_DAY = 0.0012  # ~0.12%/day dry soiling accumulation
MIN_CLEANINGS = 1
MAX_CLEANINGS = 3
MAX_SCENARIOS = 60  # keep combinatorics small so a run stays fast


def _sawtooth(n_days: int, start_sr: float, decay: float, resets) -> np.ndarray:
    """Declining SR with full recovery on heavy-rain reset days."""
    sr = np.empty(n_days)
    current = start_sr
    for d in range(n_days):
        if d in resets:
            current = start_sr
        sr[d] = current
        current -= decay
    return sr


def _as_timestamps(dates) -> list:
    """Normalize cleaning dates: 1-cleaning scenarios carry pd.Timestamp,
    multi-cleaning scenarios carry 'YYYY-MM-DD' strings."""
    return [pd.Timestamp(d) for d in dates]


@pytest.fixture(scope="module")
def df_ml_forecast() -> pd.DataFrame:
    """365-day ML forecast matching the optimizer's expected input schema.

    Datetime index; sr_predicted sawtooth + widening uncertainty bounds;
    seasonal clean-panel energy so summer cleanings genuinely recover more.
    """
    dates = pd.date_range(FORECAST_START, periods=HORIZON_DAYS, freq="D")
    sr = _sawtooth(HORIZON_DAYS, START_SR, DECAY_PER_DAY, RESET_OFFSETS)
    day = np.arange(HORIZON_DAYS)
    uncertainty = 0.02 + 0.08 * day / HORIZON_DAYS  # widens with horizon
    doy = dates.dayofyear.to_numpy()
    energy_clean = SITE_CONFIG["capacity_MW"] * (
        6.5 + 2.0 * np.sin(2 * np.pi * (doy - 80) / 365)
    )
    df = pd.DataFrame(
        {
            "date": dates,
            "sr_predicted": sr,
            "sr_lower_bound": np.clip(sr - uncertainty, 0.70, 1.0),
            "sr_upper_bound": np.clip(sr + uncertainty, 0.70, 1.0),
            "soiling_loss_pct": (1 - sr) * 100,
            "is_cleaning_needed": sr < 0.97,
            "energy_if_clean_MWh": energy_clean,
            "energy_with_soiling_MWh": energy_clean * sr,
        }
    )
    return df.set_index("date")


@pytest.fixture(scope="module")
def site_config() -> SoilingConfig:
    """Real Alpha1 economics: 9 MW, EUR 600/MW cleaning, EUR 65/MWh PPA."""
    return SoilingConfig.from_dict(SITE_CONFIG)


@pytest.fixture(scope="module")
def optimizer(site_config) -> CleaningScheduleOptimizer:
    return CleaningScheduleOptimizer(site_config)


@pytest.fixture(scope="module")
def result(optimizer, df_ml_forecast) -> dict:
    """One shared optimization run reused by all read-only assertions."""
    return optimizer.optimize_schedule_365d(
        df_ml_forecast,
        min_cleanings=MIN_CLEANINGS,
        max_cleanings=MAX_CLEANINGS,
        max_scenarios_per_count=MAX_SCENARIOS,
    )


class TestOptimalSchedule:
    """Structural correctness of the returned optimal schedule."""

    def test_result_contract(self, result):
        """Top-level keys and container types match the documented contract."""
        assert set(result) >= {"optimal_schedule", "all_scenarios", "comparison_table"}
        assert isinstance(result["optimal_schedule"], dict)
        assert isinstance(result["all_scenarios"], pd.DataFrame)
        assert isinstance(result["comparison_table"], pd.DataFrame)
        for key in (
            "cleaning_dates",
            "n_cleanings",
            "net_benefit_EUR",
            "revenue_recovered_EUR",
            "cleaning_cost_EUR",
            "roi_pct",
        ):
            assert key in result["optimal_schedule"], f"missing {key}"

    def test_optimal_dates_sorted_and_within_horizon(self, result, df_ml_forecast):
        """Optimal dates are strictly increasing and inside the candidate
        window ([start+14d, end-14d] per _generate_candidate_dates)."""
        dates = _as_timestamps(result["optimal_schedule"]["cleaning_dates"])
        assert len(dates) >= 1
        assert dates == sorted(dates)
        assert len(set(dates)) == len(dates), "duplicate cleaning dates"
        window_start = df_ml_forecast.index[0] + pd.Timedelta(days=14)
        window_end = df_ml_forecast.index[-1] - pd.Timedelta(days=14)
        for d in dates:
            assert window_start <= d <= window_end

    def test_all_scenarios_respect_min_day_spacing(self, result, optimizer):
        """Every tested scenario (not just the winner) honors the configured
        minimum spacing between cleanings."""
        min_days = optimizer.min_days_between
        assert min_days == 14  # from SITE_CONFIG defaults
        for dates_raw in result["all_scenarios"]["cleaning_dates"]:
            dates = _as_timestamps(dates_raw)
            for a, b in zip(dates, dates[1:]):
                assert (b - a).days >= min_days, f"{a} -> {b} closer than {min_days}d"

    def test_all_scenario_dates_within_horizon(self, result, df_ml_forecast):
        """No scenario schedules a cleaning outside the 365-day forecast."""
        start, end = df_ml_forecast.index[0], df_ml_forecast.index[-1]
        for dates_raw in result["all_scenarios"]["cleaning_dates"]:
            for d in _as_timestamps(dates_raw):
                assert start <= d <= end

    def test_cleaning_counts_within_requested_bounds(self, result):
        """Scenario counts stay within [min_cleanings, max_cleanings] and the
        comparison table has exactly one best row per count."""
        counts = result["all_scenarios"]["n_cleanings"]
        assert counts.between(MIN_CLEANINGS, MAX_CLEANINGS).all()
        # Every requested count was actually explored
        assert set(counts.unique()) == set(range(MIN_CLEANINGS, MAX_CLEANINGS + 1))
        comparison = result["comparison_table"]
        assert sorted(comparison["n_cleanings"].tolist()) == list(
            range(MIN_CLEANINGS, MAX_CLEANINGS + 1)
        )
        optimal_n = result["optimal_schedule"]["n_cleanings"]
        assert MIN_CLEANINGS <= optimal_n <= MAX_CLEANINGS
        assert optimal_n == len(result["optimal_schedule"]["cleaning_dates"])


class TestEconomics:
    """Economic correctness: internal consistency, do-nothing dominance,
    electricity-rate monotonicity."""

    def test_optimal_is_max_of_all_scenarios(self, result):
        """optimal_schedule is the argmax of net benefit, and each comparison
        row is the per-count maximum."""
        scenarios = result["all_scenarios"]
        best_net = result["optimal_schedule"]["net_benefit_EUR"]
        assert best_net == pytest.approx(scenarios["net_benefit_EUR"].max())
        # all_scenarios is returned sorted best-first
        assert scenarios["net_benefit_EUR"].iloc[0] == pytest.approx(best_net)
        for _, row in result["comparison_table"].iterrows():
            same_n = scenarios[scenarios["n_cleanings"] == row["n_cleanings"]]
            assert row["net_benefit_EUR"] == pytest.approx(
                same_n["net_benefit_EUR"].max()
            )
        # Optimal is also the best row of the comparison table
        assert best_net == pytest.approx(
            result["comparison_table"]["net_benefit_EUR"].max()
        )

    def test_net_benefit_identity(self, result, site_config):
        """net = revenue - cost, and cost = n * capacity * cost_per_MW,
        for every scenario (rounding tolerance from the engine's round(2))."""
        scenarios = result["all_scenarios"]
        expected_cost = (
            scenarios["n_cleanings"]
            * site_config.capacity_MW
            * site_config.cleaning_cost_per_MW
        )
        assert np.allclose(scenarios["cleaning_cost_EUR"], expected_cost, atol=0.02)
        assert np.allclose(
            scenarios["net_benefit_EUR"],
            scenarios["revenue_recovered_EUR"] - scenarios["cleaning_cost_EUR"],
            atol=0.02,
        )
        assert (scenarios["energy_recovered_MWh"] >= 0).all()

    def test_optimal_beats_do_nothing(self, result, df_ml_forecast, site_config):
        """The chosen schedule's net benefit is at least the zero-cleaning
        baseline evaluated by the same cost/benefit engine."""
        params = {
            "capacity_MW": site_config.capacity_MW,
            "cleaning_cost_per_MW": site_config.cleaning_cost_per_MW,
            "electricity_rate_per_MWh": site_config.electricity_rate_per_MWh,
        }
        do_nothing = calculate_forecast_driven_cost_benefit(
            cleaning_dates=[],
            df_ml_forecast=df_ml_forecast,
            df_aod_forecast=None,
            df_rain_forecast=None,
            parameters=params,
        )
        assert do_nothing["n_cleanings"] == 0
        assert do_nothing["cleaning_cost_EUR"] == 0
        best_net = result["optimal_schedule"]["net_benefit_EUR"]
        assert best_net >= do_nothing["net_benefit_EUR"]
        # With a heavily soiling plant, cleaning must be worth real money
        assert best_net > 0

    def test_higher_electricity_rate_does_not_decrease_net_benefit(
        self, result, df_ml_forecast
    ):
        """Doubling the PPA rate can only increase (never decrease) the
        optimal net benefit: recovered energy is >= 0 and the candidate/
        scenario generation is deterministic (seeded sampler), so the same
        scenario set is re-priced at a higher rate."""
        expensive_cfg = SoilingConfig.from_dict(
            {**SITE_CONFIG, "electricity_rate_per_MWh": SITE_CONFIG["electricity_rate_per_MWh"] * 2}
        )
        expensive_result = CleaningScheduleOptimizer(expensive_cfg).optimize_schedule_365d(
            df_ml_forecast,
            min_cleanings=MIN_CLEANINGS,
            max_cleanings=MAX_CLEANINGS,
            max_scenarios_per_count=MAX_SCENARIOS,
        )
        base_net = result["optimal_schedule"]["net_benefit_EUR"]
        expensive_net = expensive_result["optimal_schedule"]["net_benefit_EUR"]
        assert expensive_net >= base_net


class TestReporting:
    """The human-facing reporting helpers stay consistent with the raw run."""

    def test_scenario_comparison_display_table(self, optimizer, result):
        """generate_scenario_comparison mirrors comparison_table row for row."""
        display = optimizer.generate_scenario_comparison(result)
        comparison = result["comparison_table"]
        assert len(display) == len(comparison) == MAX_CLEANINGS - MIN_CLEANINGS + 1
        assert list(display["Strategy"]) == [
            f"{int(n)} cleaning(s)" for n in comparison["n_cleanings"]
        ]
        assert np.allclose(
            display["Net Benefit (€)"].to_numpy(),
            comparison["net_benefit_EUR"].round(0).to_numpy(),
        )

    def test_operator_proposal_consistent_with_optimum(
        self, optimizer, result, df_ml_forecast
    ):
        """simulate_operator_proposal reports the same optimum it was given."""
        proposal = optimizer.simulate_operator_proposal(result, df_ml_forecast)
        best = result["optimal_schedule"]
        summary = proposal["executive_summary"]
        assert summary["recommended_cleanings"] == int(best["n_cleanings"])
        assert summary["expected_net_benefit_EUR"] == pytest.approx(
            best["net_benefit_EUR"]
        )
        financial = proposal["financial_analysis"]
        assert financial["net_benefit_EUR"] == pytest.approx(best["net_benefit_EUR"])
        assert financial["optimized_revenue_EUR"] == pytest.approx(
            financial["baseline_revenue_EUR"] + best["revenue_recovered_EUR"]
        )
        assert financial["payback_days"] > 0
        assert len(proposal["recommendations"]) >= 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
