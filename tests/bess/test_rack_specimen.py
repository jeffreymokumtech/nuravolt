"""
Tests for nuravolt.pipeline.bess_rack_specimen.

A specimen is a dangerous object. It exists to look like real data, so the tests
that matter are not "does it produce numbers" but "can it ever be mistaken for a
measurement", and "does it actually demonstrate the detector it was built to
demonstrate".

Four groups, in order of how much damage the failure would do:

  the two guards       the writer refuses to run on an asset with measured
                       telemetry, and refuses any model version that does not
                       announce itself as modelled. Both are enforced, not
                       documented.
  the labels           every layer says modelled: the model version prefix, the
                       per row metadata, the artifact's provisional flag and
                       device label, the per sub index basis note.
  the physics          healthy racks sit in their stated bands, the drifting
                       rack drifts, and nothing ever reaches the 0.2 V thermal
                       runaway precursor rung.
  the detector         the rollups agree with the engine digit for digit, and
                       the spread outlier detector fires on the drifting rack
                       late in the drift and not at the start of it.

Everything here is pure: the specimen is derived from a DispatchDay, which is a
dataclass, so no database is needed to test any of it.
"""

from datetime import date, datetime, timedelta, timezone

import numpy as np
import pytest

from nuravolt.bess.imbalance import (
    DEFAULT_OUTLIER_THRESHOLD,
    SPREAD_BASIS_EXTREMES,
    analyze_imbalance,
)
from nuravolt.bess.rack_samples import rack_samples_from_silver
from nuravolt.pipeline import bess_rack_specimen as spec


ASSET = "bess-ribera-001"
CAPACITY_KWH = 10_000.0
POWER_KW = 5_000.0
LAST_DAY = date(2026, 8, 4)


# ---------------------------------------------------------------------------
# Fixtures: one day of dispatch, shaped like the twin's own rows
# ---------------------------------------------------------------------------


#: A day of arbitrage: charge overnight, sell a little into the morning, rest
#: mid state of charge, sell the rest at midday, then a second evening cycle.
#: The mid morning rest is deliberate. The healthy bands are declared AT REST
#: ON THE PLATEAU, and a battery that only ever rests full or empty would never
#: visit that condition, so the fixture would have nothing to measure it on.
_BLOCKS = (
    # (start hour, end hour, sign) with charge negative, discharge positive
    (0, 2, -1),    # 0.20 -> 0.88
    (6, 7, +1),    # 0.88 -> 0.54, then four hours at rest on the plateau
    (11, 12, +1),  # 0.54 -> 0.20
    (19, 21, -1),  # 0.20 -> 0.88
    (21, 23, +1),  # 0.88 -> 0.20
)


def _dispatch(day: date, resolution_minutes: int = 60) -> spec.DispatchDay:
    """One day of dispatch, shaped like the twin's own rows.

    Deliberately not read from the database: everything interesting about the
    specimen is a pure function of this, so the tests need no database at all.
    """
    n = 1440 // resolution_minutes
    per_hour = 60.0 / resolution_minutes
    soc = []
    power = []
    state = 0.20
    for k in range(n):
        hour = k / per_hour
        sign = next((s for lo, hi, s in _BLOCKS if lo <= hour < hi), 0)
        soc.append(float(np.clip(state, 0.0, 1.0)))
        power.append(float(POWER_KW * sign))
        # The fixture moves 0.34 of the usable band per hour of dispatch.
        state = float(np.clip(state - sign * 0.34 / per_hour, 0.20, 0.88))
    return spec.DispatchDay(
        day=day,
        resolution_minutes=resolution_minutes,
        soc=tuple(soc),
        power_kw=tuple(power),
    )


def _at_rest_plateau(series: spec.DaySeries) -> np.ndarray:
    """Mask of the periods that are on the LFP plateau with no current flowing.

    The healthy bands are declared for exactly this condition, so this is what
    the band tests measure. Anything wider than the band outside this mask is
    the knee and load widening, which is a feature.
    """
    lo, hi = spec.PLATEAU_SOC
    return (
        (series.c_rate <= 1e-9)
        & (series.asset_soc >= lo)
        & (series.asset_soc <= hi)
    )


@pytest.fixture(scope="module")
def topology() -> spec.Topology:
    return spec.build_topology(ASSET, CAPACITY_KWH)


@pytest.fixture(scope="module")
def drifting(topology) -> spec.Rack:
    return spec.choose_drifting_rack(topology)


@pytest.fixture(scope="module")
def character(topology, drifting) -> spec.RackCharacter:
    return spec.rack_character(topology, drifting)


