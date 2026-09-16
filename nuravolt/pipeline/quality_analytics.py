"""Live data-quality analytics artifacts for the DQ hub.

The hub's Spatial / Irradiance / Correlation tabs were fixture-only: real
(dashboard) plants rendered honest empty states because nothing computed the
analytics at runtime. This module generates all three from the plant's own
``measurements`` rows into ``AnalysisArtifact`` (source ``computed``), where
the section routes read them DB-first:

  - ``quality_irradiance``: on-site sensor vs Open-Meteo reference.
  - ``quality_spatial``: daily coefficient of variation of zone-relative
    performance across inverter zones (sequential inverters bucketed into
    at most 5 zones — inverter numbering follows the physical layout).
  - ``quality_correlation``: per-zone correlation of daily energy against
    on-site vs Open-Meteo insolation, split by uniform / non-uniform days.

Honesty notes:
  - On-site POA sensors are compared against Open-Meteo **GTI** (tilted
    irradiance at the plant's tilt), not GHI — comparing POA to GHI would
    manufacture a structural "bias" that says nothing about the sensor.
  - Zone "PR" values are **relative** performance (zone per-inverter energy
    over the plant mean, ~1.0) — plants don't carry per-zone nameplate in
    measurements, and spatial uniformity is about dispersion, not absolute
    PR.
  - Every generator returns ``{"skipped": reason}`` and writes nothing when
    its inputs are missing/too short — the routes then serve their empty
    states instead of a fabricated analysis.

Called from onboard_plant / nightly as non-fatal steps.
"""

from __future__ import annotations

import sys
from typing import Any, Dict, Optional

import numpy as np
import polars as pl
import requests

from nuravolt.db.writer import write_artifact
from nuravolt.soiling.data_quality.irradiance_quality import (
    calculate_quality_metrics,
    generate_hourly_metrics,
    generate_irradiance_alerts,
    generate_monthly_metrics,
)

OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# The archive lags realtime by ~5 days.
ARCHIVE_LAG_DAYS = 6
LOOKBACK_DAYS = 180
MIN_OVERLAP_HOURS = 24 * 14  # two weeks of joined daylight-capable hours

# Measurement metrics that qualify as an irradiance stream, with the matching
# Open-Meteo reference variable.
POA_METRICS = ("irradiance_poa", "poa", "poa_irradiance")
GHI_METRICS = ("irradiance_ghi", "ghi", "ghi_irradiance", "irradiance")


def _fetch_reference(
    latitude: float,
    longitude: float,
    start_date: str,
    end_date: str,
    *,
    tilted: bool,
    tilt_deg: float,
) -> Optional[pl.DataFrame]:
    """Hourly UTC reference irradiance from the Open-Meteo archive."""
    variable = "global_tilted_irradiance" if tilted else "shortwave_radiation"
    params: Dict[str, Any] = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start_date,
        "end_date": end_date,
        "hourly": variable,
        "timezone": "UTC",
    }
    if tilted:
        params["tilt"] = tilt_deg
    try:
        resp = requests.get(OPEN_METEO_ARCHIVE_URL, params=params, timeout=60)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:  # pragma: no cover - network
        print(f"[quality] Open-Meteo archive fetch failed: {exc}", file=sys.stderr)
        return None
    hourly = data.get("hourly") or {}
    times = hourly.get("time")
    values = hourly.get(variable)
    if not times or not values:
        return None
    df = pl.DataFrame({"timestamp": times, "irradiance_openmeteo": values})
    return (
        df.with_columns(pl.col("timestamp").str.to_datetime("%Y-%m-%dT%H:%M"))
        .filter(pl.col("irradiance_openmeteo").is_not_null())
    )


