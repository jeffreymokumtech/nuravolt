"""
Per-Inverter Soiling Analysis Module

The whole point of NuraVolt's soiling stack is per-inverter SR estimation.
A typical plant has ONE DustIQ reference sensor, so the per-inverter signal
must be inferred from each inverter's AC kW + irradiance + cell temperature
(the soiling-attributable residual after the digital twin removes weather,
curtailment, and temperature effects). Fleet-mean is the day-1 fallback only.

This module implements the inference + downstream products:
- Per-inverter soiling ratio (SR) calculation
- Per-inverter loss disaggregation (IEA PVPS Task 13)
- Per-inverter anomaly detection (z-score vs fleet)
- JSON export for frontend consumption (heatmap tiles, severity buckets)
- ECharts configuration generation

Companion files:
- `sr_per_inverter_features.py` — feature engineering for the trainer
- `scripts/train_per_inverter_sr.py` — `PerInverterSRModel` trainer (LightGBM)
- `scripts/backfill_per_inverter_sr.py` — historical SR backfill writer
- `scripts/generate_per_inverter_soiling.py` — regenerates the SERVED
  per-inverter artifacts from measured data (this analyzer for wide-SCADA
  plants; self-normalized PR + DustIQ calibration for pr_daily plants)

Designed for Alpha1 9MW plant (150 inverters) but adaptable to any plant.
"""

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Tuple, Optional, Any, Union
from pathlib import Path
import json
import re
from datetime import datetime

import numpy as np
import pandas as pd

# Import existing loss disaggregation
from .loss_disaggregation import (
    IEALossDisaggregator,
    LossComponents,
    PHYSICS_CONSTANTS,
    INVERTER_EFFICIENCY_CURVE,
)
from .config import SoilingConfig


@dataclass
class InverterSoilingMetrics:
    """Per-inverter soiling analysis results."""

    # Identification
    inverter_id: str
    group_id: str

    # Soiling Ratio Metrics
    sr_mean: float = 0.0
    sr_median: float = 0.0
    sr_min: float = 0.0
    sr_max: float = 0.0
    sr_std: float = 0.0

    # Loss Disaggregation (IEA method - no curtailment by default)
    soiling_loss_pct: float = 0.0
    temperature_loss_pct: float = 0.0
    spectral_loss_pct: float = 0.0
    inverter_loss_pct: float = 0.0
    wiring_bop_loss_pct: float = 0.0
    degradation_loss_pct: float = 0.0
    total_loss_pct: float = 0.0

    # Energy Values (kWh)
    reference_energy_kwh: float = 0.0
    net_energy_kwh: float = 0.0
    soiling_energy_loss_kwh: float = 0.0

    # Anomaly Detection
    anomaly_count: int = 0
    anomaly_rate_pct: float = 0.0
    anomaly_periods: List[Dict] = field(default_factory=list)

    # Performance Metrics
    performance_ratio: float = 0.0
    avg_power_normalized: float = 0.0
    capacity_factor: float = 0.0
    availability_pct: float = 0.0
    production_rate: float = 0.0

    # Data Quality
    data_completeness_pct: float = 0.0
    valid_records: int = 0
    total_records: int = 0

    # Fleet Comparison
    fleet_rank: int = 0
    deviation_from_fleet_mean_pct: float = 0.0
    z_score: float = 0.0
    severity: str = "Normal"  # "Normal", "Minor", "Major", "Critical"

    # Metadata
    analysis_start: Optional[str] = None
    analysis_end: Optional[str] = None
    generated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        # Helper to convert numpy types to native Python types
        def _convert(val):
            if hasattr(val, 'item'):  # numpy scalar
                return val.item()
            return val

        return {
            "inverterId": self.inverter_id,
            "groupId": self.group_id,
            "soilingRatio": {
                "mean": float(round(self.sr_mean, 4)),
                "median": float(round(self.sr_median, 4)),
                "min": float(round(self.sr_min, 4)),
                "max": float(round(self.sr_max, 4)),
                "std": float(round(self.sr_std, 4)),
            },
            "lossDisaggregation": {
                "method": "IEA_PVPS_T13",
                "percentages": {
                    "soiling": float(round(self.soiling_loss_pct * 100, 2)),
                    "temperature": float(round(self.temperature_loss_pct * 100, 2)),
                    "spectral": float(round(self.spectral_loss_pct * 100, 2)),
                    "inverter": float(round(self.inverter_loss_pct * 100, 2)),
                    "wiringBop": float(round(self.wiring_bop_loss_pct * 100, 2)),
                    "degradation": float(round(self.degradation_loss_pct * 100, 2)),
                    "total": float(round(self.total_loss_pct * 100, 2)),
                },
                "energy_kWh": {
                    "reference": float(round(self.reference_energy_kwh, 1)),
                    "net": float(round(self.net_energy_kwh, 1)),
                    "soilingLoss": float(round(self.soiling_energy_loss_kwh, 1)),
                },
            },
            "anomalyDetection": {
                "totalAnomalies": int(_convert(self.anomaly_count)),
                "anomalyRate_pct": float(round(self.anomaly_rate_pct, 2)),
                "periods": self.anomaly_periods[:10],  # Limit to 10 most recent
            },
            "performance": {
                "performanceRatio": float(round(self.performance_ratio, 3)),
                "avgPowerNormalized": float(round(self.avg_power_normalized, 4)),
                "capacityFactor": float(round(self.capacity_factor, 3)),
                "availability_pct": float(round(self.availability_pct, 1)),
                "productionRate": float(round(self.production_rate, 3)),
            },
            "fleetComparison": {
                "rank": int(_convert(self.fleet_rank)),
                "deviationFromMean_pct": float(round(self.deviation_from_fleet_mean_pct, 2)),
                "zScore": float(round(self.z_score, 2)),
                "severity": self.severity,
            },
            "dataQuality": {
                "completeness_pct": float(round(self.data_completeness_pct, 1)),
                "validRecords": int(_convert(self.valid_records)),
                "totalRecords": int(_convert(self.total_records)),
            },
            "metadata": {
                "analysisStart": self.analysis_start,
                "analysisEnd": self.analysis_end,
                "generatedAt": self.generated_at or datetime.now().isoformat(),
            },
        }