def _day(topology, character, day: date, *, cadence: int = 5) -> spec.DaySeries:
    return spec.generate_day(
        topology,
        character,
        _dispatch(day),
        last_day=LAST_DAY,
        cadence_minutes=cadence,
        power_kw=POWER_KW,
        capacity_kwh=CAPACITY_KWH,
    )


# ---------------------------------------------------------------------------
# The two guards. These are the tests that stop a specimen becoming a lie.
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.store.append((sql, params))

    def fetchall(self):
        return []

    def fetchone(self):
        return None

    @property
    def rowcount(self):
        return 0

    def close(self):
        pass


class _FakeConn:
    """Records every statement, so a test can assert that NOTHING was written.

    Serves the two SELECTs the run makes (the assets, and the dispatch twin's
    schedules) and nothing else, so a test that reaches the write path is
    obvious in ``statements``.
    """

    def __init__(self, asset_rows, dispatch_days=()):
        self.asset_rows = asset_rows
        self.dispatch_rows = [
            (
                d.day, d.resolution_minutes, list(d.soc),
                [min(0.0, p) for p in d.power_kw],
                [max(0.0, p) for p in d.power_kw],
            )
            for d in dispatch_days
        ]
        self.statements = []
        self.commits = 0

    def cursor(self, cursor_factory=None):
        assets, dispatch, store = self.asset_rows, self.dispatch_rows, self.statements

        class C(_FakeCursor):
            def execute(self, sql, params=None):
                store.append((sql, params))
                if 'FROM "BessAsset"' in sql:
                    self._rows = assets
                elif 'FROM "BessDispatchSchedule"' in sql:
                    self._rows = dispatch
                else:
                    self._rows = []

            def fetchall(self):
                return getattr(self, "_rows", [])

        return C(store)

    def commit(self):
        self.commits += 1


def _asset_row(metadata=None):
    return {
        "id": "asset-1",
        "plant_id": "plant-1",
        "external_asset_id": ASSET,
        "name": "Ribera Solar Park storage",
        "chemistry": "LFP",
        "nominal_capacity_kwh": CAPACITY_KWH,
        "nominal_power_kw": POWER_KW,
        "rack_count": None,
        "module_count": None,
        "installation_date": date(2025, 7, 5),
        "metadata": metadata,
    }


PLANT = {"id": "11111111-2222-3333-4444-555555555555", "slug": "ribera", "name": "Ribera"}


def test_refuses_to_run_when_the_asset_has_measured_telemetry():
    """Real telemetry outranks a specimen, and the refusal writes nothing.

    This is the unrecoverable mistake: a modelled specimen sitting on top of
    measurements cannot be told apart from the measurements afterwards by
    looking at the numbers. So the guard is a hard skip, and the test asserts on
    the absence of writes rather than on the message.
    """
    conn = _FakeConn([_asset_row({"telemetry": {"mode": "measured"}})])
    summary = spec.generate_rack_specimen(conn, PLANT)

    assert "skipped" in summary
    assert "measured" in summary["skipped"]
    assert summary["telemetry_regime"]["mode"] == "measured"
    assert conn.commits == 0
    written = [s for s, _ in conn.statements if "INSERT" in s or "UPDATE" in s or "DELETE" in s]
    assert written == [], f"the measured guard let {len(written)} write(s) through"


def test_refuses_to_run_on_a_mixed_regime_too():
    """'mixed' means measured owns part of the calendar, which is still measured."""
    conn = _FakeConn([_asset_row(
        {"telemetry": {"mode": "mixed", "first_measured_date": "2026-01-01"}}
    )])
    summary = spec.generate_rack_specimen(conn, PLANT)
    assert "skipped" in summary
    assert conn.commits == 0


def test_two_batteries_on_one_plant_suppress_the_plant_level_artifact(monkeypatch):
    """The rollups are per device, so they stay defined. The artifact is not.

    AnalysisArtifact is one row per (plant, kind), so publishing one battery's
    specimen as the plant's would attribute it to the other. The ambiguity gates
    the artifact only, and it says so in the summary instead of silently
    publishing the primary asset's numbers as the site's.
    """
    published = []
    monkeypatch.setattr(
        "nuravolt.db.writer.write_artifact",
        lambda **kwargs: published.append(kwargs),
    )
    today = date.today()
    conn = _FakeConn(
        [_asset_row(None), dict(_asset_row(None), id="asset-2")],
        dispatch_days=[_dispatch(today)],
    )
    summary = spec.generate_rack_specimen(conn, PLANT, days=1, dry_run=True)

    assert "skipped" not in summary
    assert "ambiguous_plant" in summary
    assert "2 batteries" in summary["ambiguous_plant"]
    # The rollups still happened, for the oldest asset, at all three grains.
    assert summary["asset_id"] == "asset-1"
    assert summary["records"] == 19 * 21
    assert published == []


