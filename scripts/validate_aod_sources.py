#!/usr/bin/env python3
"""
Compare CAMS EAC4 Reanalysis vs Open-Meteo (CAMS Forecast) AOD data.

Purpose: Assess compatibility before merging datasets.

Usage:
    python scripts/validate_aod_sources.py --plant-id alpha1
    python scripts/validate_aod_sources.py --plant-id eta
    python scripts/validate_aod_sources.py --plant-id ribera
"""

import argparse
import json
import numpy as np
from pathlib import Path
from scipy import stats
from datetime import datetime


def load_cams_eac4(plant_id: str) -> dict:
    """Load CAMS EAC4 reanalysis AOD."""
    path = Path(f"public/data/soiling/{plant_id}/cams_aod_history.json")
    if not path.exists():
        raise FileNotFoundError(f"CAMS EAC4 data not found: {path}")
    with open(path) as f:
        return json.load(f)


def load_openmeteo(plant_id: str) -> dict:
    """Load Open-Meteo AOD (validation overlap file)."""
    path = Path(f"public/data/soiling/{plant_id}/openmeteo_aod_validation.json")
    if not path.exists():
        raise FileNotFoundError(f"Open-Meteo validation data not found: {path}\n"
                              f"Run: python scripts/fetch_openmeteo_overlap.py --plant-id {plant_id} "
                              f"--start-date 2024-10-01 --end-date 2024-12-31")
    with open(path) as f:
        return json.load(f)


def aggregate_cams_to_daily(cams_data: dict) -> dict:
    """Aggregate 3-hourly CAMS to daily mean."""
    daily = {}
    for record in cams_data["data"]:
        # Handle both "2024-12-31 21:00" and "2024-12-31T21:00" formats
        timestamp = record["timestamp"]
        date = timestamp.split("T")[0].split(" ")[0]  # Get YYYY-MM-DD part
        if date not in daily:
            daily[date] = []
        if record.get("aod_550nm") is not None:
            daily[date].append(record["aod_550nm"])

    # Calculate daily means
    return {date: np.mean(values) for date, values in daily.items() if values}


