#!/usr/bin/env python3
"""
Diagnose soiling variance to understand why R² is negative for some plants.

Key insight: R² can be arbitrarily negative when:
1. Test set variance is near zero (clean plant with constant SR)
2. Model predictions have ANY error (even small)
3. Train/test distribution shift

For clean plants, MAE is more meaningful than R².
"""

import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).parent.parent))


PLANTS = {
    "epsilon": {
        "scada_path": "backenddata/scada/epsilon",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
    },
    "ribera": {
        "scada_path": "backenddata/scada/ribera",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "eta": {
        "scada_path": "backenddata/scada/eta",
        "sr_col": "Eta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "delta": {
        "scada_path": "backenddata/scada/delta",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "zeta": {
        "scada_path": "backenddata/scada/zeta",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
    },
    "gamma": {
        "scada_path": "backenddata/scada/gamma",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
    },
    "alpha": {
        "scada_path": "backenddata/scada/alpha",
        "sr_col": "Alpha (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
    },
}


def find_sr_column(df: pl.DataFrame, pattern: str) -> str:
    """Find soiling ratio column."""
    for col in df.columns:
        if pattern.lower() in col.lower():
            return col
        if "soiling_ratio" in col.lower():
            return col
    return None


def analyze_plant(plant_id: str, config: dict):
    """Analyze variance distribution for a plant."""
    print(f"\n{'='*60}")
    print(f"PLANT: {plant_id.upper()}")
    print(f"{'='*60}")

    scada_path = Path(config["scada_path"])
    parquet_files = list(scada_path.glob("*.parquet"))
    if not parquet_files:
        print("  No data")
        return None

    df = pl.read_parquet(parquet_files[0])
    sr_col = find_sr_column(df, config["sr_col"])

    if not sr_col:
        print("  No SR column found")
        return None

    # Get SR values (as fraction)
    sr = df[sr_col].to_numpy() / 100
    sr_valid = sr[(sr >= 0.7) & (sr <= 1.02) & ~np.isnan(sr)]

    # Daily aggregation
    df = df.with_columns(
        pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
    )

    df_daily = df.with_columns(
        (pl.col(sr_col) / 100).alias('sr')
    ).filter(
        pl.col('sr').is_not_null() &
        (pl.col('sr') >= 0.7) &
        (pl.col('sr') <= 1.02)
    ).group_by('date').agg(
        pl.col('sr').mean().alias('sr_mean')
    ).sort('date')

    sr_daily = df_daily['sr_mean'].to_numpy()
    n_days = len(sr_daily)

    # Train/test split
    n_train = int(n_days * 0.8)
    sr_train = sr_daily[:n_train]
    sr_test = sr_daily[n_train:]

    # Statistics
    train_mean = np.mean(sr_train)
    train_std = np.std(sr_train)
    train_range = np.max(sr_train) - np.min(sr_train)

    test_mean = np.mean(sr_test)
    test_std = np.std(sr_test)
    test_range = np.max(sr_test) - np.min(sr_test)

    # What R² would be if we just predicted train mean
    baseline_error = np.mean((sr_test - train_mean) ** 2)
    test_variance = np.var(sr_test)
    implied_r2 = 1 - baseline_error / test_variance if test_variance > 0 else 0

    # Count soiling days
    soiled_train = np.sum(sr_train < 0.99)
    soiled_test = np.sum(sr_test < 0.99)

    print(f"\n  TRAIN ({n_train} days):")
    print(f"    Mean SR:    {train_mean:.4f} ({train_mean*100:.2f}%)")
    print(f"    Std SR:     {train_std:.4f} ({train_std*100:.2f}%)")
    print(f"    Range:      {train_range:.4f} ({train_range*100:.2f}%)")
    print(f"    Soiled days (<99%): {soiled_train} ({soiled_train/n_train*100:.1f}%)")

    print(f"\n  TEST ({len(sr_test)} days):")
    print(f"    Mean SR:    {test_mean:.4f} ({test_mean*100:.2f}%)")
    print(f"    Std SR:     {test_std:.4f} ({test_std*100:.2f}%)")
    print(f"    Range:      {test_range:.4f} ({test_range*100:.2f}%)")
    print(f"    Soiled days (<99%): {soiled_test} ({soiled_test/len(sr_test)*100:.1f}%)")

    print(f"\n  ANALYSIS:")
    print(f"    Distribution shift: {abs(train_mean - test_mean)*100:.2f}%")
    print(f"    Variance ratio (test/train): {test_std/train_std:.2f}")
    print(f"    Baseline R² (predict train mean): {implied_r2:.4f}")

    # Predictability assessment
    if test_std < 0.005:  # < 0.5% std
        predictability = "LOW - Plant too clean, minimal variance"
    elif test_std < 0.01:  # < 1% std
        predictability = "MEDIUM - Some variance, R² may be unstable"
    else:
        predictability = "HIGH - Sufficient variance for R² metric"

    print(f"    Predictability: {predictability}")

    # Recommendation
    if test_std < 0.005:
        rec = "Use MAE only (R² inappropriate for near-constant data)"
    elif implied_r2 < -0.5:
        rec = "Significant distribution shift - retrain on recent data"
    elif test_std < 0.01:
        rec = "R² volatile - report MAE as primary metric"
    else:
        rec = "R² appropriate for evaluation"

    print(f"    Recommendation: {rec}")

    return {
        "plant_id": plant_id,
        "n_days": n_days,
        "train_mean": float(train_mean),
        "train_std": float(train_std),
        "test_mean": float(test_mean),
        "test_std": float(test_std),
        "test_variance": float(test_variance),
        "baseline_r2": float(implied_r2),
        "soiled_pct_train": float(soiled_train / n_train * 100),
        "soiled_pct_test": float(soiled_test / len(sr_test) * 100),
        "predictability": predictability,
    }


def main():
    print("="*60)
    print("SOILING VARIANCE DIAGNOSIS")
    print("="*60)
    print("Analyzing why R² is negative for some plants")

    results = []
    for plant_id, config in PLANTS.items():
        r = analyze_plant(plant_id, config)
        if r:
            results.append(r)

    # Summary
    print("\n" + "="*90)
    print("SUMMARY")
    print("="*90)
    print(f"{'Plant':<12} | {'Train Mean':>10} | {'Test Std':>9} | {'Soiled%':>8} | {'Baseline R²':>11} | Verdict")
    print("-" * 90)

    for r in results:
        verdict = "✓ OK" if r['test_std'] >= 0.005 and r['baseline_r2'] > -0.5 else "⚠ Low variance"
        print(f"{r['plant_id']:<12} | {r['train_mean']*100:>9.2f}% | {r['test_std']*100:>8.3f}% | {r['soiled_pct_test']:>7.1f}% | {r['baseline_r2']:>11.4f} | {verdict}")

    print("\n" + "="*60)
    print("KEY INSIGHT:")
    print("="*60)
    print("Plants with test_std < 0.5% have near-constant SR.")
    print("For these plants, R² is meaningless (can be -infinity).")
    print("Use MAE as the evaluation metric instead.")
    print("")
    print("For plants with negative baseline R²:")
    print("  → Train/test distribution shift is the problem")
    print("  → Model needs to adapt to test period patterns")

    # Save
    output_path = Path("backenddata/outputs/dustiq_analysis/variance_diagnosis.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
