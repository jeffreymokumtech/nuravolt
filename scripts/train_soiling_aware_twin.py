#!/usr/bin/env python3
"""
Train soiling-aware hybrid twin models on daily data.

Key difference from standard hybrid models:
- Uses daily aggregated data (not sub-daily)
- Includes rain/AOD features so ML learns soiling patterns
- Δ_ML should then correlate with soiling ratio

Usage:
    python scripts/train_soiling_aware_twin.py --plant epsilon
"""

import argparse
import json
import pickle
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from catboost import CatBoostRegressor, Pool
from sklearn.model_selection import train_test_split
from scipy.stats import spearmanr


def find_column(df: pd.DataFrame, patterns: list) -> Optional[str]:
    """Find a column matching any of the patterns (case-insensitive)."""
    for pattern in patterns:
        pattern_lower = pattern.lower()
        for col in df.columns:
            if pattern_lower in col.lower():
                return col
    return None


def load_daily_scada(plant_id: str) -> Optional[Tuple[pd.DataFrame, Optional[pd.Series], Optional[pd.Series]]]:
    """Load daily aggregated SCADA data with rain and DustIQ if available.

    Returns (df_daily, rain_series, dustiq_series)
    """
    # Try multiple naming conventions
    possible_paths = [
        Path(f"backenddata/scada/{plant_id}/cleaned_daily.parquet"),
        Path(f"backenddata/scada/{plant_id}/{plant_id}_cleaned.parquet"),
        Path(f"backenddata/scada/{plant_id}/plant_cleaned.parquet"),
    ]

    scada_path = None
    for path in possible_paths:
        if path.exists():
            scada_path = path
            break

    if scada_path is None:
        print(f"No SCADA found for {plant_id}")
        return None

    df = pd.read_parquet(scada_path)
    print(f"  Raw SCADA: {len(df)} rows, {len(df.columns)} columns")

    # Find power column
    power_col = find_column(df, [
        'Power by Inverter',
        'Power by Janitza',
        'P_AC',
        'power',
        'Plant / Power',
    ])

    # Find irradiance column
    irr_col = find_column(df, [
        'Irradiation_average',
        'Radiation 1',
        'irradiance',
        'GHI',
        'POA',
    ])

    # Find temperature column
    temp_col = find_column(df, [
        'Module',
        'Ambient',
        'temperature',
        'Temp',
    ])

    # Find rain column (embedded in SCADA)
    rain_col = find_column(df, [
        'Wetter_Regen',
        'Rain',
        'precipitation',
    ])

    # Find DustIQ column
    dustiq_col = find_column(df, [
        'soiling_ratio_Sensor01',
        'soiling_ratio_Sensor02',
        'Soiling Loss',
    ])

    if power_col is None or irr_col is None:
        print(f"  Could not find power or irradiance columns")
        print(f"  Available columns: {[c for c in df.columns if 'ower' in c.lower() or 'rrad' in c.lower()][:10]}")
        return None

    print(f"  Power column: {power_col}")
    print(f"  Irradiance column: {irr_col}")
    print(f"  Temperature column: {temp_col}")
    print(f"  Rain column: {rain_col}")
    print(f"  DustIQ column: {dustiq_col}")

    # Ensure datetime index
    if 'timestamp' in df.columns:
        df['timestamp'] = pd.to_datetime(df['timestamp'], format='mixed', errors='coerce')
        df = df.set_index('timestamp')
    elif 'date' in df.columns:
        df['date'] = pd.to_datetime(df['date'], format='mixed', errors='coerce')
        df = df.set_index('date')

    df.index = pd.to_datetime(df.index, format='mixed', errors='coerce')
    df = df[df.index.notna()]

    # Build daily aggregation dict
    agg_dict = {
        power_col: 'mean',
        irr_col: 'mean',
    }
    if temp_col:
        agg_dict[temp_col] = 'mean'

    # Aggregate to daily
    df_daily = df.resample('D').agg(agg_dict)

    # Rename to standard names
    rename_map = {
        power_col: 'power',
        irr_col: 'irradiance',
    }
    if temp_col:
        rename_map[temp_col] = 'temperature'

    df_daily = df_daily.rename(columns=rename_map)

    # Filter for good data (irradiance > 100 to avoid night)
    df_daily = df_daily[df_daily['irradiance'] > 100].dropna(subset=['power', 'irradiance'])

    # Extract rain if available
    rain_series = None
    if rain_col:
        rain_daily = df.resample('D')[rain_col].sum()
        rain_series = rain_daily.reindex(df_daily.index).fillna(0)
        print(f"  Rain data: mean={rain_series.mean():.1f}mm, max={rain_series.max():.1f}mm")

    # Extract DustIQ if available
    dustiq_series = None
    if dustiq_col:
        dustiq_daily = df.resample('D')[dustiq_col].mean()
        dustiq_series = dustiq_daily.reindex(df_daily.index)
        # Normalize to 0-1 range if in percent
        if dustiq_series.mean() > 2:
            dustiq_series = dustiq_series / 100
        # Filter valid range
        dustiq_series = dustiq_series[(dustiq_series >= 0.5) & (dustiq_series <= 1.05)]
        print(f"  DustIQ: {len(dustiq_series)} valid days, mean={dustiq_series.mean():.3f}")

    print(f"  Daily SCADA: {len(df_daily)} records")
    return df_daily, rain_series, dustiq_series


