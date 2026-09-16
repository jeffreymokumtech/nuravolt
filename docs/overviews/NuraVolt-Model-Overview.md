# NuraVolt Model Overview

NuraVolt runs a connected set of models rather than a single black box. The digital twin sits at the root and feeds the downstream models (soiling, faults, forecasting). Below is what each model does, the signals it uses, what it outputs, and how accurate it is.

**On the numbers.** Every figure in this document comes from a validation artifact we can hand you, and most of them are computed against public research datasets you can download and re-run yourself. Where we do not have a defensible number, we say so instead of supplying one. Where a model does not beat a simpler alternative, we say that too. There are several such cases below.

If your question is specifically *what do I get on day one, before you have seen any of my data, and what does my own history buy after that*, that is answered capability by capability in a companion document, `docs/TRANSFER_AND_TUNING.md`.

## How to read the accuracy figures

Two conventions matter, and both are worth thirty seconds:

<!-- ACCURACY-OK: anything above 0.95 is table stakes <- not-measured: rhetorical illustration of why R squared is uninformative on a solar time series, not a measurement of any model -->
**We report normalised error, not R squared.** On a solar power time series roughly 95% of the variation is just the sun rising and setting, which even a straight line through irradiance reproduces. That makes R squared uninformative (anything above 0.95 is table stakes) and not comparable between sites, because it depends on how variable the test period was rather than on how good the model is. So we report **nMAE**, normalised mean absolute error: the average size of the error as a percentage of a stated reference, either the plant's AC nameplate or its mean daily energy. We always state which. We report **MBE**, mean bias error, separately and with its sign, because a model that is 5% high half the time and 5% low the other half is a very different thing from one that is 5% high consistently.

**We publish the baseline next to the model.** For every model we also compute what a deliberately simple alternative achieves on the identical data: plain calibrated physics for the twin, and "same as yesterday" for the forecast. If our machine learning is not beating that, the honest thing is to show you, and there are cases below where it does not.

---

## 1. Digital twin (expected vs actual power)

**Purpose:** benchmark real production against what the plant should be producing, at plant, inverter and string level, so that any shortfall is quantified rather than argued about.

**Signals:** plane of array irradiance, ambient temperature, wind speed, solar geometry, and plant configuration and physics (a PVWatts model calibrated to the site).

**Output:** expected power and quantified loss, updated every 15 minutes.

**Accuracy, measured.** On a 9.9 MW Spanish plant with five years of 15 minute data:

| | nMAE (% of AC nameplate) | Bias |
|---|---|---|
<!-- ACCURACY-OK: 6.6% nMAE <- twin/twin_15min_alpha.reference_nmae_pct -->
| Calibrated physics twin | **6.6%** | |
<!-- ACCURACY-OK: 6.7% nMAE <- twin/twin_15min_alpha.nmae_pct -->
<!-- ACCURACY-OK: +2.1% bias <- twin/twin_15min_alpha.mbe_pct -->
| Physics plus machine learning | 6.7% | +2.1% |

<!-- ACCURACY-OK: 42,229 intervals <- twin/twin_15min_alpha.n_samples -->
<!-- ACCURACY-OK: 35 windows <- twin/twin_15min_alpha.n_windows -->
<!-- ACCURACY-OK: 37.4% retained <- twin/twin_15min_alpha.retention.retention_pct -->
<!-- ACCURACY-OK: 345 outage intervals <- twin/twin_15min_alpha.retention.availability_excluded -->
<!-- ACCURACY-OK: 373 clipping intervals <- twin/twin_15min_alpha.retention.clipping_excluded -->
Measured over 42,229 fifteen minute intervals across 35 walk forward windows. Walk forward means the model was refit on an expanding history and scored only on the next month it had never seen, which is exactly what it does in production. Night, plant outages, inverter clipping and out of range sensor readings are excluded, and the exclusion counts are in the artifact: 37.4% of raw intervals are retained, with 345 outage intervals and 373 clipping intervals removed.

**Two things we want you to notice.** First, the machine learning layer is not currently earning its place: correctly calibrated physics does the same job. We would rather tell you that than sell you a black box. Second, the twin's accuracy depends far more on your irradiance sensing than on our modelling, which is why the data quality model in section 7 exists.

