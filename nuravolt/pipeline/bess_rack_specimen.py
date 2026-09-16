"""A labelled rack level specimen, derived from an asset's own dispatch twin.

WHY THIS EXISTS
---------------
Nothing in the platform generates rack grain data. So
``nuravolt.pipeline.bess_measured.materialize_measured_imbalance`` is correct
and dark, the rack drill-down has nothing to draw, and the imbalance sub index
of state of safety reports "requires rack level telemetry" on every asset we
have. The whole rack story is real code with no data to run on.

This module makes that story demonstrable today, without a BMS and without
pretending anything was measured. It derives a per rack specimen from the
dispatch twin that already exists for the asset, and it labels the result as
modelled at every layer it touches (see LABELLED MODELLED below).

TOPOLOGY, WITH THE ARITHMETIC
-----------------------------
For Ribera: 16 racks in 2 units, ``BESS bess-ribera-001.U-1.R-1..8`` and
``.U-2.R-1..8``.

    10,000 kWh / 16 racks = 625 kWh per rack. At 3.2 V x 280 Ah = 0.896 kWh per
    LFP cell that is 698 cells per rack, 11,168 in the asset, 1,117 cells/MWh,
    inside the 473 to 2,068 cells/MWh band that real products span (Sungrow
    PowerTitan at the low end, Tesla Megapack at the high end). Two units at
    5 MWh each matches how a 10 MWh site is containerised.

State it plainly: the rack count is A MODELLING CHOICE CONSISTENT WITH THE
PHYSICS, NOT A FACT ABOUT HARDWARE, BECAUSE THERE IS NO HARDWARE. ``BessAsset``
here is a declared nameplate. ``rack_count`` is written onto the asset because
the column exists and the number is the one this specimen uses; ``module_count``
is deliberately left alone and left null, because modules are not modelled and a
number there would be an invention.

DERIVED FROM THE EXISTING TWIN, NOT A SECOND TWIN
-------------------------------------------------
Every input is already persisted by ``synthesize_bess_history``:

  ``BessDispatchSchedule.soc_schedule`` + ``resolution_minutes``  the SoC trace
  ``charge_schedule_kw`` / ``discharge_schedule_kw``              the C rate
  ``bess_intelligence.cabinet_temp_series(day, period_minutes)``  the thermal base

``cabinet_temp_series`` is IMPORTED, never reimplemented, so the specimen's
thermal base is literally the twin's curve rather than a plausible looking
cousin of it that could drift away from it in a later edit.

WHAT IS EMITTED, AND WHY IT IS EXTREMES
---------------------------------------
Per rack per period this emits ``bess_voltage_cell_max`` / ``_min``,
``bess_temp_cell_max`` / ``_min`` and ``bess_soc_rack``: the mid value plus and
minus half the spread, plus the rack's state of charge. That is what real BMS
clouds actually publish. They almost never stream a per cell series; they stream
the extremes across whatever the reporting device covers. Two extremes give the
spread exactly under ``imbalance.SPREAD_DEFINITION``, and they are honestly
labelled ``spread_basis = 'extremes'`` so no surface can read "2 members" on a
698 cell rack as "a rack with two modules".

The rows are shaped exactly like ``silver_bess_telemetry`` rows and pivoted with
``nuravolt.bess.rack_samples.rack_samples_from_silver``, the same adapter the
measured path uses. A specimen that took a private shortcut into
``DeviceSample`` would not exercise the seam it exists to demonstrate.

THE PHYSICS THE SPECIMEN ENCODES
--------------------------------
Ranges below are guidance for what healthy looks like. They are NEVER targets to
hit and they are NEVER NuraVolt limits.

  rack SoC   the asset SoC plus a small persistent per rack offset, about
             +/- 0.4 pp. Racks in parallel track closely but not exactly.

  delta V    about 10 to 25 mV on the LFP plateau, widening at the SoC knees and
             under load. The plateau is the interesting part: LFP's flat OCV
             HIDES imbalance, so the fact that delta V opens at the knees is the
             real, teachable behaviour rather than an artefact.

  delta T    about 1.5 to 3.5 C healthy, rising with C rate.

The knee and load widening are MULTIPLICATIVE on the healthy baseline, because
they act on the dispersion of state of charge across cells through the local
slope of the OCV curve. A developing fault is ADDITIVE on top, because a high
resistance cell contributes an offset of its own that does not scale with the
OCV slope. That distinction is why the drift can be stated as a plateau number
and still be honest about what the rack reports at the knees.

THE DRIFTING RACK
-----------------
``U-2.R-5``, over the last ~120 days: delta V grows 18 mV to about 95 mV, delta T
2.5 to 6.5 C, SoC divergence drifting to about -3 pp from the sibling median.
Sustained across whole days, so the 30 minute dwell scan has something true to
find rather than a single sample spike it would correctly ignore.

Its healthy baseline is set to the population MEDIAN on every channel, so before
the drift starts it is indistinguishable from its siblings. That is a modelling
choice and it is the point: the rack was normal, and then it was not.

CALIBRATED SO THE DETECTOR DEMONSTRATES ITSELF HONESTLY
-------------------------------------------------------
With 15 healthy racks spread evenly over 10.5 to 25.5 mV and the drifting rack
starting at the 18.0 mV median, the population MAD is about 3.8 mV and the
modified z score crosses 3.5 at roughly 39 mV. That gives THREE REGIMES on one
timeline:

  quiet          nothing flags, every channel sits in its healthy band
  flagged        the spread outlier detector fires WHILE EVERY ABSOLUTE VALUE IS
                 STILL COMFORTABLY INSIDE EVERY PUBLISHED THRESHOLD
  obviously wrong  the numbers speak for themselves

The middle regime is the product. It is the only window in which monitoring buys
anything, and a specimen that skipped from quiet to obviously wrong would be a
demonstration of a thermometer rather than of a detector.

THE 0.2 V RUNG
--------------
The specimen must NEVER emit a cell to cell spread at or above 0.2 V. That rung
is a thermal runaway precursor in the literature, and a specimen that showed one
would be lying about what monitoring bought you: nobody needs a detector to tell
them a pack at 200 mV of spread is in trouble. ``RUNAWAY_PRECURSOR_V`` is
enforced at emission time, not merely hoped for by choosing gentle constants.

DETERMINISM
-----------
Every random draw is seeded from the asset id plus the date (and the rack id for
the persistent per rack character), so two runs are byte identical and a rerun
replaces rather than accumulates. No global RNG is touched.

LABELLED MODELLED AT EVERY LAYER
--------------------------------
This is the point of the module, so it is exhaustive:

  * ``model_version`` literally starts ``modelled-``:
    ``modelled-bess-rack-specimen-v1``. The writer REFUSES any model version
    that does not match ``^modelled-``.
  * every ``analysis_results`` row carries
    ``metadata = {provenance: 'modelled', basis: 'modelled_rack_specimen',
    generator: 'bess_rack_specimen', grain: 'rack'|'unit'|'asset'}``.
  * ``BessAsset.metadata.rack_specimen`` records the generator, the units, the
    racks, the cells per rack, the cells per MWh and the drifting rack, so the
    asset row ALONE tells the story to anyone who finds it later.
  * the state of safety artifact carries ``provisional: true`` and a
    ``device_label`` ending "(modelled rack specimen)".
  * each scored sub index carries a basis note saying the rack channels are a
    modelled specimen derived from the dispatch twin with no BMS connected.
  * the writer REFUSES to run when ``regime.has_measured`` is true. Real
    telemetry always outranks a specimen, and the unrecoverable mistake is a
    specimen sitting on top of measurements.

Both refusals are pinned by ``tests/bess/test_rack_specimen.py``. They are
guards, not comments.

WHAT THIS WRITES
----------------
  1. ``AnalysisArtifact`` kind ``bess_state_of_safety``, for the most recent
     modelled day ONLY. Mirrors the guard in ``bess_intelligence.py``: a safety
     headline stamped now over a window that closed months ago would sail past
     the 48 hour staleness check in ``src/lib/alerts/evaluate.ts``.

     Not published at all when the plant carries more than one battery. That
     artifact is one row per (plant, kind), so one battery's specimen published
     as the plant's would be attributed to the other. The per device rollups
     below are unaffected: every one of their rows is keyed by a device id under
     the asset it describes.
  2. ``analysis_results`` daily rack rollups at canonical rack ids,
     ``domain='bess'``, using THE SAME METRIC NAMES ``gold_bess_rack_daily`` now
     emits, so a real lake publish later is a drop in under a different model
     version. Spreads follow ``imbalance.SPREAD_DEFINITION`` exactly:
     instantaneous, then worst over the day.
  3. Unit and asset rollups under the same model version, so the drill-down tree
     walks. Without unit grain ids, child discovery returns [] at the root and
     the drill-down tells the operator "requires unit level telemetry" about its
     own asset, which is an own goal.

     SPREADS ROLL UP BY MAX, NEVER BY MEAN. A spread does not average: the mean
     of one rack at 95 mV and fifteen at 18 mV is 23 mV, which is the number a
     healthy pack would report. Counts sum, levels take their own extreme, and
     the SoC divergence rolls up by largest absolute value with the sign kept,
     because an operator needs to know which way the rack is running.

Persistence is the delete then write lane pattern from
``bess_revenue_assurance.py`` with a deterministic uuid5 run id, so rollback is
one DELETE.
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from nuravolt.bess import safety_artifact
from nuravolt.bess.config import BessAssetConfig, BESSPipelineConfig, BessChemistry
from nuravolt.bess.imbalance import (
    DEFAULT_DWELL_MINUTES,
    MIN_RACKS_FOR_OUTLIER,
    MIN_SAMPLES_IN_DWELL,
    SPREAD_BASIS_EXTREMES,
    SPREAD_DEFINITION,
    analyze_imbalance,
    infer_cadence_seconds,
)
from nuravolt.bess.pipeline import BESSIntelligencePipeline
from nuravolt.bess.rack_samples import rack_samples_from_silver
from nuravolt.pipeline.bess_intelligence import cabinet_temp_series
from nuravolt.pipeline.bess_measured import DOMAIN, regime_from_asset


# ---------------------------------------------------------------------------
# Identity. Every one of these strings is a claim about provenance.
# ---------------------------------------------------------------------------

#: The model version. The leading ``modelled-`` is enforced, not conventional.
MODEL_VERSION = "modelled-bess-rack-specimen-v1"

#: The prefix every model version this writer will accept must start with. A
#: specimen published under a name that does not announce itself is the exact
#: failure this module exists to make impossible.
MODELLED_PREFIX = "modelled-"

#: Name of this generator, stamped on every row and on the asset.
GENERATOR = "bess_rack_specimen"

#: What the numbers were computed from, in the vocabulary
#: ``nuravolt.bess.safety_artifact`` already uses for its two real bases.
SPECIMEN_BASIS = "modelled_rack_specimen"
SPECIMEN_BASIS_LABEL = "modelled rack specimen"

#: ``analysis_results.metadata.provenance``, in the closed vocabulary
#: ``nuravolt/lake/publish.py`` documents for the drill-down captions.
PROVENANCE = "modelled"

SPECIMEN_BASIS_NOTES: Dict[str, str] = {
    "imbalance": (
        "Rack channels here are a modelled specimen derived from this asset's "
        "own dispatch twin. No battery management system is connected, so "
        "nothing in this sub index was measured. The spreads come from a "
        "reported max and min pair per rack, which is the extremes basis."
    ),
}
SPECIMEN_BASIS_NOTE_DEFAULT = (
    "Computed from a modelled rack specimen derived from the dispatch twin, "
    "not from measured telemetry."
)
SPECIMEN_PROVENANCE_NOTE = (
    "Every rack channel behind this artifact is a modelled specimen derived "
    "from this asset's dispatch twin. No battery management system is "
    "connected and nothing here was measured. The sub indices that need asset "
    "grain channels this run did not load report unavailable with their "
    "reason instead of a score. Absent is not zero, and a sub index nobody "
    "could measure is not a passing one."
)

#: Deterministic namespace, so a rerun reproduces the same run id.
RUN_NAMESPACE = uuid.uuid5(
    uuid.NAMESPACE_URL, "https://nuravolt.com/pipeline/bess_rack_specimen"
)


# ---------------------------------------------------------------------------
# Topology constants. The arithmetic is in the module docstring.
# ---------------------------------------------------------------------------

#: Energy per rack. 10,000 kWh / 16 racks for a 10 MWh site.
RACK_ENERGY_KWH = 625.0

#: How many racks share one containerised unit. Two units at 5 MWh each is how a
#: 10 MWh site is actually built.
RACKS_PER_UNIT = 8

#: One prismatic LFP cell: 3.2 V nominal x 280 Ah = 0.896 kWh.
CELL_NOMINAL_V = 3.2
CELL_CAPACITY_AH = 280.0
CELL_ENERGY_KWH = CELL_NOMINAL_V * CELL_CAPACITY_AH / 1000.0

#: Cells per MWh that real products span, low end to high end (Sungrow
#: PowerTitan to Tesla Megapack). A derived topology outside this band is
#: reported as a warning rather than silently accepted: it would mean the
#: nameplate and the rack model disagree about what kind of product this is.
CELLS_PER_MWH_BAND: Tuple[float, float] = (473.0, 2068.0)

#: Below this there is no sibling population to be an outlier of, so a specimen
#: with fewer racks could not demonstrate the detector at all.
MIN_RACKS = MIN_RACKS_FOR_OUTLIER

#: The rack that drifts, as a suffix under the asset. Falls back to the middle
#: rack of the last unit on a topology that has no such id.
DEFAULT_DRIFTING_RACK = "U-2.R-5"


# ---------------------------------------------------------------------------
# Behaviour constants. Guidance for healthy, never targets and never limits.
# ---------------------------------------------------------------------------

#: Healthy cell to cell voltage spread ON THE LFP PLATEAU AT REST, in
#: millivolts, spread evenly across the healthy racks. This is the BASELINE:
#: the knee and load widening below sit on top of it, so what the specimen
#: reports runs wider on a day the battery actually works. On a typical
#: arbitrage day the reported daily mean lands at about 10 to 25 mV, which is
#: the band the physics guidance describes; a day at full power all day would
#: read higher still, and that is the widening doing its job rather than a
#: healthy rack going out of band.
#:
#: The drifting rack's baseline is the median of this band, which is why its
#: reported spread starts at about 18 mV.
HEALTHY_DV_BAND_MV: Tuple[float, float] = (9.0, 21.8)

#: Healthy cell to cell temperature spread on the plateau at rest, in C. Same
#: reading as above: reported daily means land at about 1.5 to 3.5 C on a
#: typical day, and the drifting rack's baseline is this band's median, 2.5 C.
HEALTHY_DT_BAND_C: Tuple[float, float] = (1.8, 3.2)

#: Persistent per rack state of charge offset, in percentage points. Racks in
#: parallel track closely but not exactly.
HEALTHY_SOC_OFFSET_BAND_PP: Tuple[float, float] = (-0.4, 0.4)

#: Persistent per rack temperature level offset, in C. Racks at the ends of a
#: container run warmer than racks in the middle.
HEALTHY_TEMP_OFFSET_BAND_C: Tuple[float, float] = (-0.8, 0.8)

#: The LFP plateau, in state of charge. Outside it the OCV curve steepens and
#: the same cell to cell dispersion shows up as more millivolts.
PLATEAU_SOC: Tuple[float, float] = (0.30, 0.80)

#: How much the spread widens at the very edge of each knee, as a fraction. The
#: twin's own state of charge band is 0.20 to 0.88, so the knee term reaches
#: about 40 percent of this rather than all of it.
KNEE_WIDENING = 0.45

#: How much the voltage spread widens at full rated power, as a fraction.
LOAD_WIDENING_V = 0.18

#: How much the temperature spread widens at full rated power, as a fraction.
LOAD_WIDENING_T = 0.35

#: How much the DRIFT term (not the healthy baseline) widens under load. A high
#: resistance cell shows more of itself when current flows through it.
DRIFT_LOAD_WIDENING_V = 0.25
DRIFT_LOAD_WIDENING_T = 0.25

#: Multiplicative sample noise, so a day is not a perfectly rigid line. Small
#: enough that the 30 minute dwell scan still sees a sustained deviation.
NOISE_DV = 0.04
NOISE_DT = 0.04
#: Additive state of charge sample noise, in percentage points.
NOISE_SOC_PP = 0.05

#: The drift window and its end points.
#:
#: THE END POINTS ARE THE REPORTED DAILY NUMBERS, not a hidden baseline. On the
#: final day the drifting rack's ``voltage_spread_max_v`` is exactly
#: ``DRIFT_DV_END_MV`` and its ``temp_spread_max_c`` is exactly
#: ``DRIFT_DT_END_C``: the additive drift term is solved per day so it lands
#: there (see ``_solve_drift``). Defining the ramp on a plateau baseline instead
#: would leave the published number somewhere above the constant, which is the
#: sort of quiet gap between the code and the claim that this whole arc exists
#: to close. It also means the 0.2 V runaway rung is bounded by a constant a
#: reader can check rather than by a chain of multipliers.
DRIFT_DAYS = 120
DRIFT_DV_END_MV = 95.0
DRIFT_DT_END_C = 6.5
DRIFT_SOC_DIVERGENCE_END_PP = -3.0

#: Shape of the ramp. Linear: a developing cell fault does accelerate, but no
#: shape here is a claim about a real failure and a straight line is the one
#: that claims least. Its only calibrated consequence is where the flagged
#: regime opens (about 85 days before the end); the detector's own flag point is
#: Iglewicz and Hoaglin's 3.5 and is not tuned here or anywhere else.
DRIFT_EXPONENT = 1.0

#: Thermal runaway precursor rung from the literature. The specimen must never
#: emit a cell to cell voltage spread at or above this, and the check is
#: enforced at emission time rather than assumed from gentle constants.
RUNAWAY_PRECURSOR_V = 0.200

#: Poll cadence of the specimen, in minutes. Real BMS clouds poll every 1 to 5
#: minutes. It also has to be fine enough that a 30 minute dwell window holds at
#: least ``imbalance.MIN_SAMPLES_IN_DWELL`` samples, or the outlier grains would
#: correctly report themselves unresolvable and the specimen would demonstrate
#: nothing.
DEFAULT_CADENCE_MINUTES = 5

#: Days of specimen written by default. Covers the whole drift with a quiet run
#: in front of it, so the three regimes are all on the timeline.
DEFAULT_DAYS = 180


# ---------------------------------------------------------------------------
# The metric contract, mirroring gold_bess_rack_daily column for column.
# ---------------------------------------------------------------------------
#
# These names are the ones dbt now emits. A real lake publish later is then a
# drop in under a different model_version: same device ids, same metric names,
# different provenance stamp. The bare `voltage_spread_v` / `temp_spread_c`
# names are gone on purpose and must not come back here either.
#
# `voltage_pack_max_v` is deliberately ABSENT. This specimen models no pack
# voltage, and an emitted zero would read as a dead string.
# `spread_basis` is deliberately absent too: it is a word, not a number, and it
# rides in the row metadata instead.

#: How each metric combines when racks roll up into a unit and units into the
#: asset. Stated once, here, because getting it wrong is silent.
ROLLUP_MAX = "max"
ROLLUP_MIN = "min"
ROLLUP_SUM = "sum"
ROLLUP_MEAN = "mean"
ROLLUP_ABS_MAX = "abs_max"

ROLLUP_POLICY: Dict[str, str] = {
    # Spreads roll up by MAX. A pack degrades at its weakest rack and a spread
    # does not average: the mean of one rack at 95 mV and fifteen at 18 mV is
    # 23 mV, which is what a healthy pack reports.
    "temp_spread_max_c": ROLLUP_MAX,
    "temp_spread_p95_c": ROLLUP_MAX,
    "temp_spread_mean_c": ROLLUP_MAX,
    "temp_spread_envelope_c": ROLLUP_MAX,
    "voltage_spread_max_v": ROLLUP_MAX,
    "voltage_spread_p95_v": ROLLUP_MAX,
    "voltage_spread_mean_v": ROLLUP_MAX,
    "voltage_spread_envelope_v": ROLLUP_MAX,
    # Counts add.
    "temp_spread_instants": ROLLUP_SUM,
    "voltage_spread_instants": ROLLUP_SUM,
    "devices": ROLLUP_SUM,
    "samples": ROLLUP_SUM,
    # Levels take their own extreme.
    "temp_cell_max_c": ROLLUP_MAX,
    "temp_cell_min_c": ROLLUP_MIN,
    "voltage_cell_max_v": ROLLUP_MAX,
    "voltage_cell_min_v": ROLLUP_MIN,
    "soc_max_pct": ROLLUP_MAX,
    "soc_min_pct": ROLLUP_MIN,
    # A mean state of charge is a real average across parallel racks.
    "soc_mean_pct": ROLLUP_MEAN,
    # Worst divergence, sign kept: ahead of the fleet and behind it are
    # different findings.
    "soc_divergence_from_sibling_median_pct": ROLLUP_ABS_MAX,
    # Observation coverage: a unit does not observe more hours than its racks.
    "hours_observed": ROLLUP_MAX,
}

#: Decimal places per metric, mirroring gold_bess_rack_daily's own rounding so
#: the two planes agree digit for digit. Six decimals on a spread is a microvolt
#: and a micro degree, orders of magnitude below any BMS resolution.
ROUNDING: Dict[str, int] = {
    "temp_spread_max_c": 6,
    "temp_spread_p95_c": 6,
    "temp_spread_mean_c": 6,
    "voltage_spread_max_v": 6,
    "voltage_spread_p95_v": 6,
    "voltage_spread_mean_v": 6,
    "temp_cell_max_c": 2,
    "temp_cell_min_c": 2,
    "temp_spread_envelope_c": 2,
    "voltage_cell_max_v": 4,
    "voltage_cell_min_v": 4,
    "voltage_spread_envelope_v": 4,
    "soc_mean_pct": 2,
    "soc_max_pct": 2,
    "soc_min_pct": 2,
    "soc_divergence_from_sibling_median_pct": 2,
}

GRAIN_RACK = "rack"
GRAIN_UNIT = "unit"
GRAIN_ASSET = "asset"

#: Silver metric names this specimen emits, and what each carries. Extremes,
#: because that is what a BMS cloud publishes.
SILVER_METRICS: Tuple[str, ...] = (
    "bess_voltage_cell_max",
    "bess_voltage_cell_min",
    "bess_temp_cell_max",
    "bess_temp_cell_min",
    "bess_soc_rack",
)


# ---------------------------------------------------------------------------
# Topology
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Rack:
    """One rack in the modelled topology, with its canonical ids."""

    unit_no: int
    rack_no: int
    device_id: str  # 'BESS <asset>.U-<n>.R-<k>'
    unit_device_id: str  # 'BESS <asset>.U-<n>'

    @property
    def suffix(self) -> str:
        return f"U-{self.unit_no}.R-{self.rack_no}"


@dataclass(frozen=True)
class Topology:
    """The modelled rack topology for one asset, and the arithmetic behind it."""

    external_asset_id: str
    asset_device_id: str
    capacity_kwh: float
    units: Tuple[int, ...]  # unit numbers
    racks_per_unit: Tuple[int, ...]
    racks: Tuple[Rack, ...]
    rack_energy_kwh: float
    cells_per_rack: int
    cells_total: int
    cells_per_mwh: float
    in_published_band: bool

    @property
    def rack_count(self) -> int:
        return len(self.racks)

    def unit_device_ids(self) -> Tuple[str, ...]:
        seen: List[str] = []
        for r in self.racks:
            if r.unit_device_id not in seen:
                seen.append(r.unit_device_id)
        return tuple(seen)

    def racks_in_unit(self, unit_device_id: str) -> Tuple[Rack, ...]:
        return tuple(r for r in self.racks if r.unit_device_id == unit_device_id)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "asset_device_id": self.asset_device_id,
            "units": len(self.units),
            "racks": self.rack_count,
            "racks_per_unit": list(self.racks_per_unit),
            "rack_energy_kwh": round(self.rack_energy_kwh, 2),
            "cell_nominal_v": CELL_NOMINAL_V,
            "cell_capacity_ah": CELL_CAPACITY_AH,
            "cell_energy_kwh": round(CELL_ENERGY_KWH, 4),
            "cells_per_rack": self.cells_per_rack,
            "cells_total": self.cells_total,
            "cells_per_mwh": round(self.cells_per_mwh, 1),
            "cells_per_mwh_published_band": list(CELLS_PER_MWH_BAND),
            "cells_per_mwh_in_published_band": self.in_published_band,
        }


def sanitize_asset_token(raw: Any) -> str:
    """'.'-free asset token. Mirrors bess_revenue_assurance.sanitize_bess_asset_token."""
    import re

    return re.sub(r"\s+", " ", str(raw if raw is not None else "").replace(".", "-")).strip()


def build_topology(
    external_asset_id: str,
    capacity_kwh: float,
    *,
    rack_energy_kwh: float = RACK_ENERGY_KWH,
    racks_per_unit: int = RACKS_PER_UNIT,
) -> Topology:
    """Derive the modelled rack topology from the asset's declared nameplate.

    The nameplate is the only fact available: nobody has told us how this
    battery is built, because nobody has connected to it. So the topology is
    derived from the energy with a documented rule (625 kWh per rack, eight
    racks per containerised unit) and the derived cell count is checked against
    the band real products span. Everything about it is a modelling choice and
    the whole module says so.
    """
    if capacity_kwh <= 0:
        raise ValueError(f"capacity_kwh must be positive, got {capacity_kwh!r}")
    if rack_energy_kwh <= 0:
        raise ValueError(f"rack_energy_kwh must be positive, got {rack_energy_kwh!r}")
    if racks_per_unit < 1:
        raise ValueError(f"racks_per_unit must be at least 1, got {racks_per_unit!r}")

    token = sanitize_asset_token(external_asset_id)
    if not token:
        raise ValueError("build_topology: asset token is empty")
    asset_device_id = f"BESS {token}"

    count = max(MIN_RACKS, int(round(capacity_kwh / rack_energy_kwh)))
    n_units = max(1, math.ceil(count / racks_per_unit))
    base, remainder = divmod(count, n_units)
    per_unit = tuple(base + (1 if i < remainder else 0) for i in range(n_units))

    racks: List[Rack] = []
    for unit_index, n in enumerate(per_unit, start=1):
        unit_id = f"{asset_device_id}.U-{unit_index}"
        for rack_index in range(1, n + 1):
            racks.append(
                Rack(
                    unit_no=unit_index,
                    rack_no=rack_index,
                    device_id=f"{unit_id}.R-{rack_index}",
                    unit_device_id=unit_id,
                )
            )

    actual_rack_kwh = capacity_kwh / count
    cells_per_rack = int(round(actual_rack_kwh / CELL_ENERGY_KWH))
    cells_total = cells_per_rack * count
    cells_per_mwh = cells_total / (capacity_kwh / 1000.0)
    lo, hi = CELLS_PER_MWH_BAND

    return Topology(
        external_asset_id=str(external_asset_id),
        asset_device_id=asset_device_id,
        capacity_kwh=float(capacity_kwh),
        units=tuple(range(1, n_units + 1)),
        racks_per_unit=per_unit,
        racks=tuple(racks),
        rack_energy_kwh=actual_rack_kwh,
        cells_per_rack=cells_per_rack,
        cells_total=cells_total,
        cells_per_mwh=cells_per_mwh,
        in_published_band=bool(lo <= cells_per_mwh <= hi),
    )


def choose_drifting_rack(topology: Topology, preferred: str = DEFAULT_DRIFTING_RACK) -> Rack:
    """The rack that drifts: the preferred id when the topology has it.

    Falls back to the middle rack of the last unit rather than raising, so a
    smaller asset still gets a specimen. The chosen rack is recorded on the
    asset, so the fallback is never a silent substitution.
    """
    for rack in topology.racks:
        if rack.suffix == preferred:
            return rack
    last_unit = topology.unit_device_ids()[-1]
    siblings = topology.racks_in_unit(last_unit)
    return siblings[len(siblings) // 2]


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def _seed(*parts: Any) -> int:
    """Stable 64 bit seed from the given parts.

    blake2b rather than ``hash()``: Python salts string hashing per process, so
    a run tomorrow would produce different numbers under the same inputs and the
    "reruns are byte identical" claim would quietly be false.
    """
    key = "|".join(str(p) for p in parts).encode("utf-8")
    return int.from_bytes(hashlib.blake2b(key, digest_size=8).digest(), "big")


def _rng(*parts: Any) -> np.random.Generator:
    return np.random.default_rng(_seed(*parts))


def _even_spread(lo: float, hi: float, n: int) -> np.ndarray:
    """``n`` values evenly covering [lo, hi], inclusive of both ends."""
    if n <= 1:
        return np.array([(lo + hi) / 2.0], dtype=float)
    return np.linspace(lo, hi, n, dtype=float)


# ---------------------------------------------------------------------------
# Persistent per rack character
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RackCharacter:
    """The persistent, day independent character of every rack in the asset.

    Drawn once per asset (not per day) because a rack's position in a container
    and the tolerance band of its cells do not change overnight. Healthy values
    are spread EVENLY over their band and then assigned to racks by a seeded
    permutation, so the population's median and MAD are known by construction
    rather than being whatever a normal draw happened to produce. The detector's
    behaviour is then a property of the specimen, not of a lucky seed.
    """

    rack_ids: Tuple[str, ...]
    drifting_rack_id: str
    dv_base_mv: Dict[str, float]
    dt_base_c: Dict[str, float]
    soc_offset_pp: Dict[str, float]
    temp_offset_c: Dict[str, float]

    @property
    def healthy_rack_ids(self) -> Tuple[str, ...]:
        return tuple(r for r in self.rack_ids if r != self.drifting_rack_id)


def rack_character(topology: Topology, drifting: Rack) -> RackCharacter:
    """Draw the persistent per rack character for one asset."""
    ids = [r.device_id for r in topology.racks]
    healthy = [i for i in ids if i != drifting.device_id]
    n_healthy = len(healthy)

    rng = _rng(topology.external_asset_id, "rack-character")

    def assign(band: Tuple[float, float]) -> Dict[str, float]:
        values = _even_spread(band[0], band[1], n_healthy)
        order = rng.permutation(n_healthy)
        out = {healthy[i]: float(values[order[i]]) for i in range(n_healthy)}
        # The drifting rack starts at the population median on every channel:
        # before the drift it is indistinguishable from its siblings, which is
        # the whole teaching point.
        out[drifting.device_id] = float(np.median(values))
        return out

    return RackCharacter(
        rack_ids=tuple(ids),
        drifting_rack_id=drifting.device_id,
        dv_base_mv=assign(HEALTHY_DV_BAND_MV),
        dt_base_c=assign(HEALTHY_DT_BAND_C),
        soc_offset_pp=assign(HEALTHY_SOC_OFFSET_BAND_PP),
        temp_offset_c=assign(HEALTHY_TEMP_OFFSET_BAND_C),
    )


# ---------------------------------------------------------------------------
# The twin's own inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DispatchDay:
    """One day of the asset's dispatch twin, as persisted."""

    day: date
    resolution_minutes: int
    soc: Tuple[float, ...]  # fraction, state entering each slot
    power_kw: Tuple[float, ...]  # discharge positive, charge negative


