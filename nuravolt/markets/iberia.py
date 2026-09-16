"""Iberian (ES/PT) market data: day-ahead curves and imbalance prices.

Day-ahead provider ladder, best first:

- The committed OMIE CSV at ``public/data/prices/omie_es_2025-2026.csv``
  (~12 months of real hourly ES+PT clearing prices). Preferred wherever a date
  is covered so BESS dispatch and revenue are grounded in real market data
  without an ENTSO-E token.
- Live providers via nuravolt/markets/entsoe.py (ENTSO-E A44 when
  ENTSOE_API_TOKEN is set, else the token-free energy-charts.info fallback).
- A clearly labelled synthetic Iberian duck curve, for future days beyond the
  day-ahead horizon and for network trouble. Every curve carries
  ``price_source`` so downstream surfaces disclose the provenance honestly.
  Pass ``allow_synthetic=False`` to turn the last rung off.

Every rung returns the periods it actually has, plus the ``resolution_minutes``
those periods run at, derived from the period count rather than assumed. The
OMIE CSV and the synthetic curve are hourly (24 periods). The live providers
are not: energy-charts already serves ES/PT at the 15-minute MTU Europe is
migrating the day-ahead market to, which is 96 periods a day. Curves are never
truncated to 24 values, because slicing the first 24 of 96 quarter hours
returns 00:00 to 06:00 while still carrying a real provider's name. Callers
that genuinely need 24 hourly numbers call ``hourly_day_curve``, which says so.

Imbalance prices use ENTSO-E documentType A85 against the ES and PT control
areas. WARNING: the A85 response shape below is UNVERIFIED. There is no
ENTSO-E token in this environment, so the parser was written from the
documented Balancing_MarketDocument shape and has never seen a live payload.
It must be checked against a real token before any number it produces is shown
to a user or used in revenue arithmetic. Do not treat its output as measured
until that check is done.
"""

from __future__ import annotations

import math
import os
import random
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import pandas as pd
import requests

from nuravolt.markets._cache import as_date
from nuravolt.markets.errors import PriceFetchError

MINUTES_PER_DAY = 1440
HOURLY_MINUTES = 60

BASE_EUR_MWH = 62.0
PEAK_EUR_MWH = 112.0
SOLAR_DIP_EUR_MWH = 34.0
NIGHT_EUR_MWH = 46.0

ENTSOE_API_URL = "https://web-api.tp.entsoe.eu/api"

# ENTSO-E control areas for imbalance (A85). Note these are queried with
# controlArea_Domain, NOT the in_Domain/out_Domain pair the A44 day-ahead
# query uses: imbalance is settled per control area, not per bidding-zone
# border.
IMBALANCE_CONTROL_AREAS = {
    "ES": "10YES-REE------0",
    "PT": "10YPT-REN------W",
}

# Committed real OMIE Iberian day-ahead prices (EUR/MWh), ~12 months hourly for
# ES+PT.
OMIE_CSV = Path(__file__).resolve().parents[2] / "public/data/prices/omie_es_2025-2026.csv"

_REQUEST_TIMEOUT = 60

# Accept both env spellings; the ENTSO-E client reads ENTSOE_API_TOKEN.
_TOKEN = os.environ.get("ENTSOE_API_TOKEN") or os.environ.get("ENTSOE_TOKEN")

_OMIE_CACHE: Optional[Dict[str, Dict[str, List[float]]]] = None


# ---------------------------------------------------------------------------
# Period length


def resolution_minutes_for(period_count: int) -> int:
    """Minutes per settlement period, derived from how many a day carries.

    24 periods is hourly, 48 is half-hourly, 96 is the 15-minute MTU. Derived,
    never assumed: energy-charts already serves ES/PT at 96 values a day, and a
    curve labelled hourly on faith would price every quarter hour as a full one
    and overstate the energy behind it fourfold.

    Raises PriceFetchError for any other count. A day that does not split into
    equal periods aligned to whole hours has no usable period length, and the
    tempting repair (take the first 24 values) does not return a day at all: it
    returns the first quarter of one, wearing a full-day label.
    """
    if period_count <= 0 or period_count % 24 or MINUTES_PER_DAY % period_count:
        raise PriceFetchError(
            f"A day of {period_count} price periods does not divide 1440 minutes into "
            "equal periods aligned to whole hours, so the period length cannot be "
            "established. Refused rather than truncated to the first 24 values."
        )
    return MINUTES_PER_DAY // period_count


