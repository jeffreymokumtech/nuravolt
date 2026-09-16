"""
Validation Utilities for Digital Twin Models

Provides validation for:
1. Normal data selection - verify filtered data looks like normal operation
2. Physics compliance - ensure model respects physics constraints
3. Model quality - validate model performance metrics
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Any, Tuple
import logging

import numpy as np
import pandas as pd

try:
    from scipy import stats
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Result of validation check."""
    valid: bool
    score: float                      # 0-1 quality score
    checks: Dict[str, Any]            # Individual check results
    warnings: List[str]               # Warning messages
    errors: List[str]                 # Error messages


class NormalDataValidator:
    """
    Validate that filtered data represents normal operation.

    Checks:
    1. PR distribution - should be tight (std < 0.15)
    2. Time-of-day bias - should be minimal
    3. Residuals normality - should be approximately normal
    4. Sample size - should be sufficient
    5. Seasonal coverage - should cover all seasons
    """

    def __init__(
        self,
        p_rated: Optional[float] = None,
        min_samples: int = 100,
        max_pr_std: float = 0.15,
        max_hourly_pr_range: float = 0.2,
    ):
        """
        Initialize validator.

        Parameters:
        -----------
        p_rated : float
            Rated power for PR calculation
        min_samples : int
            Minimum required samples
        max_pr_std : float
            Maximum acceptable PR standard deviation
        max_hourly_pr_range : float
            Maximum acceptable PR range across hours
        """
        self.p_rated = p_rated
        self.min_samples = min_samples
        self.max_pr_std = max_pr_std
        self.max_hourly_pr_range = max_hourly_pr_range

    def validate(
        self,
        df: pd.DataFrame,
        mask: np.ndarray,
        irradiance_col: str = 'irradiance',
        power_col: str = 'power',
    ) -> ValidationResult:
        """
        Validate normal data selection.

        Parameters:
        -----------
        df : pd.DataFrame
            Original data
        mask : np.ndarray
            Boolean mask of selected normal data
        irradiance_col : str
            Irradiance column name
        power_col : str
            Power column name

        Returns:
        --------
        ValidationResult
            Validation results
        """
        normal = df[mask]

        checks = {}
        warnings = []
        errors = []
        score = 1.0

        # Check 1: Sample size
        n_samples = mask.sum()
        checks['sample_size'] = {
            'n_samples': int(n_samples),
            'min_required': self.min_samples,
            'passed': n_samples >= self.min_samples
        }
        if n_samples < self.min_samples:
            errors.append(f"Insufficient samples: {n_samples} < {self.min_samples}")
            score *= 0.5

        if len(normal) == 0:
            return ValidationResult(
                valid=False,
                score=0.0,
                checks=checks,
                warnings=warnings,
                errors=['No data after filtering']
            )

        # Check 2: PR distribution
        if power_col in normal.columns and irradiance_col in normal.columns and self.p_rated:
            irr = normal[irradiance_col].values
            power = normal[power_col].values

            with np.errstate(divide='ignore', invalid='ignore'):
                pr = np.where(irr > 50, power / ((irr / 1000) * self.p_rated), np.nan)

            pr_valid = pr[~np.isnan(pr)]
            if len(pr_valid) > 0:
                pr_mean = np.mean(pr_valid)
                pr_std = np.std(pr_valid)

                checks['pr_distribution'] = {
                    'mean': float(pr_mean),
                    'std': float(pr_std),
                    'max_std': self.max_pr_std,
                    'passed': pr_std < self.max_pr_std
                }

                if pr_std >= self.max_pr_std:
                    warnings.append(f"PR too variable (std={pr_std:.3f})")
                    score *= 0.8

                # Check for reasonable PR range
                if pr_mean < 0.5 or pr_mean > 1.0:
                    warnings.append(f"PR mean outside normal range: {pr_mean:.3f}")
                    score *= 0.9

        # Check 3: Time-of-day bias
        if isinstance(normal.index, pd.DatetimeIndex) and power_col in normal.columns:
            if self.p_rated and irradiance_col in normal.columns:
                irr = normal[irradiance_col].values
                power = normal[power_col].values
                with np.errstate(divide='ignore', invalid='ignore'):
                    pr = np.where(irr > 50, power / ((irr / 1000) * self.p_rated), np.nan)
                pr_series = pd.Series(pr, index=normal.index)
            else:
                pr_series = normal[power_col]

            pr_by_hour = pr_series.groupby(normal.index.hour).mean()
            pr_range = pr_by_hour.max() - pr_by_hour.min()

            checks['hourly_bias'] = {
                'pr_range': float(pr_range),
                'max_range': self.max_hourly_pr_range,
                'passed': pr_range < self.max_hourly_pr_range
            }

            if pr_range >= self.max_hourly_pr_range:
                warnings.append(f"Systematic hourly bias detected (range={pr_range:.3f})")
                score *= 0.9

        # Check 4: Seasonal coverage
        if isinstance(normal.index, pd.DatetimeIndex):
            months = normal.index.month.unique()
            seasons = {
                'winter': [12, 1, 2],
                'spring': [3, 4, 5],
                'summer': [6, 7, 8],
                'fall': [9, 10, 11]
            }

            seasons_covered = sum(
                any(m in months for m in season_months)
                for season_months in seasons.values()
            )

            checks['seasonal_coverage'] = {
                'seasons_covered': seasons_covered,
                'months_present': sorted(months.tolist()),
                'passed': seasons_covered >= 3
            }

            if seasons_covered < 3:
                warnings.append(f"Limited seasonal coverage ({seasons_covered}/4 seasons)")
                score *= 0.9

        # Check 5: Normality of residuals (if scipy available)
        if SCIPY_AVAILABLE and 'pr_distribution' in checks:
            try:
                pr_valid = pr[~np.isnan(pr)]
                if len(pr_valid) > 100:
                    _, p_value = stats.normaltest(pr_valid[:1000])  # Limit for speed

                    checks['normality'] = {
                        'p_value': float(p_value),
                        'passed': p_value > 0.01  # Not strictly required
                    }

                    if p_value < 0.01:
                        warnings.append("PR distribution significantly non-normal")
            except Exception:
                pass  # Skip if test fails

        # Calculate final validity
        valid = len(errors) == 0 and score > 0.6

        return ValidationResult(
            valid=valid,
            score=score,
            checks=checks,
            warnings=warnings,
            errors=errors
        )


