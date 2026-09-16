#!/usr/bin/env python3
"""Publish a dbt gold table from the lake into Postgres analysis_results.

The medallion lake (bronze -> dbt silver/gold on S3) is the analytical source of
truth, but the app reads Postgres (there is no DuckDB-on-Vercel reader). This is
the missing "gold -> serving" seam (docs/ARCHITECTURE.md gap #1): read a gold
Parquet via DuckDB and upsert its rows into analysis_results long format, so the
existing app read path (src/lib/db/timeseries.ts::queryAnalysisResults) serves
lake-computed analytics unchanged.

Generic + idempotent: each publish is scoped to one (plant, domain,
model_version) and deletes that scope before writing, so reruns are exact
replacements and rollback is a single DELETE.

Example — publish the per-device twin gold once Phase 3 emits it:
    python -m nuravolt.lake.publish \
        --plant ribera-solar \
        --gold s3://nuravolt-lake/gold/device_twin_daily.parquet \
        --domain digitaltwin --model-version gold-twin-v1 \
        --time-col day --device-col device_id \
        --metrics '{"mppt_voltage_predicted":"mppt_voltage_predicted", ...}' \
        --provenance modelled --basis "hybrid twin, daily rollup" \
        [--dry-run]

The contract every published metric must satisfy is the one the drill-down route
reads (src/app/api/digitaltwin/[plantId]/parquet-query/route.ts): device_id like
"INV X.Y[.MPPT-k|.STR-k]", metric "{base}_{predicted|actual|residual}".

Every row carries its provenance in analysis_results.metadata, because the
drill-down captions read it off the row
(src/app/api/bess/plants/[plantId]/telemetry-query/route.ts). Untagged rows
report provenance null and the caption silently degrades to a model version,
which tells an operator nothing about whether the number was measured or
modelled.
"""

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, time as dtime
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from nuravolt.db.writer import TimeseriesWriter  # noqa: E402
from nuravolt.lake.duck import duckdb_s3  # noqa: E402

# The vocabulary the UI captions understand. "measured" means the number came
# from telemetry the plant actually reported; "modelled" from a twin or a
# forecast; "declared" from a datasheet or a contract; "benchmark" from a public
# reference dataset. Anything outside this set would render as an unexplained
# word next to a number, so argparse refuses it.
PROVENANCE_CHOICES = ("measured", "modelled", "declared", "benchmark")


def build_metadata(provenance: str, basis: str, gold_path: str, model_version: str) -> dict:
    """The per-row provenance stamp.

    Deliberately four short keys. This JSONB is stored on EVERY row, and a year
    of rack gold is tens of thousands of rows per plant (metrics x racks x days),
    so each extra key is measured in megabytes of table. Measured at 133 bytes
    for the nightly BESS publish; a fifth key with a long value doubles that.
    Keep new keys short, or put them somewhere written once per run instead of
    once per row.

    Returned once per publish and shared by reference across records: the writer
    only serialises it, never mutates it.
    """
    if provenance not in PROVENANCE_CHOICES:
        raise ValueError(f"unknown provenance {provenance!r}; expected one of {PROVENANCE_CHOICES}")
    meta = {"provenance": provenance, "gold": gold_path, "model_version": model_version}
    if basis:
        meta["basis"] = basis
    return meta


def _duckdb_s3():
    """The shared lake reader connection (nuravolt/lake/duck.py)."""
    return duckdb_s3(secret_name="nuravolt_publish")


def _as_timestamp(v):
    """Gold time column may be a DATE or a TIMESTAMP; normalize to a datetime at
    UTC midnight for DATEs so analysis_daily buckets cleanly."""
    if isinstance(v, datetime):
        return v
    return datetime.combine(v, dtime.min)


