#!/usr/bin/env python3
"""Time-trend PV degradation validation against Sandia PV-IV-EL.

This is the **real** time-trend degradation question Lazzaretti can't answer:
"how fast does this PV module fade over years of outdoor exposure?"

Sandia's dataset has 438 modules measured at 0 - ~3000 days of outdoor
exposure (`Total_Exposure` column). For each module we compute:
  - degradation_ratio = Pmp_measured / Nameplate_Pmp
  - fade_rate (%/year) = linear slope of degradation_ratio vs exposure years

Report:
  - Fleet-average fade rate (%/yr) vs published literature (0.5-1.0%/yr for c-Si)
  - Per-cell-tech breakdown (mono-Si / multi-Si / thin-film)
  - Distribution of per-module fade rates
  - JSON output for the validation summary

Usage:
    python scripts/validate_pv_degradation.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import numpy as np
import polars as pl

from nuravolt.validation.report import write_report


ANONDB_CSV = REPO_ROOT / "backenddata" / "datasets" / "sandia_pv_iv_el" / "AnonDB.csv"


def _days_from_exposure_str(s) -> int | None:
    if s is None:
        return None
    m = re.search(r"(\d+)", str(s))
    return int(m.group(1)) if m else None


def main() -> int:
    if not ANONDB_CSV.exists():
        print(f"Missing {ANONDB_CSV}. Run scripts/fetch_sandia_pv_iv_el.py first.")
        return 1

    print("=" * 60)
    print(" PV degradation validation — Sandia PV-IV-EL")
    print("=" * 60)

    df = pl.read_csv(ANONDB_CSV, infer_schema_length=10000, ignore_errors=True)
    print(f"\n  loaded {len(df)} measurements across {df['Mod_ID'].n_unique()} unique modules")

    # Parse exposure days, compute degradation ratio
    df = df.with_columns([
        pl.col("Total_Exposure").map_elements(_days_from_exposure_str, return_dtype=pl.Int32).alias("exposure_days"),
        (pl.col("Pmp_(W)") / pl.col("Nameplate_Pmp_(W)")).alias("degradation_ratio"),
    ])
    df = df.filter(pl.col("exposure_days").is_not_null())
    df = df.filter(pl.col("degradation_ratio").is_finite())
    print(f"  {len(df)} measurements with valid exposure days + Pmp/Pmp_nameplate ratio")

    # Per-module fade rate via linear regression slope of degradation_ratio vs exposure_years
    per_module_rows = []
    for mod_id in df["Mod_ID"].unique().to_list():
        sub = df.filter(pl.col("Mod_ID") == mod_id).sort("exposure_days")
        if len(sub) < 2:
            continue
        days = sub["exposure_days"].to_numpy().astype(float)
        deg = sub["degradation_ratio"].to_numpy().astype(float)
        # Skip modules with no degradation observation span
        if days.max() - days.min() < 30:
            continue
        # Linear fit; slope is degradation per day, convert to %/year
        slope_per_day, intercept = np.polyfit(days, deg, 1)
        fade_rate_pct_per_year = -slope_per_day * 365 * 100   # negate so positive = fading
        cell_tech = sub["Cell_Tech"][0] if "Cell_Tech" in sub.columns else None
        per_module_rows.append({
            "mod_id": int(mod_id),
            "n_measurements": int(len(sub)),
            "exposure_span_days": int(days.max() - days.min()),
            "initial_degradation_ratio": float(intercept),
            "fade_rate_pct_per_year": round(float(fade_rate_pct_per_year), 4),
            "cell_tech": cell_tech,
        })

    if not per_module_rows:
        print("  No modules with multi-year measurements — can't compute fade rates.")
        return 1

    fade_rates = np.array([r["fade_rate_pct_per_year"] for r in per_module_rows])
    print(f"\n  Per-module fade rate distribution ({len(fade_rates)} modules):")
    print(f"    mean: {fade_rates.mean():.3f} %/yr")
    print(f"    median: {np.median(fade_rates):.3f} %/yr")
    print(f"    p25 / p75: {np.percentile(fade_rates, 25):.3f} / {np.percentile(fade_rates, 75):.3f} %/yr")
    print(f"    min / max: {fade_rates.min():.3f} / {fade_rates.max():.3f} %/yr")

    # Per-cell-tech breakdown
    tech_stats: dict = {}
    for r in per_module_rows:
        t = r["cell_tech"] or "unknown"
        tech_stats.setdefault(t, []).append(r["fade_rate_pct_per_year"])
    print(f"\n  Per-cell-tech fade rates:")
    for t, rates in sorted(tech_stats.items()):
        arr = np.array(rates)
        print(f"    {str(t)[:24]:>24}: n={len(arr):>3}, mean={arr.mean():.3f}, median={np.median(arr):.3f} %/yr")

    payload = {
        "dataset": "Sandia PV-IV-EL (time-trend degradation)",
        "n_samples": len(per_module_rows),
        "n_modules_with_fade_rate": len(per_module_rows),
        "fleet_fade_rate_distribution_pct_per_year": {
            "mean": round(float(fade_rates.mean()), 4),
            "median": round(float(np.median(fade_rates)), 4),
            "p25": round(float(np.percentile(fade_rates, 25)), 4),
            "p75": round(float(np.percentile(fade_rates, 75)), 4),
            "min": round(float(fade_rates.min()), 4),
            "max": round(float(fade_rates.max()), 4),
        },
        "per_cell_tech_mean_fade_rate_pct_per_year": {
            str(t): round(float(np.mean(rates)), 4) for t, rates in tech_stats.items()
        },
        "headline": f"fleet mean fade rate {fade_rates.mean():.3f} %/yr across {len(fade_rates)} modules",
        "method": "linear regression of (Pmp / Nameplate_Pmp) vs exposure_days, slope × 365 × 100",
        "comparison_to_literature": (
            "Published c-Si module degradation: 0.5-1.0 %/yr (Jordan & Kurtz 2013 meta-review). "
            "Fleet median above this range = unusually fast-fading population; "
            "below = unusually stable. PV-IV-EL is intentionally a stress-tested cohort."
        ),
    }
    out_path = write_report("pv", "sandia_pv_iv_el_degradation", payload)
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
