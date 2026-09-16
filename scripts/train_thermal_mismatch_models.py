#!/usr/bin/env python
"""
Train Thermal Hotspot and Mismatch RUL Models from PVDAQ Data

Uses system 7334 (SOS) data which has:
- Ambient temperature (amb-t-c)
- Module temperature (mod-t-c)
- String-level DC current/voltage (dc-a, dc-v)
- Irradiance (poa, ghi)
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
    RULThermalHotspotModel,
    RULMismatchModel,
    THERMAL_HOTSPOT_CONFIG,
    MISMATCH_CONFIG,
)
from nuravolt.fault.rul_evaluation import MultiHorizonEvaluator, check_success_criteria


def load_pvdaq_system_7334(data_dir: str) -> pl.DataFrame:
    """
    Load and merge PVDAQ system 7334 data.

    Returns DataFrame with:
    - timestamp
    - ambient_temp, module_temp
    - string currents (multiple)
    - irradiance
    """
    data_path = Path(data_dir) / "system_7334_5min" / "data"

    # Load environment data (temperatures)
    env_files = list(data_path.glob("*environment*.parquet"))
    if not env_files:
        raise FileNotFoundError(f"No environment files in {data_path}")

    # Load only 2022 data to avoid schema conflicts
    env_files_2022 = [f for f in env_files if "2022" in f.name]
    if not env_files_2022:
        env_files_2022 = env_files[:1]  # Just use first file

    print(f"Loading {len(env_files_2022)} environment files...")
    df_env = pl.concat([pl.read_parquet(f) for f in sorted(env_files_2022)])

    # Select representative ambient and module temp columns
    # Use weather station 2 (ws2) as primary
    amb_col = [c for c in df_env.columns if 'ws2-amb-t-c' in c][0]
    mod_col = [c for c in df_env.columns if 'ws2-mod-t-c' in c][0]

    df_env = df_env.select([
        pl.col("utc_measured_on").alias("timestamp"),
        pl.col(amb_col).alias("ambient_temp"),
        pl.col(mod_col).alias("module_temp"),
    ])

    # Load DC data (string currents) - 2022 only
    dc_files = list(data_path.glob("*dc*.parquet"))
    if not dc_files:
        raise FileNotFoundError(f"No DC files in {data_path}")

    dc_files_2022 = [f for f in dc_files if "2022" in f.name]
    if not dc_files_2022:
        dc_files_2022 = dc_files[:1]

    print(f"Loading {len(dc_files_2022)} DC files...")
    df_dc = pl.concat([pl.read_parquet(f) for f in sorted(dc_files_2022)])

    # Get string current columns (dc-a columns)
    current_cols = [c for c in df_dc.columns if 'dc-a' in c][:20]  # Limit to 20 strings

    df_dc = df_dc.select([
        pl.col("utc_measured_on").alias("timestamp"),
        *[pl.col(c).alias(f"string_current_{i+1}") for i, c in enumerate(current_cols)]
    ])

    # Load irradiance data - 2022 only
    irr_files = list(data_path.glob("*irradiance*.parquet"))
    if irr_files:
        irr_files_2022 = [f for f in irr_files if "2022" in f.name]
        if not irr_files_2022:
            irr_files_2022 = irr_files[:1]

        print(f"Loading {len(irr_files_2022)} irradiance files...")
        df_irr = pl.concat([pl.read_parquet(f) for f in sorted(irr_files_2022)])

        # Find POA irradiance column
        poa_cols = [c for c in df_irr.columns if 'poa' in c.lower()]
        if poa_cols:
            df_irr = df_irr.select([
                pl.col("utc_measured_on").alias("timestamp"),
                pl.col(poa_cols[0]).alias("poa_irradiance"),
            ])
        else:
            df_irr = None
    else:
        df_irr = None

    # Merge all data
    print("Merging datasets...")
    df = df_env.join(df_dc, on="timestamp", how="inner")

    if df_irr is not None:
        df = df.join(df_irr, on="timestamp", how="left")
    else:
        df = df.with_columns(pl.lit(800.0).alias("poa_irradiance"))

    print(f"Merged data shape: {df.shape}")

    return df


def compute_thermal_features(df: pl.DataFrame) -> pl.DataFrame:
    """
    Compute thermal features for hotspot model.

    Features:
    - temp_delta: module_temp - ambient_temp
    - temp_delta_trend_7d: 7-day trend
    - temp_delta_95th_7d: 95th percentile over 7 days
    - temp_delta_max_7d: max over 7 days
    """
    # FIRST: Filter rows with valid temperature data
    print(f"  Raw rows: {len(df):,}")
    df = df.filter(
        pl.col("ambient_temp").is_not_null() &
        pl.col("module_temp").is_not_null()
    )
    print(f"  After temp filter: {len(df):,}")

    # Basic features
    df = df.with_columns([
        (pl.col("module_temp") - pl.col("ambient_temp")).alias("temp_delta"),
        (pl.col("poa_irradiance").fill_null(800) / 1000).clip(0, 1.5).alias("irradiance_normalized"),
    ])

    # Filter daytime data (irradiance > 50)
    df = df.filter(pl.col("poa_irradiance").fill_null(0) > 50)
    print(f"  After daytime filter: {len(df):,}")

    # Sort by timestamp
    df = df.sort("timestamp")

    # Rolling features (7 days = 7*24*12 = 2016 points at 5-min intervals)
    # Use min_periods=100 to allow early rows to have values
    window_size = 2016
    min_periods = 100  # Require at least 100 samples (~8 hours of data)

    df = df.with_columns([
        pl.col("temp_delta")
            .rolling_mean(window_size=window_size, min_periods=min_periods)
            .alias("temp_delta_mean_7d"),

        pl.col("temp_delta")
            .rolling_max(window_size=window_size, min_periods=min_periods)
            .alias("temp_delta_max_7d"),

        pl.col("temp_delta")
            .rolling_quantile(quantile=0.95, window_size=window_size, min_periods=min_periods)
            .alias("temp_delta_95th_7d"),
    ])

    # Fill remaining nulls with forward fill, then backward fill
    df = df.with_columns([
        pl.col("temp_delta_mean_7d").forward_fill().backward_fill(),
        pl.col("temp_delta_max_7d").forward_fill().backward_fill(),
        pl.col("temp_delta_95th_7d").forward_fill().backward_fill(),
    ])

    # Trend (simplified: current - 7d mean)
    df = df.with_columns([
        ((pl.col("temp_delta") - pl.col("temp_delta_mean_7d")) / 7).fill_null(0).alias("temp_delta_trend_7d"),
    ])

    # Add power_pu proxy (sum of string currents normalized)
    string_cols = [c for c in df.columns if c.startswith("string_current_")]
    if string_cols:
        df = df.with_columns([
            (pl.sum_horizontal([pl.col(c).fill_null(0) for c in string_cols]) / (len(string_cols) * 10)).clip(0, 1.5).alias("power_pu"),
        ])
    else:
        df = df.with_columns([pl.lit(0.5).alias("power_pu")])

    return df


def compute_mismatch_features(df: pl.DataFrame) -> pl.DataFrame:
    """
    Compute mismatch features for string mismatch model.

    Features:
    - worst_string_ratio: min(string) / mean(string)
    - string_power_cv: coefficient of variation
    - string_power_range: max - min
    """
    string_cols = [c for c in df.columns if c.startswith("string_current_")]

    if len(string_cols) < 2:
        raise ValueError("Need at least 2 strings for mismatch features")

    print(f"  Computing mismatch features from {len(string_cols)} strings")

    # Fill nulls in string currents with 0
    df = df.with_columns([
        pl.col(c).fill_null(0) for c in string_cols
    ])

    # Compute string statistics
    df = df.with_columns([
        pl.mean_horizontal([pl.col(c) for c in string_cols]).alias("string_mean"),
        pl.min_horizontal([pl.col(c) for c in string_cols]).alias("string_min"),
        pl.max_horizontal([pl.col(c) for c in string_cols]).alias("string_max"),
    ])

    # Compute CV using standard deviation
    df = df.with_columns([
        (
            (pl.sum_horizontal([(pl.col(c) - pl.col("string_mean"))**2 for c in string_cols]) / len(string_cols)).sqrt()
            / (pl.col("string_mean") + 0.01)
        ).alias("string_power_cv"),
    ])

    # Compute ratio and range
    df = df.with_columns([
        (pl.col("string_min") / (pl.col("string_mean") + 0.01)).clip(0, 2).alias("worst_string_ratio"),
        (pl.col("string_max") - pl.col("string_min")).alias("string_power_range"),
    ])

    # Rolling trend with min_periods
    window_size = 2016  # 7 days
    min_periods = 100

    df = df.with_columns([
        pl.col("worst_string_ratio")
            .rolling_mean(window_size=window_size, min_periods=min_periods)
            .alias("string_ratio_mean_7d"),
    ])

    # Forward fill and backward fill
    df = df.with_columns([
        pl.col("string_ratio_mean_7d").forward_fill().backward_fill(),
    ])

    df = df.with_columns([
        ((pl.col("worst_string_ratio") - pl.col("string_ratio_mean_7d")) / 7).fill_null(0).alias("string_ratio_trend_7d"),
    ])

    return df


def generate_thermal_rul_labels(
    df: pl.DataFrame,
    threshold: float = 25.0,
    max_horizon: int = 10,
) -> pl.DataFrame:
    """
    Generate synthetic RUL labels for thermal hotspot.

    Logic: Days until temp_delta > threshold for sustained period.
    """
    # Simple threshold-based approach
    # If temp_delta is close to threshold, shorter RUL
    df = df.with_columns([
        pl.when(pl.col("temp_delta") >= threshold)
            .then(0.0)
        .when(pl.col("temp_delta") >= threshold - 5)
            .then(((threshold - pl.col("temp_delta")) / 5 * 3).clip(0, max_horizon))
        .when(pl.col("temp_delta") >= threshold - 10)
            .then(((threshold - pl.col("temp_delta")) / 10 * 7).clip(0, max_horizon))
        .otherwise(max_horizon)
        .alias("days_to_fault")
    ])

    return df


def generate_mismatch_rul_labels(
    df: pl.DataFrame,
    threshold: float = 0.85,
    max_horizon: int = 14,
) -> pl.DataFrame:
    """
    Generate synthetic RUL labels for mismatch.

    Logic: Days until worst_string_ratio < threshold.
    """
    # If ratio is below threshold, fault occurred
    # If close to threshold, shorter RUL
    df = df.with_columns([
        pl.when(pl.col("worst_string_ratio") <= threshold)
            .then(0.0)
        .when(pl.col("worst_string_ratio") <= threshold + 0.05)
            .then(((pl.col("worst_string_ratio") - threshold) / 0.05 * 3).clip(0, max_horizon))
        .when(pl.col("worst_string_ratio") <= threshold + 0.10)
            .then(((pl.col("worst_string_ratio") - threshold) / 0.10 * 7).clip(0, max_horizon))
        .otherwise(max_horizon)
        .alias("days_to_fault")
    ])

    return df


def train_thermal_model(df: pl.DataFrame, output_dir: str) -> dict:
    """Train thermal hotspot RUL model."""
    print("\n" + "=" * 60)
    print("TRAINING THERMAL HOTSPOT MODEL")
    print("=" * 60)

    # Features for thermal model
    feature_cols = [
        "temp_delta",
        "temp_delta_trend_7d",
        "temp_delta_95th_7d",
        "temp_delta_max_7d",
        "power_pu",
        "irradiance_normalized",
        "ambient_temp",
    ]

    # Filter for available columns
    available_cols = [c for c in feature_cols if c in df.columns]
    print(f"Using features: {available_cols}")

    # Fill remaining nulls with median for each column, then drop any remaining
    df_train = df.select(available_cols + ["days_to_fault"])

    # Check null counts before filling
    for col in available_cols + ["days_to_fault"]:
        null_count = df_train[col].null_count()
        if null_count > 0:
            print(f"  {col}: {null_count:,} nulls ({100*null_count/len(df_train):.1f}%)")

    # Fill numeric columns with median
    df_train = df_train.with_columns([
        pl.col(c).fill_null(pl.col(c).median()) for c in available_cols
    ])

    # Final drop of any remaining nulls
    df_train = df_train.drop_nulls()
    print(f"Training samples: {len(df_train):,}")

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
    model = RULThermalHotspotModel()
    model.config.additional_features = [c for c in available_cols if c not in [
        model.config.primary_feature, model.config.trend_feature
    ]]

    metrics = model.train(X_train, y_train, X_val, y_val)

    # Evaluate with multi-horizon
    y_pred = model.predict(X_test)
    evaluator = MultiHorizonEvaluator()
    result = evaluator.evaluate(y_test, y_pred)

    print(evaluator.generate_report(result, "Thermal Hotspot"))

    # Check success criteria
    meets, details = check_success_criteria("thermal_hotspot", result)
    print(f"Meets criteria: {meets}")

    # Save model
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    model_path = output_path / "rul_thermal_hotspot.pkl"
    model.save(model_path)
    print(f"Saved to: {model_path}")

    return {
        "mae": result.mae,
        "within_1d": result.within(1),
        "within_3d": result.within(3),
        "within_7d": result.within(7),
        "meets_criteria": meets,
    }


def train_mismatch_model(df: pl.DataFrame, output_dir: str) -> dict:
    """Train mismatch RUL model."""
    print("\n" + "=" * 60)
    print("TRAINING MISMATCH MODEL")
    print("=" * 60)

    # Features for mismatch model
    feature_cols = [
        "worst_string_ratio",
        "string_ratio_trend_7d",
        "string_power_cv",
        "string_power_range",
        "irradiance_normalized",
        "module_temp",
    ]

    # Filter for available columns
    available_cols = [c for c in feature_cols if c in df.columns]
    print(f"Using features: {available_cols}")

    # Fill remaining nulls with median for each column, then drop any remaining
    df_train = df.select(available_cols + ["days_to_fault"])

    # Check null counts before filling
    for col in available_cols + ["days_to_fault"]:
        null_count = df_train[col].null_count()
        if null_count > 0:
            print(f"  {col}: {null_count:,} nulls ({100*null_count/len(df_train):.1f}%)")

    # Fill numeric columns with median
    df_train = df_train.with_columns([
        pl.col(c).fill_null(pl.col(c).median()) for c in available_cols
    ])

    # Final drop of any remaining nulls
    df_train = df_train.drop_nulls()
    print(f"Training samples: {len(df_train):,}")

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
    model = RULMismatchModel()
    model.config.additional_features = [c for c in available_cols if c not in [
        model.config.primary_feature, model.config.trend_feature
    ]]

    metrics = model.train(X_train, y_train, X_val, y_val)

    # Evaluate with multi-horizon
    y_pred = model.predict(X_test)
    evaluator = MultiHorizonEvaluator()
    result = evaluator.evaluate(y_test, y_pred)

    print(evaluator.generate_report(result, "String Mismatch"))

    # Check success criteria
    meets, details = check_success_criteria("mismatch", result)
    print(f"Meets criteria: {meets}")

    # Save model
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    model_path = output_path / "rul_mismatch.pkl"
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
    data_dir = "<repo>/datasets/pvdaq"
    output_dir = "<repo>/models/rul"

    print("=" * 60)
    print("PVDAQ THERMAL & MISMATCH MODEL TRAINING")
    print("=" * 60)

    # Load data
    print("\n[1/5] Loading PVDAQ data...")
    df = load_pvdaq_system_7334(data_dir)

    # Compute thermal features
    print("\n[2/5] Computing thermal features...")
    df = compute_thermal_features(df)

    # Compute mismatch features
    print("\n[3/5] Computing mismatch features...")
    df = compute_mismatch_features(df)

    print(f"\nFinal dataset: {df.shape}")
    print(f"Columns: {df.columns}")

    # Train thermal model
    print("\n[4/5] Training thermal hotspot model...")
    df_thermal = generate_thermal_rul_labels(df.clone())
    thermal_results = train_thermal_model(df_thermal, output_dir)

    # Train mismatch model
    print("\n[5/5] Training mismatch model...")
    df_mismatch = generate_mismatch_rul_labels(df.clone())
    mismatch_results = train_mismatch_model(df_mismatch, output_dir)

    # Summary
    print("\n" + "=" * 80)
    print("TRAINING COMPLETE - SUMMARY")
    print("=" * 80)
    print(f"\n{'Model':<25} {'MAE':>7} {'W/1d':>7} {'W/3d':>7} {'W/7d':>7} {'Pass':>6}")
    print("-" * 80)
    print(f"{'Thermal Hotspot':<25} {thermal_results['mae']:>6.2f}d {thermal_results['within_1d']:>6.1f}% "
          f"{thermal_results['within_3d']:>6.1f}% {thermal_results['within_7d']:>6.1f}% "
          f"{'YES' if thermal_results['meets_criteria'] else 'NO':>6}")
    print(f"{'String Mismatch':<25} {mismatch_results['mae']:>6.2f}d {mismatch_results['within_1d']:>6.1f}% "
          f"{mismatch_results['within_3d']:>6.1f}% {mismatch_results['within_7d']:>6.1f}% "
          f"{'YES' if mismatch_results['meets_criteria'] else 'NO':>6}")
    print("=" * 80)


if __name__ == "__main__":
    main()
