# Battery Intelligence

*Warranty, cycling, safety and revenue for standalone and co-located batteries. Read the two halves of this page separately: they have very different evidence behind them.*

**Reading the numbers:** "within plus or minus 10%" is the fraction of battery cells whose *predicted* end of life cycle count landed within a tenth of the *actual* one, on cells that were run all the way to failure in a laboratory. It is not a percentage accuracy of anything else, and it does not transfer to a claim about your installed battery.

---

## Half one: cell end of life, which is measured

This is a genuine prediction problem with genuine ground truth. Public datasets run lithium cells to end of life and record the cycle they reached it on, so a model that sees only the first fraction of a cell's life can be scored honestly against what actually happened.

| Method | Dataset | Cells genuinely predicted | Within ±10% |
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
| Standard linear extrapolation | NASA, NMC | 4 | 50% — too few cells to mean anything |

**The comparison that matters is the first two rows,** because they are the same cells. Our model sees cycles 10 to 100 of cells that live between 101 and 1,717 cycles — roughly a sixth of a median cell's life — and places 48.8% of them within a tenth of their true end of life. Straight line extrapolation of the capacity curve, given *twice* that history, places 1%.

It can do this because it does not extrapolate the capacity curve at all. It reads the *shape* of the voltage-capacity relationship between cycle 10 and cycle 100, following Severson and colleagues (Nature Energy, 2019). That signature moves long before capacity does, which is why the answer is available so early.

<!-- ACCURACY-OK: MAPE of 17% <- bess/severson_lgbm.mape pct -->
<!-- ACCURACY-OK: roughly 9% <- not-measured: the published figure from Severson et al. 2019, quoted from the paper as the benchmark for our own -->
**Where we sit against the paper.** Severson and colleagues reported roughly **9%** mean absolute percentage error on their primary test batch. Ours is **17%**, about double. We publish the comparison because a reader who knows the literature will make it anyway.

**Two corrections we made while preparing this,** and would rather you heard from us than found:

- Our validation code used to hand the baseline the answer. On several failure paths it returned the number of cycles a cell had been measured for — which, for a cell run to failure, *is* its end of life. Those scored as perfect predictions. The baseline now abstains when it cannot predict, and abstentions are counted.
- We were scoring cells whose end of life fell *inside* the window the predictor is allowed to see. On the NASA set that was 9 of 13 cells: the model watched them fail, then reported the cycle they failed on. That is observation, not prediction. Those cells are excluded, which is why the NASA row reads 4 rather than 13, and why we will not quote a figure from it.

Neither correction changed our own model's result, which returned the label exactly zero times.

## Half two: the battery product, which is modelled

<!-- ACCURACY-OK: no measured accuracy for any product surface <- not-measured: no battery management system telemetry from a live site exists, so every output runs on a declared nameplate and a modelled operating profile -->
**We do not currently have battery management system telemetry from a live site.** Warranty tracking, cycle counting by rainflow, chemistry degradation, state of safety, revenue assurance and the optimizer audit all run real algorithms over real published market prices — but against a *declared* nameplate and a *modelled* operating profile, because there is no measured telemetry to run them on.

Every one of those outputs is tagged provisional in the product and in the database, and **none carries a measured accuracy**. We are not going to quote a state of health figure against measured capacity, because we have not measured one. When a real battery is connected that changes, and we will say so plainly.

What is real today, and worth being precise about: the degradation and cycling algorithms are standard and correctly implemented; the market prices are genuine (48 half-hourly GBP settlement periods from Elexon and NESO for Great Britain, hourly EUR from OMIE and ENTSO-E for Iberia); and the optimizer audit measures your dispatch against a perfect foresight ceiling, which good commercial optimisers typically capture 70 to 90% of. What is modelled is the battery's own behaviour.

## What you get

State of health and warranty headroom against contract terms, a warranty breach date projection, throughput and equivalent full cycles, a worst-of-four state of safety index, rack and module level imbalance, and a revenue ledger kept in three separate lanes — measured, declared and benchmark — which are never summed together.

## What it needs

For the provisional twin: a declared nameplate, chemistry and warranty terms. For anything measured: BMS telemetry at rack or module grain, which is the connection we would set up during onboarding.

---

*Cell level artifacts are under `public/data/validation/bess/`. The honesty boundary between modelled and measured is enforced in code, not just in this document: every persisted row carries a provenance column and a modelled value cannot overwrite a measured one.*
