#!/usr/bin/env python3
"""Export the vendor-id -> plant/asset resolution dimension into the lake.

The bronze landing zone is honest but anonymous. Every poll object carries
``plant_ext_id`` and ``device_ext_id`` exactly as the vendor said them, and
NOTHING in S3 knows which NuraVolt plant, which battery asset, or which currency
those strings belong to: that knowledge lives only in Postgres. Without it the
lake can count rows but cannot answer a single business question, so silver has
no join key and gold cannot be attributed to a customer.

This exports that mapping as a daily snapshot::

    s3://{LAKE_BUCKET}/bronze/dim/device_map/dt={YYYY-MM-DD}/part-0.parquet

registered as ``bronze.dim_device_map``. It is a *snapshot per day*, not a
mutable table: a device that is renamed or a plant that changes hands keeps
yesterday's rows resolvable against yesterday's telemetry. Downstream models take
the newest ``dt`` per key.

Resolution honesty
------------------
Every row records HOW it was resolved in the ``resolution`` column:

  ``promoted_from``     the plant was promoted from this exact
                        (connection_id, external_plant_id) discovery, so the
                        mapping is exact (``src/lib/onboarding/promote.ts``).
  ``data_source_sole``  the connection is wired to exactly one plant through
                        PlantDataSource and no promotion stamp exists, so the
                        mapping is unambiguous by elimination.
  ``unresolved``        the connection serves several plants and none of them
                        claims this external id. ``plant_id`` is left NULL.

Nothing is guessed. An unresolved row stays unresolved rather than being attached
to a plausible plant, because a mis-attributed megawatt-hour is worse than a
missing one.

Canonical BESS ids
------------------
The grain convention is ``BESS <asset>[.U-n][.R-k][.M-m][.C-c]``, defined once in
``src/lib/services/cloud-connector.ts``. The parser below mirrors that file's
regex and its parent-level validation exactly, so a Python reader and a
TypeScript writer can never disagree about what a device id means.

Usage::

    python -m nuravolt.lake.export_dim --dry-run
    python -m nuravolt.lake.export_dim --day 2026-07-20
    python -m nuravolt.lake.export_dim --out /tmp/dim   # local tree, no S3
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

DEFAULT_PREFIX = "bronze/dim/device_map"
TABLE_ID = "bronze.dim_device_map"

# ---------------------------------------------------------------------------
# Canonical BESS device id — mirrors src/lib/services/cloud-connector.ts
# ---------------------------------------------------------------------------

BESS_DEVICE_ID_PREFIX = "BESS "
PLANT_ROLLUP_DEVICE_ID = "PLANT"

_BESS_DEVICE_ID_RE = re.compile(
    r"^BESS ([^.]+?)(?:\.U-(\d+))?(?:\.R-(\d+))?(?:\.M-(\d+))?(?:\.C-(\d+))?$"
)


def sanitize_bess_asset_token(raw: Any) -> str:
    """'.' is the grain separator so it cannot survive; whitespace is collapsed."""
    text = "" if raw is None else str(raw)
    return re.sub(r"\s+", " ", text.replace(".", "-")).strip()


def build_bess_device_id(
    asset: str,
    unit: Optional[int] = None,
    rack: Optional[int] = None,
    module: Optional[int] = None,
    cell: Optional[int] = None,
) -> str:
    """Build a canonical BESS device id, refusing malformed hierarchies."""
    token = sanitize_bess_asset_token(asset)
    if not token:
        raise ValueError("build_bess_device_id: asset token is empty")
    if token == PLANT_ROLLUP_DEVICE_ID:
        raise ValueError(
            f"build_bess_device_id: '{PLANT_ROLLUP_DEVICE_ID}' is reserved for plant rollups"
        )

    device_id = f"{BESS_DEVICE_ID_PREFIX}{token}"
    ended = False
    for level, index in (("U", unit), ("R", rack), ("M", module), ("C", cell)):
        if index is None:
            ended = True
            continue
        if ended:
            raise ValueError("build_bess_device_id: hierarchy has a gap (a level was skipped)")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise ValueError(f"build_bess_device_id: {level} index must be a non-negative integer")
        device_id += f".{level}-{index}"
    return device_id


def parse_bess_device_id(device_ext_id: Any) -> Optional[Dict[str, Any]]:
    """Parse a canonical BESS device id. Returns None for anything else."""
    match = _BESS_DEVICE_ID_RE.match("" if device_ext_id is None else str(device_ext_id))
    if not match:
        return None

    asset = match.group(1).strip()
    if not asset or asset == PLANT_ROLLUP_DEVICE_ID:
        return None

    def as_int(group: Optional[str]) -> Optional[int]:
        return None if group is None else int(group)

    unit, rack, module, cell = (as_int(match.group(i)) for i in (2, 3, 4, 5))

    # A deeper level without its parent is not addressable — reject rather than
    # guess which level the caller meant.
    if rack is not None and unit is None:
        return None
    if module is not None and rack is None:
        return None
    if cell is not None and module is None:
        return None

    grain = "asset"
    if cell is not None:
        grain = "cell"
    elif module is not None:
        grain = "module"
    elif rack is not None:
        grain = "rack"
    elif unit is not None:
        grain = "unit"

    return {
        "device_ext_id": str(device_ext_id),
        "asset": asset,
        "unit": unit,
        "rack": rack,
        "module": module,
        "cell": cell,
        "grain": grain,
    }


def is_bess_device_id(device_ext_id: Any) -> bool:
    return parse_bess_device_id(device_ext_id) is not None


# ---------------------------------------------------------------------------
# Row assembly (pure — the tests drive this directly)
# ---------------------------------------------------------------------------

DIM_COLUMNS = [
    "dt",
    "connection_id",
    "plant_ext_id",
    "device_ext_id",
    "device_type",
    "plant_id",
    "plant_slug",
    "country",
    "currency",
    "resolution",
    "canonical_device_id",
    "device_grain",
    "asset_token",
    "unit_no",
    "rack_no",
    "module_no",
    "cell_no",
    "bess_asset_id",
    "asset_match",
    "asset_external_id",
    "asset_name",
    "chemistry",
    "nominal_capacity_kwh",
    "nominal_power_kw",
    "rack_count",
    "module_count",
]


def _plant_index(plants: Sequence[Dict[str, Any]], data_sources: Sequence[Dict[str, Any]]):
    """Build the two lookup tables the resolver needs.

    Returns ``(by_promotion, by_connection)`` where ``by_promotion`` is keyed by
    ``(connection_id, external_plant_id)`` and ``by_connection`` maps a
    connection to every plant wired to it through PlantDataSource.
    """
    by_promotion: Dict[tuple, Dict[str, Any]] = {}
    for plant in plants:
        conn = plant.get("promoted_connection_id")
        ext = plant.get("promoted_plant_ext_id")
        if conn and ext:
            by_promotion[(str(conn), str(ext))] = plant

    by_id = {str(p["id"]): p for p in plants}
    by_connection: Dict[str, List[Dict[str, Any]]] = {}
    for src in data_sources:
        conn = src.get("connection_id")
        plant = by_id.get(str(src.get("plant_id")))
        if not conn or plant is None:
            continue
        bucket = by_connection.setdefault(str(conn), [])
        if all(p["id"] != plant["id"] for p in bucket):
            bucket.append(plant)
    return by_promotion, by_connection


def resolve_plant(
    connection_id: str,
    plant_ext_id: str,
    by_promotion: Dict[tuple, Dict[str, Any]],
    by_connection: Dict[str, List[Dict[str, Any]]],
):
    """Resolve a vendor plant id to a plant, or to nothing. Never to a guess."""
    exact = by_promotion.get((str(connection_id), str(plant_ext_id)))
    if exact is not None:
        return exact, "promoted_from"

    candidates = by_connection.get(str(connection_id), [])
    if len(candidates) == 1:
        return candidates[0], "data_source_sole"
    return None, "unresolved"


def _match_bess_asset(
    assets_for_plant: Sequence[Dict[str, Any]], asset_token: Optional[str]
):
    """Match a parsed asset token to a BessAsset, and say how it was matched.

    Returns ``(asset, how)`` where ``how`` is ``external_id``, ``name``,
    ``sole_asset`` or ``none``. The caller stores ``how`` so a downstream reader
    can tell an exact identifier match from a match by elimination.
    """
    if not asset_token:
        return None, "none"
    token = sanitize_bess_asset_token(asset_token).casefold()
    for key, how in (("external_asset_id", "external_id"), ("name", "name")):
        for asset in assets_for_plant:
            candidate = sanitize_bess_asset_token(asset.get(key)).casefold()
            if candidate and candidate == token:
                return asset, how
    # The device id already parsed as a battery device on this plant. If the
    # plant holds exactly one battery asset, that is the only asset it can
    # belong to — unambiguous by elimination, and labelled as such.
    if len(assets_for_plant) == 1:
        return assets_for_plant[0], "sole_asset"
    return None, "none"


def build_dim_rows(
    day: str,
    plants: Sequence[Dict[str, Any]],
    data_sources: Sequence[Dict[str, Any]],
    devices: Sequence[Dict[str, Any]],
    bess_assets: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Assemble the device_map snapshot for one day."""
    by_promotion, by_connection = _plant_index(plants, data_sources)

    assets_by_plant: Dict[str, List[Dict[str, Any]]] = {}
    for asset in bess_assets:
        assets_by_plant.setdefault(str(asset["plant_id"]), []).append(asset)

    rows: List[Dict[str, Any]] = []
    for device in devices:
        connection_id = str(device.get("connection_id") or "")
        plant_ext_id = str(device.get("plant_ext_id") or "")
        device_ext_id = str(device.get("device_ext_id") or "")
        if not connection_id or not device_ext_id:
            continue

        plant, resolution = resolve_plant(
            connection_id, plant_ext_id, by_promotion, by_connection
        )
        parsed = parse_bess_device_id(device_ext_id)
        if parsed and plant:
            asset, asset_match = _match_bess_asset(
                assets_by_plant.get(str(plant["id"]), []), parsed["asset"]
            )
        else:
            asset, asset_match = None, "none"

        rows.append(
            {
                "dt": day,
                "connection_id": connection_id,
                "plant_ext_id": plant_ext_id,
                "device_ext_id": device_ext_id,
                "device_type": device.get("device_type"),
                "plant_id": str(plant["id"]) if plant else None,
                "plant_slug": plant.get("slug") if plant else None,
                "country": plant.get("country") if plant else None,
                "currency": plant.get("currency") if plant else None,
                "resolution": resolution,
                "canonical_device_id": parsed["device_ext_id"] if parsed else None,
                "device_grain": parsed["grain"] if parsed else None,
                "asset_token": parsed["asset"] if parsed else None,
                "unit_no": parsed["unit"] if parsed else None,
                "rack_no": parsed["rack"] if parsed else None,
                "module_no": parsed["module"] if parsed else None,
                "cell_no": parsed["cell"] if parsed else None,
                "bess_asset_id": str(asset["id"]) if asset else None,
                "asset_match": asset_match,
                "asset_external_id": asset.get("external_asset_id") if asset else None,
                "asset_name": asset.get("name") if asset else None,
                "chemistry": asset.get("chemistry") if asset else None,
                "nominal_capacity_kwh": _as_float(asset.get("nominal_capacity_kwh")) if asset else None,
                "nominal_power_kw": _as_float(asset.get("nominal_power_kw")) if asset else None,
                "rack_count": _as_int(asset.get("rack_count")) if asset else None,
                "module_count": _as_int(asset.get("module_count")) if asset else None,
            }
        )
    return rows


