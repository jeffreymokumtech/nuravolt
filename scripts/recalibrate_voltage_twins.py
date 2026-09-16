#!/usr/bin/env python3
"""
Recalibrate voltage_dc_predicted so its daily mean matches voltage_dc_actual per inverter.

Motivation
----------
Training v9 estimated Voc (~620 V) but the inverter-level voltage_dc_actual is the
mean Vmpp across MPPTs (~330 V). The resulting 2× offset makes the voltage twin
useless as an anomaly detector (everything looks "off"). This script computes a
per-inverter scale factor so that mean(predicted_new) == mean(actual), preserving
the *temperature shape* of the original prediction while fixing the absolute level.

The scale is clamped to [0.3, 2.0] so this won't inflate data at broken inverters
where actual is near zero due to outage rather than baseline miscalibration.

Usage
-----
    python scripts/recalibrate_voltage_twins.py
    python scripts/recalibrate_voltage_twins.py --dry-run
    python scripts/recalibrate_voltage_twins.py --plant ribera
"""

import argparse
import os
import sys
from typing import Dict

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv


def parse_db_url(url: str) -> Dict[str, str]:
    # postgresql://user:pass@host:port/db
    from urllib.parse import urlparse

    p = urlparse(url)
    return dict(
        host=p.hostname,
        port=p.port or 5432,
        dbname=p.path.lstrip("/"),
        user=p.username,
        password=p.password,
    )


def get_conn():
    load_dotenv()
    url = os.environ.get("DATABASE_URL") or "postgresql://nuravolt:nuravolt@localhost:5432/nuravolt"
    return psycopg2.connect(**parse_db_url(url))


def compute_scales(cur, plant_filter: str | None) -> Dict[str, float]:
    """Per-inverter ratio = mean(actual) / mean(predicted) over overlapping non-zero rows."""
    plant_clause = ""
    params: tuple = ()
    if plant_filter:
        plant_clause = "AND p.slug = %s"
        params = (plant_filter,)

    sql = f"""
        SELECT
            r.plant_id,
            r.device_id,
            AVG(CASE WHEN r.metric = 'voltage_dc_actual' THEN r.value END) AS avg_act,
            AVG(CASE WHEN r.metric = 'voltage_dc_predicted' THEN r.value END) AS avg_pred,
            COUNT(*) FILTER (WHERE r.metric = 'voltage_dc_predicted') AS n_pred
        FROM analysis_results r
        JOIN "Plant" p ON p.id = r.plant_id::text
        WHERE r.domain = 'digitaltwin'
          AND r.device_id LIKE 'INV%%'
          AND r.device_id NOT LIKE '%%.MPPT%%'
          AND r.device_id NOT LIKE '%%.STR%%'
          AND r.metric IN ('voltage_dc_predicted', 'voltage_dc_actual')
          {plant_clause}
        GROUP BY r.plant_id, r.device_id
        HAVING AVG(CASE WHEN r.metric = 'voltage_dc_predicted' THEN r.value END) > 0
           AND AVG(CASE WHEN r.metric = 'voltage_dc_actual' THEN r.value END) > 0
    """
    cur.execute(sql, params)
    scales: Dict[tuple, float] = {}
    for row in cur.fetchall():
        plant_id, device_id, avg_act, avg_pred, _n = row
        if avg_act is None or avg_pred is None or avg_pred == 0:
            continue
        ratio = float(avg_act) / float(avg_pred)
        # Clamp: don't scale below 0.3x or above 2x — outside this range something
        # else is wrong and a uniform scale won't rescue it.
        ratio = max(0.3, min(2.0, ratio))
        scales[(plant_id, device_id)] = ratio
    return scales


