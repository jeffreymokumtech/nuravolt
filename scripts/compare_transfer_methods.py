"""
Transfer Learning Method Comparison

Compares direct training vs two-stage transfer learning for soiling ratio forecasting.

Scenarios:
1. Direct Training: Train on Ribera 2020-2022 WITHOUT PR, test on 2023-2025
2. Two-Stage Transfer: Stage 1 with PR → pseudo-labels, Stage 2 without PR

Both tested on same Ribera 2023-2025 test set for fair comparison.

Usage:
    python scripts/compare_transfer_methods.py

Output:
    - outputs_transfer_comparison/comparison_report.json
    - outputs_transfer_comparison/comparison_report.md
    - outputs_transfer_comparison/direct_training/
    - outputs_transfer_comparison/two_stage_transfer/
    - outputs_transfer_comparison/plots/
"""

import sys
import json
import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime
from typing import Dict, Tuple
import warnings
warnings.filterwarnings('ignore')

# Add parent directory to path
sys.path.append(str(Path(__file__).parent.parent))

from catboost import CatBoostRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation
from scripts.utils.statistical_tests import compare_models, test_summary_string
from scripts.utils.visualization import plot_comparison_summary


def load_ribera_data(data_dir: Path) -> pd.DataFrame:
    """Load Ribera data with DustIQ, rain, AOD, and per-inverter PR."""
    print("\n📂 Loading Ribera data...")

    # Load DustIQ
    with open(data_dir / "dustiq_history.json", 'r') as f:
        dustiq_data = json.load(f)
    df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
    df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])
    df_dustiq = df_dustiq.rename(columns={'soiling_ratio': 'sr_dustiq'})

    # Load per-inverter PR data
    with open(data_dir / "time_series" / "daily_pr.json", 'r') as f:
        pr_data_full = json.load(f)
    df_pr = pd.DataFrame(pr_data_full['data'])
    df_pr['date'] = pd.to_datetime(df_pr['date'])
    df_pr = df_pr.rename(columns={'inverterId': 'inverter_id'})

    # Load rain
    with open(data_dir / "rain_history.json", 'r') as f:
        rain_data = json.load(f)
    df_rain = pd.DataFrame(rain_data['daily_data'])
    df_rain['date'] = pd.to_datetime(df_rain['date'])

    # Load AOD
    with open(data_dir / "aod_merged.json", 'r') as f:
        aod_data = json.load(f)
    df_aod = pd.DataFrame(aod_data['daily_data'])
    df_aod['date'] = pd.to_datetime(df_aod['date'])
    df_aod = df_aod.rename(columns={'aod_550nm': 'aod_550'})

    # Merge
    df = df_pr.merge(df_dustiq[['date', 'sr_dustiq']], on='date', how='inner')
    df = df.merge(df_rain[['date', 'precipitation_mm']], on='date', how='left')
    df = df.merge(df_aod[['date', 'aod_550']], on='date', how='left')

    df['precipitation_mm'] = df['precipitation_mm'].fillna(0)
    df['aod_550'] = df['aod_550'].fillna(df['aod_550'].median())

    # Filter valid range
    df = df[(df['sr_dustiq'] >= 0.75) & (df['sr_dustiq'] <= 1.0)].copy()

    print(f"  ✅ Loaded: {len(df)} samples, {len(df['date'].unique())} days")
    print(f"  Date range: {df['date'].min().date()} to {df['date'].max().date()}")

    return df


