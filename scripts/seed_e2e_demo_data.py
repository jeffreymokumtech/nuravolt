#!/usr/bin/env python
"""Seed realistic demo telemetry for a plant, synthesized from Open-Meteo.

Built for the full-circle E2E test; reusable for demo/staging environments.

    python scripts/seed_e2e_demo_data.py --plant-id <uuid-or-slug> [--days 30] [--operational]

What it writes (idempotent, fixed run_id per plant):
  measurements        power_ac / irradiance_poa / temp_air per inverter, hourly
  analysis_results    domain digitaltwin: hourly PLANT power_ac_{predicted,
                      actual,residual} + daily per-inverter rows
                      domain soiling: daily soiling_ratio per inverter +
                      fleet/economics summary metrics the soiling summary
                      route reads (fleet_sr_mean, fleet_*_count, cleaning_*,
                      ytd_energy_loss_mwh, next_cleaning_date)
  DataConnection + PlantDataSource + LatestDeviceSnapshot  (so the
                      onboarding-status "first data" step completes)
  Ticket              one open soiling ticket on the dirtiest inverter

Weather comes from nuravolt.weather.fallback.get_fallback_weather (Open-Meteo
archive + pvlib POA transposition) for the plant's own coordinates. One
inverter fouls ~2.5x faster than the rest so soiling analytics have a story.

Local-dev only extra: creates plain-SQL analysis_daily / measurements_daily
views when the TimescaleDB continuous aggregates are absent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_ROOT / ".env")
except Exception:  # noqa: BLE001
    pass

import psycopg2  # noqa: E402
import psycopg2.extras  # noqa: E402

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402
from nuravolt.weather.fallback import get_fallback_weather  # noqa: E402

PR = 0.82  # flat performance ratio for the twin's simple clean model
BASE_SOILING_PER_DAY = 0.0015
DIRTY_SOILING_PER_DAY = 0.0038  # the outlier inverter

# --- "actual" plant physics (the twin's model above stays deliberately
# simpler, so healthy residuals carry believable diurnal structure instead of
# pure white noise) ---
NOCT_C = 45.0                # cell temp model: Tc = Tair + poa/800 * (NOCT-20)
GAMMA_PER_K = -0.0038        # power temperature coefficient (1/K)
LOW_LIGHT_KNEE_WM2 = 200.0   # inverter/module efficiency rolloff below this
AR1_RHO = 0.7                # autocorrelated sensor/plant noise
AR1_SD = 0.018               # stationary standard deviation (~1.8%)
RAIN_RESET_MM = 5.0          # daily rain above this partially cleans the array
SR_DAILY_NOISE = 0.003       # daily observation noise on the soiling ratio


def _hash_unit(key: str) -> float:
    """Deterministic uniform [0,1) from a string key (stable across runs)."""
    return (int(hashlib.md5(key.encode()).hexdigest(), 16) % 10_000) / 10_000.0


def _fetch_daily_rain(lat: float, lon: float, start: str, end: str) -> Dict[str, float]:
    """Daily precipitation (mm) from the Open-Meteo archive; {} when offline.

    The soiling walk uses this for rain resets; without it the decline is
    monotonic (same as the pre-2026-07 behaviour)."""
    import urllib.parse
    import urllib.request

    url = (
        "https://archive-api.open-meteo.com/v1/archive?"
        + urllib.parse.urlencode(
            {
                "latitude": f"{lat:.4f}",
                "longitude": f"{lon:.4f}",
                "start_date": start,
                "end_date": end,
                "daily": "precipitation_sum",
                "timezone": "UTC",
            }
        )
    )
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        days = payload.get("daily", {}).get("time", [])
        vals = payload.get("daily", {}).get("precipitation_sum", [])
        return {d: float(v) for d, v in zip(days, vals) if v is not None}
    except Exception as exc:  # noqa: BLE001
        print(f"[seed] rain fetch failed ({exc}); soiling resets disabled")
        return {}


def _connect():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")
    return psycopg2.connect(dsn)


def load_plant(conn, ref: str) -> Dict[str, Any]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT p.id, p.slug, p.name, p.latitude, p.longitude, p.capacity_mw, p.status, '
            '       p.asset_type, p.timezone, p.organization_id, o.clerk_org_id '
            'FROM "Plant" p LEFT JOIN "Organization" o ON o.id = p.organization_id '
            'WHERE p.id = %s OR p.slug = %s LIMIT 1',
            (ref, ref),
        )
        plant = cur.fetchone()
        if not plant:
            raise SystemExit(f"Plant not found: {ref}")
        cur.execute(
            'SELECT g.id AS group_id, g.tilt, g.azimuth, g.inverter_nominal_power_kw, '
            '       i.external_id '
            'FROM "InverterGroup" g JOIN "Inverter" i ON i.group_id = g.id '
            'WHERE g.plant_id = %s ORDER BY i.external_id',
            (plant["id"],),
        )
        inverters = cur.fetchall()
    asset_type = str(plant.get("asset_type") or "PV")
    if not inverters and asset_type in ("PV", "HYBRID"):
        raise SystemExit("PV plant has no inverters; onboard with inverter groups first")
    return {**dict(plant), "inverters": [dict(r) for r in inverters]}


def ensure_local_daily_views(conn) -> None:
    """Plain-PG substitutes for Timescale continuous aggregates (dev only)."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
        if cur.fetchone():
            return  # real aggregates exist in Timescale environments
        cur.execute(
            """
            CREATE OR REPLACE VIEW analysis_daily AS
            SELECT date_trunc('day', time) AS bucket, plant_id, device_id, domain, metric,
                   AVG(value) AS avg_value, MIN(value) AS min_value, MAX(value) AS max_value,
                   AVG(confidence) AS avg_confidence, COUNT(*)::int AS sample_count
            FROM analysis_results GROUP BY 1,2,3,4,5;
            CREATE OR REPLACE VIEW measurements_daily AS
            SELECT date_trunc('day', time) AS bucket, plant_id, device_id, metric,
                   AVG(value) AS avg_value, MIN(value) AS min_value, MAX(value) AS max_value,
                   COUNT(*)::int AS sample_count
            FROM measurements GROUP BY 1,2,3,4;
            """
        )
    conn.commit()


