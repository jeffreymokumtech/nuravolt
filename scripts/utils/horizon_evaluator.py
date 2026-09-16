"""
Horizon-specific evaluation metrics for forecast models.

Provides functions for evaluating forecast performance at different time horizons,
including physics validation and confidence interval coverage.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Optional
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score


def evaluate_horizon(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    horizon: int,
    confidence_levels: List[float] = [0.90, 0.95]
) -> Dict[str, float]:
    """
    Evaluate forecast performance for a specific horizon.

    Metrics:
    - MAE, RMSE, R², MAPE
    - Directional accuracy (% correct trend predictions)
    - Coverage rates for prediction intervals

    Args:
        y_true: Actual values
        y_pred: Predicted values
        horizon: Forecast horizon in days
        confidence_levels: Confidence levels for coverage rates

    Returns:
        Dictionary with performance metrics
    """
    # Basic metrics
    mae = mean_absolute_error(y_true, y_pred)
    rmse = np.sqrt(mean_squared_error(y_true, y_pred))
    r2 = r2_score(y_true, y_pred)

    # MAPE (handle zeros)
    mape = np.mean(np.abs((y_true - y_pred) / np.maximum(y_true, 0.01))) * 100

    # Bias
    bias = np.mean(y_pred - y_true)

    # Directional accuracy (for consecutive predictions)
    if len(y_true) > 1:
        true_direction = np.sign(np.diff(y_true))
        pred_direction = np.sign(np.diff(y_pred))
        directional_accuracy = np.mean(true_direction == pred_direction) * 100
    else:
        directional_accuracy = np.nan

    # Coverage rates (estimate prediction intervals from residuals)
    residuals = y_pred - y_true
    std_residuals = np.std(residuals)

    coverage_rates = {}
    for conf_level in confidence_levels:
        # Z-score for confidence level
        z_score = {0.90: 1.645, 0.95: 1.96, 0.99: 2.576}.get(conf_level, 1.96)

        # Prediction interval
        lower_bound = y_pred - z_score * std_residuals
        upper_bound = y_pred + z_score * std_residuals

        # Coverage (% of actuals within interval)
        within_interval = (y_true >= lower_bound) & (y_true <= upper_bound)
        coverage = np.mean(within_interval) * 100

        coverage_rates[f'coverage_{int(conf_level*100)}'] = coverage

    metrics = {
        'horizon_days': horizon,
        'mae': mae,
        'mae_pct': mae * 100,
        'rmse': rmse,
        'r2': r2,
        'mape': mape,
        'bias': bias,
        'bias_pct': bias * 100,
        'directional_accuracy_pct': directional_accuracy,
        **coverage_rates,
        'n_samples': len(y_true)
    }

    return metrics


def evaluate_physics_constraints(
    y_pred: np.ndarray,
    dates: Optional[pd.Series] = None,
    rain_events: Optional[np.ndarray] = None,
    sr_min: float = 0.75,
    sr_max: float = 1.0
) -> Dict[str, float]:
    """
    Evaluate physics-based constraints on predictions.

    Checks:
    - Range validity (sr_min <= SR <= sr_max)
    - Rain reset behavior (SR should increase after rain)
    - Monotonic decay between rain events

    Args:
        y_pred: Predicted SR values
        dates: Date series (for rain reset timing)
        rain_events: Boolean array indicating rain days
        sr_min: Minimum valid SR (default 0.75)
        sr_max: Maximum valid SR (default 1.0)

    Returns:
        Dictionary with physics validation metrics
    """
    validation = {}

    # Range check
    in_range = (y_pred >= sr_min) & (y_pred <= sr_max)
    validation['range_valid_pct'] = np.mean(in_range) * 100
    validation['below_min_pct'] = np.mean(y_pred < sr_min) * 100
    validation['above_max_pct'] = np.mean(y_pred > sr_max) * 100

    # Rain reset check
    if rain_events is not None and len(y_pred) > 1:
        # Find rain events
        rain_indices = np.where(rain_events)[0]

        reset_improvements = []
        for rain_idx in rain_indices:
            if rain_idx > 0 and rain_idx < len(y_pred) - 1:
                # Check if SR increased after rain
                sr_before = y_pred[rain_idx - 1]
                sr_after = y_pred[rain_idx + 1]
                if sr_after > sr_before:
                    reset_improvements.append(sr_after - sr_before)

        if reset_improvements:
            validation['rain_reset_success_pct'] = (len(reset_improvements) / len(rain_indices)) * 100
            validation['avg_rain_reset_improvement'] = np.mean(reset_improvements)
        else:
            validation['rain_reset_success_pct'] = 0.0
            validation['avg_rain_reset_improvement'] = 0.0

    # Monotonic decay check (between rain events)
    if rain_events is not None and len(y_pred) > 2:
        # Split into periods between rain
        rain_indices = np.where(rain_events)[0]

        if len(rain_indices) > 0:
            periods = []
            start = 0
            for rain_idx in rain_indices:
                if rain_idx > start:
                    periods.append((start, rain_idx))
                start = rain_idx + 1
            if start < len(y_pred):
                periods.append((start, len(y_pred)))

            # Check monotonic decay in each period
            monotonic_periods = []
            for start, end in periods:
                if end - start > 2:  # Need at least 3 points
                    period_values = y_pred[start:end]
                    # Check if generally decreasing (allow small increases)
                    diffs = np.diff(period_values)
                    decreasing_pct = np.mean(diffs <= 0.001) * 100
                    monotonic_periods.append(decreasing_pct)

            if monotonic_periods:
                validation['monotonic_decay_pct'] = np.mean(monotonic_periods)
            else:
                validation['monotonic_decay_pct'] = np.nan
        else:
            validation['monotonic_decay_pct'] = np.nan

    return validation


def aggregate_horizon_results(
    horizon_results: Dict[int, Dict[str, float]],
    group_by: Optional[str] = None
) -> pd.DataFrame:
    """
    Aggregate results across horizons into summary DataFrame.

    Args:
        horizon_results: Dictionary mapping horizon -> metrics
        group_by: Optional grouping dimension (e.g., 'season', 'month')

    Returns:
        DataFrame with aggregated metrics
    """
    rows = []
    for horizon, metrics in horizon_results.items():
        row = {'horizon_days': horizon}
        row.update(metrics)
        if group_by:
            row['group'] = metrics.get(group_by, 'all')
        rows.append(row)

    df = pd.DataFrame(rows)
    return df


def calculate_seasonal_performance(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    dates: pd.Series,
    horizon: int
) -> Dict[str, Dict[str, float]]:
    """
    Calculate performance metrics broken down by season.

    Args:
        y_true: Actual values
        y_pred: Predicted values
        dates: Date series
        horizon: Forecast horizon in days

    Returns:
        Dictionary mapping season -> metrics
    """
    # Assign seasons
    dates = pd.to_datetime(dates)
    month = dates.dt.month

    seasons = pd.cut(
        month,
        bins=[0, 3, 6, 9, 12],
        labels=['Winter', 'Spring', 'Summer', 'Fall'],
        include_lowest=True
    )

    seasonal_results = {}
    for season in seasons.unique():
        if pd.notna(season):
            mask = (seasons == season)
            if np.sum(mask) > 0:
                metrics = evaluate_horizon(
                    y_true[mask],
                    y_pred[mask],
                    horizon
                )
                seasonal_results[season] = metrics

    return seasonal_results


def calculate_error_distribution_stats(
    y_true: np.ndarray,
    y_pred: np.ndarray
) -> Dict[str, float]:
    """
    Calculate detailed error distribution statistics.

    Args:
        y_true: Actual values
        y_pred: Predicted values

    Returns:
        Dictionary with error distribution stats
    """
    errors = y_pred - y_true
    abs_errors = np.abs(errors)

    stats = {
        'error_mean': np.mean(errors),
        'error_std': np.std(errors),
        'error_median': np.median(errors),
        'error_q25': np.percentile(errors, 25),
        'error_q75': np.percentile(errors, 75),
        'abs_error_mean': np.mean(abs_errors),
        'abs_error_median': np.median(abs_errors),
        'abs_error_q90': np.percentile(abs_errors, 90),
        'abs_error_q95': np.percentile(abs_errors, 95),
        'abs_error_max': np.max(abs_errors),
        'overestimate_pct': np.mean(errors > 0) * 100,
        'underestimate_pct': np.mean(errors < 0) * 100
    }

    return stats
