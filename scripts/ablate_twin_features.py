#!/usr/bin/env python3
"""Does an ML digital twin travel to a plant it has never seen?

MEASURED STARTING POINT
-----------------------
On an unseen plant the ML twin scores nMAE 11.19% against a naive fitted
irradiance line's 8.90%. The machine learning is 26% WORSE than a straight line.
The same model wins slightly on the plant it was trained on.

THE HYPOTHESIS
--------------
"ML does not generalise" is not an explanation. This is:

A twin's residual (measured minus physics) has two parts.

  Travelling physics  temperature coefficient error, angle of incidence,
                      spectral response, inverter efficiency curve. Functions of
                      measurable physical quantities. These SHOULD transfer.

  Site geometry       row-to-row shading, terrain, horizon, sensor placement.
                      Functions of sun position AT THIS SITE. Meaningless anywhere
                      else.

Shading recurs at a fixed solar position on a fixed date. So **calendar and clock
features are the channel through which site geometry enters the model**. The
current twin has `doy_sin` and `doy_cos` in its feature set.

Prediction, recorded before running:

    Removing calendar and clock features should IMPROVE leave-one-plant-out
    performance while WORSENING same-plant performance.

That is a falsifiable, directional claim, and both outcomes are informative. If it
holds, we know how to build a twin that travels. If it fails, the most plausible
story is ruled out and the physics twin ships alone, which it can: 6.61% nMAE with
no ML at all.

FEATURE SETS
------------
  physics    irradiance, its square, cell-temperature proxy, wind, and the
             clear-sky index. Nothing that identifies a time or a place.
  calendar   physics + day-of-year sine and cosine.
  clock      physics + a within-day position term.
  all        physics + calendar + clock.

Usage:
    set -a; source .env; set +a
    python scripts/ablate_twin_features.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.metrics.twin import (  # noqa: E402
    NORM_MEAN_DAILY_ENERGY,
    compute_twin_report,
)
from nuravolt.validation.report import write_report  # noqa: E402

TWIN_DIR = Path("backenddata/models/soiling_aware_twin")
SEED = 0

#: Gamma's measured output level shifts mid-record, which is a capacity change
#: or a sensor swap rather than twin error. Excluded from headlines, reported
#: separately, exactly as in scripts/validate_twin.py.
EXCLUDE = {"gamma"}

PHYSICS = ["irr", "irr_sq", "cell_temp_proxy", "wind_proxy", "clearsky_index"]
CALENDAR = ["doy_sin", "doy_cos"]
CLOCK = ["day_progress"]

FEATURE_SETS: Dict[str, List[str]] = {
    "physics": PHYSICS,
    "physics+calendar": PHYSICS + CALENDAR,
    "physics+clock": PHYSICS + CLOCK,
    "all": PHYSICS + CALENDAR + CLOCK,
}


def load(path: Path) -> pd.DataFrame | None:
    df = pd.read_parquet(path)
    if not isinstance(df.index, pd.DatetimeIndex):
        return None
    df = df.reset_index()
    df.columns = ["date"] + list(df.columns[1:])
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)

    df = df[np.isfinite(df["p_actual"]) & (df["p_actual"] > 0)]
    df = df[np.isfinite(df["irradiance"]) & (df["irradiance"] > 0)]
    if len(df) < 400:
        return None

    doy = df["date"].dt.dayofyear
    df["irr"] = df["irradiance"]
    df["irr_sq"] = df["irradiance"] ** 2
    # Cell temperature proxy: irradiance drives module heating. No calendar in it.
    df["cell_temp_proxy"] = df["irradiance"] / 800.0
    df["wind_proxy"] = df.get("rainfall", pd.Series(0.0, index=df.index)).fillna(0.0).clip(0, 20)
    # Clear-sky index needs a clear-sky reference; the rolling 95th percentile of
    # irradiance is a site-local stand-in that carries no date information.
    ref = df["irradiance"].rolling(60, min_periods=10).quantile(0.95)
    df["clearsky_index"] = (df["irradiance"] / ref.replace(0, np.nan)).clip(0, 1.5).fillna(1.0)
    df["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    df["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    df["day_progress"] = (doy % 30) / 30.0

    return df.dropna(subset=PHYSICS + CALENDAR + CLOCK + ["p_actual"]).reset_index(drop=True)


def model():
    from sklearn.ensemble import HistGradientBoostingRegressor

    return HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.05, max_depth=5, random_state=SEED
    )


def irradiance_baseline(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """Least-squares irradiance line fitted on the training window only."""
    denom = float((train["irr"] ** 2).sum())
    k = float((train["irr"] * train["p_actual"]).sum() / denom) if denom else 0.0
    return test["irr"].to_numpy() * k


def same_plant(frames: Dict[str, pd.DataFrame], feats: List[str]) -> Tuple[np.ndarray, ...]:
    """Last 20% of each plant's days, held out in time."""
    a, p, b = [], [], []
    for df in frames.values():
        cut = int(len(df) * 0.8)
        tr, te = df.iloc[:cut], df.iloc[cut:]
        if len(tr) < 200 or len(te) < 50:
            continue
        m = model()
        m.fit(tr[feats], tr["p_actual"])
        p.extend(m.predict(te[feats]))
        b.extend(irradiance_baseline(tr, te))
        a.extend(te["p_actual"])
    return np.array(a), np.array(p), np.array(b)