def synthesize(plant: Dict[str, Any], days: int, problems: bool = False, allow_clearsky: bool = False):
    lat, lon = float(plant["latitude"]), float(plant["longitude"])
    group = plant["inverters"][0]
    tilt = float(group["tilt"] or 25)
    azimuth = float(group["azimuth"] or 180)

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)
    wx = get_fallback_weather(
        lat, lon, start.isoformat(), end.isoformat(), freq="1h", tilt=tilt, azimuth=azimuth
    )
    df = wx.data.dropna(subset=["poa"]).copy()
    # Weather comes back on a naive index in the zone it was BUILT in
    # (wx.provenance['timezone']); measurements are stored true UTC
    # (TIMESTAMPTZ). Convert with THAT zone — not Plant.timezone, whose 'UTC'
    # default shifted seeded curves off solar time. Same convention as
    # nuravolt/pipeline/twin.py (_weather_index_to_utc).
    weather_tz = str(wx.provenance.get("timezone") or plant.get("timezone") or "UTC")
    _idx = pd.to_datetime(df.index)
    if _idx.tz is None:
        try:
            df.index = _idx.tz_localize(weather_tz, ambiguous="NaT", nonexistent="shift_forward").tz_convert("UTC")
        except Exception:  # noqa: BLE001 - unknown tz -> treat as UTC
            df.index = _idx.tz_localize("UTC")
    else:
        df.index = _idx.tz_convert("UTC")
    df = df[df.index.notna()]
    print(f"[seed] weather source={wx.source} rows={len(df)} tz={weather_tz} ({start}..{end})")
    if wx.source != "open-meteo" and not allow_clearsky:
        raise SystemExit(
            "[seed] weather fell back to the clear-sky model (Open-Meteo unreachable). "
            "Every day would be an identical cloudless bell curve, which reads fake. "
            "Retry with network access, or pass --allow-clearsky to proceed anyway."
        )

    inverters = plant["inverters"]
    dirty_idx = min(2, len(inverters) - 1)  # third inverter is the dirty one
    rng = random.Random(42)
    # Deterministic per-inverter fouling spread (x0.75..x1.25 of the base
    # rate) so the "dirtiest first" ranking shows a realistic distribution
    # instead of one outlier over a uniform fleet.
    soil_jitter = {
        inv["external_id"]: 0.75 + (int(hashlib.md5(inv["external_id"].encode()).hexdigest(), 16) % 51) / 100.0
        for inv in inverters
    }
    # Static per-inverter mismatch: no two units are clones. Small PR and
    # irradiance (orientation/row-position) spreads, deterministic per id.
    pr_mult = {
        inv["external_id"]: 0.985 + 0.03 * _hash_unit(f"{inv['external_id']}:pr")
        for inv in inverters
    }
    poa_mult = {
        inv["external_id"]: 0.99 + 0.02 * _hash_unit(f"{inv['external_id']}:poa")
        for inv in inverters
    }
    # Autocorrelated noise state per inverter (AR(1), replaces uniform white).
    ar_state = {inv["external_id"]: 0.0 for inv in inverters}
    ar_innov_sd = AR1_SD * math.sqrt(1.0 - AR1_RHO * AR1_RHO)

    # The "actual" physics factor (temperature derate + low-light rolloff) is
    # normalised to a POA-weighted mean of 1.0 over the window, so the fleet
    # delivery ratio stays governed by soiling + problem inverters (the PPA
    # breach story), while the twin residual gains diurnal structure.
    def _low_light(poa_wm2: float) -> float:
        return 0.85 + 0.15 * min(1.0, poa_wm2 / LOW_LIGHT_KNEE_WM2)

    _w = _t = _l = 0.0
    for _ts, _row in df.iterrows():
        _poa = max(0.0, float(_row["poa"]))
        if _poa <= 5:
            continue
        _tair = float(_row.get("temp_air", 20.0) or 20.0)
        _tc = _tair + _poa / 800.0 * (NOCT_C - 20.0)
        _w += _poa
        _t += _poa * _tc
        _l += _poa * _low_light(_poa)
    t_ref = (_t / _w) if _w > 0 else 45.0
    ll_ref = (_l / _w) if _w > 0 else 1.0

    # Daily rain at the site: soiling partially resets after wet days. The
    # dirty inverter recovers less (cemented dust), keeping it the dirtiest.
    rain_by_day = _fetch_daily_rain(lat, lon, start.isoformat(), end.isoformat())
    day_keys = [(start + timedelta(days=i)).isoformat() for i in range(days + 1)]
    sr_walk: Dict[str, Dict[str, float]] = {}  # dev -> day_key -> sr state
    for i, inv in enumerate(inverters):
        dev = inv["external_id"]
        rate = (
            DIRTY_SOILING_PER_DAY
            if i == dirty_idx
            else BASE_SOILING_PER_DAY * soil_jitter[dev]
        )
        sr_state = 0.99
        series: Dict[str, float] = {}
        for dk in day_keys:
            sr_state = max(0.82, sr_state - rate)
            rain = rain_by_day.get(dk, 0.0)
            if rain >= RAIN_RESET_MM:
                recovery = min(0.85, 0.45 + rain / 40.0)
                if i == dirty_idx:
                    recovery *= 0.5
                sr_state = min(0.995, sr_state + (0.995 - sr_state) * recovery)
            series[dk] = sr_state
        sr_walk[dev] = series

    # --problems: three visibly unhealthy inverters (in addition to the dirty
    # one) so the twin, faults, and drill-down pages have a story to tell.
    #   derate_idx : thermal derating ramping to ~70% output over the last 14d
    #                (with day-to-day jitter and one partial-recovery day)
    #   trip_idx   : overtemperature trips on hot afternoons (probabilistic,
    #                1-3h, only on the hottest ~15% of days) — matches the
    #                seeded ticket's overtemperature narrative
    #   dead_idx   : two days of decaying/flapping output, then offline for
    #                the last 3 days
    derate_idx = 16 if problems and len(inverters) > 16 else None
    trip_idx = 10 if problems and len(inverters) > 10 else None
    dead_idx = 20 if problems and len(inverters) > 20 else None
    total_days = days

    # Hot-day trip windows: day -> set of UTC hours the trip inverter is out.
    trip_windows: Dict[str, set] = {}
    if trip_idx is not None:
        day_max_temp: Dict[str, float] = {}
        for _ts, _row in df.iterrows():
            dk = _ts.date().isoformat()
            _tair = float(_row.get("temp_air", 20.0) or 20.0)
            day_max_temp[dk] = max(day_max_temp.get(dk, -99.0), _tair)
        temps = sorted(day_max_temp.values())
        p85 = temps[int(len(temps) * 0.85)] if temps else 99.0
        for dk, tmax in day_max_temp.items():
            if tmax >= p85 and _hash_unit(f"trip:{dk}") < 0.75:
                start_h = 8 + int(_hash_unit(f"trip-start:{dk}") * 4)  # 8-11 UTC
                duration = 1 + int(_hash_unit(f"trip-len:{dk}") * 3)  # 1-3 h
                trip_windows[dk] = {start_h + h for h in range(duration)}

    measurements: List[Dict[str, Any]] = []
    twin_hourly: List[Dict[str, Any]] = []  # PLANT-level
    twin_daily_dev: Dict[str, Dict[str, Dict[str, float]]] = {}  # day -> dev -> sums
    sr_daily: Dict[str, Dict[str, float]] = {}  # day -> dev -> sr
    fleet_pred_sum = 0.0  # delivery-invariant check (daylight, all inverters)
    fleet_actual_sum = 0.0

    for ts, row in df.iterrows():
        poa = max(0.0, float(row["poa"]))
        temp = float(row.get("temp_air", 20.0) or 20.0)
        t = ts.to_pydatetime().replace(tzinfo=timezone.utc)
        day_offset = (t.date() - start).days
        day_key = t.date().isoformat()

        plant_pred = 0.0
        plant_actual = 0.0
        # Diurnal physics the twin's flat-PR model does not know about:
        # temperature derate + low-light rolloff, normalised so the
        # POA-weighted window mean is 1.0 (delivery stays soiling-driven).
        cell_temp = temp + poa / 800.0 * (NOCT_C - 20.0)
        physics = (
            (1.0 + GAMMA_PER_K * (cell_temp - t_ref)) * (_low_light(poa) / ll_ref)
            if poa > 5
            else 1.0
        )

        for i, inv in enumerate(inverters):
            dev_id = inv["external_id"]
            rating = float(inv["inverter_nominal_power_kw"] or 200.0)
            sr_base = sr_walk[dev_id].get(day_key, 0.99)
            # Daily observation noise on the ratio (sensor/estimation jitter).
            sr = min(1.0, max(0.80, sr_base + (2.0 * _hash_unit(f"sr:{dev_id}:{day_key}") - 1.0) * SR_DAILY_NOISE))
            pred = min(rating, poa / 1000.0 * rating * PR)
            if poa > 5:
                e_prev = ar_state[dev_id]
                e_now = AR1_RHO * e_prev + rng.gauss(0.0, ar_innov_sd)
                ar_state[dev_id] = e_now
            else:
                e_now = ar_state[dev_id]
            base = (
                poa * poa_mult[dev_id] / 1000.0
                * rating
                * PR
                * pr_mult[dev_id]
                * physics
                * sr
            )
            actual = max(0.0, min(rating, base * (1.0 + e_now)))

            if i == derate_idx:
                # Thermal derating developing over the last 14 days, with
                # day-to-day depth jitter and one partial-recovery day.
                ramp = max(0.0, (day_offset - (total_days - 14)) / 14.0)
                depth = 0.30 * min(1.0, ramp)
                depth *= 0.85 + 0.3 * _hash_unit(f"derate:{day_key}")
                if day_offset == total_days - 6:
                    depth *= 0.45  # brief recovery before it worsens again
                actual *= 1.0 - min(0.45, depth)
            if i == trip_idx and t.hour in trip_windows.get(day_key, ()):  # hot-day trips
                actual = 0.0
            if i == dead_idx:
                if day_offset >= total_days - 3:
                    actual = 0.0
                elif day_offset >= total_days - 5:
                    # Flapping before the final failure: erratic partial output.
                    u = _hash_unit(f"flap:{day_key}:{t.hour}")
                    actual = 0.0 if u < 0.4 else actual * (0.3 + 0.4 * u)

            dev = dev_id
            if poa > 5:  # daylight rows only for measurements
                measurements.append({"time": t, "device_id": dev, "metric": "power_ac", "value": round(actual, 3), "unit": "kW", "quality": 100})
                measurements.append({"time": t, "device_id": dev, "metric": "irradiance_poa", "value": round(poa, 1), "unit": "W/m2", "quality": 100})
                measurements.append({"time": t, "device_id": dev, "metric": "temp_air", "value": round(temp, 1), "unit": "C", "quality": 100})

            plant_pred += pred
            plant_actual += actual

            d = twin_daily_dev.setdefault(day_key, {}).setdefault(dev, {"pred": 0.0, "act": 0.0, "n": 0})
            if poa > 5:
                d["pred"] += pred
                d["act"] += actual
                d["n"] += 1
                fleet_pred_sum += pred
                fleet_actual_sum += actual
            sr_daily.setdefault(day_key, {})[dev] = sr

        if poa > 5:
            twin_hourly.extend(
                [
                    {"time": t, "device_id": "PLANT", "metric": "power_ac_predicted", "value": round(plant_pred, 3)},
                    {"time": t, "device_id": "PLANT", "metric": "power_ac_actual", "value": round(plant_actual, 3)},
                    {"time": t, "device_id": "PLANT", "metric": "power_ac_residual", "value": round(plant_actual - plant_pred, 3)},
                ]
            )

    # Daily fleet-mean SR as a measurement series (device PLANT) so the
    # report-widget / getChart 'soiling_ratio' metric (source: measurements)
    # has data — the per-inverter SR lives in analysis_results only.
    for day_key, devs in sr_daily.items():
        vals = list(devs.values())
        if not vals:
            continue
        noon = datetime.fromisoformat(day_key).replace(hour=12, tzinfo=timezone.utc)
        measurements.append(
            {
                "time": noon,
                "device_id": "PLANT",
                "metric": "soiling_ratio",
                "value": round(sum(vals) / len(vals), 4),
                "unit": "ratio",
                "quality": 100,
            }
        )

    # Delivery-invariant check: the PPA breach story needs ~95.3% delivered
    # vs the twin's expectation over the window. Knobs when this drifts:
    # derate depth (0.30), dead/flap day counts, BASE/DIRTY soiling rates.
    if fleet_pred_sum > 0:
        delivery_pct = fleet_actual_sum / fleet_pred_sum * 100.0
        marker = "OK" if 94.8 <= delivery_pct <= 95.8 else "WARN outside [94.8, 95.8]"
        if not problems:
            marker = "informational (no --problems)"
        print(f"[seed] fleet delivery vs twin: {delivery_pct:.2f}% ({marker})")

    problem_ids = {
        "derate": inverters[derate_idx]["external_id"] if derate_idx is not None else None,
        "trip": inverters[trip_idx]["external_id"] if trip_idx is not None else None,
        "dead": inverters[dead_idx]["external_id"] if dead_idx is not None else None,
    }
    return measurements, twin_hourly, twin_daily_dev, sr_daily, dirty_idx, problem_ids


