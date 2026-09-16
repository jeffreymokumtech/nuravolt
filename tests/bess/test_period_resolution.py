"""The BESS engine must price a settlement period, not an hour.

GB settles 48 half-hourly periods per day; Iberia clears 24 hourly ones. These
tests pin the two places that assumption used to be baked in: the modelled
cabinet temperature series, and the arbitrage optimizer's slot-to-energy
conversion. A 30-minute period costed as a full hour would overstate revenue and
throughput by exactly 2x, which is the ratio asserted below.

No network: the Iberian router case reads the committed OMIE CSV, and the GB
cases are the ones that refuse before any fetch.
"""

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.bess.arbitrage_optimizer import DegradationAwareArbitrage
from nuravolt.bess.config import ArbitrageConfig
from nuravolt.pipeline import market_prices as mp
from nuravolt.pipeline.bess_intelligence import cabinet_temp_series

DAY = date(2026, 3, 17)


def half_hourly_prices() -> np.ndarray:
    """48 periods with a real intra-hour step, so averaging would show up."""
    rng = np.random.default_rng(11)
    hourly = np.array([40, 38, 36, 35, 34, 36, 45, 62, 78, 70, 55, 44,
                       38, 35, 34, 36, 48, 72, 96, 110, 98, 80, 62, 48], dtype=float)
    return np.repeat(hourly, 2) + rng.uniform(-6.0, 6.0, 48)


def make_optimizer(period_minutes: int) -> DegradationAwareArbitrage:
    cfg = ArbitrageConfig(
        capacity_kwh=4000.0,
        max_power_kw=2000.0,
        time_resolution_minutes=period_minutes,
    )
    return DegradationAwareArbitrage(cfg)


# ---------------------------------------------------------------------------
# Cabinet temperature


def test_hourly_series_is_unchanged():
    series = cabinet_temp_series(DAY)
    assert len(series) == 24
    assert cabinet_temp_series(DAY, 60) == series
    # Deterministic: no RNG, so reruns are byte-identical.
    assert cabinet_temp_series(DAY) == series


def test_half_hourly_series_samples_the_same_day_twice_as_often():
    hourly = cabinet_temp_series(DAY, 60)
    half = cabinet_temp_series(DAY, 30)
    assert len(half) == 48
    # The diurnal shape is a function of hour-of-day, so every other half-hour
    # lands exactly on its hourly value rather than stretching over two days.
    assert half[::2] == hourly
    assert min(half) > 15.0 and max(half) < 35.0  # inside the warranty band


def test_period_must_divide_the_day():
    with pytest.raises(ValueError):
        cabinet_temp_series(DAY, 7)


# ---------------------------------------------------------------------------
# Optimizer slot semantics


def revenue_at(sched, cfg, period_hours: float) -> float:
    """Gross revenue implied by a schedule if a period were `period_hours` long."""
    total = 0.0
    for price, charge_kw, discharge_kw in zip(
        sched.price_forecast, sched.charge_schedule_kw, sched.discharge_schedule_kw
    ):
        total -= price * abs(min(charge_kw, 0.0)) * period_hours / 1000
        total += (price * max(discharge_kw, 0.0) * period_hours
                  * cfg.discharge_efficiency / 1000)
    return total


def throughput_at(sched, period_hours: float) -> float:
    return sum(abs(c) + d for c, d in
               zip(sched.charge_schedule_kw, sched.discharge_schedule_kw)) * period_hours


def test_half_hour_slot_is_not_priced_as_a_full_hour():
    prices = half_hourly_prices()
    temps = np.asarray(cabinet_temp_series(DAY, 30), dtype=float)

    optimizer = make_optimizer(30)
    cfg = optimizer.config
    sched = optimizer.optimize(prices=prices, temp_forecast=temps)

    # Money and throughput are settled over half an hour per period, not a
    # whole one. Priced as full hours these would both come out exactly 2x.
    assert sched.expected_revenue_eur == pytest.approx(revenue_at(sched, cfg, 0.5), rel=1e-9)
    assert sched.expected_revenue_eur != pytest.approx(revenue_at(sched, cfg, 1.0), rel=1e-6)
    assert revenue_at(sched, cfg, 1.0) == pytest.approx(2 * revenue_at(sched, cfg, 0.5), rel=1e-9)
    assert sched.expected_cycles == pytest.approx(
        throughput_at(sched, 0.5) / (2 * cfg.capacity_kwh), rel=1e-9)
    assert sched.discharge_schedule_kw != [0.0] * 48  # the day actually traded


