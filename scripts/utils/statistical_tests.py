"""
Statistical tests for comparing forecast models.

Provides functions for rigorous statistical comparison of forecast accuracy
including paired tests and effect size measures.
"""

import numpy as np
import pandas as pd
from typing import Dict, Tuple
from scipy import stats


def paired_t_test(
    errors1: np.ndarray,
    errors2: np.ndarray,
    alternative: str = 'two-sided'
) -> Dict[str, float]:
    """
    Perform paired t-test on forecast errors.

    Tests whether two models have significantly different error distributions.

    Args:
        errors1: Absolute errors from model 1
        errors2: Absolute errors from model 2
        alternative: 'two-sided', 'less', or 'greater'

    Returns:
        Dictionary with test results
    """
    t_stat, p_value = stats.ttest_rel(errors1, errors2, alternative=alternative)

    return {
        't_statistic': t_stat,
        'p_value': p_value,
        'significant': p_value < 0.05,
        'mean_diff': np.mean(errors1 - errors2)
    }


def wilcoxon_test(
    errors1: np.ndarray,
    errors2: np.ndarray,
    alternative: str = 'two-sided'
) -> Dict[str, float]:
    """
    Perform Wilcoxon signed-rank test on forecast errors.

    Non-parametric alternative to paired t-test that doesn't assume normality.

    Args:
        errors1: Absolute errors from model 1
        errors2: Absolute errors from model 2
        alternative: 'two-sided', 'less', or 'greater'

    Returns:
        Dictionary with test results
    """
    # Remove pairs where both values are equal
    diff = errors1 - errors2
    mask = diff != 0
    diff = diff[mask]

    if len(diff) > 0:
        w_stat, p_value = stats.wilcoxon(diff, alternative=alternative)
        return {
            'statistic': w_stat,
            'p_value': p_value,
            'significant': p_value < 0.05,
            'median_diff': np.median(diff)
        }
    else:
        return {
            'statistic': np.nan,
            'p_value': 1.0,
            'significant': False,
            'median_diff': 0.0
        }


def cohens_d(
    errors1: np.ndarray,
    errors2: np.ndarray
) -> float:
    """
    Calculate Cohen's d effect size.

    Measures the standardized difference between two means.

    Interpretation:
    - |d| < 0.2: Small effect
    - 0.2 <= |d| < 0.5: Small to medium effect
    - 0.5 <= |d| < 0.8: Medium to large effect
    - |d| >= 0.8: Large effect

    Args:
        errors1: Absolute errors from model 1
        errors2: Absolute errors from model 2

    Returns:
        Cohen's d effect size
    """
    mean_diff = np.mean(errors1) - np.mean(errors2)
    pooled_std = np.sqrt((np.std(errors1, ddof=1)**2 + np.std(errors2, ddof=1)**2) / 2)

    if pooled_std > 0:
        return mean_diff / pooled_std
    else:
        return 0.0


def diebold_mariano_test(
    errors1: np.ndarray,
    errors2: np.ndarray,
    horizon: int = 1
) -> Dict[str, float]:
    """
    Perform Diebold-Mariano test for forecast accuracy.

    Tests whether two forecasts have equal predictive accuracy.

    Args:
        errors1: Forecast errors from model 1
        errors2: Forecast errors from model 2
        horizon: Forecast horizon (for autocorrelation adjustment)

    Returns:
        Dictionary with test results
    """
    # Calculate loss differential
    d = errors1**2 - errors2**2
    d_mean = np.mean(d)

    # Estimate variance with HAC correction
    n = len(d)
    d_var = np.var(d, ddof=1) / n

    # Adjust for autocorrelation at forecast horizon
    if horizon > 1:
        gamma_sum = 0
        for k in range(1, horizon):
            if k < n:
                gamma_k = np.sum((d[k:] - d_mean) * (d[:-k] - d_mean)) / n
                gamma_sum += gamma_k
        d_var += 2 * gamma_sum / n

    # Calculate DM statistic
    if d_var > 0:
        dm_stat = d_mean / np.sqrt(d_var)
        # Two-tailed test
        p_value = 2 * (1 - stats.norm.cdf(np.abs(dm_stat)))
    else:
        dm_stat = 0.0
        p_value = 1.0

    return {
        'dm_statistic': dm_stat,
        'p_value': p_value,
        'significant': p_value < 0.05,
        'mean_loss_diff': d_mean
    }


