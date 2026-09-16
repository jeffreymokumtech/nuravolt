# Data Architecture Guide — Iceberg + DuckDB lakehouse on AWS S3

> **Status:** Approved direction (decision record), 2026-06. **Phases 0–3 implemented & verified on real AWS.** Dual-write (P2.4) + bronze compaction (P2.5) deferred until live SCADA polling is deployed; Phase 4 (drop the Timescale hypertable) stays on the 2-3 month dual-write soak. See §15 "Phase 2/3 — as built" below.
> **Companion docs:** `ARCHITECTURE.md` (**start here** — the reconciled system hub), `PROJECT_MAP.md` (data flows + model map), `AI_AND_LLM_USAGE.md` (LLM call sites).
> **Interpreter:** the `nuravolt` conda env (`/opt/homebrew/Caskroom/miniforge/base/envs/nuravolt/bin/python`, Python 3.10) — already has duckdb 1.5.1 + pyarrow 22; `pyiceberg`, `pyiceberg[glue]`, and `dbt-duckdb` were added. Bare `python3` is empty homebrew; don't use it.
>
> ### §15. Phase 2/3 — as built (live AWS, eu-west-1)
> - **Catalog: AWS Glue** (not SQLite-on-S3). It's the shared, AWS-native registry the laptop/CI/app all resolve. `nuravolt/lake/catalog.py::get_catalog()` returns a `GlueCatalog` for `LAKE_ENV!=dev`; `LAKE_CATALOG=sql` falls back to SQLite-on-S3.
> - **Region: `eu-west-1` everywhere** (whole stack moved to EU; see the AWS-region section near the top). Bucket `s3://nuravolt-lake` (versioned, SSE-S3, lifecycle, public-access blocked).
> - **`register_parquet` is warehouse-aware:** local filesystem + µs timestamps → zero-copy `add_files`; S3 warehouse (or ns timestamps) → stream-append (uploads to S3, ns→µs cast). Verified: `bronze.twin_power_ribera` (12.35M rows) + `bronze.pr_daily_ribera` written to Glue/S3 with **count + sum(value) matching source exactly**.
> - **DuckDB reads Glue natively:** `ATTACH '<account>' AS glue_cat (TYPE iceberg, ENDPOINT_TYPE 'glue')` → `SELECT … FROM glue_cat.bronze.<table>`. DuckDB **cannot write** Glue Iceberg (REST endpoint rejects CREATE TABLE), so dbt silver/gold materialize as **external Parquet on S3**.
> - **dbt** (`dbt_project/`, `dbt-duckdb`): reads bronze via the attached Glue catalog, tests sources, writes `s3://nuravolt-lake/{silver,gold}/`. `dbt build` green (`PASS=6`): `silver_twin_power` (12.35M) + `gold_inverter_daily_kwh` (178,562 rows = 120 inverters × ~1518 days). Scheduled nightly via `.github/workflows/dbt-daily.yml` on a GitHub runner (CI uses scoped IAM user `nuravolt-lake-rw`, not root).
> - **IAM:** `nuravolt-lake-rw` (scoped S3 + Glue); its key is in GitHub Actions secrets. App/Bedrock still use the existing app IAM key (rotate the one that leaked into `.env`).
> - **Promoting gold to an Iceberg table** (so `lake.read_table('gold.*')` works): a pyiceberg post-step on the dbt gold Parquet — not yet wired; gold is read via `read_parquet('s3://…/gold/…')` for now.

## Context

Decision: keep Supabase Free for ops state, build an Apache Iceberg lakehouse on AWS S3 for everything analytical. Compute via embedded DuckDB; SQL transformations via dbt scheduled in GitHub Actions; Python scripts unchanged for ML/physics/LLM work.

Storage choice: **AWS S3**, not Cloudflare R2 — we're already on AWS for Bedrock (LLM) and the IAM/SSO/billing is in place. R2 stays an option for later if egress to non-AWS consumers becomes meaningful, but the lake is portable (Iceberg + Parquet is the same data either way) so the choice is non-destructive.

Intended outcome: a phased, reversible migration where each phase delivers value standalone, with one S3 bucket as the entire new operating footprint.

What prompted this: local-dev TimescaleDB throws OOM during analytics aggregation jobs, and we want analytics workloads on an open-source Delta-Lake-style stack (Databricks is too expensive). Investigation showed the OOM is a code bug in one script (not a Timescale scale limit), and that production runs on a single Supabase Free Postgres with a 500 MB cap — so "where does production timeseries live" is the real open question this architecture answers.

---

## 0. What's there now (the starting point)

**Production runtime**