def test_refuses_a_model_version_that_does_not_announce_itself():
    """Every downstream caption keys off the model version.

    A specimen published as 'bess-rack-v1' is indistinguishable from a
    measurement at every layer that matters, so the writer raises rather than
    skipping: this one is a programming error, not a data condition.
    """
    conn = _FakeConn([_asset_row(None)])
    with pytest.raises(ValueError, match="modelled-"):
        spec.generate_rack_specimen(conn, PLANT, model_version="bess-rack-daily-v1")
    assert conn.commits == 0

    with pytest.raises(ValueError, match="modelled-"):
        spec.write_records(
            conn, plant_id="p", records=[{"time": 1, "metric": "m", "value": 1.0}],
            model_version="gold-bess-rack-v1", run_id="r",
        )


def test_the_shipped_model_version_passes_its_own_guard():
    assert spec.MODEL_VERSION.startswith(spec.MODELLED_PREFIX)
    assert spec._assert_modelled(spec.MODEL_VERSION) == spec.MODEL_VERSION


# ---------------------------------------------------------------------------
# Topology, with the arithmetic
# ---------------------------------------------------------------------------


def test_ribera_topology_is_the_documented_arithmetic(topology):
    assert topology.rack_count == 16
    assert topology.racks_per_unit == (8, 8)
    assert topology.rack_energy_kwh == pytest.approx(625.0)
    # 625 kWh / (3.2 V x 280 Ah = 0.896 kWh) = 698 cells
    assert topology.cells_per_rack == 698
    assert topology.cells_total == 11_168
    assert topology.cells_per_mwh == pytest.approx(1116.8, abs=0.1)
    lo, hi = spec.CELLS_PER_MWH_BAND
    assert lo <= topology.cells_per_mwh <= hi
    assert topology.in_published_band


def test_canonical_device_ids_follow_the_platform_convention(topology):
    assert topology.asset_device_id == f"BESS {ASSET}"
    assert topology.racks[0].device_id == f"BESS {ASSET}.U-1.R-1"
    assert topology.racks[-1].device_id == f"BESS {ASSET}.U-2.R-8"
    assert topology.unit_device_ids() == (f"BESS {ASSET}.U-1", f"BESS {ASSET}.U-2")


def test_drifting_rack_is_u2_r5(drifting):
    assert drifting.suffix == spec.DEFAULT_DRIFTING_RACK == "U-2.R-5"


def test_a_topology_without_the_preferred_rack_substitutes_rather_than_raising():
    """A smaller asset still gets a specimen, and the substitution is visible."""
    small = spec.build_topology("bess-small-001", 2_000.0)
    chosen = spec.choose_drifting_rack(small, "U-9.R-9")
    assert chosen in small.racks
    assert chosen.suffix != "U-9.R-9"


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_two_runs_of_a_day_are_identical(topology, character):
    a = _day(topology, character, date(2026, 5, 1))
    b = _day(topology, character, date(2026, 5, 1))
    for field in ("dv", "dt", "soc_pct", "t_mid", "v_mid"):
        np.testing.assert_array_equal(getattr(a, field), getattr(b, field))


def test_the_seed_does_not_depend_on_process_hash_randomisation():
    """blake2b, not hash(): PYTHONHASHSEED must not move the specimen."""
    assert spec._seed(ASSET, "2026-05-01") == spec._seed(ASSET, "2026-05-01")
    assert spec._seed(ASSET, "2026-05-01") != spec._seed(ASSET, "2026-05-02")


def test_rack_character_is_stable_across_calls(topology, drifting):
    a = spec.rack_character(topology, drifting)
    b = spec.rack_character(topology, drifting)
    assert a.dv_base_mv == b.dv_base_mv
    assert a.dt_base_c == b.dt_base_c


# ---------------------------------------------------------------------------
# The physics: healthy bands, and the rung that must never be reached
# ---------------------------------------------------------------------------


