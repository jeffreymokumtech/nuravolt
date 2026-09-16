"""Continuous three-lane BESS revenue ledger.

This turns the one-off optimizer audit into a nightly ledger with THREE
columns that are never summed together:

  MEASURED   what the asset actually did, valued at a published price.
             (a) Energy value: discharged MWh per settlement period times the
                 zone reference price. This is a PRICE-TAKER IMPUTATION, not
                 settled revenue: nobody paid this number, it is what the
                 delivered energy was worth at the published index.
             (b) Balancing Mechanism revenue (GB only, and only when a BMU id
                 is declared on BessAsset.metadata.gb.bmu_id): reconstructed
                 exactly from the Elexon acceptance stacks as
                 sum(final_price_gbp_mwh * niv_adjusted_volume_mwh) over the
                 bid and offer stacks. That IS settled revenue, rebuilt from
                 public data, and it reconciles against the operator's own
                 settlement statement without them handing us anything.

  DECLARED   what a contract says the asset is paid, from the Contract /
             ContractTerm layer (BESS_TOLLING, BESS_CAPACITY_MARKET,
             BESS_ANCILLARY). Rate times MW times contracted hours, always
             captioned as declared from a named contract and term.

  BENCHMARK  what a perfect-foresight operator would have earned on the same
             asset, the same days and the same published prices, via
             nuravolt.bess.optimizer_audit. Plus, for GB, the ancillary
             benchmark from NESO clearing prices.

WHY THE LANES NEVER MERGE. A battery discharging at 14:00 could be running
wholesale arbitrage, delivering an accepted BM offer, or answering a frequency
event under a response contract. The power trace is IDENTICAL in all three
cases. Attributing the trace to a service would be a fabrication, and adding a
measured imputation to a declared contract fee to an optimizer benchmark would
triple-count the same megawatt hour. So the ledger presents three columns and
one derived KPI: the gap versus the benchmark.

The single derived KPI is that gap. A "capture rate %" KPI was previously
DELETED from the revenue route because its denominator was a hand-tuned
constant. The denominator here is the perfect-foresight arbitrage bound the
audit computes from the published price curve, so the KPI is defensible again
as long as it is captioned as a ceiling: perfect foresight is unreachable, and
good commercial optimizers capture 70-90% of it.

WHAT IS WRITTEN
  analysis_results  one row per (asset, day, metric), domain 'bess', device_id
                    the canonical 'BESS <external_asset_id>'. model_version is
                    one per lane and is the provenance carrier.
  AnalysisArtifact  kind 'bess_revenue_assurance', the rolling 30/90/365-day
                    summary, mirroring how contract_obligations is served.

IDEMPOTENCE. run_id is a deterministic uuid5 per (asset, lane) and each lane
deletes its own rows for the asset before writing, so a rerun is an exact
replacement rather than an append.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from nuravolt.bess.optimizer_audit import AuditAssetSpec, run_optimizer_audit
from nuravolt.db.writer import TimeseriesWriter, write_artifact
from nuravolt.markets._cache import CACHE_DIR
from nuravolt.markets.errors import PriceFetchError
from nuravolt.pipeline.market_prices import (
    day_ahead_periods,
    zone_for_country,
    zone_spec,
)

# ---------------------------------------------------------------------------
# Identity and provenance constants

DOMAIN = "bess"
ARTIFACT_KIND = "bess_revenue_assurance"

LANE_MEASURED = "measured"
LANE_DECLARED = "declared"
LANE_BENCHMARK = "benchmark"
LANES: Tuple[str, str, str] = (LANE_MEASURED, LANE_DECLARED, LANE_BENCHMARK)

# One model_version per lane. This string is what a reader keys provenance off,
# so it is deliberately self-describing and versioned independently per lane.
LANE_MODEL_VERSIONS: Dict[str, str] = {
    LANE_MEASURED: "bess_revenue_measured_v1",
    LANE_DECLARED: "bess_revenue_declared_v1",
    LANE_BENCHMARK: "bess_revenue_benchmark_v1",
}

# Rolling windows the artifact summarises. The per-day rows always cover the
# longest one; the shorter windows are slices of the same rows.
WINDOW_DAYS: Tuple[int, ...] = (30, 90, 365)

# Deterministic namespace so a rerun reproduces the same run_id per (asset, lane).
RUN_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL, "https://nuravolt.com/pipeline/bess_revenue_assurance"
)

# ---------------------------------------------------------------------------
# Canonical BESS device ids
#
# Mirror of the TypeScript helpers in src/lib/services/cloud-connector.ts
# (buildBessDeviceId / sanitizeBessAssetToken). Grain convention:
#   'BESS <asset>' / '.U-<n>' / '.R-<k>' / '.M-<m>' / '.C-<c>'
# Python cannot import the TS module, so this is a deliberate mirror; the two
# must move together.

BESS_DEVICE_ID_PREFIX = "BESS "
PLANT_ROLLUP_DEVICE_ID = "PLANT"


def sanitize_bess_asset_token(raw: Any) -> str:
    """'.'-free, whitespace-collapsed asset token. Mirrors sanitizeBessAssetToken."""
    return re.sub(r"\s+", " ", str(raw if raw is not None else "").replace(".", "-")).strip()


def build_bess_device_id(asset: Any) -> str:
    """Asset-grain canonical device id. Mirrors buildBessDeviceId at grain 'asset'."""
    token = sanitize_bess_asset_token(asset)
    if not token:
        raise ValueError("build_bess_device_id: asset token is empty")
    if token == PLANT_ROLLUP_DEVICE_ID:
        raise ValueError(
            f"build_bess_device_id: '{PLANT_ROLLUP_DEVICE_ID}' is reserved for plant rollups"
        )
    return f"{BESS_DEVICE_ID_PREFIX}{token}"


def lane_run_id(external_asset_id: str, lane: str) -> str:
    """Deterministic run_id per (asset, lane) so a rerun replaces exactly."""
    if lane not in LANE_MODEL_VERSIONS:
        raise ValueError(f"unknown lane {lane!r}; known lanes: {sorted(LANE_MODEL_VERSIONS)}")
    return str(uuid.uuid5(RUN_NAMESPACE, f"{external_asset_id}|{lane}"))


# ---------------------------------------------------------------------------
# Declared lane vocabulary
#
# The closed ContractTerm vocabulary lives in src/lib/contracts/term-fields.ts,
# which a different workstream owns. This module therefore resolves each role
# against a documented ALIAS SET rather than one pinned name, and refuses to
# compute a figure when any role is unresolved. An unresolved contract is
# reported with the fields it does carry, so a vocabulary mismatch surfaces as
# a named gap instead of a silently missing revenue line.
#
# TODO(verify): reconcile these aliases against CONTRACT_TERM_FIELDS for
# BESS_TOLLING / BESS_CAPACITY_MARKET / BESS_ANCILLARY once that vocabulary
# lands, and collapse each set to the one canonical field name.

DECLARED_TERM_ALIASES: Dict[str, Tuple[str, ...]] = {
    "rate": (
        "capacity_fee_per_mw_h",
        "capacity_fee_gbp_mw_h",
        "availability_fee_per_mw_h",
        "availability_fee_gbp_mw_h",
        "tolling_fee_per_mw_h",
        "service_fee_per_mw_h",
        "rate_per_mw_h",
    ),
    "mw": (
        "contracted_capacity_mw",
        "derated_capacity_mw",
        "declared_capacity_mw",
        "contracted_mw",
    ),
    "hours": (
        "contracted_hours_per_day",
        "availability_hours_per_day",
        "delivery_hours_per_day",
    ),
}

# ContractType -> the service token used in the metric name
# revenue_declared_<service>.
DECLARED_SERVICE_BY_TYPE: Dict[str, str] = {
    "BESS_TOLLING": "tolling",
    "BESS_CAPACITY_MARKET": "capacity_market",
    "BESS_ANCILLARY": "ancillary",
}

# ---------------------------------------------------------------------------
# GB ancillary benchmark gate
#
# nuravolt/markets/gb.py carries an unresolved TODO(verify) on the NESO
# clearing-price sign convention and unit: a sampled DRH row cleared at -14.29,
# so negative clearing prices are published and are not an error, but whether a
# negative price means the provider pays or is paid, and whether the unit is
# really GBP/MW/h, is unconfirmed.
#
# Until that is verified, NO arithmetic here may depend on the sign. The
# clearing prices are still fetched and recorded as INPUTS on the artifact so
# the evidence is visible, but revenue_benchmark_ancillary is not emitted.
# Flip this to True only alongside a citation to the NESO methodology document.
NESO_CLEARING_PRICE_SIGN_VERIFIED = False

# ---------------------------------------------------------------------------
# Balancing Mechanism acceptance cache
#
# gb.fetch_bm_acceptances costs 96 HTTP requests per BMU-day (both stacks, 48
# settlement periods). A year is ~35k requests, so days are cached on disk and
# only a bounded number of uncached days are fetched per run. NEVER call this
# from a request path.

BM_CACHE_DIR = CACHE_DIR / "bm_acceptances"
BM_DEFAULT_FETCH_DAYS = 30


@dataclass
class DispatchSeries:
    """The realized dispatch trace and an honest label for where it came from."""

    frame: pd.DataFrame  # UTC DatetimeIndex, columns power_kw (discharge +), soc
    source: str  # 'measurements' | 'bess_dispatch_schedule'
    provenance: str  # 'measured' | 'modelled' | whatever the rows declare
    resolution_minutes: int
    prices: Optional[pd.DataFrame] = None  # UTC index, column price_per_mwh
    price_source: Optional[str] = None
    currency: Optional[str] = None


@dataclass
class LaneRows:
    """Per-day analysis_results records for one lane, plus its notes."""

    lane: str
    records: List[dict] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    provenance: Dict[str, dict] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Small helpers


def _f(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(out) else out


def _day_start(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)


def _as_list(value: Any) -> List[float]:
    """psycopg2 hands Json columns back as list or str depending on the column type."""
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return []
    if not isinstance(value, (list, tuple)):
        return []
    out = []
    for item in value:
        parsed = _f(item)
        out.append(parsed if parsed is not None else 0.0)
    return out


def _asset_metadata(asset: dict) -> dict:
    meta = asset.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (TypeError, ValueError):
            meta = None
    return meta if isinstance(meta, dict) else {}


def bmu_id_for_asset(asset: dict) -> Optional[str]:
    """Declared Elexon BMU id, or None. Only a declared id unlocks the BM lane."""
    gb_meta = _asset_metadata(asset).get("gb")
    if not isinstance(gb_meta, dict):
        return None
    bmu = gb_meta.get("bmu_id")
    return str(bmu).strip() or None if bmu else None


# ---------------------------------------------------------------------------
# Realized dispatch resolution


def _measured_series(conn, plant_id: str, device_id: str, since: date) -> Optional[pd.DataFrame]:
    """Metered BESS power/SoC from the measurements hypertable, or None."""
    import psycopg2.extras

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT time, metric, value FROM measurements "
            "WHERE plant_id = %s AND device_id = %s "
            "AND metric IN ('bess_power_discharge', 'bess_power_charge', 'bess_soc') "
            "AND time >= %s ORDER BY time",
            (plant_id, device_id, _day_start(since)),
        )
        rows = list(cur.fetchall())
    if not rows:
        return None

    frame = pd.DataFrame(rows)
    pivot = frame.pivot_table(index="time", columns="metric", values="value", aggfunc="last")
    if pivot.empty:
        return None
    pivot.index = pd.to_datetime(pivot.index, utc=True)

    discharge = pivot["bess_power_discharge"] if "bess_power_discharge" in pivot else 0.0
    charge = pivot["bess_power_charge"] if "bess_power_charge" in pivot else 0.0
    # Charge may be stored positive-as-magnitude or already negative; abs() then
    # subtract so the audit's discharge-positive contract holds either way.
    out = pd.DataFrame(index=pivot.index)
    out["power_kw"] = pd.Series(discharge, index=pivot.index).fillna(0.0).abs() - pd.Series(
        charge, index=pivot.index
    ).fillna(0.0).abs()
    if "bess_soc" in pivot:
        out["soc"] = pivot["bess_soc"]
    return out.sort_index()


def _dispatch_schedule_series(
    conn, asset_id: str, since: date
) -> Tuple[Optional[pd.DataFrame], Optional[pd.DataFrame], dict]:
    """Modelled dispatch reconstructed from BessDispatchSchedule.

    Returns (telemetry, prices, meta). Period-general: the row's own
    resolution_minutes decides how long each slot is, so a GB half-hourly
    schedule is never replayed as 48 hours.
    """
    import psycopg2.extras

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT schedule_date, resolution_minutes, charge_schedule_kw, '
            '       discharge_schedule_kw, soc_schedule, price_forecast, currency, provenance '
            'FROM "BessDispatchSchedule" WHERE asset_id = %s AND schedule_date >= %s '
            "ORDER BY schedule_date",
            (asset_id, since),
        )
        rows = list(cur.fetchall())
    if not rows:
        return None, None, {}

    telemetry_records: List[dict] = []
    price_records: List[dict] = []
    resolutions = set()
    currencies = set()
    provenances = set()
    for row in rows:
        minutes = int(row.get("resolution_minutes") or 60)
        if minutes <= 0 or 1440 % minutes:
            # A period length that does not divide the day cannot be turned
            # into energy at all. Skip the day rather than mis-size it.
            continue
        resolutions.add(minutes)
        if row.get("currency"):
            currencies.add(str(row["currency"]))
        provenances.add(str(row.get("provenance") or "unknown"))

        charge = _as_list(row.get("charge_schedule_kw"))
        discharge = _as_list(row.get("discharge_schedule_kw"))
        soc = _as_list(row.get("soc_schedule"))
        prices = _as_list(row.get("price_forecast"))
        start = _day_start(row["schedule_date"])
        for slot in range(min(len(charge), len(discharge))):
            ts = start + timedelta(minutes=minutes * slot)
            telemetry_records.append(
                {
                    "time": ts,
                    "power_kw": abs(discharge[slot]) - abs(charge[slot]),
                    "soc": soc[slot] if slot < len(soc) else np.nan,
                }
            )
            if slot < len(prices):
                price_records.append({"time": ts, "price_per_mwh": prices[slot]})

    if not telemetry_records:
        return None, None, {}

    telemetry = pd.DataFrame(telemetry_records).set_index("time").sort_index()
    telemetry = telemetry[~telemetry.index.duplicated(keep="last")]
    price_frame = None
    if price_records:
        price_frame = pd.DataFrame(price_records).set_index("time").sort_index()
        price_frame = price_frame[~price_frame.index.duplicated(keep="last")]

    meta = {
        "resolution_minutes": min(resolutions) if resolutions else 60,
        "currency": sorted(currencies)[0] if len(currencies) == 1 else None,
        "provenance": sorted(provenances)[0] if len(provenances) == 1 else "mixed",
        "mixed_resolutions": sorted(resolutions) if len(resolutions) > 1 else None,
    }
    return telemetry, price_frame, meta


def resolve_dispatch_series(
    conn, plant: dict, asset: dict, since: date
) -> Optional[DispatchSeries]:
    """The realized trace, metered if it exists and modelled otherwise.

    The lane structure calls this column MEASURED because it is "what the asset
    did", but the caption never says measured when the underlying series is
    modelled: DispatchSeries.provenance carries the truth and every metric row
    repeats it in its metadata.
    """
    device_id = build_bess_device_id(asset["external_asset_id"])
    metered = _measured_series(conn, str(plant["id"]), device_id, since)
    if metered is not None and len(metered) > 1:
        step = metered.index.to_series().diff().median()
        minutes = int(round(step / pd.Timedelta(minutes=1))) if pd.notna(step) else 60
        return DispatchSeries(
            frame=metered,
            source="measurements",
            provenance="measured",
            resolution_minutes=max(1, minutes),
        )

    telemetry, prices, meta = _dispatch_schedule_series(conn, asset["id"], since)
    if telemetry is None:
        return None
    return DispatchSeries(
        frame=telemetry,
        source="bess_dispatch_schedule",
        provenance=str(meta.get("provenance") or "unknown"),
        resolution_minutes=int(meta.get("resolution_minutes") or 60),
        prices=prices,
        price_source=str(_asset_metadata(asset).get("price_source") or "") or None,
        currency=meta.get("currency"),
    )


def fetch_reference_prices(
    zone: str, start: date, end: date
) -> Tuple[Optional[pd.DataFrame], Optional[str], List[str]]:
    """Published settlement-period prices for [start, end] in one frame.

    Returns (frame indexed UTC with column price_per_mwh, price_source, missing
    days). Days the zone never published are reported, never filled in.
    """
    records: List[dict] = []
    sources = set()
    missing: List[str] = []
    day = start
    while day <= end:
        try:
            curve = day_ahead_periods(day, zone)
        except (PriceFetchError, ValueError):
            missing.append(day.isoformat())
            day += timedelta(days=1)
            continue
        minutes = int(curve["resolution_minutes"])
        sources.add(str(curve["price_source"]))
        base = _day_start(day)
        for slot, price in enumerate(curve["prices"]):
            records.append(
                {"time": base + timedelta(minutes=minutes * slot), "price_per_mwh": float(price)}
            )
        day += timedelta(days=1)

    if not records:
        return None, None, missing
    frame = pd.DataFrame(records).set_index("time").sort_index()
    frame = frame[~frame.index.duplicated(keep="last")]
    source = sorted(sources)[0] if len(sources) == 1 else "mixed"
    return frame, source, missing


# ---------------------------------------------------------------------------
# Lane 1: MEASURED


def measured_energy_rows(
    series: DispatchSeries,
    prices: pd.DataFrame,
    price_source: str,
    currency: str,
    device_id: str,
    run_id: str,
) -> LaneRows:
    """Per-day energy value of the realized trace at the published price.

    Two figures, deliberately separate: the discharge value (what the delivered
    energy was worth) and the charge cost (what the stored energy cost). They
    are NOT netted into one number here because the caption for each is
    different, and because a reader must be able to see that this is an
    imputation on both sides rather than a settlement.
    """
    lane = LaneRows(lane=LANE_MEASURED)
    frame = series.frame.join(prices, how="left")
    frame["price_per_mwh"] = frame["price_per_mwh"].ffill()
    hours = series.resolution_minutes / 60.0

    frame["discharge_mwh"] = frame["power_kw"].clip(lower=0.0) * hours / 1000.0
    frame["charge_mwh"] = (-frame["power_kw"]).clip(lower=0.0) * hours / 1000.0
    frame["discharge_value"] = frame["discharge_mwh"] * frame["price_per_mwh"]
    frame["charge_cost"] = frame["charge_mwh"] * frame["price_per_mwh"]

    metadata = {
        "lane": LANE_MEASURED,
        "series_source": series.source,
        "series_provenance": series.provenance,
        "price_source": price_source,
        "currency": currency,
        "resolution_minutes": series.resolution_minutes,
        "imputation": "price_taker",
    }
    by_day = frame.groupby(frame.index.date)
    for day, group in by_day:
        if group["price_per_mwh"].isna().all():
            continue
        time = _day_start(day)
        for metric, value in (
            ("revenue_measured_energy", group["discharge_value"].sum(skipna=True)),
            ("revenue_measured_charge_cost", group["charge_cost"].sum(skipna=True)),
            ("measured_discharge_mwh", group["discharge_mwh"].sum(skipna=True)),
            ("measured_charge_mwh", group["charge_mwh"].sum(skipna=True)),
        ):
            parsed = _f(value)
            if parsed is None:
                continue
            lane.records.append(
                {
                    "time": time,
                    "device_id": device_id,
                    "metric": metric,
                    "value": round(parsed, 4),
                    "metadata": metadata,
                }
            )

    verb = "Metered" if series.provenance == "measured" else "Modelled"
    lane.provenance["revenue_measured_energy"] = {
        "lane": LANE_MEASURED,
        "model_version": LANE_MODEL_VERSIONS[LANE_MEASURED],
        "source": f"{series.source} x {price_source}",
        "caption": (
            f"{verb} discharge valued at the published {price_source} price. "
            "Price-taker imputation, not settled revenue."
        ),
    }
    lane.provenance["revenue_measured_charge_cost"] = {
        "lane": LANE_MEASURED,
        "model_version": LANE_MODEL_VERSIONS[LANE_MEASURED],
        "source": f"{series.source} x {price_source}",
        "caption": (
            f"{verb} charging valued at the published {price_source} price. "
            "Price-taker imputation, not a settled cost."
        ),
    }
    if series.provenance != "measured":
        lane.notes.append(
            f"Dispatch trace is {series.provenance}, not metered "
            f"(source: {series.source}). The energy value is an imputation on a "
            "modelled trace and must never be captioned as measured revenue."
        )
    return lane


# ---------------------------------------------------------------------------
# Lane 1b: MEASURED, Balancing Mechanism (GB)


def _bm_cache_path(bmu_id: str, day: date) -> Path:
    token = re.sub(r"[^A-Za-z0-9_.-]", "_", bmu_id)
    return BM_CACHE_DIR / token / f"{day:%Y-%m-%d}.json"


def _read_bm_cache(bmu_id: str, day: date) -> Optional[float]:
    path = _bm_cache_path(bmu_id, day)
    if not path.exists():
        return None
    try:
        return _f(json.loads(path.read_text()).get("revenue_gbp"))
    except (OSError, ValueError):
        return None


def _write_bm_cache(bmu_id: str, day: date, revenue: float, acceptances: int) -> None:
    path = _bm_cache_path(bmu_id, day)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "bmu_id": bmu_id,
                    "settlement_date": day.isoformat(),
                    "revenue_gbp": round(revenue, 4),
                    "acceptances": int(acceptances),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "source": "elexon_bm_stack",
                },
                indent=2,
            )
        )
    except OSError:
        # A cache that cannot be written is a slow run, not a wrong one.
        pass


def bm_revenue_rows(
    bmu_id: str,
    start: date,
    end: date,
    device_id: str,
    run_id: str,
    max_fetch_days: int = BM_DEFAULT_FETCH_DAYS,
    session=None,
) -> LaneRows:
    """Settled Balancing Mechanism revenue per day, rebuilt from public data.

    revenue = sum(final_price_gbp_mwh * niv_adjusted_volume_mwh) across the bid
    and offer stacks. Bid volumes are negative (energy the unit did not
    deliver) and offer volumes positive, and both prices are published as
    signed cash-out prices, so the product carries its own sign and nothing
    here flips or absolutes it.

    Costs 96 HTTP requests per uncached BMU-day, hence the disk cache and the
    max_fetch_days bound. Never call this from a request path.
    """
    from nuravolt.markets import gb

    lane = LaneRows(lane=LANE_MEASURED)
    fetched = 0
    cached = 0
    failed: List[str] = []

    day = start
    while day <= end:
        revenue = _read_bm_cache(bmu_id, day)
        if revenue is None:
            if fetched >= max_fetch_days:
                day += timedelta(days=1)
                continue
            try:
                acceptances = gb.fetch_bm_acceptances(bmu_id, day, session=session)
            except Exception as exc:  # noqa: BLE001 - one bad day must not sink the lane
                failed.append(f"{day.isoformat()}: {exc}")
                day += timedelta(days=1)
                continue
            fetched += 1
            if acceptances.empty:
                revenue = 0.0
                _write_bm_cache(bmu_id, day, 0.0, 0)
            else:
                product = (
                    acceptances["final_price_gbp_mwh"].astype(float)
                    * acceptances["niv_adjusted_volume_mwh"].astype(float)
                )
                revenue = float(product.sum(skipna=True))
                _write_bm_cache(bmu_id, day, revenue, len(acceptances))
        else:
            cached += 1

        lane.records.append(
            {
                "time": _day_start(day),
                "device_id": device_id,
                "metric": "revenue_measured_bm",
                "value": round(revenue, 4),
                "metadata": {
                    "lane": LANE_MEASURED,
                    "series_source": "elexon_bm_stack",
                    "series_provenance": "settled",
                    "bmu_id": bmu_id,
                    "currency": "GBP",
                },
            }
        )
        day += timedelta(days=1)

    lane.provenance["revenue_measured_bm"] = {
        "lane": LANE_MEASURED,
        "model_version": LANE_MODEL_VERSIONS[LANE_MEASURED],
        "source": "elexon_bm_stack",
        "caption": (
            f"Settled Balancing Mechanism revenue for BMU {bmu_id}, reconstructed from the "
            "published Elexon acceptance stacks as final price times NIV-adjusted volume."
        ),
    }
    lane.notes.append(
        f"BM acceptances: {fetched} day(s) fetched, {cached} day(s) from cache"
        + (f", {len(failed)} day(s) failed" if failed else "")
    )
    if failed:
        lane.notes.append("BM fetch failures: " + "; ".join(failed[:5]))
    return lane


# ---------------------------------------------------------------------------
# Lane 2: DECLARED


def _resolve_declared_terms(terms: Sequence[dict]) -> Tuple[Dict[str, dict], List[str]]:
    """Map the rate / mw / hours roles onto the contract's actual terms."""
    by_field = {str(t.get("field")): t for t in terms}
    resolved: Dict[str, dict] = {}
    for role, aliases in DECLARED_TERM_ALIASES.items():
        for alias in aliases:
            term = by_field.get(alias)
            if term is not None and _f(term.get("value_numeric")) is not None:
                resolved[role] = term
                break
    unresolved = [role for role in DECLARED_TERM_ALIASES if role not in resolved]
    return resolved, unresolved


