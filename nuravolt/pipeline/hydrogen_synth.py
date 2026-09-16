"""Electrolyzer digital-twin synthesis: asset, production and stack health.

The hydrogen counterpart of nuravolt/pipeline/bess_intelligence.py (asset
creation being the bess_assets.py half). For HYDROGEN plants it creates
(idempotently, keyed on the schema's unique constraints):

  H2Asset             one per plant (rated power = plant capacity)
  H2ProductionRecord  daily price-responsive production: the electrolyzer
                      runs the cheapest hours of the day-ahead curve
                      (market_prices; synthetic until an ENTSOE_TOKEN
                      exists), producing H2 at the load- and age-dependent
                      SEC from nuravolt.hydrogen.electrolyzer
  H2StackHealth       monthly SEC / efficiency / RUL points

Until real electrolyzer telemetry is connected this IS the provisional
hydrogen twin; real data replaces the synthesized rows through the same
unique keys.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from typing import Any, Dict

import psycopg2.extras

from nuravolt.hydrogen.electrolyzer import (
    ElectrolyzerSpec,
    specific_consumption_kwh_per_kg,
    stack_efficiency_pct,
    stack_rul_hours,
)
from nuravolt.pipeline.market_prices import day_ahead_curve, price_source

# Merchant green-H2 price assumption (EUR/kg) — documented, replace with a
# contract price once one exists.
H2_PRICE_EUR_PER_KG = 5.5
# Run the electrolyzer during this many cheapest hours per day.
RUN_HOURS_PER_DAY = 12
# Assumed prior operation when synthesizing from scratch.
INITIAL_STACK_HOURS = 4000.0
WATER_L_PER_KG_H2 = 10.0  # ~9 L stoichiometric + purification reject


def ensure_h2_asset(conn, plant: Dict[str, Any]) -> Dict[str, Any]:
    """Find or create the plant's H2Asset."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute('SELECT * FROM "H2Asset" WHERE plant_id = %s LIMIT 1', (plant["id"],))
        row = cur.fetchone()
        if row:
            return dict(row)

        rated_kw = float(plant["capacity_mw"]) * 1000.0
        spec = ElectrolyzerSpec(rated_power_kw=rated_kw)
        rated_kg_h = rated_kw / spec.sec_bol_kwh_per_kg
        asset_id = str(uuid.uuid4())
        cur.execute(
            'INSERT INTO "H2Asset" (id, plant_id, external_asset_id, name, technology, '
            ' rated_power_kw, stack_count, rated_kg_per_h, sec_bol_kwh_per_kg, '
            ' manufacturer, model, current_sec_kwh_per_kg, stack_hours, enabled, '
            ' created_at, updated_at, metadata) '
            "VALUES (%s, %s, %s, %s, 'PEM', %s, %s, %s, %s, %s, %s, %s, %s, true, NOW(), NOW(), %s) "
            "RETURNING *",
            (
                asset_id,
                plant["id"],
                f"H2-{plant['slug']}",
                f"{plant.get('name', plant['slug'])} electrolyzer",
                rated_kw,
                max(1, int(rated_kw // 1250)),  # ~1.25 MW PEM stacks
                round(rated_kg_h, 2),
                52.5,
                "Generic",
                "PEM MW Class",
                52.5,
                INITIAL_STACK_HOURS,
                json.dumps({"synthesized": True}),
            ),
        )
        created = dict(cur.fetchone())
    conn.commit()
    return created


def synthesize_h2_history(conn, plant: Dict[str, Any], days: int = 30) -> Dict[str, Any]:
    """Price-responsive production + stack-health history for the plant."""
    asset = ensure_h2_asset(conn, plant)
    rated_kw = float(asset["rated_power_kw"])
    spec = ElectrolyzerSpec(rated_power_kw=rated_kw, sec_bol_kwh_per_kg=float(asset["sec_bol_kwh_per_kg"]))
    stack_hours = float(asset["stack_hours"] or INITIAL_STACK_HOURS)

    start = date.today() - timedelta(days=days)
    total_kg = 0.0

    with conn.cursor() as cur:
        for i in range(days + 1):
            day = start + timedelta(days=i)
            if day > date.today():
                break
            curve = day_ahead_curve(day)
            prices = curve["prices_eur_mwh"]
            cheapest = sorted(range(24), key=lambda h: prices[h])[:RUN_HOURS_PER_DAY]

            # Run at rated power in the cheap hours (PEM ramps in seconds, so
            # block operation at rated is the economic baseline).
            load = 1.0
            sec = specific_consumption_kwh_per_kg(load, stack_hours, spec)
            kg = rated_kw * len(cheapest) / sec
            energy_kwh = rated_kw * len(cheapest)
            power_cost = sum(prices[h] for h in cheapest) * rated_kw / 1000.0
            revenue = kg * H2_PRICE_EUR_PER_KG
            stack_hours += len(cheapest)
            total_kg += kg

            cur.execute(
                'INSERT INTO "H2ProductionRecord" (id, asset_id, production_date, energy_in_kwh, '
                ' h2_out_kg, hours_run, avg_load_pct, sec_kwh_per_kg, water_l, '
                ' h2_price_eur_per_kg, revenue_eur, power_cost_eur, net_margin_eur, created_at) '
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()) "
                'ON CONFLICT (asset_id, production_date) DO UPDATE SET '
                ' energy_in_kwh = EXCLUDED.energy_in_kwh, h2_out_kg = EXCLUDED.h2_out_kg, '
                ' hours_run = EXCLUDED.hours_run, sec_kwh_per_kg = EXCLUDED.sec_kwh_per_kg, '
                ' revenue_eur = EXCLUDED.revenue_eur, power_cost_eur = EXCLUDED.power_cost_eur, '
                ' net_margin_eur = EXCLUDED.net_margin_eur',
                (
                    str(uuid.uuid4()), asset["id"], day,
                    round(energy_kwh, 1), round(kg, 2), len(cheapest),
                    round(load * 100, 1), round(sec, 2), round(kg * WATER_L_PER_KG_H2, 1),
                    H2_PRICE_EUR_PER_KG, round(revenue, 2), round(power_cost, 2),
                    round(revenue - power_cost, 2),
                ),
            )

        # Stack-health point (idempotent per asset+date).
        sec_now = specific_consumption_kwh_per_kg(1.0, stack_hours, spec)
        rul = stack_rul_hours(stack_hours, sec_now, spec.sec_bol_kwh_per_kg)
        eff = stack_efficiency_pct(sec_now)
        health = max(0.0, min(100.0, 100.0 * (1.0 - (sec_now - spec.sec_bol_kwh_per_kg) / (spec.sec_bol_kwh_per_kg * 0.10))))
        cur.execute(
            'INSERT INTO "H2StackHealth" (id, asset_id, measured_at, stack_hours, sec_kwh_per_kg, '
            ' efficiency_hhv_pct, est_rul_hours, health_pct, created_at) '
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW()) "
            'ON CONFLICT (asset_id, measured_at) DO UPDATE SET '
            ' stack_hours = EXCLUDED.stack_hours, sec_kwh_per_kg = EXCLUDED.sec_kwh_per_kg, '
            ' efficiency_hhv_pct = EXCLUDED.efficiency_hhv_pct, est_rul_hours = EXCLUDED.est_rul_hours, '
            ' health_pct = EXCLUDED.health_pct',
            (
                str(uuid.uuid4()), asset["id"], date.today(),
                round(stack_hours, 1), round(sec_now, 2), round(eff, 2),
                round(rul, 0), round(health, 1),
            ),
        )
        cur.execute(
            'UPDATE "H2Asset" SET current_sec_kwh_per_kg = %s, stack_hours = %s, updated_at = NOW() WHERE id = %s',
            (round(sec_now, 2), round(stack_hours, 1), asset["id"]),
        )
    conn.commit()

    return {
        "asset_id": asset["id"],
        "days": days,
        "total_kg": round(total_kg, 1),
        "sec_now": round(sec_now, 2),
        "rul_hours": round(rul, 0),
        "price_source": price_source(),
    }
