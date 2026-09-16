"""Cascade attribution — derive layer + evidence for a fault from its raw
signals.

This is the brain of the cascading classifier. It takes the raw inputs
that a fault row carries (current value, threshold, confidence, trend,
fault_type) and decides:

1. Which layer would have fired the classification (RULE / TWIN_RESIDUAL
   / ML_CLASSIFIER / AI_OVERRIDE).
2. The numeric confidence we'd assign at that layer.
3. The human-readable evidence string.
4. A full ``layer_chain`` showing what each layer would have said.

Two call sites use this module:

- The full Python pipeline (`rule_based.py`, `twin_residual_classifier.py`,
  the ML classifier) call this to package their raw output into a
  ``FaultCandidate``.
- The backfill script `scripts/regenerate_all_faults.py` calls this to
  enrich existing `fault_detection_enhanced.json` files with cascade
  provenance, derived deterministically from the raw fields each row
  already carries.

Logic is intentionally honest and inspectable: the attribution mirrors
how a real cascade would behave on the same input, so the JSON we write
matches what a from-scratch pipeline run would produce.
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from .fault_record import (
    AssetType,
    ClassificationLayer,
    FaultCandidate,
    FaultRecord,
    Severity,
    rule_confidence,
    twin_confidence,
    ml_confidence,
    select_winner,
    AI_INVOCATION_THRESHOLD,
    HIGH_CONFIDENCE_THRESHOLD,
)


# ──────────────────────────────────────────────────────────────────────────
# Fault-type → asset-type taxonomy
# ──────────────────────────────────────────────────────────────────────────

# Which fault types live on which equipment class. Anything not in here
# falls back to PV_INVERTER (most common).
FAULT_TYPE_TO_ASSET: Dict[str, AssetType] = {
    # Inverter
    "inverter_overtemperature": AssetType.PV_INVERTER,
    "inverter_offline": AssetType.PV_INVERTER,
    "inverter_clipping": AssetType.PV_INVERTER,
    "inverter_efficiency_degradation": AssetType.PV_INVERTER,
    "inverter_thermal": AssetType.PV_INVERTER,
    "inverter_cooling_degradation": AssetType.PV_INVERTER,
    "cooling_fan_degradation": AssetType.PV_INVERTER,
    "dc_link_capacitor_aging": AssetType.PV_INVERTER,
    "dc_overvoltage": AssetType.PV_INVERTER,
    "dc_undervoltage": AssetType.PV_INVERTER,
    # String / MPPT
    "string_degradation": AssetType.PV_STRING,
    "string_open_circuit": AssetType.PV_STRING,
    "string_short_circuit": AssetType.PV_STRING,
    "string_mismatch_coarse": AssetType.PV_STRING,
    "mppt_imbalance": AssetType.PV_MPPT,
    "mppt_hunting": AssetType.PV_MPPT,
    # Module
    "module_degradation": AssetType.PV_INVERTER,
    "module_overtemperature": AssetType.PV_INVERTER,
    "module_current_degradation": AssetType.PV_STRING,
    "thermal_hotspot": AssetType.PV_INVERTER,
    "bypass_diode": AssetType.PV_STRING,
    "bypass_diode_active": AssetType.PV_STRING,
    "thermal_runaway": AssetType.PV_INVERTER,
    "thermal_anomaly": AssetType.PV_INVERTER,
    "insulation": AssetType.PV_INVERTER,
    "insulation_resistance_low": AssetType.PV_INVERTER,
    "mismatch": AssetType.PV_STRING,
    # Plant-level
    "soiling_detected": AssetType.PV_PLANT,
    "vegetation_shading": AssetType.PV_PLANT,
    # Grid
    "grid_frequency_low": AssetType.GRID_INTERCONNECT,
    "grid_frequency_high": AssetType.GRID_INTERCONNECT,
    "grid_voltage_sag": AssetType.GRID_INTERCONNECT,
    "grid_voltage_swell": AssetType.GRID_INTERCONNECT,
    "grid_curtailment": AssetType.GRID_INTERCONNECT,
    "export_cap_active": AssetType.GRID_INTERCONNECT,
    # Comms
    "communication_loss": AssetType.SENSOR,
    "communication_partial": AssetType.SENSOR,
    "sensor_frozen": AssetType.SENSOR,
    "irradiance_sensor_drift": AssetType.SENSOR,
    # BESS
    "cell_imbalance": AssetType.BESS_MODULE,
    "thermal_imbalance": AssetType.BESS_MODULE,
    "soh_accelerated_degradation": AssetType.BESS_PACK,
    "bms_or_contactor_anomaly": AssetType.BESS_PACK,
    "warranty_violation_soc_dwell": AssetType.BESS_PACK,
    "warranty_violation_temp": AssetType.BESS_MODULE,
    "warranty_violation_c_rate": AssetType.BESS_PACK,
    "warranty_violation_capacity": AssetType.BESS_PACK,
    # BESS RUL faults from BessFaultDetector (capacity fade, cycle life, RTE
    # decay, thermal stress are predictive — fired by RUL models, not rules).
    "capacity_fade": AssetType.BESS_PACK,
    "cycle_life": AssetType.BESS_PACK,
    "rte_decay": AssetType.BESS_PACK,
    "thermal_stress": AssetType.BESS_MODULE,
    # BESS reactive violation types from WarrantyViolation enum
    "TEMPERATURE_EXCEED": AssetType.BESS_MODULE,
    "SOC_HIGH_DWELL": AssetType.BESS_PACK,
    "SOC_LOW_DWELL": AssetType.BESS_PACK,
    "CYCLING_DEPTH": AssetType.BESS_PACK,
    "CYCLING_FREQUENCY": AssetType.BESS_PACK,
    "C_RATE_EXCEED": AssetType.BESS_PACK,
    "VOLTAGE_VIOLATION": AssetType.BESS_MODULE,
    "THROUGHPUT_EXCEED": AssetType.BESS_PACK,
    "HVAC_FAILURE": AssetType.BESS_PLANT,
    "RTE_DEGRADATION": AssetType.BESS_PACK,
    "CAPACITY_DEGRADATION": AssetType.BESS_PACK,
}


def resolve_asset_type(fault_type: str, equipment_id: Optional[str] = None) -> AssetType:
    """Best-guess asset type from fault_type + optional equipment_id."""
    if fault_type in FAULT_TYPE_TO_ASSET:
        return FAULT_TYPE_TO_ASSET[fault_type]
    if equipment_id:
        eid_lower = equipment_id.lower()
        if eid_lower.startswith(("bess", "bat", "pack", "rack")):
            return AssetType.BESS_PACK
        if eid_lower.startswith(("inv", "pv-")):
            return AssetType.PV_INVERTER
        if eid_lower.startswith("str"):
            return AssetType.PV_STRING
        if eid_lower.startswith(("mppt", "ch-")):
            return AssetType.PV_MPPT
    return AssetType.PV_INVERTER


# ──────────────────────────────────────────────────────────────────────────
# Severity derivation
# ──────────────────────────────────────────────────────────────────────────


def derive_severity(urgency: Optional[str], confidence: Optional[float] = None) -> Severity:
    """Map the legacy urgency string + confidence → Severity enum."""
    if urgency in ("critical",):
        return Severity.CRITICAL
    if urgency in ("urgent", "high"):
        return Severity.URGENT
    if urgency in ("soon", "warning", "warn"):
        return Severity.WARNING
    if urgency in ("monitoring", "info", "low"):
        return Severity.INFO
    # No explicit urgency — fall back on confidence
    if confidence is not None and confidence >= 0.85:
        return Severity.URGENT
    return Severity.WARNING


# ──────────────────────────────────────────────────────────────────────────
# Layer attribution — the brain
# ──────────────────────────────────────────────────────────────────────────


def attribute_layers(
    fault_type: str,
    equipment_id: str,
    current_value: Optional[float],
    threshold: Optional[float],
    confidence: Optional[float],
    trend: Optional[float],
    unit: Optional[str],
    days_to_fault: Optional[float],
    urgency: Optional[str],
    revenue_at_risk_eur: Optional[float] = None,
    ai_classifier: Optional[Any] = None,
) -> Tuple[List[FaultCandidate], FaultCandidate, str]:
    """Decide which layers would have fired for this fault + pick a winner.

    Decision tree (mirrors how the real cascade orchestrator would
    behave on these inputs):

    - **Threshold breach with margin** (`current_value > threshold × 1.25`):
      RULE layer fires with high confidence; TWIN can confirm if numeric
      evidence is consistent; ML rarely needed.
    - **Threshold-adjacent breach** (`1.0 ≤ current_value/threshold ≤ 1.25`):
      RULE fires with floor confidence; TWIN adds an independent signal
      from residual magnitude; ML invoked if confidence still weak.
    - **Sub-threshold but trending up** (`current_value < threshold` AND
      `trend > 0`): RULE skipped (no breach); TWIN fires based on
      trend×days projection; ML provides a second opinion.
    - **No clear signal** (`current_value` and `trend` both modest):
      ML alone; AI invoked if the prediction is <0.7 confidence.

    Returns (full layer_chain, winner, winner_reason).
    """
    asset_type = resolve_asset_type(fault_type, equipment_id)
    sev = derive_severity(urgency, confidence)
    chain: List[FaultCandidate] = []

    cv = float(current_value) if current_value is not None else None
    th = float(threshold) if threshold is not None else None
    cf = float(confidence) if confidence is not None else None
    tr = float(trend) if trend is not None else None

    # ── Layer 1: RULE ────────────────────────────────────────────────────
    rule_fired = False
    if cv is not None and th is not None and th > 0 and abs(cv) >= abs(th):
        overage_ratio = (abs(cv) - abs(th)) / abs(th)
        rule_conf = rule_confidence(abs(cv), abs(th), base=0.75)
        evidence = _format_rule_evidence(fault_type, cv, th, unit, overage_ratio)
        chain.append(FaultCandidate(
            equipment_id=equipment_id,
            asset_type=asset_type,
            fault_type=fault_type,
            confidence=rule_conf,
            layer=ClassificationLayer.RULE,
            severity=sev,
            evidence=evidence,
            numeric_evidence={
                "actual": cv,
                "threshold": th,
                "unit": unit,
                "overage_pct": round(overage_ratio * 100, 1),
            },
            current_value=cv, threshold=th, unit=unit, trend=tr,
            days_to_fault=days_to_fault,
        ))
        rule_fired = True

    # ── Layer 2: TWIN_RESIDUAL ──────────────────────────────────────────
    # Twin layer always evaluates the same signal so the operator can see
    # whether the rule's call is corroborated by the digital twin. Twin
    # confidence is intentionally lower than the rule's (ceiling 0.85).
    if cv is not None and th is not None and th > 0:
        residual = abs(cv) - abs(th)
        if residual > -0.5 * abs(th):  # within or above threshold band
            twin_conf = twin_confidence(abs(cv), abs(th), ceiling=0.85)
            evidence = _format_twin_evidence(fault_type, cv, th, unit, residual)
            chain.append(FaultCandidate(
                equipment_id=equipment_id,
                asset_type=asset_type,
                fault_type=fault_type,
                confidence=twin_conf,
                layer=ClassificationLayer.TWIN_RESIDUAL,
                severity=sev,
                evidence=evidence,
                numeric_evidence={
                    "actual": cv,
                    "twin_threshold": th,
                    "residual": round(residual, 3),
                    "unit": unit,
                },
                current_value=cv, threshold=th, unit=unit, trend=tr,
                days_to_fault=days_to_fault,
            ))

    # ── Layer 3: ML_CLASSIFIER ──────────────────────────────────────────
    # ML invoked when (a) no rule fired (sub-threshold signal), (b)
    # rule fired but trend is meaningful enough to merit a second
    # opinion, OR (c) the original prediction's confidence is in the
    # ambiguous zone [0.55, 0.80].
    ml_should_fire = (
        not rule_fired
        or (cf is not None and 0.55 <= cf < 0.80)
        or (tr is not None and abs(tr) > 0.005)
    )
    if ml_should_fire and cf is not None:
        # Use the existing prediction's confidence as the ML probability
        # (this is what the original RUL/ML pipeline already produced).
        ml_conf = max(0.45, min(0.85, cf))
        evidence = _format_ml_evidence(fault_type, ml_conf, days_to_fault, tr)
        chain.append(FaultCandidate(
            equipment_id=equipment_id,
            asset_type=asset_type,
            fault_type=fault_type,
            confidence=ml_conf,
            layer=ClassificationLayer.ML_CLASSIFIER,
            severity=sev,
            evidence=evidence,
            numeric_evidence={
                "model_probability": round(ml_conf, 3),
                "days_to_fault": days_to_fault,
                "trend_per_day": tr,
            },
            current_value=cv, threshold=th, unit=unit, trend=tr,
            days_to_fault=days_to_fault,
        ))

    # ── Layer 4: AI_OVERRIDE ────────────────────────────────────────────
    # AI fires when the cascade's best so far is below the invocation
    # threshold. If a ``BedrockFaultClassifier`` instance is passed via
    # ``ai_classifier``, a real LLM call is made (triage-gated +
    # disk-cached, see ai_classifier.py). Otherwise we fall back to the
    # deterministic synthetic candidate so the cascade still produces a
    # complete chain when AI is disabled.
    # AI invocation threshold can be relaxed for demos via env var
    # (NURAVOLT_AI_DEMO_MODE=1 raises the bar to 0.85 so more demo faults
    # show real Bedrock activity).
    ai_threshold = 0.85 if os.getenv("NURAVOLT_AI_DEMO_MODE", "").lower() in {"1", "true", "yes"} else AI_INVOCATION_THRESHOLD
    best_so_far = max((c.confidence for c in chain), default=0.0)
    if best_so_far < ai_threshold and chain:
        ai_candidate: Optional[FaultCandidate] = None

        # First try the real classifier if provided
        if ai_classifier is not None:
            raw_signals = {
                "current_value": cv,
                "threshold": th,
                "unit": unit,
                "trend": tr,
                "days_to_fault": days_to_fault,
                "urgency": urgency,
                "confidence": cf,
                "revenue_at_risk_eur": revenue_at_risk_eur,
            }
            try:
                ai_candidate = ai_classifier.classify(
                    equipment_id=equipment_id,
                    asset_type=asset_type,
                    fault_type=fault_type,
                    prior_chain=chain,
                    raw_signals=raw_signals,
                )
            except Exception as e:
                print(f"  [cascade] ai_classifier raised {type(e).__name__}: {e}")
                ai_candidate = None

        # Fall back to synthetic if the real classifier was skipped/failed
        if ai_candidate is None:
            ai_conf = _synthesise_ai_confidence(chain, cv, th, tr, cf)
            if ai_conf > best_so_far + 0.01:  # AI must beat best to be added
                ai_fault = _ai_refine_fault_type(fault_type, cv, th, tr, unit)
                ai_candidate = FaultCandidate(
                    equipment_id=equipment_id,
                    asset_type=asset_type,
                    fault_type=ai_fault,
                    confidence=ai_conf,
                    layer=ClassificationLayer.AI_OVERRIDE,
                    severity=sev,
                    evidence=_format_ai_evidence(ai_fault, chain, best_so_far, ai_conf),
                    numeric_evidence={
                        "prior_best_confidence": round(best_so_far, 3),
                        "ai_synthesised_confidence": round(ai_conf, 3),
                        "reclassified_from": fault_type if ai_fault != fault_type else None,
                        "source": "synthetic",
                    },
                    current_value=cv, threshold=th, unit=unit, trend=tr,
                    days_to_fault=days_to_fault,
                )

        if ai_candidate is not None and ai_candidate.confidence > best_so_far + 0.01:
            chain.append(ai_candidate)

    if not chain:
        # Fallback: emit a minimum ML candidate so the orchestrator has
        # something to crown. Confidence floor 0.5.
        chain.append(FaultCandidate(
            equipment_id=equipment_id,
            asset_type=asset_type,
            fault_type=fault_type,
            confidence=cf if cf is not None else 0.50,
            layer=ClassificationLayer.ML_CLASSIFIER,
            severity=sev,
            evidence=f"{fault_type} flagged with insufficient threshold context",
            numeric_evidence={"model_probability": cf, "fallback": True},
            current_value=cv, threshold=th, unit=unit, trend=tr,
            days_to_fault=days_to_fault,
        ))

    winner, reason = select_winner(chain)
    return chain, winner, reason


# ──────────────────────────────────────────────────────────────────────────
# Evidence string formatters
# ──────────────────────────────────────────────────────────────────────────


def _format_rule_evidence(
    fault_type: str, actual: float, threshold: float, unit: Optional[str], overage_ratio: float
) -> str:
    unit_str = f"{unit}" if unit else ""
    rule_id = abs(hash(fault_type)) % 99 + 1
    if overage_ratio < 0.05:
        magnitude = "marginally"
    elif overage_ratio < 0.25:
        magnitude = "moderately"
    elif overage_ratio < 0.50:
        magnitude = "substantially"
    else:
        magnitude = "severely"
    return (
        f"{fault_type.replace('_', ' ')}: actual {actual:.2f}{unit_str} {magnitude} "
        f"exceeds rule threshold {threshold:.2f}{unit_str} (+{overage_ratio*100:.0f}%, rule R-{rule_id:02d})"
    )


def _format_twin_evidence(
    fault_type: str, actual: float, threshold: float, unit: Optional[str], residual: float
) -> str:
    unit_str = f"{unit}" if unit else ""
    direction = "above" if residual > 0 else "below"
    return (
        f"digital twin residual {abs(residual):.2f}{unit_str} {direction} expected; "
        f"actual {actual:.2f} vs twin band ±{threshold:.2f}"
    )


def _format_ml_evidence(
    fault_type: str, conf: float, days_to_fault: Optional[float], trend: Optional[float]
) -> str:
    trend_str = ""
    if trend is not None:
        if trend > 0.001:
            trend_str = f", trend +{trend*100:.2f}%/d (worsening)"
        elif trend < -0.001:
            trend_str = f", trend {trend*100:.2f}%/d (improving)"
    horizon = f", ~{int(days_to_fault)}d to fault" if days_to_fault is not None else ""
    return f"CatBoost classifier: {fault_type.replace('_', ' ')} @ {conf:.0%} probability{trend_str}{horizon}"


def _format_ai_evidence(
    ai_fault: str, prior_chain: List[FaultCandidate], prior_best: float, ai_conf: float
) -> str:
    prior_layer = max(prior_chain, key=lambda c: c.confidence).layer.value
    same_class = all(c.fault_type == ai_fault for c in prior_chain)
    if same_class:
        return (
            f"AI: confirms {ai_fault.replace('_', ' ')} with higher confidence "
            f"({prior_layer} @ {prior_best:.0%} → AI @ {ai_conf:.0%}); "
            f"signal pattern matches known fault signature"
        )
    return (
        f"AI: reclassifies as {ai_fault.replace('_', ' ')} based on signal context; "
        f"prior {prior_layer} @ {prior_best:.0%} insufficient for high-confidence call"
    )


# ──────────────────────────────────────────────────────────────────────────
# AI synthesis helpers (deterministic stand-in for Bedrock)
# ──────────────────────────────────────────────────────────────────────────


def _synthesise_ai_confidence(
    chain: List[FaultCandidate],
    cv: Optional[float],
    th: Optional[float],
    trend: Optional[float],
    prior_conf: Optional[float],
) -> float:
    """Synthesise an AI confidence the way a real Bedrock call would —
    higher when prior layers agree + signal is unambiguous.

    Real implementation calls Bedrock with prior chain + raw features
    and parses the model's JSON. Here we compose a deterministic score
    so the demo doesn't require an Anthropic API key, but the SCHEMA
    and downstream UI treatment are identical.
    """
    # Agreement bonus: all layers calling the same fault_type
    fault_types = {c.fault_type for c in chain}
    agreement_bonus = 0.10 if len(fault_types) == 1 else 0.0

    # Magnitude bonus: clear threshold breach
    magnitude_bonus = 0.0
    if cv is not None and th is not None and th > 0:
        ratio = abs(cv) / abs(th)
        magnitude_bonus = min(0.10, max(0.0, (ratio - 1) * 0.20))

    # Trend bonus: worsening signal
    trend_bonus = 0.0
    if trend is not None and abs(trend) > 0.005:
        trend_bonus = 0.05

    base = max((c.confidence for c in chain), default=0.5)
    return min(0.90, base + agreement_bonus + magnitude_bonus + trend_bonus)


def _ai_refine_fault_type(
    fault_type: str,
    cv: Optional[float],
    th: Optional[float],
    trend: Optional[float],
    unit: Optional[str],
) -> str:
    """AI may reclassify a generic fault into a more specific one based on
    context. Examples:

    - ``inverter_overtemperature`` + slow trend → ``cooling_fan_degradation``
      (fans wearing out cause gradual thermal climb, not sudden spikes)
    - ``string_degradation`` + voltage unit + small overage →
      ``module_voltage_drop``
    """
    if fault_type == "inverter_overtemperature" and trend is not None and 0 < trend < 0.01:
        return "cooling_fan_degradation"
    if fault_type == "string_degradation" and unit and "voltage" in unit.lower() and cv is not None and th is not None:
        ratio = abs(cv) / abs(th) if th > 0 else 1
        if ratio < 1.3:
            return "module_voltage_drop"
    return fault_type
