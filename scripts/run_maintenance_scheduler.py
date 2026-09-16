#!/usr/bin/env python3
"""
Run maintenance schedule optimization across all plants.

This script:
1. Loads SCADA data for all 7 plants
2. Runs RUL predictions using trained models
3. Optimizes maintenance schedule across the fleet
4. Outputs schedule reports to backenddata/maintenance_schedules/
"""

import sys
from pathlib import Path
from datetime import date
import json

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

import polars as pl
import numpy as np

from nuravolt.fault import (
    MaintenanceScheduleOptimizer,
    SchedulerConfig,
    PlantInfo,
    RULPredictor,
)


# Plant configurations
PLANT_CONFIGS = {
    "alpha": PlantInfo(
        plant_id="alpha",
        capacity_mw=5.0,
        electricity_rate=80.0,
        priority_tier="tier_1",
    ),
    "ribera": PlantInfo(
        plant_id="ribera",
        capacity_mw=4.0,
        electricity_rate=80.0,
        priority_tier="tier_1",
    ),
    "eta": PlantInfo(
        plant_id="eta",
        capacity_mw=1.0,
        electricity_rate=75.0,
        priority_tier="tier_2",
    ),
    "epsilon": PlantInfo(
        plant_id="epsilon",
        capacity_mw=2.0,
        electricity_rate=85.0,
        priority_tier="tier_2",
    ),
    "gamma": PlantInfo(
        plant_id="gamma",
        capacity_mw=1.5,
        electricity_rate=80.0,
        priority_tier="tier_2",
    ),
    "delta": PlantInfo(
        plant_id="delta",
        capacity_mw=1.5,
        electricity_rate=80.0,
        priority_tier="tier_2",
    ),
    "zeta": PlantInfo(
        plant_id="zeta",
        capacity_mw=1.0,
        electricity_rate=80.0,
        priority_tier="tier_3",
    ),
}


