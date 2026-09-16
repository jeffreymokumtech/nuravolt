#!/usr/bin/env python3
"""
Fetch precipitation data from ERA5-Land reanalysis.

This script uses the Copernicus Climate Data Store (CDS) to fetch
high-resolution precipitation data for solar soiling analysis.

ERA5-Land provides:
- Spatial Resolution: 9 km (0.1° x 0.1°)
- Temporal Resolution: Hourly
- Coverage: 1950-present with ~5 day latency
- Quality: Gold standard (⭐⭐⭐⭐⭐) r=0.79 vs ground stations

Setup:
    1. Register at: https://cds.climate.copernicus.eu/user/register
    2. Get API key: https://cds.climate.copernicus.eu/how-to-api
    3. Install: pip install cdsapi
    4. Configure: ~/.cdsapirc with your UID and API key
    5. Note: Same credentials as CAMS EAC4 (both use CDS)

Usage:
    python scripts/fetch_era5_precipitation.py --plant-id eta --start-date 2020-01-01
    python scripts/fetch_era5_precipitation.py --plant-id ribera --start-date 2024-01-01 --end-date 2024-12-31
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
    print("Register at: https://cds.climate.copernicus.eu/user/register\n")


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def fetch_era5_precipitation(latitude: float, longitude: float, start_date: str, end_date: str,
                              output_file: Path) -> bool:
    """
    Fetch ERA5-Land precipitation data.

    Variables fetched:
    - total_precipitation: Total precipitation in meters (accumulation)

    Temporal Resolution: Hourly
    Spatial Resolution: 9 km (0.1° x 0.1°)
    Latency: ~5 days behind real-time

    Quality: ⭐⭐⭐⭐⭐ (Gold standard, RMSE=49.24mm/month, r=0.79)
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

    # Parse date range
    start_dt = pd.Timestamp(start_date)
    end_dt = pd.Timestamp(end_date)

    # ERA5-Land expects YYYY-MM-DD format
    years = list(range(start_dt.year, end_dt.year + 1))
    months = [f"{m:02d}" for m in range(1, 13)]
    days = [f"{d:02d}" for d in range(1, 32)]
    times = [f"{h:02d}:00" for h in range(0, 24)]

    print(f"\nFetching ERA5-Land Precipitation data:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_date} to {end_date}")
    print(f"  Spatial Resolution: 9 km (0.1° x 0.1°)")
    print(f"  Temporal Resolution: Hourly (24 times/day)")
    print(f"  Variable: total_precipitation")
    print(f"  Quality: ⭐⭐⭐⭐⭐ (r=0.79 vs ground stations)")

    # Define bounding box (0.2 degree around plant location for 9km resolution)
    area = [
        latitude + 0.1,   # North
        longitude - 0.1,  # West
        latitude - 0.1,   # South
        longitude + 0.1   # East
    ]

    request = {
        'variable': 'total_precipitation',
        'year': [str(y) for y in years],
        'month': months,
        'day': days,
        'time': times,
        'area': area,  # [N, W, S, E]
        'format': 'netcdf',
    }

    print(f"\nDownloading data (this may take several minutes for multi-year requests)...")
    temp_file = output_file.with_suffix('.nc')

    try:
        client.retrieve(
            'reanalysis-era5-land',
            request,
            str(temp_file)
        )
        print(f"✅ Downloaded: {temp_file}")
        return True
    except Exception as e:
        print(f"❌ Download failed: {e}")
        return False