def _load_onsite(conn, plant_uuid: str) -> Optional[Dict[str, Any]]:
    """Hourly plant-mean irradiance from measurements (UTC). Prefers POA."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT metric, COUNT(*) AS n
            FROM measurements
            WHERE plant_id::text = %s
              AND metric = ANY(%s)
              AND time >= NOW() - make_interval(days => %s)
            GROUP BY metric
            ORDER BY n DESC
            """,
            (plant_uuid, list(POA_METRICS + GHI_METRICS), LOOKBACK_DAYS),
        )
        rows = cur.fetchall()
    if not rows:
        return None
    metrics_present = [r[0] for r in rows]
    poa_choice = next((m for m in metrics_present if m in POA_METRICS), None)
    metric = poa_choice or metrics_present[0]

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT date_trunc('hour', time AT TIME ZONE 'UTC') AS ts,
                   AVG(value) AS v
            FROM measurements
            WHERE plant_id::text = %s AND metric = %s
              AND time >= NOW() - make_interval(days => %s)
            GROUP BY 1
            ORDER BY 1
            """,
            (plant_uuid, metric, LOOKBACK_DAYS),
        )
        data = cur.fetchall()
    if not data:
        return None
    df = pl.DataFrame(
        {
            "timestamp": [r[0] for r in data],
            "irradiance_onsite": [float(r[1]) for r in data],
        }
    )
    return {"df": df, "metric": metric, "is_poa": metric in POA_METRICS}


def generate_quality_irradiance(conn, plant_uuid: str) -> Dict[str, Any]:
    """Compute the on-site vs Open-Meteo irradiance comparison and persist it
    as an AnalysisArtifact. Returns a small summary dict (or skip reason)."""
    with conn.cursor() as cur:
        cur.execute(
            'SELECT slug, name, latitude, longitude, metadata FROM "Plant" WHERE id::text = %s',
            (plant_uuid,),
        )
        row = cur.fetchone()
    if not row:
        return {"skipped": "plant not found"}
    slug, name, lat, lon, metadata = row
    if lat is None or lon is None:
        return {"skipped": "plant has no coordinates"}

    onsite = _load_onsite(conn, plant_uuid)
    if not onsite:
        return {"skipped": "no irradiance measurements"}
    df_onsite: pl.DataFrame = onsite["df"]

    ts_min = df_onsite["timestamp"].min()
    ts_max = df_onsite["timestamp"].max()
    if ts_min is None or ts_max is None:
        return {"skipped": "no irradiance measurements"}

    import datetime as _dt

    archive_end = _dt.date.today() - _dt.timedelta(days=ARCHIVE_LAG_DAYS)
    start_date = ts_min.date()
    end_date = min(ts_max.date(), archive_end)
    if (end_date - start_date).days < 14:
        return {"skipped": "under two weeks of archive-overlapping data"}

    tilt = 30.0
    if isinstance(metadata, dict):
        raw_tilt = metadata.get("tilt_deg")
        if isinstance(raw_tilt, (int, float)) and 0 <= raw_tilt <= 90:
            tilt = float(raw_tilt)

    df_ref = _fetch_reference(
        float(lat),
        float(lon),
        start_date.isoformat(),
        end_date.isoformat(),
        tilted=onsite["is_poa"],
        tilt_deg=tilt,
    )
    if df_ref is None or df_ref.is_empty():
        return {"skipped": "Open-Meteo archive unavailable"}

    df = df_onsite.join(df_ref, on="timestamp", how="inner").filter(
        (pl.col("irradiance_onsite") > 10) & (pl.col("irradiance_openmeteo") > 10)
    )
    if len(df) < MIN_OVERLAP_HOURS // 4:
        return {"skipped": f"only {len(df)} joined daylight hours"}

    overall = calculate_quality_metrics(
        df["irradiance_onsite"].to_numpy(), df["irradiance_openmeteo"].to_numpy()
    )
    monthly = generate_monthly_metrics(df)
    hourly = generate_hourly_metrics(df)
    alerts = generate_irradiance_alerts(overall, monthly, hourly)

    # Scatter sample (bounded payload): evenly spaced up to 500 points.
    step = max(1, len(df) // 500)
    scatter = [
        {
            "onSite_Wm2": round(r["irradiance_onsite"], 1),
            "openMeteo_Wm2": round(r["irradiance_openmeteo"], 1),
        }
        for r in df.gather_every(step).iter_rows(named=True)
    ]

    reference_label = (
        f"Open-Meteo GTI ({tilt:.0f}° tilt)" if onsite["is_poa"] else "Open-Meteo GHI (ERA5)"
    )
    payload = {
        "metadata": {
            "plantId": slug,
            "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
            "location": {"latitude": float(lat), "longitude": float(lon)},
            "onSiteSensorType": "POA pyranometer" if onsite["is_poa"] else "GHI pyranometer",
            "openMeteoSource": reference_label,
        },
        "overallMetrics": overall,
        "monthlyMetrics": monthly,
        "hourlyMetrics": hourly,
        "alerts": alerts,
        "scatterData": scatter,
    }

    write_artifact(
        plant_uuid,
        "quality_irradiance",
        payload,
        source="computed",
        model_version="irradiance-compare-v1",
        conn=conn,
    )
    return {
        "plant": name,
        "metric": onsite["metric"],
        "reference": reference_label,
        "samples": overall["sampleCount"],
        "correlation": overall["correlation"],
        "alerts": len(alerts),
    }


# ---------------------------------------------------------------------------
# Spatial uniformity + data-source correlation
# ---------------------------------------------------------------------------

CV_THRESHOLD = 0.10
MAX_ZONES = 5
MIN_SPATIAL_DAYS = 10
MIN_CORR_SAMPLES = 10
ZONE_LABELS = ["Zone A", "Zone B", "Zone C", "Zone D", "Zone E"]


def _load_zone_daily_energy(conn, plant_uuid: str) -> Optional[pl.DataFrame]:
    """Daily energy per inverter zone. Inverters (device_ids with power_ac)
    are bucketed sequentially into at most MAX_ZONES zones; a day only counts
    when every zone reported (partial days would fake non-uniformity)."""
    with conn.cursor() as cur:
        # Convert to naive UTC FIRST, then truncate: date_trunc on a
        # timestamptz buckets in the SESSION timezone, which shifted every
        # day label by one vs the UTC-dayed irradiance frame (and paired
        # each day's energy with the previous day's insolation).
        cur.execute(
            """
            SELECT date_trunc('day', time AT TIME ZONE 'UTC')::date AS d,
                   device_id,
                   SUM(value) AS energy,
                   COUNT(*) AS n
            FROM measurements
            WHERE plant_id::text = %s AND metric = 'power_ac'
              AND time >= NOW() - make_interval(days => %s)
            GROUP BY 1, 2
            ORDER BY 1, 2
            """,
            (plant_uuid, LOOKBACK_DAYS),
        )
        rows = cur.fetchall()
    if not rows:
        return None
    devices = sorted({r[1] for r in rows})
    if len(devices) < 2:
        return None

    # Sequential bucketing into ≤ MAX_ZONES zones.
    n_zones = min(MAX_ZONES, len(devices))
    per_zone = -(-len(devices) // n_zones)  # ceil
    zone_of = {
        dev: ZONE_LABELS[min(i // per_zone, n_zones - 1)]
        for i, dev in enumerate(devices)
    }

    df = pl.DataFrame(
        {
            "date": [r[0] for r in rows],
            "zone": [zone_of[r[1]] for r in rows],
            "energy": [float(r[2]) for r in rows],
            "n_devices": [1 for _ in rows],
        }
    )
    zones = sorted(set(zone_of.values()))
    daily = (
        df.group_by(["date", "zone"])
        .agg(pl.col("energy").sum(), pl.col("n_devices").sum())
        # Per-inverter energy so unequal zone sizes don't fake divergence.
        .with_columns((pl.col("energy") / pl.col("n_devices")).alias("energy_per_inv"))
    )
    complete = (
        daily.group_by("date")
        .agg(pl.col("zone").n_unique().alias("nz"))
        .filter(pl.col("nz") == len(zones))
        .select("date")
    )
    daily = daily.join(complete, on="date", how="inner")
    if daily.select(pl.col("date").n_unique()).item() < MIN_SPATIAL_DAYS:
        return None
    return daily.sort(["date", "zone"])


def _spatial_frame(daily: pl.DataFrame) -> pl.DataFrame:
    """Wide per-day frame of zone-relative performance + CV columns."""
    wide = daily.pivot(values="energy_per_inv", index="date", on="zone").sort("date")
    zones = [c for c in wide.columns if c != "date"]
    # Relative performance: each zone's per-inverter energy over the plant
    # mean that day (~1.0 when uniform).
    mean_expr = pl.mean_horizontal([pl.col(z) for z in zones])
    rel = wide.with_columns(
        [(pl.col(z) / mean_expr).alias(z) for z in zones]
    )
    rel_cols = [pl.col(z) for z in zones]
    rel = rel.with_columns(
        [
            pl.mean_horizontal(rel_cols).alias("_mean"),
            pl.concat_list(rel_cols).list.std().alias("_std"),
            pl.concat_list(rel_cols).list.max().alias("_max"),
            pl.concat_list(rel_cols).list.min().alias("_min"),
        ]
    ).with_columns(
        (pl.col("_std") / pl.col("_mean")).alias("cv"),
        (pl.col("_max") - pl.col("_min")).alias("spread"),
    )
    return rel.drop_nulls(subset=["cv"])


def generate_quality_spatial(conn, plant_uuid: str) -> Dict[str, Any]:
    """Daily zone-level CV of relative performance → quality_spatial artifact."""
    with conn.cursor() as cur:
        cur.execute('SELECT slug, name FROM "Plant" WHERE id::text = %s', (plant_uuid,))
        row = cur.fetchone()
    if not row:
        return {"skipped": "plant not found"}
    slug, name = row

    daily = _load_zone_daily_energy(conn, plant_uuid)
    if daily is None:
        return {"skipped": "needs ≥2 inverter power streams and ≥10 complete days"}
    rel = _spatial_frame(daily)
    zones = [c for c in rel.columns if not c.startswith("_") and c not in ("date", "cv", "spread")]
    if rel.height < MIN_SPATIAL_DAYS:
        return {"skipped": "under 10 complete days"}

    import datetime as _dt

    time_series = []
    lowest_counts: Dict[str, int] = {z: 0 for z in zones}
    highest_counts: Dict[str, int] = {z: 0 for z in zones}
    for r in rel.iter_rows(named=True):
        zone_prs = {z: round(float(r[z]), 4) for z in zones}
        hi = max(zone_prs, key=zone_prs.get)
        lo = min(zone_prs, key=zone_prs.get)
        highest_counts[hi] += 1
        lowest_counts[lo] += 1
        time_series.append(
            {
                "timestamp": r["date"].isoformat(),
                "coefficientOfVariation": round(float(r["cv"]), 4),
                "isUniform": bool(r["cv"] < CV_THRESHOLD),
                "zonePRs": zone_prs,
                "highestZone": hi,
                "lowestZone": lo,
                "spread": round(float(r["spread"]), 4),
            }
        )

    n_days = len(time_series)
    uniform = sum(1 for t in time_series if t["isUniform"])
    cvs = [t["coefficientOfVariation"] for t in time_series]

    zone_stats = {}
    for z in zones:
        vals = rel[z].to_numpy()
        zone_stats[z] = {
            "avgPR": round(float(np.mean(vals)), 4),
            "stdPR": round(float(np.std(vals)), 4),
            "minPR": round(float(np.min(vals)), 4),
            "maxPR": round(float(np.max(vals)), 4),
            "highPerformancePct": round(highest_counts[z] / n_days * 100, 1),
            "lowPerformancePct": round(lowest_counts[z] / n_days * 100, 1),
        }

    # Alerts: runs of ≥2 consecutive non-uniform days. Attribution stays
    # conservative — 'localized_soiling' only when one zone is the laggard
    # on ≥80% of the run's days, else 'partial_cloud' (broad, transient).
    alerts = []
    run: list = []
    def _close_run(run_entries):
        if len(run_entries) < 2:
            return
        run_cvs = [e["coefficientOfVariation"] for e in run_entries]
        lows = [e["lowestZone"] for e in run_entries]
        dominant = max(set(lows), key=lows.count)
        dominant_share = lows.count(dominant) / len(lows)
        cause = "localized_soiling" if dominant_share >= 0.8 else "partial_cloud"
        max_cv = max(run_cvs)
        alerts.append(
            {
                "id": f"nonuniform_{run_entries[0]['timestamp']}",
                "startTime": run_entries[0]["timestamp"],
                "endTime": run_entries[-1]["timestamp"],
                "durationMinutes": len(run_entries) * 1440,
                "avgCV": round(sum(run_cvs) / len(run_cvs), 4),
                "maxCV": round(max_cv, 4),
                "affectedZones": [dominant] if cause == "localized_soiling" else zones,
                "likelyCause": cause,
                "severity": "high" if max_cv > 0.2 else "medium" if max_cv > 0.15 else "low",
                "description": (
                    f"{len(run_entries)} consecutive non-uniform days "
                    f"(max CV {max_cv * 100:.1f}%)"
                    + (f", {dominant} consistently lowest" if cause == "localized_soiling" else "")
                ),
            }
        )

    for t in time_series:
        if not t["isUniform"]:
            run.append(t)
        else:
            _close_run(run)
            run = []
    _close_run(run)

    payload = {
        "metadata": {
            "plantId": slug,
            "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "period": {"start": time_series[0]["timestamp"], "end": time_series[-1]["timestamp"]},
            "zones": zones,
            "cvThreshold": CV_THRESHOLD,
            "measurementInterval": "daily",
        },
        "summary": {
            "totalMeasurements": n_days,
            "uniformMeasurements": uniform,
            "nonUniformMeasurements": n_days - uniform,
            "uniformityRate": round(uniform / n_days * 100, 2),
            "avgCV": round(float(np.mean(cvs)), 4),
            "maxCV": round(float(np.max(cvs)), 4),
            "alertCount": len(alerts),
        },
        "zoneStatistics": zone_stats,
        "timeSeries": time_series,
        "alerts": alerts,
    }
    write_artifact(
        plant_uuid,
        "quality_spatial",
        payload,
        source="computed",
        model_version="spatial-cv-v1",
        conn=conn,
    )
    return {
        "plant": name,
        "zones": len(zones),
        "days": n_days,
        "uniformity_pct": payload["summary"]["uniformityRate"],
        "alerts": len(alerts),
    }


def _pearson(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    if len(a) < MIN_CORR_SAMPLES or np.std(a) == 0 or np.std(b) == 0:
        return None
    r = float(np.corrcoef(a, b)[0, 1])
    return None if np.isnan(r) else round(r, 3)


def generate_quality_correlation(conn, plant_uuid: str) -> Dict[str, Any]:
    """Per-zone correlation of daily energy vs on-site / Open-Meteo daily
    insolation, split by uniform vs non-uniform days → quality_correlation."""
    with conn.cursor() as cur:
        cur.execute(
            'SELECT slug, name, latitude, longitude, metadata FROM "Plant" WHERE id::text = %s',
            (plant_uuid,),
        )
        row = cur.fetchone()
    if not row:
        return {"skipped": "plant not found"}
    slug, name, lat, lon, metadata = row

    daily = _load_zone_daily_energy(conn, plant_uuid)
    if daily is None:
        return {"skipped": "needs ≥2 inverter power streams and ≥10 complete days"}
    rel = _spatial_frame(daily)
    zones = [c for c in rel.columns if not c.startswith("_") and c not in ("date", "cv", "spread")]
    wide_energy = daily.pivot(values="energy_per_inv", index="date", on="zone").sort("date")

    # Daily on-site insolation: hourly plant-mean irradiance summed per day.
    onsite = _load_onsite(conn, plant_uuid)
    if not onsite:
        return {"skipped": "no irradiance measurements"}
    onsite_daily = (
        onsite["df"]
        .with_columns(pl.col("timestamp").dt.date().alias("date"))
        .group_by("date")
        .agg(pl.col("irradiance_onsite").sum().alias("insol_onsite"))
    )

    # Daily Open-Meteo insolation over the same span (archive lags realtime).
    import datetime as _dt

    dmin, dmax = wide_energy["date"].min(), wide_energy["date"].max()
    archive_end = _dt.date.today() - _dt.timedelta(days=ARCHIVE_LAG_DAYS)
    end_date = min(dmax, archive_end)
    if lat is None or lon is None or (end_date - dmin).days < MIN_SPATIAL_DAYS:
        return {"skipped": "under 10 archive-overlapping days"}
    tilt = 30.0
    if isinstance(metadata, dict):
        raw_tilt = metadata.get("tilt_deg")
        if isinstance(raw_tilt, (int, float)) and 0 <= raw_tilt <= 90:
            tilt = float(raw_tilt)
    df_ref = _fetch_reference(
        float(lat), float(lon), dmin.isoformat(), end_date.isoformat(),
        tilted=onsite["is_poa"], tilt_deg=tilt,
    )
    if df_ref is None or df_ref.is_empty():
        return {"skipped": "Open-Meteo archive unavailable"}
    ref_daily = (
        df_ref.with_columns(pl.col("timestamp").dt.date().alias("date"))
        .group_by("date")
        .agg(pl.col("irradiance_openmeteo").sum().alias("insol_openmeteo"))
    )

    joined = (
        wide_energy.join(rel.select(["date", "cv"]), on="date", how="inner")
        .join(onsite_daily, on="date", how="inner")
        .join(ref_daily, on="date", how="inner")
        .sort("date")
    )
    if joined.height < MIN_CORR_SAMPLES:
        return {"skipped": f"only {joined.height} joined days"}

    def _zone_correlations(frame: pl.DataFrame):
        out = []
        for z in zones:
            e = frame[z].to_numpy()
            r_on = _pearson(e, frame["insol_onsite"].to_numpy())
            r_om = _pearson(e, frame["insol_openmeteo"].to_numpy())
            if r_on is None or r_om is None:
                continue
            diff = abs(r_on - r_om)
            better = "similar" if diff < 0.05 else ("on_site" if r_on > r_om else "open_meteo")
            out.append(
                {
                    "zoneId": z,
                    "onSiteCorrelation": r_on,
                    "openMeteoCorrelation": r_om,
                    "betterSource": better,
                    "correlationDifference": round(diff, 3),
                    "sampleCount": int(frame.height),
                }
            )
        return out

    uniform_frame = joined.filter(pl.col("cv") < CV_THRESHOLD)
    nonuniform_frame = joined.filter(pl.col("cv") >= CV_THRESHOLD)
    uniform_corrs = _zone_correlations(uniform_frame)
    nonuniform_corrs = _zone_correlations(nonuniform_frame)

    # Patterns + recommendations: only statements the numbers support.
    patterns = []
    all_corrs = uniform_corrs or nonuniform_corrs
    if uniform_corrs:
        mean_on = float(np.mean([c["onSiteCorrelation"] for c in uniform_corrs]))
        mean_om = float(np.mean([c["openMeteoCorrelation"] for c in uniform_corrs]))
        if mean_on - mean_om > 0.05:
            patterns.append(
                {
                    "id": "onsite_leads_uniform",
                    "pattern": "The on-site sensor explains zone production better than the satellite reference during uniform conditions",
                    "frequency": round(uniform_frame.height / joined.height, 2),
                    "confidence": round(min(0.9, uniform_frame.height / 60), 2),
                    "affectedZones": zones,
                }
            )
        elif mean_om - mean_on > 0.05:
            patterns.append(
                {
                    "id": "satellite_leads_uniform",
                    "pattern": "The satellite reference explains zone production better than the on-site sensor during uniform conditions — check sensor placement/calibration",
                    "frequency": round(uniform_frame.height / joined.height, 2),
                    "confidence": round(min(0.9, uniform_frame.height / 60), 2),
                    "affectedZones": zones,
                }
            )

    recommendations = []
    if all_corrs:
        mean_on = float(np.mean([c["onSiteCorrelation"] for c in all_corrs]))
        mean_om = float(np.mean([c["openMeteoCorrelation"] for c in all_corrs]))
        if mean_on >= mean_om - 0.05:
            recommendations.append(
                "Keep the on-site sensor as the primary irradiance source; it tracks zone production at least as well as the satellite reference."
            )
        else:
            recommendations.append(
                "The satellite reference tracks zone production better than the on-site sensor — investigate sensor calibration or placement."
            )
    nonuniform_share = 1 - (uniform_frame.height / joined.height) if joined.height else 0
    if nonuniform_share > 0.2:
        recommendations.append(
            f"{nonuniform_share * 100:.0f}% of days show non-uniform zone behaviour — review the Spatial tab before trusting plant-mean KPIs."
        )

    payload = {
        "metadata": {
            "plantId": slug,
            "generatedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "period": {"start": dmin.isoformat(), "end": end_date.isoformat()},
            "cvThreshold": CV_THRESHOLD,
            "minSampleSize": MIN_CORR_SAMPLES,
        },
        "overallAnalysis": {
            "uniformPeriods": {"count": int(uniform_frame.height), "zoneCorrelations": uniform_corrs},
            "nonUniformPeriods": {"count": int(nonuniform_frame.height), "zoneCorrelations": nonuniform_corrs},
        },
        "conditionalAnalysis": [],
        "patterns": patterns,
        "recommendations": recommendations,
    }
    write_artifact(
        plant_uuid,
        "quality_correlation",
        payload,
        source="computed",
        model_version="source-correlation-v1",
        conn=conn,
    )
    return {
        "plant": name,
        "days": int(joined.height),
        "uniform_days": int(uniform_frame.height),
        "zones": len(zones),
        "recommendations": len(recommendations),
    }
