#!/usr/bin/env python3
"""
Enhanced Transfer Learning Evaluation for Soiling Prediction.

Uses the new EnhancedFeatureExtractor with:
1. HybridModel features (P_physics, P_hybrid, ml_residual)
2. Digital Twin features (current_cv, voltage_cv, temp_deviation)
3. Environmental features (soil moisture, sea salt, extinction)

Compares:
1. Original 20 features
2. Enhanced 30-35 features

Reports MAE by SR bin for decision support:
- 90-95%: Cleaning decision zone (most important)
- 95-98%: Monitoring zone
- 98-99%: Clean condition
- >99%: Optimal

Usage:
    python scripts/evaluate_transfer_enhanced.py
    python scripts/evaluate_transfer_enhanced.py --plant-id gamma
"""

import argparse
import json
import pickle
import sys
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import polars as pl

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_transfer_features import (
    EnhancedFeatureExtractor,
    PLANT_CONFIGS,
)


# Source plants for training (best soiling variation)
SOURCE_PLANTS = ["zeta", "epsilon"]

# All plants for evaluation
ALL_PLANTS = ["epsilon", "ribera", "eta", "delta", "zeta", "gamma", "alpha"]

# SR bins for evaluation
SR_BINS = [
    (0.70, 0.90, "<90%"),
    (0.90, 0.95, "90-95%"),
    (0.95, 0.98, "95-98%"),
    (0.98, 0.99, "98-99%"),
    (0.99, 1.02, ">99%"),
]

