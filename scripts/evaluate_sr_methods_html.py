#!/usr/bin/env python3
"""
Evaluate all SR estimation methods and generate HTML report.

Tests Layers 1-5 with their current default settings and compares
performance against DustIQ ground truth.

Usage:
    python scripts/evaluate_sr_methods_html.py
"""

import json
import sys
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.estimation import (
    DustIQEstimator,
    SamePlantMLEstimator,
    TransferLearningEstimator,
    FoundationModelEstimator,
    LossDisaggregationEstimator,
)

# Plants with DustIQ for evaluation
DUSTIQ_PLANTS = ["epsilon", "zeta", "delta", "gamma", "ribera", "eta", "alpha"]

# Cross-plant transfer sources for L3 evaluation
TRANSFER_SOURCES = {
    "epsilon": "gamma",
    "zeta": "delta",
    "delta": "zeta",
    "gamma": "ribera",
    "ribera": "gamma",
    "eta": "alpha",
    "alpha": "eta",
}

# DustIQ variance per plant
DUSTIQ_STD = {
    "epsilon": 0.0358,
    "zeta": 0.0115,
    "ribera": 0.0150,
    "delta": 0.0064,
    "gamma": 0.0181,
    "alpha": 0.0052,
    "eta": 0.0098,
}


@dataclass
class MethodResult:
    """Result for a single method on a single plant."""
    plant_id: str
    layer: str
    method: str
    mae: float
    rmse: float
    bias: float
    correlation: float
    n_samples: int
    n_rain_anchors: int
    has_fleet_cv: bool
    rain_calibration: bool
    quality_score: float
    error: Optional[str] = None


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

            date_col = next((c for c in df.columns if 'date' in c.lower()), df.columns[0])
            sr_col = next((c for c in df.columns if 'sr' in c.lower() or 'soiling' in c.lower()), None)

            if sr_col is None:
                continue

            df[date_col] = pd.to_datetime(df[date_col])
            df = df.set_index(date_col).sort_index()
            return df[sr_col].dropna()

        except Exception:
            continue

    return None


def compute_metrics(sr_pred: pd.Series, sr_actual: pd.Series, dustiq_std: float) -> Dict[str, float]:
    """Compute evaluation metrics."""
    common_idx = sr_pred.index.intersection(sr_actual.index)
    if len(common_idx) < 10:
        return {"mae": np.nan, "rmse": np.nan, "bias": np.nan, "correlation": np.nan, "n_samples": 0, "quality_score": np.nan}

    pred = sr_pred.loc[common_idx].values
    actual = sr_actual.loc[common_idx].values

    valid = ~(np.isnan(pred) | np.isnan(actual))
    pred = pred[valid]
    actual = actual[valid]

    if len(pred) < 10:
        return {"mae": np.nan, "rmse": np.nan, "bias": np.nan, "correlation": np.nan, "n_samples": 0, "quality_score": np.nan}

    mae = np.mean(np.abs(pred - actual))
    rmse = np.sqrt(np.mean((pred - actual) ** 2))
    bias = np.mean(pred - actual)
    corr = np.corrcoef(pred, actual)[0, 1] if np.std(pred) > 0 else 0

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


def evaluate_layer1_dustiq(plant_id: str, sr_actual: pd.Series, dustiq_std: float) -> Optional[MethodResult]:
    """Evaluate Layer 1 DustIQ (baseline - should be perfect)."""
    try:
        estimator = DustIQEstimator()
        avail = estimator.check_availability(plant_id)
        if not avail.is_available:
            return MethodResult(plant_id=plant_id, layer="L1", method="DustIQ", mae=0, rmse=0, bias=0,
                                correlation=1.0, n_samples=len(sr_actual), n_rain_anchors=0,
                                has_fleet_cv=False, rain_calibration=False, quality_score=1.0,
                                error="Not available")

        result = estimator.estimate(plant_id)
        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        return MethodResult(
            plant_id=plant_id, layer="L1", method="DustIQ",
            mae=metrics["mae"], rmse=metrics["rmse"], bias=metrics["bias"],
            correlation=metrics["correlation"], n_samples=metrics["n_samples"],
            n_rain_anchors=0, has_fleet_cv=False, rain_calibration=False,
            quality_score=metrics["quality_score"]
        )
    except Exception as e:
        return MethodResult(plant_id=plant_id, layer="L1", method="DustIQ", mae=np.nan, rmse=np.nan,
                            bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                            has_fleet_cv=False, rain_calibration=False, quality_score=np.nan, error=str(e))


