#!/usr/bin/env python3
"""
Fetch extended weather data from Open-Meteo Archive API.

Features for soiling prediction:
- relative_humidity: Affects dust adhesion (high humidity = sticky dust)
- wind_speed: Dust transport and deposition
- wind_direction: Source direction for dust
- dewpoint: Morning dew can clean panels
- soil_moisture: Dry soil = more dust available
"""

import argparse
import json
import requests
from datetime import datetime, timedelta
from pathlib import Path


# Plant coordinates
PLANTS = {
    "epsilon": {"lat": 51, "lon": 14.5},
    "ribera": {"lat": 38, "lon": -1},
    "eta": {"lat": 38.5, "lon": -5.5},
    "delta": {"lat": 39.5, "lon": 2.5},
    "zeta": {"lat": 39.5, "lon": 3},
    "gamma": {"lat": 39.5, "lon": 3},
    "alpha": {"lat": 38, "lon": -4},
}


def fetch_weather_data(latitude: float, longitude: float, start_date: str, end_date: str) -> dict:
    """Fetch extended weather data from Open-Meteo Archive API."""
    url = "https://archive-api.open-meteo.com/v1/archive"

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start_date,
        "end_date": end_date,
        "daily": ",".join([
            "temperature_2m_mean",
            "temperature_2m_max",
            "temperature_2m_min",
            "relative_humidity_2m_mean",
            "relative_humidity_2m_min",
            "dewpoint_2m_mean",
            "precipitation_sum",
            "snowfall_sum",           # Snow accumulation in cm
            "wind_speed_10m_max",
            "wind_speed_10m_mean",
            "wind_direction_10m_dominant",
            "shortwave_radiation_sum",
            "et0_fao_evapotranspiration",
        ]),
        "timezone": "auto"
    }

    print(f"Fetching extended weather from Open-Meteo Archive...")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Period: {start_date} to {end_date}")

    response = requests.get(url, params=params)
    response.raise_for_status()

    return response.json()


def process_weather_data(api_data: dict, plant_id: str) -> dict:
    """Process API data into structured format."""
    daily = api_data.get("daily", {})
    dates = daily.get("time", [])

    if not dates:
        raise ValueError("No data returned from API")

    # Build daily data
    daily_data = []
    for i, date in enumerate(dates):
        temp_mean = daily.get("temperature_2m_mean", [None]*len(dates))[i]
        temp_max = daily.get("temperature_2m_max", [None]*len(dates))[i]
        temp_min = daily.get("temperature_2m_min", [None]*len(dates))[i]
        rh_mean = daily.get("relative_humidity_2m_mean", [None]*len(dates))[i]
        rh_min = daily.get("relative_humidity_2m_min", [None]*len(dates))[i]
        dewpoint = daily.get("dewpoint_2m_mean", [None]*len(dates))[i]
        precip = daily.get("precipitation_sum", [None]*len(dates))[i]
        snowfall = daily.get("snowfall_sum", [None]*len(dates))[i]
        wind_max = daily.get("wind_speed_10m_max", [None]*len(dates))[i]
        wind_mean = daily.get("wind_speed_10m_mean", [None]*len(dates))[i]
        wind_dir = daily.get("wind_direction_10m_dominant", [None]*len(dates))[i]
        radiation = daily.get("shortwave_radiation_sum", [None]*len(dates))[i]
        et0 = daily.get("et0_fao_evapotranspiration", [None]*len(dates))[i]

        # Derived features
        # Dew cleaning potential: when dewpoint is close to min temp
        dew_cleaning = False
        if dewpoint is not None and temp_min is not None:
            dew_cleaning = (temp_min - dewpoint) < 3  # Dew likely formed

        # Dust transport potential: high wind + low humidity
        dust_transport = False
        if wind_max is not None and rh_min is not None:
            dust_transport = wind_max > 20 and rh_min < 40

        # Snow coverage indicator (can block sunlight and affect panel performance)
        has_snow = snowfall is not None and snowfall > 0

        daily_data.append({
            "date": date,
            "temperature_mean": round(temp_mean, 1) if temp_mean else None,
            "temperature_max": round(temp_max, 1) if temp_max else None,
            "temperature_min": round(temp_min, 1) if temp_min else None,
            "relative_humidity_mean": round(rh_mean, 1) if rh_mean else None,
            "relative_humidity_min": round(rh_min, 1) if rh_min else None,
            "dewpoint_mean": round(dewpoint, 1) if dewpoint else None,
            "precipitation_mm": round(precip, 1) if precip else 0,
            "snowfall_cm": round(snowfall, 1) if snowfall else 0,
            "has_snow": has_snow,
            "wind_speed_max": round(wind_max, 1) if wind_max else None,
            "wind_speed_mean": round(wind_mean, 1) if wind_mean else None,
            "wind_direction": round(wind_dir) if wind_dir else None,
            "radiation_sum": round(radiation, 1) if radiation else None,
            "evapotranspiration": round(et0, 2) if et0 else None,
            "dew_cleaning_likely": dew_cleaning,
            "dust_transport_risk": dust_transport,
        })

    # Statistics
    rh_values = [d["relative_humidity_mean"] for d in daily_data if d["relative_humidity_mean"]]
    wind_values = [d["wind_speed_mean"] for d in daily_data if d["wind_speed_mean"]]
    dew_days = sum(1 for d in daily_data if d["dew_cleaning_likely"])
    dust_days = sum(1 for d in daily_data if d["dust_transport_risk"])
    snow_days = sum(1 for d in daily_data if d.get("has_snow", False))
    total_snowfall = sum(d.get("snowfall_cm", 0) for d in daily_data)

    return {
        "metadata": {
            "plant_id": plant_id,
            "latitude": api_data.get("latitude"),
            "longitude": api_data.get("longitude"),
            "period": {
                "start": dates[0],
                "end": dates[-1],
            },
            "source": "Open-Meteo Archive API",
            "generated_at": datetime.now().isoformat(),
        },
        "daily_data": daily_data,
        "statistics": {
            "total_days": len(daily_data),
            "avg_humidity": round(sum(rh_values) / len(rh_values), 1) if rh_values else None,
            "avg_wind_speed": round(sum(wind_values) / len(wind_values), 1) if wind_values else None,
            "dew_cleaning_days": dew_days,
            "dew_cleaning_pct": round(dew_days / len(daily_data) * 100, 1) if daily_data else 0,
            "dust_transport_days": dust_days,
            "dust_transport_pct": round(dust_days / len(daily_data) * 100, 1) if daily_data else 0,
            "snow_days": snow_days,
            "snow_days_pct": round(snow_days / len(daily_data) * 100, 1) if daily_data else 0,
            "total_snowfall_cm": round(total_snowfall, 1),
        }
    }


