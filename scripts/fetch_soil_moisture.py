#!/usr/bin/env python3
"""
Fetch soil moisture data from ERA5-Land reanalysis.

Soil moisture is a key indicator of dust availability for soiling prediction:
- Dry soil = more dust available for transport
- Wet soil = dust particles bound to ground

ERA5-Land Variables:
- volumetric_soil_water_layer_1: 0-7cm depth (most relevant for surface dust)
- volumetric_soil_water_layer_2: 7-28cm depth

Spatial Resolution: 9 km (0.1° x 0.1°)
Temporal Resolution: Hourly (aggregated to daily)
Coverage: 1950-present with ~5 day latency

Setup:
    1. Register at: https://cds.climate.copernicus.eu/user/register
    2. Get API key: https://cds.climate.copernicus.eu/how-to-api
    3. Install: pip install cdsapi
    4. Configure: ~/.cdsapirc with your UID and API key

Usage:
    python scripts/fetch_soil_moisture.py
    python scripts/fetch_soil_moisture.py --plant-id gamma
"""

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import cdsapi
    CDS_AVAILABLE = True
except ImportError:
    CDS_AVAILABLE = False
    print("\n⚠️  WARNING: cdsapi not installed")
    print("Install with: pip install cdsapi")
    print("Register at: https://cds.climate.copernicus.eu/user/register\n")


# Plant coordinates
PLANTS = {
    "epsilon": {"lat": 51, "lon": 14.5, "name": "Epsilon (DE)"},
    "ribera": {"lat": 38, "lon": -1, "name": "Ribera (ES)"},
    "eta": {"lat": 38.5, "lon": -5.5, "name": "Eta (ES)"},
    "delta": {"lat": 39.5, "lon": 2.5, "name": "Delta (ES)"},
    "zeta": {"lat": 39.5, "lon": 3, "name": "Zeta (ES)"},
    "gamma": {"lat": 39.5, "lon": 3, "name": "Gamma (ES)"},
    "alpha": {"lat": 38, "lon": -4, "name": "Alpha (ES)"},
}


