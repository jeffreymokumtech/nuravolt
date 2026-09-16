# Measuring what our models actually do

**A record of the work, the metrics, the methods, and the results that did not come out well.**

Status: living document. Last substantive update accompanies the peer-relative fault
detection prototype. Numbers here are reproduced from committed artifacts under
`public/data/validation/`; where a number appears with no artifact path, it is a
measurement made during investigation and labelled as such.

---

## 0. Why this document exists

A prospect asked for "all models with accuracy and lead times". That is a reasonable
question and we could not answer it honestly, because:

- The accuracy figures in our sales material were **invented**. A file called
  `modelAccuracyData.ts` carried the comment *"Generates realistic validation metrics
  for PDF export"*, and a shipped capabilities PDF published a table of design targets
  as though they were measured results, attributed to datasets the models were never
  scored on.
- The figures that were real were **wrong in the other direction**: a unit bug made the
  digital twin look far worse than it is.
- Nothing connected a published number to an artifact anyone could check.

The work below fixes that. The organising rule is one sentence:

> **A number with no committed artifact behind it does not go on a spec sheet.**

That rule is now enforced by `scripts/render_model_accuracy_doc.py` (which generates
`docs/MODEL_ACCURACY.md` from `public/data/validation/summary.json` and has a `--check`
staleness mode) and by `scripts/check_fabricated_metrics.py` (which greps for accuracy
claims outside that generated file).

---

## 1. Metric policy, and why we do not lead with R²

### The problem with R² on a power time series

Roughly 95% of the variance in a photovoltaic power series is the sun rising and setting.
A straight line through irradiance reproduces most of it. That makes R²:

- **uninformative** — anything above 0.95 is table stakes; and
- **not comparable between sites**, because it depends on the variance of the test window
  rather than on the quality of the model.

The clearest illustration is in our own data. An honest per-inverter soiling holdout
scores **R² = −8.37** at a mean absolute error of **0.0084 soiling ratio**. The R² is
catastrophic and the error is operationally excellent. Both describe the same model. The
R² is dominated by the fact that soiling ratio barely varies within a test window, so the
denominator of R² collapses.

### What we report instead

Capacity-normalised error, which is the convention in IEA-PVPS and IEA-Wind Task 36
forecast benchmarking, and what an EPC or IPP technical team expects:

| Metric | Definition | Normaliser |
|---|---|---|
| `nMAE_cap` | `mean(abs(y_hat - y)) / P_ac * 100` | AC nameplate |
| `nRMSE_cap` | `sqrt(mean((y_hat - y)^2)) / P_ac * 100` | AC nameplate |
| `MBE_cap` | `mean(y_hat - y) / P_ac * 100`, **signed** | AC nameplate |
| `nMAE_mean` | `mean(abs(E_hat - E)) / E_bar * 100` | test-set mean daily energy |

Three rules travel with them:

1. **Never mix normalisers in one table without labelling the column.** "6.7%" means
   nothing until you know whether it is a percentage of nameplate or of mean daily energy.
   `normalizer` and `normalizer_value` are required fields on every twin report.
2. **Bias is reported separately and with its sign.** A model that is 5% high half the
   time and 5% low the rest is a very different thing from one that is 5% high always,
   and folding bias into MAE hides the difference.
3. **R² is kept in the JSON as a footnote and never used as a headline.**

### Filters, and why the counts are published

Twin error is computed on a filtered sample, and every filter step is counted in the
artifact (`n_raw`, `n_after_*`, `retention_pct`, `availability_excluded_pct`):

1. **Daylight** — irradiance at least 50 W/m² and solar elevation above 5°.
2. **Availability** — drop nulls, and drop intervals where power is zero while irradiance
   is above 200 W/m². Those are plant outages, which are a plant event, not twin error.
3. **Clipping** — drop intervals at or above 98% of AC nameplate, where the inverter and
   not the model is the binding constraint. On Alpha this is 373 of 177,400 intervals.
4. **Sensor sanity** — irradiance at most 1400 W/m², ambient temperature within [−10, 55] °C.

A headline error number without a retention figure can hide arbitrarily much, so the
retention block is mandatory. Alpha retains 37.4% of raw intervals, almost all of the
loss being night.

---

## 2. The honesty tags

Every artifact carries a `distribution_relationship` tag, and the generated accuracy
document renders it as a **Basis** column. The tag matters more than the number beside it,
because an in-distribution score and a cross-plant score are not comparable and must not be
presented as though they were.

| Tag | Meaning |
|---|---|
| `walk_forward_oos` | Refit on an expanding history, scored only on the next unseen window. What the model does in production. |
| `cross_plant_transfer` | Trained on other plants entirely, scored on a site never seen. The day-one number for a new customer. |
| `cross_dist` | Scored on a different dataset than anything used in training or tuning. |
| `ground_truth_measurement` | Compared against an independent reference measurement. |
| `literature_comparison` | Compared against published field results. |
| `literature_vs_observed` | A deliberate check of where our published prior disagrees with observation. |
| `physics_check` | First principles and lookup only; nothing is trained, so nothing can overfit. |
| `transfer_readiness` | Which climate regimes we consider ourselves entitled to quote a number for at all. |
| `operability_no_labels` | Measured on real plants with no fault labels. Says how often a detector fires, **not** how many real faults it caught. |
| `in_dist_*` | Same dataset, with varying degrees of tuning. Treat as an upper bound. |

