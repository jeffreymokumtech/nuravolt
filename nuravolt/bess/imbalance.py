"""
BESS imbalance detection (sub asset grain)

Per (asset, day, rack): temperature spread, voltage spread, and state of charge
divergence from the sibling median. Per (asset, day): the inter rack spreads.

GRAIN IS THE WHOLE POINT OF THIS MODULE
---------------------------------------
Asset grain telemetry (pack temperature, pack voltage, asset SoC) is what an OEM
cloud API hands over today. It supports absolute thresholds and rates of change,
which live in ``nuravolt.bess.thermal_monitor`` and work fine on a pack average.

Imbalance needs sub asset grain: per rack, per module, per cell. Voltage spread
across modules is the single best early indicator of a developing cell fault and
it simply cannot be inferred from a pack average -- averaging is the operation
that destroys the signal.

Where sub asset telemetry is absent this module reports the metric as
unavailable, carrying ``SUB_ASSET_UNAVAILABLE`` as the reason. It never emits a
zero spread for a metric it could not measure. A computed looking zero reads as
"perfectly balanced" and is the most dangerous number this file could produce.

WHY MEDIAN AND MAD, NOT MEAN AND STANDARD DEVIATION
---------------------------------------------------
Outlier scoring uses the modified z score

    mz = 0.6745 * (x - median(x)) / MAD(x)

(Iglewicz and Hoaglin, "How to Detect and Handle Outliers", ASTM 1993; also
NIST/SEMATECH e-Handbook of Statistical Methods, section 1.3.5.17), flagged at
|mz| > 3.5.

This is load bearing, not a style preference. A mean/standard deviation test
computes its dispersion estimate *from a population that contains the outlier*,
so one badly failing rack inflates the standard deviation enough to hide itself:
the worse the rack gets, the wider the band it is measured against. The median
and the MAD have a 50 percent breakdown point, so they are unmoved by exactly
the case this module exists to catch. ``tests/bess/test_imbalance.py`` pins that
behaviour with a fixture where a mean/std test misses a rack that MAD catches.

A single sample crossing 3.5 is not an alert. Flags require the deviation to be
sustained over a dwell window, scanned with the same routine the warranty
violation detector already uses, so the two planes agree on what "sustained"
means.

TWO GRAINS OF OUTLIER, AND THE SECOND ONE IS THE PRODUCT
--------------------------------------------------------
Comparing each rack's *level* against its siblings catches a rack running hot.
It cannot catch the failure worth selling: rack 7's cell to cell spread widens
from 18 mV to 60 mV while its 15 siblings sit at 18 +/- 4 mV. Rack 7's midpoint
barely moves, so a level test sees nothing. So the same modified z machinery
also runs over each rack's within rack spread, emitted as the ``spread_outlier``
grain with metric names like ``voltage_spread``. Same statistic, same dwell,
different input series.

EXTREMES ARE MEMBERS
--------------------
Real BMS cloud APIs almost never stream a per cell series. They stream extremes:
cell voltage max and min, cell temperature max and min, across whatever the
reporting device covers. Two extreme members give the spread *exactly* under the
definition below, so they need no special case in the maths, only an honest
label: ``spread_basis`` says whether a rack's spread came from real members or
from the two edges the BMS reports. A rack that physically holds several hundred
cells and reports two of them must not present as "2 modules reporting".

TIMESTAMP ALIGNMENT
-------------------
Cross rack scoring needs a population at each instant. Vendor polls are not
aligned across devices: a few seconds of jitter and every timestamp holds
exactly one rack, the modified z score sees fewer than two finite values and
returns all nan, and the detector never fires *while still reporting itself
available*. That is a silent false clean, the worst failure mode this file has.
Samples are therefore snapped down to a cadence bucket before grouping, and the
bucket used is reported on the result.
"""

import math
from dataclasses import dataclass, field
from datetime import date as date_type, datetime, timedelta
from enum import Enum
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np

from nuravolt.bess.thermal_monitor import SafetySubIndex
from nuravolt.bess.warranty_violation_detector import WarrantyViolationDetector


# --- Policy constants ------------------------------------------------------

# The robust scoring primitives now live in nuravolt/stats/robust.py, because
# the PV fault path needs exactly the same statistic against inverter and string
# siblings. Re-exported here so every existing import keeps working, and the
# reasoning above stays with the module that first needed it.
from nuravolt.stats.robust import (  # noqa: F401
    MEAN_AD_SCALE,
    MODIFIED_Z_SCALE,
    classic_z_scores,
    median_absolute_deviation,
    modified_z_scores,
)

#: Flag point from the same source. Not tuned by us.
DEFAULT_OUTLIER_THRESHOLD = 3.5

#: NuraVolt policy: a deviation must persist this long before it is a finding.
#: Matches the temperature dwell window in ViolationDetectionConfig so the
#: safety plane and the warranty plane do not disagree about "sustained".
DEFAULT_DWELL_MINUTES = 30

