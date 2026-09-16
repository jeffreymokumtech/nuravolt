#!/usr/bin/env python3
"""Register the compacted bronze layers as daily-partitioned Iceberg tables.

``scripts/lake_register_bronze.py`` registers the hand-curated parquet stage: one
table per file, rebuilt wholesale. That shape does not fit the live landing zone,
which grows one partition per day forever. This module is the spec-driven
counterpart: a table is described once (identifier + S3 prefix + partition
column), and each night's run appends only the new day.

Two tables are described here:

  ``bronze.live_readings``   the compacted poller output written by
                             ``scripts/lake_compact_bronze.py``, at
                             ``bronze/compact/live/dt={D}/connection_id={C}/part-0.parquet``
  ``bronze.dim_device_map``  the vendor-id resolution snapshot written by
                             ``nuravolt.lake.export_dim``, at
                             ``bronze/dim/device_map/dt={D}/part-0.parquet``

Idempotency is by partition, not by file: before appending a day the table is
probed for rows already carrying that ``dt``, and a day that is already present
is skipped unless ``--replace-day`` is passed. Appending blind would silently
double a day's rows, and a doubled megawatt-hour is a wrong number, not a slow
query.

DuckDB writes ``timestamp[ns]`` happily and Iceberg is microsecond-precision, so
every append passes ``cast_ns_to_us=True``.

Usage::

    python -m nuravolt.lake.register --table bronze.live_readings --since 2
    python -m nuravolt.lake.register --table bronze.dim_device_map --day 2026-07-20
    python -m nuravolt.lake.register --all --since 2 --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt import lake  # noqa: E402


@dataclass(frozen=True)
class BronzeSpec:
    """How one bronze table maps onto daily partitions in the bucket."""

    table_id: str
    prefix: str
    partition_col: str = "dt"
    #: how deep the parts sit below ``dt={D}/`` (1 = ``dt=D/x=y/part.parquet``)
    sub_levels: int = 0
    description: str = ""

    def day_prefix(self, day: str) -> str:
        return f"{self.prefix}/{self.partition_col}={day}"


LIVE_READINGS = BronzeSpec(
    table_id="bronze.live_readings",
    prefix="bronze/compact/live",
    sub_levels=1,  # connection_id={id}/
    description="Compacted poller output, long format (ts, plant_ext_id, device_ext_id, metric, value).",
)

DEVICE_MAP = BronzeSpec(
    table_id="bronze.dim_device_map",
    prefix="bronze/dim/device_map",
    sub_levels=0,
    description="Daily snapshot resolving vendor plant/device ids to plants and BESS assets.",
)

SPECS: Dict[str, BronzeSpec] = {s.table_id: s for s in (LIVE_READINGS, DEVICE_MAP)}


@dataclass
class RegisterOutcome:
    table_id: str
    day: str
    status: str  # ok | skip | fail | dry-run
    detail: str = ""
    rows: int = 0
    parts: int = 0


# ---------------------------------------------------------------------------
# Partition probing
# ---------------------------------------------------------------------------


def partition_present(table_id: str, partition_col: str, day: str) -> bool:
    """True if the table already holds rows for ``day``.

    Uses the Iceberg metadata scan (manifest + column stats pruned) rather than a
    full DuckDB count, so probing a year-old table stays cheap.
    """
    try:
        table = lake.get_catalog().load_table(table_id)
    except Exception:
        return False
    try:
        scan = table.scan(row_filter=f"{partition_col} = '{day}'", limit=1)
        return scan.to_arrow().num_rows > 0
    except Exception:
        # A filter the catalog cannot push down must not be read as "absent" —
        # that would double the day. Fall back to the DuckDB read path.
        found = lake.scan_arrow(
            table_id,
            columns="count(*) AS n",
            where=f"{partition_col} = DATE '{day}'",
        ).to_pydict()["n"][0]
        return bool(found)


def delete_partition(table_id: str, partition_col: str, day: str) -> None:
    """Drop one day from the table so it can be re-appended."""
    table = lake.get_catalog().load_table(table_id)
    table.delete(delete_filter=f"{partition_col} = '{day}'")


# ---------------------------------------------------------------------------
# Part discovery
# ---------------------------------------------------------------------------


def list_parts(spec: BronzeSpec, day: str, *, bucket: str, root: Optional[str] = None) -> List[str]:
    """Every parquet part belonging to one day, as URIs or local paths."""
    if root:
        base = Path(root) / spec.day_prefix(day)
        if not base.is_dir():
            return []
        return sorted(str(p) for p in base.rglob("*.parquet"))

    import boto3

    client = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "eu-west-1"))
    prefix = spec.day_prefix(day) + "/"
    keys: List[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".parquet"):
                keys.append(f"s3://{bucket}/{obj['Key']}")
    return sorted(keys)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register_day(
    table_id: str,
    parts: Sequence[str] | str,
    *,
    day: str,
    partition_col: str = "dt",
    replace_day: bool = False,
    dry_run: bool = False,
) -> RegisterOutcome:
    """Append one day's parts to ``table_id``, skipping a day already present."""
    if isinstance(parts, str):
        parts = [parts]
    parts = list(parts)
    outcome = RegisterOutcome(table_id=table_id, day=day, status="ok", parts=len(parts))

    if not parts:
        outcome.status = "skip"
        outcome.detail = "no parts for this day"
        return outcome

    already = partition_present(table_id, partition_col, day)
    if already and not replace_day:
        outcome.status = "skip"
        outcome.detail = f"{partition_col}={day} already registered (pass --replace-day to rebuild)"
        return outcome

    if dry_run:
        outcome.status = "dry-run"
        outcome.detail = (
            f"would {'replace' if already else 'append'} {len(parts)} part(s) "
            f"for {partition_col}={day}"
        )
        return outcome

    try:
        if already:
            delete_partition(table_id, partition_col, day)
        outcome.rows = lake.register_parquet(
            table_id, parts, append=True, cast_ns_to_us=True
        )
        outcome.detail = f"{outcome.rows:,} rows from {len(parts)} part(s)"
    except Exception as exc:  # one bad day must not abort the batch
        outcome.status = "fail"
        outcome.detail = f"{type(exc).__name__}: {exc}"
    return outcome


