#!/usr/bin/env python3
"""
Evaluate the Soiling Foundation Model using leave-one-out validation.

This script:
1. Trains foundation model on DustIQ plants (zeta, epsilon)
2. Evaluates on all valid plants
3. Simulates bootstrap pipeline on held-out plants
4. Reports MAE, MBE by SR bin with conservative bias validation

Usage:
    python scripts/evaluate_foundation_model.py
    python scripts/evaluate_foundation_model.py --simulate-bootstrap
"""

import argparse
import json
import sys
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_foundation_model import (
    SoilingFoundationModel,
    train_and_evaluate_foundation_model,
    DUSTIQ_PLANTS,
    VALID_PLANTS,
)
from scripts.evaluate_transfer_enhanced import (
    load_plant_scada,
    load_plant_enhanced_features,
    SR_BINS,
)


def format_pct(val, width=6, sign=False):
    """Format percentage."""
    if val is None:
        return "N/A".rjust(width)
    pct = val * 100
    if sign:
        return f"{pct:+{width}.2f}%"
    return f"{pct:{width}.2f}%"


def evaluate_leave_one_out(conservative_bias: float = 0.02):
    """
    Leave-one-out evaluation: train on N-1 DustIQ plants, test on held-out.

    Since we only have 2 DustIQ plants, this tests:
    1. Train on zeta, test on epsilon
    2. Train on epsilon, test on zeta
    """
    print(f"\n{'='*80}")
    print("LEAVE-ONE-OUT CROSS-VALIDATION")
    print(f"{'='*80}")

    results = {}

    for held_out in DUSTIQ_PLANTS:
        train_plants = [p for p in DUSTIQ_PLANTS if p != held_out]
        print(f"\n--- Train: {train_plants}, Test: {held_out} ---")

        # Train model
        model = SoilingFoundationModel(conservative_bias=conservative_bias)
        model.train_on_all_dustiq_plants(plant_ids=train_plants)

        # Evaluate on held-out plant
        r = model.evaluate_on_plant(held_out)
        results[held_out] = r

        if 'error' in r:
            print(f"  ERROR: {r['error']}")
            continue

        conservative = "CONSERVATIVE" if r['is_conservative'] else "RISKY"
        print(f"  MAE: {r['mae_7d']*100:.2f}%, MBE: {r['mbe_7d']*100:+.2f}% [{conservative}]")
        print(f"  Worst: {r['worst_under']*100:+.1f}% to {r['worst_over']*100:+.1f}%")

    return results


def compare_with_transfer_learning():
    """Compare foundation model with pairwise transfer learning."""
    print(f"\n{'='*80}")
    print("COMPARISON: Foundation Model vs Transfer Learning")
    print(f"{'='*80}")

    # Train foundation model
    foundation = SoilingFoundationModel(conservative_bias=0.02)
    foundation.train_on_all_dustiq_plants()

    # Load pairwise transfer results if available
    transfer_results_path = Path("backenddata/transfer_learning")
    transfer_files = list(transfer_results_path.glob("enhanced_evaluation_*.json"))

    if transfer_files:
        latest_transfer = max(transfer_files, key=lambda p: p.stat().st_mtime)
        with open(latest_transfer) as f:
            transfer_data = json.load(f)
        print(f"  Loaded transfer results from: {latest_transfer.name}")
    else:
        transfer_data = None

    # Compare on each plant
    print(f"\n{'Plant':<15} {'Foundation MAE':>15} {'Transfer MAE':>15} {'Winner':>10}")
    print("-" * 60)

    comparison = {}

    for plant_id in VALID_PLANTS:
        # Foundation model evaluation
        foundation_r = foundation.evaluate_on_plant(plant_id)

        if 'error' in foundation_r:
            continue

        foundation_mae = foundation_r['mae_7d']

        # Transfer learning MAE (from previous results)
        if transfer_data and plant_id in transfer_data.get('results', {}):
            transfer_mae = transfer_data['results'][plant_id].get('transfer', {}).get('mae_7d')
        else:
            transfer_mae = None

        # Determine winner
        if transfer_mae is not None:
            winner = "Foundation" if foundation_mae < transfer_mae else "Transfer"
        else:
            winner = "N/A"

        print(f"{plant_id:<15} {format_pct(foundation_mae):>15} "
              f"{format_pct(transfer_mae) if transfer_mae else 'N/A':>15} {winner:>10}")

        comparison[plant_id] = {
            'foundation_mae': float(foundation_mae),
            'transfer_mae': float(transfer_mae) if transfer_mae else None,
            'winner': winner,
        }

    return comparison


