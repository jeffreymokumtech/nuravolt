# NuraVolt — Architecture Hub

**Last reviewed: 2026-07-29** (BESS ingestion contract, lake path and device grain added; bronze compaction gap closed)

The single entry point for "how is this system put together". One topology diagram, one honest map of every data flow (client data in → analytics → frontend), the lakehouse layers, and how pre-existing/public data pre-trains the models. Depth lives in the linked deep dives; this file reconciles them and wins when they disagree.

Deep dives: `PROJECT_MAP.md` (models, datasets, LLM sites, navigation) · `DATA_ARCHITECTURE_GUIDE.md` (lakehouse decision record + as-built) · `AI_AND_LLM_USAGE.md` (LLM call sites) · `OPERATOR_INTEGRATION.md` (operator/residential onboarding plan).

When you change infrastructure, a data flow, or a storage location → update this file and bump the date.

---

## 1. Topology — everything on one page

```
                                ┌──────────────┐
        users ──── auth ───────►│ BETTER AUTH  │ (session cookie; protects /dashboard /admin /chat)
                                └──────┬───────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────────────────┐
│ VERCEL — Next.js 13.4 app, functions in `fra1` (Frankfurt)                   │
│ • Marketing site + demo UI + ops dashboard + API routes                      │
│ • Crons: NONE since 2026-09-14 (send-reports + narration-metrics removed    │
│   to cut usage; cron routes still exist and can be called by hand)          │
│ • Demo UI reads static JSON from public/data/* (checked into git)            │
└───────┬──────────────────────────────────────────────┬───────────────────────┘
        │ Prisma (ops state)                            │ AWS SDK (eu-west-1)
        ▼                                               ▼
┌───────────────────────────┐   ┌─────────────────────────────────────────────┐
│ SUPABASE Free Postgres    │   │ AWS — everything in eu-west-1 (Ireland)     │
│ (eu-central-1, 500 MB)    │   │ • S3 `nuravolt-lake` — the lakehouse        │
│ • Tickets, orgs, users,   │   │   bronze/ (Iceberg + raw) silver/ gold/     │
│   PlantAccess, Subscript. │   │ • Glue Data Catalog — Iceberg table registry│
│ • DataConnection,         │   │ • Bedrock — Qwen `qwen3-next-80b-a3b`       │
│   FieldMapping,           │   │   (all 14 LLM call sites)                   │
│   PollingJob,             │   │ • Secrets Manager + per-customer KMS        │
│   DiscoveredPlant         │   │   (client SCADA/API credentials)            │
│ • AlertInterpretation     │   │ • IAM: app key (rotate!) + `nuravolt-lake-  │
│   (LLM cache)             │   │   rw` scoped user for CI                    │
└───────────────────────────┘   └───────────────▲─────────────────────────────┘
                                                │ pyiceberg / DuckDB / boto3
        ┌───────────────────────────────────────┴───────────────┐
        │ GITHUB ACTIONS (scheduled batch worker, free tier)    │
        │ • dbt-daily.yml   02:00 UTC  bronze → silver → gold   │
        │ • poll-connections.yml  PAUSED 2026-09-14 (dispatch only) │
        └───────────────────────────────────────▲───────────────┘
                                                │
        ┌───────────────────────────────────────┴───────────────┐
        │ LOCAL DEV (laptop)                                    │
        │ • Python: conda env `nuravolt` (3.10) — ML, physics,  │
        │   digital twins, soiling; reads the lake via DuckDB   │
        │ • TimescaleDB docker — dev-only, being retired        │
        │ • ./lake — local dev Iceberg catalog (gitignored)     │
        └───────────────────────────────────────────────────────┘
```

Residency: storage, secrets, catalog, and LLM inference are all EU (`eu-west-1`); Supabase and Vercel functions are EU (`eu-central-1` / `fra1`). The only non-EU compute is GitHub-hosted runners (US) processing non-PII lake analytics.

> `vercel.json` previously pinned functions to `iad1` (US-East) — corrected to `fra1` on 2026-07-02: Supabase reads become same-region, S3 reads become intra-EU (Frankfurt↔Ireland, cents/mo), and the app stays EU end to end. Takes effect on next deploy.

