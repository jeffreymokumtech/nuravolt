"""
Soiling Ratio Foundation Model for plants without DustIQ sensors.

This module provides a global foundation model trained on all DustIQ-equipped plants
to estimate soiling ratio for new plants without nearby reference data.

Key features:
1. Conservative bias: Prefers to overpredict soiling (negative MBE) to not miss cleaning triggers
2. Asymmetric loss: Penalizes underprediction 3x more than overprediction
3. Sample weighting: Dirty days weighted higher for better cleaning decision support
4. Location-invariant features: Uses relative environmental indicators, not absolute location

Usage:
    from nuravolt.soiling.sr_foundation_model import SoilingFoundationModel

    # Train on all DustIQ plants
    model = SoilingFoundationModel(conservative_bias=0.02)
    model.train_on_all_dustiq_plants()

    # Predict for new plant
    sr_pred = model.predict(features)
"""

import pickle
import warnings
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')


@dataclass
class FoundationModelConfig:
    """Configuration for foundation model training."""
    conservative_bias: float = 0.02  # 2% safety margin (predict dirtier)
    underprediction_penalty: float = 3.0  # 3x penalty for underpredicting soiling

    # Sample weights by SR bin
    weight_very_dirty: float = 10.0   # SR < 90%
    weight_dirty: float = 5.0          # SR 90-95%
    weight_moderate: float = 3.0       # SR 95-98%
    weight_light: float = 2.0          # SR 98-99%
    weight_clean: float = 1.0          # SR > 99%

    # Model hyperparameters (tuned for better generalization)
    iterations: int = 300
    learning_rate: float = 0.015  # Slower learning for stability
    depth: int = 5                 # Deeper trees capture more patterns
    l2_leaf_reg: float = 5.0       # Less regularization
    min_data_in_leaf: int = 20
    random_seed: int = 42


# DEPRECATED — single-pool donor list. Kept for callers that still import it.
# The single-pool model was retired in favour of per-climate-zone models because
# mixing Mediterranean (Zeta) and continental (Epsilon) donors produced
# inverted seasonality on Mediterranean targets. Use `donors_for_zone()` from
# `nuravolt.soiling.climate_regions` instead.
DUSTIQ_PLANTS = ["zeta", "epsilon"]

# All plants for validation (excluding bad data plants)
VALID_PLANTS = ["epsilon", "ribera", "delta", "zeta", "gamma"]

# Location-invariant features (don't use raw lat/lon)
LOCATION_INVARIANT_FEATURES = [
    'P_hybrid',           # Hybrid model power prediction
    'rainfall_7d',        # Recent rainfall (mm)
    'rainfall_14d',
    'rainfall_30d',
    'days_since_rain',    # Days since last significant rain
    'is_heavy_rain',      # Binary: heavy rain recently
    'aod_mean_7d',        # Aerosol optical depth
    'aod_mean_14d',
    'is_high_aod',        # Binary: high dust conditions
    'dust_aod_mean_7d',   # Dust-specific AOD
    'dust_aod_mean_14d',
    'pm10_mean_7d',       # Particulate matter
    'pm2p5_mean_7d',
    'sea_salt_aod',       # Sea salt AOD (coastal indicator)
    'sea_salt_aod_mean_7d',
    'is_high_sea_salt',
    'sea_salt_pct',       # Sea salt as % of total AOD
    'organic_aod_mean_7d',
    'sulphate_aod_mean_7d',
    'dust_extinction',    # MERRA-2 surface dust extinction (deposition rate)
    'seasalt_extinction', # MERRA-2 sea salt extinction
    'soil_moisture_mean_7d',  # Dust availability indicator
    'is_dry_soil',        # Binary: dry soil = higher dust availability
    'day_of_year_sin',    # Seasonal features
    'day_of_year_cos',
    'month_sin',
    'month_cos',
    'is_dry_season',      # Binary: dry season indicator
    'latitude_abs',       # Absolute latitude (climate zone)
    'altitude_m',         # Altitude (dust deposition rate)
    'is_coastal',         # Binary: coastal location
]