def build_analysis_records(twin_daily_dev, sr_daily, inverters, dirty_idx):
    twin_daily: List[Dict[str, Any]] = []
    soiling: List[Dict[str, Any]] = []

    for day_key, devs in twin_daily_dev.items():
        t = datetime.fromisoformat(day_key).replace(hour=12, tzinfo=timezone.utc)
        for dev, agg in devs.items():
            if agg["n"] == 0:
                continue
            pred, act = agg["pred"] / agg["n"], agg["act"] / agg["n"]
            twin_daily.extend(
                [
                    {"time": t, "device_id": dev, "metric": "power_ac_predicted", "value": round(pred, 3)},
                    {"time": t, "device_id": dev, "metric": "power_ac_actual", "value": round(act, 3)},
                    {"time": t, "device_id": dev, "metric": "power_ac_residual", "value": round(act - pred, 3)},
                ]
            )

    for day_key, devs in sr_daily.items():
        t = datetime.fromisoformat(day_key).replace(hour=12, tzinfo=timezone.utc)
        for dev, sr in devs.items():
            soiling.append({"time": t, "device_id": dev, "metric": "soiling_ratio", "value": round(sr, 5), "confidence": 0.85})

    # Fleet/economics summary (latest day) — the metrics the summary route reads.
    last_day = max(sr_daily.keys())
    now = datetime.fromisoformat(last_day).replace(hour=12, tzinfo=timezone.utc)
    srs = list(sr_daily[last_day].values())
    fleet_mean = sum(srs) / len(srs)
    minor = sum(1 for s in srs if 0.90 <= s < 0.95)
    major = sum(1 for s in srs if 0.85 <= s < 0.90)
    critical = sum(1 for s in srs if s < 0.85)
    normal = len(srs) - minor - major - critical
    summary = [
        {"metric": "fleet_sr_mean", "value": round(fleet_mean, 5)},
        {"metric": "soiling_loss_pct", "value": round((1 - fleet_mean) * 100, 3)},
        {"metric": "fleet_normal_count", "value": normal},
        {"metric": "fleet_minor_issues_count", "value": minor},
        {"metric": "fleet_major_issues_count", "value": major},
        {"metric": "fleet_critical_count", "value": critical},
        {"metric": "ytd_energy_loss_mwh", "value": 4.2},
        {"metric": "cleaning_roi_pct", "value": 240.0},
        {"metric": "cleaning_net_benefit_eur", "value": 1850.0},
        {"metric": "cleaning_payback_days", "value": 12},
        {
            "metric": "next_cleaning_date",
            "value": 0,
            "metadata": {"date": (now + timedelta(days=10)).date().isoformat()},
        },
    ]
    for rec in summary:
        rec.update({"time": now, "confidence": 0.85})
        soiling.append(rec)

    return twin_daily, soiling


