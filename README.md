# NuraVolt

Energy intelligence for solar, wind and battery storage: a production SaaS that turns raw plant telemetry into per-inverter soiling forecasts, fault and remaining-life predictions, battery warranty and revenue tracking, and an operations agent that can act on all of it.

Built and operated as a solo product from 2025 to 2026. The live platform runs at [nuravolt.com](https://nuravolt.com). This repository is the full source: the Next.js application, the Python analytics package, the lakehouse pipeline, the tests and the documentation.

![Portfolio overview](docs/screenshots/01-portfolio-overview.png)

## What it does

**Per-inverter soiling intelligence.** Plants usually carry one dust sensor for the whole site. NuraVolt infers a soiling ratio for every inverter from AC power, irradiance and cell temperature after digital-twin correction for weather, curtailment and temperature, then forecasts it 365 days out with a physics-ML hybrid (LightGBM over pvlib clear-sky features) and optimises the cleaning schedule against energy price, rain forecast and cleaning cost.

![Soiling](docs/screenshots/03-soiling.png)

**Fault detection and remaining useful life.** Rule-based, twin-residual and ML detectors run side by side over inverter, string and MPPT telemetry. Each fault carries an evidence chain, a confidence and a time-to-action, and thermal RUL models rank inverters by degradation.

![Faults](docs/screenshots/04-faults.png)

**Battery intelligence.** Rainflow cycle counting, chemistry-aware degradation, a four-axis warranty tracker and a worst-of-four state of safety. Revenue is kept as a three-lane ledger (measured, declared, benchmark) that is never summed, with a perfect-foresight arbitrage bound over real day-ahead prices from Elexon, NESO, OMIE and ENTSO-E.

![Battery](docs/screenshots/05-bess.png)
![Revenue ledger](docs/screenshots/06-bess-revenue.png)

**Shams, the operations agent.** A tool-using LLM agent (AWS Bedrock) with 15 typed tools over the same services the UI uses: forecasts, fault triage, cleaning optimisation, contract obligations, report composition, ticket drafts. Every tool result renders as a rich card, and the same tools are exposed to external agents through an MCP server with OAuth and scoped API keys.

![Shams](docs/screenshots/07-shams-agent.png)
![MCP in Claude](docs/screenshots/08-mcp-claude.png)

**The agent service.** A second agent, built as a LangGraph planner/executor in Python, consumes the product through its own MCP server. It classifies intent, plans tool calls against the live catalogue, verifies every result, and pauses on a durable interrupt before any write so a human approves, edits or rejects it; threads are checkpointed in Postgres and the organisation gets a long-term memory of preferences and nicknames. Trajectory and approval evals run in CI against a scripted model, and a live eval grades answers with an LLM judge. Details and diagrams in [docs/AGENT.md](docs/AGENT.md).

```mermaid
flowchart LR
  A[classify intent] --> B[plan]
  B --> C{write step?}
  C -- no --> D[execute via MCP]
  C -- yes --> H[interrupt: human approval]
  H -- approved / edited --> D
  H -- rejected --> V
  D --> V[verify result]
  V -- next step --> C
  V -- replan --> B
  V -- done --> S[synthesize answer]
  S --> M[write memory]
```

**Also in the box:** digital twins per plant and per device (physics plus CatBoost residual), contract intelligence (PPA, warranty, SLA obligations evaluated hourly), alert evaluation with email and signed webhooks, a ticketing workflow, scheduled PDF reports rendered with headless Chromium, a data hub with lineage, multi-tenant organisations with plan gating and Stripe billing, and connectors for Huawei FusionSolar, SolarEdge, Sungrow, Modbus, SCADA databases and CSV.

## Architecture

```mermaid
flowchart LR
  subgraph app["Vercel (Frankfurt)"]
    next["Next.js 14 app<br/>marketing, ops console, API routes"]
    shams["Shams agent + MCP server"]
  end
  subgraph state["Supabase Postgres"]
    prisma["Prisma models<br/>orgs, plants, tickets, alerts, contracts, BESS"]
  end
  subgraph aws["AWS eu-west-1"]
    s3["S3 lakehouse<br/>bronze / silver / gold (Iceberg)"]
    glue["Glue catalog"]
    bedrock["Bedrock LLM"]
    secrets["Secrets Manager + KMS"]
  end
  subgraph batch["GitHub Actions"]
    dbt["dbt (DuckDB) nightly"]
    py["Python analytics<br/>nuravolt/ package"]
  end
  connectors["Plant connectors<br/>FusionSolar, SolarEdge, Sungrow, Modbus, SCADA, CSV"]

  connectors --> next
  next --> prisma
  next --> s3
  shams --> bedrock
  next --> secrets
  s3 --> glue
  s3 --> dbt --> s3
  s3 --> py --> prisma
  py --> s3
```

The full topology, every data plane and the honest state of each is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tech stack

| Layer | Choice |
|---|---|
| Web | Next.js 14 (App Router), React 18, TypeScript, Tailwind, shadcn/ui, ECharts |
| Auth and tenancy | Better Auth (email, Google, magic link, organisations), MCP OAuth provider |
| Ops database | PostgreSQL on Supabase via Prisma |
| Analytics lake | Apache Iceberg on S3, AWS Glue catalog, DuckDB compute, dbt silver and gold models |
| Analytics | Python 3.11: Polars, pandas, pvlib, LightGBM, CatBoost, scikit-learn |
| LLM | AWS Bedrock (Qwen), typed tool calling, cost tracking per turn |
| Billing | Stripe |
| Hosting and batch | Vercel, GitHub Actions |
| Tests | Vitest (API contracts, tenancy, UI logic), pytest (analytics), Playwright (page walk) |

## Repository layout

```
src/                 Next.js app: app router pages, API routes, components, lib
  app/api/           REST routes (soiling, faults, bess, tickets, contracts, chat, mcp, cron)
  lib/               services, agent tools, MCP server, alerts, contracts, billing
nuravolt/            Python analytics package
  soiling/           soiling ratio, per-inverter estimation, forecasting, cleaning optimiser
  fault/             rule-based detection, thermal RUL, topology
  digitaltwin/       physics + ML hybrid twins
  bess/              rainflow, degradation, warranty, optimizer audit, imbalance
  markets/           day-ahead prices (GB, Iberia, ENTSO-E)
  lake/              Iceberg lakehouse access and publish seam
  pipeline/          orchestration entry points
dbt_project/         silver and gold models over the bronze lake
prisma/              schema, migrations, seeds
public/data/         static forecast and twin artifacts read by the demo pages
scripts/             analysis, training, backfill and QA scripts (see scripts/README.md)
tests/               vitest and pytest suites
automation/qa/       end-to-end validation harness
docs/                architecture hub, model docs, technical specs
```

## Running it locally

Everything below runs without any external account. The local demo seeds one fully synthetic plant pair (Kilima Solar Park, a 6 MW PV plant with 24 inverters, and Athi Storage, a 1 MW / 2 MWh battery): telemetry is generated from a committed weather fixture through the physics models, faults and tickets are scripted, battery dispatch is modelled over published day-ahead prices. Nothing is copied from a real plant.

### Docker (recommended)

```bash
git clone https://github.com/jeffreymokumtech/nuravolt.git && cd nuravolt
docker compose up
```

First start builds the app, migrates the database and runs the seed (a few minutes). Then open http://localhost:3000 and sign in:

| | |
|---|---|
| Email | `demo@nuravolt.local` |
| Password | `nuravolt-demo` |

The agent service comes up on http://localhost:8100 with the same stack (see [docs/AGENT.md](docs/AGENT.md)). Optional integrations are switched on by filling values in `.env.docker`: an LLM endpoint for the chat surfaces (Ollama on the host works out of the box), AWS for Bedrock, Resend for email, Stripe for billing.

### Bare metal

Prerequisites: Node 22, Python 3.11, Docker for the database (the schema uses TimescaleDB extensions).

```bash
cp .env.example .env.local           # then set the variables below
docker compose up -d db              # TimescaleDB on localhost:5432
npm install
pip install -e ".[lake,agent]" psycopg2-binary python-dotenv
DATABASE_URL=postgresql://nuravolt:nuravolt@localhost:5432/nuravolt npm run seed:local-demo
npm run dev                          # http://localhost:3000
```

| Variable | Required | What it enables |
|---|---|---|
| `DATABASE_URL` | yes | Postgres with TimescaleDB |
| `BETTER_AUTH_SECRET` | yes | Session signing (`openssl rand -base64 32`) |
| `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `BETTER_AUTH_URL` | yes | `http://localhost:3000` locally |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` or `AWS_BEARER_TOKEN_BEDROCK` | no | Bedrock: Shams chat, briefings, alert narration, knowledge base embeddings |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | no | Any OpenAI-compatible model for the agent service |
| `RESEND_API_KEY` | no | Invitations, magic links, scheduled report emails |
| `STRIPE_SECRET_KEY` and price ids | no | Self-service billing (the demo org has enterprise entitlements without it) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Google sign-in |
| `LAKE_BUCKET`, `LAKE_ENV` | no | The S3 lakehouse; `LAKE_ENV=dev` uses a local folder |

What works with no keys: the whole operations console (portfolio, plant overview, soiling, faults, battery health and revenue, contracts, tickets, data quality, reports and PDFs), the MCP server, and the agent service with a local model. What needs a key: Shams chat and the other LLM surfaces (an LLM provider), knowledge base search (Bedrock embeddings plus the pgvector extension), outbound email, billing.

## Tests

```bash
npm test               # vitest: API contracts, tenancy isolation, connectors, UI logic
npm run test:py:ci     # pytest: soiling, fault, BESS, twin, markets, lake
npm run lint
npm run validate       # full harness: leak lint, API sweep, contracts, Playwright page walk
```

CI runs lint, both test suites and a production build on every push ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Documentation

- [Architecture hub](docs/ARCHITECTURE.md): topology, data planes, lakehouse layers, ingestion contracts
- [Project map](docs/PROJECT_MAP.md): every model, every LLM call site, public datasets, foundation models
- [Data architecture](docs/DATA_ARCHITECTURE_GUIDE.md): lakehouse decision record and as-built
- [Model accuracy](docs/MODEL_ACCURACY.md) and [methods](docs/MODEL_ACCURACY_METHODS.md): what the models are measured against
- [Product overviews](docs/overviews/): soiling, fault detection, inverter health, battery, digital twin, forecasting
- [Technical specs](docs/technical/): soiling methodology, fault detection spec, twin configuration, transfer learning
- [MCP server](docs/MCP_SERVER.md), [AI and LLM usage](docs/AI_AND_LLM_USAGE.md), [cloud inverter APIs](docs/CLOUD_INVERTER_APIS.md)

## A note on the data

Plant names, locations and identifiers in this repository are fictional or anonymised. Measured telemetry that trained and validated the models came from operating plants under agreements that do not permit redistribution, so the fixtures here are anonymised specimens or synthetic series. Every number the UI shows is tagged with its provenance (measured, modelled, provisional) and the product never presents a modelled value as a measurement.