---

## 3. The single most important number in this document

Three scores on the **identical 99,481 held-out rows**:

| Condition | macro-F1 | Artifact |
|---|---|---|
| Thresholds tuned on that dataset | **0.835** | `pv/lazzaretti_holdout.json` |
| Physics defaults that never saw the data | **0.519** | `pv/lazzaretti_physics_blind.json` |
| A different plant architecture entirely | **0.189** | `pv/gpvs_cross_dataset.json` |

**Roughly a third of the in-distribution score is threshold fitting rather than detection
skill.** We define this as the overfitting tax:

```
overfitting_tax = (tuned - untuned) / tuned = (0.8348 - 0.5188) / 0.8348 = 37.9%
```

The cross-domain collapse to 0.189 has four causes, in order of magnitude, and only the
third is about thresholds:

1. **Feature shape and sensor semantics.** Every discriminator in the tuned rule set is an
   inter-string imbalance. A single-array system has nothing to difference against, so the
   rules cannot express themselves at all. Five of eight classes score F1 exactly 0.000
   because the classifier can only emit three labels.
2. **Temporal scope.** The comparison dataset is a 100 kHz event trace where most rows in a
   fault file look normal. Scoring per row against a file-level fault label is a category error.
3. **Absolute voltage-scale thresholds** such as `SHORT_CIRCUIT_V_MEAN_MAX = 245.0` and
   `EXPECTED_CURRENT_PER_W_M2 = 0.009`. Neither rule set is actually scale-invariant,
   despite being labelled "plant-agnostic".
4. **Taxonomy mismatch**, 5 classes against 8.

A model trained on the second dataset's own shape reaches **0.766** on the same rows, which
proves the ceiling is methodological rather than informational. The information is there;
our method could not reach it.

**This is why fault detection is now tiered** (section 6).

---

## 4. The digital twin: a unit bug, not a bad model

### What was wrong

Eight committed twin artifacts reported `physics_r2` of roughly **−13,000**. The chain:

1. `scripts/train_hybrid_models.py::find_power_column` returned on the first column whose
   name contained `normalized`. In the Spanish SCADA that is a *single inverter's* per-unit
   kW/kWp column, range 0 to 0.84 — never the plant-level `Power by Inverter (kW)`, range
   0 to 9,818.
2. Physics was then built at `p_rated: 60.0` kW.
3. `PVWattsPhysicsModel.calibrate` computed the true correction factor, about 0.02, failed
   its own `0.5 <= factor <= 1.5` sanity check, and **silently reset it to 1.0**.

Every one of the eight artifacts carries `"calibrationFactor": 1.0`. That is the fingerprint.
Because the machine learning layer then learned a residual of about −22 kW against a 0.2
per-unit target, it was re-learning the physics curve itself, which is why `ml_r2` reads
0.9998 in every file while overall R² lands between 0.32 and 0.72 with two plants negative.

### What was done

- Explicit per-plant `power_col` and `power_units` instead of pattern guessing.
- Capacities derived once and frozen into config, with the derivation written down.
- `calibrate` now **raises `CalibrationScaleError`** instead of silently resetting. A factor
  far from 1 is definitionally a unit error, and the silent fallback is what turned a
  thirty-second bug into eight shipped artifacts.
- Calibration restricted to the training window; it previously ran on the full frame before
  the split, leaking the test period into the physics baseline.

### What it measures now

| Result | Basis | Artifact |
|---|---|---|
| **nMAE 6.61% of AC nameplate** (physics alone), 6.68% (hybrid), bias +2.11%, 42,229 intervals, 35 walk-forward windows | walk-forward out-of-sample | `twin/twin_15min_alpha.json` |
| **nMAE 9.31% of mean daily energy**, 5,847 plant-days, 248 windows | walk-forward out-of-sample | `twin/twin_daily_energy_es_fleet.json` |
| **nMAE 11.19% of mean daily energy**, 9,495 plant-days | cross-plant, unseen site | `twin/twin_daily_energy_leave_one_plant_out.json` |

The calibration factor now lands between **1.1198 and 1.1578** across all 35 windows,
comfortably inside the sanity band it used to fail.

---

## 5. Where machine learning did not earn its place

Every twin and forecast report carries a **named reference baseline** and the uplift the
model achieves over it on the identical sample (`reference_baseline`,
`uplift_vs_reference_pct` in `nuravolt/validation/metrics/twin.py`). This exists because the
question a technical buyer asks first is whether the ML is doing anything.

The answer, so far, is largely no:

| Protocol | Model | Reference | Uplift |
|---|---|---|---|
| 15-minute twin, Alpha | gradient boosting on the physics residual | calibrated PVWatts physics | **−1%** |
| Daily-energy twin, 6-plant fleet | gradient boosting | fitted irradiance line | **−9%** |
| Daily-energy twin, unseen plant | gradient boosting | fitted irradiance line | **−26%** |

Three independent protocols, the same direction. The honest reading, stated in the artifact,
is bounded: what was scored is a gradient-boosted residual model over six features, **not**
the product's full hybrid with the complete physics feature set. So the claim is *"residual
boosting over these features does not improve on correctly calibrated physics at this
resolution"*, not *"machine learning cannot help"*. What it does establish is that **the
physics twin carries the accuracy on its own**, and any ML layer must be measured against
it rather than assumed to add value.

