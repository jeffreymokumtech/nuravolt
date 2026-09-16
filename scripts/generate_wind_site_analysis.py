#!/usr/bin/env python3
"""Generate wind-rose + wake-analysis fixtures for the wind demo plants.

Data sources are real:
  - Wind climate: Open-Meteo ERA5 archive (hourly wind speed + direction at
    100 m, close to the ~80 m hub height) for the plant's coordinates —
    the same satellite/reanalysis source the rest of the platform uses.
  - Layout: per-turbine lat/lng from public/data/wind/<plant>/turbines.json.
  - Wake engine: nuravolt.wind.wake_model (Jensen), frequency-weighted over
    16 direction sectors.

Writes, per plant:
  public/data/wind/<plant>/wind_rose.json
  public/data/wind/<plant>/wake_analysis.json

Usage:  python scripts/generate_wind_site_analysis.py [--plant-id care-portugal]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from nuravolt.wind.wake_model import TurbinePosition, WakeFarmModel  # noqa: E402

WIND_DATA = ROOT / "public" / "data" / "wind"
SECTORS = 16
SECTOR_DEG = 360 / SECTORS
SECTOR_NAMES = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]
SPEED_CLASSES = [(0, 3), (3, 6), (6, 9), (9, 12), (12, 99)]
ARCHIVE_YEAR = 2025


def fetch_hourly_wind(lat: float, lng: float) -> tuple[list[float], list[float]]:
    """One year of hourly wind speed (m/s) + direction at 100 m from ERA5."""
    resp = requests.get(
        "https://archive-api.open-meteo.com/v1/archive",
        params={
            "latitude": lat,
            "longitude": lng,
            "start_date": f"{ARCHIVE_YEAR}-01-01",
            "end_date": f"{ARCHIVE_YEAR}-12-31",
            "hourly": "wind_speed_100m,wind_direction_100m",
            "wind_speed_unit": "ms",
            "timezone": "UTC",
        },
        timeout=60,
    )
    resp.raise_for_status()
    hourly = resp.json()["hourly"]
    speeds = [s for s in hourly["wind_speed_100m"] if s is not None]
    dirs = [
        d
        for s, d in zip(hourly["wind_speed_100m"], hourly["wind_direction_100m"])
        if s is not None and d is not None
    ]
    return speeds, dirs


def build_rose(speeds: list[float], dirs: list[float]) -> dict:
    n = len(dirs)
    sectors = []
    for i in range(SECTORS):
        lo = (i * SECTOR_DEG - SECTOR_DEG / 2) % 360
        in_sector = [
            s
            for s, d in zip(speeds, dirs)
            if (d - lo) % 360 < SECTOR_DEG
        ]
        cls_freq = []
        for c_lo, c_hi in SPEED_CLASSES:
            cnt = sum(1 for s in in_sector if c_lo <= s < c_hi)
            cls_freq.append(round(100 * cnt / n, 2))
        sectors.append(
            {
                "sector": SECTOR_NAMES[i],
                "centerDeg": i * SECTOR_DEG,
                "frequencyPct": round(100 * len(in_sector) / n, 2),
                "meanSpeedMs": round(sum(in_sector) / len(in_sector), 2) if in_sector else 0.0,
                "speedClassesPct": cls_freq,
            }
        )
    return {
        "source": f"Open-Meteo ERA5 archive, hourly 100 m wind, {ARCHIVE_YEAR}",
        "sampleHours": n,
        "meanSpeedMs": round(sum(speeds) / len(speeds), 2),
        "speedClasses": [f"{lo}-{hi if hi < 99 else '+'} m/s" for lo, hi in SPEED_CLASSES],
        "sectors": sectors,
    }


def latlng_to_xy(lat0: float, lng0: float, lat: float, lng: float) -> tuple[float, float]:
    x = (lng - lng0) * 111_320 * math.cos(math.radians(lat0))
    y = (lat - lat0) * 110_540
    return x, y


def expected_power_curve(plant_dir: Path) -> tuple:
    """Interpolator over the plant's real expected power curve (first turbine)."""
    pc_files = sorted((plant_dir / "power_curve").glob("power_curve_*.json"))
    pc = json.loads(pc_files[0].read_text())
    pts = [(p["windSpeedBin"], p["expectedPower"]) for p in pc["points"]]
    pts.sort()
    cut_out = pc.get("cutOutSpeed", 25.0)
    rated = pc.get("ratedPower", 2000)

    def curve(ws: float) -> float:
        if ws >= cut_out:
            return 0.0
        if ws <= pts[0][0]:
            return 0.0
        for (w1, p1), (w2, p2) in zip(pts, pts[1:]):
            if w1 <= ws <= w2:
                return p1 + (p2 - p1) * (ws - w1) / (w2 - w1) if w2 > w1 else p1
        return float(rated)

    return curve, rated