def load_rain_data(plant_id: str) -> Optional[pd.Series]:
    """Load rainfall data."""
    paths = [
        Path(f"public/data/soiling/{plant_id}/weather_extended.json"),
        Path(f"public/data/soiling/{plant_id}/rain_history.json"),
    ]

    for path in paths:
        if path.exists():
            try:
                with open(path, 'r') as f:
                    data = json.load(f)

                # Handle different formats
                if 'daily_data' in data:
                    df = pd.DataFrame(data['daily_data'])
                else:
                    df = pd.DataFrame(data)

                df['date'] = pd.to_datetime(df['date'])
                df = df.set_index('date')

                for col in ['precipitation_mm', 'precipitation', 'rain_mm']:
                    if col in df.columns:
                        rain = df[col].fillna(0)
                        print(f"  Loaded rain: {len(rain)} days, mean={rain.mean():.1f}mm")
                        return rain
            except Exception as e:
                continue

    print(f"  No rain data found")
    return None


def load_aod_data(plant_id: str) -> Optional[pd.DataFrame]:
    """Load AOD/dust data."""
    paths = [
        Path(f"public/data/soiling/{plant_id}/cams_aod_history.json"),
        Path(f"public/data/soiling/{plant_id}/aod_history.json"),
    ]

    for path in paths:
        if path.exists():
            try:
                with open(path, 'r') as f:
                    data = json.load(f)

                if 'daily_data' in data:
                    df = pd.DataFrame(data['daily_data'])
                else:
                    df = pd.DataFrame(data)

                df['date'] = pd.to_datetime(df['date'])
                df = df.set_index('date')

                # Find AOD columns
                aod_cols = [c for c in df.columns if 'aod' in c.lower() or 'dust' in c.lower()]
                if aod_cols:
                    print(f"  Loaded AOD: {len(df)} days, cols={aod_cols[:3]}")
                    return df[aod_cols]
            except Exception as e:
                continue

    print(f"  No AOD data found")
    return None


def load_dustiq(plant_id: str) -> Optional[pd.Series]:
    """Load DustIQ ground truth."""
    path = Path(f"public/data/soiling/{plant_id}/dustiq_daily.csv")
    if not path.exists():
        print(f"  No DustIQ data found")
        return None

    df = pd.read_csv(path)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date')

    if 'sr_dustiq' in df.columns:
        sr = df['sr_dustiq'] / 100 if df['sr_dustiq'].max() > 2 else df['sr_dustiq']
        sr = sr[(sr >= 0.5) & (sr <= 1.05)]
        print(f"  Loaded DustIQ: {len(sr)} days, mean={sr.mean():.3f}")
        return sr

    return None


