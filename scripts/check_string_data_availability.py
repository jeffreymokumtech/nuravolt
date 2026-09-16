#!/usr/bin/env python
"""
Check string-level data availability for digital twin training.

Usage:
    python scripts/check_string_data_availability.py --plant alpha1
    python scripts/check_string_data_availability.py --plant ribera
    python scripts/check_string_data_availability.py --plant eta
"""

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

import polars as pl

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.plant_config import PlantConfig


def analyze_string_data_availability(config: PlantConfig) -> dict:
    """Analyze string-level data availability for a plant."""

    source_path = Path(config.data.source_path)

    if not source_path.exists():
        return {
            "status": "error",
            "message": f"Data file not found: {source_path}",
        }

    print(f"\n{'='*60}")
    print(f"Analyzing: {config.plant_name}")
    print(f"Data file: {source_path.name}")
    print(f"{'='*60}\n")

    # Load schema only (fast)
    print("Loading data schema...")
    lf = pl.scan_parquet(source_path)
    all_columns = lf.collect_schema().names()

    print(f"Total columns in file: {len(all_columns):,}")

    # Identify string-level columns
    string_current_cols = []
    string_voltage_cols = []

    # Pattern for string current: "Plant (ES): INV XX.XXX / Input_current_NN (A)"
    # Pattern for string voltage: "Plant (ES): INV XX.XXX / U_DC_NN (V)"

    current_pattern = re.compile(r'INV\s+[\d.]+\s*/\s*Input_current_(\d+)\s*\(A\)')
    voltage_pattern = re.compile(r'INV\s+[\d.]+\s*/\s*U_DC_(\d+)\s*\(V\)')

    for col in all_columns:
        if current_pattern.search(col):
            string_current_cols.append(col)
        elif voltage_pattern.search(col):
            string_voltage_cols.append(col)

    print(f"\nString-level measurements found:")
    print(f"  Current columns: {len(string_current_cols):,}")
    print(f"  Voltage columns: {len(string_voltage_cols):,}")

    if len(string_current_cols) == 0:
        return {
            "status": "insufficient",
            "plant_id": config.plant_id,
            "plant_name": config.plant_name,
            "total_columns": len(all_columns),
            "string_current_cols": 0,
            "string_voltage_cols": 0,
            "recommendation": "No string-level current data found. String digital twin not possible.",
        }

    # Analyze per-inverter string configuration
    print("\nAnalyzing per-inverter string configuration...")

    inverter_string_counts = {}
    for col in string_current_cols:
        # Extract inverter ID and string number
        match = re.search(r'INV\s+([\d.]+)\s*/\s*Input_current_(\d+)', col)
        if match:
            inv_id = match.group(1)
            string_num = int(match.group(2))

            if inv_id not in inverter_string_counts:
                inverter_string_counts[inv_id] = []
            inverter_string_counts[inv_id].append(string_num)

    # Calculate statistics
    strings_per_inverter = [len(strings) for strings in inverter_string_counts.values()]
    avg_strings = sum(strings_per_inverter) / len(strings_per_inverter) if strings_per_inverter else 0
    min_strings = min(strings_per_inverter) if strings_per_inverter else 0
    max_strings = max(strings_per_inverter) if strings_per_inverter else 0

    print(f"  Inverters with string data: {len(inverter_string_counts)}")
    print(f"  Strings per inverter: {min_strings}-{max_strings} (avg: {avg_strings:.1f})")

    # Sample a subset of string columns for data quality check
    print("\nChecking data quality (sampling 30 string columns)...")
    sample_cols = string_current_cols[:30] + ["timestamp"]

    # Load sample data
    df_sample = lf.select(sample_cols).collect()

    # Temporal coverage
    # Ensure timestamp is datetime type
    if df_sample["timestamp"].dtype == pl.Utf8:
        df_sample = df_sample.with_columns(
            pl.col("timestamp").str.strptime(pl.Datetime, format=config.data.timestamp_format)
        )

    start_date = df_sample["timestamp"].min()
    end_date = df_sample["timestamp"].max()
    total_days = (end_date - start_date).days if start_date and end_date else 0
    total_records = len(df_sample)

    print(f"\nTemporal coverage:")
    print(f"  Start: {start_date}")
    print(f"  End: {end_date}")
    print(f"  Duration: {total_days:,} days")
    print(f"  Total records: {total_records:,}")

    # Data completeness check
    completeness_stats = []
    for col in sample_cols[:-1]:  # Exclude timestamp
        null_count = df_sample[col].null_count()
        completeness_pct = 100 * (1 - null_count / total_records)
        completeness_stats.append(completeness_pct)

    avg_completeness = sum(completeness_stats) / len(completeness_stats)
    min_completeness = min(completeness_stats)
    max_completeness = max(completeness_stats)

    print(f"\nData completeness (sampled strings):")
    print(f"  Average: {avg_completeness:.1f}%")
    print(f"  Range: {min_completeness:.1f}% - {max_completeness:.1f}%")

    # Generate recommendation
    recommendation = _generate_recommendation(
        total_days=total_days,
        avg_completeness=avg_completeness,
        num_inverters=len(inverter_string_counts),
        avg_strings=avg_strings,
    )

    return {
        "status": "success",
        "plant_id": config.plant_id,
        "plant_name": config.plant_name,
        "total_columns": len(all_columns),
        "string_current_cols": len(string_current_cols),
        "string_voltage_cols": len(string_voltage_cols),
        "inverters_with_strings": len(inverter_string_counts),
        "strings_per_inverter_min": min_strings,
        "strings_per_inverter_max": max_strings,
        "strings_per_inverter_avg": avg_strings,
        "temporal_coverage_days": total_days,
        "total_records": total_records,
        "data_completeness_avg": avg_completeness,
        "data_completeness_min": min_completeness,
        "data_completeness_max": max_completeness,
        "start_date": str(start_date),
        "end_date": str(end_date),
        "recommendation": recommendation,
    }


