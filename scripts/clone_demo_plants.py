#!/usr/bin/env python3
"""Clone the smoke-park-one plant structure into extra PV plants for a fuller
demo fleet, all under the same org. Copies every Plant/InverterGroup/Inverter
column (so the schema stays valid) and overrides id/slug/name/coords/capacity.

Idempotent: skips a target slug that already exists.

    python scripts/clone_demo_plants.py
Then seed + onboard each printed slug.
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    from dotenv import load_dotenv
    load_dotenv(".env"); load_dotenv(".env.local")
except Exception:
    pass

import psycopg2
import psycopg2.extras

SOURCE_SLUG = "smoke-park-one"

# New PV plants: (slug, name, lat, lon, capacity_mw, timezone)
NEW_PLANTS = [
    ("valencia-solar", "Valencia Solar Park", 39.47, -0.38, 5.2, "Europe/Madrid"),
    ("region_a-field", "Region A Solar Field", 36.84, -2.46, 8.0, "Europe/Madrid"),
    ("toledo-ridge", "Toledo Ridge PV", 39.86, -4.02, 2.4, "Europe/Madrid"),
    ("faro-coastal", "Faro Coastal Array", 37.02, -7.93, 3.1, "Europe/Lisbon"),
]


def _conn():
    dsn = os.environ["DATABASE_URL"]
    return psycopg2.connect(dsn)


def _copy_row(cur, table: str, where_col: str, where_val, overrides: dict) -> dict:
    """Read one row as a dict, apply overrides, insert it, return the new row."""
    cur.execute(f'SELECT * FROM "{table}" WHERE {where_col} = %s LIMIT 1', (where_val,))
    row = dict(cur.fetchone())
    row.update(overrides)
    cols = list(row.keys())
    placeholders = ", ".join(["%s"] * len(cols))
    collist = ", ".join(f'"{c}"' for c in cols)
    cur.execute(
        f'INSERT INTO "{table}" ({collist}) VALUES ({placeholders})',
        [row[c] for c in cols],
    )
    return row


def main() -> int:
    conn = _conn()
    conn.autocommit = False
    created: list[str] = []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT id, organization_id FROM "Plant" WHERE slug = %s', (SOURCE_SLUG,))
        src = cur.fetchone()
        if not src:
            print(f"source plant {SOURCE_SLUG} not found", file=sys.stderr)
            return 1
        src_plant_id = src["id"]
        cur.execute('SELECT id FROM "InverterGroup" WHERE plant_id = %s LIMIT 1', (src_plant_id,))
        src_group_id = cur.fetchone()["id"]

        for slug, name, lat, lon, cap, tz in NEW_PLANTS:
            cur.execute('SELECT 1 FROM "Plant" WHERE slug = %s', (slug,))
            if cur.fetchone():
                print(f"skip {slug} (exists)")
                continue
            new_plant_id = str(uuid.uuid4())
            _copy_row(cur, "Plant", "slug", SOURCE_SLUG, {
                "id": new_plant_id, "slug": slug, "name": name,
                "latitude": lat, "longitude": lon, "capacity_mw": cap, "timezone": tz,
            })
            new_group_id = str(uuid.uuid4())
            _copy_row(cur, "InverterGroup", "id", src_group_id, {
                "id": new_group_id, "plant_id": new_plant_id,
            })
            cur.execute('SELECT external_id FROM "Inverter" WHERE group_id = %s ORDER BY external_id', (src_group_id,))
            inv_ids = [r["external_id"] for r in cur.fetchall()]
            for ext in inv_ids:
                _copy_row(cur, "Inverter", "external_id", ext, {
                    "id": str(uuid.uuid4()), "group_id": new_group_id,
                })
            created.append(slug)
            print(f"created {slug} ({cap} MW, {len(inv_ids)} inverters)")

    conn.commit()
    conn.close()
    if created:
        print("\nNext, for each new slug run:")
        for slug in created:
            print(f"  python scripts/seed_e2e_demo_data.py --plant-id {slug} --operational && "
                  f"python -m nuravolt.pipeline.onboard_plant --plant-id {slug}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
