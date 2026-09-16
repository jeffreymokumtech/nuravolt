#!/usr/bin/env python3
"""Forecast validation: normalised error plus skill score against a baseline.

Sub-commands
------------
``dayahead_alpha``
    Day-ahead plant energy forecast on real 15-minute SCADA, scored against a
    persistence baseline ("same as yesterday"). Today this is an *endogenous*
    forecast: lags of the plant's own energy plus solar geometry and calendar,
    with no weather forecast feed. That is exactly what a site with no numerical
    weather prediction (NWP) connection looks like, and the skill score says
    honestly how much that is worth.

``soiling_sr_ribera``
    Soiling-ratio forecast against a DustIQ reference, walk-forward. Published
    at a one-day horizon only: ``scripts/backtest_forecast.py`` currently reuses
    one prediction for every horizon (see its "use same predictions for all
    horizons" comment), so the multi-horizon rows in its report are not real and
    are not published here.

A note on the physics comparison
--------------------------------
The physics model driven by *observed* irradiance is included as
``physics_perfect_irradiance``. It is an oracle upper bound, not a fair
baseline: a real forecast cannot know tomorrow's irradiance. It is reported so
the gap between "what physics could do with perfect weather" and "what we
achieve without a weather feed" is visible. The genuine physics-versus-machine-
learning comparison arrives with the NWP fetch (see the module docstring of
``scripts/fetch_historical_forecast.py`` once it exists).

Usage:
    python scripts/validate_forecast.py dayahead_alpha
    python scripts/validate_forecast.py all
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nuravolt.validation.metrics.forecast import (  # noqa: E402
    NORM_MEAN,
    compute_forecast_report,
)
from nuravolt.validation.report import write_report  # noqa: E402

SCADA = Path("analyticsbackend_deprecated/data/alpha1/scada.parquet")
POWER_COL = "Alpha (ES): Plant / Power by Inverter (kW)"
IRR_COL = "Alpha (ES): Plant / Irradiation_average (W/m²)"
SR_BACKTEST = Path("backenddata/outputs/backtest_ribera/backtest_report.json")

INTERVAL_HOURS = 0.25
MIN_INTERVALS_PER_DAY = 90   # of 96; below this the day is not comparable
SEED = 0


def _daily_energy() -> Optional[pd.DataFrame]:
    """Aggregate 15-minute plant power to clean daily energy (kWh) + insolation."""
    if not SCADA.exists():
        return None

    df = pd.read_parquet(SCADA, columns=["timestamp", POWER_COL, IRR_COL])
    df["timestamp"] = pd.to_datetime(df["timestamp"], format="%Y.%m.%d %H:%M", errors="coerce")
    df = df.dropna(subset=["timestamp"]).set_index("timestamp").sort_index()

    power = df[POWER_COL].clip(lower=0)
    daily = pd.DataFrame({
        "energy_kwh": power.resample("D").sum() * INTERVAL_HOURS,
        "n_intervals": power.resample("D").count(),
        "insolation": df[IRR_COL].clip(lower=0).resample("D").sum() * INTERVAL_HOURS,
    })
    daily = daily[daily["n_intervals"] >= MIN_INTERVALS_PER_DAY]
    daily = daily[daily["energy_kwh"] > 0]
    return daily.reset_index().rename(columns={"timestamp": "date"})


def cmd_dayahead_alpha() -> None:
    daily = _daily_energy()
    if daily is None or len(daily) < 400:
        write_report(
            "forecast",
            "forecast_dayahead_alpha_endogenous",
            {
                "dataset": "Alpha day-ahead plant energy",
                "status": "pending_manual_fetch",
                "reason": f"{SCADA} missing or too short",
            },
        )
        print("SCADA missing/short; wrote pending report")
        return

    d = daily.copy()
    d["prev_date"] = d["date"].shift(1)
    d["gap_days"] = (d["date"] - d["prev_date"]).dt.days

    # Persistence is only defined when yesterday is genuinely yesterday.
    d["persistence"] = d["energy_kwh"].shift(1)
    d = d[d["gap_days"] == 1].reset_index(drop=True)

    doy = d["date"].dt.dayofyear
    d["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    d["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    for lag in (1, 2, 3, 7):
        d[f"lag_{lag}"] = d["energy_kwh"].shift(lag)
    d["roll_7"] = d["energy_kwh"].shift(1).rolling(7, min_periods=3).mean()
    d["roll_30"] = d["energy_kwh"].shift(1).rolling(30, min_periods=10).mean()
    d = d.dropna().reset_index(drop=True)

    feats = ["doy_sin", "doy_cos", "lag_1", "lag_2", "lag_3", "lag_7", "roll_7", "roll_30"]

    from sklearn.ensemble import HistGradientBoostingRegressor

    # Walk forward: refit yearly-ish, always predicting strictly ahead.
    initial, step = 730, 30
    actual: List[float] = []
    model_pred: List[float] = []
    persistence: List[float] = []
    climatology: List[float] = []
    oracle: List[float] = []
    n_windows = 0

    i = initial
    while i < len(d):
        train, test = d.iloc[:i], d.iloc[i:i + step]
        if len(test) == 0:
            break
        n_windows += 1

        m = HistGradientBoostingRegressor(
            max_iter=300, learning_rate=0.05, max_depth=5, random_state=SEED
        )
        m.fit(train[feats], train["energy_kwh"])
        model_pred.extend(m.predict(test[feats]).tolist())

        # Day-of-year climatology from the training period only.
        clim = train.groupby(train["date"].dt.dayofyear)["energy_kwh"].mean()
        overall = float(train["energy_kwh"].mean())
        climatology.extend(
            [float(clim.get(dd, overall)) for dd in test["date"].dt.dayofyear]
        )

        # Oracle: performance-ratio model fed the observed insolation. Not a
        # baseline a real forecast could match; an upper bound on physics.
        denom = float((train["insolation"] ** 2).sum())
        k = float((train["insolation"] * train["energy_kwh"]).sum() / denom) if denom else 0.0
        oracle.extend((test["insolation"].to_numpy() * k).tolist())

        persistence.extend(test["persistence"].tolist())
        actual.extend(test["energy_kwh"].tolist())
        i += step

    rep = compute_forecast_report(
        dataset="Alpha day-ahead plant energy (endogenous, no weather feed)",
        actual=actual,
        predicted=model_pred,
        baselines={
            "persistence": persistence,
            "climatology": climatology,
            "physics_perfect_irradiance": oracle,
        },
        horizon_hours=24,
        normalizer=NORM_MEAN,
        primary_baseline="persistence",
        driver="endogenous",
        n_windows=n_windows,
        retention={
            "n_days_scored": len(actual),
            "min_intervals_per_day": MIN_INTERVALS_PER_DAY,
            "note": (
                "Days with fewer than 90 of 96 intervals dropped, and days whose "
                "predecessor is not the previous calendar day dropped so the "
                "persistence baseline is well defined on the identical sample."
            ),
        },
        extras={
            "baseline_definitions": {
                "persistence": "yesterday's measured energy",
                "climatology": "day-of-year mean over the training period",
                "physics_perfect_irradiance": (
                    "performance-ratio model fed the OBSERVED insolation. An "
                    "oracle upper bound, not an achievable forecast; shown to "
                    "expose how much of the remaining error is weather "
                    "uncertainty rather than model error."
                ),
            },
            "limitation": (
                "No numerical weather prediction (NWP) input. Every Open-Meteo "
                "call in this repo currently hits the ERA5 reanalysis archive, "
                "which is a record of what already happened and would leak if "
                "used as a forecast input. A true day-ahead skill score needs "
                "archived forecast runs."
            ),
        },
    )
    write_report("forecast", "forecast_dayahead_alpha_endogenous", rep.to_dict())
    out = rep.to_dict()
    print(
        f"  day-ahead: nMAE {out['nmae_pct']:.2f}% vs persistence "
        f"{out['baseline_nmae_pct']:.2f}%  ->  skill {out['skill_score']:+.3f} "
        f"on {out['n_samples']:,} days"
    )
    print(
        f"  oracle (perfect irradiance): "
        f"{out['baselines']['physics_perfect_irradiance']['nmae_pct']:.2f}% nMAE"
    )


def cmd_soiling_sr_ribera() -> None:
    """Publish the one-day-horizon soiling-ratio forecast only. See module docstring."""
    if not SR_BACKTEST.exists():
        write_report(
            "forecast",
            "forecast_soiling_sr_ribera",
            {
                "dataset": "Ribera soiling-ratio forecast vs DustIQ",
                "status": "pending_manual_fetch",
                "reason": f"{SR_BACKTEST} not found",
            },
        )
        print("no Ribera backtest artifact; wrote pending report")
        return

    raw = json.loads(SR_BACKTEST.read_text())
    h1 = (raw.get("horizon_summary") or {}).get("1", {})
    splits = raw.get("split_info") or []
    n_pred = sum(int(sp.get("test_days", 0) or 0) for sp in splits) or None

    payload: Dict = {
        "dataset": "Ribera soiling-ratio forecast vs DustIQ reference",
        "n_samples": n_pred,
        "n_windows": raw.get("n_windows"),
        "horizon_hours": 24,
        "driver": "endogenous",
        "mae_sr_pp": h1.get("mae_pct"),
        "mae_sr_pp_std": h1.get("mae_std"),
        "r2_footnote_only": h1.get("r2"),
        "note": (
            "Soiling ratio error in percentage points (pp): 1.44 means the "
            "estimate was off by 0.0144 of soiling ratio. Only the one-day "
            "horizon is published: scripts/backtest_forecast.py currently reuses "
            "a single prediction for every horizon, so its 3/7/14/21/30-day rows "
            "are identical to the one-day row and are not real multi-horizon "
            "results. R-squared on this series is negative because the test-window "
            "variance of soiling ratio is near zero, which is why error, not "
            "R-squared, is the metric that means anything here."
        ),
        "source_artifact": str(SR_BACKTEST),
    }
    write_report("forecast", "forecast_soiling_sr_ribera", payload)
    print(f"  soiling SR h=1: MAE {payload['mae_sr_pp']:.2f} pp "
          f"(sd {payload['mae_sr_pp_std']:.2f}) over "
          f"{payload['n_windows']} walk-forward windows")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "command",
        choices=["dayahead_alpha", "soiling_sr_ribera", "all"],
        nargs="?",
        default="all",
    )
    args = ap.parse_args()

    if args.command in ("dayahead_alpha", "all"):
        print("== dayahead_alpha ==")
        cmd_dayahead_alpha()
    if args.command in ("soiling_sr_ribera", "all"):
        print("== soiling_sr_ribera ==")
        cmd_soiling_sr_ribera()
    return 0


if __name__ == "__main__":
    sys.exit(main())
