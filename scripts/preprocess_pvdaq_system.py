#!/usr/bin/env python3
"""Resolve a PVDAQ system's per-metric columns to canonical-named tables.

PVDAQ ships data in several layouts:
  - **Wide format** (system_2107, system_7334_5min): one big parquet per year,
    columns named like ``inv_01_ac_power_inv_149583`` or
    ``sos-01-001-inv1-phza-a__175583`` — the trailing integer is the metric_id.
  - **Long format** (system_34): one parquet per day, schema {measured_on,
    metric_id, value}.
  - **Per-metric files** (system_9069): one parquet per (equipment, metric).

This script handles the wide-format case (systems 2107 and 7334), which is
where the metadata JSON catalog applies cleanest. Long-format / per-metric
preprocessing is a follow-on if/when we need those systems.

The output is a wide parquet per source file with columns renamed to
canonical field types (irradiance_poa, ac_power_plant, dc_voltage_plant, ...).
When multiple columns map to the same canonical type (e.g. 24 inverter
AC-power channels), they get aggregated (sum for power/energy, mean for
voltage/temp/irradiance) and the per-inverter columns are dropped.
Optionally keeps per-equipment columns if ``--keep-per-equipment`` is set.

Usage:
    python scripts/preprocess_pvdaq_system.py 2107
    python scripts/preprocess_pvdaq_system.py 7334
    python scripts/preprocess_pvdaq_system.py 2107 --keep-per-equipment
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import polars as pl

from nuravolt.validation.adapters.pvdaq_channels import (
    SYSTEM_METADATA_PATHS,
    SystemChannelCatalog,
    load_system_catalog,
)


# How to aggregate when N columns share a canonical field type at the plant level
AGG_METHOD = {
    "power_ac": "sum",
    "power_dc": "sum",
    "energy_daily": "sum",
    "energy_total": "sum",
}

# Per-system data folder + (regex to extract metric_id from column name)
# System 2107 + 9069 split data across electrical/environment/irradiance/meter parquets
# — we glob all of them and merge on measured_on.
SYSTEM_CONFIG = {
    2107: {
        "data_dir": "system_2107/data",
        "glob": "2107_*.parquet",
        "metric_id_re": re.compile(r"_(\d{5,})$"),     # ..._inv_149579 → 149579
    },
    7334: {
        # Column names: 'sos-01-001-inv1-phza-a__175583'. The metric_id suffix
        # (175583) DOES NOT match the catalog's metric_ids — the catalog uses
        # different IDs for the same sensor. So we strip the __<digits>$ tail
        # and match by sensor_name prefix instead.
        "data_dir": "system_7334_5min/data",
        "glob": "7333_5_min_*.parquet",
        "metric_id_re": re.compile(r"__(\d{4,})$"),    # used to strip the suffix
        "match_by": "sensor_name",                     # special handling below
    },
    9069: {
        # System 9069 ships thousands of per-string parquets plus a handful of
        # aggregate files (irradiance/meter/environment). For rdtools soiling
        # we only need the aggregates — they carry plant-level POA, AC power,
        # ambient temp. Per-string files (with spaces / dots in the middle of
        # the name) are excluded by the more specific glob.
        "data_dir": "system_9069/data",
        "glob": "9069_*_data.parquet",
        "metric_id_re": re.compile(r"_(\d{5,})$"),
    },
}


def _extract_metric_id(col: str, regex: re.Pattern) -> Optional[int]:
    m = regex.search(col)
    return int(m.group(1)) if m else None


def _rename_and_aggregate(
    df: pl.DataFrame,
    catalog: SystemChannelCatalog,
    metric_id_re: re.Pattern,
    keep_per_equipment: bool,
) -> pl.DataFrame:
    """Rename columns to canonical field types + aggregate when N→1."""
    timestamp_col = next(
        (c for c in ("measured_on", "utc_measured_on", "timestamp") if c in df.columns),
        None,
    )
    if timestamp_col is None:
        raise ValueError(f"No timestamp column in {df.columns[:5]}...")

    # Map each non-timestamp column → canonical field type. Two strategies:
    #  - by metric_id (default): regex extracts the integer suffix, look it up
    #  - by sensor_name (system 7334): strip the __<digits>$ tail, match the
    #    prefix to catalog sensor_names (case-insensitive)
    match_by = getattr(_rename_and_aggregate, "_match_by_override", "metric_id")
    if match_by == "sensor_name":
        sn_to_entry = {e.sensor_name.lower(): e for e in catalog.entries if e.sensor_name}

    col_to_field: Dict[str, str] = {}
    col_to_equipment: Dict[str, Optional[str]] = {}
    for c in df.columns:
        if c == timestamp_col:
            continue
        if match_by == "sensor_name":
            # Strip __<digits>$ and match by sensor_name prefix
            prefix = metric_id_re.sub("", c).lower()
            entry = sn_to_entry.get(prefix)
        else:
            metric_id = _extract_metric_id(c, metric_id_re)
            if metric_id is None:
                continue
            entry = catalog.by_metric_id.get(metric_id)
        if entry is None or not entry.is_mappable:
            continue
        col_to_field[c] = entry.field_type
        col_to_equipment[c] = entry.equipment_id

    # Group columns by field type
    by_field: Dict[str, List[str]] = {}
    for c, ft in col_to_field.items():
        by_field.setdefault(ft, []).append(c)

    # Build the aggregated frame. Cast any string-typed columns to float
    # (some channels are null-only and polars picks String dtype, which
    # breaks sum_horizontal/mean_horizontal).
    result = df.select(pl.col(timestamp_col).alias("measured_on"))
    for field_type, cols in by_field.items():
        method = AGG_METHOD.get(field_type, "mean")
        # Coerce all chosen columns to Float64
        casted = df.select([
            pl.col(c).cast(pl.Float64, strict=False).alias(c) for c in cols
        ])
        if len(cols) == 1:
            result = result.with_columns(casted[cols[0]].alias(field_type))
        else:
            agg = (casted.sum_horizontal() if method == "sum"
                   else casted.mean_horizontal()).alias(field_type)
            result = result.with_columns(agg)

        if keep_per_equipment:
            for c in cols:
                eq = col_to_equipment.get(c)
                if eq:
                    result = result.with_columns(casted[c].alias(f"{field_type}__{eq}"))

    return result.sort("measured_on")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("system_id", type=int, choices=list(SYSTEM_CONFIG.keys()))
    parser.add_argument("--keep-per-equipment", action="store_true",
                        help="Also write per-inverter columns (default: aggregate only)")
    parser.add_argument("--max-files", type=int, default=None)
    args = parser.parse_args()

    sid = args.system_id
    cfg = SYSTEM_CONFIG[sid]

    pvdaq_root = REPO_ROOT / "backenddata" / "datasets" / "pvdaq"
    data_dir = pvdaq_root / cfg["data_dir"]
    if not data_dir.exists():
        print(f"Missing data folder: {data_dir}")
        return 1

    # System 7334's data is actually system 7333 in the metadata
    catalog_sid = 7333 if sid == 7334 else sid
    metadata_path = SYSTEM_METADATA_PATHS.get(catalog_sid)
    if metadata_path is None or not metadata_path.exists():
        print(f"No metadata catalog for system {catalog_sid}. Aborting.")
        return 1

    print(f"Loading catalog for system {catalog_sid}...")
    catalog = load_system_catalog(metadata_path)
    print(f"  {catalog.total_entries} channels, {catalog.mappable_entries} mappable")
    for ft, es in sorted(catalog.by_field_type.items(), key=lambda x: -len(x[1])):
        if ft != "unmapped":
            print(f"    {len(es):>5} {ft}")

    # Plumb the per-system match strategy through to the renamer via a
    # function attribute (avoids restructuring the signature for one knob).
    _rename_and_aggregate._match_by_override = cfg.get("match_by", "metric_id")

    files = sorted(data_dir.glob(cfg["glob"]))
    if args.max_files:
        files = files[: args.max_files]
    if not files:
        print(f"No files matching {cfg['glob']} in {data_dir}")
        return 1
    print(f"\nProcessing {len(files)} source files: {[f.name for f in files[:5]]}{'...' if len(files) > 5 else ''}")

    out_dir = data_dir.parent / "cleaned"
    out_dir.mkdir(exist_ok=True)

    t0 = time.time()
    written = 0
    for fp in files:
        out_path = out_dir / fp.name.replace(".parquet", "_cleaned.parquet")
        if out_path.exists():
            print(f"  ⇢ {fp.name} → cleaned exists, skipping")
            continue
        try:
            df = pl.read_parquet(fp)
            cleaned = _rename_and_aggregate(df, catalog, cfg["metric_id_re"], args.keep_per_equipment)
            cleaned.write_parquet(out_path)
            written += 1
            print(f"  ✓ {fp.name} → {out_path.name}: {len(cleaned):,} rows, {len(cleaned.columns)} cols")
        except Exception as e:
            print(f"  ✗ {fp.name}: {type(e).__name__}: {e}")

    elapsed = time.time() - t0
    print(f"\nWrote {written} cleaned parquets in {elapsed:.1f}s")
    print(f"Output: {out_dir}/")

    if written > 0:
        sample = sorted(out_dir.glob("*_cleaned.parquet"))[-1]
        df_sample = pl.read_parquet(sample)
        print(f"\nSample schema ({sample.name}): {df_sample.columns}")
        print(f"  rows: {len(df_sample):,}, time range: {df_sample['measured_on'].min()} → {df_sample['measured_on'].max()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
