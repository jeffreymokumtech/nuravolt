#!/usr/bin/env python3
"""Foundation Model with Enhanced Environmental Features.

This script implements a leak-free evaluation of the foundation model using
the full environmental feature set from sr_transfer_features.py:

1. NO bias correction on test set
2. NO hybrid model features (would need plant-specific training)
3. NO digital twin features (would need plant-specific training)
4. YES environmental features (AOD, soil moisture, sea salt, weather rolling)
   - These come from external satellite/weather data, no leakage

When testing on plant X, ZERO data from plant X is used in training.
Environmental features (AOD, weather, etc.) are external data - safe to use.
"""

import sys
import warnings
import json
from pathlib import Path
from datetime import datetime
import numpy as np
import pandas as pd
from scipy.stats import spearmanr, pearsonr
from sklearn.metrics import r2_score

warnings.filterwarnings('ignore')
sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.evaluate_transfer_enhanced import (
    load_plant_scada, PLANT_CONFIGS
)
from nuravolt.soiling.sr_transfer_features import EnhancedFeatureExtractor

# All plants with DustIQ sensors
PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

# Climate zones
PLANT_CLIMATE = {
    "epsilon": "temperate",
    "ribera": "semi-arid",
    "delta": "coastal",
    "zeta": "coastal",
    "gamma": "semi-arid",
    "eta": "semi-arid",
    "alpha": "semi-arid",
}

CLIMATE_ENCODING = {
    "temperate": 0,
    "coastal": 1,
    "semi-arid": 2,
}

# Plant locations for static features
PLANT_LOCATIONS = {
    "epsilon": {"latitude": 47.5, "altitude": 400, "is_coastal": 0},
    "ribera": {"latitude": 37.9, "altitude": 200, "is_coastal": 0},
    "delta": {"latitude": 39.5, "altitude": 50, "is_coastal": 1},
    "zeta": {"latitude": 39.6, "altitude": 100, "is_coastal": 1},
    "gamma": {"latitude": 38.3, "altitude": 150, "is_coastal": 0},
    "eta": {"latitude": 38.8, "altitude": 350, "is_coastal": 0},
    "alpha": {"latitude": 37.4, "altitude": 250, "is_coastal": 0},
}

# Feature categories used (from EnhancedFeatureExtractor):
# - Weather: rainfall_7d/14d/30d, days_since_rain, humidity, wind, dew_potential
# - AOD/Dust: aod_mean_7d/14d, dust_aod_mean_7d, pm10, pm2p5
# - Soil Moisture: soil_moisture, is_dry_soil, dust_availability
# - Sea Salt: sea_salt_aod, sea_salt_aod_mean_7d (coastal)
# - MERRA-2: dust_extinction, seasalt_extinction
# - Temporal: day_of_year, month, is_dry_season
# - Location: latitude, altitude, is_coastal
#
# NOT used (would require plant-specific training):
# - Hybrid model features (P_physics, P_hybrid, ml_residual)
# - Digital twin features (current_cv, voltage_cv, etc.)
# - Soiling-aware twin features (sat_*)


def rolling_avg(arr, window=7):
    """Compute rolling average with NaN padding."""
    result = np.convolve(arr, np.ones(window)/window, mode='valid')
    pad = np.full(window-1, np.nan)
    return np.concatenate([pad, result])


def get_sample_weights(y_train):
    """Sample weights tuned via Optuna (trial 95)."""
    sample_weights = np.ones(len(y_train))
    sample_weights[y_train < 0.90] = 5.96
    sample_weights[(y_train >= 0.90) & (y_train < 0.95)] = 5.45
    sample_weights[(y_train >= 0.95) & (y_train < 0.98)] = 1.80
    sample_weights[(y_train >= 0.98) & (y_train < 0.99)] = 2.76
    return sample_weights