<!-- ACCURACY-OK: 11.2% nMAE <- twin/twin_daily_energy_leave_one_plant_out.nmae_pct -->
<!-- ACCURACY-OK: 9,495 plant days <- twin/twin_daily_energy_leave_one_plant_out.n_samples -->
**New sites.** Trained on six plants and scored on a seventh it had never seen, the twin reaches **11.2% nMAE of mean daily energy** across 9,495 plant days. That is the honest day one number for a site with no history. It tightens as site history accumulates and the physics model calibrates to your actual array.

<!-- ACCURACY-OK: 10.41% nMAE <- twin/twin_15min_dayone.day_zero_uncalibrated_nmae_pct -->
<!-- ACCURACY-OK: 6.57% nMAE <- twin/twin_15min_dayone.day_one_transferred_nmae_pct -->
<!-- ACCURACY-OK: 16.46% after 365 days <- twin/twin_local_data_curve.best_after_local_nmae_pct -->
<!-- ACCURACY-OK: 16.70% day one <- twin/twin_local_data_curve.day_one_nmae_pct -->
**How little we need from you.** With nothing but nameplate, coordinates, tilt and azimuth, and no calibration at all, the 15 minute physics twin reaches **10.41% nMAE**. A single transferred calibration scalar takes it to **6.57%**, and that scalar does not have to be yours. At daily energy resolution a full year of your own history moves the error from **16.70%** to **16.46%** — about 1%. We would rather you knew that before paying for a data migration.

---

## 2. Soiling estimation

**Purpose:** estimate the soiling ratio (actual output divided by clean panel output) per inverter or module group, and forecast it forward so cleaning can be scheduled on value rather than on the calendar.

**Signals:** digital twin loss signatures, aerosol optical depth, meteorological records including rainfall, and where present a calibrated soiling sensor for reference.

**Output:** estimated and forecast soiling ratio over time, with cleaning benefit and return on investment context.

**Accuracy, measured.** This is our strongest area.

| What | Result | Basis |
|---|---|---|
<!-- ACCURACY-OK: 1.44 percentage points MAE <- forecast/forecast_soiling_sr_ribera.mae_sr_pp -->
<!-- ACCURACY-OK: standard deviation 0.54 <- forecast/forecast_soiling_sr_ribera.mae_sr_pp_std -->
<!-- ACCURACY-OK: 36 windows <- forecast/forecast_soiling_sr_ribera.n_windows -->
<!-- ACCURACY-OK: 2,799 forecast days <- forecast/forecast_soiling_sr_ribera.n_samples -->
| Soiling ratio forecast vs a DustIQ reference sensor | **1.44 percentage points** mean absolute error (standard deviation 0.54) | 36 walk forward windows, 2,799 forecast days, one Spanish plant |
<!-- ACCURACY-OK: 0.920 <- soiling/pvdaq_system_9069.iwsr_p50 -->
<!-- ACCURACY-OK: 0.960 <- soiling/pvdaq_system_7334.iwsr_p50 -->
| Annual soiling agreement vs the rdtools open source reference method | **insolation weighted soiling ratio 0.920 to 0.960** | Three NREL PVDAQ public sites, 7,256 days total |
<!-- ACCURACY-OK: median 0.11% per day <- soiling/nrel_map_sites.distribution.p50 -->
<!-- ACCURACY-OK: 146 sites <- soiling/nrel_map_sites.n_sites -->
| Soiling rate vs published field measurements | median 0.11% per day | 146 US sites, NREL Soiling Map |

A percentage point here means an absolute error on the soiling ratio: 1.44 pp means an estimate of 0.98 when the true value was 0.9656. That is well inside the decision margin for a cleaning call at most soiling levels.

The rdtools comparison is worth singling out because you can reproduce it. rdtools is NREL's open source soiling analysis library, PVDAQ is NREL's public plant data archive, and the three systems are identified in our artifact. Nothing about that check depends on trusting us.

<!-- ACCURACY-OK: within 30% at 1 site <- soiling/climate_prior_cross_check.n_sites_within_30pct -->
<!-- ACCURACY-OK: out of 3 compared <- soiling/climate_prior_cross_check.n_sites_compared -->
**Where we do not transfer.** Checked against those same three sites, our climate prior (the estimate we give a site before it has any data) lands within plus or minus 30% of observed soiling at only one of the three. At the other two it under predicts, substantially. It is a rough first estimate, not a substitute for measurement, and we would expect to be recalibrating it against your data inside the first season. We publish that gap because you would find it anyway.

