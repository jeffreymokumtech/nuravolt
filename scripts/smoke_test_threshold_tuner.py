#!/usr/bin/env python3
"""Smoke test for the LLM threshold tuner.

Runs the tuner on 3 representative plants spanning climate/equipment
diversity and prints the LLM-suggested overrides + rationale.

Requires AWS Bedrock credentials in .env.

Usage:
    python scripts/smoke_test_threshold_tuner.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    import os
    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def main() -> int:
    _load_dotenv(REPO_ROOT / ".env")
    from nuravolt.llm.threshold_tuner import PlantMetadataInput, tune_thresholds

    test_plants = [
        PlantMetadataInput(
            plant_id="mediterranean_huawei",
            asset_type="PV",
            capacity_mw=10.0,
            latitude=38, longitude=-1,
            country="Spain",
            climate_zone="MEDITERRANEAN",
            inverter_manufacturer="Huawei",
            inverter_model="SUN2000-105KTL",
            module_manufacturer="JA Solar",
            mounting_type="fixed-ground",
            n_strings=2400, n_inverters=20,
            commissioning_year=2022,
        ),
        PlantMetadataInput(
            plant_id="mena_sungrow_rooftop",
            asset_type="PV",
            capacity_mw=2.5,
            latitude=24.5, longitude=54.5,
            country="UAE",
            climate_zone="DESERT_MENA",
            inverter_manufacturer="Sungrow",
            inverter_model="SG110CX",
            mounting_type="rooftop",
            n_strings=600, n_inverters=8,
            commissioning_year=2021,
            additional_context="High dust loading, ~1% daily soiling. No automated cleaning.",
        ),
        PlantMetadataInput(
            plant_id="german_sma_tracker",
            asset_type="PV",
            capacity_mw=50.0,
            latitude=51.5, longitude=13,
            country="Germany",
            climate_zone="TEMPERATE_CONTINENTAL",
            inverter_manufacturer="SMA",
            inverter_model="Sunny Highpower PEAK3",
            module_manufacturer="LONGi",
            mounting_type="single-axis tracker",
            n_strings=12000, n_inverters=40,
            commissioning_year=2023,
        ),
    ]

    print("=" * 70)
    print(" LLM threshold tuner — smoke test")
    print("=" * 70)
    for meta in test_plants:
        print(f"\n── {meta.plant_id} ──")
        print(f"  {meta.country}, {meta.capacity_mw} MW, {meta.inverter_manufacturer} {meta.inverter_model}")
        result = tune_thresholds(meta, use_cache=False)
        print(f"  Bedrock invocations: {result.invocations}  cache_hit: {result.cache_hit}")
        print(f"  Overrides suggested: {len(result.overrides)}  rejected (out-of-bounds): {result.rejected_count}")
        for o in result.overrides:
            delta_pct = ((o.value - o.default) / o.default * 100) if o.default else 0
            print(
                f"  • {o.section}.{o.field}: {o.default} → {o.value} {o.unit} "
                f"({delta_pct:+.1f}%, conf {o.confidence:.2f})"
            )
            print(f"      reason: {o.rationale}")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
