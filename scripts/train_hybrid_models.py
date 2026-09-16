#!/usr/bin/env python3
"""
Train HybridModel (Physics-ML) for all plants.

The HybridModel combines:
1. Physics baseline (PVWatts) - generalizes across plants
2. ML residual learner (CatBoost) - site-specific adjustments

Output features for soiling prediction:
- P_physics: Physics-only power prediction
- P_hybrid: Physics + ML prediction
- ml_residual: What ML learned about the site
- physics_loss_pct: (P_physics - P_actual) / P_physics
- hybrid_loss_pct: (P_hybrid - P_actual) / P_hybrid

Usage:
    python scripts/train_hybrid_models.py
    python scripts/train_hybrid_models.py --plant-id gamma
"""

import argparse
import json
import pickle
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.hybrid_model import (
    HybridPhysicsMLModel as HybridModel,
    HybridModelConfig,
)
from nuravolt.digitaltwin.physics_model import create_physics_model
from nuravolt.digitaltwin.feature_engineering import create_physics_engineer


# Plant configurations
PLANTS = {
    "epsilon": {
        "scada_path": "backenddata/scada/epsilon",
        "output_path": "public/data/digitaltwin/epsilon",
        "lat": 51,
        "lon": 14.5,
        "altitude": 150,
        "power_col": "Epsilon: Plant / Power by Inverter (kW)",
        "power_units": "kW",
        "capacity_kwp": None,   # derive once from data, then freeze here
        "irr_col": "Epsilon: Plant / Irradiation_average (W/m²)",
        "temp_col": "Epsilon: Temperatur Sensor 1 / Ambient (°C)",
    },
    "ribera": {
        "scada_path": "backenddata/scada/ribera",
        "output_path": "public/data/digitaltwin/ribera",
        "lat": 38,
        "lon": -1,
        "altitude": 50,
        "power_col": "Ribera (ES): Plant / Power by Inverter (kW)",
        "power_units": "kW",
        "capacity_kwp": None,   # derive once from data, then freeze here
        "irr_col": "Ribera (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Ribera (ES): Meteo.z.bloxx / Ambient (°C)",
    },
    "eta": {
        "scada_path": "backenddata/scada/eta",
        "output_path": "public/data/digitaltwin/eta",
        "lat": 38.5,
        "lon": -5.5,
        "altitude": 400,
        "power_col": "Eta (ES): Plant / Power by Inverter (kW)",
        "power_units": "kW",
        "capacity_kwp": None,   # derive once from data, then freeze here
        "irr_col": "Eta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Eta (ES): Temperatur MC / Ambient (°C)",
    },
    "delta": {
        "scada_path": "backenddata/scada/delta",
        "output_path": "public/data/digitaltwin/delta",
        "lat": 39.5,
        "lon": 2.5,
        "altitude": 50,
        "power_col": "Delta (ES): Plant / Power by Inverter (kW)",
        "power_units": "kW",
        "capacity_kwp": None,   # derive once from data, then freeze here
        "irr_col": "Delta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Delta (ES): zbloxx 407 / Ambient",
    },
    "zeta": {
        "scada_path": "backenddata/scada/zeta",
        "output_path": "public/data/digitaltwin/zeta",
        "lat": 39.5,
        "lon": 3,
        "altitude": 50,
        "power_col": "Zeta (ES): Plant / Power by Inverter (kW)",
        "power_units": "kW",
        "capacity_kwp": None,   # derive once from data, then freeze here
        "irr_col": "Zeta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Zeta (ES): Meteo.Z.bloxx407 / temperature_internal (°C)",
    },
    "gamma": {
        "scada_path": "backenddata/scada/gamma",
        "output_path": "public/data/digitaltwin/gamma",
        "lat": 39.5,
        "lon": 3,
        "altitude": 25,
        "power_col": "Gamma 1& 2 (ES): Plant / Power by Inverter (kW)",
        "power_units": "kW",
        "capacity_kwp": None,   # derive once from data, then freeze here
        "irr_col": "Gamma 1& 2 (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Gamma 1& 2 (ES): zbloxx 407 / temperature_internal (°C)",
    },
    "alpha": {
        "scada_path": "backenddata/scada/alpha",
        "output_path": "public/data/digitaltwin/alpha",
        "lat": 38,
        "lon": -4,
        "altitude": 500,
        "power_col": "Alpha (ES): Plant / Power by Inverter (kW)",
        "power_units": "kW",
        # Derived from measured data, then frozen: p99.9 of plant power is
        # 9,746 kW and the max is 9,818, so AC nameplate is about 9,900 kW.
        # Median performance ratio at irradiance above 700 W/m2 is 0.905
        # against a 10.5 MWp DC array.
        "capacity_kwac": 9900.0,
        "capacity_kwp": 10500.0,
        "irr_col": "Alpha (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Alpha (ES): Meteo.z.bloxx / Ambient (°C)",
    },
}


