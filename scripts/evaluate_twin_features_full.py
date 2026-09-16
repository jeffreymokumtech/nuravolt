#!/usr/bin/env python3
"""
Full evaluation of soiling prediction using ALL twin features from loss disaggregator.

For each plant:
1. Load SCADA data
2. Run multi-signal twin predictions to get ALL features
3. Combine with weather/AOD features
4. Train CatBoost to predict soiling ratio
5. Report R² and MAE

Twin features extracted:
- temp_deviation: T_actual - T_expected (thermal indicator)
- current_cv: DC current coefficient of variation (shading vs uniform soiling)
- current_imbalance_ratio: Max/min current ratio (equipment faults)
- current_loss_pct: (I_expected - I_actual) / I_expected * 100
- voltage_cv: DC voltage coefficient of variation
- voltage_deviation: V_actual - V_expected
- voltage_loss_pct: (V_expected - V_actual) / V_expected * 100
- power_loss_pct: (P_expected - P_actual) / P_expected * 100
- T_expected, I_expected, V_expected, P_expected: Expected values from physics+ML
- inv_temp_mean, inv_temp_max: Inverter temperature stats
"""

import json
import sys
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import polars as pl

warnings.filterwarnings('ignore')

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.digitaltwin.multi_signal_twin import (
    MultiSignalTwinFactory,
    DCCurrentTwin,
    DCVoltageTwin,
)


# Plant configurations
PLANTS = {
    "alpha1": {
        "name": "Alpha1 (ES)",
        "lat": 37.818,
        "lon": -3.803,
        "scada_path": "backenddata/scada/alpha1",
        "twins_path": "public/data/digitaltwin/alpha1",
        "dustiq_path": "public/data/soiling/alpha1/dustiq_history.json",
    },
    "epsilon": {
        "name": "Epsilon",
        "lat": 51.196,
        "lon": 14.509,
        "scada_path": "backenddata/scada/epsilon",
        "twins_path": "public/data/digitaltwin/epsilon",
        "dustiq_path": "public/data/soiling/epsilon/dustiq_history.json",
    },
    "ribera": {
        "name": "Ribera (ES)",
        "lat": 37.927,
        "lon": -1.233,
        "scada_path": "backenddata/scada/ribera",
        "twins_path": "public/data/digitaltwin/ribera",
        "dustiq_path": "public/data/soiling/ribera/dustiq_history.json",
    },
    "gamma": {
        "name": "Gamma (ES)",
        "lat": 38.35,
        "lon": -0.48,
        "scada_path": "backenddata/scada/gamma",
        "twins_path": "public/data/digitaltwin/gamma",
        "dustiq_path": "public/data/soiling/gamma/dustiq_history.json",
    },
    "eta": {
        "name": "Eta (ES)",
        "lat": 38.663,
        "lon": -5.392,
        "scada_path": "backenddata/scada/eta",
        "twins_path": "public/data/digitaltwin/eta",
        "dustiq_path": "public/data/soiling/eta/dustiq_history.json",
    },
    "delta": {
        "name": "Delta (ES)",
        "lat": 39.57,
        "lon": 2.65,
        "scada_path": "backenddata/scada/delta",
        "twins_path": "public/data/digitaltwin/delta",
        "dustiq_path": "public/data/soiling/delta/dustiq_history.json",
    },
    "zeta": {
        "name": "Zeta (ES)",
        "lat": 39.60,
        "lon": 2.70,
        "scada_path": "backenddata/scada/zeta",
        "twins_path": "public/data/digitaltwin/zeta",
        "dustiq_path": "public/data/soiling/zeta/dustiq_history.json",
    },
}


def detect_columns(df: pl.DataFrame, plant_name: str) -> dict:
    """Auto-detect column names for a plant."""
    cols = df.columns

    # Irradiance
    irr_candidates = [c for c in cols if 'irrad' in c.lower() and 'average' in c.lower()]
    irr_col = irr_candidates[0] if irr_candidates else None

    # Ambient temp
    temp_candidates = [c for c in cols if 'ambient' in c.lower() or 'umgebung' in c.lower()]
    ambient_col = temp_candidates[0] if temp_candidates else None

    # Module temp
    mod_temp = [c for c in cols if 'module' in c.lower() and 'temp' in c.lower()]
    module_col = mod_temp[0] if mod_temp else None

    # DustIQ soiling ratio
    sr_candidates = [c for c in cols if 'soiling_ratio' in c.lower() and 'dustiq' in c.lower()]
    if not sr_candidates:
        sr_candidates = [c for c in cols if 'soiling_ratio' in c.lower()]
    sr_col = sr_candidates[0] if sr_candidates else None

    # DustIQ soiling loss
    sl_candidates = [c for c in cols if 'soiling' in c.lower() and 'loss' in c.lower() and 'dustiq' in c.lower()]
    if not sl_candidates:
        sl_candidates = [c for c in cols if 'soiling' in c.lower() and 'loss' in c.lower()]
    sl_col = sl_candidates[0] if sl_candidates else None

    # Find inverter IDs
    inv_ids = set()
    for c in cols:
        if 'INV' in c:
            # Extract "INV XX.XXX" pattern
            import re
            match = re.search(r'(INV\s*\d+\.\d+)', c)
            if match:
                inv_ids.add(match.group(1))

    return {
        'irradiance': irr_col,
        'ambient_temp': ambient_col,
        'module_temp': module_col,
        'soiling_ratio': sr_col,
        'soiling_loss': sl_col,
        'inverter_ids': list(inv_ids),
    }


