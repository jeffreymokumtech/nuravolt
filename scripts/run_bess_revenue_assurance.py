#!/usr/bin/env python3
"""Build the three-lane BESS revenue ledger for one plant or the whole fleet.

    DATABASE_URL=<dsn> python scripts/run_bess_revenue_assurance.py --plant ribera-solar
    DATABASE_URL=<dsn> python scripts/run_bess_revenue_assurance.py --all

Runs nuravolt.pipeline.bess_revenue_assurance.assure_bess_revenue, which writes
per-day lane rows to analysis_results (domain='bess', one model_version per
lane, so provenance never mixes) and the rolling summary to
AnalysisArtifact(kind='bess_revenue_assurance') that the revenue route serves.

The lanes are never summed: measured (metered energy at the reference price,
plus exact Elexon BM reconstruction when a BMU id is declared), declared (from
the plant's confirmed contracts) and benchmark (the perfect-foresight LP). On a
modelled asset the measured lane is honestly empty; the benchmark lane is what
gives the capture-ratio KPI its real denominator.

Also called from the onboarding sweep (nuravolt/pipeline/onboard_plant.py), so
the nightly keeps the windows fresh; this script is for backfills and demo
reseeds. Idempotent: each lane is delete-then-write scoped by model_version.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

# An explicitly-exported DATABASE_URL always beats .env: the house
# override-everything convention once silently pointed a prod run at the local
# database (see scripts/add_bess_to_plant.ts for the incident writeup).
load_dotenv(PROJECT_ROOT / ".env", override=not os.environ.get("DATABASE_URL"))

from nuravolt.pipeline.bess_revenue_assurance import assure_bess_revenue  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--plant", help="plant slug or uuid")
    group.add_argument("--all", action="store_true", help="every BESS/HYBRID plant")
    ap.add_argument("--days", type=int, default=365, help="ledger depth (default 365)")
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if args.all:
                cur.execute(
                    'SELECT * FROM "Plant" WHERE asset_type::text IN (%s, %s) ORDER BY slug',
                    ("BESS", "HYBRID"),
                )
            else:
                cur.execute(
                    'SELECT * FROM "Plant" WHERE slug = %s OR id::text = %s',
                    (args.plant, args.plant),
                )
            plants = [dict(r) for r in cur.fetchall()]

        if not plants:
            sys.exit(f"no plant matched {args.plant!r}" if args.plant else "no BESS/HYBRID plants")

        failures = 0
        for plant in plants:
            try:
                report = assure_bess_revenue(conn, plant, days=args.days, dsn=dsn)
                note = report.get("skipped") or json.dumps(
                    {k: v for k, v in report.items() if k in ("assets", "windows")},
                    default=str,
                )[:300]
                print(f"  {plant['slug']}: {note}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"  {plant['slug']}: FAILED {exc}", file=sys.stderr)

        return 1 if failures else 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
