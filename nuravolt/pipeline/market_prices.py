"""Zone router for the day-ahead price curves the dispatch pipelines run on.

Every market has its own module under nuravolt/markets and its own shape:

- Iberia (ES/PT) clears 24 hourly periods in EUR/MWh. The provider ladder
  (committed OMIE CSV, then ENTSO-E / energy-charts, then a labelled synthetic
  duck curve) lives in nuravolt/markets/iberia.py.
- GB settles 48 half-hourly periods in GBP/MWh and has no synthetic rung at
  all. nuravolt/markets/gb.py returns those from Elexon, or raises.

This module owns none of that ladder. It maps a country or a bidding zone onto
the right provider and normalises the answer to one zone-agnostic shape:

    {date, zone, currency, resolution_minutes, price_source, prices}

``prices`` is the period list at ``resolution_minutes`` resolution: 24 values
for Iberia, 48 for GB. Consumers must derive energy as
``power_kw * resolution_minutes / 60`` and must never assume a period is an
hour.

GB half-hourly prices are never averaged down to hourly here. Intra-hour spread
is exactly what a GB battery trades, so averaging it away would make every
arbitrage benchmark systematically understate the opportunity.

``day_ahead_curve`` / ``range_curves`` / ``synthetic_day_curve`` remain as
deprecated Iberian-only aliases for one release; new code should call
``day_ahead_periods``.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

from nuravolt.markets import SUPPORTED_ZONES as ENTSOE_ZONES
from nuravolt.markets import iberia
from nuravolt.markets.errors import PriceFetchError

# Re-exported so the historical `from nuravolt.pipeline.market_prices import
# synthetic_day_curve` (and the tuning constants) keep working.
from nuravolt.markets.iberia import (  # noqa: F401
    BASE_EUR_MWH,
    NIGHT_EUR_MWH,
    PEAK_EUR_MWH,
    SOLAR_DIP_EUR_MWH,
    synthetic_day_curve,
)

HOURLY_MINUTES = 60
GB_SETTLEMENT_MINUTES = 30

# Bidding zone -> (settlement currency, period length in minutes). Everything
# ENTSO-E serves for us clears hourly in euro; GB settles half-hourly in
# sterling.
ZONE_SPECS: Dict[str, Tuple[str, int]] = {
    zone: ("EUR", HOURLY_MINUTES) for zone in ENTSOE_ZONES
}
ZONE_SPECS["GB"] = ("GBP", GB_SETTLEMENT_MINUTES)

# Zones whose real shape the Iberian synthetic duck curve is allowed to stand
# in for. It is an Iberian shape; letting it cover a French or Polish gap would
# be a fabricated curve wearing another market's label.
SYNTHETIC_ZONES = {"ES", "PT"}

# ISO 3166-1 alpha-2 country -> bidding zone, for the unambiguous cases only.
#
# IT is deliberately absent: Italy is split into several bidding zones and
# IT-NORTH is only one of them, so a country-level mapping would price a
# Sicilian asset off northern prices.
#
# GB covers the GB transmission system only. Northern Ireland trades on the
# all-island SEM, which no module here serves, so IE and the NI part of the UK
# are absent rather than silently routed to GB.
ZONE_BY_COUNTRY: Dict[str, str] = {
    "ES": "ES",
    "PT": "PT",
    "GB": "GB",
    "FR": "FR",
    "BE": "BE",
    "NL": "NL",
    "DE": "DE-LU",  # the DE-LU zone covers both countries
    "LU": "DE-LU",
    "AT": "AT",
    "PL": "PL",
    "GR": "GR",
}


def zone_for_country(country: Optional[str]) -> Optional[str]:
    """Bidding zone for an ISO country code, or None when it is not mapped.

    Returns None rather than guessing so the caller decides what to do with an
    asset in a market this repo has no prices for.
    """
    if not country:
        return None
    return ZONE_BY_COUNTRY.get(str(country).strip().upper())


def zone_spec(zone: str) -> Tuple[str, int]:
    """(currency, resolution_minutes) for a bidding zone."""
    z = (zone or "").strip().upper()
    if z not in ZONE_SPECS:
        raise ValueError(
            f"Unsupported bidding zone {zone!r}; known zones: {sorted(ZONE_SPECS)}"
        )
    return ZONE_SPECS[z]


def periods_per_day(zone: str) -> int:
    """Number of settlement periods in a normal day for a zone (24 or 48)."""
    return 1440 // zone_spec(zone)[1]


# ---------------------------------------------------------------------------
# Per-zone providers


def _gb_periods(day: date, session=None, use_cache: bool = True) -> Dict[str, object]:
    """48 half-hourly GBP/MWh periods for one UTC day, or raise.

    A UTC day always holds exactly 48 half-hour periods (the 46/50-period days
    are GB *local* settlement days, and the Elexon fetch is bounded in UTC), so
    a short day means a period is missing upstream. That is refused rather than
    padded: a 47-value list would shift every later slot index by half an hour
    and misprice the dispatch.
    """
    from nuravolt.markets import gb

    try:
        df = gb.fetch_day_ahead_prices("GB", day, day, session=session, use_cache=use_cache)
    except ImportError:
        # The monthly cache writes parquet, which needs pyarrow, and pyarrow is
        # only in the optional `lake` extra. A missing cache engine must cost a
        # refetch, not the prices.
        df = gb.fetch_day_ahead_prices("GB", day, day, session=session, use_cache=False)
    expected = 1440 // GB_SETTLEMENT_MINUTES
    if len(df) != expected:
        raise PriceFetchError(
            f"GB {day.isoformat()} came back with {len(df)} settlement periods, not "
            f"{expected}. A partial day is refused rather than padded, because a "
            "short list shifts every later period and misprices the dispatch."
        )
    return {
        "date": day.isoformat(),
        "zone": "GB",
        "currency": str(df.attrs.get("currency", "GBP")),
        "resolution_minutes": int(df.attrs.get("resolution_minutes", GB_SETTLEMENT_MINUTES)),
        "price_source": str(df.attrs.get("price_source", "elexon_mid")),
        "prices": [round(float(v), 2) for v in df["price_gbp_mwh"].to_numpy()],
    }


def _euro_periods(day: date, zone: str, allow_synthetic: bool) -> Dict[str, object]:
    """EUR/MWh periods from the Iberian ladder. 24 hourly ones today.

    The period length is derived from the array the ladder returns rather than
    assumed to be an hour. Europe is migrating the day-ahead market to a
    15-minute MTU, so the day a provider starts serving 96 values, labelling
    them hourly would price every quarter hour as a full one and overstate
    revenue fourfold. Deriving it means the mislabel cannot happen; a length
    that is not a whole number of equal periods is refused outright, because a
    curve with no period length cannot be turned into energy at all.
    """
    curve = iberia.day_ahead_curve(
        day, zone, allow_synthetic=allow_synthetic and zone in SYNTHETIC_ZONES
    )
    prices = [float(p) for p in curve["prices_eur_mwh"]]
    if not prices or 1440 % len(prices):
        raise PriceFetchError(
            f"{zone} {day.isoformat()} came back with {len(prices)} price periods, which "
            "do not divide a 1440-minute day evenly. A curve whose period length cannot "
            "be established is refused rather than assumed to be hourly."
        )
    return {
        "date": str(curve["date"]),
        "zone": zone,
        "currency": "EUR",
        "resolution_minutes": 1440 // len(prices),
        "price_source": str(curve["price_source"]),
        "prices": prices,
    }


# ---------------------------------------------------------------------------
# Router


def day_ahead_periods(
    day: date,
    zone: str = "ES",
    allow_synthetic: bool = True,
    session=None,
    use_cache: bool = True,
) -> Dict[str, object]:
    """Settlement-period prices for one day in whatever shape the zone uses.

    Returns {date, zone, currency, resolution_minutes, price_source, prices}.
    ``prices`` holds one value per settlement period: 24 hourly EUR/MWh for the
    Iberian zones, 48 half-hourly GBP/MWh for GB.

    ``allow_synthetic`` only reaches the Iberian ladder, and only for ES/PT.
    There is no synthetic GB curve and there never will be (see the honesty
    note in nuravolt/markets/gb.py), so a GB day with no published prices
    raises PriceFetchError.
    """
    z = (zone or "").strip().upper()
    zone_spec(z)  # validates
    if z == "GB":
        return _gb_periods(day, session=session, use_cache=use_cache)
    return _euro_periods(day, z, allow_synthetic)


def range_periods(
    start: date,
    days: int,
    zone: str = "ES",
    allow_synthetic: bool = True,
) -> List[Dict[str, object]]:
    """day_ahead_periods over a run of consecutive days."""
    return [
        day_ahead_periods(start + timedelta(days=i), zone, allow_synthetic)
        for i in range(days)
    ]


# ---------------------------------------------------------------------------
# Deprecated Iberian-only aliases (one release)


def price_source() -> str:
    """Configured best-available Iberian provider (per-day curves may fall back)."""
    return iberia.price_source()


def day_ahead_curve(day: date, zone: str = "ES", allow_synthetic: bool = True) -> Dict[str, object]:
    """DEPRECATED: hourly EUR/MWh curve with the legacy ``prices_eur_mwh`` key.

    Kept for one release so the existing pipeline call sites keep working. Use
    ``day_ahead_periods`` instead: it carries the currency and the period
    length, which this shape cannot.

    Raises ValueError for a zone that does not settle hourly in euro, because
    a ``prices_eur_mwh`` key holding GBP half-hours would be a lie in two ways.
    """
    z = (zone or "").strip().upper()
    currency, resolution = zone_spec(z)
    if currency != "EUR" or resolution != HOURLY_MINUTES:
        raise ValueError(
            f"day_ahead_curve() is hourly-euro only and {z} settles in {currency} at "
            f"{resolution}-minute resolution. Call day_ahead_periods() instead."
        )
    return iberia.day_ahead_curve(
        day, z, allow_synthetic=allow_synthetic and z in SYNTHETIC_ZONES
    )


def range_curves(start: date, days: int, zone: str = "ES",
                 allow_synthetic: bool = True) -> List[Dict[str, object]]:
    """DEPRECATED: see day_ahead_curve. Use range_periods."""
    return [day_ahead_curve(start + timedelta(days=i), zone, allow_synthetic)
            for i in range(days)]


__all__ = [
    "GB_SETTLEMENT_MINUTES",
    "HOURLY_MINUTES",
    "PriceFetchError",
    "SYNTHETIC_ZONES",
    "ZONE_BY_COUNTRY",
    "ZONE_SPECS",
    "day_ahead_curve",
    "day_ahead_periods",
    "periods_per_day",
    "price_source",
    "range_curves",
    "range_periods",
    "synthetic_day_curve",
    "zone_for_country",
    "zone_spec",
]
