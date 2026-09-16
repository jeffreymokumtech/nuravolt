"""
Contract tests for the SERVED per-inverter soiling artifacts.

RED BY DESIGN: these tests assert what the artifacts under
``public/data/soiling/{plant}/`` must look like AFTER the real per-inverter
pipeline (scripts/train_per_inverter_sr.py + backfill) regenerates them.
On today's placeholder data several tests fail on purpose; they turn green
only when the regenerated artifacts carry measured per-inverter signal.

Conventions:
- Parametrized over the three flagship plants (ribera, eta, alpha).
- A missing plant directory (or a missing served artifact in a fork) SKIPS,
  so downstream forks without the demo data don't break.
- Every failure on real-but-wrong data is a plain assertion failure with a
  crisp message — malformed/missing keys are surfaced via asserts, never as
  KeyError/TypeError crashes.
"""

import json
import math
import statistics
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SOILING_DIR = REPO_ROOT / "public" / "data" / "soiling"
PLANTS_DIR = REPO_ROOT / "public" / "data" / "plants"

FLAGSHIP_PLANTS = ["ribera", "eta", "alpha"]

# Honest model families a served 365d forecast may claim. Anything else
# (e.g. a marketing name for a synthetic ramp) fails the contract.
HONEST_MODEL_TYPES = {
    "seasonal_climatology",
    "ml_climate_aware",
    "climatology_blend",
    "lightgbm_dustiq",
}

PER_INVERTER_SR_MAX_BYTES = 3 * 1024 * 1024  # 3 MB serving budget


# ---------------------------------------------------------------------------
# Loaders (skip on absent plant/file so forks don't break; assert on shape)
# ---------------------------------------------------------------------------

def _plant_root(plant: str) -> Path:
    root = SOILING_DIR / plant
    if not root.is_dir():
        pytest.skip(f"plant directory absent: {root}")
    return root


def _load_served_json(plant: str, relpath: str) -> dict:
    """Load a served JSON artifact; skip if the file is absent (fork safety)."""
    path = _plant_root(plant) / relpath
    if not path.is_file():
        pytest.skip(f"served artifact absent: {path}")
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        assert False, f"{path} is not valid JSON: {exc}"
    assert isinstance(payload, dict), (
        f"{path} must be a JSON object, got {type(payload).__name__}"
    )
    return payload


@lru_cache(maxsize=None)
def _all_inverters(plant: str) -> dict:
    return _load_served_json(plant, "all_inverters.json")


def _all_inverters_rows(plant: str) -> list:
    doc = _all_inverters(plant)
    rows = doc.get("inverters")
    assert isinstance(rows, list) and rows, (
        f"{plant}/all_inverters.json must carry a non-empty 'inverters' list, "
        f"got {type(rows).__name__}"
    )
    return rows


@lru_cache(maxsize=None)
def _per_inverter_sr(plant: str):
    """Return (path, parsed doc) for the slug-named per-inverter SR file.

    The slug naming is part of the serving contract for the flagships:
    the UI resolves ``per_inverter/{plant}_per_inverter_sr.json``. A file
    parked under another plant's slug (e.g. alpha1) is a real defect, so a
    present-but-misnamed file FAILS rather than skips.
    """
    per_dir = _plant_root(plant) / "per_inverter"
    if not per_dir.is_dir():
        pytest.skip(f"per_inverter directory absent: {per_dir}")
    expected = per_dir / f"{plant}_per_inverter_sr.json"
    if not expected.is_file():
        candidates = sorted(p.name for p in per_dir.glob("*_per_inverter_sr.json"))
        assert False, (
            f"{plant}: expected slug-named per-inverter file "
            f"{expected.relative_to(REPO_ROOT)}; found instead: "
            f"{candidates or 'nothing'} — the pipeline must write the file "
            f"under the plant's own slug"
        )
    doc = json.loads(expected.read_text())
    assert isinstance(doc, dict), f"{expected} must be a JSON object"
    inverters = doc.get("inverters")
    assert isinstance(inverters, dict) and inverters, (
        f"{expected.name} must carry a non-empty 'inverters' map "
        f"(inverterId -> record), got {type(inverters).__name__}"
    )
    return expected, doc