def _as_list(value: Any) -> List[float]:
    """psycopg2 hands a Json column back as a list or as text, depending."""
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return []
    if not isinstance(value, (list, tuple)):
        return []
    out: List[float] = []
    for v in value:
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        out.append(f if np.isfinite(f) else 0.0)
    return out


def read_dispatch_days(conn, asset_id: str, days: Sequence[date]) -> Dict[date, DispatchDay]:
    """The twin's SoC and power schedules for the requested days.

    A day the twin never modelled is simply absent from the result. The
    specimen then has nothing to derive from for that day and skips it, which is
    the honest answer: there is no second twin here to fall back on.
    """
    if not days:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            'SELECT schedule_date, resolution_minutes, soc_schedule, '
            ' charge_schedule_kw, discharge_schedule_kw '
            'FROM "BessDispatchSchedule" WHERE asset_id = %s AND schedule_date = ANY(%s) '
            "ORDER BY schedule_date",
            (asset_id, list(days)),
        )
        rows = cur.fetchall()

    out: Dict[date, DispatchDay] = {}
    for schedule_date, resolution, soc_json, charge_json, discharge_json in rows:
        soc = _as_list(soc_json)
        charge = _as_list(charge_json)
        discharge = _as_list(discharge_json)
        if not soc:
            continue
        n = len(soc)
        power = [
            (discharge[k] if k < len(discharge) else 0.0)
            + (charge[k] if k < len(charge) else 0.0)
            for k in range(n)
        ]
        res = int(resolution or 60)
        if res <= 0 or 1440 % res:
            # The twin writes the day's own settlement resolution. One that does
            # not divide a day cannot be resampled onto a clock, and inventing
            # one would misplace every sample.
            continue
        out[schedule_date] = DispatchDay(
            day=schedule_date,
            resolution_minutes=res,
            soc=tuple(soc),
            power_kw=tuple(power),
        )
    return out


