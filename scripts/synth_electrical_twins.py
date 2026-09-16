#!/usr/bin/env python3
"""Derive per-inverter electrical twin channels from existing power rows.

The inverter drill-down UI ships Temperature / DC-voltage / DC-current twin
panels, but only power_ac_* channels exist in analysis_results (the SCADA
parquets behind the trained electrical pkls are gone, so retraining is not an
option). This script derives physics-consistent daily electrical channels
from each device's existing power_ac_{predicted,actual} rows:

    temp     = ambient(seasonal) + k_rise x (P / P_rated)
    voltage  = V_mpp_stc x (1 + beta x (cell_temp - 25)),  beta = -0.29 %/degC
    current  = (P_ac / eta_inv) / voltage

Faulty devices inherit anomalous temperature/current for free because the
derivation runs through their (anomalous) actual power. Rows are tagged
model_version='electrical-synth-v1' — the UI renders a "physics-derived
synthetic twin" caption on that tag, and rollback is:

    DELETE FROM analysis_results WHERE model_version = 'electrical-synth-v1';

Deterministic per (plant, device, day): reruns upsert identical values.

Usage:
    python scripts/synth_electrical_twins.py [--plant <slug-or-uuid>] [--dry-run]

Prod: run with the prod DATABASE_URL exported explicitly, then verify with
psql (never trust the script output alone).
"""

import argparse
import hashlib
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

MODEL_VERSION = "electrical-synth-v1"
ETA_INV = 0.975          # inverter DC->AC efficiency
BETA_V = -0.0029         # V_mpp temperature coefficient per degC
K_RISE = 26.0            # degC module temp rise at full load
CELL_OFFSET = 8.0        # cell runs hotter than the reported cabinet temp


def _unit(seed: str) -> float:
    """Deterministic uniform [0,1) from a string seed."""
    return int(hashlib.sha256(seed.encode()).hexdigest()[:12], 16) / float(16 ** 12)


def _gauss(seed: str, sigma: float) -> float:
    """Deterministic ~N(0, sigma) via Box-Muller on hashed uniforms."""
    u1 = max(1e-9, _unit(seed + ":u1"))
    u2 = _unit(seed + ":u2")
    return sigma * math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def ambient_c(day, plant_key: str) -> float:
    doy = day.timetuple().tm_yday
    base = 12.0 + 10.0 * math.cos(2 * math.pi * (doy - 197) / 365)
    return base + _gauss(f"{plant_key}:{day}:amb", 2.0)


def derive(day, device: str, plant_key: str, p_pred, p_act, p_rated: float):
    """Return list of (metric, value) for one device-day."""
    amb = ambient_c(day, plant_key)
    v_mpp = 600.0 + 40.0 * _unit(f"{plant_key}:{device}:vmpp")

    def channels(p_kw, suffix_seed):
        load = max(0.0, min(1.3, p_kw / p_rated))
        temp = amb + K_RISE * load + _gauss(suffix_seed + ":t", 0.7)
        cell = temp + CELL_OFFSET * load
        volt = v_mpp * (1 + BETA_V * (cell - 25.0))
        curr = (p_kw / ETA_INV) * 1000.0 / max(1.0, volt)
        return temp, volt, curr

    out = []
    t_pred = v_pred = c_pred = None
    if p_pred is not None:
        t_pred, v_pred, c_pred = channels(p_pred, f"{plant_key}:{device}:{day}:pred")
        out += [
            ("temperature_predicted", t_pred),
            ("voltage_dc_predicted", v_pred),
            ("current_dc_predicted", c_pred),
        ]
    if p_act is not None:
        t_act, v_act, c_act = channels(p_act, f"{plant_key}:{device}:{day}:act")
        out += [
            ("temperature_actual", t_act),
            ("voltage_dc_actual", v_act),
            ("current_dc_actual", c_act),
        ]
        if t_pred is not None:
            out += [
                ("temperature_residual", t_act - t_pred),
                ("voltage_dc_residual", v_act - v_pred),
                ("current_dc_residual", c_act - c_pred),
            ]
    return [(m, round(v, 3)) for m, v in out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", help="plant slug or uuid (default: every plant with device power rows)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")  # does not override an exported DATABASE_URL
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    plant_filter = ""
    params = []
    if args.plant:
        cur.execute('SELECT id FROM "Plant" WHERE id::text = %s OR slug = %s', (args.plant, args.plant))
        row = cur.fetchone()
        if not row:
            sys.exit(f"plant not found: {args.plant}")
        plant_filter = "AND plant_id = %s"
        params = [row["id"]]

    cur.execute(
        f"""
        SELECT plant_id::text AS plant_id, device_id, metric, time, value
        FROM analysis_results
        WHERE domain = 'digitaltwin'
          AND metric IN ('power_ac_predicted', 'power_ac_actual')
          AND device_id IS NOT NULL AND device_id <> 'PLANT'
          {plant_filter}
        ORDER BY plant_id, device_id, time
        """,
        params,
    )
    rows = cur.fetchall()
    if not rows:
        sys.exit("no per-device power_ac rows found — nothing to derive from")

    # Pivot to (plant, device, time) -> {pred, act}; track per-device rating.
    cells = defaultdict(dict)
    rated = defaultdict(float)
    for r in rows:
        key = (r["plant_id"], r["device_id"], r["time"])
        which = "pred" if r["metric"] == "power_ac_predicted" else "act"
        cells[key][which] = float(r["value"])
        if which == "pred":
            rated[(r["plant_id"], r["device_id"])] = max(
                rated[(r["plant_id"], r["device_id"])], float(r["value"])
            )

    per_plant = defaultdict(list)
    for (plant_id, device, ts), vals in cells.items():
        p_rated = max(1.0, rated[(plant_id, device)] * 1.1)
        metrics = derive(ts.date(), device, plant_id, vals.get("pred"), vals.get("act"), p_rated)
        for metric, value in metrics:
            per_plant[plant_id].append(
                {"time": ts, "device_id": device, "metric": metric, "value": value}
            )

    total = sum(len(v) for v in per_plant.values())
    for plant_id, records in sorted(per_plant.items()):
        devices = len({r["device_id"] for r in records})
        print(f"{plant_id}: {len(records)} rows across {devices} devices")
    if args.dry_run:
        print(f"[dry-run] would upsert {total} analysis_results rows ({MODEL_VERSION})")
        return

    with TimeseriesWriter(dsn=dsn) as writer:
        written = 0
        for plant_id, records in per_plant.items():
            written += writer.write_analysis_results(
                plant_id, "digitaltwin", records, model_version=MODEL_VERSION
            )
    print(f"upserted {written} rows tagged {MODEL_VERSION}")


if __name__ == "__main__":
    main()