def seed_connection_and_snapshots(conn, plant, measurements) -> None:
    """DataConnection + PlantDataSource + LatestDeviceSnapshot (idempotent)."""
    conn_name = f"E2E demo feed ({plant['slug']})"
    with conn.cursor() as cur:
        cur.execute('SELECT id FROM "DataConnection" WHERE name = %s', (conn_name,))
        row = cur.fetchone()
        if row:
            connection_id = row[0]
        else:
            connection_id = str(uuid.uuid4())
            cur.execute(
                'INSERT INTO "DataConnection" (id, customer_id, organization_id, name, type, status, config, enabled, created_at, updated_at) '
                "VALUES (%s, %s, %s, %s, 'csv_upload', 'connected', %s, true, NOW(), NOW())",
                (connection_id, plant["clerk_org_id"] or "e2e", plant["organization_id"], conn_name, json.dumps({"seeded": True})),
            )

        cur.execute(
            'SELECT id FROM "PlantDataSource" WHERE plant_id = %s AND connection_id = %s',
            (plant["id"], connection_id),
        )
        if not cur.fetchone():
            cur.execute(
                'INSERT INTO "PlantDataSource" (id, plant_id, connection_id, name, source_type, purpose, provides_metrics, polling_interval, is_primary, enabled, created_at, updated_at) '
                "VALUES (%s, %s, %s, %s, 'MANUAL_CSV', 'INVERTER_DATA', %s, 900, true, true, NOW(), NOW())",
                (str(uuid.uuid4()), plant["id"], connection_id, "Seeded inverter data", ["power_ac", "irradiance_poa", "temp_module"]),
            )

        # Representative device->metric field mappings so the data-lineage panel
        # shows the raw SCADA/inverter tags mapping onto our canonical metrics.
        field_mappings = [
            ("INV1.P_AC", "power_ac", "kW", 1.00),
            ("INV1.G_POA", "irradiance_poa", "W/m2", 0.95),
            ("INV1.T_MOD", "temp_module", "degC", 0.90),
        ]
        for original, mapped, unit, confidence in field_mappings:
            cur.execute(
                'INSERT INTO "FieldMapping" (id, connection_id, original_field, mapped_field, unit, scaling_factor, "offset", confidence_score, is_confirmed, created_at, updated_at) '
                "VALUES (%s, %s, %s, %s::\"DataFieldType\", %s, 1.0, 0.0, %s, true, NOW(), NOW()) "
                "ON CONFLICT (connection_id, original_field) DO UPDATE SET mapped_field = EXCLUDED.mapped_field, unit = EXCLUDED.unit, confidence_score = EXCLUDED.confidence_score, updated_at = NOW()",
                (str(uuid.uuid4()), connection_id, original, mapped, unit, confidence),
            )

        # Modeled open-data source: irradiance/weather comes from Open-Meteo
        # reanalysis (not the inverter), so lineage shows it honestly as satellite.
        modeled_name = f"Open-Meteo reanalysis ({plant['slug']})"
        cur.execute(
            'SELECT id FROM "PlantDataSource" WHERE plant_id = %s AND name = %s',
            (plant["id"], modeled_name),
        )
        if not cur.fetchone():
            cur.execute(
                'INSERT INTO "PlantDataSource" (id, plant_id, connection_id, name, source_type, purpose, provides_metrics, polling_interval, is_primary, enabled, created_at, updated_at) '
                "VALUES (%s, %s, NULL, %s, 'SATELLITE_IRR', 'WEATHER_DATA', %s, 3600, false, true, NOW(), NOW())",
                (str(uuid.uuid4()), plant["id"], modeled_name, ["irradiance_ghi", "temp_ambient", "wind_speed"]),
            )

        # Latest power reading per device -> snapshot rows.
        latest: Dict[str, Dict[str, Any]] = {}
        for m in measurements:
            if m["metric"] != "power_ac":
                continue
            cur_best = latest.get(m["device_id"])
            if not cur_best or m["time"] > cur_best["time"]:
                latest[m["device_id"]] = m
        for dev, m in latest.items():
            cur.execute(
                'INSERT INTO "LatestDeviceSnapshot" (id, connection_id, plant_ext_id, device_ext_id, device_type, ts, active_power_kw, daily_energy_kwh, extra, updated_at) '
                "VALUES (%s, %s, %s, %s, 'inverter', %s, %s, %s, %s, NOW()) "
                'ON CONFLICT (connection_id, device_ext_id) DO UPDATE SET ts = EXCLUDED.ts, active_power_kw = EXCLUDED.active_power_kw, daily_energy_kwh = EXCLUDED.daily_energy_kwh, updated_at = NOW()',
                (str(uuid.uuid4()), connection_id, plant["slug"], dev, m["time"], m["value"], round(m["value"] * 5.5, 1), json.dumps({"seeded": True})),
            )
    conn.commit()
    print(f"[seed] connection + {len(latest)} device snapshots linked")


