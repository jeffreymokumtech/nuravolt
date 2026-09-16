#!/usr/bin/env python3
"""
Main execution script for soiling model comparison.

Compares two soiling ratio modeling methods:
1. Method 1: Foundation model trained on DustIQ
2. Method 2: Pseudo-labels from rain/AOD/PR (no DustIQ)

Usage:
    python scripts/run_model_comparison.py
    python scripts/run_model_comparison.py --retrain
    python scripts/run_model_comparison.py --per-inverter
    python scripts/run_model_comparison.py --retrain --per-inverter --test-size 0.25

Author: NuraVolt Team
"""

import argparse
import sys
import logging
from pathlib import Path
from datetime import datetime
import json

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.sr_method_comparison import MethodComparer, ComparisonResults
from nuravolt.soiling.sr_validation import comprehensive_physics_validation


def setup_logging(output_dir: Path) -> None:
    """Setup logging configuration."""
    log_file = output_dir / f"comparison_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"

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
        description='Compare soiling ratio modeling methods',
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
        help='Retrain models from scratch (otherwise use existing if available)'
    )
    parser.add_argument(
        '--test-size',
        type=float,
        default=0.2,
        help='Fraction of data for test set (0-1)'
    )
    parser.add_argument(
        '--cv-splits',
        type=int,
        default=3,
        help='Number of cross-validation folds'
    )

    # Analysis options
    parser.add_argument(
        '--per-inverter',
        action='store_true',
        help='Include per-inverter analysis'
    )

    # Output options
    parser.add_argument(
        '--output',
        type=str,
        default='outputs_method_comparison',
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
    logger.info("SOILING MODEL COMPARISON - EXECUTION START")
    logger.info("="*80)
    logger.info(f"Output directory: {output_dir}")
    logger.info(f"Retrain models: {args.retrain}")
    logger.info(f"Test size: {args.test_size}")
    logger.info(f"CV splits: {args.cv_splits}")
    logger.info(f"Per-inverter analysis: {args.per_inverter}")

    try:
        # Initialize comparer
        comparer = MethodComparer(
            output_dir=args.output,
            test_size=args.test_size,
            cv_splits=args.cv_splits
        )

        # Data paths for Ribera (good DustIQ)
        data_dir = Path(args.data_dir)
        ribera_dir = data_dir / "ribera"

        dustiq_path = ribera_dir / "dustiq_history.json"
        rain_path = ribera_dir / "rain_history.json"
        aod_path = ribera_dir / "cams_aod_history.json"
        pr_path = ribera_dir / "pr_daily.parquet"

        # Verify files exist
        for path in [dustiq_path, rain_path]:
            if not path.exists():
                logger.error(f"Required file not found: {path}")
                return 1

        # STEP 1: Load data
        logger.info("\n" + "="*80)
        logger.info("STEP 1: Loading Ribera Data (Good DustIQ)")
        logger.info("="*80)

        X, y = comparer.load_ribera_data(
            dustiq_path=str(dustiq_path),
            rain_path=str(rain_path),
            aod_path=str(aod_path) if aod_path.exists() else None,
            pr_path=str(pr_path) if pr_path.exists() else None,
            latitude=37.927,
            longitude=-1.233
        )

        # STEP 2: Create train/test split
        logger.info("\n" + "="*80)
        logger.info("STEP 2: Creating Temporal Train/Test Split")
        logger.info("="*80)

        comparer.create_train_test_split(X, y)

        # STEP 3: Train Method 1 (DustIQ-based)
        logger.info("\n" + "="*80)
        logger.info("STEP 3: Training Method 1 (DustIQ-based Foundation Model)")
        logger.info("="*80)

        model1_path = output_dir / "models" / "method1_foundation_ribera.pkl"

        if args.retrain or not model1_path.exists():
            model1 = comparer.train_method1_dustiq(
                plant_id="ribera",
                latitude=37.927,
                longitude=-1.233
            )
        else:
            logger.info(f"Loading existing model: {model1_path}")
            from nuravolt.soiling.sr_ml_model import SoilingRatioModel
            comparer.model1 = SoilingRatioModel.load(model1_path)

        # STEP 4: Train Method 2 (Pseudo-labels)
        logger.info("\n" + "="*80)
        logger.info("STEP 4: Training Method 2 (Pseudo-Labels, No DustIQ)")
        logger.info("="*80)

        model2_path = output_dir / "models" / "method2_pseudo_ribera.pkl"

        if args.retrain or not model2_path.exists():
            model2 = comparer.train_method2_pseudo(
                rain_path=str(rain_path),
                pr_path=str(pr_path),
                aod_path=str(aod_path) if aod_path.exists() else None,
                plant_id="ribera_pseudo",
                latitude=37.927,
                longitude=-1.233
            )
        else:
            logger.info(f"Loading existing model: {model2_path}")
            from nuravolt.soiling.sr_ml_model import SoilingRatioModel
            comparer.model2 = SoilingRatioModel.load(model2_path)

        # STEP 5: Test set evaluation
        logger.info("\n" + "="*80)
        logger.info("STEP 5: Evaluating on Test Set")
        logger.info("="*80)

        # Load rain data for physics validation
        with open(rain_path, 'r') as f:
            import json as json_lib
            rain_data = json_lib.load(f)
        import pandas as pd
        df_rain = pd.DataFrame(rain_data['daily_data'])
        df_rain['date'] = pd.to_datetime(df_rain['date'])
        df_rain = df_rain.set_index('date')

        metrics1, metrics2 = comparer.evaluate_on_test_set(df_rain)

        # Save metrics
        with open(output_dir / "ribera_validation" / "method1_evaluation.json", 'w') as f:
            json.dump(metrics1.to_dict(), f, indent=2, default=str)
        with open(output_dir / "ribera_validation" / "method2_evaluation.json", 'w') as f:
            json.dump(metrics2.to_dict(), f, indent=2, default=str)

        # STEP 6: Cross-validation
        logger.info("\n" + "="*80)
        logger.info("STEP 6: Running Cross-Validation")
        logger.info("="*80)

        cv1, cv2 = comparer.run_cross_validation(X, y)

        # STEP 7: Statistical comparison
        logger.info("\n" + "="*80)
        logger.info("STEP 7: Statistical Comparison")
        logger.info("="*80)

        stat_comparison = comparer.statistical_comparison()

        # Save statistical comparison (convert numpy types to native Python)
        with open(output_dir / "ribera_validation" / "comparison_metrics.json", 'w') as f:
            json.dump(stat_comparison, f, indent=2, default=str)

        # STEP 8: Multi-criteria scoring
        logger.info("\n" + "="*80)
        logger.info("STEP 8: Multi-Criteria Scoring")
        logger.info("="*80)

        score1, score2, reasoning = comparer.multi_criteria_scoring(
            metrics1, metrics2, cv1, cv2
        )

        # Determine recommendation
        diff = abs(score1 - score2)
        if diff > 10:
            recommendation = "Method 1" if score1 > score2 else "Method 2"
            confidence = min(diff / 100, 0.95)
        else:
            recommendation = "Hybrid Ensemble"
            confidence = 0.6

        # STEP 9: Generate comprehensive report
        logger.info("\n" + "="*80)
        logger.info("STEP 9: Generating Comprehensive Report")
        logger.info("="*80)

        results = ComparisonResults(
            method1_name="Method 1 (DustIQ-based)",
            method2_name="Method 2 (Pseudo-labels)",
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

        # Save recommendation separately
        recommendation_data = {
            'winner': recommendation,
            'confidence': confidence,
            'reasoning': reasoning,
            'method1_score': score1,
            'method2_score': score2,
            'score_difference': diff,
            'timestamp': datetime.now().isoformat()
        }

        with open(output_dir / "recommendation.json", 'w') as f:
            json.dump(recommendation_data, f, indent=2)

        # FINAL: Print summary
        logger.info("\n" + "="*80)
        logger.info("COMPARISON COMPLETE - SUMMARY")
        logger.info("="*80)
        logger.info(f"\nTest Set Performance:")
        logger.info(f"  Method 1: MAE={metrics1.mae:.4f}, R²={metrics1.r2:.4f}")
        logger.info(f"  Method 2: MAE={metrics2.mae:.4f}, R²={metrics2.r2:.4f}")
        logger.info(f"\nCross-Validation Stability:")
        logger.info(f"  Method 1: {cv1.mean_mae:.4f} ± {cv1.std_mae:.4f}")
        logger.info(f"  Method 2: {cv2.mean_mae:.4f} ± {cv2.std_mae:.4f}")
        logger.info(f"\nMulti-Criteria Scores:")
        logger.info(f"  Method 1: {score1:.1f}/100")
        logger.info(f"  Method 2: {score2:.1f}/100")
        logger.info(f"\n{'='*80}")
        logger.info(f"RECOMMENDATION: {recommendation}")
        logger.info(f"CONFIDENCE: {confidence:.0%}")
        logger.info(f"REASONING: {reasoning}")
        logger.info(f"{'='*80}")
        logger.info(f"\nAll results saved to: {output_dir}")
        logger.info(f"  - Comprehensive report: comprehensive_report.json")
        logger.info(f"  - Executive summary: executive_summary.txt")
        logger.info(f"  - Recommendation: recommendation.json")
        logger.info(f"  - Predictions: ribera_validation/predictions_*.csv")

        return 0

    except Exception as e:
        logger.error(f"ERROR: {str(e)}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
