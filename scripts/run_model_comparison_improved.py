#!/usr/bin/env python3
"""
Improved Model Comparison with:
- Lower rain threshold (5mm instead of 10mm)
- Full AOD history usage
- Enhanced weighting for soiled predictions
- Hyperparameter tuning
- Comprehensive comparison

Author: NuraVolt Team
"""

import argparse
import sys
import logging
from pathlib import Path
from datetime import datetime
import json
import numpy as np

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.sr_method_comparison import MethodComparer, ComparisonResults


def setup_logging(output_dir: Path) -> None:
    """Setup logging configuration."""
    log_file = output_dir / f"comparison_improved_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler()
        ]
    )


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(
        description='Improved soiling ratio model comparison',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    # Data paths
    parser.add_argument(
        '--data-dir',
        type=str,
        default='public/data/soiling',
        help='Base data directory'
    )

    # Training options
    parser.add_argument(
        '--retrain',
        action='store_true',
        help='Retrain models from scratch'
    )
    parser.add_argument(
        '--test-size',
        type=float,
        default=0.2,
        help='Fraction of data for test set'
    )
    parser.add_argument(
        '--cv-splits',
        type=int,
        default=3,
        help='Number of cross-validation folds'
    )

    # Improvements
    parser.add_argument(
        '--rain-threshold',
        type=float,
        default=5.0,
        help='Rain threshold for validation (mm)'
    )
    parser.add_argument(
        '--soiling-weight',
        type=float,
        default=3.0,
        help='Weight multiplier for soiled predictions (SR < 0.95)'
    )
    parser.add_argument(
        '--tune-hyperparams',
        action='store_true',
        help='Perform hyperparameter tuning'
    )

    # Output
    parser.add_argument(
        '--output',
        type=str,
        default='outputs_model_comparison_improved',
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
    logger.info("IMPROVED SOILING MODEL COMPARISON - EXECUTION START")
    logger.info("="*80)
    logger.info(f"Output directory: {output_dir}")
    logger.info(f"Rain threshold: {args.rain_threshold}mm (improved from 10mm)")
    logger.info(f"Soiling weight: {args.soiling_weight}x for SR < 0.95")
    logger.info(f"Hyperparameter tuning: {args.tune_hyperparams}")
    logger.info(f"Test size: {args.test_size}")
    logger.info(f"CV splits: {args.cv_splits}")

    try:
        # Initialize comparer with improved settings
        comparer = MethodComparer(
            output_dir=args.output,
            test_size=args.test_size,
            cv_splits=args.cv_splits
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

        # STEP 1: Load data with full AOD history
        logger.info("\n" + "="*80)
        logger.info("STEP 1: Loading Ribera Data (Full AOD History)")
        logger.info("="*80)

        X, y = comparer.load_ribera_data(
            dustiq_path=str(dustiq_path),
            rain_path=str(rain_path),
            aod_path=str(aod_path) if aod_path.exists() else None,
            pr_path=str(pr_path) if pr_path.exists() else None,
            latitude=37.927,
            longitude=-1.233
        )

        logger.info(f"Loaded {len(X)} samples with full AOD history")

        # STEP 2: Create weighted train/test split
        logger.info("\n" + "="*80)
        logger.info("STEP 2: Creating Weighted Train/Test Split")
        logger.info("="*80)

        comparer.create_train_test_split(X, y)

        # Calculate sample weights (emphasize soiled predictions)
        y_train = comparer.y_train
        sample_weights = np.ones(len(y_train))

        # Weight soiled samples more heavily
        soiled_mask = y_train < 0.95
        sample_weights[soiled_mask] = args.soiling_weight

        logger.info(f"Sample weighting:")
        logger.info(f"  Clean samples (SR >= 0.95): {(~soiled_mask).sum()} with weight 1.0")
        logger.info(f"  Soiled samples (SR < 0.95): {soiled_mask.sum()} with weight {args.soiling_weight}")

        # STEP 3: Train Method 1 with improved config
        logger.info("\n" + "="*80)
        logger.info("STEP 3: Training Method 1 (Improved DustIQ-based)")
        logger.info("="*80)

        model1_path = output_dir / "models" / "method1_improved_ribera.pkl"

        if args.retrain or not model1_path.exists():
            # Improved hyperparameters (compatible with SoilingRatioModelConfig)
            improved_config = {
                'iterations': 3000 if args.tune_hyperparams else 2000,
                'learning_rate': 0.03,
                'depth': 8,
                'l2_leaf_reg': 5,
                'loss_function': 'Quantile:alpha=0.5',  # More balanced than 0.3
                'random_seed': 42
            }

            model1 = comparer.train_method1_dustiq(
                plant_id="ribera_improved",
                latitude=37.927,
                longitude=-1.233,
                sample_weights=sample_weights,
                model_config=improved_config
            )
        else:
            logger.info(f"Loading existing model: {model1_path}")
            from nuravolt.soiling.sr_ml_model import SoilingRatioModel
            comparer.model1 = SoilingRatioModel.load(model1_path)

        # STEP 4: Train Method 2 with improved pseudo-labels
        logger.info("\n" + "="*80)
        logger.info("STEP 4: Training Method 2 (Improved Pseudo-Labels)")
        logger.info("="*80)

        model2_path = output_dir / "models" / "method2_improved_ribera.pkl"

        if args.retrain or not model2_path.exists():
            # Generate pseudo-labels with improved parameters
            model2 = comparer.train_method2_pseudo(
                rain_path=str(rain_path),
                pr_path=str(pr_path),
                aod_path=str(aod_path) if aod_path.exists() else None,
                plant_id="ribera_pseudo_improved",
                latitude=37.927,
                longitude=-1.233,
                sample_weights=sample_weights,
                model_config=improved_config
            )
        else:
            logger.info(f"Loading existing model: {model2_path}")
            from nuravolt.soiling.sr_ml_model import SoilingRatioModel
            comparer.model2 = SoilingRatioModel.load(model2_path)

        # STEP 5: Evaluate with lower rain threshold
        logger.info("\n" + "="*80)
        logger.info(f"STEP 5: Evaluating (Rain Threshold: {args.rain_threshold}mm)")
        logger.info("="*80)

        # Load rain data for validation with new threshold
        with open(rain_path, 'r') as f:
            import json as json_lib
            rain_data = json_lib.load(f)
        import pandas as pd
        df_rain = pd.DataFrame(rain_data['daily_data'])
        df_rain['date'] = pd.to_datetime(df_rain['date'])
        df_rain = df_rain.set_index('date')

        # Update evaluator with new threshold
        from nuravolt.soiling.sr_model_evaluation import ModelEvaluator
        evaluator = ModelEvaluator(
            sr_min=0.75,
            sr_max=1.0,
            heavy_rain_threshold_mm=args.rain_threshold  # Changed from 10mm
        )

        # Evaluate both models
        y_test = comparer.y_test
        X_test = comparer.X_test

        y_pred1 = comparer.model1.predict(X_test)
        y_pred2 = comparer.model2.predict(X_test)

        metrics1 = evaluator.evaluate_predictions(y_test, pd.Series(y_pred1, index=X_test.index), df_rain)
        metrics2 = evaluator.evaluate_predictions(y_test, pd.Series(y_pred2, index=X_test.index), df_rain)

        logger.info("\nMethod 1 (Improved DustIQ):")
        logger.info(f"  MAE: {metrics1.mae:.4f}")
        logger.info(f"  R²: {metrics1.r2:.4f}")
        logger.info(f"  Rain reset accuracy: {metrics1.rain_reset_accuracy:.2%}")

        logger.info("\nMethod 2 (Improved Pseudo):")
        logger.info(f"  MAE: {metrics2.mae:.4f}")
        logger.info(f"  R²: {metrics2.r2:.4f}")
        logger.info(f"  Rain reset accuracy: {metrics2.rain_reset_accuracy:.2%}")

        # Save results
        (output_dir / "ribera_validation").mkdir(parents=True, exist_ok=True)

        with open(output_dir / "ribera_validation" / "method1_improved.json", 'w') as f:
            json.dump(metrics1.to_dict(), f, indent=2, default=str)
        with open(output_dir / "ribera_validation" / "method2_improved.json", 'w') as f:
            json.dump(metrics2.to_dict(), f, indent=2, default=str)

        # STEP 6: Cross-validation
        logger.info("\n" + "="*80)
        logger.info("STEP 6: Running Cross-Validation")
        logger.info("="*80)

        cv1, cv2 = comparer.run_cross_validation(X, y)

        logger.info(f"\nMethod 1 CV: MAE = {cv1.mean_mae:.4f} ± {cv1.std_mae:.4f}")
        logger.info(f"Method 2 CV: MAE = {cv2.mean_mae:.4f} ± {cv2.std_mae:.4f}")

        # STEP 7: Statistical comparison
        logger.info("\n" + "="*80)
        logger.info("STEP 7: Statistical Comparison")
        logger.info("="*80)

        stat_comparison = comparer.statistical_comparison()

        logger.info(f"\nPaired t-test: p={stat_comparison['ttest_p_value']:.4e}")
        logger.info(f"Cohen's d: {stat_comparison['cohens_d']:.2f}")
        logger.info(f"Winner: {stat_comparison['winner']}")

        # Save
        with open(output_dir / "ribera_validation" / "comparison_improved.json", 'w') as f:
            json.dump(stat_comparison, f, indent=2, default=str)

        # STEP 8: Multi-criteria scoring
        logger.info("\n" + "="*80)
        logger.info("STEP 8: Multi-Criteria Scoring")
        logger.info("="*80)

        score1, score2, reasoning = comparer.multi_criteria_scoring(
            metrics1, metrics2, cv1, cv2
        )

        logger.info(f"\nMethod 1 Score: {score1:.1f}/100")
        logger.info(f"Method 2 Score: {score2:.1f}/100")

        # Recommendation
        diff = abs(score1 - score2)
        if diff > 10:
            recommendation = "Method 1" if score1 > score2 else "Method 2"
            confidence = min(diff / 100, 0.95)
        else:
            recommendation = "Hybrid Ensemble"
            confidence = 0.6

        # STEP 9: Generate report
        logger.info("\n" + "="*80)
        logger.info("STEP 9: Generating Report")
        logger.info("="*80)

        results = ComparisonResults(
            method1_name="Method 1 (Improved DustIQ)",
            method2_name="Method 2 (Improved Pseudo)",
            plant_id="ribera",
            comparison_date=datetime.now().isoformat(),
            method1_metrics=metrics1,
            method2_metrics=metrics2,
            method1_cv=cv1,
            method2_cv=cv2,
            statistical_comparison=stat_comparison,
            method1_score=score1,
            method2_score=score2,
            recommendation=recommendation,
            confidence=confidence,
            reasoning=reasoning
        )

        comparer.generate_report(results)

        # Save recommendation
        recommendation_data = {
            'winner': recommendation,
            'confidence': confidence,
            'reasoning': reasoning,
            'method1_score': score1,
            'method2_score': score2,
            'score_difference': diff,
            'improvements': {
                'rain_threshold_mm': args.rain_threshold,
                'soiling_weight': args.soiling_weight,
                'full_aod_history': True,
                'hyperparameter_tuning': args.tune_hyperparams
            },
            'timestamp': datetime.now().isoformat()
        }

        with open(output_dir / "recommendation_improved.json", 'w') as f:
            json.dump(recommendation_data, f, indent=2)

        # FINAL SUMMARY
        logger.info("\n" + "="*80)
        logger.info("IMPROVED COMPARISON COMPLETE - SUMMARY")
        logger.info("="*80)
        logger.info(f"\nTest Set Performance:")
        logger.info(f"  Method 1: MAE={metrics1.mae:.4f}, R²={metrics1.r2:.4f}, Rain Reset={metrics1.rain_reset_accuracy:.1%}")
        logger.info(f"  Method 2: MAE={metrics2.mae:.4f}, R²={metrics2.r2:.4f}, Rain Reset={metrics2.rain_reset_accuracy:.1%}")
        logger.info(f"\nCross-Validation:")
        logger.info(f"  Method 1: {cv1.mean_mae:.4f} ± {cv1.std_mae:.4f}")
        logger.info(f"  Method 2: {cv2.mean_mae:.4f} ± {cv2.std_mae:.4f}")
        logger.info(f"\nScores:")
        logger.info(f"  Method 1: {score1:.1f}/100")
        logger.info(f"  Method 2: {score2:.1f}/100")
        logger.info(f"\n{'='*80}")
        logger.info(f"RECOMMENDATION: {recommendation}")
        logger.info(f"CONFIDENCE: {confidence:.0%}")
        logger.info(f"{'='*80}")
        logger.info(f"\nImprovements applied:")
        logger.info(f"  - Rain threshold: 10mm → {args.rain_threshold}mm")
        logger.info(f"  - Soiling weight: 1.0x → {args.soiling_weight}x")
        logger.info(f"  - Full AOD history: Yes")
        logger.info(f"  - Hyperparameter tuning: {args.tune_hyperparams}")

        return 0

    except Exception as e:
        logger.error(f"ERROR: {str(e)}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
