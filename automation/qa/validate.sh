#!/usr/bin/env bash
# One-command validation pipeline for the demo -> dashboard app.
#
# Lanes, cheapest first (fail fast):
#   1. leak-lint      static: no /demo links or ungated /data fetches on dashboard
#   2. pytest         Python unit + served-artifact physics (tests/fault + tests/soiling;
#                     the artifact tests catch placeholder regressions in public/data/soiling)
#   3. api-cases      regenerate + sweep every route.ts (deterministic status)
#   4. contracts      vitest: strict shape + tenancy isolation + twin/soiling sanity
#   5. dashboard-walk Playwright: per-page crashes, fixture-404s, /demo leaks, nav gating
#
# Prereqs: dev server running (npm run dev); the QA org's plants seeded
#   (python scripts/seed_e2e_demo_data.py --plant-id smoke-park-one --operational
#    && python -m nuravolt.pipeline.onboard_plant --plant-id smoke-park-one).
# The UI lane needs Playwright in $PYTHON (pip install -r automation/requirements.txt
#   && playwright install chromium). Override the interpreter with PYTHON=... when
#   Playwright lives in a venv/conda env, e.g. PYTHON=$(which python) npm run validate.
#
# Env: BASE_URL (default http://localhost:3000), QA_EMAIL / QA_PASSWORD
#   (default the smoke fixture user), PYTHON (default python3).
set -uo pipefail
cd "$(dirname "$0")/../.."

PYTHON="${PYTHON:-python3}"
BASE_URL="${BASE_URL:-http://localhost:3000}"
QA_EMAIL="${QA_EMAIL:-smoke@nuravolt.test}"
QA_PASSWORD="${QA_PASSWORD:-smoketest-passw0rd}"
PLANT="${QA_PLANT_SLUG:-smoke-park-one}"
BESS_PLANT="${QA_BESS_PLANT_SLUG:-region_a-storage}"

pass=0; fail=0
declare -a results

lane() {  # lane <name> <cmd...>
  local name="$1"; shift
  echo ""
  echo "──────── $name ────────"
  if "$@"; then results+=("✅ $name"); pass=$((pass+1));
  else results+=("❌ $name"); fail=$((fail+1)); fi
}

# 0. Server reachable?
if ! curl -fsS -o /dev/null "$BASE_URL/api/plants" 2>/dev/null; then
  echo "❌ dev server not reachable at $BASE_URL — start it with: npm run dev"
  exit 1
fi

# 1. Static leak-lint (no server/deps needed beyond stdlib).
lane "leak-lint" "$PYTHON" scripts/check_dashboard_leaks.py

# 2. Python unit + served-artifact physics tests (no server needed).
lane "pytest" "$PYTHON" -m pytest -q tests

# Sign in once; share the cookie across the API sweep + UI walk.
COOKIE=$(curl -s -D - -o /dev/null -X POST "$BASE_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' -H "Origin: $BASE_URL" \
  -d "{\"email\":\"$QA_EMAIL\",\"password\":\"$QA_PASSWORD\"}" \
  | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr '\n' ';' | sed 's/;$//')
if [ -z "$COOKIE" ]; then echo "❌ QA sign-in failed for $QA_EMAIL"; exit 1; fi
export QA_SESSION_COOKIE="$COOKIE"

# 3. API cases — regenerate from the filesystem, then sweep.
lane "api-cases" bash -c "\
  '$PYTHON' scripts/generate_api_cases.py --plant-slug '$PLANT' --bess-plant-slug '$BESS_PLANT' --inverter-id INV-01 >/dev/null && \
  '$PYTHON' -m automation.qa.collect --cases automation/qa/cases/api-full.yaml"

# 4. Vitest contracts.
lane "contracts" bash -c "QA_PLANT_SLUG='$PLANT' npx vitest run tests/api"

# 5. Dashboard walk (Playwright) — needs Playwright in \$PYTHON.
lane "dashboard-walk" bash -c "\
  '$PYTHON' -m automation.qa.collect --cases automation/qa/cases/dashboard-walk.yaml --headless"

echo ""
echo "════════ VALIDATION SUMMARY ════════"
for r in "${results[@]}"; do echo "  $r"; done
echo "  ($pass passed, $fail failed)"
[ "$fail" -eq 0 ] || exit 1