def compare_datasets(plant_id: str):
    """Compare CAMS EAC4 vs Open-Meteo AOD for overlap period."""
    print(f"\n{'='*70}")
    print(f"AOD DATA SOURCE VALIDATION: {plant_id.upper()}")
    print(f"{'='*70}\n")

    # Load data
    print("Loading datasets...")
    cams = load_cams_eac4(plant_id)
    openmeteo = load_openmeteo(plant_id)
    print(f"  ✅ CAMS EAC4 Reanalysis: {cams['metadata']['period']['start']} to {cams['metadata']['period']['end']}")
    print(f"  ✅ Open-Meteo Forecast: {openmeteo['metadata']['period']['start']} to {openmeteo['metadata']['period']['end']}")

    # Prepare datasets
    cams_daily = aggregate_cams_to_daily(cams)
    openmeteo_daily = {d["date"]: d["aod_550nm"] for d in openmeteo["daily_data"] if d.get("aod_550nm")}

    # Find common dates
    common_dates = sorted(set(cams_daily.keys()) & set(openmeteo_daily.keys()))

    if not common_dates:
        print("\n❌ ERROR: No overlapping dates found!")
        print("   CAMS EAC4 only covers through 2024-12-31")
        print("   Open-Meteo covers last 92 days from today")
        print("   Cannot validate compatibility without overlap.")
        return None

    print(f"\nOverlap period: {common_dates[0]} to {common_dates[-1]}")
    print(f"Common days: {len(common_dates)}")

    # Extract values for comparison
    cams_values = np.array([cams_daily[d] for d in common_dates])
    openmeteo_values = np.array([openmeteo_daily[d] for d in common_dates])

    # Calculate statistics
    bias = np.mean(openmeteo_values - cams_values)
    bias_pct = (bias / np.mean(cams_values)) * 100
    rmse = np.sqrt(np.mean((openmeteo_values - cams_values)**2))
    mae = np.mean(np.abs(openmeteo_values - cams_values))
    correlation, p_value = stats.pearsonr(cams_values, openmeteo_values)

    # Calculate R² (coefficient of determination)
    ss_res = np.sum((openmeteo_values - cams_values)**2)
    ss_tot = np.sum((cams_values - np.mean(cams_values))**2)
    r_squared = 1 - (ss_res / ss_tot)

    # Print results
    print("\n" + "="*70)
    print("STATISTICAL COMPARISON")
    print("="*70)
    print(f"  CAMS EAC4 Reanalysis:")
    print(f"    Mean: {np.mean(cams_values):.4f}")
    print(f"    Std:  {np.std(cams_values):.4f}")
    print(f"    Min:  {np.min(cams_values):.4f}")
    print(f"    Max:  {np.max(cams_values):.4f}")
    print(f"\n  Open-Meteo Forecast:")
    print(f"    Mean: {np.mean(openmeteo_values):.4f}")
    print(f"    Std:  {np.std(openmeteo_values):.4f}")
    print(f"    Min:  {np.min(openmeteo_values):.4f}")
    print(f"    Max:  {np.max(openmeteo_values):.4f}")
    print(f"\n  Differences:")
    print(f"    Bias (Open-Meteo - CAMS): {bias:+.4f} ({bias_pct:+.1f}%)")
    print(f"    RMSE: {rmse:.4f}")
    print(f"    MAE:  {mae:.4f}")
    print(f"    Correlation (r): {correlation:.3f} (p={p_value:.2e})")
    print(f"    R²: {r_squared:.3f}")

    # Compatibility assessment
    print("\n" + "="*70)
    print("COMPATIBILITY ASSESSMENT")
    print("="*70)

    compatible = False
    recommendation = ""
    correction_method = ""

    if abs(bias_pct) < 10 and correlation > 0.85:
        compatible = True
        recommendation = "✅ COMPATIBLE - Safe to use together with bias correction"
        correction_method = f"Subtract {bias:.4f} from Open-Meteo values"
        print(f"  {recommendation}")
        print(f"  Recommended correction: {correction_method}")
    elif abs(bias_pct) < 20 and correlation > 0.70:
        compatible = True
        recommendation = "⚠️  MODERATE - Can use with careful bias adjustment"
        correction_factor = np.mean(cams_values)/np.mean(openmeteo_values)
        correction_method = f"Multiply Open-Meteo by {correction_factor:.4f}"
        print(f"  {recommendation}")
        print(f"  Apply correction factor: {correction_method}")
    else:
        compatible = False
        recommendation = "❌ INCOMPATIBLE - Keep datasets separate"
        correction_method = "None - use only for gap-filling, not continuous series"
        print(f"  {recommendation}")
        print(f"  Consider using only for gap-filling, not for continuous series")
        print(f"  Investigate regional bias patterns or seasonal effects")

    # Save validation report
    report = {
        "plant_id": plant_id,
        "validation_date": datetime.now().isoformat(),
        "overlap_period": {
            "start": common_dates[0],
            "end": common_dates[-1],
            "days": len(common_dates)
        },
        "statistics": {
            "cams_eac4": {
                "mean": float(np.mean(cams_values)),
                "std": float(np.std(cams_values)),
                "min": float(np.min(cams_values)),
                "max": float(np.max(cams_values))
            },
            "openmeteo": {
                "mean": float(np.mean(openmeteo_values)),
                "std": float(np.std(openmeteo_values)),
                "min": float(np.min(openmeteo_values)),
                "max": float(np.max(openmeteo_values))
            },
            "comparison": {
                "bias": float(bias),
                "bias_percent": float(bias_pct),
                "rmse": float(rmse),
                "mae": float(mae),
                "correlation": float(correlation),
                "p_value": float(p_value),
                "r_squared": float(r_squared)
            }
        },
        "assessment": {
            "compatible": compatible,
            "recommendation": recommendation,
            "correction_method": correction_method
        }
    }

    output_path = Path(f"public/data/soiling/{plant_id}/aod_validation_report.json")
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)

    print(f"\n✅ Validation report saved: {output_path}")
    print("="*70 + "\n")

    return report


def main():
    parser = argparse.ArgumentParser(description="Validate AOD data sources")
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    args = parser.parse_args()

    try:
        compare_datasets(args.plant_id)
    except FileNotFoundError as e:
        print(f"\n❌ ERROR: {e}")
        print("\nMake sure you have run:")
        print(f"  1. Download CAMS EAC4 historical data (should already exist)")
        print(f"  2. python scripts/fetch_dust_history.py --plant-id {args.plant_id}")


if __name__ == "__main__":
    main()
