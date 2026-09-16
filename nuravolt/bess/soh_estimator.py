"""
State of Health (SoH) Estimation Module

Physics-informed machine learning for battery health monitoring
and remaining useful life (RUL) prediction.

Transfer pattern from: nuravolt/soiling/sr_ml_model.py

HONESTY BOUNDARY: this estimator has never been trained or loaded in
production. Every SoH number the platform serves today comes from the
chemistry EmpiricalDegradationModel in nuravolt/bess/warranty_tracker.py.
Training this model needs real measured capacity tests (BessCapacityTest rows
of test_type 'standard' or 'partial', not the 'estimated' points the twin
writes); fitting it on modelled SoH would launder the degradation model's own
assumptions back as if they were independent evidence. ``predict`` therefore
raises rather than returning a number from an unfitted booster, and
``predict_rul`` reports a derived interval only when it is given real
observations to regress on.
"""

from dataclasses import dataclass, field
from typing import Optional, Sequence, Tuple
import numpy as np

try:
    import polars as pl
    POLARS_AVAILABLE = True
except ImportError:
    POLARS_AVAILABLE = False
    pl = None

try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False
    lgb = None


@dataclass
class BatteryFeatures:
    """Feature set for SoH estimation (analog to SoilingFeatures)"""
    cycle_count: float
    total_ah_throughput: float
    avg_temperature: float
    avg_c_rate: float
    dod_variance: float
    rest_time_ratio: float
    high_soc_hours: float = 0.0
    high_temp_hours: float = 0.0
    calendar_days: float = 0.0

    def to_array(self) -> np.ndarray:
        """Convert to numpy array for model input"""
        return np.array([
            self.cycle_count,
            self.total_ah_throughput,
            self.avg_temperature,
            self.avg_c_rate,
            self.dod_variance,
            self.rest_time_ratio,
            self.high_soc_hours,
            self.high_temp_hours,
            self.calendar_days,
        ])


@dataclass
class SoHEstimatorConfig:
    """Configuration for SoH estimator"""
    # Model parameters
    n_estimators: int = 100
    learning_rate: float = 0.1
    max_depth: int = 6

    # Physics constraints
    min_soh: float = 0.0
    max_soh: float = 1.0
    physics_weight: float = 0.1

    # Feature configuration
    feature_names: list = field(default_factory=lambda: [
        'cycle_count', 'total_ah_throughput', 'avg_temperature',
        'avg_c_rate', 'dod_variance', 'rest_time_ratio',
        'high_soc_hours', 'high_temp_hours', 'calendar_days'
    ])


# Two-sided 95 % Student-t critical values by degrees of freedom, so the RUL
# prediction interval needs no scipy dependency. Beyond df=30 the normal
# approximation (1.96) is within ~2 % of the exact value.
_T_CRITICAL_95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
    8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
    15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056,
    27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
}


def _t_critical_95(dof: int) -> float:
    """Two-sided 95 % t critical value for ``dof`` degrees of freedom."""
    if dof <= 0:
        return float('inf')
    return _T_CRITICAL_95.get(dof, 1.96)


def _fit_degradation_slope(
    observations: Optional[Sequence[Tuple[float, float]]]
) -> Optional[dict]:
    """
    OLS of SoH on cumulative cycles, with the slope's standard error.

    Args:
        observations: (cumulative_cycles, soh) pairs, e.g. real capacity tests

    Returns:
        Dict with slope, slope_stderr, r_squared, dof and n, or None when
        there are too few points (or no spread in cycles) to fit a slope and
        estimate its error. Two points always fit perfectly, so three is the
        minimum that leaves a residual degree of freedom.
    """
    if observations is None:
        return None

    points = [(float(x), float(y)) for x, y in observations]
    if len(points) < 3:
        return None

    x = np.array([p[0] for p in points], dtype=float)
    y = np.array([p[1] for p in points], dtype=float)

    x_mean = float(x.mean())
    y_mean = float(y.mean())
    ss_x = float(np.sum((x - x_mean) ** 2))
    if ss_x <= 0:
        return None  # all observations at the same cycle count

    slope = float(np.sum((x - x_mean) * (y - y_mean)) / ss_x)
    intercept = y_mean - slope * x_mean
    residuals = y - (intercept + slope * x)
    dof = len(points) - 2
    residual_var = float(np.sum(residuals ** 2)) / dof
    slope_stderr = float(np.sqrt(residual_var / ss_x))

    ss_tot = float(np.sum((y - y_mean) ** 2))
    r_squared = 1.0 - float(np.sum(residuals ** 2)) / ss_tot if ss_tot > 0 else None

    return {
        'slope': slope,
        'intercept': intercept,
        'slope_stderr': slope_stderr,
        'r_squared': r_squared,
        'dof': dof,
        'n': len(points),
    }


