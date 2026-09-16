#!/usr/bin/env python3
"""
Convert residuals CSV files to Parquet format for dashboard aggregator.

The dashboard aggregator expects Parquet files but the plant factory
exports CSVs. This script converts them to Parquet format.
"""

import sys
from pathlib import Path

import polars as pl

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))


def convert_plant_residuals(plant_id: str):
    """Convert all residuals CSV files to Parquet for a single plant."""
    data_dir = project_root / "public" / "data" / "digitaltwin" / plant_id

    if not data_dir.exists():
        print(f"⚠️  Data directory not found: {data_dir}")
        return False

    # Find all CSV residuals files
    csv_files = sorted(data_dir.glob("residuals_INV_*.csv"))

    if len(csv_files) == 0:
        print(f"⚠️  No residuals CSV files found in {data_dir}")
        return False

    print(f"\n🔧 Converting {plant_id.upper()}...")
    print(f"   Found {len(csv_files)} CSV files")

    converted = 0
    errors = 0

    for csv_file in csv_files:
        try:
            # Read CSV with Polars (don't auto-parse dates - keep as strings)
            df = pl.read_csv(
                csv_file,
                try_parse_dates=False,
            )

            # Write to Parquet (same name, different extension)
            parquet_file = csv_file.with_suffix(".parquet")
            df.write_parquet(parquet_file, compression="zstd")

            converted += 1

            if converted % 10 == 0:
                print(f"   Converted {converted}/{len(csv_files)} files...")

        except Exception as e:
            print(f"   ❌ Error converting {csv_file.name}: {e}")
            errors += 1

    print(f"   ✅ Converted {converted} files")
    if errors > 0:
        print(f"   ⚠️  {errors} errors")

    return errors == 0


def main():
    """Convert residuals for both plants."""
    print("=" * 60)
    print("CSV to Parquet Conversion")
    print("=" * 60)

    plants = ["eta", "ribera"]
    results = {}

    for plant_id in plants:
        success = convert_plant_residuals(plant_id)
        results[plant_id] = success

    # Summary
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    for plant_id, success in results.items():
        status = "✅ Success" if success else "❌ Failed"
        print(f"   {plant_id:12s}: {status}")

    # Return exit code
    all_success = all(results.values())
    sys.exit(0 if all_success else 1)


if __name__ == "__main__":
    main()
