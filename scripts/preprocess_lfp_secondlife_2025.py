#!/usr/bin/env python3
"""Preprocess the 2025 LFP-second-life summary file into a parquet.

Phase N-6. The Recherche Data Gouv dataset (DOI 10.57745/OLBXKT,
20 18650 Graphite/LFP cells cycled in first + second life) ships:
  - 20 per-cell ZIPs (1.2-1.5 GB each, 24 GB total) — raw cycling data
  - `extractedData.mat` (459 KB) — pre-extracted summary

This script processes `extractedData.mat` only — gives us per-cell SoH-
over-cycle trajectories + EOL cycle. Not enough for delta-Q featurization
(no per-timestep voltage curves), but a useful second-LFP-dataset reference
point that we can validate our bess_lfp_v1 against indirectly.

For full delta-Q upgrade, we'd need to download the per-cell zips and
extract raw V/I/T per cycle. Documented but not done here.

Usage:
    python scripts/preprocess_lfp_secondlife_2025.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = REPO_ROOT / "backenddata" / "datasets" / "lfp_secondlife_2025"
MAT_FILE = DATA_ROOT / "extractedData.mat"
OUT_PARQUET = DATA_ROOT / "cells_summary.parquet"

# 80% of 1.1 Ah rated → EOL threshold for A123-style LFP
EOL_THRESHOLD_AH = 0.88
NOMINAL_AH = 1.1


def main() -> int:
    if not MAT_FILE.exists():
        print(f"Missing {MAT_FILE}")
        print(f"  Fetch via:")
        print(f"  curl -L -o {MAT_FILE} 'https://entrepot.recherche.data.gouv.fr/api/access/datafile/606807'")
        return 1

    from scipy.io import loadmat
    import polars as pl

    print(f"Loading {MAT_FILE}...")
    m = loadmat(str(MAT_FILE), simplify_cells=True)
    cells = m["cell"]
    print(f"  {len(cells)} cells found")

    rows = []
    for c in cells:
        name = c.get("name", "?")
        charac_list = c.get("charac", [])
        # charac entries: {cycle, chargecapacity, soh}
        cycles = []
        capacities = []
        sohs = []
        for entry in charac_list:
            if not isinstance(entry, dict):
                continue
            cyc = entry.get("cycle")
            cap = entry.get("chargecapacity")
            soh = entry.get("soh")
            def _safe_scalar(x):
                if x is None:
                    return None
                if hasattr(x, "__len__"):
                    try:
                        if len(x) == 0:
                            return None
                        return float(x.item() if hasattr(x, "item") and x.size == 1 else x.ravel()[0])
                    except Exception:
                        return None
                try:
                    return float(x)
                except (TypeError, ValueError):
                    return None
            cyc_val = _safe_scalar(cyc)
            cap_val = _safe_scalar(cap)
            if cyc_val is None or cap_val is None:
                continue
            cycles.append(int(cyc_val))
            capacities.append(cap_val)
            soh_val = _safe_scalar(soh)
            sohs.append(soh_val if soh_val is not None else 0.0)

        if not cycles:
            print(f"  ⚠ {name}: no charac entries, skipping")
            continue

        # EOL: first checkpoint where chargecapacity drops below threshold
        eol_idx = next((i for i, c in enumerate(capacities) if c < EOL_THRESHOLD_AH), None)
        eol_cycle = cycles[eol_idx] if eol_idx is not None else cycles[-1]
        reached_eol = eol_idx is not None

        rows.append({
            "cell_id": name,
            "n_checkpoints": len(cycles),
            "initial_capacity_ah": capacities[0],
            "final_capacity_ah": capacities[-1],
            "max_cycle_observed": max(cycles),
            "eol_cycle": eol_cycle,
            "reached_eol": reached_eol,
            "fade_over_observed_cycles_pct": round((1 - capacities[-1] / capacities[0]) * 100, 2),
            "checkpoint_cycles": cycles,
            "checkpoint_capacities_ah": capacities,
            "checkpoint_soh_pct": sohs,
        })
        eol_str = f"EOL {eol_cycle}" if reached_eol else f"still {capacities[-1]:.3f}Ah at cycle {cycles[-1]} (no EOL)"
        print(f"  ✓ {name}: {len(cycles)} checkpoints, init {capacities[0]:.3f}Ah, {eol_str}")

    df = pl.DataFrame(rows)
    df.write_parquet(OUT_PARQUET)
    print(f"\nWrote {len(df)} cells to {OUT_PARQUET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