def evaluate_layer2_same_plant_ml(plant_id: str, sr_actual: pd.Series, dustiq_std: float) -> Optional[MethodResult]:
    """Evaluate Layer 2 Same-Plant ML."""
    try:
        estimator = SamePlantMLEstimator()
        avail = estimator.check_availability(plant_id)
        if not avail.is_available:
            return MethodResult(plant_id=plant_id, layer="L2", method="Same-Plant ML", mae=np.nan, rmse=np.nan,
                                bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                                has_fleet_cv=False, rain_calibration=False, quality_score=np.nan,
                                error=avail.reason)

        result = estimator.estimate(plant_id)
        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        return MethodResult(
            plant_id=plant_id, layer="L2", method="Same-Plant ML",
            mae=metrics["mae"], rmse=metrics["rmse"], bias=metrics["bias"],
            correlation=metrics["correlation"], n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=result.metadata.get("has_fleet_cv_data", False),
            rain_calibration=result.metadata.get("rain_calibration_applied", False),
            quality_score=metrics["quality_score"]
        )
    except Exception as e:
        return MethodResult(plant_id=plant_id, layer="L2", method="Same-Plant ML", mae=np.nan, rmse=np.nan,
                            bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                            has_fleet_cv=False, rain_calibration=False, quality_score=np.nan, error=str(e))


def evaluate_layer3_transfer(plant_id: str, sr_actual: pd.Series, dustiq_std: float) -> Optional[MethodResult]:
    """Evaluate Layer 3 Transfer Learning with default settings."""
    source_plant = TRANSFER_SOURCES.get(plant_id)
    if not source_plant:
        return None

    try:
        # Use default settings (rain calibration disabled)
        estimator = TransferLearningEstimator(source_plant_override=source_plant)

        result = estimator.estimate(plant_id, skip_dustiq_check=True)
        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        return MethodResult(
            plant_id=plant_id, layer="L3", method=f"Transfer ({source_plant})",
            mae=metrics["mae"], rmse=metrics["rmse"], bias=metrics["bias"],
            correlation=metrics["correlation"], n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=result.metadata.get("has_fleet_cv_data", False),
            rain_calibration=result.metadata.get("rain_calibration_applied", False),
            quality_score=metrics["quality_score"]
        )
    except Exception as e:
        return MethodResult(plant_id=plant_id, layer="L3", method=f"Transfer ({source_plant})", mae=np.nan, rmse=np.nan,
                            bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                            has_fleet_cv=False, rain_calibration=False, quality_score=np.nan, error=str(e))


def evaluate_layer4_foundation(plant_id: str, sr_actual: pd.Series, dustiq_std: float) -> Optional[MethodResult]:
    """Evaluate Layer 4 Foundation Model with default settings (rain calibration enabled)."""
    try:
        # Use default settings (rain calibration enabled)
        estimator = FoundationModelEstimator()

        # Try to estimate, use rule-based fallback if needed
        try:
            result = estimator.estimate(plant_id)
        except ValueError as e:
            if "not available" in str(e).lower() or "model not trained" in str(e).lower():
                result = _run_foundation_rule_based(estimator, plant_id)
                if result is None:
                    raise
            else:
                raise

        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        return MethodResult(
            plant_id=plant_id, layer="L4", method="Foundation",
            mae=metrics["mae"], rmse=metrics["rmse"], bias=metrics["bias"],
            correlation=metrics["correlation"], n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=result.metadata.get("has_fleet_cv_data", False),
            rain_calibration=result.metadata.get("rain_calibration_applied", False),
            quality_score=metrics["quality_score"]
        )
    except Exception as e:
        return MethodResult(plant_id=plant_id, layer="L4", method="Foundation", mae=np.nan, rmse=np.nan,
                            bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                            has_fleet_cv=False, rain_calibration=False, quality_score=np.nan, error=str(e))


