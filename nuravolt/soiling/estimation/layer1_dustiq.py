"""
Layer 1: DustIQ Sensor-based SR Estimation.

This is the highest confidence layer, using direct sensor measurements.
DustIQ sensors provide ground truth soiling ratio values that other
layers are validated against.

Data source: public/data/soiling/{plant_id}/dustiq_history.json

Quality monitoring features:
- Calibration drift detection
- Measurement gap identification
- Invalid reading tracking (SR > 1.02 or < 0.70)
- Automated quality scoring and recommendations
"""

import json
from dataclasses import dataclass, field
from datetime import datetime, date
from pathlib import Path
from typing import Optional, List, Tuple

import numpy as np
import pandas as pd

from .base import (
    EstimationLayer,
    MethodAvailability,
    SREstimationResult,
    SREstimator,
    create_confidence_series,
    LAYER_CONFIDENCE,
)


# Known DustIQ-equipped plants
DUSTIQ_PLANTS = ["epsilon", "zeta"]

# Path to soiling data
DEFAULT_DATA_DIR = Path("public/data/soiling")


class DustIQEstimator(SREstimator):
    """Layer 1: Direct DustIQ sensor measurement.

    Uses DustIQ sensor data as ground truth SR values.
    This is the highest confidence estimation method.

    Attributes
    ----------
    data_dir : Path
        Directory containing plant soiling data
    """

    def __init__(self, data_dir: Optional[Path] = None):
        """Initialize DustIQ estimator.

        Parameters
        ----------
        data_dir : Path, optional
            Directory containing plant soiling data.
            Defaults to public/data/soiling
        """
        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self._cache = {}

    @property
    def layer(self) -> EstimationLayer:
        return EstimationLayer.DUSTIQ

    @property
    def method_name(self) -> str:
        return "dustiq"

    def _get_dustiq_path(self, plant_id: str) -> Path:
        """Get path to DustIQ data file for a plant."""
        return self.data_dir / plant_id / "dustiq_history.json"

    def _load_dustiq_data(self, plant_id: str) -> Optional[pd.DataFrame]:
        """Load DustIQ data for a plant.

        Returns
        -------
        pd.DataFrame or None
            DataFrame with columns: date, sr_dustiq, sr_min, sr_max, measurement_count
        """
        if plant_id in self._cache:
            return self._cache[plant_id]

        dustiq_path = self._get_dustiq_path(plant_id)
        if not dustiq_path.exists():
            return None

        try:
            with open(dustiq_path) as f:
                data = json.load(f)

            daily_data = data.get("daily_data", [])
            if not daily_data:
                return None

            df = pd.DataFrame(daily_data)
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()

            # Cache for future use
            self._cache[plant_id] = df
            return df

        except (json.JSONDecodeError, KeyError) as e:
            print(f"Error loading DustIQ data for {plant_id}: {e}")
            return None

    def check_availability(self, plant_id: str) -> MethodAvailability:
        """Check if DustIQ data is available for this plant.

        Parameters
        ----------
        plant_id : str
            Plant identifier

        Returns
        -------
        MethodAvailability
            Availability status with reason and expected confidence
        """
        df = self._load_dustiq_data(plant_id)

        if df is None or len(df) == 0:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"No DustIQ sensor data found for {plant_id}",
                confidence=0,
                data_days_available=0,
                data_days_required=1,
            )

        # Check data recency (within last 30 days)
        latest_date = df.index.max()
        days_since_latest = (pd.Timestamp.now() - latest_date).days
        is_recent = days_since_latest <= 30

        # Adjust confidence based on recency
        base_conf = LAYER_CONFIDENCE[self.layer]
        if days_since_latest > 7:
            confidence = max(base_conf - 10, 70)  # Reduce confidence for stale data
        else:
            confidence = base_conf

        return MethodAvailability(
            method=self.method_name,
            layer=self.layer,
            is_available=True,
            reason=f"DustIQ sensor data available ({len(df)} days, latest: {latest_date.strftime('%Y-%m-%d')})",
            confidence=confidence,
            data_days_available=len(df),
            data_days_required=1,
        )

    def estimate(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> SREstimationResult:
        """Get SR values from DustIQ sensor data.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        start_date : str, optional
            Start date (YYYY-MM-DD)
        end_date : str, optional
            End date (YYYY-MM-DD)

        Returns
        -------
        SREstimationResult
            Estimation results with SR values and confidence
        """
        df = self._load_dustiq_data(plant_id)

        if df is None:
            raise ValueError(f"No DustIQ data available for {plant_id}")

        # Filter by date range
        if start_date:
            df = df[df.index >= pd.Timestamp(start_date)]
        if end_date:
            df = df[df.index <= pd.Timestamp(end_date)]

        if len(df) == 0:
            raise ValueError(f"No DustIQ data in specified date range for {plant_id}")

        # Extract SR values
        sr_values = df["sr_dustiq"].copy()
        sr_values.name = "sr"

        # Calculate confidence based on measurement count and data quality
        base_conf = LAYER_CONFIDENCE[self.layer]
        confidence = self._calculate_confidence(df, base_conf)

        return SREstimationResult(
            sr_values=sr_values,
            confidence=confidence,
            method=self.method_name,
            layer=self.layer,
            metadata={
                "source": "dustiq_sensor",
                "plant_id": plant_id,
                "n_days": len(df),
                "date_range": {
                    "start": df.index.min().strftime("%Y-%m-%d"),
                    "end": df.index.max().strftime("%Y-%m-%d"),
                },
                "avg_measurements_per_day": float(df["measurement_count"].mean()),
            },
        )

    def _calculate_confidence(self, df: pd.DataFrame, base_conf: int) -> pd.Series:
        """Calculate confidence scores based on measurement quality.

        Parameters
        ----------
        df : pd.DataFrame
            DustIQ data with measurement_count column
        base_conf : int
            Base confidence level (0-100)

        Returns
        -------
        pd.Series
            Confidence values indexed by date
        """
        # Confidence adjustments based on measurement count
        # More measurements = higher confidence
        counts = df["measurement_count"]
        count_factor = np.minimum(counts / 48, 1.0)  # 48 = measurements for 8h of sun

        # Adjust for SR range (wide range = lower confidence)
        sr_range = df["sr_max"] - df["sr_min"]
        range_factor = 1 - np.minimum(sr_range / 0.1, 0.2)  # Max 20% reduction

        confidence = base_conf * count_factor * range_factor
        confidence = np.clip(confidence, 50, 100)

        return pd.Series(confidence, index=df.index, name="confidence")

    def get_latest_sr(self, plant_id: str) -> Optional[float]:
        """Get the most recent SR value for a plant.

        Parameters
        ----------
        plant_id : str
            Plant identifier

        Returns
        -------
        float or None
            Latest SR value, or None if not available
        """
        df = self._load_dustiq_data(plant_id)
        if df is None or len(df) == 0:
            return None

        return float(df["sr_dustiq"].iloc[-1])

    @classmethod
    def get_dustiq_plants(cls) -> list:
        """Get list of plants with DustIQ sensors."""
        return DUSTIQ_PLANTS.copy()


# =============================================================================
# DustIQ Quality Monitoring
# =============================================================================

# Quality thresholds
SR_MIN_VALID = 0.70   # Below = data error
SR_MAX_VALID = 1.02   # Above = sensor malfunction
DRIFT_THRESHOLD = 0.001  # SR/week slope indicating drift


@dataclass
class DustIQQualityReport:
    """Quality report for DustIQ sensor data.

    Provides automated quality assessment and recommendations for
    DustIQ sensor maintenance and recalibration.
    """

    plant_id: str
    date_range: Tuple[date, date]
    total_days: int
    valid_days: int

    # Data quality metrics
    invalid_high_pct: float  # % of days with SR > 1.02
    invalid_low_pct: float   # % of days with SR < 0.70
    missing_pct: float       # % of expected days with no data

    # Calibration metrics
    calibration_drift: bool
    drift_rate_per_week: float  # SR units per week (+ = increasing)
    mean_sr: float
    sr_std: float

    # Gap analysis
    measurement_gaps: List[Tuple[date, date]] = field(default_factory=list)
    longest_gap_days: int = 0

    # Overall assessment
    confidence_score: float = 100.0  # 0-100
    quality_grade: str = "A"  # A, B, C, D, F
    recommended_action: str = "No action required"
    issues: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            'plant_id': self.plant_id,
            'date_range': {
                'start': self.date_range[0].isoformat(),
                'end': self.date_range[1].isoformat(),
            },
            'data_coverage': {
                'total_days': self.total_days,
                'valid_days': self.valid_days,
                'invalid_high_pct': round(self.invalid_high_pct, 2),
                'invalid_low_pct': round(self.invalid_low_pct, 2),
                'missing_pct': round(self.missing_pct, 2),
            },
            'calibration': {
                'drift_detected': self.calibration_drift,
                'drift_rate_per_week': round(self.drift_rate_per_week, 5),
                'mean_sr': round(self.mean_sr, 4),
                'sr_std': round(self.sr_std, 4),
            },
            'gaps': {
                'count': len(self.measurement_gaps),
                'longest_days': self.longest_gap_days,
                'details': [
                    {'start': g[0].isoformat(), 'end': g[1].isoformat()}
                    for g in self.measurement_gaps[:5]  # Limit to 5
                ],
            },
            'assessment': {
                'confidence_score': round(self.confidence_score, 1),
                'quality_grade': self.quality_grade,
                'recommended_action': self.recommended_action,
                'issues': self.issues,
            },
        }