def _read_gold(gold_path: str, cols: set) -> tuple:
    """Read the requested columns out of a gold table.

    ``gold_path`` may be a single object, a directory, or a glob. dbt writes
    partitioned gold (``PARTITION_BY (day)``) as a directory tree, so a bare
    path needs the recursive glob appended or read_parquet sees nothing.
    """
    target = gold_path
    if not target.endswith((".parquet", "*")):
        target = target.rstrip("/") + "/**/*.parquet"

    con = _duckdb_s3()
    select = ", ".join(sorted(cols))
    # hive_partitioning=false: the partition columns are written into the files
    # themselves, so the path tokens would otherwise shadow them as VARCHAR.
    source = f"read_parquet('{target}', hive_partitioning=false)"
    try:
        described = con.execute(f"DESCRIBE SELECT {select} FROM {source}").fetchall()
        rows = con.execute(f"SELECT {select} FROM {source}").fetchall()
    finally:
        con.close()
    return rows, {c: i for i, c in enumerate(d[0] for d in described)}


def _resolve_plant_ids(cur, refs) -> dict:
    """Map slug-or-uuid -> Plant.id for every distinct reference in one query."""
    wanted = sorted({str(r) for r in refs if r is not None})
    if not wanted:
        return {}
    cur.execute(
        'SELECT id, slug FROM "Plant" WHERE slug = ANY(%s) OR id::text = ANY(%s)',
        (wanted, wanted),
    )
    resolved = {}
    for plant_id, slug in cur.fetchall():
        resolved[str(plant_id)] = str(plant_id)
        if slug:
            resolved[slug] = str(plant_id)
    return resolved


def _run_id_for(domain: str, model_version: str, plant_id: str) -> uuid.UUID:
    """Deterministic run_id so a rerun upserts in place.

    The unique index is (time, plant_id, COALESCE(device_id,''), domain, metric,
    COALESCE(run_id,'000...')). Leaving run_id NULL puts every model_version in
    the same all-zeros bucket, so two model_versions of the same metric collide
    and silently overwrite each other. Deriving it from the scope keeps each
    model_version in its own lane while staying stable across reruns.
    """
    return uuid.uuid5(uuid.NAMESPACE_URL, f"nuravolt:publish:{domain}:{model_version}:{plant_id}")