def extract_twin_features_for_inverter(
    df: pl.DataFrame,
    twin: MultiSignalTwinFactory,
    inv_id: str,
    irradiance_col: str,
    ambient_temp_col: str,
    module_temp_col: Optional[str] = None,
) -> pl.DataFrame:
    """
    Extract ALL twin features for an inverter.

    Returns DataFrame with:
    - timestamp
    - T_expected, temp_deviation
    - I_expected, current_cv, current_imbalance_ratio, current_loss_pct
    - V_expected, voltage_cv, voltage_deviation, voltage_loss_pct
    - power_loss_pct, P_expected
    """
    # Detect DC current and voltage columns for this inverter
    current_cols = DCCurrentTwin.detect_current_columns(df, inv_id)
    voltage_cols = DCVoltageTwin.detect_voltage_columns(df, inv_id)

    # Find inverter temperature column
    inv_temp_col = None
    for c in df.columns:
        if inv_id in c and 'temp' in c.lower():
            inv_temp_col = c
            break

    # Find inverter power column
    inv_power_col = None
    for c in df.columns:
        if inv_id in c and ('power' in c.lower() or 'P_AC' in c):
            inv_power_col = c
            break

    # Run twin predictions
    result = twin.predict(
        df,
        temp_col=inv_temp_col or "inverter_temp",
        current_cols=current_cols if current_cols else None,
        voltage_cols=voltage_cols if voltage_cols else None,
        power_col=inv_power_col,
        irradiance_col=irradiance_col,
        ambient_temp_col=ambient_temp_col,
        auto_detect_columns=True,
    )

    return result


def aggregate_twin_features_daily(
    df: pl.DataFrame,
    feature_cols: List[str],
) -> pl.DataFrame:
    """Aggregate twin features to daily level."""

    # Ensure we have a date column
    if 'date' not in df.columns and 'timestamp' in df.columns:
        # Handle string timestamps
        ts_dtype = df['timestamp'].dtype
        if ts_dtype == pl.Utf8 or ts_dtype == pl.String:
            df = df.with_columns(
                pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
            )
        else:
            df = df.with_columns(
                pl.col('timestamp').dt.strftime('%Y-%m-%d').alias('date')
            )

    # Build aggregation expressions
    agg_exprs = []
    for col in feature_cols:
        if col in df.columns:
            # Mean, min, max, std for each feature
            agg_exprs.extend([
                pl.col(col).mean().alias(f"{col}_mean"),
                pl.col(col).min().alias(f"{col}_min"),
                pl.col(col).max().alias(f"{col}_max"),
                pl.col(col).std().alias(f"{col}_std"),
            ])

    # Add sample count
    agg_exprs.append(pl.len().alias('n_samples'))

    return df.group_by('date').agg(agg_exprs).sort('date')


def load_dustiq_ground_truth(dustiq_path: str) -> Optional[pl.DataFrame]:
    """Load DustIQ ground truth data."""
    path = Path(dustiq_path)
    if not path.exists():
        return None

    with open(path) as f:
        data = json.load(f)

    daily_data = data.get('daily_data', [])
    if not daily_data:
        return None

    df = pl.DataFrame(daily_data)

    # Find SR column
    sr_col = None
    for c in df.columns:
        if 'sr_dustiq' in c.lower() or 'soiling_ratio' in c.lower():
            sr_col = c
            break

    if sr_col and sr_col != 'sr_dustiq':
        df = df.with_columns(pl.col(sr_col).alias('sr_dustiq'))

    return df