#: A modified z score over two points is always +/- 0.6745 by construction, so
#: it can never flag. Below three siblings there is no population to be an
#: outlier of, and we say so rather than returning a score that cannot fire.
MIN_RACKS_FOR_OUTLIER = 3

#: A spread needs at least two members to be a spread.
MIN_MEMBERS_FOR_SPREAD = 2

#: A dwell test needs samples inside the dwell window. Two points at the edges
#: are a line, not evidence of persistence, so below this many samples the
#: sustained grains report themselves unresolvable instead of flagging.
MIN_SAMPLES_IN_DWELL = 3

#: The exact wording every surface must use when sub asset telemetry is missing.
SUB_ASSET_UNAVAILABLE = "Requires rack level telemetry, connect your BMS to enable"

#: Reason emitted when racks exist but there are too few of them to score.
TOO_FEW_SIBLINGS = (
    f"Requires at least {MIN_RACKS_FOR_OUTLIER} racks reporting, "
    "outlier scoring needs siblings to compare against"
)

#: Reason emitted when the feed is too coarse to say whether a deviation was
#: sustained. Not a flag and not a clean bill of health: an unanswerable
#: question, reported as unanswered.
DWELL_UNRESOLVABLE = (
    f"Requires at least {MIN_SAMPLES_IN_DWELL} samples inside the dwell window, "
    "this feed's cadence is too coarse to test whether a deviation is sustained"
)


# --- One definition of spread ----------------------------------------------
#
# There are two defensible ways to turn a day of sub asset readings into one
# "spread" number, they give different answers, and the whole platform has to
# pick one and name it:
#
#   1. instantaneous, then worst over the window (what this module computes)
#          spread(t) = max(members at t) - min(members at t)
#          reported  = max over t
#      This is the physical quantity: at every instant, how far apart were the
#      cells that are wired in series. Widening it means real divergence.
#
#   2. the day envelope
#          reported = max over (member, t) - min over (member, t)
#      This is a different number and it is systematically larger. It over reads
#      any rack whose extremes never coincide, because it subtracts the coldest
#      cell at dawn from the hottest cell at noon. On a battery cycling twice a
#      day it over reads by the whole SoC swing, which is tens of percentage
#      points of nothing at all.
#
# Both are computable and (2) is cheaper in SQL, which is exactly why the two
# will drift into the same column name if nobody stops it. They must never share
# one. This constant is the definition of record: a dbt model quotes it and a
# parity test asserts the warehouse number equals the number computed here, so
# the definition lives in code where it cannot silently change.
SPREAD_DEFINITION = (
    "instantaneous_then_worst: spread(t) = max(members at t) - min(members at t), "
    "reported as the worst spread(t) over the window. Not the day envelope "
    "(max over all members and times minus min over all members and times), "
    "which over reads any rack whose extremes never coincide."
)

#: The centre a rack is compared against, and the one place it is named. The
#: median, never the mean: a mean is dragged toward the failing rack by the
#: failing rack, so the sibling reference moves to meet the fault. Dispersion is
#: the MAD for the same reason. Changing this changes what "normal" means on
#: every safety surface, so it is a constant and not a call site decision.
SIBLING_CENTRE = "median"


# --- Member kinds ----------------------------------------------------------

#: A real physical child of the rack: a module or a cell with its own id.
MEMBER_KIND_DEVICE = "device"

#: An edge the BMS reports across a population it does not stream: cell voltage
#: max and min, cell temperature max and min. Two extremes give the spread
#: exactly, and nothing else. They are not a census of the rack.
MEMBER_KIND_EXTREME = "extreme"

#: A scalar the rack reports about itself (rack SoC, a single rack temperature).
#: One value is not a spread, and a rack whose only reading is a scalar reports
#: no spread rather than a zero one.
MEMBER_KIND_RACK = "rack"

#: How a rack's spread was obtained. A UI must say which: "2 members" from a
#: rack of 700 cells means the BMS reported its two edges, not that the rack has
#: two modules.
SPREAD_BASIS_EXTREMES = "extremes"
SPREAD_BASIS_MEMBERS = "members"
#: Both kinds present in one population. The adapter should have dropped the
#: extremes in favour of the children (an extreme is a summary *of* the
#: children, so counting both double counts the edges); seeing this means it
#: did not, and the number is labelled rather than trusted.
SPREAD_BASIS_MIXED = "mixed"


# --- Timestamp alignment ---------------------------------------------------

#: Cadence buckets a real feed can plausibly be on. Inference floors the
#: observed median gap to one of these rather than trusting it directly, so a
#: single long gap or a burst cannot move the grid.
ALIGNMENT_BUCKETS_SECONDS: Tuple[int, ...] = (60, 300, 900, 1800)

#: How far below a bucket an observed cadence may sit and still be read as that
#: bucket. Jitter is what makes this necessary and it is not a nicety: a five
#: minute feed with a few seconds of poll jitter measures at 298 seconds, and a
#: strict floor would call that a sixty second feed. Every rack would then get
#: its own bucket and the alignment would achieve precisely nothing, which is
#: the failure it exists to prevent. The buckets are far enough apart (60, 300,
#: 900, 1800) that a tenth is nowhere near ambiguous.
CADENCE_JITTER_TOLERANCE = 0.10

