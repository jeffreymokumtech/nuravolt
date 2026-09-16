#!/usr/bin/env python3
"""
Fetch near-real-time AOD data from CAMS Global Atmospheric Composition Forecasts (Analysis Mode).

This script uses the Copernicus Atmosphere Data Store (ADS) to fetch
near-real-time aerosol optical depth data (analysis steps) for solar soiling analysis.

IMPORTANT: This fetches ANALYSIS time steps (leadtime_hour: 0), not forecast steps.
Analysis steps provide the best estimate of current atmospheric state using latest observations.

Setup:
    1. Register at: https://ads.atmosphere.copernicus.eu/user/register
    2. Get API key: https://ads.atmosphere.copernicus.eu/how-to-api
    3. Install: pip install cdsapi
    4. Configure: ~/.cdsapirc with your UID and API key

Usage:
    python scripts/fetch_cams_nrt_analysis.py --plant-id eta --start-date 2025-01-01
    python scripts/fetch_cams_nrt_analysis.py --plant-id ribera --start-date 2025-01-01 --end-date 2025-12-16
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


def fetch_cams_nrt_analysis(latitude: float, longitude: float, start_date: str, end_date: str,
                             output_file: Path) -> bool:
    """
    Fetch CAMS-NRT aerosol optical depth data (ANALYSIS MODE).

    Variables fetched:
    - total_aerosol_optical_depth_550nm: Total AOD
    - dust_aerosol_optical_depth_550nm: Dust AOD only
    - particulate_matter_2.5um: PM2.5
    - particulate_matter_10um: PM10

    Analysis Mode: leadtime_hour = 0 (best estimate of current state)
    Temporal Resolution: 6-hourly (00:00, 06:00, 12:00, 18:00 UTC)

    IMPORTANT: CAMS-NRT only keeps ~3-5 days of analysis data.
    For historical data, use CAMS EAC4 reanalysis instead.
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

    # Analysis times (every 6 hours)
    time_values = ['00:00', '06:00', '12:00', '18:00']

    print(f"\nFetching CAMS-NRT Analysis data:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_date} to {end_date}")
    print(f"  Mode: Analysis (type='analysis', leadtime_hour='0')")
    print(f"  Temporal Resolution: 6-hourly (4 times/day)")
    print(f"  Variables: AOD 550nm, Dust AOD, PM2.5, PM10")
    print(f"  ⚠️  Note: CAMS-NRT only keeps ~3-5 days of data")

    # Define bounding box (0.5 degree around plant location)
    area = [
        latitude + 0.25,   # North
        longitude - 0.25,  # West
        latitude - 0.25,   # South
        longitude + 0.25   # East
    ]

    request = {
        'type': 'analysis',  # Analysis type (NOT 'fc')
        'variable': [
            'total_aerosol_optical_depth_550nm',
            'dust_aerosol_optical_depth_550nm',
            'particulate_matter_2.5um',
            'particulate_matter_10um',
        ],
        'date': f'{start_date}/{end_date}',
        'time': time_values,
        'leadtime_hour': '0',  # Analysis time (step 0)
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
                           latitude: float, longitude: float):
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

    # Convert to temporal data (6-hourly analysis)
    temporal_data = []
    for time in data_point[time_coord].values:
        timestamp = pd.Timestamp(time)

        # Store full timestamp for 6-hourly resolution
        time_key = timestamp.strftime('%Y-%m-%d %H:%M')

        # Extract values (handle NaN) - variable names might be different in NRT
        aod_var = 'aod550' if 'aod550' in data_point else 'total_aerosol_optical_depth_550nm'
        dust_var = 'duaod550' if 'duaod550' in data_point else 'dust_aerosol_optical_depth_550nm'

        aod_total = float(data_point[aod_var].sel({time_coord: time}).values)
        aod_dust = float(data_point[dust_var].sel({time_coord: time}).values)

        # Skip if all NaN
        if np.isnan(aod_total):
            continue

        # Convert AOD to approximate PM concentrations (μg/m³)
        # These are rough estimates based on typical atmospheric conditions
        # PM from AOD conversion factors:
        #   PM2.5 ≈ AOD × 120 (fine aerosols)
        #   PM10 ≈ AOD × 150 (total aerosols including coarse)
        #   Dust ≈ Dust_AOD × 250 (dust-specific, higher density)
        pm2_5_estimate = round(aod_total * 120, 2) if not np.isnan(aod_total) else None
        pm10_estimate = round(aod_total * 150, 2) if not np.isnan(aod_total) else None
        dust_estimate = round(aod_dust * 250, 2) if not np.isnan(aod_dust) else None

        data_point_dict = {
            "timestamp": time_key,
            "aod_550nm": round(aod_total, 4) if not np.isnan(aod_total) else None,
            "dust_aod_550nm": round(aod_dust, 4) if not np.isnan(aod_dust) else None,
            "pm2_5": pm2_5_estimate,
            "pm10": pm10_estimate,
            "dust": dust_estimate,
        }

        temporal_data.append(data_point_dict)

    # Calculate statistics
    aod_values = [d['aod_550nm'] for d in temporal_data if d['aod_550nm'] is not None]
    dust_aod_values = [d['dust_aod_550nm'] for d in temporal_data if d['dust_aod_550nm'] is not None]
    dust_values = [d['dust'] for d in temporal_data if d['dust'] is not None]

    mean_aod = round(np.mean(aod_values), 4) if aod_values else 0
    mean_dust_aod = round(np.mean(dust_aod_values), 4) if dust_aod_values else 0

    # Count high dust days (>100 μg/m³ threshold)
    high_dust_records = len([v for v in dust_values if v and v > 100])

    output_data = {
        "metadata": {
            "plant_id": plant_id,
            "location": {"latitude": latitude, "longitude": longitude},
            "data_source": "CAMS-NRT Analysis (cams-global-atmospheric-composition-forecasts)",
            "temporal_resolution": "6-hourly (analysis steps, leadtime_hour = 0)",
            "variables": ["aod_550nm", "dust_aod_550nm", "pm2_5", "pm10", "dust"],
            "record_count": len(temporal_data),
            "statistics": {
                "mean_aod": mean_aod,
                "mean_dust_aod": mean_dust_aod,
                "high_dust_records": high_dust_records
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
    print(f"  Mean AOD: {mean_aod}")
    print(f"  Mean Dust AOD: {mean_dust_aod}")
    print(f"  High dust records: {high_dust_records}")

    ds.close()
    return True


def main():
    parser = argparse.ArgumentParser(description="Fetch CAMS-NRT Analysis AOD data")
    parser.add_argument("--plant-id", required=True, help="Plant identifier (e.g., eta, ribera, alpha1)")
    parser.add_argument("--start-date", help="Start date (YYYY-MM-DD), defaults to 5 days ago")
    parser.add_argument("--end-date", help="End date (YYYY-MM-DD), defaults to today")
    parser.add_argument("--days", type=int, default=5, help="Number of recent days to fetch (default: 5)")

    args = parser.parse_args()

    # Load plant configuration
    config = load_plant_config(args.plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Default to last N days if start_date not provided
    if args.start_date:
        start_date = args.start_date
    else:
        start_date = (datetime.now() - timedelta(days=args.days)).strftime('%Y-%m-%d')

    # Default end date to today if not provided
    end_date = args.end_date if args.end_date else datetime.now().strftime('%Y-%m-%d')

    # Output directory
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "cams_nrt_analysis.json"

    print("=" * 70)
    print(f"FETCH CAMS-NRT ANALYSIS AOD DATA FOR {args.plant_id.upper()}")
    print("=" * 70)

    # Fetch data
    temp_nc = output_dir / "cams_nrt_analysis.nc"
    success = fetch_cams_nrt_analysis(
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
        longitude=longitude
    )

    if success:
        # Clean up temp NetCDF file
        temp_nc.unlink()
        print(f"\n✅ Cleaned up temporary NetCDF file")

        print(f"\n✅ Complete! NRT Analysis AOD data saved to: {output_file}")
        return 0
    else:
        print("\n❌ Failed to convert data")
        return 1


if __name__ == "__main__":
    exit(main())