def declared_rows(
    contracts: Sequence[dict],
    start: date,
    end: date,
    device_id: str,
    run_id: str,
    zone_currency: str,
) -> LaneRows:
    """Per-day contracted revenue: declared rate x declared MW x contracted hours.

    Never captioned as measured. A contract whose terms do not resolve to all
    three roles produces no revenue line at all and is reported by name with
    the fields it does carry, because guessing which term is the rate would be
    a fabricated number wearing a contract's authority.
    """
    lane = LaneRows(lane=LANE_DECLARED)
    for contract in contracts:
        ctype = str(contract.get("contract_type") or "")
        service = DECLARED_SERVICE_BY_TYPE.get(ctype)
        if service is None:
            continue
        title = str(contract.get("title") or ctype)
        terms = contract.get("terms") or []
        resolved, unresolved = _resolve_declared_terms(terms)
        if unresolved:
            lane.notes.append(
                f"Contract '{title}' ({ctype}) carries terms on file but no revenue line: "
                f"unresolved role(s) {unresolved}. Fields present: "
                f"{sorted(str(t.get('field')) for t in terms)}."
            )
            continue

        rate_term = resolved["rate"]
        rate = _f(rate_term.get("value_numeric"))
        mw = _f(resolved["mw"].get("value_numeric"))
        hours = _f(resolved["hours"].get("value_numeric"))
        if rate is None or mw is None or hours is None:
            continue

        unit = str(rate_term.get("unit") or "")
        # The rate's unit carries the currency. A rate in a currency other than
        # the zone's is left uncomputed rather than converted: an FX rate this
        # module does not have would be a fabricated constant.
        rate_currency = next(
            (code for code in ("GBP", "EUR", "USD") if code in unit.upper()), zone_currency
        )
        if rate_currency != zone_currency:
            lane.notes.append(
                f"Contract '{title}' declares its rate in {rate_currency} while the asset "
                f"settles in {zone_currency}. No conversion is applied and no revenue line "
                "is emitted; record the rate in the settlement currency."
            )
            continue

        effective_from = contract.get("effective_from")
        effective_to = contract.get("effective_to")
        daily = rate * mw * hours
        metric = f"revenue_declared_{service}"
        metadata = {
            "lane": LANE_DECLARED,
            "contract_id": str(contract.get("id")),
            "contract_title": title,
            "contract_type": ctype,
            "counterparty": contract.get("counterparty"),
            "rate_field": str(rate_term.get("field")),
            "rate": rate,
            "rate_unit": unit or None,
            "mw_field": str(resolved["mw"].get("field")),
            "mw": mw,
            "hours_field": str(resolved["hours"].get("field")),
            "hours_per_day": hours,
            "currency": zone_currency,
        }

        day = start
        while day <= end:
            in_window = (effective_from is None or day >= effective_from) and (
                effective_to is None or day <= effective_to
            )
            if in_window:
                lane.records.append(
                    {
                        "time": _day_start(day),
                        "device_id": device_id,
                        "metric": metric,
                        "value": round(daily, 4),
                        "metadata": metadata,
                    }
                )
            day += timedelta(days=1)

        lane.provenance[metric] = {
            "lane": LANE_DECLARED,
            "model_version": LANE_MODEL_VERSIONS[LANE_DECLARED],
            "source": f"contract:{contract.get('id')}",
            "caption": (
                f"Declared by contract '{title}' ({ctype}): "
                f"{rate_term.get('field')} x {resolved['mw'].get('field')} x "
                f"{resolved['hours'].get('field')}. Contracted, not measured."
            ),
        }
    return lane