def create_features(
    df_scada: pd.DataFrame,
    rain: Optional[pd.Series],
    aod: Optional[pd.DataFrame],
) -> pd.DataFrame:
    """Create feature matrix with soiling-relevant features."""

    features = pd.DataFrame(index=df_scada.index)

    # Base features
    features['irradiance'] = df_scada['irradiance']
    if 'temperature' in df_scada.columns:
        features['temperature'] = df_scada['temperature']

    # Temporal features
    features['day_of_year'] = features.index.dayofyear
    features['day_of_year_sin'] = np.sin(2 * np.pi * features['day_of_year'] / 365)
    features['day_of_year_cos'] = np.cos(2 * np.pi * features['day_of_year'] / 365)
    features['month'] = features.index.month

    # Rain features (KEY for soiling)
    if rain is not None:
        rain_aligned = rain.reindex(features.index).fillna(0)
        features['rainfall'] = rain_aligned
        features['rainfall_7d'] = rain_aligned.rolling(7, min_periods=1).sum()
        features['rainfall_14d'] = rain_aligned.rolling(14, min_periods=1).sum()
        features['is_rain_day'] = (rain_aligned >= 1.0).astype(float)

        # Days since significant rain
        is_sig_rain = rain_aligned >= 5.0
        days_since = pd.Series(0, index=features.index)
        last_rain = 0
        for i, (idx, is_rain) in enumerate(is_sig_rain.items()):
            if is_rain:
                last_rain = i
            days_since.loc[idx] = i - last_rain
        features['days_since_rain'] = days_since.clip(0, 60)  # Cap at 60 days

    # AOD features (KEY for soiling)
    if aod is not None:
        aod_aligned = aod.reindex(features.index)
        for col in aod_aligned.columns[:3]:  # Top 3 AOD columns
            features[col] = aod_aligned[col].fillna(aod_aligned[col].median())
            features[f'{col}_7d'] = features[col].rolling(7, min_periods=1).mean()

    # Clean up
    features = features.replace([np.inf, -np.inf], np.nan)
    features = features.fillna(method='ffill').fillna(method='bfill').fillna(0)

    return features


def train_soiling_aware_model(
    X: pd.DataFrame,
    y: pd.Series,
    feature_names: list,
) -> Tuple[CatBoostRegressor, Dict]:
    """Train CatBoost model to predict power from features."""

    # Train/test split
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=42, shuffle=True
    )

    model = CatBoostRegressor(
        iterations=500,
        depth=5,
        learning_rate=0.05,
        l2_leaf_reg=5.0,
        random_seed=42,
        early_stopping_rounds=50,
        verbose=False,
    )

    train_pool = Pool(X_train, y_train)
    val_pool = Pool(X_val, y_val)

    model.fit(train_pool, eval_set=val_pool, use_best_model=True)

    # Metrics
    y_pred_val = model.predict(X_val)
    mae = np.mean(np.abs(y_pred_val - y_val))
    rmse = np.sqrt(np.mean((y_pred_val - y_val) ** 2))

    # Feature importance
    importance = model.get_feature_importance()
    feat_imp = dict(zip(feature_names, importance))

    metrics = {
        'mae': mae,
        'rmse': rmse,
        'n_train': len(X_train),
        'n_val': len(X_val),
        'iterations': model.best_iteration_,
        'feature_importance': feat_imp,
    }

    return model, metrics


