# Digital Twin

*What the plant should be producing right now, so any shortfall is a number rather than an argument.*

<!-- ACCURACY-OK: R squared above 0.95 is table stakes <- not-measured: rhetorical illustration of why R squared is uninformative on a solar time series, not a measurement of any model -->
**Reading the numbers:** we report **nMAE** — the average size of the error as a percentage of a stated reference — and we always say which reference. On a solar time series roughly 95% of the variation is just the sun rising and setting, which even a straight line through irradiance reproduces, so R squared above 0.95 is table stakes and tells you nothing. We also report **bias** separately and with its sign, because a model that is 5% high half the time and 5% low the other half is a very different thing from one that is 5% high consistently.

---

## What it does

Computes expected power every 15 minutes at plant, inverter and string level from a PVWatts physics model calibrated to your site, then quantifies the gap to what was actually produced. It is the root model: soiling, fault attribution and forecasting all read from it.

## What it needs from your SCADA

Plane of array irradiance, ambient temperature, wind speed, and your plant configuration — nameplate, coordinates, tilt, azimuth. That is the whole list. Solar geometry we compute.

## What you get

Expected versus actual power at 15 minute resolution, the loss quantified in kWh and revenue, and a per inverter and per string breakdown of where it is going.

## How good it is

On a 9.9 MW Spanish plant with five years of 15 minute data:

| | nMAE (% of AC nameplate) | Bias |
|---|---|---|
<!-- ACCURACY-OK: 6.6% <- twin/twin_15min_alpha.reference_nmae_pct -->
| Calibrated physics twin | **6.6%** | |
<!-- ACCURACY-OK: 6.7% <- twin/twin_15min_alpha.nmae_pct -->
<!-- ACCURACY-OK: +2.1% <- twin/twin_15min_alpha.mbe_pct -->
| Physics plus machine learning | 6.7% | +2.1% |

<!-- ACCURACY-OK: 42,229 intervals <- twin/twin_15min_alpha.n_samples -->
<!-- ACCURACY-OK: 35 walk forward windows <- twin/twin_15min_alpha.n_windows -->
<!-- ACCURACY-OK: 37.4% of raw intervals retained <- twin/twin_15min_alpha.retention.retention_pct -->
<!-- ACCURACY-OK: 345 outage <- twin/twin_15min_alpha.retention.availability_excluded -->
<!-- ACCURACY-OK: 373 clipping <- twin/twin_15min_alpha.retention.clipping_excluded -->
Measured over **42,229 intervals across 35 walk forward windows** — refit on an expanding history, scored only on the next month it had never seen, which is what it does in production. Night, outages, clipping and out of range sensor readings are excluded and the counts are published: **37.4% of raw intervals retained**, with **345 outage** and **373 clipping** intervals removed. We publish the exclusions because a retention figure is how you tell a filtered result from a flattering one.

<!-- ACCURACY-OK: 11.2% nMAE <- twin/twin_daily_energy_leave_one_plant_out.nmae_pct -->
<!-- ACCURACY-OK: 9,495 plant days <- twin/twin_daily_energy_leave_one_plant_out.n_samples -->
**On a plant it has never seen:** trained on six plants and scored on a seventh, **11.2% nMAE of mean daily energy** across **9,495 plant days**. That is the honest day one number for a site with no history.

## How little we need before it works

<!-- ACCURACY-OK: 10.41% nMAE <- twin/twin_15min_dayone.day_zero_uncalibrated_nmae_pct -->
<!-- ACCURACY-OK: 6.57% <- twin/twin_15min_dayone.day_one_transferred_nmae_pct -->
With nothing but nameplate, coordinates, tilt and azimuth, and no calibration at all, the 15 minute physics twin reaches **10.41% nMAE**. One transferred calibration scalar takes it to **6.57%** — and that scalar does not have to come from your plant. There is no training period to sit through.

## What we do not claim

**The machine learning layer is not currently earning its place.** Correctly calibrated physics does the same job: 6.6% against 6.7%, and the ML version carries a bias the physics version does not. We would rather tell you that than sell you a black box, and it is why the physics model is what runs.

<!-- ACCURACY-OK: 16.70% on day one, 16.46% after 365 days <- twin/twin_local_data_curve.day_one_nmae_pct -->
<!-- ACCURACY-OK: 1.4% error reduction <- twin/twin_local_data_curve.error_reduction_pct -->
**Your own history buys less than you would expect.** At daily energy resolution the twin sits at **16.70% nMAE on day one** and **16.46% after 365 days** of your data — an error reduction of about **1.4%**. Below a full year, a model trained only on your site is actually *worse* than one transferred from elsewhere. If someone is quoting you a long data migration as a prerequisite, this is the number to ask them for.

**Accuracy is bounded by your irradiance sensing, not by our modelling.** A drifting or badly sited pyranometer moves the twin error more than any modelling choice we could make. That is the entire reason the data quality checks exist, and it is the first thing we look at during onboarding.

<!-- ACCURACY-OK: temporal rather than cross-plant transfer <- not-measured: the transferred scalar is the median across other time windows of the same plant, so it measures temporal transfer; the cross-plant figure is the separate 11.2% leave-one-plant-out result -->
**One precision about the transfer claim.** The transferred scalar above is a median across other *time windows of the same plant*, so strictly it demonstrates temporal transfer. The genuine cross-plant number is the leave-one-plant-out result, 11.2% of mean daily energy, and we keep the two separate rather than quoting the flattering one for both.

---

*Artifacts under `public/data/validation/twin/`. The retention and exclusion policy, and the unit bug we found and fixed in the physics calibration, are both written up in `docs/MODEL_ACCURACY_METHODS.md`.*
