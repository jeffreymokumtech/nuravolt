#!/usr/bin/env python3
"""Cross-validate the climate-prior literature numbers against PVDAQ rdtools.

Phase N-5. For each PVDAQ site where rdtools has run:
  - Look up the site lat/lon in the metadata JSON
  - Ask climate_prior_forecast for the expected per-day soiling rate
  - Compare to the rdtools-observed rate (derived from IWSR + soiling-interval count)
  - Report per-site delta + fleet bias

If the climate prior matches within ~30% of observed, we're calibrated.
If it deviates wildly, the literature priors need an update.

Usage:
    python scripts/validate_climate_prior_vs_pvdaq.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from datetime import date

from nuravolt.soiling.client_baseline import climate_prior_forecast
from nuravolt.validation.report import write_report


# Per-system lat/lon — pulled from the metadata JSONs we've already inspected
PVDAQ_SITES = {
    2107: {"lat": 38.996306, "lon": -122.134111, "name": "Farm Solar Array (Arbuckle CA)"},
    7334: {"lat": 37.0,       "lon": -120.0,     "name": "Shine On Solar Facility (CA utility 257MW)"},
    9069: {"lat": 33.6762,    "lon": -83.676,    "name": "Simon Solar Farm (Social Circle GA)"},
}


def _observed_rate_pct_per_day(rdtools_report: dict) -> float | None:
    """Read the median per-interval soiling rate from the rdtools report.

    The validator now captures `soiling_rate_distribution_pct_per_day` with
    p50, mean, etc. — those are the actual rdtools per-dry-interval slopes
    (filtered to `valid=True` intervals only). We compare the **median** to
    the climate prior to avoid skew from a few extreme intervals.
    """
    dist = rdtools_report.get("soiling_rate_distribution_pct_per_day") or {}
    return dist.get("p50")


def main() -> int:
    print("=" * 60)
    print(" Climate prior vs PVDAQ rdtools — cross-validation")
    print("=" * 60)

    validation_dir = REPO_ROOT / "backenddata" / "validation" / "soiling"
    site_reports = []

    for system_id, site in PVDAQ_SITES.items():
        rdtools_fp = validation_dir / f"pvdaq_system_{system_id}.json"
        if not rdtools_fp.exists():
            print(f"  ⏸  system {system_id}: no rdtools report yet")
            continue
        rdtools_report = json.loads(rdtools_fp.read_text())
        if "iwsr_p50" not in rdtools_report:
            print(f"  ⏸  system {system_id}: rdtools report missing IWSR (status={rdtools_report.get('status')})")
            continue

        # Climate prior for this site
        fc = climate_prior_forecast(
            latitude=site["lat"], longitude=site["lon"],
            plant_id=f"pvdaq_{system_id}",
            horizon_days=365,
            start=date(2026, 1, 1),
        )
        prior_mean_rate = fc.summary()["mean_daily_rate_pct"]
        observed_rate = _observed_rate_pct_per_day(rdtools_report)

        delta_abs = (observed_rate - prior_mean_rate) if observed_rate else None
        delta_pct = (delta_abs / prior_mean_rate * 100) if (delta_abs is not None and prior_mean_rate) else None

        site_reports.append({
            "system_id": system_id,
            "name": site["name"],
            "lat": site["lat"],
            "lon": site["lon"],
            "zone": fc.zone.value,
            "climate_prior_rate_pct_day": round(float(prior_mean_rate), 4),
            "rdtools_iwsr": rdtools_report["iwsr_p50"],
            "rdtools_n_intervals": rdtools_report.get("n_soiling_intervals_detected"),
            "rdtools_n_days_used": rdtools_report.get("n_days_used"),
            "observed_rate_pct_day_approx": round(float(observed_rate), 5) if observed_rate else None,
            "delta_abs_pct_day": round(float(delta_abs), 5) if delta_abs is not None else None,
            "delta_relative_to_prior_pct": round(float(delta_pct), 1) if delta_pct is not None else None,
            "within_30pct": (abs(delta_pct) <= 30) if delta_pct is not None else None,
        })

    if not site_reports:
        print("\n  No PVDAQ rdtools reports found. Run Phase N-1 first.")
        return 1

    print(f"\n  {'system':>7}  {'zone':>22}  {'prior(%/d)':>11}  {'observed(%/d)':>13}  {'delta%':>8}  match?")
    print("  " + "-" * 78)
    for r in site_reports:
        status = "✓" if r["within_30pct"] else ("✗" if r["within_30pct"] is False else "?")
        prior = r["climate_prior_rate_pct_day"]
        obs = r["observed_rate_pct_day_approx"]
        delta = r["delta_relative_to_prior_pct"]
        print(
            f"  {r['system_id']:>7}  {r['zone'][:22]:>22}  "
            f"{prior:>11.4f}  "
            f"{obs if obs is not None else '—':>13}  "
            f"{delta if delta is not None else '—':>8}  {status}"
        )

    payload = {
        "dataset": "Climate prior vs PVDAQ rdtools cross-validation",
        "n_samples": len(site_reports),
        "n_sites_compared": len(site_reports),
        "n_sites_within_30pct": sum(1 for r in site_reports if r.get("within_30pct")),
        "sites": site_reports,
        "note": (
            "Compares climate_prior_forecast literature numbers against "
            "rdtools-observed rates per PVDAQ site. Observed rate is an "
            "approximation derived from IWSR + interval count (avg loss per "
            "interval / avg days per interval). A match within ±30% means our "
            "climate prior is calibrated for that climate zone."
        ),
    }
    out_path = write_report("soiling", "climate_prior_cross_check", payload)
    print(f"\n  → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
