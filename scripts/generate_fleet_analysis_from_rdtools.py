#!/usr/bin/env python
"""
Generate Fleet Analysis from rdtools SRR Output

Takes rdtools soiling ratio output and generates fleet summary and per-inverter
analysis files for the frontend dashboard.

Usage:
    python scripts/generate_fleet_analysis_from_rdtools.py --plant-id eta
    python scripts/generate_fleet_analysis_from_rdtools.py --plant-id ribera
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import polars as pl

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.plant_config import PlantConfig


def load_soiling_data(plant_id: str, data_dir: Path) -> Optional[pl.DataFrame]:
    """Load soiling ratio SRR data using Polars."""
    srr_file = data_dir / plant_id / 'soiling_ratio_srr.json'

    if not srr_file.exists():
        print(f"Error: SRR data not found at {srr_file}")
        return None

    print(f"Loading soiling data from {srr_file}")

    with open(srr_file) as f:
        data = json.load(f)

    # Extract daily data
    daily_data = data.get('daily_data', [])

    if not daily_data:
        print("Error: No daily data found in SRR file")
        return None

    # Convert to Polars DataFrame
    df = pl.DataFrame(daily_data)
    df = df.with_columns(pl.col('date').str.strptime(pl.Date, format='%Y-%m-%d'))

    return df


def load_digital_twin_data(plant_id: str, data_dir: Path) -> Optional[pl.DataFrame]:
    """Load digital twin predictions using Polars."""
    dt_file = data_dir / plant_id / 'digital_twins_summary.json'

    if not dt_file.exists():
        print(f"Warning: Digital twin data not found at {dt_file}")
        return None

    print(f"Loading digital twin data from {dt_file}")

    with open(dt_file) as f:
        data = json.load(f)

    return data


def generate_fleet_summary(
    df: pl.DataFrame,
    config: PlantConfig,
    dt_data: Optional[Dict] = None
) -> Dict:
    """Generate fleet-level soiling summary."""

    # Calculate fleet statistics
    sr_mean = float(df['soiling_ratio'].mean())
    sr_std = float(df['soiling_ratio'].std())
    sr_min = float(df['soiling_ratio'].min())
    sr_max = float(df['soiling_ratio'].max())

    # Calculate analysis period
    start_date = df['date'].min()
    end_date = df['date'].max()
    total_days = len(df)

    # Calculate losses (simplified - assumes 1 kW/kWp at clean state)
    avg_soiling_loss_fraction = 1.0 - sr_mean

    # Estimate energy impact (very simplified)
    # Assume avg 4 kWh/kWp/day * capacity * days * loss_fraction
    avg_daily_energy_per_kw = 4.0  # kWh/kWp/day
    total_reference_energy_MWh = (
        config.capacity.nominal_mw * 1000 *  # kW
        avg_daily_energy_per_kw *
        total_days / 1000  # Convert to MWh
    )

    total_soiling_loss_MWh = total_reference_energy_MWh * avg_soiling_loss_fraction

    # Get inverter count
    total_inverters = sum(len(group.inverters) for group in config.components.groups)
    inverter_groups = [g.group_id for g in config.components.groups]

    # Build summary
    summary = {
        "plantInfo": {
            "plantName": config.plant_name,
            "capacity_MW": config.capacity.nominal_mw,
            "totalInverters": total_inverters,
            "inverterGroups": inverter_groups,
        },
        "analysisPeriod": {
            "start": str(start_date),
            "end": str(end_date),
            "totalDays": total_days,
        },
        "fleetSoiling": {
            "srMean": round(sr_mean, 4),
            "srStd": round(sr_std, 4),
            "srMin": round(sr_min, 4),
            "srMax": round(sr_max, 4),
        },
        "fleetLosses": {
            "totalSoilingLoss_MWh": round(total_soiling_loss_MWh, 2),
            "totalLoss_MWh": round(total_soiling_loss_MWh, 2),  # Only soiling for now
            "referenceEnergy_MWh": round(total_reference_energy_MWh, 2),
            "netEnergy_MWh": round(total_reference_energy_MWh - total_soiling_loss_MWh, 2),
        },
        # healthDistribution / topPerformers / worstPerformers are per-inverter
        # products this plant-level SRR script cannot honestly derive — they
        # come from generate_per_inverter_soiling.py (measured per-inverter
        # data) and are preserved from the existing file when present.
        "economicImpact": {
            "estimatedAnnualLoss_EUR": round(total_soiling_loss_MWh * 365 / total_days * 120, 2),  # €120/MWh
            "cleaningROIPotential_EUR": round(total_soiling_loss_MWh * 365 / total_days * 120 * 0.7, 2),  # 70% recoverable
        }
    }

    return summary


# NOTE: the old generate_inverter_summaries() fan-out (fleet mean broadcast to
# every inverter, zScore 0.0) is intentionally gone. Per-inverter artifacts
# come only from scripts/generate_per_inverter_soiling.py, which computes them
# from measured per-inverter data and refuses to write a flat fleet.


def main():
    parser = argparse.ArgumentParser(description='Generate fleet analysis from rdtools SRR output')
    parser.add_argument('--plant-id', required=True, help='Plant ID (eta, ribera, alpha1)')
    parser.add_argument('--data-dir', default='public/data', help='Data directory')
    args = parser.parse_args()

    print("=" * 60)
    print(f"FLEET ANALYSIS GENERATION - {args.plant_id.upper()}")
    print("=" * 60)

    # Setup paths
    base_dir = Path(__file__).parent.parent
    data_dir = base_dir / args.data_dir
    soiling_dir = data_dir / 'soiling'
    dt_dir = data_dir / 'digitaltwin'
    config_path = base_dir / 'plant_configs' / f'{args.plant_id}.yaml'

    # Load plant config
    if not config_path.exists():
        print(f"Error: Plant config not found: {config_path}")
        return 1

    config = PlantConfig.from_yaml(config_path)
    print(f"\nPlant: {config.plant_name}")
    print(f"Capacity: {config.capacity.nominal_mw} MW")
    print(f"Inverters: {sum(len(g.inverters) for g in config.components.groups)}")

    # Load soiling data
    df = load_soiling_data(args.plant_id, soiling_dir)
    if df is None:
        return 1

    print(f"Loaded {len(df)} days of soiling ratio data")

    # Load digital twin data if available
    dt_data = load_digital_twin_data(args.plant_id, dt_dir)

    # Generate fleet summary
    print("\nGenerating fleet summary...")
    fleet_summary = generate_fleet_summary(df, config, dt_data)

    # Save outputs
    output_dir = soiling_dir / args.plant_id
    output_dir.mkdir(parents=True, exist_ok=True)

    # Preserve the per-inverter fields when a measured-per-inverter artifact
    # already owns them (generate_per_inverter_soiling.py); this script only
    # refreshes the plant-level SRR blocks.
    fleet_file = output_dir / 'fleet_summary.json'
    if fleet_file.exists():
        with open(fleet_file) as f:
            existing = json.load(f)
        for key in ('healthDistribution', 'topPerformers', 'worstPerformers', 'provenance'):
            if key in existing:
                fleet_summary[key] = existing[key]

    with open(fleet_file, 'w') as f:
        json.dump(fleet_summary, f, indent=2)
    print(f"\nSaved: {fleet_file}")
    print("Per-inverter artifacts: run scripts/generate_per_inverter_soiling.py "
          "(measured data only; this script no longer fans out fleet means).")

    # Print summary
    print("\n" + "=" * 60)
    print("FLEET SUMMARY")
    print("=" * 60)
    print(f"Mean SR: {fleet_summary['fleetSoiling']['srMean']:.3f}")
    print(f"SR Range: {fleet_summary['fleetSoiling']['srMin']:.3f} - {fleet_summary['fleetSoiling']['srMax']:.3f}")
    print(f"Total Soiling Loss: {fleet_summary['fleetLosses']['totalSoilingLoss_MWh']:.1f} MWh")
    print(f"Estimated Annual Loss: €{fleet_summary['economicImpact']['estimatedAnnualLoss_EUR']:,.0f}")
    print("=" * 60)

    return 0


if __name__ == '__main__':
    sys.exit(main())
