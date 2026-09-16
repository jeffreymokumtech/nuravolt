"""Physics-based soiling forecast via pvlib (HSU + Kimber models).

This is the **physics layer** that sits on top of the climate-prior
baseline (`client_baseline.climate_prior_forecast`). Given:

  - rainfall time series (mm/day)
  - optional PM2.5 / PM10 (μg/m³, from CAMS or local sensors)
  - panel tilt
  - climate-zone-derived cleaning-threshold + loss rate priors

it produces a per-day soiling-ratio forecast using pvlib's published
models (HSU = particulate-driven, Kimber = simple-decay-with-rain).
Both are published baselines we can defend.

When weather inputs are unavailable, the function falls back to the
climate prior alone — so the function is always callable, never blocks.

This is universal — no training data, no client labels, works minute one
for any plant with coordinates + (ideally) a weather feed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import List, Optional

import numpy as np
import pandas as pd
from pvlib import soiling as pvlib_soiling

from .client_baseline import ClientSoilingForecast, SoilingDay, climate_prior_forecast
from .climate_regions import CLIMATE_PRIORS, ClimateZone, resolve_zone


@dataclass
class PvlibForecastDay:
    date: date
    soiling_ratio: float          # 0..1 (1.0 = clean, 0.85 = 15% loss)
    rate_pct_per_day: float       # equivalent %/day for comparability with the climate prior
    rainfall_mm: float
    rain_reset: bool              # True if rain >= cleaning threshold this day
    method: str                   # "kimber" or "hsu"


def kimber_forecast(
    latitude: float,
    longitude: float,
    rainfall_mm_per_day: List[float],
    start: date,
    plant_id: Optional[str] = None,
    surface_tilt: float = 30.0,
    overrides: Optional[dict] = None,
) -> List[PvlibForecastDay]:
    """Run Kimber soiling model over a rainfall series.

    Args:
        latitude, longitude: required for climate-zone defaults (cleaning
            threshold + loss rate).
        rainfall_mm_per_day: list of mm/day values, one per day in the horizon.
        start: first day of forecast.
        plant_id: optional override key for climate registry.
        surface_tilt: panel tilt in degrees (informational; Kimber doesn't use it).
        overrides: optional dict to override climate-prior defaults:
            ``cleaning_threshold`` (mm), ``soiling_loss_rate`` (fraction/day),
            ``max_soiling`` (fraction).

    Returns one ``PvlibForecastDay`` per input day.
    """
    zone = resolve_zone(plant_id or "", latitude, longitude)
    prior = CLIMATE_PRIORS[zone]
    overrides = overrides or {}

    cleaning_threshold = overrides.get("cleaning_threshold", prior.recovery_threshold_mm)
    # Convert climate prior's %/day (mean across year) → fraction/day for Kimber
    annual_mean_pct = sum(prior.monthly_soiling_rate_pct_day) / 12
    soiling_loss_rate = overrides.get("soiling_loss_rate", annual_mean_pct / 100)
    max_soiling = overrides.get("max_soiling", 0.30)
    grace_period = overrides.get("grace_period", 14)

    n = len(rainfall_mm_per_day)
    if n == 0:
        return []

    index = pd.date_range(start=pd.Timestamp(start), periods=n, freq="D")
    rain_series = pd.Series(rainfall_mm_per_day, index=index, dtype=float)

    # pvlib.kimber returns *loss* fraction (0=clean, 0.3=30% loss), grace period is days
    loss = pvlib_soiling.kimber(
        rainfall=rain_series,
        cleaning_threshold=cleaning_threshold,
        soiling_loss_rate=soiling_loss_rate,
        grace_period=grace_period,
        max_soiling=max_soiling,
    )

    out: List[PvlibForecastDay] = []
    for i, ts in enumerate(index):
        sr = 1.0 - float(loss.iloc[i])
        rain = float(rain_series.iloc[i])
        # Rate %/day at this point = (previous SR - current SR) × 100
        prev_sr = 1.0 if i == 0 else (1.0 - float(loss.iloc[i - 1]))
        rate_pct = max(0.0, (prev_sr - sr) * 100)
        out.append(PvlibForecastDay(
            date=ts.date(),
            soiling_ratio=round(sr, 4),
            rate_pct_per_day=round(rate_pct, 4),
            rainfall_mm=rain,
            rain_reset=rain >= cleaning_threshold,
            method="kimber",
        ))
    return out


def hsu_forecast(
    latitude: float,
    longitude: float,
    rainfall_mm_per_day: List[float],
    pm2_5_g_per_m3: List[float],
    pm10_g_per_m3: List[float],
    start: date,
    plant_id: Optional[str] = None,
    surface_tilt: float = 30.0,
    overrides: Optional[dict] = None,
) -> List[PvlibForecastDay]:
    """Run the HSU (Humboldt) soiling model — particulate-driven.

    HSU is more accurate than Kimber in dusty climates because it uses
    PM2.5 + PM10 inputs (which can come from CAMS forecast or local
    sensors). Falls back to Kimber-style if PM data missing.

    Args mirror ``kimber_forecast`` plus PM time series. PM units are
    g/m³ (pvlib convention) — convert from μg/m³ by dividing by 1e6.
    """
    n = len(rainfall_mm_per_day)
    if n == 0 or len(pm2_5_g_per_m3) != n or len(pm10_g_per_m3) != n:
        raise ValueError("rainfall / pm2_5 / pm10 series must align in length")

    zone = resolve_zone(plant_id or "", latitude, longitude)
    prior = CLIMATE_PRIORS[zone]
    overrides = overrides or {}
    cleaning_threshold = overrides.get("cleaning_threshold", prior.recovery_threshold_mm)

    index = pd.date_range(start=pd.Timestamp(start), periods=n, freq="D")
    rain_series = pd.Series(rainfall_mm_per_day, index=index, dtype=float)
    pm2_5_series = pd.Series(pm2_5_g_per_m3, index=index, dtype=float)
    pm10_series = pd.Series(pm10_g_per_m3, index=index, dtype=float)

    sr_series = pvlib_soiling.hsu(
        rainfall=rain_series,
        cleaning_threshold=cleaning_threshold,
        surface_tilt=surface_tilt,
        pm2_5=pm2_5_series,
        pm10=pm10_series,
        rain_accum_period=pd.Timedelta("1 day"),
    )

    out: List[PvlibForecastDay] = []
    for i, ts in enumerate(index):
        sr = float(sr_series.iloc[i])
        rain = float(rain_series.iloc[i])
        prev_sr = 1.0 if i == 0 else float(sr_series.iloc[i - 1])
        rate_pct = max(0.0, (prev_sr - sr) * 100)
        out.append(PvlibForecastDay(
            date=ts.date(),
            soiling_ratio=round(sr, 4),
            rate_pct_per_day=round(rate_pct, 4),
            rainfall_mm=rain,
            rain_reset=rain >= cleaning_threshold,
            method="hsu",
        ))
    return out


def universal_forecast(
    latitude: float,
    longitude: float,
    horizon_days: int = 365,
    rainfall_mm_per_day: Optional[List[float]] = None,
    pm2_5_g_per_m3: Optional[List[float]] = None,
    pm10_g_per_m3: Optional[List[float]] = None,
    plant_id: Optional[str] = None,
    start: Optional[date] = None,
    surface_tilt: float = 30.0,
) -> ClientSoilingForecast:
    """The single entry point for "give me a soiling forecast for ANY plant".

    Resolution order (best-available wins):

    1. **HSU model** if rainfall + PM2.5 + PM10 all provided → published
       physics, most accurate in dusty climates.
    2. **Kimber model** if only rainfall provided → still physics, simpler.
    3. **Climate prior alone** if no weather data → literature-derived
       monthly rates by zone, augmented by NREL Map for US plants.

    Returns the same ``ClientSoilingForecast`` shape as the climate-prior
    baseline so downstream code (UI, optimizer) treats them
    interchangeably. The ``prior_provenance`` field documents which path
    was taken.
    """
    if start is None:
        from datetime import date as _date
        start = _date.today()

    # If no weather → climate prior is the answer
    if rainfall_mm_per_day is None:
        return climate_prior_forecast(
            latitude=latitude,
            longitude=longitude,
            plant_id=plant_id,
            horizon_days=horizon_days,
            start=start,
        )

    # Decide pvlib variant
    if pm2_5_g_per_m3 is not None and pm10_g_per_m3 is not None:
        days_pvlib = hsu_forecast(
            latitude, longitude, rainfall_mm_per_day,
            pm2_5_g_per_m3, pm10_g_per_m3,
            start=start, plant_id=plant_id, surface_tilt=surface_tilt,
        )
        method = "hsu"
    else:
        days_pvlib = kimber_forecast(
            latitude, longitude, rainfall_mm_per_day,
            start=start, plant_id=plant_id, surface_tilt=surface_tilt,
        )
        method = "kimber"

    # Wrap as ClientSoilingForecast so callers don't branch on method
    zone = resolve_zone(plant_id or "", latitude, longitude)
    prior = CLIMATE_PRIORS[zone]
    # Build climate prior for comparison
    climate_baseline = climate_prior_forecast(
        latitude=latitude,
        longitude=longitude,
        plant_id=plant_id,
        horizon_days=len(days_pvlib),
        start=start,
    )

    soiling_days: List[SoilingDay] = []
    for i, p in enumerate(days_pvlib):
        cp_rate = climate_baseline.days[i].climate_prior_rate
        soiling_days.append(SoilingDay(
            date=p.date,
            expected_rate_pct_per_day=p.rate_pct_per_day,
            climate_prior_rate=cp_rate,
            nrel_overlay_rate=climate_baseline.days[i].nrel_overlay_rate,
            rain_recovery_threshold_mm=prior.recovery_threshold_mm,
            dust_source=prior.dominant_dust_source,
            zone=zone,
        ))

    return ClientSoilingForecast(
        plant_id=plant_id,
        latitude=latitude,
        longitude=longitude,
        zone=zone,
        prior_provenance=f"pvlib:{method}+climate_prior:{zone.value}",
        nrel_site=climate_baseline.nrel_site,
        days=soiling_days,
    )
