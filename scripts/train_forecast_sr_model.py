#!/usr/bin/env python3
"""Train forecasting-compatible soiling ratio model with inverterID.

This script creates a single CatBoost model that uses inverterID as a categorical
feature, enabling per-inverter predictions from a single model.

Key differences from previous approach:
1. Single model instead of 150 separate models
2. inverterID as categorical feature
3. NO PR FEATURES (not available for forecasting)
4. Only forecastable features: AOD, rain, weather, temporal, spatial

This enables true forecasting: Given AOD forecast + rain forecast → Predict SR
"""

import json
import logging
import sys
from pathlib import Path
from typing import Dict, List, Tuple
import warnings

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor, Pool

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation
from nuravolt.soiling.sr_validation import (
    validate_sr_range,
    validate_rain_resets,
    validate_monotonic_decay
)

warnings.filterwarnings('ignore')

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def load_ribera_per_inverter_data(
    data_dir: Path,
    latitude: float = 37.927,
    longitude: float = -1.233
) -> pd.DataFrame:
    """Load Ribera per-inverter data with DustIQ ground truth.

    Returns DataFrame with columns:
    - date
    - inverter_id
    - sr_dustiq (ground truth)
    - precipitation_mm
    - aod_550
    """
    logger.info("Loading Ribera per-inverter data...")

    # Load per-inverter SR JSON
    sr_json_path = data_dir / "per_inverter" / "ribera_per_inverter_sr.json"

    if not sr_json_path.exists():
        raise FileNotFoundError(f"Per-inverter data not found: {sr_json_path}")

    with open(sr_json_path, 'r') as f:
        data = json.load(f)

    # Extract per-inverter history
    inverters_data = data['inverters']
    records = []

    for inv_id, inv_data in inverters_data.items():
        for hist in inv_data.get('history', []):
            records.append({
                'date': pd.to_datetime(hist['date']),
                'inverter_id': inv_id,
                'sr_dustiq': hist['sr']
            })

    df = pd.DataFrame(records)
    logger.info(f"Loaded {len(df)} records for {df['inverter_id'].nunique()} inverters")

    # Load rain data (plant-level)
    rain_path = data_dir / "rain_history.json"
    with open(rain_path, 'r') as f:
        rain_data = json.load(f)

    df_rain = pd.DataFrame(rain_data['daily_data'])
    df_rain['date'] = pd.to_datetime(df_rain['date'])
    df_rain = df_rain.rename(columns={'precipitation': 'precipitation_mm'})

    logger.info(f"Loaded rain data: {len(df_rain)} days")

    # Load AOD data (plant-level)
    aod_path = data_dir / "aod_history.json"
    if aod_path.exists():
        with open(aod_path, 'r') as f:
            aod_data = json.load(f)

        df_aod = pd.DataFrame(aod_data['daily_data'])
        df_aod['date'] = pd.to_datetime(df_aod['date'])

        # Handle column name (aod_550nm or aod_550)
        aod_col = 'aod_550nm' if 'aod_550nm' in df_aod.columns else 'aod_550'
        df_aod = df_aod.rename(columns={aod_col: 'aod_550'})

        logger.info(f"Loaded AOD data: {len(df_aod)} days")
    else:
        df_aod = None
        logger.warning("AOD data not found")

    # Merge plant-level data
    df = df.merge(df_rain[['date', 'precipitation_mm']], on='date', how='left')

    if df_aod is not None:
        df = df.merge(df_aod[['date', 'aod_550']], on='date', how='left')
        df['aod_550'] = df['aod_550'].fillna(0.1)
    else:
        df['aod_550'] = 0.1

    df['precipitation_mm'] = df['precipitation_mm'].fillna(0)

    # Sort by date and inverter
    df = df.sort_values(['date', 'inverter_id']).reset_index(drop=True)

    logger.info(f"Final dataset: {len(df)} rows, {df['inverter_id'].nunique()} inverters")
    logger.info(f"Date range: {df['date'].min()} to {df['date'].max()}")
    logger.info(f"DustIQ mean: {df['sr_dustiq'].mean():.3f}, std: {df['sr_dustiq'].std():.3f}")

    return df


