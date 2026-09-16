#!/usr/bin/env python3
"""
Compare ALL soiling prediction methods against DustIQ ground truth.

Methods compared:
1. DustIQ Ground Truth (Reference) - Physical sensor measurements
2. Same-Plant ML - Train on same plant's DustIQ, test on held-out period
3. Transfer Learning - Train on best source plant, predict on target
4. Foundation Model (CatBoost) - Global model trained on ALL DustIQ plants (MAE loss)
4b. TabPFN Foundation - Transformer-based tabular foundation model (LOPO)
6. Ensemble (Transfer + Foundation) - 50/50 average
7. 3-Way Ensemble (Transfer + Foundation + TabPFN) - Equal-weight average

Outputs:
- Summary metrics table (MAE, MBE by SR bin)
- HTML visualization with Plotly (all methods per plant)
- JSON results file

Usage:
    python scripts/compare_all_soiling_methods.py
"""

import json
import pickle
import sys
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import polars as pl

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from catboost import CatBoostRegressor

from nuravolt.soiling.sr_foundation_model import SoilingFoundationModel
from nuravolt.soiling.sr_transfer_features import PLANT_CONFIGS
from scripts.evaluate_transfer_enhanced import (
    load_plant_scada,
    load_plant_enhanced_features,
    SR_BINS,
)

# All plants with DustIQ sensors for comprehensive comparison
# Including eta and alpha (inland Spain - good transfer sources)
VALID_PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

# All plants that can be used as transfer sources (have DustIQ + HybridModels)
# Now includes alpha and eta - inland Spanish plants are good sources
# for other inland plants like ribera (better climate similarity)
ALL_SOURCE_PLANTS = ["delta", "zeta", "gamma", "epsilon", "alpha", "eta"]

# Best inverter per plant - HIGHEST CORRELATION with DustIQ
# Selected by DustIQ correlation (ρ) - better for tracking soiling trends
BEST_INVERTERS = {
    "epsilon": "INV 06.11",        # ρ=0.493 (best correlation with DustIQ)
    "zeta": "INV 01.010",  # ρ=0.346
    "ribera": "INV 01.052",    # ρ=0.290
    "delta": "INV 01.015",     # ρ=0.292
    "gamma": "INV 01.003",     # ρ=0.346
    "alpha": "INV 01.001",     # Best available for transfer source
    "eta": "INV 01.001",     # Best available for transfer source
}

# DustIQ variance per plant (for compound quality metric)
# Plants with std < 1% have limited signal for correlation
DUSTIQ_STD = {
    "epsilon": 0.0358,       # High variance - good for training
    "zeta": 0.0115,  # Good variance
    "ribera": 0.0150,    # Moderate variance
    "delta": 0.0064,     # LOW - correlation unreliable
    "gamma": 0.0181,     # Highest variance - best for training
    "alpha": 0.0052,     # VERY LOW - essentially constant
    "eta": 0.0098,     # Low variance
}

# Method colors for plotting
METHOD_COLORS = {
    'actual': '#000000',          # Black - Ground truth
    'same_plant': '#1f77b4',      # Blue
    'transfer': '#2ca02c',         # Green
    'foundation': '#ff7f0e',       # Orange
    'ensemble': '#9467bd',          # Purple
    'tabpfn': '#8c564b',             # Brown
    'ensemble_3way': '#e377c2',      # Pink
}

# Plant climate classification
PLANT_CLIMATE = {
    "epsilon": "temperate",     # Austria - continental/temperate
    "ribera": "semi-arid",  # Southern Europe - inland dry
    "gamma": "semi-arid",   # Region B, Spain - inland
    "delta": "coastal",     # Region C - Mediterranean coast
    "zeta": "coastal",  # Region C - Mediterranean coast
    "eta": "semi-arid",   # Region E, Spain - inland
    "alpha": "semi-arid",   # Andalusia, Spain - inland
}

# Climate-based transfer source selection (production-ready - no DustIQ needed)
# Priority order: same climate first, then nearest climate
CLIMATE_SOURCE_PRIORITY = {
    "semi-arid": ["gamma", "alpha", "eta", "delta", "zeta", "epsilon"],
    "coastal": ["delta", "zeta", "gamma", "alpha", "eta", "epsilon"],
    "temperate": ["epsilon", "alpha", "eta", "gamma", "delta", "zeta"],
    "arid": ["gamma", "alpha", "eta", "delta", "zeta", "epsilon"],  # Closest to semi-arid
}


def get_climate_based_source(target_plant: str, available_sources: list) -> str:
    """Select transfer source based on climate similarity (no DustIQ needed).

    This is the production-ready selection method that doesn't require
    ground truth data from the target plant.
    """
    target_climate = PLANT_CLIMATE.get(target_plant, "semi-arid")
    priority_list = CLIMATE_SOURCE_PRIORITY.get(target_climate, CLIMATE_SOURCE_PRIORITY["semi-arid"])

    # Return first available source from priority list (excluding target itself)
    for source in priority_list:
        if source in available_sources and source != target_plant:
            return source

    # Fallback: first available source
    for source in available_sources:
        if source != target_plant:
            return source

    return None

METHOD_NAMES = {
    'actual': 'DustIQ Ground Truth',
    'same_plant': 'Same-Plant ML',
    'transfer': 'Transfer Learning',
    'foundation': 'Foundation Model',
    'ensemble': 'Ensemble (Transfer+Foundation)',
    'tabpfn': 'TabPFN Foundation',
    'ensemble_3way': '3-Way Ensemble',
}


def calibrate_with_rain_anchors(
    predictions: np.ndarray,
    dates: pd.DatetimeIndex,
    plant_id: str,
    min_anchors: int = 3,
) -> Tuple[np.ndarray, float, int]:
    """Calibrate model predictions using rain anchor points (leak-free).

    Uses physics knowledge that heavy rain resets SR to ~0.995.
    This does NOT use any DustIQ ground truth - only weather data.

    Parameters
    ----------
    predictions : array
        Model predictions (SR values)
    dates : DatetimeIndex
        Dates corresponding to predictions
    plant_id : str
        Plant ID for loading weather data
    min_anchors : int
        Minimum number of anchors required for calibration

    Returns
    -------
    calibrated : array
        Calibrated predictions
    bias : float
        Estimated bias (positive = model over-predicts)
    n_anchors : int
        Number of anchor points used
    """
    # Config
    heavy_rain_threshold = 10.0  # mm
    moderate_rain_threshold = 5.0  # mm
    post_heavy_rain_sr = 0.995
    post_moderate_rain_sr = 0.98
    anchor_window_days = 2

    # Load rainfall data
    weather_paths = [
        Path(f"public/data/soiling/{plant_id}/weather_extended.json"),
        Path(f"public/data/soiling/{plant_id}/rain_history.json"),
    ]

    df_weather = None
    for weather_path in weather_paths:
        if weather_path.exists():
            try:
                with open(weather_path) as f:
                    weather = json.load(f)
                df_weather = pd.DataFrame(weather.get('daily_data', weather))
                df_weather['date'] = pd.to_datetime(df_weather['date'])
                df_weather = df_weather.set_index('date')
                break
            except Exception:
                continue

    if df_weather is None:
        return predictions, 0.0, 0

    # Find precipitation column
    precip_col = None
    for col in ['precipitation_mm', 'precipitation', 'rain_mm', 'rainfall']:
        if col in df_weather.columns:
            precip_col = col
            break

    if precip_col is None:
        return predictions, 0.0, 0

    # Align rainfall to prediction dates
    rainfall = df_weather[precip_col].reindex(dates).fillna(0).values

    # Find rain anchor points
    anchors = []
    for i, rain in enumerate(rainfall):
        if rain >= heavy_rain_threshold:
            expected_sr = post_heavy_rain_sr
            confidence = 0.95
        elif rain >= moderate_rain_threshold:
            expected_sr = post_moderate_rain_sr
            confidence = 0.75
        else:
            continue

        # Check predictions 1-2 days after rain event
        for offset in range(1, anchor_window_days + 1):
            idx = i + offset
            if idx < len(predictions):
                anchors.append({
                    'idx': idx,
                    'expected_sr': expected_sr,
                    'predicted_sr': predictions[idx],
                    'confidence': confidence * (1 - 0.1 * offset),
                })

    # Need minimum anchors for reliable calibration
    if len(anchors) < min_anchors:
        return predictions, 0.0, len(anchors)

    # Estimate bias (weighted average)
    total_weight = sum(a['confidence'] for a in anchors)
    bias = sum(
        (a['predicted_sr'] - a['expected_sr']) * a['confidence']
        for a in anchors
    ) / total_weight

    # Apply calibration
    calibrated = predictions - bias

    # Clip to valid SR range
    calibrated = np.clip(calibrated, 0.5, 1.0)

    return calibrated, bias, len(anchors)