#: The alignment rule, stated once so the warehouse can implement the same one
#: rather than a plausible looking cousin. Same purpose as SPREAD_DEFINITION:
#: any cross grid arithmetic done in SQL must quote this and match it.
ALIGNMENT_RULE = (
    "Timestamps are snapped to the NEAREST bucket boundary measured from local "
    "midnight, not floored. In SQL: date_trunc to the bucket after adding half "
    "a bucket, not date_trunc alone. Vendors poll on the clock, so nominal "
    "instants sit on the boundaries and a floor scatters each early poll into "
    "the previous bucket, away from its own siblings."
)


#: Grains whose findings are sustained outlier scores. ``spread_outlier`` runs
#: the same statistic over each rack's within rack spread instead of its level.
OUTLIER_GRAINS: Tuple[str, ...] = ("outlier", "spread_outlier")

#: Every grain reported, in the order they are computed.
ALL_GRAINS: Tuple[str, ...] = ("within_rack", "inter_rack") + OUTLIER_GRAINS

#: Suffix appended to a metric name for a finding on the spread grain, so
#: ``voltage`` (rack level) and ``voltage_spread`` (cell to cell spread inside
#: the rack) can never be mistaken for one another downstream.
SPREAD_METRIC_SUFFIX = "_spread"


class ImbalanceMetric(Enum):
    """Sub asset metrics this module can measure."""

    TEMPERATURE = "temperature"
    VOLTAGE = "voltage"
    SOC = "soc"


#: Display unit per metric, used in messages and by the UI.
METRIC_UNITS: Dict[ImbalanceMetric, str] = {
    ImbalanceMetric.TEMPERATURE: "C",
    ImbalanceMetric.VOLTAGE: "V",
    ImbalanceMetric.SOC: "pp",
}


# --- Inputs and results ----------------------------------------------------


@dataclass
class DeviceSample:
    """
    One sub asset reading at one timestamp.

    ``member_id`` identifies a member of the rack's population: a module, a
    cell, or one of the two extremes the BMS reports. Leave it None for a rack
    aggregate row: within rack spreads then report as unavailable for that rack
    instead of quietly collapsing to zero.

    ``member_kind`` says what that member is, and it is the difference between
    an honest caption and a misleading one. Two members of kind ``extreme`` give
    the spread exactly, but they are the edges of a population of hundreds, not
    a population of two.
    """

    timestamp: datetime
    rack_id: str
    member_id: Optional[str] = None
    temperature_c: Optional[float] = None
    voltage_v: Optional[float] = None
    soc: Optional[float] = None  # fraction, 0 to 1
    member_kind: str = MEMBER_KIND_DEVICE


@dataclass
class MetricAvailability:
    """Whether a metric could be measured at all, and why not when it could not."""

    metric: str
    grain: str  # 'within_rack' | 'inter_rack' | 'outlier' | 'spread_outlier'
    available: bool
    reason: Optional[str] = None
    #: 'extremes' | 'members' | 'mixed' | None, on the member dependent grains.
    #: What the spreads behind this metric were actually computed from.
    member_basis: Optional[str] = None


@dataclass
class RackDayImbalance:
    """Per (asset, day, rack) imbalance. None means not measured, never zero."""

    rack_id: str
    day: date_type
    sample_count: int
    member_count: int
    temperature_spread_c: Optional[float] = None
    voltage_spread_v: Optional[float] = None
    soc_divergence_pp: Optional[float] = None
    #: 'extremes' | 'members' | 'mixed', or None when no spread was measurable.
    #: Read it with ``member_count``: 2 members on the ``extremes`` basis is a
    #: rack reporting its two edges, not a rack with two modules.
    spread_basis: Optional[str] = None


@dataclass
class ImbalanceOutlier:
    """A sustained modified z score exceedance for one rack on one metric."""

    rack_id: str
    metric: str
    unit: str
    modified_z: float
    observed_value: float
    sibling_median: float
    sibling_mad: float
    started_at: datetime
    ended_at: datetime
    duration_minutes: float
    threshold: float = DEFAULT_OUTLIER_THRESHOLD

    @property
    def description(self) -> str:
        return (
            f"Rack {self.rack_id} {self.metric} sits {self.modified_z:+.1f} modified z "
            f"from the sibling median of {self.sibling_median:.2f} {self.unit} "
            f"for {self.duration_minutes:.0f} minutes"
        )


