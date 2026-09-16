#!/usr/bin/env python3
"""
Evaluate impact of rain anchor calibration and fleet CV on SR estimation.

This script compares Layer 3 (Transfer) and Layer 4 (Foundation) with and
without the new calibration features:
1. Rain Anchor Calibration - Heavy rain resets SR to ~0.995
2. Fleet CV Features - Uniformity indicator

Compares against DustIQ ground truth on plants with sensors.

Usage:
    python scripts/evaluate_calibration_impact.py
"""

import json
import sys
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.estimation import (
    TransferLearningEstimator,
    FoundationModelEstimator,
    LossDisaggregationEstimator,
    DustIQEstimator,
    RainAnchorConfig,
    FleetCVConfig,
)

# Plants with DustIQ for evaluation
DUSTIQ_PLANTS = ["epsilon", "zeta", "delta", "gamma", "ribera", "eta", "alpha"]

# DustIQ variance per plant (for quality scoring)
DUSTIQ_STD = {
    "epsilon": 0.0358,
    "zeta": 0.0115,
    "ribera": 0.0150,
    "delta": 0.0064,
    "gamma": 0.0181,
    "alpha": 0.0052,
    "eta": 0.0098,
}

# Transfer source plants for cross-validation testing
# For each target, we use a different plant as source to simulate transfer
TRANSFER_SOURCES = {
    "epsilon": "gamma",       # epsilon ← gamma (different climate)
    "zeta": "delta",  # zeta ← delta (both Region C)
    "delta": "zeta",  # delta ← zeta (both Region C)
    "gamma": "ribera",    # gamma ← ribera (similar climate)
    "ribera": "gamma",    # ribera ← gamma (similar climate)
    "eta": "alpha",     # eta ← alpha (both inland Spain)
    "alpha": "eta",     # alpha ← eta (both inland Spain)
}


@dataclass
class EvaluationResult:
    """Result of evaluating one configuration."""
    plant_id: str
    layer: str
    config_name: str
    mae: float
    rmse: float
    bias: float
    correlation: float
    n_samples: int
    n_rain_anchors: int
    has_fleet_cv: bool
    quality_score: float  # Combines MAE skill and correlation


def load_dustiq_ground_truth(plant_id: str) -> Optional[pd.Series]:
    """Load DustIQ ground truth for a plant."""
    paths = [
        Path(f"public/data/soiling/{plant_id}/dustiq_daily.csv"),
        Path(f"public/data/soiling/{plant_id}/dustiq_history.json"),
    ]

    for path in paths:
        if not path.exists():
            continue

        try:
            if path.suffix == '.csv':
                df = pd.read_csv(path)
            else:
                with open(path) as f:
                    data = json.load(f)
                df = pd.DataFrame(data.get("daily_data", []))

            if len(df) == 0:
                continue

            # Find date and SR columns
            date_col = next((c for c in df.columns if 'date' in c.lower()), df.columns[0])
            sr_col = next((c for c in df.columns if 'sr' in c.lower() or 'soiling' in c.lower()), None)

            if sr_col is None:
                continue

            df[date_col] = pd.to_datetime(df[date_col])
            df = df.set_index(date_col).sort_index()

            return df[sr_col].dropna()

        except Exception as e:
            print(f"    Warning: Failed to load DustIQ from {path}: {e}")
            continue

    return None