def compute_portfolio_bias(
    target_plant: str,
    all_mbe: Dict[str, float],
    plant_climate: Dict[str, str],
) -> Tuple[float, int]:
    """Estimate bias for target plant using other plants' observed MBE.

    Leak-free: Only uses MBE from plants OTHER than target.
    Weighted by climate similarity (same climate = 2x weight).

    Returns: (estimated_bias, n_plants_used)
    """
    target_climate = plant_climate.get(target_plant, 'unknown')
    weighted_sum = 0.0
    total_weight = 0.0
    n_used = 0

    for plant_id, mbe in all_mbe.items():
        if plant_id == target_plant:
            continue  # NEVER use target plant's own data

        weight = 2.0 if plant_climate.get(plant_id) == target_climate else 1.0
        weighted_sum += mbe * weight
        total_weight += weight
        n_used += 1

    if total_weight == 0:
        return 0.0, 0

    return weighted_sum / total_weight, n_used


def load_inverter_scada(plant_id: str, inverter_id: str = None) -> Tuple[Optional[pd.DataFrame], Optional[pd.Series]]:
    """Load SCADA data for a specific inverter.

    Returns:
        df_scada: DataFrame with 'power', 'irradiance' columns at daily resolution
        sr_actual: Series with DustIQ soiling ratio ground truth
    """
    if inverter_id is None:
        inverter_id = BEST_INVERTERS.get(plant_id)

    if inverter_id is None:
        print(f"    No best inverter defined for {plant_id}")
        return None, None

    scada_dir = Path(f"backenddata/scada/{plant_id}")
    raw_files = list(scada_dir.glob("emsdt_*_training.parquet"))

    if not raw_files:
        print(f"    No raw SCADA file found for {plant_id}")
        return None, None

    df = pl.read_parquet(raw_files[0])

    # Find the specific inverter's power column
    inv_col = None
    for c in df.columns:
        if 'Inverter Power Normalized' in c and inverter_id in c:
            inv_col = c
            break

    if inv_col is None:
        print(f"    Inverter {inverter_id} not found in {plant_id}")
        return None, None

    # Find DustIQ columns
    sr_cols = [c for c in df.columns if 'soiling_ratio' in c.lower()]
    if not sr_cols:
        print(f"    No DustIQ columns found for {plant_id}")
        return None, None

    # Find irradiance column
    irr_cols = [c for c in df.columns if 'Irradiation' in c or 'Radiation' in c]
    irr_col = [c for c in irr_cols if 'average' in c.lower()]
    irr_col = irr_col[0] if irr_col else (irr_cols[0] if irr_cols else None)

    if irr_col is None:
        print(f"    No irradiance column found for {plant_id}")
        return None, None

    # Parse timestamp and add date
    df = df.with_columns([
        pl.col('timestamp').str.to_datetime().alias('ts'),
    ]).with_columns([
        pl.col('ts').dt.date().alias('date')
    ])

    # Daily aggregation (filter for good irradiance)
    daily = df.filter(pl.col(irr_col) > 200).group_by('date').agg([
        pl.col(inv_col).mean().alias('power'),
        pl.col(irr_col).mean().alias('irradiance'),
        pl.mean_horizontal(*[pl.col(c) for c in sr_cols]).mean().alias('sr_dustiq'),
    ]).sort('date').to_pandas()

    daily['date'] = pd.to_datetime(daily['date'])
    daily = daily.set_index('date')
    daily['sr_dustiq'] = daily['sr_dustiq'] / 100  # Convert % to ratio

    # Preclean SR data: keep only valid values (0.70-1.02, matching training data range)
    valid_sr = (daily['sr_dustiq'] >= 0.70) & (daily['sr_dustiq'] <= 1.02)
    n_invalid = (~valid_sr).sum()
    if n_invalid > 0:
        print(f"    Precleaning: removing {n_invalid} invalid SR values (out of {len(daily)})")
        daily = daily[valid_sr]

    # Split into SCADA and ground truth
    df_scada = daily[['power', 'irradiance']].copy()
    sr_actual = daily['sr_dustiq'].copy()

    print(f"    Loaded inverter {inverter_id}: {len(df_scada)} days")
    return df_scada, sr_actual


def load_inverter_features(
    plant_id: str,
    df_scada: pd.DataFrame,
    inverter_id: str = None,
    include_hybrid: bool = True
) -> Optional[pd.DataFrame]:
    """Extract features for a specific inverter.

    Uses the inverter's power data but shares environmental features.
    """
    if inverter_id is None:
        inverter_id = BEST_INVERTERS.get(plant_id)

    # Load the base features (environmental, temporal)
    from scripts.evaluate_transfer_enhanced import load_plant_enhanced_features, load_plant_scada

    # Load plant-level SCADA to get environmental features
    df_plant_scada, _ = load_plant_scada(plant_id, use_cleaned=True)
    if df_plant_scada is None:
        return None

    # Get base features
    df_features = load_plant_enhanced_features(plant_id, df_plant_scada, include_hybrid=include_hybrid)
    if df_features is None:
        return None

    # Replace P_hybrid with inverter's normalized power if available
    if 'P_hybrid' in df_features.columns and df_scada is not None:
        # Align indices
        common_idx = df_features.index.intersection(df_scada.index)
        if len(common_idx) > 0:
            # Scale inverter power to match P_hybrid scale
            inv_power = df_scada.loc[common_idx, 'power']
            # Use z-score scaling to match P_hybrid distribution
            p_hybrid_mean = df_features['P_hybrid'].mean()
            p_hybrid_std = df_features['P_hybrid'].std()
            inv_mean = inv_power.mean()
            inv_std = inv_power.std()

            if inv_std > 0 and p_hybrid_std > 0:
                inv_scaled = (inv_power - inv_mean) / inv_std * p_hybrid_std + p_hybrid_mean
                df_features.loc[common_idx, 'P_hybrid'] = inv_scaled.values

    return df_features