@dataclass
class ImbalanceReport:
    """Everything measured for one asset over one day."""

    asset_id: str
    day: Optional[date_type]
    rack_count: int
    racks: List[RackDayImbalance] = field(default_factory=list)
    #: metric name -> worst inter rack spread seen in the window
    inter_rack_spread: Dict[str, float] = field(default_factory=dict)
    outliers: List[ImbalanceOutlier] = field(default_factory=list)
    availability: List[MetricAvailability] = field(default_factory=list)
    dwell_minutes: float = DEFAULT_DWELL_MINUTES
    threshold: float = DEFAULT_OUTLIER_THRESHOLD
    #: Bucket every timestamp was snapped down to before grouping, or None when
    #: no alignment was applied.
    alignment_seconds: Optional[int] = None
    #: How that bucket was chosen: 'explicit', 'inferred_from_cadence',
    #: 'inferred_cadence_below_smallest_bucket', 'disabled', or
    #: 'single_sample_no_alignment'.
    alignment_basis: Optional[str] = None
    #: Median inter sample gap observed within a rack, pooled across racks.
    cadence_seconds: Optional[float] = None

    @property
    def has_sub_asset_telemetry(self) -> bool:
        """True when at least one metric could actually be measured."""
        return any(a.available for a in self.availability)

    @property
    def worst_modified_z(self) -> Optional[float]:
        """Largest sustained |mz| seen, or None when nothing was measurable."""
        if not self.outliers:
            return 0.0 if self.scoreable else None
        return max(abs(o.modified_z) for o in self.outliers)

    @property
    def scoreable(self) -> bool:
        """True when outlier scoring actually ran on at least one metric."""
        return any(
            a.available for a in self.availability if a.grain in OUTLIER_GRAINS
        )


# --- Modified z score ------------------------------------------------------


# Reuse the contiguous-period scanner the warranty violation detector already
# ships rather than writing a second one that could drift from it. It is a
# private helper there; promoting it to a public function is a follow-up owned
# by that file, not this one.
_DWELL_SCANNER = WarrantyViolationDetector()


def _sustained_periods(
    timestamps: Sequence[datetime],
    values: np.ndarray,
    threshold: float,
    min_duration_minutes: float,
) -> List[Tuple[datetime, datetime, float, List[float]]]:
    """
    Contiguous runs where ``values`` stay above ``threshold`` for at least
    ``min_duration_minutes``. Returns (start, end, duration_minutes, values).
    """
    if len(timestamps) == 0:
        return []
    events = _DWELL_SCANNER._find_violation_periods(  # noqa: SLF001 - deliberate reuse
        timestamps=np.asarray(list(timestamps), dtype=object),
        values=np.asarray(values, dtype=float),
        threshold=threshold,
        above=True,
        min_duration_minutes=min_duration_minutes,
    )
    return [
        (
            e.start_time,
            e.end_time,
            float(e.metadata.get("duration_minutes", 0.0)),
            list(e.measured_values),
        )
        for e in events
    ]


# --- Timestamp alignment ---------------------------------------------------


def infer_cadence_seconds(samples: Iterable[DeviceSample]) -> Optional[float]:
    """
    Median inter sample gap, measured inside each rack and pooled across racks.

    Measured per rack on purpose. Pooling the distinct timestamps of the whole
    asset first would measure the jitter between racks rather than the poll
    cadence: sixteen racks each on a five minute clock, each a few seconds
    apart, would read as a cadence of a few seconds.

    None when no rack has two distinct timestamps, which is also the honest
    answer to "how often does this feed report".
    """
    by_rack: Dict[str, Set[datetime]] = {}
    for s in samples:
        by_rack.setdefault(s.rack_id, set()).add(s.timestamp)

    gaps: List[float] = []
    for stamps in by_rack.values():
        ordered = sorted(stamps)
        gaps.extend(
            gap
            for gap in ((b - a).total_seconds() for a, b in zip(ordered, ordered[1:]))
            if gap > 0
        )
    if not gaps:
        return None
    return float(np.median(gaps))


def _alignment_bucket(cadence_seconds: Optional[float]) -> Tuple[Optional[int], str]:
    """
    Floor an observed cadence to a plausible bucket, and say how.

    Floor, not nearest, because the warehouse buckets the same samples with
    date_trunc and that floors too. Rounding here would put a sample in one
    bucket in Python and the previous one in SQL, and the two planes would
    disagree about a number they are both supposed to be computing.
    """
    if cadence_seconds is None:
        return None, "single_sample_no_alignment"
    allowance = cadence_seconds * (1.0 + CADENCE_JITTER_TOLERANCE)
    below = [b for b in ALIGNMENT_BUCKETS_SECONDS if b <= allowance]
    if below:
        return max(below), "inferred_from_cadence"
    # Faster than the smallest bucket. Snapping to 60s merges a few samples per
    # bucket, which costs a little time resolution and buys defeating jitter.
    return ALIGNMENT_BUCKETS_SECONDS[0], "inferred_cadence_below_smallest_bucket"


