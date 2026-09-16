# Operator Integration Plan — residential & industrial onboarding

**Last reviewed: 2026-07-29** (storage lane added: §10) · Companion to `ARCHITECTURE.md` (system hub, §4 ingestion) — this doc is the strategy + roadmap for connecting any operator with the least possible human intervention.

**The goal in one sentence:** an operator signs up, enters one set of vendor-cloud credentials, and their whole fleet has forecasts within the hour — no field mapping, no device matching, no data engineer.

**Scope note:** §1 to §9 are the **solar** lane and were written for it. Storage (BESS and co-located hybrid) has a different device grain, a different minimum data contract, and a different vendor landscape; it lives in **§10** at the bottom. Where the two share plumbing (the `CloudVendorConnector` interface, the bronze landing zone, the polling scheduler) §10 says so rather than restating it.

---

## 1. Who we integrate (segment matrix)

| | Residential fleets | Commercial & industrial (C&I) | Utility-scale |
|---|---|---|---|
| Typical site | 3–15 kWp, 1–2 inverters (or microinverters) | 100 kWp–5 MWp, 5–50 inverters | 5 MWp+, 50–150+ inverters |
| Who is the customer | The **operator/installer managing thousands of homes** — never the homeowner | Plant owner, O&M contractor, ESCO | IPP, O&M contractor |
| How data is reachable | **Vendor cloud API only** (inverter/dongle uploads to Huawei/SolarEdge/Solarman/… cloud) | Vendor cloud API, sometimes SCADA export or CSV | SCADA (InfluxDB, SQL, Modbus), historian, occasionally vendor cloud |
| On-site sensors | None. No pyranometer, no ambient temp, no DustIQ | Sometimes POA irradiance + ambient/module temp; rarely DustIQ | Full: POA/GHI, temps, met station, sometimes DustIQ |
| Onboarding tolerance | Zero-touch mandatory — nobody maps fields for 5,000 rooftops | Low-touch (one review pass acceptable) | Project onboarding acceptable |
| Connector today | Huawei FusionSolar (first real cloud connector); rest per roadmap §5 | Same cloud path + CSV; SQL/Modbus are stubs | InfluxDB (real, end-to-end) |

## 2. What data we assume per segment

**Residential — the minimum viable contract** (everything obtainable from the vendor API alone):

| Signal | Source | Notes |
|---|---|---|
| Per-inverter AC power, 5–15 min | Vendor API | Hard requirement. One inverter/home → "per-inverter" = "per-site" |
| Daily/cumulative energy | Vendor API | Sanity + billing-grade rollups |
| Site lat/lon, kWp, commissioning date | Vendor API plant metadata | Drives weather fetch + climate-zone assignment |
| Irradiance, ambient temp, wind | **Not assumed.** Satellite/model via `nuravolt/weather/fallback.py` (Open-Meteo → clearsky) | The fallback chain is what makes residential viable at all |
| Tilt/azimuth | **Not assumed.** Default heuristic (tilt ≈ |lat| capped 10–35°, azimuth equator-facing); refined later by clear-day power-curve fitting | Only affects GHI→POA transposition accuracy |
| Module/cell temp | Estimated (NOCT model from fallback ambient + irradiance) | Existing estimators in `digitaltwin/` |

**C&I:** the residential contract **plus** whatever real sensors exist (POA irradiance, ambient/module temp — auto-detected; on-site sensor always outranks the fallback). Huawei plants with an EMI weather station (devTypeId 10) get real irradiance through the same API.

**Utility:** full SCADA path — the existing heuristic + LLM field mapping and device matching remain, because SCADA schemas are freeform.

**What each data tier unlocks:**

| Available data | Analytics unlocked |
|---|---|
| Power + metadata only (residential floor) | Day-1 climate-prior soiling forecast; twin with satellite weather; fleet-ranked underperformance; peer comparison across same-region sites |
| + real irradiance/temp (C&I) | Full-accuracy digital twin, tighter SR, thermal analytics |
| + DustIQ (utility) | Ground-truth SR (estimation Layer 1), foundation-model donor plant |

## 3. Why zero-touch is achievable (and where the touch remains)

The two human-touch steps in today's wizard exist **only because SCADA schemas are freeform**:

1. Field mapping review (regex + LLM polish, human confirms <0.85 confidence) — a vendor cloud API has a **fixed, documented schema**, so a static per-vendor mapping table ships in code, written as confirmed `FieldMapping` rows at discovery. No LLM, no review.
2. Device matching (fuzzy SCADA-tag ↔ equipment) — the API returns structured device objects with IDs, types, serials. Nothing to match.

