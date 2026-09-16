#!/usr/bin/env python3
"""
Merge CAMS EAC4 Reanalysis (historical) with Open-Meteo Forecast (2025) AOD data.

Applies validated bias corrections to ensure data compatibility.

Usage:
    python scripts/merge_aod_datasets.py --plant-id alpha1
    python scripts/merge_aod_datasets.py --plant-id eta
    python scripts/merge_aod_datasets.py --plant-id ribera
"""

import argparse
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List


# Validated bias corrections from validation study
BIAS_CORRECTIONS = {
    "alpha1": 0.0020,      # Add to Open-Meteo values
    "eta": 0.0017,  # Add to Open-Meteo values
    "ribera": -0.0078 # Subtract from Open-Meteo values (Open-Meteo is higher)
}


def load_cams_eac4(plant_id: str) -> Dict:
    """Load CAMS EAC4 Reanalysis data (2020-2024)."""
    path = Path(f"public/data/soiling/{plant_id}/cams_aod_history.json")
    if not path.exists():
        raise FileNotFoundError(f"CAMS EAC4 data not found: {path}")

    with open(path) as f:
        return json.load(f)


def load_openmeteo(plant_id: str) -> Dict:
    """Load Open-Meteo AOD data (2025)."""
    path = Path(f"public/data/soiling/{plant_id}/openmeteo_aod_history.json")
    if not path.exists():
        raise FileNotFoundError(f"Open-Meteo data not found: {path}")

    with open(path) as f:
        return json.load(f)


def aggregate_cams_to_daily(cams_data: Dict) -> Dict[str, float]:
    """Convert 3-hourly CAMS data to daily averages."""
    from statistics import mean

    daily = {}
    for record in cams_data["data"]:
        # Handle "2024-12-31 21:00" format
        timestamp = record["timestamp"]
        date = timestamp.split("T")[0].split(" ")[0]

        if date not in daily:
            daily[date] = []

        if record.get("aod_550nm") is not None:
            daily[date].append(record["aod_550nm"])

    # Calculate daily means
    return {date: round(mean(values), 4) for date, values in daily.items() if values}


def apply_bias_correction(openmeteo_data: Dict, plant_id: str) -> Dict:
    """Apply validated bias correction to Open-Meteo data."""
    correction = BIAS_CORRECTIONS.get(plant_id, 0.0)

    corrected_data = openmeteo_data.copy()
    corrected_data["daily_data"] = []

    for record in openmeteo_data["daily_data"]:
        corrected_record = record.copy()
        if corrected_record.get("aod_550nm") is not None:
            # Apply bias correction
            original_value = corrected_record["aod_550nm"]
            corrected_value = original_value + correction
            corrected_record["aod_550nm"] = round(corrected_value, 4)

        corrected_data["daily_data"].append(corrected_record)

    # Update metadata to indicate correction was applied
    corrected_data["metadata"]["bias_correction_applied"] = correction
    corrected_data["metadata"]["bias_correction_note"] = (
        f"Validated bias correction of {correction:+.4f} applied to align "
        f"Open-Meteo (CAMS Forecast) with CAMS EAC4 Reanalysis"
    )

    return corrected_data


