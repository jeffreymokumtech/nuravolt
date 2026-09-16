#!/usr/bin/env python3
"""
Fetch dust/air quality data from Open-Meteo Air Quality API and generate
historical data for solar soiling analysis.

Open-Meteo provides ~92 days of historical data from CAMS.
For earlier periods, we generate realistic synthetic data based on:
- Seasonal patterns (higher dust in spring/summer in Mediterranean)
- Random dust events (Saharan dust intrusions)
- Known climate patterns for southern Spain

API Docs: https://open-meteo.com/en/docs/air-quality-api
"""

import json
import requests
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path

# Configuration
LATITUDE = 37.8145  # ALPHA1 location (near Region A, Spain)
LONGITUDE = -3.8047
OUTPUT_DIR = Path("public/data/soiling/alpha1")

def fetch_recent_dust_data():
    """Fetch recent dust data from Open-Meteo Air Quality API."""
    params = {
        "latitude": LATITUDE,
        "longitude": LONGITUDE,
        "hourly": "pm10,pm2_5,dust,european_aqi,us_aqi",
        "past_days": 92,
        "forecast_days": 5,
        "timezone": "Europe/Madrid",
    }

    url = "https://air-quality-api.open-meteo.com/v1/air-quality"

    print(f"Fetching dust data from Open-Meteo...")
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()


def aggregate_hourly_to_daily(data):
    """Aggregate hourly data to daily values."""
    hourly = data.get("hourly", {})
    times = hourly.get("time", [])

    if not times:
        return []

    # Group by date
    daily_groups = {}
    for i, time_str in enumerate(times):
        date = time_str.split("T")[0]
        if date not in daily_groups:
            daily_groups[date] = {"pm10": [], "pm2_5": [], "dust": [], "aqi_eu": [], "aqi_us": []}

        if hourly.get("pm10") and hourly["pm10"][i] is not None:
            daily_groups[date]["pm10"].append(hourly["pm10"][i])
        if hourly.get("pm2_5") and hourly["pm2_5"][i] is not None:
            daily_groups[date]["pm2_5"].append(hourly["pm2_5"][i])
        if hourly.get("dust") and hourly["dust"][i] is not None:
            daily_groups[date]["dust"].append(hourly["dust"][i])
        if hourly.get("european_aqi") and hourly["european_aqi"][i] is not None:
            daily_groups[date]["aqi_eu"].append(hourly["european_aqi"][i])
        if hourly.get("us_aqi") and hourly["us_aqi"][i] is not None:
            daily_groups[date]["aqi_us"].append(hourly["us_aqi"][i])

    # Calculate daily values
    daily_data = []
    for date in sorted(daily_groups.keys()):
        group = daily_groups[date]
        daily_data.append({
            "date": date,
            "pm10": round(np.mean(group["pm10"]), 1) if group["pm10"] else None,
            "pm2_5": round(np.mean(group["pm2_5"]), 1) if group["pm2_5"] else None,
            "dust": round(np.max(group["dust"]), 1) if group["dust"] else None,  # Max for dust events
            "aqi_eu": int(np.max(group["aqi_eu"])) if group["aqi_eu"] else None,
            "aqi_us": int(np.max(group["aqi_us"])) if group["aqi_us"] else None,
        })

    return daily_data


def generate_synthetic_dust_data(start_date, end_date, seed=42):
    """
    Generate realistic synthetic dust data for southern Spain.

    Based on:
    - Higher PM10/dust in spring (March-May) due to Saharan dust intrusions
    - Agricultural activity peaks in summer
    - Lower values in winter with occasional events
    - Random major dust events (calima) occurring ~5-10 times per year
    """
    np.random.seed(seed)

    # Seasonal base levels (μg/m³)
    seasonal_pm10 = {
        1: 18, 2: 20, 3: 28, 4: 32, 5: 30,  # Winter to spring
        6: 25, 7: 22, 8: 23, 9: 21, 10: 19, 11: 17, 12: 16  # Summer to winter
    }

    seasonal_dust = {
        1: 5, 2: 8, 3: 15, 4: 20, 5: 18,  # Higher in spring (Saharan)
        6: 12, 7: 8, 8: 10, 9: 8, 10: 6, 11: 4, 12: 4
    }

    daily_data = []
    current = start_date

    # Predefined major dust events (calima dates based on historical patterns)
    major_dust_events = set()
    year = start_date.year
    while year <= end_date.year:
        # Typically 5-10 major Saharan dust events per year
        for _ in range(np.random.randint(5, 11)):
            # Most likely in Feb-April and October
            if np.random.random() < 0.7:
                month = np.random.choice([2, 3, 4, 10])
            else:
                month = np.random.randint(1, 13)
            day = np.random.randint(1, 28)
            event_date = datetime(year, month, day)
            # Add event spanning 1-3 days
            duration = np.random.randint(1, 4)
            for d in range(duration):
                major_dust_events.add((event_date + timedelta(days=d)).strftime("%Y-%m-%d"))
        year += 1

    while current <= end_date:
        date_str = current.strftime("%Y-%m-%d")
        month = current.month

        # Base values with seasonal variation
        base_pm10 = seasonal_pm10[month]
        base_dust = seasonal_dust[month]

        # Add daily variation
        pm10 = base_pm10 + np.random.normal(0, 5)
        pm2_5 = pm10 * 0.6 + np.random.normal(0, 2)  # PM2.5 typically 50-70% of PM10
        dust = base_dust + np.random.normal(0, 3)

        # Major dust event
        if date_str in major_dust_events:
            dust_multiplier = np.random.uniform(3, 10)
            dust *= dust_multiplier
            pm10 *= np.random.uniform(1.5, 3)
            pm2_5 *= np.random.uniform(1.3, 2.5)

        # Ensure non-negative
        pm10 = max(5, pm10)
        pm2_5 = max(2, pm2_5)
        dust = max(0, dust)

        # Calculate AQI (simplified)
        aqi_eu = calculate_aqi_eu(pm10, pm2_5)
        aqi_us = calculate_aqi_us(pm2_5)

        daily_data.append({
            "date": date_str,
            "pm10": round(pm10, 1),
            "pm2_5": round(pm2_5, 1),
            "dust": round(dust, 1),
            "aqi_eu": aqi_eu,
            "aqi_us": aqi_us,
        })

        current += timedelta(days=1)

    return daily_data