| Component | State |
|---|---|
| Next.js app | Deployed on Vercel. Two cron jobs in `vercel.json`: `/api/cron/send-reports` (daily 07:00 UTC), `/api/cron/narration-metrics` (daily 02:30 UTC). Default function timeout 300 s. |
| Database | **One** Postgres — Supabase **Free** tier via `DATABASE_URL` (`aws-0-eu-central-1.pooler.supabase.com`). 500 MB cap, pauses after 1 week idle. |
| Auth | Clerk; custom `server.js` for JWT header overflow |
| LLM | AWS Bedrock — Qwen `qwen3-next-80b-a3b` since 2026-06 (was Haiku 4.5) with Postgres cache (`AlertInterpretation`) |
| AWS account | Already exists (Bedrock). Reused for S3. |
| Batch worker host | **None.** No Celery / RQ / Airflow / Prefect / cron container. dbt + Iceberg compaction run on GitHub Actions. |

**Local-dev runtime**

| Component | State |
|---|---|
| Timescale | `docker-compose.yml` runs `timescale/timescaledb:latest-pg16` on port 5432. Dev-only, not deployed. **Source of the OOM.** |
| Python | `nuravolt/` local-import package. Polars + LightGBM + PVLib + Plotly. |

**Data assets already in repo**

| Path | Footprint | Status |
|---|---|---|
| `backenddata/scada/` | ~3.9 GB parquet × 7 plants (~9.5M rows) | Demo input; not in any catalog |
| `backenddata/twins/` | ~2.8 GB digital-twin outputs (hourly per-inverter) | Pre-computed; demo input |
| `backenddata/datasets/` | ~8.9 GB public refs (PVDAQ, Lazzaretti, Severson, LFP) | Static; ML transfer-learning inputs |
| `backenddata/weather/` | ~532 KB ERA5/AOD parquets | Per-plant; soiling feature engineering |
| `public/data/{soiling,faults,digitaltwin}/{plant}/` | ~7 GB JSON | **Current source of truth for the demo UI** — 365-day per-plant predictions checked into git |

**Hypertables in Prisma migrations (exist only on local-dev Timescale)**

| Table | Retention | Compression / aggregates |
|---|---|---|
| `measurements` | indefinite | 7-day chunk compression, daily continuous aggregate `measurements_daily` |
| `analysis_results` | indefinite | 30-day chunk compression, daily CA `analysis_daily` |

**Scale**

- 7 plants, ~318 inverters (largest: alpha 150, then ribera 120)
- SCADA cadence 15 min → ~30 k rows/day fleet-wide
- ML training corpus ~10-15M rows over 2-3 years
- `PollingJob` Prisma model exists but is a passive config row (no live polling deployed yet)

**Already pointing in this direction**

- `disabled_pages_backup/api.disabled/data/[plantId]/route.ts` has a stub `S3ParquetStorage` class
- `nuravolt/db/writer.py:TimeseriesWriter` already batches via `psycopg2.execute_values` — easy to grow a parallel `LakeWriter`
- `backenddata/` already partitioned per-plant; bronze layout is essentially the directory we already have

**The OOM (justifies Phase 0 on its own merits)**

`scripts/aggregate_twins_to_db.py` lifts Timescale's decompression cap then DELETEs from compressed chunks — that's the OOM source. The cap-lift exists because DELETE-on-compressed-chunk expands the whole chunk into memory (~900 MB at current row counts). Patch: switch DELETE to `drop_chunks(...)` or `INSERT ... ON CONFLICT DO UPDATE`. One-day fix.

---

## 1. Where everything will live (target deployment topology)

```
┌───────────────────────────────────────────────────────────────────┐
│ VERCEL — Next.js app (already deployed)                           │
│ • API routes, ops UI, ticket workflow                             │
│ • Cron handlers for short jobs (≤300 s timeout)                   │
│ • Reads ops state from Supabase via Prisma                        │
│ • Reads gold-layer analytics from S3 via DuckDB-in-process        │
│ • Functions pinned to `fra1` (Frankfurt) — same region as bucket  │
└───────────────────────────────────────────────────────────────────┘
                  │ ms-latency point reads
                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ SUPABASE FREE — Postgres (slim, ops-state only)                   │
│ • Tickets, users, orgs, PlantAccess, Subscription                 │
│ • DataConnection, PollingJob, FieldMapping                        │
│ • latest_inverter_snapshot (~318 rows for ops UI)                 │
│ • AlertInterpretation cache                                       │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│ GITHUB ACTIONS — scheduled batch worker (free tier)               │
│ • Daily 02:00 UTC: dbt build (bronze → silver → gold + tests)     │
│ • Daily 03:00 UTC: Iceberg compaction + snapshot expiry           │
│ • Hourly: SCADA poll → bronze (until per-poll dual-write lands)   │
│ • Weekly: ML retrain (LightGBM / CatBoost), writes models to S3   │
│ • Manual: backfill, plant onboarding                              │
└───────────────────────────────────────────────────────────────────┘
                  │ pyiceberg + DuckDB writes
                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ AWS S3 — bucket `nuravolt-lake` in `eu-west-1` (as built)         │
│ • s3://nuravolt-lake/bronze/{scada,weather,public,live}/...       │
│ • s3://nuravolt-lake/silver/{measurements,weather}/...            │
│ • s3://nuravolt-lake/gold/{soiling,faults,digitaltwin}/...        │
│ • Catalog: AWS Glue (as built — see §15; SQLite was the plan)     │
│ • Versioning ON, lifecycle: noncurrent → IA after 30 d, delete 90 │
└───────────────────────────────────────────────────────────────────┘
                  ▲
                  │ DuckDB+pyiceberg over httpfs
                  │
┌───────────────────────────────────────────────────────────────────┐
│ LOCAL DEV (your laptop)                                           │
│ • Python scripts call DuckDB → S3                                 │
│ • dbt run --target dev (S3 dev prefix or filesystem catalog)      │
└───────────────────────────────────────────────────────────────────┘
```