---

## 2. Runtime inventory

| Where | What runs there | State |
|---|---|---|
| Vercel | Next.js app, API routes, 2 daily crons | Production |
| Supabase (Free) | All Prisma models — ops state only, no timeseries | Production |
| AWS S3 + Glue | Lakehouse `s3://nuravolt-lake` (~17 GB, ~$0.41/mo) | Production |
| AWS Bedrock | Qwen `qwen3-next-80b-a3b` for all LLM sites (Claude blocked until the Anthropic use-case form is submitted in the console) | Production |
| AWS Secrets Manager + KMS | Per-customer connector credentials, EU-only (a former us-west-2 replica was removed) | Production |
| GitHub Actions | dbt nightly build; 15-min connector polling trigger | Production (CI) |
| Laptop | Python analytics (`nuravolt/`), model training, backfills | Dev |
| TimescaleDB (docker) | `measurements` hypertable behind `/api/measurements/ingest` | **Dev-only, being retired** (Phase 4 of the lakehouse plan) |

---

## 3. Data planes — as-is, honestly

Four planes exist today. Only (1) and (4) are load-bearing in production; the plan is to converge on (4).

| # | Plane | Path | Status |
|---|---|---|---|
| 1 | **Demo static JSON** | `nuravolt/` Python generates forecasts → `public/data/{soiling,faults,digitaltwin}/{plant}/*.json` (~7 GB in git) → demo UI fetches directly | **Source of truth for the demo UI today** |
| 2 | Push ingest → Timescale | `POST /api/measurements/ingest` → `insertMeasurements` (`src/lib/db/timeseries.ts`) → local Timescale hypertable | Dev-only; endpoint now requires `x-api-key` (`INGEST_API_KEY`) |
| 3 | Poller → S3 | `PollingService` (`src/lib/services/polling-service.ts`) → parquet on S3 | Live for `huawei_api` via GitHub Actions trigger; lands in `bronze/live/` (legacy `heliosiq-plant-data` bucket retired) |
| 4 | **The lake** | bronze (Iceberg + raw) → dbt → silver/gold on `s3://nuravolt-lake` | Production; nightly dbt green |

**Target flow (what every new integration should follow):**

```
connector poll ──► s3://nuravolt-lake/bronze/live/{connection}/{date}/{epoch_ms}.parquet
                        │  scripts/lake_compact_bronze.py  (one object per connection-day)
                        ▼
                   bronze/compact/live/dt={D}/connection_id={C}/part-0.parquet
                        │  nuravolt/lake/register.py  → Iceberg `bronze.live_readings`
                        ▼
                   dbt build (GitHub Actions, 02:00 UTC)
                        ▼
                   silver (cleaned, typed) ──► gold (daily per-device aggregates)
                        ▼                             ▼
             Python ML/twins read gold        nuravolt/lake/publish.py upserts gold rows into
                                              Postgres `analysis_results` ──► API routes ──► UI
```

The last hop is the one worth being precise about: **there is no DuckDB reader on Vercel**, so API routes do not read S3 gold directly. `nuravolt/lake/publish.py` reads a gold Parquet with DuckDB and upserts it into `analysis_results` (long format, scoped to one plant + domain + `model_version`, delete-then-write so a rerun is an exact replacement). The app then reads `analysis_results` through `src/lib/db/timeseries.ts::queryAnalysisResults` exactly as before.

Known seams still open: the demo UI is still on plane 1 static JSON for the PV soiling/twin pages; plane 2 writes to a store nothing downstream reads. The BESS silver/gold dbt models named in §4 are not in `dbt_project/models/` yet — both ends of that contract exist (bronze compaction and registration, and the consumers `bess_measured.py` plus the telemetry-query route), the dbt middle does not.

---

## 4. Client data journey (ingestion)

