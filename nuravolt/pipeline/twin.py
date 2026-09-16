"""Physics digital-twin generation for the import/onboarding pipeline.

Zero-training PVWatts twin (nuravolt.digitaltwin.physics_model) driven by
Open-Meteo weather for the plant's own coordinates:

  predicted  = physics model (POA -> cell temp -> DC -> AC), absolute kW
  actual     = the plant's own `measurements` rows (metric power_ac), when any
  residual   = actual - predicted

Rows land in analysis_results (domain='digitaltwin') exactly as the dashboard
twin routes read them:
  device_id='PLANT'          hourly sums   (summary route)
  device_id=<external_id>    daily means   (timeseries / inverter-metrics)

model_version='physics-v1'; deterministic run_id => idempotent re-runs.

Calibration ladder: once >=14 distinct days of measured power exist, a single
scalar calibration factor is fitted (PVWattsPhysicsModel.calibrate) and
applied; callers treat calibrated=True as the TRAINING -> OPERATIONAL signal.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import pandas as pd
import psycopg2.extras

from nuravolt.db.writer import TimeseriesWriter
from nuravolt.digitaltwin.physics_model import (
    CalibrationScaleError,
    create_physics_model,
)
from nuravolt.weather.fallback import detect_time_shift, get_fallback_weather

log = logging.getLogger(__name__)

MODEL_VERSION = "physics-v1"
CALIBRATION_MIN_DAYS = 14


def _weather_index_to_utc(index, tz_name: str) -> pd.DatetimeIndex:
    """Label a naive weather index in the zone it was BUILT in, then convert
    to UTC.

    get_fallback_weather returns a naive index on the clock of
    ``fw.provenance['timezone']`` (Open-Meteo's auto-resolved local zone
    online; a longitude Etc/GMT zone on the clearsky path). Localizing with
    any OTHER zone — e.g. Plant.timezone, whose Prisma default is 'UTC' even
    for Spanish plants — relabels the physics prediction onto the wrong clock
    and shifts its peak 1-2 h (DST-varying) against the measured curve.
    """
    idx = pd.to_datetime(index)
    if idx.tz is not None:
        return idx.tz_convert("UTC")
    try:
        return idx.tz_localize(
            tz_name or "UTC", ambiguous="NaT", nonexistent="shift_forward"
        ).tz_convert("UTC")
    except Exception:  # noqa: BLE001 - unknown tz string -> treat as UTC
        return idx.tz_localize("UTC")


def load_plant_geometry(conn, plant_id: str) -> Dict[str, Any]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT p.id, p.slug, p.latitude, p.longitude, p.capacity_mw, p.timezone '
            'FROM "Plant" p WHERE p.id = %s',
            (plant_id,),
        )
        plant = cur.fetchone()
        if not plant:
            raise ValueError(f"Plant not found: {plant_id}")
        cur.execute(
            'SELECT g.tilt, g.azimuth, g.inverter_nominal_power_kw, g.gamma_pdc, '
            '       i.external_id '
            'FROM "InverterGroup" g JOIN "Inverter" i ON i.group_id = g.id '
            'WHERE g.plant_id = %s ORDER BY i.external_id',
            (plant_id,),
        )
        inverters = [dict(r) for r in cur.fetchall()]
    return {**dict(plant), "inverters": inverters}


def _load_actuals(conn, plant_id: str, start: datetime) -> pd.DataFrame:
    """Hourly-floored measured power per device: columns time, device_id, value."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT date_trunc('hour', time) AS time, device_id, AVG(value) AS value "
            "FROM measurements WHERE plant_id = %s AND metric = 'power_ac' AND time >= %s "
            "GROUP BY 1, 2",
            (plant_id, start),
        )
        rows = cur.fetchall()
    if not rows:
        return pd.DataFrame(columns=["time", "device_id", "value"])
    df = pd.DataFrame(rows, columns=["time", "device_id", "value"])
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df["value"] = df["value"].astype(float)
    return df


