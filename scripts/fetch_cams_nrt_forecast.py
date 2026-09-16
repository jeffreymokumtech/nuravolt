#!/usr/bin/env python3
"""
Fetch 5-day AOD forecast from CAMS Global Atmospheric Composition Forecasts (Forecast Mode).

This script uses the Copernicus Atmosphere Data Store (ADS) to fetch
5-day aerosol optical depth forecasts for solar soiling event prediction.

IMPORTANT: This fetches FORECAST time steps (leadtime_hour: 3-120), not analysis steps.
Forecast steps provide predicted atmospheric state up to 5 days ahead.

Setup:
    1. Register at: https://ads.atmosphere.copernicus.eu/user/register
    2. Get API key: https://ads.atmosphere.copernicus.eu/how-to-api
    3. Install: pip install cdsapi
    4. Configure: ~/.cdsapirc with your UID and API key

Usage:
    python scripts/fetch_cams_nrt_forecast.py --plant-id eta
    python scripts/fetch_cams_nrt_forecast.py --plant-id ribera --init-time 00
"""

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
import yaml
import pandas as pd
import numpy as np

try:
    import cdsapi
    CDS_AVAILABLE = True
except ImportError:
    CDS_AVAILABLE = False
    print("\n⚠️  WARNING: cdsapi not installed")
    print("Install with: pip install cdsapi")
    print("Register at: https://ads.atmosphere.copernicus.eu/user/register\n")


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def fetch_cams_nrt_forecast(latitude: float, longitude: float, init_date: str, init_time: str,
                             output_file: Path) -> bool:
    """
    Fetch CAMS-NRT aerosol optical depth 5-day forecast (FORECAST MODE).

    Variables fetched:
    - total_aerosol_optical_depth_550nm: Total AOD
    - dust_aerosol_optical_depth_550nm: Dust AOD only
    - particulate_matter_2.5um: PM2.5
    - particulate_matter_10um: PM10

    Forecast Mode: leadtime_hour = 3, 6, 9, ..., 120 (5 days)
    Temporal Resolution: 3-hourly for 120 hours (40 time steps)
    """
    if not CDS_AVAILABLE:
        raise ImportError("cdsapi is required. Install with: pip install cdsapi")

    # Fix SSL certificate verification on macOS
    import os
    try:
        import certifi
        os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
        os.environ['SSL_CERT_FILE'] = certifi.where()
    except ImportError:
        pass  # certifi not required, just helps with SSL issues

    client = cdsapi.Client()

    # Forecast lead times (3-hourly for 5 days = 120 hours)
    leadtime_hours = [str(h) for h in range(3, 121, 3)]  # ['3', '6', '9', ..., '120']

    print(f"\nFetching CAMS-NRT Forecast data:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Initialization: {init_date} {init_time}:00 UTC")
    print(f"  Mode: Forecast (leadtime_hour = 3-120)")
    print(f"  Forecast Horizon: 5 days (120 hours)")
    print(f"  Temporal Resolution: 3-hourly (40 time steps)")
    print(f"  Variables: AOD 550nm, Dust AOD, PM2.5, PM10")

    # Define bounding box (0.5 degree around plant location)
    area = [
        latitude + 0.25,   # North
        longitude - 0.25,  # West
        latitude - 0.25,   # South
        longitude + 0.25   # East
    ]

    request = {
        'type': 'fc',  # Forecast type
        'variable': [
            'total_aerosol_optical_depth_550nm',
            'dust_aerosol_optical_depth_550nm',
            'particulate_matter_2.5um',
            'particulate_matter_10um',
        ],
        'date': init_date,
        'time': [init_time],  # Must be a list
        'leadtime_hour': leadtime_hours,  # 3-hour steps from 3 to 120
        'area': area,  # [N, W, S, E]
        'format': 'netcdf_zip',
    }

    print(f"\nDownloading data (this may take several minutes)...")
    temp_file = output_file.with_suffix('.nc')

    try:
        client.retrieve(
            'cams-global-atmospheric-composition-forecasts',
            request,
            str(temp_file)
        )
        print(f"✅ Downloaded: {temp_file}")
        return True
    except Exception as e:
        print(f"❌ Download failed: {e}")
        return False


