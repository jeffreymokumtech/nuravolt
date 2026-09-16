#!/usr/bin/env python3
"""Build the static soiling artifacts for the shared demo plant kilima-solar.

The dashboard's flagship soiling surfaces read static files under
public/data/soiling/<slug>/ (see sr-estimate + cleaning-schedule routes and
CleaningOptimizerTab's context fetches). Those artifacts only exist for the
research donors (ribera/alpha), so the demo plant gets donor-derived
specimens:

- per_inverter/kilima-solar_per_inverter_sr.json: ribera's 120 measured
  per-inverter SR series aggregated into 24 fleet inverters (INV-01..24,
  matching the seeded registry), calendar-shifted so the series ends
  yesterday. The dirtiest aggregate is assigned to INV-03 so it lines up with
  the seeded DB story (seed_e2e_demo_data makes the third inverter foul ~2.5x
  faster and opens the soiling ticket on it).
- operator_proposal.json + cleaning_comparison.json: alpha' optimizer
  output rescaled from 9.0 MW to 6.0 MW with conservative economics
  (~450 MWh/yr recovered, 65 EUR/MWh, 3600 EUR per cleaning) and cleaning
  dates moved into Kenya's dry seasons.
- rain_history.json: REAL Open-Meteo archive daily precipitation for the
  plant's own coordinates (Athi River shows its true bimodal MAM/OND rains).
- aod_history.json: REAL Open-Meteo air-quality (CAMS) daily PM10/PM2.5/
  dust/AOD means for the same coordinates.
- dustiq_history.json: fleet-mean SR series derived from the per-inverter
  specimen above (no physical DustIQ exists at this site; metadata says so).
- ml_forecast_365d.json: ribera donor curve, calendar-shifted, labeled a
  transfer specimen; climate_zone = EQUATORIAL_EAST_AFRICA (bimodal prior in
  nuravolt/soiling/climate_regions.py).

Provenance blocks are relabeled accordingly. Idempotent: re-running
overwrites the output directory contents. Network access needed for the two
Open-Meteo fetches.

    python scripts/make_kilima_demo_artifacts.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOILING = ROOT / "public" / "data" / "soiling"
OUT = SOILING / "kilima-solar"
SLUG = "kilima-solar"
N_TARGET = 24
DIRTY_TARGET = "INV-03"  # matches seed_e2e_demo_data's dirty_idx = 2

# History shift: donor per-inverter series ends 2025-12-13; land it on
# "yesterday" relative to the generation date so the demo reads fresh.
DONOR_HISTORY_END = date(2025, 12, 13)
HISTORY_SHIFT_DAYS = (date.today() - timedelta(days=1) - DONOR_HISTORY_END).days

DEMO_NOTE = (
    "Demo specimen: series derived from an anonymized European donor plant, "
    "aggregated to this fleet's 24 inverters and calendar-shifted. Not "
    "measurements from this site."
)

DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def shift_date_str(s: str, days: int) -> str:
    m = DATE_RE.match(s)
    if not m:
        return s
    d = date(int(m.group(1)), int(m.group(2)), int(m.group(3))) + timedelta(days=days)
    return d.isoformat() + s[10:]


def shift_dates(obj, days: int):
    """Recursively shift every YYYY-MM-DD-prefixed string value."""
    if isinstance(obj, dict):
        return {k: shift_dates(v, days) for k, v in obj.items()}
    if isinstance(obj, list):
        return [shift_dates(v, days) for v in obj]
    if isinstance(obj, str) and DATE_RE.match(obj):
        return shift_date_str(obj, days)
    return obj


def load(plant: str, name: str):
    with open(SOILING / plant / name) as f:
        return json.load(f)


def dump(name: str, payload) -> None:
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"  wrote {path.relative_to(ROOT)}")


def db_fleet_sr_mean() -> float | None:
    """Latest seeded fleet_sr_mean for kilima-solar so the static per-inverter
    specimen agrees with the DB-backed summary KPI (the soiling page shows
    both). Falls back to None (no calibration) without a DB."""
    try:
        import psycopg2

        try:
            from dotenv import load_dotenv

            load_dotenv(ROOT / ".env")
            load_dotenv(ROOT / ".env.local")
        except Exception:
            pass
        conn = psycopg2.connect(os.environ["DATABASE_URL"])
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ar.value FROM analysis_results ar
                JOIN "Plant" p ON p.id = ar.plant_id::text
                WHERE p.slug = %s AND ar.domain = 'soiling' AND ar.metric = 'fleet_sr_mean'
                ORDER BY ar.time DESC LIMIT 1
                """,
                (SLUG,),
            )
            row = cur.fetchone()
        conn.close()
        return float(row[0]) if row else None
    except Exception as exc:
        print(f"  (no DB calibration: {exc})")
        return None


