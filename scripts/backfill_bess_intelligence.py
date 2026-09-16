#!/usr/bin/env python3
"""Run the real BESS intelligence pipeline for a plant (or every BESS/HYBRID plant)
and persist genuine analytics to the DB, replacing the rows the deleted
placeholder generator used to write.

Real algorithms (ASTM rainflow, degradation-aware arbitrage, chemistry SoH,
warranty scoring, RUL) over real day-ahead prices for the plant's bidding zone:
OMIE for ES/PT, Elexon half-hourly for GB. Provisional twin — no BMS telemetry —
clearly tagged. See nuravolt/pipeline/bess_intelligence.py.

The zone comes from Plant.country unless --zone overrides it, and it decides
both the settlement currency and the period length, so a GB asset is written as
48 half-hourly GBP periods rather than 24 euro hours.

Usage:
    python scripts/backfill_bess_intelligence.py --plant region_a-storage [--dry-run]
    python scripts/backfill_bess_intelligence.py --all            # every BESS/HYBRID plant
    python scripts/backfill_bess_intelligence.py --plant boreas --days 395
    python scripts/backfill_bess_intelligence.py --plant thurrock-bess --zone GB

Prod: export the prod DATABASE_URL explicitly, dry-run first, then verify with psql.
"""

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv


def clean_dsn(dsn: str) -> str:
    """Drop Prisma-only query params (pgbouncer, connection_limit, schema, …) that
    libpq/psycopg2 rejects; keep SSL-related ones. Supabase's pooler connects fine
    without them (psycopg2 binds params client-side, so transaction mode is OK)."""
    parts = urlsplit(dsn)
    keep = [(k, v) for k, v in parse_qsl(parts.query)
            if k in ("sslmode", "sslrootcert", "sslcert", "sslkey", "options")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(keep), parts.fragment))

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.pipeline.bess_intelligence import resolve_zone, synthesize_bess_history  # noqa: E402


def resolve_plants(conn, ident, all_bess):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if all_bess:
            cur.execute(
                'SELECT id, slug, name, capacity_mw, asset_type, country FROM "Plant" '
                "WHERE asset_type IN ('BESS', 'HYBRID') ORDER BY slug"
            )
            return list(cur.fetchall())
        cur.execute(
            'SELECT id, slug, name, capacity_mw, asset_type, country FROM "Plant" '
            "WHERE id::text = %s OR slug = %s",
            (ident, ident),
        )
        row = cur.fetchone()
        if not row:
            sys.exit(f"plant not found: {ident}")
        return [row]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", help="plant slug or uuid")
    ap.add_argument("--all", action="store_true", help="every BESS/HYBRID plant")
    ap.add_argument("--days", type=int, default=395, help="history depth (default 395)")
    ap.add_argument("--zone", default=None,
                    help="bidding zone override (default: from Plant.country, else ES)")
    ap.add_argument("--dry-run", action="store_true", help="resolve + report, write nothing")
    args = ap.parse_args()
    if not args.plant and not args.all:
        sys.exit("pass --plant <slug> or --all")

    load_dotenv(PROJECT_ROOT / ".env")  # AWS + local DATABASE_URL; won't override an exported DSN
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    conn = psycopg2.connect(clean_dsn(dsn))
    plants = resolve_plants(conn, args.plant, args.all)
    print(f"{len(plants)} plant(s): {', '.join(p['slug'] for p in plants)}")

    if args.dry_run:
        for p in plants:
            plant = dict(p)
            print(f"  [dry-run] would run BESS intelligence for {p['slug']} "
                  f"({p['asset_type']}, {p['capacity_mw']} MW), {args.days} days, "
                  f"zone {resolve_zone(plant, args.zone)}")
        conn.close()
        return

    for p in plants:
        plant = {"id": p["id"], "slug": p["slug"], "name": p["name"],
                 "capacity_mw": p["capacity_mw"], "country": p.get("country")}
        try:
            result = synthesize_bess_history(conn, plant, days=args.days, zone=args.zone)
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {p['slug']}: {type(e).__name__}: {e}")
            conn.rollback()
            continue
        if result.get("skipped"):
            print(f"  – {p['slug']}: {result['skipped']}")
        else:
            missing = result.get("days_missing_prices") or 0
            odd = result.get("days_resolution_mismatch") or 0
            gap = f" · {missing} day(s) unpriced" if missing else ""
            if odd:
                gap += f" · {odd} day(s) skipped on settlement resolution"
            print(f"  ✓ {p['slug']}: SoH {result['soh']} · health {result['health_score']} "
                  f"({result['risk_level']}) · {result['cumulative_cycles']} cyc · "
                  f"{result['violations']} violations · {result['zone']} "
                  f"{result['currency']} @{result['resolution_minutes']}min · "
                  f"prices {result['price_source']}{gap} · {result['engine']}")
    conn.close()


if __name__ == "__main__":
    main()
