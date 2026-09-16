#!/usr/bin/env python3
"""Preprocess Severson per-cell parquets → cells.parquet for validation.

Reads each cell's per-timestep parquet (under backenddata/datasets/severson/raw/),
extracts per-cycle discharge capacity (max of capacity_Ah during the
'discharge' step), and writes one row per cell with the trajectory.

Severson EOL convention: 80% of nominal 1.1 Ah = 0.88 Ah.

Usage:
    python scripts/preprocess_severson_battery.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import polars as pl

REPO_ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = REPO_ROOT / "backenddata" / "datasets" / "severson" / "raw"
OUT_PARQUET = REPO_ROOT / "backenddata" / "datasets" / "severson" / "cells.parquet"

NOMINAL_AH = 1.1
EOL_THRESHOLD_AH = 0.88   # 80% of 1.1 Ah


def _per_cycle_capacity(cell_df: pl.DataFrame) -> list[float]:
    """Per-cycle discharge capacity (max capacity_Ah within discharge step)."""
    discharge = cell_df.filter(pl.col("step_id") == "discharge")
    if discharge.is_empty():
        return []
    # Polars: group by cycle, take max capacity
    by_cycle = (
        discharge.group_by("cycle_number")
        .agg(pl.col("capacity_Ah").max().alias("Qd"))
        .sort("cycle_number")
    )
    return [float(v) for v in by_cycle["Qd"].to_list()]


def main() -> int:
    if not RAW_DIR.exists() or not any(RAW_DIR.glob("*.parquet")):
        print(f"No raw cell parquets in {RAW_DIR}")
        print("Run: python scripts/fetch_severson_battery.py")
        return 1

    parquets = sorted(RAW_DIR.glob("*.parquet"))
    print(f"Preprocessing {len(parquets)} Severson cells...")

    rows = []
    for fp in parquets:
        cell_id = fp.stem
        try:
            df = pl.read_parquet(fp)
        except Exception as e:
            print(f"  ✗ {cell_id}: {e}")
            continue
        caps = _per_cycle_capacity(df)
        if not caps:
            print(f"  ⚠ {cell_id}: no discharge cycles found")
            continue
        # EOL = first cycle below 0.88 Ah
        eol = next((i for i, c in enumerate(caps) if c < EOL_THRESHOLD_AH), len(caps))
        rows.append({
            "cell_id": cell_id,
            "eol_cycle": eol,
            "capacity_over_cycles": caps,
            "avg_temp_c": float(df["temperature_C"].mean() or 30.0),
            "c_rate": float(df["current_A"].abs().mean()) / NOMINAL_AH if "current_A" in df.columns else 1.0,
            "initial_capacity": caps[0],
            "n_cycles": len(caps),
        })
        print(
            f"  ✓ {cell_id}: {len(caps)} cycles, "
            f"init {caps[0]:.3f}Ah → final {caps[-1]:.3f}Ah, EOL cycle {eol}"
        )

    if not rows:
        print("Nothing to write.")
        return 1

    df = pl.DataFrame(rows)
    OUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(OUT_PARQUET)
    print(f"\nWrote {len(df)} cells to {OUT_PARQUET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
