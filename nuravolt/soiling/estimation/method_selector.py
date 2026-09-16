"""
SR Method Selector - Automatic method selection and orchestration.

This module provides intelligent selection of the best available
SR estimation method based on data availability and confidence.

Hierarchy (priority order):
1. DustIQ Sensor (95% confidence) - Direct measurement
2. Same-Plant ML (85% confidence) - Trained on plant's DustIQ
3. Transfer Learning (75% confidence) - From similar plant
4. Foundation Model (65% confidence) - Global model
5. Loss Disaggregation (55% confidence) - Physics-based

The selector:
- Checks availability of each method
- Auto-selects the highest confidence method
- Allows manual override
- Provides comparison of all available methods
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Any

import pandas as pd

from .base import (
    EstimationLayer,
    MethodAvailability,
    SREstimationResult,
    SREstimator,
    LAYER_CONFIDENCE,
)
from .layer1_dustiq import DustIQEstimator
from .layer2_same_plant_ml import SamePlantMLEstimator
from .layer3_transfer import TransferLearningEstimator
from .layer4_foundation import FoundationModelEstimator
from .layer5_disaggregation import LossDisaggregationEstimator
from .similarity import PlantSimilarityScorer


@dataclass
class MethodSelectionResult:
    """Result of method selection for a plant."""

    plant_id: str
    selected_method: str
    selected_layer: int
    confidence: int
    reason: str
    all_methods: List[MethodAvailability]

    def to_dict(self) -> dict:
        return {
            "plant_id": self.plant_id,
            "selected_method": self.selected_method,
            "selected_layer": self.selected_layer,
            "confidence": self.confidence,
            "reason": self.reason,
            "all_methods": [m.to_dict() for m in self.all_methods],
        }


class SRMethodSelector:
    """Intelligent SR estimation method selector.

    Automatically selects the best available method based on
    data availability and expected confidence.

    Attributes
    ----------
    data_dir : Path
        Directory containing plant soiling data
    model_dir : Path
        Directory for trained models
    estimators : dict
        Cached estimator instances by layer
    """

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        model_dir: Optional[Path] = None,
    ):
        """Initialize method selector.

        Parameters
        ----------
        data_dir : Path, optional
            Directory containing plant soiling data.
        model_dir : Path, optional
            Directory for trained models.
        """
        self.data_dir = Path(data_dir) if data_dir else Path("public/data/soiling")
        self.model_dir = Path(model_dir) if model_dir else Path("backenddata/models")
        self.model_dir.mkdir(parents=True, exist_ok=True)

        # Initialize estimators lazily
        self._estimators: Dict[EstimationLayer, SREstimator] = {}
        self._transfer_configs: Dict[str, dict] = {}  # Manual source plant configs

    def _get_estimator(self, layer: EstimationLayer) -> SREstimator:
        """Get or create estimator for a layer."""
        if layer not in self._estimators:
            if layer == EstimationLayer.DUSTIQ:
                self._estimators[layer] = DustIQEstimator(data_dir=self.data_dir)
            elif layer == EstimationLayer.SAME_PLANT_ML:
                self._estimators[layer] = SamePlantMLEstimator(
                    data_dir=self.data_dir,
                    model_dir=self.model_dir / "same_plant",
                )
            elif layer == EstimationLayer.TRANSFER:
                self._estimators[layer] = TransferLearningEstimator(
                    data_dir=self.data_dir,
                    model_dir=self.model_dir / "transfer",
                )
            elif layer == EstimationLayer.FOUNDATION:
                self._estimators[layer] = FoundationModelEstimator(
                    data_dir=self.data_dir,
                    model_dir=self.model_dir / "foundation",
                )
            elif layer == EstimationLayer.DISAGGREGATION:
                self._estimators[layer] = LossDisaggregationEstimator(
                    data_dir=self.data_dir,
                )

        return self._estimators[layer]

    def get_availability(self, plant_id: str) -> List[MethodAvailability]:
        """Get availability of all SR estimation methods for a plant.

        Parameters
        ----------
        plant_id : str
            Plant identifier

        Returns
        -------
        list of MethodAvailability
            Availability status for each method, sorted by layer
        """
        availabilities = []

        for layer in EstimationLayer:
            try:
                estimator = self._get_estimator(layer)
                avail = estimator.check_availability(plant_id)
                availabilities.append(avail)
            except Exception as e:
                # If estimator fails to check, mark as unavailable
                availabilities.append(MethodAvailability(
                    method=layer.name.lower(),
                    layer=layer,
                    is_available=False,
                    reason=f"Error checking availability: {str(e)}",
                    confidence=0,
                ))

        return availabilities

    def auto_select(self, plant_id: str) -> MethodSelectionResult:
        """Automatically select the best available method for a plant.

        Selection is based on:
        1. Method availability
        2. Expected confidence
        3. Layer priority (lower layer = higher priority)

        Parameters
        ----------
        plant_id : str
            Plant identifier

        Returns
        -------
        MethodSelectionResult
            Selection result with chosen method and all options
        """
        availabilities = self.get_availability(plant_id)

        # Filter to available methods
        available = [a for a in availabilities if a.is_available]

        if not available:
            return MethodSelectionResult(
                plant_id=plant_id,
                selected_method="none",
                selected_layer=0,
                confidence=0,
                reason="No SR estimation methods available",
                all_methods=availabilities,
            )

        # Sort by layer (priority order) - lower layer = higher priority
        available.sort(key=lambda a: a.layer)

        # Select first available (highest priority)
        selected = available[0]

        return MethodSelectionResult(
            plant_id=plant_id,
            selected_method=selected.method,
            selected_layer=int(selected.layer),
            confidence=selected.confidence,
            reason=selected.reason,
            all_methods=availabilities,
        )

    def estimate(
        self,
        plant_id: str,
        method_override: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> SREstimationResult:
        """Estimate SR using the best available or specified method.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        method_override : str, optional
            Force specific method ("dustiq", "same_plant_ml", "transfer",
            "foundation", "disaggregation")
        start_date : str, optional
            Start date (YYYY-MM-DD)
        end_date : str, optional
            End date (YYYY-MM-DD)

        Returns
        -------
        SREstimationResult
            Estimation results from selected method
        """
        if method_override:
            # Map method name to layer
            method_map = {
                "dustiq": EstimationLayer.DUSTIQ,
                "same_plant_ml": EstimationLayer.SAME_PLANT_ML,
                "transfer": EstimationLayer.TRANSFER,
                "transfer_learning": EstimationLayer.TRANSFER,
                "foundation": EstimationLayer.FOUNDATION,
                "foundation_model": EstimationLayer.FOUNDATION,
                "disaggregation": EstimationLayer.DISAGGREGATION,
                "loss_disaggregation": EstimationLayer.DISAGGREGATION,
            }

            layer = method_map.get(method_override.lower())
            if layer is None:
                raise ValueError(f"Unknown method: {method_override}")

            estimator = self._get_estimator(layer)
        else:
            # Auto-select
            selection = self.auto_select(plant_id)
            if selection.selected_method == "none":
                raise ValueError(selection.reason)

            layer = EstimationLayer(selection.selected_layer)
            estimator = self._get_estimator(layer)

        return estimator.estimate(plant_id, start_date, end_date)

    def compare_methods(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run all available methods and compare results.

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
        dict
            Comparison results with SR from each method
        """
        availabilities = self.get_availability(plant_id)
        results = {}
        errors = {}

        for avail in availabilities:
            if not avail.is_available:
                continue

            try:
                estimator = self._get_estimator(avail.layer)
                result = estimator.estimate(plant_id, start_date, end_date)

                results[avail.method] = {
                    "layer": int(avail.layer),
                    "confidence": avail.confidence,
                    "avg_sr": result.avg_sr,
                    "current_sr": result.current_sr,
                    "estimated_loss_pct": result.estimated_loss_pct,
                    "n_days": len(result.sr_values),
                    "validation": {
                        "mae": result.validation_mae,
                        "rmse": result.validation_rmse,
                        "r2": result.validation_r2,
                    },
                    "source_plant": result.source_plant,
                }
            except Exception as e:
                errors[avail.method] = str(e)

        return {
            "plant_id": plant_id,
            "methods_compared": len(results),
            "results": results,
            "errors": errors,
            "all_availabilities": [a.to_dict() for a in availabilities],
        }

    def set_transfer_source(
        self,
        target_plant: str,
        source_plant: str,
    ) -> float:
        """Manually configure transfer learning source for a plant.

        Parameters
        ----------
        target_plant : str
            Target plant ID
        source_plant : str
            Source plant ID (must have DustIQ)

        Returns
        -------
        float
            Similarity score between plants
        """
        transfer_estimator = self._get_estimator(EstimationLayer.TRANSFER)
        if isinstance(transfer_estimator, TransferLearningEstimator):
            return transfer_estimator.set_source_plant(target_plant, source_plant)
        raise RuntimeError("Transfer estimator not available")

    def get_transfer_config(self, plant_id: str) -> Optional[dict]:
        """Get current transfer learning configuration for a plant."""
        transfer_estimator = self._get_estimator(EstimationLayer.TRANSFER)
        if isinstance(transfer_estimator, TransferLearningEstimator):
            return transfer_estimator.get_transfer_config(plant_id)
        return None

    def get_ranked_transfer_sources(
        self,
        target_plant: str,
        top_k: int = 3,
    ) -> List[dict]:
        """Get ranked list of potential transfer sources for a plant."""
        transfer_estimator = self._get_estimator(EstimationLayer.TRANSFER)
        if isinstance(transfer_estimator, TransferLearningEstimator):
            return transfer_estimator.get_ranked_sources(target_plant, top_k)
        return []

    def retrain_same_plant_model(self, plant_id: str, verbose: bool = True) -> dict:
        """Force retrain the Same-Plant ML model for a plant.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        verbose : bool
            Print training progress

        Returns
        -------
        dict
            Training metrics
        """
        estimator = self._get_estimator(EstimationLayer.SAME_PLANT_ML)
        if isinstance(estimator, SamePlantMLEstimator):
            return estimator.retrain(plant_id, verbose)
        raise RuntimeError("Same-Plant ML estimator not available")

    def get_similarity_matrix(self) -> pd.DataFrame:
        """Get plant similarity matrix for transfer learning."""
        scorer = PlantSimilarityScorer()
        return scorer.get_similarity_matrix()

    def get_dustiq_plants(self) -> List[str]:
        """Get list of plants with DustIQ sensors."""
        dustiq_estimator = self._get_estimator(EstimationLayer.DUSTIQ)
        if isinstance(dustiq_estimator, DustIQEstimator):
            return dustiq_estimator.get_dustiq_plants()
        return []
