#!/usr/bin/env python3
"""Deepen the BESS demo fixtures from 30 days to ~13 months.

Rebuilds cycling_metrics.json daily_metrics (same field set, same value
texture as the existing 30-day tail) over ~395 days ending at the fixture's
current last date, and reconciles cumulative_cycles with soh_history.json —
the two files previously disagreed (cycling said ~53 cumulative cycles in
Jan-2026, SoH said ~600). SoH history gets appended up to the cycling end so
month-over-month capacity fade and cycles-per-month tie out on the console.

Deterministic per plant (seeded). Run:
    python scripts/generate_bess_fixture_history.py
"""

import json
import math
import random
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE_DIRS = [
    REPO / "public/data/bess",
    REPO / "public/data/showcase/bess",
]
TARGET_DAYS = 395


def seasonal_temp(d: date, rng: random.Random) -> float:
    doy = d.timetuple().tm_yday
    base = 20 + 8 * math.cos(2 * math.pi * (doy - 200) / 365)
    return base + rng.gauss(0, 1.6)


def rebuild_plant(plant_dir: Path) -> None:
    cyc_path = plant_dir / "cycling_metrics.json"
    soh_path = plant_dir / "soh_history.json"
    if not cyc_path.exists():
        return
    cycling = json.loads(cyc_path.read_text())
    daily = cycling.get("daily_metrics") or []
    if not daily:
        return
    soh = json.loads(soh_path.read_text()) if soh_path.exists() else []

    rng = random.Random(f"bess-history-{plant_dir.name}")
    end = date.fromisoformat(daily[-1]["date"])
    start = end - timedelta(days=TARGET_DAYS - 1)

    # Texture anchors from the existing tail.
    def mean(key, default):
        vals = [r.get(key) for r in daily if isinstance(r.get(key), (int, float))]
        return sum(vals) / len(vals) if vals else default

    m_cycles = mean("equivalent_cycles", 0.9)
    m_dod = mean("avg_dod", 0.7)
    m_crate = mean("avg_c_rate", 0.27)
    m_rte = mean("round_trip_efficiency", 0.885)
    # Usable capacity implied by the tail: energy_out per equivalent cycle.
    m_out = mean("energy_out_kwh", 2700.0)
    cap_kwh = m_out / max(0.2, m_cycles)

    # RTE fades slowly with age: older days sit slightly above today's mean.
    RTE_FADE_PER_YEAR = 0.008

    new_daily = []
    cumulative = 0.0
    weather = 0.0
    total_out_kwh = 0.0
    for i in range(TARGET_DAYS):
        d = start + timedelta(days=i)
        days_back = (end - d).days
        weather = 0.55 * weather + rng.gauss(0, 0.06)
        # Market-driven duty: some days cycle harder than others.
        duty = max(0.25, min(1.35, 1 + weather + rng.gauss(0, 0.10)))
        eq_cycles = round(m_cycles * duty, 3)
        dod = round(max(0.35, min(0.95, m_dod + weather * 0.15 + rng.gauss(0, 0.03))), 3)
        c_rate = round(max(0.1, m_crate + rng.gauss(0, 0.02)), 2)
        rte = round(
            min(0.97, m_rte + RTE_FADE_PER_YEAR * (days_back / 365) + rng.gauss(0, 0.004)), 3
        )
        out_kwh = round(eq_cycles * cap_kwh, 1)
        in_kwh = round(out_kwh / rte, 1)
        temp = seasonal_temp(d, rng)
        cumulative += eq_cycles
        total_out_kwh += out_kwh
        new_daily.append(
            {
                "date": d.isoformat(),
                "equivalent_cycles": eq_cycles,
                "cumulative_cycles": round(cumulative, 1),
                "energy_in_kwh": in_kwh,
                "energy_out_kwh": out_kwh,
                "avg_dod": dod,
                "avg_c_rate": c_rate,
                "max_c_rate": round(min(1.0, c_rate * (2.4 + rng.gauss(0, 0.2))), 2),
                "avg_temp_c": round(temp, 1),
                "max_temp_c": round(temp + 4.5 + rng.gauss(0, 0.8), 1),
                "round_trip_efficiency": rte,
                "high_soc_hours": round(max(0, rng.gauss(1.5, 0.8)), 1),
                "high_temp_hours": round(max(0, (temp - 24) * 0.4 + rng.gauss(0, 0.4)), 1),
            }
        )

    cycling["daily_metrics"] = new_daily
    cycling["total_cycles"] = round(cumulative, 1)
    cycling["total_throughput_mwh"] = round(total_out_kwh / 1000, 1)
    cyc_path.write_text(json.dumps(cycling, indent=1))

    # Reconcile SoH: keep the existing (older, capacity-test anchored) points
    # but rebase their cumulative_cycles onto the rebuilt cycling series, and
    # append monthly points up to the cycling end so fade-per-month closes.
    if soh:
        by_date = {r["date"]: r["cumulative_cycles"] for r in new_daily}
        daily_dates = sorted(by_date)

        def cycles_at(day_iso: str) -> float:
            if day_iso <= daily_dates[0]:
                return 0.0
            prior = [d for d in daily_dates if d <= day_iso]
            return by_date[prior[-1]] if prior else 0.0

        for point in soh:
            point["cumulative_cycles"] = round(cycles_at(point["date"]), 1)

        last_soh_date = date.fromisoformat(soh[-1]["date"])
        last_soh = soh[-1]["soh"]
        # Fade rate implied by the recent SoH trend (pp per cycle).
        recent = soh[-6:]
        span_cycles = max(1.0, soh[-1]["cumulative_cycles"] - recent[0]["cumulative_cycles"])
        fade_per_cycle = max(0.0, (recent[0]["soh"] - last_soh) / span_cycles)
        cursor = last_soh_date
        while cursor + timedelta(days=30) <= end:
            cursor = cursor + timedelta(days=30)
            cyc = cycles_at(cursor.isoformat())
            delta_c = cyc - cycles_at((cursor - timedelta(days=30)).isoformat())
            last_soh = round(last_soh - fade_per_cycle * delta_c + rng.gauss(0, 0.0004), 4)
            soh.append(
                {
                    "date": cursor.isoformat(),
                    "soh": last_soh,
                    "source": "estimated",
                    "cumulative_cycles": round(cyc, 1),
                }
            )
        soh_path.write_text(json.dumps(soh, indent=1))

    print(
        f"{plant_dir}: {len(new_daily)} daily records "
        f"({new_daily[0]['date']} → {new_daily[-1]['date']}), "
        f"{cycling['total_cycles']} cycles, soh points: {len(soh)}"
    )


def main():
    for root in FIXTURE_DIRS:
        if not root.exists():
            continue
        for plant_dir in sorted(root.iterdir()):
            if plant_dir.is_dir():
                rebuild_plant(plant_dir)


if __name__ == "__main__":
    main()
