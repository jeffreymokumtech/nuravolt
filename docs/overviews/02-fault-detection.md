# Fault Detection

*Which component is failing, on which inverter, with the evidence attached.*

**Reading the numbers:** *precision* is how often an alert is right; *recall* is how many real faults were caught. Both matter and they trade off. A detector with high recall and low precision finds everything and wastes technician time; the reverse misses faults quietly. We publish both, per fault, because a single averaged score hides which faults a detector actually finds.

---

## What it does

<!-- ACCURACY-OK: 34 fault types, 31 emitting, 3 not yet <- doc:docs/FAULT_COVERAGE.md -->
**34 fault types** across eight component groups: inverters, DC and MPPT, strings, modules, trackers, grid and export, sensors and communications, and environmental. **31 emit today**; **3** are specified and not yet raised, and are marked as such. Each is a specific rule against specific telemetry rather than a general anomaly score, so an alert names the component to go and look at.

## The part that needs no calibration, and works on day one

<!-- ACCURACY-OK: 6 of the 34 are tier A <- doc:docs/FAULT_COVERAGE.md -->
The rules we are most confident about carry no number at all. **6 of the 34** compare a device against its sibling devices on the same bus at the same instant. Irradiance, ambient temperature, soiling, orientation, module technology and vendor all cancel, because every peer meets them at the same moment. There is no threshold in volts, amps or degrees to carry from our plants to yours.

They need four or more comparable siblings and no site history whatsoever.

<!-- ACCURACY-OK: 416 inverters <- pv/peer_inverter_underperformance_fleet.devices_total -->
<!-- ACCURACY-OK: 1.14 alerts per MW per month <- pv/peer_inverter_underperformance_fleet.alerts_per_mw_month -->
<!-- ACCURACY-OK: 157.7 times <- pv/peer_inverter_underperformance_fleet.null_calibration.signal_to_null_ratio -->
Measured across **416 inverters on six real plants**, with identical parameters on every plant: the peer underperformance rule fires **1.14** times per MW per month, and the harmless tail of the same two sided statistic puts the false alarm rate **157.7 times** below the signal. Our internal gate is one alert per MW per month, which this currently sits just above, so it is tightened before it reaches an operator's inbox rather than shipped at that rate.

<!-- ACCURACY-OK: 6 tier A, 17 tier B, 11 tier C <- doc:docs/FAULT_COVERAGE.md -->
Every rule is graded by how well it survives an unseen plant: **6 tier A** (peer relative, nothing to carry), **17 tier B** (anchored to physics, a grid code or a datasheet) and **11 tier C** (fitted to our fleet, so needing calibration on yours). That last number is the honest limitation of the current set, and it is what the peer relative work is steadily replacing.

## The part that is fitted, and what it scores

On 99,481 held out rows of the Lazzaretti public PV fault dataset:

| Fault | Precision | Recall | F1 | Rows tested |
|---|---|---|---|---|
<!-- ACCURACY-OK: precision 0.991 <- pv/lazzaretti_holdout.per_class.open_circuit.precision -->
<!-- ACCURACY-OK: recall 1.000 <- pv/lazzaretti_holdout.per_class.open_circuit.recall -->
<!-- ACCURACY-OK: F1 0.995 <- pv/lazzaretti_holdout.per_class.open_circuit.f1 -->
<!-- ACCURACY-OK: 1,183 rows <- pv/lazzaretti_holdout.per_class.open_circuit.support -->
| Open circuit | 0.991 | 1.000 | 0.995 | 1,183 |
<!-- ACCURACY-OK: precision 0.977 <- pv/lazzaretti_holdout.per_class.short_circuit.precision -->
<!-- ACCURACY-OK: recall 0.989 <- pv/lazzaretti_holdout.per_class.short_circuit.recall -->
<!-- ACCURACY-OK: F1 0.983 <- pv/lazzaretti_holdout.per_class.short_circuit.f1 -->
<!-- ACCURACY-OK: 1,203 rows <- pv/lazzaretti_holdout.per_class.short_circuit.support -->
| Short circuit | 0.977 | 0.989 | 0.983 | 1,203 |
<!-- ACCURACY-OK: precision 0.795 <- pv/lazzaretti_holdout.per_class.partial_shading.precision -->
<!-- ACCURACY-OK: recall 0.645 <- pv/lazzaretti_holdout.per_class.partial_shading.recall -->
<!-- ACCURACY-OK: F1 0.712 <- pv/lazzaretti_holdout.per_class.partial_shading.f1 -->
<!-- ACCURACY-OK: 35,803 rows <- pv/lazzaretti_holdout.per_class.partial_shading.support -->
| Partial shading | 0.795 | 0.645 | 0.712 | 35,803 |
<!-- ACCURACY-OK: precision 0.463 <- pv/lazzaretti_holdout.per_class.degradation.precision -->
<!-- ACCURACY-OK: recall 0.963 <- pv/lazzaretti_holdout.per_class.degradation.recall -->
<!-- ACCURACY-OK: F1 0.625 <- pv/lazzaretti_holdout.per_class.degradation.f1 -->
<!-- ACCURACY-OK: 2,062 rows <- pv/lazzaretti_holdout.per_class.degradation.support -->
| Degradation | 0.463 | 0.963 | 0.625 | 2,062 |
<!-- ACCURACY-OK: precision 0.828 <- pv/lazzaretti_holdout.per_class.normal.precision -->
<!-- ACCURACY-OK: recall 0.891 <- pv/lazzaretti_holdout.per_class.normal.recall -->
<!-- ACCURACY-OK: F1 0.859 <- pv/lazzaretti_holdout.per_class.normal.f1 -->
<!-- ACCURACY-OK: 59,230 rows <- pv/lazzaretti_holdout.per_class.normal.support -->
| Normal | 0.828 | 0.891 | 0.859 | 59,230 |
<!-- ACCURACY-OK: macro average 0.835 <- pv/lazzaretti_holdout.macro_f1 -->
<!-- ACCURACY-OK: 99,481 rows <- pv/lazzaretti_holdout.n_samples -->
| **Macro average** | | | **0.835** | 99,481 |

**Read the degradation row rather than the average.** It catches 96% of degradation events, but **54% of what it calls degradation is not degradation**. That is a real cost in technician time and you should know it before you buy, not after.

## What we do not claim

<!-- ACCURACY-OK: macro F1 0.183 <- pv/shipped_detector_lazzaretti.macro_f1 -->
**That 0.835 is an upper bound, not the shipped score.** It comes from a research surrogate whose thresholds were fitted to that dataset's own percentiles. The code we actually ship, run on the same rows, scores macro F1 **0.183** — because it is built for continuous time series with persistence requirements, and that dataset is a pile of unordered snapshots which cannot express them. Both numbers are published so nobody can pick the flattering one.

<!-- ACCURACY-OK: 0.835 falls to 0.268 <- pv/scale_transfer_lazzaretti.headline_macro_f1_unnormalised_worst -->
<!-- ACCURACY-OK: 5.95 million daylight measurements <- pv/classifier_class_mix_real_plants.n_samples millions -->
**Cross-plant accuracy for that classifier is unmeasured, and we tested why.** Rescaling the test set to imitate a rig with a different number of modules per string drops macro F1 from 0.835 to **0.268**, with four fault classes reaching exactly zero at some geometry. And across three real utility plants and **5.95 million** daylight measurements, the fixed-threshold version never once raised short circuit or degradation — those plants run several times the test rig's string voltage, putting every threshold permanently out of reach. A detector that raises nothing looks exactly like a healthy plant. The fix is to express thresholds as a fraction of your own plant's operating point, which can be estimated from your data with no labels.

<!-- ACCURACY-OK: no confirmed-on-inspection rate <- not-measured: requires a customer fleet with logged inspection outcomes, which we do not have -->
**No recall figure on a real plant, and no confirmed-on-inspection rate.** Real plants carry no fault labels, so nothing here says how many real faults were caught in the field. A confirmed-on-inspection rate needs a customer fleet with logged outcomes; we are not going to invent one. It is measurable on your plant during onboarding and we are happy to make it a contractual metric.

**Coverage depends on your telemetry.** String faults need per string current, MPPT faults need per MPPT power, capacitor and cooling models need inverter cabinet temperature. A rule whose signal is absent returns silently rather than failing loudly, so we map what is available during onboarding and tell you which of the 34 will be dark on your site.

---

*Per fault coverage, the tier of every rule, and the exact telemetry each one needs: `docs/FAULT_COVERAGE.md`, generated from the detector source so it cannot drift from what ships.*