def calculate_aqi_eu(pm10, pm2_5):
    """Simplified European AQI calculation (1-5 scale converted to 0-500)."""
    # European AQI uses highest index from all pollutants
    pm10_index = min(5, max(1, pm10 / 20))  # Rough approximation
    pm2_5_index = min(5, max(1, pm2_5 / 10))
    return int(max(pm10_index, pm2_5_index) * 100)


def calculate_aqi_us(pm2_5):
    """Simplified US AQI calculation based on PM2.5."""
    if pm2_5 <= 12:
        return int((50 / 12) * pm2_5)
    elif pm2_5 <= 35.4:
        return int(50 + (50 / 23.4) * (pm2_5 - 12))
    elif pm2_5 <= 55.4:
        return int(100 + (50 / 20) * (pm2_5 - 35.4))
    elif pm2_5 <= 150.4:
        return int(150 + (50 / 95) * (pm2_5 - 55.4))
    else:
        return min(500, int(200 + (pm2_5 - 150.4)))


def calculate_statistics(daily_data):
    """Calculate summary statistics."""
    dust_values = [d["dust"] for d in daily_data if d["dust"] is not None]
    pm10_values = [d["pm10"] for d in daily_data if d["pm10"] is not None]
    pm2_5_values = [d["pm2_5"] for d in daily_data if d["pm2_5"] is not None]

    high_dust_threshold = 50
    very_high_dust_threshold = 100

    high_dust_days = sum(1 for v in dust_values if v > high_dust_threshold)
    very_high_dust_days = sum(1 for v in dust_values if v > very_high_dust_threshold)

    max_dust = max(dust_values) if dust_values else 0
    max_dust_date = next((d["date"] for d in daily_data if d["dust"] == max_dust), "")

    return {
        "total_days": len(daily_data),
        "high_dust_days": high_dust_days,
        "very_high_dust_days": very_high_dust_days,
        "avg_pm10": round(np.mean(pm10_values), 1) if pm10_values else 0,
        "avg_pm2_5": round(np.mean(pm2_5_values), 1) if pm2_5_values else 0,
        "max_dust": round(max_dust, 1),
        "max_dust_date": max_dust_date,
    }


def main():
    print("=" * 60)
    print("Dust Data Generator for ALPHA1 (Southern Spain)")
    print("=" * 60)

    # Define date range to match rain data
    start_date = datetime(2019, 1, 1)
    end_date = datetime.now()

    # Try to fetch recent data from API
    recent_data = []
    try:
        api_response = fetch_recent_dust_data()
        recent_data = aggregate_hourly_to_daily(api_response)
        print(f"✓ Fetched {len(recent_data)} days of recent dust data from API")
    except Exception as e:
        print(f"⚠ Could not fetch API data: {e}")
        print("  Will generate synthetic data for entire period")

    # Calculate cutoff date (use API data for recent ~90 days)
    if recent_data:
        recent_dates = {d["date"] for d in recent_data}
        cutoff_date = datetime.strptime(min(recent_dates), "%Y-%m-%d")
        synthetic_end = cutoff_date - timedelta(days=1)
    else:
        synthetic_end = end_date

    # Generate synthetic historical data
    print(f"Generating synthetic data from {start_date.date()} to {synthetic_end.date()}...")
    synthetic_data = generate_synthetic_dust_data(start_date, synthetic_end)
    print(f"✓ Generated {len(synthetic_data)} days of synthetic historical data")

    # Combine data
    all_data = synthetic_data + recent_data

    # Sort by date
    all_data.sort(key=lambda x: x["date"])

    # Calculate statistics
    statistics = calculate_statistics(all_data)

    # Prepare output
    output = {
        "metadata": {
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
            "timezone": "Europe/Madrid",
            "generated_at": datetime.now().isoformat(),
            "source": "Open-Meteo Air Quality API (CAMS) + synthetic historical data",
            "period": {
                "start": all_data[0]["date"] if all_data else "",
                "end": all_data[-1]["date"] if all_data else "",
            },
            "notes": {
                "synthetic_data_end": synthetic_end.strftime("%Y-%m-%d") if recent_data else end_date.strftime("%Y-%m-%d"),
                "api_data_start": min(recent_dates) if recent_data else None,
            }
        },
        "statistics": statistics,
        "daily_data": all_data,
    }

    # Save to file
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_file = OUTPUT_DIR / "dust_history.json"

    with open(output_file, "w") as f:
        json.dump(output, f, indent=2)

    print()
    print(f"✓ Saved dust data to {output_file}")
    print()
    print("Statistics:")
    print(f"  Total days: {statistics['total_days']}")
    print(f"  High dust days (>50 μg/m³): {statistics['high_dust_days']}")
    print(f"  Very high dust days (>100 μg/m³): {statistics['very_high_dust_days']}")
    print(f"  Average PM10: {statistics['avg_pm10']} μg/m³")
    print(f"  Average PM2.5: {statistics['avg_pm2_5']} μg/m³")
    print(f"  Maximum dust: {statistics['max_dust']} μg/m³ on {statistics['max_dust_date']}")


if __name__ == "__main__":
    main()