def compute_metrics(
    sr_pred: pd.Series,
    sr_actual: pd.Series,
    dustiq_std: float,
) -> Dict[str, float]:
    """Compute evaluation metrics."""
    # Align indices
    common_idx = sr_pred.index.intersection(sr_actual.index)
    if len(common_idx) < 10:
        return {
            "mae": np.nan, "rmse": np.nan, "bias": np.nan,
            "correlation": np.nan, "n_samples": 0, "quality_score": np.nan
        }

    pred = sr_pred.loc[common_idx].values
    actual = sr_actual.loc[common_idx].values

    # Remove NaN
    valid = ~(np.isnan(pred) | np.isnan(actual))
    pred = pred[valid]
    actual = actual[valid]

    if len(pred) < 10:
        return {
            "mae": np.nan, "rmse": np.nan, "bias": np.nan,
            "correlation": np.nan, "n_samples": 0, "quality_score": np.nan
        }

    # Metrics
    mae = np.mean(np.abs(pred - actual))
    rmse = np.sqrt(np.mean((pred - actual) ** 2))
    bias = np.mean(pred - actual)
    corr = np.corrcoef(pred, actual)[0, 1] if np.std(pred) > 0 else 0

    # Quality score: skill (1 - MAE/std) * correlation
    skill = max(0, 1 - mae / dustiq_std)
    quality = skill * max(0, corr)

    return {
        "mae": float(mae),
        "rmse": float(rmse),
        "bias": float(bias),
        "correlation": float(corr),
        "n_samples": len(pred),
        "quality_score": float(quality),
    }


def evaluate_layer3_transfer(
    plant_id: str,
    sr_actual: pd.Series,
    dustiq_std: float,
    enable_rain_cal: bool,
    enable_fleet_cv: bool,
    source_plant: Optional[str] = None,
) -> Optional[EvaluationResult]:
    """Evaluate Layer 3 Transfer Learning with specific config.

    For plants that have DustIQ, we can still test transfer by:
    1. Forcing a different source plant
    2. Comparing transferred predictions vs actual DustIQ

    This simulates "what if this plant didn't have DustIQ?"
    """
    try:
        # For DustIQ plants, force a different source to test transfer
        estimator = TransferLearningEstimator(
            enable_rain_calibration=enable_rain_cal,
            enable_fleet_cv=enable_fleet_cv,
            rain_calibration_method='constrain',
            source_plant_override=source_plant,
        )

        # For DustIQ plants with source_plant_override, skip the DustIQ check
        # This allows cross-validation testing where we compare transfer predictions
        # against actual DustIQ ground truth (simulating "what if plant had no DustIQ?")
        if source_plant is None:
            avail = estimator.check_availability(plant_id)
            if not avail.is_available:
                print(f"    L3 Transfer not available: {avail.reason}")
                return None
            result = estimator.estimate(plant_id)
        else:
            # With source_plant_override, skip the DustIQ check
            result = estimator.estimate(plant_id, skip_dustiq_check=True)
        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        config_name = []
        if enable_rain_cal:
            config_name.append("rain")
        if enable_fleet_cv:
            config_name.append("fleet_cv")
        if not config_name:
            config_name = ["baseline"]

        return EvaluationResult(
            plant_id=plant_id,
            layer="L3_Transfer",
            config_name="+".join(config_name),
            mae=metrics["mae"],
            rmse=metrics["rmse"],
            bias=metrics["bias"],
            correlation=metrics["correlation"],
            n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=result.metadata.get("has_fleet_cv_data", False),
            quality_score=metrics["quality_score"],
        )

    except Exception as e:
        print(f"    L3 Transfer error: {e}")
        return None


def evaluate_layer4_foundation(
    plant_id: str,
    sr_actual: pd.Series,
    dustiq_std: float,
    enable_rain_cal: bool,
    enable_fleet_cv: bool,
) -> Optional[EvaluationResult]:
    """Evaluate Layer 4 Foundation Model with specific config.

    Uses the rule-based fallback when the trained model isn't available.
    This tests the physics-based rain/decay logic with calibration.
    """
    try:
        # Create a modified estimator that will use rule-based fallback
        estimator = FoundationModelEstimator(
            enable_rain_calibration=enable_rain_cal,
            enable_fleet_cv=enable_fleet_cv,
            rain_calibration_method='blend',
        )

        # Check availability - but continue even if model not trained
        # (rule-based fallback will be used)
        avail = estimator.check_availability(plant_id)
        if not avail.is_available and "model not trained" not in avail.reason.lower():
            print(f"    L4 Foundation not available: {avail.reason}")
            return None

        # Force the estimate even without trained model (uses rule-based)
        try:
            result = estimator.estimate(plant_id)
        except ValueError as e:
            if "model not trained" in str(e).lower() or "not available" in str(e).lower():
                # Use direct rule-based estimation with calibration
                result = _run_foundation_rule_based(
                    estimator, plant_id, enable_rain_cal, enable_fleet_cv
                )
                if result is None:
                    return None
            else:
                raise

        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        config_name = []
        if enable_rain_cal:
            config_name.append("rain")
        if enable_fleet_cv:
            config_name.append("fleet_cv")
        if not config_name:
            config_name = ["baseline"]

        return EvaluationResult(
            plant_id=plant_id,
            layer="L4_Foundation",
            config_name="+".join(config_name),
            mae=metrics["mae"],
            rmse=metrics["rmse"],
            bias=metrics["bias"],
            correlation=metrics["correlation"],
            n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=result.metadata.get("has_fleet_cv_data", False),
            quality_score=metrics["quality_score"],
        )

    except Exception as e:
        print(f"    L4 Foundation error: {e}")
        import traceback
        traceback.print_exc()
        return None