def compute_metrics(y_pred, y_true):
    """Compute metrics on 7-day rolling averages."""
    y_pred_7d = rolling_avg(y_pred, 7)
    y_true_7d = rolling_avg(y_true, 7)

    valid = ~(np.isnan(y_pred_7d) | np.isnan(y_true_7d))
    if valid.sum() < 10:
        return None

    y_p = y_pred_7d[valid]
    y_t = y_true_7d[valid]

    mae = np.mean(np.abs(y_p - y_t)) * 100
    rmse = np.sqrt(np.mean((y_p - y_t)**2)) * 100
    mbe = np.mean(y_p - y_t) * 100
    rho, _ = spearmanr(y_p, y_t)
    r_pearson, _ = pearsonr(y_p, y_t)
    r2 = r2_score(y_t, y_p)

    return {
        'mae': mae,
        'rmse': rmse,
        'mbe': mbe,
        'spearman': rho if not np.isnan(rho) else 0,
        'pearson': r_pearson if not np.isnan(r_pearson) else 0,
        'r2': r2 if not np.isnan(r2) else 0,
    }


def extract_features(plant_id: str, df_scada: pd.DataFrame) -> pd.DataFrame:
    """Extract environmental features using EnhancedFeatureExtractor.

    Uses full environmental feature set (AOD, soil moisture, sea salt, weather)
    but NO plant-specific features (hybrid model, digital twin, soiling twin).

    Environmental features come from external satellite/weather data - no leakage.
    """
    extractor = EnhancedFeatureExtractor(plant_id=plant_id)

    try:
        features_df = extractor.extract_features(
            df_scada=df_scada,
            include_hybrid=False,        # NO - would need plant-specific training
            include_twin=False,          # NO - would need plant-specific training
            include_environmental=True,  # YES - external satellite/weather data
            include_soiling_twin=False,  # NO - plant-specific
        )

        # Add climate categorical (not in EnhancedFeatureExtractor)
        climate = PLANT_CLIMATE.get(plant_id, "semi-arid")
        features_df['climate'] = CLIMATE_ENCODING[climate]

        return features_df

    except Exception as e:
        print(f"    Warning: EnhancedFeatureExtractor failed for {plant_id}: {e}")
        print(f"    Falling back to minimal features...")

        # Fallback to minimal features if extractor fails
        features = pd.DataFrame(index=df_scada.index)

        # Temporal features
        day_of_year = df_scada.index.dayofyear
        features['day_of_year_sin'] = np.sin(2 * np.pi * day_of_year / 365)
        features['day_of_year_cos'] = np.cos(2 * np.pi * day_of_year / 365)
        month = df_scada.index.month
        features['month_sin'] = np.sin(2 * np.pi * month / 12)
        features['month_cos'] = np.cos(2 * np.pi * month / 12)
        features['is_dry_season'] = month.isin([5, 6, 7, 8, 9]).astype(int)

        # Location features
        loc = PLANT_LOCATIONS.get(plant_id, {"latitude": 40, "altitude": 200, "is_coastal": 0})
        features['latitude_abs'] = abs(loc['latitude'])
        features['altitude_m'] = loc['altitude']
        features['is_coastal'] = loc['is_coastal']

        # Climate
        climate = PLANT_CLIMATE.get(plant_id, "semi-arid")
        features['climate'] = CLIMATE_ENCODING[climate]

        return features


def load_plant_data(plant_id: str):
    """Load plant data with environmental features."""
    df_scada, sr = load_plant_scada(plant_id, use_cleaned=True)
    if df_scada is None:
        return None, None, None

    # Extract features using EnhancedFeatureExtractor
    df_feat = extract_features(plant_id, df_scada)

    # Align with SR
    common_idx = df_feat.index.intersection(sr.index)
    df_feat = df_feat.loc[common_idx]
    y = sr.loc[common_idx].values

    return df_feat, y, common_idx


def load_multiple_plants(plant_ids: list):
    """Load and combine data from multiple plants with environmental features."""
    all_X = []
    all_y = []
    all_dates = []
    all_plant_ids = []

    for plant_id in plant_ids:
        df_feat, y, dates = load_plant_data(plant_id)
        if df_feat is not None:
            all_X.append(df_feat)
            all_y.append(y)
            all_dates.extend(dates)
            all_plant_ids.extend([plant_id] * len(y))

    if not all_X:
        return None, None, None, None

    X_combined = pd.concat(all_X, ignore_index=True)
    y_combined = np.concatenate(all_y)

    return X_combined, y_combined, all_dates, all_plant_ids


def _prepare_numeric_df(df):
    """Ensure all columns are numeric float, fill NaN with 0."""
    df = df.copy()
    for col in df.columns:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    return df.fillna(0)