**Net new infrastructure:** one S3 bucket + one IAM user/role. Everything else reuses Vercel + GitHub + the developer's laptop.

---

## 2. Storage: AWS S3 (chosen), with R2 noted as a later optimization

### Why S3 here, not R2

- **Already on AWS.** Bedrock for the LLM means an AWS account, IAM, billing, and observability are already wired. Adding R2 means a second cloud, second credential, second observability surface, for zero functional gain on day 1.
- **Egress fears were overstated for this architecture.** S3 charges $0.09/GB egress *to the internet*. Same-region reads (S3 `eu-west-1` ↔ compute in `eu-west-1`) are **free**; Vercel `fra1` → S3 `eu-west-1` is cross-region EU (~$0.02/GB, negligible at our volume — move functions to `dub1` if gold reads ever grow). The only paid egress in the topology is S3 → GitHub-hosted runners (US-East), which at dbt's daily volumes (~hundreds of MB) is ~$1-5/mo. Acceptable.
- **Standard tooling.** DuckDB, pyiceberg, dbt-duckdb all default to AWS auth (env vars or boto3 credential chain) — no custom endpoint config needed.

### Quick comparison

| Option | Storage | Egress | Verdict |
|---|---|---|---|
| **AWS S3** | $0.023/GB/mo | $0 in-region, $0.09/GB internet | ✅ **Chosen.** Same-region with Vercel + Bedrock; tiny external egress. |
| Cloudflare R2 | $0.015/GB/mo | $0 | Best if serving raw lake data to non-AWS consumers. Swap is non-destructive — same protocol, same tables. |
| Backblaze B2 | $0.006/GB/mo | $0.01/GB (3× storage free) | Cheapest. Only worth it at TB scale. |

### S3 config

- Region: `eu-west-1` (Ireland) — as built (plan said Frankfurt; bucket landed in Ireland with the EU standardization)
- Bucket: `nuravolt-lake`; versioning ON
- Lifecycle: noncurrent versions → Standard-IA after 30 days, expire after 90 days; abort multipart uploads after 7 days
- Encryption: SSE-S3 (default) or SSE-KMS if compliance needs it
- IAM: dedicated user `nuravolt-lake-rw` scoped to `arn:aws:s3:::nuravolt-lake/*` (Get, Put, Delete, ListBucket). Or Vercel's AWS OIDC integration so no long-lived key sits in env vars.
- Env vars: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `LAKE_BUCKET=nuravolt-lake`

### Cost-sanity for year 1

- Storage at 100 GB ceiling: 100 × $0.023 = **$2.30/mo**
- Same-region reads (Vercel ↔ S3): **$0**
- Egress to GitHub Actions (~10 GB/mo): **$0.90/mo**
- PUT/COPY/POST requests at ~10 k/day: ~$0.05/mo
- **Total: ~$3-5/mo.**

---

## 3. Compute: DuckDB vs Trino vs alternatives