This became a standing policy: **the simplest model wins by default, and ML ships only if it
proves uplift on the identical sample.**

---

## 6. Fault detection: tiers, and why they are falsifiable

### The tier system

Given section 3, new fault detectors carry a tier that states how well the claim travels:

- **Tier A — peer-relative or self-referential.** No portable constant exists to get wrong.
  A device is scored against its siblings at the same instant, so irradiance, temperature,
  plant size, orientation, soiling and vendor all cancel.
- **Tier B — physics- or standards-anchored.** IEC 62446 insulation limits, grid-code
  frequency bands, IEC 61709 activation energies. Not fitted to any dataset.
- **Tier C — per-plant fitted.** Requires onboarding calibration and must be disclosed.

### The rule that makes the tier claim falsifiable

> **A tier A fault whose overfitting tax exceeds 10% is mislabelled and is re-tiered to C.**

Without that, "tier A" is marketing. With it, the label is a prediction that can fail.

### Anti-overfitting doctrine

1. Robust statistics only — median and MAD, never mean and standard deviation.
2. A parameter budget: tier A detectors get at most three parameters, all dimensionless.
3. Leave-one-plant-out is the only publishable number.
4. Nested cross-validation; hyperparameters never see the held-out plant.
5. A lockbox plant (`delta`), never used during development.
6. A standing tuned-versus-untuned gate per fault.
7. No absolute-unit constant in a tier A code path — a CI grep gate.
8. Simplest model wins by default.

### Why median and MAD is load-bearing, not stylistic

A mean/standard-deviation test estimates its dispersion **from a population that contains
the outlier**, so one badly failing device inflates the band meant to catch it: the worse it
gets, the wider the band it is measured against. Median and MAD have a 50% breakdown point.

Demonstrated on five devices, one of which has failed to 20% of its peers:

```
values          [10.0, 10.1, 9.9, 10.05, 2.0]
modified z      [0.00, 0.67, -0.67, 0.34, -53.96]   <- flagged hard
classic z       [0.44, 0.47, 0.42, 0.46,  -1.79]   <- hides below any sane threshold
```

The primitive lives in `nuravolt/stats/robust.py`, promoted from the battery module that
first needed it, and uses the Iglewicz-Hoaglin formulation
(`mz = 0.6745 * (x - median) / MAD`, ASTM 1993; NIST/SEMATECH 1.3.5.17).

---

## 6b. The peer-relative rewrite

Section 6 states the tier doctrine. This section is what happened when it was applied to
the rules that were still absolute.

### The architectural constraint that forced absolute thresholds

`scripts/run_fault_detection.py::run_fault_detection_single_inverter` slices one inverter's
columns and renames them before calling `detect_all`. **The detector structurally could not
see a sibling machine.** Every inverter-grain rule therefore had to compare against a
constant: a temperature limit, a voltage step in volts, a current in amps. That is not a
style choice anyone made; it is what the call shape allowed.

`RuleBasedFaultDetector.detect_plant_level` is the change that lifts it, and
`nuravolt/fault/peer_stats.py` is the one statistic every rule now shares.

### The statistic

Two numbers per device per timestamp, and every detector fires on their conjunction:

```
ratio = y_i / median(y_j, j != i)
z     = 0.6745 * (y_i - median(y_j)) / MAD(y_j)      # Iglewicz-Hoaglin
```

Each fails where the other works, which is why both are required:

- The **ratio** is scale free — the property that lets one rule serve a 3 A residential
  string and a 15 A utility one — but it is noisy at low output, where a small absolute
  gap is a large relative one.
- The **z** asks whether the shortfall is large *against how much these siblings normally
  differ*. A ratio of 0.84 is unremarkable on an array whose channels legitimately spread
  and damning on one where they track within 2%. Nothing but the dispersion distinguishes
  those two plants, which is exactly why a flat 0.85 did not travel.
- The z explodes when a fleet is uniform and the MAD tends to zero, so it carries a floor.

**Leave-one-out is load-bearing, not fastidious.** With four channels and one dead, an
all-columns median already sits between the healthy value and zero: the reference has been
pulled toward the very fault it is meant to reveal. Above eight siblings the reference is
shared for cost reasons — one device moves a median of nine by at most one order statistic —
and below it the exact leave-one-out is kept, because that is the regime where it decides
outcomes.

### Temperature is an interval scale, so it uses differences

`peer_deficit` gates on a ratio; `peer_excess` gates on a difference. This is not
symmetry for its own sake. A ratio of two Celsius readings is not a physical quantity —
Celsius has an arbitrary zero, so `t_i / median(t)` changes meaning in Kelvin. Differences
are correct on an interval scale and ratios are not. Any signal without a true zero
(temperature, power factor, phase angle) belongs in `peer_excess`.

### Rules moved, and what was actually wrong with each

