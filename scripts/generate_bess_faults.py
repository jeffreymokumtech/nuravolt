#!/usr/bin/env python3
"""Generate BESS faults from existing fixtures and merge them into the
unified fault stream alongside PV faults.

For each plant with BESS fixtures at ``public/data/bess/{plant}/``:

1. Load asset_info + soh_history + cycling_metrics + warranty_violations.
2. Transform the cycling daily_metrics into the time-series shape the
   ``BessFaultDetector`` expects (temp_history, cycle_history, rte_history,
   imbalance_history). For series we don't have at module granularity
   (per-cell voltage spread), synthesise from aggregates honestly.
3. If warranty_violations is empty, synthesise 1-2 plausible recent
   violations from cycling stress aggregates (high_soc_hours,
   high_temp_hours). Tag with ``_synthetic: true`` so the provenance is
   visible.
4. Run ``BessFaultDetector.predict_faults()`` + ``detect_reactive()``.
5. Convert the output (which uses ``bess_`` prefixes + asset_type='bess')
   into the unified ``predictive_faults`` row shape with cascade-friendly
   field names + BESS_MODULE / BESS_PACK asset_type strings.
6. Append the rows to ``public/data/faults/{plant}/fault_detection_enhanced.json``
   (creating the file if it doesn't exist).

Idempotent: BESS rows are tagged with ``bess_source: true`` so re-running
removes the old ones before writing fresh ones.

Usage:
    python scripts/generate_bess_faults.py                # all BESS plants
    python scripts/generate_bess_faults.py ribera      # subset
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nuravolt.fault.bess_fault_detector import BessFaultDetector  # noqa: E402

BESS_ROOT = REPO_ROOT / "public" / "data" / "bess"
FAULTS_ROOT = REPO_ROOT / "public" / "data" / "faults"

# Default electricity price (matches Mediterranean PPA bracket — €75/MWh = €0.075/kWh)
DEFAULT_PRICE_EUR_KWH = 0.075


def load_bess_fixtures(plant_id: str) -> Optional[Dict[str, Any]]:
    """Load all relevant BESS fixtures for a plant, or None if no BESS data."""
    plant_dir = BESS_ROOT / plant_id
    if not plant_dir.exists():
        return None

    def _load(name: str) -> Any:
        fp = plant_dir / name
        if not fp.exists():
            return None
        try:
            return json.loads(fp.read_text())
        except json.JSONDecodeError:
            return None

    return {
        "asset_info": _load("asset_info.json"),
        "soh_history": _load("soh_history.json"),
        "cycling_metrics": _load("cycling_metrics.json"),
        "warranty_status": _load("warranty_status.json"),
        "warranty_violations": _load("warranty_violations.json") or [],
    }


def list_bess_plants() -> List[str]:
    if not BESS_ROOT.exists():
        return []
    return sorted([p.name for p in BESS_ROOT.iterdir() if p.is_dir() and (p / "asset_info.json").exists()])


def build_detector_input(fixtures: Dict[str, Any]) -> Dict[str, Any]:
    """Convert the on-disk BESS fixtures into the asset_data dict that
    ``BessFaultDetector.predict_faults()`` expects."""
    asset_info = fixtures.get("asset_info") or {}
    soh_raw = fixtures.get("soh_history") or []
    cycling = fixtures.get("cycling_metrics") or {}
    daily = cycling.get("daily_metrics") or []

    # SoH history — already in the right shape
    soh_history = [{"date": r["date"], "soh": r["soh"]} for r in soh_raw if "soh" in r]

    # Temp history from daily_metrics.max_temp_c
    temp_history = [
        {"date": r["date"], "daily_max_temp_c": r.get("max_temp_c", 25.0)}
        for r in daily if "max_temp_c" in r
    ]

    # Cycle history from cumulative_cycles
    cycle_history = [
        {"date": r["date"], "cumulative_efc": r.get("cumulative_cycles", 0.0)}
        for r in daily if "cumulative_cycles" in r
    ]

    # RTE history from round_trip_efficiency
    rte_history = [
        {"date": r["date"], "daily_rte": r.get("round_trip_efficiency", 0.88)}
        for r in daily if "round_trip_efficiency" in r
    ]

    # Cell imbalance history — synthesised from high_temp_hours.
    imbalance_history = []
    cumulative_stress_mv = 5.0  # baseline 5mV for a new pack
    for r in daily:
        if "high_temp_hours" in r:
            cumulative_stress_mv += float(r.get("high_temp_hours", 0)) * 0.6
            cumulative_stress_mv = min(cumulative_stress_mv, 65.0)
            imbalance_history.append({
                "date": r["date"],
                "cell_voltage_spread_mv": round(cumulative_stress_mv, 1),
            })

    return {
        "asset_id": asset_info.get("asset_id") or asset_info.get("name", "bess-unknown"),
        "asset_name": asset_info.get("name", "BESS Unit"),
        "capacity_kwh": float(asset_info.get("nominal_capacity_kwh", 1000.0)),
        "soh_history": soh_history,
        "temp_history": temp_history,
        "cycle_history": cycle_history,
        "rte_history": rte_history,
        "imbalance_history": imbalance_history,
        "violations": fixtures.get("warranty_violations") or [],
    }


def synthesise_violations_if_empty(fixtures: Dict[str, Any]) -> List[Dict[str, Any]]:
    """If the plant ships an empty warranty_violations list, derive 1-2
    plausible recent violations from the cycling stress aggregates so
    the reactive fault path has something to fire on."""
    if fixtures.get("warranty_violations"):
        return list(fixtures["warranty_violations"])

    cycling = fixtures.get("cycling_metrics") or {}
    daily = cycling.get("daily_metrics") or []
    if not daily:
        return []

    synthetic: List[Dict[str, Any]] = []
    today = date.today()

    high_soc_hours_total = sum(float(r.get("high_soc_hours", 0)) for r in daily)
    if high_soc_hours_total > 25:
        synthetic.append({
            "violation_type": "SOC_HIGH_DWELL",
            "severity": "warning",
            "measured_value": round(high_soc_hours_total, 1),
            "threshold_value": 24.0,
            "unit": "h cumulative",
            "description": "Pack held at >90% SoC longer than warranty allows over the analysis window.",
            "started_at": (today - timedelta(days=3)).isoformat(),
            "_synthetic": True,
        })

    high_temp_days = sum(1 for r in daily if float(r.get("max_temp_c", 0)) > 35.0)
    if high_temp_days >= 2:
        max_temp = max(float(r.get("max_temp_c", 0)) for r in daily)
        synthetic.append({
            "violation_type": "TEMPERATURE_EXCEED",
            "severity": "warning",
            "measured_value": round(max_temp, 1),
            "threshold_value": 35.0,
            "unit": "°C",
            "description": f"Module hot-side temperature exceeded warranty limit on {high_temp_days} day(s).",
            "started_at": (today - timedelta(days=2)).isoformat(),
            "_synthetic": True,
        })

    return synthetic


def _strip_bess_prefix(fault_type: str) -> str:
    return fault_type[5:] if fault_type.startswith("bess_") else fault_type


def _asset_type_for_bess_fault(fault_type: str) -> str:
    module_faults = {
        "capacity_fade", "thermal_stress", "cell_imbalance",
        "temperature_exceed", "voltage_violation",
    }
    return "BESS_MODULE" if _strip_bess_prefix(fault_type).lower() in module_faults else "BESS_PACK"


def convert_to_unified_row(bess_fault: Dict[str, Any], plant_id: str, idx: int) -> Dict[str, Any]:
    raw_fault_type = bess_fault.get("fault_type", "unknown")
    unified_fault_type = _strip_bess_prefix(raw_fault_type)
    equipment_id = bess_fault.get("equipment_id", f"bess-{plant_id}")
    if not equipment_id.upper().startswith("BESS"):
        equipment_id = f"BESS-{equipment_id}"

    return {
        "id": bess_fault.get("id") or f"BESS-{plant_id}-{idx:02d}",
        "fault_type": unified_fault_type,
        "display_name": bess_fault.get("display_name", unified_fault_type.replace("_", " ").title()),
        "equipment_id": equipment_id,
        "equipment_name": bess_fault.get("equipment_name", equipment_id),
        "asset_type": _asset_type_for_bess_fault(raw_fault_type),
        "days_to_fault": bess_fault.get("days_to_fault", 0),
        "confidence": bess_fault.get("confidence", 0.6),
        "current_value": bess_fault.get("current_value"),
        "threshold": bess_fault.get("threshold"),
        "unit": bess_fault.get("unit", ""),
        "trend": bess_fault.get("trend"),
        "urgency": bess_fault.get("urgency", "soon"),
        "is_urgent": bess_fault.get("is_urgent", False),
        "recommended_action": bess_fault.get("recommended_action", ""),
        "estimated_date": bess_fault.get("estimated_date"),
        "projected_power_loss_kw": bess_fault.get("projected_power_loss_kw", 0),
        "projected_energy_loss_kwh": bess_fault.get("projected_energy_loss_kwh", 0),
        "repair_cost_eur": bess_fault.get("repair_cost_eur", 1500),
        "revenue_at_risk_eur": bess_fault.get(
            "revenue_at_risk_eur",
            round(bess_fault.get("projected_energy_loss_kwh", 0) * DEFAULT_PRICE_EUR_KWH, 2),
        ),
        "is_reactive": bess_fault.get("is_reactive", False),
        "bess_source": True,
    }


def generate_for_plant(plant_id: str) -> Dict[str, Any]:
    fixtures = load_bess_fixtures(plant_id)
    if fixtures is None or not fixtures.get("asset_info"):
        return {"plant_id": plant_id, "error": "no BESS fixtures"}

    if not fixtures.get("warranty_violations"):
        fixtures["warranty_violations"] = synthesise_violations_if_empty(fixtures)

    detector_input = build_detector_input(fixtures)
    detector = BessFaultDetector(electricity_price_eur_kwh=DEFAULT_PRICE_EUR_KWH)

    reactive_faults = detector.detect_reactive({**detector_input, "violations": fixtures["warranty_violations"]})
    predictive_faults = detector.predict_faults(detector_input)
    all_bess_faults = reactive_faults + predictive_faults

    if not all_bess_faults:
        return {"plant_id": plant_id, "reactive": 0, "predictive": 0, "note": "no faults"}

    unified_rows = [convert_to_unified_row(f, plant_id, i) for i, f in enumerate(all_bess_faults)]

    fault_dir = FAULTS_ROOT / plant_id
    fault_dir.mkdir(parents=True, exist_ok=True)
    fault_fp = fault_dir / "fault_detection_enhanced.json"

    if fault_fp.exists():
        data = json.loads(fault_fp.read_text())
    else:
        data = {
            "plant_id": plant_id,
            "generated_at": datetime.utcnow().isoformat(),
            "summary": {
                "current_loss_kwh": 0.0, "projected_loss_kwh": 0.0,
                "currency": "EUR", "reactive_count": 0, "predictive_count": 0,
                "critical_count": 0, "urgent_count": 0, "soon_count": 0,
                "planned_count": 0, "monitoring_count": 0,
            },
            "health_score": {"value": 90, "status": "healthy", "trend": "stable"},
            "urgency_summary": {},
            "rul_predictions": [],
            "predictive_faults": [],
        }

    for key in ("rul_predictions", "predictive_faults"):
        rows = data.get(key, [])
        data[key] = [r for r in rows if not r.get("bess_source")]

    data["rul_predictions"].extend(unified_rows)
    data["predictive_faults"].extend(unified_rows)

    s = data.setdefault("summary", {})
    bess_critical = sum(1 for r in unified_rows if r["urgency"] == "critical")
    bess_urgent = sum(1 for r in unified_rows if r["urgency"] == "urgent")
    bess_soon = sum(1 for r in unified_rows if r["urgency"] == "soon")
    s["critical_count"] = s.get("critical_count", 0) + bess_critical
    s["urgent_count"] = s.get("urgent_count", 0) + bess_urgent
    s["soon_count"] = s.get("soon_count", 0) + bess_soon
    s["predictive_count"] = s.get("predictive_count", 0) + sum(1 for r in unified_rows if not r.get("is_reactive"))
    s["reactive_count"] = s.get("reactive_count", 0) + sum(1 for r in unified_rows if r.get("is_reactive"))

    data["bess_summary"] = {
        "reactive_count": len(reactive_faults),
        "predictive_count": len(predictive_faults),
        "synthesised_violations": sum(1 for v in fixtures.get("warranty_violations", []) if v.get("_synthetic")),
        "asset_id": fixtures["asset_info"].get("asset_id"),
        "generated_at": datetime.utcnow().isoformat(),
    }

    fault_fp.write_text(json.dumps(data, indent=2))
    return {
        "plant_id": plant_id,
        "reactive": len(reactive_faults),
        "predictive": len(predictive_faults),
        "merged_into": str(fault_fp.relative_to(REPO_ROOT)),
    }


def main() -> int:
    argv = sys.argv[1:]
    plants = argv if argv else list_bess_plants()
    print("=" * 60)
    print("BESS fault generation")
    print("=" * 60)
    print(f"Plants ({len(plants)}): {plants}")

    for plant_id in plants:
        try:
            r = generate_for_plant(plant_id)
            if "error" in r:
                print(f"  ✗ {plant_id}: {r['error']}")
            else:
                print(
                    f"  • {plant_id:14s}  reactive={r['reactive']:2d}  predictive={r['predictive']:2d}  "
                    f"→ {r.get('merged_into', r.get('note', ''))}"
                )
        except Exception as e:
            print(f"  ✗ {plant_id}: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()

    print("=" * 60)
    print("Done")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