def find_column(df_cols: list, patterns: list) -> Optional[str]:
    """Find column matching patterns."""
    for pattern in patterns:
        pattern_lower = pattern.lower()
        for col in df_cols:
            if pattern_lower in col.lower():
                return col
    return None


def resolve_power_column(df_cols: list, config: dict) -> tuple:
    """Resolve the measured-power column and its units from explicit config.

    The previous implementation guessed, and returned on the first column whose
    name contained "normalized". In the Spanish SCADA that is a *single
    inverter's* per-unit kW/kWp column (range 0 to 0.84), never the plant-level
    "Power by Inverter (kW)" (range 0 to 9,818). Training a physics model built
    at nameplate kW against a 0-1 target produced a calibration factor of about
    0.02, which the sanity check in physics_model.calibrate then silently reset
    to 1.0 -- so every twin artifact shipped with physics_r2 near -13,000 and a
    meaningless accuracy number.

    Units are therefore declared per plant, not inferred.

    Returns:
        (column_name, units) where units is 'kW' or 'per_unit'.
    """
    declared = config.get("power_col")
    units = config.get("power_units", "kW")
    if declared:
        if declared not in df_cols:
            raise KeyError(
                f"configured power_col {declared!r} not present. Available "
                f"power-ish columns: "
                f"{[c for c in df_cols if 'power' in c.lower()][:8]}"
            )
        return declared, units

    # No explicit config: prefer plant-level kW and refuse to fall back to a
    # per-unit column, which is the exact mistake this function exists to stop.
    plant_level = [
        c for c in df_cols
        if "power" in c.lower() and "plant" in c.lower() and "normalized" not in c.lower()
    ]
    if plant_level:
        return plant_level[0], "kW"
    raise KeyError(
        "No plant-level power column found and no power_col configured. Declare "
        "power_col and power_units explicitly rather than letting this guess -- "
        "a per-unit column scored against a nameplate-kW physics model is a "
        "silent, total loss of accuracy."
    )


def load_scada_data(plant_id: str, config: dict) -> Optional[pd.DataFrame]:
    """Load and prepare SCADA data for training."""
    scada_path = Path(config["scada_path"])
    parquet_files = list(scada_path.glob("*.parquet"))

    if not parquet_files:
        print(f"  No parquet files in {scada_path}")
        return None

    # Load data
    df = pl.read_parquet(parquet_files[0])

    # Find columns
    irr_col = find_column(df.columns, [config["irr_col"], "irradiation"])
    temp_col = find_column(df.columns, [config["temp_col"], "ambient", "temperature"])
    power_col, power_units = resolve_power_column(list(df.columns), config)

    if not irr_col or not temp_col:
        print(f"  Missing irradiance or temperature column")
        return None

    print(f"  Columns: irr={irr_col[:30]}, temp={temp_col[:30]}, "
          f"power={power_col[:40]} [{power_units}]")

    # Filter valid data
    df_filtered = df.filter(
        pl.col(irr_col).is_not_null() &
        pl.col(temp_col).is_not_null() &
        pl.col(power_col).is_not_null() &
        (pl.col(irr_col) > 50) &  # Minimum irradiance
        (pl.col(power_col) > 0)
    )

    print(f"  Rows: {len(df)} total, {len(df_filtered)} valid")

    if len(df_filtered) < 1000:
        print(f"  Insufficient data for training")
        return None

    # Convert to pandas with standardized column names
    df_pd = df_filtered.select([
        pl.col('timestamp'),
        pl.col(irr_col).alias('irradiance'),
        pl.col(temp_col).alias('temperature'),
        pl.col(power_col).alias('power'),
    ]).to_pandas()

    # Parse timestamp and sort
    df_pd['timestamp'] = pd.to_datetime(df_pd['timestamp'])
    df_pd = df_pd.set_index('timestamp').sort_index()

    # If the plant only exposes per-unit power, convert to kW here so that
    # everything downstream (physics capacity, calibration, reported MAE) is in
    # one consistent unit. Guessing this is what broke the twins before.
    if power_units == "per_unit":
        capacity = config.get("capacity_kwp")
        if not capacity:
            raise ValueError(
                f"power_units='per_unit' requires capacity_kwp in the config for "
                f"{plant_id}; without it the target has no physical scale."
            )
        df_pd['power'] = df_pd['power'] * float(capacity)
    elif power_units != "kW":
        raise ValueError(f"unknown power_units {power_units!r} for {plant_id}")

    return df_pd


def _estimate_capacity_kwp(df) -> float:
    """Derive DC nameplate from measured power, for plants not yet pinned.

    Uses the 99.9th percentile of measured AC power (robust to spikes) and a
    nominal 0.9 performance ratio to back out DC capacity. Print the value and
    freeze it into the PLANTS config rather than re-deriving it every run, so a
    quiet data change cannot silently move every accuracy number.
    """
    p999 = float(df['power'].quantile(0.999))
    return round(p999 / 0.9, -1)


