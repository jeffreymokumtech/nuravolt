#!/usr/bin/env python3
"""
Export PR timeline heatmaps for Eta and Ribera plants.

This script reads the residuals parquet files and generates the
pr_timeline_heatmap.json file needed by the frontend dashboard.
"""

import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.digitaltwin.dashboard_aggregator import DashboardAggregator

def export_pr_heatmap(plant_id: str):
    """Export PR heatmap for a single plant."""
    data_dir = project_root / "public" / "data" / "digitaltwin" / plant_id

    if not data_dir.exists():
        print(f"⚠️  Data directory not found: {data_dir}")
        return False

    print(f"\n🔧 Processing {plant_id.upper()}...")
    print(f"   Data directory: {data_dir}")

    # Check for residuals files
    parquet_files = list(data_dir.glob("residuals_INV_*.parquet"))
    if len(parquet_files) == 0:
        # Try CSV files if parquet not found
        csv_files = list(data_dir.glob("residuals_INV_*.csv"))
        if len(csv_files) == 0:
            print(f"⚠️  No residuals files found in {data_dir}")
            return False
        print(f"   Found {len(csv_files)} CSV files")
    else:
        print(f"   Found {len(parquet_files)} parquet files")

    try:
        # Create aggregator and run PR heatmap export
        aggregator = DashboardAggregator(data_dir, data_dir)

        # Generate PR heatmap
        print(f"   Generating PR heatmap...")
        pr_path = aggregator.aggregate_pr_timeline_heatmap()

        if pr_path:
            # Get file size
            file_size_mb = pr_path.stat().st_size / (1024 * 1024)
            print(f"   ✅ Generated: {pr_path.name} ({file_size_mb:.1f} MB)")
            return True
        else:
            print(f"   ⚠️  PR column not found in residuals data")
            return False

    except Exception as e:
        print(f"   ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Export PR heatmaps for all plants."""
    print("=" * 60)
    print("PR Timeline Heatmap Export")
    print("=" * 60)

    plants = ["eta", "ribera"]
    results = {}

    for plant_id in plants:
        success = export_pr_heatmap(plant_id)
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
