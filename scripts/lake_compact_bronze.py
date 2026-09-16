#!/usr/bin/env python3
"""Compact the bronze landing zone: one object per poll -> one object per connection-day.

The poller (``src/lib/services/s3-storage.ts`` ``ParquetLakeWriter``) writes ONE
Parquet object per poll run::

    s3://{LAKE_BUCKET}/bronze/live/{connection_id}/{YYYY-MM-DD}/{epoch_ms}.parquet

That is the right durability contract for a write path (a failed poll can never
corrupt a previous one) but it is the wrong read contract: at 15 minute polling
it is 96 objects per day per connection, so 50 connections over a year is ~1.75M
objects. Iceberg manifest planning and DuckDB scan planning both degrade badly
there, and S3 charges per request.

This script fixes it one layer down, without touching the writer: it rewrites
each connection-day into a single Parquet part::

    s3://{LAKE_BUCKET}/bronze/compact/live/dt={YYYY-MM-DD}/connection_id={id}/part-0.parquet

The Hive tokens are in the path AND carried as real ``dt`` / ``connection_id``
columns, so the file is self-describing: a reader that lost the path (a copy, a
download, ``pyarrow.parquet.read_schema``) still knows which day and connection
the rows belong to. DuckDB de-duplicates the two when a hive key matches a file
column, so a hive-partitioned scan sees each column once.

One caveat that follows from that choice: pyarrow's *dataset* API infers Hive
partitioning from parent directories and then refuses to merge its inferred
``dt`` with the file's own, so ``pq.read_table(<part>)`` raises. Read a part with
``pq.ParquetFile(part).read()`` (footer only, no inference) or pass
``partitioning=None``. The registration path already uses the footer-only reader.

Raw poll objects are kept for ``--retain-days`` (default 7) so a bad compaction
can be replayed from source, and are only deleted when ``--prune`` is passed AND
the compacted part for that connection-day exists.

Schema drift guard
------------------
``lake.register_parquet`` reads its Arrow schema from the FIRST file it is given.
If the writer schema ever drifts (a renamed column, a value column that becomes
DECIMAL) registration would silently mis-type the whole table. So every source
file batch is checked against the writer's fixed schema before anything is
written, and a drifting connection-day is skipped loudly rather than compacted.

Usage::

    python scripts/lake_compact_bronze.py --since 2            # yesterday + today
    python scripts/lake_compact_bronze.py --day 2026-07-20 --prune
    python scripts/lake_compact_bronze.py --connection <uuid> --dry-run
    python scripts/lake_compact_bronze.py --root /tmp/lake --since 1   # local tree
"""
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

DEFAULT_SRC_PREFIX = "bronze/live"
DEFAULT_DST_PREFIX = "bronze/compact/live"
DEFAULT_RETAIN_DAYS = 7

# The poller's Parquet schema is fixed (LAKE_PARQUET_SCHEMA in s3-storage.ts).
# Values are the DuckDB type families each column is allowed to have; anything
# else is drift and must not be compacted silently.
WRITER_COLUMNS: Dict[str, Tuple[str, ...]] = {
    "ts": ("TIMESTAMP", "TIMESTAMP_MS", "TIMESTAMP_S", "TIMESTAMP_NS", "TIMESTAMP WITH TIME ZONE"),
    "plant_ext_id": ("VARCHAR",),
    "device_ext_id": ("VARCHAR",),
    "device_type": ("VARCHAR",),
    "metric": ("VARCHAR",),
    "value": ("DOUBLE", "FLOAT"),
    "unit": ("VARCHAR",),
}

# Columns the compacted part adds on top of the writer schema.
PARTITION_COLUMNS = ("dt", "connection_id")


class SchemaDriftError(RuntimeError):
    """Raised when a bronze poll file no longer matches the writer's schema."""


# ---------------------------------------------------------------------------
# Object store abstraction — S3 in production, a plain directory tree in tests.
# ---------------------------------------------------------------------------


