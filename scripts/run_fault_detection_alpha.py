#!/usr/bin/env python
"""
Run fault detection on Alpha (Spain) demo data.

This script demonstrates:
1. Rule-based fault detection on real plant data
2. Plant-agnostic feature engineering
3. Per-inverter analysis

Data: 150 inverters, 12 strings each, 182K timestamps (~15-min resolution)
"""

import sys
from pathlib import Path
from datetime import datetime
import json
import re

import polars as pl
import numpy as np

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.fault import (
    RuleBasedFaultDetector,
    FaultDetectionConfig,
    PlantAgnosticFeatureEngine,
    PlantConfig,
    FaultType,
    FaultSeverity,
)


# Alpha plant configuration
ALPHA_CONFIG = {
    "name": "Alpha",
    "location": "Spain",
    "n_inverters": 150,
    "strings_per_inverter": 12,
    "rated_dc_power_kw": 50000,  # Estimated ~50 MW
    "rated_ac_power_kw": 45000,
    "nominal_grid_frequency": 50.0,  # EU grid
}

# Column mapping for Alpha data
COLUMN_PATTERNS = {
    "timestamp": "timestamp",
    "poa_irradiance": "Alpha (ES): Plant / Irradiation_average (W/m²)",
    "ambient_temp": "Alpha (ES): Meteo.z.bloxx / Ambient (°C)",
    "module_temp": "Alpha (ES): Meteo.z.bloxx / Module (°C)",
    "plant_power": "Alpha (ES): Plant / Power by Inverter (kW)",
    "solar_elevation": "Alpha (ES): Plant / Altitude (°)",
    "solar_azimuth": "Alpha (ES): Plant / Azimuth (°)",
    "humidity": "Alpha (ES): Plant / Wetter_Luftfeuchtigkeit (%)",
    "wind_speed": "Alpha (ES): Plant / Wetter_Windgeschwindigkeit (m/s)",
}


def load_alpha_data(filepath: str, sample_size: int = None) -> pl.DataFrame:
    """Load Alpha data with column filtering and optional sampling."""
    print(f"Loading data from {filepath} (using Polars lazy API with column filtering)...")

    # Use lazy scan for memory efficiency
    lf = pl.scan_parquet(filepath)

    # Get all available columns
    all_columns = lf.collect_schema().names()
    print(f"  Total columns in file: {len(all_columns)}")

    # Identify columns needed for fault detection
    needed_cols = []

    # Patterns for columns we need:
    # - Timestamp
    # - Plant-level weather/conditions (irradiance, temp, wind, humidity, solar angles)
    # - Inverter data: AC power, DC currents, DC voltages, temperature, normalized power

    for col in all_columns:
        col_lower = col.lower()

        # Always include timestamp
        if 'timestamp' in col_lower or 'time' in col_lower:
            needed_cols.append(col)

        # Plant-level columns
        elif any(pattern in col_lower for pattern in [
            'irrad', 'radiation', 'ghi', 'poa',  # Irradiance
            'ambient', 'module',  # Temperature
            'wind', 'humidity', 'luftfeuchtigkeit',  # Weather
            'altitude', 'azimuth', 'elevation',  # Solar angles
            'plant / power',  # Plant-level power
        ]):
            needed_cols.append(col)

        # Inverter-specific columns (keep for fault detection)
        elif 'inv' in col_lower and any(pattern in col_lower for pattern in [
            'p_ac', 'power',  # AC power
            'input_current', 'current',  # String currents
            'u_dc', 'voltage',  # String voltages
            'temperature',  # Inverter temperature
            'normalized',  # Normalized power
        ]):
            needed_cols.append(col)

    # Remove duplicates while preserving order
    needed_cols = list(dict.fromkeys(needed_cols))

    print(f"  Filtered to {len(needed_cols)} needed columns (timestamp + weather + inverters + strings)")
    print(f"  Memory reduction: {100 * (1 - len(needed_cols) / len(all_columns)):.1f}%")

    # Select only needed columns in lazy mode
    lf = lf.select(needed_cols)

    # Apply sampling if requested (in lazy mode for efficiency)
    if sample_size:
        # Calculate step for even sampling
        lf = lf.with_row_count("_row_id")

        # Collect schema to get approximate count (we need to know total rows for sampling)
        # For Polars lazy, we'll just collect and sample
        df = lf.collect()

        if len(df) > sample_size:
            step = len(df) // sample_size
            df = df.gather_every(step).head(sample_size)
            print(f"  Sampled to {len(df):,} rows")

        # Remove row_id column if added
        if "_row_id" in df.columns:
            df = df.drop("_row_id")
    else:
        # Collect all data with filtered columns
        df = lf.collect()

    print(f"  Loaded {len(df):,} rows x {len(df.columns)} columns")

    return df


