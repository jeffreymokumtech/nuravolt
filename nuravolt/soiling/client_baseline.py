"""Day-1 universal soiling forecast for any client plant.

This is the **portable** soiling baseline — given only a plant's
coordinates (+ optional metadata), produce a defensible daily soiling
forecast without any training data, sensor history, or DustIQ ground
truth. The output is suitable for the platform's "soiling tab" from
minute one of onboarding.

Two layers, both shipped here:

1. **Climate-prior baseline** (`climate_prior_forecast`)
   Uses the existing per-zone climatology from
   ``nuravolt/soiling/climate_regions.py`` (Mediterranean, MENA, Sahel,
   Indian subcontinent, SW US desert, North Africa desert, temperate
   continental — each backed by literature). Output: monthly soiling
   rate (%/day) interpolated per requested date.

2. **NREL Soiling Map augmentation** (`nrel_site_lookup`)
   For US plants, find the nearest NREL Soiling Map site (146 US sites
   with per-month observed rates) and return its rate as a higher-
   resolution overlay on the climate prior. Empty for non-US plants.

The two compose: when a US plant onboards, the forecast blends the
climate prior with the nearest NREL site's observed rates, weighted
toward NREL as distance decreases. Outside the US, climate prior alone.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import List, Optional

import polars as pl

from .climate_regions import (
    ClimatePrior,
    ClimateZone,
    CLIMATE_PRIORS,
    prior_for_plant,
    resolve_zone,
)


NREL_SOILING_CSV = Path("backenddata/datasets/nrel_soiling_map/nrel_soiling_monthly.csv")


@dataclass
class NrelNearestSite:
    site_id: str
    lat: float
    lon: float
    distance_km: float
    monthly_rate_pct_per_day: List[float]   # 12 entries (Jan..Dec); None-filled if month missing


@dataclass
class SoilingDay:
    date: date
    expected_rate_pct_per_day: float    # blended forecast
    climate_prior_rate: float           # what the zone prior alone would have said
    nrel_overlay_rate: Optional[float]  # what the nearest NREL site says (if any)
    rain_recovery_threshold_mm: float
    dust_source: str
    zone: ClimateZone


@dataclass
class ClientSoilingForecast:
    plant_id: Optional[str]
    latitude: float
    longitude: float
    zone: ClimateZone
    prior_provenance: str       # short string explaining where the numbers come from
    nrel_site: Optional[NrelNearestSite]
    days: List[SoilingDay]

    def summary(self) -> dict:
        rates = [d.expected_rate_pct_per_day for d in self.days]
        return {
            "plant_id": self.plant_id,
            "lat": self.latitude,
            "lon": self.longitude,
            "zone": self.zone.value,
            "horizon_days": len(self.days),
            "mean_daily_rate_pct": round(sum(rates) / max(1, len(rates)), 4),
            "min_daily_rate_pct": round(min(rates), 4) if rates else None,
            "max_daily_rate_pct": round(max(rates), 4) if rates else None,
            "nrel_overlay_active": self.nrel_site is not None,
            "nrel_site_id": self.nrel_site.site_id if self.nrel_site else None,
            "nrel_site_distance_km": round(self.nrel_site.distance_km, 1) if self.nrel_site else None,
            "prior_provenance": self.prior_provenance,
        }


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    from math import asin, cos, radians, sin, sqrt
    R = 6371.0
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlam = radians(lon2 - lon1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlam / 2) ** 2
    return 2 * R * asin(sqrt(a))


def nrel_site_lookup(
    latitude: float,
    longitude: float,
    max_distance_km: float = 500.0,
    csv_path: Path = NREL_SOILING_CSV,
) -> Optional[NrelNearestSite]:
    """Find the closest NREL Soiling Map site within ``max_distance_km``.

    Returns None for plants outside the US footprint (all NREL Map sites
    are continental US) or when no site falls inside the radius.
    """
    if not csv_path.exists():
        return None

    df = pl.read_csv(csv_path)
    # Schema: site_id, latitude, longitude, month, soiling_rate_per_day, ...
    # Some sites have month=13 as the all-year aggregate. Filter to 1-12.
    df = df.filter((pl.col("month") >= 1) & (pl.col("month") <= 12))

    # Unique site coordinates
    sites = df.unique(subset=["site_id"], maintain_order=True)[["site_id", "latitude", "longitude"]]
    best: Optional[NrelNearestSite] = None
    best_dist = max_distance_km
    for row in sites.iter_rows(named=True):
        d = _haversine_km(latitude, longitude, row["latitude"], row["longitude"])
        if d < best_dist:
            best_dist = d
            best = NrelNearestSite(
                site_id=str(row["site_id"]),
                lat=float(row["latitude"]),
                lon=float(row["longitude"]),
                distance_km=d,
                monthly_rate_pct_per_day=[0.0] * 12,
            )

    if best is None:
        return None

    # Populate monthly rate from this site's CSV rows
    site_rows = df.filter(pl.col("site_id") == best.site_id).sort("month")
    # NREL publishes negative rates (loss); convert to positive %/day
    rates_by_month: dict[int, list[float]] = {}
    for r in site_rows.iter_rows(named=True):
        m = int(r["month"])
        rate = r["soiling_rate_per_day"]
        if rate is None or rate >= 0:
            continue
        rates_by_month.setdefault(m, []).append(-float(rate) * 100)

    monthly = []
    for m in range(1, 13):
        vals = rates_by_month.get(m, [])
        monthly.append(round(sum(vals) / len(vals), 4) if vals else 0.0)
    best.monthly_rate_pct_per_day = monthly
    return best


def _interpolate_monthly_to_daily(
    monthly: List[float],
    start: date,
    horizon_days: int,
) -> List[float]:
    """Convert 12 monthly rates into a daily forecast across the horizon.

    Each calendar date returns the rate for that month — simple
    step-function (no smoothing). The monthly rate is a fair representation
    of expected rate for any day in that month.
    """
    out = []
    d = start
    for _ in range(horizon_days):
        out.append(monthly[d.month - 1])
        d = d + timedelta(days=1)
    return out


def climate_prior_forecast(
    latitude: float,
    longitude: float,
    plant_id: Optional[str] = None,
    horizon_days: int = 365,
    start: Optional[date] = None,
    nrel_blend_weight: float = 0.6,
    nrel_max_distance_km: float = 300.0,
) -> ClientSoilingForecast:
    """Generate a full N-day soiling forecast for any plant.

    Args:
        latitude / longitude: required. Used for climate zone resolution
            and NREL nearest-site lookup.
        plant_id: optional. If set and present in PLANT_CLIMATE, takes
            precedence over lat/lon zone inference.
        horizon_days: forecast length in days.
        start: first day of forecast. Defaults to today.
        nrel_blend_weight: when an NREL site is within range, the final
            rate is `w * NREL + (1-w) * climate_prior`. Default 0.6 favours
            the more specific NREL signal but keeps climate as the backbone.
            Set to 0 to ignore NREL even when available.
        nrel_max_distance_km: cap for NREL lookup. >300 km drops to climate
            prior only — we don't trust distant sites' rates.

    Returns a `ClientSoilingForecast` with per-day rates and provenance.
    """
    if start is None:
        # Caller can pass a fixed date for deterministic tests; default to
        # the calendar today.
        from datetime import date as _date
        start = _date.today()

    zone = resolve_zone(plant_id or "", latitude, longitude)
    prior: ClimatePrior = CLIMATE_PRIORS[zone]
    prior_monthly_pct = list(prior.monthly_soiling_rate_pct_day)  # already in %/day

    nrel_site: Optional[NrelNearestSite] = None
    if nrel_blend_weight > 0:
        nrel_site = nrel_site_lookup(
            latitude, longitude,
            max_distance_km=nrel_max_distance_km,
        )

    # Build per-day forecast
    days: List[SoilingDay] = []
    climate_daily = _interpolate_monthly_to_daily(prior_monthly_pct, start, horizon_days)
    nrel_daily = (
        _interpolate_monthly_to_daily(nrel_site.monthly_rate_pct_per_day, start, horizon_days)
        if nrel_site else [None] * horizon_days
    )

    for i, d in enumerate([start + timedelta(days=k) for k in range(horizon_days)]):
        cp = climate_daily[i]
        nrel_rate = nrel_daily[i]
        if nrel_rate is not None and nrel_rate > 0:
            blended = nrel_blend_weight * nrel_rate + (1 - nrel_blend_weight) * cp
        else:
            blended = cp
        days.append(SoilingDay(
            date=d,
            expected_rate_pct_per_day=round(blended, 4),
            climate_prior_rate=round(cp, 4),
            nrel_overlay_rate=round(nrel_rate, 4) if nrel_rate else None,
            rain_recovery_threshold_mm=prior.recovery_threshold_mm,
            dust_source=prior.dominant_dust_source,
            zone=zone,
        ))

    provenance = f"climate_prior:{zone.value}"
    if nrel_site:
        provenance += f"+nrel:{nrel_site.site_id}@{nrel_site.distance_km:.0f}km"

    return ClientSoilingForecast(
        plant_id=plant_id,
        latitude=latitude,
        longitude=longitude,
        zone=zone,
        prior_provenance=provenance,
        nrel_site=nrel_site,
        days=days,
    )
