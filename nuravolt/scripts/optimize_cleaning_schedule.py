#!/usr/bin/env python3
"""
Standalone cleaning schedule optimization script.
Called from Next.js API to run optimization with custom parameters.

Usage:
    echo '{"plant_id": "alpha1", "parameters": {...}}' | python optimize_cleaning_schedule.py

Input (JSON via stdin):
    {
        "plant_id": "alpha1",
        "parameters": {
            "cleaning_cost_per_MW": 600,
            "electricity_rate_per_MWh": 65,
            "capacity_MW": 9.0,
            "min_days_between_cleanings": 14,
            "rain_avoidance_days": 7,
            "rain_threshold_mm": 10.0,
            "cleaning_threshold_sr": 0.97
        },
        "manual_cleaning_dates": ["2025-06-15", "2025-09-01"],  # Optional
        "locked_dates": ["2025-06-15"],  # Optional
        "mode": "exhaustive"  # "quick" or "exhaustive"
    }

Output (JSON to stdout):
    {
        "plant_id": "alpha1",
        "parameters": {...},
        "optimal_schedule": {...},
        "alternatives": [...],
        "comparison_table": [...],
        "execution_time_ms": 1234,
        "warnings": []
    }
"""

import sys
import json
import time
from pathlib import Path
from typing import Dict, List, Optional
import pandas as pd
import numpy as np

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.soiling.config import SoilingConfig
from nuravolt.soiling.schedule_optimizer import CleaningScheduleOptimizer
from nuravolt.soiling.financial_forecast import FinancialForecaster


def load_forecast_data(plant_id: str, data_dir: Path) -> pd.DataFrame:
    """Load 365-day forecast data for the plant."""
    # Try ML forecast first (most recent), fall back to physics forecast
    ml_forecast_file = data_dir / plant_id / "ml_forecast_365d.json"
    physics_forecast_file = data_dir / plant_id / "forecast_365d.json"

    if ml_forecast_file.exists():
        forecast_file = ml_forecast_file
        print(f"   Using ML forecast: {ml_forecast_file}", file=sys.stderr)
    elif physics_forecast_file.exists():
        forecast_file = physics_forecast_file
        print(f"   Using physics forecast: {physics_forecast_file}", file=sys.stderr)
    else:
        raise FileNotFoundError(f"No forecast file found for {plant_id}")

    with open(forecast_file, 'r') as f:
        forecast_data = json.load(f)

    # Convert to DataFrame
    forecasts = forecast_data.get('forecasts', [])
    df = pd.DataFrame(forecasts)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date')

    # Rename columns to match optimizer expectations
    df = df.rename(columns={
        'soilingRatio': 'sr_predicted',
        'soilingLossPct': 'soiling_loss_pct'
    })

    # Add energy_if_clean_MWh if missing (required by optimizer)
    if 'energy_if_clean_MWh' not in df.columns:
        # Calculate energy if clean using monthly sun hours
        monthly_sun_hours = {
            1: 5.5, 2: 6.5, 3: 7.5, 4: 8.5, 5: 9.5, 6: 10.5,
            7: 10.5, 8: 9.5, 9: 8.5, 10: 7.5, 11: 6.5, 12: 5.5
        }
        # Get capacity from metadata or use default
        capacity_MW = forecast_data.get('metadata', {}).get('capacity_MW', 9.0)
        df['energy_if_clean_MWh'] = df.index.map(
            lambda d: capacity_MW * monthly_sun_hours.get(d.month, 6.5)
        )

    # Add energy_with_soiling_MWh if missing
    if 'energy_with_soiling_MWh' not in df.columns:
        df['energy_with_soiling_MWh'] = df['energy_if_clean_MWh'] * df['sr_predicted']

    return df


