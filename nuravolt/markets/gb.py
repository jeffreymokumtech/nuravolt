"""GB electricity market data: prices, imbalance, ancillary auctions, BM acceptances.

Two public, key-free sources:

- Elexon Insights (``https://data.elexon.co.uk/bmrs/api/v1``) for the market
  index price, the DISEBSP imbalance settlement prices and the per-BMU
  balancing-mechanism acceptance stacks.
- The NESO Data Portal CKAN API (``https://api.neso.energy/api/3/action``) for
  response and reserve auction clearing prices.

Neither needs an API key. GB left the ENTSO-E Transparency Platform after
Brexit, so nuravolt/markets/entsoe.py does not serve this zone. If an ENTSO-E
security token is ever provisioned and it turns out to carry a GB day-ahead
series, that rung slots in at the top of the ladder in
``fetch_day_ahead_prices`` (source="entsoe"); nothing here depends on it today.
energy-charts.info answers HTTP 400 for bzn=GB, so there is no fallback there.

NO SYNTHETIC GB CURVE, EVER. The labelled synthetic duck curve in
nuravolt/markets/iberia.py is acceptable only because a real 12-month OMIE CSV
is committed alongside it, so synthesis merely covers gaps beyond the
day-ahead horizon against a known real shape. No GB price history is committed
to this repo, so a synthetic GB curve would be a fabricated measurement
powering a revenue number. When the real fetch fails, this module raises
PriceFetchError and the caller shows nothing.

Honesty note on what the day-ahead function returns: the Elexon Market Index
Price (MID) is a short-term market index published by appointed Market Index
Data Providers, computed from their own traded volume close to delivery. It is
NOT a day-ahead auction clearing price the way EPEX/OMIE prices are. Captions
must say "market index price", not "day-ahead auction price". The provenance
label reflects this: ``price_source`` reads e.g. ``elexon_mid_apx``.

MID also has a trap. Providers that are not trading still publish a row, at
price 0.00 and volume 0.000. Taking the first row, or hardcoding a provider,
silently produces a zero price curve and values a battery at zero. Every
settlement period here is therefore resolved to a provider with volume > 0,
and a window where no provider ever traded raises rather than passing as a
free-energy day.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Iterable, List, NamedTuple, Optional, Sequence, Tuple

import pandas as pd
import requests

from nuravolt.markets._cache import as_date, month_span, read_cache, write_cache
from nuravolt.markets.errors import PriceFetchError

ELEXON_BASE = "https://data.elexon.co.uk/bmrs/api/v1"
NESO_CKAN_BASE = "https://api.neso.energy/api/3/action"

# "NESO Response-Reserve Daily Results Summary". Daily resources hold only the
# LATEST auction round; historical clearing prices live in the per-financial-year
# archive resources on the same portal.
NESO_RESERVE_RESOURCE_ID = "3c51a666-1c33-450e-a6eb-c9b4a0c91584"

# CKAN package that carries the Enduring Auction Capability results, including
# the rolling current-financial-year "Results Summary" and one archive resource
# per past financial year. The archive resource ids are DISCOVERED from this
# package at runtime (see _discover_eac_summary_resources) rather than pinned,
# because NESO mints a new one every April and a hardcoded list would rot.
NESO_EAC_PACKAGE_ID = "eac-auction-results"

# Pre-EAC response auction results (DCH/DCL/DMH/DML/DRH/DRL). Verified live on
# 2026-07-28: 23424 rows spanning 2021-09-15T23:00 to 2023-11-02T23:00, which
# is exactly the run that ends where the FY2023 EAC archive begins. Its columns
# are titled differently from the EAC ones, hence the separate alias map. This
# id is hardcoded because it belongs to a different package (dynamic
# containment data) and is closed: nothing new is ever appended to it.
NESO_DC_LEGACY_RESOURCE_ID = "888e5029-f786-41d2-bc15-cbfd1d285e96"

# Documented in the resource's own field metadata on the NESO Data Portal.
# Live sampling on 2026-07-28 also returned NBR and PBR, which that metadata
# does not list, so this tuple is treated as a hint for error messages and not
# as a closed set: a product present in the response is always accepted.
# TODO(verify): reconcile the NBR/PBR products against the NESO product
# definitions before they are described to a user.
NESO_PRODUCTS = ("DCH", "DCL", "DMH", "DML", "DRH", "DRL", "NSR", "PSR", "NQR", "PQR")

# GB is a single balancing and settlement zone.
SUPPORTED_ZONES = {
    "GB": "National Electricity Transmission System",
}

CURRENCY = "GBP"
SETTLEMENT_PERIOD_MINUTES = 30
SETTLEMENT_PERIODS_PER_DAY = 48

# Preference order among Market Index Data Providers that are actually trading.
# This is a tie-break, not a hardcoded choice: the volume > 0 filter runs first
# and any provider not named here is still eligible (highest volume wins).
MID_PROVIDER_PREFERENCE = ("APXMIDP",)

# Verified against the live endpoint: a from/to span longer than 7 days is
# rejected with HTTP 400 ("The date range between From and To inclusive must
# not exceed 7 days"), and both ends of the window are inclusive, so a request
# starting at 00:00Z does return the 00:00Z settlement period.
_MID_MAX_WINDOW_DAYS = 7

_REQUEST_TIMEOUT = 60


# ---------------------------------------------------------------------------
# HTTP helpers


def _elexon_get(path: str, session: requests.Session, params: Optional[dict] = None) -> dict:
    resp = session.get(f"{ELEXON_BASE}{path}", params=params, timeout=_REQUEST_TIMEOUT)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict):
        raise PriceFetchError(f"Elexon {path} returned an unexpected payload type")
    return payload


def _rows(payload: dict) -> List[dict]:
    data = payload.get("data")
    return list(data) if isinstance(data, list) else []


def _float_or_none(value) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_utc(value) -> Optional[pd.Timestamp]:
    """Parse a timestamp string to UTC. Naive strings are treated as UTC."""
    if value is None:
        return None
    ts = pd.Timestamp(value)
    if pd.isna(ts):
        return None
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


# ---------------------------------------------------------------------------
# Market Index Price (MID)


def _provider_slug(provider: str) -> str:
    """APXMIDP -> apx. Derived, so a new provider labels itself correctly."""
    name = (provider or "").strip()
    if name.upper().endswith("MIDP"):
        name = name[:-4]
    return name.lower() or "unknown"


def _select_mid_provider(candidates: Sequence[dict]) -> Optional[dict]:
    """Pick the row from one settlement period that a real trade stands behind.

    Rows whose volume is zero (or missing) are providers that were not trading;
    their price is published as 0.00 and means nothing. Among the providers
    that did trade, MID_PROVIDER_PREFERENCE breaks ties and anything else falls
    back to the largest traded volume. Returns None when nobody traded.
    """
    live = [r for r in candidates if (_float_or_none(r.get("volume")) or 0.0) > 0.0]
    if not live:
        return None
    for preferred in MID_PROVIDER_PREFERENCE:
        for row in live:
            if row.get("dataProvider") == preferred:
                return row
    return max(live, key=lambda r: _float_or_none(r.get("volume")) or 0.0)


def _parse_mid_payload(payload: dict, context: str) -> pd.DataFrame:
    """Build a half-hourly frame from a market-index payload.

    Returns columns ``price_gbp_mwh`` and ``mid_data_provider`` indexed by UTC
    ``startTime``. The provider is kept as a column so the label survives the
    parquet cache round trip and a caption can name it per period.
    """
    rows = _rows(payload)
    if not rows:
        raise PriceFetchError(f"Elexon market index returned no rows for {context}")

    by_period: dict = {}
    for row in rows:
        start = row.get("startTime")
        if start is None:
            continue
        by_period.setdefault(start, []).append(row)

    records = []
    for start, candidates in by_period.items():
        chosen = _select_mid_provider(candidates)
        if chosen is None:
            continue
        price = _float_or_none(chosen.get("price"))
        if price is None:
            continue
        records.append((pd.Timestamp(start).tz_convert("UTC"), price, chosen.get("dataProvider")))

    if not records:
        raise PriceFetchError(
            f"Elexon market index returned only zero-volume rows for {context}. "
            "Every Market Index Data Provider published price 0.00 at volume 0.000, "
            "which is an absence of trade, not free energy."
        )

    df = pd.DataFrame(records, columns=["ts", "price_gbp_mwh", "mid_data_provider"]).set_index("ts")
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def _cache_reaches(df: pd.DataFrame, month_end: date, wanted_end: date) -> bool:
    """Does a cached month already run to the last period the caller wants?

    A part-month cache of the current month is legitimate, but reusing it for a
    request that runs past its horizon would silently return a short curve.
    """
    if df.empty:
        return False
    last_wanted = min(
        pd.Timestamp(wanted_end + timedelta(days=1), tz="UTC"),
        pd.Timestamp(month_end, tz="UTC"),
    ) - timedelta(minutes=SETTLEMENT_PERIOD_MINUTES)
    return df.index.max() >= last_wanted


def _mid_windows(month_start: date, month_end: date) -> Iterable:
    """<= 7-day request windows covering one calendar month."""
    cursor = month_start
    while cursor < month_end:
        stop = min(cursor + timedelta(days=_MID_MAX_WINDOW_DAYS), month_end)
        yield cursor, stop
        cursor = stop


def _fetch_mid_month(month_start: date, month_end: date, session: requests.Session) -> pd.DataFrame:
    frames = []
    for window_start, window_end in _mid_windows(month_start, month_end):
        payload = _elexon_get(
            "/balancing/pricing/market-index",
            session,
            params={
                "from": f"{window_start:%Y-%m-%d}T00:00Z",
                "to": f"{window_end:%Y-%m-%d}T00:00Z",
            },
        )
        # A window past the published horizon comes back with no rows at all.
        # That is a not-yet, so it skips; a window that came back full of
        # zero-volume rows is a different story and _parse_mid_payload raises.
        if not _rows(payload):
            continue
        frames.append(_parse_mid_payload(payload, f"{window_start}..{window_end}"))
    if not frames:
        raise PriceFetchError(
            f"Elexon market index returned no rows for {month_start:%Y-%m}"
        )
    out = pd.concat(frames).sort_index()
    return out[~out.index.duplicated(keep="last")]


def fetch_day_ahead_prices(
    zone: str = "GB",
    start=None,
    end=None,
    source: str = "auto",
    use_cache: bool = True,
    session: Optional[requests.Session] = None,
) -> pd.DataFrame:
    """
    Fetch the GB market index price for [start, end] (dates, inclusive).

    Args:
        zone: Must be "GB" (see SUPPORTED_ZONES).
        start, end: Date-like bounds (inclusive), interpreted as UTC days.
        source: "auto" or "elexon-mid" today. "entsoe" is reserved for the
            inactive rung described in the module docstring and raises.
        use_cache: Reuse/populate monthly parquet caches in ~/.nuravolt/cache.
        session: Optional requests.Session (tests inject a mock here).

    Returns:
        DataFrame indexed by UTC timestamps at half-hourly resolution with
        columns ``price_gbp_mwh`` and ``mid_data_provider``, plus attrs
        price_source, zone, currency and resolution_minutes. When some months
        could not be fetched but others could, attrs also carries
        ``fetch_errors`` so partial coverage is visible.

    Raises:
        PriceFetchError when no real prices could be fetched. There is no
        synthetic GB fallback (see the module docstring).
    """
    if zone not in SUPPORTED_ZONES:
        raise ValueError(f"Unsupported zone {zone!r}; known zones: {sorted(SUPPORTED_ZONES)}")
    if start is None or end is None:
        raise ValueError("start and end are required")

    start_d, end_d = as_date(start), as_date(end)
    if end_d < start_d:
        raise ValueError("end must be >= start")

    if source == "entsoe":
        raise PriceFetchError(
            "There is no ENTSO-E rung for GB: GB left the Transparency Platform after "
            "Brexit and no security token is provisioned here. Use source='auto'."
        )
    if source not in ("auto", "elexon-mid"):
        raise ValueError(f"Unknown source {source!r}")
    resolved = "elexon_mid"

    sess = session or requests.Session()
    frames: List[pd.DataFrame] = []
    errors: List[str] = []
    for month_start, month_end in month_span(start_d, end_d):
        df = read_cache(resolved, zone, month_start, month_end) if use_cache else None
        if df is not None and not _cache_reaches(df, month_end, end_d):
            df = None  # the current month grew since it was cached
        if df is None:
            try:
                df = _fetch_mid_month(month_start, month_end, sess)
            except (requests.RequestException, PriceFetchError) as exc:
                errors.append(f"{month_start:%Y-%m}: {exc}")
                continue
            if use_cache:
                write_cache(df, resolved, zone, month_start, month_end)
        frames.append(df)

    if not frames:
        raise PriceFetchError(
            f"No GB market index prices for {start_d}..{end_d}: " + "; ".join(errors)
        )

    out = pd.concat(frames).sort_index()
    out = out[~out.index.duplicated(keep="last")]
    lo = pd.Timestamp(start_d, tz="UTC")
    hi = pd.Timestamp(end_d + timedelta(days=1), tz="UTC")
    out = out.loc[(out.index >= lo) & (out.index < hi)]
    if out.empty:
        raise PriceFetchError(
            f"Elexon returned data but none inside {start_d}..{end_d} for {zone}"
            + (f" (errors: {'; '.join(errors)})" if errors else "")
        )
    # Second line of defence behind the per-period volume filter: an all-zero
    # curve is an upstream failure, never a valid market outcome.
    if bool((out["price_gbp_mwh"] == 0.0).all()):
        raise PriceFetchError(
            f"Every GB market index price in {start_d}..{end_d} is exactly 0.00. "
            "That is an upstream data problem, not a free-energy day."
        )

    providers = sorted({str(p) for p in out["mid_data_provider"].dropna().unique()})
    slug = _provider_slug(providers[0]) if len(providers) == 1 else "mixed"
    if errors:
        # A month can drop out while others succeed, which would otherwise
        # return a quietly short curve. Carry the reasons so a caller can say
        # the coverage is partial.
        out.attrs["fetch_errors"] = list(errors)
    out.attrs["price_source"] = f"elexon_mid_{slug}"
    out.attrs["zone"] = zone
    out.attrs["currency"] = CURRENCY
    out.attrs["resolution_minutes"] = SETTLEMENT_PERIOD_MINUTES
    return out


# ---------------------------------------------------------------------------
# Imbalance settlement prices (DISEBSP)


def _fetch_disebsp_day(day: date, session: requests.Session) -> pd.DataFrame:
    payload = _elexon_get(f"/balancing/settlement/system-prices/{day:%Y-%m-%d}", session)
    rows = _rows(payload)
    if not rows:
        raise PriceFetchError(f"Elexon system prices returned no rows for {day}")

    records = []
    for row in rows:
        start = row.get("startTime")
        if start is None:
            continue
        # GB has settled on a single cash-out price since P305, and the live
        # sample confirms systemSellPrice == systemBuyPrice. The sell price is
        # taken as that single price.
        price = _float_or_none(row.get("systemSellPrice"))
        if price is None:
            continue
        records.append(
            (
                pd.Timestamp(start).tz_convert("UTC"),
                price,
                _float_or_none(row.get("netImbalanceVolume")),
                row.get("priceDerivationCode"),
            )
        )
    if not records:
        raise PriceFetchError(f"Elexon system prices for {day} carried no usable price")

    df = pd.DataFrame(
        records,
        columns=["ts", "system_price_gbp_mwh", "niv_mwh", "price_derivation_code"],
    ).set_index("ts")
    return df[~df.index.duplicated(keep="last")].sort_index()


def fetch_imbalance_prices(
    zone: str = "GB",
    start=None,
    end=None,
    use_cache: bool = True,
    session: Optional[requests.Session] = None,
) -> pd.DataFrame:
    """
    Fetch GB imbalance (cash-out) prices for [start, end] (dates, inclusive).

    Args:
        zone: Must be "GB".
        start, end: Date-like bounds (inclusive). Elexon keys this dataset by
            settlement date, which is a GB local-clock day; the returned index
            is the UTC ``startTime`` of each settlement period, so the first
            period of a BST settlement date lands at 23:00 UTC the day before.
        use_cache: Monthly parquet cache. Only whole months that the requested
            range fully covers are written, because a part-month write would be
            marked complete and its gap would then be invisible.
        session: Optional requests.Session.

    Returns:
        DataFrame indexed by UTC timestamps with columns
        ``system_price_gbp_mwh``, ``niv_mwh`` and ``price_derivation_code``,
        plus attrs price_source, zone, currency and resolution_minutes.
    """
    if zone not in SUPPORTED_ZONES:
        raise ValueError(f"Unsupported zone {zone!r}; known zones: {sorted(SUPPORTED_ZONES)}")
    if start is None or end is None:
        raise ValueError("start and end are required")

    start_d, end_d = as_date(start), as_date(end)
    if end_d < start_d:
        raise ValueError("end must be >= start")

    resolved = "elexon_disebsp"
    sess = session or requests.Session()
    frames: List[pd.DataFrame] = []
    errors: List[str] = []
    for month_start, month_end in month_span(start_d, end_d):
        cached = read_cache(resolved, zone, month_start, month_end) if use_cache else None
        if cached is not None:
            frames.append(cached)
            continue
        day_frames = []
        month_errors = 0
        day = max(month_start, start_d)
        last = min(month_end - timedelta(days=1), end_d)
        while day <= last:
            try:
                day_frames.append(_fetch_disebsp_day(day, sess))
            except (requests.RequestException, PriceFetchError) as exc:
                errors.append(f"{day}: {exc}")
                month_errors += 1
            day += timedelta(days=1)
        if not day_frames:
            continue
        month_df = pd.concat(day_frames).sort_index()
        month_df = month_df[~month_df.index.duplicated(keep="last")]
        # Cache only a gapless whole month: write_cache would mark a part month
        # complete and the missing days would then never be refetched.
        covers_month = start_d <= month_start and end_d >= month_end - timedelta(days=1)
        if use_cache and covers_month and not month_errors:
            write_cache(month_df, resolved, zone, month_start, month_end)
        frames.append(month_df)

    if not frames:
        raise PriceFetchError(
            f"No GB imbalance prices for {start_d}..{end_d}: " + "; ".join(errors)
        )

    out = pd.concat(frames).sort_index()
    out = out[~out.index.duplicated(keep="last")]
    # Settlement dates are GB local-clock days: under BST, period 1 of the
    # first requested date starts at 23:00 UTC the day before, so the lower
    # bound is widened by an hour rather than dropping two real periods.
    lo = pd.Timestamp(start_d, tz="UTC") - timedelta(hours=1)
    hi = pd.Timestamp(end_d + timedelta(days=1), tz="UTC")
    out = out.loc[(out.index >= lo) & (out.index < hi)]
    if out.empty:
        raise PriceFetchError(
            f"Elexon returned imbalance data but none inside {start_d}..{end_d}"
            + (f" (errors: {'; '.join(errors)})" if errors else "")
        )
    out.attrs["price_source"] = "elexon_disebsp"
    out.attrs["zone"] = zone
    out.attrs["currency"] = CURRENCY
    out.attrs["resolution_minutes"] = SETTLEMENT_PERIOD_MINUTES
    return out


# ---------------------------------------------------------------------------
# NESO response and reserve auction clearing prices


# TODO(verify): NESO clearing-price sign convention and unit against the NESO
# methodology doc before any revenue arithmetic uses this. Live sampling
# returned a DRH row at clearingPrice -14.29, i.e. negative clearing prices are
# published and are not an error. They are returned exactly as published here:
# no abs(), no sign flip. Whether a negative price means the provider pays or
# is paid, and whether the unit is GBP/MW/h as the column name assumes, must be
# confirmed before it drives money.
#
# TODO(verify): deliveryStart and deliveryEnd arrive without a timezone suffix
# ("2026-07-28T22:00:00"). The 22:00 / 02:00 / 06:00 block boundaries line up
# with GB EFA blocks expressed in UTC during BST, so they are localised to UTC
# here. Confirm against the NESO Data Portal field definitions.


class _ClearingColumns(NamedTuple):
    """Where one CKAN resource keeps each field this module needs."""
    product: str
    service_type: Optional[str]
    delivery_start: str
    delivery_end: str
    cleared_volume: str
    clearing_price: str


# The EAC-era schema (daily summary, current-FY summary, FY archives).
_EAC_COLUMNS = _ClearingColumns(
    product="auctionProduct",
    service_type="serviceType",
    delivery_start="deliveryStart",
    delivery_end="deliveryEnd",
    cleared_volume="clearedVolume",
    clearing_price="clearingPrice",
)

# The pre-EAC dynamic-containment schema. Column titles sampled live on
# 2026-07-28: Service, EFA Date, Delivery Start, Delivery End, EFA,
# Cleared Volume, Clearing Price. It carries no service-type column, so
# service_type is None and the parsed rows leave that field null rather than
# inventing a label.
_DC_LEGACY_COLUMNS = _ClearingColumns(
    product="Service",
    service_type=None,
    delivery_start="Delivery Start",
    delivery_end="Delivery End",
    cleared_volume="Cleared Volume",
    clearing_price="Clearing Price",
)


class _ClearingRung(NamedTuple):
    """One resource the clearing-price ladder may consult, in order."""
    resource_id: str
    columns: _ClearingColumns
    price_source: str
    name: str
    # False for the daily resource, which is small enough to pull whole and is
    # the shape the recorded fixtures use.
    window_query: bool


# A CKAN resource id is always a UUID. Checked before it is interpolated into a
# datastore SQL statement (see _fetch_window_records).
_RESOURCE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_FY_IN_NAME_RE = re.compile(r"FY(\d{4})", re.I)

# Page cap for the datastore SQL walk. At the default limit that is 100k rows,
# comfortably more than a whole financial year of one resource.
_MAX_SQL_PAGES = 20


def _ckan_result(session: requests.Session, action: str, params: dict, context: str) -> dict:
    resp = session.get(f"{NESO_CKAN_BASE}/{action}", params=params, timeout=_REQUEST_TIMEOUT)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise PriceFetchError(f"NESO CKAN rejected the query for {context}")
    result = payload.get("result")
    return result if isinstance(result, dict) else {}


def _fetch_whole_records(resource_id: str, limit: int, session: requests.Session) -> List[dict]:
    """Every row of a small resource, or raise rather than truncate silently."""
    result = _ckan_result(
        session, "datastore_search",
        {"resource_id": resource_id, "limit": limit},
        f"resource {resource_id}",
    )
    records = result.get("records") or []
    total = result.get("total")
    if isinstance(total, int) and total > len(records):
        raise PriceFetchError(
            f"NESO resource {resource_id} holds {total} records but only {len(records)} "
            f"were returned at limit={limit}. Raise limit rather than reporting a "
            "truncated auction set."
        )
    return list(records)


def _fetch_window_records(
    resource_id: str,
    columns: _ClearingColumns,
    start_d: date,
    end_d: date,
    limit: int,
    session: requests.Session,
) -> List[dict]:
    """Rows of a large resource whose delivery window overlaps [start_d, end_d].

    The financial-year resources hold tens of thousands of rows, so pulling one
    whole and filtering in Python would page for a minute and trip the
    truncation guard. CKAN's datastore SQL endpoint takes the range filter
    instead, and pages through it so a long window is complete rather than cut
    off at the first page.

    Two constraints shape the statement:

    - The portal sits behind a WAF that answers HTTP 403 to anything wearing an
      injection signature. Verified live on 2026-07-28: ``COALESCE(...)`` and a
      bare ``OR`` are both refused, while quoted identifiers, ``AND``,
      ``ORDER BY`` and ``OFFSET`` pass. The range therefore filters on the
      delivery-start column alone, padded by a day on the low side so a block
      that started before the window but delivers inside it still arrives.
      _parse_clearing_records then applies the exact overlap test, so this
      clause only has to be generous, never precise.
    - Nothing caller-supplied reaches the statement: ``resource_id`` is checked
      against _RESOURCE_ID_RE first, the column names come from the module's
      own _ClearingColumns constants, and the bounds are formatted from
      ``date`` objects. The delivery columns are stored as ISO-8601 text in a
      single fixed format, so a lexicographic comparison is a chronological one.
    """
    if not _RESOURCE_ID_RE.match(resource_id):
        raise PriceFetchError(
            f"Refusing to query CKAN resource id {resource_id!r}: not a UUID."
        )
    lo = f"{start_d - timedelta(days=1):%Y-%m-%d}T00:00:00"
    hi = f"{end_d + timedelta(days=1):%Y-%m-%d}T00:00:00"
    start_col = columns.delivery_start

    records: List[dict] = []
    for page in range(_MAX_SQL_PAGES):
        sql = (
            f'SELECT * FROM "{resource_id}" '
            f'WHERE "{start_col}" >= \'{lo}\' AND "{start_col}" < \'{hi}\' '
            f'ORDER BY "_id" LIMIT {int(limit)} OFFSET {page * int(limit)}'
        )
        result = _ckan_result(
            session, "datastore_search_sql", {"sql": sql}, f"resource {resource_id}"
        )
        page_records = list(result.get("records") or [])
        records.extend(page_records)
        if len(page_records) < limit:
            return records

    raise PriceFetchError(
        f"NESO resource {resource_id} still had rows after {_MAX_SQL_PAGES} pages of "
        f"{limit} for {start_d}..{end_d}. Narrow the window rather than reporting a "
        "truncated auction set."
    )


def _discover_eac_summary_resources(session: requests.Session) -> List[Tuple[str, str]]:
    """(resource_id, name) for the EAC results-summary resources, newest first.

    The rolling current-financial-year summary has no FY marker in its name and
    sorts first; the archives sort by the year in "FY2025 (Archive)". The daily
    resource is excluded because it is the rung that already ran.

    Any failure returns an empty list: discovery is an optimisation on top of
    the daily rung, and a portal hiccup must degrade into the honest "no rung
    could serve this window" error rather than into an exception with a
    different story.
    """
    try:
        result = _ckan_result(
            session, "package_show", {"id": NESO_EAC_PACKAGE_ID},
            f"package {NESO_EAC_PACKAGE_ID}",
        )
        resources = result.get("resources")
        if not isinstance(resources, list):
            return []
    except (requests.RequestException, PriceFetchError, ValueError):
        return []

    found: List[Tuple[int, str, str]] = []
    for res in resources:
        if not isinstance(res, dict):
            continue
        name = str(res.get("name") or "")
        rid = str(res.get("id") or "")
        lowered = name.lower()
        if "results summary" not in lowered or "daily" in lowered:
            continue
        if not _RESOURCE_ID_RE.match(rid) or rid == NESO_RESERVE_RESOURCE_ID:
            continue
        match = _FY_IN_NAME_RE.search(name)
        # No FY marker means the live rolling summary for the current financial
        # year, which is newer than every archive.
        found.append((int(match.group(1)) if match else 9999, rid, name))

    found.sort(key=lambda item: item[0], reverse=True)
    return [(rid, name) for _year, rid, name in found]


def _parse_clearing_records(
    records: Iterable[dict],
    columns: _ClearingColumns,
    lo: pd.Timestamp,
    hi: pd.Timestamp,
    wanted: Optional[set],
) -> List[dict]:
    """Records overlapping [lo, hi) as this module's canonical row shape."""
    rows = []
    for rec in records:
        product = rec.get(columns.product)
        if product is None:
            continue
        if wanted is not None and str(product).upper() not in wanted:
            continue
        d_start = _as_utc(rec.get(columns.delivery_start))
        d_end = _as_utc(rec.get(columns.delivery_end))
        if d_start is None:
            continue
        # Keep any auction window that overlaps the requested range, not only
        # the ones that start inside it.
        if d_start >= hi or (d_end or d_start) <= lo:
            continue
        rows.append(
            {
                "delivery_start": d_start,
                "delivery_end": d_end,
                "product": product,
                "service_type": rec.get(columns.service_type) if columns.service_type else None,
                "cleared_volume_mw": _float_or_none(rec.get(columns.cleared_volume)),
                "clearing_price_gbp_mw_h": _float_or_none(rec.get(columns.clearing_price)),
            }
        )
    return rows