<!-- ACCURACY-OK: 25 valid intervals <- soiling/pvdaq_system_2107.n_valid_soiling_intervals -->
<!-- ACCURACY-OK: 2 valid intervals <- soiling/pvdaq_system_7334.n_valid_soiling_intervals -->
<!-- ACCURACY-OK: 12 valid intervals <- soiling/pvdaq_system_9069.n_valid_soiling_intervals -->
One more caveat on the rdtools comparison, since a reproducible check deserves an honest denominator: across those three sites rdtools identifies only 25, 2 and 12 *valid* soiling intervals respectively. The insolation weighted ratio is computed over thousands of days, but the number of distinct soiling episodes it rests on is small, and the middle site in particular is thin.

---

## 3. Fault detection and attribution

**Purpose:** detect and explain underperformance across strings and inverters (undercurrent, overcurrent, voltage and temperature patterns), and attribute it to a likely cause.

**Signals:** the family of digital twins plus inverter error codes and raw electrical telemetry.

**Output:** classified fault with likely cause, severity, and a suggested inspection step. An agentic layer interprets each signal, assigns a confidence score and filters before anything is raised.

### The part that needs no calibration

<!-- ACCURACY-OK: 6 of the 34 <- doc:docs/FAULT_COVERAGE.md -->
The rules we are most confident about are the ones that carry no number at all. **6 of the 34** fault types are judged peer relatively: a device is compared against the sibling devices on its own bus at the same instant, using the ratio to their median and how far outside their normal spread it sits. Irradiance, ambient temperature, soiling, orientation, module technology and vendor all cancel, because every peer meets them at the same moment. There is no threshold in volts, amps or degrees to carry from our plants to yours.

That is what makes them work on day one. They need four or more comparable siblings and no history at all.

<!-- ACCURACY-OK: 416 inverters <- pv/peer_inverter_underperformance_fleet.devices_total -->
<!-- ACCURACY-OK: 1.14 alerts <- pv/peer_inverter_underperformance_fleet.alerts_per_mw_month -->
<!-- ACCURACY-OK: 157.7 times <- pv/peer_inverter_underperformance_fleet.null_calibration.signal_to_null_ratio -->
Measured across **416 inverters on six real plants** with identical parameters on every plant: the peer underperformance rule fires **1.14** times per MW per month, and the same two sided statistic's harmless tail gives a false alarm estimate **157.7 times** below the signal. We hold ourselves to a gate of one alert per MW per month and this rule currently sits just above it, so it is tuned tighter before it reaches an operator's inbox rather than shipped at that rate.

### The part that is fitted, and the score it earns

**Accuracy, measured** on 99,481 held out rows of the Lazzaretti public PV fault dataset. Per fault, because a single averaged score hides which faults a detector actually finds:

| Fault class | Precision | Recall | F1 | Rows tested |
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
<!-- ACCURACY-OK: macro F1 0.835 <- pv/lazzaretti_holdout.macro_f1 -->
<!-- ACCURACY-OK: 99,481 rows <- pv/lazzaretti_holdout.n_samples -->
| **Macro average** | | **0.835** | 99,481 |

Read the degradation row rather than the average: it catches 96% of degradation events but **54% of what it calls degradation is not degradation**. That is a real cost in technician time and you should know it before you buy, not after.

<!-- ACCURACY-OK: macro F1 0.183 <- pv/shipped_detector_lazzaretti.macro_f1 -->
**And read the next line before you quote that one.** The 0.835 above is a *research surrogate*: a classifier whose thresholds were fitted to this dataset's own percentiles. It is an upper bound on what the approach can do, not the score of the code we ship. The shipped detector, run on the same rows, scores macro F1 **0.183**, because it is built for continuous time series with persistence requirements and this dataset is a pile of unordered snapshots that cannot express them. Neither number is the one you care about; both are published so nobody can pick the flattering one.

<!-- ACCURACY-OK: macro F1 0.189 <- not-measured: withdrawn; provenance in public/data/validation/pv/classifier_provenance.json -->
**A figure we have withdrawn.** An earlier version of this document said the same rule set scores macro F1 0.189 on a different public dataset. That was wrong, and the correction matters more than the number did. Those two figures came from **two different classifiers**. The 0.189 was produced by a separate implementation reading system level measurements, on a rig with no per string sensors and no irradiance channel at all — the classifier above physically cannot be run on it. So it never measured transfer, and the truth is plainer: **we have never had a second labelled dataset this classifier can read, so its cross-plant accuracy is unmeasured.**

What we did measure, rather than leave the gap unfilled:

<!-- ACCURACY-OK: 0.835 to 0.268 <- pv/scale_transfer_lazzaretti.headline_macro_f1_unnormalised_worst -->
- **Size sensitivity, exactly.** Rescaling the test set to imitate a rig with a different number of modules per string and strings per input drops macro F1 from 0.835 to **0.268**, and all four fault classes hit F1 of exactly 0.000 at some geometry. The thresholds were in volts and amps, and those are properties of one particular array.
<!-- ACCURACY-OK: 5.95 million measurements <- pv/classifier_class_mix_real_plants.n_samples millions -->
<!-- ACCURACY-OK: 653 to 788 V <- doc:docs/MODEL_ACCURACY_METHODS.md -->
- **On real hardware it goes silent rather than noisy.** Across three real utility plants and 5.95 million daylight measurements, that classifier never once raised short circuit or degradation — because those plants run at 653 to 788 V per string against the test rig's 270, which puts every voltage threshold permanently out of reach. A detector that raises nothing looks exactly like a healthy plant.
<!-- ACCURACY-OK: 0.014 macro F1 <- pv/scale_transfer_lazzaretti.cost_of_unsupervised_calibration -->
- **The fix, and its cost.** Expressing every threshold as a fraction of the plant's own operating point instead of in volts makes the score identical at every geometry tested, and the reference can be estimated from your own data with no labels and no commissioning paperwork. The price is **0.014 macro F1** for estimating it rather than being told it.

Onboarding therefore calibrates to your plant. What has changed is that we can now say what calibration is worth and what it is not: it removes the dependency on how your array is wired. It does not remove differences in module technology, soiling regime or sensor placement, and we are not going to claim it does.

<!-- ACCURACY-OK: no confirmed-on-inspection rate <- not-measured: requires a customer fleet with logged inspection outcomes -->
**What we do not have.** We do not have a confirmed on inspection rate, because that requires a customer fleet with logged inspection outcomes and we are not going to invent one. If a confirmed on inspection figure matters to your evaluation, it is measurable on your plant during onboarding and we are happy to make it a contractual metric. Equally, no number anywhere in this document is recall on a real plant: real plants carry no fault labels, so nothing here says how many real faults were caught.

### Component coverage

<!-- ACCURACY-OK: 34 fault types, 31 emitting, 3 pending <- doc:docs/FAULT_COVERAGE.md -->
34 fault types are defined across eight component groups, of which **31 currently emit** and three are specified but not yet raised. Each one is a specific rule against specific telemetry, not a general anomaly score, so an alert tells your team which component to go and look at. The pending ones are marked, because a count of defined types is not a count of working detectors and we would rather you heard that from us.

| Component group | Faults | What we watch for |
|---|---|---|
| **Inverter** | 6 live, 1 pending | Offline during daylight, clipping, overtemperature against sibling inverters, underperformance against sibling inverters, efficiency below 92% or 88% at load, cooling degradation from thermal twin residual. *Pending:* DC link capacitor ageing |
| **DC side and MPPT** | 4 | DC overvoltage and undervoltage against the MPPT window, MPPT power imbalance, MPPT hunting (voltage oscillation) |
| **Strings** | 4 | Open circuit, short circuit, coarse mismatch, sustained underperformance against the string digital twin |
| **Modules** | 3 live, 2 pending | Overtemperature, bypass diode activation, insulation resistance below the IEC 62446 limit. *Pending:* current degradation trend and voltage drop, both being rebuilt as peer relative rules |
| **Trackers** | 2 | Stuck (angle variance near zero in daylight), misaligned from calculated optimum |
| **Grid and export** | 6 | Frequency excursions outside 49.5 to 50.5 Hz, voltage sag and swell against nominal, curtailment, export cap active |
| **Sensors and communications** | 4 | Data loss, partial channel loss, frozen sensor, irradiance sensor drift against clear sky |
| **Environmental** | 2 | Soiling detected, vegetation shading (morning and afternoon asymmetry) |

<!-- ACCURACY-OK: 6 tier A, 17 tier B, 11 tier C <- doc:docs/FAULT_COVERAGE.md -->
We also grade every rule by how well it survives moving to a plant we have never seen: **6 are tier A** (peer relative, nothing to carry), **17 are tier B** (anchored to physics, a grid code or a datasheet) and **11 are tier C** (fitted to our fleet, and therefore needing calibration on yours). That last number is the single biggest limitation of the current detector set, and it is what the peer relative work is steadily replacing. The full per fault table, including which telemetry each rule needs, is in `docs/FAULT_COVERAGE.md` and is generated from the code so it cannot drift.