def _as_float(value: Any) -> Optional[float]:
    return None if value is None else float(value)


def _as_int(value: Any) -> Optional[int]:
    return None if value is None else int(value)


# ---------------------------------------------------------------------------
# Postgres reads
# ---------------------------------------------------------------------------

_PLANTS_SQL = """
SELECT
    p.id::text                                        AS id,
    p.slug,
    p.country,
    p.currency,
    p.asset_type::text                                AS asset_type,
    p.metadata->'promoted_from'->>'connection_id'     AS promoted_connection_id,
    p.metadata->'promoted_from'->>'external_plant_id' AS promoted_plant_ext_id
FROM "Plant" p
"""

_DATA_SOURCES_SQL = """
SELECT plant_id::text AS plant_id, connection_id::text AS connection_id
FROM "PlantDataSource"
WHERE connection_id IS NOT NULL AND enabled = true
"""

_DEVICES_SQL = """
SELECT
    connection_id::text AS connection_id,
    plant_ext_id,
    device_ext_id,
    device_type
FROM "LatestDeviceSnapshot"
"""

_BESS_ASSETS_SQL = """
SELECT
    id::text       AS id,
    plant_id::text AS plant_id,
    external_asset_id,
    name,
    chemistry::text AS chemistry,
    nominal_capacity_kwh,
    nominal_power_kw,
    rack_count,
    module_count
FROM "BessAsset"
WHERE enabled = true
"""