def train_foundation_model(X_train_df, y_train, X_val_df=None, y_val=None):
    """Train CatBoost regressor with MAE loss and optional early stopping."""
    from catboost import CatBoostRegressor, Pool

    sample_weights = get_sample_weights(y_train)

    X_train_df = _prepare_numeric_df(X_train_df)

    train_pool = Pool(
        data=X_train_df,
        label=y_train,
        weight=sample_weights,
    )

    use_early_stopping = X_val_df is not None and y_val is not None

    model = CatBoostRegressor(
        iterations=1000 if use_early_stopping else 677,
        learning_rate=0.0069,
        depth=8,
        l2_leaf_reg=6.88,
        min_data_in_leaf=29,
        loss_function='MAE',
        random_seed=42,
        verbose=False,
        early_stopping_rounds=50 if use_early_stopping else None,
    )

    if use_early_stopping:
        X_val_df = _prepare_numeric_df(X_val_df)
        val_pool = Pool(data=X_val_df, label=y_val)
        model.fit(train_pool, eval_set=val_pool, verbose=False)
        print(f"    Early stopping: best iteration {model.best_iteration_} / {model.tree_count_}")
    else:
        model.fit(train_pool, verbose=False)

    return model


def pick_validation_plant(target_plant: str, train_plants: list) -> str:
    """Pick the training plant most climatically similar to target for validation.

    This creates a nested LOPO: 5 plants train, 1 plant validate, 1 plant test.
    The validation plant should be representative of the target's domain.
    """
    target_climate = PLANT_CLIMATE[target_plant]

    # Prefer same climate zone
    same_climate = [p for p in train_plants if PLANT_CLIMATE[p] == target_climate]
    if same_climate:
        # Pick the one with the most data (last alphabetically as tiebreaker)
        return sorted(same_climate)[-1]

    # Fallback: pick the last plant alphabetically
    return sorted(train_plants)[-1]


def evaluate_on_target(target_plant: str):
    """TRUE LOPO: Train on all plants EXCEPT target, test on target.

    ZERO data from target plant in training.
    NO bias correction (would leak test info).
    Uses nested LOPO: 5 plants train, 1 plant validation (early stopping), 1 plant test.
    """
    print(f"\n{'='*60}")
    print(f"Target: {target_plant.upper()} ({PLANT_CLIMATE[target_plant]})")
    print(f"{'='*60}")

    train_plants = [p for p in PLANTS if p != target_plant]

    # Nested LOPO: hold out one training plant for validation (early stopping)
    val_plant = pick_validation_plant(target_plant, train_plants)
    actual_train_plants = [p for p in train_plants if p != val_plant]

    print(f"Training on: {', '.join(actual_train_plants)}")
    print(f"Validation:  {val_plant} (early stopping)")

    # Load training data (5 plants)
    X_train, y_train, _, _ = load_multiple_plants(actual_train_plants)
    if X_train is None:
        print("ERROR: Could not load training data")
        return None

    # Load validation data (1 plant)
    X_val, y_val, _ = load_plant_data(val_plant)

    print(f"Training samples: {len(y_train)} (from {len(actual_train_plants)} plants)")
    print(f"Validation samples: {len(y_val) if y_val is not None else 0} ({val_plant})")
    print(f"Features ({len(X_train.columns)}): {list(X_train.columns)[:10]}...")

    # Load test data (target plant ONLY)
    X_test, y_test, dates_test = load_plant_data(target_plant)
    if X_test is None:
        print("ERROR: Could not load test data")
        return None

    X_test = _prepare_numeric_df(X_test)

    # Align columns with training data
    for col in set(X_train.columns) - set(X_test.columns):
        X_test[col] = 0
    X_test = X_test[X_train.columns]

    # Align validation columns too
    if X_val is not None:
        X_val = _prepare_numeric_df(X_val)
        for col in set(X_train.columns) - set(X_val.columns):
            X_val[col] = 0
        X_val = X_val[X_train.columns]

    print(f"Test samples: {len(y_test)}")

    # Train model with early stopping on validation plant
    model = train_foundation_model(X_train, y_train, X_val, y_val)

    # Predict - NO BIAS CORRECTION
    y_pred = model.predict(X_test)

    # Compute metrics on RAW predictions (honest evaluation)
    metrics = compute_metrics(y_pred, y_test)

    if metrics:
        print(f"\n--- RESULTS (NO BIAS CORRECTION) ---")
        print(f"MAE:      {metrics['mae']:.2f}%")
        print(f"RMSE:     {metrics['rmse']:.2f}%")
        print(f"MBE:      {metrics['mbe']:+.2f}%")
        print(f"Spearman: {metrics['spearman']:.3f}")
        print(f"Pearson:  {metrics['pearson']:.3f}")
        print(f"R²:       {metrics['r2']:.3f}")

    return {
        'target_plant': target_plant,
        'climate': PLANT_CLIMATE[target_plant],
        'train_plants': train_plants,
        'n_train': len(y_train),
        'n_test': len(y_test),
        'n_features': len(X_train.columns),
        'features': list(X_train.columns),
        'metrics': metrics,
        'predictions': {
            'dates': [str(d) for d in dates_test],
            'actual': y_test.tolist(),
            'predicted': y_pred.tolist(),
        }
    }