class PhysicsComplianceValidator:
    """
    Validate that model predictions respect physics constraints.

    Checks:
    1. Night power - should be zero when irradiance is low
    2. Irradiance scaling - power should scale with irradiance
    3. Temperature derating - higher temp should reduce power (c-Si)
    4. Non-negative predictions - power should never be negative
    5. Maximum bounds - power should not exceed theoretical max
    """

    def __init__(
        self,
        p_rated: Optional[float] = None,
        night_irradiance_threshold: float = 50.0,
        max_night_power_ratio: float = 0.01,
    ):
        """
        Initialize validator.

        Parameters:
        -----------
        p_rated : float
            Rated power for bounds checking
        night_irradiance_threshold : float
            Irradiance threshold for nighttime
        max_night_power_ratio : float
            Maximum acceptable power/rated at night
        """
        self.p_rated = p_rated
        self.night_irradiance_threshold = night_irradiance_threshold
        self.max_night_power_ratio = max_night_power_ratio

    def validate(
        self,
        predictions: np.ndarray,
        irradiance: np.ndarray,
        temperature: Optional[np.ndarray] = None,
    ) -> ValidationResult:
        """
        Validate model predictions for physics compliance.

        Parameters:
        -----------
        predictions : np.ndarray
            Model predictions (kW)
        irradiance : np.ndarray
            Irradiance values (W/m²)
        temperature : np.ndarray
            Temperature values (°C), optional

        Returns:
        --------
        ValidationResult
            Validation results
        """
        checks = {}
        warnings = []
        errors = []
        score = 1.0

        predictions = np.asarray(predictions)
        irradiance = np.asarray(irradiance)

        # Check 1: Non-negative predictions
        negative_count = np.sum(predictions < 0)
        checks['non_negative'] = {
            'negative_count': int(negative_count),
            'passed': negative_count == 0
        }
        if negative_count > 0:
            errors.append(f"Model predicts negative power: {negative_count} instances")
            score *= 0.5

        # Check 2: Night power
        night_mask = irradiance < self.night_irradiance_threshold
        if night_mask.any():
            night_predictions = predictions[night_mask]
            max_night_power = np.max(night_predictions) if len(night_predictions) > 0 else 0

            if self.p_rated:
                night_ratio = max_night_power / self.p_rated
            else:
                night_ratio = max_night_power / (np.max(predictions) + 0.01)

            checks['night_power'] = {
                'max_night_power': float(max_night_power),
                'night_ratio': float(night_ratio),
                'passed': night_ratio < self.max_night_power_ratio
            }

            if night_ratio >= self.max_night_power_ratio:
                warnings.append(f"Non-zero night power: {max_night_power:.2f} kW")
                score *= 0.8

        # Check 3: Irradiance scaling
        # Power should generally increase with irradiance
        if len(predictions) > 100:
            try:
                correlation = np.corrcoef(
                    irradiance[irradiance > 50],
                    predictions[irradiance > 50]
                )[0, 1]

                checks['irradiance_correlation'] = {
                    'correlation': float(correlation),
                    'passed': correlation > 0.8
                }

                if correlation <= 0.8:
                    warnings.append(f"Weak irradiance correlation: {correlation:.3f}")
                    score *= 0.9
            except Exception:
                pass

        # Check 4: Maximum bounds
        if self.p_rated:
            # At peak irradiance, power shouldn't exceed rated
            high_irr_mask = irradiance > 900
            if high_irr_mask.any():
                max_high_irr_power = np.max(predictions[high_irr_mask])
                over_capacity = max_high_irr_power > self.p_rated * 1.1

                checks['max_bounds'] = {
                    'max_prediction': float(max_high_irr_power),
                    'rated_power': self.p_rated,
                    'passed': not over_capacity
                }

                if over_capacity:
                    warnings.append(f"Predictions exceed capacity: {max_high_irr_power:.1f} > {self.p_rated:.1f}")
                    score *= 0.9

        # Check 5: Temperature effect (if available)
        if temperature is not None and len(predictions) > 100:
            try:
                temperature = np.asarray(temperature)
                # At similar irradiance levels, higher temp should mean lower power
                high_irr = (irradiance > 800) & (irradiance < 1000)
                if high_irr.sum() > 50:
                    temp_power_corr = np.corrcoef(
                        temperature[high_irr],
                        predictions[high_irr]
                    )[0, 1]

                    # For c-Si, expect negative correlation
                    checks['temperature_effect'] = {
                        'correlation': float(temp_power_corr),
                        'passed': temp_power_corr < 0.3  # Should be negative or weak positive
                    }

                    if temp_power_corr > 0.3:
                        warnings.append(f"Unexpected positive temp-power correlation: {temp_power_corr:.3f}")
            except Exception:
                pass

        # Calculate final validity
        valid = len(errors) == 0 and score > 0.7

        return ValidationResult(
            valid=valid,
            score=score,
            checks=checks,
            warnings=warnings,
            errors=errors
        )


