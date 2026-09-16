"""Adapter: Severson / Toyota Research / MIT-Stanford battery cycle-life dataset.

Source: data.matr.io project 5c48dd2bc625d700019f3204 (Apache 2.0).

124 commercial A123 LFP cells cycled to failure under fast-charging in a
30°C convection chamber, cycle lives 150-2300. Each cell publishes:
  - capacity_in_cycle: per-cycle discharge capacity (Ah)
  - cycle_count: cumulative cycle count
  - first_cycle_features: voltage/temperature/IR trajectories for prediction

data.matr.io is a JS-rendered SPA — there is no curlable URL pattern for the
individual .mat or .pkl files. The fetch is one-time and manual:

    1. Visit https://data.matr.io/1/projects/5c48dd2bc625d700019f3204
    2. Download the three batches: 2017-05-12_batchdata_updated_struct.mat,
       2017-06-30_batchdata_updated_struct.mat,
       2018-04-12_batchdata_updated_struct.mat
    3. Place .mat files in ``backenddata/datasets/severson/``
    4. Convert via the MIT-Stanford preprocessing notebook
       (https://github.com/petermattia/revisit-severson-et-al has a working one)
       producing one row per cell with capacity-vs-cycle as a list column.

This adapter expects a final parquet at ``backenddata/datasets/severson/cells.parquet``
with columns:
    cell_id (str), eol_cycle (int), capacity_over_cycles (list[float]),
    avg_temp_c (float), c_rate (float)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

import polars as pl


SEVERSON_PARQUET = Path("backenddata/datasets/severson/cells.parquet")


@dataclass
class SeversonCell:
    cell_id: str
    eol_cycle: int                          # ground-truth cycle to failure (capacity < 80% rated)
    capacity_over_cycles: List[float]       # discharge capacity per cycle (Ah)
    avg_temp_c: float                       # average cycling temperature
    c_rate: float                           # average C-rate


def load_severson(parquet_path: Path = SEVERSON_PARQUET) -> List[SeversonCell]:
    """Load Severson cells. Raises ``FileNotFoundError`` if the parquet is
    absent, with detailed manual-fetch instructions."""
    if not parquet_path.exists():
        raise FileNotFoundError(
            f"Severson cells parquet not found at {parquet_path}.\n"
            f"  Manual fetch:\n"
            f"  1. Visit https://data.matr.io/1/projects/5c48dd2bc625d700019f3204\n"
            f"  2. Download the three batchdata .mat files\n"
            f"  3. Place .mat files in backenddata/datasets/severson/\n"
            f"  4. Run preprocessing — see e.g. github.com/petermattia/revisit-severson-et-al\n"
            f"     to produce {parquet_path.name} with one row per cell"
        )
    df = pl.read_parquet(parquet_path)
    cells = []
    for row in df.iter_rows(named=True):
        cells.append(SeversonCell(
            cell_id=str(row["cell_id"]),
            eol_cycle=int(row["eol_cycle"]),
            capacity_over_cycles=list(row["capacity_over_cycles"]),
            avg_temp_c=float(row["avg_temp_c"]),
            c_rate=float(row["c_rate"]),
        ))
    return cells