| Rule | What the old test measured | What it measures now |
|---|---|---|
| `string_open_circuit` | ratio to a sibling median at a flat 0.05 | + z, + a four-interval dwell |
| `string_mismatch_coarse` | ratio to a sibling median at a flat 0.85 | + z, so 0.85 means something on the next plant |
| `bypass_diode_active` | consecutive-sample voltage **differences** of 10–30 V | a sustained voltage **level** deficit in the one-to-three-diode band |
| `inverter_overtemperature` | a rated **ambient** compared to a **heatsink** reading | one machine hot against the siblings sharing its ambient |
| `communication_partial` | whole-record null share, one alert spanning everything | a channel that *was* reporting and stopped while siblings continued |

Three of those five were not detecting their failure mode at all:

- **Bypass diode** fired on 14.6–16.0% of daylight intervals across three plants, 32 times
  the plausible bound, because normal MPPT tracking moves string voltage by tens of volts
  between samples. It was detecting the tracker working. A conducting diode is a *level*,
  is *differential* against siblings, and has a *characteristic depth* — one diode spans 20
  cells of a 60-cell module, so it removes `1/(3M)` of an M-module string's voltage, about
  1% for a 20-module string. Being a band rather than a threshold is also what stops this
  rule and the mismatch rule both claiming the same fault.

  **The first rewrite of this rule was wrong, and measurement caught it.** The band was set
  from module construction alone — 1.1% to 10% — with a 0.2% dispersion floor justified on
  the theory that paralleled strings share a voltage. That is true *within* one MPPT input
  and false *between* them, which is what the comparison actually spans, and the rule went
  to 9–11 times its bound on two plants. Sampling healthy inverters on delta, the MAD
  between MPPT inputs is **0.0038 per-unit at the median and 0.0103 at p90** — the
  single-diode signature sits inside the normal spread, and no threshold separates them.
  The band's lower edge is therefore **0.06, not 0.011**, and the reason is the telemetry:
  `U_DC` is reported per MPPT input, and detecting one diode needs string-level voltage
  behind a single input, which no connector here provides. The rule now claims a fully
  bypassed module and says so.
- **Overtemperature** compared a 60 C rated ambient plus a 15 C cabinet allowance against a
  channel whose 95th percentile in normal operation is 78.2 C — because it is a heatsink
  reading, and heatsinks are supposed to run hot. 167 times the plausible bound. The
  absolute test now declines unless the channel's semantics are declared, and the peer test
  carries the detection, which is the right home for it: whether 78 C is hot depends
  entirely on what the machines beside it read at that instant.
- **Partial communication loss** computed a whole-record null percentage and emitted one
  alert spanning the entire record. A plant that simply does not instrument a channel scored
  100% null forever and was permanently in alarm.

### The shading finding

`string_open_circuit` survived the first rewrite still firing at 12 times its bound on one
plant. Grouping its trips by hour of day settled what it was:

```
hour      08      09      10      11      12      13      14      15
rate    7.26%   7.55%   3.45%   1.57%   1.59%   1.58%   3.85%   7.72%
```

A 4.7× morning-and-afternoon excess with a clean midday trough. **A disconnected string
does not reconnect at noon and disconnect again at 15:00.** Low sun putting one string
behind the row in front does exactly that. The rule was reporting row shading.

The gate that admitted it was `min_peer_output_pu = 0.15`: a sibling median at 15% of
capacity is early morning. Requiring half capacity means the sun is high enough that
inter-row shading has cleared. Sweeping it, the morning excess falls **4.7× → 1.9× → 0.0×**
at 0.15, 0.30 and 0.50, and the overall trip rate falls 3.67% → 0.99%. The signature
disappears exactly where the physics says it should, which is what makes 0.50 a measurement
rather than a knob that happened to help.

The cost is stated: an open circuit is not detected while the array is below half output. A
genuinely open string is open at midday too.

### Two defects the rewrite exposed

**A plant-level signal must not be judged inside a per-inverter loop.** The comms rule
originally included plane-of-array irradiance among the channels it compared. That comes
from one shared pyranometer, and the detector runs once per inverter, so a single sensor
outage became 28 identical alerts and put the rule at 4.5 times its bound. The rule now
judges device-local channels only; the pyranometer is monitored once, at plant level, by
`sensor_frozen` and `irradiance_sensor_drift`.

**A silent zero is indistinguishable from a healthy plant.** eta's metadata calls its
inverters `WR.01.001` (*Wechselrichter*) while its telemetry says `INV 01.001`. A naive
match resolves zero devices and the peer rules return a clean result computed from nothing.
`topology.resolve_device_columns` reconciles the two by digit sequence and **raises** below
50% coverage; `detect_plant_level` logs every group it declines to score.

### Limits, stated because they are easy to rediscover the hard way

**Self-normalisation cancels a permanently deficient channel.** Dividing each channel by its
own 99th percentile is what makes an input with three strings paralleled into it comparable
to one with a single string. The price is exact: a channel deficient for its *entire* record
is rescaled to look healthy, because nothing in the data distinguishes "this input has one
string" from "this input had two and one died before our history starts". These rules detect
degradation that **started within the record**. Catching a fault that predates all available
history needs the string count from the commissioning drawing, not statistics.

**The MAD floor presumes per-unit input.** The ratio is scale free; the z is not, because the
floor is an absolute number — and it has to be, or a uniform healthy fleet makes every speck
of noise enormous. Callers normalise first, and then 0.02 means "2% of this channel's own
capacity" everywhere. Hand the kernel raw amps and the ratio stays right while the z quietly
stops meaning anything. Both properties are pinned in `tests/fault/test_peer_kernel.py`.

