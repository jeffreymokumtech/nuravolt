"""Adapter: NASA Ames PCoE Battery Aging Dataset.

Source: NASA Prognostics Center of Excellence repository.

4 batteries (B0005, B0006, B0007, B0018) cycled to EOL under controlled
conditions. Each provides:
  - capacity per cycle (Ah)
  - internal resistance (Ohm) per cycle
  - temperature curves per cycle

The PCoE repository serves these as .mat files behind an HTML index page
(no direct stable download URL). Manual fetch:

    1. Visit https://www.nasa.gov/intelligent-systems-division/discovery-and-systems-health/pcoe/pcoe-data-set-repository/
    2. Locate "Battery Data Set"
    3. Download the ZIP
    4. Extract .mat files to ``backenddata/datasets/nasa_pcoe/``

Then run a preprocessing step (similar to BatteryML's NASA loader) to
produce ``backenddata/datasets/nasa_pcoe/batteries.parquet`` with one row
per battery.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

import polars as pl


NASA_PCOE_PARQUET = Path("backenddata/datasets/nasa_pcoe/batteries.parquet")


@dataclass
class NasaPcoeBattery:
    battery_id: str
    capacity_over_cycles: List[float]
    eol_cycle: int
    initial_capacity: float


# Cells that start below the EOL threshold (≈1.4 Ah for 2.0 Ah rated) are
# experiments with already-degraded cells, partial-discharge regimes, or
# extreme conditions — RUL extrapolation from "early cycles" is undefined
# when there's no fade trajectory to fit, so we drop them.
MIN_INITIAL_CAPACITY_AH = 1.5
MIN_FADE_FRACTION = 0.05   # cell must have lost ≥5% capacity over the run


def load_nasa_pcoe(
    parquet_path: Path = NASA_PCOE_PARQUET,
    well_formed_only: bool = True,
) -> List[NasaPcoeBattery]:
    """Load NASA PCoE battery cells.

    Args:
        parquet_path: produced by scripts/preprocess_nasa_pcoe.py
        well_formed_only: drop cells that started below EOL threshold or
            never faded — these don't have a usable EOL trajectory for
            extrapolation-based RUL validation
    """
    if not parquet_path.exists():
        raise FileNotFoundError(
            f"NASA PCoE batteries parquet not found at {parquet_path}.\n"
            f"  Auto-fetch:\n"
            f"  1. curl -L -o backenddata/datasets/nasa_pcoe/battery_data.zip \\\n"
            f"       'https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip'\n"
            f"  2. cd backenddata/datasets/nasa_pcoe && unzip battery_data.zip\n"
            f"  3. python scripts/preprocess_nasa_pcoe.py"
        )
    df = pl.read_parquet(parquet_path)
    # Some batteries appear in multiple sub-zips; keep the row with the most cycles.
    df = df.with_columns(pl.col("capacity_over_cycles").list.len().alias("_n"))
    df = df.sort("_n", descending=True).unique(subset=["battery_id"], keep="first").drop("_n")

    cells = []
    for row in df.iter_rows(named=True):
        caps = list(row["capacity_over_cycles"])
        if not caps:
            continue
        initial = float(caps[0])
        fade = (initial - min(caps)) / initial if initial > 0 else 0
        if well_formed_only and (initial < MIN_INITIAL_CAPACITY_AH or fade < MIN_FADE_FRACTION):
            continue
        cells.append(NasaPcoeBattery(
            battery_id=str(row["battery_id"]),
            capacity_over_cycles=caps,
            eol_cycle=int(row["eol_cycle"]),
            initial_capacity=initial,
        ))
    return cells
