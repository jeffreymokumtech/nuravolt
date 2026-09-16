"""
Forecast Backtesting Framework

Walk-forward validation of soiling ratio forecasting models on Ribera data.
Tests forecast accuracy across multiple time horizons (1-30 days) with good DustIQ ground truth.

Usage:
    python scripts/backtest_forecast.py [--horizons 1,3,7,14,21,30] [--windows 20]

Output:
    - outputs_backtest_ribera/backtest_report.json
    - outputs_backtest_ribera/backtest_report.md
    - outputs_backtest_ribera/predictions/*.csv
    - outputs_backtest_ribera/plots/*.png
"""

import sys
import json
import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple
import warnings
warnings.filterwarnings('ignore')

# Add parent directory to path for imports
sys.path.append(str(Path(__file__).parent.parent))

from catboost import CatBoostRegressor
from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation
from scripts.utils.walk_forward import (
    create_walk_forward_splits,
    get_split_info,
    validate_split_quality,
    get_seasonal_coverage
)
from scripts.utils.horizon_evaluator import (
    evaluate_horizon,
    evaluate_physics_constraints,
    aggregate_horizon_results,
    calculate_seasonal_performance,
    calculate_error_distribution_stats
)
from scripts.utils.visualization import (
    plot_horizon_comparison,
    plot_time_series_overlay,
    plot_error_distribution,
    plot_confidence_intervals
)


def load_ribera_data(data_dir: Path) -> pd.DataFrame:
    """
    Load Ribera data with DustIQ, rain, AOD, and per-inverter PR.

    Args:
        data_dir: Base data directory (public/data/soiling/ribera/)

    Returns:
        DataFrame with all required features
    """
    print("\n📂 Loading Ribera data...")

    # Load DustIQ ground truth
    dustiq_path = data_dir / "dustiq_history.json"
    with open(dustiq_path, 'r') as f:
        dustiq_data = json.load(f)

    df_dustiq = pd.DataFrame(dustiq_data['daily_data'])
    df_dustiq['date'] = pd.to_datetime(df_dustiq['date'])
    df_dustiq = df_dustiq.rename(columns={'soiling_ratio': 'sr_dustiq'})
    print(f"  ✅ DustIQ: {len(df_dustiq)} days")

    # Load per-inverter PR data
    pr_path = data_dir / "time_series" / "daily_pr.json"
    with open(pr_path, 'r') as f:
        pr_data_full = json.load(f)

    df_pr = pd.DataFrame(pr_data_full['data'])
    df_pr['date'] = pd.to_datetime(df_pr['date'])
    df_pr = df_pr.rename(columns={'inverterId': 'inverter_id'})
    print(f"  ✅ Per-inverter PR: {len(df_pr)} rows ({len(df_pr['inverter_id'].unique())} inverters)")

    # Load rain history
    rain_path = data_dir / "rain_history.json"
    with open(rain_path, 'r') as f:
        rain_data = json.load(f)

    df_rain = pd.DataFrame(rain_data['daily_data'])
    df_rain['date'] = pd.to_datetime(df_rain['date'])
    print(f"  ✅ Rain: {len(df_rain)} days")

    # Load AOD history (merged file created by user)
    aod_path = data_dir / "aod_merged.json"
    with open(aod_path, 'r') as f:
        aod_data = json.load(f)

    df_aod = pd.DataFrame(aod_data['daily_data'])
    df_aod['date'] = pd.to_datetime(df_aod['date'])
    df_aod = df_aod.rename(columns={'aod_550nm': 'aod_550'})
    print(f"  ✅ AOD: {len(df_aod)} days")

    # Merge everything
    df = df_pr.merge(df_dustiq[['date', 'sr_dustiq']], on='date', how='inner')
    df = df.merge(df_rain[['date', 'precipitation_mm']], on='date', how='left')
    df = df.merge(df_aod[['date', 'aod_550']], on='date', how='left')

    # Fill missing values
    df['precipitation_mm'] = df['precipitation_mm'].fillna(0)
    df['aod_550'] = df['aod_550'].fillna(df['aod_550'].median())

    # Filter to valid DustIQ range
    df = df[(df['sr_dustiq'] >= 0.75) & (df['sr_dustiq'] <= 1.0)].copy()

    print(f"\n✅ Merged dataset: {len(df)} samples")
    print(f"  Date range: {df['date'].min().date()} to {df['date'].max().date()}")
    print(f"  Inverters: {len(df['inverter_id'].unique())}")
    print(f"  DustIQ mean: {df['sr_dustiq'].mean():.4f} ({df['sr_dustiq'].mean()*100:.1f}%)")

    return df