```
DataConnection (creds → Secrets Manager, per-customer KMS key)
   └─► discover  → DataStructureAnalysis (format, hierarchy, columns)
        ├─ SCADA/CSV path: FieldMapping via regex heuristics
        │    + LLM polish below 0.7 confidence (field-mapping-llm.ts,
        │    auto-confirmed at ≥0.85) → human review of the rest
        │    + DeviceMatchStep fuzzy SCADA-tag ↔ equipment matching
        └─ Cloud-API path (Huawei, …): fixed vendor schema →
             static mapping table written as confirmed FieldMapping rows,
             devices from the API — no fuzzy matching, no LLM, no review
   └─► DiscoveredPlant rows (name, lat/lon, capacity, inverter count)
   └─► GeneratedPlantConfig — YAML bridge into the Python analytics
   └─► polling (15-min default) → bronze/live/ parquet + PollingJob log
```

**Connector maturity** (see `OPERATOR_INTEGRATION.md` for the roadmap):

| Connector | Status |
|---|---|
| InfluxDB | Real end-to-end (discovery + polling) |
| Huawei FusionSolar (`huawei_api`) | Real client + discovery + polling; live validation pending Northbound credentials. Storage rides the same API: `devTypeId` 39 (battery) and 41 (Smart String ESS) are both polled, but **no battery `dataItemMap` key is in the static mapping** — the item names have never been read off a real ESS account, so they are left as `TODO(verify)` candidates rather than guessed (`src/lib/services/huawei-api-service.ts`) |
| SolarEdge (`solaredge_api`) | Real client + discovery + polling (built 2026-07-03); live validation pending API key; enum migration `20260703120000_solaredge_connection_type` shipped |
| CSV upload | Partial (client-side parse in the wizard) |
| SQL SCADA | Stub (`// TODO` service) |
| Modbus TCP | Live client is a stub, but register maps can be AI-extracted from datasheets/exports into confirmed FieldMappings (`src/lib/ai/register-map-llm.ts`, 2026-07-03) |
| Sungrow iSolarCloud (`sungrow_api`) | Client + discovery + polling built (`src/lib/services/sungrow-api-service.ts`, wired into the discover/test/poll routes). **Never executed against a live endpoint** — OpenAPI access needs a signed confidentiality agreement with Sungrow, so every response parse is defensive and each assumed field name carries an `ASSUMPTION` comment. Measurement points arrive as `p<point_id>` keys and the point catalogue is behind the same agreement, so there is no built-in point map: the operator supplies one |
| SMA, Fronius, GoodWe, SunSpec | UI cards only — not in the DB enum |

### Minimum signals per plant

**PV:** **per-inverter AC power at ~15-min cadence** (hard requirement), plant metadata (lat/lon, tilt/azimuth, kWp), and irradiance + ambient temperature — which since 2026-07 can be **satellite/model-derived via `nuravolt/weather/fallback.py`** when no on-site sensor exists (see §6).

**BESS:** the hard requirement is **charge and discharge energy per settlement period, plus state of charge**, at the asset grain. Everything else is an upgrade, and the code says so rather than defaulting: `nuravolt/bess/imbalance.py` reports `SUB_ASSET_UNAVAILABLE` instead of a zero spread when per-rack telemetry is absent, and `nuravolt/bess/soh_estimator.py` raises rather than returning a number from an unfitted model. The vendor-side metric names are the `bess_*` members of the `DataFieldType` enum (`prisma/schema.prisma`): `bess_soc`, `bess_soh`, `bess_power_charge`, `bess_power_discharge`, `bess_temp_cell/_pack/_ambient/_cell_max/_cell_min`, `bess_voltage_cell/_pack/_cell_max/_cell_min`, `bess_current`, `bess_c_rate`, `bess_cycle_count`, `bess_throughput`, `bess_rte`, `bess_hvac_status`, `bess_contactor_status`.

**Canonical BESS device grain.** Identity lives in `device_ext_id`, never in the metric name (a per-cell metric name would blow the `DataFieldType` enum up combinatorially). Defined once in `src/lib/services/cloud-connector.ts` (`buildBessDeviceId` / `parseBessDeviceId` / `isBessDeviceId`), imported by the lake writers and by the drill-down route:

```
BESS <asset>                          asset      e.g. "BESS athi-1"
BESS <asset>.U-<n>                    unit / container
BESS <asset>.U-<n>.R-<k>              rack
BESS <asset>.U-<n>.R-<k>.M-<m>        module
BESS <asset>.U-<n>.R-<k>.M-<m>.C-<c>  cell
```

