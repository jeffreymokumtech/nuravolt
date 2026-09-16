"""
Tests for nuravolt.pipeline.bess_measured.materialize_measured_imbalance.

THE REGRESSION THIS FILE EXISTS FOR
-----------------------------------

`BESSIntelligencePipeline.load_rack_samples` had zero callers. `rack_samples`
initialised to `[]` and stayed there, so `calculate_state_of_safety` called
`analyze_imbalance(asset_id, [])`, so every sub asset availability came back
False with the "connect your BMS" wording. An operator whose BMS was already
streaming rack telemetry into the lake read that sentence and concluded the
platform could not see their racks.

`test_the_break_the_uncalled_loader` is the assertion that would have failed
before the caller existed, and `test_the_state_before_the_caller_existed` is the
same engine on the same day with the loader skipped, so the two sit next to each
other and the difference is one method call.

Everything here is offline. The silver reader, the artifact writer and the
database are all substituted, because what is under test is the wiring between
them: which day is read, whether the samples reach the engine, and what is
published (and refused) as a result.
"""

import json
from datetime import date, datetime, timedelta
from typing import Any, Dict, List

import pytest

from nuravolt.bess import rack_samples as rack_samples_mod
from nuravolt.bess.imbalance import SUB_ASSET_UNAVAILABLE, analyze_imbalance, imbalance_index
from nuravolt.bess.safety_artifact import (
    MEASURED_RACK_BASIS,
    MODELLED_BASIS,
    SAFETY_ARTIFACT_KIND,
    WINDOW_KEY_MEASURED,
)
from nuravolt.lake import read_silver as read_silver_mod
from nuravolt.lake.duck import DUCKDB_MISSING
from nuravolt.pipeline import bess_measured
from nuravolt.pipeline.bess_measured import materialize_measured_imbalance

PLANT = {"id": "3f2b1a00-0000-4000-8000-0000000000a1", "slug": "athi-storage",
         "name": "Athi Storage", "capacity_mw": 5.0, "country": "KE"}
ASSET_ID = "9c4e0011-0000-4000-8000-0000000000b2"
DAY = date(2026, 7, 20)
T0 = datetime(2026, 7, 20, 6, 0)

#: Seven racks running together and one 6 C hot, the same population shape as
#: tests/bess/test_imbalance.py, so a real finding falls out of the chain rather
#: than only an "it did not crash".
NORMAL_RACK_TEMPS_C = [28.0, 28.4, 27.8, 28.2, 28.1, 27.9, 28.3]
HOT_RACK_TEMP_C = 34.0

#: Five minute cadence over two hours. Cadence matters: the sustained scan needs
#: at least MIN_SAMPLES_IN_DWELL samples inside the 30 minute dwell window, and a
#: 15 minute feed gives it two, so a coarser fixture would report the dwell as
#: unresolvable and the availability assertion below would pass or fail for the
#: wrong reason.
CADENCE_MINUTES = 5
STEPS = 24


def silver_rows(day: date = DAY) -> List[Dict[str, Any]]:
    """One day of rack grain silver_bess_telemetry, as the reader returns it.

    Cell temperature max and min per rack: the shape a BMS that reports its
    edges rather than streaming every module actually sends.
    """
    start = datetime(day.year, day.month, day.day, 6, 0)
    rows: List[Dict[str, Any]] = []
    for step in range(STEPS):
        ts = start + timedelta(minutes=CADENCE_MINUTES * step)
        for i, mid in enumerate(NORMAL_RACK_TEMPS_C + [HOT_RACK_TEMP_C]):
            rack = f"BESS athi-1.U1.R{i + 1}"
            for metric, offset in (("bess_temp_cell_max", 0.6), ("bess_temp_cell_min", -0.6)):
                rows.append({
                    "rack_device_id": rack,
                    "canonical_device_id": rack,
                    "device_grain": "rack",
                    "ts": ts,
                    "metric": metric,
                    "value_canonical": mid + offset,
                    "bess_asset_id": ASSET_ID,
                })
    return rows


