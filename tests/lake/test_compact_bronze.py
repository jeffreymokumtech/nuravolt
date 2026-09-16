"""Bronze compaction must collapse the poll objects without changing the data.

The poller writes one Parquet object per poll for durability; at 15 minute
polling that is 96 objects per connection per day, and Iceberg planning degrades
badly at a million tiny files. These tests pin the three properties that make the
compaction safe to run unattended:

  1. many poll objects in, exactly one self-describing part out, same rows;
  2. the Hive tokens are BOTH in the path and in the file, so a part that lost
     its path still knows its day and connection;
  3. a drifted writer schema is refused, not silently compacted — registration
     types the whole Iceberg table from the first file it sees.

No AWS: the store abstraction runs against a directory tree shaped like the
bucket.
"""

import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from scripts.lake_compact_bronze import (  # noqa: E402
    LocalStore,
    SchemaDriftError,
    assert_writer_schema,
    compact_key,
    discover_connection_days,
    duckdb_connection,
    run,
)

CONN = "11111111-2222-3333-4444-555555555555"
DAY = "2026-07-20"


def writer_batch(n: int, start_ms: int) -> pa.Table:
    """A poll object in the exact schema of ParquetLakeWriter (s3-storage.ts)."""
    return pa.table(
        {
            "ts": pa.array([start_ms + i * 1000 for i in range(n)], type=pa.timestamp("ms")),
            "plant_ext_id": pa.array(["PLANT-A"] * n, type=pa.string()),
            "device_ext_id": pa.array([f"BESS athi-1.U-0.R-{i % 3}" for i in range(n)], type=pa.string()),
            "device_type": pa.array(["battery"] * n, type=pa.string()),
            "metric": pa.array(["bess_soc"] * n, type=pa.string()),
            "value": pa.array([50.0 + i for i in range(n)], type=pa.float64()),
            "unit": pa.array(["%"] * n, type=pa.string()),
        }
    )


def seed_landing_zone(root: Path, *, polls: int = 5, rows_per_poll: int = 4,
                      day: str = DAY, conn: str = CONN) -> int:
    day_dir = root / "bronze" / "live" / conn / day
    day_dir.mkdir(parents=True, exist_ok=True)
    for i in range(polls):
        epoch = 1_753_000_000_000 + i * 900_000
        pq.write_table(writer_batch(rows_per_poll, epoch), day_dir / f"{epoch}.parquet")
    return polls * rows_per_poll


def test_many_poll_objects_become_one_part(tmp_path):
    expected_rows = seed_landing_zone(tmp_path, polls=8, rows_per_poll=6)
    store = LocalStore(tmp_path)

    report = run(store, days=[DAY])

    assert [d.status for d in report.days] == ["ok"]
    result = report.days[0]
    assert result.source_objects == 8
    assert result.rows == expected_rows

    parts = sorted((tmp_path / "bronze" / "compact" / "live").rglob("*.parquet"))
    assert len(parts) == 1
    assert parts[0] == tmp_path / compact_key("bronze/compact/live", CONN, DAY)
    assert pq.read_metadata(parts[0]).num_rows == expected_rows


def test_part_is_self_describing(tmp_path):
    """dt and connection_id live in the file, not only in the path."""
    seed_landing_zone(tmp_path)
    run(LocalStore(tmp_path), days=[DAY])

    part = next((tmp_path / "bronze" / "compact" / "live").rglob("*.parquet"))
    # ParquetFile reads the footer only: no partition inference, which is exactly
    # the path lake.register_parquet takes.
    table = pq.ParquetFile(part).read()

    assert "dt" in table.column_names and "connection_id" in table.column_names
    assert set(table.column("connection_id").to_pylist()) == {CONN}
    assert {str(v) for v in table.column("dt").to_pylist()} == {DAY}

    # ...and the path still carries the Hive tokens, so a scan can prune.
    assert f"dt={DAY}" in str(part) and f"connection_id={CONN}" in str(part)


def test_timestamps_land_as_microseconds(tmp_path):
    """Iceberg is microsecond-precision; a nanosecond part would fail to register."""
    seed_landing_zone(tmp_path)
    run(LocalStore(tmp_path), days=[DAY])

    part = next((tmp_path / "bronze" / "compact" / "live").rglob("*.parquet"))
    ts_type = pq.read_schema(part).field("ts").type
    assert pa.types.is_timestamp(ts_type)
    assert ts_type.unit in ("us", "ms")