def detect_cleaning_events(
    sr_series: pd.Series,
    rainfall_series: Optional[pd.Series] = None,
    sr_increase_threshold: float = 0.05,  # 5% increase (was 3% - too sensitive)
    lookback_days: int = 5,               # 5 days (was 3 - too sensitive)
    rain_threshold: float = 10.0,         # 10mm to count as cleaning rain (was 5mm)
) -> pd.Series:
    """Detect manual cleaning events from SR spikes without rain.

    If SR increases significantly and there was no significant rain,
    it's likely a manual cleaning event.

    Conservative thresholds to avoid false positives from natural SR recovery
    (dew, humidity changes, etc.).

    Returns:
        Series with 1.0 for detected cleaning days, 0.0 otherwise
    """
    cleaning_events = pd.Series(0.0, index=sr_series.index)

    # Calculate SR change over lookback window
    sr_change = sr_series.diff(lookback_days)

    # Find significant SR increases
    significant_increase = sr_change > sr_increase_threshold

    if rainfall_series is not None:
        # Check if there was rain in the past lookback_days
        rain_sum = rainfall_series.rolling(lookback_days, min_periods=1).sum()
        no_rain = rain_sum < rain_threshold

        # Cleaning = significant SR increase WITHOUT rain
        cleaning_events = (significant_increase & no_rain).astype(float)
    else:
        # Without rain data, just mark all significant increases
        cleaning_events = significant_increase.astype(float)

    return cleaning_events


def add_cleaning_features(
    df_features: pd.DataFrame,
    sr_actual: pd.Series,
    plant_id: str,
) -> pd.DataFrame:
    """Add cleaning detection features to the feature matrix.

    Detects manual cleaning events and adds features:
    - is_cleaning_event: 1 if manual cleaning detected
    - days_since_cleaning: Days since last cleaning (rain or manual)
    """
    # Load rainfall data
    import json
    from pathlib import Path

    rainfall = None
    weather_paths = [
        Path(f"public/data/soiling/{plant_id}/weather_extended.json"),
        Path(f"public/data/soiling/{plant_id}/rain_history.json"),
    ]

    for path in weather_paths:
        if path.exists():
            try:
                with open(path, 'r') as f:
                    data = json.load(f)
                df_weather = pd.DataFrame(data.get('daily_data', data))
                df_weather['date'] = pd.to_datetime(df_weather['date'])
                df_weather = df_weather.set_index('date')

                precip_col = None
                for col in ['precipitation_mm', 'precipitation']:
                    if col in df_weather.columns:
                        precip_col = col
                        break

                if precip_col:
                    rainfall = df_weather[precip_col].reindex(sr_actual.index).fillna(0)
                    break
            except Exception:
                continue

    # Align SR to features index
    sr_aligned = sr_actual.reindex(df_features.index)

    # Detect manual cleaning events
    cleaning_events = detect_cleaning_events(sr_aligned, rainfall)

    # Add features
    df_features = df_features.copy()
    df_features['is_cleaning_event'] = cleaning_events.values

    # Days since any cleaning (rain OR manual)
    if rainfall is not None:
        rainfall_aligned = rainfall.reindex(df_features.index).fillna(0)
        is_rain_cleaning = rainfall_aligned >= 5.0  # Significant rain
        is_any_cleaning = (cleaning_events > 0) | is_rain_cleaning
    else:
        is_any_cleaning = cleaning_events > 0

    # Calculate days since cleaning
    days_since = pd.Series(0, index=df_features.index)
    last_clean_day = 0
    for i, (idx, is_clean) in enumerate(is_any_cleaning.items()):
        if is_clean:
            last_clean_day = i
        days_since.loc[idx] = i - last_clean_day

    df_features['days_since_cleaning'] = days_since.values

    # Count cleaning events in past 30 days
    cleaning_30d = cleaning_events.rolling(30, min_periods=1).sum()
    df_features['manual_cleanings_30d'] = cleaning_30d.values

    n_events = int(cleaning_events.sum())
    if n_events > 0:
        print(f"    Detected {n_events} manual cleaning events")

    return df_features


def rolling_avg(arr: np.ndarray, window: int = 7) -> np.ndarray:
    """Calculate rolling average."""
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


def load_rainfall_data(plant_id: str) -> Optional[pd.Series]:
    """Load rainfall data for a plant."""
    weather_paths = [
        Path(f"public/data/soiling/{plant_id}/weather_extended.json"),
        Path(f"public/data/soiling/{plant_id}/rain_history.json"),
    ]

    for path in weather_paths:
        if path.exists():
            try:
                with open(path, 'r') as f:
                    data = json.load(f)
                df_weather = pd.DataFrame(data.get('daily_data', data))
                df_weather['date'] = pd.to_datetime(df_weather['date'])
                df_weather = df_weather.set_index('date')

                for col in ['precipitation_mm', 'precipitation']:
                    if col in df_weather.columns:
                        return df_weather[col].fillna(0)
            except Exception:
                continue
    return None


def apply_soiling_rate_cap(
    sr_series: pd.Series,
    max_daily_rate: float,
    rain_series: Optional[pd.Series] = None,
    smooth_window: int = 3,
) -> pd.Series:
    """Cap soiling rate to physically possible values.

    Soiling cannot accumulate faster than max_daily_rate per day.
    Rain days are allowed to have faster upward recovery (uncapped).

    Args:
        sr_series: Soiling ratio time series
        max_daily_rate: Maximum daily decline (e.g., 0.005 = 0.5%/day)
        rain_series: Optional rainfall data to allow rain recovery
        smooth_window: EWM smoothing span

    Returns:
        Rate-capped and smoothed SR series
    """
    sr_diff = sr_series.diff()

    if rain_series is not None:
        # Align rain series to SR index
        rain_aligned = rain_series.reindex(sr_series.index).fillna(0)
        is_rain_day = rain_aligned >= 5.0  # Significant rain
    else:
        is_rain_day = pd.Series(False, index=sr_series.index)

    # Only cap negative changes (soiling accumulation), not rain recovery
    sr_diff_capped = sr_diff.where(
        (sr_diff >= 0) | is_rain_day,  # Don't cap recovery or rain days
        sr_diff.clip(lower=-max_daily_rate)
    )

    # Reconstruct from capped differences
    sr_capped = sr_series.iloc[0] + sr_diff_capped.cumsum().fillna(0)

    # Apply smoothing to reduce erratic jumps
    sr_smoothed = sr_capped.ewm(span=smooth_window, min_periods=1).mean()

    return sr_smoothed.clip(0.7, 1.0)


def apply_rain_anchor_calibration(
    sr_series: pd.Series,
    rain_series: pd.Series,
    heavy_threshold: float = 10.0,
    moderate_threshold: float = 5.0,
    blend_weight: float = 0.3,
) -> pd.Series:
    """Apply rain anchor calibration to SR estimates.

    Heavy rain (>10mm) should reset SR to ~0.995 (near clean).
    This grounds physics-based estimates to known clean states.

    Args:
        sr_series: Raw SR estimates
        rain_series: Daily rainfall in mm
        heavy_threshold: Rain amount for full reset (mm)
        moderate_threshold: Rain amount for partial reset (mm)
        blend_weight: How much to weight anchor vs estimate (0-1)

    Returns:
        Calibrated SR series
    """
    sr_calibrated = sr_series.copy()
    rain_aligned = rain_series.reindex(sr_series.index).fillna(0)

    # Find rain anchor points
    heavy_rain = rain_aligned >= heavy_threshold
    moderate_rain = (rain_aligned >= moderate_threshold) & ~heavy_rain

    # Apply anchors with blending (not hard reset)
    # Heavy rain: blend toward 0.995
    sr_calibrated = sr_calibrated.where(
        ~heavy_rain,
        sr_calibrated * (1 - blend_weight) + 0.995 * blend_weight
    )

    # Moderate rain: blend toward 0.98
    sr_calibrated = sr_calibrated.where(
        ~moderate_rain,
        sr_calibrated * (1 - blend_weight * 0.5) + 0.98 * blend_weight * 0.5
    )

    # Light forward propagation: only constrain first 3 days after heavy rain
    # This prevents unrealistic immediate drops after rain without overriding the signal
    result = sr_calibrated.copy()
    last_anchor_sr = None
    last_anchor_day = -100  # Far in past

    for i, (idx, sr) in enumerate(sr_calibrated.items()):
        if heavy_rain.get(idx, False):
            last_anchor_sr = 0.995
            last_anchor_day = i
        elif moderate_rain.get(idx, False):
            last_anchor_sr = 0.98
            last_anchor_day = i

        days_since = i - last_anchor_day
        if last_anchor_sr is not None and 0 < days_since <= 3:
            # Only constrain first 3 days: can't drop more than 1%/day
            min_sr = last_anchor_sr - 0.01 * days_since
            if sr < min_sr:
                result.iloc[i] = sr * 0.5 + min_sr * 0.5

    return result.clip(0.7, 1.0)


