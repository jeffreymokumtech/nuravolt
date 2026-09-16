#!/usr/bin/env python3
"""
Train Soiling Ratio Foundation Model using DustIQ sensor data as ground truth.

The trained model can be transferred to other plants without DustIQ sensors.

Usage:
    python scripts/train_sr_foundation_model.py --plant alpha1
    python scripts/train_sr_foundation_model.py --plant eta
    python scripts/train_sr_foundation_model.py --plant ribera --config plant_configs/ribera.yaml
"""

import argparse
import shutil
import sys
from pathlib import Path

import yaml

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.sr_ml_training import train_foundation_model


def load_plant_config(plant_id: str, config_path: str = None) -> dict:
    """Load plant configuration from YAML file."""
    if config_path:
        config_file = Path(config_path)
    else:
        config_file = project_root / 'plant_configs' / f'{plant_id}.yaml'

    if not config_file.exists():
        raise FileNotFoundError(f"Plant config not found: {config_file}")

    with open(config_file) as f:
        return yaml.safe_load(f)


def train_plant_sr_foundation(plant_id: str, config_path: str = None):
    """Train foundation SR model for specified plant.

    Args:
        plant_id: Plant identifier (e.g., 'alpha1', 'eta', 'ribera')
        config_path: Optional path to plant config YAML
    """
    print("=" * 70)
    print(f"SR Foundation Model Training - {plant_id.upper()}")
    print("=" * 70)

    # Load plant config
    print(f"\nLoading plant configuration for {plant_id}...")
    config = load_plant_config(plant_id, config_path)

    # Get location from config
    latitude = config['location']['latitude']
    longitude = config['location']['longitude']
    plant_name = config.get('name', plant_id)

    print(f"Plant: {plant_name}")
    print(f"Location: ({latitude}, {longitude})")

    # Data paths
    data_dir = project_root / 'public' / 'data' / 'soiling' / plant_id
    dustiq_path = data_dir / 'dustiq_history.json'
    weather_path = data_dir / 'rain_history.json'
    aod_path = data_dir / 'aod_history.json'
    pr_path = data_dir / 'time_series' / 'daily_pr.json'

    # Output directory
    output_dir = project_root / 'models' / 'soiling'

    # Check DustIQ data exists (required for foundation model)
    if not dustiq_path.exists():
        print(f"\n❌ ERROR: DustIQ data not found at {dustiq_path}")
        print("Foundation model requires DustIQ sensor data as ground truth.")
        print("Run scripts/extract_dustiq_history.py first to extract DustIQ data.")
        sys.exit(1)

    print(f"✅ DustIQ data found: {dustiq_path}")

    # Check weather data exists (required)
    if not weather_path.exists():
        print(f"\n❌ ERROR: Weather data not found at {weather_path}")
        print("Run scripts/fetch_rain_history.py first to fetch weather data.")
        sys.exit(1)

    print(f"✅ Weather data found: {weather_path}")

    # Check for optional data sources
    aod_path_str = str(aod_path) if aod_path.exists() else None
    if aod_path_str:
        print(f"✅ AOD data found: {aod_path}")
    else:
        print("⚠️  No AOD data found - training without aerosol features")

    pr_path_str = str(pr_path) if pr_path.exists() else None
    if pr_path_str:
        print(f"✅ PR data found: {pr_path}")
    else:
        print("⚠️  No PR data found - training without performance ratio features")

    # Train model with enhanced features
    print("\n" + "=" * 70)
    print("TRAINING MODEL")
    print("=" * 70)

    model, report = train_foundation_model(
        plant_id=plant_id,
        dustiq_path=str(dustiq_path),
        weather_path=str(weather_path),
        latitude=latitude,
        longitude=longitude,
        aod_path=aod_path_str,
        pr_path=pr_path_str,
        output_dir=str(output_dir)
    )

    # Print summary
    print("\n" + "=" * 70)
    print("TRAINING SUMMARY")
    print("=" * 70)
    print(f"Plant: {report['plant_id']}")
    print(f"Samples: {report['n_samples']:,}")
    print(f"Features: {report['n_features']}")
    print(f"\nTest Set Performance:")
    print(f"  MAE: {report['metrics']['mae']:.4f} ({report['metrics']['mae']*100:.2f}%)")
    print(f"  RMSE: {report['metrics']['rmse']:.4f}")
    print(f"  R²: {report['metrics']['r2']:.4f}")
    print(f"  Correlation: {report['metrics']['correlation']:.4f}")

    # Copy to standard location
    if report['model_path']:
        standard_path = output_dir / f'sr_foundation_{plant_id}.pkl'
        shutil.copy(report['model_path'], standard_path)
        print(f"\n✅ Model saved to: {standard_path}")

    print("=" * 70)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Train Soiling Ratio Foundation Model using DustIQ ground truth',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Train foundation model for ALPHA1
  python scripts/train_sr_foundation_model.py --plant alpha1

  # Train foundation model for Eta
  python scripts/train_sr_foundation_model.py --plant eta

  # Use custom config file
  python scripts/train_sr_foundation_model.py --plant ribera --config custom_config.yaml

Note:
  - Requires DustIQ sensor data (ground truth for soiling ratio)
  - Requires weather data (rain history)
  - Optional: AOD data, PR data for additional features
        """
    )

    parser.add_argument('--plant', required=True,
                       help='Plant identifier (e.g., alpha1, eta, ribera)')
    parser.add_argument('--config', type=str,
                       help='Optional path to plant config YAML file')

    args = parser.parse_args()

    try:
        train_plant_sr_foundation(args.plant, args.config)
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