| Engine | What it is | When it wins | When you reach for it next |
|---|---|---|---|
| **DuckDB** | Embedded SQL engine, single-process, columnar. Iceberg reader since 0.10, writer since 1.1. | Single-node analytics, GB-to-low-TB. Latency-sensitive. Runs *inside* Python scripts and Node servers. | Always, until you outgrow it. **Recommended.** |
| Trino (was Presto) | Distributed SQL engine. Coordinator + N workers. | TB+ data, ≥10 concurrent BI users, federation across many sources. | When DuckDB's single-node working set hurts or you need a JDBC endpoint for many tools. |
| ClickHouse | Columnar OLAP DB with its own storage. Experimental Iceberg connector. | Realtime sub-second analytics on billions of rows. | If you ship a high-volume telemetry SaaS. |
| Apache DataFusion | Embedded SQL engine on Arrow, Rust-native. | Building your own platform / engine. | Library, not an end-user tool. |
| Polars | DataFrame library, Rust+Python. | Replacing pandas inside scripts. | Use *alongside* DuckDB — Polars for DataFrame ops, DuckDB for SQL. Shared Arrow buffers. |
| Daft | Distributed Python DataFrame on Ray. | TB+ Python-native scale-out. | When you outgrow single-node Python. |
| Snowflake / BigQuery Iceberg | Pay-per-query cloud warehouses. | Enterprise BI on petabytes. | When a customer pays for it. |
| **AWS Athena** | Serverless SQL over S3 (Trino under the hood). $5/TB scanned. | Ad-hoc queries from the AWS console with no setup. | Keep handy alongside DuckDB for one-off operational queries. |

### Why DuckDB specifically wins

1. **Zero operational cost.** No coordinator, no worker pool. It's a Python package.
2. **Embedded matches the existing pattern.** Swap `pd.read_parquet(...)` for `duckdb.sql("SELECT ... FROM iceberg_scan('...')")` — same script.
3. **Faster than Trino at this size.** Trino's coordinator handshake adds 1-2 s; DuckDB beats it 2-5× at <100 GB on one node.
4. **First-class Iceberg.** `iceberg_scan('s3://...')` works out of the box.
5. **Vercel-compatible.** Runs inside a serverless function via `duckdb-async`. Trino cannot — it's a JVM cluster.
6. **Migration path is free.** Iceberg tables are portable; add Trino (or Athena, which IS Trino) later without moving data.

### When you'd add Trino

Three triggers; none true today → don't:
- ≥10 simultaneous BI users on ad-hoc queries
- Hot data exceeds ~100 GB on a single node
- Need one SQL query that federates live Postgres + Iceberg + Kafka

Athena is "Trino as a service" on S3 — if you ever want a SQL endpoint on the AWS side without operating a cluster, it reads the same Iceberg tables for $5/TB scanned.

---

## 4. Where dbt lives and what it does

dbt is a **Python CLI**. No "dbt server" required. For NuraVolt it runs in three places:

1. **Developer laptop** during dev: `dbt run --target dev`
2. **GitHub Actions** for scheduled runs: `.github/workflows/dbt-daily.yml` invokes `dbt build --target prod` on cron. GitHub-hosted runner, ephemeral, free under 2000 min/mo for private repos.
3. **Optional self-hosted runner** later: an AWS EC2 `t4g.nano` in `eu-west-1` (~$3/mo) would cut S3 egress to GitHub Actions to zero. Only worth it if egress bills climb.

dbt-Cloud (the SaaS, $100+/mo) — **skip it.**

### Mechanics

```
.github/workflows/dbt-daily.yml (GitHub runner, ephemeral)
   ↓ runs
dbt build --target prod
   ↓ compiles Jinja+SQL, resolves DAG
DuckDB (in-process on the runner) with dbt-duckdb adapter
   ↓ reads/writes via httpfs+iceberg extensions
Iceberg tables on S3
```

### Can dbt match Python's complexity?

For **analytical transformations**, yes — often nicer than Python. For **ML and external APIs**, no.

**dbt SQL wins:** window functions, multi-table joins, type/JSON/regex handling, incremental materializations (only process new partitions), Jinja macros, tests (`not_null`, `unique`, `relationships`, custom), auto-generated docs + lineage.

**Stays in Python:** LightGBM/CatBoost training, PVLib physics, Open-Meteo/Solcast/Bedrock calls, NumPy/SciPy signal processing, stateful per-row work that's not a window function.

**Gray middle: dbt-python models.** Since dbt 1.3, write a model as a Python function returning a DataFrame. With dbt-duckdb these run *on the runner that runs dbt*. Useful for one numpy step in an otherwise-SQL chain; not for full pipelines.

### Split for NuraVolt

| Lives in | Domain |
|---|---|
| **dbt SQL models** | Bronze → silver cleaning. Silver → gold aggregations. Daily/hourly rollups. Joining weather + SCADA + faults. Tests on every layer. |
| **dbt-python models** (rare) | One numpy step in a SQL chain where pulling it out would break lineage. |
| **`nuravolt/` Python (unchanged)** | All ML training, digital-twin simulation, per-inverter SR inference, fault classifier, plant-config generation, LLM calls. |

dbt owns "data shape"; Python owns "data meaning." Both read/write the same Iceberg tables.

---

## 5. Catalog choice