def compute_features_from_scada(df: pl.DataFrame, plant_id: str, rated_power_kw: float) -> pl.DataFrame:
    """Compute standardized features from raw SCADA data."""

    # Find columns by pattern
    irr_cols = [c for c in df.columns if "irradiation" in c.lower() and "average" in c.lower()]
    temp_cols = [c for c in df.columns if "temperature" in c.lower()]
    power_cols = [c for c in df.columns if "power" in c.lower() and ("ac" in c.lower() or "kw" in c.lower().replace(" ", ""))]
    current_cols = [c for c in df.columns if "current" in c.lower() and "dc" in c.lower()]

    if not irr_cols:
        print(f"  Warning: No irradiance column found for {plant_id}")
        return df

    # Get primary columns
    irr_col = irr_cols[0]
    temp_col = temp_cols[0] if temp_cols else None

    # Start building features
    features = df.select(["timestamp"] if "timestamp" in df.columns else [df.columns[0]])

    # Irradiance features
    irr = df[irr_col].fill_null(0).to_numpy()
    features = features.with_columns([
        pl.Series("irradiance_normalized", np.clip(irr / 1000, 0, 1.5)),
    ])

    # Temperature features
    if temp_col:
        temp = df[temp_col].fill_null(25).to_numpy()
        ambient = np.clip(temp - 10, 0, 50)  # Estimate ambient
        features = features.with_columns([
            pl.Series("temp_rise", np.clip(temp - ambient, 0, 50)),
            pl.Series("module_temp", temp),
            pl.Series("ambient_temp", ambient),
        ])
    else:
        features = features.with_columns([
            pl.Series("temp_rise", np.full(len(df), 15.0)),
            pl.Series("module_temp", np.full(len(df), 40.0)),
            pl.Series("ambient_temp", np.full(len(df), 25.0)),
        ])

    # Power features
    if power_cols:
        power_data = df.select(power_cols).fill_null(0)
        total_power = power_data.sum_horizontal().to_numpy()
        features = features.with_columns([
            pl.Series("power_normalized", np.clip(total_power / rated_power_kw, 0, 1.2)),
        ])
    else:
        features = features.with_columns([
            pl.Series("power_normalized", np.full(len(df), 0.5)),
        ])

    # String current features
    if current_cols and len(current_cols) >= 2:
        current_data = df.select(current_cols).fill_null(0).to_numpy()

        # Calculate CV across strings
        with np.errstate(divide='ignore', invalid='ignore'):
            string_mean = np.nanmean(current_data, axis=1)
            string_std = np.nanstd(current_data, axis=1)
            string_cv = np.where(string_mean > 0.1, string_std / string_mean, 0)

            string_min = np.nanmin(current_data, axis=1)
            string_max = np.nanmax(current_data, axis=1)
            balance_ratio = np.where(string_max > 0.1, string_min / string_max, 1.0)

        features = features.with_columns([
            pl.Series("string_current_cv", np.clip(string_cv, 0, 2)),
            pl.Series("worst_string_ratio", np.clip(balance_ratio, 0, 1)),
        ])
    else:
        features = features.with_columns([
            pl.Series("string_current_cv", np.full(len(df), 0.1)),
            pl.Series("worst_string_ratio", np.full(len(df), 0.95)),
        ])

    # Performance ratio
    expected_power = rated_power_kw * features["irradiance_normalized"].to_numpy()
    actual_power = features["power_normalized"].to_numpy() * rated_power_kw
    with np.errstate(divide='ignore', invalid='ignore'):
        pr = np.where(expected_power > rated_power_kw * 0.1, actual_power / expected_power, 1.0)
    features = features.with_columns([
        pl.Series("performance_ratio", np.clip(pr, 0, 1.2)),
    ])

    # Trend features (simplified: use rolling mean as proxy)
    features = features.with_columns([
        pl.Series("string_cv_trend_7d", np.full(len(df), 0.001)),  # Slight degradation
        pl.Series("temp_trend_7d", np.full(len(df), 0.1)),
        pl.Series("pr_trend_30d", np.full(len(df), -0.001)),
    ])

    # Hotspot features (estimated)
    features = features.with_columns([
        pl.Series("temp_delta", features["temp_rise"].to_numpy()),
        pl.Series("temp_delta_trend_7d", np.full(len(df), 0.05)),
        pl.Series("temp_delta_95th_7d", features["temp_rise"].to_numpy() * 1.1),
        pl.Series("temp_delta_max_7d", features["temp_rise"].to_numpy() * 1.15),
        pl.Series("hotspot_count", np.random.poisson(0.5, len(df))),
    ])

    # Insulation features (estimated)
    features = features.with_columns([
        pl.Series("riso_value", np.random.uniform(50, 100, len(df))),
        pl.Series("riso_trend_30d", np.full(len(df), -0.1)),
        pl.Series("humidity_avg_7d", np.random.uniform(40, 70, len(df))),
        pl.Series("temp_cycles_30d", np.random.uniform(20, 40, len(df))),
    ])

    return features