def snap_timestamp(ts: datetime, seconds: int) -> datetime:
    """
    Snap ``ts`` to the nearest bucket boundary, measured from its own midnight.

    Nearest, not floored, and the difference is not cosmetic. A vendor polling
    every five minutes fires on the clock, so its nominal instants sit exactly
    ON the bucket boundaries: with a floor, every poll that arrives a few
    seconds early falls into the previous bucket while its siblings stay in the
    current one. Measured on the jitter fixture in tests/bess/test_imbalance.py,
    24 nominal instants become 25 ragged buckets holding 3 to 8 racks, and the
    sustained run of a genuinely hot rack is clipped from 50 minutes to 30. With
    nearest, the same samples reconstruct the grid exactly: 24 buckets, 8 racks
    in every one.

    Anchored on midnight rather than the Unix epoch so it never has to guess a
    timezone for a naive datetime, and so it behaves identically for naive and
    aware inputs. Every bucket in ALIGNMENT_BUCKETS_SECONDS divides a day, so
    the grid is stable across day boundaries.
    """
    if seconds <= 0:
        return ts
    midnight = ts.replace(hour=0, minute=0, second=0, microsecond=0)
    offset = (ts - midnight).total_seconds()
    return midnight + timedelta(seconds=math.floor(offset / seconds + 0.5) * seconds)


def _basis_from_kinds(kinds: Set[str]) -> Optional[str]:
    """What a population of these member kinds makes the spread basis."""
    has_device = MEMBER_KIND_DEVICE in kinds
    has_extreme = MEMBER_KIND_EXTREME in kinds
    if has_device and has_extreme:
        return SPREAD_BASIS_MIXED
    if has_device:
        return SPREAD_BASIS_MEMBERS
    if has_extreme:
        return SPREAD_BASIS_EXTREMES
    return None


def _combined_basis(bases: Iterable[Optional[str]]) -> Optional[str]:
    """One basis for a set of racks, or 'mixed' when the fleet disagrees."""
    seen = {b for b in bases if b}
    if not seen:
        return None
    if len(seen) == 1:
        return next(iter(seen))
    return SPREAD_BASIS_MIXED


# --- Analysis --------------------------------------------------------------


def _metric_value(sample: DeviceSample, metric: ImbalanceMetric) -> Optional[float]:
    if metric is ImbalanceMetric.TEMPERATURE:
        return sample.temperature_c
    if metric is ImbalanceMetric.VOLTAGE:
        return sample.voltage_v
    return sample.soc


def _to_display(metric: ImbalanceMetric, value: float) -> float:
    """SoC is carried as a fraction and reported in percentage points."""
    return value * 100.0 if metric is ImbalanceMetric.SOC else value


