# Forecasting, and Data Quality

*Five things look forward at very different horizons and very different levels of confidence. We would rather set that out than let "forecasting" sit in a proposal as one word.*

**Reading the numbers:** a **skill score** compares a forecast against a deliberately stupid baseline. Persistence means "tomorrow will be like yesterday". A skill score of 0 means you matched it, above 0 means you beat it, below 0 means you lost to it. Publishing an error figure without saying what baseline it beat is how forecasting claims get inflated, so we lead with the skill score.

---

## What looks forward, and how far

| What | Horizon | Status |
|---|---|---|
<!-- ACCURACY-OK: 1.44 pp at one day <- forecast/forecast_soiling_sr_ribera.mae_sr_pp -->
| Soiling ratio | 1 to 365 days | **Measured: 1.44 pp at one day.** Multi horizon not published, see below |
| Optimal cleaning schedule | 365 days | Live. An economic optimisation over the soiling forecast, not an accuracy claim |
<!-- ACCURACY-OK: no measured accuracy <- not-measured: physics based; no population of observed inverter component failures exists to validate against -->
| Capacitor and IGBT remaining life | days to end of life | Live where cabinet temperature exists. Physics based, no measured accuracy |
| Degradation trend life | up to 90 days | Withdrawn pending revalidation |
| Battery warranty breach date | contract term | Modelled only. No battery telemetry connected yet |
<!-- ACCURACY-OK: not quoted <- not-measured: withheld because the skill score against persistence is negative; the figure is in forecast/forecast_dayahead_alpha_endogenous.json -->
| Day ahead plant generation | 24 hours | **Not quoted. Does not currently beat persistence** |

## Soiling, the one we are confident about

<!-- ACCURACY-OK: 1.44 percentage points <- forecast/forecast_soiling_sr_ribera.mae_sr_pp -->
<!-- ACCURACY-OK: 36 walk forward windows <- forecast/forecast_soiling_sr_ribera.n_windows -->
<!-- ACCURACY-OK: 2,799 forecast days <- forecast/forecast_soiling_sr_ribera.n_samples -->
This is the forecast that moves real money, because it decides when a cleaning crew is worth paying for. Measured error against a physical reference sensor is **1.44 percentage points** at a one day horizon, across **36 walk forward windows** and **2,799 forecast days**.

The 365 day version feeds the cleaning schedule optimiser: it simulates cleaning scenarios across the year, weights recovery by when the sun is actually worth something at your latitude, and returns the schedule with the best net benefit rather than the one that keeps modules cleanest.

**We are not publishing a multi horizon error curve.** We found a bug in our own backtest: it reuses a single prediction for every horizon, so its 3, 7, 14, 21 and 30 day rows are copies of the one day row and are not real. That is being fixed. Until it is, one day is the only horizon we quote — and we would rather tell you about the bug than ship the numbers it produced.

## Day ahead generation, and why we are not quoting it

<!-- ACCURACY-OK: skill score of minus 0.032 <- forecast/forecast_dayahead_alpha_endogenous.skill_score abs -->
Tested on five years of real 15 minute data, our day ahead plant energy forecast scores a **skill score of minus 0.032** against persistence. Below zero means it is very slightly *worse* than assuming tomorrow looks like yesterday. Publishing an error percentage without that context would be misleading, so we do not.

<!-- ACCURACY-OK: 13.2% nMAE <- forecast/forecast_dayahead_alpha_endogenous.reference_nmae_pct -->
<!-- ACCURACY-OK: our 21.0% <- forecast/forecast_dayahead_alpha_endogenous.nmae_pct -->
The cause is identifiable and fixable, and worth knowing because it tells you what the ceiling is. The test site has no numerical weather prediction feed connected, so the model is forecasting from the plant's own history alone. The same physics model fed the *observed* irradiance reaches **13.2% nMAE** on the same days, against **our 21.0%**. That eight point gap is weather uncertainty, not model error. The work is to connect archived forecast weather and re-measure — not to build a cleverer model.

We would rather arrive at a bake-off with a negative number we understand than a positive one we cannot defend.

## Data quality monitoring

<!-- ACCURACY-OK: no accuracy figure to quote <- not-measured: these are deterministic checks against physical bounds and clear-sky expectations, not statistical models, so there is no error to measure -->
**Purpose:** catch instrument problems — above all irradiance sensor drift — that would otherwise corrupt every number in this set. Twin accuracy is bounded by irradiance sensing quality more than by modelling, so this is not a peripheral feature.

**What it watches:** sensor drift against a clear sky model, frozen sensors (a run of identical consecutive readings when the signal should be varying), total data loss, and partial channel loss where a channel that *was* reporting goes null while its siblings continue.

**Output:** alerts to inspect or recalibrate, plus coverage and completeness reporting per data stream.

**There is no accuracy figure to quote and we do not present one.** These are deterministic checks against physical bounds, not statistical models — there is no error to measure. What we report instead is coverage: what fraction of expected intervals arrived, and what fraction were flagged. A vendor offering you a percentage accuracy for data quality monitoring is describing something other than what this is.

---

*Artifacts under `public/data/validation/forecast/`. The backtest defect above is described, with its consequence, in `docs/MODEL_ACCURACY_METHODS.md`.*