def fetch_soil_moisture(latitude: float, longitude: float, start_date: str, end_date: str) -> dict:
    """
    Fetch ERA5-Land soil moisture data.

    Returns daily aggregated soil moisture (0-7cm layer).
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
        pass

    client = cdsapi.Client()

    # Parse dates
    import pandas as pd
    start_dt = pd.Timestamp(start_date)
    end_dt = pd.Timestamp(end_date)

    years = list(range(start_dt.year, end_dt.year + 1))
    months = [f"{m:02d}" for m in range(1, 13)]
    days = [f"{d:02d}" for d in range(1, 32)]
    # Use noon only for daily value (representative of daytime conditions)
    times = ["12:00"]

    print(f"\nFetching ERA5-Land Soil Moisture data:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_date} to {end_date}")
    print(f"  Variable: volumetric_soil_water_layer_1 (0-7cm)")

    # Define bounding box
    area = [
        latitude + 0.1,   # North
        longitude - 0.1,  # West
        latitude - 0.1,   # South
        longitude + 0.1   # East
    ]

    request = {
        'variable': [
            'volumetric_soil_water_layer_1',  # 0-7cm (surface)
            'volumetric_soil_water_layer_2',  # 7-28cm (root zone)
        ],
        'year': [str(y) for y in years],
        'month': months,
        'day': days,
        'time': times,
        'area': area,
        'format': 'netcdf',
    }

    # Download to temp file
    temp_file = Path(f"/tmp/soil_moisture_{latitude}_{longitude}.nc")

    print(f"\nDownloading data...")
    try:
        client.retrieve('reanalysis-era5-land', request, str(temp_file))
    except Exception as e:
        print(f"Error downloading data: {e}")
        return None

    # Process NetCDF file
    try:
        import xarray as xr
        ds = xr.open_dataset(temp_file)

        # Extract values at the nearest grid point
        swvl1 = ds['swvl1'].values  # 0-7cm layer
        swvl2 = ds['swvl2'].values  # 7-28cm layer
        times = ds['time'].values

        # Convert to daily data
        daily_data = []
        for i, t in enumerate(times):
            date = pd.Timestamp(t).strftime('%Y-%m-%d')

            # Get value at center point (mean of small area)
            sm1 = float(np.nanmean(swvl1[i]))  # m³/m³
            sm2 = float(np.nanmean(swvl2[i]))  # m³/m³

            # Derived features
            # "Dry" if soil moisture < 0.15 m³/m³ (typical threshold)
            is_dry = sm1 < 0.15

            daily_data.append({
                'date': date,
                'soil_moisture_0_7cm': round(sm1, 4) if not np.isnan(sm1) else None,
                'soil_moisture_7_28cm': round(sm2, 4) if not np.isnan(sm2) else None,
                'is_dry_soil': is_dry,
            })

        ds.close()
        temp_file.unlink()  # Clean up

        return {
            'daily_data': daily_data,
            'metadata': {
                'latitude': latitude,
                'longitude': longitude,
                'period': {'start': start_date, 'end': end_date},
                'source': 'ERA5-Land',
                'variables': ['volumetric_soil_water_layer_1', 'volumetric_soil_water_layer_2'],
                'generated_at': datetime.now().isoformat(),
            }
        }

    except ImportError:
        print("xarray required to process NetCDF. Install with: pip install xarray netCDF4")
        return None
    except Exception as e:
        print(f"Error processing data: {e}")
        return None


def fetch_all_plants(start_date: str = None, end_date: str = None):
    """Fetch soil moisture for all plants."""

    if not end_date:
        end_date = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d")
    if not start_date:
        # 2 years of data
        start_date = (datetime.now() - timedelta(days=2*365)).strftime("%Y-%m-%d")

    print(f"\n{'='*60}")
    print(f"FETCHING SOIL MOISTURE FOR ALL PLANTS")
    print(f"Period: {start_date} to {end_date}")
    print(f"{'='*60}")

    for plant_id, coords in PLANTS.items():
        print(f"\n--- {plant_id.upper()} ({coords['name']}) ---")

        try:
            data = fetch_soil_moisture(
                coords["lat"], coords["lon"],
                start_date, end_date
            )

            if data:
                # Save
                output_dir = Path(f"public/data/soiling/{plant_id}")
                output_dir.mkdir(parents=True, exist_ok=True)

                output_path = output_dir / "soil_moisture.json"
                with open(output_path, 'w') as f:
                    json.dump(data, f, indent=2)

                # Stats
                daily = data['daily_data']
                sm_values = [d['soil_moisture_0_7cm'] for d in daily if d['soil_moisture_0_7cm'] is not None]
                dry_days = sum(1 for d in daily if d['is_dry_soil'])

                print(f"  ✓ Saved to {output_path}")
                print(f"    Days: {len(daily)}")
                print(f"    Avg soil moisture: {np.mean(sm_values):.3f} m³/m³")
                print(f"    Dry days (<0.15): {dry_days} ({dry_days/len(daily)*100:.1f}%)")
            else:
                print(f"  ✗ Failed to fetch data")

        except Exception as e:
            print(f"  ✗ Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Fetch ERA5-Land soil moisture")
    parser.add_argument("--plant-id", help="Specific plant (or 'all')")
    parser.add_argument("--start-date", help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="End date (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.plant_id and args.plant_id != "all":
        if args.plant_id not in PLANTS:
            print(f"Unknown plant: {args.plant_id}")
            print(f"Available: {', '.join(PLANTS.keys())}")
            return

        coords = PLANTS[args.plant_id]
        end_date = args.end_date or (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d")
        start_date = args.start_date or (datetime.now() - timedelta(days=2*365)).strftime("%Y-%m-%d")

        data = fetch_soil_moisture(coords["lat"], coords["lon"], start_date, end_date)

        if data:
            output_dir = Path(f"public/data/soiling/{args.plant_id}")
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / "soil_moisture.json"

            with open(output_path, 'w') as f:
                json.dump(data, f, indent=2)

            print(f"\n✓ Saved to {output_path}")
    else:
        fetch_all_plants(args.start_date, args.end_date)


if __name__ == "__main__":
    main()
