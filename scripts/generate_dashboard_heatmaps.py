#!/usr/bin/env python3
"""
Generate dashboard heatmap JSON files from residuals.

This script runs the DashboardAggregator to create:
- timeline_heatmap_data.json (power loss %)
- pr_timeline_heatmap.json (performance ratio)
"""

import argparse
import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.digitaltwin.dashboard_aggregator import DashboardAggregator


def generate_heatmaps(plant_id: str):
    """Generate heatmap JSON files for a single plant."""
    data_dir = project_root / "public" / "data" / "digitaltwin" / plant_id

    if not data_dir.exists():
        print(f"⚠️  Data directory not found: {data_dir}")
        return False

    print(f"\n🔧 Generating heatmaps for {plant_id.upper()}...")
    print(f"   Data directory: {data_dir}")

    parquet_files = list(data_dir.glob("residuals_INV_*.parquet"))
    csv_files = list(data_dir.glob("residuals_INV_*.csv"))
    if len(parquet_files) == 0 and len(csv_files) == 0:
        print(f"⚠️  No residuals files found in {data_dir}")
        return False

    if len(parquet_files) > 0:
        print(f"   Found {len(parquet_files)} parquet files")
    else:
        print(f"   Found {len(csv_files)} CSV files")

    try:
        # Create aggregator
        aggregator = DashboardAggregator(data_dir, data_dir)

        # Generate all heatmaps
        results = aggregator.aggregate_all()

        # Check results
        if results["timeline_heatmap"]:
            timeline_path = Path(results["timeline_heatmap"])
            size_mb = timeline_path.stat().st_size / (1024 * 1024)
            print(f"   ✅ timeline_heatmap_data.json ({size_mb:.1f} MB)")
        else:
            print(f"   ❌ timeline_heatmap_data.json failed")

        if results["pr_heatmap"]:
            pr_path = Path(results["pr_heatmap"])
            size_mb = pr_path.stat().st_size / (1024 * 1024)
            print(f"   ✅ pr_timeline_heatmap.json ({size_mb:.1f} MB)")
        else:
            print(f"   ⚠️  pr_timeline_heatmap.json not generated (no PR column)")

        if results["errors"]:
            print(f"   ⚠️  Errors: {results['errors']}")
            return False

        return True

    except Exception as e:
        print(f"   ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """Generate heatmaps for both plants."""
    parser = argparse.ArgumentParser(description="Generate dashboard heatmap JSON files from residuals parquet files.")
    parser.add_argument(
        "plant_ids",
        nargs="*",
        help="One or more plant IDs under public/data/digitaltwin/<plantId>. If omitted, runs for alpha1, eta, ribera.",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("Dashboard Heatmap Generation")
    print("=" * 60)

    plants = args.plant_ids or ["alpha1", "eta", "ribera"]
    results = {}

    for plant_id in plants:
        success = generate_heatmaps(plant_id)
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
