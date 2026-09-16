"""CatBoost-based Soiling Ratio prediction model with transfer learning support.

This module provides:
1. Foundation model training on plants with DustIQ ground truth
2. Transfer learning to plants without DustIQ sensors
3. Per-inverter SR estimation with shared model architecture
4. Physical constraints (SR bounded to [0.75, 1.0])

Model Variants:
- dustiq: Trained on DustIQ sensor ground truth
- pseudo: Trained on pseudo-labels from rain+AOD+PR patterns
"""

import numpy as np
import pandas as pd
import pickle
import json
from pathlib import Path
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional, Tuple, Union, Literal
from datetime import datetime
from enum import Enum

try:
    from catboost import CatBoostRegressor, Pool
    CATBOOST_AVAILABLE = True
except ImportError:
    CATBOOST_AVAILABLE = False


class ModelVariant(Enum):
    """Model variant types for SR prediction."""
    DUSTIQ = "dustiq"       # Trained on DustIQ ground truth
    PSEUDO = "pseudo"       # Trained on pseudo-labels (rain+AOD+PR)


@dataclass
class SoilingRatioModelConfig:
    """Configuration for SR prediction model."""

    # Model parameters
    iterations: int = 2000  # More iterations for better learning
    learning_rate: float = 0.02  # Slightly lower for stability
    depth: int = 6
    l2_leaf_reg: float = 3.0
    random_seed: int = 42

    # Training parameters
    early_stopping_rounds: int = None  # Disable early stopping - let it learn
    train_test_split: float = 0.2  # Temporal split

    # Loss function - Quantile:alpha=0.3 biases predictions toward lower values
    # This helps the model learn to predict soiling events instead of the mean
    loss_function: str = 'Quantile:alpha=0.3'

    # Physical constraints
    min_sr: float = 0.75  # Physical minimum (25% soiling is extreme)
    max_sr: float = 1.0   # Clean panel

    # Transfer learning parameters
    fine_tune_learning_rate: float = 0.01  # Lower LR for fine-tuning
    fine_tune_iterations: int = 500


@dataclass
class PerInverterModelConfig:
    """Configuration for per-inverter SR prediction.

    This config extends the base SR model to support:
    - Per-inverter feature engineering
    - Multiple model variants (DustIQ vs pseudo-labels)
    - Shared model with inverter-specific features
    """

    # Base model config
    base_config: SoilingRatioModelConfig = field(
        default_factory=SoilingRatioModelConfig
    )

    # Model variant
    variant: str = "pseudo"  # "dustiq" or "pseudo"

    # Per-inverter features to include
    use_inverter_group: bool = True      # Encode inverter group (INV 01-05)
    use_inverter_position: bool = True   # Position within group
    use_inverter_pr: bool = True         # Per-inverter PR features
    use_inverter_anomaly: bool = True    # Historical anomaly rate
    use_inverter_baseline: bool = True   # Historical SR baseline

    # Categorical feature handling
    categorical_features: List[str] = field(
        default_factory=lambda: ['inverter_group_encoded']
    )

    # Per-inverter validation
    validate_fleet_consistency: bool = True  # Check SR within 2 std of fleet
    validate_rain_reset: bool = True         # Check SR > 0.99 after heavy rain
    validate_monotonic_decay: bool = True    # Check SR decreasing between rain

    # Confidence thresholds
    min_confidence_for_training: float = 0.5  # Minimum pseudo-label confidence
    high_confidence_threshold: float = 0.8    # High-confidence threshold

    # Output settings
    output_history_days: int = 30  # Days of history in JSON output
    forecast_horizon_days: int = 7  # Days to forecast

    # Performance targets (for pseudo-label model plausibility)
    target_sr_after_rain: float = 0.99   # Expected SR after heavy rain
    max_fleet_sr_std: float = 0.02       # Max standard deviation within fleet

    def get_feature_columns(self) -> List[str]:
        """Get list of inverter-specific feature columns."""
        features = []
        if self.use_inverter_group:
            features.append('inverter_group_encoded')
        if self.use_inverter_position:
            features.append('inverter_position')
        if self.use_inverter_pr:
            features.extend([
                'inverter_pr_7d',
                'inverter_pr_deviation',
                'inverter_pr_trend'
            ])
        if self.use_inverter_anomaly:
            features.append('inverter_anomaly_rate')
        if self.use_inverter_baseline:
            features.append('inverter_sr_baseline')
        return features