def to_hourly(prices: Sequence[float]) -> List[float]:
    """Downsample one day of sub-hourly prices to 24 hourly values.

    This is a deliberate, lossy downsample, and it exists only for the legacy
    callers whose shape is 24 hours (see ``hourly_day_curve``). The mean is the
    correct operator for a price: the cost of holding constant power across the
    hour is the mean of that hour's sub-period prices. Taking the first
    sub-period of each hour would report a different instant's price, and
    taking the first 24 sub-periods of the day would report six hours of it.

    Intra-hour spread is destroyed here, which is exactly what a battery
    trades, so anything sizing arbitrage must use the native curve instead.
    """
    resolution_minutes_for(len(prices))  # refuses a day with no period length
    per_hour = len(prices) // 24
    if per_hour == 1:
        return [round(float(p), 2) for p in prices]
    return [
        round(sum(float(p) for p in prices[h * per_hour:(h + 1) * per_hour]) / per_hour, 2)
        for h in range(24)
    ]


# ---------------------------------------------------------------------------
# OMIE provider (committed CSV)


def load_omie() -> Dict[str, Dict[str, List[float]]]:
    """Parse the OMIE CSV into {zone: {date_iso: [24 hourly EUR/MWh]}}.

    Only full 24-hour days are kept — DST 23/25-hour days fall through to the
    next rung rather than misaligning the dispatch hours. Parsed once.
    """
    global _OMIE_CACHE
    if _OMIE_CACHE is not None:
        return _OMIE_CACHE
    by_day: Dict[str, Dict[str, Dict[int, float]]] = {"ES": {}, "PT": {}}
    try:
        with open(OMIE_CSV, "r") as fh:
            next(fh, None)  # header: time,eur_per_mwh_es,eur_per_mwh_pt
            for line in fh:
                parts = line.strip().split(",")
                if len(parts) < 3:
                    continue
                ts, es_s, pt_s = parts[0], parts[1], parts[2]
                if len(ts) < 13:
                    continue
                d, hh = ts[:10], ts[11:13]
                try:
                    hour = int(hh)
                    es_v, pt_v = float(es_s), float(pt_s)
                except ValueError:
                    continue
                by_day["ES"].setdefault(d, {})[hour] = es_v
                by_day["PT"].setdefault(d, {})[hour] = pt_v
    except FileNotFoundError:
        _OMIE_CACHE = {"ES": {}, "PT": {}}
        return _OMIE_CACHE

    out: Dict[str, Dict[str, List[float]]] = {"ES": {}, "PT": {}}
    for zone, days in by_day.items():
        for d, hours in days.items():
            if len(hours) == 24:
                out[zone][d] = [round(hours[h], 2) for h in range(24)]
    _OMIE_CACHE = out
    return _OMIE_CACHE


def omie_day_curve(day: date, zone: str) -> Optional[Dict[str, object]]:
    """Real OMIE 24-hour curve for a covered date, else None."""
    prices = load_omie().get(zone, {}).get(day.isoformat())
    if not prices:
        return None
    return {
        "date": day.isoformat(),
        "zone": zone,
        "price_source": "omie",
        "resolution_minutes": HOURLY_MINUTES,
        "prices_eur_mwh": list(prices),
    }


# ---------------------------------------------------------------------------
# Live providers (ENTSO-E A44 / energy-charts) via nuravolt.markets.entsoe


