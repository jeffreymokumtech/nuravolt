#!/usr/bin/env python
"""
Benchmark RUL Models on Alpha (Spain) Data

Tests how well models trained on other datasets generalize to Alpha.
"""

import sys
from pathlib import Path
import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.fault import RULPredictor, create_predictor
from nuravolt.fault.rul_evaluation import MultiHorizonEvaluator


def load_alpha_sample(filepath: str, n_inverters: int = 10) -> pl.DataFrame:
    """Load Alpha data with standardized columns."""
    print(f"Loading Alpha data...")
    df = pl.read_parquet(filepath)
    print(f"  Shape: {df.shape}")

    # Get ambient temp
    amb_col = [c for c in df.columns if 'Ambient' in c and '°C' in c][0]
    mod_col = [c for c in df.columns if 'Module' in c and '°C' in c][0]

    # Find inverter columns
    inv_temp_cols = [c for c in df.columns if '/ Temperature' in c and 'INV' in c][:n_inverters]
    inv_power_cols = [c for c in df.columns if '/ P_AC' in c and 'INV' in c][:n_inverters]

    print(f"  Using {len(inv_temp_cols)} inverters")

    # Process each inverter
    all_data = []
    for i, (temp_col, power_col) in enumerate(zip(inv_temp_cols, inv_power_cols)):
        inv_id = temp_col.split('INV ')[1].split(' /')[0]

        # Get string currents for this inverter
        string_cols = [c for c in df.columns if f'INV {inv_id}' in c and 'Input_current' in c]

        inv_df = df.select([
            pl.col("timestamp"),
            pl.col(amb_col).alias("ambient_temp"),
            pl.col(mod_col).alias("module_temp"),
            pl.col(temp_col).alias("inverter_temp"),
            pl.col(power_col).alias("ac_power_kw"),
            *[pl.col(c).alias(f"string_current_{j+1}") for j, c in enumerate(string_cols[:12])],
        ]).with_columns([
            pl.lit(inv_id).alias("inverter_id"),
        ])

        all_data.append(inv_df)

    return pl.concat(all_data)


