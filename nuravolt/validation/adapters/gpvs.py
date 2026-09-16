"""Adapter: GPVS-Faults dataset → cascade-aligned classification.

Source: https://data.mendeley.com/datasets/n76t439f65/1 (CC BY 4.0).

GPVS-Faults is 16 .mat files (8 fault classes × 2 modes: MPPT + IPPT), each
at 100 kHz. The downloader at ``backenddata/datasets/labeled/download_gpvs_faults.py``
handles the .mat → parquet conversion (with 1000× downsampling to 100 Hz)
once the .mat files are present on disk.

Mendeley's web UI does not expose direct .mat download URLs without a browser
session. To populate the dataset:

    1. Visit https://data.mendeley.com/datasets/n76t439f65/1
    2. Click "Download" → ZIP (~600MB)
    3. Extract .mat files into ``backenddata/datasets/gpvs_faults/``
    4. Run: ``python backenddata/datasets/labeled/download_gpvs_faults.py``

The combined parquet then lives at
``backenddata/datasets/gpvs_faults/parquet/gpvs_faults_combined.parquet``.

Fault-class mapping (GPVS → our taxonomy):
    F0 → normal
    F1, F2 → string_short_circuit (array faults are dominated by short-circuit
            patterns in this dataset per the original paper)
    F3, F4 → inverter_overtemperature (inverter faults map to the closest
            production fault we detect — overtemp manifests with similar
            current/voltage signatures)
    F5, F6 → grid_voltage_sag (grid anomalies — voltage events)
    F7    → irradiance_sensor_drift (sensor / MPPT controller fault)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

import polars as pl


GPVS_PARQUET_DEFAULT = Path("backenddata/datasets/gpvs_faults/parquet/gpvs_faults_combined.parquet")

GPVS_CLASS_TO_UNIFIED = {
    0: "normal",
    1: "string_short_circuit",  # PV array fault type 1
    2: "string_short_circuit",  # PV array fault type 2 (also array-side)
    3: "inverter_overtemperature",  # Inverter fault type 1 (closest production fault)
    4: "inverter_overtemperature",  # Inverter fault type 2
    5: "grid_voltage_sag",          # Grid anomaly type 1
    6: "grid_voltage_sag",          # Grid anomaly type 2
    7: "irradiance_sensor_drift",   # Sensor / MPPT controller
}

GPVS_UNIFIED_CLASSES = sorted(set(GPVS_CLASS_TO_UNIFIED.values()))


@dataclass
class GpvsSplit:
    signals: pl.DataFrame
    labels: pl.Series        # int 0-7
    label_names: pl.Series   # human-readable unified class
    n_rows: int


def load_gpvs(
    parquet_path: Path = GPVS_PARQUET_DEFAULT,
    sample_n: int | None = None,
    seed: int = 42,
) -> GpvsSplit:
    """Load the GPVS-Faults combined parquet (post-conversion).

    Raises ``FileNotFoundError`` with manual-fetch instructions if the
    parquet doesn't exist — the dataset requires a one-time Mendeley
    download outside this script.
    """
    if not parquet_path.exists():
        raise FileNotFoundError(
            f"GPVS-Faults parquet not found at {parquet_path}.\n"
            f"  1. Download ZIP from https://data.mendeley.com/datasets/n76t439f65/1\n"
            f"  2. Extract .mat files to backenddata/datasets/gpvs_faults/\n"
            f"  3. Run: python backenddata/datasets/labeled/download_gpvs_faults.py"
        )
    df = pl.read_parquet(parquet_path)

    if sample_n is not None and sample_n < len(df):
        df = df.sample(n=sample_n, seed=seed)

    labels = df["fault_class"]
    label_names = labels.cast(pl.Int64).map_elements(
        lambda c: GPVS_CLASS_TO_UNIFIED.get(int(c), "unknown"),
        return_dtype=pl.Utf8,
    )
    return GpvsSplit(signals=df, labels=labels, label_names=label_names, n_rows=len(df))