def publish(
    dsn: str,
    plant_ref: str,
    gold_path: str,
    domain: str,
    model_version: str,
    metrics: dict,
    time_col: str = "day",
    device_col: str = "inverter_id",
    plant_col: str = None,
    dry_run: bool = False,
    provenance: str = "measured",
    basis: str = None,
) -> int:
    """Publish a gold table into analysis_results.

    With ``plant_col`` the gold file carries its own plant column and one
    invocation fans out across the whole fleet. Without it every row is
    attributed to ``plant_ref``, so never point a multi-plant gold file at a
    single ``--plant``: it would file the entire fleet under one plant.

    ``provenance`` / ``basis`` describe where the published numbers came from
    and ride along on every row (see ``build_metadata``). The default says
    "measured" because the seam exists to serve lake gold, which is aggregated
    from reported telemetry; a modelled gold table must say so explicitly.
    """
    metadata = build_metadata(provenance, basis, gold_path, model_version)
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()

    wanted = {time_col, device_col, *metrics.keys()}
    if plant_col:
        wanted.add(plant_col)
    rows, col_index = _read_gold(gold_path, wanted)

    if plant_col:
        plant_map = _resolve_plant_ids(cur, {r[col_index[plant_col]] for r in rows})
    else:
        plant_map = _resolve_plant_ids(cur, [plant_ref])
        if plant_ref not in plant_map:
            conn.close()
            sys.exit(f"plant not found: {plant_ref}")

    # plant_id -> records, so each plant's scope is replaced independently.
    by_plant = {}
    unresolved = set()
    for r in rows:
        ref = str(r[col_index[plant_col]]) if plant_col else plant_ref
        plant_id = plant_map.get(ref)
        if not plant_id:
            unresolved.add(ref)
            continue
        ts = _as_timestamp(r[col_index[time_col]])
        device_id = str(r[col_index[device_col]])
        bucket = by_plant.setdefault(plant_id, [])
        for gold_col, metric_name in metrics.items():
            val = r[col_index[gold_col]]
            if val is None:
                continue
            bucket.append(
                {
                    "time": ts,
                    "device_id": device_id,
                    "metric": metric_name,
                    "value": float(val),
                    # One shared dict, not a per-row copy: identical for the
                    # whole publish and read-only downstream.
                    "metadata": metadata,
                }
            )

    total = sum(len(v) for v in by_plant.values())
    n_devices = len({rec["device_id"] for v in by_plant.values() for rec in v})
    print(
        f"{len(by_plant)} plant(s): {total} rows across {n_devices} devices "
        f"from {gold_path} -> analysis_results({domain}, {model_version}) "
        f"[provenance={provenance}]"
    )
    if unresolved:
        # Loud, never silent: an unmatched plant reference means real gold rows
        # were dropped on the floor.
        print(f"  WARNING: {len(unresolved)} unresolved plant reference(s) skipped: "
              f"{sorted(unresolved)[:5]}")

    if dry_run:
        for v in by_plant.values():
            for rec in v[:3]:
                print("  sample:", rec)
            break
        print(f"[dry-run] would delete + upsert {total} rows")
        conn.close()
        return 0

    written_total = 0
    for plant_id, records in by_plant.items():
        run_id = _run_id_for(domain, model_version, plant_id)
        # Delete-first per (plant, domain, model_version): exact replacement + easy rollback.
        cur.execute(
            "DELETE FROM analysis_results WHERE plant_id = %s::uuid AND domain = %s AND model_version = %s",
            (plant_id, domain, model_version),
        )
        conn.commit()
        with TimeseriesWriter(dsn=dsn) as writer:
            written_total += writer.write_analysis_results(
                plant_id, domain, records, model_version=model_version, run_id=str(run_id)
            )
    conn.close()
    print(f"upserted {written_total} rows tagged {model_version}")
    return written_total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--plant",
        help="plant slug or uuid; attributes every row to this plant. Omit when --plant-col is set.",
    )
    ap.add_argument(
        "--plant-col",
        help="gold column holding the plant slug or uuid, so one file fans out across the fleet",
    )
    ap.add_argument(
        "--gold",
        required=True,
        help="s3://bucket/gold/name.parquet, or a partitioned directory / glob",
    )
    ap.add_argument("--domain", default="digitaltwin")
    ap.add_argument("--model-version", required=True)
    ap.add_argument("--time-col", default="day")
    ap.add_argument("--device-col", default="inverter_id")
    ap.add_argument(
        "--metrics",
        required=True,
        help='JSON map of gold column -> analysis_results metric name, e.g. \'{"daily_kwh":"energy_daily_kwh"}\'',
    )
    ap.add_argument(
        "--provenance",
        default="measured",
        choices=PROVENANCE_CHOICES,
        help="what these numbers are, stamped on every row and read by the drill-down captions",
    )
    ap.add_argument(
        "--basis",
        help="short free-text note on how the values were derived, e.g. 'BMS rack telemetry, daily rollup'",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.plant and not args.plant_col:
        sys.exit("pass --plant (single plant) or --plant-col (fan out across the fleet)")

    load_dotenv(PROJECT_ROOT / ".env")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL not set")

    metrics = json.loads(args.metrics)
    if not isinstance(metrics, dict) or not metrics:
        sys.exit("--metrics must be a non-empty JSON object")

    publish(
        dsn=dsn,
        plant_ref=args.plant,
        gold_path=args.gold,
        domain=args.domain,
        model_version=args.model_version,
        metrics=metrics,
        time_col=args.time_col,
        device_col=args.device_col,
        plant_col=args.plant_col,
        dry_run=args.dry_run,
        provenance=args.provenance,
        basis=args.basis,
    )


if __name__ == "__main__":
    main()