class Store:
    """Minimal list/exists/delete over either S3 or a local directory tree."""

    def uri(self, key: str) -> str:  # pragma: no cover - interface
        raise NotImplementedError

    def list_children(self, prefix: str) -> List[str]:  # pragma: no cover
        """Immediate child "directory" names under ``prefix`` (no trailing slash)."""
        raise NotImplementedError

    def list_keys(self, prefix: str) -> List[str]:  # pragma: no cover
        raise NotImplementedError

    def exists(self, key: str) -> bool:  # pragma: no cover
        raise NotImplementedError

    def delete(self, keys: Sequence[str]) -> int:  # pragma: no cover
        raise NotImplementedError


class S3Store(Store):
    def __init__(self, bucket: str, region: Optional[str] = None):
        import boto3

        self.bucket = bucket
        self.client = boto3.client("s3", region_name=region or os.environ.get("AWS_REGION", "eu-west-1"))

    def uri(self, key: str) -> str:
        return f"s3://{self.bucket}/{key}"

    def list_children(self, prefix: str) -> List[str]:
        prefix = prefix.rstrip("/") + "/"
        out: List[str] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            for cp in page.get("CommonPrefixes", []):
                out.append(cp["Prefix"][len(prefix):].rstrip("/"))
        return sorted(out)

    def list_keys(self, prefix: str) -> List[str]:
        prefix = prefix.rstrip("/") + "/"
        out: List[str] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                out.append(obj["Key"])
        return sorted(out)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    def delete(self, keys: Sequence[str]) -> int:
        deleted = 0
        for start in range(0, len(keys), 1000):
            batch = keys[start:start + 1000]
            self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True},
            )
            deleted += len(batch)
        return deleted