**Remaining human steps: exactly one** — the operator enters vendor credentials once per account (one FusionSolar/SolarEdge/Solarman account exposes the entire fleet). Everything downstream is automatic.

## 4. The zero-touch pipeline

```
1. Connect      operator picks vendor, enters credentials
                → DataConnection + Secrets Manager (per-customer KMS, eu-west-1)
2. Discover     stations → DiscoveredPlant rows; devices → inventory;
                static mapping table → confirmed FieldMapping rows        [~1 min]
3. Configure    GeneratedPlantConfig per site from API metadata + defaults
                (lat/lon, kWp, tilt/azimuth heuristic, climate zone)      [automatic]
4. Weather      backfill rain/dust/AOD + irradiance/temp/wind history
                (Open-Meteo, CAMS) via nuravolt/weather fallback           [~min/site, cached]
5. Forecast     day-1 climate-prior soiling forecast (lat/lon only)
                → 90-day bootstrap → full physics-ML hybrid               [immediately]
6. Poll         GitHub Actions */15 → /api/cron/poll-connections
                → vendor API → parquet in s3://nuravolt-lake/bronze/live/
                {connection_id}/{date}/ + LatestDeviceSnapshot upsert
7. Nightly      compaction/registration of live/ into Iceberg bronze,
                dbt build → silver/gold                                    [02:00 UTC]
```

KPIs: **time-to-first-forecast < 1 h** · **human steps = 1** · **time-to-full-hybrid = 90 days** (bootstrap, automatic).

Data contract for every cloud connector (long format, one row per reading):
`ts, plant_ext_id, device_ext_id, device_type, metric (DataFieldType), value, unit` — implemented by the `CloudVendorConnector` interface (`src/lib/services/cloud-connector.ts`); a new vendor = one class + one static mapping table.

## 5. Vendor API roadmap (ranked)

| # | Vendor | Why this rank | Auth | Data granularity | Gotchas |
|---|---|---|---|---|---|
| 1 | **Huawei FusionSolar** (built — pending live credentials) | Enum + service existed; dominant in Spain/GCC/Africa C&I and strong residential | Northbound account: userName + systemCode → XSRF token (~30 min) | 5-min per device (`getDevFiveMinutes`), realtime KPIs | Harsh rate limits (login ≤1/10 min, failCode 407); one call per device-type; EMI device = free irradiance on C&I plants |
| 2 | **SolarEdge** | Best-documented public API; huge EU residential base; fastest to validate | Simple API key (account or site level) | 15-min inverter telemetry, site energy | 300 req/day/site + concurrency 3 → batch carefully at fleet scale; optimizer-level data available |
| 3 | **Deye / Solarman Business API** | East-Africa residential + small C&I (Amria territory); one API covers many rebranded logger vendors | appId + appSecret + business-account token | 5-min logger data, station + device lists | Approval process for Business API; device naming varies by rebrand |
| 4 | **Sungrow iSolarCloud OpenAPI** | Enum exists; strong C&I/utility, growing residential | Developer-portal application → appkey + access key + account token | 5-min device KPIs | Portal approval is slow; region-specific hosts |
| — | Later tier: Enphase (OAuth2, microinverter-level), Fronius Solar.web, SMA Sunny Portal (ennexOS), GoodWe SEMS, Growatt | Add on demand per signed operator | | | Everything lands on the same `CloudVendorConnector` interface |
| — | Escape hatch: CSV upload + authenticated push API (`/api/measurements/ingest` with `x-api-key`) | For vendors with no API or operators with exports only | | | Falls back to the SCADA-style mapping wizard |

## 6. Polling & landing infrastructure (decided)

- **Scheduler:** GitHub Actions `*/15` (`.github/workflows/poll-connections.yml`) → `POST /api/cron/poll-connections` with bearer secret. Rationale: Vercel Hobby crons are daily-only and serverless can't hold a `setInterval` loop; Actions is already the batch worker (dbt).
- **Landing zone:** `s3://nuravolt-lake/bronze/live/{connection_id}/{YYYY-MM-DD}/*.parquet` (long format above). The legacy dormant path to `heliosiq-plant-data` is retired.
- **Ops visibility:** `PollingJob` log row per run + `LatestDeviceSnapshot` upsert (per-device freshness for the dashboard) + `DataConnection.last_poll_*`.
- **Nightly:** compaction + Iceberg registration of `live/` (lakehouse tasks P2.4/P2.5), then dbt silver/gold.