| Catalog | How it works | Multi-writer | Cost | Pick when |
|---|---|---|---|---|
| **SQLite-on-S3** | `pyiceberg` writes `iceberg.db` to S3 | ⚠️ single-writer at a time | $0 (storage only) | **Pick now.** Only the GitHub Action + a few scripts write. |
| **AWS Glue Data Catalog** | Managed by AWS, free tier covers our scale | ✅ | $0 below 1M objects/mo, then $1/100k req | Strong AWS-native alternative. Integrates with Athena, Lake Formation, IAM. Consider vs SQLite if you want Athena from day 1. |
| Lakekeeper REST (OSS, self-hosted) | Rust service, Iceberg REST spec | ✅ | ~$5/mo on Fly.io or AWS App Runner | When concurrent writers conflict |
| Snowflake Polaris (OSS) | Snowflake's open catalog | ✅ | self-host free | If anticipating a Snowflake move |
| Nessie | Git-style branching catalog | ✅ | self-host free | When time-travel branching matters |

**Decision:** start with SQLite-on-S3 (filesystem catalog in local dev). If Athena access from day 1 is wanted, use Glue instead — same metadata, AWS-native, free at our scale. Catalog swap is non-destructive; metadata is portable.

---

## 6. Implementation phases

### Phase 0 — Fix the local-dev OOM (~1 day, do regardless)

Patch `scripts/aggregate_twins_to_db.py`: remove the decompression-cap lift, switch DELETE-on-compressed-chunk to `drop_chunks(...)` or upsert via `ON CONFLICT DO UPDATE`.

### Phase 1 — Local Iceberg over existing parquets (DONE, verified)

Goal: prove the DuckDB+Iceberg read path with zero infra cost (filesystem catalog, no AWS).

Shipped:
- `pyproject.toml` gained a `lake` optional-dependency group (`duckdb>=1.1`, `pyarrow`, `pyiceberg[sql-sqlite]`); installed into the `nuravolt` conda env.
- `nuravolt/lake/catalog.py` — `get_catalog()` factory (filesystem warehouse under `./lake` in dev; SQLite-on-S3 in staging/prod; Glue/REST swappable behind the same factory later). `./lake/` is gitignored.
- `nuravolt/lake/__init__.py` — `register_parquet()` (zero-copy `add_files`, plus an opt-in `cast_ns_to_us` rewrite path), `read_table()` (DuckDB-over-Iceberg → pandas, the drop-in for `pd.read_parquet`), `scan_arrow()`, `list_tables()`, `table_exists()`, `NanosecondTimestampError`.
- `scripts/lake_register_bronze.py` — discovers tidy parquets and registers them as `bronze.*` Iceberg tables, then cross-checks every table's row count via DuckDB against the parquet footer. Flags: `--plant`, `--replace`, `--cast-ns`, `--max-cast-rows`, `--no-verify`.

### Phase 1 — as built (what implementation revealed; corrects the plan above)

Three plan assumptions were wrong and are corrected here:

1. **SCADA parquets are WIDE, not long.** Each `backenddata/scada/<plant>/<plant>_cleaned.parquet` is one row per timestamp × ~3,263 columns (ribera: 182,524 rows × 3,263 cols), with column names like `Ribera (ES): INV 01.032 / P_AC (kW)` and **non-UTF8 mojibake** for units (`Temperature (\x83)`, `Radiation 1 (W/m�)`). Iceberg field names can't carry those bytes. So raw wide SCADA is **deliberately not registered as bronze** — unpivoting it to tidy `(time, device_id, metric, value)` is a *silver* transformation (a dbt model), not a faithful raw-bronze `add_files`. The tidy **twin** parquets (`backenddata/twins/<uuid>/*_hourly.parquet`, already `(time, device_id, metric, value)`) and `pr_daily.parquet` are the registered bronze tables instead.

2. **Nanosecond-vs-microsecond timestamp inconsistency.** Some parquets are `timestamp[us]` (ribera twins) and some `timestamp[ns]` (alpha twins, all `pr_daily`, all `string_current`) — even for the *same logical file across plants*. Iceberg is microsecond-precision, so zero-copy `add_files` rejects `timestamp[ns]`. `register_parquet` raises `NanosecondTimestampError` with a remedy; `--cast-ns` rewrites ns→us on ingest (streamed in 1M-row batches, memory-bounded). **Recommended upstream fix:** re-export the twin/PR parquet writers at µs precision so everything stays zero-copy.

3. **The 3 "swap these reads" targets were partly invalid.** `generate_ml_soiling_predictions.py` read **no parquet** (JSON + a hardcoded sinusoid; the foundation-model call was commented out — script deleted in the 2026-07 soiling arc, superseded by `generate_per_inverter_soiling.py`). `train_per_inverter_sr.py` reads via `nuravolt/soiling/sr_per_inverter_training.py:324`, not itself. So production read-site swaps are **deferred to Phase 2/3**, when canonical tables live on S3 and `lake.read_table('bronze.<table>')` is a clean drop-in. The Postgres ingest path is unchanged; nothing in the running app was touched.

