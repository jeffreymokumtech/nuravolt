#!/usr/bin/env python3
"""
Fix portfolio_financial.json capacity inflation for ribera and alpha.

SCADA ground truth (from backenddata/scada/{plant}/*_meta.csv):
  - Alpha:  150 × SUN 2000-60 KTL = 9.0 MW AC  (currently shown as 45.0 MW = 5x too high)
  - Ribera: 120 × SUN 2000-60 KTL = 7.2 MW AC  (currently shown as 36.0 MW = 5x too high)

This script divides capacity, generation MWh, revenue EUR, OPEX EUR, and loss EUR
fields by 5 for both plants. Ratios (PR, availability, deviation %) are unchanged.
The portfolio summary totals are recomputed from corrected per-plant numbers.
"""
import json
import sys
from pathlib import Path

PORTFOLIO_FILE = Path(__file__).parent.parent / "public" / "data" / "portfolio_financial.json"

# Plants to fix and their correction factor
# NOTE: alpha + ribera already scaled in a previous run — do not double-scale.
CORRECTIONS = {
    "gamma":    {"new_capacity_MW": 2.7,  "scale": 1 / 5},
    "delta":    {"new_capacity_MW": 2.58, "scale": 1 / 5},
    "epsilon":      {"new_capacity_MW": 2.16, "scale": 1 / 5},
    "zeta": {"new_capacity_MW": 1.8,  "scale": 1 / 5},
    "eta":    {"new_capacity_MW": 1.68, "scale": 1 / 5},
}

# Fields in plant.financials that scale with capacity
SCALING_FIELDS = [
    "budget_generation_MWh",
    "actual_generation_MWh",
    "annual_opex_eur",
    "soiling_loss_eur",
    "fault_loss_eur",
    "degradation_loss_eur",
    "curtailment_loss_eur",
    "total_loss_eur",
    "revenue_at_risk_eur",
    "annual_revenue_eur",
    "ytd_revenue_eur",
]

# Fields in summary.financials that need recomputation (sum of plant values)
SUMMARY_SUM_FIELDS = [
    "total_capacity_MW",
    "total_budget_generation_MWh",
    "total_actual_generation_MWh",
    "total_annual_revenue_eur",
    "total_ytd_revenue_eur",
    "total_revenue_at_risk_eur",
    "total_soiling_loss_eur",
    "total_fault_loss_eur",
    "total_degradation_loss_eur",
    "total_curtailment_loss_eur",
    "total_opex_eur",
]


def main():
    if not PORTFOLIO_FILE.exists():
        print(f"ERROR: {PORTFOLIO_FILE} not found", file=sys.stderr)
        return 1

    with open(PORTFOLIO_FILE) as f:
        data = json.load(f)

    print("=== BEFORE ===")
    for p in data.get("plants", []):
        if p["plantId"] in CORRECTIONS:
            print(f"  {p['plantId']}: capacity={p['capacity_MW']} MW, "
                  f"annual_revenue={p['financials']['annual_revenue_eur']:,.0f} EUR")

    # Fix per-plant values
    for plant in data.get("plants", []):
        pid = plant["plantId"]
        if pid not in CORRECTIONS:
            continue

        new_cap = CORRECTIONS[pid]["new_capacity_MW"]
        scale = CORRECTIONS[pid]["scale"]

        print(f"\nFixing {pid}: capacity {plant['capacity_MW']} -> {new_cap} MW (scale={scale})")

        plant["capacity_MW"] = new_cap

        fin = plant.get("financials", {})
        for field in SCALING_FIELDS:
            if field in fin:
                old = fin[field]
                fin[field] = round(old * scale, 2)
                print(f"  {field}: {old:,.0f} -> {fin[field]:,.0f}")

    # Recompute summary totals
    summary = data.get("summary", {})
    summary_fin = summary.get("financials", {})

    plants = data.get("plants", [])

    # totalCapacity_MW (top-level too)
    new_total_cap = sum(p.get("capacity_MW", 0) for p in plants)
    if "totalCapacity_MW" in summary:
        print(f"\nSummary totalCapacity_MW: {summary['totalCapacity_MW']} -> {new_total_cap}")
        summary["totalCapacity_MW"] = round(new_total_cap, 2)

    if "total_capacity_MW" in summary_fin:
        summary_fin["total_capacity_MW"] = round(new_total_cap, 2)

    # Recompute summed financial fields
    for field in SUMMARY_SUM_FIELDS:
        if field == "total_capacity_MW":
            continue
        plant_field = field.replace("total_", "")
        # Map summary field name back to plant.financials field
        plant_field_map = {
            "budget_generation_MWh": "budget_generation_MWh",
            "actual_generation_MWh": "actual_generation_MWh",
            "annual_revenue_eur": "annual_revenue_eur",
            "ytd_revenue_eur": "ytd_revenue_eur",
            "revenue_at_risk_eur": "revenue_at_risk_eur",
            "soiling_loss_eur": "soiling_loss_eur",
            "fault_loss_eur": "fault_loss_eur",
            "degradation_loss_eur": "degradation_loss_eur",
            "curtailment_loss_eur": "curtailment_loss_eur",
            "opex_eur": "annual_opex_eur",
        }
        plant_key = plant_field_map.get(plant_field, plant_field)
        new_total = sum(p.get("financials", {}).get(plant_key, 0) for p in plants)
        if field in summary_fin:
            old = summary_fin[field]
            summary_fin[field] = round(new_total, 2)
            print(f"summary.{field}: {old:,.0f} -> {new_total:,.0f}")

    # Recompute overall budget deviation %
    budget = summary_fin.get("total_budget_generation_MWh", 0)
    actual = summary_fin.get("total_actual_generation_MWh", 0)
    if budget > 0:
        new_dev = round((actual - budget) / budget * 100, 1)
        old_dev = summary_fin.get("overall_budget_deviation_pct")
        summary_fin["overall_budget_deviation_pct"] = new_dev
        print(f"summary.overall_budget_deviation_pct: {old_dev} -> {new_dev}")

    print("\n=== AFTER ===")
    for p in data.get("plants", []):
        if p["plantId"] in CORRECTIONS:
            print(f"  {p['plantId']}: capacity={p['capacity_MW']} MW, "
                  f"annual_revenue={p['financials']['annual_revenue_eur']:,.0f} EUR, "
                  f"soiling_loss={p['financials']['soiling_loss_eur']:,.0f} EUR")

    # Sanity check: implied capacity factor should be reasonable (15-25% for Spain)
    print("\n=== SANITY CHECK ===")
    for p in plants:
        pid = p["plantId"]
        if pid not in CORRECTIONS:
            continue
        cap = p["capacity_MW"]
        actual_mwh = p["financials"]["actual_generation_MWh"]
        cf = actual_mwh / (cap * 8760) * 100
        rev = p["financials"]["annual_revenue_eur"]
        ppa = p["financials"]["ppa_price_per_MWh"]
        rev_check = actual_mwh * ppa
        print(f"  {pid}: CF={cf:.1f}%, revenue check {rev:,.0f} vs MWh*PPA {rev_check:,.0f}")

    with open(PORTFOLIO_FILE, "w") as f:
        json.dump(data, f, indent=2)

    print(f"\n✓ Wrote {PORTFOLIO_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
