"""
Loss Disaggregator - Power loss decomposition using multi-signal digital twins.

This module decomposes total power losses into distinct categories:
- Soiling (uniform dirt accumulation)
- Thermal (temperature-related efficiency loss)
- Shading (partial shading, non-uniform)
- Curtailment (grid-imposed power limits)
- Clipping (inverter at max capacity)
- Equipment faults (string failures, degradation)

The key insight is that soiling has a unique signature:
- Low current CV (uniform across strings)
- Normal temperature deviation
- Normal voltage behavior
- Gradual accumulation over days/weeks

By "peeling off" other loss categories, we isolate soiling losses.

Usage:
    from nuravolt.digitaltwin.loss_disaggregator import LossDisaggregator

    disaggregator = LossDisaggregator(plant_id="alpha")
    disaggregator.load_twins()

    results = disaggregator.analyze(df_scada)
    # Returns daily disaggregated losses per inverter
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
import polars as pl

logger = logging.getLogger(__name__)


@dataclass
class LossComponents:
    """Disaggregated power loss components for a time period."""

    timestamp: datetime
    inverter_id: str

    # Raw values
    power_expected: float  # From physics model (W)
    power_actual: float    # Measured power (W)
    power_loss_total: float  # P_expected - P_actual (W)
    power_loss_pct: float    # Loss as percentage

    # Disaggregated components (as percentage of expected power)
    loss_thermal_pct: float = 0.0      # Temperature-related losses
    loss_shading_pct: float = 0.0      # Non-uniform shading
    loss_curtailment_pct: float = 0.0  # Grid curtailment
    loss_clipping_pct: float = 0.0     # Inverter clipping
    loss_equipment_pct: float = 0.0    # Equipment faults
    loss_soiling_pct: float = 0.0      # Residual = soiling + degradation

    # Detection flags
    is_curtailed: bool = False
    is_clipping: bool = False
    is_shading: bool = False
    is_thermal_anomaly: bool = False
    is_equipment_fault: bool = False

    # Twin outputs used for detection
    temp_deviation: Optional[float] = None
    current_cv: Optional[float] = None
    current_imbalance: Optional[float] = None
    voltage_cv: Optional[float] = None
    voltage_deviation: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat() if hasattr(self.timestamp, "isoformat") else str(self.timestamp),
            "inverter_id": self.inverter_id,
            "power_expected": round(self.power_expected, 1),
            "power_actual": round(self.power_actual, 1),
            "power_loss_pct": round(self.power_loss_pct, 2),
            "loss_thermal_pct": round(self.loss_thermal_pct, 2),
            "loss_shading_pct": round(self.loss_shading_pct, 2),
            "loss_curtailment_pct": round(self.loss_curtailment_pct, 2),
            "loss_clipping_pct": round(self.loss_clipping_pct, 2),
            "loss_equipment_pct": round(self.loss_equipment_pct, 2),
            "loss_soiling_pct": round(self.loss_soiling_pct, 2),
            "is_curtailed": self.is_curtailed,
            "is_clipping": self.is_clipping,
            "is_shading": self.is_shading,
            "is_thermal_anomaly": self.is_thermal_anomaly,
            "is_equipment_fault": self.is_equipment_fault,
            "temp_deviation": round(self.temp_deviation, 2) if self.temp_deviation else None,
            "current_cv": round(self.current_cv, 4) if self.current_cv else None,
        }


@dataclass
class DailyLossSummary:
    """Daily aggregated loss summary for an inverter."""

    date: str
    inverter_id: str

    # Energy values (Wh)
    energy_expected: float
    energy_actual: float
    energy_loss_total: float

    # Disaggregated losses (% of expected)
    loss_thermal_pct: float
    loss_shading_pct: float
    loss_curtailment_pct: float
    loss_clipping_pct: float
    loss_equipment_pct: float
    loss_soiling_pct: float  # Residual after peeling off other losses

    # Soiling ratio (comparable to DustIQ)
    # SR = 1 - (soiling_loss / 100), clamped to [0.8, 1.0]
    soiling_ratio: float = 1.0

    # Detection statistics
    hours_curtailed: float = 0
    hours_clipping: float = 0
    hours_shading: float = 0
    hours_thermal_anomaly: float = 0
    hours_equipment_fault: float = 0

    # Quality metrics
    n_samples: int = 0
    avg_current_cv: float = 0
    avg_temp_deviation: float = 0

    def to_dict(self) -> dict:
        return {
            "date": self.date,
            "inverter_id": self.inverter_id,
            "energy_expected_kwh": round(self.energy_expected / 1000, 2),
            "energy_actual_kwh": round(self.energy_actual / 1000, 2),
            "loss_total_pct": round((self.energy_expected - self.energy_actual) / self.energy_expected * 100, 2) if self.energy_expected > 0 else 0,
            "loss_thermal_pct": round(self.loss_thermal_pct, 2),
            "loss_shading_pct": round(self.loss_shading_pct, 2),
            "loss_curtailment_pct": round(self.loss_curtailment_pct, 2),
            "loss_clipping_pct": round(self.loss_clipping_pct, 2),
            "loss_equipment_pct": round(self.loss_equipment_pct, 2),
            "loss_soiling_pct": round(self.loss_soiling_pct, 2),
            "soiling_ratio": round(self.soiling_ratio, 4),
            "hours_curtailed": round(self.hours_curtailed, 1),
            "hours_clipping": round(self.hours_clipping, 1),
            "hours_shading": round(self.hours_shading, 1),
            "avg_current_cv": round(self.avg_current_cv, 4),
            "avg_temp_deviation": round(self.avg_temp_deviation, 2),
            "n_samples": self.n_samples,
        }


@dataclass
class SoilingEstimate:
    """
    Soiling ratio estimate with rolling average smoothing.

    Designed to be directly comparable with DustIQ measurements.
    """
    date: str

    # Raw daily soiling ratio from disaggregation
    sr_daily: float

    # Smoothed soiling ratios (rolling averages)
    sr_3d: float   # 3-day rolling average
    sr_7d: float   # 7-day rolling average
    sr_14d: float  # 14-day rolling average (best for comparison with DustIQ)

    # Confidence based on data quality
    confidence: float  # 0-1, based on n_samples and current_cv stability

    # Detection flags
    rain_recovery: bool = False  # Sharp SR increase suggests rain cleaning
    cleaning_event: bool = False  # Very sharp SR increase suggests manual cleaning

    def to_dict(self) -> dict:
        return {
            "date": self.date,
            "sr_daily": round(self.sr_daily, 4),
            "sr_3d": round(self.sr_3d, 4),
            "sr_7d": round(self.sr_7d, 4),
            "sr_14d": round(self.sr_14d, 4),
            "confidence": round(self.confidence, 3),
            "rain_recovery": self.rain_recovery,
            "cleaning_event": self.cleaning_event,
        }


class LossDisaggregator:
    """
    Disaggregates power losses using multi-signal digital twin outputs.

    The disaggregation follows a sequential "peeling" approach:
    1. Detect curtailment (power plateau while irradiance increases)
    2. Detect clipping (voltage/power at inverter limits)
    3. Calculate thermal losses (from temperature deviation)
    4. Detect shading (high current CV = non-uniform)
    5. Detect equipment faults (current imbalance, voltage anomalies)
    6. Residual = soiling + long-term degradation

    Parameters
    ----------
    plant_id : str
        Plant identifier for loading twins
    twins_path : Path, optional
        Path to trained twin models

    Thresholds (configurable):
    - temp_deviation_threshold: °C above expected to flag thermal anomaly (default: 5)
    - current_cv_threshold: CV above which indicates shading (default: 0.05)
    - current_imbalance_threshold: Imbalance ratio for equipment fault (default: 0.2)
    - voltage_cv_threshold: CV above which indicates equipment issue (default: 0.03)
    - curtailment_detection_window: Minutes of flat power to detect curtailment (default: 15)
    - clipping_power_threshold: Fraction of rated power for clipping (default: 0.98)
    """

    def __init__(
        self,
        plant_id: str,
        twins_path: Optional[Path] = None,
        # Thermal thresholds
        temp_deviation_threshold: float = 5.0,  # °C
        thermal_loss_coeff: float = 0.004,  # 0.4% per °C (typical silicon)
        # Current thresholds (shading vs soiling)
        current_cv_threshold: float = 0.05,  # 5% CV = non-uniform = shading
        current_imbalance_threshold: float = 0.2,  # 20% imbalance = fault
        # Voltage thresholds
        voltage_cv_threshold: float = 0.03,  # 3% CV = equipment issue
        # Curtailment/clipping
        curtailment_plateau_threshold: float = 0.02,  # 2% variation = flat
        clipping_power_threshold: float = 0.98,  # 98% of rated = clipping
        # Inverter specs (can be overridden per plant)
        inverter_power_rating: float = 100_000,  # W (100 kW default)
    ):
        self.plant_id = plant_id
        self.twins_path = twins_path or Path(f"public/data/digitaltwin/{plant_id}")

        # Thresholds
        self.temp_deviation_threshold = temp_deviation_threshold
        self.thermal_loss_coeff = thermal_loss_coeff
        self.current_cv_threshold = current_cv_threshold
        self.current_imbalance_threshold = current_imbalance_threshold
        self.voltage_cv_threshold = voltage_cv_threshold
        self.curtailment_plateau_threshold = curtailment_plateau_threshold
        self.clipping_power_threshold = clipping_power_threshold
        self.inverter_power_rating = inverter_power_rating

        # Loaded twins
        self.twins: Dict[str, "MultiSignalTwinFactory"] = {}
        self._twins_loaded = False

    def load_twins(self, inverter_ids: Optional[List[str]] = None) -> int:
        """
        Load trained multi-signal twins for the plant.

        Args:
            inverter_ids: Specific inverters to load (None = all available)

        Returns:
            Number of twins loaded
        """
        from nuravolt.digitaltwin.multi_signal_twin import MultiSignalTwinFactory

        if not self.twins_path.exists():
            raise FileNotFoundError(f"Twins path not found: {self.twins_path}")

        # Find all factory meta files
        meta_files = list(self.twins_path.glob("*_factory_meta.pkl"))

        if not meta_files:
            raise FileNotFoundError(f"No trained twins found in {self.twins_path}")

        loaded = 0
        for meta_file in meta_files:
            inverter_id = meta_file.stem.replace("_factory_meta", "")

            if inverter_ids and inverter_id not in inverter_ids:
                continue

            try:
                twin = MultiSignalTwinFactory.load(self.twins_path, inverter_id)
                self.twins[inverter_id] = twin
                loaded += 1
            except Exception as e:
                logger.warning(f"Failed to load twin for {inverter_id}: {e}")

        self._twins_loaded = loaded > 0
        logger.info(f"Loaded {loaded} twins for {self.plant_id}")
        return loaded

    def analyze_timestamp(
        self,
        row: dict,
        inverter_id: str,
        twin_outputs: Optional[dict] = None,
    ) -> LossComponents:
        """
        Analyze a single timestamp for loss disaggregation.

        Args:
            row: Data row with power, irradiance, etc.
            inverter_id: Inverter ID
            twin_outputs: Pre-computed twin outputs (optional)

        Returns:
            LossComponents with disaggregated losses
        """
        timestamp = row.get("timestamp", datetime.now())
        power_actual = row.get("power", 0) or 0
        power_expected = row.get("power_expected", power_actual) or power_actual
        irradiance = row.get("irradiance", 0) or 0

        # Skip nighttime
        if irradiance < 50 or power_expected <= 0:
            return LossComponents(
                timestamp=timestamp,
                inverter_id=inverter_id,
                power_expected=0,
                power_actual=0,
                power_loss_total=0,
                power_loss_pct=0,
            )

        # Total loss
        power_loss = max(0, power_expected - power_actual)
        power_loss_pct = (power_loss / power_expected * 100) if power_expected > 0 else 0

        # Get twin outputs
        temp_deviation = twin_outputs.get("temp_deviation") if twin_outputs else row.get("temp_deviation")
        current_cv = twin_outputs.get("current_cv") if twin_outputs else row.get("current_cv")
        current_imbalance = twin_outputs.get("current_imbalance_ratio") if twin_outputs else row.get("current_imbalance_ratio")
        voltage_cv = twin_outputs.get("voltage_cv") if twin_outputs else row.get("voltage_cv")
        voltage_deviation = twin_outputs.get("voltage_deviation") if twin_outputs else row.get("voltage_deviation")

        # Initialize loss components
        loss_thermal = 0.0
        loss_shading = 0.0
        loss_curtailment = 0.0
        loss_clipping = 0.0
        loss_equipment = 0.0

        # Detection flags
        is_curtailed = False
        is_clipping = False
        is_shading = False
        is_thermal_anomaly = False
        is_equipment_fault = False

        remaining_loss = power_loss_pct

        # 1. CLIPPING DETECTION
        # Power near inverter rating AND voltage at limit
        power_ratio = power_actual / self.inverter_power_rating if self.inverter_power_rating > 0 else 0
        if power_ratio >= self.clipping_power_threshold:
            is_clipping = True
            # Estimate clipping loss: difference between what we could produce and what we're limited to
            # This is approximate - would need more data for precise calculation
            loss_clipping = min(remaining_loss, power_loss_pct * 0.5)  # Cap at 50% of total loss
            remaining_loss -= loss_clipping

        # 2. CURTAILMENT DETECTION
        # Would need time-series context for proper detection (power plateau while G increases)
        # For now, use flag if provided in data
        if row.get("curtailment_flag") or row.get("is_curtailed"):
            is_curtailed = True
            loss_curtailment = min(remaining_loss, power_loss_pct * 0.8)
            remaining_loss -= loss_curtailment

        # 3. THERMAL LOSS CALCULATION
        if temp_deviation is not None:
            if abs(temp_deviation) > self.temp_deviation_threshold:
                is_thermal_anomaly = True
            # Calculate thermal loss: ~0.4% per °C above expected
            # Only count positive deviation (overheating causes loss)
            if temp_deviation > 0:
                loss_thermal = min(remaining_loss, temp_deviation * self.thermal_loss_coeff * 100)
                remaining_loss -= loss_thermal

        # 4. EQUIPMENT FAULT DETECTION
        # High current imbalance OR high voltage CV
        if current_imbalance is not None and current_imbalance > self.current_imbalance_threshold:
            is_equipment_fault = True
            # Estimate loss from the imbalanced string
            loss_equipment = min(remaining_loss, current_imbalance * 100 * 0.5)
            remaining_loss -= loss_equipment
        elif voltage_cv is not None and voltage_cv > self.voltage_cv_threshold:
            is_equipment_fault = True
            loss_equipment = min(remaining_loss, voltage_cv * 100 * 2)
            remaining_loss -= loss_equipment

        # 5. SHADING DETECTION
        # High current CV indicates non-uniform light (shading, not soiling)
        if current_cv is not None and current_cv > self.current_cv_threshold:
            is_shading = True
            # Shading loss proportional to CV
            loss_shading = min(remaining_loss, current_cv * 100 * 1.5)
            remaining_loss -= loss_shading

        # 6. SOILING = RESIDUAL
        # What remains after peeling off all other losses
        loss_soiling = max(0, remaining_loss)

        return LossComponents(
            timestamp=timestamp,
            inverter_id=inverter_id,
            power_expected=power_expected,
            power_actual=power_actual,
            power_loss_total=power_loss,
            power_loss_pct=power_loss_pct,
            loss_thermal_pct=loss_thermal,
            loss_shading_pct=loss_shading,
            loss_curtailment_pct=loss_curtailment,
            loss_clipping_pct=loss_clipping,
            loss_equipment_pct=loss_equipment,
            loss_soiling_pct=loss_soiling,
            is_curtailed=is_curtailed,
            is_clipping=is_clipping,
            is_shading=is_shading,
            is_thermal_anomaly=is_thermal_anomaly,
            is_equipment_fault=is_equipment_fault,
            temp_deviation=temp_deviation,
            current_cv=current_cv,
            current_imbalance=current_imbalance,
            voltage_cv=voltage_cv,
            voltage_deviation=voltage_deviation,
        )

    def analyze_inverter(
        self,
        df: pl.DataFrame,
        inverter_id: str,
        power_col: str = "power",
        irradiance_col: str = "irradiance",
        ambient_temp_col: str = "ambient_temp",
        use_twins: bool = True,
    ) -> pl.DataFrame:
        """
        Analyze an inverter's data and disaggregate losses.

        Args:
            df: Time-series data for the inverter
            inverter_id: Inverter ID
            power_col: Power column name
            irradiance_col: Irradiance column name
            ambient_temp_col: Ambient temperature column name
            use_twins: Whether to use loaded twins for predictions

        Returns:
            DataFrame with disaggregated loss columns
        """
        if use_twins and inverter_id in self.twins:
            twin = self.twins[inverter_id]

            # Run twin predictions to get expected values and deviations
            df_with_predictions = twin.predict(
                df,
                irradiance_col=irradiance_col,
                ambient_temp_col=ambient_temp_col,
            )
        else:
            df_with_predictions = df

        # Calculate power expected using simple physics if not available
        if "power_expected" not in df_with_predictions.columns:
            # Simple model: P_expected ∝ G × (1 - 0.004 × (T - 25))
            if "module_temp" in df_with_predictions.columns:
                temp_col = "module_temp"
            else:
                temp_col = ambient_temp_col

            # Get reference power at STC (estimate from max observed)
            max_power = df_with_predictions[power_col].max()

            df_with_predictions = df_with_predictions.with_columns([
                (
                    pl.col(irradiance_col) / 1000 * max_power *
                    (1 - 0.004 * (pl.col(temp_col) - 25))
                ).clip(0, max_power * 1.1).alias("power_expected")
            ])

        # Analyze each row
        results = []
        for row in df_with_predictions.iter_rows(named=True):
            loss = self.analyze_timestamp(row, inverter_id)
            results.append(loss.to_dict())

        # Convert to DataFrame
        df_results = pl.DataFrame(results)

        return df_results

    def analyze_daily(
        self,
        df: pl.DataFrame,
        inverter_id: str,
        **kwargs,
    ) -> List[DailyLossSummary]:
        """
        Analyze and aggregate losses by day.

        Args:
            df: Time-series data
            inverter_id: Inverter ID
            **kwargs: Passed to analyze_inverter

        Returns:
            List of daily loss summaries
        """
        # Get disaggregated results
        df_results = self.analyze_inverter(df, inverter_id, **kwargs)

        # Add date column
        df_results = df_results.with_columns([
            pl.col("timestamp").str.slice(0, 10).alias("date")
        ])

        # Aggregate by day
        daily_summaries = []

        for date in df_results["date"].unique().sort():
            df_day = df_results.filter(pl.col("date") == date)

            # Skip days with insufficient data
            if len(df_day) < 10:
                continue

            # Calculate energy (sum of power × time_step)
            # Assuming hourly data for simplicity
            time_step_hours = 1.0  # Could be calculated from timestamps

            energy_expected = df_day["power_expected"].sum() * time_step_hours
            energy_actual = df_day["power_actual"].sum() * time_step_hours

            # Weighted average of loss percentages (weighted by expected power)
            weights = df_day["power_expected"].to_numpy()
            total_weight = weights.sum()

            if total_weight > 0:
                loss_thermal = (df_day["loss_thermal_pct"].to_numpy() * weights).sum() / total_weight
                loss_shading = (df_day["loss_shading_pct"].to_numpy() * weights).sum() / total_weight
                loss_curtailment = (df_day["loss_curtailment_pct"].to_numpy() * weights).sum() / total_weight
                loss_clipping = (df_day["loss_clipping_pct"].to_numpy() * weights).sum() / total_weight
                loss_equipment = (df_day["loss_equipment_pct"].to_numpy() * weights).sum() / total_weight
                loss_soiling = (df_day["loss_soiling_pct"].to_numpy() * weights).sum() / total_weight
            else:
                loss_thermal = loss_shading = loss_curtailment = 0
                loss_clipping = loss_equipment = loss_soiling = 0

            # Count hours with each condition
            hours_curtailed = df_day["is_curtailed"].sum() * time_step_hours
            hours_clipping = df_day["is_clipping"].sum() * time_step_hours
            hours_shading = df_day["is_shading"].sum() * time_step_hours
            hours_thermal = df_day["is_thermal_anomaly"].sum() * time_step_hours
            hours_fault = df_day["is_equipment_fault"].sum() * time_step_hours

            # Quality metrics
            current_cv_values = df_day["current_cv"].drop_nulls()
            temp_dev_values = df_day["temp_deviation"].drop_nulls()

            daily_summaries.append(DailyLossSummary(
                date=date,
                inverter_id=inverter_id,
                energy_expected=energy_expected,
                energy_actual=energy_actual,
                energy_loss_total=energy_expected - energy_actual,
                loss_thermal_pct=loss_thermal,
                loss_shading_pct=loss_shading,
                loss_curtailment_pct=loss_curtailment,
                loss_clipping_pct=loss_clipping,
                loss_equipment_pct=loss_equipment,
                loss_soiling_pct=loss_soiling,
                hours_curtailed=hours_curtailed,
                hours_clipping=hours_clipping,
                hours_shading=hours_shading,
                hours_thermal_anomaly=hours_thermal,
                hours_equipment_fault=hours_fault,
                n_samples=len(df_day),
                avg_current_cv=current_cv_values.mean() if len(current_cv_values) > 0 else 0,
                avg_temp_deviation=temp_dev_values.mean() if len(temp_dev_values) > 0 else 0,
            ))

        return daily_summaries

    def analyze_plant(
        self,
        df: pl.DataFrame,
        inverter_id_col: str = "inverter_id",
        **kwargs,
    ) -> Dict[str, List[DailyLossSummary]]:
        """
        Analyze all inverters in a plant.

        Args:
            df: Plant-wide time-series data
            inverter_id_col: Column containing inverter IDs
            **kwargs: Passed to analyze_daily

        Returns:
            Dict mapping inverter_id to list of daily summaries
        """
        results = {}

        inverter_ids = df[inverter_id_col].unique().to_list()

        for inv_id in inverter_ids:
            df_inv = df.filter(pl.col(inverter_id_col) == inv_id)

            try:
                daily_results = self.analyze_daily(df_inv, inv_id, **kwargs)
                results[inv_id] = daily_results
            except Exception as e:
                logger.warning(f"Failed to analyze {inv_id}: {e}")

        return results

    def get_plant_summary(
        self,
        daily_results: Dict[str, List[DailyLossSummary]],
    ) -> pl.DataFrame:
        """
        Aggregate daily results into a plant-level summary.

        Args:
            daily_results: Output from analyze_plant

        Returns:
            DataFrame with plant-level daily summaries
        """
        all_rows = []

        for inv_id, summaries in daily_results.items():
            for summary in summaries:
                row = summary.to_dict()
                all_rows.append(row)

        if not all_rows:
            return pl.DataFrame()

        df = pl.DataFrame(all_rows)

        # Aggregate by date across all inverters
        plant_daily = df.group_by("date").agg([
            pl.col("energy_expected_kwh").sum().alias("energy_expected_kwh"),
            pl.col("energy_actual_kwh").sum().alias("energy_actual_kwh"),
            pl.col("loss_thermal_pct").mean().alias("loss_thermal_pct"),
            pl.col("loss_shading_pct").mean().alias("loss_shading_pct"),
            pl.col("loss_curtailment_pct").mean().alias("loss_curtailment_pct"),
            pl.col("loss_clipping_pct").mean().alias("loss_clipping_pct"),
            pl.col("loss_equipment_pct").mean().alias("loss_equipment_pct"),
            pl.col("loss_soiling_pct").mean().alias("loss_soiling_pct"),
            pl.col("hours_shading").mean().alias("avg_hours_shading"),
            pl.col("avg_current_cv").mean().alias("avg_current_cv"),
            pl.col("n_samples").sum().alias("n_samples"),
            pl.col("inverter_id").n_unique().alias("n_inverters"),
        ]).sort("date")

        # Add total loss
        plant_daily = plant_daily.with_columns([
            (
                (pl.col("energy_expected_kwh") - pl.col("energy_actual_kwh")) /
                pl.col("energy_expected_kwh") * 100
            ).alias("loss_total_pct")
        ])

        return plant_daily

    def compute_soiling_estimates(
        self,
        daily_results: Dict[str, List[DailyLossSummary]],
        windows: Tuple[int, int, int] = (3, 7, 14),
    ) -> pl.DataFrame:
        """
        Compute rolling average soiling estimates from daily disaggregation.

        Soiling accumulates gradually, so rolling averages reduce noise
        and provide estimates comparable to DustIQ sensors.

        Args:
            daily_results: Output from analyze_plant or analyze_daily
            windows: Rolling window sizes in days (default: 3, 7, 14)

        Returns:
            DataFrame with date, sr_daily, sr_3d, sr_7d, sr_14d, confidence
        """
        # Aggregate all inverters to plant level
        all_rows = []
        for inv_id, summaries in daily_results.items():
            for s in summaries:
                all_rows.append({
                    "date": s.date,
                    "inverter_id": inv_id,
                    "loss_soiling_pct": s.loss_soiling_pct,
                    "n_samples": s.n_samples,
                    "avg_current_cv": s.avg_current_cv,
                })

        if not all_rows:
            return pl.DataFrame()

        df = pl.DataFrame(all_rows)

        # Aggregate by date (average across inverters)
        daily_avg = df.group_by("date").agg([
            pl.col("loss_soiling_pct").mean().alias("loss_soiling_pct"),
            pl.col("n_samples").sum().alias("n_samples"),
            pl.col("avg_current_cv").mean().alias("avg_current_cv"),
            pl.col("inverter_id").n_unique().alias("n_inverters"),
        ]).sort("date")

        # Convert soiling loss % to soiling ratio
        # SR = 1 - (loss / 100), clamped to [0.7, 1.0] for realistic values
        daily_avg = daily_avg.with_columns([
            (1 - pl.col("loss_soiling_pct") / 100).clip(0.7, 1.0).alias("sr_daily")
        ])

        # Compute rolling averages
        w3, w7, w14 = windows
        daily_avg = daily_avg.with_columns([
            pl.col("sr_daily").rolling_mean(window_size=w3, min_periods=1).alias("sr_3d"),
            pl.col("sr_daily").rolling_mean(window_size=w7, min_periods=2).alias("sr_7d"),
            pl.col("sr_daily").rolling_mean(window_size=w14, min_periods=3).alias("sr_14d"),
        ])

        # Confidence based on data quality:
        # - More samples = higher confidence
        # - Lower current CV = more uniform = higher confidence (likely soiling, not shading)
        # - More inverters = higher confidence
        daily_avg = daily_avg.with_columns([
            (
                # Sample factor: log scale, max out at ~100 samples per inverter
                (pl.col("n_samples") / pl.col("n_inverters")).log().clip(0, 5) / 5 * 0.4 +
                # CV factor: low CV = high confidence
                (1 - pl.col("avg_current_cv").clip(0, 0.1) / 0.1) * 0.4 +
                # Inverter coverage factor
                (pl.col("n_inverters") / pl.col("n_inverters").max()).clip(0, 1) * 0.2
            ).clip(0, 1).alias("confidence")
        ])

        # Detect rain/cleaning events (sharp SR increase)
        daily_avg = daily_avg.with_columns([
            (pl.col("sr_daily") - pl.col("sr_daily").shift(1)).alias("sr_change")
        ])
        daily_avg = daily_avg.with_columns([
            (pl.col("sr_change") > 0.02).alias("rain_recovery"),  # >2% jump
            (pl.col("sr_change") > 0.05).alias("cleaning_event"),  # >5% jump
        ])

        return daily_avg.select([
            "date", "sr_daily", "sr_3d", "sr_7d", "sr_14d",
            "confidence", "rain_recovery", "cleaning_event",
            "loss_soiling_pct", "n_samples", "n_inverters"
        ])

    def compare_with_dustiq(
        self,
        soiling_estimates: pl.DataFrame,
        dustiq_path: Optional[Path] = None,
    ) -> Dict:
        """
        Compare disaggregated soiling estimates with DustIQ ground truth.

        Args:
            soiling_estimates: Output from compute_soiling_estimates
            dustiq_path: Path to DustIQ JSON file

        Returns:
            Comparison metrics: MAE, correlation, bias for each rolling window
        """
        import json

        if dustiq_path is None:
            dustiq_path = Path(f"public/data/soiling/{self.plant_id}/dustiq_history.json")

        if not dustiq_path.exists():
            return {"status": "no_dustiq_data", "path": str(dustiq_path)}

        # Load DustIQ data
        with open(dustiq_path) as f:
            dustiq_data = json.load(f)

        daily_dustiq = dustiq_data.get("daily_data", [])
        if not daily_dustiq:
            return {"status": "empty_dustiq_data"}

        # Convert to DataFrame
        df_dustiq = pl.DataFrame(daily_dustiq)
        if "sr_dustiq" in df_dustiq.columns:
            df_dustiq = df_dustiq.rename({"sr_dustiq": "sr_ground_truth"})
        elif "soiling_ratio" in df_dustiq.columns:
            df_dustiq = df_dustiq.rename({"soiling_ratio": "sr_ground_truth"})
        else:
            return {"status": "no_sr_column", "columns": df_dustiq.columns}

        # Join on date
        df_joined = soiling_estimates.join(
            df_dustiq.select(["date", "sr_ground_truth"]),
            on="date",
            how="inner"
        )

        if len(df_joined) == 0:
            return {"status": "no_overlapping_dates"}

        # Compute metrics for each window
        results = {
            "status": "success",
            "n_days_compared": len(df_joined),
            "date_range": f"{df_joined['date'].min()} to {df_joined['date'].max()}",
            "metrics": {}
        }

        for sr_col, label in [
            ("sr_daily", "daily"),
            ("sr_3d", "3-day"),
            ("sr_7d", "7-day"),
            ("sr_14d", "14-day"),
        ]:
            sr_est = df_joined[sr_col].to_numpy()
            sr_true = df_joined["sr_ground_truth"].to_numpy()

            # Filter out NaN values
            mask = ~(np.isnan(sr_est) | np.isnan(sr_true))
            sr_est = sr_est[mask]
            sr_true = sr_true[mask]

            if len(sr_est) < 10:
                continue

            mae = float(np.mean(np.abs(sr_est - sr_true)))
            bias = float(np.mean(sr_est - sr_true))
            rmse = float(np.sqrt(np.mean((sr_est - sr_true) ** 2)))

            # Correlation
            if np.std(sr_est) > 0 and np.std(sr_true) > 0:
                corr = float(np.corrcoef(sr_est, sr_true)[0, 1])
            else:
                corr = 0.0

            results["metrics"][label] = {
                "mae": round(mae, 4),
                "rmse": round(rmse, 4),
                "bias": round(bias, 4),
                "correlation": round(corr, 3),
                "n_samples": len(sr_est),
            }

        # Summary: which window is best?
        if results["metrics"]:
            best_window = min(
                results["metrics"].items(),
                key=lambda x: x[1]["mae"]
            )
            results["best_window"] = best_window[0]
            results["best_mae"] = best_window[1]["mae"]

        return results


def run_disaggregation_analysis(
    plant_id: str,
    scada_path: Optional[Path] = None,
    output_path: Optional[Path] = None,
    sample_days: int = 30,
) -> pl.DataFrame:
    """
    Run loss disaggregation analysis for a plant.

    Args:
        plant_id: Plant identifier
        scada_path: Path to SCADA data (default: backenddata/scada/{plant_id})
        output_path: Path to save results (default: public/data/digitaltwin/{plant_id})
        sample_days: Number of recent days to analyze

    Returns:
        Plant-level daily summary DataFrame
    """
    from nuravolt.digitaltwin.plant_config import PlantConfigLoader

    # Paths
    if scada_path is None:
        scada_path = Path(f"backenddata/scada/{plant_id}")
    if output_path is None:
        output_path = Path(f"public/data/digitaltwin/{plant_id}")

    print(f"\n{'='*60}")
    print(f"Loss Disaggregation Analysis: {plant_id}")
    print(f"{'='*60}")

    # Load plant config
    config_path = Path(f"backenddata/configs/plants/{plant_id}.yaml")
    if config_path.exists():
        config = PlantConfigLoader.load(config_path)
        print(f"Loaded config: {config.plant_name}")
    else:
        print(f"No config found, using defaults")
        config = None

    # Initialize disaggregator
    disaggregator = LossDisaggregator(
        plant_id=plant_id,
        twins_path=output_path,
    )

    # Load twins
    try:
        n_twins = disaggregator.load_twins()
        print(f"Loaded {n_twins} trained twins")
    except FileNotFoundError as e:
        print(f"Warning: {e}")
        print("Running without twin predictions")

    # Load SCADA data
    # This would need to be adapted based on actual data format
    print(f"\nLoading SCADA data from {scada_path}...")

    # For now, return empty - actual implementation would load and process data
    print("Note: Full SCADA loading not implemented in this demo")

    return pl.DataFrame()