Coverage depends on what your SCADA actually exposes. String level faults need per string current, MPPT faults need per MPPT power, and the capacitor and cooling models need inverter cabinet temperature. A rule whose signal is missing returns silently rather than failing loudly, so we map what is available during onboarding and tell you plainly which of the 34 will be dark on your site.

---

## 4. Predictive and preventive inverter health

**Live today.** These run now, as threshold and twin residual rules on 15 minute telemetry:

- Inverter overtemperature, judged against the sibling inverters sharing the same ambient
- Inverter efficiency degradation, at efficiency below 92% (warning) or 88% (critical) above 20% load
- Inverter cooling degradation, from the thermal twin residual, on plants where a thermal twin has been trained

**Built but not yet emitting.** We would rather list this here than in the section above:

- DC link capacitor ageing as a *symptom* rule from DC bus voltage variance. The fault type is defined and the physics model below is written, but no detector currently raises it. It is scheduled, not shipping.

<!-- ACCURACY-OK: 78.2 C <- doc:docs/FAULT_COVERAGE.md -->
One thing we found while preparing this document, which is worth telling you because it is the kind of thing you would find yourselves: our absolute inverter overtemperature threshold was set against a *rated ambient* temperature, but the channel most plants actually expose is a heatsink or cabinet reading. On one of our reference sites the 95th percentile of that channel in entirely normal operation is **78.2 C**, against a 60 C rated ambient — so the rule fired constantly and meant nothing. It is now peer relative: each inverter is compared to its neighbours at the same moment, and the absolute test declines to run at all unless the channel's meaning has been declared. That is a much tighter test, and it needed no threshold from us.

### Component life models: capacitors and IGBTs

Two specific inverter components get a dedicated physics model rather than a threshold rule, because they are the two that most often take an inverter down and both degrade predictably with thermal history.

**DC link capacitors.** Electrolytic capacitors fail by electrolyte loss, which raises equivalent series resistance (ESR). ESR growth follows an Arrhenius relationship with temperature, so a capacitor that spends its life at 70 C ages far faster than one at 50 C, in a way that is calculable rather than guessed. A physics model estimates current ESR from accumulated thermal history and operating hours, and reports days until ESR reaches three times its rated value, the conventional end of life threshold. Activation energy 0.7 eV, per IEC 61709 and MIL-HDBK-217F reference conditions.

**IGBT power modules.** These fail from thermal cycling rather than absolute temperature: bond wire and solder fatigue driven by the size and number of temperature swings. We count thermal cycles from cabinet temperature, apply Coffin-Manson (cycles to failure falls with the sixth power of cycle amplitude), and accumulate damage cycle by cycle.

**Output.** Both models report a component health percentage and a remaining life in days, and the cascade raises tiered alerts: early warning below 15 days, critical below 7 days, imminent below 2 days. A capacitor and an IGBT can be at very different health on the same inverter, and we report them separately, because they are different parts with different lead times and different costs.

<!-- ACCURACY-OK: no measured accuracy figure <- not-measured: no population of observed inverter failures exists to validate against -->
**Requirements and honesty.** These need inverter cabinet temperature telemetry at 15 minute resolution and a thermal twin trained on your inverters during onboarding. Without cabinet temperature they do not run at all. And a limitation we want stated rather than discovered: **these are physics models with no measured accuracy figure.** They are built on published reliability standards and they are not validated against a population of observed inverter failures, because we do not have one. The physics is standard and well established. The claim we are entitled to make is that a component running hot is ageing faster and by roughly how much, not that we can name the week it will fail. Anyone quoting you a validated component level failure prediction accuracy for solar inverters should be asked which failures they observed and how many.

### Degradation trend life estimation

A separate family of models predicts days until a degradation trend crosses an engineering limit. **We are not quoting accuracy for any of them, and we have withdrawn four of the seven outright.**

The reasons are entirely ours and worth stating plainly, because they are the sort of thing that only ever comes out under scrutiny:

- **Four models were trained on invented inputs.** Hotspot counts, insulation resistance, humidity history and module age were synthesised with random number generators from a dataset that carries none of those sensors. Two of the four were never even produced as files. There is no signal there to recover, so they are withdrawn rather than retrained.
<!-- ACCURACY-OK: 7.18 days <- not-measured: the figure is quoted only to withdraw it; it was the error of inverting a formula, not of predicting a failure -->
- **All seven were labelled with a formula derived from one of their own inputs.** That makes the task algebraically invertible, so the model was being scored on how well it inverts a function it was handed. The tell is exact: one model's reported error of 7.18 days is precisely the error a perfect inverter of that formula would produce given the noise that was added. It was measuring the noise, not the failure.

