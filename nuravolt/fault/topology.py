"""Plant electrical topology, parsed from the SCADA component metadata.

Peer-relative fault detection needs to know which devices are comparable. Two
inverters on the same bus, of the same model and the same nameplate, seeing the
same weather at the same instant, are directly comparable: any difference
between them is the fault. Two inverters of different sizes on different buses
are not, and scoring them against each other manufactures alerts.

The component metadata that answers this already ships with every plant export
(``bronze/scada/<plant>/<id>_meta.csv``, semicolon delimited). It carries, per
device: ``Bus``, ``componentType`` (the inverter model), ``Installed P_DC``,
``Nominal P_AC``, physical ``Location`` and ``Serial``.

REAL SCHEMA QUIRKS THIS MUST SURVIVE
------------------------------------
All four were observed in the shipped fleet metadata, not imagined:

1. ``Bus`` values of the literal string ``nA``. At Gamma this is 9 of 45
   inverters, and those 9 are exactly the 238 kWp devices, so the sentinel is
   correlated with device type rather than random.
2. **A missing ``Bus`` column entirely.** Epsilon's metadata uses a different
   schema (``maStRNo``, ``project``, ``registered``). Bus grouping must degrade
   to plant grouping rather than raise.
3. A UTF-8 BOM on the header of ``_reference/all_plants_meta.csv``, which makes
   the first column name ``\\ufeffplantName`` unless handled.
4. Blank ``Installed P_DC``. Devices without a nameplate cannot be normalised
   and must be excluded from peer groups rather than defaulted.

DEVICE HETEROGENEITY IS LARGER THAN PLANT HETEROGENEITY
-------------------------------------------------------
Measured across the fleet: Gamma runs three device sizes in one plant
(238.08 kWp x9, 84.48 x20, 77.44 x16); Epsilon's centrals are 1,036 to 1,083 kWp
against Eta's 78.65 kWp strings inverters. That is a 14x device-scale
range *within* a fleet whose plant sizes span only 5x. Peer groups therefore key
on ``(bus, model, kwp)`` and never on bus alone.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

logger = logging.getLogger(__name__)

#: Values in the ``Bus`` column that mean "not recorded", not a bus named that.
BUS_SENTINELS = {"", "na", "n/a", "nan", "none", "null", "-", "?"}

#: The metadata is semicolon delimited, as exported.
META_DELIMITER = ";"

#: Nameplates within this relative tolerance of each other are treated as one
#: class. Exact matching fragments a fleet badly: Epsilon's 36 central inverters
#: carry 18 distinct nameplates between 1,036 and 1,140 kWp, which is one class
#: of machine recorded to the nearest tenth, not 18 incomparable populations.
#: A 25% band keeps those together while still separating Gamma's 238 kWp
#: devices from its 77 and 84 kWp ones, which really are different machines.
#: Residual size difference inside a band is removed by per-unit normalisation.
NAMEPLATE_CLASS_TOLERANCE = 0.25


@dataclass(frozen=True)
class DeviceMeta:
    """One physical device and the attributes that decide who its peers are."""

    device_id: str
    component_type: str = ""          # inverter model, e.g. "SUN 2000 - 60 KTL"
    bus: Optional[str] = None         # None when unrecorded; never the string "nA"
    kwp_dc: Optional[float] = None    # Installed P_DC
    kw_ac: Optional[float] = None     # Nominal P_AC
    location: str = ""                # physical position, e.g. "H.044 E"
    serial: str = ""

    #: Assigned by PlantTopology once every device is known, because nameplate
    #: classing is relative to the rest of the fleet (see NAMEPLATE_CLASS_TOLERANCE).
    nameplate_class: Optional[int] = None

    def peer_key(self, include_bus: bool = True) -> tuple:
        """The grouping key. Devices sharing this key are directly comparable."""
        return (
            self.bus if include_bus else None,
            self.component_type.strip().lower(),
            self.nameplate_class,
        )

    @property
    def is_groupable(self) -> bool:
        """A device with no nameplate cannot be normalised, so it cannot be scored."""
        return self.kwp_dc is not None and self.kwp_dc > 0


@dataclass(frozen=True)
class ScoringGroup:
    """One peer comparison: who sets the baseline, and who may be alerted.

    ``population`` and ``scored`` differ when a device has too few same-bus
    peers and has to borrow the plant-wide class for its baseline. Keeping them
    separate is what stops a device being scored twice.
    """

    key: tuple
    population: List[str]
    scored: List[str]
    level: str

    def __len__(self) -> int:
        return len(self.population)


@dataclass
class PlantTopology:
    """Every device on one plant, plus the groupings peer statistics need."""

    plant_id: str
    devices: Dict[str, DeviceMeta] = field(default_factory=dict)
    #: True when the source metadata had no Bus column at all (see quirk 2).
    has_bus_column: bool = False

    def __len__(self) -> int:
        return len(self.devices)

    @property
    def inverters(self) -> List[DeviceMeta]:
        return [d for d in self.devices.values() if "inverter" in d.component_type.lower()
                or d.kwp_dc is not None]

    def buses(self) -> Dict[str, List[str]]:
        """bus id -> device ids. Devices with an unrecorded bus are omitted."""
        out: Dict[str, List[str]] = {}
        for d in self.devices.values():
            if d.bus is None:
                continue
            out.setdefault(d.bus, []).append(d.device_id)
        return out

    def peer_groups(self, level: str = "inverter_within_bus") -> Dict[tuple, List[str]]:
        """Group device ids by comparability at the requested level.

        ``inverter_within_bus`` keys on (bus, model, kwp) and is the tightest
        grouping. ``inverter_within_plant`` drops the bus, which is the correct
        fallback when the metadata has no bus column, or when a bus holds too
        few devices to compute a dispersion from.
        """
        if level not in ("inverter_within_bus", "inverter_within_plant"):
            raise ValueError(f"unknown peer level {level!r}")

        out: Dict[tuple, List[str]] = {}
        for d in self.devices.values():
            if not d.is_groupable:
                continue
            key = d.peer_key(include_bus=(level == "inverter_within_bus"))
            out.setdefault(key, []).append(d.device_id)
        return out

    def usable_peer_groups(self, level: str = "inverter_within_bus",
                           min_members: int = 4) -> Dict[tuple, "ScoringGroup"]:
        """Assign every groupable device to exactly one scoring group.

        Two populations matter and they are not the same:

        - ``population`` is who the median and MAD are computed from. Bigger is
          better, because a robust centre wants members.
        - ``scored`` is who may raise an alert from this group. Each device
          appears in exactly one group's ``scored`` set across the whole return
          value, so a device can never raise the same fault twice.

        A device is scored against its bus peers when that bus holds at least
        ``min_members`` comparable devices, because same-bus devices share
        upstream equipment and physical position. Otherwise it is scored against
        its class across the whole plant, which is a weaker but still valid
        comparison. Below ``min_members`` at both levels the device is not
        scored at all, and that is logged rather than papered over.
        """
        if level not in ("inverter_within_bus", "inverter_within_plant"):
            raise ValueError(f"unknown peer level {level!r}")

        tight = self.peer_groups(level)
        out: Dict[tuple, ScoringGroup] = {}
        placed: set = set()

        for key, members in tight.items():
            if len(members) >= min_members:
                out[key] = ScoringGroup(key=key, population=list(members),
                                        scored=list(members), level=level)
                placed.update(members)

        if level == "inverter_within_bus":
            orphans = [d for d in self.devices.values()
                       if d.is_groupable and d.device_id not in placed]
            if orphans:
                wide = self.peer_groups("inverter_within_plant")
                by_key: Dict[tuple, List[str]] = {}
                for d in orphans:
                    by_key.setdefault(d.peer_key(include_bus=False), []).append(d.device_id)
                for key, orphan_ids in by_key.items():
                    population = wide.get(key, [])
                    if len(population) >= min_members:
                        # Score the orphans against the full plant-wide class,
                        # but only the orphans are scored here: their bus peers
                        # already have their own group.
                        out[("plant",) + key[1:]] = ScoringGroup(
                            key=("plant",) + key[1:], population=list(population),
                            scored=list(orphan_ids), level="inverter_within_plant")
                    else:
                        logger.info(
                            "topology %s: %d device(s) have no peer group at any "
                            "level (key=%s, population=%d); peer detectors will "
                            "skip them", self.plant_id, len(orphan_ids), key,
                            len(population),
                        )
        return out


def _assign_nameplate_classes(topo: "PlantTopology") -> None:
    """Cluster device nameplates into classes by relative distance.

    Greedy single pass over the sorted nameplates: a device joins the current
    class while it stays within ``NAMEPLATE_CLASS_TOLERANCE`` of that class's
    smallest member, otherwise it opens a new class. This is deliberately simple
    and order-stable, so the same fleet always yields the same classes.
    """
    sized = sorted(
        (d for d in topo.devices.values() if d.kwp_dc),
        key=lambda d: d.kwp_dc,
    )
    if not sized:
        return

    class_idx = 0
    anchor = sized[0].kwp_dc
    for device in sized:
        if device.kwp_dc > anchor * (1.0 + NAMEPLATE_CLASS_TOLERANCE):
            class_idx += 1
            anchor = device.kwp_dc
        topo.devices[device.device_id] = replace(device, nameplate_class=class_idx)


def _clean(value: Optional[str]) -> str:
    return (value or "").strip()


def _parse_float(value: Optional[str]) -> Optional[float]:
    text = _clean(value).replace(",", ".")
    if not text or text.lower() in BUS_SENTINELS:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _parse_bus(value: Optional[str]) -> Optional[str]:
    """Return a real bus id, or None for the ``nA`` sentinel (quirk 1)."""
    text = _clean(value)
    return None if text.lower() in BUS_SENTINELS else text


def parse_component_meta(text: str, plant_id: str = "") -> PlantTopology:
    """Parse one plant's component metadata CSV into a topology.

    Accepts the raw text so the caller decides where it came from: local disk,
    an S3 stream, or a test fixture.
    """
    # Quirk 3: strip a UTF-8 BOM before the header is read.
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")), delimiter=META_DELIMITER)
    fieldnames = [f.lstrip("﻿") for f in (reader.fieldnames or [])]
    reader.fieldnames = fieldnames

    # Quirk 2: the Bus column may simply not exist.
    has_bus = "Bus" in fieldnames
    if not has_bus:
        logger.info(
            "topology %s: metadata has no 'Bus' column (columns: %s); "
            "bus-level grouping will degrade to plant level",
            plant_id, fieldnames[:6],
        )

    topo = PlantTopology(plant_id=plant_id, has_bus_column=has_bus)
    for row in reader:
        device_id = _clean(row.get("componentName")) or _clean(row.get("componentLabel"))
        if not device_id:
            continue
        topo.devices[device_id] = DeviceMeta(
            device_id=device_id,
            component_type=_clean(row.get("componentType")),
            bus=_parse_bus(row.get("Bus")) if has_bus else None,
            kwp_dc=_parse_float(row.get("Installed P_DC")),   # quirk 4: may be blank
            kw_ac=_parse_float(row.get("Nominal P_AC")),
            location=_clean(row.get("Location")),
            serial=_clean(row.get("Serial")),
        )
    _assign_nameplate_classes(topo)
    return topo


def load_component_meta(path: Path, plant_id: str = "") -> PlantTopology:
    """Parse a plant's component metadata from a local file."""
    return parse_component_meta(
        Path(path).read_text(encoding="utf-8-sig", errors="replace"),
        plant_id or Path(path).parent.name,
    )


