"""
Silver telemetry rows -> imbalance DeviceSamples.

``silver_bess_telemetry`` is long and thin: one row per (device, timestamp,
metric). ``nuravolt.bess.imbalance`` wants it wide and per member: one
``DeviceSample`` per (rack, timestamp, member). That pivot is the whole job of
this module, and it is a pure function of the rows: no S3, no database, no
clock. Which means the interesting decisions in it are unit testable, and they
are exactly the decisions worth testing, because each of them is a way to be
confidently wrong.

THREE REFUSALS
--------------

1. **SoC arrives as a percentage and leaves as a fraction.**
   ``silver_bess_telemetry`` classifies ``bess_soc`` / ``bess_soc_rack`` under
   ``unit_family = 'percent'`` and emits ``value_canonical`` in percent, while
   ``DeviceSample.soc`` is documented as a fraction 0 to 1 and imbalance.py
   multiplies it by 100 for display. Carrying the percentage straight across
   would report a real 3 percentage point divergence between racks as 300
   percentage points: not a rounding error, a factor of one hundred, and one
   that looks like a catastrophic imbalance rather than like a bug. The divisor
   is applied here, exactly once, and recorded as ``soc_scale_applied`` so the
   place it happened is discoverable from the output.

2. **Pack voltage is never cell voltage.**
   ``bess_voltage_pack`` is hundreds of volts of series string; a cell is a few
   volts. Folding it into ``voltage_v`` alongside cell readings would produce a
   "cell to cell spread" of several hundred volts, which is not a large number
   for this metric, it is a nonsense one. It is dropped, and counted in
   ``metrics_ignored`` so a silent drop cannot be mistaken for a feed that never
   sent it.

3. **Extremes are not a census.**
   A rack that reports a single scalar ``bess_temp_cell`` and no children and no
   max/min pair has told us one number. One number is not a spread. That rack
   gets ``member_kind='rack'`` and ``member_id=None``, so imbalance.py reports
   ``temperature_spread_c`` as None for it. Not 0.0: a zero spread reads as a
   perfectly balanced rack, which is the strongest possible claim to make from
   the weakest possible evidence.

A fourth rule, less dangerous but still worth stating: when a rack reports both
its extremes and real per module children for the same quantity, the children
win and the extremes are dropped. An extreme is a summary *of* that population,
so keeping both would put the population's own max and min into the population
twice, tightening the MAD around values that are duplicates.
"""

from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from nuravolt.bess.imbalance import (
    MEMBER_KIND_DEVICE,
    MEMBER_KIND_EXTREME,
    MEMBER_KIND_RACK,
    SPREAD_BASIS_EXTREMES,
    SPREAD_BASIS_MEMBERS,
    SPREAD_BASIS_MIXED,
    DeviceSample,
)

#: SoC in silver is a percentage (see silver_bess_telemetry's unit_family), and
#: DeviceSample.soc is a fraction. One divisor, one place.
SOC_PERCENT_TO_FRACTION = 100.0

#: Above this, a SoC series is unambiguously a percentage. At or below it for
#: every sample in the window, the feed may already be a fraction and the
#: divisor above would be a second application of it. Reported as a flag, never
#: acted on: silently switching scale on a heuristic is how a 100x error becomes
#: undebuggable.
SOC_FRACTION_SUSPICION_MAX = 1.5

#: Rack grain extremes: canonical metric -> (member id, DeviceSample field).
#: Two members, so max minus min over them is the reported delta exactly.
EXTREME_MEMBERS: Dict[str, Tuple[str, str]] = {
    "bess_temp_cell_max": ("#Tmax", "temperature_c"),
    "bess_temp_cell_min": ("#Tmin", "temperature_c"),
    "bess_voltage_cell_max": ("#Vmax", "voltage_v"),
    "bess_voltage_cell_min": ("#Vmin", "voltage_v"),
}

#: Per device metrics, at module or cell grain: real members of the rack.
CHILD_METRICS: Dict[str, str] = {
    "bess_temp_cell": "temperature_c",
    "bess_voltage_cell": "voltage_v",
    "bess_soc": "soc",
}

#: The same metrics reported by the rack itself: one scalar, not a population.
RACK_SCALAR_METRICS: Dict[str, str] = {
    "bess_soc_rack": "soc",
    "bess_soc": "soc",
    "bess_temp_cell": "temperature_c",
    "bess_voltage_cell": "voltage_v",
}

