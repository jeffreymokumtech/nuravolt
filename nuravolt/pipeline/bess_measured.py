"""Measured BESS telemetry: the lake-to-relational bridge.

THE ARCHITECTURAL POINT: **the relational Bess* tables are a materialized
summary of the lake, not a parallel source of truth.** One lineage, two serving
shapes. Device-grain telemetry lands in bronze, dbt rolls it to
`gold_bess_asset_daily`, `nuravolt.lake.publish` lands that gold in
`analysis_results` (domain='bess'), and this module materializes the three
relational tables the warranty and cycling UI reads from exactly those rows:

  BessCycleRecord     one row per measured day, straight off the daily gold.
  BessCapacityTest    SoH points along the measured cycling history.
  BessWarrantyStatus  composite health snapshot at the last measured day.

Nothing here recomputes what `nuravolt/bess/` already computes. The daily
aggregation, the cumulative rollup, the record shape, the warranty KPIs and the
composite health score all come from the engine (`cycling_analysis`,
`warranty_tracker`, `pipeline.calculate_health_score`); this module is the
adapter that feeds the engine measured numbers instead of modelled ones.

THE REGIME BOUNDARY (the reason this module exists): the nightly sweep
subprocess-runs the onboarding for every plant, and `synthesize_bess_history`
writes on the same unique keys these writes use. Without a boundary, modelled
dispatch would silently overwrite real telemetry every single night. The
boundary is one JSON block on `BessAsset.metadata`:

    {"telemetry": {"mode": "modelled|measured|mixed",
                   "first_measured_date": "YYYY-MM-DD",
                   "source": "huawei_api:<connection_id>"}}

`TelemetryRegime` turns that block into an exact partition of the calendar:
`owns_modelled(day)` is the complement of `owns_measured(day)` by construction,
so no day can be claimed by both writers and none can fall through. Synthesis
never writes on or after `first_measured_date`; this module never writes before
it.

HONESTY BOUNDARY: rows written here carry provenance 'measured', meaning their
lineage is measured telemetry. That is a statement about the input, not a claim
that every derived figure is a direct reading. Where a number is inferred
(state of health from the chemistry degradation model, depth of discharge from
the daily state-of-charge swing), the basis is written into the row's notes and
returned in the run summary. If the expected gold rows are absent this module
does nothing and says so; it never falls back to synthesis.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import psycopg2.extras

from nuravolt.bess.cycling_analysis import DailyCycleMetrics
from nuravolt.bess.config import BessAssetConfig, BESSPipelineConfig, BessChemistry
from nuravolt.bess.pipeline import BESSIntelligencePipeline
from nuravolt.bess.warranty_tracker import EmpiricalDegradationModel
from nuravolt.pipeline.bess_assets import ensure_bess_asset

PROVENANCE = "measured"
DOMAIN = "bess"

# The gold table this materializes, as published into analysis_results by
# nuravolt.lake.publish. Overridable so a re-publish under a new version can be
# picked up without a code change.
DEFAULT_MODEL_VERSION = os.environ.get("BESS_GOLD_MODEL_VERSION", "gold-bess-asset-daily-v1")

#: Python WarrantyHealthScore.risk_level maps 1:1 to the Prisma enum.
RISK_LEVELS = {"LOW", "MODERATE", "HIGH", "CRITICAL"}

# Asset-grain canonical device id, e.g. "BESS athi-1". The full grain
# convention (unit / rack / module / cell suffixes) is defined once in
# src/lib/services/cloud-connector.ts; this is the narrow asset-grain mirror,
# deliberately the only piece of it duplicated on the Python side.
ASSET_GRAIN_DEVICE_ID_RE = re.compile(r"^BESS ([^.]+)$")

# ---------------------------------------------------------------------------
# Telemetry regime
# ---------------------------------------------------------------------------

TELEMETRY_KEY = "telemetry"
MODE_MODELLED = "modelled"
MODE_MEASURED = "measured"
MODE_MIXED = "mixed"
VALID_MODES = (MODE_MODELLED, MODE_MEASURED, MODE_MIXED)


@dataclass(frozen=True)
class TelemetryRegime:
    """Which writer owns which days for one BESS asset.

    `owns_modelled` is defined as the complement of `owns_measured`, so the two
    writers partition the calendar exactly: every day has one owner, no day has
    two. That invariant is the whole point of the arc, so it lives in one place
    rather than being re-derived at each call site.
    """

    mode: str = MODE_MODELLED
    first_measured_date: Optional[date] = None
    source: Optional[str] = None
    #: Set when the stored block was incoherent and had to be normalized.
    note: Optional[str] = None

    @property
    def has_measured(self) -> bool:
        return self.mode in (MODE_MEASURED, MODE_MIXED)

    def owns_measured(self, day: date) -> bool:
        """True when the measured pipeline owns `day`."""
        if not self.has_measured:
            return False
        if self.first_measured_date is None:
            # 'measured' with no cutover date means measured all the way back.
            return True
        return day >= self.first_measured_date

    def owns_modelled(self, day: date) -> bool:
        """True when synthesis may write `day`. Complement of owns_measured."""
        return not self.owns_measured(day)

    @property
    def synthesis_cutoff(self) -> Optional[date]:
        """First day synthesis must not write. None means no cutoff at all.

        `date.min` is returned for a measured asset with no cutover date: there
        is no day synthesis may write, and callers compare `day >= cutoff`.
        """
        if not self.has_measured:
            return None
        return self.first_measured_date or date.min

    def as_dict(self) -> Dict[str, Any]:
        return {
            "mode": self.mode,
            "first_measured_date": (
                self.first_measured_date.isoformat() if self.first_measured_date else None
            ),
            "source": self.source,
            **({"note": self.note} if self.note else {}),
        }


def _parse_date(value: Any) -> Optional[date]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def parse_telemetry_regime(metadata: Any) -> TelemetryRegime:
    """Read the regime out of a BessAsset.metadata value (dict, JSON text or None).

    An absent block means a plain modelled asset, which is every asset that has
    never had a telemetry connection: synthesis keeps full ownership. An
    explicitly present but incoherent block (unknown mode, or 'mixed' with no
    cutover date) is normalized towards MEASURED-owns-everything, because the
    unrecoverable failure is overwriting real telemetry, not missing a night of
    modelled data. The normalization is recorded in `note` and surfaces in the
    run summary, so it is visible rather than silent.
    """
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (TypeError, ValueError):
            metadata = None
    if not isinstance(metadata, dict):
        return TelemetryRegime()

    block = metadata.get(TELEMETRY_KEY)
    if not isinstance(block, dict):
        return TelemetryRegime()

    mode = str(block.get("mode") or MODE_MODELLED).strip().lower()
    first = _parse_date(block.get("first_measured_date"))
    source = block.get("source") or None

    if mode not in VALID_MODES:
        return TelemetryRegime(
            mode=MODE_MEASURED, first_measured_date=None, source=source,
            note=f"unknown telemetry mode {mode!r}; treated as measured so synthesis cannot overwrite",
        )
    if mode == MODE_MIXED and first is None:
        return TelemetryRegime(
            mode=MODE_MEASURED, first_measured_date=None, source=source,
            note="mixed telemetry with no first_measured_date; treated as measured so synthesis cannot overwrite",
        )
    return TelemetryRegime(mode=mode, first_measured_date=first, source=source)


def regime_from_asset(asset: Dict[str, Any]) -> TelemetryRegime:
    return parse_telemetry_regime(asset.get("metadata"))


def read_telemetry_regime(
    conn, *, asset_id: Optional[str] = None, plant_id: Optional[str] = None
) -> TelemetryRegime:
    """Regime for one asset, by asset id or by plant id."""
    if not asset_id and not plant_id:
        raise ValueError("read_telemetry_regime needs asset_id or plant_id")
    with conn.cursor() as cur:
        if asset_id:
            cur.execute('SELECT metadata FROM "BessAsset" WHERE id = %s', (asset_id,))
        else:
            cur.execute('SELECT metadata FROM "BessAsset" WHERE plant_id = %s LIMIT 1', (plant_id,))
        row = cur.fetchone()
    return parse_telemetry_regime(row[0] if row else None)


def set_telemetry_regime(
    conn,
    asset_id: str,
    *,
    mode: str,
    first_measured_date: Optional[date] = None,
    source: Optional[str] = None,
) -> TelemetryRegime:
    """Record the regime on the asset. Merges, never replaces, the metadata.

    A wholesale `metadata = %s` write here would drop whatever the asset
    provisioner and the modelled twin put there (nameplate flags, price source,
    zone), so the block is concatenated onto the existing jsonb.
    """
    if mode not in VALID_MODES:
        raise ValueError(f"mode must be one of {VALID_MODES}, got {mode!r}")
    if mode == MODE_MIXED and first_measured_date is None:
        raise ValueError("a mixed asset must carry first_measured_date (where it switched over)")

    block = {
        TELEMETRY_KEY: {
            "mode": mode,
            "first_measured_date": first_measured_date.isoformat() if first_measured_date else None,
            "source": source,
        }
    }
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE "BessAsset" SET metadata = COALESCE(metadata, \'{}\'::jsonb) || %s::jsonb, '
            "updated_at = NOW() WHERE id = %s",
            (json.dumps(block), asset_id),
        )
    conn.commit()
    return TelemetryRegime(mode=mode, first_measured_date=first_measured_date, source=source)


# ---------------------------------------------------------------------------
# The gold metric contract
# ---------------------------------------------------------------------------
# Each field lists (metric name, scale to the target unit), most-preferred
# first. Aliases exist because the same quantity gets published under a couple
# of spellings and a metric-name mismatch is the classic way a lake-to-serving
# seam silently produces nothing (see the twin's R2 metric-name bug). When a
# run finds no rows it reports the metric names that ARE present, so the
# mismatch is visible in one line instead of a day of digging.

FIELD_ALIASES: Dict[str, Tuple[Tuple[str, float], ...]] = {
    # Energy, published in MWh; the relational tables are kWh.
    "energy_in_kwh": (
        ("energy_charged_mwh", 1000.0), ("charge_energy_mwh", 1000.0),
        ("energy_charged_kwh", 1.0), ("charge_energy_kwh", 1.0),
    ),
    "energy_out_kwh": (
        ("energy_discharged_mwh", 1000.0), ("discharge_energy_mwh", 1000.0),
        ("energy_discharged_kwh", 1.0), ("discharge_energy_kwh", 1.0),
    ),
    "throughput_kwh": (
        ("throughput_mwh", 1000.0), ("energy_throughput_mwh", 1000.0),
        ("throughput_kwh", 1.0),
    ),
    "equivalent_cycles": (("equivalent_full_cycles", 1.0), ("efc", 1.0)),
    "round_trip_efficiency": (("round_trip_efficiency", 1.0), ("rte", 1.0)),
    "avg_soc": (("soc_avg", 1.0), ("avg_soc", 1.0)),
    "max_soc": (("soc_max", 1.0), ("max_soc", 1.0)),
    "min_soc": (("soc_min", 1.0), ("min_soc", 1.0)),
    "avg_dod": (("dod_avg", 1.0), ("avg_dod", 1.0)),
    "avg_temp_c": (("temperature_avg_c", 1.0), ("temp_avg_c", 1.0), ("avg_temp_c", 1.0)),
    "max_temp_c": (("temperature_max_c", 1.0), ("temp_max_c", 1.0), ("max_temp_c", 1.0)),
    "min_temp_c": (("temperature_min_c", 1.0), ("temp_min_c", 1.0), ("min_temp_c", 1.0)),
    "avg_c_rate": (("c_rate_avg", 1.0), ("avg_c_rate", 1.0)),
    "max_c_rate": (("c_rate_max", 1.0), ("max_c_rate", 1.0)),
    "high_soc_hours": (("soc_high_dwell_hours", 1.0), ("high_soc_hours", 1.0)),
    "low_soc_hours": (("soc_low_dwell_hours", 1.0), ("low_soc_hours", 1.0)),
    "high_temp_hours": (("temp_high_dwell_hours", 1.0), ("high_temp_hours", 1.0)),
    "availability_pct": (("availability_pct", 1.0),),
    # Optional: a battery management system that reports its own state of
    # health. When present it beats any inference from cycling history.
    "soh": (("soh", 1.0), ("state_of_health", 1.0)),
}

#: Every metric name this module knows how to read, for the "what IS published"
#: diagnostic and for the serving route's unit table.
GOLD_METRIC_NAMES: Tuple[str, ...] = tuple(
    name for aliases in FIELD_ALIASES.values() for name, _scale in aliases
)


def _field(row: Dict[str, float], field: str) -> Optional[float]:
    for name, scale in FIELD_ALIASES[field]:
        if name in row:
            return float(row[name]) * scale
    return None


# ---------------------------------------------------------------------------
# Reading the published gold
# ---------------------------------------------------------------------------


def resolve_asset_device_id(
    conn, plant_id: str, model_version: str, asset: Dict[str, Any]
) -> Tuple[Optional[str], List[str]]:
    """The asset-grain canonical device id the gold was published under.

    Returns (device_id, all_asset_grain_ids). A plant with several batteries is
    reported as ambiguous rather than guessed at: writing one asset's telemetry
    onto another's warranty record is worse than writing nothing.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT device_id FROM analysis_results "
            "WHERE plant_id = %s::uuid AND domain = %s AND model_version = %s "
            "AND device_id IS NOT NULL",
            (plant_id, DOMAIN, model_version),
        )
        ids = sorted({r[0] for r in cur.fetchall()})

    asset_grain = [d for d in ids if ASSET_GRAIN_DEVICE_ID_RE.match(d)]
    if len(asset_grain) <= 1:
        return (asset_grain[0] if asset_grain else None), asset_grain

    # Several batteries on one plant: match on the asset's own identifiers.
    wanted = {
        str(asset.get("external_asset_id") or "").strip(),
        str(asset.get("name") or "").strip(),
    }
    for candidate in asset_grain:
        token = ASSET_GRAIN_DEVICE_ID_RE.match(candidate).group(1)
        if token in wanted:
            return candidate, asset_grain
    return None, asset_grain