def extract_inverter_data(df: pl.DataFrame, inverter_id: str) -> pl.DataFrame:
    """Extract data for a single inverter with standardized column names."""

    prefix = f"Alpha (ES): INV {inverter_id}"

    # Find columns for this inverter
    inv_cols = [c for c in df.columns if prefix in c]

    if not inv_cols:
        return None

    # Select and rename columns
    select_cols = ["timestamp"]
    rename_map = {}

    # Plant-level columns
    for std_name, orig_name in COLUMN_PATTERNS.items():
        if orig_name in df.columns and std_name != "timestamp":
            select_cols.append(orig_name)
            rename_map[orig_name] = std_name

    # Inverter columns
    for col in inv_cols:
        select_cols.append(col)

        # Standardize names
        if "P_AC" in col:
            rename_map[col] = "ac_power"
        elif "Input_current" in col:
            # Extract string number
            match = re.search(r'Input_current_(\d+)', col)
            if match:
                rename_map[col] = f"string_current_{int(match.group(1))}"
        elif "U_DC_" in col:
            match = re.search(r'U_DC_(\d+)', col)
            if match:
                rename_map[col] = f"string_voltage_{int(match.group(1))}"
        elif "Temperature" in col:
            rename_map[col] = "inverter_temp"
        elif "Inverter Power Normalized" in col:
            rename_map[col] = "power_normalized"

    # Select and rename
    inv_df = df.select([c for c in select_cols if c in df.columns])
    inv_df = inv_df.rename(rename_map)

    # Add inverter ID
    inv_df = inv_df.with_columns(pl.lit(inverter_id).alias("inverter_id"))

    return inv_df


def run_fault_detection_single_inverter(
    df: pl.DataFrame,
    inverter_id: str,
    config: FaultDetectionConfig,
) -> dict:
    """Run fault detection on a single inverter."""

    inv_df = extract_inverter_data(df, inverter_id)

    if inv_df is None or len(inv_df) == 0:
        return {"inverter_id": inverter_id, "status": "no_data"}

    # Run rule-based detection
    detector = RuleBasedFaultDetector(config)
    result = detector.detect_all(inv_df)

    return {
        "inverter_id": inverter_id,
        "status": "ok",
        "n_records": result.records_processed,
        "n_alerts": result.n_alerts,
        "n_critical": result.n_critical,
        "n_warning": result.n_warning,
        "alerts": [a.to_dict() for a in result.alerts],
    }


def run_fleet_fault_detection(
    df: pl.DataFrame,
    config: FaultDetectionConfig,
    max_inverters: int = 10,
) -> dict:
    """Run fault detection across fleet of inverters."""

    print(f"\nRunning fault detection on up to {max_inverters} inverters...")

    # Find all inverters
    inverter_ids = set()
    for col in df.columns:
        match = re.search(r'INV (\d+\.\d+)', col)
        if match:
            inverter_ids.add(match.group(1))

    inverter_ids = sorted(inverter_ids)[:max_inverters]
    print(f"  Processing {len(inverter_ids)} inverters: {inverter_ids[:5]}...")

    results = []
    total_alerts = 0
    total_critical = 0

    for inv_id in inverter_ids:
        inv_result = run_fault_detection_single_inverter(df, inv_id, config)
        results.append(inv_result)

        if inv_result["status"] == "ok":
            total_alerts += inv_result["n_alerts"]
            total_critical += inv_result["n_critical"]

    return {
        "n_inverters": len(inverter_ids),
        "total_alerts": total_alerts,
        "total_critical": total_critical,
        "inverter_results": results,
    }


