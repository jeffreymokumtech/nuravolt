"""Real BESS intelligence — the battery counterpart of the PV twin, wired to the
actual `nuravolt.bess` engine instead of toy math.

It supersedes a placeholder generator (since deleted) that wrote crude values
straight to the DB: charge-cheapest-3h dispatch; SoH = 1 - 0.02*yrs -
0.00004*cycles; hardcoded temp 25C / DoD 0.8 / RTE 0.88. The asset-provisioning
helper that generator carried now lives in `nuravolt/pipeline/bess_assets.py`
(`ensure_bess_asset`). This module runs the genuine algorithms and writes their
real output to the same tables (idempotent, same unique keys):

  BessDispatchSchedule  DegradationAwareArbitrage (revenue - degradation cost)
                        over REAL day-ahead prices for the plant's bidding zone
                        (OMIE for ES/PT, Elexon for GB).
  BessCycleRecord       real ASTM E1049 rainflow cycling — populates the
                        previously-unused `rainflow_data` (DoD histogram).
  BessCapacityTest      SoH points from the chemistry EmpiricalDegradationModel.
  BessWarrantyStatus    real composite warranty health score + EOL + RUL (the
                        placeholder wrote none, so the warranty UI fell to defaults).
  BessWarrantyViolation real violation detection.
  BessAsset.current_soh from the degradation model, plus
                        BessAsset.installation_date from the resolved
                        commissioning date (see `resolve_installation_date`)
                        and BessAsset.current_soc cleared to NULL (see
                        "NO LIVE STATE" below).
  AnalysisArtifact      kind 'bess_state_of_safety' — the worst-of safety
                        composite the pipeline already computed but nobody
                        persisted, so the console could only ever say "not
                        published". See `state_of_safety_payload`.

Zone-aware, not euro-and-hourly-aware: the price router
(`nuravolt.pipeline.market_prices`) returns 24 hourly EUR/MWh periods for
Iberia and 48 half-hourly GBP/MWh periods for GB. Every energy figure here is
derived from `power_kw * resolution_minutes / 60`, and the persisted rows carry
`resolution_minutes` plus an explicit `currency` so a GB row is never read as
euro.

HONESTY BOUNDARY: this is a PROVISIONAL twin — real algorithms on real prices, but
NO BMS telemetry exists. The operating profile (SoC/power/temperature) is MODELLED
from the optimizer against real prices, not measured. Asset metadata is tagged
`{"provisional": true, "engine": "nuravolt.bess", "price_source": ...}`, every
persisted row carries provenance 'modelled', and every UI surface labels it as
modelled, never as measured hardware.

ONE COMMISSIONING DATE: the asset's `installation_date` is the clock every
calendar-age number hangs off, on two independent paths. The warranty tracker
reads `BessAssetConfig.installation_date` to write
`BessWarrantyStatus.years_remaining`, from which the console draws its
"Calendar age" bar; and the warranty route falls back to
`BessAsset.installation_date` when no snapshot exists yet. Those two used to be
set independently, so the row said the battery was installed today while its
own history ran back a year, and the tracker read a third value again.
`resolve_installation_date` is now the single answer for both, and the modelled
window is truncated so it can never begin before the date it resolves to. A
battery cannot have operated before it was installed.

NO LIVE STATE: `current_soc` is left NULL on a modelled asset. State of charge
is by definition an instantaneous reading, and no BMS is connected, so there is
no such reading to serve. The optimizer's end-of-day SoC is a plan, not a
state: publishing it into the column the console captions "state of charge"
would put a modelled intention where an operator expects live hardware, and it
would go stale silently because that tile carries no timestamp. The modelled
profile is not lost by clearing the column — it is persisted per day in
`BessDispatchSchedule.soc_schedule`, where it is labelled modelled and dated,
and that is what the SoC chart already reads. Absent is the honest answer, and
absent is not zero.

TELEMETRY REGIME: "when real BMS data arrives it replaces these rows" used to be
aspirational and dangerous. The nightly sweep re-runs onboarding for every plant,
and this module writes on the same unique keys a measured pipeline uses, so real
telemetry would have been silently overwritten by modelled data every night.
It no longer can: `synthesize_bess_history` reads the asset's telemetry regime
(`nuravolt.pipeline.bess_measured.TelemetryRegime`) and writes nothing on or
after `first_measured_date`. Pre-connection history stays modelled and stays
labelled; the measured pipeline owns the complement, exactly.
"""

from __future__ import annotations

import json
import math
import uuid
from datetime import date, datetime, timedelta, timezone
from dataclasses import replace
from typing import Any, Dict, List

import numpy as np
import psycopg2.extras
from psycopg2.extensions import AsIs, register_adapter

# The nuravolt.bess optimizer/rainflow are numpy-internal, so many computed values
# are numpy scalars. psycopg2 can't adapt those (it would str() them to
# "np.float64(...)" and break the SQL), so register plain-number adapters once.
register_adapter(np.float64, lambda v: AsIs(repr(float(v))))
register_adapter(np.float32, lambda v: AsIs(repr(float(v))))
register_adapter(np.int64, lambda v: AsIs(str(int(v))))
register_adapter(np.int32, lambda v: AsIs(str(int(v))))

from nuravolt.bess import safety_artifact
from nuravolt.db.writer import write_artifact
from nuravolt.pipeline.bess_assets import ensure_bess_asset
from nuravolt.pipeline.bess_measured import regime_from_asset
from nuravolt.pipeline.market_prices import (
    PriceFetchError,
    day_ahead_periods,
    price_source,
    zone_for_country,
    zone_spec,
)
from nuravolt.bess.config import BessAssetConfig, BESSPipelineConfig, BessChemistry
from nuravolt.bess.pipeline import BESSIntelligencePipeline
from nuravolt.bess.arbitrage_optimizer import DegradationAwareArbitrage
from nuravolt.bess.thermal_monitor import StateOfSafety
from nuravolt.bess.warranty_tracker import EmpiricalDegradationModel

