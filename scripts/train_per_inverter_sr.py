#!/usr/bin/env python3
"""
Train Per-Inverter Soiling Ratio Models

CLI script to train per-inverter SR models for solar plants.

Usage:
    # Train WITH DustIQ (uses sensor data as target)
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant dustiq

    # Train WITHOUT DustIQ (uses pseudo-labels from rain+PR)
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant pseudo

    # Train both variants
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant both

Author: NuraVolt Team
"""

import argparse
import sys
import logging
from pathlib import Path
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_per_inverter_training import (
    PerInverterSRTrainer,
    TrainingDataPaths,
    TrainingResult
)
from nuravolt.soiling.sr_ml_model import PerInverterModelConfig

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(f"per_inverter_training_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
    ]
)
logger = logging.getLogger(__name__)


def get_data_paths(plant_id: str, data_dir: Path, variant: str) -> TrainingDataPaths:
    """
    Build data paths for a plant.

    Assumes standard NuraVolt data directory structure:
    - public/data/soiling/{plant_id}/
        - rain_history.csv
        - aod_history.csv
        - pr_daily.parquet
        - per_inverter/all_inverters.json
        - dustiq.csv (if available)
    """
    plant_data_dir = data_dir / plant_id

    # Check for various naming conventions
    rain_path = None
    for name in ['rain_history.csv', f'{plant_id}_rain_history.csv', 'rain.csv']:
        candidate = plant_data_dir / name
        if candidate.exists():
            rain_path = candidate
            break
    if rain_path is None:
        rain_path = plant_data_dir / 'rain_history.csv'  # Default

    aod_path = None
    for name in ['aod_history.csv', f'{plant_id}_aod_history.csv', 'aod.csv']:
        candidate = plant_data_dir / name
        if candidate.exists():
            aod_path = candidate
            break

    pr_path = None
    for name in ['pr_daily.parquet', f'{plant_id}_pr_daily.parquet', 'pr.parquet']:
        candidate = plant_data_dir / name
        if candidate.exists():
            pr_path = candidate
            break
    if pr_path is None:
        pr_path = plant_data_dir / 'pr_daily.parquet'  # Default

    inverter_json = plant_data_dir / 'per_inverter' / 'all_inverters.json'

    dustiq_path = None
    if variant in ['dustiq', 'both']:
        for name in ['dustiq_history.csv', 'dustiq_history.json', 'dustiq.csv',
                     f'{plant_id}_dustiq.csv', 'soiling_ratio.csv']:
            candidate = plant_data_dir / name
            if candidate.exists():
                dustiq_path = candidate
                break

    return TrainingDataPaths(
        rain_csv=rain_path,
        aod_csv=aod_path,
        pr_parquet=pr_path,
        inverter_json=inverter_json,
        dustiq_csv=dustiq_path
    )


def validate_data_paths(paths: TrainingDataPaths, variant: str) -> bool:
    """Validate that required data files exist."""
    errors = []

    if not paths.rain_csv.exists():
        errors.append(f"Rain data not found: {paths.rain_csv}")

    if not paths.pr_parquet.exists():
        errors.append(f"PR data not found: {paths.pr_parquet}")

    if not paths.inverter_json.exists():
        errors.append(f"Inverter metadata not found: {paths.inverter_json}")

    if variant == 'dustiq' and (paths.dustiq_csv is None or not paths.dustiq_csv.exists()):
        errors.append(f"DustIQ data required for 'dustiq' variant but not found")

    if errors:
        for error in errors:
            logger.error(error)
        return False

    return True


def train_variant(
    plant_id: str,
    variant: str,
    data_paths: TrainingDataPaths,
    output_dir: Path,
    config: PerInverterModelConfig
) -> TrainingResult:
    """Train a single model variant."""
    logger.info(f"Training {variant.upper()} variant for {plant_id}")

    trainer = PerInverterSRTrainer(
        plant_id=plant_id,
        data_paths=data_paths,
        output_dir=output_dir,
        config=config
    )

    result = trainer.train(variant=variant, verbose=True)

    # Log results
    logger.info(f"Training complete for {variant}:")
    logger.info(f"  MAE: {result.metrics['mae']:.4f}")
    logger.info(f"  RMSE: {result.metrics['rmse']:.4f}")
    logger.info(f"  R²: {result.metrics['r2']:.4f}")
    logger.info(f"  Duration: {result.training_duration_seconds:.1f}s")
    logger.info(f"  Model saved: {result.output_path}")

    return result


