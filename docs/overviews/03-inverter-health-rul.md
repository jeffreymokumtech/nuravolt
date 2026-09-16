# Inverter Health and Remaining Life

*Which inverter is ageing fastest, and why. This is the one page here that leads with a number we do not have.*

**Reading this page:** every other capability in this set is presented with a measured error. This one is presented without, on purpose. Predicting *when a component will fail* requires a population of components that were observed failing, with timestamps. No such public dataset exists for solar inverters, and we do not yet have one of our own. What we have instead is standard reliability physics, which tells you a component running hot is ageing faster and roughly by how much — but not the week it will fail.

---

## What runs today

**Peer relative overtemperature.** Each inverter is compared against the neighbours sharing its ambient at the same instant. No absolute temperature threshold is involved.

**Efficiency degradation.** DC to AC efficiency below 92% (warning) or 88% (critical) above 20% load.

**Cooling degradation.** From the thermal twin residual, on plants where a thermal twin has been trained on your inverters.

**Component life physics, where cabinet temperature exists:**

- *DC link capacitors.* Electrolytic capacitors fail by electrolyte loss, which raises equivalent series resistance. That growth follows an Arrhenius relationship with temperature, so a capacitor living at 70 C ages far faster than one at 50 C in a way that is calculable rather than guessed. We estimate current resistance from accumulated thermal history and report days until it reaches three times rated, the conventional end of life point. Activation energy 0.7 eV, per IEC 61709 and MIL-HDBK-217F.
- *IGBT power modules.* These fail from thermal *cycling* rather than absolute heat: bond wire and solder fatigue driven by the size and number of temperature swings. We count cycles from cabinet temperature and apply Coffin-Manson, where cycles to failure fall with the sixth power of swing amplitude.

Both report a health percentage and a remaining life in days, with tiered alerts at 15, 7 and 2 days. A capacitor and an IGBT can be at very different health on the same inverter and we report them separately, because they are different parts with different lead times and different costs.

**Built, not yet emitting:** DC link capacitor ageing as a *symptom* rule from DC bus voltage variance. The fault type is defined and the physics above is written, but no detector currently raises it. Scheduled, not shipping.

## What it needs from your SCADA

Inverter cabinet or heatsink temperature at 15 minute resolution, plus DC and AC power. **Without cabinet temperature the component life models do not run at all.**

## How good it is

<!-- ACCURACY-OK: no measured accuracy figure <- not-measured: no population of observed inverter component failures exists to validate against, publicly or in our own fleet -->
**There is no measured accuracy figure, and we will not supply one.** The capacitor and IGBT models are published reliability standards applied to your thermal history. They are not validated against a population of observed inverter failures, because we do not have one and nor does anyone publishing openly. Anyone quoting you a validated component level failure prediction accuracy for solar inverters should be asked which failures they observed, and how many.

<!-- ACCURACY-OK: Spearman rank correlation 0.375 <- pv/rul_cross_dataset.spearman_correlation_fade_vs_eol abs -->
<!-- ACCURACY-OK: 9 modules <- pv/rul_cross_dataset.n_modules_validated -->
**The one figure we do stand behind is a ranking, not a date.** On Sandia's public outdoor module fade data the model orders modules in the correct direction — faster fade means shorter life — at a **Spearman rank correlation of 0.375 across 9 modules**. That is weak to moderate, on a small sample. It is useful for deciding what to inspect first. It is not calibrated to give you an accurate day count.

<!-- ACCURACY-OK: 0.887 %/yr mean, 0.724 %/yr median <- pv/sandia_pv_iv_el_degradation.fleet_fade_rate_distribution_pct_per_year.mean -->
<!-- ACCURACY-OK: 166 modules <- pv/sandia_pv_iv_el_degradation.n_modules_with_fade_rate -->
**And a real measurement of how fast modules actually fade:** **0.887 %/yr mean, 0.724 %/yr median across 166 modules**, sitting inside the 0.5 to 1.0 %/yr range published by Jordan and Kurtz. That is a measured fleet statistic, not a model accuracy, and we quote it as one.

## What we withdrew, and why

A separate family of seven models predicted days until a degradation trend crosses an engineering limit. **We have withdrawn four of them outright and quote accuracy for none.**

- **Four were trained on invented inputs.** Hotspot counts, insulation resistance, humidity history and module age were generated with random numbers, from a dataset carrying none of those sensors. Two were never even produced as files. There is no signal there to recover, so they are withdrawn rather than retrained.
<!-- ACCURACY-OK: 7.18 days <- not-measured: quoted only to withdraw it; it is the error of inverting a formula, not of predicting a failure -->
- **All seven were labelled with a formula derived from one of their own inputs.** That makes the task algebraically invertible: the model was scored on how well it inverts a function it was handed. The tell is exact. One model's reported error of **7.18 days** is precisely what a perfect inverter of that formula would produce given the noise added to it. It was measuring the noise, not the failure.

The three that survive — string degradation, inverter thermal, string mismatch — use features from real measured signals and are being rebuilt on real event labels, meaning days until an event actually observed on a real plant, with proper handling of assets that never failed during the window. We will publish those numbers when the rebuild validates across plants, and not before.

## Why the gap exists at all

It is narrow and specific. No open dataset records inverters, capacitors, IGBTs or strings failing with timestamps. The public PV fault datasets label fault *states*, not time to failure — which is exactly why the withdrawn models had to fabricate their labels. Batteries are the counterexample: real run to failure data exists there, and the battery page shows what it lets us do.

Two routes are open, neither needing data we lack: build the module degradation model properly on the Sandia trajectories, which are real and already on disk, and derive component event labels from our own plants and five years of telemetry using the peer relative detectors.

---

*The full account, including how the invertible-label defect was found, is in `docs/MODEL_ACCURACY_METHODS.md`.*
