"""
Smoothed Anomaly Detector for Digital Twin Residuals

Implements 24-hour rolling window anomaly detection to reduce noise:
- Smooths residuals over 24-hour window
- Requires sustained deviation (not transient spikes)
- 2-sigma threshold by default
- Minimum 24-hour duration to confirm anomaly

Features:
- Real-time anomaly detection on streaming data
- Confidence scoring for anomaly severity
- Root cause classification hints
- JSON export for dashboard alerts
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime, timedelta
from pathlib import Path
import json
import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class AnomalyConfig:
    """Configuration for anomaly detection."""
    # Smoothing
    window_hours: int = 24              # Rolling window for smoothing
    min_samples: int = 48               # Minimum samples in window (15-min data = 96/day)

    # Thresholds
    threshold_sigma: float = 2.0        # Standard deviations for anomaly
    threshold_pct: float = 0.10         # Alternative: 10% deviation threshold

    # Duration requirements
    min_duration_hours: int = 24        # Minimum hours to confirm anomaly

    # Filtering
    min_irradiance: float = 100.0       # Only daylight hours (W/m²)
    min_expected_power: float = 0.5     # Minimum expected power (kW)

    # Classification
    classify_root_cause: bool = True


@dataclass
class AnomalyPeriod:
    """Detected anomaly period."""
    start: datetime
    end: datetime
    duration_hours: float
    severity: str                       # "Minor", "Major", "Critical"
    anomaly_type: str                   # "underperformance", "overperformance"
    mean_residual_kw: float
    mean_relative_residual: float       # As fraction (-0.15 = 15% under)
    max_residual_kw: float
    confidence: float                   # 0-1
    root_cause_hint: Optional[str] = None
    affected_samples: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "start": self.start.isoformat() if isinstance(self.start, datetime) else str(self.start)[:19],
            "end": self.end.isoformat() if isinstance(self.end, datetime) else str(self.end)[:19],
            "durationHours": round(self.duration_hours, 1),
            "severity": self.severity,
            "type": self.anomaly_type,
            "meanResidual_kW": round(self.mean_residual_kw, 2),
            "meanRelativeResidual_pct": round(self.mean_relative_residual * 100, 1),
            "maxResidual_kW": round(self.max_residual_kw, 2),
            "confidence": round(self.confidence, 2),
            "rootCauseHint": self.root_cause_hint,
            "affectedSamples": self.affected_samples,
        }


@dataclass
class InverterAnomalyResult:
    """Anomaly detection result for single inverter."""
    inverter_id: str
    total_anomalies: int = 0
    anomaly_periods: List[AnomalyPeriod] = field(default_factory=list)
    anomaly_rate_pct: float = 0.0       # Percent of time in anomaly state
    total_energy_loss_kwh: float = 0.0  # Estimated loss from anomalies
    latest_status: str = "Normal"       # Current status
    latest_residual_kw: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "inverterId": self.inverter_id,
            "totalAnomalies": self.total_anomalies,
            "anomalyRate_pct": round(self.anomaly_rate_pct, 2),
            "totalEnergyLoss_kWh": round(self.total_energy_loss_kwh, 1),
            "latestStatus": self.latest_status,
            "latestResidual_kW": round(self.latest_residual_kw, 2),
            "periods": [p.to_dict() for p in self.anomaly_periods[-10:]],  # Last 10
        }


class SmoothedAnomalyDetector:
    """
    24-hour smoothed anomaly detector for digital twin residuals.

    Uses rolling window averaging to filter out noise and detect
    sustained performance deviations that indicate real issues.
    """

    def __init__(self, config: Optional[AnomalyConfig] = None):
        """
        Initialize detector.

        Parameters:
        -----------
        config : AnomalyConfig
            Detection configuration
        """
        self.config = config or AnomalyConfig()

        # Results storage
        self.results: Dict[str, InverterAnomalyResult] = {}

    def detect_anomalies(
        self,
        residuals_df: pd.DataFrame,
        irradiance: Optional[pd.Series] = None,
        expected_power: Optional[pd.Series] = None,
    ) -> InverterAnomalyResult:
        """
        Detect anomalies in residual time series.

        Parameters:
        -----------
        residuals_df : pd.DataFrame
            DataFrame with columns: expected_kW, actual_kW, residual_kW, relative_residual
        irradiance : pd.Series
            Optional irradiance for daylight filtering
        expected_power : pd.Series
            Optional expected power for filtering

        Returns:
        --------
        InverterAnomalyResult
            Detection result with anomaly periods
        """
        # Get inverter ID from column if available
        inverter_id = getattr(residuals_df, 'name', 'unknown') or 'unknown'

        result = InverterAnomalyResult(inverter_id=inverter_id)

        # Ensure datetime index
        if not isinstance(residuals_df.index, pd.DatetimeIndex):
            try:
                residuals_df.index = pd.to_datetime(residuals_df.index)
            except Exception:
                logger.warning("Could not parse datetime index")
                return result

        # Filter for daylight hours if irradiance available
        if irradiance is not None:
            daylight_mask = irradiance > self.config.min_irradiance
            residuals_df = residuals_df[daylight_mask]

        # Filter for producing hours if expected power available
        if expected_power is not None:
            producing_mask = expected_power > self.config.min_expected_power
            residuals_df = residuals_df[producing_mask]
        elif 'expected_kW' in residuals_df.columns:
            producing_mask = residuals_df['expected_kW'] > self.config.min_expected_power
            residuals_df = residuals_df[producing_mask]

        if len(residuals_df) < self.config.min_samples:
            logger.warning(f"Insufficient data for anomaly detection: {len(residuals_df)} samples")
            return result

        # Get residual column
        if 'residual_kW' in residuals_df.columns:
            residuals = residuals_df['residual_kW']
        else:
            # Assume first column is residuals
            residuals = residuals_df.iloc[:, 0]

        # Get relative residuals if available
        if 'relative_residual' in residuals_df.columns:
            relative = residuals_df['relative_residual']
        else:
            # Calculate from absolute
            expected = residuals_df.get('expected_kW', pd.Series(1, index=residuals.index))
            relative = residuals / (expected + 0.01)

        # Apply smoothing
        smoothed_residuals = self._apply_smoothing(residuals)
        smoothed_relative = self._apply_smoothing(relative)

        # Calculate statistics on smoothed data
        mean_residual = smoothed_residuals.mean()
        std_residual = smoothed_residuals.std()

        # Detect threshold crossings
        threshold = self.config.threshold_sigma * std_residual

        # Anomaly mask (using negative threshold for underperformance)
        underperform_mask = smoothed_residuals < -threshold
        overperform_mask = smoothed_residuals > threshold

        # Group into periods
        anomaly_periods = []

        # Detect underperformance periods
        under_periods = self._identify_periods(
            underperform_mask, smoothed_residuals, smoothed_relative,
            anomaly_type="underperformance"
        )
        anomaly_periods.extend(under_periods)

        # Detect overperformance periods (less common, may indicate sensor issues)
        over_periods = self._identify_periods(
            overperform_mask, smoothed_residuals, smoothed_relative,
            anomaly_type="overperformance"
        )
        anomaly_periods.extend(over_periods)

        # Sort by start time
        anomaly_periods.sort(key=lambda p: p.start)

        # Calculate summary statistics
        result.total_anomalies = len(anomaly_periods)
        result.anomaly_periods = anomaly_periods

        # Calculate anomaly rate
        total_anomaly_samples = sum(p.affected_samples for p in anomaly_periods)
        result.anomaly_rate_pct = (total_anomaly_samples / len(residuals_df) * 100
                                   if len(residuals_df) > 0 else 0)

        # Estimate energy loss
        result.total_energy_loss_kwh = self._estimate_energy_loss(
            anomaly_periods, residuals_df
        )

        # Latest status
        result.latest_status = self._get_latest_status(smoothed_residuals, threshold)
        result.latest_residual_kw = smoothed_residuals.iloc[-1] if len(smoothed_residuals) > 0 else 0

        return result

    def _apply_smoothing(self, series: pd.Series) -> pd.Series:
        """Apply rolling window smoothing."""
        # Calculate window size in samples
        # Assuming 15-minute data: 4 samples/hour
        samples_per_hour = 4
        window_size = self.config.window_hours * samples_per_hour

        # Rolling mean with center=True for no lag
        smoothed = series.rolling(
            window=window_size,
            center=True,
            min_periods=self.config.min_samples
        ).mean()

        # Fill edges with non-centered rolling
        if smoothed.isna().any():
            edge_smooth = series.rolling(
                window=window_size // 2,
                min_periods=self.config.min_samples // 2
            ).mean()
            smoothed = smoothed.fillna(edge_smooth)

        return smoothed.ffill().bfill()

    def _identify_periods(
        self,
        anomaly_mask: pd.Series,
        residuals: pd.Series,
        relative: pd.Series,
        anomaly_type: str,
    ) -> List[AnomalyPeriod]:
        """Identify contiguous anomaly periods."""
        periods = []

        if not anomaly_mask.any():
            return periods

        # Group consecutive anomalies
        groups = (anomaly_mask != anomaly_mask.shift()).cumsum()
        anomaly_groups = anomaly_mask[anomaly_mask].groupby(groups)

        for group_id, group_data in anomaly_groups:
            indices = group_data.index

            if len(indices) < 2:
                continue

            start = indices.min()
            end = indices.max()

            # Calculate duration
            if isinstance(start, pd.Timestamp):
                duration_hours = (end - start).total_seconds() / 3600
            else:
                duration_hours = len(indices) * 0.25  # Assume 15-min data

            # Skip if too short
            if duration_hours < self.config.min_duration_hours:
                continue

            # Calculate statistics for this period
            period_residuals = residuals.loc[indices]
            period_relative = relative.loc[indices]

            mean_residual = period_residuals.mean()
            mean_relative = period_relative.mean()
            max_residual = period_residuals.abs().max()

            # Classify severity
            severity = self._classify_severity(mean_relative, duration_hours)

            # Calculate confidence
            confidence = self._calculate_confidence(
                len(indices), duration_hours, abs(mean_relative)
            )

            # Classify root cause
            root_cause = None
            if self.config.classify_root_cause:
                root_cause = self._classify_root_cause(
                    mean_relative, anomaly_type, duration_hours
                )

            period = AnomalyPeriod(
                start=start,
                end=end,
                duration_hours=duration_hours,
                severity=severity,
                anomaly_type=anomaly_type,
                mean_residual_kw=mean_residual,
                mean_relative_residual=mean_relative,
                max_residual_kw=max_residual,
                confidence=confidence,
                root_cause_hint=root_cause,
                affected_samples=len(indices),
            )
            periods.append(period)

        return periods

    def _classify_severity(
        self,
        mean_relative: float,
        duration_hours: float
    ) -> str:
        """Classify anomaly severity."""
        abs_relative = abs(mean_relative)

        # Critical: >30% deviation or long duration + high deviation
        if abs_relative > 0.30 or (duration_hours > 72 and abs_relative > 0.20):
            return "Critical"

        # Major: >20% deviation or long duration
        if abs_relative > 0.20 or (duration_hours > 48 and abs_relative > 0.15):
            return "Major"

        # Minor: all others that passed minimum threshold
        return "Minor"

    def _calculate_confidence(
        self,
        n_samples: int,
        duration_hours: float,
        abs_deviation: float
    ) -> float:
        """Calculate confidence in anomaly detection."""
        # More samples = higher confidence
        sample_factor = min(1.0, n_samples / 200)

        # Longer duration = higher confidence
        duration_factor = min(1.0, duration_hours / 72)

        # Higher deviation = higher confidence
        deviation_factor = min(1.0, abs_deviation / 0.20)

        # Weighted combination
        confidence = (
            sample_factor * 0.3 +
            duration_factor * 0.4 +
            deviation_factor * 0.3
        )

        return confidence

    def _classify_root_cause(
        self,
        mean_relative: float,
        anomaly_type: str,
        duration_hours: float
    ) -> str:
        """Classify likely root cause based on characteristics."""
        abs_relative = abs(mean_relative)

        if anomaly_type == "underperformance":
            if abs_relative > 0.20:
                if duration_hours < 48:
                    return "Possible shading or temporary obstruction"
                else:
                    return "Possible soiling accumulation or inverter degradation"
            elif abs_relative > 0.10:
                if duration_hours > 168:  # > 1 week
                    return "Gradual soiling buildup"
                else:
                    return "Partial shading or minor efficiency loss"
            else:
                return "Minor performance deviation"

        elif anomaly_type == "overperformance":
            return "Possible sensor calibration issue or data quality problem"

        return "Unknown"

    def _estimate_energy_loss(
        self,
        periods: List[AnomalyPeriod],
        residuals_df: pd.DataFrame
    ) -> float:
        """Estimate total energy loss from anomaly periods."""
        total_loss = 0.0

        for period in periods:
            if period.anomaly_type == "underperformance":
                # Loss = mean_residual * duration * samples_per_hour * interval_hours
                # For 15-min data: interval = 0.25 hours
                samples_per_hour = 4
                interval_hours = 0.25

                # Negative residual = actual < expected = loss
                loss_kw = abs(period.mean_residual_kw)
                loss_kwh = loss_kw * period.duration_hours

                total_loss += loss_kwh

        return total_loss

    def _get_latest_status(
        self,
        smoothed_residuals: pd.Series,
        threshold: float
    ) -> str:
        """Get latest status based on current residual."""
        if len(smoothed_residuals) == 0:
            return "Unknown"

        latest = smoothed_residuals.iloc[-1]

        if latest < -threshold:
            return "Underperforming"
        elif latest > threshold:
            return "Overperforming"
        else:
            return "Normal"

    def detect_fleet_anomalies(
        self,
        residuals_dict: Dict[str, pd.DataFrame],
        irradiance: Optional[pd.Series] = None,
    ) -> Dict[str, InverterAnomalyResult]:
        """
        Detect anomalies for entire fleet of inverters.

        Parameters:
        -----------
        residuals_dict : Dict[str, pd.DataFrame]
            Dictionary mapping inverter IDs to residual DataFrames
        irradiance : pd.Series
            Common irradiance series for all inverters

        Returns:
        --------
        Dict[str, InverterAnomalyResult]
            Results keyed by inverter ID
        """
        logger.info(f"Detecting anomalies for {len(residuals_dict)} inverters")

        for inv_id, residuals_df in residuals_dict.items():
            try:
                result = self.detect_anomalies(residuals_df, irradiance)
                result.inverter_id = inv_id
                self.results[inv_id] = result
            except Exception as e:
                logger.error(f"Error detecting anomalies for {inv_id}: {e}")
                self.results[inv_id] = InverterAnomalyResult(inverter_id=inv_id)

        # Log summary
        total_anomalies = sum(r.total_anomalies for r in self.results.values())
        critical = sum(
            1 for r in self.results.values()
            for p in r.anomaly_periods if p.severity == "Critical"
        )

        logger.info(f"Fleet anomaly detection complete: "
                   f"{total_anomalies} anomalies ({critical} critical)")

        return self.results

    def export_to_json(self, output_path: str) -> None:
        """Export anomaly results to JSON."""
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Summary
        summary = {
            "generatedAt": datetime.now().isoformat(),
            "config": {
                "windowHours": self.config.window_hours,
                "thresholdSigma": self.config.threshold_sigma,
                "minDurationHours": self.config.min_duration_hours,
            },
            "fleetSummary": {
                "totalInverters": len(self.results),
                "invertersWithAnomalies": sum(
                    1 for r in self.results.values() if r.total_anomalies > 0
                ),
                "totalAnomalies": sum(r.total_anomalies for r in self.results.values()),
                "criticalAnomalies": sum(
                    1 for r in self.results.values()
                    for p in r.anomaly_periods if p.severity == "Critical"
                ),
                "totalEnergyLoss_kWh": sum(
                    r.total_energy_loss_kwh for r in self.results.values()
                ),
            },
            "inverters": {
                inv_id: result.to_dict()
                for inv_id, result in self.results.items()
            },
        }

        with open(output_path, 'w') as f:
            json.dump(summary, f, indent=2)

        logger.info(f"Exported anomaly results to {output_path}")

    def get_active_alerts(self) -> List[Dict[str, Any]]:
        """Get list of current active alerts for dashboard."""
        alerts = []

        for inv_id, result in self.results.items():
            if result.latest_status != "Normal":
                # Check if currently in anomaly period
                for period in result.anomaly_periods:
                    # Check if period is recent (within last 24 hours)
                    if isinstance(period.end, datetime):
                        if (datetime.now() - period.end).total_seconds() < 86400:
                            alerts.append({
                                "inverterId": inv_id,
                                "status": result.latest_status,
                                "severity": period.severity,
                                "type": period.anomaly_type,
                                "residual_kW": result.latest_residual_kw,
                                "relativeLoss_pct": period.mean_relative_residual * 100,
                                "rootCauseHint": period.root_cause_hint,
                                "since": str(period.start)[:19],
                            })
                            break

        # Sort by severity
        severity_order = {"Critical": 0, "Major": 1, "Minor": 2}
        alerts.sort(key=lambda x: severity_order.get(x.get("severity", "Minor"), 3))

        return alerts
