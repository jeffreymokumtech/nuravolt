#!/usr/bin/env python3
"""
Generate ML-based Soiling Ratio predictions for visualization.

This script uses the trained foundation model to generate SR predictions
that can be compared against DustIQ (ground truth) and statistical SRR.

Usage:
    python scripts/generate_ml_predictions.py --plant alpha1
"""

import sys
import json
import argparse
from pathlib import Path
from datetime import datetime

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

import numpy as np
import pandas as pd

from nuravolt.soiling.sr_ml_model import SoilingRatioModel
from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation


# Plant configurations
PLANT_CONFIGS = {
    'alpha1': {
        'latitude': 37.5,
        'longitude': -6,
        'model_path': 'models/soiling/sr_foundation_alpha1.pkl',
    }
}


def load_weather_data(plant_id: str) -> pd.DataFrame:
    """Load weather data for a plant."""
    weather_path = project_root / 'public' / 'data' / 'soiling' / plant_id / 'rain_history.json'

    with open(weather_path, 'r') as f:
        weather_data = json.load(f)

    df = pd.DataFrame(weather_data['daily_data'])
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date')

    # Rename columns if needed
    if 'precipitation_mm' not in df.columns and 'precipitation' in df.columns:
        df['precipitation_mm'] = df['precipitation']

    return df


def load_pr_data(plant_id: str) -> pd.DataFrame:
    """Load Performance Ratio data for a plant."""
    pr_path = project_root / 'public' / 'data' / 'soiling' / plant_id / 'time_series' / 'daily_pr.json'

    if not pr_path.exists():
        print(f"Warning: PR data not found at {pr_path}")
        return None

    with open(pr_path, 'r') as f:
        pr_data = json.load(f)

    # Handle nested data structure
    if 'data' in pr_data:
        df_raw = pd.DataFrame(pr_data['data'])
    else:
        df_raw = pd.DataFrame(pr_data)

    df_raw['date'] = pd.to_datetime(df_raw['date'])

    # Aggregate per-inverter PR to plant-level mean (if multiple inverters)
    df = df_raw.groupby('date').agg({'pr': 'mean'}).reset_index()
    df = df.set_index('date')

    return df


def load_cleaning_events(plant_id: str, df_weather: pd.DataFrame) -> pd.DataFrame:
    """Detect cleaning events from weather data for feature engineering."""
    # Rain cleaning detection
    precip = df_weather['precipitation_mm'].fillna(0)
    cleaning_dates = []

    for i in range(len(df_weather)):
        if i < 2:
            continue

        # 3-day rolling rain
        rain_3d = precip.iloc[i-2:i+1].sum()

        if rain_3d >= 5.0:  # Rain cleaning threshold
            cleaning_dates.append(df_weather.index[i])

    df_events = pd.DataFrame({
        'date': cleaning_dates,
        'event_type': 'rain'
    })

    return df_events


def generate_predictions(plant_id: str, output_dir: str = None) -> dict:
    """Generate ML predictions for a plant."""
    print(f"Generating ML predictions for {plant_id}...")

    config = PLANT_CONFIGS.get(plant_id)
    if not config:
        raise ValueError(f"Unknown plant: {plant_id}")

    # Load model
    model_path = project_root / config['model_path']
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    print(f"Loading model from: {model_path}")
    model = SoilingRatioModel.load(model_path)

    # Load weather data
    df_weather = load_weather_data(plant_id)
    print(f"Loaded {len(df_weather)} weather days")

    # Load PR data (Performance Ratio - lagging soiling indicator)
    df_pr = load_pr_data(plant_id)
    if df_pr is not None:
        print(f"Loaded {len(df_pr)} PR data points")
    else:
        print("No PR data available - generating features without PR")

    # Generate features (cleaning events are inferred from rain data)
    location = PlantLocation(latitude=config['latitude'], longitude=config['longitude'])
    feature_engineer = SoilingRatioFeatureEngineer(location)

    # Generate features with PR data for enhanced prediction
    X = feature_engineer.generate_features(df_weather, df_pr=df_pr)
    print(f"Generated {len(X)} feature vectors with {len(X.columns)} features")

    # Generate predictions
    predictions = model.predict(X)
    print(f"Generated {len(predictions)} predictions")

    # Build output data
    daily_data = []
    for i, (date, sr_pred) in enumerate(zip(X.index, predictions)):
        daily_data.append({
            'date': date.strftime('%Y-%m-%d'),
            'sr_ml': float(sr_pred),
        })

    result = {
        'plant_id': plant_id,
        'model_info': {
            'model_path': str(model_path),
            'plant_id': model.metadata.plant_id if model.metadata else 'unknown',
            'validation_mae': model.metadata.validation_mae if model.metadata else None,
            'validation_r2': model.metadata.validation_r2 if model.metadata else None,
        },
        'generated_at': datetime.now().isoformat(),
        'n_predictions': len(daily_data),
        'date_range': {
            'start': daily_data[0]['date'] if daily_data else None,
            'end': daily_data[-1]['date'] if daily_data else None,
        },
        'daily_data': daily_data,
    }

    # Save output
    if output_dir is None:
        output_dir = project_root / 'public' / 'data' / 'soiling' / plant_id
    else:
        output_dir = Path(output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / 'ml_sr_predictions.json'

    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2)

    print(f"\nPredictions saved to: {output_path}")
    print(f"Date range: {result['date_range']['start']} to {result['date_range']['end']}")
    print(f"Total predictions: {result['n_predictions']}")

    return result


def main():
    parser = argparse.ArgumentParser(description='Generate ML-based SR predictions')
    parser.add_argument('--plant', '-p', default='alpha1', help='Plant ID (default: alpha1)')
    parser.add_argument('--output', '-o', help='Output directory (default: public/data/soiling/<plant>)')

    args = parser.parse_args()

    generate_predictions(args.plant, args.output)


if __name__ == '__main__':
    main()