def compute_all_features(df: pl.DataFrame) -> pl.DataFrame:
    """Compute features for all models."""
    print("Computing features...")

    # Filter valid data
    df = df.filter(
        pl.col("ambient_temp").is_not_null() &
        pl.col("module_temp").is_not_null() &
        pl.col("inverter_temp").is_not_null() &
        pl.col("ac_power_kw").is_not_null()
    )

    df = df.filter(
        (pl.col("inverter_temp") > 0) &
        (pl.col("inverter_temp") < 100) &
        (pl.col("ac_power_kw") > 1)
    )

    print(f"  Valid rows: {len(df):,}")

    # Basic features
    df = df.with_columns([
        # Thermal features
        (pl.col("inverter_temp") - pl.col("ambient_temp")).alias("temp_rise"),
        (pl.col("module_temp") - pl.col("ambient_temp")).alias("temp_delta"),
        (pl.col("ac_power_kw") / 333.0).clip(0, 1.5).alias("ac_power_pu"),
        (pl.col("ac_power_kw") / 333.0).clip(0, 1.5).alias("power_pu"),
        pl.lit(0.8).alias("irradiance_normalized"),
    ])

    # String features
    string_cols = [c for c in df.columns if c.startswith("string_current_")]
    if string_cols:
        df = df.with_columns([
            pl.col(c).fill_null(0) for c in string_cols
        ])

        df = df.with_columns([
            pl.mean_horizontal([pl.col(c) for c in string_cols]).alias("string_mean"),
            pl.min_horizontal([pl.col(c) for c in string_cols]).alias("string_min"),
            pl.max_horizontal([pl.col(c) for c in string_cols]).alias("string_max"),
        ])

        df = df.with_columns([
            (
                (pl.sum_horizontal([(pl.col(c) - pl.col("string_mean"))**2 for c in string_cols]) / len(string_cols)).sqrt()
                / (pl.col("string_mean") + 0.01)
            ).alias("string_current_cv"),
            (pl.col("string_min") / (pl.col("string_mean") + 0.01)).clip(0, 2).alias("worst_string_ratio"),
            (pl.col("string_min") / (pl.col("string_mean") + 0.01)).clip(0, 2).alias("string_current_min_ratio"),
            (pl.col("string_max") / (pl.col("string_mean") + 0.01)).clip(0, 2).alias("string_current_max_ratio"),
            (pl.col("string_max") - pl.col("string_min")).alias("string_power_range"),
        ])

        df = df.with_columns([
            pl.col("string_current_cv").alias("string_power_cv"),
        ])

    # Sort for rolling
    df = df.sort(["inverter_id", "timestamp"])

    # Rolling features (7 days at 15-min = 672)
    window = 672
    min_samples = 50

    df = df.with_columns([
        # Thermal trends
        pl.col("temp_rise").rolling_mean(window_size=window, min_periods=min_samples).over("inverter_id").alias("temp_rise_mean_7d"),
        pl.col("temp_rise").rolling_max(window_size=window, min_periods=min_samples).over("inverter_id").alias("temp_rise_max_7d"),
        pl.col("temp_rise").rolling_quantile(quantile=0.95, window_size=window, min_periods=min_samples).over("inverter_id").alias("temp_rise_95th_7d"),

        pl.col("temp_delta").rolling_mean(window_size=window, min_periods=min_samples).over("inverter_id").alias("temp_delta_mean_7d"),
        pl.col("temp_delta").rolling_max(window_size=window, min_periods=min_samples).over("inverter_id").alias("temp_delta_max_7d"),
        pl.col("temp_delta").rolling_quantile(quantile=0.95, window_size=window, min_periods=min_samples).over("inverter_id").alias("temp_delta_95th_7d"),

        # String trends
        pl.col("string_current_cv").rolling_mean(window_size=window, min_periods=min_samples).over("inverter_id").alias("string_cv_mean_7d"),
        pl.col("worst_string_ratio").rolling_mean(window_size=window, min_periods=min_samples).over("inverter_id").alias("string_ratio_mean_7d"),
    ])

    # Fill nulls
    trend_cols = [c for c in df.columns if '_7d' in c]
    df = df.with_columns([
        pl.col(c).forward_fill().backward_fill().over("inverter_id") for c in trend_cols
    ])

    # Compute trends
    df = df.with_columns([
        ((pl.col("temp_rise") - pl.col("temp_rise_mean_7d")) / 7).fill_null(0).alias("temp_rise_trend_7d"),
        ((pl.col("temp_delta") - pl.col("temp_delta_mean_7d")) / 7).fill_null(0).alias("temp_delta_trend_7d"),
        ((pl.col("string_current_cv") - pl.col("string_cv_mean_7d")) / 7).fill_null(0).alias("string_cv_trend_7d"),
        ((pl.col("worst_string_ratio") - pl.col("string_ratio_mean_7d")) / 7).fill_null(0).alias("string_ratio_trend_7d"),
    ])

    return df


def generate_labels(df: pl.DataFrame) -> dict:
    """Generate synthetic labels for each model type."""
    labels = {}

    # Inverter thermal: days until inverter_temp > 65°C
    threshold = 65.0
    max_horizon = 10
    labels["inverter_thermal"] = (
        pl.when(pl.col("inverter_temp") >= threshold).then(0.0)
        .when(pl.col("inverter_temp") >= threshold - 5).then(((threshold - pl.col("inverter_temp")) / 5 * 2).clip(0, max_horizon))
        .when(pl.col("inverter_temp") >= threshold - 10).then(((threshold - pl.col("inverter_temp")) / 10 * 5).clip(0, max_horizon))
        .otherwise(max_horizon)
    )

    # Thermal hotspot: days until temp_delta > 25°C
    threshold = 25.0
    labels["thermal_hotspot"] = (
        pl.when(pl.col("temp_delta") >= threshold).then(0.0)
        .when(pl.col("temp_delta") >= threshold - 5).then(((threshold - pl.col("temp_delta")) / 5 * 3).clip(0, 10))
        .otherwise(10.0)
    )

    # String mismatch: days until worst_string_ratio < 0.85
    threshold = 0.85
    labels["mismatch"] = (
        pl.when(pl.col("worst_string_ratio") <= threshold).then(0.0)
        .when(pl.col("worst_string_ratio") <= threshold + 0.05).then(((pl.col("worst_string_ratio") - threshold) / 0.05 * 3).clip(0, 14))
        .otherwise(14.0)
    )

    # String degradation: days until CV > 25%
    threshold = 0.25
    labels["string_degradation"] = (
        pl.when(pl.col("string_current_cv") >= threshold).then(0.0)
        .when(pl.col("string_current_cv") >= threshold - 0.05).then(((threshold - pl.col("string_current_cv")) / 0.05 * 3).clip(0, 14))
        .otherwise(14.0)
    )

    return labels


