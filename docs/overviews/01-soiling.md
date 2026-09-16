# Soiling Intelligence

*How dirty are the modules, what is it costing, and when is a cleaning crew worth paying for.*

**Reading the numbers:** we quote error in *percentage points of soiling ratio*. The soiling ratio is what the plant produces divided by what it would produce clean, so 1.00 is spotless and 0.95 is a 5% loss. An error of 1.44 pp means that when the true ratio was 0.9656 we said 0.98.

---

## What it does

Estimates the soiling ratio **per inverter**, not just per plant, and forecasts it forward so cleaning is scheduled on value rather than on the calendar. Most plants carry one reference soiling sensor for a whole site; we infer the per inverter signal from each inverter's own AC output against irradiance and cell temperature, after the digital twin has removed weather, curtailment and temperature effects.

The 365 day forecast feeds a cleaning schedule optimiser that weights recovery by when the sun is actually worth something at your latitude, and returns the schedule that maximises net benefit rather than the one that maximises cleanliness.

## What it needs from your SCADA

Per inverter AC power, plane of array irradiance, ambient or module temperature, and rainfall. A calibrated soiling sensor is used as a reference where one exists but is not required. Nothing else.

## What you get

Current and forecast soiling ratio per inverter, the energy and revenue currently being lost, a ranked list of which inverters are worst, and a recommended cleaning schedule with its net benefit.

## How good it is

<!-- ACCURACY-OK: 1.44 percentage points <- forecast/forecast_soiling_sr_ribera.mae_sr_pp -->
<!-- ACCURACY-OK: standard deviation 0.54 <- forecast/forecast_soiling_sr_ribera.mae_sr_pp_std -->
<!-- ACCURACY-OK: 36 walk forward windows <- forecast/forecast_soiling_sr_ribera.n_windows -->
<!-- ACCURACY-OK: 2,799 forecast days <- forecast/forecast_soiling_sr_ribera.n_samples -->
**Against a physical reference sensor: 1.44 percentage points** of mean absolute error at a one day horizon (standard deviation 0.54), measured over 36 walk forward windows and 2,799 forecast days on a Spanish plant. Walk forward means the model was refit on an expanding history and scored only on the next period it had never seen, which is exactly what it does in production.

<!-- ACCURACY-OK: 0.920 <- soiling/pvdaq_system_9069.iwsr_p50 -->
<!-- ACCURACY-OK: 0.949 <- soiling/pvdaq_system_2107.iwsr_p50 -->
<!-- ACCURACY-OK: 0.960 <- soiling/pvdaq_system_7334.iwsr_p50 -->
**Against the industry reference method, on public data you can download: insolation weighted soiling ratio 0.920, 0.949 and 0.960** on three NREL PVDAQ systems. rdtools is NREL's open source soiling library and PVDAQ is NREL's public plant archive, so nothing about this check depends on trusting us. The three system identifiers are in our artifact.

<!-- ACCURACY-OK: median 0.11% per day <- soiling/nrel_map_sites.distribution.p50 -->
<!-- ACCURACY-OK: 146 sites <- soiling/nrel_map_sites.n_sites -->
**Against published field measurements:** our soiling rates sit at a median of **0.11% per day**, in line with the distribution NREL publishes across **146 US sites**.

This is the strongest measured area in the platform.

## What we do not claim

<!-- ACCURACY-OK: 1 of the 3 sites, 3 compared <- soiling/climate_prior_cross_check.n_sites_within_30pct -->
**The day one estimate is rough.** Before your site has produced any data we fall back on a climate prior. Checked against those same public sites it lands within plus or minus 30% of observed soiling at only **1 of the 3**; at the other two it under predicts substantially. It is a first estimate, not a substitute for measurement, and we would expect to recalibrate against your data inside the first season.

<!-- ACCURACY-OK: 25, 2 and 12 valid intervals <- soiling/pvdaq_system_2107.n_valid_soiling_intervals -->
**The public comparison rests on few episodes.** The insolation weighted ratios above are computed across thousands of days, but rdtools identifies only **25, 2 and 12** distinct valid soiling intervals at the three sites. The middle site in particular is thin, and we would rather say so than quote three decimal places over it.

**No multi horizon error curve yet.** We found a bug in our own backtest: it reuses a single prediction for every horizon, so its 3, 7, 14, 21 and 30 day figures are copies of the one day figure. Until that is fixed, one day is the only horizon we quote.

---

*Every figure above is computed by a script in our repository and stored as a JSON artifact under `public/data/validation/`. The full method, including what was excluded and why, is in `docs/MODEL_ACCURACY_METHODS.md`. We are glad to walk your engineers through any of it.*
