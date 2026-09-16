#!/usr/bin/env python3
"""
Fault Detection Service - Called from Next.js API via child_process.spawn

Input (JSON via stdin):
{
    "plant_id": "alpha1_1",
    "data_source": "/path/to/data.parquet",
    "currency": "EUR",
    "electricity_price": 0.12,
    "rated_dc_power_kw": 50000,
    "rated_ac_power_kw": 45000,
    "n_strings_per_inverter": 12
}

Output (JSON to stdout):
{
    "plant_id": "alpha1_1",
    "timestamp": "2025-01-15T10:30:00Z",
    "summary": {
        "current_loss_kwh": 23765.09,
        "projected_loss_kwh": 71040.0,
        "current_loss_value": 4753.02,
        "projected_loss_value": 14208.0,
        "currency": "EUR",
        "reactive_count": 5,
        "predictive_count": 12,
        "critical_count": 2,
        "urgent_count": 3
    },
    "reactive_faults": [...],
    "predictive_faults": [...]
}
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional
import uuid

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import polars as pl

from nuravolt.fault import (
    RuleBasedFaultDetector,
    FaultDetectionConfig,
    RULPredictor,
    PlantConfig,
    FaultType,
    FaultSeverity,
)


# Power loss factors by fault type with methodology metadata
REACTIVE_LOSS_FACTORS = {
    FaultType.INVERTER_OFFLINE.value: {
        "factor": 1.0,
        "description": "Complete inverter shutdown - 100% of inverter capacity lost",
        "basis": "Measured offline events - no power production during daylight hours",
        "reference": "Field observations across 150+ plants (2023-2025)"
    },
    FaultType.INVERTER_CLIPPING.value: {
        "factor": 0.10,
        "description": "AC output limited by inverter capacity - 10% energy loss during clipping periods",
        "basis": "DC power exceeds AC capacity, extra DC power not converted",
        "reference": "IEC 61724-1 clipping loss calculation"
    },
    FaultType.INVERTER_OVERTEMPERATURE.value: {
        "factor": 0.50,
        "description": "Thermal derating or shutdown - 50% capacity reduction",
        "basis": "Progressive derating from 65°C to complete shutdown at 85°C",
        "reference": "Manufacturer thermal derating curves"
    },
    FaultType.STRING_OPEN_CIRCUIT.value: {
        "factor": 0.083,
        "description": "Single string open circuit - 1/12 of inverter capacity lost per string",
        "basis": "Typical 12-string inverter configuration (1/12 = 8.3%)",
        "reference": "IEC 61724-1 string loss calculation"
    },
    FaultType.STRING_SHORT_CIRCUIT.value: {
        "factor": 0.083,
        "description": "String short circuit - 1/12 of inverter capacity lost per string",
        "basis": "Affected string produces zero power in typical 12-string configuration",
        "reference": "IEC 61724-1 string loss calculation"
    },
    FaultType.TRACKER_STUCK.value: {
        "factor": 0.20,
        "description": "Fixed tracker position - 20% cosine tracking loss average across day",
        "basis": "Suboptimal angle causes cosine losses averaging 20% over daylight hours",
        "reference": "NREL tracker performance studies (SAM model validation)"
    },
    FaultType.TRACKER_MISALIGNED.value: {
        "factor": 0.10,
        "description": "Tracker angle deviation - 10% cosine loss from misalignment",
        "basis": "Typical 5-10° misalignment results in ~10% cosine loss",
        "reference": "NREL tracker accuracy guidelines"
    },
    FaultType.MODULE_OVERTEMPERATURE.value: {
        "factor": 0.05,
        "description": "Elevated module temperature - 5% power derating",
        "basis": "Temperature coefficient -0.4%/°C × 12.5°C above STC (25°C → 37.5°C ambient)",
        "reference": "IEC 61215 temperature coefficient specification"
    },
    FaultType.COMMUNICATION_LOSS.value: {
        "factor": 0.0,
        "description": "Data communication gap - no direct power loss",
        "basis": "Monitoring loss only, inverter continues operating normally",
        "reference": "Operational experience - monitoring vs. production data"
    },
    FaultType.GRID_FREQUENCY_LOW.value: {
        "factor": 0.0,
        "description": "Grid underfrequency event - monitoring only, no loss attribution",
        "basis": "Inverter may trip for grid protection but resumes automatically",
        "reference": "IEEE 1547 grid support requirements"
    },
    FaultType.GRID_FREQUENCY_HIGH.value: {
        "factor": 0.0,
        "description": "Grid overfrequency event - monitoring only, no loss attribution",
        "basis": "Inverter may trip for grid protection but resumes automatically",
        "reference": "IEEE 1547 grid support requirements"
    },
    FaultType.GRID_VOLTAGE_SAG.value: {
        "factor": 0.0,
        "description": "Grid voltage sag - monitoring only, no loss attribution",
        "basis": "Transient event, inverter ride-through capability per grid codes",
        "reference": "IEC 61727 voltage ride-through requirements"
    },
    FaultType.GRID_VOLTAGE_SWELL.value: {
        "factor": 0.0,
        "description": "Grid voltage swell - monitoring only, no loss attribution",
        "basis": "Transient event, inverter ride-through capability per grid codes",
        "reference": "IEC 61727 voltage ride-through requirements"
    },
}

PREDICTIVE_LOSS_FACTORS = {
    "string_degradation": 0.15,  # 15% loss on affected string
    "module_degradation": 0.25,  # 25% permanent loss
    "inverter_thermal": 1.0,  # 100% shutdown risk
    "thermal_hotspot": 0.10,  # 10% module loss
    "mismatch": 0.15,  # 15% string loss
    "bypass_diode": 0.20,  # 20% module loss
    "insulation": 0.0,  # Safety risk, not power loss
}


def load_data(data_source: str) -> pl.DataFrame:
    """Load data from file path."""
    path = Path(data_source)

    if not path.exists():
        raise FileNotFoundError(f"Data source not found: {data_source}")

    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return pl.read_parquet(data_source)
    elif suffix == ".csv":
        return pl.read_csv(data_source)
    elif suffix == ".json":
        return pl.read_json(data_source)
    else:
        raise ValueError(f"Unsupported file format: {suffix}")


def calculate_reactive_power_loss(
    alert: dict,
    rated_ac_power_kw: float,
    n_strings: int,
    peak_sun_hours: float = 5.0,
) -> tuple[float, float, dict]:
    """
    Calculate power loss (kW) and energy loss (kWh) for a reactive fault with methodology metadata.

    Returns:
        (power_loss_kw, energy_loss_kwh, loss_metadata)
    """
    fault_type = alert.get("fault_type", "")
    duration_minutes = alert.get("duration_minutes") or 0

    # Get loss factor info
    loss_info = REACTIVE_LOSS_FACTORS.get(fault_type, {
        "factor": 0.05,
        "description": "Unknown fault type - conservative 5% estimate",
        "basis": "Default fallback for unrecognized fault types",
        "reference": "Conservative estimate"
    })
    loss_factor = loss_info["factor"]

    # Calculate power loss and build metadata
    if fault_type in [FaultType.STRING_OPEN_CIRCUIT.value, FaultType.STRING_SHORT_CIRCUIT.value]:
        # Per-string loss
        per_string_capacity = rated_ac_power_kw / n_strings
        power_loss_kw = per_string_capacity * loss_factor
        formula = f"Loss = (Rated_AC / N_strings) × Factor = ({rated_ac_power_kw:.1f} kW / {n_strings}) × {loss_factor*100:.1f}%"
        factors = {
            "rated_ac_power_kw": rated_ac_power_kw,
            "n_strings": n_strings,
            "loss_factor_pct": loss_factor * 100,
            "affected_strings": 1,
            "per_string_capacity_kw": per_string_capacity,
            "rationale": f"Based on 1 of {n_strings} strings affected ({loss_info['basis']})"
        }
    elif fault_type == FaultType.INVERTER_OFFLINE.value:
        # Full inverter loss
        power_loss_kw = rated_ac_power_kw * loss_factor
        formula = f"Loss = Rated_AC × Factor = {rated_ac_power_kw:.1f} kW × {loss_factor*100:.0f}%"
        factors = {
            "rated_ac_power_kw": rated_ac_power_kw,
            "loss_factor_pct": loss_factor * 100,
            "rationale": loss_info["description"]
        }
    else:
        # Generic calculation
        power_loss_kw = rated_ac_power_kw * loss_factor
        formula = f"Loss = Rated_AC × Factor = {rated_ac_power_kw:.1f} kW × {loss_factor*100:.1f}%"
        factors = {
            "rated_ac_power_kw": rated_ac_power_kw,
            "loss_factor_pct": loss_factor * 100,
            "rationale": loss_info["description"]
        }

    # Energy loss calculation
    if duration_minutes > 0:
        duration_hours = duration_minutes / 60
        energy_loss_kwh = power_loss_kw * duration_hours
        energy_formula = f"Energy = Power × Duration = {power_loss_kw:.2f} kW × {duration_hours:.2f} h"
    else:
        duration_hours = 1.0
        energy_loss_kwh = power_loss_kw * 1.0
        energy_formula = f"Energy = Power × 1h (ongoing) = {power_loss_kw:.2f} kW × 1 h"

    factors["duration_hours"] = duration_hours

    metadata = {
        "method": "reactive_factor",
        "power_formula": formula,
        "energy_formula": energy_formula,
        "factors": factors,
        "reference": loss_info["reference"]
    }

    return power_loss_kw, energy_loss_kwh, metadata


def calculate_predictive_power_loss(
    action: dict,
    rated_ac_power_kw: float,
    n_strings: int,
    peak_sun_hours: float = 5.0,
) -> tuple[float, float]:
    """
    Calculate projected power loss (kW) and energy loss (kWh) for predictive fault.

    Returns:
        (projected_power_loss_kw, projected_energy_loss_kwh)
    """
    fault_type = action.get("fault_type", "")
    days_to_fault = action.get("days_to_fault", 30)

    # Get loss factor
    loss_factor = PREDICTIVE_LOSS_FACTORS.get(fault_type, 0.10)

    # Base power loss when fault occurs
    if fault_type in ["string_degradation", "mismatch"]:
        # Per-string loss
        power_loss_kw = (rated_ac_power_kw / n_strings) * loss_factor
    elif fault_type == "module_degradation":
        # Plant-wide effect
        power_loss_kw = rated_ac_power_kw * loss_factor
    else:
        # Per-inverter
        power_loss_kw = rated_ac_power_kw * loss_factor

    # Project energy loss over time until fault
    # Assumes loss accumulates linearly over days_to_fault
    projected_energy_kwh = power_loss_kw * peak_sun_hours * days_to_fault

    return power_loss_kw, projected_energy_kwh


def run_reactive_detection(
    df: pl.DataFrame,
    config: FaultDetectionConfig,
    rated_ac_power_kw: float,
    n_strings: int,
) -> tuple[list[dict], dict]:
    """
    Run rule-based reactive fault detection.

    Returns:
        (reactive_faults, summary_stats)
    """
    detector = RuleBasedFaultDetector(config)
    result = detector.detect_all(df)

    reactive_faults = []
    total_loss_kwh = 0.0
    critical_count = 0
    warning_count = 0

    for alert in result.alerts:
        alert_dict = alert.to_dict()

        # Calculate power loss WITH metadata
        power_loss_kw, energy_loss_kwh, loss_metadata = calculate_reactive_power_loss(
            alert_dict, rated_ac_power_kw, n_strings
        )

        # Add calculated fields
        fault_data = {
            "id": str(uuid.uuid4()),
            "fault_type": alert_dict["fault_type"],
            "severity": alert_dict["severity"],
            "equipment_id": alert_dict.get("inverter_id") or alert_dict.get("string_id") or "plant",
            "equipment_name": _get_equipment_name(alert_dict),
            "timestamp_start": alert_dict["timestamp_start"],
            "timestamp_end": alert_dict["timestamp_end"],
            "value": alert_dict["value"],
            "threshold": alert_dict["threshold"],
            "message": alert_dict["message"],
            "duration_minutes": alert_dict["duration_minutes"] or 0,
            "power_loss_kw": round(power_loss_kw, 2),
            "energy_loss_kwh": round(energy_loss_kwh, 2),
            # NEW: Loss computation metadata
            "loss_computation": loss_metadata
        }

        reactive_faults.append(fault_data)
        total_loss_kwh += energy_loss_kwh

        if alert_dict["severity"] == "critical":
            critical_count += 1
        elif alert_dict["severity"] == "warning":
            warning_count += 1

    stats = {
        "reactive_count": len(reactive_faults),
        "current_loss_kwh": round(total_loss_kwh, 2),
        "critical_count": critical_count,
        "warning_count": warning_count,
    }

    return reactive_faults, stats


def run_predictive_detection(
    df: pl.DataFrame,
    model_dir: str,
    plant_config: Optional[PlantConfig],
    rated_ac_power_kw: float,
    n_strings: int,
) -> tuple[list[dict], dict]:
    """
    Run RUL-based predictive fault detection.

    Returns:
        (predictive_faults, summary_stats)
    """
    model_path = Path(model_dir)

    if not model_path.exists():
        return [], {"predictive_count": 0, "projected_loss_kwh": 0, "urgent_count": 0}

    try:
        predictor = RULPredictor(str(model_path))
    except Exception as e:
        print(f"Warning: Failed to load RUL predictor: {e}", file=sys.stderr)
        return [], {"predictive_count": 0, "projected_loss_kwh": 0, "urgent_count": 0}

    # Get maintenance schedule
    schedule = predictor.get_maintenance_schedule(df, plant_config)

    predictive_faults = []
    total_projected_kwh = 0.0
    urgent_count = 0

    # Process all urgency levels
    all_actions = (
        schedule.urgent + schedule.soon + schedule.planned + schedule.monitoring
    )

    for action in all_actions:
        action_dict = action.to_dict()

        # Calculate projected loss
        power_loss_kw, projected_kwh = calculate_predictive_power_loss(
            action_dict, rated_ac_power_kw, n_strings
        )

        fault_data = {
            "id": str(uuid.uuid4()),
            "fault_type": action_dict["fault_type"],
            "display_name": action_dict["display_name"],
            "urgency": action_dict["urgency"],
            "equipment_id": "plant",  # RUL models are typically plant-level
            "equipment_name": action_dict["display_name"],
            "days_to_fault": action_dict["days_to_fault"],
            "confidence": action_dict["confidence"],
            "current_value": action_dict["current_value"],
            "threshold": action_dict["threshold"],
            "unit": action_dict["unit"],
            "recommended_action": action_dict["recommended_action"],
            "estimated_date": action_dict["estimated_date"],
            "projected_power_loss_kw": round(power_loss_kw, 2),
            "projected_energy_loss_kwh": round(projected_kwh, 2),
        }

        predictive_faults.append(fault_data)
        total_projected_kwh += projected_kwh

        if action_dict["urgency"] == "urgent":
            urgent_count += 1

    stats = {
        "predictive_count": len(predictive_faults),
        "projected_loss_kwh": round(total_projected_kwh, 2),
        "urgent_count": urgent_count,
    }

    return predictive_faults, stats


def _get_equipment_name(alert: dict) -> str:
    """Generate human-readable equipment name from alert."""
    if alert.get("inverter_id"):
        return f"Inverter {alert['inverter_id']}"
    if alert.get("string_id"):
        return f"String {alert['string_id']}"
    return "Plant"


def main():
    """Main entry point - reads JSON from stdin, writes JSON to stdout."""
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())

        plant_id = input_data.get("plant_id", "unknown")
        data_source = input_data.get("data_source")
        currency = input_data.get("currency", "EUR")
        electricity_price = input_data.get("electricity_price", 0.12)
        rated_dc_power_kw = input_data.get("rated_dc_power_kw", 50000)
        rated_ac_power_kw = input_data.get("rated_ac_power_kw", 45000)
        n_strings = input_data.get("n_strings_per_inverter", 12)

        if not data_source:
            print(json.dumps({"error": "Missing required field: data_source"}))
            sys.exit(1)

        # Load data
        df = load_data(data_source)

        # Configure fault detection
        config = FaultDetectionConfig.for_eu_plant()
        config.rated_dc_power_kw = rated_dc_power_kw
        config.rated_ac_power_kw = rated_ac_power_kw

        # Plant config for RUL features
        plant_config = PlantConfig(
            rated_dc_power_kw=rated_dc_power_kw,
            rated_ac_power_kw=rated_ac_power_kw,
            n_strings=n_strings,
        )

        # Run reactive detection
        reactive_faults, reactive_stats = run_reactive_detection(
            df, config, rated_ac_power_kw, n_strings
        )

        # Run predictive detection
        model_dir = Path(__file__).parent.parent.parent / "models" / "rul"
        predictive_faults, predictive_stats = run_predictive_detection(
            df, str(model_dir), plant_config, rated_ac_power_kw, n_strings
        )

        # Calculate monetary values
        current_loss_value = reactive_stats["current_loss_kwh"] * electricity_price
        projected_loss_value = predictive_stats["projected_loss_kwh"] * electricity_price

        # Build response
        response = {
            "plant_id": plant_id,
            "timestamp": datetime.now().isoformat(),
            "summary": {
                "current_loss_kwh": reactive_stats["current_loss_kwh"],
                "projected_loss_kwh": predictive_stats["projected_loss_kwh"],
                "current_loss_value": round(current_loss_value, 2),
                "projected_loss_value": round(projected_loss_value, 2),
                "currency": currency,
                "reactive_count": reactive_stats["reactive_count"],
                "predictive_count": predictive_stats["predictive_count"],
                "critical_count": reactive_stats["critical_count"],
                "urgent_count": predictive_stats["urgent_count"],
            },
            "reactive_faults": reactive_faults,
            "predictive_faults": predictive_faults,
        }

        # Output JSON to stdout
        print(json.dumps(response, indent=2))

    except FileNotFoundError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Fault detection failed: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