def analyze_string_health(df: pl.DataFrame, inverter_id: str) -> dict:
    """Analyze string-level health for an inverter."""

    inv_df = extract_inverter_data(df, inverter_id)

    if inv_df is None:
        return None

    # Find string current columns
    string_cols = [c for c in inv_df.columns if c.startswith("string_current_")]

    if not string_cols:
        return None

    # Filter daylight hours
    if "poa_irradiance" in inv_df.columns:
        inv_df = inv_df.filter(pl.col("poa_irradiance") > 100)

    if len(inv_df) == 0:
        return None

    # Calculate statistics per string
    string_stats = {}
    for col in string_cols:
        values = inv_df[col].drop_nulls().to_numpy()
        if len(values) > 0:
            string_stats[col] = {
                "mean": float(np.mean(values)),
                "std": float(np.std(values)),
                "min": float(np.min(values)),
                "max": float(np.max(values)),
                "zeros_pct": float(np.sum(values < 0.1) / len(values) * 100),
            }

    # Find underperforming strings
    if string_stats:
        means = [s["mean"] for s in string_stats.values()]
        overall_mean = np.mean(means)

        underperforming = []
        for name, stats in string_stats.items():
            if stats["mean"] < overall_mean * 0.85:
                underperforming.append({
                    "string": name,
                    "mean_current": stats["mean"],
                    "deficit_pct": (1 - stats["mean"] / overall_mean) * 100,
                })
    else:
        underperforming = []

    return {
        "inverter_id": inverter_id,
        "n_strings": len(string_cols),
        "n_records": len(inv_df),
        "string_stats": string_stats,
        "underperforming_strings": underperforming,
        "overall_mean_current": float(overall_mean) if string_stats else None,
    }


def main():
    """Main entry point."""

    print("=" * 60)
    print("ALPHA FAULT DETECTION DEMO")
    print("=" * 60)

    # Load data
    data_path = Path(__file__).parent.parent / "demo_spain" / "emsdt_650addffb0721062b19a6636_15_00461_Inverter_Inverter Power Normalized_training.parquet"

    # Sample for faster processing (use full data for production)
    df = load_alpha_data(str(data_path), sample_size=10000)

    # Configure detector for EU grid
    config = FaultDetectionConfig.for_eu_plant()
    config.rated_dc_power_kw = ALPHA_CONFIG["rated_dc_power_kw"]
    config.rated_ac_power_kw = ALPHA_CONFIG["rated_ac_power_kw"]
    config.inverter.max_module_temp = 80.0  # Spain is hot

    # Run fleet fault detection
    fleet_results = run_fleet_fault_detection(df, config, max_inverters=10)

    print(f"\n{'=' * 60}")
    print("FLEET SUMMARY")
    print("=" * 60)
    print(f"  Inverters analyzed: {fleet_results['n_inverters']}")
    print(f"  Total alerts: {fleet_results['total_alerts']}")
    print(f"  Critical alerts: {fleet_results['total_critical']}")

    # Show alerts per inverter
    print(f"\nAlerts by inverter:")
    for inv_result in fleet_results["inverter_results"]:
        if inv_result["status"] == "ok" and inv_result["n_alerts"] > 0:
            print(f"  INV {inv_result['inverter_id']}: {inv_result['n_alerts']} alerts ({inv_result['n_critical']} critical)")
            for alert in inv_result["alerts"][:3]:
                print(f"    - {alert['fault_type']}: {alert['message'][:60]}...")

    # String health analysis
    print(f"\n{'=' * 60}")
    print("STRING HEALTH ANALYSIS")
    print("=" * 60)

    for inv_id in ["01.001", "01.002", "01.003"]:
        health = analyze_string_health(df, inv_id)
        if health:
            print(f"\nINV {inv_id}:")
            print(f"  Strings: {health['n_strings']}, Records: {health['n_records']}")
            print(f"  Mean current: {health['overall_mean_current']:.2f} A")

            if health["underperforming_strings"]:
                print(f"  Underperforming strings:")
                for s in health["underperforming_strings"]:
                    print(f"    - {s['string']}: {s['mean_current']:.2f} A ({s['deficit_pct']:.1f}% below mean)")
            else:
                print(f"  All strings performing normally")

    # Save results
    output_path = Path(__file__).parent.parent / "outputs_alpha" / "fault_detection_results.json"
    output_path.parent.mkdir(exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(fleet_results, f, indent=2, default=str)

    print(f"\n{'=' * 60}")
    print(f"Results saved to: {output_path}")
    print("=" * 60)

    return fleet_results


if __name__ == "__main__":
    main()
