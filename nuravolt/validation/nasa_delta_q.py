"""NASA PCoE delta-Q featurization (mirrors severson_delta_q.py).

Phase N-4. NASA .mat files contain per-timestep Voltage / Current / Time
during each discharge cycle. We can compute Q(V) curves (cumulative
discharged capacity vs voltage) at any cycle and the delta between two
cycles as Severson 2019 prescribed.

For NMC cells the meaningful voltage range is 2.5-4.2V (vs LFP's 2.0-3.5V).

This module:
  - Extracts per-timestep (V, I, T) from a NASA cell's .mat file
  - For each discharge cycle, computes cumulative Q(t) from current integration
  - Interpolates Q at a fixed voltage grid
  - Computes ΔQ between cycles 10 and 100 (configurable)
  - Returns the same feature shape as severson_delta_q so the LGBM trainer
    in scripts/train_bess_lfp_foundation.py can be re-used trivially
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import numpy as np

# NMC discharge voltage range (different from LFP). Standard for 18650 NMC.
NMC_VOLTAGE_GRID = np.linspace(2.7, 4.1, 1000)


@dataclass
class NasaDeltaQFeatures:
    cell_id: str
    log_var_delta_q: float
    log_mean_abs_delta_q: float
    log_min_delta_q: float
    delta_q_skew: float
    n_valid_points: int


def _discharge_cycles(mat_data: dict) -> List[dict]:
    """Return list of discharge cycle data dicts in order."""
    top = next((k for k in mat_data if not k.startswith("__")), None)
    if top is None:
        return []
    cycles = mat_data[top]["cycle"]
    return [c for c in cycles if c.get("type") == "discharge"]


def _q_at_voltage_grid_nasa(cycle: dict, voltage_grid: np.ndarray = NMC_VOLTAGE_GRID) -> Optional[np.ndarray]:
    """For one NASA discharge cycle, return cumulative discharged capacity at
    each voltage in the grid. Returns None if data is unusable.

    Q(t) computed by integrating |I(t)| over time. We then sort by descending
    voltage (start of discharge = high V) and interpolate Q at the grid.
    """
    data = cycle.get("data", {})
    if not all(k in data for k in ("Voltage_measured", "Current_measured", "Time")):
        return None
    v = np.array(data["Voltage_measured"], dtype=float)
    i = np.array(data["Current_measured"], dtype=float)
    t = np.array(data["Time"], dtype=float)
    if len(v) < 30:
        return None

    # Cumulative discharged capacity in Ah (current is negative during discharge)
    # Q(t_n) = integral(|I| dt) from 0 to t_n.  Using trapezoidal sum, in As → /3600 = Ah
    dt = np.diff(t, prepend=t[0])
    dq_per_step = np.abs(i) * dt / 3600.0
    q_cumulative = np.cumsum(dq_per_step)

    # Discharge starts at high voltage, ends at low. Sort by voltage ASCENDING
    # for np.interp (which needs monotonic xs).
    idx = np.argsort(v)
    v_sorted = v[idx]
    q_sorted = q_cumulative[idx]
    # Deduplicate near-identical voltages
    keep = np.concatenate(([True], np.diff(v_sorted) > 1e-4))
    v_sorted = v_sorted[keep]
    q_sorted = q_sorted[keep]
    if len(v_sorted) < 30:
        return None
    return np.interp(voltage_grid, v_sorted, q_sorted, left=np.nan, right=np.nan)


def extract_features_for_cell(
    mat_path: Path,
    early_cycle: int = 10,
    late_cycle: int = 100,
) -> Optional[NasaDeltaQFeatures]:
    """Extract delta-Q features for one NASA cell."""
    from scipy.io import loadmat
    mat = loadmat(str(mat_path), simplify_cells=True)
    disch = _discharge_cycles(mat)
    if len(disch) <= late_cycle:
        # Not enough discharge cycles to compute delta-Q at requested indices
        return None

    q_early = _q_at_voltage_grid_nasa(disch[early_cycle])
    q_late = _q_at_voltage_grid_nasa(disch[late_cycle])
    if q_early is None or q_late is None:
        return None

    delta_q = q_late - q_early
    valid = ~np.isnan(delta_q)
    if valid.sum() < 100:
        return None
    dq = delta_q[valid]

    var_dq = max(float(np.var(dq)), 1e-12)
    mean_abs = max(float(np.mean(np.abs(dq))), 1e-12)
    min_dq = max(float(abs(np.min(dq))), 1e-12)
    mean_dq = float(np.mean(dq))
    std_dq = max(float(np.std(dq)), 1e-12)
    skew = float(np.mean(((dq - mean_dq) / std_dq) ** 3))

    return NasaDeltaQFeatures(
        cell_id=mat_path.stem,
        log_var_delta_q=float(np.log10(var_dq)),
        log_mean_abs_delta_q=float(np.log10(mean_abs)),
        log_min_delta_q=float(np.log10(min_dq)),
        delta_q_skew=skew,
        n_valid_points=int(valid.sum()),
    )


def extract_features_all(nasa_root: Path) -> List[NasaDeltaQFeatures]:
    """Walk every B*.mat under nasa_root, extract delta-Q features."""
    out = []
    for mp in sorted(nasa_root.rglob("B*.mat")):
        feats = extract_features_for_cell(mp)
        if feats is not None:
            out.append(feats)
    return out
