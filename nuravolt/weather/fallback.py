"""
Weather/irradiance fallback chain.

Residential and many C&I plants have no pyranometer or ambient-temp sensor.
This module supplies modeled weather so the digital twin and per-inverter SR
can still run, with explicit provenance so downstream consumers (and the UI)
know the irradiance is satellite/model-derived rather than measured.

Chain (highest available wins):
    1. on-site sensor column      confidence 0.95  (handled by the callers)
    2. Open-Meteo archive         confidence 0.75  (ERA5+satellite blend, hourly)
    3. pvlib Ineichen clearsky    confidence 0.40  (no network needed)

Sub-hourly targets are built by interpolating the clear-sky index (kt), not the
GHI itself, then multiplying by the target-frequency clearsky curve — linear
interpolation of GHI would flatten the midday curvature.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np
import pandas as pd
import requests

logger = logging.getLogger(__name__)

OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
CACHE_DIR = Path.home() / ".nuravolt" / "cache"

CONFIDENCE = {"onsite": 0.95, "open-meteo": 0.75, "clearsky": 0.40}

# Open-Meteo hourly variables -> our column names
_HOURLY_VARS = {
    "shortwave_radiation": "ghi",
    "direct_normal_irradiance": "dni",
    "diffuse_radiation": "dhi",
    "temperature_2m": "temp_air",
    "wind_speed_10m": "wind_speed",
    "cloud_cover": "cloud_cover",
}

# Column names injected into caller DataFrames. Chosen so the existing
# auto-detectors pick them up: 'irradiance' / 'ambient'+'temp' substrings.
IRRADIANCE_COLUMN = "irradiance_openmeteo"
AMBIENT_TEMP_COLUMN = "ambient_temp_openmeteo"
WIND_SPEED_COLUMN = "wind_speed_openmeteo"


@dataclass
class FallbackWeather:
    """Fetched/modeled weather plus provenance."""

    data: pd.DataFrame  # indexed by naive local timestamps
    source: str  # 'open-meteo' | 'clearsky'
    confidence: float
    provenance: Dict[str, Any] = field(default_factory=dict)


def default_array_geometry(latitude: float) -> Tuple[float, float]:
    """Heuristic (tilt, azimuth) when array geometry is unknown.

    tilt ~= |lat| bounded to typical fixed-rack installs; azimuth equator-facing
    (pvlib convention: 180 = south).
    """
    tilt = float(np.clip(abs(latitude), 10.0, 35.0))
    azimuth = 180.0 if latitude >= 0 else 0.0
    return tilt, azimuth


# ---------------------------------------------------------------------------
# timezone helpers
# ---------------------------------------------------------------------------

def _fallback_tz_name(longitude: float) -> str:
    # Etc/GMT signs are inverted: Etc/GMT-1 == UTC+1
    offset = int(round(longitude / 15.0))
    return f"Etc/GMT{-offset:+d}"


def _localize(index: pd.DatetimeIndex, tz_name: str) -> pd.DatetimeIndex:
    """Localize a naive local index for solar-position math.

    DST-ambiguous times are treated as standard time; nonexistent times are
    shifted forward. Falls back to a longitude-based fixed offset on error.
    """
    if index.tz is not None:
        return index
    try:
        return index.tz_localize(
            tz_name,
            ambiguous=np.zeros(len(index), dtype=bool),
            nonexistent="shift_forward",
        )
    except Exception:  # unknown tz name, etc.
        return index.tz_localize("UTC")


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------

def _cache_paths(latitude: float, longitude: float, start_date: str, end_date: str) -> Tuple[Path, Path]:
    key = f"openmeteo_weather_{latitude:.3f}_{longitude:.3f}_{start_date}_{end_date}"
    return CACHE_DIR / f"{key}.parquet", CACHE_DIR / f"{key}.meta.json"


def fetch_open_meteo_weather(
    latitude: float,
    longitude: float,
    start_date: str,
    end_date: str,
    timezone: str = "auto",
    use_cache: bool = True,
) -> Tuple[Optional[pd.DataFrame], Optional[str]]:
    """Fetch hourly weather from the Open-Meteo archive.

    Returns (df, resolved_timezone) or (None, None) on failure. df is indexed
    by naive local timestamps with columns ghi, dni, dhi, temp_air, wind_speed,
    cloud_cover. timezone='auto' lets Open-Meteo resolve the IANA zone from the
    coordinates, matching SCADA exports that use naive local time.
    """
    cache_file, meta_file = _cache_paths(latitude, longitude, start_date, end_date)
    if use_cache and cache_file.exists() and meta_file.exists():
        try:
            df = pd.read_parquet(cache_file)
            tz_name = json.loads(meta_file.read_text())["timezone"]
            return df, tz_name
        except Exception:
            pass

    # Chunk long ranges to keep individual API responses modest.
    starts = pd.date_range(start_date, end_date, freq="730D")
    bounds = [d.strftime("%Y-%m-%d") for d in starts] + [end_date]
    frames = []
    resolved_tz: Optional[str] = None
    for i in range(len(bounds) - 1):
        chunk_start = bounds[i]
        chunk_end = bounds[i + 1]
        params = {
            "latitude": latitude,
            "longitude": longitude,
            "start_date": chunk_start,
            "end_date": chunk_end,
            "hourly": ",".join(_HOURLY_VARS.keys()),
            "timezone": timezone,
            "wind_speed_unit": "ms",
        }
        try:
            resp = requests.get(OPEN_METEO_ARCHIVE_URL, params=params, timeout=120)
            resp.raise_for_status()
            payload = resp.json()
        except requests.RequestException as exc:
            logger.warning("Open-Meteo fetch failed (%s..%s): %s", chunk_start, chunk_end, exc)
            return None, None
        hourly = payload.get("hourly")
        if not hourly or not hourly.get("time"):
            continue
        resolved_tz = payload.get("timezone", resolved_tz)
        n = len(hourly["time"])
        frame = pd.DataFrame(
            {ours: hourly.get(theirs, [None] * n) for theirs, ours in _HOURLY_VARS.items()},
            index=pd.to_datetime(hourly["time"]),
        )
        frames.append(frame)

    if not frames:
        return None, None

    df = pd.concat(frames)
    df = df[~df.index.duplicated(keep="first")].sort_index()
    df = df.dropna(subset=["ghi"])
    if resolved_tz is None:
        resolved_tz = timezone if timezone != "auto" else _fallback_tz_name(longitude)

    if use_cache:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            df.to_parquet(cache_file)
            meta_file.write_text(json.dumps({"timezone": resolved_tz}))
        except Exception as exc:
            logger.debug("Weather cache write failed: %s", exc)

    return df, resolved_tz


# ---------------------------------------------------------------------------
# clearsky / resampling / transposition (pvlib)
# ---------------------------------------------------------------------------

def clearsky_ghi(
    index: pd.DatetimeIndex, latitude: float, longitude: float, tz_name: str
) -> pd.Series:
    """Ineichen clearsky GHI on a naive local index."""
    from pvlib.location import Location

    localized = _localize(index, tz_name)
    loc = Location(latitude, longitude, tz=str(localized.tz))
    cs = loc.get_clearsky(localized, model="ineichen")
    return pd.Series(cs["ghi"].to_numpy(), index=index, name="ghi_clearsky")


def resample_weather(
    hourly: pd.DataFrame,
    freq: str,
    latitude: float,
    longitude: float,
    tz_name: str,
) -> pd.DataFrame:
    """Resample hourly weather to `freq` via clear-sky-index interpolation.

    GHI: kt = GHI/clearsky is interpolated in time, then multiplied by the
    target-frequency clearsky curve. temp/wind/cloud are time-interpolated.
    DNI/DHI are re-derived at the target frequency from GHI (erbs) during
    transposition, so they are dropped here for sub-hourly targets.
    """
    if hourly.empty:
        return hourly

    # Open-Meteo hourly radiation is the mean over the PRECEDING hour, so the
    # value labeled 12:00 is centered at 11:30 — shift radiation to interval
    # centers before treating it as instantaneous. Temp/wind are instantaneous.
    rad_cols = [c for c in ("ghi", "dni", "dhi") if c in hourly.columns]
    radiation = hourly[rad_cols].copy()
    radiation.index = radiation.index - pd.Timedelta(minutes=30)

    target = pd.date_range(hourly.index.min(), hourly.index.max(), freq=freq)
    cs_hourly = clearsky_ghi(radiation.index, latitude, longitude, tz_name)
    kt = (radiation["ghi"] / cs_hourly.where(cs_hourly > 10.0)).clip(0.0, 1.5)

    union = kt.index.union(target)
    kt_hf = kt.reindex(union).interpolate("time", limit_direction="both").reindex(target)
    cs_hf = clearsky_ghi(target, latitude, longitude, tz_name)
    ghi_hf = (kt_hf * cs_hf).clip(lower=0.0)
    # Night: clearsky is 0 so ghi is 0 regardless of kt gaps.
    ghi_hf = ghi_hf.fillna(0.0)

    out = pd.DataFrame({"ghi": ghi_hf}, index=target)
    for col in ("temp_air", "wind_speed", "cloud_cover"):
        if col in hourly.columns:
            inst_union = hourly[col].index.union(target)
            series = hourly[col].reindex(inst_union).interpolate("time", limit_direction="both")
            out[col] = series.reindex(target)
    return out


def transpose_to_poa(
    weather: pd.DataFrame,
    latitude: float,
    longitude: float,
    tilt: float,
    azimuth: float,
    tz_name: str,
) -> pd.Series:
    """GHI -> plane-of-array via pvlib (erbs decomposition when DNI/DHI absent)."""
    from pvlib import irradiance, solarposition

    localized = _localize(weather.index, tz_name)
    solpos = solarposition.get_solarposition(localized, latitude, longitude)
    zenith = pd.Series(solpos["apparent_zenith"].to_numpy(), index=weather.index)

    if {"dni", "dhi"}.issubset(weather.columns) and weather["dni"].notna().any():
        dni = weather["dni"].fillna(0.0)
        dhi = weather["dhi"].fillna(0.0)
    else:
        erbs = irradiance.erbs(weather["ghi"].to_numpy(), zenith.to_numpy(), localized)
        dni = pd.Series(np.asarray(erbs["dni"]), index=weather.index).fillna(0.0)
        dhi = pd.Series(np.asarray(erbs["dhi"]), index=weather.index).fillna(0.0)

    poa = irradiance.get_total_irradiance(
        surface_tilt=tilt,
        surface_azimuth=azimuth,
        solar_zenith=zenith.to_numpy(),
        solar_azimuth=solpos["azimuth"].to_numpy(),
        dni=dni.to_numpy(),
        ghi=weather["ghi"].to_numpy(),
        dhi=dhi.to_numpy(),
    )
    return pd.Series(np.asarray(poa["poa_global"]), index=weather.index, name="poa").clip(lower=0.0).fillna(0.0)


# ---------------------------------------------------------------------------
# public chain
# ---------------------------------------------------------------------------

def get_fallback_weather(
    latitude: float,
    longitude: float,
    start_date: str,
    end_date: str,
    freq: str = "1h",
    tilt: Optional[float] = None,
    azimuth: Optional[float] = None,
    timezone: str = "auto",
    use_cache: bool = True,
) -> FallbackWeather:
    """Best-available modeled weather for a site and date range.

    Tries Open-Meteo (confidence 0.75); degrades to pure Ineichen clearsky
    (confidence 0.40, irradiance only) when offline. Adds a `poa` column using
    provided or heuristic array geometry.
    """
    geometry_defaulted = tilt is None or azimuth is None
    if geometry_defaulted:
        d_tilt, d_azi = default_array_geometry(latitude)
        tilt = d_tilt if tilt is None else tilt
        azimuth = d_azi if azimuth is None else azimuth

    hourly, tz_name = fetch_open_meteo_weather(
        latitude, longitude, start_date, end_date, timezone=timezone, use_cache=use_cache
    )

    if hourly is not None and not hourly.empty:
        source = "open-meteo"
        data = resample_weather(hourly, freq, latitude, longitude, tz_name)
    else:
        source = "clearsky"
        tz_name = timezone if timezone != "auto" else _fallback_tz_name(longitude)
        index = pd.date_range(start_date, end_date, freq=freq)
        data = pd.DataFrame({"ghi": clearsky_ghi(index, latitude, longitude, tz_name)}, index=index)

    try:
        data["poa"] = transpose_to_poa(data, latitude, longitude, tilt, azimuth, tz_name)
    except Exception as exc:
        logger.warning("POA transposition failed (%s); keeping GHI only", exc)

    return FallbackWeather(
        data=data,
        source=source,
        confidence=CONFIDENCE[source],
        provenance={
            "source": source,
            "confidence": CONFIDENCE[source],
            "timezone": tz_name,
            "latitude": latitude,
            "longitude": longitude,
            "tilt": tilt,
            "azimuth": azimuth,
            "geometry_defaulted": geometry_defaulted,
            "freq": freq,
        },
    )


def _infer_freq(index: pd.DatetimeIndex) -> str:
    diffs = np.diff(index.values[: min(len(index), 5000)]).astype("timedelta64[s]").astype(int)
    diffs = diffs[diffs > 0]
    if len(diffs) == 0:
        return "1h"
    seconds = int(np.median(diffs))
    if seconds % 3600 == 0:
        return f"{seconds // 3600}h"
    return f"{max(seconds // 60, 1)}min"


def _align_to_index(
    data: pd.DataFrame, index: pd.DatetimeIndex, tolerance: pd.Timedelta
) -> pd.DataFrame:
    # nearest-reindex needs a unique monotonic target; SCADA indexes can have
    # duplicates or be unsorted, so align on the unique sorted labels first,
    # then broadcast back with an exact-label lookup.
    unique_sorted = pd.DatetimeIndex(index.unique()).sort_values()
    return data.reindex(unique_sorted, method="nearest", tolerance=tolerance).reindex(index)


def _detect_time_shift(
    data: pd.DataFrame,
    index: pd.DatetimeIndex,
    reference: pd.Series,
    irr_col: str,
    step: pd.Timedelta,
    max_steps: int = 8,
    min_gain: float = 0.02,
) -> Tuple[pd.Timedelta, float, float]:
    """Find the fallback→logger clock offset by maximizing daytime correlation
    between fallback irradiance and a production signal (e.g. fleet-mean power).

    SCADA loggers commonly run fixed standard time while modeled weather uses
    DST local time; the offset is unknowable per vendor, so detect it.
    Returns (shift, best_r, unshifted_r); shift is zero unless it beats the
    unshifted correlation by `min_gain`.
    """
    ref = pd.Series(np.asarray(reference, dtype=float), index=index)
    zero = pd.Timedelta(0)
    best_shift, best_r, r0 = zero, -np.inf, np.nan
    for s in range(-max_steps, max_steps + 1):
        shift = s * step
        candidate = _align_to_index(data.shift(freq=shift) if s else data, index, step)[irr_col]
        mask = candidate.notna() & ref.notna() & (candidate > 20.0)
        if mask.sum() < 100:
            continue
        r = float(np.corrcoef(candidate[mask], ref[mask])[0, 1])
        if s == 0:
            r0 = r
        if r > best_r:
            best_shift, best_r = shift, r
    if not np.isfinite(best_r) or (np.isfinite(r0) and best_r - r0 < min_gain):
        return zero, r0, r0
    return best_shift, best_r, r0


# Public name — the physics twin pipeline (nuravolt/pipeline/twin.py) imports
# this directly; keep the underscore alias for existing internal callers.
detect_time_shift = _detect_time_shift


def fallback_columns_for_index(
    index: pd.DatetimeIndex,
    latitude: float,
    longitude: float,
    tilt: Optional[float] = None,
    azimuth: Optional[float] = None,
    timezone: str = "auto",
    prefer_poa: bool = True,
    use_cache: bool = True,
    align_reference: Optional[pd.Series] = None,
) -> Tuple[Optional[pd.DataFrame], Dict[str, Any]]:
    """Fallback weather aligned to an existing (naive local) DatetimeIndex.

    Returns (aligned df, provenance). Aligned columns: IRRADIANCE_COLUMN,
    AMBIENT_TEMP_COLUMN, WIND_SPEED_COLUMN (temp/wind only when the source
    provides them). Returns (None, {}) when nothing could be fetched/modeled.

    `align_reference`: optional production signal positionally aligned with
    `index` (e.g. fleet-mean AC power) used to auto-detect the logger's clock
    offset vs modeled weather (DST/standard-time mismatches).
    """
    if len(index) == 0:
        return None, {}
    index = pd.DatetimeIndex(index)
    freq = _infer_freq(index)
    start = (index.min() - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    end = (index.max() + pd.Timedelta(days=1)).strftime("%Y-%m-%d")

    try:
        fw = get_fallback_weather(
            latitude, longitude, start, end,
            freq=freq, tilt=tilt, azimuth=azimuth, timezone=timezone, use_cache=use_cache,
        )
    except Exception as exc:
        logger.warning("Weather fallback unavailable: %s", exc)
        return None, {}

    irr_source_col = "poa" if (prefer_poa and "poa" in fw.data.columns) else "ghi"
    tolerance = pd.Timedelta(freq)

    time_shift = pd.Timedelta(0)
    alignment_r = None
    if align_reference is not None and len(align_reference) == len(index):
        try:
            time_shift, best_r, r0 = _detect_time_shift(
                fw.data, index, align_reference, irr_source_col, tolerance
            )
            alignment_r = best_r
            if time_shift != pd.Timedelta(0):
                logger.info(
                    "Weather fallback clock offset detected: %s (r %.3f -> %.3f)",
                    time_shift, r0, best_r,
                )
                fw.data = fw.data.shift(freq=time_shift)
        except Exception as exc:
            logger.debug("Clock-offset detection failed: %s", exc)

    aligned = _align_to_index(fw.data, index, tolerance)

    out = pd.DataFrame(index=index)
    out[IRRADIANCE_COLUMN] = aligned[irr_source_col]
    if "temp_air" in aligned.columns:
        out[AMBIENT_TEMP_COLUMN] = aligned["temp_air"]
    if "wind_speed" in aligned.columns:
        out[WIND_SPEED_COLUMN] = aligned["wind_speed"]

    provenance = dict(fw.provenance)
    provenance.update(
        {
            "irradiance_column": IRRADIANCE_COLUMN,
            "irradiance_plane": "poa" if irr_source_col == "poa" else "ghi",
            "coverage": float(out[IRRADIANCE_COLUMN].notna().mean()),
            "time_shift_minutes": int(time_shift.total_seconds() // 60),
            "alignment_r": None if alignment_r is None else round(float(alignment_r), 3),
        }
    )
    if out[IRRADIANCE_COLUMN].notna().mean() < 0.5:
        logger.warning(
            "Weather fallback covers only %.0f%% of the requested index",
            100 * out[IRRADIANCE_COLUMN].notna().mean(),
        )
    return out, provenance


def ensure_irradiance(
    df: pd.DataFrame,
    latitude: float,
    longitude: float,
    tilt: Optional[float] = None,
    azimuth: Optional[float] = None,
    timezone: str = "auto",
    prefer_poa: bool = True,
    use_cache: bool = True,
    align_reference: Optional[pd.Series] = None,
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """Inject fallback irradiance/temp/wind columns into a DataFrame.

    `df` must have a naive-local DatetimeIndex. Returns (df with injected
    columns, provenance); raises ValueError when the fallback yields nothing.
    Pass a production signal (fleet-mean power) as `align_reference` to
    auto-correct logger-vs-model clock offsets.
    """
    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError("ensure_irradiance requires a DatetimeIndex")
    cols, provenance = fallback_columns_for_index(
        df.index, latitude, longitude,
        tilt=tilt, azimuth=azimuth, timezone=timezone,
        prefer_poa=prefer_poa, use_cache=use_cache,
        align_reference=align_reference,
    )
    if cols is None:
        raise ValueError("weather fallback could not produce irradiance (offline and clearsky failed)")
    df = df.copy()
    for col in cols.columns:
        # positional assignment — label alignment breaks on duplicate indexes
        df[col] = cols[col].to_numpy()
    return df, provenance