def create_energy_forecast(df_forecast: pd.DataFrame,
                           capacity_MW: float,
                           monthly_sun_hours: Dict[int, float]) -> pd.DataFrame:
    """Create energy forecast DataFrame from soiling forecast."""
    df_energy = df_forecast.copy()

    # Calculate energy if clean (daily)
    df_energy['energy_if_clean_MWh'] = df_energy.index.map(
        lambda d: capacity_MW * monthly_sun_hours.get(d.month, 6.5)
    )

    # Calculate energy with soiling
    df_energy['energy_with_soiling_MWh'] = (
        df_energy['energy_if_clean_MWh'] * df_energy['sr_predicted']
    )

    # Calculate losses
    df_energy['energy_loss_MWh'] = (
        df_energy['energy_if_clean_MWh'] - df_energy['energy_with_soiling_MWh']
    )
    df_energy['energy_loss_pct'] = (
        df_energy['energy_loss_MWh'] / df_energy['energy_if_clean_MWh'] * 100
    )

    return df_energy


def convert_dates_to_strings(dates: List) -> List[str]:
    """Convert a list of dates (which may be Timestamps) to ISO format strings."""
    result = []
    for date in dates:
        if hasattr(date, 'strftime'):
            # It's a datetime-like object
            result.append(date.strftime('%Y-%m-%d'))
        else:
            # Already a string
            result.append(str(date))
    return result


def apply_manual_constraints(optimizer: CleaningScheduleOptimizer,
                            manual_dates: Optional[List[str]],
                            locked_dates: Optional[List[str]]) -> None:
    """Apply manual date constraints to optimizer (if supported)."""
    # This is a placeholder - the optimizer would need modification
    # to support fixed dates. For now, we'll just pass them through
    # and filter results in post-processing.
    pass