def fetch_all_plants(start_date: str = None, end_date: str = None):
    """Fetch extended weather for all plants."""

    if not end_date:
        # Archive API has 5-7 day delay for data availability
        end_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    if not start_date:
        # Cover full DustIQ history (back to 2020) for maximum training data
        start_date = "2020-01-01"

    print(f"\n{'='*60}")
    print(f"FETCHING EXTENDED WEATHER FOR ALL PLANTS")
    print(f"Period: {start_date} to {end_date}")
    print(f"{'='*60}")

    for plant_id, coords in PLANTS.items():
        print(f"\n--- {plant_id.upper()} ---")

        try:
            api_data = fetch_weather_data(
                coords["lat"], coords["lon"],
                start_date, end_date
            )

            processed = process_weather_data(api_data, plant_id)

            # Save
            output_dir = Path(f"public/data/soiling/{plant_id}")
            output_dir.mkdir(parents=True, exist_ok=True)

            output_path = output_dir / "weather_extended.json"
            with open(output_path, 'w') as f:
                json.dump(processed, f, indent=2)

            stats = processed["statistics"]
            print(f"  ✓ Saved to {output_path}")
            print(f"    Days: {stats['total_days']}")
            print(f"    Avg Humidity: {stats['avg_humidity']}%, Avg Wind: {stats['avg_wind_speed']} km/h")
            print(f"    Dew cleaning days: {stats['dew_cleaning_days']} ({stats['dew_cleaning_pct']}%)")
            print(f"    Dust transport days: {stats['dust_transport_days']} ({stats['dust_transport_pct']}%)")

        except Exception as e:
            print(f"  ✗ Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Fetch extended weather history")
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
        end_date = args.end_date or (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        start_date = args.start_date or (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")

        api_data = fetch_weather_data(coords["lat"], coords["lon"], start_date, end_date)
        processed = process_weather_data(api_data, args.plant_id)

        output_dir = Path(f"public/data/soiling/{args.plant_id}")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "weather_extended.json"

        with open(output_path, 'w') as f:
            json.dump(processed, f, indent=2)

        print(f"\n✓ Saved to {output_path}")
    else:
        fetch_all_plants(args.start_date, args.end_date)


if __name__ == "__main__":
    main()