The three that survive (string degradation, inverter thermal, string mismatch) use features derived from real measured signals. They are being rebuilt on real event labels, meaning days until an event we actually observed on a real plant, with proper handling of assets that never failed during the observation window. We will publish those numbers when the rebuild is validated across plants, and not before.

<!-- ACCURACY-OK: Spearman rank correlation 0.375 <- pv/rul_cross_dataset.spearman_correlation_fade_vs_eol abs -->
<!-- ACCURACY-OK: 9 modules <- pv/rul_cross_dataset.n_modules_validated -->
The one figure here we do stand behind is a cross dataset check on Sandia's public outdoor module fade data: the model orders modules in the correct direction (faster fade means shorter life) at a **Spearman rank correlation of 0.375 across 9 modules**. That is weak to moderate, on a small sample. It is useful for deciding what to inspect first and it is not calibrated to give you an accurate day count.

<!-- ACCURACY-OK: 0.887 %/yr mean <- pv/sandia_pv_iv_el_degradation.fleet_fade_rate_distribution_pct_per_year.mean -->
<!-- ACCURACY-OK: 0.724 %/yr median <- pv/sandia_pv_iv_el_degradation.fleet_fade_rate_distribution_pct_per_year.median -->
<!-- ACCURACY-OK: 166 modules <- pv/sandia_pv_iv_el_degradation.n_modules_with_fade_rate -->
What that same dataset does give us is a real measurement of how fast modules actually fade: **0.887 %/yr mean and 0.724 %/yr median across 166 modules**, which sits inside the 0.5 to 1.0 %/yr range published by Jordan and Kurtz. That is a measured fleet statistic, not a model accuracy, and we quote it as such.

**Why there is no PV component remaining life number at all.** The gap is narrow and specific. No open dataset records inverters, capacitors, IGBTs or strings failing with timestamps. Lazzaretti labels fault *states*, not time to failure. That absence is precisely why the seven models above fabricated their labels. Batteries are different, and section 6 shows what a real run to failure dataset lets us do.

---

## 5. What we forecast

Five things look forward, at very different horizons and very different levels of confidence. We would rather set that out explicitly than let "forecasting" sit in the proposal as one word.

| What | Horizon | Status |
|---|---|---|
<!-- ACCURACY-OK: 1.44 pp at one day <- forecast/forecast_soiling_sr_ribera.mae_sr_pp -->
| Soiling ratio | 1 to 365 days | **Measured: 1.44 pp at one day.** Multi horizon error not published, see below |
| Optimal cleaning schedule | 365 days | Live. An economic optimisation over the soiling forecast, not an accuracy claim |
<!-- ACCURACY-OK: no measured accuracy <- not-measured: physics based, no observed inverter component failures -->
| Capacitor and IGBT remaining life | days to end of life | Live where cabinet temperature exists. Physics based, no measured accuracy |
| Degradation trend life | up to 90 days | Withdrawn pending revalidation (section 4) |
| Battery state of health and warranty breach date | contract term | Modelled only. No battery telemetry yet (section 6) |
<!-- ACCURACY-OK: does not beat persistence <- not-measured: not quoted because the skill score is negative; the figure itself is in forecast/forecast_dayahead_alpha_endogenous.json -->
| Day ahead plant generation | 24 hours | **Not quoted. Does not currently beat persistence, see below** |

### Soiling, the one we are confident about

<!-- ACCURACY-OK: 1.44 percentage points <- forecast/forecast_soiling_sr_ribera.mae_sr_pp -->
<!-- ACCURACY-OK: 36 walk forward windows <- forecast/forecast_soiling_sr_ribera.n_windows -->
The soiling forecast is the model that drives real money for you, because it decides when a cleaning crew is worth paying for. Measured error is **1.44 percentage points** at a one day horizon across **36 walk forward windows**.

The 365 day forecast is what feeds the cleaning schedule optimiser: it simulates cleaning scenarios across the year, weights recovery by when the sun is actually worth something at your latitude, and returns the schedule that maximises net benefit rather than the one that maximises cleanliness.

**We are not publishing a multi horizon error curve yet.** We found a bug in our own backtest: it reuses a single prediction for every horizon, so its 3, 7, 14, 21 and 30 day rows are identical to the one day row and are not real. That is being fixed. Until it is, one day is the only horizon we will quote, and we are telling you about the bug rather than shipping the numbers it produced.