# --- Test doubles -----------------------------------------------------------


class FakeCursor:
    """Answers the queries this module runs, and is loud about any other.

    ``incumbent`` is the state-of-safety payload already stored for the plant,
    which the publisher reads to decide whether it may overwrite it. None means
    an empty slot, so the publish goes ahead.
    """

    def __init__(self, asset_ids: List[str], incumbent=None):
        self._asset_ids = asset_ids
        self._incumbent = incumbent
        self._rows: List[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql: str, params=None):
        if '"BessAsset"' in sql:
            self._rows = [(a,) for a in self._asset_ids]
        elif "analysis_results" in sql:
            self._rows = [("gold-bess-asset-daily-v1", "bess_soc")]
        elif '"AnalysisArtifact"' in sql:
            # The precedence read: measured telemetry outranks every other
            # publisher, so an empty slot here is the normal case for these
            # tests and the publish proceeds.
            self._rows = [(self._incumbent,)] if self._incumbent else []
        else:  # pragma: no cover - an unexpected query should be loud
            raise AssertionError(f"unexpected query: {sql}")

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    def __init__(self, asset_ids: List[str], incumbent=None):
        self.asset_ids = asset_ids
        self.incumbent = incumbent
        self.commits = 0

    def cursor(self, **kwargs):
        return FakeCursor(self.asset_ids, incumbent=self.incumbent)

    def commit(self):
        self.commits += 1


class RecordingPipeline(bess_measured.BESSIntelligencePipeline):
    """The real engine, with every instance kept so the test can inspect it.

    Subclassed rather than mocked on purpose: the composite, the sub indices and
    the availability wording all have to come from the real
    `calculate_state_of_safety`. A mock here would let the test pass while the
    engine was never fed anything.
    """

    instances: List["RecordingPipeline"] = []

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        RecordingPipeline.instances.append(self)


def asset_row(*, mode: str = "measured", first_measured: Any = None) -> Dict[str, Any]:
    return {
        "id": ASSET_ID,
        "plant_id": PLANT["id"],
        "external_asset_id": "athi-1",
        "name": "Athi Storage BESS",
        "chemistry": "LFP",
        "nominal_capacity_kwh": 10000.0,
        "nominal_power_kw": 5000.0,
        "current_soh": 0.97,
        "installation_date": date(2025, 3, 1),
        "metadata": json.dumps({
            "telemetry": {
                "mode": mode,
                "first_measured_date": first_measured,
                "source": "huawei_api:test",
            }
        }),
    }


@pytest.fixture
def rig(monkeypatch):
    """Wire the module to fakes and hand back the knobs plus what was written.

    `read_bess_rack_samples` and `write_artifact` are patched on their own
    modules rather than on `bess_measured`, because `materialize_measured_imbalance`
    imports them at call time (the lake extras are optional, so the import must
    not happen at module import).
    """
    state: Dict[str, Any] = {
        "asset": asset_row(),
        "asset_ids": [ASSET_ID],
        "rows_by_day": {DAY: silver_rows(DAY)},
        "raise_silver": None,
        "artifacts": [],
        "days_read": [],
    }
    RecordingPipeline.instances = []

    def fake_read(day, *, plant_id=None, bess_asset_id=None, silver_path=None):
        state["days_read"].append(day)
        if state["raise_silver"] is not None:
            raise state["raise_silver"]
        return list(state["rows_by_day"].get(day, []))

    def fake_metric_names(day, *, plant_id=None, bess_asset_id=None, silver_path=None):
        if state["raise_silver"] is not None:
            raise state["raise_silver"]
        counts: Dict[str, int] = {}
        for r in state["rows_by_day"].get(day, []):
            counts[r["metric"]] = counts.get(r["metric"], 0) + 1
        return counts

    def fake_write(*, plant_id, kind, payload, source, model_version, conn):
        state["artifacts"].append({
            "plant_id": plant_id, "kind": kind, "payload": payload,
            "source": source, "model_version": model_version,
        })

    monkeypatch.setattr(read_silver_mod, "read_bess_rack_samples", fake_read)
    monkeypatch.setattr(read_silver_mod, "silver_metric_names", fake_metric_names)
    monkeypatch.setattr(read_silver_mod, "default_silver_path", lambda *a, **k: "/tmp/fake-silver")
    monkeypatch.setattr("nuravolt.db.writer.write_artifact", fake_write)
    monkeypatch.setattr(bess_measured, "ensure_bess_asset", lambda conn, plant: state["asset"])
    monkeypatch.setattr(bess_measured, "BESSIntelligencePipeline", RecordingPipeline)
    return state