def build_per_inverter() -> None:
    donor = load("ribera", "per_inverter/ribera_per_inverter_sr.json")
    src = donor["inverters"]
    keys = sorted(src.keys())
    chunk = max(1, round(len(keys) / N_TARGET))
    groups = [keys[i * chunk : (i + 1) * chunk] for i in range(N_TARGET)]
    # Guard: never drop donors — fold any tail into the last group.
    covered = sum(len(g) for g in groups)
    if covered < len(keys):
        groups[-1].extend(keys[covered:])

    def mean(vals):
        vals = [v for v in vals if isinstance(v, (int, float))]
        return sum(vals) / len(vals) if vals else None

    aggregated = []
    for members in groups:
        histories = {}
        for k in members:
            for h in src[k].get("history", []):
                histories.setdefault(h["date"], []).append(h)
        history = [
            {
                "date": shift_date_str(d, HISTORY_SHIFT_DAYS),
                "sr": round(mean([h["sr"] for h in hs]), 4),
                "confidence": round(mean([h.get("confidence", 0.9) for h in hs]), 2),
            }
            for d, hs in sorted(histories.items(), reverse=True)
        ]
        aggregated.append(
            {
                "current_sr": round(mean([src[k].get("current_sr") for k in members]), 4),
                "sr_7d_avg": round(mean([src[k].get("sr_7d_avg") for k in members]), 4),
                "confidence": round(mean([src[k].get("confidence") for k in members]), 2),
                "history": history,
                "n_source_series": len(members),
            }
        )

    # Calibrate the specimen to the seeded DB fleet mean (multiplicative, so
    # the relative inverter spread survives) — the soiling page renders the DB
    # summary KPI and this file side by side.
    target = db_fleet_sr_mean()
    fleet_mean = sum(a["current_sr"] for a in aggregated) / len(aggregated)
    if target and fleet_mean:
        f = target / fleet_mean
        print(f"  calibrating specimen SR x{f:.4f} (fleet {fleet_mean:.4f} -> {target:.4f})")
        for rec in aggregated:
            rec["current_sr"] = round(rec["current_sr"] * f, 4)
            rec["sr_7d_avg"] = round(rec["sr_7d_avg"] * f, 4)
            for h in rec["history"]:
                h["sr"] = round(h["sr"] * f, 4)

    # Assign fleet ids: dirtiest aggregate becomes INV-03; everything else
    # fills the remaining ids in donor order.
    dirty = min(range(len(aggregated)), key=lambda i: aggregated[i]["current_sr"] or 1.0)
    ids = [f"INV-{i + 1:02d}" for i in range(N_TARGET)]
    remaining = [i for i in ids if i != DIRTY_TARGET]
    inverters = {}
    for idx, rec in enumerate(aggregated):
        inverters[DIRTY_TARGET if idx == dirty else remaining.pop(0)] = rec
    inverters = {k: inverters[k] for k in ids}

    meta = dict(donor.get("metadata", {}))
    meta.update(
        {
            "plant_id": SLUG,
            "n_inverters": N_TARGET,
            "generated_at": datetime.now().isoformat(),
        }
    )
    prov = dict(meta.get("provenance", {}))
    prov = shift_dates(prov, HISTORY_SHIFT_DAYS)
    prov["note"] = DEMO_NOTE
    prov["donor_series"] = len(keys)
    meta["provenance"] = prov

    dump(f"per_inverter/{SLUG}_per_inverter_sr.json", {"metadata": meta, "inverters": inverters})