def compare_models(
    y_true: np.ndarray,
    y_pred1: np.ndarray,
    y_pred2: np.ndarray,
    model1_name: str = 'Model 1',
    model2_name: str = 'Model 2',
    horizon: int = 1
) -> Dict[str, any]:
    """
    Comprehensive statistical comparison of two models.

    Performs multiple tests and calculates effect sizes to determine
    if models have significantly different performance.

    Args:
        y_true: Actual values
        y_pred1: Predictions from model 1
        y_pred2: Predictions from model 2
        model1_name: Name of model 1
        model2_name: Name of model 2
        horizon: Forecast horizon for DM test

    Returns:
        Dictionary with comprehensive comparison results
    """
    # Calculate errors
    errors1 = np.abs(y_pred1 - y_true)
    errors2 = np.abs(y_pred2 - y_true)

    # Basic metrics
    mae1 = np.mean(errors1)
    mae2 = np.mean(errors2)

    # Determine winner
    winner = model1_name if mae1 < mae2 else model2_name
    improvement_pct = abs((mae2 - mae1) / mae1) * 100

    # Statistical tests
    t_test = paired_t_test(errors1, errors2)
    wilcoxon = wilcoxon_test(errors1, errors2)
    effect_size = cohens_d(errors1, errors2)

    # DM test (use squared errors)
    dm_test = diebold_mariano_test(y_pred1 - y_true, y_pred2 - y_true, horizon)

    # Interpret effect size
    effect_interpretation = 'negligible'
    abs_effect = abs(effect_size)
    if abs_effect >= 0.8:
        effect_interpretation = 'large'
    elif abs_effect >= 0.5:
        effect_interpretation = 'medium to large'
    elif abs_effect >= 0.2:
        effect_interpretation = 'small to medium'
    elif abs_effect > 0:
        effect_interpretation = 'small'

    results = {
        'model1': model1_name,
        'model2': model2_name,
        'model1_mae': mae1,
        'model2_mae': mae2,
        'winner': winner,
        'improvement_pct': improvement_pct,
        'cohens_d': effect_size,
        'effect_interpretation': effect_interpretation,
        'paired_t_test': t_test,
        'wilcoxon_test': wilcoxon,
        'diebold_mariano_test': dm_test,
        'consensus': {
            't_test_significant': t_test['significant'],
            'wilcoxon_significant': wilcoxon['significant'],
            'dm_test_significant': dm_test['significant'],
            'tests_agree': (t_test['significant'] == wilcoxon['significant'] == dm_test['significant'])
        }
    }

    return results


def test_summary_string(comparison: Dict[str, any]) -> str:
    """
    Generate human-readable summary of comparison results.

    Args:
        comparison: Results from compare_models()

    Returns:
        Formatted summary string
    """
    winner = comparison['winner']
    improvement = comparison['improvement_pct']
    effect = comparison['effect_interpretation']
    mae1 = comparison['model1_mae']
    mae2 = comparison['model2_mae']

    summary = f"""
Model Comparison: {comparison['model1']} vs {comparison['model2']}

Performance:
  {comparison['model1']}: MAE = {mae1:.4f} ({mae1*100:.2f}%)
  {comparison['model2']}: MAE = {mae2:.4f} ({mae2*100:.2f}%)
  Winner: {winner} (improvement: {improvement:.1f}%)

Effect Size:
  Cohen's d = {comparison['cohens_d']:.3f} ({effect} effect)

Statistical Tests:
  Paired t-test: p = {comparison['paired_t_test']['p_value']:.4f} {'✓ Significant' if comparison['paired_t_test']['significant'] else '✗ Not significant'}
  Wilcoxon test: p = {comparison['wilcoxon_test']['p_value']:.4f} {'✓ Significant' if comparison['wilcoxon_test']['significant'] else '✗ Not significant'}
  Diebold-Mariano: p = {comparison['diebold_mariano_test']['p_value']:.4f} {'✓ Significant' if comparison['diebold_mariano_test']['significant'] else '✗ Not significant'}

Conclusion:
  Tests agree: {comparison['consensus']['tests_agree']}
  Difference is {'statistically significant' if comparison['consensus']['tests_agree'] and comparison['paired_t_test']['significant'] else 'not statistically significant'}
"""

    return summary


def bootstrap_confidence_interval(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    metric_func=lambda y_true, y_pred: np.mean(np.abs(y_true - y_pred)),
    n_bootstrap: int = 1000,
    confidence_level: float = 0.95
) -> Tuple[float, float, float]:
    """
    Calculate bootstrap confidence interval for a metric.

    Args:
        y_true: Actual values
        y_pred: Predicted values
        metric_func: Function to calculate metric (default: MAE)
        n_bootstrap: Number of bootstrap samples
        confidence_level: Confidence level (default 0.95)

    Returns:
        Tuple of (metric_value, lower_bound, upper_bound)
    """
    n = len(y_true)
    bootstrap_metrics = []

    for _ in range(n_bootstrap):
        # Resample with replacement
        indices = np.random.choice(n, size=n, replace=True)
        y_true_sample = y_true[indices]
        y_pred_sample = y_pred[indices]

        # Calculate metric
        metric = metric_func(y_true_sample, y_pred_sample)
        bootstrap_metrics.append(metric)

    # Calculate percentiles
    alpha = 1 - confidence_level
    lower_percentile = (alpha / 2) * 100
    upper_percentile = (1 - alpha / 2) * 100

    metric_value = metric_func(y_true, y_pred)
    lower_bound = np.percentile(bootstrap_metrics, lower_percentile)
    upper_bound = np.percentile(bootstrap_metrics, upper_percentile)

    return metric_value, lower_bound, upper_bound