def analyze_imbalance(
    asset_id: str,
    samples: Sequence[DeviceSample],
    *,
    dwell_minutes: float = DEFAULT_DWELL_MINUTES,
    threshold: float = DEFAULT_OUTLIER_THRESHOLD,
    align_seconds: Optional[int] = None,
) -> ImbalanceReport:
    """
    Measure rack imbalance for one asset over the window covered by ``samples``.

    Callers pass one day of samples at a time; ``day`` on the report is the date
    of the earliest sample. Metrics that cannot be measured at the grain the
    samples provide come back as unavailable, not as zero.

    ``align_seconds`` is the bucket every timestamp is snapped down to before
    grouping. None (the default) infers it from the observed cadence. Pass a
    value only to pin the grid; passing one smaller than the real poll interval
    reintroduces the jitter problem this parameter exists to solve, because each
    bucket then holds one rack and there is no population to be an outlier of.
    """
    ordered = sorted(samples, key=lambda s: s.timestamp)
    if not ordered:
        return ImbalanceReport(
            asset_id=asset_id,
            day=None,
            rack_count=0,
            availability=[
                MetricAvailability(m.value, grain, False, SUB_ASSET_UNAVAILABLE)
                for m in ImbalanceMetric
                for grain in ALL_GRAINS
            ],
            dwell_minutes=dwell_minutes,
            threshold=threshold,
        )

    cadence_seconds = infer_cadence_seconds(ordered)
    if align_seconds is None:
        alignment_seconds, alignment_basis = _alignment_bucket(cadence_seconds)
    elif align_seconds > 0:
        alignment_seconds, alignment_basis = int(align_seconds), "explicit"
    else:
        alignment_seconds, alignment_basis = None, "disabled"

    def _bucket(ts: datetime) -> datetime:
        return snap_timestamp(ts, alignment_seconds) if alignment_seconds else ts

    # A dwell test needs samples inside the dwell window. Snapping can only make
    # the effective cadence coarser, never finer, so the resolvable cadence is
    # the worse of the two. With no second timestamp anywhere there is exactly
    # one sample, which cannot demonstrate persistence at all.
    effective_cadence_s = max(cadence_seconds or 0.0, float(alignment_seconds or 0))
    samples_in_dwell = (
        dwell_minutes * 60.0 / effective_cadence_s if effective_cadence_s > 0 else 1.0
    )
    dwell_resolvable = samples_in_dwell >= MIN_SAMPLES_IN_DWELL

    day = ordered[0].timestamp.date()
    rack_ids = sorted({s.rack_id for s in ordered})
    timestamps = sorted({_bucket(s.timestamp) for s in ordered})

    availability: List[MetricAvailability] = []
    racks_out: List[RackDayImbalance] = []
    inter_rack: Dict[str, float] = {}
    outliers: List[ImbalanceOutlier] = []

    # rack -> bucket -> member key -> [values]. Keyed by member so that snapping
    # two of one member's readings into one bucket collapses to that member's
    # median rather than presenting as two members.
    by_metric: Dict[
        ImbalanceMetric, Dict[str, Dict[datetime, Dict[str, List[float]]]]
    ] = {m: {r: {} for r in rack_ids} for m in ImbalanceMetric}
    members_by_rack: Dict[str, Set[str]] = {r: set() for r in rack_ids}
    kinds_by_rack: Dict[str, Set[str]] = {r: set() for r in rack_ids}
    samples_by_rack: Dict[str, int] = {r: 0 for r in rack_ids}

    for s in ordered:
        samples_by_rack[s.rack_id] += 1
        if s.member_id is not None:
            members_by_rack[s.rack_id].add(s.member_id)
            kinds_by_rack[s.rack_id].add(s.member_kind)
        ts = _bucket(s.timestamp)
        member_key = s.member_id if s.member_id is not None else ""
        for metric in ImbalanceMetric:
            v = _metric_value(s, metric)
            if v is None or not np.isfinite(v):
                continue
            slot = by_metric[metric][s.rack_id].setdefault(ts, {})
            slot.setdefault(member_key, []).append(float(v))

    # rack -> bucket -> one value per member.
    member_values: Dict[ImbalanceMetric, Dict[str, Dict[datetime, List[float]]]] = {
        m: {
            r: {
                ts: [float(np.median(vals)) for vals in per_member.values()]
                for ts, per_member in by_metric[m][r].items()
            }
            for r in rack_ids
        }
        for m in ImbalanceMetric
    }

    # THE spread, per rack per instant, exactly as SPREAD_DEFINITION states it.
    # Absent below two members: one member cannot be a spread, and a zero there
    # would read as a perfectly balanced rack.
    spread_series: Dict[ImbalanceMetric, Dict[str, Dict[datetime, float]]] = {
        m: {
            r: {
                ts: max(vals) - min(vals)
                for ts, vals in member_values[m][r].items()
                if len(vals) >= MIN_MEMBERS_FOR_SPREAD
            }
            for r in rack_ids
        }
        for m in ImbalanceMetric
    }

    # Per rack, per day: the worst instantaneous spread in the window.
    per_rack_spread: Dict[str, Dict[ImbalanceMetric, Optional[float]]] = {}
    for rack in rack_ids:
        spreads: Dict[ImbalanceMetric, Optional[float]] = {}
        for metric in ImbalanceMetric:
            observed = spread_series[metric][rack]
            spreads[metric] = (
                _to_display(metric, max(observed.values())) if observed else None
            )
        per_rack_spread[rack] = spreads

    # A rack's basis is only stated when a spread was actually measured for it.
    rack_basis: Dict[str, Optional[str]] = {
        rack: (
            _basis_from_kinds(kinds_by_rack[rack])
            if any(v is not None for v in per_rack_spread[rack].values())
            else None
        )
        for rack in rack_ids
    }

    for metric in ImbalanceMetric:
        measured_racks = [
            r for r in rack_ids if per_rack_spread[r][metric] is not None
        ]
        availability.append(
            MetricAvailability(
                metric=metric.value,
                grain="within_rack",
                available=bool(measured_racks),
                reason=None if measured_racks else SUB_ASSET_UNAVAILABLE,
                member_basis=_combined_basis(rack_basis[r] for r in measured_racks),
            )
        )

    # Rack aggregate per timestamp: the median of that rack's members, or its
    # single reported value.
    rack_series: Dict[ImbalanceMetric, Dict[str, Dict[datetime, float]]] = {
        m: {
            r: {ts: float(np.median(vals)) for ts, vals in member_values[m][r].items()}
            for r in rack_ids
        }
        for m in ImbalanceMetric
    }

    # SoC divergence from the sibling median, and inter rack spreads.
    soc_divergence: Dict[str, Optional[float]] = {r: None for r in rack_ids}
    for metric in ImbalanceMetric:
        series = rack_series[metric]
        reporting = [r for r in rack_ids if series[r]]
        enough_racks = len(reporting) >= 2
        availability.append(
            MetricAvailability(
                metric=metric.value,
                grain="inter_rack",
                available=enough_racks,
                reason=None if enough_racks else SUB_ASSET_UNAVAILABLE,
            )
        )
        if not enough_racks:
            continue

        worst_spread: Optional[float] = None
        for ts in timestamps:
            present = [series[r][ts] for r in reporting if ts in series[r]]
            if len(present) < 2:
                continue
            spread = max(present) - min(present)
            worst_spread = spread if worst_spread is None else max(worst_spread, spread)

            if metric is ImbalanceMetric.SOC:
                for rack in reporting:
                    if ts not in series[rack]:
                        continue
                    siblings = [
                        series[r][ts] for r in reporting if r != rack and ts in series[r]
                    ]
                    if not siblings:
                        continue
                    div = (series[rack][ts] - float(np.median(siblings))) * 100.0
                    prev = soc_divergence[rack]
                    if prev is None or abs(div) > abs(prev):
                        soc_divergence[rack] = div

        if worst_spread is not None:
            inter_rack[metric.value] = _to_display(metric, worst_spread)

    for rack in rack_ids:
        racks_out.append(
            RackDayImbalance(
                rack_id=rack,
                day=day,
                sample_count=samples_by_rack[rack],
                member_count=len(members_by_rack[rack]),
                temperature_spread_c=per_rack_spread[rack][ImbalanceMetric.TEMPERATURE],
                voltage_spread_v=per_rack_spread[rack][ImbalanceMetric.VOLTAGE],
                soc_divergence_pp=soc_divergence[rack],
                spread_basis=rack_basis[rack],
            )
        )

    # Sustained outlier scoring across racks, over two grains:
    #   'outlier'        each rack's level  against its siblings' levels
    #   'spread_outlier' each rack's spread against its siblings' spreads
    # The second is the one that catches a rack whose cells are drifting apart
    # while its midpoint stays exactly where the fleet's is.
    for grain, source, name_suffix in (
        ("outlier", rack_series, ""),
        ("spread_outlier", spread_series, SPREAD_METRIC_SUFFIX),
    ):
        for metric in ImbalanceMetric:
            series = source[metric]
            reporting = [r for r in rack_ids if series[r]]
            basis = _combined_basis(rack_basis[r] for r in reporting)

            if len(reporting) < MIN_RACKS_FOR_OUTLIER:
                availability.append(
                    MetricAvailability(
                        metric=metric.value,
                        grain=grain,
                        available=False,
                        reason=(
                            SUB_ASSET_UNAVAILABLE if not reporting else TOO_FEW_SIBLINGS
                        ),
                        member_basis=basis if grain == "spread_outlier" else None,
                    )
                )
                continue

            if not dwell_resolvable:
                availability.append(
                    MetricAvailability(
                        metric=metric.value,
                        grain=grain,
                        available=False,
                        reason=DWELL_UNRESOLVABLE,
                        member_basis=basis if grain == "spread_outlier" else None,
                    )
                )
                continue

            availability.append(
                MetricAvailability(
                    metric=metric.value,
                    grain=grain,
                    available=True,
                    member_basis=basis if grain == "spread_outlier" else None,
                )
            )
            outliers.extend(
                _score_metric_outliers(
                    metric=metric,
                    rack_ids=reporting,
                    series=series,
                    timestamps=timestamps,
                    dwell_minutes=dwell_minutes,
                    threshold=threshold,
                    metric_name=f"{metric.value}{name_suffix}",
                )
            )

    return ImbalanceReport(
        asset_id=asset_id,
        day=day,
        rack_count=len(rack_ids),
        racks=racks_out,
        inter_rack_spread=inter_rack,
        outliers=outliers,
        availability=availability,
        dwell_minutes=dwell_minutes,
        threshold=threshold,
        alignment_seconds=alignment_seconds,
        alignment_basis=alignment_basis,
        cadence_seconds=cadence_seconds,
    )