# 6 MW Kenya economics: ~450 MWh/yr recovered (about 4% of expected annual
# generation), 65 EUR/MWh, 3600 EUR per cleaning event.
TARGET_ENERGY_MWH = 450.0
PRICE_EUR_MWH = 65.0
COST_PER_CLEANING_EUR = 3600.0
# Dry-season cleaning dates (Kenya: dry Jan-Feb and Jun-Sep).
CLEANING_DATES = ["2026-08-18", "2026-09-29", "2027-01-26"]
FORECAST_PERIOD = "2026-07-01 to 2027-06-30"


def build_cleaning() -> None:
    donor = load("alpha", "operator_proposal.json")
    donor_energy = donor["optimal_schedule"]["energy_recovered_MWh"]
    f_energy = TARGET_ENERGY_MWH / donor_energy

    n = len(CLEANING_DATES)
    energy = TARGET_ENERGY_MWH
    revenue = round(energy * PRICE_EUR_MWH, 2)
    cost = COST_PER_CLEANING_EUR * n
    net = round(revenue - cost, 2)
    roi = round(net / cost * 100, 1)
    payback_days = round(cost / (revenue / 365.0), 1)

    proposal = {
        "metadata": {
            "plant_id": SLUG,
            "generated_at": datetime.now().isoformat(),
            "note": DEMO_NOTE + " Costs are estimates; update with actual values.",
        },
        "executive_summary": {
            "plant_capacity_MW": 6.0,
            "forecast_period": FORECAST_PERIOD,
            "recommended_cleanings": n,
            "expected_net_benefit_EUR": net,
            "expected_roi_pct": roi,
        },
        "optimal_schedule": {
            "cleaning_dates": CLEANING_DATES,
            "n_cleanings": n,
            "energy_recovered_MWh": energy,
            "revenue_recovered_EUR": revenue,
            "cleaning_cost_EUR": cost,
            "net_benefit_EUR": net,
            "roi_pct": roi,
            "avg_sr": donor["optimal_schedule"]["avg_sr"],
        },
        "financial_analysis": {
            "baseline_revenue_EUR": round(donor["financial_analysis"]["baseline_revenue_EUR"] * f_energy * PRICE_EUR_MWH / 65.0, 2),
            "optimized_revenue_EUR": revenue,
            "cleaning_investment_EUR": cost,
            "net_benefit_EUR": net,
            "payback_days": payback_days,
        },
        "technical_details": donor.get("technical_details", {}),
        "recommendations": donor.get("recommendations", []),
    }
    dump("operator_proposal.json", proposal)

    comparison = load("alpha", "cleaning_comparison.json")
    scenarios = []
    for s in comparison.get("scenarios", []):
        n_c = s.get("n_cleanings") or 0
        e = round((s.get("energy_recovered_mwh") or 0) * f_energy, 1)
        rev = round(e * PRICE_EUR_MWH, 2)
        c = COST_PER_CLEANING_EUR * n_c
        scenarios.append(
            {
                **s,
                "dates": ", ".join(
                    shift_date_str(d.strip(), 280) for d in (s.get("dates") or "").split(",") if d.strip()
                ),
                "energy_recovered_mwh": e,
                "revenue_recovered_eur": rev,
                "cleaning_cost_eur": c,
                "net_benefit_eur": round(rev - c, 2),
                "roi__pct": round((rev - c) / c * 100, 1) if c else 0.0,
            }
        )
    dump(
        "cleaning_comparison.json",
        {
            "metadata": {"plant_id": SLUG, "generated_at": datetime.now().isoformat(), "note": DEMO_NOTE},
            "scenarios": scenarios,
        },
    )


LAT, LON = -1.45, 36.98
RECOVERY_MM = 5.0  # matches the EQUATORIAL_EAST_AFRICA prior
HEAVY_RAIN_MM = 10.0


def _fetch_json(url: str):
    import urllib.request

    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.load(resp)


