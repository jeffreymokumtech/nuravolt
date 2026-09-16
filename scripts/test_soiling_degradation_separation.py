#!/usr/bin/env python3
"""
Test Soiling vs Degradation Separation

Runs the SoilingDegradationSeparator on all plants with DustIQ data
and outputs analysis results to soilingexperiments/.

Usage:
    python scripts/test_soiling_degradation_separation.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.soiling_degradation_separator import (
    SoilingDegradationSeparator,
    RecoveryEventDetector,
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

DUSTIQ_BASE = Path("public/data/soiling")
OUTPUT_BASE = Path("soilingexperiments")

# Valid SR range
SR_MIN = 0.70
SR_MAX = 1.02


def load_dustiq(plant_id: str) -> tuple:
    """Load DustIQ data for a plant."""
    dustiq_path = DUSTIQ_BASE / plant_id / "dustiq_history.json"

    if not dustiq_path.exists():
        return None, None

    with open(dustiq_path) as f:
        data = json.load(f)

    daily = data.get("daily_data", [])
    if not daily:
        return None, None

    df = pl.DataFrame(daily)

    # Get SR column
    sr_col = "sr_dustiq" if "sr_dustiq" in df.columns else "soiling_ratio"

    # Clean data
    df = df.filter(
        (pl.col(sr_col) >= SR_MIN) &
        (pl.col(sr_col) <= SR_MAX)
    ).sort("date")

    dates = df["date"].to_numpy()
    sr_values = df[sr_col].to_numpy()

    return dates, sr_values


def analyze_plant(plant_id: str) -> dict:
    """Analyze a single plant."""
    print(f"\n{'='*60}")
    print(f"Analyzing: {plant_id.upper()}")
    print(f"{'='*60}")

    dates, sr_values = load_dustiq(plant_id)

    if dates is None or len(dates) < 30:
        print(f"  Insufficient data")
        return {"plant_id": plant_id, "status": "insufficient_data"}

    print(f"  Data points: {len(dates)}")
    print(f"  Date range: {dates[0]} to {dates[-1]}")
    print(f"  SR range: {sr_values.min():.4f} - {sr_values.max():.4f}")

    # Run separator
    separator = SoilingDegradationSeparator(plant_id)

    try:
        result = separator.analyze(
            sr_daily=sr_values,
            dates=dates,
            precipitation=None,  # No precipitation data available
        )
    except Exception as e:
        print(f"  Error: {e}")
        return {"plant_id": plant_id, "status": "error", "error": str(e)}

    # Print summary
    print(f"\n  Results:")
    print(f"    Soiling rate: {result.soiling_rate_pct_per_week:.4f}%/week")
    print(f"    Degradation rate: {result.degradation_rate_pct_per_year:.4f}%/year")
    print(f"    Rain events: {result.n_rain_events}")
    print(f"    Cleaning events: {result.n_cleaning_events}")
    print(f"    Confidence: {result.confidence:.1%}")
    print(f"    Method: {result.method_used}")

    # Generate report
    report = separator.generate_report(result)

    # Save report
    output_path = OUTPUT_BASE / "plants" / f"{plant_id}_soiling_degradation.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write(report)
    print(f"\n  Report saved: {output_path}")

    return {
        "plant_id": plant_id,
        "status": "ok",
        "soiling_rate_pct_per_week": result.soiling_rate_pct_per_week,
        "degradation_rate_pct_per_year": result.degradation_rate_pct_per_year,
        "n_rain_events": result.n_rain_events,
        "n_cleaning_events": result.n_cleaning_events,
        "confidence": result.confidence,
        "method": result.method_used,
        "n_years": result.n_years_analyzed,
    }


def generate_summary(all_results: list) -> str:
    """Generate summary report."""
    lines = []
    lines.append("# Soiling vs Degradation Analysis - Summary\n")
    lines.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*\n")

    lines.append("## Cross-Plant Comparison\n")
    lines.append("| Plant | Years | Soiling (%/wk) | Degradation (%/yr) | Events | Confidence |")
    lines.append("|-------|-------|----------------|--------------------| -------|------------|")

    for r in all_results:
        if r.get("status") != "ok":
            lines.append(f"| {r['plant_id']} | - | - | - | - | {r.get('status', 'error')} |")
            continue

        events = r.get("n_rain_events", 0) + r.get("n_cleaning_events", 0)
        lines.append(
            f"| {r['plant_id']} | {r['n_years']:.1f} | "
            f"{r['soiling_rate_pct_per_week']:.3f} | "
            f"{r['degradation_rate_pct_per_year']:.3f} | "
            f"{events} | {r['confidence']:.0%} |"
        )

    lines.append("")

    # Rankings
    valid_results = [r for r in all_results if r.get("status") == "ok"]

    if valid_results:
        lines.append("## Rankings\n")

        # Highest soiling
        by_soiling = sorted(valid_results, key=lambda x: x["soiling_rate_pct_per_week"], reverse=True)
        lines.append("### Highest Soiling Rate")
        lines.append(f"1. **{by_soiling[0]['plant_id']}**: {by_soiling[0]['soiling_rate_pct_per_week']:.3f}%/week")
        if len(by_soiling) > 1:
            lines.append(f"2. {by_soiling[1]['plant_id']}: {by_soiling[1]['soiling_rate_pct_per_week']:.3f}%/week")
        lines.append("")

        # Highest degradation
        by_deg = sorted(valid_results, key=lambda x: x["degradation_rate_pct_per_year"], reverse=True)
        lines.append("### Highest Degradation Rate")
        lines.append(f"1. **{by_deg[0]['plant_id']}**: {by_deg[0]['degradation_rate_pct_per_year']:.3f}%/year")
        if len(by_deg) > 1:
            lines.append(f"2. {by_deg[1]['plant_id']}: {by_deg[1]['degradation_rate_pct_per_year']:.3f}%/year")
        lines.append("")

        # Cleanest
        by_clean = sorted(valid_results, key=lambda x: x["soiling_rate_pct_per_week"])
        lines.append("### Cleanest Plants (Lowest Soiling)")
        lines.append(f"1. **{by_clean[0]['plant_id']}**: {by_clean[0]['soiling_rate_pct_per_week']:.3f}%/week")
        if len(by_clean) > 1:
            lines.append(f"2. {by_clean[1]['plant_id']}: {by_clean[1]['soiling_rate_pct_per_week']:.3f}%/week")
        lines.append("")

    lines.append("## Interpretation Guide\n")
    lines.append("""
