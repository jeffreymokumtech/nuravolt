"""Time-integrity tests for the physics twin pipeline
(nuravolt/pipeline/twin.py + nuravolt/weather/fallback.py).

Regression background: the twin used to relabel the weather index with
Plant.timezone (Prisma default 'UTC') instead of the zone the weather was
built in, shifting the PREDICTED daily peak 1-2 h (DST-varying) against the
measured curve. These tests pin the conversion and the logger clock-offset
detection with synthetic data — no DB, no network.
"""

import numpy as np
import pandas as pd

from nuravolt.pipeline.twin import _weather_index_to_utc
from nuravolt.weather.fallback import detect_time_shift


def _naive_hourly(start: str, days: int) -> pd.DatetimeIndex:
    return pd.date_range(start, periods=days * 24, freq="h")


class TestWeatherIndexToUtc:
    def test_madrid_summer_shifts_two_hours(self):
        idx = _naive_hourly("2026-07-01", 2)  # CEST = UTC+2
        utc = _weather_index_to_utc(idx, "Europe/Madrid")
        assert str(utc.tz) == "UTC"
        # Local 12:00 is 10:00 UTC in summer.
        local_noon = idx.get_loc(pd.Timestamp("2026-07-01 12:00"))
        assert utc[local_noon] == pd.Timestamp("2026-07-01 10:00", tz="UTC")

    def test_madrid_winter_shifts_one_hour(self):
        idx = _naive_hourly("2026-01-10", 2)  # CET = UTC+1
        utc = _weather_index_to_utc(idx, "Europe/Madrid")
        local_noon = idx.get_loc(pd.Timestamp("2026-01-10 12:00"))
        assert utc[local_noon] == pd.Timestamp("2026-01-10 11:00", tz="UTC")

    def test_utc_zone_is_identity(self):
        idx = _naive_hourly("2026-07-01", 1)
        utc = _weather_index_to_utc(idx, "UTC")
        assert (utc == idx.tz_localize("UTC")).all()

    def test_unknown_zone_falls_back_to_utc(self):
        idx = _naive_hourly("2026-07-01", 1)
        utc = _weather_index_to_utc(idx, "Not/AZone")
        assert (utc == idx.tz_localize("UTC")).all()

    def test_already_aware_index_only_converts(self):
        idx = _naive_hourly("2026-07-01", 1).tz_localize("Europe/Madrid")
        utc = _weather_index_to_utc(idx, "UTC")  # tz arg must be ignored
        assert utc[12] == pd.Timestamp("2026-07-01 10:00", tz="UTC")

    def test_peak_lands_at_solar_noon_regardless_of_plant_tz_column(self):
        """The founder's regression: with the weather built in Madrid local
        time, converting with the CORRECT zone puts the POA peak near solar
        noon UTC — and the (possibly wrong) Plant.timezone column must play
        no part in the result."""
        idx = _naive_hourly("2026-07-01", 3)
        hours = idx.hour.to_numpy()
        # POA bell peaking at 14:00 LOCAL (typical Madrid solar noon CEST).
        poa = np.clip(np.sin((hours - 6) / 16 * np.pi), 0, None) * 900

        utc = _weather_index_to_utc(idx, "Europe/Madrid")
        series = pd.Series(poa, index=utc)
        peak_utc_hour = series.groupby(series.index.hour).mean().idxmax()
        assert 11 <= peak_utc_hour <= 13, (
            f"POA peak at {peak_utc_hour}:00 UTC — a wrong-zone conversion "
            f"(the old Plant.timezone='UTC' path) would leave it at 14:00"
        )


class TestClockOffsetDetection:
    def _weather_df(self, days: int = 20) -> pd.DataFrame:
        idx = _naive_hourly("2026-06-01", days).tz_localize("UTC")
        hours = idx.hour.to_numpy()
        rng = np.random.default_rng(4)
        poa = np.clip(np.sin((hours - 5) / 15 * np.pi), 0, None) * 850
        poa += rng.normal(0, 10, len(poa)).clip(-30, 30)
        return pd.DataFrame({"poa": np.clip(poa, 0, None)}, index=idx)

    def test_detects_one_hour_logger_offset(self):
        wx = self._weather_df()
        # Logger clock runs 1h behind DST local: measured power = POA shifted +1h.
        actual = wx["poa"].shift(freq="1h") * 0.8 / 1000
        shift, best_r, r0 = detect_time_shift(
            wx, actual.index, actual, "poa", pd.Timedelta("1h")
        )
        assert shift == pd.Timedelta("1h")
        assert best_r > r0

    def test_no_offset_detected_when_aligned(self):
        wx = self._weather_df()
        actual = wx["poa"] * 0.8 / 1000
        shift, _best_r, _r0 = detect_time_shift(
            wx, actual.index, actual, "poa", pd.Timedelta("1h")
        )
        assert shift == pd.Timedelta(0)

    def test_applied_shift_realigns_peaks(self):
        wx = self._weather_df()
        actual = wx["poa"].shift(freq="1h") * 0.8 / 1000
        shift, _r, _r0 = detect_time_shift(wx, actual.index, actual, "poa", pd.Timedelta("1h"))
        shifted = wx["poa"].copy()
        shifted.index = shifted.index + shift  # what twin.py applies
        pred_peak = shifted.groupby(shifted.index.hour).mean().idxmax()
        act_peak = actual.groupby(actual.index.hour).mean().idxmax()
        assert abs(int(pred_peak) - int(act_peak)) <= 1