`PLANT` stays reserved for plant-grain rollups and is never an asset token. `nuravolt/pipeline/bess_measured.py` mirrors only the narrow asset-grain regex on the Python side, deliberately.

**The BESS lake path**, end to end. Two publishers write into one serving table, and the row's own `metadata.provenance` stamp is what keeps them apart:

```
MEASURED LANE  (customer telemetry, solid arrows)
  poll ──► bronze/live/{connection}/{date}/*.parquet
       ──► scripts/lake_compact_bronze.py ──► bronze/compact/live/dt=/connection_id=/part-0.parquet
       ──► nuravolt/lake/register.py       ──► Iceberg `bronze.live_readings` (+ `bronze.dim_device_map`
                                               from nuravolt/lake/export_dim.py, the vendor-id snapshot)
       ──► dbt `silver_bess_telemetry` ──► `gold_bess_asset_daily` / `gold_bess_rack_daily`
       ──► nuravolt/lake/publish.py --provenance measured ─────────────────┐
                                                                          │
SPECIMEN LANE  (labelled, non-customer, dashed arrows)                    │
  scripted rack specimen                                                  │
       ╌╌► gold-shaped Parquet (same columns, same metric names)          │
       ╌╌► nuravolt/lake/publish.py --provenance benchmark --basis "…" ╌╌╌┤
                                                                          │
                                                                          ▼
                       analysis_results (domain='bess', device_id the canonical grain,
                       model_version 'gold-bess-asset-daily-v1' / 'gold-bess-rack-daily-v1',
                       metadata = {provenance, basis, gold, model_version} on every row)
                                                                          │
       ◄──────────────────────────────────────────────────────────────────┘
       GET /api/bess/plants/[plantId]/telemetry-query   (device_id + metric + range → series)
       nuravolt/pipeline/bess_measured.py materializes BessCycleRecord / BessCapacityTest /
           BessWarrantyStatus from exactly those rows, so the relational tables are a summary
           of the lake and not a parallel source of truth
```

The lanes share a shape on purpose: a specimen that does not exercise the real publish path proves nothing about the real publish path. They can never share a caption, because `publish.py` refuses any provenance outside `measured | modelled | declared | benchmark` and stamps the chosen one on every row, and the drill-down route reads the caption off the row rather than off the model version.

Honest status of that path. The dbt layer is built and running: `silver_bess_telemetry` plus both golds exist under `dbt_project/models/`, the `bess_metric_alias` seed ships its 25 identity rows, and `.github/workflows/analytics-nightly.yml` publishes each gold **behind a freshness gate** (a gold whose newest day is older than yesterday is reported stale and the publish step is skipped, so a failed dbt run cannot let the cron republish stale numbers as fresh). What is actually missing sits upstream of all of it: **there are no bronze rows at rack grain, because no connector emits sub-asset device ids.** `src/lib/services/huawei-api-service.ts` hardcodes `metadata.bess_grain = 'asset'` (getDevList returns one row per storage device, and whether FusionSolar ever exposes rack-grain rows is unverified), and Sungrow parses the grain out of the canonical id, so rack grain there needs an operator-supplied override. **That is a connector gap, not a dbt gap.** Until a feed carries rack ids, `bess_measured.py` finds no gold rows and says so (it prints the metric names that ARE published rather than falling back to synthesis), and the telemetry-query route returns an honest empty series. The specimen lane exists to exercise the rack-grain half of the chain before that feed arrives; its generator is landing in the current arc.

**Below rack is a decision, not a gap.** Module and cell ids parse and resolve, and `silver_bess_telemetry` attributes those rows up to their rack, but nothing downstream preserves their identity and nothing should: vendor clouds do not carry per-cell series, and ΔV from the reported extremes gives the imbalance signal exactly. Full reasoning, evidence and confidence caveats: **`docs/BESS_GRAIN_POLICY.md`**, pinned by `tests/bess/test_grain_boundary.py`.