def entsoe_day_curve(day: date, zone: str, api_token: Optional[str] = None) -> Optional[Dict[str, object]]:
    """A full day of EUR/MWh periods from the live providers, or None.

    Returns every period the provider published, at whatever MTU it publishes,
    with the derived ``resolution_minutes``. energy-charts serves ES/PT at the
    15-minute MTU (96 periods), so this is routinely not 24 values.

    Nothing is truncated and nothing is resampled here. Taking the first 24 of
    96 quarter hours returns 00:00 to 06:00 of the day, which reads as a plain
    day-ahead curve and understates the real daily spread severalfold while
    still carrying the provider's name.

    A day whose period count yields no usable period length falls through to
    the next rung (None) rather than being reshaped into something plausible.
    """
    try:
        from nuravolt.markets.entsoe import fetch_day_ahead_prices

        df = fetch_day_ahead_prices(zone, day, day, api_token=api_token or _TOKEN, source="auto")
        if df is None or df.empty:
            return None
        day_df = df[df.index.date == day]
        resolution = resolution_minutes_for(len(day_df))
        prices = [round(float(v), 2) for v in day_df["price_eur_mwh"].to_numpy()]
        return {
            "date": day.isoformat(),
            "zone": zone,
            "price_source": str(df.attrs.get("price_source", price_source())),
            "resolution_minutes": resolution,
            "prices_eur_mwh": prices,
        }
    except Exception:  # noqa: BLE001 — the pipeline must never block on prices
        return None


# ---------------------------------------------------------------------------
# Labelled synthetic curve (last rung)


def synthetic_day_curve(day: date, seed: int = 7) -> List[float]:
    """24 hourly EUR/MWh values with a duck-curve shape."""
    rng = random.Random(seed * 100000 + day.toordinal())
    weekend = day.weekday() >= 5
    softening = 0.82 if weekend else 1.0

    prices: List[float] = []
    for hour in range(24):
        if 0 <= hour < 6:
            base = NIGHT_EUR_MWH + 4 * math.sin(hour / 6 * math.pi)
        elif 6 <= hour < 10:  # morning ramp
            base = NIGHT_EUR_MWH + (PEAK_EUR_MWH - NIGHT_EUR_MWH) * (hour - 6) / 4
        elif 10 <= hour < 16:  # solar dip
            depth = math.sin((hour - 10) / 6 * math.pi)
            base = BASE_EUR_MWH - (BASE_EUR_MWH - SOLAR_DIP_EUR_MWH) * depth
        elif 16 <= hour < 22:  # evening peak
            crest = math.sin((hour - 16) / 6 * math.pi)
            base = BASE_EUR_MWH + (PEAK_EUR_MWH - BASE_EUR_MWH) * crest
        else:
            base = NIGHT_EUR_MWH + 8
        noise = rng.uniform(-4.0, 4.0)
        prices.append(round(max(5.0, base * softening + noise), 2))
    return prices


# ---------------------------------------------------------------------------
# Public API


def price_source() -> str:
    """Configured best-available provider (per-day curves may still fall back)."""
    if load_omie().get("ES"):
        return "omie"
    return "entsoe" if _TOKEN else "energy-charts"


def day_ahead_curve(day: date, zone: str = "ES", allow_synthetic: bool = True) -> Dict[str, object]:
    """EUR/MWh for one day: real OMIE first, then live providers, then synthetic.

    This is the provider-shaped entry point the pipeline router calls. The
    returned dict is
    {date, zone, price_source, resolution_minutes, prices_eur_mwh[N]}.

    N is whatever the winning rung actually publishes: 24 from the OMIE CSV and
    from the synthetic curve, but 96 from a live provider serving the 15-minute
    MTU. ``resolution_minutes`` is derived from N, so the two always agree.
    Consumers must derive energy as ``power_kw * resolution_minutes / 60`` and
    must not index the list by hour. Callers that can only handle 24 hourly
    numbers call ``hourly_day_curve``.

    Raises PriceFetchError when every real rung misses and ``allow_synthetic``
    is False, so callers that must not show a modelled number can say so.
    """
    omie = omie_day_curve(day, zone)
    if omie is not None:
        return omie
    real = entsoe_day_curve(day, zone)
    if real is not None:
        return real
    if not allow_synthetic:
        raise PriceFetchError(
            f"No real Iberian day-ahead prices for {zone} {day.isoformat()} "
            "(OMIE CSV does not cover it and the live providers returned nothing)"
        )
    return {
        "date": day.isoformat(),
        "zone": zone,
        "price_source": "synthetic",
        "resolution_minutes": HOURLY_MINUTES,
        "prices_eur_mwh": synthetic_day_curve(day),
    }


