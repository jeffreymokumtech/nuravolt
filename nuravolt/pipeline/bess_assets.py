"""BessAsset row creation, extracted from the retired toy BESS twin.

`nuravolt/pipeline/bess_synth.py` used to own both the asset row and a crude
placeholder twin (charge-cheapest-3h dispatch, hardcoded RTE, linear SoH). The
twin was superseded by `nuravolt/pipeline/bess_intelligence.py`, which runs the
real `nuravolt.bess` algorithms over real day-ahead prices; the synth module is
gone. Only the asset-row helper survives, because a plant still needs a
`BessAsset` to exist before any engine can write dispatch, cycling or warranty
rows against it.

HONESTY BOUNDARY: the row this creates is a placeholder nameplate, not a
commissioning record. Duration (2h), chemistry (LFP), module/rack counts and
manufacturer are assumed from the plant's AC capacity because no BMS or
datasheet is connected. Metadata carries `{"synthesized": true}` so downstream
surfaces can tell an assumed nameplate from a real one; a real asset spec
replaces the row through the same plant_id key.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict

import psycopg2.extras


def ensure_bess_asset(conn, plant: Dict[str, Any]) -> Dict[str, Any]:
    """Find or create the plant's BessAsset (2h duration default)."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "BessAsset" WHERE plant_id = %s LIMIT 1', (plant["id"],))
        row = cur.fetchone()
        if row:
            return dict(row)

        power_kw = float(plant["capacity_mw"]) * 1000.0
        capacity_kwh = power_kw * 2.0
        asset_id = str(uuid.uuid4())
        cur.execute(
            'INSERT INTO "BessAsset" (id, plant_id, external_asset_id, name, chemistry, '
            ' nominal_capacity_kwh, nominal_power_kw, module_count, rack_count, '
            ' manufacturer, model, current_soh, current_soc, enabled, created_at, updated_at, metadata) '
            "VALUES (%s, %s, %s, %s, 'LFP', %s, %s, %s, %s, %s, %s, 1.0, 0.5, true, NOW(), NOW(), %s) "
            "RETURNING *",
            (
                asset_id,
                plant["id"],
                f"BESS-{plant['slug']}",
                f"{plant.get('name', plant['slug'])} storage",
                capacity_kwh,
                power_kw,
                max(1, int(capacity_kwh // 250)),
                max(1, int(capacity_kwh // 2500)),
                "Generic",
                "GridPack 2h",
                json.dumps({"synthesized": True, "duration_h": 2}),
            ),
        )
        created = dict(cur.fetchone())
    conn.commit()
    return created