**The dispersion floor, not the physics, sets a rule's real sensitivity.** The modified z
only reaches its 3.5 flag at a deficit of `mad_floor * 3.5 / 0.6745`. With the diode rule's
0.010 floor that is 5.19%, so a band advertised as starting at 3% behaved like one starting
at 5.19% — the config stating a sensitivity the gate silently refused to honour. The band
edge is now 0.06 and an invariant test keeps the two in step. The same interaction in the
other direction is equally dangerous: a floor *wider* than the band makes the z an
unconditional veto and the fault undetectable by construction, with nothing in the output
to say so.

**Peer comparison is blind to a whole group failing together.** If most devices on a bus
degrade at once, the reference moves with them. Exact leave-one-out does not help, because
it still leaves the other failures in the reference. This is inherent to the method and is
the reason the physics twin is not being retired in favour of it.

---

## 6c. Three numbers, three classifiers

### The finding

These three figures have been quoted together as one detector degrading:

| Number | Module | Dataset |
|---|---|---|
| 0.835 | `pv_row_classifier.py` | Lazzaretti test, 99,481 rows |
| 0.519 | `pv_row_classifier_physics.py` | **identical** 99,481 rows |
| 0.189 | `gpvs_row_classifier.py` | GPVS, 80,000 rows, 8 classes |

**0.835 → 0.519 is fair.** Same rows, same taxonomy, a pure threshold swap; the 37.9%
gap is the cost of tuning thresholds on the data they are scored on.

**0.519 → 0.189 is not a comparison.** Four things change at once: a different classifier
module, disjoint input columns, a 5-class versus 8-class taxonomy, and GPVS thresholds that
are themselves fitted to GPVS percentiles. Five of the eight classes score F1 exactly 0.000
because that classifier structurally cannot emit them, which drags an unweighted macro mean
mechanically.

The surrogate needs per-string voltage, per-string current and irradiance. GPVS has none of
the three. **It was never possible to run it there**, so nobody ever measured how it travels.
`pv/classifier_provenance.json` records this by script rather than by assertion.

### One cascade, parameterised

`nuravolt/validation/row_classifier.py` replaces all three. An artifact now records a
**parameter set** — thresholds and scale references, by value — instead of a module name, so
this confusion cannot recur.

The refactor reproduces both Lazzaretti artifacts **row for row, zero rows differing**. A
refactor that quietly moves a published number is worse than no refactor, and that is a test
rather than a hope.

### What was actually plant-specific

| Dependency | Old form | Set by |
|---|---|---|
| voltage scale | `240` / `245` / `260` volts | modules in series |
| current scale | `EXPECTED_CURRENT_PER_W_M2 = 0.009` | strings in parallel × Isc |
| channel count | exactly two strings | inverter input count |

The middle one is worth naming plainly: `0.009` is 9 A/kW, and the measured median of
`i_mean / (irradiance/1000)` on Lazzaretti's healthy rows is **8.985 A/kW**. That constant
was never a physical law — it was one rig's Isc, written as a literal.

The 200 W/m² daylight floor is deliberately **not** normalised. Irradiance is measured the
same way everywhere, so it is not a property of the array.

### What normalisation buys, measured

Rescaling the labelled test set to imitate other geometries, holding physics and labels
fixed:

```
k_v   k_i   geometry                              fixed    normalised
1.0   1.0   Lazzaretti as built                   0.8348   0.8212
0.75  1.0   6 modules in series instead of 8      0.5941   0.8212
1.5   1.0   12 modules in series                  0.5081   0.8212
1.0   2.0   two strings paralleled per input      0.4496   0.8212
0.75  2.0   6 modules, two strings paralleled     0.2677   0.8212
```

Macro-F1 falls to **0.268**, and **all four fault classes reach F1 exactly 0.000** at some
geometry. Normalised, the spread across the whole grid is **0.000000**.

**The cost of not being told the reference is 0.0136 macro-F1.** Estimating it from the
target record's own distribution — no labels, no commissioning paperwork — lands within
0.87% of an estimate computed from labelled healthy rows only, because a median tolerates
40% fault contamination. The estimator holds to within 2% up to 49% contamination and
collapses by 66% at 55%: the 50% breakdown point, pinned by a test that asserts both sides.

### The real-plant confirmation, and its surprise

On three real plants, 5.95M daylight device-intervals, the fixed-reference cascade **never
once emits short circuit or degradation**. Those plants run at 653–788 V per string against
Lazzaretti's 270, so every voltage ceiling in the cascade sits permanently out of reach.

The expected failure was noise. The actual failure is **silence**, which is worse: a plant
with no alerts is indistinguishable from a healthy plant. Normalisation restores all four
classes and leaves the mix inside stated plausible bounds — a necessary condition for
transfer, not proof of it, since these plants carry no labels.

One class stays dark under both references. `open_circuit` needs a voltage spread exceeding
the median, which a 12-input inverter's median-based statistic rarely reaches. That is a
channel-count effect and scale normalisation does not touch it.

### What this does not establish

That the classifier transfers. Three specific dependencies are gone. Fill factor, series
resistance, temperature coefficient and sensor placement remain, and none of them is a scale
factor. Invariance under rescaling is **necessary, not sufficient** — and the one experiment
that would settle it needs a second labelled dataset with per-string channels, which does not
exist here. `pv/sandia_sat_transfer.json` carries a prediction registered in advance against
the day one does.

