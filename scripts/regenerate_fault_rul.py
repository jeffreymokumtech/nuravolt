#!/usr/bin/env python3
"""Regenerate fault_detection_enhanced.json RUL sections from real twin residuals.

Replaces the random demo predictions (generate_demo_fault_data.py) with
predictions derived from measured digital-twin residuals in analysis_daily:

- inverter_thermal:    trailing temperature residual + its trend
- string_degradation:  peer-relative DC-voltage deviation + its trend
- module_degradation:  sustained power loss with a mild voltage signature

Confidence uses the rul_models.py heuristic — distance-to-threshold x
prediction-horizon — capped at 0.9 (no labelled ground truth, no certainty).
bypass_diode is intentionally NOT generated: it needs hotspot/IR data we do
not have, and fabricating it would reintroduce false positives.

reactive_faults and loss_disaggregation in the existing file are preserved
(reactive history is real). Everything prediction-derived is recomputed.

Usage:
  .venv-temp/bin/python scripts/regenerate_fault_rul.py alpha ribera
"""

import json
import sys
from datetime import timedelta
from pathlib import Path
from statistics import median

import psycopg2

ROOT = Path(__file__).resolve().parent.parent

TEMP_THRESHOLD_C = 10.0      # thermal failure threshold (residual above twin)
TEMP_WATCH_C = 4.0           # start predicting above this residual
VOLT_THRESHOLD_PCT = 5.0     # string failure threshold (peer-relative |dV|)
VOLT_WATCH_PCT = 1.5
LOSS_THRESHOLD_PCT = 8.0     # module degradation escalation threshold
LOSS_WATCH_PCT = 4.0
MAX_HORIZON_DAYS = 180
SUN_HOURS = 5.5

DISPLAY = {
    "inverter_thermal": ("Inverter Thermal Stress", "°C above twin", 500,
                         "Inspect cooling path / fans; verify ventilation and derate settings."),
    "string_degradation": ("String Degradation", "% voltage deviation", 800,
                           "IV-curve trace the strings on this inverter; check connectors and isolation."),
    "module_degradation": ("Module Degradation", "% power loss", 1200,
                           "Sustained underperformance with voltage shift — schedule module-level inspection."),
}


def db():
    url = next(
        line.split("=", 1)[1].strip().strip('"')
        for line in open(ROOT / ".env")
        if line.startswith("DATABASE_URL")
    )
    return psycopg2.connect(url)


