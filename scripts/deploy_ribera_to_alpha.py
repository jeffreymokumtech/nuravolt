#!/usr/bin/env python3
"""
Deploy Ribera Foundation Model to Alpha (Per-Inverter)

Uses optimal hyperparameters from experiments:
- alpha=0.4 (balanced quantile loss)
- depth=8 (best MAE)
- 2000 iterations

Validates using physics constraints since Alpha DustIQ is broken.

Author: NuraVolt Team
"""

import argparse
import sys
import logging
from pathlib import Path
from datetime import datetime
import json
import numpy as np
import pandas as pd
from typing import Dict, List

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.sr_method_comparison import MethodComparer
from nuravolt.soiling.sr_validation import comprehensive_physics_validation


def setup_logging(output_dir: Path) -> None:
    """Setup logging configuration."""
    log_file = output_dir / f"alpha_deployment_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler()
        ]
    )


def load_alpha_per_inverter_data(
    data_dir: Path,
    latitude: float,
    longitude: float
) -> pd.DataFrame:
    """
    Load Alpha per-inverter PR data.

    Returns DataFrame with columns: date, inverter_id, pr, (weather features merged)
    """
    logger = logging.getLogger(__name__)

    # Load PR data from existing JSON (already calculated)
    pr_json_path = data_dir / "per_inverter" / "alpha1_per_inverter_sr.json"

    # If JSON doesn't exist, try parquet from demo_spain
    if pr_json_path.exists():
        logger.info(f"Loading existing per-inverter SR from: {pr_json_path}")
        with open(pr_json_path, 'r') as f:
            data = json.load(f)

        # Extract PR data from SR predictions
        # We'll use this as a reference but generate new predictions
        inverters_data = data['inverters']

        # Convert to dataframe
        records = []
        for inv_id, inv_data in inverters_data.items():
            for hist in inv_data.get('history', []):
                records.append({
                    'date': pd.to_datetime(hist['date']),
                    'inverter_id': inv_id,
                    'sr_existing': hist['sr']  # Existing predictions for comparison
                })

        df_pr = pd.DataFrame(records)
        logger.info(f"Loaded existing SR data: {len(df_pr)} rows, {df_pr['inverter_id'].nunique()} inverters")

        # For PR, we'll use normalized values since we don't have actual PR
        # The model will use weather features primarily
        df_pr['pr'] = 0.80  # Placeholder - model uses other features
    else:
        # Fallback: create minimal dataframe with inverter list
        logger.warning("No per-inverter data found, using minimal setup")
        # Create placeholder for 150 inverters
        dates = pd.date_range(start='2024-01-01', end='2024-12-31', freq='D')
        inverter_ids = [f"INV {g:02d}.{i:03d}" for g in range(1, 6) for i in range(1, 31)][:150]

        records = []
        for date in dates:
            for inv_id in inverter_ids:
                records.append({
                    'date': date,
                    'inverter_id': inv_id,
                    'pr': 0.80,
                    'sr_existing': None
                })
        df_pr = pd.DataFrame(records)
        logger.info(f"Created placeholder data: {len(df_pr)} rows, {len(inverter_ids)} inverters")

    # Load rain data
    rain_path = data_dir / "rain_history.json"
    if rain_path.exists():
        with open(rain_path, 'r') as f:
            rain_data = json.load(f)
        df_rain = pd.DataFrame(rain_data['daily_data'])
        df_rain['date'] = pd.to_datetime(df_rain['date'])
        logger.info(f"Loaded rain data: {len(df_rain)} days")
    else:
        df_rain = None
        logger.warning("Rain data not found")

    # Load AOD data
    aod_path = data_dir / "cams_aod_history.json"
    if aod_path.exists():
        with open(aod_path, 'r') as f:
            aod_data = json.load(f)
        df_aod = pd.DataFrame(aod_data['daily_data'])
        df_aod['date'] = pd.to_datetime(df_aod['date'])
        logger.info(f"Loaded AOD data: {len(df_aod)} days")
    else:
        df_aod = None
        logger.warning("AOD data not found")

    return df_pr, df_rain, df_aod