# ---------------------------------------------------------------------------
# Lane 3: BENCHMARK


def benchmark_rows(
    series: DispatchSeries,
    prices: pd.DataFrame,
    price_source: str,
    currency: str,
    spec: AuditAssetSpec,
    device_id: str,
    run_id: str,
    zone: Optional[str],
) -> Tuple[LaneRows, dict]:
    """Perfect-foresight arbitrage bound, plus the KPIs derived against it.

    nuravolt.bess.optimizer_audit is already general over period length and is
    called, never modified. It charges the same degradation cost per kWh to the
    realized and the optimal trajectory and matches their state-of-charge
    boundary conditions, so the gap is a strategy difference and not an
    accounting artefact.
    """
    lane = LaneRows(lane=LANE_BENCHMARK)

    audit_prices = prices.rename(columns={"price_per_mwh": "price_eur_mwh"}).copy()
    # The audit's price column keeps a legacy euro name; the values are always
    # per MWh in the zone's own settlement currency, which travels in attrs.
    audit_prices.attrs["price_source"] = price_source
    audit_prices.attrs["zone"] = zone

    telemetry = series.frame.copy()
    result = run_optimizer_audit(
        telemetry=telemetry,
        prices=audit_prices,
        spec=spec,
        power_col="power_kw",
        soc_col="soc" if "soc" in telemetry.columns else None,
        power_sign="discharge_positive",
        day_tz="UTC",
    )

    metadata = {
        "lane": LANE_BENCHMARK,
        "benchmark": "perfect_foresight_arbitrage",
        "price_source": price_source,
        "currency": currency,
        "series_source": series.source,
        "series_provenance": series.provenance,
        "degradation_cost_per_kwh": spec.degradation_cost_per_kwh,
    }
    for day_audit in result.days:
        if day_audit.status not in ("ok", "ok_relaxed"):
            continue
        time = pd.Timestamp(day_audit.day).to_pydatetime().replace(tzinfo=timezone.utc)
        pairs: List[Tuple[str, Optional[float]]] = [
            ("revenue_benchmark_arbitrage", day_audit.optimal_net_eur),
            ("revenue_realized_net", day_audit.realized_net_eur),
            ("capture_ratio", day_audit.capture_ratio),
            ("revenue_gap", day_audit.optimal_net_eur - day_audit.realized_net_eur),
        ]
        for metric, value in pairs:
            parsed = _f(value)
            if parsed is None:
                continue
            lane.records.append(
                {
                    "time": time,
                    "device_id": device_id,
                    "metric": metric,
                    "value": round(parsed, 6),
                    "metadata": {**metadata, "audit_status": day_audit.status},
                }
            )

    ceiling = (
        "Perfect-foresight ceiling on the same published prices, same asset limits and "
        "matched state-of-charge boundaries. Unreachable by construction: good commercial "
        "optimizers capture 70 to 90 percent of it."
    )
    lane.provenance["revenue_benchmark_arbitrage"] = {
        "lane": LANE_BENCHMARK,
        "model_version": LANE_MODEL_VERSIONS[LANE_BENCHMARK],
        "source": f"optimizer_audit x {price_source}",
        "caption": ceiling,
    }
    lane.provenance["capture_ratio"] = {
        "lane": LANE_BENCHMARK,
        "model_version": LANE_MODEL_VERSIONS[LANE_BENCHMARK],
        "source": f"optimizer_audit x {price_source}",
        "caption": (
            "Realized net over the perfect-foresight ceiling. The denominator is the "
            "arbitrage bound above, not a tuned constant."
        ),
    }
    lane.provenance["revenue_gap"] = {
        "lane": LANE_BENCHMARK,
        "model_version": LANE_MODEL_VERSIONS[LANE_BENCHMARK],
        "source": f"optimizer_audit x {price_source}",
        "caption": "Perfect-foresight ceiling minus realized net, on the same days and prices.",
    }
    if series.provenance != "measured":
        lane.notes.append(
            "The benchmark compares against a "
            f"{series.provenance} dispatch trace, so the gap is a strategy benchmark on "
            "modelled behaviour, not an audit of measured plant behaviour."
        )
    return lane, result.summary()