# ---------------------------------------------------------------------------
# One day of rack channels
# ---------------------------------------------------------------------------


@dataclass
class DaySeries:
    """One day of per rack channels at the specimen's poll cadence."""

    day: date
    cadence_minutes: int
    rack_ids: Tuple[str, ...]
    timestamps: Tuple[datetime, ...]
    asset_soc: np.ndarray  # (periods,) fraction
    c_rate: np.ndarray  # (periods,) 1/h, unsigned
    soc_pct: np.ndarray  # (racks, periods) percent
    v_mid: np.ndarray  # (racks, periods) volts
    dv: np.ndarray  # (racks, periods) volts
    t_mid: np.ndarray  # (racks, periods) C
    dt: np.ndarray  # (racks, periods) C
    drift_progress: float  # 0 before the drift window, 1 at its end


def drift_progress(day: date, last_day: date, drift_days: int = DRIFT_DAYS) -> float:
    """How far into the drift window ``day`` is, from 0 to 1.

    0 for every day before the window opens, so the quiet regime is genuinely
    quiet rather than very slightly unwell.
    """
    if drift_days <= 0:
        return 0.0
    elapsed = drift_days - (last_day - day).days
    if elapsed <= 0:
        return 0.0
    return float(min(1.0, elapsed / drift_days))