def hourly_day_curve(day: date, zone: str = "ES", allow_synthetic: bool = True) -> Dict[str, object]:
    """``day_ahead_curve`` collapsed to exactly 24 hourly values.

    For the callers whose shape is 24 hours and cannot yet carry a period
    length. When the winning rung is already hourly this is the same curve.
    When it is sub-hourly, each hour becomes the mean of its sub-periods (see
    ``to_hourly``) and ``downsampled_from_minutes`` records the native
    resolution that was averaged away, so the loss is stated rather than
    hidden. ``price_source`` is unchanged: the numbers are still that
    provider's, just aggregated.

    Anything that trades intra-hour spread must use ``day_ahead_curve``.
    """
    curve = day_ahead_curve(day, zone, allow_synthetic=allow_synthetic)
    native = int(curve["resolution_minutes"])
    if native == HOURLY_MINUTES:
        return dict(curve, downsampled_from_minutes=None)
    return {
        "date": curve["date"],
        "zone": curve["zone"],
        "price_source": curve["price_source"],
        "resolution_minutes": HOURLY_MINUTES,
        "downsampled_from_minutes": native,
        "prices_eur_mwh": to_hourly(curve["prices_eur_mwh"]),
    }


def range_curves(start: date, days: int, zone: str = "ES",
                 allow_synthetic: bool = True) -> List[Dict[str, object]]:
    return [day_ahead_curve(start + timedelta(days=i), zone, allow_synthetic) for i in range(days)]


# ---------------------------------------------------------------------------
# Imbalance prices (ENTSO-E A85) — UNVERIFIED SHAPE, see module docstring


# flowDirection.direction codes on a Balancing_MarketDocument TimeSeries.
_FLOW_DIRECTION_COLUMNS = {
    "A01": "imbalance_price_up_eur_mwh",
    "A02": "imbalance_price_down_eur_mwh",
}
# When a TSO publishes one price with no direction tag.
_SINGLE_PRICE_COLUMN = "imbalance_price_eur_mwh"


