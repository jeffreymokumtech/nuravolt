"""
AC-Side Fault Detection Module

Detects faults that DC-side twins cannot identify:
1. Efficiency drop - Inverter efficiency degradation
2. MPPT error - Maximum power point tracking failures
3. Grid sync - Grid frequency/voltage issues (when data available)
4. Clipping - Power limiting at high irradiance
5. Curtailment - Grid-forced power reduction
6. Compound - ML-based multi-variable anomaly detection
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import math

import numpy as np
import polars as pl

try:
    from sklearn.ensemble import IsolationForest
    from sklearn.preprocessing import StandardScaler
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

# Optional SHAP support for feature attribution
try:
    from nuravolt.ml_enhancements.feature_attribution import SHAPAttributor, FeatureAttribution
    HAS_SHAP = True
except ImportError:
    HAS_SHAP = False
    SHAPAttributor = None
    FeatureAttribution = None


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class ACFaultResult:
    """Result from AC-side fault detection."""

    fault_type: str  # efficiency_drop, mppt_error, grid_sync, clipping, curtailment, compound
    severity: str    # minor, moderate, major, critical
    confidence: float  # 0-1
    detected_at: datetime
    duration_minutes: float
    loss_kwh: float
    inverter_id: Optional[str] = None
    details: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "fault_type": self.fault_type,
            "severity": self.severity,
            "confidence": self.confidence,
            "detected_at": self.detected_at.isoformat() if self.detected_at else None,
            "duration_minutes": self.duration_minutes,
            "loss_kwh": self.loss_kwh,
            "inverter_id": self.inverter_id,
            "details": self.details,
        }


@dataclass
class CompoundFaultResult(ACFaultResult):
    """Extended result for compound ML-detected faults."""

    anomaly_score: float = 0.0
    contributing_factors: dict = field(default_factory=dict)
    interpretation: str = ""
    possible_causes: list = field(default_factory=list)

    # SHAP feature attribution (when available)
    shap_values: dict = field(default_factory=dict)  # Feature name -> SHAP value
    shap_explanation: str = ""  # Human-readable SHAP explanation


@dataclass
class DataAvailability:
    """Track which data columns are available."""

    has_p_ac: bool = False
    has_p_dc: bool = False
    has_mppt_current: bool = False
    has_mppt_voltage: bool = False
    has_grid_frequency: bool = False
    has_grid_voltage: bool = False
    has_irradiance: bool = False
    has_temperature: bool = False
    n_mppt_channels: int = 0

    def can_run_efficiency(self) -> bool:
        return self.has_p_ac and self.has_p_dc

    def can_run_mppt(self) -> bool:
        return self.has_mppt_current and self.n_mppt_channels >= 2

    def can_run_grid(self) -> bool:
        return self.has_grid_frequency or self.has_grid_voltage

    def can_run_clipping(self) -> bool:
        return self.has_p_ac and self.has_irradiance

    def can_run_curtailment(self) -> bool:
        return self.has_p_ac

    def can_run_compound(self) -> bool:
        # Need at least efficiency + one other signal
        return self.has_p_ac and (self.has_p_dc or self.has_irradiance)


# =============================================================================
# Thresholds Configuration
# =============================================================================

@dataclass
class ACFaultThresholds:
    """Configurable thresholds for AC fault detection."""

    # Efficiency thresholds (η = P_AC / P_DC)
    efficiency_minor: float = 0.96      # 96% - minor concern
    efficiency_moderate: float = 0.94   # 94% - investigate
    efficiency_major: float = 0.92      # 92% - significant issue
    efficiency_critical: float = 0.90   # 90% - immediate action
    efficiency_min_power_pu: float = 0.2  # Only check when power > 20% rated

    # MPPT thresholds
    mppt_imbalance_minor: float = 0.15   # 15% imbalance
    mppt_imbalance_major: float = 0.25   # 25% imbalance
    mppt_hunting_cv: float = 0.10        # CV > 10% = hunting

    # Grid thresholds (50Hz system)
    grid_freq_nominal: float = 50.0      # Hz
    grid_freq_tolerance: float = 0.5     # ±0.5 Hz normal
    grid_freq_warning: float = 0.3       # ±0.3 Hz warning for curtailment
    grid_voltage_min_pu: float = 0.9     # 90% = voltage sag
    grid_voltage_max_pu: float = 1.1     # 110% = voltage swell

    # Clipping thresholds
    clipping_power_pu: float = 0.95      # Power > 95% rated = potential clipping
    clipping_irradiance_min: float = 800  # Only check at high irradiance
    clipping_dp_dg_threshold: float = 0.1  # dP/dG < 0.1 = plateau

    # Curtailment thresholds
    curtailment_drop_pct: float = 0.15   # 15% sudden drop
    curtailment_min_duration_min: float = 5  # Minimum 5 min duration

    # Compound ML thresholds
    compound_minor_score: float = 0.65
    compound_moderate_score: float = 0.80
    compound_major_score: float = 0.90
    compound_contamination: float = 0.05  # Expected 5% anomalies


# =============================================================================
# Individual Fault Detectors
# =============================================================================

class EfficiencyDropDetector:
    """
    Detect inverter efficiency degradation.

    Method: η = P_AC / P_DC

    Normal: 96-98% at rated power
    Accounts for power-dependent efficiency curve.
    """

    def __init__(self, thresholds: ACFaultThresholds):
        self.thresholds = thresholds

    def detect(
        self,
        df: pl.DataFrame,
        p_ac_col: str = "P_AC",
        p_dc_col: str = "P_DC",
        rated_power_kw: float = 100.0,
        timestamp_col: str = "timestamp",
        inverter_id: Optional[str] = None,
    ) -> list[ACFaultResult]:
        """Detect efficiency drop events."""

        results = []

        # Filter to valid operating periods (power > min threshold)
        min_power = rated_power_kw * self.thresholds.efficiency_min_power_pu

        df_valid = df.filter(
            (pl.col(p_ac_col) > min_power) &
            (pl.col(p_dc_col) > min_power * 1.02)  # DC should be slightly higher
        )

        if df_valid.height == 0:
            return results

        # Calculate efficiency
        df_eff = df_valid.with_columns(
            (pl.col(p_ac_col) / pl.col(p_dc_col)).alias("efficiency")
        )

        # Expected efficiency based on power level (efficiency curve)
        # η(P) ≈ η_max × (1 - k × (1 - P/P_rated)²) where k ≈ 0.02
        df_eff = df_eff.with_columns(
            (0.97 * (1 - 0.02 * (1 - pl.col(p_ac_col) / rated_power_kw).pow(2)))
            .alias("expected_efficiency")
        )

        # Find periods where efficiency is below thresholds
        df_faults = df_eff.filter(
            pl.col("efficiency") < self.thresholds.efficiency_minor
        )

        if df_faults.height == 0:
            return results

        # Group consecutive fault periods
        fault_periods = self._group_consecutive_periods(
            df_faults,
            timestamp_col,
            p_ac_col,
            p_dc_col,
        )

        for period in fault_periods:
            avg_efficiency = period["avg_efficiency"]

            # Determine severity
            if avg_efficiency < self.thresholds.efficiency_critical:
                severity = "critical"
            elif avg_efficiency < self.thresholds.efficiency_major:
                severity = "major"
            elif avg_efficiency < self.thresholds.efficiency_moderate:
                severity = "moderate"
            else:
                severity = "minor"

            # Calculate energy loss
            # Loss = ∫(P_expected - P_actual) dt
            expected_power = period["avg_p_dc"] * period["avg_expected_eff"]
            actual_power = period["avg_p_ac"]
            duration_hours = period["duration_min"] / 60
            loss_kwh = max(0, (expected_power - actual_power) * duration_hours)

            results.append(ACFaultResult(
                fault_type="efficiency_drop",
                severity=severity,
                confidence=min(1.0, 0.7 + (self.thresholds.efficiency_minor - avg_efficiency) * 5),
                detected_at=period["start"],
                duration_minutes=period["duration_min"],
                loss_kwh=loss_kwh,
                inverter_id=inverter_id,
                details={
                    "avg_efficiency": round(avg_efficiency, 4),
                    "expected_efficiency": round(period["avg_expected_eff"], 4),
                    "efficiency_gap": round(period["avg_expected_eff"] - avg_efficiency, 4),
                    "avg_power_kw": round(period["avg_p_ac"], 2),
                    "n_samples": period["n_samples"],
                },
            ))

        return results

    def _group_consecutive_periods(
        self,
        df: pl.DataFrame,
        timestamp_col: str,
        p_ac_col: str,
        p_dc_col: str,
    ) -> list[dict]:
        """Group consecutive fault samples into periods."""

        periods = []

        if df.height == 0:
            return periods

        # Sort by timestamp
        df = df.sort(timestamp_col)

        # Convert to numpy for easier processing
        timestamps = df[timestamp_col].to_numpy()
        efficiencies = df["efficiency"].to_numpy()
        expected_effs = df["expected_efficiency"].to_numpy()
        p_ac = df[p_ac_col].to_numpy()
        p_dc = df[p_dc_col].to_numpy()

        # Group consecutive samples (within 15 min gap)
        max_gap_seconds = 15 * 60

        period_start_idx = 0
        for i in range(1, len(timestamps)):
            gap = (timestamps[i] - timestamps[i-1]).astype('timedelta64[s]').astype(int)

            if gap > max_gap_seconds or i == len(timestamps) - 1:
                # End of period
                end_idx = i if i == len(timestamps) - 1 else i - 1

                if end_idx >= period_start_idx:
                    duration_sec = (timestamps[end_idx] - timestamps[period_start_idx]).astype('timedelta64[s]').astype(int)

                    periods.append({
                        "start": timestamps[period_start_idx],
                        "end": timestamps[end_idx],
                        "duration_min": max(1, duration_sec / 60),
                        "avg_efficiency": float(np.mean(efficiencies[period_start_idx:end_idx+1])),
                        "avg_expected_eff": float(np.mean(expected_effs[period_start_idx:end_idx+1])),
                        "avg_p_ac": float(np.mean(p_ac[period_start_idx:end_idx+1])),
                        "avg_p_dc": float(np.mean(p_dc[period_start_idx:end_idx+1])),
                        "n_samples": end_idx - period_start_idx + 1,
                    })

                period_start_idx = i

        return periods


class MPPTErrorDetector:
    """
    Detect MPPT tracking failures.

    Methods:
    1. Current imbalance across MPPTs
    2. Voltage deviation from expected MPP
    3. Hunting detection (oscillating voltage/current)
    """

    def __init__(self, thresholds: ACFaultThresholds):
        self.thresholds = thresholds

    def detect(
        self,
        df: pl.DataFrame,
        mppt_current_cols: list[str],
        mppt_voltage_cols: Optional[list[str]] = None,
        timestamp_col: str = "timestamp",
        irradiance_col: Optional[str] = None,
        inverter_id: Optional[str] = None,
    ) -> list[ACFaultResult]:
        """Detect MPPT tracking errors."""

        results = []

        if len(mppt_current_cols) < 2:
            return results

        # Calculate current imbalance
        df_mppt = df.select([timestamp_col] + mppt_current_cols)

        # Filter to periods with significant current
        min_current = 1.0  # At least 1A
        valid_filter = pl.lit(True)
        for col in mppt_current_cols:
            valid_filter = valid_filter & (pl.col(col) > min_current)

        df_mppt = df_mppt.filter(valid_filter)

        if df_mppt.height == 0:
            return results

        # Calculate imbalance: (max - min) / mean
        current_cols_expr = [pl.col(c) for c in mppt_current_cols]

        df_mppt = df_mppt.with_columns([
            pl.concat_list(current_cols_expr).list.mean().alias("current_mean"),
            pl.concat_list(current_cols_expr).list.max().alias("current_max"),
            pl.concat_list(current_cols_expr).list.min().alias("current_min"),
            pl.concat_list(current_cols_expr).list.std().alias("current_std"),
        ])

        df_mppt = df_mppt.with_columns([
            ((pl.col("current_max") - pl.col("current_min")) / pl.col("current_mean"))
            .alias("imbalance"),
            (pl.col("current_std") / pl.col("current_mean")).alias("current_cv"),
        ])

        # Detect imbalance faults
        df_imbalance = df_mppt.filter(
            pl.col("imbalance") > self.thresholds.mppt_imbalance_minor
        )

        if df_imbalance.height > 0:
            # Group into periods
            imbalance_periods = self._group_imbalance_periods(df_imbalance, timestamp_col)

            for period in imbalance_periods:
                if period["avg_imbalance"] > self.thresholds.mppt_imbalance_major:
                    severity = "major"
                else:
                    severity = "minor"

                results.append(ACFaultResult(
                    fault_type="mppt_error",
                    severity=severity,
                    confidence=min(1.0, 0.6 + period["avg_imbalance"]),
                    detected_at=period["start"],
                    duration_minutes=period["duration_min"],
                    loss_kwh=0,  # Hard to quantify without more data
                    inverter_id=inverter_id,
                    details={
                        "error_type": "imbalance",
                        "avg_imbalance_pct": round(period["avg_imbalance"] * 100, 1),
                        "n_mppt_channels": len(mppt_current_cols),
                        "n_samples": period["n_samples"],
                    },
                ))

        # Detect hunting (high CV over short rolling windows)
        if mppt_voltage_cols and len(mppt_voltage_cols) > 0:
            hunting_faults = self._detect_hunting(df, mppt_voltage_cols, timestamp_col, inverter_id)
            results.extend(hunting_faults)

        return results

    def _group_imbalance_periods(self, df: pl.DataFrame, timestamp_col: str) -> list[dict]:
        """Group consecutive imbalance samples."""

        periods = []

        if df.height == 0:
            return periods

        df = df.sort(timestamp_col)
        timestamps = df[timestamp_col].to_numpy()
        imbalances = df["imbalance"].to_numpy()

        max_gap_seconds = 15 * 60
        period_start_idx = 0

        for i in range(1, len(timestamps)):
            gap = (timestamps[i] - timestamps[i-1]).astype('timedelta64[s]').astype(int)

            if gap > max_gap_seconds or i == len(timestamps) - 1:
                end_idx = i if i == len(timestamps) - 1 else i - 1

                if end_idx >= period_start_idx:
                    duration_sec = (timestamps[end_idx] - timestamps[period_start_idx]).astype('timedelta64[s]').astype(int)

                    periods.append({
                        "start": timestamps[period_start_idx],
                        "end": timestamps[end_idx],
                        "duration_min": max(1, duration_sec / 60),
                        "avg_imbalance": float(np.mean(imbalances[period_start_idx:end_idx+1])),
                        "n_samples": end_idx - period_start_idx + 1,
                    })

                period_start_idx = i

        return periods

    def _detect_hunting(
        self,
        df: pl.DataFrame,
        voltage_cols: list[str],
        timestamp_col: str,
        inverter_id: Optional[str],
    ) -> list[ACFaultResult]:
        """Detect MPPT hunting (oscillating voltage)."""

        results = []

        # Calculate rolling CV of voltage (hunting = high short-term variance)
        window_size = 10  # 10 samples rolling window

        for v_col in voltage_cols:
            if v_col not in df.columns:
                continue

            df_v = df.select([timestamp_col, v_col]).drop_nulls()

            if df_v.height < window_size:
                continue

            # Calculate rolling std and mean
            df_v = df_v.with_columns([
                pl.col(v_col).rolling_std(window_size).alias("v_std"),
                pl.col(v_col).rolling_mean(window_size).alias("v_mean"),
            ])

            df_v = df_v.with_columns(
                (pl.col("v_std") / pl.col("v_mean")).alias("v_cv")
            )

            # Detect high CV periods
            df_hunting = df_v.filter(
                pl.col("v_cv") > self.thresholds.mppt_hunting_cv
            )

            if df_hunting.height > 5:  # At least 5 samples with hunting
                # Simplified: create one fault for the hunting period
                timestamps = df_hunting[timestamp_col].to_numpy()

                results.append(ACFaultResult(
                    fault_type="mppt_error",
                    severity="moderate",
                    confidence=0.7,
                    detected_at=timestamps[0],
                    duration_minutes=len(timestamps),  # Approximate
                    loss_kwh=0,
                    inverter_id=inverter_id,
                    details={
                        "error_type": "hunting",
                        "voltage_channel": v_col,
                        "avg_cv_pct": round(df_hunting["v_cv"].mean() * 100, 1),
                        "n_samples": df_hunting.height,
                    },
                ))

        return results


class GridSyncDetector:
    """
    Detect grid connection issues.

    Requires: Grid frequency and/or voltage data (often unavailable).
    """

    def __init__(self, thresholds: ACFaultThresholds):
        self.thresholds = thresholds

    def detect(
        self,
        df: pl.DataFrame,
        freq_col: Optional[str] = None,
        voltage_col: Optional[str] = None,
        voltage_nominal: float = 400.0,  # V
        timestamp_col: str = "timestamp",
        inverter_id: Optional[str] = None,
    ) -> list[ACFaultResult]:
        """Detect grid sync issues."""

        results = []

        # Frequency deviation
        if freq_col and freq_col in df.columns:
            freq_faults = self._detect_frequency_issues(
                df, freq_col, timestamp_col, inverter_id
            )
            results.extend(freq_faults)

        # Voltage deviation
        if voltage_col and voltage_col in df.columns:
            voltage_faults = self._detect_voltage_issues(
                df, voltage_col, voltage_nominal, timestamp_col, inverter_id
            )
            results.extend(voltage_faults)

        return results

    def _detect_frequency_issues(
        self,
        df: pl.DataFrame,
        freq_col: str,
        timestamp_col: str,
        inverter_id: Optional[str],
    ) -> list[ACFaultResult]:
        """Detect frequency deviation."""

        results = []

        df_freq = df.select([timestamp_col, freq_col]).drop_nulls()

        # Filter to out-of-range frequency
        nominal = self.thresholds.grid_freq_nominal
        tolerance = self.thresholds.grid_freq_tolerance

        df_fault = df_freq.filter(
            (pl.col(freq_col) < nominal - tolerance) |
            (pl.col(freq_col) > nominal + tolerance)
        )

        if df_fault.height > 0:
            timestamps = df_fault[timestamp_col].to_numpy()
            freqs = df_fault[freq_col].to_numpy()

            avg_deviation = np.mean(np.abs(freqs - nominal))

            if avg_deviation > 1.0:
                severity = "critical"
            elif avg_deviation > 0.7:
                severity = "major"
            else:
                severity = "moderate"

            results.append(ACFaultResult(
                fault_type="grid_sync",
                severity=severity,
                confidence=min(1.0, 0.6 + avg_deviation),
                detected_at=timestamps[0],
                duration_minutes=len(timestamps),
                loss_kwh=0,
                inverter_id=inverter_id,
                details={
                    "issue_type": "frequency_deviation",
                    "avg_frequency_hz": round(float(np.mean(freqs)), 2),
                    "avg_deviation_hz": round(avg_deviation, 2),
                    "n_samples": df_fault.height,
                },
            ))

        return results

    def _detect_voltage_issues(
        self,
        df: pl.DataFrame,
        voltage_col: str,
        voltage_nominal: float,
        timestamp_col: str,
        inverter_id: Optional[str],
    ) -> list[ACFaultResult]:
        """Detect voltage sag/swell."""

        results = []

        df_v = df.select([timestamp_col, voltage_col]).drop_nulls()

        # Calculate per-unit voltage
        df_v = df_v.with_columns(
            (pl.col(voltage_col) / voltage_nominal).alias("v_pu")
        )

        # Voltage sag (< 90%)
        df_sag = df_v.filter(pl.col("v_pu") < self.thresholds.grid_voltage_min_pu)

        if df_sag.height > 0:
            timestamps = df_sag[timestamp_col].to_numpy()

            results.append(ACFaultResult(
                fault_type="grid_sync",
                severity="major",
                confidence=0.8,
                detected_at=timestamps[0],
                duration_minutes=df_sag.height,
                loss_kwh=0,
                inverter_id=inverter_id,
                details={
                    "issue_type": "voltage_sag",
                    "min_voltage_pu": round(df_sag["v_pu"].min(), 3),
                    "avg_voltage_pu": round(df_sag["v_pu"].mean(), 3),
                    "n_samples": df_sag.height,
                },
            ))

        # Voltage swell (> 110%)
        df_swell = df_v.filter(pl.col("v_pu") > self.thresholds.grid_voltage_max_pu)

        if df_swell.height > 0:
            timestamps = df_swell[timestamp_col].to_numpy()

            results.append(ACFaultResult(
                fault_type="grid_sync",
                severity="major",
                confidence=0.8,
                detected_at=timestamps[0],
                duration_minutes=df_swell.height,
                loss_kwh=0,
                inverter_id=inverter_id,
                details={
                    "issue_type": "voltage_swell",
                    "max_voltage_pu": round(df_swell["v_pu"].max(), 3),
                    "avg_voltage_pu": round(df_swell["v_pu"].mean(), 3),
                    "n_samples": df_swell.height,
                },
            ))

        return results


class ClippingDetector:
    """
    Detect inverter clipping (power limiting at high irradiance).

    Method: AC power plateau detection when irradiance is high.
    """

    def __init__(self, thresholds: ACFaultThresholds):
        self.thresholds = thresholds

    def detect(
        self,
        df: pl.DataFrame,
        p_ac_col: str = "P_AC",
        irradiance_col: str = "irradiance",
        rated_power_kw: float = 100.0,
        timestamp_col: str = "timestamp",
        temp_col: Optional[str] = None,
        inverter_id: Optional[str] = None,
    ) -> list[ACFaultResult]:
        """Detect clipping events."""

        results = []

        # Filter to high irradiance periods
        df_high_g = df.filter(
            pl.col(irradiance_col) > self.thresholds.clipping_irradiance_min
        )

        if df_high_g.height < 5:
            return results

        # Calculate normalized power
        df_high_g = df_high_g.with_columns(
            (pl.col(p_ac_col) / rated_power_kw).alias("p_norm")
        )

        # Filter to periods near rated power
        df_clip = df_high_g.filter(
            pl.col("p_norm") > self.thresholds.clipping_power_pu
        )

        if df_clip.height < 3:
            return results

        # Calculate expected power without clipping
        # P_expected = G/1000 × P_stc × (1 - γ × (T - 25))
        gamma = 0.004  # Typical temp coefficient

        if temp_col and temp_col in df.columns:
            df_clip = df_clip.with_columns(
                (pl.col(irradiance_col) / 1000 * rated_power_kw *
                 (1 - gamma * (pl.col(temp_col) - 25))).alias("p_expected")
            )
        else:
            # Assume 40°C module temp at high irradiance
            df_clip = df_clip.with_columns(
                (pl.col(irradiance_col) / 1000 * rated_power_kw *
                 (1 - gamma * 15)).alias("p_expected")  # 40-25=15
            )

        # Calculate clipping loss
        df_clip = df_clip.with_columns(
            (pl.col("p_expected") - pl.col(p_ac_col)).clip(lower_bound=0).alias("clip_loss")
        )

        # Only count as clipping if there's actual loss
        df_clip = df_clip.filter(pl.col("clip_loss") > 0.5)  # > 0.5 kW loss

        if df_clip.height == 0:
            return results

        # Group clipping periods
        clip_periods = self._group_clipping_periods(
            df_clip, timestamp_col, "clip_loss"
        )

        for period in clip_periods:
            # Clipping is usually not a "fault" per se, but we report it
            if period["total_loss_kwh"] > 10:
                severity = "moderate"
            elif period["total_loss_kwh"] > 5:
                severity = "minor"
            else:
                severity = "minor"

            results.append(ACFaultResult(
                fault_type="clipping",
                severity=severity,
                confidence=0.95,  # Clipping is very detectable
                detected_at=period["start"],
                duration_minutes=period["duration_min"],
                loss_kwh=period["total_loss_kwh"],
                inverter_id=inverter_id,
                details={
                    "avg_clipped_power_kw": round(period["avg_clip_loss"], 2),
                    "peak_clipped_power_kw": round(period["max_clip_loss"], 2),
                    "avg_irradiance": round(period["avg_irradiance"], 0),
                    "n_samples": period["n_samples"],
                },
            ))

        return results

    def _group_clipping_periods(
        self,
        df: pl.DataFrame,
        timestamp_col: str,
        loss_col: str,
    ) -> list[dict]:
        """Group consecutive clipping samples."""

        periods = []

        if df.height == 0:
            return periods

        df = df.sort(timestamp_col)
        timestamps = df[timestamp_col].to_numpy()
        losses = df[loss_col].to_numpy()
        irradiances = df["irradiance"].to_numpy() if "irradiance" in df.columns else np.zeros(len(losses))

        max_gap_seconds = 15 * 60
        period_start_idx = 0

        for i in range(1, len(timestamps)):
            gap = (timestamps[i] - timestamps[i-1]).astype('timedelta64[s]').astype(int)

            if gap > max_gap_seconds or i == len(timestamps) - 1:
                end_idx = i if i == len(timestamps) - 1 else i - 1

                if end_idx >= period_start_idx:
                    duration_sec = (timestamps[end_idx] - timestamps[period_start_idx]).astype('timedelta64[s]').astype(int)
                    duration_hours = max(1, duration_sec) / 3600

                    avg_loss = float(np.mean(losses[period_start_idx:end_idx+1]))
                    total_loss = avg_loss * duration_hours

                    periods.append({
                        "start": timestamps[period_start_idx],
                        "end": timestamps[end_idx],
                        "duration_min": max(1, duration_sec / 60),
                        "avg_clip_loss": avg_loss,
                        "max_clip_loss": float(np.max(losses[period_start_idx:end_idx+1])),
                        "total_loss_kwh": total_loss,
                        "avg_irradiance": float(np.mean(irradiances[period_start_idx:end_idx+1])),
                        "n_samples": end_idx - period_start_idx + 1,
                    })

                period_start_idx = i

        return periods


class CurtailmentDetector:
    """
    Detect grid curtailment (forced power reduction).

    Methods:
    1. Frequency-triggered (if grid freq available)
    2. Export cap detection
    3. Pattern-based (sudden drop not explained by G/T/clouds)
    """

    def __init__(self, thresholds: ACFaultThresholds):
        self.thresholds = thresholds

    def detect(
        self,
        df: pl.DataFrame,
        p_ac_col: str = "P_AC",
        irradiance_col: Optional[str] = None,
        freq_col: Optional[str] = None,
        rated_power_kw: float = 100.0,
        timestamp_col: str = "timestamp",
        inverter_id: Optional[str] = None,
    ) -> list[ACFaultResult]:
        """Detect curtailment events."""

        results = []

        # Method 1: Frequency-triggered curtailment
        if freq_col and freq_col in df.columns:
            freq_results = self._detect_frequency_curtailment(
                df, p_ac_col, freq_col, rated_power_kw, timestamp_col, inverter_id
            )
            results.extend(freq_results)

        # Method 2: Export cap detection
        cap_results = self._detect_export_cap(
            df, p_ac_col, irradiance_col, rated_power_kw, timestamp_col, inverter_id
        )
        results.extend(cap_results)

        # Method 3: Pattern-based (sudden unexplained drop)
        if irradiance_col and irradiance_col in df.columns:
            pattern_results = self._detect_pattern_curtailment(
                df, p_ac_col, irradiance_col, rated_power_kw, timestamp_col, inverter_id
            )
            results.extend(pattern_results)

        return results

    def _detect_frequency_curtailment(
        self,
        df: pl.DataFrame,
        p_ac_col: str,
        freq_col: str,
        rated_power_kw: float,
        timestamp_col: str,
        inverter_id: Optional[str],
    ) -> list[ACFaultResult]:
        """Detect curtailment triggered by high grid frequency."""

        results = []

        nominal = self.thresholds.grid_freq_nominal
        warning = self.thresholds.grid_freq_warning

        # High frequency + power reduction
        df_curt = df.filter(
            (pl.col(freq_col) > nominal + warning) &
            (pl.col(p_ac_col) < rated_power_kw * 0.9)
        )

        if df_curt.height > 0:
            timestamps = df_curt[timestamp_col].to_numpy()

            results.append(ACFaultResult(
                fault_type="curtailment",
                severity="moderate",
                confidence=0.85,
                detected_at=timestamps[0],
                duration_minutes=df_curt.height,
                loss_kwh=0,  # Would need expected power to calculate
                inverter_id=inverter_id,
                details={
                    "trigger": "high_frequency",
                    "avg_frequency_hz": round(df_curt[freq_col].mean(), 2),
                    "avg_power_kw": round(df_curt[p_ac_col].mean(), 1),
                    "n_samples": df_curt.height,
                },
            ))

        return results

    def _detect_export_cap(
        self,
        df: pl.DataFrame,
        p_ac_col: str,
        irradiance_col: Optional[str],
        rated_power_kw: float,
        timestamp_col: str,
        inverter_id: Optional[str],
    ) -> list[ACFaultResult]:
        """Detect export cap (power capped at specific value)."""

        results = []

        # Look for power clustering at a specific value below rated
        # This indicates a hard export limit

        df_high_power = df.filter(
            pl.col(p_ac_col) > rated_power_kw * 0.7
        )

        if df_high_power.height < 10:
            return results

        powers = df_high_power[p_ac_col].to_numpy()

        # Check for clustering (low variance at specific power level)
        # If CV < 2% for extended period, likely capped
        power_cv = np.std(powers) / np.mean(powers)

        if power_cv < 0.02 and np.mean(powers) < rated_power_kw * 0.95:
            # Likely export cap
            cap_power = np.mean(powers)
            timestamps = df_high_power[timestamp_col].to_numpy()

            results.append(ACFaultResult(
                fault_type="curtailment",
                severity="minor",  # Export cap is intentional, not a fault
                confidence=0.7,
                detected_at=timestamps[0],
                duration_minutes=len(timestamps),
                loss_kwh=0,
                inverter_id=inverter_id,
                details={
                    "trigger": "export_cap",
                    "cap_power_kw": round(cap_power, 1),
                    "cap_power_pct": round(cap_power / rated_power_kw * 100, 1),
                    "power_cv": round(power_cv, 4),
                    "n_samples": len(timestamps),
                },
            ))

        return results

    def _detect_pattern_curtailment(
        self,
        df: pl.DataFrame,
        p_ac_col: str,
        irradiance_col: str,
        rated_power_kw: float,
        timestamp_col: str,
        inverter_id: Optional[str],
    ) -> list[ACFaultResult]:
        """Detect curtailment from sudden power drop not explained by irradiance."""

        results = []

        # Calculate power and irradiance derivatives
        df_sorted = df.sort(timestamp_col)

        df_diff = df_sorted.with_columns([
            pl.col(p_ac_col).diff().alias("dp"),
            pl.col(irradiance_col).diff().alias("dg"),
        ])

        # Large power drop without corresponding irradiance drop
        # dp < -15% AND dg > -5% (irradiance stable or rising)
        drop_threshold = -rated_power_kw * self.thresholds.curtailment_drop_pct

        df_curt = df_diff.filter(
            (pl.col("dp") < drop_threshold) &
            (pl.col("dg") > -50)  # Irradiance drop < 50 W/m²
        )

        if df_curt.height > 0:
            timestamps = df_curt[timestamp_col].to_numpy()

            results.append(ACFaultResult(
                fault_type="curtailment",
                severity="moderate",
                confidence=0.6,  # Pattern-based is less certain
                detected_at=timestamps[0],
                duration_minutes=df_curt.height,
                loss_kwh=0,
                inverter_id=inverter_id,
                details={
                    "trigger": "unexplained_drop",
                    "avg_power_drop_kw": round(abs(df_curt["dp"].mean()), 1),
                    "avg_irradiance_change": round(df_curt["dg"].mean(), 1),
                    "n_samples": df_curt.height,
                },
            ))

        return results


class CompoundFaultDetector:
    """
    ML-based detection of subtle multi-variable faults.

    Detects compound faults where multiple small deviations
    combine to indicate a problem (none individually exceeds threshold).

    Uses Isolation Forest for unsupervised anomaly detection.
    """

    FEATURE_NAMES = [
        "efficiency_residual",
        "power_ratio_residual",
        "temp_residual",
        "current_cv",
        "voltage_residual",
        "mppt_balance",
        "clipping_proximity",
        "irradiance_consistency",
        "hour_sin",
        "hour_cos",
        "month_sin",
        "month_cos",
    ]

    def __init__(self, thresholds: ACFaultThresholds, enable_shap: bool = True):
        self.thresholds = thresholds
        self.enable_shap = enable_shap and HAS_SHAP

        if not HAS_SKLEARN:
            raise ImportError("scikit-learn required for CompoundFaultDetector")

        self.model = IsolationForest(
            n_estimators=100,
            contamination=thresholds.compound_contamination,
            random_state=42,
            n_jobs=-1,
        )
        self.scaler = StandardScaler()
        self.is_fitted = False
        self.feature_means: Optional[np.ndarray] = None
        self.feature_stds: Optional[np.ndarray] = None

        # SHAP attributor (initialized during fit)
        self._shap_attributor: Optional[SHAPAttributor] = None
        self._fitted_feature_names: list[str] = []
        self._background_data: Optional[np.ndarray] = None

    def fit(
        self,
        df: pl.DataFrame,
        feature_cols: dict[str, str],
        irradiance_col: str = "irradiance",
        timestamp_col: str = "timestamp",
        min_irradiance: float = 100.0,
    ):
        """
        Train on 'normal' operation periods.

        Args:
            df: DataFrame with features
            feature_cols: Mapping of feature name to column name
            irradiance_col: Column with irradiance values
            timestamp_col: Timestamp column
            min_irradiance: Minimum irradiance for valid data
        """
        # Filter to daytime operation
        df_normal = df.filter(pl.col(irradiance_col) > min_irradiance)

        if df_normal.height < 100:
            raise ValueError(f"Insufficient data: {df_normal.height} samples (need >= 100)")

        # Extract features
        features = self._extract_features(df_normal, feature_cols, timestamp_col)

        if features.shape[1] < 4:
            raise ValueError(f"Insufficient features: {features.shape[1]} (need >= 4)")

        # Scale and fit
        features_scaled = self.scaler.fit_transform(features)
        self.model.fit(features_scaled)

        # Store feature statistics for interpretation
        self.feature_means = np.mean(features, axis=0)
        self.feature_stds = np.std(features, axis=0)

        # Store fitted feature names
        self._fitted_feature_names = [
            name for name in self.FEATURE_NAMES
            if name in feature_cols or name.startswith("hour_") or name.startswith("month_")
        ]

        # Store background data for SHAP (subsample for efficiency)
        if self.enable_shap:
            n_background = min(100, features_scaled.shape[0])
            idx = np.random.choice(features_scaled.shape[0], n_background, replace=False)
            self._background_data = features_scaled[idx]

            # Initialize SHAP attributor
            try:
                self._shap_attributor = SHAPAttributor(
                    model=self.model,
                    feature_names=self._fitted_feature_names[:features_scaled.shape[1]],
                    background_data=self._background_data,
                    max_background_samples=100,
                )
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning(f"SHAP initialization failed: {e}")
                self._shap_attributor = None

        self.is_fitted = True

    def detect(
        self,
        df: pl.DataFrame,
        feature_cols: dict[str, str],
        timestamp_col: str = "timestamp",
        irradiance_col: str = "irradiance",
        min_irradiance: float = 100.0,
        inverter_id: Optional[str] = None,
    ) -> list[CompoundFaultResult]:
        """
        Detect compound anomalies.

        Returns list of CompoundFaultResult with anomaly scores and interpretations.
        """

        if not self.is_fitted:
            raise ValueError("Model not fitted. Call fit() first.")

        results = []

        # Filter to operating periods
        df_op = df.filter(pl.col(irradiance_col) > min_irradiance)

        if df_op.height == 0:
            return results

        # Extract features
        features = self._extract_features(df_op, feature_cols, timestamp_col)

        if features.shape[0] == 0:
            return results

        # Scale and predict
        features_scaled = self.scaler.transform(features)

        # Get anomaly scores (negative = anomaly, positive = normal)
        raw_scores = self.model.decision_function(features_scaled)

        # Convert to 0-1 anomaly probability (higher = more anomalous)
        score_min, score_max = raw_scores.min(), raw_scores.max()
        if score_max > score_min:
            anomaly_scores = 1 - (raw_scores - score_min) / (score_max - score_min)
        else:
            anomaly_scores = np.zeros_like(raw_scores)

        # Find anomalous periods
        timestamps = df_op[timestamp_col].to_numpy()

        # Group anomalies
        anomaly_mask = anomaly_scores > self.thresholds.compound_minor_score

        if not np.any(anomaly_mask):
            return results

        anomaly_periods = self._group_anomaly_periods(
            timestamps[anomaly_mask],
            anomaly_scores[anomaly_mask],
            features[anomaly_mask],
            feature_cols,
        )

        for period in anomaly_periods:
            # Determine severity
            if period["max_score"] > self.thresholds.compound_major_score:
                severity = "major"
            elif period["max_score"] > self.thresholds.compound_moderate_score:
                severity = "moderate"
            else:
                severity = "minor"

            # Interpret contributing factors
            contributing_factors = self._interpret_anomaly(
                period["avg_features"],
                list(feature_cols.keys()),
            )

            # Generate interpretation string
            interpretation_parts = []
            for name, info in contributing_factors.items():
                direction = "+" if info["z_score"] > 0 else ""
                interpretation_parts.append(f"{name} {direction}{info['z_score']:.1f}σ")

            interpretation = "Compound fault: " + " + ".join(interpretation_parts)

            # Suggest possible causes
            possible_causes = self._suggest_causes(contributing_factors)

            # Compute SHAP attribution if available
            shap_values = {}
            shap_explanation = ""
            if self._shap_attributor is not None:
                try:
                    # Get SHAP values for the average features of this period
                    avg_features_scaled = self.scaler.transform(
                        period["avg_features"].reshape(1, -1)
                    )
                    attribution = self._shap_attributor.explain(avg_features_scaled)
                    shap_values = attribution.feature_contributions
                    shap_explanation = attribution.explanation_text
                except Exception:
                    pass  # SHAP failed, use fallback interpretation

            results.append(CompoundFaultResult(
                fault_type="compound",
                severity=severity,
                confidence=min(1.0, 0.5 + period["avg_score"] * 0.5),
                detected_at=period["start"],
                duration_minutes=period["duration_min"],
                loss_kwh=0,  # Hard to quantify compound losses
                inverter_id=inverter_id,
                anomaly_score=period["avg_score"],
                contributing_factors=contributing_factors,
                interpretation=interpretation,
                possible_causes=possible_causes,
                shap_values=shap_values,
                shap_explanation=shap_explanation,
                details={
                    "max_anomaly_score": round(period["max_score"], 3),
                    "n_samples": period["n_samples"],
                    "has_shap": bool(shap_values),
                },
            ))

        return results

    def _extract_features(
        self,
        df: pl.DataFrame,
        feature_cols: dict[str, str],
        timestamp_col: str,
    ) -> np.ndarray:
        """Extract feature matrix from DataFrame."""

        features = []

        for feature_name in self.FEATURE_NAMES:
            if feature_name in feature_cols:
                col_name = feature_cols[feature_name]
                if col_name in df.columns:
                    features.append(df[col_name].to_numpy())
                    continue

            # Handle temporal features
            if feature_name == "hour_sin":
                hours = df[timestamp_col].dt.hour().to_numpy()
                features.append(np.sin(2 * np.pi * hours / 24))
            elif feature_name == "hour_cos":
                hours = df[timestamp_col].dt.hour().to_numpy()
                features.append(np.cos(2 * np.pi * hours / 24))
            elif feature_name == "month_sin":
                months = df[timestamp_col].dt.month().to_numpy()
                features.append(np.sin(2 * np.pi * months / 12))
            elif feature_name == "month_cos":
                months = df[timestamp_col].dt.month().to_numpy()
                features.append(np.cos(2 * np.pi * months / 12))
            elif feature_name in feature_cols:
                # Feature requested but column missing - use zeros
                features.append(np.zeros(df.height))

        if not features:
            return np.array([]).reshape(0, 0)

        # Stack and handle NaN
        feature_matrix = np.column_stack(features)
        feature_matrix = np.nan_to_num(feature_matrix, nan=0.0)

        return feature_matrix

    def _group_anomaly_periods(
        self,
        timestamps: np.ndarray,
        scores: np.ndarray,
        features: np.ndarray,
        feature_cols: dict[str, str],
    ) -> list[dict]:
        """Group consecutive anomalous samples."""

        periods = []

        if len(timestamps) == 0:
            return periods

        max_gap_seconds = 30 * 60  # 30 min gap
        period_start_idx = 0

        for i in range(1, len(timestamps)):
            gap = (timestamps[i] - timestamps[i-1]).astype('timedelta64[s]').astype(int)

            if gap > max_gap_seconds or i == len(timestamps) - 1:
                end_idx = i if i == len(timestamps) - 1 else i - 1

                if end_idx >= period_start_idx:
                    duration_sec = (timestamps[end_idx] - timestamps[period_start_idx]).astype('timedelta64[s]').astype(int)

                    periods.append({
                        "start": timestamps[period_start_idx],
                        "end": timestamps[end_idx],
                        "duration_min": max(1, duration_sec / 60),
                        "avg_score": float(np.mean(scores[period_start_idx:end_idx+1])),
                        "max_score": float(np.max(scores[period_start_idx:end_idx+1])),
                        "avg_features": np.mean(features[period_start_idx:end_idx+1], axis=0),
                        "n_samples": end_idx - period_start_idx + 1,
                    })

                period_start_idx = i

        return periods

    def _interpret_anomaly(
        self,
        features: np.ndarray,
        feature_names: list[str],
    ) -> dict:
        """Identify which features contribute most to anomaly."""

        if self.feature_means is None or self.feature_stds is None:
            return {}

        deviations = {}

        for i, name in enumerate(feature_names):
            if i >= len(features) or i >= len(self.feature_means):
                continue

            if self.feature_stds[i] > 0:
                z_score = (features[i] - self.feature_means[i]) / self.feature_stds[i]
            else:
                z_score = 0

            if abs(z_score) > 1.5:  # Notable deviation
                deviations[name] = {
                    "value": float(features[i]),
                    "z_score": float(z_score),
                    "direction": "high" if z_score > 0 else "low",
                }

        return deviations

    def get_shap_attribution(
        self,
        features: np.ndarray,
    ) -> Optional[FeatureAttribution]:
        """
        Get SHAP attribution for a feature vector.

        Args:
            features: Raw feature vector (unscaled)

        Returns:
            FeatureAttribution object or None if SHAP unavailable
        """
        if self._shap_attributor is None:
            return None

        if not self.is_fitted:
            return None

        try:
            features_scaled = self.scaler.transform(features.reshape(1, -1))
            return self._shap_attributor.explain(features_scaled)
        except Exception:
            return None

    def get_feature_names(self) -> list[str]:
        """Get the list of feature names used by this detector."""
        return self._fitted_feature_names.copy()

    def has_shap(self) -> bool:
        """Check if SHAP attribution is available."""
        return self._shap_attributor is not None

    def _suggest_causes(self, contributing_factors: dict) -> list[str]:
        """Suggest possible causes based on contributing factors."""

        causes = []

        factor_names = set(contributing_factors.keys())

        # Pattern matching for common fault combinations
        if "efficiency_residual" in factor_names and "temp_residual" in factor_names:
            if contributing_factors["efficiency_residual"]["direction"] == "low":
                if contributing_factors["temp_residual"]["direction"] == "high":
                    causes.append("Thermal throttling or inverter overheating")
                else:
                    causes.append("Inverter efficiency degradation")

        if "current_cv" in factor_names:
            if contributing_factors["current_cv"]["direction"] == "high":
                if "temp_residual" in factor_names:
                    causes.append("Hot spot with partial shading")
                else:
                    causes.append("String mismatch or partial shading")

        if "voltage_residual" in factor_names:
            if contributing_factors["voltage_residual"]["direction"] == "low":
                causes.append("String voltage drop - possible connector issue")

        if "mppt_balance" in factor_names:
            if contributing_factors["mppt_balance"]["direction"] == "low":
                causes.append("MPPT tracking issue or string failure")

        if "hour_sin" in factor_names or "hour_cos" in factor_names:
            causes.append("Time-dependent issue - possible shading at specific sun angles")

        if "month_sin" in factor_names or "month_cos" in factor_names:
            causes.append("Seasonal pattern - possible thermal design limitation")

        if not causes:
            causes.append("Compound anomaly - further investigation recommended")

        return causes


# =============================================================================
# Main Unified Detector
# =============================================================================

class ACFaultDetector:
    """
    Unified AC-side fault detection with graceful data handling.

    Automatically detects available data and runs appropriate detectors.
    """

    def __init__(
        self,
        plant_id: str,
        rated_power_kw: float = 100.0,
        thresholds: Optional[ACFaultThresholds] = None,
    ):
        """
        Initialize AC fault detector.

        Args:
            plant_id: Plant identifier
            rated_power_kw: Rated AC power in kW
            thresholds: Optional custom thresholds
        """
        self.plant_id = plant_id
        self.rated_power_kw = rated_power_kw
        self.thresholds = thresholds or ACFaultThresholds()

        # Initialize individual detectors
        self.efficiency_detector = EfficiencyDropDetector(self.thresholds)
        self.mppt_detector = MPPTErrorDetector(self.thresholds)
        self.grid_detector = GridSyncDetector(self.thresholds)
        self.clipping_detector = ClippingDetector(self.thresholds)
        self.curtailment_detector = CurtailmentDetector(self.thresholds)

        self.compound_detector: Optional[CompoundFaultDetector] = None
        if HAS_SKLEARN:
            self.compound_detector = CompoundFaultDetector(self.thresholds)

    def check_data_availability(self, df: pl.DataFrame) -> DataAvailability:
        """Check which data columns are available."""

        cols = list(df.columns)

        availability = DataAvailability()

        # Check AC power (support various naming conventions)
        # Pattern: "P_AC", "{plant}: INV XX / P_AC (kW)", "Power by Inverter (kW)"
        availability.has_p_ac = any(
            "P_AC" in c or "Power by Inverter" in c or "power_ac" in c.lower()
            for c in cols
        )

        # Check DC power (could be sum of MPPTs or direct measurement)
        availability.has_p_dc = any(
            "P_DC" in c or "power_dc" in c.lower()
            for c in cols
        )

        # Check MPPT currents
        # Pattern: "Input_current_XX", "{plant}: INV XX / Input_current_YY (A)"
        mppt_current_cols = [c for c in cols if "Input_current" in c]
        availability.has_mppt_current = len(mppt_current_cols) > 0
        availability.n_mppt_channels = len(mppt_current_cols)

        # Check MPPT voltages
        # Pattern: "U_DC_XX", "{plant}: INV XX / U_DC_YY (V)"
        mppt_voltage_cols = [c for c in cols if "U_DC" in c]
        availability.has_mppt_voltage = len(mppt_voltage_cols) > 0

        # Check grid data
        availability.has_grid_frequency = any(
            "frequency" in c.lower() or "freq" in c.lower()
            for c in cols
        )
        availability.has_grid_voltage = any(
            "grid_voltage" in c.lower() or "v_grid" in c.lower()
            for c in cols
        )

        # Check irradiance
        # Pattern: "irradiance", "{plant}: Plant / Irradiation_average (W/m²)"
        availability.has_irradiance = any(
            "Irradiation" in c or "irradiance" in c.lower() or
            "Radiation" in c or "ghi" in c.lower() or "poa" in c.lower()
            for c in cols
        )

        # Check temperature
        # Pattern: "Temperature", "{plant}: INV XX / Temperature (°C)"
        availability.has_temperature = any(
            "Temperature" in c or "temperature" in c.lower() or
            "Temp" in c
            for c in cols
        )

        return availability

    def detect_all(
        self,
        df: pl.DataFrame,
        inverter_id: Optional[str] = None,
        column_mapping: Optional[dict] = None,
    ) -> list[ACFaultResult]:
        """
        Run all available fault detectors.

        Args:
            df: DataFrame with SCADA data
            inverter_id: Optional inverter identifier
            column_mapping: Optional column name mapping

        Returns:
            List of detected faults
        """

        all_results = []

        # Check data availability
        availability = self.check_data_availability(df)

        # Get column names (with fallback to common patterns)
        cols = self._resolve_columns(df, column_mapping)

        # 1. Efficiency drop detection
        if availability.can_run_efficiency():
            try:
                results = self.efficiency_detector.detect(
                    df,
                    p_ac_col=cols["p_ac"],
                    p_dc_col=cols["p_dc"],
                    rated_power_kw=self.rated_power_kw,
                    timestamp_col=cols["timestamp"],
                    inverter_id=inverter_id,
                )
                all_results.extend(results)
            except Exception as e:
                pass  # Silently skip on error

        # 2. MPPT error detection
        if availability.can_run_mppt():
            try:
                mppt_current_cols = [
                    c for c in df.columns
                    if "Input_current" in c or "I_mppt" in c.lower()
                ]
                mppt_voltage_cols = [
                    c for c in df.columns
                    if "U_DC" in c or "V_mppt" in c.lower()
                ]

                results = self.mppt_detector.detect(
                    df,
                    mppt_current_cols=mppt_current_cols,
                    mppt_voltage_cols=mppt_voltage_cols if mppt_voltage_cols else None,
                    timestamp_col=cols["timestamp"],
                    inverter_id=inverter_id,
                )
                all_results.extend(results)
            except Exception as e:
                pass

        # 3. Grid sync detection
        if availability.can_run_grid():
            try:
                results = self.grid_detector.detect(
                    df,
                    freq_col=cols.get("grid_frequency"),
                    voltage_col=cols.get("grid_voltage"),
                    timestamp_col=cols["timestamp"],
                    inverter_id=inverter_id,
                )
                all_results.extend(results)
            except Exception as e:
                pass

        # 4. Clipping detection
        if availability.can_run_clipping():
            try:
                results = self.clipping_detector.detect(
                    df,
                    p_ac_col=cols["p_ac"],
                    irradiance_col=cols["irradiance"],
                    rated_power_kw=self.rated_power_kw,
                    timestamp_col=cols["timestamp"],
                    temp_col=cols.get("temperature"),
                    inverter_id=inverter_id,
                )
                all_results.extend(results)
            except Exception as e:
                pass

        # 5. Curtailment detection
        if availability.can_run_curtailment():
            try:
                results = self.curtailment_detector.detect(
                    df,
                    p_ac_col=cols["p_ac"],
                    irradiance_col=cols.get("irradiance"),
                    freq_col=cols.get("grid_frequency"),
                    rated_power_kw=self.rated_power_kw,
                    timestamp_col=cols["timestamp"],
                    inverter_id=inverter_id,
                )
                all_results.extend(results)
            except Exception as e:
                pass

        return all_results

    def detect_compound(
        self,
        df: pl.DataFrame,
        feature_cols: dict[str, str],
        inverter_id: Optional[str] = None,
    ) -> list[CompoundFaultResult]:
        """
        Run compound ML fault detection.

        Requires prior call to fit_compound() with normal operation data.

        Args:
            df: DataFrame with features
            feature_cols: Mapping of feature names to column names
            inverter_id: Optional inverter identifier

        Returns:
            List of compound faults
        """

        if self.compound_detector is None:
            return []

        if not self.compound_detector.is_fitted:
            return []

        cols = self._resolve_columns(df)

        try:
            return self.compound_detector.detect(
                df,
                feature_cols=feature_cols,
                timestamp_col=cols["timestamp"],
                irradiance_col=cols.get("irradiance", "irradiance"),
                inverter_id=inverter_id,
            )
        except Exception as e:
            return []

    def fit_compound(
        self,
        df_normal: pl.DataFrame,
        feature_cols: dict[str, str],
    ):
        """
        Train compound ML detector on normal operation data.

        Args:
            df_normal: DataFrame with normal operation data
            feature_cols: Mapping of feature names to column names
        """

        if self.compound_detector is None:
            raise ValueError("scikit-learn required for compound detection")

        cols = self._resolve_columns(df_normal)

        self.compound_detector.fit(
            df_normal,
            feature_cols=feature_cols,
            irradiance_col=cols.get("irradiance", "irradiance"),
            timestamp_col=cols["timestamp"],
        )

    def _resolve_columns(
        self,
        df: pl.DataFrame,
        mapping: Optional[dict] = None,
    ) -> dict[str, str]:
        """Resolve column names with fallbacks."""

        mapping = mapping or {}
        cols = df.columns

        resolved = {}

        # Timestamp
        resolved["timestamp"] = mapping.get("timestamp", self._find_col(
            cols, ["timestamp", "Timestamp", "time", "datetime"]
        ))

        # AC Power - look for plant total or first inverter
        p_ac = mapping.get("p_ac") or self._find_col_pattern(
            cols, ["Power by Inverter", "P_AC"]
        )
        if p_ac:
            resolved["p_ac"] = p_ac

        # DC Power
        p_dc = mapping.get("p_dc") or self._find_col_pattern(
            cols, ["P_DC"]
        )
        if p_dc:
            resolved["p_dc"] = p_dc

        # Irradiance - prefer plant average
        irr = mapping.get("irradiance") or self._find_col_pattern(
            cols, ["Irradiation_average", "irradiance", "Radiation"]
        )
        if irr:
            resolved["irradiance"] = irr

        # Temperature - use first inverter
        temp = mapping.get("temperature") or self._find_col_pattern(
            cols, ["Temperature"]
        )
        if temp:
            resolved["temperature"] = temp

        # Grid frequency
        freq = mapping.get("grid_frequency") or self._find_col_pattern(
            cols, ["frequency", "Frequency"]
        )
        if freq:
            resolved["grid_frequency"] = freq

        # Grid voltage
        voltage = mapping.get("grid_voltage") or self._find_col_pattern(
            cols, ["grid_voltage", "V_grid"]
        )
        if voltage:
            resolved["grid_voltage"] = voltage

        return resolved

    def _find_col(self, cols: list[str], candidates: list[str]) -> Optional[str]:
        """Find first matching column from candidates (exact match)."""
        for c in candidates:
            if c in cols:
                return c
        return None

    def _find_col_pattern(self, cols: list[str], patterns: list[str]) -> Optional[str]:
        """Find first column containing any of the patterns."""
        for pattern in patterns:
            for col in cols:
                if pattern in col:
                    return col
        return None

    def generate_report(
        self,
        results: list[ACFaultResult],
        availability: Optional[DataAvailability] = None,
    ) -> str:
        """Generate markdown report of detected faults."""

        lines = [
            f"# AC Fault Detection Report: {self.plant_id}",
            "",
            f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
            "",
        ]

        # Data availability
        if availability:
            lines.append("## Data Availability")
            lines.append("")
            lines.append("| Data | Available | Detector |")
            lines.append("|------|-----------|----------|")
            lines.append(f"| AC Power | {'✅' if availability.has_p_ac else '❌'} | All |")
            lines.append(f"| DC Power | {'✅' if availability.has_p_dc else '❌'} | Efficiency |")
            lines.append(f"| MPPT Current ({availability.n_mppt_channels} ch) | {'✅' if availability.has_mppt_current else '❌'} | MPPT Error |")
            lines.append(f"| Grid Freq/Voltage | {'✅' if availability.has_grid_frequency else '❌'} | Grid Sync |")
            lines.append(f"| Irradiance | {'✅' if availability.has_irradiance else '❌'} | Clipping |")
            lines.append("")

        # Summary
        lines.append("## Summary")
        lines.append("")

        if not results:
            lines.append("No faults detected.")
            return "\n".join(lines)

        # Count by type and severity
        by_type = {}
        by_severity = {"critical": 0, "major": 0, "moderate": 0, "minor": 0}
        total_loss = 0

        for r in results:
            by_type[r.fault_type] = by_type.get(r.fault_type, 0) + 1
            by_severity[r.severity] = by_severity.get(r.severity, 0) + 1
            total_loss += r.loss_kwh

        lines.append(f"- **Total Faults**: {len(results)}")
        lines.append(f"- **Total Energy Loss**: {total_loss:.1f} kWh")
        lines.append("")

        lines.append("### By Type")
        lines.append("")
        for fault_type, count in sorted(by_type.items()):
            lines.append(f"- {fault_type}: {count}")
        lines.append("")

        lines.append("### By Severity")
        lines.append("")
        for severity in ["critical", "major", "moderate", "minor"]:
            if by_severity[severity] > 0:
                lines.append(f"- {severity}: {by_severity[severity]}")
        lines.append("")

        # Detailed results
        lines.append("## Fault Details")
        lines.append("")

        for r in results:
            lines.append(f"### {r.fault_type.upper()} - {r.severity}")
            lines.append("")
            lines.append(f"- **Detected at**: {r.detected_at}")
            lines.append(f"- **Duration**: {r.duration_minutes:.0f} min")
            lines.append(f"- **Confidence**: {r.confidence:.0%}")
            if r.loss_kwh > 0:
                lines.append(f"- **Energy Loss**: {r.loss_kwh:.1f} kWh")
            if r.inverter_id:
                lines.append(f"- **Inverter**: {r.inverter_id}")

            if r.details:
                lines.append("")
                for k, v in r.details.items():
                    lines.append(f"  - {k}: {v}")

            if isinstance(r, CompoundFaultResult):
                if r.interpretation:
                    lines.append(f"- **Interpretation**: {r.interpretation}")
                if r.possible_causes:
                    lines.append(f"- **Possible Causes**: {', '.join(r.possible_causes)}")

            lines.append("")

        return "\n".join(lines)
