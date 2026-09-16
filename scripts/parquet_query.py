#!/usr/bin/env python3
"""DuckDB-based Parquet query helper for fast per-device twin timeseries.

Usage:
  python3 scripts/parquet_query.py <plant_uuid> <device_id> <twin_type> <from_date> <to_date>

twin_type:
  power               — inverter / plant power (power_hourly.parquet)
  temperature         — inverter temperature (temperature_hourly.parquet)
  mppt_voltage        — per-MPPT voltage (mppt_voltage_hourly.parquet); device_id like
                        "INV 01.057.MPPT-1"
  string_current      — per-string current (string_current_hourly.parquet); device_id like
                        "INV 01.057.STR-1"
  string_current_sum  — sum of the strings under one MPPT, returned as a single
                        predicted/actual/residual series. device_id is the MPPT id
                        ("INV 01.057.MPPT-1") and we look up its child strings via
                        a configurable strings-per-MPPT (defaults to 2 for SUN2000-60KTL).

For string_current_sum, the SUN2000-60KTL convention is 2 strings per MPPT
(MPPT-1 → STR-1+STR-2, MPPT-2 → STR-3+STR-4, …). Override with $STRINGS_PER_MPPT.
"""
import sys
import json
import os
import re

# Map twin_type to parquet file name + (optional) custom handler
TYPE_FILE = {
    "power": "power_hourly.parquet",
    "temperature": "temperature_hourly.parquet",
    "mppt_voltage": "mppt_voltage_hourly.parquet",
    "string_current": "string_current_hourly.parquet",
    "string_current_sum": "string_current_hourly.parquet",
}


def child_strings_for_mppt(mppt_device_id: str, strings_per_mppt: int) -> list[str]:
    """Given "INV 01.057.MPPT-1" return ["INV 01.057.STR-1", "INV 01.057.STR-2"]."""
    m = re.match(r"^(.+)\.MPPT-(\d+)$", mppt_device_id)
    if not m:
        return []
    parent = m.group(1)
    mppt_num = int(m.group(2))
    first = (mppt_num - 1) * strings_per_mppt + 1
    return [f"{parent}.STR-{first + i}" for i in range(strings_per_mppt)]


def pivot_to_series(rows) -> list[dict]:
    by_time: dict[str, dict] = {}
    for _, row in rows.iterrows():
        ts = str(row["time"])
        bucket = by_time.setdefault(ts, {})
        metric = row["metric"]
        val = float(row["value"]) if row["value"] is not None else None
        if "predicted" in metric:
            bucket["predicted"] = val
        elif "actual" in metric:
            bucket["actual"] = val
        elif "residual" in metric:
            bucket["residual"] = val
    return [{"date": ts, **vals} for ts, vals in sorted(by_time.items())]


def main():
    if len(sys.argv) < 6:
        print(json.dumps({"error": "Usage: parquet_query.py <plant_uuid> <device_id> <twin_type> <from_date> <to_date>"}))
        sys.exit(1)

    plant_id = sys.argv[1]
    device_id = sys.argv[2]
    twin_type = sys.argv[3]
    from_date = sys.argv[4]
    to_date = sys.argv[5]

    if twin_type not in TYPE_FILE:
        print(json.dumps({"error": f"Unknown twin_type: {twin_type}", "series": []}))
        sys.exit(0)

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parquet_path = os.path.join(project_root, "backenddata", "twins", plant_id, TYPE_FILE[twin_type])

    if not os.path.exists(parquet_path):
        print(json.dumps({"error": f"Parquet file not found: {TYPE_FILE[twin_type]}", "series": []}))
        sys.exit(0)

    try:
        import duckdb

        if twin_type == "string_current_sum":
            strings_per_mppt = int(os.environ.get("STRINGS_PER_MPPT", "2"))
            child_ids = child_strings_for_mppt(device_id, strings_per_mppt)
            if not child_ids:
                print(json.dumps({"error": f"Cannot derive child strings from {device_id}", "series": []}))
                sys.exit(0)
            # Sum predicted/actual/residual at each timestamp across the child strings.
            rows = duckdb.sql("""
                SELECT time, metric, SUM(value) AS value
                FROM read_parquet(?)
                WHERE device_id IN (SELECT UNNEST(?::VARCHAR[]))
                  AND time >= ?::TIMESTAMP
                  AND time <= ?::TIMESTAMP
                GROUP BY time, metric
                ORDER BY time, metric
            """, params=[parquet_path, child_ids, from_date, to_date]).fetchdf()
        else:
            rows = duckdb.sql("""
                SELECT time, metric, value
                FROM read_parquet(?)
                WHERE device_id = ?
                  AND time >= ?::TIMESTAMP
                  AND time <= ?::TIMESTAMP
                ORDER BY time, metric
            """, params=[parquet_path, device_id, from_date, to_date]).fetchdf()

        if rows.empty:
            print(json.dumps({"series": [], "count": 0, "device_id": device_id, "twin_type": twin_type}))
            return

        series = pivot_to_series(rows)
        print(json.dumps({"series": series, "count": len(series), "device_id": device_id, "twin_type": twin_type}))

    except Exception as e:
        print(json.dumps({"error": str(e), "series": []}))
        sys.exit(0)


if __name__ == "__main__":
    main()
