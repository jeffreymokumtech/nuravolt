# Model accuracy

> **This file is generated.** Run `python scripts/render_model_accuracy_doc.py`
> to rebuild it from `public/data/validation/summary.json`. Do not edit it by
> hand, and do not quote a number anywhere (sales asset, spec sheet, proposal)
> that does not appear here with a source path. A number with no artifact
> behind it does not go on a spec sheet.

Generated: `2026-08-21T08:30:39.368361Z` · 37 datasets · 16,101,021 samples

## How to read this

The **Basis** column matters more than the number next to it. It says how the
score was earned: on a site the model had never seen, on a held-out slice of
its own training data, or against a published reference. An in-distribution
score and a cross-plant score are not comparable, and we do not present them
as though they were.

The **Reference baseline** column is the same metric computed for a simpler
model on the identical sample, and the arrow is what the machine learning
adds over it. It answers the question a technical buyer asks first: is the
ML earning its place, or is it decoration? Where it is not earning its
place we say so, in this table, rather than leaving the comparison out.

`irradiance_scaling` is a least-squares line through irradiance, fitted on
the training window only. `physics_only` is the PVWatts physics twin.
`physics_perfect_irradiance` is an oracle: physics fed the *observed*
weather, which no real forecast can match, shown to separate weather
uncertainty from model error.

## Digital twin (expected vs actual power)

| Result | n | Basis | Reference baseline → ML uplift | Source |
|---|---|---|---|---|
| nMAE 6.57% of AC nameplate on 42,229 points, 35 walk-forward windows | 42,229 | Walk-forward out-of-sample | — | `public/data/validation/twin/twin_15min_dayone.json` |
| nMAE 6.68% of AC nameplate (bias +2.11%) on 42,229 points, 35 walk-forward windows · physics_only 6.61% -> ML uplift -1% | 42,229 | Walk-forward out-of-sample | physics_only 6.61% → -1% (**ML does not help**) | `public/data/validation/twin/twin_15min_alpha.json` |
| nMAE 9.31% of mean daily energy (bias +1.13%) on 5,847 points, 248 walk-forward windows · irradiance_scaling 8.51% -> ML uplift -9% | 5,847 | Walk-forward out-of-sample | irradiance_scaling 8.51% → -9% (**ML does not help**) | `public/data/validation/twin/twin_daily_energy_es_fleet.json` |
| nMAE 11.19% of mean daily energy (bias -0.04%) on 9,495 points · irradiance_scaling 8.90% -> ML uplift -26% | 9,495 | Cross-plant, unseen site | irradiance_scaling 8.90% → -26% (**ML does not help**) | `public/data/validation/twin/twin_daily_energy_leave_one_plant_out.json` |
| nMAE 10.04% of mean daily energy on 10,954 points · reference 8.90% -> ML uplift -13% | 10,954 | Walk-forward out-of-sample | baseline 8.90% → -13% (**ML does not help**) | `public/data/validation/twin/twin_feature_ablation.json` |
| nMAE 16.70% of mean daily energy on 10,954 points | 10,954 | Walk-forward out-of-sample | — | `public/data/validation/twin/twin_local_data_curve.json` |

## Soiling

| Result | n | Basis | Reference baseline → ML uplift | Source |
|---|---|---|---|---|
| 9 sites triaged: 2 high_confidence_production, 4 literature_only, 3 needs_dustiq_rollout | 9 | Transfer readiness | — | `public/data/validation/soiling/africa_transferability.json` |
| 1/3 sites within +/-30% of the climate prior | 3 | Literature vs observed gap | — | `public/data/validation/soiling/climate_prior_cross_check.json` |
| soiling_rate_during_dry_intervals_pct_per_day: p25 0.088 / p50 0.107 / p75 0.136 across 146 sites | 146 | Literature comparison | — | `public/data/validation/soiling/nrel_map_sites.json` |
| IWSR = 0.949 on 2,557 days (136 soiling intervals detected) | 2,557 | Ground-truth measurement | — | `public/data/validation/soiling/pvdaq_system_2107.json` |
| IWSR = 0.960 on 1,884 days (31 soiling intervals detected) | 1,884 | Ground-truth measurement | — | `public/data/validation/soiling/pvdaq_system_7334.json` |
| IWSR = 0.920 on 2,815 days (183 soiling intervals detected) | 2,815 | Ground-truth measurement | — | `public/data/validation/soiling/pvdaq_system_9069.json` |
| 7/7 plants resolved to the correct climate zone (100%) | 7 | Physics check | — | `public/data/validation/soiling/universal_dayone.json` |

