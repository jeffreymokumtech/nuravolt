"""
Deterministic fixture generator for the standalone BESS demo asset
"Boreas Storage Hub" — a 50 MW / 100 MWh LFP merchant battery in Yorkshire, UK.

Writes 9 JSONs under public/data/bess/boreas/ matching the schemas the
existing BessSection + new Revenue Cockpit components expect.

No randomness — re-running produces byte-identical files (modulo the
timestamps the existing API derives elsewhere).
"""

from __future__ import annotations

import json
import math
import os
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "bess" / "boreas"
OUT.mkdir(parents=True, exist_ok=True)

# --- Asset constants ---------------------------------------------------------
PLANT_ID = "boreas"
ASSET_ID = "bess-boreas-001"
ASSET_NAME = "Boreas Storage Hub"
CHEMISTRY = "LFP"
NOMINAL_POWER_KW = 50_000
NOMINAL_ENERGY_KWH = 100_000
MANUFACTURER = "Tesla"
MODEL = "Megapack 2 XL"
INSTALL_DATE = date(2024, 6, 15)
CURRENT_SOH = 0.963
CURRENT_SOC = 0.42

# Demo "today" — anchored to a recent point so the fixtures show fresh data.
# (The existing Ribera dispatch_schedule.json uses 2026-02-04; we align
# Boreas similarly so all four demo plants share a coherent reference frame.)
TODAY = date(2026, 5, 2)


def write_json(filename: str, data) -> None:
    path = OUT / filename
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  ✓ {filename}  ({path.stat().st_size:,} bytes)")


# --- 1. asset_info.json ------------------------------------------------------

def gen_asset_info() -> None:
    write_json("asset_info.json", {
        "asset_id": ASSET_ID,
        "plant_id": PLANT_ID,
        "name": ASSET_NAME,
        "chemistry": CHEMISTRY,
        "nominal_capacity_kwh": NOMINAL_ENERGY_KWH,
        "nominal_power_kw": NOMINAL_POWER_KW,
        "manufacturer": MANUFACTURER,
        "model": MODEL,
        "installation_date": INSTALL_DATE.isoformat(),
        "current_soh": CURRENT_SOH,
        "current_soc": CURRENT_SOC,
    })


# --- 2. soh_history.json -----------------------------------------------------

def gen_soh_history() -> None:
    # Monthly snapshots from commissioning to today. LFP fade rate ~1.6 pp/year
    # with mild seasonality (summer hot months drop faster).
    snapshots = []
    months = 0
    cur = INSTALL_DATE
    cycles = 0.0
    soh = 1.00
    while cur <= TODAY:
        # Annual fade allocated by month, slightly higher in Jul/Aug.
        month_seasonality = 1.0 + (0.4 if cur.month in (7, 8) else -0.05 * (cur.month in (1, 2, 12)))
        monthly_fade = (0.016 / 12) * month_seasonality
        soh = round(soh - monthly_fade, 5)
        cycles = round(cycles + 35 + (10 if cur.month in (1, 12, 7, 8) else 0), 1)
        source = "commissioning" if months == 0 else (
            "capacity_test" if months % 3 == 0 else "estimated"
        )
        snapshots.append({
            "date": cur.replace(day=1).isoformat() if months > 0 else cur.isoformat(),
            "soh": soh,
            "source": source,
            "cumulative_cycles": cycles,
        })
        # advance one month
        next_month = cur.month + 1
        next_year = cur.year + (1 if next_month > 12 else 0)
        next_month = ((next_month - 1) % 12) + 1
        cur = date(next_year, next_month, min(cur.day, 28))
        months += 1
    # Force the last snapshot to land on TODAY with the configured current SoH
    # so the dashboard "current" matches.
    snapshots.append({
        "date": TODAY.isoformat(),
        "soh": CURRENT_SOH,
        "source": "capacity_test",
        "cumulative_cycles": round(cycles + 12, 1),
    })
    write_json("soh_history.json", snapshots)


# --- 3. cycling_metrics.json ------------------------------------------------