def main():
    parser = argparse.ArgumentParser(
        description='Train Per-Inverter Soiling Ratio Models',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Train pseudo-label model (no DustIQ required)
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant pseudo

    # Train DustIQ-based model
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant dustiq

    # Train both variants
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant both

    # Custom output directory
    python scripts/train_per_inverter_sr.py --plant alpha1 --variant pseudo --output-dir ./models
        """
    )

    parser.add_argument(
        '--plant',
        type=str,
        required=True,
        help='Plant identifier (e.g., alpha1)'
    )

    parser.add_argument(
        '--variant',
        type=str,
        choices=['dustiq', 'pseudo', 'both'],
        default='pseudo',
        help='Model variant to train (default: pseudo)'
    )

    parser.add_argument(
        '--data-dir',
        type=str,
        default='public/data/soiling',
        help='Data directory (default: public/data/soiling)'
    )

    parser.add_argument(
        '--output-dir',
        type=str,
        default='public/data/soiling',
        help='Output directory for models (default: public/data/soiling)'
    )

    parser.add_argument(
        '--iterations',
        type=int,
        default=2000,
        help='Training iterations (default: 2000)'
    )

    parser.add_argument(
        '--learning-rate',
        type=float,
        default=0.02,
        help='Learning rate (default: 0.02)'
    )

    parser.add_argument(
        '--test-size',
        type=float,
        default=0.2,
        help='Test set size (default: 0.2)'
    )

    args = parser.parse_args()

    # Setup paths
    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir) / args.plant / 'models'
    output_dir.mkdir(parents=True, exist_ok=True)

    # Configure model
    from nuravolt.soiling.sr_ml_model import SoilingRatioModelConfig

    base_config = SoilingRatioModelConfig(
        iterations=args.iterations,
        learning_rate=args.learning_rate
    )

    config = PerInverterModelConfig(base_config=base_config)

    # Get data paths
    data_paths = get_data_paths(args.plant, data_dir, args.variant)

    # Print configuration
    print(f"\n{'='*60}")
    print("Per-Inverter SR Model Training")
    print(f"{'='*60}")
    print(f"Plant: {args.plant}")
    print(f"Variant: {args.variant}")
    print(f"Data directory: {data_dir}")
    print(f"Output directory: {output_dir}")
    print(f"Iterations: {args.iterations}")
    print(f"Learning rate: {args.learning_rate}")
    print(f"{'='*60}\n")

    # Determine which variants to train
    variants_to_train = []
    if args.variant == 'both':
        variants_to_train = ['pseudo', 'dustiq']
    else:
        variants_to_train = [args.variant]

    results = {}

    for variant in variants_to_train:
        # Update data paths for variant
        variant_paths = get_data_paths(args.plant, data_dir, variant)

        # Validate paths
        if not validate_data_paths(variant_paths, variant):
            if variant == 'dustiq' and args.variant == 'both':
                logger.warning(f"Skipping {variant} variant due to missing data")
                continue
            else:
                logger.error(f"Cannot train {variant} variant - missing required data")
                sys.exit(1)

        # Train
        try:
            result = train_variant(
                plant_id=args.plant,
                variant=variant,
                data_paths=variant_paths,
                output_dir=output_dir,
                config=config
            )
            results[variant] = result
        except Exception as e:
            logger.error(f"Training failed for {variant}: {e}")
            if args.variant != 'both':
                sys.exit(1)

    # Summary
    print(f"\n{'='*60}")
    print("Training Summary")
    print(f"{'='*60}")

    for variant, result in results.items():
        print(f"\n{variant.upper()} Model:")
        print(f"  MAE:  {result.metrics['mae']:.4f}")
        print(f"  RMSE: {result.metrics['rmse']:.4f}")
        print(f"  R²:   {result.metrics['r2']:.4f}")
        print(f"  Path: {result.output_path}")

    print(f"\n{'='*60}")
    print("Training complete!")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()