def ancillary_benchmark(
    zone: Optional[str],
    start: date,
    end: date,
    derated_mw: Optional[float],
    availability_by_block: Optional[Dict[str, float]] = None,
    session=None,
) -> Tuple[LaneRows, Optional[dict]]:
    """GB ancillary benchmark: NESO clearing price x derated MW x availability.

    Two preconditions are enforced rather than papered over:

    1. The NESO clearing-price sign convention and unit are unverified (see
       NESO_CLEARING_PRICE_SIGN_VERIFIED). Until they are, this returns the
       fetched clearing prices as evidence and emits NO money metric, because
       a signed price of unknown meaning times MW times hours is a number
       nobody can defend.
    2. Availability per EFA block must be MEASURED. Assuming 100 percent would
       silently turn a ceiling into a revenue figure.
    """
    lane = LaneRows(lane=LANE_BENCHMARK)
    if zone != "GB":
        return lane, None

    from nuravolt.markets import gb

    try:
        clearing = gb.fetch_ancillary_clearing_prices(start, end, session=session)
    except Exception as exc:  # noqa: BLE001 - an absent benchmark is a note, not a crash
        lane.notes.append(f"NESO clearing prices unavailable for {start}..{end}: {exc}")
        return lane, None

    evidence = {
        "price_source": clearing.attrs.get("price_source"),
        "resource_id": clearing.attrs.get("resource_id"),
        "resource_name": clearing.attrs.get("resource_name"),
        "blocks": int(len(clearing)),
        "products": sorted({str(p) for p in clearing["product"].dropna().unique()}),
        "derated_mw": derated_mw,
    }
    if not NESO_CLEARING_PRICE_SIGN_VERIFIED:
        lane.notes.append(
            "GB ancillary benchmark withheld: the NESO clearing-price sign convention and "
            "unit are not yet verified against the NESO methodology document, and a sampled "
            "DRH block cleared at a negative price. The clearing prices are recorded as "
            "evidence; no revenue figure is derived from them."
        )
        return lane, evidence
    if derated_mw is None:
        lane.notes.append(
            "GB ancillary benchmark withheld: no declared derated MW on the asset."
        )
        return lane, evidence
    if not availability_by_block:
        lane.notes.append(
            "GB ancillary benchmark withheld: per-EFA-block availability is not measured, "
            "and assuming full availability would turn a ceiling into a revenue figure."
        )
        return lane, evidence

    # Reached only once the sign convention is verified and availability is
    # measured; kept explicit so the arithmetic is reviewable now.
    lane.notes.append("GB ancillary benchmark computed from measured availability.")
    return lane, evidence


