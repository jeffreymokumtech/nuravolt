#!/usr/bin/env python3
"""
Fetch historical AOD (Aerosol Optical Depth) data from CAMS (Copernicus).

AOD is a key predictor of dust deposition on solar panels.
Uses the CAMS global reanalysis (EAC4) dataset via ADS API.

Note: Requires registration at https://ads.atmosphere.copernicus.eu/
and API key in ~/.cdsapirc

For simplicity, this script uses Open-Meteo's air quality API which
provides similar data without requiring API keys.
"""

import argparse
import json
import requests
from datetime import datetime, timedelta
from pathlib import Path


# Plant coordinates
PLANTS = {
    "epsilon": {"lat": 51.195, "lon": 14.509},
    "ribera": {"lat": 37.927, "lon": -1.233},
    "eta": {"lat": 38.66, "lon": -5.39},
    "delta": {"lat": 39.6544, "lon": 2.6978},
    "zeta": {"lat": 39.525, "lon": 3.187},
    "gamma": {"lat": 39.489, "lon": 2.916},
    "alpha": {"lat": 37.8145, "lon": -3.8047},
}


def fetch_aod_data(latitude: float, longitude: float, start_date: str, end_date: str) -> dict:
    """
    Fetch AOD data from Open-Meteo Air Quality API.

    Note: Air Quality API only supports last ~5 days for historical.
    For longer history, we use the forecast endpoint with past_days.
    """
    # Use forecast API which can go back further with past_days
    url = "https://air-quality-api.open-meteo.com/v1/air-quality"

    # Calculate days back (max 92 days for free tier)
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    days_back = min((datetime.now() - start_dt).days, 92)

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "hourly": "pm10,pm2_5,dust",  # Note: pm2_5 with underscore
        "past_days": days_back,
        "forecast_days": 0,
        "timezone": "auto"
    }

    print(f"Fetching AOD/dust data from Open-Meteo Air Quality API...")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Past days: {days_back}")

    response = requests.get(url, params=params)
    response.raise_for_status()

    return response.json()


def process_aod_data(api_data: dict, plant_id: str) -> dict:
    """Process hourly data into daily aggregates."""
    hourly = api_data.get("hourly", {})
    times = hourly.get("time", [])
    pm10 = hourly.get("pm10", [])
    pm2p5 = hourly.get("pm2_5", [])  # Note: underscore in API response
    dust = hourly.get("dust", [])
    aod = []  # Not available in free tier

    if not times:
        raise ValueError("No data returned from API")

    # Group by date
    daily_data = {}
    for i, time_str in enumerate(times):
        date = time_str[:10]
        if date not in daily_data:
            daily_data[date] = {
                "pm10": [], "pm2p5": [], "dust": [], "aod": []
            }

        if i < len(pm10) and pm10[i] is not None:
            daily_data[date]["pm10"].append(pm10[i])
        if i < len(pm2p5) and pm2p5[i] is not None:
            daily_data[date]["pm2p5"].append(pm2p5[i])
        if i < len(dust) and dust[i] is not None:
            daily_data[date]["dust"].append(dust[i])
        if i < len(aod) and aod[i] is not None:
            daily_data[date]["aod"].append(aod[i])

    # Calculate daily stats
    result_data = []
    for date in sorted(daily_data.keys()):
        d = daily_data[date]

        pm10_mean = sum(d["pm10"]) / len(d["pm10"]) if d["pm10"] else None
        pm2p5_mean = sum(d["pm2p5"]) / len(d["pm2p5"]) if d["pm2p5"] else None
        dust_mean = sum(d["dust"]) / len(d["dust"]) if d["dust"] else None
        aod_mean = sum(d["aod"]) / len(d["aod"]) if d["aod"] else None

        # High dust indicator
        is_high_dust = (pm10_mean or 0) > 50 or (dust_mean or 0) > 20

        result_data.append({
            "date": date,
            "pm10_mean": round(pm10_mean, 2) if pm10_mean else None,
            "pm2p5_mean": round(pm2p5_mean, 2) if pm2p5_mean else None,
            "dust_mean": round(dust_mean, 2) if dust_mean else None,
            "aod_mean": round(aod_mean, 4) if aod_mean else None,
            "is_high_dust": is_high_dust,
        })

    # Statistics
    pm10_values = [d["pm10_mean"] for d in result_data if d["pm10_mean"]]
    dust_values = [d["dust_mean"] for d in result_data if d["dust_mean"]]
    high_dust_days = sum(1 for d in result_data if d["is_high_dust"])

    return {
        "metadata": {
            "plant_id": plant_id,
            "latitude": api_data.get("latitude"),
            "longitude": api_data.get("longitude"),
            "period": {
                "start": result_data[0]["date"] if result_data else None,
                "end": result_data[-1]["date"] if result_data else None,
            },
            "source": "Open-Meteo Air Quality API (CAMS data)",
            "generated_at": datetime.now().isoformat(),
        },
        "daily_data": result_data,
        "statistics": {
            "total_days": len(result_data),
            "high_dust_days": high_dust_days,
            "high_dust_pct": round(high_dust_days / len(result_data) * 100, 1) if result_data else 0,
            "avg_pm10": round(sum(pm10_values) / len(pm10_values), 1) if pm10_values else None,
            "max_pm10": round(max(pm10_values), 1) if pm10_values else None,
            "avg_dust": round(sum(dust_values) / len(dust_values), 1) if dust_values else None,
        }
    }


def fetch_all_plants(start_date: str = None, end_date: str = None):
    """Fetch AOD data for all plants."""

    if not end_date:
        end_date = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
    if not start_date:
        start_date = (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")

    print(f"\n{'='*60}")
    print(f"FETCHING AOD/DUST DATA FOR ALL PLANTS")
    print(f"Period: {start_date} to {end_date}")
    print(f"{'='*60}")

    for plant_id, coords in PLANTS.items():
        print(f"\n--- {plant_id.upper()} ---")

        try:
            api_data = fetch_aod_data(
                coords["lat"], coords["lon"],
                start_date, end_date
            )

            processed = process_aod_data(api_data, plant_id)

            # Save
            output_dir = Path(f"public/data/soiling/{plant_id}")
            output_dir.mkdir(parents=True, exist_ok=True)

            output_path = output_dir / "aod_history.json"
            with open(output_path, 'w') as f:
                json.dump(processed, f, indent=2)

            stats = processed["statistics"]
            print(f"  ✓ Saved to {output_path}")
            print(f"    Days: {stats['total_days']}, High dust: {stats['high_dust_days']} ({stats['high_dust_pct']}%)")
            print(f"    Avg PM10: {stats['avg_pm10']} µg/m³, Avg Dust: {stats['avg_dust']} µg/m³")

        except Exception as e:
            print(f"  ✗ Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Fetch AOD/dust history")
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
        start_date = args.start_date or (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")

        api_data = fetch_aod_data(coords["lat"], coords["lon"], start_date, end_date)
        processed = process_aod_data(api_data, args.plant_id)

        output_dir = Path(f"public/data/soiling/{args.plant_id}")
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "aod_history.json"

        with open(output_path, 'w') as f:
            json.dump(processed, f, indent=2)

        print(f"\n✓ Saved to {output_path}")
    else:
        fetch_all_plants(args.start_date, args.end_date)


if __name__ == "__main__":
    main()
