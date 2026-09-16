"""
Soiling Ratio Model Evaluation Module

Provides comprehensive evaluation framework for comparing soiling ratio (SR) models:
- Statistical metrics (MAE, RMSE, R², bias, correlation, MAPE)
- Temporal cross-validation with expanding windows
- Error analysis by season and conditions
- Physics-based validation checks
- Significance testing and model comparison

Author: NuraVolt Team
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
import json

from sklearn.metrics import (
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    mean_absolute_percentage_error
)
from scipy.stats import ttest_rel, wilcoxon


@dataclass
class EvaluationMetrics:
    """Comprehensive evaluation metrics for SR predictions."""

    # Statistical Accuracy
    mae: float  # Mean Absolute Error
    rmse: float  # Root Mean Square Error
    r2: float  # R² score (coefficient of determination)
    bias: float  # Mean bias (systematic over/under-prediction)
    correlation: float  # Pearson correlation
    mape: float  # Mean Absolute Percentage Error
    median_ae: float  # Median Absolute Error (robust)
    q95_ae: float  # 95th percentile error

    # Sample info
    n_samples: int
    date_range: Tuple[str, str]

    # Physics validation
    range_violations: int  # Predictions outside [0.75, 1.0]
    rain_reset_accuracy: float  # % correct after heavy rain

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)


@dataclass
class CrossValidationResults:
    """Results from temporal cross-validation."""

    fold_scores: List[Dict[str, float]]  # Metrics per fold
    mean_mae: float
    std_mae: float  # Stability metric (lower is better)
    mean_r2: float
    std_r2: float

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)


class ModelEvaluator:
    """
    Comprehensive model evaluation for Soiling Ratio predictions.

    Features:
    - Statistical metrics calculation
    - Temporal cross-validation
    - Error analysis by season and conditions
    - Physics-based validation
    - Significance testing for model comparison
    """

    def __init__(
        self,
        sr_min: float = 0.75,
        sr_max: float = 1.0,
        heavy_rain_threshold_mm: float = 10.0
    ):
        """
        Initialize evaluator.

        Parameters
        ----------
        sr_min : float
            Minimum valid SR value
        sr_max : float
            Maximum valid SR value
        heavy_rain_threshold_mm : float
            Threshold for heavy rain cleaning events
        """
        self.sr_min = sr_min
        self.sr_max = sr_max
        self.heavy_rain_threshold = heavy_rain_threshold_mm

    def evaluate_predictions(
        self,
        y_true: pd.Series,
        y_pred: pd.Series,
        df_rain: Optional[pd.DataFrame] = None
    ) -> EvaluationMetrics:
        """
        Calculate comprehensive evaluation metrics.

        Parameters
        ----------
        y_true : pd.Series
            Ground truth SR values (indexed by date)
        y_pred : pd.Series
            Predicted SR values (indexed by date)
        df_rain : pd.DataFrame, optional
            Rain data for physics validation

        Returns
        -------
        EvaluationMetrics
            All evaluation metrics
        """
        # Align series
        common_idx = y_true.index.intersection(y_pred.index)
        y_true_aligned = y_true.loc[common_idx]
        y_pred_aligned = y_pred.loc[common_idx]

        # Remove NaN
        valid_mask = ~(y_true_aligned.isna() | y_pred_aligned.isna())
        y_true_clean = y_true_aligned[valid_mask]
        y_pred_clean = y_pred_aligned[valid_mask]

        if len(y_true_clean) == 0:
            raise ValueError("No valid samples for evaluation")

        # Statistical metrics
        mae = mean_absolute_error(y_true_clean, y_pred_clean)
        rmse = np.sqrt(mean_squared_error(y_true_clean, y_pred_clean))
        r2 = r2_score(y_true_clean, y_pred_clean)
        bias = float((y_pred_clean - y_true_clean).mean())
        correlation = float(y_true_clean.corr(y_pred_clean))

        # Robust metrics
        abs_errors = np.abs(y_pred_clean - y_true_clean)
        median_ae = float(np.median(abs_errors))
        q95_ae = float(np.percentile(abs_errors, 95))

        # MAPE (handle division by zero)
        mape = mean_absolute_percentage_error(
            y_true_clean.replace(0, 1e-6),
            y_pred_clean
        )

        # Physics validation
        range_violations = int(
            ((y_pred_clean < self.sr_min) | (y_pred_clean > self.sr_max)).sum()
        )

        # Rain reset accuracy (if rain data available)
        rain_reset_accuracy = 0.0
        if df_rain is not None:
            rain_reset_accuracy = self._calculate_rain_reset_accuracy(
                y_pred_clean, df_rain
            )

        # Date range
        date_range = (
            str(y_true_clean.index.min())[:10],
            str(y_true_clean.index.max())[:10]
        )

        return EvaluationMetrics(
            mae=float(mae),
            rmse=float(rmse),
            r2=float(r2),
            bias=bias,
            correlation=correlation,
            mape=float(mape),
            median_ae=median_ae,
            q95_ae=q95_ae,
            n_samples=len(y_true_clean),
            date_range=date_range,
            range_violations=range_violations,
            rain_reset_accuracy=rain_reset_accuracy
        )

    def _calculate_rain_reset_accuracy(
        self,
        y_pred: pd.Series,
        df_rain: pd.DataFrame
    ) -> float:
        """
        Calculate accuracy of SR resets after heavy rain.

        Parameters
        ----------
        y_pred : pd.Series
            Predicted SR values
        df_rain : pd.DataFrame
            Rain data with 'precipitation_mm' column

        Returns
        -------
        float
            Percentage of correct rain resets (0-1)
        """
        # Ensure date column
        if 'date' in df_rain.columns:
            df_rain = df_rain.set_index('date')

        df_rain.index = pd.to_datetime(df_rain.index)

        # Find heavy rain events
        if 'precipitation_mm' not in df_rain.columns:
            return 0.0

        heavy_rain_dates = df_rain[
            df_rain['precipitation_mm'] >= self.heavy_rain_threshold
        ].index

        if len(heavy_rain_dates) == 0:
            return 0.0

        # Check SR within 2 days after each rain event
        correct_resets = 0
        for rain_date in heavy_rain_dates:
            # Get predictions for 2 days after rain
            end_date = rain_date + pd.Timedelta(days=2)
            sr_after_rain = y_pred.loc[
                (y_pred.index >= rain_date) & (y_pred.index <= end_date)
            ]

            if len(sr_after_rain) > 0:
                # SR should be > 0.99 after heavy rain
                if sr_after_rain.mean() > 0.99:
                    correct_resets += 1

        return correct_resets / len(heavy_rain_dates)

    def temporal_cross_validation(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        train_func: callable,
        predict_func: callable,
        n_splits: int = 3
    ) -> CrossValidationResults:
        """
        Perform temporal cross-validation with expanding window.

        Parameters
        ----------
        X : pd.DataFrame
            Features (indexed by date)
        y : pd.Series
            Target values (indexed by date)
        train_func : callable
            Function(X_train, y_train) -> model
        predict_func : callable
            Function(model, X_test) -> predictions
        n_splits : int
            Number of CV folds

        Returns
        -------
        CrossValidationResults
            CV results with fold-wise metrics
        """
        fold_scores = []

        # Define fold boundaries
        fold_percentages = np.linspace(0.33, 0.67, n_splits)

        for i, fold_pct in enumerate(fold_percentages):
            # Training set: beginning to fold_pct
            train_end_idx = int(len(X) * fold_pct)

            # Test set: next 17% of data
            test_end_idx = int(len(X) * min(fold_pct + 0.17, 1.0))

            # Split data
            X_train = X.iloc[:train_end_idx]
            y_train = y.iloc[:train_end_idx]
            X_test = X.iloc[train_end_idx:test_end_idx]
            y_test = y.iloc[train_end_idx:test_end_idx]

            if len(X_test) < 10:
                continue

            # Train model
            model = train_func(X_train, y_train)

            # Predict
            y_pred = predict_func(model, X_test)

            # Ensure series
            if isinstance(y_pred, np.ndarray):
                y_pred = pd.Series(y_pred, index=X_test.index)

            # Calculate metrics
            mae = mean_absolute_error(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))
            r2 = r2_score(y_test, y_pred)

            fold_scores.append({
                'fold': i + 1,
                'train_size': len(X_train),
                'test_size': len(X_test),
                'mae': float(mae),
                'rmse': float(rmse),
                'r2': float(r2),
                'train_period': (
                    str(X_train.index.min())[:10],
                    str(X_train.index.max())[:10]
                ),
                'test_period': (
                    str(X_test.index.min())[:10],
                    str(X_test.index.max())[:10]
                )
            })

        # Calculate statistics
        maes = [f['mae'] for f in fold_scores]
        r2s = [f['r2'] for f in fold_scores]

        return CrossValidationResults(
            fold_scores=fold_scores,
            mean_mae=float(np.mean(maes)),
            std_mae=float(np.std(maes)),
            mean_r2=float(np.mean(r2s)),
            std_r2=float(np.std(r2s))
        )

    def error_analysis_by_season(
        self,
        y_true: pd.Series,
        y_pred: pd.Series
    ) -> Dict[str, Dict[str, float]]:
        """
        Analyze errors by season.

        Parameters
        ----------
        y_true : pd.Series
            Ground truth (indexed by date)
        y_pred : pd.Series
            Predictions (indexed by date)

        Returns
        -------
        dict
            Error metrics per season
        """
        # Align
        common_idx = y_true.index.intersection(y_pred.index)
        y_true = y_true.loc[common_idx]
        y_pred = y_pred.loc[common_idx]

        # Add month column
        df = pd.DataFrame({
            'true': y_true,
            'pred': y_pred,
            'month': pd.to_datetime(y_true.index).month
        })

        # Define seasons
        seasons = {
            'winter': [12, 1, 2],
            'spring': [3, 4, 5],
            'summer': [6, 7, 8],
            'fall': [9, 10, 11]
        }

        season_metrics = {}

        for season_name, months in seasons.items():
            season_data = df[df['month'].isin(months)]

            if len(season_data) > 0:
                mae = mean_absolute_error(season_data['true'], season_data['pred'])
                rmse = np.sqrt(mean_squared_error(season_data['true'], season_data['pred']))
                bias = float((season_data['pred'] - season_data['true']).mean())

                season_metrics[season_name] = {
                    'mae': float(mae),
                    'rmse': float(rmse),
                    'bias': bias,
                    'n_samples': len(season_data)
                }

        return season_metrics

    @staticmethod
    def compare_models_statistical(
        y_true: pd.Series,
        y_pred1: pd.Series,
        y_pred2: pd.Series,
        model1_name: str = "Method 1",
        model2_name: str = "Method 2"
    ) -> Dict[str, Any]:
        """
        Statistical comparison of two models.

        Uses paired t-test and Wilcoxon signed-rank test to determine
        if differences are statistically significant.

        Parameters
        ----------
        y_true : pd.Series
            Ground truth
        y_pred1 : pd.Series
            Model 1 predictions
        y_pred2 : pd.Series
            Model 2 predictions
        model1_name : str
            Name of model 1
        model2_name : str
            Name of model 2

        Returns
        -------
        dict
            Statistical comparison results
        """
        # Align all series
        common_idx = y_true.index.intersection(y_pred1.index).intersection(y_pred2.index)
        y_true_aligned = y_true.loc[common_idx]
        y_pred1_aligned = y_pred1.loc[common_idx]
        y_pred2_aligned = y_pred2.loc[common_idx]

        # Calculate errors
        errors1 = np.abs(y_true_aligned - y_pred1_aligned)
        errors2 = np.abs(y_true_aligned - y_pred2_aligned)

        # Paired t-test
        t_stat, p_value_ttest = ttest_rel(errors1, errors2)

        # Wilcoxon signed-rank test (non-parametric)
        w_stat, p_value_wilcoxon = wilcoxon(errors1, errors2)

        # Effect size (Cohen's d)
        pooled_std = np.sqrt((errors1.std()**2 + errors2.std()**2) / 2)
        cohens_d = (errors1.mean() - errors2.mean()) / pooled_std if pooled_std > 0 else 0

        # Determine winner
        mae1 = errors1.mean()
        mae2 = errors2.mean()

        is_significant = p_value_ttest < 0.05
        winner = model1_name if mae1 < mae2 else model2_name

        return {
            'model1_name': model1_name,
            'model2_name': model2_name,
            'model1_mae': float(mae1),
            'model2_mae': float(mae2),
            'mae_difference': float(mae1 - mae2),
            'mae_difference_pct': float((mae1 - mae2) / mae2 * 100) if mae2 > 0 else 0,
            'ttest_statistic': float(t_stat),
            'ttest_p_value': float(p_value_ttest),
            'wilcoxon_statistic': float(w_stat),
            'wilcoxon_p_value': float(p_value_wilcoxon),
            'cohens_d': float(cohens_d),
            'is_significant': is_significant,
            'winner': winner if is_significant else "No significant difference",
            'interpretation': {
                'p_value': 'Significant' if is_significant else 'Not significant',
                'effect_size': (
                    'Large' if abs(cohens_d) > 0.8 else
                    'Medium' if abs(cohens_d) > 0.5 else
                    'Small'
                )
            }
        }

    def export_predictions(
        self,
        y_true: pd.Series,
        y_pred: pd.Series,
        output_path: Path,
        metadata: Optional[Dict] = None
    ) -> None:
        """
        Export predictions to CSV for analysis.

        Parameters
        ----------
        y_true : pd.Series
            Ground truth
        y_pred : pd.Series
            Predictions
        output_path : Path
            Path to save CSV
        metadata : dict, optional
            Additional metadata to include in header
        """
        # Align
        common_idx = y_true.index.intersection(y_pred.index)
        y_true = y_true.loc[common_idx]
        y_pred = y_pred.loc[common_idx]

        # Create dataframe
        df = pd.DataFrame({
            'date': y_true.index,
            'actual': y_true.values,
            'predicted': y_pred.values,
            'residual': (y_pred - y_true).values,
            'abs_error': np.abs(y_pred - y_true).values,
            'pct_error': ((y_pred - y_true) / y_true * 100).values
        })

        # Save
        output_path.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(output_path, index=False)

        # Save metadata if provided
        if metadata:
            meta_path = output_path.parent / f"{output_path.stem}_metadata.json"
            with open(meta_path, 'w') as f:
                json.dump(metadata, f, indent=2, default=str)
