"""GPVS-Faults CSV adapter (cross-dataset PV validation).

Source: Bakdi et al. 2020, Mendeley dataset `n76t439f65` (CC BY 4.0).
On disk: ``backenddata/datasets/gpvs_faults/CSV_Files/F[0-7][LM].csv``
where L = IPPT mode, M = MPPT mode. Filename letter = fault class.

Schema (per the dataset README):
    Time, Ipv, Vpv, Vdc, ia, ib, ic, va, vb, vc, Iabc, If, Vabc, Vf

  - Ipv, Vpv: PV array current / voltage (system-level, NOT per-string)
  - Vdc: DC bus voltage
  - ia/b/c, va/b/c: three-phase AC currents / voltages
  - Iabc, Vabc: AC magnitudes
  - If, Vf: frequencies

This differs from Lazzaretti's per-string feature shape. So this adapter
maps GPVS fault classes (F0-F7) to OUR cascade taxonomy where possible,
and exposes 3-phase derived features the row classifier can score against.

Fault class mapping (from the Bakdi paper):
    F0 → normal
    F1 → string_short_circuit   (PV array fault type 1 — short circuit pattern)
    F2 → string_open_circuit    (PV array fault type 2 — open circuit pattern)
    F3 → inverter_overtemperature (inverter fault — heat sink stress)
    F4 → dc_link_capacitor_aging  (inverter fault — DC link aging)
    F5 → grid_voltage_sag         (grid anomaly — voltage sag)
    F6 → grid_voltage_swell       (grid anomaly — voltage swell)
    F7 → irradiance_sensor_drift  (sensor / MPPT controller fault)

For row classification we expose 3-phase derived features:
    ac_current_imbalance = std(ia,ib,ic) / mean(ia,ib,ic)
    ac_voltage_imbalance = std(va,vb,vc) / mean(va,vb,vc)
    dc_ratio = Vpv / Vdc
    pv_power = Ipv * Vpv
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

import numpy as np
import polars as pl


GPVS_ROOT = Path("backenddata/datasets/gpvs_faults/CSV_Files")

GPVS_CLASS_TO_FAULT = {
    "F0": "normal",
    "F1": "string_short_circuit",
    "F2": "string_open_circuit",
    "F3": "inverter_overtemperature",
    "F4": "dc_link_capacitor_aging",
    "F5": "grid_voltage_sag",
    "F6": "grid_voltage_swell",
    "F7": "irradiance_sensor_drift",
}

# Classes we'll actually score against (the full taxonomy is wide; this is the
# subset that overlaps with what our rule classifier can plausibly detect)
GPVS_SCORED_CLASSES = list(set(GPVS_CLASS_TO_FAULT.values()))


@dataclass
class GpvsSplit:
    signals: pl.DataFrame
    labels: pl.Series          # fault class label e.g. "F0", "F1"
    fault_types: pl.Series     # mapped to our taxonomy
    mode: pl.Series            # "MPPT" or "IPPT"
    n_rows: int


def _engineer_features(df: pl.DataFrame) -> pl.DataFrame:
    """Add 3-phase imbalance + DC ratio + pv_power derived columns."""
    # Coefficient of variation across the 3 AC phases (absolute values)
    return df.with_columns([
        pl.concat_list([
            pl.col("ia").abs(), pl.col("ib").abs(), pl.col("ic").abs(),
        ]).alias("_iabc_list"),
        pl.concat_list([
            pl.col("va").abs(), pl.col("vb").abs(), pl.col("vc").abs(),
        ]).alias("_vabc_list"),
    ]).with_columns([
        (pl.col("_iabc_list").list.std() / (pl.col("_iabc_list").list.mean() + 1e-6)).alias("ac_current_imbalance"),
        (pl.col("_vabc_list").list.std() / (pl.col("_vabc_list").list.mean() + 1e-6)).alias("ac_voltage_imbalance"),
        (pl.col("Vpv") / (pl.col("Vdc").abs() + 1e-6)).alias("dc_ratio"),
        (pl.col("Ipv") * pl.col("Vpv")).alias("pv_power"),
    ]).drop(["_iabc_list", "_vabc_list"])


def load_gpvs(
    csv_dir: Path = GPVS_ROOT,
    sample_n_per_class: int | None = 5000,
    mode: str | None = None,
    seed: int = 42,
) -> GpvsSplit:
    """Load every GPVS CSV under ``csv_dir`` (F0L, F0M, F1L, ..., F7M).

    Args:
        csv_dir: where the CSVs live
        sample_n_per_class: optional cap per (class, mode) file to keep total
            row count manageable. Default 5000 → 16 files × 5K = ~80K rows.
            Set to None for full ~493M file → ~5M rows post-load (slow).
        mode: 'MPPT', 'IPPT', or None for both. Files named *M.csv = MPPT,
            *L.csv = IPPT.

    Returns a GpvsSplit with engineered features and ground-truth fault labels.
    """
    if not csv_dir.exists():
        raise FileNotFoundError(
            f"GPVS-Faults CSVs not found at {csv_dir}.\n"
            f"  Manual fetch: download from https://data.mendeley.com/datasets/n76t439f65/1\n"
            f"  unzip CSV_Files.zip to backenddata/datasets/gpvs_faults/"
        )

    files = sorted(csv_dir.glob("F[0-7][LM].csv"))
    if mode == "MPPT":
        files = [f for f in files if f.stem.endswith("M")]
    elif mode == "IPPT":
        files = [f for f in files if f.stem.endswith("L")]
    if not files:
        raise FileNotFoundError(f"No F*.csv files in {csv_dir}")

    rng = np.random.default_rng(seed)
    chunks = []
    for fp in files:
        class_letter = fp.stem[:2]   # F0, F1, ...
        mode_letter = fp.stem[-1]    # M or L
        mode_name = "MPPT" if mode_letter == "M" else "IPPT"
        # GPVS CSVs have int-looking values early in some columns followed by
        # floats — bump schema inference to avoid mis-detection.
        df = pl.read_csv(fp, infer_schema_length=10000)
        if sample_n_per_class and len(df) > sample_n_per_class:
            # Stratified sample within this file
            idx = rng.choice(len(df), size=sample_n_per_class, replace=False)
            df = df[sorted(idx.tolist())]
        df = df.with_columns([
            pl.lit(class_letter).alias("_gpvs_class"),
            pl.lit(mode_name).alias("_gpvs_mode"),
        ])
        chunks.append(df)

    combined = pl.concat(chunks, how="diagonal_relaxed")
    combined = _engineer_features(combined)

    labels = combined["_gpvs_class"]
    fault_types = labels.map_elements(
        lambda c: GPVS_CLASS_TO_FAULT.get(str(c), "unknown"),
        return_dtype=pl.Utf8,
    )
    modes = combined["_gpvs_mode"]

    return GpvsSplit(
        signals=combined,
        labels=labels,
        fault_types=fault_types,
        mode=modes,
        n_rows=len(combined),
    )
