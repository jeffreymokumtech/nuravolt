#!/usr/bin/env python
"""
Train Inverter Thermal RUL Model from Alpha (Spain) Data

Uses:
- Per-inverter temperature: INV XX.XXX / Temperature (°C)
- Ambient temperature: Meteo.z.bloxx / Ambient (°C)
- Inverter power: INV XX.XXX / P_AC (kW)
"""

import sys
from pathlib import Path
from datetime import datetime
import numpy as np
import polars as pl
from sklearn.model_selection import train_test_split

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.fault.rul_models import (
    RULInverterThermalModel,
    INVERTER_THERMAL_CONFIG,
)
from nuravolt.fault.rul_evaluation import MultiHorizonEvaluator, check_success_criteria


def load_alpha_thermal_data(filepath: str, sample_inverters: int = 20) -> pl.DataFrame:
    """
    Load Alpha data and extract thermal features.

    Args:
        filepath: Path to parquet file
        sample_inverters: Number of inverters to sample (for speed)

    Returns:
        DataFrame with standardized columns
    """
    print(f"Loading Alpha data from {filepath}...")
    df = pl.read_parquet(filepath)
    print(f"  Shape: {df.shape}")

    # Find all inverter IDs
    inv_temp_cols = [c for c in df.columns if '/ Temperature' in c and 'INV' in c]
    print(f"  Found {len(inv_temp_cols)} inverters with temperature data")

    # Sample inverters for faster training
    if sample_inverters and len(inv_temp_cols) > sample_inverters:
        inv_temp_cols = inv_temp_cols[:sample_inverters]
        print(f"  Sampling {sample_inverters} inverters")

    # Get ambient temperature column
    amb_col = [c for c in df.columns if 'Ambient' in c and '°C' in c][0]
    print(f"  Ambient temp column: {amb_col}")

    # Process each inverter and stack data
    all_data = []

    for inv_temp_col in inv_temp_cols:
        # Extract inverter ID (e.g., "01.001" from "Alpha (ES): INV 01.001 / Temperature")
        inv_id = inv_temp_col.split('INV ')[1].split(' /')[0]

        # Find corresponding power column
        power_col = f"Alpha (ES): INV {inv_id} / P_AC (kW)"
        if power_col not in df.columns:
            continue

        # Extract data for this inverter
        inv_df = df.select([
            pl.col("timestamp"),
            pl.col(amb_col).alias("ambient_temp"),
            pl.col(inv_temp_col).alias("inverter_temp"),
            pl.col(power_col).alias("ac_power_kw"),
        ]).with_columns([
            pl.lit(inv_id).alias("inverter_id"),
        ])

        all_data.append(inv_df)

    # Concatenate all inverter data
    df_all = pl.concat(all_data)
    print(f"  Combined shape: {df_all.shape}")

    return df_all


def compute_thermal_features(df: pl.DataFrame, rated_power_kw: float = 333.0) -> pl.DataFrame:
    """
    Compute thermal features for inverter thermal model.

    Features:
    - temp_rise: inverter_temp - ambient_temp
    - temp_rise_trend_7d: 7-day trend
    - ac_power_pu: normalized power
    """
    print("Computing thermal features...")

    # Filter for valid data
    print(f"  Raw rows: {len(df):,}")
    df = df.filter(
        pl.col("ambient_temp").is_not_null() &
        pl.col("inverter_temp").is_not_null() &
        pl.col("ac_power_kw").is_not_null()
    )
    print(f"  After null filter: {len(df):,}")

    # Filter for reasonable temperature range
    df = df.filter(
        (pl.col("inverter_temp") > 0) &
        (pl.col("inverter_temp") < 100) &
        (pl.col("ambient_temp") > -20) &
        (pl.col("ambient_temp") < 50)
    )
    print(f"  After temp range filter: {len(df):,}")

    # Filter for daytime (power > 0)
    df = df.filter(pl.col("ac_power_kw") > 1)
    print(f"  After daytime filter: {len(df):,}")

    # Compute temp_rise (key feature)
    df = df.with_columns([
        (pl.col("inverter_temp") - pl.col("ambient_temp")).alias("temp_rise"),
        (pl.col("ac_power_kw") / rated_power_kw).clip(0, 1.5).alias("ac_power_pu"),
    ])

    # Sort by inverter and timestamp for rolling calcs
    df = df.sort(["inverter_id", "timestamp"])

    # Rolling features per inverter (7 days = 7*24*4 = 672 points at 15-min intervals)
    window_size = 672
    min_samples = 50

    df = df.with_columns([
        pl.col("temp_rise")
            .rolling_mean(window_size=window_size, min_periods=min_samples)
            .over("inverter_id")
            .alias("temp_rise_mean_7d"),

        pl.col("temp_rise")
            .rolling_max(window_size=window_size, min_periods=min_samples)
            .over("inverter_id")
            .alias("temp_rise_max_7d"),

        pl.col("temp_rise")
            .rolling_quantile(quantile=0.95, window_size=window_size, min_periods=min_samples)
            .over("inverter_id")
            .alias("temp_rise_95th_7d"),
    ])

    # Fill nulls
    df = df.with_columns([
        pl.col("temp_rise_mean_7d").forward_fill().backward_fill().over("inverter_id"),
        pl.col("temp_rise_max_7d").forward_fill().backward_fill().over("inverter_id"),
        pl.col("temp_rise_95th_7d").forward_fill().backward_fill().over("inverter_id"),
    ])

    # Trend (simplified: current - 7d mean)
    df = df.with_columns([
        ((pl.col("temp_rise") - pl.col("temp_rise_mean_7d")) / 7).fill_null(0).alias("temp_rise_trend_7d"),
    ])

    return df