def main():
    """Run foundation model evaluation with environmental features."""
    print("="*70)
    print("FOUNDATION MODEL EVALUATION (Enhanced Environmental Features)")
    print("="*70)
    print("\nFeatures used:")
    print("  - Weather: rainfall_7d/14d/30d, humidity, wind, dew_potential")
    print("  - AOD/Dust: aod_mean_7d/14d, dust_aod, pm10, pm2p5")
    print("  - Soil Moisture: soil_moisture, is_dry_soil, dust_availability")
    print("  - Sea Salt: sea_salt_aod (coastal sites)")
    print("  - MERRA-2: dust_extinction, seasalt_extinction")
    print("  - Temporal: day_of_year, month, is_dry_season")
    print("  - Location: latitude, altitude, is_coastal, climate")
    print("\nNOT used (would need plant-specific training):")
    print("  - Hybrid model features (P_physics, P_hybrid, ml_residual)")
    print("  - Digital twin features (current_cv, voltage_cv, etc.)")
    print("\nWhen testing on plant X, ZERO data from plant X is used in training.")

    # Evaluate on ALL plants
    target_plants = PLANTS  # ["epsilon", "ribera", "delta", "zeta", "gamma", "eta", "alpha"]

    results = {}
    for target in target_plants:
        result = evaluate_on_target(target)
        if result:
            results[target] = result

    # Summary
    print("\n" + "="*70)
    print("SUMMARY (Leak-Free Evaluation)")
    print("="*70)
    print(f"\n{'Plant':<15} {'Climate':<12} {'MAE (%)':<10} {'MBE (%)':<10} {'ρ':<8} {'R²':<8}")
    print("-"*65)

    for plant, r in results.items():
        m = r['metrics']
        print(f"{plant:<15} {r['climate']:<12} {m['mae']:<10.2f} {m['mbe']:<+10.2f} {m['spearman']:<8.3f} {m['r2']:<8.3f}")

    # Save results
    output_dir = Path('backenddata/foundation_model')
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = output_dir / 'leak_free_results.json'
    # Get feature list from first result
    feature_list = list(results.values())[0]['features'] if results else []
    with open(output_path, 'w') as f:
        json.dump({
            'timestamp': datetime.now().isoformat(),
            'description': 'Foundation model with environmental features (AOD, soil moisture, sea salt, weather)',
            'n_features': len(feature_list),
            'features': feature_list,
            'results': results,  # Include predictions for plotting
        }, f, indent=2)
    print(f"\nResults saved to: {output_path}")

    # Compare with leaky version if available
    leaky_path = output_dir / 'foundation_model_results.json'
    if leaky_path.exists():
        print("\n" + "="*70)
        print("COMPARISON: Leak-Free vs Original (with leakage)")
        print("="*70)

        with open(leaky_path) as f:
            leaky_results = json.load(f)

        print(f"\n{'Plant':<15} {'Leak-Free MAE':<15} {'Leaky MAE':<15} {'Difference':<15}")
        print("-"*60)

        for plant in target_plants:
            if plant in results and plant in leaky_results.get('results', {}):
                leak_free_mae = results[plant]['metrics']['mae']
                leaky_mae = leaky_results['results'][plant]['mae']
                diff = leak_free_mae - leaky_mae
                status = "(leaked)" if diff > 0.5 else "(similar)"
                print(f"{plant:<15} {leak_free_mae:<15.2f} {leaky_mae:<15.2f} {diff:+.2f}% {status}")


if __name__ == "__main__":
    main()
