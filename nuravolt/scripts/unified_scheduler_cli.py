#!/usr/bin/env python3
"""
CLI interface for unified cleaning scheduler.

Called by Next.js API route via subprocess.
Reads JSON from stdin, returns JSON to stdout.

Commands:
- optimize: Run optimization for specified horizon
- optimize_zones: Get per-zone schedules
- compare_horizons: Compare 30d/90d/365d results
- get_summary: Get human-readable summary
"""

import sys
import json
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import dataclass

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pandas as pd
import numpy as np


@dataclass
class MockSoilingConfig:
    """Mock config for testing without database."""
    capacity_MW: float = 10.0
    cleaning_cost_per_MW: float = 400.0
    electricity_rate_per_MWh: float = 50.0
    min_days_between: int = 14


def load_forecast_data(plant_id: str, horizon_days: int = 365) -> pd.DataFrame:
    """
    Load forecast data for a plant.

    In production, this would query the database or load from files.
    For now, generates synthetic data for testing.
    """
    # Try to load from static JSON files
    forecast_path = Path(__file__).parent.parent.parent.parent / 'public' / 'data' / 'soiling' / f'{plant_id}_forecast.json'

    if forecast_path.exists():
        with open(forecast_path) as f:
            data = json.load(f)
            if 'forecast' in data:
                df = pd.DataFrame(data['forecast'])
                df['date'] = pd.to_datetime(df['date'])
                df = df.set_index('date')
                return df

    # Generate synthetic forecast
    dates = pd.date_range(
        start=datetime.now(),
        periods=horizon_days,
        freq='D'
    )

    # Simulate SR degradation with seasonal variation
    base_sr = 0.98
    daily_soiling = 0.002  # 0.2%/day
    sr_values = []

    current_sr = base_sr
    for date in dates:
        # Seasonal variation (faster soiling in dry summer)
        month = date.month
        if month in (6, 7, 8):  # Summer
            rate = daily_soiling * 1.5
        elif month in (12, 1, 2):  # Winter
            rate = daily_soiling * 0.7
        else:
            rate = daily_soiling

        current_sr = max(0.85, current_sr - rate)
        sr_values.append(current_sr)

        # Simulate occasional rain resets (every ~30 days)
        if np.random.random() < 0.03:
            current_sr = min(0.98, current_sr + 0.02)

    df = pd.DataFrame({
        'sr_predicted': sr_values,
        'energy_if_clean_MWh': [40.0] * len(dates),  # ~4 MWh/MW/day for 10MW plant
        'soiling_loss_pct': [(1 - sr) * 100 for sr in sr_values],
    }, index=dates)

    return df


def load_sr_data(plant_id: str) -> pd.DataFrame:
    """
    Load historical SR data with inverter columns.

    Returns DataFrame with inverter columns for zone detection.
    """
    # Generate synthetic SR data with zone patterns
    dates = pd.date_range(
        start=datetime.now() - timedelta(days=90),
        end=datetime.now(),
        freq='D'
    )

    # Create inverter columns with zone patterns
    zones = {
        'Zone_A': ['INV_A1', 'INV_A2', 'INV_A3', 'INV_A4'],
        'Zone_B': ['INV_B1', 'INV_B2', 'INV_B3', 'INV_B4'],
        'Zone_C': ['INV_C1', 'INV_C2', 'INV_C3', 'INV_C4'],
    }

    data = {'date': dates}

    for zone_name, inverters in zones.items():
        # Each zone has slightly different soiling characteristics
        zone_offset = {'Zone_A': 0.0, 'Zone_B': -0.02, 'Zone_C': -0.01}[zone_name]

        for inv in inverters:
            sr_values = []
            current_sr = 0.98 + zone_offset
            for _ in dates:
                current_sr = max(0.85, current_sr - 0.002 + np.random.normal(0, 0.001))
                sr_values.append(current_sr)
            data[inv] = sr_values

    df = pd.DataFrame(data)
    df = df.set_index('date')

    return df


