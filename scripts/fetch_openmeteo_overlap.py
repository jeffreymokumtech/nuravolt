#!/usr/bin/env python3
"""
Fetch Open-Meteo AOD data for specific date range (for validation overlap).

Usage:
    python scripts/fetch_openmeteo_overlap.py --plant-id alpha1 --start-date 2024-10-01 --end-date 2024-12-31
"""

import argparse
import json
import requests
from datetime import datetime
from pathlib import Path
import yaml
import numpy as np


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def fetch_aod_data(latitude: float, longitude: float, start_date: str, end_date: str) -> dict:
    """Fetch AOD data for specific date range."""
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "aerosol_optical_depth",
        "start_date": start_date,
        "end_date": end_date,
        "timezone": "auto"
    }

    print(f"Fetching AOD data from Open-Meteo...")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Date range: {start_date} to {end_date}")

    response = requests.get(url, params=params)
    response.raise_for_status()

    return response.json()


def aggregate_hourly_to_daily(api_data: dict) -> list:
    """Aggregate hourly AOD data to daily means."""
    hourly = api_data.get("hourly", {})
    times = hourly.get("time", [])
    aod_values = hourly.get("aerosol_optical_depth", [])

    if not times:
        return []

    # Group by date
    daily_groups = {}
    for i, time_str in enumerate(times):
        date = time_str.split("T")[0]
        if date not in daily_groups:
            daily_groups[date] = []

        if aod_values[i] is not None:
            daily_groups[date].append(aod_values[i])

    # Calculate daily means
    daily_data = []
    for date in sorted(daily_groups.keys()):
        values = daily_groups[date]
        daily_data.append({
            "date": date,
            "aod_550nm": round(float(np.mean(values)), 4) if values else None
        })

    return daily_data


def main():
    parser = argparse.ArgumentParser(description="Fetch Open-Meteo AOD for specific date range")
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    parser.add_argument("--start-date", required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", required=True, help="End date (YYYY-MM-DD)")
    args = parser.parse_args()

    plant_id = args.plant_id

    print(f"\n{'='*60}")
    print(f"FETCHING OPEN-METEO AOD FOR {plant_id.upper()} (VALIDATION OVERLAP)")
    print(f"{'='*60}\n")

    # Load plant config
    config = load_plant_config(plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Fetch data from API
    api_data = fetch_aod_data(latitude, longitude, args.start_date, args.end_date)

    # Aggregate to daily
    daily_data = aggregate_hourly_to_daily(api_data)

    if not daily_data:
        print("⚠ No data returned from API")
        return

    # Build output
    output = {
        "metadata": {
            "plant_id": plant_id,
            "latitude": api_data["latitude"],
            "longitude": api_data["longitude"],
            "elevation": api_data.get("elevation"),
            "period": {
                "start": daily_data[0]["date"],
                "end": daily_data[-1]["date"]
            },
            "source": "Open-Meteo Air Quality API (CAMS Global Forecast)",
            "generated_at": datetime.now().isoformat(),
            "note": "Specific date range for validation overlap with CAMS EAC4 reanalysis"
        },
        "daily_data": daily_data
    }

    # Save output to separate validation file
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "openmeteo_aod_validation.json"
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Validation AOD data saved to: {output_path}")
    print(f"  Total days: {len(daily_data)}")
    print(f"  Avg AOD: {np.mean([d['aod_550nm'] for d in daily_data if d['aod_550nm']]):.4f}")
    print(f"\nThis data can now be used for validation against CAMS EAC4.")


if __name__ == "__main__":
    main()
