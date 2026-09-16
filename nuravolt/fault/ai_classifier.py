"""Real Bedrock fault classifier — Layer 4 of the cascade.

When ``cascade_attribution.attribute_layers()`` determines that prior
layers (rule, twin, ML) all produced confidence <0.70 AND the fault
passes the triage gate (high-stakes only — we don't burn LLM budget on
noise), this module sends the prior layer chain + raw signals to
Bedrock and asks Claude/Qwen to either confirm or reclassify.

Two cost gates protect against LLM-call explosion:

1. **Triage gate** (`should_invoke_ai`): only severe + actionable +
   imminent + revenue-meaningful faults call the model. Most
   "monitoring" or far-future faults never reach AI.
2. **Disk cache** (24h TTL, keyed on equipment + signal fingerprint):
   the same noisy inverter repeatedly producing the same fault doesn't
   hit Bedrock twice in a day.

Model is configured via ``BEDROCK_MODEL_ID`` env (default Qwen 3 32B,
since the demo AWS account doesn't have Anthropic Claude approval —
swap to Claude Haiku 4.5 when access is granted).

Failure mode is graceful: any Bedrock error → log + return None so the
caller falls back to the synthetic AI candidate from
``cascade_attribution._synthesise_ai_confidence()``. Regen never breaks
because Bedrock had a bad day.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from .fault_record import (
    AssetType,
    ClassificationLayer,
    FaultCandidate,
    Severity,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "backenddata" / "cache" / "ai_classifications"
DEFAULT_CACHE_TTL_HOURS = 24

# Default model — Qwen 3 Next 80B (MoE) on Bedrock eu-west-1, the best
# enabled model on this account (DeepSeek isn't offered in eu-west-1, and
# Claude needs the Anthropic use-case form which hasn't been submitted).
# Invoked via the provider-agnostic Converse API; override with
# BEDROCK_FAULT_MODEL_ID. (qwen.qwen3-32b-v1:0 is a smaller/cheaper option.)
DEFAULT_MODEL_ID = "qwen.qwen3-next-80b-a3b"
DEFAULT_REGION = "eu-west-1"

# Closed taxonomy — Bedrock output is rejected if it returns anything outside.
TAXONOMY = frozenset({
    # Inverter
    "inverter_overtemperature", "cooling_fan_degradation", "inverter_efficiency_degradation",
    "dc_link_capacitor_aging", "dc_overvoltage", "dc_undervoltage", "inverter_thermal",
    "inverter_cooling_degradation",
    # String / MPPT
    "string_degradation", "string_open_circuit", "string_short_circuit", "module_voltage_drop",
    "mppt_imbalance", "mppt_hunting", "partial_shading", "thermal_hotspot", "bypass_diode_active",
    "insulation_resistance_low", "module_degradation", "module_overtemperature",
    "module_current_degradation", "thermal_runaway", "thermal_anomaly", "mismatch",
    "string_mismatch_coarse",
    # BESS
    "cell_imbalance", "thermal_imbalance", "soh_accelerated_degradation",
    "bms_or_contactor_anomaly", "warranty_violation_soc_dwell", "warranty_violation_temp",
    "warranty_violation_c_rate", "warranty_violation_capacity",
    "capacity_fade", "cycle_life", "rte_decay", "thermal_stress",
    # Grid / plant / sensor
    "grid_curtailment", "grid_frequency_low", "grid_frequency_high",
    "grid_voltage_sag", "grid_voltage_swell", "export_cap_active",
    "soiling_detected", "vegetation_shading",
    "communication_loss", "communication_partial",
    "sensor_frozen", "irradiance_sensor_drift",
})


# ──────────────────────────────────────────────────────────────────────────
# Triage gate — protects the LLM budget
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class TriageConfig:
    """Configurable thresholds for the triage gate.

    Defaults chosen so AI fires on ~25% of cascade-uncertain faults on
    our demo plants — high enough to be visible, low enough that a
    200-inverter production plant doesn't trigger thousands of LLM calls
    per regen. Tune via env vars (NURAVOLT_AI_TRIAGE_*) or pass a custom
    instance to ``should_invoke_ai``.
    """

    min_confidence: float = 0.50
    max_days_to_fault: float = 30.0
    min_revenue_at_risk_eur: float = 100.0
    # urgency must be one of these — "planned" + "monitoring" are skipped
    allowed_urgencies: frozenset = frozenset({"critical", "urgent", "soon", "high", "warning"})

    @classmethod
    def from_env(cls) -> "TriageConfig":
        return cls(
            min_confidence=float(os.getenv("NURAVOLT_AI_TRIAGE_MIN_CONFIDENCE", "0.50")),
            max_days_to_fault=float(os.getenv("NURAVOLT_AI_TRIAGE_MAX_DAYS", "30")),
            min_revenue_at_risk_eur=float(os.getenv("NURAVOLT_AI_TRIAGE_MIN_REVENUE", "100")),
        )


def should_invoke_ai(fault_signals: Dict[str, Any], cfg: Optional[TriageConfig] = None) -> tuple[bool, str]:
    """Decide whether a fault is severe + imminent + valuable enough to
    spend Bedrock budget on. Returns (bool, reason)."""
    cfg = cfg or TriageConfig.from_env()

    conf = float(fault_signals.get("confidence", 0) or 0)
    if conf < cfg.min_confidence:
        return False, f"confidence {conf:.2f} below triage floor {cfg.min_confidence:.2f}"

    days = fault_signals.get("days_to_fault")
    if days is not None and float(days) > cfg.max_days_to_fault:
        return False, f"days_to_fault {days} > triage horizon {cfg.max_days_to_fault}"

    urgency = (fault_signals.get("urgency") or "").lower()
    if urgency and urgency not in cfg.allowed_urgencies:
        return False, f"urgency {urgency!r} not in triage allow-list"

    revenue = float(fault_signals.get("revenue_at_risk_eur", 0) or 0)
    if revenue < cfg.min_revenue_at_risk_eur:
        return False, f"revenue_at_risk €{revenue:.0f} below triage floor €{cfg.min_revenue_at_risk_eur:.0f}"

    return True, "triage passed"


# ──────────────────────────────────────────────────────────────────────────
# Disk cache
# ──────────────────────────────────────────────────────────────────────────


def _cache_key(equipment_id: str, fault_type: str, signals: Dict[str, Any]) -> str:
    """Fingerprint a (equipment, fault, signal) tuple. Rounds current_value
    and threshold to 3 sig figs so small numerical jitter doesn't bust
    the cache."""
    def round_sig(x: Any, digits: int = 3) -> Any:
        if x is None:
            return None
        try:
            f = float(x)
            if f == 0:
                return 0
            from math import log10, floor
            return round(f, digits - int(floor(log10(abs(f)))) - 1)
        except (TypeError, ValueError):
            return x

    fingerprint = {
        "equipment_id": equipment_id,
        "fault_type": fault_type,
        "current_value": round_sig(signals.get("current_value")),
        "threshold": round_sig(signals.get("threshold")),
        "unit": signals.get("unit"),
    }
    blob = json.dumps(fingerprint, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def _cache_read(key: str, ttl_hours: int = DEFAULT_CACHE_TTL_HOURS) -> Optional[Dict[str, Any]]:
    fp = CACHE_DIR / f"{key}.json"
    if not fp.exists():
        return None
    try:
        stat = fp.stat()
        age = datetime.utcnow() - datetime.utcfromtimestamp(stat.st_mtime)
        if age > timedelta(hours=ttl_hours):
            return None
        return json.loads(fp.read_text())
    except Exception:
        return None


def _cache_write(key: str, payload: Dict[str, Any]) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{key}.json").write_text(json.dumps(payload, indent=2))


# ──────────────────────────────────────────────────────────────────────────
# Bedrock client
# ──────────────────────────────────────────────────────────────────────────


SYSTEM_PROMPT = """You are the AI override layer of a cascading fault classifier for solar PV and battery storage assets. Rule-based + digital twin residual + CatBoost ML classifiers already ran and each produced a candidate fault type with confidence <0.70 — i.e. the upstream layers are not confident.

