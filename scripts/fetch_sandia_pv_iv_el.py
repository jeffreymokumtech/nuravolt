#!/usr/bin/env python3
"""Fetch the Sandia PV-IV-EL dataset (metadata + IV curves, ~28 MB).

Source: DOE OpenEI, dataset 8378 (Photovoltaic Module Current-Voltage and
Electroluminescence Image Data, last modified May 2025).

Why this matters: 613 sets of corresponding IV-curve flash test data for
438 unique PV modules measured at 0-5 years of outdoor exposure. This is
**actual time-trend degradation data** — exactly what Lazzaretti can't give
us (Lazzaretti's "degradation" class is a snapshot of a series resistor,
not a fade-over-years trajectory).

This script downloads:
  - AnonDB.csv (metadata index — module IDs, exposure year, technology)
  - AnonDB_descriptions.xlsx (column descriptions)
  - IV.zip (per-module IV-curve files)
  - RefIV.zip (reference IV measurements)

Skipped (17 GB, out of scope for now):
  - EL.zip (electroluminescence images — for CV branch)

Usage:
    python scripts/fetch_sandia_pv_iv_el.py
"""

from __future__ import annotations

import sys
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "backenddata" / "datasets" / "sandia_pv_iv_el"

FILES = [
    ("AnonDB.csv", "https://data.openei.org/files/8378/AnonDB.csv"),
    ("AnonDB_descriptions.xlsx", "https://data.openei.org/files/8378/AnonDB_descriptions.xlsx"),
    ("IV.zip", "https://data.openei.org/files/8378/IV.zip"),
    ("RefIV.zip", "https://data.openei.org/files/8378/RefIV.zip"),
]


def _download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  ⇢ {dest.name} already on disk ({dest.stat().st_size // 1024} KB)")
        return True
    print(f"  ↓ {dest.name} from {url}")
    try:
        urllib.request.urlretrieve(url, dest)
        print(f"    ✓ {dest.stat().st_size // 1024} KB downloaded")
        return True
    except Exception as e:
        print(f"    ✗ {type(e).__name__}: {e}")
        return False


def _unzip_if_needed(zip_path: Path) -> None:
    extract_dir = zip_path.parent / zip_path.stem
    if extract_dir.exists() and any(extract_dir.iterdir()):
        return
    extract_dir.mkdir(parents=True, exist_ok=True)
    print(f"  unzipping {zip_path.name} → {extract_dir.name}/")
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extract_dir)
    n = sum(1 for _ in extract_dir.rglob("*"))
    print(f"    {n} files extracted")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Fetching Sandia PV-IV-EL dataset → {OUT_DIR}/")

    ok = True
    for fname, url in FILES:
        if not _download(url, OUT_DIR / fname):
            ok = False

    print("\nExtracting archives...")
    for zip_name in ("IV.zip", "RefIV.zip"):
        zp = OUT_DIR / zip_name
        if zp.exists():
            _unzip_if_needed(zp)

    print("\nDone." if ok else "\nDone with errors.")
    print(f"  Sample contents:")
    for child in sorted(OUT_DIR.iterdir())[:10]:
        sz = child.stat().st_size if child.is_file() else sum(f.stat().st_size for f in child.rglob("*") if f.is_file())
        print(f"    {sz // 1024:>7} KB  {child.name}{'/' if child.is_dir() else ''}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