# ---------------------------------------------------------------------------
# Matching telemetry columns to metadata device ids
# ---------------------------------------------------------------------------
#
# The component metadata and the SCADA column headers do not agree on device
# naming, and the disagreement is not cosmetic. Measured across the fleet:
#
#     plant         column token        metadata id            naive match
#     alpha      'INV 01.001'        'INV 01.001'           yes
#     delta      'INV 01.001'        'INV 01.001'           yes
#     gamma      'INV 03.045'        'INV 01.001'           yes
#     ribera     'INV 01.032'        'WR.01.032'            NO
#     eta      'INV 01.001'        'WR.01.001'            NO
#     zeta   'INV 01.001'        'INV01.001'            NO
#     epsilon        'INV 01.01'         'inverter001@IPC01'    NO
#
# Four of seven plants fail a naive string match. "WR" is Wechselrichter, the
# German for inverter, so the same fleet carries two languages. Without a
# resolver, peer-relative detection silently covers three plants out of seven
# and reports a clean zero on the rest -- which looks like "no faults found".
#
# The stable content in every one of these is the *sequence of digit groups*:
# 'INV 01.001', 'WR.01.001', 'INV01.001' and 'inverter001@IPC01' all reduce to
# (1, 1). That is what we match on, with an exact-string match preferred when
# one exists, and ambiguity treated as no match rather than a guess.

