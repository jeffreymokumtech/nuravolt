"""
NuraVolt: Solar PV Intelligence Platform

A comprehensive platform for solar PV system monitoring, fault detection,
and digital twin modeling.

Modules:
    soiling: Soiling detection, forecasting, and cleaning optimization
    fault: Fault detection and diagnosis (placeholder)
    digitaltwin: Digital twin modeling and simulation (placeholder)
"""

__version__ = "0.1.0"
__author__ = "NuraVolt Team"

__all__ = ["soiling", "fault", "digitaltwin"]


def __getattr__(name: str):
    """
    Lazy-import submodules to avoid importing heavy optional dependencies
    (e.g., LightGBM/Matplotlib) when they aren't needed.
    """
    if name in __all__:
        import importlib

        module = importlib.import_module(f"{__name__}.{name}")
        globals()[name] = module
        return module
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")