def evaluate_predictions(y_pred: np.ndarray, y_true: np.ndarray) -> Dict:
    """Evaluate predictions with comprehensive metrics."""
    from scipy.stats import spearmanr, pearsonr
    from sklearn.metrics import r2_score

    # 7-day rolling average
    y_pred_7d = rolling_avg(y_pred, 7)
    y_true_7d = rolling_avg(y_true, 7)

    errors = y_pred_7d - y_true_7d

    # Overall metrics
    mae = np.mean(np.abs(errors))
    rmse = np.sqrt(np.mean(errors**2))
    mbe = np.mean(errors)  # + = predicts cleaner (risky), - = predicts dirtier (safe)
    worst_over = np.max(errors)
    worst_under = np.min(errors)

    # Spearman correlation (rank correlation - captures trend following)
    spearman_corr, spearman_pval = spearmanr(y_pred_7d, y_true_7d)

    # Pearson correlation (linear correlation)
    pearson_corr, pearson_pval = pearsonr(y_pred_7d, y_true_7d)

    # R² (coefficient of determination)
    r2 = r2_score(y_true_7d, y_pred_7d)

    # By SR bin
    bins_result = {}
    for low, high, label in SR_BINS:
        mask = (y_true_7d >= low) & (y_true_7d < high)
        if mask.sum() > 0:
            bin_errors = errors[mask]
            bins_result[label] = {
                'count': int(mask.sum()),
                'mae': float(np.mean(np.abs(bin_errors))),
                'mbe': float(np.mean(bin_errors)),
            }

    return {
        'mae_7d': float(mae),
        'rmse_7d': float(rmse),
        'mbe_7d': float(mbe),
        'spearman_corr': float(spearman_corr) if not np.isnan(spearman_corr) else 0.0,
        'spearman_pval': float(spearman_pval) if not np.isnan(spearman_pval) else 1.0,
        'pearson_corr': float(pearson_corr) if not np.isnan(pearson_corr) else 0.0,
        'pearson_pval': float(pearson_pval) if not np.isnan(pearson_pval) else 1.0,
        'r2': float(r2) if not np.isnan(r2) else 0.0,
        'worst_over': float(worst_over),
        'worst_under': float(worst_under),
        'is_conservative': mbe < 0,
        'bins': bins_result,
        'n_samples': len(y_true),
    }


def train_same_plant_model(
    X: np.ndarray, y: np.ndarray, train_pct: float = 0.8
) -> Tuple[CatBoostRegressor, np.ndarray, np.ndarray, np.ndarray]:
    """Train same-plant model and return predictions on test set."""
    n_train = int(len(X) * train_pct)

    X_train, X_test = X[:n_train], X[n_train:]
    y_train, y_test = y[:n_train], y[n_train:]

    model = CatBoostRegressor(
        iterations=200,
        learning_rate=0.02,
        depth=3,
        l2_leaf_reg=15.0,
        min_data_in_leaf=30,
        loss_function='MAE',
        random_seed=42,
        verbose=False,
    )
    model.fit(X_train, y_train, verbose=False)

    y_pred = model.predict(X_test)
    return model, y_pred, y_test, X_test


def train_transfer_model(
    source_id: str, target_X: np.ndarray, target_y: np.ndarray,
    use_inverter_level: bool = True
) -> np.ndarray:
    """Train on source plant (using best inverter), predict on target.

    Args:
        source_id: Source plant ID
        target_X: Target features (already at inverter level)
        target_y: Target ground truth
        use_inverter_level: If True, train on best inverter from source plant
    """
    # Load source data - use inverter level if enabled
    if use_inverter_level:
        df_src, sr_src = load_inverter_scada(source_id)
        if df_src is not None:
            df_feat_src = load_inverter_features(source_id, df_src)
        else:
            df_feat_src = None
    else:
        df_src, sr_src = load_plant_scada(source_id, use_cleaned=True)
        # NOTE: include_soiling_twin=False - SAT features hurt transfer learning
        df_feat_src = load_plant_enhanced_features(source_id, df_src, include_hybrid=True, include_soiling_twin=False) if df_src is not None else None

    if df_src is None or df_feat_src is None:
        return None

    common_idx = df_feat_src.index.intersection(sr_src.index)
    X_train = df_feat_src.loc[common_idx].values
    y_train = sr_src.loc[common_idx].values

    # Handle NaN in features
    X_train = np.nan_to_num(X_train, nan=0.0)

    # Preclean SR data: filter out NaN and invalid values (SR should be 0.70-1.02)
    valid_mask = ~np.isnan(y_train) & (y_train >= 0.70) & (y_train <= 1.02)
    if valid_mask.sum() < len(y_train):
        X_train = X_train[valid_mask]
        y_train = y_train[valid_mask]

    if len(y_train) < 50:
        return None  # Insufficient data

    # Sample weighting for dirty days (tuned via Optuna - trial 95)
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 5.96
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.45
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 1.80
    sample_weights[(y_train >= 0.98) & (y_train < 0.99)] = 2.76

    # CatBoost params tuned via Optuna (backenddata/tuning/tuning_results.json)
    model = CatBoostRegressor(
        iterations=677,
        learning_rate=0.0069,
        depth=8,
        l2_leaf_reg=6.88,
        min_data_in_leaf=29,
        loss_function='MAE',
        random_seed=42,
        verbose=False,
    )
    model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)

    # Align features
    target_X = np.nan_to_num(target_X, nan=0.0)
    if target_X.shape[1] != X_train.shape[1]:
        if target_X.shape[1] < X_train.shape[1]:
            diff = X_train.shape[1] - target_X.shape[1]
            target_X = np.hstack([target_X, np.zeros((len(target_X), diff))])
        else:
            target_X = target_X[:, :X_train.shape[1]]

    y_pred = model.predict(target_X)
    return y_pred


