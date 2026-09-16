#!/usr/bin/env python3
"""
Train String-Level Digital Twin Models

CLI entry point for training string-level digital twins for mismatch detection.
Uses CatBoost models per string with physics baseline.

Usage:
    # Train by plant ID (loads plant_configs/{plant_id}.yaml)
    python scripts/train_string_twins.py --plant-id alpha1

    # Train specific inverters only
    python scripts/train_string_twins.py --plant-id alpha1 --inverters INV_01.001 INV_01.002

    # Limit number of strings for testing
    python scripts/train_string_twins.py --plant-id alpha1 --max-strings 50

    # Dry run (validate config and data availability only)
    python scripts/train_string_twins.py --plant-id alpha1 --dry-run

    # Verbose output
    python scripts/train_string_twins.py --plant-id alpha1 --verbose
"""

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List

import polars as pl

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.digitaltwin.plant_config import (
    PlantConfig,
    load_plant_config,
)
from nuravolt.digitaltwin.string_factory import (
    StringTwinFactory,
    StringFactoryConfig,
)


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(f"string_twin_training_{datetime.now():%Y%m%d_%H%M%S}.log"),
        ],
    )


def validate_string_data(config: PlantConfig) -> bool:
    """Validate string-level data availability."""
    logger = logging.getLogger(__name__)

    # Check data file exists
    data_path = Path(config.data.source_path)
    if not data_path.exists():
        print(f"❌ Data file not found: {data_path}")
        return False

    print(f"✅ Data file found: {data_path}")

    # Load schema to check for string columns
    try:
        lf = pl.scan_parquet(data_path)
        columns = lf.collect_schema().names()

        # Count string current columns
        import re
        current_pattern = re.compile(r'INV\s+[\d.]+\s*/\s*Input_current_(\d+)\s*\(A\)')
        string_cols = [c for c in columns if current_pattern.search(c)]

        if not string_cols:
            print(f"❌ No string current columns found in data")
            print(f"   Expected pattern: 'INV XX.XXX / Input_current_NN (A)'")
            return False

        # Group by inverter
        inv_strings = {}
        for col in string_cols:
            match = current_pattern.search(col)
            if match:
                inv_id = col.split("/")[0].strip().split()[-1]
                if inv_id not in inv_strings:
                    inv_strings[inv_id] = []
                inv_strings[inv_id].append(int(match.group(1)))

        print(f"✅ Found {len(string_cols)} string current columns")
        print(f"   Inverters with strings: {len(inv_strings)}")
        print(f"   Strings per inverter: {min(len(s) for s in inv_strings.values())}-{max(len(s) for s in inv_strings.values())}")

        return True

    except Exception as e:
        print(f"❌ Error validating data: {e}")
        return False


def estimate_string_params(config: PlantConfig) -> tuple[Optional[int], Optional[float]]:
    """
    Estimate string hardware parameters from plant config.

    Returns:
        (num_modules, module_imp) or (None, None) if not determinable
    """
    logger = logging.getLogger(__name__)

    # Try to infer from capacity and inverter count
    if config.capacity.nominal_mw and config.components.total_inverters:
        # Typical string configuration for utility-scale
        # Rough estimates - can be overridden with command-line args
        num_modules = 20  # Typical for 1500V systems
        module_power_w = 400  # Typical module power

        # Estimate module current at MPP
        # I_mp ≈ P_mp / V_mp, assuming V_mp ≈ 40V for typical c-Si
        module_imp = module_power_w / 40.0  # ≈ 10A

        logger.info(f"Estimated string parameters: {num_modules} modules, {module_imp:.1f}A per module")
        return num_modules, module_imp

    return None, None