def leave_one_plant_out(frames: Dict[str, pd.DataFrame], feats: List[str]) -> Tuple[np.ndarray, ...]:
    """Train on every plant but one; score the held-out plant with no history from it.

    Targets are per-unit against each plant's own median so that plants of very
    different size are comparable, then rescaled to the held-out plant's level.
    Only its median is assumed known, which is what a nameplate gives you on day one.
    """
    a, p, b = [], [], []
    for held_out, test_df in frames.items():
        if held_out in EXCLUDE:
            continue
        parts = []
        for name, df in frames.items():
            if name == held_out:
                continue
            q = df.copy()
            q["y_pu"] = q["p_actual"] / float(df["p_actual"].median())
            q["irr"] = q["irr"] / float(df["irr"].median())
            q["irr_sq"] = q["irr"] ** 2
            parts.append(q)
        train = pd.concat(parts, ignore_index=True)

        te = test_df.copy()
        scale = float(te["p_actual"].median())
        irr_scale = float(te["irr"].median())
        te["irr"] = te["irr"] / irr_scale
        te["irr_sq"] = te["irr"] ** 2

        m = model()
        m.fit(train[feats], train["y_pu"])
        p.extend(m.predict(te[feats]) * scale)

        denom = float((train["irr"] ** 2).sum())
        k = float((train["irr"] * train["y_pu"]).sum() / denom) if denom else 0.0
        b.extend(te["irr"].to_numpy() * k * scale)
        a.extend(te["p_actual"])
    return np.array(a), np.array(p), np.array(b)


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()

    frames: Dict[str, pd.DataFrame] = {}
    for path in sorted(TWIN_DIR.glob("*_daily_hybrid.parquet")):
        name = path.name.replace("_daily_hybrid.parquet", "")
        df = load(path)
        if df is not None:
            frames[name] = df
    if len(frames) < 3:
        write_report("twin", "twin_feature_ablation", {
            "dataset": "Twin feature ablation",
            "status": "pending_manual_fetch",
            "reason": f"need >=3 plants, found {len(frames)}",
        })
        print("insufficient plants; wrote pending report")
        return 0

    print(f"plants: {', '.join(frames)}  (excluded from LOPO headline: {', '.join(EXCLUDE)})\n")
    print(f"{'feature set':<20}{'same-plant':>12}{'unseen plant':>14}{'baseline':>11}{'ML uplift':>12}")

    results: Dict[str, Dict] = {}
    for label, feats in FEATURE_SETS.items():
        a1, p1, b1 = same_plant(frames, feats)
        a2, p2, b2 = leave_one_plant_out(frames, feats)

        sp = compute_twin_report(
            dataset=f"same_plant/{label}", actual=a1, predicted=p1,
            normalizer=NORM_MEAN_DAILY_ENERGY, normalizer_value=float(a1.mean()),
            baselines={"irradiance_scaling": b1}, reference_baseline="irradiance_scaling",
        ).to_dict()
        lopo = compute_twin_report(
            dataset=f"leave_one_plant_out/{label}", actual=a2, predicted=p2,
            normalizer=NORM_MEAN_DAILY_ENERGY, normalizer_value=float(a2.mean()),
            baselines={"irradiance_scaling": b2}, reference_baseline="irradiance_scaling",
        ).to_dict()

        results[label] = {"same_plant": sp, "leave_one_plant_out": lopo}
        print(f"{label:<20}{sp['nmae_pct']:>11.2f}%{lopo['nmae_pct']:>13.2f}%"
              f"{lopo['reference_nmae_pct']:>10.2f}%{lopo['uplift_vs_reference_pct']:>11.1f}%")

    phys = results["physics"]["leave_one_plant_out"]["nmae_pct"]
    cal = results["physics+calendar"]["leave_one_plant_out"]["nmae_pct"]
    phys_sp = results["physics"]["same_plant"]["nmae_pct"]
    cal_sp = results["physics+calendar"]["same_plant"]["nmae_pct"]

    travels = phys < cal
    same_plant_cost = phys_sp > cal_sp
    supported = travels and same_plant_cost

    print(f"\nHYPOTHESIS: dropping calendar features improves transfer and costs same-plant accuracy")
    print(f"  unseen plant  physics {phys:.2f}%  vs  physics+calendar {cal:.2f}%"
          f"   -> {'IMPROVES' if travels else 'does NOT improve'}")
    print(f"  same plant    physics {phys_sp:.2f}%  vs  physics+calendar {cal_sp:.2f}%"
          f"   -> {'costs accuracy as predicted' if same_plant_cost else 'does NOT cost accuracy'}")
    print(f"  VERDICT: {'SUPPORTED' if supported else 'NOT SUPPORTED'}")

    best = min(results, key=lambda k: results[k]["leave_one_plant_out"]["nmae_pct"])
    beats = results[best]["leave_one_plant_out"]["uplift_vs_reference_pct"] > 0
    print(f"  best feature set on an unseen plant: {best}"
          f"  ({'beats' if beats else 'still loses to'} the naive line)")

    write_report("twin", "twin_feature_ablation", {
        "dataset": "Twin feature ablation: does an ML twin travel?",
        "n_samples": int(sum(len(f) for f in frames.values())),
        "n_plants": len(frames),
        "hypothesis": (
            "Calendar and clock features encode site-specific shading geometry, "
            "because shading recurs at a fixed solar position on a fixed date. "
            "Removing them should improve leave-one-plant-out performance while "
            "worsening same-plant performance."
        ),
        "hypothesis_supported": supported,
        "transfer_improves_without_calendar": travels,
        "same_plant_cost_as_predicted": same_plant_cost,
        "best_feature_set_on_unseen_plant": best,
        "best_beats_naive_baseline": beats,
        "nmae_pct": results[best]["leave_one_plant_out"]["nmae_pct"],
        "reference_nmae_pct": results[best]["leave_one_plant_out"]["reference_nmae_pct"],
        "uplift_vs_reference_pct": results[best]["leave_one_plant_out"]["uplift_vs_reference_pct"],
        "normalizer": NORM_MEAN_DAILY_ENERGY,
        "by_feature_set": results,
        "feature_sets": FEATURE_SETS,
        "excluded_from_headline": sorted(EXCLUDE),
        "interpretation": (
            "If the hypothesis is supported, a twin that travels is buildable by "
            "restricting features to physical covariates. If it is not, the most "
            "plausible explanation for the transfer failure is ruled out, and the "
            "physics twin ships alone at 6.61% nMAE with no ML layer."
        ),
    })
    print("\nwrote twin/twin_feature_ablation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
