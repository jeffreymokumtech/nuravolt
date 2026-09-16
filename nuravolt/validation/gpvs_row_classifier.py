"""Row-level classifier for GPVS-Faults (cross-dataset PV validation).

This is a SEPARATE classifier from ``pv_row_classifier.py`` because GPVS
has a different feature shape than Lazzaretti (system-level 3-phase AC
+ DC bus, not per-string current/voltage). Both classifiers share the
same spirit — physics-grounded threshold rules — but the discriminators
differ because the observables differ.

Mirrors our production cascade discriminators for the GPVS-observable fault classes:

    F0 normal                       → fall-through
    F1 string_short_circuit         → low Vpv / Vdc ratio (PV array voltage collapsed)
    F2 string_open_circuit          → low Ipv with normal Vpv (current path broken)
    F3 inverter_overtemperature     → harder — we don't have temperature, skip honestly
    F4 dc_link_capacitor_aging      → erratic dc_ratio (Vpv/Vdc oscillates)
    F5 grid_voltage_sag             → low ac_voltage_magnitude with normal frequency
    F6 grid_voltage_swell           → high ac_voltage_magnitude with normal frequency
    F7 irradiance_sensor_drift      → can't detect electrically — skip

Thresholds calibrated from per-class percentile analysis of the GPVS
data itself (see scripts/validate_gpvs.py for the calibration).

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


# Discriminator thresholds — calibrated empirically from GPVS per-class percentile analysis.
# IMPORTANT: GPVS samples at 100 kHz over a few-second experiment with the fault active
# for only a fraction of that window. Most rows in any fault file look identical to
# normal rows. Only F4 (DC capacitor aging — sustained Vpv depression) and F5 (grid sag —
# total system collapse) are detectable per-row. F1/F2/F3/F6/F7 need time-window features
# or sequence classification (out of scope for this row-level surrogate).

# F4 DC link capacitor aging: Vpv sits ~85V (vs ~99V normal), dc_ratio < 0.62
DC_CAP_AGING_VPV_MAX = 88.0
DC_CAP_AGING_DC_RATIO_MAX = 0.62

# F5 Grid voltage sag: Vdc drops below 130V (normal is 143-148V), Ipv collapses
GRID_SAG_VDC_MAX = 130.0
GRID_SAG_IPV_MAX = 0.5


def classify_dataframe(signals: pl.DataFrame) -> pl.Series:
    """Apply cascade-style rules to GPVS rows. Returns predicted fault_type.

    Calibrated against GPVS per-class percentile statistics. Honest scope:
    only catches F4 (DC capacitor aging) and F5 (grid sag) — the other classes
    are temporally-localized events that look indistinguishable at single-row
    resolution.
    """
    required = {"Ipv", "Vpv", "Vdc", "dc_ratio"}
    missing = required - set(signals.columns)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    n = len(signals)
    preds = np.full(n, "normal", dtype=object)

    ipv = signals["Ipv"].to_numpy()
    vpv = signals["Vpv"].to_numpy()
    vdc = signals["Vdc"].to_numpy()
    dc_ratio = signals["dc_ratio"].to_numpy()

    # ── F5 Grid voltage sag (catch first — most severe collapse)
    sag = (np.abs(vdc) < GRID_SAG_VDC_MAX) & (np.abs(ipv) < GRID_SAG_IPV_MAX)
    preds[sag] = "grid_voltage_sag"

    # ── F4 DC link capacitor aging (sustained Vpv depression)
    cap_aging = ~sag & (np.abs(vpv) < DC_CAP_AGING_VPV_MAX) & (dc_ratio < DC_CAP_AGING_DC_RATIO_MAX)
    preds[cap_aging] = "dc_link_capacitor_aging"

    return pl.Series("predicted_fault_type", preds, dtype=pl.Utf8)
