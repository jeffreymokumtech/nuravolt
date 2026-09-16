"""Unit tests for the 365-day hybrid forecaster + cleaning simulation
(nuravolt/soiling/forecasting_longterm.py).

Correctness properties: exact horizon, contiguous daily dates, ordered
uncertainty bounds, physical SR range, threshold-consistent cleaning flags,
and cleanings lifting the simulated trajectory.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.config import SoilingConfig
from nuravolt.soiling.forecasting_longterm import (
    PhysicsMLHybridForecaster,
    simulate_cleaning_scenarios,
)

# The forecaster reads config attributes (not dict keys) — use the real dataclass.
SITE_CONFIG = SoilingConfig(
    name='Testplant',
    plant_id=999,
    latitude=39.0,
    longitude=-3.0,
    elevation=400.0,
    timezone='Europe/Madrid',
    capacity_MW=5.0,
    capacity_installed_MW=5.5,
    tilt=25.0,
    azimuth=180.0,
    expected_soiling_rate_per_day=0.1,
    rain_cleaning_threshold_mm=10.0,
    cleaning_threshold_sr=0.97,
)


@pytest.fixture(scope='module')
def historical_daily(request):
    """Two years of daily history with the columns the forecaster reads:
    a smoothed SR sawtooth (dry decay + rain resets) and rainfall."""
    rng = np.random.default_rng(3)
    dates = pd.date_range('2022-01-01', periods=730, freq='D')
    sr = np.empty(len(dates))
    rain = np.zeros(len(dates))
    current = 0.99
    for i, d in enumerate(dates):
        if rng.random() < 0.06:
            rain[i] = rng.uniform(8, 20)
            current = 0.99
        sr[i] = current
        current = max(0.85, current - 0.0012)
    return pd.DataFrame(
        {'soiling_ratio_smooth': sr, 'rainfall': rain}, index=dates
    )


@pytest.fixture(scope='module')
def forecast(historical_daily):
    forecaster = PhysicsMLHybridForecaster(site_config=SITE_CONFIG)
    return forecaster.predict_365d_hybrid(
        last_sr=0.95,
        last_date=historical_daily.index[-1],
        df_daily_historical=historical_daily,
        include_uncertainty=True,
    )


def test_forecast_has_exactly_365_contiguous_days(forecast, historical_daily):
    assert len(forecast) == 365
    dates = pd.to_datetime(forecast['date']) if 'date' in forecast.columns else forecast.index
    dates = pd.DatetimeIndex(dates)
    assert dates[0] == historical_daily.index[-1] + pd.Timedelta(days=1)
    deltas = np.diff(dates.values).astype('timedelta64[D]').astype(int)
    assert (deltas == 1).all(), 'forecast dates must be daily-contiguous'


def test_forecast_bounds_bracket_prediction(forecast):
    lower = forecast['sr_lower_bound'].to_numpy()
    upper = forecast['sr_upper_bound'].to_numpy()
    pred = forecast['sr_predicted'].to_numpy()
    assert (lower <= pred + 1e-9).all()
    assert (pred <= upper + 1e-9).all()


def test_forecast_sr_in_physical_range(forecast):
    pred = forecast['sr_predicted'].to_numpy()
    assert pred.min() >= 0.5
    assert pred.max() <= 1.05


def test_cleaning_flag_matches_threshold(forecast):
    pred = forecast['sr_predicted'].to_numpy()
    flags = forecast['is_cleaning_needed'].to_numpy()
    expected = pred < SITE_CONFIG.cleaning_threshold_sr
    assert (flags == expected).all()


def test_simulated_cleaning_lifts_sr(forecast):
    df = forecast.copy()
    if 'date' in df.columns:
        df = df.set_index(pd.to_datetime(df['date']))
    clean_date = str(df.index[100].date())
    scenario = simulate_cleaning_scenarios(df, [clean_date], cleaning_effectiveness=0.95)

    before = df['sr_predicted'].iloc[100]
    after = scenario['sr_predicted'].iloc[100]
    assert after > before, 'cleaning must lift SR at its date'
    assert after == pytest.approx(before + (1.0 - before) * 0.95, abs=1e-9)
    # Pre-cleaning days are untouched.
    pd.testing.assert_series_equal(
        scenario['sr_predicted'].iloc[:100], df['sr_predicted'].iloc[:100]
    )
    # loss column stays consistent with the lifted SR.
    lifted = scenario.iloc[150]
    assert lifted['soiling_loss_pct'] == pytest.approx(
        (1 - lifted['sr_predicted']) * 100, abs=1e-6
    )