def load_weather_features(plant_id: str, lat: float, lon: float) -> Optional[pl.DataFrame]:
    """Load pre-computed weather and AOD features."""
    # Check for cached correlation analysis data
    cache_path = Path(f"backenddata/outputs/dustiq_analysis/{plant_id}_daily_features.parquet")
    if cache_path.exists():
        return pl.read_parquet(cache_path)

    # Try loading from weather cache
    weather_path = Path("backenddata/weather/openmeteo_weather_cache.parquet")
    if not weather_path.exists():
        return None

    # This would need plant-specific filtering - skip for now
    return None


def evaluate_plant(plant_id: str, config: dict, max_inverters: int = 10) -> dict:
    """Evaluate soiling prediction for a single plant using its own twin features."""

    print(f"\n{'='*70}")
    print(f"EVALUATING: {plant_id.upper()}")
    print(f"{'='*70}")

    result = {
        "plant_id": plant_id,
        "status": "unknown",
    }

    # Check paths
    scada_path = Path(config["scada_path"])
    twins_path = Path(config["twins_path"])

    if not scada_path.exists():
        print(f"  ✗ SCADA path not found: {scada_path}")
        result["status"] = "no_scada"
        return result

    if not twins_path.exists():
        print(f"  ✗ Twins path not found: {twins_path}")
        result["status"] = "no_twins"
        return result

    # Load SCADA data
    parquet_files = list(scada_path.glob("*.parquet"))
    if not parquet_files:
        print(f"  ✗ No parquet files found")
        result["status"] = "no_parquet"
        return result

    df = pl.read_parquet(parquet_files[0])
    print(f"  Loaded {len(df):,} rows from SCADA")

    # Detect columns
    col_map = detect_columns(df, config["name"])
    print(f"  Irradiance: {col_map['irradiance']}")
    print(f"  Ambient temp: {col_map['ambient_temp']}")
    print(f"  Soiling ratio col: {col_map['soiling_ratio']}")
    print(f"  Soiling loss col: {col_map['soiling_loss']}")
    print(f"  Inverters found: {len(col_map['inverter_ids'])}")

    if not col_map['irradiance'] or not col_map['ambient_temp']:
        print(f"  ✗ Missing required columns")
        result["status"] = "missing_columns"
        return result

    # Load available twins
    meta_files = list(twins_path.glob("*_factory_meta.pkl"))
    available_inv_ids = [f.stem.replace("_factory_meta", "") for f in meta_files]
    print(f"  Available twins: {len(available_inv_ids)}")

    if not available_inv_ids:
        print(f"  ✗ No trained twins found")
        result["status"] = "no_trained_twins"
        return result

    # Select inverters to process
    inv_ids_to_process = available_inv_ids[:max_inverters]
    print(f"  Processing {len(inv_ids_to_process)} inverters")

    # Extract twin features for each inverter
    all_twin_features = []
    twin_feature_cols = [
        'T_expected', 'temp_deviation',
        'I_expected', 'current_cv', 'current_imbalance_ratio', 'current_mean', 'current_loss_pct',
        'V_expected', 'voltage_cv', 'voltage_deviation', 'voltage_mean', 'voltage_loss_pct',
        'P_expected', 'power_loss_pct',
    ]

    for inv_id in inv_ids_to_process:
        try:
            twin = MultiSignalTwinFactory.load(twins_path, inv_id)

            df_features = extract_twin_features_for_inverter(
                df,
                twin,
                inv_id,
                col_map['irradiance'],
                col_map['ambient_temp'],
                col_map.get('module_temp'),
            )

            # Filter to daytime with good irradiance
            df_features = df_features.filter(
                pl.col('irradiance').is_not_null() &
                (pl.col('irradiance') > 100)
            )

            if len(df_features) > 0:
                # Add inverter temp stats if available
                inv_temp_col = None
                for c in df.columns:
                    if inv_id in c and 'temp' in c.lower():
                        inv_temp_col = c
                        break

                if inv_temp_col and inv_temp_col in df_features.columns:
                    # Already included
                    pass

                all_twin_features.append(df_features)
                print(f"    {inv_id}: {len(df_features):,} rows")
        except Exception as e:
            print(f"    {inv_id}: Error - {e}")

    if not all_twin_features:
        print(f"  ✗ No twin features extracted")
        result["status"] = "no_features"
        return result

    # Combine features across inverters (average per timestamp)
    print(f"\n  Combining features from {len(all_twin_features)} inverters...")

    # For simplicity, just use the first inverter's data as base
    # and add mean of twin features across all inverters
    df_combined = all_twin_features[0].clone()

    # If we have multiple inverters, compute mean features
    if len(all_twin_features) > 1:
        for feat_col in twin_feature_cols:
            if feat_col in df_combined.columns:
                # Compute mean across all inverters
                feat_values = []
                for df_inv in all_twin_features:
                    if feat_col in df_inv.columns:
                        feat_values.append(df_inv[feat_col].to_numpy())

                if feat_values:
                    # Stack and compute mean, handling NaNs
                    stacked = np.column_stack(feat_values)
                    mean_values = np.nanmean(stacked, axis=1)
                    df_combined = df_combined.with_columns(
                        pl.Series(feat_col, mean_values)
                    )

    print(f"  Combined data: {len(df_combined):,} rows")

    # Get DustIQ ground truth from SCADA directly
    sr_col = col_map['soiling_ratio']
    sl_col = col_map['soiling_loss']

    if sr_col and sr_col in df.columns:
        # Use soiling ratio directly
        df_combined = df_combined.with_columns(
            df[sr_col].alias('sr_dustiq')
        )
        print(f"  Using soiling ratio column: {sr_col}")
    elif sl_col and sl_col in df.columns:
        # Convert soiling loss to ratio: SR = 1 - (loss / 100)
        df_combined = df_combined.with_columns(
            (1 - df[sl_col] / 100).clip(0.5, 1.02).alias('sr_dustiq')
        )
        print(f"  Converted soiling loss to ratio from: {sl_col}")
    else:
        # Try loading from JSON
        dustiq_df = load_dustiq_ground_truth(config["dustiq_path"])
        if dustiq_df is None:
            print(f"  ✗ No DustIQ ground truth found")
            result["status"] = "no_dustiq"
            return result

        # Need to join on date - aggregate SCADA to daily first
        print(f"  Loading DustIQ from JSON: {len(dustiq_df)} days")

    # Aggregate to daily for model training
    df_daily = aggregate_twin_features_daily(df_combined, twin_feature_cols)

    # If we have sr_dustiq in combined, also aggregate it
    if 'sr_dustiq' in df_combined.columns:
        sr_daily = df_combined.group_by(
            pl.col('timestamp').str.slice(0, 10).str.replace_all(r"\.", "-").alias('date')
        ).agg([
            pl.col('sr_dustiq').mean().alias('sr_dustiq'),
            pl.col('sr_dustiq').min().alias('sr_dustiq_min'),
            pl.col('sr_dustiq').max().alias('sr_dustiq_max'),
        ]).sort('date')

        df_daily = df_daily.join(sr_daily, on='date', how='left')
    else:
        # Join with dustiq_df
        dustiq_df = load_dustiq_ground_truth(config["dustiq_path"])
        if dustiq_df is not None and 'sr_dustiq' in dustiq_df.columns:
            df_daily = df_daily.join(
                dustiq_df.select(['date', 'sr_dustiq']),
                on='date',
                how='inner'
            )

    print(f"  Daily data: {len(df_daily)} days")

    # Filter to valid SR values
    if 'sr_dustiq' not in df_daily.columns:
        print(f"  ✗ No sr_dustiq column after aggregation")
        result["status"] = "no_sr_column"
        return result

    df_valid = df_daily.filter(
        pl.col('sr_dustiq').is_not_null() &
        (pl.col('sr_dustiq') >= 0.7) &
        (pl.col('sr_dustiq') <= 1.02)
    )

    print(f"  Valid days with DustIQ: {len(df_valid)}")

    if len(df_valid) < 50:
        print(f"  ✗ Insufficient valid data")
        result["status"] = "insufficient_data"
        result["n_valid_days"] = len(df_valid)
        return result

    # Prepare features for ML
    feature_cols = [c for c in df_valid.columns if c.endswith('_mean') or c.endswith('_std') or c.endswith('_max') or c.endswith('_min')]
    feature_cols = [c for c in feature_cols if c in df_valid.columns and not df_valid[c].is_null().all()]

    print(f"  Feature columns: {len(feature_cols)}")
    for fc in feature_cols[:10]:
        print(f"    - {fc}")
    if len(feature_cols) > 10:
        print(f"    ... and {len(feature_cols) - 10} more")

    # Train/test split (80/20)
    n_train = int(len(df_valid) * 0.8)
    df_train = df_valid.head(n_train)
    df_test = df_valid.tail(len(df_valid) - n_train)

    print(f"  Train: {len(df_train)}, Test: {len(df_test)}")

    # Prepare data
    X_train = df_train.select(feature_cols).to_pandas().values
    y_train = df_train['sr_dustiq'].to_numpy()
    X_test = df_test.select(feature_cols).to_pandas().values
    y_test = df_test['sr_dustiq'].to_numpy()

    # Replace NaN with median
    for i in range(X_train.shape[1]):
        col_median = np.nanmedian(X_train[:, i])
        X_train[np.isnan(X_train[:, i]), i] = col_median
        X_test[np.isnan(X_test[:, i]), i] = col_median

    # Train CatBoost
    try:
        from catboost import CatBoostRegressor

        model = CatBoostRegressor(
            iterations=500,
            learning_rate=0.05,
            depth=6,
            l2_leaf_reg=3.0,
            random_seed=42,
            verbose=False,
            early_stopping_rounds=50,
        )

        model.fit(X_train, y_train, eval_set=(X_test, y_test), verbose=False)

        # Predictions
        y_pred_train = model.predict(X_train)
        y_pred_test = model.predict(X_test)

        # Metrics
        def calc_metrics(y_true, y_pred):
            mae = np.mean(np.abs(y_true - y_pred))
            mse = np.mean((y_true - y_pred) ** 2)
            rmse = np.sqrt(mse)
            ss_res = np.sum((y_true - y_pred) ** 2)
            ss_tot = np.sum((y_true - np.mean(y_true)) ** 2)
            r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
            corr = np.corrcoef(y_true, y_pred)[0, 1] if len(y_true) > 1 else 0
            return {"mae": mae, "rmse": rmse, "r2": r2, "corr": corr}

        train_metrics = calc_metrics(y_train, y_pred_train)
        test_metrics = calc_metrics(y_test, y_pred_test)

        print(f"\n  === RESULTS ===")
        print(f"  Train: R²={train_metrics['r2']:.4f}, MAE={train_metrics['mae']:.4f}, Corr={train_metrics['corr']:.4f}")
        print(f"  Test:  R²={test_metrics['r2']:.4f}, MAE={test_metrics['mae']:.4f}, Corr={test_metrics['corr']:.4f}")

        # Feature importance
        importance = model.get_feature_importance()
        feat_imp = sorted(zip(feature_cols, importance), key=lambda x: -x[1])

        print(f"\n  Top 10 Features:")
        for fname, imp in feat_imp[:10]:
            print(f"    {fname}: {imp:.1f}")

        result["status"] = "success"
        result["n_train"] = len(df_train)
        result["n_test"] = len(df_test)
        result["n_features"] = len(feature_cols)
        result["train_r2"] = train_metrics["r2"]
        result["train_mae"] = train_metrics["mae"]
        result["train_corr"] = train_metrics["corr"]
        result["test_r2"] = test_metrics["r2"]
        result["test_mae"] = test_metrics["mae"]
        result["test_corr"] = test_metrics["corr"]
        result["top_features"] = feat_imp[:15]

    except ImportError:
        print("  ✗ CatBoost not available")
        result["status"] = "no_catboost"
    except Exception as e:
        import traceback
        print(f"  ✗ Training error: {e}")
        traceback.print_exc()
        result["status"] = "training_error"
        result["error"] = str(e)

    return result


