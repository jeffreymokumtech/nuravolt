#!/usr/bin/env python3
"""
Generate Soiling Ratio forecasts for visualization and analysis.

This script generates two types of forecasts:
1. Short-term (30 days): ML model + weather/AOD forecast for days 1-7,
   seasonal patterns for days 8-30
2. Annual (365 days): Daily soiling rates using seasonal patterns

Usage:
    # Generate 30-day short-term forecast
    python scripts/generate_sr_forecast.py --plant alpha1

    # Generate annual soiling rate forecast
    python scripts/generate_sr_forecast.py --plant alpha1 --annual

    # Generate both forecasts
    python scripts/generate_sr_forecast.py --plant alpha1 --both

    # Specify current SR (from DustIQ or estimate)
    python scripts/generate_sr_forecast.py --plant alpha1 --current-sr 0.985
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

import pandas as pd


# Plant configurations
PLANT_CONFIGS = {
    'alpha1': {
        'name': 'ALPHA1 - Alpha Solar',
        'latitude': 37.8145,
        'longitude': -3.8047,
        'timezone': 'Europe/Madrid',
        'model_path': 'models/soiling/sr_foundation_alpha1.pkl',
        'dustiq_path': 'public/data/soiling/alpha1/dustiq_history.json',
        'weather_path': 'public/data/soiling/alpha1/rain_history.json',
        'pr_path': 'public/data/soiling/alpha1/time_series/daily_pr.json',
    }
}


def get_current_sr(plant_id: str) -> float:
    """Get current SR from DustIQ data or return default."""
    config = PLANT_CONFIGS.get(plant_id)
    if not config:
        return 1.0

    dustiq_path = project_root / config['dustiq_path']
    if dustiq_path.exists():
        try:
            with open(dustiq_path, 'r') as f:
                data = json.load(f)
            # Get most recent SR
            if 'daily_data' in data and data['daily_data']:
                latest = data['daily_data'][-1]
                sr = latest.get('sr_dustiq', latest.get('sr_mean', 1.0))
                print(f"📊 Current SR from DustIQ: {sr:.4f}")
                return sr
        except Exception as e:
            print(f"Warning: Could not read DustIQ data: {e}")

    return 1.0


def load_recent_weather(plant_id: str, days: int = 30) -> pd.DataFrame:
    """Load recent weather data for feature generation."""
    config = PLANT_CONFIGS.get(plant_id)
    if not config:
        return None

    weather_path = project_root / config['weather_path']
    if not weather_path.exists():
        return None

    try:
        with open(weather_path, 'r') as f:
            data = json.load(f)

        df = pd.DataFrame(data['daily_data'])
        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date')

        # Get last N days
        df = df.tail(days)

        # Rename columns if needed
        if 'precipitation_mm' not in df.columns and 'precipitation' in df.columns:
            df['precipitation_mm'] = df['precipitation']

        return df
    except Exception as e:
        print(f"Warning: Could not load weather data: {e}")
        return None


def load_recent_pr(plant_id: str, days: int = 30) -> pd.DataFrame:
    """Load recent PR data for feature generation."""
    config = PLANT_CONFIGS.get(plant_id)
    if not config:
        return None

    pr_path = project_root / config['pr_path']
    if not pr_path.exists():
        return None

    try:
        with open(pr_path, 'r') as f:
            data = json.load(f)

        if 'data' in data:
            df = pd.DataFrame(data['data'])
        else:
            df = pd.DataFrame(data)

        df['date'] = pd.to_datetime(df['date'])

        # Aggregate to daily if needed
        if 'inverter' in df.columns or 'inverter_id' in df.columns:
            df = df.groupby('date').agg({'pr': 'mean'}).reset_index()

        df = df.set_index('date')

        # Get last N days
        df = df.tail(days)

        return df
    except Exception as e:
        print(f"Warning: Could not load PR data: {e}")
        return None


def generate_short_term_forecast(
    plant_id: str,
    current_sr: float,
    output_dir: str = None
):
    """Generate 30-day short-term forecast."""
    from nuravolt.soiling.sr_forecast import SoilingRatioForecaster

    config = PLANT_CONFIGS.get(plant_id)
    if not config:
        raise ValueError(f"Unknown plant: {plant_id}")

    print(f"\n{'='*60}")
    print(f"SHORT-TERM (30-DAY) SOILING RATIO FORECAST")
    print(f"Plant: {config['name']}")
    print(f"{'='*60}\n")

    # Load recent data for feature generation
    df_weather_recent = load_recent_weather(plant_id)
    df_pr_recent = load_recent_pr(plant_id)

    if df_weather_recent is not None:
        print(f"📊 Loaded {len(df_weather_recent)} days of recent weather")
    if df_pr_recent is not None:
        print(f"📊 Loaded {len(df_pr_recent)} days of recent PR data")

    # Initialize forecaster
    model_path = project_root / config['model_path']
    forecaster = SoilingRatioForecaster(
        model_path=str(model_path),
        latitude=config['latitude'],
        longitude=config['longitude'],
        timezone=config['timezone'],
        plant_id=plant_id
    )

    # Generate forecast
    result = forecaster.forecast(
        current_sr=current_sr,
        days=30,
        df_pr_recent=df_pr_recent,
        df_weather_historical=df_weather_recent
    )

    # Save to JSON
    if output_dir:
        output_path = Path(output_dir) / 'sr_forecast.json'
    else:
        output_path = project_root / 'public' / 'data' / 'soiling' / plant_id / 'sr_forecast.json'

    output_path.parent.mkdir(parents=True, exist_ok=True)

    data = result.to_dict()
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"\n💾 Forecast saved to: {output_path}")

    # Print summary
    print(f"\n📋 FORECAST SUMMARY")
    print(f"   Current SR: {current_sr:.4f}")
    print(f"   Min SR forecast: {result.min_sr_forecast:.4f}")
    print(f"   Max soiling loss: {result.max_soiling_loss_pct:.2f}%")
    if result.rain_cleaning_expected:
        print(f"   🌧️  Rain cleaning expected in ~{result.days_until_rain} day(s)")
    print(f"   Recommendation: {result.cleaning_recommendation}")

    return data


def generate_annual_forecast(
    plant_id: str,
    output_dir: str = None,
    cleanings_per_year: int = 4
):
    """Generate 365-day annual soiling rate forecast."""
    from nuravolt.soiling.annual_soiling_rate import AnnualSoilingRateForecast

    config = PLANT_CONFIGS.get(plant_id)
    if not config:
        raise ValueError(f"Unknown plant: {plant_id}")

    print(f"\n{'='*60}")
    print(f"ANNUAL (365-DAY) SOILING RATE FORECAST")
    print(f"Plant: {config['name']}")
    print(f"{'='*60}\n")

    # Initialize forecaster
    forecaster = AnnualSoilingRateForecast(
        latitude=config['latitude'],
        longitude=config['longitude'],
        plant_id=plant_id
    )

    # Generate forecast
    result = forecaster.generate_forecast(
        cleanings_per_year=cleanings_per_year
    )

    # Save to JSON
    if output_dir:
        output_path = Path(output_dir) / 'annual_soiling_forecast.json'
    else:
        output_path = project_root / 'public' / 'data' / 'soiling' / plant_id / 'annual_soiling_forecast.json'

    output_path.parent.mkdir(parents=True, exist_ok=True)

    data = result.to_dict()
    with open(output_path, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"\n💾 Forecast saved to: {output_path}")

    # Print summary
    print(f"\n📋 ANNUAL FORECAST SUMMARY")
    print(f"   Average soiling rate: {result.avg_soiling_rate_pct_day:.3f} %/day")
    print(f"   Expected annual loss (no cleaning): {result.expected_annual_loss_pct:.1f}%")
    print(f"   Expected annual loss (with {result.recommended_cleanings} cleanings): {result.expected_loss_with_cleaning_pct:.1f}%")
    print(f"   Optimal cleaning months: {', '.join(result.optimal_cleaning_months)}")

    # Print monthly breakdown
    print(f"\n📊 MONTHLY SOILING RATES:")
    for m in result.monthly_summary:
        bar = "█" * int(m.soiling_rate_pct_day * 10)
        print(f"   {m.month_name:12s}: {m.soiling_rate_pct_day:.3f} %/day {bar}")

    return data


def main():
    parser = argparse.ArgumentParser(
        description='Generate Soiling Ratio forecasts',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Generate 30-day short-term forecast
    python scripts/generate_sr_forecast.py --plant alpha1

    # Generate annual soiling rate forecast
    python scripts/generate_sr_forecast.py --plant alpha1 --annual

    # Generate both forecasts
    python scripts/generate_sr_forecast.py --plant alpha1 --both

    # Specify current SR
    python scripts/generate_sr_forecast.py --plant alpha1 --current-sr 0.985
        """
    )

    parser.add_argument(
        '--plant', '-p',
        default='alpha1',
        help='Plant ID (default: alpha1)'
    )
    parser.add_argument(
        '--annual',
        action='store_true',
        help='Generate annual (365-day) soiling rate forecast'
    )
    parser.add_argument(
        '--both',
        action='store_true',
        help='Generate both short-term and annual forecasts'
    )
    parser.add_argument(
        '--current-sr',
        type=float,
        help='Current soiling ratio (default: read from DustIQ)'
    )
    parser.add_argument(
        '--output', '-o',
        help='Output directory (default: public/data/soiling/<plant>/)'
    )
    parser.add_argument(
        '--cleanings',
        type=int,
        default=4,
        help='Number of cleanings per year for annual forecast (default: 4)'
    )

    args = parser.parse_args()

    # Validate plant
    if args.plant not in PLANT_CONFIGS:
        print(f"Error: Unknown plant '{args.plant}'")
        print(f"Available plants: {', '.join(PLANT_CONFIGS.keys())}")
        sys.exit(1)

    # Get current SR
    if args.current_sr is not None:
        current_sr = args.current_sr
    else:
        current_sr = get_current_sr(args.plant)

    # Generate forecasts
    if args.both:
        generate_short_term_forecast(args.plant, current_sr, args.output)
        print("\n" + "="*60 + "\n")
        generate_annual_forecast(args.plant, args.output, args.cleanings)
    elif args.annual:
        generate_annual_forecast(args.plant, args.output, args.cleanings)
    else:
        generate_short_term_forecast(args.plant, current_sr, args.output)


if __name__ == '__main__':
    main()