def _ramp(progress: float) -> float:
    """The drift ramp shape."""
    return float(max(0.0, min(1.0, progress)) ** DRIFT_EXPONENT)


def _resample(values: Sequence[float], source_minutes: int, cadence_minutes: int,
              *, interpolate: bool) -> np.ndarray:
    """Resample a per slot series onto the specimen's poll clock.

    State of charge is interpolated (it moves continuously between slots);
    power is held (the optimizer's setpoint is constant within a slot). Getting
    those the wrong way round would either put a staircase in a continuous
    quantity or smear a step change across a slot boundary.
    """
    periods = 1440 // cadence_minutes
    src = np.asarray(values, dtype=float)
    if src.size == 0:
        return np.zeros(periods, dtype=float)
    minutes = np.arange(periods, dtype=float) * cadence_minutes
    slot = minutes / float(source_minutes)
    if not interpolate:
        idx = np.clip(np.floor(slot).astype(int), 0, src.size - 1)
        return src[idx]
    lo = np.clip(np.floor(slot).astype(int), 0, src.size - 1)
    hi = np.clip(lo + 1, 0, src.size - 1)
    frac = slot - np.floor(slot)
    return src[lo] * (1.0 - frac) + src[hi] * frac


def _knee_factor(soc: np.ndarray) -> np.ndarray:
    """How much wider the same cell dispersion reads outside the LFP plateau."""
    lo, hi = PLATEAU_SOC
    below = np.clip((lo - soc) / lo, 0.0, 1.0)
    above = np.clip((soc - hi) / (1.0 - hi), 0.0, 1.0)
    return 1.0 + KNEE_WIDENING * (below + above)


def _solve_drift(
    quiet: np.ndarray,
    drift_widening: np.ndarray,
    noise: np.ndarray,
    target: float,
) -> float:
    """The additive drift term that makes the day's WORST instant equal ``target``.

    The emitted series is ``(quiet[t] + d * drift_widening[t]) * noise[t]`` and we
    want ``max_t`` of it to be ``target``. Each instant gives one linear
    constraint, ``d <= (target / noise[t] - quiet[t]) / drift_widening[t]``, and
    the maximum of a family of increasing linear functions of ``d`` equals the
    target exactly at the SMALLEST of those. So the answer is the minimum, in
    closed form, with no search and no iteration.

    Clamped at zero: a target below what the rack already reports when healthy
    would otherwise ask the drift to run backwards, and a rack that gets tighter
    than its siblings is not the story this specimen tells.
    """
    with np.errstate(divide="ignore", invalid="ignore"):
        candidates = (target / noise - quiet) / drift_widening
    candidates = candidates[np.isfinite(candidates)]
    if candidates.size == 0:  # pragma: no cover - defensive
        return 0.0
    return float(max(0.0, np.min(candidates)))


def _lfp_ocv(soc: np.ndarray) -> np.ndarray:
    """A flat LFP open circuit voltage curve with knees at both ends.

    Deliberately simple. Its job is to make the plateau visible and the knees
    real, not to be a cell model: nothing downstream reads the absolute cell
    voltage as a measurement, and the specimen says so on every row.
    """
    return (
        3.20
        + 0.055 * np.tanh(4.0 * (soc - 0.5))
        + 0.20 * np.clip((soc - 0.90) / 0.10, 0.0, 1.0) ** 2
        - 0.25 * np.clip((0.12 - soc) / 0.12, 0.0, 1.0) ** 2
    )