def build_rain_history() -> None:
    """Real Open-Meteo archive precipitation for the plant's own coordinates —
    Athi River's actual bimodal MAM/OND rains, not a shifted donor series."""
    end = (date.today() - timedelta(days=2)).isoformat()
    start = (date.today() - timedelta(days=910)).isoformat()
    data = _fetch_json(
        "https://archive-api.open-meteo.com/v1/archive"
        f"?latitude={LAT}&longitude={LON}&daily=precipitation_sum"
        f"&start_date={start}&end_date={end}&timezone=UTC"
    )
    dates = data["daily"]["time"]
    mm = data["daily"]["precipitation_sum"]
    rows = [
        {
            "date": d,
            "precipitation_mm": round(v or 0.0, 1),
            "is_cleaning_event": (v or 0.0) >= RECOVERY_MM,
            "is_heavy_rain": (v or 0.0) >= HEAVY_RAIN_MM,
        }
        for d, v in zip(dates, mm)
    ]
    events = [r["date"] for r in rows if r["is_cleaning_event"]]
    total = sum(r["precipitation_mm"] for r in rows)
    dump(
        "rain_history.json",
        {
            "metadata": {
                "plant_id": SLUG,
                "generated_at": datetime.now().isoformat(),
                "source": "open-meteo archive (ERA5), plant coordinates",
                "latitude": LAT,
                "longitude": LON,
                "cleaning_event_threshold_mm": RECOVERY_MM,
            },
            "daily_data": rows,
            "cleaning_events": events,
            "statistics": {
                "days": len(rows),
                "total_mm": round(total, 1),
                "rain_days": sum(1 for r in rows if r["precipitation_mm"] >= 1.0),
                "cleaning_events": len(events),
            },
        },
    )


def build_aod_history() -> None:
    """Real Open-Meteo air-quality (CAMS) daily means for the coordinates."""
    end = (date.today() - timedelta(days=2)).isoformat()
    start = (date.today() - timedelta(days=365)).isoformat()
    data = _fetch_json(
        "https://air-quality-api.open-meteo.com/v1/air-quality"
        f"?latitude={LAT}&longitude={LON}"
        "&hourly=pm10,pm2_5,dust,aerosol_optical_depth"
        f"&start_date={start}&end_date={end}&timezone=UTC"
    )
    hourly = data["hourly"]
    by_day: dict[str, dict[str, list]] = {}
    for i, t in enumerate(hourly["time"]):
        day = t[:10]
        rec = by_day.setdefault(day, {"pm10": [], "pm2_5": [], "dust": [], "aod": []})
        for key, col in [("pm10", "pm10"), ("pm2_5", "pm2_5"), ("dust", "dust"), ("aod", "aerosol_optical_depth")]:
            v = hourly[col][i]
            if v is not None:
                rec[key].append(v)

    def mean(vals):
        return round(sum(vals) / len(vals), 2) if vals else None

    rows = []
    for day in sorted(by_day):
        rec = by_day[day]
        aod = mean(rec["aod"])
        rows.append(
            {
                "date": day,
                "pm10_mean": mean(rec["pm10"]),
                "pm2p5_mean": mean(rec["pm2_5"]),
                "dust_mean": mean(rec["dust"]),
                "aod_mean": aod,
                "is_high_dust": aod is not None and aod > 0.5,
            }
        )
    dump(
        "aod_history.json",
        {
            "metadata": {
                "plant_id": SLUG,
                "generated_at": datetime.now().isoformat(),
                "source": "open-meteo air-quality (CAMS), plant coordinates",
                "latitude": LAT,
                "longitude": LON,
            },
            "daily_data": rows,
            "statistics": {"days": len(rows)},
        },
    )


def build_dustiq_history() -> None:
    """Fleet-mean SR series derived from the per-inverter specimen. There is
    no physical DustIQ at this site — this file exists so the optimizer's
    observed-SR anchor agrees with the rest of the soiling story, and its
    metadata says exactly what it is."""
    per_inv = json.load(open(OUT / "per_inverter" / f"{SLUG}_per_inverter_sr.json"))
    by_date: dict[str, list[float]] = {}
    for rec in per_inv["inverters"].values():
        for h in rec.get("history", []):
            by_date.setdefault(h["date"], []).append(h["sr"])
    rows = [
        {"date": d, "sr_dustiq": round(sum(v) / len(v), 4)}
        for d, v in sorted(by_date.items())
    ]
    dump(
        "dustiq_history.json",
        {
            "metadata": {
                "plant_id": SLUG,
                "generated_at": datetime.now().isoformat(),
                "note": (
                    "Demo specimen: fleet-mean SR derived from the per-inverter "
                    "series. No physical DustIQ sensor exists at this site."
                ),
            },
            "daily_data": rows,
        },
    )


