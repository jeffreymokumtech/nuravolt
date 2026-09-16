"""
Visualization utilities for forecast backtesting results.

Provides functions for generating publication-quality plots for demo presentations.
"""

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import warnings
warnings.filterwarnings('ignore')

# Set publication-quality style
sns.set_style("whitegrid")
plt.rcParams['figure.dpi'] = 300
plt.rcParams['savefig.dpi'] = 300
plt.rcParams['font.size'] = 10
plt.rcParams['axes.labelsize'] = 11
plt.rcParams['axes.titlesize'] = 12
plt.rcParams['xtick.labelsize'] = 9
plt.rcParams['ytick.labelsize'] = 9
plt.rcParams['legend.fontsize'] = 9

# Color palette
COLORS = {
    'primary': '#2E86AB',
    'secondary': '#A23B72',
    'success': '#06A77D',
    'warning': '#F18F01',
    'danger': '#C73E1D',
    'info': '#6A4C93'
}


def plot_horizon_comparison(
    horizon_results: Dict[int, Dict[str, float]],
    output_path: Path,
    metrics: List[str] = ['mae_pct', 'rmse', 'r2']
) -> None:
    """
    Plot performance degradation across forecast horizons.

    Creates line plots showing how accuracy degrades with forecast horizon.

    Args:
        horizon_results: Dictionary mapping horizon -> metrics
        output_path: Path to save plot
        metrics: List of metrics to plot
    """
    # Extract data
    horizons = sorted(horizon_results.keys())
    data = {metric: [horizon_results[h].get(metric, np.nan) for h in horizons] for metric in metrics}

    # Create figure with subplots
    fig, axes = plt.subplots(1, len(metrics), figsize=(15, 4))
    if len(metrics) == 1:
        axes = [axes]

    for ax, metric in zip(axes, metrics):
        values = data[metric]

        # Plot line with markers
        ax.plot(horizons, values, marker='o', linewidth=2, markersize=8,
                color=COLORS['primary'], label=metric.upper())

        # Add trend line
        z = np.polyfit(horizons, values, 2)
        p = np.poly1d(z)
        x_smooth = np.linspace(min(horizons), max(horizons), 100)
        ax.plot(x_smooth, p(x_smooth), '--', color=COLORS['secondary'],
                alpha=0.5, linewidth=1.5, label='Trend')

        # Formatting
        ax.set_xlabel('Forecast Horizon (days)', fontweight='bold')
        ax.set_ylabel(metric.upper().replace('_', ' '), fontweight='bold')
        ax.set_title(f'{metric.upper()} vs Horizon', fontweight='bold', pad=10)
        ax.grid(True, alpha=0.3)
        ax.legend()

        # Add value labels
        for h, v in zip(horizons, values):
            if not np.isnan(v):
                ax.annotate(f'{v:.2f}', (h, v), textcoords='offset points',
                           xytext=(0, 8), ha='center', fontsize=8)

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"✅ Saved horizon comparison: {output_path}")


def plot_time_series_overlay(
    dates: pd.Series,
    y_true: np.ndarray,
    y_pred: np.ndarray,
    output_path: Path,
    horizon: int = 7,
    sample_days: int = 90,
    title: Optional[str] = None
) -> None:
    """
    Plot time series overlay showing actual vs predicted values.

    Args:
        dates: Date series
        y_true: Actual values
        y_pred: Predicted values
        output_path: Path to save plot
        horizon: Forecast horizon (for title)
        sample_days: Number of days to plot (default 90)
        title: Optional custom title
    """
    # Sample data (take first sample_days)
    n = min(sample_days, len(dates))
    dates_sample = dates[:n]
    y_true_sample = y_true[:n]
    y_pred_sample = y_pred[:n]

    # Calculate errors
    errors = y_pred_sample - y_true_sample

    # Create figure with two subplots
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), height_ratios=[2, 1])

    # Plot 1: Time series overlay
    ax1.plot(dates_sample, y_true_sample, label='Actual SR', color=COLORS['primary'],
             linewidth=2, marker='o', markersize=4, alpha=0.8)
    ax1.plot(dates_sample, y_pred_sample, label=f'Predicted SR ({horizon}d horizon)',
             color=COLORS['secondary'], linewidth=2, marker='s', markersize=4, alpha=0.8)

    # Fill area between
    ax1.fill_between(dates_sample, y_true_sample, y_pred_sample,
                     alpha=0.2, color=COLORS['warning'])

    ax1.set_ylabel('Soiling Ratio', fontweight='bold')
    ax1.set_title(title or f'Forecast Tracking ({horizon}-Day Horizon)', fontweight='bold', pad=10)
    ax1.legend(loc='best')
    ax1.grid(True, alpha=0.3)
    ax1.set_ylim([0.92, 1.01])

    # Plot 2: Prediction errors
    ax2.bar(dates_sample, errors, color=COLORS['info'], alpha=0.6, width=0.8)
    ax2.axhline(y=0, color='black', linestyle='-', linewidth=0.5)
    ax2.axhline(y=0.01, color='red', linestyle='--', linewidth=1, alpha=0.5, label='±1% threshold')
    ax2.axhline(y=-0.01, color='red', linestyle='--', linewidth=1, alpha=0.5)

    ax2.set_xlabel('Date', fontweight='bold')
    ax2.set_ylabel('Prediction Error', fontweight='bold')
    ax2.set_title('Prediction Errors Over Time', fontweight='bold', pad=10)
    ax2.legend()
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"✅ Saved time series overlay: {output_path}")