def _run_foundation_rule_based(
    estimator: FoundationModelEstimator,
    plant_id: str,
    enable_rain_cal: bool,
    enable_fleet_cv: bool,
):
    """Run foundation model's rule-based estimation directly."""
    from nuravolt.soiling.estimation import SREstimationResult, EstimationLayer
    from nuravolt.soiling.estimation.calibration import (
        calibrate_with_rain_anchors,
        add_fleet_cv_to_features,
    )

    # Load weather data
    df_weather = estimator._load_weather_data(plant_id)
    if df_weather is None or len(df_weather) < 14:
        return None

    df_aod = estimator._load_aod_data(plant_id)
    df_rain = estimator._load_rain_data(plant_id)

    # Generate features
    features = estimator._generate_foundation_features(plant_id, df_weather, df_aod)

    # Add fleet CV if enabled
    if enable_fleet_cv:
        features = add_fleet_cv_to_features(
            features, plant_id, estimator.data_dir, estimator.fleet_cv_config
        )

    # Run rule-based estimation
    sr_pred = estimator._rule_based_estimate(features)

    # Apply conservative bias
    sr_pred = sr_pred - estimator.conservative_bias
    sr_pred = np.clip(sr_pred, 0.75, 1.0)

    sr_series = pd.Series(sr_pred, index=features.index, name="sr")

    # Apply rain calibration if enabled
    n_rain_anchors = 0
    if enable_rain_cal and df_rain is not None and len(df_rain) > 0:
        rain_series = df_rain.get("precipitation_mm", df_rain.iloc[:, 0]).fillna(0)
        if len(rain_series) > 0:
            sr_series, _ = calibrate_with_rain_anchors(
                sr_series, rain_series,
                config=estimator.rain_config,
                method=estimator.rain_calibration_method,
            )
            heavy_mask = rain_series >= estimator.rain_config.heavy_rain_threshold_mm
            moderate_mask = rain_series >= estimator.rain_config.moderate_rain_threshold_mm
            n_rain_anchors = int(heavy_mask.sum() + (moderate_mask & ~heavy_mask).sum())

    confidence = pd.Series(55, index=features.index)  # Base L4 confidence

    return SREstimationResult(
        sr_values=sr_series,
        confidence=confidence,
        method="foundation_rule_based",
        layer=EstimationLayer.FOUNDATION,
        metadata={
            "plant_id": plant_id,
            "n_days": len(features),
            "rain_calibration_applied": enable_rain_cal and n_rain_anchors > 0,
            "n_rain_anchors": n_rain_anchors,
            "has_fleet_cv_data": 'fleet_cv' in features.columns,
            "fleet_cv_enabled": enable_fleet_cv,
        },
    )