# Plant column mappings
PLANT_COLUMNS = {
    "epsilon": {
        "scada_path": "backenddata/scada/epsilon",
        "irr_col": "Epsilon: Plant / Irradiation_average (W/m²)",
        "temp_col": "Epsilon: Temperatur Sensor 1 / Ambient (°C)",
        "sr_col": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Epsilon: Meteo.DustIQ / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "ribera": {
        "scada_path": "backenddata/scada/ribera",
        "irr_col": "Ribera (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Ribera (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Ribera (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "eta": {
        "scada_path": "backenddata/scada/eta",
        "irr_col": "Eta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Eta (ES): Temperatur MC / Ambient (°C)",
        "sr_col": "Eta (ES): Dust_IQ.01 / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Eta (ES): Dust_IQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "delta": {
        "scada_path": "backenddata/scada/delta",
        "irr_col": "Delta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Delta (ES): zbloxx 407 / Ambient",
        "sr_col": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Delta (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "zeta": {
        "scada_path": "backenddata/scada/zeta",
        "irr_col": "Zeta (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Zeta (ES): Meteo.Z.bloxx407 / temperature_internal (°C)",
        "sr_col": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Zeta (ES): DUSTIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "gamma": {
        "scada_path": "backenddata/scada/gamma",
        "irr_col": "Gamma 1& 2 (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Gamma 1& 2 (ES): zbloxx 407 / temperature_internal (°C)",
        "sr_col": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Gamma 1& 2 (ES): Dust_IQ / soiling_ratio_Sensor01 (%)_cleaned",
    },
    "alpha": {
        "scada_path": "backenddata/scada/alpha",
        "irr_col": "Alpha (ES): Plant / Irradiation_average (W/m²)",
        "temp_col": "Alpha (ES): Meteo.z.bloxx / Ambient (°C)",
        "sr_col": "Alpha (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)",
        "sr_col_cleaned": "Alpha (ES): DustIQ.01 / soiling_ratio_Sensor01 (%)_cleaned",
    },
}


def find_column(df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
    """Find column matching patterns."""
    for pattern in patterns:
        pattern_clean = pattern.lower().replace('°c', '').replace('(c)', '')
        for col in df.columns:
            col_clean = col.lower().replace('°c', '').replace('(c)', '')
            if pattern_clean in col_clean:
                return col
    return None


def load_plant_scada(plant_id: str, use_cleaned: bool = True) -> Tuple[pd.DataFrame, pd.Series]:
    """Load SCADA data and SR target for a plant.

    Returns
    -------
    df_daily : pd.DataFrame
        Daily SCADA data with irradiance, temperature, power
    sr_daily : pd.Series
        Daily SR target values
    """
    config = PLANT_COLUMNS[plant_id]
    scada_path = Path(config["scada_path"])

    # Try cleaned file first
    if use_cleaned:
        cleaned_file = scada_path / f"{plant_id}_cleaned.parquet"
        if cleaned_file.exists():
            df = pl.read_parquet(cleaned_file)
            sr_col = config.get("sr_col_cleaned", config["sr_col"])
        else:
            parquet_files = list(scada_path.glob("*.parquet"))
            if not parquet_files:
                return None, None
            df = pl.read_parquet(parquet_files[0])
            sr_col = config["sr_col"]
    else:
        parquet_files = list(scada_path.glob("*.parquet"))
        if not parquet_files:
            return None, None
        df = pl.read_parquet(parquet_files[0])
        sr_col = config["sr_col"]

    # Find columns
    irr_col = find_column(df, [config.get("irr_col", ""), "irradiation_average"])
    temp_col = find_column(df, [config.get("temp_col", ""), "ambient"])
    sr_col_found = find_column(df, [sr_col, config["sr_col"], "soiling_ratio"])

    if not irr_col or not sr_col_found:
        print(f"  Missing columns: irr={irr_col}, sr={sr_col_found}")
        return None, None

    # Convert SR to ratio
    df = df.with_columns((pl.col(sr_col_found) / 100).alias('sr_dustiq'))

    # Filter valid data
    df_valid = df.filter(
        pl.col('sr_dustiq').is_not_null() &
        (pl.col('sr_dustiq') >= 0.7) &
        (pl.col('sr_dustiq') <= 1.02) &
        (pl.col(irr_col) > 100)
    )

    if len(df_valid) < 100:
        print(f"  Insufficient data: {len(df_valid)} rows")
        return None, None

    # Parse timestamp and add date column
    df_valid = df_valid.with_columns(
        pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
    )

    # Daily aggregation
    agg_exprs = [
        pl.col('sr_dustiq').mean().alias('sr_dustiq'),
        pl.len().alias('n_samples'),
    ]

    if irr_col:
        agg_exprs.append(pl.col(irr_col).mean().alias('irradiance'))
    if temp_col:
        agg_exprs.append(pl.col(temp_col).mean().alias('temperature'))

    # Find power columns
    power_cols = [c for c in df_valid.columns if 'power' in c.lower() and 'normalized' in c.lower()]
    if power_cols:
        agg_exprs.append(pl.col(power_cols[0]).sum().alias('power'))
    else:
        # Try any power column
        power_cols = [c for c in df_valid.columns if 'power' in c.lower()]
        if power_cols:
            agg_exprs.append(pl.col(power_cols[0]).sum().alias('power'))

    df_daily = df_valid.group_by('date').agg(agg_exprs).sort('date')

    # Convert to pandas
    df_pd = df_daily.to_pandas()
    df_pd['date'] = pd.to_datetime(df_pd['date'])
    df_pd = df_pd.set_index('date')

    # Extract SR target
    sr_daily = df_pd['sr_dustiq']

    return df_pd, sr_daily


def load_plant_enhanced_features(
    plant_id: str,
    df_scada: pd.DataFrame = None,
    include_hybrid: bool = True,
    include_soiling_twin: bool = True,
) -> pd.DataFrame:
    """Load enhanced features using EnhancedFeatureExtractor.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    df_scada : pd.DataFrame
        SCADA data
    include_hybrid : bool
        Include HybridModel features (requires trained model)

    Returns
    -------
    pd.DataFrame
        Enhanced feature matrix
    """
    extractor = EnhancedFeatureExtractor(plant_id)

    # Try to load hybrid model
    hybrid_model = None
    if include_hybrid:
        hybrid_path = Path(f"public/data/digitaltwin/{plant_id}/hybrid_model.pkl")
        if hybrid_path.exists():
            try:
                with open(hybrid_path, 'rb') as f:
                    hybrid_model = pickle.load(f)
                print(f"    Loaded HybridModel from {hybrid_path}")
            except Exception as e:
                print(f"    Could not load HybridModel: {e}")

    # Extract features
    # NOTE: include_soiling_twin=False for transfer learning to avoid plant-specific features
    df_features = extractor.extract_features(
        df_scada,
        hybrid_model=hybrid_model,
        include_hybrid=include_hybrid,
        include_twin=True,
        include_environmental=True,
        include_soiling_twin=include_soiling_twin,
    )

    return df_features


def rolling_avg(arr: np.ndarray, window: int) -> np.ndarray:
    """Calculate rolling average."""
    result = np.zeros_like(arr)
    for i in range(len(arr)):
        start = max(0, i - window + 1)
        result[i] = np.mean(arr[start:i+1])
    return result


def evaluate_model(model, X_test: np.ndarray, y_test: np.ndarray) -> dict:
    """Evaluate model on test data with MAE by SR bin."""
    y_pred = model.predict(X_test)

    # 7-day rolling average
    y_pred_7d = rolling_avg(y_pred, 7)
    y_test_7d = rolling_avg(y_test, 7)

    mae = np.mean(np.abs(y_test - y_pred))
    mae_7d = np.mean(np.abs(y_test_7d - y_pred_7d))
    corr = np.corrcoef(y_test, y_pred)[0, 1] if len(y_test) > 1 else 0

    # MAE by bin
    mae_by_bin = {}
    for low, high, label in SR_BINS:
        mask = (y_test_7d >= low) & (y_test_7d < high)
        count = np.sum(mask)
        if count > 0:
            bin_mae = np.mean(np.abs(y_test_7d[mask] - y_pred_7d[mask]))
            mae_by_bin[label] = {"count": int(count), "mae": float(bin_mae)}
        else:
            mae_by_bin[label] = {"count": 0, "mae": None}

    return {
        "mae": float(mae),
        "mae_7d": float(mae_7d),
        "corr": float(corr),
        "mae_by_bin": mae_by_bin,
        "n_test": len(y_test),
    }


def print_mae_table(results: Dict[str, dict]):
    """Print MAE comparison table by SR bin."""
    print(f"\n{'='*90}")
    print("MAE BY SOILING RATIO BIN (7-day rolling)")
    print(f"{'='*90}")

    # Header
    header = f"{'Plant':<15} {'<90%':>8} {'90-95%':>8} {'95-98%':>8} {'98-99%':>8} {'>99%':>8} {'Overall':>10}"
    print(header)
    print("-" * 90)

    # Same-plant results
    print("\nSAME-PLANT TRAINING:")
    for plant_id in ALL_PLANTS:
        if plant_id not in results:
            continue
        r = results[plant_id].get("same_plant", {})
        bins = r.get("mae_by_bin", {})

        row = f"{plant_id:<15}"
        for label in ["<90%", "90-95%", "95-98%", "98-99%", ">99%"]:
            bin_data = bins.get(label, {})
            mae = bin_data.get("mae")
            count = bin_data.get("count", 0)
            if mae is not None and count > 0:
                row += f" {mae*100:7.2f}%"
            else:
                row += f" {'N/A':>7}"

        overall = r.get("mae_7d", 0) * 100
        row += f" {overall:9.2f}%"
        print(row)

    # Transfer results
    print("\nTRANSFER LEARNING:")
    for plant_id in ALL_PLANTS:
        if plant_id not in results:
            continue
        r = results[plant_id].get("transfer", {})
        bins = r.get("mae_by_bin", {})
        is_source = results[plant_id].get("is_source", False)

        row = f"{plant_id:<15}"
        for label in ["<90%", "90-95%", "95-98%", "98-99%", ">99%"]:
            bin_data = bins.get(label, {})
            mae = bin_data.get("mae")
            count = bin_data.get("count", 0)
            if mae is not None and count > 0:
                row += f" {mae*100:7.2f}%"
            else:
                row += f" {'N/A':>7}"

        overall = r.get("mae_7d", 0) * 100
        marker = " *" if is_source else ""
        row += f" {overall:9.2f}%{marker}"
        print(row)

    print("\n* = Source plant (used in foundation model training)")


def main():
    parser = argparse.ArgumentParser(description="Enhanced Transfer Learning Evaluation")
    parser.add_argument("--plant-id", help="Evaluate single plant only")
    parser.add_argument("--no-hybrid", action="store_true", help="Skip hybrid model features")
    args = parser.parse_args()

    print(f"\n{'='*70}")
    print(f"ENHANCED TRANSFER LEARNING EVALUATION")
    print(f"Source plants: {', '.join(SOURCE_PLANTS)}")
    print(f"Features: EnhancedFeatureExtractor (30-35 features)")
    print(f"Generated: {datetime.now().isoformat()}")
    print(f"{'='*70}")

    include_hybrid = not args.no_hybrid

    # Determine plants to evaluate
    plants_to_eval = [args.plant_id] if args.plant_id else ALL_PLANTS

    # Load and combine source plant data for foundation model
    print(f"\n--- Loading Source Plant Data ---")
    X_train_list = []
    y_train_list = []
    feature_cols = None

    for source_plant in SOURCE_PLANTS:
        print(f"\n  {source_plant.upper()}:")
        df_scada, sr_target = load_plant_scada(source_plant, use_cleaned=True)
        if df_scada is None:
            print(f"    FAILED to load SCADA data")
            continue

        df_features = load_plant_enhanced_features(
            source_plant, df_scada, include_hybrid=include_hybrid
        )

        # Align features and target
        common_idx = df_features.index.intersection(sr_target.index)
        X = df_features.loc[common_idx].values
        y = sr_target.loc[common_idx].values

        print(f"    Days: {len(y)}, Features: {df_features.shape[1]}")

        # Handle NaN
        X = np.nan_to_num(X, nan=0.0)

        X_train_list.append(X)
        y_train_list.append(y)

        if feature_cols is None:
            feature_cols = df_features.columns.tolist()

    if len(X_train_list) == 0:
        print("ERROR: No source plant data loaded")
        return

    # Combine source data
    X_train = np.vstack(X_train_list)
    y_train = np.concatenate(y_train_list)
    print(f"\n  Combined training data: {len(y_train)} days, {X_train.shape[1]} features")

    # SR distribution in training data
    below_95 = (y_train < 0.95).sum()
    in_90_95 = ((y_train >= 0.90) & (y_train < 0.95)).sum()
    print(f"  Days < 95%: {below_95}, Days 90-95%: {in_90_95}")

    # Create sample weights biased towards dirty days
    # This helps the model focus on predicting soiling correctly
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 10.0   # Very dirty - highest weight
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.0   # Dirty - high weight
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 3.0   # Moderate - medium weight
    sample_weights[(y_train >= 0.98) & (y_train < 0.99)] = 2.0   # Light - low weight
    # SR > 99%: weight = 1.0 (default)

    print(f"  Sample weights: <90%=10x, 90-95%=5x, 95-98%=3x, 98-99%=2x, >99%=1x")

    # Train foundation model
    print(f"\n--- Training Foundation Model (weighted) ---")
    from catboost import CatBoostRegressor

    foundation_model = CatBoostRegressor(
        iterations=300,
        learning_rate=0.02,
        depth=4,
        l2_leaf_reg=10.0,
        min_data_in_leaf=20,
        random_seed=42,
        verbose=False,
    )
    foundation_model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)
    print(f"  Foundation model trained (dirty-day weighted)")

    # Feature importance
    importance = foundation_model.get_feature_importance()
    feat_imp = sorted(zip(feature_cols, importance), key=lambda x: -x[1])
    print(f"\n  Top 10 Features:")
    for fname, imp in feat_imp[:10]:
        print(f"    {fname}: {imp:.1f}")

    # Evaluate on all plants
    print(f"\n{'='*70}")
    print(f"EVALUATION RESULTS")
    print(f"{'='*70}")

    results = {}

    for plant_id in plants_to_eval:
        print(f"\n--- {plant_id.upper()} ---")

        df_scada, sr_target = load_plant_scada(plant_id, use_cleaned=True)
        if df_scada is None:
            print(f"  FAILED to load data")
            continue

        df_features = load_plant_enhanced_features(
            plant_id, df_scada, include_hybrid=include_hybrid
        )

        # Align features and target
        common_idx = df_features.index.intersection(sr_target.index)
        X = df_features.loc[common_idx].values
        y = sr_target.loc[common_idx].values

        # Handle NaN
        X = np.nan_to_num(X, nan=0.0)

        # Align to foundation model features
        if X.shape[1] != len(feature_cols):
            print(f"  Feature mismatch: {X.shape[1]} vs {len(feature_cols)}, padding/truncating")
            if X.shape[1] < len(feature_cols):
                # Pad with zeros
                diff = len(feature_cols) - X.shape[1]
                X = np.hstack([X, np.zeros((len(X), diff))])
            else:
                X = X[:, :len(feature_cols)]

        print(f"  Days: {len(y)}, Features: {X.shape[1]}")

        # Same-plant evaluation (80/20 split)
        n_train_sp = int(len(X) * 0.8)
        X_train_sp, X_test_sp = X[:n_train_sp], X[n_train_sp:]
        y_train_sp, y_test_sp = y[:n_train_sp], y[n_train_sp:]

        same_plant_model = CatBoostRegressor(
            iterations=200,
            learning_rate=0.02,
            depth=3,
            l2_leaf_reg=15.0,
            min_data_in_leaf=30,
            random_seed=42,
            verbose=False,
        )
        same_plant_model.fit(X_train_sp, y_train_sp, verbose=False)
        same_plant_result = evaluate_model(same_plant_model, X_test_sp, y_test_sp)

        # Transfer learning evaluation (use last 20% as test)
        X_test_tf = X[n_train_sp:]
        y_test_tf = y[n_train_sp:]
        transfer_result = evaluate_model(foundation_model, X_test_tf, y_test_tf)

        # Compare
        is_source = plant_id in SOURCE_PLANTS
        improvement = (same_plant_result['mae_7d'] - transfer_result['mae_7d']) / same_plant_result['mae_7d'] * 100

        print(f"  Same-plant 7d MAE: {same_plant_result['mae_7d']*100:.2f}%")
        print(f"  Transfer 7d MAE:   {transfer_result['mae_7d']*100:.2f}% {'(source plant)' if is_source else ''}")
        print(f"  Improvement:       {improvement:+.1f}%")

        # MAE by bin comparison
        print(f"\n  MAE by SR bin (Same-plant → Transfer):")
        for label in ["90-95%", "95-98%", "98-99%", ">99%"]:
            sp_data = same_plant_result['mae_by_bin'].get(label, {})
            tf_data = transfer_result['mae_by_bin'].get(label, {})
            sp_mae = sp_data.get('mae')
            tf_mae = tf_data.get('mae')
            count = sp_data.get('count', 0)

            if count > 0 and sp_mae is not None and tf_mae is not None:
                change = "better" if tf_mae < sp_mae else "worse"
                print(f"    {label}: {sp_mae*100:.2f}% → {tf_mae*100:.2f}% ({change}, {count} days)")
            elif count > 0:
                print(f"    {label}: N/A ({count} days)")

        results[plant_id] = {
            "is_source": is_source,
            "n_days": len(y),
            "n_features": X.shape[1],
            "same_plant": same_plant_result,
            "transfer": transfer_result,
            "improvement_pct": improvement,
        }

    # Print summary table
    print_mae_table(results)

    # Summary statistics
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")

    non_source = [r for p, r in results.items() if not r.get("is_source")]
    if non_source:
        avg_sp_mae = np.mean([r["same_plant"]["mae_7d"] for r in non_source]) * 100
        avg_tf_mae = np.mean([r["transfer"]["mae_7d"] for r in non_source]) * 100
        avg_improvement = np.mean([r["improvement_pct"] for r in non_source])

        print(f"\nNon-source plants (transfer target):")
        print(f"  Avg same-plant 7d MAE: {avg_sp_mae:.2f}%")
        print(f"  Avg transfer 7d MAE:   {avg_tf_mae:.2f}%")
        print(f"  Avg improvement:       {avg_improvement:+.1f}%")

    # Save results
    output_dir = Path("backenddata/transfer_learning")
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"enhanced_evaluation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

    with open(output_file, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'source_plants': SOURCE_PLANTS,
            'feature_count': len(feature_cols),
            'feature_names': feature_cols,
            'results': results,
        }, f, indent=2, default=str)

    print(f"\nResults saved to: {output_file}")


if __name__ == "__main__":
    main()
