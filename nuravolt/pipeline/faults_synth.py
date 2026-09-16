"""Synthesized enhanced fault detection for the dashboard faults page.

The live plant-classifications panel (ACUTE/DEGRADED/CHRONIC tiers) is computed
from the digital twin; but the demo's richer faults console also wants an RUL
queue, cascade attribution, health score and a maintenance schedule. Those need
a predictive fault model a freshly-onboarded plant doesn't have yet, so for
seeded/demo plants we synthesize a physically-plausible `faults_enhanced`
artifact keyed to the plant's own per-inverter soiling — dirtier inverters get a
soiling-loss fault, plus a deterministic sprinkle of long-horizon degradation
faults. Labeled source='synthetic'; real customers get the classifications-only
view + "model maturing" until a trained fault model ships.

    from nuravolt.pipeline.faults_synth import synthesize_faults
    synthesize_faults(conn, plant_id)   # writes the AnalysisArtifact
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import psycopg2.extras

from nuravolt.db.writer import write_artifact

MODEL_VERSION = "faults-synth-v1"

# (fault_type, display_name, unit, base repair cost EUR, base days-to-fault)
_PV_FAULTS = [
    ("SOILING_LOSS", "Soiling Performance Loss", "SR", 450, 45),
    ("STRING_DEGRADATION", "String Degradation", "%", 1200, 210),
    ("CONNECTOR_RESISTANCE", "Connector Resistance Rise", "mOhm", 350, 320),
    ("PID_DEGRADATION", "Potential-Induced Degradation", "%", 2600, 540),
    ("DIODE_FAILURE", "Bypass Diode Fault", "V", 180, 120),
]

_LAYERS = ["RULE", "TWIN_RESIDUAL", "ML_CLASSIFIER", "AI_OVERRIDE"]


def _rng(seed_str: str) -> Any:
    """Deterministic per-plant RNG (stdlib Random seeded on a stable hash)."""
    import random

    h = int(hashlib.sha256(seed_str.encode()).hexdigest()[:12], 16)
    return random.Random(h)


def _urgency_for_days(days: int) -> str:
    if days <= 0:
        return "critical"
    if days < 7:
        return "urgent"
    if days < 30:
        return "soon"
    if days < 180:
        return "planned"
    return "monitoring"


def _load_inverter_sr(conn, plant_id: str) -> List[Dict[str, Any]]:
    """Latest soiling ratio per inverter (device_id), with the plant's inverters."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            'SELECT i.external_id, g.name AS group_name '
            'FROM "InverterGroup" g JOIN "Inverter" i ON i.group_id = g.id '
            'WHERE g.plant_id = %s ORDER BY i.external_id',
            (plant_id,),
        )
        inverters = [dict(r) for r in cur.fetchall()]
        # Latest per-inverter SR from analysis_results (soiling domain).
        cur.execute(
            "SELECT DISTINCT ON (device_id) device_id, value "
            "FROM analysis_results "
            "WHERE plant_id = %s AND domain = 'soiling' AND metric = 'soiling_ratio' "
            "  AND device_id <> 'PLANT' AND time <= NOW() "
            "ORDER BY device_id, time DESC",
            (plant_id,),
        )
        sr_by_dev = {r["device_id"]: float(r["value"]) for r in cur.fetchall()}
    for inv in inverters:
        inv["sr"] = sr_by_dev.get(inv["external_id"], 0.97)
    return inverters


