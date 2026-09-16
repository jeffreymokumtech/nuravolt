#!/usr/bin/env python3
"""
Train Plant-Level Digital Twin Model

CLI entry point for training hybrid (Physics + ML) digital twin models
for solar PV plants. Uses a single CatBoost model per plant with
inverter_id as a categorical feature.

Usage:
    # Train by plant ID (loads plant_configs/{plant_id}.yaml)
    python scripts/train_plant_model.py --plant-id alpha1

    # Train by config path
    python scripts/train_plant_model.py --config-path plant_configs/alpha1.yaml

    # Train all available plants
    python scripts/train_plant_model.py --all

    # Dry run (validate config only)
    python scripts/train_plant_model.py --plant-id alpha1 --dry-run

    # Verbose output
    python scripts/train_plant_model.py --plant-id alpha1 --verbose
"""

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.digitaltwin.plant_config import (
    PlantConfig,
    list_available_plants,
    load_plant_config,
)
from nuravolt.digitaltwin.plant_factory import PlantLevelFactory, PlantTrainingResult


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(f"plant_training_{datetime.now():%Y%m%d_%H%M%S}.log"),
        ],
    )


def validate_config(config: PlantConfig) -> bool:
    """Validate plant configuration."""
    errors = config.validate()
    if errors:
        print(f"Configuration errors for {config.plant_id}:")
        for error in errors:
            print(f"  - {error}")
        return False

    # Check data file exists
    data_path = Path(config.data.source_path)
    if not data_path.exists():
        print(f"Data file not found: {data_path}")
        return False

    print(f"Configuration valid for {config.plant_id}")
    print(f"  Plant name: {config.plant_name}")
    print(f"  Location: {config.location.latitude:.4f}N, {config.location.longitude:.4f}E")
    print(f"  Capacity: {config.capacity.nominal_mw} MW")
    print(f"  Inverters: {config.components.total_inverters}")
    print(f"  Data source: {config.data.source_path}")
    return True


def train_single_plant(
    config: PlantConfig,
    dry_run: bool = False,
) -> Optional[PlantTrainingResult]:
    """Train model for a single plant."""
    logger = logging.getLogger(__name__)

    print()
    print("=" * 70)
    print(f"Plant: {config.plant_name} ({config.plant_id})")
    print("=" * 70)

    # Validate config
    if not validate_config(config):
        return None

    if dry_run:
        print("Dry run - skipping training")
        return None

    # Train model
    print()
    print("Starting training...")
    factory = PlantLevelFactory(config)
    result = factory.train()

    # Print results
    print()
    if result.success:
        print("Training successful!")
        print(f"  Plant R²: {result.plant_r2:.4f}")
        print(f"  Plant MAE: {result.plant_mae_kw:.4f} kW/kWp")
        print(f"  Physics-only R²: {result.physics_only_r2:.4f}")
        print(f"  ML improvement: +{(result.plant_r2 - result.physics_only_r2):.4f} R²")
        print()
        print(f"  Inverters: {result.n_inverters}")
        print(f"  Avg R² (per-inverter): {result.avg_r2:.4f}")
        print(f"  Avg MAE (per-inverter): {result.avg_mae_kw:.4f} kW/kWp")
        print()
        print(f"  Training samples: {result.n_training_samples:,}")
        print(f"  Validation samples: {result.n_validation_samples:,}")
        print(f"  Training time: {result.training_time_s:.1f}s")
        print()
        print(f"  Output directory: {config.output_dir}")
    else:
        print(f"Training failed: {result.error_message}")

    return result


def train_all_plants(
    config_dir: str | Path = "plant_configs",
    dry_run: bool = False,
) -> list[PlantTrainingResult]:
    """Train models for all available plants."""
    plant_ids = list_available_plants(config_dir)

    if not plant_ids:
        print(f"No plant configurations found in {config_dir}")
        return []

    print(f"Found {len(plant_ids)} plant(s): {', '.join(plant_ids)}")

    results = []
    for plant_id in plant_ids:
        try:
            config = load_plant_config(plant_id, config_dir)
            result = train_single_plant(config, dry_run=dry_run)
            if result:
                results.append(result)
        except Exception as e:
            print(f"Error loading config for {plant_id}: {e}")

    return results


def print_summary(results: list[PlantTrainingResult]) -> None:
    """Print summary of all training results."""
    if not results:
        return

    print()
    print("=" * 70)
    print("TRAINING SUMMARY")
    print("=" * 70)

    successful = [r for r in results if r.success]
    failed = [r for r in results if not r.success]

    print(f"Total plants: {len(results)}")
    print(f"Successful: {len(successful)}")
    print(f"Failed: {len(failed)}")

    if successful:
        print()
        print("Successful plants:")
        for r in successful:
            print(f"  {r.plant_id}: R²={r.plant_r2:.4f}, MAE={r.plant_mae_kw:.4f}, "
                  f"inverters={r.n_inverters}, time={r.training_time_s:.1f}s")

    if failed:
        print()
        print("Failed plants:")
        for r in failed:
            print(f"  {r.plant_id}: {r.error_message}")


def main():
    parser = argparse.ArgumentParser(
        description="Train plant-level hybrid digital twin models",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # Plant selection (mutually exclusive)
    plant_group = parser.add_mutually_exclusive_group(required=True)
    plant_group.add_argument(
        "--plant-id",
        help="Plant identifier (loads plant_configs/{plant_id}.yaml)",
    )
    plant_group.add_argument(
        "--config-path",
        help="Direct path to plant config YAML file",
    )
    plant_group.add_argument(
        "--all",
        action="store_true",
        help="Train all available plants",
    )
    plant_group.add_argument(
        "--list",
        action="store_true",
        help="List available plant configurations",
    )

    # Options
    parser.add_argument(
        "--config-dir",
        default="plant_configs",
        help="Directory containing plant config files (default: plant_configs)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration only, don't train",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose output",
    )

    args = parser.parse_args()

    # Setup logging
    setup_logging(args.verbose)

    print()
    print("=" * 70)
    print("Plant-Level Digital Twin Training")
    print("Model: Physics (PVWatts) + ML (CatBoost) with inverter_id categorical")
    print("=" * 70)

    # Handle --list
    if args.list:
        plant_ids = list_available_plants(args.config_dir)
        if plant_ids:
            print(f"\nAvailable plants in {args.config_dir}:")
            for plant_id in plant_ids:
                try:
                    config = load_plant_config(plant_id, args.config_dir)
                    print(f"  - {plant_id}: {config.plant_name} "
                          f"({config.capacity.nominal_mw} MW, "
                          f"{config.components.total_inverters} inverters)")
                except Exception as e:
                    print(f"  - {plant_id}: Error loading config - {e}")
        else:
            print(f"\nNo plant configurations found in {args.config_dir}")
        return 0

    # Handle --all
    if args.all:
        results = train_all_plants(args.config_dir, dry_run=args.dry_run)
        print_summary(results)
        return 0 if all(r.success for r in results) else 1

    # Handle --plant-id or --config-path
    try:
        if args.config_path:
            config = PlantConfig.from_yaml(args.config_path)
        else:
            config = load_plant_config(args.plant_id, args.config_dir)

        result = train_single_plant(config, dry_run=args.dry_run)

        if args.dry_run:
            return 0
        return 0 if result and result.success else 1

    except FileNotFoundError as e:
        print(f"Error: {e}")
        return 1
    except Exception as e:
        print(f"Error: {e}")
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