def test_healthy_racks_sit_in_the_stated_voltage_band(topology, character, drifting):
    """Fifteen healthy racks, inside HEALTHY_DV_BAND_MV on the plateau at rest.

    Measured on the plateau with no current flowing, because that is the
    condition the band is declared for. Off the plateau and under load the
    spread widens, which is the physics the specimen encodes rather than a rack
    leaving its band.
    """
    series = _day(topology, character, LAST_DAY - timedelta(days=150))
    assert series.drift_progress == 0.0
    rest = _at_rest_plateau(series)
    assert rest.sum() > 0, "the fixture never rests on the plateau"

    lo, hi = spec.HEALTHY_DV_BAND_MV
    tolerance = 1.0 + spec.NOISE_DV
    for i, rack_id in enumerate(series.rack_ids):
        if rack_id == drifting.device_id:
            continue
        values = series.dv[i][rest] * 1000.0
        assert values.min() >= lo / tolerance, rack_id
        assert values.max() <= hi * tolerance, rack_id

    # The fifteen of them actually SPAN the band, so the population has a real
    # MAD for the detector to measure against.
    bases = [v for r, v in character.dv_base_mv.items() if r != drifting.device_id]
    assert min(bases) == pytest.approx(lo)
    assert max(bases) == pytest.approx(hi)


def test_healthy_racks_sit_in_the_stated_temperature_band(topology, character, drifting):
    series = _day(topology, character, LAST_DAY - timedelta(days=150))
    rest = _at_rest_plateau(series)
    lo, hi = spec.HEALTHY_DT_BAND_C
    tolerance = 1.0 + spec.NOISE_DT
    for i, rack_id in enumerate(series.rack_ids):
        if rack_id == drifting.device_id:
            continue
        values = series.dt[i][rest]
        assert values.min() >= lo / tolerance, rack_id
        assert values.max() <= hi * tolerance, rack_id


def test_the_spread_widens_under_load_and_at_the_knees(topology, character, drifting):
    """The band is a resting band. Working the battery widens it, on purpose."""
    series = _day(topology, character, LAST_DAY - timedelta(days=150))
    rest = _at_rest_plateau(series)
    i = series.rack_ids.index(drifting.device_id)
    assert float(np.max(series.dv[i])) > float(np.max(series.dv[i][rest]))
    assert float(np.max(series.dt[i])) > float(np.max(series.dt[i][rest]))


def test_the_drifting_rack_starts_indistinguishable_from_its_siblings(
    topology, character, drifting
):
    """Before the drift window it sits inside the sibling band, not above it."""
    series = _day(topology, character, LAST_DAY - timedelta(days=150))
    metrics = spec.rack_day_metrics(series)
    subject = metrics[drifting.device_id]["voltage_spread_mean_v"]
    siblings = [
        m["voltage_spread_mean_v"] for r, m in metrics.items() if r != drifting.device_id
    ]
    assert min(siblings) < subject < max(siblings)


def test_the_drift_lands_on_the_published_end_points(topology, character, drifting):
    """The constants are the REPORTED numbers, not a hidden baseline."""
    series = _day(topology, character, LAST_DAY)
    assert series.drift_progress == 1.0
    metrics = spec.rack_day_metrics(series)[drifting.device_id]
    assert metrics["voltage_spread_max_v"] == pytest.approx(
        spec.DRIFT_DV_END_MV / 1000.0, abs=1e-6
    )
    assert metrics["temp_spread_max_c"] == pytest.approx(spec.DRIFT_DT_END_C, abs=1e-6)
    assert metrics["soc_divergence_from_sibling_median_pct"] == pytest.approx(
        spec.DRIFT_SOC_DIVERGENCE_END_PP, abs=0.25
    )


def test_it_never_reaches_the_thermal_runaway_precursor_rung(topology, character):
    """0.2 V of cell to cell spread is a runaway precursor in the literature.

    A specimen that showed one would be claiming monitoring bought you a warning
    nobody needed. The end point is a constant, so the bound is checkable by
    reading it, and the generator also refuses at emission time.
    """
    assert spec.DRIFT_DV_END_MV / 1000.0 < spec.RUNAWAY_PRECURSOR_V
    for offset in (0, 1, 30, 60, 119, 150):
        series = _day(topology, character, LAST_DAY - timedelta(days=offset))
        worst = float(np.max(series.dv))
        assert worst < spec.RUNAWAY_PRECURSOR_V, (
            f"{offset} days before the end the specimen emitted {worst:.3f} V"
        )


def test_the_emission_guard_actually_fires(topology, character, monkeypatch):
    """The rung is enforced, not merely arranged for by gentle constants."""
    monkeypatch.setattr(spec, "DRIFT_DV_END_MV", 400.0)
    with pytest.raises(ValueError, match="runaway precursor"):
        _day(topology, character, LAST_DAY)


