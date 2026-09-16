#!/usr/bin/env python3
"""
Fetch MERRA-2 Dust Extinction Data

Downloads dust extinction optical thickness from NASA MERRA-2 reanalysis.
Surface extinction is a direct measure of dust concentration at panel level,
more relevant than AOD (which is column-integrated).

MERRA-2 Collection: M2T1NXAER (Aerosol Optical Depth Analysis)
Variables:
- DUEXTTAU: Dust Extinction AOD [550 nm] (unitless)
- DUEXTT25: Dust Extinction AOD [550 nm] - PM2.5 (fine dust)
- DUSCATAU: Dust Scattering AOD [550 nm]

Data source: https://goldsmr4.gesdisc.eosdis.nasa.gov/data/MERRA2/M2T1NXAER.5.12.4/
Requires: NASA Earthdata account (free at https://urs.earthdata.nasa.gov/)

Usage:
    python scripts/fetch_merra2_extinction.py
    python scripts/fetch_merra2_extinction.py --plant-id gamma
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import requests


# MERRA-2 configuration
MERRA2_BASE_URL = "https://goldsmr4.gesdisc.eosdis.nasa.gov/opendap/MERRA2/M2T1NXAER.5.12.4"

# Extinction variables
EXTINCTION_VARS = [
    "DUEXTTAU",   # Dust Extinction AOD [550 nm]
    "DUEXTT25",   # Dust Extinction AOD [550 nm] - PM2.5
    "DUSCATAU",   # Dust Scattering AOD [550 nm]
    "SSEXTTAU",   # Sea Salt Extinction AOD [550 nm] - useful for coastal plants
]

# Plant coordinates
PLANTS = {
    "epsilon": {"lat": 51.195, "lon": 14.509, "name": "Epsilon (DE)"},
    "ribera": {"lat": 37.927, "lon": -1.233, "name": "Ribera (ES)"},
    "eta": {"lat": 38.66, "lon": -5.39, "name": "Eta (ES)"},
    "delta": {"lat": 39.6544, "lon": 2.6978, "name": "Delta (ES)"},
    "zeta": {"lat": 39.525, "lon": 3.187, "name": "Zeta (ES)"},
    "gamma": {"lat": 39.489, "lon": 2.916, "name": "Gamma (ES)"},
    "alpha": {"lat": 37.8145, "lon": -3.8047, "name": "Alpha (ES)"},
}


def get_earthdata_session() -> requests.Session:
    """Create an authenticated session for NASA Earthdata."""
    session = requests.Session()

    # Try bearer token first (from environment)
    token = os.environ.get("EARTHDATA_TOKEN")
    if token:
        session.headers.update({"Authorization": f"Bearer {token}"})
        adapter = requests.adapters.HTTPAdapter(max_retries=3)
        session.mount('https://', adapter)
        return session

    # Fall back to username/password
    username = os.environ.get("EARTHDATA_USERNAME")
    password = os.environ.get("EARTHDATA_PASSWORD")

    if not (username and password):
        netrc_path = Path.home() / ".netrc"
        if netrc_path.exists():
            import netrc
            try:
                auth = netrc.netrc().authenticators("urs.earthdata.nasa.gov")
                if auth:
                    username, password = auth[0], auth[2]
            except Exception:
                pass

    if not (username and password):
        print("NASA Earthdata credentials required.")
        print("\nOption 1: Set environment variable (Bearer token):")
        print("  export EARTHDATA_TOKEN=your_token")
        print("\nOption 2: Set environment variables (username/password):")
        print("  export EARTHDATA_USERNAME=your_username")
        print("  export EARTHDATA_PASSWORD=your_password")
        print("\nOption 3: Add to ~/.netrc:")
        print("  machine urs.earthdata.nasa.gov")
        print("      login your_username")
        print("      password your_password")
        print("\nRegister at: https://urs.earthdata.nasa.gov/")
        sys.exit(1)

    session.auth = (username, password)
    adapter = requests.adapters.HTTPAdapter(max_retries=3)
    session.mount('https://', adapter)

    return session


def get_merra2_file_for_date(date: datetime) -> str:
    """Get the MERRA-2 filename for a specific date."""
    year = date.year

    if year < 1992:
        stream = "100"
    elif year < 2001:
        stream = "200"
    elif year < 2011:
        stream = "300"
    else:
        stream = "400"

    return f"MERRA2_{stream}.tavg1_2d_aer_Nx.{year:04d}{date.month:02d}{date.day:02d}.nc4"


def find_nearest_grid_indices(lat: float, lon: float) -> tuple:
    """Find the nearest MERRA-2 grid indices."""
    lat_idx = int(round((lat + 90) / 0.5))
    lat_idx = max(0, min(360, lat_idx))

    lon_idx = int(round((lon + 180) / 0.625))
    lon_idx = max(0, min(575, lon_idx))

    return lat_idx, lon_idx


def fetch_merra2_daily(date: datetime, lat: float, lon: float, session: requests.Session) -> Optional[dict]:
    """Fetch MERRA-2 extinction data for a single day."""
    filename = get_merra2_file_for_date(date)
    year = date.year
    month = date.month

    lat_idx, lon_idx = find_nearest_grid_indices(lat, lon)

    base_url = f"{MERRA2_BASE_URL}/{year:04d}/{month:02d}/{filename}"

    # Build OPeNDAP subset request
    var_subsets = []
    for var in EXTINCTION_VARS:
        var_subsets.append(f"{var}[0:23][{lat_idx}][{lon_idx}]")

    subset_str = ",".join(var_subsets)
    url = f"{base_url}.ascii?{subset_str}"

    try:
        response = session.get(url, timeout=120, allow_redirects=True)

        if response.status_code == 404:
            return None

        if response.status_code == 401:
            print(f"  Authentication failed.")
            return None

        if response.status_code != 200:
            return None

        # Parse ASCII response
        text = response.text
        data = {}

        for var in EXTINCTION_VARS:
            try:
                start_idx = text.find(f"{var}[24]")
                if start_idx == -1:
                    continue

                end_idx = text.find("\n\n", start_idx)
                var_section = text[start_idx:end_idx]

                # Extract values
                values = []
                for line in var_section.split('\n')[1:]:
                    line = line.strip()
                    if line and not line.startswith(var):
                        parts = line.split(',')
                        for part in parts:
                            part = part.strip()
                            if part:
                                try:
                                    values.append(float(part))
                                except ValueError:
                                    pass

                if values:
                    # Daily mean
                    data[var] = float(np.mean(values))

            except Exception:
                pass

        if not data:
            return None

        return {
            'date': date.strftime('%Y-%m-%d'),
            'dust_extinction': data.get('DUEXTTAU'),
            'dust_extinction_pm25': data.get('DUEXTT25'),
            'dust_scattering': data.get('DUSCATAU'),
            'seasalt_extinction': data.get('SSEXTTAU'),
        }

    except Exception as e:
        print(f"  Error fetching {date}: {e}")
        return None


def fetch_extinction_data(lat: float, lon: float, start_date: str, end_date: str) -> dict:
    """Fetch MERRA-2 extinction data for date range."""
    session = get_earthdata_session()

    start_dt = datetime.strptime(start_date, '%Y-%m-%d')
    end_dt = datetime.strptime(end_date, '%Y-%m-%d')

    print(f"\nFetching MERRA-2 Dust Extinction data:")
    print(f"  Location: ({lat}, {lon})")
    print(f"  Period: {start_date} to {end_date}")
    print(f"  Variables: DUEXTTAU, DUEXTT25, DUSCATAU, SSEXTTAU")

    daily_data = []
    current = start_dt
    total_days = (end_dt - start_dt).days + 1
    fetched = 0

    while current <= end_dt:
        result = fetch_merra2_daily(current, lat, lon, session)

        if result:
            daily_data.append(result)
            fetched += 1

        if (current - start_dt).days % 30 == 0:
            print(f"  Progress: {(current - start_dt).days}/{total_days} days, {fetched} successful")

        current += timedelta(days=1)

    print(f"  Fetched {fetched}/{total_days} days")

    # Calculate statistics
    dust_ext = [d['dust_extinction'] for d in daily_data if d['dust_extinction']]
    seasalt_ext = [d['seasalt_extinction'] for d in daily_data if d['seasalt_extinction']]

    return {
        'metadata': {
            'latitude': lat,
            'longitude': lon,
            'period': {'start': start_date, 'end': end_date},
            'source': 'MERRA-2 M2T1NXAER',
            'generated_at': datetime.now().isoformat(),
        },
        'daily_data': daily_data,
        'statistics': {
            'total_days': len(daily_data),
            'avg_dust_extinction': round(np.mean(dust_ext), 6) if dust_ext else None,
            'max_dust_extinction': round(np.max(dust_ext), 6) if dust_ext else None,
            'avg_seasalt_extinction': round(np.mean(seasalt_ext), 6) if seasalt_ext else None,
        }
    }


def fetch_all_plants(start_date: str = None, end_date: str = None):
    """Fetch extinction data for all plants."""

    if not end_date:
        end_date = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
    if not start_date:
        start_date = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")

    print(f"\n{'='*60}")
    print(f"FETCHING MERRA-2 EXTINCTION FOR ALL PLANTS")
    print(f"Period: {start_date} to {end_date}")
    print(f"{'='*60}")

    for plant_id, coords in PLANTS.items():
        print(f"\n--- {plant_id.upper()} ({coords['name']}) ---")

        try:
            data = fetch_extinction_data(
                coords["lat"], coords["lon"],
                start_date, end_date
            )

            # Save
            output_dir = Path(f"public/data/soiling/{plant_id}")
            output_dir.mkdir(parents=True, exist_ok=True)

            output_path = output_dir / "merra2_extinction.json"
            with open(output_path, 'w') as f:
                json.dump(data, f, indent=2)

            stats = data['statistics']
            print(f"  ✓ Saved to {output_path}")
            print(f"    Days: {stats['total_days']}")
            print(f"    Avg dust extinction: {stats['avg_dust_extinction']}")
            print(f"    Avg sea salt extinction: {stats['avg_seasalt_extinction']}")

        except Exception as e:
            print(f"  ✗ Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Fetch MERRA-2 dust extinction")
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
        end_date = args.end_date or (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
        start_date = args.start_date or (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")

        data = fetch_extinction_data(coords["lat"], coords["lon"], start_date, end_date)

        output_dir = Path(f"public/data/soiling/{args.plant_id}")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "merra2_extinction.json"

        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)

        print(f"\n✓ Saved to {output_path}")
    else:
        fetch_all_plants(args.start_date, args.end_date)


if __name__ == "__main__":
    main()
