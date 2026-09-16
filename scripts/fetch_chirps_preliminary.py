#!/usr/bin/env python3
"""
Fetch CHIRPS Preliminary daily precipitation data.

Purpose: Near-real-time monitoring with ~2 day latency
Data Source: UCSB Climate Hazards Center
Quality: Preliminary (updated to Final after ~3 weeks)
"""

import argparse
import json
import yaml
from pathlib import Path
from datetime import datetime, timedelta
import requests
import xarray as xr

def fetch_chirps_preliminary(latitude: float, longitude: float, days: int = 60) -> list:
    """
    Fetch CHIRPS Preliminary data for last N days.

    Uses pentad (5-day) NetCDF files from prelim directory.
    """

    # Determine which pentad files to download
    # CHIRPS uses 6 pentads per month (days 1-5, 6-10, 11-15, 16-20, 21-25, 26-end)
    current_year = datetime.utcnow().year

    url = f"https://data.chc.ucsb.edu/products/CHIRPS-2.0/prelim/global_pentad/netcdf/chirps-v2.0_p6.{current_year}.nc"

    print(f"📥 Downloading CHIRPS Preliminary {current_year}...")
    response = requests.get(url)
    response.raise_for_status()

    # Save temporarily
    temp_file = Path(f"/tmp/chirps_prelim_{current_year}.nc")
    with open(temp_file, 'wb') as f:
        f.write(response.content)

    # Extract point data
    ds = xr.open_dataset(temp_file)
    point_data = ds.sel(latitude=latitude, longitude=longitude, method='nearest')

    # Get last N days
    end_date = datetime.utcnow() - timedelta(days=2)  # 2-day delay
    start_date = end_date - timedelta(days=days)

    # Filter to date range
    mask = (point_data['time'] >= start_date) & (point_data['time'] <= end_date)
    filtered = point_data.where(mask, drop=True)

    # Extract to list
    precip = filtered['precip'].values
    times = filtered['time'].values

    daily_data = []
    for i, time in enumerate(times):
        date_str = str(time)[:10]
        precip_mm = float(precip[i])

        daily_data.append({
            'date': date_str,
            'precipitation_mm': round(precip_mm, 2),
            'is_cleaning_event': precip_mm > 5.0,
            'is_heavy_rain': precip_mm > 10.0
        })

    ds.close()
    temp_file.unlink()

    return daily_data

def main():
    parser = argparse.ArgumentParser(description="Fetch CHIRPS Preliminary Rain Data")
    parser.add_argument("--plant-id", required=True)
    parser.add_argument("--days", type=int, default=60)
    args = parser.parse_args()

    # Load plant config
    config_path = Path(f"plant_configs/{args.plant_id}.yaml")
    with open(config_path) as f:
        config = yaml.safe_load(f)

    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Fetch data
    daily_data = fetch_chirps_preliminary(latitude, longitude, args.days)

    output = {
        'metadata': {
            'plant_id': args.plant_id,
            'latitude': latitude,
            'longitude': longitude,
            'source': 'CHIRPS v2.0 Preliminary (UCSB CHC)',
            'quality': '⭐⭐⭐ Preliminary (2-day delay, updated to Final after 3 weeks)',
            'latency': '~2 days',
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        },
        'daily_data': daily_data
    }

    # Save
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "rain_recent.json"

    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"✅ Saved: {output_file}")

if __name__ == "__main__":
    main()
