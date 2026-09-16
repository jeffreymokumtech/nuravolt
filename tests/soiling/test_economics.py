"""Unit tests for cleaning economics (nuravolt/soiling/economics.py).

Correctness properties, not smoke checks: breakeven positivity and
monotonicity in the tariff, and the weather-aware schedule's spacing and
pre-rain skip rules.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.economics import (
    calculate_breakeven_days,
    optimize_cleaning_schedule,
)


class TestBreakeven:
    BASE = dict(
        soiling_loss_pct=3.0,
        capacity_MW=9.0,
        cleaning_cost_per_MW=600.0,
        electricity_rate=65.0,
        sun_hours_per_day=5.5,
    )

    def test_breakeven_positive_and_consistent(self):
        days, daily_loss = calculate_breakeven_days(**self.BASE)
        assert days > 0
        assert daily_loss > 0
        # By definition: cumulative loss over `days` equals the cleaning cost.
        cleaning_cost = self.BASE['capacity_MW'] * self.BASE['cleaning_cost_per_MW']
        assert days * daily_loss == pytest.approx(cleaning_cost, rel=1e-9)

    def test_breakeven_monotonic_nonincreasing_in_tariff(self):
        """A higher electricity price makes cleaning pay back sooner."""
        rates = [40.0, 65.0, 90.0, 140.0]
        days = [
            calculate_breakeven_days(**{**self.BASE, 'electricity_rate': r})[0]
            for r in rates
        ]
        assert all(a >= b for a, b in zip(days, days[1:])), days

    def test_breakeven_monotonic_nonincreasing_in_soiling(self):
        """Dirtier panels justify cleaning faster."""
        losses = [1.0, 3.0, 6.0, 12.0]
        days = [
            calculate_breakeven_days(**{**self.BASE, 'soiling_loss_pct': s})[0]
            for s in losses
        ]
        assert all(a >= b for a, b in zip(days, days[1:])), days


class TestOptimizeCleaningSchedule:
    def _daily(self, n_days=120, rain_days=()):
        dates = pd.date_range('2024-01-01', periods=n_days, freq='D')
        rainfall = np.zeros(n_days)
        for d in rain_days:
            rainfall[d] = 15.0
        return pd.DataFrame({'rainfall': rainfall}, index=dates)

    def test_schedule_respects_min_spacing(self):
        df = self._daily()
        y_pred = np.full(len(df), 0.90)  # always below threshold
        schedule = optimize_cleaning_schedule(
            df, y_pred, cleaning_threshold_sr=0.97,
            min_days_between=14, rain_avoid_days=7,
        )
        cleaned = [row['date'] for row in schedule if not row['reason'].startswith('SKIP')]
        assert cleaned, 'a permanently dirty plant must get cleanings'
        gaps = [(b - a).days for a, b in zip(cleaned, cleaned[1:])]
        assert all(g >= 14 for g in gaps), gaps

    def test_schedule_skips_before_heavy_rain(self):
        """>=10mm forecast within the look-ahead window defers to free rain."""
        rain_day = 30
        df = self._daily(rain_days=(rain_day,))
        y_pred = np.full(len(df), 0.90)
        schedule = optimize_cleaning_schedule(
            df, y_pred, cleaning_threshold_sr=0.97,
            min_days_between=14, rain_avoid_days=7,
        )
        by_date = {row['date']: row for row in schedule}
        pre_rain = df.index[rain_day - 3]
        if pre_rain in by_date:
            assert by_date[pre_rain]['reason'].startswith('SKIP'), (
                'cleaning scheduled 3 days before a 15mm rain event'
            )
        # No non-skip cleaning may fall within 7 days before the rain event.
        rain_date = df.index[rain_day]
        for row in schedule:
            if row['reason'].startswith('SKIP'):
                continue
            lead = (rain_date - row['date']).days
            assert not (0 < lead <= 7), (
                f"cleaning on {row['date'].date()} only {lead}d before heavy rain"
            )

    def test_clean_plant_gets_no_schedule(self):
        df = self._daily()
        y_pred = np.full(len(df), 0.995)  # spotless
        schedule = optimize_cleaning_schedule(df, y_pred, cleaning_threshold_sr=0.97)
        assert schedule == []
