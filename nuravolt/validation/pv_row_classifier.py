"""Row-level PV fault classifier — surrogate for the cascade detector.

The production cascade in ``nuravolt/fault/rule_based.py`` operates on
aggregate plant DataFrames. This module provides a thin per-row
surrogate that applies the SAME discriminators (string-current
imbalance, string-voltage imbalance, current-vs-irradiance ratio,
voltage-at-MPP) so the validation harness can measure detection logic
accuracy against labeled public datasets.

Thresholds are derived empirically from per-class percentile analysis of
the Lazzaretti dataset (see ``scripts/validate_pv_faults.py``), and
mirror the same logical signals our production rules use:
- ``string_current_cv`` (mismatch / degradation in rul_models.py)
- ``string_balance_ratio`` (open circuit in rule_based.py)
- ``voltage delta`` (short circuit in rule_based.py)
- ``current_ratio`` vs irradiance (partial shading, degradation)

Not used in production inference — production path stays
``rule_based.py`` against aggregate SCADA.

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

from typing import Optional

import numpy as np
import polars as pl


# Discrimination thresholds — calibrated against Lazzaretti class statistics
DAYLIGHT_IRRADIANCE_FLOOR_W_M2 = 200.0

# Open circuit: one string fully disconnected — voltage AND current near zero on one side
OPEN_CIRCUIT_CURRENT_RATIO_MAX = 0.60          # observed p75 for open class is 0.532
OPEN_CIRCUIT_V_IMBALANCE_MIN = 1.0             # one string voltage near zero

# Short circuit: large voltage delta between strings + currents both elevated
SHORT_CIRCUIT_V_IMBALANCE_MIN = 0.15           # observed p25 for short is 0.246
SHORT_CIRCUIT_V_MEAN_MAX = 245.0               # observed p75 for short is 234
SHORT_CIRCUIT_CURRENT_RATIO_MIN = 0.90         # currents still flowing

# Partial shading: reduced current at moderate irradiance, voltage stays above
# the depressed-resistive-fault zone (v_mean > 240). Tightening cr to <0.90
# (was 0.95) separates shading cleanly from degradation (which sits at cr ~ 1.0).
PARTIAL_SHADING_V_MEAN_MIN = 240.0
PARTIAL_SHADING_CURRENT_RATIO_MAX = 0.90

# Degradation: joint i+v imbalance (resistive fault signature) + depressed v_mean
# + current_ratio still near 1.0 (distinguishes from shading which depresses current).
# Joint threshold beats per-axis thresholds because the signature is SIMULTANEOUS
# small imbalances on both axes — one alone overlaps with normal noise.
DEGRADATION_IV_IMBALANCE_SUM_MIN = 0.10        # i_imb + v_imb combined
DEGRADATION_V_MEAN_MAX = 260.0                 # observed p75 for degradation is 254
DEGRADATION_CURRENT_RATIO_MIN = 0.95           # rejects shading rows (cr < 0.95)

EXPECTED_CURRENT_PER_W_M2 = 0.009              # ~9A at 1000 W/m² for this system


def classify_row(
    poa_irradiance: float,
    module_temp: float,
    string_voltage_1: float,
    string_voltage_2: float,
    string_current_1: float,
    string_current_2: float,
) -> str:
    """Classify a single Lazzaretti-shaped row using cascade-aligned rules."""
    if poa_irradiance < DAYLIGHT_IRRADIANCE_FLOOR_W_M2:
        return "normal"

    i1, i2 = string_current_1, string_current_2
    v1, v2 = string_voltage_1, string_voltage_2
    i_mean = (i1 + i2) / 2
    v_mean = (max(v1, 0) + max(v2, 0)) / 2
    expected_i = poa_irradiance * EXPECTED_CURRENT_PER_W_M2
    current_ratio = i_mean / expected_i if expected_i > 0 else 1.0

    i_imbalance = abs(i1 - i2) / (i_mean + 1e-6)
    v_imbalance = abs(v1 - v2) / ((max(v1, 0) + max(v2, 0)) / 2 + 1e-6)

    # ── Open circuit: current ratio crashed + extreme voltage imbalance
    if current_ratio < OPEN_CIRCUIT_CURRENT_RATIO_MAX and v_imbalance > OPEN_CIRCUIT_V_IMBALANCE_MIN:
        return "open_circuit"

    # ── Short circuit: large voltage delta, low average voltage, currents OK
    if (
        v_imbalance > SHORT_CIRCUIT_V_IMBALANCE_MIN
        and v_mean < SHORT_CIRCUIT_V_MEAN_MAX
        and current_ratio > SHORT_CIRCUIT_CURRENT_RATIO_MIN
    ):
        return "short_circuit"

    # ── Partial shading: reduced current with elevated MPP voltage (alt-MPP signature)
    if v_mean > PARTIAL_SHADING_V_MEAN_MIN and current_ratio < PARTIAL_SHADING_CURRENT_RATIO_MAX:
        return "partial_shading"

    # ── Degradation: joint i+v imbalance signature + depressed voltage + cr still normal
    if (
        (i_imbalance + v_imbalance) > DEGRADATION_IV_IMBALANCE_SUM_MIN
        and v_mean < DEGRADATION_V_MEAN_MAX
        and current_ratio > DEGRADATION_CURRENT_RATIO_MIN
    ):
        return "degradation"

    return "normal"


def classify_dataframe(signals: pl.DataFrame) -> pl.Series:
    """Vectorized version of ``classify_row`` over an entire DataFrame."""
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

    daylight = irr >= DAYLIGHT_IRRADIANCE_FLOOR_W_M2

    i_mean = (i1 + i2) / 2
    v_mean = (np.maximum(v1, 0) + np.maximum(v2, 0)) / 2
    expected_i = irr * EXPECTED_CURRENT_PER_W_M2
    with np.errstate(divide="ignore", invalid="ignore"):
        current_ratio = np.where(expected_i > 0, i_mean / expected_i, 1.0)
        i_imbalance = np.where(i_mean > 1e-6, np.abs(i1 - i2) / i_mean, 0.0)
        v_imbalance = np.where(v_mean > 1e-6, np.abs(v1 - v2) / v_mean, 0.0)

    # Open circuit
    oc = daylight & (
        (current_ratio < OPEN_CIRCUIT_CURRENT_RATIO_MAX)
        & (v_imbalance > OPEN_CIRCUIT_V_IMBALANCE_MIN)
    )
    preds[oc] = "open_circuit"

    # Short circuit
    sc = daylight & ~oc & (
        (v_imbalance > SHORT_CIRCUIT_V_IMBALANCE_MIN)
        & (v_mean < SHORT_CIRCUIT_V_MEAN_MAX)
        & (current_ratio > SHORT_CIRCUIT_CURRENT_RATIO_MIN)
    )
    preds[sc] = "short_circuit"

    # Partial shading
    ps = daylight & ~oc & ~sc & (
        (v_mean > PARTIAL_SHADING_V_MEAN_MIN)
        & (current_ratio < PARTIAL_SHADING_CURRENT_RATIO_MAX)
    )
    preds[ps] = "partial_shading"

    # Degradation
    deg = daylight & ~oc & ~sc & ~ps & (
        ((i_imbalance + v_imbalance) > DEGRADATION_IV_IMBALANCE_SUM_MIN)
        & (v_mean < DEGRADATION_V_MEAN_MAX)
        & (current_ratio > DEGRADATION_CURRENT_RATIO_MIN)
    )
    preds[deg] = "degradation"

    return pl.Series("predicted_class", preds, dtype=pl.Utf8)