def fetch_signals(cur, slug):
    """Per-inverter trailing aggregates + 30d trends from analysis_daily."""
    cur.execute(
        """
        WITH plant AS (SELECT id FROM "Plant" WHERE slug = %s),
        latest AS (
          SELECT MAX(bucket) m FROM analysis_daily ad, plant
          WHERE ad.plant_id::text = plant.id::text AND domain='digitaltwin'
            AND device_id LIKE 'INV%%'
        ),
        daily AS (
          SELECT device_id, bucket::date AS day,
            AVG(CASE WHEN metric='power_ac_predicted' THEN avg_value END) p_pred,
            AVG(CASE WHEN metric='power_ac_actual' THEN avg_value END) p_act,
            AVG(CASE WHEN metric='temperature_actual' THEN avg_value END) t_act,
            AVG(CASE WHEN metric='temperature_predicted' THEN avg_value END) t_pred,
            AVG(CASE WHEN metric='voltage_dc_residual' THEN avg_value END) v_res,
            AVG(CASE WHEN metric='voltage_dc_actual' THEN avg_value END) v_act
          FROM analysis_daily ad, plant, latest
          WHERE ad.plant_id::text = plant.id::text AND domain='digitaltwin'
            AND device_id LIKE 'INV%%'
            AND bucket >= latest.m - interval '30 days'
          GROUP BY device_id, bucket::date
        )
        SELECT device_id, day, p_pred, p_act, t_act, t_pred, v_res, v_act,
               (SELECT m FROM latest) AS anchor
        FROM daily ORDER BY device_id, day
        """,
        (slug,),
    )
    rows = cur.fetchall()
    if not rows:
        return None, None

    anchor = rows[0][8]
    per_inv = {}
    for dev, day, p_pred, p_act, t_act, t_pred, v_res, v_act, _ in rows:
        per_inv.setdefault(dev, []).append(
            dict(day=day, p_pred=p_pred, p_act=p_act, t_act=t_act,
                 t_pred=t_pred, v_res=v_res, v_act=v_act)
        )

    def lin_slope(points):
        n = len(points)
        if n < 5:
            return 0.0
        xs = list(range(n))
        mx, my = sum(xs) / n, sum(p for p in points) / n
        denom = sum((x - mx) ** 2 for x in xs)
        if denom == 0:
            return 0.0
        return sum((x - mx) * (y - my) for x, y in zip(xs, points)) / denom

    sigs = {}
    for dev, days in per_inv.items():
        days = sorted(days, key=lambda d: d["day"])
        tail14 = days[-14:]

        temp_series = [d["t_act"] - d["t_pred"] for d in days
                       if d["t_act"] is not None and d["t_pred"] is not None]
        temp_dev14 = (sum((d["t_act"] - d["t_pred"]) for d in tail14
                          if d["t_act"] is not None and d["t_pred"] is not None) /
                      max(1, sum(1 for d in tail14 if d["t_act"] is not None and d["t_pred"] is not None)))

        v_pts = [(100.0 * d["v_res"] / d["v_act"]) for d in days
                 if d["v_res"] is not None and d["v_act"] not in (None, 0)]
        v_tail = [(100.0 * d["v_res"] / d["v_act"]) for d in tail14
                  if d["v_res"] is not None and d["v_act"] not in (None, 0)]
        v_dev14 = sum(v_tail) / len(v_tail) if v_tail else None

        losses = [100.0 * (d["p_pred"] - d["p_act"]) / d["p_pred"] for d in days
                  if d["p_pred"] and d["p_pred"] > 0 and d["p_act"] is not None]
        loss_tail = [100.0 * (d["p_pred"] - d["p_act"]) / d["p_pred"] for d in tail14
                     if d["p_pred"] and d["p_pred"] > 0 and d["p_act"] is not None]
        loss14 = sum(loss_tail) / len(loss_tail) if loss_tail else 0.0

        avg_power_kw = (sum(d["p_act"] for d in tail14 if d["p_act"] is not None) /
                        max(1, sum(1 for d in tail14 if d["p_act"] is not None)))

        sigs[dev] = dict(
            temp_dev=temp_dev14,
            temp_slope=lin_slope(temp_series),
            v_dev=v_dev14,
            v_slope=lin_slope(v_pts) if v_pts else 0.0,
            loss=loss14,
            loss_slope=lin_slope(losses) if losses else 0.0,
            avg_power_kw=avg_power_kw or 0.0,
        )
    return sigs, anchor


def confidence(distance_to_threshold, threshold, days_pred):
    """rul_models.py heuristic: distance x horizon, capped at 0.9."""
    if distance_to_threshold <= 0:
        return 0.9
    norm = min(1.0, distance_to_threshold / threshold)
    horizon = 1.0 - (days_pred / MAX_HORIZON_DAYS) * 0.3
    return round(max(0.3, min(0.9, (1.0 - norm * 0.4) * horizon)), 2)


def days_to(threshold, current, slope_per_day):
    if slope_per_day <= 1e-4:
        return None  # not trending toward the threshold
    return max(1, min(MAX_HORIZON_DAYS, round((threshold - current) / slope_per_day)))


def urgency_of(days):
    if days <= 3:
        return "critical"
    if days <= 7:
        return "urgent"
    if days <= 30:
        return "soon"
    if days <= 90:
        return "planned"
    return "monitoring"