class ModelQualityValidator:
    """
    Validate model quality metrics.

    Checks:
    1. R² score - should exceed minimum threshold
    2. MAE - should be below maximum threshold
    3. Training samples - should be sufficient
    4. Feature importance - no single feature should dominate
    """

    def __init__(
        self,
        min_r2: float = 0.70,
        max_mae_kw: float = 50.0,
        min_training_samples: int = 500,
        max_single_feature_importance: float = 0.8,
    ):
        """
        Initialize validator.

        Parameters:
        -----------
        min_r2 : float
            Minimum acceptable R² score
        max_mae_kw : float
            Maximum acceptable MAE (kW)
        min_training_samples : int
            Minimum required training samples
        max_single_feature_importance : float
            Maximum importance for any single feature
        """
        self.min_r2 = min_r2
        self.max_mae_kw = max_mae_kw
        self.min_training_samples = min_training_samples
        self.max_single_feature_importance = max_single_feature_importance

    def validate(
        self,
        r2: float,
        mae: float,
        training_samples: int,
        feature_importance: Optional[Dict[str, float]] = None,
    ) -> ValidationResult:
        """
        Validate model quality.

        Parameters:
        -----------
        r2 : float
            R² score
        mae : float
            Mean absolute error (kW)
        training_samples : int
            Number of training samples
        feature_importance : Dict
            Feature importance scores

        Returns:
        --------
        ValidationResult
            Validation results
        """
        checks = {}
        warnings = []
        errors = []
        score = 1.0

        # Check 1: R² score
        checks['r2_score'] = {
            'value': r2,
            'min_required': self.min_r2,
            'passed': r2 >= self.min_r2
        }
        if r2 < self.min_r2:
            errors.append(f"R² below threshold: {r2:.4f} < {self.min_r2}")
            score *= 0.7

        # Check 2: MAE
        checks['mae'] = {
            'value': mae,
            'max_allowed': self.max_mae_kw,
            'passed': mae <= self.max_mae_kw
        }
        if mae > self.max_mae_kw:
            errors.append(f"MAE above threshold: {mae:.2f} > {self.max_mae_kw}")
            score *= 0.7

        # Check 3: Training samples
        checks['training_samples'] = {
            'value': training_samples,
            'min_required': self.min_training_samples,
            'passed': training_samples >= self.min_training_samples
        }
        if training_samples < self.min_training_samples:
            warnings.append(f"Limited training data: {training_samples} samples")
            score *= 0.9

        # Check 4: Feature importance distribution
        if feature_importance:
            max_importance = max(feature_importance.values()) if feature_importance else 0
            total_importance = sum(feature_importance.values())

            if total_importance > 0:
                max_importance_ratio = max_importance / total_importance
            else:
                max_importance_ratio = 0

            checks['feature_importance'] = {
                'max_importance': float(max_importance_ratio),
                'max_allowed': self.max_single_feature_importance,
                'passed': max_importance_ratio <= self.max_single_feature_importance
            }

            if max_importance_ratio > self.max_single_feature_importance:
                warnings.append(f"Single feature dominates: {max_importance_ratio:.2f}")
                score *= 0.95

        # Calculate final validity
        valid = len(errors) == 0 and score > 0.6

        return ValidationResult(
            valid=valid,
            score=score,
            checks=checks,
            warnings=warnings,
            errors=errors
        )


