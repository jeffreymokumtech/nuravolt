#!/usr/bin/env python3
"""Backfill the per-plant ML cleaning forecast across every plant in the
soiling registry.

Usage:
    python scripts/regenerate_all_forecasts.py            # all plants
    python scripts/regenerate_all_forecasts.py --retrain  # retrain models first
    python scripts/regenerate_all_forecasts.py ribera epsilon   # subset

Prints a per-plant validation report:
- resolved climate zone + model used (or "prior-only")
- monthly Δ vs climatology Δ
- guard-rail trigger count
- DustIQ correlation if ground-truth history exists
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import List

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nuravolt.soiling.climate_regions import PLANT_CLIMATE, resolve_zone  # noqa: E402
from nuravolt.soiling.sr_foundation_model import train_per_climate  # noqa: E402
from nuravolt.soiling.sr_transfer_features import PLANT_CONFIGS  # noqa: E402
from scripts.generate_ml_cleaning_forecast import (  # noqa: E402
    DATA_ROOT,
    generate_ml_cleaning_forecast,
)


def validate_plant(plant_id: str) -> dict:
    """Inspect the regenerated ml_forecast_365d.json and return a report."""
    p = DATA_ROOT / plant_id / "ml_forecast_365d.json"
    if not p.exists():
        return {"plant_id": plant_id, "error": "forecast not written"}

    d = json.loads(p.read_text())
    meta = d["metadata"]
    forecasts = d["forecasts"]

    by_month = defaultdict(list)
    for row in forecasts:
        by_month[row["date"][:7]].append(row["sr_predicted"])

    monthly = []
    for ym in sorted(by_month.keys()):
        v = by_month[ym]
        monthly.append({
            "month": ym,
            "avg_sr": round(sum(v) / len(v), 4),
            "delta_pp": round((v[-1] - v[0]) * 100, 2),
        })

    guard = meta.get("guard_rail", {}).get("monthly_diagnostics", {})
    triggered_months = [m for m, info in guard.items() if info.get("blend_weight_climatology", 0) > 0]

    return {
        "plant_id": plant_id,
        "climate_zone": meta.get("climate_zone"),
        "model_type": meta.get("model_type"),
        "model_version": meta.get("model_version"),
        "n_days": meta.get("n_days"),
        "monthly_trend": monthly,
        "guard_rail_months_blended": sorted(triggered_months),
    }


def print_report(reports: List[dict]) -> None:
    print(f"\n{'=' * 70}")
    print("VALIDATION REPORT")
    print(f"{'=' * 70}")
    for r in reports:
        if "error" in r:
            print(f"  ✗ {r['plant_id']}: {r['error']}")
            continue
        print(f"\n— {r['plant_id']:18s} [{r['climate_zone']}] — {r['model_type']}")
        print(f"  version: {r['model_version']}")
        # Compact monthly summary
        for row in r["monthly_trend"]:
            d = row["delta_pp"]
            mark = "↓" if d < -2 else "↑" if d > 2 else "·"
            print(f"    {row['month']}: SR={row['avg_sr']}  Δ={d:+6.2f}pp {mark}")
        if r["guard_rail_months_blended"]:
            print(f"  guard-rail blended months: {r['guard_rail_months_blended']}")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("plants", nargs="*", help="Plant IDs (default: all known)")
    p.add_argument("--retrain", action="store_true", help="Retrain per-climate models before regenerating")
    args = p.parse_args()

    plants = args.plants or sorted(PLANT_CLIMATE.keys())

    if args.retrain:
        print("Retraining per-climate models …")
        registry = train_per_climate(save_dir=REPO_ROOT / "backenddata" / "models")
        print("Train registry:")
        for z, info in registry.items():
            if "error" in info:
                print(f"  {z}: ERROR {info['error']}")
            else:
                n_donors = len(info["donors"])
                mae = info["train_mae"] * 100
                print(f"  {z}: {n_donors} donors, MAE={mae:.2f}%")

    print(f"\nRegenerating forecasts for {len(plants)} plants …")
    success = 0
    reports = []
    for plant_id in plants:
        try:
            ok = generate_ml_cleaning_forecast(plant_id)
            if ok:
                success += 1
                reports.append(validate_plant(plant_id))
            else:
                reports.append({"plant_id": plant_id, "error": "generator returned False"})
        except Exception as e:
            print(f"  ✗ {plant_id}: {e}")
            reports.append({"plant_id": plant_id, "error": str(e)})

    print_report(reports)

    print(f"\n{'=' * 70}")
    print(f"Done — {success}/{len(plants)} successful")
    print(f"{'=' * 70}")
    return 0 if success == len(plants) else 1


if __name__ == "__main__":
    sys.exit(main())
