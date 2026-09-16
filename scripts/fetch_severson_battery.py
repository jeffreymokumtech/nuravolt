#!/usr/bin/env python3
"""Fetch Severson MIT-Stanford LFP battery cells from the HF open mirror.

Source: https://huggingface.co/datasets/bsebench-org/severson-2019 (CC BY 4.0).
This mirror takes the original three .mat batchdata files from data.matr.io,
applies the BSEBench TimeSeriesSchema, and re-publishes as one parquet per
cell. ~25 MB per cell, ~2.4 GB total for all 124 cells.

This script downloads a subset (default: 20 cells from batch 1, ~500 MB)
sufficient for validation. Use --all for the full set.

After fetching, run scripts/preprocess_severson_battery.py to extract
per-cycle discharge capacity → cells.parquet for the validation harness.

Usage:
    python scripts/fetch_severson_battery.py            # default: 20 cells
    python scripts/fetch_severson_battery.py --n=40     # more cells
    python scripts/fetch_severson_battery.py --all      # full 124 cells
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path
from urllib.error import URLError

HF_API_TREE = "https://huggingface.co/api/datasets/bsebench-org/severson-2019/tree/main"
HF_FILE_BASE = "https://huggingface.co/datasets/bsebench-org/severson-2019/resolve/main"
OUT_DIR = Path("backenddata/datasets/severson/raw")


def _list_cells() -> list[dict]:
    with urllib.request.urlopen(HF_API_TREE, timeout=30) as r:
        return json.loads(r.read())


def _download_cell(path: str, dest: Path) -> bool:
    url = f"{HF_FILE_BASE}/{path}"
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        dest.write_bytes(data)
        return True
    except URLError as e:
        print(f"  ✗ {path}: {e}")
        return False


def main() -> int:
    argv = sys.argv[1:]
    n = 20
    fetch_all = "--all" in argv
    for a in argv:
        if a.startswith("--n="):
            n = int(a.split("=", 1)[1])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Listing Severson cells on Hugging Face mirror...")
    tree = _list_cells()
    parquets = sorted(
        (f for f in tree if f.get("type") == "file" and f["path"].endswith(".parquet")),
        key=lambda f: f.get("size", 0),
    )
    print(f"  {len(parquets)} cells available")

    if not fetch_all:
        parquets = parquets[:n]
    print(f"  fetching {len(parquets)} cells ({sum(p.get('size', 0) for p in parquets) / 1e6:.0f} MB total)")

    downloaded = 0
    skipped = 0
    for i, p in enumerate(parquets, 1):
        path = p["path"]
        dest = OUT_DIR / path
        if dest.exists() and dest.stat().st_size == p.get("size"):
            skipped += 1
            continue
        size_mb = p.get("size", 0) / 1e6
        print(f"  [{i}/{len(parquets)}] {path} ({size_mb:.1f} MB)")
        if _download_cell(path, dest):
            downloaded += 1

    print(f"\nDone — downloaded {downloaded}, skipped {skipped}")
    print(f"Files in {OUT_DIR}")
    print(f"\nNext: python scripts/preprocess_severson_battery.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
