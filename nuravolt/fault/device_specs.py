"""Manufacturer specifications, keyed to the device models a plant actually runs.

WHY THIS EXISTS
---------------
Several detector thresholds were fleet guesses standing in for numbers the
manufacturer publishes. The starkest: inverter overtemperature fired at 65 degrees
C, while the datasheet for the inverter running roughly 340 of our 452 fleet
devices rates it to **60 C ambient** and begins derating at **45 C**. The threshold
sat above the machine's rated envelope, and on real plants it fired up to 329 times
its plausible base rate.

A specification is not a tuning parameter. Taking it from the datasheet moves a
detector from tier C (fitted to our fleet, needs recalibration on a new site) to
tier B (anchored to a published fact about the hardware).

THE CONTRACT: NEVER GUESS
-------------------------
``lookup`` returns ``None`` for a model we have no datasheet for, and every tier B
detector must then decline to run. That is deliberate and it matches
``resolve_device_columns`` and the DC voltage envelope: a detector that cannot run
must say so, because a silent skip and a healthy plant look identical from the
outside, and substituting a fleet default is how the 65 C guess got there.

MODEL NAMING
------------
The plant metadata and the datasheets do not agree on how a model is written. The
metadata says ``"SUN 2000 - 60 KTL"``; the spec file says ``"SUN2000-60KTL-M0"``.
This is the same class of mismatch as ``WR.01.001`` against ``INV 01.001`` in the
device identifiers, and it is resolved the same way: normalise aggressively, then
match.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_DIR = REPO_ROOT / "public" / "data" / "manuals"


@dataclass(frozen=True)
class DeviceSpec:
    """The manufacturer facts a detector may anchor a threshold to."""

    model: str
    manufacturer: str = ""
    source: str = ""

    # Thermal
    derating_start_temp_c: Optional[float] = None
    max_operating_temp_c: Optional[float] = None
    min_operating_temp_c: Optional[float] = None

    # DC input
    max_dc_input_voltage_v: Optional[float] = None
    operating_voltage_min_v: Optional[float] = None
    operating_voltage_max_v: Optional[float] = None
    rated_input_voltage_v: Optional[float] = None
    max_input_current_per_mppt_a: Optional[float] = None
    max_short_circuit_current_per_mppt_a: Optional[float] = None

    # Topology
    mppt_count: Optional[int] = None
    inputs_count: Optional[int] = None
    strings_per_mppt: Optional[int] = None

    # AC
    nominal_power_ac_kw: Optional[float] = None
    max_efficiency_pct: Optional[float] = None
    euro_efficiency_pct: Optional[float] = None

    @property
    def has_thermal(self) -> bool:
        return self.derating_start_temp_c is not None or self.max_operating_temp_c is not None

    @property
    def has_mppt_topology(self) -> bool:
        return bool(self.mppt_count and self.strings_per_mppt)

    def strings_of_mppt(self, mppt_index: int) -> List[int]:
        """1-based string input indices belonging to a 1-based MPPT index.

        With 6 MPPTs of 2 strings, MPPT 1 owns inputs 1 and 2, MPPT 2 owns 3 and 4,
        and so on. Strings sharing an MPPT have their current forced together, so a
        deficit across a pair means something different from a deficit in one string.
        """
        if not self.has_mppt_topology:
            return []
        n = self.strings_per_mppt
        start = (mppt_index - 1) * n + 1
        return list(range(start, start + n))


def _normalise(name: str) -> str:
    """Collapse a model name to something comparable across sources."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _load_all() -> Dict[str, DeviceSpec]:
    out: Dict[str, DeviceSpec] = {}
    if not SPEC_DIR.exists():
        return out
    for path in sorted(SPEC_DIR.glob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except Exception as exc:  # noqa: BLE001
            logger.warning("device_specs: unreadable %s: %s", path, exc)
            continue
        specs = doc.get("specs") or {}
        env = doc.get("environmental") or {}
        op = specs.get("operating_voltage_range_v") or [None, None]
        temp = env.get("operating_temp_c") or [None, None]
        spec = DeviceSpec(
            model=doc.get("model", path.stem),
            manufacturer=doc.get("manufacturer", ""),
            source=str(doc.get("source", "")),
            derating_start_temp_c=env.get("derating_start_temp_c"),
            min_operating_temp_c=temp[0] if len(temp) > 1 else None,
            max_operating_temp_c=temp[1] if len(temp) > 1 else None,
            max_dc_input_voltage_v=specs.get("max_dc_input_voltage_v"),
            operating_voltage_min_v=op[0] if len(op) > 1 else None,
            operating_voltage_max_v=op[1] if len(op) > 1 else None,
            rated_input_voltage_v=specs.get("rated_input_voltage_v"),
            max_input_current_per_mppt_a=specs.get("max_input_current_per_mppt_a"),
            max_short_circuit_current_per_mppt_a=specs.get("max_short_circuit_current_per_mppt_a"),
            mppt_count=specs.get("mppt_count"),
            inputs_count=specs.get("inputs_count"),
            strings_per_mppt=specs.get("strings_per_mppt"),
            nominal_power_ac_kw=specs.get("nominal_power_ac_kw"),
            max_efficiency_pct=specs.get("max_efficiency_pct"),
            euro_efficiency_pct=specs.get("euro_efficiency_pct"),
        )
        out[_normalise(spec.model)] = spec
    return out


_CACHE: Optional[Dict[str, DeviceSpec]] = None


def all_specs() -> Dict[str, DeviceSpec]:
    global _CACHE
    if _CACHE is None:
        _CACHE = _load_all()
    return _CACHE


def lookup(component_type: str) -> Optional[DeviceSpec]:
    """Find the spec for a plant-metadata model string, or None.

    Returns None rather than a default. A detector that cannot find its device's
    specification must decline to run.
    """
    if not component_type:
        return None
    specs = all_specs()
    key = _normalise(component_type)
    if key in specs:
        return specs[key]
    # Datasheets carry variant suffixes the plant metadata omits, e.g. the
    # metadata's "SUN 2000 - 60 KTL" against the file's "SUN2000-60KTL-M0".
    for spec_key, spec in specs.items():
        if spec_key.startswith(key) or key.startswith(spec_key):
            return spec
    logger.info(
        "device_specs: no datasheet for %r (known: %s). Detectors anchored to "
        "manufacturer specifications will decline to run for this device.",
        component_type, sorted(s.model for s in specs.values()),
    )
    return None