def read_gold_daily(
    conn,
    plant_id: str,
    *,
    model_version: str,
    device_id: str,
    since: Optional[date] = None,
    until: Optional[date] = None,
) -> List[Tuple[date, Dict[str, float]]]:
    """Daily gold rows for one asset, pivoted to {day: {metric: value}}.

    Queried out of `analysis_results` with no continuous-aggregate rollup: the
    gold is already daily grain, so there is nothing to aggregate, and the
    `analysis_daily` CAGG lags by a day anyway.
    """
    clauses = ["plant_id = %s::uuid", "domain = %s", "model_version = %s", "device_id = %s"]
    params: List[Any] = [plant_id, DOMAIN, model_version, device_id]
    if since:
        clauses.append("time >= %s")
        params.append(datetime(since.year, since.month, since.day))
    if until:
        clauses.append("time < %s")
        params.append(datetime(until.year, until.month, until.day) + timedelta(days=1))

    with conn.cursor() as cur:
        cur.execute(
            "SELECT time, metric, value FROM analysis_results WHERE "
            + " AND ".join(clauses)
            + " ORDER BY time",
            params,
        )
        rows = cur.fetchall()

    by_day: Dict[date, Dict[str, float]] = {}
    for ts, metric, value in rows:
        day = ts.date() if isinstance(ts, datetime) else ts
        by_day.setdefault(day, {})[metric] = float(value)
    return sorted(by_day.items())


