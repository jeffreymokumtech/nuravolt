"""
BESS Intelligence Pipeline

End-to-end orchestration of BESS analytics including:
- State of Health estimation
- Warranty violation detection
- Cycling analysis with rainflow counting
- Warranty health score calculation
- Degradation-aware dispatch optimization
- Export to dashboard-ready JSON

Follows the pattern established by nuravolt.soiling.pipeline.SoilingIntelligencePipeline.
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import json
import numpy as np

try:
    import polars as pl
except ImportError:
    pl = None

from nuravolt.bess.config import (
    BESSPipelineConfig,
    BessAssetConfig,
    WarrantyTermsConfig,
    ViolationDetectionConfig,
    CyclingAnalysisConfig,
    ArbitrageConfig,
    WarrantyHealthScore,
    WarrantyViolation,
    CycleRecord,
    DispatchSchedule,
    BESSAnalysisResult,
)
from nuravolt.bess.warranty_tracker import WarrantyTracker, WarrantyTerms
from nuravolt.bess.warranty_violation_detector import WarrantyViolationDetector
from nuravolt.bess.cycling_analysis import CyclingAnalyzer
from nuravolt.bess.arbitrage_optimizer import DegradationAwareArbitrage
from nuravolt.bess.soh_estimator import SoHEstimator
from nuravolt.bess.imbalance import (
    DeviceSample,
    ImbalanceReport,
    analyze_imbalance,
    imbalance_index,
)
from nuravolt.bess.thermal_monitor import (
    StateOfSafety,
    ThermalThresholds,
    combine_state_of_safety,
    dwell_exposure_index,
    protection_status_index,
    safety_disclosure,
    thermal_margin_index,
)


class BESSIntelligencePipeline:
    """
    End-to-end BESS analytics pipeline.

    Workflow:
    1. Load time-series data
    2. Calculate SoH from operational data or capacity tests
    3. Detect warranty violations
    4. Track cycling metrics (rainflow)
    5. Generate warranty health score
    6. Optimize dispatch with degradation awareness
    7. Export results for dashboard

    Example:
        from nuravolt.bess.pipeline import BESSIntelligencePipeline
        from nuravolt.bess.config import BessAssetConfig, BESSPipelineConfig, BessChemistry

        asset = BessAssetConfig(
            asset_id="bess-001",
            plant_id="plant-001",
            name="Battery Storage Unit 1",
            chemistry=BessChemistry.LFP,
            nominal_capacity_kwh=1000,
            nominal_power_kw=500,
        )

        config = BESSPipelineConfig(asset=asset)
        pipeline = BESSIntelligencePipeline(config)

        # Load data and run analysis
        pipeline.load_data(df)
        result = pipeline.run_full_analysis()

        # Export for dashboard
        pipeline.export_to_json("output/bess_analysis.json")
    """

    def __init__(self, config: BESSPipelineConfig):
        """
        Initialize the BESS intelligence pipeline.

        Args:
            config: Pipeline configuration
        """
        self.config = config
        self.asset = config.asset

        # Initialize sub-modules
        self._init_modules()

        # Data storage
        self.df: Optional["pl.DataFrame"] = None
        self.capacity_tests: List[dict] = []
        self.rack_samples: List[DeviceSample] = []

        # Results
        self.warranty_status: Optional[dict] = None
        self.violations: List[WarrantyViolation] = []
        self.cycle_records: List[CycleRecord] = []
        self.health_score: Optional[WarrantyHealthScore] = None
        self.dispatch_schedule: Optional[DispatchSchedule] = None
        self.imbalance_report: Optional[ImbalanceReport] = None
        self.state_of_safety: Optional[StateOfSafety] = None

    def _init_modules(self):
        """Initialize analytics sub-modules."""
        # Warranty tracker (existing module)
        warranty_terms = WarrantyTerms(
            capacity_guarantee_pct=self.config.warranty_terms.capacity_guarantee_pct,
            warranty_years=self.config.warranty_terms.warranty_years,
            max_cycles=self.config.warranty_terms.max_cycles or 5000,
            max_throughput_mwh=self.config.warranty_terms.max_throughput_mwh,
            min_rte=self.config.warranty_terms.min_rte,
            max_avg_soc=self.config.warranty_terms.max_avg_soc,
            max_operating_temp=self.config.warranty_terms.operating_temp_max_c,
        )
        self.warranty_tracker = WarrantyTracker(
            terms=warranty_terms,
            nominal_capacity_kwh=self.asset.nominal_capacity_kwh,
            installation_date=self.asset.installation_date,
        )

        # Violation detector
        self.violation_detector = WarrantyViolationDetector(
            config=self.config.violation_detection
        )

        # Cycling analyzer
        self.cycling_analyzer = CyclingAnalyzer(
            config=self.config.cycling_analysis,
            nominal_capacity_kwh=self.asset.nominal_capacity_kwh,
        )

        # SoH estimator
        self.soh_estimator = SoHEstimator()

        # Arbitrage optimizer
        if self.config.arbitrage:
            self.arbitrage_optimizer = DegradationAwareArbitrage(
                config=self.config.arbitrage
            )
        else:
            self.arbitrage_optimizer = None

    def load_data(
        self,
        df: "pl.DataFrame",
        column_mapping: Optional[Dict[str, str]] = None
    ):
        """
        Load time-series data for analysis.

        Args:
            df: Polars DataFrame with BESS operational data
            column_mapping: Optional mapping of standard names to actual columns
        """
        if pl is None:
            raise ImportError("Polars is required for the BESS pipeline")

        self.df = df

        # Store column mapping
        self.column_mapping = column_mapping or {
            "timestamp": "timestamp",
            "soc": "soc",
            "power": "power_kw",
            "temp": "temperature_c",
            "voltage": "cell_voltage_v",
            "hvac_status": "hvac_status",
            "c_rate": "c_rate",
            "alarm_code": "alarm_code",
        }

    def load_rack_samples(self, samples: List[DeviceSample]):
        """
        Load sub asset (rack, module, cell) telemetry for imbalance analysis.

        Optional. Without it the imbalance sub index of state of safety reports
        as unavailable with the connect your BMS wording, which is the honest
        answer for an asset whose only feed is an OEM cloud API.
        """
        self.rack_samples = list(samples)

    def load_capacity_tests(self, tests: List[dict]):
        """
        Load capacity test results.

        Args:
            tests: List of capacity test dictionaries with:
                - test_date: datetime
                - measured_capacity_kwh: float
                - soh_result: float
                - test_type: str
        """
        self.capacity_tests = tests

        # Update warranty tracker with latest measurement
        if tests:
            latest = sorted(tests, key=lambda x: x["test_date"])[-1]
            self.warranty_tracker.measure_capacity(latest["measured_capacity_kwh"])

    def run_warranty_analysis(self) -> dict:
        """
        Run warranty compliance analysis.

        Returns:
            Warranty status dictionary
        """
        if self.df is None:
            raise ValueError("No data loaded. Call load_data() first.")

        # Update warranty tracker from time series
        self._update_warranty_tracker_from_data()

        # Get warranty status
        self.warranty_status = self.warranty_tracker.get_kpi_summary()

        return self.warranty_status

    def run_violation_detection(self) -> List[WarrantyViolation]:
        """
        Run warranty violation detection.

        Returns:
            List of detected violations
        """
        if self.df is None:
            raise ValueError("No data loaded. Call load_data() first.")

        cols = self.column_mapping

        self.violations = self.violation_detector.check_all(
            df=self.df,
            timestamp_col=cols.get("timestamp", "timestamp"),
            temp_col=cols.get("temp"),
            soc_col=cols.get("soc"),
            power_col=cols.get("power"),
            voltage_col=cols.get("voltage"),
            hvac_col=cols.get("hvac_status"),
            c_rate_col=cols.get("c_rate"),
        )

        # Check throughput limit
        if self.warranty_status:
            throughput_mwh = self.warranty_status.get("throughput_mwh", 0)
            throughput_violation = self.violation_detector.check_throughput_limit(
                cumulative_throughput_mwh=throughput_mwh
            )
            if throughput_violation:
                self.violations.append(throughput_violation)

        return self.violations

    def run_cycling_analysis(self) -> List[CycleRecord]:
        """
        Run cycling analysis with rainflow counting.

        Returns:
            List of daily cycle records
        """
        if self.df is None:
            raise ValueError("No data loaded. Call load_data() first.")

        cols = self.column_mapping

        # Analyze daily cycling
        daily_metrics = self.cycling_analyzer.analyze_daily(
            df=self.df,
            date_col=cols.get("timestamp", "timestamp"),
            soc_col=cols.get("soc", "soc"),
            power_col=cols.get("power", "power_kw"),
            temp_col=cols.get("temp"),
            high_soc_threshold=self.config.violation_detection.soc_high_warning,
            high_temp_threshold=self.config.violation_detection.temp_warning_threshold_c,
        )

        # Convert to CycleRecord format
        self.cycle_records = self.cycling_analyzer.to_cycle_records(daily_metrics)

        # Update warranty tracker with cycle data
        cumulative = self.cycling_analyzer.calculate_cumulative_metrics(daily_metrics)
        self.warranty_tracker.metrics["equivalent_full_cycles"] = cumulative["total_cycles"]
        self.warranty_tracker.metrics["total_throughput_kwh"] = cumulative["total_throughput_kwh"]
        self.warranty_tracker.metrics["high_soc_hours"] = cumulative["total_high_soc_hours"]
        self.warranty_tracker.metrics["high_temp_hours"] = cumulative["total_high_temp_hours"]

        return self.cycle_records

    def calculate_health_score(self) -> WarrantyHealthScore:
        """
        Calculate composite warranty health score.

        Returns:
            WarrantyHealthScore with breakdown
        """
        # Ensure prerequisite analyses are run
        if self.warranty_status is None:
            self.run_warranty_analysis()

        status = self.warranty_tracker.get_warranty_status()

        # Component scores (0-100 each)
        soh_score = int(min(100, max(0, (status.soh_margin / 0.30) * 100)))
        cycle_score = int(min(100, max(0, (1 - status.cycle_usage_pct) * 100)))
        time_score = int(min(100, max(0, (status.years_remaining / 10) * 100)))

        # Efficiency score (based on RTE)
        avg_rte = self.warranty_status.get("avg_rte_30d", 0.90) if self.warranty_status else 0.90
        efficiency_score = int(min(100, max(0, ((avg_rte - 0.80) / 0.15) * 100)))

        # Violations penalty
        n_violations = len([v for v in self.violations if v.severity == "critical"])
        violations_score = max(0, 100 - n_violations * 20)

        # Weighted composite score
        weights = {
            "soh": 0.30,
            "cycle": 0.25,
            "time": 0.15,
            "efficiency": 0.15,
            "violations": 0.15,
        }

        composite = int(
            soh_score * weights["soh"]
            + cycle_score * weights["cycle"]
            + time_score * weights["time"]
            + efficiency_score * weights["efficiency"]
            + violations_score * weights["violations"]
        )

        # Risk level classification
        if composite >= 80:
            risk_level = "LOW"
        elif composite >= 60:
            risk_level = "MODERATE"
        elif composite >= 40:
            risk_level = "HIGH"
        else:
            risk_level = "CRITICAL"

        self.health_score = WarrantyHealthScore(
            score=composite,
            risk_level=risk_level,
            soh_score=soh_score,
            cycle_score=cycle_score,
            time_score=time_score,
            efficiency_score=efficiency_score,
            violations_score=violations_score,
            current_soh=status.current_soh,
            warranty_threshold=status.warranty_soh_threshold,
            soh_margin=status.soh_margin,
            cycles_used=self.warranty_tracker.metrics["equivalent_full_cycles"],
            cycles_remaining=status.cycles_remaining,
            years_remaining=status.years_remaining,
            projected_eol_date=status.projected_warranty_date,
            risk_factors=status.risk_factors,
            recommendation=status.recommendation,
        )

        return self.health_score

    # ------------------------------------------------------------------
    # State of safety
    # ------------------------------------------------------------------

    def _timestamps_utc(self) -> Optional[np.ndarray]:
        """Sorted numpy datetime64 array of the loaded timestamps, or None."""
        if self.df is None:
            return None
        ts_col = self.column_mapping.get("timestamp", "timestamp")
        if ts_col not in self.df.columns:
            return None
        try:
            ts = np.asarray(self.df[ts_col].to_numpy(), dtype="datetime64[ns]")
        except (TypeError, ValueError):
            return None
        return np.sort(ts)

    def telemetry_interval_minutes(self) -> Optional[float]:
        """
        Median gap between samples, in minutes.

        Measured, never assumed: the disclosure quotes this number back to the
        operator, so it has to be the real cadence of their feed.
        """
        ts = self._timestamps_utc()
        if ts is None or len(ts) < 2:
            return None
        gaps = np.diff(ts).astype("timedelta64[s]").astype(float) / 60.0
        gaps = gaps[gaps > 0]
        if gaps.size == 0:
            return None
        return float(np.median(gaps))

    def _window_hours(self) -> Optional[float]:
        ts = self._timestamps_utc()
        if ts is None or len(ts) < 2:
            return None
        span = (ts[-1] - ts[0]).astype("timedelta64[s]").astype(float) / 3600.0
        return span if span > 0 else None

    def _thermal_extremes(self) -> tuple:
        """(max temperature, max rise rate in C/min); either may be None."""
        if self.df is None:
            return (None, None)
        temp_col = self.column_mapping.get("temp", "temperature_c")
        if temp_col not in self.df.columns:
            return (None, None)

        temps = np.asarray(self.df[temp_col].to_numpy(), dtype=float)
        finite = temps[np.isfinite(temps)]
        max_temp = float(finite.max()) if finite.size else None

        max_rate = None
        ts_col = self.column_mapping.get("timestamp", "timestamp")
        raw_ts = None
        if ts_col in self.df.columns:
            try:
                raw_ts = np.asarray(self.df[ts_col].to_numpy(), dtype="datetime64[ns]")
            except (TypeError, ValueError):
                raw_ts = None

        if raw_ts is not None and len(raw_ts) == len(temps) and len(temps) > 1:
            order = np.argsort(raw_ts)
            minutes = np.diff(raw_ts[order]).astype("timedelta64[s]").astype(float) / 60.0
            deltas = np.diff(temps[order])
            valid = np.isfinite(deltas) & (minutes > 0)
            if valid.any():
                max_rate = float((deltas[valid] / minutes[valid]).max())

        return (max_temp, max_rate)

    def calculate_state_of_safety(
        self,
        interval_minutes: Optional[float] = None,
        thresholds: Optional[ThermalThresholds] = None,
    ) -> StateOfSafety:
        """
        Worst-of state of safety over four sub indices.

        Mirrors the transparency of `calculate_health_score` (every component
        exposes its inputs and its scoring method, and the rubric is published)
        but combines the parts with worst-of rather than a weighted sum. The
        rationale lives with the code in nuravolt.bess.thermal_monitor: safety
        does not average, so a critical thermal margin must not be diluted by
        three healthy sub indices.

        Sub indices with no data report unavailable and are excluded from the
        worst-of. They are never scored 100 for lack of evidence, and if none of
        the four has data the composite is None rather than a reassuring number.
        """
        if self.violations == [] and self.df is not None and self.warranty_status is None:
            # Violations drive two of the four sub indices; run detection first
            # so a bare calculate_state_of_safety() call is not scored blind.
            self.run_warranty_analysis()
            self.run_violation_detection()

        cadence = interval_minutes if interval_minutes is not None else self.telemetry_interval_minutes()

        # 1. Thermal margin (asset grain, works from OEM cloud today).
        max_temp, max_rate = self._thermal_extremes()
        thermal = thermal_margin_index(max_temp, max_rate, thresholds)

        # 2. Imbalance (sub asset grain, needs rack level telemetry).
        self.imbalance_report = analyze_imbalance(
            self.asset.asset_id, self.rack_samples
        )
        imbalance = imbalance_index(self.imbalance_report)

        # 3. Dwell exposure, reusing the warranty violation events.
        events = [
            (v.violation_type, v.started_at, v.ended_at)
            for v in self.violations
            if v.started_at is not None and v.ended_at is not None
        ]
        dwell = dwell_exposure_index(events, self._window_hours())

        # 4. Protection status.
        hvac_col = self.column_mapping.get("hvac_status", "hvac_status")
        alarm_col = self.column_mapping.get("alarm_code", "alarm_code")
        has_df = self.df is not None
        hvac_present = bool(has_df and hvac_col in self.df.columns)
        alarm_present = bool(has_df and alarm_col in self.df.columns)
        alarm_codes: List[str] = []
        if alarm_present:
            alarm_codes = sorted(
                {
                    str(c)
                    for c in self.df[alarm_col].to_list()
                    if c is not None and str(c).strip() not in ("", "0", "none", "None")
                }
            )
        protection = protection_status_index(
            hvac_failures=sum(1 for v in self.violations if v.violation_type == "HVAC_FAILURE"),
            alarm_codes=alarm_codes,
            hvac_channel_present=hvac_present,
            alarm_channel_present=alarm_present,
        )

        self.state_of_safety = combine_state_of_safety(
            [thermal, imbalance, dwell, protection],
            interval_minutes=cadence,
            computed_at=datetime.now(),
        )
        return self.state_of_safety

    def run_dispatch_optimization(
        self,
        prices: np.ndarray,
        temp_forecast: Optional[np.ndarray] = None
    ) -> Optional[DispatchSchedule]:
        """
        Run degradation-aware dispatch optimization.

        Args:
            prices: Price forecast array (EUR/MWh)
            temp_forecast: Temperature forecast array

        Returns:
            Optimized DispatchSchedule or None if optimizer not configured
        """
        if self.arbitrage_optimizer is None:
            return None

        # Get current SoC and SoH
        current_soc = self.asset.current_soc or 0.5
        current_soh = self.asset.current_soh or 1.0

        # Calculate warranty margin
        warranty_margin = current_soh - self.config.warranty_terms.capacity_guarantee_pct

        self.dispatch_schedule = self.arbitrage_optimizer.optimize(
            prices=prices,
            initial_soc=current_soc,
            current_soh=current_soh,
            warranty_margin=warranty_margin,
            temp_forecast=temp_forecast,
        )

        return self.dispatch_schedule

    def run_full_analysis(
        self,
        prices: Optional[np.ndarray] = None,
        temp_forecast: Optional[np.ndarray] = None
    ) -> BESSAnalysisResult:
        """
        Run complete BESS analytics pipeline.

        Args:
            prices: Optional price forecast for dispatch optimization
            temp_forecast: Optional temperature forecast

        Returns:
            Complete BESSAnalysisResult
        """
        if self.df is None:
            raise ValueError("No data loaded. Call load_data() first.")

        # Run all analyses
        self.run_warranty_analysis()
        self.run_violation_detection()
        self.run_cycling_analysis()
        self.calculate_health_score()
        self.calculate_state_of_safety()

        # Optional dispatch optimization
        if prices is not None:
            self.run_dispatch_optimization(prices, temp_forecast)

        # Get data range
        ts_col = self.column_mapping.get("timestamp", "timestamp")
        timestamps = self.df[ts_col]
        data_start = timestamps.min()
        data_end = timestamps.max()

        # Convert numpy datetime64 to datetime if needed
        if hasattr(data_start, 'item'):
            data_start = data_start.item()
        if hasattr(data_end, 'item'):
            data_end = data_end.item()

        # Cumulative metrics
        cumulative = self.cycling_analyzer.calculate_cumulative_metrics(
            [r for r in self.cycle_records if hasattr(r, 'equivalent_cycles')]
        ) if self.cycle_records else {"total_cycles": 0, "total_throughput_kwh": 0}

        return BESSAnalysisResult(
            asset_id=self.asset.asset_id,
            analysis_timestamp=datetime.now(),
            warranty_health=self.health_score,
            active_violations=[v for v in self.violations if not getattr(v, 'is_resolved', False)],
            total_cycles=cumulative.get("total_cycles", 0),
            total_throughput_mwh=cumulative.get("total_throughput_kwh", 0) / 1000,
            recent_cycles=self.cycle_records[-30:] if self.cycle_records else [],
            dispatch_schedule=self.dispatch_schedule,
            data_start=data_start,
            data_end=data_end,
            data_points=len(self.df),
        )

    def export_to_json(self, output_path: str) -> str:
        """
        Export analysis results to JSON for dashboard.

        Args:
            output_path: Path to output JSON file

        Returns:
            Path to written file
        """
        # Ensure analysis has been run
        if self.health_score is None:
            raise ValueError("No analysis results. Call run_full_analysis() first.")

        # Build export data
        export_data = {
            "metadata": {
                "asset_id": self.asset.asset_id,
                "plant_id": self.asset.plant_id,
                "asset_name": self.asset.name,
                "chemistry": self.asset.chemistry.value,
                "nominal_capacity_kwh": self.asset.nominal_capacity_kwh,
                "nominal_power_kw": self.asset.nominal_power_kw,
                "manufacturer": self.asset.manufacturer,
                "model": self.asset.model,
                "generated_at": datetime.now().isoformat(),
            },
            "warranty_health": {
                "score": self.health_score.score,
                "risk_level": self.health_score.risk_level,
                "component_scores": {
                    "soh": self.health_score.soh_score,
                    "cycles": self.health_score.cycle_score,
                    "time": self.health_score.time_score,
                    "efficiency": self.health_score.efficiency_score,
                    "violations": self.health_score.violations_score,
                },
                "current_soh": self.health_score.current_soh,
                "warranty_threshold": self.health_score.warranty_threshold,
                "soh_margin": self.health_score.soh_margin,
                "cycles_used": self.health_score.cycles_used,
                "cycles_remaining": self.health_score.cycles_remaining,
                "years_remaining": self.health_score.years_remaining,
                "projected_eol_date": (
                    self.health_score.projected_eol_date.isoformat()
                    if self.health_score.projected_eol_date else None
                ),
                "risk_factors": self.health_score.risk_factors,
                "recommendation": self.health_score.recommendation,
            },
            "violations": [
                {
                    "type": v.violation_type,
                    "severity": v.severity,
                    "started_at": v.started_at.isoformat() if v.started_at else None,
                    "ended_at": v.ended_at.isoformat() if v.ended_at else None,
                    "duration_minutes": v.duration_minutes,
                    "measured_value": v.measured_value,
                    "threshold_value": v.threshold_value,
                    "unit": v.unit,
                    "description": v.description,
                }
                for v in self.violations
            ],
            "cycling_metrics": {
                "total_cycles": self.health_score.cycles_used,
                "total_throughput_mwh": self.warranty_tracker.metrics["total_throughput_kwh"] / 1000,
                "recent_cycles": [
                    {
                        "date": r.date.isoformat(),
                        "equivalent_cycles": r.equivalent_cycles,
                        "energy_in_kwh": r.energy_in_kwh,
                        "energy_out_kwh": r.energy_out_kwh,
                        "avg_dod": r.avg_dod,
                        "avg_c_rate": r.avg_c_rate,
                        "round_trip_efficiency": r.round_trip_efficiency,
                    }
                    for r in self.cycle_records[-30:]
                ],
            },
        }

        # State of safety. Exported whether or not it could be scored: a UI that
        # can tell "no rack telemetry" from "balanced" needs the unavailable
        # list and the disclosure just as much as it needs the number.
        if self.state_of_safety is not None:
            export_data["state_of_safety"] = self.state_of_safety.to_dict()
            if self.imbalance_report is not None:
                export_data["state_of_safety"]["imbalance"] = {
                    "day": (
                        self.imbalance_report.day.isoformat()
                        if self.imbalance_report.day else None
                    ),
                    "rack_count": self.imbalance_report.rack_count,
                    "dwell_minutes": self.imbalance_report.dwell_minutes,
                    "flag_threshold": self.imbalance_report.threshold,
                    "inter_rack_spread": self.imbalance_report.inter_rack_spread,
                    "availability": [
                        {
                            "metric": a.metric,
                            "grain": a.grain,
                            "available": a.available,
                            "reason": a.reason,
                        }
                        for a in self.imbalance_report.availability
                    ],
                    "racks": [
                        {
                            "rack_id": r.rack_id,
                            "day": r.day.isoformat(),
                            "sample_count": r.sample_count,
                            "member_count": r.member_count,
                            "temperature_spread_c": r.temperature_spread_c,
                            "voltage_spread_v": r.voltage_spread_v,
                            "soc_divergence_pp": r.soc_divergence_pp,
                        }
                        for r in self.imbalance_report.racks
                    ],
                    "outliers": [
                        {
                            "rack_id": o.rack_id,
                            "metric": o.metric,
                            "unit": o.unit,
                            "modified_z": o.modified_z,
                            "observed_value": o.observed_value,
                            "sibling_median": o.sibling_median,
                            "sibling_mad": o.sibling_mad,
                            "started_at": o.started_at.isoformat(),
                            "ended_at": o.ended_at.isoformat(),
                            "duration_minutes": o.duration_minutes,
                            "threshold": o.threshold,
                            "description": o.description,
                        }
                        for o in self.imbalance_report.outliers
                    ],
                }
        else:
            # Never silently omit the disclosure from a payload a UI will render.
            export_data["state_of_safety"] = {
                "score": None,
                "band": "UNKNOWN",
                "limiting_index": None,
                "sub_indices": [],
                "unavailable": [],
                "disclosure": safety_disclosure(self.telemetry_interval_minutes()),
            }

        # Add dispatch schedule if available
        if self.dispatch_schedule:
            export_data["dispatch_schedule"] = {
                "schedule_date": self.dispatch_schedule.schedule_date.isoformat(),
                "horizon_hours": self.dispatch_schedule.horizon_hours,
                "charge_schedule_kw": self.dispatch_schedule.charge_schedule_kw,
                "discharge_schedule_kw": self.dispatch_schedule.discharge_schedule_kw,
                "soc_schedule": self.dispatch_schedule.soc_schedule,
                "price_forecast": self.dispatch_schedule.price_forecast,
                "expected_revenue_eur": self.dispatch_schedule.expected_revenue_eur,
                "degradation_cost_eur": self.dispatch_schedule.degradation_cost_eur,
                "net_revenue_eur": self.dispatch_schedule.net_revenue_eur,
                "expected_cycles": self.dispatch_schedule.expected_cycles,
            }

        # Write to file
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w") as f:
            json.dump(export_data, f, indent=2, default=str)

        return str(output_path)

    def _update_warranty_tracker_from_data(self):
        """Update warranty tracker metrics from loaded time series data."""
        if self.df is None:
            return

        cols = self.column_mapping

        # Get columns
        power_col = cols.get("power", "power_kw")
        temp_col = cols.get("temp", "temperature_c")
        soc_col = cols.get("soc", "soc")

        if power_col not in self.df.columns:
            return

        # Calculate basic metrics
        df = self.df

        # Energy throughput
        if power_col in df.columns:
            hours_per_sample = 1.0 / 4  # Assume 15-min data
            power_values = df[power_col].to_numpy()
            throughput = np.abs(power_values).sum() * hours_per_sample
            self.warranty_tracker.metrics["total_throughput_kwh"] = throughput

            # Equivalent cycles
            efc = throughput / (2 * self.asset.nominal_capacity_kwh)
            self.warranty_tracker.metrics["equivalent_full_cycles"] = efc

        # High temperature hours
        if temp_col in df.columns:
            temp_values = df[temp_col].to_numpy()
            high_temp_mask = temp_values > self.config.warranty_terms.operating_temp_max_c
            high_temp_hours = np.sum(high_temp_mask) * 0.25  # 15-min samples
            self.warranty_tracker.metrics["high_temp_hours"] = high_temp_hours

        # High SoC hours
        if soc_col in df.columns:
            soc_values = df[soc_col].to_numpy()
            high_soc_mask = soc_values > self.config.warranty_terms.max_avg_soc
            high_soc_hours = np.sum(high_soc_mask) * 0.25
            self.warranty_tracker.metrics["high_soc_hours"] = high_soc_hours
