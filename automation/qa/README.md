# Validation

How we prove the app works for a real user. Five lanes, cheapest first, each a
standing artifact you can re-run. `npm run validate` chains the deterministic
four; the adversarial review workflow is the on-demand deep audit.

| Lane | What it catches | Command | Speed |
|------|-----------------|---------|-------|
| **leak-lint** | `/demo` links + ungated `/data` fetches reachable from `/dashboard` (import-graph precise) | `npm run qa:leaks` | instant |
| **api-cases** | every `route.ts` returns a sane status (deterministic pass/fail) | `npm run qa:api` | ~1 min |
| **contracts** | strict shape, tenancy isolation, MW cap, twin/soiling sanity | `npm run test:api` | ~30 s |
| **dashboard-walk** | per-page crashes, fixture-404s, `/demo` leaks, **nav gating** | `npm run qa:ui` | ~2 min |
| **adversarial review** | logic bugs the above miss (math, timezones, idempotency) | Workflow tool (see below) | ~10 min |

```bash
npm run validate            # lanes 1-4, fail-fast, one summary
PYTHON=$(which python) npm run validate   # when Playwright lives in a venv/conda
```

## Why these lanes, in this order

Each lane exists because a real bug slipped past the ones above it:

- **leak-lint** is static and instant. The `/demo`→`/dashboard` reuse leaked
  hardcoded `/demo` links and `/data` fixture fetches; a browser walk finds them
  but a grep finds them in milliseconds and points at `file:line`. It walks the
  **import graph** from the dashboard pages so it only flags genuinely-reachable
  code (a demo-only component may legitimately keep its `/demo` links).
- **api-cases** sweeps the whole route surface for status regressions. Generated
  from the filesystem (`scripts/generate_api_cases.py`) so coverage is auditable
  — every `route.ts` is either swept or an explicit SKIP.
- **contracts** (`tests/api/contracts.test.ts`) asserts *shape and behaviour*,
  not just status: cross-tenant 404s via throwaway orgs, the MW-cap 402, the
  twin's actual-within-50%-of-predicted sanity, the forecast windowed from today.
- **dashboard-walk** loads each page as the signed-in org user and asserts the
  things a screenshot alone won't: no `/data` fetch fired, no `/demo` link in the
  DOM, and the **nav rail matches the asset type** (a BESS plant offers
  Revenue/Battery and hides Soiling/Faults; a PV plant the reverse).
- **adversarial review** is a multi-agent audit for the logic bugs none of the
  above assert — a timezone misalignment in the twin, a non-idempotent upsert, a
  double-counted energy total. Run it after a substantial change.

## Prerequisites

```bash
# 1. Deps (one time)
cd automation && pip install -r requirements.txt && playwright install chromium

# 2. Dev server
npm run dev

# 3. Seed the QA org's fixture plants (PV + BESS, same org)
python scripts/seed_e2e_demo_data.py --plant-id smoke-park-one --operational
python -m nuravolt.pipeline.onboard_plant --plant-id smoke-park-one   # coldstart forecast + physics twin
python scripts/seed_e2e_demo_data.py --plant-id region_a-storage --operational   # BESS

# 4. Global equipment manuals (shared KB library — every org can search/read them)
npm run seed:manuals -- --org=global
# One-time on prod (after pulling DATABASE_URL via `npx vercel env pull`):
#   DATABASE_URL=<prod url> npx tsx scripts/seed_manuals.ts --org=global
```

Fixtures: `smoke-park-one` (PV) + `region_a-storage` (BESS) under the same org as
`smoke@nuravolt.test`. The walk + contracts default to these; override with
`QA_PLANT_SLUG` / `QA_BESS_PLANT_SLUG` / `QA_EMAIL` / `QA_PASSWORD`.

## Sample inverter feed (sandbox) — self-test

A paying customer who has no real inverter credentials can turn on a synthetic
feed so the dashboard is never a dead end. To try it yourself:

1. In the onboarding wizard (`/dashboard/onboarding`), at **Data Sources** click
   **Try with sample data** → Confirm → **Generate sample data**. (It's also the
   escape hatch when a vendor like Sungrow is still "coming soon".)
2. Or, on an already-created but empty plant, open its status page
   (`/dashboard/plant/<slug>/status`) and click **Generate sample data**.

Under the hood this POSTs `/api/plants/<slug>/sample-feed`, which writes ~30 days
of per-inverter `measurements` + `LatestDeviceSnapshot` (via a TS generator — no
Python), provisions a `sample_api` connection + field mappings, and triggers the
onboarding pipeline for the twin/soiling/faults. The feed is badged
"Sample / sandbox (synthesized)" in the data-lineage panel and connections list.
The contract test `sample inverter feed (seeded plant)` in
`tests/api/contracts.test.ts` asserts live-tile + onboarding-status + lineage all
light up; the API sweep covers `post-api-plants-sample-feed`.

## Cloud inverter API tests (Huawei / SolarEdge / free demos)

Three layers, full landscape + how to get vendor keys in
[`docs/CLOUD_INVERTER_APIS.md`](../../docs/CLOUD_INVERTER_APIS.md):