def published_metric_names(conn, plant_id: str) -> Dict[str, List[str]]:
    """Diagnostic: what IS in analysis_results for this plant's bess domain."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT model_version, metric FROM analysis_results "
            "WHERE plant_id = %s::uuid AND domain = %s",
            (plant_id, DOMAIN),
        )
        rows = cur.fetchall()
    out: Dict[str, List[str]] = {}
    for model_version, metric in rows:
        out.setdefault(model_version or "(null)", []).append(metric)
    for names in out.values():
        names.sort()
    return out


# ---------------------------------------------------------------------------
# Materialization
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _OpenViolation:
    """Minimal stand-in so the engine's health score can weigh real open
    violations. The engine reads `.severity` only."""

    severity: str


def _open_violations(conn, asset_id: str) -> List[_OpenViolation]:
    with conn.cursor() as cur:
        cur.execute(
            'SELECT severity FROM "BessWarrantyViolation" '
            "WHERE asset_id = %s AND is_resolved = false",
            (asset_id,),
        )
        return [_OpenViolation(severity=str(r[0] or "warning")) for r in cur.fetchall()]


def _chemistry(value: Any) -> BessChemistry:
    try:
        return BessChemistry(str(value).lower())
    except ValueError:
        return BessChemistry.LFP


def _daily_metrics(
    days: Sequence[Tuple[date, Dict[str, float]]], capacity_kwh: float
) -> Tuple[List[DailyCycleMetrics], List[Tuple[date, Dict[str, float]]], List[str], str]:
    """Adapt gold rows into the engine's DailyCycleMetrics.

    Returns (metrics, kept_days, skipped_days, dod_basis). A day without both
    energy directions cannot be a cycle record, so it is skipped and counted.
    """
    metrics: List[DailyCycleMetrics] = []
    kept: List[Tuple[date, Dict[str, float]]] = []
    skipped: List[str] = []
    dod_bases: set = set()

    for day, row in days:
        e_in = _field(row, "energy_in_kwh")
        e_out = _field(row, "energy_out_kwh")
        if e_in is None or e_out is None:
            skipped.append(day.isoformat())
            continue

        throughput = _field(row, "throughput_kwh")
        if throughput is None:
            throughput = e_in + e_out

        efc = _field(row, "equivalent_cycles")
        if efc is None:
            # The engine's own equivalent-full-cycle identity
            # (WarrantyTracker.update_from_cycle): throughput / (2 * nameplate).
            efc = throughput / (2 * capacity_kwh) if capacity_kwh > 0 else 0.0

        rte = _field(row, "round_trip_efficiency")
        if rte is None and e_in > 0:
            rte = e_out / e_in

        dod = _field(row, "avg_dod")
        if dod is not None:
            dod_bases.add("gold_dod_avg")
        else:
            hi, lo = _field(row, "max_soc"), _field(row, "min_soc")
            if hi is not None and lo is not None:
                dod = max(0.0, hi - lo)
                dod_bases.add("soc_swing")

        metrics.append(
            DailyCycleMetrics(
                date=day,
                energy_in_kwh=e_in,
                energy_out_kwh=e_out,
                equivalent_full_cycles=efc,
                # No sub-daily state of charge in a daily gold, so no rainflow
                # stress weighting is available. Left equal to the plain count
                # rather than invented; rainflow_data stays NULL for these rows.
                stress_weighted_cycles=efc,
                avg_dod=dod if dod is not None else 0.0,
                max_dod=dod if dod is not None else 0.0,
                avg_c_rate=_field(row, "avg_c_rate") or 0.0,
                max_c_rate=_field(row, "max_c_rate") or 0.0,
                avg_temp_c=_field(row, "avg_temp_c") or 0.0,
                max_temp_c=_field(row, "max_temp_c") or 0.0,
                round_trip_efficiency=rte or 0.0,
                high_soc_hours=_field(row, "high_soc_hours") or 0.0,
                high_temp_hours=_field(row, "high_temp_hours") or 0.0,
                rainflow_cycles=[],
            )
        )
        kept.append((day, row))

    basis = "gold_dod_avg" if "gold_dod_avg" in dod_bases else (
        "soc_swing" if "soc_swing" in dod_bases else "unavailable"
    )
    return metrics, kept, skipped, basis


def materialize_measured_bess(
    conn,
    plant: Dict[str, Any],
    *,
    model_version: str = DEFAULT_MODEL_VERSION,
    since: Optional[date] = None,
    until: Optional[date] = None,
    device_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Materialize the measured window of one plant's battery into the Bess* tables.

    Idempotent per (asset, day): the same unique keys the modelled twin uses, so
    a re-run replaces rather than accumulates. Writes nothing before the asset's
    `first_measured_date`; that half of the calendar belongs to synthesis.
    """
    asset = ensure_bess_asset(conn, plant)
    regime = regime_from_asset(asset)
    summary: Dict[str, Any] = {
        "asset_id": asset["id"],
        "model_version": model_version,
        "regime": regime.as_dict(),
        "provenance": PROVENANCE,
    }

    if not regime.has_measured:
        summary["skipped"] = "asset telemetry regime is modelled; there is no measured window"
        return summary

    window_start = regime.first_measured_date
    if since and (window_start is None or since > window_start):
        window_start = since
    summary["window_start"] = window_start.isoformat() if window_start else None

    if device_id is None:
        device_id, candidates = resolve_asset_device_id(conn, plant["id"], model_version, asset)
        if device_id is None:
            summary["skipped"] = (
                "no asset-grain gold rows for this battery"
                if not candidates
                else f"ambiguous asset-grain device ids {candidates}; none matches this asset"
            )
            summary["published"] = published_metric_names(conn, plant["id"])
            return summary
    summary["device_id"] = device_id

    days = read_gold_daily(
        conn, plant["id"], model_version=model_version, device_id=device_id,
        since=window_start, until=until,
    )
    if not days:
        summary["skipped"] = (
            f"no analysis_results rows for domain='{DOMAIN}', model_version='{model_version}', "
            f"device_id='{device_id}' in the measured window"
        )
        summary["published"] = published_metric_names(conn, plant["id"])
        return summary

    # Belt and braces: the SQL already filters, but the boundary is the point of
    # this module, so it is asserted rather than assumed.
    days = [(d, row) for d, row in days if regime.owns_measured(d)]
    if not days:
        summary["skipped"] = "every gold row fell before the measured cutover"
        return summary

    cap = float(asset["nominal_capacity_kwh"])
    power = float(asset["nominal_power_kw"])
    if cap <= 0 or power <= 0:
        summary["skipped"] = "degenerate asset (0 kWh/kW)"
        return summary

    metrics, kept, skipped_days, dod_basis = _daily_metrics(days, cap)
    summary["days_measured"] = len(metrics)
    summary["days_incomplete"] = len(skipped_days)
    summary["dod_basis"] = dod_basis
    if not metrics:
        summary["skipped"] = "gold rows carry no usable charge and discharge energy"
        summary["published"] = published_metric_names(conn, plant["id"])
        return summary

    first_day, last_day = metrics[0].date, metrics[-1].date
    installation = _parse_date(asset.get("installation_date")) or first_day

    cfg = BESSPipelineConfig(
        asset=BessAssetConfig(
            asset_id=asset["id"], plant_id=str(plant["id"]),
            name=asset.get("name") or plant["slug"],
            chemistry=_chemistry(asset.get("chemistry", "LFP")),
            nominal_capacity_kwh=cap, nominal_power_kw=power,
            current_soh=float(asset.get("current_soh") or 1.0),
            installation_date=datetime(installation.year, installation.month, installation.day),
        )
    )
    pipe = BESSIntelligencePipeline(cfg)

    # Engine, not reimplementation: the cumulative rollup and the CycleRecord
    # shape both come from CyclingAnalyzer, and the tracker is primed exactly
    # the way pipeline.run_cycling_analysis primes it.
    cumulative = pipe.cycling_analyzer.calculate_cumulative_metrics(metrics)
    cycle_records = pipe.cycling_analyzer.to_cycle_records(metrics)
    pipe.warranty_tracker.metrics["equivalent_full_cycles"] = cumulative["total_cycles"]
    pipe.warranty_tracker.metrics["total_throughput_kwh"] = cumulative["total_throughput_kwh"]
    pipe.warranty_tracker.metrics["high_soc_hours"] = cumulative["total_high_soc_hours"]
    pipe.warranty_tracker.metrics["high_temp_hours"] = cumulative["total_high_temp_hours"]

    # State of health: a reported value beats an inferred one. When nothing is
    # reported, infer from the measured cycling history with the chemistry
    # degradation model, and only when a depth of discharge is actually
    # derivable. No derivable depth means no SoH claim at all.
    soh_series: List[Tuple[date, float]] = []
    reported = [(d, _field(row, "soh")) for d, row in kept]
    reported = [(d, v) for d, v in reported if v is not None]
    if reported:
        soh_basis = "bms_reported"
        soh_series = [(d, float(v)) for d, v in reported]
    elif dod_basis != "unavailable":
        soh_basis = f"degradation_model:{cfg.asset.chemistry.value}"
        degm = EmpiricalDegradationModel(chemistry=cfg.asset.chemistry.value)
        cum = 0.0
        for m in metrics:
            cum += float(m.equivalent_full_cycles)
            yrs = max(0.02, (m.date - installation).days / 365.25)
            soh_series.append(
                (m.date, float(degm.predict_soh(cum, yrs, m.avg_temp_c, m.avg_dod)))
            )
    else:
        soh_basis = None
    summary["soh_basis"] = soh_basis

    threshold = float(cfg.warranty_terms.capacity_guarantee_pct)
    soh_now = soh_series[-1][1] if soh_series else None
    if soh_now is not None:
        pipe.warranty_tracker.measure_capacity(cap * soh_now)

    # Real round-trip efficiency over the last 30 measured days feeds the
    # engine's efficiency component instead of its 0.90 placeholder.
    recent_rte = [m.round_trip_efficiency for m in metrics[-30:] if m.round_trip_efficiency]
    avg_rte = sum(recent_rte) / len(recent_rte) if recent_rte else None

    pipe.violations = _open_violations(conn, asset["id"])
    pipe.warranty_status = pipe.warranty_tracker.get_kpi_summary()
    if avg_rte is not None:
        pipe.warranty_status["avg_rte_30d"] = avg_rte
    health = pipe.calculate_health_score()
    risk = health.risk_level if health.risk_level in RISK_LEVELS else "MODERATE"

    # End of life: the tracker's own projection needs a cycle history this path
    # does not build, so run the capacity-fade model over the measured SoH
    # series instead. A bonus, not a requirement: no projection is left NULL
    # rather than guessed.
    eol_date: Optional[date] = None
    cycles_to_eol = int(max(0.0, float(health.cycles_remaining or 0.0)))
    if len(soh_series) >= 3:
        try:
            import pandas as pd
            from nuravolt.fault.bess_rul_models import RULCapacityFadeModel

            rul = RULCapacityFadeModel(warranty_threshold=threshold).predict(
                pd.DataFrame([{"date": d.isoformat(), "soh": s} for d, s in soh_series])
            )
            days_to_eol = rul.get("days_to_fault")
            if days_to_eol and days_to_eol > 0:
                eol_date = last_day + timedelta(days=int(days_to_eol))
                cyc_per_day = cumulative["total_cycles"] / max(1, len(metrics))
                cycles_to_eol = int(days_to_eol * cyc_per_day)
        except Exception:  # noqa: BLE001 — the snapshot stands without a projection
            pass

    cum_cycles = 0.0
    cum_through = 0.0
    with conn.cursor() as cur:
        # Cycle records, one per measured day. rainflow_data stays NULL: a daily
        # gold carries no sub-daily state of charge, so there is no depth
        # histogram to write and none is invented.
        for (day, row), rec in zip(kept, cycle_records):
            cum_cycles += float(rec.equivalent_cycles)
            cum_through += float(rec.energy_in_kwh) + float(rec.energy_out_kwh)
            cur.execute(
                'INSERT INTO "BessCycleRecord" (id, asset_id, cycle_date, energy_in_kwh, energy_out_kwh, '
                ' equivalent_cycles, cumulative_cycles, cumulative_throughput_kwh, '
                ' avg_soc, max_soc, min_soc, avg_dod, avg_temp_c, max_temp_c, min_temp_c, '
                ' avg_c_rate, max_c_rate, round_trip_efficiency, high_soc_hours, high_temp_hours, '
                ' rainflow_data, provenance, created_at) '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s, NOW()) "
                'ON CONFLICT (asset_id, cycle_date) DO UPDATE SET '
                ' energy_in_kwh = EXCLUDED.energy_in_kwh, energy_out_kwh = EXCLUDED.energy_out_kwh, '
                ' equivalent_cycles = EXCLUDED.equivalent_cycles, cumulative_cycles = EXCLUDED.cumulative_cycles, '
                ' cumulative_throughput_kwh = EXCLUDED.cumulative_throughput_kwh, '
                ' avg_soc = EXCLUDED.avg_soc, max_soc = EXCLUDED.max_soc, min_soc = EXCLUDED.min_soc, '
                ' avg_dod = EXCLUDED.avg_dod, avg_temp_c = EXCLUDED.avg_temp_c, '
                ' max_temp_c = EXCLUDED.max_temp_c, min_temp_c = EXCLUDED.min_temp_c, '
                ' avg_c_rate = EXCLUDED.avg_c_rate, max_c_rate = EXCLUDED.max_c_rate, '
                ' round_trip_efficiency = EXCLUDED.round_trip_efficiency, '
                ' high_soc_hours = EXCLUDED.high_soc_hours, high_temp_hours = EXCLUDED.high_temp_hours, '
                ' rainflow_data = EXCLUDED.rainflow_data, provenance = EXCLUDED.provenance',
                (
                    str(uuid.uuid4()), asset["id"], day,
                    round(rec.energy_in_kwh, 2), round(rec.energy_out_kwh, 2),
                    round(rec.equivalent_cycles, 4), round(cum_cycles, 2), round(cum_through, 2),
                    _rounded(_field(row, "avg_soc"), 4),
                    _rounded(_field(row, "max_soc"), 4),
                    _rounded(_field(row, "min_soc"), 4),
                    _rounded(_field(row, "avg_dod") if dod_basis == "gold_dod_avg" else
                             (rec.avg_dod if dod_basis == "soc_swing" else None), 4),
                    _rounded(_field(row, "avg_temp_c"), 2),
                    _rounded(_field(row, "max_temp_c"), 2),
                    _rounded(_field(row, "min_temp_c"), 2),
                    _rounded(_field(row, "avg_c_rate"), 2),
                    _rounded(_field(row, "max_c_rate"), 2),
                    _rounded(_field(row, "round_trip_efficiency") or rec.round_trip_efficiency, 4),
                    _rounded(_field(row, "high_soc_hours"), 2),
                    _rounded(_field(row, "high_temp_hours"), 2),
                    PROVENANCE,
                ),
            )

        # State-of-health points. No unique key on this table, so the measured
        # points are replaced wholesale; the modelled ones are left alone.
        if soh_series:
            cur.execute(
                'DELETE FROM "BessCapacityTest" WHERE asset_id = %s AND provenance = %s',
                (asset["id"], PROVENANCE),
            )
            note = (
                "State of health reported by the battery management system."
                if soh_basis == "bms_reported"
                else (
                    "State of health inferred from measured cycling history with the chemistry "
                    "degradation model. Depth of discharge basis: "
                    + ("published daily average." if dod_basis == "gold_dod_avg"
                       else "daily state of charge swing.")
                    + " Not a capacity test."
                )
            )
            n = len(soh_series)
            for q in range(4):
                idx = min(n - 1, max(0, int(n * (q + 1) / 4) - 1))
                td, tsoh = soh_series[idx]
                cur.execute(
                    'INSERT INTO "BessCapacityTest" (id, asset_id, test_date, measured_capacity_kwh, '
                    " soh_result, capacity_retention, test_type, is_valid, notes, provenance, created_at, updated_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, 'estimated', true, %s, %s, NOW(), NOW())",
                    (str(uuid.uuid4()), asset["id"],
                     datetime(td.year, td.month, td.day),
                     round(cap * tsoh, 1), round(tsoh, 4), round(tsoh, 4), note, PROVENANCE),
                )

        # Warranty snapshot at the last measured day, not at "today": the
        # snapshot describes the telemetry it was computed from.
        if soh_now is not None:
            max_cycles = cfg.warranty_terms.max_cycles or 5000
            years_elapsed = (last_day - installation).days / 365.25
            cur.execute(
                'INSERT INTO "BessWarrantyStatus" (id, asset_id, snapshot_date, current_soh, warranty_threshold, '
                ' soh_margin, equivalent_full_cycles, total_throughput_mwh, cycle_usage_pct, time_usage_pct, '
                ' years_remaining, avg_rte_30d, warranty_health_score, risk_level, projected_eol_date, '
                ' projected_cycles_to_eol, active_violations, provenance, created_at) '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::\"WarrantyRiskLevel\", %s, %s, %s, %s, NOW()) "
                'ON CONFLICT (asset_id, snapshot_date) DO UPDATE SET '
                ' current_soh = EXCLUDED.current_soh, soh_margin = EXCLUDED.soh_margin, '
                ' equivalent_full_cycles = EXCLUDED.equivalent_full_cycles, '
                ' total_throughput_mwh = EXCLUDED.total_throughput_mwh, '
                ' cycle_usage_pct = EXCLUDED.cycle_usage_pct, time_usage_pct = EXCLUDED.time_usage_pct, '
                ' years_remaining = EXCLUDED.years_remaining, avg_rte_30d = EXCLUDED.avg_rte_30d, '
                ' warranty_health_score = EXCLUDED.warranty_health_score, risk_level = EXCLUDED.risk_level, '
                ' projected_eol_date = EXCLUDED.projected_eol_date, '
                ' projected_cycles_to_eol = EXCLUDED.projected_cycles_to_eol, '
                ' active_violations = EXCLUDED.active_violations, provenance = EXCLUDED.provenance',
                (
                    str(uuid.uuid4()), asset["id"], last_day, round(soh_now, 4), threshold,
                    round(soh_now - threshold, 4), round(cum_cycles, 2), round(cum_through / 1000, 2),
                    round(min(1.0, cum_cycles / max_cycles), 4),
                    round(min(1.0, years_elapsed / cfg.warranty_terms.warranty_years), 4),
                    round(max(0.0, float(health.years_remaining or 0.0)), 2),
                    _rounded(avg_rte, 4), round(float(health.score), 2), risk,
                    eol_date, cycles_to_eol,
                    len(pipe.violations), PROVENANCE,
                ),
            )

            # Asset headline SoH follows the measurement. current_soc is left
            # alone on purpose: a daily average is not a live state of charge,
            # and the realtime poller owns that column.
            cur.execute(
                'UPDATE "BessAsset" SET current_soh = %s, last_updated = NOW(), updated_at = NOW(), '
                "metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb WHERE id = %s",
                (round(soh_now, 4),
                 json.dumps({"measured": {"model_version": model_version,
                                          "device_id": device_id,
                                          "last_measured_date": last_day.isoformat(),
                                          "soh_basis": soh_basis}}),
                 asset["id"]),
            )
    conn.commit()

    summary.update({
        "first_day": first_day.isoformat(),
        "last_day": last_day.isoformat(),
        "cumulative_cycles": round(cum_cycles, 2),
        "throughput_mwh": round(cum_through / 1000, 2),
        "soh": round(soh_now, 4) if soh_now is not None else None,
        "avg_rte_30d": round(avg_rte, 4) if avg_rte is not None else None,
        "health_score": int(health.score),
        "risk_level": risk,
        "projected_eol_date": eol_date.isoformat() if eol_date else None,
        "open_violations": len(pipe.violations),
    })
    return summary