@dataclass
class ModelMetadata:
    """Metadata stored with model artifact."""
    plant_id: str
    is_foundation: bool
    training_start: str
    training_end: str
    n_samples: int
    feature_names: List[str]
    validation_mae: float
    validation_rmse: float
    validation_r2: float
    created_at: str
    config: dict
    fine_tuned_from: Optional[str] = None

    # Per-inverter specific metadata
    model_variant: Optional[str] = None  # "dustiq" or "pseudo"
    n_inverters: Optional[int] = None    # Number of inverters in training
    inverter_features: Optional[List[str]] = None  # Inverter-specific features used
    pseudo_label_stats: Optional[dict] = None  # Stats from pseudo-label generation


@dataclass
class PerInverterPrediction:
    """Container for per-inverter SR predictions."""
    inverter_id: str
    date: str
    sr_predicted: float
    confidence: float
    method: str  # "dustiq" or "pseudo"

    # Optional diagnostic info
    sr_deviation_from_fleet: Optional[float] = None
    is_anomaly: Optional[bool] = None


class SoilingRatioModel:
    """CatBoost-based SR prediction model with transfer learning."""

    def __init__(self, config: Optional[SoilingRatioModelConfig] = None):
        """
        Initialize SR model.

        Parameters
        ----------
        config : SoilingRatioModelConfig, optional
            Model configuration. Uses defaults if None.
        """
        if not CATBOOST_AVAILABLE:
            raise ImportError("CatBoost not installed. Install with: pip install catboost")

        self.config = config or SoilingRatioModelConfig()
        self.model: Optional[CatBoostRegressor] = None
        self.feature_names: List[str] = []
        self.metadata: Optional[ModelMetadata] = None

    def fit(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_val: Optional[pd.DataFrame] = None,
        y_val: Optional[pd.Series] = None,
        plant_id: str = "unknown",
        verbose: bool = True,
        sample_weight: Optional[np.ndarray] = None
    ) -> 'SoilingRatioModel':
        """
        Train the foundation model on DustIQ ground truth.

        Parameters
        ----------
        X_train : pd.DataFrame
            Training features
        y_train : pd.Series
            Training target (sr_dustiq)
        X_val : pd.DataFrame, optional
            Validation features
        y_val : pd.Series, optional
            Validation target
        plant_id : str
            Plant identifier for metadata
        verbose : bool
            Print training progress
        sample_weight : np.ndarray, optional
            Sample weights to emphasize soiling events.
            If None, will auto-compute weights based on SR values.

        Returns
        -------
        self : SoilingRatioModel
        """
        if verbose:
            print(f"Training SR model on {len(X_train)} samples...")

        self.feature_names = X_train.columns.tolist()

        # Handle NaN values
        X_train_clean = X_train.fillna(0)
        y_train_clean = y_train.fillna(y_train.mean())

        # Auto-compute sample weights to emphasize soiling events
        if sample_weight is None:
            sample_weight = self._compute_soiling_weights(y_train_clean)
            if verbose:
                n_soiled = np.sum(y_train_clean < 0.99)
                print(f"  Auto-computed sample weights: {n_soiled} soiling events ({n_soiled/len(y_train)*100:.1f}%)")
                print(f"  Weight range: [{sample_weight.min():.2f}, {sample_weight.max():.2f}]")

        # For soiling prediction, train for fixed iterations without early stopping
        # because MAE-based early stopping on highly imbalanced data prefers
        # predicting the mean, which doesn't capture soiling events
        use_early_stopping = self.config.early_stopping_rounds is not None

        # Create CatBoost model with Quantile loss to learn soiling distribution
        self.model = CatBoostRegressor(
            iterations=self.config.iterations,
            learning_rate=self.config.learning_rate,
            depth=self.config.depth,
            l2_leaf_reg=self.config.l2_leaf_reg,
            random_seed=self.config.random_seed,
            loss_function=self.config.loss_function,  # Quantile loss biases toward lower predictions
            verbose=100 if verbose else 0,
            early_stopping_rounds=self.config.early_stopping_rounds if use_early_stopping and X_val is not None else None
        )

        # Prepare training pool with sample weights
        train_pool = Pool(X_train_clean, y_train_clean, weight=sample_weight)

        # Prepare validation data only if early stopping enabled
        eval_set = None
        if use_early_stopping and X_val is not None and y_val is not None:
            X_val_clean = X_val.fillna(0)
            y_val_clean = y_val.fillna(y_val.mean())
            # Apply weights to validation set too
            val_weights = self._compute_soiling_weights(y_val_clean)
            eval_set = Pool(X_val_clean, y_val_clean, weight=val_weights)

        # Train
        self.model.fit(
            train_pool,
            eval_set=eval_set,
            use_best_model=use_early_stopping and eval_set is not None
        )

        # Calculate validation metrics
        if X_val is not None and y_val is not None:
            y_pred = self.predict(X_val)
            val_mae = np.mean(np.abs(y_val - y_pred))
            val_rmse = np.sqrt(np.mean((y_val - y_pred) ** 2))
            val_r2 = 1 - np.sum((y_val - y_pred) ** 2) / np.sum((y_val - y_val.mean()) ** 2)
        else:
            # Use training data for metrics
            y_pred = self.predict(X_train)
            val_mae = np.mean(np.abs(y_train - y_pred))
            val_rmse = np.sqrt(np.mean((y_train - y_pred) ** 2))
            val_r2 = 1 - np.sum((y_train - y_pred) ** 2) / np.sum((y_train - y_train.mean()) ** 2)

        # Store metadata
        self.metadata = ModelMetadata(
            plant_id=plant_id,
            is_foundation=True,
            training_start=str(X_train.index.min()) if hasattr(X_train.index, 'min') else "",
            training_end=str(X_train.index.max()) if hasattr(X_train.index, 'max') else "",
            n_samples=len(X_train),
            feature_names=self.feature_names,
            validation_mae=float(val_mae),
            validation_rmse=float(val_rmse),
            validation_r2=float(val_r2),
            created_at=datetime.now().isoformat(),
            config=asdict(self.config)
        )

        if verbose:
            print(f"Training complete:")
            print(f"  MAE: {val_mae:.4f}")
            print(f"  RMSE: {val_rmse:.4f}")
            print(f"  R2: {val_r2:.4f}")

        return self

    def _compute_soiling_weights(self, y: pd.Series) -> np.ndarray:
        """
        Compute sample weights to HEAVILY emphasize soiling events.

        The model must learn to predict soiling, not just the mean.
        We use very aggressive weighting to force attention to rare soiling events.

        Parameters
        ----------
        y : pd.Series
            Target SR values

        Returns
        -------
        np.ndarray
            Sample weights
        """
        y_arr = np.array(y)

        # Soiling loss: how far from clean (1.0)
        soiling_loss = 1.0 - y_arr  # 0 for clean, 0.02 for 2% soiling

        # AGGRESSIVE exponential scaling to force learning soiling events
        # scale_factor=200: SR=0.99 -> weight~7, SR=0.98 -> weight~55, SR=0.97 -> weight~403
        scale_factor = 200.0
        weights = np.exp(soiling_loss * scale_factor)

        # Cap at very high weight to make soiling events dominate
        weights = np.clip(weights, 1.0, 500.0)

        # Also boost any day below median SR
        median_sr = np.median(y_arr)
        below_median = y_arr < median_sr
        weights[below_median] *= 2.0  # Double weight for below-median days

        # Normalize so mean weight is ~1.0
        weights = weights / weights.mean()

        return weights

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        """
        Predict soiling ratio.

        Parameters
        ----------
        X : pd.DataFrame
            Features

        Returns
        -------
        np.ndarray
            Predicted SR values (clipped to physical bounds)
        """
        if self.model is None:
            raise ValueError("Model not trained. Call fit() first.")

        # Handle missing features
        X_aligned = X.reindex(columns=self.feature_names, fill_value=0)
        X_clean = X_aligned.fillna(0)

        # Predict
        sr_pred = self.model.predict(X_clean)

        # Apply physical constraints
        sr_pred = np.clip(sr_pred, self.config.min_sr, self.config.max_sr)

        return sr_pred

    def fine_tune(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_val: Optional[pd.DataFrame] = None,
        y_val: Optional[pd.Series] = None,
        plant_id: str = "unknown",
        verbose: bool = True
    ) -> 'SoilingRatioModel':
        """
        Fine-tune model for a new plant using pseudo-labels.

        Uses lower learning rate to preserve foundation knowledge.

        Parameters
        ----------
        X_train : pd.DataFrame
            Fine-tuning features
        y_train : pd.Series
            Fine-tuning target (pseudo-labels)
        X_val : pd.DataFrame, optional
            Validation features
        y_val : pd.Series, optional
            Validation target
        plant_id : str
            New plant identifier
        verbose : bool
            Print training progress

        Returns
        -------
        SoilingRatioModel
            New fine-tuned model
        """
        if self.model is None:
            raise ValueError("Model not trained. Call fit() first or load a foundation model.")

        if verbose:
            print(f"Fine-tuning SR model for {plant_id} on {len(X_train)} samples...")

        # Create new model with lower learning rate
        fine_tuned_model = CatBoostRegressor(
            iterations=self.config.fine_tune_iterations,
            learning_rate=self.config.fine_tune_learning_rate,
            depth=self.config.depth,
            l2_leaf_reg=self.config.l2_leaf_reg * 2,  # More regularization for fine-tuning
            random_seed=self.config.random_seed,
            loss_function='MAE',
            verbose=100 if verbose else 0,
            early_stopping_rounds=50 if X_val is not None else None
        )

        # Initialize from foundation model weights
        # CatBoost supports init_model parameter
        X_train_clean = X_train.reindex(columns=self.feature_names, fill_value=0).fillna(0)
        y_train_clean = y_train.fillna(y_train.mean())

        eval_set = None
        if X_val is not None and y_val is not None:
            X_val_clean = X_val.reindex(columns=self.feature_names, fill_value=0).fillna(0)
            y_val_clean = y_val.fillna(y_val.mean())
            eval_set = Pool(X_val_clean, y_val_clean)

        fine_tuned_model.fit(
            X_train_clean,
            y_train_clean,
            eval_set=eval_set,
            init_model=self.model,  # Start from foundation weights
            use_best_model=True if eval_set else False
        )

        # Create new model instance with fine-tuned model
        result = SoilingRatioModel(self.config)
        result.model = fine_tuned_model
        result.feature_names = self.feature_names

        # Calculate metrics
        y_pred = result.predict(X_train)
        val_mae = np.mean(np.abs(y_train - y_pred))
        val_rmse = np.sqrt(np.mean((y_train - y_pred) ** 2))
        val_r2 = 1 - np.sum((y_train - y_pred) ** 2) / np.sum((y_train - y_train.mean()) ** 2)

        # Update metadata
        result.metadata = ModelMetadata(
            plant_id=plant_id,
            is_foundation=False,
            training_start=str(X_train.index.min()) if hasattr(X_train.index, 'min') else "",
            training_end=str(X_train.index.max()) if hasattr(X_train.index, 'max') else "",
            n_samples=len(X_train),
            feature_names=self.feature_names,
            validation_mae=float(val_mae),
            validation_rmse=float(val_rmse),
            validation_r2=float(val_r2),
            created_at=datetime.now().isoformat(),
            config=asdict(self.config),
            fine_tuned_from=self.metadata.plant_id if self.metadata else "unknown"
        )

        if verbose:
            print(f"Fine-tuning complete:")
            print(f"  MAE: {val_mae:.4f}")
            print(f"  RMSE: {val_rmse:.4f}")
            print(f"  R2: {val_r2:.4f}")

        return result

    def get_feature_importance(self) -> pd.DataFrame:
        """
        Get feature importance scores.

        Returns
        -------
        pd.DataFrame
            Feature importance sorted by importance
        """
        if self.model is None:
            raise ValueError("Model not trained.")

        importance = self.model.get_feature_importance()
        df_importance = pd.DataFrame({
            'feature': self.feature_names,
            'importance': importance
        }).sort_values('importance', ascending=False)

        return df_importance

    def save(self, path: Union[str, Path]) -> None:
        """
        Save model to file.

        Parameters
        ----------
        path : str or Path
            Output file path (will save .pkl and .json metadata)
        """
        if self.model is None:
            raise ValueError("Model not trained.")

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        # Save model
        with open(path, 'wb') as f:
            pickle.dump({
                'model': self.model,
                'feature_names': self.feature_names,
                'config': asdict(self.config),
                'metadata': asdict(self.metadata) if self.metadata else None
            }, f)

        # Save metadata as JSON for easy reading
        meta_path = path.with_suffix('.json')
        with open(meta_path, 'w') as f:
            json.dump(asdict(self.metadata) if self.metadata else {}, f, indent=2)

        print(f"Model saved to {path}")

    @classmethod
    def load(cls, path: Union[str, Path]) -> 'SoilingRatioModel':
        """
        Load model from file.

        Parameters
        ----------
        path : str or Path
            Model file path

        Returns
        -------
        SoilingRatioModel
            Loaded model
        """
        path = Path(path)

        with open(path, 'rb') as f:
            data = pickle.load(f)

        config = SoilingRatioModelConfig(**data['config'])
        model = cls(config)
        model.model = data['model']
        model.feature_names = data['feature_names']

        if data['metadata']:
            model.metadata = ModelMetadata(**data['metadata'])

        return model


