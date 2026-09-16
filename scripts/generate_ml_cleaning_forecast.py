#!/usr/bin/env python3
"""Generate 365-day ML cleaning forecast for a plant.

This is the canonical entry point for producing
``public/data/soiling/{plant_id}/ml_forecast_365d.json`` — the file the
SR forecast chart and cleaning optimizer both consume.

Pipeline:
1. Resolve the plant's climate zone via ``nuravolt.soiling.climate_regions``.
2. Build a climatology-driven daily SR trajectory using the zone's
   ``ClimatePrior`` (monthly soiling rate + rain days + recovery threshold).
3. Load the zone's foundation model if it exists, build a synthetic
   feature frame for the 365-day window (climatology-driven environmental
   features + plant-static features), and call ``model.predict()``.
4. Apply the climatology guard rail: for each month, if the model's
   monthly Δ disagrees with climatology Δ in sign OR magnitude by more
   than the tolerance, blend the model output toward climatology.
5. Write JSON with full provenance (zone, model_version, guard-rail
   trigger flags by month).

The old hardcoded sinusoidal stub is gone — every forecast now ties to
either a trained per-zone model or the zone's climatology prior. No more
inverted seasonality.

Usage:
    python scripts/generate_ml_cleaning_forecast.py [plant_id ...]

    # All known plants (default)
    python scripts/generate_ml_cleaning_forecast.py
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# Make repo root importable when called as a plain script.
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nuravolt.soiling.climate_regions import (  # noqa: E402
    CLIMATE_PRIORS,
    ClimatePrior,
    ClimateZone,
    PLANT_CLIMATE,
    prior_for_plant,
    resolve_zone,
)
from nuravolt.soiling.sr_foundation_model import load_model_for_zone  # noqa: E402
from nuravolt.soiling.sr_transfer_features import PLANT_CONFIGS, PlantConfig  # noqa: E402

DATA_ROOT = REPO_ROOT / "public" / "data" / "soiling"
MODELS_DIR = REPO_ROOT / "backenddata" / "models"

# Guard-rail tolerance: how much the model's monthly Δ can disagree with
# the climatology Δ before we blend toward climatology. Picked at 3pp
# because soiling rates of 0.2-0.5%/day produce monthly Δ in the
# 5-15pp range — a 3pp tolerance lets the model retain 50-80% of its
# signal while clipping cases where the sign is wrong.
GUARD_TOLERANCE_PP = 3.0
GUARD_FULL_BLEND_PP = 9.0  # disagreement at which weight → 100% climatology
GUARD_MAX_WEIGHT = 0.85    # never go past 85% climatology (preserve model contribution)

DEFAULT_PLANTS = sorted(PLANT_CLIMATE.keys())


# ──────────────────────────────────────────────────────────────────────────
# Climatology simulator
# ──────────────────────────────────────────────────────────────────────────


@dataclass
class ClimatologyTrajectory:
    dates: List[date]
    sr: List[float]
    rain_days: List[bool]
    monthly_delta_pp: Dict[int, float]  # month → end-of-month SR − start-of-month SR (in pp)


def simulate_climatology_trajectory(
    prior: ClimatePrior,
    start: date,
    n_days: int = 365,
    seed: int = 42,
) -> ClimatologyTrajectory:
    """Run a deterministic climatology simulation for ``n_days``.

    SR starts at 1.0 and decays by the zone's monthly soiling rate per
    day. Random rain events (Poisson-distributed by month, sized at the
    zone's recovery threshold) restore SR to 1.0. The output is what
    you'd expect a clean panel at this location to look like over the
    next year *without* cleanings — the guard rail compares the model
    output against this trajectory.
    """
    rng = np.random.default_rng(seed)
    sr_today = 1.0
    sr_series: List[float] = []
    rain_flags: List[bool] = []
    date_series: List[date] = []

    for offset in range(n_days):
        d = start + timedelta(days=offset)
        month = d.month
        rate_per_day = prior.soiling_rate_for_month(month) / 100.0  # convert %/day → fraction

        # Poisson rain event: probability scales with monthly rain days / 30
        rain_prob = prior.rain_days_for_month(month) / 30.0
        rain_today = rng.random() < rain_prob

        if rain_today:
            # Recovery threshold is the rain depth needed to fully wash.
            # We assume each rain event meets the threshold (climatology
            # simplification); real-world variability is the model's job.
            sr_today = 1.0
        else:
            sr_today = max(0.70, sr_today - rate_per_day)

        date_series.append(d)
        sr_series.append(sr_today)
        rain_flags.append(rain_today)

    # Monthly Δ in percentage points
    df = pd.DataFrame({"date": date_series, "sr": sr_series})
    df["month"] = pd.to_datetime(df["date"]).dt.month
    by_month = df.groupby("month")
    monthly_delta = {int(m): float((g["sr"].iloc[-1] - g["sr"].iloc[0]) * 100) for m, g in by_month}

    return ClimatologyTrajectory(
        dates=date_series,
        sr=sr_series,
        rain_days=rain_flags,
        monthly_delta_pp=monthly_delta,
    )


# ──────────────────────────────────────────────────────────────────────────
# Model feature frame builder
# ──────────────────────────────────────────────────────────────────────────


def build_inference_features(
    plant_id: str,
    prior: ClimatePrior,
    dates: List[date],
    plant_config: Optional[PlantConfig],
    feature_names: List[str],
) -> pd.DataFrame:
    """Construct a feature frame the foundation model can consume for
    forward forecasting.

    The model was trained on rich features (hybrid model loss, MERRA-2
    extinction, etc.) that aren't computable for *future* days without
    real-time SCADA + reanalysis pipelines. For 365-day forward
    forecasting we synthesise placeholder values from climatology +
    plant-static metadata. The guard rail catches cases where this
    placeholder mismatch makes the model produce nonsense.

    Strategy per feature:
    - Temporal (day_of_year_sin/cos, month_sin/cos, is_dry_season,
      season_of_year): derived from date + zone prior.
    - Plant-static (latitude_abs, altitude_m, is_coastal, p_rated):
      from PLANT_CONFIGS.
    - Environmental (aod_*, rainfall_*, pm10_*, etc.): from the
      zone's climatology prior (monthly_aod_typical / monthly_rain_days).
    - Hybrid-model-derived (hybrid_loss_pct, *_mean_7d/14d, etc.):
      filled with 0 so the model leans on the other features.
    """
    n = len(dates)
    df = pd.DataFrame(index=pd.DatetimeIndex(dates))

    # Temporal features
    doy = np.array([d.timetuple().tm_yday for d in dates])
    month = np.array([d.month for d in dates])
    df["day_of_year_sin"] = np.sin(2 * np.pi * doy / 365.0)
    df["day_of_year_cos"] = np.cos(2 * np.pi * doy / 365.0)
    df["month_sin"] = np.sin(2 * np.pi * month / 12.0)
    df["month_cos"] = np.cos(2 * np.pi * month / 12.0)
    df["is_dry_season"] = np.array([1 if prior.is_dry_season(m) else 0 for m in month])

    # Plant-static
    if plant_config is not None:
        df["latitude_abs"] = abs(plant_config.latitude)
        df["altitude_m"] = plant_config.altitude
        df["is_coastal"] = 1 if plant_config.is_coastal else 0
    else:
        df["latitude_abs"] = 38.0  # mid-Mediterranean fallback
        df["altitude_m"] = 100.0
        df["is_coastal"] = 0

    # Environmental — climatology-driven
    aod_mean = np.array([prior.aod_for_month(m) for m in month])
    rain_days_month = np.array([prior.rain_days_for_month(m) for m in month])
    rate_per_day = np.array([prior.soiling_rate_for_month(m) / 100.0 for m in month])

    df["aod_mean_7d"] = aod_mean
    df["aod_mean_14d"] = aod_mean
    df["dust_aod_mean_7d"] = aod_mean * 0.45  # dust typically ~45% of total AOD
    df["dust_aod_mean_14d"] = aod_mean * 0.45
    df["is_high_aod"] = (aod_mean > 0.25).astype(int)
    df["pm10_mean_7d"] = aod_mean * 100  # rough scaling for climatology
    df["pm2p5_mean_7d"] = aod_mean * 40
    df["sea_salt_aod"] = 0.02 * (1 + df["is_coastal"])
    df["sea_salt_aod_mean_7d"] = 0.02 * (1 + df["is_coastal"])
    df["is_high_sea_salt"] = 0
    df["sea_salt_pct"] = 0.1 + df["is_coastal"] * 0.15
    df["organic_aod_mean_7d"] = 0.02
    df["sulphate_aod_mean_7d"] = 0.04
    df["dust_extinction"] = aod_mean * 0.3
    df["seasalt_extinction"] = df["sea_salt_aod"] * 0.3

    df["rainfall_7d"] = rain_days_month / 30.0 * 5.0 * 7  # ~5mm/event × prob
    df["rainfall_14d"] = df["rainfall_7d"] * 2
    df["rainfall_30d"] = rain_days_month * 5.0
    df["days_since_rain"] = np.minimum(30, 30 / np.maximum(0.1, rain_days_month))
    df["is_heavy_rain"] = 0

    df["soil_moisture_mean_7d"] = 0.15 + (rain_days_month / 30.0) * 0.2
    df["is_dry_soil"] = (df["soil_moisture_mean_7d"] < 0.15).astype(int)

    # Hybrid-model-derived placeholders. The trained model uses these as
    # strong signals; for forward forecasting we don't have them so we
    # set conservative values that won't trigger spurious cleaning.
    hybrid_default = float(np.mean(rate_per_day) * 100)  # ~ avg daily loss %
    for col in [
        "P_hybrid",
        "P_physics",
        "ml_residual",
        "hybrid_loss_pct",
        "hybrid_loss_pct_mean_7d",
        "hybrid_loss_pct_mean_14d",
        "hybrid_loss_pct_mean_30d",
        "hybrid_loss_pct_trend_7d",
        "hybrid_loss_pct_trend_14d",
        "physics_loss_pct",
        "physics_loss_pct_mean_7d",
        "current_cv",
        "voltage_cv",
        "temp_deviation",
        "soiling_signature_score",
        "power_loss_pct",
        "current_loss_pct",
        "voltage_loss_pct",
    ]:
        df[col] = hybrid_default if "hybrid" in col else 0.0

    # Snow features (relevant for Temperate Continental zone only)
    df["snowfall_7d"] = 0.0
    df["snowfall_30d"] = 0.0
    df["days_since_snow"] = 999.0
    df["has_snow"] = 0
    df["wind_mean_7d"] = 3.0  # m/s typical
    df["wind_max_7d"] = 6.0
    df["humidity_mean_7d"] = 60.0
    df["dewpoint_mean_7d"] = 10.0
    df["dew_cleaning"] = 0
    df["natural_cleaning"] = 0

    # Add any model-expected columns we missed, filling with 0
    for col in feature_names:
        if col not in df.columns:
            df[col] = 0.0

    # Reorder to match training schema
    df = df[feature_names]
    return df


# ──────────────────────────────────────────────────────────────────────────
# Climatology guard rail
# ──────────────────────────────────────────────────────────────────────────


def climatology_guard_rail(
    model_sr: np.ndarray,
    climatology_sr: np.ndarray,
    dates: List[date],
    prior: ClimatePrior,
) -> Tuple[np.ndarray, Dict[int, Dict[str, float]]]:
    """Blend the model's daily SR series toward climatology where the
    model's monthly trend disagrees with the prior.

    Returns the blended series + a per-month diagnostic dict (model Δ,
    climatology Δ, blend weight applied, blended flag).
    """
    df = pd.DataFrame({
        "date": pd.DatetimeIndex(dates),
        "model": model_sr,
        "climatology": climatology_sr,
    })
    df["month"] = df["date"].dt.month

    blended = model_sr.copy()
    diagnostics: Dict[int, Dict[str, float]] = {}

    for month, group in df.groupby("month"):
        idx = group.index.to_numpy()
        if len(idx) < 2:
            continue
        model_delta_pp = (group["model"].iloc[-1] - group["model"].iloc[0]) * 100
        climo_delta_pp = (group["climatology"].iloc[-1] - group["climatology"].iloc[0]) * 100

        disagreement_pp = abs(model_delta_pp - climo_delta_pp)
        sign_mismatch = np.sign(model_delta_pp) != np.sign(climo_delta_pp) and abs(model_delta_pp) > 0.5

        if disagreement_pp <= GUARD_TOLERANCE_PP and not sign_mismatch:
            weight = 0.0
        else:
            # Linear ramp from tolerance → full-blend; cap at GUARD_MAX_WEIGHT
            raw_weight = min(
                (disagreement_pp - GUARD_TOLERANCE_PP) / (GUARD_FULL_BLEND_PP - GUARD_TOLERANCE_PP),
                1.0,
            )
            weight = min(GUARD_MAX_WEIGHT, max(0.0, raw_weight))
            if sign_mismatch:
                # If the sign is wrong, force at least 50% climatology
                weight = max(weight, 0.5)

        if weight > 0:
            blended[idx] = (1 - weight) * model_sr[idx] + weight * climatology_sr[idx]

        diagnostics[int(month)] = {
            "model_delta_pp": float(round(model_delta_pp, 2)),
            "climatology_delta_pp": float(round(climo_delta_pp, 2)),
            "disagreement_pp": float(round(disagreement_pp, 2)),
            "sign_mismatch": bool(sign_mismatch),
            "blend_weight_climatology": float(round(weight, 2)),
        }

    return blended, diagnostics


# ──────────────────────────────────────────────────────────────────────────
# Forecast generator entry point
# ──────────────────────────────────────────────────────────────────────────


def generate_ml_cleaning_forecast(
    plant_id: str,
    output_dir: Optional[Path] = None,
    start_date: Optional[date] = None,
    n_days: int = 365,
) -> bool:
    """Produce ``ml_forecast_365d.json`` for ``plant_id`` and return success."""
    if output_dir is None:
        output_dir = DATA_ROOT / plant_id
    output_dir.mkdir(parents=True, exist_ok=True)

    start = start_date or date.today()
    plant_config = PLANT_CONFIGS.get(plant_id)
    lat = plant_config.latitude if plant_config else None
    lon = plant_config.longitude if plant_config else None
    zone = resolve_zone(plant_id, lat, lon)
    prior = CLIMATE_PRIORS[zone]

    print(f"\n— {plant_id} ({zone.value}) —")
    print(f"  start={start.isoformat()}  n_days={n_days}  zone_prior={zone.value}")

    # 1. Climatology trajectory (always the guard-rail baseline)
    climo = simulate_climatology_trajectory(prior, start, n_days=n_days)
    climo_sr = np.array(climo.sr)
    print(f"  climatology: SR range {climo_sr.min():.3f}–{climo_sr.max():.3f}")

    # 2. Load the zone's model, if any
    model = load_model_for_zone(zone, MODELS_DIR)
    if model is None:
        print(f"  no foundation model for {zone.value} — using climatology only")
        final_sr = climo_sr
        diagnostics: Dict[int, Dict[str, float]] = {}
        model_version = f"climate_prior_{zone.value}_v1"
    else:
        # 3. Build the inference feature frame
        feat_df = build_inference_features(
            plant_id, prior, climo.dates, plant_config, model.feature_names
        )
        print(f"  model: {len(model.feature_names)} features, predicting {len(feat_df)} days")

        # 4. Predict
        model_pred = model.predict(feat_df.values, apply_bias=True)

        # Light smoothing (7-day rolling) so the daily noise from
        # placeholder features doesn't pollute the chart.
        model_pred_smoothed = pd.Series(model_pred).rolling(window=7, min_periods=1).mean().values

        # 5. Guard rail
        final_sr, diagnostics = climatology_guard_rail(
            model_pred_smoothed, climo_sr, climo.dates, prior
        )
        triggered = [m for m, d in diagnostics.items() if d["blend_weight_climatology"] > 0]
        print(f"  model SR range {model_pred_smoothed.min():.3f}–{model_pred_smoothed.max():.3f}")
        print(f"  final SR range {final_sr.min():.3f}–{final_sr.max():.3f}")
        print(f"  guard-rail blended months: {triggered or 'none'}")
        model_version = f"climate_aware_{zone.value}_v2"

    # 6. Write JSON in the same shape the UI expects
    forecasts = []
    for i, d in enumerate(climo.dates):
        sr_pred = float(np.clip(final_sr[i], 0.70, 1.0))
        forecasts.append({
            "date": d.isoformat(),
            "sr_physics": 0.0,
            "sr_ml_correction": 0.0,
            "sr_predicted": sr_pred,
            "soiling_loss_pct": float(round((1 - sr_pred) * 100, 3)),
            "is_cleaning_needed": sr_pred < 0.85,
            "sr_lower_bound": float(round(max(0.70, sr_pred - 0.02), 4)),
            "sr_upper_bound": float(round(min(1.0, sr_pred + 0.02), 4)),
        })

    output = {
        "metadata": {
            "plant_id": plant_id,
            "forecast_period": {
                "start": climo.dates[0].isoformat(),
                "end": climo.dates[-1].isoformat(),
            },
            "n_days": n_days,
            "model_type": "ml_climate_aware" if model is not None else "climate_prior_only",
            "model_version": model_version,
            "climate_zone": zone.value,
            "dominant_dust_source": prior.dominant_dust_source,
            "guard_rail": {
                "tolerance_pp": GUARD_TOLERANCE_PP,
                "max_climatology_weight": GUARD_MAX_WEIGHT,
                "monthly_diagnostics": diagnostics,
            },
            "generated_at": datetime.now().isoformat(),
        },
        "forecasts": forecasts,
    }

    out_path = output_dir / "ml_forecast_365d.json"
    out_path.write_text(json.dumps(output, indent=2))
    print(f"  ✓ wrote {out_path.relative_to(REPO_ROOT)}")
    return True


def main(argv: Optional[List[str]] = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    plants = argv if argv else DEFAULT_PLANTS

    print("=" * 60)
    print("ML cleaning forecast generator (climate-aware)")
    print("=" * 60)
    print(f"Target plants ({len(plants)}): {plants}")

    success = 0
    for plant_id in plants:
        try:
            if generate_ml_cleaning_forecast(plant_id):
                success += 1
        except Exception as e:
            print(f"  ✗ {plant_id} failed: {e}")
            import traceback
            traceback.print_exc()

    print(f"\n{'=' * 60}")
    print(f"Done — {success}/{len(plants)} successful")
    print("=" * 60)
    return 0 if success == len(plants) else 1


if __name__ == "__main__":
    sys.exit(main())
