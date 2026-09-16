#!/usr/bin/env python3
"""Sync raw source parquet/data into the S3 bronze layer as plain objects.

Some source data can't become Iceberg tables faithfully — the wide SCADA parquets
carry non-UTF8 (mojibake) column names, and the public reference datasets have
heterogeneous schemas. Those still belong in the lake, so we land them as raw
objects under ``s3://$LAKE_BUCKET/bronze/<prefix>/`` (DuckDB reads them directly;
the silver layer unpivots SCADA from here). Tidy long-format data (twins, pr_daily)
goes through ``scripts/lake_register_bronze.py`` into Glue instead.

Idempotent: skips any object already present in S3 with a matching byte size, so it
resumes cleanly. Multipart + concurrent uploads via the boto3 transfer manager.

Usage (creds via AWS_PROFILE=shamsiq or AWS_ACCESS_KEY_ID/SECRET in env):
    LAKE_BUCKET=nuravolt-lake AWS_REGION=eu-west-1 \
        python scripts/lake_sync_raw.py
    python scripts/lake_sync_raw.py --only scada        # one source dir
    python scripts/lake_sync_raw.py --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.exceptions import ClientError

PROJECT_ROOT = Path(__file__).parent.parent

# local source dir -> S3 prefix under bronze/
SOURCES = {
    "scada": ("backenddata/scada", "bronze/scada"),       # wide, mojibake column names
    "datasets": ("backenddata/datasets", "bronze/public"),  # public reference datasets
    "weather": ("backenddata/weather", "bronze/weather"),
}

_transfer = TransferConfig(
    multipart_threshold=64 * 1024 * 1024,
    multipart_chunksize=32 * 1024 * 1024,
    max_concurrency=8,
    use_threads=True,
)

_lock = threading.Lock()


def _human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}"
        n /= 1024


def _already_uploaded(s3, bucket: str, key: str, size: int) -> bool:
    try:
        return s3.head_object(Bucket=bucket, Key=key)["ContentLength"] == size
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", choices=list(SOURCES), help="sync just one source dir")
    ap.add_argument("--dry-run", action="store_true", help="list what would upload, do nothing")
    ap.add_argument("--workers", type=int, default=4, help="parallel file uploads (default 4)")
    args = ap.parse_args()

    bucket = os.environ.get("LAKE_BUCKET", "nuravolt-lake")
    region = os.environ.get("AWS_REGION", "eu-west-1")
    s3 = boto3.client("s3", region_name=region)

    sources = {args.only: SOURCES[args.only]} if args.only else SOURCES

    # Enumerate candidates from the filesystem only (fast). The S3 existence check
    # runs INSIDE each worker — doing it as a sequential pre-scan would serialize
    # thousands of head_object round-trips before any upload starts.
    candidates = []
    for name, (local_rel, prefix) in sources.items():
        root = PROJECT_ROOT / local_rel
        if not root.exists():
            print(f"  (skip {name}: {local_rel} not found)")
            continue
        for f in sorted(root.rglob("*")):
            if f.is_file() and not f.name.startswith("."):
                key = f"{prefix}/{f.relative_to(root).as_posix()}"
                candidates.append((f, key, f.stat().st_size))

    total_bytes = sum(s for _, _, s in candidates)
    print(f"{len(candidates)} candidate files, {_human(total_bytes)} total — "
          f"checking + uploading with {args.workers} workers "
          f"(skips objects already in S3 with matching size).")
    if args.dry_run:
        for f, key, size in candidates[:30]:
            print(f"  candidate  s3://{bucket}/{key}  ({_human(size)})")
        if len(candidates) > 30:
            print(f"  ... +{len(candidates) - 30} more")
        return 0
    if not candidates:
        print("No source files found.")
        return 0

    c = {"up": 0, "up_b": 0, "skip": 0, "skip_b": 0}

    def handle(item):
        f, key, size = item
        if _already_uploaded(s3, bucket, key, size):
            with _lock:
                c["skip"] += 1
                c["skip_b"] += size
            return
        s3.upload_file(str(f), bucket, key, Config=_transfer)
        with _lock:
            c["up"] += 1
            c["up_b"] += size
            if c["up"] % 25 == 0:
                print(f"  uploaded {c['up']} files, {_human(c['up_b'])} / {_human(total_bytes)}")

    failures = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(handle, it): it for it in candidates}
        for fut in as_completed(futs):
            try:
                fut.result()
            except Exception as exc:  # noqa: BLE001
                _, key, _ = futs[fut]
                failures.append((key, str(exc)))
                print(f"  FAILED {key}: {exc}")

    print(f"\nDone. uploaded {c['up']} ({_human(c['up_b'])}), "
          f"skipped {c['skip']} already-present ({_human(c['skip_b'])}), {len(failures)} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