class LocalStore(Store):
    """A filesystem tree shaped exactly like the bucket. Used by the tests."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def uri(self, key: str) -> str:
        return str(self.root / key)

    def list_children(self, prefix: str) -> List[str]:
        base = self.root / prefix
        if not base.is_dir():
            return []
        return sorted(p.name for p in base.iterdir() if p.is_dir())

    def list_keys(self, prefix: str) -> List[str]:
        base = self.root / prefix
        if not base.exists():
            return []
        return sorted(
            str(p.relative_to(self.root)) for p in base.rglob("*") if p.is_file()
        )

    def exists(self, key: str) -> bool:
        return (self.root / key).exists()

    def delete(self, keys: Sequence[str]) -> int:
        deleted = 0
        for k in keys:
            p = self.root / k
            if p.exists():
                p.unlink()
                deleted += 1
        return deleted


# ---------------------------------------------------------------------------
# Compaction
# ---------------------------------------------------------------------------


@dataclass
class DayResult:
    connection_id: str
    day: str
    source_objects: int = 0
    rows: int = 0
    status: str = "ok"
    detail: str = ""
    pruned: int = 0


@dataclass
class CompactionReport:
    days: List[DayResult] = field(default_factory=list)

    @property
    def failed(self) -> int:
        return sum(1 for d in self.days if d.status == "fail")

    @property
    def compacted(self) -> int:
        return sum(1 for d in self.days if d.status == "ok")


def duckdb_connection(*, s3: bool):
    """A DuckDB connection able to read and write the lake."""
    import duckdb

    con = duckdb.connect()
    if s3:
        con.execute("INSTALL httpfs;")
        con.execute("LOAD httpfs;")
        region = os.environ.get("AWS_REGION", "eu-west-1")
        con.execute(
            "CREATE SECRET IF NOT EXISTS nuravolt_compact "
            f"(TYPE s3, PROVIDER credential_chain, REGION '{region}');"
        )
    return con


def assert_writer_schema(con, glob_uri: str) -> None:
    """Fail loudly if the poller's Parquet schema has drifted.

    ``register_parquet`` types the Iceberg table from the first file it sees, so
    an unnoticed drift would mis-type every later day. Checked per compaction
    batch, before anything is written.
    """
    described = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{glob_uri}', union_by_name = true)"
    ).fetchall()
    actual = {row[0]: str(row[1]).upper() for row in described}

    missing = sorted(set(WRITER_COLUMNS) - set(actual))
    unexpected = sorted(set(actual) - set(WRITER_COLUMNS))
    if missing or unexpected:
        raise SchemaDriftError(
            f"bronze writer schema drifted at {glob_uri}: "
            f"missing={missing or 'none'} unexpected={unexpected or 'none'}. "
            "Update WRITER_COLUMNS here and re-register bronze.live_readings "
            "deliberately; do not compact a schema nobody has looked at."
        )

    bad = [
        f"{col} is {actual[col]}, expected one of {list(allowed)}"
        for col, allowed in WRITER_COLUMNS.items()
        if not any(actual[col].startswith(a) for a in allowed)
    ]
    if bad:
        raise SchemaDriftError(
            f"bronze writer schema drifted at {glob_uri}: " + "; ".join(bad)
        )


def compact_key(dst_prefix: str, connection_id: str, day: str) -> str:
    return f"{dst_prefix}/dt={day}/connection_id={connection_id}/part-0.parquet"


def compact_connection_day(
    con,
    store: Store,
    connection_id: str,
    day: str,
    *,
    src_prefix: str = DEFAULT_SRC_PREFIX,
    dst_prefix: str = DEFAULT_DST_PREFIX,
    dry_run: bool = False,
) -> DayResult:
    """Rewrite one connection-day of poll objects into a single compacted part."""
    result = DayResult(connection_id=connection_id, day=day)

    src_dir = f"{src_prefix}/{connection_id}/{day}"
    source_keys = [k for k in store.list_keys(src_dir) if k.endswith(".parquet")]
    result.source_objects = len(source_keys)
    if not source_keys:
        result.status = "skip"
        result.detail = "no poll objects"
        return result

    glob_uri = store.uri(f"{src_dir}/*.parquet")
    try:
        assert_writer_schema(con, glob_uri)
    except SchemaDriftError as exc:
        result.status = "fail"
        result.detail = str(exc)
        return result

    dst_key = compact_key(dst_prefix, connection_id, day)
    dst_uri = store.uri(dst_key)

    # Column list is explicit and ordered so every compacted part shares one
    # schema regardless of which optional columns a given poll happened to emit.
    select_sql = f"""
        SELECT
            CAST(ts AS TIMESTAMP)            AS ts,
            CAST(plant_ext_id AS VARCHAR)    AS plant_ext_id,
            CAST(device_ext_id AS VARCHAR)   AS device_ext_id,
            CAST(device_type AS VARCHAR)     AS device_type,
            CAST(metric AS VARCHAR)          AS metric,
            CAST(value AS DOUBLE)            AS value,
            CAST(unit AS VARCHAR)            AS unit,
            DATE '{day}'                     AS dt,
            '{connection_id}'                AS connection_id
        FROM read_parquet('{glob_uri}', union_by_name = true)
        ORDER BY device_ext_id, metric, ts
    """
    result.rows = con.execute(
        f"SELECT count(*) FROM ({select_sql})"
    ).fetchone()[0]

    if dry_run:
        result.status = "dry-run"
        result.detail = f"would write {dst_uri}"
        return result

    if isinstance(store, LocalStore):
        (store.root / dst_key).parent.mkdir(parents=True, exist_ok=True)

    con.execute(
        f"COPY ({select_sql}) TO '{dst_uri}' "
        "(FORMAT parquet, COMPRESSION zstd, OVERWRITE_OR_IGNORE 1)"
    )
    result.detail = dst_uri
    return result


def prune_raw_day(
    store: Store,
    connection_id: str,
    day: str,
    *,
    src_prefix: str,
    dst_prefix: str,
    dry_run: bool,
) -> int:
    """Delete the raw poll objects for a day, but only once compaction landed."""
    if not store.exists(compact_key(dst_prefix, connection_id, day)):
        return 0
    keys = [
        k for k in store.list_keys(f"{src_prefix}/{connection_id}/{day}")
        if k.endswith(".parquet")
    ]
    if not keys or dry_run:
        return 0
    return store.delete(keys)


def _parse_day(value: str) -> str:
    return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")


def discover_connection_days(
    store: Store, src_prefix: str, connection_filter: Optional[str]
) -> List[Tuple[str, str]]:
    """Every (connection_id, day) pair present in the landing zone."""
    pairs: List[Tuple[str, str]] = []
    connections = (
        [connection_filter] if connection_filter else store.list_children(src_prefix)
    )
    for conn in connections:
        for day in store.list_children(f"{src_prefix}/{conn}"):
            try:
                _parse_day(day)
            except ValueError:
                continue  # not a YYYY-MM-DD partition; leave it alone
            pairs.append((conn, day))
    return sorted(pairs)


def run(
    store: Store,
    *,
    days: Optional[Iterable[str]] = None,
    connection_filter: Optional[str] = None,
    src_prefix: str = DEFAULT_SRC_PREFIX,
    dst_prefix: str = DEFAULT_DST_PREFIX,
    retain_days: int = DEFAULT_RETAIN_DAYS,
    prune: bool = False,
    dry_run: bool = False,
    today: Optional[date] = None,
) -> CompactionReport:
    """Compact (and optionally prune) the requested connection-days."""
    report = CompactionReport()
    wanted = set(days) if days else None
    pairs = [
        (conn, day)
        for conn, day in discover_connection_days(store, src_prefix, connection_filter)
        if wanted is None or day in wanted
    ]
    if not pairs:
        return report

    con = duckdb_connection(s3=isinstance(store, S3Store))
    try:
        cutoff = (today or datetime.now(timezone.utc).date()) - timedelta(days=retain_days)
        for conn, day in pairs:
            res = compact_connection_day(
                con, store, conn, day,
                src_prefix=src_prefix, dst_prefix=dst_prefix, dry_run=dry_run,
            )
            if prune and res.status in ("ok", "skip") and _parse_day(day) < cutoff.isoformat():
                res.pruned = prune_raw_day(
                    store, conn, day,
                    src_prefix=src_prefix, dst_prefix=dst_prefix, dry_run=dry_run,
                )
            report.days.append(res)
    finally:
        con.close()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--day", action="append", type=_parse_day,
                        help="compact this day only (YYYY-MM-DD); repeatable")
    parser.add_argument("--since", type=int,
                        help="compact the last N days including today")
    parser.add_argument("--connection", help="restrict to one connection id")
    parser.add_argument("--bucket", default=os.environ.get("LAKE_BUCKET", "nuravolt-lake"))
    parser.add_argument("--root", help="compact a local directory tree instead of S3 "
                                       "(the tree is shaped exactly like the bucket)")
    parser.add_argument("--src-prefix", default=DEFAULT_SRC_PREFIX)
    parser.add_argument("--dst-prefix", default=DEFAULT_DST_PREFIX)
    parser.add_argument("--retain-days", type=int, default=DEFAULT_RETAIN_DAYS,
                        help=f"keep raw poll objects this many days (default {DEFAULT_RETAIN_DAYS})")
    parser.add_argument("--prune", action="store_true",
                        help="delete raw poll objects older than --retain-days once "
                             "their compacted part exists")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    days: Optional[List[str]] = list(args.day) if args.day else None
    if args.since:
        today = datetime.now(timezone.utc).date()
        span = [(today - timedelta(days=i)).isoformat() for i in range(args.since)]
        days = sorted(set((days or []) + span))

    store: Store = LocalStore(Path(args.root)) if args.root else S3Store(args.bucket)
    scope = ", ".join(days) if days else "every day present"
    print(f"Compacting {args.src_prefix} -> {args.dst_prefix} ({scope})")

    report = run(
        store,
        days=days,
        connection_filter=args.connection,
        src_prefix=args.src_prefix,
        dst_prefix=args.dst_prefix,
        retain_days=args.retain_days,
        prune=args.prune,
        dry_run=args.dry_run,
    )

    if not report.days:
        print("Nothing to compact.")
        return 0

    for res in report.days:
        line = (f"  [{res.status:>7}] {res.connection_id[:12]:<12} {res.day}  "
                f"{res.source_objects:>4} objects -> {res.rows:>9,} rows")
        if res.pruned:
            line += f"  (pruned {res.pruned} raw)"
        print(line)
        if res.status == "fail":
            print(f"           {res.detail}")

    print(f"\nDone. {report.compacted} compacted, {report.failed} failed.")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
