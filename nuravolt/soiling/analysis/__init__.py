"""Soiling analysis modules.

This package provides advanced analysis tools for soiling detection:

- **Decay Fitting**: Piecewise fitting of soiling decay between rain events
- **Inverter Selection**: Zone-representative inverter selection for training
- **Shading Separation**: Explicit separation of shading from soiling losses
"""

from nuravolt.soiling.analysis.decay_fitting import (
    PiecewiseDecayFitter,
    SoilingSegment,
    DecayFitConfig,
    fit_plant_decay,
)
from nuravolt.soiling.analysis.inverter_selection import (
    InverterSelector,
    InverterQuality,
    ZoneConfig,
)
from nuravolt.soiling.analysis.shading_separation import (
    ShadingSeparator,
    ShadingProfile,
)

__all__ = [
    # Decay fitting
    "PiecewiseDecayFitter",
    "SoilingSegment",
    "DecayFitConfig",
    "fit_plant_decay",
    # Inverter selection
    "InverterSelector",
    "InverterQuality",
    "ZoneConfig",
    # Shading separation
    "ShadingSeparator",
    "ShadingProfile",
]