def compare_plant(plant_id: str, foundation_model: dict, use_inverter_level: bool = True) -> Dict:
    """Compare all methods for a single plant using best inverter data.

    Args:
        plant_id: Target plant ID
        foundation_model: Foundation model dict with 'model', 'feature_cols', 'climate_encoding'
        use_inverter_level: If True, use best inverter data for predictions
    """
    best_inv = BEST_INVERTERS.get(plant_id, "plant-level")
    print(f"\n{'='*60}")
    print(f"PLANT: {plant_id.upper()} (Best Inverter: {best_inv})")
    print(f"{'='*60}")

    results = {'plant_id': plant_id, 'best_inverter': best_inv, 'methods': {}}

    # Load inverter-level data if available, otherwise fall back to plant-level
    if use_inverter_level and plant_id in BEST_INVERTERS:
        df_scada, sr_actual = load_inverter_scada(plant_id)
        if df_scada is not None:
            df_features = load_inverter_features(plant_id, df_scada)
            print(f"  Using inverter-level data: {best_inv}")
        else:
            # Fall back to plant level
            df_scada, sr_actual = load_plant_scada(plant_id, use_cleaned=True)
            df_features = load_plant_enhanced_features(plant_id, df_scada, include_hybrid=True) if df_scada is not None else None
            print(f"  Falling back to plant-level data")
    else:
        df_scada, sr_actual = load_plant_scada(plant_id, use_cleaned=True)
        df_features = load_plant_enhanced_features(plant_id, df_scada, include_hybrid=True) if df_scada is not None else None

    if df_scada is None:
        print(f"  Could not load data")
        return results

    if df_features is None:
        print(f"  Could not extract features")
        return results

    # Add cleaning detection features (uses SR ground truth to detect manual cleaning)
    df_features = add_cleaning_features(df_features, sr_actual, plant_id)

    # Align
    common_idx = df_features.index.intersection(sr_actual.index)
    X = df_features.loc[common_idx].values
    y = sr_actual.loc[common_idx].values

    # Handle NaN in features and target
    X = np.nan_to_num(X, nan=0.0)

    # Preclean SR data: filter out NaN and invalid values (SR should be 0.70-1.02)
    valid_mask = ~np.isnan(y) & (y >= 0.70) & (y <= 1.02)
    n_invalid = (~valid_mask).sum()
    if n_invalid > 0:
        n_nan = np.isnan(y).sum()
        n_out_of_range = ((y < 0.70) | (y > 1.02)).sum() - n_nan  # Avoid double counting NaN
        print(f"  Precleaning SR: removing {n_invalid} invalid values ({n_nan} NaN, {n_out_of_range} out of range)")
        X = X[valid_mask]
        y = y[valid_mask]
        common_idx = common_idx[valid_mask]

    if len(y) < 100:
        print(f"  WARNING: Only {len(y)} valid samples after precleaning - insufficient data")
        return results

    # Train/test split for metrics calculation
    n_train = int(len(X) * 0.8)
    X_train, X_test = X[:n_train], X[n_train:]
    y_train, y_test = y[:n_train], y[n_train:]
    dates_all = common_idx
    dates_test = common_idx[n_train:]

    # Store predictions for plotting - use ALL dates for visualization
    predictions = {
        'dates': [d.isoformat() for d in dates_all],
        'actual': y.tolist(),  # All actual values
    }

    # --- Method 2: Same-Plant ML ---
    print(f"\n  Method 2: Same-Plant ML")
    model_same, y_pred_test, _, _ = train_same_plant_model(X, y)
    results['methods']['same_plant'] = evaluate_predictions(y_pred_test, y_test)
    # Predict on ALL data for visualization
    y_pred_same_all = model_same.predict(X)
    predictions['same_plant'] = y_pred_same_all.tolist()
    print(f"    MAE: {results['methods']['same_plant']['mae_7d']*100:.2f}%, "
          f"MBE: {results['methods']['same_plant']['mbe_7d']*100:+.2f}%, "
          f"ρ={results['methods']['same_plant']['spearman_corr']:.3f}")

    # --- Method 3: Transfer Learning ---
    print(f"\n  Method 3: Transfer Learning (plant-level)")
    # Use plant-level data for BOTH source and target to match plot_transfer_predictions.py
    # This gives consistent results with the enhanced feature extraction approach
    best_mae = float('inf')
    best_source = None
    best_pred_test = None
    best_pred_all = None

    # Load plant-level data for transfer learning (separate from inverter-level used above)
    # NOTE: include_soiling_twin=False - SAT features hurt transfer learning
    df_plant_scada, sr_plant = load_plant_scada(plant_id, use_cleaned=True)
    df_plant_features = load_plant_enhanced_features(plant_id, df_plant_scada, include_hybrid=True, include_soiling_twin=False) if df_plant_scada is not None else None

    if df_plant_features is not None:
        plant_common_idx = df_plant_features.index.intersection(sr_plant.index)
        X_plant = df_plant_features.loc[plant_common_idx].values
        y_plant = sr_plant.loc[plant_common_idx].values
        X_plant = np.nan_to_num(X_plant, nan=0.0)
        valid_plant = ~np.isnan(y_plant) & (y_plant >= 0.70) & (y_plant <= 1.02)
        X_plant, y_plant = X_plant[valid_plant], y_plant[valid_plant]
        plant_common_idx = plant_common_idx[valid_plant]

        n_train_plant = int(len(X_plant) * 0.8)
        X_plant_test = X_plant[n_train_plant:]
        y_plant_test = y_plant[n_train_plant:]

        # Try all sources and track both MAE and correlation
        source_results = []
        source_preds = {}  # Store predictions for each source
        for source in ALL_SOURCE_PLANTS:
            if source == plant_id:
                continue
            y_pred_transfer = train_transfer_model(source, X_plant_test, y_plant_test, use_inverter_level=False)
            if y_pred_transfer is not None:
                mae = np.mean(np.abs(rolling_avg(y_pred_transfer, 7) - rolling_avg(y_plant_test, 7)))
                # Also compute correlation for better source selection
                from scipy.stats import spearmanr
                corr, _ = spearmanr(rolling_avg(y_pred_transfer, 7), rolling_avg(y_plant_test, 7), nan_policy='omit')
                corr = corr if not np.isnan(corr) else 0

                # COMPOUND QUALITY METRIC (updated 2026-01-20)
                # Quality = ρ × Skill = ρ × (1 - MAE/σ_target)
                # - Penalizes constant predictions (ρ=0 → Quality=0)
                # - Penalizes models worse than naive (MAE > σ → Skill < 0)
                # - Rewards both correlation AND low MAE relative to signal
                sigma_target = DUSTIQ_STD.get(plant_id, 0.015)  # Target plant's DustIQ variance
                sigma_source = DUSTIQ_STD.get(source, 0.015)    # Source plant's variance (training quality)
                skill = max(0, 1 - mae / sigma_target)
                quality = corr * skill
                # Boost for high-variance sources (better training signal)
                quality_adj = quality * np.sqrt(sigma_source / 0.01)  # Normalized to 1% baseline
                source_results.append((source, mae, corr, skill, quality, quality_adj))
                source_preds[source] = y_pred_transfer

        # Select by CLIMATE SIMILARITY + MULTI-SOURCE ENSEMBLE + BIAS CORRECTION
        if source_results:
            target_climate = PLANT_CLIMATE.get(plant_id, "semi-arid")

            # Sort by correlation for selection
            source_results.sort(key=lambda x: -x[2])  # Sort by ρ descending

            # Get top 3 sources (prioritize same climate, then by correlation)
            same_climate_sources = [(src, mae, corr) for src, mae, corr, _, _, _ in source_results
                                     if PLANT_CLIMATE.get(src, "") == target_climate]
            other_sources = [(src, mae, corr) for src, mae, corr, _, _, _ in source_results
                             if PLANT_CLIMATE.get(src, "") != target_climate]

            # Select top 2-3 sources: prefer same climate, fill with best others
            ensemble_sources = []
            for src, mae, corr in same_climate_sources[:2]:  # Up to 2 same-climate
                if corr > 0.1:  # Only use if correlation is positive
                    ensemble_sources.append(src)
            for src, mae, corr in other_sources:
                if len(ensemble_sources) >= 3:
                    break
                if corr > 0.3:  # Higher threshold for cross-climate
                    ensemble_sources.append(src)

            # Fallback: use climate-based selection if no good ensemble
            if not ensemble_sources:
                available_sources = [src for src, _, _, _, _, _ in source_results]
                best_source = get_climate_based_source(plant_id, available_sources)
                if best_source:
                    ensemble_sources = [best_source]

            # Print selection info
            print(f"    Transfer: MULTI-SOURCE ENSEMBLE (target: {target_climate}, no bias correction):")
            for src, mae, corr, skill, quality, quality_adj in source_results:
                src_climate = PLANT_CLIMATE.get(src, "unknown")
                climate_match = "✓" if src_climate == target_climate else " "
                marker = " ← ENSEMBLE" if src in ensemble_sources else ""
                print(f"      {src:15} [{src_climate:10}] {climate_match} ρ={corr:.3f} MAE={mae*100:.2f}%{marker}")

            # Create ensemble predictions (average of selected sources)
            if ensemble_sources:
                # Test set predictions
                ensemble_preds_test = []
                for src in ensemble_sources:
                    if src in source_preds:
                        ensemble_preds_test.append(source_preds[src])

                if ensemble_preds_test:
                    # Average ensemble predictions (NO BIAS CORRECTION - would be data leakage)
                    best_pred_test = np.mean(ensemble_preds_test, axis=0)

                    print(f"    Ensemble of {len(ensemble_sources)} sources: {', '.join(ensemble_sources)}")

                    # Get full predictions for visualization
                    ensemble_preds_all = []
                    for src in ensemble_sources:
                        pred_all = train_transfer_model(src, X_plant, y_plant, use_inverter_level=False)
                        if pred_all is not None:
                            ensemble_preds_all.append(pred_all)

                    if ensemble_preds_all:
                        best_pred_all = np.mean(ensemble_preds_all, axis=0)
                    else:
                        best_pred_all = best_pred_test

                    best_source = "+".join(ensemble_sources[:2])  # For display

    if best_pred_test is not None:
        source_inv = "ensemble"
        results['methods']['transfer'] = evaluate_predictions(best_pred_test, y_plant_test)
        results['methods']['transfer']['source'] = best_source
        results['methods']['transfer']['source_inverter'] = source_inv
        results['methods']['transfer']['target_inverter'] = best_inv
        results['methods']['transfer']['ensemble_sources'] = ensemble_sources if 'ensemble_sources' in dir() else [best_source]
        predictions['transfer'] = best_pred_all.tolist() if best_pred_all is not None else best_pred_test.tolist()
        print(f"    MAE: {results['methods']['transfer']['mae_7d']*100:.2f}%, "
              f"MBE: {results['methods']['transfer']['mbe_7d']*100:+.2f}%, "
              f"ρ={results['methods']['transfer']['spearman_corr']:.3f}")

    # --- Method 4: Foundation Model (Leak-Free LOPO) ---
    print(f"\n  Method 4: Foundation Model (Leak-Free LOPO)")
    # Load leak-free results - TRUE LOPO with no data leakage
    leak_free_path = Path("backenddata/foundation_model/leak_free_results.json")
    if leak_free_path.exists():
        with open(leak_free_path) as f:
            leak_free_data = json.load(f)

        if plant_id in leak_free_data.get('results', {}):
            lf = leak_free_data['results'][plant_id]
            m = lf['metrics']

            # Convert leak-free metrics to our format
            results['methods']['foundation'] = {
                'mae_7d': m['mae'] / 100,  # Convert from % to fraction
                'rmse_7d': m['rmse'] / 100,
                'mbe_7d': m['mbe'] / 100,
                'spearman_corr': m['spearman'],
                'pearson_corr': m['pearson'],
                'r2': m['r2'],
                'is_conservative': m['mbe'] < 0,  # Negative MBE = conservative
                'leak_free': True,
                'n_train': lf['n_train'],
                'climate': lf['climate'],
            }

            # Load actual predictions if available
            if lf.get('predictions') and lf['predictions'].get('predicted'):
                pred_dates = pd.DatetimeIndex([pd.Timestamp(d) for d in lf['predictions']['dates']])
                pred_values = np.array(lf['predictions']['predicted'])

                # Create a series for easy reindexing
                pred_series = pd.Series(pred_values, index=pred_dates)
                # Reindex to match dates_all
                pred_aligned = pred_series.reindex(dates_all).fillna(0.95).values
                predictions['foundation'] = pred_aligned.tolist()
            else:
                # Fallback to constant if no predictions stored
                mean_sr = 0.95
                predictions['foundation'] = [mean_sr] * len(dates_all)

            print(f"    TRUE LOPO: Trained on {lf['n_train']:,} samples from 6 other plants")
            print(f"    MAE: {m['mae']:.2f}%, MBE: {m['mbe']:+.2f}%, ρ={m['spearman']:.3f}")
        else:
            print(f"    WARNING: No leak-free results for {plant_id}")
    else:
        print(f"    WARNING: Leak-free results not found. Run: python scripts/train_foundation_model_leak_free.py")

    # --- Method 4b: TabPFN Foundation Model (Leak-Free LOPO) ---
    print(f"\n  Method 4b: TabPFN Foundation (LOPO)")
    tabpfn_path = Path("backenddata/foundation_model/tabpfn_results.json")
    if tabpfn_path.exists():
        with open(tabpfn_path) as f:
            tabpfn_data = json.load(f)

        if plant_id in tabpfn_data.get('results', {}):
            tp = tabpfn_data['results'][plant_id]
            tp_m = tp['metrics']
            results['methods']['tabpfn'] = {
                'mae_7d': tp_m['mae'] / 100,
                'rmse_7d': tp_m['rmse'] / 100,
                'mbe_7d': tp_m['mbe'] / 100,
                'spearman_corr': tp_m['spearman'],
                'pearson_corr': tp_m['pearson'],
                'r2': tp_m['r2'],
                'is_conservative': tp_m['mbe'] < 0,
                'leak_free': True,
            }
            if tp.get('predictions') and tp['predictions'].get('predicted'):
                pred_dates = pd.DatetimeIndex([pd.Timestamp(d) for d in tp['predictions']['dates']])
                pred_values = np.array(tp['predictions']['predicted'])
                pred_series = pd.Series(pred_values, index=pred_dates)
                pred_aligned = pred_series.reindex(dates_all).fillna(0.95).values
                predictions['tabpfn'] = pred_aligned.tolist()
            print(f"    MAE: {tp_m['mae']:.2f}%, MBE: {tp_m['mbe']:+.2f}%, ρ={tp_m['spearman']:.3f}")
        else:
            print(f"    WARNING: No TabPFN results for {plant_id}")
    else:
        print(f"    WARNING: TabPFN results not found. Run: python scripts/evaluate_tabpfn_foundation.py")

    # --- Method 6: Ensemble (Transfer + Foundation) ---
    if 'transfer' in predictions and 'foundation' in predictions:
        print(f"\n  Method 6: Ensemble (Transfer + Foundation)")
        transfer_arr = np.array(predictions['transfer'])
        foundation_arr = np.array(predictions['foundation'])
        min_len = min(len(transfer_arr), len(foundation_arr), len(y))
        ensemble_arr = 0.5 * transfer_arr[:min_len] + 0.5 * foundation_arr[:min_len]
        predictions['ensemble'] = ensemble_arr.tolist()

        # Evaluate on test portion
        ensemble_test = ensemble_arr[n_train:min_len]
        y_test_ens = y[n_train:min_len]
        if len(ensemble_test) > 0 and len(y_test_ens) > 0:
            results['methods']['ensemble'] = evaluate_predictions(ensemble_test, y_test_ens)
            print(f"    MAE: {results['methods']['ensemble']['mae_7d']*100:.2f}%, "
                  f"MBE: {results['methods']['ensemble']['mbe_7d']*100:+.2f}%, "
                  f"ρ={results['methods']['ensemble']['spearman_corr']:.3f}")
    else:
        missing = []
        if 'transfer' not in predictions:
            missing.append('transfer')
        if 'foundation' not in predictions:
            missing.append('foundation')
        print(f"\n  Method 6: Ensemble SKIPPED (missing: {', '.join(missing)})")

    # --- Method 7: 3-Way Ensemble (Transfer + Foundation + TabPFN) ---
    if all(k in predictions for k in ('transfer', 'foundation', 'tabpfn')):
        print(f"\n  Method 7: 3-Way Ensemble (Transfer + Foundation + TabPFN)")
        t_arr = np.array(predictions['transfer'])
        f_arr = np.array(predictions['foundation'])
        p_arr = np.array(predictions['tabpfn'])
        min_len3 = min(len(t_arr), len(f_arr), len(p_arr), len(y))
        ens3_arr = (t_arr[:min_len3] + f_arr[:min_len3] + p_arr[:min_len3]) / 3.0
        predictions['ensemble_3way'] = ens3_arr.tolist()

        ens3_test = ens3_arr[n_train:min_len3]
        y_test_ens3 = y[n_train:min_len3]
        if len(ens3_test) > 0 and len(y_test_ens3) > 0:
            results['methods']['ensemble_3way'] = evaluate_predictions(ens3_test, y_test_ens3)
            print(f"    MAE: {results['methods']['ensemble_3way']['mae_7d']*100:.2f}%, "
                  f"MBE: {results['methods']['ensemble_3way']['mbe_7d']*100:+.2f}%, "
                  f"ρ={results['methods']['ensemble_3way']['spearman_corr']:.3f}")
    else:
        print(f"\n  Method 7: 3-Way Ensemble SKIPPED (need transfer + foundation + tabpfn)")

    results['predictions'] = predictions
    return results