class DustIQQualityMonitor:
    """Monitor and assess DustIQ sensor data quality.

    Detects common DustIQ issues:
    1. Calibration drift (SR trending away from expected)
    2. Invalid readings (SR > 1.02 or < 0.70)
    3. Measurement gaps (missing days)
    4. Low measurement counts per day
    5. Excessive variance (unstable readings)

    Example:
        monitor = DustIQQualityMonitor()
        report = monitor.generate_report("epsilon", days=90)
        print(f"Quality grade: {report.quality_grade}")
        print(f"Action: {report.recommended_action}")
    """

    def __init__(
        self,
        estimator: Optional[DustIQEstimator] = None,
        sr_min_valid: float = SR_MIN_VALID,
        sr_max_valid: float = SR_MAX_VALID,
        drift_threshold: float = DRIFT_THRESHOLD,
    ):
        """Initialize quality monitor.

        Args:
            estimator: DustIQ estimator instance (creates new if not provided)
            sr_min_valid: Minimum valid SR value
            sr_max_valid: Maximum valid SR value
            drift_threshold: Drift rate threshold (SR/week)
        """
        self.estimator = estimator or DustIQEstimator()
        self.sr_min_valid = sr_min_valid
        self.sr_max_valid = sr_max_valid
        self.drift_threshold = drift_threshold

    def generate_report(
        self,
        plant_id: str,
        days: int = 90,
        end_date: Optional[date] = None,
    ) -> DustIQQualityReport:
        """Generate quality report for a plant's DustIQ data.

        Args:
            plant_id: Plant identifier
            days: Number of days to analyze
            end_date: End date for analysis (default: today)

        Returns:
            DustIQQualityReport with quality assessment
        """
        # Load data
        df = self.estimator._load_dustiq_data(plant_id)

        if df is None or len(df) == 0:
            return DustIQQualityReport(
                plant_id=plant_id,
                date_range=(date.today(), date.today()),
                total_days=0,
                valid_days=0,
                invalid_high_pct=0,
                invalid_low_pct=0,
                missing_pct=100,
                calibration_drift=False,
                drift_rate_per_week=0,
                mean_sr=0,
                sr_std=0,
                confidence_score=0,
                quality_grade="F",
                recommended_action="CRITICAL: No DustIQ data available",
                issues=["No sensor data found"],
            )

        # Filter to date range
        if end_date is None:
            end_date = df.index.max().date()

        start_date = end_date - pd.Timedelta(days=days)
        df = df[(df.index >= pd.Timestamp(start_date)) &
                (df.index <= pd.Timestamp(end_date))]

        if len(df) == 0:
            return DustIQQualityReport(
                plant_id=plant_id,
                date_range=(start_date, end_date),
                total_days=days,
                valid_days=0,
                invalid_high_pct=0,
                invalid_low_pct=0,
                missing_pct=100,
                calibration_drift=False,
                drift_rate_per_week=0,
                mean_sr=0,
                sr_std=0,
                confidence_score=0,
                quality_grade="F",
                recommended_action="CRITICAL: No data in specified period",
                issues=["No data in analysis period"],
            )

        # Calculate metrics
        sr = df['sr_dustiq']
        total_days = days
        valid_days = len(df)
        missing_pct = (1 - valid_days / total_days) * 100

        # Invalid readings
        invalid_high = (sr > self.sr_max_valid).sum()
        invalid_low = (sr < self.sr_min_valid).sum()
        invalid_high_pct = (invalid_high / len(df)) * 100 if len(df) > 0 else 0
        invalid_low_pct = (invalid_low / len(df)) * 100 if len(df) > 0 else 0

        # Calibration drift detection
        drift_rate, calibration_drift = self._detect_drift(sr)

        # Gap detection
        gaps = self._find_gaps(df.index, min_gap_days=3)
        longest_gap = max((g[1] - g[0]).days for g in gaps) if gaps else 0

        # Mean and std
        valid_sr = sr[(sr >= self.sr_min_valid) & (sr <= self.sr_max_valid)]
        mean_sr = valid_sr.mean() if len(valid_sr) > 0 else 0
        sr_std = valid_sr.std() if len(valid_sr) > 0 else 0

        # Compute confidence score and grade
        confidence_score, issues = self._compute_confidence(
            invalid_high_pct=invalid_high_pct,
            invalid_low_pct=invalid_low_pct,
            missing_pct=missing_pct,
            calibration_drift=calibration_drift,
            sr_std=sr_std,
            longest_gap=longest_gap,
        )

        quality_grade = self._score_to_grade(confidence_score)
        recommended_action = self._determine_action(
            confidence_score, issues, calibration_drift
        )

        return DustIQQualityReport(
            plant_id=plant_id,
            date_range=(start_date, end_date),
            total_days=total_days,
            valid_days=valid_days,
            invalid_high_pct=invalid_high_pct,
            invalid_low_pct=invalid_low_pct,
            missing_pct=missing_pct,
            calibration_drift=calibration_drift,
            drift_rate_per_week=drift_rate,
            mean_sr=mean_sr,
            sr_std=sr_std,
            measurement_gaps=gaps,
            longest_gap_days=longest_gap,
            confidence_score=confidence_score,
            quality_grade=quality_grade,
            recommended_action=recommended_action,
            issues=issues,
        )

    def check_all_plants(self, days: int = 90) -> pd.DataFrame:
        """Generate quality summary for all DustIQ plants.

        Args:
            days: Number of days to analyze

        Returns:
            DataFrame with quality summary per plant
        """
        results = []
        for plant_id in DUSTIQ_PLANTS:
            report = self.generate_report(plant_id, days=days)
            results.append({
                'plant_id': plant_id,
                'quality_grade': report.quality_grade,
                'confidence_score': report.confidence_score,
                'valid_days': report.valid_days,
                'invalid_pct': report.invalid_high_pct + report.invalid_low_pct,
                'drift_detected': report.calibration_drift,
                'recommended_action': report.recommended_action,
            })

        return pd.DataFrame(results)

    def _detect_drift(self, sr: pd.Series) -> Tuple[float, bool]:
        """Detect calibration drift in SR timeseries.

        Args:
            sr: Soiling ratio series with datetime index

        Returns:
            Tuple of (drift_rate_per_week, is_drifting)
        """
        if len(sr) < 14:  # Need at least 2 weeks
            return 0.0, False

        # Weekly mean to reduce noise
        weekly = sr.resample('W').mean().dropna()
        if len(weekly) < 2:
            return 0.0, False

        # Linear regression
        x = np.arange(len(weekly))
        y = weekly.values

        try:
            slope, intercept = np.polyfit(x, y, 1)
            drift_rate = float(slope)  # SR units per week
            is_drifting = abs(drift_rate) > self.drift_threshold
            return drift_rate, is_drifting
        except Exception:
            return 0.0, False

    def _find_gaps(
        self,
        dates: pd.DatetimeIndex,
        min_gap_days: int = 3,
    ) -> List[Tuple[date, date]]:
        """Find gaps in measurement dates.

        Args:
            dates: DatetimeIndex of measurements
            min_gap_days: Minimum gap size to report

        Returns:
            List of (start, end) tuples for each gap
        """
        if len(dates) < 2:
            return []

        gaps = []
        dates_sorted = dates.sort_values()

        for i in range(1, len(dates_sorted)):
            gap_days = (dates_sorted[i] - dates_sorted[i-1]).days
            if gap_days > min_gap_days:
                gap_start = dates_sorted[i-1].date() + pd.Timedelta(days=1)
                gap_end = dates_sorted[i].date() - pd.Timedelta(days=1)
                gaps.append((gap_start, gap_end))

        return gaps

    def _compute_confidence(
        self,
        invalid_high_pct: float,
        invalid_low_pct: float,
        missing_pct: float,
        calibration_drift: bool,
        sr_std: float,
        longest_gap: int,
    ) -> Tuple[float, List[str]]:
        """Compute confidence score and identify issues.

        Returns:
            Tuple of (confidence_score, list_of_issues)
        """
        score = 100.0
        issues = []

        # Invalid high readings (SR > 1.02)
        if invalid_high_pct > 10:
            score -= 25
            issues.append(f"High invalid readings ({invalid_high_pct:.1f}% > 1.02)")
        elif invalid_high_pct > 5:
            score -= 15
            issues.append(f"Elevated invalid readings ({invalid_high_pct:.1f}% > 1.02)")
        elif invalid_high_pct > 1:
            score -= 5

        # Invalid low readings (SR < 0.70)
        if invalid_low_pct > 10:
            score -= 25
            issues.append(f"High invalid low readings ({invalid_low_pct:.1f}% < 0.70)")
        elif invalid_low_pct > 5:
            score -= 15
            issues.append(f"Elevated invalid low readings ({invalid_low_pct:.1f}% < 0.70)")
        elif invalid_low_pct > 1:
            score -= 5

        # Missing data
        if missing_pct > 30:
            score -= 20
            issues.append(f"Significant data gaps ({missing_pct:.1f}% missing)")
        elif missing_pct > 15:
            score -= 10
            issues.append(f"Data gaps present ({missing_pct:.1f}% missing)")
        elif missing_pct > 5:
            score -= 5

        # Calibration drift
        if calibration_drift:
            score -= 15
            issues.append("Calibration drift detected")

        # High variance
        if sr_std > 0.05:
            score -= 10
            issues.append(f"High variance (std={sr_std:.3f})")
        elif sr_std > 0.03:
            score -= 5

        # Long gaps
        if longest_gap > 14:
            score -= 10
            issues.append(f"Long measurement gap ({longest_gap} days)")
        elif longest_gap > 7:
            score -= 5

        return max(0, score), issues

    def _score_to_grade(self, score: float) -> str:
        """Convert confidence score to letter grade."""
        if score >= 90:
            return "A"
        elif score >= 80:
            return "B"
        elif score >= 70:
            return "C"
        elif score >= 50:
            return "D"
        else:
            return "F"

    def _determine_action(
        self,
        score: float,
        issues: List[str],
        calibration_drift: bool,
    ) -> str:
        """Determine recommended action based on issues."""
        if score < 50:
            return "URGENT: Sensor recalibration or replacement required"
        elif score < 70:
            return "Schedule maintenance check within 2 weeks"
        elif calibration_drift:
            return "Monitor for continued drift; schedule inspection if trend continues"
        elif issues:
            return "Minor issues detected; continue monitoring"
        else:
            return "No action required"


def load_dustiq_history(
    plant_id: str,
    days: Optional[int] = None,
) -> Optional[pd.DataFrame]:
    """Convenience function to load DustIQ history.

    Args:
        plant_id: Plant identifier
        days: Optional limit on number of days

    Returns:
        DataFrame with DustIQ data or None
    """
    estimator = DustIQEstimator()
    df = estimator._load_dustiq_data(plant_id)

    if df is None:
        return None

    if days is not None:
        cutoff = df.index.max() - pd.Timedelta(days=days)
        df = df[df.index >= cutoff]

    return df
