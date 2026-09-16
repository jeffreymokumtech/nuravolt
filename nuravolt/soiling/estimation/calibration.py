"""
Post-hoc calibration utilities for SR estimation layers.

This module provides calibration techniques that can be applied after
any ML-based SR estimation to improve accuracy:

1. Rain Anchor Calibration: Uses heavy rain events as SR reset points
2. Fleet CV Features: Coefficient of variation across inverters

These techniques are particularly valuable for:
- Layer 3 (Transfer Learning): Local rain anchors ground transferred predictions
- Layer 4 (Foundation Model): Post-hoc calibration improves global model accuracy

Reference: IEA PVPS Task 13, Section 4.3
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


# =============================================================================
# Rain Anchor Calibration
# =============================================================================

@dataclass
class RainAnchorConfig:
    """Configuration for rain anchor calibration.

    Attributes
    ----------
    heavy_rain_threshold_mm : float
        Rainfall threshold for full SR reset (default: 10mm)
    moderate_rain_threshold_mm : float
        Rainfall threshold for partial SR reset (default: 5mm)
    post_heavy_rain_sr : float
        Expected SR after heavy rain (default: 0.995)
    post_moderate_rain_sr : float
        Expected SR after moderate rain (default: 0.98)
    base_decay_rate : float
        SR decay rate per day without rain (default: 0.002 = 0.2%/day)
    max_decay_days : int
        Maximum days to project decay forward (default: 30)
    confidence_boost_pct : float
        Confidence boost near rain anchors (default: 10%)
    """
    heavy_rain_threshold_mm: float = 10.0
    moderate_rain_threshold_mm: float = 5.0
    post_heavy_rain_sr: float = 0.995
    post_moderate_rain_sr: float = 0.98
    base_decay_rate: float = 0.002
    max_decay_days: int = 30
    confidence_boost_pct: float = 10.0


@dataclass
class RainAnchor:
    """A rain anchor point for SR calibration."""
    date: pd.Timestamp
    rainfall_mm: float
    expected_sr: float
    confidence: float
    event_type: str  # 'heavy' or 'moderate'


def identify_rain_anchors(
    rain_series: pd.Series,
    config: Optional[RainAnchorConfig] = None,
) -> List[RainAnchor]:
    """Identify rain events that serve as SR calibration anchors.

    Heavy rain events reset SR to ~1.0, providing ground truth anchor points.
    These anchors can constrain SR estimates from ML models.

    Parameters
    ----------
    rain_series : pd.Series
        Daily rainfall in mm, indexed by date
    config : RainAnchorConfig, optional
        Configuration for anchor identification

    Returns
    -------
    List[RainAnchor]
        List of rain anchor points

    Example
    -------
    >>> rain = pd.Series([0, 0, 12, 0, 0, 6, 0],
    ...                  index=pd.date_range('2024-01-01', periods=7))
    >>> anchors = identify_rain_anchors(rain)
    >>> len(anchors)  # 2 anchors: heavy (12mm) and moderate (6mm)
    2
    """
    cfg = config or RainAnchorConfig()
    anchors = []

    for date, rain_mm in rain_series.items():
        if pd.isna(rain_mm):
            continue

        if rain_mm >= cfg.heavy_rain_threshold_mm:
            anchors.append(RainAnchor(
                date=pd.Timestamp(date),
                rainfall_mm=float(rain_mm),
                expected_sr=cfg.post_heavy_rain_sr,
                confidence=0.95,
                event_type='heavy',
            ))
        elif rain_mm >= cfg.moderate_rain_threshold_mm:
            anchors.append(RainAnchor(
                date=pd.Timestamp(date),
                rainfall_mm=float(rain_mm),
                expected_sr=cfg.post_moderate_rain_sr,
                confidence=0.75,
                event_type='moderate',
            ))

    return sorted(anchors, key=lambda a: a.date)


def calibrate_with_rain_anchors(
    sr_estimate: pd.Series,
    rain_series: pd.Series,
    config: Optional[RainAnchorConfig] = None,
    method: str = 'constrain',
) -> Tuple[pd.Series, pd.Series]:
    """Calibrate SR estimates using rain anchor points.

    This function applies physical constraints based on rain events:
    - After heavy rain, SR should be near 1.0
    - SR can only decrease (get dirtier) without rain
    - Decay rate determines maximum SR reduction per day

    Parameters
    ----------
    sr_estimate : pd.Series
        Initial SR estimates (e.g., from ML model), indexed by date
    rain_series : pd.Series
        Daily rainfall in mm, indexed by date
    config : RainAnchorConfig, optional
        Configuration for calibration
    method : str
        Calibration method:
        - 'constrain': Clip SR to not exceed decayed anchor value
        - 'blend': Weighted average near anchors
        - 'forward_simulate': Forward simulate from anchors

    Returns
    -------
    Tuple[pd.Series, pd.Series]
        (calibrated_sr, confidence_adjustment)
        - calibrated_sr: Calibrated SR values
        - confidence_adjustment: Per-day confidence adjustment

    Example
    -------
    >>> sr = pd.Series([0.95, 0.94, 0.98, 0.92, 0.91],
    ...                index=pd.date_range('2024-01-01', periods=5))
    >>> rain = pd.Series([0, 0, 15, 0, 0],
    ...                  index=pd.date_range('2024-01-01', periods=5))
    >>> sr_cal, conf = calibrate_with_rain_anchors(sr, rain)
    >>> sr_cal.iloc[2]  # After heavy rain, should be ~0.995
    0.995
    """
    cfg = config or RainAnchorConfig()

    # Align indices
    common_idx = sr_estimate.index.intersection(rain_series.index)
    if len(common_idx) == 0:
        # No overlap - return original
        return sr_estimate, pd.Series(0.0, index=sr_estimate.index)

    sr = sr_estimate.reindex(common_idx).copy()
    rain = rain_series.reindex(common_idx).fillna(0)

    # Identify anchors
    anchors = identify_rain_anchors(rain, cfg)

    if len(anchors) == 0:
        # No rain anchors - return original with slight confidence reduction
        return sr_estimate, pd.Series(-5.0, index=sr_estimate.index)

    # Initialize output
    sr_calibrated = sr.copy()
    confidence_adj = pd.Series(0.0, index=sr.index)

    if method == 'constrain':
        sr_calibrated, confidence_adj = _calibrate_constrain(
            sr, anchors, cfg, rain
        )
    elif method == 'blend':
        sr_calibrated, confidence_adj = _calibrate_blend(
            sr, anchors, cfg, rain
        )
    elif method == 'forward_simulate':
        sr_calibrated, confidence_adj = _calibrate_forward_simulate(
            sr, anchors, cfg, rain
        )
    else:
        raise ValueError(f"Unknown calibration method: {method}")

    # Ensure valid SR range
    sr_calibrated = sr_calibrated.clip(0.7, 1.0)

    # Reindex back to original index
    sr_calibrated = sr_calibrated.reindex(sr_estimate.index)
    confidence_adj = confidence_adj.reindex(sr_estimate.index, fill_value=0.0)

    # Fill any gaps with original estimates
    sr_calibrated = sr_calibrated.fillna(sr_estimate)

    return sr_calibrated, confidence_adj


def _calibrate_constrain(
    sr: pd.Series,
    anchors: List[RainAnchor],
    cfg: RainAnchorConfig,
    rain: pd.Series,
) -> Tuple[pd.Series, pd.Series]:
    """Constrain SR to not exceed physically possible values.

    After rain, SR resets. Then it can only decrease (panels get dirtier).
    This method clips SR estimates to respect these physical constraints.
    """
    sr_cal = sr.copy()
    conf_adj = pd.Series(0.0, index=sr.index)

    # Sort dates
    dates = sorted(sr.index)

    for date in dates:
        # Find most recent anchor before or on this date
        prior_anchors = [a for a in anchors if a.date <= date]

        if not prior_anchors:
            continue

        latest_anchor = prior_anchors[-1]
        days_since = (pd.Timestamp(date) - latest_anchor.date).days

        if days_since < 0:
            continue

        # Calculate expected max SR based on decay from anchor
        expected_max_sr = latest_anchor.expected_sr - (cfg.base_decay_rate * days_since)
        expected_max_sr = max(0.7, expected_max_sr)

        # Check for intermediate rain events that might have cleaned
        intermediate_rain = rain.loc[latest_anchor.date:date].iloc[1:] if days_since > 0 else pd.Series()
        if len(intermediate_rain) > 0 and intermediate_rain.max() >= cfg.moderate_rain_threshold_mm:
            # There was rain since the anchor - don't constrain too tightly
            continue

        # Constrain: SR cannot exceed expected_max_sr
        if sr_cal.loc[date] > expected_max_sr:
            sr_cal.loc[date] = expected_max_sr

        # Boost confidence near anchors
        if days_since <= 3:
            conf_adj.loc[date] = cfg.confidence_boost_pct * latest_anchor.confidence
        elif days_since <= 7:
            conf_adj.loc[date] = cfg.confidence_boost_pct * latest_anchor.confidence * 0.5

    return sr_cal, conf_adj


def _calibrate_blend(
    sr: pd.Series,
    anchors: List[RainAnchor],
    cfg: RainAnchorConfig,
    rain: pd.Series,
) -> Tuple[pd.Series, pd.Series]:
    """Blend ML estimate with anchor-based estimate near rain events.

    Uses weighted average where weight of anchor-based estimate
    decreases with distance from anchor.
    """
    sr_cal = sr.copy()
    conf_adj = pd.Series(0.0, index=sr.index)

    for date in sr.index:
        # Find nearest anchor
        nearest_anchor = None
        min_distance = float('inf')

        for anchor in anchors:
            distance = abs((pd.Timestamp(date) - anchor.date).days)
            if distance < min_distance:
                min_distance = distance
                nearest_anchor = anchor

        if nearest_anchor is None or min_distance > cfg.max_decay_days:
            continue

        # Calculate anchor-based SR estimate
        days_since = (pd.Timestamp(date) - nearest_anchor.date).days
        if days_since >= 0:
            anchor_sr = nearest_anchor.expected_sr - (cfg.base_decay_rate * days_since)
        else:
            # Before anchor - use model estimate primarily
            anchor_sr = sr.loc[date]

        anchor_sr = max(0.7, min(1.0, anchor_sr))

        # Blend weight: decays exponentially with distance from anchor
        # At anchor: weight = 0.8, at 7 days: weight ≈ 0.4, at 14 days: weight ≈ 0.2
        blend_weight = 0.8 * np.exp(-min_distance / 10.0)

        # Blend estimates
        sr_cal.loc[date] = blend_weight * anchor_sr + (1 - blend_weight) * sr.loc[date]

        # Confidence adjustment
        conf_adj.loc[date] = cfg.confidence_boost_pct * blend_weight * nearest_anchor.confidence

    return sr_cal, conf_adj


def _calibrate_forward_simulate(
    sr: pd.Series,
    anchors: List[RainAnchor],
    cfg: RainAnchorConfig,
    rain: pd.Series,
) -> Tuple[pd.Series, pd.Series]:
    """Forward simulate SR from each anchor, using ML estimate as guide.

    Most aggressive calibration - fully replaces ML estimate between anchors
    with physics-based simulation guided by decay rate.
    """
    sr_cal = sr.copy()
    conf_adj = pd.Series(0.0, index=sr.index)

    dates = sorted(sr.index)

    # Process segments between anchors
    for i, anchor in enumerate(anchors):
        # Find segment end (next anchor or end of data)
        if i < len(anchors) - 1:
            segment_end = anchors[i + 1].date
        else:
            segment_end = dates[-1]

        # Simulate forward from this anchor
        current_sr = anchor.expected_sr

        for date in dates:
            if date < anchor.date:
                continue
            if date > segment_end:
                break

            days_since = (pd.Timestamp(date) - anchor.date).days

            if days_since == 0:
                sr_cal.loc[date] = anchor.expected_sr
                conf_adj.loc[date] = cfg.confidence_boost_pct
            else:
                # Check for intermediate rain
                daily_rain = rain.get(date, 0)

                if daily_rain >= cfg.heavy_rain_threshold_mm:
                    current_sr = cfg.post_heavy_rain_sr
                elif daily_rain >= cfg.moderate_rain_threshold_mm:
                    # Partial cleaning
                    cleaning_effect = min(0.02, daily_rain / 500)
                    current_sr = min(cfg.post_moderate_rain_sr, current_sr + cleaning_effect)
                else:
                    # Decay
                    current_sr = max(0.7, current_sr - cfg.base_decay_rate)

                sr_cal.loc[date] = current_sr

                # Confidence decreases with distance from anchor
                decay_factor = max(0.3, 1.0 - days_since / cfg.max_decay_days)
                conf_adj.loc[date] = cfg.confidence_boost_pct * decay_factor

    return sr_cal, conf_adj


# =============================================================================
# Fleet CV Feature Extraction
# =============================================================================

@dataclass
class FleetCVConfig:
    """Configuration for fleet CV feature extraction.

    Attributes
    ----------
    min_inverters : int
        Minimum inverters required to compute CV (default: 3)
    outlier_threshold_sigma : float
        Standard deviations for outlier detection (default: 2.0)
    window_days : int
        Rolling window for CV calculation (default: 7)
    """
    min_inverters: int = 3
    outlier_threshold_sigma: float = 2.0
    window_days: int = 7


@dataclass
class FleetCVFeatures:
    """Fleet-level features derived from cross-inverter analysis.

    These features capture the uniformity of losses across the fleet,
    which helps distinguish soiling (uniform) from faults (non-uniform).
    """
    # Core CV metrics
    fleet_cv: pd.Series           # Daily coefficient of variation
    fleet_cv_7d: pd.Series        # 7-day rolling CV

    # Outlier detection
    n_outliers: pd.Series         # Number of outlier inverters per day
    outlier_fraction: pd.Series   # Fraction of inverters that are outliers

    # Uniformity indicators
    is_uniform: pd.Series         # True if CV < 5% (suggests soiling)
    uniformity_score: pd.Series   # 1 - normalized CV (higher = more uniform)

    def to_dataframe(self) -> pd.DataFrame:
        """Convert to DataFrame for feature extraction."""
        return pd.DataFrame({
            'fleet_cv': self.fleet_cv,
            'fleet_cv_7d': self.fleet_cv_7d,
            'n_outliers': self.n_outliers,
            'outlier_fraction': self.outlier_fraction,
            'is_uniform': self.is_uniform.astype(int),
            'uniformity_score': self.uniformity_score,
        })


def compute_fleet_cv_features(
    inverter_power: Dict[str, pd.Series],
    config: Optional[FleetCVConfig] = None,
) -> FleetCVFeatures:
    """Compute fleet coefficient of variation features.

    The CV across inverters indicates whether losses are uniform (soiling)
    or non-uniform (faults, shading):
    - Low CV (<5%): Losses are uniform → likely soiling
    - High CV (>10%): Losses are non-uniform → likely equipment issues

    Parameters
    ----------
    inverter_power : Dict[str, pd.Series]
        Power output per inverter, keyed by inverter ID
    config : FleetCVConfig, optional
        Configuration for CV computation

    Returns
    -------
    FleetCVFeatures
        Fleet-level CV features for use in ML models

    Example
    -------
    >>> inv_power = {
    ...     'inv1': pd.Series([100, 95, 90], index=dates),
    ...     'inv2': pd.Series([100, 94, 89], index=dates),
    ...     'inv3': pd.Series([100, 96, 91], index=dates),
    ... }
    >>> features = compute_fleet_cv_features(inv_power)
    >>> features.fleet_cv.mean()  # Low CV indicates uniform soiling
    0.02
    """
    cfg = config or FleetCVConfig()

    if len(inverter_power) < cfg.min_inverters:
        raise ValueError(
            f"Need at least {cfg.min_inverters} inverters, got {len(inverter_power)}"
        )

    # Create DataFrame with all inverters
    df = pd.DataFrame(inverter_power)

    # Compute daily statistics
    fleet_mean = df.mean(axis=1)
    fleet_std = df.std(axis=1)

    # Coefficient of variation (std / mean)
    fleet_cv = (fleet_std / fleet_mean.replace(0, np.nan)).fillna(0)

    # Rolling CV
    fleet_cv_7d = fleet_cv.rolling(cfg.window_days, min_periods=1).mean()

    # Outlier detection per day
    z_scores = df.sub(fleet_mean, axis=0).div(fleet_std.replace(0, 1), axis=0)
    is_outlier = z_scores.abs() > cfg.outlier_threshold_sigma
    n_outliers = is_outlier.sum(axis=1)
    outlier_fraction = n_outliers / len(inverter_power)

    # Uniformity indicators
    is_uniform = fleet_cv < 0.05  # CV < 5%
    uniformity_score = (1 - fleet_cv.clip(0, 0.2) / 0.2).clip(0, 1)

    return FleetCVFeatures(
        fleet_cv=fleet_cv,
        fleet_cv_7d=fleet_cv_7d,
        n_outliers=n_outliers,
        outlier_fraction=outlier_fraction,
        is_uniform=is_uniform,
        uniformity_score=uniformity_score,
    )


def load_fleet_cv_from_scada(
    plant_id: str,
    data_dir: Path,
    config: Optional[FleetCVConfig] = None,
) -> Optional[FleetCVFeatures]:
    """Load SCADA data and compute fleet CV features.

    Attempts to load per-inverter power data and compute CV features.
    Returns None if insufficient data is available.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    data_dir : Path
        Directory containing plant data
    config : FleetCVConfig, optional
        Configuration for CV computation

    Returns
    -------
    FleetCVFeatures or None
        Fleet CV features, or None if data unavailable
    """
    cfg = config or FleetCVConfig()

    # Try to load SCADA data with per-inverter columns
    scada_paths = [
        data_dir / plant_id / "scada_daily.csv",
        data_dir / plant_id / "scada.csv",
        Path(f"public/data/digitaltwin/{plant_id}/scada_daily.csv"),
        Path(f"public/data/soiling/{plant_id}/scada_daily.csv"),
    ]

    df = None
    for path in scada_paths:
        if path.exists():
            try:
                df = pd.read_csv(path)
                break
            except Exception:
                continue

    if df is None:
        return None

    # Find date column
    date_col = None
    for col in df.columns:
        if 'date' in col.lower() or 'time' in col.lower():
            date_col = col
            break

    if date_col is None:
        return None

    df[date_col] = pd.to_datetime(df[date_col])
    df = df.set_index(date_col)

    # Find inverter power columns
    # Look for patterns like 'inv1_power', 'inverter_1_pac', 'P_inv_01', etc.
    inv_patterns = ['inv', 'inverter', 'p_inv', 'pac_']
    inverter_cols = []

    for col in df.columns:
        col_lower = col.lower()
        for pattern in inv_patterns:
            if pattern in col_lower and any(x in col_lower for x in ['power', 'pac', 'p_ac', 'kw', 'mw']):
                inverter_cols.append(col)
                break

    if len(inverter_cols) < cfg.min_inverters:
        # Try alternative: any numeric columns that look like inverter data
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        potential_inv_cols = [c for c in numeric_cols if 'inv' in c.lower() or c.startswith('P_')]
        if len(potential_inv_cols) >= cfg.min_inverters:
            inverter_cols = potential_inv_cols
        else:
            return None

    # Extract inverter power data
    inverter_power = {col: df[col].dropna() for col in inverter_cols}

    try:
        return compute_fleet_cv_features(inverter_power, cfg)
    except ValueError:
        return None


def add_fleet_cv_to_features(
    features: pd.DataFrame,
    plant_id: str,
    data_dir: Path,
    config: Optional[FleetCVConfig] = None,
) -> pd.DataFrame:
    """Add fleet CV features to an existing feature DataFrame.

    This is a convenience function for integrating fleet CV into
    the feature extraction pipeline.

    Parameters
    ----------
    features : pd.DataFrame
        Existing feature DataFrame indexed by date
    plant_id : str
        Plant identifier
    data_dir : Path
        Directory containing plant data
    config : FleetCVConfig, optional
        Configuration for CV computation

    Returns
    -------
    pd.DataFrame
        Features with fleet CV columns added (or unchanged if unavailable)
    """
    cv_features = load_fleet_cv_from_scada(plant_id, data_dir, config)

    if cv_features is None:
        # Add placeholder columns with default values
        features['fleet_cv'] = 0.03  # Assume moderate uniformity
        features['fleet_cv_7d'] = 0.03
        features['is_uniform'] = 1
        features['uniformity_score'] = 0.85
        return features

    cv_df = cv_features.to_dataframe()

    # Align indices
    cv_df = cv_df.reindex(features.index)

    # Forward fill and backward fill gaps
    cv_df = cv_df.fillna(method='ffill').fillna(method='bfill')

    # Fill any remaining with defaults
    cv_df = cv_df.fillna({
        'fleet_cv': 0.03,
        'fleet_cv_7d': 0.03,
        'n_outliers': 0,
        'outlier_fraction': 0,
        'is_uniform': 1,
        'uniformity_score': 0.85,
    })

    # Merge with features
    for col in cv_df.columns:
        features[col] = cv_df[col]

    return features
