# What you get on day one, and what local data buys

For each capability: the model that transfers best to a plant we have never seen, the accuracy
to expect with no local history, and the accuracy after the model has seen that site's own data.

Every figure traces to an artifact under `public/data/validation/`. Where a cell says *not
measured*, it is not measured, and that is not a euphemism for "good".

> **Read down a row, not across rows.** The normalisers differ by capability: a twin error is a
> percentage of nameplate or of mean daily energy, a soiling error is percentage points of
> soiling ratio, a battery figure is a fraction of cells inside a tolerance. Comparing 6.61% to
> 48.8% is meaningless.

---

## The summary

| Capability | Best transfer model | Day one, no local data | With local data | What local data buys |
|---|---|---|---|---|
| **Digital twin**, 15-min power | PVWatts physics + one scalar | **6.57% nMAE of AC nameplate** (10.41% with no scalar at all) | 6.61% locally calibrated | **nothing.** Local calibration is marginally *worse* |
| **Digital twin**, daily energy | Naive irradiance line | **16.70% nMAE of mean daily energy** | 16.46% after 365 days | **~1%.** Local-only ML is *worse* below a full year |
| **Soiling ratio** | Climate prior | **fails a ±30% match at 2 of 3 public sites** | **1.44 pp** against a reference sensor | the whole capability |
| **Fault detection**, peer-relative | The statistic itself | **works on day one** (needs ≥4 siblings, no history) | same | nothing, and that is the point |
| **Fault detection**, threshold rules | Physics- and standards-anchored (tier B) | not measured cross-plant | — | 15 of 33 rules are fleet-fitted and need calibration |
| **Fault classification**, ML | none that transfers | **macro-F1 0.189** cross-architecture | 0.835 tuned, 0.998 same-split | large, but it does not travel |
| **PV module degradation** | Published fade rate (0.5–1.0 %/yr) | **rank only**: Spearman −0.375 | not measured | not measured |
| **PV component RUL** (capacitor, IGBT) | Arrhenius / Coffin-Manson physics | **no measured accuracy** | no measured accuracy | needs observed failures; no public dataset has them |
| **Battery end of life** | **Naive linear extrapolation** | **75% / 69% within ±10%** | 48.8% with delta-Q features | naive *wins* on transfer |
| **Day-ahead generation** | Persistence | **skill −0.032**, i.e. loses to persistence | not measured | needs a weather forecast feed, not history |

---

## The three findings that surprised us

### 1. The naive or physical model is usually the best transfer model

This is not a rhetorical position, it is what the measurements keep saying. Across five
independent protocols the simpler model won or tied on an unseen plant:

| Protocol | ML | Simpler reference | ML uplift |
|---|---|---|---|
| Twin, 15-min, walk-forward | 6.68% | calibrated physics 6.61% | −1% |
| Twin, daily, walk-forward | 9.31% | irradiance line 8.51% | −9% |
| Twin, daily, unseen plant | 11.19% | irradiance line 8.90% | −26% |
| Twin, feature ablation, best of four sets | 10.04% | irradiance line 8.90% | −13% |
| Battery end of life, cross-dataset | 48.8% | linear extrapolation 75% | worse |

The honest reading is bounded: what was scored is gradient boosting over a modest feature set,
not every conceivable model. But five protocols pointing the same way is enough to make the
simplest model the default, and to require any ML layer to prove its uplift on the identical
sample before it ships.

### 2. Local data buys far less than intuition suggests, and early local data is harmful

The learning curve, measured by holding each plant out entirely and letting the model see only
its first *k* days (`twin/twin_local_data_curve.json`):

| Local days | Irradiance line | Physics transfer | ML transfer | ML local | ML hybrid |
|---|---|---|---|---|---|
| 0 | 17.01% | 17.01% | 16.70% | n/a | n/a |
| 30 | 17.36% | 17.01% | 16.70% | **33.82%** | 16.75% |
| 60 | 16.81% | 17.01% | 16.70% | 22.00% | 16.78% |
| 90 | 16.32% | 17.01% | 16.70% | 19.90% | 16.77% |
| 180 | 16.36% | 17.01% | 16.70% | 18.36% | 16.78% |
| 365 | 16.49% | 17.01% | 16.70% | **16.46%** | 16.58% |

Two things to take from it. A year of the plant's own history buys about **1%**. And a model
trained only on a customer's first month is **twice as bad as one that never saw their plant at
all**, because thirty days cannot contain a seasonal cycle. The practical consequence is that
we should transfer first and blend local data in slowly, never train from scratch on a new site.

