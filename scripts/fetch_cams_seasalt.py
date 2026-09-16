#!/usr/bin/env python3
"""
Fetch Sea Salt AOD from CAMS Global Reanalysis.

Sea salt is a major soiling contributor for coastal plants (25-35% of soiling events).
This data is NOT available via Open-Meteo, must use CAMS directly.

CAMS Collection: cams-global-reanalysis-eac4
Variables:
- sea_salt_aerosol_optical_depth_550nm (ssaod550)
- organic_matter_aerosol_optical_depth_550nm (omaod550) - agricultural
- sulphate_aerosol_optical_depth_550nm (suaod550) - industrial

Setup:
    1. Register at: https://ads.atmosphere.copernicus.eu/
    2. Get API key from profile page
    3. Install: pip install cdsapi
    4. Configure ~/.cdsapirc with UID and API key

Usage:
    python scripts/fetch_cams_seasalt.py
    python scripts/fetch_cams_seasalt.py --plant-id gamma
"""

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import cdsapi
    CDS_AVAILABLE = True
except ImportError:
    CDS_AVAILABLE = False
    print("\n⚠️  cdsapi not installed. Install with: pip install cdsapi")


# Plant coordinates - coastal plants will benefit most
PLANTS = {
    "epsilon": {"lat": 51, "lon": 14.5, "name": "Epsilon (DE)", "coastal": False},
    "ribera": {"lat": 38, "lon": -1, "name": "Ribera (ES)", "coastal": True},
    "eta": {"lat": 38.5, "lon": -5.5, "name": "Eta (ES)", "coastal": False},
    "delta": {"lat": 39.5, "lon": 2.5, "name": "Delta (ES)", "coastal": True},
    "zeta": {"lat": 39.5, "lon": 3, "name": "Zeta (ES)", "coastal": True},
    "gamma": {"lat": 39.5, "lon": 3, "name": "Gamma (ES)", "coastal": True},
    "alpha": {"lat": 38, "lon": -4, "name": "Alpha (ES)", "coastal": False},
}


def fetch_cams_seasalt(latitude: float, longitude: float, start_date: str, end_date: str) -> dict:
    """
    Fetch CAMS sea salt and other aerosol speciation data.

    Returns daily values for:
    - Sea salt AOD
    - Organic matter AOD (agricultural)
    - Sulphate AOD (industrial)
    """
    if not CDS_AVAILABLE:
        raise ImportError("cdsapi required. Install with: pip install cdsapi")

    # Fix SSL on macOS
    import os
    try:
        import certifi
        os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
        os.environ['SSL_CERT_FILE'] = certifi.where()
    except ImportError:
        pass

    client = cdsapi.Client()

    print(f"\nFetching CAMS Aerosol Speciation data:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_date} to {end_date}")
    print(f"  Variables: sea_salt, organic_matter, sulphate AOD")

    # CAMS expects specific date format
    request = {
        'variable': [
            'sea_salt_aerosol_optical_depth_550nm',
            'organic_matter_aerosol_optical_depth_550nm',
            'sulphate_aerosol_optical_depth_550nm',
            'total_aerosol_optical_depth_550nm',  # For reference
        ],
        'date': f'{start_date}/{end_date}',
        'time': ['12:00'],  # Noon only for daily value
        'area': [latitude + 0.5, longitude - 0.5, latitude - 0.5, longitude + 0.5],
        'format': 'netcdf',
    }

    temp_file = f'/tmp/cams_seasalt_{latitude}_{longitude}.nc'

    print(f"\nDownloading from CAMS (may take 2-5 minutes)...")

    try:
        client.retrieve('cams-global-reanalysis-eac4', request, temp_file)
    except Exception as e:
        print(f"Error downloading: {e}")
        return None

    # Process NetCDF
    try:
        import xarray as xr
        ds = xr.open_dataset(temp_file)

        # Get nearest grid point
        ds_point = ds.sel(latitude=latitude, longitude=longitude, method='nearest')

        # Get time coordinate
        time_coord = 'valid_time' if 'valid_time' in ds_point.coords else 'time'
        times = ds_point[time_coord].values

        # Variable mapping
        var_map = {
            'ssaod550': 'sea_salt_aod',
            'omaod550': 'organic_matter_aod',
            'suaod550': 'sulphate_aod',
            'aod550': 'total_aod',
        }

        daily_data = []
        for i, t in enumerate(times):
            date_str = pd.Timestamp(t).strftime('%Y-%m-%d')

            row = {'date': date_str}
            for nc_var, out_name in var_map.items():
                if nc_var in ds_point:
                    val = float(ds_point[nc_var].values[i])
                    row[out_name] = round(val, 6) if not np.isnan(val) else None

            # Calculate relative contributions
            total = row.get('total_aod')
            if total and total > 0:
                row['sea_salt_pct'] = round(row.get('sea_salt_aod', 0) / total * 100, 1)
                row['organic_pct'] = round(row.get('organic_matter_aod', 0) / total * 100, 1)
                row['sulphate_pct'] = round(row.get('sulphate_aod', 0) / total * 100, 1)

            daily_data.append(row)

        ds.close()
        Path(temp_file).unlink()

        # Statistics
        ss_values = [d['sea_salt_aod'] for d in daily_data if d.get('sea_salt_aod')]
        om_values = [d['organic_matter_aod'] for d in daily_data if d.get('organic_matter_aod')]
        su_values = [d['sulphate_aod'] for d in daily_data if d.get('sulphate_aod')]

        return {
            'metadata': {
                'latitude': latitude,
                'longitude': longitude,
                'period': {'start': start_date, 'end': end_date},
                'source': 'CAMS Global Reanalysis EAC4',
                'generated_at': datetime.now().isoformat(),
            },
            'daily_data': daily_data,
            'statistics': {
                'total_days': len(daily_data),
                'avg_sea_salt_aod': round(np.mean(ss_values), 6) if ss_values else None,
                'max_sea_salt_aod': round(np.max(ss_values), 6) if ss_values else None,
                'avg_organic_aod': round(np.mean(om_values), 6) if om_values else None,
                'avg_sulphate_aod': round(np.mean(su_values), 6) if su_values else None,
            }
        }

    except ImportError:
        print("xarray required. Install with: pip install xarray netCDF4")
        return None
    except Exception as e:
        print(f"Error processing: {e}")
        return None


