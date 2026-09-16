#!/usr/bin/env python3
"""
Fetch historical AOD data from CAMS Global Reanalysis (EAC4).

This script uses the Copernicus Atmosphere Data Store (ADS) to fetch
multi-year historical aerosol optical depth data for solar soiling analysis.

Setup:
    1. Register at: https://ads.atmosphere.copernicus.eu/user/register
    2. Get API key: https://ads.atmosphere.copernicus.eu/how-to-api
    3. Install: pip install cdsapi
    4. Configure: ~/.cdsapirc with your UID and API key

Usage:
    python scripts/fetch_cams_historical_aod.py --plant-id eta --start-date 2020-01-01
    python scripts/fetch_cams_historical_aod.py --plant-id ribera --start-date 2020-01-01 --end-date 2024-12-31
"""

import argparse
import json
from datetime import datetime
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


def fetch_cams_aod(latitude: float, longitude: float, start_year: int, end_year: int,
                   output_file: Path, temporal_resolution: str = 'daily') -> bool:
    """
    Fetch CAMS EAC4 aerosol optical depth data.

    Variables fetched:
    - total_aerosol_optical_depth_550nm: Total AOD
    - dust_aerosol_optical_depth_550nm: Dust AOD only
    - pm2p5: Particulate matter < 2.5 μm
    - pm10: Particulate matter < 10 μm

    Args:
        temporal_resolution: 'daily' (noon only), '3hourly' (8 times/day), 'hourly' (24 times/day)
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

    # Determine time values based on temporal resolution
    if temporal_resolution == 'daily':
        time_values = '12:00'  # Noon only
        time_desc = "daily at noon"
    elif temporal_resolution == '3hourly':
        time_values = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']
        time_desc = "3-hourly (8 times/day)"
    elif temporal_resolution == 'hourly':
        time_values = [f'{h:02d}:00' for h in range(24)]
        time_desc = "hourly (24 times/day)"
    else:
        raise ValueError(f"Invalid temporal_resolution: {temporal_resolution}")

    print(f"\nFetching CAMS EAC4 data:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_year}-{end_year}")
    print(f"  Temporal Resolution: {time_desc}")
    print(f"  Variables: AOD 550nm, Dust AOD, PM2.5, PM10")

    # Create date range string (API requires YYYY-MM-DD/YYYY-MM-DD format)
    start_date = f"{start_year}-01-01"
    end_date = f"{end_year}-12-31"

    # Define bounding box (0.5 degree around plant location)
    area = [
        latitude + 0.25,   # North
        longitude - 0.25,  # West
        latitude - 0.25,   # South
        longitude + 0.25   # East
    ]

    request = {
        'variable': [
            'total_aerosol_optical_depth_550nm',
            'dust_aerosol_optical_depth_550nm',
            'particulate_matter_2.5um',
            'particulate_matter_10um',
        ],
        'date': f'{start_date}/{end_date}',  # NEW API format
        'time': time_values,
        'area': area,  # [N, W, S, E]
        'format': 'netcdf',
    }

    print(f"\nDownloading data (this may take several minutes)...")
    temp_file = output_file.with_suffix('.nc')

    try:
        client.retrieve(
            'cams-global-reanalysis-eac4',
            request,
            str(temp_file)
        )
        print(f"✅ Downloaded: {temp_file}")
        return True
    except Exception as e:
        print(f"❌ Download failed: {e}")
        return False


def convert_netcdf_to_json(nc_file: Path, output_file: Path, plant_id: str,
                           latitude: float, longitude: float, temporal_resolution: str = 'daily'):
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

    # Get time coordinate (could be 'time' or 'valid_time')
    time_coord = 'valid_time' if 'valid_time' in data_point.coords else 'time'

    # Convert to temporal data (3-hourly or daily)
    temporal_data = []
    for time in data_point[time_coord].values:
        timestamp = pd.Timestamp(time)

        if temporal_resolution == 'daily':
            # Store date only for daily resolution
            time_key = timestamp.strftime('%Y-%m-%d')
        else:
            # Store full timestamp for sub-daily resolution
            time_key = timestamp.strftime('%Y-%m-%d %H:%M')

        # Extract values (handle NaN)
        aod_total = float(data_point['aod550'].sel({time_coord: time}).values)
        aod_dust = float(data_point['duaod550'].sel({time_coord: time}).values)

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
            "aod_550nm": round(aod_total, 4) if not np.isnan(aod_total) else None,
            "dust_aod_550nm": round(aod_dust, 4) if not np.isnan(aod_dust) else None,
            "pm2_5": pm2_5_estimate,
            "pm10": pm10_estimate,
            "dust": dust_estimate,  # Add dust estimate for Saharan dust
        }

        if temporal_resolution == 'daily':
            data_point_dict["date"] = time_key
        else:
            data_point_dict["timestamp"] = time_key

        temporal_data.append(data_point_dict)

    # Calculate statistics
    aod_values = [d['aod_550nm'] for d in temporal_data if d['aod_550nm'] is not None]
    dust_aod_values = [d['dust_aod_550nm'] for d in temporal_data if d['dust_aod_550nm'] is not None]

    # Determine time key for metadata
    time_key_field = 'date' if temporal_resolution == 'daily' else 'timestamp'
    temporal_desc = {
        'daily': 'Daily data at solar noon',
        '3hourly': '3-hourly data (00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, 21:00 UTC)',
        'hourly': 'Hourly data (all 24 hours)'
    }

    output = {
        "metadata": {
            "plant_id": plant_id,
            "latitude": float(latitude),
            "longitude": float(longitude),
            "source": "CAMS Global Reanalysis EAC4",
            "temporal_resolution": temporal_resolution,
            "period": {
                "start": temporal_data[0][time_key_field] if temporal_data else None,
                "end": temporal_data[-1][time_key_field] if temporal_data else None,
            },
            "variables": [
                "aod_550nm (Total aerosol optical depth at 550nm)",
                "dust_aod_550nm (Dust AOD only at 550nm)",
                "pm2_5 (μg/m³, AOD-derived estimate: AOD × 120)",
                "pm10 (μg/m³, AOD-derived estimate: AOD × 150)",
                "dust (μg/m³, AOD-derived estimate: Dust_AOD × 250)",
            ],
            "generated_at": datetime.now().isoformat(),
            "note": f"{temporal_desc.get(temporal_resolution, 'Temporal data')} from CAMS EAC4 reanalysis. PM concentrations are derived from AOD using standard atmospheric conversion factors."
        },
        "data": temporal_data,
        "statistics": {
            "total_records": len(temporal_data),
            "aod_mean": round(np.mean(aod_values), 4) if aod_values else None,
            "aod_std": round(np.std(aod_values), 4) if aod_values else None,
            "aod_max": round(max(aod_values), 4) if aod_values else None,
            "dust_aod_mean": round(np.mean(dust_aod_values), 4) if dust_aod_values else None,
            "high_dust_records": sum(1 for d in dust_aod_values if d > 0.2),  # AOD > 0.2 indicates high dust
        }
    }

    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"✅ Saved: {output_file}")
    print(f"\nStatistics:")
    print(f"  Total records: {output['statistics']['total_records']}")
    print(f"  Mean AOD: {output['statistics']['aod_mean']}")
    print(f"  Mean Dust AOD: {output['statistics']['dust_aod_mean']}")
    print(f"  High dust records: {output['statistics']['high_dust_records']}")

    # Clean up NetCDF file
    ds.close()
    nc_file.unlink()
    print(f"\n✅ Cleaned up temporary NetCDF file")

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Fetch historical AOD data from CAMS EAC4",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Default 3-hourly resolution
    python scripts/fetch_cams_historical_aod.py --plant-id eta --start-date 2020-01-01

    # Daily resolution (noon only)
    python scripts/fetch_cams_historical_aod.py --plant-id ribera --start-date 2020-01-01 --end-date 2024-12-31 --temporal-resolution daily

    # Hourly resolution (24 times/day)
    python scripts/fetch_cams_historical_aod.py --plant-id alpha1 --start-date 2020-01-01 --temporal-resolution hourly

Setup Instructions:
    1. Register: https://ads.atmosphere.copernicus.eu/user/register
    2. Get API key: https://ads.atmosphere.copernicus.eu/how-to-api
    3. Install: pip install cdsapi xarray netCDF4
    4. Create ~/.cdsapirc with your credentials:
       url: https://ads.atmosphere.copernicus.eu/api
       key: YOUR_UID:YOUR_API_KEY
        """
    )
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    parser.add_argument("--start-date", required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="End date (YYYY-MM-DD), default: today")
    parser.add_argument(
        "--temporal-resolution",
        choices=['daily', '3hourly', 'hourly'],
        default='3hourly',
        help="Temporal resolution: daily (noon only), 3hourly (8 times/day), hourly (24 times/day). Default: 3hourly"
    )
    args = parser.parse_args()

    # Parse dates and extract years
    start_dt = datetime.fromisoformat(args.start_date)
    end_dt = datetime.fromisoformat(args.end_date) if args.end_date else datetime.now()

    start_year = start_dt.year
    end_year = end_dt.year

    print(f"\n{'='*70}")
    print(f"FETCH CAMS HISTORICAL AOD DATA FOR {args.plant_id.upper()}")
    print(f"{'='*70}")

    # Load plant config
    config = load_plant_config(args.plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Output directory
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "cams_aod_history.json"
    temp_nc = output_dir / "cams_aod_history.nc"

    # Fetch data
    success = fetch_cams_aod(latitude, longitude, start_year, end_year, temp_nc, args.temporal_resolution)

    if success:
        # Convert to JSON
        convert_netcdf_to_json(temp_nc, output_file, args.plant_id, latitude, longitude, args.temporal_resolution)
        print(f"\n✅ Complete! Historical AOD data saved to: {output_file}")
    else:
        print("\n❌ Failed to fetch CAMS data")
        return 1

    return 0


if __name__ == "__main__":
    exit(main())
