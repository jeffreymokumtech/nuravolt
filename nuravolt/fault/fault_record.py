"""Unified fault record schema for the cascading classifier.

Why this exists
---------------
Today the fault pipeline runs three layers (rules, RUL models, ML classifier)
in parallel + a BESS warranty-violation pipeline that's completely separate.
The operator sees a single opaque ``fault_type`` with no provenance and no
shared treatment between PV and battery.

This module defines the *single source of truth* for a fault: one schema
emitted by every layer (``FaultCandidate``), one schema chosen by the
cascade orchestrator (``FaultRecord``). PV and BESS share both.

Each candidate carries:
- numeric confidence (0-1), not just severity
- the layer that produced it (``RULE``, ``TWIN_RESIDUAL``, ``ML_CLASSIFIER``, ``AI_OVERRIDE``)
- human-readable ``evidence`` ("thermal residual 8.2°C for 36h vs threshold 6°C")
- structured ``numeric_evidence`` (machine-readable form of the same)

The winning ``FaultRecord`` records the full ``layer_chain`` (audit trail of
every layer that ran for this equipment) + a ``winner_reason`` string so
the UI can show "RULE @ 0.92 won over TWIN @ 0.78" if the operator asks.

Backward compatibility
----------------------
``FaultRecord.to_legacy_dict()`` emits the existing
``public/data/faults/{plantId}/fault_detection_enhanced.json`` shape with
new fields added (never removed/renamed), so existing UI consumers keep
working unchanged.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from datetime import datetime, date
from enum import Enum
from typing import Any, Dict, List, Optional


# ──────────────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────────────


class AssetType(str, Enum):
    """Equipment categories. Used to dispatch to the right rule + twin layer."""

    PV_INVERTER = "PV_INVERTER"
    PV_STRING = "PV_STRING"
    PV_MPPT = "PV_MPPT"
    PV_PLANT = "PV_PLANT"
    BESS_MODULE = "BESS_MODULE"
    BESS_PACK = "BESS_PACK"
    BESS_PLANT = "BESS_PLANT"
    GRID_INTERCONNECT = "GRID_INTERCONNECT"
    SENSOR = "SENSOR"


class ClassificationLayer(str, Enum):
    """Which layer of the cascade produced a candidate.

    Precedence on confidence ties: RULE > TWIN_RESIDUAL > ML_CLASSIFIER > AI_OVERRIDE.
    Rationale: rules are inherently explainable + cheapest; AI is most
    expensive + most opaque, so when two candidates tie, defer to the
    more transparent layer.
    """

    RULE = "RULE"
    TWIN_RESIDUAL = "TWIN_RESIDUAL"
    ML_CLASSIFIER = "ML_CLASSIFIER"
    AI_OVERRIDE = "AI_OVERRIDE"


class Severity(str, Enum):
    """Severity buckets used by the UI for tone-keyed rendering."""

    INFO = "info"
    WARNING = "warning"
    URGENT = "urgent"
    CRITICAL = "critical"


# Layer precedence for tie-breaking (lower index = higher precedence)
_LAYER_PRECEDENCE = [
    ClassificationLayer.RULE,
    ClassificationLayer.TWIN_RESIDUAL,
    ClassificationLayer.ML_CLASSIFIER,
    ClassificationLayer.AI_OVERRIDE,
]

# Confidence thresholds used by the cascade orchestrator
HIGH_CONFIDENCE_THRESHOLD = 0.85   # rule/twin layer short-circuits at this
ML_FLOOR_THRESHOLD = 0.60          # below this, ML output is "weak coverage"
AI_INVOCATION_THRESHOLD = 0.70     # max-conf below this triggers AI


# ──────────────────────────────────────────────────────────────────────────
# Candidate emitted by each layer
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class FaultCandidate:
    """One layer's hypothesis about a fault on one piece of equipment.

    Each layer (rules, twin, ML, AI) emits ``FaultCandidate``s. The
    orchestrator collects them and picks a winner per equipment.
    """

    equipment_id: str
    asset_type: AssetType
    fault_type: str                  # taxonomy: thermal_runaway, cell_imbalance, …
    confidence: float                # 0-1
    layer: ClassificationLayer
    severity: Severity = Severity.WARNING
    evidence: str = ""               # human-readable rationale for the UI
    numeric_evidence: Dict[str, Any] = field(default_factory=dict)
    detected_at: Optional[datetime] = None  # when the layer made this call

    # Optional forward-looking fields populated when the layer has a horizon
    days_to_fault: Optional[float] = None
    predicted_fault_date: Optional[date] = None
    current_value: Optional[float] = None
    threshold: Optional[float] = None
    unit: Optional[str] = None
    trend: Optional[float] = None

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError(f"confidence must be in [0, 1], got {self.confidence}")
        if self.detected_at is None:
            self.detected_at = datetime.utcnow()


# ──────────────────────────────────────────────────────────────────────────
# Final record emitted by the cascade orchestrator
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class FaultRecord:
    """The orchestrator's chosen fault for one equipment + its audit trail.

    Surfaces in the UI as a single alarm row but carries the entire
    layer chain so the operator can drill into "why did the system decide
    this?". The winning candidate's fields are promoted to the top level
    for the UI's convenience.
    """

    id: str                           # stable hash; idempotency key for tickets
    equipment_id: str
    asset_type: AssetType
    fault_type: str
    confidence: float
    classification_layer: ClassificationLayer
    severity: Severity
    evidence: str
    numeric_evidence: Dict[str, Any] = field(default_factory=dict)
    detected_at: Optional[datetime] = None

    days_to_fault: Optional[float] = None
    predicted_fault_date: Optional[date] = None
    current_value: Optional[float] = None
    threshold: Optional[float] = None
    unit: Optional[str] = None
    trend: Optional[float] = None

    recommended_action: str = ""
    revenue_at_risk_eur: float = 0.0
    projected_energy_loss_kwh: float = 0.0

    layer_chain: List[FaultCandidate] = field(default_factory=list)
    winner_reason: str = ""

    @staticmethod
    def make_id(equipment_id: str, fault_type: str, detected_at: datetime) -> str:
        """Stable hash for ticket idempotency. Same equipment + same fault
        type on the same calendar day → same id, so the alarm-click flow
        finds an existing ticket instead of creating duplicates."""
        day = detected_at.strftime("%Y-%m-%d")
        seed = f"{equipment_id}|{fault_type}|{day}"
        return hashlib.sha1(seed.encode()).hexdigest()[:16]

    @classmethod
    def from_winning_candidate(
        cls,
        winner: FaultCandidate,
        layer_chain: List[FaultCandidate],
        winner_reason: str,
        recommended_action: str = "",
        revenue_at_risk_eur: float = 0.0,
        projected_energy_loss_kwh: float = 0.0,
    ) -> "FaultRecord":
        """Promote a winning ``FaultCandidate`` to a ``FaultRecord`` while
        preserving the full layer chain for audit."""
        detected_at = winner.detected_at or datetime.utcnow()
        return cls(
            id=cls.make_id(winner.equipment_id, winner.fault_type, detected_at),
            equipment_id=winner.equipment_id,
            asset_type=winner.asset_type,
            fault_type=winner.fault_type,
            confidence=winner.confidence,
            classification_layer=winner.layer,
            severity=winner.severity,
            evidence=winner.evidence,
            numeric_evidence=dict(winner.numeric_evidence),
            detected_at=detected_at,
            days_to_fault=winner.days_to_fault,
            predicted_fault_date=winner.predicted_fault_date,
            current_value=winner.current_value,
            threshold=winner.threshold,
            unit=winner.unit,
            trend=winner.trend,
            recommended_action=recommended_action,
            revenue_at_risk_eur=revenue_at_risk_eur,
            projected_energy_loss_kwh=projected_energy_loss_kwh,
            layer_chain=list(layer_chain),
            winner_reason=winner_reason,
        )

    def to_legacy_dict(self) -> Dict[str, Any]:
        """Emit the existing ``predictive_faults`` row shape with the new
        cascade fields appended. The UI's existing
        ``OpsFaults.tsx``/``AlarmStack.tsx`` consumers keep working unchanged;
        the new fields are surfaced by the updated UI."""
        urgency = _severity_to_urgency(self.severity, self.days_to_fault)
        return {
            # legacy fields the UI already consumes
            "id": self.id,
            "fault_type": self.fault_type,
            "display_name": _humanise(self.fault_type),
            "equipment_id": self.equipment_id,
            "asset_type": self.asset_type.value,
            "days_to_fault": self.days_to_fault if self.days_to_fault is not None else 30,
            "urgency": urgency,
            "recommended_action": self.recommended_action,
            "revenue_at_risk_eur": float(round(self.revenue_at_risk_eur, 2)),
            "projected_energy_loss_kwh": float(round(self.projected_energy_loss_kwh, 2)),
            "current_value": self.current_value,
            "threshold": self.threshold,
            "unit": self.unit,
            "trend": self.trend,
            "confidence": float(round(self.confidence, 3)),
            "severity": self.severity.value,
            # new cascade fields
            "classification_layer": self.classification_layer.value,
            "evidence": self.evidence,
            "numeric_evidence": self.numeric_evidence,
            "winner_reason": self.winner_reason,
            "layer_chain": [
                {
                    "layer": c.layer.value,
                    "fault_type": c.fault_type,
                    "confidence": float(round(c.confidence, 3)),
                    "evidence": c.evidence,
                    "severity": c.severity.value,
                }
                for c in self.layer_chain
            ],
            "detected_at": self.detected_at.isoformat() if self.detected_at else None,
        }


# ──────────────────────────────────────────────────────────────────────────
# Winner selection — used by the cascade orchestrator
# ──────────────────────────────────────────────────────────────────────────


def select_winner(candidates: List[FaultCandidate]) -> tuple[FaultCandidate, str]:
    """Pick the winning candidate from a layer chain for one equipment.

    Rules:
    1. Highest confidence wins.
    2. On ties (within 0.01), the more precedent layer wins
       (RULE > TWIN_RESIDUAL > ML_CLASSIFIER > AI_OVERRIDE).
    3. AI is treated as an override candidate: if AI emitted a candidate
       AND its confidence > the best non-AI candidate, AI wins regardless
       of ties.

    Returns the winning candidate + a human-readable ``winner_reason``.
    """
    if not candidates:
        raise ValueError("no candidates to select from")

    # Separate AI from the rest so override semantics are explicit
    non_ai = [c for c in candidates if c.layer != ClassificationLayer.AI_OVERRIDE]
    ai = [c for c in candidates if c.layer == ClassificationLayer.AI_OVERRIDE]

    if non_ai:
        best_non_ai = max(non_ai, key=lambda c: (c.confidence, -_LAYER_PRECEDENCE.index(c.layer)))
    else:
        best_non_ai = None

    if ai:
        best_ai = max(ai, key=lambda c: c.confidence)
        if best_non_ai is None:
            return best_ai, "AI only candidate"
        if best_ai.confidence > best_non_ai.confidence + 0.01:
            return (
                best_ai,
                f"AI override: {best_non_ai.layer.value} @ {best_non_ai.confidence:.2f} "
                f"→ AI @ {best_ai.confidence:.2f} reclassified as {best_ai.fault_type}",
            )

    assert best_non_ai is not None  # by construction (candidates non-empty)
    return (
        best_non_ai,
        f"highest confidence ({best_non_ai.confidence:.2f}) via {best_non_ai.layer.value}",
    )


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _severity_to_urgency(sev: Severity, days_to_fault: Optional[float]) -> str:
    """Map (severity, time-horizon) → the urgency strings the UI expects.

    The UI's existing tone mapping is:
        critical/urgent → alarm (red)
        soon → warn (amber)
        planned/monitoring → info / muted (blue/grey)
    """
    if sev == Severity.CRITICAL:
        return "critical"
    if sev == Severity.URGENT or (days_to_fault is not None and days_to_fault < 7):
        return "urgent"
    if days_to_fault is not None and days_to_fault < 30:
        return "soon"
    if sev == Severity.INFO:
        return "monitoring"
    return "planned"


def _humanise(fault_type: str) -> str:
    """Convert snake_case fault_type to a UI-friendly display string."""
    return " ".join(w.capitalize() for w in fault_type.split("_"))


# ──────────────────────────────────────────────────────────────────────────
# Confidence helpers — used by every layer
# ──────────────────────────────────────────────────────────────────────────


def rule_confidence(breach_magnitude: float, threshold: float, base: float = 0.75) -> float:
    """Compute a rule-layer confidence.

    Rules are inherently high-trust because they encode operator-validated
    physics. Confidence starts at a floor (default 0.75) and scales toward
    0.95 as the breach grows relative to the threshold.

    Examples:
    - actual at threshold → 0.75
    - actual 50% over threshold → 0.85
    - actual 100% over threshold → 0.95 (capped)
    """
    if threshold <= 0:
        return min(0.95, base + 0.20)
    overage = max(0.0, abs(breach_magnitude) - abs(threshold)) / abs(threshold)
    return min(0.95, base + 0.20 * min(1.0, overage))


def twin_confidence(residual: float, threshold: float, ceiling: float = 0.85) -> float:
    """Compute a twin-residual-layer confidence.

    Twin residuals are softer evidence than rules — model drift, sensor
    noise, edge cases all flow into the residual. Confidence ceiling is
    intentionally lower than rules.
    """
    if threshold <= 0:
        return 0.5
    ratio = abs(residual) / abs(threshold)
    return min(ceiling, 0.45 + 0.40 * min(1.0, (ratio - 1) / 2)) if ratio >= 1 else min(0.5, 0.30 + 0.20 * ratio)


def ml_confidence(softmax_probs: List[float]) -> float:
    """Confidence from a softmax distribution = max probability.

    Optionally we could subtract a margin (max - second), but for the
    cascade's purposes the bare max is the cleanest single number.
    """
    if not softmax_probs:
        return 0.0
    return float(max(softmax_probs))
