"""Monthly parquet caching for market-price fetches.

Factored out of nuravolt/markets/entsoe.py so every provider (ENTSO-E, Elexon,
OMIE) shares one cache layout and one freshness rule. Conventions mirror
nuravolt/weather/fallback.py: one parquet plus one JSON sidecar per
(source, zone, calendar month) under ``~/.nuravolt/cache``.

Freshness rule: a month whose end is already in the past is written with
``complete: true`` and trusted forever. The current month is only reused while
the caller is still asking for a horizon that runs past today, because the
provider will keep appending points to it.

Callers must only cache frames whose index is a UTC DatetimeIndex covering the
whole calendar month. Writing a partial month would mark it complete and the
gap would then be invisible for good.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple

import pandas as pd

CACHE_DIR = Path.home() / ".nuravolt" / "cache"


def as_date(value) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    return pd.Timestamp(value).date()


def month_span(start: date, end: date) -> list:
    """Calendar months covering [start, end], as (month_start, month_end_exclusive)."""
    months = []
    cursor = start.replace(day=1)
    while cursor <= end:
        nxt = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
        months.append((cursor, nxt))
        cursor = nxt
    return months


def cache_paths(source: str, zone: str, month_start: date) -> Tuple[Path, Path]:
    key = f"prices_{source}_{zone}_{month_start:%Y%m}"
    return CACHE_DIR / f"{key}.parquet", CACHE_DIR / f"{key}.meta.json"


def read_cache(source: str, zone: str, month_start: date, month_end: date) -> Optional[pd.DataFrame]:
    pq, meta_path = cache_paths(source, zone, month_start)
    if not pq.exists() or not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text())
        df = pd.read_parquet(pq)
    except Exception:
        return None
    now_utc = datetime.now(timezone.utc).date()
    # Past months marked complete are always trusted; the current month is
    # reused only if its cached horizon already covers what was asked for.
    if meta.get("complete"):
        return df
    if meta.get("max_ts") and month_end > now_utc:
        return df  # caller filters; partial current month
    return None


def write_cache(df: pd.DataFrame, source: str, zone: str, month_start: date, month_end: date) -> None:
    if df.empty:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    pq, meta_path = cache_paths(source, zone, month_start)
    df.to_parquet(pq)
    complete = month_end <= datetime.now(timezone.utc).date()
    meta = {
        "source": source,
        "zone": zone,
        "month": f"{month_start:%Y-%m}",
        "rows": int(len(df)),
        "max_ts": df.index.max().isoformat(),
        "complete": complete,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_path.write_text(json.dumps(meta, indent=2))


__all__ = [
    "CACHE_DIR",
    "as_date",
    "month_span",
    "cache_paths",
    "read_cache",
    "write_cache",
]