class AsymmetricLoss:
    """Custom loss that penalizes underprediction of soiling more than overprediction.

    Underpredicting soiling (predicting cleaner than actual) is risky because
    it may cause missed cleaning triggers. Overpredicting (predicting dirtier)
    is conservative and safe.
    """

    def __init__(self, underprediction_penalty: float = 3.0):
        """
        Parameters
        ----------
        underprediction_penalty : float
            Multiplier for underprediction error (default 3x)
        """
        self.alpha = underprediction_penalty

    def calc_ders_range(self, approxes, targets, weights):
        """Calculate gradients and hessians for CatBoost.

        For SR prediction:
        - If pred > target (overpredict soiling, i.e., predict dirtier): normal loss
        - If pred < target (underpredict soiling, i.e., predict cleaner): 3x loss

        Wait - we're predicting SR directly, not soiling loss.
        - If pred > target: we predict cleaner than actual = RISKY = penalize more
        - If pred < target: we predict dirtier than actual = SAFE = normal loss
        """
        assert len(approxes) == len(targets)

        result = []
        for i in range(len(targets)):
            w = weights[i] if weights is not None else 1.0
            diff = approxes[i] - targets[i]

            if diff > 0:
                # Predicted SR > Actual SR = thinks cleaner = RISKY
                # Apply higher penalty
                grad = 2 * diff * self.alpha * w
                hess = 2 * self.alpha * w
            else:
                # Predicted SR < Actual SR = thinks dirtier = SAFE
                # Normal loss
                grad = 2 * diff * w
                hess = 2 * w

            result.append((grad, hess))

        return result


