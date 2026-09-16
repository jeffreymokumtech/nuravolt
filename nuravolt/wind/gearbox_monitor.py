"""
Gearbox and Bearing Predictive Maintenance Module

Normal Behavior Modeling (NBM) for wind turbine drivetrain health monitoring.
Uses SCADA data to predict expected temperatures and detect anomalies.

Transfer pattern from: nuravolt/fault/rul_models.py
Reference: Tautz-Weinert & Watson, 2017 - SCADA-based condition monitoring
"""

from dataclasses import dataclass
from typing import Optional
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
class GearboxHealth:
    """Health status output from gearbox monitoring"""
    health_score: float  # 0-100, higher is better
    anomaly_detected: bool
    primary_indicator: str  # Which sensor triggered
    residual_mean: float = 0.0
    residual_zscore: float = 0.0
    days_to_failure_estimate: Optional[int] = None
    recommendation: str = ""
    confidence: float = 0.0


@dataclass
class NBMConfig:
    """Configuration for Normal Behavior Model"""
    # Model parameters
    n_estimators: int = 100
    learning_rate: float = 0.1
    max_depth: int = 6

    # Anomaly detection thresholds
    zscore_warning: float = 3.0
    zscore_critical: float = 5.0

    # Feature columns
    feature_cols: tuple = (
        'wind_speed',
        'rotor_speed',
        'power',
        'ambient_temp',
        'nacelle_temp',
        'generator_speed',
        'pitch_angle'
    )

    # Target columns (temperatures to predict)
    target_cols: tuple = (
        'gearbox_bearing_temp',
        'gearbox_oil_temp',
        'generator_bearing_de_temp',  # Drive-end
        'generator_bearing_nde_temp'  # Non-drive-end
    )


class GearboxNBMModel:
    """
    Normal Behavior Model for gearbox temperature prediction.

    Trains ML model on healthy operation data, then monitors for
    deviations between predicted and actual temperatures.
    Large residual = developing fault.

    Example:
        nbm = GearboxNBMModel()

        # Train on known-healthy historical data
        metrics = nbm.train(healthy_data, target='gearbox_bearing_temp')
        print(f"Validation MAE: {metrics['val_mae']:.2f}°C")

        # Monitor in production
        df_monitored = nbm.predict_and_detect(current_data)
        anomalies = df_monitored.filter(pl.col('gearbox_bearing_temp_anomaly'))
    """

    def __init__(self, config: Optional[NBMConfig] = None):
        """
        Initialize NBM model.

        Args:
            config: Model configuration
        """
        if not LIGHTGBM_AVAILABLE:
            raise ImportError(
                "lightgbm required for NBM. Install with: pip install lightgbm"
            )

        self.config = config or NBMConfig()
        self.models = {}
        self.residual_stats = {}

    def train(
        self,
        df: "pl.DataFrame",
        target: str,
        validation_split: float = 0.2
    ) -> dict:
        """
        Train NBM on healthy operation data.

        Args:
            df: Historical data (should be from healthy operation periods)
            target: Target column to predict (e.g., 'gearbox_bearing_temp')
            validation_split: Fraction for validation

        Returns:
            Dict with training metrics
        """
        if not POLARS_AVAILABLE:
            raise ImportError("polars required")

        # Get available features
        available_features = [
            col for col in self.config.feature_cols
            if col in df.columns
        ]

        if len(available_features) < 3:
            raise ValueError(
                f"Need at least 3 feature columns. Available: {available_features}"
            )

        X = df.select(available_features).to_numpy()
        y = df[target].to_numpy()

        # Train/validation split
        n = len(y)
        n_val = int(n * validation_split)
        indices = np.random.permutation(n)

        train_idx = indices[n_val:]
        val_idx = indices[:n_val]

        X_train, X_val = X[train_idx], X[val_idx]
        y_train, y_val = y[train_idx], y[val_idx]

        # Train model
        train_data = lgb.Dataset(X_train, label=y_train)
        val_data = lgb.Dataset(X_val, label=y_val, reference=train_data)

        params = {
            'objective': 'regression',
            'metric': 'mae',
            'learning_rate': self.config.learning_rate,
            'max_depth': self.config.max_depth,
            'num_leaves': 31,
            'verbose': -1,
        }

        model = lgb.train(
            params,
            train_data,
            num_boost_round=self.config.n_estimators,
            valid_sets=[val_data],
            callbacks=[lgb.early_stopping(10, verbose=False)]
        )

        # Calculate residual statistics on validation set
        val_pred = model.predict(X_val)
        residuals = y_val - val_pred

        self.models[target] = {
            'model': model,
            'features': available_features
        }
        self.residual_stats[target] = {
            'mean': float(np.mean(residuals)),
            'std': float(np.std(residuals)),
            'n_samples': len(val_idx)
        }

        return {
            'target': target,
            'train_mae': float(np.mean(np.abs(y_train - model.predict(X_train)))),
            'val_mae': float(np.mean(np.abs(residuals))),
            'val_rmse': float(np.sqrt(np.mean(residuals ** 2))),
            'residual_mean': self.residual_stats[target]['mean'],
            'residual_std': self.residual_stats[target]['std'],
            'n_train': len(train_idx),
            'n_val': len(val_idx),
            'features_used': available_features
        }

    def predict_and_detect(
        self,
        df: "pl.DataFrame",
        target: str
    ) -> "pl.DataFrame":
        """
        Predict temperatures and detect anomalies.

        Args:
            df: Current SCADA data
            target: Target column being monitored

        Returns:
            DataFrame with prediction, residual, zscore, and anomaly columns
        """
        if target not in self.models:
            raise ValueError(f"Model for {target} not trained")

        model_info = self.models[target]
        stats = self.residual_stats[target]

        X = df.select(model_info['features']).to_numpy()
        predicted = model_info['model'].predict(X)
        actual = df[target].to_numpy()

        residuals = actual - predicted
        z_scores = (residuals - stats['mean']) / (stats['std'] + 1e-8)

        return df.with_columns([
            pl.lit(predicted).alias(f'{target}_predicted'),
            pl.lit(residuals).alias(f'{target}_residual'),
            pl.lit(z_scores).alias(f'{target}_zscore'),
            (pl.lit(np.abs(z_scores)) > self.config.zscore_warning).alias(
                f'{target}_anomaly'
            )
        ])

    def get_feature_importance(self, target: str) -> dict:
        """Get feature importance for a trained model"""
        if target not in self.models:
            raise ValueError(f"Model for {target} not trained")

        model_info = self.models[target]
        importance = model_info['model'].feature_importance(importance_type='gain')

        return dict(zip(model_info['features'], importance))