def test_rerun_is_idempotent(tmp_path):
    expected_rows = seed_landing_zone(tmp_path)
    store = LocalStore(tmp_path)

    run(store, days=[DAY])
    run(store, days=[DAY])

    parts = sorted((tmp_path / "bronze" / "compact" / "live").rglob("*.parquet"))
    assert len(parts) == 1
    assert pq.read_metadata(parts[0]).num_rows == expected_rows


def test_schema_drift_is_refused(tmp_path):
    """A renamed column must stop the run, not quietly re-type the bronze table."""
    seed_landing_zone(tmp_path, polls=2)
    day_dir = tmp_path / "bronze" / "live" / CONN / DAY
    drifted = writer_batch(2, 1_753_100_000_000).rename_columns(
        ["ts", "plant_ext_id", "device_ext_id", "device_type", "tag", "value", "unit"]
    )
    pq.write_table(drifted, day_dir / "9999999999999.parquet")

    report = run(LocalStore(tmp_path), days=[DAY])

    assert [d.status for d in report.days] == ["fail"]
    assert "drifted" in report.days[0].detail
    assert "tag" in report.days[0].detail
    assert not list((tmp_path / "bronze" / "compact" / "live").rglob("*.parquet"))
    assert report.failed == 1


def test_value_type_drift_is_refused(tmp_path):
    """A DOUBLE that becomes a string is drift even though the names all match."""
    day_dir = tmp_path / "bronze" / "live" / CONN / DAY
    day_dir.mkdir(parents=True)
    table = writer_batch(3, 1_753_000_000_000)
    stringy = table.set_column(
        table.schema.get_field_index("value"),
        "value",
        pa.array(["50.0", "51.0", "52.0"], type=pa.string()),
    )
    pq.write_table(stringy, day_dir / "1753000000000.parquet")

    report = run(LocalStore(tmp_path), days=[DAY])

    assert [d.status for d in report.days] == ["fail"]
    assert "VARCHAR" in report.days[0].detail


def test_schema_assertion_accepts_the_writer_schema(tmp_path):
    seed_landing_zone(tmp_path, polls=1)
    con = duckdb_connection(s3=False)
    try:
        glob = str(tmp_path / "bronze" / "live" / CONN / DAY / "*.parquet")
        assert_writer_schema(con, glob)  # must not raise
    finally:
        con.close()


def test_prune_keeps_the_retention_window(tmp_path):
    """Raw objects inside the window survive; older ones go once compacted."""
    from datetime import date

    old_day, fresh_day = "2026-07-01", "2026-07-20"
    seed_landing_zone(tmp_path, polls=3, day=old_day)
    seed_landing_zone(tmp_path, polls=3, day=fresh_day)
    store = LocalStore(tmp_path)

    run(store, prune=True, retain_days=7, today=date(2026, 7, 21))

    raw = tmp_path / "bronze" / "live" / CONN
    assert not list((raw / old_day).glob("*.parquet"))
    assert len(list((raw / fresh_day).glob("*.parquet"))) == 3
    assert len(list((tmp_path / "bronze" / "compact" / "live").rglob("*.parquet"))) == 2


def test_prune_will_not_delete_without_a_compacted_part(tmp_path):
    from datetime import date

    old_day = "2026-07-01"
    seed_landing_zone(tmp_path, polls=3, day=old_day)
    store = LocalStore(tmp_path)

    # dry-run writes no part, so the raw objects are the only copy that exists.
    run(store, prune=True, retain_days=7, today=date(2026, 7, 21), dry_run=True)

    assert len(list((tmp_path / "bronze" / "live" / CONN / old_day).glob("*.parquet"))) == 3


def test_discovery_ignores_non_day_directories(tmp_path):
    seed_landing_zone(tmp_path)
    (tmp_path / "bronze" / "live" / CONN / "_staging").mkdir()

    pairs = discover_connection_days(LocalStore(tmp_path), "bronze/live", None)

    assert pairs == [(CONN, DAY)]


def test_no_landing_zone_is_not_an_error(tmp_path):
    report = run(LocalStore(tmp_path), days=[DAY])
    assert report.days == []
    assert report.failed == 0