def _rounded(value: Optional[float], digits: int) -> Optional[float]:
    return None if value is None else round(float(value), digits)


# ---------------------------------------------------------------------------
# Measured sub asset imbalance (the rack grain)
# ---------------------------------------------------------------------------
#
# `BESSIntelligencePipeline.load_rack_samples` existed with zero callers, so
# `pipeline.rack_samples` stayed `[]`, so `calculate_state_of_safety` called
# `analyze_imbalance(asset_id, [])`, so every sub asset availability came back
# False. The whole rack grain product was dark because one method was never
# called. This is its caller.
#
# It lives here rather than beside the engine because this file already owns the
# regime boundary (`TelemetryRegime`) and its stated job is adapting lake rows
# into engine inputs. Imbalance is the same shape of work as the daily gold
# above: read the lake, feed the engine, publish what the engine says.


def _plant_asset_ids(conn, plant_id: str) -> List[str]:
    with conn.cursor() as cur:
        cur.execute('SELECT id FROM "BessAsset" WHERE plant_id = %s ORDER BY id', (plant_id,))
        return [str(r[0]) for r in cur.fetchall()]


def _cadence_minutes(samples: Sequence[Any]) -> Optional[float]:
    """Measured poll cadence of the rack feed, in minutes.

    The safety disclosure quotes this number back to the operator, so it is
    measured off the samples that were actually analysed rather than assumed
    from a config.
    """
    from nuravolt.bess.imbalance import infer_cadence_seconds

    seconds = infer_cadence_seconds(samples)
    return round(seconds / 60.0, 4) if seconds else None