def train_string_twins(
    config: PlantConfig,
    inverter_ids: Optional[List[str]] = None,
    max_strings: Optional[int] = None,
    num_modules: Optional[int] = None,
    module_imp: Optional[float] = None,
    max_workers: int = 4,
    dry_run: bool = False,
) -> dict:
    """Train string twins for a plant."""
    logger = logging.getLogger(__name__)

    print()
    print("=" * 70)
    print(f"Plant: {config.plant_name} ({config.plant_id})")
    print("=" * 70)

    # Validate config
    errors = config.validate()
    if errors:
        print(f"❌ Configuration errors:")
        for error in errors:
            print(f"   - {error}")
        return {"success": False, "error": "Invalid configuration"}

    print(f"✅ Configuration valid")
    print(f"   Plant: {config.plant_name}")
    print(f"   Location: {config.location.latitude:.4f}N, {config.location.longitude:.4f}E")
    print(f"   Capacity: {config.capacity.nominal_mw} MW")
    print(f"   Inverters: {config.components.total_inverters}")

    # Validate string data availability
    if not validate_string_data(config):
        return {"success": False, "error": "No string-level data available"}

    if dry_run:
        print("\n✅ Dry run complete - configuration and data are valid")
        return {"success": True, "dry_run": True}

    # Estimate string parameters if not provided
    if num_modules is None or module_imp is None:
        est_modules, est_imp = estimate_string_params(config)
        num_modules = num_modules or est_modules
        module_imp = module_imp or est_imp

        if num_modules and module_imp:
            print(f"\n📐 String parameters (estimated):")
            print(f"   Modules per string: {num_modules}")
            print(f"   Module current (STC): {module_imp:.1f} A")
        else:
            print(f"\n⚠️  String parameters not provided - using ML-only (no physics baseline)")

    # Load data
    print(f"\n📊 Loading data...")
    data_path = Path(config.data.source_path)

    try:
        df = pl.read_parquet(data_path)
        print(f"   Loaded {len(df):,} rows × {len(df.columns):,} columns")
    except Exception as e:
        print(f"❌ Error loading data: {e}")
        return {"success": False, "error": str(e)}

    # Configure factory
    output_dir = Path(config.output_dir) / "strings"

    factory_config = StringFactoryConfig(
        num_modules=num_modules,
        module_imp=module_imp,
        max_years=config.training.max_years,
        min_training_samples=config.training.min_training_samples,
        validation_split=0.2,
        use_physics_baseline=(num_modules is not None and module_imp is not None),
        max_workers=max_workers,
        batch_size=30,
        # Phase 1.7 tuned thresholds for string-level noise
        min_r2=0.40,  # Optimized for string data (0.60→0.45→0.40)
        max_mae_a=1.2,  # Increased from 1.0
        min_data_completeness=0.70,  # Minimum 70% valid data
        min_high_irradiance_samples=500,  # Min samples at >700 W/m²
        save_models=True,
        save_residuals=True,  # Export Parquet (not CSV)
        save_json=True,
        verbose=True,
    )

    factory = StringTwinFactory(
        config=factory_config,
        output_dir=str(output_dir),
    )

    # Train twins
    print(f"\n🚀 Starting string twin training...")
    print(f"   Output directory: {output_dir}")
    if inverter_ids:
        print(f"   Inverters: {', '.join(inverter_ids)}")
    if max_strings:
        print(f"   Max strings: {max_strings}")

    try:
        results = factory.create_all_twins(
            df=df,
            inverter_ids=inverter_ids,
            string_limit=max_strings,
        )

        # Print summary
        print()
        print("=" * 70)
        print("TRAINING RESULTS")
        print("=" * 70)
        print(f"✅ Training complete!")
        print(f"   Total strings: {factory.stats['total_strings']}")
        print(f"   Successful: {factory.stats['successful']}")
        print(f"   Failed: {factory.stats['failed']}")
        print(f"   Skipped: {factory.stats['skipped']}")
        print(f"   Success rate: {factory.stats['successful'] / factory.stats['total_strings'] * 100:.1f}%")

        if factory.stats.get("avg_r2"):
            print()
            print(f"   Average R²: {factory.stats['avg_r2']:.4f}")
            print(f"   Average MAE: {factory.stats['avg_mae']:.3f} A")

        print()
        print(f"   Total time: {factory.stats.get('total_time_s', 0):.1f}s")
        print(f"   Output directory: {output_dir}")
        print()
        print("📦 Generated files:")
        print(f"   - Models: {output_dir}/models/")
        print(f"   - Residuals: {output_dir}/residuals/")
        print(f"   - Summary: {output_dir}/string_twins_summary.json")
        print("=" * 70)

        return {
            "success": True,
            "stats": factory.stats,
            "output_dir": str(output_dir),
        }

    except Exception as e:
        logger.error(f"Training failed: {e}", exc_info=True)
        print(f"\n❌ Training failed: {e}")
        return {"success": False, "error": str(e)}


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Train string-level digital twin models for fault detection",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    parser.add_argument(
        "--plant-id",
        required=True,
        help="Plant ID (e.g., alpha1, ribera, eta)",
    )

    parser.add_argument(
        "--config-dir",
        default="plant_configs",
        help="Directory containing plant config YAML files",
    )

    parser.add_argument(
        "--inverters",
        nargs="+",
        help="Specific inverter IDs to train (e.g., INV_01.001 INV_01.002)",
    )

    parser.add_argument(
        "--max-strings",
        type=int,
        help="Maximum number of strings to train (for testing)",
    )

    parser.add_argument(
        "--num-modules",
        type=int,
        help="Number of modules per string (default: auto-estimate)",
    )

    parser.add_argument(
        "--module-imp",
        type=float,
        help="Module current at MPP in A (default: auto-estimate)",
    )

    parser.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Maximum parallel workers (default: 4)",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration and data availability only",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    # Setup logging
    setup_logging(verbose=args.verbose)

    # Load plant config
    try:
        config = load_plant_config(args.plant_id, args.config_dir)
    except FileNotFoundError:
        print(f"❌ Plant config not found: {args.plant_id}")
        print(f"   Config directory: {args.config_dir}")
        print(f"\nAvailable plants:")
        config_path = Path(args.config_dir)
        if config_path.exists():
            for yaml_file in sorted(config_path.glob("*.yaml")):
                if yaml_file.stem != "_template":
                    print(f"   - {yaml_file.stem}")
        return 1

    # Train string twins
    result = train_string_twins(
        config=config,
        inverter_ids=args.inverters,
        max_strings=args.max_strings,
        num_modules=args.num_modules,
        module_imp=args.module_imp,
        max_workers=args.max_workers,
        dry_run=args.dry_run,
    )

    if result["success"]:
        return 0
    else:
        print(f"\n❌ Training failed: {result.get('error', 'Unknown error')}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