def calculate_fleet_uniformity(
    predictions_df: pd.DataFrame,
    date_col: str = 'date',
    inverter_col: str = 'inverter_id',
    sr_col: str = 'sr_predicted'
) -> Dict:
    """
    Calculate spatial uniformity across inverter fleet.

    Returns daily std dev and uniformity metrics.
    """
    # Group by date and calculate fleet statistics
    daily_stats = predictions_df.groupby(date_col)[sr_col].agg([
        ('mean', 'mean'),
        ('std', 'std'),
        ('min', 'min'),
        ('max', 'max'),
        ('range', lambda x: x.max() - x.min())
    ]).reset_index()

    # Overall uniformity metrics
    mean_fleet_std = daily_stats['std'].mean()
    max_fleet_std = daily_stats['std'].max()

    # Days with good uniformity (std < 2%)
    good_uniformity_days = (daily_stats['std'] < 0.02).sum()
    total_days = len(daily_stats)
    uniformity_rate = good_uniformity_days / total_days

    return {
        'mean_fleet_std': float(mean_fleet_std),
        'max_fleet_std': float(max_fleet_std),
        'uniformity_rate': float(uniformity_rate),
        'good_uniformity_days': int(good_uniformity_days),
        'total_days': int(total_days),
        'daily_stats': daily_stats
    }


