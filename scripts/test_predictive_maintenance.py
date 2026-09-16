#!/usr/bin/env python3
"""
Test Predictive Maintenance Pipeline

Runs the full predictive maintenance pipeline on all plants with SCADA data:
1. Compound ML Anomaly Detection
2. Failure Mode Classification
3. RUL Estimation

Outputs per-plant reports to backenddata/predictive_maintenance/

Usage:
    python scripts/test_predictive_maintenance.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.fault.predictive_maintenance import (
    PredictiveMaintenancePipeline,
    PredictiveMaintenanceResult,
    create_pipeline,
)
from nuravolt.fault.features import PlantConfig


# =============================================================================
# Configuration
# =============================================================================

PLANTS = [
    "alpha",
    "ribera",
    "eta",
    "epsilon",
    "gamma",
    "delta",
    "zeta",
]

# Plant rated power (kW AC)
PLANT_RATED_POWER = {
    "alpha": 10000,
    "ribera": 3000,
    "eta": 2500,
    "epsilon": 1500,
    "gamma": 2000,
    "delta": 1500,
    "zeta": 1200,
}

SCADA_BASE = Path("backenddata/scada")
OUTPUT_DIR = Path("backenddata/predictive_maintenance")
MODEL_DIR = Path("models")


# =============================================================================
# Data Loading
# =============================================================================

def load_scada(plant_id: str, days: int = 30) -> pl.DataFrame:
    """Load SCADA data for a plant."""
    scada_dir = SCADA_BASE / plant_id

    if not scada_dir.exists():
        return pl.DataFrame()

    parquet_files = sorted(scada_dir.glob("*.parquet"))

    if not parquet_files:
        return pl.DataFrame()

    # Load most recent files
    dfs = []
    for pf in parquet_files[-days:]:
        try:
            df = pl.read_parquet(pf)
            dfs.append(df)
        except Exception:
            continue

    if not dfs:
        return pl.DataFrame()

    df = pl.concat(dfs, how="diagonal")

    # Normalize timestamp column
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


def get_plant_config(plant_id: str) -> PlantConfig:
    """Create plant configuration."""
    rated_ac = PLANT_RATED_POWER.get(plant_id, 1000)
    rated_dc = rated_ac * 1.2  # Typical DC/AC ratio

    return PlantConfig(
        rated_dc_power_kw=rated_dc,
        rated_ac_power_kw=rated_ac,
    )


# =============================================================================
# Analysis
# =============================================================================

def analyze_plant(
    plant_id: str,
    pipeline: PredictiveMaintenancePipeline,
) -> Optional[PredictiveMaintenanceResult]:
    """Run predictive maintenance analysis on a single plant."""
    print(f"\n{'=' * 60}")
    print(f"Analyzing: {plant_id.upper()}")
    print(f"{'=' * 60}")

    # Load data
    df = load_scada(plant_id, days=30)

    if df.height == 0:
        print(f"  No SCADA data found")
        return None

    print(f"  Data points: {df.height:,}")
    print(f"  Date range: {df['timestamp'].min()} to {df['timestamp'].max()}")
    print(f"  Columns: {len(df.columns)}")

    # Get plant config
    plant_config = get_plant_config(plant_id)
    print(f"  Rated power: {plant_config.rated_ac_power_kw:.0f} kW AC")

    # Update pipeline with plant ID
    pipeline.plant_id = plant_id

    # Run analysis
    try:
        result = pipeline.analyze(df, plant_config)
    except Exception as e:
        print(f"  Error during analysis: {e}")
        import traceback
        traceback.print_exc()
        return None

    # Print summary
    print(f"\n  RESULTS")
    print(f"  {'-' * 40}")
    print(f"  Health Score: {result.health_score:.0f}/100")
    print(f"  Anomalies: {result.anomaly_count}")
    print(f"  Classified Faults: {len(result.classified_faults)}")
    print(f"  RUL Predictions: {len(result.rul_predictions)} fault types")
    print(f"  Priority Actions: {len(result.priority_actions)}")

    if result.fault_distribution:
        print(f"\n  Fault Distribution:")
        for fault_name, count in result.fault_distribution.items():
            print(f"    - {fault_name}: {count}")

    if result.rul_predictions:
        print(f"\n  RUL Predictions:")
        for fault_type, preds in result.rul_predictions.items():
            if preds:
                latest = preds[-1]
                print(f"    - {fault_type}: {latest.days_to_fault:.0f} days (conf: {latest.confidence:.0%})")

    if result.priority_actions:
        print(f"\n  Priority Actions:")
        for action in result.priority_actions[:3]:
            print(f"    - [{action.urgency.upper()}] {action.display_name}: {action.days_to_fault:.0f} days")

    return result


def run_all_plants() -> dict:
    """Run predictive maintenance on all plants."""
    print("\n" + "=" * 70)
    print("PREDICTIVE MAINTENANCE ANALYSIS")
    print("=" * 70)
    print(f"\nModel directory: {MODEL_DIR}")
    print(f"Output directory: {OUTPUT_DIR}")

    # Create pipeline
    pipeline = create_pipeline(
        model_dir=str(MODEL_DIR),
        plant_id="",
    )

    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    plants_dir = OUTPUT_DIR / "plants"
    plants_dir.mkdir(exist_ok=True)

    # Analyze each plant
    all_results = {}

    for plant_id in PLANTS:
        result = analyze_plant(plant_id, pipeline)

        if result:
            all_results[plant_id] = result

            # Save per-plant report
            report_path = plants_dir / f"{plant_id}_pm.md"
            with open(report_path, "w") as f:
                f.write(result.to_markdown())
            print(f"\n  Report saved: {report_path}")

            # Save per-plant JSON
            json_path = plants_dir / f"{plant_id}_pm.json"
            result.to_json(json_path)

    # Generate summary
    generate_summary(all_results)

    return all_results


def generate_summary(results: dict):
    """Generate cross-plant summary."""
    lines = []

    lines.append("# Predictive Maintenance Summary\n")
    lines.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n")

    lines.append("## Cross-Plant Comparison\n")
    lines.append("| Plant | Health | Anomalies | Faults | Priority Actions | Min RUL |")
    lines.append("|-------|--------|-----------|--------|------------------|---------|")

    for plant_id, result in results.items():
        # Find minimum RUL
        min_rul = 365
        for preds in result.rul_predictions.values():
            for p in preds:
                if p.days_to_fault < min_rul:
                    min_rul = p.days_to_fault

        lines.append(
            f"| {plant_id} | "
            f"{result.health_score:.0f}/100 | "
            f"{result.anomaly_count} | "
            f"{len(result.classified_faults)} | "
            f"{len(result.priority_actions)} | "
            f"{min_rul:.0f}d |"
        )

    lines.append("")

    # Health score distribution
    lines.append("## Health Score Distribution\n")

    health_scores = [r.health_score for r in results.values()]
    if health_scores:
        avg_health = sum(health_scores) / len(health_scores)
        min_health = min(health_scores)
        max_health = max(health_scores)

        lines.append(f"- **Average**: {avg_health:.0f}/100")
        lines.append(f"- **Min**: {min_health:.0f}/100")
        lines.append(f"- **Max**: {max_health:.0f}/100")
        lines.append("")

        # Categorize
        critical = sum(1 for h in health_scores if h < 40)
        degraded = sum(1 for h in health_scores if 40 <= h < 60)
        attention = sum(1 for h in health_scores if 60 <= h < 80)
        healthy = sum(1 for h in health_scores if h >= 80)

        lines.append("### Status Distribution")
        lines.append(f"- 🟢 Healthy (≥80): {healthy} plants")
        lines.append(f"- 🟡 Attention (60-80): {attention} plants")
        lines.append(f"- 🟠 Degraded (40-60): {degraded} plants")
        lines.append(f"- 🔴 Critical (<40): {critical} plants")
        lines.append("")

    # Aggregate fault distribution
    lines.append("## Aggregate Fault Distribution\n")

    all_faults = {}
    for result in results.values():
        for fault_name, count in result.fault_distribution.items():
            all_faults[fault_name] = all_faults.get(fault_name, 0) + count

    if all_faults:
        lines.append("| Fault Type | Count |")
        lines.append("|------------|-------|")
        for fault_name, count in sorted(all_faults.items(), key=lambda x: -x[1]):
            lines.append(f"| {fault_name} | {count} |")
        lines.append("")

    # Priority actions across all plants
    lines.append("## All Priority Actions\n")

    all_actions = []
    for plant_id, result in results.items():
        for action in result.priority_actions:
            all_actions.append((plant_id, action))

    # Sort by urgency and days
    urgency_order = {"urgent": 0, "soon": 1, "planned": 2, "monitoring": 3}
    all_actions.sort(key=lambda x: (urgency_order.get(x[1].urgency, 4), x[1].days_to_fault))

    if all_actions:
        lines.append("| Plant | Fault Type | Urgency | Days | Action |")
        lines.append("|-------|------------|---------|------|--------|")
        for plant_id, action in all_actions[:20]:  # Top 20
            urgency_icon = {
                "urgent": "🔴",
                "soon": "🟠",
                "planned": "🟡",
                "monitoring": "🟢",
            }.get(action.urgency, "⚪")
            lines.append(
                f"| {plant_id} | "
                f"{action.display_name} | "
                f"{urgency_icon} {action.urgency} | "
                f"{action.days_to_fault:.0f} | "
                f"{action.recommended_action[:50]}... |"
            )
        lines.append("")

    # Save summary
    summary_path = OUTPUT_DIR / "summary.md"
    with open(summary_path, "w") as f:
        f.write("\n".join(lines))

    print(f"\n{'=' * 70}")
    print("SUMMARY")
    print("=" * 70)
    print(f"\n{'Plant':<15} | {'Health':>8} | {'Anomalies':>10} | {'Faults':>7} | {'Min RUL':>8}")
    print("-" * 60)

    for plant_id, result in results.items():
        min_rul = 365
        for preds in result.rul_predictions.values():
            for p in preds:
                if p.days_to_fault < min_rul:
                    min_rul = p.days_to_fault

        print(
            f"{plant_id:<15} | "
            f"{result.health_score:>6.0f}/100 | "
            f"{result.anomaly_count:>10} | "
            f"{len(result.classified_faults):>7} | "
            f"{min_rul:>6.0f}d"
        )

    print("=" * 60)
    print(f"\nSummary saved: {summary_path}")

    # Save JSON summary
    json_summary = {
        "timestamp": datetime.now().isoformat(),
        "plants_analyzed": len(results),
        "total_anomalies": sum(r.anomaly_count for r in results.values()),
        "total_faults": sum(len(r.classified_faults) for r in results.values()),
        "total_priority_actions": sum(len(r.priority_actions) for r in results.values()),
        "health_scores": {p: r.health_score for p, r in results.items()},
        "fault_distribution": all_faults,
    }

    json_path = OUTPUT_DIR / "summary.json"
    with open(json_path, "w") as f:
        json.dump(json_summary, f, indent=2)

    print(f"JSON summary saved: {json_path}")


# =============================================================================
# Main
# =============================================================================

def main():
    print("\n" + "=" * 70)
    print("PREDICTIVE MAINTENANCE PIPELINE TEST")
    print("=" * 70)

    results = run_all_plants()

    if not results:
        print("\nNo plants analyzed successfully.")
        return 1

    # Summary statistics
    total_anomalies = sum(r.anomaly_count for r in results.values())
    total_faults = sum(len(r.classified_faults) for r in results.values())
    avg_health = sum(r.health_score for r in results.values()) / len(results)

    print(f"\n{'=' * 70}")
    print("ANALYSIS COMPLETE")
    print("=" * 70)
    print(f"  Plants analyzed: {len(results)}")
    print(f"  Total anomalies: {total_anomalies}")
    print(f"  Total faults: {total_faults}")
    print(f"  Average health score: {avg_health:.0f}/100")
    print(f"\n  Reports saved to: {OUTPUT_DIR}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
