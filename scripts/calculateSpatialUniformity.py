#!/usr/bin/env python3
"""
Calculate spatial uniformity metrics across inverter zones.

This is an entry point script that imports core logic from nuravolt.soiling.data_quality.

Usage:
    python scripts/calculateSpatialUniformity.py --plant-id alpha1
"""

import argparse
import json
import math
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import polars as pl

from nuravolt.soiling.data_quality.spatial_uniformity import (
    ANALYSIS_CONFIG,
    DEFAULT_ZONE_CONFIG,
    aggregate_to_daily,
    calculate_spatial_uniformity,
    calculate_zone_pr,
    calculate_zone_statistics,
    detect_non_uniform_periods,
    get_zone_mapping,
    identify_zone_columns,
)


def load_parquet_data(parquet_dir: Path, plant_id: str = "alpha1") -> Optional[pl.DataFrame]:
    """Load 15-minute inverter data from parquet files."""
    # Map plant IDs to file identifiers
    plant_file_ids = {
        'alpha1': '00461',
        'eta': '00457',
        'ribera': '00460'
    }

    file_id = plant_file_ids.get(plant_id, '00461')

    parquet_files = list(parquet_dir.glob('*.parquet'))

    if not parquet_files:
        print(f"No parquet files found in {parquet_dir}")
        return None

    # Find parquet file for this specific plant
    power_file = None
    for f in parquet_files:
        if file_id in f.name and ('Normalized' in f.name or 'training' in f.name):
            power_file = f
            break

    if power_file is None:
        print(f"No parquet file found for plant {plant_id} (file ID: {file_id})")
        return None

    print(f"Loading: {power_file.name}")
    df = pl.read_parquet(power_file)

    return df


def save_results(
    df_daily: pl.DataFrame,
    zones: List[str],
    zone_stats: Dict,
    alerts: List[Dict],
    output_dir: Path,
    plant_id: str,
    cv_threshold: float
):
    """Save spatial uniformity results to JSON."""
    output_dir.mkdir(parents=True, exist_ok=True)

    df_pd = df_daily.to_pandas()

    # Build time series
    time_series = []
    for _, row in df_pd.iterrows():
        zone_prs = {zone: round(float(row[f'{zone}_pr']), 4) for zone in zones}
        max_zone = max(zone_prs, key=zone_prs.get)
        min_zone = min(zone_prs, key=zone_prs.get)

        time_series.append({
            'timestamp': row['date'].isoformat(),
            'coefficientOfVariation': round(float(row['cv']), 4),
            'isUniform': bool(row['is_uniform']),
            'zonePRs': zone_prs,
            'highestZone': max_zone,
            'lowestZone': min_zone,
            'spread': round(float(row['avg_spread']), 4),
        })

    # Calculate summary
    uniform_count = int(df_pd['is_uniform'].sum())
    non_uniform_count = len(df_pd) - uniform_count

    summary = {
        'totalMeasurements': len(df_pd),
        'uniformMeasurements': uniform_count,
        'nonUniformMeasurements': non_uniform_count,
        'uniformityRate': round(uniform_count / len(df_pd) * 100, 2),
        'avgCV': round(float(df_pd['cv'].mean()), 4),
        'maxCV': round(float(df_pd['cv'].max()), 4),
        'alertCount': len(alerts),
    }

    output = {
        'metadata': {
            'plantId': plant_id,
            'generatedAt': datetime.now().isoformat(),
            'period': {
                'start': df_pd['date'].min().isoformat(),
                'end': df_pd['date'].max().isoformat(),
            },
            'zones': zones,
            'cvThreshold': cv_threshold,
            'measurementInterval': 'daily',
        },
        'summary': summary,
        'zoneStatistics': zone_stats,
        'timeSeries': time_series,
        'alerts': alerts,
    }

    # Save
    output_file = output_dir / 'quality' / 'spatial_uniformity.json'
    output_file.parent.mkdir(exist_ok=True)

    def _json_clean(o):
        # Literal NaN/Infinity is invalid JSON — the route's strict
        # JSON.parse 500s on it (this silently broke the Spatial tab once).
        if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
            return None
        if isinstance(o, dict):
            return {k: _json_clean(v) for k, v in o.items()}
        if isinstance(o, list):
            return [_json_clean(v) for v in o]
        return o

    with open(output_file, 'w') as f:
        json.dump(_json_clean(output), f, indent=2, allow_nan=False)

    print(f"\nSaved: {output_file}")
    print(f"  Total days: {len(time_series)}")
    print(f"  Uniform days: {uniform_count} ({summary['uniformityRate']:.1f}%)")
    print(f"  Non-uniform days: {non_uniform_count}")
    print(f"  Alerts: {len(alerts)}")