def generate_day(
    topology: Topology,
    character: RackCharacter,
    dispatch: DispatchDay,
    *,
    last_day: date,
    cadence_minutes: int = DEFAULT_CADENCE_MINUTES,
    drift_days: int = DRIFT_DAYS,
    power_kw: float,
    capacity_kwh: float,
) -> DaySeries:
    """One day of per rack channels, derived from one day of the dispatch twin."""
    if cadence_minutes <= 0 or 1440 % cadence_minutes:
        raise ValueError(
            f"cadence_minutes must divide a 1440 minute day evenly, got {cadence_minutes}"
        )
    if DEFAULT_DWELL_MINUTES / cadence_minutes < MIN_SAMPLES_IN_DWELL:
        # A feed too coarse to demonstrate persistence demonstrates nothing.
        # imbalance.py would (correctly) report every outlier grain unresolvable
        # and the specimen would be silent while looking like it had run, which
        # is the worst outcome available here.
        raise ValueError(
            f"a {cadence_minutes} minute cadence puts fewer than {MIN_SAMPLES_IN_DWELL} "
            f"samples inside the {DEFAULT_DWELL_MINUTES} minute dwell window, so the "
            "outlier grains would report themselves unresolvable and the specimen would "
            f"demonstrate nothing. Use {int(DEFAULT_DWELL_MINUTES // MIN_SAMPLES_IN_DWELL)} "
            "minutes or finer."
        )
    periods = 1440 // cadence_minutes
    rack_ids = tuple(r.device_id for r in topology.racks)
    n_racks = len(rack_ids)

    asset_soc = np.clip(
        _resample(dispatch.soc, dispatch.resolution_minutes, cadence_minutes, interpolate=True),
        0.0,
        1.0,
    )
    power = _resample(
        dispatch.power_kw, dispatch.resolution_minutes, cadence_minutes, interpolate=False
    )
    c_rate_max = max(1e-6, power_kw / capacity_kwh)
    c_rate = np.abs(power) / max(1e-6, capacity_kwh)
    load_frac = np.clip(c_rate / c_rate_max, 0.0, 1.0)

    # The twin's own thermal base, imported rather than reimplemented, sampled
    # at the specimen's cadence. cabinet_temp_series is a function of the hour
    # of day, so a finer cadence samples the same curve more often.
    cabinet = np.asarray(cabinet_temp_series(dispatch.day, cadence_minutes), dtype=float)
    if cabinet.size != periods:  # pragma: no cover - guarded by the divisor check
        cabinet = np.resize(cabinet, periods)

    progress = drift_progress(dispatch.day, last_day, drift_days)
    ramp = _ramp(progress)

    knee = _knee_factor(asset_soc)
    widen_v = knee * (1.0 + LOAD_WIDENING_V * load_frac)
    widen_t = 1.0 + LOAD_WIDENING_T * load_frac
    widen_drift_v = 1.0 + DRIFT_LOAD_WIDENING_V * load_frac
    widen_drift_t = 1.0 + DRIFT_LOAD_WIDENING_T * load_frac

    rng = _rng(topology.external_asset_id, dispatch.day.isoformat(), "day")
    noise_dv = 1.0 + NOISE_DV * (rng.random((n_racks, periods)) * 2.0 - 1.0)
    noise_dt = 1.0 + NOISE_DT * (rng.random((n_racks, periods)) * 2.0 - 1.0)
    noise_soc = NOISE_SOC_PP * (rng.random((n_racks, periods)) * 2.0 - 1.0)

    dv = np.empty((n_racks, periods), dtype=float)
    dt = np.empty((n_racks, periods), dtype=float)
    soc_pct = np.empty((n_racks, periods), dtype=float)
    t_mid = np.empty((n_racks, periods), dtype=float)

    # The drift term, solved so the day's WORST reported spread lands on the
    # ramp. At progress 0 the target IS the quiet worst, so the solved drift is
    # exactly zero and the rack is genuinely indistinguishable from its
    # siblings; at progress 1 it is exactly DRIFT_*_END.
    d_index = rack_ids.index(character.drifting_rack_id)
    quiet_dv = character.dv_base_mv[character.drifting_rack_id] * widen_v
    quiet_dt = character.dt_base_c[character.drifting_rack_id] * widen_t
    quiet_dv_max = float(np.max(quiet_dv * noise_dv[d_index]))
    quiet_dt_max = float(np.max(quiet_dt * noise_dt[d_index]))
    drift_dv_mv = _solve_drift(
        quiet_dv, widen_drift_v, noise_dv[d_index],
        quiet_dv_max + (DRIFT_DV_END_MV - quiet_dv_max) * ramp,
    )
    drift_dt_c = _solve_drift(
        quiet_dt, widen_drift_t, noise_dt[d_index],
        quiet_dt_max + (DRIFT_DT_END_C - quiet_dt_max) * ramp,
    )
    drift_soc_pp = DRIFT_SOC_DIVERGENCE_END_PP * ramp

    ocv = _lfp_ocv(asset_soc)
    # Internal resistance shows as an offset on the reported mid cell voltage:
    # higher under charge, lower under discharge. Sign follows the twin's
    # convention (discharge positive).
    ir_offset = -0.030 * (power / max(1e-6, power_kw))

    for i, rack_id in enumerate(rack_ids):
        drifting = rack_id == character.drifting_rack_id

        base_mv = character.dv_base_mv[rack_id]
        dv_mv = base_mv * widen_v
        if drifting:
            # Additive, not multiplicative: a high resistance cell contributes
            # an offset of its own that does not scale with the OCV slope.
            dv_mv = dv_mv + drift_dv_mv * widen_drift_v
        dv[i] = dv_mv * noise_dv[i] / 1000.0

        dt_c = character.dt_base_c[rack_id] * widen_t
        if drifting:
            dt_c = dt_c + drift_dt_c * widen_drift_t
        dt[i] = dt_c * noise_dt[i]

        offset_pp = character.soc_offset_pp[rack_id] + (drift_soc_pp if drifting else 0.0)
        soc_pct[i] = np.clip(asset_soc * 100.0 + offset_pp + noise_soc[i], 0.0, 100.0)

        # A developing rack does run a little warmer, but only a little: the
        # level barely moves while the spread trebles, which is exactly why the
        # spread grain exists and a level test alone would miss this.
        level_rise = 0.25 * (drift_dt_c if drifting else 0.0)
        t_mid[i] = cabinet + character.temp_offset_c[rack_id] + 1.6 * load_frac + level_rise

    v_mid = np.tile(ocv + ir_offset, (n_racks, 1))

    worst_dv = float(np.max(dv)) if dv.size else 0.0
    if worst_dv >= RUNAWAY_PRECURSOR_V:
        raise ValueError(
            f"specimen would emit a cell to cell spread of {worst_dv:.3f} V on "
            f"{dispatch.day.isoformat()}, at or above the {RUNAWAY_PRECURSOR_V} V thermal "
            "runaway precursor rung. A specimen that shows one lies about what "
            "monitoring bought you, so this generator refuses to write it."
        )

    day_start = datetime(dispatch.day.year, dispatch.day.month, dispatch.day.day,
                         tzinfo=timezone.utc)
    timestamps = tuple(
        day_start + timedelta(minutes=cadence_minutes * k) for k in range(periods)
    )

    return DaySeries(
        day=dispatch.day,
        cadence_minutes=cadence_minutes,
        rack_ids=rack_ids,
        timestamps=timestamps,
        asset_soc=asset_soc,
        c_rate=c_rate,
        soc_pct=soc_pct,
        v_mid=v_mid,
        dv=dv,
        t_mid=t_mid,
        dt=dt,
        drift_progress=progress,
    )


# ---------------------------------------------------------------------------
# Silver shaped rows, for the same adapter the measured path uses
# ---------------------------------------------------------------------------


def silver_rows(series: DaySeries, *, plant_id: str, plant_slug: str,
                bess_asset_id: str) -> List[Dict[str, Any]]:
    """The specimen as ``silver_bess_telemetry`` rows.

    Shaped for ``rack_samples.rack_samples_from_silver`` so the specimen goes
    through the SAME pivot the measured path uses, including its SoC percent to
    fraction divisor and its extremes handling. A private shortcut into
    ``DeviceSample`` would skip the seam this specimen exists to exercise.
    """
    rows: List[Dict[str, Any]] = []
    for i, rack_id in enumerate(series.rack_ids):
        for k, ts in enumerate(series.timestamps):
            half_v = series.dv[i, k] / 2.0
            half_t = series.dt[i, k] / 2.0
            emitted = (
                ("bess_voltage_cell_max", series.v_mid[i, k] + half_v),
                ("bess_voltage_cell_min", series.v_mid[i, k] - half_v),
                ("bess_temp_cell_max", series.t_mid[i, k] + half_t),
                ("bess_temp_cell_min", series.t_mid[i, k] - half_t),
                # Percent, exactly as silver classifies it. The adapter applies
                # the one divisor, in one place.
                ("bess_soc_rack", series.soc_pct[i, k]),
            )
            for metric, value in emitted:
                rows.append({
                    "plant_id": plant_id,
                    "plant_slug": plant_slug,
                    "bess_asset_id": bess_asset_id,
                    "rack_device_id": rack_id,
                    "canonical_device_id": rack_id,
                    "device_grain": "rack",
                    "day": series.day,
                    "ts": ts,
                    "metric": metric,
                    "value_canonical": float(value),
                })
    return rows


# ---------------------------------------------------------------------------
# Daily rollups, by the shared spread definition
# ---------------------------------------------------------------------------


def _round(metric: str, value: float) -> float:
    places = ROUNDING.get(metric)
    return round(float(value), places) if places is not None else float(value)


