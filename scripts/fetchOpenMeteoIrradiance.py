#!/usr/bin/env python3
"""
Fetch Open-Meteo Irradiance and Compare with On-Site Measurements.

This is an entry point script that imports core logic from nuravolt.soiling.data_quality.

Usage:
    python scripts/fetchOpenMeteoIrradiance.py [plant_id]
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import polars as pl

from nuravolt.soiling.data_quality.irradiance_quality import (
    compare_irradiance_sources,
    fetch_open_meteo_irradiance,
    generate_hourly_metrics,
    generate_irradiance_alerts,
    generate_monthly_metrics,
    load_onsite_irradiance,
)

# ============================================================================
# Configuration
# ============================================================================

PLANT_CONFIG = {
    "alpha1": {
        "latitude": 37.8145,
        "longitude": -3.8047,
        "timezone": "Europe/Madrid",
        "name": "Alpha Solar Plant",
        "sensor_type": "Pyranometer"
    },
    "eta": {
        "latitude": 38.6623,
        "longitude": -5.392,
        "timezone": "Europe/Madrid",
        "name": "Eta Solar Plant",
        "sensor_type": "Pyranometer"
    },
    "ribera": {
        "latitude": 37.9271,
        "longitude": -1.2331,
        "timezone": "Europe/Madrid",
        "name": "Ribera Solar Plant",
        "sensor_type": "Pyranometer"
    }
}

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "demo_spain"


def generate_scatter_data(df: pl.DataFrame, max_points: int = 2000) -> List[Dict]:
    """Generate scatter plot data for visualization."""
    df_filtered = df.filter(
        (pl.col("irradiance_onsite") > 50) &
        (pl.col("irradiance_openmeteo") > 50)
    )

    if len(df_filtered) > max_points:
        df_filtered = df_filtered.sample(n=max_points, seed=42)

    scatter_data = []
    for row in df_filtered.iter_rows(named=True):
        scatter_data.append({
            "onsite": round(row["irradiance_onsite"], 1),
            "openmeteo": round(row["irradiance_openmeteo"], 1),
            "timestamp": row["timestamp"].isoformat() if hasattr(row["timestamp"], 'isoformat') else str(row["timestamp"])
        })

    return scatter_data


def main(plant_id: str = "alpha1"):
    """Main function to fetch and compare irradiance data."""
    print(f"\n{'='*60}")
    print(f"Open-Meteo Irradiance Comparison - {plant_id.upper()}")
    print(f"{'='*60}\n")

    config = PLANT_CONFIG.get(plant_id)
    if not config:
        print(f"Unknown plant ID: {plant_id}")
        return

    # Set output directory for this plant
    OUTPUT_DIR = BASE_DIR / "public" / "data" / "soiling" / plant_id / "quality"

    # Load on-site data
    print("Loading on-site irradiance data...")
    df_onsite = load_onsite_irradiance(DATA_DIR)

    if df_onsite is None or len(df_onsite) == 0:
        print("No on-site data available")
        # Create placeholder output
        output = {
            "metadata": {
                "plantId": plant_id,
                "generatedAt": datetime.utcnow().isoformat() + "Z",
                "period": {"start": "2024-01-01", "end": "2024-12-31"},
                "location": {
                    "latitude": config["latitude"],
                    "longitude": config["longitude"]
                },
                "onSiteSensorType": config["sensor_type"],
                "openMeteoSource": "ERA5"
            },
            "overallMetrics": {
                "correlation": 0, "rmse": 0, "mae": 0,
                "bias": 0, "biasPct": 0, "r_squared": 0, "sampleCount": 0
            },
            "monthlyMetrics": [],
            "hourlyMetrics": [],
            "alerts": [],
            "scatterData": []
        }

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output_path = OUTPUT_DIR / "irradiance_comparison.json"
        with open(output_path, "w") as f:
            json.dump(output, f, indent=2)
        print(f"Saved placeholder to {output_path}")
        return

    # Get date range
    min_date = df_onsite["timestamp"].min()
    max_date = df_onsite["timestamp"].max()

    # Cap end_date to 7 days ago to avoid Open-Meteo archive API issues
    from datetime import datetime, timedelta
    max_archive_date = datetime.now() - timedelta(days=7)
    if max_date > max_archive_date:
        max_date = max_archive_date

    # Limit to last 2 years to avoid timeout issues
    min_archive_date = max_archive_date - timedelta(days=730)  # 2 years
    if min_date < min_archive_date:
        min_date = min_archive_date

    start_date = min_date.strftime("%Y-%m-%d")
    end_date = max_date.strftime("%Y-%m-%d")

    print(f"On-site data range: {start_date} to {end_date}")
    print(f"Total on-site records: {len(df_onsite)}")

    # Fetch Open-Meteo data
    df_openmeteo = fetch_open_meteo_irradiance(
        latitude=config["latitude"],
        longitude=config["longitude"],
        start_date=start_date,
        end_date=end_date,
        timezone=config["timezone"]
    )

    if df_openmeteo is None or len(df_openmeteo) == 0:
        print("Failed to fetch Open-Meteo data")
        return

    # Compare sources
    print("\nComparing irradiance sources...")
    df_combined, overall_metrics = compare_irradiance_sources(df_onsite, df_openmeteo)

    if len(df_combined) < 100:
        print("Insufficient overlapping data for meaningful comparison")
        return

    print(f"Combined dataset: {len(df_combined)} hourly records")
    print(f"  Correlation: {overall_metrics['correlation']:.4f}")
    print(f"  RMSE: {overall_metrics['rmse']:.2f} W/m²")
    print(f"  Bias: {overall_metrics['bias']:.2f} W/m² ({overall_metrics['biasPct']:.2f}%)")

    # Calculate breakdowns
    print("\nCalculating monthly breakdown...")
    monthly_metrics = generate_monthly_metrics(df_combined)
    print(f"  Generated {len(monthly_metrics)} monthly records")

    print("\nCalculating hourly breakdown...")
    hourly_metrics = generate_hourly_metrics(df_combined)
    print(f"  Generated {len(hourly_metrics)} hourly records")

    # Generate alerts
    print("\nGenerating quality alerts...")
    alerts = generate_irradiance_alerts(overall_metrics, monthly_metrics, hourly_metrics)
    print(f"  Generated {len(alerts)} alerts")

    # Generate scatter data
    print("\nGenerating scatter plot data...")
    scatter_data = generate_scatter_data(df_combined)
    print(f"  Generated {len(scatter_data)} scatter points")

    # Build output
    output = {
        "metadata": {
            "plantId": plant_id,
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "period": {"start": start_date, "end": end_date},
            "location": {
                "latitude": config["latitude"],
                "longitude": config["longitude"]
            },
            "onSiteSensorType": config["sensor_type"],
            "openMeteoSource": "ERA5"
        },
        "overallMetrics": overall_metrics,
        "monthlyMetrics": monthly_metrics,
        "hourlyMetrics": hourly_metrics,
        "alerts": alerts,
        "scatterData": scatter_data
    }

    # Save output
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / "irradiance_comparison.json"

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n{'='*60}")
    print(f"Output saved to: {output_path}")
    print(f"{'='*60}")

    # Summary
    print("\n📊 Summary:")
    print(f"  • Correlation: {overall_metrics['correlation']:.3f}")
    print(f"  • Bias: {overall_metrics['bias']:+.1f} W/m² ({overall_metrics['biasPct']:+.1f}%)")
    print(f"  • Alerts: {len(alerts)}")

    if overall_metrics['correlation'] >= 0.95:
        print("  ✅ Excellent agreement between on-site and Open-Meteo")
    elif overall_metrics['correlation'] >= 0.90:
        print("  ✅ Good agreement between on-site and Open-Meteo")
    elif overall_metrics['correlation'] >= 0.80:
        print("  ⚠️ Moderate agreement - investigate sensor quality")
    else:
        print("  ❌ Poor agreement - sensor issues likely")


if __name__ == "__main__":
    plant_id = sys.argv[1] if len(sys.argv) > 1 else "alpha1"
    main(plant_id)