def calculate_physics_baseline(df_scada: pd.DataFrame) -> pd.Series:
    """Simple physics baseline: power proportional to irradiance."""
    irr = df_scada['irradiance']

    # Use 95th percentile power/irr ratio as capacity factor
    valid_mask = irr > 100
    if valid_mask.sum() > 100:
        power_per_irr = df_scada.loc[valid_mask, 'power'] / irr[valid_mask]
        capacity_factor = power_per_irr.quantile(0.95)
    else:
        capacity_factor = df_scada['power'].max() / irr.max()

    p_physics = irr * capacity_factor
    return p_physics.clip(lower=0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plant', default='epsilon', help='Plant ID')
    parser.add_argument('--save', action='store_true', help='Save model')
    args = parser.parse_args()

    plant_id = args.plant
    print(f"\n{'='*60}")
    print(f"Training Soiling-Aware Twin: {plant_id.upper()}")
    print(f"{'='*60}")

    # Load data (now returns tuple with embedded rain/dustiq)
    result = load_daily_scada(plant_id)
    if result is None:
        return

    df_scada, scada_rain, scada_dustiq = result

    # Try external rain data first, fall back to embedded
    rain = load_rain_data(plant_id)
    if rain is None and scada_rain is not None:
        rain = scada_rain
        print("  Using embedded rain data from SCADA")

    aod = load_aod_data(plant_id)

    # Try external DustIQ first, fall back to embedded
    sr_dustiq = load_dustiq(plant_id)
    if sr_dustiq is None and scada_dustiq is not None:
        sr_dustiq = scada_dustiq
        print("  Using embedded DustIQ data from SCADA")

    # Create features
    print("\nCreating features...")
    features = create_features(df_scada, rain, aod)
    print(f"  Feature columns ({len(features.columns)}): {list(features.columns)}")

    # Align target (power)
    common_idx = features.index.intersection(df_scada.index)
    X = features.loc[common_idx]
    y = df_scada.loc[common_idx, 'power']

    # Remove NaN
    valid_mask = ~(X.isna().any(axis=1) | y.isna())
    X = X[valid_mask]
    y = y[valid_mask]

    print(f"  Training samples: {len(X)}")

    # Train model
    print("\nTraining model...")
    model, metrics = train_soiling_aware_model(X, y, list(X.columns))

    print(f"  MAE: {metrics['mae']:.2f} kW")
    print(f"  RMSE: {metrics['rmse']:.2f} kW")
    print(f"  Iterations: {metrics['iterations']}")

    print("\n  Top features:")
    sorted_imp = sorted(metrics['feature_importance'].items(), key=lambda x: -x[1])
    for name, imp in sorted_imp[:10]:
        print(f"    {name}: {imp:.1f}")

    # Calculate Δ_ML and check correlation with SR
    print("\nAnalyzing Δ_ML correlation with soiling...")

    # Physics baseline
    p_physics = calculate_physics_baseline(df_scada)

    # ML prediction (hybrid)
    p_hybrid = model.predict(X)

    # Δ_ML = what ML learned beyond physics
    # Here: Δ_ML = P_actual - P_physics (what ML predicts minus simple physics)
    # Actually P_hybrid already IS the hybrid prediction
    # So Δ_ML = P_hybrid - P_physics

    p_physics_aligned = p_physics.reindex(X.index)
    delta_ml = p_hybrid - p_physics_aligned.values

    # Convert to loss percentage
    loss_ml_pct = -delta_ml / p_physics_aligned.values.clip(min=1) * 100

    # Check correlation with DustIQ
    if sr_dustiq is not None:
        sr_aligned = sr_dustiq.reindex(X.index)
        valid_sr = sr_aligned.notna()

        if valid_sr.sum() > 50:
            corr, pval = spearmanr(
                loss_ml_pct[valid_sr],
                sr_aligned[valid_sr]
            )
            print(f"  Δ_ML vs SR correlation: ρ={corr:.3f} (p={pval:.4f})")

            # Also check raw delta
            corr2, _ = spearmanr(delta_ml[valid_sr], sr_aligned[valid_sr])
            print(f"  Raw Δ_ML vs SR: ρ={corr2:.3f}")

            # Check days_since_rain importance
            if 'days_since_rain' in metrics['feature_importance']:
                print(f"\n  days_since_rain importance: {metrics['feature_importance']['days_since_rain']:.1f}")

            # Check rain feature correlations
            if rain is not None:
                rain_aligned = rain.reindex(X.index).fillna(0)[valid_sr]
                corr_rain, _ = spearmanr(rain_aligned, sr_aligned[valid_sr])
                print(f"  Rainfall vs SR: ρ={corr_rain:.3f}")

    # Create daily output dataframe
    daily_output = pd.DataFrame({
        'date': X.index,
        'p_actual': y.values,
        'p_physics': p_physics_aligned.values,
        'p_hybrid': p_hybrid,
        'delta_ml': delta_ml,
        'irradiance': X['irradiance'].values,
    })
    daily_output = daily_output.set_index('date')

    # Add SR if available
    if sr_dustiq is not None:
        daily_output['sr_dustiq'] = sr_dustiq.reindex(daily_output.index)

    # Add rain features if available
    if rain is not None:
        rain_aligned = rain.reindex(daily_output.index).fillna(0)
        daily_output['rainfall'] = rain_aligned
        if 'days_since_rain' in X.columns:
            daily_output['days_since_rain'] = X['days_since_rain'].values

    # Save daily output
    out_dir = Path(f"backenddata/models/soiling_aware_twin")
    out_dir.mkdir(parents=True, exist_ok=True)

    daily_path = out_dir / f"{plant_id}_daily_hybrid.parquet"
    daily_output.to_parquet(daily_path)
    print(f"\n  Daily hybrid power saved to: {daily_path}")
    print(f"  Columns: {list(daily_output.columns)}")
    print(f"  Records: {len(daily_output)}")

    # Also save as CSV for easy inspection
    csv_path = out_dir / f"{plant_id}_daily_hybrid.csv"
    daily_output.to_csv(csv_path)
    print(f"  CSV: {csv_path}")

    # Save model
    if args.save:
        out_path = out_dir / f"{plant_id}_soiling_aware.pkl"
        with open(out_path, 'wb') as f:
            pickle.dump({
                'model': model,
                'feature_names': list(X.columns),
                'metrics': metrics,
                'plant_id': plant_id,
            }, f)
        print(f"\n  Model saved to: {out_path}")


if __name__ == '__main__':
    main()
