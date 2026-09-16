#!/usr/bin/env python3
"""
Train Soiling Ratio ML Model on ALPHA1 (Alpha, Spain)

This script trains the foundation SR model using DustIQ sensor data as ground truth.
The trained model can be transferred to other plants without DustIQ sensors.

Usage:
    python scripts/train_sr_model_alpha1.py
"""

import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.sr_ml_training import train_foundation_model

# ALPHA1 Configuration
ALPHA1_CONFIG = {
    'plant_id': 'alpha1',
    'latitude': 37.5,
    'longitude': -6,
}

# Data paths
DATA_DIR = project_root / 'public' / 'data' / 'soiling' / 'alpha1'
DUSTIQ_PATH = DATA_DIR / 'dustiq_history.json'
WEATHER_PATH = DATA_DIR / 'rain_history.json'
AOD_PATH = DATA_DIR / 'aod_history.json'  # May not exist yet
PR_PATH = DATA_DIR / 'time_series' / 'daily_pr.json'  # Performance Ratio data

# Output directory
OUTPUT_DIR = project_root / 'models' / 'soiling'


def main():
    print("=" * 70)
    print("SR Foundation Model Training - ALPHA1 (Alpha, Spain)")
    print("=" * 70)
    print("Enhanced with: PR features (lagging soiling indicator)")
    print("=" * 70)

    # Check data files exist
    if not DUSTIQ_PATH.exists():
        print(f"ERROR: DustIQ data not found at {DUSTIQ_PATH}")
        print("Run scripts/extractDustIQData.py first to extract DustIQ data.")
        sys.exit(1)

    if not WEATHER_PATH.exists():
        print(f"ERROR: Weather data not found at {WEATHER_PATH}")
        print("Run scripts/fetchRainHistory.ts first to fetch weather data.")
        sys.exit(1)

    # Check for AOD data (optional)
    aod_path = str(AOD_PATH) if AOD_PATH.exists() else None
    if aod_path:
        print(f"✓ AOD data found at {AOD_PATH}")
    else:
        print("○ No AOD data found - training without aerosol features")

    # Check for PR data (NEW - lagging soiling indicator)
    pr_path = str(PR_PATH) if PR_PATH.exists() else None
    if pr_path:
        print(f"✓ PR data found at {PR_PATH}")
    else:
        print("○ No PR data found - training without performance ratio features")

    # Train model with enhanced features
    model, report = train_foundation_model(
        plant_id=ALPHA1_CONFIG['plant_id'],
        dustiq_path=str(DUSTIQ_PATH),
        weather_path=str(WEATHER_PATH),
        latitude=ALPHA1_CONFIG['latitude'],
        longitude=ALPHA1_CONFIG['longitude'],
        aod_path=aod_path,
        pr_path=pr_path,  # NEW: Include PR as lagging soiling indicator
        output_dir=str(OUTPUT_DIR)
    )

    # Print summary
    print("\n" + "=" * 70)
    print("TRAINING SUMMARY")
    print("=" * 70)
    print(f"Plant: {report['plant_id']}")
    print(f"Samples: {report['n_samples']}")
    print(f"Features: {report['n_features']}")
    print(f"\nTest Set Performance:")
    print(f"  MAE: {report['metrics']['mae']:.4f} ({report['metrics']['mae']*100:.2f}%)")
    print(f"  RMSE: {report['metrics']['rmse']:.4f}")
    print(f"  R2: {report['metrics']['r2']:.4f}")
    print(f"  Correlation: {report['metrics']['correlation']:.4f}")
    print(f"\nModel saved to: {report['model_path']}")
    print("=" * 70)

    # Copy to standard location
    if report['model_path']:
        standard_path = OUTPUT_DIR / 'sr_foundation_alpha1.pkl'
        import shutil
        shutil.copy(report['model_path'], standard_path)
        print(f"\nCopied to standard location: {standard_path}")


if __name__ == '__main__':
    main()
