#!/usr/bin/env python
"""7-day physics-based power forecast for the import/onboarding pipeline.

Same zero-training PVWatts twin as nuravolt.pipeline.twin, but driven by the
Open-Meteo *forecast* API (next 7 days) instead of the archive: per-inverter
physics predictions on forecast weather, summed to plant level.

Rows land in analysis_results (domain='power_forecast'):
  device_id='PLANT'  metric='expected_power_kw'    hourly, now -> now+7d (UTC)
  device_id='PLANT'  metric='expected_energy_kwh'  one row per local day at
                                                   local-day noon UTC (sum of
                                                   that local day's hourly kW;
                                                   1h steps => kWh)
  device_id='PLANT'  metric='ghi_wm2'              hourly forecast global
                                                   horizontal irradiance
  device_id='PLANT'  metric='poa_wm2'              hourly plane-of-array
                                                   irradiance at the plant's
                                                   dominant array geometry

model_version='forecast-physics-v1'. Idempotent: every run deletes the plant's
previous power_forecast rows before writing (a forecast is only ever "the
latest one" — stale future rows must not accumulate under old run ids).

Run locally:

    python -m nuravolt.pipeline.power_forecast --plant-id <uuid-or-slug> [--days 7]
"""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

try:  # optional in CI images until installed
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env")
except Exception:  # noqa: BLE001
    pass

import pandas as pd  # noqa: E402
import psycopg2  # noqa: E402
import requests  # noqa: E402

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402
from nuravolt.digitaltwin.physics_model import create_physics_model  # noqa: E402
from nuravolt.pipeline.twin import load_plant_geometry  # noqa: E402
from nuravolt.weather.fallback import transpose_to_poa  # noqa: E402

OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
MODEL_VERSION = "forecast-physics-v1"
CONFIDENCE = 0.75  # modeled weather, same tier as the Open-Meteo archive

# Open-Meteo hourly variables -> the column names nuravolt.weather.fallback uses
_HOURLY_VARS = {
    "shortwave_radiation": "ghi",
    "direct_normal_irradiance": "dni",
    "diffuse_radiation": "dhi",
    "temperature_2m": "temp_air",
    "wind_speed_10m": "wind_speed",
}


