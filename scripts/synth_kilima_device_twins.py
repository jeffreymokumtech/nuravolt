#!/usr/bin/env python3
"""Derive per-MPPT / per-string twin timeseries for the kilima-solar drill-down.

The inverter drill-down's MPPT and string pages fetch a "live twin" overlay
(predicted vs actual) from /api/digitaltwin/.../parquet-query, which reads
analysis_results at device grain. Kilima has no wide SCADA and no per-string
MEASURED telemetry, so this cannot be a trained twin. Instead we DERIVE a
physics-plausible per-device timeseries from data we do have:

  * per-string current = the inverter's existing power twin shape
    (analysis_results power_ac_{predicted,actual}) allocated across strings by
    the committed snapshot's current shares
    (public/data/digitaltwin/kilima-solar/mppt_string_data.json), anchored so
    the snapshot value is hit at peak power;
  * per-MPPT voltage = the snapshot MPPT voltage with a physics temp correction;
  * ACTUAL applies the seeded string_anomalies.json factors (OPEN_CIRCUIT -> 0,
    MISMATCH/DEGRADATION -> current drop) so the drill-down reproduces the fault
    story (e.g. INV-21 outage). residual = actual - predicted.

This is a demo shortcut, explicitly NOT measured per-string data. Rows are tagged
model_version='snapshot-derived-v1'; the UI labels that provenance and rollback is
    DELETE FROM analysis_results WHERE model_version='snapshot-derived-v1';

Device ids match the parquet-query route contract exactly:
    mppt_voltage_{predicted,actual,residual}   at  INV-XX.MPPT-k
    string_current_{predicted,actual,residual} at  INV-XX.STR-g
where g is the GLOBAL per-inverter string index the route's string_current_sum
expects: MPPT-k -> STR-(2k-1), STR-2k (stringsPerMppt=2).

Deterministic per (device, day): reruns upsert identical values.

Usage:
    DATABASE_URL=<dsn> python scripts/synth_kilima_device_twins.py [--plant kilima-solar] [--dry-run]

Prod: export the prod DATABASE_URL explicitly and verify with psql afterwards.
"""

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402

MODEL_VERSION = "snapshot-derived-v1"
BETA_V = -0.0029     # V_mpp temperature coefficient per degC
K_RISE = 26.0        # degC module temp rise at full load
CELL_OFFSET = 8.0    # cell hotter than cabinet at load


def _unit(seed: str) -> float:
    return int(hashlib.sha256(seed.encode()).hexdigest()[:12], 16) / float(16 ** 12)


def _gauss(seed: str, sigma: float) -> float:
    u1 = max(1e-9, _unit(seed + ":u1"))
    u2 = _unit(seed + ":u2")
    return sigma * math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def _ambient_c(day, plant_key: str) -> float:
    # Equatorial East Africa: mild seasonal swing.
    doy = day.timetuple().tm_yday
    base = 24.0 + 3.0 * math.cos(2 * math.pi * (doy - 15) / 365)
    return base + _gauss(f"{plant_key}:{day}:amb", 1.2)


def _load_snapshot(plant_slug: str):
    p = PROJECT_ROOT / "public" / "data" / "digitaltwin" / plant_slug / "mppt_string_data.json"
    return json.loads(p.read_text())


def _load_anomalies(plant_slug: str):
    """Return {(inverterId, mpptId, stringId): drop_fraction}. OPEN_CIRCUIT -> 1.0."""
    p = PROJECT_ROOT / "public" / "data" / "digitaltwin" / plant_slug / "string_anomalies.json"
    out = {}
    try:
        data = json.loads(p.read_text())
    except FileNotFoundError:
        return out
    for a in data.get("anomalies", []):
        if a.get("type") == "OPEN_CIRCUIT":
            drop = 1.0
        else:
            drop = float(a.get("currentDrop_pct", 0.0)) / 100.0
        out[(a.get("inverterId"), a.get("mpptId"), a.get("stringId"))] = min(1.0, max(0.0, drop))
    return out


