#!/usr/bin/env python3
"""
Hyperparameter Experiments with 50/50 Split and Multi-Day Rain Reset Validation

Changes from original:
- 50/50 temporal split (first half train, second half test)
- Full AOD and rain data usage
- Hyperparameter grid search
- Multi-day rain reset windows (0-2, 3-5, 5-7 days)

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
from typing import Dict, List, Tuple

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.sr_method_comparison import MethodComparer
from nuravolt.soiling.sr_validation import validate_rain_resets
from nuravolt.soiling.sr_model_evaluation import ModelEvaluator


def setup_logging(output_dir: Path) -> None:
    """Setup logging configuration."""
    log_file = output_dir / f"hyperparam_experiments_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler()
        ]
    )


def validate_rain_resets_multiday(
    y_pred: pd.Series,
    df_rain: pd.DataFrame,
    rain_threshold: float = 5.0
) -> Dict[str, float]:
    """
    Validate rain resets with multiple time windows.

    Returns accuracy for different windows after rain.
    """
    results = {}

    # Window configurations: (start_day, end_day, name)
    windows = [
        (0, 2, "0-2_days"),      # Immediate (original)
        (0, 5, "0-5_days"),      # Extended immediate
        (3, 5, "3-5_days"),      # Delayed
        (3, 7, "3-7_days"),      # Extended delayed
        (5, 7, "5-7_days"),      # Late
    ]

    for start, end, name in windows:
        events, correct, accuracy = validate_rain_resets(
            y_pred,
            df_rain,
            heavy_rain_threshold_mm=rain_threshold,
            reset_threshold_sr=0.99,
            check_window_days=end,
            check_window_start=start
        )

        results[f"rain_reset_{name}"] = accuracy
        results[f"rain_events_{name}"] = events

    return results


def run_hyperparameter_experiment(
    comparer: MethodComparer,
    config: Dict,
    config_name: str,
    output_dir: Path,
    df_rain: pd.DataFrame,
    rain_threshold: float
) -> Dict:
    """Run single hyperparameter configuration experiment."""

    logger = logging.getLogger(__name__)
    logger.info(f"\n{'='*80}")
    logger.info(f"EXPERIMENT: {config_name}")
    logger.info(f"{'='*80}")
    logger.info(f"Config: {config}")

    # Train model
    model = comparer.train_method1_dustiq(
        plant_id=f"ribera_{config_name}",
        latitude=37.927,
        longitude=-1.233,
        sample_weights=None,
        model_config=config
    )

    # Predict on test set
    y_pred = model.predict(comparer.X_test)
    y_pred_series = pd.Series(y_pred, index=comparer.X_test.index)

    # Evaluate
    evaluator = ModelEvaluator(
        sr_min=0.75,
        sr_max=1.0,
        heavy_rain_threshold_mm=rain_threshold
    )

    metrics = evaluator.evaluate_predictions(
        comparer.y_test,
        y_pred_series,
        df_rain
    )

    # Multi-day rain reset validation
    rain_reset_results = validate_rain_resets_multiday(
        y_pred_series,
        df_rain,
        rain_threshold
    )

    # Combine results
    results = {
        'config_name': config_name,
        'config': config,
        'mae': metrics.mae,
        'rmse': metrics.rmse,
        'r2': metrics.r2,
        'bias': metrics.bias,
        'correlation': metrics.correlation,
        'mape': metrics.mape,
        'range_violations': metrics.range_violations,
        **rain_reset_results
    }

    logger.info(f"Results for {config_name}:")
    logger.info(f"  MAE: {metrics.mae:.4f}")
    logger.info(f"  R²: {metrics.r2:.4f}")
    logger.info(f"  Rain Reset 0-2d: {rain_reset_results.get('rain_reset_0-2_days', 0):.2%}")
    logger.info(f"  Rain Reset 3-7d: {rain_reset_results.get('rain_reset_3-7_days', 0):.2%}")

    return results


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(
        description='Hyperparameter experiments with 50/50 split',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    # Data paths
    parser.add_argument(
        '--data-dir',
        type=str,
        default='public/data/soiling',
        help='Base data directory'
    )

    # Improvements
    parser.add_argument(
        '--rain-threshold',
        type=float,
        default=5.0,
        help='Rain threshold for validation (mm)'
    )

    # Output
    parser.add_argument(
        '--output',
        type=str,
        default='outputs_hyperparam_experiments',
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
    logger.info("HYPERPARAMETER EXPERIMENTS - 50/50 SPLIT")
    logger.info("="*80)
    logger.info(f"Output directory: {output_dir}")
    logger.info(f"Rain threshold: {args.rain_threshold}mm")
    logger.info(f"Train/Test split: 50/50 (temporal)")

    try:
        # Initialize comparer with 50/50 split
        comparer = MethodComparer(
            output_dir=args.output,
            test_size=0.5,  # 50/50 split
            cv_splits=3
        )

        # Data paths
        data_dir = Path(args.data_dir)
        ribera_dir = data_dir / "ribera"

        dustiq_path = ribera_dir / "dustiq_history.json"
        rain_path = ribera_dir / "rain_history.json"
        aod_path = ribera_dir / "cams_aod_history.json"
        pr_path = ribera_dir / "pr_daily.parquet"

        # Verify files
        for path in [dustiq_path, rain_path]:
            if not path.exists():
                logger.error(f"Required file not found: {path}")
                return 1

        # STEP 1: Load data
        logger.info("\n" + "="*80)
        logger.info("STEP 1: Loading Ribera Data (Full History)")
        logger.info("="*80)

        X, y = comparer.load_ribera_data(
            dustiq_path=str(dustiq_path),
            rain_path=str(rain_path),
            aod_path=str(aod_path) if aod_path.exists() else None,
            pr_path=str(pr_path) if pr_path.exists() else None,
            latitude=37.927,
            longitude=-1.233
        )

        logger.info(f"Total samples: {len(X)}")
        logger.info(f"Period: {X.index.min()} to {X.index.max()}")

        # STEP 2: Create 50/50 split
        logger.info("\n" + "="*80)
        logger.info("STEP 2: Creating 50/50 Temporal Split")
        logger.info("="*80)

        comparer.create_train_test_split(X, y)

        logger.info(f"Train period: {comparer.X_train.index.min()} to {comparer.X_train.index.max()}")
        logger.info(f"Test period: {comparer.X_test.index.min()} to {comparer.X_test.index.max()}")

        # Load rain data for validation
        with open(rain_path, 'r') as f:
            rain_data = json.load(f)
        df_rain = pd.DataFrame(rain_data['daily_data'])
        df_rain['date'] = pd.to_datetime(df_rain['date'])
        df_rain = df_rain.set_index('date')

        # STEP 3: Define hyperparameter configurations
        logger.info("\n" + "="*80)
        logger.info("STEP 3: Hyperparameter Grid")
        logger.info("="*80)

        # Hyperparameter configurations to test
        configs = {
            'baseline': {
                'iterations': 2000,
                'learning_rate': 0.02,
                'depth': 6,
                'l2_leaf_reg': 3.0,
                'loss_function': 'Quantile:alpha=0.3',
                'random_seed': 42
            },
            'alpha_0.4': {
                'iterations': 2000,
                'learning_rate': 0.02,
                'depth': 6,
                'l2_leaf_reg': 3.0,
                'loss_function': 'Quantile:alpha=0.4',
                'random_seed': 42
            },
            'alpha_0.5': {
                'iterations': 2000,
                'learning_rate': 0.02,
                'depth': 6,
                'l2_leaf_reg': 3.0,
                'loss_function': 'Quantile:alpha=0.5',
                'random_seed': 42
            },
            'deeper': {
                'iterations': 2000,
                'learning_rate': 0.02,
                'depth': 8,
                'l2_leaf_reg': 3.0,
                'loss_function': 'Quantile:alpha=0.3',
                'random_seed': 42
            },
            'more_reg': {
                'iterations': 2000,
                'learning_rate': 0.02,
                'depth': 6,
                'l2_leaf_reg': 5.0,
                'loss_function': 'Quantile:alpha=0.3',
                'random_seed': 42
            },
            'higher_lr': {
                'iterations': 2000,
                'learning_rate': 0.03,
                'depth': 6,
                'l2_leaf_reg': 3.0,
                'loss_function': 'Quantile:alpha=0.3',
                'random_seed': 42
            },
            'more_iters': {
                'iterations': 3000,
                'learning_rate': 0.02,
                'depth': 6,
                'l2_leaf_reg': 3.0,
                'loss_function': 'Quantile:alpha=0.3',
                'random_seed': 42
            },
        }

        logger.info(f"Testing {len(configs)} configurations:")
        for name, config in configs.items():
            logger.info(f"  - {name}: {config}")

        # STEP 4: Run experiments
        logger.info("\n" + "="*80)
        logger.info("STEP 4: Running Experiments")
        logger.info("="*80)

        all_results = []
        for config_name, config in configs.items():
            result = run_hyperparameter_experiment(
                comparer,
                config,
                config_name,
                output_dir,
                df_rain,
                args.rain_threshold
            )
            all_results.append(result)

        # STEP 5: Analysis and comparison
        logger.info("\n" + "="*80)
        logger.info("STEP 5: Results Analysis")
        logger.info("="*80)

        # Convert to DataFrame for easy comparison
        df_results = pd.DataFrame(all_results)

        # Save full results
        df_results.to_csv(output_dir / "hyperparam_results.csv", index=False)

        # Save JSON with full details
        with open(output_dir / "hyperparam_results.json", 'w') as f:
            json.dump(all_results, f, indent=2, default=str)

        # Find best configurations for different metrics
        best_mae_idx = df_results['mae'].idxmin()
        best_r2_idx = df_results['r2'].idxmax()
        best_rain_reset_02_idx = df_results['rain_reset_0-2_days'].idxmax()
        best_rain_reset_37_idx = df_results['rain_reset_3-7_days'].idxmax()

        logger.info("\n" + "="*80)
        logger.info("BEST CONFIGURATIONS")
        logger.info("="*80)

        logger.info(f"\nBest MAE: {df_results.loc[best_mae_idx, 'config_name']}")
        logger.info(f"  MAE: {df_results.loc[best_mae_idx, 'mae']:.4f}")
        logger.info(f"  R²: {df_results.loc[best_mae_idx, 'r2']:.4f}")

        logger.info(f"\nBest R²: {df_results.loc[best_r2_idx, 'config_name']}")
        logger.info(f"  MAE: {df_results.loc[best_r2_idx, 'mae']:.4f}")
        logger.info(f"  R²: {df_results.loc[best_r2_idx, 'r2']:.4f}")

        logger.info(f"\nBest Rain Reset (0-2 days): {df_results.loc[best_rain_reset_02_idx, 'config_name']}")
        logger.info(f"  Rain Reset 0-2d: {df_results.loc[best_rain_reset_02_idx, 'rain_reset_0-2_days']:.2%}")
        logger.info(f"  MAE: {df_results.loc[best_rain_reset_02_idx, 'mae']:.4f}")

        logger.info(f"\nBest Rain Reset (3-7 days): {df_results.loc[best_rain_reset_37_idx, 'config_name']}")
        logger.info(f"  Rain Reset 3-7d: {df_results.loc[best_rain_reset_37_idx, 'rain_reset_3-7_days']:.2%}")
        logger.info(f"  MAE: {df_results.loc[best_rain_reset_37_idx, 'mae']:.4f}")

        # STEP 6: Multi-day rain reset analysis
        logger.info("\n" + "="*80)
        logger.info("STEP 6: Multi-Day Rain Reset Analysis")
        logger.info("="*80)

        # Compare rain reset accuracy across different time windows
        rain_reset_cols = [col for col in df_results.columns if col.startswith('rain_reset_')]

        logger.info("\nRain Reset Accuracy by Time Window (averaged across all configs):")
        for col in rain_reset_cols:
            window_name = col.replace('rain_reset_', '')
            mean_accuracy = df_results[col].mean()
            std_accuracy = df_results[col].std()
            logger.info(f"  {window_name}: {mean_accuracy:.2%} ± {std_accuracy:.2%}")

        # Create summary report
        summary = {
            'experiment_date': datetime.now().isoformat(),
            'split_ratio': '50/50 (temporal)',
            'rain_threshold_mm': args.rain_threshold,
            'num_configurations': len(configs),
            'best_mae': {
                'config': df_results.loc[best_mae_idx, 'config_name'],
                'mae': float(df_results.loc[best_mae_idx, 'mae']),
                'r2': float(df_results.loc[best_mae_idx, 'r2']),
                'rain_reset_0_2d': float(df_results.loc[best_mae_idx, 'rain_reset_0-2_days'])
            },
            'best_r2': {
                'config': df_results.loc[best_r2_idx, 'config_name'],
                'mae': float(df_results.loc[best_r2_idx, 'mae']),
                'r2': float(df_results.loc[best_r2_idx, 'r2']),
                'rain_reset_0_2d': float(df_results.loc[best_r2_idx, 'rain_reset_0-2_days'])
            },
            'rain_reset_analysis': {
                window.replace('rain_reset_', ''): {
                    'mean_accuracy': float(df_results[window].mean()),
                    'std_accuracy': float(df_results[window].std()),
                    'best_config': df_results.loc[df_results[window].idxmax(), 'config_name']
                }
                for window in rain_reset_cols
            }
        }

        with open(output_dir / "experiment_summary.json", 'w') as f:
            json.dump(summary, f, indent=2)

        logger.info("\n" + "="*80)
        logger.info("EXPERIMENTS COMPLETE")
        logger.info("="*80)
        logger.info(f"\nResults saved to: {output_dir}")
        logger.info(f"  - hyperparam_results.csv")
        logger.info(f"  - hyperparam_results.json")
        logger.info(f"  - experiment_summary.json")

        return 0

    except Exception as e:
        logger.error(f"ERROR: {str(e)}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