def gen_cycling_metrics() -> None:
    # 30 days of daily metrics ending TODAY.
    daily = []
    cum = 770.0  # rough accumulated cycles at start of window
    for i in range(30):
        d = TODAY - timedelta(days=29 - i)
        # Realistic merchant pattern: weekends slightly lower throughput
        weekend = d.weekday() >= 5
        eq_cyc = round((0.9 if weekend else 1.15) + 0.08 * math.cos(i * 0.7), 2)
        cum = round(cum + eq_cyc, 1)
        energy_in = round(eq_cyc * 105_000, 0)
        energy_out = round(energy_in * (0.892 + 0.004 * math.sin(i * 0.3)), 0)
        rte = round(energy_out / energy_in, 3)
        avg_temp = round(20.5 + 4 * math.sin((d.timetuple().tm_yday - 60) / 365 * 2 * math.pi), 1)
        daily.append({
            "date": d.isoformat(),
            "equivalent_cycles": eq_cyc,
            "cumulative_cycles": cum,
            "energy_in_kwh": energy_in,
            "energy_out_kwh": energy_out,
            "avg_dod": round(0.62 + 0.05 * math.sin(i * 0.4), 2),
            "avg_c_rate": 0.42,
            "max_c_rate": round(0.55 + 0.02 * math.sin(i * 0.6), 2),
            "avg_temp_c": avg_temp,
            "max_temp_c": round(avg_temp + 4.5, 1),
            "round_trip_efficiency": rte,
            "high_soc_hours": round(0.4 + 0.3 * math.sin(i * 0.5), 1),
            "high_temp_hours": round(0.2 + 0.4 * math.sin((d.timetuple().tm_yday - 100) / 365 * 2 * math.pi), 1),
        })
    write_json("cycling_metrics.json", {
        "total_cycles": daily[-1]["cumulative_cycles"],
        "total_throughput_mwh": round(sum(d["energy_out_kwh"] for d in daily) / 1000 * 3, 1),
        "daily_metrics": daily,
    })


# --- 4. capacity_tests.json --------------------------------------------------

def gen_capacity_tests() -> None:
    tests = []
    for i, (offset_months, label, soh_target) in enumerate([
        (0, "commissioning", 1.000),
        (3, "quarterly", 0.992),
        (9, "quarterly", 0.982),
        (15, "quarterly", 0.973),
        (21, "quarterly", CURRENT_SOH),
    ]):
        d = INSTALL_DATE
        for _ in range(offset_months):
            next_month = d.month + 1
            next_year = d.year + (1 if next_month > 12 else 0)
            d = date(next_year, ((next_month - 1) % 12) + 1, min(d.day, 28))
        tests.append({
            "id": f"test-{i+1}",
            "test_date": d.isoformat() + "T00:00:00",
            "measured_capacity_kwh": int(round(NOMINAL_ENERGY_KWH * soh_target)),
            "soh_result": soh_target,
            "capacity_retention": soh_target,
            "test_type": label,
            "ambient_temp_c": [13.5, 17.0, 22.5, 9.0, 14.0][i],
            "c_rate_used": 0.2,
            "is_valid": True,
            "notes": [
                "Commissioning test — Tesla Megapack 2 XL string-level acceptance.",
                "Q1 2025 routine — within spec.",
                "Q3 2025 routine — slight summer-related fade noted.",
                "Q1 2026 routine — within spec.",
                "Q2 2026 routine — current state-of-health baseline.",
            ][i],
        })
    write_json("capacity_tests.json", tests)


# --- 5. warranty_status.json -------------------------------------------------

