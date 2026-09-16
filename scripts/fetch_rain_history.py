#!/usr/bin/env python3
"""
Fetch historical rain data from Open-Meteo API for any plant.

Usage:
    python scripts/fetch_rain_history.py --plant-id eta
    python scripts/fetch_rain_history.py --plant-id ribera
    python scripts/fetch_rain_history.py --plant-id alpha1
"""

import argparse
import json
import requests
from datetime import datetime, timedelta
from pathlib import Path
import yaml


CLEANING_THRESHOLD_MM = 5.0
HEAVY_RAIN_THRESHOLD_MM = 10.0


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def fetch_rain_data(latitude: float, longitude: float, start_date: str, end_date: str) -> dict:
    """Fetch historical rain data from Open-Meteo Archive API."""
    url = "https://archive-api.open-meteo.com/v1/archive"

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start_date,
        "end_date": end_date,
        "daily": "precipitation_sum",
        "timezone": "auto"
    }

    print(f"Fetching rain data from Open-Meteo...")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_date} to {end_date}")

    response = requests.get(url, params=params)
    response.raise_for_status()

    return response.json()


def process_rain_data(api_data: dict, plant_id: str) -> dict:
    """Process API data into structured format."""
    daily = api_data.get("daily", {})
    dates = daily.get("time", [])
    precip = daily.get("precipitation_sum", [])

    if not dates or not precip:
        raise ValueError("No data returned from API")

    # Build daily data
    daily_data = []
    cleaning_events = []

    for date, rain_mm in zip(dates, precip):
        rain_mm = rain_mm if rain_mm is not None else 0.0

        is_cleaning = rain_mm >= CLEANING_THRESHOLD_MM
        is_heavy = rain_mm >= HEAVY_RAIN_THRESHOLD_MM

        daily_data.append({
            "date": date,
            "precipitation_mm": round(rain_mm, 1),
            "is_cleaning_event": is_cleaning,
            "is_heavy_rain": is_heavy
        })

        # Record cleaning events
        if is_cleaning:
            # Estimate SR recovery based on rain amount
            if is_heavy:
                expected_recovery = 0.15  # Heavy rain can recover ~15% SR
                event_type = "heavy"
            else:
                expected_recovery = 0.08  # Moderate rain ~8% SR recovery
                event_type = "moderate"

            cleaning_events.append({
                "date": date,
                "amount_mm": round(rain_mm, 1),
                "type": event_type,
                "expected_sr_recovery": expected_recovery
            })

    # Calculate statistics
    total_days = len(daily_data)
    rain_days = sum(1 for d in daily_data if d["precipitation_mm"] > 0.1)
    total_precip = sum(d["precipitation_mm"] for d in daily_data)
    cleaning_count = len(cleaning_events)

    # Build response
    return {
        "metadata": {
            "plant_id": plant_id,
            "latitude": api_data["latitude"],
            "longitude": api_data["longitude"],
            "period": {
                "start": dates[0],
                "end": dates[-1]
            },
            "source": "Open-Meteo Archive API",
            "cleaning_threshold_mm": CLEANING_THRESHOLD_MM,
            "generated_at": datetime.now().isoformat()
        },
        "daily_data": daily_data,
        "cleaning_events": cleaning_events,
        "statistics": {
            "total_days": total_days,
            "rain_days": rain_days,
            "rain_frequency": round(rain_days / total_days, 3) if total_days > 0 else 0,
            "cleaning_events_count": cleaning_count,
            "total_precipitation_mm": round(total_precip, 1),
            "avg_precipitation_mm": round(total_precip / total_days, 2) if total_days > 0 else 0
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch rain history from Open-Meteo")
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    parser.add_argument("--start-date", help="Start date (YYYY-MM-DD), default: 3 years ago")
    parser.add_argument("--end-date", help="End date (YYYY-MM-DD), default: today")
    args = parser.parse_args()

    plant_id = args.plant_id

    print(f"\n{'='*60}")
    print(f"FETCHING RAIN HISTORY FOR {plant_id.upper()}")
    print(f"{'='*60}\n")

    # Load plant config
    config = load_plant_config(plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Default date range: 3 years ago to today
    end_date = args.end_date or datetime.now().strftime("%Y-%m-%d")
    if not args.start_date:
        start_date = (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")
    else:
        start_date = args.start_date

    # Fetch data
    api_data = fetch_rain_data(latitude, longitude, start_date, end_date)

    # Process data
    rain_data = process_rain_data(api_data, plant_id)

    # Save output
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save JSON (full data with metadata)
    output_path_json = output_dir / "rain_history.json"
    with open(output_path_json, 'w') as f:
        json.dump(rain_data, f, indent=2)

    # Save CSV (simple format for per-inverter training)
    import pandas as pd
    output_path_csv = output_dir / "rain_history.csv"
    df_rain = pd.DataFrame(rain_data['daily_data'])
    df_rain.to_csv(output_path_csv, index=False)

    print(f"\n✅ Rain history saved to:")
    print(f"  JSON: {output_path_json}")
    print(f"  CSV:  {output_path_csv}")
    print(f"\nSummary:")
    print(f"  Total days: {rain_data['statistics']['total_days']}")
    print(f"  Rain days: {rain_data['statistics']['rain_days']} ({rain_data['statistics']['rain_frequency']*100:.1f}%)")
    print(f"  Cleaning events: {rain_data['statistics']['cleaning_events_count']}")
    print(f"  Total precipitation: {rain_data['statistics']['total_precipitation_mm']} mm")
    print(f"  Avg daily: {rain_data['statistics']['avg_precipitation_mm']} mm/day")


if __name__ == "__main__":
    main()