def generate_twin(conn, plant_id: str, days: int = 30) -> Dict[str, Any]:
    """Generate + persist physics-twin rows for one plant. Returns a summary.

    WARNING: keep `days` <= the ML-backfill seam gap (30 today). A plant that
    carries scripts/backfill_ml_twin_history.py history holds ML rows under a
    different run_id up to `seam = first-physics-day`. Reads never filter by
    run_id, so if physics ever writes into that historical range (days>30) the
    summary route would sum both series -> duplicate timestamps, 2x MWh on the
    overlap. onboard_plant.py hardcodes days=30; do not raise it blindly.
    """
    plant = load_plant_geometry(conn, plant_id)
    inverters = plant["inverters"]
    if not inverters:
        return {"rows_written": 0, "calibrated": False, "note": "no inverters"}

    lat, lon = float(plant["latitude"]), float(plant["longitude"])
    end = datetime.now(timezone.utc).date()
    start_date = end - timedelta(days=days)
    start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)

    # One weather series per distinct geometry (groups usually share tilt/azimuth).
    tilt = float(inverters[0]["tilt"] or 25.0)
    azimuth = float(inverters[0]["azimuth"] or 180.0)
    fw = get_fallback_weather(
        lat, lon, start_date.isoformat(), end.isoformat(), freq="1h", tilt=tilt, azimuth=azimuth
    )
    wx = fw.data.dropna(subset=["poa"]).copy()
    if wx.empty:
        return {"rows_written": 0, "calibrated": False, "note": "no weather"}
    # Convert the naive weather index to UTC using the zone the weather was
    # actually built in (fw.provenance['timezone']) — NOT Plant.timezone,
    # which defaults to 'UTC' and used to shift the predicted peak 1-2 h.
    weather_tz = str(fw.provenance.get("timezone") or plant.get("timezone") or "UTC")
    wx_utc_index = _weather_index_to_utc(wx.index, weather_tz)

    actuals = _load_actuals(conn, plant_id, start_dt)
    actual_by_dev: Dict[str, pd.Series] = {
        dev: g.set_index("time")["value"] for dev, g in actuals.groupby("device_id")
    }
    actual_days = int(actuals["time"].dt.date.nunique()) if not actuals.empty else 0

    # SCADA loggers commonly run fixed standard time while modeled weather is
    # DST local. Detect the residual clock offset against the fleet-mean
    # measured power and shift the weather labels onto the logger clock —
    # the same alignment the trained-twin factory applies (factory.py).
    time_shift_minutes = 0
    if not actuals.empty:
        fleet_mean = actuals.groupby("time")["value"].mean().sort_index()
        try:
            wx_utc_df = wx.copy()
            wx_utc_df.index = wx_utc_index
            shift, _best_r, _r0 = detect_time_shift(
                wx_utc_df, fleet_mean.index, fleet_mean, "poa", pd.Timedelta("1h")
            )
            if shift != pd.Timedelta(0):
                wx_utc_index = wx_utc_index + shift
                time_shift_minutes = int(shift.total_seconds() // 60)
        except Exception:  # noqa: BLE001 - detection is best-effort
            pass

    # Write the resolved zone back to the Plant when it still carries the
    # 'UTC' default and Open-Meteo resolved a real region zone from lat/lon —
    # future UI (plant-local axes) and pipelines then have a truthful tz.
    resolved_tz = str(fw.provenance.get("timezone") or "")
    if (
        resolved_tz
        and "/" in resolved_tz
        and not resolved_tz.startswith("Etc/")
        and (plant.get("timezone") or "UTC") == "UTC"
    ):
        try:
            with conn.cursor() as cur:
                cur.execute('UPDATE "Plant" SET timezone = %s WHERE id = %s', (resolved_tz, plant_id))
            conn.commit()
        except Exception:  # noqa: BLE001 - metadata write-back is best-effort
            conn.rollback()

    # Predict per inverter.
    per_dev_pred: Dict[str, pd.Series] = {}
    calibration: Dict[str, float] = {}
    for inv in inverters:
        rating = float(inv["inverter_nominal_power_kw"] or 200.0)
        gamma = float(inv["gamma_pdc"]) if inv["gamma_pdc"] is not None else -0.004
        model = create_physics_model(
            capacity_kw=rating, latitude=lat, longitude=lon,
            tilt=float(inv["tilt"] or tilt), azimuth=float(inv["azimuth"] or azimuth),
            gamma_pdc=gamma,
        )
        dev = inv["external_id"]

        # Calibrate on measured power once enough days accrued.
        if actual_days >= CALIBRATION_MIN_DAYS and dev in actual_by_dev:
            cal_df = wx.copy()
            cal_df.index = wx_utc_index
            joined = cal_df.join(actual_by_dev[dev].rename("power_ac"), how="inner")
            joined = joined[joined["poa"] > 50]
            if len(joined) >= 24:
                try:
                    factor = model.calibrate(
                        joined, power_col="power_ac",
                        irradiance_col="poa", temperature_col="temp_air",
                    )
                    calibration[dev] = round(float(factor), 4)
                except CalibrationScaleError as exc:
                    # Unit mismatch, not a data problem -- leave this device
                    # uncalibrated rather than recording a fake 1.0.
                    log.warning("twin: skipping calibration for %s: %s", dev, exc)
                except Exception:  # noqa: BLE001
                    pass

        pred = model.predict(wx, irradiance_col="poa", temperature_col="temp_air", wind_col="wind_speed")
        per_dev_pred[dev] = pd.Series(pred, index=wx_utc_index)

    # Assemble rows.
    hourly_records: List[Dict[str, Any]] = []
    daily_acc: Dict[str, Dict[str, Dict[str, List[float]]]] = {}

    n_inverters = len(per_dev_pred)
    for ts in wx_utc_index:
        t = ts.to_pydatetime()
        plant_pred = 0.0
        plant_actual = 0.0
        n_reporting = 0
        for dev, pred_series in per_dev_pred.items():
            pred = float(pred_series.loc[ts])
            plant_pred += pred
            actual = None
            series = actual_by_dev.get(dev)
            if series is not None and ts in series.index:
                actual = float(series.loc[ts])
                plant_actual += actual
                n_reporting += 1

            day_key = t.date().isoformat()
            acc = daily_acc.setdefault(day_key, {}).setdefault(dev, {"pred": [], "act": [], "pred_matched": []})
            if pred > 1:  # daylight-ish
                acc["pred"].append(pred)
                if actual is not None:
                    acc["act"].append(actual)
                    acc["pred_matched"].append(pred)  # match the actual's hour support

        if plant_pred > 1:
            hourly_records.append({"time": t, "device_id": "PLANT", "metric": "power_ac_predicted", "value": round(plant_pred, 3)})
            # Only emit PLANT actual/residual when the WHOLE fleet reported this
            # hour. A partial-fleet actual (some inverters lagging/gapped) vs the
            # full-fleet prediction would fabricate a large phantom loss, so a
            # partially-reported hour is left predicted-only (chart gaps).
            if n_reporting == n_inverters and n_reporting > 0:
                hourly_records.append({"time": t, "device_id": "PLANT", "metric": "power_ac_actual", "value": round(plant_actual, 3)})
                hourly_records.append({"time": t, "device_id": "PLANT", "metric": "power_ac_residual", "value": round(plant_actual - plant_pred, 3)})

    daily_records: List[Dict[str, Any]] = []
    for day_key, devs in daily_acc.items():
        t = datetime.fromisoformat(day_key).replace(hour=12, tzinfo=timezone.utc)
        for dev, acc in devs.items():
            if not acc["pred"]:
                continue
            pred = sum(acc["pred"]) / len(acc["pred"])
            daily_records.append({"time": t, "device_id": dev, "metric": "power_ac_predicted", "value": round(pred, 3)})
            if acc["act"]:
                act = sum(acc["act"]) / len(acc["act"])
                # Compare the actual mean to the predicted mean over the SAME
                # hours it covers, so partial intra-day coverage doesn't read as
                # a false loss.
                pred_matched = sum(acc["pred_matched"]) / len(acc["pred_matched"])
                daily_records.append({"time": t, "device_id": dev, "metric": "power_ac_actual", "value": round(act, 3)})
                daily_records.append({"time": t, "device_id": dev, "metric": "power_ac_residual", "value": round(act - pred_matched, 3)})

    # Idempotency guard: the analysis_results upsert keys on `time`, so a
    # tz-corrected re-run would land on NEW timestamps and leave the old
    # misaligned rows as ghost curves. Clear this run's physics window first
    # (never touches the ML history — different model_version, older dates).
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM analysis_results WHERE plant_id = %s AND domain = 'digitaltwin' "
            "AND model_version = %s AND time >= %s",
            (plant_id, MODEL_VERSION, start_dt),
        )
    conn.commit()  # writer uses its own connection — the delete must land first

    writer = TimeseriesWriter()
    run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"physics:{plant_id}"))
    written = writer.write_analysis_results(
        plant_id=plant_id,
        domain="digitaltwin",
        records=hourly_records + daily_records,
        model_version=MODEL_VERSION,
        run_id=run_id,
    )

    _refresh_daily_aggregate(conn)

    return {
        "rows_written": written,
        "weather_source": fw.source,
        "weather_timezone": weather_tz,
        "time_shift_minutes": time_shift_minutes,
        "actual_days": actual_days,
        "calibrated": bool(calibration),
        "calibration": calibration or None,
    }


def _refresh_daily_aggregate(conn) -> None:
    """Timescale environments: refresh analysis_daily so routes see new rows."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'")
            has_ts = cur.fetchone()
        if not has_ts:
            return
        # refresh_continuous_aggregate must run outside a transaction, but the
        # geometry/actuals reads above (and the extension check) left one open
        # on this connection — end it before flipping autocommit, else psycopg2
        # raises "set_session cannot be used inside a transaction".
        conn.rollback()
        old_autocommit = conn.autocommit
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute("CALL refresh_continuous_aggregate('analysis_daily', NULL, NULL)")
        finally:
            conn.autocommit = old_autocommit
    except Exception:  # noqa: BLE001
        pass  # aggregate refresh is best-effort; the scheduled policy catches up