def generate_thermal_rul_labels(
    df: pl.DataFrame,
    threshold: float = 65.0,  # Inverter temp threshold
    max_horizon: int = 10,
) -> pl.DataFrame:
    """
    Generate synthetic RUL labels for inverter thermal.

    Logic: Days until inverter_temp > threshold sustained.
    """
    # Calculate how close we are to threshold
    df = df.with_columns([
        pl.when(pl.col("inverter_temp") >= threshold)
            .then(0.0)
        .when(pl.col("inverter_temp") >= threshold - 5)
            .then(((threshold - pl.col("inverter_temp")) / 5 * 2).clip(0, max_horizon))
        .when(pl.col("inverter_temp") >= threshold - 10)
            .then(((threshold - pl.col("inverter_temp")) / 10 * 5).clip(0, max_horizon))
        .when(pl.col("inverter_temp") >= threshold - 20)
            .then(((threshold - pl.col("inverter_temp")) / 20 * 8).clip(0, max_horizon))
        .otherwise(max_horizon)
        .alias("days_to_fault")
    ])

    return df


def train_inverter_thermal_model(df: pl.DataFrame, output_dir: str) -> dict:
    """Train inverter thermal RUL model."""
    print("\n" + "=" * 60)
    print("TRAINING INVERTER THERMAL MODEL")
    print("=" * 60)

    # Features for thermal model
    feature_cols = [
        "temp_rise",
        "temp_rise_trend_7d",
        "temp_rise_max_7d",
        "temp_rise_95th_7d",
        "ac_power_pu",
        "ambient_temp",
        "inverter_temp",
    ]

    # Filter for available columns
    available_cols = [c for c in feature_cols if c in df.columns]
    print(f"Using features: {available_cols}")

    # Prepare training data
    df_train = df.select(available_cols + ["days_to_fault"])

    # Check null counts
    for col in available_cols + ["days_to_fault"]:
        null_count = df_train[col].null_count()
        if null_count > 0:
            print(f"  {col}: {null_count:,} nulls ({100*null_count/len(df_train):.1f}%)")

    # Fill nulls with median
    df_train = df_train.with_columns([
        pl.col(c).fill_null(pl.col(c).median()) for c in available_cols
    ])

    # Drop remaining nulls
    df_train = df_train.drop_nulls()
    print(f"Training samples: {len(df_train):,}")

    if len(df_train) < 1000:
        raise ValueError(f"Not enough training samples: {len(df_train)}")

    # Extract arrays
    X = df_train.select(available_cols).to_numpy()
    y = df_train["days_to_fault"].to_numpy()

    # Split
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_train, y_train, test_size=0.1, random_state=42
    )

    print(f"Train: {len(X_train):,}, Val: {len(X_val):,}, Test: {len(X_test):,}")

    # Create and train model
    model = RULInverterThermalModel()
    model.config.additional_features = [c for c in available_cols if c not in [
        model.config.primary_feature, model.config.trend_feature
    ]]

    metrics = model.train(X_train, y_train, X_val, y_val)

    # Evaluate with multi-horizon
    y_pred = model.predict(X_test)
    evaluator = MultiHorizonEvaluator()
    result = evaluator.evaluate(y_test, y_pred)

    print(evaluator.generate_report(result, "Inverter Thermal"))

    # Check success criteria
    meets, details = check_success_criteria("inverter_thermal", result)
    print(f"Meets criteria: {meets}")

    # Save model
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    model_path = output_path / "rul_inverter_thermal.pkl"
    model.save(model_path)
    print(f"Saved to: {model_path}")

    return {
        "mae": result.mae,
        "within_1d": result.within(1),
        "within_3d": result.within(3),
        "within_7d": result.within(7),
        "meets_criteria": meets,
    }


def main():
    data_file = "<repo>/demo_spain/emsdt_650addffb0721062b19a6636_15_00461_Inverter_Inverter Power Normalized_training.parquet"
    output_dir = "<repo>/models/rul"

    print("=" * 60)
    print("ALPHA INVERTER THERMAL MODEL TRAINING")
    print("=" * 60)

    # Load data (sample 30 inverters for speed)
    print("\n[1/4] Loading Alpha data...")
    df = load_alpha_thermal_data(data_file, sample_inverters=30)

    # Compute features
    print("\n[2/4] Computing thermal features...")
    df = compute_thermal_features(df)

    # Generate labels
    print("\n[3/4] Generating RUL labels...")
    df = generate_thermal_rul_labels(df)

    print(f"\nFinal dataset: {df.shape}")

    # Check label distribution
    print("\nLabel distribution:")
    print(f"  Min: {df['days_to_fault'].min():.1f} days")
    print(f"  Max: {df['days_to_fault'].max():.1f} days")
    print(f"  Mean: {df['days_to_fault'].mean():.1f} days")
    print(f"  Urgent (< 3d): {(df['days_to_fault'] < 3).sum():,} samples")

    # Train model
    print("\n[4/4] Training inverter thermal model...")
    results = train_inverter_thermal_model(df, output_dir)

    # Summary
    print("\n" + "=" * 80)
    print("TRAINING COMPLETE")
    print("=" * 80)
    print(f"\n{'Model':<25} {'MAE':>7} {'W/1d':>7} {'W/3d':>7} {'W/7d':>7} {'Pass':>6}")
    print("-" * 80)
    print(f"{'Inverter Thermal':<25} {results['mae']:>6.2f}d {results['within_1d']:>6.1f}% "
          f"{results['within_3d']:>6.1f}% {results['within_7d']:>6.1f}% "
          f"{'YES' if results['meets_criteria'] else 'NO':>6}")
    print("=" * 80)


if __name__ == "__main__":
    main()