*Planned, not yet run: `pvdaq_system_34`.*

## Forecasting

| Result | n | Basis | Reference baseline → ML uplift | Source |
|---|---|---|---|---|
| skill -0.032 vs persistence (nMAE 21.00% vs 20.36%) at h=24h on 1,024 periods · physics_perfect_irradiance 13.19% | 1,024 | Walk-forward out-of-sample | physics_perfect_irradiance 13.19% | `public/data/validation/forecast/forecast_dayahead_alpha_endogenous.json` |
| soiling-ratio MAE 1.44 pp (sd 0.54) at h=24h over 36 walk-forward windows | 2,799 | Walk-forward out-of-sample | — | `public/data/validation/forecast/forecast_soiling_sr_ribera.json` |

## PV fault detection and degradation

| Result | n | Basis | Reference baseline → ML uplift | Source |
|---|---|---|---|---|
| on 3 real plants the fixed-reference cascade never emits degradation, short_circuit at all | 5,952,959 | Operability, unlabelled | — | `public/data/validation/pv/classifier_class_mix_real_plants.json` |
| 4 published fault numbers traced to their classifiers; 0.835/0.519 comparable, 0.189 is a different implementation | 378,443 | Provenance audit | — | `public/data/validation/pv/classifier_provenance.json` |
| macro-F1 0.189 on 80,000 samples | 80,000 | Cross-dataset | — | `public/data/validation/pv/gpvs_cross_dataset.json` |
| macro-F1 0.835 on 99,481 samples | 99,481 | In-distribution, tuned | — | `public/data/validation/pv/lazzaretti_holdout.json` |
| macro-F1 0.998 on 99,481 samples | 99,481 | In-distribution split | — | `public/data/validation/pv/lazzaretti_lgbm.json` |
| macro-F1 0.519 on 99,481 samples | 99,481 | In-distribution, untuned | — | `public/data/validation/pv/lazzaretti_physics_blind.json` |
| 1.14 alerts/MW/month on 416 devices, FAILS the 1.0 gate · null tail 0.0020% vs theory 0.0032% (calibrated), signal 157.7x null · alert rate tracks plant size (rho +0.83) | 416 | Operability, unlabelled | — | `public/data/validation/pv/peer_inverter_underperformance_fleet.json` |
| Spearman -0.375 on 9 modules (WEAK NEGATIVE — partial transfer) | 9 | Cross-dataset | — | `public/data/validation/pv/rul_cross_dataset.json` |
| report present | 8,357,802 | Operability, unlabelled | — | `public/data/validation/pv/rule_firing_rates_real_plants.json` |
| fleet fade 0.886 %/yr mean, 0.724 %/yr median across 166 modules | 166 | Literature comparison | — | `public/data/validation/pv/sandia_pv_iv_el_degradation.json` |
| macro-F1 0.8348 unperturbed falls to 0.2677 on a rig of another size; 4 classes reach F1 0.000. Normalised, invariant to within 0.0 | 99,481 | Synthetic perturbation | — | `public/data/validation/pv/scale_transfer_lazzaretti.json` |
| macro-F1 0.183 on 200,000 samples | 200,000 | In-distribution, shipped code | — | `public/data/validation/pv/shipped_detector_lazzaretti.json` |
| macro-F1 0.196 on 200,000 samples | 200,000 | In-distribution, shipped code | — | `public/data/validation/pv/shipped_detector_lazzaretti_before_fixes.json` |
| macro-F1 0.202 on 200,000 samples | 200,000 | In-distribution, shipped code | — | `public/data/validation/pv/shipped_detector_lazzaretti_dwell1.json` |
| macro-F1 0.204 on 200,000 samples | 200,000 | In-distribution, shipped code | — | `public/data/validation/pv/shipped_detector_lazzaretti_v5.json` |