### Day ahead generation, and why we are not quoting it

<!-- ACCURACY-OK: skill score of minus 0.032 <- forecast/forecast_dayahead_alpha_endogenous.skill_score abs -->
Tested on five years of real 15 minute data, our day ahead plant energy forecast scores a **skill score of minus 0.032** against a persistence baseline. Persistence means "tomorrow will be like yesterday". A skill score below zero means our forecast is very slightly worse than that. Publishing an nMAE figure without that context would be misleading, so we are not going to.

<!-- ACCURACY-OK: 13.2% nMAE <- forecast/forecast_dayahead_alpha_endogenous.reference_nmae_pct -->
<!-- ACCURACY-OK: 21.0% nMAE <- forecast/forecast_dayahead_alpha_endogenous.nmae_pct -->
The cause is identifiable and fixable: the site has no numerical weather prediction (NWP) feed connected, so the model is forecasting from the plant's own history alone. The same physics model fed the *observed* irradiance reaches **13.2% nMAE** on the same days, against our **21.0%**. That gap is entirely weather uncertainty rather than model error, which tells us precisely where the work is: connect archived forecast weather, then re measure.

We would rather arrive at a bake off with a negative number we understand than a positive one we cannot defend.

---

## 6. Battery module (pilot)

**Status:** piloting. Active dispatch control is on the roadmap and is not live.

<!-- ACCURACY-OK: no state of health accuracy <- not-measured: no battery management system telemetry from a live site exists yet -->
**Important scope note.** We do not currently have battery management system telemetry from a live site. Every battery figure we produce today is modelled from real degradation algorithms over real published market prices against a declared nameplate, and it is tagged as provisional in the product. We are not going to quote a state of health accuracy against measured capacity, because we have not measured one.

**What end of life means here.** Every figure below predicts the *cycle count* at which a cell reaches its capacity threshold, which is 80% of nominal for lithium iron phosphate and a fixed 1.4 amp hours for the nickel manganese cobalt set. "Within plus or minus 10%" is the fraction of cells whose predicted end of life cycle lands within a tenth of the actual one.

| Method | Dataset | Cells genuinely predicted | Within plus or minus 10% |
|---|---|---|---|
<!-- ACCURACY-OK: 123 cells <- bess/severson_lgbm.n_cells -->
<!-- ACCURACY-OK: 48.8% <- bess/severson_lgbm.eol_within_10pct_fraction pct -->
| **Our model** (gradient boosting on delta-Q features) | Severson, LFP | **123** | **48.8%** |
<!-- ACCURACY-OK: 89 cells <- bess/severson.n_cells -->
<!-- ACCURACY-OK: 1% <- bess/severson.eol_within_10pct_fraction pct -->
| Standard linear extrapolation | Severson, LFP | 89 | **1%** |
<!-- ACCURACY-OK: 20 cells <- bess/lfp_secondlife_2025.n_cells -->
<!-- ACCURACY-OK: 75% <- bess/lfp_secondlife_2025.eol_within_10pct_fraction pct -->
| Standard linear extrapolation | LFP second life 2025 | 20 | 75% |
<!-- ACCURACY-OK: 4 cells <- bess/nasa.n_cells -->
<!-- ACCURACY-OK: 50% <- bess/nasa.eol_within_10pct_fraction pct -->
| Standard linear extrapolation | NASA, NMC | 4 | 50%, too few cells to mean anything |

**The comparison that matters is the first two rows.** They are the same cells. Our model sees cycles 10 to 100 of cells that live between 101 and 1,717 cycles, so roughly a sixth of a median cell's life, and places 48.8% of them within a tenth of their true end of life. Straight line extrapolation of the capacity curve, given twice that history, places 1%.

The reason our model can do this is that it does not extrapolate the capacity curve at all. It reads the *shape* of the voltage-capacity relationship between cycle 10 and cycle 100, following Severson and colleagues (Nature Energy, 2019). That signature moves long before capacity does, which is why the answer is available so early.

<!-- ACCURACY-OK: MAPE of 17% <- bess/severson_lgbm.mape pct -->
<!-- ACCURACY-OK: roughly 9% <- not-measured: Severson et al. 2019 published figure, quoted from the paper as a benchmark for our own -->
**And where we sit against the paper.** Severson and colleagues reported roughly 9% mean absolute percentage error on their primary test batch. Ours is **17%**, about double. We publish the comparison because a reader who knows the literature will make it anyway.

