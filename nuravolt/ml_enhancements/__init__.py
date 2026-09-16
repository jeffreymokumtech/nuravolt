"""
ML Enhancements Module

Adds explainability and confidence quantification to NuraVolt ML models:
- SHAP feature attribution for per-sample explanations
- Bootstrap confidence intervals for uncertainty quantification
- Alert correlation using DBSCAN clustering
- Historical event matching using KNN

These enhancements work without LLM and provide the rich context
that makes LLM interpretations valuable.
"""

from nuravolt.ml_enhancements.feature_attribution import (
    SHAPAttributor,
    FeatureAttribution,
)

__all__ = [
    "SHAPAttributor",
    "FeatureAttribution",
]