def fetch_all_plants(start_date: str = None, end_date: str = None):
    """Fetch sea salt AOD for all plants."""

    if not end_date:
        end_date = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d")
    if not start_date:
        # 1 year of data (CAMS has ~5 day latency)
        start_date = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")

    print(f"\n{'='*60}")
    print(f"FETCHING CAMS SEA SALT AOD FOR ALL PLANTS")
    print(f"Period: {start_date} to {end_date}")
    print(f"{'='*60}")

    for plant_id, coords in PLANTS.items():
        print(f"\n--- {plant_id.upper()} ({coords['name']}) ---")
        if coords['coastal']:
            print(f"  [COASTAL] - Sea salt likely significant")
        else:
            print(f"  [INLAND] - Sea salt less important")

        try:
            data = fetch_cams_seasalt(
                coords["lat"], coords["lon"],
                start_date, end_date
            )

            if data:
                output_dir = Path(f"public/data/soiling/{plant_id}")
                output_dir.mkdir(parents=True, exist_ok=True)

                output_path = output_dir / "cams_aerosol_speciation.json"
                with open(output_path, 'w') as f:
                    json.dump(data, f, indent=2)

                stats = data['statistics']
                print(f"  ✓ Saved to {output_path}")
                print(f"    Days: {stats['total_days']}")
                print(f"    Avg sea salt AOD: {stats['avg_sea_salt_aod']}")
                print(f"    Avg organic AOD: {stats['avg_organic_aod']}")
                print(f"    Avg sulphate AOD: {stats['avg_sulphate_aod']}")

        except Exception as e:
            print(f"  ✗ Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Fetch CAMS sea salt AOD")
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
        end_date = args.end_date or (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d")
        start_date = args.start_date or (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")

        data = fetch_cams_seasalt(coords["lat"], coords["lon"], start_date, end_date)

        if data:
            output_dir = Path(f"public/data/soiling/{args.plant_id}")
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / "cams_aerosol_speciation.json"

            with open(output_path, 'w') as f:
                json.dump(data, f, indent=2)

            print(f"\n✓ Saved to {output_path}")
    else:
        fetch_all_plants(args.start_date, args.end_date)


if __name__ == "__main__":
    main()