class MultiComponentMonitor:
    """
    Monitor multiple drivetrain components simultaneously.

    Trains NBM models for each temperature sensor and provides
    unified health assessment across all components.

    Example:
        monitor = MultiComponentMonitor()

        # Train on healthy data
        metrics = monitor.train_all_components(healthy_historical_data)

        # Monitor in production
        health_status = monitor.monitor(current_data)
        for status in health_status:
            if status.anomaly_detected:
                send_alert(status)
    """

    def __init__(self, config: Optional[NBMConfig] = None):
        self.config = config or NBMConfig()
        self.nbm = GearboxNBMModel(config)
        self.alert_history = []

    def train_all_components(self, df: "pl.DataFrame") -> dict:
        """
        Train NBM for all monitored temperature sensors.

        Args:
            df: Healthy historical data

        Returns:
            Dict of training metrics per component
        """
        metrics = {}

        for target in self.config.target_cols:
            if target in df.columns:
                try:
                    metrics[target] = self.nbm.train(df, target)
                except Exception as e:
                    metrics[target] = {'error': str(e)}

        return metrics

    def monitor(self, df: "pl.DataFrame") -> list[GearboxHealth]:
        """
        Monitor all components and return health status.

        Args:
            df: Current SCADA data

        Returns:
            List of GearboxHealth for each monitored component
        """
        results = []

        for target in self.nbm.models.keys():
            try:
                df_analyzed = self.nbm.predict_and_detect(df, target)

                # Calculate health metrics
                anomaly_col = f'{target}_anomaly'
                zscore_col = f'{target}_zscore'
                residual_col = f'{target}_residual'

                anomaly_rate = float(df_analyzed[anomaly_col].mean())
                max_zscore = float(df_analyzed[zscore_col].max())
                avg_residual = float(df_analyzed[residual_col].mean())

                # Generate health score (100 = perfect, 0 = failure imminent)
                health_score = max(
                    0,
                    100 - anomaly_rate * 100 - max(0, max_zscore - 3) * 10
                )

                # Determine if anomaly detected
                anomaly_detected = (
                    anomaly_rate > 0.1 or
                    max_zscore > self.config.zscore_critical
                )

                # Generate recommendation
                recommendation = self._generate_recommendation(
                    health_score, target, max_zscore
                )

                results.append(GearboxHealth(
                    health_score=health_score,
                    anomaly_detected=anomaly_detected,
                    primary_indicator=target,
                    residual_mean=avg_residual,
                    residual_zscore=max_zscore,
                    recommendation=recommendation,
                    confidence=min(0.9, 0.5 + 0.1 * len(df))
                ))

            except Exception as e:
                results.append(GearboxHealth(
                    health_score=50.0,
                    anomaly_detected=False,
                    primary_indicator=target,
                    recommendation=f"Error monitoring {target}: {str(e)}",
                    confidence=0.0
                ))

        return results

    def _generate_recommendation(
        self,
        health_score: float,
        component: str,
        max_zscore: float
    ) -> str:
        """Generate operational recommendation based on health score"""
        if health_score < 50:
            return f"CRITICAL: Schedule immediate inspection of {component}"
        elif health_score < 70:
            return f"WARNING: Plan maintenance for {component} within 30 days"
        elif health_score < 85:
            return f"ADVISORY: Monitor {component} closely, check trend"
        return f"OK: {component} operating normally"


