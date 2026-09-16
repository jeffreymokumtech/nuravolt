#!/usr/bin/env python3
"""
Fetch fallback weather (irradiance, ambient temp, wind) for a plant.

Backfills satellite/model weather via nuravolt/weather so plants WITHOUT an
on-site pyranometer (all residential, many C&I) can run the digital twin and
per-inverter SR from day 1. Output feeds the soiling onboarding pipeline.

Usage:
    python scripts/fetch_weather_fallback.py --plant-id eta \
        --start-date 2023-01-01 --end-date 2024-12-31
    # or without a plant_configs yaml:
    python scripts/fetch_weather_fallback.py --plant-id newsite \
        --lat 37.94 --lon -1.22 --start-date 2024-01-01 --end-date 2024-12-31

Output: public/data/soiling/{plant_id}/weather_openmeteo.parquet
        (columns: ghi, poa, temp_air, wind_speed, cloud_cover; naive local time)
"""

import argparse
import json
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.weather import get_fallback_weather


def _lookup(config: dict, *keys, default=None):
    """Find the first present key, searching one level of nesting too."""
    for key in keys:
        if key in config:
            return config[key]
    for value in config.values():
        if isinstance(value, dict):
            for key in keys:
                if key in value:
                    return value[key]
    return default


def load_plant_location(project_root: Path, plant_id: str):
    config_path = project_root / 'plant_configs' / f'{plant_id}.yaml'
    if not config_path.exists():
        return {}
    with open(config_path) as f:
        config = yaml.safe_load(f) or {}
    return {
        'latitude': _lookup(config, 'latitude', 'lat'),
        'longitude': _lookup(config, 'longitude', 'lon', 'lng'),
        'timezone': _lookup(config, 'timezone', 'tz', default='auto'),
        'tilt': _lookup(config, 'tilt'),
        'azimuth': _lookup(config, 'azimuth'),
    }


def main():
    parser = argparse.ArgumentParser(description='Fetch fallback weather for a plant')
    parser.add_argument('--plant-id', required=True)
    parser.add_argument('--start-date', required=True, help='YYYY-MM-DD')
    parser.add_argument('--end-date', required=True, help='YYYY-MM-DD')
    parser.add_argument('--lat', type=float, help='Override/replace plant config latitude')
    parser.add_argument('--lon', type=float, help='Override/replace plant config longitude')
    parser.add_argument('--timezone', default=None, help="IANA tz (default: from config or 'auto')")
    parser.add_argument('--tilt', type=float, default=None)
    parser.add_argument('--azimuth', type=float, default=None)
    parser.add_argument('--freq', default='15min', help='Target cadence (default 15min)')
    args = parser.parse_args()

    project_root = Path(__file__).parent.parent
    loc = load_plant_location(project_root, args.plant_id)

    latitude = args.lat if args.lat is not None else loc.get('latitude')
    longitude = args.lon if args.lon is not None else loc.get('longitude')
    timezone = args.timezone or loc.get('timezone') or 'auto'
    tilt = args.tilt if args.tilt is not None else loc.get('tilt')
    azimuth = args.azimuth if args.azimuth is not None else loc.get('azimuth')

    if latitude is None or longitude is None:
        print(f"❌ No coordinates for '{args.plant_id}' — pass --lat/--lon or add "
              f"latitude/longitude to plant_configs/{args.plant_id}.yaml")
        return 1

    print(f"🌤️ Fetching fallback weather for {args.plant_id} "
          f"({latitude:.4f}, {longitude:.4f}) {args.start_date}..{args.end_date}")

    fw = get_fallback_weather(
        latitude, longitude, args.start_date, args.end_date,
        freq=args.freq, tilt=tilt, azimuth=azimuth, timezone=timezone,
    )

    out_dir = project_root / 'public' / 'data' / 'soiling' / args.plant_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / 'weather_openmeteo.parquet'
    fw.data.to_parquet(out_file)
    (out_dir / 'weather_openmeteo.meta.json').write_text(json.dumps(fw.provenance, indent=2))

    print(f"   ✅ {len(fw.data):,} rows [{fw.source}, confidence {fw.confidence:.2f}] → {out_file}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
