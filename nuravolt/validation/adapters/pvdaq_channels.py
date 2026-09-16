"""PVDAQ metric_id → field_type resolver.

PVDAQ ships per-system metadata JSONs (e.g.
``backenddata/datasets/pvdaq/system_7334_5min/metadata/7333_system_metadata.json``)
that contain 125-5119 channel entries shaped:

    {
      "metric_id": 146722,
      "sensor_name": "SOS-01-001-INV1-CMB-CAB-T-C",
      "common_name": "Temperature enclosure"
    }

The daily-parquet measurement files key on `metric_id`; without resolving
to a canonical field type, we can't extract irradiance, AC power, etc.
This module is the lookup. Once built, `preprocess_pvdaq_system.py`
uses it to convert opaque-metric-id rows into canonical-column tables
that downstream code (rdtools, our soiling validator) can consume.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional


# common_name (from PVDAQ JSON) → our canonical field name
# Aligns with Prisma `DataFieldType` enum where possible, with extras for
# things PVDAQ tracks that we don't model elsewhere (tracker position, etc.)
COMMON_NAME_TO_FIELD: Dict[str, str] = {
    "AC power": "power_ac",
    "AC current": "current_ac",
    "AC voltage": "voltage_ac",
    "DC current": "current_dc",
    "DC voltage": "voltage_dc",
    "DC power": "power_dc",
    "Temperature ambient": "temp_ambient",
    "Temperature module": "temp_module",
    "Temperature inverter": "temp_inverter",
    "Temperature enclosure": "temp_inverter",   # treat enclosure as inverter cabinet
    "Irradiance POA": "irradiance_poa",
    "Irradiance GHI": "irradiance_ghi",
    "Irradiance DNI": "irradiance_dni",
    "Irradiance DHI": "irradiance_ghi",         # DHI maps to GHI bucket (no DHI in our taxonomy)
    "Wind speed": "wind_speed",
    "Wind direction": "wind_direction",
    "Humidity": "humidity",
    "Tracker position": "tracker_position",     # PVDAQ-only field
    "Tracker angle": "tracker_position",
    "Inverter status": "status_code",
    "Energy daily": "energy_daily",
    "Energy total": "energy_total",
    "Frequency": "frequency",
    "Power factor": "power_factor",
}

# Fields we explicitly DON'T map (free-text bucket, vendor-specific)
SKIP_COMMON_NAMES = {"Other", "AC other", "DC other"}


@dataclass
class ChannelEntry:
    metric_id: int
    sensor_name: str
    common_name: str
    field_type: str                    # canonical, from COMMON_NAME_TO_FIELD
    equipment_id: Optional[str]        # extracted from sensor_name when possible
    raw_path: str                      # JSON path for debugging
    is_mappable: bool


@dataclass
class SystemChannelCatalog:
    system_id: int
    public_name: str
    total_entries: int
    mappable_entries: int
    entries: List[ChannelEntry]
    by_metric_id: Dict[int, ChannelEntry]
    by_field_type: Dict[str, List[ChannelEntry]]


def _extract_equipment_id(sensor_name: str) -> Optional[str]:
    """Pull a stable equipment identifier from PVDAQ sensor names.

    PVDAQ uses dash-separated naming like ``SOS-01-001-INV1-CMB-CAB-T-C``.
    The ``INV*`` token (or ``inv_*``, ``str_*``, etc.) is the equipment
    identifier for grouping channels by inverter / string.

    Returns ``None`` for sensors without a recognizable equipment token
    (typically plant-wide measurements like POA irradiance).
    """
    if not sensor_name:
        return None
    parts = sensor_name.replace("_", "-").split("-")
    for p in parts:
        pl = p.lower()
        if (pl.startswith("inv") and len(p) <= 6) or pl.startswith("str") or pl.startswith("mppt"):
            return p
    return None


def _walk_for_metrics(obj, path: str = "") -> List[tuple]:
    """Walk a parsed JSON tree, yield (raw_path, dict) for every dict that
    looks like a metric entry (has both ``metric_id`` and ``common_name``).
    """
    out = []
    if isinstance(obj, dict):
        if "metric_id" in obj and "common_name" in obj:
            out.append((path, obj))
        else:
            for k, v in obj.items():
                out.extend(_walk_for_metrics(v, f"{path}/{k}"))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.extend(_walk_for_metrics(v, f"{path}/[{i}]"))
    return out


def load_system_catalog(metadata_json: Path) -> SystemChannelCatalog:
    """Parse one PVDAQ system metadata JSON into a channel catalog.

    Raises ``FileNotFoundError`` if the file doesn't exist (callers fall back
    to value-range inference for systems without metadata, like system_34).
    """
    if not metadata_json.exists():
        raise FileNotFoundError(
            f"PVDAQ metadata JSON not found: {metadata_json}.\n"
            f"  Systems with metadata: 2107, 7333 (in system_7334_5min/), 9069.\n"
            f"  Systems without: 34, 1430 (need value-range inference)."
        )
    data = json.loads(metadata_json.read_text())
    raw_entries = _walk_for_metrics(data)

    entries: List[ChannelEntry] = []
    by_metric_id: Dict[int, ChannelEntry] = {}
    by_field_type: Dict[str, List[ChannelEntry]] = {}

    for raw_path, e in raw_entries:
        common_name = str(e.get("common_name", "")).strip()
        sensor_name = str(e.get("sensor_name", "")).strip()
        try:
            metric_id = int(e["metric_id"])
        except (TypeError, ValueError):
            continue
        field_type = COMMON_NAME_TO_FIELD.get(common_name, "unmapped")
        is_mappable = field_type != "unmapped" and common_name not in SKIP_COMMON_NAMES
        entry = ChannelEntry(
            metric_id=metric_id,
            sensor_name=sensor_name,
            common_name=common_name,
            field_type=field_type,
            equipment_id=_extract_equipment_id(sensor_name),
            raw_path=raw_path,
            is_mappable=is_mappable,
        )
        entries.append(entry)
        by_metric_id[metric_id] = entry
        by_field_type.setdefault(field_type, []).append(entry)

    system_info = data.get("System", {})
    return SystemChannelCatalog(
        system_id=int(system_info.get("system_id", -1)),
        public_name=str(system_info.get("public_name", "")),
        total_entries=len(entries),
        mappable_entries=sum(1 for e in entries if e.is_mappable),
        entries=entries,
        by_metric_id=by_metric_id,
        by_field_type=by_field_type,
    )


# Convenience: registry of where each system's metadata JSON lives on disk
PVDAQ_ROOT = Path("backenddata/datasets/pvdaq")
SYSTEM_METADATA_PATHS: Dict[int, Path] = {
    2107: PVDAQ_ROOT / "system_2107" / "metadata" / "2107_system_metadata.json",
    7333: PVDAQ_ROOT / "system_7334_5min" / "metadata" / "7333_system_metadata.json",
    9069: PVDAQ_ROOT / "system_9069" / "metadata" / "9069_system_metadata.json",
    # Systems WITHOUT metadata on disk — preprocess script handles separately
    # via value-range inference (less accurate, documented):
    34: None,
    1430: None,
}


def list_systems_with_metadata() -> List[int]:
    """Return system_ids that have a metadata JSON on disk (resolvable)."""
    return sorted(sid for sid, p in SYSTEM_METADATA_PATHS.items() if p is not None and p.exists())


def load_all_catalogs() -> Dict[int, SystemChannelCatalog]:
    """Load every available metadata catalog. Skips systems without metadata."""
    out = {}
    for sid in list_systems_with_metadata():
        out[sid] = load_system_catalog(SYSTEM_METADATA_PATHS[sid])
    return out