def scenario_direct_training(
    df: pd.DataFrame,
    location: PlantLocation,
    split_date: str = '2023-01-01',
    output_dir: Path = Path("outputs_transfer_comparison/direct_training")
) -> Tuple[np.ndarray, np.ndarray, Dict[str, any]]:
    """
    Scenario 1: Direct training WITHOUT PR.

    Train: Ribera 2020-2022 (no PR features)
    Test: Ribera 2023-2025
    Features: 38 forecastable (rain, AOD, temporal, spatial)

    Returns:
        (y_true, y_pred, results_dict)
    """
    print("\n" + "="*80)
    print("SCENARIO 1: DIRECT TRAINING (Baseline)")
    print("="*80)

    output_dir.mkdir(parents=True, exist_ok=True)

    split_date = pd.to_datetime(split_date)
    df_train = df[df['date'] < split_date].copy()
    df_test = df[df['date'] >= split_date].copy()

    print(f"\nTrain: {df_train['date'].min().date()} to {df_train['date'].max().date()}")
    print(f"  Days: {len(df_train['date'].unique())}, Samples: {len(df_train)}")
    print(f"Test: {df_test['date'].min().date()} to {df_test['date'].max().date()}")
    print(f"  Days: {len(df_test['date'].unique())}, Samples: {len(df_test)}")

    # Generate features WITHOUT PR
    print("\n🔧 Generating features (no PR)...")
    engineer = SoilingRatioFeatureEngineer(location)

    # TRAIN features
    df_weather_train = df_train[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')
    df_aod_train = df_train[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod_train = df_aod_train.rename(columns={'aod_550': 'aod_550nm'})

    X_plant_train = engineer.generate_features(
        df_weather=df_weather_train,
        df_aod=df_aod_train,
        df_pr=None  # No PR!
    )

    # Merge to per-inverter
    X_plant_train = X_plant_train.reset_index()
    df_train_merged = df_train.merge(X_plant_train, on='date', how='left')

    # Add inverter_id from original data
    df_train_merged['inverter_id_raw'] = df_train['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_train_merged = df_train_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_train_merged['inverter_id'] = df_train_merged['inverter_id_raw'].astype(str)
    df_train_merged = df_train_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_train_merged = df_train_merged[df_train_merged['inverter_id'] != 'nan']
    df_train_merged = df_train_merged[df_train_merged['inverter_id'] != '']

    # Fill NaN values in features
    for col in df_train_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id']:
            if df_train_merged[col].dtype in ['float64', 'int64']:
                df_train_merged[col] = df_train_merged[col].fillna(df_train_merged[col].median())
            else:
                df_train_merged[col] = df_train_merged[col].fillna(df_train_merged[col].mode()[0] if len(df_train_merged[col].mode()) > 0 else 'UNKNOWN')

    # Spatial features
    inv_parts = df_train_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_train_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_train_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    feature_cols = [col for col in df_train_merged.columns
                   if col not in ['date', 'sr_dustiq', 'inverter_id']]
    X_train = df_train_merged[feature_cols + ['inverter_id']]
    y_train = df_train_merged['sr_dustiq']

    # TEST features (reuse same engineer for consistency)
    df_weather_test = df_test[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')
    df_aod_test = df_test[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod_test = df_aod_test.rename(columns={'aod_550': 'aod_550nm'})

    X_plant_test = engineer.generate_features(
        df_weather=df_weather_test,
        df_aod=df_aod_test,
        df_pr=None
    )

    # Merge to per-inverter
    X_plant_test = X_plant_test.reset_index()
    df_test_merged = df_test.merge(X_plant_test, on='date', how='left')

    # Add inverter_id from original data
    df_test_merged['inverter_id_raw'] = df_test['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_test_merged = df_test_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_test_merged['inverter_id'] = df_test_merged['inverter_id_raw'].astype(str)
    df_test_merged = df_test_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_test_merged = df_test_merged[df_test_merged['inverter_id'] != 'nan']
    df_test_merged = df_test_merged[df_test_merged['inverter_id'] != '']

    # Fill NaN values in features
    for col in df_test_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id']:
            if df_test_merged[col].dtype in ['float64', 'int64']:
                df_test_merged[col] = df_test_merged[col].fillna(df_test_merged[col].median())
            else:
                df_test_merged[col] = df_test_merged[col].fillna(df_test_merged[col].mode()[0] if len(df_test_merged[col].mode()) > 0 else 'UNKNOWN')

    # Spatial features
    inv_parts = df_test_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_test_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_test_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    X_test = df_test_merged[feature_cols + ['inverter_id']]
    y_test = df_test_merged['sr_dustiq']

    feature_names = feature_cols
    print(f"  Features: {len(feature_names)}")
    print(f"  Train samples: {len(X_train)}")
    print(f"  Test samples: {len(X_test)}")

    # Train model
    print("\n🚀 Training CatBoost model...")
    model = CatBoostRegressor(
        iterations=2000,
        learning_rate=0.02,
        depth=8,
        l2_leaf_reg=3.0,
        loss_function='Quantile:alpha=0.4',
        random_seed=42,
        cat_features=['inverter_id'] if 'inverter_id' in X_train.columns else None,
        verbose=100
    )

    model.fit(X_train, y_train)

    # Predict
    print("\n📊 Evaluating...")
    y_pred_train = model.predict(X_train)
    y_pred_test = model.predict(X_test)

    # Metrics
    train_mae = mean_absolute_error(y_train, y_pred_train)
    test_mae = mean_absolute_error(y_test, y_pred_test)
    test_r2 = r2_score(y_test, y_pred_test)

    print(f"\n✅ Results:")
    print(f"  Train MAE: {train_mae:.4f} ({train_mae*100:.2f}%)")
    print(f"  Test MAE: {test_mae:.4f} ({test_mae*100:.2f}%)")
    print(f"  Test R²: {test_r2:.4f}")

    # Save results
    results = {
        'method': 'direct_training',
        'train_mae': float(train_mae),
        'test_mae': float(test_mae),
        'test_r2': float(test_r2),
        'n_features': len(feature_names),
        'train_samples': len(X_train),
        'test_samples': len(X_test)
    }

    with open(output_dir / "metrics.json", 'w') as f:
        json.dump(results, f, indent=2)

    # Save predictions (use cleaned merged dataframe, not original df_test)
    pred_df = df_test_merged[['date', 'inverter_id', 'sr_dustiq']].copy()
    pred_df['sr_pred'] = y_pred_test
    pred_df.to_csv(output_dir / "predictions.csv", index=False)

    # Save model
    model.save_model(str(output_dir / "model.pkl"))

    print(f"\n💾 Saved to: {output_dir}/")

    return y_test, y_pred_test, results


def scenario_two_stage_transfer(
    df: pd.DataFrame,
    location: PlantLocation,
    split_date: str = '2023-01-01',
    output_dir: Path = Path("outputs_transfer_comparison/two_stage_transfer")
) -> Tuple[np.ndarray, np.ndarray, Dict[str, any]]:
    """
    Scenario 2: Two-stage transfer learning.

    Stage 1 (with PR):
      Train: Ribera 2020-2022 WITH PR
      Apply: Generate pseudo-labels for 2023-2025

    Stage 2 (without PR):
      Train: 2023-2025 pseudo-labels (first 50%) WITHOUT PR
      Test: 2023-2025 DustIQ (last 50%)

    Returns:
        (y_true, y_pred, results_dict)
    """
    print("\n" + "="*80)
    print("SCENARIO 2: TWO-STAGE TRANSFER LEARNING")
    print("="*80)

    output_dir.mkdir(parents=True, exist_ok=True)

    split_date = pd.to_datetime(split_date)
    df_train = df[df['date'] < split_date].copy()
    df_test = df[df['date'] >= split_date].copy()

    # ==================== STAGE 1: WITH PR ====================
    print("\n" + "-"*80)
    print("STAGE 1: Training with PR → Generate pseudo-labels")
    print("-"*80)

    engineer = SoilingRatioFeatureEngineer(location)

    # Generate features WITH PR
    print("\n🔧 Generating features (with PR)...")

    # TRAIN with PR
    df_weather_train = df_train[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')
    df_aod_train = df_train[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod_train = df_aod_train.rename(columns={'aod_550': 'aod_550nm'})
    df_pr_train = df_train[['date', 'pr']].drop_duplicates('date').set_index('date')

    X_plant_train_pr = engineer.generate_features(
        df_weather=df_weather_train,
        df_aod=df_aod_train,
        df_pr=df_pr_train  # WITH PR!
    )

    # Merge to per-inverter
    X_plant_train_pr = X_plant_train_pr.reset_index()
    df_train_merged = df_train.merge(X_plant_train_pr, on='date', how='left')

    # Add inverter_id from original data
    df_train_merged['inverter_id_raw'] = df_train['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_train_merged = df_train_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_train_merged['inverter_id'] = df_train_merged['inverter_id_raw'].astype(str)
    df_train_merged = df_train_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_train_merged = df_train_merged[df_train_merged['inverter_id'] != 'nan']
    df_train_merged = df_train_merged[df_train_merged['inverter_id'] != '']

    # Fill NaN values in features
    for col in df_train_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id', 'pr']:
            if df_train_merged[col].dtype in ['float64', 'int64']:
                df_train_merged[col] = df_train_merged[col].fillna(df_train_merged[col].median())
            else:
                df_train_merged[col] = df_train_merged[col].fillna(df_train_merged[col].mode()[0] if len(df_train_merged[col].mode()) > 0 else 'UNKNOWN')

    # Spatial features
    inv_parts = df_train_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_train_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_train_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    feature_cols_pr = [col for col in df_train_merged.columns
                       if col not in ['date', 'sr_dustiq', 'inverter_id', 'pr']]
    X_train_pr = df_train_merged[feature_cols_pr + ['inverter_id']]
    y_train = df_train_merged['sr_dustiq']

    # TEST with PR
    df_weather_test = df_test[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')
    df_aod_test = df_test[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod_test = df_aod_test.rename(columns={'aod_550': 'aod_550nm'})
    df_pr_test = df_test[['date', 'pr']].drop_duplicates('date').set_index('date')

    X_plant_test_pr = engineer.generate_features(
        df_weather=df_weather_test,
        df_aod=df_aod_test,
        df_pr=df_pr_test
    )

    # Merge to per-inverter
    X_plant_test_pr = X_plant_test_pr.reset_index()
    df_test_merged = df_test.merge(X_plant_test_pr, on='date', how='left')

    # Add inverter_id from original data
    df_test_merged['inverter_id_raw'] = df_test['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_test_merged = df_test_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_test_merged['inverter_id'] = df_test_merged['inverter_id_raw'].astype(str)
    df_test_merged = df_test_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_test_merged = df_test_merged[df_test_merged['inverter_id'] != 'nan']
    df_test_merged = df_test_merged[df_test_merged['inverter_id'] != '']

    # Fill NaN values in features
    for col in df_test_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id', 'pr']:
            if df_test_merged[col].dtype in ['float64', 'int64']:
                df_test_merged[col] = df_test_merged[col].fillna(df_test_merged[col].median())
            else:
                df_test_merged[col] = df_test_merged[col].fillna(df_test_merged[col].mode()[0] if len(df_test_merged[col].mode()) > 0 else 'UNKNOWN')

    # Spatial features
    inv_parts = df_test_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_test_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_test_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    X_test_pr = df_test_merged[feature_cols_pr + ['inverter_id']]
    y_test = df_test_merged['sr_dustiq']

    feature_names_pr = feature_cols_pr
    print(f"  Features (with PR): {len(feature_names_pr)}")

    # Train Stage 1 model
    print("\n🚀 Training Stage 1 model (with PR)...")
    model_stage1 = CatBoostRegressor(
        iterations=2000,
        learning_rate=0.02,
        depth=8,
        l2_leaf_reg=3.0,
        loss_function='Quantile:alpha=0.4',
        random_seed=42,
        cat_features=['inverter_id'] if 'inverter_id' in X_train_pr.columns else None,
        verbose=100
    )

    model_stage1.fit(X_train_pr, y_train)

    # Generate pseudo-labels
    print("\n📊 Generating pseudo-labels for test period...")
    pseudo_labels = model_stage1.predict(X_test_pr)
    stage1_mae = mean_absolute_error(y_test, pseudo_labels)

    print(f"  Stage 1 MAE vs DustIQ: {stage1_mae:.4f} ({stage1_mae*100:.2f}%)")
    print(f"  Pseudo-labels: mean={pseudo_labels.mean():.4f}, std={pseudo_labels.std():.4f}")

    # Save Stage 1 results
    model_stage1.save_model(str(output_dir / "stage1_model_with_pr.pkl"))

    # ==================== STAGE 2: WITHOUT PR ====================
    print("\n" + "-"*80)
    print("STAGE 2: Training on pseudo-labels (without PR)")
    print("-"*80)

    # Generate features WITHOUT PR for test period
    print("\n🔧 Generating features (no PR)...")

    # Use same test weather/AOD data, but NO PR
    X_plant_test_no_pr = engineer.generate_features(
        df_weather=df_weather_test,
        df_aod=df_aod_test,
        df_pr=None  # No PR for forecasting!
    )

    # Merge to per-inverter
    X_plant_test_no_pr = X_plant_test_no_pr.reset_index()
    df_test_no_pr_merged = df_test.merge(X_plant_test_no_pr, on='date', how='left')

    # Add inverter_id from original data
    df_test_no_pr_merged['inverter_id_raw'] = df_test['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_test_no_pr_merged = df_test_no_pr_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_test_no_pr_merged['inverter_id'] = df_test_no_pr_merged['inverter_id_raw'].astype(str)
    df_test_no_pr_merged = df_test_no_pr_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_test_no_pr_merged = df_test_no_pr_merged[df_test_no_pr_merged['inverter_id'] != 'nan']
    df_test_no_pr_merged = df_test_no_pr_merged[df_test_no_pr_merged['inverter_id'] != '']

    # Fill NaN values in features
    for col in df_test_no_pr_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id', 'pr']:
            if df_test_no_pr_merged[col].dtype in ['float64', 'int64']:
                df_test_no_pr_merged[col] = df_test_no_pr_merged[col].fillna(df_test_no_pr_merged[col].median())
            else:
                df_test_no_pr_merged[col] = df_test_no_pr_merged[col].fillna(df_test_no_pr_merged[col].mode()[0] if len(df_test_no_pr_merged[col].mode()) > 0 else 'UNKNOWN')

    # Spatial features
    inv_parts = df_test_no_pr_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_test_no_pr_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_test_no_pr_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    feature_cols_no_pr = [col for col in df_test_no_pr_merged.columns
                          if col not in ['date', 'sr_dustiq', 'inverter_id', 'pr']]
    X_test_no_pr = df_test_no_pr_merged[feature_cols_no_pr + ['inverter_id']]

    feature_names_no_pr = feature_cols_no_pr
    print(f"  Features (no PR): {len(feature_names_no_pr)}")

    # Split pseudo-labels 50/50
    split_idx = len(pseudo_labels) // 2

    X_stage2_train = X_test_no_pr[:split_idx]
    y_stage2_train = pseudo_labels[:split_idx]  # Use pseudo-labels!

    X_stage2_test = X_test_no_pr[split_idx:]
    y_stage2_test = y_test[split_idx:]  # Test against real DustIQ

    print(f"\n  Stage 2 train: {len(X_stage2_train)} samples (pseudo-labels)")
    print(f"  Stage 2 test: {len(X_stage2_test)} samples (real DustIQ)")

    # Train Stage 2 model
    print("\n🚀 Training Stage 2 model (on pseudo-labels, no PR)...")
    model_stage2 = CatBoostRegressor(
        iterations=2000,
        learning_rate=0.02,
        depth=8,
        l2_leaf_reg=3.0,
        loss_function='Quantile:alpha=0.4',
        random_seed=42,
        cat_features=['inverter_id'] if 'inverter_id' in X_stage2_train.columns else None,
        verbose=100
    )

    model_stage2.fit(X_stage2_train, y_stage2_train)

    # Final predictions
    print("\n📊 Evaluating Stage 2...")
    y_pred_stage2_train = model_stage2.predict(X_stage2_train)
    y_pred_stage2_test = model_stage2.predict(X_stage2_test)

    # Metrics
    stage2_train_mae = mean_absolute_error(y_stage2_train, y_pred_stage2_train)
    stage2_test_mae = mean_absolute_error(y_stage2_test, y_pred_stage2_test)
    stage2_test_r2 = r2_score(y_stage2_test, y_pred_stage2_test)

    print(f"\n✅ Stage 2 Results:")
    print(f"  Train MAE (vs pseudo-labels): {stage2_train_mae:.4f} ({stage2_train_mae*100:.2f}%)")
    print(f"  Test MAE (vs DustIQ): {stage2_test_mae:.4f} ({stage2_test_mae*100:.2f}%)")
    print(f"  Test R²: {stage2_test_r2:.4f}")

    # Save results
    results = {
        'method': 'two_stage_transfer',
        'stage1_mae': float(stage1_mae),
        'stage2_train_mae': float(stage2_train_mae),
        'stage2_test_mae': float(stage2_test_mae),
        'stage2_test_r2': float(stage2_test_r2),
        'n_features_stage1': len(feature_names_pr),
        'n_features_stage2': len(feature_names_no_pr)
    }

    with open(output_dir / "metrics.json", 'w') as f:
        json.dump(results, f, indent=2)

    # Save predictions (use cleaned dataframe for Stage 2 test set)
    pred_df = df_test_no_pr_merged.iloc[split_idx:][['date', 'inverter_id', 'sr_dustiq']].copy()
    pred_df['sr_pred'] = y_pred_stage2_test
    pred_df.to_csv(output_dir / "predictions.csv", index=False)

    # Save models
    model_stage2.save_model(str(output_dir / "stage2_model_without_pr.pkl"))

    # Save pseudo-labels (use cleaned dataframe from Stage 1)
    pseudo_df = df_test_merged[['date', 'inverter_id', 'sr_dustiq']].copy()
    pseudo_df['sr_pseudo_label'] = pseudo_labels
    pseudo_df.to_csv(output_dir / "pseudo_labels.csv", index=False)

    print(f"\n💾 Saved to: {output_dir}/")

    return y_stage2_test, y_pred_stage2_test, results


def generate_comparison_report(
    comparison: Dict[str, any],
    direct_results: Dict[str, any],
    transfer_results: Dict[str, any],
    output_dir: Path
) -> None:
    """Generate comparison reports."""
    print("\n📝 Generating comparison report...")

    # JSON report
    report = {
        'comparison': comparison,
        'direct_training': direct_results,
        'two_stage_transfer': transfer_results,
        'timestamp': datetime.now().isoformat()
    }

    json_path = output_dir / "comparison_report.json"
    with open(json_path, 'w') as f:
        json.dump(report, f, indent=2, default=str)
    print(f"  ✅ {json_path}")

    # Markdown report
    md_path = output_dir / "comparison_report.md"
    with open(md_path, 'w') as f:
        f.write("# Transfer Learning vs Direct Training\n\n")
        f.write(f"**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")

        f.write("## Test Configuration\n\n")
        f.write("- Train: 2020-2022\n")
        f.write("- Test: 2023-2025\n")
        f.write("- Ground Truth: Ribera DustIQ\n\n")

        f.write("## Results\n\n")
        f.write("| Method | MAE (%) | R² | Notes |\n")
        f.write("|--------|---------|-----|-------|\n")

        f.write(f"| Direct Training | {comparison['model1_mae']*100:.2f} | ")
        f.write(f"{direct_results['test_r2']:.3f} | Simple, fast |\n")

        f.write(f"| Two-Stage Transfer | {comparison['model2_mae']*100:.2f} | ")
        f.write(f"{transfer_results['stage2_test_r2']:.3f} | Complex, flexible |\n\n")

        f.write("## Statistical Tests\n\n")
        f.write(f"**Winner**: {comparison['winner']}\n\n")
        f.write(f"**Improvement**: {comparison['improvement_pct']:.1f}%\n\n")

        f.write("| Test | p-value | Significant |\n")
        f.write("|------|---------|-------------|\n")

        f.write(f"| Paired t-test | {comparison['paired_t_test']['p_value']:.4f} | ")
        f.write(f"{'Yes' if comparison['paired_t_test']['significant'] else 'No'} |\n")

        f.write(f"| Wilcoxon | {comparison['wilcoxon_test']['p_value']:.4f} | ")
        f.write(f"{'Yes' if comparison['wilcoxon_test']['significant'] else 'No'} |\n")

        f.write(f"| Diebold-Mariano | {comparison['diebold_mariano_test']['p_value']:.4f} | ")
        f.write(f"{'Yes' if comparison['diebold_mariano_test']['significant'] else 'No'} |\n\n")

        f.write(f"**Effect Size**: Cohen's d = {comparison['cohens_d']:.3f} ")
        f.write(f"({comparison['effect_interpretation']})\n\n")

        f.write("## Recommendation\n\n")
        if comparison['winner'] == 'Direct Training':
            f.write("**Use Direct Training** when:\n")
            f.write("- You have good DustIQ on the target plant\n")
            f.write("- You want simplicity and speed\n")
            f.write("- Accuracy difference is minimal\n\n")
            f.write("**Use Two-Stage Transfer** when:\n")
            f.write("- Target plant has broken or no DustIQ\n")
            f.write("- You need to transfer knowledge across plants\n")
        else:
            f.write("**Use Two-Stage Transfer** when:\n")
            f.write("- Significantly better accuracy justified\n")
            f.write("- Target plant has broken or no DustIQ\n\n")
            f.write("**Use Direct Training** when:\n")
            f.write("- Simplicity and speed are priorities\n")

    print(f"  ✅ {md_path}")


def main():
    """Main execution function."""
    print("="*80)
    print("TRANSFER LEARNING METHOD COMPARISON")
    print("="*80)

    # Configuration
    DATA_DIR = Path("public/data/soiling/ribera")
    OUTPUT_DIR = Path("outputs_transfer_comparison")
    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "plots").mkdir(exist_ok=True)

    LOCATION = PlantLocation(
        latitude=37.927,
        longitude=-1.233,
        elevation_m=50,
        climate_zone='mediterranean'
    )

    # Load data
    df = load_ribera_data(DATA_DIR)

    # Run Scenario 1: Direct Training
    y_true_direct, y_pred_direct, direct_results = scenario_direct_training(
        df, LOCATION, output_dir=OUTPUT_DIR / "direct_training"
    )

    # Run Scenario 2: Two-Stage Transfer
    y_true_transfer, y_pred_transfer, transfer_results = scenario_two_stage_transfer(
        df, LOCATION, output_dir=OUTPUT_DIR / "two_stage_transfer"
    )

    # Statistical comparison
    print("\n" + "="*80)
    print("STATISTICAL COMPARISON")
    print("="*80)

    # Align test sets for fair comparison (use second half only)
    # Two-stage transfer only used second half of test set for Stage 2
    split_idx = len(y_true_direct) // 2
    y_true_aligned = y_true_direct.iloc[split_idx:].values if hasattr(y_true_direct, 'iloc') else y_true_direct[split_idx:]
    y_pred_direct_aligned = y_pred_direct.iloc[split_idx:].values if hasattr(y_pred_direct, 'iloc') else y_pred_direct[split_idx:]
    y_pred_transfer_aligned = y_pred_transfer.values if hasattr(y_pred_transfer, 'values') else y_pred_transfer

    print(f"\n⚖️ Comparing on aligned test set:")
    print(f"  Direct training predictions: {len(y_pred_direct_aligned)} samples (second half)")
    print(f"  Two-stage transfer predictions: {len(y_pred_transfer_aligned)} samples")
    print(f"  Ground truth: {len(y_true_aligned)} samples")

    comparison = compare_models(
        y_true_aligned,
        y_pred_direct_aligned,
        y_pred_transfer_aligned,
        model1_name='Direct Training',
        model2_name='Two-Stage Transfer'
    )

    print(test_summary_string(comparison))

    # Generate reports
    generate_comparison_report(
        comparison,
        direct_results,
        transfer_results,
        OUTPUT_DIR
    )

    # Generate visualization
    plot_comparison_summary(
        comparison,
        OUTPUT_DIR / "plots" / "comparison_summary.png"
    )

    print("\n" + "="*80)
    print("✅ COMPARISON COMPLETE")
    print("="*80)
    print(f"\n📁 Results saved to: {OUTPUT_DIR}/")
    print(f"   - comparison_report.json")
    print(f"   - comparison_report.md")
    print(f"   - direct_training/")
    print(f"   - two_stage_transfer/")
    print(f"   - plots/comparison_summary.png")


if __name__ == "__main__":
    main()