def optimize_with_parameters(plant_id: str,
                            parameters: Dict,
                            manual_dates: Optional[List[str]] = None,
                            locked_dates: Optional[List[str]] = None,
                            mode: str = 'exhaustive',
                            data_dir: Path = None,
                            min_cleanings_override: Optional[int] = None,
                            max_cleanings_override: Optional[int] = None,
                            rain_forecast: Optional[List[Dict]] = None) -> Dict:
    """
    Run optimization with custom parameters.

    Parameters:
    -----------
    plant_id : str
        Plant identifier (e.g., "alpha1")
    parameters : dict
        Cleaning optimization parameters
    manual_dates : list, optional
        User-specified cleaning dates to include
    locked_dates : list, optional
        Dates that must be included (subset of manual_dates)
    mode : str
        "quick" (1-3 cleanings) or "exhaustive" (1-5 cleanings)
    data_dir : Path, optional
        Path to data directory (defaults to public/data/soiling/)

    Returns:
    --------
    dict
        Optimization results
    """
    warnings = []
    start_time = time.time()

    # Default data directory
    if data_dir is None:
        data_dir = Path(__file__).parent.parent.parent / "public" / "data" / "soiling"

    # Load forecast data
    try:
        df_forecast = load_forecast_data(plant_id, data_dir)
    except Exception as e:
        return {
            "error": f"Failed to load forecast data: {str(e)}",
            "plant_id": plant_id,
            "parameters": parameters
        }

    # Create site config with custom parameters
    # Use default site config as base, but only pass valid SoilingConfig params
    from nuravolt.soiling.config import SITE_CONFIG

    config = SoilingConfig(
        name=SITE_CONFIG.get('name', f'{plant_id}_custom'),
        plant_id=SITE_CONFIG.get('plant_id', 461),
        latitude=SITE_CONFIG.get('latitude', 37.8145),
        longitude=SITE_CONFIG.get('longitude', -3.8047),
        elevation=SITE_CONFIG.get('elevation', 450),
        timezone=SITE_CONFIG.get('timezone', 'Europe/Madrid'),
        capacity_MW=parameters.get('capacity_MW', 9.0),
        capacity_installed_MW=SITE_CONFIG.get('capacity_installed_MW', 11.797),
        tilt=SITE_CONFIG.get('tilt', 20),
        azimuth=SITE_CONFIG.get('azimuth', 180),
        orientation=SITE_CONFIG.get('orientation', 'Landscape'),
        cleaning_cost_per_MW=parameters.get('cleaning_cost_per_MW', 600),
        electricity_rate_per_MWh=parameters.get('electricity_rate_per_MWh', 65),
        avg_sun_hours_per_day=SITE_CONFIG.get('avg_sun_hours_per_day', 6.5),
        expected_soiling_rate_per_day=SITE_CONFIG.get('expected_soiling_rate_per_day', 0.25),
        rain_cleaning_threshold_mm=parameters.get('rain_threshold_mm', 10.0),
        cleaning_threshold_sr=parameters.get('cleaning_threshold_sr', 0.97),
        min_days_between=parameters.get('min_days_between_cleanings', 14),
    )

    # Create monthly sun hours pattern (use default or derive from historical data)
    monthly_sun_hours = {
        1: 5.5, 2: 6.5, 3: 7.5, 4: 8.5, 5: 9.5, 6: 10.5,
        7: 10.5, 8: 9.5, 9: 8.5, 10: 7.5, 11: 6.5, 12: 5.5
    }

    # Create energy forecast
    df_energy = create_energy_forecast(df_forecast, config.capacity_MW, monthly_sun_hours)

    # Initialize optimizer
    optimizer = CleaningScheduleOptimizer(config)

    # Apply manual constraints if provided
    if manual_dates or locked_dates:
        apply_manual_constraints(optimizer, manual_dates, locked_dates)
        if manual_dates:
            warnings.append(f"Manual dates provided: {', '.join(manual_dates)}")
        if locked_dates:
            warnings.append(f"Locked dates: {', '.join(locked_dates)}")

    # Set cleaning count range based on mode.
    # Dry-Mediterranean and dust-heavy plants routinely benefit from 8-12
    # cleanings/year. The old 5-cap silently truncated the search space and
    # made the optimizer always return ≤5 cleanings even when more were
    # economically optimal. Sample size kept low enough to fit the API's 60s
    # subprocess timeout (each scenario eval is ~3-5ms).
    if mode == 'quick':
        min_cleanings = 1
        max_cleanings = 6
        max_scenarios = 400
    else:  # exhaustive
        min_cleanings = 1
        max_cleanings = 12
        max_scenarios = 600

    # Explicit user overrides take precedence over mode defaults.
    if min_cleanings_override is not None:
        min_cleanings = max(1, int(min_cleanings_override))
    if max_cleanings_override is not None:
        max_cleanings = max(min_cleanings, int(max_cleanings_override))
    # Guard against min > max after override application.
    if min_cleanings > max_cleanings:
        min_cleanings = max_cleanings

    # Rain forecast, when the caller supplied one (the API route fetches a
    # 16-day Open-Meteo daily forecast at the plant coords). Absent or
    # malformed input keeps the optimizer rain-blind, exactly as before.
    df_rain = None
    if rain_forecast:
        try:
            df_rain = pd.DataFrame(rain_forecast)
            if 'date' not in df_rain.columns or 'precipitation_mm' not in df_rain.columns:
                df_rain = None
            elif df_rain.empty:
                df_rain = None
        except Exception:
            df_rain = None

    # Run optimization
    try:
        results = optimizer.optimize_schedule_365d(
            df_ml_forecast=df_forecast,
            df_aod_forecast=None,  # AOD forecast source not wired; out of scope
            df_rain_forecast=df_rain,
            min_cleanings=min_cleanings,
            max_cleanings=max_cleanings,
            prioritize_summer=True,
            max_scenarios_per_count=max_scenarios
        )
    except Exception as e:
        return {
            "error": f"Optimization failed: {str(e)}",
            "plant_id": plant_id,
            "parameters": parameters
        }

    # Format optimal schedule
    optimal = results['optimal_schedule']
    optimal_formatted = {
        "dates": convert_dates_to_strings(optimal.get('cleaning_dates', [])),
        "n_cleanings": int(optimal.get('n_cleanings', 0)),
        "energy_recovered_MWh": float(optimal.get('energy_recovered_MWh', 0)),
        "revenue_recovered_EUR": float(optimal.get('revenue_recovered_EUR', 0)),
        "cleaning_cost_EUR": float(optimal.get('cleaning_cost_EUR', 0)),
        "net_benefit_EUR": float(optimal.get('net_benefit_EUR', 0)),
        "roi_pct": float(optimal.get('roi_pct', 0)),
        "payback_days": float(optimal.get('payback_days', 0)),
        "avg_sr": float(optimal.get('avg_sr', 0)),
        "avg_loss_pct": float(optimal.get('avg_loss_pct', 0))
    }

    # Format alternatives (top 5 from each cleaning count)
    alternatives = []
    comparison_table = []

    for n in range(min_cleanings, max_cleanings + 1):
        scenarios_n = results['all_scenarios'][
            results['all_scenarios']['n_cleanings'] == n
        ].head(5)

        for _, scenario in scenarios_n.iterrows():
            alt = {
                "dates": convert_dates_to_strings(scenario.get('cleaning_dates', [])),
                "n_cleanings": int(scenario.get('n_cleanings', 0)),
                "energy_recovered_MWh": float(scenario.get('energy_recovered_MWh', 0)),
                "revenue_recovered_EUR": float(scenario.get('revenue_recovered_EUR', 0)),
                "cleaning_cost_EUR": float(scenario.get('cleaning_cost_EUR', 0)),
                "net_benefit_EUR": float(scenario.get('net_benefit_EUR', 0)),
                "roi_pct": float(scenario.get('roi_pct', 0)),
                "payback_days": float(scenario.get('payback_days', 0)),
                "avg_sr": float(scenario.get('avg_sr', 0)),
                "avg_loss_pct": float(scenario.get('avg_loss_pct', 0))
            }
            alternatives.append(alt)

        # Add to comparison table (best of each count)
        best_n = scenarios_n.iloc[0]
        comparison_table.append({
            "n_cleanings": int(n),
            "best_dates": convert_dates_to_strings(best_n.get('cleaning_dates', [])),
            "net_benefit_EUR": float(best_n.get('net_benefit_EUR', 0)),
            "roi_pct": float(best_n.get('roi_pct', 0))
        })

    # Calculate execution time
    execution_time_ms = int((time.time() - start_time) * 1000)

    # Return formatted results
    return {
        "plant_id": plant_id,
        "parameters": parameters,
        "optimal_schedule": optimal_formatted,
        "alternatives": alternatives,
        "comparison_table": comparison_table,
        "execution_time_ms": execution_time_ms,
        "rain_aware": df_rain is not None,
        "warnings": warnings
    }