ENGINE = "nuravolt.bess"
DEFAULT_ZONE = "ES"
PROVENANCE = "modelled"  # never 'measured': no BMS telemetry exists yet
WARRANTY_SOH_THRESHOLD = 0.70
RISK_LEVELS = {"LOW", "MODERATE", "HIGH", "CRITICAL"}
# Python ViolationType.value maps 1:1 to the Prisma WarrantyViolationType enum.
VIOLATION_TYPES = {
    "TEMPERATURE_EXCEED", "SOC_HIGH_DWELL", "SOC_LOW_DWELL", "CYCLING_DEPTH",
    "CYCLING_FREQUENCY", "C_RATE_EXCEED", "VOLTAGE_VIOLATION", "THROUGHPUT_EXCEED",
    "HVAC_FAILURE", "RTE_DEGRADATION", "CAPACITY_DEGRADATION",
}

# --- State of safety artifact ---------------------------------------------
#
# The composite itself is nuravolt.bess.pipeline's (worst-of over four sub
# indices) and the envelope is nuravolt.bess.safety_artifact's, shared with the
# measured publisher in nuravolt/pipeline/bess_measured.py. This module is one
# of its two callers: the modelled one. The constants below keep their existing
# names because the console, the tests and the audit route all speak them.
SAFETY_ARTIFACT_KIND = safety_artifact.SAFETY_ARTIFACT_KIND
SAFETY_MODEL_VERSION = safety_artifact.SAFETY_MODEL_VERSION
#: What every published sub index was actually computed from. Not measured.
SAFETY_BASIS = safety_artifact.MODELLED_BASIS
SAFETY_BASIS_LABEL = safety_artifact.MODELLED_BASIS_LABEL
SAFETY_BASIS_NOTES = safety_artifact.MODELLED_BASIS_NOTES
SAFETY_BASIS_NOTE_DEFAULT = safety_artifact.MODELLED_BASIS_NOTE_DEFAULT
SAFETY_PROVENANCE_NOTE = safety_artifact.MODELLED_PROVENANCE_NOTE

#: Numpy/date/NaN scrubbing for jsonb, shared with the envelope it feeds.
_jsonable = safety_artifact.jsonable


def state_of_safety_payload(
    sos: StateOfSafety,
    *,
    asset_db_id: str,
    external_asset_id: str,
    asset_name: Any = None,
    interval_minutes: Any = None,
    window: Any = None,
    zone: str = DEFAULT_ZONE,
    price_src: Any = None,
) -> Dict[str, Any]:
    """The shared envelope, filled in with this twin's modelled basis.

    Every honesty rule lives in nuravolt.bess.safety_artifact and is pinned by
    tests/bess/test_state_of_safety_artifact.py. What this wrapper adds is the
    one thing the measured publisher must NOT inherit: the statement that every
    sub index here came off a modelled dispatch profile, that none of it was
    measured, and that no sub asset telemetry existed at all.
    """
    return safety_artifact.state_of_safety_payload(
        sos,
        asset_db_id=asset_db_id,
        external_asset_id=external_asset_id,
        basis=SAFETY_BASIS,
        basis_label=SAFETY_BASIS_LABEL,
        asset_name=asset_name,
        interval_minutes=interval_minutes,
        window=window,
        window_key=safety_artifact.WINDOW_KEY_MODELLED,
        basis_notes=SAFETY_BASIS_NOTES,
        basis_note_default=SAFETY_BASIS_NOTE_DEFAULT,
        provenance_note=SAFETY_PROVENANCE_NOTE,
        provisional=True,
        measured=False,
        sub_asset_telemetry="absent",
        engine=ENGINE,
        zone=zone,
        price_src=price_src,
    )


def _chemistry(value: Any) -> BessChemistry:
    try:
        return BessChemistry(str(value).lower())
    except ValueError:
        return BessChemistry.LFP


def cabinet_temp_series(day: date, period_minutes: int = 60) -> List[float]:
    """Deterministic HVAC-controlled cabinet temperature (°C), one value per period.

    A BESS thermal-management system holds the cells in a tight band (not ambient
    tracking), so this is a mild seasonal + diurnal drift around ~23 °C, well
    inside the 35 °C warranty limit. Modelled, not measured — the honesty
    boundary. No RNG so reruns are byte-identical.

    The diurnal shape is a function of the hour of day, so a half-hourly series
    samples the same curve twice as often rather than stretching it over two
    days. At the 60-minute default the output is identical to the hourly
    version this replaced.
    """
    if period_minutes <= 0 or 1440 % period_minutes:
        raise ValueError(
            f"period_minutes must divide a 1440-minute day evenly, got {period_minutes}"
        )
    doy = day.timetuple().tm_yday
    base = 23.0 + 1.5 * math.cos(2 * math.pi * (doy - 197) / 365)  # 21.5..24.5 seasonal
    n_periods = 1440 // period_minutes
    hours = [i * period_minutes / 60.0 for i in range(n_periods)]
    return [round(base + 1.2 * math.sin((h - 15) / 24.0 * 2 * math.pi), 2) for h in hours]


def _dod_histogram(rainflow_cycles: List[dict]) -> dict:
    """Bucket rainflow cycle depths into a real DoD histogram (10% bins)."""
    edges = [i / 10 for i in range(11)]  # 0.0 .. 1.0
    buckets = [0.0] * 10
    total = 0.0
    for c in rainflow_cycles:
        rng = float(c.get("range", 0.0))
        cnt = float(c.get("count", 0.0))
        idx = min(9, max(0, int(rng * 10)))
        buckets[idx] += cnt
        total += cnt
    return {
        "method": "astm_e1049_rainflow",
        "n_cycles": round(total, 2),
        "buckets": [
            {"dod_min": edges[i], "dod_max": edges[i + 1], "cycles": round(buckets[i], 3)}
            for i in range(10)
        ],
    }