- `npm run test:connectors` — vitest contract tests (`tests/connectors/*`) drive
  the real Huawei + SolarEdge clients through their `fetchImpl` seam against
  recorded fixtures. No network/creds; folded into `npm run test:api`.
- `npm run test:live` — real API round-trips (`tests/integration/*`). Skips every
  vendor whose env creds are absent (0 failures); never in default CI. Supply
  keys per `.env.example` (SolarEdge, Huawei, Fronius demo, GoodWe). The GoodWe
  probe reaches the real SEMS cloud with any real login (public demo is disabled).

## The collector (api-cases + dashboard-walk)

`python -m automation.qa.collect --cases <file>` drives `requests` for API cases
and Playwright for UI cases, dropping artifacts + `manifest.json` into a
timestamped `outputs/<run_id>/`. A non-zero exit means an assertion failed.
`/qa-judge` (Claude Code itself) then rubric-grades the artifacts for the softer
"does this show real data" questions.

Auth: export `QA_SESSION_COOKIE` (a signed-in Better Auth cookie) — API cases
attach it as `Cookie`, and UI cases with `authed: true` load it into the browser
context so `/dashboard/*` renders as the org user.

```bash
COOKIE=$(curl -s -D - -o /dev/null -X POST localhost:3000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"email":"smoke@nuravolt.test","password":"smoketest-passw0rd"}' \
  | grep -i '^set-cookie:' | sed 's/^set-cookie: //I' | cut -d';' -f1 | paste -sd';' -)
QA_SESSION_COOKIE="$COOKIE" npm run qa:ui
```

## Writing cases

Rubrics must be **explicit about PASS and FAIL** — vague rubrics produce vague
verdicts. Beyond the rubric, UI cases can carry **deterministic assertions** that
turn a screenshot into pass/fail without the LLM:

```yaml
- id: dash-bess-overview
  type: ui
  authed: true                       # load QA_SESSION_COOKIE into the browser
  url: /dashboard/plant/region_a-storage
  actions:
    - wait_for_selector: "main, [class*='ops']"
    - wait_for_timeout: 1500
  forbid_requests: ["/data/", "/demo"]          # FAIL if any request URL contains these
  forbid_selectors:                             # FAIL if any element matches (nav gating!)
    - 'a[href^="/demo"]'
    - 'a[href$="/region_a-storage/soiling"]'      # BESS must NOT show Soiling
  expect_selectors: ['a[href$="/region_a-storage/revenue"]']  # BESS MUST show Revenue
  allow_console_substrings: ["PopChild"]        # ignore known-benign dev warnings
  max_console_errors: 0
  rubric: |
    PASS if the BESS overview shows SoH + a battery panel and no PV panels.
    FAIL on a fixture 404 or PV empty-states on a battery plant.
```

Any case with `forbid_*` / `expect_selectors` / `max_console_errors` gets a
deterministic `passed` flag (and drives the collector's exit code). Pure
screenshot cases leave it to `/qa-judge`. The collector waits for `networkidle`
after `goto`, so client-side data (e.g. the asset-gated nav) is settled before
assertions run. Supported `actions`: `wait_for_selector`, `click`,
`fill {selector, value}`, `wait_for_timeout` (each with optional `timeout` ms).

Case files: `cases/dashboard-walk.yaml` (authed /dashboard + demo/showcase
regression), `cases/api-full.yaml` (generated — don't hand-edit), plus the
legacy `smoke.yaml` / `all-pages.yaml`.

## Adversarial review workflow (deep audit)

For substantial changes, run a multi-agent review: N dimension reviewers
(tenancy/security, analytics-correctness, frontend, fixture-leak completeness,
pipeline) each produce findings, and every finding is then handed to an
independent verifier prompted to *refute* it — only findings it can't refute
survive. This is what caught the twin timezone bug, the double-counted energy,
and the BESS-synth idempotency issue that the deterministic lanes passed over.
Launch it via the Workflow tool (see `.claude/` orchestration); it is on-demand
and token-heavy, not part of `npm run validate`.

## Interactive browser (Playwright MCP)

With `.mcp.json` at the repo root, Claude Code gets live browser control
(navigate/click/screenshot) for exploration and reproducing failures the batch
collector surfaces. Just ask: "open /dashboard/data-hub and try adding a
connection." Note: the MCP session can wedge after a dev-server restart — fall
back to the collector or a standalone Playwright script if navigations hang.

## Directory layout

```
automation/qa/
├── validate.sh            # npm run validate — chains the four deterministic lanes
├── collect.py             # collector CLI (requests + Playwright, deterministic assertions)
├── case_loader.py         # strict YAML schema (typos fail loudly)
├── cases/
│   ├── dashboard-walk.yaml # authed /dashboard walk + demo/showcase regression
│   ├── api-full.yaml       # generated by scripts/generate_api_cases.py
│   ├── smoke.yaml
│   └── all-pages.yaml
└── outputs/               # gitignored; <run_id>/{manifest,,*.png,*.json,report.md}

scripts/check_dashboard_leaks.py   # leak-lint (import-graph reachability)
scripts/generate_api_cases.py      # regenerates api-full.yaml from the route filesystem
tests/api/contracts.test.ts        # vitest contract + tenancy suite
```