def rack_day_metrics(series: DaySeries) -> Dict[str, Dict[str, float]]:
    """Per rack daily metrics under the gold_bess_rack_daily names.

    Spreads follow ``imbalance.SPREAD_DEFINITION`` exactly: the instantaneous
    spread at each poll, then the worst (and the p95, and the mean) over the
    day. Never the day envelope, which is emitted separately and under a name
    that says which question it answers.
    """
    n_racks, periods = series.dv.shape
    out: Dict[str, Dict[str, float]] = {}

    # SoC divergence from the sibling median, EXCLUDING the rack itself. A rack
    # counted in its own reference drags the centre toward itself and so under
    # reports exactly the case this number exists to catch.
    soc = series.soc_pct
    divergence = np.empty((n_racks, periods), dtype=float)
    if n_racks >= 2:
        for i in range(n_racks):
            siblings = np.delete(soc, i, axis=0)
            divergence[i] = soc[i] - np.median(siblings, axis=0)
    else:
        divergence[:] = np.nan

    n_metrics = len(SILVER_METRICS)
    for i, rack_id in enumerate(series.rack_ids):
        dv = series.dv[i]
        dt = series.dt[i]
        v_max = series.v_mid[i] + dv / 2.0
        v_min = series.v_mid[i] - dv / 2.0
        t_max = series.t_mid[i] + dt / 2.0
        t_min = series.t_mid[i] - dt / 2.0

        metrics: Dict[str, float] = {
            # Instantaneous spread, aggregated over the day.
            "voltage_spread_max_v": float(np.max(dv)),
            "voltage_spread_p95_v": float(np.quantile(dv, 0.95)),
            "voltage_spread_mean_v": float(np.mean(dv)),
            "voltage_spread_instants": float(periods),
            "temp_spread_max_c": float(np.max(dt)),
            "temp_spread_p95_c": float(np.quantile(dt, 0.95)),
            "temp_spread_mean_c": float(np.mean(dt)),
            "temp_spread_instants": float(periods),
            # Day envelope: a different question, under a name that says so.
            "voltage_cell_max_v": float(np.max(v_max)),
            "voltage_cell_min_v": float(np.min(v_min)),
            "voltage_spread_envelope_v": float(np.max(v_max) - np.min(v_min)),
            "temp_cell_max_c": float(np.max(t_max)),
            "temp_cell_min_c": float(np.min(t_min)),
            "temp_spread_envelope_c": float(np.max(t_max) - np.min(t_min)),
            # State of charge.
            "soc_mean_pct": float(np.mean(soc[i])),
            "soc_max_pct": float(np.max(soc[i])),
            "soc_min_pct": float(np.min(soc[i])),
            # Coverage, mirroring the gold model's own counts.
            "hours_observed": float(len({ts.hour for ts in series.timestamps})),
            "devices": 1.0,
            "samples": float(periods * n_metrics),
        }
        if n_racks >= 2:
            peak = int(np.argmax(np.abs(divergence[i])))
            metrics["soc_divergence_from_sibling_median_pct"] = float(divergence[i][peak])

        out[rack_id] = {k: _round(k, v) for k, v in metrics.items()}
    return out


def _combine(metric: str, values: Sequence[float]) -> Optional[float]:
    """Roll a metric up from children to a parent, by the declared policy."""
    present = [v for v in values if v is not None and np.isfinite(v)]
    if not present:
        return None
    policy = ROLLUP_POLICY.get(metric)
    if policy is None:
        # An unpoliced metric is a metric nobody decided how to combine, so it
        # does not get combined. Absent beats a plausible looking average.
        return None
    if policy == ROLLUP_MAX:
        return float(max(present))
    if policy == ROLLUP_MIN:
        return float(min(present))
    if policy == ROLLUP_SUM:
        return float(sum(present))
    if policy == ROLLUP_MEAN:
        return float(sum(present) / len(present))
    if policy == ROLLUP_ABS_MAX:
        return float(max(present, key=abs))
    raise ValueError(f"unknown rollup policy {policy!r} for {metric!r}")


def rollup(children: Mapping[str, Mapping[str, float]]) -> Dict[str, float]:
    """One parent's metrics from its children's, by ROLLUP_POLICY."""
    names = sorted({m for child in children.values() for m in child})
    out: Dict[str, float] = {}
    for metric in names:
        value = _combine(metric, [child.get(metric) for child in children.values()])
        if value is not None:
            out[metric] = _round(metric, value)
    return out


# ---------------------------------------------------------------------------
# Records for analysis_results
# ---------------------------------------------------------------------------


def _row_metadata(grain: str) -> Dict[str, Any]:
    """The per row provenance stamp.

    Four short keys, matching the discipline in ``nuravolt/lake/publish.py``:
    this JSONB is stored on EVERY row and a year of rack rollups is tens of
    thousands of rows per plant, so each extra key is measured in megabytes.
    """
    return {
        "provenance": PROVENANCE,
        "basis": SPECIMEN_BASIS,
        "generator": GENERATOR,
        "grain": grain,
    }


def day_records(
    series: DaySeries,
    topology: Topology,
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, float]], Dict[str, Dict[str, float]],
           Dict[str, float]]:
    """Every analysis_results record for one day, at all three grains.

    Returns (records, per rack metrics, per unit metrics, asset metrics).
    """
    time = datetime(series.day.year, series.day.month, series.day.day, tzinfo=timezone.utc)
    per_rack = rack_day_metrics(series)

    per_unit: Dict[str, Dict[str, float]] = {}
    for unit_id in topology.unit_device_ids():
        members = {
            r.device_id: per_rack[r.device_id]
            for r in topology.racks_in_unit(unit_id)
            if r.device_id in per_rack
        }
        if members:
            per_unit[unit_id] = rollup(members)

    asset_metrics = rollup(per_unit) if per_unit else {}

    records: List[Dict[str, Any]] = []

    def emit(device_id: str, metrics: Mapping[str, float], grain: str) -> None:
        meta = _row_metadata(grain)
        for metric, value in sorted(metrics.items()):
            records.append({
                "time": time,
                "device_id": device_id,
                "metric": metric,
                "value": float(value),
                "metadata": meta,
            })

    for rack in topology.racks:
        if rack.device_id in per_rack:
            emit(rack.device_id, per_rack[rack.device_id], GRAIN_RACK)
    for unit_id, metrics in per_unit.items():
        emit(unit_id, metrics, GRAIN_UNIT)
    if asset_metrics:
        emit(topology.asset_device_id, asset_metrics, GRAIN_ASSET)

    return records, per_rack, per_unit, asset_metrics


# ---------------------------------------------------------------------------
# The state of safety artifact
# ---------------------------------------------------------------------------


def specimen_state_of_safety_payload(
    sos: Any,
    *,
    asset_db_id: str,
    external_asset_id: str,
    asset_name: Any = None,
    interval_minutes: Any = None,
    window: Any = None,
) -> Dict[str, Any]:
    """The shared envelope, filled in with the specimen's basis.

    ``provisional=True``, ``measured=False`` and ``sub_asset_telemetry='modelled'``
    are all separate claims and all three are made explicitly. The label the
    console footer and the alert email both render ends "(modelled rack
    specimen)".
    """
    return safety_artifact.state_of_safety_payload(
        sos,
        asset_db_id=asset_db_id,
        external_asset_id=external_asset_id,
        basis=SPECIMEN_BASIS,
        basis_label=SPECIMEN_BASIS_LABEL,
        asset_name=asset_name,
        interval_minutes=interval_minutes,
        window=window,
        window_key=safety_artifact.WINDOW_KEY_MODELLED,
        basis_notes=SPECIMEN_BASIS_NOTES,
        basis_note_default=SPECIMEN_BASIS_NOTE_DEFAULT,
        provenance_note=SPECIMEN_PROVENANCE_NOTE,
        provisional=True,
        measured=False,
        sub_asset_telemetry="modelled",
    )


def analyze_specimen_day(
    series: DaySeries,
    *,
    plant_id: str,
    plant_slug: str,
    asset_db_id: str,
    asset_name: Optional[str],
    chemistry: Any,
    capacity_kwh: float,
    power_kw: float,
    installation_date: Optional[date],
) -> Tuple[Any, Any, List[Any], Optional[float]]:
    """Run the real engine over one specimen day.

    Same call sequence as the measured path in ``bess_measured.py``: pivot with
    the shared adapter, ``load_rack_samples``, then ``calculate_state_of_safety``.
    No asset grain frame is loaded and ``column_mapping`` is declared empty, so
    thermal margin, dwell exposure and protection status report unavailable with
    their reasons rather than being scored off channels this run does not have.

    Returns (state of safety, imbalance report, samples, cadence minutes).
    """
    rows = silver_rows(series, plant_id=plant_id, plant_slug=plant_slug,
                       bess_asset_id=asset_db_id)
    samples, _diagnostics = rack_samples_from_silver(rows)

    install = installation_date or series.day
    cfg = BESSPipelineConfig(
        asset=BessAssetConfig(
            asset_id=asset_db_id,
            plant_id=plant_id,
            name=asset_name or plant_slug,
            chemistry=chemistry,
            nominal_capacity_kwh=capacity_kwh,
            nominal_power_kw=power_kw,
            installation_date=datetime(install.year, install.month, install.day),
        )
    )
    pipe = BESSIntelligencePipeline(cfg)
    pipe.column_mapping = {}
    pipe.load_rack_samples(samples)

    seconds = infer_cadence_seconds(samples)
    cadence = round(seconds / 60.0, 4) if seconds else None
    sos = pipe.calculate_state_of_safety(interval_minutes=cadence)
    return sos, pipe.imbalance_report, samples, cadence


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def specimen_run_id(external_asset_id: str, model_version: str = MODEL_VERSION) -> str:
    """Deterministic run id per (asset, model version), so a rerun replaces."""
    return str(uuid.uuid5(RUN_NAMESPACE, f"{external_asset_id}|{model_version}"))


def _assert_modelled(model_version: str) -> str:
    """Refuse any model version that does not announce itself as modelled.

    A guard, not a convention. Every surface downstream keys its "is this real?"
    caption off the model version, and a specimen published under a neutral name
    is indistinguishable from a measurement at every layer that matters.
    """
    version = str(model_version or "")
    if not version.startswith(MODELLED_PREFIX):
        raise ValueError(
            f"model_version {version!r} does not start with {MODELLED_PREFIX!r}. "
            "This writer publishes a modelled specimen and refuses to publish it "
            "under a name that does not say so."
        )
    return version


def _delete_scope(conn, plant_id: str, model_version: str, asset_device_id: str) -> int:
    """Clear this specimen's rows for one asset, so a rewrite replaces exactly.

    Scoped by the device id as well as (plant, domain, model version): a plant
    can hold more than one battery, and a plant wide delete would let the last
    asset processed wipe its siblings' rows.

    ``left(...)`` rather than ``LIKE``, so an asset token containing a LIKE
    wildcard cannot widen the scope of a DELETE, and the prefix carries its own
    dot so ``BESS foo`` cannot reach the children of ``BESS foo-2``.
    """
    child_prefix = f"{asset_device_id}."
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM analysis_results "
            "WHERE plant_id = %s AND domain = %s AND model_version = %s "
            "AND (device_id = %s OR left(device_id, %s) = %s)",
            (plant_id, DOMAIN, model_version,
             asset_device_id, len(child_prefix), child_prefix),
        )
        return cur.rowcount or 0