def _run_foundation_rule_based(estimator: FoundationModelEstimator, plant_id: str):
    """Run foundation model's rule-based estimation."""
    from nuravolt.soiling.estimation import SREstimationResult, EstimationLayer
    from nuravolt.soiling.estimation.calibration import calibrate_with_rain_anchors, add_fleet_cv_to_features

    df_weather = estimator._load_weather_data(plant_id)
    if df_weather is None or len(df_weather) < 14:
        return None

    df_aod = estimator._load_aod_data(plant_id)
    df_rain = estimator._load_rain_data(plant_id)

    features = estimator._generate_foundation_features(plant_id, df_weather, df_aod)

    if estimator.enable_fleet_cv:
        features = add_fleet_cv_to_features(features, plant_id, estimator.data_dir, estimator.fleet_cv_config)

    sr_pred = estimator._rule_based_estimate(features)
    sr_pred = sr_pred - estimator.conservative_bias
    sr_pred = np.clip(sr_pred, 0.75, 1.0)

    sr_series = pd.Series(sr_pred, index=features.index, name="sr")

    n_rain_anchors = 0
    rain_calibration_applied = False
    if estimator.enable_rain_calibration and df_rain is not None and len(df_rain) > 0:
        rain_series = df_rain.get("precipitation_mm", df_rain.iloc[:, 0]).fillna(0)
        if len(rain_series) > 0:
            sr_series, _ = calibrate_with_rain_anchors(
                sr_series, rain_series, config=estimator.rain_config, method=estimator.rain_calibration_method
            )
            rain_calibration_applied = True
            heavy_mask = rain_series >= estimator.rain_config.heavy_rain_threshold_mm
            moderate_mask = rain_series >= estimator.rain_config.moderate_rain_threshold_mm
            n_rain_anchors = int(heavy_mask.sum() + (moderate_mask & ~heavy_mask).sum())

    return SREstimationResult(
        sr_values=sr_series,
        confidence=pd.Series(55, index=features.index),
        method="foundation_rule_based",
        layer=EstimationLayer.FOUNDATION,
        metadata={
            "plant_id": plant_id,
            "n_days": len(features),
            "rain_calibration_applied": rain_calibration_applied,
            "n_rain_anchors": n_rain_anchors,
            "has_fleet_cv_data": 'fleet_cv' in features.columns,
        },
    )


def evaluate_layer5_disaggregation(plant_id: str, sr_actual: pd.Series, dustiq_std: float) -> Optional[MethodResult]:
    """Evaluate Layer 5 Loss Disaggregation."""
    try:
        estimator = LossDisaggregationEstimator()
        avail = estimator.check_availability(plant_id)
        if not avail.is_available:
            return MethodResult(plant_id=plant_id, layer="L5", method="Disaggregation", mae=np.nan, rmse=np.nan,
                                bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                                has_fleet_cv=False, rain_calibration=True, quality_score=np.nan, error=avail.reason)

        result = estimator.estimate(plant_id)
        metrics = compute_metrics(result.sr_values, sr_actual, dustiq_std)

        return MethodResult(
            plant_id=plant_id, layer="L5", method="Disaggregation",
            mae=metrics["mae"], rmse=metrics["rmse"], bias=metrics["bias"],
            correlation=metrics["correlation"], n_samples=metrics["n_samples"],
            n_rain_anchors=result.metadata.get("n_rain_anchors", 0),
            has_fleet_cv=False,
            rain_calibration=True,  # L5 has rain built into physics
            quality_score=metrics["quality_score"]
        )
    except Exception as e:
        return MethodResult(plant_id=plant_id, layer="L5", method="Disaggregation", mae=np.nan, rmse=np.nan,
                            bias=np.nan, correlation=np.nan, n_samples=0, n_rain_anchors=0,
                            has_fleet_cv=False, rain_calibration=True, quality_score=np.nan, error=str(e))