@dataclass
class FleetSoilingSummary:
    """Fleet-wide soiling summary."""

    # Plant Info
    plant_id: str
    plant_name: str
    capacity_mw: float
    total_inverters: int
    inverter_groups: List[str] = field(default_factory=list)

    # Analysis Period
    analysis_start: Optional[str] = None
    analysis_end: Optional[str] = None
    total_days: int = 0

    # Fleet Soiling Aggregates
    fleet_sr_mean: float = 0.0
    fleet_sr_std: float = 0.0
    fleet_sr_min: float = 0.0
    fleet_sr_max: float = 0.0

    # Fleet Loss Totals
    fleet_total_soiling_loss_mwh: float = 0.0
    fleet_total_loss_mwh: float = 0.0
    fleet_reference_energy_mwh: float = 0.0
    fleet_net_energy_mwh: float = 0.0

    # Health Distribution
    inverters_normal: int = 0
    inverters_minor_issues: int = 0
    inverters_major_issues: int = 0
    inverters_critical: int = 0

    # Group-Level Metrics
    group_metrics: Dict[str, Dict] = field(default_factory=dict)

    # Top/Worst Performers
    top_performers: List[Dict] = field(default_factory=list)
    worst_performers: List[Dict] = field(default_factory=list)

    # Anomaly Summary
    total_anomalies: int = 0
    inverters_with_anomalies: int = 0

    # Economic Impact
    estimated_annual_loss_eur: float = 0.0
    cleaning_roi_potential_eur: float = 0.0

    # Metadata
    generated_at: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "plantInfo": {
                "plantId": self.plant_id,
                "plantName": self.plant_name,
                "capacity_MW": self.capacity_mw,
                "totalInverters": self.total_inverters,
                "inverterGroups": self.inverter_groups,
            },
            "analysisPeriod": {
                "start": self.analysis_start,
                "end": self.analysis_end,
                "totalDays": self.total_days,
            },
            "fleetSoiling": {
                "srMean": round(self.fleet_sr_mean, 4),
                "srStd": round(self.fleet_sr_std, 4),
                "srMin": round(self.fleet_sr_min, 4),
                "srMax": round(self.fleet_sr_max, 4),
            },
            "fleetLosses": {
                "totalSoilingLoss_MWh": round(self.fleet_total_soiling_loss_mwh, 1),
                "totalLoss_MWh": round(self.fleet_total_loss_mwh, 1),
                "referenceEnergy_MWh": round(self.fleet_reference_energy_mwh, 1),
                "netEnergy_MWh": round(self.fleet_net_energy_mwh, 1),
            },
            "healthDistribution": {
                "normal": self.inverters_normal,
                "minorIssues": self.inverters_minor_issues,
                "majorIssues": self.inverters_major_issues,
                "critical": self.inverters_critical,
            },
            "groupMetrics": self.group_metrics,
            "topPerformers": self.top_performers[:5],
            "worstPerformers": self.worst_performers[:5],
            "anomalySummary": {
                "totalAnomalies": self.total_anomalies,
                "invertersWithAnomalies": self.inverters_with_anomalies,
            },
            "economicImpact": {
                "estimatedAnnualLoss_EUR": round(self.estimated_annual_loss_eur, 0),
                "cleaningROIPotential_EUR": round(self.cleaning_roi_potential_eur, 0),
            },
            "generatedAt": self.generated_at or datetime.now().isoformat(),
        }