def build_ml_forecast() -> None:
    payload = shift_dates(load("ribera", "ml_forecast_365d.json"), HISTORY_SHIFT_DAYS)
    if isinstance(payload, dict) and isinstance(payload.get("metadata"), dict):
        payload["metadata"]["plant_id"] = SLUG
        payload["metadata"]["note"] = DEMO_NOTE
        # Bimodal East-African prior (nuravolt/soiling/climate_regions.py);
        # drives the optimizer's climate-zone chip and prior band.
        payload["metadata"]["climate_zone"] = "EQUATORIAL_EAST_AFRICA"
    dump("ml_forecast_365d.json", payload)


def build_loss_waterfall() -> None:
    """ml_per_inverter_metrics.json for the loss-disaggregation waterfall.

    Soiling share comes from the per-inverter SR artifact written above;
    the other components are Kenya-plausible constants with deterministic
    per-inverter jitter. INV-21 (offline) and INV-17 (derating) carry the
    elevated inverter-loss share so the waterfall matches the fleet story.
    """
    per_inv = json.load(open(OUT / "per_inverter" / f"{SLUG}_per_inverter_sr.json"))
    inverters = {}
    # 30-day reference energy per 250 kW inverter at a Kenyan capacity factor.
    reference_kwh = 250.0 * 24 * 30 * 0.215

    def jitter(inv_id: str, lo: float, hi: float, salt: str) -> float:
        h = int(hashlib.md5(f"{inv_id}:{salt}".encode()).hexdigest(), 16) % 1000
        return lo + (hi - lo) * (h / 999.0)

    for inv_id, data in per_inv["inverters"].items():
        sr = data.get("current_sr") or data.get("sr_7d_avg") or 0.95
        soiling = round(max(0.0, (1 - sr) * 100), 2)
        inverter_loss = 1.2
        if inv_id == "INV-21":
            inverter_loss = 10.0  # offline 3 of the last 30 days
        elif inv_id == "INV-17":
            inverter_loss = 6.5  # derating ramp
        elif inv_id == "INV-11":
            inverter_loss = 2.8  # midday overtemperature trips
        else:
            inverter_loss = round(jitter(inv_id, 0.9, 1.5, "inv"), 2)
        parts = {
            "soiling": soiling,
            "temperature": round(jitter(inv_id, 2.2, 3.1, "temp"), 2),
            "spectral": round(jitter(inv_id, 0.6, 0.9, "spec"), 2),
            "inverter": inverter_loss,
            "wiringBop": round(jitter(inv_id, 1.1, 1.6, "wire"), 2),
            "degradation": round(jitter(inv_id, 0.3, 0.6, "deg"), 2),
        }
        parts["total"] = round(sum(parts.values()), 2)
        net = round(reference_kwh * (1 - parts["total"] / 100), 2)
        inverters[inv_id] = {
            "inverterId": inv_id,
            "soilingRatio": {
                "mean": round(sr, 6),
                "median": round(sr, 6),
                "min": round(max(0.75, sr - 0.02), 6),
                "max": round(min(1.0, sr + 0.02), 6),
                "std": round(jitter(inv_id, 0.008, 0.016, "std"), 6),
            },
            "lossDisaggregation": {
                "method": "ml_transfer_learning",
                "percentages": parts,
                "energy_kWh": {
                    "reference": round(reference_kwh, 2),
                    "net": net,
                    "soilingLoss": round(reference_kwh * parts["soiling"] / 100, 2),
                },
            },
        }
    dump(
        "ml_per_inverter_metrics.json",
        {
            "plantId": SLUG,
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "note": DEMO_NOTE,
            "inverters": inverters,
        },
    )


def build_context_series() -> None:
    build_ml_forecast()
    build_rain_history()
    build_aod_history()
    build_dustiq_history()
    build_loss_waterfall()


def main() -> int:
    print(f"[kilima] shift = +{HISTORY_SHIFT_DAYS} days")
    OUT.mkdir(parents=True, exist_ok=True)
    build_per_inverter()
    build_cleaning()
    build_context_series()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