def _generate_recommendation(
    total_days: int,
    avg_completeness: float,
    num_inverters: int,
    avg_strings: float,
) -> str:
    """Generate training recommendation based on data characteristics."""

    issues = []

    # Check temporal coverage (need 2+ years for reliable training)
    if total_days < 365:
        issues.append(f"Insufficient temporal coverage ({total_days} days < 1 year minimum)")
    elif total_days < 730:
        issues.append(f"Limited temporal coverage ({total_days} days < 2 years recommended)")

    # Check data completeness
    if avg_completeness < 70:
        issues.append(f"Poor data quality (avg completeness {avg_completeness:.1f}% < 70% minimum)")
    elif avg_completeness < 85:
        issues.append(f"Moderate data quality (avg completeness {avg_completeness:.1f}% < 85% recommended)")

    # Check configuration
    if avg_strings < 4:
        issues.append(f"Few strings per inverter ({avg_strings:.1f} < 4 may limit mismatch detection)")

    if len(issues) == 0:
        return (
            f"✅ READY FOR TRAINING\n"
            f"   - {total_days} days of data ({total_days/365:.1f} years)\n"
            f"   - {avg_completeness:.1f}% average completeness\n"
            f"   - {num_inverters} inverters with {avg_strings:.1f} strings each\n"
            f"   - Proceed with string digital twin training"
        )
    elif total_days >= 365 and avg_completeness >= 70:
        return (
            f"⚠️  READY WITH CAVEATS\n"
            f"   Issues:\n" + "\n".join(f"   - {issue}" for issue in issues) + "\n"
            f"   - Can proceed but expect lower model quality\n"
            f"   - Consider waiting for more data if time permits"
        )
    else:
        return (
            f"❌ NOT READY\n"
            f"   Critical issues:\n" + "\n".join(f"   - {issue}" for issue in issues) + "\n"
            f"   - Wait for more data before training string twins"
        )


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Check string-level data availability for digital twin training'
    )
    parser.add_argument(
        '--plant',
        required=True,
        help='Plant ID (alpha1, ribera, eta, etc.)'
    )
    args = parser.parse_args()

    # Load plant config
    config_path = Path(__file__).parent.parent / "plant_configs" / f"{args.plant}.yaml"

    if not config_path.exists():
        print(f"❌ Error: Plant config not found: {config_path}")
        print(f"\nAvailable configs:")
        for p in (Path(__file__).parent.parent / "plant_configs").glob("*.yaml"):
            if p.stem != "_template":
                print(f"  - {p.stem}")
        return 1

    config = PlantConfig.from_yaml(config_path)

    # Analyze data availability
    result = analyze_string_data_availability(config)

    # Print summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")

    if result["status"] == "error":
        print(f"❌ {result['message']}")
        return 1

    print(f"\nPlant: {result['plant_name']} ({result['plant_id']})")
    print(f"String data availability: {result['string_current_cols']:,} current columns")

    if result["status"] == "insufficient":
        print(f"\n{result['recommendation']}")
        return 1

    print(f"Inverters: {result['inverters_with_strings']}")
    print(f"Strings/inverter: {result['strings_per_inverter_min']}-{result['strings_per_inverter_max']} (avg: {result['strings_per_inverter_avg']:.1f})")
    print(f"Data period: {result['temporal_coverage_days']:,} days")
    print(f"Completeness: {result['data_completeness_avg']:.1f}%")

    print(f"\n{result['recommendation']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