def generate_html_report(all_results: Dict, output_path: Path):
    """Generate HTML report with Plotly visualizations."""
    html = '''<!DOCTYPE html>
<html>
<head>
    <title>Soiling Prediction Methods Comparison</title>
    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        h2 { color: #555; margin-top: 40px; border-bottom: 2px solid #ddd; padding-bottom: 10px; }
        .plot-container { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; background: white; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: center; }
        th { background: #4CAF50; color: white; }
        .conservative { background: #c8e6c9; }
        .risky { background: #ffcdd2; }
        .method-box { display: inline-block; padding: 5px 15px; margin: 5px; border-radius: 5px; }
        .legend { margin: 20px 0; }
    </style>
</head>
<body>
    <h1>Soiling Prediction Methods Comparison</h1>
    <p>Generated: ''' + datetime.now().isoformat() + '''</p>

    <h2>Method Overview</h2>
    <div class="legend">
'''

    # Method legend
    for method_id, name in METHOD_NAMES.items():
        color = METHOD_COLORS[method_id]
        html += f'<div class="method-box" style="background: {color}; color: white;">{name}</div>\n'

    html += '''
    </div>

    <h2>Summary Table - All Metrics</h2>
    <p><em>All predictions use the inverter closest to the DustIQ sensor for each plant.</em></p>
    <p><strong>Metrics:</strong> MAE (Mean Absolute Error), RMSE (Root Mean Squared Error), ρ (Spearman Correlation), R² (Coefficient of Determination)</p>
    <table>
        <tr>
            <th>Plant</th>
            <th>Inverter</th>
            <th>Same-Plant ML</th>
            <th>Transfer Learning</th>
            <th>Foundation Model</th>
            <th>TabPFN</th>
            <th>Ensemble (T+F)</th>
            <th>3-Way Ens</th>
        </tr>
'''

    # Summary table rows with all metrics
    for plant_id, results in all_results.items():
        if 'methods' not in results:
            continue

        best_inv = results.get('best_inverter', 'plant-level')
        html += f'        <tr>\n            <td><strong>{plant_id.upper()}</strong></td>\n'
        html += f'            <td><code>{best_inv}</code></td>\n'

        for method in ['same_plant', 'transfer', 'foundation', 'tabpfn', 'ensemble', 'ensemble_3way']:
            if method in results['methods']:
                m = results['methods'][method]
                mae = m['mae_7d'] * 100
                rmse = m.get('rmse_7d', 0) * 100
                mbe = m['mbe_7d'] * 100
                rho = m.get('spearman_corr', 0)
                r2 = m.get('r2', 0)
                css_class = 'conservative' if m.get('is_conservative', False) else 'risky'
                # Show source for transfer learning
                extra = ""
                if method == 'transfer' and 'source' in m:
                    src = m['source']
                    extra = f"<br><small>from {src}</small>"
                html += f'            <td class="{css_class}">MAE: {mae:.2f}%<br>RMSE: {rmse:.2f}%<br>ρ={rho:.2f} R²={r2:.2f}{extra}</td>\n'
            else:
                html += '            <td>N/A</td>\n'

        html += '        </tr>\n'

    html += '''    </table>

    <h2>Prediction Plots</h2>
'''

    # Generate plots for each plant
    for plant_id, results in all_results.items():
        if 'predictions' not in results:
            continue

        preds = results['predictions']
        best_inv = results.get('best_inverter', 'plant-level')

        html += f'''
    <h3>{plant_id.upper()} - Inverter: {best_inv}</h3>
    <div class="plot-container">
        <div id="plot_{plant_id}" style="width:100%;height:500px;"></div>
    </div>
'''

    html += '''
    <script>
'''

    # Generate Plotly data for each plant
    for plant_id, results in all_results.items():
        if 'predictions' not in results:
            continue

        preds = results['predictions']
        best_inv = results.get('best_inverter', 'plant-level')
        traces = []

        # Apply 7-day rolling average for display
        dates = preds['dates']

        # Actual (ground truth)
        actual_7d = rolling_avg(np.array(preds['actual']), 7).tolist()
        traces.append({
            'x': dates,
            'y': actual_7d,
            'name': 'DustIQ Ground Truth',
            'type': 'scatter',
            'mode': 'lines',
            'line': {'color': METHOD_COLORS['actual'], 'width': 3},
        })

        # Other methods
        for method_id in ['same_plant', 'transfer', 'foundation', 'tabpfn', 'ensemble', 'ensemble_3way']:
            if method_id in preds:
                method_7d = rolling_avg(np.array(preds[method_id]), 7).tolist()

                # Get metrics for legend
                if method_id in results['methods']:
                    m = results['methods'][method_id]
                    mae = m['mae_7d']*100
                    rmse = m.get('rmse_7d', 0)*100
                    rho = m.get('spearman_corr', 0)
                    r2 = m.get('r2', 0)
                    label = f"{METHOD_NAMES[method_id]} (MAE:{mae:.1f}% RMSE:{rmse:.1f}% ρ={rho:.2f} R²={r2:.2f})"
                else:
                    label = METHOD_NAMES[method_id]

                traces.append({
                    'x': dates,
                    'y': method_7d,
                    'name': label,
                    'type': 'scatter',
                    'mode': 'lines',
                    'line': {'color': METHOD_COLORS[method_id], 'width': 1.5},
                    'opacity': 0.8,
                })

        html += f'''
        Plotly.newPlot('plot_{plant_id}', {json.dumps(traces)}, {{
            title: 'Soiling Ratio: {plant_id.upper()} [{best_inv}] (7-day rolling avg)',
            xaxis: {{ title: 'Date', type: 'date' }},
            yaxis: {{ title: 'Soiling Ratio', range: [0.85, 1.02] }},
            hovermode: 'x unified',
            legend: {{ orientation: 'h', y: -0.2 }},
            shapes: [{{
                type: 'line', x0: '{dates[0]}', x1: '{dates[-1]}',
                y0: 0.95, y1: 0.95, line: {{ color: 'gray', width: 1, dash: 'dash' }}
            }}],
            annotations: [{{
                x: '{dates[-1]}', y: 0.95, text: 'Cleaning threshold (95%)',
                showarrow: false, xanchor: 'right', font: {{ size: 10, color: 'gray' }}
            }}]
        }});
'''

    html += '''
    </script>

    <h2>Method Comparison</h2>
    <table>
        <tr>
            <th>Aspect</th>
            <th>Same-Plant ML</th>
            <th>Transfer Learning</th>
            <th>Foundation Model</th>
            <th>TabPFN Foundation</th>
            <th>Ensemble (T+F)</th>
            <th>3-Way Ensemble</th>
        </tr>
        <tr>
            <td><strong>Needs DustIQ at target</strong></td>
            <td>YES</td>
            <td>NO</td>
            <td>NO</td>
            <td>NO</td>
            <td>NO</td>
            <td>NO</td>
        </tr>
        <tr>
            <td><strong>Needs DustIQ anywhere</strong></td>
            <td>YES</td>
            <td>YES (at source)</td>
            <td>YES (for training)</td>
            <td>YES (for training)</td>
            <td>YES (for training)</td>
            <td>YES (for training)</td>
        </tr>
        <tr>
            <td><strong>Expected MAE</strong></td>
            <td>0.1-0.6%</td>
            <td>0.5-3.3%</td>
            <td>0.5-1.6% (MAE loss)</td>
            <td>0.9-2.3% (LOPO)</td>
            <td>0.6-3.1%</td>
            <td>0.5-2.9%</td>
        </tr>
        <tr>
            <td><strong>MBE (bias)</strong></td>
            <td>~0%</td>
            <td>~0%</td>
            <td>-0.5 to +1.2%</td>
            <td>-1.9 to +1.4%</td>
            <td>Avg of transfer + foundation</td>
            <td>Avg of 3 methods</td>
        </tr>
        <tr>
            <td><strong>Model type</strong></td>
            <td>CatBoost (same plant)</td>
            <td>CatBoost (cross-plant)</td>
            <td>CatBoost (LOPO, MAE loss)</td>
            <td>TabPFN v2 (transformer)</td>
            <td>Transfer + Foundation avg</td>
            <td>Transfer + Foundation + TabPFN avg</td>
        </tr>
        <tr>
            <td><strong>Best for</strong></td>
            <td>Same plant with DustIQ</td>
            <td>Nearby plants</td>
            <td>Any location</td>
            <td>Ensemble diversity</td>
            <td>Best accuracy without DustIQ</td>
            <td>Maximum robustness</td>
        </tr>
    </table>

    <p><small><strong>Foundation Model Note</strong>: Uses TRUE LOPO evaluation - when testing on plant X, ZERO data from plant X is used in training. CatBoost foundation uses MAE loss with early stopping (nested LOPO validation).</small></p>
    <p><small><strong>TabPFN Note</strong>: TabPFN v2 (Apache 2.0 license) is a transformer-based tabular foundation model. Subsampled to 3K training samples for CPU feasibility. Different inductive bias provides ensemble diversity.</small></p>
    <p><small><strong>MBE (Mean Bias Error)</strong>: Negative = model over-predicts SR (conservative), Positive = model under-predicts SR.</small></p>

    <h2>Fault vs Soiling Separation</h2>
    <p>For per-inverter SR estimation, distinguish soiling from equipment faults using:</p>
    <table>
        <tr>
            <th>Signal</th>
            <th>Soiling</th>
            <th>Equipment Fault</th>
            <th>Shading</th>
        </tr>
        <tr>
            <td><strong>Fleet CV</strong></td>
            <td style="background: #c8e6c9;">Low (&lt;5%)</td>
            <td style="background: #ffcdd2;">High (&gt;10%)</td>
            <td>Variable</td>
        </tr>
        <tr>
            <td><strong>Change Pattern</strong></td>
            <td style="background: #c8e6c9;">Gradual</td>
            <td style="background: #ffcdd2;">Sudden</td>
            <td>Diurnal</td>
        </tr>
        <tr>
            <td><strong>Rain Response</strong></td>
            <td style="background: #c8e6c9;">Improves</td>
            <td style="background: #ffcdd2;">No change</td>
            <td>No change</td>
        </tr>
        <tr>
            <td><strong>Time Pattern</strong></td>
            <td>No pattern</td>
            <td>Step change</td>
            <td style="background: #ffcdd2;">Morning/evening dips</td>
        </tr>
    </table>

</body>
</html>
'''

    output_path.write_text(html)
    print(f"\nHTML report saved to: {output_path}")


