"""LLM-driven per-plant threshold tuner for rule-based fault detection.

Pattern mirrors ``nuravolt/fault/ai_classifier.py`` — boto3 Bedrock
Converse API + closed-output validation + graceful fallback + disk
cache.

Why this exists
---------------
``nuravolt/fault/config.py`` ships sensible *fleet-average* defaults
(max_inverter_temp=65°C, string_cv_warning=0.10, etc). For any single
client plant, the true thresholds depend on:

  - **OEM equipment**: a Huawei SUN2000 normal cabinet temperature runs
    8-12°C hotter than an SMA Sunny Highpower under identical conditions.
  - **Climate**: a Mediterranean plant runs 5°C warmer in summer than a
    German plant. The same 65°C warning fires too often in Spain.
  - **Mounting**: rooftop arrays without rear-of-module airflow run
    10°C hotter than ground-mount trackers.
  - **Plant scale**: 200 MW utility plants tolerate slightly noisier
    string-CV than 5 kW residential before flagging.

This tuner reads plant metadata + the default ``FaultDetectionConfig``
and asks Bedrock to suggest per-plant override values for the most
sensitive thresholds. Each suggestion is validated against physics
bounds before being stored.

The output is a `PlantConfigOverrides` dict that the runtime config
loader merges on top of the defaults. It is purely additive — the
default config is the floor; tuner overrides are layered on at plant
provisioning time.

Cost: one Bedrock call per plant at onboarding. ~€0.0005 amortized
across the plant's lifetime. Negligible.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "backenddata" / "cache" / "threshold_tuner"
DEFAULT_CACHE_TTL_HOURS = 24 * 30  # tuner output stable for a month

DEFAULT_MODEL_ID = os.environ.get(
    "BEDROCK_THRESHOLD_TUNER_MODEL_ID",
    os.environ.get("BEDROCK_FAULT_MODEL_ID", "qwen.qwen3-next-80b-a3b"),
)
DEFAULT_REGION = os.environ.get("AWS_REGION", "eu-west-1")


# ──────────────────────────────────────────────────────────────────────────
# Schema — what the tuner can override (closed set)
# ──────────────────────────────────────────────────────────────────────────

# Each entry: (config.section, field_name, default_value, physics_min, physics_max,
#              "short description for the LLM", "unit")
# Bedrock's output is validated against (physics_min, physics_max) before being
# accepted. Out-of-bounds suggestions are silently rejected (fall back to default).
TUNABLE_THRESHOLDS: List[Tuple[str, str, float, float, float, str, str]] = [
    # ── Inverter ─────────────────────────────────────────────────────────
    ("inverter", "max_inverter_temp", 65.0, 50.0, 90.0,
     "Cabinet/IGBT temperature warning threshold. Higher for hot-climate plants + Huawei OEM.", "°C"),
    ("inverter", "max_module_temp", 85.0, 65.0, 95.0,
     "Module backsheet temperature warning. Higher for rooftop / desert plants.", "°C"),
    ("inverter", "clipping_power_ratio", 1.05, 1.00, 1.30,
     "DC/AC ratio above which clipping is flagged. Higher for plants designed with high DC oversizing.", "ratio"),
    # ── String ───────────────────────────────────────────────────────────
    ("string", "min_active_current", 0.5, 0.1, 2.0,
     "Minimum string current to consider it 'active'. Smaller for residential, larger for utility.", "A"),
    ("string", "short_circuit_voltage_ratio", 0.7, 0.5, 0.95,
     "Voltage ratio below which short circuit suspected. Tighter (lower) for high-quality equipment.", "ratio"),
    # ── MPPT ─────────────────────────────────────────────────────────────
    ("mppt", "imbalance_cv_warning", 0.08, 0.03, 0.20,
     "String current CV above which imbalance warning fires. Higher for many-string utility plants.", "fraction"),
    ("mppt", "imbalance_cv_critical", 0.15, 0.08, 0.30,
     "String CV above which critical imbalance alert. Should be > imbalance_cv_warning.", "fraction"),
    # ── Soiling ──────────────────────────────────────────────────────────
    ("soiling", "pr_soiling_threshold", 0.95, 0.80, 0.99,
     "PR threshold below which soiling suspected. Lower for arid climates with high baseline soiling.", "fraction"),
    # ── Sensor health ────────────────────────────────────────────────────
    ("sensor_health", "frozen_std_threshold", 0.01, 0.001, 0.10,
     "Standard deviation floor for frozen-sensor detection.", "fraction"),
    ("sensor_health", "irradiance_drift_threshold", 0.05, 0.01, 0.20,
     "Fraction deviation from clearsky model that flags irradiance sensor drift.", "fraction"),
    # ── Efficiency (decline rate over time) ──────────────────────────────
    ("efficiency", "efficiency_decline_rate", 0.005, 0.001, 0.05,
     "Weekly efficiency decline rate above which degradation suspected. Lower for new plants.", "fraction/week"),
    # ── Thermal twin (field names match nuravolt/fault/config.py) ────────
    ("thermal_twin", "warning_residual", 5.0, 3.0, 20.0,
     "Inverter temperature residual (actual - twin prediction) warning threshold.", "°C"),
    ("thermal_twin", "critical_residual", 10.0, 5.0, 30.0,
     "Inverter temperature residual critical threshold. Must be > warning.", "°C"),
]


@dataclass
class PlantMetadataInput:
    """Inputs the tuner needs to suggest per-plant thresholds.

    Every field optional except plant_id — but the more we provide, the
    more targeted the LLM's recommendations.
    """
    plant_id: str
    asset_type: str = "PV"                  # "PV", "BESS", "WIND", "HYBRID"
    capacity_mw: Optional[float] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    country: Optional[str] = None
    climate_zone: Optional[str] = None      # from climate_regions.ClimateZone
    inverter_manufacturer: Optional[str] = None  # "Huawei", "SMA", "Sungrow", etc
    inverter_model: Optional[str] = None
    module_manufacturer: Optional[str] = None
    mounting_type: Optional[str] = None     # "tracker", "fixed-ground", "rooftop", "carport"
    n_strings: Optional[int] = None
    n_inverters: Optional[int] = None
    rated_ac_voltage: Optional[float] = None
    commissioning_year: Optional[int] = None
    additional_context: Optional[str] = None  # free-text notes for unusual setups


@dataclass
class ThresholdOverride:
    section: str
    field: str
    value: float
    default: float
    physics_bounds: Tuple[float, float]
    unit: str
    rationale: str
    confidence: float


@dataclass
class TunerResult:
    plant_id: str
    overrides: List[ThresholdOverride] = field(default_factory=list)
    overrides_dict: Dict[str, Dict[str, float]] = field(default_factory=dict)  # section -> field -> value
    rejected_count: int = 0     # LLM suggestions that failed physics bounds
    invocations: int = 0
    cache_hit: bool = False
    model_id: str = ""
    generated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "plant_id": self.plant_id,
            "overrides": [asdict(o) for o in self.overrides],
            "overrides_dict": self.overrides_dict,
            "rejected_count": self.rejected_count,
            "invocations": self.invocations,
            "cache_hit": self.cache_hit,
            "model_id": self.model_id,
            "generated_at": self.generated_at,
        }


# ──────────────────────────────────────────────────────────────────────────
# System prompt (closed taxonomy + JSON contract)
# ──────────────────────────────────────────────────────────────────────────

def _build_system_prompt() -> str:
    threshold_rows = []
    for section, fld, default, lo, hi, desc, unit in TUNABLE_THRESHOLDS:
        threshold_rows.append(
            f'  - "{section}.{fld}": default={default} {unit}, '
            f'physics-bounded [{lo}, {hi}]. {desc}'
        )

    return (
        "You are a solar PV / BESS reliability engineer tuning fault-detection "
        "thresholds for a specific plant. You have decades of experience with "
        "Huawei / SMA / Sungrow / Fronius / Tesla / Sungrow / Power Electronics "
        "equipment across Mediterranean, MENA, Indian, US-SW, Sahel, and "
        "continental European climates.\n\n"
        "You will receive plant metadata. Output JSON with per-threshold "
        "overrides — only for thresholds where your judgement says the fleet-"
        "average default is wrong for THIS plant. Skip thresholds you don't "
        "have strong opinions on (omitting them = keep the default).\n\n"
        "Closed schema of tunable thresholds (use these EXACT section.field keys):\n"
        + "\n".join(threshold_rows) + "\n\n"
        "Output strict JSON (no markdown, no preamble):\n"
        '{\n'
        '  "overrides": [\n'
        '    {\n'
        '      "key": "<section>.<field>",\n'
        '      "value": <number within physics bounds>,\n'
        '      "rationale": "<one sentence why this value fits THIS plant>",\n'
        '      "confidence": <0.0-1.0>\n'
        '    },\n'
        '    ...\n'
        '  ]\n'
        '}\n\n'
        "Rules:\n"
        "- Only override thresholds where the plant's specifics genuinely "
        "matter. Default is fine for ambiguous cases.\n"
        "- Every value MUST be inside its physics bounds. Values outside "
        "will be silently rejected.\n"
        "- Rationale must cite the specific plant attribute that drives the "
        "override (e.g. 'Huawei SUN2000 runs 10°C hotter at full load').\n"
        "- Aim for 3-8 overrides per plant. More than 12 is suspicious."
    )


def _build_user_prompt(meta: PlantMetadataInput) -> str:
    lines = [f"Plant ID: {meta.plant_id}"]
    if meta.asset_type:
        lines.append(f"Asset type: {meta.asset_type}")
    if meta.capacity_mw is not None:
        lines.append(f"Capacity: {meta.capacity_mw} MW")
    if meta.latitude is not None and meta.longitude is not None:
        lines.append(f"Location: {meta.latitude:.2f}°N, {meta.longitude:.2f}°E")
    if meta.country:
        lines.append(f"Country: {meta.country}")
    if meta.climate_zone:
        lines.append(f"Climate zone: {meta.climate_zone}")
    if meta.inverter_manufacturer:
        lines.append(f"Inverter OEM: {meta.inverter_manufacturer}")
    if meta.inverter_model:
        lines.append(f"Inverter model: {meta.inverter_model}")
    if meta.module_manufacturer:
        lines.append(f"Module OEM: {meta.module_manufacturer}")
    if meta.mounting_type:
        lines.append(f"Mounting: {meta.mounting_type}")
    if meta.n_strings is not None:
        lines.append(f"String count: {meta.n_strings}")
    if meta.n_inverters is not None:
        lines.append(f"Inverter count: {meta.n_inverters}")
    if meta.rated_ac_voltage is not None:
        lines.append(f"Rated AC voltage: {meta.rated_ac_voltage} V")
    if meta.commissioning_year is not None:
        lines.append(f"Commissioned: {meta.commissioning_year}")
    if meta.additional_context:
        lines.append(f"Notes: {meta.additional_context}")

    lines.append("")
    lines.append("Suggest per-threshold overrides for this plant.")
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────────────────────
# Cache key
# ──────────────────────────────────────────────────────────────────────────

def _cache_key(meta: PlantMetadataInput, model_id: str) -> str:
    canonical = json.dumps(asdict(meta), sort_keys=True, default=str)
    h = hashlib.sha256((canonical + "|" + model_id).encode()).hexdigest()[:16]
    return h


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def _cache_get(key: str, ttl_hours: int) -> Optional[Dict[str, Any]]:
    fp = _cache_path(key)
    if not fp.exists():
        return None
    try:
        data = json.loads(fp.read_text())
    except Exception:
        return None
    ts = datetime.fromisoformat(data.get("generated_at", "").rstrip("Z"))
    if datetime.utcnow() - ts > timedelta(hours=ttl_hours):
        return None
    return data


def _cache_put(key: str, payload: Dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(key).write_text(json.dumps(payload, indent=2, default=str))


# ──────────────────────────────────────────────────────────────────────────
# Main entry — tune_thresholds
# ──────────────────────────────────────────────────────────────────────────

def _physics_bound_map() -> Dict[str, Tuple[str, str, float, float, float, str]]:
    """Lookup: section.field -> (section, field, default, lo, hi, unit)."""
    return {
        f"{section}.{fld}": (section, fld, default, lo, hi, unit)
        for section, fld, default, lo, hi, _desc, unit in TUNABLE_THRESHOLDS
    }


def tune_thresholds(
    meta: PlantMetadataInput,
    model_id: str = DEFAULT_MODEL_ID,
    region: str = DEFAULT_REGION,
    cache_ttl_hours: int = DEFAULT_CACHE_TTL_HOURS,
    use_cache: bool = True,
) -> TunerResult:
    """Ask Bedrock to suggest per-plant threshold overrides.

    Returns a `TunerResult` with the LLM's suggestions filtered against
    physics bounds. Graceful — if Bedrock is unavailable or returns junk,
    returns an empty result (callers fall back to fleet defaults).
    """
    key = _cache_key(meta, model_id)

    if use_cache:
        cached = _cache_get(key, cache_ttl_hours)
        if cached is not None:
            r = TunerResult(**{k: v for k, v in cached.items() if k != "overrides"})
            r.cache_hit = True
            r.overrides = [ThresholdOverride(**o) for o in cached.get("overrides", [])]
            return r

    result = TunerResult(
        plant_id=meta.plant_id,
        model_id=model_id,
        generated_at=datetime.utcnow().isoformat() + "Z",
    )

    # Lazy import boto3 so module loads even without it (development).
    try:
        import boto3
    except ImportError:
        print("[threshold_tuner] boto3 not installed — returning empty overrides")
        return result

    try:
        client = boto3.client("bedrock-runtime", region_name=region)
        resp = client.converse(
            modelId=model_id,
            system=[{"text": _build_system_prompt()}],
            messages=[{"role": "user", "content": [{"text": _build_user_prompt(meta)}]}],
            inferenceConfig={"maxTokens": 800, "temperature": 0.1},
        )
        result.invocations = 1
        raw = resp["output"]["message"]["content"][0]["text"]
    except Exception as e:
        print(f"[threshold_tuner] Bedrock error: {type(e).__name__}: {e}")
        return result

    # Parse JSON (strip markdown fences if any)
    raw_clean = raw.strip()
    if raw_clean.startswith("```"):
        # remove first and last fence lines
        lines = [l for l in raw_clean.splitlines() if not l.strip().startswith("```")]
        raw_clean = "\n".join(lines)
    try:
        parsed = json.loads(raw_clean)
    except json.JSONDecodeError:
        # Fallback: extract first {...} block
        start = raw_clean.find("{")
        end = raw_clean.rfind("}")
        if start < 0 or end <= start:
            print(f"[threshold_tuner] LLM returned non-JSON: {raw[:200]}")
            return result
        try:
            parsed = json.loads(raw_clean[start:end + 1])
        except json.JSONDecodeError:
            print(f"[threshold_tuner] could not parse LLM JSON")
            return result

    bounds_map = _physics_bound_map()
    overrides_list: List[Dict[str, Any]] = parsed.get("overrides") or []
    for entry in overrides_list:
        key_str = entry.get("key", "")
        value = entry.get("value")
        rationale = entry.get("rationale", "")
        confidence = float(entry.get("confidence", 0.7))

        if key_str not in bounds_map:
            result.rejected_count += 1
            continue
        try:
            value = float(value)
        except (TypeError, ValueError):
            result.rejected_count += 1
            continue

        section, fld, default, lo, hi, unit = bounds_map[key_str]
        if value < lo or value > hi:
            print(f"[threshold_tuner] rejected {key_str}={value} (out of bounds [{lo}, {hi}])")
            result.rejected_count += 1
            continue

        result.overrides.append(ThresholdOverride(
            section=section,
            field=fld,
            value=value,
            default=default,
            physics_bounds=(lo, hi),
            unit=unit,
            rationale=rationale,
            confidence=max(0.0, min(1.0, confidence)),
        ))
        result.overrides_dict.setdefault(section, {})[fld] = value

    payload = result.to_dict()
    _cache_put(key, payload)
    return result
