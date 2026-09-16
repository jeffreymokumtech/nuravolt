---
title: Soiling and module cleaning: standard operating procedure
equipment_type: pv_modules
manufacturer: ""
model_number: ""
synthetic: true
revision: 1
---

# Soiling and module cleaning: SOP

## When to clean

A cleaning round is justified when **all three** of the following are true for
the same fleet segment:

1. The 14-day rolling soiling ratio (SR) is below 0.95 (i.e. >5% loss).
2. The 30-day forecast does not include a natural recovery event of
   ≥10 mm precipitation expected within the next 10 days.
3. The expected revenue recovery from cleaning exceeds the cleaning cost by
   a margin of at least 2× over a 30-day horizon.

If item 2 is true (rain is imminent), defer cleaning by at least 72 hours
past the forecast event and re-evaluate.

## Cleaning ROI calculation

Use the following relation, all values rolling over the last 14 days:

```
revenue_recovery_eur_30d = (1 - SR) × E_baseline_30d_kwh × tariff_eur_per_kwh
roi = revenue_recovery_eur_30d / cleaning_cost_eur
```

Trigger cleaning when `roi ≥ 2.0`. Adjust the threshold upward in regions
with high dust deposition cycles, downward in regions with stable soiling.

## Cleaning methods

| Method | Use when |
|---|---|
| Dry brushing (rotary) | SR loss is <10%, no cemented dust, dust is dry and loose. |
| Demineralised water rinse | SR loss is 10-20%, no surface cementation, water available. |
| Detergent + soft brush | Bird droppings, pollen, lichen, or cemented dust present. |
| High-pressure (>40 bar) | NEVER on modules. Will void OEM warranty and abrade ARC coating. |

Always rinse with demineralised water (conductivity <50 µS/cm). Tap water
leaves mineral residue that re-soils within days.

## Safety constraints

- Module surface temperature must be <40 °C at the start of the cleaning
  cycle. Cold water on hot glass risks thermal shock cracking.
- Disable string-level isolation before walking the array.
- Do not walk on modules: frame-loading only.
- Tracker arrays: park flat (0° tilt) and lock manually before cleaning.

## Post-cleaning validation

Within 5 sunlit days of cleaning, the per-tracker SR should recover to within
1% of the pre-soiling baseline. If recovery is <2%, the cleaning was
ineffective: investigate water quality and brushing pressure before
re-cleaning.
