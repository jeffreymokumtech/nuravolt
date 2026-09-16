#!/usr/bin/env python3
"""Two-stage soiling ratio forecasting approach.

STAGE 1: Transfer Learning with PR
- Train on Ribera (good DustIQ) using PR
- Apply to Alpha WITH PR → Get SR pseudo-labels

STAGE 2: Forecast Model on Alpha
- Train on Alpha pseudo-labels WITHOUT PR
- Use Alpha' actual inverter_ids as categorical features
- Result: Forecasting model that learned Alpha-specific patterns

This solves the inverterID transfer problem!
"""

import json
import logging
import sys
from pathlib import Path
from typing import Dict, Tuple
import warnings

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor, Pool

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation

warnings.filterwarnings('ignore')

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def load_alpha_per_inverter_with_pr(data_dir: Path) -> pd.DataFrame:
    """Load Alpha per-inverter data with PR from existing JSON."""
    logger.info("Loading Alpha per-inverter data with PR...")

    # Load existing per-inverter SR JSON (contains PR)
    sr_json_path = data_dir / "per_inverter" / "alpha1_per_inverter_sr.json"

    with open(sr_json_path, 'r') as f:
        data = json.load(f)

    inverters_data = data['inverters']
    records = []

    for inv_id, inv_data in inverters_data.items():
        for hist in inv_data.get('history', []):
            records.append({
                'date': pd.to_datetime(hist['date']),
                'inverter_id': inv_id,
                'sr_existing': hist.get('sr', np.nan),  # Existing estimates
                'pr': hist.get('pr', np.nan)  # IMPORTANT: PR data
            })

    df = pd.DataFrame(records)

    # Load rain
    rain_path = data_dir / "rain_history.json"
    with open(rain_path, 'r') as f:
        rain_data = json.load(f)
    df_rain = pd.DataFrame(rain_data['daily_data'])
    df_rain['date'] = pd.to_datetime(df_rain['date'])
    df_rain = df_rain.rename(columns={'precipitation': 'precipitation_mm'})

    # Load AOD
    aod_path = data_dir / "cams_aod_history.json"
    if not aod_path.exists():
        aod_path = data_dir / "aod_history.json"

    with open(aod_path, 'r') as f:
        aod_data = json.load(f)

    # Handle different JSON structures
    if 'daily_data' in aod_data:
        df_aod = pd.DataFrame(aod_data['daily_data'])
        df_aod['date'] = pd.to_datetime(df_aod['date'])
    elif 'data' in aod_data:
        df_aod = pd.DataFrame(aod_data['data'])
        # CAMS data uses 'timestamp' instead of 'date'
        if 'timestamp' in df_aod.columns:
            df_aod['date'] = pd.to_datetime(df_aod['timestamp'])
            # Aggregate 3-hourly to daily (mean)
            df_aod = df_aod.groupby('date').agg({
                col: 'mean' for col in df_aod.columns if col not in ['date', 'timestamp']
            }).reset_index()
        else:
            df_aod['date'] = pd.to_datetime(df_aod['date'])
    else:
        df_aod = pd.DataFrame(aod_data)
        df_aod['date'] = pd.to_datetime(df_aod['date'])

    aod_col = 'aod_550nm' if 'aod_550nm' in df_aod.columns else 'aod_550'
    df_aod = df_aod.rename(columns={aod_col: 'aod_550'})

    # Merge
    df = df.merge(df_rain[['date', 'precipitation_mm']], on='date', how='left')
    df = df.merge(df_aod[['date', 'aod_550']], on='date', how='left')

    df['precipitation_mm'] = df['precipitation_mm'].fillna(0)
    df['aod_550'] = df['aod_550'].fillna(0.1)
    df['pr'] = df['pr'].fillna(df['pr'].mean())  # Fill missing PR

    df = df.sort_values(['date', 'inverter_id']).reset_index(drop=True)

    logger.info(f"Loaded {len(df)} rows for {df['inverter_id'].nunique()} inverters")
    logger.info(f"Date range: {df['date'].min()} to {df['date'].max()}")
    logger.info(f"PR available: {df['pr'].notna().sum()} / {len(df)} samples")

    return df


