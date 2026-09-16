#!/usr/bin/env python3
"""Generate automation/qa/cases/api-full.yaml from the API route filesystem.

Enumerates every src/app/api/**/route.ts, detects exported methods, fills
path params from the seeded test plant, and emits QA cases with sensible
expect_status assertions. Coverage is auditable: the generated suite carries
one case per (route, GET) plus curated write cases; the script prints any
route it could not parameterize so nothing silently drops out.

    python3 scripts/generate_api_cases.py [--plant-slug region_a-rooftop] \
        [--inverter-id INV-01] [--out automation/qa/cases/api-full.yaml]

Auth model: local dev needs no headers (demo-fallback session); against
staging export QA_SESSION_COOKIE. MCP cases read ${MCP_BEARER} from the env.
Write routes get curated idempotent bodies below — extend WRITE_CASES when
adding routes.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "src" / "app" / "api"

# Routes that are intentionally NOT swept (special auth or side effects).
SKIP = {
    "/api/auth/[...all]",            # Better Auth internal surface
    "/api/mcp/[transport]",          # exercised by dedicated MCP cases below
    "/api/stripe/webhook",           # needs signed payloads (vitest covers it)
    "/api/measurements/ingest",      # INGEST_API_KEY push endpoint
    "/api/cron/poll-connections",    # CRON_SECRET
    "/api/cron/send-reports",        # CRON_SECRET
    "/api/cron/narration-metrics",   # CRON_SECRET
    "/api/checkout/growth",          # 308 redirect stub
    "/api/checkout/business",        # redirects to Stripe (vitest asserts 303)
    "/api/billing/portal",           # redirects to Stripe
    "/api/contact",                  # sends real email
    "/api/leads/capture",            # writes Lead + sends email
    "/api/leads/audit",              # sends email
}

# Param fillers, keyed by the bracket param name.
def param_fillers(plant: str, inverter: str) -> dict[str, str]:
    return {
        "plantId": plant,
        "inverterId": inverter,
        "assetId": "primary",
        "ticketId": "00000000-0000-0000-0000-000000000000",
        "connectionId": "00000000-0000-0000-0000-000000000000",
        "id": "00000000-0000-0000-0000-000000000000",
        "jobId": "00000000-0000-0000-0000-000000000000",
        "mpptId": "1",
        "stringId": "1",
        "streamId": "s1",
        "slug": plant,
        "token": "unknown-token",
        "transport": "mcp",
    }


GENERIC_RUBRIC = (
    "Response is valid JSON with no stack traces or secrets. Status matches "
    "expect_status. For 200s the payload has plausible domain fields (not an "
    "empty shell when the seeded plant should have data). For 4xx the body "
    "carries an 'error' key with a human-readable reason."
)


def discover_routes() -> list[tuple[str, list[str]]]:
    routes: list[tuple[str, list[str]]] = []
    for route_file in sorted(API_DIR.rglob("route.ts")):
        rel = route_file.parent.relative_to(ROOT / "src" / "app")
        url = "/" + str(rel).replace("\\", "/")
        src = route_file.read_text(encoding="utf-8")
        methods = sorted(set(re.findall(r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b", src)))
        if methods:
            routes.append((url, methods))
    return routes


def fill_params(url: str, fillers: dict[str, str]) -> str | None:
    def repl(match: re.Match[str]) -> str:
        name = match.group(1).lstrip(".")
        return fillers.get(name, "__MISSING__")

    filled = re.sub(r"\[(\.*[A-Za-z]+)\]", repl, url)
    return None if "__MISSING__" in filled else filled


# Per-family behavior: (substring match on the ROUTE url, query suffix
# template, allowed statuses). First match wins. {plant}/{inverter}/{bess}
# are filled from CLI args. Rationale per family:
#  - wind/*: asset-type-specific; a PV/BESS fixture plant legitimately 404s.
#  - bess/*: swept against the BESS test plant.
#  - param-requiring GETs: a clean 400 (validated input) is a pass.
#  - data-dependent analytics: 404-no-data is honest until data accrues.
FAMILY_RULES: list[tuple[str, str, list[int]]] = [
    # Specific routes first — matching is first-wins.
    ("/api/wind/plants/[plantId]/scada", "?turbineId=T-01", [200, 400, 404]),
    ("/api/wind/", "", [200, 404]),
    ("/api/digitaltwin/[plantId]/timeseries", "?device_id={inverter}", [200, 404]),
    ("/api/digitaltwin/[plantId]/parquet-query", "?device_id={inverter}&type=mppt_voltage", [200, 400, 404]),
    ("/api/soiling/plants/[plantId]/history", "?inverterId={inverter}&days=30", [200, 404]),
    ("/api/inverters/[inverterId]/classification", "?plant_id={plant}", [200, 400, 404]),
    ("/api/inverters/[inverterId]/anomalies", "?plant_id={plant}", [200, 400, 404]),
    ("/api/soiling/universal", "", [200, 400]),
    ("/api/soiling/inverters/[inverterId]", "", [200, 400, 404]),
    ("/api/faults/sensor-history", "?plantId={plant}&sensorId=1", [200, 400, 404]),
    ("/api/analysis/[plantId]", "?domain=soiling", [200, 404]),
    ("/api/faults", "?plantId={plant}", [200, 404]),
    ("/api/soiling/plants/", "", [200, 400, 404]),
    ("/api/analysis/", "", [200, 404]),
    ("/api/analytics/", "", [200, 404]),
    ("/api/measurements/", "", [200, 404]),
    ("/api/llm/", "", [200, 404]),
    ("/api/bess/", "", [200, 404]),
]

# Core seeded surfaces that MUST 200 — overrides the family default.
MUST_200 = [
    "/api/plants",
    "/api/plants/[plantId]",
    "/api/plants/[plantId]/live",
    "/api/plants/[plantId]/onboarding-status",
    "/api/soiling/plants/[plantId]/forecast",
    "/api/soiling/plants/[plantId]/summary",
    "/api/digitaltwin/[plantId]/summary",
    "/api/billing/plan",
    "/api/billing/usage",
    "/api/tickets",
    "/api/tickets/stats",
    "/api/bess/plants/[plantId]",
    "/api/bess/plants/[plantId]/revenue",
]


def route_behavior(url: str, fillers: dict[str, str], bess_plant: str) -> tuple[str, list[int]]:
    """(query suffix, expected statuses) for a route url."""
    query = ""
    expect: list[int] = [200]
    for pattern, q, statuses in FAMILY_RULES:
        if url.startswith(pattern) or pattern.rstrip("/") == url:
            query = q
            expect = statuses
            break
    if url in MUST_200:
        expect = [200]
    query = query.format(plant=fillers["plantId"], inverter=fillers["inverterId"], bess=bess_plant)
    return query, expect


def expected_get_status(url: str) -> list[int]:
    # Known-id lookups with zero-uuids legitimately 404; plant-scoped reads 200.
    if "00000000-0000-0000-0000-000000000000" in url or "unknown-token" in url:
        return [404, 400, 410]
    return [200]


def case_id(url: str, method: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", url.lower().strip("/")).strip("-")
    return f"{method.lower()}-{slug}"[:80]


def emit_yaml(cases: list[dict]) -> str:
    # Hand-rolled emission keeps key ordering + comments-free determinism.
    lines: list[str] = ["# GENERATED by scripts/generate_api_cases.py - regenerate, don't hand-edit the swept section."]
    for c in cases:
        lines.append(f"- id: {c['id']}")
        lines.append(f"  type: api")
        lines.append(f"  method: {c['method']}")
        lines.append(f"  path: {c['path']}")
        if c.get("json") is not None:
            import json as _json

            lines.append(f"  json: {_json.dumps(c['json'])}")
        if c.get("headers"):
            lines.append("  headers:")
            for k, v in c["headers"].items():
                lines.append(f"    {k}: \"{v}\"")
        expect = c["expect_status"]
        lines.append(f"  expect_status: {expect if isinstance(expect, list) else [expect]}")
        lines.append(f"  description: {c['description']}")
        lines.append("  rubric: |")
        for rub_line in c["rubric"].splitlines() or [c["rubric"]]:
            lines.append(f"    {rub_line}")
    return "\n".join(lines) + "\n"


def curated_write_cases(plant: str) -> list[dict]:
    """Idempotent-ish write cases against the seeded fixtures."""
    return [
        {
            "id": "post-api-tickets-create",
            "method": "POST",
            "path": "/api/tickets",
            "json": {
                "plant_id": "__PLANT_UUID__",  # resolved at runtime by suite doc; see note
                "title": "QA suite ticket (safe to close)",
                "trigger_type": "MANUAL_CREATION",
                "priority": "LOW",
            },
            "expect_status": [201, 404],
            "description": "Create a low-priority ticket on the seeded plant (404 acceptable when plant uuid placeholder not replaced).",
            "rubric": GENERIC_RUBRIC,
        },
        {
            "id": "post-api-plants-mw-cap",
            "method": "POST",
            "path": "/api/plants",
            "json": {
                "name": "QA Overcap Park",
                "latitude": 37.0,
                "longitude": -4.0,
                "capacity_mw": 9999,
            },
            "expect_status": [402, 401],
            "description": "MW cap must reject an absurd plant (402 upgrade-required; 401 when unauthenticated on staging).",
            "rubric": "Body has error=mw_limit_reached (or plant_limit_reached) and an upgrade_url when 402.",
        },
        {
            "id": "post-api-plants-sample-feed",
            "method": "POST",
            "path": "/api/plants/" + plant + "/sample-feed",
            "json": {},
            "expect_status": [200],
            "description": "Sample inverter feed provisions a sandbox connection + synthetic telemetry.",
            "rubric": "Body has ok=true, a connection_id, device_count>0 and rows_written>0. Idempotent.",
        },
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plant-slug", default="region_a-rooftop")
    parser.add_argument("--bess-plant-slug", default="region_a-storage")
    parser.add_argument("--inverter-id", default="INV-01")
    parser.add_argument("--out", type=Path, default=ROOT / "automation" / "qa" / "cases" / "api-full.yaml")
    args = parser.parse_args()

    fillers = param_fillers(args.plant_slug, args.inverter_id)
    routes = discover_routes()

    cases: list[dict] = []
    skipped: list[str] = []
    unparameterized: list[str] = []

    for url, methods in routes:
        if url in SKIP:
            skipped.append(url)
            continue
        if "GET" not in methods:
            continue
        # BESS routes sweep against the BESS test plant.
        route_fillers = dict(fillers)
        if url.startswith("/api/bess/"):
            route_fillers["plantId"] = args.bess_plant_slug
            route_fillers["slug"] = args.bess_plant_slug
        filled = fill_params(url, route_fillers)
        if filled is None:
            unparameterized.append(url)
            continue
        query, expect = route_behavior(url, route_fillers, args.bess_plant_slug)
        if "00000000-0000-0000-0000-000000000000" in filled or "unknown-token" in filled:
            expect = expected_get_status(filled)
        cases.append(
            {
                "id": case_id(url, "GET"),
                "method": "GET",
                "path": filled + query,
                "expect_status": expect,
                "description": f"GET sweep of {url}",
                "rubric": GENERIC_RUBRIC,
            }
        )

    cases.extend(curated_write_cases(args.plant_slug))

    args.out.write_text(emit_yaml(cases), encoding="utf-8")
    total_routes = len(routes)
    print(f"routes discovered: {total_routes}")
    print(f"cases written:     {len(cases)} -> {args.out}")
    print(f"skipped (intentional): {len(skipped)}")
    if unparameterized:
        print(f"NOT parameterized (add fillers!): {unparameterized}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