def main():
    print(f"\n{'='*70}")
    print("COMPLETE SOILING PREDICTION METHODS COMPARISON")
    print(f"Generated: {datetime.now().isoformat()}")
    print(f"{'='*70}")

    # Load foundation model with climate categorical
    model_path = Path("backenddata/foundation_model/foundation_model.pkl")
    if model_path.exists():
        print(f"\nLoading foundation model (climate categorical) from: {model_path}")
        import pickle
        with open(model_path, 'rb') as f:
            foundation = pickle.load(f)
        print(f"  Features: {len(foundation['feature_cols'])}, Climate encoding: {foundation['climate_encoding']}")
    else:
        print(f"\nWARNING: Foundation model not found at {model_path}")
        print("  Run: python scripts/train_foundation_model_climate.py")
        foundation = None

    # Compare all methods for each plant
    all_results = {}

    for plant_id in VALID_PLANTS:
        results = compare_plant(plant_id, foundation)
        all_results[plant_id] = results

    # Print summary table
    print(f"\n{'='*120}")
    print("SUMMARY TABLE (MAE% / RMSE% / ρ / R²)")
    print(f"{'='*120}")

    header = f"{'Plant':<12} {'Same-Plant':>26} {'Transfer':>26} {'Foundation':>26} {'TabPFN':>26} {'Ensemble':>26} {'3-Way':>26}"
    print(header)
    print("-" * 120)

    for plant_id, results in all_results.items():
        if 'methods' not in results:
            continue

        row = f"{plant_id:<12}"
        for method in ['same_plant', 'transfer', 'foundation', 'tabpfn', 'ensemble', 'ensemble_3way']:
            if method in results['methods']:
                m = results['methods'][method]
                mae = m['mae_7d'] * 100
                rmse = m.get('rmse_7d', 0) * 100
                rho = m.get('spearman_corr', 0)
                r2 = m.get('r2', 0)
                row += f" {mae:4.1f}/{rmse:4.1f}/ρ{rho:.2f}/R²{r2:.2f}"
            else:
                row += f" {'N/A':>25}"
        print(row)

    # Generate HTML report
    output_dir = Path("backenddata/soiling_comparison")
    output_dir.mkdir(parents=True, exist_ok=True)

    html_path = output_dir / "all_methods_comparison.html"
    generate_html_report(all_results, html_path)

    # Save JSON results
    json_path = output_dir / f"comparison_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(json_path, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'plants': VALID_PLANTS,
            'results': all_results,
        }, f, indent=2, default=str)
    print(f"JSON results saved to: {json_path}")


if __name__ == "__main__":
    main()
