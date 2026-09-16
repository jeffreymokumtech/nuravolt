---
title: BESS warranty and degradation: operator reference
equipment_type: battery
manufacturer: ""
model_number: ""
synthetic: true
revision: 1
---

# BESS warranty and degradation: operator reference

This note summarises typical warranty bands and degradation behaviour for
commercial Li-ion BESS installations. It is a general operator reference,
not an OEM warranty document: always defer to the contract for binding
terms.

## Chemistry families

| Chemistry | Typical use | Cycle life (80% DoD) | Calendar life | Notes |
|---|---|---|---|---|
| LFP (LiFePO4) | Standard utility-scale BESS, residential | 4,000-6,000 cycles to 80% SoH | 15-20 years | Thermally stable, lower energy density, preferred for stationary storage. |
| NMC | Mobility-derived BESS, high-power applications | 2,000-3,500 cycles to 80% SoH | 10-15 years | Higher specific energy, more sensitive to high SoC dwell and high temperature. |

## Warranty structure (typical for utility BESS)

OEMs usually warrant the lower of two limits, whichever is reached first:

1. **Capacity retention**: e.g. ≥70% SoH at 10 years or ≥60% at 20 years.
2. **Energy throughput**: e.g. ≥X MWh AC discharged at the unit terminals
   over the life of the system.

Common warranty exclusions:
- Operation outside the OEM SoC window (typically 10-95%).
- Operation outside the OEM temperature window (typically 0-35 °C cell temp).
- Cycles exceeding the contracted cycles/day (typically 1.5-2 cycles/day for
  storage assets, higher for ancillary-services assets).
- Idle SoC dwell above 80% for extended periods (months).

Persistent SoC dwell above 90% accelerates calendar degradation by an
order of magnitude for NMC cells.

## Degradation drivers, ranked

For NMC:
1. High average SoC (especially >80%).
2. High average cell temperature (>30 °C).
3. Number of full-equivalent cycles.
4. Depth-of-discharge magnitude per cycle.

For LFP:
1. Number of full-equivalent cycles.
2. High average cell temperature (>35 °C).
3. High C-rate (>1C continuous).
4. SoC dwell is a much weaker factor than for NMC.

## When to escalate to the OEM

Open a warranty case when **any** of the following holds:

- Annualised SoH degradation exceeds 2× the contracted curve over a rolling
  90-day window.
- A single capacity test shows >5 percentage-point drop vs. the previous test.
- More than 2% of cells in a string show voltage deviation >50 mV at SoC 50%.

Always attach: cell-level voltage histograms, the last 90 days of
temperature and SoC traces, all relevant fault events from the BMS log.

## Operational levers under operator control

To slow degradation without changing dispatch revenue meaningfully:

- Cap upper SoC at 90% rather than 100% during low-revenue hours
  (overnight charging in arbitrage assets).
- Maintain cabinet HVAC setpoint at 20-22 °C; treat HVAC failure as a
  Priority-1 incident.
- Schedule capacity tests every 6 months and after any thermal event.
- Balance strings whenever cell delta exceeds 50 mV at 50% SoC.