def merge_datasets(plant_id: str, apply_correction: bool = True) -> Dict:
    """Merge CAMS EAC4 and Open-Meteo datasets."""
    print(f"\n{'='*70}")
    print(f"MERGING AOD DATASETS: {plant_id.upper()}")
    print(f"{'='*70}\n")

    # Load datasets
    print("Loading datasets...")
    cams = load_cams_eac4(plant_id)
    openmeteo = load_openmeteo(plant_id)

    print(f"  ✅ CAMS EAC4: {cams['metadata']['period']['start']} to {cams['metadata']['period']['end']}")
    print(f"  ✅ Open-Meteo: {openmeteo['metadata']['period']['start']} to {openmeteo['metadata']['period']['end']}")

    # Apply bias correction if requested
    if apply_correction:
        correction = BIAS_CORRECTIONS.get(plant_id, 0.0)
        print(f"\n  Applying bias correction: {correction:+.4f}")
        openmeteo = apply_bias_correction(openmeteo, plant_id)

    # Convert CAMS 3-hourly to daily
    print("\n  Converting CAMS EAC4 from 3-hourly to daily averages...")
    cams_daily = aggregate_cams_to_daily(cams)

    # Convert to daily_data format
    cams_daily_list = [
        {"date": date, "aod_550nm": aod}
        for date, aod in sorted(cams_daily.items())
    ]

    # Merge: Open-Meteo takes precedence for overlapping dates
    openmeteo_dates = {d["date"] for d in openmeteo["daily_data"]}

    merged_data = []

    # Add CAMS data (excluding dates covered by Open-Meteo)
    for record in cams_daily_list:
        if record["date"] not in openmeteo_dates:
            merged_data.append(record)

    # Add Open-Meteo data (with or without bias correction)
    for record in openmeteo["daily_data"]:
        if record.get("aod_550nm") is not None:
            merged_data.append({
                "date": record["date"],
                "aod_550nm": record["aod_550nm"]
            })

    # Sort by date
    merged_data.sort(key=lambda x: x["date"])

    # Calculate statistics
    aod_values = [d["aod_550nm"] for d in merged_data if d.get("aod_550nm")]

    # Build merged output
    output = {
        "metadata": {
            "plant_id": plant_id,
            "latitude": cams["metadata"]["latitude"],
            "longitude": cams["metadata"]["longitude"],
            "period": {
                "start": merged_data[0]["date"],
                "end": merged_data[-1]["date"],
                "total_days": len(merged_data)
            },
            "sources": {
                "historical_2020_2024": "CAMS EAC4 Reanalysis (3-hourly aggregated to daily)",
                "recent_2025": "Open-Meteo Air Quality API (CAMS Global Forecast)",
                "bias_correction": BIAS_CORRECTIONS.get(plant_id, 0.0) if apply_correction else 0.0,
                "validation_report": f"public/data/soiling/{plant_id}/aod_validation_report.json"
            },
            "generated_at": datetime.now().isoformat(),
            "note": (
                "Merged dataset combining CAMS EAC4 Reanalysis (2020-2024) and "
                "Open-Meteo CAMS Forecast (2025) with validated bias correction. "
                "Open-Meteo data takes precedence for overlapping dates."
            )
        },
        "statistics": {
            "total_days": len(merged_data),
            "mean_aod": round(sum(aod_values) / len(aod_values), 4) if aod_values else 0,
            "min_aod": round(min(aod_values), 4) if aod_values else 0,
            "max_aod": round(max(aod_values), 4) if aod_values else 0,
        },
        "daily_data": merged_data
    }

    # Save merged dataset
    output_dir = Path(f"public/data/soiling/{plant_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / "aod_merged.json"
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ Merged AOD dataset saved: {output_path}")
    print(f"\nMerged Dataset Summary:")
    print(f"  Period: {output['metadata']['period']['start']} to {output['metadata']['period']['end']}")
    print(f"  Total days: {output['statistics']['total_days']}")
    print(f"  Mean AOD: {output['statistics']['mean_aod']}")
    print(f"  Min AOD: {output['statistics']['min_aod']}")
    print(f"  Max AOD: {output['statistics']['max_aod']}")

    if apply_correction:
        print(f"  Bias correction applied: {BIAS_CORRECTIONS.get(plant_id, 0.0):+.4f}")

    print("="*70 + "\n")

    return output


def main():
    parser = argparse.ArgumentParser(description="Merge CAMS EAC4 and Open-Meteo AOD datasets")
    parser.add_argument("--plant-id", required=True, help="Plant ID")
    parser.add_argument("--no-bias-correction", action="store_true",
                       help="Skip bias correction (not recommended)")
    args = parser.parse_args()

    try:
        merge_datasets(args.plant_id, apply_correction=not args.no_bias_correction)
    except FileNotFoundError as e:
        print(f"\n❌ ERROR: {e}")
        print("\nMake sure you have:")
        print(f"  1. CAMS EAC4 data: public/data/soiling/{args.plant_id}/cams_aod_history.json")
        print(f"  2. Open-Meteo data: public/data/soiling/{args.plant_id}/openmeteo_aod_history.json")
        print(f"\nRun: python scripts/fetch_dust_history.py --plant-id {args.plant_id}")


if __name__ == "__main__":
    main()
