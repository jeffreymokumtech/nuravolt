"""
Physics-Based Validation for Soiling Ratio Predictions

Validates SR predictions against physical constraints and expected behaviors:
1. Range constraints: SR must be in [0.75, 1.0]
2. Rain reset behavior: SR should increase after heavy rain
3. Monotonic decay: SR should decrease between rain events
4. Fleet consistency: Spatial uniformity across inverters
5. Seasonal patterns: Summer vs winter soiling rates

Author: NuraVolt Team
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass


@dataclass
class PhysicsValidationResults:
    """Results from physics-based validation."""

    # Range checks
    total_predictions: int
    range_violations: int
    range_violation_rate: float

    # Rain reset checks
    heavy_rain_events: int
    correct_rain_resets: int
    rain_reset_accuracy: float

    # Decay checks
    decay_periods: int
    decay_violations: int
    decay_plausibility: float

    # Fleet consistency
    mean_fleet_std: float
    uniformity_score: float

    # Seasonal patterns
    summer_mean_sr: float
    winter_mean_sr: float
    seasonal_ratio: float

    # Overall
    overall_pass_rate: float
    is_physically_plausible: bool

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            'range_checks': {
                'total': self.total_predictions,
                'violations': self.range_violations,
                'violation_rate': self.range_violation_rate,
                'pass': self.range_violation_rate < 0.01
            },
            'rain_reset': {
                'events': self.heavy_rain_events,
                'correct': self.correct_rain_resets,
                'accuracy': self.rain_reset_accuracy,
                'pass': self.rain_reset_accuracy > 0.95
            },
            'decay_plausibility': {
                'periods': self.decay_periods,
                'violations': self.decay_violations,
                'plausibility': self.decay_plausibility,
                'pass': self.decay_plausibility > 0.95
            },
            'fleet_uniformity': {
                'mean_std': self.mean_fleet_std,
                'uniformity_score': self.uniformity_score,
                'pass': self.uniformity_score > 0.9
            },
            'seasonal_patterns': {
                'summer_sr': self.summer_mean_sr,
                'winter_sr': self.winter_mean_sr,
                'ratio': self.seasonal_ratio,
                'pass': self.summer_mean_sr < self.winter_mean_sr
            },
            'overall': {
                'pass_rate': self.overall_pass_rate,
                'is_plausible': self.is_physically_plausible
            }
        }


def validate_sr_range(
    sr_predictions: pd.Series,
    sr_min: float = 0.75,
    sr_max: float = 1.0
) -> Tuple[int, float]:
    """
    Validate that SR predictions are within physical bounds.

    Parameters
    ----------
    sr_predictions : pd.Series
        Soiling ratio predictions
    sr_min : float
        Minimum valid SR
    sr_max : float
        Maximum valid SR

    Returns
    -------
    violations : int
        Number of out-of-range predictions
    violation_rate : float
        Fraction of violations (0-1)
    """
    violations = int(((sr_predictions < sr_min) | (sr_predictions > sr_max)).sum())
    violation_rate = violations / len(sr_predictions) if len(sr_predictions) > 0 else 0.0

    return violations, violation_rate


def validate_rain_resets(
    sr_predictions: pd.Series,
    rain_data: pd.DataFrame,
    heavy_rain_threshold_mm: float = 10.0,
    reset_threshold_sr: float = 0.99,
    check_window_days: int = 2,
    check_window_start: int = 0
) -> Tuple[int, int, float]:
    """
    Validate that SR resets correctly after heavy rain events.

    Parameters
    ----------
    sr_predictions : pd.Series
        Soiling ratio predictions (indexed by date)
    rain_data : pd.DataFrame
        Rain data with 'precipitation_mm' column (indexed by date)
    heavy_rain_threshold_mm : float
        Threshold for heavy rain cleaning
    reset_threshold_sr : float
        Expected SR after rain
    check_window_days : int
        Days after rain to check (from start)
    check_window_start : int
        Days to skip after rain before checking (default 0)

    Returns
    -------
    events : int
        Number of heavy rain events
    correct_resets : int
        Number of correct SR resets
    accuracy : float
        Reset accuracy (0-1)
    """
    # Ensure date indices
    if 'date' in rain_data.columns:
        rain_data = rain_data.set_index('date')
    rain_data.index = pd.to_datetime(rain_data.index)
    sr_predictions.index = pd.to_datetime(sr_predictions.index)

    # Find heavy rain events
    if 'precipitation_mm' not in rain_data.columns:
        return 0, 0, 0.0

    heavy_rain_dates = rain_data[
        rain_data['precipitation_mm'] >= heavy_rain_threshold_mm
    ].index

    if len(heavy_rain_dates) == 0:
        return 0, 0, 0.0

    # Check SR after each event
    correct_resets = 0
    for rain_date in heavy_rain_dates:
        # Get SR in window after rain (with optional delay)
        start_date = rain_date + pd.Timedelta(days=check_window_start)
        end_date = rain_date + pd.Timedelta(days=check_window_days)
        sr_after = sr_predictions.loc[
            (sr_predictions.index >= start_date) &
            (sr_predictions.index <= end_date)
        ]

        if len(sr_after) > 0:
            # SR should be high after rain
            if sr_after.mean() >= reset_threshold_sr:
                correct_resets += 1

    accuracy = correct_resets / len(heavy_rain_dates)

    return len(heavy_rain_dates), correct_resets, accuracy


def validate_monotonic_decay(
    sr_predictions: pd.Series,
    rain_data: pd.DataFrame,
    rain_threshold_mm: float = 5.0
) -> Tuple[int, int, float]:
    """
    Validate that SR decays monotonically between rain events.

    Parameters
    ----------
    sr_predictions : pd.Series
        Soiling ratio predictions (indexed by date)
    rain_data : pd.DataFrame
        Rain data with 'precipitation_mm' column
    rain_threshold_mm : float
        Threshold to consider a cleaning event

    Returns
    -------
    periods : int
        Number of decay periods checked
    violations : int
        Number of periods with non-monotonic decay
    plausibility : float
        Fraction of periods with valid decay (0-1)
    """
    # Ensure indices
    if 'date' in rain_data.columns:
        rain_data = rain_data.set_index('date')
    rain_data.index = pd.to_datetime(rain_data.index)
    sr_predictions.index = pd.to_datetime(sr_predictions.index)

    if 'precipitation_mm' not in rain_data.columns:
        return 0, 0, 1.0

    # Identify rain events
    rain_dates = rain_data[rain_data['precipitation_mm'] >= rain_threshold_mm].index
    rain_dates = sorted(rain_dates)

    if len(rain_dates) < 2:
        return 0, 0, 1.0

    # Check decay between consecutive rain events
    violations = 0
    periods = 0

    for i in range(len(rain_dates) - 1):
        start_date = rain_dates[i]
        end_date = rain_dates[i + 1]

        # Get SR in this period
        sr_period = sr_predictions.loc[
            (sr_predictions.index > start_date) &
            (sr_predictions.index < end_date)
        ]

        if len(sr_period) >= 3:
            periods += 1

            # Check for monotonic decay (SR should generally decrease)
            # Allow small increases (<0.005) due to noise
            diff = sr_period.diff()
            large_increases = (diff > 0.005).sum()

            # If more than 30% of changes are large increases, flag as violation
            if large_increases / len(diff) > 0.3:
                violations += 1

    plausibility = 1 - (violations / periods) if periods > 0 else 1.0

    return periods, violations, plausibility


def validate_fleet_consistency(
    per_inverter_sr: Dict[str, pd.Series],
    max_acceptable_std: float = 0.02
) -> Tuple[float, float]:
    """
    Validate spatial uniformity across inverter fleet.

    Parameters
    ----------
    per_inverter_sr : dict
        {inverter_id: SR time series}
    max_acceptable_std : float
        Maximum acceptable daily standard deviation

    Returns
    -------
    mean_fleet_std : float
        Average daily standard deviation across fleet
    uniformity_score : float
        Uniformity score (0-1, higher is better)
    """
    # Align all series to common dates
    all_dates = None
    for inv_id, sr_series in per_inverter_sr.items():
        if all_dates is None:
            all_dates = sr_series.index
        else:
            all_dates = all_dates.intersection(sr_series.index)

    if all_dates is None or len(all_dates) == 0:
        return 0.0, 1.0

    # Create dataframe with aligned data
    fleet_df = pd.DataFrame({
        inv_id: sr_series.reindex(all_dates)
        for inv_id, sr_series in per_inverter_sr.items()
    })

    # Calculate daily standard deviation across fleet
    daily_stds = fleet_df.std(axis=1)
    mean_fleet_std = float(daily_stds.mean())

    # Uniformity score: 1 - (actual_std / max_acceptable_std)
    # Score of 1.0 = perfect uniformity
    # Score of 0.0 = std at or above threshold
    uniformity_score = max(0, 1 - (mean_fleet_std / max_acceptable_std))

    return mean_fleet_std, uniformity_score


def validate_seasonal_patterns(
    sr_predictions: pd.Series
) -> Tuple[float, float, float]:
    """
    Validate that seasonal patterns are physically plausible.

    Summer (Jun-Aug) should generally have lower SR than winter (Dec-Feb)
    due to more dust accumulation.

    Parameters
    ----------
    sr_predictions : pd.Series
        Soiling ratio predictions (indexed by date)

    Returns
    -------
    summer_mean : float
        Mean SR in summer
    winter_mean : float
        Mean SR in winter
    ratio : float
        Summer/Winter ratio (should be < 1.0)
    """
    # Ensure datetime index
    sr_predictions.index = pd.to_datetime(sr_predictions.index)

    # Extract month
    months = sr_predictions.index.month

    # Summer: June, July, August
    summer_mask = months.isin([6, 7, 8])
    summer_sr = sr_predictions[summer_mask]
    summer_mean = float(summer_sr.mean()) if len(summer_sr) > 0 else 1.0

    # Winter: December, January, February
    winter_mask = months.isin([12, 1, 2])
    winter_sr = sr_predictions[winter_mask]
    winter_mean = float(winter_sr.mean()) if len(winter_sr) > 0 else 1.0

    # Ratio (should be < 1.0 for physically plausible)
    ratio = summer_mean / winter_mean if winter_mean > 0 else 1.0

    return summer_mean, winter_mean, ratio


def comprehensive_physics_validation(
    sr_predictions: pd.Series,
    rain_data: Optional[pd.DataFrame] = None,
    per_inverter_sr: Optional[Dict[str, pd.Series]] = None,
    sr_min: float = 0.75,
    sr_max: float = 1.0
) -> PhysicsValidationResults:
    """
    Run comprehensive physics-based validation.

    Parameters
    ----------
    sr_predictions : pd.Series
        Soiling ratio predictions (plant-level or single inverter)
    rain_data : pd.DataFrame, optional
        Rain data for rain reset validation
    per_inverter_sr : dict, optional
        Per-inverter SR for fleet consistency
    sr_min, sr_max : float
        Valid SR range

    Returns
    -------
    PhysicsValidationResults
        Complete validation results
    """
    # Range validation
    range_viol, range_viol_rate = validate_sr_range(sr_predictions, sr_min, sr_max)

    # Rain reset validation
    if rain_data is not None:
        rain_events, correct_resets, reset_acc = validate_rain_resets(
            sr_predictions, rain_data
        )
    else:
        rain_events, correct_resets, reset_acc = 0, 0, 1.0

    # Decay validation
    if rain_data is not None:
        decay_periods, decay_viol, decay_plaus = validate_monotonic_decay(
            sr_predictions, rain_data
        )
    else:
        decay_periods, decay_viol, decay_plaus = 0, 0, 1.0

    # Fleet consistency
    if per_inverter_sr is not None and len(per_inverter_sr) > 1:
        mean_std, uniformity = validate_fleet_consistency(per_inverter_sr)
    else:
        mean_std, uniformity = 0.01, 1.0

    # Seasonal patterns
    summer_sr, winter_sr, seasonal_ratio = validate_seasonal_patterns(sr_predictions)

    # Calculate overall pass rate
    checks = []

    # Range check (target: <1% violations)
    checks.append(1.0 if range_viol_rate < 0.01 else 0.0)

    # Rain reset check (target: >95% accuracy)
    if rain_events > 0:
        checks.append(1.0 if reset_acc > 0.95 else 0.0)

    # Decay check (target: >95% plausible)
    if decay_periods > 0:
        checks.append(1.0 if decay_plaus > 0.95 else 0.0)

    # Fleet uniformity (target: score >0.9)
    if per_inverter_sr is not None:
        checks.append(1.0 if uniformity > 0.9 else 0.0)

    # Seasonal pattern (target: summer < winter)
    checks.append(1.0 if summer_sr < winter_sr else 0.0)

    overall_pass_rate = sum(checks) / len(checks) if checks else 1.0
    is_plausible = overall_pass_rate >= 0.9

    return PhysicsValidationResults(
        total_predictions=len(sr_predictions),
        range_violations=range_viol,
        range_violation_rate=range_viol_rate,
        heavy_rain_events=rain_events,
        correct_rain_resets=correct_resets,
        rain_reset_accuracy=reset_acc,
        decay_periods=decay_periods,
        decay_violations=decay_viol,
        decay_plausibility=decay_plaus,
        mean_fleet_std=mean_std,
        uniformity_score=uniformity,
        summer_mean_sr=summer_sr,
        winter_mean_sr=winter_sr,
        seasonal_ratio=seasonal_ratio,
        overall_pass_rate=overall_pass_rate,
        is_physically_plausible=is_plausible
    )