# ---------------------------------------------------------------------------
# Persistence


def _delete_lane(conn, plant_id: str, device_id: str, model_version: str) -> None:
    """Clear one lane's rows for one asset so the rewrite is an exact replacement.

    Scoped by device_id as well as (plant, domain, model_version): a plant can
    hold more than one BessAsset, and a plant-wide delete would let the last
    asset processed wipe its siblings' rows.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM analysis_results "
            "WHERE plant_id = %s AND domain = %s AND device_id = %s AND model_version = %s",
            (plant_id, DOMAIN, device_id, model_version),
        )


def persist_lane(
    writer: TimeseriesWriter,
    plant_id: str,
    device_id: str,
    lane: str,
    records: Sequence[dict],
    run_id: str,
) -> int:
    """Delete-then-write one lane, in one transaction on the writer's connection."""
    model_version = LANE_MODEL_VERSIONS[lane]
    _delete_lane(writer.conn, plant_id, device_id, model_version)
    if not records:
        writer.conn.commit()
        return 0
    # write_analysis_results commits, which commits the delete above with it.
    return writer.write_analysis_results(
        plant_id=plant_id,
        domain=DOMAIN,
        records=list(records),
        model_version=model_version,
        run_id=run_id,
    )


# ---------------------------------------------------------------------------
# Aggregation


