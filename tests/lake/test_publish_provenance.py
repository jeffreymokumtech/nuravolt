"""Published rows must carry their own provenance.

The BESS drill-down captions a series with ``metadata.provenance`` read off the
newest published row (src/app/api/bess/plants/[plantId]/telemetry-query/
route.ts). Before this stamp existed, publish.py never wrote a metadata column,
so provenance came back null on every lake-published series and the caption fell
back to a model version string, which tells an operator nothing about whether a
number was measured or modelled.

These tests pin the stamp end to end through ``publish(dry_run=True)``: no S3
(``_read_gold`` is faked) and no database (psycopg2 is faked), so they assert
the record construction, not the network.
"""

import json
import sys
from datetime import date, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from nuravolt.lake import publish as publish_mod  # noqa: E402
from nuravolt.lake.publish import PROVENANCE_CHOICES, build_metadata, publish  # noqa: E402

PLANT_UUID = "22222222-2222-2222-2222-222222222222"
GOLD = "s3://nuravolt-lake/gold/bess_rack_daily/*/*.parquet"
MODEL_VERSION = "gold-bess-rack-daily-v1"


# ---------------------------------------------------------------------------
# Fakes: one gold row per day, one resolvable plant, no I/O of any kind.
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        # _resolve_plant_ids: (id, slug)
        return [(PLANT_UUID, "athi-storage")]


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.closed = False

    def cursor(self):
        return self.cur

    def commit(self):
        pass

    def close(self):
        self.closed = True


@pytest.fixture
def fake_gold(monkeypatch):
    """Two days x one rack x two metrics = four records."""
    rows = [
        (date(2026, 7, 20), "BESS athi-1.U-0.R-3", "athi-storage", 31.4, 2.1),
        (date(2026, 7, 21), "BESS athi-1.U-0.R-3", "athi-storage", 33.0, 2.4),
    ]
    col_index = {"day": 0, "device_id": 1, "plant_id": 2, "temp_cell_max_c": 3, "temp_spread_c": 4}

    def _fake_read_gold(gold_path, cols):
        return rows, col_index

    monkeypatch.setattr(publish_mod, "_read_gold", _fake_read_gold)
    monkeypatch.setattr(publish_mod.psycopg2, "connect", lambda dsn: _FakeConn())
    return rows


def _capture_records(monkeypatch):
    """Intercept the records publish() would hand the dry-run printer."""
    seen = {}
    real_build = publish_mod.build_metadata

    def _spy(provenance, basis, gold_path, model_version):
        meta = real_build(provenance, basis, gold_path, model_version)
        seen["metadata"] = meta
        return meta

    monkeypatch.setattr(publish_mod, "build_metadata", _spy)
    return seen


METRICS = {"temp_cell_max_c": "temp_cell_max_c", "temp_spread_c": "temp_spread_c"}


def _publish(**kwargs):
    params = dict(
        dsn="postgresql://fake/fake",
        plant_ref=None,
        gold_path=GOLD,
        domain="bess",
        model_version=MODEL_VERSION,
        metrics=METRICS,
        time_col="day",
        device_col="device_id",
        plant_col="plant_id",
        dry_run=True,
    )
    params.update(kwargs)
    return publish(**params)


# ---------------------------------------------------------------------------
# The stamp itself
# ---------------------------------------------------------------------------


def test_dry_run_sample_carries_provenance(fake_gold, capsys):
    """The printed sample is what would be written; it must show provenance."""
    _publish(provenance="measured")
    out = capsys.readouterr().out

    assert "sample:" in out
    sample_lines = [ln for ln in out.splitlines() if "sample:" in ln]
    assert sample_lines, "dry-run printed no sample record"
    for line in sample_lines:
        assert "'provenance': 'measured'" in line
    # The summary line names it too, so a nightly log says what it published.
    assert "[provenance=measured]" in out


def test_every_record_is_stamped(fake_gold, monkeypatch):
    """Not just the sample: the metadata dict reaches record construction."""
    seen = _capture_records(monkeypatch)
    _publish(provenance="measured", basis="BMS rack telemetry, daily rollup")

    meta = seen["metadata"]
    assert meta["provenance"] == "measured"
    assert meta["basis"] == "BMS rack telemetry, daily rollup"
    assert meta["gold"] == GOLD
    assert meta["model_version"] == MODEL_VERSION


def test_metadata_stays_small():
    """Four short keys, because this is stored on every single row."""
    meta = build_metadata("measured", "BMS rack telemetry, daily rollup", GOLD, MODEL_VERSION)
    assert set(meta) == {"provenance", "basis", "gold", "model_version"}
    # A year of rack gold is tens of thousands of rows per plant; a stamp that
    # grows past a couple of hundred bytes is measured in megabytes of table.
    assert len(json.dumps(meta)) < 256


def test_basis_is_omitted_when_absent():
    meta = build_metadata("modelled", None, GOLD, MODEL_VERSION)
    assert "basis" not in meta
    assert meta["provenance"] == "modelled"


@pytest.mark.parametrize("provenance", PROVENANCE_CHOICES)
def test_every_declared_provenance_is_accepted(provenance):
    assert build_metadata(provenance, None, GOLD, MODEL_VERSION)["provenance"] == provenance


def test_unknown_provenance_is_refused():
    """An unrecognised word would render as an unexplained caption."""
    with pytest.raises(ValueError):
        build_metadata("probably-fine", None, GOLD, MODEL_VERSION)


def test_records_keep_their_shape(fake_gold, capsys):
    """Metadata is additive: time / device_id / metric / value are untouched."""
    _publish(provenance="measured")
    line = [ln for ln in capsys.readouterr().out.splitlines() if "sample:" in ln][0]
    for key in ("'time':", "'device_id':", "'metric':", "'value':", "'metadata':"):
        assert key in line
    assert "BESS athi-1.U-0.R-3" in line
    # A DATE gold column normalises to a UTC-midnight datetime, not a date.
    assert repr(datetime(2026, 7, 20, 0, 0)) in line