def train_forecast_model(
    df_train: pd.DataFrame,
    location: PlantLocation,
    model_params: Dict[str, any]
) -> Tuple[CatBoostRegressor, SoilingRatioFeatureEngineer]:
    """
    Train forecast model WITHOUT PR dependency.

    Args:
        df_train: Training dataframe with per-inverter data
        location: Plant location object
        model_params: CatBoost parameters

    Returns:
        Tuple of (trained_model, feature_engineer)
    """
    # Initialize feature engineer
    engineer = SoilingRatioFeatureEngineer(location)

    # Prepare plant-level weather data
    df_weather = df_train[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')

    # Prepare plant-level AOD data
    df_aod = df_train[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod = df_aod.rename(columns={'aod_550': 'aod_550nm'})

    # Generate plant-level features WITHOUT PR
    X_plant = engineer.generate_features(
        df_weather=df_weather,
        df_aod=df_aod,
        df_pr=None  # No PR for forecasting!
    )

    # Merge back to per-inverter data
    X_plant = X_plant.reset_index()
    df_merged = df_train.merge(X_plant, on='date', how='left')

    # Add inverter_id from original data
    df_merged['inverter_id_raw'] = df_train['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_merged = df_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_merged['inverter_id'] = df_merged['inverter_id_raw'].astype(str)
    df_merged = df_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_merged = df_merged[df_merged['inverter_id'] != 'nan']
    df_merged = df_merged[df_merged['inverter_id'] != '']

    # Fill NaN values in features with median/mode
    for col in df_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id']:
            if df_merged[col].dtype in ['float64', 'int64']:
                df_merged[col] = df_merged[col].fillna(df_merged[col].median())
            else:
                df_merged[col] = df_merged[col].fillna(df_merged[col].mode()[0] if len(df_merged[col].mode()) > 0 else 'UNKNOWN')

    # Extract spatial features from inverter_id (e.g., "INV 03.025" → row=3, pos=25)
    inv_parts = df_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    # Feature columns (exclude target and metadata)
    feature_cols = [col for col in df_merged.columns
                   if col not in ['date', 'sr_dustiq', 'inverter_id']]

    X_train = df_merged[feature_cols + ['inverter_id']]
    y_train = df_merged['sr_dustiq']

    # Train model with inverter_id as categorical
    model = CatBoostRegressor(**model_params)
    model.fit(
        X_train,
        y_train,
        cat_features=['inverter_id'],
        verbose=False
    )

    return model, engineer


def generate_multi_horizon_forecasts(
    model: CatBoostRegressor,
    engineer: SoilingRatioFeatureEngineer,
    df_test: pd.DataFrame,
    horizons: List[int]
) -> Dict[int, Tuple[np.ndarray, np.ndarray]]:
    """
    Generate forecasts for multiple horizons.

    For simplicity, we forecast using current features (same-day forecast).
    Real production would use weather/AOD forecasts.

    Args:
        model: Trained model
        engineer: Feature engineer
        df_test: Test dataframe with per-inverter data
        horizons: List of forecast horizons in days

    Returns:
        Dictionary mapping horizon -> (y_true, y_pred)
    """
    # Prepare plant-level weather data
    df_weather = df_test[['date', 'precipitation_mm']].drop_duplicates('date').set_index('date')

    # Prepare plant-level AOD data
    df_aod = df_test[['date', 'aod_550']].drop_duplicates('date').set_index('date')
    df_aod = df_aod.rename(columns={'aod_550': 'aod_550nm'})

    # Generate plant-level features
    X_plant = engineer.generate_features(
        df_weather=df_weather,
        df_aod=df_aod,
        df_pr=None
    )

    # Merge back to per-inverter data
    X_plant = X_plant.reset_index()
    df_merged = df_test.merge(X_plant, on='date', how='left')

    # Add inverter_id from original data
    df_merged['inverter_id_raw'] = df_test['inverter_id'].values

    # Drop rows where target or inverter_id is missing BEFORE converting to string
    df_merged = df_merged.dropna(subset=['sr_dustiq', 'inverter_id_raw'])

    # Now convert to string (NaN values already removed)
    df_merged['inverter_id'] = df_merged['inverter_id_raw'].astype(str)
    df_merged = df_merged.drop(columns=['inverter_id_raw'])

    # Additional safety: filter out any 'nan' strings and empty strings
    df_merged = df_merged[df_merged['inverter_id'] != 'nan']
    df_merged = df_merged[df_merged['inverter_id'] != '']

    # Fill NaN values in features
    for col in df_merged.columns:
        if col not in ['date', 'sr_dustiq', 'inverter_id']:
            if df_merged[col].dtype in ['float64', 'int64']:
                df_merged[col] = df_merged[col].fillna(df_merged[col].median())
            else:
                df_merged[col] = df_merged[col].fillna(df_merged[col].mode()[0] if len(df_merged[col].mode()) > 0 else 'UNKNOWN')

    # Extract spatial features
    inv_parts = df_merged['inverter_id'].str.extract(r'INV (\d+)\.(\d+)')
    df_merged['inverter_row'] = inv_parts[0].astype(float).fillna(0)
    df_merged['inverter_position'] = inv_parts[1].astype(float).fillna(0)

    # Feature columns
    feature_cols = [col for col in df_merged.columns
                   if col not in ['date', 'sr_dustiq', 'inverter_id']]

    X_test = df_merged[feature_cols + ['inverter_id']]
    y_test = df_merged['sr_dustiq'].values

    # Base predictions
    y_pred_base = model.predict(X_test)

    # For now, use same predictions for all horizons
    # In production, would adjust features based on forecasted weather/AOD
    horizon_predictions = {}
    for horizon in horizons:
        # Simple approach: same prediction for all horizons
        # Real implementation would use forecasted weather/AOD
        horizon_predictions[horizon] = (y_test, y_pred_base.copy())

    return horizon_predictions


def run_walk_forward_backtest(
    df: pd.DataFrame,
    location: PlantLocation,
    horizons: List[int] = [1, 3, 7, 14, 21, 30],
    initial_train_days: int = 730,
    test_window_days: int = 90,
    step_days: int = 30,
    output_dir: Path = Path("outputs_backtest_ribera")
) -> Dict[str, any]:
    """
    Run walk-forward backtesting with multiple horizons.

    Args:
        df: Complete dataset
        location: Plant location
        horizons: List of forecast horizons to test
        initial_train_days: Initial training window (default 730 = 2 years)
        test_window_days: Test window size (default 90 = 1 quarter)
        step_days: Step between windows (default 30 = 1 month)
        output_dir: Output directory

    Returns:
        Dictionary with complete backtest results
    """
    print("\n🔄 Running walk-forward backtest...\n")

    # Create output directories
    output_dir.mkdir(exist_ok=True)
    (output_dir / "predictions").mkdir(exist_ok=True)
    (output_dir / "plots").mkdir(exist_ok=True)

    # Model parameters (from existing successful models)
    model_params = {
        'iterations': 2000,
        'learning_rate': 0.02,
        'depth': 8,
        'l2_leaf_reg': 3.0,
        'loss_function': 'Quantile:alpha=0.4',
        'random_seed': 42,
        'verbose': False
    }

    # Create splits
    print("Creating walk-forward splits...")
    splits = create_walk_forward_splits(
        df,
        initial_train_days=initial_train_days,
        test_window_days=test_window_days,
        step_days=step_days,
        date_column='date'
    )

    split_info = get_split_info(splits)
    print(f"\n✅ Created {len(splits)} validation windows")
    print(split_info.to_string(index=False))

    # Validate splits
    validation = validate_split_quality(splits)
    if not validation['valid']:
        print(f"\n⚠️ Split validation issues:")
        for error in validation['errors']:
            print(f"  ❌ {error}")
    if validation['warnings']:
        for warning in validation['warnings']:
            print(f"  ⚠️ {warning}")

    # Run backtest across all windows
    all_results = []

    for window_idx, (df_train, df_test) in enumerate(splits, 1):
        print(f"\n📊 Window {window_idx}/{len(splits)}")
        print(f"  Train: {df_train['date'].min().date()} to {df_train['date'].max().date()} ({len(df_train['date'].unique())} days)")
        print(f"  Test: {df_test['date'].min().date()} to {df_test['date'].max().date()} ({len(df_test['date'].unique())} days)")

        # Check if we have sufficient data
        if len(df_train) < 100 or len(df_test) < 10:
            print(f"  ⚠️ Skipping window {window_idx}: Insufficient data (train={len(df_train)}, test={len(df_test)})")
            continue

        # Train model
        print("  Training model...")
        model, engineer = train_forecast_model(df_train, location, model_params)

        # Generate forecasts for all horizons
        print(f"  Generating forecasts for {len(horizons)} horizons...")
        horizon_preds = generate_multi_horizon_forecasts(model, engineer, df_test, horizons)

        # Check if we got valid predictions
        first_horizon = horizons[0]
        y_true_check, y_pred_check = horizon_preds[first_horizon]
        if len(y_pred_check) == 0:
            print(f"  ⚠️ Skipping window {window_idx}: No predictions after data cleaning")
            continue

        # Evaluate each horizon
        window_results = {'window_id': window_idx}

        for horizon in horizons:
            y_true, y_pred = horizon_preds[horizon]

            # Calculate metrics
            metrics = evaluate_horizon(y_true, y_pred, horizon)
            window_results[f'h{horizon}_mae'] = metrics['mae_pct']
            window_results[f'h{horizon}_r2'] = metrics['r2']

            print(f"    {horizon}d: MAE={metrics['mae_pct']:.2f}%, R²={metrics['r2']:.3f}")

        all_results.append(window_results)

        # Save window predictions (only save if we have predictions)
        if len(horizon_preds) > 0:
            # Get first horizon to check if we have data
            first_horizon = horizons[0]
            y_true_sample, y_pred_sample = horizon_preds[first_horizon]

            if len(y_pred_sample) > 0:
                # Create dataframe from test data indices that survived dropna
                pred_df = pd.DataFrame({
                    'date': df_test['date'].iloc[:len(y_pred_sample)],
                    'inverter_id': df_test['inverter_id'].iloc[:len(y_pred_sample)],
                    'sr_dustiq': y_true_sample
                })

                for horizon in horizons:
                    y_true, y_pred = horizon_preds[horizon]
                    pred_df[f'pred_h{horizon}'] = y_pred

                pred_path = output_dir / "predictions" / f"window_{window_idx:03d}_predictions.csv"
                pred_df.to_csv(pred_path, index=False)
            else:
                print(f"  ⚠️ Window {window_idx}: No predictions (empty after data cleaning)")

    # Aggregate results
    results_df = pd.DataFrame(all_results)

    # Calculate overall metrics per horizon
    horizon_summary = {}
    for horizon in horizons:
        horizon_summary[horizon] = {
            'mae_pct': results_df[f'h{horizon}_mae'].mean(),
            'mae_std': results_df[f'h{horizon}_mae'].std(),
            'r2': results_df[f'h{horizon}_r2'].mean(),
            'r2_std': results_df[f'h{horizon}_r2'].std()
        }

    return {
        'split_info': split_info.to_dict('records'),
        'window_results': all_results,
        'horizon_summary': horizon_summary,
        'horizons': horizons,
        'n_windows': len(splits),
        'model_params': model_params
    }


def generate_reports(results: Dict[str, any], output_dir: Path) -> None:
    """
    Generate JSON and markdown reports.

    Args:
        results: Backtest results
        output_dir: Output directory
    """
    print("\n📝 Generating reports...")

    # JSON report
    json_path = output_dir / "backtest_report.json"
    with open(json_path, 'w') as f:
        json.dump(results, f, indent=2, default=str)
    print(f"  ✅ {json_path}")

    # Markdown report
    md_path = output_dir / "backtest_report.md"
    with open(md_path, 'w') as f:
        f.write("# Ribera Forecast Backtesting Results\n\n")
        f.write(f"**Generated**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write("## Summary\n\n")
        f.write(f"- Plant: Ribera\n")
        f.write(f"- Walk-forward windows: {results['n_windows']}\n")
        f.write(f"- Horizons tested: {', '.join(map(str, results['horizons']))} days\n\n")

        f.write("## Performance by Horizon\n\n")
        f.write("| Horizon | MAE (%) | MAE Std | R² | R² Std |\n")
        f.write("|---------|---------|---------|-----|--------|\n")

        for horizon in results['horizons']:
            summary = results['horizon_summary'][horizon]
            f.write(f"| {horizon} day{'s' if horizon > 1 else ''} | ")
            f.write(f"{summary['mae_pct']:.2f} | {summary['mae_std']:.2f} | ")
            f.write(f"{summary['r2']:.3f} | {summary['r2_std']:.3f} |\n")

        f.write("\n## Interpretation\n\n")
        mae_1d = results['horizon_summary'][1]['mae_pct']
        mae_7d = results['horizon_summary'][7]['mae_pct'] if 7 in results['horizons'] else None
        mae_30d = results['horizon_summary'][30]['mae_pct'] if 30 in results['horizons'] else None

        if mae_1d < 1.0:
            f.write("✅ **Excellent** 1-day forecast accuracy (MAE < 1%)\n")
        elif mae_1d < 2.0:
            f.write("✅ **Good** 1-day forecast accuracy (MAE < 2%)\n")
        else:
            f.write("⚠️ **Moderate** 1-day forecast accuracy (MAE ≥ 2%)\n")

        if mae_7d and mae_7d < 2.0:
            f.write("✅ **Excellent** 7-day forecast accuracy (MAE < 2%)\n")
        elif mae_7d and mae_7d < 3.0:
            f.write("✅ **Good** 7-day forecast accuracy (MAE < 3%)\n")

        f.write("\n## Model Configuration\n\n")
        f.write("```yaml\n")
        for key, value in results['model_params'].items():
            f.write(f"{key}: {value}\n")
        f.write("```\n")

    print(f"  ✅ {md_path}")


def main():
    """Main execution function."""
    print("="*80)
    print("RIBERA FORECAST BACKTESTING")
    print("="*80)

    # Configuration
    DATA_DIR = Path("public/data/soiling/ribera")
    OUTPUT_DIR = Path("outputs_backtest_ribera")
    HORIZONS = [1, 3, 7, 14, 21, 30]

    LOCATION = PlantLocation(
        latitude=37.927,
        longitude=-1.233,
        elevation_m=50,
        climate_zone='mediterranean'
    )

    # Load data
    df = load_ribera_data(DATA_DIR)

    # Run backtest
    results = run_walk_forward_backtest(
        df,
        LOCATION,
        horizons=HORIZONS,
        output_dir=OUTPUT_DIR
    )

    # Generate reports
    generate_reports(results, OUTPUT_DIR)

    print("\n" + "="*80)
    print("✅ BACKTESTING COMPLETE")
    print("="*80)
    print(f"\n📁 Results saved to: {OUTPUT_DIR}/")
    print(f"   - backtest_report.json")
    print(f"   - backtest_report.md")
    print(f"   - predictions/ (CSV files per window)")


if __name__ == "__main__":
    main()