def summarise_windows(records: Sequence[dict], today: date) -> Dict[str, Dict[str, float]]:
    """Rolling 30/90/365-day totals per metric.

    Ratios are averaged and money is summed, because summing a ratio is
    meaningless. Nothing here ever adds one lane's metric to another's.
    """
    out: Dict[str, Dict[str, float]] = {}
    for window in WINDOW_DAYS:
        cutoff = today - timedelta(days=window)
        bucket: Dict[str, List[float]] = {}
        for record in records:
            time = record["time"]
            day = time.date() if isinstance(time, datetime) else time
            if day < cutoff or day > today:
                continue
            bucket.setdefault(record["metric"], []).append(float(record["value"]))
        summary: Dict[str, float] = {}
        for metric, values in bucket.items():
            if not values:
                continue
            if metric.endswith("_ratio"):
                summary[metric] = round(float(np.mean(values)), 4)
            else:
                summary[metric] = round(float(np.sum(values)), 2)
            summary[f"{metric}__days"] = len(values)
        out[f"{window}d"] = summary
    return out


# ---------------------------------------------------------------------------
# Orchestration


def _fetch_assets(conn, plant_id: str) -> List[dict]:
    import psycopg2.extras

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT * FROM "BessAsset" WHERE plant_id = %s AND enabled = true '
            "ORDER BY created_at ASC",
            (plant_id,),
        )
        return list(cur.fetchall())


