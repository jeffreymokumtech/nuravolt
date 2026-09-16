"""Adapter: PVDAQ soiling signal validation.

Validates our soiling SR model against the NREL Soiling Map dataset
(monthly IWSR — Insolation-Weighted Soiling Ratio — per US site).

Source: ``backenddata/datasets/nrel_soiling_map/`` (already on disk).
This isn't per-day ground-truth — it's monthly aggregate per location —
so the metric we report is "annual SR loss bias" rather than "daily RMSE".

For full daily-resolution validation we'd need:
  - PVDAQ system raw data + rdtools soiling_srr (run is non-trivial)
  - DustIQ sensor ground truth (proprietary on most sites)

This adapter does what's possible with what's on disk.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

import polars as pl


NREL_SOILING_CSV = Path("backenddata/datasets/nrel_soiling_map/nrel_soiling_monthly.csv")


@dataclass
class NrelSoilingSite:
    site_id: str
    latitude: float
    longitude: float
    months: List[int]                    # 1-12
    daily_soiling_rates: List[float]     # negative = soiling, positive = cleaning recovery


def load_nrel_soiling_sites() -> List[NrelSoilingSite]:
    """Return NREL soiling sites with their per-month observed daily rates.

    The CSV columns are: site_id, latitude, longitude, month, soiling_rate_per_day,
    soiling_rate_lower_95, soiling_rate_upper_95, n_intervals. A "month" of 13
    sometimes appears as the all-year aggregate — those rows are kept too.

    Raises ``FileNotFoundError`` with fetch instructions if absent.
    """
    if not NREL_SOILING_CSV.exists():
        raise FileNotFoundError(
            f"NREL Soiling Map CSV not found at {NREL_SOILING_CSV}.\n"
            f"  Run: python scripts/fetch_nrel_soiling_map.py"
        )
    df = pl.read_csv(NREL_SOILING_CSV)
    sites = []
    for site_val in df["site_id"].unique():
        sub = df.filter(pl.col("site_id") == site_val).sort("month")
        sites.append(NrelSoilingSite(
            site_id=str(site_val),
            latitude=float(sub["latitude"][0]),
            longitude=float(sub["longitude"][0]),
            months=[int(m) for m in sub["month"].to_list()],
            daily_soiling_rates=[float(v) for v in sub["soiling_rate_per_day"].to_list() if v is not None],
        ))
    return sites