def fetch_ancillary_clearing_prices(
    start=None,
    end=None,
    products: Optional[Iterable[str]] = None,
    limit: int = 5000,
    session: Optional[requests.Session] = None,
    resource_id: str = NESO_RESERVE_RESOURCE_ID,
) -> pd.DataFrame:
    """
    Fetch NESO response and reserve auction clearing prices overlapping [start, end].

    Walks a ladder of CKAN resources and returns the first one that actually
    delivers in the requested window:

      1. the daily results summary, which holds only the LATEST auction round
         and therefore answers today and yesterday;
      2. the EAC results-summary resources discovered from the
         ``eac-auction-results`` package: the rolling current-financial-year
         one, then the FY archives newest first (FY2023 onwards);
      3. the pre-EAC dynamic-containment archive, which runs 2021-09 to
         2023-11 under different column titles.

    Historical benchmarking used to be impossible because only rung 1 existed,
    and it drops every round but the newest.

    Args:
        start, end: Date-like bounds (inclusive), matched against the UTC
            delivery window.
        products: Optional product codes (e.g. ("DCH", "DCL")). Any code the
            resource actually carries is accepted, so the undocumented ones are
            not blocked; see the NESO_PRODUCTS note.
        limit: CKAN page size. A resource returning more rows than this raises
            rather than silently returning a truncated auction set.
        session: Optional requests.Session.
        resource_id: CKAN resource to start from. Defaults to the daily results
            summary. Passing any other id pins the fetch to that one resource
            and disables the ladder, because a caller naming a resource is
            asking that resource a question.

    Returns:
        DataFrame with columns delivery_start, delivery_end, product,
        service_type, cleared_volume_mw, clearing_price_gbp_mw_h, plus attrs
        price_source, zone, currency, resource_id, resource_name and
        rungs_tried.

    Raises:
        PriceFetchError when no rung delivers in the window, naming every rung
        that was consulted.
    """
    if start is None or end is None:
        raise ValueError("start and end are required")
    start_d, end_d = as_date(start), as_date(end)
    if end_d < start_d:
        raise ValueError("end must be >= start")

    wanted = {str(p).upper() for p in products} if products is not None else None
    sess = session or requests.Session()
    lo = pd.Timestamp(start_d, tz="UTC")
    hi = pd.Timestamp(end_d + timedelta(days=1), tz="UTC")

    pinned = resource_id != NESO_RESERVE_RESOURCE_ID
    rungs: List[_ClearingRung] = [
        _ClearingRung(
            resource_id=resource_id,
            columns=_EAC_COLUMNS,
            price_source=(
                "neso_response_reserve_daily" if not pinned else f"neso_ckan_{resource_id}"
            ),
            name="NESO Response-Reserve Daily Results Summary" if not pinned else resource_id,
            window_query=False,
        )
    ]
    if not pinned:
        for rid, name in _discover_eac_summary_resources(sess):
            rungs.append(
                _ClearingRung(
                    resource_id=rid,
                    columns=_EAC_COLUMNS,
                    price_source="neso_eac_results_summary",
                    name=name,
                    window_query=True,
                )
            )
        rungs.append(
            _ClearingRung(
                resource_id=NESO_DC_LEGACY_RESOURCE_ID,
                columns=_DC_LEGACY_COLUMNS,
                price_source="neso_dynamic_containment_archive",
                name="Dynamic containment auction results (2021-2023 archive)",
                window_query=True,
            )
        )

    tried: List[str] = []
    validated_products = False
    for rung in rungs:
        tried.append(rung.name)
        try:
            if rung.window_query:
                records = _fetch_window_records(
                    rung.resource_id, rung.columns, start_d, end_d, limit, sess
                )
            else:
                records = _fetch_whole_records(rung.resource_id, limit, sess)
                if not records:
                    raise PriceFetchError(
                        f"NESO resource {rung.resource_id} returned no records"
                    )
        except PriceFetchError:
            if not rung.window_query:
                # The first rung is the documented entry point; a truncated or
                # empty answer from it is a real failure to report, not a rung
                # that simply does not cover this window.
                raise
            continue
        except requests.RequestException:
            continue

        if wanted is not None and not validated_products and records:
            # Checked against what the resource actually carries, not only
            # against the documented list, because the live data carries
            # products that list omits. Only a code in neither place is a
            # caller error.
            available = {str(r.get(rung.columns.product)).upper() for r in records}
            unknown = wanted - available - set(NESO_PRODUCTS)
            if unknown:
                raise ValueError(
                    f"Unknown NESO product(s) {sorted(unknown)}; this resource carries "
                    f"{sorted(available)}"
                )
            validated_products = True

        rows = _parse_clearing_records(records, rung.columns, lo, hi, wanted)
        if not rows:
            continue

        df = pd.DataFrame(rows).sort_values(["delivery_start", "product"]).reset_index(drop=True)
        df.attrs["price_source"] = rung.price_source
        df.attrs["zone"] = "GB"
        df.attrs["currency"] = CURRENCY
        df.attrs["resource_id"] = rung.resource_id
        df.attrs["resource_name"] = rung.name
        df.attrs["rungs_tried"] = list(tried)
        return df

    raise PriceFetchError(
        f"No NESO clearing prices delivering in {start_d}..{end_d}"
        + (f" for products {sorted(wanted)}" if wanted else "")
        + ". The daily resource only carries the latest auction round, and no "
        "financial-year archive resource covered this window either. Rungs "
        f"consulted: {'; '.join(tried)}."
    )