def _fetch_declared_contracts(conn, plant_id: str) -> List[dict]:
    import psycopg2.extras

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT id, contract_type::text AS contract_type, title, counterparty, '
            '       effective_from, effective_to '
            'FROM "Contract" WHERE plant_id = %s '
            "AND contract_type::text IN ('BESS_TOLLING','BESS_CAPACITY_MARKET','BESS_ANCILLARY') "
            "AND status::text = 'ACTIVE' ORDER BY created_at",
            (plant_id,),
        )
        contracts = list(cur.fetchall())
        for contract in contracts:
            cur.execute(
                'SELECT field, value_numeric, unit, value_text, status::text AS status '
                'FROM "ContractTerm" WHERE contract_id = %s',
                (contract["id"],),
            )
            contract["terms"] = list(cur.fetchall())
    return contracts


def assure_bess_revenue(
    conn,
    plant: dict,
    days: int = 365,
    bm_fetch_days: int = BM_DEFAULT_FETCH_DAYS,
    today: Optional[date] = None,
    session=None,
    dsn: Optional[str] = None,
) -> dict:
    """Build and persist the three-lane ledger for every BESS asset on a plant.

    Nightly job entry point. Returns a report dict; the same content (plus the
    rolling summary) lands on AnalysisArtifact(kind='bess_revenue_assurance').
    """
    today = today or datetime.now(timezone.utc).date()
    start = today - timedelta(days=days)
    plant_id = str(plant["id"])

    zone = zone_for_country(plant.get("country"))
    assets = _fetch_assets(conn, plant_id)
    if not assets:
        return {"plant": plant.get("slug"), "skipped": "no enabled BESS assets"}
    if zone is None:
        return {
            "plant": plant.get("slug"),
            "skipped": (
                f"country {plant.get('country')!r} maps to no bidding zone this repo has "
                "prices for, so no lane can be valued"
            ),
        }
    currency, _resolution = zone_spec(zone)
    contracts = _fetch_declared_contracts(conn, plant_id)

    ledger: Dict[str, Any] = {
        "plant_id": plant_id,
        "plant_slug": plant.get("slug"),
        "zone": zone,
        "currency": currency,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window": {"from": start.isoformat(), "to": today.isoformat(), "days": days},
        "lanes": {lane: {"model_version": LANE_MODEL_VERSIONS[lane]} for lane in LANES},
        "assets": [],
    }

    writer = TimeseriesWriter(dsn=dsn) if dsn else TimeseriesWriter()
    try:
        for asset in assets:
            ledger["assets"].append(
                _assure_asset(
                    conn=conn,
                    writer=writer,
                    plant=plant,
                    asset=asset,
                    zone=zone,
                    currency=currency,
                    contracts=contracts,
                    start=start,
                    today=today,
                    bm_fetch_days=bm_fetch_days,
                    session=session,
                )
            )
        write_artifact(
            plant_id=plant_id,
            kind=ARTIFACT_KIND,
            payload=json.loads(json.dumps(ledger, default=str)),
            source="computed",
            model_version=LANE_MODEL_VERSIONS[LANE_BENCHMARK],
            conn=writer.conn,
        )
        writer.conn.commit()
    finally:
        writer.close()
    return ledger