Verified end-to-end: `add_files` registered 3 twin tables (12.35M / 12.78M / 52.9M rows) and `--cast-ns` registered 2 `pr_daily` tables (52,351 / 215,755 rows); DuckDB `iceberg_scan` row counts and `sum(value)` match the source parquets exactly.

### Phase 2 — Push lake to S3, dual-write SCADA (~3-5 days)

- Provision S3 bucket `nuravolt-lake` in `eu-west-1` with versioning + lifecycle rules
- Create IAM user `nuravolt-lake-rw` with scoped policy. Store key in Vercel env + GitHub Secrets.
- One-time `aws s3 sync backenddata/ s3://nuravolt-lake/bronze/`
- NEW `nuravolt/lake/writer.py:LakeWriter` — lands a SCADA poll as `bronze/scada/{plant}/{date}/{poll_id}.parquet`
- Modify `nuravolt/db/writer.py:TimeseriesWriter` + `src/lib/db/timeseries.ts` to **dual-write** behind `LAKE_DUAL_WRITE=1` env flag
- NEW `scripts/lake_compact_bronze.py` + `.github/workflows/lake-compact-daily.yml`
- Pin Vercel functions to `fra1` region in `vercel.json`

### Phase 3 — Add dbt for silver + gold (~3-4 days)

- NEW `dbt_project/` at repo root: `dbt_project.yml`, `profiles.yml`, `models/silver/`, `models/gold/`, `tests/`, `macros/`. Adapter: `dbt-duckdb`.
- Silver: `silver_measurements.sql`, `silver_weather.sql`, `silver_inverter_metadata.sql`
- Gold: `gold_inverter_daily_perf.sql`, `gold_plant_daily_summary.sql`, `gold_soiling_inputs.sql`
- NEW `.github/workflows/dbt-daily.yml` — cron `0 2 * * *`, runs `dbt build`. Auto-opens GitHub issue on failure.
- ML scripts switch feature loads to `iceberg_scan('s3://nuravolt-lake/gold/soiling_inputs/')`

### Phase 4 — Slim Supabase, retire local Timescale (~1 week, optional)

After 2-3 months of dual-write stability:
- Confirm no Next.js route still reads `measurements` directly
- Replace Prisma `Measurement` model with `LatestInverterSnapshot` (1 row/inverter)
- Stop dual-write to Supabase; raw measurements land in S3 only
- Drop local-dev Timescale container (or keep for OLTP testing)
- Supabase footprint stays well under 500 MB → continues on free tier indefinitely

---

## 7. Critical files (by phase)

| Phase | Files |
|---|---|
| **0** | `scripts/aggregate_twins_to_db.py` (kill decompression-cap lift, switch DELETE → `drop_chunks` or upsert) |
| **1 (done)** | `pyproject.toml` (`lake` extra); NEW `nuravolt/lake/{__init__,catalog}.py`; NEW `scripts/lake_register_bronze.py`; `.gitignore` (`/lake/`). Production read-swaps deferred to Phase 2/3 (see §6 "as built"). |
| **2** | `.env.example` (+ `AWS_*`, `LAKE_BUCKET`); NEW `nuravolt/lake/writer.py`; modify `nuravolt/db/writer.py` + `src/lib/db/timeseries.ts` (dual-write hook); NEW `scripts/lake_compact_bronze.py`; NEW `.github/workflows/lake-compact-daily.yml`; `vercel.json` (pin functions to `fra1`) |
| **3** | NEW `dbt_project/` (full scaffold); NEW `.github/workflows/dbt-daily.yml`; modify ML scripts to read gold |
| **4** | `prisma/schema.prisma` (replace `Measurement` with `LatestInverterSnapshot`); NEW migration; remove `LAKE_DUAL_WRITE` flag; modify any remaining `measurements`-reading routes |

---

## 8. Reuse-don't-rebuild

- `backenddata/{scada,twins,datasets,weather}/` → become bronze with zero data movement (Phase 1 registers in place; Phase 2 copies once to S3)
- `TimeseriesWriter` in `nuravolt/db/writer.py` gains a `LakeWriter` sibling, not a rewrite
- DuckDB's S3 client uses the AWS credential chain — same env vars as Bedrock already does
- `pyiceberg` ships with SQLite + filesystem + REST + Glue catalogs — start with SQLite/filesystem
- Existing Vercel cron jobs untouched
- 300 s Vercel function timeout means short polls + gold-layer reads fit inside Vercel

---

## 9. Verification

