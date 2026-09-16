"""
Unified RUL Predictor Interface

Provides a single interface for running all RUL models and
generating maintenance schedules.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Literal
import json
import polars as pl

from .rul_models import (
    RULStringDegradationModel,
    RULInverterThermalModel,
    RULModuleDegradationModel,
    # New models (v0.4.0)
    RULThermalHotspotModel,
    RULMismatchModel,
    RULBypassDiodeModel,
    RULInsulationModel,
    # Utilities
    RULPrediction,
    BaseRULModel,
    ALL_RUL_MODELS,
)
from .features import PlantAgnosticFeatureEngine, PlantConfig


@dataclass
class MaintenanceAction:
    """A recommended maintenance action."""

    fault_type: str
    display_name: str
    urgency: Literal["urgent", "soon", "planned", "monitoring"]
    days_to_fault: float
    confidence: float
    current_value: float
    threshold: float
    unit: str
    recommended_action: str
    estimated_date: Optional[datetime] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "fault_type": self.fault_type,
            "display_name": self.display_name,
            "urgency": self.urgency,
            "days_to_fault": round(self.days_to_fault, 1),
            "confidence": round(self.confidence, 2),
            "current_value": round(self.current_value, 3) if self.current_value else None,
            "threshold": self.threshold,
            "unit": self.unit,
            "recommended_action": self.recommended_action,
            "estimated_date": self.estimated_date.isoformat() if self.estimated_date else None,
        }


@dataclass
class MaintenanceSchedule:
    """Complete maintenance schedule from all RUL predictions."""

    timestamp: datetime = field(default_factory=datetime.now)
    urgent: list[MaintenanceAction] = field(default_factory=list)  # < 3 days
    soon: list[MaintenanceAction] = field(default_factory=list)    # 3-7 days
    planned: list[MaintenanceAction] = field(default_factory=list) # 7-30 days
    monitoring: list[MaintenanceAction] = field(default_factory=list)  # > 30 days

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "timestamp": self.timestamp.isoformat(),
            "summary": {
                "urgent_count": len(self.urgent),
                "soon_count": len(self.soon),
                "planned_count": len(self.planned),
                "monitoring_count": len(self.monitoring),
            },
            "urgent": [a.to_dict() for a in self.urgent],
            "soon": [a.to_dict() for a in self.soon],
            "planned": [a.to_dict() for a in self.planned],
            "monitoring": [a.to_dict() for a in self.monitoring],
        }

    def to_json(self, path: Optional[Path] = None) -> str:
        """Export to JSON string or file."""
        data = self.to_dict()
        json_str = json.dumps(data, indent=2)

        if path:
            with open(path, "w") as f:
                f.write(json_str)

        return json_str


# Recommended actions by fault type
RECOMMENDED_ACTIONS = {
    "string_degradation": {
        "urgent": "Immediately inspect string connections and bypass diodes. Check for corrosion or loose connectors.",
        "soon": "Schedule string inspection within the week. Monitor current imbalance closely.",
        "planned": "Add to next scheduled maintenance. Document baseline CV for trending.",
        "monitoring": "Continue monitoring. String performance is within normal range.",
    },
    "inverter_thermal": {
        "urgent": "Check inverter cooling system immediately. Inspect fans, filters, and ventilation.",
        "soon": "Schedule cooling system inspection. Monitor cabinet temperature closely.",
        "planned": "Plan preventive maintenance for cooling system. Check thermal paste and heat sinks.",
        "monitoring": "Temperature within normal range. Continue standard monitoring.",
    },
    "module_degradation": {
        "urgent": "Investigate sudden performance drop. Check for hot spots, soiling, or shading issues.",
        "soon": "Schedule module inspection. Consider cleaning or I-V curve testing.",
        "planned": "Plan module performance assessment. Review degradation rate vs warranty.",
        "monitoring": "Performance within expected range. Track long-term degradation trend.",
    },
    # New fault types (v0.4.0)
    "thermal_hotspot": {
        "urgent": "CRITICAL: Inspect for localized overheating immediately. Check module ventilation and look for hotspots with IR camera.",
        "soon": "Schedule thermal inspection. Clean module surfaces and check air flow around affected area.",
        "planned": "Plan thermal imaging survey. Review module positioning and ventilation design.",
        "monitoring": "Thermal performance normal. Continue monitoring temperature delta trends.",
    },
    "mismatch": {
        "urgent": "Investigate string mismatch immediately. Check for shading, soiling differences, or failing modules.",
        "soon": "Schedule I-V curve testing on affected strings. Compare string performance.",
        "planned": "Plan string balancing assessment. Consider module reallocation or replacement.",
        "monitoring": "String performance balanced. Continue monitoring inter-string variation.",
    },
    "bypass_diode": {
        "urgent": "CRITICAL: Check bypass diodes immediately. High hotspot count indicates potential fire risk.",
        "soon": "Schedule thermal imaging and bypass diode testing. Check affected modules.",
        "planned": "Plan comprehensive bypass diode assessment. Consider module replacement strategy.",
        "monitoring": "Bypass diode stress within normal range. Continue thermal monitoring.",
    },
    "insulation": {
        "urgent": "CRITICAL: Ground fault risk! Disconnect affected strings and test Riso immediately.",
        "soon": "Schedule comprehensive insulation testing (Riso). Check for moisture ingress.",
        "planned": "Plan insulation assessment. Review backsheet condition and encapsulation integrity.",
        "monitoring": "Insulation resistance healthy. Continue annual Riso testing.",
    },
}


# Model file mapping.
#
# Four of the original seven were withdrawn: `thermal_hotspot` and
# `module_degradation` are trained substantially on `np.random.*` features that
# the source dataset does not contain, and `bypass_diode` / `insulation` were
# never produced at all. On top of that, every one of the seven was labelled with
# a closed-form invertible function of one of its own input columns, so the
# reported MAE measures the injected noise term rather than predictive skill --
# for `insulation` the reported 7.18 is exactly `9 * sqrt(2/pi)`, the score a
# perfect inverter of that function would achieve.
#
# See backenddata/models/rul/withdrawn/README.md. The three below use features
# derived from real measured signals and are pending a rebuild on real event
# labels via RULLabelGenerator.generate_from_fault_events.
MODEL_FILES = {
    "string_degradation": "rul_string_degradation.pkl",
    "inverter_thermal": "rul_inverter_thermal.pkl",
    "mismatch": "rul_mismatch.pkl",
}


class RULPredictor:
    """
    Unified interface for RUL predictions.

    Loads all trained RUL models and provides:
    - Individual fault type predictions
    - Combined predictions across all models
    - Maintenance schedule generation
    """

    def __init__(self, model_dir: str):
        """
        Initialize predictor with trained models.

        Args:
            model_dir: Directory containing trained RUL models
        """
        self.model_dir = Path(model_dir)
        self.models: dict[str, BaseRULModel] = {}

        # Load available models
        self._load_models()

    def _load_models(self):
        """Load all available RUL models from directory."""
        for fault_type, filename in MODEL_FILES.items():
            model_path = self.model_dir / filename
            if model_path.exists():
                try:
                    # Use the appropriate model class for loading
                    model_class = ALL_RUL_MODELS.get(fault_type)
                    if model_class:
                        self.models[fault_type] = model_class.load(model_path)
                        print(f"  Loaded RUL model: {fault_type}")
                except Exception as e:
                    print(f"  Warning: Failed to load {fault_type} model: {e}")

        print(f"Loaded {len(self.models)} / {len(MODEL_FILES)} RUL models")

    def predict_single(
        self,
        df: pl.DataFrame,
        fault_type: str,
    ) -> list[RULPrediction]:
        """
        Run a single RUL model.

        Args:
            df: DataFrame with required features
            fault_type: Type of fault to predict

        Returns:
            List of RUL predictions
        """
        if fault_type not in self.models:
            raise ValueError(f"Model '{fault_type}' not loaded. Available: {list(self.models.keys())}")

        model = self.models[fault_type]
        return model.predict_from_df(df)

    def predict_all(
        self,
        df: pl.DataFrame,
        plant_config: Optional[PlantConfig] = None,
    ) -> dict[str, list[RULPrediction]]:
        """
        Run all available RUL models.

        Args:
            df: Input DataFrame
            plant_config: Plant configuration for feature engineering

        Returns:
            Dictionary mapping fault_type to predictions
        """
        # Compute features if not already present
        if plant_config and not self._has_rul_features(df):
            engine = PlantAgnosticFeatureEngine(plant_config)
            df = engine.transform(df, include_temporal=True, include_rul_features=True)

        results = {}
        for fault_type, model in self.models.items():
            try:
                # Check if required features are available
                missing = [c for c in model.feature_columns if c not in df.columns]
                if missing:
                    print(f"Skipping {fault_type}: missing features {missing}")
                    continue

                predictions = model.predict_from_df(df)
                results[fault_type] = predictions
            except Exception as e:
                print(f"Warning: Failed to predict {fault_type}: {e}")

        return results

    def get_maintenance_schedule(
        self,
        df: pl.DataFrame,
        plant_config: Optional[PlantConfig] = None,
        aggregate_method: Literal["latest", "worst", "mean"] = "latest",
    ) -> MaintenanceSchedule:
        """
        Generate a maintenance schedule from RUL predictions.

        Args:
            df: Input DataFrame
            plant_config: Plant configuration
            aggregate_method: How to aggregate multiple timestamps:
                - "latest": Use only the most recent prediction
                - "worst": Use the worst (lowest) RUL across timestamps
                - "mean": Average RUL across timestamps

        Returns:
            MaintenanceSchedule with prioritized actions
        """
        # Get predictions from all models
        all_predictions = self.predict_all(df, plant_config)

        schedule = MaintenanceSchedule()

        for fault_type, predictions in all_predictions.items():
            if not predictions:
                continue

            # Aggregate predictions
            if aggregate_method == "latest":
                pred = predictions[-1]  # Last timestamp
            elif aggregate_method == "worst":
                pred = min(predictions, key=lambda p: p.days_to_fault)
            else:  # mean
                avg_days = sum(p.days_to_fault for p in predictions) / len(predictions)
                avg_conf = sum(p.confidence for p in predictions) / len(predictions)
                pred = predictions[0]
                pred.days_to_fault = avg_days
                pred.confidence = avg_conf

            # Create maintenance action
            action = self._create_maintenance_action(pred, fault_type)

            # Categorize by urgency
            if action.days_to_fault < 3:
                schedule.urgent.append(action)
            elif action.days_to_fault < 7:
                schedule.soon.append(action)
            elif action.days_to_fault < 30:
                schedule.planned.append(action)
            else:
                schedule.monitoring.append(action)

        # Sort each category by days_to_fault
        schedule.urgent.sort(key=lambda a: a.days_to_fault)
        schedule.soon.sort(key=lambda a: a.days_to_fault)
        schedule.planned.sort(key=lambda a: a.days_to_fault)
        schedule.monitoring.sort(key=lambda a: a.days_to_fault)

        return schedule

    def _create_maintenance_action(
        self,
        prediction: RULPrediction,
        fault_type: str,
    ) -> MaintenanceAction:
        """Create a maintenance action from a prediction."""
        # Determine urgency
        days = prediction.days_to_fault
        if days < 3:
            urgency = "urgent"
        elif days < 7:
            urgency = "soon"
        elif days < 30:
            urgency = "planned"
        else:
            urgency = "monitoring"

        # Get display name and unit from model config
        model = self.models.get(fault_type)
        if model:
            display_name = model.config.display_name
            unit = model.config.unit
        else:
            display_name = fault_type.replace("_", " ").title()
            unit = ""

        # Get recommended action
        actions = RECOMMENDED_ACTIONS.get(fault_type, {})
        recommended = actions.get(urgency, "Review and assess condition.")

        return MaintenanceAction(
            fault_type=fault_type,
            display_name=display_name,
            urgency=urgency,
            days_to_fault=prediction.days_to_fault,
            confidence=prediction.confidence,
            current_value=prediction.current_value,
            threshold=prediction.threshold,
            unit=unit,
            recommended_action=recommended,
            estimated_date=datetime.now() + timedelta(days=prediction.days_to_fault),
        )

    def _has_rul_features(self, df: pl.DataFrame) -> bool:
        """Check if DataFrame already has RUL features."""
        rul_features = [
            "efficiency_trend_7d",
            "pr_trend_7d",
            "string_cv_trend_7d",
        ]
        return any(f in df.columns for f in rul_features)

    def get_available_models(self) -> list[str]:
        """Get list of loaded model names."""
        return list(self.models.keys())

    def get_model_info(self) -> dict:
        """Get information about loaded models."""
        info = {}
        for fault_type, model in self.models.items():
            info[fault_type] = {
                "display_name": model.config.display_name,
                "threshold": model.config.threshold,
                "unit": model.config.unit,
                "max_horizon_days": model.config.max_horizon_days,
                "features": model.feature_columns,
            }
        return info


def create_predictor(model_dir: str = "models/rul") -> RULPredictor:
    """
    Create an RUL predictor with default model directory.

    Args:
        model_dir: Path to directory containing trained models

    Returns:
        Configured RULPredictor instance
    """
    return RULPredictor(model_dir)