*Planned, not yet run: `sandia_sat_transfer`.*

## Battery (BESS)

| Result | n | Basis | Reference baseline → ML uplift | Source |
|---|---|---|---|---|
| 75% of cells within ±10% EOL (MAPE 21%) — naive baseline: linear extrapolation from first 25% of checkpoints | 20 | Cross-dataset | — | `public/data/validation/bess/lfp_secondlife_2025.json` |
| 50% of cells within ±10% EOL (MAPE 49%) — naive baseline: linear extrapolation from first 50 cycles | 4 | Cross-dataset | — | `public/data/validation/bess/nasa.json` |
| 1% of cells within ±10% EOL (MAPE 35%) — naive baseline: linear extrapolation from first 200 cycles | 89 | In-distribution, untuned | — | `public/data/validation/bess/severson.json` |
| 48% of cells within ±10% EOL (MAPE 19%) — our model: Ridge regression on delta-Q features (Severson 2019), cycles 10-100 | 123 | Leave-one-out | — | `public/data/validation/bess/severson_delta_q.json` |
| 49% of cells within ±10% EOL (MAPE 17%) — our model: LGBMRegressor (200 trees, depth 4, min_child=5) | 123 | Leave-one-out | — | `public/data/validation/bess/severson_lgbm.json` |

## Per fault: precision, recall, F1

Read this before the macro number above it. `Support` is how many rows of
that class the test set actually held; a class with small support carries a
noisy F1 and should not be quoted alone.

### `pv/gpvs_cross_dataset` — Cross-dataset

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `dc_link_capacitor_aging` | 0.407 | 0.921 | 0.565 | 10,000 |
| `grid_voltage_sag` | 1.000 | 0.461 | 0.631 | 10,000 |
| `grid_voltage_swell` | 0.000 | 0.000 | 0.000 | 10,000 |
| `inverter_overtemperature` | 0.000 | 0.000 | 0.000 | 10,000 |
| `irradiance_sensor_drift` | 0.000 | 0.000 | 0.000 | 10,000 |
| `normal` | 0.190 | 1.000 | 0.319 | 10,000 |
| `string_open_circuit` | 0.000 | 0.000 | 0.000 | 10,000 |
| `string_short_circuit` | 0.000 | 0.000 | 0.000 | 10,000 |

macro-F1 over all 8 classes **0.189** · over the 3 it ever predicts **0.505**

**Never detected** (present in the data, F1 exactly 0.000): `grid_voltage_swell`, `inverter_overtemperature`, `irradiance_sensor_drift`, `string_open_circuit`, `string_short_circuit`.

### `pv/lazzaretti_holdout` — In-distribution, tuned

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.828 | 0.891 | 0.859 | 59,230 |
| `short_circuit` | 0.977 | 0.989 | 0.983 | 1,203 |
| `degradation` | 0.463 | 0.963 | 0.625 | 2,062 |
| `open_circuit` | 0.991 | 1.000 | 0.995 | 1,183 |
| `partial_shading` | 0.795 | 0.645 | 0.712 | 35,803 |

macro-F1 over all 5 classes **0.835**

### `pv/lazzaretti_lgbm` — In-distribution split

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.999 | 0.998 | 0.998 | 59,230 |
| `short_circuit` | 0.998 | 0.998 | 0.998 | 1,203 |
| `degradation` | 0.999 | 1.000 | 0.999 | 2,062 |
| `open_circuit` | 0.998 | 1.000 | 0.999 | 1,183 |
| `partial_shading` | 0.996 | 0.998 | 0.997 | 35,803 |

macro-F1 over all 5 classes **0.998**