#: Metrics deliberately excluded from imbalance, with the reason. Counted rather
#: than dropped quietly.
REFUSED_METRICS: Dict[str, str] = {
    "bess_voltage_pack": (
        "pack voltage is a series string, not a cell; mixing it into cell "
        "voltage would fabricate a spread of hundreds of volts"
    ),
}

#: Grains whose rows are children of a rack rather than the rack itself.
CHILD_GRAINS = ("module", "cell")

_SAMPLE_FIELDS = ("temperature_c", "voltage_v", "soc")


def _get(row: Any, key: str) -> Any:
    """Read a column from a mapping row or an attribute style row."""
    if isinstance(row, Mapping):
        return row.get(key)
    return getattr(row, key, None)


def _as_datetime(value: Any) -> Optional[datetime]:
    """Coerce a silver ts to datetime, or None when it is not a timestamp."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None
    to_pydatetime = getattr(value, "to_pydatetime", None)
    if callable(to_pydatetime):
        try:
            result = to_pydatetime()
        except Exception:  # pragma: no cover - defensive on exotic row types
            return None
        return result if isinstance(result, datetime) else None
    if isinstance(value, date):
        # A calendar day is not an instant, and pretending it is midnight would
        # collapse a day of samples onto one timestamp.
        return None
    return None


def _as_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result != result or result in (float("inf"), float("-inf")):
        return None
    return result


def _basis(kinds: Set[str]) -> Optional[str]:
    """
    What imbalance.py will call this rack's spread basis.

    ``rack`` is reported for a rack that carries only scalars: it produces no
    spread at all, which is a different statement from a spread of zero and
    from a spread measured off two edges.
    """
    if not kinds:
        return None
    has_child = MEMBER_KIND_DEVICE in kinds
    has_extreme = MEMBER_KIND_EXTREME in kinds
    if has_child and has_extreme:
        return SPREAD_BASIS_MIXED
    if has_child:
        return SPREAD_BASIS_MEMBERS
    if has_extreme:
        return SPREAD_BASIS_EXTREMES
    return MEMBER_KIND_RACK


def rack_samples_from_silver(
    rows: Iterable[Any],
) -> Tuple[List[DeviceSample], Dict[str, Any]]:
    """
    Pivot silver telemetry rows into imbalance DeviceSamples.

    Each row needs ``rack_device_id``, ``canonical_device_id``, ``device_grain``,
    ``ts``, ``metric`` and ``value_canonical``. Rows may be mappings or objects
    with those attributes.

    Returns the samples and a diagnostics dict:

    ``metrics_seen``       canonical metric -> rows accepted
    ``metrics_ignored``    canonical metric -> rows refused or unrecognised
    ``racks``              number of distinct racks in the output
    ``basis_per_rack``     rack device id -> 'members' | 'extremes' | 'mixed' | 'rack'
    ``soc_scale_applied``  the divisor applied to SoC, or None when no SoC rows
    ``rows_in``            rows offered
    ``samples_out``        DeviceSamples returned
    ``dropped``            reason -> rows dropped that carried no usable metric
    ``soc_suspect_already_fraction``
                           every SoC value was at or below
                           SOC_FRACTION_SUSPICION_MAX, so the feed may already
                           be a fraction and the divisor may be a second
                           application. Flagged, not corrected.
    """
    metrics_seen: Dict[str, int] = {}
    metrics_ignored: Dict[str, int] = {}
    dropped: Dict[str, int] = {}
    rows_in = 0

    def _count(bucket: Dict[str, int], key: str) -> None:
        bucket[key] = bucket.get(key, 0) + 1

    # (rack, ts, member_id, kind) -> field -> (value, metric), before the mixed
    # rack rule. The metric is carried so a field dropped in the second pass can
    # be moved from metrics_seen to metrics_ignored rather than counted as
    # accepted.
    pending: Dict[
        Tuple[str, datetime, Optional[str], str], Dict[str, Tuple[float, str]]
    ] = {}
    order: List[Tuple[str, datetime, Optional[str], str]] = []
    child_fields_by_rack: Dict[str, Set[str]] = {}
    soc_values: List[float] = []

    for row in rows:
        rows_in += 1
        rack_id = _get(row, "rack_device_id")
        metric = _get(row, "metric")
        metric_key = str(metric) if metric is not None else "(null)"

        if not rack_id:
            # Asset and unit grain rows have no rack to belong to. Attributing
            # them to one would invent a rack.
            _count(dropped, "no_rack_device_id")
            continue

        ts = _as_datetime(_get(row, "ts"))
        if ts is None:
            _count(dropped, "bad_timestamp")
            continue

        value = _as_float(_get(row, "value_canonical"))
        if value is None:
            # Silver leaves value_canonical null when it could not convert the
            # reported unit. An unconvertible value is not a zero.
            _count(dropped, "no_canonical_value")
            continue

        if metric in REFUSED_METRICS:
            _count(metrics_ignored, metric_key)
            continue

        grain = _get(row, "device_grain")
        rack_id = str(rack_id)

        if grain in CHILD_GRAINS:
            field = CHILD_METRICS.get(metric)
            if field is None:
                _count(metrics_ignored, metric_key)
                continue
            member_id = _get(row, "canonical_device_id")
            if not member_id:
                # A child with no id cannot be told apart from its siblings, so
                # it cannot be a member of a population.
                _count(dropped, "child_without_device_id")
                continue
            member_id = str(member_id)
            kind = MEMBER_KIND_DEVICE
            child_fields_by_rack.setdefault(rack_id, set()).add(field)
        elif metric in EXTREME_MEMBERS:
            member_id, field = EXTREME_MEMBERS[metric]
            kind = MEMBER_KIND_EXTREME
        elif metric in RACK_SCALAR_METRICS:
            member_id, field = None, RACK_SCALAR_METRICS[metric]
            kind = MEMBER_KIND_RACK
        else:
            _count(metrics_ignored, metric_key)
            continue

        if field == "soc":
            soc_values.append(value)
            value = value / SOC_PERCENT_TO_FRACTION

        key = (rack_id, ts, member_id, kind)
        slot = pending.get(key)
        if slot is None:
            slot = {}
            pending[key] = slot
            order.append(key)
        if field in slot:
            # The same member reported the same quantity twice at one instant.
            # Keeping the first is arbitrary but stable; the count says it
            # happened rather than letting a duplicate feed look clean.
            _count(dropped, "duplicate_metric_for_member")
            _count(metrics_ignored, metric_key)
            continue
        slot[field] = (value, metric_key)

    samples: List[DeviceSample] = []
    kinds_by_rack: Dict[str, Set[str]] = {}
    superseded = 0

    for key in order:
        rack_id, ts, member_id, kind = key
        fields = pending[key]
        if kind == MEMBER_KIND_EXTREME:
            children = child_fields_by_rack.get(rack_id, set())
            kept = {}
            for f, (value, metric_key) in fields.items():
                if f in children:
                    # Real children cover this quantity, so the edges are a
                    # summary of the population rather than an addition to it.
                    superseded += 1
                    _count(metrics_ignored, metric_key)
                else:
                    kept[f] = (value, metric_key)
            fields = kept
            if not fields:
                continue

        for _, metric_key in fields.values():
            _count(metrics_seen, metric_key)

        samples.append(
            DeviceSample(
                timestamp=ts,
                rack_id=rack_id,
                member_id=member_id,
                member_kind=kind,
                **{
                    f: (fields[f][0] if f in fields else None)
                    for f in _SAMPLE_FIELDS
                },
            )
        )
        kinds_by_rack.setdefault(rack_id, set()).add(kind)

    if superseded:
        dropped["extremes_superseded_by_children"] = superseded

    diagnostics: Dict[str, Any] = {
        "rows_in": rows_in,
        "samples_out": len(samples),
        "metrics_seen": metrics_seen,
        "metrics_ignored": metrics_ignored,
        "racks": len(kinds_by_rack),
        "basis_per_rack": {r: _basis(k) for r, k in sorted(kinds_by_rack.items())},
        "soc_scale_applied": SOC_PERCENT_TO_FRACTION if soc_values else None,
        "soc_suspect_already_fraction": bool(soc_values)
        and max(soc_values) <= SOC_FRACTION_SUSPICION_MAX,
        "dropped": dropped,
    }
    return samples, diagnostics