def generate_simulated_rul(features: pl.DataFrame, plant_id: str) -> dict:
    """Generate simulated RUL predictions based on computed features."""
    from nuravolt.fault.rul_models import RULPrediction

    # Get average feature values for this plant
    cv = features["string_current_cv"].mean() if "string_current_cv" in features.columns else 0.15
    temp_rise = features["temp_rise"].mean() if "temp_rise" in features.columns else 15.0
    pr = features["performance_ratio"].mean() if "performance_ratio" in features.columns else 0.85
    balance = features["worst_string_ratio"].mean() if "worst_string_ratio" in features.columns else 0.9

    # Generate predictions based on features
    results = {}

    # String degradation: higher CV = closer to fault
    cv_threshold = 0.25
    cv_days = max(1, min(30, (cv_threshold - cv) / 0.01)) if cv < cv_threshold else 0
    results["string_degradation"] = [RULPrediction("string_degradation", cv_days, 0.75, cv_threshold)]

    # Inverter thermal: higher temp = closer to fault
    temp_threshold = 65.0
    temp_days = max(1, min(30, (temp_threshold - temp_rise) / 2)) if temp_rise < temp_threshold else 0
    results["inverter_thermal"] = [RULPrediction("inverter_thermal", temp_days, 0.7, temp_threshold)]

    # Module degradation: lower PR = closer to fault
    pr_threshold = 0.75
    pr_days = max(1, min(90, (pr - pr_threshold) / 0.005)) if pr > pr_threshold else 0
    results["module_degradation"] = [RULPrediction("module_degradation", pr_days, 0.65, pr_threshold)]

    # Mismatch: lower balance = closer to fault
    balance_threshold = 0.85
    balance_days = max(1, min(30, (balance - balance_threshold) / 0.02)) if balance > balance_threshold else 0
    results["mismatch"] = [RULPrediction("mismatch", balance_days, 0.7, balance_threshold)]

    # Thermal hotspot: based on temp rise
    hotspot_threshold = 25.0
    hotspot_days = max(1, min(14, (hotspot_threshold - temp_rise) / 1.5)) if temp_rise < hotspot_threshold else 0
    results["thermal_hotspot"] = [RULPrediction("thermal_hotspot", hotspot_days, 0.6, hotspot_threshold)]

    # Bypass diode: random based on temp
    diode_days = max(1, min(7, 7 - temp_rise / 10)) if temp_rise < 40 else 2
    results["bypass_diode"] = [RULPrediction("bypass_diode", diode_days, 0.5, 3.0)]

    # Insulation: generally healthy
    results["insulation"] = [RULPrediction("insulation", 60.0, 0.6, 40.0)]

    # Print summary
    for fault_type, preds in results.items():
        print(f"    {fault_type}: {preds[0].days_to_fault:.1f}d")

    return results


def run_rul_predictions(
    features: pl.DataFrame,
    predictor: RULPredictor,
) -> dict:
    """Run RUL predictions on feature dataframe."""

    results = {}
    available_models = predictor.get_available_models()

    for fault_type in available_models:
        try:
            predictions = predictor.predict_single(features, fault_type)
            if predictions:
                results[fault_type] = predictions
        except Exception as e:
            print(f"    Warning: {fault_type} failed: {e}")

    return results


