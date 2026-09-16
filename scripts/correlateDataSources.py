#!/usr/bin/env python3
"""
Data Source Correlation Analysis.

This is an entry point script that imports core logic from nuravolt.soiling.data_quality.

Usage:
    python scripts/correlateDataSources.py [plant_id]
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import polars as pl

from nuravolt.soiling.data_quality.correlation_analysis import (
    CV_THRESHOLD,
    MIN_SAMPLES,
    analyze_data_source_correlation,
    analyze_seasonal_patterns,
    analyze_time_patterns,
    calculate_zone_correlations,
    generate_recommendations,
)

# ============================================================================
# Configuration
# ============================================================================

PLANT_CONFIG = {
    "alpha1": {
        "zones": ["INV 01", "INV 02", "INV 03", "INV 04", "INV 05"],
        "latitude": 37.8145,
        "longitude": -3.8047
    },
    "eta": {
        "zones": ["INV 01A", "INV 01B"],
        "latitude": 38.6623,
        "longitude": -5.392
    },
    "ribera": {
        "zones": ["INV 01", "INV 02", "INV 03", "INV 04"],
        "latitude": 37.9271,
        "longitude": -1.2331
    }
}

BASE_DIR = Path(__file__).parent.parent


def load_zone_pr_data(plant_id: str = "alpha1") -> Optional[pl.DataFrame]:
    """Load zone-level performance ratio data from spatial_uniformity.json."""
    quality_dir = BASE_DIR / "public" / "data" / "soiling" / plant_id / "quality"
    spatial_json = quality_dir / "spatial_uniformity.json"

    if spatial_json.exists():
        with open(spatial_json) as f:
            data = json.load(f)

        if data.get("timeSeries") and len(data["timeSeries"]) > 0:
            time_series = data["timeSeries"]
            zones = data["metadata"].get("zones", [])

            records = []
            for entry in time_series:
                record = {
                    "timestamp": entry["timestamp"],
                    "cv": entry.get("coefficientOfVariation", entry.get("cv", 0)),
                    "isUniform": entry.get("isUniform", True)
                }
                zone_prs = entry.get("zonePRs", {})
                for zone in zones:
                    record[f"pr_{zone}"] = zone_prs.get(zone, None)
                records.append(record)

            df = pl.DataFrame(records)
            df = df.with_columns(
                pl.col("timestamp").str.to_datetime().alias("timestamp")
            )

            print(f"Loaded {len(df)} records from spatial_uniformity.json")
            return df

    print("No spatial uniformity data available")
    return None


def load_irradiance_data(plant_id: str = "alpha1") -> Optional[pl.DataFrame]:
    """Load irradiance comparison data."""
    quality_dir = BASE_DIR / "public" / "data" / "soiling" / plant_id / "quality"
    irradiance_json = quality_dir / "irradiance_comparison.json"

    if not irradiance_json.exists():
        print("No irradiance comparison data available")
        return None

    with open(irradiance_json) as f:
        data = json.load(f)

    scatter_data = data.get("scatterData", [])

    if not scatter_data:
        print("No scatter data in irradiance comparison")
        return None

    df = pl.DataFrame(scatter_data)

    if "timestamp" in df.columns:
        df = df.with_columns(
            pl.col("timestamp").str.to_datetime().alias("timestamp")
        )

    df = df.rename({
        "onsite": "irradiance_onsite",
        "openmeteo": "irradiance_openmeteo"
    })

    print(f"Loaded {len(df)} irradiance comparison records")
    return df


def main(plant_id: str = "alpha1"):
    """Main function to analyze data source correlations."""
    print(f"\n{'='*60}")
    print(f"Data Source Correlation Analysis - {plant_id.upper()}")
    print(f"{'='*60}\n")

    config = PLANT_CONFIG.get(plant_id)
    if not config:
        print(f"Unknown plant ID: {plant_id}")
        return

    zones = config["zones"]

    # Set output directory for this plant
    OUTPUT_DIR = BASE_DIR / "public" / "data" / "soiling" / plant_id / "quality"

    # Load data
    print("Loading zone PR data...")
    df_pr = load_zone_pr_data(plant_id)

    print("Loading irradiance comparison data...")
    df_irr = load_irradiance_data(plant_id)

    # Initialize output structure
    output = {
        "metadata": {
            "plantId": plant_id,
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "period": {"start": "2024-01-01", "end": "2024-12-31"},
            "cvThreshold": CV_THRESHOLD,
            "minSampleSize": MIN_SAMPLES
        },
        "overallAnalysis": {
            "uniformPeriods": {"count": 0, "zoneCorrelations": []},
            "nonUniformPeriods": {"count": 0, "zoneCorrelations": []}
        },
        "conditionalAnalysis": [],
        "patterns": [],
        "recommendations": []
    }

    # Check if we have data
    if df_pr is None or df_irr is None:
        print("Insufficient data for correlation analysis")
        output["recommendations"] = [
            "Insufficient data available. Run spatial uniformity and irradiance comparison scripts first."
        ]

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output_path = OUTPUT_DIR / "data_source_correlation.json"

        with open(output_path, "w") as f:
            json.dump(output, f, indent=2)

        print(f"Saved placeholder to {output_path}")
        return

    # Update period from actual data
    min_date = df_pr["timestamp"].min()
    max_date = df_pr["timestamp"].max()
    output["metadata"]["period"]["start"] = min_date.strftime("%Y-%m-%d")
    output["metadata"]["period"]["end"] = max_date.strftime("%Y-%m-%d")

    # Analyze overall correlations
    print("\nAnalyzing zone correlations...")
    overall_corrs = calculate_zone_correlations(df_pr, df_irr, zones)

    if overall_corrs:
        print(f"  Found correlations for {len(overall_corrs)} zones")
        for zc in overall_corrs:
            print(f"    {zc['zoneId']}: on-site={zc['onSiteCorrelation']:.3f}, "
                  f"Open-Meteo={zc['openMeteoCorrelation']:.3f} → {zc['betterSource']}")

    # Analyze conditional correlations
    print("\nAnalyzing conditional correlations...")
    overall_analysis = analyze_data_source_correlation(df_pr, df_irr, zones)
    output["overallAnalysis"] = overall_analysis

    print(f"  Uniform periods: {overall_analysis['uniformPeriods']['count']}")
    print(f"  Non-uniform periods: {overall_analysis['nonUniformPeriods']['count']}")

    # Analyze time patterns
    print("\nAnalyzing time-of-day patterns...")
    time_patterns = analyze_time_patterns(df_pr, df_irr, zones)
    print(f"  Found {len(time_patterns)} time patterns")

    # Analyze seasonal patterns
    print("\nAnalyzing seasonal patterns...")
    seasonal_patterns = analyze_seasonal_patterns(df_pr, df_irr, zones)
    print(f"  Found {len(seasonal_patterns)} seasonal patterns")

    # Combine patterns
    all_patterns = time_patterns + seasonal_patterns
    output["patterns"] = all_patterns

    # Add conditional analysis summary
    output["conditionalAnalysis"] = [
        {
            "condition": "uniform",
            "description": "CV < 0.10 - spatially uniform irradiance conditions",
            "sampleCount": overall_analysis["uniformPeriods"]["count"],
            "zoneCorrelations": overall_analysis["uniformPeriods"]["zoneCorrelations"]
        },
        {
            "condition": "nonUniform",
            "description": "CV >= 0.10 - partial clouds or localized effects",
            "sampleCount": overall_analysis["nonUniformPeriods"]["count"],
            "zoneCorrelations": overall_analysis["nonUniformPeriods"]["zoneCorrelations"]
        }
    ]

    # Generate recommendations
    print("\nGenerating recommendations...")
    recommendations = generate_recommendations(overall_analysis, time_patterns, seasonal_patterns)
    output["recommendations"] = recommendations

    for rec in recommendations:
        print(f"  • {rec}")

    # Save output
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / "data_source_correlation.json"

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n{'='*60}")
    print(f"Output saved to: {output_path}")
    print(f"{'='*60}")

    # Summary
    print("\n📊 Summary:")
    print(f"  • Analyzed {len(zones)} zones")
    print(f"  • Found {len(all_patterns)} correlation patterns")
    print(f"  • Generated {len(recommendations)} recommendations")


if __name__ == "__main__":
    plant_id = sys.argv[1] if len(sys.argv) > 1 else "alpha1"
    main(plant_id)
