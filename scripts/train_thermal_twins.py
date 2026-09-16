#!/usr/bin/env python3
"""
Train Enhanced Thermal Digital Twins with RUL Prediction

CLI entry point for training inverter-level thermal twins with component life prediction.
Uses CatBoost for temperature prediction + Arrhenius/Coffin-Manson physics models for RUL.

Usage:
    # Train by plant ID (loads plant_configs/{plant_id}.yaml)
    python scripts/train_thermal_twins.py --plant-id alpha1

    # Train specific inverters only
    python scripts/train_thermal_twins.py --plant-id alpha1 --inverters INV_01.001 INV_01.002

    # Dry run (validate config and data availability only)
    python scripts/train_thermal_twins.py --plant-id alpha1 --dry-run

    # Verbose output
    python scripts/train_thermal_twins.py --plant-id alpha1 --verbose
"""

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, List
import json

import polars as pl
import numpy as np

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.digitaltwin.plant_config import (
    PlantConfig,
    load_plant_config,
)

from nuravolt.fault.digital_twins import (
    EnhancedThermalTwin,
)

from nuravolt.digitaltwin.thermal_physics import (
    CapacitorConfig,
    IGBTConfig,
    ThermalStressConfig,
)


def setup_logging(verbose: bool = False) -> None:
    """Configure logging."""
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(f"thermal_twin_training_{datetime.now():%Y%m%d_%H%M%S}.log"),
        ],
    )


def validate_thermal_data(config: PlantConfig) -> bool:
    """Validate thermal data availability."""
    logger = logging.getLogger(__name__)

    # Check data file exists
    data_path = Path(config.data.source_path)
    if not data_path.exists():
        print(f"❌ Data file not found: {data_path}")
        return False

    print(f"✅ Data file found: {data_path}")

    # Load schema to check for thermal columns
    try:
        lf = pl.scan_parquet(data_path)
        columns = lf.collect_schema().names()

        # Look for temperature columns
        import re
        temp_pattern = re.compile(r'(temperature|temp|cabinet)', re.IGNORECASE)
        temp_cols = [c for c in columns if temp_pattern.search(c)]

        if not temp_cols:
            print(f"❌ No temperature columns found in data")
            print(f"   Expected patterns: temperature, temp, cabinet")
            return False

        print(f"✅ Found {len(temp_cols)} temperature columns")
        print(f"   Examples: {temp_cols[:5]}")

        return True

    except Exception as e:
        print(f"❌ Error validating data: {e}")
        return False