def _parse_a85_xml(payload: bytes) -> pd.DataFrame:
    """Parse an ENTSO-E Balancing_MarketDocument (A85 imbalance prices).

    A sibling of, not a reuse of, the A44 parser in entsoe.py: A85 has a
    different document root, carries flowDirection.direction on the TimeSeries
    and names the value ``imbalance_Price.amount`` rather than
    ``price.amount``. Spain settles imbalance in 15-minute periods, so the
    Period resolution is read rather than assumed hourly.

    TODO(verify): this parser has never seen a live A85 payload. Check it
    against https://transparency.entsoe.eu (documentType A85, controlArea
    10YES-REE------0) with a real security token before trusting any output.
    """
    root = ET.fromstring(payload)
    ns = {"ns": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}

    def findall(elem, path):
        return elem.findall(path.replace("x:", "ns:" if ns else ""), ns)

    def findtext(elem, path):
        node = elem.find(path.replace("x:", "ns:" if ns else ""), ns)
        return node.text if node is not None else None

    if root.tag.endswith("Acknowledgement_MarketDocument"):
        reason = findtext(root, ".//x:Reason/x:text") or "no data returned"
        raise PriceFetchError(f"ENTSO-E acknowledgement: {reason}")

    columns: Dict[str, Dict[pd.Timestamp, float]] = {}
    resolutions: set = set()
    for ts_elem in findall(root, ".//x:TimeSeries"):
        direction = findtext(ts_elem, "x:flowDirection.direction")
        column = _FLOW_DIRECTION_COLUMNS.get(direction or "", _SINGLE_PRICE_COLUMN)
        curve_type = findtext(ts_elem, "x:curveType") or ""
        for period in findall(ts_elem, ".//x:Period"):
            start_text = findtext(period, "x:timeInterval/x:start")
            resolution = findtext(period, "x:resolution") or "PT60M"
            if start_text is None:
                continue
            period_start = pd.Timestamp(start_text).tz_convert("UTC")
            step = pd.Timedelta(resolution.replace("PT", "").replace("M", "min"))
            resolutions.add(int(step.total_seconds() // 60))
            points = []
            for point in findall(period, "x:Point"):
                pos = findtext(point, "x:position")
                amount = findtext(point, "x:imbalance_Price.amount")
                if pos is None or amount is None:
                    continue
                points.append((int(pos), float(amount)))
            if not points:
                continue
            points.sort()
            slot = columns.setdefault(column, {})
            if curve_type == "A03":
                # Variable-sized blocks: a position holds until the next one.
                last_pos = points[-1][0]
                held = points[0][1]
                cursor = 0
                for pos, amount in points:
                    for i in range(cursor, pos - 1):
                        slot[period_start + i * step] = held
                    held = amount
                    cursor = pos - 1
                slot[period_start + (last_pos - 1) * step] = held
            else:
                for pos, amount in points:
                    slot[period_start + (pos - 1) * step] = amount

    if not columns:
        raise PriceFetchError("ENTSO-E A85 response contained no imbalance price points")

    df = pd.DataFrame({name: pd.Series(values) for name, values in columns.items()}).sort_index()
    df.index.name = "ts"
    df.attrs["resolution_minutes"] = min(resolutions) if resolutions else None
    return df


def fetch_imbalance_prices(
    zone: str,
    start,
    end,
    api_token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> pd.DataFrame:
    """
    Fetch Iberian imbalance settlement prices for ``zone`` over [start, end].

    Args:
        zone: "ES" or "PT" (control areas, see IMBALANCE_CONTROL_AREAS).
        start, end: Date-like bounds, inclusive, interpreted as UTC days.
        api_token: ENTSO-E token; falls back to env ENTSOE_API_TOKEN.
        session: Optional requests.Session (tests inject a mock here).

    Returns:
        DataFrame indexed by UTC timestamps with an
        ``imbalance_price_up_eur_mwh`` / ``imbalance_price_down_eur_mwh``
        column pair (or a single ``imbalance_price_eur_mwh`` when the TSO
        publishes one undirected price), plus attrs price_source, zone,
        currency and resolution_minutes.

    The response shape is unverified (see the module docstring). This function
    is importable and non-crashing, but its output must not be trusted until a
    live token has confirmed the payload.
    """
    if zone not in IMBALANCE_CONTROL_AREAS:
        raise ValueError(
            f"Unsupported imbalance zone {zone!r}; known control areas: "
            f"{sorted(IMBALANCE_CONTROL_AREAS)}"
        )

    start_d, end_d = as_date(start), as_date(end)
    if end_d < start_d:
        raise ValueError("end must be >= start")

    token = api_token or _TOKEN or os.environ.get("ENTSOE_API_TOKEN") or ""
    if not token:
        raise PriceFetchError(
            "Iberian imbalance prices need an ENTSO-E token (arg api_token or env "
            "ENTSOE_API_TOKEN). There is no token-free provider for A85."
        )

    sess = session or requests.Session()
    params = {
        "securityToken": token,
        "documentType": "A85",
        "controlArea_Domain": IMBALANCE_CONTROL_AREAS[zone],
        "periodStart": f"{start_d:%Y%m%d}0000",
        "periodEnd": f"{end_d + timedelta(days=1):%Y%m%d}0000",
    }
    resp = sess.get(ENTSOE_API_URL, params=params, timeout=_REQUEST_TIMEOUT)
    if resp.status_code == 401:
        raise PriceFetchError("ENTSO-E rejected the security token (401)")
    resp.raise_for_status()

    df = _parse_a85_xml(resp.content)
    lo = pd.Timestamp(start_d, tz="UTC")
    hi = pd.Timestamp(end_d + timedelta(days=1), tz="UTC")
    out = df.loc[(df.index >= lo) & (df.index < hi)]
    if out.empty:
        raise PriceFetchError(
            f"ENTSO-E returned A85 data but none inside {start_d}..{end_d} for {zone}"
        )
    resolution = df.attrs.get("resolution_minutes")
    out.attrs["price_source"] = "entsoe_a85"
    out.attrs["zone"] = zone
    out.attrs["currency"] = "EUR"
    out.attrs["resolution_minutes"] = resolution
    return out
