#!/usr/bin/env python3
"""Enrich every plant's ``fault_detection_enhanced.json`` with cascade
classification metadata.

For each existing fault row (in ``rul_predictions`` and
``predictive_faults``), runs ``cascade_attribution.attribute_layers()``
against the raw signals (current_value, threshold, confidence, trend) to
derive:

- ``classification_layer`` — which cascade layer fired
- ``evidence`` — human-readable rationale
- ``numeric_evidence`` — structured key-value form
- ``layer_chain`` — full audit trail
- ``winner_reason`` — why this candidate won

Backward compatible: every existing field stays untouched. New fields are
additive. The UI's existing consumers keep working; the updated UI
surfaces the cascade fields.

Usage:
    python scripts/regenerate_all_faults.py               # all plants
    python scripts/regenerate_all_faults.py ribera     # subset
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_dotenv(path: Path) -> None:
    """Tiny .env loader. We avoid the python-dotenv dependency for one use."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nuravolt.fault.cascade_attribution import attribute_layers  # noqa: E402
from nuravolt.fault.fault_record import (  # noqa: E402
    FaultRecord,
    ClassificationLayer,
)

FAULTS_ROOT = REPO_ROOT / "public" / "data" / "faults"

# Module-level holder for the AI classifier so all enrich_fault_row calls
# in one regen run share the cache + stats counter.
_AI_CLASSIFIER = None


def get_ai_classifier(enabled: bool, demo_mode: bool = False):
    """Lazy-init the BedrockFaultClassifier. Returns None if disabled
    or import fails (graceful — the cascade falls back to synthetic AI).

    ``demo_mode=True`` lowers the triage floors so demo faults (which
    typically have €0-5 revenue at risk) can trigger Bedrock at all.
    Production defaults (€100 revenue floor, 30-day horizon) stay
    appropriate for live plants.
    """
    global _AI_CLASSIFIER
    if not enabled:
        return None
    if _AI_CLASSIFIER is not None:
        return _AI_CLASSIFIER
    try:
        from nuravolt.fault.ai_classifier import BedrockFaultClassifier, TriageConfig
        triage = None
        if demo_mode:
            triage = TriageConfig(
                min_confidence=0.50,
                max_days_to_fault=60.0,
                min_revenue_at_risk_eur=0.0,
                allowed_urgencies=frozenset({"critical", "urgent", "soon", "high", "warning", "planned", "monitoring"}),
            )
            print("  [AI] demo mode: triage floors lowered (€0 revenue, all urgencies)")
        _AI_CLASSIFIER = BedrockFaultClassifier(triage=triage)
        print(f"  [AI] Bedrock classifier active: model={_AI_CLASSIFIER.model_id}, region={_AI_CLASSIFIER.region}")
    except Exception as e:
        print(f"  [AI] disabled (init failed): {type(e).__name__}: {e}")
        _AI_CLASSIFIER = None
    return _AI_CLASSIFIER


def enrich_fault_row(row: Dict[str, Any], ai_classifier=None) -> Dict[str, Any]:
    """Apply cascade attribution to a single fault row and merge the
    cascade fields into the existing row.

    Idempotent: re-running on an already-enriched row produces the same
    output (assuming AI classifier disabled or cache warm).
    """
    fault_type = row.get("fault_type")
    if not fault_type:
        return row

    equipment_id = (
        row.get("equipment_id")
        or row.get("inverter_id")
        or row.get("string_id")
        or "unknown"
    )

    chain, winner, reason = attribute_layers(
        fault_type=fault_type,
        equipment_id=equipment_id,
        current_value=row.get("current_value"),
        threshold=row.get("threshold"),
        confidence=row.get("confidence"),
        trend=row.get("trend"),
        unit=row.get("unit"),
        days_to_fault=row.get("days_to_fault"),
        urgency=row.get("urgency"),
        revenue_at_risk_eur=row.get("revenue_at_risk_eur"),
        ai_classifier=ai_classifier,
    )

    record = FaultRecord.from_winning_candidate(
        winner, chain, reason,
        recommended_action=row.get("recommended_action", ""),
        revenue_at_risk_eur=float(row.get("revenue_at_risk_eur", 0) or 0),
        projected_energy_loss_kwh=float(row.get("projected_energy_loss_kwh", 0) or 0),
    )
    legacy = record.to_legacy_dict()

    # Merge into the existing row. Original fields are authoritative for
    # operator-facing values that already have stable meaning; cascade
    # fields are added.
    enriched = dict(row)  # keep originals
    for key in [
        "classification_layer",
        "evidence",
        "numeric_evidence",
        "winner_reason",
        "layer_chain",
        "severity",
        "asset_type",
    ]:
        enriched[key] = legacy[key]

    # Promote fault_type if AI reclassified — but keep the original under
    # `fault_type_original` so the operator can see both.
    if winner.fault_type != fault_type:
        enriched["fault_type_original"] = fault_type
        enriched["fault_type_reclassified"] = winner.fault_type
        enriched["display_name"] = legacy["display_name"]
        # Don't overwrite fault_type — keeping the original means existing
        # downstream consumers (ticketing, optimizer) see no surprise.
        # The UI shows reclassified label via fault_type_reclassified.

    # Promote confidence if AI is more confident
    if winner.confidence > (row.get("confidence") or 0):
        enriched["confidence_cascade"] = legacy["confidence"]
    enriched["cascade_winning_confidence"] = legacy["confidence"]

    return enriched


