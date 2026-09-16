#!/usr/bin/env python3
"""
Fetch MERRA-2 Dust Deposition Data

Downloads dust deposition data from NASA MERRA-2 reanalysis for use in
soiling prediction models. The dust deposition rate (g/m²/day) is directly
relevant to soiling accumulation on solar panels.

MERRA-2 Collection: M2T1NXADG (Aerosol Diagnostics)
Variables:
- DUDP001-DUDP005: Dust deposition for 5 particle size bins (kg/m²/s)
- Combined into total dust deposition and converted to g/m²/day

Data source: https://goldsmr4.gesdisc.eosdis.nasa.gov/data/MERRA2/M2T1NXADG.5.12.4/
Requires: NASA Earthdata account (free registration at https://urs.earthdata.nasa.gov/)

Usage:
    python fetch_merra2_dust_deposition.py --lat 37.9 --lon -1.1 --start 2023-01-01 --end 2024-12-31

Output:
- datasets/merra2_dust/{plant_name}_dust_deposition.csv
"""

import argparse
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import requests


# MERRA-2 configuration
MERRA2_BASE_URL = "https://goldsmr4.gesdisc.eosdis.nasa.gov/opendap/MERRA2/M2T1NXADG.5.12.4"

# Dust deposition variables (kg/m²/s for each size bin)
DUST_VARS = [
    "DUDP001",  # Dust Dry Deposition Bin 001 (0.1-1.0 μm)
    "DUDP002",  # Dust Dry Deposition Bin 002 (1.0-1.8 μm)
    "DUDP003",  # Dust Dry Deposition Bin 003 (1.8-3.0 μm)
    "DUDP004",  # Dust Dry Deposition Bin 004 (3.0-6.0 μm)
    "DUDP005",  # Dust Dry Deposition Bin 005 (6.0-10.0 μm)
]

# Additional useful variables
EXTRA_VARS = [
    "DUSD001",  # Dust Sedimentation Bin 001
    "DUSD002",  # Dust Sedimentation Bin 002
    "DUSD003",  # Dust Sedimentation Bin 003
    "DUSD004",  # Dust Sedimentation Bin 004
    "DUSD005",  # Dust Sedimentation Bin 005
    "DUWT001",  # Dust Wet Deposition Bin 001
    "DUWT002",  # Dust Wet Deposition Bin 002
    "DUWT003",  # Dust Wet Deposition Bin 003
    "DUWT004",  # Dust Wet Deposition Bin 004
    "DUWT005",  # Dust Wet Deposition Bin 005
]

# Conversion factor: kg/m²/s -> g/m²/day
KG_PER_S_TO_G_PER_DAY = 1000 * 86400  # 1 kg = 1000 g, 1 day = 86400 s


def get_earthdata_session() -> requests.Session:
    """
    Create an authenticated session for NASA Earthdata.

    Uses the .netrc file for credentials (recommended by NASA).
    Setup: Add to ~/.netrc:
        machine urs.earthdata.nasa.gov
            login <your_username>
            password <your_password>
    """
    session = requests.Session()

    # Check for credentials
    username = os.environ.get("EARTHDATA_USERNAME")
    password = os.environ.get("EARTHDATA_PASSWORD")

    if not (username and password):
        # Try to read from .netrc
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
        print("\nOption 1: Set environment variables:")
        print("  export EARTHDATA_USERNAME=your_username")
        print("  export EARTHDATA_PASSWORD=your_password")
        print("\nOption 2: Add to ~/.netrc:")
        print("  machine urs.earthdata.nasa.gov")
        print("      login your_username")
        print("      password your_password")
        print("\nRegister at: https://urs.earthdata.nasa.gov/")
        sys.exit(1)

    # Setup session with redirect handling for NASA OAuth
    session.auth = (username, password)

    # NASA uses redirects for authentication
    # We need to handle this properly
    adapter = requests.adapters.HTTPAdapter(max_retries=3)
    session.mount('https://', adapter)

    return session


def get_merra2_file_for_date(date: datetime) -> str:
    """Get the MERRA-2 filename for a specific date."""
    # MERRA-2 filenames follow pattern: MERRA2_400.tavg1_2d_aer_Nx.YYYYMMDD.nc4
    # The stream ID (400) may vary based on date
    year = date.year
    month = date.month
    day = date.day

    # Determine stream ID based on date
    if year < 1992:
        stream = "100"
    elif year < 2001:
        stream = "200"
    elif year < 2011:
        stream = "300"
    else:
        stream = "400"

    return f"MERRA2_{stream}.tavg1_2d_aer_Nx.{year:04d}{month:02d}{day:02d}.nc4"


def find_nearest_grid_indices(lat: float, lon: float) -> tuple[int, int]:
    """
    Find the nearest MERRA-2 grid indices for given lat/lon.

    MERRA-2 grid:
    - Latitude: -90 to 90, 0.5° resolution (361 points)
    - Longitude: -180 to 179.375, 0.625° resolution (576 points)
    """
    # Latitude index
    lat_idx = int(round((lat + 90) / 0.5))
    lat_idx = max(0, min(360, lat_idx))

    # Longitude index
    lon_idx = int(round((lon + 180) / 0.625))
    lon_idx = max(0, min(575, lon_idx))

    return lat_idx, lon_idx