**After Phase 0:** `python scripts/aggregate_twins_to_db.py --plant alpha` completes without OOM. No `SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0` remains in the source — the wipe now runs as bounded 7-day windowed DELETEs (`DELETE_WINDOW_DAYS`), committing per window. (Verified: the script compiles clean in the `nuravolt` env and the cap-lift is gone; full runtime check needs the local Timescale container.)

**After Phase 1 (verified):**
```bash
# uses the nuravolt conda env interpreter
python scripts/lake_register_bronze.py --replace --cast-ns
# -> registers bronze.twin_{power,temperature,mppt_voltage}_ribera (add_files, zero-copy)
#    + bronze.pr_daily_{ribera,eta} (cast ns->us); each DuckDB count == parquet footer count.
python -c "from nuravolt import lake; print(lake.read_table('bronze.twin_power_ribera', columns='count(*) n').to_dict('records'))"
# -> [{'n': 12352383}]   (matches power_hourly.parquet exactly; sum(value) parity also confirmed)
```

**After Phase 2:** S3 console shows partitioned objects under `bronze/scada/{plant}/{date}/`. Dual-write produces one row in Supabase AND one parquet on S3 per poll. DuckDB aggregates over S3 match `time_bucket('1 day', time)` aggregates over Supabase for any (plant, day).

**After Phase 3:** `dbt build --target prod` from GitHub Actions completes in <5 min. `dbt test` is green. `gold_inverter_daily_perf` has one row per `(plant_id, inverter_id, day)` for last 365 days. ML scripts produce same outputs reading from gold as from raw.

**After Phase 4:** Supabase dashboard shows DB size flat under 500 MB. Ops UI pages load in <500 ms. Stopping the local Timescale container does not break any production code path.

**Cost validation at end of year 1:** S3 + egress < $5/mo (100 GB ceiling, mostly in-region). GitHub Actions < 500 min/mo. Supabase still on free tier. Total new monthly cost: ~$3-5.

---

## 10. Out of scope (intentionally)

- Replacing Supabase entirely
- Snowflake / Databricks / BigQuery (cost-ruled-out)
- Streaming ingest (Kafka, Redpanda, Flink) — 15-min cadence is not streaming
- Trino cluster — no trigger fires
- dbt-Cloud — GitHub Actions covers scheduling
- Multi-tenant lake isolation — single-tenant until first compliance-driven customer
- REST catalog (Lakekeeper) in Phase 1-3 — add only when SQLite contention bites
- Migrating existing Vercel cron jobs — they keep running alongside
- R2 migration — defer until a non-AWS consumer needs raw lake data; non-destructive whenever
- Glue Catalog — start with SQLite; flip to Glue only if Athena access becomes worth wiring up

---

## 11. Concrete code & config sketches (appendix)

### `nuravolt/lake/catalog.py`
```python
"""Iceberg catalog factory — filesystem (dev) or SQLite-on-S3 (prod/staging)."""
from __future__ import annotations
import os
from pyiceberg.catalog.sql import SqlCatalog

LAKE_ENV = os.getenv("LAKE_ENV", "dev")

def get_catalog() -> SqlCatalog:
    if LAKE_ENV == "dev":
        return SqlCatalog(
            "nuravolt",
            uri="sqlite:///lake/catalog.db",
            warehouse="file://./lake",
        )
    bucket = os.environ["LAKE_BUCKET"]  # nuravolt-lake
    region = os.environ.get("AWS_REGION", "eu-west-1")
    return SqlCatalog(
        "nuravolt",
        uri=f"sqlite:///tmp/iceberg-{LAKE_ENV}.db",
        warehouse=f"s3://{bucket}/",
        **{
            "s3.region": region,
            # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY picked up from env automatically
        },
    )
```

### `dbt_project/dbt_project.yml`
```yaml
name: nuravolt
version: 1.0.0
config-version: 2
profile: nuravolt
model-paths: [models]
test-paths: [tests]
macro-paths: [macros]
models:
  nuravolt:
    silver:
      +materialized: incremental
      +file_format: iceberg
      +location_root: s3://nuravolt-lake/silver
    gold:
      +materialized: incremental
      +file_format: iceberg
      +unique_key: [plant_id, inverter_id, day]
      +location_root: s3://nuravolt-lake/gold
```

### `dbt_project/profiles.yml`
```yaml
nuravolt:
  target: dev
  outputs:
    prod: &s3
      type: duckdb
      path: ":memory:"
      extensions: [httpfs, iceberg, aws]
      settings:
        s3_region: "{{ env_var('AWS_REGION', 'eu-west-1') }}"
        # DuckDB's aws extension reads boto3 credential chain automatically
    dev: *s3
```

