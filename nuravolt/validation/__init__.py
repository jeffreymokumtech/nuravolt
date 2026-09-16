"""Validation harness for NuraVolt detectors against public labeled datasets.

Each adapter loads a raw public dataset and yields detector inputs +
ground-truth labels. Metrics package computes confusion matrices, RUL
prediction error, and soiling RMSE. Reports land in
``backenddata/validation/{algo}/{dataset}.json``.

Detectors are untouched — the harness is read-only against them.
"""

__version__ = "0.1.0"