def synthesize_faults(conn, plant_id: str) -> Dict[str, Any]:
    """Generate + persist the `faults_enhanced` artifact for one plant."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT slug, asset_type, capacity_mw FROM "Plant" WHERE id = %s', (plant_id,))
        plant = cur.fetchone()
    if not plant:
        return {"rows_written": 0, "note": "plant not found"}
    asset_type = str(plant.get("asset_type") or "PV").upper()
    # BESS-only plants surface battery faults via /api/bess/faults; the PV faults
    # console isn't in their nav, so skip synthesis for them.
    if asset_type == "BESS":
        return {"faults": 0, "note": "bess plant — no PV fault synthesis"}

    rng = _rng(f"faults:{plant_id}")
    inverters = _load_inverter_sr(conn, plant_id)
    capacity_kw = float(plant.get("capacity_mw") or 1.0) * 1000.0
    tariff_eur_mwh = 65.0
    now = datetime.now(timezone.utc)

    predictive: List[Dict[str, Any]] = []
    rul: List[Dict[str, Any]] = []
    fault_id = 0

    for inv in inverters:
        dev = inv["external_id"]
        sr = float(inv["sr"])
        loss_pct = max(0.0, (1.0 - sr) * 100.0)
        faults_for_inv: List[tuple] = []

        # Soiling-driven fault when the inverter is meaningfully dirty.
        if loss_pct >= 6.0:
            days = int(max(3, 60 - loss_pct * 3))  # dirtier => sooner
            faults_for_inv.append(("SOILING_LOSS", days, sr, 0.92))
        # A deterministic sprinkle of long-horizon degradation faults.
        n_extra = rng.choices([0, 1, 2], weights=[6, 3, 1])[0]
        pool = [f for f in _PV_FAULTS if f[0] != "SOILING_LOSS"]
        rng.shuffle(pool)
        for ftype, _dn, _u, _c, base_days in pool[:n_extra]:
            days = int(base_days * rng.uniform(0.6, 1.4))
            faults_for_inv.append((ftype, days, None, None))

        for ftype, days, cur_val, thr in faults_for_inv:
            meta = next(f for f in _PV_FAULTS if f[0] == ftype)
            _, display, unit, base_cost, _bd = meta
            urgency = _urgency_for_days(days)
            # Energy at risk over the horizon (rough, tariff-priced).
            inv_kw = capacity_kw / max(1, len(inverters))
            daily_loss_kwh = inv_kw * 8.0 * (loss_pct / 100.0 if ftype == "SOILING_LOSS" else rng.uniform(0.01, 0.04))
            proj_loss = round(daily_loss_kwh * min(days, 90), 1)
            revenue = round(proj_loss / 1000.0 * tariff_eur_mwh, 2)
            repair = round(base_cost * rng.uniform(0.8, 1.3))
            layer = rng.choices(_LAYERS, weights=[3, 4, 3, 1])[0]
            fault_id += 1
            recommended = (
                "Schedule a cleaning" if ftype == "SOILING_LOSS"
                else "IV-curve trace the strings on this inverter; check connectors and isolation."
            )
            predictive.append({
                "id": f"pf-{plant_id[:8]}-{fault_id}",
                "fault_type": ftype,
                "display_name": display,
                "equipment_id": dev,
                "days_to_fault": days,
                "urgency": urgency,
                "recommended_action": recommended,
                "revenue_at_risk_eur": revenue,
                "classification_layer": layer,
                "evidence": (
                    f"SR {sr:.3f} ({loss_pct:.1f}% loss) sustained on {dev}"
                    if ftype == "SOILING_LOSS"
                    else f"Twin residual drift on {dev} over trailing window"
                ),
                "winner_reason": f"{layer} classifier, confidence {rng.uniform(0.7, 0.95):.2f}",
                "cascade_winning_confidence": round(rng.uniform(0.7, 0.95), 2),
                "asset_type": "PV",
                "bess_source": False,
                "is_reactive": days <= 0,
            })
            rul.append({
                "fault_type": ftype,
                "display_name": display,
                "days_to_fault": days,
                "confidence": round(rng.uniform(0.7, 0.95), 2),
                "current_value": round(cur_val if cur_val is not None else rng.uniform(1, 100), 3),
                "threshold": round(thr if thr is not None else rng.uniform(0.5, 90), 3),
                "unit": unit,
                "trend": round(rng.uniform(-0.5, 0.5), 3),
                "urgency": urgency,
                "recommended_action": recommended,
                "repair_cost_eur": repair,
                "estimated_date": (now + timedelta(days=days)).date().isoformat(),
                "projected_energy_loss_kwh": proj_loss,
                "revenue_at_risk_eur": revenue,
                "inverter_id": dev,
            })

    # Roll-ups.
    by_urg: Dict[str, Dict[str, float]] = {}
    counts = {"critical": 0, "urgent": 0, "soon": 0, "planned": 0, "monitoring": 0}
    for f in predictive:
        u = f["urgency"]
        counts[u] = counts.get(u, 0) + 1
        b = by_urg.setdefault(u, {"count": 0, "total_revenue_at_risk_eur": 0.0})
        b["count"] += 1
        b["total_revenue_at_risk_eur"] = round(b["total_revenue_at_risk_eur"] + f["revenue_at_risk_eur"], 2)

    total_loss_kwh = round(sum(r["projected_energy_loss_kwh"] for r in rul), 1)
    # Health: penalise by worst urgency + count.
    penalty = counts["critical"] * 18 + counts["urgent"] * 10 + counts["soon"] * 5 + counts["planned"] * 2
    health = max(40, 100 - penalty)
    health_status = "healthy" if health >= 85 else "degraded" if health >= 60 else "critical"

    layer_dist: Dict[str, int] = {}
    for f in predictive:
        layer_dist[f["classification_layer"]] = layer_dist.get(f["classification_layer"], 0) + 1
    ai_overrides = layer_dist.get("AI_OVERRIDE", 0)

    # Maintenance schedule: bucket the soonest faults into the next 7 days.
    next_7: List[Dict[str, Any]] = []
    for d in range(7):
        day = (now + timedelta(days=d)).date().isoformat()
        tasks = [
            {"asset": f["equipment_id"], "action": f["recommended_action"], "fault": f["display_name"]}
            for f in predictive
            if 0 <= f["days_to_fault"] - d < 1
        ]
        if tasks:
            next_7.append({"date": day, "tasks": tasks})
    total_repair = round(sum(r["repair_cost_eur"] for r in rul))
    total_saved = round(sum(f["revenue_at_risk_eur"] for f in predictive))

    payload = {
        "plant_id": plant["slug"],
        "generated_at": now.isoformat(),
        "summary": {
            "current_loss_kwh": round(total_loss_kwh * 0.1, 1),
            "projected_loss_kwh": total_loss_kwh,
            "currency": "EUR",
            "reactive_count": sum(1 for f in predictive if f["is_reactive"]),
            "predictive_count": len(predictive),
            "critical_count": counts["critical"],
            "urgent_count": counts["urgent"],
            "soon_count": counts["soon"],
            "planned_count": counts["planned"],
            "monitoring_count": counts["monitoring"],
        },
        "health_score": {"value": health, "status": health_status, "trend": "stable"},
        "urgency_summary": by_urg,
        "rul_predictions": rul,
        "predictive_faults": predictive,
        "cascade_summary": {
            "rows_classified": len(predictive),
            "layer_distribution": layer_dist,
            "ai_overrides": ai_overrides,
            "ai_override_rate": round(ai_overrides / len(predictive), 3) if predictive else 0.0,
        },
        "maintenance_schedule": {
            "next_7_days": next_7,
            "total_repair_cost_eur": total_repair,
            "total_revenue_saved_eur": total_saved,
            "roi_pct": round((total_saved / total_repair) * 100, 1) if total_repair else 0.0,
        },
    }

    write_artifact(plant_id, "faults_enhanced", payload, source="synthetic",
                   model_version=MODEL_VERSION, conn=conn)
    conn.commit()
    return {"faults": len(predictive), "health": health}