def simulate_bootstrap_on_plant(plant_id: str, n_days: int = 90):
    """Simulate the bootstrap pipeline on a plant."""
    from nuravolt.soiling.sr_bootstrap_pipeline import BootstrapPipeline

    print(f"\n--- Bootstrap Simulation: {plant_id} ({n_days} days) ---")

    # Load foundation model
    model_path = Path("backenddata/models/soiling_foundation_model.pkl")
    if model_path.exists():
        foundation = SoilingFoundationModel.load(model_path)
    else:
        foundation = SoilingFoundationModel(conservative_bias=0.02)
        foundation.train_on_all_dustiq_plants()

    # Load plant data
    df_scada, sr_actual = load_plant_scada(plant_id, use_cleaned=True)
    if df_scada is None:
        print(f"  Could not load data for {plant_id}")
        return None

    df_features = load_plant_enhanced_features(plant_id, df_scada, include_hybrid=True)
    if df_features is None:
        print(f"  Could not extract features for {plant_id}")
        return None

    # Initialize pipeline
    pipeline = BootstrapPipeline(plant_id)
    pipeline.initialize_with_foundation_model(foundation)

    # Simulate daily updates
    results = []
    common_dates = df_features.index.intersection(sr_actual.index)[:n_days]

    # Simulate rainfall (using feature if available, else generate synthetic)
    if 'rainfall_7d' in df_features.columns:
        # Estimate daily rainfall from 7d accumulation
        rainfall = df_features['rainfall_7d'].diff().fillna(0).clip(lower=0)
    else:
        # Synthetic: occasional rain events
        np.random.seed(42)
        rainfall = pd.Series(0, index=common_dates)
        rain_days = np.random.choice(len(common_dates), size=max(1, len(common_dates)//10), replace=False)
        for i in rain_days:
            rainfall.iloc[i] = np.random.uniform(5, 20)

    for i, date in enumerate(common_dates):
        features = df_features.loc[date].values
        rain_mm = rainfall.get(date, 0.0)
        sr_true = sr_actual.loc[date]

        # Estimate SR
        sr_est, confidence, meta = pipeline.estimate_daily_sr(
            features=features,
            rainfall_mm=rain_mm,
            date=date,
        )

        # Update pipeline (using PR derived from true SR as proxy)
        power_actual = 100.0  # Arbitrary
        power_expected = power_actual / sr_true if sr_true > 0.5 else power_actual

        pipeline.update_with_observation(
            date=date,
            features=features,
            power_actual=power_actual,
            power_expected=power_expected,
            rainfall_mm=rain_mm,
        )

        results.append({
            'day': i + 1,
            'date': date,
            'sr_actual': sr_true,
            'sr_estimated': sr_est,
            'error': sr_est - sr_true,
            'phase': meta['phase'],
            'method': meta['method'],
        })

    results_df = pd.DataFrame(results)

    # Analyze by phase
    print(f"\n  Results by Phase:")
    for phase in results_df['phase'].unique():
        phase_df = results_df[results_df['phase'] == phase]
        mae = phase_df['error'].abs().mean()
        mbe = phase_df['error'].mean()
        print(f"    {phase}: MAE={mae*100:.2f}%, MBE={mbe*100:+.2f}%, days={len(phase_df)}")

    # Overall
    mae = results_df['error'].abs().mean()
    mbe = results_df['error'].mean()
    conservative = "CONSERVATIVE" if mbe < 0 else "RISKY"

    print(f"\n  Overall: MAE={mae*100:.2f}%, MBE={mbe*100:+.2f}% [{conservative}]")

    return {
        'plant_id': plant_id,
        'n_days': len(results_df),
        'mae': float(mae),
        'mbe': float(mbe),
        'is_conservative': mbe < 0,
        'phases': {
            phase: {
                'mae': float(results_df[results_df['phase'] == phase]['error'].abs().mean()),
                'mbe': float(results_df[results_df['phase'] == phase]['error'].mean()),
                'days': int((results_df['phase'] == phase).sum()),
            }
            for phase in results_df['phase'].unique()
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate Foundation Model")
    parser.add_argument("--simulate-bootstrap", action="store_true",
                        help="Run bootstrap simulation on held-out plants")
    parser.add_argument("--conservative-bias", type=float, default=0.02,
                        help="Conservative bias (default 2%%)")
    parser.add_argument("--save", action="store_true",
                        help="Save trained model")
    args = parser.parse_args()

    print(f"\n{'='*80}")
    print("SOILING FOUNDATION MODEL EVALUATION")
    print(f"Generated: {datetime.now().isoformat()}")
    print(f"Conservative bias: {args.conservative_bias*100:.1f}%")
    print(f"{'='*80}")

    # Train and evaluate foundation model
    model_path = Path("backenddata/models/soiling_foundation_model.pkl") if args.save else None
    model, eval_results = train_and_evaluate_foundation_model(
        conservative_bias=args.conservative_bias,
        save_path=model_path,
    )

    # Leave-one-out validation
    loo_results = evaluate_leave_one_out(args.conservative_bias)

    # Compare with transfer learning
    comparison = compare_with_transfer_learning()

    # Bootstrap simulation
    bootstrap_results = {}
    if args.simulate_bootstrap:
        print(f"\n{'='*80}")
        print("BOOTSTRAP SIMULATION")
        print(f"{'='*80}")

        # Simulate on non-DustIQ plants
        for plant_id in VALID_PLANTS:
            if plant_id not in DUSTIQ_PLANTS:
                r = simulate_bootstrap_on_plant(plant_id, n_days=90)
                if r:
                    bootstrap_results[plant_id] = r

    # Final summary
    print(f"\n{'='*80}")
    print("FINAL SUMMARY")
    print(f"{'='*80}")

    # Check if conservative
    n_conservative = sum(1 for r in eval_results.values() if r.get('is_conservative', False))
    total_plants = len(eval_results)

    print(f"\nConservative Bias Validation:")
    print(f"  {n_conservative}/{total_plants} plants have negative MBE (conservative)")

    if n_conservative == total_plants:
        print(f"  PASS: Model is consistently conservative")
    else:
        risky_plants = [p for p, r in eval_results.items() if not r.get('is_conservative', False)]
        print(f"  WARNING: Non-conservative on: {risky_plants}")
        print(f"  Consider increasing conservative_bias")

    # Save results
    output_dir = Path("backenddata/foundation_model")
    output_dir.mkdir(parents=True, exist_ok=True)

    output_file = output_dir / f"evaluation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(output_file, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'conservative_bias': args.conservative_bias,
            'training_stats': model.training_stats,
            'evaluation_results': eval_results,
            'leave_one_out': loo_results,
            'comparison_with_transfer': comparison,
            'bootstrap_simulation': bootstrap_results,
        }, f, indent=2, default=str)

    print(f"\nResults saved to: {output_file}")


if __name__ == "__main__":
    main()