---

## 7. Two integration problems that would have failed silently

Both were found by running against all seven real plants rather than one.

### Nameplate classing

Grouping devices by exact nameplate split Epsilon's 36 central inverters into **18 "classes"**
spanning 1,036 to 1,140 kWp — one machine class recorded to the nearest tenth, treated as 18
incomparable populations, leaving only 10 of 36 devices scoreable. Relative clustering with a
25% tolerance fixes it, while still separating Gamma's 238 kWp devices from its 77 and 84
kWp ones, which really are different machines.

Result: **452 of 452 devices grouped, each scored exactly once.**

### Device naming disagrees between metadata and telemetry

| plant | telemetry token | metadata id | naive match |
|---|---|---|---|
| alpha | `INV 01.001` | `INV 01.001` | yes |
| delta | `INV 01.001` | `INV 01.001` | yes |
| gamma | `INV 03.045` | `INV 01.001` | yes |
| ribera | `INV 01.032` | `WR.01.032` | **no** |
| eta | `INV 01.001` | `WR.01.001` | **no** |
| zeta | `INV 01.001` | `INV01.001` | **no** |
| epsilon | `INV 01.01` | `inverter001@IPC01` | **no** |

`WR` is *Wechselrichter*, German for inverter: the same fleet carries two languages. **Four of
seven plants fail a naive match**, and the failure mode is the dangerous one — a detector with
no devices resolved reports zero alerts, which is indistinguishable from a healthy plant.

The stable content is the *sequence of digit groups*: `INV 01.001`, `WR.01.001`, `INV01.001`
and `inverter001@IPC01` all reduce to `(1, 1)`. Matching on that resolves **416 of 416
inverters on six plants**, and `resolve_device_columns` **raises** below 50% coverage rather
than running. Epsilon correctly refuses at 11%.

> This is the general lesson: **a detector that cannot run must say so loudly.** Silence and
> health look identical from the outside.

---

## 8. Measuring a fault detector when there are no labels

Real plants do not come with labelled faults. Five things are measurable without them, and
**none of them is recall**:

1. **Injected-fault recall** — corrupt clean data with a known physical fault of known
   magnitude and measure detection against severity. Yields a *minimum detectable fault*. It
   is an upper bound, because real faults are confounded with the conditions that caused them.
2. **Alert rate per MW-month** — proves operability, not correctness. Ship gate: a tier A
   detector may not exceed 1 alert per MW per month.
3. **Precision by construction** — for tier B range rules. A module temperature of −224.66 °C
   is a sensor fault with probability near 1; no label is needed. This is an *argument*, not a
   measurement, and the claim is confined to that family.
4. **Independent-detector agreement** — Cohen's κ between detectors with disjoint failure modes.
5. **Alert persistence** — a detector whose alerts are independent across devices is detecting
   weather, not faults.

### The symmetric-tail control

The most useful method found in this work, and it costs nothing.

**Over-performance relative to peers is not a fault.** So the *positive* tail of the same
statistic estimates the false-positive rate directly, with no labels at all.

Measured across 416 inverters on six plants:

| quantity | value |
|---|---|
| theoretical one-sided `P(z > 4)` under a normal null | **0.0032%** |
| observed positive tail | **0.0030%** |
| observed negative tail | **0.2492%** |
| asymmetry (signal to null) | **~78x** |
| Spearman(plant size, positive tail) | −0.26, p = 0.62 |
| Spearman(plant size, negative tail) | +0.77, p = 0.072 |

The observed positive tail matches the theoretical null to three significant figures. That
tells us the modified z-score is correctly calibrated on real data and shows no size-dependent
inflation, and it tells us the negative tail is real signal rather than noise.

### A wrong diagnosis, and how the control caught it

The first fleet run produced **1.14 alerts/MW/month**, failing the 1.0 gate, with alert rate
correlating with plant size at Spearman **+0.83 (p = 0.042)**. The initial diagnosis recorded
in the artifact was:

> *more peers give a tighter MAD, so a fixed z threshold becomes progressively more sensitive
> as the fleet grows*

**That was wrong, and the symmetric-tail control disproved it.** If the effect were
statistical, the positive tail would inflate with plant size too. It does not (ρ = −0.26,
p = 0.62), and it sits precisely on the theoretical null. The size correlation therefore
reflects genuine differences in how much underperformance these plants carry.

The correction is preserved in the artifact rather than overwritten, under
`scale_invariance.corrected_mechanism`, because the correction is more instructive than the
original claim. The revised conclusion: the two plants over the gate are most likely carrying
real underperformance, which makes the 1.0 per MW-month threshold a **product decision about
alert volume**, not evidence of a broken detector.

Current per-plant, identical parameters everywhere, no tuning:

| plant | inverters | alerts/MW/month |
|---|---|---|
| alpha | 150 | 1.71 |
| ribera | 120 | 1.12 |
| delta | 43 | 0.83 |
| zeta | 30 | 0.79 |
| gamma | 45 | 0.57 |
| eta | 28 | 0.08 |

---

## 9. Forecasting, including one we refuse to quote

### Soiling, the one we are confident about

