"""Peer-relative scoring: judge a device against its siblings, not a constant.

WHY THIS EXISTS
---------------
Every threshold in ``nuravolt/fault/config.py`` is an absolute number, and the
repo's own artifacts show what that costs. The same rule set scores macro-F1
0.835 in-distribution with thresholds tuned on that dataset, 0.519 with untuned
physics defaults, and 0.189 on a different plant architecture. Roughly a third
of the in-distribution score is threshold fitting rather than detection skill.

A peer-relative statistic has **no portable constant in it**. Irradiance, cell
temperature, plant size, module orientation, soiling and inverter vendor all
cancel, because every sibling sees the same conditions at the same instant. The
only parameters are the flag level and the dwell window, and the flag level comes
from published statistical practice rather than from our data. That is what makes
a detector built here a tier A detector: there is no threshold to get wrong on
the next plant.

THE ARCHITECTURAL REASON THIS DID NOT EXIST BEFORE
--------------------------------------------------
``scripts/run_fault_detection.py::run_fault_detection_single_inverter`` slices one
inverter's columns and renames them before calling ``detect_all``. The detector
structurally could not see peers, so every rule had to be absolute. This module
plus ``RuleBasedFaultDetector.detect_plant_level`` is the change that lifts that
constraint.

WHAT IS SCORED, AND WHY BOTH
----------------------------
Two statistics per device per timestamp, and detectors fire on their conjunction:

    ratio = y_i / median_peers(y)
    z     = 0.6745 * (y_i - median_peers(y)) / MAD_peers(y)

The ratio alone is noisy at low output, where a small absolute difference is a
large relative one. The z alone explodes when a fleet is uniform and the MAD
approaches zero, which is exactly the well-behaved case that should be quiet.
Requiring both to trip removes both failure modes, and a floor on the MAD stops
the second one dead.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

import polars as pl

from nuravolt.fault.topology import PlantTopology, ScoringGroup
from nuravolt.stats.robust import MODIFIED_Z_SCALE

logger = logging.getLogger(__name__)

#: Minimum peers needed before a median and MAD mean anything. Below this the
#: group is not scored at all: a confident number from three points is worse
#: than no number.
MIN_PEERS = 4

#: Floor on the peer MAD, in per-unit output. Without it, a uniform healthy
#: fleet drives MAD toward zero and every trivial difference becomes a huge z.
#: 0.02 means "two percent of nameplate is the smallest dispersion we will
#: believe". Dimensionless, so it ports across plants unchanged.
MAD_FLOOR_PU = 0.02

#: Below this peer-median output there is not enough generation to compare
#: anything. Per-unit, so it is not an irradiance threshold in disguise.
MIN_PEER_MEDIAN_PU = 0.15


@dataclass(frozen=True)
class PeerScores:
    """Per-timestamp peer scores for one scoring group."""

    key: tuple
    level: str
    frame: pl.DataFrame          # timestamp + <device>__ratio + <device>__z
    scored_devices: List[str]
    n_population: int

    def device_columns(self, device: str) -> tuple:
        return f"{device}__ratio", f"{device}__z"


def _median_horizontal(cols: Sequence[str]) -> pl.Expr:
    """Row-wise median across columns.

    Polars has no ``median_horizontal``; this is the idiom already used in
    ``nuravolt/fault/features.py`` for the same purpose.
    """
    return pl.concat_list(cols).list.eval(pl.element().median()).list.first()


def _mad_horizontal(cols: Sequence[str], centre: pl.Expr) -> pl.Expr:
    """Row-wise median absolute deviation about a given centre."""
    return (
        pl.concat_list([(pl.col(c) - centre).abs() for c in cols])
        .list.eval(pl.element().median())
        .list.first()
    )


def score_group(
    df: pl.DataFrame,
    group: ScoringGroup,
    column_for: Dict[str, str],
    *,
    normalizers: Optional[Dict[str, float]] = None,
    timestamp_col: str = "timestamp",
    mad_floor: float = MAD_FLOOR_PU,
    min_peer_median: float = MIN_PEER_MEDIAN_PU,
) -> Optional[PeerScores]:
    """Score every device in ``group.scored`` against ``group.population``.

    Args:
        df: wide frame, one column per device.
        group: from ``PlantTopology.usable_peer_groups``.
        column_for: device id -> column name in ``df``.
        normalizers: device id -> nameplate kWp. Omit when the columns are
            already per-unit, which is the case for the ``Inverter Power
            Normalized (kW / kWp)`` channels.

    Returns None when the group cannot be scored, rather than returning zeros.
    A computed-looking zero reads as "perfectly balanced" and is the most
    dangerous number this module could produce.
    """
    population = [d for d in group.population if column_for.get(d) in df.columns]
    if len(population) < MIN_PEERS:
        logger.info("peer_stats: group %s has %d/%d columns present; skipping",
                    group.key, len(population), len(group.population))
        return None

    work = df.select([timestamp_col] + [column_for[d] for d in population])

    # Normalise to per-unit so devices of different nameplate are comparable.
    pu_names = []
    exprs = []
    for d in population:
        col = column_for[d]
        pu = f"__pu__{d}"
        pu_names.append(pu)
        scale = (normalizers or {}).get(d)
        expr = pl.col(col) if not scale else pl.col(col) / float(scale)
        exprs.append(expr.alias(pu))
    work = work.with_columns(exprs)

    centre = _median_horizontal(pu_names)
    work = work.with_columns(centre.alias("__centre"))
    work = work.with_columns(
        _mad_horizontal(pu_names, pl.col("__centre")).alias("__mad_raw")
    )
    # MODIFIED_Z_SCALE makes MAD a consistent estimator of sigma for normal data;
    # the floor stops a uniform fleet producing enormous scores from noise.
    work = work.with_columns(
        pl.max_horizontal(pl.col("__mad_raw"), pl.lit(mad_floor)).alias("__mad")
    )

    out_cols = [pl.col(timestamp_col)]
    for d in group.scored:
        if column_for.get(d) not in df.columns:
            continue
        pu = f"__pu__{d}"
        # Only comparable while the group is actually generating.
        gate = pl.col("__centre") >= min_peer_median
        out_cols.append(
            pl.when(gate)
            .then(pl.col(pu) / pl.col("__centre"))
            .otherwise(None)
            .alias(f"{d}__ratio")
        )
        out_cols.append(
            pl.when(gate)
            .then(MODIFIED_Z_SCALE * (pl.col(pu) - pl.col("__centre")) / pl.col("__mad"))
            .otherwise(None)
            .alias(f"{d}__z")
        )

    scored = [d for d in group.scored if column_for.get(d) in df.columns]
    if not scored:
        return None

    return PeerScores(
        key=group.key,
        level=group.level,
        frame=work.select(out_cols),
        scored_devices=scored,
        n_population=len(population),
    )


def score_plant(
    df: pl.DataFrame,
    topology: PlantTopology,
    column_for: Dict[str, str],
    *,
    level: str = "inverter_within_bus",
    timestamp_col: str = "timestamp",
    normalizers: Optional[Dict[str, float]] = None,
    **kwargs,
) -> List[PeerScores]:
    """Score every usable peer group on a plant."""
    groups = topology.usable_peer_groups(level, min_members=MIN_PEERS)
    out: List[PeerScores] = []
    for group in groups.values():
        scores = score_group(
            df, group, column_for,
            normalizers=normalizers, timestamp_col=timestamp_col, **kwargs,
        )
        if scores is not None:
            out.append(scores)
    return out


def sustained_deficit_mask(
    frame: pl.DataFrame,
    device: str,
    *,
    ratio_max: float,
    z_max: float,
    min_consecutive: int,
) -> pl.Series:
    """True where a device has been jointly ratio- and z-deficient long enough.

    A single sample over a threshold is not a fault; that is how alarm storms
    start. Both statistics must trip together for ``min_consecutive`` intervals.
    """
    ratio_col, z_col = f"{device}__ratio", f"{device}__z"
    if ratio_col not in frame.columns:
        return pl.Series([], dtype=pl.Boolean)

    tripped = (
        (pl.col(ratio_col) < ratio_max) & (pl.col(z_col) < z_max)
    ).fill_null(False)

    run = frame.select(
        tripped.alias("t"),
    ).with_columns(
        # Length of the current run of True values, computed as a cumulative
        # count that resets on every False.
        pl.col("t").rle_id().alias("run_id")
    )
    run = run.with_columns(
        pl.when(pl.col("t"))
        .then(pl.col("t").cum_sum().over("run_id"))
        .otherwise(0)
        .alias("run_len")
    )
    return (run["run_len"] >= min_consecutive)


# ---------------------------------------------------------------------------
# The shared kernel
# ---------------------------------------------------------------------------
#
# Everything above scores whole plants through a topology. The functions below
# are the same statistic applied to a bare list of sibling columns in one wide
# frame, which is the shape every within-inverter rule already has: the MPPT
# inputs of one machine, or the string currents behind one MPPT.
#
# There is one implementation of the statistic and both paths call it. Before
# this, four rules each carried their own hand-rolled median comparison with its
# own gates, which is how they came to disagree with each other.

#: Below this many siblings the DISPERSION cannot be estimated. A median from
#: three points is defensible; a median absolute deviation from three points is
#: not. When there are too few siblings the z is emitted as null rather than as
#: a confident-looking number, and callers fall back to the ratio test alone.
MIN_SIBLINGS_FOR_Z = 4

#: Iglewicz and Hoaglin's flag level for the modified z-score (ASTM E178,
#: NIST/SEMATECH e-Handbook 1.3.5.17). Published statistical practice, not a
#: value fitted on our data, which is the whole point of a tier A detector.
PEER_Z_FLAG = 3.5


def leave_one_out_scores(
    df: pl.DataFrame,
    target: str,
    siblings: Sequence[str],
    *,
    mad_floor: float = MAD_FLOOR_PU,
    min_centre: float = MIN_PEER_MEDIAN_PU,
    prefix: str = "_peer",
) -> pl.DataFrame:
    """Score one column against its siblings, excluding itself from the reference.

    Leave-one-out is not a nicety. With four string inputs and one of them dead,
    an all-columns median is computed from a set containing the dead channel, so
    the reference the dead channel is judged against has already been pulled
    toward it. At two or three siblings that is the difference between detecting
    the fault and not. The device under test never contributes to its own
    reference here.

    Adds three columns:

    ``{prefix}_centre``
        Median of the siblings. The comparison basis.
    ``{prefix}_ratio``
        ``target / centre``. Scale free, and the statistic an engineer reads.
    ``{prefix}_z``
        ``0.6745 * (target - centre) / MAD``, the Iglewicz-Hoaglin modified
        z-score. Negative means deficient. Null when there are fewer than
        ``MIN_SIBLINGS_FOR_Z`` siblings, because a MAD from three points is not
        a dispersion estimate.

    Both are emitted because each fails where the other works. The ratio is
    noisy at low output, where a small absolute gap is a large relative one. The
    z explodes when a fleet is uniform and the MAD tends to zero, which is
    exactly the healthy case that should stay silent. ``mad_floor`` blunts the
    second and the ``min_centre`` gate blunts the first; requiring both to trip
    removes what is left.

    PRECONDITION: the inputs must already be per-unit.

    The ratio is scale free on its own -- multiply every channel by any constant
    and it decides identically. The z is NOT, because ``mad_floor`` is an absolute
    number in the inputs' units, and that is deliberate: without a floor a uniform
    healthy fleet drives the MAD toward zero and every speck of noise becomes an
    enormous score. The floor is what makes the z usable, and the price is that it
    presumes a known scale.

    So callers normalise first -- ``_self_normalised`` in ``rule_based`` divides
    each channel by its own high quantile -- and then 0.02 means "two percent of
    this channel's own capacity" on every plant. Hand this function raw amps and
    the ratio will still be right while the z quietly stops meaning anything.
    """
    peers = [c for c in siblings if c != target and c in df.columns]
    centre, ratio, z = f"{prefix}_centre", f"{prefix}_ratio", f"{prefix}_z"

    if not peers or target not in df.columns:
        return df.with_columns([
            pl.lit(None, dtype=pl.Float64).alias(c) for c in (centre, ratio, z)
        ])

    work = df.with_columns(_median_horizontal(peers).alias(centre))

    # Only comparable while the siblings are genuinely generating. Below that,
    # both statistics are dominated by noise and neither means anything.
    gate = pl.col(centre) >= min_centre

    work = work.with_columns(
        pl.when(gate)
        .then(pl.col(target) / pl.col(centre))
        .otherwise(None)
        .alias(ratio)
    )

    if len(peers) < MIN_SIBLINGS_FOR_Z:
        logger.debug(
            "leave_one_out_scores: %s has %d sibling(s), below the %d needed for a "
            "dispersion estimate; emitting a null z rather than a fabricated one",
            target, len(peers), MIN_SIBLINGS_FOR_Z,
        )
        return work.with_columns(pl.lit(None, dtype=pl.Float64).alias(z))

    work = work.with_columns(
        _mad_horizontal(peers, pl.col(centre)).alias(f"{prefix}__mad_raw")
    )
    work = work.with_columns(
        pl.max_horizontal(
            pl.col(f"{prefix}__mad_raw"), pl.lit(mad_floor)
        ).alias(f"{prefix}__mad")
    )
    return work.with_columns(
        pl.when(gate)
        .then(
            MODIFIED_Z_SCALE
            * (pl.col(target) - pl.col(centre))
            / pl.col(f"{prefix}__mad")
        )
        .otherwise(None)
        .alias(z)
    ).drop([f"{prefix}__mad_raw", f"{prefix}__mad"])


def sustained(mask: pl.Expr, min_consecutive: int) -> pl.Expr:
    """True only where ``mask`` has held for ``min_consecutive`` intervals.

    A single sample over a threshold is not a fault; it is how alarm storms
    start. Cloud shadow crosses an array in minutes, a mismatched string does
    not move at all.

    Implemented as a rolling sum equal to the window, the idiom already used
    elsewhere in this package, so a run interrupted by even one good interval
    restarts rather than accumulating.
    """
    if min_consecutive <= 1:
        return mask
    return (
        # Polars leaves the first window-1 rows null, which is what we want: a run
        # cannot be established before the window has filled.
        mask.cast(pl.Int32).rolling_sum(window_size=min_consecutive)
        >= min_consecutive
    ).fill_null(False)


def peer_deficit(
    df: pl.DataFrame,
    target: str,
    siblings: Sequence[str],
    *,
    ratio_max: float,
    ratio_min: Optional[float] = None,
    z_max: float = -PEER_Z_FLAG,
    min_consecutive: int = 1,
    mad_floor: float = MAD_FLOOR_PU,
    min_centre: float = MIN_PEER_MEDIAN_PU,
    prefix: str = "_peer",
) -> tuple:
    """``(frame, mask)`` for "this column is genuinely below its siblings".

    The conjunction of a relative shortfall and a statistically improbable one,
    sustained. When the group is too small for a dispersion estimate the z gate
    is skipped rather than faked, so the test degrades to the ratio alone and
    says so in the log instead of quietly inventing confidence.

    ``ratio_min`` turns the one-sided test into a BAND. Some failure modes have a
    characteristic size, not merely a direction: a conducting bypass diode removes
    a known fraction of a string's cells and therefore a known fraction of its
    voltage, so a deficit far deeper than that is some other fault and should be
    reported as one. Leaving it None keeps the plain "below" test.
    """
    work = leave_one_out_scores(
        df, target, siblings,
        mad_floor=mad_floor, min_centre=min_centre, prefix=prefix,
    )
    ratio, z = f"{prefix}_ratio", f"{prefix}_z"

    below = pl.col(ratio).is_not_null() & (pl.col(ratio) < ratio_max)
    if ratio_min is not None:
        below = below & (pl.col(ratio) >= ratio_min)
    # Null z means "not estimable", never "not anomalous": skip the gate, do not
    # let it silently veto a real ratio deficit.
    improbable = pl.col(z).is_null() | (pl.col(z) < z_max)
    return work, sustained(below & improbable, min_consecutive)


def peer_excess(
    df: pl.DataFrame,
    target: str,
    siblings: Sequence[str],
    *,
    delta_min: float,
    delta_max: Optional[float] = None,
    z_min: float = PEER_Z_FLAG,
    min_consecutive: int = 1,
    mad_floor: float = MAD_FLOOR_PU,
    min_centre: Optional[float] = None,
    prefix: str = "_peer",
) -> tuple:
    """``(frame, mask)`` for "this column runs hotter than its siblings".

    The mirror of :func:`peer_deficit`, with one deliberate difference: it gates
    on the DIFFERENCE from the sibling median, not on the ratio.

    A ratio of two Celsius readings is not a physical quantity. Celsius is an
    interval scale with an arbitrary zero, so 40 C is not "twice as hot" as 20 C
    and ``t_i / median(t)`` changes meaning if you switch to Kelvin or Fahrenheit.
    Differences are scale-correct on an interval scale; ratios are not. Any signal
    without a true zero -- temperature, power factor, phase angle -- belongs here
    rather than in ``peer_deficit``.

    ``delta_min`` is therefore in the signal's own units, and so is ``mad_floor``.
    The portable part of the test is the z; the delta is there only to stop a
    statistically striking but operationally trivial difference being raised, and
    should be set from what an engineer would bother to act on.
    """
    work = leave_one_out_scores(
        df, target, siblings,
        mad_floor=mad_floor,
        min_centre=min_centre if min_centre is not None else float("-inf"),
        prefix=prefix,
    )
    centre, z = f"{prefix}_centre", f"{prefix}_z"
    delta = f"{prefix}_delta"
    work = work.with_columns((pl.col(target) - pl.col(centre)).alias(delta))

    above = pl.col(delta).is_not_null() & (pl.col(delta) >= delta_min)
    if delta_max is not None:
        above = above & (pl.col(delta) <= delta_max)
    improbable = pl.col(z).is_null() | (pl.col(z) > z_min)
    return work, sustained(above & improbable, min_consecutive)


#: Above this many siblings, the shared-reference path is used instead of exact
#: leave-one-out. See :func:`sibling_scores_wide` for why that is safe, and for
#: the cost of not doing it.
EXACT_LOO_MAX_PEERS = 8


def sibling_scores_wide(
    df: pl.DataFrame,
    cols: Sequence[str],
    *,
    mad_floor: float = MAD_FLOOR_PU,
    min_centre: float = MIN_PEER_MEDIAN_PU,
    exact_loo_max: int = EXACT_LOO_MAX_PEERS,
    prefix: str = "_peer",
) -> tuple:
    """Score EVERY column against its siblings in one pass. ``(frame, {col: (ratio, z, delta)})``

    WHY THIS EXISTS AND NOT JUST A LOOP
    -----------------------------------
    Calling :func:`leave_one_out_scores` once per device costs a horizontal median
    over N columns, N times: O(N^2) per row. On a 150-inverter plant with five
    years of 15-minute data that is billions of element operations and the rule
    simply does not finish. A detector that cannot run is not a detector, so the
    plant-level rules use this instead.

    Above ``exact_loo_max`` siblings the reference is computed ONCE over all
    columns and shared. That is not exact leave-one-out, and the difference is
    bounded and small: a single device shifts a median of nine or more values by
    at most one order statistic, roughly 1/N of the spread. Below the threshold
    the exact leave-one-out is kept, because that is where it decides outcomes --
    with four channels and one dead, an all-columns median already sits between
    the healthy value and zero.

    The honest limit of the shared path: if MANY devices in a group fail together,
    the shared reference moves with them and the group looks healthy. That failure
    mode is inherent to peer comparison, not to this optimisation -- an exact
    leave-one-out is equally blind to it, because it still leaves the other
    failures in the reference.
    """
    present = [c for c in cols if c in df.columns]
    if len(present) < 2:
        return df, {}

    work = df
    exact = len(present) - 1 <= exact_loo_max
    out: Dict[str, tuple] = {}

    if not exact:
        centre, mad = f"{prefix}__centre_all", f"{prefix}__mad_all"
        work = work.with_columns(_median_horizontal(present).alias(centre))
        work = work.with_columns(
            pl.max_horizontal(
                _mad_horizontal(present, pl.col(centre)), pl.lit(mad_floor)
            ).alias(mad)
        )

    exprs = []
    for c in present:
        rc, zc, dc = f"{prefix}_ratio__{c}", f"{prefix}_z__{c}", f"{prefix}_delta__{c}"
        if exact:
            peers = [x for x in present if x != c]
            cen = _median_horizontal(peers)
            work = work.with_columns(cen.alias(f"{prefix}__c__{c}"))
            work = work.with_columns(
                pl.max_horizontal(
                    _mad_horizontal(peers, pl.col(f"{prefix}__c__{c}")), pl.lit(mad_floor)
                ).alias(f"{prefix}__m__{c}")
            )
            cen_col, mad_col = f"{prefix}__c__{c}", f"{prefix}__m__{c}"
        else:
            cen_col, mad_col = centre, mad

        gate = pl.col(cen_col) >= min_centre
        exprs += [
            pl.when(gate).then(pl.col(c) / pl.col(cen_col)).otherwise(None).alias(rc),
            pl.when(gate)
            .then(MODIFIED_Z_SCALE * (pl.col(c) - pl.col(cen_col)) / pl.col(mad_col))
            .otherwise(None)
            .alias(zc),
            (pl.col(c) - pl.col(cen_col)).alias(dc),
        ]
        out[c] = (rc, zc, dc)

    return work.with_columns(exprs), out