**Modelled versus measured.** A plant's battery can be written by two writers, and the boundary is one JSON block on `BessAsset.metadata`: `{"telemetry": {"mode": "modelled|measured|mixed", "first_measured_date": ..., "source": ...}}`. `TelemetryRegime` (`nuravolt/pipeline/bess_measured.py`) makes `owns_modelled(day)` the exact complement of `owns_measured(day)`, so modelled dispatch can never overwrite real telemetry and no day falls through. Every BESS analytics row carries a `provenance` column for the same reason.

---

## 5. The lakehouse (medallion layers, as built)

Bucket `s3://nuravolt-lake` (eu-west-1, versioned, SSE-S3, lifecycle rules). Catalog: **AWS Glue** (`nuravolt/lake/catalog.py::get_catalog()`; local dev uses a SQLite/filesystem catalog under `./lake`).

| Layer | Contents | Format |
|---|---|---|
| `bronze/` (Iceberg, curated) | 8 digital-twin tables (AC power, temperatures, string voltages, string currents × ribera, alpha — ~500M rows), `pr_daily_*` | Iceberg via Glue |
| `bronze/` (Iceberg, spec-driven) | `bronze.live_readings` (compacted poller output, one partition per day) and `bronze.dim_device_map` (vendor-id resolution snapshot) — described and appended day-by-day by `nuravolt/lake/register.py` | Iceberg via Glue |
| `bronze/` (raw) | `scada/` (7 plants), `public/` (PVDAQ, Lazzaretti, GPVS, Sandia, NASA PCoE, Severson, NREL soiling map…), `weather/` (ERA5/AOD), `live/{connection}/` (raw connector polls), `compact/live/dt=/connection_id=/` (compacted), `dim/device_map/dt=/` | Parquet/CSV objects |
| `silver/` | `silver_twin_power` (cleaned, typed); `silver_bess_telemetry` (battery readings resolved to plant + asset + canonical device, metric and unit normalized, sub-rack rows attributed to `rack_device_id`) | External Parquet (dbt) |
| `gold/` | `gold_inverter_daily_kwh` (one row per inverter-day); `gold_bess_asset_daily` and `gold_bess_rack_daily` (one row per asset-day and per rack-day) | External Parquet (dbt) |

Two properties of the bronze live path are load-bearing rather than incidental. **Compaction** (`scripts/lake_compact_bronze.py`): the poller writes one object per poll run, which is 96 objects per connection-day at 15-min polling and ruins both Iceberg manifest planning and S3 request cost; compaction rewrites each connection-day into a single part, keeps the raw objects for `--retain-days` (default 7) so a bad run can be replayed, and refuses to compact a connection-day whose schema has drifted from the writer's. **Registration idempotency** (`nuravolt/lake/register.py`) is by partition, not by file: a `dt` already present is skipped unless `--replace-day` is passed, because appending blind would silently double a day's rows and a doubled megawatt-hour is a wrong number, not a slow query.

Only the `prod` dbt target may write into the S3 lake; every other target lands under `LAKE_DEV_ROOT` (`dbt_project/macros/lake_location.sql`), so iterating on a model on a laptop cannot publish to production gold.

The local `backenddata/{scada,twins,datasets,weather}` copies were verified against S3 and deleted (2026-07-01); `backenddata/` retains only artifacts with no S3 copy (models, outputs, logs). dbt (`dbt_project/`, dbt-duckdb) reads bronze through the attached Glue catalog and materializes silver/gold as external Parquet — DuckDB cannot write Glue Iceberg. Nightly build: `.github/workflows/dbt-daily.yml`.

---

## 6. Pre-existing data, pre-training, and sensor fallbacks

**Public data → foundation models (cold start).** `bronze/public/` datasets pre-train plant-agnostic models: fault classifiers (`nuravolt/fault/pretraining.py`, routed per client feature shape by `nuravolt/foundation/pv_router.py`) and per-climate-zone soiling foundation models (`nuravolt/soiling/sr_foundation_model.py`). Honest status: **2 of ~11 climate zones have trained soiling foundation models** (Mediterranean, Temperate-Continental); other zones cold-start on literature climate priors.

**Cold-start ladder for a brand-new plant:** day-1 climate-prior forecast from lat/lon only (`client_baseline.py`, `pvlib_forecast.py`) → 90-day bootstrap (`sr_bootstrap_pipeline.py`: foundation-only → rain-calibrated → residual model) → full physics-ML hybrid.