def convert_netcdf_to_json(nc_file: Path, output_file: Path, plant_id: str,
                           latitude: float, longitude: float, start_date: str, end_date: str):
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

    # Get time coordinate
    time_coord = 'time' if 'time' in data_point.coords else 'valid_time'

    # Filter to requested date range
    start_dt = pd.Timestamp(start_date)
    end_dt = pd.Timestamp(end_date)

    # Convert to temporal data (hourly precipitation)
    temporal_data = []
    for time in data_point[time_coord].values:
        timestamp = pd.Timestamp(time)

        # Filter by date range
        if timestamp < start_dt or timestamp > end_dt:
            continue

        time_key = timestamp.strftime('%Y-%m-%d %H:%M')

        # ERA5-Land precipitation is in meters (accumulated over the hour)
        # Convert to mm/hour: 1 meter = 1000 mm
        precip_m = float(data_point['tp'].sel({time_coord: time}).values)
        precip_mm = precip_m * 1000 if not np.isnan(precip_m) else 0.0

        data_point_dict = {
            "timestamp": time_key,
            "precipitation_mm": round(precip_mm, 2),
        }

        temporal_data.append(data_point_dict)

    # Calculate statistics
    precip_values = [d['precipitation_mm'] for d in temporal_data]

    # Daily aggregation for summary stats
    df = pd.DataFrame(temporal_data)
    df['timestamp'] = pd.to_datetime(df['timestamp'])
    df['date'] = df['timestamp'].dt.date
    daily = df.groupby('date')['precipitation_mm'].sum()

    total_precip_mm = round(sum(precip_values), 2)
    mean_hourly_mm = round(np.mean(precip_values), 4)
    rain_hours = len([v for v in precip_values if v > 0.1])  # >0.1mm threshold
    rain_days = len([v for v in daily.values if v > 1.0])  # >1mm/day threshold
    max_daily_mm = round(daily.max(), 2) if len(daily) > 0 else 0

    output_data = {
        "metadata": {
            "plant_id": plant_id,
            "location": {"latitude": latitude, "longitude": longitude},
            "data_source": "ERA5-Land Reanalysis (reanalysis-era5-land)",
            "temporal_resolution": "Hourly",
            "spatial_resolution": "9 km (0.1° x 0.1°)",
            "variable": "total_precipitation (mm)",
            "quality": "⭐⭐⭐⭐⭐ (r=0.79 vs ground stations)",
            "period": {"start": start_date, "end": end_date},
            "record_count": len(temporal_data),
            "statistics": {
                "total_precipitation_mm": total_precip_mm,
                "mean_hourly_mm": mean_hourly_mm,
                "rain_hours": rain_hours,
                "rain_days": rain_days,
                "max_daily_mm": max_daily_mm,
            }
        },
        "data": temporal_data
    }

    # Save to JSON
    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)

    print(f"✅ Saved: {output_file}")
    print(f"\nStatistics:")
    print(f"  Total records: {len(temporal_data)}")
    print(f"  Total precipitation: {total_precip_mm} mm")
    print(f"  Mean hourly: {mean_hourly_mm} mm/hr")
    print(f"  Rain hours (>0.1mm): {rain_hours}")
    print(f"  Rain days (>1mm): {rain_days}")
    print(f"  Max daily: {max_daily_mm} mm/day")

    ds.close()
    return True


def main():
    parser = argparse.ArgumentParser(description="Fetch ERA5-Land Precipitation data")
    parser.add_argument("--plant-id", required=True, help="Plant identifier (e.g., eta, ribera, alpha1)")
    parser.add_argument("--start-date", required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="End date (YYYY-MM-DD), defaults to 5 days ago (ERA5-Land latency)")

    args = parser.parse_args()

    # Load plant configuration
    config = load_plant_config(args.plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Default end date to 5 days ago (ERA5-Land latency)
    end_date = args.end_date if args.end_date else (datetime.now() - timedelta(days=5)).strftime('%Y-%m-%d')

    # Output directory
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "era5_rain_history.json"

    print("=" * 70)
    print(f"FETCH ERA5-LAND PRECIPITATION DATA FOR {args.plant_id.upper()}")
    print("=" * 70)

    # Fetch data
    temp_nc = output_dir / "era5_rain_history.nc"
    success = fetch_era5_precipitation(
        latitude=latitude,
        longitude=longitude,
        start_date=args.start_date,
        end_date=end_date,
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
        start_date=args.start_date,
        end_date=end_date
    )

    if success:
        # Clean up temp NetCDF file
        temp_nc.unlink()
        print(f"\n✅ Cleaned up temporary NetCDF file")

        print(f"\n✅ Complete! ERA5-Land precipitation data saved to: {output_file}")
        return 0
    else:
        print("\n❌ Failed to convert data")
        return 1


if __name__ == "__main__":
    exit(main())
