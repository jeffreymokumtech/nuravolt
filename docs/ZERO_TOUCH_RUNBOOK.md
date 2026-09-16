# Zero-touch onboarding — how the loop works & what keeps it on

Last updated: 2026-07-09.

## The loop

1. **Customer connects their inverter cloud** (residential: 3-step flow at
   `/dashboard/onboarding/residential`; business: full wizard or the
   "Create plants from discovery" action in the Data Hub).
2. **Discovery** (`POST /api/connections/[id]/discover`) captures the plant
   name, coordinates, kWp, timezone, commissioning date and device inventory
   from the vendor, persisted as `DiscoveredPlant` (+ static field mappings).
3. **Promotion** (`POST /api/connections/[id]/promote`,
   `src/lib/onboarding/promote.ts`) turns that into a real `Plant` +
   `InverterGroup` + `Inverter`s + `PlantDataSource` — no manual input.
4. **Analytics** (`triggerPlantOnboarding`) dispatches
   `.github/workflows/plant-onboarding.yml`, which runs
   `nuravolt/pipeline/onboard_plant.py`: cold-start soiling forecast, digital
   twin, synthesized faults, soiling streams, **power forecast** — plant flips
   ONBOARDING → TRAINING. The nightly sweep (`analytics-nightly.yml`,
   03:30 UTC) re-runs every active plant and is the safety net when a
   dispatch fails.
5. **Polling** (`poll-connections.yml`, PAUSED 2026-09-14: schedule removed and workflow disabled to cut Vercel usage; re-add the cron + `gh workflow enable` to resume) fetches realtime vendor
   KPIs → measurements → twin calibration → TRAINING → OPERATIONAL.
6. **Irradiance** is satellite-based by default (Open-Meteo, confidence
   labelled) — no on-site sensor needed anywhere in the loop.

## Environment that keeps it on

| Where | Key | Purpose | Status |
|---|---|---|---|
| GitHub repo secret | `DATABASE_URL` | plant-onboarding + analytics-nightly write to PROD (use the **session pooler** URL, port 5432) | set 2026-07-09 |
| GitHub repo secret | `CRON_SECRET` | poll-connections auth | set 2026-07-08 |
| Vercel prod | `GITHUB_DISPATCH_TOKEN` | app dispatches plant-onboarding instantly on plant creation. **Founder-created fine-grained PAT**: github.com → Settings → Developer settings → Fine-grained tokens → repo = this repo only, Permissions → Actions: Read and write. Without it, jobs stay `queued` and the nightly sweep picks them up. | ⚠️ founder action |
| Vercel prod | `GITHUB_REPO` | e.g. `jeffreyjeffreymokumtech/nuravolt` | set 2026-07-09 |
| Vercel prod | `CRON_SECRET`, AWS keys, `LAKE_BUCKET` | polling + lake writes | set 2026-07-08 |

## Residential vendor coverage

Live today: **SolarEdge** (homeowner self-serve API key), **Huawei
FusionSolar** (installer-level Northbound account), **sample feed**.
Fast-follow: **Enode** — one integration + homeowner OAuth "Link" flow
covering 20+ brands (Enphase, Growatt, GoodWe, SolaX, Fronius…). Founder
action: sign up at enode.com for sandbox keys; the residential vendor grid
already reserves the card.

## Cautions

- The nightly sweep now processes every `organization_id IS NOT NULL` plant
  in ONBOARDING/TRAINING/OPERATIONAL against prod — a few seconds and two
  Open-Meteo calls per plant (free tier is ample).
- Promotion is idempotent (`Plant.metadata.promoted_from`); re-promoting
  returns the existing plant.
- If a vendor omits coordinates/capacity, promotion returns 422
  `discovery_incomplete { missing[] }` and the UI asks for exactly those
  fields — never a silently broken plant.
