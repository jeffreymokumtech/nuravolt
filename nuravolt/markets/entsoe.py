"""
Day-ahead electricity price ingestion.

Two providers behind one function:

- ENTSO-E Transparency Platform (primary; needs a free security token,
  https://transparency.entsoe.eu -> account -> Web API security token).
  Token via the ``api_token`` argument or the ``ENTSOE_API_TOKEN`` env var.
- energy-charts.info (Fraunhofer ISE; no token) as the fallback so audits can
  run before a token is provisioned.

Prices are returned as a pandas DataFrame indexed by UTC timestamps with a
single ``price_eur_mwh`` column. Monthly parquet caching under
``~/.nuravolt/cache`` mirrors nuravolt/weather/fallback.py conventions; the
cache helpers now live in nuravolt/markets/_cache.py so Elexon (gb.py) and
OMIE (iberia.py) share the same layout.

Imbalance prices for the Iberian control areas moved to
nuravolt/markets/iberia.py (ENTSO-E documentType A85, a different document
root than the A44 parser below). ``fetch_imbalance_prices`` here forwards the
caller there.
"""

from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd
import requests

# CACHE_DIR is re-exported because it was part of this module's surface before
# the cache helpers were factored out.
from nuravolt.markets._cache import (  # noqa: F401
    CACHE_DIR,
    as_date,
    month_span,
    read_cache,
    write_cache,
)

# Re-exported so the historical `from nuravolt.markets.entsoe import
# PriceFetchError` import keeps working now that the class lives in errors.py.
from nuravolt.markets.errors import PriceFetchError

ENTSOE_API_URL = "https://web-api.tp.entsoe.eu/api"
ENERGY_CHARTS_URL = "https://api.energy-charts.info/price"

# Bidding zone -> (ENTSO-E EIC area code, energy-charts bzn code)
SUPPORTED_ZONES = {
    "ES": ("10YES-REE------0", "ES"),
    "PT": ("10YPT-REN------W", "PT"),
    "FR": ("10YFR-RTE------C", "FR"),
    "BE": ("10YBE----------2", "BE"),
    "NL": ("10YNL----------L", "NL"),
    "DE-LU": ("10Y1001A1001A82H", "DE-LU"),
    "AT": ("10YAT-APG------L", "AT"),
    "IT-NORTH": ("10Y1001A1001A73I", "IT-North"),
    "PL": ("10YPL-AREA-----S", "PL"),
    "GR": ("10YGR-HTSO-----Y", "GR"),
}

_REQUEST_TIMEOUT = 60


# ---------------------------------------------------------------------------
# ENTSO-E provider


def _entsoe_period_param(d: date) -> str:
    return f"{d:%Y%m%d}0000"


def _parse_entsoe_xml(payload: bytes) -> pd.DataFrame:
    """Parse an ENTSO-E Publication_MarketDocument (A44 day-ahead prices)."""
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

    records: list[tuple[pd.Timestamp, float]] = []
    for ts_elem in findall(root, ".//x:TimeSeries"):
        for period in findall(ts_elem, ".//x:Period"):
            start_text = findtext(period, "x:timeInterval/x:start")
            resolution = findtext(period, "x:resolution") or "PT60M"
            if start_text is None:
                continue
            period_start = pd.Timestamp(start_text).tz_convert("UTC")
            step = pd.Timedelta(resolution.replace("PT", "").replace("M", "min"))
            points = []
            for point in findall(period, "x:Point"):
                pos = findtext(point, "x:position")
                amount = findtext(point, "x:price.amount")
                if pos is None or amount is None:
                    continue
                points.append((int(pos), float(amount)))
            if not points:
                continue
            points.sort()
            # Curve type A03 omits repeated values: a position implicitly
            # holds until the next stated position.
            max_pos = points[-1][0]
            filled = np.full(max_pos, np.nan)
            for pos, amount in points:
                filled[pos - 1:] = amount
            for i, amount in enumerate(filled):
                records.append((period_start + i * step, float(amount)))

    if not records:
        raise PriceFetchError("ENTSO-E response contained no price points")

    df = pd.DataFrame(records, columns=["ts", "price_eur_mwh"]).set_index("ts")
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def _fetch_entsoe_month(zone: str, month_start: date, month_end: date, api_token: str,
                        session: requests.Session) -> pd.DataFrame:
    eic = SUPPORTED_ZONES[zone][0]
    params = {
        "securityToken": api_token,
        "documentType": "A44",
        "in_Domain": eic,
        "out_Domain": eic,
        "periodStart": _entsoe_period_param(month_start),
        "periodEnd": _entsoe_period_param(month_end),
    }
    resp = session.get(ENTSOE_API_URL, params=params, timeout=_REQUEST_TIMEOUT)
    if resp.status_code == 401:
        raise PriceFetchError("ENTSO-E rejected the security token (401)")
    resp.raise_for_status()
    return _parse_entsoe_xml(resp.content)


# ---------------------------------------------------------------------------
# energy-charts.info provider (token-free fallback)