class PerInverterSoilingAnalyzer:
    """
    Per-inverter soiling analysis for solar PV plants.

    Features:
    - Per-inverter SR calculation from normalized power
    - Per-inverter loss disaggregation (IEA PVPS Task 13)
    - Per-inverter anomaly detection
    - JSON export for frontend consumption
    - ECharts configuration generation
    """

    # Column pattern for Alpha1 inverters
    INVERTER_PATTERN = r'.*INV\s*\d+\.\d+.*(?:Power|power).*'

    def __init__(
        self,
        site_config: SoilingConfig,
        output_dir: str = "public/data/soiling/alpha1",
        min_irradiance: float = 50.0,
        anomaly_threshold: float = 0.15,
        min_data_points: int = 1000,
    ):
        """
        Initialize per-inverter analyzer.

        Parameters:
        -----------
        site_config : SoilingConfig
            Site configuration
        output_dir : str
            Output directory for JSON files
        min_irradiance : float
            Minimum irradiance (W/m²) for valid analysis
        anomaly_threshold : float
            Deviation threshold for anomaly detection (0.15 = 15%)
        min_data_points : int
            Minimum data points required for reliable analysis
        """
        self.config = site_config
        self.output_dir = Path(output_dir)
        self.min_irradiance = min_irradiance
        self.anomaly_threshold = anomaly_threshold
        self.min_data_points = min_data_points

        # Storage
        self.df: Optional[pd.DataFrame] = None
        self.inverter_columns: List[str] = []
        self.inverter_metrics: Dict[str, InverterSoilingMetrics] = {}
        self.fleet_summary: Optional[FleetSoilingSummary] = None

        # System-wide columns (detected during load)
        self.irradiance_col: Optional[str] = None
        self.temperature_col: Optional[str] = None
        self.power_col: Optional[str] = None

        # Provenance of the irradiance input ('onsite' | 'open-meteo' | 'clearsky')
        self.irradiance_source: Optional[str] = None
        self.weather_provenance: Dict[str, Any] = {}

    def load_data(self, filepath: str) -> None:
        """
        Load parquet data and identify columns.

        Parameters:
        -----------
        filepath : str
            Path to parquet file
        """
        print(f"📊 Loading data from {filepath}...")

        self.df = pd.read_parquet(filepath)
        print(f"   Loaded: {len(self.df):,} rows, {len(self.df.columns)} columns")

        # Parse timestamp if string
        if 'timestamp' in self.df.columns:
            if self.df['timestamp'].dtype == object:
                self.df['timestamp'] = pd.to_datetime(
                    self.df['timestamp'],
                    format='%Y.%m.%d %H:%M',
                    errors='coerce'
                )
            self.df = self.df.set_index('timestamp')

        # Identify inverter columns
        self.inverter_columns = self.identify_inverter_columns()
        print(f"   Found {len(self.inverter_columns)} inverter columns")

        # Identify system-wide columns
        self._identify_system_columns()

        # Operator preference (Plant.metadata.settings.dataSources, carried in
        # via site_config): 'onsite' | 'open_meteo' | 'auto'. 'open_meteo'
        # forces the modeled fallback even when a sensor column exists;
        # 'onsite' without a sensor warns loudly but still falls back so the
        # run completes (the picker UI disables that choice when no sensor
        # exists — this path is belt-and-braces).
        preference = self._config_value('preferred_irradiance_source', 'auto') or 'auto'

        if preference == 'open_meteo' and self.irradiance_col is not None:
            skipped_col = self.irradiance_col
            self.irradiance_col = None
            self._apply_weather_fallback()
            if self.irradiance_col is not None:
                self.weather_provenance['forced'] = 'user_preference'
                self.weather_provenance['skipped_onsite_column'] = skipped_col
                print(f"   ⚙️ Operator preference: open_meteo — skipping on-site column '{skipped_col}'")
            else:
                # Fallback unavailable (no lat/lon, fetch failed) — honor the
                # data over the preference rather than dying.
                self.irradiance_col = skipped_col
                self.irradiance_source = 'onsite'
                self.weather_provenance['requested'] = 'open_meteo'
                self.weather_provenance['fallback_reason'] = 'weather_fallback_unavailable'
                print("   ⚠️ open_meteo preferred but fallback unavailable — using on-site sensor")
        elif self.irradiance_col is None:
            # No on-site irradiance sensor -> satellite/model fallback
            # (residential plants have no pyranometer; without this the SR
            # degrades to a fixed PR-constant reference)
            if preference == 'onsite':
                print("   ⚠️ Operator preference is 'onsite' but no on-site irradiance "
                      "column was found — proceeding with the modeled fallback")
            self._apply_weather_fallback()
            if preference == 'onsite':
                # after: _apply_weather_fallback replaces weather_provenance
                self.weather_provenance['requested'] = 'onsite'
                self.weather_provenance['fallback_reason'] = 'no_onsite_sensor'
        else:
            self.irradiance_source = 'onsite'

        # Filter for daylight hours
        if self.irradiance_col and self.irradiance_col in self.df.columns:
            daylight_mask = self.df[self.irradiance_col] > self.min_irradiance
            self.df = self.df[daylight_mask]
            print(f"   Filtered to daylight hours: {len(self.df):,} records")

    def identify_inverter_columns(self) -> List[str]:
        """
        Identify inverter power columns from DataFrame.

        Returns:
        --------
        List[str]
            List of inverter column names
        """
        pattern = re.compile(self.INVERTER_PATTERN, re.IGNORECASE)
        inv_cols = [col for col in self.df.columns if pattern.match(col)]

        # Sort by inverter ID
        def sort_key(col):
            match = re.search(r'INV\s*(\d+)\.(\d+)', col)
            if match:
                return (int(match.group(1)), int(match.group(2)))
            return (999, 999)

        return sorted(inv_cols, key=sort_key)

    def _identify_system_columns(self) -> None:
        """Identify system-wide sensor columns."""
        cols = self.df.columns.tolist()

        # Irradiance
        irr_patterns = ['Irradiation', 'irradiance', 'Radiation', 'GHI', 'POA']
        for pattern in irr_patterns:
            matches = [c for c in cols if pattern.lower() in c.lower() and 'INV' not in c]
            if matches:
                self.irradiance_col = matches[0]
                break

        # Temperature
        temp_patterns = ['Ambient', 'temperature', 'Module', 'Temp']
        for pattern in temp_patterns:
            matches = [c for c in cols if pattern.lower() in c.lower() and 'INV' not in c]
            if matches:
                self.temperature_col = matches[0]
                break

        # Plant power
        power_patterns = ['Plant / Power', 'Total Power', 'Plant Power']
        for pattern in power_patterns:
            matches = [c for c in cols if pattern.lower() in c.lower() and 'INV' not in c]
            if matches:
                self.power_col = matches[0]
                break

        print(f"   System columns: irradiance={self.irradiance_col}, temp={self.temperature_col}")

    def _config_value(self, key: str, default=None):
        """Read a config value from either a dict or a SoilingConfig dataclass."""
        if hasattr(self.config, 'get'):
            return self.config.get(key, default)
        return getattr(self.config, key, default)

    def _apply_weather_fallback(self) -> None:
        """Inject satellite/model irradiance (+ ambient temp, wind) when the
        plant has no on-site sensor columns. See nuravolt/weather/fallback.py."""
        latitude = self._config_value('latitude')
        longitude = self._config_value('longitude')
        if latitude is None or longitude is None or self.df is None:
            print("   ⚠️ No irradiance column and no lat/lon in config — "
                  "SR will fall back to a fixed PR reference")
            return
        if not isinstance(self.df.index, pd.DatetimeIndex):
            return
        try:
            from nuravolt.weather import ensure_irradiance
            # fleet-mean power lets the fallback auto-detect logger clock
            # offsets (SCADA fixed standard time vs modeled DST local time)
            reference = (self.df[self.inverter_columns].mean(axis=1)
                         if self.inverter_columns else None)
            self.df, provenance = ensure_irradiance(
                self.df, latitude, longitude,
                tilt=self._config_value('tilt'),
                azimuth=self._config_value('azimuth'),
                timezone=self._config_value('timezone', 'auto'),
                align_reference=reference,
            )
        except Exception as exc:
            print(f"   ⚠️ Weather fallback failed ({exc}) — "
                  "SR will fall back to a fixed PR reference")
            return

        self.irradiance_col = provenance['irradiance_column']
        self.irradiance_source = provenance['source']
        self.weather_provenance = provenance
        if self.temperature_col is None and 'ambient_temp_openmeteo' in self.df.columns:
            self.temperature_col = 'ambient_temp_openmeteo'
        print(f"   🌤️ No on-site irradiance — using {provenance['source']} fallback "
              f"(plane={provenance['irradiance_plane']}, "
              f"confidence={provenance['confidence']:.2f}, "
              f"coverage={100 * provenance['coverage']:.0f}%)")

    def _extract_inverter_id(self, col_name: str) -> Tuple[str, str]:
        """
        Extract inverter ID and group ID from column name.

        Returns:
        --------
        Tuple[str, str]
            (inverter_id, group_id)
        """
        match = re.search(r'INV\s*(\d+)\.(\d+)', col_name)
        if match:
            group = f"INV {match.group(1).zfill(2)}"
            inv_id = f"INV {match.group(1).zfill(2)}.{match.group(2).zfill(3)}"
            return inv_id, group
        return col_name, "Unknown"

    def calculate_per_inverter_sr(self) -> Dict[str, pd.DataFrame]:
        """
        Calculate soiling ratio for each inverter.

        Soiling Ratio = Actual Power / Expected Power

        Expected power is calculated from irradiance using a reference efficiency.
        This gives SR in the typical 0.85-0.99 range for PV systems.

        Returns:
        --------
        Dict[str, pd.DataFrame]
            Per-inverter soiling ratio time series
        """
        print("\n⚙️ Calculating per-inverter soiling ratios...")

        per_inverter_sr = {}

        # Get irradiance data for expected power calculation
        has_irr = self.irradiance_col and self.irradiance_col in self.df.columns
        if has_irr:
            irradiance = self.df[self.irradiance_col].copy()
            # Reference system efficiency at STC (accounts for inverter, wiring losses)
            # Typical value is 0.80-0.85 for a well-functioning system
            reference_efficiency = 0.82
            g_stc = PHYSICS_CONSTANTS['G_stc']  # 1000 W/m²
            # Expected normalized power = (G / G_STC) * reference_efficiency
            expected_power = (irradiance / g_stc) * reference_efficiency
            # Avoid division by zero - only calculate SR when expected > 0.05
            expected_power = expected_power.clip(lower=0.05)
        else:
            expected_power = None

        for i, inv_col in enumerate(self.inverter_columns):
            if i % 30 == 0:
                print(f"   Progress: {i+1}/{len(self.inverter_columns)}")

            inv_id, group_id = self._extract_inverter_id(inv_col)

            # Get inverter power data
            inv_data = self.df[[inv_col]].copy()
            inv_data = inv_data.dropna()

            if len(inv_data) < self.min_data_points:
                continue

            # Calculate Soiling Ratio = Actual / Expected
            if expected_power is not None:
                # Join expected power to this inverter's data
                inv_data = inv_data.join(expected_power.rename('expected_power'), how='left')
                # SR = actual / expected, clipped to realistic range
                inv_data['sr_raw'] = (inv_data[inv_col] / inv_data['expected_power']).clip(0.0, 1.05)
            else:
                # Fallback: use normalized power with adjusted reference
                # Assume typical PR of 0.80 as reference for clean system
                inv_data['sr_raw'] = (inv_data[inv_col] / 0.80).clip(0.0, 1.05)

            # 7-day rolling median for smoothing (15-min data = 672 samples)
            window = min(672, len(inv_data) // 4)
            inv_data['sr_smooth'] = inv_data['sr_raw'].rolling(
                window=window,
                center=True,
                min_periods=window // 4
            ).median()

            # Forward/backward fill edges
            inv_data['sr_smooth'] = inv_data['sr_smooth'].ffill().bfill()

            per_inverter_sr[inv_id] = inv_data

        print(f"   ✅ Calculated SR for {len(per_inverter_sr)} inverters")
        return per_inverter_sr

    def calculate_per_inverter_losses(
        self,
        per_inverter_sr: Dict[str, pd.DataFrame]
    ) -> Dict[str, LossComponents]:
        """
        Calculate loss disaggregation for each inverter.

        Parameters:
        -----------
        per_inverter_sr : Dict[str, pd.DataFrame]
            Per-inverter SR time series from calculate_per_inverter_sr()

        Returns:
        --------
        Dict[str, LossComponents]
            Per-inverter loss components
        """
        print("\n⚙️ Calculating per-inverter loss disaggregation...")

        per_inverter_losses = {}

        # Get system-wide data for loss calculations
        has_temp = self.temperature_col and self.temperature_col in self.df.columns
        has_irr = self.irradiance_col and self.irradiance_col in self.df.columns

        for i, (inv_id, sr_df) in enumerate(per_inverter_sr.items()):
            if i % 30 == 0:
                print(f"   Progress: {i+1}/{len(per_inverter_sr)}")

            # Merge with system data
            if has_irr:
                sr_df = sr_df.join(self.df[[self.irradiance_col]], how='left')
            if has_temp:
                sr_df = sr_df.join(self.df[[self.temperature_col]], how='left')

            # Calculate individual loss factors
            time_factor = 0.25  # 15-min intervals to hours

            # Reference energy (using irradiance ratio to STC)
            g_stc = PHYSICS_CONSTANTS['G_stc']
            if has_irr:
                ref_power = sr_df[self.irradiance_col].fillna(0) / g_stc  # Normalized
                ref_energy = (ref_power * time_factor).sum()
            else:
                ref_energy = len(sr_df) * time_factor * 0.3  # Estimate

            # Soiling loss from SR
            sr_mean = sr_df['sr_smooth'].mean()
            soiling_loss_factor = max(0, 1 - sr_mean)
            soiling_loss = ref_energy * soiling_loss_factor

            # Temperature loss
            if has_temp:
                t_cell = sr_df[self.temperature_col].fillna(25)
                gamma = PHYSICS_CONSTANTS['gamma_pmax']
                t_stc = PHYSICS_CONSTANTS['T_stc']
                temp_loss_factor = (gamma * (t_cell.mean() - t_stc))
                temp_loss = max(0, ref_energy * abs(temp_loss_factor))
            else:
                temp_loss_factor = 0.05
                temp_loss = ref_energy * temp_loss_factor

            # Spectral loss (estimated from typical air mass)
            spectral_loss_factor = 0.01
            spectral_loss = ref_energy * spectral_loss_factor

            # Inverter efficiency loss
            inverter_loss_factor = 0.02
            inverter_loss = ref_energy * inverter_loss_factor

            # Wiring/BOP loss (fixed)
            wiring_loss = ref_energy * PHYSICS_CONSTANTS['wiring_bop_loss']

            # Degradation loss
            degradation_loss = ref_energy * PHYSICS_CONSTANTS['degradation_rate']

            # Net energy
            total_loss = soiling_loss + temp_loss + spectral_loss + inverter_loss + wiring_loss + degradation_loss
            net_energy = max(0, ref_energy - total_loss)

            # Create LossComponents
            loss = LossComponents(
                soiling_loss_pct=soiling_loss_factor,
                temperature_loss_pct=temp_loss / ref_energy if ref_energy > 0 else 0,
                spectral_loss_pct=spectral_loss_factor,
                inverter_loss_pct=inverter_loss_factor,
                wiring_bop_loss_pct=PHYSICS_CONSTANTS['wiring_bop_loss'],
                degradation_loss_pct=PHYSICS_CONSTANTS['degradation_rate'],
                curtailment_loss_pct=0.0,  # No curtailment for now
                reference_energy=ref_energy,
                net_energy=net_energy,
                soiling_energy_loss=soiling_loss,
                temperature_energy_loss=temp_loss,
                spectral_energy_loss=spectral_loss,
                inverter_energy_loss=inverter_loss,
                wiring_bop_energy_loss=wiring_loss,
                degradation_energy_loss=degradation_loss,
                curtailment_energy_loss=0.0,
            )

            per_inverter_losses[inv_id] = loss

        print(f"   ✅ Calculated losses for {len(per_inverter_losses)} inverters")
        return per_inverter_losses

    def detect_per_inverter_anomalies(
        self,
        per_inverter_sr: Dict[str, pd.DataFrame]
    ) -> Dict[str, List[Dict]]:
        """
        Detect anomaly periods for each inverter.

        Anomalies are periods where SR deviates significantly from the rolling mean.

        Parameters:
        -----------
        per_inverter_sr : Dict[str, pd.DataFrame]
            Per-inverter SR time series

        Returns:
        --------
        Dict[str, List[Dict]]
            Per-inverter anomaly periods
        """
        print("\n⚙️ Detecting per-inverter anomalies...")

        per_inverter_anomalies = {}

        for inv_id, sr_df in per_inverter_sr.items():
            anomalies = []

            # Calculate deviation from rolling mean
            sr_df = sr_df.copy()
            rolling_mean = sr_df['sr_smooth'].rolling(window=96, min_periods=24).mean()
            deviation = (sr_df['sr_smooth'] - rolling_mean) / rolling_mean

            # Identify anomaly periods (deviation > threshold)
            is_anomaly = deviation.abs() > self.anomaly_threshold

            # Group consecutive anomalies into periods
            if is_anomaly.any():
                # Create anomaly groups
                anomaly_groups = (is_anomaly != is_anomaly.shift()).cumsum()
                anomaly_df = sr_df[is_anomaly].copy()
                anomaly_df['group'] = anomaly_groups[is_anomaly]
                anomaly_df['deviation'] = deviation[is_anomaly]

                for group_id, group_df in anomaly_df.groupby('group'):
                    if len(group_df) >= 4:  # Minimum 1 hour of anomaly
                        start = group_df.index.min()
                        end = group_df.index.max()
                        mean_deviation = group_df['deviation'].mean()

                        # Classify severity
                        if abs(mean_deviation) > 0.3:
                            severity = "Critical"
                        elif abs(mean_deviation) > 0.2:
                            severity = "Major"
                        else:
                            severity = "Minor"

                        anomalies.append({
                            "start": str(start)[:10],
                            "end": str(end)[:10],
                            "duration_hours": len(group_df) * 0.25,
                            "severity": severity,
                            "type": "underperformance" if mean_deviation < 0 else "overperformance",
                            "deviation_pct": round(mean_deviation * 100, 1),
                        })

            per_inverter_anomalies[inv_id] = anomalies

        total_anomalies = sum(len(a) for a in per_inverter_anomalies.values())
        print(f"   ✅ Detected {total_anomalies} anomaly periods across {len(per_inverter_anomalies)} inverters")

        return per_inverter_anomalies

    def analyze_all_inverters(self) -> Dict[str, InverterSoilingMetrics]:
        """
        Run complete analysis for all inverters.

        Returns:
        --------
        Dict[str, InverterSoilingMetrics]
            Per-inverter metrics
        """
        print("\n🔍 Running complete per-inverter analysis...")

        # Step 1: Calculate SR
        per_inverter_sr = self.calculate_per_inverter_sr()

        # Step 2: Calculate losses
        per_inverter_losses = self.calculate_per_inverter_losses(per_inverter_sr)

        # Step 3: Detect anomalies
        per_inverter_anomalies = self.detect_per_inverter_anomalies(per_inverter_sr)

        # Step 4: Compile metrics for each inverter
        print("\n⚙️ Compiling per-inverter metrics...")

        # Calculate fleet statistics for comparison
        all_sr_means = []
        for inv_id, sr_df in per_inverter_sr.items():
            all_sr_means.append(sr_df['sr_smooth'].mean())

        fleet_sr_mean = np.mean(all_sr_means) if all_sr_means else 0.95
        fleet_sr_std = np.std(all_sr_means) if len(all_sr_means) > 1 else 0.02

        # Sort by SR mean for ranking
        sorted_inverters = sorted(per_inverter_sr.keys(),
                                  key=lambda x: per_inverter_sr[x]['sr_smooth'].mean(),
                                  reverse=True)

        inverter_metrics = {}

        for rank, inv_id in enumerate(sorted_inverters, 1):
            sr_df = per_inverter_sr[inv_id]
            inv_id_clean, group_id = self._extract_inverter_id(inv_id)

            # Get SR statistics
            sr_series = sr_df['sr_smooth']
            sr_mean = sr_series.mean()
            sr_median = sr_series.median()
            sr_min = sr_series.min()
            sr_max = sr_series.max()
            sr_std = sr_series.std()

            # Get losses
            losses = per_inverter_losses.get(inv_id)

            # Get anomalies
            anomalies = per_inverter_anomalies.get(inv_id, [])

            # Calculate fleet comparison
            deviation = (sr_mean - fleet_sr_mean) / fleet_sr_mean * 100
            z_score = (sr_mean - fleet_sr_mean) / fleet_sr_std if fleet_sr_std > 0 else 0

            # Classify severity based on multiple criteria
            criteria_failed = 0
            if deviation < -15:
                criteria_failed += 1
            if z_score < -2:
                criteria_failed += 1
            if len(anomalies) > 5:
                criteria_failed += 1
            if sr_std > 0.05:
                criteria_failed += 1

            if criteria_failed >= 4:
                severity = "Critical"
            elif criteria_failed >= 3:
                severity = "Major"
            elif criteria_failed >= 2:
                severity = "Minor"
            else:
                severity = "Normal"

            # Get original column for power statistics
            inv_col = None
            for col in self.inverter_columns:
                if inv_id in col or inv_id_clean in col:
                    inv_col = col
                    break

            # Calculate performance metrics
            total_records = len(sr_df)
            valid_records = sr_series.notna().sum()
            data_completeness = valid_records / total_records * 100 if total_records > 0 else 0

            avg_power_normalized = sr_df.iloc[:, 0].mean() if len(sr_df.columns) > 0 else sr_mean
            production_rate = (sr_df.iloc[:, 0] > 0).mean() if len(sr_df.columns) > 0 else 0.9

            # Create metrics object
            metrics = InverterSoilingMetrics(
                inverter_id=inv_id_clean,
                group_id=group_id,
                sr_mean=sr_mean,
                sr_median=sr_median,
                sr_min=sr_min,
                sr_max=sr_max,
                sr_std=sr_std,
                soiling_loss_pct=losses.soiling_loss_pct if losses else 0,
                temperature_loss_pct=losses.temperature_loss_pct if losses else 0,
                spectral_loss_pct=losses.spectral_loss_pct if losses else 0,
                inverter_loss_pct=losses.inverter_loss_pct if losses else 0,
                wiring_bop_loss_pct=losses.wiring_bop_loss_pct if losses else 0,
                degradation_loss_pct=losses.degradation_loss_pct if losses else 0,
                total_loss_pct=losses.total_loss_pct if losses else 0,
                reference_energy_kwh=losses.reference_energy if losses else 0,
                net_energy_kwh=losses.net_energy if losses else 0,
                soiling_energy_loss_kwh=losses.soiling_energy_loss if losses else 0,
                anomaly_count=len(anomalies),
                anomaly_rate_pct=len(anomalies) / total_records * 100 if total_records > 0 else 0,
                anomaly_periods=anomalies,
                performance_ratio=sr_mean,
                avg_power_normalized=avg_power_normalized,
                capacity_factor=avg_power_normalized * 0.25,  # Rough estimate
                availability_pct=data_completeness,
                production_rate=production_rate,
                data_completeness_pct=data_completeness,
                valid_records=valid_records,
                total_records=total_records,
                fleet_rank=rank,
                deviation_from_fleet_mean_pct=deviation,
                z_score=z_score,
                severity=severity,
                analysis_start=str(sr_df.index.min())[:10] if len(sr_df) > 0 else None,
                analysis_end=str(sr_df.index.max())[:10] if len(sr_df) > 0 else None,
                generated_at=datetime.now().isoformat(),
            )

            inverter_metrics[inv_id_clean] = metrics

        self.inverter_metrics = inverter_metrics
        print(f"   ✅ Compiled metrics for {len(inverter_metrics)} inverters")

        return inverter_metrics

    def calculate_fleet_summary(self) -> FleetSoilingSummary:
        """
        Calculate fleet-wide summary from per-inverter metrics.

        Returns:
        --------
        FleetSoilingSummary
            Fleet-wide summary
        """
        print("\n📊 Calculating fleet summary...")

        if not self.inverter_metrics:
            raise ValueError("Run analyze_all_inverters() first")

        metrics_list = list(self.inverter_metrics.values())

        # Extract unique groups
        groups = sorted(set(m.group_id for m in metrics_list))

        # Calculate fleet statistics
        sr_means = [m.sr_mean for m in metrics_list]

        # Health distribution
        health_counts = {"Normal": 0, "Minor": 0, "Major": 0, "Critical": 0}
        for m in metrics_list:
            if m.severity == "Normal":
                health_counts["Normal"] += 1
            elif m.severity == "Minor":
                health_counts["Minor"] += 1
            elif m.severity == "Major":
                health_counts["Major"] += 1
            else:
                health_counts["Critical"] += 1

        # Group-level metrics
        group_metrics = {}
        for group in groups:
            group_inverters = [m for m in metrics_list if m.group_id == group]
            group_sr_means = [m.sr_mean for m in group_inverters]
            group_normal = sum(1 for m in group_inverters if m.severity == "Normal")

            group_metrics[group] = {
                "inverterCount": len(group_inverters),
                "srMean": round(np.mean(group_sr_means), 4),
                "srStd": round(np.std(group_sr_means), 4),
                "healthScore": round(group_normal / len(group_inverters) * 100, 1) if group_inverters else 0,
            }

        # Top/worst performers
        sorted_by_sr = sorted(metrics_list, key=lambda m: m.sr_mean, reverse=True)
        top_performers = [
            {"inverterId": m.inverter_id, "srMean": round(m.sr_mean, 4), "rank": i+1}
            for i, m in enumerate(sorted_by_sr[:5])
        ]
        worst_performers = [
            {"inverterId": m.inverter_id, "srMean": round(m.sr_mean, 4), "rank": len(sorted_by_sr) - i}
            for i, m in enumerate(sorted_by_sr[-5:][::-1])
        ]

        # Total energy losses
        total_soiling_loss = sum(m.soiling_energy_loss_kwh for m in metrics_list)
        total_ref_energy = sum(m.reference_energy_kwh for m in metrics_list)
        total_net_energy = sum(m.net_energy_kwh for m in metrics_list)
        total_loss = total_ref_energy - total_net_energy

        # Anomaly summary
        total_anomalies = sum(m.anomaly_count for m in metrics_list)
        inverters_with_anomalies = sum(1 for m in metrics_list if m.anomaly_count > 0)

        # Economic impact (using config rates)
        electricity_rate = self.config.get('electricity_rate_per_MWh', 65)
        cleaning_cost = self.config.get('cleaning_cost_per_MW', 600) * self.config.get('capacity_MW', 9.0)

        # Annualize losses
        if metrics_list and metrics_list[0].analysis_start and metrics_list[0].analysis_end:
            try:
                start = datetime.fromisoformat(metrics_list[0].analysis_start)
                end = datetime.fromisoformat(metrics_list[0].analysis_end)
                total_days = (end - start).days
                annual_factor = 365 / total_days if total_days > 0 else 1
            except:
                total_days = 365
                annual_factor = 1
        else:
            total_days = 365
            annual_factor = 1

        annual_soiling_loss_mwh = total_soiling_loss / 1000 * annual_factor
        estimated_annual_loss_eur = annual_soiling_loss_mwh * electricity_rate

        # ROI potential (assuming 3 cleanings @ 95% effectiveness)
        cleaning_roi = max(0, estimated_annual_loss_eur * 0.7 - 3 * cleaning_cost)

        plant_name = self.config.get('name', 'Unknown')
        self.fleet_summary = FleetSoilingSummary(
            plant_id=plant_name.lower().replace(' ', '_').replace('(', '').replace(')', ''),
            plant_name=plant_name,
            capacity_mw=self.config.get('capacity_MW', 9.0),
            total_inverters=len(metrics_list),
            inverter_groups=groups,
            analysis_start=metrics_list[0].analysis_start if metrics_list else None,
            analysis_end=metrics_list[0].analysis_end if metrics_list else None,
            total_days=total_days,
            fleet_sr_mean=np.mean(sr_means),
            fleet_sr_std=np.std(sr_means),
            fleet_sr_min=min(sr_means),
            fleet_sr_max=max(sr_means),
            fleet_total_soiling_loss_mwh=total_soiling_loss / 1000,
            fleet_total_loss_mwh=total_loss / 1000,
            fleet_reference_energy_mwh=total_ref_energy / 1000,
            fleet_net_energy_mwh=total_net_energy / 1000,
            inverters_normal=health_counts["Normal"],
            inverters_minor_issues=health_counts["Minor"],
            inverters_major_issues=health_counts["Major"],
            inverters_critical=health_counts["Critical"],
            group_metrics=group_metrics,
            top_performers=top_performers,
            worst_performers=worst_performers,
            total_anomalies=total_anomalies,
            inverters_with_anomalies=inverters_with_anomalies,
            estimated_annual_loss_eur=estimated_annual_loss_eur,
            cleaning_roi_potential_eur=cleaning_roi,
            generated_at=datetime.now().isoformat(),
        )

        print(f"   ✅ Fleet summary calculated")
        return self.fleet_summary

    def export_to_json(self) -> None:
        """
        Export all results to static JSON files.

        Creates:
        - fleet_summary.json
        - inverters/*.json (one per inverter)
        - time_series/*.json (aggregated time series)
        """
        print("\n📁 Exporting to JSON...")

        # Create output directories
        self.output_dir.mkdir(parents=True, exist_ok=True)
        (self.output_dir / "inverters").mkdir(exist_ok=True)
        (self.output_dir / "time_series").mkdir(exist_ok=True)
        (self.output_dir / "charts").mkdir(exist_ok=True)

        # Export fleet summary
        if self.fleet_summary:
            summary_dict = self.fleet_summary.to_dict()
            if self.irradiance_source:
                summary_dict["dataProvenance"] = {
                    "irradianceSource": self.irradiance_source,
                    **{k: self.weather_provenance[k]
                       for k in ("confidence", "irradiance_plane", "timezone",
                                 "geometry_defaulted", "coverage")
                       if k in self.weather_provenance},
                }
            with open(self.output_dir / "fleet_summary.json", 'w') as f:
                json.dump(summary_dict, f, indent=2)
            print(f"   Saved fleet_summary.json")

        # Export per-inverter metrics
        for inv_id, metrics in self.inverter_metrics.items():
            # Clean filename
            filename = inv_id.replace(' ', '_').replace('.', '_') + '.json'
            with open(self.output_dir / "inverters" / filename, 'w') as f:
                json.dump(metrics.to_dict(), f, indent=2)

        print(f"   Saved {len(self.inverter_metrics)} inverter JSON files")

        # Export aggregated time series (daily SR)
        if self.df is not None:
            self._export_time_series_json()

        print(f"   ✅ JSON export complete to {self.output_dir}")

    def _export_time_series_json(self) -> None:
        """Export aggregated time series data for charts."""
        # Daily average SR per inverter (sampled for frontend performance)
        daily_data = []

        for inv_col in self.inverter_columns[:50]:  # Limit for performance
            inv_id, _ = self._extract_inverter_id(inv_col)
            inv_daily = self.df[inv_col].resample('D').mean()

            for date, value in inv_daily.items():
                if pd.notna(value):
                    daily_data.append({
                        "date": str(date)[:10],
                        "inverterId": inv_id,
                        "sr": round(float(value), 4),
                    })

        # Save daily SR
        with open(self.output_dir / "time_series" / "daily_soiling_ratio.json", 'w') as f:
            json.dump({"data": daily_data}, f)

        print(f"   Saved daily_soiling_ratio.json ({len(daily_data)} records)")

    def run_analysis(
        self,
        filepath: str
    ) -> Tuple[Dict[str, InverterSoilingMetrics], FleetSoilingSummary]:
        """
        Run complete analysis pipeline.

        Parameters:
        -----------
        filepath : str
            Path to parquet data file

        Returns:
        --------
        Tuple[Dict[str, InverterSoilingMetrics], FleetSoilingSummary]
            Per-inverter metrics and fleet summary
        """
        print("=" * 60)
        print("🔌 Starting Per-Inverter Soiling Analysis")
        print("=" * 60)

        # Load data
        self.load_data(filepath)

        # Analyze all inverters
        self.analyze_all_inverters()

        # Calculate fleet summary
        self.calculate_fleet_summary()

        # Export to JSON
        self.export_to_json()

        # Print summary
        self._print_summary()

        return self.inverter_metrics, self.fleet_summary

    def _print_summary(self) -> None:
        """Print analysis summary to console."""
        if not self.fleet_summary:
            return

        fs = self.fleet_summary

        print("\n" + "=" * 60)
        print("📊 PER-INVERTER ANALYSIS SUMMARY")
        print("=" * 60)

        print(f"\n✅ Analysis Complete:")
        print(f"   • Plant: {fs.plant_name}")
        print(f"   • Inverters analyzed: {fs.total_inverters}")
        print(f"   • Fleet SR mean: {fs.fleet_sr_mean:.3f} ± {fs.fleet_sr_std:.3f}")
        print(f"   • Analysis period: {fs.analysis_start} to {fs.analysis_end}")

        print(f"\n🏥 Health Distribution:")
        print(f"   • Normal: {fs.inverters_normal} ({fs.inverters_normal/fs.total_inverters*100:.1f}%)")
        print(f"   • Minor Issues: {fs.inverters_minor_issues}")
        print(f"   • Major Issues: {fs.inverters_major_issues}")
        print(f"   • Critical: {fs.inverters_critical}")

        print(f"\n💰 Economic Impact:")
        print(f"   • Estimated annual soiling loss: €{fs.estimated_annual_loss_eur:,.0f}")
        print(f"   • Cleaning ROI potential: €{fs.cleaning_roi_potential_eur:,.0f}")

        print(f"\n📁 Output saved to: {self.output_dir}")
        print("\n🎉 Per-inverter analysis complete!")


def compare_per_inverter_methods(
    df_inverters: pd.DataFrame,
    model1: Any,
    model2: Any,
    dustiq_per_inverter: Optional[Dict[str, pd.Series]] = None,
    model1_name: str = "Method 1",
    model2_name: str = "Method 2"
) -> Dict[str, Dict[str, float]]:
    """
    Compare two soiling methods at per-inverter level.

    Parameters
    ----------
    df_inverters : pd.DataFrame
        Per-inverter data with features
    model1 : SoilingRatioModel
        First method's model
    model2 : SoilingRatioModel
        Second method's model
    dustiq_per_inverter : dict, optional
        Ground truth {inverter_id: SR series} if available
    model1_name, model2_name : str
        Names for the methods

    Returns
    -------
    dict
        {
            'INV 01.001': {
                'mae_method1': float,
                'mae_method2': float,
                'r2_method1': float,
                'r2_method2': float,
                'winner': str,
                'improvement_pct': float
            },
            ...
            'fleet_summary': {
                'method1_avg_mae': float,
                'method2_avg_mae': float,
                'method1_wins': int,
                'method2_wins': int,
                'ties': int
            }
        }
    """
    from sklearn.metrics import mean_absolute_error, r2_score

    comparison_results = {}
    method1_wins = 0
    method2_wins = 0
    ties = 0
    all_mae1 = []
    all_mae2 = []

    # Get unique inverter IDs
    inverter_cols = [col for col in df_inverters.columns if 'INV' in col and 'Power' in col]

    for inv_col in inverter_cols:
        # Extract inverter ID
        import re
        match = re.search(r'INV\s*(\d+)\.(\d+)', inv_col)
        if not match:
            continue

        inv_id = f"INV {match.group(1).zfill(2)}.{match.group(2).zfill(3)}"

        # Get inverter data
        inv_data = df_inverters[[inv_col]].dropna()

        if len(inv_data) < 100:
            continue

        # If we have ground truth for this inverter
        if dustiq_per_inverter and inv_id in dustiq_per_inverter:
            y_true = dustiq_per_inverter[inv_id]

            # Align
            common_idx = inv_data.index.intersection(y_true.index)
            if len(common_idx) < 50:
                continue

            inv_data_aligned = inv_data.loc[common_idx]
            y_true_aligned = y_true.loc[common_idx]

            # Predict with both models (simplified - would need full feature set)
            # For now, use the power values as proxy
            # In real implementation, would generate full feature set per inverter

            # Method 1 predictions
            try:
                y_pred1 = model1.predict(inv_data_aligned)
                if isinstance(y_pred1, np.ndarray):
                    y_pred1 = pd.Series(y_pred1, index=common_idx)
            except:
                continue

            # Method 2 predictions
            try:
                y_pred2 = model2.predict(inv_data_aligned)
                if isinstance(y_pred2, np.ndarray):
                    y_pred2 = pd.Series(y_pred2, index=common_idx)
            except:
                continue

            # Calculate metrics
            mae1 = mean_absolute_error(y_true_aligned, y_pred1)
            mae2 = mean_absolute_error(y_true_aligned, y_pred2)
            r2_1 = r2_score(y_true_aligned, y_pred1)
            r2_2 = r2_score(y_true_aligned, y_pred2)

            all_mae1.append(mae1)
            all_mae2.append(mae2)

            # Determine winner
            if mae1 < mae2 * 0.95:  # Method 1 is >5% better
                winner = model1_name
                method1_wins += 1
            elif mae2 < mae1 * 0.95:  # Method 2 is >5% better
                winner = model2_name
                method2_wins += 1
            else:
                winner = "Tie"
                ties += 1

            improvement_pct = (mae1 - mae2) / mae2 * 100 if mae2 > 0 else 0

            comparison_results[inv_id] = {
                'mae_method1': float(mae1),
                'mae_method2': float(mae2),
                'r2_method1': float(r2_1),
                'r2_method2': float(r2_2),
                'winner': winner,
                'improvement_pct': float(improvement_pct),
                'n_samples': len(y_true_aligned)
            }

    # Fleet summary
    comparison_results['fleet_summary'] = {
        'method1_avg_mae': float(np.mean(all_mae1)) if all_mae1 else 0.0,
        'method2_avg_mae': float(np.mean(all_mae2)) if all_mae2 else 0.0,
        'method1_wins': method1_wins,
        'method2_wins': method2_wins,
        'ties': ties,
        'total_inverters': len(all_mae1),
        'method1_win_rate': method1_wins / max(len(all_mae1), 1),
        'method2_win_rate': method2_wins / max(len(all_mae1), 1)
    }

    return comparison_results