def test_horizon_hours_is_delivery_hours_not_slot_count():
    prices = half_hourly_prices()
    half = make_optimizer(30).optimize(prices=prices)
    assert len(half.soc_schedule) == 48
    assert half.horizon_hours == 24
    assert half.resolution_minutes == 30

    hourly = make_optimizer(60).optimize(prices=prices[:24])
    assert len(hourly.soc_schedule) == 24
    assert hourly.horizon_hours == 24
    assert hourly.resolution_minutes == 60


def test_currency_travels_with_the_schedule():
    cfg = ArbitrageConfig(capacity_kwh=4000.0, max_power_kw=2000.0,
                          time_resolution_minutes=30, currency="GBP")
    sched = DegradationAwareArbitrage(cfg).optimize(prices=half_hourly_prices())
    assert sched.currency == "GBP"


def test_config_rejects_a_period_that_does_not_divide_the_day():
    with pytest.raises(ValueError):
        ArbitrageConfig(capacity_kwh=1000.0, max_power_kw=500.0, time_resolution_minutes=7)


# ---------------------------------------------------------------------------
# Zone router


def test_iberian_day_is_24_hourly_euro_periods():
    curve = mp.day_ahead_periods(date(2025, 12, 2), "ES")
    assert curve["currency"] == "EUR"
    assert curve["resolution_minutes"] == 60
    assert len(curve["prices"]) == 24
    assert curve["zone"] == "ES"


def test_gb_zone_spec_is_half_hourly_sterling():
    assert mp.zone_spec("GB") == ("GBP", 30)
    assert mp.periods_per_day("GB") == 48
    assert mp.periods_per_day("ES") == 24


def test_legacy_euro_curve_refuses_gb():
    # prices_eur_mwh holding GBP half-hours would be wrong twice over, so the
    # deprecated alias raises instead of fetching.
    with pytest.raises(ValueError):
        mp.day_ahead_curve(date(2026, 7, 20), "GB")


def test_euro_resolution_is_derived_from_the_curve_not_assumed_hourly(monkeypatch):
    """A 96-value Iberian day must report 15-minute periods, never hourly.

    Europe is migrating the day-ahead market to a 15-minute MTU. If the ladder
    ever starts serving 96 values and the router still called them hours, the
    engine would price every quarter hour as a full one and overstate revenue
    fourfold. The length decides the label.
    """
    from nuravolt.markets import iberia

    def quarter_hourly(day, zone="ES", allow_synthetic=True):
        return {"date": day.isoformat(), "zone": zone, "price_source": "energy-charts",
                "prices_eur_mwh": [50.0 + i for i in range(96)]}

    monkeypatch.setattr(iberia, "day_ahead_curve", quarter_hourly)
    curve = mp.day_ahead_periods(DAY, "ES")
    assert len(curve["prices"]) == 96
    assert curve["resolution_minutes"] == 15
    assert curve["currency"] == "EUR"


def test_a_curve_with_no_period_length_is_refused(monkeypatch):
    """23 values divide no day evenly, so the period length is unknowable."""
    from nuravolt.markets import iberia

    def ragged(day, zone="ES", allow_synthetic=True):
        return {"date": day.isoformat(), "zone": zone, "price_source": "energy-charts",
                "prices_eur_mwh": [50.0] * 23}

    monkeypatch.setattr(iberia, "day_ahead_curve", ragged)
    with pytest.raises(mp.PriceFetchError):
        mp.day_ahead_periods(DAY, "ES")


def test_country_routing_skips_the_ambiguous_cases():
    assert mp.zone_for_country("gb") == "GB"
    assert mp.zone_for_country("ES") == "ES"
    assert mp.zone_for_country("DE") == "DE-LU"
    # Italy has several bidding zones and Kenya has no price source here.
    assert mp.zone_for_country("IT") is None
    assert mp.zone_for_country("KE") is None
    assert mp.zone_for_country(None) is None