def seed_ticket(
    conn,
    plant,
    inverter_external_id: str | None,
    title: str,
    description: str,
    priority: str = "HIGH",
    trigger_type: str = "SOILING_FORECAST",
) -> None:
    with conn.cursor() as cur:
        cur.execute('SELECT id FROM "Ticket" WHERE plant_id = %s AND title = %s', (plant["id"], title))
        if cur.fetchone():
            return
        ticket_id = str(uuid.uuid4())
        cur.execute(
            'INSERT INTO "Ticket" (id, org_clerk_id, plant_id, inverter_id, title, description, status, priority, trigger_type, created_at, updated_at) '
            "VALUES (%s, %s, %s, %s, %s, %s, 'NEW', %s::\"TicketPriority\", %s::\"TicketTriggerType\", NOW(), NOW())",
            (
                ticket_id,
                plant["clerk_org_id"] or "e2e",
                plant["id"],
                inverter_external_id,
                title,
                description,
                priority,
                trigger_type,
            ),
        )
        cur.execute(
            'INSERT INTO "TicketHistory" (id, ticket_id, new_status, new_priority, changed_by_clerk_id, change_reason, changed_at) '
            "VALUES (%s, %s, 'NEW', %s::\"TicketPriority\", 'system', 'Ticket created (seeded)', NOW())",
            (str(uuid.uuid4()), ticket_id, priority),
        )
    conn.commit()
    print(f"[seed] ticket created: {title}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed demo telemetry for a plant from Open-Meteo weather")
    parser.add_argument("--plant-id", required=True)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--operational", action="store_true", help="flip plant status to OPERATIONAL after seeding")
    parser.add_argument(
        "--problems",
        action="store_true",
        help="seed visibly unhealthy inverters (derating, midday trips, one offline) plus matching tickets — used by the shared demo plant",
    )
    parser.add_argument(
        "--allow-clearsky",
        action="store_true",
        help="proceed even when Open-Meteo is unreachable and the weather falls back to a flawless clear-sky model (demo reads fake)",
    )
    args = parser.parse_args()

    conn = _connect()
    ensure_local_daily_views(conn)
    plant = load_plant(conn, args.plant_id)
    asset_type = str(plant.get("asset_type") or "PV")
    print(f"[seed] plant={plant['slug']} type={asset_type} inverters={len(plant['inverters'])} days={args.days}")

    # Battery synthesis for BESS / HYBRID plants (asset, dispatch, cycling, SoH).
    if asset_type in ("BESS", "HYBRID"):
        from nuravolt.pipeline.bess_intelligence import synthesize_bess_history

        bess = synthesize_bess_history(conn, plant, days=args.days)
        print(f"[seed] bess: asset={bess['asset_id']} soh={bess['soh']} cycles={bess['cumulative_cycles']} prices={bess['price_source']}")

    if not plant["inverters"]:
        # BESS/inverterless plants: one scheduled-maintenance ticket so the
        # ticket board tells a story on storage plants too.
        if asset_type in ("BESS", "HYBRID"):
            seed_ticket(
                conn,
                plant,
                None,
                "Quarterly capacity test due on Unit 2",
                "Scheduled maintenance: the quarterly standard capacity verification for Unit 2 is due. Book a discharge window with the trading desk and record the metered result against the warranty tracker.",
                priority="MEDIUM",
                trigger_type="SCHEDULED_MAINTENANCE",
            )
        if args.operational:
            with conn.cursor() as cur:
                cur.execute('UPDATE "Plant" SET status = \'OPERATIONAL\'::"PlantStatus", updated_at = NOW() WHERE id = %s', (plant["id"],))
            conn.commit()
            print("[seed] plant status -> OPERATIONAL")
        conn.close()
        return 0

    measurements, twin_hourly, twin_daily_dev, sr_daily, dirty_idx, problem_ids = synthesize(
        plant, args.days, problems=args.problems, allow_clearsky=args.allow_clearsky
    )
    twin_daily, soiling = build_analysis_records(twin_daily_dev, sr_daily, plant["inverters"], dirty_idx)

    run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"e2e-seed:{plant['id']}"))
    # The twin shares the pipeline's deterministic run_id so that a later
    # onboard_plant / twin.py run (physics-v1) UPSERTS over these seed rows
    # instead of coexisting under a second run_id — the analysis_results unique
    # index keys on run_id, so mismatched ids double the rows and inflate the
    # daily energy aggregate. Seed-only demos still get a usable twin.
    twin_run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"physics:{plant['id']}"))

    # Idempotency: measurements upsert on (time, ...), so a re-seed after a
    # clock-convention change would leave the OLD wrong-clock rows coexisting
    # with the new ones — and the twin's clock-offset detector would then
    # faithfully re-align the prediction to the contaminated mixture. Clear
    # the seed window first (same guard generate_twin applies to its rows).
    seed_start = min(m["time"] for m in measurements) if measurements else None
    if seed_start is not None:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM measurements WHERE plant_id = %s AND time >= %s",
                (plant["id"], seed_start),
            )
        conn.commit()

    writer = TimeseriesWriter()
    n_meas = writer.write_measurements(plant_id=plant["id"], records=measurements)
    n_twin = writer.write_analysis_results(plant_id=plant["id"], domain="digitaltwin", records=twin_hourly + twin_daily, model_version="e2e-seed", run_id=twin_run_id)
    n_soil = writer.write_analysis_results(plant_id=plant["id"], domain="soiling", records=soiling, model_version="e2e-seed", run_id=run_id)
    print(f"[seed] wrote measurements={n_meas} twin={n_twin} soiling={n_soil}")

    seed_connection_and_snapshots(conn, plant, measurements)
    dirty_id = plant["inverters"][dirty_idx]["external_id"]
    seed_ticket(
        conn,
        plant,
        dirty_id,
        f"Soiling above threshold on {dirty_id}",
        "Seeded during E2E: this inverter is fouling roughly 2.5x faster than the rest of the fleet. Recommend inspection and spot cleaning.",
    )
    if problem_ids.get("dead"):
        seed_ticket(
            conn,
            plant,
            problem_ids["dead"],
            f"Inverter offline: {problem_ids['dead']}",
            "No AC output for 3 consecutive days while neighbouring inverters produce normally. Suspected DC-side isolation fault or tripped breaker; requires a site visit.",
            priority="CRITICAL",
            trigger_type="PERFORMANCE_ANOMALY",
        )
    if problem_ids.get("trip"):
        seed_ticket(
            conn,
            plant,
            problem_ids["trip"],
            f"Intermittent midday trips on {problem_ids['trip']}",
            "Drops to zero output for about three hours around midday on roughly one day in three. Pattern is consistent with overtemperature shutdown or grid-voltage ride-through trips at peak irradiance.",
            priority="MEDIUM",
            trigger_type="PERFORMANCE_ANOMALY",
        )
    if problem_ids.get("derate"):
        seed_ticket(
            conn,
            plant,
            problem_ids["derate"],
            f"Progressive derating on {problem_ids['derate']}",
            "Output has drifted about 30 percent below its digital-twin expectation over two weeks with no matching soiling signal. Consistent with fan failure or a failing DC string; check cooling and string currents.",
            priority="HIGH",
            trigger_type="PERFORMANCE_ANOMALY",
        )

    if args.operational:
        with conn.cursor() as cur:
            cur.execute('UPDATE "Plant" SET status = \'OPERATIONAL\'::"PlantStatus", updated_at = NOW() WHERE id = %s', (plant["id"],))
        conn.commit()
        print("[seed] plant status -> OPERATIONAL")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