def test_the_cadence_must_resolve_the_dwell_window(topology, character):
    """A feed too coarse to demonstrate persistence demonstrates nothing.

    imbalance.py requires MIN_SAMPLES_IN_DWELL samples inside a 30 minute
    window, so a specimen polled hourly would report every outlier grain as
    unresolvable and the whole exercise would be silent.
    """
    from nuravolt.bess.imbalance import DEFAULT_DWELL_MINUTES, MIN_SAMPLES_IN_DWELL

    assert (
        DEFAULT_DWELL_MINUTES / spec.DEFAULT_CADENCE_MINUTES >= MIN_SAMPLES_IN_DWELL
    )
    with pytest.raises(ValueError, match="1440"):
        _day(topology, character, LAST_DAY, cadence=7)


# ---------------------------------------------------------------------------
# The seam: silver shaped rows through the shared adapter
# ---------------------------------------------------------------------------


def test_rows_go_through_the_same_adapter_the_measured_path_uses(topology, character):
    series = _day(topology, character, LAST_DAY, cadence=10)
    rows = spec.silver_rows(series, plant_id="p", plant_slug="ribera", bess_asset_id="a")
    samples, diagnostics = rack_samples_from_silver(rows)

    assert diagnostics["racks"] == 16
    assert diagnostics["dropped"] == {}
    assert set(diagnostics["metrics_seen"]) == set(spec.SILVER_METRICS)
    # Extremes, honestly labelled: two edges of a 698 cell rack, not two modules.
    assert set(diagnostics["basis_per_rack"].values()) == {SPREAD_BASIS_EXTREMES}
    # The adapter's one SoC divisor was applied here and nowhere else.
    assert diagnostics["soc_scale_applied"] == 100.0
    assert not diagnostics["soc_suspect_already_fraction"]
    assert samples


def test_state_of_charge_survives_the_percent_to_fraction_pivot(topology, character):
    """A 3 pp divergence must not arrive as 300 pp."""
    series = _day(topology, character, LAST_DAY, cadence=10)
    rows = spec.silver_rows(series, plant_id="p", plant_slug="ribera", bess_asset_id="a")
    samples, _ = rack_samples_from_silver(rows)
    socs = [s.soc for s in samples if s.soc is not None]
    assert socs
    assert 0.0 <= min(socs) <= max(socs) <= 1.0


# ---------------------------------------------------------------------------
# Parity: the rollups are the engine's numbers, not a plausible looking cousin
# ---------------------------------------------------------------------------


def test_rollups_match_the_engine_digit_for_digit(topology, character, drifting):
    """The published spread IS imbalance.py's spread.

    The specimen computes its daily rollups directly in numpy for speed, so the
    risk is exactly the one gold_bess_rack_daily already had: a second
    implementation of SPREAD_DEFINITION that quietly answers a different
    question. This asserts the two agree to a microvolt.
    """
    series = _day(topology, character, LAST_DAY, cadence=10)
    mine = spec.rack_day_metrics(series)

    rows = spec.silver_rows(series, plant_id="p", plant_slug="ribera", bess_asset_id="a")
    samples, _ = rack_samples_from_silver(rows)
    report = analyze_imbalance(ASSET, samples)

    assert report.rack_count == 16
    for rack in report.racks:
        engine_v = round(rack.voltage_spread_v, 6)
        engine_t = round(rack.temperature_spread_c, 6)
        assert mine[rack.rack_id]["voltage_spread_max_v"] == pytest.approx(
            engine_v, abs=1e-9
        ), rack.rack_id
        assert mine[rack.rack_id]["temp_spread_max_c"] == pytest.approx(
            engine_t, abs=1e-9
        ), rack.rack_id
        assert mine[rack.rack_id]["soc_divergence_from_sibling_median_pct"] == (
            pytest.approx(round(rack.soc_divergence_pp, 2), abs=0.011)
        ), rack.rack_id
        assert rack.spread_basis == SPREAD_BASIS_EXTREMES


def test_spreads_roll_up_by_max_not_by_mean():
    """A spread does not average.

    The mean of one rack at 95 mV and fifteen at 18 mV is 23 mV, which is what a
    healthy pack reports. Rolling a spread up by mean would hide exactly the
    rack the specimen exists to show.
    """
    children = {
        "r1": {"voltage_spread_max_v": 0.095, "samples": 100.0, "soc_mean_pct": 50.0,
               "soc_divergence_from_sibling_median_pct": -3.0},
        "r2": {"voltage_spread_max_v": 0.018, "samples": 100.0, "soc_mean_pct": 52.0,
               "soc_divergence_from_sibling_median_pct": 0.4},
    }
    parent = spec.rollup(children)
    assert parent["voltage_spread_max_v"] == pytest.approx(0.095)
    assert parent["samples"] == 200.0
    assert parent["soc_mean_pct"] == pytest.approx(51.0)
    # Sign kept: ahead of the fleet and behind it are different findings.
    assert parent["soc_divergence_from_sibling_median_pct"] == pytest.approx(-3.0)


