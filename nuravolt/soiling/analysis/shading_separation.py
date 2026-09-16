"""Explicit shading separation from soiling losses.

Shading and soiling both reduce power output but have different signatures:
- Shading: Strong time-of-day pattern (morning/evening dips)
- Soiling: Relatively uniform throughout the day

This module fits diurnal shading profiles from clear-sky days and
uses them to isolate the uniform soiling component.

Example usage:
    separator = ShadingSeparator()
    profile = separator.fit_shading_profile(df_scada)
    df_corrected = separator.correct_for_shading(df_scada, profile)
    severity = separator.detect_shading_severity(profile)
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Literal
import logging

import numpy as np
import pandas as pd
from scipy import stats
from scipy.signal import savgol_filter

logger = logging.getLogger(__name__)


@dataclass
class ShadingProfile:
    """Fitted shading profile for a plant or zone."""

    # Hourly shading factors (0-1, 1.0 = no shading)
    hourly_factors: pd.Series

    # Seasonal variation (month -> scale factor)
    seasonal_factors: Optional[Dict[int, float]] = None

    # Metadata
    severity: str = "none"  # none, light, moderate, severe
    morning_loss_pct: float = 0.0
    evening_loss_pct: float = 0.0
    peak_hours: Tuple[int, int] = (10, 14)
    fit_r2: float = 0.0
    n_clear_days: int = 0

    @property
    def daily_shading_loss_pct(self) -> float:
        """Average daily shading loss as percentage."""
        if self.hourly_factors is None:
            return 0.0
        # Only count daylight hours (6-18)
        daylight = self.hourly_factors.loc[6:18] if 6 in self.hourly_factors.index else self.hourly_factors
        return (1 - daylight.mean()) * 100

    def get_factor(self, hour: int, month: Optional[int] = None) -> float:
        """Get shading factor for a given hour (and optionally month)."""
        base_factor = self.hourly_factors.get(hour, 1.0)

        if month is not None and self.seasonal_factors:
            seasonal_scale = self.seasonal_factors.get(month, 1.0)
            # Seasonal adjustment: more shading in winter (lower sun)
            return base_factor * seasonal_scale

        return base_factor

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            'severity': self.severity,
            'morning_loss_pct': round(self.morning_loss_pct, 2),
            'evening_loss_pct': round(self.evening_loss_pct, 2),
            'daily_loss_pct': round(self.daily_shading_loss_pct, 2),
            'peak_hours': list(self.peak_hours),
            'fit_r2': round(self.fit_r2, 3),
            'n_clear_days': self.n_clear_days,
            'hourly_factors': {
                int(h): round(float(f), 4)
                for h, f in self.hourly_factors.items()
            },
            'seasonal_factors': self.seasonal_factors,
        }


class ShadingSeparator:
    """Separate shading losses from soiling losses using diurnal patterns.

    Shading creates predictable time-of-day patterns that can be fitted
    from clear-sky days and then removed from all data to isolate soiling.

    Methods:
    1. Identify clear-sky days (high irradiance, low variability)
    2. Fit hourly PR profile from clear-sky days
    3. Normalize to midday peak (assumed unshaded)
    4. Use profile to correct all data for shading

    Example:
        separator = ShadingSeparator()
        profile = separator.fit_shading_profile(df)
        df['pr_shading_corrected'] = separator.correct_for_shading(df, profile)
    """

    def __init__(
        self,
        min_irradiance_clear: float = 800.0,
        max_irradiance_cv: float = 0.10,
        peak_hours: Tuple[int, int] = (10, 14),
        min_clear_days: int = 10,
    ):
        """Initialize shading separator.

        Args:
            min_irradiance_clear: Minimum irradiance for clear-sky classification (W/m²)
            max_irradiance_cv: Maximum coefficient of variation for clear-sky
            peak_hours: Hours assumed to have minimal shading (start, end)
            min_clear_days: Minimum clear-sky days required for fitting
        """
        self.min_irradiance_clear = min_irradiance_clear
        self.max_irradiance_cv = max_irradiance_cv
        self.peak_hours = peak_hours
        self.min_clear_days = min_clear_days

    def fit_shading_profile(
        self,
        df: pd.DataFrame,
        pr_col: str = 'performance_ratio',
        irradiance_col: str = 'irradiance',
        fit_seasonal: bool = True,
    ) -> ShadingProfile:
        """Fit diurnal shading profile from clear-sky days.

        Args:
            df: SCADA DataFrame with timestamp index
            pr_col: Performance ratio column name
            irradiance_col: Irradiance column name
            fit_seasonal: Whether to fit seasonal variation

        Returns:
            ShadingProfile with fitted parameters
        """
        # Ensure datetime index
        if not isinstance(df.index, pd.DatetimeIndex):
            raise ValueError("DataFrame must have DatetimeIndex")

        # Add helper columns
        df_work = df.copy()
        df_work['hour'] = df_work.index.hour
        df_work['date'] = df_work.index.date
        df_work['month'] = df_work.index.month

        # Identify clear-sky days
        clear_days = self._identify_clear_days(df_work, irradiance_col)

        if len(clear_days) < self.min_clear_days:
            logger.warning(
                f"Only {len(clear_days)} clear days found, "
                f"need {self.min_clear_days}. Using all data."
            )
            clear_data = df_work
            n_clear_days = 0
        else:
            clear_data = df_work[df_work['date'].isin(clear_days)]
            n_clear_days = len(clear_days)
            logger.info(f"Using {n_clear_days} clear-sky days for shading fit")

        # Compute hourly PR profile
        hourly_pr = clear_data.groupby('hour')[pr_col].mean()

        # Normalize to peak hours (assumed unshaded)
        peak_start, peak_end = self.peak_hours
        peak_mask = (hourly_pr.index >= peak_start) & (hourly_pr.index <= peak_end)
        midday_pr = hourly_pr.loc[peak_mask].mean()

        if midday_pr <= 0 or pd.isna(midday_pr):
            midday_pr = hourly_pr.max()

        # Shading factor: 1.0 at peak, < 1.0 when shaded
        hourly_factors = (hourly_pr / midday_pr).clip(0.5, 1.05)

        # Smooth the profile to reduce noise
        if len(hourly_factors) >= 7:
            hourly_factors = pd.Series(
                savgol_filter(hourly_factors.values, window_length=5, polyorder=2),
                index=hourly_factors.index
            ).clip(0.5, 1.05)

        # Calculate morning/evening losses
        morning_hours = [7, 8, 9]
        evening_hours = [15, 16, 17]

        morning_loss = 1 - hourly_factors.loc[
            hourly_factors.index.isin(morning_hours)
        ].mean()
        evening_loss = 1 - hourly_factors.loc[
            hourly_factors.index.isin(evening_hours)
        ].mean()

        # Seasonal variation (optional)
        seasonal_factors = None
        if fit_seasonal and len(clear_data) > 100:
            seasonal_factors = self._fit_seasonal_variation(
                clear_data, pr_col, hourly_factors
            )

        # Compute fit quality (R² of profile)
        fit_r2 = self._compute_fit_quality(clear_data, pr_col, hourly_factors)

        # Determine severity
        severity = self._classify_severity(hourly_factors)

        profile = ShadingProfile(
            hourly_factors=hourly_factors,
            seasonal_factors=seasonal_factors,
            severity=severity,
            morning_loss_pct=morning_loss * 100,
            evening_loss_pct=evening_loss * 100,
            peak_hours=self.peak_hours,
            fit_r2=fit_r2,
            n_clear_days=n_clear_days,
        )

        logger.info(
            f"Fitted shading profile: severity={severity}, "
            f"daily_loss={profile.daily_shading_loss_pct:.1f}%"
        )

        return profile

    def correct_for_shading(
        self,
        df: pd.DataFrame,
        profile: ShadingProfile,
        pr_col: str = 'performance_ratio',
        output_col: str = 'pr_shading_corrected',
        use_seasonal: bool = True,
    ) -> pd.DataFrame:
        """Apply shading correction to performance ratio.

        Divides PR by shading factor to remove diurnal pattern,
        isolating the uniform soiling component.

        Args:
            df: DataFrame to correct
            profile: Fitted shading profile
            pr_col: Input PR column
            output_col: Output corrected PR column
            use_seasonal: Whether to apply seasonal adjustment

        Returns:
            DataFrame with added corrected columns
        """
        result = df.copy()

        # Extract hour (and month if seasonal)
        hour = result.index.hour
        month = result.index.month if use_seasonal else None

        # Get shading factors
        if use_seasonal and profile.seasonal_factors:
            shading_factors = pd.Series(
                [profile.get_factor(h, m) for h, m in zip(hour, month)],
                index=result.index
            )
        else:
            shading_factors = hour.map(profile.hourly_factors).fillna(1.0)

        result['shading_factor'] = shading_factors

        # Correct PR (divide by shading factor)
        # This "removes" the shading effect
        result[output_col] = result[pr_col] / shading_factors.clip(lower=0.5)

        # Cap at reasonable values
        result[output_col] = result[output_col].clip(0.5, 1.1)

        # Calculate shading loss component
        result['shading_loss'] = (1 - shading_factors).clip(lower=0)

        return result

    def separate_losses(
        self,
        df: pd.DataFrame,
        pr_col: str = 'performance_ratio',
        irradiance_col: str = 'irradiance',
    ) -> Tuple[pd.DataFrame, ShadingProfile]:
        """Complete workflow: fit profile and separate losses.

        Args:
            df: SCADA DataFrame
            pr_col: Performance ratio column
            irradiance_col: Irradiance column

        Returns:
            Tuple of (corrected DataFrame, shading profile)
        """
        profile = self.fit_shading_profile(df, pr_col, irradiance_col)
        df_corrected = self.correct_for_shading(df, profile, pr_col)

        # Estimate soiling from corrected PR
        # After shading removal, remaining loss is primarily soiling
        df_corrected['soiling_ratio_separated'] = df_corrected['pr_shading_corrected'].clip(0.7, 1.0)

        return df_corrected, profile

    def detect_shading_severity(
        self,
        profile: Optional[ShadingProfile] = None,
        hourly_factors: Optional[pd.Series] = None,
    ) -> str:
        """Classify shading severity based on diurnal amplitude.

        Args:
            profile: Fitted shading profile
            hourly_factors: Or raw hourly factors series

        Returns:
            Severity classification: 'none', 'light', 'moderate', 'severe'
        """
        if profile is not None:
            factors = profile.hourly_factors
        elif hourly_factors is not None:
            factors = hourly_factors
        else:
            return 'unknown'

        return self._classify_severity(factors)

    def generate_report(
        self,
        profile: ShadingProfile,
        df_original: Optional[pd.DataFrame] = None,
        df_corrected: Optional[pd.DataFrame] = None,
        pr_col: str = 'performance_ratio',
    ) -> dict:
        """Generate shading analysis report.

        Args:
            profile: Fitted shading profile
            df_original: Original data (optional, for comparison)
            df_corrected: Corrected data (optional, for comparison)
            pr_col: PR column name

        Returns:
            Report dictionary
        """
        report = {
            'profile': profile.to_dict(),
            'summary': {
                'severity': profile.severity,
                'daily_loss_pct': round(profile.daily_shading_loss_pct, 2),
                'morning_loss_pct': round(profile.morning_loss_pct, 2),
                'evening_loss_pct': round(profile.evening_loss_pct, 2),
                'fit_quality_r2': round(profile.fit_r2, 3),
                'clear_days_used': profile.n_clear_days,
            },
            'recommendations': self._generate_recommendations(profile),
        }

        if df_original is not None and df_corrected is not None:
            # Add comparison metrics
            original_pr = df_original[pr_col]
            corrected_pr = df_corrected['pr_shading_corrected']

            report['comparison'] = {
                'original_pr_mean': round(original_pr.mean(), 4),
                'corrected_pr_mean': round(corrected_pr.mean(), 4),
                'pr_improvement': round((corrected_pr.mean() - original_pr.mean()) * 100, 2),
                'original_pr_std': round(original_pr.std(), 4),
                'corrected_pr_std': round(corrected_pr.std(), 4),
                'variance_reduction_pct': round(
                    (1 - corrected_pr.std() / original_pr.std()) * 100, 1
                ) if original_pr.std() > 0 else 0,
            }

        return report

    def _identify_clear_days(
        self,
        df: pd.DataFrame,
        irradiance_col: str,
    ) -> List:
        """Identify clear-sky days based on irradiance patterns."""
        # Group by date and compute statistics
        daily_stats = df.groupby('date').agg({
            irradiance_col: ['max', 'mean', 'std'],
        })
        daily_stats.columns = ['irr_max', 'irr_mean', 'irr_std']

        # Clear-sky criteria:
        # 1. High maximum irradiance
        # 2. Low coefficient of variation (stable conditions)
        daily_stats['irr_cv'] = daily_stats['irr_std'] / daily_stats['irr_mean'].clip(lower=1)

        clear_mask = (
            (daily_stats['irr_max'] >= self.min_irradiance_clear) &
            (daily_stats['irr_cv'] <= self.max_irradiance_cv)
        )

        return daily_stats[clear_mask].index.tolist()

    def _fit_seasonal_variation(
        self,
        df: pd.DataFrame,
        pr_col: str,
        base_hourly: pd.Series,
    ) -> Dict[int, float]:
        """Fit monthly adjustment factors for shading."""
        # Compute monthly deviation from base profile
        monthly_factors = {}

        for month in range(1, 13):
            month_data = df[df['month'] == month]
            if len(month_data) < 10:
                monthly_factors[month] = 1.0
                continue

            # Compare actual PR to expected from base profile
            expected = month_data['hour'].map(base_hourly)
            actual = month_data[pr_col]

            # Ratio: how much worse/better than expected
            ratio = (actual / expected.clip(lower=0.5)).mean()
            monthly_factors[month] = float(ratio)

        return monthly_factors

    def _compute_fit_quality(
        self,
        df: pd.DataFrame,
        pr_col: str,
        hourly_factors: pd.Series,
    ) -> float:
        """Compute R² of shading profile fit."""
        if len(df) < 10:
            return 0.0

        predicted = df['hour'].map(hourly_factors)
        actual = df[pr_col]

        # Filter valid pairs
        valid = ~(predicted.isna() | actual.isna())
        if valid.sum() < 10:
            return 0.0

        # Compute R²
        ss_res = ((actual[valid] - predicted[valid]) ** 2).sum()
        ss_tot = ((actual[valid] - actual[valid].mean()) ** 2).sum()

        if ss_tot == 0:
            return 0.0

        r2 = 1 - (ss_res / ss_tot)
        return max(0, r2)

    def _classify_severity(self, hourly_factors: pd.Series) -> str:
        """Classify shading severity based on diurnal amplitude."""
        # Consider only daylight hours
        daylight = hourly_factors.loc[
            (hourly_factors.index >= 6) & (hourly_factors.index <= 18)
        ]

        if len(daylight) == 0:
            return 'unknown'

        amplitude = daylight.max() - daylight.min()

        if amplitude < 0.02:
            return 'none'
        elif amplitude < 0.05:
            return 'light'
        elif amplitude < 0.10:
            return 'moderate'
        else:
            return 'severe'

    def _generate_recommendations(self, profile: ShadingProfile) -> List[str]:
        """Generate recommendations based on shading analysis."""
        recommendations = []

        if profile.severity == 'none':
            recommendations.append(
                "Minimal shading detected. Diurnal patterns in power output "
                "are primarily due to other factors."
            )
        elif profile.severity == 'light':
            recommendations.append(
                f"Light shading detected ({profile.daily_shading_loss_pct:.1f}% daily loss). "
                "May not warrant intervention."
            )
        elif profile.severity == 'moderate':
            recommendations.append(
                f"Moderate shading detected ({profile.daily_shading_loss_pct:.1f}% daily loss). "
                "Consider vegetation trimming or obstacle removal."
            )
        else:  # severe
            recommendations.append(
                f"Severe shading detected ({profile.daily_shading_loss_pct:.1f}% daily loss). "
                "Investigation strongly recommended."
            )

        # Morning vs evening specific recommendations
        if profile.morning_loss_pct > profile.evening_loss_pct + 2:
            recommendations.append(
                f"Morning shading ({profile.morning_loss_pct:.1f}%) exceeds evening. "
                "Check for obstacles to the east (trees, buildings, hills)."
            )
        elif profile.evening_loss_pct > profile.morning_loss_pct + 2:
            recommendations.append(
                f"Evening shading ({profile.evening_loss_pct:.1f}%) exceeds morning. "
                "Check for obstacles to the west."
            )

        if profile.fit_r2 < 0.5:
            recommendations.append(
                "Shading profile fit quality is low. Results should be verified "
                "with site inspection or additional data."
            )

        return recommendations