def write_records(
    conn,
    *,
    plant_id: str,
    records: Sequence[Dict[str, Any]],
    model_version: str,
    run_id: str,
    batch_size: int = 1000,
) -> int:
    """Upsert specimen rows into ``analysis_results`` on the caller's connection.

    Uses ``TimeseriesWriter``'s own INSERT statement rather than a second copy
    of it, so the conflict target and the update list cannot drift. The writer
    class itself owns its connection and would open a second one, which would
    put the DELETE and the INSERT in different transactions; a specimen half
    replaced is worse than one not written.
    """
    from psycopg2.extras import execute_values

    from nuravolt.db.writer import _ANALYSIS_INSERT, _ANALYSIS_TEMPLATE

    if not records:
        return 0
    _assert_modelled(model_version)

    rows = [
        {
            "time": rec["time"],
            "plant_id": plant_id,
            "device_id": rec.get("device_id"),
            "domain": DOMAIN,
            "metric": rec["metric"],
            "value": float(rec["value"]),
            "confidence": rec.get("confidence"),
            "model_version": model_version,
            "run_id": run_id,
            "metadata": json.dumps(rec["metadata"]) if rec.get("metadata") else None,
        }
        for rec in records
    ]

    total = 0
    with conn.cursor() as cur:
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start + batch_size]
            execute_values(cur, _ANALYSIS_INSERT, batch,
                           template=_ANALYSIS_TEMPLATE, page_size=batch_size)
            total += len(batch)
    conn.commit()
    return total


def _asset_metadata_patch(
    topology: Topology,
    drifting: Rack,
    *,
    window: Tuple[date, date],
    cadence_minutes: int,
    drift_days: int,
) -> Dict[str, Any]:
    """The block written to ``BessAsset.metadata.rack_specimen``.

    The asset row alone has to tell the story: what generated the rack channels,
    how many racks and cells the model assumes, which rack drifts, and the plain
    statement that none of it is a fact about hardware.
    """
    return {
        "rack_specimen": {
            "generator": GENERATOR,
            "model_version": MODEL_VERSION,
            "basis": SPECIMEN_BASIS,
            "provenance": PROVENANCE,
            "measured": False,
            "provisional": True,
            "drifting_rack": drifting.device_id,
            "drift_days": drift_days,
            "drift_end": {
                "voltage_spread_mv": DRIFT_DV_END_MV,
                "temp_spread_c": DRIFT_DT_END_C,
                "soc_divergence_pp": DRIFT_SOC_DIVERGENCE_END_PP,
            },
            "cadence_minutes": cadence_minutes,
            "window": [window[0].isoformat(), window[1].isoformat()],
            "spread_basis": SPREAD_BASIS_EXTREMES,
            "spread_definition": SPREAD_DEFINITION,
            "module_count": None,
            "module_count_note": (
                "Left null on purpose. Modules are not modelled by this "
                "specimen and a number here would be an invention."
            ),
            "note": (
                "Rack count is a modelling choice consistent with the physics, "
                "not a fact about hardware, because there is no hardware: this "
                "asset is a declared nameplate with no battery management "
                "system connected. Every rack channel under model version "
                f"{MODEL_VERSION!r} is derived from this asset's own dispatch "
                "twin and is modelled, never measured."
            ),
            **topology.as_dict(),
        }
    }


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def _chemistry(value: Any) -> BessChemistry:
    try:
        return BessChemistry(str(value).lower())
    except ValueError:
        return BessChemistry.LFP


