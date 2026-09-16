#!/usr/bin/env python3
"""Cross-dataset validation of the module_degradation RUL model.

Phase N-3. The 7 RUL models in `models/rul/` were trained on Lazzaretti
synthetic labels. We've never tested them outside that distribution.

Sandia PV-IV-EL has 438 modules measured 0-3000 days of outdoor exposure
with real Pmpp + nameplate. For each module with ≥3 measurements:
  - Compute observed_fade_pct_per_year (linear slope of Pmp/Nameplate)
  - For each measurement, feed module_degradation RUL with the inputs it
    expects and capture predicted days_to_fault
  - Check correlation between observed_fade_rate vs predicted_days_to_fault
    (faster faders should have shorter predicted EOL)

Honest expectation: model trained on Lazzaretti's synthetic PR (where
"degradation" is a series-resistor snapshot) likely won't generalize well
to PV-IV-EL's actual outdoor fade. The Spearman correlation will tell us
how predictions correlate with reality. Negative or weak correlation =
the model doesn't transfer; strong negative correlation (faster fade →
shorter predicted EOL) = it transfers despite the training mismatch.

Usage:
    python scripts/validate_rul_cross_dataset.py
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

from nuravolt.fault.rul_predictor import RULPredictor
from nuravolt.validation.report import write_report


ANONDB_CSV = REPO_ROOT / "backenddata" / "datasets" / "sandia_pv_iv_el" / "AnonDB.csv"


def _days_from_str(s):
    if s is None:
        return None
    m = re.search(r"(\d+)", str(s))
    return int(m.group(1)) if m else None


def main() -> int:
    if not ANONDB_CSV.exists():
        print(f"Missing {ANONDB_CSV}. Run scripts/fetch_sandia_pv_iv_el.py first.")
        return 1

    print("=" * 60)
    print(" PV RUL cross-dataset validation — module_degradation on PV-IV-EL")
    print("=" * 60)

    df = pl.read_csv(ANONDB_CSV, infer_schema_length=10000, ignore_errors=True)
    df = df.with_columns([
        pl.col("Total_Exposure").map_elements(_days_from_str, return_dtype=pl.Int32).alias("exposure_days"),
        (pl.col("Pmp_(W)") / pl.col("Nameplate_Pmp_(W)")).alias("pr_proxy"),
    ])
    df = df.filter(pl.col("exposure_days").is_not_null() & pl.col("pr_proxy").is_finite())

    # Load RUL predictor
    predictor = RULPredictor(str(REPO_ROOT / "models" / "rul"))
    if "module_degradation" not in predictor.models:
        print("module_degradation RUL model missing")
        return 1
    model = predictor.models["module_degradation"]
    print(f"\n  loaded model with features: {model.feature_columns}")

    # Per-module: compute observed fade rate + feed RUL with each measurement
    per_module = []
    for mod_id in df["Mod_ID"].unique().to_list():
        sub = df.filter(pl.col("Mod_ID") == mod_id).sort("exposure_days")
        if len(sub) < 3:
            continue
        days = sub["exposure_days"].to_numpy().astype(float)
        prs = sub["pr_proxy"].to_numpy().astype(float)
        if days.max() - days.min() < 365:
            continue
        slope_per_day, intercept = np.polyfit(days, prs, 1)
        observed_fade_pct_per_year = -slope_per_day * 365 * 100   # positive = fading

        # Use last measurement as the "current" state to feed the RUL
        latest_pr = float(prs[-1])
        # Approximate pr_trend_30d as slope normalized to 30d
        pr_trend_30d = float(slope_per_day * 30)
        # Build a single-row DataFrame matching the model's feature schema
        features_row = pl.DataFrame({
            "performance_ratio": [latest_pr],
            "pr_trend_30d": [pr_trend_30d],
            "efficiency_trend_30d": [pr_trend_30d],  # approximation
            "pr_acceleration_7d": [0.0],
            "module_temp": [25.0],
            "irradiance_normalized": [1.0],
        })
        try:
            rul_preds = model.predict_from_df(features_row)
        except Exception as e:
            continue
        if not rul_preds:
            continue
        pred = rul_preds[0]
        per_module.append({
            "mod_id": int(mod_id),
            "n_measurements": int(len(sub)),
            "exposure_span_days": int(days.max() - days.min()),
            "latest_pr_proxy": round(latest_pr, 4),
            "observed_fade_pct_per_year": round(float(observed_fade_pct_per_year), 4),
            "predicted_days_to_fault": round(float(pred.days_to_fault), 1),
            "predicted_confidence": round(float(pred.confidence), 3),
        })

    if not per_module:
        print("  No modules with ≥3 measurements over ≥1yr — can't validate.")
        return 1

    print(f"\n  {len(per_module)} modules validated")
    fade = np.array([m["observed_fade_pct_per_year"] for m in per_module])
    pred = np.array([m["predicted_days_to_fault"] for m in per_module])

    # Spearman rank correlation (no scipy needed — use np.argsort)
    fade_rank = fade.argsort().argsort()
    pred_rank = pred.argsort().argsort()
    cov = np.cov(fade_rank, pred_rank)[0, 1]
    std_f = fade_rank.std()
    std_p = pred_rank.std()
    spearman = float(cov / (std_f * std_p)) if (std_f * std_p) > 0 else 0.0

    # Expected: faster fade → shorter predicted EOL → NEGATIVE correlation
    print(f"\n  Observed fade rate:      mean {fade.mean():.3f} %/yr, p25-p75 {np.percentile(fade,25):.3f}-{np.percentile(fade,75):.3f}")
    print(f"  Predicted days-to-fault: mean {pred.mean():.0f}, p25-p75 {np.percentile(pred,25):.0f}-{np.percentile(pred,75):.0f}")
    print(f"  Spearman correlation (fade_rate vs predicted_eol): {spearman:.3f}")
    print(f"  Expected sign: NEGATIVE (faster fade → shorter EOL)")

    interpretation = (
        "STRONG NEGATIVE — model transfers despite training mismatch" if spearman < -0.5
        else "WEAK NEGATIVE — partial transfer" if spearman < -0.1
        else "NO CORRELATION — model doesn't generalize to PV-IV-EL distribution" if abs(spearman) < 0.1
        else "POSITIVE — model fundamentally mis-predicts on this dataset"
    )
    print(f"  Interpretation: {interpretation}")

    payload = {
        "dataset": "module_degradation RUL on Sandia PV-IV-EL",
        "n_samples": len(per_module),
        "n_modules_validated": len(per_module),
        "spearman_correlation_fade_vs_eol": round(spearman, 4),
        "expected_sign": "negative",
        "interpretation": interpretation,
        "fade_rate_distribution_pct_per_year": {
            "mean": round(float(fade.mean()), 4),
            "p25": round(float(np.percentile(fade, 25)), 4),
            "p50": round(float(np.median(fade)), 4),
            "p75": round(float(np.percentile(fade, 75)), 4),
        },
        "predicted_eol_days_distribution": {
            "mean": round(float(pred.mean()), 1),
            "p25": round(float(np.percentile(pred, 25)), 1),
            "p50": round(float(np.median(pred)), 1),
            "p75": round(float(np.percentile(pred, 75)), 1),
        },
        "sample_modules": per_module[:20],
        "note": (
            "Cross-dataset validation. module_degradation RUL was trained on "
            "Lazzaretti synthetic 'degradation' labels (series-resistor "
            "snapshots) — testing whether it generalizes to PV-IV-EL real "
            "outdoor fade. Spearman correlation between observed fade rate "
            "and predicted EOL is the honest transfer metric."
        ),
    }
    out_path = write_report("pv", "rul_cross_dataset", payload)
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