def fetch_forecast_weather(
    lat: float, lon: float, days: int = 7
) -> Tuple[pd.DataFrame, str]:
    """Fetch hourly forecast weather from Open-Meteo (no caching — forecasts go
    stale by definition).

    Returns (df, resolved_timezone). df is indexed by naive *local* timestamps
    with columns ghi, dni, dhi, temp_air, wind_speed — the same convention as
    nuravolt.weather.fallback.fetch_open_meteo_weather. forecast_days=days+1 so
    the horizon fully covers now -> now+days regardless of the local clock.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": ",".join(_HOURLY_VARS.keys()),
        "timezone": "auto",
        "wind_speed_unit": "ms",
        "forecast_days": days + 1,
    }
    resp = requests.get(OPEN_METEO_FORECAST_URL, params=params, timeout=60)
    resp.raise_for_status()
    payload = resp.json()

    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise ValueError("Open-Meteo forecast returned no hourly data")

    n = len(times)
    df = pd.DataFrame(
        {ours: hourly.get(theirs, [None] * n) for theirs, ours in _HOURLY_VARS.items()},
        index=pd.to_datetime(times),
    )
    df = df.dropna(subset=["ghi"]).sort_index()
    resolved_tz = payload.get("timezone") or "UTC"
    return df, resolved_tz


def generate_power_forecast(conn, plant_id: str, days: int = 7) -> Dict[str, Any]:
    """Generate + persist the plant's forward power forecast. Returns a summary."""
    plant = load_plant_geometry(conn, plant_id)
    inverters = plant["inverters"]
    if not inverters:
        return {"rows_written": 0, "days": days, "note": "no inverters"}

    lat, lon = float(plant["latitude"]), float(plant["longitude"])
    wx, tz_name = fetch_forecast_weather(lat, lon, days=days)
    if wx.empty:
        return {"rows_written": 0, "days": days, "note": "no weather"}

    # POA per distinct array geometry (groups usually share tilt/azimuth).
    default_tilt = float(inverters[0]["tilt"] or 25.0)
    default_azimuth = float(inverters[0]["azimuth"] or 180.0)
    poa_by_geom: Dict[Tuple[float, float], pd.Series] = {}

    def _poa(tilt: float, azimuth: float) -> pd.Series:
        key = (round(tilt, 2), round(azimuth, 2))
        if key not in poa_by_geom:
            poa_by_geom[key] = transpose_to_poa(wx, lat, lon, tilt, azimuth, tz_name)
        return poa_by_geom[key]

    # Open-Meteo returns a naive *local* index; analysis_results.time is true
    # UTC (TIMESTAMPTZ), so convert local->UTC via the resolved IANA zone —
    # same convention as nuravolt.pipeline.twin (relabeling local as UTC would
    # shift the whole curve by the plant's offset).
    _idx = pd.to_datetime(wx.index)
    if _idx.tz is None:
        try:
            wx_utc_index = _idx.tz_localize(
                tz_name, ambiguous="NaT", nonexistent="shift_forward"
            ).tz_convert("UTC")
        except Exception:  # noqa: BLE001 - unknown tz string -> treat as UTC
            wx_utc_index = _idx.tz_localize("UTC")
    else:
        wx_utc_index = _idx.tz_convert("UTC")

    # Predict per inverter, sum to plant-level hourly kW.
    plant_kw = pd.Series(0.0, index=wx.index)
    for inv in inverters:
        rating = float(inv["inverter_nominal_power_kw"] or 200.0)
        gamma = float(inv["gamma_pdc"]) if inv["gamma_pdc"] is not None else -0.004
        tilt = float(inv["tilt"] or default_tilt)
        azimuth = float(inv["azimuth"] or default_azimuth)
        model = create_physics_model(
            capacity_kw=rating, latitude=lat, longitude=lon,
            tilt=tilt, azimuth=azimuth, gamma_pdc=gamma,
        )
        frame = wx.copy()
        frame["poa"] = _poa(tilt, azimuth)
        pred = model.predict(
            frame, irradiance_col="poa", temperature_col="temp_air", wind_col="wind_speed"
        )
        plant_kw = plant_kw + pd.Series(pred, index=wx.index)

    # Assemble rows: hourly kW inside now -> now+days; daily kWh per *local*
    # day over the full fetched horizon (1h steps => the sum of hourly kW is
    # kWh), stamped at local-day noon UTC like the twin's daily rows.
    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=days)

    hourly_records: List[Dict[str, Any]] = []
    daily_kwh: Dict[str, float] = {}
    # Irradiance forecast series: GHI straight from the weather model, POA at
    # the plant's dominant geometry (the location-based "what sun will I get"
    # view, independent of inverter sizing).
    poa_default = _poa(default_tilt, default_azimuth)
    ghi_values = wx["ghi"].to_numpy()
    poa_values = poa_default.reindex(wx.index).to_numpy()
    for local_ts, utc_ts, kw, ghi, poa in zip(
        _idx, wx_utc_index, plant_kw.to_numpy(), ghi_values, poa_values
    ):
        if pd.isna(utc_ts):
            continue  # DST-ambiguous hour dropped by tz_localize
        kw = max(float(kw), 0.0)
        day_key = local_ts.date().isoformat()
        daily_kwh[day_key] = daily_kwh.get(day_key, 0.0) + kw
        t = utc_ts.to_pydatetime()
        if now <= t <= horizon:
            hourly_records.append(
                {
                    "time": t,
                    "device_id": "PLANT",
                    "metric": "expected_power_kw",
                    "value": round(kw, 3),
                    "confidence": CONFIDENCE,
                }
            )
            if ghi is not None and not pd.isna(ghi):
                hourly_records.append(
                    {
                        "time": t,
                        "device_id": "PLANT",
                        "metric": "ghi_wm2",
                        "value": round(max(float(ghi), 0.0), 1),
                        "confidence": CONFIDENCE,
                    }
                )
            if poa is not None and not pd.isna(poa):
                hourly_records.append(
                    {
                        "time": t,
                        "device_id": "PLANT",
                        "metric": "poa_wm2",
                        "value": round(max(float(poa), 0.0), 1),
                        "confidence": CONFIDENCE,
                    }
                )

    daily_records: List[Dict[str, Any]] = []
    for day_key in sorted(daily_kwh):
        t = datetime.fromisoformat(day_key).replace(hour=12, tzinfo=timezone.utc)
        daily_records.append(
            {
                "time": t,
                "device_id": "PLANT",
                "metric": "expected_energy_kwh",
                "value": round(daily_kwh[day_key], 1),
                "confidence": CONFIDENCE,
            }
        )

    # Idempotency: a forecast supersedes all previous ones — clear the domain
    # for this plant before writing (run_id changes daily, so upsert alone
    # would leave yesterday's stale future rows behind).
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM analysis_results WHERE plant_id = %s AND domain = 'power_forecast'",
            (plant_id,),
        )
    conn.commit()

    writer = TimeseriesWriter()
    run_id = str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"power-forecast:{plant_id}:{date.today().isoformat()}")
    )
    written = writer.write_analysis_results(
        plant_id=plant_id,
        domain="power_forecast",
        records=hourly_records + daily_records,
        model_version=MODEL_VERSION,
        run_id=run_id,
    )

    return {"rows_written": written, "days": days}


def _connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")
    return psycopg2.connect(dsn)


def main() -> int:
    parser = argparse.ArgumentParser(description="7-day physics power forecast for one plant")
    parser.add_argument("--plant-id", required=True, help="Plant uuid or slug")
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()

    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT id, slug FROM "Plant" WHERE id = %s OR slug = %s LIMIT 1',
                (args.plant_id, args.plant_id),
            )
            row = cur.fetchone()
        if not row:
            print(f"Plant not found: {args.plant_id}", file=sys.stderr)
            return 1
        plant_id, slug = row
        summary = generate_power_forecast(conn, plant_id, days=args.days)
        print(f"[power-forecast] plant={slug} ({plant_id}): {summary}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
