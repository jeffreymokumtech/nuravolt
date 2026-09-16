#!/usr/bin/env python3
"""
Fetch dust/air quality data from Open-Meteo Air Quality API.

Usage:
    python scripts/fetch_dust_history.py --plant-id eta
    python scripts/fetch_dust_history.py --plant-id ribera
    python scripts/fetch_dust_history.py --plant-id alpha1
"""

import argparse
import json
import requests
from datetime import datetime, timedelta
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


def fetch_dust_data(latitude: float, longitude: float, past_days: int = 92) -> dict:
    """Fetch recent dust data from Open-Meteo Air Quality API."""
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "pm10,pm2_5,dust,aerosol_optical_depth,european_aqi,us_aqi",
        "past_days": past_days,
        "forecast_days": 5,
        "timezone": "auto"
    }

    print(f"Fetching dust data from Open-Meteo Air Quality API...")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Past days: {past_days}")

    response = requests.get(url, params=params)
    response.raise_for_status()

    return response.json()


def aggregate_hourly_to_daily(api_data: dict) -> list:
    """Aggregate hourly data to daily values."""
    hourly = api_data.get("hourly", {})
    times = hourly.get("time", [])

    if not times:
        return []

    # Group by date
    daily_groups = {}
    for i, time_str in enumerate(times):
        date = time_str.split("T")[0]
        if date not in daily_groups:
            daily_groups[date] = {
                "pm10": [], "pm2_5": [], "dust": [],
                "aod_550nm": [],
                "aqi_eu": [], "aqi_us": []
            }

        if hourly.get("pm10") and hourly["pm10"][i] is not None:
            daily_groups[date]["pm10"].append(hourly["pm10"][i])
        if hourly.get("pm2_5") and hourly["pm2_5"][i] is not None:
            daily_groups[date]["pm2_5"].append(hourly["pm2_5"][i])
        if hourly.get("dust") and hourly["dust"][i] is not None:
            daily_groups[date]["dust"].append(hourly["dust"][i])
        if hourly.get("aerosol_optical_depth") and hourly["aerosol_optical_depth"][i] is not None:
            daily_groups[date]["aod_550nm"].append(hourly["aerosol_optical_depth"][i])
        if hourly.get("european_aqi") and hourly["european_aqi"][i] is not None:
            daily_groups[date]["aqi_eu"].append(hourly["european_aqi"][i])
        if hourly.get("us_aqi") and hourly["us_aqi"][i] is not None:
            daily_groups[date]["aqi_us"].append(hourly["us_aqi"][i])

    # Calculate daily aggregates
    daily_data = []
    for date in sorted(daily_groups.keys()):
        group = daily_groups[date]
        daily_data.append({
            "date": date,
            "pm10": round(float(np.mean(group["pm10"])), 1) if group["pm10"] else None,
            "pm2_5": round(float(np.mean(group["pm2_5"])), 1) if group["pm2_5"] else None,
            "dust": round(float(np.max(group["dust"])), 1) if group["dust"] else None,  # Max for dust events
            "aod_550nm": round(float(np.mean(group["aod_550nm"])), 4) if group["aod_550nm"] else None,  # Mean AOD, 4 decimals
            "aqi_eu": int(np.max(group["aqi_eu"])) if group["aqi_eu"] else None,
            "aqi_us": int(np.max(group["aqi_us"])) if group["aqi_us"] else None,
        })

    return daily_data


def calculate_statistics(daily_data: list) -> dict:
    """Calculate summary statistics."""
    dust_values = [d["dust"] for d in daily_data if d["dust"] is not None]
    pm10_values = [d["pm10"] for d in daily_data if d["pm10"] is not None]
    pm2_5_values = [d["pm2_5"] for d in daily_data if d["pm2_5"] is not None]
    aod_values = [d["aod_550nm"] for d in daily_data if d.get("aod_550nm") is not None]

    high_dust_threshold = 50
    very_high_dust_threshold = 100
    high_aod_threshold = 0.3  # Moderate-high AOD

    high_dust_days = sum(1 for v in dust_values if v > high_dust_threshold)
    very_high_dust_days = sum(1 for v in dust_values if v > very_high_dust_threshold)
    high_aod_days = sum(1 for v in aod_values if v > high_aod_threshold)

    max_dust = max(dust_values) if dust_values else 0
    max_dust_date = next((d["date"] for d in daily_data if d.get("dust") == max_dust), "")
    max_aod = max(aod_values) if aod_values else 0
    max_aod_date = next((d["date"] for d in daily_data if d.get("aod_550nm") == max_aod), "")

    return {
        "total_days": len(daily_data),
        "high_dust_days": high_dust_days,
        "very_high_dust_days": very_high_dust_days,
        "high_aod_days": high_aod_days,
        "avg_pm10": round(float(np.mean(pm10_values)), 1) if pm10_values else 0,
        "avg_pm2_5": round(float(np.mean(pm2_5_values)), 1) if pm2_5_values else 0,
        "avg_aod": round(float(np.mean(aod_values)), 4) if aod_values else 0,
        "max_dust": round(max_dust, 1),
        "max_dust_date": max_dust_date,
        "max_aod": round(max_aod, 4),
        "max_aod_date": max_aod_date,
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch dust/air quality history")
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    parser.add_argument("--past-days", type=int, default=92,
                       help="Number of past days to fetch (max 92)")
    args = parser.parse_args()

    plant_id = args.plant_id

    print(f"\n{'='*60}")
    print(f"FETCHING DUST HISTORY FOR {plant_id.upper()}")
    print(f"{'='*60}\n")

    # Load plant config
    config = load_plant_config(plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Fetch data from API
    api_data = fetch_dust_data(latitude, longitude, args.past_days)

    # Aggregate to daily
    daily_data = aggregate_hourly_to_daily(api_data)

    if not daily_data:
        print("⚠ No data returned from API")
        return

    # Calculate statistics
    stats = calculate_statistics(daily_data)

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
            "note": "Recent ~92 days from CAMS Global Forecast model. NOT directly comparable to CAMS EAC4 reanalysis without validation - see validation report."
        },
        "daily_data": daily_data,
        "statistics": stats
    }

    # Save output
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "openmeteo_aod_history.json"
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Open-Meteo AOD history saved to: {output_path}")
    print(f"\nSummary:")
    print(f"  Total days: {stats['total_days']}")
    print(f"  High dust days (>50 μg/m³): {stats['high_dust_days']}")
    print(f"  Very high dust days (>100 μg/m³): {stats['very_high_dust_days']}")
    print(f"  High AOD days (>0.3): {stats['high_aod_days']}")
    print(f"  Avg PM10: {stats['avg_pm10']} μg/m³")
    print(f"  Avg PM2.5: {stats['avg_pm2_5']} μg/m³")
    print(f"  Avg AOD (550nm): {stats['avg_aod']}")
    print(f"  Max dust: {stats['max_dust']} μg/m³ on {stats['max_dust_date']}")
    print(f"  Max AOD: {stats['max_aod']} on {stats['max_aod_date']}")
    print(f"\n⚠️  NOTE: This data is from CAMS Global Forecast.")
    print(f"  Validate against CAMS EAC4 reanalysis before merging datasets.")


if __name__ == "__main__":
    main()