def build_predictions(sigs, anchor, electricity_eur_mwh=65.0):
    # Peer-relative voltage: subtract the plant median so the twin's
    # systematic bias cancels.
    v_devs = [s["v_dev"] for s in sigs.values() if s["v_dev"] is not None]
    v_med = median(v_devs) if v_devs else 0.0

    preds = []
    for dev, s in sorted(sigs.items()):
        equip = dev.replace("INV ", "PV-")

        # Thermal: residual above watch level.
        if s["temp_dev"] > TEMP_WATCH_C:
            d = days_to(TEMP_THRESHOLD_C, s["temp_dev"], s["temp_slope"]) or MAX_HORIZON_DAYS
            preds.append(_pred(
                "inverter_thermal", equip, d,
                confidence(TEMP_THRESHOLD_C - s["temp_dev"], TEMP_THRESHOLD_C, d),
                round(s["temp_dev"], 1), TEMP_THRESHOLD_C,
                trend=round(s["temp_slope"], 3),
                power_kw=s["avg_power_kw"] * 0.05, anchor=anchor,
            ))

        # String degradation: peer-relative voltage shift.
        v_rel = (s["v_dev"] - v_med) if s["v_dev"] is not None else 0.0
        if abs(v_rel) > VOLT_WATCH_PCT:
            d = days_to(VOLT_THRESHOLD_PCT, abs(v_rel), abs(s["v_slope"])) or MAX_HORIZON_DAYS
            preds.append(_pred(
                "string_degradation", equip, d,
                confidence(VOLT_THRESHOLD_PCT - abs(v_rel), VOLT_THRESHOLD_PCT, d),
                round(v_rel, 2), VOLT_THRESHOLD_PCT,
                trend=round(s["v_slope"], 4),
                power_kw=s["avg_power_kw"] * max(0.0, s["loss"]) / 100.0, anchor=anchor,
            ))
            continue  # voltage shift explains the loss — don't double-report

        # Module degradation: sustained material loss, voltage near-neutral.
        if s["loss"] > LOSS_WATCH_PCT and abs(v_rel) <= VOLT_WATCH_PCT and s["loss_slope"] > 0:
            d = days_to(LOSS_THRESHOLD_PCT, s["loss"], s["loss_slope"]) or MAX_HORIZON_DAYS
            preds.append(_pred(
                "module_degradation", equip, d,
                confidence(LOSS_THRESHOLD_PCT - s["loss"], LOSS_THRESHOLD_PCT, d),
                round(s["loss"], 1), LOSS_THRESHOLD_PCT,
                trend=round(s["loss_slope"], 3),
                power_kw=s["avg_power_kw"] * s["loss"] / 100.0, anchor=anchor,
            ))
    return preds


def _pred(fault_type, equip, days, conf, current, threshold, trend, power_kw, anchor):
    name, unit, repair_cost, action = DISPLAY[fault_type]
    energy_day = max(0.0, power_kw) * SUN_HOURS
    return dict(
        fault_type=fault_type,
        display_name=name,
        equipment_id=equip,
        days_to_fault=int(days),
        confidence=conf,
        current_value=current,
        threshold=threshold,
        unit=unit,
        trend=trend,
        urgency=urgency_of(days),
        is_urgent=days <= 7,
        recommended_action=action,
        repair_cost_eur=repair_cost,
        estimated_date=(anchor + timedelta(days=int(days))).isoformat(),
        projected_power_loss_kw=round(max(0.0, power_kw), 2),
        projected_energy_loss_kwh=round(energy_day, 1),
        revenue_at_risk_eur=round(energy_day * int(days) * 65.0 / 1000.0),
    )


