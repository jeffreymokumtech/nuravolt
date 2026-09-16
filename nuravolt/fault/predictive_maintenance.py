"""
Unified Predictive Maintenance Pipeline

Full predictive maintenance stack:
1. Compound ML Anomaly Detection → Detect subtle multi-variable faults
2. Failure Mode Classification → Classify fault type (9 classes)
3. RUL Estimation → Predict days to failure (7 fault types)

Combines:
- ac_fault_detector.py: CompoundFaultDetector
- pretraining.py: FaultClassifier
- rul_predictor.py: RULPredictor
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Literal, List, Dict, Any
import json
import sys

import numpy as np
import polars as pl

# Import components
from ..digitaltwin.ac_fault_detector import (
    CompoundFaultDetector,
    CompoundFaultResult,
    ACFaultResult,
    ACFaultThresholds,
)
from ..model_paths import resolve_model_path, resolve_model_root
from .pretraining import FaultClassifier, UNIFIED_FAULT_CLASSES
from .rul_predictor import RULPredictor, MaintenanceSchedule, MaintenanceAction
from .rul_models import RULPrediction
from .features import PlantAgnosticFeatureEngine, PlantConfig


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class ClassifiedFault:
    """A fault classified by the failure mode classifier."""

    fault_class: int
    fault_name: str
    fault_type: str  # reactive, predictive, normal
    confidence: float  # 0-1
    probabilities: Dict[int, float]  # class -> probability
    timestamp: Optional[datetime] = None
    source_anomaly: Optional[CompoundFaultResult] = None

    def to_dict(self) -> dict:
        return {
            "fault_class": self.fault_class,
            "fault_name": self.fault_name,
            "fault_type": self.fault_type,
            "confidence": round(self.confidence, 3),
            "probabilities": {k: round(v, 3) for k, v in self.probabilities.items()},
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
        }


@dataclass
class PredictiveMaintenanceResult:
    """Complete predictive maintenance analysis result."""

    timestamp: datetime
    plant_id: str
    analysis_period_days: int

    # Layer 0: Anomaly Detection
    anomalies: List[CompoundFaultResult] = field(default_factory=list)
    anomaly_count: int = 0

    # Layer 1: Failure Mode Classification
    classified_faults: List[ClassifiedFault] = field(default_factory=list)
    fault_distribution: Dict[str, int] = field(default_factory=dict)

    # Layer 2: RUL Estimation
    rul_predictions: Dict[str, List[RULPrediction]] = field(default_factory=dict)
    maintenance_schedule: Optional[MaintenanceSchedule] = None

    # Summary
    health_score: float = 100.0  # 0-100
    priority_actions: List[MaintenanceAction] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "timestamp": self.timestamp.isoformat(),
            "plant_id": self.plant_id,
            "analysis_period_days": self.analysis_period_days,
            "summary": {
                "health_score": round(self.health_score, 1),
                "anomaly_count": self.anomaly_count,
                "fault_count": len(self.classified_faults),
                "fault_distribution": self.fault_distribution,
                "priority_action_count": len(self.priority_actions),
            },
            "anomalies": [
                {
                    "fault_type": a.fault_type,
                    "severity": a.severity,
                    "confidence": round(a.confidence, 2),
                    "anomaly_score": round(a.anomaly_score, 2),
                    "detected_at": a.detected_at.isoformat() if a.detected_at else None,
                    "duration_minutes": round(a.duration_minutes, 1),
                    "loss_kwh": round(a.loss_kwh, 1),
                    "interpretation": a.interpretation,
                    "possible_causes": a.possible_causes,
                }
                for a in self.anomalies
            ],
            "classified_faults": [f.to_dict() for f in self.classified_faults],
            "rul_predictions": {
                fault_type: [
                    {
                        "days_to_fault": round(p.days_to_fault, 1),
                        "confidence": round(p.confidence, 2),
                        "current_value": round(p.current_value, 3) if p.current_value else None,
                        "threshold": p.threshold,
                    }
                    for p in predictions
                ]
                for fault_type, predictions in self.rul_predictions.items()
            },
            "maintenance_schedule": self.maintenance_schedule.to_dict() if self.maintenance_schedule else None,
            "priority_actions": [a.to_dict() for a in self.priority_actions],
        }

    def to_json(self, path: Optional[Path] = None) -> str:
        """Export to JSON string or file."""
        data = self.to_dict()
        json_str = json.dumps(data, indent=2, default=str)

        if path:
            with open(path, "w") as f:
                f.write(json_str)

        return json_str

    def to_markdown(self) -> str:
        """Generate a markdown report."""
        lines = []

        lines.append(f"# Predictive Maintenance Report: {self.plant_id}\n")
        lines.append(f"*Generated: {self.timestamp.strftime('%Y-%m-%d %H:%M')}*\n")
        lines.append(f"*Analysis period: {self.analysis_period_days} days*\n")

        # Health Score
        lines.append("## Health Score\n")
        if self.health_score >= 80:
            status = "🟢 Healthy"
        elif self.health_score >= 60:
            status = "🟡 Attention Needed"
        elif self.health_score >= 40:
            status = "🟠 Degraded"
        else:
            status = "🔴 Critical"
        lines.append(f"**{self.health_score:.0f}/100** - {status}\n")

        # Summary
        lines.append("## Summary\n")
        lines.append(f"| Metric | Value |")
        lines.append(f"|--------|-------|")
        lines.append(f"| Anomalies Detected | {self.anomaly_count} |")
        lines.append(f"| Classified Faults | {len(self.classified_faults)} |")
        lines.append(f"| Priority Actions | {len(self.priority_actions)} |")
        lines.append("")

        # Fault Distribution
        if self.fault_distribution:
            lines.append("## Fault Distribution\n")
            lines.append("| Fault Type | Count |")
            lines.append("|------------|-------|")
            for fault_name, count in sorted(self.fault_distribution.items(), key=lambda x: -x[1]):
                lines.append(f"| {fault_name} | {count} |")
            lines.append("")

        # Priority Actions
        if self.priority_actions:
            lines.append("## Priority Actions\n")
            for action in self.priority_actions:
                urgency_icon = {
                    "urgent": "🔴",
                    "soon": "🟠",
                    "planned": "🟡",
                    "monitoring": "🟢",
                }.get(action.urgency, "⚪")
                lines.append(f"### {urgency_icon} {action.display_name}")
                lines.append(f"- **Urgency**: {action.urgency}")
                lines.append(f"- **Days to fault**: {action.days_to_fault:.0f}")
                lines.append(f"- **Confidence**: {action.confidence:.0%}")
                lines.append(f"- **Action**: {action.recommended_action}")
                lines.append("")

        # RUL Predictions
        if self.rul_predictions:
            lines.append("## RUL Predictions by Fault Type\n")
            lines.append("| Fault Type | Days to Fault | Confidence | Status |")
            lines.append("|------------|---------------|------------|--------|")
            for fault_type, predictions in self.rul_predictions.items():
                if predictions:
                    pred = predictions[-1]  # Latest
                    if pred.days_to_fault < 7:
                        status = "🔴 Critical"
                    elif pred.days_to_fault < 30:
                        status = "🟠 Soon"
                    elif pred.days_to_fault < 90:
                        status = "🟡 Planned"
                    else:
                        status = "🟢 OK"
                    lines.append(f"| {fault_type} | {pred.days_to_fault:.0f} | {pred.confidence:.0%} | {status} |")
            lines.append("")

        # Top Anomalies
        if self.anomalies:
            lines.append("## Top Anomalies\n")
            for i, anomaly in enumerate(self.anomalies[:5]):  # Top 5
                lines.append(f"### Anomaly {i+1}: {anomaly.severity.title()}")
                lines.append(f"- **Score**: {anomaly.anomaly_score:.2f}")
                lines.append(f"- **Interpretation**: {anomaly.interpretation}")
                if anomaly.possible_causes:
                    lines.append(f"- **Possible causes**: {', '.join(anomaly.possible_causes)}")
                lines.append("")

        return "\n".join(lines)


# =============================================================================
# Mapping between fault types
# =============================================================================

# Map classifier output (9 classes) to RUL model types (7 types)
FAULT_CLASS_TO_RUL_TYPE = {
    0: None,                    # Normal - no RUL needed
    1: "string_degradation",    # String Open Circuit
    2: "string_degradation",    # String Short Circuit
    3: "string_degradation",    # String Degradation
    4: None,                    # Partial Shading/Soiling - separate system
    5: "inverter_thermal",      # Inverter Fault
    6: None,                    # Grid Fault - external
    7: None,                    # Sensor/Controller - not predictable
    8: "mismatch",              # Array Fault
}

# Map compound fault patterns to RUL types
COMPOUND_PATTERN_TO_RUL = {
    "efficiency_drop": "inverter_thermal",
    "thermal": "thermal_hotspot",
    "current_imbalance": "mismatch",
    "voltage_deviation": "string_degradation",
    "degradation": "module_degradation",
}


# =============================================================================
# Main Pipeline
# =============================================================================

class PredictiveMaintenancePipeline:
    """
    Full predictive maintenance stack:

    1. Compound ML → Detect subtle multi-variable anomalies
    2. FaultClassifier → Classify fault type (9 classes)
    3. RULPredictor → Estimate days to failure (7 fault types)

    Usage:
        pipeline = PredictiveMaintenancePipeline(model_dir="models")
        result = pipeline.analyze(df, plant_config)
        print(result.to_markdown())
    """

    def __init__(
        self,
        model_dir: Optional[str] = None,
        rul_model_dir: Optional[str] = None,
        classifier_path: Optional[str] = None,
        plant_id: str = "",
    ):
        """
        Initialize the predictive maintenance pipeline.

        Args:
            model_dir: Base directory for all models. Defaults to whichever of
                ``backenddata/models`` or ``models`` exists, resolved against the
                repository root rather than the working directory.
            rul_model_dir: Specific directory for RUL models (default: model_dir/rul)
            classifier_path: Path to fault classifier model
            plant_id: Plant identifier
        """
        self.model_dir = resolve_model_root(model_dir)
        self.plant_id = plant_id

        # Initialize components
        self.anomaly_detector: Optional[CompoundFaultDetector] = None
        self.fault_classifier: Optional[FaultClassifier] = None
        self.rul_predictor: Optional[RULPredictor] = None

        # Load models
        self._load_models(rul_model_dir, classifier_path)

        print(f"PredictiveMaintenancePipeline initialized for plant: {plant_id}")

    def _load_models(
        self,
        rul_model_dir: Optional[str] = None,
        classifier_path: Optional[str] = None,
    ):
        """Load all required models."""

        # 1. Anomaly detector (no pre-trained model needed - fits on data)
        self.anomaly_detector = CompoundFaultDetector(ACFaultThresholds())
        print("  ✓ Compound fault detector initialized")

        # 2. Fault classifier
        if classifier_path is None:
            classifier_path = resolve_model_path(
                "fault_detection", "fault_classifier_string_level.pkl"
            )

        if classifier_path is not None and Path(classifier_path).exists():
            try:
                self.fault_classifier = FaultClassifier.load(str(classifier_path))
                print(f"  ✓ Fault classifier loaded: {classifier_path}")
            except Exception as e:
                print(f"  ⚠ Could not load fault classifier: {e}")
        else:
            print(f"  ⚠ Fault classifier not found: {classifier_path}")

        # 3. RUL predictor
        if rul_model_dir is None:
            rul_model_dir = resolve_model_path("rul")

        if rul_model_dir is not None and Path(rul_model_dir).exists():
            try:
                self.rul_predictor = RULPredictor(str(rul_model_dir))
                print(f"  ✓ RUL predictor loaded from: {rul_model_dir}")
            except Exception as e:
                print(f"  ⚠ Could not load RUL predictor: {e}")
        else:
            print(f"  ⚠ RUL model directory not found: {rul_model_dir}")

    def analyze(
        self,
        df: pl.DataFrame,
        plant_config: Optional[PlantConfig] = None,
        fit_anomaly_detector: bool = True,
        min_irradiance: float = 100.0,
    ) -> PredictiveMaintenanceResult:
        """
        Run full predictive maintenance analysis.

        Args:
            df: Input DataFrame with SCADA data
            plant_config: Plant configuration for feature engineering
            fit_anomaly_detector: Whether to fit anomaly detector on data
            min_irradiance: Minimum irradiance for analysis (W/m²)

        Returns:
            PredictiveMaintenanceResult with all analysis results
        """
        timestamp = datetime.now()

        # Calculate analysis period
        if "timestamp" in df.columns:
            date_range = df.select(
                (pl.col("timestamp").max() - pl.col("timestamp").min()).alias("range")
            )
            analysis_days = date_range["range"][0].days if date_range.height > 0 else 0
        else:
            analysis_days = len(df) // 96  # Assume 15-min data

        # Initialize result
        result = PredictiveMaintenanceResult(
            timestamp=timestamp,
            plant_id=self.plant_id,
            analysis_period_days=analysis_days,
        )

        # Filter to daytime data for analysis
        df_filtered = self._filter_daytime(df, min_irradiance)

        if df_filtered.height == 0:
            print("  No valid daytime data for analysis")
            return result

        # Step 1: Anomaly Detection
        print("\n  Step 1: Detecting anomalies...")
        anomalies = self._detect_anomalies(df_filtered, fit=fit_anomaly_detector)
        result.anomalies = anomalies
        result.anomaly_count = len(anomalies)
        print(f"    Found {len(anomalies)} anomalies")

        # Step 2: Failure Mode Classification
        print("\n  Step 2: Classifying faults...")
        classified = self._classify_faults(df_filtered, anomalies)
        result.classified_faults = classified
        result.fault_distribution = self._compute_fault_distribution(classified)
        print(f"    Classified {len(classified)} faults")

        # Step 3: RUL Estimation
        print("\n  Step 3: Estimating RUL...")
        rul_results, schedule = self._estimate_rul(df_filtered, classified, plant_config)
        result.rul_predictions = rul_results
        result.maintenance_schedule = schedule
        print(f"    Generated predictions for {len(rul_results)} fault types")

        # Step 4: Compute health score
        result.health_score = self._compute_health_score(anomalies, classified, rul_results)
        print(f"\n  Health Score: {result.health_score:.0f}/100")

        # Step 5: Prioritize actions
        result.priority_actions = self._get_priority_actions(schedule)

        return result

    def _filter_daytime(
        self,
        df: pl.DataFrame,
        min_irradiance: float = 100.0,
    ) -> pl.DataFrame:
        """Filter to daytime data only."""
        # Find irradiance column
        irr_col = None
        for col in df.columns:
            if "irradiance" in col.lower() or "irradiation" in col.lower():
                irr_col = col
                break

        if irr_col and irr_col in df.columns:
            return df.filter(pl.col(irr_col) > min_irradiance)

        # Fallback: filter by hour if timestamp available
        if "timestamp" in df.columns:
            return df.filter(
                (pl.col("timestamp").dt.hour() >= 6) &
                (pl.col("timestamp").dt.hour() <= 18)
            )

        return df

    def _detect_anomalies(
        self,
        df: pl.DataFrame,
        fit: bool = True,
    ) -> List[CompoundFaultResult]:
        """Run compound ML anomaly detection."""
        if self.anomaly_detector is None:
            return []

        try:
            if fit:
                # Fit on "normal" portion of data (middle 80%)
                # Exclude first/last 10% which may have startup/shutdown artifacts
                n = df.height
                start_idx = int(n * 0.1)
                end_idx = int(n * 0.9)
                df_normal = df.slice(start_idx, end_idx - start_idx)
                self.anomaly_detector.fit(df_normal)

            return self.anomaly_detector.detect(df)
        except Exception as e:
            print(f"    Warning: Anomaly detection failed: {e}")
            return []

    def _classify_faults(
        self,
        df: pl.DataFrame,
        anomalies: List[CompoundFaultResult],
    ) -> List[ClassifiedFault]:
        """Classify detected anomalies into fault types."""
        if self.fault_classifier is None:
            return []

        classified = []

        # If no anomalies, still run classification on whole dataset
        if not anomalies:
            try:
                # Extract features for classification
                features = self._extract_classification_features(df)
                if features is not None and len(features) > 0:
                    # Get predictions
                    proba = self.fault_classifier.predict_proba(features)
                    predictions = self.fault_classifier.predict(features)

                    # Create classified faults for non-normal predictions
                    for i, (pred, prob_row) in enumerate(zip(predictions, proba)):
                        pred_class = int(pred)
                        if pred_class != 0:  # Not normal
                            fault_info = UNIFIED_FAULT_CLASSES.get(pred_class, {})
                            classified.append(ClassifiedFault(
                                fault_class=pred_class,
                                fault_name=fault_info.get("name", f"Unknown_{pred_class}"),
                                fault_type=fault_info.get("type", "unknown"),
                                confidence=float(prob_row[pred_class]) if pred_class < len(prob_row) else 0.5,
                                probabilities={j: float(p) for j, p in enumerate(prob_row)},
                            ))
            except Exception as e:
                print(f"    Warning: Classification failed: {e}")
        else:
            # Classify each anomaly
            for anomaly in anomalies:
                try:
                    # Use anomaly features for classification
                    fault_class = self._infer_fault_class_from_anomaly(anomaly)
                    fault_info = UNIFIED_FAULT_CLASSES.get(fault_class, {})

                    classified.append(ClassifiedFault(
                        fault_class=fault_class,
                        fault_name=fault_info.get("name", f"Unknown_{fault_class}"),
                        fault_type=fault_info.get("type", "unknown"),
                        confidence=anomaly.confidence,
                        probabilities={fault_class: anomaly.confidence},
                        timestamp=anomaly.detected_at,
                        source_anomaly=anomaly,
                    ))
                except Exception as e:
                    print(f"    Warning: Could not classify anomaly: {e}")

        return classified

    def _infer_fault_class_from_anomaly(
        self,
        anomaly: CompoundFaultResult,
    ) -> int:
        """Infer fault class from anomaly contributing factors."""
        factors = anomaly.contributing_factors

        # Map contributing factors to fault classes
        if "efficiency_residual" in factors:
            if factors["efficiency_residual"].get("direction") == "low":
                return 5  # Inverter fault

        if "current_cv" in factors:
            if factors["current_cv"].get("direction") == "high":
                return 8  # Array fault (mismatch)

        if "temp_residual" in factors:
            if factors["temp_residual"].get("direction") == "high":
                return 5  # Inverter fault (thermal)

        if "voltage_residual" in factors:
            return 3  # String degradation

        # Default: string degradation
        return 3

    def _extract_classification_features(
        self,
        df: pl.DataFrame,
    ) -> Optional[np.ndarray]:
        """Extract features for fault classification."""
        if self.fault_classifier is None:
            return None

        feature_names = self.fault_classifier.feature_names

        # Check which features are available
        available = [f for f in feature_names if f in df.columns]

        if len(available) < len(feature_names) * 0.5:  # Need at least 50% of features
            return None

        # Fill missing with zeros
        features = []
        for fname in feature_names:
            if fname in df.columns:
                features.append(df[fname].to_numpy())
            else:
                features.append(np.zeros(df.height))

        return np.column_stack(features)

    def _estimate_rul(
        self,
        df: pl.DataFrame,
        classified_faults: List[ClassifiedFault],
        plant_config: Optional[PlantConfig] = None,
    ) -> tuple[Dict[str, List[RULPrediction]], Optional[MaintenanceSchedule]]:
        """Run RUL estimation for detected fault types."""
        if self.rul_predictor is None:
            return {}, None

        # Determine which RUL models to run
        active_rul_types = set()

        # From classified faults
        for fault in classified_faults:
            rul_type = FAULT_CLASS_TO_RUL_TYPE.get(fault.fault_class)
            if rul_type:
                active_rul_types.add(rul_type)

        # Also run all available models for comprehensive assessment
        available_models = self.rul_predictor.get_available_models()
        active_rul_types.update(available_models)

        # Run RUL predictions
        rul_results = {}
        for rul_type in active_rul_types:
            if rul_type in available_models:
                try:
                    predictions = self.rul_predictor.predict_single(df, rul_type)
                    if predictions:
                        rul_results[rul_type] = predictions
                except Exception as e:
                    print(f"    Warning: RUL prediction failed for {rul_type}: {e}")

        # Generate maintenance schedule
        try:
            schedule = self.rul_predictor.get_maintenance_schedule(df, plant_config)
        except Exception as e:
            print(f"    Warning: Could not generate schedule: {e}")
            schedule = None

        return rul_results, schedule

    def _compute_fault_distribution(
        self,
        classified_faults: List[ClassifiedFault],
    ) -> Dict[str, int]:
        """Compute distribution of fault types."""
        distribution = {}
        for fault in classified_faults:
            name = fault.fault_name
            distribution[name] = distribution.get(name, 0) + 1
        return distribution

    def _compute_health_score(
        self,
        anomalies: List[CompoundFaultResult],
        classified_faults: List[ClassifiedFault],
        rul_results: Dict[str, List[RULPrediction]],
    ) -> float:
        """
        Compute overall health score 0-100.

        Factors:
        - Anomaly severity (30% weight)
        - Fault type risk (30% weight)
        - Minimum RUL across fault types (40% weight)
        """
        # 1. Anomaly penalty (0-30 points)
        anomaly_penalty = 0
        for anomaly in anomalies:
            severity_weight = {
                "minor": 2,
                "moderate": 5,
                "major": 10,
                "critical": 15,
            }.get(anomaly.severity, 3)
            anomaly_penalty += severity_weight
        anomaly_penalty = min(30, anomaly_penalty)

        # 2. Fault risk penalty (0-30 points)
        fault_penalty = 0
        for fault in classified_faults:
            if fault.fault_type == "reactive":
                fault_penalty += 10  # Reactive faults are serious
            elif fault.fault_type == "predictive":
                fault_penalty += 5   # Predictive faults give warning
        fault_penalty = min(30, fault_penalty)

        # 3. RUL factor (0-40 points)
        # Based on minimum RUL across all predictions
        min_rul = 365  # Default: 1 year
        for predictions in rul_results.values():
            for pred in predictions:
                if pred.days_to_fault < min_rul:
                    min_rul = pred.days_to_fault

        # RUL scoring: 30+ days = full 40 points, <7 days = 0 points
        if min_rul >= 30:
            rul_score = 40
        elif min_rul >= 7:
            rul_score = 40 * (min_rul - 7) / 23  # Linear scale 7-30 days
        else:
            rul_score = 0

        # Compute final score
        health_score = max(0, 100 - anomaly_penalty - fault_penalty - (40 - rul_score))

        return health_score

    def _get_priority_actions(
        self,
        schedule: Optional[MaintenanceSchedule],
    ) -> List[MaintenanceAction]:
        """Get priority actions from maintenance schedule."""
        if schedule is None:
            return []

        # Combine urgent and soon actions
        priority = []
        priority.extend(schedule.urgent)
        priority.extend(schedule.soon)

        # Sort by days to fault
        priority.sort(key=lambda a: a.days_to_fault)

        return priority[:5]  # Top 5


# =============================================================================
# Convenience Functions
# =============================================================================

def create_pipeline(
    model_dir: str = "models",
    plant_id: str = "",
) -> PredictiveMaintenancePipeline:
    """
    Create a predictive maintenance pipeline with default configuration.

    Args:
        model_dir: Directory containing all models
        plant_id: Plant identifier

    Returns:
        Configured PredictiveMaintenancePipeline instance
    """
    return PredictiveMaintenancePipeline(
        model_dir=model_dir,
        plant_id=plant_id,
    )


def analyze_plant(
    df: pl.DataFrame,
    plant_id: str,
    model_dir: str = "models",
    plant_config: Optional[PlantConfig] = None,
) -> PredictiveMaintenanceResult:
    """
    Run predictive maintenance analysis on a plant.

    Args:
        df: DataFrame with SCADA data
        plant_id: Plant identifier
        model_dir: Directory containing models
        plant_config: Optional plant configuration

    Returns:
        PredictiveMaintenanceResult with analysis
    """
    pipeline = create_pipeline(model_dir, plant_id)
    return pipeline.analyze(df, plant_config)