**Soiling-ratio estimation fallback chain** (`nuravolt/soiling/estimation/`, auto-selected by confidence): DustIQ sensor (95) → same-plant ML (85) → transfer from similar plant (75) → foundation model (65) → physics disaggregation from SCADA power alone (55).

**Market prices (the BESS equivalent of the weather fallback).** `nuravolt/pipeline/market_prices.py` is a zone router only: `zone_for_country` maps a plant's country onto a bidding zone, and `day_ahead_periods(day, zone)` returns `{date, zone, currency, resolution_minutes, price_source, prices}`. The ladders live per market:

- **Iberia** (`nuravolt/markets/iberia.py`, EUR, 24 hourly periods): the committed OMIE CSV `public/data/prices/omie_es_2025-2026.csv` (~12 months of real ES/PT clearing prices) first, then live providers via `nuravolt/markets/entsoe.py` (ENTSO-E A44 with `ENTSOE_API_TOKEN`, else the token-free energy-charts.info fallback, which serves ES/PT at 15-min MTU, so 96 periods), then a clearly labelled synthetic duck curve for days beyond the day-ahead horizon (`allow_synthetic=False` turns it off).
- **GB** (`nuravolt/markets/gb.py`, GBP, 48 half-hourly periods): Elexon Insights for the market index price, the DISEBSP imbalance prices and per-BMU balancing-mechanism acceptance stacks, plus the NESO CKAN portal for response/reserve auction clearing prices. Neither needs a key; GB left ENTSO-E after Brexit. **There is no synthetic GB rung at all** — no real GB price history is committed to this repo, so a synthesized curve would be a fabricated measurement powering a revenue number. The fetch either succeeds or raises `PriceFetchError` and the surface shows nothing.

Two honesty notes carried in the code and owed to any caption: the Elexon figure is the **market index price** (MID), computed by appointed Market Index Data Providers from their own traded volume near delivery, not a day-ahead auction clearing price like OMIE or EPEX (provenance reads e.g. `elexon_mid_apx`); and GB half-hourly prices are never averaged down to hourly, because intra-hour spread is exactly what a GB battery trades. Verified live on 2026-07-28: 48 half-hourly rows per day. Two things remain unverified and are labelled as such in the source: the **NESO clearing-price sign convention** (whether a negative price means the provider pays or is paid) and the **ENTSO-E A85 Iberian imbalance parser**, which was written from the documented `Balancing_MarketDocument` shape and has never seen a live payload because there is no token in this environment.

**Weather/irradiance fallback** (`nuravolt/weather/fallback.py`): on-site sensor → Open-Meteo archive (satellite/reanalysis GHI/DNI/DHI + temp + wind) with GHI→POA transposition → clearsky × cloud-cover last resort. The digital twin and per-inverter SR no longer hard-require an on-site pyranometer; outputs carry `data_provenance` so the UI can show when irradiance is modeled rather than measured. Open-data feeds already in production for soiling features: Open-Meteo rain/dust, CAMS AOD, NASA POWER, NREL soiling map.

---

## 7. How data reaches the frontend

| Surface | Reads from | Notes |
|---|---|---|
| Demo plant/inverter pages | `public/data/*/{plant}/*.json` | Static, regenerated by Python scripts; source of truth today |
| Ops dashboard (tickets, connections, orgs) | Supabase via Prisma | Live |
| LLM features (chat, insights, digest, diagnosis) | Bedrock + Postgres caches | Live |
| Live connector freshness | `LatestDeviceSnapshot` (Supabase) + `PollingJob` | New with the Huawei connector |
| BESS revenue | `GET /api/bess/plants/[plantId]/revenue` → `analysis_results` (domain='bess') | Three lanes that are never summed: `{ledger: {measured, declared, benchmark}, provenance, kpis, currency, resolution_minutes}`. Lane definitions and styling: `src/lib/config/bessServices.ts` |
| BESS per-device drill-down | `GET /api/bess/plants/[plantId]/telemetry-query` → `analysis_results` (domain='bess') | device_id + metric + range in, `{series, modelVersion, grain, provenance, unit}` out. Returns an honest empty series (never a 500, never fabricated points) until the lake publishes that grain |
| Lake-computed analytics | Postgres `analysis_results`, written by `nuravolt/lake/publish.py` | The seam is generic (one publish per plant + domain + `model_version`). Read today by the per-device twin drill-down and by both BESS routes above. Not a DuckDB-on-Vercel read: see §3 |
| PV soiling/twin charts (target) | gold → `analysis_results` → API routes | **Still on plane 1 static JSON** for the demo pages |