def enrich_plant(plant_id: str, ai_classifier=None) -> Dict[str, Any]:
    """Enrich one plant's fault JSON in place and return a stats report."""
    fp = FAULTS_ROOT / plant_id / "fault_detection_enhanced.json"
    if not fp.exists():
        return {"plant_id": plant_id, "error": "no fault file"}

    data = json.loads(fp.read_text())
    layer_counter: Counter = Counter()
    ai_overrides = 0
    rows_enriched = 0

    for key in ("rul_predictions", "predictive_faults"):
        rows = data.get(key)
        if not isinstance(rows, list):
            continue
        for i, row in enumerate(rows):
            enriched = enrich_fault_row(row, ai_classifier=ai_classifier)
            rows[i] = enriched
            rows_enriched += 1
            layer = enriched.get("classification_layer")
            if layer:
                layer_counter[layer] += 1
            if enriched.get("classification_layer") == "AI_OVERRIDE":
                ai_overrides += 1

    # Add a cascade summary block at the top level so the UI / API can
    # display the "n RULE · n TWIN · n ML · n AI" stat without iterating.
    data["cascade_summary"] = {
        "rows_classified": rows_enriched,
        "layer_distribution": dict(layer_counter),
        "ai_overrides": ai_overrides,
        "ai_override_rate": round(ai_overrides / rows_enriched, 3) if rows_enriched else 0,
    }
    data["generated_at"] = data.get("generated_at")  # keep existing
    data["cascade_generated_at"] = __import__("datetime").datetime.utcnow().isoformat()

    fp.write_text(json.dumps(data, indent=2))
    return {
        "plant_id": plant_id,
        "rows_enriched": rows_enriched,
        "layer_distribution": dict(layer_counter),
        "ai_overrides": ai_overrides,
    }


def main() -> int:
    argv = sys.argv[1:]
    # Parse flags
    ai_enabled = "--ai" in argv or os.getenv("NURAVOLT_AI_CLASSIFY_ENABLED", "").lower() in {"1", "true", "yes"}
    demo_mode = "--demo" in argv or os.getenv("NURAVOLT_AI_DEMO_MODE", "").lower() in {"1", "true", "yes"}
    plants = [a for a in argv if not a.startswith("--")]
    if not plants:
        plants = sorted([p.name for p in FAULTS_ROOT.iterdir() if p.is_dir()])

    # Propagate demo flag to cascade_attribution module
    if demo_mode:
        os.environ["NURAVOLT_AI_DEMO_MODE"] = "1"

    print("=" * 60)
    print("Cascade fault classification — backfill")
    print("=" * 60)
    print(f"Plants ({len(plants)}): {plants}")
    print(f"AI Override layer: {'ENABLED (Bedrock)' if ai_enabled else 'SYNTHETIC (no LLM calls)'}")
    if demo_mode:
        print("Demo mode: triage floors lowered + AI invocation threshold 0.85")

    # Load .env so AWS creds are present when AI is enabled
    if ai_enabled:
        _load_dotenv(REPO_ROOT / ".env")

    ai_classifier = get_ai_classifier(ai_enabled, demo_mode=demo_mode)

    reports = []
    for plant_id in plants:
        try:
            r = enrich_plant(plant_id, ai_classifier=ai_classifier)
            reports.append(r)
        except Exception as e:
            print(f"  ✗ {plant_id}: {e}")
            import traceback
            traceback.print_exc()

    print(f"\n{'=' * 60}")
    print("VALIDATION REPORT")
    print(f"{'=' * 60}")
    for r in reports:
        if "error" in r:
            print(f"  ✗ {r['plant_id']}: {r['error']}")
            continue
        dist = r["layer_distribution"]
        line = "  ".join(f"{k}={v}" for k, v in sorted(dist.items()))
        print(
            f"  • {r['plant_id']:14s}  {r['rows_enriched']:3d} rows  →  {line}  "
            f"(AI overrides: {r['ai_overrides']})"
        )

    # Bedrock activity report (if AI was active)
    if ai_classifier is not None:
        print(f"\n{'=' * 60}")
        print("BEDROCK ACTIVITY")
        print(f"{'=' * 60}")
        stats = ai_classifier.stats_dict()
        for k, v in stats.items():
            print(f"  {k}: {v}")
        if stats["input_tokens"] + stats["output_tokens"]:
            est_cost = (stats["input_tokens"] * 0.0008 + stats["output_tokens"] * 0.004) / 1000
            print(f"  estimated cost: ~${est_cost:.4f} (rough)")

    print(f"\n{'=' * 60}")
    print("Done")
    print(f"{'=' * 60}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