def _fetch(cur, sql: str) -> List[Dict[str, Any]]:
    cur.execute(sql)
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def fetch_snapshot(dsn: str, day: str) -> List[Dict[str, Any]]:
    """Read every input from Postgres and assemble the day's dim rows."""
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        cur = conn.cursor()
        plants = _fetch(cur, _PLANTS_SQL)
        data_sources = _fetch(cur, _DATA_SOURCES_SQL)
        devices = _fetch(cur, _DEVICES_SQL)
        bess_assets = _fetch(cur, _BESS_ASSETS_SQL)
        cur.close()
    finally:
        conn.close()
    return build_dim_rows(day, plants, data_sources, devices, bess_assets)


# ---------------------------------------------------------------------------
# Write + register
# ---------------------------------------------------------------------------


def _arrow_table(rows: Sequence[Dict[str, Any]]):
    import pyarrow as pa

    schema = pa.schema(
        [
            ("dt", pa.date32()),
            ("connection_id", pa.string()),
            ("plant_ext_id", pa.string()),
            ("device_ext_id", pa.string()),
            ("device_type", pa.string()),
            ("plant_id", pa.string()),
            ("plant_slug", pa.string()),
            ("country", pa.string()),
            ("currency", pa.string()),
            ("resolution", pa.string()),
            ("canonical_device_id", pa.string()),
            ("device_grain", pa.string()),
            ("asset_token", pa.string()),
            ("unit_no", pa.int32()),
            ("rack_no", pa.int32()),
            ("module_no", pa.int32()),
            ("cell_no", pa.int32()),
            ("bess_asset_id", pa.string()),
            ("asset_match", pa.string()),
            ("asset_external_id", pa.string()),
            ("asset_name", pa.string()),
            ("chemistry", pa.string()),
            ("nominal_capacity_kwh", pa.float64()),
            ("nominal_power_kw", pa.float64()),
            ("rack_count", pa.int32()),
            ("module_count", pa.int32()),
        ]
    )
    columns = {name: [] for name in DIM_COLUMNS}
    for row in rows:
        for name in DIM_COLUMNS:
            columns[name].append(row.get(name))
    # dt arrives as an ISO string; date32 keeps it a real date in the file, so a
    # reader that never saw the path still knows the snapshot day.
    columns["dt"] = [
        datetime.strptime(v, "%Y-%m-%d").date() if isinstance(v, str) else v
        for v in columns["dt"]
    ]
    return pa.Table.from_pydict(columns, schema=schema)