### `pv/lazzaretti_physics_blind` — In-distribution, untuned

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.781 | 0.945 | 0.855 | 59,230 |
| `short_circuit` | 0.000 | 0.000 | 0.000 | 1,203 |
| `degradation` | 0.000 | 0.000 | 0.000 | 2,062 |
| `open_circuit` | 0.992 | 1.000 | 0.996 | 1,183 |
| `partial_shading` | 0.874 | 0.646 | 0.743 | 35,803 |

macro-F1 over all 5 classes **0.519** · over the 3 it ever predicts **0.865**

**Never detected** (present in the data, F1 exactly 0.000): `short_circuit`, `degradation`.

### `pv/shipped_detector_lazzaretti` — In-distribution, shipped code

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.846 | 1.000 | 0.916 | 169,116 |
| `short_circuit` | 0.000 | 0.000 | 0.000 | 933 |
| `degradation` | 0.000 | 0.000 | 0.000 | 1,484 |
| `open_circuit` | 0.000 | 0.000 | 0.000 | 904 |
| `partial_shading` | 0.000 | 0.000 | 0.000 | 27,563 |

macro-F1 over all 5 classes **0.183** · over the 1 it ever predicts **0.916**

**Never detected** (present in the data, F1 exactly 0.000): `short_circuit`, `degradation`, `open_circuit`, `partial_shading`.

### `pv/shipped_detector_lazzaretti_before_fixes` — In-distribution, shipped code

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.852 | 0.976 | 0.910 | 169,116 |
| `short_circuit` | 0.000 | 0.000 | 0.000 | 933 |
| `degradation` | 0.000 | 0.000 | 0.000 | 1,484 |
| `open_circuit` | 0.040 | 0.278 | 0.070 | 904 |
| `partial_shading` | 0.000 | 0.000 | 0.000 | 27,563 |

macro-F1 over all 5 classes **0.196** · over the 2 it ever predicts **0.490**

**Never detected** (present in the data, F1 exactly 0.000): `short_circuit`, `degradation`, `partial_shading`.

### `pv/shipped_detector_lazzaretti_dwell1` — In-distribution, shipped code

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.846 | 0.998 | 0.916 | 169,116 |
| `short_circuit` | 0.000 | 0.000 | 0.000 | 933 |
| `degradation` | 0.000 | 0.000 | 0.000 | 1,484 |
| `open_circuit` | 0.149 | 0.071 | 0.096 | 904 |
| `partial_shading` | 0.000 | 0.000 | 0.000 | 27,563 |

macro-F1 over all 5 classes **0.202** · over the 2 it ever predicts **0.506**

**Never detected** (present in the data, F1 exactly 0.000): `short_circuit`, `degradation`, `partial_shading`.

### `pv/shipped_detector_lazzaretti_v5` — In-distribution, shipped code

| Fault | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| `normal` | 0.848 | 0.993 | 0.915 | 169,116 |
| `short_circuit` | 0.000 | 0.000 | 0.000 | 933 |
| `degradation` | 0.000 | 0.000 | 0.000 | 1,484 |
| `open_circuit` | 0.080 | 0.163 | 0.107 | 904 |
| `partial_shading` | 0.000 | 0.000 | 0.000 | 27,563 |

macro-F1 over all 5 classes **0.204** · over the 2 it ever predicts **0.511**

**Never detected** (present in the data, F1 exactly 0.000): `short_circuit`, `degradation`, `partial_shading`.

## What each basis means

