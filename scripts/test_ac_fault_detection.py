#!/usr/bin/env python3
"""
Test AC-Side Fault Detection

Runs the ACFaultDetector on all plants with SCADA data
and outputs analysis results.

Usage:
    python scripts/test_ac_fault_detection.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.ac_fault_detector import (
    ACFaultDetector,
    ACFaultThresholds,
    DataAvailability,
)


# Configuration
PLANTS = [
    "alpha",
    "ribera",
    "eta",
    "epsilon",
    "gamma",
    "delta",
    "zeta",
]

# Approximate rated power per plant (kW)
# Based on max observed power in SCADA data
PLANT_RATED_POWER = {
    "alpha": 10000,    # ~10 MW plant
    "ribera": 3000,    # ~3 MW plant
    "eta": 2500,     # ~2.5 MW plant
    "epsilon": 1500,       # ~1.5 MW plant
    "gamma": 2000,     # ~2 MW plant
    "delta": 1500,     # ~1.5 MW plant
    "zeta": 1200,  # ~1.2 MW plant
}

SCADA_BASE = Path("backenddata/scada")
OUTPUT_DIR = Path("backenddata/ac_faults")


def load_scada(plant_id: str, days: int = 90) -> pl.DataFrame:
    """Load SCADA data for a plant."""

    scada_dir = SCADA_BASE / plant_id

    if not scada_dir.exists():
        return pl.DataFrame()

    parquet_files = sorted(scada_dir.glob("*.parquet"))

    if not parquet_files:
        return pl.DataFrame()

    # Load most recent files (up to 'days' worth)
    dfs = []
    for pf in parquet_files[-days:]:
        try:
            df = pl.read_parquet(pf)
            dfs.append(df)
        except Exception as e:
            continue

    if not dfs:
        return pl.DataFrame()

    df = pl.concat(dfs, how="diagonal")

    # Ensure timestamp column
    if "Timestamp" in df.columns:
        df = df.rename({"Timestamp": "timestamp"})

    if "timestamp" not in df.columns:
        return pl.DataFrame()

    # Parse timestamp if needed
    if df["timestamp"].dtype == pl.Utf8:
        df = df.with_columns(
            pl.col("timestamp").str.to_datetime().alias("timestamp")
        )

    return df.sort("timestamp")


def get_inverter_power_cols(df: pl.DataFrame) -> list[str]:
    """Find inverter power columns."""

    power_cols = []
    for col in df.columns:
        if "P_AC" in col or "Power by Inverter" in col:
            power_cols.append(col)

    return power_cols


def compute_dc_power(df: pl.DataFrame, inverter_prefix: str = "") -> pl.DataFrame:
    """Compute total DC power from MPPT currents and voltages."""

    # Find MPPT columns for this inverter
    current_cols = []
    voltage_cols = []

    for col in df.columns:
        if inverter_prefix and inverter_prefix not in col:
            continue
        if "Input_current" in col:
            current_cols.append(col)
        elif "U_DC" in col:
            voltage_cols.append(col)

    if not current_cols or not voltage_cols:
        return df

    # Pair currents and voltages (assuming same MPPT numbering)
    # Calculate P = V × I for each MPPT and sum

    p_dc_exprs = []
    for i, i_col in enumerate(sorted(current_cols)):
        # Find matching voltage column
        mppt_num = i_col.split("_")[-1].replace("(A)", "").strip()
        matching_v = None
        for v_col in voltage_cols:
            if mppt_num in v_col:
                matching_v = v_col
                break

        if matching_v:
            p_dc_exprs.append(
                (pl.col(i_col).fill_null(0) * pl.col(matching_v).fill_null(0) / 1000)  # Convert to kW
            )

    if p_dc_exprs:
        # Sum all MPPT powers
        df = df.with_columns(
            sum(p_dc_exprs).alias("P_DC")
        )

    return df


def analyze_plant(plant_id: str) -> dict:
    """Analyze a single plant for AC faults."""

    print(f"\n{'='*60}")
    print(f"Analyzing: {plant_id.upper()}")
    print(f"{'='*60}")

    # Load SCADA data
    df = load_scada(plant_id, days=90)

    if df.height == 0:
        print(f"  No SCADA data found")
        return {"plant_id": plant_id, "status": "no_data"}

    print(f"  Data points: {df.height:,}")
    print(f"  Date range: {df['timestamp'].min()} to {df['timestamp'].max()}")
    print(f"  Columns: {len(df.columns)}")

    # Get rated power
    rated_power = PLANT_RATED_POWER.get(plant_id, 1000)

    # Initialize detector
    detector = ACFaultDetector(
        plant_id=plant_id,
        rated_power_kw=rated_power,
    )

    # Check data availability
    availability = detector.check_data_availability(df)

    print(f"\n  Data Availability:")
    print(f"    AC Power: {'✅' if availability.has_p_ac else '❌'}")
    print(f"    DC Power: {'✅' if availability.has_p_dc else '❌'}")
    print(f"    MPPT Current: {'✅' if availability.has_mppt_current else '❌'} ({availability.n_mppt_channels} channels)")
    print(f"    MPPT Voltage: {'✅' if availability.has_mppt_voltage else '❌'}")
    print(f"    Grid Data: {'✅' if availability.has_grid_frequency else '❌'}")
    print(f"    Irradiance: {'✅' if availability.has_irradiance else '❌'}")
    print(f"    Temperature: {'✅' if availability.has_temperature else '❌'}")

    # Compute DC power if not present but MPPTs available
    if not availability.has_p_dc and availability.has_mppt_current and availability.has_mppt_voltage:
        print(f"\n  Computing DC power from MPPTs...")
        df = compute_dc_power(df)
        availability.has_p_dc = "P_DC" in df.columns

    # Find/map column names
    column_mapping = {}

    # Map P_AC
    for col in df.columns:
        if "P_AC" in col and "kW" in col:
            column_mapping["p_ac"] = col
            break
    if "p_ac" not in column_mapping:
        for col in df.columns:
            if "P_AC" in col:
                column_mapping["p_ac"] = col
                break

    # Map irradiance
    for col in df.columns:
        if "Irradiation_average" in col:
            column_mapping["irradiance"] = col
            break

    # Map temperature
    for col in df.columns:
        if "Temperature" in col and "°C" in col:
            column_mapping["temperature"] = col
            break

    print(f"\n  Column mapping: {column_mapping}")

    # Run detection
    print(f"\n  Running fault detection...")

    all_results = []

    try:
        results = detector.detect_all(
            df,
            column_mapping=column_mapping,
        )
        all_results.extend(results)
        print(f"    Found {len(results)} faults")
    except Exception as e:
        print(f"    Error: {e}")

    # Summarize results
    if all_results:
        print(f"\n  Fault Summary:")

        by_type = {}
        by_severity = {}
        total_loss = 0

        for r in all_results:
            by_type[r.fault_type] = by_type.get(r.fault_type, 0) + 1
            by_severity[r.severity] = by_severity.get(r.severity, 0) + 1
            total_loss += r.loss_kwh

        for fault_type, count in sorted(by_type.items()):
            print(f"    {fault_type}: {count}")

        print(f"\n    By severity:")
        for sev in ["critical", "major", "moderate", "minor"]:
            if by_severity.get(sev, 0) > 0:
                print(f"      {sev}: {by_severity[sev]}")

        if total_loss > 0:
            print(f"\n    Total energy loss: {total_loss:.1f} kWh")

    # Generate report
    report = detector.generate_report(all_results, availability)

    # Save report
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / f"{plant_id}_ac_faults.md"

    with open(report_path, "w") as f:
        f.write(report)

    print(f"\n  Report saved: {report_path}")

    return {
        "plant_id": plant_id,
        "status": "ok",
        "n_samples": df.height,
        "n_faults": len(all_results),
        "faults_by_type": by_type if all_results else {},
        "faults_by_severity": by_severity if all_results else {},
        "total_loss_kwh": total_loss if all_results else 0,
        "data_availability": {
            "p_ac": availability.has_p_ac,
            "p_dc": availability.has_p_dc,
            "mppt": availability.has_mppt_current,
            "grid": availability.has_grid_frequency,
            "irradiance": availability.has_irradiance,
        },
    }


def generate_summary(all_results: list) -> str:
    """Generate summary report."""

    lines = []
    lines.append("# AC Fault Detection Summary\n")
    lines.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n")

    lines.append("## Cross-Plant Comparison\n")
    lines.append("| Plant | Samples | Faults | Efficiency | MPPT | Clipping | Curtailment | Loss (kWh) |")
    lines.append("|-------|---------|--------|------------|------|----------|-------------|------------|")

    for r in all_results:
        if r.get("status") != "ok":
            lines.append(f"| {r['plant_id']} | - | - | - | - | - | - | {r.get('status', 'error')} |")
            continue

        faults = r.get("faults_by_type", {})
        lines.append(
            f"| {r['plant_id']} | {r['n_samples']:,} | {r['n_faults']} | "
            f"{faults.get('efficiency_drop', 0)} | {faults.get('mppt_error', 0)} | "
            f"{faults.get('clipping', 0)} | {faults.get('curtailment', 0)} | "
            f"{r['total_loss_kwh']:.0f} |"
        )

    lines.append("")

    # Data availability
    lines.append("## Data Availability\n")
    lines.append("| Plant | P_AC | P_DC | MPPT | Grid | Irradiance |")
    lines.append("|-------|------|------|------|------|------------|")

    for r in all_results:
        if r.get("status") != "ok":
            continue

        avail = r.get("data_availability", {})
        lines.append(
            f"| {r['plant_id']} | "
            f"{'✅' if avail.get('p_ac') else '❌'} | "
            f"{'✅' if avail.get('p_dc') else '❌'} | "
            f"{'✅' if avail.get('mppt') else '❌'} | "
            f"{'✅' if avail.get('grid') else '❌'} | "
            f"{'✅' if avail.get('irradiance') else '❌'} |"
        )

    lines.append("")

    # Severity distribution
    lines.append("## Fault Severity Distribution\n")

    total_by_severity = {"critical": 0, "major": 0, "moderate": 0, "minor": 0}
    for r in all_results:
        if r.get("status") != "ok":
            continue
        for sev, count in r.get("faults_by_severity", {}).items():
            total_by_severity[sev] = total_by_severity.get(sev, 0) + count

    for sev in ["critical", "major", "moderate", "minor"]:
        if total_by_severity[sev] > 0:
            lines.append(f"- **{sev.title()}**: {total_by_severity[sev]}")

    lines.append("")

    # Notes
    lines.append("## Notes\n")
    lines.append("- Grid sync detection skipped (no grid frequency/voltage data available)")
    lines.append("- Compound ML detection requires fitting on normal data first")
    lines.append("- Clipping detection may show high counts on sunny days (expected behavior)")
    lines.append("")

    return "\n".join(lines)


def main():
    """Run AC fault detection on all plants."""

    print("\n" + "="*70)
    print("AC-SIDE FAULT DETECTION ANALYSIS")
    print("="*70)

    all_results = []

    for plant_id in PLANTS:
        result = analyze_plant(plant_id)
        all_results.append(result)

    # Generate summary
    print("\n" + "="*70)
    print("Generating summary...")

    summary = generate_summary(all_results)
    summary_path = OUTPUT_DIR / "ac_fault_summary.md"

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(summary_path, "w") as f:
        f.write(summary)

    print(f"Summary saved: {summary_path}")

    # Print final summary
    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"{'Plant':<15} | {'Faults':<8} | {'Efficiency':<10} | {'MPPT':<6} | {'Clipping':<8} | {'Loss (kWh)':<10}")
    print("-" * 75)

    for r in all_results:
        if r.get("status") == "ok":
            faults = r.get("faults_by_type", {})
            print(
                f"{r['plant_id']:<15} | {r['n_faults']:<8} | "
                f"{faults.get('efficiency_drop', 0):<10} | {faults.get('mppt_error', 0):<6} | "
                f"{faults.get('clipping', 0):<8} | {r['total_loss_kwh']:<10.0f}"
            )
        else:
            print(f"{r['plant_id']:<15} | {'N/A':<8} | {r.get('status', 'error')}")

    print("\n" + "="*70)
    print("ANALYSIS COMPLETE")
    print("="*70)

    # Save JSON results
    json_path = OUTPUT_DIR / "ac_fault_results.json"
    with open(json_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)

    print(f"\nJSON results saved: {json_path}")


if __name__ == "__main__":
    main()