_DIGITS = re.compile(r"\d+")


def device_number_key(name: str) -> tuple:
    """Reduce a device name to its sequence of numbers, ignoring vendor wording."""
    return tuple(int(g) for g in _DIGITS.findall(name or ""))


def resolve_device_columns(
    columns: Iterable[str],
    topology: "PlantTopology",
    *,
    signal_match: str,
    require_coverage: float = 0.5,
) -> Dict[str, str]:
    """Map metadata device ids to telemetry column names.

    Args:
        columns: every column in the telemetry frame.
        signal_match: substring identifying the signal, e.g.
            ``"Inverter Power Normalized"`` or ``"/ Temperature"``.
        require_coverage: raise if fewer than this fraction of groupable devices
            resolve. A silent zero here is indistinguishable from a healthy
            plant, so it must be loud.

    Returns:
        device_id -> column name, for devices that resolved unambiguously.
    """
    candidates = [c for c in columns if signal_match in c]
    if not candidates:
        raise LookupError(
            f"no telemetry column contains {signal_match!r}; "
            f"cannot resolve devices for plant {topology.plant_id!r}"
        )

    by_exact: Dict[str, str] = {}
    by_number: Dict[tuple, List[str]] = {}
    for col in candidates:
        # The device token sits between the plant prefix and the signal name.
        token = col.split(":", 1)[-1].split("/", 1)[0].strip() if ":" in col else col
        by_exact[token] = col
        by_number.setdefault(device_number_key(token), []).append(col)

    resolved: Dict[str, str] = {}
    ambiguous: List[str] = []
    for device_id, meta in topology.devices.items():
        if not meta.is_groupable:
            continue
        if device_id in by_exact:
            resolved[device_id] = by_exact[device_id]
            continue
        hits = by_number.get(device_number_key(device_id), [])
        if len(hits) == 1:
            resolved[device_id] = hits[0]
        elif len(hits) > 1:
            ambiguous.append(device_id)

    groupable = sum(1 for d in topology.devices.values() if d.is_groupable)
    coverage = len(resolved) / groupable if groupable else 0.0
    if coverage < require_coverage:
        raise LookupError(
            f"plant {topology.plant_id!r}: resolved only {len(resolved)}/{groupable} "
            f"devices ({coverage:.0%}) for signal {signal_match!r}. Metadata ids look "
            f"like {list(topology.devices)[:3]}, column tokens like "
            f"{list(by_exact)[:3]}. Refusing to run a detector that would report a "
            f"clean result from near-zero coverage."
        )
    if ambiguous:
        logger.warning("topology %s: %d device(s) matched multiple columns and were "
                       "skipped: %s", topology.plant_id, len(ambiguous), ambiguous[:5])
    return resolved