# ---------------------------------------------------------------------------
# Balancing mechanism acceptances, per BMU


_ACCEPTANCE_COLUMNS = [
    "settlement_period",
    "direction",
    "final_price_gbp_mwh",
    "niv_adjusted_volume_mwh",
    "volume_mwh",
    "acceptance_id",
    "so_flag",
    "cadl_flag",
]


def fetch_bm_acceptances(
    bmu_id: str,
    day=None,
    periods: Optional[Iterable[int]] = None,
    session: Optional[requests.Session] = None,
) -> pd.DataFrame:
    """
    Fetch one BMU's balancing-mechanism acceptances for a settlement day.

    Walks both the bid and the offer stack for every settlement period, because
    Elexon exposes the stack one period and one direction at a time. That is 96
    small requests for a normal day.

    Args:
        bmu_id: Elexon BMU id, e.g. "T_PEMB-51" or "E_BHOLB-1".
        day: Date-like settlement date.
        periods: Settlement periods to walk. Defaults to 1..48. GB clock-change
            days have 46 or 50 periods, so pass an explicit range for those;
            periods that do not exist simply come back empty.
        session: Optional requests.Session.

    Returns:
        DataFrame with columns settlement_period, direction,
        final_price_gbp_mwh, niv_adjusted_volume_mwh, acceptance_id, so_flag,
        cadl_flag, plus attrs price_source, zone, bmu_id and settlement_date.

    A BMU with no acceptances that day returns an empty frame, not an error: a
    quiet day is a real answer and must not read as a fetch failure.
    """
    if day is None:
        raise ValueError("day is required")
    day_d = as_date(day)
    period_list = list(periods) if periods is not None else list(range(1, SETTLEMENT_PERIODS_PER_DAY + 1))

    sess = session or requests.Session()
    rows = []
    for direction in ("bid", "offer"):
        for period in period_list:
            payload = _elexon_get(
                f"/balancing/settlement/stack/all/{direction}/{day_d:%Y-%m-%d}/{period}", sess
            )
            for rec in _rows(payload):
                if rec.get("id") != bmu_id:
                    continue
                rows.append(
                    {
                        "settlement_period": rec.get("settlementPeriod", period),
                        "direction": direction,
                        "final_price_gbp_mwh": _float_or_none(rec.get("finalPrice")),
                        "niv_adjusted_volume_mwh": _float_or_none(rec.get("nivAdjustedVolume")),
                        # Raw accepted volume, carried alongside the NIV-adjusted
                        # figure. Elexon leaves nivAdjustedVolume null on some
                        # acceptances, and summing the adjusted column alone would
                        # silently drop those rows from a revenue reconstruction we
                        # describe as reconciling to the operator's settlement
                        # statement. Keeping both makes the gap countable.
                        "volume_mwh": _float_or_none(rec.get("volume")),
                        "acceptance_id": rec.get("acceptanceId"),
                        "so_flag": rec.get("soFlag"),
                        "cadl_flag": rec.get("cadlFlag"),
                    }
                )

    df = pd.DataFrame(rows, columns=_ACCEPTANCE_COLUMNS)
    if not df.empty:
        df = df.sort_values(["settlement_period", "direction", "acceptance_id"]).reset_index(drop=True)
    df.attrs["price_source"] = "elexon_bm_stack"
    df.attrs["zone"] = "GB"
    df.attrs["currency"] = CURRENCY
    df.attrs["bmu_id"] = bmu_id
    df.attrs["settlement_date"] = day_d.isoformat()
    return df