def rebuild_file(slug, preds, anchor):
    fp = ROOT / "public" / "data" / "faults" / slug / "fault_detection_enhanced.json"
    existing = json.loads(fp.read_text()) if fp.exists() else {}

    rul_predictions = [
        {**{k: v for k, v in p.items() if k not in ("equipment_id",)},
         "inverter_id": p["equipment_id"]}
        for p in preds
    ]
    predictive_faults = [
        {"id": f"PF-{i+1:04d}",
         **p,
         "equipment_name": p["equipment_id"]}
        for i, p in enumerate(preds)
    ]

    buckets = {}
    for p in preds:
        b = buckets.setdefault(p["urgency"], dict(count=0, total_revenue_at_risk_eur=0))
        b["count"] += 1
        b["total_revenue_at_risk_eur"] += p["revenue_at_risk_eur"]
    for u in ("critical", "urgent", "soon", "planned", "monitoring"):
        buckets.setdefault(u, dict(count=0, total_revenue_at_risk_eur=0))

    reactive = existing.get("reactive_faults", [])
    rul_penalty = min(30, 5 * sum(1 for p in preds if p["days_to_fault"] <= 30))
    fault_penalty = min(20, len(reactive))
    health = max(0, 100 - rul_penalty - fault_penalty)

    current_loss_kwh = round(sum(p["projected_energy_loss_kwh"] for p in preds), 1)
    projected_loss_kwh = round(sum(
        p["projected_energy_loss_kwh"] * p["days_to_fault"] for p in preds), 1)

    schedule_days = []
    for offset in range(7):
        day = (anchor + timedelta(days=offset)).date().isoformat()
        tasks = [
            dict(fault_type=p["fault_type"], inverter_id=p["equipment_id"],
                 priority_score=round(100 - p["days_to_fault"] * 3 + p["confidence"] * 10))
            for p in preds if p["days_to_fault"] <= offset + 1
        ][:3]
        schedule_days.append(dict(date=day, tasks=tasks))
    total_repair = sum(p["repair_cost_eur"] for p in preds)
    total_saved = sum(p["revenue_at_risk_eur"] for p in preds)

    out = {
        **existing,
        "plant_id": slug,
        "generated_at": anchor.isoformat(),
        "generator": "scripts/regenerate_fault_rul.py — derived from analysis_daily twin residuals",
        "summary": {
            **existing.get("summary", {}),
            "current_loss_kwh": current_loss_kwh,
            "projected_loss_kwh": projected_loss_kwh,
            "current_loss_value": round(current_loss_kwh * 65.0 / 1000.0),
            "projected_loss_value": round(projected_loss_kwh * 65.0 / 1000.0),
            "currency": "EUR",
            "reactive_count": len(reactive),
            "predictive_count": len(preds),
            "critical_count": buckets["critical"]["count"],
            "urgent_count": buckets["urgent"]["count"],
            "soon_count": buckets["soon"]["count"],
            "planned_count": buckets["planned"]["count"],
            "monitoring_count": buckets["monitoring"]["count"],
        },
        "health_score": {
            "value": health,
            # Must match HealthScoreCard's HealthStatus enum.
            "status": ("healthy" if health >= 80 else
                       "attention_needed" if health >= 60 else
                       "degraded" if health >= 40 else "critical"),
            "anomaly_penalty": 0,
            "fault_penalty": fault_penalty,
            "rul_penalty": rul_penalty,
            "trend": "stable",
        },
        "rul_predictions": rul_predictions,
        "urgency_summary": buckets,
        "maintenance_schedule": {
            "next_7_days": schedule_days,
            "total_repair_cost_eur": total_repair,
            "total_revenue_saved_eur": total_saved,
            "roi_pct": round(100.0 * (total_saved - total_repair) / total_repair, 1)
            if total_repair > 0 else 0.0,
        },
        "predictive_faults": predictive_faults,
    }
    fp.write_text(json.dumps(out, indent=2))
    return fp


def main():
    slugs = sys.argv[1:] or ["alpha", "ribera"]
    conn = db()
    cur = conn.cursor()
    for slug in slugs:
        sigs, anchor = fetch_signals(cur, slug)
        if not sigs:
            print(f"{slug}: no twin data in analysis_daily — skipped")
            continue
        preds = build_predictions(sigs, anchor)
        fp = rebuild_file(slug, preds, anchor)
        by_type = {}
        for p in preds:
            by_type[p["fault_type"]] = by_type.get(p["fault_type"], 0) + 1
        print(f"{slug}: {len(preds)} predictions {by_type} -> {fp.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