## 7. Phases

| Phase | Scope | Status / effort |
|---|---|---|
| R0 | Connector framework: `CloudVendorConnector`, poll route, GH workflow, bronze/live landing, ingest auth | **Built 2026-07-02** |
| R1 | Huawei FusionSolar end-to-end (discovery, static mappings, backfill, poll) | **Built; live validation needs credentials** (§8) |
| R2 | Weather fallback default-on for cloud plants (twin + per-inverter SR without sensors) | **Built 2026-07-02** (`nuravolt/weather/fallback.py`) |
| R3 | Auto-`GeneratedPlantConfig` for cloud plants (defaults + heuristics, no wizard) | ~2-3 days |
| R4 | SolarEdge connector | **Built 2026-07-03** (`solaredge-api-service.ts`, fixture-tested; live validation needs an API key; `solaredge_api` enum migration written, not applied) |
| R5 | Solarman/Deye connector | ~3 days (+ Business-API approval lead time); trigger: Amria pilot signature |
| R6 | Sungrow connector | ~3 days (+ portal approval lead time) |
| R7 | Self-serve onboarding UX: vendor picker → credentials → live fleet view; kill the 8-step wizard for cloud vendors | ~1 week |
| R8 | Tilt/azimuth refinement from clear-day curve fitting; peer-fleet comparison analytics for residential | research-y, after first fleet lands |

## 8. What the user must obtain (credential checklist)

- **Huawei:** FusionSolar installer/operator account → Admin creates a **Northbound API** account (userName + systemCode) scoped to the plants; note the region host (`eu5.fusionsolar.huawei.com` for EU).
- **SolarEdge:** monitoring-portal account → Admin → API access → generate account-level API key.
- **Solarman (Deye):** apply for Business API appId/appSecret at solarmanpv.com developer channel; needs the operator's business account.
- **Sungrow:** register at the iSolarCloud developer portal, request OpenAPI access (lead time: days–weeks).
- GitHub secrets for polling: `CRON_SECRET` (also set in Vercel env), `APP_BASE_URL` variable.

## 9. Risks & mitigations

- **Vendor rate limits at fleet scale** (SolarEdge 300 req/day/site; Huawei per-interface caps) → batch by device type, poll at vendor-native granularity, backfill day-by-day, spread fleets across the 15-min window.
- **API ToS/regional hosts** vary — keep base URL per `DataConnection.config`.
- **Satellite-weather accuracy** (residential twin quality) → provenance flags in outputs; peer-fleet ranking is robust to shared weather bias because all neighbors use the same source.
- **Vendor lock-in of history** — backfill as far as each API allows on day 1 (Huawei 5-min history, SolarEdge to commissioning) so the bootstrap has maximal data.

---

## 10. The storage lane (BESS and hybrid)

Everything above assumes a PV plant whose smallest interesting unit is an inverter. A battery is not shaped like that, so this section states what is different, what is built, and what has never touched a real endpoint.

### 10.1 What is different from solar

| | Solar | Storage |
|---|---|---|
| Smallest interesting unit | Inverter | Rack, module, sometimes cell. Pack averages destroy the signal that matters (`nuravolt/bess/imbalance.py`) |
| Device id | `INV <group>.<n>` | `BESS <asset>[.U-n][.R-k][.M-m][.C-c]` — one definition in `src/lib/services/cloud-connector.ts` (`buildBessDeviceId` / `parseBessDeviceId` / `isBessDeviceId`), imported everywhere |
| Hard minimum | Per-inverter AC power at ~15 min | Charge and discharge energy per settlement period, plus state of charge, at asset grain |
| Metric vocabulary | Existing `DataFieldType` members | The `bess_*` members of `DataFieldType` (SoC, SoH, charge/discharge power, cell/pack/ambient temperature and their min/max, cell/pack voltage and their min/max, current, C rate, cycle count, throughput, RTE, HVAC and contactor status) |
| The missing exogenous input | Irradiance and ambient temperature | **Market prices.** A battery's analytics are meaningless without the price curve it dispatched against. Ladder and honesty caveats: `ARCHITECTURE.md` §6 |
| Settlement period | Irrelevant | Load-bearing. GB settles 48 half-hourly periods in GBP; Iberia clears 24 hourly periods in EUR. Never assume a period is an hour |