**Two things we corrected while preparing this document, and would rather you heard from us.**

First, our validation code used to hand the baseline the answer. On several failure paths it returned the number of cycles the cell had been measured for, which for a cell run to failure *is* its end of life. Those returns scored as perfect predictions. The baseline now abstains when it cannot predict, and abstentions are counted.

Second, we were scoring cells whose end of life fell *inside* the window the predictor is allowed to see. On the NASA set that was 9 of 13 cells: the model watched them fail and then reported the cycle they failed on. That is observation, not prediction, and those cells are now excluded. It is why the NASA row above reads 4 cells rather than 13, and why we will not quote a figure from it.

Neither correction changed our own model's result, which returned the label exactly zero times.

<!-- ACCURACY-OK: no measured accuracy for the product surfaces <- not-measured: no battery management system telemetry exists, so warranty, cycling, safety and revenue outputs are modelled and tagged provisional -->
**What the cell numbers do and do not cover.** They are cell cycle life on public laboratory data. They are not a validation of the battery product's other outputs. Warranty tracking, cycle counting, state of safety, revenue assurance and the optimizer audit run real algorithms over real published market prices, but against a *declared* nameplate and a *modelled* operating profile, because no measured telemetry exists to run them on. Every one of those outputs is tagged provisional in the product and in the database, and none of them carries a measured accuracy. When a real battery is connected, that changes and we will say so.

---

## 7. Data quality monitoring

**Purpose:** catch instrument problems, above all irradiance sensor drift, that would otherwise corrupt every number in this document. As section 1 notes, twin accuracy is bounded by irradiance sensing quality more than by modelling.

**Output:** alerts to inspect or recalibrate a sensor when it drifts beyond expectation, plus coverage and completeness reporting per data stream.

<!-- ACCURACY-OK: no accuracy figure to quote <- not-measured: these are deterministic bound checks, not statistical models, so there is no error to measure -->
These are deterministic checks against physical bounds and clear sky expectations, not statistical models, so there is no accuracy figure to quote and we do not present one. What we report instead is coverage: what fraction of expected intervals arrived, and what fraction were flagged.

---

## Notes

- **Cadence:** models run automatically on 15 minute data. No manual initiation is needed.
- **Deployment:** standard cloud (AWS), or on premise or your own cloud where data control requirements are stricter.
- **Reproducibility:** every figure above traces to a JSON artifact in our repository, and the public dataset results (Lazzaretti, NREL PVDAQ, NREL Soiling Map, Sandia, NASA, Severson) can be re run independently. We are glad to walk your engineers through the validation method for any individual model, including the ones that did not come out well.

## Abbreviations used above

| Short form | Means |
|---|---|
| nMAE | normalised mean absolute error: average error size as a percentage of a stated reference |
| MBE | mean bias error: the signed average error, reported separately from its magnitude |
| MAPE | mean absolute percentage error: average error as a percentage of the true value |
| pp | percentage points, the unit of a soiling ratio error |
| IWSR | insolation weighted soiling ratio: soiling weighted by how much sunlight each day carried |
| POA | plane of array: irradiance measured in the plane the modules sit in |
| PR | performance ratio: measured output divided by what irradiance and nameplate imply |
| RUL | remaining useful life: days until a degradation trend crosses a defined limit |
| ESR | equivalent series resistance: the internal resistance of a capacitor, which rises as it dries out. Three times its rated value is the conventional end of life point |
| IGBT | insulated gate bipolar transistor: the switching power module inside an inverter. Fails from thermal cycling rather than absolute heat |
| MPPT | maximum power point tracker: the inverter stage that holds each string array at its optimal voltage |
| Arrhenius | the standard chemical ageing relationship: reaction rate rises exponentially with temperature. Used here for capacitor dry out |
| Coffin-Manson | the standard metal fatigue relationship: cycles to failure fall steeply with the size of each temperature swing. Used here for IGBT bond wires |
| IEC 61709 / MIL-HDBK-217F | published reliability standards giving reference conditions and activation energies for electronic component ageing |
| EOL | end of life: the point at which a battery cell reaches its capacity threshold |
| NWP | numerical weather prediction: an actual weather forecast model run |
| F1 | balance of precision and recall; macro averaged counts each fault class equally |
| Skill score | 1 minus (model error divided by baseline error). Above zero beats the baseline |
| Walk forward | refit on an expanding history, scored only on the next unseen period |
| Tier A / B / C | how well a fault rule survives an unseen plant: peer relative, standards anchored, or fleet fitted |