def run(rig_state, **kwargs):
    conn = FakeConn(rig_state["asset_ids"])
    summary = materialize_measured_imbalance(conn, PLANT, day=DAY, **kwargs)
    return summary, conn


def sub_index(pipeline, name):
    return next(s for s in pipeline.state_of_safety.sub_indices if s.name == name)


# --- The break --------------------------------------------------------------


def test_the_state_before_the_caller_existed():
    """The engine with the loader never called, which is `analyze_imbalance(id, [])`.

    Not a hypothetical: this is what `calculate_state_of_safety` returned on
    every asset, every night, for as long as `load_rack_samples` had no callers,
    including assets whose racks were already streaming into the lake.
    """
    unavailable = imbalance_index(analyze_imbalance(ASSET_ID, []))
    assert unavailable.available is False
    assert unavailable.score is None
    assert unavailable.reason == SUB_ASSET_UNAVAILABLE


def test_the_break_the_uncalled_loader(rig):
    """THE regression test: the samples reach the engine and imbalance scores.

    Both halves matter. `rack_samples` non-empty says the loader was called at
    all; the sub index being available says the engine did something with them,
    which is the operator visible half.
    """
    summary, _ = run(rig)

    assert len(RecordingPipeline.instances) == 1
    pipe = RecordingPipeline.instances[0]

    # The break, closed.
    assert pipe.rack_samples, "load_rack_samples was never called: the break is back"
    # Eight racks, two extremes each, every timestamp: nothing dropped on the way.
    assert len(pipe.rack_samples) == (len(NORMAL_RACK_TEMPS_C) + 1) * 2 * STEPS

    imbalance = sub_index(pipe, "imbalance")
    assert imbalance.available is True
    assert imbalance.reason != SUB_ASSET_UNAVAILABLE
    assert imbalance.score is not None

    # And the chain produced a real finding, not merely a non-crash: the hot
    # rack is flagged, sustained, off measured telemetry.
    assert summary["imbalance"]["available"] is True
    assert summary["imbalance"]["racks"] == len(NORMAL_RACK_TEMPS_C) + 1
    assert summary["imbalance"]["sustained_outliers"] >= 1
    assert summary["imbalance"]["worst_modified_z"] > 3.5
    assert summary["day_analysed"] == DAY.isoformat()


def test_the_composite_comes_from_the_engine(rig):
    """No second implementation of state of safety on the measured path."""
    summary, _ = run(rig)
    pipe = RecordingPipeline.instances[0]
    assert summary["state_of_safety"]["score"] == pipe.state_of_safety.score
    assert summary["state_of_safety"]["band"] == pipe.state_of_safety.band
    assert summary["state_of_safety"]["limiting_index"] == pipe.state_of_safety.limiting_index


def test_dwell_minutes_pins_the_engine_window_it_does_not_override_it(rig):
    with pytest.raises(ValueError, match="pins the engine"):
        run(rig, dwell_minutes=15)


# --- What gets published ----------------------------------------------------