### `.github/workflows/dbt-daily.yml`
```yaml
name: dbt daily
on:
  schedule: [{ cron: "0 2 * * *" }]  # 02:00 UTC
  workflow_dispatch:
jobs:
  dbt:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      id-token: write   # for AWS OIDC if you wire that up later
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: pip install -r dbt_project/requirements.txt
      - name: dbt build
        working-directory: dbt_project
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: eu-west-1
          LAKE_BUCKET: nuravolt-lake
        run: |
          dbt deps
          dbt build --target prod
      - name: open issue on failure
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner, repo: context.repo.repo,
              title: `dbt failed ${new Date().toISOString().slice(0,10)}`,
              body: `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
              labels: ['data-pipeline', 'urgent']
            })
```

### `dbt_project/models/silver/silver_measurements.sql`
```sql
{{ config(
    materialized='incremental',
    unique_key=['plant_id','inverter_id','time','metric'],
    partition_by=['plant_id','day']
) }}
with raw as (
  select * from iceberg_scan('s3://nuravolt-lake/bronze/scada/')
  {% if is_incremental() %}
    where time > (select max(time) - interval '6 hours' from {{ this }})
  {% endif %}
)
select
  plant_id, inverter_id, time, cast(time as date) as day,
  metric, value, unit, quality
from raw
where quality in ('good','estimated') and value is not null
```

### `dbt_project/models/gold/gold_inverter_daily_perf.sql`
```sql
{{ config(materialized='incremental', unique_key=['plant_id','inverter_id','day']) }}
with m as (
  select * from {{ ref('silver_measurements') }}
  {% if is_incremental() %}
    where day >= (select max(day) - interval '3 days' from {{ this }})
  {% endif %}
),
agg as (
  select
    plant_id, inverter_id, day,
    sum(value) filter (where metric = 'ac_power_kw') / 4.0 as daily_kwh,
    avg(value) filter (where metric = 'module_temp_c') as avg_module_temp_c,
    count(*) filter (where metric = 'ac_power_kw') as samples,
    count(*) filter (where metric = 'ac_power_kw' and value > 0) as production_samples
  from m
  group by 1,2,3
)
select *, production_samples::float / nullif(samples,0) as availability from agg
```

### IAM policy for `nuravolt-lake-rw`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::nuravolt-lake"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::nuravolt-lake/*"
    }
  ]
}
```

---

## 12. Open questions to resolve before kicking off Phase 2+

- **Supabase tier during Phase 2 dual-write.** ~30 k rows/day × 90 days ≈ 2.7M rows ≈ 250 MB — within free-tier cap but tight. Either set an aggressive retention policy (only last 30 days in Supabase) or temporarily upgrade to Pro for the cut-over window.
- **Vercel function region.** ~~Currently default (US).~~ Resolved 2026-07-02: pinned to `fra1` in `vercel.json` (was `iad1`). S3 is `eu-west-1` so lake reads are cross-region EU (cents); revisit `dub1` if gold reads grow.
- **AWS auth from Vercel.** Long-lived IAM access key in env var is simplest; Vercel's AWS OIDC integration is cleaner but adds setup.
- **Catalog: SQLite vs Glue.** SQLite is zero-setup. Glue gets you Athena queries from the AWS console for free. Decide whether ad-hoc Athena access is worth ~30 min extra setup.
- **Failure notifications.** GitHub Actions sketch opens an issue on dbt failure. Slack webhook? Email? PagerDuty?
- **`public/data/*.json` demo fixtures.** Currently the source of truth for the demo UI. Keep as hand-curated demo data, or regenerate nightly from gold tables in CI?
- **Plant onboarding flow.** How does a new plant get its bronze SCADA into the lake on day 1 — manual `lake_register_bronze.py` run, or an admin API endpoint?
- **AWS Bedrock + S3 in same account?** Confirm so IAM scoping doesn't create a cross-account headache.

---

## 13. TL;DR for the three deep-dives

1. **Why DuckDB over Trino?** Embedded (no cluster), faster at <100 GB single-node, Vercel-compatible. Trino is for ≥10 concurrent BI users, federation, or working sets that genuinely need fan-out. Lake is portable — adopt Trino later (or just use Athena, which IS Trino-as-a-service on the same Iceberg tables) without moving data.

2. **Where does dbt live?** Python CLI — runs wherever invoked. On the dev laptop (`dbt run --target dev`), on a GitHub-hosted runner via `.github/workflows/dbt-daily.yml` for prod cron. No dbt server, no dbt-Cloud.

3. **Can dbt match Python's complexity?** For analytical transformations (joins, windows, rollups, incremental builds, tests, lineage) — yes, often nicer. For ML/physics/external APIs/NumPy — no, that stays in `nuravolt/` Python. dbt-python models cover the gray middle. Split: dbt owns "data shape," Python owns "data meaning."
