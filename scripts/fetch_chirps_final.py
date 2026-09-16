#!/usr/bin/env python3
"""
Fetch CHIRPS Final daily precipitation data for solar plant locations.

Downloads annual CHIRPS v2.0 NetCDF files and extracts point data.
Data Source: UCSB Climate Hazards Center
Quality: Research-grade, satellite + ground station blend
"""

import argparse
import json
import yaml
from pathlib import Path
from datetime import datetime
import requests
import xarray as xr
from tqdm import tqdm

def download_chirps_year(year: int, cache_dir: Path) -> Path:
    """Download CHIRPS Final annual NetCDF file."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    filename = f"chirps-v2.0.{year}.days_p05.nc"
    filepath = cache_dir / filename

    if filepath.exists():
        print(f"✅ Using cached: {filepath}")
        return filepath

    url = f"https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/netcdf/p05/{filename}"
    print(f"\n📥 Downloading CHIRPS {year} (~1GB)...")

    response = requests.get(url, stream=True)
    response.raise_for_status()

    total_size = int(response.headers.get('content-length', 0))
    with open(filepath, 'wb') as f, tqdm(total=total_size, unit='B', unit_scale=True) as pbar:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
            pbar.update(len(chunk))

    print(f"✅ Downloaded: {filepath}")
    return filepath

def extract_point_data(netcdf_path: Path, latitude: float, longitude: float, year: int) -> list:
    """Extract daily precipitation for a specific location."""
    print(f"📍 Extracting data for ({latitude}, {longitude})...")

    ds = xr.open_dataset(netcdf_path)

    # Select nearest grid point
    point_data = ds.sel(latitude=latitude, longitude=longitude, method='nearest')

    # Extract precipitation time series
    precip = point_data['precip'].values  # mm/day
    times = point_data['time'].values

    ds.close()

    # Convert to daily records
    daily_data = []
    for i, time in enumerate(times):
        date_str = str(time)[:10]  # YYYY-MM-DD
        precip_mm = float(precip[i])

        daily_data.append({
            'date': date_str,
            'precipitation_mm': round(precip_mm, 2),
            'is_cleaning_event': precip_mm > 5.0,
            'is_heavy_rain': precip_mm > 10.0
        })

    return daily_data

def main():
    parser = argparse.ArgumentParser(description="Fetch CHIRPS Final Rain Data")
    parser.add_argument("--plant-id", required=True)
    parser.add_argument("--start-year", type=int, default=2019)
    parser.add_argument("--end-year", type=int, default=2024)
    args = parser.parse_args()

    # Load plant config
    config_path = Path(f"plant_configs/{args.plant_id}.yaml")
    with open(config_path) as f:
        config = yaml.safe_load(f)

    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Cache directory for NetCDF files
    cache_dir = Path(f".cache/chirps")

    # Download and extract data for each year
    all_data = []
    for year in range(args.start_year, args.end_year + 1):
        netcdf_path = download_chirps_year(year, cache_dir)
        year_data = extract_point_data(netcdf_path, latitude, longitude, year)
        all_data.extend(year_data)

    # Calculate statistics
    cleaning_events = [d for d in all_data if d['is_cleaning_event']]

    output = {
        'metadata': {
            'plant_id': args.plant_id,
            'latitude': latitude,
            'longitude': longitude,
            'source': 'CHIRPS v2.0 Final (UCSB Climate Hazards Center)',
            'spatial_resolution': '0.05° (~5 km)',
            'temporal_resolution': 'Daily',
            'quality': '⭐⭐⭐⭐ Research-grade (satellite + ground stations)',
            'period': {
                'start': all_data[0]['date'],
                'end': all_data[-1]['date']
            },
            'cleaning_threshold_mm': 5,
            'generated_at': datetime.utcnow().isoformat() + 'Z'
        },
        'daily_data': all_data,
        'cleaning_events': cleaning_events,
        'statistics': {
            'total_days': len(all_data),
            'rain_days': len([d for d in all_data if d['precipitation_mm'] > 0.1]),
            'cleaning_events_count': len(cleaning_events),
            'heavy_rain_count': len([d for d in all_data if d['is_heavy_rain']]),
            'total_precipitation_mm': round(sum(d['precipitation_mm'] for d in all_data), 2)
        }
    }

    # Save to JSON
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "rain_history.json"

    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Saved: {output_file}")
    print(f"   Total precipitation: {output['statistics']['total_precipitation_mm']:.1f} mm")
    print(f"   Cleaning events (>5mm): {output['statistics']['cleaning_events_count']}")

if __name__ == "__main__":
    main()