---

## 8. Security & residency notes

- Better Auth protects `/dashboard`, `/admin`, `/chat`, `/create-organization`, `/onboarding`, `/api/mcp-keys` (middleware cookie check; real session validation via `auth.api.getSession` in handlers). Config: `src/lib/auth.ts`; legacy `*_clerk_id` columns store Better Auth ids.
- Connector credentials never touch the DB: `secret_arn` → Secrets Manager, per-customer KMS keys, eu-west-1 only.
- `POST /api/measurements/ingest` requires `x-api-key` = `INGEST_API_KEY` (fails closed if unset).
- Open items: rotate the app IAM key that leaked into `.env`; GitHub runners are US-based (non-PII workloads only); Anthropic use-case form unsubmitted (Bedrock Claude unavailable → Qwen).

## 9. Open gaps (tracked)

1. Retire plane 1 static JSON for the PV dashboard pages. The gold → serving seam itself is **closed** (`nuravolt/lake/publish.py` → `analysis_results`); what remains is publishing the soiling and twin golds and repointing those pages.
2. ~~Bronze `live/` compaction + Iceberg registration~~ — **CLOSED**: `scripts/lake_compact_bronze.py` compacts each connection-day, `nuravolt/lake/register.py` appends it to Iceberg `bronze.live_readings` (and `bronze.dim_device_map` from `nuravolt/lake/export_dim.py`). Python `LakeWriter` dual-write (P2.4) is still open.
3. **No bronze rows at rack grain.** The dbt layer is built and nightly: `silver_bess_telemetry`, `gold_bess_asset_daily` and `gold_bess_rack_daily` all exist under `dbt_project/models/`, the `bess_metric_alias` seed carries its 25 identity rows, and `analytics-nightly.yml` publishes each gold behind a freshness gate. The gap is at the connector edge, one layer earlier: `huawei-api-service.ts` hardcodes `bess_grain = 'asset'` and Sungrow needs an operator-supplied override, so nothing has ever written a rack-grain `device_ext_id` into bronze and every measured-BESS surface is honestly empty. **A connector gap, not a dbt gap.** Below rack, module and cell grain are addressable and **deliberately** unbuilt, with vendor evidence and confidence caveats written down in `docs/BESS_GRAIN_POLICY.md` and pinned by `tests/bess/test_grain_boundary.py`.
4. Phase 4: retire the Timescale hypertable + slim Supabase after dual-write soak.
5. Remaining vendor connectors per `OPERATOR_INTEGRATION.md` roadmap (Deye/Solarman next; SolarEdge and Sungrow are built but unvalidated against a live endpoint).
6. **Unverified BESS externals**, each labelled in its own source: Huawei FusionSolar battery `dataItemMap` keys for `devTypeId` 39/41 (candidates listed, none shipped); Sungrow iSolarCloud (no live request ever made, no point catalogue); the ENTSO-E A85 Iberian imbalance parser (never seen a live payload); the NESO clearing-price sign convention.
7. No BMS telemetry anywhere yet. The BESS twin is provisional: real `nuravolt.bess` algorithms over real published prices, no measured battery data. `nuravolt/bess/soh_estimator.py` has never been trained (`predict` raises); every served SoH comes from the chemistry `EmpiricalDegradationModel`. What has changed is the readiness, not the data: the imbalance chain is now wired end to end (silver rack attribution → `nuravolt/bess/rack_samples.py` pivot → `analyze_imbalance` → `gold_bess_rack_daily` → publish → drill-down), so a real BMS feed works on arrival rather than needing a build.
8. Train the missing ~9 climate-zone soiling foundation models (needs donor data).