def test_published_artifact_is_the_shared_envelope_on_the_measured_basis(rig):
    summary, conn = run(rig)

    (written,) = rig["artifacts"]
    assert written["kind"] == SAFETY_ARTIFACT_KIND
    assert written["plant_id"] == PLANT["id"]
    payload = written["payload"]

    assert payload["provisional"] is False
    prov = payload["provenance"]
    assert prov["telemetry_source"] == MEASURED_RACK_BASIS
    assert prov["measured"] is True
    assert prov["sub_asset_telemetry"] == "present"
    # The window key is itself a claim, so a measured payload must not carry the
    # modelled one.
    assert prov[WINDOW_KEY_MEASURED] == [DAY.isoformat(), DAY.isoformat()]
    assert "modelled_window" not in prov

    (reading,) = payload["readings"]
    assert reading["basis"] == MEASURED_RACK_BASIS
    assert MEASURED_RACK_BASIS != MODELLED_BASIS
    assert "measured rack telemetry" in reading["device_label"]

    imbalance = next(s for s in reading["sub_indices"] if s["name"] == "imbalance")
    assert imbalance["available"] is True
    assert imbalance["inputs"]["basis"] == MEASURED_RACK_BASIS
    # The extremes caveat travels with the number: two members on this basis are
    # a rack's reported edges, not a rack with two modules.
    assert "spread basis" in imbalance["inputs"]["basis_note"]
    assert imbalance["inputs"]["spread_basis"] == "extremes"

    assert summary["state_of_safety"]["published"] is True
    assert conn.commits >= 1


def test_sub_indices_this_run_could_not_measure_stay_unavailable(rig):
    """This path loads no asset grain series, so three of the four have nothing.

    They must keep their reason. A zero would read as perfectly unsafe and a
    hundred would claim evidence nobody collected.
    """
    run(rig)
    (reading,) = rig["artifacts"][0]["payload"]["readings"]
    absent = [s for s in reading["sub_indices"] if not s["available"]]
    assert absent, "the measured rack path scores imbalance only; the rest have no inputs"
    for sub in absent:
        assert sub["score"] is None
        assert sub["reason"]
        assert "basis" not in sub["inputs"]


def test_publish_safety_false_computes_without_writing(rig):
    summary, _ = run(rig, publish_safety=False)
    assert summary["imbalance"]["available"] is True
    assert summary["state_of_safety"]["published"] is False
    assert rig["artifacts"] == []


# --- Refusals: every failure is a skip with a reason, never a fallback -------


def test_a_day_the_regime_does_not_own_writes_nothing(rig):
    """The measured writer must not claim a day the modelled twin owns."""
    rig["asset"] = asset_row(mode="mixed", first_measured=(DAY + timedelta(days=5)).isoformat())

    summary, _ = run(rig)

    assert rig["artifacts"] == []
    assert rig["days_read"] == [], "silver must not even be read for a day we do not own"
    (entry,) = summary["per_day"]
    assert entry["day"] == DAY.isoformat()
    assert "modelled twin owns this day" in entry["skipped"]
    assert summary["skipped"]
    assert "day_analysed" not in summary


def test_a_modelled_asset_is_skipped_with_a_reason(rig):
    rig["asset"] = asset_row(mode="modelled")
    summary, _ = run(rig)
    assert rig["artifacts"] == []
    assert "no measured window" in summary["skipped"]


def test_absent_silver_skips_with_a_reason(rig):
    """An unbuilt lake is not a quiet battery, and neither is a score."""
    rig["raise_silver"] = read_silver_mod.SilverUnavailable(
        "silver_bess_telemetry is not built at /tmp/fake-silver"
    )

    summary, _ = run(rig)

    assert rig["artifacts"] == []
    (entry,) = summary["per_day"]
    assert "not built" in entry["skipped"]
    assert summary["skipped"]
    assert "day_analysed" not in summary