class SoHEstimator:
    """
    State of Health estimator using LightGBM with physics constraints.

    Architecture mirrors nuravolt/soiling/sr_ml_model.py

    Example:
        estimator = SoHEstimator()
        estimator.train(features_df, soh_targets)

        # Predict current SoH
        current_soh = estimator.predict(current_features)

        # Predict remaining useful life
        rul_days = estimator.predict_rul(current_soh, usage_profile)
    """

    def __init__(
        self,
        config: Optional[SoHEstimatorConfig] = None,
        physics_model=None
    ):
        """
        Initialize SoH estimator.

        Args:
            config: Model configuration
            physics_model: Optional physics model for hybrid predictions
        """
        self.config = config or SoHEstimatorConfig()
        self.physics = physics_model
        self.model = None
        self.is_fitted = False

        if not LIGHTGBM_AVAILABLE:
            raise ImportError(
                "lightgbm required for SoH estimation. "
                "Install with: pip install lightgbm"
            )

    def engineer_features(self, cycle_data) -> np.ndarray:
        """
        Engineer features from raw cycle data.

        Args:
            cycle_data: DataFrame or dict with cycle-level data

        Returns:
            Feature array for model input
        """
        if POLARS_AVAILABLE and isinstance(cycle_data, pl.DataFrame):
            return self._engineer_features_polars(cycle_data)

        # Handle dict input
        return BatteryFeatures(**cycle_data).to_array()

    def _engineer_features_polars(self, df: "pl.DataFrame") -> np.ndarray:
        """Feature engineering from Polars DataFrame"""
        features = df.select([
            pl.col('cycle_count').last(),
            pl.col('ah_throughput').sum().alias('total_ah_throughput'),
            pl.col('temperature').mean().alias('avg_temperature'),
            pl.col('c_rate').mean().alias('avg_c_rate'),
            pl.col('dod').var().alias('dod_variance'),
            (pl.col('rest_hours').sum() / pl.col('total_hours').sum())
                .alias('rest_time_ratio'),
            (pl.col('soc') > 0.8).sum().alias('high_soc_hours'),
            (pl.col('temperature') > 35).sum().alias('high_temp_hours'),
            pl.col('timestamp').max().diff(pl.col('timestamp').min())
                .dt.total_days().alias('calendar_days'),
        ]).to_numpy()[0]

        return features

    def train(
        self,
        features: np.ndarray,
        soh_targets: np.ndarray,
        validation_split: float = 0.2
    ) -> dict:
        """
        Train SoH estimator.

        Args:
            features: Feature array (n_samples, n_features)
            soh_targets: SoH targets (n_samples,)
            validation_split: Fraction for validation

        Returns:
            Dict with training metrics
        """
        n = len(soh_targets)
        n_val = int(n * validation_split)
        indices = np.random.permutation(n)

        train_idx = indices[n_val:]
        val_idx = indices[:n_val]

        X_train, X_val = features[train_idx], features[val_idx]
        y_train, y_val = soh_targets[train_idx], soh_targets[val_idx]

        # Create LightGBM datasets
        train_data = lgb.Dataset(X_train, label=y_train)
        val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

        # Training parameters
        params = {
            'objective': 'regression',
            'metric': 'mae',
            'learning_rate': self.config.learning_rate,
            'max_depth': self.config.max_depth,
            'num_leaves': 31,
            'verbose': -1,
        }

        # Train with early stopping
        self.model = lgb.train(
            params,
            train_data,
            num_boost_round=self.config.n_estimators,
            valid_sets=[val_data],
            callbacks=[lgb.early_stopping(10, verbose=False)]
        )

        self.is_fitted = True

        # Calculate metrics
        train_pred = self.model.predict(X_train)
        val_pred = self.model.predict(X_val)

        return {
            'train_mae': float(np.mean(np.abs(y_train - train_pred))),
            'val_mae': float(np.mean(np.abs(y_val - val_pred))),
            'train_rmse': float(np.sqrt(np.mean((y_train - train_pred) ** 2))),
            'val_rmse': float(np.sqrt(np.mean((y_val - val_pred) ** 2))),
            'n_train': len(train_idx),
            'n_val': len(val_idx),
        }

    def predict(self, features: np.ndarray) -> np.ndarray:
        """
        Predict SoH from features.

        Args:
            features: Feature array (single sample or batch)

        Returns:
            Predicted SoH (0-1)

        Raises:
            NotImplementedError: when no trained artifact is loaded (the
                production state; see the module docstring).
        """
        if not self.is_fitted:
            raise NotImplementedError(
                "No trained SoH artifact is loaded, and none exists to load: SoH is "
                "served by the chemistry EmpiricalDegradationModel in "
                "nuravolt/bess/warranty_tracker.py, not by this estimator. Training it "
                "requires real measured capacity tests (BessCapacityTest of test_type "
                "'standard' or 'partial'); fitting on modelled SoH would launder the "
                "degradation model's own assumptions back as independent evidence. "
                "Call train() or load() with real capacity-test data first."
            )

        features = np.atleast_2d(features)
        predictions = self.model.predict(features)

        # Apply physics constraints
        predictions = np.clip(
            predictions,
            self.config.min_soh,
            self.config.max_soh
        )

        # Optional physics correction
        if self.physics is not None:
            physics_pred = self.physics.predict(features)
            predictions = (
                (1 - self.config.physics_weight) * predictions
                + self.config.physics_weight * physics_pred
            )

        return predictions

    def predict_rul(
        self,
        current_soh: float,
        usage_profile: dict,
        eol_threshold: float = 0.70,
        soh_history: Optional[Sequence[Tuple[float, float]]] = None,
    ) -> dict:
        """
        Predict Remaining Useful Life (RUL) by linear extrapolation to EOL.

        The projection is linear, so its uncertainty is derivable: regress the
        observed SoH on cumulative cycles, take the standard error of the
        slope, and map the 95 % interval on the degradation rate onto an
        interval on cycles-to-EOL. Without observations there is nothing to
        regress on, so ``confidence`` and the bounds come back as None rather
        than as an invented number.

        Args:
            current_soh: Current state of health (0-1)
            usage_profile: Dict with 'cycles_per_day', 'avg_dod', 'avg_temp'
                and optionally 'degradation_per_cycle' (the assumed fallback
                rate used when no history is supplied)
            eol_threshold: End-of-life SoH threshold
            soh_history: Optional (cumulative_cycles, soh) observations, e.g.
                real capacity tests for the asset. Three or more points with
                spread in cycles are needed to fit a slope and its error.

        Returns:
            Dict with RUL estimates, the interval, and the basis for both
        """
        if current_soh <= eol_threshold:
            return {
                'rul_days': 0,
                'rul_cycles': 0,
                'rul_days_low': 0,
                'rul_days_high': 0,
                'rul_cycles_low': 0,
                'rul_cycles_high': 0,
                'current_soh': current_soh,
                'eol_threshold': eol_threshold,
                'degradation_per_cycle': None,
                'degradation_source': 'observed_soh',
                'n_observations': len(soh_history) if soh_history is not None else 0,
                'fit_r2': None,
                'confidence': 1.0,
                'confidence_level': None,
                'confidence_basis': 'EOL already reached; no projection needed',
                'status': 'eol_reached'
            }

        cycles_per_day = float(usage_profile.get('cycles_per_day', 1.0))
        if cycles_per_day <= 0:
            raise ValueError("usage_profile['cycles_per_day'] must be > 0 to project RUL in days")

        # Degradation rate: measured slope when there is history to fit,
        # otherwise the caller's assumed rate (which carries no derivable error).
        fit = _fit_degradation_slope(soh_history)
        if fit is not None and fit['slope'] < 0:
            degradation_per_cycle = -fit['slope']
            degradation_source = 'ols_fit'
            slope_stderr = fit['slope_stderr']
        else:
            degradation_per_cycle = float(usage_profile.get('degradation_per_cycle', 0.0001))
            degradation_source = 'assumed'
            slope_stderr = None

        if degradation_per_cycle <= 0:
            raise ValueError("degradation_per_cycle must be > 0 to project a finite RUL")

        soh_remaining = current_soh - eol_threshold
        cycles_to_eol = soh_remaining / degradation_per_cycle
        rul_days = cycles_to_eol / cycles_per_day

        # 95 % interval on cycles-to-EOL, propagated from the slope's standard
        # error. cycles = remaining / rate, so the fast rate gives the low
        # bound and the slow rate the high one; a rate interval that reaches
        # zero means the fit cannot rule out "no degradation", i.e. an
        # unbounded upper end.
        cycles_low = cycles_high = None
        confidence = None
        confidence_level = None
        if slope_stderr is not None:
            t_crit = _t_critical_95(fit['dof'])
            rate_low = degradation_per_cycle - t_crit * slope_stderr
            rate_high = degradation_per_cycle + t_crit * slope_stderr
            cycles_low = soh_remaining / rate_high
            cycles_high = soh_remaining / rate_low if rate_low > 0 else None
            confidence_level = 0.95
            if cycles_high is None:
                confidence = 0.0
                confidence_basis = (
                    'slope not distinguishable from zero at 95 %, so the upper bound '
                    'on cycles to EOL is unbounded'
                )
            else:
                # 1 minus the relative half-width of the interval: a tight fit
                # scores near 1, a fit as wide as the estimate itself scores 0.
                rel_half_width = (cycles_high - cycles_low) / (2.0 * cycles_to_eol)
                confidence = float(np.clip(1.0 - rel_half_width, 0.0, 1.0))
                confidence_basis = (
                    'derived from the standard error of the SoH-vs-cycles OLS slope '
                    f"over {fit['n']} observations"
                )
        else:
            confidence_basis = (
                'no SoH observations supplied, so the projection rests on an assumed '
                'degradation rate whose error is not derivable'
            )

        return {
            'rul_days': int(rul_days),
            'rul_cycles': int(cycles_to_eol),
            'rul_days_low': int(cycles_low / cycles_per_day) if cycles_low is not None else None,
            'rul_days_high': int(cycles_high / cycles_per_day) if cycles_high is not None else None,
            'rul_cycles_low': int(cycles_low) if cycles_low is not None else None,
            'rul_cycles_high': int(cycles_high) if cycles_high is not None else None,
            'current_soh': current_soh,
            'eol_threshold': eol_threshold,
            'degradation_per_cycle': degradation_per_cycle,
            'degradation_source': degradation_source,
            'n_observations': fit['n'] if fit is not None else 0,
            'fit_r2': fit['r_squared'] if fit is not None else None,
            'confidence': confidence,
            'confidence_level': confidence_level,
            'confidence_basis': confidence_basis,
            'status': 'healthy' if current_soh > 0.8 else 'degraded'
        }

    def get_feature_importance(self) -> dict:
        """Get feature importance from trained model"""
        if not self.is_fitted:
            raise ValueError("Model not fitted.")

        importance = self.model.feature_importance(importance_type='gain')
        return dict(zip(self.config.feature_names, importance))

    def save(self, path: str):
        """Save model to file"""
        if not self.is_fitted:
            raise ValueError("Model not fitted.")
        self.model.save_model(path)

    def load(self, path: str):
        """Load model from file"""
        self.model = lgb.Booster(model_file=path)
        self.is_fitted = True