class TrendAnalyzer:
    """
    Analyze residual trends for RUL estimation.

    Tracks how temperature residuals change over time to estimate
    remaining useful life before component failure.

    Transfer pattern from: nuravolt/fault/rul_models.py
    """

    def __init__(self, window_days: int = 30):
        """
        Args:
            window_days: Window for trend calculation
        """
        self.window_days = window_days

    def calculate_trend(
        self,
        residuals: np.ndarray,
        timestamps: np.ndarray
    ) -> dict:
        """
        Calculate trend in residuals over time.

        Increasing positive residual = component running hotter than expected
        = developing fault.

        Args:
            residuals: Array of temperature residuals
            timestamps: Array of timestamps

        Returns:
            Dict with trend metrics and RUL estimate
        """
        if len(residuals) < 7:
            return {
                'trend_per_day': 0,
                'confidence': 0,
                'days_to_threshold': None
            }

        # Convert timestamps to day offsets
        if hasattr(timestamps[0], 'timestamp'):
            days = np.array([
                (t - timestamps[0]).total_seconds() / 86400
                for t in timestamps
            ])
        else:
            days = np.arange(len(residuals))

        # Linear regression
        slope, intercept = np.polyfit(days, residuals, 1)

        # Calculate R² for confidence
        predicted = slope * days + intercept
        ss_res = np.sum((residuals - predicted) ** 2)
        ss_tot = np.sum((residuals - np.mean(residuals)) ** 2)
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Estimate days to threshold (10°C above normal as critical)
        threshold = 10.0  # °C above normal
        current_level = float(residuals[-1])

        if slope > 0:
            days_to_threshold = (threshold - current_level) / slope
        else:
            days_to_threshold = None  # Not trending upward

        return {
            'trend_per_day': float(slope),  # °C/day increase
            'current_level': current_level,
            'projected_30d': current_level + slope * 30,
            'days_to_threshold': days_to_threshold,
            'confidence': max(0, r_squared),
            'intercept': float(intercept)
        }

    def estimate_rul(
        self,
        trend_results: dict,
        failure_threshold: float = 10.0
    ) -> dict:
        """
        Estimate Remaining Useful Life from trend analysis.

        Args:
            trend_results: Output from calculate_trend()
            failure_threshold: Temperature deviation threshold for failure

        Returns:
            Dict with RUL estimates and confidence
        """
        if trend_results['trend_per_day'] <= 0:
            return {
                'rul_days': None,
                'status': 'stable',
                'confidence': trend_results['confidence'],
                'recommendation': 'No degradation trend detected'
            }

        days_to_threshold = trend_results.get('days_to_threshold')

        if days_to_threshold is None or days_to_threshold < 0:
            return {
                'rul_days': None,
                'status': 'threshold_exceeded',
                'confidence': trend_results['confidence'],
                'recommendation': 'CRITICAL: Threshold exceeded, schedule inspection'
            }

        if days_to_threshold < 30:
            status = 'critical'
            recommendation = f"CRITICAL: Estimated {int(days_to_threshold)} days to failure threshold"
        elif days_to_threshold < 90:
            status = 'warning'
            recommendation = f"WARNING: Estimated {int(days_to_threshold)} days to failure threshold"
        elif days_to_threshold < 180:
            status = 'advisory'
            recommendation = f"ADVISORY: Monitor closely, {int(days_to_threshold)} days to threshold"
        else:
            status = 'healthy'
            recommendation = f"OK: {int(days_to_threshold)} days margin before threshold"

        return {
            'rul_days': int(days_to_threshold),
            'status': status,
            'confidence': trend_results['confidence'],
            'trend_per_day': trend_results['trend_per_day'],
            'recommendation': recommendation
        }
