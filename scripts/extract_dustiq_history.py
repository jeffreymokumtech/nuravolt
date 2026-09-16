#!/usr/bin/env python3
"""
Extract DustIQ sensor history from plant parquet files.

This script reads the DustIQ optical sensor columns from the parquet data
and generates daily aggregated soiling ratio measurements.

Usage:
    python scripts/extract_dustiq_history.py --plant-id eta
    python scripts/extract_dustiq_history.py --plant-id ribera
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import polars as pl
import yaml


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def extract_dustiq_data(plant_id: str, config: dict) -> dict:
    """Extract DustIQ sensor data from parquet file."""
    source_path = Path(config['data']['source_path'])
    if not source_path.exists():
        raise FileNotFoundError(f"Data file not found: {source_path}")

    print(f"Loading data from {source_path}")

    # Use lazy scan
    lf = pl.scan_parquet(source_path)
    all_columns = lf.collect_schema().names()

    # Find timestamp column
    timestamp_col = config['data']['timestamp_column']

    # Find DustIQ columns (case-insensitive search)
    dustiq_cols = []
    for col in all_columns:
        col_lower = col.lower()
        if ('dustiq' in col_lower or 'dust_iq' in col_lower) and \
           ('soiling' in col_lower or 'sensor' in col_lower):
            dustiq_cols.append(col)

    if not dustiq_cols:
        raise ValueError(f"No DustIQ columns found in {source_path}")

    print(f"Found {len(dustiq_cols)} DustIQ columns:")
    for col in dustiq_cols:
        print(f"  - {col}")

    # Select timestamp + DustIQ columns
    needed_cols = [timestamp_col] + dustiq_cols
    lf = lf.select(needed_cols)

    # Parse timestamp if needed
    timestamp_format = config['data'].get('timestamp_format')
    if timestamp_format:
        lf = lf.with_columns(
            pl.col(timestamp_col).str.strptime(pl.Datetime, format=timestamp_format)
        )

    # Collect data
    df = lf.collect()
    print(f"Loaded {len(df):,} rows")

    # Convert to pandas for easier date handling
    df_pd = df.to_pandas()

    # Extract date
    df_pd['date'] = df_pd[timestamp_col].dt.date

    # Identify sensor columns - prefer soiling_ratio columns over soiling_loss
    sensor1_cols = [c for c in dustiq_cols if 'soiling_ratio' in c.lower() and ('sensor' in c.lower() or 'sensor1' in c.lower() or 'sensor01' in c.lower()) and ('1' in c or '01' in c)]
    sensor2_cols = [c for c in dustiq_cols if 'soiling_ratio' in c.lower() and ('sensor' in c.lower() or 'sensor2' in c.lower() or 'sensor02' in c.lower()) and ('2' in c or '02' in c)]

    # If no soiling_ratio columns found, try soiling_loss columns
    if not sensor1_cols:
        sensor1_cols = [c for c in dustiq_cols if 'sensor' in c.lower() and ('1' in c or '01' in c)]
    if not sensor2_cols:
        sensor2_cols = [c for c in dustiq_cols if 'sensor' in c.lower() and ('2' in c or '02' in c)]

    # Group by date and calculate daily average
    daily_data = []

    for date, group in df_pd.groupby('date'):
        # Get sensor values (convert from % to ratio if needed)
        sensor1_vals = []
        sensor2_vals = []

        for col in sensor1_cols:
            vals = group[col].dropna()
            if len(vals) > 0:
                # Check if values are in percentage (>1) and convert to ratio
                if vals.max() > 1.5:
                    vals = vals / 100.0
                # Filter out unreasonable values (SR should be 0-1.2)
                vals = vals[(vals >= 0) & (vals <= 1.2)]
                if len(vals) > 0:
                    sensor1_vals.extend(vals.tolist())

        for col in sensor2_cols:
            vals = group[col].dropna()
            if len(vals) > 0:
                # Check if values are in percentage (>1) and convert to ratio
                if vals.max() > 1.5:
                    vals = vals / 100.0
                # Filter out unreasonable values (SR should be 0-1.2)
                vals = vals[(vals >= 0) & (vals <= 1.2)]
                if len(vals) > 0:
                    sensor2_vals.extend(vals.tolist())

        # Calculate daily averages
        sr_sensor1 = sum(sensor1_vals) / len(sensor1_vals) if sensor1_vals else None
        sr_sensor2 = sum(sensor2_vals) / len(sensor2_vals) if sensor2_vals else None

        # Average of both sensors
        if sr_sensor1 is not None and sr_sensor2 is not None:
            sr_dustiq = (sr_sensor1 + sr_sensor2) / 2.0
        elif sr_sensor1 is not None:
            sr_dustiq = sr_sensor1
        elif sr_sensor2 is not None:
            sr_dustiq = sr_sensor2
        else:
            continue

        daily_data.append({
            "date": str(date),
            "sr_dustiq": round(sr_dustiq, 6),
            "sr_sensor1": round(sr_sensor1, 6) if sr_sensor1 is not None else None,
            "sr_sensor2": round(sr_sensor2, 6) if sr_sensor2 is not None else None,
        })

    # Sort by date
    daily_data.sort(key=lambda x: x['date'])

    # Build metadata
    metadata = {
        "plant_id": plant_id,
        "source": "DustIQ Direct Sensor",
        "sensors": [
            f"DustIQ.01 Sensor 1",
            f"DustIQ.01 Sensor 2"
        ],
        "period": {
            "start": daily_data[0]['date'] if daily_data else None,
            "end": daily_data[-1]['date'] if daily_data else None,
        },
        "generated_at": datetime.now().isoformat(),
        "description": "Direct soiling ratio measurement from DustIQ optical sensor"
    }

    return {
        "metadata": metadata,
        "daily_data": daily_data
    }


def main():
    parser = argparse.ArgumentParser(description="Extract DustIQ sensor history from parquet data")
    parser.add_argument("--plant-id", required=True, help="Plant ID (e.g., eta, ribera)")
    args = parser.parse_args()

    plant_id = args.plant_id

    print(f"\n{'='*60}")
    print(f"EXTRACTING DUSTIQ DATA FOR {plant_id.upper()}")
    print(f"{'='*60}\n")

    # Load plant config
    config = load_plant_config(plant_id)

    # Extract DustIQ data
    dustiq_data = extract_dustiq_data(plant_id, config)

    # Save output
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "dustiq_history.json"
    with open(output_path, 'w') as f:
        json.dump(dustiq_data, f, indent=2)

    print(f"\n✅ DustIQ history saved to: {output_path}")
    print(f"\nSummary:")
    print(f"  Total days: {len(dustiq_data['daily_data'])}")
    print(f"  Period: {dustiq_data['metadata']['period']['start']} to {dustiq_data['metadata']['period']['end']}")

    # Calculate some stats
    sr_values = [d['sr_dustiq'] for d in dustiq_data['daily_data']]
    if sr_values:
        print(f"  Mean SR: {sum(sr_values)/len(sr_values):.4f}")
        print(f"  Min SR: {min(sr_values):.4f}")
        print(f"  Max SR: {max(sr_values):.4f}")


if __name__ == "__main__":
    main()
