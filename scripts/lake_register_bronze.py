#!/usr/bin/env python3
"""Register the existing parquet stage as Iceberg *bronze* tables (zero data movement).

Phase 1 of the lakehouse migration — see ``docs/DATA_ARCHITECTURE_GUIDE.md``.

This wraps the tidy, long-format parquets we already have on disk
(``backenddata/twins/<plant_uuid>/*_hourly.parquet`` and
``public/data/soiling/<plant>/pr_daily.parquet``) as Iceberg tables via
``add_files`` — which records each parquet's footer metadata + column stats into
the catalog WITHOUT rewriting a single byte. The tables are then readable through
DuckDB exactly as they will be in production (the warehouse just moves from the
local filesystem to S3 in Phase 2).

Deliberately NOT registered here: the wide ``backenddata/scada/<plant>/<plant>_cleaned.parquet``
files. They are 3,000+ columns with non-UTF8 (mojibake) column names like
``Temperature (\\x83)`` that Iceberg field names can't carry as-is. Normalizing
those into a tidy ``(time, device_id, metric, value)`` shape is a *silver* concern
(an unpivot), not a faithful raw-bronze ``add_files``. Tracked in the guide.

Usage::

    python scripts/lake_register_bronze.py                 # register everything discoverable
    python scripts/lake_register_bronze.py --plant ribera
    python scripts/lake_register_bronze.py --replace       # rebuild metadata from scratch
    python scripts/lake_register_bronze.py --no-verify     # skip the DuckDB count cross-check

The local warehouse lands under ``./lake`` (override with LAKE_WAREHOUSE). Nothing
touches AWS in dev (LAKE_ENV defaults to ``dev``).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import pyarrow.parquet as pq  # noqa: E402

from nuravolt import lake  # noqa: E402

# plant_uuid -> slug (matches scripts/aggregate_twins_to_db.py::PLANTS)
PLANT_UUID_TO_SLUG = {
    "eb47ddda-0961-40b8-965a-80271b41e33f": "ribera",
    "ee0f71ae-b431-4956-8ace-fa535d263151": "alpha",
}

# twin parquet stem -> bronze table-name fragment
TWIN_FILES = {
    "power_hourly": "twin_power",
    "temperature_hourly": "twin_temperature",
    "mppt_voltage_hourly": "twin_mppt_voltage",
    "string_current_hourly": "twin_string_current",
}


def discover_targets(plant_filter: Optional[str]) -> List[Tuple[str, Path]]:
    """Build the (table_id, parquet_path) work list from what's actually on disk."""
    targets: List[Tuple[str, Path]] = []

    twins_root = PROJECT_ROOT / "backenddata" / "twins"
    for uuid_dir in sorted(twins_root.glob("*")) if twins_root.exists() else []:
        slug = PLANT_UUID_TO_SLUG.get(uuid_dir.name, uuid_dir.name[:8])
        if plant_filter and slug != plant_filter:
            continue
        for stem, frag in TWIN_FILES.items():
            p = uuid_dir / f"{stem}.parquet"
            if p.exists():
                targets.append((f"bronze.{frag}_{slug}", p))

    soiling_root = PROJECT_ROOT / "public" / "data" / "soiling"
    for plant_dir in sorted(soiling_root.glob("*")) if soiling_root.exists() else []:
        slug = plant_dir.name
        if plant_filter and slug != plant_filter:
            continue
        p = plant_dir / "pr_daily.parquet"
        if p.exists():
            targets.append((f"bronze.pr_daily_{slug}", p))

    return targets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plant", help="restrict to one plant slug (e.g. ribera)")
    parser.add_argument("--replace", action="store_true",
                        help="drop + recreate table metadata (parquet files untouched)")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip the DuckDB row-count cross-check")
    parser.add_argument("--cast-ns", action="store_true",
                        help="rewrite timestamp[ns] parquets to us on ingest "
                             "(not zero-copy); files above --max-cast-rows are skipped")
    parser.add_argument("--max-cast-rows", type=int, default=20_000_000,
                        help="largest ns parquet to cast-ingest (default 20M); "
                             "bigger files should be re-exported at us precision upstream")
    parser.add_argument("--batch-rows", type=int, default=1_000_000,
                        help="rows per append batch when writing to S3 (default 1M). "
                             "Raise (e.g. 20M) for big tables to cut the snapshot count.")
    args = parser.parse_args()

    targets = discover_targets(args.plant)
    if not targets:
        print("No parquet targets found. Nothing to register.")
        return 0

    print(f"Registering {len(targets)} bronze table(s) into the Iceberg catalog "
          f"(warehouse: {lake.get_catalog().properties.get('warehouse')})\n")

    results: List[Dict] = []
    for table_id, path in targets:
        rows_total = pq.read_metadata(path).num_rows
        row: Dict = {
            "table": table_id,
            "file": str(path.relative_to(PROJECT_ROOT)),
            "rows": rows_total,
        }
        try:
            lake.register_parquet(table_id, path, replace=args.replace, batch_rows=args.batch_rows)
            row["status"], row["mode"] = "ok", "add_files (zero-copy)"
        except lake.TableAlreadyRegisteredError:
            row["status"], row["mode"] = "skip", "already registered (use --replace to rebuild)"
        except lake.NanosecondTimestampError:
            if not args.cast_ns:
                row["status"], row["mode"] = "skip", "timestamp[ns] -> needs --cast-ns"
            elif rows_total > args.max_cast_rows:
                row["status"] = "skip"
                row["mode"] = (f"timestamp[ns], {rows_total:,} rows > --max-cast-rows "
                               "-> re-export at us precision upstream")
            else:
                try:
                    lake.register_parquet(table_id, path, replace=True, cast_ns_to_us=True,
                                          batch_rows=args.batch_rows)
                    row["status"], row["mode"] = "ok", "cast ns->us (rewrite)"
                except Exception as exc:
                    row["status"], row["mode"] = "fail", f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # one bad file must not abort the batch
            row["status"], row["mode"] = "fail", f"{type(exc).__name__}: {exc}"
        results.append(row)
        print(f"  [{row['status']:>4}] {table_id:<38} {row['rows']:>12,} rows  "
              f"{row['mode']}")

    if not args.no_verify:
        print("\nVerifying via DuckDB iceberg_scan (count parity vs parquet footer):")
        for row in results:
            if row["status"] != "ok":
                continue
            table_id = row["table"]
            path = PROJECT_ROOT / row["file"]
            ice_n = lake.scan_arrow(table_id, columns="count(*) AS n").to_pydict()["n"][0]
            pq_n = pq.read_metadata(path).num_rows
            ok = ice_n == pq_n
            print(f"  [{'ok' if ok else 'MISMATCH':>8}] {table_id:<40} "
                  f"iceberg={ice_n:,} parquet={pq_n:,}")
            row["verified"] = ok

    n_ok = sum(1 for r in results if r["status"] == "ok")
    n_skip = sum(1 for r in results if r["status"] == "skip")
    n_fail = sum(1 for r in results if r["status"] == "fail")
    print(f"\nDone. {n_ok} registered, {n_skip} skipped, {n_fail} failed.")
    if n_skip and not args.cast_ns:
        print("  (skipped tables have timestamp[ns] columns; re-run with --cast-ns "
              "to rewrite them to us, or re-export them at us precision upstream.)")
    if not args.no_verify:
        n_bad = sum(1 for r in results if r.get("verified") is False)
        if n_bad:
            print(f"WARNING: {n_bad} table(s) failed count verification.")
            return 1
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