def main():
    parser = argparse.ArgumentParser(description='Calculate spatial uniformity metrics')
    parser.add_argument('--plant-id', default='alpha1', help='Plant ID')
    parser.add_argument('--parquet-dir', default='demo_spain', help='Parquet directory')
    parser.add_argument('--output-dir', default='public/data/soiling', help='Output directory')
    args = parser.parse_args()

    print("=" * 60)
    print("Spatial Uniformity Analysis")
    print("=" * 60)

    # Get configuration
    zone_patterns, cv_threshold = get_zone_mapping(args.plant_id)

    # Set up paths
    base_dir = Path(__file__).parent.parent
    parquet_dir = base_dir / args.parquet_dir
    output_dir = base_dir / args.output_dir / args.plant_id

    # Load data
    print(f"\nLoading data from {parquet_dir}...")
    df = load_parquet_data(parquet_dir, args.plant_id)

    if df is None:
        print("Failed to load data")
        return

    print(f"Loaded {len(df)} records")

    # Identify columns
    columns = df.columns
    print(f"\nIdentifying zone columns...")
    zone_columns = identify_zone_columns(columns, zone_patterns)

    zones = [z for z in zone_columns.keys() if zone_columns[z]]
    if len(zones) < 2:
        print("Error: Need at least 2 zones for uniformity analysis")
        return

    # Find timestamp and irradiance columns
    ts_col = None
    irr_col = None

    for col in columns:
        if 'timestamp' in col.lower() or col == columns[0]:
            ts_col = col
        if 'irrad' in col.lower() or 'radiation' in col.lower():
            irr_col = col

    if ts_col is None:
        ts_col = columns[0]

    if irr_col is None:
        print("Warning: No irradiance column found, using constant value")
        df = df.with_columns(pl.lit(500.0).alias('irradiance_const'))
        irr_col = 'irradiance_const'

    print(f"\nTimestamp column: {ts_col}")
    print(f"Irradiance column: {irr_col}")

    # Calculate zone PR
    print(f"\nCalculating zone-level PR...")
    df_zones = calculate_zone_pr(df, zone_columns, irr_col, ts_col)
    print(f"Valid daylight records: {len(df_zones)}")

    # Calculate CV and uniformity
    print(f"\nCalculating CV and uniformity metrics...")
    df_cv = calculate_spatial_uniformity(df_zones, zones, cv_threshold)

    # Aggregate to daily
    print(f"\nAggregating to daily values...")
    df_daily = aggregate_to_daily(df_cv, zones, cv_threshold)
    print(f"Days with data: {len(df_daily)}")

    # Detect alerts
    print(f"\nDetecting non-uniformity alerts...")
    alerts = detect_non_uniform_periods(df_cv, zones, ANALYSIS_CONFIG['alert_cv_threshold'])
    print(f"Alerts detected: {len(alerts)}")

    # Calculate zone statistics
    zone_stats = calculate_zone_statistics(df_daily, zones)

    # Save results
    save_results(df_daily, zones, zone_stats, alerts, output_dir, args.plant_id, cv_threshold)

    print("\nDone!")


if __name__ == '__main__':
    main()