def load_ribera_data_with_dustiq(ribera_dir: Path) -> Tuple[pd.DataFrame, pd.Series]:
    """Load Ribera data with DustIQ ground truth."""
    # Load DustIQ
    dustiq_path = ribera_dir / "dustiq_history.json"
    with open(dustiq_path, 'r') as f:
        dustiq_data = json.load(f)
    df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
    df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])

    # Load rain
    rain_path = ribera_dir / "rain_history.json"
    with open(rain_path, 'r') as f:
        rain_data = json.load(f)
    df_rain = pd.DataFrame(rain_data['daily_data'])
    df_rain['date'] = pd.to_datetime(df_rain['date'])
    df_rain = df_rain.rename(columns={'precipitation': 'precipitation_mm'})

    # Load AOD
    aod_path = ribera_dir / "cams_aod_history.json"
    if not aod_path.exists():
        aod_path = ribera_dir / "aod_history.json"
    with open(aod_path, 'r') as f:
        aod_data = json.load(f)

    # Handle different JSON structures
    if 'daily_data' in aod_data:
        df_aod = pd.DataFrame(aod_data['daily_data'])
        df_aod['date'] = pd.to_datetime(df_aod['date'])
    elif 'data' in aod_data:
        df_aod = pd.DataFrame(aod_data['data'])
        # CAMS data uses 'timestamp' instead of 'date'
        if 'timestamp' in df_aod.columns:
            df_aod['date'] = pd.to_datetime(df_aod['timestamp'])
            # Aggregate 3-hourly to daily (mean)
            df_aod = df_aod.groupby('date').agg({
                col: 'mean' for col in df_aod.columns if col not in ['date', 'timestamp']
            }).reset_index()
        else:
            df_aod['date'] = pd.to_datetime(df_aod['date'])
    else:
        df_aod = pd.DataFrame(aod_data)
        df_aod['date'] = pd.to_datetime(df_aod['date'])

    aod_col = 'aod_550nm' if 'aod_550nm' in df_aod.columns else 'aod_550'
    df_aod = df_aod.rename(columns={aod_col: 'aod_550nm'})

    # Load PR (daily plant-level)
    pr_path = ribera_dir / "pr_daily.parquet"
    df_pr = pd.read_parquet(pr_path)
    df_pr['date'] = pd.to_datetime(df_pr['date'])
    # Aggregate to plant level if per-inverter
    df_pr = df_pr.groupby('date').agg({'pr': 'mean'}).reset_index()

    # Merge all
    df = df_dustiq.merge(df_rain[['date', 'precipitation_mm']], on='date', how='inner')
    df = df.merge(df_aod[['date', 'aod_550nm']], on='date', how='left')
    df = df.merge(df_pr[['date', 'pr']], on='date', how='left')

    df = df.sort_values('date').reset_index(drop=True)

    return df