def fetch_merra2_daily(
    date: datetime,
    lat: float,
    lon: float,
    session: requests.Session
) -> Optional[dict]:
    """
    Fetch MERRA-2 dust deposition data for a single day.

    Uses OPeNDAP to extract just the needed grid point.
    """
    filename = get_merra2_file_for_date(date)
    year = date.year
    month = date.month

    # Find grid indices
    lat_idx, lon_idx = find_nearest_grid_indices(lat, lon)

    # Build OPeNDAP URL for subset
    base_url = f"{MERRA2_BASE_URL}/{year:04d}/{month:02d}/{filename}"

    # Request all dust deposition variables for this point
    # OPeNDAP subset: variable[time][lat][lon]
    # We want all 24 hours, single lat/lon point
    var_subsets = []
    all_vars = DUST_VARS + EXTRA_VARS
    for var in all_vars:
        var_subsets.append(f"{var}[0:23][{lat_idx}][{lon_idx}]")

    subset_str = ",".join(var_subsets)
    url = f"{base_url}.ascii?{subset_str}"

    try:
        response = session.get(url, timeout=120, allow_redirects=True)

        if response.status_code == 404:
            # File not available for this date
            return None

        if response.status_code == 401:
            print(f"  Authentication failed. Check your Earthdata credentials.")
            return None

        response.raise_for_status()

        # Parse ASCII response
        data = parse_opendap_ascii(response.text, all_vars)
        data['date'] = date.strftime('%Y-%m-%d')
        data['latitude'] = lat
        data['longitude'] = lon

        return data

    except requests.RequestException as e:
        print(f"  Warning: Failed to fetch {date}: {e}")
        return None


def parse_opendap_ascii(text: str, variables: list[str]) -> dict:
    """Parse OPeNDAP ASCII response into dictionary of daily values."""
    result = {}

    # The ASCII format is structured with variable names followed by data
    # Example:
    # DUDP001, [24][1][1]
    # [0], 1.2e-10
    # [1], 1.3e-10
    # ...

    lines = text.strip().split('\n')
    current_var = None
    values = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Check if this is a variable header
        for var in variables:
            if line.startswith(var):
                # Save previous variable
                if current_var and values:
                    # Compute daily mean (24 hourly values)
                    daily_mean = np.mean(values)
                    result[current_var] = daily_mean

                current_var = var
                values = []
                break
        else:
            # Try to extract value from data line
            if current_var and ',' in line:
                try:
                    val_str = line.split(',')[-1].strip()
                    values.append(float(val_str))
                except (ValueError, IndexError):
                    pass

    # Save last variable
    if current_var and values:
        daily_mean = np.mean(values)
        result[current_var] = daily_mean

    return result


