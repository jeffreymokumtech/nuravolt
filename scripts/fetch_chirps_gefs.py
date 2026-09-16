#!/usr/bin/env python3
"""
Fetch CHIRPS-GEFS daily precipitation forecast.

Purpose: 1-16 day forecast for cleaning schedule optimization
Data Source: UCSB Climate Hazards Center / USGS FEWS NET
Quality: Blends CHIRPS with NCEP GEFS forecast model
"""

import argparse
import json
import yaml
from pathlib import Path
from datetime import datetime, timedelta
import requests
import xarray as xr

def fetch_chirps_gefs_forecast(latitude: float, longitude: float) -> list:
    """
    Fetch CHIRPS-GEFS 16-day precipitation forecast.

    Returns ensemble mean and spread for uncertainty quantification.
    """

    # Get today's forecast file
    today = datetime.utcnow()
    date_str = today.strftime("%Y%m%d")

    url = f"https://data.chc.ucsb.edu/products/EWX/data/forecasts/CHIRPS-GEFS_precip_v12/daily_16day/data.{date_str}.nc"

    print(f"📥 Downloading CHIRPS-GEFS forecast for {today.date()}...")

    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
    except requests.exceptions.HTTPError:
        # Try yesterday's forecast if today's not available yet
        yesterday = today - timedelta(days=1)
        date_str = yesterday.strftime("%Y%m%d")
        url = f"https://data.chc.ucsb.edu/products/EWX/data/forecasts/CHIRPS-GEFS_precip_v12/daily_16day/data.{date_str}.nc"
        print(f"⚠️  Today's forecast unavailable, trying {yesterday.date()}...")
        response = requests.get(url, timeout=60)
        response.raise_for_status()

    # Save temporarily
    temp_file = Path(f"/tmp/chirps_gefs_{date_str}.nc")
    with open(temp_file, 'wb') as f:
        f.write(response.content)

    # Extract point data
    ds = xr.open_dataset(temp_file)
    point_data = ds.sel(latitude=latitude, longitude=longitude, method='nearest')

    # Extract ensemble mean and spread
    precip_mean = point_data['precip_mean'].values  # mm/day
    precip_spread = point_data['precip_spread'].values if 'precip_spread' in point_data else None
    times = point_data['time'].values

    # Convert to daily forecast data
    daily_forecast = []
    for i, time in enumerate(times):
        date_str = str(time)[:10]
        mean_mm = float(precip_mean[i])
        spread_mm = float(precip_spread[i]) if precip_spread is not None else 0

        daily_forecast.append({
            'date': date_str,
            'precipitation_mm': round(mean_mm, 2),
            'uncertainty_mm': round(spread_mm, 2),
            'is_cleaning_event': mean_mm > 5.0,
            'is_heavy_rain': mean_mm > 10.0
        })

    ds.close()
    temp_file.unlink()

    return daily_forecast

def main():
    parser = argparse.ArgumentParser(description="Fetch CHIRPS-GEFS Rain Forecast")
    parser.add_argument("--plant-id", required=True)
    args = parser.parse_args()

    # Load plant config
    config_path = Path(f"plant_configs/{args.plant_id}.yaml")
    with open(config_path) as f:
        config = yaml.safe_load(f)

    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Fetch forecast
    daily_forecast = fetch_chirps_gefs_forecast(latitude, longitude)

    # Calculate statistics
    total_precip = sum(d['precipitation_mm'] for d in daily_forecast)
    rain_days = len([d for d in daily_forecast if d['precipitation_mm'] > 1.0])

    output = {
        'metadata': {
            'plant_id': args.plant_id,
            'latitude': latitude,
            'longitude': longitude,
            'source': 'CHIRPS-GEFS v12 (UCSB CHC / USGS FEWS NET)',
            'forecast_horizon': '16 days',
            'spatial_resolution': '0.05° (~5 km)',
            'quality': '⭐⭐⭐ Blends CHIRPS + NCEP GEFS forecast',
            'ensemble_members': 11,
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'statistics': {
                'total_forecast_precipitation_mm': round(total_precip, 2),
                'rain_days_forecast': rain_days,
                'max_daily_mm': round(max(d['precipitation_mm'] for d in daily_forecast), 2)
            }
        },
        'daily_forecast': daily_forecast
    }

    # Save
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "rain_forecast.json"

    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"✅ Saved: {output_file}")
    print(f"   Forecast period: {daily_forecast[0]['date']} to {daily_forecast[-1]['date']}")
    print(f"   Total forecast: {total_precip:.1f} mm")
    print(f"   Rain days (>1mm): {rain_days}")

if __name__ == "__main__":
    main()
