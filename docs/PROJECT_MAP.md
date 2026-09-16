# NuraVolt / ShamsIQ — Project Map

**Last reviewed: 2026-07-29** (BESS program: market-data modules, the three-lane revenue ledger, the measured-telemetry bridge and sub-asset imbalance registered here. Previous review 2026-06-21, Phase N — generalization push: 3 PVDAQ sites validated, GPVS LightGBM companion, PV-RUL cross-test, LFP second-life dataset, climate-prior calibration check)

The model/dataset/LLM navigation map for this codebase. Answers "what models exist, what features they take, what LLM calls run, what public datasets back them" without forcing a code search. For the system-level picture — infrastructure topology, all data planes, the S3/Glue lakehouse, and how data reaches the frontend — start at **`docs/ARCHITECTURE.md`** (the entry point; it wins where docs disagree). Deep dives live in their own docs (linked); this file points to them.

When you add a new model, LLM call, dataset, or data stream → edit the relevant section here and bump the date.

---

## 1. System overview

```
                                         ┌─────────────────────────────────────┐
                                         │   PUBLIC DATASETS (training/eval)    │
                                         │   Lazzaretti · Severson · NASA       │
                                         │   NREL Soiling Map · GPVS · Sandia   │
                                         └─────────────────┬────────────────────┘
                                                           │
                                                           ▼
  CLIENT SCADA                                  ┌──────────────────────┐
  (in prod replaces  ──┐                        │ FOUNDATION MODELS    │
  backenddata/scada)   │                        │ • pv_classifier_v1   │
                       ▼                        │ • bess_lfp_v1        │
  ┌──────────────────────────┐                  │ • soiling_foundation │
  │  INGESTION                │                 │   (per-zone)         │
  │  ──────────              │                  └──────────┬───────────┘
  │  DataConnection           │                            │
  │   (influxdb/sql/modbus/   │                            │
  │    csv/huawei_api)        │                            │
  │       │                   │                            │
  │       ▼                   │                            │
  │  FieldMapping             │      ┌─────────────────────▼──────────────────┐
  │   (110+ regex patterns +  │      │ DETECTION CASCADE                       │
  │    LLM polish ↓0.7 conf)  │      │ ──────────────                          │
  │       │                   │      │ Layer 1: rule_based.py    (day 1)       │
  │       ▼                   │      │ Layer 2: digital_twin     (≥7 d data)   │
  │  PollingJob               │      │ Layer 3: foundation model (day 1)       │
  │   (15-min cadence)        │      │ Layer 4: BedrockFaultClassifier         │
  │       │                   │      │           (triage-gated LLM override)   │
  │       ▼                   │      └─────────────────────┬──────────────────┘
  │  PlantAgnosticFeature─────┼──────► features ───────────┘
  │  Engine (scale-invariant) │                            │
  │                           │                            ▼
  └───────────────────────────┘                ┌──────────────────────┐
                                               │  OUTPUTS              │
                                               │  • Tickets (NEW→DONE) │
                                               │  • SoilingForecast    │
                                               │  • RUL predictions    │
                                               │  • Cascade summary    │
                                               └──────────┬───────────┘
                                                          │
                                                          ▼
                                               ┌──────────────────────┐
                                               │  LLM POLISH (14)      │
                                               │  Narration · Briefing │
                                               │  Insights · Chat      │
                                               │  Threshold tuning     │
                                               │  Warranty extraction  │
                                               │  Fleet synthesis      │
                                               └──────────────────────┘
```

Five entry points to the system: (1) public datasets train foundation models, (2) client SCADA streams in through `DataConnection`, (3) the four-layer cascade emits classifications, (4) outputs land as Tickets / Forecasts / RUL, (5) LLM polish layer narrates, tunes, and synthesizes.

---

## 2. Data streams

### Today (demo) — `backenddata/scada/{plant_id}/`
- 7 named plants: `ribera`, `alpha`, `eta`, `epsilon`, `gamma`, `delta`, `zeta`
- Parquet timeseries: hourly metrics per inverter (AC power, DC voltage/current, irradiance, module temp)
- Hand-mapped column conventions, hardcoded `PLANTS` dict in `scripts/train_all_rul_models.py`

### Production — Prisma-backed multi-tenant ingestion
A new client follows this path (see `src/app/api/connections/[connectionId]/discover/route.ts`):

```
1. POST /api/connections          → DataConnection row (encrypted creds)
2. POST .../discover              → FieldMappingIntelligence runs
                                  → (regex pass)
                                  → llmPolishMappings() for confidence <0.7
                                  → FieldMapping rows persisted
                                  → DiscoveredPlant rows persisted
3. PollingJob (default 15 min)    → fetches → stores measurements
4. generatePlantConfig()          → YAML for downstream PV/BESS detectors
                                  → (LLM threshold tuner — Phase K-2b — applies overrides)
```

Connection types supported (Prisma enum `ConnectionType`): `influxdb`, `sql_scada`, `modbus_tcp`, `csv_upload`, `huawei_api`, `sungrow_api`, `solaredge_api`, `sample_api`. Maturity per connector (which of these are live-validated) is tracked in `docs/ARCHITECTURE.md` §4, not here. Adding a new vendor = new entry in `field-mapping-intelligence.ts` hierarchy patterns + (optionally) a custom discover handler in `discover/route.ts`.

**Multi-tenant scoping**: every row is `org_clerk_id`-scoped at the Prisma level. `PlantAccess` ACL (VIEW / OPERATE / MANAGE) gates per-user access within an org.

### Plant-agnostic features
`nuravolt/fault/features.py:PlantAgnosticFeatureEngine` normalizes raw signals into scale-invariant ratios (per-unit power, efficiency, string-current CV, PR, current ratio vs irradiance) so a 5 kW rooftop's features are comparable to a 500 MW utility plant's. **Every foundation model below operates on these normalized features** — never raw absolute amps/volts.

---

## 3. Models registry

Every ML model in the codebase, grouped by domain. Validation numbers come from `backenddata/validation/summary.json` (regenerate via `python scripts/validate_all.py`).