| Result | Basis | Artifact |
|---|---|---|
| **1.44 percentage points** mean absolute error against a reference sensor, 36 walk-forward windows, 2,799 forecast days | walk-forward out-of-sample | `forecast/forecast_soiling_sr_ribera.json` |
| **Insolation-weighted soiling ratio 0.920 to 0.960** against the rdtools open-source reference, 7,256 days, three public sites | ground-truth measurement | `soiling/pvdaq_system_{2107,7334,9069}.json` |

Only the one-day horizon is published. `scripts/backtest_forecast.py` contains an explicit
`# For now, use same predictions for all horizons`, which is why its committed report shows
bit-identical MAE and R² at 1, 3, 7, 14, 21 and 30 days. Those rows are not real and are not
published.

### Day-ahead generation, and why there is no number

| quantity | value |
|---|---|
| skill score against persistence | **−0.032** |
| model nMAE | 21.00% of mean daily energy |
| persistence baseline | 20.36% |
| oracle: physics fed *observed* irradiance | 13.19% |

A skill score below zero means the forecast is slightly **worse than "tomorrow will be like
yesterday"**. Publishing an nMAE without that context would mislead, so no forecast accuracy
is quoted. The cause is identifiable: no numerical weather prediction feed is connected, so
the model forecasts from the plant's own history. Every Open-Meteo call in the repository
targets the ERA5 *reanalysis* archive, which is a record of what already happened and would
leak if used as a forecast input. The oracle number shows the entire remaining gap is weather
uncertainty rather than model error, which says exactly where the work is.

### Remaining useful life: four models withdrawn

Two independent defects made the reported accuracy meaningless.

**Target leakage.** The label was computed as a closed-form invertible function of a column
that is itself one of the model's own features:

```python
y = (threshold - x) / threshold * max_days + np.random.normal(0, 0.1 * max_days)
```

The arithmetic tell is exact. For `insulation`, `max_days = 90`, so the injected noise has
sigma 9.0, and a *perfect* inverter of that function scores
`MAE = 9 * sqrt(2/pi) = 7.18`. **The reported test MAE is 7.18.** The number measures the
noise term.

**Synthesized inputs.** Four of seven models were trained on features the source dataset does
not contain, fabricated with random number generators — `hotspot_count`, `riso_value`,
`humidity_avg_7d`, `age_years`, `pr_trend_30d`. Two of the four were never produced as files.

Outcome: `thermal_hotspot` and `module_degradation` quarantined under
`backenddata/models/rul/withdrawn/` with the arithmetic written out; `bypass_diode` and
`insulation` never existed. `MODEL_FILES` trimmed from seven entries to three. The three
survivors use real measured signals and are pending a rebuild on **real event labels** via
`RULLabelGenerator.generate_from_fault_events`, which already exists and had never been called.

---

## 10. Defects found, and the guards now standing

| Defect | Effect | Guard |
|---|---|---|
| Three `FaultType` members referenced but never defined | `AttributeError` on any path reaching them | AST test: every `FaultType.X` reference must resolve |
| Three `FaultAlert(...)` calls using non-existent field names | `TypeError` even with valid enums | AST test against the dataclass fields |
| `_detect_dc_voltage_envelope` inverted margins **plus** a `max(V) * 1.1` fallback | **`DC_UNDERVOLTAGE` fired on essentially every non-zero daylight record**; `DC_OVERVOLTAGE` could never fire | Regression test; detector now refuses without a datasheet MPPT window |
| Four fault types defined with no emit site, described as live in customer material | Capability claims for code that cannot run | Allow-list test requiring a written reason per entry |
| Physics calibration silently resetting a bad factor to 1.0 | Eight shipped artifacts with meaningless accuracy | Raises `CalibrationScaleError` |
| `"90-99% accuracy"` in the rule engine's module docstring | Unsourced claim in code | `check_fabricated_metrics.py` |

### Outstanding, and not fixed by this work

`scripts/check_fabricated_metrics.py` reports **209 accuracy claims across 43 files** outside
the generated document. The dangerous class is on the public website and in a downloadable
whitepaper — for example *"94-97% detection accuracy validated across Spanish 120MW, UAE 50MW
and Australian deployments"*, *"18-month validation across 500+ MW"*, and an *"SOH Accuracy
< 1%"* claim for a battery product that has no telemetry connected. These were left in place
deliberately: rewriting public marketing claims is a business decision, not a code cleanup.
The guard is therefore **not** wired into `npm run validate`, because it would fail the build
on 209 pre-existing findings. Wiring it in is the forcing function whenever the decision is made.

Seven of those 209 are new, and only because the scan was widened. `.html` was not in
`SCAN_SUFFIXES` until this work, which is how `sales-assets/nuravolt-catalog.html` — the source
of the flagship product-catalog PDF — came to headline *"99.8% of PV faults correctly
classified"* and *"~1 day, how close predicted failure timing lands on the main fault modes"*
without the guard ever seeing them. The first is real but describes `lazzaretti_lgbm`, an
in-distribution same-split gradient booster, not the detector that ships (0.183) and not
anything that survives a change of rig (0.268). The second came from the seven RUL models
withdrawn in §9 and has no artifact at all. Both are now corrected at source; the seven
remaining `.html` findings are older decks carrying a *"92% fault detection accuracy"* claim
with no artifact behind it, and they fall in the same "business decision" bucket as the rest.