def benchmark_model(
    predictor: RULPredictor,
    model_name: str,
    df: pl.DataFrame,
    label_expr,
) -> dict:
    """Benchmark a single model."""
    if model_name not in predictor.models:
        return None

    model = predictor.models[model_name]

    # Get feature columns
    feature_cols = model.feature_columns
    available_features = [c for c in feature_cols if c in df.columns]

    if len(available_features) < len(feature_cols) * 0.7:
        print(f"  {model_name}: Not enough features ({len(available_features)}/{len(feature_cols)})")
        return None

    # Add labels
    df_eval = df.with_columns([
        label_expr.alias("days_to_fault")
    ])

    # Prepare data
    df_eval = df_eval.select(available_features + ["days_to_fault"]).drop_nulls()

    if len(df_eval) < 1000:
        print(f"  {model_name}: Not enough samples ({len(df_eval)})")
        return None

    # Extract arrays
    X = df_eval.select(available_features).to_numpy()
    y_true = df_eval["days_to_fault"].to_numpy()

    # Predict
    y_pred = model.predict(X)

    # Evaluate
    evaluator = MultiHorizonEvaluator()
    result = evaluator.evaluate(y_true, y_pred)

    return {
        "mae": result.mae,
        "rmse": result.rmse,
        "within_1d": result.within(1),
        "within_3d": result.within(3),
        "within_7d": result.within(7),
        "samples": len(y_true),
    }


def main():
    data_file = "<repo>/demo_spain/emsdt_650addffb0721062b19a6636_15_00461_Inverter_Inverter Power Normalized_training.parquet"
    model_dir = "<repo>/models/rul"

    print("=" * 70)
    print("BENCHMARK RUL MODELS ON ALPHA DATA")
    print("=" * 70)

    # Load predictor
    print("\n[1/4] Loading models...")
    predictor = create_predictor(model_dir)

    # Load data
    print("\n[2/4] Loading Alpha data...")
    df = load_alpha_sample(data_file, n_inverters=20)

    # Compute features
    print("\n[3/4] Computing features...")
    df = compute_all_features(df)

    # Generate labels
    print("\n[4/4] Benchmarking models...")
    labels = generate_labels(df)

    results = {}
    for model_name, label_expr in labels.items():
        result = benchmark_model(predictor, model_name, df, label_expr)
        if result:
            results[model_name] = result

    # Print results
    print("\n" + "=" * 90)
    print("BENCHMARK RESULTS: ALPHA DATA")
    print("=" * 90)
    print(f"\n{'Model':<20} {'Samples':>10} {'MAE':>8} {'RMSE':>8} {'W/1d':>8} {'W/3d':>8} {'W/7d':>8}")
    print("-" * 90)

    for model_name, r in results.items():
        print(f"{model_name:<20} {r['samples']:>10,} {r['mae']:>7.2f}d {r['rmse']:>7.2f}d "
              f"{r['within_1d']:>7.1f}% {r['within_3d']:>7.1f}% {r['within_7d']:>7.1f}%")

    print("=" * 90)

    # Summary
    print("\n📊 INTERPRETATION:")
    print("-" * 50)
    for model_name, r in results.items():
        if r['within_3d'] > 90:
            status = "✅ EXCELLENT"
        elif r['within_3d'] > 70:
            status = "⚠️ GOOD"
        else:
            status = "❌ NEEDS WORK"
        print(f"  {model_name}: {status} (MAE={r['mae']:.2f}d)")


if __name__ == "__main__":
    main()