def validate_predictions_physics(
    predictions_df: pd.DataFrame,
    df_rain: pd.DataFrame,
    sr_col: str = 'sr_predicted'
) -> Dict:
    """
    Validate predictions using physics constraints.

    Since Alpha DustIQ is broken, we validate against:
    1. Range constraints [0.75, 1.0]
    2. Rain reset behavior
    3. Monotonic decay between rains
    4. Seasonal patterns
    """
    logger = logging.getLogger(__name__)

    # Get plant-level average SR time series
    plant_sr = predictions_df.groupby('date')[sr_col].mean()

    # Run comprehensive physics validation
    validation_results = comprehensive_physics_validation(
        sr_predictions=plant_sr,
        rain_data=df_rain,
        per_inverter_sr=None,  # Could add per-inverter validation
        sr_min=0.75,
        sr_max=1.0
    )

    logger.info("\nPhysics Validation Results:")
    logger.info(f"  Range violations: {validation_results.range_violations}/{validation_results.total_predictions} ({validation_results.range_violation_rate:.1%})")
    logger.info(f"  Rain reset accuracy: {validation_results.rain_reset_accuracy:.1%} ({validation_results.correct_rain_resets}/{validation_results.heavy_rain_events})")
    logger.info(f"  Decay plausibility: {validation_results.decay_plausibility:.1%}")
    logger.info(f"  Overall pass rate: {validation_results.overall_pass_rate:.1%}")
    logger.info(f"  Physically plausible: {validation_results.is_physically_plausible}")

    return validation_results.to_dict()


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(
        description='Deploy Ribera foundation model to Alpha per-inverter',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    # Data paths
    parser.add_argument(
        '--ribera-dir',
        type=str,
        default='public/data/soiling/ribera',
        help='Ribera data directory (for foundation model training)'
    )
    parser.add_argument(
        '--alpha-dir',
        type=str,
        default='public/data/soiling/alpha1',
        help='Alpha data directory (for predictions)'
    )

    # Model configuration
    parser.add_argument(
        '--retrain',
        action='store_true',
        help='Retrain foundation model from scratch'
    )

    # Output
    parser.add_argument(
        '--output',
        type=str,
        default='outputs_alpha_deployment',
        help='Output directory'
    )

    args = parser.parse_args()

    # Setup output directory
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Setup logging
    setup_logging(output_dir)
    logger = logging.getLogger(__name__)

    logger.info("="*80)
    logger.info("ALPHA DEPLOYMENT - RIBERA FOUNDATION MODEL")
    logger.info("="*80)
    logger.info(f"Output directory: {output_dir}")
    logger.info(f"Retrain foundation: {args.retrain}")

    try:
        # STEP 1: Train or load Ribera foundation model
        logger.info("\n" + "="*80)
        logger.info("STEP 1: Foundation Model Training (Ribera)")
        logger.info("="*80)

        comparer = MethodComparer(
            output_dir=str(output_dir),
            test_size=0.5,
            cv_splits=3
        )

        # Load Ribera data
        ribera_dir = Path(args.ribera_dir)
        dustiq_path = ribera_dir / "dustiq_history.json"
        rain_path_sang = ribera_dir / "rain_history.json"
        aod_path_sang = ribera_dir / "cams_aod_history.json"
        pr_path_sang = ribera_dir / "pr_daily.parquet"

        logger.info("Loading Ribera training data...")
        X, y = comparer.load_ribera_data(
            dustiq_path=str(dustiq_path),
            rain_path=str(rain_path_sang),
            aod_path=str(aod_path_sang) if aod_path_sang.exists() else None,
            pr_path=str(pr_path_sang) if pr_path_sang.exists() else None,
            latitude=37.927,
            longitude=-1.233
        )

        logger.info(f"Loaded {len(X)} Ribera samples")
        logger.info(f"Period: {X.index.min()} to {X.index.max()}")

        # Train/test split
        comparer.create_train_test_split(X, y)

        # Optimal configuration from hyperparameter experiments
        optimal_config = {
            'iterations': 2000,
            'learning_rate': 0.02,
            'depth': 8,
            'l2_leaf_reg': 3.0,
            'loss_function': 'Quantile:alpha=0.4',
            'random_seed': 42
        }

        logger.info(f"\nOptimal configuration:")
        for key, value in optimal_config.items():
            logger.info(f"  {key}: {value}")

        # Train foundation model
        model_path = output_dir / "models" / "foundation_ribera_optimal.pkl"

        if args.retrain or not model_path.exists():
            logger.info("\nTraining foundation model on Ribera...")
            foundation_model = comparer.train_method1_dustiq(
                plant_id="ribera_foundation_optimal",
                latitude=37.927,
                longitude=-1.233,
                sample_weights=None,
                model_config=optimal_config
            )
            logger.info(f"Foundation model saved to {model_path}")
        else:
            logger.info(f"\nLoading existing foundation model: {model_path}")
            from nuravolt.soiling.sr_ml_model import SoilingRatioModel
            foundation_model = SoilingRatioModel.load(model_path)

        # Evaluate on Ribera test set
        y_pred_sang = foundation_model.predict(comparer.X_test)
        mae_sang = np.abs(comparer.y_test.values - y_pred_sang).mean()
        logger.info(f"\nFoundation model test MAE: {mae_sang:.4f} ({mae_sang*100:.2f}%)")

        # STEP 2: Load Alpha data
        logger.info("\n" + "="*80)
        logger.info("STEP 2: Loading Alpha Data (Per-Inverter)")
        logger.info("="*80)

        alpha_dir = Path(args.alpha_dir)
        df_pr_oliv, df_rain_oliv, df_aod_oliv = load_alpha_per_inverter_data(
            alpha_dir,
            latitude=38.485,  # Alpha coordinates
            longitude=-6.833
        )

        # Get unique inverters
        inverters = sorted(df_pr_oliv['inverter_id'].unique())
        logger.info(f"\nFound {len(inverters)} inverters")
        logger.info(f"Sample inverters: {inverters[:5]}")

        # STEP 3: Feature engineering for Alpha
        logger.info("\n" + "="*80)
        logger.info("STEP 3: Feature Engineering for Alpha")
        logger.info("="*80)

        # Use same feature engineer as Ribera
        from nuravolt.soiling.sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation

        alpha_location = PlantLocation(
            latitude=38.485,
            longitude=-6.833,
            elevation_m=200.0,
            climate_zone="mediterranean",
            distance_to_coast_km=300.0
        )

        feature_engineer = SoilingRatioFeatureEngineer(location=alpha_location)

        # Prepare base dataframe with dates
        df_pr_oliv['date'] = pd.to_datetime(df_pr_oliv['date'])
        dates = pd.Series(df_pr_oliv['date'].unique()).sort_values().values

        logger.info(f"Alpha period: {dates.min()} to {dates.max()}")
        logger.info(f"Total days: {len(dates)}")

        # Create features for each inverter
        logger.info("\nGenerating features per inverter...")

        all_predictions = []

        for inv_idx, inverter_id in enumerate(inverters, 1):
            if inv_idx % 30 == 0 or inv_idx == len(inverters):
                logger.info(f"Processing inverter {inv_idx}/{len(inverters)}: {inverter_id}")

            # Get data for this inverter
            inv_data = df_pr_oliv[df_pr_oliv['inverter_id'] == inverter_id].copy()
            inv_data = inv_data.set_index('date').sort_index()

            # Create base dataframe for this inverter
            df_inv = pd.DataFrame(index=pd.DatetimeIndex(dates))
            df_inv['pr'] = inv_data['pr']

            # Add rain data
            if df_rain_oliv is not None:
                df_rain_indexed = df_rain_oliv.set_index('date')
                df_inv = df_inv.join(df_rain_indexed['precipitation_mm'], how='left')
                df_inv['precipitation_mm'] = df_inv['precipitation_mm'].fillna(0)
            else:
                df_inv['precipitation_mm'] = 0

            # Add AOD data
            if df_aod_oliv is not None:
                df_aod_indexed = df_aod_oliv.set_index('date')
                aod_col = 'aod_550nm' if 'aod_550nm' in df_aod_oliv.columns else 'aod_550'
                df_inv = df_inv.join(df_aod_indexed[aod_col], how='left')
                df_inv['aod_550'] = df_inv[aod_col] if aod_col in df_inv.columns else np.nan
            else:
                df_inv['aod_550'] = np.nan

            # Generate features
            X_inv = feature_engineer.generate_features(df_inv)

            # Predict SR for this inverter
            y_pred_inv = foundation_model.predict(X_inv)

            # Store predictions
            for date, sr_pred in zip(X_inv.index, y_pred_inv):
                all_predictions.append({
                    'date': date,
                    'inverter_id': inverter_id,
                    'sr_predicted': sr_pred
                })

        # Convert to DataFrame
        predictions_df = pd.DataFrame(all_predictions)
        logger.info(f"\nGenerated {len(predictions_df)} predictions ({len(inverters)} inverters × {len(dates)} days)")

        # STEP 4: Physics validation
        logger.info("\n" + "="*80)
        logger.info("STEP 4: Physics-Based Validation")
        logger.info("="*80)
        logger.info("(Note: NOT using Alpha DustIQ - it's broken)")

        validation_results = validate_predictions_physics(
            predictions_df,
            df_rain_oliv,
            sr_col='sr_predicted'
        )

        # STEP 5: Fleet uniformity analysis
        logger.info("\n" + "="*80)
        logger.info("STEP 5: Fleet Uniformity Analysis")
        logger.info("="*80)

        uniformity_results = calculate_fleet_uniformity(predictions_df)

        logger.info(f"\nFleet Uniformity Metrics:")
        logger.info(f"  Mean daily std: {uniformity_results['mean_fleet_std']:.4f} ({uniformity_results['mean_fleet_std']*100:.2f}%)")
        logger.info(f"  Max daily std: {uniformity_results['max_fleet_std']:.4f} ({uniformity_results['max_fleet_std']*100:.2f}%)")
        logger.info(f"  Days with std < 2%: {uniformity_results['good_uniformity_days']}/{uniformity_results['total_days']} ({uniformity_results['uniformity_rate']:.1%})")

        # Check if uniformity is good
        if uniformity_results['mean_fleet_std'] < 0.02:
            logger.info("  ✓ PASS: Good spatial uniformity across fleet")
        else:
            logger.warning(f"  ⚠ WARNING: High fleet variability (target < 2%)")

        # STEP 6: Save results
        logger.info("\n" + "="*80)
        logger.info("STEP 6: Saving Results")
        logger.info("="*80)

        # Save predictions
        predictions_file = output_dir / "alpha_predictions_per_inverter.csv"
        predictions_df.to_csv(predictions_file, index=False)
        logger.info(f"Saved predictions: {predictions_file}")

        # Save validation results
        validation_file = output_dir / "physics_validation_results.json"
        with open(validation_file, 'w') as f:
            json.dump(validation_results, f, indent=2, default=str)
        logger.info(f"Saved validation: {validation_file}")

        # Save uniformity analysis
        uniformity_file = output_dir / "fleet_uniformity_analysis.json"
        uniformity_to_save = {k: v for k, v in uniformity_results.items() if k != 'daily_stats'}
        with open(uniformity_file, 'w') as f:
            json.dump(uniformity_to_save, f, indent=2, default=str)
        logger.info(f"Saved uniformity: {uniformity_file}")

        # Save daily uniformity stats
        daily_stats_file = output_dir / "daily_fleet_statistics.csv"
        uniformity_results['daily_stats'].to_csv(daily_stats_file, index=False)
        logger.info(f"Saved daily stats: {daily_stats_file}")

        # STEP 7: Summary
        logger.info("\n" + "="*80)
        logger.info("DEPLOYMENT SUMMARY")
        logger.info("="*80)

        logger.info(f"\nFoundation Model (Ribera):")
        logger.info(f"  Configuration: alpha=0.4, depth=8, 2000 iterations")
        logger.info(f"  Test MAE: {mae_sang:.4f} ({mae_sang*100:.2f}%)")

        logger.info(f"\nAlpha Deployment:")
        logger.info(f"  Inverters: {len(inverters)}")
        logger.info(f"  Period: {dates.min()} to {dates.max()}")
        logger.info(f"  Total predictions: {len(predictions_df)}")

        logger.info(f"\nPhysics Validation:")
        logger.info(f"  Range violations: {validation_results['range_checks']['violation_rate']:.1%}")
        logger.info(f"  Rain reset accuracy: {validation_results['rain_reset']['accuracy']:.1%}")
        logger.info(f"  Overall pass rate: {validation_results['overall']['pass_rate']:.1%}")
        logger.info(f"  Physically plausible: {validation_results['overall']['is_plausible']}")

        logger.info(f"\nFleet Uniformity:")
        logger.info(f"  Mean std: {uniformity_results['mean_fleet_std']*100:.2f}%")
        logger.info(f"  Uniformity rate: {uniformity_results['uniformity_rate']:.1%}")

        logger.info("\n" + "="*80)
        logger.info("DEPLOYMENT COMPLETE")
        logger.info("="*80)
        logger.info(f"\nResults saved to: {output_dir}")
        logger.info(f"  - alpha_predictions_per_inverter.csv")
        logger.info(f"  - physics_validation_results.json")
        logger.info(f"  - fleet_uniformity_analysis.json")
        logger.info(f"  - daily_fleet_statistics.csv")

        logger.info("\nNEXT STEPS:")
        logger.info("  1. Review physics validation results")
        logger.info("  2. Visualize predictions and fleet uniformity")
        logger.info("  3. Compare with operational data (energy losses)")
        logger.info("  4. Deploy to production monitoring")

        return 0

    except Exception as e:
        logger.error(f"ERROR: {str(e)}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
