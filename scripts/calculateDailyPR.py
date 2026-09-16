#!/usr/bin/env python3
"""
Calculate daily Performance Ratio (PR) per inverter from parquet data.

PR = (Actual Energy Output / Theoretical Maximum)
   = (Normalized Power kW/kWp) / (Irradiance W/m² / 1000)

When irradiance is 1000 W/m², a perfect system would output 1 kW/kWp (PR=100%)

Usage:
    python scripts/calculateDailyPR.py --plant-id alpha1
    python scripts/calculateDailyPR.py --plant-id eta
    python scripts/calculateDailyPR.py --plant-id ribera
"""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

import pandas as pd
import yaml


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def extract_inverter_id(col_name: str, plant_name: str = None) -> str:
    """Extract inverter ID from column name.

    Handles various patterns:
    - "Alpha (ES): INV 01.001 / ..."
    - "INV 01.001"
    - "INV_01_001"
    """
    # Try common patterns
    patterns = [
        r'INV[_\s]+\d+[._]\d+',  # INV 01.001 or INV_01_001
        r'INV\d+',               # INV01
        r'Inverter\s*\d+',       # Inverter 01
    ]

    for pattern in patterns:
        match = re.search(pattern, col_name, re.IGNORECASE)
        if match:
            return match.group(0)

    # Fallback: return column name
    return col_name