def test_every_emitted_metric_has_a_declared_rollup(topology, character):
    """An unpoliced metric is one nobody decided how to combine."""
    series = _day(topology, character, LAST_DAY, cadence=10)
    metrics = spec.rack_day_metrics(series)
    emitted = {m for row in metrics.values() for m in row}
    undeclared = emitted - set(spec.ROLLUP_POLICY)
    assert undeclared == set(), f"no rollup policy for {sorted(undeclared)}"


def test_metric_names_match_the_gold_model(topology, character):
    """A real lake publish later must be a drop in under a different version.

    gold_bess_rack_daily deliberately deleted the bare `voltage_spread_v` and
    `temp_spread_c` names because they meant two different things in two places.
    The specimen must not resurrect them.
    """
    series = _day(topology, character, LAST_DAY, cadence=10)
    emitted = {m for row in spec.rack_day_metrics(series).values() for m in row}
    assert "voltage_spread_v" not in emitted
    assert "temp_spread_c" not in emitted
    for required in (
        "voltage_spread_max_v", "voltage_spread_p95_v", "voltage_spread_mean_v",
        "voltage_spread_instants", "voltage_spread_envelope_v",
        "temp_spread_max_c", "temp_spread_p95_c", "temp_spread_mean_c",
        "temp_spread_instants", "temp_spread_envelope_c",
        "soc_divergence_from_sibling_median_pct",
    ):
        assert required in emitted, required
    # Never emitted: this specimen models no pack voltage, and a zero there
    # would read as a dead string.
    assert "voltage_pack_max_v" not in emitted


def test_the_envelope_is_never_published_as_the_instantaneous_spread(
    topology, character, drifting
):
    """The two are different questions and the envelope is systematically larger."""
    series = _day(topology, character, LAST_DAY, cadence=10)
    m = spec.rack_day_metrics(series)[drifting.device_id]
    assert m["voltage_spread_envelope_v"] > m["voltage_spread_max_v"]
    assert m["temp_spread_envelope_c"] > m["temp_spread_max_c"]


# ---------------------------------------------------------------------------
# Three grains, so the drill-down tree walks
# ---------------------------------------------------------------------------


def test_records_cover_rack_unit_and_asset_grain(topology, character):
    series = _day(topology, character, LAST_DAY, cadence=10)
    records, per_rack, per_unit, asset_metrics = spec.day_records(series, topology)

    device_ids = {r["device_id"] for r in records}
    assert len(per_rack) == 16
    assert len(per_unit) == 2
    assert asset_metrics
    assert topology.asset_device_id in device_ids
    assert f"BESS {ASSET}.U-1" in device_ids
    assert f"BESS {ASSET}.U-2.R-5" in device_ids

    grains = {r["metadata"]["grain"] for r in records}
    assert grains == {"rack", "unit", "asset"}


def test_the_worst_rack_reaches_the_asset_headline(topology, character, drifting):
    """Without a max rollup the fleet would swallow the one rack that matters."""
    series = _day(topology, character, LAST_DAY, cadence=10)
    _records, per_rack, _per_unit, asset_metrics = spec.day_records(series, topology)
    assert asset_metrics["voltage_spread_max_v"] == pytest.approx(
        per_rack[drifting.device_id]["voltage_spread_max_v"]
    )


def test_every_row_carries_the_modelled_provenance_stamp(topology, character):
    series = _day(topology, character, LAST_DAY, cadence=10)
    records, *_ = spec.day_records(series, topology)
    assert records
    for record in records:
        meta = record["metadata"]
        assert meta["provenance"] == "modelled"
        assert meta["basis"] == spec.SPECIMEN_BASIS == "modelled_rack_specimen"
        assert meta["generator"] == spec.GENERATOR
        assert meta["grain"] in ("rack", "unit", "asset")


def test_the_daily_row_is_stamped_at_utc_midnight(topology, character):
    series = _day(topology, character, LAST_DAY, cadence=10)
    records, *_ = spec.day_records(series, topology)
    times = {r["time"] for r in records}
    assert times == {datetime(2026, 8, 4, tzinfo=timezone.utc)}