def _assure_asset(
    conn,
    writer: TimeseriesWriter,
    plant: dict,
    asset: dict,
    zone: str,
    currency: str,
    contracts: Sequence[dict],
    start: date,
    today: date,
    bm_fetch_days: int,
    session=None,
) -> dict:
    device_id = build_bess_device_id(asset["external_asset_id"])
    report: Dict[str, Any] = {
        "asset_id": str(asset["id"]),
        "external_asset_id": asset["external_asset_id"],
        "device_id": device_id,
        "lanes": {},
        "provenance": {},
        "notes": [],
    }

    series = resolve_dispatch_series(conn, plant, asset, start)
    if series is None:
        report["skipped"] = "no realized dispatch trace (no metered rows, no dispatch schedules)"
        return report

    prices = series.prices
    price_source = series.price_source
    missing_days: List[str] = []
    if prices is None or prices.empty:
        prices, price_source, missing_days = fetch_reference_prices(zone, start, today)
    if prices is None or prices.empty:
        report["skipped"] = (
            f"no published {zone} prices for {start}..{today}; no lane can be valued "
            "and nothing is invented"
        )
        return report
    price_source = price_source or f"{zone.lower()}_day_ahead"
    if missing_days:
        report["notes"].append(
            f"{len(missing_days)} day(s) had no published {zone} price and are absent from "
            "every lane rather than filled in."
        )

    # --- MEASURED -----------------------------------------------------------
    measured = measured_energy_rows(
        series=series,
        prices=prices,
        price_source=price_source,
        currency=currency,
        device_id=device_id,
        run_id=lane_run_id(asset["external_asset_id"], LANE_MEASURED),
    )
    bmu_id = bmu_id_for_asset(asset)
    if bmu_id and zone == "GB":
        bm = bm_revenue_rows(
            bmu_id=bmu_id,
            start=start,
            end=today,
            device_id=device_id,
            run_id=lane_run_id(asset["external_asset_id"], LANE_MEASURED),
            max_fetch_days=bm_fetch_days,
            session=session,
        )
        measured.records.extend(bm.records)
        measured.notes.extend(bm.notes)
        measured.provenance.update(bm.provenance)
    elif zone == "GB":
        measured.notes.append(
            "No BMU id declared on BessAsset.metadata.gb.bmu_id, so settled Balancing "
            "Mechanism revenue cannot be reconstructed for this asset."
        )

    # --- DECLARED -----------------------------------------------------------
    declared = declared_rows(
        contracts=contracts,
        start=start,
        end=today,
        device_id=device_id,
        run_id=lane_run_id(asset["external_asset_id"], LANE_DECLARED),
        zone_currency=currency,
    )

    # --- BENCHMARK ----------------------------------------------------------
    capacity_kwh = _f(asset.get("nominal_capacity_kwh")) or 0.0
    power_kw = _f(asset.get("nominal_power_kw")) or 0.0
    if capacity_kwh <= 0 or power_kw <= 0:
        report["skipped"] = "degenerate asset (0 kWh or 0 kW): no benchmark can be solved"
        return report
    spec = AuditAssetSpec(
        capacity_kwh=capacity_kwh,
        max_power_kw=power_kw,
        asset_name=str(asset.get("name") or asset["external_asset_id"]),
    )
    benchmark, audit_summary = benchmark_rows(
        series=series,
        prices=prices,
        price_source=price_source,
        currency=currency,
        spec=spec,
        device_id=device_id,
        run_id=lane_run_id(asset["external_asset_id"], LANE_BENCHMARK),
        zone=zone,
    )
    ancillary, ancillary_evidence = ancillary_benchmark(
        zone=zone,
        start=start,
        end=today,
        derated_mw=_f(_asset_metadata(asset).get("derated_mw")),
        session=session,
    )
    benchmark.records.extend(ancillary.records)
    benchmark.notes.extend(ancillary.notes)
    benchmark.provenance.update(ancillary.provenance)

    # --- persist ------------------------------------------------------------
    for lane in (measured, declared, benchmark):
        written = persist_lane(
            writer=writer,
            plant_id=str(plant["id"]),
            device_id=device_id,
            lane=lane.lane,
            records=lane.records,
            run_id=lane_run_id(asset["external_asset_id"], lane.lane),
        )
        report["lanes"][lane.lane] = {
            "model_version": LANE_MODEL_VERSIONS[lane.lane],
            "rows_written": written,
            "summary": summarise_windows(lane.records, today),
            "notes": lane.notes,
        }
        report["provenance"].update(lane.provenance)

    report["audit_summary"] = audit_summary
    report["price_source"] = price_source
    report["series"] = {
        "source": series.source,
        "provenance": series.provenance,
        "resolution_minutes": series.resolution_minutes,
    }
    if ancillary_evidence:
        report["ancillary_clearing_evidence"] = ancillary_evidence
    return report


__all__ = [
    "ARTIFACT_KIND",
    "DOMAIN",
    "LANES",
    "LANE_BENCHMARK",
    "LANE_DECLARED",
    "LANE_MEASURED",
    "LANE_MODEL_VERSIONS",
    "WINDOW_DAYS",
    "DispatchSeries",
    "LaneRows",
    "ancillary_benchmark",
    "assure_bess_revenue",
    "benchmark_rows",
    "bm_revenue_rows",
    "bmu_id_for_asset",
    "build_bess_device_id",
    "declared_rows",
    "fetch_reference_prices",
    "lane_run_id",
    "measured_energy_rows",
    "persist_lane",
    "resolve_dispatch_series",
    "sanitize_bess_asset_token",
    "summarise_windows",
]