def _as_date(value: Any) -> date:
    """Normalize an explicit cutoff (date, datetime or ISO string) to a date.

    `datetime` is a subclass of `date`, so an unconverted datetime would slip
    through an isinstance check and then blow up on the first date comparison.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


# --- Commissioning date ----------------------------------------------------
#
# `BessAsset.metadata.installation_date_source` records where the date on the
# row came from, exactly as `warranty_terms_source` does for the terms row.
INSTALLATION_DATE_SOURCE_KEY = "installation_date_source"

#: Sources that are a real claim about the hardware. Never overwritten here.
DECLARED_INSTALLATION_SOURCES = frozenset(
    {"operator_declared", "contract", "oem_api", "measured"}
)
#: A date left by a writer that recorded no source (the seed scripts, an older
#: run of the setup script, a future integration that forgets the key). Kept
#: whenever it is possible, so this pipeline can repair the impossible case
#: without trampling everything else.
SOURCE_EXISTING_UNATTRIBUTED = "existing_unattributed"
#: What this pipeline writes when nobody has made such a claim.
SOURCE_PLANT_COMMISSIONING = "plant_commissioning"
SOURCE_MODELLED_WINDOW = "modelled_window_start"

#: Every source string this file understands. A kept date keeps its label:
#: without this, the run after the one that wrote `modelled_window_start`
#: would relabel its own derivation as unattributed, and the caption
#: "not a commissioning record" would quietly fall off the number.
KNOWN_INSTALLATION_SOURCES = DECLARED_INSTALLATION_SOURCES | {
    SOURCE_EXISTING_UNATTRIBUTED,
    SOURCE_PLANT_COMMISSIONING,
    SOURCE_MODELLED_WINDOW,
}


def _asset_metadata(asset: Dict[str, Any]) -> Dict[str, Any]:
    """BessAsset.metadata as a dict, whether it arrives as jsonb or as text."""
    meta = asset.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (TypeError, ValueError):
            meta = None
    return meta if isinstance(meta, dict) else {}


def plant_commissioning_date(conn, plant: Dict[str, Any]) -> Any:
    """`Plant.commissioning_date`, read from the DB when the caller omitted it.

    The call sites select different plant columns (the backfill script asks for
    six, onboarding passes a fuller row), and a missing key is not the same
    fact as a null column. Without this a commissioned plant would silently
    fall through to the modelled-window fallback depending on which script ran.
    """
    if "commissioning_date" in plant:
        return plant["commissioning_date"]
    with conn.cursor() as cur:
        cur.execute('SELECT commissioning_date FROM "Plant" WHERE id = %s', (plant["id"],))
        row = cur.fetchone()
    return row[0] if row else None


def resolve_installation_date(
    plant: Dict[str, Any], asset: Dict[str, Any], window_start: date
) -> tuple[date, str]:
    """The date this asset's calendar clocks run from, and where it came from.

    Precedence, best evidence first:

      1. A declared date already on the row (operator, contract, OEM API or a
         measured commissioning record). A human's or an integration's claim
         about the hardware always wins; this pipeline models dispatch, it does
         not know when a battery was bolted down.
      2. An unattributed date already on the row, as long as it is possible,
         meaning not after the window it has history for. The seed scripts and
         older setup runs left dates without recording a source, and those are
         still somebody's claim. Only the impossible ones are overwritten.
      3. `Plant.commissioning_date`, when the plant carries one. The battery is
         co-located with the plant, and the plant header already shows this
         date, so taking it keeps one date on the screen rather than two.
      4. The start of the modelled window. Not a commissioning record, and
         labelled as such, but it is the earliest day this asset demonstrably
         has history for, which is the weakest claim that is still true.

    Never `today`. A date of today on an asset carrying a year of history is
    the specific contradiction this function exists to remove: it made the
    console render a battery that had operated for 396 days before it existed.

    Returns (date, source). The source is written to
    `metadata.installation_date_source` so the next run can tell its own
    derivation from somebody else's evidence and leave the latter alone.
    """
    meta = _asset_metadata(asset)
    recorded = str(meta.get(INSTALLATION_DATE_SOURCE_KEY) or "").strip()
    stored = _as_date(asset["installation_date"]) if asset.get("installation_date") else None

    if stored is not None and recorded in DECLARED_INSTALLATION_SOURCES:
        return stored, recorded
    if stored is not None and stored <= window_start:
        # Keeping the date keeps its label. The window start walks forward a
        # day at a time, so a date this pipeline derived once stays put; it
        # must not be relabelled as somebody else's claim on the second run.
        return stored, (
            recorded if recorded in KNOWN_INSTALLATION_SOURCES else SOURCE_EXISTING_UNATTRIBUTED
        )

    commissioned = plant.get("commissioning_date")
    if commissioned:
        return _as_date(commissioned), SOURCE_PLANT_COMMISSIONING

    return window_start, SOURCE_MODELLED_WINDOW


def clamp_window_start(default_start: date, install_date: date, install_source: str) -> date:
    """The first day the twin may model, given when the asset was installed.

    A battery cannot have operated before it was installed, so a real
    commissioning date later than the default window truncates the window to
    it. The modelled fallback is exempt because it *is* the window start, and
    clamping the window to a date derived from the window would be circular.
    """
    if install_source != SOURCE_MODELLED_WINDOW and install_date > default_start:
        return install_date
    return default_start


def resolve_zone(plant: Dict[str, Any], zone: Any = None) -> str:
    """Bidding zone for a plant: explicit argument, else its country, else ES.

    An unmapped country falls back to the default rather than raising, because
    the dispatch twin is provisional anyway; the zone it actually used is
    written into the asset metadata so nobody has to guess afterwards.
    """
    if zone:
        return str(zone).strip().upper()
    return zone_for_country(plant.get("country")) or DEFAULT_ZONE


def synthesize_bess_history(conn, plant: Dict[str, Any], days: int = 395,
                            zone: Any = None, telemetry_cutoff: Any = None) -> Dict[str, Any]:
    """Run the real nuravolt.bess pipeline for the plant's BESS asset and persist it.

    Kept under the historical name `synthesize_bess_history` so the onboarding,
    seed and backfill call sites need no change. Idempotent per (asset, date).

    The bidding zone decides both the currency and the settlement period: ES/PT
    give 24 hourly EUR periods, GB gives 48 half-hourly GBP ones. Days the zone
    has no published prices for are skipped and counted, not filled in.

    `telemetry_cutoff` is the first day this function must NOT write. Passing
    None reads it from the asset's telemetry regime, which is what every
    scheduled caller wants; pass a date explicitly only to override. Nothing on
    or after the cutoff is written to ANY table, including the dispatch
    schedules: a modelled plan over a measured day is a different product
    decision, and silently interleaving the two would make the provenance
    column meaningless.
    """
    import polars as pl  # local import: heavy, and keeps --help cheap

    market_zone = resolve_zone(plant, zone)
    currency, period_minutes = zone_spec(market_zone)
    period = timedelta(minutes=period_minutes)
    periods_expected = 1440 // period_minutes

    asset = ensure_bess_asset(conn, plant)
    regime = regime_from_asset(asset)
    cutoff = _as_date(telemetry_cutoff) if telemetry_cutoff is not None else regime.synthesis_cutoff
    cap = float(asset["nominal_capacity_kwh"])
    power = float(asset["nominal_power_kw"])
    chem = _chemistry(asset.get("chemistry", "LFP"))
    if cap <= 0 or power <= 0:
        return {"asset_id": asset["id"], "skipped": "degenerate asset (0 kWh/kW)"}

    start = date.today() - timedelta(days=days)
    # A battery cannot have operated before it was installed, so a real
    # commissioning date later than the default window truncates the window
    # rather than being ignored. The other direction needs no clamp:
    # `resolve_installation_date` falls back to the window start, so a resolved
    # date is never later than the history it describes.
    install_date, install_source = resolve_installation_date(
        {**plant, "commissioning_date": plant_commissioning_date(conn, plant)},
        asset,
        start,
    )
    start = clamp_window_start(start, install_date, install_source)
    if start > date.today():
        return {
            "asset_id": asset["id"],
            "installation_date": install_date.isoformat(),
            "installation_date_source": install_source,
            "skipped": (
                f"installation date {install_date.isoformat()} is in the future; "
                "there is no operating history to model"
            ),
        }
    # The modelled window ends the day before measured telemetry takes over.
    last_modelled = date.today()
    if cutoff is not None:
        if cutoff <= start:
            return {
                "asset_id": asset["id"],
                "telemetry_regime": regime.as_dict(),
                "telemetry_cutoff": cutoff.isoformat(),
                "skipped": (
                    f"measured telemetry owns every day from {cutoff.isoformat()}; "
                    "synthesis writes nothing"
                ),
            }
        last_modelled = min(last_modelled, cutoff - timedelta(days=1))
    asset_cfg = BessAssetConfig(
        asset_id=asset["id"], plant_id=str(plant["id"]),
        name=asset.get("name") or plant["slug"], chemistry=chem,
        nominal_capacity_kwh=cap, nominal_power_kw=power,
        # Simulation seeds, not readings: the run starts the battery half full
        # at beginning-of-life health and lets the optimizer and the
        # degradation model carry both forward from there.
        current_soh=1.0, current_soc=0.5,
        # The same date that lands on BessAsset.installation_date below. The
        # warranty tracker subtracts this from now() to get years_remaining,
        # which is the number the console's "Calendar age" bar renders, so the
        # row and the bar cannot disagree.
        installation_date=datetime(install_date.year, install_date.month, install_date.day),
    )
    cfg = BESSPipelineConfig(asset=asset_cfg)
    # Operate in a conservative SoC band (a real BESS rarely rests at 0.10/0.90);
    # keeps SoC clear of the low/high-dwell warranty thresholds so the modelled
    # profile isn't riddled with artefact violations.
    cfg.arbitrage.min_soc = 0.20
    cfg.arbitrage.max_soc = 0.88
    # The settlement period is what turns power into energy. Leaving this at the
    # 60-minute default while feeding 30-minute GB periods would price every
    # half hour as a full hour and double the modelled revenue.
    #
    # The zone gives the expected resolution, but a market can publish a day at a
    # finer one: Iberia moved to a 15-minute MTU, so ES days now arrive as 96
    # periods rather than 24. The optimizer is period-agnostic, so rather than
    # discard those days the loop rebuilds it at whatever length the day actually
    # cleared on. `_optimizer_for` caches one instance per length, since building
    # it per day for a year of history is pure overhead.
    cfg.arbitrage.time_resolution_minutes = period_minutes
    cfg.arbitrage.currency = currency

    _optimizers: Dict[int, DegradationAwareArbitrage] = {}

    def _optimizer_for(minutes: int) -> DegradationAwareArbitrage:
        opt = _optimizers.get(minutes)
        if opt is None:
            day_cfg = replace(cfg.arbitrage, time_resolution_minutes=minutes)
            opt = DegradationAwareArbitrage(day_cfg)
            _optimizers[minutes] = opt
        return opt

    # 1. Grounded operating series: real optimizer over real day-ahead prices,
    #    day by day, at the zone's own settlement resolution.
    op_rows: List[dict] = []
    daily: List[tuple] = []  # (date, DispatchSchedule, price_source)
    soc = 0.5
    soh_running = 1.0
    sources = set()
    missing_days: List[str] = []
    mismatched_days: List[str] = []
    for i in range((last_modelled - start).days + 1):
        d = start + timedelta(days=i)
        try:
            curve = day_ahead_periods(d, market_zone)
        except PriceFetchError:
            # GB has no synthetic rung by design. A day with no published
            # prices is skipped and counted, never invented.
            missing_days.append(d.isoformat())
            continue
        prices = np.asarray(curve["prices"], dtype=float)
        day_minutes = int(curve["resolution_minutes"])
        # Trust the day's own resolution, but only when it is internally
        # consistent: the period count has to match the length it claims, or the
        # energy conversion would be wrong by exactly that ratio (48 half hours
        # costed as hours doubles revenue, 96 quarter hours quadruples it).
        if day_minutes <= 0 or 1440 % day_minutes != 0 or len(prices) != 1440 // day_minutes:
            mismatched_days.append(d.isoformat())
            continue
        temps = np.asarray(cabinet_temp_series(d, day_minutes), dtype=float)[: len(prices)]
        sched = _optimizer_for(day_minutes).optimize(
            prices=prices, initial_soc=soc, current_soh=soh_running,
            warranty_margin=max(0.0, soh_running - WARRANTY_SOH_THRESHOLD),
            temp_forecast=temps, schedule_date=datetime(d.year, d.month, d.day),
        )
        charge, discharge, socs = sched.charge_schedule_kw, sched.discharge_schedule_kw, sched.soc_schedule
        day_start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        # Step at the day's own resolution, not the zone default: on a 15-minute
        # day a 60-minute step would spread 96 samples across four days and the
        # rainflow counter would read the SoC trace as a much slower cycle.
        day_period = timedelta(minutes=day_minutes)
        for k in range(len(socs)):
            p = float(discharge[k]) + float(charge[k])  # discharge +, charge -
            op_rows.append({
                "timestamp": day_start + k * day_period,
                "soc": float(socs[k]), "power_kw": p,
                "temperature_c": float(temps[k]) if k < len(temps) else 25.0,
            })
        # Carry the state AFTER the last slot, not the state at its start.
        # soc_schedule[k] is the state entering slot k, so socs[-1] predates the
        # final slot's own energy: that slot was spent in the power trace and
        # then refunded to the ledger, and the error compounded across every
        # modelled day. DispatchSchedule.final_soc is the closing state.
        soc = float(sched.final_soc) if sched.final_soc is not None else (
            float(socs[-1]) if socs else soc
        )
        sources.add(str(curve["price_source"]))
        daily.append((d, sched, str(curve["price_source"])))

    if not daily:
        n_days = (last_modelled - start).days + 1
        return {
            "asset_id": asset["id"],
            "telemetry_regime": regime.as_dict(),
            "skipped": (
                f"no usable {market_zone} prices for any of the {n_days} modelled days: "
                f"{len(missing_days)} unpublished, {len(mismatched_days)} at a settlement "
                f"resolution other than {period_minutes} min"
            ),
        }

    # 2. Real cycling + warranty + violations via the nuravolt.bess pipeline.
    df = pl.DataFrame(op_rows)
    pipe = BESSIntelligencePipeline(cfg)
    pipe.load_data(df, column_mapping={
        "timestamp": "timestamp", "soc": "soc", "power": "power_kw", "temp": "temperature_c",
    })
    pipe.run_warranty_analysis()
    pipe.run_violation_detection()
    cycle_records = pipe.run_cycling_analysis()  # List[CycleRecord] with rainflow_cycles

    # 3. SoH trajectory from the chemistry degradation model over REAL cumulative cycles.
    degm = EmpiricalDegradationModel(chemistry=chem.value)
    cum_cycles = 0.0
    cum_through = 0.0
    # Round-trip efficiency on a MODELLED asset is a model input, not a
    # measurement, and it must not be back-derived from the dispatch trace.
    #
    # Two reasons. The optimizer's SoC schedule already has the efficiency
    # applied and then drops its final state, so a day's start and end SoC do
    # not close an energy balance: deriving out/in from it produced values above
    # 100% before, and exactly 1.0 (a lossless battery) after the balance fix.
    # Both are fiction. The honest figure is the efficiency the twin actually
    # ran at, which is the product of the configured charge and discharge
    # efficiencies. It is reported for what it is, since every row this pipeline
    # writes already carries provenance 'modelled'.
    #
    # cycling_analysis.py keeps the real energy-balance derivation for the day
    # measured BMS telemetry arrives; bess_measured.py uses that path.
    modelled_rte = round(
        float(cfg.arbitrage.charge_efficiency) * float(cfg.arbitrage.discharge_efficiency), 4
    )

    per_day: List[dict] = []
    soh_series: List[tuple] = []  # (date, soh) for RUL
    for rec in cycle_records:
        rec_date = rec.date.date()
        cum_cycles += float(rec.equivalent_cycles)
        cum_through += float(rec.energy_in_kwh) + float(rec.energy_out_kwh)
        # Calendar fade runs from installation, not from the first day this
        # twin happens to model. On an asset commissioned before the modelled
        # window those are different dates, and the window start would understate
        # the age the cells have actually sat at.
        yrs = max(0.02, (rec_date - install_date).days / 365.25)
        soh = float(degm.predict_soh(cum_cycles, yrs, rec.avg_temp_c, rec.avg_dod or 0.5))
        soh_series.append((rec_date, soh))
        per_day.append({
            "date": rec_date, "rec": rec,
            "cum_cycles": cum_cycles, "cum_through": cum_through, "soh": soh,
        })
    soh_now = soh_series[-1][1] if soh_series else 1.0

    # 4. Real composite health score (feed the estimated SoH into the tracker).
    pipe.asset.current_soh = soh_now
    pipe.warranty_tracker.measure_capacity(cap * soh_now)
    health = pipe.calculate_health_score()
    risk = health.risk_level if health.risk_level in RISK_LEVELS else "MODERATE"

    # 4b. State of safety: worst-of over thermal margin, imbalance, dwell
    #     exposure and protection status, on the same pipeline instance that
    #     just detected the violations two of those sub indices are built from.
    #     Imbalance needs rack level channels and protection status needs an
    #     HVAC or alarm channel. THIS path loads neither: it never calls
    #     load_rack_samples, because a modelled dispatch profile has no rack
    #     members to be imbalanced between. Both therefore come back unavailable
    #     with their reason, which is the honest answer and is not a score of
    #     zero. The measured path DOES load rack channels, from silver, in
    #     nuravolt/pipeline/bess_measured.py::materialize_measured_imbalance;
    #     it publishes the same artifact on the measured basis.
    safety_interval = pipe.telemetry_interval_minutes()
    sos = pipe.calculate_state_of_safety(interval_minutes=safety_interval)

    # 5. RUL: days-to-warranty-threshold from the capacity-fade model over the SoH history.
    proj_cycles_to_eol = int(max(0.0, health.cycles_remaining or 0.0))
    try:
        import pandas as pd
        from nuravolt.fault.bess_rul_models import RULCapacityFadeModel

        rul = RULCapacityFadeModel(warranty_threshold=WARRANTY_SOH_THRESHOLD).predict(
            pd.DataFrame([{"date": d.isoformat(), "soh": s} for d, s in soh_series])
        )
        days_to_eol = rul.get("days_to_fault")
        if days_to_eol and days_to_eol > 0:
            # cycles/day from the modelled dispatch → cycles until EOL
            cyc_per_day = cum_cycles / max(1, len(cycle_records))
            proj_cycles_to_eol = int(days_to_eol * cyc_per_day)
    except Exception:  # noqa: BLE001 — RUL is a bonus; the tracker projection stands
        pass

    # 6. Persist. Tag the asset honestly first.
    real_sources = sorted(s for s in sources if s != "synthetic")
    price_src = ("omie" if "omie" in sources
                 else (real_sources[0] if real_sources
                       else (sorted(sources)[0] if sources else price_source())))
    meta_patch: Dict[str, Any] = {
        "provisional": True, "engine": ENGINE, "price_source": price_src,
        "zone": market_zone, "currency": currency,
        "resolution_minutes": period_minutes,
        "duration_h": round(cap / power, 2) if power else None,
        INSTALLATION_DATE_SOURCE_KEY: install_source,
    }
    if cutoff is None:
        # Say in the metadata what the null column means, so a reader of the
        # row alone does not have to guess whether the SoC is missing or the
        # battery is empty.
        meta_patch["current_soc_source"] = "unavailable_no_bms"
        meta_patch["current_soc_note"] = (
            "State of charge is a live reading and no BMS is connected, so the column is "
            "left empty rather than filled with the optimizer's planned end-of-day SoC. "
            "The modelled SoC profile is in BessDispatchSchedule.soc_schedule, dated and "
            "labelled modelled."
        )
    modelled_meta = json.dumps(meta_patch)
    with conn.cursor() as cur:
        # Merge, never replace: a wholesale `metadata = %s` would drop the
        # telemetry regime block this run just read, and the next night the
        # asset would look modelled again and overwrite real telemetry.
        # The resolved commissioning date is written on both paths. On a
        # declared source it is that source's own date going back where it
        # belongs; on the modelled fallback it is the first day of the history
        # this run just wrote. Either way the row stops contradicting itself.
        install_dt = datetime(install_date.year, install_date.month, install_date.day)
        if cutoff is None:
            # current_soc is cleared, not set: see NO LIVE STATE in the module
            # docstring. It is the one headline column this pipeline can only
            # answer with a modelled intention, and a modelled intention has no
            # business in a field the console captions "state of charge".
            cur.execute(
                'UPDATE "BessAsset" SET metadata = COALESCE(metadata, \'{}\'::jsonb) || %s::jsonb, '
                'current_soh = %s, current_soc = NULL, installation_date = %s, '
                'last_updated = NOW(), updated_at = NOW() '
                'WHERE id = %s',
                (modelled_meta, round(soh_now, 4), install_dt, asset["id"]),
            )
        else:
            # A measured window exists, so the asset's headline SoH and SoC
            # belong to the measured pipeline. Only the modelling context and
            # the commissioning date are recorded here.
            cur.execute(
                'UPDATE "BessAsset" SET metadata = COALESCE(metadata, \'{}\'::jsonb) || %s::jsonb, '
                'installation_date = %s, updated_at = NOW() WHERE id = %s',
                (modelled_meta, install_dt, asset["id"]),
            )

        # Dispatch schedules (real degradation-aware arbitrage over real prices).
        # horizon_hours is delivery hours, resolution_minutes the period length,
        # so 48 GB half-hours store as 24h @ 30min, not 48h @ 60min. The
        # revenue columns keep their legacy _eur suffix; `currency` is the
        # authoritative label and is set explicitly so a GB row never inherits
        # the 'EUR' column default.
        for d, sched, _src in daily:
            cur.execute(
                'INSERT INTO "BessDispatchSchedule" (id, asset_id, schedule_date, horizon_hours, resolution_minutes, '
                ' charge_schedule_kw, discharge_schedule_kw, soc_schedule, price_forecast, '
                ' expected_revenue_eur, degradation_cost_eur, net_revenue_eur, currency, expected_cycles, avg_dod, '
                ' optimizer_type, objective_function, status, warranty_constrained, max_cycles_constrained, provenance, created_at, updated_at) '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'max_net_revenue', %s, %s, false, %s, NOW(), NOW()) "
                'ON CONFLICT (asset_id, schedule_date) DO UPDATE SET '
                ' horizon_hours = EXCLUDED.horizon_hours, resolution_minutes = EXCLUDED.resolution_minutes, '
                ' charge_schedule_kw = EXCLUDED.charge_schedule_kw, discharge_schedule_kw = EXCLUDED.discharge_schedule_kw, '
                ' soc_schedule = EXCLUDED.soc_schedule, price_forecast = EXCLUDED.price_forecast, '
                ' expected_revenue_eur = EXCLUDED.expected_revenue_eur, degradation_cost_eur = EXCLUDED.degradation_cost_eur, '
                ' net_revenue_eur = EXCLUDED.net_revenue_eur, currency = EXCLUDED.currency, '
                ' expected_cycles = EXCLUDED.expected_cycles, avg_dod = EXCLUDED.avg_dod, '
                ' optimizer_type = EXCLUDED.optimizer_type, provenance = EXCLUDED.provenance, updated_at = NOW()',
                (
                    str(uuid.uuid4()), asset["id"], d,
                    int(sched.horizon_hours), int(sched.resolution_minutes),
                    json.dumps([round(x, 1) for x in sched.charge_schedule_kw]),
                    json.dumps([round(x, 1) for x in sched.discharge_schedule_kw]),
                    json.dumps([round(x, 4) for x in sched.soc_schedule]),
                    json.dumps([round(x, 2) for x in sched.price_forecast]),
                    round(sched.expected_revenue_eur, 2), round(sched.degradation_cost_eur, 2),
                    round(sched.net_revenue_eur, 2), sched.currency,
                    round(sched.expected_cycles, 4),
                    round(float(np.max(sched.soc_schedule) - np.min(sched.soc_schedule)), 4) if sched.soc_schedule else 0.0,
                    sched.optimizer_type, sched.status, cfg.arbitrage.respect_warranty_limits,
                    PROVENANCE,
                ),
            )

        # Cycle records (real rainflow, real rainflow_data histogram).
        for pd_row in per_day:
            if pd_row["date"] > last_modelled:
                continue
            rec = pd_row["rec"]
            socs = [c.get("mean", 0.5) for c in rec.rainflow_cycles] or [0.5]
            cur.execute(
                'INSERT INTO "BessCycleRecord" (id, asset_id, cycle_date, energy_in_kwh, energy_out_kwh, '
                ' equivalent_cycles, cumulative_cycles, cumulative_throughput_kwh, '
                ' avg_soc, max_soc, min_soc, avg_dod, avg_temp_c, max_temp_c, min_temp_c, '
                ' avg_c_rate, max_c_rate, round_trip_efficiency, high_soc_hours, high_temp_hours, rainflow_data, provenance, created_at) '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()) "
                'ON CONFLICT (asset_id, cycle_date) DO UPDATE SET '
                ' energy_in_kwh = EXCLUDED.energy_in_kwh, energy_out_kwh = EXCLUDED.energy_out_kwh, '
                ' equivalent_cycles = EXCLUDED.equivalent_cycles, cumulative_cycles = EXCLUDED.cumulative_cycles, '
                ' cumulative_throughput_kwh = EXCLUDED.cumulative_throughput_kwh, avg_dod = EXCLUDED.avg_dod, '
                ' avg_c_rate = EXCLUDED.avg_c_rate, round_trip_efficiency = EXCLUDED.round_trip_efficiency, '
                ' rainflow_data = EXCLUDED.rainflow_data, provenance = EXCLUDED.provenance',
                (
                    str(uuid.uuid4()), asset["id"], pd_row["date"],
                    round(rec.energy_in_kwh, 2), round(rec.energy_out_kwh, 2),
                    round(rec.equivalent_cycles, 4), round(pd_row["cum_cycles"], 2),
                    round(pd_row["cum_through"], 2),
                    round(float(np.mean(socs)), 4), round(float(np.max(socs)), 4), round(float(np.min(socs)), 4),
                    round(rec.avg_dod, 4), round(rec.avg_temp_c, 2),
                    round(rec.avg_temp_c + 3, 2), round(rec.avg_temp_c - 3, 2),
                    round(rec.avg_c_rate, 2), round(rec.avg_c_rate * 1.4, 2),
                    modelled_rte,
                    0.0, 0.0, json.dumps(_dod_histogram(rec.rainflow_cycles)), PROVENANCE,
                ),
            )

        # Capacity tests — quarterly SoH points along the real trajectory. No unique
        # key, so replace prior provisional 'estimated' points (avoids growth and
        # supersedes the SoH ladder the deleted placeholder generator wrote).
        # Scoped by provenance so a measured SoH point is never collateral damage.
        cur.execute(
            "DELETE FROM \"BessCapacityTest\" WHERE asset_id = %s AND test_type = 'estimated' "
            "AND provenance = %s",
            (asset["id"], PROVENANCE),
        )
        if soh_series:
            n = len(soh_series)
            for q in range(4):
                idx = min(n - 1, int(n * (q + 1) / 4) - 1)
                td, tsoh = soh_series[max(0, idx)]
                cur.execute(
                    'INSERT INTO "BessCapacityTest" (id, asset_id, test_date, measured_capacity_kwh, soh_result, '
                    " capacity_retention, test_type, is_valid, notes, provenance, created_at, updated_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, 'estimated', true, %s, %s, NOW(), NOW())",
                    (str(uuid.uuid4()), asset["id"], datetime(td.year, td.month, td.day),
                     round(cap * tsoh, 1), round(tsoh, 4), round(tsoh, 4),
                     "Provisional SoH from chemistry degradation model over modelled dispatch",
                     PROVENANCE),
                )

        # Warranty status snapshot (real composite health score + EOL + RUL),
        # dated at the last modelled day rather than at "today": a snapshot
        # describes the window it was computed from, and on a mixed asset today
        # belongs to the measured pipeline.
        # Same reasoning as modelled_rte above: on a modelled profile this is the
        # twin's configured efficiency, not a 30 day measurement.
        avg_rte = modelled_rte
        max_cycles = cfg.warranty_terms.max_cycles or 5000
        eol_date = health.projected_eol_date.date() if getattr(health, "projected_eol_date", None) else None
        cur.execute(
            'INSERT INTO "BessWarrantyStatus" (id, asset_id, snapshot_date, current_soh, warranty_threshold, soh_margin, '
            ' equivalent_full_cycles, total_throughput_mwh, cycle_usage_pct, time_usage_pct, years_remaining, '
            ' avg_rte_30d, warranty_health_score, risk_level, projected_eol_date, projected_cycles_to_eol, active_violations, provenance, created_at) '
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::\"WarrantyRiskLevel\", %s, %s, %s, %s, NOW()) "
            'ON CONFLICT (asset_id, snapshot_date) DO UPDATE SET '
            ' current_soh = EXCLUDED.current_soh, soh_margin = EXCLUDED.soh_margin, '
            ' equivalent_full_cycles = EXCLUDED.equivalent_full_cycles, total_throughput_mwh = EXCLUDED.total_throughput_mwh, '
            ' cycle_usage_pct = EXCLUDED.cycle_usage_pct, years_remaining = EXCLUDED.years_remaining, '
            ' avg_rte_30d = EXCLUDED.avg_rte_30d, warranty_health_score = EXCLUDED.warranty_health_score, '
            ' risk_level = EXCLUDED.risk_level, projected_eol_date = EXCLUDED.projected_eol_date, '
            ' projected_cycles_to_eol = EXCLUDED.projected_cycles_to_eol, active_violations = EXCLUDED.active_violations, '
            ' provenance = EXCLUDED.provenance',
            (
                str(uuid.uuid4()), asset["id"], last_modelled, round(soh_now, 4), WARRANTY_SOH_THRESHOLD,
                round(soh_now - WARRANTY_SOH_THRESHOLD, 4), round(cum_cycles, 2), round(cum_through / 1000, 2),
                round(min(1.0, cum_cycles / max_cycles), 4),
                # Calendar usage runs from installation, like years_remaining
                # beside it, not from the first modelled day. The two used to
                # be measured from different origins, so the same snapshot
                # could report an age and a remaining life that did not add up
                # to the warranty length.
                round(min(1.0, ((last_modelled - install_date).days / 365.25) / cfg.warranty_terms.warranty_years), 4),
                round(max(0.0, health.years_remaining or 0.0), 2),
                round(avg_rte, 4) if avg_rte is not None else None,
                round(float(health.score), 2), risk, eol_date, proj_cycles_to_eol,
                len([v for v in pipe.violations if not getattr(v, "is_resolved", False)]),
                PROVENANCE,
            ),
        )

        # Violations — real detection. Replace prior provisional (un-ticketed) rows.
        # The table has no provenance column, so the modelled window is scoped by
        # start time instead: a violation raised against measured telemetry must
        # survive a modelled re-run.
        if cutoff is None:
            cur.execute(
                'DELETE FROM "BessWarrantyViolation" WHERE asset_id = %s AND ticket_id IS NULL',
                (asset["id"],),
            )
        else:
            cur.execute(
                'DELETE FROM "BessWarrantyViolation" WHERE asset_id = %s AND ticket_id IS NULL '
                "AND started_at < %s",
                (asset["id"], datetime(cutoff.year, cutoff.month, cutoff.day, tzinfo=timezone.utc)),
            )
        for v in pipe.violations:
            vtype = str(getattr(v, "violation_type", "")).upper()
            if vtype not in VIOLATION_TYPES:
                continue
            started = getattr(v, "started_at", None) or datetime.now(timezone.utc)
            started_day = started.date() if isinstance(started, datetime) else started
            if cutoff is not None and started_day >= cutoff:
                # Detected on the modelled series but dated into the measured
                # window: not ours to assert.
                continue
            cur.execute(
                'INSERT INTO "BessWarrantyViolation" (id, asset_id, violation_type, started_at, ended_at, '
                ' duration_minutes, severity, measured_value, threshold_value, unit, description, is_resolved, created_at, updated_at) '
                "VALUES (%s, %s, %s::\"WarrantyViolationType\", %s, %s, %s, %s, %s, %s, %s, %s, false, NOW(), NOW())",
                (
                    str(uuid.uuid4()), asset["id"], vtype, started,
                    getattr(v, "ended_at", None), getattr(v, "duration_minutes", None),
                    getattr(v, "severity", "warning"),
                    getattr(v, "measured_value", None), getattr(v, "threshold_value", None),
                    getattr(v, "unit", None), getattr(v, "description", None),
                ),
            )

    # State of safety, published for the console and the alert evaluator.
    #
    # Only when this run owns the present. Once measured telemetry has taken
    # over (cutoff set), the modelled window ends in the past, and a safety
    # headline stamped generated_at = NOW() over a window that closed months
    # ago would sail straight past the 48-hour staleness guard in
    # src/lib/alerts/evaluate.ts. Same rule the asset's headline SoH follows.
    safety_published = False
    safety_skip_reason = None
    if cutoff is None:
        # Through the precedence helper, never a raw upsert: this is the
        # thinnest of the three publishers (no sub-asset channels, so the
        # imbalance sub index cannot score) and it is the one the nightly sweep
        # runs. A raw write would revert a measured or specimen headline every
        # night without saying so.
        safety_published, safety_skip_reason = safety_artifact.publish_safety_artifact(
            conn,
            str(plant["id"]),
            state_of_safety_payload(
                sos,
                asset_db_id=str(asset["id"]),
                external_asset_id=str(asset.get("external_asset_id") or asset["id"]),
                asset_name=asset.get("name") or plant.get("name"),
                interval_minutes=safety_interval,
                window=(start, last_modelled),
                zone=market_zone,
                price_src=price_src,
            ),
            SAFETY_BASIS,
        )

    conn.commit()

    return {
        "asset_id": asset["id"], "days": days, "chemistry": chem.value,
        "telemetry_regime": regime.as_dict(),
        "telemetry_cutoff": cutoff.isoformat() if cutoff else None,
        "modelled_window": [start.isoformat(), last_modelled.isoformat()],
        "installation_date": install_date.isoformat(),
        "installation_date_source": install_source,
        "current_soc": (
            "cleared: no BMS, so there is no live state of charge to serve"
            if cutoff is None
            else "left to the measured pipeline"
        ),
        "cumulative_cycles": round(cum_cycles, 2), "soh": round(soh_now, 4),
        "health_score": int(health.score), "risk_level": risk,
        "state_of_safety": {
            "published": safety_published,
            # Why a computed reading was not stored: normally that a better
            # evidenced publisher already holds the slot. Reported rather than
            # swallowed, so a stale console has a traceable cause.
            "publish_reason": safety_skip_reason,
            "kind": SAFETY_ARTIFACT_KIND,
            "score": sos.score,
            "band": sos.band,
            "limiting_index": sos.limiting_index,
            "unavailable": sos.unavailable,
            "interval_minutes": safety_interval,
        },
        "violations": len(pipe.violations), "price_source": price_src,
        "zone": market_zone, "currency": currency,
        "resolution_minutes": period_minutes,
        "days_priced": len(daily), "days_missing_prices": len(missing_days),
        "days_resolution_mismatch": len(mismatched_days),
        "engine": ENGINE, "provenance": PROVENANCE,
    }
