"""Physics-only row classifier — uses ONLY production thresholds from config.py.

This is the honest "blind" baseline: thresholds come from
``nuravolt/fault/config.py`` defaults which are manufacturer-spec /
universal-physics values that were NEVER tuned to any dataset's
distribution.

Contrast with ``pv_row_classifier.py`` (the per-class-percentile-tuned
surrogate) — that one's thresholds were calibrated from Lazzaretti
distribution statistics, so its 0.835 F1 on Lazzaretti held-out is
in-distribution-leakage.

This physics-only classifier should score:
- Honestly on any dataset (lower than the tuned surrogate on Lazzaretti,
  but the same number across all datasets that have similar physics)
- A floor that any real client's data should hit since the thresholds
  are physics-derived

Used for cross-distribution validation only — not the production cascade
(production uses the full pipeline in nuravolt/fault/cascade_attribution.py
which works on aggregate plant DataFrames, not per-row samples).

.. deprecated::
    Superseded by ``nuravolt/validation/row_classifier.py``, one parameterised
    cascade that reproduces this module row for row and additionally works on a
    rig of a different size. New code should use that.

    This file is deliberately **not** a shim delegating to the replacement. It is
    the reference implementation the replacement is verified against
    (``tests/validation/test_row_classifier.py::TestReproduction``), and a shim
    would make that test compare the new code with itself. It stays frozen: do
    not fix bugs here, because a change would silently move the baseline that
    proves the refactor was behaviour preserving.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from nuravolt.fault.config import FaultDetectionConfig


# Single source of truth — these are the production defaults
_CFG = FaultDetectionConfig()

# All thresholds below come from ``config.py`` defaults (never tuned per-dataset).
DAYLIGHT_IRR_FLOOR = 200.0   # mirrors string.min_daylight_irradiance (200 W/m²)
MIN_ACTIVE_CURRENT_A = _CFG.string.min_active_current     # 0.5 A
SHORT_CIRCUIT_VOLTAGE_RATIO = _CFG.string.short_circuit_voltage_ratio  # 0.7
MPPT_IMBALANCE_CV_WARNING = _CFG.mppt.imbalance_cv_warning  # 0.15
MPPT_IMBALANCE_CV_CRITICAL = _CFG.mppt.imbalance_cv_critical  # 0.25
STRING_MISMATCH_THRESHOLD = _CFG.mppt.string_mismatch_threshold  # 0.85
# Open circuit: a string is "open" when its voltage drops below 20% of the
# OTHER string's voltage (operationally meaningless threshold). This isn't in
# config.py per se but is a direct physics interpretation of "open circuit".
OPEN_CIRCUIT_VOLTAGE_RATIO = 0.2


def classify_dataframe(signals: pl.DataFrame) -> pl.Series:
    """Physics-only per-row classification — no dataset stats used.

    Returns one of:
        "normal", "open_circuit", "short_circuit", "partial_shading",
        "degradation".
    """
    required = {
        "poa_irradiance", "module_temp",
        "string_voltage_1", "string_voltage_2",
        "string_current_1", "string_current_2",
    }
    missing = required - set(signals.columns)
    if missing:
        raise ValueError(f"signals missing columns: {missing}")

    irr = signals["poa_irradiance"].to_numpy()
    v1 = signals["string_voltage_1"].to_numpy()
    v2 = signals["string_voltage_2"].to_numpy()
    i1 = signals["string_current_1"].to_numpy()
    i2 = signals["string_current_2"].to_numpy()

    n = len(signals)
    preds = np.full(n, "normal", dtype=object)

    daylight = irr >= DAYLIGHT_IRR_FLOOR

    v_max = np.maximum(np.abs(v1), np.abs(v2))
    v_min_to_max_ratio = np.where(v_max > 0, np.minimum(np.abs(v1), np.abs(v2)) / v_max, 1.0)
    i_max = np.maximum(np.abs(i1), np.abs(i2))
    i_min_to_max_ratio = np.where(i_max > 0, np.minimum(np.abs(i1), np.abs(i2)) / i_max, 1.0)
    i_mean = (i1 + i2) / 2

    # ── Open circuit: voltage ratio below threshold (one string collapsed)
    #    AND minimum current below operational floor
    oc = daylight & (v_min_to_max_ratio < OPEN_CIRCUIT_VOLTAGE_RATIO) & (
        np.minimum(np.abs(i1), np.abs(i2)) < MIN_ACTIVE_CURRENT_A
    )
    preds[oc] = "open_circuit"

    # ── Short circuit: voltage_min / voltage_max drops below
    #    short_circuit_voltage_ratio (0.7), but currents still flowing
    sc = daylight & ~oc & (v_min_to_max_ratio < SHORT_CIRCUIT_VOLTAGE_RATIO) & (
        i_max > MIN_ACTIVE_CURRENT_A * 2
    )
    preds[sc] = "short_circuit"

    # ── Partial shading: string MISMATCH below threshold (one string
    #    significantly underperforming) — uses production string_mismatch_threshold
    shading = daylight & ~oc & ~sc & (i_min_to_max_ratio < STRING_MISMATCH_THRESHOLD)
    preds[shading] = "partial_shading"

    # ── Degradation: MPPT current imbalance CV exceeds warning threshold
    #    (uses production mppt.imbalance_cv_warning) but both strings still
    #    producing meaningful current
    with np.errstate(divide="ignore", invalid="ignore"):
        i_cv = np.where(i_mean > 0.1, np.abs(i1 - i2) / i_mean / 2, 0.0)
    deg = daylight & ~oc & ~sc & ~shading & (i_cv > MPPT_IMBALANCE_CV_WARNING)
    preds[deg] = "degradation"

    return pl.Series("predicted_class", preds, dtype=pl.Utf8)