# ---------------------------------------------------------------------------
# The detector: three regimes on one timeline
# ---------------------------------------------------------------------------


def _flagged_metrics(topology, character, drifting, day: date, cadence: int = 5):
    series = _day(topology, character, day, cadence=cadence)
    rows = spec.silver_rows(series, plant_id="p", plant_slug="ribera", bess_asset_id="a")
    samples, _ = rack_samples_from_silver(rows)
    report = analyze_imbalance(ASSET, samples)
    return report, sorted(
        {o.metric for o in report.outliers if o.rack_id == drifting.device_id}
    )


def test_quiet_regime_flags_nothing(topology, character, drifting):
    """Before the drift the detector is silent, and it is silent for everyone."""
    report, flagged = _flagged_metrics(
        topology, character, drifting, LAST_DAY - timedelta(days=150)
    )
    assert report.scoreable, "the detector must be RUNNING, not merely quiet"
    assert flagged == []
    assert report.outliers == []


def test_flagged_regime_fires_on_the_spread_grain(topology, character, drifting):
    """The middle regime is the product: flagged, and still inside thresholds.

    The rack's LEVEL barely moves while its cells drift apart, so a level test
    sees nothing. That is why imbalance.py runs the same statistic over each
    rack's own spread, and it is the grain that has to fire here.
    """
    report, flagged = _flagged_metrics(
        topology, character, drifting, LAST_DAY - timedelta(days=70)
    )
    assert "voltage_spread" in flagged
    # Every absolute value still comfortably inside anything published: a BMS
    # balances from about 20 to 50 mV and alarms far above 100 mV.
    series = _day(topology, character, LAST_DAY - timedelta(days=70), cadence=5)
    i = series.rack_ids.index(drifting.device_id)
    worst_mv = float(np.max(series.dv[i])) * 1000.0
    assert 39.0 < worst_mv < 100.0, f"{worst_mv:.1f} mV"
    # The rack's own temperature LEVEL is not what is firing.
    assert "temperature" not in flagged


def test_the_flag_belongs_to_the_drifting_rack_alone(topology, character, drifting):
    report, _ = _flagged_metrics(topology, character, drifting, LAST_DAY)
    racks = {o.rack_id for o in report.outliers}
    assert racks == {drifting.device_id}


def test_the_finding_is_sustained_not_a_spike(topology, character, drifting):
    """A single sample over the line is not an alert, and never was."""
    report, _ = _flagged_metrics(topology, character, drifting, LAST_DAY)
    found = [o for o in report.outliers if o.metric == "voltage_spread"]
    assert found
    assert all(o.duration_minutes >= report.dwell_minutes for o in found)
    assert all(abs(o.modified_z) > DEFAULT_OUTLIER_THRESHOLD for o in found)


def test_the_imbalance_sub_index_is_scored_and_labelled(topology, character):
    """Scored, because rack channels exist. Labelled, because they are modelled."""
    series = _day(topology, character, LAST_DAY, cadence=5)
    sos, report, samples, cadence = spec.analyze_specimen_day(
        series,
        plant_id="p", plant_slug="ribera", asset_db_id="a",
        asset_name="Ribera Solar Park storage",
        chemistry=spec._chemistry("LFP"),
        capacity_kwh=CAPACITY_KWH, power_kw=POWER_KW,
        installation_date=date(2025, 7, 5),
    )
    sub = {s.name: s for s in sos.sub_indices}
    assert sub["imbalance"].available
    assert sub["imbalance"].score is not None
    # No asset grain frame was loaded, so these report unavailable WITH a reason
    # rather than being scored off channels this run does not have.
    for name in ("thermal_margin", "dwell_exposure", "protection_status"):
        assert not sub[name].available
        assert sub[name].reason
        assert sub[name].score is None
    assert cadence == pytest.approx(5.0)
    assert report.rack_count == 16


# ---------------------------------------------------------------------------
# The artifact: provisional at every layer a human reads
# ---------------------------------------------------------------------------