def validate_complete_model(
    df: pd.DataFrame,
    mask: np.ndarray,
    predictions: np.ndarray,
    metrics: Dict[str, Any],
    irradiance_col: str = 'irradiance',
    power_col: str = 'power',
    temperature_col: str = 'temperature',
    p_rated: Optional[float] = None,
) -> Dict[str, ValidationResult]:
    """
    Run complete validation on model and data.

    Parameters:
    -----------
    df : pd.DataFrame
        Original data
    mask : np.ndarray
        Normal data mask
    predictions : np.ndarray
        Model predictions
    metrics : Dict
        Model metrics (r2, mae, etc.)
    irradiance_col, power_col, temperature_col : str
        Column names
    p_rated : float
        Rated power

    Returns:
    --------
    Dict[str, ValidationResult]
        Results for each validation type
    """
    results = {}

    # Normal data validation
    normal_validator = NormalDataValidator(p_rated=p_rated)
    results['normal_data'] = normal_validator.validate(
        df, mask, irradiance_col, power_col
    )

    # Physics compliance validation
    physics_validator = PhysicsComplianceValidator(p_rated=p_rated)
    irradiance = df[irradiance_col].values if irradiance_col in df.columns else np.zeros(len(df))
    temperature = df[temperature_col].values if temperature_col in df.columns else None

    results['physics_compliance'] = physics_validator.validate(
        predictions, irradiance, temperature
    )

    # Model quality validation
    quality_validator = ModelQualityValidator()
    results['model_quality'] = quality_validator.validate(
        r2=metrics.get('r2', 0),
        mae=metrics.get('mae', 0) or metrics.get('mae_kW', 0),
        training_samples=metrics.get('trainingSamples', 0) or metrics.get('training_samples', 0),
        feature_importance=metrics.get('featureImportance'),
    )

    return results


def summarize_validation(results: Dict[str, ValidationResult]) -> Dict[str, Any]:
    """
    Summarize validation results.

    Parameters:
    -----------
    results : Dict[str, ValidationResult]
        Validation results by type

    Returns:
    --------
    Dict
        Summary with overall pass/fail and details
    """
    all_valid = all(r.valid for r in results.values())
    overall_score = np.mean([r.score for r in results.values()])

    all_warnings = []
    all_errors = []

    for name, result in results.items():
        all_warnings.extend([f"{name}: {w}" for w in result.warnings])
        all_errors.extend([f"{name}: {e}" for e in result.errors])

    return {
        'valid': all_valid,
        'overall_score': round(overall_score, 3),
        'results': {name: result.valid for name, result in results.items()},
        'scores': {name: round(result.score, 3) for name, result in results.items()},
        'warnings': all_warnings,
        'errors': all_errors,
    }