class SoilingFoundationModel:
    """Global foundation model for soiling ratio prediction.

    Trained on all DustIQ-equipped plants to provide baseline predictions
    for new plants without nearby reference data.
    """

    def __init__(
        self,
        config: Optional[FoundationModelConfig] = None,
        conservative_bias: float = 0.02,
    ):
        """
        Parameters
        ----------
        config : FoundationModelConfig, optional
            Full configuration object
        conservative_bias : float
            Safety margin to subtract from predictions (default 0.02 = 2%)
            This ensures we predict dirtier than actual (negative MBE)
        """
        self.config = config or FoundationModelConfig(conservative_bias=conservative_bias)
        self.model = None
        self.feature_names: List[str] = []
        self.training_stats: Dict = {}
        self.is_trained = False

    def _get_sample_weights(self, y: np.ndarray) -> np.ndarray:
        """Calculate sample weights based on SR values.

        Weights are higher for dirty days to improve predictions
        in the cleaning decision zone.
        """
        weights = np.ones(len(y))
        cfg = self.config

        weights[y < 0.90] = cfg.weight_very_dirty
        weights[(y >= 0.90) & (y < 0.95)] = cfg.weight_dirty
        weights[(y >= 0.95) & (y < 0.98)] = cfg.weight_moderate
        weights[(y >= 0.98) & (y < 0.99)] = cfg.weight_light
        # y >= 0.99: weight = weight_clean (default 1.0)

        return weights

    def train_on_all_dustiq_plants(
        self,
        plant_ids: Optional[List[str]] = None,
        use_asymmetric_loss: bool = True,
    ) -> Dict:
        """Train foundation model on all DustIQ-equipped plants.

        Parameters
        ----------
        plant_ids : List[str], optional
            Override default DustIQ plants
        use_asymmetric_loss : bool
            Use asymmetric loss (penalize underprediction more)

        Returns
        -------
        Dict
            Training statistics
        """
        from nuravolt.soiling.sr_transfer_features import EnhancedFeatureExtractor
        from scripts.evaluate_transfer_enhanced import load_plant_scada, load_plant_enhanced_features

        plants = plant_ids or DUSTIQ_PLANTS

        print(f"\n{'='*60}")
        print(f"TRAINING SOILING FOUNDATION MODEL")
        print(f"{'='*60}")
        print(f"Source plants: {plants}")
        print(f"Conservative bias: {self.config.conservative_bias*100:.1f}%")
        print(f"Underprediction penalty: {self.config.underprediction_penalty}x")

        # Collect training data from all plants. Different donors can ship
        # different feature columns (gamma currently lacks the MERRA-2
        # extinction features) — collect each plant as a DataFrame, then
        # reindex to the UNION of columns at concat time, filling 0 for
        # missing columns. That way no donor is silently dropped and the
        # model sees consistent feature dimensionality across plants.
        per_plant: List[Tuple[pd.DataFrame, np.ndarray, str]] = []

        for plant_id in plants:
            print(f"\n  Loading {plant_id}...")

            df_scada, sr_target = load_plant_scada(plant_id, use_cleaned=True)
            if df_scada is None:
                print(f"    SKIP: Could not load SCADA data")
                continue

            df_features = load_plant_enhanced_features(plant_id, df_scada, include_hybrid=True)
            if df_features is None:
                print(f"    SKIP: Could not extract features")
                continue

            common_idx = df_features.index.intersection(sr_target.index)
            df_features_aligned = df_features.loc[common_idx]
            y = sr_target.loc[common_idx].values

            print(
                f"    Days: {len(y)}, SR range: [{y.min():.3f}, {y.max():.3f}], "
                f"features: {df_features_aligned.shape[1]}"
            )
            per_plant.append((df_features_aligned, y, plant_id))

        if not per_plant:
            raise ValueError("No training data loaded from any plant")

        # Union the feature columns across all donors.
        all_cols: List[str] = []
        seen = set()
        for df_p, _, _ in per_plant:
            for col in df_p.columns:
                if col not in seen:
                    seen.add(col)
                    all_cols.append(col)
        self.feature_names = all_cols

        # Reindex each donor's frame to the union; missing columns become 0.
        X_list, y_list = [], []
        for df_p, y, plant_id in per_plant:
            X = df_p.reindex(columns=all_cols, fill_value=0.0).values
            X = np.nan_to_num(X, nan=0.0)
            X_list.append(X)
            y_list.append(y)

        # Combine all training data
        X_train = np.vstack(X_list)
        y_train = np.concatenate(y_list)

        print(f"\n  Combined: {len(y_train)} days, {X_train.shape[1]} features")

        # SR distribution
        bins = [
            ("<90%", (y_train < 0.90).sum()),
            ("90-95%", ((y_train >= 0.90) & (y_train < 0.95)).sum()),
            ("95-98%", ((y_train >= 0.95) & (y_train < 0.98)).sum()),
            ("98-99%", ((y_train >= 0.98) & (y_train < 0.99)).sum()),
            (">99%", (y_train >= 0.99).sum()),
        ]
        print(f"  SR distribution: {dict(bins)}")

        # Calculate sample weights
        sample_weights = self._get_sample_weights(y_train)
        print(f"  Sample weights: <90%={self.config.weight_very_dirty}x, "
              f"90-95%={self.config.weight_dirty}x, 95-98%={self.config.weight_moderate}x")

        # Train model
        print(f"\n  Training CatBoost model...")
        from catboost import CatBoostRegressor

        cfg = self.config

        if use_asymmetric_loss:
            # Use custom asymmetric loss
            loss_fn = AsymmetricLoss(cfg.underprediction_penalty)
            self.model = CatBoostRegressor(
                iterations=cfg.iterations,
                learning_rate=cfg.learning_rate,
                depth=cfg.depth,
                l2_leaf_reg=cfg.l2_leaf_reg,
                min_data_in_leaf=cfg.min_data_in_leaf,
                random_seed=cfg.random_seed,
                loss_function=loss_fn,
                verbose=False,
            )
        else:
            # MAE loss with sample weighting
            self.model = CatBoostRegressor(
                iterations=cfg.iterations,
                learning_rate=cfg.learning_rate,
                depth=cfg.depth,
                l2_leaf_reg=cfg.l2_leaf_reg,
                min_data_in_leaf=cfg.min_data_in_leaf,
                random_seed=cfg.random_seed,
                loss_function='MAE',
                verbose=False,
            )

        try:
            self.model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)
        except Exception as e:
            # Fall back to MAE loss if custom loss fails
            print(f"    Custom loss failed ({e}), using MAE loss")
            self.model = CatBoostRegressor(
                iterations=cfg.iterations,
                learning_rate=cfg.learning_rate,
                depth=cfg.depth,
                l2_leaf_reg=cfg.l2_leaf_reg,
                min_data_in_leaf=cfg.min_data_in_leaf,
                random_seed=cfg.random_seed,
                loss_function='MAE',
                verbose=False,
            )
            self.model.fit(X_train, y_train, sample_weight=sample_weights, verbose=False)

        self.is_trained = True

        # Feature importance
        importance = self.model.get_feature_importance()
        feat_imp = sorted(zip(self.feature_names, importance), key=lambda x: -x[1])

        print(f"\n  Top 10 Features:")
        for fname, imp in feat_imp[:10]:
            print(f"    {fname}: {imp:.1f}")

        # Training stats
        y_pred_train = self.model.predict(X_train)
        train_mae = np.mean(np.abs(y_pred_train - y_train))
        train_mbe = np.mean(y_pred_train - y_train)

        self.training_stats = {
            'n_plants': len(plants),
            'n_samples': len(y_train),
            'n_features': X_train.shape[1],
            'feature_names': self.feature_names,
            'sr_distribution': dict(bins),
            'train_mae': float(train_mae),
            'train_mbe': float(train_mbe),
            'feature_importance': dict(feat_imp[:20]),
            'trained_at': datetime.now().isoformat(),
        }

        print(f"\n  Training MAE: {train_mae*100:.2f}%")
        print(f"  Training MBE: {train_mbe*100:+.2f}% (+ = predicts cleaner)")
        print(f"  Model trained successfully")

        return self.training_stats

    def predict(
        self,
        features: np.ndarray,
        apply_bias: bool = True,
        return_uncertainty: bool = False,
    ) -> np.ndarray:
        """Predict soiling ratio for new data.

        Parameters
        ----------
        features : np.ndarray
            Feature matrix (n_samples, n_features)
        apply_bias : bool
            Apply conservative bias (subtract from prediction)
        return_uncertainty : bool
            Return uncertainty estimate alongside prediction

        Returns
        -------
        np.ndarray
            Predicted soiling ratio (clipped to [0.7, 1.0])
        """
        if not self.is_trained:
            raise ValueError("Model not trained. Call train_on_all_dustiq_plants() first.")

        # Handle NaN
        features = np.nan_to_num(features, nan=0.0)

        # Predict
        pred = self.model.predict(features)

        # Apply conservative bias (predict dirtier)
        if apply_bias:
            pred = pred - self.config.conservative_bias

        # Clip to valid range
        pred = np.clip(pred, 0.7, 1.0)

        if return_uncertainty:
            # Estimate uncertainty based on feature variance
            # Higher uncertainty for extreme values
            uncertainty = np.abs(pred - 0.95) * 0.05 + 0.02
            return pred, uncertainty

        return pred

    def predict_with_confidence(
        self,
        features: np.ndarray,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Predict with confidence intervals.

        Returns (prediction, lower_bound, upper_bound).
        Lower bound is more conservative (dirtier).
        """
        pred = self.predict(features, apply_bias=True)

        # Confidence interval: +-3% typically
        margin = 0.03
        lower = np.clip(pred - margin, 0.7, 1.0)
        upper = np.clip(pred + margin, 0.7, 1.0)

        return pred, lower, upper

    def evaluate_on_plant(
        self,
        plant_id: str,
        use_cleaned: bool = True,
    ) -> Dict:
        """Evaluate model on a held-out plant.

        Parameters
        ----------
        plant_id : str
            Plant to evaluate on
        use_cleaned : bool
            Use cleaned SCADA data

        Returns
        -------
        Dict
            Evaluation metrics (MAE, MBE by SR bin)
        """
        from scripts.evaluate_transfer_enhanced import (
            load_plant_scada, load_plant_enhanced_features, SR_BINS
        )

        df_scada, sr_target = load_plant_scada(plant_id, use_cleaned=use_cleaned)
        if df_scada is None:
            return {'error': 'Could not load data'}

        df_features = load_plant_enhanced_features(plant_id, df_scada, include_hybrid=True)
        if df_features is None:
            return {'error': 'Could not extract features'}

        # Align
        common_idx = df_features.index.intersection(sr_target.index)
        X = df_features.loc[common_idx].values
        y_true = sr_target.loc[common_idx].values

        # Handle feature mismatch
        if X.shape[1] != len(self.feature_names):
            if X.shape[1] < len(self.feature_names):
                diff = len(self.feature_names) - X.shape[1]
                X = np.hstack([X, np.zeros((len(X), diff))])
            else:
                X = X[:, :len(self.feature_names)]

        # Predict
        y_pred = self.predict(X, apply_bias=True)

        # 7-day rolling average
        def rolling_avg(arr, window=7):
            result = np.zeros_like(arr)
            for i in range(len(arr)):
                start = max(0, i - window + 1)
                result[i] = np.mean(arr[start:i+1])
            return result

        y_pred_7d = rolling_avg(y_pred, 7)
        y_true_7d = rolling_avg(y_true, 7)

        errors = y_pred_7d - y_true_7d

        # Overall metrics
        mae = np.mean(np.abs(errors))
        mbe = np.mean(errors)  # + = predicts cleaner (risky), - = predicts dirtier (safe)
        worst_over = np.max(errors)   # Worst overprediction (thinks cleaner)
        worst_under = np.min(errors)  # Worst underprediction (thinks dirtier)

        # By SR bin
        bins_result = {}
        for low, high, label in SR_BINS:
            mask = (y_true_7d >= low) & (y_true_7d < high)
            if mask.sum() > 0:
                bin_errors = errors[mask]
                bins_result[label] = {
                    'count': int(mask.sum()),
                    'mae': float(np.mean(np.abs(bin_errors))),
                    'mbe': float(np.mean(bin_errors)),
                    'worst_over': float(np.max(bin_errors)),
                    'worst_under': float(np.min(bin_errors)),
                }

        return {
            'plant_id': plant_id,
            'n_days': len(y_true),
            'mae_7d': float(mae),
            'mbe_7d': float(mbe),
            'worst_over': float(worst_over),
            'worst_under': float(worst_under),
            'bins': bins_result,
            'is_conservative': mbe < 0,  # True if predicts dirtier on average
        }

    def save(self, path: Path):
        """Save model to file."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, 'wb') as f:
            pickle.dump({
                'model': self.model,
                'feature_names': self.feature_names,
                'config': self.config,
                'training_stats': self.training_stats,
            }, f)

        print(f"Model saved to: {path}")

    @classmethod
    def load(cls, path: Path) -> 'SoilingFoundationModel':
        """Load model from file."""
        with open(path, 'rb') as f:
            data = pickle.load(f)

        instance = cls(config=data['config'])
        instance.model = data['model']
        instance.feature_names = data['feature_names']
        instance.training_stats = data['training_stats']
        instance.is_trained = True

        return instance


def train_per_climate(
    save_dir: Path,
    conservative_bias: float = 0.02,
) -> Dict:
    """Train one foundation model per climate zone with ≥1 DustIQ donor.

    For each ``ClimateZone`` returned by ``zones_with_donors()`` (e.g.
    MEDITERRANEAN, TEMPERATE_CONTINENTAL today), train a separate
    ``SoilingFoundationModel`` using only that zone's donors. Save each
    artifact as ``soiling_foundation_{ZONE}.pkl`` under ``save_dir``.

    Mediterranean targets never see Epsilon's continental seasonality; the
    continental model never sees Mediterranean signal. Each zone's model
    is internally consistent.

    Returns a registry keyed by zone-name with model paths + training
    stats (used by callers + dev diagnostics).
    """
    from nuravolt.soiling.climate_regions import (
        ClimateZone,
        donors_for_zone,
        zones_with_donors,
    )

    save_dir = Path(save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)

    registry: Dict[str, Dict] = {}
    eligible_zones = zones_with_donors()
    print(f"\n{'='*60}")
    print(f"TRAINING PER-CLIMATE FOUNDATION MODELS")
    print(f"{'='*60}")
    print(f"Eligible zones (≥1 donor): {[z.value for z in eligible_zones]}")

    for zone in eligible_zones:
        donors = donors_for_zone(zone)
        if not donors:
            continue

        print(f"\n--- Zone {zone.value} (donors: {donors}) ---")
        model = SoilingFoundationModel(conservative_bias=conservative_bias)
        try:
            stats = model.train_on_all_dustiq_plants(plant_ids=donors)
        except Exception as e:
            print(f"  ! Training failed for {zone.value}: {e}")
            registry[zone.value] = {"error": str(e), "donors": donors}
            continue

        out = save_dir / f"soiling_foundation_{zone.value}.pkl"
        model.save(out)
        registry[zone.value] = {
            "model_path": str(out),
            "donors": donors,
            "n_samples": stats.get("n_samples"),
            "n_features": stats.get("n_features"),
            "train_mae": stats.get("train_mae"),
            "train_mbe": stats.get("train_mbe"),
            "trained_at": stats.get("trained_at"),
        }

    print(f"\n{'='*60}")
    print(f"SUMMARY — per-climate training")
    print(f"{'='*60}")
    for zone_name, info in registry.items():
        if "error" in info:
            print(f"  {zone_name}: ERROR — {info['error']}")
        else:
            print(
                f"  {zone_name}: {len(info['donors'])} donors, "
                f"{info['n_samples']} samples, MAE={info['train_mae']*100:.2f}%, "
                f"MBE={info['train_mbe']*100:+.2f}%"
            )
    return registry


def load_model_for_zone(zone, models_dir: Path) -> Optional[SoilingFoundationModel]:
    """Load the per-zone foundation model from disk if it exists.

    Returns None for zones without a trained model (e.g. African zones
    where we have no donors yet). The forecast generator handles None by
    falling back to climatology-only inference.
    """
    from nuravolt.soiling.climate_regions import ClimateZone

    if isinstance(zone, str):
        try:
            zone = ClimateZone(zone)
        except ValueError:
            return None

    path = Path(models_dir) / f"soiling_foundation_{zone.value}.pkl"
    if not path.exists():
        return None
    try:
        return SoilingFoundationModel.load(path)
    except Exception as e:
        print(f"  ! Failed to load {path}: {e}")
        return None


def train_and_evaluate_foundation_model(
    conservative_bias: float = 0.02,
    save_path: Optional[Path] = None,
) -> Tuple[SoilingFoundationModel, Dict]:
    """Train foundation model and evaluate on all plants.

    Parameters
    ----------
    conservative_bias : float
        Safety margin (default 2%)
    save_path : Path, optional
        Where to save the trained model

    Returns
    -------
    Tuple[SoilingFoundationModel, Dict]
        Trained model and evaluation results
    """
    # Train
    model = SoilingFoundationModel(conservative_bias=conservative_bias)
    model.train_on_all_dustiq_plants()

    # Evaluate on all valid plants
    print(f"\n{'='*60}")
    print(f"LEAVE-ONE-OUT EVALUATION")
    print(f"{'='*60}")

    results = {}
    for plant_id in VALID_PLANTS:
        print(f"\n  {plant_id.upper()}:")
        r = model.evaluate_on_plant(plant_id)

        if 'error' in r:
            print(f"    ERROR: {r['error']}")
            continue

        results[plant_id] = r

        is_source = plant_id in DUSTIQ_PLANTS
        marker = " (source)" if is_source else ""
        conservative = "CONSERVATIVE" if r['is_conservative'] else "RISKY"

        print(f"    MAE: {r['mae_7d']*100:.2f}%, MBE: {r['mbe_7d']*100:+.2f}% [{conservative}]{marker}")
        print(f"    Worst errors: {r['worst_under']*100:+.1f}% to {r['worst_over']*100:+.1f}%")

        for label in ["<90%", "90-95%", "95-98%", "98-99%", ">99%"]:
            b = r['bins'].get(label, {})
            if b.get('count', 0) > 0:
                print(f"      {label}: MAE={b['mae']*100:.2f}%, MBE={b['mbe']*100:+.2f}% ({b['count']} days)")

    # Summary
    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")

    non_source = [r for p, r in results.items() if p not in DUSTIQ_PLANTS]
    if non_source:
        avg_mae = np.mean([r['mae_7d'] for r in non_source])
        avg_mbe = np.mean([r['mbe_7d'] for r in non_source])
        n_conservative = sum(1 for r in non_source if r['is_conservative'])

        print(f"\nNon-source plants:")
        print(f"  Avg MAE: {avg_mae*100:.2f}%")
        print(f"  Avg MBE: {avg_mbe*100:+.2f}%")
        print(f"  Conservative: {n_conservative}/{len(non_source)}")

    # Save
    if save_path:
        model.save(save_path)

    return model, results


if __name__ == "__main__":
    # Per-climate training (one model per zone with ≥1 DustIQ donor).
    # Replaces the previous single-pool training which mixed continental
    # and Mediterranean donors and produced inverted seasonality on
    # Mediterranean targets.
    save_dir = Path("backenddata/models")
    registry = train_per_climate(save_dir=save_dir, conservative_bias=0.02)
    print(f"\nArtifacts written to {save_dir.resolve()}")
    for zone_name, info in registry.items():
        if "model_path" in info:
            print(f"  • {zone_name}: {info['model_path']}")
