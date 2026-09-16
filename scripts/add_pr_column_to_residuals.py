#!/usr/bin/env python3
"""
Add PR (Performance Ratio) column to residuals Parquet files.

PR = actual / expected (when expected > 0)

This enables the PR timeline heatmap generation.
"""

import sys
from pathlib import Path

import polars as pl

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))


def add_pr_column(plant_id: str):
    """Add PR column to all residuals Parquet files for a plant."""
    data_dir = project_root / "public" / "data" / "digitaltwin" / plant_id

    if not data_dir.exists():
        print(f"⚠️  Data directory not found: {data_dir}")
        return False

    # Find all residuals parquet files
    parquet_files = sorted(data_dir.glob("residuals_INV_*.parquet"))

    if len(parquet_files) == 0:
        print(f"⚠️  No residuals parquet files found in {data_dir}")
        return False

    print(f"\n🔧 Adding PR column to {plant_id.upper()}...")
    print(f"   Found {len(parquet_files)} parquet files")

    processed = 0
    errors = 0

    for parquet_file in parquet_files:
        try:
            # Read parquet file
            df = pl.read_parquet(parquet_file)

            # Check if PR column already exists
            if "pr" in df.columns:
                continue

            # Calculate PR = actual / expected (handle division by zero)
            df = df.with_columns(
                pl.when(pl.col("expected") > 0)
                .then(pl.col("actual") / pl.col("expected"))
                .otherwise(None)
                .alias("pr")
            )

            # Write back to parquet
            df.write_parquet(parquet_file, compression="zstd")

            processed += 1

            if processed % 10 == 0:
                print(f"   Processed {processed}/{len(parquet_files)} files...")

        except Exception as e:
            print(f"   ❌ Error processing {parquet_file.name}: {e}")
            errors += 1

    print(f"   ✅ Added PR column to {processed} files")
    if errors > 0:
        print(f"   ⚠️  {errors} errors")

    return errors == 0


def main():
    """Add PR column to residuals for both plants."""
    print("=" * 60)
    print("Add PR Column to Residuals")
    print("=" * 60)

    plants = ["eta", "ribera"]
    results = {}

    for plant_id in plants:
        success = add_pr_column(plant_id)
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