### PV faults

| Stage | File | Type | Trained on | Features | Validation |
|---|---|---|---|---|---|
| Rule (Layer 1) | `nuravolt/fault/rule_based.py` | hand thresholds | n/a | raw signals + clearsky | macro-F1 **0.204** on Lazzaretti, measured on the shipped class itself (`pv/shipped_detector_lazzaretti.json`). The **0.835** quoted elsewhere is a different implementation, `nuravolt/validation/pv_row_classifier.py`, whose thresholds are fitted to Lazzaretti's own percentiles: it is an upper bound, not this detector's score |
| Twin residual (Layer 2) | `nuravolt/digitaltwin/hybrid_model.py` | physics + CatBoost ensemble | per-plant 365d | inverter outputs vs physics expectation | residual-based; see `docs/technical/TRANSFER_LEARNING_TECHNICAL.md` |
| Foundation (Layer 3) | `models/foundation/pv_classifier_v1.pkl` | LGBMClassifier (200 trees, depth 8) | Lazzaretti 397K rows | 7 plant-agnostic (`poa_irradiance, module_temp, i_mean, i_imbalance, v_imbalance, v_mean, current_ratio`) | macro-F1 **0.998** on 99K held-out (loader: `nuravolt/foundation/pv_classifier.py`) |
| AI override (Layer 4) | `nuravolt/fault/ai_classifier.py:BedrockFaultClassifier` | Qwen 3 32B on Bedrock | n/a (LLM) | prior chain + raw signals | triage-gated, 24h cache, see [LLM section](#5-llm-use-cases-14-sites) |
| RUL (per fault type) | `models/rul/rul_*.pkl` (7 models) | LightGBM regressors | Lazzaretti 989K train / 274K test | feature engineering in `nuravolt/fault/features.py:RULFeatureEngine` | see table below |

**RUL models** (`models/rul/training_summary.json` is the source of truth):

| Fault type | MAE (days) | Within 7d | Within 30d | Production-ready? |
|---|---|---|---|---|
| `bypass_diode` | 0.35 | 100% | 100% | ✅ |
| `inverter_thermal` | 0.48 | 100% | 100% | ✅ |
| `thermal_hotspot` | 0.54 | 100% | 100% | ✅ |
| `string_degradation` | 0.69 | 100% | 100% | ✅ |
| `mismatch` | 1.34 | 96% | 100% | ✅ |
| `module_degradation` | 4.75 | 71% | 100% | ⚠️ marginal (`meets_criteria: false`) |
| `insulation` | 7.18 | 56% | 99.9% | ⚠️ marginal (`meets_criteria: false`) |

Deep dive: `docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md`, `docs/FAULT_DETECTION_CATALOG.md`.

### BESS

| Stage | File | Type | Trained on | Features | Validation |
|---|---|---|---|---|---|
| Universal warranty (reactive) | `nuravolt/fault/bess_fault_detector.py:BessFaultDetector` | hand thresholds | n/a | SoH, cycle count, temp dwell, C-rate | universal — works any chemistry |
| RUL: capacity fade | `nuravolt/fault/bess_rul_models.py` | linear extrapolation | per-cell observed | capacity vs cycle | NASA: 69% within ±10% (MAPE 29.5%) |
| Foundation: LFP | `models/foundation/bess_lfp_v1.pkl` | LGBMRegressor (200 trees, depth 4) | Severson 123 cells | 9 delta-Q + per-cycle (`log_var_delta_q, log_mean_abs_delta_q, log_min_delta_q, delta_q_skew, capacity_at_cycle_2/100, capacity_max_first_100, slope_first_100, cycles_to_99pct`) | LOO **MAPE 17.2%, 49% within ±10%, 84% within ±25%** (loader: `nuravolt/foundation/bess_router.py`) |
| Foundation: NMC | (pending) `models/foundation/bess_nmc_v1.pkl` | LGBMRegressor | NASA + Multi-Stage BESS (TBD) | same delta-Q + capacity feature shape | router falls back to "no_model" + universal warranty |
| LLM warranty extractor | `nuravolt/llm/warranty_extractor.py` | Qwen 3 32B on Bedrock | n/a | warranty PDF text | physics-bounded 10-field taxonomy |
| SoH estimator (**never trained**) | `nuravolt/bess/soh_estimator.py:SoHEstimator` | LightGBM, design only | nothing — no artifact exists to load | electrical + thermal + cycling features | n/a. `predict()` **raises `NotImplementedError`** when unloaded rather than returning a number from an unfitted booster. Training it needs real `BessCapacityTest` rows of `test_type` 'standard' or 'partial'; fitting on modelled SoH would launder the degradation model's assumptions back as independent evidence. Every SoH the platform serves comes from `EmpiricalDegradationModel` in `warranty_tracker.py` |
| RUL projection (linear, with a derived interval) | `nuravolt/bess/soh_estimator.py:SoHEstimator.predict_rul` | OLS on observed SoH vs cumulative cycles | the asset's own observations, when supplied | `soh_history` = (cumulative_cycles, soh) points | The projection is linear, so its uncertainty is derivable: regress SoH on cycles, take the standard error of the slope, map the 95% interval on the degradation rate onto an interval on cycles-to-EOL. Returns `confidence`, `confidence_level`, `confidence_basis`, `fit_r2`, `n_observations` and low/high bounds. **Fewer than 3 points with spread in cycles → `confidence` and the bounds come back `None`**, not a hardcoded number |
| Sub-asset imbalance | `nuravolt/bess/imbalance.py` | median + MAD modified z-score, flagged at \|mz\| > 3.5 | n/a (statistical) | per-rack / per-module temperature, voltage, SoC vs the sibling median | Median/MAD, not mean/std, because a mean/std test computes its dispersion from a population containing the outlier, so one failing rack widens the band enough to hide itself. Where sub-asset telemetry is absent the metric is reported `SUB_ASSET_UNAVAILABLE` — **never a zero spread**, which would read as "perfectly balanced". Pinned by `tests/bess/test_imbalance.py` |

#### BESS market data and pipelines (not models — deterministic, but this is where to find them)

| Piece | File | What it is |
|---|---|---|
| Zone router | `nuravolt/pipeline/market_prices.py` | `zone_for_country`, `day_ahead_periods(day, zone)`, `periods_per_day`. Normalizes every market to `{date, zone, currency, resolution_minutes, price_source, prices}`. Consumers derive energy as `power_kw * resolution_minutes / 60` and must never assume a period is an hour. `day_ahead_curve` / `range_curves` / `synthetic_day_curve` survive as deprecated Iberian-only aliases |
| GB market | `nuravolt/markets/gb.py` | Elexon Insights (market index price, DISEBSP imbalance prices, per-BMU balancing-mechanism acceptance stacks) + NESO CKAN (response/reserve auction clearing prices). Key-free; GB left ENTSO-E after Brexit. 48 half-hourly GBP periods per day, live-verified 2026-07-28. **No synthetic rung**: a failed fetch raises `PriceFetchError`. MID is a market **index** price, not a day-ahead auction clearing price, and captions must say so. Zero-price/zero-volume rows from non-trading providers are skipped, so a window where nobody traded raises rather than valuing a battery at zero. `TODO(verify)`: NESO clearing-price sign convention and the untimezoned `deliveryStart`/`deliveryEnd` |
| Iberian market | `nuravolt/markets/iberia.py` | Ladder: committed OMIE CSV (`public/data/prices/omie_es_2025-2026.csv`, ~12 months real ES/PT hourly) → live via `entsoe.py` (A44 with a token, else energy-charts.info, which serves 96 quarter-hourly periods) → a labelled synthetic duck curve for days past the day-ahead horizon. Imbalance uses ENTSO-E documentType A85 — **the A85 parser has never seen a live payload** (no token in this environment) and is written from the documented `Balancing_MarketDocument` shape; its output must not be treated as measured until checked |
| Provider plumbing | `nuravolt/markets/_cache.py`, `nuravolt/markets/errors.py`, `nuravolt/markets/entsoe.py` | Month-span disk cache, `PriceFetchError`, ENTSO-E A44 client + energy-charts fallback |
| Three-lane revenue ledger | `nuravolt/pipeline/bess_revenue_assurance.py` | MEASURED (delivered energy valued at a published index — a price-taker imputation, not settled revenue; plus, GB only and only with a declared BMU id, real settled BM revenue rebuilt from the Elexon acceptance stacks) · DECLARED (from the `Contract` / `ContractTerm` layer) · BENCHMARK (perfect-foresight bound from `nuravolt/bess/optimizer_audit.py`, plus the NESO ancillary benchmark for GB). **The lanes are never summed** — the same power trace is identical whether it was arbitrage, an accepted BM offer or a frequency response, so attributing it would be a fabrication and adding the lanes would triple-count the megawatt-hour. One derived KPI: the gap to the benchmark, captioned as a ceiling. Writes `analysis_results` (domain='bess', device_id `BESS <external_asset_id>`, one `model_version` per lane) + an `AnalysisArtifact` of kind `bess_revenue_assurance`. Idempotent by `uuid5(asset, lane)` |
| Measured telemetry bridge | `nuravolt/pipeline/bess_measured.py` | Lake-to-relational: reads the published daily gold out of `analysis_results` and materializes `BessCycleRecord` / `BessCapacityTest` / `BessWarrantyStatus` through the existing engine (`cycling_analysis`, `warranty_tracker`, `pipeline.calculate_health_score`) — it recomputes nothing. `TelemetryRegime` partitions the calendar between the modelled and measured writers so neither can overwrite the other. `rainflow_data` stays NULL for these rows because a daily gold carries no sub-daily SoC, and SoH is `bms_reported` when the pack reports one, else inferred from the degradation model with the basis written into the row's notes, else not claimed at all |

### Soiling

> **Design intent:** the whole point of the soiling stack is **per-inverter** SR
> estimation, NOT plant-mean. A typical plant has one DustIQ reference sensor,
> so per-inverter SR has to be *inferred* from per-inverter AC kW + irradiance
> + cell temperature (the soiling-attributable residual after the digital twin
> removes weather, curtailment, and temperature). Plant-mean is the day-1
> fallback only.

| Stage | File | Type | Trained on | Features | Validation |
|---|---|---|---|---|---|
| Climate prior (day 1) | `nuravolt/soiling/client_baseline.py:climate_prior_forecast` | lookup | 7 zone literature priors | lat/lon → zone | 7/7 zones resolve correctly; NREL overlay activates for US plants within 300km |
| pvlib physics | `nuravolt/soiling/pvlib_forecast.py:universal_forecast` | HSU / Kimber | physics | rainfall, PM2.5/PM10, surface tilt | universal, no training |
| Pseudo-label transfer | `nuravolt/soiling/sr_ml_model.py` | LightGBM (Quantile loss) | rain + AOD + PR patterns | weather + AOD + clearsky residual | per-plant; see `docs/technical/TRANSFER_LEARNING_TECHNICAL.md` |
| **Foundation (per climate zone)** | `backenddata/models/soiling_foundation_{ZONE}.pkl` (MEDITERRANEAN, TEMPERATE_CONTINENTAL) + generic `soiling_foundation_model.pkl` | `SoilingFoundationModel` (asymmetric loss, conservative bias 0.02) | All DustIQ-equipped plants (ribera, zeta, epsilon) | location-invariant environmental features only | DustIQ-vs-prediction; see `docs/technical/SOILING_METHODOLOGY.md` |
| Per-plant foundation | `backenddata/models/soiling/sr_foundation_{plant_id}.pkl` (alpha1, ribera, eta) | same class, plant-tuned weights | DustIQ + plant-specific weather | as above | per-plant DustIQ ground truth |
| DustIQ ML | `nuravolt/soiling/sr_ml_model.py` (DustIQ variant) | LightGBM Quantile α=0.3 | DustIQ-equipped plants only | features in `sr_ml_features.py` | per-plant macro RMSE |
| **Per-inverter SR (the actual product)** | `nuravolt/soiling/per_inverter_analysis.py` + `nuravolt/soiling/sr_per_inverter_features.py`; trainer `scripts/train_per_inverter_sr.py`; backfill `scripts/backfill_per_inverter_sr.py` | `PerInverterSRModel` (LightGBM) | per-inverter SCADA AC kW + irradiance + cell temp residual after digital-twin removal | per-inverter `PR_soiling = PR_observed / PR_temp_corrected_expected`; group_id one-hot; rolling window | not yet run end-to-end on a customer plant — see Known gaps |

Deep dives: `docs/technical/SOILING_METHODOLOGY.md`, `docs/technical/SOILING_INTELLIGENCE_TECHNICAL.md`, `nuravolt/soiling/sr_foundation_model.py` docstring.

**`public/data/soiling/{plant}/all_inverters.json` (real since 2026-07):** the
per-inverter SR values rendered by the demo (heatmap tiles, top/worst-performer
tables, zone severity buckets) are generated from **measured per-inverter
data** by `scripts/generate_per_inverter_soiling.py`: self-normalized measured
PR calibrated to the plant's DustIQ sensor (ribera, eta) or
irradiance-normalized raw SCADA via `PerInverterSoilingAnalyzer` (alpha).
Every artifact carries `metadata.provenance.source = 'measured_per_inverter'`
and the generator refuses to write a flat (broadcast) fleet; the old
fleet-mean + jitter placeholder chain (`generate_ml_soiling_predictions.py`)
is deleted. Served-artifact physics tests: `tests/soiling/test_served_artifacts.py`.

---

## 4. Foundation models

What we have on disk RIGHT NOW. Read each `.meta.json` for full numbers; this is the headline.

| Model | Path | Trained on | What it predicts | Headline metric |
|---|---|---|---|---|
| **PV classifier v1** (Lazzaretti shape) | `models/foundation/pv_classifier_v1.pkl` + `.meta.json` (3.5 MB) | Lazzaretti 397K rows train / 99K test | 5-class PV fault (normal / short / degradation / open / partial shading) | macro-F1 **0.998** on held-out 99K |
| **PV classifier GPVS v1** *(NEW Phase N)* | `models/foundation/pv_classifier_gpvs_v1.pkl` + `.meta.json` (5.6 MB) | GPVS 256K rows train / 64K test | 8-class fault (normal + 7 fault types in F0-F7 taxonomy) | macro-F1 **0.766** on held-out 64K |
| **PV router** *(NEW Phase N)* | `nuravolt/foundation/pv_router.py` | n/a | Picks classifier by client feature shape (per-string Lazzaretti vs system-level GPVS) | dispatches by `detect_shape()` |
| **BESS-LFP v1** | `models/foundation/bess_lfp_v1.pkl` + `.meta.json` (207 KB) | Severson 123 A123 LFP cells at 30°C | log10(EOL cycle), 0.88 Ah threshold (80% of 1.1 Ah) | LOO **17% MAPE, 49% within ±10%**; naive linear **75% within ±10%** on second LFP dataset (cross-validation) |
| **BESS-NMC v1** | `models/foundation/bess_nmc_v1.pkl` + `.meta.json` (175 B) | NASA PCoE — 13 well-formed 18650 NMC cells; linear extrapolation (LGBM attempt failed — only 3 cells passed prereqs) | EOL_cycle, 1.4 Ah threshold (70% of 2.0 Ah NMC convention) | MAPE 29.5%, **69% within ±10%, 85% within ±25%** |
| **Soiling foundation (per zone)** | `backenddata/models/soiling_foundation_MEDITERRANEAN.pkl` (191 KB), `..._TEMPERATE_CONTINENTAL.pkl` (192 KB), generic `..._model.pkl` (189 KB) | DustIQ-equipped plants (Mediterranean: ribera, zeta; Continental: epsilon) | daily soiling ratio | conservative bias (negative MBE) — see `SoilingFoundationModel` docstring |
| **Soiling per-plant** | `backenddata/models/soiling/sr_foundation_{alpha1,ribera,eta}.pkl` | DustIQ + that plant's weather | daily SR for that plant | per-plant DustIQ RMSE |

### Missing / pending
| Model | Why missing | Effort |
|---|---|---|
| BESS-NMC v1 (LightGBM upgrade) | Phase N-4 attempted — NASA's delta-Q featurization works but only 3 cells pass the EOL ≥ 100 filter (stress-test bias). Need 20+ NMC cells with long-life trajectories. Battery Archive walled. The 2025 French dataset (DOI 10.57745/OLBXKT) has 20 LFP cells fetchable; NMC equivalent would need new source. | depends on NMC data availability |
| BESS-NCA v1 | Sparse public data | scope TBD |
| Soiling foundation for non-Mediterranean / non-Continental zones | DustIQ donor plants exist only in those two zones; need DustIQ rollout to MENA / Sahel / India / SW US | depends on client equipment |
| **Per-inverter SR from live telemetry** | DONE for the flagships (2026-07): `scripts/generate_per_inverter_soiling.py` serves measured per-inverter SR (self-normalized PR + DustIQ calibration / SCADA analyzer). Remaining gap: org plants onboarded WITHOUT historical per-inverter data get the honest plant-mean fallback until their own telemetry accrues; no automatic nightly re-run of the generator yet. | wire the generator into the nightly refresh once live per-inverter feeds exist |
| Climate prior recalibration | Phase N-5 found ALL 3 PVDAQ sites fail ±30% match. Need to revise literature priors using observed rdtools rates + add SE US humid subtropical zone (9069 currently lands in UNKNOWN). | 4-6 hours once we have more PVDAQ sites validated |
| Soiling foundation extension | Could train SE US humid subtropical foundation from PVDAQ 9069 + similar sites (if more available). | scope TBD |
| BESS-LFP delta-Q on 2025 dataset | Per-cell ZIPs (1.2 GB × 20 = 24 GB) on disk would unlock cross-dataset delta-Q validation of `bess_lfp_v1`. | manual fetch decision (24 GB) |

### Foundation → per-client fine-tune transition

Phase K plan (in `/Users/jeffr/.claude/plans/compressed-brewing-lake.md`) defines the four-layer client cascade. Activation timeline:

| Client age | Active layers |
|---|---|
| Day 1 | Layer 1 (rule_based) · Layer 3 (foundation) · Layer 4 (LLM AI override) · Universal warranty (BESS) · Climate prior (soiling) |
| 7 days | + Layer 2 (digital twin residual on client data) |
| 30 days | + Per-plant soiling adapter (PR-residual proxy) · BESS Kalman online updating |
| 90 days OR 100 labeled events | + Foundation few-shot fine-tune on client data |
| Quarterly | Foundation models re-released using patterns across all clients |

Per-client tuning today: `nuravolt/llm/threshold_tuner.py` produces per-plant threshold overrides at onboarding (applied via `FaultDetectionConfig.apply_overrides()`).

---

## 5. LLM use cases (14 sites)

The canonical deep-dive is **`docs/AI_AND_LLM_USAGE.md`** — read it for the original 8 use cases (prompts, JSON schemas, token costs, persisted tables). What follows is the index + the 6 Phase K additions.

### Index

| # | Use case | File | Path | Model | Fallback |
|---|---|---|---|---|---|
| 1 | Copilot chat | `/api/chat` | `src/app/api/chat/route.ts` | Claude Haiku 4.5 | tool-call error → graceful message |
| 2 | Page briefings | `/api/chat/briefing` | `src/lib/ai/briefings.ts:generatePlantBriefing/generateInverterBriefing` | Claude Haiku 4.5 | returns null → UI hides briefing |
| 3 | KB embeddings | `/api/chat/kb/upload` | `src/lib/ai/kb-ingest.ts` | `amazon.titan-embed-text-v2:0` | upload fails fast |
| 4 | Plant insights card | `/api/llm/insights` | `src/app/api/llm/insights/route.ts` | Claude Haiku 4.5 | error message returned |
| 5 | Alert interpretation | `/api/llm/interpret-alert` | `src/lib/ai/interpret-alert-core.ts` | Claude Haiku 4.5 | rule-based fallback in `nuravolt/llm/alert_interpreter.py` |
| 6 | Inverter diagnosis | `/api/ai/inverter-diagnosis/[plantId]/[inverterId]` | route file same name | DeepSeek-V3 or Claude Haiku via `BEDROCK_MODEL_ID` | rule classifier upstream |
| 7 | LLM usage view | `/api/llm/usage` | route file same name | n/a (read-only) | n/a |
| 8 | Reply generation | `automation/ai/claude_client.py` | same | Claude Sonnet 4 | none (offline tool) |
| **9** | **Fault classifier override (cascade L4)** | `nuravolt/fault/ai_classifier.py:BedrockFaultClassifier` | same | Qwen 3 32B (Claude when allowed) | synthetic candidate from `cascade_attribution.py` |
| **10** | **Field-mapper polish** | `src/lib/services/field-mapping-llm.ts:llmPolishMappings` | called from `discover/route.ts` when confidence <0.7 | Claude Haiku 4.5 | regex result kept |
| **11** | **Threshold tuner** | `nuravolt/llm/threshold_tuner.py:tune_thresholds` | called at plant onboarding | Qwen 3 32B | fleet defaults kept |
| **12** | **Warranty extractor** | `nuravolt/llm/warranty_extractor.py:extract_warranty_terms` | called when client uploads BESS contract PDF | Qwen 3 32B | universal warranty rules kept |
| **13** | **Fleet insights** | `src/lib/ai/briefings.ts:generateFleetInsights` | `/api/llm/fleet-insights` GET | Claude Haiku 4.5 | returns null → UI hides tile |
| **14** | **Fleet insights endpoint** | `src/app/api/llm/fleet-insights/route.ts` | thin wrapper on #13 | (same) | (same) |

**Bold = added in Phase K** (after May 2026 `AI_AND_LLM_USAGE.md` review).

### Cost gates summary

- **Triage-gated** (high-stakes only): #9 fault classifier override — `should_invoke_ai()` filters on confidence <0.5, days_to_fault >30, revenue <€100, etc.
- **Confidence-gated**: #10 field mapper — only fires when regex < 0.7
- **Cache-backed**: #9 (24h disk cache), #11 (30-day disk cache)
- **Hard daily cap recommendation**: Phase K plan section "Key architectural decisions" lists `LLM cost ceiling per plant` as a pending product decision.

### Auth (TS path)
Production prompts use Bedrock with bearer token `AWS_BEARER_TOKEN_BEDROCK` (currently commented out in `.env` — uncomment to enable TS-side LLM polish). Python path uses regular `AWS_ACCESS_KEY_ID` via boto3 and already works.

---

## 6. Public datasets

| Dataset | License | Where on disk | Size | Use | Fetcher |
|---|---|---|---|---|---|
| **Lazzaretti / UTFPR PV** | CC BY 4.0 | `backenddata/datasets/lazzaretti/lazzaretti_faults.parquet` | 1.37M rows, 5 classes | Trains PV foundation v1, all 7 RUL models, validates rule cascade surrogate | `backenddata/datasets/labeled/download_lazzaretti.py` |
| **Severson MIT-Stanford LFP** | CC BY 4.0 (via HF mirror `bsebench-org/severson-2019`) | `backenddata/datasets/severson/raw/*.parquet` + `cells.parquet` | 124 LFP cells, 2.4 GB raw | Trains BESS-LFP foundation v1 | `scripts/fetch_severson_battery.py` + `scripts/preprocess_severson_battery.py` |
| **NASA PCoE Battery** | NASA public | `backenddata/datasets/nasa_pcoe/` (6 unzipped batches) | 42 cells, ~200 MB | Trains BESS-NMC foundation v1 (Phase M-4), validates BESS linear baseline (69% within ±10%) | `curl https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip` + `scripts/preprocess_nasa_pcoe.py` |
| **NREL Soiling Map** | NREL public | `backenddata/datasets/nrel_soiling_map/nrel_soiling_monthly.csv` | 146 US sites × monthly | NREL site overlay for US plants in `client_baseline.py` | `scripts/fetch_nrel_soiling_map.py` |
| **GPVS-Faults** *(NEW, Phase M)* | CC BY 4.0 | `backenddata/datasets/gpvs_faults/CSV_Files/F[0-7][LM].csv` | 16 CSVs, 8 fault classes × 2 modes, ~470 MB | Cross-dataset PV validation (validates rule transferability — macro-F1 0.189) | Manual Mendeley download to `~/Downloads/CSV_Files.zip` → `unzip` to `backenddata/datasets/gpvs_faults/` |
| **Sandia PV-IV-EL** *(NEW, Phase M-2)* | DOE public | `backenddata/datasets/sandia_pv_iv_el/{IV,RefIV}/` + `AnonDB.csv` | 613 IV measurements, 438 modules, 28 MB (EL.zip 17 GB skipped) | Time-trend PV degradation validation — fleet mean fade rate 0.887 %/yr matches Jordan & Kurtz 2013 published 0.5-1.0 %/yr literature | `scripts/fetch_sandia_pv_iv_el.py` — direct download from `data.openei.org/files/8378/` |
| **Sandia SAT** | CC0 | (not yet fetched) | tracker faults Jun-Nov 2023 Albuquerque | Tracker-specific validation | DuraMAT Datahub SPA — manual download required |
| **PVDAQ NREL** *(Phase M-1 — channels unlocked)* | NREL public | `backenddata/datasets/pvdaq/system_{34,1430,2107,7334_5min,9069}/*.parquet` + `cleaned/` per system | 5 systems, ~5.2 GB capacity | Per-day soiling SR ground truth (rdtools IWSR 0.949 on system 2107 — 6 yrs); long-term degradation (system_34 = 10 yrs available) | `scripts/preprocess_pvdaq_system.py {id}` — channel catalog in `nuravolt/validation/adapters/pvdaq_channels.py` |
| **Battery Archive** *(walled)* | — | (no public API) | many cells | NMC + LFP consolidation | Email `info@batteryarchive.org` for CSV access — public site is dashboard-only |
| **OMIE ES/PT day-ahead** *(BESS)* | public market data | `public/data/prices/omie_es_2025-2026.csv` (committed) | ~12 months hourly ES+PT clearing prices | Grounds Iberian BESS dispatch, arbitrage benchmark and revenue in real prices with no API token | committed to the repo; see `public/data/prices/README.md` |
| **Elexon Insights (GB)** *(BESS)* | public, key-free | fetched live, month-span disk cache | half-hourly: market index price, DISEBSP imbalance prices, per-BMU BM acceptance stacks | GB price curves and reconstruction of settled Balancing Mechanism revenue from a declared BMU id | `nuravolt/markets/gb.py` (`https://data.elexon.co.uk/bmrs/api/v1`) |
| **NESO Data Portal (GB)** *(BESS)* | public CKAN, key-free | fetched live | response/reserve auction clearing prices | GB ancillary benchmark lane | `nuravolt/markets/gb.py` (`https://api.neso.energy/api/3/action`); daily resources hold only the latest auction round, history is in the per-financial-year archive resources |
| **ENTSO-E Transparency** *(BESS)* | requires `ENTSOE_API_TOKEN` | fetched live | A44 day-ahead prices, A85 imbalance | Iberian live price rung and imbalance | `nuravolt/markets/entsoe.py`, `nuravolt/markets/iberia.py`. **No token in this environment**: the A44 path falls back to token-free energy-charts.info, and the A85 parser has never run against a live payload |

Adapters that translate each dataset to our schema live in `nuravolt/validation/adapters/` — one file per dataset.

---

## 7. Validation harness

> **The generated table in `docs/MODEL_ACCURACY.md` is the source of truth for every
> accuracy figure, and the only place one may be quoted from.** It is rendered from
> `public/data/validation/summary.json` by `scripts/render_model_accuracy_doc.py`, so it
> cannot drift from the artifacts. The headline table further down this section is a
> narrative snapshot and has already gone stale at least once; prefer the generated doc.

**One-shot driver**: `python scripts/validate_all.py` runs the entire suite, rewrites
`backenddata/validation/summary.json`, and mirrors every artifact into the tracked
`public/data/validation/`. `backenddata/` is gitignored (and its `!` negations are no-ops,
because git cannot re-include a path under an excluded directory), so the mirror is what
makes a published number reproducible by anyone who only has the repo.

### Per-domain validators
- `scripts/validate_twin.py` — digital twin, capacity-normalised error, physics vs ML
- `scripts/validate_forecast.py` — forecast skill score against a persistence baseline
- `scripts/validate_pv_faults.py` — rule-based **surrogate** on Lazzaretti (not the shipped detector)
- `scripts/validate_shipped_detector.py` — the shipped `RuleBasedFaultDetector` on the same data
- `scripts/validate_pv_lgbm.py` — LightGBM ceiling on Lazzaretti
- `scripts/validate_bess_rul.py` — naive baselines on NASA + Severson
- `scripts/validate_severson_delta_q.py` — Ridge regression with delta-Q features
- `scripts/validate_severson_lgbm.py` — LightGBM with delta-Q + companion features
- `scripts/validate_soiling.py` — NREL Map distribution + universal day-1 check

### Output structure
```
backenddata/validation/
├── pv/
│   ├── lazzaretti_holdout.json    # rule-based surrogate (fitted thresholds)
│   ├── shipped_detector_lazzaretti.json  # the code that actually ships
│   └── lazzaretti_lgbm.json       # LGBM ceiling
├── bess/
│   ├── nasa.json
│   ├── severson.json              # naive baseline
│   ├── severson_delta_q.json      # Ridge
│   └── severson_lgbm.json         # LightGBM
├── twin/                          # capacity-normalised twin error, walk-forward
├── forecast/                      # skill score vs persistence
├── soiling/
│   ├── nrel_map_sites.json
│   ├── pvdaq_system_34.json       # pending implementation
│   └── universal_dayone.json      # Phase K Pillar 3
└── summary.json                   # aggregate headline numbers
```

### Current headlines (as of 2026-06-21, after Phase M)

| Domain | Model | Headline |
|---|---|---|
| PV | rule detector, **as shipped** | macro-F1 **0.204** on 200K Lazzaretti rows (`pv/shipped_detector_lazzaretti.json`); addresses 2 of 5 labelled classes |
| PV | rule-based **surrogate**, thresholds fitted to this dataset | macro-F1 **0.835** on 99K Lazzaretti held-out — an in-distribution upper bound for a separate implementation, not a measurement of the shipped code |
| PV | LightGBM foundation | macro-F1 **0.998** on 99K Lazzaretti held-out |
| PV | **GPVS-shape LightGBM** *(NEW Phase N)* | macro-F1 **0.766** on 64K held-out GPVS rows — companion model for system-level 3-phase clients |
| PV | GPVS cross-dataset (row classifier) | macro-F1 **0.189** on 80K GPVS rows — honest "doesn't transfer cleanly" finding |
| PV | Sandia PV-IV-EL fleet fade | mean fade **0.887 %/yr**, median **0.724 %/yr** across 166 modules — matches Jordan & Kurtz 2013 literature |
| PV | **module_degradation RUL cross-dataset** *(NEW Phase N)* | Spearman **-0.375** on 9 PV-IV-EL modules — **partial transfer** (correct rank, wrong absolute days-to-fault scale) |
| BESS | NASA linear (NMC) | **69% within ±10%** of actual EOL (13 well-formed cells) |
| BESS | Severson Ridge delta-Q | **48% within ±10%**, MAPE 18.9% (123 cells, LOO) |
| BESS | Severson LightGBM delta-Q | **49% within ±10%**, MAPE 17.2% (123 cells, LOO) |
| BESS | **LFP second-life 2025 cross-dataset** *(NEW Phase N)* | **75% within ±10%**, **85% within ±25%** on 20 cells from a different LFP vendor than Severson — naive baseline transfers cleanly |
| Soiling | NREL Map distribution | p25 0.088 / p50 0.107 / p75 0.136 %/day across 146 US sites |
| Soiling | PVDAQ system 2107 + rdtools (CA Med) | IWSR **0.949** on 2,557 days, 136 intervals |
| Soiling | **PVDAQ system 7334 + rdtools** *(NEW Phase N)* | IWSR **0.960** on 1,884 days at Shine On Solar (CA utility 257MW), 31 intervals |
| Soiling | **PVDAQ system 9069 + rdtools** *(NEW Phase N)* | IWSR **0.920** on 2,815 days at Social Circle GA (humid subtropical), 183 intervals — dirtiest of the 3 |
| Soiling | **Climate prior vs PVDAQ cross-check** *(NEW Phase N)* | All 3 sites FAIL ±30% match — climate prior is rough baseline, needs recalibration. 2107 over-predicts (-53%), 7334+9069 under-predict (+116%, +104%) |
| Soiling | Universal day-1 | 7/7 climate zones resolved correctly; NREL overlay activates for US plants |
| Twin | Alpha 15-min, walk-forward | **nMAE 6.7% of AC nameplate** (physics-only 6.6%, ML uplift −1%) on 42,229 intervals |
| Twin | Leave-one-plant-out (unseen site) | **nMAE 11.2% of mean daily energy** on 9,495 plant-days |
| Forecast | Day-ahead, no NWP feed | **skill −0.032 vs persistence** — does not beat "same as yesterday"; oracle with observed irradiance is 13.2% |

Metrics methodology and tradeoffs: see code in `nuravolt/validation/metrics/{classification,rul,soiling}.py`.

### Client-facing overviews — send these, not a screenshot of the table above

`docs/overviews/` holds the documents written to be sent to a prospect. Prose is
hand-written; every number in them is machine-verified against
`public/data/validation/` by `scripts/check_overview_numbers.py`, which fails on a
figure that has drifted *and* on a figure with no annotation at all. PDFs render into
`sales-assets/` (gitignored, disposable) via `scripts/render_sales_pdf.py`.

| Document | Send it when | Leads with |
|---|---|---|
| `NuraVolt-Model-Overview.md` | A full technical evaluation, or due diligence | All seven model families, each with what it does *and* what it does not claim |
| `01-soiling.md` | Cleaning economics is the conversation | 1.44 pp vs a reference sensor; IWSR 0.92–0.96 vs rdtools on public data |
| `02-fault-detection.md` | Alarm fatigue, or "what do you actually detect" | Peer-relative rules that work on day one; per-fault precision and recall |
| `03-inverter-health-rul.md` | They ask about predictive maintenance or RUL | That we have **no** measured accuracy here, and why nobody honest does |
| `04-battery-bess.md` | Storage, warranty or degradation | 48.8% of cells within ±10% of true end of life vs 1% for extrapolation — and that the product surfaces are modelled |
| `05-digital-twin.md` | Performance benchmarking, or a data-migration objection | 6.6% nMAE of nameplate; that local history buys ~1.4% | <!-- ACCURACY-OK: both figures are verified against twin/twin_15min_alpha.json and twin/twin_local_data_curve.json by scripts/check_overview_numbers.py -->
| `06-forecasting-and-data-quality.md` | Forecasting came up as one word in an RFP | The soiling forecast we stand behind, and the generation forecast we withhold |

Three older assets cover overlapping ground and are **not** maintained against the
artifacts: `sales-assets/CAPABILITIES_OVERVIEW.md` (fault and RUL, carries design
*targets* for models since withdrawn), `sales-assets/nuravolt-catalog.html` (the product
catalog PDF) and `sales-assets/nuravolt-model-overview-sevenoaks.md` (the per-client
instance this master was generalised from). Prefer `docs/overviews/`.

---

## 8. Auth & multi-tenancy

**Clerk is gone.** Better Auth replaced it in 2026-07: server config `src/lib/auth.ts`, client `src/lib/auth-client.ts`, catch-all route `/api/auth/[...all]`. Zero files import `@clerk/nextjs`. The legacy `org_clerk_id` / `user_clerk_id` / `clerk_org_id` columns were kept and now store Better Auth ids (opaque strings, so no rename was needed), which is why the names survive in the schema and in the tenancy-scoping code.

`PlantAccess` (VIEW / OPERATE / MANAGE) still gates per-user access within an org, and every row is org-scoped at the Prisma level.

Current state and the deploy checklist live in `docs/ARCHITECTURE.md` §8 and `CLAUDE.md`. The old `CLERK_SOLUTION.md` / `CLERK_FIX.md` workaround notes were deleted with the migration. The `--max-http-header-size=32768` flag they justified is still set in `package.json` and `server.js`; nobody has checked whether Better Auth's cookie still needs it.

---

## 9. Phase K rollout status

Full strategy plan: `/Users/jeffr/.claude/plans/compressed-brewing-lake.md` (Phase K = "general-purpose client-agnostic detection models").

| Piece | Status | What landed |
|---|---|---|
| K-1a Climate-prior soiling baseline | ✅ shipped | `nuravolt/soiling/client_baseline.py` |
| K-1b pvlib physics forecast | ✅ shipped | `nuravolt/soiling/pvlib_forecast.py` |
| K-1c Universal soiling validator | ✅ shipped | `scripts/validate_soiling.py:_validate_universal` |
| K-2a LLM field-mapper polish | ✅ shipped | `src/lib/services/field-mapping-llm.ts` |
| K-2b LLM threshold tuner | ✅ shipped | `nuravolt/llm/threshold_tuner.py` |
| K-3 Wire LLM polish into discover route + `apply_overrides` | ✅ shipped | `src/app/api/connections/[connectionId]/discover/route.ts` + `nuravolt/fault/config.py:apply_overrides` |
| K-4 PV foundation classifier | ✅ shipped | `models/foundation/pv_classifier_v1.pkl` + `nuravolt/foundation/pv_classifier.py` |
| K-5 BESS chemistry router (LFP foundation + warranty PDF extractor) | ✅ shipped | `models/foundation/bess_lfp_v1.pkl` + `nuravolt/foundation/bess_router.py` + `nuravolt/llm/warranty_extractor.py` |
| K-6 Cross-fleet insight synthesizer | ✅ shipped | `src/lib/ai/briefings.ts:generateFleetInsights` + `/api/llm/fleet-insights` |
| K-7 Universal soiling demo route + UI | ✅ shipped | `/api/soiling/universal` + `UniversalSoilingCard` + `/showcase/universal-soiling` |
| BESS-NMC foundation | ⏸ pending data prep | NASA + Multi-Stage BESS preprocessing |
| Cross-dataset PV foundation | ⏸ blocked on manual fetch | Mendeley GPVS, DuraMAT Sandia SAT |
| PVDAQ per-day soiling validator | ⏸ pending channel mapping | requires OEDI metric_id catalog + rdtools install |
| Maintenance log labeler (Polish #3) | ⏸ pending | needs CMMS connector + label DB |
| Active learning loop (Polish #5) | ⏸ pending | needs `LabeledOverride` Prisma model |
| SOP generator (Polish #7) | ⏸ pending | needs OEM manual KB |
| Per-tenant adapter fine-tune (Phase 3) | ⏸ 90-day client gate | needs `LabeledOverride` first |
| Soiling foundation for non-Med/Continental zones | ⏸ depends on DustIQ rollout | data availability |

Key architectural decisions still pending product/eng alignment (see Phase K plan section "Key architectural decisions"): per-tenant adapter vs shared, auto-labeling threshold, retrain cadence, per-plant LLM cost ceiling, BESS chemistry detection method.

---

## 10. How to update this doc

When you add a new model / LLM call / dataset / data stream:

1. Edit the relevant section in this file.
2. If you added an LLM call, also add the deep-dive entry in `docs/AI_AND_LLM_USAGE.md`.
3. Bump `Last reviewed: YYYY-MM-DD` at the top.
4. If the change is structural (new section needed), update the section list.

Auto-generation from `models/foundation/*.meta.json` + `validation/summary.json` is **out of scope** for v1 — a manual edit keeps the doc honest. The numbers in this file reference the JSON artifacts, so the artifacts are the source of truth; this file is the narrative.

### Related deep dives (linked from above sections)

- `docs/DATA_ARCHITECTURE_GUIDE.md` — Iceberg+DuckDB-on-S3 lakehouse plan: storage/compute/dbt choices, phased migration, OOM fix
- `docs/AI_AND_LLM_USAGE.md` — every LLM call site, deep
- `docs/FAULT_DETECTION_OVERVIEW.md`, `docs/FAULT_DETECTION_CATALOG.md` — fault taxonomy
- `docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md` — rule + RUL implementation details
- `docs/technical/SOILING_METHODOLOGY.md`, `docs/technical/SOILING_INTELLIGENCE_TECHNICAL.md` — soiling forecasting depth
- `docs/technical/TRANSFER_LEARNING_TECHNICAL.md` — digital twin + transfer
- `docs/technical/DIGITAL_TWIN_CONFIGURATION_GUIDE.md` — per-plant twin config
- (`CLERK_SOLUTION.md` and `CLERK_FIX.md` were deleted with the Better Auth migration — auth now lives in `docs/ARCHITECTURE.md` §8)
- `docs/archive/LLM_IMPLEMENTATION_PLAN.md` — original LLM strategy (3K lines, mostly historical)
- `/Users/jeffr/.claude/plans/compressed-brewing-lake.md` — Phase K strategy (what's pending, why)
