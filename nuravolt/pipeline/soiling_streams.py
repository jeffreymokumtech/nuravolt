"""Multi-source soiling history for the Data Explorer tab.

The demo's Data Explorer overlays precipitation, dust/PM, aerosol (AOD), a DustIQ
reference sensor, and ML/transfer soiling-ratio predictions. A freshly-onboarded
plant only has its own measurements + twin, so for seeded/demo plants we
synthesize the external-feed streams (dust/PM/AOD/DustIQ deterministic and
physically plausible) and reuse the plant's real soiling ratio for the SR/ML/
DustIQ series. Written as one consolidated `soiling_streams` artifact keyed to
the shapes DataExplorerChart consumes; labeled source='synthetic'. Real
customers without the feeds get the "connect a source" state instead.

Per-inverter PR: NEVER fabricated. When the plant has measured per-inverter
daily PR (public/data/soiling/{slug}/pr_daily.parquet), the real cross-inverter
structure is replayed by day-of-year into the serving window (same re-anchoring
convention as the electrical-twin backfill; grouped k:1 onto the DB inverters
when the physical count is larger) and labeled in payload["sources"]. Plants
without measured per-inverter data get NO per-inverter series at all — the
previous 0.86*sr + jitter fan-out is gone.

    from nuravolt.pipeline.soiling_streams import synthesize_soiling_streams
    synthesize_soiling_streams(conn, plant_id)
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

import psycopg2.extras

from nuravolt.db.writer import write_artifact

MODEL_VERSION = "soiling-streams-v1"
HISTORY_DAYS = 120


def _rng(seed_str: str) -> Any:
    import random

    h = int(hashlib.sha256(seed_str.encode()).hexdigest()[:12], 16)
    return random.Random(h)


def _load_real_inverter_pr(slug: str, dates: List[str], db_inverters: List[str]) -> List[Dict[str, Any]]:
    """Real per-inverter daily PR rows for the serving window, or [] if the
    plant has no measured per-inverter data.

    Reads public/data/soiling/{slug}/pr_daily.parquet (measured, long format
    date/inverterId/pr). The fixture typically ends before the serving window,
    so values are replayed by (month, day) from each inverter's latest year —
    the cross-inverter spread/ranking is measured, only the dates are
    re-anchored. Physical inverters are grouped k:1 onto the DB external ids
    (sorted order), mirroring the electrical-twin backfill convention.
    """
    if not db_inverters:
        return []
    repo_root = Path(__file__).resolve().parents[2]
    for cand in dict.fromkeys([slug, slug.split("-")[0]]):
        parquet = repo_root / "public" / "data" / "soiling" / cand / "pr_daily.parquet"
        if parquet.exists():
            break
    else:
        return []

    import pandas as pd

    df = pd.read_parquet(parquet)
    physical = sorted(df["inverterId"].unique())
    if len(physical) < len(db_inverters):
        return []  # cannot honestly expand fewer measured units onto more DB units

    # Group physical inverters k:1 onto DB externals (sorted order, like the twin backfill).
    k = len(physical) // len(db_inverters)
    group_of = {
        phys: db_inverters[min(i // k, len(db_inverters) - 1)]
        for i, phys in enumerate(physical)
    }
    df["ext"] = df["inverterId"].map(group_of)
    df["md"] = df["date"].dt.strftime("%m-%d")
    # Latest year wins per (month-day, external id).
    df = df.sort_values("date").groupby(["md", "ext"], as_index=False).last()
    lookup: Dict[str, Dict[str, float]] = {}
    for row in df.itertuples(index=False):
        lookup.setdefault(row.md, {})[row.ext] = float(row.pr)

    rows: List[Dict[str, Any]] = []
    for d in dates:
        by_ext = lookup.get(d[5:])  # 'YYYY-MM-DD' -> 'MM-DD'
        if not by_ext:
            continue
        for ext, val in sorted(by_ext.items()):
            rows.append({"date": d, "inverterId": ext, "pr": round(val, 4)})
    return rows


def _load_plant_sr_history(conn, plant_id: str, start: datetime) -> Dict[str, float]:
    """Daily PLANT soiling ratio, {date_iso: sr}, from analysis_results."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT time::date AS d, AVG(value) AS sr FROM analysis_results "
            "WHERE plant_id = %s AND domain = 'soiling' AND metric = 'soiling_ratio' "
            "  AND device_id = 'PLANT' AND time >= %s AND time <= NOW() "
            "GROUP BY 1 ORDER BY 1",
            (plant_id, start),
        )
        return {r[0].isoformat(): float(r[1]) for r in cur.fetchall()}