def train_hybrid_model(plant_id: str, config: dict) -> Optional[dict]:
    """Train HybridModel for a single plant."""
    print(f"\n{'='*60}")
    print(f"TRAINING HYBRID MODEL: {plant_id.upper()}")
    print(f"{'='*60}")

    # Load data
    df = load_scada_data(plant_id, config)
    if df is None:
        return None

    # Create physics model and feature engineer
    capacity_kwp = config.get("capacity_kwp") or _estimate_capacity_kwp(df)
    print(f"  Capacity: {capacity_kwp:,.0f} kWp DC "
          f"({'configured' if config.get('capacity_kwp') else 'estimated from data'})")

    physics_model = create_physics_model(
        capacity_kw=capacity_kwp,
        latitude=config["lat"],
        longitude=config["lon"],
        tilt=30.0,
        azimuth=180.0,
    )
    feature_engineer = create_physics_engineer(
        latitude=config["lat"],
        longitude=config["lon"],
        altitude=config["altitude"],
        tilt=30.0,
        azimuth=180.0,
    )

    # Create hybrid model config
    model_config = HybridModelConfig(
        use_catboost=True,
        calibrate_physics=True,
        min_training_samples=1000,
        validation_split=0.2,
    )

    # Create and train hybrid model
    hybrid_model = HybridModel(
        inverter_id=plant_id,
        physics_model=physics_model,
        feature_engineer=feature_engineer,
        config=model_config,
    )

    try:
        metrics = hybrid_model.train(
            df,
            power_col='power',
            irradiance_col='irradiance',
            temperature_col='temperature',
            wind_col=None,  # Optional
        )

        print(f"\n  Training Results:")
        print(f"    Samples: {metrics.training_samples:,} train, {metrics.validation_samples:,} val")
        print(f"    Physics R²: {metrics.physics_r2:.4f}, MAE: {metrics.physics_mae:.2f} kW")
        print(f"    Hybrid R²: {metrics.r2:.4f}, MAE: {metrics.mae:.2f} kW")
        print(f"    Improvement: {metrics.improvement_over_physics:.1f}%")
        print(f"    Calibration factor: {metrics.calibration_factor:.4f}")

        # Save model
        output_dir = Path(config["output_path"])
        output_dir.mkdir(parents=True, exist_ok=True)

        model_path = output_dir / "hybrid_model.pkl"
        with open(model_path, 'wb') as f:
            pickle.dump(hybrid_model, f)

        # Save metrics
        metrics_path = output_dir / "hybrid_model_metrics.json"
        with open(metrics_path, 'w') as f:
            json.dump({
                'plant_id': plant_id,
                'trained_at': datetime.now().isoformat(),
                'metrics': metrics.to_dict(),
            }, f, indent=2)

        print(f"\n  ✓ Model saved to {model_path}")

        return {
            'plant_id': plant_id,
            'status': 'success',
            'metrics': metrics.to_dict(),
            'model_path': str(model_path),
        }

    except Exception as e:
        print(f"\n  ✗ Training failed: {e}")
        import traceback
        traceback.print_exc()
        return {
            'plant_id': plant_id,
            'status': 'error',
            'error': str(e),
        }


def train_all_plants():
    """Train HybridModel for all plants."""
    print(f"\n{'='*60}")
    print(f"TRAINING HYBRID MODELS FOR ALL PLANTS")
    print(f"Started: {datetime.now().isoformat()}")
    print(f"{'='*60}")

    results = []
    for plant_id, config in PLANTS.items():
        result = train_hybrid_model(plant_id, config)
        if result:
            results.append(result)

    # Summary
    print(f"\n{'='*60}")
    print("TRAINING SUMMARY")
    print(f"{'='*60}")

    success = [r for r in results if r['status'] == 'success']
    failed = [r for r in results if r['status'] != 'success']

    print(f"\nSuccessful: {len(success)}/{len(results)}")
    for r in success:
        m = r['metrics']
        print(f"  {r['plant_id']}: R²={m['r2']:.4f}, MAE={m['mae_kW']:.2f} kW")

    if failed:
        print(f"\nFailed: {len(failed)}")
        for r in failed:
            print(f"  {r['plant_id']}: {r.get('error', 'Unknown error')}")


def main():
    parser = argparse.ArgumentParser(description="Train HybridModels for plants")
    parser.add_argument("--plant-id", help="Specific plant (or 'all')")
    args = parser.parse_args()

    if args.plant_id and args.plant_id != "all":
        if args.plant_id not in PLANTS:
            print(f"Unknown plant: {args.plant_id}")
            print(f"Available: {', '.join(PLANTS.keys())}")
            return

        train_hybrid_model(args.plant_id, PLANTS[args.plant_id])
    else:
        train_all_plants()


if __name__ == "__main__":
    main()
