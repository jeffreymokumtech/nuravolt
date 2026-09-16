#!/usr/bin/env python3
"""Preprocess NASA PCoE battery .mat files → parquet for the validation harness.

Source: NASA Prognostics Center of Excellence "Battery Data Set"
(https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip).

The dataset ships as one .mat file per battery, each containing a list of
cycle records (charge / discharge / impedance). For RUL validation we only
need the per-cycle discharge capacity series + the EOL cycle, defined as
the first cycle where capacity drops below 1.4Ah (NASA's 70%-of-2.0Ah-rated
convention).

This script walks every .mat under ``backenddata/datasets/nasa_pcoe/5. Battery Data Set/``
(any sub-zip already extracted), extracts the capacity-vs-cycle series for
each battery, and writes:

    backenddata/datasets/nasa_pcoe/batteries.parquet

with columns: battery_id (str), eol_cycle (int), capacity_over_cycles (list[f64]).

Usage:
    python scripts/preprocess_nasa_pcoe.py
"""

from __future__ import annotations

from pathlib import Path
import sys

import polars as pl

REPO_ROOT = Path(__file__).resolve().parents[1]
NASA_ROOT = REPO_ROOT / "backenddata" / "datasets" / "nasa_pcoe"
NASA_DATA = NASA_ROOT / "5. Battery Data Set"
OUT_PARQUET = NASA_ROOT / "batteries.parquet"

# NASA EOL convention: 30% capacity loss → 1.4Ah for 2.0Ah-rated cells
EOL_THRESHOLD_AH = 1.4


def _extract_zips_if_needed() -> None:
    """Unzip any sub-archives that haven't been expanded yet."""
    import zipfile

    if not NASA_DATA.exists():
        print(f"  NASA root not found: {NASA_DATA}")
        return

    for z in NASA_DATA.glob("*.zip"):
        out_dir = z.with_suffix("")
        if not out_dir.exists() or not any(out_dir.glob("*.mat")):
            # Use an "extracted_" prefix to match what the curl step produced
            out_dir = NASA_DATA / f"extracted_{z.stem.split('. ')[-1]}"
            if out_dir.exists() and any(out_dir.glob("*.mat")):
                continue
            print(f"  Unzipping {z.name} → {out_dir.name}")
            out_dir.mkdir(exist_ok=True)
            with zipfile.ZipFile(z) as zf:
                zf.extractall(out_dir)


def _extract_capacity_series(mat_path: Path) -> tuple[list[float], int]:
    """Read one .mat, return (capacity_per_discharge_cycle, eol_cycle).

    EOL = index of first discharge cycle where capacity drops below
    ``EOL_THRESHOLD_AH``. If the battery never crosses the threshold,
    returns the total cycle count (right-censored).
    """
    from scipy.io import loadmat

    mat = loadmat(str(mat_path), simplify_cells=True)
    # Top-level key is the battery name (e.g. 'B0005')
    top = next((k for k in mat if not k.startswith("__")), None)
    if top is None:
        return [], 0
    cycles = mat[top]["cycle"]

    caps = []
    for c in cycles:
        if c.get("type") != "discharge":
            continue
        data = c.get("data", {})
        if "Capacity" not in data:
            continue
        try:
            caps.append(float(data["Capacity"]))
        except (TypeError, ValueError):
            continue

    if not caps:
        return [], 0

    eol = next((i for i, c in enumerate(caps) if c < EOL_THRESHOLD_AH), len(caps))
    return caps, eol


def main() -> int:
    _extract_zips_if_needed()

    mat_files = sorted(NASA_DATA.rglob("B*.mat"))
    if not mat_files:
        print(f"No B*.mat files found under {NASA_DATA}")
        print("Run scripts/fetch_nasa_pcoe.py first (or download manually).")
        return 1

    rows = []
    for mp in mat_files:
        battery_id = mp.stem  # B0005, B0006, ...
        caps, eol = _extract_capacity_series(mp)
        if not caps:
            print(f"  ⚠  {battery_id}: no discharge capacity data")
            continue
        rows.append({
            "battery_id": battery_id,
            "eol_cycle": eol,
            "capacity_over_cycles": caps,
            "initial_capacity": caps[0],
            "final_capacity": caps[-1],
            "n_cycles": len(caps),
        })
        print(
            f"  ✓ {battery_id}: {len(caps)} discharge cycles, "
            f"init {caps[0]:.2f}Ah → final {caps[-1]:.2f}Ah, EOL cycle {eol}"
        )

    if not rows:
        print("Nothing to write.")
        return 1

    df = pl.DataFrame(rows)
    df.write_parquet(OUT_PARQUET)
    print(f"\nWrote {len(df)} batteries to {OUT_PARQUET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
