#!/usr/bin/env python3
"""Run every validation script + rebuild summary.json.

One-shot driver for Phase J. Calls in order:
    1. scripts/validate_pv_faults.py
    2. scripts/validate_bess_rul.py
    3. scripts/validate_soiling.py
    4. scripts/validate_twin.py       (digital twin, capacity-normalised error)
    5. scripts/validate_forecast.py   (forecast skill score vs persistence)
    6. nuravolt.validation.report.build_summary()

Each step writes its own JSON report under ``backenddata/validation/``;
this script then aggregates everything into ``summary.json``.

Usage:
    python scripts/validate_all.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _run(script) -> int:
    """``script`` is either a filename string or a list [filename, *args]."""
    if isinstance(script, str):
        cmd = [sys.executable, f"scripts/{script}"]
        label = script
    else:
        cmd = [sys.executable, f"scripts/{script[0]}", *script[1:]]
        label = " ".join(str(s) for s in script)
    print(f"\n{'#' * 60}\n# {label}\n{'#' * 60}")
    result = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=False)
    return result.returncode


def main() -> int:
    failures = []
    for script in (
        "validate_pv_faults.py",
        "validate_pv_physics_blind.py",
        "validate_pv_lgbm.py",
        "validate_gpvs_cross_dataset.py",
        "audit_classifier_provenance.py",
        "validate_scale_transfer.py",
        "validate_sandia_sat.py",
        "validate_pv_degradation.py",
        "validate_rul_cross_dataset.py",
        "validate_bess_rul.py",
        "validate_severson_delta_q.py",
        "validate_severson_lgbm.py",
        "validate_lfp_secondlife_2025.py",
        ["validate_soiling.py", "nrel_map", "universal", "pvdaq", "pvdaq_7334", "pvdaq_9069"],
        "validate_climate_prior_vs_pvdaq.py",
        ["validate_twin.py", "all"],
        ["validate_forecast.py", "all"],
    ):
        rc = _run(script)
        if rc != 0:
            failures.append(script)

    print(f"\n{'#' * 60}\n# Building summary.json\n{'#' * 60}")
    from nuravolt.validation.report import build_summary
    summary = build_summary()
    print(f"\nSummary written to backenddata/validation/summary.json")
    print(f"Tracked mirror: public/data/validation/")
    print(f"\n── Headlines ──")
    for line in summary["headlines"]:
        print(f"  • {line}")
    print(f"\nTotals: {summary['totals']['datasets']} datasets, {summary['totals']['samples']:,} samples")

    if failures:
        print(f"\n⚠  {len(failures)} script(s) returned non-zero: {failures}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