def _fetch_energy_charts_month(zone: str, month_start: date, month_end: date,
                               session: requests.Session) -> pd.DataFrame:
    bzn = SUPPORTED_ZONES[zone][1]
    params = {
        "bzn": bzn,
        "start": month_start.isoformat(),
        "end": (month_end - timedelta(days=1)).isoformat(),
    }
    resp = session.get(ENERGY_CHARTS_URL, params=params, timeout=_REQUEST_TIMEOUT)
    resp.raise_for_status()
    payload = resp.json()
    seconds = payload.get("unix_seconds") or []
    prices = payload.get("price") or []
    if not seconds or len(seconds) != len(prices):
        raise PriceFetchError(f"energy-charts returned no usable data for {zone} {month_start:%Y-%m}")
    idx = pd.to_datetime(np.asarray(seconds, dtype="int64"), unit="s", utc=True)
    df = pd.DataFrame({"price_eur_mwh": np.asarray(prices, dtype=float)}, index=idx)
    df.index.name = "ts"
    df = df.dropna()
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


# ---------------------------------------------------------------------------
# Public API


def fetch_day_ahead_prices(
    zone: str,
    start,
    end,
    api_token: Optional[str] = None,
    source: str = "auto",
    use_cache: bool = True,
    session: Optional[requests.Session] = None,
) -> pd.DataFrame:
    """
    Fetch day-ahead prices for ``zone`` covering [start, end] (dates, inclusive).

    Args:
        zone: Bidding zone key from SUPPORTED_ZONES (e.g. "ES", "DE-LU").
        start, end: Date-like bounds (inclusive), interpreted as UTC days.
        api_token: ENTSO-E token; falls back to env ENTSOE_API_TOKEN.
        source: "auto" (ENTSO-E if a token is available, else energy-charts),
            "entsoe", or "energy-charts".
        use_cache: Reuse/populate monthly parquet caches in ~/.nuravolt/cache.
        session: Optional requests.Session (tests inject a mock here).

    Returns:
        DataFrame indexed by UTC timestamps with column ``price_eur_mwh``,
        plus ``df.attrs["price_source"]`` naming the provider used.
    """
    if zone not in SUPPORTED_ZONES:
        raise ValueError(f"Unsupported zone {zone!r}; known zones: {sorted(SUPPORTED_ZONES)}")

    start_d, end_d = as_date(start), as_date(end)
    if end_d < start_d:
        raise ValueError("end must be >= start")

    token = api_token or os.environ.get("ENTSOE_API_TOKEN") or ""
    if source == "auto":
        resolved = "entsoe" if token else "energy-charts"
    elif source in ("entsoe", "energy-charts"):
        resolved = source
    else:
        raise ValueError(f"Unknown source {source!r}")
    if resolved == "entsoe" and not token:
        raise PriceFetchError(
            "ENTSO-E source requested but no token given (arg api_token or env ENTSOE_API_TOKEN)"
        )

    sess = session or requests.Session()
    frames: list[pd.DataFrame] = []
    errors: list[str] = []
    for month_start, month_end in month_span(start_d, end_d):
        df = read_cache(resolved, zone, month_start, month_end) if use_cache else None
        if df is None:
            try:
                if resolved == "entsoe":
                    df = _fetch_entsoe_month(zone, month_start, month_end, token, sess)
                else:
                    df = _fetch_energy_charts_month(zone, month_start, month_end, sess)
            except (requests.RequestException, PriceFetchError) as exc:
                errors.append(f"{month_start:%Y-%m}: {exc}")
                continue
            if use_cache:
                write_cache(df, resolved, zone, month_start, month_end)
        frames.append(df)

    if not frames:
        raise PriceFetchError(
            f"No day-ahead prices for {zone} {start_d}..{end_d} via {resolved}: " + "; ".join(errors)
        )

    out = pd.concat(frames).sort_index()
    out = out[~out.index.duplicated(keep="last")]
    lo = pd.Timestamp(start_d, tz="UTC")
    hi = pd.Timestamp(end_d + timedelta(days=1), tz="UTC")
    out = out.loc[(out.index >= lo) & (out.index < hi)]
    if out.empty:
        raise PriceFetchError(
            f"Providers returned data but none inside {start_d}..{end_d} for {zone}"
            + (f" (errors: {'; '.join(errors)})" if errors else "")
        )
    out.attrs["price_source"] = resolved
    out.attrs["zone"] = zone
    return out


def fetch_imbalance_prices(zone: str, start, end, **kwargs):
    """Imbalance settlement prices, per control area.

    Only the Iberian control areas are wired up; the call forwards to
    nuravolt/markets/iberia.py, which parses the A85 Balancing_MarketDocument
    (a different document root than the A44 parser above). GB imbalance lives
    in nuravolt/markets/gb.py because GB left ENTSO-E after Brexit.
    """
    from nuravolt.markets import iberia  # local import: iberia imports this module

    if zone in iberia.IMBALANCE_CONTROL_AREAS:
        return iberia.fetch_imbalance_prices(zone, start, end, **kwargs)
    raise NotImplementedError(
        f"Imbalance prices are not implemented for {zone!r}. Implemented control areas: "
        f"{sorted(iberia.IMBALANCE_CONTROL_AREAS)} (nuravolt/markets/iberia.py); "
        "GB is served by nuravolt/markets/gb.py."
    )