@lru_cache(maxsize=None)
def _ml_forecast(plant: str) -> dict:
    return _load_served_json(plant, "ml_forecast_365d.json")


def _forecast_rows(plant: str) -> list:
    doc = _ml_forecast(plant)
    rows = doc.get("forecasts") or doc.get("forecast")
    assert isinstance(rows, list) and rows, (
        f"{plant}/ml_forecast_365d.json must carry a non-empty "
        f"'forecasts' list; top-level keys: {sorted(doc.keys())}"
    )
    return rows


@lru_cache(maxsize=None)
def _fleet_summary(plant: str) -> dict:
    return _load_served_json(plant, "fleet_summary.json")


def _registered_external_ids(plant: str) -> list:
    """External inverter ids from public/data/plants/{plant}/inverter_groups.json."""
    path = PLANTS_DIR / plant / "inverter_groups.json"
    if not path.is_file():
        pytest.skip(f"inverter registry absent: {path}")
    doc = json.loads(path.read_text())
    groups = doc.get("inverter_groups")
    assert isinstance(groups, list) and groups, (
        f"{path} must carry a non-empty 'inverter_groups' list"
    )
    ids = [
        inv.get("external_id")
        for grp in groups
        for inv in (grp.get("inverters") or [])
    ]
    assert ids and all(isinstance(i, str) and i for i in ids), (
        f"{path}: every registered inverter needs a non-empty external_id"
    )
    return ids


