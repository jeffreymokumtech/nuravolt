"""Daily partition registration must never double a day.

``bronze.live_readings`` grows one partition per night forever, so registration
is an append, not a rebuild. An append that runs twice would double that day's
rows, and a doubled megawatt-hour is a wrong number rather than a slow query.
These tests pin the partition-level idempotency, the replace path, and the
nanosecond cast Iceberg requires.

No AWS: LAKE_ENV stays dev, so the catalog is SQLite over a temp directory and
the parts are read from a local tree shaped like the bucket.
"""

import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from scripts.lake_compact_bronze import LocalStore, run as compact_run  # noqa: E402
from tests.lake.test_compact_bronze import CONN, DAY, seed_landing_zone  # noqa: E402


@pytest.fixture()
def dev_lake(tmp_path, monkeypatch):
    """A throwaway local Iceberg warehouse, isolated per test."""
    monkeypatch.setenv("LAKE_ENV", "dev")
    monkeypatch.setenv("LAKE_WAREHOUSE", str(tmp_path / "warehouse"))
    for module in ("nuravolt.lake", "nuravolt.lake.catalog", "nuravolt.lake.register"):
        sys.modules.pop(module, None)
    from nuravolt.lake import register as register_module

    return register_module


def seed_and_compact(tmp_path, day=DAY, polls=3):
    expected = seed_landing_zone(tmp_path, polls=polls, day=day)
    compact_run(LocalStore(tmp_path), days=[day])
    return expected


def test_registers_a_compacted_day(dev_lake, tmp_path):
    expected = seed_and_compact(tmp_path)

    outcome = dev_lake.register_days(
        dev_lake.LIVE_READINGS, [DAY], bucket="unused", root=str(tmp_path)
    )[0]

    assert outcome.status == "ok"
    assert outcome.rows == expected
    assert outcome.parts == 1

    from nuravolt import lake

    assert lake.read_table("bronze.live_readings", columns="count(*) AS n")["n"][0] == expected


def test_second_run_skips_an_already_registered_day(dev_lake, tmp_path):
    expected = seed_and_compact(tmp_path)
    kwargs = dict(bucket="unused", root=str(tmp_path))

    first = dev_lake.register_days(dev_lake.LIVE_READINGS, [DAY], **kwargs)[0]
    second = dev_lake.register_days(dev_lake.LIVE_READINGS, [DAY], **kwargs)[0]

    assert first.status == "ok"
    assert second.status == "skip"
    assert "already registered" in second.detail

    from nuravolt import lake

    assert lake.read_table("bronze.live_readings", columns="count(*) AS n")["n"][0] == expected


def test_replace_day_rebuilds_exactly_one_day(dev_lake, tmp_path):
    day_one = seed_and_compact(tmp_path, day="2026-07-19", polls=2)
    day_two = seed_and_compact(tmp_path, day="2026-07-20", polls=3)
    kwargs = dict(bucket="unused", root=str(tmp_path))

    dev_lake.register_days(dev_lake.LIVE_READINGS, ["2026-07-19", "2026-07-20"], **kwargs)
    outcome = dev_lake.register_days(
        dev_lake.LIVE_READINGS, ["2026-07-20"], replace_day=True, **kwargs
    )[0]

    assert outcome.status == "ok"

    from nuravolt import lake

    total = lake.read_table("bronze.live_readings", columns="count(*) AS n")["n"][0]
    assert total == day_one + day_two


def test_a_day_with_no_parts_is_a_skip_not_a_failure(dev_lake, tmp_path):
    seed_and_compact(tmp_path)

    outcome = dev_lake.register_days(
        dev_lake.LIVE_READINGS, ["2026-01-01"], bucket="unused", root=str(tmp_path)
    )[0]

    assert outcome.status == "skip"
    assert "no parts" in outcome.detail


def test_dry_run_registers_nothing(dev_lake, tmp_path):
    seed_and_compact(tmp_path)

    outcome = dev_lake.register_days(
        dev_lake.LIVE_READINGS, [DAY], bucket="unused", root=str(tmp_path), dry_run=True
    )[0]

    assert outcome.status == "dry-run"

    from nuravolt import lake

    assert not lake.table_exists("bronze.live_readings")


def test_nanosecond_timestamps_are_cast_not_rejected(dev_lake, tmp_path):
    """DuckDB emits ns happily; Iceberg is us. The registrar must bridge that."""
    part = tmp_path / "bronze" / "compact" / "live" / f"dt={DAY}" / "connection_id=c" / "part-0.parquet"
    part.parent.mkdir(parents=True)
    pq.write_table(
        pa.table(
            {
                "ts": pa.array([0, 1, 2], type=pa.timestamp("ns")),
                "value": pa.array([1.0, 2.0, 3.0]),
                "dt": pa.array([DAY] * 3, type=pa.string()),
                "connection_id": pa.array(["c"] * 3, type=pa.string()),
            }
        ),
        part,
    )

    outcome = dev_lake.register_days(
        dev_lake.LIVE_READINGS, [DAY], bucket="unused", root=str(tmp_path)
    )[0]

    assert outcome.status == "ok", outcome.detail
    assert outcome.rows == 3


def test_multiple_connections_land_in_one_partition(dev_lake, tmp_path):
    other = "99999999-8888-7777-6666-555555555555"
    rows_a = seed_landing_zone(tmp_path, polls=2, day=DAY, conn=CONN)
    rows_b = seed_landing_zone(tmp_path, polls=4, day=DAY, conn=other)
    compact_run(LocalStore(tmp_path), days=[DAY])

    outcome = dev_lake.register_days(
        dev_lake.LIVE_READINGS, [DAY], bucket="unused", root=str(tmp_path)
    )[0]

    assert outcome.parts == 2
    assert outcome.rows == rows_a + rows_b

    from nuravolt import lake

    connections = lake.read_table(
        "bronze.live_readings", columns="DISTINCT connection_id"
    )["connection_id"].tolist()
    assert sorted(connections) == sorted([CONN, other])


def test_specs_cover_both_bronze_tables(dev_lake):
    assert set(dev_lake.SPECS) == {"bronze.live_readings", "bronze.dim_device_map"}
    assert dev_lake.LIVE_READINGS.day_prefix("2026-07-20") == "bronze/compact/live/dt=2026-07-20"
    assert dev_lake.DEVICE_MAP.day_prefix("2026-07-20") == "bronze/dim/device_map/dt=2026-07-20"