def test_the_artifact_is_labelled_modelled_everywhere(topology, character):
    series = _day(topology, character, LAST_DAY, cadence=5)
    sos, _report, _samples, cadence = spec.analyze_specimen_day(
        series,
        plant_id="p", plant_slug="ribera", asset_db_id="asset-1",
        asset_name="Ribera Solar Park storage",
        chemistry=spec._chemistry("LFP"),
        capacity_kwh=CAPACITY_KWH, power_kw=POWER_KW,
        installation_date=date(2025, 7, 5),
    )
    payload = spec.specimen_state_of_safety_payload(
        sos,
        asset_db_id="asset-1", external_asset_id=ASSET,
        asset_name="Ribera Solar Park storage",
        interval_minutes=cadence, window=(LAST_DAY, LAST_DAY),
    )

    assert payload["provisional"] is True
    prov = payload["provenance"]
    assert prov["measured"] is False
    assert prov["provisional"] is True
    assert prov["telemetry_source"] == "modelled_rack_specimen"
    assert prov["sub_asset_telemetry"] == "modelled"
    assert "modelled" in prov["note"]

    reading = payload["readings"][0]
    assert reading["provisional"] is True
    assert reading["basis"] == "modelled_rack_specimen"
    # The console footer and the alert email both render this label.
    assert reading["device_label"].endswith("(modelled rack specimen)")

    scored = [s for s in reading["sub_indices"] if s.get("available")]
    assert scored, "nothing was scored, so nothing carried a basis"
    for sub in scored:
        assert sub["inputs"]["basis"] == "modelled_rack_specimen"
        assert "modelled" in sub["inputs"]["basis_note"]
    imbalance = next(s for s in reading["sub_indices"] if s["name"] == "imbalance")
    assert "no battery management system" in imbalance["inputs"]["basis_note"].lower()

    # An unavailable sub index keeps its reason and gains nothing else. Never 0,
    # which reads as perfectly unsafe; never 100, which claims evidence nobody
    # collected.
    for sub in reading["sub_indices"]:
        if not sub.get("available"):
            assert sub["score"] is None
            assert sub["reason"]
            assert "basis" not in sub["inputs"]


def test_the_disclosure_is_the_canonical_sentence(topology, character):
    series = _day(topology, character, LAST_DAY, cadence=10)
    sos, *_ = spec.analyze_specimen_day(
        series,
        plant_id="p", plant_slug="ribera", asset_db_id="asset-1", asset_name=None,
        chemistry=spec._chemistry("LFP"),
        capacity_kwh=CAPACITY_KWH, power_kw=POWER_KW, installation_date=None,
    )
    payload = spec.specimen_state_of_safety_payload(
        sos, asset_db_id="asset-1", external_asset_id=ASSET,
    )
    assert payload["disclosure"] == sos.disclosure
    assert "not a protection system" in payload["disclosure"]


def test_the_asset_metadata_block_tells_the_story_alone(topology, drifting):
    patch = spec._asset_metadata_patch(
        topology, drifting,
        window=(date(2026, 2, 6), LAST_DAY),
        cadence_minutes=5, drift_days=120,
    )["rack_specimen"]

    assert patch["generator"] == spec.GENERATOR
    assert patch["model_version"].startswith(spec.MODELLED_PREFIX)
    assert patch["provenance"] == "modelled"
    assert patch["measured"] is False
    assert patch["provisional"] is True
    assert patch["units"] == 2
    assert patch["racks"] == 16
    assert patch["cells_per_rack"] == 698
    assert patch["cells_per_mwh"] == pytest.approx(1116.8, abs=0.1)
    assert patch["drifting_rack"] == f"BESS {ASSET}.U-2.R-5"
    # Modules are not modelled, and the refusal is recorded rather than filled in.
    assert patch["module_count"] is None
    assert "invention" in patch["module_count_note"]
    assert "not a fact about hardware" in patch["note"]


def test_the_run_id_is_deterministic():
    a = spec.specimen_run_id(ASSET)
    b = spec.specimen_run_id(ASSET)
    assert a == b
    assert a != spec.specimen_run_id("bess-other-001")


# ---------------------------------------------------------------------------
# Resolution independence: the twin publishes 24, 48 or 96 period days
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("resolution", [60, 30, 15])
def test_any_settlement_resolution_the_twin_publishes_is_resampled(
    topology, character, resolution
):
    """Iberia moved to a 15 minute MTU, so ES days arrive as 96 periods.

    The specimen polls on its own clock and resamples, so a day at a finer
    settlement resolution must not change the number of samples it emits.
    """
    series = spec.generate_day(
        topology, character, _dispatch(LAST_DAY, resolution),
        last_day=LAST_DAY, cadence_minutes=5,
        power_kw=POWER_KW, capacity_kwh=CAPACITY_KWH,
    )
    assert series.soc_pct.shape == (16, 288)
    assert float(np.max(series.dv)) == pytest.approx(
        spec.DRIFT_DV_END_MV / 1000.0, abs=1e-9
    )