def _score_metric_outliers(
    *,
    metric: ImbalanceMetric,
    rack_ids: Sequence[str],
    series: Dict[str, Dict[datetime, float]],
    timestamps: Sequence[datetime],
    dwell_minutes: float,
    threshold: float,
    metric_name: Optional[str] = None,
) -> List[ImbalanceOutlier]:
    """
    Modified z per timestamp across racks, then a dwell filter per rack.

    ``series`` is whatever per rack quantity is being compared: the rack's level
    for the 'outlier' grain, the rack's within rack spread for 'spread_outlier'.
    The statistic, the flag point and the dwell scan are identical either way,
    which is the point: one detector, two inputs, not two detectors.

    ``timestamps`` must already be on a common grid. Rows are assembled by exact
    key, so unaligned vendor polls would leave one rack per row, and a
    population of one cannot produce a score.
    """
    unit = METRIC_UNITS[metric]
    name = metric_name or metric.value
    n_t = len(timestamps)
    n_r = len(rack_ids)

    z = np.full((n_t, n_r), np.nan, dtype=float)
    med = np.full(n_t, np.nan, dtype=float)
    mad = np.full(n_t, np.nan, dtype=float)
    raw = np.full((n_t, n_r), np.nan, dtype=float)

    for i, ts in enumerate(timestamps):
        row = np.array(
            [series[r].get(ts, np.nan) for r in rack_ids],
            dtype=float,
        )
        raw[i] = row
        z[i] = modified_z_scores(row)
        finite = row[np.isfinite(row)]
        if finite.size >= 2:
            med[i] = float(np.median(finite))
            mad[i] = float(np.median(np.abs(finite - np.median(finite))))

    found: List[ImbalanceOutlier] = []
    for j, rack in enumerate(rack_ids):
        # nan (rack not reporting at that timestamp) compares False against the
        # threshold, so a gap breaks the run rather than extending it.
        magnitude = np.nan_to_num(np.abs(z[:, j]), nan=0.0)
        for start, end, duration, _ in _sustained_periods(
            timestamps, magnitude, threshold, dwell_minutes
        ):
            window = [i for i, ts in enumerate(timestamps) if start <= ts <= end]
            if not window:
                continue
            peak = max(window, key=lambda i: abs(z[i, j]) if np.isfinite(z[i, j]) else 0.0)
            found.append(
                ImbalanceOutlier(
                    rack_id=rack,
                    metric=name,
                    unit=unit,
                    modified_z=float(z[peak, j]),
                    observed_value=_to_display(metric, float(raw[peak, j])),
                    sibling_median=_to_display(metric, float(med[peak])),
                    sibling_mad=_to_display(metric, float(mad[peak])),
                    started_at=start,
                    ended_at=end,
                    duration_minutes=duration,
                    threshold=threshold,
                )
            )
    return found


