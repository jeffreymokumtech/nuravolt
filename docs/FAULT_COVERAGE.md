# Fault coverage, per fault

> **Generated.** Run `python scripts/render_fault_coverage_doc.py` to rebuild from the
> code. Do not edit by hand. The detector and signal columns are read out of
> `nuravolt/fault/rule_based.py` by AST inspection, so they cannot drift from what
> actually ships.

Validation snapshot: `2026-08-21T08:30:39.368361Z`

**34 fault types defined, 31 emitting, 3 specified but not emitting.**

By tier: 6 tier A, 17 tier B, 11 tier C.

## What the columns mean

**Emits** — whether any code path actually constructs an alert of this type. Three types
are defined and described but never raised; they are marked and must not be presented as
live.

**Tier** — how well the claim survives moving to a plant we have never seen. This is the
most important column and it is the one to read first:

| Tier | Meaning | Travels? |
|---|---|---|
| **A** | Peer-relative or self-referential. The device is judged against its own siblings at the same instant, so irradiance, temperature, plant size, orientation and vendor all cancel. There is no constant to carry to the next plant. | Yes, by construction |
| **B** | Anchored to physics, a published standard, a grid code or a datasheet. Not fitted to any dataset of ours. | Yes, as far as the standard applies |
| **C** | Fitted to our fleet. Needs per-plant calibration during onboarding, and must be disclosed as such. | Not without calibration |

Why this matters, in one line: the same rule set scores macro-F1 **0.835** with thresholds
tuned on a dataset, **0.519** with untuned physics defaults, and **0.189** on a different
plant architecture. Roughly a third of the in-distribution score is threshold fitting. Tier
is our estimate of which side of that gap a given fault sits on.

**Signals** — the telemetry columns the detector searches for. Column matching is by
substring, and a detector whose signal is absent returns silently, so a fault whose signals
your SCADA does not expose is simply dark rather than failing loudly.

**Validation** — an artifact under `public/data/validation/` that speaks to this fault. Most
have none: only 7 of the 33 have any public-dataset ground truth at all, and 5 of those 7
score F1 0.000 in the only cross-architecture test that has been run.

---

## Per fault