def evaluate_model(
    model: SoilingRatioModel,
    X_test: pd.DataFrame,
    y_test: pd.Series
) -> Dict[str, float]:
    """
    Evaluate model performance.

    Parameters
    ----------
    model : SoilingRatioModel
        Trained model
    X_test : pd.DataFrame
        Test features
    y_test : pd.Series
        Test target

    Returns
    -------
    dict
        Performance metrics
    """
    y_pred = model.predict(X_test)

    # Handle NaN in y_test
    mask = ~np.isnan(y_test)
    y_test_clean = y_test[mask]
    y_pred_clean = y_pred[mask]

    mae = np.mean(np.abs(y_test_clean - y_pred_clean))
    rmse = np.sqrt(np.mean((y_test_clean - y_pred_clean) ** 2))
    r2 = 1 - np.sum((y_test_clean - y_pred_clean) ** 2) / np.sum((y_test_clean - y_test_clean.mean()) ** 2)

    # Bias
    bias = np.mean(y_pred_clean - y_test_clean)

    # Correlation
    corr = np.corrcoef(y_test_clean, y_pred_clean)[0, 1]

    return {
        'mae': mae,
        'rmse': rmse,
        'r2': r2,
        'bias': bias,
        'correlation': corr,
        'n_samples': len(y_test_clean)
    }


