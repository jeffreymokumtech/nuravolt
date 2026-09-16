"""Soiling feature extraction modules.

This package provides feature extraction for soiling estimation:

- **Twin Features**: Physics and ML residual features for transfer learning
- **Original Features**: Historical soiling, weather, and temporal/physics features
"""

from nuravolt.soiling.features.twin_features import (
    TwinFeatureExtractor,
    TwinFeatureConfig,
    TwinFeatures,
    compute_transfer_features,
)

# Re-export original feature functions from the parent features.py module
# This maintains backward compatibility after package restructuring
import sys
import importlib.util

# Load the original features.py as a separate module
_features_path = __file__.replace("features/__init__.py", "features.py")
_spec = importlib.util.spec_from_file_location("_soiling_features_original", _features_path)
_features_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_features_module)

# Re-export original functions
create_all_features = _features_module.create_all_features
create_historical_soiling_features = _features_module.create_historical_soiling_features
create_weather_features = _features_module.create_weather_features
create_temporal_physics_features = _features_module.create_temporal_physics_features

__all__ = [
    # Twin features (new)
    "TwinFeatureExtractor",
    "TwinFeatureConfig",
    "TwinFeatures",
    "compute_transfer_features",
    # Original feature functions (backward compatibility)
    "create_all_features",
    "create_historical_soiling_features",
    "create_weather_features",
    "create_temporal_physics_features",
]