| Fault | Emits | Tier | Why that tier | Signals | Validation |
|---|---|---|---|---|---|
| `INVERTER_OFFLINE` | yes | **B** | Zero output during daylight is definitional, not fitted | `ac_kw`, `ac_power`, `ghi`, `irradiance` +3 | — |
| `INVERTER_CLIPPING` | yes | **B** | Ratio against nameplate; nameplate is a datasheet fact | `ac_kw`, `ac_power`, `dc_kw`, `dc_power` +2 | — |
| `INVERTER_OVERTEMPERATURE` | yes | **A** | Peer-relative since 2026-08-21: one machine hot against the siblings sharing its ambient. The absolute test now DECLINES unless the channel's semantics are declared, because the datasheet number is a rated ambient and the channel is usually a heatsink (measured p95 78.2 C in normal operation on delta, against a 60 C rated ambient) | `cabinet_temp`, `cell_temp`, `inverter_temp`, `inverter_temperature` +3 | pv/gpvs_cross_dataset.json (F1 0.000 cross-architecture) |
| `INVERTER_EFFICIENCY_DEGRADATION` | yes | **C** | 92%/88% are fleet defaults, not per-model efficiency curves | `ac_kw`, `ac_power`, `dc_kw`, `dc_power` +2 | — |
| `DC_LINK_CAPACITOR_AGING` | **no** | **C** | Specified, and the physics model exists, but no detector constructs the alert. | — | pv/gpvs_cross_dataset.json (F1 0.565 cross-architecture) |
| `DC_OVERVOLTAGE` | yes | **B** | Datasheet MPPT window; refuses to run without it | `dc_voltage`, `string_voltage`, `v_dc`, `vdc` | — |
| `DC_UNDERVOLTAGE` | yes | **B** | Datasheet MPPT window; refuses to run without it | `dc_voltage`, `string_voltage`, `v_dc`, `vdc` | — |
| `INVERTER_COOLING_DEGRADATION` | yes | **C** | Thermal twin residual; needs a twin trained per plant | — | — |
| `INVERTER_UNDERPERFORMANCE_PEER` | yes | **A** | One machine below the median of the siblings on its bus, sustained. Irradiance, ambient, soiling, orientation and vendor all cancel because every peer meets them at the same instant | — | pv/peer_inverter_underperformance_fleet.json (symmetric-tail null calibration)<br>pv/rule_firing_rates_real_plants.json (firing rate on 4 real plants) |
| `STRING_OPEN_CIRCUIT` | yes | **A** | Peer ratio to the leave-one-out sibling median AND the modified z of the same comparison, sustained. No amp value anywhere in the path | `current_string`, `i_string`, `idc`, `string_current` | pv/lazzaretti_holdout.json (F1 0.995, in-distribution)<br>pv/gpvs_cross_dataset.json (F1 0.000 cross-architecture) |
| `STRING_SHORT_CIRCUIT` | yes | **C** | Voltage ratio against a rolling baseline; partly self-referential | `i_string`, `idc`, `string_current`, `string_voltage` +2 | pv/lazzaretti_holdout.json (F1 0.983, in-distribution)<br>pv/gpvs_cross_dataset.json (F1 0.000 cross-architecture) |
| `STRING_MISMATCH_COARSE` | yes | **A** | The 0.85 ratio now has to clear the sibling DISPERSION too, which is what makes it mean the same thing on an array whose channels spread 2% and one that spreads 20% | `ghi`, `irradiance`, `poa_irradiance` | — |
| `STRING_DEGRADATION` | yes | **C** | Digital twin residual; twin is per plant | — | — |
| `MPPT_IMBALANCE` | yes | **A** | Median and MAD over self-normalised channels; dimensionless throughout | `ghi`, `irradiance`, `poa_irradiance` | — |
| `MPPT_HUNTING` | yes | **C** | Absolute 5 V oscillation and a count per hour | — | — |
| `TRACKER_STUCK` | yes | **B** | Angle variance near zero in daylight is definitional | `ghi`, `irradiance`, `poa_irradiance`, `tilt_angle` +3 | — |
| `TRACKER_MISALIGNED` | yes | **B** | Deviation from computed solar position; astronomy, not fitting | `optimal_angle`, `solar_elevation`, `sun_elevation`, `tracker_angle` +2 | — |
| `GRID_FREQUENCY_LOW` | yes | **B** | Grid code: 49.5 Hz | `ac_frequency`, `freq`, `frequency`, `grid_frequency` | — |
| `GRID_FREQUENCY_HIGH` | yes | **B** | Grid code: 50.5 Hz | `ac_frequency`, `freq`, `frequency`, `grid_frequency` | — |
| `GRID_VOLTAGE_SAG` | yes | **B** | Grid code: 90% of nominal | `ac_voltage`, `grid_voltage`, `vac`, `voltage_ac` | pv/gpvs_cross_dataset.json (F1 0.631 cross-architecture) |
| `GRID_VOLTAGE_SWELL` | yes | **B** | Grid code: 110% of nominal | `ac_voltage`, `grid_voltage`, `vac`, `voltage_ac` | pv/gpvs_cross_dataset.json (F1 0.000 cross-architecture) |
| `GRID_CURTAILMENT` | yes | **B** | Frequency offset triggering P-f response | `ac_frequency`, `ac_kw`, `ac_power`, `frequency` +2 | — |
| `EXPORT_CAP_ACTIVE` | yes | **B** | Against the contracted export limit | `ac_frequency`, `ac_kw`, `ac_power`, `frequency` +2 | — |
| `MODULE_OVERTEMPERATURE` | yes | **C** | 85 C is a fleet default, not a module datasheet limit | `cabinet_temp`, `cell_temp`, `inverter_temp`, `inverter_temperature` +3 | — |
| `MODULE_CURRENT_DEGRADATION` | **no** | **C** | Superseded by the planned peer-relative string deficit rule. | — | pv/sandia_pv_iv_el_degradation.json (fleet fade vs literature)<br>pv/rul_cross_dataset.json (Spearman -0.375, rank transfer only) |
| `MODULE_VOLTAGE_DROP` | **no** | **C** | Superseded by the planned peer-relative string voltage rule. | — | — |
| `BYPASS_DIODE_ACTIVE` | yes | **C** | The comparison is peer-relative, but the band's LOWER EDGE (0.06) is set by dispersion measured on our own fleet, not by physics: the p90 MAD between healthy MPPT inputs is 0.0103 per-unit, so the one-diode signature of 1.1% is inside the noise. Needs re-measuring on a new plant, and single-diode detection needs string-level voltage this telemetry does not carry | `dc_voltage`, `string_voltage`, `v_string`, `vdc` | — |
| `COMMUNICATION_LOSS` | yes | **B** | A data gap is definitional | — | — |
| `COMMUNICATION_PARTIAL` | yes | **B** | A channel that WAS reporting going null while its siblings continue is definitional. Judges device-local channels only: a shared pyranometer evaluated inside a per-inverter loop turned one outage into 28 alerts | `ac_power`, `dc_power`, `inverter_temp`, `inverter_temperature` +2 | — |
| `SENSOR_FROZEN` | yes | **A** | Run length of exactly identical consecutive values, gated to when the signal should be varying. Unit free, so it serves W/m2, degrees C and a power factor alike | `ghi`, `irradiance`, `poa`, `poa_irradiance` | — |
| `IRRADIANCE_SENSOR_DRIFT` | yes | **B** | Against a clear-sky model, which is astronomy plus atmosphere | `clearsky_ghi`, `clearsky_irradiance`, `ghi`, `ghi_clearsky` +2 | pv/gpvs_cross_dataset.json (F1 0.000 cross-architecture) |
| `SOILING_DETECTED` | yes | **C** | PR below 0.95 is a fleet default; real soiling rates vary by climate | `ac_kw`, `ac_power`, `clearsky_ghi`, `clearsky_irradiance` +5 | soiling/pvdaq_system_{2107,7334,9069}.json (IWSR 0.920-0.960 vs rdtools)<br>forecast/forecast_soiling_sr_ribera.json (1.44 pp vs reference sensor) |
| `VEGETATION_SHADING` | yes | **B** | Morning/afternoon asymmetry is geometric | `ac_kw`, `ac_power`, `datetime`, `ghi` +5 | — |
| `INSULATION_RESISTANCE_LOW` | yes | **B** | IEC 62446 limit | `insulation_resistance`, `iso_resistance`, `r_iso`, `riso` | — |

---

## The honest summary

- **11 of 34 are tier C**: they carry a number fitted to our fleet and
  will need calibration on a new site. That is the single biggest limitation of the current
  detector set, and it is what the peer-relative work is replacing.
- **3 are specified but never fire.** They are described in the code and were,
  until recently, described to customers as live.
- **Only 7 of 33 have any public-dataset ground truth**, and in the one cross-architecture
  test, 5 of those 7 score F1 exactly 0.000, because the rules cannot express themselves on
  a plant wired differently.
- **Every emitting rule has now been measured on four real plants** (`pv/rule_firing_rates_real_plants.json`), not by precision -- real plants carry no labels -- but by comparing each rule's firing rate against a stated plausible bound for its failure mode. 2 rule(s) still fire above their bound: `inverter_overtemperature`, `string_open_circuit`.
- Peer-relative inverter underperformance is additionally null-calibrated across 416
  inverters on 6 plants: the harmless tail of the same two-sided statistic gives a
  false-positive estimate of 0.0020% against a theoretical 0.0032%, with signal 158x
  the null.

Nothing here is recall. Real plants carry no fault labels, so no number in this document
says how many real faults were caught.