class PerInverterSRModel(SoilingRatioModel):
    """
    Extended SR model for per-inverter prediction.

    Supports both DustIQ-based and pseudo-label-based training
    with per-inverter feature engineering.
    """

    def __init__(
        self,
        config: Optional[PerInverterModelConfig] = None
    ):
        """
        Initialize per-inverter SR model.

        Parameters
        ----------
        config : PerInverterModelConfig, optional
            Per-inverter configuration. Uses defaults if None.
        """
        self.per_inverter_config = config or PerInverterModelConfig()

        # Initialize base model with the embedded config
        super().__init__(self.per_inverter_config.base_config)

        # Track inverter metadata
        self.inverter_ids: List[str] = []
        self.n_inverters: int = 0

    def fit_per_inverter(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        inverter_ids: pd.Series,
        X_val: Optional[pd.DataFrame] = None,
        y_val: Optional[pd.Series] = None,
        plant_id: str = "unknown",
        verbose: bool = True,
        sample_weight: Optional[np.ndarray] = None
    ) -> 'PerInverterSRModel':
        """
        Train model on per-inverter data.

        Parameters
        ----------
        X_train : pd.DataFrame
            Training features (expanded to per-inverter rows)
        y_train : pd.Series
            Training target (SR per inverter per day)
        inverter_ids : pd.Series
            Inverter IDs corresponding to each row
        X_val : pd.DataFrame, optional
            Validation features
        y_val : pd.Series, optional
            Validation target
        plant_id : str
            Plant identifier
        verbose : bool
            Print training progress
        sample_weight : np.ndarray, optional
            Sample weights

        Returns
        -------
        self : PerInverterSRModel
        """
        # Store inverter info
        self.inverter_ids = inverter_ids.unique().tolist()
        self.n_inverters = len(self.inverter_ids)

        if verbose:
            print(f"Training per-inverter SR model ({self.per_inverter_config.variant}):")
            print(f"  Inverters: {self.n_inverters}")
            print(f"  Total samples: {len(X_train)}")
            print(f"  Features: {len(X_train.columns)}")

        # Get categorical feature indices
        cat_features = []
        for i, col in enumerate(X_train.columns):
            if col in self.per_inverter_config.categorical_features:
                cat_features.append(i)

        # Modify CatBoost config to handle categorical features
        if cat_features and verbose:
            print(f"  Categorical features: {cat_features}")

        # Call base fit method
        self.fit(
            X_train=X_train,
            y_train=y_train,
            X_val=X_val,
            y_val=y_val,
            plant_id=plant_id,
            verbose=verbose,
            sample_weight=sample_weight
        )

        # Update metadata with per-inverter info
        if self.metadata:
            self.metadata.model_variant = self.per_inverter_config.variant
            self.metadata.n_inverters = self.n_inverters
            self.metadata.inverter_features = self.per_inverter_config.get_feature_columns()

        return self

    def predict_per_inverter(
        self,
        X: pd.DataFrame,
        inverter_ids: pd.Series,
        dates: pd.Series
    ) -> pd.DataFrame:
        """
        Predict SR for all inverters.

        Parameters
        ----------
        X : pd.DataFrame
            Features (per-inverter rows)
        inverter_ids : pd.Series
            Inverter IDs
        dates : pd.Series
            Dates

        Returns
        -------
        pd.DataFrame
            Predictions with columns:
            - inverter_id
            - date
            - sr_predicted
            - confidence
        """
        # Get raw predictions
        sr_pred = self.predict(X)

        # Build result DataFrame
        results = pd.DataFrame({
            'inverter_id': inverter_ids,
            'date': dates,
            'sr_predicted': sr_pred,
            'method': self.per_inverter_config.variant
        })

        # Calculate fleet statistics per date for confidence
        fleet_stats = results.groupby('date')['sr_predicted'].agg(['mean', 'std']).reset_index()
        fleet_stats.columns = ['date', 'fleet_mean', 'fleet_std']

        results = results.merge(fleet_stats, on='date', how='left')

        # Calculate deviation from fleet mean
        results['sr_deviation_from_fleet'] = results['sr_predicted'] - results['fleet_mean']

        # Confidence based on consistency with fleet
        results['confidence'] = 0.8  # Base confidence
        results.loc[results['fleet_std'].notna(), 'confidence'] = (
            0.8 - np.minimum(np.abs(results['sr_deviation_from_fleet']) / 0.05, 0.3)
        )

        # Flag anomalies (>2 std from fleet)
        results['is_anomaly'] = np.abs(results['sr_deviation_from_fleet']) > 2 * results['fleet_std']

        # Clean up
        results = results.drop(columns=['fleet_mean', 'fleet_std'])

        return results

    def validate_predictions(
        self,
        predictions: pd.DataFrame,
        rain_data: Optional[pd.DataFrame] = None
    ) -> Dict[str, any]:
        """
        Validate per-inverter predictions for plausibility.

        Parameters
        ----------
        predictions : pd.DataFrame
            Model predictions
        rain_data : pd.DataFrame, optional
            Rain data for rain-reset validation

        Returns
        -------
        dict
            Validation metrics and issues
        """
        cfg = self.per_inverter_config
        issues = []
        metrics = {}

        # Fleet consistency check
        if cfg.validate_fleet_consistency:
            daily_std = predictions.groupby('date')['sr_predicted'].std()
            metrics['avg_fleet_std'] = float(daily_std.mean())
            metrics['max_fleet_std'] = float(daily_std.max())

            if daily_std.max() > cfg.max_fleet_sr_std * 2:
                issues.append(f"High fleet variability: max std={daily_std.max():.3f}")

        # Rain reset check
        if cfg.validate_rain_reset and rain_data is not None:
            rain_data = rain_data.copy()
            rain_data['date'] = pd.to_datetime(rain_data['date'])

            # Find heavy rain days
            heavy_rain_days = rain_data[
                rain_data['precipitation_mm'] >= 10.0
            ]['date'].tolist()

            if heavy_rain_days:
                # Check SR after rain
                for rain_date in heavy_rain_days[-5:]:  # Check last 5
                    next_day = rain_date + pd.Timedelta(days=1)
                    post_rain = predictions[predictions['date'] == next_day]

                    if len(post_rain) > 0:
                        avg_sr_post_rain = post_rain['sr_predicted'].mean()
                        if avg_sr_post_rain < cfg.target_sr_after_rain:
                            issues.append(
                                f"Low SR after rain on {rain_date.date()}: "
                                f"{avg_sr_post_rain:.3f} < {cfg.target_sr_after_rain}"
                            )

                metrics['post_rain_sr_avg'] = float(avg_sr_post_rain) if len(post_rain) > 0 else None

        # Monotonic decay check (SR should generally decrease between rain events)
        if cfg.validate_monotonic_decay:
            daily_mean_sr = predictions.groupby('date')['sr_predicted'].mean().sort_index()
            sr_increases = (daily_mean_sr.diff() > 0.02).sum()  # Count significant increases
            total_days = len(daily_mean_sr) - 1

            if total_days > 0:
                metrics['sr_increase_ratio'] = float(sr_increases / total_days)
                # Some increases expected (after rain), but not too many
                if sr_increases / total_days > 0.3:  # More than 30% of days show increase
                    issues.append(f"High SR increase ratio: {sr_increases}/{total_days}")

        # Overall metrics
        metrics['mean_sr'] = float(predictions['sr_predicted'].mean())
        metrics['std_sr'] = float(predictions['sr_predicted'].std())
        metrics['min_sr'] = float(predictions['sr_predicted'].min())
        metrics['max_sr'] = float(predictions['sr_predicted'].max())
        metrics['anomaly_rate'] = float(predictions['is_anomaly'].mean())
        metrics['issues'] = issues
        metrics['is_valid'] = len(issues) == 0

        return metrics

    def to_json_output(
        self,
        predictions: pd.DataFrame,
        plant_id: str
    ) -> dict:
        """
        Convert predictions to JSON output format.

        Parameters
        ----------
        predictions : pd.DataFrame
            Model predictions
        plant_id : str
            Plant identifier

        Returns
        -------
        dict
            JSON-serializable output
        """
        cfg = self.per_inverter_config

        output = {
            'metadata': {
                'plant_id': plant_id,
                'model_variant': cfg.variant,
                'generated_at': datetime.now().isoformat(),
                'n_inverters': self.n_inverters
            },
            'inverters': {}
        }

        # Group by inverter
        for inv_id in predictions['inverter_id'].unique():
            inv_data = predictions[predictions['inverter_id'] == inv_id].copy()
            inv_data = inv_data.sort_values('date', ascending=False)

            # Get last N days
            recent = inv_data.head(cfg.output_history_days)

            output['inverters'][inv_id] = {
                'current_sr': float(recent.iloc[0]['sr_predicted']) if len(recent) > 0 else None,
                'sr_7d_avg': float(recent.head(7)['sr_predicted'].mean()) if len(recent) >= 7 else None,
                'confidence': float(recent.iloc[0]['confidence']) if len(recent) > 0 else None,
                'history': [
                    {
                        'date': row['date'].strftime('%Y-%m-%d') if hasattr(row['date'], 'strftime') else str(row['date']),
                        'sr': float(row['sr_predicted']),
                        'confidence': float(row['confidence'])
                    }
                    for _, row in recent.iterrows()
                ]
            }

        return output

    def save(self, path: Union[str, Path]) -> None:
        """
        Save model to file, including the per-inverter configuration.

        The base save() only persists the base config, which made the base
        load() reconstruct this subclass with the wrong config type — so
        PerInverterSRModel.load() raised AttributeError and no per-inverter
        model could ever be loaded back. This pair round-trips properly.
        """
        if self.model is None:
            raise ValueError("Model not trained.")

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, 'wb') as f:
            pickle.dump({
                'model': self.model,
                'feature_names': self.feature_names,
                'config': asdict(self.per_inverter_config.base_config),
                'per_inverter_config': asdict(self.per_inverter_config),
                'inverter_ids': self.inverter_ids,
                'n_inverters': self.n_inverters,
                'metadata': asdict(self.metadata) if self.metadata else None
            }, f)

        meta_path = path.with_suffix('.json')
        with open(meta_path, 'w') as f:
            json.dump(asdict(self.metadata) if self.metadata else {}, f, indent=2)

        print(f"Model saved to {path}")

    @classmethod
    def load(cls, path: Union[str, Path]) -> 'PerInverterSRModel':
        """Load a per-inverter model, tolerating legacy base-save pickles."""
        path = Path(path)

        with open(path, 'rb') as f:
            data = pickle.load(f)

        per_cfg_dict = data.get('per_inverter_config')
        if per_cfg_dict:
            base = SoilingRatioModelConfig(**per_cfg_dict.pop('base_config'))
            config = PerInverterModelConfig(base_config=base, **per_cfg_dict)
        else:
            # Legacy pickle from the base save(): only the base config exists.
            config = PerInverterModelConfig(
                base_config=SoilingRatioModelConfig(**data['config'])
            )

        model = cls(config)
        model.model = data['model']
        model.feature_names = data['feature_names']
        model.inverter_ids = data.get('inverter_ids', [])
        model.n_inverters = data.get('n_inverters', 0)

        if data.get('metadata'):
            model.metadata = ModelMetadata(**data['metadata'])

        return model