def write_snapshot(rows: Sequence[Dict[str, Any]], day: str, destination: str) -> str:
    """Write the day's snapshot Parquet. ``destination`` is an s3:// URI or a path."""
    import pyarrow.parquet as pq

    table = _arrow_table(rows)
    key = f"{destination.rstrip('/')}/dt={day}/part-0.parquet"

    if key.startswith("s3://"):
        from pyarrow.fs import FileSystem

        fs, path = FileSystem.from_uri(key)
        pq.write_table(table, path, filesystem=fs, compression="zstd")
    else:
        Path(key).parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, key, compression="zstd")
    return key


def main() -> int:
    from dotenv import load_dotenv

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--day", help="snapshot day (YYYY-MM-DD, default today UTC)")
    parser.add_argument("--bucket", default=os.environ.get("LAKE_BUCKET", "nuravolt-lake"))
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--out", help="write to this local directory instead of S3")
    parser.add_argument("--no-register", action="store_true",
                        help="write the Parquet but skip the Iceberg registration")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be exported and write nothing")
    args = parser.parse_args()

    load_dotenv(PROJECT_ROOT / ".env")
    day = args.day or datetime.now(timezone.utc).date().isoformat()
    datetime.strptime(day, "%Y-%m-%d")  # fail fast on a malformed --day

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    rows = fetch_snapshot(dsn, day)
    by_resolution: Dict[str, int] = {}
    for row in rows:
        by_resolution[row["resolution"]] = by_resolution.get(row["resolution"], 0) + 1
    canonical = sum(1 for row in rows if row["canonical_device_id"])
    with_asset = sum(1 for row in rows if row["bess_asset_id"])

    print(f"device_map {day}: {len(rows)} devices")
    for name in sorted(by_resolution):
        print(f"  {name}: {by_resolution[name]}")
    print(f"  canonical BESS ids: {canonical}  (matched to an asset: {with_asset})")

    if args.dry_run:
        for row in rows[:3]:
            print("  sample:", {k: row[k] for k in
                                ("connection_id", "device_ext_id", "plant_slug",
                                 "resolution", "device_grain")})
        print("[dry-run] nothing written")
        return 0

    if not rows:
        print("No devices to export. Nothing written (an empty dim would erase the join).")
        return 0

    destination = args.out or f"s3://{args.bucket}/{args.prefix}"
    key = write_snapshot(rows, day, destination)
    print(f"wrote {key}")

    if args.no_register:
        return 0

    from nuravolt.lake.register import register_day

    outcome = register_day(TABLE_ID, key, day=day, partition_col="dt")
    print(f"{TABLE_ID}: {outcome.status} ({outcome.detail})")
    return 0 if outcome.status != "fail" else 1


if __name__ == "__main__":
    sys.exit(main())