def reconstruct_bm_revenue(acceptances: pd.DataFrame) -> dict:
    """Settled balancing-mechanism revenue for one BMU-day, with its own coverage.

    Revenue is ``sum(final_price * niv_adjusted_volume)``. Bid volumes are
    published negative and offer volumes positive, so the signs carry through
    without adjustment: a bid the unit was paid to deliver reduces net revenue.

    The result reports how much of the accepted volume it could actually price.
    Elexon leaves ``nivAdjustedVolume`` null on a minority of acceptances, and a
    bare ``.sum()`` skips those rows silently. Since this figure is presented as
    reconciling against an operator's own settlement statement, an unpriced
    acceptance has to be visible rather than absorbed into the total.
    """
    if acceptances is None or acceptances.empty:
        return {
            "revenue_gbp": 0.0,
            "acceptances": 0,
            "priced_acceptances": 0,
            "unpriced_acceptances": 0,
            "unpriced_volume_mwh": 0.0,
            "complete": True,
        }

    priced = acceptances["niv_adjusted_volume_mwh"].notna()
    revenue = float(
        (acceptances.loc[priced, "final_price_gbp_mwh"]
         * acceptances.loc[priced, "niv_adjusted_volume_mwh"]).sum()
    )
    unpriced = acceptances.loc[~priced]
    unpriced_volume = 0.0
    if "volume_mwh" in unpriced.columns:
        unpriced_volume = float(unpriced["volume_mwh"].abs().sum(skipna=True))

    return {
        "revenue_gbp": round(revenue, 2),
        "acceptances": int(len(acceptances)),
        "priced_acceptances": int(priced.sum()),
        "unpriced_acceptances": int((~priced).sum()),
        "unpriced_volume_mwh": round(unpriced_volume, 4),
        "complete": bool((~priced).sum() == 0),
    }