def test_missing_duckdb_skips_rather_than_crashing(rig):
    """duckdb is an optional extra; onboarding must survive its absence."""
    rig["raise_silver"] = ImportError(DUCKDB_MISSING)
    summary, _ = run(rig)
    assert rig["artifacts"] == []
    assert summary["skipped"]
    assert "pip install duckdb" in summary["per_day"][0]["skipped"]


def test_two_batteries_on_one_plant_is_refused_not_guessed(rig):
    """The safety artifact is one row per (plant, kind), so one of two batteries
    would be published as the plant's."""
    rig["asset_ids"] = [ASSET_ID, "0000ffff-0000-4000-8000-0000000000c3"]

    summary, _ = run(rig)

    assert rig["artifacts"] == []
    assert "ambiguous" in summary["skipped"]
    assert rig["days_read"] == []


def test_an_empty_day_says_what_is_there_on_both_sides_of_the_seam(rig):
    """A readable day with no rack rows is almost always a metric name mismatch,
    so the skip carries the names that ARE present rather than only the absence."""
    rig["rows_by_day"] = {DAY: [
        {"rack_device_id": None, "canonical_device_id": "BESS athi-1",
         "device_grain": "asset", "ts": T0, "metric": "bess_soc_asset",
         "value_canonical": 55.0, "bess_asset_id": ASSET_ID},
    ]}

    summary, _ = run(rig)

    assert rig["artifacts"] == []
    assert "no rack grain rows" in summary["skipped"]
    assert summary["silver_metrics"]["present"] == {"bess_soc_asset": 1}
    assert summary["published"] == {"gold-bess-asset-daily-v1": ["bess_soc"]}
    (entry,) = summary["per_day"]
    assert entry["rows"] == 1
    assert entry["samples"] == 0
    assert entry["dropped"]["no_rack_device_id"] == 1


def test_days_walks_backwards_newest_first_and_stops_at_the_first_day_with_rows(rig):
    """Which day the headline came from is stated, not implied by the run date."""
    older = DAY - timedelta(days=2)
    rig["rows_by_day"] = {older: silver_rows(older)}

    summary, _ = run(rig, days=3)

    assert rig["days_read"] == [DAY, DAY - timedelta(days=1), older]
    assert summary["day_analysed"] == older.isoformat()
    prov = rig["artifacts"][0]["payload"]["provenance"]
    assert prov[WINDOW_KEY_MEASURED] == [older.isoformat(), older.isoformat()]


# --- The pivot's honesty survives the round trip ----------------------------


def test_percent_soc_is_a_fraction_by_the_time_it_reaches_the_engine(rig):
    """Silver reports SoC in percent and DeviceSample.soc is a fraction. Carrying
    the percentage across would report a 3 point divergence as 300 points."""
    rows = silver_rows(DAY)
    for step in range(STEPS):
        ts = datetime(DAY.year, DAY.month, DAY.day, 6, 0) + timedelta(minutes=CADENCE_MINUTES * step)
        for i in range(len(NORMAL_RACK_TEMPS_C) + 1):
            rows.append({
                "rack_device_id": f"BESS athi-1.U1.R{i + 1}",
                "canonical_device_id": f"BESS athi-1.U1.R{i + 1}",
                "device_grain": "rack", "ts": ts, "metric": "bess_soc_rack",
                "value_canonical": 62.0 + i, "bess_asset_id": ASSET_ID,
            })
    rig["rows_by_day"] = {DAY: rows}

    summary, _ = run(rig)

    pipe = RecordingPipeline.instances[0]
    socs = [s.soc for s in pipe.rack_samples if s.soc is not None]
    assert socs and max(socs) <= 1.0
    assert max(socs) == pytest.approx(69.0 / rack_samples_mod.SOC_PERCENT_TO_FRACTION)
    (entry,) = summary["per_day"]
    assert entry["soc_scale_applied"] == rack_samples_mod.SOC_PERCENT_TO_FRACTION