def materialize_measured_imbalance(
    conn,
    plant: Dict[str, Any],
    *,
    day: Optional[date] = None,
    days: int = 1,
    silver_path: Optional[str] = None,
    dwell_minutes: Optional[float] = None,
    publish_safety: bool = True,
) -> Dict[str, Any]:
    """Measure rack imbalance from silver and publish the state of safety.

    The chain: silver_bess_telemetry (sub daily, per device, per metric) ->
    `rack_samples_from_silver` (pivot to DeviceSamples, percent SoC to fraction)
    -> `BESSIntelligencePipeline.load_rack_samples` -> the engine's own
    `calculate_state_of_safety` -> the shared artifact envelope on the measured
    basis. Nothing here recomputes an index or a composite.

    `day` defaults to today UTC and `days` walks backwards from it inclusive,
    newest first. The newest day that actually yields rack samples is the one
    analysed and published, and which day that was is stamped in the summary and
    in the payload's measured window: a headline computed from an older day must
    say which day, not merely be dated by when it ran.

    `dwell_minutes` PINS the sustained scan window, it does not override it. The
    composite has to come from the engine's own `calculate_state_of_safety`,
    which calls `analyze_imbalance` with the engine default, and honouring a
    different value here would mean rebuilding the composite outside the engine.
    A second implementation of a safety composite is the thing this arc exists
    to prevent, so a mismatch is refused rather than silently ignored.

    Every failure degrades to a skip with a stated reason. There is no fallback:
    an asset whose rack telemetry is not in the lake has no measured imbalance,
    and saying nothing is the honest answer.
    """
    from nuravolt.bess.imbalance import DEFAULT_DWELL_MINUTES
    from nuravolt.bess.rack_samples import rack_samples_from_silver
    from nuravolt.bess.safety_artifact import (
        MEASURED_RACK_BASIS,
        MEASURED_RACK_BASIS_LABEL,
        MEASURED_RACK_BASIS_NOTE_DEFAULT,
        MEASURED_RACK_BASIS_NOTES,
        MEASURED_RACK_PROVENANCE_NOTE,
        SAFETY_ARTIFACT_KIND,
        SAFETY_MODEL_VERSION,
        WINDOW_KEY_MEASURED,
        publish_safety_artifact,
        state_of_safety_payload,
    )
    from nuravolt.db.writer import write_artifact

    # Imported at call time: the lake readers pull in pyiceberg and duckdb,
    # which are optional extras. A CI image without them must still be able to
    # import this module for the daily gold path above.
    from nuravolt.lake.read_silver import (
        SilverUnavailable,
        default_silver_path,
        read_bess_rack_samples,
        silver_metric_names,
    )

    if dwell_minutes is not None and float(dwell_minutes) != float(DEFAULT_DWELL_MINUTES):
        raise ValueError(
            f"dwell_minutes pins the engine's sustained scan window, it does not override it: "
            f"the engine uses {DEFAULT_DWELL_MINUTES} minutes and {dwell_minutes} was requested"
        )

    asset = ensure_bess_asset(conn, plant)
    regime = regime_from_asset(asset)
    resolved_path = silver_path or default_silver_path()
    end_day = day or datetime.now(timezone.utc).date()
    window = [end_day - timedelta(days=i) for i in range(max(1, int(days)))]

    summary: Dict[str, Any] = {
        "asset_id": asset["id"],
        "regime": regime.as_dict(),
        "provenance": PROVENANCE,
        "basis": MEASURED_RACK_BASIS,
        "silver_path": resolved_path,
        "days_requested": [d.isoformat() for d in window],
        "per_day": [],
    }

    if not regime.has_measured:
        summary["skipped"] = "asset telemetry regime is modelled; there is no measured window"
        return summary

    # Several batteries on one plant: the same refusal the daily gold path makes.
    # The state of safety artifact is one row per (plant, kind), so publishing
    # one battery's imbalance as the plant's would attribute it to the other.
    asset_ids = _plant_asset_ids(conn, plant["id"])
    if len(asset_ids) > 1:
        summary["skipped"] = (
            f"ambiguous: this plant carries {len(asset_ids)} batteries {asset_ids}; "
            "rack telemetry cannot be published as one plant level safety artifact"
        )
        return summary

    analysed: Optional[Dict[str, Any]] = None
    for d in window:
        entry: Dict[str, Any] = {"day": d.isoformat()}
        summary["per_day"].append(entry)

        if not regime.owns_measured(d):
            entry["skipped"] = (
                "the modelled twin owns this day (before first_measured_date "
                f"{regime.first_measured_date})"
            )
            continue

        try:
            rows = read_bess_rack_samples(
                d,
                plant_id=str(plant["id"]),
                bess_asset_id=str(asset["id"]),
                silver_path=resolved_path,
            )
        except (SilverUnavailable, ImportError) as exc:
            entry["skipped"] = str(exc)
            continue

        samples, diagnostics = rack_samples_from_silver(rows)
        entry.update({
            "rows": len(rows),
            "samples": diagnostics["samples_out"],
            "racks": diagnostics["racks"],
            "metrics_seen": diagnostics["metrics_seen"],
            "metrics_ignored": diagnostics["metrics_ignored"],
            "dropped": diagnostics["dropped"],
            "basis_per_rack": diagnostics["basis_per_rack"],
            "soc_scale_applied": diagnostics["soc_scale_applied"],
            "soc_suspect_already_fraction": diagnostics["soc_suspect_already_fraction"],
        })
        if samples and analysed is None:
            analysed = {"day": d, "samples": samples, "diagnostics": diagnostics}

    if analysed is None:
        summary["skipped"] = (
            "no rack grain rows in silver_bess_telemetry for this asset in the requested days"
        )
        # Say what IS there, on both sides of the seam, so a metric name
        # mismatch is one line to read rather than a day of digging.
        summary["published"] = published_metric_names(conn, plant["id"])
        for d in window:
            try:
                summary["silver_metrics"] = {
                    "day": d.isoformat(),
                    "present": silver_metric_names(
                        d,
                        plant_id=str(plant["id"]),
                        bess_asset_id=str(asset["id"]),
                        silver_path=resolved_path,
                    ),
                }
                break
            except (SilverUnavailable, ImportError):
                continue
        return summary

    measured_day: date = analysed["day"]
    samples = analysed["samples"]
    summary["day_analysed"] = measured_day.isoformat()

    cap = float(asset["nominal_capacity_kwh"])
    power = float(asset["nominal_power_kw"])
    if cap <= 0 or power <= 0:
        summary["skipped"] = "degenerate asset (0 kWh/kW)"
        return summary

    installation = _parse_date(asset.get("installation_date")) or measured_day
    cfg = BESSPipelineConfig(
        asset=BessAssetConfig(
            asset_id=asset["id"], plant_id=str(plant["id"]),
            name=asset.get("name") or plant["slug"],
            chemistry=_chemistry(asset.get("chemistry", "LFP")),
            nominal_capacity_kwh=cap, nominal_power_kw=power,
            current_soh=float(asset.get("current_soh") or 1.0),
            installation_date=datetime(installation.year, installation.month, installation.day),
        )
    )
    pipe = BESSIntelligencePipeline(cfg)
    # The engine reads `column_mapping` unconditionally when it scores
    # protection status, and only `load_data` sets it. This run loads no asset
    # grain series at all, so the honest declaration is an empty mapping: no
    # HVAC channel and no alarm channel, which is what the engine will then
    # report as unavailable.
    pipe.column_mapping = {}

    # THE BREAK, CLOSED. Everything above exists to make this call possible.
    pipe.load_rack_samples(samples)
    sos = pipe.calculate_state_of_safety(interval_minutes=_cadence_minutes(samples))
    report = pipe.imbalance_report

    imbalance_sub = next((s for s in sos.sub_indices if s.name == "imbalance"), None)
    summary["imbalance"] = {
        "available": bool(imbalance_sub and imbalance_sub.available),
        "reason": imbalance_sub.reason if imbalance_sub else None,
        "score": imbalance_sub.score if imbalance_sub else None,
        "racks": report.rack_count if report else 0,
        "samples": len(samples),
        "sustained_outliers": len(report.outliers) if report else 0,
        "worst_modified_z": report.worst_modified_z if report else None,
        "inter_rack_spread": dict(report.inter_rack_spread) if report else {},
        "dwell_minutes": report.dwell_minutes if report else None,
        "alignment_seconds": report.alignment_seconds if report else None,
        "alignment_basis": report.alignment_basis if report else None,
        "cadence_seconds": report.cadence_seconds if report else None,
    }
    summary["state_of_safety"] = {
        "score": sos.score,
        "band": sos.band,
        "limiting_index": sos.limiting_index,
        # Named, not counted: "3 unavailable" tells an operator nothing about
        # which evidence is missing or how to get it.
        "unavailable": sos.unavailable,
        "published": False,
        "kind": SAFETY_ARTIFACT_KIND,
    }

    if publish_safety:
        # Through the precedence helper for symmetry with the other two
        # publishers, though measured telemetry outranks both and will always
        # win. Going through one door means a future fourth publisher cannot
        # quietly downgrade this one.
        measured_published, measured_reason = publish_safety_artifact(
            conn,
            str(plant["id"]),
            state_of_safety_payload(
                sos,
                asset_db_id=str(asset["id"]),
                external_asset_id=str(asset.get("external_asset_id") or asset["id"]),
                basis=MEASURED_RACK_BASIS,
                basis_label=MEASURED_RACK_BASIS_LABEL,
                asset_name=asset.get("name") or plant.get("name"),
                interval_minutes=_cadence_minutes(samples),
                window=(measured_day, measured_day),
                window_key=WINDOW_KEY_MEASURED,
                basis_notes=MEASURED_RACK_BASIS_NOTES,
                basis_note_default=MEASURED_RACK_BASIS_NOTE_DEFAULT,
                provenance_note=MEASURED_RACK_PROVENANCE_NOTE,
                provisional=False,
                measured=True,
                sub_asset_telemetry="present",
            ),
            MEASURED_RACK_BASIS,
        )
        conn.commit()
        summary["state_of_safety"]["published"] = measured_published
        summary["state_of_safety"]["publish_reason"] = measured_reason

    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    import argparse
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    import psycopg2

    ap = argparse.ArgumentParser(description="Materialize measured BESS gold into the Bess* tables")
    ap.add_argument("--plant-id", required=True, help="Plant uuid or slug")
    ap.add_argument("--model-version", default=DEFAULT_MODEL_VERSION)
    ap.add_argument("--since", help="YYYY-MM-DD lower bound (clamped to the measured cutover)")
    ap.add_argument(
        "--imbalance-day",
        help="YYYY-MM-DD newest day of rack telemetry to read from silver (default: today UTC)",
    )
    ap.add_argument(
        "--imbalance-days",
        type=int,
        default=1,
        help="how many days back from --imbalance-day to try, newest first; 0 skips the rack arm",
    )
    ap.add_argument(
        "--silver-path",
        help="override where silver_bess_telemetry lives (default: LAKE_ENV aware, dev root unless LAKE_ENV is set)",
    )
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                'SELECT id, slug, name, capacity_mw, country FROM "Plant" '
                "WHERE id::text = %s OR slug = %s LIMIT 1",
                (args.plant_id, args.plant_id),
            )
            row = cur.fetchone()
        if not row:
            raise SystemExit(f"Plant not found: {args.plant_id}")
        summary = {
            "daily": materialize_measured_bess(
                conn, dict(row),
                model_version=args.model_version,
                since=_parse_date(args.since),
            )
        }
        if args.imbalance_days > 0:
            summary["imbalance"] = materialize_measured_imbalance(
                conn, dict(row),
                day=_parse_date(args.imbalance_day),
                days=args.imbalance_days,
                silver_path=args.silver_path,
            )
        else:
            summary["imbalance"] = {"skipped": "--imbalance-days 0"}
        print(json.dumps(summary, indent=2, default=str))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
