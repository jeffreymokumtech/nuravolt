#!/usr/bin/env python3
"""
Clean DustIQ sensor data by removing spikes and smoothing anomalies.

Cleaning steps:
1. Remove extreme values (>110% or <50%)
2. Detect and remove sudden spikes (>5% jump in single reading)
3. Apply rolling median filter to smooth remaining noise
4. Interpolate gaps from removed values

Usage:
    python scripts/clean_dustiq_data.py
    python scripts/clean_dustiq_data.py --plant gamma
"""

import argparse
from pathlib import Path
from datetime import datetime

import numpy as np
import polars as pl


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


def find_sr_column(df: pl.DataFrame, hint: str) -> str:
    """Find the soiling ratio column."""
    # Try exact match first
    if hint in df.columns:
        return hint
    # Try pattern match
    for col in df.columns:
        if 'soiling_ratio' in col.lower():
            return col
    raise ValueError("No soiling ratio column found")


def clean_dustiq_series(sr_values: np.ndarray, timestamps: list) -> tuple:
    """
    Clean DustIQ soiling ratio series.

    Returns:
        cleaned_values: Cleaned SR values
        stats: Dictionary with cleaning statistics
    """
    original = sr_values.copy()
    n_original = len(original)
    cleaned = sr_values.copy()

    stats = {
        "original_count": n_original,
        "original_nulls": int(np.isnan(original).sum()),
    }

    # Step 1: Remove extreme values (>110% or <50%)
    extreme_mask = (cleaned > 110) | (cleaned < 50)
    n_extreme = int(np.sum(extreme_mask))
    cleaned[extreme_mask] = np.nan
    stats["removed_extreme"] = n_extreme

    # Step 2: Detect sudden spikes (>5% change in single reading)
    # Use rolling window to detect spikes
    n_spikes = 0
    for i in range(1, len(cleaned) - 1):
        if np.isnan(cleaned[i]):
            continue

        # Get neighbors
        prev_val = cleaned[i-1] if not np.isnan(cleaned[i-1]) else None
        next_val = cleaned[i+1] if not np.isnan(cleaned[i+1]) else None

        if prev_val is not None and next_val is not None:
            # If current value differs significantly from both neighbors
            # but neighbors are similar, it's a spike
            curr = cleaned[i]
            neighbor_diff = abs(prev_val - next_val)
            curr_to_prev = abs(curr - prev_val)
            curr_to_next = abs(curr - next_val)

            if neighbor_diff < 2 and (curr_to_prev > 5 or curr_to_next > 5):
                cleaned[i] = np.nan
                n_spikes += 1

    stats["removed_spikes"] = n_spikes

    # Step 3: Apply rolling median filter (window=5) to smooth remaining noise
    # Only apply to non-null values
    window_size = 5
    smoothed = cleaned.copy()

    for i in range(len(smoothed)):
        if np.isnan(cleaned[i]):
            continue

        # Get window
        start = max(0, i - window_size // 2)
        end = min(len(cleaned), i + window_size // 2 + 1)
        window = cleaned[start:end]
        valid = window[~np.isnan(window)]

        if len(valid) >= 3:
            smoothed[i] = np.median(valid)

    cleaned = smoothed

    # Step 4: Interpolate gaps (linear interpolation for short gaps)
    # Find gaps and interpolate if gap <= 4 readings
    n_interpolated = 0
    in_gap = False
    gap_start = 0

    for i in range(len(cleaned)):
        if np.isnan(cleaned[i]):
            if not in_gap:
                in_gap = True
                gap_start = i
        else:
            if in_gap:
                gap_end = i
                gap_length = gap_end - gap_start

                # Only interpolate short gaps
                if gap_length <= 4 and gap_start > 0:
                    prev_val = cleaned[gap_start - 1]
                    next_val = cleaned[gap_end]

                    if not np.isnan(prev_val) and not np.isnan(next_val):
                        # Linear interpolation
                        for j in range(gap_start, gap_end):
                            t = (j - gap_start + 1) / (gap_length + 1)
                            cleaned[j] = prev_val + t * (next_val - prev_val)
                            n_interpolated += 1

                in_gap = False

    stats["interpolated"] = n_interpolated

    # Final stats
    stats["final_nulls"] = int(np.isnan(cleaned).sum())
    stats["final_valid"] = int((~np.isnan(cleaned)).sum())

    # Calculate improvement metrics
    valid_original = original[(~np.isnan(original)) & (original >= 50) & (original <= 110)]
    valid_cleaned = cleaned[~np.isnan(cleaned)]

    if len(valid_original) > 0:
        stats["original_mean"] = float(np.mean(valid_original))
        stats["original_std"] = float(np.std(valid_original))

    if len(valid_cleaned) > 0:
        stats["cleaned_mean"] = float(np.mean(valid_cleaned))
        stats["cleaned_std"] = float(np.std(valid_cleaned))

    return cleaned, stats


def clean_plant_data(plant_id: str, config: dict, save: bool = True) -> dict:
    """Clean DustIQ data for a single plant."""
    print(f"\n{'='*60}")
    print(f"CLEANING: {plant_id.upper()}")
    print(f"{'='*60}")

    scada_path = Path(config["scada_path"])
    parquet_files = list(scada_path.glob("*.parquet"))

    if not parquet_files:
        print(f"  No parquet files found")
        return {"status": "no_data"}

    # Load data
    df = pl.read_parquet(parquet_files[0])

    try:
        sr_col = find_sr_column(df, config.get("sr_col", ""))
    except ValueError as e:
        print(f"  {e}")
        return {"status": "no_sr_column"}

    print(f"  SR column: {sr_col}")
    print(f"  Total rows: {len(df):,}")

    # Get SR values
    sr_values = df[sr_col].to_numpy().astype(float)
    timestamps = df['timestamp'].to_list() if 'timestamp' in df.columns else list(range(len(df)))

    # Clean
    cleaned_values, stats = clean_dustiq_series(sr_values, timestamps)

    # Report
    print(f"\n  Cleaning Results:")
    print(f"    Original nulls: {stats['original_nulls']:,}")
    print(f"    Removed extreme (>110% or <50%): {stats['removed_extreme']:,}")
    print(f"    Removed spikes: {stats['removed_spikes']:,}")
    print(f"    Interpolated: {stats['interpolated']:,}")
    print(f"    Final valid: {stats['final_valid']:,}")

    if 'original_mean' in stats and 'cleaned_mean' in stats:
        print(f"\n  Statistics:")
        print(f"    Original: {stats['original_mean']:.2f}% ± {stats['original_std']:.2f}%")
        print(f"    Cleaned:  {stats['cleaned_mean']:.2f}% ± {stats['cleaned_std']:.2f}%")

    # Save cleaned data
    if save:
        # Create new column with cleaned values
        cleaned_col = f"{sr_col}_cleaned"
        df = df.with_columns(
            pl.Series(cleaned_col, cleaned_values)
        )

        # Save to new parquet file
        output_path = scada_path / f"{plant_id}_cleaned.parquet"
        df.write_parquet(output_path)
        print(f"\n  Saved to: {output_path}")

        stats["output_path"] = str(output_path)

    stats["status"] = "success"
    stats["plant_id"] = plant_id

    return stats


def main():
    parser = argparse.ArgumentParser(description="Clean DustIQ sensor data")
    parser.add_argument("--plant", help="Specific plant to clean (or 'all')")
    args = parser.parse_args()

    print(f"\n{'='*60}")
    print(f"DUSTIQ DATA CLEANING")
    print(f"Generated: {datetime.now().isoformat()}")
    print(f"{'='*60}")

    if args.plant and args.plant != "all":
        if args.plant not in PLANTS:
            print(f"Unknown plant: {args.plant}")
            print(f"Available: {', '.join(PLANTS.keys())}")
            return

        clean_plant_data(args.plant, PLANTS[args.plant])
    else:
        results = []
        for plant_id, config in PLANTS.items():
            result = clean_plant_data(plant_id, config)
            results.append(result)

        # Summary
        print(f"\n{'='*60}")
        print("SUMMARY")
        print(f"{'='*60}")

        for result in results:
            if result.get("status") == "success":
                plant = result["plant_id"]
                removed = result["removed_extreme"] + result["removed_spikes"]
                print(f"  {plant}: removed {removed:,} anomalies, {result['final_valid']:,} valid")


if __name__ == "__main__":
    main()