def _as_date(value: Any) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _read_asset(conn, plant_id: str) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    import psycopg2.extras

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT id, plant_id, external_asset_id, name, chemistry, '
            ' nominal_capacity_kwh, nominal_power_kw, rack_count, module_count, '
            ' installation_date, metadata '
            'FROM "BessAsset" WHERE plant_id = %s ORDER BY created_at ASC, id ASC',
            (plant_id,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    if not rows:
        return None, []
    return rows[0], [str(r["id"]) for r in rows]


_HEADLINE_METRICS = (
    "voltage_spread_max_v",
    "voltage_spread_mean_v",
    "temp_spread_max_c",
    "temp_spread_mean_c",
    "soc_divergence_from_sibling_median_pct",
)


def _day_report(
    series: DaySeries,
    per_rack: Mapping[str, Mapping[str, float]],
    per_unit: Mapping[str, Mapping[str, float]],
    asset_metrics: Mapping[str, float],
    drifting: Rack,
) -> Dict[str, Any]:
    """What one day looks like, for the run summary.

    Reports the healthy racks as a RANGE rather than a mean, because the whole
    point of the specimen is the distance between one rack and the band its
    siblings occupy, and a mean hides the band.
    """
    healthy = [m for rack_id, m in per_rack.items() if rack_id != drifting.device_id]

    def band(metric: str) -> Optional[List[float]]:
        values = [m[metric] for m in healthy if metric in m]
        return [min(values), max(values)] if values else None

    return {
        "day": series.day.isoformat(),
        "drift_progress": round(series.drift_progress, 4),
        "drifting_rack": {
            k: v for k, v in per_rack[drifting.device_id].items() if k in _HEADLINE_METRICS
        },
        "healthy_racks": {
            "count": len(healthy),
            **{f"{m}_band": band(m) for m in _HEADLINE_METRICS},
        },
        "asset_rollup": {
            k: v for k, v in asset_metrics.items()
            if k in ("voltage_spread_max_v", "temp_spread_max_c",
                     "soc_divergence_from_sibling_median_pct")
        },
        "units": sorted(per_unit),
    }


def generate_rack_specimen(
    conn,
    plant: Dict[str, Any],
    *,
    days: int = DEFAULT_DAYS,
    cadence_minutes: int = DEFAULT_CADENCE_MINUTES,
    drift_days: int = DRIFT_DAYS,
    drifting_rack: str = DEFAULT_DRIFTING_RACK,
    rack_energy_kwh: float = RACK_ENERGY_KWH,
    model_version: str = MODEL_VERSION,
    publish_safety: bool = True,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Generate and persist a labelled rack specimen for one plant's battery.

    Returns a summary dict. Writes nothing at all when it refuses, and every
    refusal is reported under ``skipped`` with its reason rather than raising,
    so a nightly caller can run this over a fleet without a try/except around
    every plant. The two guards that MUST NOT be soft are the exceptions:
    an unlabelled model version raises, because it is a programming error.
    """
    from nuravolt.db.writer import write_artifact

    version = _assert_modelled(model_version)

    summary: Dict[str, Any] = {
        "plant": plant.get("slug"),
        "generator": GENERATOR,
        "model_version": version,
        "basis": SPECIMEN_BASIS,
        "provenance": PROVENANCE,
        "measured": False,
        "provisional": True,
        "dry_run": bool(dry_run),
    }

    asset, asset_ids = _read_asset(conn, str(plant["id"]))
    if asset is None:
        summary["skipped"] = "plant has no BessAsset; a specimen needs a nameplate to model"
        return summary
    summary["asset_id"] = str(asset["id"])
    summary["external_asset_id"] = str(asset.get("external_asset_id") or asset["id"])

    # Several batteries on one plant. The per device rollups stay perfectly well
    # defined, because every row is keyed by a device id under THIS asset. The
    # state of safety artifact is not: it is one row per (plant, kind), so
    # publishing one battery's specimen as the plant's would attribute it to the
    # other. So the ambiguity gates the artifact, not the whole run, and the
    # asset chosen is the oldest one, which is the same battery
    # scripts/generate_bess_audit_artifacts.py and the /bess page already serve.
    if len(asset_ids) > 1:
        summary["ambiguous_plant"] = (
            f"this plant carries {len(asset_ids)} batteries {asset_ids}; rack "
            f"rollups are written for the primary asset {summary['external_asset_id']!r} "
            "and the plant level state of safety artifact is NOT published, "
            "because one battery's specimen must not be presented as the plant's"
        )
        publish_safety = False

    regime = regime_from_asset(asset)
    summary["telemetry_regime"] = regime.as_dict()
    if regime.has_measured:
        # THE GUARD. Real telemetry always outranks a specimen, and a specimen
        # written on top of measurements is the one mistake here that cannot be
        # undone by looking at the numbers afterwards.
        summary["skipped"] = (
            "asset telemetry regime reports measured data "
            f"(mode {regime.mode!r}); a modelled specimen must never sit on top "
            "of real telemetry, so nothing was written"
        )
        return summary

    capacity_kwh = float(asset["nominal_capacity_kwh"] or 0.0)
    power_kw = float(asset["nominal_power_kw"] or 0.0)
    if capacity_kwh <= 0 or power_kw <= 0:
        summary["skipped"] = "degenerate asset (0 kWh/kW)"
        return summary

    topology = build_topology(
        summary["external_asset_id"], capacity_kwh, rack_energy_kwh=rack_energy_kwh
    )
    drifting = choose_drifting_rack(topology, drifting_rack)
    character = rack_character(topology, drifting)
    summary["topology"] = topology.as_dict()
    summary["drifting_rack"] = drifting.device_id
    summary["drifting_rack_requested"] = drifting_rack
    if drifting.suffix != drifting_rack:
        summary["drifting_rack_note"] = (
            f"{drifting_rack} is not in this topology; used {drifting.suffix} instead"
        )
    if not topology.in_published_band:
        summary["topology_warning"] = (
            f"{topology.cells_per_mwh:.0f} cells/MWh sits outside the "
            f"{CELLS_PER_MWH_BAND[0]:.0f} to {CELLS_PER_MWH_BAND[1]:.0f} band real "
            "products span; the nameplate and the rack model disagree about what "
            "kind of product this is"
        )

    today = date.today()
    window = [today - timedelta(days=i) for i in range(max(1, int(days)) - 1, -1, -1)]
    dispatch = read_dispatch_days(conn, str(asset["id"]), window)
    modelled_days = sorted(dispatch)
    if not modelled_days:
        summary["skipped"] = (
            f"the dispatch twin has no schedule for any of the {len(window)} requested "
            "days; there is nothing to derive a rack specimen from"
        )
        return summary

    last_day = modelled_days[-1]
    summary["window"] = [modelled_days[0].isoformat(), last_day.isoformat()]
    summary["days_generated"] = len(modelled_days)
    summary["days_requested"] = len(window)
    summary["days_without_dispatch"] = len(window) - len(modelled_days)
    summary["cadence_minutes"] = cadence_minutes
    summary["drift_days"] = drift_days
    summary["spread_definition"] = SPREAD_DEFINITION
    summary["spread_basis"] = SPREAD_BASIS_EXTREMES

    records: List[Dict[str, Any]] = []
    last_series: Optional[DaySeries] = None
    for day in modelled_days:
        series = generate_day(
            topology,
            character,
            dispatch[day],
            last_day=last_day,
            cadence_minutes=cadence_minutes,
            drift_days=drift_days,
            power_kw=power_kw,
            capacity_kwh=capacity_kwh,
        )
        day_rows, per_rack, per_unit, asset_metrics = day_records(series, topology)
        records.extend(day_rows)
        last_series = series
        if day == last_day:
            summary["last_day"] = _day_report(series, per_rack, per_unit, asset_metrics,
                                              drifting)
        if series.drift_progress <= 0.0 and "quiet_day" not in summary:
            summary["quiet_day"] = _day_report(series, per_rack, per_unit, asset_metrics,
                                               drifting)

    summary["records"] = len(records)
    summary["devices"] = topology.rack_count + len(topology.unit_device_ids()) + 1
    summary["run_id"] = specimen_run_id(summary["external_asset_id"], version)

    # State of safety, for the MOST RECENT modelled day only. A headline stamped
    # generated_at = NOW() over a window that closed months ago would sail past
    # the 48 hour staleness guard in src/lib/alerts/evaluate.ts. Same rule the
    # modelled dispatch twin already follows.
    sos = None
    if last_series is not None:
        sos, report, samples, cadence = analyze_specimen_day(
            last_series,
            plant_id=str(plant["id"]),
            plant_slug=str(plant.get("slug") or ""),
            asset_db_id=str(asset["id"]),
            asset_name=asset.get("name"),
            chemistry=_chemistry(asset.get("chemistry", "LFP")),
            capacity_kwh=capacity_kwh,
            power_kw=power_kw,
            installation_date=_as_date(asset.get("installation_date")),
        )
        imbalance_sub = next((s for s in sos.sub_indices if s.name == "imbalance"), None)
        summary["imbalance"] = {
            "available": bool(imbalance_sub and imbalance_sub.available),
            "reason": imbalance_sub.reason if imbalance_sub else None,
            "score": imbalance_sub.score if imbalance_sub else None,
            "racks": report.rack_count if report else 0,
            "samples": len(samples),
            "sustained_outliers": len(report.outliers) if report else 0,
            "worst_modified_z": report.worst_modified_z if report else None,
            "outlier_metrics": sorted({o.metric for o in report.outliers}) if report else [],
            "outlier_racks": sorted({o.rack_id for o in report.outliers}) if report else [],
            "alignment_seconds": report.alignment_seconds if report else None,
            "cadence_minutes": cadence,
        }
        summary["state_of_safety"] = {
            "score": sos.score,
            "band": sos.band,
            "limiting_index": sos.limiting_index,
            "unavailable": sos.unavailable,
            "published": False,
            "kind": safety_artifact.SAFETY_ARTIFACT_KIND,
            "provisional": True,
            "basis": SPECIMEN_BASIS,
        }

    if dry_run:
        summary["written"] = 0
        return summary

    # Delete then write, one lane, so rollback is a single DELETE.
    summary["deleted"] = _delete_scope(
        conn, str(plant["id"]), version, topology.asset_device_id
    )

    patch = _asset_metadata_patch(
        topology, drifting,
        window=(modelled_days[0], last_day),
        cadence_minutes=cadence_minutes,
        drift_days=drift_days,
    )
    with conn.cursor() as cur:
        # Merge, never replace: a wholesale metadata write would drop the
        # telemetry regime block this run just read, and the next run would not
        # know whether real telemetry had arrived.
        #
        # module_count is deliberately untouched. Modules are not modelled and a
        # number there would be an invention; the refusal is recorded in the
        # metadata block instead.
        cur.execute(
            'UPDATE "BessAsset" SET metadata = COALESCE(metadata, \'{}\'::jsonb) || %s::jsonb, '
            "rack_count = %s, updated_at = NOW() WHERE id = %s",
            (json.dumps(patch), topology.rack_count, asset["id"]),
        )
    conn.commit()
    summary["rack_count_written"] = topology.rack_count
    summary["module_count"] = "left null: modules are not modelled"

    summary["written"] = write_records(
        conn,
        plant_id=str(plant["id"]),
        records=records,
        model_version=version,
        run_id=summary["run_id"],
    )

    if publish_safety and sos is not None:
        # Through the precedence helper: the specimen outranks the modelled
        # dispatch twin (it has rack channels the twin does not) but must never
        # displace real measured telemetry.
        published, reason = safety_artifact.publish_safety_artifact(
            conn,
            str(plant["id"]),
            specimen_state_of_safety_payload(
                sos,
                asset_db_id=str(asset["id"]),
                external_asset_id=summary["external_asset_id"],
                asset_name=asset.get("name") or plant.get("name"),
                interval_minutes=summary["imbalance"]["cadence_minutes"],
                window=(last_day, last_day),
            ),
            SPECIMEN_BASIS,
        )
        conn.commit()
        summary["state_of_safety"]["published"] = published
        summary["state_of_safety"]["publish_reason"] = reason

    return summary


# ---------------------------------------------------------------------------
# Verification helper: where does the detector actually cross?
# ---------------------------------------------------------------------------


def scan_outlier_days(
    conn,
    plant: Dict[str, Any],
    *,
    days: int = DEFAULT_DAYS,
    every: int = 5,
    cadence_minutes: int = DEFAULT_CADENCE_MINUTES,
    drift_days: int = DRIFT_DAYS,
    drifting_rack: str = DEFAULT_DRIFTING_RACK,
    rack_energy_kwh: float = RACK_ENERGY_KWH,
) -> List[Dict[str, Any]]:
    """Run the real outlier scan over a sample of days, for verification.

    Deliberately not part of the write path: running ``analyze_imbalance`` over
    a whole window costs minutes, and the specimen's daily rollups are computed
    directly from the same series by the same definition. This exists so a human
    can check WHERE the detector crosses rather than taking the calibration on
    trust.
    """
    asset, _ = _read_asset(conn, str(plant["id"]))
    if asset is None:
        return []
    capacity_kwh = float(asset["nominal_capacity_kwh"] or 0.0)
    power_kw = float(asset["nominal_power_kw"] or 0.0)
    external = str(asset.get("external_asset_id") or asset["id"])
    topology = build_topology(external, capacity_kwh, rack_energy_kwh=rack_energy_kwh)
    drifting = choose_drifting_rack(topology, drifting_rack)
    character = rack_character(topology, drifting)

    today = date.today()
    window = [today - timedelta(days=i) for i in range(max(1, int(days)) - 1, -1, -1)]
    dispatch = read_dispatch_days(conn, str(asset["id"]), window)
    modelled_days = sorted(dispatch)
    if not modelled_days:
        return []
    last_day = modelled_days[-1]

    out: List[Dict[str, Any]] = []
    for index, day in enumerate(modelled_days):
        if index % max(1, every) and day != last_day:
            continue
        series = generate_day(
            topology, character, dispatch[day],
            last_day=last_day, cadence_minutes=cadence_minutes, drift_days=drift_days,
            power_kw=power_kw, capacity_kwh=capacity_kwh,
        )
        rows = silver_rows(series, plant_id=str(plant["id"]),
                           plant_slug=str(plant.get("slug") or ""),
                           bess_asset_id=str(asset["id"]))
        samples, _ = rack_samples_from_silver(rows)
        report = analyze_imbalance(external, samples)
        found = [o for o in report.outliers if o.rack_id == drifting.device_id]
        i = series.rack_ids.index(drifting.device_id)
        out.append({
            "day": day.isoformat(),
            "days_before_end": (last_day - day).days,
            "drift_progress": round(series.drift_progress, 4),
            "voltage_spread_max_mv": round(float(np.max(series.dv[i])) * 1000.0, 2),
            "temp_spread_max_c": round(float(np.max(series.dt[i])), 3),
            "flagged_metrics": sorted({o.metric for o in found}),
            "worst_modified_z": (
                round(max(abs(o.modified_z) for o in found), 2) if found else None
            ),
            "flagged": bool(found),
        })
    return out


__all__ = [
    "MODEL_VERSION",
    "MODELLED_PREFIX",
    "GENERATOR",
    "SPECIMEN_BASIS",
    "SPECIMEN_BASIS_LABEL",
    "PROVENANCE",
    "RUNAWAY_PRECURSOR_V",
    "ROLLUP_POLICY",
    "Rack",
    "Topology",
    "RackCharacter",
    "DispatchDay",
    "DaySeries",
    "build_topology",
    "choose_drifting_rack",
    "rack_character",
    "read_dispatch_days",
    "generate_day",
    "silver_rows",
    "rack_day_metrics",
    "rollup",
    "day_records",
    "drift_progress",
    "analyze_specimen_day",
    "specimen_state_of_safety_payload",
    "specimen_run_id",
    "write_records",
    "generate_rack_specimen",
    "scan_outlier_days",
]
