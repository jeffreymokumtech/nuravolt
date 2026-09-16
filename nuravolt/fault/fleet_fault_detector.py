"""
Fleet-based fault detection using twin features.

Distinguishes soiling from equipment faults by analyzing:
1. Fleet deviation: Soiling affects all inverters uniformly, faults affect individual units
2. Suddenness: Soiling is gradual, equipment faults are sudden
3. Rain response: Soiling improves after rain, faults don't
4. Diurnal pattern: Shading has time-of-day signature, soiling doesn't

Reference: IEA PVPS Task 13, Section 4.3
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple
from pathlib import Path

import numpy as np
import pandas as pd


class LossType(Enum):
    """Classification of power loss types."""
    SOILING = "soiling"
    EQUIPMENT_FAULT = "equipment_fault"
    SHADING = "shading"
    THERMAL = "thermal"
    DEGRADATION = "degradation"
    CURTAILMENT = "curtailment"
    UNKNOWN = "unknown"


@dataclass
class FleetDeviationResult:
    """Result of fleet deviation analysis for a single inverter."""
    inverter_id: str
    date: pd.Timestamp
    deviation_pct: float  # % deviation from fleet median
    physics_residual_pct: float  # Twin physics residual
    is_outlier: bool  # True if significant deviation
    loss_type: LossType
    confidence: float  # 0-1 confidence in classification


@dataclass
class FaultDetectionConfig:
    """Configuration for fault detection."""
    # Thresholds for fleet deviation
    outlier_threshold_pct: float = 5.0  # >5% deviation = potential issue
    severe_outlier_pct: float = 10.0    # >10% = definite issue

    # Suddenness detection
    sudden_change_threshold_pct: float = 3.0  # >3% single-day change = sudden
    gradual_window_days: int = 7  # Window for gradual trend detection

    # Rain response
    rain_response_threshold_pct: float = 2.0  # >2% improvement after rain = rain-responsive
    rain_window_days: int = 3  # Days to look after rain event

    # Diurnal pattern (shading)
    diurnal_amplitude_threshold_pct: float = 2.0  # >2% morning/evening dip = shading


@dataclass
class RainResponseResult:
    """Result of rain response analysis."""
    date: pd.Timestamp
    rain_mm: float
    sr_before: float
    sr_after: float
    response_pct: float  # % improvement
    confirms_soiling: bool  # True if response suggests soiling


class FleetFaultDetector:
    """Detect equipment faults vs soiling using fleet comparison and twin features.

    Uses the principle that soiling affects all inverters uniformly while
    equipment faults affect individual units differently.

    Example:
        detector = FleetFaultDetector(config)
        results = detector.analyze_fleet(df_all_inverters)
        faults = [r for r in results if r.loss_type == LossType.EQUIPMENT_FAULT]
    """

    def __init__(self, config: Optional[FaultDetectionConfig] = None):
        self.config = config or FaultDetectionConfig()

    def compute_fleet_deviation(
        self,
        df: pd.DataFrame,
        power_col: str = "power_actual",
        inverter_col: str = "inverter_id",
        date_col: str = "date",
    ) -> pd.DataFrame:
        """Compute each inverter's deviation from fleet median.

        Args:
            df: DataFrame with all inverters' power data
            power_col: Column name for power
            inverter_col: Column name for inverter ID
            date_col: Column name for date

        Returns:
            DataFrame with deviation metrics per inverter per day
        """
        # Pivot to get power by inverter
        if date_col not in df.columns:
            if "timestamp" in df.columns:
                df = df.copy()
                df[date_col] = pd.to_datetime(df["timestamp"]).dt.date
            else:
                raise ValueError(f"No date column '{date_col}' found")

        # Group by date and inverter, aggregate power
        daily = df.groupby([date_col, inverter_col])[power_col].sum().reset_index()
        pivot = daily.pivot(index=date_col, columns=inverter_col, values=power_col)

        # Compute fleet median and std per day
        fleet_median = pivot.median(axis=1)
        fleet_std = pivot.std(axis=1)

        # Compute deviation for each inverter
        results = []
        for inv_id in pivot.columns:
            inv_power = pivot[inv_id]
            deviation = (inv_power - fleet_median) / fleet_median * 100  # As percentage
            z_score = (inv_power - fleet_median) / fleet_std.replace(0, np.nan)

            for date in pivot.index:
                if pd.isna(deviation[date]):
                    continue
                results.append({
                    "date": date,
                    "inverter_id": inv_id,
                    "power": inv_power[date],
                    "fleet_median": fleet_median[date],
                    "deviation_pct": deviation[date],
                    "z_score": z_score[date] if not pd.isna(z_score[date]) else 0,
                    "is_outlier": abs(deviation[date]) > self.config.outlier_threshold_pct,
                })

        return pd.DataFrame(results)

    def detect_suddenness(
        self,
        sr_series: pd.Series,
    ) -> Tuple[bool, float]:
        """Detect if changes are sudden (fault) vs gradual (soiling).

        Args:
            sr_series: Time series of SR or power values

        Returns:
            (is_sudden, max_change_pct)
        """
        if len(sr_series) < 3:
            return False, 0.0

        # Compute day-over-day changes
        changes = sr_series.diff().abs()
        max_change = changes.max() * 100  # As percentage

        is_sudden = max_change > self.config.sudden_change_threshold_pct

        return is_sudden, max_change

    def analyze_rain_response(
        self,
        sr_series: pd.Series,
        rain_series: pd.Series,
        rain_threshold_mm: float = 5.0,
    ) -> List[RainResponseResult]:
        """Analyze SR response to rain events.

        Soiling: SR improves after rain
        Faults/degradation: No response to rain

        Args:
            sr_series: Daily SR values
            rain_series: Daily rainfall in mm
            rain_threshold_mm: Minimum rain to consider

        Returns:
            List of rain response results
        """
        results = []

        # Align indices
        common_idx = sr_series.index.intersection(rain_series.index)
        sr = sr_series.loc[common_idx].sort_index()
        rain = rain_series.loc[common_idx].sort_index()

        # Find rain events
        rain_events = rain[rain >= rain_threshold_mm]

        for rain_date in rain_events.index:
            # Get SR before rain (average of 3 days before)
            before_start = rain_date - pd.Timedelta(days=3)
            before_mask = (sr.index >= before_start) & (sr.index < rain_date)
            if before_mask.sum() == 0:
                continue
            sr_before = sr[before_mask].mean()

            # Get SR after rain (1-3 days after)
            after_start = rain_date + pd.Timedelta(days=1)
            after_end = rain_date + pd.Timedelta(days=self.config.rain_window_days)
            after_mask = (sr.index >= after_start) & (sr.index <= after_end)
            if after_mask.sum() == 0:
                continue
            sr_after = sr[after_mask].mean()

            response_pct = (sr_after - sr_before) * 100
            confirms_soiling = response_pct > self.config.rain_response_threshold_pct

            results.append(RainResponseResult(
                date=rain_date,
                rain_mm=float(rain_events[rain_date]),
                sr_before=float(sr_before),
                sr_after=float(sr_after),
                response_pct=float(response_pct),
                confirms_soiling=confirms_soiling,
            ))

        return results

    def detect_diurnal_pattern(
        self,
        df_hourly: pd.DataFrame,
        power_col: str = "power_actual",
        hour_col: str = "hour",
    ) -> Tuple[bool, float]:
        """Detect diurnal (time-of-day) pattern suggesting shading.

        Shading creates consistent morning/evening dips unrelated to soiling.

        Args:
            df_hourly: Hourly power data
            power_col: Column for power
            hour_col: Column for hour of day

        Returns:
            (has_shading_pattern, amplitude_pct)
        """
        if hour_col not in df_hourly.columns:
            if "timestamp" in df_hourly.columns:
                df_hourly = df_hourly.copy()
                df_hourly[hour_col] = pd.to_datetime(df_hourly["timestamp"]).dt.hour
            else:
                return False, 0.0

        # Normalize power by daily max to isolate pattern
        if "date" not in df_hourly.columns:
            df_hourly = df_hourly.copy()
            df_hourly["date"] = pd.to_datetime(df_hourly.get("timestamp", df_hourly.index)).dt.date

        daily_max = df_hourly.groupby("date")[power_col].transform("max")
        df_hourly["power_norm"] = df_hourly[power_col] / daily_max.replace(0, np.nan)

        # Compute average hourly profile
        hourly_profile = df_hourly.groupby(hour_col)["power_norm"].mean()

        # Filter to solar hours (9am-3pm typically)
        solar_hours = hourly_profile[(hourly_profile.index >= 9) & (hourly_profile.index <= 15)]
        if len(solar_hours) < 3:
            return False, 0.0

        # Amplitude = max - min during solar hours
        amplitude = (solar_hours.max() - solar_hours.min()) * 100

        has_shading = amplitude > self.config.diurnal_amplitude_threshold_pct

        return has_shading, amplitude

    def classify_loss_type(
        self,
        deviation_pct: float,
        is_outlier: bool,
        is_sudden: bool,
        rain_response_confirms_soiling: bool,
        has_diurnal_pattern: bool,
    ) -> Tuple[LossType, float]:
        """Classify the type of power loss based on multiple signals.

        Decision logic:
        1. If outlier + sudden → Equipment fault (high confidence)
        2. If uniform + gradual + rain responsive → Soiling
        3. If diurnal pattern → Shading
        4. If neither → Unknown or degradation

        Args:
            deviation_pct: Fleet deviation percentage
            is_outlier: Is this inverter an outlier from fleet?
            is_sudden: Was the change sudden?
            rain_response_confirms_soiling: Did SR improve after rain?
            has_diurnal_pattern: Is there a time-of-day pattern?

        Returns:
            (loss_type, confidence)
        """
        confidence_factors = []

        # Equipment fault: outlier + sudden
        if is_outlier and is_sudden:
            confidence_factors.append(("fault", 0.4))
            confidence_factors.append(("fault", 0.3 if abs(deviation_pct) > self.config.severe_outlier_pct else 0.1))
            if not rain_response_confirms_soiling:
                confidence_factors.append(("fault", 0.2))

        # Soiling: uniform + gradual + rain responsive
        if not is_outlier and rain_response_confirms_soiling:
            confidence_factors.append(("soiling", 0.5))
        if not is_sudden and rain_response_confirms_soiling:
            confidence_factors.append(("soiling", 0.3))

        # Shading: diurnal pattern
        if has_diurnal_pattern:
            confidence_factors.append(("shading", 0.6))

        # Aggregate confidence by type
        type_scores = {}
        for loss_type, score in confidence_factors:
            type_scores[loss_type] = type_scores.get(loss_type, 0) + score

        if not type_scores:
            return LossType.UNKNOWN, 0.3

        # Return highest confidence type
        best_type = max(type_scores.keys(), key=lambda t: type_scores[t])
        confidence = min(type_scores[best_type], 1.0)

        type_map = {
            "soiling": LossType.SOILING,
            "fault": LossType.EQUIPMENT_FAULT,
            "shading": LossType.SHADING,
        }

        return type_map.get(best_type, LossType.UNKNOWN), confidence

    def analyze_inverter(
        self,
        df_inv: pd.DataFrame,
        df_fleet: pd.DataFrame,
        rain_series: Optional[pd.Series] = None,
        inverter_id: str = "unknown",
    ) -> List[FleetDeviationResult]:
        """Full analysis of a single inverter against fleet.

        Args:
            df_inv: Single inverter's data
            df_fleet: All inverters' data (for fleet comparison)
            rain_series: Optional rain data for response analysis
            inverter_id: Inverter identifier

        Returns:
            List of daily classification results
        """
        results = []

        # Compute fleet deviation
        fleet_dev = self.compute_fleet_deviation(df_fleet)
        inv_dev = fleet_dev[fleet_dev["inverter_id"] == inverter_id]

        if inv_dev.empty:
            return results

        # Get SR or use physics residual
        if "sr_estimated" in df_inv.columns:
            sr_col = "sr_estimated"
        elif "physics_residual_pct" in df_inv.columns:
            sr_col = "physics_residual_pct"
            # Invert: lower residual = higher SR
        else:
            sr_col = None

        # Analyze suddenness over rolling window
        for _, row in inv_dev.iterrows():
            date = row["date"]
            deviation_pct = row["deviation_pct"]
            is_outlier = row["is_outlier"]

            # Get recent history for suddenness analysis
            recent_mask = inv_dev["date"] <= date
            recent = inv_dev[recent_mask].tail(self.config.gradual_window_days)

            if len(recent) > 2:
                is_sudden, _ = self.detect_suddenness(recent.set_index("date")["deviation_pct"])
            else:
                is_sudden = False

            # Rain response (if data available)
            rain_response = False
            if rain_series is not None and sr_col is not None:
                sr_series = df_inv.set_index("date" if "date" in df_inv.columns else df_inv.index)[sr_col]
                responses = self.analyze_rain_response(sr_series, rain_series)
                rain_response = any(r.confirms_soiling for r in responses if abs((r.date - date).days) < 14)

            # Diurnal pattern (need hourly data - skip for daily)
            has_diurnal = False

            # Classify
            loss_type, confidence = self.classify_loss_type(
                deviation_pct=deviation_pct,
                is_outlier=is_outlier,
                is_sudden=is_sudden,
                rain_response_confirms_soiling=rain_response,
                has_diurnal_pattern=has_diurnal,
            )

            physics_res = 0.0
            if "physics_residual_pct" in df_inv.columns:
                day_data = df_inv[df_inv["date"] == date] if "date" in df_inv.columns else None
                if day_data is not None and len(day_data) > 0:
                    physics_res = day_data["physics_residual_pct"].mean()

            results.append(FleetDeviationResult(
                inverter_id=inverter_id,
                date=pd.Timestamp(date),
                deviation_pct=deviation_pct,
                physics_residual_pct=physics_res,
                is_outlier=is_outlier,
                loss_type=loss_type,
                confidence=confidence,
            ))

        return results


def compute_fleet_cv(
    df: pd.DataFrame,
    power_col: str = "power_actual",
    inverter_col: str = "inverter_id",
) -> float:
    """Compute coefficient of variation across fleet.

    Low CV (<5%) suggests uniform loss (soiling).
    High CV (>10%) suggests non-uniform loss (faults, shading).

    Args:
        df: DataFrame with all inverters' power
        power_col: Power column name
        inverter_col: Inverter ID column

    Returns:
        CV as percentage
    """
    inv_totals = df.groupby(inverter_col)[power_col].sum()
    cv = inv_totals.std() / inv_totals.mean() * 100
    return float(cv) if not np.isnan(cv) else 0.0


@dataclass
class FleetAnalysisResult:
    """Result of comprehensive fleet analysis separating soiling and faults."""

    # Fleet-level metrics (after removing outliers)
    fleet_cv_raw: float           # CV with all inverters
    fleet_cv_clean: float         # CV after removing outliers
    n_outliers: int               # Number of faulty inverters
    outlier_inverters: List[str]  # IDs of faulty inverters

    # Soiling estimate (from healthy fleet)
    fleet_mean_deviation_pct: float  # Mean deviation from expected (soiling proxy)
    soiling_detected: bool           # True if uniform loss > threshold

    # Fault estimate (from outliers)
    faults_detected: bool            # True if any outliers found
    fault_severity_pct: float        # Average outlier deviation


def analyze_fleet_with_fault_separation(
    df: pd.DataFrame,
    power_col: str = "power_actual",
    expected_power_col: str = "power_expected",
    inverter_col: str = "inverter_id",
    outlier_threshold_sigma: float = 2.0,
    soiling_threshold_pct: float = 2.0,
) -> FleetAnalysisResult:
    """Analyze fleet separating soiling (uniform) from faults (outliers).

    Algorithm:
    1. Compute each inverter's deviation from expected power
    2. Identify outliers (>2σ from fleet median)
    3. Remove outliers, compute CV on "healthy" fleet
    4. Healthy fleet's mean deviation = soiling estimate
    5. Outliers' deviation = fault severity

    This handles simultaneous soiling + faults:
    - Soiling affects ALL inverters uniformly → low clean CV, non-zero mean deviation
    - Faults affect SOME inverters → identified as outliers, removed before soiling estimate

    Args:
        df: DataFrame with all inverters
        power_col: Actual power column
        expected_power_col: Expected/physics power column (optional)
        inverter_col: Inverter ID column
        outlier_threshold_sigma: Standard deviations for outlier detection
        soiling_threshold_pct: Minimum mean deviation to flag soiling

    Returns:
        FleetAnalysisResult with separated soiling and fault estimates
    """
    # Compute per-inverter totals
    inv_power = df.groupby(inverter_col)[power_col].sum()

    # If we have expected power, use deviation from expected
    # Otherwise, use deviation from fleet median
    if expected_power_col in df.columns:
        inv_expected = df.groupby(inverter_col)[expected_power_col].sum()
        inv_deviation_pct = (inv_expected - inv_power) / inv_expected * 100
    else:
        fleet_median = inv_power.median()
        inv_deviation_pct = (fleet_median - inv_power) / fleet_median * 100

    # Fleet statistics
    fleet_mean = inv_deviation_pct.median()  # Use median for robustness
    fleet_std = inv_deviation_pct.std()

    # Identify outliers (deviating >2σ from fleet median)
    z_scores = (inv_deviation_pct - fleet_mean) / fleet_std if fleet_std > 0 else pd.Series(0, index=inv_deviation_pct.index)
    outlier_mask = z_scores.abs() > outlier_threshold_sigma
    outlier_inverters = inv_deviation_pct[outlier_mask].index.tolist()
    n_outliers = len(outlier_inverters)

    # Raw CV (all inverters)
    cv_raw = inv_power.std() / inv_power.mean() * 100 if inv_power.mean() > 0 else 0

    # Clean CV (healthy fleet only)
    healthy_power = inv_power[~outlier_mask]
    if len(healthy_power) > 1:
        cv_clean = healthy_power.std() / healthy_power.mean() * 100 if healthy_power.mean() > 0 else 0
    else:
        cv_clean = cv_raw  # Can't compute if too few inverters

    # Soiling estimate: mean deviation of healthy fleet
    healthy_deviation = inv_deviation_pct[~outlier_mask]
    fleet_mean_deviation = healthy_deviation.mean() if len(healthy_deviation) > 0 else 0
    soiling_detected = fleet_mean_deviation > soiling_threshold_pct

    # Fault severity: average deviation of outliers beyond fleet mean
    if n_outliers > 0:
        outlier_deviation = inv_deviation_pct[outlier_mask]
        fault_severity = (outlier_deviation - fleet_mean_deviation).mean()
        faults_detected = True
    else:
        fault_severity = 0.0
        faults_detected = False

    return FleetAnalysisResult(
        fleet_cv_raw=float(cv_raw),
        fleet_cv_clean=float(cv_clean),
        n_outliers=n_outliers,
        outlier_inverters=outlier_inverters,
        fleet_mean_deviation_pct=float(fleet_mean_deviation),
        soiling_detected=soiling_detected,
        faults_detected=faults_detected,
        fault_severity_pct=float(fault_severity),
    )