def get_site_config(plant_id: str) -> MockSoilingConfig:
    """Get site configuration for a plant."""
    # In production, this would query the database
    return MockSoilingConfig(
        capacity_MW=10.0,
        cleaning_cost_per_MW=400.0,
        electricity_rate_per_MWh=50.0,
        min_days_between=14
    )


def handle_optimize(input_data: dict) -> dict:
    """Handle optimize command."""
    from nuravolt.soiling.cleaning import UnifiedScheduler

    plant_id = input_data.get('plant_id')
    horizon = input_data.get('horizon', 90)
    zone_level = input_data.get('zone_level', False)

    # Load data
    config = get_site_config(plant_id)
    df_forecast = load_forecast_data(plant_id, horizon)

    sr_data = None
    if zone_level:
        sr_data = load_sr_data(plant_id)

    # Run optimization
    scheduler = UnifiedScheduler(config)
    result = scheduler.optimize(
        df_forecast=df_forecast,
        horizon=horizon,
        sr_data=sr_data,
        zone_level=zone_level
    )

    return {
        'success': True,
        'result': result.to_dict(),
        'summary': scheduler.get_summary(result),
    }


def handle_optimize_zones(input_data: dict) -> dict:
    """Handle optimize_zones command."""
    from nuravolt.soiling.cleaning import UnifiedScheduler

    plant_id = input_data.get('plant_id')
    horizon = input_data.get('horizon', 90)

    # Load data
    config = get_site_config(plant_id)
    df_forecast = load_forecast_data(plant_id, horizon)
    sr_data = load_sr_data(plant_id)

    # Run zone optimization
    scheduler = UnifiedScheduler(config)
    zone_results = scheduler.optimize_zones(
        df_forecast=df_forecast,
        sr_data=sr_data,
        horizon=horizon
    )

    return {
        'success': True,
        'zones': [z.to_dict() for z in zone_results],
        'n_zones': len(zone_results),
    }


def handle_compare_horizons(input_data: dict) -> dict:
    """Handle compare_horizons command."""
    from nuravolt.soiling.cleaning import UnifiedScheduler

    plant_id = input_data.get('plant_id')

    # Load data
    config = get_site_config(plant_id)
    df_forecast = load_forecast_data(plant_id, 365)
    sr_data = load_sr_data(plant_id)

    # Run comparison
    scheduler = UnifiedScheduler(config)
    results = scheduler.compare_horizons(
        df_forecast=df_forecast,
        sr_data=sr_data
    )

    return {
        'success': True,
        'comparison': {
            horizon: {
                'result': result.to_dict(),
                'summary': scheduler.get_summary(result),
            }
            for horizon, result in results.items()
        }
    }


def handle_get_horizon_info(input_data: dict) -> dict:
    """Handle get_horizon_info command."""
    from nuravolt.soiling.cleaning import UnifiedScheduler

    config = MockSoilingConfig()
    scheduler = UnifiedScheduler(config)

    return {
        'success': True,
        'horizons': {
            '30d': scheduler.get_horizon_description(30),
            '90d': scheduler.get_horizon_description(90),
            '365d': scheduler.get_horizon_description(365),
        }
    }


def main():
    """Main entry point."""
    try:
        # Read input from stdin
        input_text = sys.stdin.read()
        input_data = json.loads(input_text)

        command = input_data.get('command', 'optimize')

        # Route to handler
        handlers = {
            'optimize': handle_optimize,
            'optimize_zones': handle_optimize_zones,
            'compare_horizons': handle_compare_horizons,
            'get_horizon_info': handle_get_horizon_info,
        }

        handler = handlers.get(command)
        if handler is None:
            result = {'success': False, 'error': f'Unknown command: {command}'}
        else:
            result = handler(input_data)

        # Output JSON
        print(json.dumps(result, indent=2, default=str))

    except Exception as e:
        error_result = {
            'success': False,
            'error': str(e),
            'type': type(e).__name__,
        }
        print(json.dumps(error_result), file=sys.stdout)
        sys.exit(1)


if __name__ == '__main__':
    main()