def build_wake(plant_dir: Path, rose: dict) -> dict:
    turbines = json.loads((plant_dir / "turbines.json").read_text())
    tlist = turbines["turbines"] if isinstance(turbines, dict) else turbines
    lat0 = sum(t["latitude"] for t in tlist) / len(tlist)
    lng0 = sum(t["longitude"] for t in tlist) / len(tlist)

    positions = []
    for t in tlist:
        x, y = latlng_to_xy(lat0, lng0, t["latitude"], t["longitude"])
        positions.append(
            TurbinePosition(
                x=x,
                y=y,
                hub_height=t.get("hubHeightM", 80.0),
                rotor_diameter=t.get("rotorDiameterM", 90.0),
                turbine_id=t["id"],
            )
        )
    farm = WakeFarmModel(positions)
    curve, rated = expected_power_curve(plant_dir)

    per_sector = []
    weighted_turbine_loss = [0.0] * len(tlist)
    weighted_farm_loss = 0.0
    total_weight = 0.0
    for sector in rose["sectors"]:
        ws = sector["meanSpeedMs"]
        freq = sector["frequencyPct"] / 100
        if ws <= 0 or freq == 0:
            per_sector.append(
                {"sector": sector["sector"], "centerDeg": sector["centerDeg"],
                 "frequencyPct": sector["frequencyPct"], "farmLossPct": 0.0,
                 "turbineLossPct": [0.0] * len(tlist)}
            )
            continue
        res = farm.calculate_farm_power(ws, sector["centerDeg"], curve)
        gross_each = curve(ws)
        t_loss = [
            round(100 * (1 - p / gross_each), 2) if gross_each > 0 else 0.0
            for p in res.turbine_powers
        ]
        per_sector.append(
            {
                "sector": sector["sector"],
                "centerDeg": sector["centerDeg"],
                "frequencyPct": sector["frequencyPct"],
                "farmLossPct": round(res.wake_losses_pct, 2),
                "turbineLossPct": t_loss,
            }
        )
        weighted_farm_loss += res.wake_losses_pct * freq
        total_weight += freq
        for i, loss in enumerate(t_loss):
            weighted_turbine_loss[i] += loss * freq

    annual_farm_loss = weighted_farm_loss / total_weight if total_weight else 0.0
    return {
        "model": "Jensen (nuravolt.wind.wake_model), frequency-weighted over 16 sectors",
        "windSource": rose["source"],
        "farm": {
            "annualWakeLossPct": round(annual_farm_loss, 2),
            "farmEfficiencyPct": round(100 - annual_farm_loss, 2),
            "ratedPowerKw": rated,
        },
        "turbines": [
            {
                "id": positions[i].turbine_id,
                "x": round(positions[i].x, 1),
                "y": round(positions[i].y, 1),
                "annualWakeLossPct": round(weighted_turbine_loss[i] / total_weight, 2)
                if total_weight
                else 0.0,
            }
            for i in range(len(positions))
        ],
        "sectors": per_sector,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plant-id", default=None, help="single plant slug")
    args = parser.parse_args()

    plants = [args.plant_id] if args.plant_id else [
        p.name for p in WIND_DATA.iterdir() if (p / "turbines.json").exists()
    ]
    for plant in plants:
        plant_dir = WIND_DATA / plant
        summary = json.loads((plant_dir / "summary.json").read_text())
        lat, lng = summary["latitude"], summary["longitude"]
        print(f"[{plant}] fetching {ARCHIVE_YEAR} ERA5 wind for ({lat}, {lng})...")
        speeds, dirs = fetch_hourly_wind(lat, lng)
        rose = build_rose(speeds, dirs)
        (plant_dir / "wind_rose.json").write_text(json.dumps(rose, indent=1))
        print(f"[{plant}] wind_rose.json written ({rose['sampleHours']} h, mean {rose['meanSpeedMs']} m/s)")
        wake = build_wake(plant_dir, rose)
        (plant_dir / "wake_analysis.json").write_text(json.dumps(wake, indent=1))
        print(
            f"[{plant}] wake_analysis.json written "
            f"(annual wake loss {wake['farm']['annualWakeLossPct']}%, "
            f"farm efficiency {wake['farm']['farmEfficiencyPct']}%)"
        )


if __name__ == "__main__":
    main()