# --- Safety sub index ------------------------------------------------------

#: Score mapping, stated as policy so the UI can publish it verbatim.
#: 100 at or below half the flag point (a tight population), 60 exactly at the
#: Iglewicz and Hoaglin flag point (which is also the alert floor, so a flagged
#: rack lands on the boundary rather than inside it), 0 at twice the flag point.
IMBALANCE_INDEX_METHOD = (
    "Worst sustained modified z score across racks, over two grains: each "
    "rack's level against its siblings, and each rack's within rack spread "
    "against its siblings. Spread is the instantaneous max minus min across a "
    "rack's members, worst over the window. 100 at or below half the flag "
    "point, 60 at the flag point, 0 at twice the flag point."
)


def imbalance_index(report: ImbalanceReport) -> SafetySubIndex:
    """
    Turn an ImbalanceReport into the imbalance sub index of state of safety.

    Reports the sub index as unavailable, with the connect your BMS wording,
    whenever outlier scoring could not run. It is never scored 100 for lack of
    data: absence of rack telemetry is absence of evidence, not evidence of a
    balanced pack.
    """
    worst_outlier = max(
        report.outliers, key=lambda o: abs(o.modified_z), default=None
    )

    def _worst_spread(values: Iterable[Optional[float]]) -> Optional[float]:
        seen = [v for v in values if v is not None]
        if not seen:
            return None
        # Six decimals is a microvolt and a micro degree, orders of magnitude
        # below any BMS resolution, so this removes floating point noise
        # (0.05999999999999961 V) without touching a measured digit.
        return round(max(seen), 6)

    inputs = {
        "rack_count": report.rack_count,
        "dwell_minutes": report.dwell_minutes,
        "flag_threshold": report.threshold,
        "sustained_outliers": len(report.outliers),
        "inter_rack_spread": dict(report.inter_rack_spread),
        "worst_outlier": worst_outlier.description if worst_outlier else None,
        # The within rack view: how far apart a single rack's own members got.
        # None where no rack could measure it, never 0.
        "worst_within_rack_spread": {
            "voltage": _worst_spread(r.voltage_spread_v for r in report.racks),
            "temperature": _worst_spread(r.temperature_spread_c for r in report.racks),
        },
        # Whether those spreads came from real members or from the two edges a
        # BMS reports. A caption that omits this over states the sample.
        "spread_basis": _combined_basis(r.spread_basis for r in report.racks),
        "racks_reporting_extremes": sum(
            1 for r in report.racks if r.spread_basis == SPREAD_BASIS_EXTREMES
        ),
        "alignment_seconds": report.alignment_seconds,
        "alignment_basis": report.alignment_basis,
    }

    if not report.scoreable:
        # Prefer the level grain's reason: it is the one every existing surface
        # already renders, and 'too few racks' is more actionable than a note
        # about the spread grain.
        reason = next(
            (
                a.reason
                for a in report.availability
                if a.grain == "outlier" and a.reason
            ),
            None,
        ) or next(
            (
                a.reason
                for a in report.availability
                if a.grain in OUTLIER_GRAINS and a.reason
            ),
            SUB_ASSET_UNAVAILABLE,
        )
        return SafetySubIndex(
            name="imbalance",
            score=None,
            available=False,
            reason=reason,
            inputs=inputs,
            method=IMBALANCE_INDEX_METHOD,
        )

    worst = report.worst_modified_z or 0.0
    flag = report.threshold
    half = flag / 2.0
    if worst <= half:
        score = 100.0
    elif worst <= flag:
        score = 100.0 - 40.0 * (worst - half) / (flag - half)
    else:
        score = max(0.0, 60.0 * (1.0 - (worst - flag) / flag))

    inputs["worst_modified_z"] = round(float(worst), 2)
    return SafetySubIndex(
        name="imbalance",
        score=int(round(score)),
        available=True,
        reason=None,
        inputs=inputs,
        method=IMBALANCE_INDEX_METHOD,
    )