def gen_warranty_status() -> None:
    cycles_used = 850
    cycles_max = 6000
    years_used = (TODAY - INSTALL_DATE).days / 365.25
    years_remaining = round(15 - years_used, 1)
    soh_margin = round(CURRENT_SOH - 0.70, 4)
    write_json("warranty_status.json", {
        "asset_id": ASSET_ID,
        "snapshot_date": TODAY.isoformat(),
        "warranty_health": {
            "score": 88,
            "risk_level": "LOW",
            "component_scores": {
                "soh": 86,
                "cycles": 92,
                "time": 88,
                "efficiency": 84,
                "violations": 90,
            },
            "current_soh": CURRENT_SOH,
            "warranty_threshold": 0.70,
            "soh_margin": soh_margin,
            "cycles_used": cycles_used,
            "cycles_remaining": cycles_max - cycles_used,
            "years_remaining": years_remaining,
            "risk_factors": [
                "Two minor warranty events (C-rate excursion + SoC dwell) in the last 90 days — informational, not yet impacting warranty status.",
            ],
            "recommendation": "OK: Operating within warranty parameters. Monitor C-rate during DC low-frequency response activations.",
        },
        "warranty_terms": {
            "capacity_guarantee_pct": 0.70,
            "warranty_years": 15,
            "max_cycles": cycles_max,
            "max_throughput_mwh": 800_000,
            "min_rte": 0.86,
            "operating_temp_min_c": 0,
            "operating_temp_max_c": 50,
        },
    })


# --- 6. warranty_violations.json --------------------------------------------

def gen_warranty_violations() -> None:
    write_json("warranty_violations.json", [
        {
            "id": "v-boreas-001",
            "type": "C_RATE_EXCEED",
            "started_at": "2026-03-12T14:22:00Z",
            "ended_at": "2026-03-12T14:24:00Z",
            "duration_minutes": 2,
            "severity": "warning",
            "measured_value": 1.06,
            "threshold_value": 1.00,
            "unit": "C",
            "description": "Brief C-rate excursion during a Dynamic Containment Low-frequency response activation. Within OEM peak allowance window.",
            "is_resolved": True,
        },
        {
            "id": "v-boreas-002",
            "type": "SOC_HIGH_DWELL",
            "started_at": "2026-04-08T03:10:00Z",
            "ended_at": "2026-04-08T07:48:00Z",
            "duration_minutes": 278,
            "severity": "warning",
            "measured_value": 0.94,
            "threshold_value": 0.92,
            "unit": "fraction",
            "description": "SoC held above 92% for 4h38m after overnight wholesale charge — trader cancelled morning slot bid.",
            "is_resolved": True,
        },
    ])


# --- 7. dispatch_schedule.json ----------------------------------------------

def gen_dispatch_schedule() -> None:
    # 24h day-ahead schedule. GBP/MWh values reflective of recent NESO clearing.
    # Charge negative (drawing from grid), discharge positive.
    charge = [0]*24
    discharge = [0]*24
    soc = [0.40]*24
    # Morning trough charge (4 MW × 4 hours = 16 MWh)
    for h in range(2, 6):
        charge[h] = -8000
    # Evening peak discharge (35 MW for 4 hours = 140 MWh, capped at duration)
    for h in range(17, 21):
        discharge[h] = 25_000
    # Roll SoC
    s = 0.40
    for h in range(24):
        delta = (charge[h] + discharge[h]) * 0.92 / NOMINAL_ENERGY_KWH
        s = max(0.10, min(0.95, s - delta))
        soc[h] = round(s, 2)
    # Realistic UK day-ahead curve: low ~£35/MWh midday, peak ~£190 17-19h.
    prices = [62, 58, 55, 48, 45, 42, 48, 75, 95, 88, 65, 42, 35, 38, 52, 75, 110, 165, 195, 175, 140, 105, 82, 70]
    write_json("dispatch_schedule.json", {
        "schedule_date": TODAY.isoformat(),
        "horizon_hours": 24,
        "resolution_minutes": 60,
        "charge_schedule_kw": charge,
        "discharge_schedule_kw": discharge,
        "soc_schedule": soc,
        "price_forecast": prices,
        "expected_revenue_eur": 14_800.0,
        "degradation_cost_eur": 1_650.0,
        "net_revenue_eur": 13_150.0,
        "optimizer_type": "ancillary_stacked_lp",
        "status": "optimal",
        "expected_cycles": 1.4,
    })