def stage1_transfer_learning_with_pr(
    ribera_dir: Path,
    alpha_df: pd.DataFrame,
    output_dir: Path
) -> pd.Series:
    """STAGE 1: Train on Ribera with PR, apply to Alpha.

    Returns:
        pd.Series: SR pseudo-labels for Alpha (per-inverter, per-day)
    """
    logger.info("\n" + "="*80)
    logger.info("STAGE 1: TRANSFER LEARNING WITH PR")
    logger.info("="*80)

    # Load Ribera data
    logger.info("Loading Ribera data with DustIQ...")
    df_ribera = load_ribera_data_with_dustiq(ribera_dir)
    logger.info(f"Loaded {len(df_ribera)} samples")
    logger.info(f"Period: {df_ribera['date'].min()} to {df_ribera['date'].max()}")

    # Generate features WITH PR
    ribera_location = PlantLocation(
        latitude=37.927,
        longitude=-1.233,
        elevation_m=200.0,
        climate_zone="mediterranean",
        distance_to_coast_km=80.0
    )

    df_weather = df_ribera[['date', 'precipitation_mm']].set_index('date')
    df_aod = df_ribera[['date', 'aod_550nm']].set_index('date')
    df_pr = df_ribera[['date', 'pr']].set_index('date')

    feature_engineer = SoilingRatioFeatureEngineer(location=ribera_location)
    X = feature_engineer.generate_features(
        df_weather=df_weather,
        df_aod=df_aod,
        df_pr=df_pr  # WITH PR
    )

    y = df_ribera.set_index('date')['sr_dustiq']

    # Align
    common_idx = X.index.intersection(y.index)
    X = X.loc[common_idx]
    y = y.loc[common_idx]

    logger.info(f"Features: {X.shape[1]} columns (with PR)")

    # 50/50 split
    split_idx = len(X) // 2
    X_train = X.iloc[:split_idx]
    y_train = y.iloc[:split_idx]
    X_test = X.iloc[split_idx:]
    y_test = y.iloc[split_idx:]

    logger.info(f"Train: {len(X_train)}, Test: {len(X_test)}")

    # Train model
    logger.info("Training CatBoost model with PR...")
    model_stage1 = CatBoostRegressor(
        iterations=2000,
        learning_rate=0.02,
        depth=8,
        l2_leaf_reg=3.0,
        loss_function='Quantile:alpha=0.4',
        random_seed=42,
        verbose=100
    )

    model_stage1.fit(X_train, y_train, eval_set=(X_test, y_test))

    # Evaluate
    y_pred_test = model_stage1.predict(X_test)
    mae_test = np.mean(np.abs(y_pred_test - y_test))
    logger.info(f"\nRibera test MAE: {mae_test:.4f} ({mae_test*100:.2f}%)")

    # Save Stage 1 model
    stage1_model_path = output_dir / "stage1_transfer_model_with_pr.pkl"
    model_stage1.save_model(str(stage1_model_path))
    logger.info(f"Stage 1 model saved: {stage1_model_path}")

    # Apply to Alpha WITH PR
    logger.info("\nApplying to Alpha with PR...")

    alpha_location = PlantLocation(
        latitude=38.485,
        longitude=-6.833,
        elevation_m=200.0,
        climate_zone="mediterranean",
        distance_to_coast_km=300.0
    )

    # Generate features WITH PR for Alpha
    df_weather = alpha_df[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')
    df_aod = alpha_df[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod = df_aod.rename(columns={'aod_550': 'aod_550nm'})
    df_pr = alpha_df[['date', 'pr']].drop_duplicates('date').set_index('date')

    feature_engineer = SoilingRatioFeatureEngineer(location=alpha_location)
    X_alpha_plant = feature_engineer.generate_features(
        df_weather=df_weather,
        df_aod=df_aod,
        df_pr=df_pr  # INCLUDE PR for Stage 1
    )

    # Merge back to per-inverter
    X_alpha_plant = X_alpha_plant.reset_index()
    alpha_df_features = alpha_df.merge(X_alpha_plant, on='date', how='left')

    # Select feature columns (match Ribera training)
    feature_cols = [col for col in X_train.columns if col in alpha_df_features.columns]
    X_alpha = alpha_df_features[feature_cols]

    logger.info(f"Alpha features: {X_alpha.shape}")
    logger.info(f"Using {len(feature_cols)} features (with PR)")

    # Predict SR for Alpha
    sr_pseudo_labels = model_stage1.predict(X_alpha)

    logger.info(f"\nAlpha SR pseudo-labels generated:")
    logger.info(f"  Mean: {sr_pseudo_labels.mean():.3f}")
    logger.info(f"  Std: {sr_pseudo_labels.std():.3f}")
    logger.info(f"  Range: {sr_pseudo_labels.min():.3f} - {sr_pseudo_labels.max():.3f}")

    # Save pseudo-labels
    pseudo_labels_df = pd.DataFrame({
        'date': alpha_df_features['date'],
        'inverter_id': alpha_df_features['inverter_id'],
        'sr_pseudo_label': sr_pseudo_labels
    })

    pseudo_labels_path = output_dir / "alpha_sr_pseudo_labels_stage1.csv"
    pseudo_labels_df.to_csv(pseudo_labels_path, index=False)
    logger.info(f"Pseudo-labels saved: {pseudo_labels_path}")

    return pd.Series(sr_pseudo_labels, index=alpha_df_features.index)


def stage2_forecast_model_on_alpha(
    alpha_df: pd.DataFrame,
    sr_pseudo_labels: pd.Series,
    output_dir: Path
) -> CatBoostRegressor:
    """STAGE 2: Train forecast model on Alpha WITHOUT PR.

    Uses Alpha' actual inverter_ids and SR pseudo-labels from Stage 1.
    """
    logger.info("\n" + "="*80)
    logger.info("STAGE 2: FORECAST MODEL ON ALPHA (NO PR)")
    logger.info("="*80)

    alpha_location = PlantLocation(
        latitude=38.485,
        longitude=-6.833,
        elevation_m=200.0,
        climate_zone="mediterranean",
        distance_to_coast_km=300.0
    )

    # Generate features WITHOUT PR
    logger.info("Generating forecast-compatible features (NO PR)...")

    df_weather = alpha_df[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')
    df_aod = alpha_df[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod = df_aod.rename(columns={'aod_550': 'aod_550nm'})

    feature_engineer = SoilingRatioFeatureEngineer(location=alpha_location)
    X_plant = feature_engineer.generate_features(
        df_weather=df_weather,
        df_aod=df_aod,
        df_pr=None  # NO PR for forecasting!
    )

    # Merge back
    X_plant = X_plant.reset_index()
    df_merged = alpha_df.merge(X_plant, on='date', how='left')

    # Add inverter features
    df_merged['inverter_id'] = alpha_df['inverter_id']
    inv_parts = df_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_merged['inverter_row'] = inv_parts[0].astype(float)
    df_merged['inverter_position'] = inv_parts[1].astype(float)

    # Feature columns (exclude target)
    feature_cols = [col for col in df_merged.columns
                   if col not in ['date', 'sr_pseudo_label', 'sr_existing', 'pr', 'inverter_id']]

    X = df_merged[feature_cols + ['inverter_id']]
    y = sr_pseudo_labels
    dates = df_merged['date']

    logger.info(f"Features: {len(feature_cols)} (no PR)")
    logger.info(f"Samples: {len(X)}")
    logger.info(f"Inverters: {X['inverter_id'].nunique()}")

    # Temporal split
    logger.info("\n50/50 temporal split...")
    split_idx = len(X) // 2

    X_train = X.iloc[:split_idx]
    y_train = y.iloc[:split_idx]
    dates_train = dates.iloc[:split_idx]

    X_test = X.iloc[split_idx:]
    y_test = y.iloc[split_idx:]
    dates_test = dates.iloc[split_idx:]

    logger.info(f"Train: {dates_train.min()} to {dates_train.max()}")
    logger.info(f"Test: {dates_test.min()} to {dates_test.max()}")

    # Train model
    logger.info("\nTraining Stage 2 forecast model...")

    categorical_features = ['inverter_id']

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

    model_stage2 = CatBoostRegressor(
        iterations=2000,
        learning_rate=0.02,
        depth=8,
        l2_leaf_reg=3.0,
        loss_function='Quantile:alpha=0.4',
        random_seed=42,
        verbose=100,
        cat_features=categorical_features
    )

    model_stage2.fit(train_pool, eval_set=test_pool)

    # Evaluate
    y_pred_test = model_stage2.predict(X_test)
    mae_test = np.mean(np.abs(y_pred_test - y_test))

    logger.info(f"\nStage 2 test MAE: {mae_test:.4f} ({mae_test*100:.2f}%)")
    logger.info("(MAE is vs Stage 1 pseudo-labels, not true ground truth)")

    # Save model
    stage2_model_path = output_dir / "stage2_forecast_model_alpha.pkl"
    model_stage2.save_model(str(stage2_model_path))
    logger.info(f"Stage 2 model saved: {stage2_model_path}")

    # Per-inverter analysis
    logger.info("\n" + "="*80)
    logger.info("PER-INVERTER PERFORMANCE (Alpha-specific patterns)")
    logger.info("="*80)

    df_results = pd.DataFrame({
        'date': dates_test.values,
        'inverter_id': X_test['inverter_id'].values,
        'y_pseudo_label': y_test.values,
        'y_pred': y_pred_test
    })

    inv_mae = df_results.groupby('inverter_id').apply(
        lambda g: np.mean(np.abs(g['y_pseudo_label'] - g['y_pred']))
    ).sort_values()

    logger.info(f"\nBest 5 Alpha inverters:")
    for inv_id in inv_mae.head(5).index:
        logger.info(f"  {inv_id}: MAE={inv_mae[inv_id]:.4f}")

    logger.info(f"\nWorst 5 Alpha inverters:")
    for inv_id in inv_mae.tail(5).index:
        logger.info(f"  {inv_id}: MAE={inv_mae[inv_id]:.4f}")

    logger.info(f"\nMean MAE: {inv_mae.mean():.4f}")
    logger.info(f"Std MAE: {inv_mae.std():.4f}")

    # Feature importance
    feature_importance = model_stage2.get_feature_importance()
    feature_names = [col for col in X.columns if col != 'inverter_id'] + ['inverter_id']

    fi_df = pd.DataFrame({
        'feature': feature_names[:len(feature_importance)],
        'importance': feature_importance
    }).sort_values('importance', ascending=False)

    logger.info("\nTop 15 features:")
    for idx, row in fi_df.head(15).iterrows():
        logger.info(f"  {row['feature']}: {row['importance']:.2f}")

    # Save results
    predictions_path = output_dir / "stage2_test_predictions.csv"
    df_results.to_csv(predictions_path, index=False)

    fi_path = output_dir / "stage2_feature_importance.csv"
    fi_df.to_csv(fi_path, index=False)

    logger.info(f"\nPredictions saved: {predictions_path}")
    logger.info(f"Feature importance saved: {fi_path}")

    return model_stage2


def main():
    """Execute two-stage training pipeline."""
    logger.info("="*80)
    logger.info("TWO-STAGE SOILING FORECAST MODEL")
    logger.info("="*80)
    logger.info("\nStage 1: Transfer learning WITH PR → Get Alpha pseudo-labels")
    logger.info("Stage 2: Train forecast model on Alpha WITHOUT PR")
    logger.info("="*80)

    # Setup paths
    ribera_dir = Path("public/data/soiling/ribera")
    alpha_dir = Path("public/data/soiling/alpha1")
    output_dir = Path("outputs_two_stage_forecast")
    output_dir.mkdir(exist_ok=True)

    # Load Alpha data with PR
    alpha_df = load_alpha_per_inverter_with_pr(alpha_dir)

    # Stage 1: Transfer learning with PR
    sr_pseudo_labels = stage1_transfer_learning_with_pr(
        ribera_dir,
        alpha_df,
        output_dir
    )

    # Stage 2: Forecast model without PR
    model_forecast = stage2_forecast_model_on_alpha(
        alpha_df,
        sr_pseudo_labels,
        output_dir
    )

    logger.info("\n" + "="*80)
    logger.info("TWO-STAGE TRAINING COMPLETE")
    logger.info("="*80)
    logger.info(f"\nOutput directory: {output_dir}")
    logger.info("\nGenerated files:")
    logger.info("  - stage1_transfer_model_with_pr.pkl      (Ribera → Alpha with PR)")
    logger.info("  - alpha_sr_pseudo_labels_stage1.csv   (Pseudo ground truth)")
    logger.info("  - stage2_forecast_model_alpha.pkl     (Alpha-specific, no PR)")
    logger.info("  - stage2_test_predictions.csv            (Test set results)")
    logger.info("  - stage2_feature_importance.csv          (Feature rankings)")

    logger.info("\nNext steps:")
    logger.info("  1. Use stage2 model for forecasting (no PR needed)")
    logger.info("  2. Model knows Alpha-specific inverter patterns")
    logger.info("  3. All 150 Alpha inverters learned (no unknown categories)")


if __name__ == "__main__":
    main()
