"""Adapter: Lazzaretti / UTFPR PV Fault Dataset → cascade-aligned classification.

Source: ``backenddata/datasets/lazzaretti/lazzaretti_faults.parquet`` (CC BY 4.0,
1.37M rows, 5 classes: normal / short_circuit / degradation / open_circuit /
partial_shading). Raw signals are in SI units (W/m², V, A).

The adapter:
1. Loads the parquet.
2. Optionally splits temporally (default last 20% as held-out).
3. Returns (signals_df, ground_truth_label_series) for the chosen split.

The downstream caller applies the row-level classifier (mirrors the same
thresholds used in ``nuravolt/fault/rule_based.py``) and compares predictions
to ground truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Tuple

import polars as pl


LAZZARETTI_CLASS_NAMES = {
    0: "normal",
    1: "short_circuit",
    2: "degradation",
    3: "open_circuit",
    4: "partial_shading",
}

LAZZARETTI_CLASS_TO_FAULT_TYPE = {
    "normal": None,
    "short_circuit": "string_short_circuit",
    "degradation": "string_degradation",
    "open_circuit": "string_open_circuit",
    "partial_shading": "partial_shading",
}


@dataclass
class LazzarettiSplit:
    """A train/test split of the Lazzaretti dataset (signals + labels)."""

    signals: pl.DataFrame  # poa_irradiance, module_temp, string_voltage_{1,2}, string_current_{1,2}
    labels: pl.Series      # fault_class int 0-4
    label_names: pl.Series # human-readable: "normal", "short_circuit", ...
    n_rows: int


def load_lazzaretti(
    parquet_path: Path = Path("backenddata/datasets/lazzaretti/lazzaretti_faults.parquet"),
    split: Literal["train", "test", "all"] = "test",
    test_fraction: float = 0.20,
    daylight_only: bool = True,
    daylight_irradiance_threshold: float = 200.0,
    sample_n: int | None = None,
    seed: int = 42,
) -> LazzarettiSplit:
    """Load Lazzaretti with optional held-out split.

    Args:
        parquet_path: where the dataset lives
        split: "train" → first (1-test_fraction), "test" → last test_fraction,
            "all" → everything (no split)
        test_fraction: fraction of rows reserved for test split (held out from
            the tail, not random — preserves temporal order if it exists)
        daylight_only: drop rows below ``daylight_irradiance_threshold`` W/m²
            (matches the convention in ``rule_based._filter_daylight_only``).
            Highly recommended — Class 0 is dominated by night data which is
            not what we want to validate against.
        daylight_irradiance_threshold: W/m² floor for "daylight"
        sample_n: if set, return a random sample of this size (after split &
            daylight filter). Useful for fast iteration.
        seed: RNG seed for sampling

    Returns:
        LazzarettiSplit with aligned signals, labels, label names.
    """
    if not parquet_path.exists():
        raise FileNotFoundError(
            f"Lazzaretti parquet not found at {parquet_path}. "
            f"Run: python backenddata/datasets/labeled/download_lazzaretti.py"
        )

    df = pl.read_parquet(parquet_path)

    if daylight_only:
        df = df.filter(pl.col("poa_irradiance") > daylight_irradiance_threshold)

    # Temporal split — the parquet is class-stratified (all normal first,
    # then all short, etc.) so we shuffle deterministically before splitting
    # to avoid a trivial degenerate test set.
    df = df.with_row_index("_idx").sample(fraction=1.0, seed=seed, shuffle=True)
    n = len(df)

    if split == "all":
        chosen = df
    else:
        n_test = int(n * test_fraction)
        if split == "test":
            chosen = df.tail(n_test)
        else:  # train
            chosen = df.head(n - n_test)

    if sample_n is not None and sample_n < len(chosen):
        chosen = chosen.sample(n=sample_n, seed=seed)

    chosen = chosen.drop("_idx")
    labels = chosen["fault_class"]
    label_names = labels.cast(pl.Int64).map_elements(
        lambda c: LAZZARETTI_CLASS_NAMES.get(int(c), "unknown"),
        return_dtype=pl.Utf8,
    )

    signals = chosen.drop("fault_class")
    return LazzarettiSplit(
        signals=signals,
        labels=labels,
        label_names=label_names,
        n_rows=len(chosen),
    )