def plot_error_distribution(
    horizon_results: Dict[int, Tuple[np.ndarray, np.ndarray]],
    output_path: Path,
    title: str = 'Error Distribution by Horizon'
) -> None:
    """
    Plot error distribution histograms for each horizon.

    Args:
        horizon_results: Dictionary mapping horizon -> (y_true, y_pred)
        output_path: Path to save plot
        title: Plot title
    """
    horizons = sorted(horizon_results.keys())
    n_horizons = len(horizons)

    # Create subplots
    fig, axes = plt.subplots(2, 3, figsize=(15, 10))
    axes = axes.flatten()

    for idx, horizon in enumerate(horizons[:6]):  # Max 6 horizons
        y_true, y_pred = horizon_results[horizon]
        errors = (y_pred - y_true) * 100  # Convert to percentage

        ax = axes[idx]

        # Histogram
        ax.hist(errors, bins=30, color=COLORS['primary'], alpha=0.6, edgecolor='black')

        # Add vertical lines for mean and median
        mean_error = np.mean(errors)
        median_error = np.median(errors)

        ax.axvline(mean_error, color=COLORS['danger'], linestyle='--', linewidth=2,
                   label=f'Mean: {mean_error:.2f}%')
        ax.axvline(median_error, color=COLORS['success'], linestyle='--', linewidth=2,
                   label=f'Median: {median_error:.2f}%')
        ax.axvline(0, color='black', linestyle='-', linewidth=1)

        # Statistics text
        mae = np.mean(np.abs(errors))
        std = np.std(errors)
        ax.text(0.05, 0.95, f'MAE: {mae:.2f}%\nStd: {std:.2f}%',
                transform=ax.transAxes, verticalalignment='top',
                bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))

        ax.set_xlabel('Prediction Error (%)', fontweight='bold')
        ax.set_ylabel('Frequency', fontweight='bold')
        ax.set_title(f'{horizon}-Day Horizon', fontweight='bold', pad=10)
        ax.legend(loc='upper right')
        ax.grid(True, alpha=0.3)

    # Hide unused subplots
    for idx in range(n_horizons, 6):
        axes[idx].set_visible(False)

    plt.suptitle(title, fontsize=14, fontweight='bold', y=0.995)
    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"✅ Saved error distribution: {output_path}")


def plot_seasonal_heatmap(
    seasonal_results: pd.DataFrame,
    output_path: Path,
    metric: str = 'mae_pct',
    title: str = 'Seasonal Performance Heatmap'
) -> None:
    """
    Plot heatmap showing performance across months and horizons.

    Args:
        seasonal_results: DataFrame with columns ['horizon_days', 'month', metric]
        output_path: Path to save plot
        metric: Metric to plot
        title: Plot title
    """
    # Pivot data for heatmap
    pivot = seasonal_results.pivot(index='month', columns='horizon_days', values=metric)

    # Create figure
    fig, ax = plt.subplots(figsize=(12, 8))

    # Create heatmap
    sns.heatmap(pivot, annot=True, fmt='.2f', cmap='RdYlGn_r', center=pivot.mean().mean(),
                cbar_kws={'label': metric.upper().replace('_', ' ')},
                linewidths=0.5, linecolor='gray', ax=ax)

    ax.set_xlabel('Forecast Horizon (days)', fontweight='bold')
    ax.set_ylabel('Month', fontweight='bold')
    ax.set_title(title, fontweight='bold', pad=15)

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"✅ Saved seasonal heatmap: {output_path}")