Onboarding collects the battery nameplate on the plant step (`src/components/data-hub/PlantConfigStep.tsx`): energy capacity in MWh (required — it sets the billed size and every warranty, cycling and dispatch model works in energy, not power), chemistry, rack and module counts, max continuous C rate, manufacturer, model, install date, and for GB the BMU and CMU ids. `POST /api/plants` writes `Plant.energy_capacity_mwh` and the `BessAsset` row in one transaction (`src/lib/plants/create.ts`). Asset types `BESS` and `HYBRID` both take this branch.

### 10.2 Connector status, honestly

| Vendor | Path | Status |
|---|---|---|
| **Huawei ESS** | The existing FusionSolar connector — storage rides the same Northbound API, no second integration. `devTypeId` 39 (battery) and 41 (Smart String ESS) are both in `HUAWEI_STORAGE_DEV_TYPE_IDS` and both polled; covering only 39 would silently miss every commercial Smart String ESS, which is the fleet this program targets | Client + discovery + polling built. **No battery `dataItemMap` key is shipped.** The item names for 39/41 have never been read off a real ESS account and no public source prints them, so the static mapping's battery scope is deliberately empty and the candidate keys sit behind a `TODO(verify)` in `src/lib/services/huawei-api-service.ts`. First real ESS account turns that into a discovery exercise |
| **Sungrow iSolarCloud** | Own connector, `src/lib/services/sungrow-api-service.ts`, wired into the discover / test / poll routes under the `sungrow_api` enum value | Built, **never executed against a live endpoint**. OpenAPI access is granted only after a signed confidentiality agreement with Sungrow. Every response parse is defensive and each assumed field name carries an `ASSUMPTION` comment. Measurements arrive as `p<point_id>` keys and the point catalogue is behind the same agreement and is account and model specific, so there is **no built-in point map** — that would be fabricated. Operators supply one (connection config `point_map`, or the field mapper fed from the `point_dict` the API returns), and a mapping whose target is not a `DataFieldType` member is dropped. Rate limits are unpublished, so the connector assumes they are tight: sequential calls, polite minimum interval, backoff with jitter, hard per-run request budget. Treat a first live run as schema discovery, not a smoke test |
| **Tesla Megapack** | `nuravolt/bess/manufacturer_adapters/tesla_megapack.py` — **a bulk-file shape, not a REST poll.** Only `parse_csv_export` is implemented; `fetch_realtime` returns `None` and `fetch_historical` returns `[]`, and both say in-line that a production version would call the API. There is no `tesla_*` value in the `ConnectionType` enum and nothing schedules it | Treat Tesla as "operator sends us exports", the same escape hatch as §5's CSV row, until a Powerhub account exists to build against |

Later tier, **unbuilt**: Fluence (Mosaic), BYD, Huawei LUNA, CATL. Note that `nuravolt/bess/manufacturer_adapters/__init__.py` lists Fluence under "Supported manufacturers" — there is no `fluence.py`, so read that line as intent. Add on demand per signed operator; all land on the same `CloudVendorConnector` interface and the same canonical device grain.

### 10.3 What the operator must obtain

- **Huawei ESS:** the same FusionSolar Northbound account as §8, with the storage plants in scope. Ask explicitly whether the site is a devTypeId 39 residential battery or a 41 Smart String ESS.
- **Sungrow:** iSolarCloud developer-portal application (appkey + access key + account token), **plus the signed confidentiality agreement** that unlocks the OpenAPI and the measurement-point catalogue. Portal approval is slow; budget weeks, not days.
- **Tesla:** a Powerhub CSV export covering the period of interest. Column names are mapped in `TESLA_FIELD_MAPPINGS`.
- **GB assets specifically:** the BMU id (and CMU id where a capacity-market agreement exists). A declared BMU id is what lets the revenue ledger reconstruct settled Balancing Mechanism revenue from public Elexon data, without the operator handing over a settlement statement.

### 10.4 Where the data goes

The BESS lake path (bronze/live → compaction → Iceberg `bronze.live_readings` → dbt silver/gold → `nuravolt/lake/publish.py` → `analysis_results` → the telemetry-query route) is documented once, in `ARCHITECTURE.md` §4. Two things a reader of this doc should know before promising anything to an operator:

1. **The BESS silver/gold dbt models do not exist yet.** Both ends of the contract are built; the middle is not. Until they land, measured-BESS surfaces are honestly empty rather than wrong.
2. **No BMS telemetry has ever reached this system.** Every battery number served today comes from the real `nuravolt.bess` algorithms run over real published prices against a declared nameplate — a provisional twin, tagged as such. `nuravolt/pipeline/bess_measured.py` and its `TelemetryRegime` exist precisely so that the day real telemetry arrives, the modelled rows step aside for it instead of overwriting it.
