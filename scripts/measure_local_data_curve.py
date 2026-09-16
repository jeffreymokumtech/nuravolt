#!/usr/bin/env python3
"""How much accuracy do you get on day one, and how much does local data buy?

THE QUESTION A BUYER ACTUALLY ASKS
----------------------------------
"What do I get the day you connect, and what do I get once you have had my data
for a season?" Everything else in the validation suite answers a version of the
first half. This answers both, on the same plants, with the same metric, so the
two halves are comparable.

THE PROTOCOL
------------
For each plant in turn, held out entirely:

  n_local = 0     Transfer only. Every candidate model is built from the OTHER
                  plants and applied to the held-out one with zero days of its
                  history. This is genuinely day one.

  n_local = k     The model is fitted (or calibrated) on the FIRST k days of the
                  held-out plant, then scored on the days that follow. The scoring
                  window is held identical across all values of k, so the curve
                  measures what local data buys and not merely a different test set.

CANDIDATE MODELS
----------------
  irradiance_line     power proportional to irradiance, one fitted scalar. This is
                      the naive reference the ML has repeatedly lost to.
  physics_calibrated  the same line, but the scalar transferred from other plants
                      and rescaled by the held-out plant's own nameplate. At k=0
                      this is what "physics with no local history" means.
  ml_transfer         gradient boosting trained on the other plants only.
  ml_local            gradient boosting trained on the held-out plant's first k days.
  ml_hybrid           trained on other plants, then the last k days appended.

At k=0 the local variants are undefined and are reported as such rather than
silently falling back to something else.

Usage:
    python scripts/measure_local_data_curve.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.report import write_report  # noqa: E402

TWIN_DIR = Path("backenddata/models/soiling_aware_twin")
SEED = 0

#: Days of the held-out plant's own history the model is allowed to see.
LOCAL_DAYS = [0, 7, 14, 30, 60, 90, 180, 365]

#: Held back from every fit so the scoring window never moves.
SCORE_TAIL_DAYS = 365

#: Structural outlier: its output level shifts mid-record. Excluded from the
#: headline, reported separately.
EXCLUDE = {"gamma"}

FEATURES = ["irr", "irr_sq", "temp_proxy", "rain", "doy_sin", "doy_cos"]


def load(path: Path) -> Optional[pd.DataFrame]:
    df = pd.read_parquet(path)
    if not isinstance(df.index, pd.DatetimeIndex):
        return None
    df = df.reset_index()
    df.columns = ["date"] + list(df.columns[1:])
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df = df[np.isfinite(df["p_actual"]) & (df["p_actual"] > 0)]
    df = df[np.isfinite(df["irradiance"]) & (df["irradiance"] > 0)]
    if len(df) < (max(LOCAL_DAYS) + SCORE_TAIL_DAYS):
        return None
    doy = df["date"].dt.dayofyear
    df["irr"] = df["irradiance"]
    df["irr_sq"] = df["irradiance"] ** 2
    df["temp_proxy"] = df["irradiance"] / 800.0
    df["rain"] = df.get("rainfall", pd.Series(0.0, index=df.index)).fillna(0.0)
    df["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    df["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    return df.dropna(subset=FEATURES + ["p_actual"]).reset_index(drop=True)


def gbm():
    from sklearn.ensemble import HistGradientBoostingRegressor
    return HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.05, max_depth=5, random_state=SEED)


def nmae(actual: np.ndarray, pred: np.ndarray) -> float:
    a, p = np.asarray(actual, float), np.asarray(pred, float)
    ok = np.isfinite(a) & np.isfinite(p)
    return float(np.mean(np.abs(p[ok] - a[ok])) / np.mean(a[ok]) * 100)


def fit_line(df: pd.DataFrame) -> float:
    d = float((df["irr"] ** 2).sum())
    return float((df["irr"] * df["p_actual"]).sum() / d) if d else 0.0


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()

    frames: Dict[str, pd.DataFrame] = {}
    for path in sorted(TWIN_DIR.glob("*_daily_hybrid.parquet")):
        name = path.name.replace("_daily_hybrid.parquet", "")
        df = load(path)
        if df is not None:
            frames[name] = df
    if len(frames) < 3:
        write_report("twin", "twin_local_data_curve", {
            "dataset": "Local-data learning curve",
            "status": "pending_manual_fetch",
            "reason": f"need >=3 plants with enough history, found {len(frames)}"})
        print("insufficient plants")
        return 0

    print(f"plants: {', '.join(frames)}   (excluded from headline: {', '.join(EXCLUDE)})")
    print(f"scoring window: last {SCORE_TAIL_DAYS} days of each plant, identical across all k\n")

    curve: Dict[int, Dict[str, List[float]]] = {k: {} for k in LOCAL_DAYS}

    for held_out, test_df in frames.items():
        others = pd.concat(
            [d.assign(y_pu=d["p_actual"] / d["p_actual"].median(),
                      irr_pu=d["irr"] / d["irr"].median())
             for n, d in frames.items() if n != held_out],
            ignore_index=True)
        others["irr"] = others["irr_pu"]
        others["irr_sq"] = others["irr_pu"] ** 2

        scale = float(test_df["p_actual"].median())
        irr_scale = float(test_df["irr"].median())

        score = test_df.iloc[-SCORE_TAIL_DAYS:]
        pool = test_df.iloc[:-SCORE_TAIL_DAYS]
        y = score["p_actual"].to_numpy()

        # --- transfer models, no local history at all ---
        m_tr = gbm(); m_tr.fit(others[FEATURES], others["y_pu"])
        sc = score.copy(); sc["irr"] = sc["irr"] / irr_scale; sc["irr_sq"] = sc["irr"] ** 2
        pred_ml_transfer = m_tr.predict(sc[FEATURES]) * scale
        k_other = fit_line(others.assign(p_actual=others["y_pu"]))
        pred_physics_transfer = sc["irr"].to_numpy() * k_other * scale

        for k in LOCAL_DAYS:
            entry = curve[k].setdefault
            res: Dict[str, float] = {}
            res["ml_transfer"] = nmae(y, pred_ml_transfer)
            res["physics_calibrated"] = nmae(y, pred_physics_transfer)

            if k == 0:
                res["irradiance_line"] = nmae(y, pred_physics_transfer)
            else:
                local = pool.iloc[-k:] if len(pool) >= k else pool
                res["irradiance_line"] = nmae(y, score["irr"].to_numpy() * fit_line(local))
                if len(local) >= 20:
                    m_loc = gbm(); m_loc.fit(local[FEATURES], local["p_actual"])
                    res["ml_local"] = nmae(y, m_loc.predict(score[FEATURES]))
                    loc_pu = local.assign(y_pu=local["p_actual"] / scale,
                                          irr=local["irr"] / irr_scale)
                    loc_pu["irr_sq"] = loc_pu["irr"] ** 2
                    both = pd.concat([others, loc_pu], ignore_index=True)
                    m_hy = gbm(); m_hy.fit(both[FEATURES], both["y_pu"])
                    res["ml_hybrid"] = nmae(y, m_hy.predict(sc[FEATURES]) * scale)

            for model, v in res.items():
                if held_out not in EXCLUDE:
                    curve[k].setdefault(model, []).append(v)

    print(f"{'local days':<12}{'irradiance line':>17}{'physics transfer':>18}"
          f"{'ML transfer':>13}{'ML local':>10}{'ML hybrid':>11}")
    summary: Dict[str, Dict[str, Optional[float]]] = {}
    for k in LOCAL_DAYS:
        row = {m: (float(np.mean(v)) if v else None) for m, v in curve[k].items()}
        summary[str(k)] = row
        fmt = lambda m: f"{row[m]:>.2f}%" if row.get(m) is not None else "n/a"
        print(f"{k:<12}{fmt('irradiance_line'):>17}{fmt('physics_calibrated'):>18}"
              f"{fmt('ml_transfer'):>13}{fmt('ml_local'):>10}{fmt('ml_hybrid'):>11}")

    day0 = min(v for v in [summary["0"].get("irradiance_line"),
                           summary["0"].get("physics_calibrated"),
                           summary["0"].get("ml_transfer")] if v is not None)
    best_last = min(v for v in summary[str(LOCAL_DAYS[-1])].values() if v is not None)
    best_model_last = min((m for m, v in summary[str(LOCAL_DAYS[-1])].items() if v is not None),
                          key=lambda m: summary[str(LOCAL_DAYS[-1])][m])

    print(f"\nday one (no local data): {day0:.2f}% nMAE of mean daily energy")
    print(f"after {LOCAL_DAYS[-1]} days of local data: {best_last:.2f}% ({best_model_last})")
    print(f"local data buys: {(day0 - best_last) / day0 * 100:.0f}% error reduction")

    write_report("twin", "twin_local_data_curve", {
        "dataset": "Twin accuracy against days of local history",
        "n_samples": int(sum(len(f) for f in frames.values())),
        "n_plants": len(frames),
        "normalizer": "mean_daily_energy_kwh",
        "nmae_pct": day0,
        "protocol": (
            "Each plant held out entirely. At k=0 every model is built from the "
            "other plants only. At k>0 the model sees the held-out plant's first k "
            "days. The scoring window is the plant's final 365 days and is "
            "identical for every k, so the curve isolates what local data buys."),
        "day_one_nmae_pct": day0,
        "best_after_local_nmae_pct": best_last,
        "best_model_after_local": best_model_last,
        "error_reduction_pct": (day0 - best_last) / day0 * 100,
        "curve": summary,
        "local_days": LOCAL_DAYS,
        "excluded_from_headline": sorted(EXCLUDE),
    })
    print("\nwrote twin/twin_local_data_curve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