def calculate_daily_pr(plant_id: str, min_irradiance: int = 100):
    """Calculate daily PR for all inverters.

    Args:
        plant_id: Plant identifier
        min_irradiance: Minimum irradiance threshold in W/m² (default: 100)
    """
    print(f"\n{'='*60}")
    print(f"CALCULATING DAILY PR FOR {plant_id.upper()}")
    print(f"{'='*60}\n")

    # Load plant config
    print("Loading plant configuration...")
    config = load_plant_config(plant_id)

    # Get paths and column names from config
    parquet_file = Path(config['data']['source_path'])
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_file = output_dir / 'pr_daily.parquet'
    output_file_json = Path(f"public/data/soiling/{plant_id}/time_series") / 'daily_pr.json'

    # Get column mappings
    timestamp_col = config['data']['timestamp_column']
    timestamp_format = config['data'].get('timestamp_format')

    # Get irradiance column
    irrad_col = config['data']['columns'].get('irradiance')
    if not irrad_col:
        raise ValueError(f"Irradiance column not defined in config for {plant_id}")

    print(f"Data file: {parquet_file}")
    print(f"Irradiance column: {irrad_col}")
    print(f"Min irradiance threshold: {min_irradiance} W/m²")

    # Load data
    print("\nLoading parquet file...")
    df = pd.read_parquet(parquet_file)
    print(f"Loaded {len(df):,} rows")

    # Parse timestamp
    if timestamp_format:
        df['timestamp'] = pd.to_datetime(df[timestamp_col], format=timestamp_format)
    else:
        df['timestamp'] = pd.to_datetime(df[timestamp_col])

    df['date'] = df['timestamp'].dt.date.astype(str)

    # Check if irradiance column exists
    if irrad_col not in df.columns:
        # Try case-insensitive search
        matching_cols = [col for col in df.columns if irrad_col.lower() in col.lower()]
        if matching_cols:
            irrad_col = matching_cols[0]
            print(f"⚠️  Using matched column: {irrad_col}")
        else:
            raise ValueError(f"Irradiance column '{irrad_col}' not found in data")

    # Find all inverter columns
    # Use inverter_pattern from config if available
    inverter_pattern = config['data'].get('inverter_pattern', 'Inverter Power Normalized')

    # Try as regex pattern first, then fallback to substring search
    inverter_cols = []
    try:
        import re as regex_module
        pattern = regex_module.compile(inverter_pattern)
        inverter_cols = [col for col in df.columns if pattern.search(col)]
    except:
        # Fallback to substring search
        inverter_cols = [col for col in df.columns if inverter_pattern in col]

    print(f"Found {len(inverter_cols)} inverters")

    if len(inverter_cols) == 0:
        # Try simpler pattern as last resort
        inverter_cols = [col for col in df.columns if 'Inverter Power Normalized' in col]
        if inverter_cols:
            print(f"⚠️  Used fallback pattern, found {len(inverter_cols)} inverters")
        else:
            raise ValueError(f"No inverter columns found matching pattern: {inverter_pattern}")

    # Extract plant name from first column (for inverter ID extraction)
    plant_name = config.get('name', plant_id)

    # Calculate PR for each timestamp where irradiance > threshold
    results = []

    print("\nCalculating daily PR values...")

    # Group by date
    for date, group in df.groupby('date'):
        # Filter for daylight hours with sufficient irradiance
        daylight = group[group[irrad_col] >= min_irradiance]

        if len(daylight) < 4:  # Need at least 1 hour of data (15-min intervals)
            continue

        # Calculate daily PR for each inverter
        for inv_col in inverter_cols:
            inv_id = extract_inverter_id(inv_col, plant_name)

            # Get valid data points (both irradiance and power available)
            valid = daylight[[irrad_col, inv_col]].dropna()

            if len(valid) < 4:
                continue

            # Calculate PR = normalized_power / (irradiance / 1000)
            irradiance = valid[irrad_col].values
            power = valid[inv_col].values

            # PR = power / (irradiance / 1000) where irradiance > 0
            pr_values = power / (irradiance / 1000)

            # Filter out unrealistic values (PR should be between 0 and 1.2)
            pr_values = pr_values[(pr_values >= 0) & (pr_values <= 1.2)]

            if len(pr_values) > 0:
                daily_pr = float(pr_values.mean())
                results.append({
                    'date': date,
                    'inverterId': inv_id,
                    'pr': round(daily_pr, 4)
                })

    print(f"Calculated {len(results):,} daily PR values")

    # Get date range and inverters
    dates = sorted(set(r['date'] for r in results))
    inverters = sorted(set(r['inverterId'] for r in results))

    # Create output structure
    output = {
        'metadata': {
            'plant_id': plant_id,
            'generated_at': datetime.now().isoformat(),
            'source': 'parquet_calculation',
            'min_irradiance_threshold': min_irradiance,
            'period': {
                'start': dates[0] if dates else None,
                'end': dates[-1] if dates else None
            },
            'inverters': inverters,
            'total_records': len(results)
        },
        'data': results
    }

    # Ensure output directories exist
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file_json.parent.mkdir(parents=True, exist_ok=True)

    # Convert to DataFrame for Parquet
    df_pr = pd.DataFrame(results)
    df_pr['date'] = pd.to_datetime(df_pr['date'])

    # Save to Parquet (performant format)
    print(f"\n✅ Saving to {output_file} (Parquet)...")
    df_pr.to_parquet(output_file, engine='pyarrow', compression='snappy', index=False)

    # Also save to JSON for backward compatibility
    print(f"✅ Saving to {output_file_json} (JSON, backward compatibility)...")
    with open(output_file_json, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\nSummary:")
    print(f"  Total records: {len(results):,}")
    print(f"  Inverters: {len(inverters)}")
    print(f"  Date range: {dates[0]} to {dates[-1]}")
    print(f"  Days: {len(dates)}")

    # Print sample
    print("\nSample data:")
    for r in results[:5]:
        print(f"  {r['date']} | {r['inverterId']} | PR: {r['pr']:.2%}")

    parquet_size = output_file.stat().st_size / 1024 / 1024
    json_size = output_file_json.stat().st_size / 1024 / 1024
    print(f"\n  Parquet size: {parquet_size:.2f} MB")
    print(f"  JSON size: {json_size:.2f} MB")
    print(f"  Space savings: {(1 - parquet_size/json_size)*100:.1f}%")

    print(f"\n✅ Done! Primary output: {output_file}")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Calculate daily Performance Ratio (PR) per inverter',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('--plant-id', required=True,
                       help='Plant identifier (e.g., alpha1, eta, ribera)')
    parser.add_argument('--min-irradiance', type=int, default=100,
                       help='Minimum irradiance threshold in W/m² (default: 100)')

    args = parser.parse_args()

    calculate_daily_pr(args.plant_id, args.min_irradiance)


if __name__ == '__main__':
    main()
