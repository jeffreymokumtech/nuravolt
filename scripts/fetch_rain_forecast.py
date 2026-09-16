#!/usr/bin/env python3
"""
Fetch 16-day precipitation forecast from Open-Meteo.

This script uses the Open-Meteo Weather Forecast API to fetch
precipitation forecasts for solar soiling analysis and cleaning optimization.

Open-Meteo provides:
- Forecast Horizon: 16 days (best in class)
- Temporal Resolution: Hourly
- Variables: Precipitation (mm), rain (mm), snowfall (cm)
- Quality: Good (⭐⭐⭐⭐) - validated against GFS/ECMWF
- Access: Free, no API key required

Usage:
    python scripts/fetch_rain_forecast.py --plant-id eta
    python scripts/fetch_rain_forecast.py --plant-id ribera
"""

import argparse
import json
from datetime import datetime
from pathlib import Path
import yaml

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False
    print("\n⚠️  WARNING: requests not installed")
    print("Install with: pip install requests\n")


def load_plant_config(plant_id: str) -> dict:
    """Load plant configuration from YAML file."""
    config_path = Path(f"plant_configs/{plant_id}.yaml")
    if not config_path.exists():
        raise FileNotFoundError(f"Plant config not found: {config_path}")

    with open(config_path) as f:
        return yaml.safe_load(f)


def fetch_rain_forecast(latitude: float, longitude: float, output_file: Path) -> bool:
    """
    Fetch precipitation forecast from Open-Meteo.

    Variables fetched:
    - precipitation: Total precipitation (rain + snow water equivalent) in mm
    - rain: Liquid precipitation only in mm
    - snowfall: Snowfall in cm

    Forecast Horizon: 16 days (384 hours)
    Temporal Resolution: Hourly
    Update Frequency: Every 6 hours

    Quality: ⭐⭐⭐⭐ (validated against major weather models)
    """
    if not REQUESTS_AVAILABLE:
        raise ImportError("requests is required. Install with: pip install requests")

    print(f"\nFetching Open-Meteo Rain Forecast:")
    print(f"  Location: ({latitude}, {longitude})")
    print(f"  Forecast Horizon: 16 days (384 hours)")
    print(f"  Temporal Resolution: Hourly")
    print(f"  Variables: precipitation, rain, snowfall")
    print(f"  Quality: ⭐⭐⭐⭐ (validated against GFS/ECMWF)")

    # Open-Meteo Weather Forecast API
    url = "https://api.open-meteo.com/v1/forecast"

    params = {
        'latitude': latitude,
        'longitude': longitude,
        'hourly': 'precipitation,rain,snowfall',
        'forecast_days': 16,  # Maximum forecast horizon
        'timezone': 'auto',
    }

    try:
        print(f"\nDownloading forecast data...")
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        data = response.json()

        print(f"✅ Downloaded forecast data")

        # Parse hourly data
        hourly = data.get('hourly', {})
        times = hourly.get('time', [])
        precipitation = hourly.get('precipitation', [])
        rain = hourly.get('rain', [])
        snowfall = hourly.get('snowfall', [])

        # Convert to our format
        forecast_data = []
        for i, time_str in enumerate(times):
            forecast_data.append({
                'timestamp': time_str,
                'precipitation_mm': precipitation[i] if i < len(precipitation) else 0,
                'rain_mm': rain[i] if i < len(rain) else 0,
                'snowfall_cm': snowfall[i] if i < len(snowfall) else 0,
            })

        # Aggregate to daily for summary
        from collections import defaultdict
        daily_totals = defaultdict(lambda: {'precip': 0, 'rain': 0, 'snow': 0})

        for record in forecast_data:
            date = record['timestamp'].split('T')[0]
            daily_totals[date]['precip'] += record['precipitation_mm']
            daily_totals[date]['rain'] += record['rain_mm']
            daily_totals[date]['snow'] += record['snowfall_cm']

        daily_data = [
            {
                'date': date,
                'precipitation_mm': round(totals['precip'], 2),
                'rain_mm': round(totals['rain'], 2),
                'snowfall_cm': round(totals['snow'], 2),
            }
            for date, totals in sorted(daily_totals.items())
        ]

        # Calculate statistics
        total_precip = sum(d['precipitation_mm'] for d in daily_data)
        rain_days = len([d for d in daily_data if d['precipitation_mm'] > 1.0])
        max_daily = max((d['precipitation_mm'] for d in daily_data), default=0)

        output_data = {
            'metadata': {
                'location': {'latitude': latitude, 'longitude': longitude},
                'data_source': 'Open-Meteo Weather Forecast API',
                'forecast_horizon': '16 days',
                'temporal_resolution': 'Hourly',
                'variables': ['precipitation_mm', 'rain_mm', 'snowfall_cm'],
                'quality': '⭐⭐⭐⭐ (validated against GFS/ECMWF)',
                'generated_at': datetime.utcnow().isoformat() + 'Z',
                'record_count_hourly': len(forecast_data),
                'record_count_daily': len(daily_data),
                'statistics': {
                    'total_precipitation_mm': round(total_precip, 2),
                    'rain_days_forecast': rain_days,
                    'max_daily_mm': round(max_daily, 2),
                }
            },
            'hourly_data': forecast_data,
            'daily_data': daily_data,
        }

        # Save to JSON
        with open(output_file, 'w') as f:
            json.dump(output_data, f, indent=2)

        print(f"✅ Saved: {output_file}")
        print(f"\nForecast Statistics:")
        print(f"  Forecast period: {daily_data[0]['date']} to {daily_data[-1]['date']}")
        print(f"  Total forecast precipitation: {total_precip:.1f} mm")
        print(f"  Rain days (>1mm): {rain_days}")
        print(f"  Max daily: {max_daily:.1f} mm")

        return True

    except requests.exceptions.RequestException as e:
        print(f"❌ Download failed: {e}")
        return False
    except Exception as e:
        print(f"❌ Processing failed: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Fetch Open-Meteo Rain Forecast")
    parser.add_argument("--plant-id", required=True, help="Plant identifier (e.g., eta, ribera, alpha1)")

    args = parser.parse_args()

    # Load plant configuration
    config = load_plant_config(args.plant_id)
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']

    # Output directory
    output_dir = Path(f"public/data/soiling/{args.plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "rain_forecast.json"

    print("=" * 70)
    print(f"FETCH RAIN FORECAST FOR {args.plant_id.upper()}")
    print("=" * 70)

    # Fetch forecast
    success = fetch_rain_forecast(
        latitude=latitude,
        longitude=longitude,
        output_file=output_file
    )

    if success:
        print(f"\n✅ Complete! Rain forecast saved to: {output_file}")
        return 0
    else:
        print("\n❌ Failed to fetch forecast")
        return 1


if __name__ == "__main__":
    exit(main())