def synthesize_soiling_streams(conn, plant_id: str) -> Dict[str, Any]:
    """Generate + persist the `soiling_streams` artifact for one plant."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT slug, asset_type FROM "Plant" WHERE id = %s', (plant_id,))
        plant = cur.fetchone()
        cur.execute(
            'SELECT i.external_id FROM "InverterGroup" g JOIN "Inverter" i ON i.group_id = g.id '
            'WHERE g.plant_id = %s ORDER BY i.external_id',
            (plant_id,),
        )
        inverters = [r["external_id"] for r in cur.fetchall()]
    if not plant or str(plant.get("asset_type") or "PV").upper() == "BESS":
        return {"days": 0, "note": "no PV inverters"}

    rng = _rng(f"streams:{plant_id}")
    end = datetime.now(timezone.utc).date()
    start_dt = datetime.combine(end - timedelta(days=HISTORY_DAYS), datetime.min.time(), tzinfo=timezone.utc)
    sr_hist = _load_plant_sr_history(conn, plant_id, start_dt)

    dates = [(end - timedelta(days=HISTORY_DAYS - 1 - i)).isoformat() for i in range(HISTORY_DAYS)]

    rain_onsite: List[Dict[str, Any]] = []
    rain_openmeteo: List[Dict[str, Any]] = []
    dust: List[Dict[str, Any]] = []
    aod: List[Dict[str, Any]] = []
    dustiq: List[Dict[str, Any]] = []
    ml_sr: List[Dict[str, Any]] = []
    transfer_sr: List[Dict[str, Any]] = []

    # Fallback SR walk when the plant has no forecast rows (keeps series continuous).
    walk_sr = 0.99
    for i, d in enumerate(dates):
        # Real SR where available, else a slow soiling walk with rain resets.
        sr = sr_hist.get(d)
        if sr is None:
            walk_sr = max(0.85, walk_sr - rng.uniform(0.0, 0.004))
            sr = walk_sr

        # Rain: dry Mediterranean summer — occasional events; a wet day cleans.
        wet = rng.random() < 0.08
        rain_mm = round(rng.uniform(2, 18), 1) if wet else 0.0
        if wet:
            walk_sr = min(0.995, walk_sr + rng.uniform(0.01, 0.03))
        rain_onsite.append({"date": d, "rain_mm": rain_mm})
        rain_openmeteo.append({"date": d, "rain_mm": round(rain_mm * rng.uniform(0.8, 1.2), 1)})

        # Aerosol optical depth 550nm — baseline + seasonal + dust spikes.
        base_aod = 0.14 + 0.05 * math.sin((i / HISTORY_DAYS) * 2 * math.pi)
        dust_event = rng.random() < 0.05
        aod_val = round(max(0.02, base_aod + (rng.uniform(0.2, 0.5) if dust_event else rng.uniform(-0.03, 0.05))), 3)
        aod.append({"date": d, "aod_550nm": aod_val})

        # PM correlated with AOD.
        pm10 = round(max(3, aod_val * 90 + rng.uniform(-5, 8)), 1)
        pm25 = round(max(2, pm10 * rng.uniform(0.4, 0.6)), 1)
        dust.append({"date": d, "pm10": pm10, "pm2_5": pm25, "dust": round(aod_val * 40 + rng.uniform(-3, 5), 1)})

        # DustIQ reference sensor ≈ true SR + sensor noise.
        dustiq.append({"date": d, "sr_dustiq": round(min(1.0, max(0.8, sr + rng.uniform(-0.008, 0.008))), 4)})
        # ML + transfer SR predictions bracket the true SR.
        ml_sr.append({"date": d, "sr_predicted": round(min(1.0, max(0.8, sr + rng.uniform(-0.01, 0.01))), 4)})
        transfer_sr.append({"date": d, "sr_transfer": round(min(1.0, max(0.8, sr + rng.uniform(-0.02, 0.015))), 4)})

    # Per-inverter PR: measured replay only — no synthetic fan-out. Plants
    # without measured per-inverter data simply carry no `pr` series.
    pr = _load_real_inverter_pr(str(plant.get("slug") or ""), dates, inverters)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "climate_zone": "MEDITERRANEAN",
        "rain_onsite": rain_onsite,
        "rain_openmeteo": rain_openmeteo,
        "dust": dust,
        "aod": aod,
        "dustiq": dustiq,
        "ml_sr": ml_sr,
        "transfer_sr": transfer_sr,
        "sources": {
            "rain_onsite": "synthetic", "rain_openmeteo": "synthetic",
            "dust": "synthetic", "aod": "synthetic", "dustiq": "synthetic",
            "ml_sr": "model_over_plant_sr", "transfer_sr": "model_over_plant_sr",
            **({"pr": "measured_replay_by_doy"} if pr else {}),
        },
    }
    if pr:
        payload["pr"] = pr
    write_artifact(plant_id, "soiling_streams", payload, source="synthetic",
                   model_version=MODEL_VERSION, conn=conn)
    conn.commit()
    return {"days": len(dates), "inverters": len(inverters)}
