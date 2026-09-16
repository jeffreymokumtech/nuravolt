#!/usr/bin/env python3
"""
Fetch 5-day AOD forecast from Open-Meteo Air Quality API.

Applies validated bias corrections to match CAMS EAC4 Reanalysis baseline.

Usage:
    python scripts/fetch_aod_forecast.py --plant-id alpha1
    python scripts/fetch_aod_forecast.py --plant-id eta
    python scripts/fetch_aod_forecast.py --plant-id ribera
"""

import argparse
import json
import requests
from datetime import datetime
from pathlib import Path
import yaml
import numpy as np


# Validated bias corrections
BIAS_CORRECTIONS = {
    "alpha1": 0.0020,
    "eta": 0.0017,
    "ribera": -0.0078
}


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def fetch_aod_forecast(latitude: float, longitude: float, forecast_days: int = 5) -> dict:
    """Fetch AOD forecast from Open-Meteo Air Quality API."""
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "aerosol_optical_depth",
        "forecast_days": forecast_days,
        "timezone": "auto"
    }

    print(f"Fetching {forecast_days}-day AOD forecast from Open-Meteo...")
    print(f"  Location: ({latitude}, {longitude})")

    response = requests.get(url, params=params)
    response.raise_for_status()

    return response.json()


def aggregate_hourly_to_daily(api_data: dict, plant_id: str, apply_correction: bool = True) -> list:
    """Aggregate hourly forecast data to daily values with bias correction."""
    hourly = api_data.get("hourly", {})
    times = hourly.get("time", [])
    aod_values = hourly.get("aerosol_optical_depth", [])

    if not times:
        return []

    # Get bias correction
    correction = BIAS_CORRECTIONS.get(plant_id, 0.0) if apply_correction else 0.0

    # Group by date
    daily_groups = {}
    for i, time_str in enumerate(times):
        date = time_str.split("T")[0]
        if date not in daily_groups:
            daily_groups[date] = []

        if aod_values[i] is not None:
            # Apply bias correction
            corrected_value = aod_values[i] + correction
            daily_groups[date].append(corrected_value)

    # Calculate daily aggregates
    daily_data = []
    for date in sorted(daily_groups.keys()):
        values = daily_groups[date]
        daily_data.append({
            "date": date,
            "aod_550nm_mean": round(float(np.mean(values)), 4) if values else None,
            "aod_550nm_min": round(float(np.min(values)), 4) if values else None,
            "aod_550nm_max": round(float(np.max(values)), 4) if values else None,
            "hourly_count": len(values)
        })

    return daily_data


def main():
    parser = argparse.ArgumentParser(description="Fetch 5-day AOD forecast")
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    parser.add_argument("--forecast-days", type=int, default=5,
                       help="Number of forecast days (default: 5, max: 5)")
    parser.add_argument("--no-bias-correction", action="store_true",
                       help="Skip bias correction (not recommended)")
    args = parser.parse_args()

    plant_id = args.plant_id
    apply_correction = not args.no_bias_correction

    print(f"\n{'='*70}")
    print(f"FETCHING AOD FORECAST FOR {plant_id.upper()}")
    print(f"{'='*70}\n")

    # Load plant config
    config = load_plant_config(plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Fetch forecast from API
    api_data = fetch_aod_forecast(latitude, longitude, args.forecast_days)

    # Aggregate to daily with bias correction
    daily_forecast = aggregate_hourly_to_daily(api_data, plant_id, apply_correction)

    if not daily_forecast:
        print("⚠ No forecast data returned from API")
        return

    # Calculate statistics
    mean_values = [d["aod_550nm_mean"] for d in daily_forecast if d["aod_550nm_mean"]]
    correction = BIAS_CORRECTIONS.get(plant_id, 0.0) if apply_correction else 0.0

    # Build output
    output = {
        "metadata": {
            "plant_id": plant_id,
            "latitude": api_data["latitude"],
            "longitude": api_data["longitude"],
            "elevation": api_data.get("elevation"),
            "forecast_period": {
                "start": daily_forecast[0]["date"],
                "end": daily_forecast[-1]["date"],
                "days": len(daily_forecast)
            },
            "source": "Open-Meteo Air Quality API (CAMS Global Forecast)",
            "bias_correction_applied": correction,
            "generated_at": datetime.now().isoformat(),
            "note": (
                f"5-day AOD forecast with validated bias correction ({correction:+.4f}) "
                f"applied to align with CAMS EAC4 Reanalysis baseline. "
                f"Daily values show mean, min, max from hourly forecasts."
            )
        },
        "statistics": {
            "forecast_days": len(daily_forecast),
            "mean_aod": round(float(np.mean(mean_values)), 4) if mean_values else 0,
            "min_aod": round(float(np.min(mean_values)), 4) if mean_values else 0,
            "max_aod": round(float(np.max(mean_values)), 4) if mean_values else 0,
        },
        "daily_forecast": daily_forecast
    }

    # Save output
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "aod_forecast.json"
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ AOD forecast saved: {output_path}")
    print(f"\nForecast Summary:")
    print(f"  Period: {output['metadata']['forecast_period']['start']} to {output['metadata']['forecast_period']['end']}")
    print(f"  Days: {output['statistics']['forecast_days']}")
    print(f"  Mean AOD: {output['statistics']['mean_aod']}")
    print(f"  Range: {output['statistics']['min_aod']} - {output['statistics']['max_aod']}")

    if apply_correction:
        print(f"  Bias correction: {correction:+.4f} applied")

    print("\nDaily Forecast:")
    for day in daily_forecast:
        print(f"  {day['date']}: {day['aod_550nm_mean']:.4f} "
              f"(min: {day['aod_550nm_min']:.4f}, max: {day['aod_550nm_max']:.4f})")

    print("="*70 + "\n")


if __name__ == "__main__":
    main()
