#!/usr/bin/env bash
# Local demo seed: migrations, a demo login, and one fully synthetic plant pair
# (Kilima Solar Park + Athi Storage). Every number it writes is generated at
# seed time from the committed weather fixture, physics models and published
# day-ahead prices; nothing is copied from a real plant.
#
# Idempotent. Runs inside the web container before the server starts
# (docker-compose.yml) and works on a laptop too:
#
#   DATABASE_URL=postgresql://nuravolt:nuravolt@localhost:5432/nuravolt bash scripts/seed_local_demo.sh
#
# Set SEED_LOCAL_DEMO=0 to skip (e.g. a container restart on a seeded volume).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${SEED_LOCAL_DEMO:-1}" = "0" ]; then
  echo "[seed] SEED_LOCAL_DEMO=0, skipping"
  exit 0
fi
: "${DATABASE_URL:?DATABASE_URL is required}"
export NODE_ENV="${SEED_NODE_ENV:-development}"   # the identity seeder refuses production
PY="${PYTHON:-python3}"
ORG=demo_org_alpha1
PV=kilima-solar
BESS=athi-storage
WEATHER=public/data/weather/kilima_demo_hourly.json

step() { printf '\n[seed] %s\n' "$*"; }

step "database migrations"
npx prisma migrate deploy

step "demo login + organisation + agent key"
npx tsx prisma/seed-demo-account.ts

step "plant registry ($PV, $BESS)"
"$PY" scripts/seed_prod_fleet.py --org-clerk-id "$ORG" --plants "$PV,$BESS"

# Order matters (docs/DEMO_ACCOUNT.md): onboarding calibrates the physics twin
# to whatever it finds, so the clean pass runs first, then the twin, then the
# pass that injects the visible problems (a dirty inverter, trips, an outage).
step "PV telemetry: clean pass"
"$PY" scripts/seed_e2e_demo_data.py --plant-id "$PV" --days 30 --operational --weather-fixture "$WEATHER"
step "PV onboarding (cold-start soiling, twin, quality)"
"$PY" -m nuravolt.pipeline.onboard_plant --plant-id "$PV" || echo "[seed] onboarding reported errors; continuing"
step "PV telemetry: problems pass"
"$PY" scripts/seed_e2e_demo_data.py --plant-id "$PV" --days 30 --operational --problems --weather-fixture "$WEATHER"

step "BESS telemetry + intelligence"
"$PY" scripts/seed_e2e_demo_data.py --plant-id "$BESS" --days 30 --operational --weather-fixture "$WEATHER"
"$PY" -m nuravolt.pipeline.onboard_plant --plant-id "$BESS" || echo "[seed] onboarding reported errors; continuing"
"$PY" scripts/backfill_bess_intelligence.py --plant "$BESS" || echo "[seed] BESS backfill reported errors; continuing"
npx tsx scripts/seed_bess_completeness.ts || true
"$PY" scripts/generate_bess_audit_artifacts.py --plant "$BESS" --skip-pdf || echo "[seed] BESS audit reported errors; continuing"

step "contracts, electrical twins, reports, cleaning plan"
npx tsx scripts/seed_contracts.ts --pv-plant="$PV" || true
"$PY" scripts/synth_electrical_twins.py --plant "$PV" || true
# The identity seeder writes DEMO_USER_ID next to the agent key.
if [ -f "${AGENT_KEY_ENV_FILE:-.env.docker}" ]; then set -a; . "${AGENT_KEY_ENV_FILE:-.env.docker}"; set +a; fi
DEMO_USER_ID="${DEMO_USER_ID:-demo_user}"
npx tsx scripts/seed_demo_reports.ts --org "$ORG" --user "$DEMO_USER_ID" --recipients "${DEMO_EMAIL:-demo@nuravolt.local}" || true
npx tsx scripts/seed_demo_cleaning_plan.ts --org "$ORG" --user "$DEMO_USER_ID" --plant "$PV" || true

step "synthetic soiling artifacts for $PV"
"$PY" scripts/make_kilima_demo_artifacts.py --synthetic-donor || echo "[seed] artifact generation reported errors; continuing"

step "done"
