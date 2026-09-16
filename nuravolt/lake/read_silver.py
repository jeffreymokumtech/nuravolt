"""Read one day of ``silver_bess_telemetry`` for the imbalance engine.

WHY NOT ``gold_bess_rack_daily``
--------------------------------

Someone will try it, because it is the table whose name has "rack" in it. It is
the wrong source, and the way it is wrong renders like a finding.

``gold_bess_rack_daily`` is (rack, day) grain and already collapsed to a day's
max and min. That collapse destroys the three things
``nuravolt.bess.imbalance.analyze_imbalance`` needs:

  the timestamp axis     the dwell scan asks whether a rack sat outside its
                         siblings for 30 sustained minutes. One point per day
                         cannot answer that; "sustained" stops meaning anything.
  simultaneous siblings  the modified z score compares racks *at one instant*.
                         Comparing daily envelopes compares racks that were
                         never in the same operating state.
  within rack members    the spread is max minus min across a rack's own
                         members at one instant. A daily envelope is neither.

Fed the gold, the engine would still return numbers, with units, in the right
shape, on a panel captioned "rack imbalance". They would be a comparison of
daily envelopes wearing the clothes of an instantaneous spread.

``silver_bess_telemetry`` is the only artefact with all three properties:
sub daily, per device, per metric, in canonical units, already carrying
``rack_device_id``, ``device_grain`` and the parsed unit / rack / module / cell
numbers. And it is the only possible source at all, because real rack telemetry
never lands in Postgres: the poller writes bronze Parquet to S3, and the
``measurements`` table is fed only by the ingest route and the PV paths.

Per day by design
-----------------

One day of a 16 rack asset at 15 minute cadence with four extremes is roughly
six thousand rows: trivial. A year is roughly two million, which is not, and
which would also be wrong (see the timestamp axis above: the engine's report is
per asset per day). So the API takes one day and callers loop.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from nuravolt.lake.duck import duckdb_for_path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

#: dbt writes this model to ``<layer>/<name>`` (dbt_project/macros/lake_location.sql).
SILVER_BESS_TELEMETRY = "silver/bess_telemetry"

#: The columns the rack sample adapter reads, plus the asset id so a caller that
#: scoped only to a plant can still tell two batteries apart.
SILVER_COLUMNS: Tuple[str, ...] = (
    "rack_device_id",
    "canonical_device_id",
    "device_grain",
    "ts",
    "metric",
    "value_canonical",
    "bess_asset_id",
)


class SilverUnavailable(RuntimeError):
    """The silver table, or that day's partition of it, could not be read.

    Not the same as "that day has no rack telemetry", which is an empty list.
    A caller must be able to tell an unbuilt lake from a quiet battery, because
    only one of those is a fact about the battery.
    """


def default_silver_path(name: str = SILVER_BESS_TELEMETRY) -> str:
    """Where this model lands, mirroring ``lake_location`` fail safe by default.

    Only an explicitly non dev ``LAKE_ENV`` reads the S3 lake. Every other value
    (unset, dev, a typo) reads the local dbt dev root, so running an analysis on
    a laptop cannot silently pull production objects. ``LAKE_DEV_ROOT`` is
    resolved against the repo root because that is the directory dbt is invoked
    from (``dbt build --project-dir dbt_project``).
    """
    override = os.environ.get("SILVER_BESS_TELEMETRY_PATH")
    if override:
        return override
    if os.environ.get("LAKE_ENV", "dev") == "dev":
        root = Path(os.environ.get("LAKE_DEV_ROOT", "dev_lake"))
        if not root.is_absolute():
            root = PROJECT_ROOT / root
        return str(root / name)
    bucket = os.environ.get("LAKE_BUCKET", "nuravolt-lake")
    return f"s3://{bucket}/{name}"


def day_target(silver_path: str, day: date) -> str:
    """The glob for exactly one day's partition.

    Silver is partitioned by ``day``, so this never scans the table. A caller
    that has already pinned an object or a glob keeps it.
    """
    base = str(silver_path).rstrip("/")
    if base.endswith(".parquet") or base.endswith("*"):
        return base
    return f"{base}/day={day.isoformat()}/**/*.parquet"


def _rack_metrics() -> Tuple[str, ...]:
    """The canonical metrics the pivot adapter understands.

    Derived from the adapter's own tables rather than restated here, so adding a
    metric there cannot leave this filter quietly dropping it in SQL. Metrics
    the adapter deliberately refuses (pack voltage) are excluded on purpose:
    they would be fetched only to be counted, and the "what IS in silver"
    diagnostic below reports them without a filter anyway.
    """
    from nuravolt.bess.rack_samples import (
        CHILD_METRICS,
        EXTREME_MEMBERS,
        RACK_SCALAR_METRICS,
    )

    return tuple(sorted(set(CHILD_METRICS) | set(EXTREME_MEMBERS) | set(RACK_SCALAR_METRICS)))


def _scope(plant_id: Optional[str], bess_asset_id: Optional[str]) -> Tuple[List[str], List[Any]]:
    clauses: List[str] = []
    params: List[Any] = []
    if plant_id:
        clauses.append("cast(plant_id as varchar) = ?")
        params.append(str(plant_id))
    if bess_asset_id:
        clauses.append("cast(bess_asset_id as varchar) = ?")
        params.append(str(bess_asset_id))
    return clauses, params


def _query(target: str, sql: str, params: List[Any]) -> List[tuple]:
    con = duckdb_for_path(target)
    try:
        return con.execute(sql, params).fetchall()
    except Exception as exc:  # noqa: BLE001 - translated, never swallowed
        base = target.split("/day=", 1)[0]
        if not target.startswith("s3://") and not Path(base).exists():
            raise SilverUnavailable(
                f"silver_bess_telemetry is not built at {base}. "
                "Run the dbt silver models, or point SILVER_BESS_TELEMETRY_PATH at a built copy."
            ) from exc
        raise SilverUnavailable(f"cannot read {target}: {exc}") from exc
    finally:
        con.close()


def read_bess_rack_samples(
    day: date,
    *,
    plant_id: Optional[str] = None,
    bess_asset_id: Optional[str] = None,
    silver_path: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """One day of rack grain silver rows, ready for ``rack_samples_from_silver``.

    Rows with no ``rack_device_id`` are asset or unit grain and have no rack to
    belong to. Rows with a null ``value_canonical`` are ones silver could not
    convert out of their reported unit, and an unconvertible value is not a
    zero. Both are filtered in SQL rather than fetched and dropped.

    Raises ``SilverUnavailable`` when the table or that day's partition cannot
    be read. An empty list means the day was readable and held no rack rows,
    which is a different statement and callers must be able to tell them apart.
    """
    target = day_target(silver_path or default_silver_path(), day)
    metrics = _rack_metrics()

    clauses = [
        "rack_device_id is not null",
        "value_canonical is not null",
        "metric in (" + ", ".join(["?"] * len(metrics)) + ")",
    ]
    params: List[Any] = list(metrics)
    scope_clauses, scope_params = _scope(plant_id, bess_asset_id)
    clauses += scope_clauses
    params += scope_params

    # hive_partitioning=false: the partition column is written into the files
    # themselves (write_partition_columns), so the path token would otherwise
    # shadow it as VARCHAR.
    sql = (
        f"SELECT {', '.join(SILVER_COLUMNS)} "
        f"FROM read_parquet('{target}', hive_partitioning=false) "
        f"WHERE {' AND '.join(clauses)} "
        "ORDER BY ts, rack_device_id, canonical_device_id, metric"
    )
    rows = _query(target, sql, params)
    return [dict(zip(SILVER_COLUMNS, r)) for r in rows]


def silver_metric_names(
    day: date,
    *,
    plant_id: Optional[str] = None,
    bess_asset_id: Optional[str] = None,
    silver_path: Optional[str] = None,
) -> Dict[str, int]:
    """Diagnostic: every metric name present that day, with its row count.

    Deliberately unfiltered by the adapter's vocabulary. A run that read the
    right partition and still found nothing is almost always a metric name
    mismatch, and the fastest way to see it is the list of names that ARE there
    next to the list the adapter knows.
    """
    target = day_target(silver_path or default_silver_path(), day)
    clauses = ["metric is not null"]
    scope_clauses, params = _scope(plant_id, bess_asset_id)
    clauses += scope_clauses
    sql = (
        "SELECT metric, count(*) FROM "
        f"read_parquet('{target}', hive_partitioning=false) "
        f"WHERE {' AND '.join(clauses)} GROUP BY 1 ORDER BY 1"
    )
    return {str(metric): int(n) for metric, n in _query(target, sql, params)}
