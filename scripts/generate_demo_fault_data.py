#!/usr/bin/env python3
"""
Generate enhanced fault detection demo data with RUL predictions.

This script generates sample data for the NuraVolt demo pages including:
- Health score from predictive maintenance
- RUL (Remaining Useful Life) predictions
- Urgency summary
- IEA PVPS Task 13 loss disaggregation
- Maintenance schedule with ROI

Usage:
    python scripts/generate_demo_fault_data.py
    python scripts/generate_demo_fault_data.py --plant-id alpha1 --output public/data/faults/alpha/
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any
import argparse

# RUL model configurations (matching nuravolt/fault/rul_models.py)
RUL_CONFIGS = {
    "string_degradation": {
        "display_name": "String Degradation",
        "threshold": 0.25,
        "unit": "CV",
        "max_days": 14,
        "repair_hours": 2.0,
        "repair_cost_base": 450,
        "loss_kwh_per_day": 15,
        "recommended_action": "Inspect string connections for corrosion or loose terminals. Check for damaged cables."
    },
    "inverter_thermal": {
        "display_name": "Inverter Overtemperature",
        "threshold": 65.0,
        "unit": "°C",
        "max_days": 10,
        "repair_hours": 4.0,
        "repair_cost_base": 800,
        "loss_kwh_per_day": 50,
        "recommended_action": "Check cooling system immediately. Inspect fans, filters, and ventilation. Consider reducing load."
    },
    "module_degradation": {
        "display_name": "Module Degradation",
        "threshold": 0.75,
        "unit": "PR",
        "max_days": 90,
        "repair_hours": 8.0,
        "repair_cost_base": 1200,
        "loss_kwh_per_day": 25,
        "recommended_action": "Schedule module inspection. Check for PID, delamination, or hotspots. Consider I-V curve testing."
    },
    "thermal_hotspot": {
        "display_name": "Thermal Hotspot Risk",
        "threshold": 25.0,
        "unit": "°C ΔT",
        "max_days": 10,
        "repair_hours": 3.0,
        "repair_cost_base": 600,
        "loss_kwh_per_day": 20,
        "recommended_action": "URGENT: Perform IR camera inspection. Check for cell cracking, bypass diode issues, or junction box problems."
    },
    "mismatch": {
        "display_name": "String Mismatch",
        "threshold": 0.85,
        "unit": "ratio",
        "max_days": 14,
        "repair_hours": 3.0,
        "repair_cost_base": 500,
        "loss_kwh_per_day": 30,
        "recommended_action": "Check string voltage/current balance. Look for shading, soiling patterns, or module degradation differences."
    },
    "bypass_diode": {
        "display_name": "Bypass Diode Failure",
        "threshold": 3,
        "unit": "hotspots",
        "max_days": 7,
        "repair_hours": 4.0,
        "repair_cost_base": 700,
        "loss_kwh_per_day": 40,
        "recommended_action": "CRITICAL: High hotspot count indicates fire risk. Test bypass diodes immediately. Consider module replacement."
    },
    "insulation": {
        "display_name": "Insulation Degradation",
        "threshold": 40.0,
        "unit": "MΩ/kWp",
        "max_days": 90,
        "repair_hours": 6.0,
        "repair_cost_base": 900,
        "loss_kwh_per_day": 10,
        "recommended_action": "CRITICAL: Ground fault risk. Test Riso immediately. Check cable insulation and junction boxes for moisture ingress."
    },
}

# Sample inverter IDs for the plant
def generate_inverter_ids(n_inverters: int = 150) -> List[str]:
    """Generate realistic inverter IDs."""
    ids = []
    for group in range(1, 6):  # 5 groups
        for inv in range(1, (n_inverters // 5) + 1):
            ids.append(f"INV {group:02d}.{inv:03d}")
    return ids


def generate_rul_predictions(inverter_ids: List[str], count: int = 16) -> List[Dict]:
    """Generate realistic RUL predictions."""
    predictions = []
    fault_types = list(RUL_CONFIGS.keys())
    used_combinations = set()

    for _ in range(count):
        # Avoid duplicate inverter+fault combinations
        attempts = 0
        while attempts < 50:
            fault_type = random.choice(fault_types)
            inverter_id = random.choice(inverter_ids)
            key = (fault_type, inverter_id)
            if key not in used_combinations:
                used_combinations.add(key)
                break
            attempts += 1

        config = RUL_CONFIGS[fault_type]

        # Generate days_to_fault with realistic distribution
        # Distribute across the available range for this fault type
        max_days = config["max_days"]
        rand = random.random()

        if max_days <= 7:
            # Short horizon models: only urgent/soon
            if rand < 0.4:
                days_to_fault = random.randint(1, 2)
            else:
                days_to_fault = random.randint(3, max_days)
        elif max_days <= 14:
            # Medium horizon models: urgent/soon/planned
            if rand < 0.2:
                days_to_fault = random.randint(1, 2)
            elif rand < 0.5:
                days_to_fault = random.randint(3, 7)
            else:
                days_to_fault = random.randint(8, max_days)
        else:
            # Long horizon models: full distribution
            if rand < 0.15:
                days_to_fault = random.randint(1, 2)
            elif rand < 0.40:
                days_to_fault = random.randint(3, 7)
            elif rand < 0.85:
                days_to_fault = random.randint(8, 30)
            else:
                days_to_fault = random.randint(31, max_days)

        urgency = (
            "urgent" if days_to_fault < 3 else
            "soon" if days_to_fault < 7 else
            "planned" if days_to_fault < 30 else
            "monitoring"
        )

        # Generate current value near threshold
        if config["unit"] in ["CV", "ratio", "PR"]:
            current_value = round(config["threshold"] * random.uniform(0.75, 0.95), 3)
        elif config["unit"] in ["°C", "°C ΔT"]:
            current_value = round(config["threshold"] * random.uniform(0.85, 0.98), 1)
        elif config["unit"] == "hotspots":
            current_value = random.randint(1, int(config["threshold"]) - 1)
        else:
            current_value = round(config["threshold"] * random.uniform(0.80, 0.95), 1)

        # Calculate costs
        repair_cost = config["repair_cost_base"] + random.randint(-100, 200)
        revenue_at_risk = int(days_to_fault * config["loss_kwh_per_day"] * 0.12 * random.uniform(0.8, 1.2))  # ~0.12 EUR/kWh

        # Confidence based on days to fault (closer = more confident)
        confidence = round(0.95 - (days_to_fault / config["max_days"]) * 0.25 + random.uniform(-0.05, 0.05), 2)
        confidence = max(0.60, min(0.95, confidence))

        # Trend (negative = getting worse)
        if config["unit"] in ["CV", "°C", "°C ΔT", "hotspots"]:
            trend = round(random.uniform(0.001, 0.01), 4)  # Increasing is bad
        else:
            trend = round(random.uniform(-0.01, -0.001), 4)  # Decreasing is bad

        predictions.append({
            "fault_type": fault_type,
            "display_name": config["display_name"],
            "inverter_id": inverter_id,
            "days_to_fault": days_to_fault,
            "confidence": confidence,
            "current_value": current_value,
            "threshold": config["threshold"],
            "unit": config["unit"],
            "trend": trend,
            "is_urgent": days_to_fault < 3,
            "urgency": urgency,
            "recommended_action": config["recommended_action"],
            "repair_cost_eur": repair_cost,
            "revenue_at_risk_eur": revenue_at_risk,
        })

    # Sort by days_to_fault (most urgent first)
    predictions.sort(key=lambda x: x["days_to_fault"])
    return predictions


def generate_health_score(rul_predictions: List[Dict]) -> Dict:
    """Calculate health score based on RUL predictions."""
    urgent_count = sum(1 for p in rul_predictions if p["urgency"] == "urgent")
    soon_count = sum(1 for p in rul_predictions if p["urgency"] == "soon")
    planned_count = sum(1 for p in rul_predictions if p["urgency"] == "planned")

    # Calculate penalties
    anomaly_penalty = min(30, urgent_count * 10 + soon_count * 3)
    fault_penalty = min(20, len(rul_predictions) * 1.5)

    # RUL penalty based on minimum days to fault
    min_rul = min((p["days_to_fault"] for p in rul_predictions), default=365)
    if min_rul < 3:
        rul_penalty = 25
    elif min_rul < 7:
        rul_penalty = 15
    elif min_rul < 14:
        rul_penalty = 10
    elif min_rul < 30:
        rul_penalty = 5
    else:
        rul_penalty = 0

    value = max(0, 100 - anomaly_penalty - fault_penalty - rul_penalty)

    return {
        "value": round(value, 1),
        "status": (
            "healthy" if value >= 80 else
            "attention_needed" if value >= 60 else
            "degraded" if value >= 40 else
            "critical"
        ),
        "anomaly_penalty": round(anomaly_penalty, 1),
        "fault_penalty": round(fault_penalty, 1),
        "rul_penalty": round(rul_penalty, 1),
        "trend": random.choice(["improving", "stable", "stable", "degrading"])  # Bias toward stable
    }


def generate_urgency_summary(rul_predictions: List[Dict]) -> Dict:
    """Calculate urgency summary from RUL predictions."""
    summary = {
        "urgent": {"count": 0, "total_revenue_at_risk_eur": 0},
        "soon": {"count": 0, "total_revenue_at_risk_eur": 0},
        "planned": {"count": 0, "total_revenue_at_risk_eur": 0},
        "monitoring": {"count": 0, "total_revenue_at_risk_eur": 0},
    }

    for pred in rul_predictions:
        urgency = pred["urgency"]
        summary[urgency]["count"] += 1
        summary[urgency]["total_revenue_at_risk_eur"] += pred["revenue_at_risk_eur"]

    return summary


def generate_loss_disaggregation(reference_energy_kwh: float) -> Dict:
    """Generate IEA PVPS Task 13 compliant loss disaggregation."""
    # Realistic loss percentages for a utility-scale PV plant
    losses = {
        "soiling": round(random.uniform(1.5, 3.5), 2),
        "temperature": round(random.uniform(2.5, 4.5), 2),
        "spectral": round(random.uniform(0.3, 0.8), 2),
        "inverter": round(random.uniform(1.0, 2.0), 2),
        "wiring_bop": round(random.uniform(1.5, 2.5), 2),
        "degradation": round(random.uniform(0.5, 1.5), 2),
        "curtailment": round(random.uniform(0.5, 2.0), 2),
    }

    total_loss_pct = sum(losses.values())
    net_energy = reference_energy_kwh * (1 - total_loss_pct / 100)

    return {
        "reference_energy_kwh": reference_energy_kwh,
        "net_energy_kwh": round(net_energy, 0),
        "losses": {
            k: {
                "kwh": round(reference_energy_kwh * v / 100, 0),
                "pct": v
            }
            for k, v in losses.items()
        }
    }


def generate_maintenance_schedule(rul_predictions: List[Dict]) -> Dict:
    """Generate maintenance schedule for next 7 days."""
    today = datetime.now().date()
    schedule = []

    for i in range(7):
        date = today + timedelta(days=i)
        tasks = [
            {
                "fault_type": p["fault_type"],
                "inverter_id": p["inverter_id"],
                "priority_score": round(100 - (p["days_to_fault"] * 3) + (p["confidence"] * 10), 0)
            }
            for p in rul_predictions
            if p["days_to_fault"] <= i + 3 and p["urgency"] in ["urgent", "soon"]
        ]

        if tasks:
            schedule.append({
                "date": date.isoformat(),
                "tasks": sorted(tasks, key=lambda x: -x["priority_score"])[:3]  # Top 3 per day
            })

    total_repair_cost = sum(p["repair_cost_eur"] for p in rul_predictions)
    total_revenue_saved = sum(p["revenue_at_risk_eur"] for p in rul_predictions)
    roi_pct = ((total_revenue_saved - total_repair_cost) / max(1, total_repair_cost)) * 100

    return {
        "next_7_days": schedule,
        "total_repair_cost_eur": total_repair_cost,
        "total_revenue_saved_eur": total_revenue_saved,
        "roi_pct": round(roi_pct, 1)
    }


def generate_reactive_faults(inverter_ids: List[str], count: int = 52) -> List[Dict]:
    """Generate sample reactive faults."""
    fault_types = [
        ("inverter_clipping", "warning", 0.5, 2.0),
        ("string_mismatch_coarse", "warning", 0.3, 1.5),
        ("mppt_imbalance", "info", 0.2, 1.0),
        ("soiling_detected", "info", 0.4, 2.5),
        ("inverter_efficiency_degradation", "warning", 0.6, 3.0),
        ("communication_partial", "info", 0.1, 0.5),
        ("sensor_frozen", "info", 0.05, 0.2),
        ("grid_curtailment", "info", 0.8, 4.0),
        ("inverter_overtemperature", "critical", 1.0, 5.0),
        ("string_open_circuit", "critical", 0.9, 4.5),
    ]

    faults = []
    now = datetime.now()

    for i in range(count):
        fault_type, severity, power_factor, energy_factor = random.choice(fault_types)
        inverter_id = random.choice(inverter_ids)

        duration_minutes = random.randint(30, 720)
        power_loss = round(power_factor * random.uniform(0.5, 2.0), 2)
        energy_loss = round(energy_factor * (duration_minutes / 60) * random.uniform(0.5, 1.5), 2)

        start_time = now - timedelta(hours=random.randint(1, 168))

        faults.append({
            "id": f"RF-{i+1:04d}",
            "fault_type": fault_type,
            "severity": severity,
            "equipment_id": inverter_id,
            "equipment_name": inverter_id,
            "timestamp_start": start_time.isoformat(),
            "timestamp_end": (start_time + timedelta(minutes=duration_minutes)).isoformat() if random.random() > 0.3 else None,
            "value": round(random.uniform(0.5, 1.5), 2),
            "threshold": 1.0,
            "message": f"{fault_type.replace('_', ' ').title()} detected on {inverter_id}",
            "duration_minutes": duration_minutes,
            "power_loss_kw": power_loss,
            "energy_loss_kwh": energy_loss,
        })

    return faults


def generate_predictive_faults(rul_predictions: List[Dict]) -> List[Dict]:
    """Convert RUL predictions to predictive fault format."""
    now = datetime.now()
    faults = []

    for i, pred in enumerate(rul_predictions):
        faults.append({
            "id": f"PF-{i+1:04d}",
            "fault_type": pred["fault_type"],
            "display_name": pred["display_name"],
            "urgency": pred["urgency"],
            "equipment_id": pred["inverter_id"],
            "equipment_name": pred["inverter_id"],
            "days_to_fault": pred["days_to_fault"],
            "confidence": pred["confidence"],
            "current_value": pred["current_value"],
            "threshold": pred["threshold"],
            "unit": pred["unit"],
            "recommended_action": pred["recommended_action"],
            "estimated_date": (now + timedelta(days=pred["days_to_fault"])).isoformat(),
            "projected_power_loss_kw": round(random.uniform(0.5, 2.0), 2),
            "projected_energy_loss_kwh": round(pred["revenue_at_risk_eur"] / 0.12, 0),  # Reverse calculate from revenue
        })

    return faults


def main():
    parser = argparse.ArgumentParser(description="Generate enhanced fault detection demo data")
    parser.add_argument("--plant-id", default="alpha1", help="Plant ID (default: alpha1)")
    parser.add_argument("--output", default="public/data/faults/alpha/", help="Output directory")
    parser.add_argument("--n-rul", type=int, default=16, help="Number of RUL predictions")
    parser.add_argument("--n-reactive", type=int, default=52, help="Number of reactive faults")
    parser.add_argument("--reference-energy", type=float, default=2450000, help="Reference energy in kWh")
    args = parser.parse_args()

    # Generate inverter IDs
    inverter_ids = generate_inverter_ids(150)

    # Generate RUL predictions
    rul_predictions = generate_rul_predictions(inverter_ids, count=args.n_rul)

    # Calculate derived data
    health_score = generate_health_score(rul_predictions)
    urgency_summary = generate_urgency_summary(rul_predictions)
    loss_disaggregation = generate_loss_disaggregation(args.reference_energy)
    maintenance_schedule = generate_maintenance_schedule(rul_predictions)

    # Generate faults
    reactive_faults = generate_reactive_faults(inverter_ids, count=args.n_reactive)
    predictive_faults = generate_predictive_faults(rul_predictions)

    # Calculate summary
    summary = {
        "current_loss_kwh": sum(f["energy_loss_kwh"] for f in reactive_faults),
        "projected_loss_kwh": sum(f["projected_energy_loss_kwh"] for f in predictive_faults),
        "current_loss_value": round(sum(f["energy_loss_kwh"] for f in reactive_faults) * 0.12, 0),
        "projected_loss_value": round(sum(f["projected_energy_loss_kwh"] for f in predictive_faults) * 0.12, 0),
        "currency": "EUR",
        "reactive_count": len(reactive_faults),
        "predictive_count": len(predictive_faults),
        "critical_count": sum(1 for f in reactive_faults if f["severity"] == "critical"),
        "urgent_count": urgency_summary["urgent"]["count"],
        "soon_count": urgency_summary["soon"]["count"],
        "planned_count": urgency_summary["planned"]["count"],
        "monitoring_count": urgency_summary["monitoring"]["count"],
    }

    # Assemble enhanced data
    enhanced_data = {
        "plant_id": args.plant_id,
        "generated_at": datetime.now().isoformat(),
        "summary": summary,
        "health_score": health_score,
        "rul_predictions": rul_predictions,
        "urgency_summary": urgency_summary,
        "maintenance_schedule": maintenance_schedule,
        "loss_disaggregation": loss_disaggregation,
        "reactive_faults": reactive_faults,
        "predictive_faults": predictive_faults,
    }

    # Write output
    output_path = Path(args.output)
    output_path.mkdir(parents=True, exist_ok=True)

    output_file = output_path / "fault_detection_enhanced.json"
    with open(output_file, "w") as f:
        json.dump(enhanced_data, f, indent=2)

    print(f"Generated: {output_file}")
    print(f"  - Health Score: {health_score['value']} ({health_score['status']})")
    print(f"  - RUL Predictions: {len(rul_predictions)}")
    print(f"    - Urgent: {urgency_summary['urgent']['count']}")
    print(f"    - Soon: {urgency_summary['soon']['count']}")
    print(f"    - Planned: {urgency_summary['planned']['count']}")
    print(f"    - Monitoring: {urgency_summary['monitoring']['count']}")
    print(f"  - Reactive Faults: {len(reactive_faults)}")
    print(f"  - Loss Disaggregation: {loss_disaggregation['reference_energy_kwh']:,.0f} kWh reference")


if __name__ == "__main__":
    main()