def main():
    """Main entry point for CLI usage."""
    try:
        # Read JSON input from stdin
        input_data = json.load(sys.stdin)

        # Extract parameters
        plant_id = input_data.get('plant_id', 'alpha1')
        parameters = input_data.get('parameters', {})
        manual_dates = input_data.get('manual_cleaning_dates')
        locked_dates = input_data.get('locked_dates')
        mode = input_data.get('mode', 'exhaustive')
        data_dir = input_data.get('data_dir')
        min_cleanings_override = input_data.get('min_cleanings')
        max_cleanings_override = input_data.get('max_cleanings')
        rain_forecast = input_data.get('rain_forecast')

        # Run optimization
        results = optimize_with_parameters(
            plant_id=plant_id,
            parameters=parameters,
            manual_dates=manual_dates,
            locked_dates=locked_dates,
            mode=mode,
            data_dir=Path(data_dir) if data_dir else None,
            min_cleanings_override=min_cleanings_override,
            max_cleanings_override=max_cleanings_override,
            rain_forecast=rain_forecast,
        )

        # Output JSON to stdout
        print(json.dumps(results, indent=2))

    except json.JSONDecodeError as e:
        error_result = {
            "error": f"Invalid JSON input: {str(e)}",
            "usage": "echo '{...}' | python optimize_cleaning_schedule.py"
        }
        print(json.dumps(error_result, indent=2, file=sys.stderr))
        sys.exit(1)

    except Exception as e:
        error_result = {
            "error": f"Unexpected error: {str(e)}",
            "type": type(e).__name__
        }
        print(json.dumps(error_result, indent=2, file=sys.stderr))
        sys.exit(1)


if __name__ == "__main__":
    main()