def evaluate_layer5_disaggregation(
    plant_id: str,
    sr_actual: pd.Series,
    dustiq_std: float,
) -> Optional[EvaluationResult]:
    """Evaluate Layer 5 Loss Disaggregation.

    L5 already has rain calibration built into its physics model,
    so we evaluate it as-is to compare against other layers.
    """
    try:
        estimator = LossDisaggregationEstimator()

        avail = estimator.check_availability(plant_id)
        if not avail.is_available:
            print(f"    L5 Disaggregation not available: {avail.reason}")
            return None

        result = estimator.estimate(plant_id)
        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        return EvaluationResult(
            plant_id=plant_id,
            layer="L5_Disaggregation",
            config_name="native_rain",  # Rain is built into L5's physics
            mae=metrics["mae"],
            rmse=metrics["rmse"],
            bias=metrics["bias"],
            correlation=metrics["correlation"],
            n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=False,  # L5 doesn't use fleet CV
            quality_score=metrics["quality_score"],
        )

    except Exception as e:
        print(f"    L5 Disaggregation error: {e}")
        return None


def main():
    """Run calibration impact evaluation."""
    print("=" * 80)
    print("CALIBRATION IMPACT EVALUATION")
    print("Rain Anchor Calibration + Fleet CV Features")
    print("=" * 80)
    print()

    all_results: List[EvaluationResult] = []

    # Test configurations
    configs = [
        (False, False, "baseline"),
        (True, False, "rain_only"),
        (False, True, "fleet_cv_only"),
        (True, True, "rain+fleet_cv"),
    ]

    for plant_id in DUSTIQ_PLANTS:
        print(f"\n{'='*60}")
        print(f"Plant: {plant_id}")
        print(f"{'='*60}")

        # Load ground truth
        sr_actual = load_dustiq_ground_truth(plant_id)
        if sr_actual is None or len(sr_actual) < 30:
            print(f"  Skipping - insufficient DustIQ data")
            continue

        dustiq_std = DUSTIQ_STD.get(plant_id, sr_actual.std())
        print(f"  DustIQ: {len(sr_actual)} days, std={dustiq_std:.4f}")

        # Evaluate Layer 3 with different configs
        # Use cross-plant transfer to simulate "what if this plant didn't have DustIQ?"
        source_plant = TRANSFER_SOURCES.get(plant_id)
        print(f"\n  Layer 3 (Transfer Learning from {source_plant}):")
        for enable_rain, enable_cv, name in configs:
            result = evaluate_layer3_transfer(
                plant_id, sr_actual, dustiq_std, enable_rain, enable_cv,
                source_plant=source_plant,
            )
            if result:
                all_results.append(result)
                status = f"MAE={result.mae:.4f}, r={result.correlation:.3f}, Q={result.quality_score:.3f}"
                extras = []
                if result.n_rain_anchors > 0:
                    extras.append(f"{result.n_rain_anchors} anchors")
                if result.has_fleet_cv:
                    extras.append("fleet_cv")
                if extras:
                    status += f" ({', '.join(extras)})"
                print(f"    {name:20s}: {status}")

        # Evaluate Layer 4 with different configs
        print(f"\n  Layer 4 (Foundation Model):")
        for enable_rain, enable_cv, name in configs:
            result = evaluate_layer4_foundation(
                plant_id, sr_actual, dustiq_std, enable_rain, enable_cv
            )
            if result:
                all_results.append(result)
                status = f"MAE={result.mae:.4f}, r={result.correlation:.3f}, Q={result.quality_score:.3f}"
                extras = []
                if result.n_rain_anchors > 0:
                    extras.append(f"{result.n_rain_anchors} anchors")
                if result.has_fleet_cv:
                    extras.append("fleet_cv")
                if extras:
                    status += f" ({', '.join(extras)})"
                print(f"    {name:20s}: {status}")

        # Evaluate Layer 5 (already has rain calibration built in)
        print(f"\n  Layer 5 (Loss Disaggregation - native rain):")
        result = evaluate_layer5_disaggregation(plant_id, sr_actual, dustiq_std)
        if result:
            all_results.append(result)
            status = f"MAE={result.mae:.4f}, r={result.correlation:.3f}, Q={result.quality_score:.3f}"
            if result.n_rain_anchors > 0:
                status += f" ({result.n_rain_anchors} anchors)"
            print(f"    {result.config_name:20s}: {status}")

    # Summary
    if not all_results:
        print("\nNo results generated.")
        return

    print("\n" + "=" * 80)
    print("SUMMARY BY CONFIGURATION")
    print("=" * 80)

    # Group by layer and config
    df = pd.DataFrame([
        {
            "layer": r.layer,
            "config": r.config_name,
            "plant": r.plant_id,
            "mae": r.mae,
            "correlation": r.correlation,
            "quality": r.quality_score,
            "n_anchors": r.n_rain_anchors,
        }
        for r in all_results
    ])

    # Summary stats by layer+config
    summary = df.groupby(["layer", "config"]).agg({
        "mae": ["mean", "std"],
        "correlation": ["mean", "std"],
        "quality": ["mean", "std"],
        "n_anchors": "mean",
        "plant": "count",
    }).round(4)

    print("\n")
    print(summary.to_string())

    # Improvement analysis
    print("\n" + "=" * 80)
    print("IMPROVEMENT ANALYSIS (vs baseline)")
    print("=" * 80)

    for layer in ["L3_Transfer", "L4_Foundation"]:
        layer_df = df[df["layer"] == layer]
        if len(layer_df) == 0:
            continue

        baseline = layer_df[layer_df["config"] == "baseline"]
        if len(baseline) == 0:
            continue

        print(f"\n{layer}:")
        baseline_mae = baseline["mae"].mean()
        baseline_corr = baseline["correlation"].mean()
        baseline_q = baseline["quality"].mean()

        for config in ["rain_only", "fleet_cv_only", "rain+fleet_cv"]:
            config_df = layer_df[layer_df["config"] == config]
            if len(config_df) == 0:
                continue

            mae_change = (config_df["mae"].mean() - baseline_mae) / baseline_mae * 100
            corr_change = config_df["correlation"].mean() - baseline_corr
            q_change = config_df["quality"].mean() - baseline_q

            mae_dir = "↓" if mae_change < 0 else "↑"
            corr_dir = "↑" if corr_change > 0 else "↓"
            q_dir = "↑" if q_change > 0 else "↓"

            print(f"  {config:20s}: MAE {mae_dir}{abs(mae_change):5.1f}%, "
                  f"Corr {corr_dir}{abs(corr_change):.3f}, "
                  f"Quality {q_dir}{abs(q_change):.3f}")

    # Save results
    output_path = Path("backenddata/calibration_impact_results.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Convert MultiIndex summary to JSON-serializable format
    # summary has MultiIndex columns like (('mae', 'mean'), ...)
    # Convert to nested dict: layer -> config -> metric -> value
    summary_dict = {}
    for (layer, config), row in summary.iterrows():
        if layer not in summary_dict:
            summary_dict[layer] = {}
        summary_dict[layer][config] = {
            "mae_mean": float(row[("mae", "mean")]) if pd.notna(row[("mae", "mean")]) else None,
            "mae_std": float(row[("mae", "std")]) if pd.notna(row[("mae", "std")]) else None,
            "correlation_mean": float(row[("correlation", "mean")]) if pd.notna(row[("correlation", "mean")]) else None,
            "correlation_std": float(row[("correlation", "std")]) if pd.notna(row[("correlation", "std")]) else None,
            "quality_mean": float(row[("quality", "mean")]) if pd.notna(row[("quality", "mean")]) else None,
            "quality_std": float(row[("quality", "std")]) if pd.notna(row[("quality", "std")]) else None,
            "avg_rain_anchors": float(row[("n_anchors", "mean")]) if pd.notna(row[("n_anchors", "mean")]) else None,
            "n_plants": int(row[("plant", "count")]),
        }

    with open(output_path, "w") as f:
        json.dump(
            {
                "results": [
                    {
                        "plant_id": r.plant_id,
                        "layer": r.layer,
                        "config": r.config_name,
                        "mae": r.mae,
                        "rmse": r.rmse,
                        "bias": r.bias,
                        "correlation": r.correlation,
                        "quality_score": r.quality_score,
                        "n_samples": r.n_samples,
                        "n_rain_anchors": r.n_rain_anchors,
                        "has_fleet_cv": r.has_fleet_cv,
                    }
                    for r in all_results
                ],
                "summary": summary_dict,
            },
            f,
            indent=2,
            default=str,
        )

    print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
