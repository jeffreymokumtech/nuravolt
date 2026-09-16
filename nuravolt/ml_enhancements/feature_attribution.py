"""
Feature Attribution using SHAP

Explains which features drove anomaly detection at the per-sample level.
This is CRITICAL for LLM interpretation - gives it something meaningful to explain.

Supported models:
- LightGBM (TreeExplainer - fast, exact)
- CatBoost (TreeExplainer - fast, exact)
- Isolation Forest (KernelExplainer - slower, approximate)

Usage:
    from nuravolt.ml_enhancements import SHAPAttributor

    # For LightGBM/CatBoost models
    attributor = SHAPAttributor(
        model=digital_twin.ml_model,
        feature_names=['ghi', 'temp_ambient', 'wind_speed', 'hour'],
        background_data=training_data[:100]
    )

    attribution = attributor.explain(anomaly_features)
    print(f"Top contributor: {attribution.top_contributors[0]}")
    # Output: ('temp_ambient', 0.34)
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Any
import numpy as np
import logging

logger = logging.getLogger(__name__)

# Lazy import SHAP to avoid dependency issues at module load
_shap = None


def _ensure_shap():
    """Lazy load SHAP library."""
    global _shap
    if _shap is None:
        try:
            import shap
            _shap = shap
        except ImportError:
            raise ImportError(
                "SHAP required for feature attribution. "
                "Install with: pip install shap"
            )
    return _shap


@dataclass
class FeatureAttribution:
    """Attribution result for a single prediction."""
    feature_contributions: Dict[str, float]  # Feature name -> SHAP value
    top_contributors: List[Tuple[str, float]]  # Sorted by |contribution|
    base_value: float  # Expected value without any features
    prediction: float  # Final prediction
    explanation_text: str  # Human-readable explanation

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'featureContributions': self.feature_contributions,
            'topContributors': [
                {'feature': f, 'contribution': round(c, 4)}
                for f, c in self.top_contributors
            ],
            'baseValue': round(self.base_value, 4),
            'prediction': round(self.prediction, 4),
            'explanationText': self.explanation_text,
        }


class SHAPAttributor:
    """
    SHAP-based feature attribution for NuraVolt models.

    Automatically selects the best explainer based on model type:
    - TreeExplainer for LightGBM, CatBoost (fast, exact)
    - KernelExplainer for Isolation Forest, other models (slower)

    Example:
        attributor = SHAPAttributor(
            model=digital_twin.ml_model,
            feature_names=['ghi', 'temp_ambient', 'wind_speed', 'hour'],
            background_data=training_data[:100]
        )

        attribution = attributor.explain(anomaly_features)
        print(f"Top contributor: {attribution.top_contributors[0]}")
    """

    # Models that support fast TreeExplainer
    TREE_MODELS = {
        'LGBMRegressor', 'LGBMClassifier', 'Booster',
        'XGBRegressor', 'XGBClassifier',
        'CatBoostRegressor', 'CatBoostClassifier', 'CatBoost',
        'RandomForestRegressor', 'RandomForestClassifier',
        'GradientBoostingRegressor', 'GradientBoostingClassifier',
    }

    def __init__(
        self,
        model: Any,
        feature_names: List[str],
        background_data: Optional[np.ndarray] = None,
        max_background_samples: int = 100
    ):
        """
        Initialize SHAP attributor.

        Args:
            model: Trained model with predict() method
            feature_names: List of feature names matching model input
            background_data: Sample of training data for KernelExplainer
            max_background_samples: Max samples for background (for speed)
        """
        shap = _ensure_shap()

        self.model = model
        self.feature_names = feature_names
        self.explainer = None
        self.explainer_type = None

        # Determine model type and create appropriate explainer
        model_type = type(model).__name__

        if model_type in self.TREE_MODELS:
            # Fast TreeExplainer for tree-based models
            try:
                self.explainer = shap.TreeExplainer(model)
                self.explainer_type = "tree"
                logger.info(f"Using TreeExplainer for {model_type}")
            except Exception as e:
                logger.warning(f"TreeExplainer failed: {e}, falling back to Kernel")
                self._create_kernel_explainer(model, background_data, max_background_samples)

        elif model_type == 'IsolationForest':
            # Isolation Forest needs special handling with decision_function
            self._create_isolation_forest_explainer(model, background_data, max_background_samples)

        else:
            # Generic KernelExplainer for other models
            self._create_kernel_explainer(model, background_data, max_background_samples)

    def _create_kernel_explainer(
        self,
        model: Any,
        background_data: Optional[np.ndarray],
        max_samples: int
    ):
        """Create model-agnostic KernelExplainer."""
        shap = _ensure_shap()

        if background_data is None:
            raise ValueError("background_data required for KernelExplainer")

        # Subsample background for speed
        if len(background_data) > max_samples:
            idx = np.random.choice(len(background_data), max_samples, replace=False)
            background_data = background_data[idx]

        self.explainer = shap.KernelExplainer(model.predict, background_data)
        self.explainer_type = "kernel"
        logger.info(f"Using KernelExplainer with {len(background_data)} background samples")

    def _create_isolation_forest_explainer(
        self,
        model: Any,
        background_data: Optional[np.ndarray],
        max_samples: int
    ):
        """Create explainer for Isolation Forest using decision_function."""
        shap = _ensure_shap()

        if background_data is None:
            raise ValueError("background_data required for IsolationForest explainer")

        if len(background_data) > max_samples:
            idx = np.random.choice(len(background_data), max_samples, replace=False)
            background_data = background_data[idx]

        # Use decision_function (anomaly score) instead of predict
        # Negate so higher values = more anomalous
        self.explainer = shap.KernelExplainer(
            lambda x: -model.decision_function(x),
            background_data
        )
        self.explainer_type = "isolation_forest"
        logger.info("Using KernelExplainer for IsolationForest")

    def explain(
        self,
        instance: np.ndarray,
        top_k: int = 5
    ) -> FeatureAttribution:
        """
        Explain a single prediction using SHAP.

        Args:
            instance: Feature vector to explain (1D or 2D array)
            top_k: Number of top contributors to return

        Returns:
            FeatureAttribution with contributions and explanation
        """
        if instance.ndim == 1:
            instance = instance.reshape(1, -1)

        # Compute SHAP values
        shap_values = self.explainer.shap_values(instance)

        # Handle different SHAP output formats
        if isinstance(shap_values, list):
            shap_values = shap_values[0]  # For classifiers, take first class
        shap_values = shap_values.flatten()

        # Build contribution dict
        contributions = {}
        for i, name in enumerate(self.feature_names):
            if i < len(shap_values):
                contributions[name] = float(shap_values[i])

        # Sort by absolute contribution
        sorted_contributions = sorted(
            contributions.items(),
            key=lambda x: abs(x[1]),
            reverse=True
        )

        # Generate explanation text
        explanation = self._generate_explanation_text(
            sorted_contributions[:top_k],
            instance.flatten()
        )

        # Get base value and prediction
        if hasattr(self.explainer, 'expected_value'):
            base_value = float(
                self.explainer.expected_value[0]
                if isinstance(self.explainer.expected_value, np.ndarray)
                else self.explainer.expected_value
            )
        else:
            base_value = 0.0

        prediction = base_value + sum(shap_values)

        return FeatureAttribution(
            feature_contributions=contributions,
            top_contributors=sorted_contributions[:top_k],
            base_value=base_value,
            prediction=prediction,
            explanation_text=explanation
        )

    def explain_batch(
        self,
        instances: np.ndarray,
        top_k: int = 5
    ) -> List[FeatureAttribution]:
        """
        Explain multiple predictions.

        Args:
            instances: Feature matrix (n_samples, n_features)
            top_k: Number of top contributors per instance

        Returns:
            List of FeatureAttribution objects
        """
        if instances.ndim == 1:
            instances = instances.reshape(1, -1)

        results = []
        for i in range(len(instances)):
            results.append(self.explain(instances[i:i+1], top_k))

        return results

    def _generate_explanation_text(
        self,
        top_contributors: List[Tuple[str, float]],
        feature_values: np.ndarray
    ) -> str:
        """Generate human-readable explanation from SHAP values."""
        explanations = []

        for feature, shap_value in top_contributors[:3]:
            try:
                idx = self.feature_names.index(feature)
                value = feature_values[idx]
            except (ValueError, IndexError):
                value = None

            direction = "increased" if shap_value > 0 else "decreased"
            impact = "anomaly likelihood" if shap_value > 0 else "expected behavior"

            if value is not None:
                explanations.append(
                    f"{feature}={value:.2f} {direction} {impact} by {abs(shap_value):.3f}"
                )
            else:
                explanations.append(
                    f"{feature} {direction} {impact} by {abs(shap_value):.3f}"
                )

        return "; ".join(explanations) if explanations else "No significant contributors"


def create_attributor_for_model(
    model: Any,
    feature_names: List[str],
    training_data: Optional[np.ndarray] = None
) -> SHAPAttributor:
    """
    Factory function to create appropriate attributor for a model.

    Args:
        model: Trained model
        feature_names: Feature names
        training_data: Training data sample (required for some models)

    Returns:
        Configured SHAPAttributor
    """
    return SHAPAttributor(
        model=model,
        feature_names=feature_names,
        background_data=training_data
    )