def plot_confidence_intervals(
    dates: pd.Series,
    y_true: np.ndarray,
    y_pred: np.ndarray,
    output_path: Path,
    confidence_levels: List[float] = [0.90, 0.95],
    sample_days: int = 90,
    horizon: int = 7
) -> None:
    """
    Plot predictions with confidence intervals.

    Args:
        dates: Date series
        y_true: Actual values
        y_pred: Predicted values
        output_path: Path to save plot
        confidence_levels: Confidence levels for intervals
        sample_days: Number of days to plot
        horizon: Forecast horizon
    """
    # Sample data
    n = min(sample_days, len(dates))
    dates_sample = dates[:n]
    y_true_sample = y_true[:n]
    y_pred_sample = y_pred[:n]

    # Calculate residuals and std
    residuals = y_pred_sample - y_true_sample
    std_residuals = np.std(residuals)

    # Create figure
    fig, ax = plt.subplots(figsize=(14, 7))

    # Plot actual
    ax.plot(dates_sample, y_true_sample, label='Actual SR', color='black',
            linewidth=2, marker='o', markersize=4, zorder=3)

    # Plot prediction
    ax.plot(dates_sample, y_pred_sample, label=f'Predicted SR ({horizon}d horizon)',
            color=COLORS['primary'], linewidth=2, marker='s', markersize=4, zorder=2)

    # Plot confidence intervals
    colors_ci = [COLORS['info'], COLORS['secondary']]
    alphas = [0.3, 0.15]

    for i, (conf_level, color, alpha) in enumerate(zip(confidence_levels, colors_ci, alphas)):
        z_score = {0.90: 1.645, 0.95: 1.96, 0.99: 2.576}.get(conf_level, 1.96)

        lower = y_pred_sample - z_score * std_residuals
        upper = y_pred_sample + z_score * std_residuals

        ax.fill_between(dates_sample, lower, upper,
                        alpha=alpha, color=color, label=f'{int(conf_level*100)}% CI')

        # Calculate coverage
        within = (y_true_sample >= lower) & (y_true_sample <= upper)
        coverage = np.mean(within) * 100
        print(f"  {int(conf_level*100)}% CI Coverage: {coverage:.1f}%")

    ax.set_xlabel('Date', fontweight='bold')
    ax.set_ylabel('Soiling Ratio', fontweight='bold')
    ax.set_title(f'Forecast with Confidence Intervals ({horizon}-Day Horizon)',
                 fontweight='bold', pad=10)
    ax.legend(loc='best')
    ax.grid(True, alpha=0.3)
    ax.set_ylim([0.92, 1.01])

    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"✅ Saved confidence intervals: {output_path}")


def plot_comparison_summary(
    comparison: Dict[str, any],
    output_path: Path
) -> None:
    """
    Plot summary comparison of two models.

    Creates side-by-side visualization comparing model performance.

    Args:
        comparison: Results from compare_models()
        output_path: Path to save plot
    """
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))

    # Plot 1: MAE comparison
    models = [comparison['model1'], comparison['model2']]
    maes = [comparison['model1_mae'] * 100, comparison['model2_mae'] * 100]
    colors = [COLORS['primary'] if comparison['winner'] == models[0] else COLORS['secondary'],
              COLORS['primary'] if comparison['winner'] == models[1] else COLORS['secondary']]

    axes[0].bar(models, maes, color=colors, alpha=0.7, edgecolor='black', linewidth=1.5)
    axes[0].set_ylabel('MAE (%)', fontweight='bold')
    axes[0].set_title('Model Accuracy', fontweight='bold', pad=10)
    axes[0].grid(True, alpha=0.3, axis='y')

    # Add value labels
    for i, (model, mae) in enumerate(zip(models, maes)):
        axes[0].text(i, mae + 0.05, f'{mae:.2f}%', ha='center', fontweight='bold')

    # Plot 2: Statistical tests
    tests = ['T-test', 'Wilcoxon', 'DM Test']
    p_values = [
        comparison['paired_t_test']['p_value'],
        comparison['wilcoxon_test']['p_value'],
        comparison['diebold_mariano_test']['p_value']
    ]
    colors_sig = [COLORS['success'] if p < 0.05 else COLORS['danger'] for p in p_values]

    axes[1].barh(tests, [-np.log10(p) for p in p_values], color=colors_sig, alpha=0.7)
    axes[1].axvline(-np.log10(0.05), color='red', linestyle='--', linewidth=2, label='α=0.05')
    axes[1].set_xlabel('-log₁₀(p-value)', fontweight='bold')
    axes[1].set_title('Statistical Significance', fontweight='bold', pad=10)
    axes[1].legend()
    axes[1].grid(True, alpha=0.3, axis='x')

    # Plot 3: Effect size
    effect_size = comparison['cohens_d']
    interpretation = comparison['effect_interpretation']

    # Bar for effect size
    color_effect = COLORS['success'] if abs(effect_size) >= 0.5 else COLORS['warning']
    axes[2].barh(['Cohen\'s d'], [abs(effect_size)], color=color_effect, alpha=0.7)

    # Reference lines
    axes[2].axvline(0.2, color='gray', linestyle='--', alpha=0.5, label='Small (0.2)')
    axes[2].axvline(0.5, color='gray', linestyle='--', alpha=0.7, label='Medium (0.5)')
    axes[2].axvline(0.8, color='gray', linestyle='--', alpha=0.9, label='Large (0.8)')

    axes[2].set_xlabel('Effect Size', fontweight='bold')
    axes[2].set_title(f'Effect Size: {interpretation.title()}', fontweight='bold', pad=10)
    axes[2].legend()
    axes[2].grid(True, alpha=0.3, axis='x')

    plt.suptitle(f'Model Comparison: {comparison["model1"]} vs {comparison["model2"]}',
                 fontsize=14, fontweight='bold', y=1.02)
    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    plt.close()
    print(f"✅ Saved comparison summary: {output_path}")
