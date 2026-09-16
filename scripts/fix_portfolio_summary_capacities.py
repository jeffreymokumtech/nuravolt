#!/usr/bin/env python3
"""
Fix portfolio_summary.json capacity inflation.

All solar plants show 300 kW per inverter, but the actual hardware is
SUN 2000-60 KTL = 60 kW per inverter. Every capacity is 5× too high.

Wind plants (nordic-wind-1, care-portugal) are left untouched.
"""
import json
from pathlib import Path

FILE = Path(__file__).parent.parent / "public" / "data" / "portfolio_summary.json"

# Plants to scale down by 5 (solar plants with the 300 kW/inverter bug)
SOLAR_PLANTS = {"alpha", "ribera", "gamma", "delta", "epsilon",
                "zeta", "eta"}
# theta is already correct (50 kW/inverter)

SCALE = 1 / 5

# Fields in each plant object that scale with capacity
SCALING_FIELDS = [
    "capacity_MW",
    "installed_MW",
    "totalCapacity_MW",
    "annual_production_MWh",
    "annual_revenue_eur",
    "annual_opex_eur",
    "annual_loss_eur",
    "ytd_revenue_eur",
]


def main():
    with open(FILE) as f:
        data = json.load(f)

    print("=== BEFORE ===")
    for p in data.get("plants", []):
        if p.get("plantId") in SOLAR_PLANTS:
            print(f"  {p['plantId']}: {p.get('capacity_MW')} MW")

    for plant in data.get("plants", []):
        if plant.get("plantId") not in SOLAR_PLANTS:
            continue
        for field in SCALING_FIELDS:
            if field in plant and isinstance(plant[field], (int, float)):
                plant[field] = round(plant[field] * SCALE, 2)
        # Recurse into any nested objects with scalable fields (e.g., metrics)
        for key, val in plant.items():
            if isinstance(val, dict):
                for nested_field, nested_val in list(val.items()):
                    if nested_field in SCALING_FIELDS and isinstance(nested_val, (int, float)):
                        val[nested_field] = round(nested_val * SCALE, 2)

    # Recompute portfolio summary totals
    summary = data.get("summary", {})
    plants = data.get("plants", [])
    total_cap = sum(p.get("capacity_MW", 0) for p in plants)
    if "totalCapacity_MW" in summary:
        old = summary["totalCapacity_MW"]
        summary["totalCapacity_MW"] = round(total_cap, 2)
        print(f"\nsummary.totalCapacity_MW: {old} -> {summary['totalCapacity_MW']}")

    print("\n=== AFTER ===")
    for p in plants:
        if p.get("plantId") in SOLAR_PLANTS:
            cap = p.get("capacity_MW")
            inv = p.get("totalInverters") or 1
            print(f"  {p['plantId']}: {cap} MW ({cap * 1000 / inv:.0f} kW/inv)")

    with open(FILE, "w") as f:
        json.dump(data, f, indent=2)
    print(f"\n✓ Wrote {FILE}")


if __name__ == "__main__":
    main()