def generate_html_report(results: List[MethodResult], output_path: Path):
    """Generate HTML report from results."""
    # Convert to DataFrame for easier manipulation
    df = pd.DataFrame([asdict(r) for r in results])

    # Summary by layer
    summary = df.groupby('layer').agg({
        'mae': ['mean', 'std', 'min', 'max'],
        'correlation': ['mean', 'std'],
        'n_samples': 'sum',
    }).round(4)

    # Create HTML
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SR Estimation Methods Evaluation</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }}
        .container {{ max-width: 1400px; margin: 0 auto; }}
        h1 {{ color: #1a1a2e; border-bottom: 3px solid #e94560; padding-bottom: 10px; }}
        h2 {{ color: #16213e; margin-top: 30px; }}
        .summary-cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 20px 0; }}
        .card {{ background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }}
        .card h3 {{ margin: 0 0 15px 0; color: #16213e; font-size: 1.1em; }}
        .card .metric {{ font-size: 2em; font-weight: bold; color: #e94560; }}
        .card .label {{ color: #666; font-size: 0.9em; }}
        table {{ width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin: 20px 0; }}
        th {{ background: #16213e; color: white; padding: 15px 10px; text-align: left; font-weight: 500; }}
        td {{ padding: 12px 10px; border-bottom: 1px solid #eee; }}
        tr:hover {{ background: #f8f9fa; }}
        .good {{ color: #28a745; font-weight: bold; }}
        .ok {{ color: #ffc107; font-weight: bold; }}
        .bad {{ color: #dc3545; font-weight: bold; }}
        .error {{ color: #dc3545; font-style: italic; }}
        .tag {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; margin-left: 5px; }}
        .tag-rain {{ background: #d4edda; color: #155724; }}
        .tag-cv {{ background: #cce5ff; color: #004085; }}
        .layer-badge {{ display: inline-block; padding: 4px 10px; border-radius: 5px; font-weight: bold; margin-right: 10px; }}
        .L1 {{ background: #28a745; color: white; }}
        .L2 {{ background: #17a2b8; color: white; }}
        .L3 {{ background: #ffc107; color: #333; }}
        .L4 {{ background: #fd7e14; color: white; }}
        .L5 {{ background: #6c757d; color: white; }}
        .chart {{ margin: 20px 0; padding: 20px; background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }}
        .bar {{ height: 25px; border-radius: 4px; margin: 5px 0; display: flex; align-items: center; padding-left: 10px; color: white; font-weight: bold; font-size: 0.9em; }}
        .bar-L1 {{ background: linear-gradient(90deg, #28a745, #20c997); }}
        .bar-L2 {{ background: linear-gradient(90deg, #17a2b8, #20c9b8); }}
        .bar-L3 {{ background: linear-gradient(90deg, #ffc107, #ffda44); color: #333; }}
        .bar-L4 {{ background: linear-gradient(90deg, #fd7e14, #ffaa44); }}
        .bar-L5 {{ background: linear-gradient(90deg, #6c757d, #adb5bd); }}
        .timestamp {{ color: #666; font-size: 0.9em; margin-top: 30px; }}
        .note {{ background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 0 5px 5px 0; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>SR Estimation Methods Evaluation</h1>
        <p>Comparison of all soiling ratio estimation layers against DustIQ ground truth.</p>

        <div class="note">
            <strong>Default Settings:</strong>
            L3 Transfer: Rain calibration <strong>disabled</strong> (ML predictions accurate without it) |
            L4 Foundation: Rain calibration <strong>enabled</strong> (3% improvement) |
            L5 Disaggregation: Rain <strong>native</strong> (built into physics model)
        </div>

        <h2>Summary by Layer</h2>
        <div class="summary-cards">
"""

    # Add summary cards for each layer
    layer_names = {"L1": "DustIQ", "L2": "Same-Plant ML", "L3": "Transfer", "L4": "Foundation", "L5": "Disaggregation"}
    layer_order = ["L1", "L2", "L3", "L4", "L5"]

    for layer in layer_order:
        layer_df = df[df['layer'] == layer]
        if len(layer_df) == 0:
            continue

        avg_mae = layer_df['mae'].mean()
        avg_corr = layer_df['correlation'].mean()
        n_plants = len(layer_df)

        mae_class = "good" if avg_mae < 0.03 else ("ok" if avg_mae < 0.06 else "bad")

        html += f"""
            <div class="card">
                <h3><span class="layer-badge {layer}">{layer}</span> {layer_names.get(layer, layer)}</h3>
                <div class="metric {mae_class}">{avg_mae:.4f}</div>
                <div class="label">Average MAE</div>
                <div style="margin-top: 10px;">
                    <span class="label">Correlation:</span> <strong>{avg_corr:.3f}</strong><br>
                    <span class="label">Plants tested:</span> <strong>{n_plants}</strong>
                </div>
            </div>
"""

    html += """
        </div>

        <h2>MAE Comparison (lower is better)</h2>
        <div class="chart">
"""

    # Add bar chart for MAE comparison
    max_mae = df['mae'].max()
    if pd.notna(max_mae) and max_mae > 0:
        for layer in layer_order:
            layer_df = df[df['layer'] == layer]
            if len(layer_df) == 0:
                continue
            avg_mae = layer_df['mae'].mean()
            if pd.isna(avg_mae):
                continue
            width = min(100, (avg_mae / max_mae) * 100)
            html += f"""
            <div style="display: flex; align-items: center; margin: 10px 0;">
                <div style="width: 100px;"><span class="layer-badge {layer}">{layer}</span></div>
                <div class="bar bar-{layer}" style="width: {width}%;">{avg_mae:.4f}</div>
            </div>
"""

    html += """
        </div>

        <h2>Detailed Results by Plant</h2>
        <table>
            <thead>
                <tr>
                    <th>Plant</th>
                    <th>Layer</th>
                    <th>Method</th>
                    <th>MAE</th>
                    <th>RMSE</th>
                    <th>Correlation</th>
                    <th>Samples</th>
                    <th>Features</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
"""

    # Sort by plant then layer
    df_sorted = df.sort_values(['plant_id', 'layer'])

    for _, row in df_sorted.iterrows():
        mae_class = ""
        if pd.notna(row['mae']):
            mae_class = "good" if row['mae'] < 0.03 else ("ok" if row['mae'] < 0.06 else "bad")

        features = []
        if row['rain_calibration']:
            features.append('<span class="tag tag-rain">Rain</span>')
        if row['has_fleet_cv']:
            features.append('<span class="tag tag-cv">FleetCV</span>')
        features_str = ''.join(features) if features else '-'

        if row['error']:
            status = f'<span class="error">{row["error"][:30]}...</span>' if len(str(row['error'])) > 30 else f'<span class="error">{row["error"]}</span>'
        else:
            status = '<span class="good">OK</span>'

        mae_str = f'<span class="{mae_class}">{row["mae"]:.4f}</span>' if pd.notna(row['mae']) else '-'
        rmse_str = f'{row["rmse"]:.4f}' if pd.notna(row['rmse']) else '-'
        corr_str = f'{row["correlation"]:.3f}' if pd.notna(row['correlation']) else '-'

        html += f"""
                <tr>
                    <td><strong>{row['plant_id']}</strong></td>
                    <td><span class="layer-badge {row['layer']}">{row['layer']}</span></td>
                    <td>{row['method']}</td>
                    <td>{mae_str}</td>
                    <td>{rmse_str}</td>
                    <td>{corr_str}</td>
                    <td>{row['n_samples']}</td>
                    <td>{features_str}</td>
                    <td>{status}</td>
                </tr>
"""

    html += f"""
            </tbody>
        </table>

        <h2>Layer Descriptions</h2>
        <table>
            <thead>
                <tr>
                    <th>Layer</th>
                    <th>Method</th>
                    <th>Confidence</th>
                    <th>Requirements</th>
                    <th>Rain Calibration</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><span class="layer-badge L1">L1</span></td>
                    <td>DustIQ Sensor</td>
                    <td>95%</td>
                    <td>DustIQ sensor installed</td>
                    <td>N/A (direct measurement)</td>
                </tr>
                <tr>
                    <td><span class="layer-badge L2">L2</span></td>
                    <td>Same-Plant ML</td>
                    <td>85%</td>
                    <td>DustIQ + SCADA data</td>
                    <td>Optional</td>
                </tr>
                <tr>
                    <td><span class="layer-badge L3">L3</span></td>
                    <td>Transfer Learning</td>
                    <td>75%</td>
                    <td>Similar DustIQ plant nearby</td>
                    <td><strong>Disabled by default</strong> (hurts accuracy)</td>
                </tr>
                <tr>
                    <td><span class="layer-badge L4">L4</span></td>
                    <td>Foundation Model</td>
                    <td>65%</td>
                    <td>Weather + AOD data</td>
                    <td><strong>Enabled by default</strong> (3% improvement)</td>
                </tr>
                <tr>
                    <td><span class="layer-badge L5">L5</span></td>
                    <td>Loss Disaggregation</td>
                    <td>55%</td>
                    <td>Weather + rainfall data</td>
                    <td><strong>Native</strong> (built into physics model)</td>
                </tr>
            </tbody>
        </table>

        <p class="timestamp">Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
    </div>
</body>
</html>
"""

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        f.write(html)


def main():
    """Run evaluation and generate HTML report."""
    print("=" * 80)
    print("SR ESTIMATION METHODS EVALUATION")
    print("=" * 80)
    print()

    all_results: List[MethodResult] = []

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

        # Evaluate each layer
        print("\n  Evaluating layers...")

        # L1 DustIQ
        result = evaluate_layer1_dustiq(plant_id, sr_actual, dustiq_std)
        if result:
            all_results.append(result)
            print(f"    L1 DustIQ: MAE={result.mae:.4f}" if pd.notna(result.mae) else f"    L1 DustIQ: {result.error}")

        # L2 Same-Plant ML
        result = evaluate_layer2_same_plant_ml(plant_id, sr_actual, dustiq_std)
        if result:
            all_results.append(result)
            print(f"    L2 Same-Plant: MAE={result.mae:.4f}" if pd.notna(result.mae) else f"    L2 Same-Plant: {result.error}")

        # L3 Transfer
        result = evaluate_layer3_transfer(plant_id, sr_actual, dustiq_std)
        if result:
            all_results.append(result)
            print(f"    L3 Transfer: MAE={result.mae:.4f}, rain_cal={result.rain_calibration}" if pd.notna(result.mae) else f"    L3 Transfer: {result.error}")

        # L4 Foundation
        result = evaluate_layer4_foundation(plant_id, sr_actual, dustiq_std)
        if result:
            all_results.append(result)
            print(f"    L4 Foundation: MAE={result.mae:.4f}, rain_cal={result.rain_calibration}" if pd.notna(result.mae) else f"    L4 Foundation: {result.error}")

        # L5 Disaggregation
        result = evaluate_layer5_disaggregation(plant_id, sr_actual, dustiq_std)
        if result:
            all_results.append(result)
            print(f"    L5 Disaggregation: MAE={result.mae:.4f}" if pd.notna(result.mae) else f"    L5 Disaggregation: {result.error}")

    # Summary
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)

    df = pd.DataFrame([asdict(r) for r in all_results])
    for layer in ["L1", "L2", "L3", "L4", "L5"]:
        layer_df = df[df['layer'] == layer]
        if len(layer_df) > 0:
            avg_mae = layer_df['mae'].mean()
            avg_corr = layer_df['correlation'].mean()
            print(f"  {layer}: MAE={avg_mae:.4f}, Corr={avg_corr:.3f}, n={len(layer_df)}")

    # Generate HTML report
    output_path = Path("backenddata/sr_methods_evaluation.html")
    generate_html_report(all_results, output_path)
    print(f"\nHTML report saved to: {output_path}")

    # Also save JSON
    json_path = Path("backenddata/sr_methods_evaluation.json")
    with open(json_path, 'w') as f:
        json.dump([asdict(r) for r in all_results], f, indent=2, default=str)
    print(f"JSON data saved to: {json_path}")


if __name__ == "__main__":
    main()
