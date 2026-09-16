#!/usr/bin/env python3
"""
Recalibrate voltage_dc_predicted for a single inverter.

Same logic as recalibrate_voltage_twins.py, but scoped to one (plant, device).
Use this to sanity-check the result on one inverter before committing the
fleet-wide update.

Usage
-----
    python scripts/recalibrate_voltage_one_inverter.py --plant ribera --device "INV 01.057"
    python scripts/recalibrate_voltage_one_inverter.py --plant ribera --device "INV 01.057" --dry-run
"""

import argparse
import os
import sys
from urllib.parse import urlparse

import psycopg2
from dotenv import load_dotenv


def parse_db_url(url: str) -> dict:
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plant", required=True, help="Plant slug, e.g. ribera")
    parser.add_argument("--device", required=True, help='Device id, e.g. "INV 01.057"')
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    conn = get_conn()
    conn.autocommit = False
    cur = conn.cursor()
    # Hypertable updates can decompress > 100k tuples; lift the per-DML cap
    # for this session so the residual recompute doesn't abort partway.
    cur.execute("SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0;")

    cur.execute(
        """
        SELECT
            r.plant_id,
            AVG(CASE WHEN r.metric = 'voltage_dc_actual' THEN r.value END) AS avg_act,
            AVG(CASE WHEN r.metric = 'voltage_dc_predicted' THEN r.value END) AS avg_pred,
            COUNT(*) FILTER (WHERE r.metric = 'voltage_dc_predicted') AS n_pred,
            COUNT(*) FILTER (WHERE r.metric = 'voltage_dc_residual') AS n_res
        FROM analysis_results r
        JOIN "Plant" p ON p.id = r.plant_id::text
        WHERE r.domain = 'digitaltwin'
          AND r.metric IN ('voltage_dc_predicted', 'voltage_dc_actual', 'voltage_dc_residual')
          AND p.slug = %s
          AND r.device_id = %s
        GROUP BY r.plant_id
        """,
        (args.plant, args.device),
    )
    row = cur.fetchone()
    if not row:
        print(f"No data for {args.plant} / {args.device}")
        return 1

    plant_id, avg_act, avg_pred, n_pred, n_res = row
    if avg_act is None or avg_pred is None or avg_pred == 0:
        print(f"Cannot compute scale: avg_act={avg_act} avg_pred={avg_pred}")
        return 1

    raw_ratio = float(avg_act) / float(avg_pred)
    scale = max(0.3, min(2.0, raw_ratio))
    clamped = "" if scale == raw_ratio else f"  (clamped from {raw_ratio:.4f})"
    print(f"Plant: {args.plant}  Device: {args.device}")
    print(f"  predicted rows: {n_pred}   residual rows: {n_res}")
    print(f"  mean(actual)   = {float(avg_act):.2f}")
    print(f"  mean(predicted)= {float(avg_pred):.2f}")
    print(f"  scale          = {scale:.4f}{clamped}")

    if args.dry_run:
        print("Dry run — no updates applied.")
        return 0

    cur.execute(
        """
        UPDATE analysis_results
        SET value = value * %s
        WHERE plant_id = %s::uuid
          AND device_id = %s
          AND domain = 'digitaltwin'
          AND metric = 'voltage_dc_predicted'
        """,
        (scale, plant_id, args.device),
    )
    print(f"  predicted rows updated: {cur.rowcount}")

    cur.execute(
        """
        UPDATE analysis_results r
        SET value = a.value - p.value
        FROM analysis_results a
        JOIN analysis_results p
          ON p.plant_id = a.plant_id AND p.device_id = a.device_id AND p.time = a.time
         AND p.domain = 'digitaltwin' AND p.metric = 'voltage_dc_predicted'
        WHERE r.plant_id = a.plant_id AND r.device_id = a.device_id AND r.time = a.time
          AND r.domain = 'digitaltwin' AND r.metric = 'voltage_dc_residual'
          AND a.domain = 'digitaltwin' AND a.metric = 'voltage_dc_actual'
          AND a.plant_id = %s::uuid AND a.device_id = %s
        """,
        (plant_id, args.device),
    )
    n_res_updated = cur.rowcount

    if n_res_updated == 0:
        # TimescaleDB hypertable can refuse the self-join planner shape;
        # fall back to the temp-table strategy used by the fleet script.
        cur.execute("DROP TABLE IF EXISTS _recal_residuals_one;")
        cur.execute(
            """
            CREATE TEMP TABLE _recal_residuals_one AS
            SELECT a.plant_id, a.device_id, a.time, (a.value - p.value) AS new_val
            FROM analysis_results a
            JOIN analysis_results p
              ON p.plant_id = a.plant_id AND p.device_id = a.device_id AND p.time = a.time
             AND p.domain = 'digitaltwin' AND p.metric = 'voltage_dc_predicted'
            WHERE a.domain = 'digitaltwin'
              AND a.metric = 'voltage_dc_actual'
              AND a.plant_id = %s::uuid
              AND a.device_id = %s
            """,
            (plant_id, args.device),
        )
        cur.execute(
            """
            UPDATE analysis_results r
            SET value = nr.new_val
            FROM _recal_residuals_one nr
            WHERE r.plant_id = nr.plant_id
              AND r.device_id = nr.device_id
              AND r.time = nr.time
              AND r.domain = 'digitaltwin'
              AND r.metric = 'voltage_dc_residual'
            """
        )
        n_res_updated = cur.rowcount
        cur.execute("DROP TABLE _recal_residuals_one;")

    print(f"  residual rows updated:  {n_res_updated}")
    conn.commit()

    print("Refreshing analysis_daily continuous aggregate (one device, full range)…")
    conn.autocommit = True
    cur2 = conn.cursor()
    cur2.execute("CALL refresh_continuous_aggregate('analysis_daily', '2020-01-01', '2027-01-01');")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