def convert_netcdf_to_json(nc_file: Path, output_file: Path, plant_id: str,
                           latitude: float, longitude: float, init_datetime: str):
    """Convert NetCDF to JSON format."""
    try:
        import xarray as xr
    except ImportError:
        print("⚠️  xarray not installed. Install with: pip install xarray netCDF4")
        return False

    print(f"\nConverting NetCDF to JSON...")
    ds = xr.open_dataset(nc_file)

    # Extract data for nearest grid point
    data_point = ds.sel(latitude=latitude, longitude=longitude, method='nearest')

    # Get time coordinate (could be 'time', 'valid_time', or 'forecast_time')
    time_coord = None
    for coord in ['time', 'valid_time', 'forecast_time']:
        if coord in data_point.coords:
            time_coord = coord
            break

    if time_coord is None:
        raise ValueError("Could not find time coordinate in NetCDF file")

    # Convert to temporal forecast data (3-hourly for 5 days)
    forecast_data = []
    init_dt = pd.Timestamp(init_datetime)

    for time in data_point[time_coord].values:
        timestamp = pd.Timestamp(time)

        # Store full timestamp
        time_key = timestamp.strftime('%Y-%m-%d %H:%M')

        # Calculate hours ahead from initialization
        hours_ahead = int((timestamp - init_dt).total_seconds() / 3600)

        # Extract values (handle NaN) - variable names might be different in NRT
        aod_var = 'aod550' if 'aod550' in data_point else 'total_aerosol_optical_depth_550nm'
        dust_var = 'duaod550' if 'duaod550' in data_point else 'dust_aerosol_optical_depth_550nm'

        aod_total = float(data_point[aod_var].sel({time_coord: time}).values)
        aod_dust = float(data_point[dust_var].sel({time_coord: time}).values)

        # Skip if all NaN
        if np.isnan(aod_total):
            continue

        # Convert AOD to approximate PM concentrations (μg/m³)
        pm2_5_estimate = round(aod_total * 120, 2) if not np.isnan(aod_total) else None
        pm10_estimate = round(aod_total * 150, 2) if not np.isnan(aod_total) else None
        dust_estimate = round(aod_dust * 250, 2) if not np.isnan(aod_dust) else None

        data_point_dict = {
            "timestamp": time_key,
            "hours_ahead": hours_ahead,
            "forecast_day": (hours_ahead // 24) + 1,
            "aod_550nm": round(aod_total, 4) if not np.isnan(aod_total) else None,
            "dust_aod_550nm": round(aod_dust, 4) if not np.isnan(aod_dust) else None,
            "pm2_5": pm2_5_estimate,
            "pm10": pm10_estimate,
            "dust": dust_estimate,
        }

        forecast_data.append(data_point_dict)

    # Calculate statistics by forecast day
    day_stats = {}
    for day in range(1, 6):
        day_data = [d for d in forecast_data if d['forecast_day'] == day]
        if day_data:
            aod_values = [d['aod_550nm'] for d in day_data if d['aod_550nm'] is not None]
            dust_values = [d['dust'] for d in day_data if d['dust'] is not None]
            day_stats[f"day_{day}"] = {
                "mean_aod": round(np.mean(aod_values), 4) if aod_values else 0,
                "max_dust": round(max(dust_values), 2) if dust_values else 0,
                "record_count": len(day_data)
            }

    output_data = {
        "metadata": {
            "plant_id": plant_id,
            "location": {"latitude": latitude, "longitude": longitude},
            "data_source": "CAMS-NRT Forecast (cams-global-atmospheric-composition-forecasts)",
            "initialization": init_datetime,
            "forecast_horizon": "5 days (120 hours)",
            "temporal_resolution": "3-hourly (forecast steps)",
            "variables": ["aod_550nm", "dust_aod_550nm", "pm2_5", "pm10", "dust"],
            "record_count": len(forecast_data),
            "forecast_quality": {
                "day_1_2": "High accuracy (r > 0.75)",
                "day_3": "Moderate accuracy (r > 0.70)",
                "day_4_5": "Lower accuracy (r ~ 0.60-0.70)"
            },
            "day_statistics": day_stats
        },
        "data": forecast_data
    }

    # Save to JSON
    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)

    print(f"✅ Saved: {output_file}")
    print(f"\nForecast Statistics:")
    print(f"  Total time steps: {len(forecast_data)}")
    for day in range(1, 6):
        if f"day_{day}" in day_stats:
            stats = day_stats[f"day_{day}"]
            print(f"  Day {day}: AOD={stats['mean_aod']:.4f}, Max Dust={stats['max_dust']:.1f} μg/m³")

    ds.close()
    return True


def main():
    parser = argparse.ArgumentParser(description="Fetch CAMS-NRT Forecast AOD data")
    parser.add_argument("--plant-id", required=True, help="Plant identifier (e.g., eta, ribera, alpha1)")
    parser.add_argument("--init-date", help="Forecast initialization date (YYYY-MM-DD), defaults to today")
    parser.add_argument("--init-time", choices=['00:00', '12:00'], default='00:00',
                       help="Forecast initialization time (00:00 or 12:00 UTC)")

    args = parser.parse_args()

    # Load plant configuration
    config = load_plant_config(args.plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Default init date to today if not provided
    init_date = args.init_date if args.init_date else datetime.now().strftime('%Y-%m-%d')
    init_datetime = f"{init_date} {args.init_time}"

    # Output directory
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "cams_nrt_forecast.json"

    print("=" * 70)
    print(f"FETCH CAMS-NRT FORECAST AOD DATA FOR {args.plant_id.upper()}")
    print("=" * 70)

    # Fetch data
    temp_nc = output_dir / "cams_nrt_forecast.nc"
    success = fetch_cams_nrt_forecast(
        latitude=latitude,
        longitude=longitude,
        init_date=init_date,
        init_time=args.init_time,
        output_file=temp_nc
    )

    if not success:
        print("\n❌ Failed to fetch data")
        return 1

    # Convert to JSON
    success = convert_netcdf_to_json(
        nc_file=temp_nc,
        output_file=output_file,
        plant_id=args.plant_id,
        latitude=latitude,
        longitude=longitude,
        init_datetime=init_datetime
    )

    if success:
        # Clean up temp NetCDF file
        temp_nc.unlink()
        print(f"\n✅ Cleaned up temporary NetCDF file")

        print(f"\n✅ Complete! NRT Forecast AOD data saved to: {output_file}")
        return 0
    else:
        print("\n❌ Failed to convert data")
        return 1


if __name__ == "__main__":
    exit(main())