### Soiling Rate (%/week)
| Rate | Interpretation |
|------|----------------|
| < 0.2% | Very low (frequent rain or clean environment) |
| 0.2-0.5% | Low (typical temperate climate) |
| 0.5-1.0% | Moderate (semi-arid or industrial) |
| 1.0-2.0% | High (arid climate) |
| > 2.0% | Very high (desert or heavy pollution) |

### Degradation Rate (%/year)
| Rate | Interpretation |
|------|----------------|
| < 0.3% | Excellent (below industry average) |
| 0.3-0.6% | Good (industry average ~0.5%) |
| 0.6-1.0% | Moderate (slightly elevated) |
| > 1.0% | High (investigate PID, hotspots, etc.) |
""")

    lines.append("## Methodology\n")
    lines.append("""
The separation uses multiple approaches:

1. **Recovery Event Detection**: Sharp SR increases indicate rain or cleaning
2. **Year-over-Year Trending**: Systematic annual decline = degradation
3. **Post-Cleaning Baseline**: SR after cleaning should only decline by degradation

Key insight: **Soiling recovers after rain/cleaning, degradation doesn't.**
""")

    return "\n".join(lines)


def main():
    """Run separation analysis on all plants."""
    print("\n" + "="*70)
    print("SOILING VS DEGRADATION SEPARATION ANALYSIS")
    print("="*70)

    all_results = []

    for plant_id in PLANTS:
        result = analyze_plant(plant_id)
        all_results.append(result)

    # Generate summary
    print("\n" + "="*70)
    print("Generating summary...")

    summary = generate_summary(all_results)
    summary_path = OUTPUT_BASE / "soiling_degradation_summary.md"
    with open(summary_path, "w") as f:
        f.write(summary)
    print(f"Summary saved: {summary_path}")

    # Print final summary table
    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"{'Plant':<15} | {'Soiling %/wk':<12} | {'Degradation %/yr':<16} | {'Confidence':<10}")
    print("-" * 60)

    for r in all_results:
        if r.get("status") == "ok":
            print(
                f"{r['plant_id']:<15} | "
                f"{r['soiling_rate_pct_per_week']:<12.4f} | "
                f"{r['degradation_rate_pct_per_year']:<16.4f} | "
                f"{r['confidence']:<10.0%}"
            )
        else:
            print(f"{r['plant_id']:<15} | {'N/A':<12} | {'N/A':<16} | {r.get('status', 'error')}")

    print("\n" + "="*70)
    print("ANALYSIS COMPLETE")
    print("="*70)


if __name__ == "__main__":
    main()