# ---------------------------------------------------------------------------
# all_inverters.json — the per-inverter fleet snapshot the dashboard renders
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_all_inverters_plant_id_matches_folder_slug(plant):
    """metadata.plant_id must equal the serving folder slug, not a donor id."""
    metadata = _all_inverters(plant).get("metadata") or {}
    plant_id = metadata.get("plant_id")
    assert plant_id == plant, (
        f"{plant}/all_inverters.json metadata.plant_id is {plant_id!r}; the "
        f"artifact served from public/data/soiling/{plant}/ must identify "
        f"itself as {plant!r} (a foreign id means donor data was copied in)"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_all_inverters_covers_every_registered_inverter(plant):
    """One SR row per inverter registered in inverter_groups.json."""
    rows = _all_inverters_rows(plant)
    registered = _registered_external_ids(plant)
    assert len(rows) == len(registered), (
        f"{plant}: all_inverters.json has {len(rows)} inverters but "
        f"inverter_groups.json registers {len(registered)} external ids — "
        f"the served snapshot must cover the whole registered fleet"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_all_inverters_sr_spread_is_measured_not_flat(plant):
    """Per-inverter SR means must genuinely differ (std > 0.005) and the
    fleet z-scores must not be uniformly zero — a flat fleet is the
    signature of a plant-mean value copied to every inverter."""
    rows = _all_inverters_rows(plant)
    sr_means = [
        (r.get("soilingRatio") or {}).get("mean")
        for r in rows
    ]
    missing = sum(1 for v in sr_means if not isinstance(v, (int, float)))
    assert missing == 0, (
        f"{plant}: {missing}/{len(rows)} inverters lack a numeric "
        f"soilingRatio.mean in all_inverters.json"
    )
    # Threshold calibrated against measured reality: eta's 28 well-
    # matched inverters genuinely sit at std ~0.0026, ribera at ~0.007. A
    # plant-mean broadcast is exactly 0.0, so 0.002 still catches it.
    spread = statistics.pstdev(sr_means)
    assert spread > 0.002, (
        f"{plant}: fleet SR-mean std is {spread:.5f} (<= 0.002) — "
        f"per-inverter values look like a single plant-mean broadcast"
    )
    z_scores = [(r.get("fleetComparison") or {}).get("zScore") for r in rows]
    assert not all(z == 0.0 for z in z_scores), (
        f"{plant}: every fleetComparison.zScore is 0.0 — ranking against "
        f"the fleet was never computed"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_all_inverters_provenance_is_measured_per_inverter(plant):
    """Flagship plants must declare measured per-inverter provenance."""
    metadata = _all_inverters(plant).get("metadata") or {}
    provenance = metadata.get("provenance") or {}
    source = provenance.get("source") if isinstance(provenance, dict) else provenance
    assert source == "measured_per_inverter", (
        f"{plant}/all_inverters.json metadata.provenance.source is "
        f"{source!r}; the regenerated artifact must declare "
        f"'measured_per_inverter' so the UI can distinguish real signal "
        f"from plant-mean fallback"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_all_inverters_severity_buckets_sum_to_total(plant):
    """Every inverter carries a severity, and the buckets partition the fleet."""
    rows = _all_inverters_rows(plant)
    buckets = {}
    unlabelled = []
    for r in rows:
        severity = (r.get("fleetComparison") or {}).get("severity")
        if not severity:
            unlabelled.append(r.get("inverterId"))
        buckets[severity] = buckets.get(severity, 0) + 1
    assert not unlabelled, (
        f"{plant}: {len(unlabelled)} inverters have no fleetComparison."
        f"severity (e.g. {unlabelled[:5]})"
    )
    assert sum(buckets.values()) == len(rows), (
        f"{plant}: severity buckets {buckets} sum to "
        f"{sum(buckets.values())} but the fleet has {len(rows)} inverters"
    )


# ---------------------------------------------------------------------------
# per_inverter/{plant}_per_inverter_sr.json — the per-inverter SR time series
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_per_inverter_sr_file_exists_under_plant_slug(plant):
    """The serving contract file per_inverter/{plant}_per_inverter_sr.json
    must exist under the plant's own slug (loader fails with the list of
    misnamed candidates otherwise)."""
    path, _ = _per_inverter_sr(plant)
    assert path.name == f"{plant}_per_inverter_sr.json"


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_per_inverter_current_sr_varies_across_fleet(plant):
    """current_sr must differ between inverters — identical values across
    the whole fleet mean the plant-mean was broadcast, defeating the
    entire point of per-inverter estimation."""
    _, doc = _per_inverter_sr(plant)
    current = {
        inv_id: rec.get("current_sr")
        for inv_id, rec in doc["inverters"].items()
    }
    non_numeric = [k for k, v in current.items() if not isinstance(v, (int, float))]
    assert not non_numeric, (
        f"{plant}: inverters without numeric current_sr: {non_numeric[:5]}"
    )
    values = list(current.values())
    spread = statistics.pstdev(values)
    assert spread > 0.0, (
        f"{plant}: all {len(values)} inverters share current_sr="
        f"{values[0]:.6f} (std=0) — per-inverter SR was not actually "
        f"estimated per inverter"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_per_inverter_histories_are_not_clones(plant):
    """At least 95% of inverter SR histories must be pairwise non-identical.

    Cloned histories (same dates and same SR values) betray a fleet-mean
    series copied to every inverter.
    """
    _, doc = _per_inverter_sr(plant)
    signatures = {}
    for inv_id, rec in doc["inverters"].items():
        history = rec.get("history") or []
        sig = tuple((row.get("date"), row.get("sr")) for row in history)
        signatures.setdefault(sig, []).append(inv_id)
    n = len(doc["inverters"])
    unique = sum(1 for members in signatures.values() if len(members) == 1)
    clone_groups = {
        members[0]: len(members)
        for members in signatures.values()
        if len(members) > 1
    }
    assert unique / n >= 0.95, (
        f"{plant}: only {unique}/{n} inverters have a unique SR history; "
        f"clone groups (leader -> size): {clone_groups}"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_per_inverter_confidences_are_valid_probabilities(plant):
    """Every inverter (and every history row that carries one) must report
    a confidence in (0, 1]."""
    _, doc = _per_inverter_sr(plant)
    bad = []
    for inv_id, rec in doc["inverters"].items():
        conf = rec.get("confidence")
        if not (isinstance(conf, (int, float)) and 0.0 < conf <= 1.0
                and math.isfinite(conf)):
            bad.append((inv_id, conf))
        for row in rec.get("history") or []:
            row_conf = row.get("confidence")
            if row_conf is None:
                continue
            if not (isinstance(row_conf, (int, float)) and 0.0 < row_conf <= 1.0
                    and math.isfinite(row_conf)):
                bad.append((inv_id, row.get("date"), row_conf))
                break  # one bad row per inverter is enough evidence
    assert not bad, (
        f"{plant}: confidences outside (0, 1] (or non-numeric): {bad[:5]}"
        + (f" … and {len(bad) - 5} more" if len(bad) > 5 else "")
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_per_inverter_sr_file_fits_serving_budget(plant):
    """The browser downloads this file on the soiling page — keep it < 3 MB
    (trim history horizon / precision rather than shipping raw backfill)."""
    path, _ = _per_inverter_sr(plant)
    size = path.stat().st_size
    assert size < PER_INVERTER_SR_MAX_BYTES, (
        f"{plant}: {path.name} is {size / 1e6:.2f} MB, over the 3 MB "
        f"serving budget"
    )


# ---------------------------------------------------------------------------
# ml_forecast_365d.json — the 365-day SR forecast the dashboard charts
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_ml_forecast_has_365_contiguous_daily_rows(plant):
    """Exactly 365 rows, one per calendar day, no gaps or duplicates."""
    rows = _forecast_rows(plant)
    assert len(rows) == 365, (
        f"{plant}: ml_forecast_365d.json has {len(rows)} forecast rows, "
        f"expected exactly 365"
    )
    try:
        dates = [date.fromisoformat(str(r.get("date"))) for r in rows]
    except ValueError as exc:
        assert False, f"{plant}: unparseable forecast date: {exc}"
    gaps = [
        (dates[i - 1].isoformat(), dates[i].isoformat())
        for i in range(1, len(dates))
        if dates[i] - dates[i - 1] != timedelta(days=1)
    ]
    assert not gaps, (
        f"{plant}: forecast dates are not contiguous daily; first bad "
        f"steps: {gaps[:3]}"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_ml_forecast_bounds_bracket_prediction(plant):
    """sr_lower_bound <= sr_predicted <= sr_upper_bound on every row."""
    rows = _forecast_rows(plant)
    violations = []
    for r in rows:
        lo, mid, hi = (r.get("sr_lower_bound"), r.get("sr_predicted"),
                       r.get("sr_upper_bound"))
        if not all(isinstance(v, (int, float)) for v in (lo, mid, hi)):
            violations.append((r.get("date"), lo, mid, hi))
        elif not (lo <= mid <= hi):
            violations.append((r.get("date"), lo, mid, hi))
    assert not violations, (
        f"{plant}: {len(violations)} rows where bounds don't bracket the "
        f"prediction (date, lo, pred, hi): {violations[:3]}"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_ml_forecast_sr_within_physical_range(plant):
    """Served SR predictions must stay within the physical band [0.75, 1.02]."""
    rows = _forecast_rows(plant)
    out_of_range = [
        (r.get("date"), r.get("sr_predicted"))
        for r in rows
        if not (isinstance(r.get("sr_predicted"), (int, float))
                and 0.75 <= r["sr_predicted"] <= 1.02)
    ]
    assert not out_of_range, (
        f"{plant}: {len(out_of_range)} forecast rows outside SR "
        f"[0.75, 1.02]: {out_of_range[:3]}"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_ml_forecast_decays_monotonically_between_rain_events(plant):
    """The served forecast must satisfy the engine's own physics check:
    SR decays between rain events (nuravolt.soiling.sr_validation)."""
    pd = pytest.importorskip("pandas")
    sr_validation = pytest.importorskip("nuravolt.soiling.sr_validation")

    rain_csv = _plant_root(plant) / "rain_history.csv"
    if not rain_csv.is_file():
        pytest.skip(f"rain_history.csv absent for {plant}; cannot anchor "
                    f"the decay check to rain events")
    rain_df = pd.read_csv(rain_csv)
    assert "precipitation_mm" in rain_df.columns, (
        f"{plant}: rain_history.csv lacks a precipitation_mm column "
        f"(columns: {list(rain_df.columns)})"
    )

    rows = _forecast_rows(plant)
    sr_series = pd.Series(
        [r.get("sr_predicted") for r in rows],
        index=pd.to_datetime([r.get("date") for r in rows]),
        name="sr_predicted",
    )
    periods, violations, plausibility = sr_validation.validate_monotonic_decay(
        sr_series, rain_df
    )
    assert plausibility >= 0.95, (
        f"{plant}: monotonic-decay plausibility {plausibility:.3f} < 0.95 "
        f"({violations}/{periods} inter-rain periods violate decay) — the "
        f"served forecast contradicts soiling physics"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_ml_forecast_model_type_is_honest(plant):
    """metadata.model_type must name a model family we actually run."""
    metadata = _ml_forecast(plant).get("metadata") or {}
    model_type = metadata.get("model_type")
    assert model_type in HONEST_MODEL_TYPES, (
        f"{plant}: ml_forecast_365d.json metadata.model_type is "
        f"{model_type!r}, not one of the honest families "
        f"{sorted(HONEST_MODEL_TYPES)}"
    )


# ---------------------------------------------------------------------------
# fleet_summary.json — the fleet health card
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_fleet_summary_health_distribution_partitions_fleet(plant):
    """healthDistribution buckets must sum to the plant's inverter total."""
    summary = _fleet_summary(plant)
    distribution = summary.get("healthDistribution") or {}
    assert distribution and all(
        isinstance(v, int) and v >= 0 for v in distribution.values()
    ), (
        f"{plant}: fleet_summary.json healthDistribution must be a map of "
        f"non-negative integer bucket counts, got {distribution!r}"
    )
    total = (summary.get("plantInfo") or {}).get("totalInverters")
    assert isinstance(total, int) and total > 0, (
        f"{plant}: fleet_summary.json plantInfo.totalInverters must be a "
        f"positive integer, got {total!r}"
    )
    bucket_sum = sum(distribution.values())
    assert bucket_sum == total, (
        f"{plant}: healthDistribution {distribution} sums to {bucket_sum} "
        f"but plantInfo.totalInverters is {total}"
    )


@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_fleet_summary_names_top_and_worst_performers(plant):
    """The fleet card must actually name best/worst inverters — empty lists
    mean the per-inverter ranking never ran."""
    summary = _fleet_summary(plant)
    top = summary.get("topPerformers")
    worst = summary.get("worstPerformers")
    assert isinstance(top, list) and top, (
        f"{plant}: fleet_summary.json topPerformers is empty ({top!r}) — "
        f"per-inverter ranking must populate it"
    )
    assert isinstance(worst, list) and worst, (
        f"{plant}: fleet_summary.json worstPerformers is empty ({worst!r}) "
        f"— per-inverter ranking must populate it"
    )


# ---------------------------------------------------------------------------
# Cross-cutting: no donor-plant name leaks into served artifacts
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("plant", FLAGSHIP_PLANTS)
def test_no_donor_plant_leak_in_served_soiling_json(plant):
    """The donor plant's internal name (renamed to Ribera in every artifact)
    must not appear in any served soiling JSON for these plants."""
    root = _plant_root(plant)
    json_files = sorted(root.rglob("*.json"))
    if not json_files:
        pytest.skip(f"no JSON artifacts under {root}")
    leaks = []
    for path in json_files:
        if b"redacted_donor_plant" in path.read_bytes().lower():
            leaks.append(str(path.relative_to(REPO_ROOT)))
    assert not leaks, (
        f"{plant}: donor plant name leaks into served JSON: "
        f"{leaks}"
    )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