# --- 8. ancillary_revenue_30d.json (NEW SCHEMA) -----------------------------

def gen_ancillary_revenue() -> None:
    """
    Per-day revenue split by service for the last 30 days.
    Calibrated to ~£25k/day average → £8.5M/year (~£170k/MW/year).
    """
    days = []
    for i in range(30):
        d = TODAY - timedelta(days=29 - i)
        weekday = d.weekday()
        weekend = weekday >= 5
        # Dynamic Containment dominant overnight + weekend low-demand
        dc = round(11_000 + 5_500 * math.cos((i + 3) * 0.4) + (2_000 if weekend else 0), -1)
        dm = round(2_400 + 1_100 * math.sin(i * 0.3), -1)
        dr = round(1_100 + 600 * math.cos(i * 0.5), -1)
        # BM utilization spikes on cold / stressed days (~every 5d)
        bm = round((4_500 if i % 6 == 0 else 1_400) + 800 * math.sin(i * 0.7), -1)
        cap = 1_500  # Capacity Market — flat daily share of annual payment
        # Wholesale arbitrage benefits high-spread days
        wholesale = round(800 + 600 * abs(math.sin(i * 0.4)), -1)
        total = dc + dm + dr + bm + cap + wholesale
        throughput = round(82 + 16 * math.sin(i * 0.4) + (8 if not weekend else 0), 1)
        rte = round(89.2 + 0.6 * math.sin(i * 0.2), 1)
        days.append({
            "date": d.isoformat(),
            "dynamic_containment_gbp": int(dc),
            "dynamic_moderation_gbp": int(dm),
            "dynamic_regulation_gbp": int(dr),
            "balancing_mechanism_gbp": int(bm),
            "capacity_market_gbp": int(cap),
            "wholesale_arbitrage_gbp": int(wholesale),
            "total_gbp": int(total),
            "throughput_mwh": throughput,
            "rte_pct": rte,
        })
    write_json("ancillary_revenue_30d.json", {"currency": "GBP", "days": days})


# --- 9. service_stack_utilization.json (NEW SCHEMA) -------------------------

def gen_service_stack_utilization() -> None:
    """
    Hourly share of MW dispatched across the 6 services. Real UK pattern:
    DC dominates overnight + low-demand hours; wholesale arbitrage spikes
    evening peak (17-21h); BM spikes during demand stress windows.
    """
    hours = []
    for h in range(24):
        # Time-of-day mix
        if 0 <= h <= 6:
            dc, dm, dr, bm, cap, ws = 0.62, 0.10, 0.07, 0.06, 0.10, 0.05
        elif 7 <= h <= 11:
            dc, dm, dr, bm, cap, ws = 0.45, 0.15, 0.10, 0.08, 0.10, 0.12
        elif 12 <= h <= 15:
            dc, dm, dr, bm, cap, ws = 0.40, 0.12, 0.10, 0.12, 0.10, 0.16
        elif 16 <= h <= 21:
            dc, dm, dr, bm, cap, ws = 0.20, 0.08, 0.05, 0.22, 0.10, 0.35
        else:  # 22-23h
            dc, dm, dr, bm, cap, ws = 0.50, 0.12, 0.10, 0.08, 0.10, 0.10
        hours.append({
            "hour": h,
            "share": {
                "dynamic_containment": dc,
                "dynamic_moderation": dm,
                "dynamic_regulation": dr,
                "balancing_mechanism": bm,
                "capacity_market": cap,
                "wholesale_arbitrage": ws,
            },
        })
    write_json("service_stack_utilization.json", {"hours": hours})


def main() -> None:
    print(f"Writing Boreas fixtures to {OUT.relative_to(ROOT)}/")
    gen_asset_info()
    gen_soh_history()
    gen_cycling_metrics()
    gen_capacity_tests()
    gen_warranty_status()
    gen_warranty_violations()
    gen_dispatch_schedule()
    gen_ancillary_revenue()
    gen_service_stack_utilization()
    print(f"\nDone. 9 files in {OUT}")


if __name__ == "__main__":
    main()