Your job: given the full prior layer chain + raw signal evidence, either
  (a) CONFIRM one of the prior candidates with higher confidence (because the signal pattern matches a known signature), or
  (b) RECLASSIFY to a different fault type from the closed taxonomy below if the prior layers are picking the wrong cause.

CLOSED TAXONOMY (output EXACTLY one of these strings — no others, no variations):
inverter_overtemperature, cooling_fan_degradation, inverter_efficiency_degradation, dc_link_capacitor_aging, dc_overvoltage, dc_undervoltage, inverter_thermal, inverter_cooling_degradation, string_degradation, string_open_circuit, string_short_circuit, module_voltage_drop, mppt_imbalance, mppt_hunting, partial_shading, thermal_hotspot, bypass_diode_active, insulation_resistance_low, cell_imbalance, thermal_imbalance, soh_accelerated_degradation, bms_or_contactor_anomaly, warranty_violation_soc_dwell, warranty_violation_temp, warranty_violation_c_rate, warranty_violation_capacity, capacity_fade, cycle_life, rte_decay, thermal_stress, grid_curtailment, soiling_detected, vegetation_shading, communication_loss, sensor_frozen, irradiance_sensor_drift

OUTPUT FORMAT — strict JSON, no markdown fences, no prose:
{"fault_type": "<one of the taxonomy strings>", "confidence": <float 0.0-1.0>, "evidence": "<one sentence O&M-engineer rationale>", "reasoning": "<2-3 sentence longer explanation>"}"""


@dataclass
class ClassifierStats:
    invocations: int = 0
    cache_hits: int = 0
    triage_skips: int = 0
    validation_failures: int = 0
    bedrock_errors: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0


class BedrockFaultClassifier:
    """Single instance reused across a regen run.

    Holds the boto3 client + accumulated stats so the regen script can
    report Bedrock activity at the end.
    """

    def __init__(
        self,
        model_id: Optional[str] = None,
        region: Optional[str] = None,
        triage: Optional[TriageConfig] = None,
        cache_ttl_hours: int = DEFAULT_CACHE_TTL_HOURS,
        rate_limit_sleep_ms: int = 200,
    ) -> None:
        self.model_id = model_id or os.getenv("BEDROCK_FAULT_MODEL_ID") or DEFAULT_MODEL_ID
        self.region = region or os.getenv("AWS_REGION") or DEFAULT_REGION
        self.triage = triage or TriageConfig.from_env()
        self.cache_ttl_hours = cache_ttl_hours
        self.rate_limit_sleep_ms = rate_limit_sleep_ms
        self.stats = ClassifierStats()
        self._client = None

    @property
    def client(self):
        if self._client is None:
            import boto3
            self._client = boto3.client("bedrock-runtime", region_name=self.region)
        return self._client

    def classify(
        self,
        equipment_id: str,
        asset_type: AssetType,
        fault_type: str,
        prior_chain: List[FaultCandidate],
        raw_signals: Dict[str, Any],
    ) -> Optional[FaultCandidate]:
        """Classify a single fault. Returns a ``FaultCandidate`` with
        ``layer=AI_OVERRIDE`` or ``None`` if AI was skipped/failed (the
        caller then uses the synthetic candidate as fallback)."""
        # 1. Triage gate
        gate_pass, gate_reason = should_invoke_ai(raw_signals, self.triage)
        if not gate_pass:
            self.stats.triage_skips += 1
            return None

        # 2. Cache lookup
        cache_key = _cache_key(equipment_id, fault_type, raw_signals)
        cached = _cache_read(cache_key, self.cache_ttl_hours)
        if cached:
            self.stats.cache_hits += 1
            return self._payload_to_candidate(cached, equipment_id, asset_type, raw_signals)

        # 3. Bedrock invocation
        try:
            user_prompt = self._build_user_prompt(equipment_id, fault_type, prior_chain, raw_signals)
            response = self.client.converse(
                modelId=self.model_id,
                system=[{"text": SYSTEM_PROMPT}],
                messages=[{"role": "user", "content": [{"text": user_prompt}]}],
                inferenceConfig={"maxTokens": 400, "temperature": 0.1, "topP": 0.9},
            )
            time.sleep(self.rate_limit_sleep_ms / 1000.0)
        except Exception as e:
            self.stats.bedrock_errors += 1
            print(f"  [AI] {equipment_id}/{fault_type}: Bedrock error {type(e).__name__}: {str(e)[:120]}")
            return None

        # 4. Parse + validate
        usage = response.get("usage", {})
        self.stats.invocations += 1
        self.stats.total_input_tokens += int(usage.get("inputTokens", 0))
        self.stats.total_output_tokens += int(usage.get("outputTokens", 0))

        text = ""
        try:
            text = response["output"]["message"]["content"][0]["text"]
        except (KeyError, IndexError):
            self.stats.validation_failures += 1
            return None

        payload = self._extract_json(text)
        if not payload:
            self.stats.validation_failures += 1
            print(f"  [AI] {equipment_id}/{fault_type}: invalid JSON: {text[:120]!r}")
            return None

        new_fault_type = payload.get("fault_type")
        if new_fault_type not in TAXONOMY:
            self.stats.validation_failures += 1
            print(f"  [AI] {equipment_id}/{fault_type}: fault_type {new_fault_type!r} outside taxonomy")
            return None

        # 5. Cache + return
        _cache_write(cache_key, payload)
        return self._payload_to_candidate(payload, equipment_id, asset_type, raw_signals)

    # ────────────────────────────────────────────────────────────────────
    # Internal helpers
    # ────────────────────────────────────────────────────────────────────

    def _build_user_prompt(
        self,
        equipment_id: str,
        fault_type: str,
        prior_chain: List[FaultCandidate],
        raw_signals: Dict[str, Any],
    ) -> str:
        chain_summary = []
        for c in prior_chain:
            chain_summary.append({
                "layer": c.layer.value,
                "fault_type": c.fault_type,
                "confidence": round(c.confidence, 3),
                "evidence": c.evidence,
            })
        ctx = {
            "equipment_id": equipment_id,
            "prior_layer_chain": chain_summary,
            "raw_signals": {
                "current_value": raw_signals.get("current_value"),
                "threshold": raw_signals.get("threshold"),
                "unit": raw_signals.get("unit"),
                "trend_per_day": raw_signals.get("trend"),
                "days_to_fault": raw_signals.get("days_to_fault"),
                "urgency": raw_signals.get("urgency"),
                "confidence_upstream": raw_signals.get("confidence"),
            },
            "task": "Decide whether to confirm one of the prior fault_types with higher confidence, or reclassify based on the signal pattern. Output strict JSON.",
        }
        return json.dumps(ctx, indent=2)

    def _extract_json(self, text: str) -> Optional[Dict[str, Any]]:
        """Forgiving JSON extraction — handles a few common LLM
        artefacts (markdown fences, leading prose) before giving up."""
        text = text.strip()
        # Strip markdown code fences if present
        if text.startswith("```"):
            lines = text.split("\n")
            # Drop first + last line (fence)
            text = "\n".join(lines[1:-1]) if len(lines) > 2 else text
            text = text.strip()
        # Find first { and last }
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None

    def _payload_to_candidate(
        self,
        payload: Dict[str, Any],
        equipment_id: str,
        asset_type: AssetType,
        raw_signals: Dict[str, Any],
    ) -> FaultCandidate:
        return FaultCandidate(
            equipment_id=equipment_id,
            asset_type=asset_type,
            fault_type=payload["fault_type"],
            confidence=float(min(0.95, max(0.0, payload.get("confidence", 0.5)))),
            layer=ClassificationLayer.AI_OVERRIDE,
            severity=Severity.WARNING,
            evidence=str(payload.get("evidence", "AI classification"))[:280],
            numeric_evidence={
                "ai_reasoning": str(payload.get("reasoning", ""))[:500],
                "model_id": self.model_id,
            },
            current_value=raw_signals.get("current_value"),
            threshold=raw_signals.get("threshold"),
            unit=raw_signals.get("unit"),
            trend=raw_signals.get("trend"),
            days_to_fault=raw_signals.get("days_to_fault"),
        )

    def stats_dict(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "invocations": self.stats.invocations,
            "cache_hits": self.stats.cache_hits,
            "triage_skips": self.stats.triage_skips,
            "validation_failures": self.stats.validation_failures,
            "bedrock_errors": self.stats.bedrock_errors,
            "input_tokens": self.stats.total_input_tokens,
            "output_tokens": self.stats.total_output_tokens,
        }