def _mppt_index(mppt_id: str) -> int:
    # "MPPT-3" -> 3
    return int(str(mppt_id).rsplit("-", 1)[-1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", default="kilima-solar", help="plant slug")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")  # never overrides an exported DATABASE_URL
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    snapshot = _load_snapshot(args.plant)
    anomalies = _load_anomalies(args.plant)
    strings_per_mppt = int(snapshot.get("stringsPerMppt", 2))
    inv_snap = snapshot["inverters"]  # dict keyed by "INV-XX"

    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute('SELECT id FROM "Plant" WHERE slug = %s OR id::text = %s', (args.plant, args.plant))
    prow = cur.fetchone()
    if not prow:
        sys.exit(f"plant not found: {args.plant}")
    plant_id = prow["id"]

    # Inverter power twin (daily) as the shape driver.
    cur.execute(
        """
        SELECT device_id, metric, time, value
        FROM analysis_results
        WHERE plant_id = %s AND domain = 'digitaltwin'
          AND metric IN ('power_ac_predicted', 'power_ac_actual')
          AND device_id LIKE 'INV-%%'
        ORDER BY device_id, time
        """,
        (plant_id,),
    )
    rows = cur.fetchall()
    if not rows:
        sys.exit("no per-inverter power_ac rows for this plant — run the inverter twin first")

    # (device, time) -> {pred, act}; per-device peak predicted for anchoring.
    power = defaultdict(dict)
    peak = defaultdict(float)
    for r in rows:
        which = "pred" if r["metric"] == "power_ac_predicted" else "act"
        power[(r["device_id"], r["time"])][which] = float(r["value"])
        if which == "pred":
            peak[r["device_id"]] = max(peak[r["device_id"]], float(r["value"]))

    records = defaultdict(list)  # device_id-scoped rows go under one plant write

    def add(device_id, ts, metric, value):
        records[plant_id].append(
            {"time": ts, "device_id": device_id, "metric": metric, "value": round(float(value), 3)}
        )

    n_mppt_rows = n_str_rows = 0
    for (device_id, ts), p in sorted(power.items()):
        snap = inv_snap.get(device_id)
        if not snap:
            continue
        p_peak = max(1.0, peak[device_id])
        frac_pred = max(0.0, p.get("pred", 0.0)) / p_peak
        has_act = "act" in p
        frac_act = max(0.0, p.get("act", 0.0)) / p_peak if has_act else None
        day = ts.date()
        amb = _ambient_c(day, device_id)

        for mppt in snap.get("mppts", []):
            k = _mppt_index(mppt["mpptId"])
            # Per-MPPT voltage from snapshot + temp correction (flat-ish).
            load = min(1.3, frac_pred)
            cell = amb + (K_RISE + CELL_OFFSET) * load
            v_base = float(mppt.get("voltage_V", 730.0))
            v_pred = v_base * (1 + BETA_V * (cell - 25.0))
            add(f"{device_id}.{mppt['mpptId']}", ts, "mppt_voltage_predicted", v_pred)
            # An open string on this MPPT nudges bus voltage up slightly.
            mppt_open = any(
                anomalies.get((device_id, mppt["mpptId"], s.get("stringId")), 0.0) >= 1.0
                for s in mppt.get("strings", [])
            )
            if has_act:
                v_act = v_pred * (1.0 + (0.01 if mppt_open else 0.0)) + _gauss(f"{device_id}:{mppt['mpptId']}:{day}:v", 1.5)
                add(f"{device_id}.{mppt['mpptId']}", ts, "mppt_voltage_actual", v_act)
                add(f"{device_id}.{mppt['mpptId']}", ts, "mppt_voltage_residual", v_act - v_pred)
            n_mppt_rows += 1

            for j, s in enumerate(mppt.get("strings", []), start=1):
                g = (k - 1) * strings_per_mppt + j  # global per-inverter string index
                sid = f"{device_id}.STR-{g}"
                i_base = float(s.get("current_A", 0.0))
                i_pred = i_base * frac_pred
                add(sid, ts, "string_current_predicted", i_pred)
                if has_act:
                    drop = anomalies.get((device_id, mppt["mpptId"], s.get("stringId")), 0.0)
                    i_act = i_base * frac_act * (1.0 - drop)
                    i_act = max(0.0, i_act + _gauss(f"{sid}:{day}:i", 0.15))
                    add(sid, ts, "string_current_actual", i_act)
                    add(sid, ts, "string_current_residual", i_act - i_pred)
                n_str_rows += 1

    total = sum(len(v) for v in records.values())
    n_devices = len({rec["device_id"] for recs in records.values() for rec in recs})
    print(
        f"{args.plant}: {total} rows across {n_devices} devices "
        f"({n_mppt_rows} mppt-days, {n_str_rows} string-days)"
    )
    if args.dry_run:
        print(f"[dry-run] would upsert {total} analysis_results rows ({MODEL_VERSION})")
        return

    with TimeseriesWriter(dsn=dsn) as writer:
        written = 0
        for pid, recs in records.items():
            written += writer.write_analysis_results(pid, "digitaltwin", recs, model_version=MODEL_VERSION)
    print(f"upserted {written} rows tagged {MODEL_VERSION}")


if __name__ == "__main__":
    main()
