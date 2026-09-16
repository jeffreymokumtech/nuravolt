"""
BESS Demo Data Generator

Generates realistic synthetic BESS data for development and demos.

Scenarios:
1. 'healthy' - New battery, within warranty
2. 'degrading' - 3-year-old, approaching threshold
3. 'stressed' - Multiple warranty violations
4. 'fleet' - Multi-asset with varying health

Usage:
    python scripts/generate_bess_demo_data.py --output public/data/bess/
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any
import argparse
import math


def generate_soh_history(
    installation_date: datetime,
    current_date: datetime,
    chemistry: str = "lfp",
    usage_intensity: str = "normal"  # 'light', 'normal', 'heavy'
) -> List[Dict[str, Any]]:
    """Generate historical SoH data showing degradation."""

    # Chemistry-specific degradation rates
    degradation_rates = {
        "lfp": {"base": 0.015, "calendar": 0.012, "cyclic": 0.00003},
        "nmc": {"base": 0.020, "calendar": 0.018, "cyclic": 0.00005},
        "nca": {"base": 0.025, "calendar": 0.020, "cyclic": 0.00006},
    }

    usage_multipliers = {"light": 0.7, "normal": 1.0, "heavy": 1.4}

    rates = degradation_rates.get(chemistry, degradation_rates["nmc"])
    multiplier = usage_multipliers.get(usage_intensity, 1.0)

    history = []
    current = installation_date
    soh = 1.0
    cycles = 0

    while current <= current_date:
        # Monthly data points
        years_elapsed = (current - installation_date).days / 365.25

        # Calendar aging
        calendar_loss = rates["calendar"] * years_elapsed * multiplier

        # Cyclic aging (estimate cycles from time)
        cycles_per_year = 365 * (1.0 if usage_intensity == "normal" else
                                 0.7 if usage_intensity == "light" else 1.5)
        cycles = years_elapsed * cycles_per_year
        cyclic_loss = rates["cyclic"] * cycles * multiplier

        # Total degradation with some noise
        soh = 1.0 - calendar_loss - cyclic_loss
        soh = max(0.5, soh + random.gauss(0, 0.005))  # Add noise

        history.append({
            "date": current.strftime("%Y-%m-%d"),
            "soh": round(soh, 4),
            "source": "capacity_test" if random.random() < 0.1 else "estimated",
            "cumulative_cycles": round(cycles, 1),
        })

        current += timedelta(days=30)

    return history


def generate_cycling_metrics(
    start_date: datetime,
    end_date: datetime,
    capacity_kwh: float,
    usage_intensity: str = "normal"
) -> List[Dict[str, Any]]:
    """Generate daily cycling metrics."""

    base_cycles_per_day = {"light": 0.5, "normal": 1.0, "heavy": 2.0}
    base = base_cycles_per_day.get(usage_intensity, 1.0)

    metrics = []
    current = start_date
    cumulative_cycles = 0
    cumulative_throughput = 0

    while current <= end_date:
        # Daily variation
        daily_cycles = max(0, base + random.gauss(0, 0.3))

        # Weekend reduction
        if current.weekday() >= 5:
            daily_cycles *= 0.6

        # Energy calculations
        avg_dod = 0.6 + random.gauss(0, 0.1)
        avg_dod = max(0.3, min(0.9, avg_dod))

        energy_throughput = daily_cycles * capacity_kwh * 2 * avg_dod
        cumulative_cycles += daily_cycles
        cumulative_throughput += energy_throughput

        # Round-trip efficiency
        base_rte = 0.88 + random.gauss(0, 0.02)
        rte = max(0.82, min(0.95, base_rte))

        metrics.append({
            "date": current.strftime("%Y-%m-%d"),
            "equivalent_cycles": round(daily_cycles, 3),
            "cumulative_cycles": round(cumulative_cycles, 1),
            "energy_in_kwh": round(energy_throughput / 2, 1),
            "energy_out_kwh": round(energy_throughput / 2 * rte, 1),
            "avg_dod": round(avg_dod, 3),
            "avg_c_rate": round(0.3 + random.gauss(0, 0.1), 2),
            "max_c_rate": round(0.6 + random.gauss(0, 0.15), 2),
            "avg_temp_c": round(25 + random.gauss(0, 3), 1),
            "max_temp_c": round(30 + random.gauss(0, 4), 1),
            "round_trip_efficiency": round(rte, 3),
            "high_soc_hours": round(max(0, random.gauss(2, 1)), 1),
            "high_temp_hours": round(max(0, random.gauss(0.5, 0.3)), 1),
        })

        current += timedelta(days=1)

    return metrics


def generate_violations(
    scenario: str,
    start_date: datetime,
    end_date: datetime
) -> List[Dict[str, Any]]:
    """Generate warranty violations based on scenario."""

    violations = []

    if scenario == "healthy":
        # No violations for healthy battery
        return []

    if scenario in ["degrading", "stressed"]:
        # Generate some temperature events
        n_temp_events = 2 if scenario == "degrading" else 6
        for i in range(n_temp_events):
            event_date = start_date + timedelta(days=random.randint(30, 300))
            duration = random.randint(20, 90)
            max_temp = 36 + random.gauss(0, 2)

            violations.append({
                "id": f"viol-temp-{i+1}",
                "type": "TEMPERATURE_EXCEED",
                "severity": "warning" if max_temp < 40 else "critical",
                "started_at": event_date.isoformat(),
                "ended_at": (event_date + timedelta(minutes=duration)).isoformat(),
                "duration_minutes": duration,
                "measured_value": round(max_temp, 1),
                "threshold_value": 35.0,
                "unit": "°C",
                "description": f"Temperature exceeded 35°C for {duration} minutes. Max: {max_temp:.1f}°C",
                "is_resolved": True,
            })

    if scenario == "stressed":
        # Add high SoC dwelling events
        for i in range(3):
            event_date = start_date + timedelta(days=random.randint(60, 250))
            duration_hours = random.randint(48, 120)

            violations.append({
                "id": f"viol-soc-{i+1}",
                "type": "SOC_HIGH_DWELL",
                "severity": "warning" if duration_hours < 72 else "critical",
                "started_at": event_date.isoformat(),
                "ended_at": (event_date + timedelta(hours=duration_hours)).isoformat(),
                "duration_minutes": duration_hours * 60,
                "measured_value": 0.97,
                "threshold_value": 0.95,
                "unit": "%",
                "description": f"Battery at >95% SoC for {duration_hours:.0f} hours. Warranty risk.",
                "is_resolved": True,
            })

        # Add C-rate violation
        violations.append({
            "id": "viol-crate-1",
            "type": "C_RATE_EXCEED",
            "severity": "warning",
            "started_at": (start_date + timedelta(days=180)).isoformat(),
            "ended_at": (start_date + timedelta(days=180, minutes=25)).isoformat(),
            "duration_minutes": 25,
            "measured_value": 1.15,
            "threshold_value": 1.0,
            "unit": "C",
            "description": "C-rate exceeded 1.0C for 25 minutes. Max: 1.15C",
            "is_resolved": True,
        })

    return violations


def generate_capacity_tests(
    installation_date: datetime,
    current_date: datetime,
    nominal_capacity_kwh: float,
    scenario: str
) -> List[Dict[str, Any]]:
    """Generate capacity test history."""

    tests = []
    current = installation_date + timedelta(days=90)  # First test after 90 days

    # SoH trajectory based on scenario
    soh_start = 1.0
    soh_end = {
        "healthy": 0.98,
        "degrading": 0.82,
        "stressed": 0.75,
    }.get(scenario, 0.90)

    test_num = 0
    while current <= current_date:
        test_num += 1

        # Linear interpolation with noise
        progress = (current - installation_date).days / (current_date - installation_date).days
        soh = soh_start - (soh_start - soh_end) * progress
        soh = max(0.5, soh + random.gauss(0, 0.01))

        measured_capacity = nominal_capacity_kwh * soh

        tests.append({
            "id": f"test-{test_num}",
            "test_date": current.isoformat(),
            "measured_capacity_kwh": round(measured_capacity, 1),
            "soh_result": round(soh, 4),
            "capacity_retention": round(soh, 4),
            "test_type": "standard",
            "ambient_temp_c": round(22 + random.gauss(0, 2), 1),
            "c_rate_used": 0.2,
            "is_valid": True,
        })

        current += timedelta(days=90)  # Quarterly tests

    return tests


def generate_dispatch_schedule(
    date: datetime,
    capacity_kwh: float,
    power_kw: float
) -> Dict[str, Any]:
    """Generate a 24-hour optimized dispatch schedule."""

    # Typical price profile (low at night, peaks during day)
    base_prices = [
        30, 28, 25, 23, 22, 24,  # 0-5
        35, 55, 75, 80, 70, 65,  # 6-11
        60, 58, 62, 85, 95, 90,  # 12-17
        75, 65, 55, 45, 40, 35,  # 18-23
    ]

    prices = [p + random.gauss(0, 5) for p in base_prices]

    # Generate schedules
    charge_schedule = []
    discharge_schedule = []
    soc_schedule = [0.5]  # Start at 50%

    current_soc = 0.5

    for hour in range(24):
        price = prices[hour]

        # Simple rule: charge when cheap, discharge when expensive
        if price < 35:  # Low price - charge
            charge_power = -power_kw * 0.8
            discharge_power = 0
            soc_change = (power_kw * 0.8 * 0.95) / capacity_kwh  # Charge
        elif price > 70:  # High price - discharge
            charge_power = 0
            discharge_power = power_kw * 0.8
            soc_change = -(power_kw * 0.8) / (capacity_kwh * 0.95)  # Discharge
        else:
            charge_power = 0
            discharge_power = 0
            soc_change = 0

        # Apply SoC limits
        new_soc = current_soc + soc_change
        if new_soc > 0.9:
            charge_power = 0
            new_soc = current_soc
        if new_soc < 0.1:
            discharge_power = 0
            new_soc = current_soc

        charge_schedule.append(round(charge_power, 1))
        discharge_schedule.append(round(discharge_power, 1))
        soc_schedule.append(round(new_soc, 3))
        current_soc = new_soc

    # Calculate economics
    revenue = sum(d * p / 1000 for d, p in zip(discharge_schedule, prices) if d > 0)
    cost = sum(-c * p / 1000 for c, p in zip(charge_schedule, prices) if c < 0)
    gross_revenue = revenue - cost

    # Degradation cost estimate
    total_throughput = sum(abs(c) + d for c, d in zip(charge_schedule, discharge_schedule))
    degradation_cost = total_throughput * 0.005  # EUR 0.005/kWh

    return {
        "schedule_date": date.strftime("%Y-%m-%d"),
        "horizon_hours": 24,
        "resolution_minutes": 60,
        "charge_schedule_kw": charge_schedule,
        "discharge_schedule_kw": discharge_schedule,
        "soc_schedule": soc_schedule[:-1],  # Exclude final state
        "price_forecast": [round(p, 2) for p in prices],
        "expected_revenue_eur": round(gross_revenue, 2),
        "degradation_cost_eur": round(degradation_cost, 2),
        "net_revenue_eur": round(gross_revenue - degradation_cost, 2),
        "optimizer_type": "degradation_aware_greedy",
        "status": "optimal",
        "expected_cycles": round(total_throughput / (2 * capacity_kwh), 3),
    }


def calculate_warranty_health_score(
    current_soh: float,
    warranty_threshold: float,
    cycles_used: float,
    max_cycles: int,
    years_elapsed: float,
    warranty_years: int,
    n_violations: int
) -> Dict[str, Any]:
    """Calculate composite warranty health score."""

    # Component scores (0-100)
    soh_margin = current_soh - warranty_threshold
    soh_score = min(100, max(0, (soh_margin / 0.30) * 100))

    cycle_usage = cycles_used / max_cycles
    cycle_score = min(100, max(0, (1 - cycle_usage) * 100))

    time_usage = years_elapsed / warranty_years
    time_score = min(100, max(0, (1 - time_usage) * 100))

    efficiency_score = 85  # Assume good efficiency

    violations_score = max(0, 100 - n_violations * 15)

    # Weighted composite
    composite = int(
        soh_score * 0.30 +
        cycle_score * 0.25 +
        time_score * 0.15 +
        efficiency_score * 0.15 +
        violations_score * 0.15
    )

    # Risk level
    if composite >= 80:
        risk_level = "LOW"
    elif composite >= 60:
        risk_level = "MODERATE"
    elif composite >= 40:
        risk_level = "HIGH"
    else:
        risk_level = "CRITICAL"

    # Generate risk factors
    risk_factors = []
    if soh_margin < 0.10:
        risk_factors.append(f"SoH margin only {soh_margin:.1%} above warranty threshold")
    if cycle_usage > 0.80:
        risk_factors.append(f"Cycle usage at {cycle_usage:.0%} of warranty limit")
    if n_violations > 2:
        risk_factors.append(f"{n_violations} warranty violations recorded")

    # Recommendation
    if risk_level == "LOW":
        recommendation = "OK: Operating within warranty parameters."
    elif risk_level == "MODERATE":
        recommendation = "ADVISORY: Monitor operating conditions. Consider reducing cycle depth."
    elif risk_level == "HIGH":
        recommendation = "WARNING: Approaching warranty limits. Reduce usage intensity."
    else:
        recommendation = "CRITICAL: Near warranty threshold. Document operations for potential claim."

    return {
        "score": composite,
        "risk_level": risk_level,
        "component_scores": {
            "soh": int(soh_score),
            "cycles": int(cycle_score),
            "time": int(time_score),
            "efficiency": efficiency_score,
            "violations": violations_score,
        },
        "current_soh": current_soh,
        "warranty_threshold": warranty_threshold,
        "soh_margin": round(soh_margin, 4),
        "cycles_used": cycles_used,
        "cycles_remaining": max_cycles - cycles_used,
        "years_remaining": round(warranty_years - years_elapsed, 1),
        "risk_factors": risk_factors,
        "recommendation": recommendation,
    }


def generate_bess_plant_data(
    plant_id: str,
    plant_name: str,
    scenario: str,
    output_dir: Path
):
    """Generate all demo data for a BESS plant."""

    output_dir.mkdir(parents=True, exist_ok=True)

    # Configuration based on scenario
    scenarios = {
        "healthy": {
            "installation_date": datetime(2024, 6, 1),
            "chemistry": "lfp",
            "usage": "normal",
            "capacity_kwh": 2000,
            "power_kw": 1000,
            "warranty_years": 10,
            "max_cycles": 5000,
        },
        "degrading": {
            "installation_date": datetime(2021, 3, 1),
            "chemistry": "nmc",
            "usage": "heavy",
            "capacity_kwh": 4000,
            "power_kw": 2000,
            "warranty_years": 10,
            "max_cycles": 4000,
        },
        "stressed": {
            "installation_date": datetime(2020, 1, 1),
            "chemistry": "nmc",
            "usage": "heavy",
            "capacity_kwh": 3000,
            "power_kw": 1500,
            "warranty_years": 10,
            "max_cycles": 4000,
        },
    }

    config = scenarios.get(scenario, scenarios["healthy"])
    current_date = datetime.now()
    years_elapsed = (current_date - config["installation_date"]).days / 365.25

    # Generate SoH history
    soh_history = generate_soh_history(
        installation_date=config["installation_date"],
        current_date=current_date,
        chemistry=config["chemistry"],
        usage_intensity=config["usage"],
    )
    current_soh = soh_history[-1]["soh"] if soh_history else 1.0

    # Generate cycling metrics (last 90 days)
    cycling_start = current_date - timedelta(days=90)
    cycling_metrics = generate_cycling_metrics(
        start_date=cycling_start,
        end_date=current_date,
        capacity_kwh=config["capacity_kwh"],
        usage_intensity=config["usage"],
    )
    total_cycles = cycling_metrics[-1]["cumulative_cycles"] if cycling_metrics else 0

    # Scale cycles based on years
    total_cycles = total_cycles * (years_elapsed / 0.25)  # Scale from 90-day to full history

    # Generate violations
    violations = generate_violations(
        scenario=scenario,
        start_date=config["installation_date"],
        end_date=current_date,
    )

    # Generate capacity tests
    capacity_tests = generate_capacity_tests(
        installation_date=config["installation_date"],
        current_date=current_date,
        nominal_capacity_kwh=config["capacity_kwh"],
        scenario=scenario,
    )

    # Generate dispatch schedule
    dispatch_schedule = generate_dispatch_schedule(
        date=current_date,
        capacity_kwh=config["capacity_kwh"],
        power_kw=config["power_kw"],
    )

    # Calculate warranty health score
    warranty_health = calculate_warranty_health_score(
        current_soh=current_soh,
        warranty_threshold=0.70,
        cycles_used=total_cycles,
        max_cycles=config["max_cycles"],
        years_elapsed=years_elapsed,
        warranty_years=config["warranty_years"],
        n_violations=len([v for v in violations if v["severity"] == "critical"]),
    )

    # Asset info
    asset_info = {
        "asset_id": f"bess-{plant_id}-001",
        "plant_id": plant_id,
        "name": f"{plant_name} BESS Unit 1",
        "chemistry": config["chemistry"].upper(),
        "nominal_capacity_kwh": config["capacity_kwh"],
        "nominal_power_kw": config["power_kw"],
        "manufacturer": "Tesla" if config["chemistry"] == "nmc" else "BYD",
        "model": "Megapack 2" if config["chemistry"] == "nmc" else "Battery Box",
        "installation_date": config["installation_date"].strftime("%Y-%m-%d"),
        "current_soh": current_soh,
        "current_soc": 0.65,
    }

    # Write all JSON files
    files = {
        "asset_info.json": asset_info,
        "warranty_status.json": {
            "asset_id": asset_info["asset_id"],
            "snapshot_date": current_date.strftime("%Y-%m-%d"),
            "warranty_health": warranty_health,
            "warranty_terms": {
                "capacity_guarantee_pct": 0.70,
                "warranty_years": config["warranty_years"],
                "max_cycles": config["max_cycles"],
                "max_throughput_mwh": None,
                "min_rte": 0.85,
                "operating_temp_min_c": 15,
                "operating_temp_max_c": 35,
            },
        },
        "warranty_violations.json": violations,
        "cycling_metrics.json": {
            "total_cycles": round(total_cycles, 1),
            "total_throughput_mwh": round(total_cycles * config["capacity_kwh"] * 2 / 1000, 1),
            "daily_metrics": cycling_metrics[-30:],  # Last 30 days
        },
        "capacity_tests.json": capacity_tests,
        "dispatch_schedule.json": dispatch_schedule,
        "soh_history.json": soh_history,
    }

    for filename, data in files.items():
        filepath = output_dir / filename
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)
        print(f"  Generated: {filepath}")

    return asset_info


def main():
    parser = argparse.ArgumentParser(description="Generate BESS demo data")
    parser.add_argument(
        "--output",
        type=str,
        default="public/data/bess",
        help="Output directory for demo data",
    )
    args = parser.parse_args()

    output_base = Path(args.output)

    print("Generating BESS demo data...")
    print("=" * 50)

    # Generate BESS-only demo plant (healthy)
    print("\n1. Demo BESS Plant (Healthy scenario)")
    generate_bess_plant_data(
        plant_id="demo-bess-plant",
        plant_name="Demo Energy Storage",
        scenario="healthy",
        output_dir=output_base / "demo-bess-plant",
    )

    # Generate hybrid PV+BESS plant (degrading)
    print("\n2. Alpha1 Hybrid Plant (Degrading scenario)")
    generate_bess_plant_data(
        plant_id="alpha1",
        plant_name="Alpha1 Solar + Storage",
        scenario="degrading",
        output_dir=output_base / "alpha1",
    )

    # Generate stressed scenario
    print("\n3. Demo Stressed Plant (Stressed scenario)")
    generate_bess_plant_data(
        plant_id="demo-stressed",
        plant_name="Demo Stressed Battery",
        scenario="stressed",
        output_dir=output_base / "demo-stressed",
    )

    print("\n" + "=" * 50)
    print("Demo data generation complete!")
    print(f"Output directory: {output_base}")


if __name__ == "__main__":
    main()