def train_thermal_twins(
    config: PlantConfig,
    inverter_ids: Optional[List[str]] = None,
    max_inverters: Optional[int] = None,
    rated_ac_power_kw: float = 60.0,
    dry_run: bool = False,
) -> dict:
    """Train thermal twins for a plant."""
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

    # Validate thermal data availability
    if not validate_thermal_data(config):
        return {"success": False, "error": "No thermal data available"}

    if dry_run:
        print("\\n✅ Dry run complete - configuration and data are valid")
        return {"success": True, "dry_run": True}

    # Load data
    print(f"\\n📊 Loading data...")
    data_path = Path(config.data.source_path)

    try:
        df = pl.read_parquet(data_path)
        print(f"   Loaded {len(df):,} rows × {len(df.columns):,} columns")
    except Exception as e:
        print(f"❌ Error loading data: {e}")
        return {"success": False, "error": str(e)}

    # Identify inverter temperature columns
    import re
    temp_pattern = re.compile(r'INV[_\s]+([\d.]+)\s*/.*(?:temperature|temp|cabinet)', re.IGNORECASE)
    temp_cols = {}

    for col in df.columns:
        match = temp_pattern.search(col)
        if match:
            inv_id = f"INV_{match.group(1).replace('.', '_').replace(' ', '_')}"
            temp_cols[inv_id] = col

    if not temp_cols:
        print(f"❌ No inverter temperature columns found")
        return {"success": False, "error": "No temperature data"}

    print(f"\\n✅ Found {len(temp_cols)} inverters with temperature data")

    # Filter to requested inverters
    if inverter_ids:
        # Normalize inverter IDs
        normalized_ids = {inv_id.replace(" ", "_"): inv_id for inv_id in inverter_ids}
        temp_cols = {k: v for k, v in temp_cols.items() if k in normalized_ids}
        print(f"   Filtered to {len(temp_cols)} requested inverters")

    if max_inverters and len(temp_cols) > max_inverters:
        temp_cols = dict(list(temp_cols.items())[:max_inverters])
        print(f"   Limited to {max_inverters} inverters")

    # Configure output
    output_dir = Path(config.output_dir) / "thermal"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Component life configs
    cap_config = CapacitorConfig()
    igbt_config = IGBTConfig()
    stress_config = ThermalStressConfig()

    # Train twins
    print(f"\\n🚀 Starting thermal twin training...")
    print(f"   Output directory: {output_dir}")

    results = {}
    successful = 0
    failed = 0

    for inv_id, temp_col in temp_cols.items():
        print(f"\\n   Training {inv_id}...")

        try:
            # Create twin
            twin = EnhancedThermalTwin(
                inverter_id=inv_id,
                rated_ac_power_kw=rated_ac_power_kw,
                capacitor_config=cap_config,
                igbt_config=igbt_config,
                thermal_stress_config=stress_config,
            )

            # Prepare training data
            train_df = df.select([
                "timestamp",
                temp_col,
                # Look for power and irradiance columns
            ])

            # Find ambient temperature column
            ambient_pattern = re.compile(r'(?:ambient|meteo).*(?:temp|temperature)', re.IGNORECASE)
            ambient_cols = [c for c in df.columns if ambient_pattern.search(c)]
            if ambient_cols:
                train_df = df.with_columns(pl.col(ambient_cols[0]).alias("ambient_temp"))

            # Find irradiance column
            irrad_pattern = re.compile(r'irrad|poa|ghi', re.IGNORECASE)
            irrad_cols = [c for c in df.columns if irrad_pattern.search(c)]
            if irrad_cols:
                train_df = df.with_columns(pl.col(irrad_cols[0]).alias("poa_irradiance"))

            # Find AC power column for this inverter
            power_pattern = re.compile(rf'INV[_\s]+{inv_id.replace("INV_", "")}.*(?:power|ac|kw)', re.IGNORECASE)
            power_cols = [c for c in df.columns if power_pattern.search(c)]
            if power_cols:
                train_df = df.with_columns(pl.col(power_cols[0]).alias("ac_power"))

            # Rename temperature column
            train_df = train_df.rename({temp_col: "inverter_temperature"})

            # Train model
            metrics = twin.train(train_df, verbose=False)

            print(f"      ✅ R²={metrics.r2:.3f}, MAE={metrics.mae:.2f}°C")

            # Save model
            model_path = output_dir / f"thermal_{inv_id}.pkl"
            twin.save_enhanced(model_path)

            results[inv_id] = {
                "success": True,
                "r2": metrics.r2,
                "mae": metrics.mae,
                "rmse": metrics.rmse,
                "model_path": str(model_path),
            }

            successful += 1

        except Exception as e:
            logger.error(f"Failed to train {inv_id}: {e}", exc_info=True)
            print(f"      ❌ Failed: {e}")
            failed += 1
            results[inv_id] = {
                "success": False,
                "error": str(e),
            }

    # Export summary
    summary_path = output_dir / "thermal_twins_summary.json"
    summary = {
        "plant_id": config.plant_id,
        "plant_name": config.plant_name,
        "timestamp": datetime.now().isoformat(),
        "total_inverters": len(temp_cols),
        "successful": successful,
        "failed": failed,
        "success_rate": successful / len(temp_cols) if temp_cols else 0,
        "results": results,
    }

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    # Print summary
    print()
    print("=" * 70)
    print("TRAINING RESULTS")
    print("=" * 70)
    print(f"✅ Training complete!")
    print(f"   Total inverters: {len(temp_cols)}")
    print(f"   Successful: {successful}")
    print(f"   Failed: {failed}")
    print(f"   Success rate: {successful / len(temp_cols) * 100:.1f}%")

    if successful > 0:
        avg_r2 = np.mean([r["r2"] for r in results.values() if r.get("success")])
        avg_mae = np.mean([r["mae"] for r in results.values() if r.get("success")])
        print()
        print(f"   Average R²: {avg_r2:.4f}")
        print(f"   Average MAE: {avg_mae:.2f}°C")

    print()
    print(f"   Output directory: {output_dir}")
    print()
    print("📦 Generated files:")
    print(f"   - Models: {output_dir}/thermal_*.pkl")
    print(f"   - Summary: {summary_path}")
    print("=" * 70)

    return {
        "success": True,
        "stats": summary,
        "output_dir": str(output_dir),
    }


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Train enhanced thermal digital twin models for RUL prediction",
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
        "--max-inverters",
        type=int,
        help="Maximum number of inverters to train (for testing)",
    )

    parser.add_argument(
        "--rated-power",
        type=float,
        default=60.0,
        help="Rated AC power per inverter in kW (default: 60.0)",
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
        print(f"\\nAvailable plants:")
        config_path = Path(args.config_dir)
        if config_path.exists():
            for yaml_file in sorted(config_path.glob("*.yaml")):
                if yaml_file.stem != "_template":
                    print(f"   - {yaml_file.stem}")
        return 1

    # Train thermal twins
    result = train_thermal_twins(
        config=config,
        inverter_ids=args.inverters,
        max_inverters=args.max_inverters,
        rated_ac_power_kw=args.rated_power,
        dry_run=args.dry_run,
    )

    if result["success"]:
        return 0
    else:
        print(f"\\n❌ Training failed: {result.get('error', 'Unknown error')}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