def register_days(
    spec: BronzeSpec,
    days: Iterable[str],
    *,
    bucket: str,
    root: Optional[str] = None,
    replace_day: bool = False,
    dry_run: bool = False,
) -> List[RegisterOutcome]:
    outcomes: List[RegisterOutcome] = []
    for day in days:
        parts = list_parts(spec, day, bucket=bucket, root=root)
        outcomes.append(
            register_day(
                spec.table_id,
                parts,
                day=day,
                partition_col=spec.partition_col,
                replace_day=replace_day,
                dry_run=dry_run,
            )
        )
    return outcomes


def _parse_day(value: str) -> str:
    return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", action="append", choices=sorted(SPECS),
                        help="table to register; repeatable (default: all)")
    parser.add_argument("--all", action="store_true", help="register every known table")
    parser.add_argument("--day", action="append", type=_parse_day,
                        help="day to register (YYYY-MM-DD); repeatable")
    parser.add_argument("--since", type=int, default=1,
                        help="register the last N days including today (default 1)")
    parser.add_argument("--bucket", default=os.environ.get("LAKE_BUCKET", "nuravolt-lake"))
    parser.add_argument("--root", help="read parts from a local directory tree instead of S3")
    parser.add_argument("--replace-day", action="store_true",
                        help="delete and re-append a day that is already registered")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    tables = args.table or (sorted(SPECS) if args.all else sorted(SPECS))
    days = list(args.day) if args.day else None
    if not days:
        today = datetime.now(timezone.utc).date()
        days = sorted((today - timedelta(days=i)).isoformat() for i in range(max(args.since, 1)))

    warehouse = lake.get_catalog().properties.get("warehouse")
    print(f"Registering {', '.join(tables)} for {', '.join(days)} (warehouse: {warehouse})")

    failures = 0
    for table_id in tables:
        spec = SPECS[table_id]
        for outcome in register_days(
            spec, days,
            bucket=args.bucket, root=args.root,
            replace_day=args.replace_day, dry_run=args.dry_run,
        ):
            print(f"  [{outcome.status:>7}] {outcome.table_id:<26} {outcome.day}  "
                  f"{outcome.detail}")
            if outcome.status == "fail":
                failures += 1

    print(f"\nDone. {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