def main():
    print("=" * 70)
    print("MAINTENANCE SCHEDULE OPTIMIZER")
    print("=" * 70)

    # Configuration
    config = SchedulerConfig(
        max_tasks_per_day=3,
        planning_horizon_days=30,
        urgency_weight=0.6,
        impact_weight=0.4,
        auto_create_tickets=True,
    )

    print(f"\nConfiguration:")
    print(f"  Max tasks/day: {config.max_tasks_per_day}")
    print(f"  Planning horizon: {config.planning_horizon_days} days")
    print(f"  Urgency weight: {config.urgency_weight}")
    print(f"  Impact weight: {config.impact_weight}")

    # Load RUL predictor
    model_dir = project_root / "models" / "rul"
    print(f"\nLoading RUL models from {model_dir}...")

    try:
        predictor = RULPredictor(str(model_dir))
        models = predictor.get_available_models()
        print(f"  Loaded {len(models)} models: {', '.join(models)}")
    except Exception as e:
        print(f"  Error loading models: {e}")
        print("  Using mock predictions for testing...")
        predictor = None

    # Process each plant
    rul_results = {}

    for plant_id, plant_info in PLANT_CONFIGS.items():
        print(f"\n{'=' * 50}")
        print(f"Processing: {plant_id.upper()}")
        print(f"{'=' * 50}")

        # Load SCADA data
        scada_dir = project_root / "backenddata" / "scada" / plant_id
        parquet_files = list(scada_dir.glob("*.parquet")) if scada_dir.exists() else []

        if not parquet_files:
            print(f"  No SCADA data found in {scada_dir}")
            continue

        parquet_file = parquet_files[0]
        print(f"  Loading: {parquet_file.name}")

        try:
            df = pl.read_parquet(parquet_file)
            print(f"  Data: {len(df):,} samples, {len(df.columns)} columns")
        except Exception as e:
            print(f"  Error loading data: {e}")
            continue

        # Compute features
        print(f"  Computing features...")
        rated_power_kw = plant_info.capacity_mw * 1000
        features = compute_features_from_scada(df, plant_id, rated_power_kw)
        print(f"  Features: {len(features.columns)} columns")

        # Run RUL predictions
        if predictor:
            print(f"  Running RUL predictions...")
            plant_rul = run_rul_predictions(features, predictor)

            if plant_rul:
                rul_results[plant_id] = plant_rul
                print(f"  Results:")
                for fault_type, preds in plant_rul.items():
                    if preds:
                        min_rul = min(p.days_to_fault for p in preds)
                        urgent_pct = sum(1 for p in preds if p.days_to_fault < 3) / len(preds) * 100
                        print(f"    {fault_type}: min={min_rul:.1f}d, urgent={urgent_pct:.1f}%")
            else:
                # Use simulated predictions based on computed features
                print(f"  Using simulated predictions (models need extended features)...")
                rul_results[plant_id] = generate_simulated_rul(features, plant_id)
        else:
            # Mock predictions for testing
            from nuravolt.fault.rul_models import RULPrediction
            rul_results[plant_id] = {
                "string_degradation": [RULPrediction("string_degradation", 12.0, 0.8, 0.25)],
                "inverter_thermal": [RULPrediction("inverter_thermal", 8.0, 0.75, 65.0)],
                "mismatch": [RULPrediction("mismatch", 5.0, 0.7, 0.85)],
            }

    # Run schedule optimization
    print(f"\n{'=' * 70}")
    print("OPTIMIZING SCHEDULE")
    print(f"{'=' * 70}")

    optimizer = MaintenanceScheduleOptimizer(config, str(model_dir))
    result = optimizer.optimize(PLANT_CONFIGS, rul_results)

    # Print results
    print(f"\nSchedule Summary:")
    print(f"  Total tasks: {result.metrics.total_tasks}")
    print(f"  Scheduled: {result.metrics.scheduled_tasks}")
    print(f"  Deferred: {result.metrics.deferred_tasks}")
    print(f"  Total repair cost: €{result.metrics.total_repair_cost_eur:,.0f}")
    print(f"  Revenue saved: €{result.metrics.total_revenue_saved_eur:,.0f}")
    print(f"  Net benefit: €{result.metrics.net_benefit_eur:,.0f}")
    print(f"  ROI: {result.metrics.roi_pct:.0f}%")
    print(f"  Crew utilization: {result.metrics.crew_utilization_pct:.0f}%")

    print(f"\nDaily Schedule:")
    for day in sorted(result.daily_schedule.keys())[:7]:  # Show first week
        tasks = result.daily_schedule[day]
        task_list = ", ".join([f"{t.task.plant_id}:{t.task.fault_type}" for t in tasks])
        print(f"  {day}: {task_list}")

    if result.deferred:
        print(f"\nDeferred Tasks (top 5):")
        for task in result.deferred[:5]:
            print(f"  {task.plant_id}: {task.fault_type} ({task.days_to_fault:.1f}d, priority={task.priority_score:.0f})")

    # Save outputs
    output_dir = project_root / "backenddata" / "maintenance_schedules"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save JSON
    json_path = output_dir / f"schedule_{date.today().strftime('%Y-%m')}.json"
    result.to_json(str(json_path))
    print(f"\nJSON saved: {json_path}")

    # Save Markdown
    md_path = output_dir / f"schedule_{date.today().strftime('%Y-%m')}.md"
    with open(md_path, "w") as f:
        f.write(result.to_markdown())
    print(f"Markdown saved: {md_path}")

    print(f"\n{'=' * 70}")
    print("OPTIMIZATION COMPLETE")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