The reason is mundane: at daily aggregation the irradiance-to-power relationship is close to
universal, and most of what differs between plants is a scale factor that comes from the
nameplate rather than from history.

*Caveat: this is daily-energy resolution. The 15-minute twin is a different metric on a
different normaliser and this curve says nothing about it.*

### 3. The 15-minute twin needs one number, and it does not have to be yours

Measured on Alpha across 35 walk-forward windows (`twin/twin_15min_dayone.json`):

| Variant | nMAE of AC nameplate | Bias |
|---|---|---|
| Day zero, calibration scalar fixed at 1.0, nothing local | 10.41% | −4.71% |
| One **transferred** scalar | **6.57%** | +2.03% |
| Scalar fitted on this plant's own history | 6.61% | +1.82% |

A single scalar removes **37%** of the error. Fitting it locally rather than transferring it
makes things **marginally worse**, because a median over many windows is shrunk toward the
population while a single local fit carries that window's noise. Ordinary shrinkage, and it
means a fleet prior beats a short local fit.

*Limitation: the transferred factor here is the median of other time windows of the same plant,
so this measures temporal transfer. A genuine cross-plant day-one number needs factors from
other sites, which is the next test.*

### 4. Peer-relative detection is the only thing that is genuinely good on day one

Every other capability either needs local history or degrades on transfer. A peer-relative
detector needs neither: it compares a device to its siblings at the same instant, so it requires
**four peers, not four months**. Irradiance, temperature, plant size, orientation and vendor all
cancel because every sibling sees the same conditions.

Measured across 416 inverters on six plants with identical parameters and no per-plant tuning:
the statistic is calibrated against its own null (harmless tail 0.0020% against a theoretical
0.0032%) with signal 158× the null. It currently fires 1.14 times per MW per month, above our
own 1.0 shipping gate, which is an alert-volume question rather than a correctness one.

That is why the retier campaign moves faults toward this construction wherever the signals allow.

---

## Why there are no PV RUL estimates, when public data exists

The question is fair and the answer is more specific than "we have none".

**For batteries we do have real remaining-useful-life, and it is validated.** Severson runs 123
LFP cells to end of life and records the actual cycle count (for example cell `b1c1`, actual EOL
1,177 cycles, predicted 1,128). NASA does the same for NMC. That is genuine run-to-failure data,
and our delta-Q model reaches 48.8% of cells within ±10% using only cycles 10 to 100 — against
3.2% for linear extrapolation given twice the history.

**For PV modules we have real degradation trajectories.** Sandia PV-IV-EL carries repeated IV
curves per module over years, and all 166 modules have a computable fade rate (mean 0.887 %/yr,
median 0.724 %/yr, matching the published Jordan and Kurtz range). That is enough to build a
genuine module-degradation model today, and it is where the one surviving RUL number comes from:
Spearman −0.375, correct rank ordering with an uncalibrated day scale.

**What does not exist publicly is PV *component* run-to-failure data.** No open dataset records
inverters, capacitors, IGBTs or strings failing with timestamps. Lazzaretti labels fault
*states*, not time-to-failure. That absence is precisely why the seven PV RUL models fabricated
their labels, and did so in a way that made their reported accuracy meaningless: the label was a
closed-form invertible function of one of each model's own features, so a perfect inverter of
that function scores exactly the reported number.

So the gap is narrow and specific:

| | Real run-to-failure data? | Validated model? |
|---|---|---|
| Battery cells | yes, Severson and NASA | **yes**, 48.8% within ±10% |
| PV module degradation | yes, Sandia trajectories | partial, rank only |
| PV component failure | **no public dataset** | no |

Two routes are open for the last row, neither needing data we lack. Build the module-degradation
model properly on the Sandia trajectories, which are real and already on disk. And derive
component event labels from our own seven plants and five years of telemetry using the
peer-relative detectors, which is what the RUL rebuild does.

---

## What we will not claim

- No accuracy for the capacitor and IGBT life models. They are published reliability physics with
  no observed-failure validation, because we have no population of observed inverter failures.
- No state of health against measured battery capacity. No installed battery telemetry exists.
- No day-ahead generation forecast accuracy. It does not beat persistence without a weather feed.
- No recall for any fault detector. Real plants carry no fault labels, so nothing here says how
  many real faults were caught.