def apply_scales(cur, scales, dry_run: bool) -> int:
    """Update voltage_dc_predicted *= scale and recompute voltage_dc_residual.

    Implementation notes:
    - Predicted updates are per-inverter (targeted, fast).
    - Residual recompute is done in a single batch after all predicted updates,
      via a temp table. A direct UPDATE...FROM <self-join> returns 0 rows on
      this TimescaleDB hypertable (planner quirk); materialising the pairs
      first is reliable.
    """
    touched = 0
    to_update: list[tuple[str, str, float]] = []

    for (plant_id, device_id), scale in scales.items():
        if abs(scale - 1.0) < 0.02:
            continue  # close enough, skip
        to_update.append((plant_id, device_id, scale))

    if dry_run:
        for plant_id, device_id, scale in to_update:
            cur.execute(
                """
                SELECT COUNT(*) FROM analysis_results
                WHERE plant_id = %s::uuid AND device_id = %s
                  AND domain = 'digitaltwin' AND metric = 'voltage_dc_predicted'
                """,
                (plant_id, device_id),
            )
            n = cur.fetchone()[0]
            print(f"  [dry] {device_id:<20s} scale={scale:.3f}  would update {n} rows")
            touched += n
        return touched

    # 1) scale predicted per inverter
    for plant_id, device_id, scale in to_update:
        cur.execute(
            """
            UPDATE analysis_results
            SET value = value * %s
            WHERE plant_id = %s::uuid
              AND device_id = %s
              AND domain = 'digitaltwin'
              AND metric = 'voltage_dc_predicted'
            """,
            (scale, plant_id, device_id),
        )
        n_pred = cur.rowcount
        print(f"  {device_id:<20s} scale={scale:.3f}  pred={n_pred}")
        touched += n_pred

    # 2) Recompute all residuals in one pass via temp table.
    # A self-joined UPDATE on this hypertable returns 0 rows (TimescaleDB
    # planner does not support it here). Materialising the (plant, device, time)
    # -> new_residual map first works reliably.
    print("  Recomputing residuals via temp table…")
    cur.execute("DROP TABLE IF EXISTS _recal_residuals;")
    cur.execute(
        """
        CREATE TEMP TABLE _recal_residuals AS
        SELECT a.plant_id, a.device_id, a.time, (a.value - p.value) AS new_val
        FROM analysis_results a
        JOIN analysis_results p
          ON p.plant_id = a.plant_id AND p.device_id = a.device_id
         AND p.time = a.time AND p.domain = 'digitaltwin'
         AND p.metric = 'voltage_dc_predicted'
        WHERE a.domain = 'digitaltwin'
          AND a.metric = 'voltage_dc_actual'
          AND a.device_id LIKE 'INV%%'
          AND a.device_id NOT LIKE '%%.MPPT%%'
          AND a.device_id NOT LIKE '%%.STR%%';
        """
    )
    cur.execute(
        """
        UPDATE analysis_results r
        SET value = nr.new_val
        FROM _recal_residuals nr
        WHERE r.plant_id = nr.plant_id
          AND r.device_id = nr.device_id
          AND r.time = nr.time
          AND r.domain = 'digitaltwin'
          AND r.metric = 'voltage_dc_residual';
        """
    )
    n_res = cur.rowcount
    print(f"  → updated {n_res} residual rows")
    cur.execute("DROP TABLE _recal_residuals;")

    return touched


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--plant", help="Only recalibrate a single plant slug")
    args = parser.parse_args()

    conn = get_conn()
    conn.autocommit = False
    cur = conn.cursor()

    print(f"Computing per-inverter voltage scales (plant={args.plant or 'ALL'})…")
    scales = compute_scales(cur, args.plant)
    print(f"  → {len(scales)} inverters to consider")
    if not scales:
        print("Nothing to do.")
        return 0

    # Show distribution
    vals = sorted(scales.values())
    print(f"  scale range: min={vals[0]:.3f} median={vals[len(vals)//2]:.3f} max={vals[-1]:.3f}")

    n = apply_scales(cur, scales, args.dry_run)
    if args.dry_run:
        print(f"Dry run: would update {n} rows across {len(scales)} inverters")
        conn.rollback()
        return 0

    conn.commit()
    print(f"Committed {n} row updates across {len(scales)} inverters")

    # Refresh the daily CAGG so UI picks up the change
    print("Refreshing analysis_daily continuous aggregate…")
    conn.autocommit = True
    cur2 = conn.cursor()
    cur2.execute("CALL refresh_continuous_aggregate('analysis_daily', '2020-01-01', '2027-01-01');")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