| Basis | What it means |
|---|---|
| **Cross-dataset** | Scored on a different dataset than anything used in training or tuning. |
| **Cross-plant, unseen site** | Trained on other plants entirely and scored on a site the model had never seen. This is the day-one number for a new customer. |
| **Ground-truth measurement** | Compared against an independent reference measurement. |
| **Leave-one-out** | Each subject held out in turn from the same dataset. |
| **In-distribution, untuned** | Same dataset, but with thresholds that never saw it. The honest untuned baseline. |
| **In-distribution, shipped code** | Held-out rows of one dataset, scored by running the detector that actually ships rather than a research surrogate written to match it. It has its own basis because it is the only in-distribution row that measures the product: the surrogate scores are upper bounds on the approach, this is the code a customer receives. |
| **In-distribution split** | A random split of one dataset. Flattering; treat as an upper bound, not as field performance. |
| **In-distribution, tuned** | Held-out rows, but thresholds were tuned on the same dataset. |
| **Literature comparison** | Compared against published field results rather than a held-out split. |
| **Literature vs observed gap** | A deliberate check of where our published prior disagrees with observation. |
| **Operability, unlabelled** | Measured on real plants that carry no fault labels. This says how often the detector fires per MW per month, not how many real faults it caught. It is a shipping gate, not an accuracy figure. |
| **Physics check** | First-principles and lookup only. No model is trained, so there is nothing to overfit. |
| **Provenance audit** | Not a score. A record of which implementation produced which published number, and which comparisons between them are legitimate. |
| **Synthetic perturbation** | The same labelled dataset with its voltage and current channels rescaled to imitate a rig built with a different number of modules in series and strings in parallel. Isolates scale, holding physics and labels fixed. Necessary for transfer, not sufficient: fill factor, series resistance and temperature coefficient are not scale factors. |
| **Transfer readiness** | Which climate regimes we consider ourselves entitled to quote a number for at all. |
| **Walk-forward out-of-sample** | Refit on an expanding history, scored only on the next unseen window. This is what the model does in production. |

## Abbreviations

Every abbreviation used in this document, spelled out once:

| Short form | Means | In plain terms |
|---|---|---|
| **nMAE** | normalised mean absolute error | Average size of the error, expressed as a percentage of a stated reference (nameplate capacity, or mean daily energy) so it is comparable between plants of different sizes. |
| **nRMSE** | normalised root mean squared error | Like nMAE but penalises large misses more heavily. Always at least as large as nMAE. |
| **MBE** | mean bias error | The *signed* average error. Positive means we over-predict. Bias and accuracy are reported separately and never folded together. |
| **MAE** | mean absolute error | Average size of the error in the target's own units. |
| **MAPE** | mean absolute percentage error | Average error as a percentage of each individual value. Unstable near zero, so it is not used as a headline here. |
| **R²** | coefficient of determination | Share of variance explained. Reported in the JSON as a footnote only: on a solar power time series roughly 95% of the variance is just the day/night cycle, so a high R² is table stakes and a low one can coexist with an excellent error. |
| **SR** | soiling ratio | Actual output divided by clean-panel output. 0.98 means dirt is costing 2%. |
| **pp** | percentage points | The unit for a soiling-ratio error. "1 pp" means the SR estimate was off by 0.01. |
| **IWSR** | insolation-weighted soiling ratio | Annual soiling ratio weighted by how much sunlight each day carried, i.e. what soiling actually costs you in energy. |
| **POA** | plane of array | Irradiance measured in the plane the modules actually sit in, rather than horizontally. |
| **PR** | performance ratio | Measured output divided by the output the irradiance and nameplate say you should have got. |
| **RUL** | remaining useful life | How long until an asset crosses a defined engineering limit. |
| **EOL** | end of life | The cycle or date at which a battery cell reaches its capacity threshold. |
| **NWP** | numerical weather prediction | A real weather forecast model run, as opposed to a reanalysis of what already happened. |
| **LOO** | leave-one-out | Validation where each subject is held out in turn. |
| **F1 / macro-F1** | F1 score | Balance of precision and recall. "Macro" averages across classes equally, so a rare fault type counts as much as a common one. |
| **Spearman** | Spearman rank correlation | Whether the ordering is right, ignoring the absolute scale. Useful when a model ranks assets correctly but its absolute numbers are uncalibrated. |
| **Skill score** | skill score vs a baseline | `1 - nMAE_model / nMAE_baseline`. Above 0 the model beats the baseline; at or below 0 it does not, and should not ship. |
| **Persistence** | persistence baseline | The cheapest defensible forecast: "same as yesterday". The reference every forecast is measured against. |
