"""Adapter: Sandia PVPMC single-axis tracker fault dataset (2023).

Source: Sandia National Labs PVPMC, hosted on DuraMAT Datahub
(https://datahub.duramat.org/dataset/time-series-from-emulated-pv-single-axis-tracker-faults-data-and-resources)
License: CC0.

The dataset is a time series of emulated tracker faults from a 2-string × 6-
module Canadian Solar CS3U-355PB-AG SAT system in Albuquerque NM,
2023-06-13 to 2023-11-25. Fault types include tracker_stuck, misalign,
backtracking_error.

DuraMAT serves the dataset via a JS-rendered SPA, so direct curl fetch
isn't possible. Manual fetch:

    1. Visit https://datahub.duramat.org/dataset/time-series-from-emulated-pv-single-axis-tracker-faults-data-and-resources
    2. Click each resource link to download the CSV / parquet bundle
    3. Place files under ``backenddata/datasets/sandia_sat/``

Once present, this adapter loads them and maps the Sandia fault labels to
our cascade taxonomy (tracker_stuck → tracker_stuck, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import polars as pl


SANDIA_SAT_DIR = Path("backenddata/datasets/sandia_sat")

# Sandia SAT fault classes per the dataset README → our taxonomy.
# These are placeholders pending the actual CSV column structure.
SANDIA_CLASS_TO_UNIFIED = {
    "no_fault": "normal",
    "tracker_stuck": "tracker_stuck",
    "tracker_misalign": "tracker_misaligned",
    "tracker_backtracking_error": "tracker_misaligned",
}


@dataclass
class SandiaSatSplit:
    signals: pl.DataFrame
    labels: pl.Series
    label_names: pl.Series
    n_rows: int


def load_sandia_sat(
    data_dir: Path = SANDIA_SAT_DIR,
    sample_n: int | None = None,
    seed: int = 42,
) -> SandiaSatSplit:
    """Load Sandia SAT fault CSVs from ``data_dir``.

    Raises ``FileNotFoundError`` with fetch instructions if the directory
    is empty.
    """
    csvs = sorted(data_dir.glob("*.csv")) if data_dir.exists() else []
    if not csvs:
        raise FileNotFoundError(
            f"Sandia SAT CSVs not found in {data_dir}.\n"
            f"  Manual fetch:\n"
            f"  1. Visit https://datahub.duramat.org/dataset/"
            f"time-series-from-emulated-pv-single-axis-tracker-faults-data-and-resources\n"
            f"  2. Download the resource files\n"
            f"  3. Place CSVs under {data_dir}/"
        )

    frames = [pl.read_csv(c) for c in csvs]
    df = pl.concat(frames, how="diagonal_relaxed")

    if sample_n is not None and sample_n < len(df):
        df = df.sample(n=sample_n, seed=seed)

    # Sandia uses a "fault_class" or similar column — column-name fallback chain.
    label_col = next((c for c in ("fault_class", "fault_type", "label") if c in df.columns), None)
    if label_col is None:
        raise ValueError(
            f"No fault label column found in Sandia SAT CSVs (looked for "
            f"fault_class/fault_type/label). Columns present: {df.columns}"
        )

    labels = df[label_col]
    label_names = labels.cast(pl.Utf8).map_elements(
        lambda c: SANDIA_CLASS_TO_UNIFIED.get(str(c), "unknown"),
        return_dtype=pl.Utf8,
    )
    return SandiaSatSplit(signals=df, labels=labels, label_names=label_names, n_rows=len(df))