The narrower guard, `scripts/check_overview_numbers.py`, is a different contract and **is**
enforceable today: it covers `docs/overviews/` only, resolves each annotation against the
artifact it names, and fails on drift as well as on absence. It is pinned by
`tests/validation/test_overview_numbers.py`.

---

## 11. Reproducing all of it

```bash
set -a; source .env; set +a          # the lake needs credentials exported

python scripts/validate_all.py                    # every validator, rebuilds summary.json
python scripts/render_model_accuracy_doc.py       # regenerates docs/MODEL_ACCURACY.md
python scripts/render_model_accuracy_doc.py --check   # fails if the doc is stale
python scripts/check_fabricated_metrics.py        # unsourced accuracy claims
pytest -q tests                                    # 528 tests
```

Artifacts are written to `backenddata/validation/` and mirrored to the git-tracked
`public/data/validation/`, which is what makes a published number reproducible by someone who
only has the repository. `backenddata/` is gitignored, and its negation patterns are no-ops
because git cannot re-include a path under an excluded directory — hence the mirror.

### Data

Everything lives in `s3://nuravolt-lake/`:

- `bronze/public/` — 8.9 GiB: GPVS, Lazzaretti, Sandia PV-IV-EL, PVDAQ (4 systems), NREL
  soiling map, Severson, NASA PCoE.
- `bronze/scada/` — 3.9 GiB: seven Spanish plants, `*_cleaned.parquet` plus component metadata.
- `bronze/scada/_reference/all_plants_meta.csv` — 362 plants, 3,185 MWp.

The cross-plant corpus, read from the parquet footers:

| plant | rows | days | inverters | strings | cabinet temp | buses | vendor |
|---|---|---|---|---|---|---|---|
| alpha | 182,533 | 1,901 | 150 | 1,800 | 150 | 11 | Huawei |
| ribera | 182,524 | 1,901 | 120 | 1,440 | 120 | 8 | Huawei |
| gamma | 162,519 | 1,693 | 45 | 540 | 36 | 3 | Huawei, mixed models |
| zeta | 118,742 | 1,237 | 30 | 540 | 30 | 2 | Sungrow |
| delta | 162,231 | 1,690 | 43 | 516 | 43 | 2 | Huawei |
| eta | 182,488 | 1,901 | 28 | 336 | 28 | 2 | Huawei |
| epsilon | 323,612 | 3,371 | 36 | plant level | 36 | none | SMA |

Plus PVDAQ system 9069, a US utility plant with **2,522 per-string channels**, public and
independently reproducible.

**A limitation to state plainly:** six of the seven Spanish plants share the same Huawei and
Janitza stack, so leave-one-plant-out across them is a **scale and site test, not a vendor
test**. The PVDAQ systems are the only vendor diversity available.

---

## 12. Gotchas that cost time

- **Timestamps in the cleaned parquets are strings** (`'2023.04.11 13:00'`). Passing a raw
  frame to `_group_into_discrete_events` hits its "unknown type, assume large gap" branch and
  emits **one event per record**. Parse to `pl.Datetime` first.
- **The revenue meter is sign-inverted** (export negative, median ratio −0.9845). Normalise on
  ingest or the whole AC-side family silently inverts.
- **Power factor is signed and sits at −1.0** in daylight, so a naive `pf < 0.95` rule fires on
  100% of rows. Use `abs(cos phi)`.
- **The meter ratio has a heavy tail** (p01 −1.81 against a median of −0.985), so AC-loss must
  be a daily-energy statistic, never instantaneous.
- **Polars has no `median_horizontal`.** The working idiom is
  `pl.concat_list(cols).list.eval(pl.element().median()).list.first()`.
- **A pyranometer failed for six months and nothing noticed.** Alpha Sensor 01 degraded
  from 5.6% dead daylight rows in April 2023 to **98% in July**. The plant reference
  irradiance correctly fell back to the surviving sensor, so downstream numbers including the
  twin validation are **not** contaminated — but the plant ran half a year with no redundancy
  and no alert.
- **The shipped 65 °C inverter threshold fires on over 5% of one plant's daylight samples**
  (p95 of cabinet temperature is 66.2 °C). The peer-relative form has a p95 of +2.33 °C, about
  25 times tighter.

---

## 13. What is still not measured

Stated so it cannot be mistaken for covered:

- **Recall against real fault labels.** Not available on any real plant. Injected-fault recall
  is designed but not yet run.
- **Cross-vendor fault transfer.** Only PVDAQ offers it, and it has not been run.
- **Component life models** (capacitor Arrhenius ESR, IGBT Coffin-Manson). Physics based, with
  **no observed-failure validation**, because we have no population of observed inverter
  failures. Cabinet temperature exists on 443 of 452 inverters, so the input is not the blocker.
- **Battery state of health against measured capacity.** No battery telemetry is connected. The
  chemistry models are validated on public cell datasets only.
- **The 200 unsourced accuracy claims** in the public marketing surface.

---

*Every figure above is reproducible from a committed artifact under `public/data/validation/`,
or is labelled as an investigation measurement. If a number appears anywhere in NuraVolt
material that is not in `docs/MODEL_ACCURACY.md`, it should be treated as unverified until it is.*