def compute_derived_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute derived features from raw dust deposition variables."""
    # Sum all dry deposition bins for total dry deposition
    dry_dep_cols = [c for c in df.columns if c.startswith('DUDP')]
    if dry_dep_cols:
        df['dust_dry_deposition_total'] = df[dry_dep_cols].sum(axis=1)

    # Sum all wet deposition bins
    wet_dep_cols = [c for c in df.columns if c.startswith('DUWT')]
    if wet_dep_cols:
        df['dust_wet_deposition_total'] = df[wet_dep_cols].sum(axis=1)

    # Sum all sedimentation bins
    sed_cols = [c for c in df.columns if c.startswith('DUSD')]
    if sed_cols:
        df['dust_sedimentation_total'] = df[sed_cols].sum(axis=1)

    # Total dust deposition (dry + wet + sedimentation)
    total_cols = ['dust_dry_deposition_total', 'dust_wet_deposition_total', 'dust_sedimentation_total']
    existing_total_cols = [c for c in total_cols if c in df.columns]
    if existing_total_cols:
        df['dust_total_deposition'] = df[existing_total_cols].sum(axis=1)

    # Convert from kg/m²/s to g/m²/day
    for col in df.columns:
        if col.startswith('DUDP') or col.startswith('DUWT') or col.startswith('DUSD') or col.startswith('dust_'):
            df[f'{col}_g_m2_day'] = df[col] * KG_PER_S_TO_G_PER_DAY

    return df


def fetch_merra2_range(
    lat: float,
    lon: float,
    start_date: datetime,
    end_date: datetime,
    plant_name: str = "plant"
) -> pd.DataFrame:
    """
    Fetch MERRA-2 dust deposition data for a date range.
    """
    session = get_earthdata_session()

    print(f"Fetching MERRA-2 dust deposition data")
    print(f"  Location: ({lat:.4f}, {lon:.4f})")
    print(f"  Period: {start_date.date()} to {end_date.date()}")

    records = []
    current_date = start_date

    total_days = (end_date - start_date).days + 1
    fetched = 0

    while current_date <= end_date:
        data = fetch_merra2_daily(current_date, lat, lon, session)

        if data:
            records.append(data)
            fetched += 1

        # Progress update every 30 days
        if (current_date - start_date).days % 30 == 0:
            progress = (current_date - start_date).days / total_days * 100
            print(f"  Progress: {progress:.1f}% ({fetched} days fetched)")

        current_date += timedelta(days=1)

    print(f"  Completed: {fetched}/{total_days} days fetched")

    if not records:
        print("  Warning: No data retrieved!")
        return pd.DataFrame()

    df = pd.DataFrame(records)
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').reset_index(drop=True)

    # Compute derived features
    df = compute_derived_features(df)

    return df


def save_data(df: pd.DataFrame, plant_name: str, output_dir: Path):
    """Save the dust deposition data."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save full data
    output_path = output_dir / f"{plant_name}_dust_deposition.csv"
    df.to_csv(output_path, index=False)
    print(f"Saved: {output_path} ({len(df)} days)")

    # Save metadata
    metadata = {
        'source': 'NASA MERRA-2 M2T1NXADG',
        'url': 'https://goldsmr4.gesdisc.eosdis.nasa.gov/data/MERRA2/M2T1NXADG.5.12.4/',
        'fetched_at': datetime.now().isoformat(),
        'plant_name': plant_name,
        'location': {
            'latitude': float(df['latitude'].iloc[0]) if len(df) > 0 else None,
            'longitude': float(df['longitude'].iloc[0]) if len(df) > 0 else None,
        },
        'date_range': {
            'start': df['date'].min().isoformat() if len(df) > 0 else None,
            'end': df['date'].max().isoformat() if len(df) > 0 else None,
        },
        'n_days': len(df),
        'variables': {
            'DUDP001-005': 'Dust Dry Deposition for 5 size bins (kg/m²/s)',
            'DUSD001-005': 'Dust Sedimentation for 5 size bins (kg/m²/s)',
            'DUWT001-005': 'Dust Wet Deposition for 5 size bins (kg/m²/s)',
            'dust_total_deposition_g_m2_day': 'Total dust deposition (g/m²/day)',
        },
        'conversion': 'kg/m²/s * 86400000 = g/m²/day',
    }

    import json
    metadata_path = output_dir / f"{plant_name}_metadata.json"
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2, default=str)
    print(f"Saved: {metadata_path}")


def print_summary(df: pd.DataFrame):
    """Print summary statistics."""
    print("\n" + "=" * 60)
    print("MERRA-2 DUST DEPOSITION SUMMARY")
    print("=" * 60)

    if len(df) == 0:
        print("No data available")
        return

    print(f"\nDate range: {df['date'].min().date()} to {df['date'].max().date()}")
    print(f"Total days: {len(df)}")

    # Key statistics
    if 'dust_total_deposition_g_m2_day' in df.columns:
        col = 'dust_total_deposition_g_m2_day'
        print(f"\nTotal Dust Deposition (g/m²/day):")
        print(f"  - Mean: {df[col].mean():.6f}")
        print(f"  - Median: {df[col].median():.6f}")
        print(f"  - Max: {df[col].max():.6f}")
        print(f"  - 95th percentile: {df[col].quantile(0.95):.6f}")

    if 'dust_dry_deposition_total_g_m2_day' in df.columns:
        col = 'dust_dry_deposition_total_g_m2_day'
        print(f"\nDry Dust Deposition (g/m²/day):")
        print(f"  - Mean: {df[col].mean():.6f}")
        print(f"  - Max: {df[col].max():.6f}")


def main():
    parser = argparse.ArgumentParser(description="Fetch MERRA-2 dust deposition data")
    parser.add_argument("--lat", type=float, required=True, help="Latitude")
    parser.add_argument("--lon", type=float, required=True, help="Longitude")
    parser.add_argument("--start", type=str, required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", type=str, required=True, help="End date (YYYY-MM-DD)")
    parser.add_argument("--name", type=str, default="plant", help="Plant name for output files")
    parser.add_argument("--output", type=str, default=None, help="Output directory")

    args = parser.parse_args()

    start_date = datetime.strptime(args.start, "%Y-%m-%d")
    end_date = datetime.strptime(args.end, "%Y-%m-%d")

    # Determine output directory
    if args.output:
        output_dir = Path(args.output)
    else:
        script_dir = Path(__file__).parent.parent
        output_dir = script_dir / "datasets" / "merra2_dust"

    print("MERRA-2 Dust Deposition Fetcher")
    print("-" * 40)

    # Fetch data
    df = fetch_merra2_range(args.lat, args.lon, start_date, end_date, args.name)

    if len(df) > 0:
        # Save data
        save_data(df, args.name, output_dir)

        # Print summary
        print_summary(df)
    else:
        print("\nNo data retrieved. Check your credentials and date range.")

    print("\n" + "=" * 60)
    print("Done!")
    print("=" * 60)


if __name__ == "__main__":
    main()