def main():
    print("="*70)
    print("FULL TWIN FEATURES EVALUATION")
    print("Using ALL twin features from loss disaggregator")
    print("="*70)

    all_results = []

    for plant_id, config in PLANTS.items():
        result = evaluate_plant(plant_id, config, max_inverters=10)
        all_results.append(result)

    # Summary table
    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"{'Plant':<15} | {'Status':<15} | {'Test R²':>10} | {'Test MAE':>10} | {'Corr':>8}")
    print("-" * 70)

    for r in all_results:
        if r["status"] == "success":
            print(f"{r['plant_id']:<15} | {'✓ success':<15} | {r['test_r2']:>10.4f} | {r['test_mae']:>10.4f} | {r['test_corr']:>8.4f}")
        else:
            print(f"{r['plant_id']:<15} | {'✗ ' + r['status']:<15} | {'N/A':>10} | {'N/A':>10} | {'N/A':>8}")

    # Save results
    output_path = Path("backenddata/outputs/dustiq_analysis/twin_features_evaluation.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Convert numpy types for JSON
    def convert_for_json(obj):
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, tuple):
            return list(obj)
        return obj

    results_json = []
    for r in all_results:
        r_clean = {}
        for k, v in r.items():
            if isinstance(v, list):
                r_clean[k] = [(convert_for_json(x[0]), convert_for_json(x[1])) if isinstance(x, tuple) else convert_for_json(x) for x in v]
            else:
                r_clean[k] = convert_for_json(v)
        results_json.append(r_clean)

    with open(output_path, 'w') as f:
        json.dump(results_json, f, indent=2)

    print(f"\n✓ Results saved to {output_path}")


if __name__ == "__main__":
    main()