def generate_forecast_features(
    df: pd.DataFrame,
    location: PlantLocation
) -> pd.DataFrame:
    """Generate features WITHOUT PR (forecasting-compatible).

    Only uses:
    - Rain (forecastable from weather models)
    - AOD (forecastable from CAMS)
    - Temporal features (deterministic)
    - Spatial features (static)
    - inverter_id (categorical)
    """
    logger.info("Generating forecast-compatible features (NO PR)...")

    # Prepare weather DataFrame
    df_weather = df[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')

    # Prepare AOD DataFrame
    df_aod = df[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod = df_aod.rename(columns={'aod_550': 'aod_550nm'})

    # Generate features WITHOUT PR
    feature_engineer = SoilingRatioFeatureEngineer(location=location)
    X_plant = feature_engineer.generate_features(
        df_weather=df_weather,
        df_aod=df_aod,
        df_pr=None  # NO PR for forecasting!
    )

    # Merge back to per-inverter data
    X_plant = X_plant.reset_index()
    df_merged = df.merge(X_plant, on='date', how='left')

    # Add inverter_id and spatial features
    df_merged['inverter_id'] = df['inverter_id']

    # Extract inverter row and position (e.g., "INV 03.025" → row=3, pos=25)
    inv_parts = df_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_merged['inverter_row'] = inv_parts[0].astype(float)
    df_merged['inverter_position'] = inv_parts[1].astype(float)

    # Feature columns (exclude target and metadata)
    feature_cols = [col for col in df_merged.columns
                   if col not in ['date', 'sr_dustiq', 'inverter_id']]

    X = df_merged[feature_cols + ['inverter_id']]
    y = df_merged['sr_dustiq']
    dates = df_merged['date']

    logger.info(f"Generated {len(feature_cols)} features (no PR)")
    logger.info(f"Feature columns: {feature_cols[:10]}...")

    return X, y, dates, df_merged


def train_forecast_model(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    X_test: pd.DataFrame,
    y_test: pd.Series,
    categorical_features: List[str]
) -> CatBoostRegressor:
    """Train CatBoost model with inverterID as categorical feature.

    Uses optimal hyperparameters from experiments:
    - alpha=0.4 (balanced quantile loss)
    - depth=8 (optimal complexity)
    - 2000 iterations
    """
    logger.info("\nTraining forecast model with inverterID...")
    logger.info(f"Train samples: {len(X_train)}")
    logger.info(f"Test samples: {len(X_test)}")
    logger.info(f"Categorical features: {categorical_features}")

    # Create CatBoost Pools with categorical features
    train_pool = Pool(
        data=X_train,
        label=y_train,
        cat_features=categorical_features
    )

    test_pool = Pool(
        data=X_test,
        label=y_test,
        cat_features=categorical_features
    )

    # Train model with optimal hyperparameters
    model = CatBoostRegressor(
        iterations=2000,
        learning_rate=0.02,
        depth=8,
        l2_leaf_reg=3.0,
        loss_function='Quantile:alpha=0.4',
        random_seed=42,
        verbose=100,
        cat_features=categorical_features
    )

    model.fit(train_pool, eval_set=test_pool)

    # Evaluate
    y_pred_train = model.predict(X_train)
    y_pred_test = model.predict(X_test)

    mae_train = np.mean(np.abs(y_pred_train - y_train))
    mae_test = np.mean(np.abs(y_pred_test - y_test))

    rmse_train = np.sqrt(np.mean((y_pred_train - y_train) ** 2))
    rmse_test = np.sqrt(np.mean((y_pred_test - y_test) ** 2))

    logger.info(f"\nTraining MAE: {mae_train:.4f} ({mae_train*100:.2f}%)")
    logger.info(f"Test MAE: {mae_test:.4f} ({mae_test*100:.2f}%)")
    logger.info(f"Training RMSE: {rmse_train:.4f}")
    logger.info(f"Test RMSE: {rmse_test:.4f}")

    return model


def validate_predictions(
    y_pred: pd.Series,
    df_weather: pd.DataFrame,
    dates: pd.Series
) -> Dict:
    """Validate predictions using physics constraints."""
    logger.info("\nValidating predictions with physics constraints...")

    # Convert to Series with date index
    y_pred_series = pd.Series(y_pred, index=dates.values)

    # Aggregate to daily (multiple inverters per day)
    y_pred_daily = y_pred_series.groupby(y_pred_series.index).mean()

    # 1. Range validation
    violations, total = validate_sr_range(y_pred_daily)
    range_pass_rate = 1 - (violations / total) if total > 0 else 1

    violation_pct = (violations/total*100) if total > 0 else 0
    logger.info(f"Range violations: {violations}/{total} ({violation_pct:.1f}%)")

    # 2. Rain reset validation
    df_rain = df_weather[['date', 'precipitation_mm']].drop_duplicates('date')
    df_rain = df_rain.set_index('date')

    rain_events, correct, rain_reset_accuracy = validate_rain_resets(
        y_pred_daily,
        df_rain,
        heavy_rain_threshold_mm=5.0,
        reset_threshold_sr=0.99,
        check_window_days=2
    )

    logger.info(f"Rain reset accuracy: {rain_reset_accuracy*100:.1f}% ({correct}/{rain_events})")

    # 3. Monotonic decay validation
    decay_violations = validate_monotonic_decay(
        y_pred_daily,
        df_rain,
        rain_threshold_mm=5.0
    )
    decay_plausibility = 1.0 if decay_violations == 0 else 0.0

    logger.info(f"Decay violations: {decay_violations}")
    logger.info(f"Decay plausibility: {decay_plausibility*100:.1f}%")

    # Overall physics score
    checks_passed = sum([
        range_pass_rate > 0.99,
        rain_reset_accuracy > 0.2,
        decay_plausibility > 0.9
    ])
    overall_pass_rate = checks_passed / 3

    logger.info(f"Overall physics pass rate: {overall_pass_rate*100:.1f}% ({checks_passed}/3)")

    return {
        'range_violations': violations,
        'range_total': total,
        'range_pass_rate': range_pass_rate,
        'rain_events': rain_events,
        'rain_resets_correct': correct,
        'rain_reset_accuracy': rain_reset_accuracy,
        'decay_violations': decay_violations,
        'decay_plausibility': decay_plausibility,
        'overall_pass_rate': overall_pass_rate,
        'checks_passed': checks_passed
    }


def main():
    """Main training workflow."""
    logger.info("="*80)
    logger.info("FORECASTING-COMPATIBLE SR MODEL - SINGLE MODEL WITH INVERTER_ID")
    logger.info("="*80)

    # Configuration
    ribera_dir = Path("public/data/soiling/ribera")
    output_dir = Path("outputs_forecast_model")
    output_dir.mkdir(exist_ok=True)

    ribera_location = PlantLocation(
        latitude=37.927,
        longitude=-1.233,
        elevation_m=200.0,
        climate_zone="mediterranean",
        distance_to_coast_km=80.0
    )

    # Load data
    df = load_ribera_per_inverter_data(ribera_dir)

    # Generate features (NO PR!)
    X, y, dates, df_full = generate_forecast_features(df, ribera_location)

    logger.info("\n" + "="*80)
    logger.info("TEMPORAL SPLIT (50/50)")
    logger.info("="*80)

    # 50/50 temporal split
    split_idx = len(df_full) // 2

    X_train = X.iloc[:split_idx]
    y_train = y.iloc[:split_idx]
    dates_train = dates.iloc[:split_idx]

    X_test = X.iloc[split_idx:]
    y_test = y.iloc[split_idx:]
    dates_test = dates.iloc[split_idx:]

    logger.info(f"Train period: {dates_train.min()} to {dates_train.max()}")
    logger.info(f"Test period: {dates_test.min()} to {dates_test.max()}")
    logger.info(f"Train inverters: {X_train['inverter_id'].nunique()}")
    logger.info(f"Test inverters: {X_test['inverter_id'].nunique()}")

    # Train model
    categorical_features = ['inverter_id']
    model = train_forecast_model(
        X_train, y_train,
        X_test, y_test,
        categorical_features
    )

    # Save model
    model_path = output_dir / "forecast_sr_model_with_inverter_id.pkl"
    model.save_model(str(model_path))
    logger.info(f"\nModel saved: {model_path}")

    # Predictions
    y_pred_test = model.predict(X_test)

    # Validate physics
    df_weather_test = df_full.iloc[split_idx:][['date', 'precipitation_mm']]
    validation_results = validate_predictions(y_pred_test, df_weather_test, dates_test)

    # Save validation results
    validation_path = output_dir / "validation_results.json"
    with open(validation_path, 'w') as f:
        json.dump(validation_results, f, indent=2, default=str)

    logger.info(f"Validation results saved: {validation_path}")

    # Analyze per-inverter performance
    logger.info("\n" + "="*80)
    logger.info("PER-INVERTER ANALYSIS")
    logger.info("="*80)

    df_results = pd.DataFrame({
        'date': dates_test.values,
        'inverter_id': X_test['inverter_id'].values,
        'y_true': y_test.values,
        'y_pred': y_pred_test
    })

    # MAE per inverter
    inv_mae = df_results.groupby('inverter_id').apply(
        lambda g: np.mean(np.abs(g['y_true'] - g['y_pred']))
    ).sort_values()

    logger.info(f"\nBest 5 inverters (lowest MAE):")
    for inv_id in inv_mae.head(5).index:
        logger.info(f"  {inv_id}: MAE={inv_mae[inv_id]:.4f}")

    logger.info(f"\nWorst 5 inverters (highest MAE):")
    for inv_id in inv_mae.tail(5).index:
        logger.info(f"  {inv_id}: MAE={inv_mae[inv_id]:.4f}")

    logger.info(f"\nMean MAE across inverters: {inv_mae.mean():.4f}")
    logger.info(f"Std MAE across inverters: {inv_mae.std():.4f}")

    # Save predictions
    predictions_path = output_dir / "test_predictions.csv"
    df_results.to_csv(predictions_path, index=False)
    logger.info(f"\nPredictions saved: {predictions_path}")

    # Feature importance
    feature_importance = model.get_feature_importance()
    feature_names = [col for col in X.columns if col != 'inverter_id']

    # Add inverter_id importance
    if len(feature_importance) > len(feature_names):
        feature_names = feature_names + ['inverter_id']

    fi_df = pd.DataFrame({
        'feature': feature_names,
        'importance': feature_importance[:len(feature_names)]
    }).sort_values('importance', ascending=False)

    logger.info("\nTop 15 features:")
    for idx, row in fi_df.head(15).iterrows():
        logger.info(f"  {row['feature']}: {row['importance']:.2f}")

    # Save feature importance
    fi_path = output_dir / "feature_importance.csv"
    fi_df.to_csv(fi_path, index=False)

    logger.info("\n" + "="*80)
    logger.info("TRAINING COMPLETE")
    logger.info("="*80)
    logger.info(f"Model: {model_path}")
    logger.info(f"Test MAE: {np.mean(np.abs(y_pred_test - y_test)):.4f}")
    logger.info(f"Physics pass rate: {validation_results['overall_pass_rate']*100:.1f}%")
    logger.info(f"Predictions: {predictions_path}")


if __name__ == "__main__":
    main()
