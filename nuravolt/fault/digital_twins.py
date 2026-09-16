"""
Digital Twin Models for Fault Detection

Physics-ML hybrid models for anomaly detection through digital twins.
v1.5 - Enhanced Thermal Digital Twin with RUL prediction and component life modeling.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Union
import pickle
import json

import numpy as np
import polars as pl

from .config import FaultDetectionConfig, ThermalTwinThresholds

# Import thermal physics models for RUL prediction
import sys
from pathlib import Path as SysPath
sys.path.insert(0, str(SysPath(__file__).parent.parent))

from nuravolt.digitaltwin.thermal_physics import (
    ArrheniusLifeModel,
    CapacitorESRModel,
    IGBTThermalCyclingModel,
    ThermalStressAccumulator,
    CapacitorConfig,
    IGBTConfig,
    ThermalStressConfig,
)


class ThermalStatus(Enum):
    """Thermal anomaly status levels."""
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class ThermalAnomalyResult:
    """Result from thermal anomaly detection."""
    timestamp: datetime
    inverter_id: str
    actual_temp: float
    expected_temp: float
    residual: float
    status: ThermalStatus

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat() if hasattr(self.timestamp, "isoformat") else str(self.timestamp),
            "inverter_id": self.inverter_id,
            "actual_temp": self.actual_temp,
            "expected_temp": self.expected_temp,
            "residual": self.residual,
            "status": self.status.value,
        }


@dataclass
class TwinTrainingMetrics:
    """Metrics from digital twin training."""
    mae: float  # Mean Absolute Error
    rmse: float  # Root Mean Square Error
    r2: float  # R-squared
    n_samples: int
    feature_importance: dict = field(default_factory=dict)
    training_time_s: float = 0.0


class InverterThermalTwin:
    """
    Digital twin for inverter thermal behavior prediction.

    Uses CatBoost regression to predict expected inverter temperature
    based on operating conditions. Anomalies detected through residual
    analysis (actual - expected temperature).

    Features:
        - ambient_temp: Ambient temperature (°C)
        - ac_power_pu: AC power as fraction of rated (0-1)
        - poa_irradiance: Plane-of-array irradiance (W/m²)
        - hour_of_day: Hour of day (0-23) for thermal mass effects

    Anomaly thresholds:
        - Normal: |residual| < 5°C
        - Warning: 5°C <= |residual| < 10°C (cooling degradation)
        - Critical: |residual| >= 10°C (fan failure likely)

    Example usage:
        twin = InverterThermalTwin()

        # Train on historical data
        metrics = twin.train(df_training)
        print(f"Training MAE: {metrics.mae:.2f}°C")

        # Predict and detect anomalies
        df_result = twin.predict(df_new)
        anomalies = twin.detect_anomalies(df_result)

        # Save/load model
        twin.save("thermal_twin.pkl")
        twin = InverterThermalTwin.load("thermal_twin.pkl")
    """

    FEATURE_COLS = ["ambient_temp", "ac_power_pu", "poa_irradiance", "hour_of_day"]
    TARGET_COL = "inverter_temperature"

    def __init__(
        self,
        thresholds: Optional[ThermalTwinThresholds] = None,
        inverter_id: Optional[str] = None,
        rated_ac_power_kw: Optional[float] = None,
    ):
        """
        Initialize thermal twin.

        Args:
            thresholds: Anomaly detection thresholds
            inverter_id: Identifier for this inverter
            rated_ac_power_kw: Rated AC power for normalization
        """
        self.thresholds = thresholds or ThermalTwinThresholds()
        self.inverter_id = inverter_id or "inverter_1"
        self.rated_ac_power_kw = rated_ac_power_kw

        self.model = None
        self.training_metrics: Optional[TwinTrainingMetrics] = None
        self._is_trained = False

        # Column mapping for flexible input
        self._col_mapping = {
            "ambient_temp": ["ambient_temp", "ambient_temperature", "t_amb", "temp_ambient"],
            "ac_power": ["ac_power", "power_ac", "ac_kw", "p_ac"],
            "poa_irradiance": ["poa_irradiance", "irradiance", "poa", "ghi"],
            "inverter_temperature": ["inverter_temp", "inverter_temperature", "t_inv", "temp_inverter", "cabinet_temp"],
        }

    def train(
        self,
        df: pl.DataFrame,
        target_col: Optional[str] = None,
        validation_split: float = 0.2,
        verbose: bool = True,
    ) -> TwinTrainingMetrics:
        """
        Train the thermal twin model.

        Args:
            df: Training data with features and target
            target_col: Name of target column (inverter temperature)
            validation_split: Fraction of data for validation
            verbose: Print training progress

        Returns:
            TwinTrainingMetrics with training results
        """
        import time
        start_time = time.time()

        # Prepare features
        df_prepared = self._prepare_features(df)

        if df_prepared is None or len(df_prepared) == 0:
            raise ValueError("No valid training data after feature preparation")

        # Get feature columns present in data
        feature_cols = [c for c in self.FEATURE_COLS if c in df_prepared.columns]

        # Find target column
        target = target_col or self._find_column(df_prepared, self._col_mapping["inverter_temperature"])
        if target is None:
            raise ValueError("Could not find inverter temperature column")

        # Filter valid rows (no nulls in features or target)
        valid_mask = pl.all_horizontal([pl.col(c).is_not_null() for c in feature_cols + [target]])
        df_valid = df_prepared.filter(valid_mask)

        if len(df_valid) < 100:
            raise ValueError(f"Insufficient training data: {len(df_valid)} rows (need >= 100)")

        # Convert to numpy
        X = df_valid.select(feature_cols).to_numpy()
        y = df_valid[target].to_numpy()

        # Train/validation split
        n_val = int(len(X) * validation_split)
        X_train, X_val = X[:-n_val], X[-n_val:]
        y_train, y_val = y[:-n_val], y[-n_val:]

        # Train CatBoost model
        try:
            from catboost import CatBoostRegressor

            self.model = CatBoostRegressor(
                iterations=500,
                learning_rate=0.05,
                depth=6,
                loss_function="RMSE",
                verbose=False,
                early_stopping_rounds=50,
                random_seed=42,
            )

            self.model.fit(
                X_train, y_train,
                eval_set=(X_val, y_val),
                verbose=verbose,
            )

        except ImportError:
            # Fallback to LightGBM if CatBoost not available
            try:
                import lightgbm as lgb

                self.model = lgb.LGBMRegressor(
                    n_estimators=500,
                    learning_rate=0.05,
                    max_depth=6,
                    random_state=42,
                    verbose=-1,
                )

                self.model.fit(
                    X_train, y_train,
                    eval_set=[(X_val, y_val)],
                    callbacks=[lgb.early_stopping(50, verbose=False)],
                )

            except ImportError:
                # Final fallback to sklearn
                from sklearn.ensemble import GradientBoostingRegressor

                self.model = GradientBoostingRegressor(
                    n_estimators=100,
                    learning_rate=0.1,
                    max_depth=5,
                    random_state=42,
                )
                self.model.fit(X_train, y_train)

        # Calculate metrics
        y_pred_val = self.model.predict(X_val)

        mae = np.mean(np.abs(y_val - y_pred_val))
        rmse = np.sqrt(np.mean((y_val - y_pred_val) ** 2))
        ss_res = np.sum((y_val - y_pred_val) ** 2)
        ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
        r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Feature importance
        if hasattr(self.model, "feature_importances_"):
            importance = dict(zip(feature_cols, self.model.feature_importances_))
        elif hasattr(self.model, "get_feature_importance"):
            importance = dict(zip(feature_cols, self.model.get_feature_importance()))
        else:
            importance = {}

        self.training_metrics = TwinTrainingMetrics(
            mae=mae,
            rmse=rmse,
            r2=r2,
            n_samples=len(X_train),
            feature_importance=importance,
            training_time_s=time.time() - start_time,
        )

        self._is_trained = True
        self._feature_cols = feature_cols

        if verbose:
            print(f"Thermal Twin trained: MAE={mae:.2f}°C, RMSE={rmse:.2f}°C, R²={r2:.3f}")

        return self.training_metrics

    def predict(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Predict expected inverter temperature and calculate residuals.

        Args:
            df: Input data with feature columns

        Returns:
            DataFrame with added columns:
                - T_inv_expected: Predicted temperature
                - temp_residual: Actual - Expected
        """
        if not self._is_trained:
            raise RuntimeError("Model not trained. Call train() first or load a saved model.")

        # Prepare features
        df_prepared = self._prepare_features(df)

        if df_prepared is None:
            return df

        # Get features
        feature_cols = [c for c in self._feature_cols if c in df_prepared.columns]

        if len(feature_cols) != len(self._feature_cols):
            missing = set(self._feature_cols) - set(feature_cols)
            raise ValueError(f"Missing required features: {missing}")

        # Find actual temperature column
        temp_col = self._find_column(df_prepared, self._col_mapping["inverter_temperature"])

        # Predict
        X = df_prepared.select(feature_cols).to_numpy()

        # Handle nulls by filling with predictions where valid
        valid_mask = np.all(~np.isnan(X), axis=1)
        predictions = np.full(len(X), np.nan)

        if np.any(valid_mask):
            predictions[valid_mask] = self.model.predict(X[valid_mask])

        # Add predictions to dataframe
        df_result = df_prepared.with_columns([
            pl.Series("T_inv_expected", predictions),
        ])

        # Calculate residual if actual temp available
        if temp_col is not None:
            df_result = df_result.with_columns([
                (pl.col(temp_col) - pl.col("T_inv_expected")).alias("temp_residual"),
            ])

        return df_result

    def detect_anomalies(
        self,
        df: pl.DataFrame,
        temp_col: Optional[str] = None,
    ) -> list[ThermalAnomalyResult]:
        """
        Detect thermal anomalies from prediction residuals.

        Args:
            df: DataFrame with temp_residual column (from predict())
            temp_col: Actual temperature column name

        Returns:
            List of ThermalAnomalyResult for anomalous periods
        """
        anomalies = []

        if "temp_residual" not in df.columns:
            raise ValueError("temp_residual column not found. Run predict() first.")

        # Find temperature column
        if temp_col is None:
            temp_col = self._find_column(df, self._col_mapping["inverter_temperature"])

        # Find timestamp column
        ts_col = self._find_column(df, ["timestamp", "datetime", "time"])

        # Get thresholds
        warning_threshold = self.thresholds.warning_residual
        critical_threshold = self.thresholds.critical_residual
        consecutive_required = self.thresholds.consecutive_anomalies_required

        # Detect anomalies
        df_check = df.with_columns([
            pl.when(pl.col("temp_residual").abs() >= critical_threshold)
            .then(pl.lit("critical"))
            .when(pl.col("temp_residual").abs() >= warning_threshold)
            .then(pl.lit("warning"))
            .otherwise(pl.lit("normal"))
            .alias("_thermal_status"),
        ])

        # Group consecutive anomalies
        anomaly_rows = df_check.filter(pl.col("_thermal_status") != "normal")

        if len(anomaly_rows) >= consecutive_required:
            # Get rows as list of dicts
            rows = anomaly_rows.to_dicts()

            for row in rows:
                status_str = row.get("_thermal_status", "warning")
                status = ThermalStatus.CRITICAL if status_str == "critical" else ThermalStatus.WARNING

                ts = row.get(ts_col) if ts_col else datetime.now()

                anomalies.append(ThermalAnomalyResult(
                    timestamp=ts,
                    inverter_id=self.inverter_id,
                    actual_temp=row.get(temp_col, 0.0) if temp_col else 0.0,
                    expected_temp=row.get("T_inv_expected", 0.0),
                    residual=row.get("temp_residual", 0.0),
                    status=status,
                ))

        return anomalies

    def save(self, path: Union[str, Path]) -> None:
        """Save trained model to file."""
        if not self._is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)

        save_data = {
            "model": self.model,
            "thresholds": self.thresholds,
            "inverter_id": self.inverter_id,
            "rated_ac_power_kw": self.rated_ac_power_kw,
            "training_metrics": self.training_metrics,
            "feature_cols": self._feature_cols,
            "version": "1.4",
        }

        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "InverterThermalTwin":
        """Load trained model from file."""
        path = Path(path)

        with open(path, "rb") as f:
            save_data = pickle.load(f)

        twin = cls(
            thresholds=save_data.get("thresholds"),
            inverter_id=save_data.get("inverter_id"),
            rated_ac_power_kw=save_data.get("rated_ac_power_kw"),
        )

        twin.model = save_data["model"]
        twin.training_metrics = save_data.get("training_metrics")
        twin._feature_cols = save_data.get("feature_cols", cls.FEATURE_COLS)
        twin._is_trained = True

        return twin

    def _prepare_features(self, df: pl.DataFrame) -> Optional[pl.DataFrame]:
        """Prepare feature columns for model."""
        result = df.clone()

        # Map ambient temperature
        amb_col = self._find_column(df, self._col_mapping["ambient_temp"])
        if amb_col and amb_col != "ambient_temp":
            result = result.with_columns(pl.col(amb_col).alias("ambient_temp"))

        # Map and normalize AC power
        ac_col = self._find_column(df, self._col_mapping["ac_power"])
        if ac_col:
            if self.rated_ac_power_kw:
                result = result.with_columns(
                    (pl.col(ac_col) / self.rated_ac_power_kw).alias("ac_power_pu")
                )
            else:
                # Estimate from data (assume max is ~rated)
                max_power = df[ac_col].max()
                if max_power and max_power > 0:
                    result = result.with_columns(
                        (pl.col(ac_col) / max_power).alias("ac_power_pu")
                    )

        # Map irradiance
        poa_col = self._find_column(df, self._col_mapping["poa_irradiance"])
        if poa_col and poa_col != "poa_irradiance":
            result = result.with_columns(pl.col(poa_col).alias("poa_irradiance"))

        # Extract hour of day from timestamp
        ts_col = self._find_column(df, ["timestamp", "datetime", "time"])
        if ts_col and "hour_of_day" not in result.columns:
            try:
                result = result.with_columns(
                    pl.col(ts_col).dt.hour().alias("hour_of_day")
                )
            except Exception:
                # If timestamp parsing fails, try string parsing
                pass

        return result

    def _find_column(self, df: pl.DataFrame, patterns: list[str]) -> Optional[str]:
        """Find first column matching any pattern (case-insensitive)."""
        df_cols_lower = {c.lower(): c for c in df.columns}

        for pattern in patterns:
            pattern_lower = pattern.lower()

            # Exact match
            if pattern_lower in df_cols_lower:
                return df_cols_lower[pattern_lower]

            # Partial match
            for col_lower, col_original in df_cols_lower.items():
                if pattern_lower in col_lower:
                    return col_original

        return None


# ============================================================================
# Enhanced Thermal Twin with RUL Prediction
# ============================================================================


@dataclass
class ComponentRULEstimate:
    """Remaining useful life estimate for inverter component."""
    component: str  # "capacitor" or "igbt"
    rul_days: float
    confidence: float  # 0-1
    current_health: float  # 0-1, where 1 is perfect
    degradation_rate: float  # health/day
    failure_mode: str


@dataclass
class ThermalRULResult:
    """Result from thermal RUL estimation."""
    timestamp: datetime
    inverter_id: str
    capacitor_rul: ComponentRULEstimate
    igbt_rul: ComponentRULEstimate
    thermal_stress_metrics: dict
    min_rul_days: float  # Minimum across components

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat() if hasattr(self.timestamp, "isoformat") else str(self.timestamp),
            "inverter_id": self.inverter_id,
            "capacitor_rul_days": self.capacitor_rul.rul_days,
            "igbt_rul_days": self.igbt_rul.rul_days,
            "min_rul_days": self.min_rul_days,
            "thermal_stress_metrics": self.thermal_stress_metrics,
        }


class EnhancedThermalTwin(InverterThermalTwin):
    """
    Enhanced thermal digital twin with component life prediction.

    Extends InverterThermalTwin with:
    - Arrhenius degradation models for capacitor ESR
    - Coffin-Manson thermal cycling for IGBT/MOSFET
    - Thermal stress accumulation tracking
    - Remaining useful life (RUL) estimation

    Provides predictive maintenance capabilities with 5-15 day advance warning
    for component failures.

    Example usage:
        twin = EnhancedThermalTwin(
            inverter_id="INV_01.001",
            rated_ac_power_kw=60.0,
        )

        # Train temperature prediction model
        metrics = twin.train(df_training)

        # Predict with RUL estimation
        df_result = twin.predict(df_new)
        rul_estimate = twin.estimate_rul(df_result)

        print(f"Capacitor RUL: {rul_estimate.capacitor_rul.rul_days:.0f} days")
        print(f"IGBT RUL: {rul_estimate.igbt_rul.rul_days:.0f} days")

        # Save/load
        twin.save_enhanced("thermal_twin_enhanced.pkl")
    """

    def __init__(
        self,
        thresholds: Optional[ThermalTwinThresholds] = None,
        inverter_id: Optional[str] = None,
        rated_ac_power_kw: Optional[float] = None,
        capacitor_config: Optional[CapacitorConfig] = None,
        igbt_config: Optional[IGBTConfig] = None,
        thermal_stress_config: Optional[ThermalStressConfig] = None,
    ):
        """
        Initialize enhanced thermal twin.

        Args:
            thresholds: Anomaly detection thresholds
            inverter_id: Identifier for this inverter
            rated_ac_power_kw: Rated AC power for normalization
            capacitor_config: Capacitor degradation model config
            igbt_config: IGBT thermal cycling config
            thermal_stress_config: Thermal stress tracking config
        """
        super().__init__(thresholds, inverter_id, rated_ac_power_kw)

        # Component life models
        self.capacitor_config = capacitor_config or CapacitorConfig()
        self.igbt_config = igbt_config or IGBTConfig()
        self.stress_config = thermal_stress_config or ThermalStressConfig()

        self.capacitor_model = CapacitorESRModel(self.capacitor_config)
        self.igbt_model = IGBTThermalCyclingModel(self.igbt_config)
        self.stress_accumulator = ThermalStressAccumulator(self.stress_config)

    def estimate_rul(
        self,
        df: pl.DataFrame,
        temp_col: Optional[str] = None,
        hours_per_day: float = 8.0,
    ) -> Optional[ThermalRULResult]:
        """
        Estimate remaining useful life for inverter components.

        Args:
            df: DataFrame with temperature data (actual or predicted)
            temp_col: Temperature column name
            hours_per_day: Operating hours per day (default: 8h for solar)

        Returns:
            ThermalRULResult with component life predictions
        """
        # Find temperature column
        if temp_col is None:
            temp_col = self._find_column(df, self._col_mapping["inverter_temperature"])
            if temp_col is None:
                temp_col = "T_inv_expected"  # Use predicted temp if available

        if temp_col not in df.columns:
            return None

        # Extract temperature series
        temp_series = df[temp_col].to_numpy()
        temp_series = temp_series[~np.isnan(temp_series)]

        if len(temp_series) < 10:
            return None

        # Update thermal stress accumulator
        stress_metrics = self.stress_accumulator.update(
            temp_series,
            rated_temp_c=self.capacitor_config.rated_temp_c,
        )

        # Estimate operating hours from data
        total_hours = stress_metrics["total_hours"]

        # Capacitor RUL
        cap_rul_days = self.capacitor_model.rul_days(
            thermal_history_c=temp_series,
            operating_hours=total_hours,
            hours_per_day=hours_per_day,
        )

        current_esr = self.capacitor_model.current_esr(temp_series, total_hours)
        cap_health = 1.0 - (
            (current_esr - self.capacitor_config.rated_esr_ohm) /
            (self.capacitor_config.failure_esr_multiplier * self.capacitor_config.rated_esr_ohm - self.capacitor_config.rated_esr_ohm)
        )
        cap_health = max(0.0, min(1.0, cap_health))

        # IGBT RUL
        thermal_cycles = stress_metrics["thermal_cycles"]
        operating_days = total_hours / hours_per_day

        igbt_rul_days = self.igbt_model.rul_days(
            thermal_cycles=thermal_cycles,
            operating_days=operating_days,
        )

        igbt_damage = self.igbt_model.total_damage(thermal_cycles)
        igbt_health = 1.0 - min(1.0, igbt_damage)

        # Create component RUL estimates
        capacitor_rul = ComponentRULEstimate(
            component="capacitor",
            rul_days=cap_rul_days,
            confidence=0.7,  # TODO: calibrate based on validation
            current_health=cap_health,
            degradation_rate=(1.0 - cap_health) / operating_days if operating_days > 0 else 0.0,
            failure_mode="ESR_degradation",
        )

        igbt_rul = ComponentRULEstimate(
            component="igbt",
            rul_days=igbt_rul_days,
            confidence=0.6,  # Lower confidence for thermal cycling
            current_health=igbt_health,
            degradation_rate=(1.0 - igbt_health) / operating_days if operating_days > 0 else 0.0,
            failure_mode="thermal_cycling",
        )

        # Get timestamp
        ts_col = self._find_column(df, ["timestamp", "datetime", "time"])
        timestamp = df[ts_col][-1] if ts_col else datetime.now()

        return ThermalRULResult(
            timestamp=timestamp,
            inverter_id=self.inverter_id,
            capacitor_rul=capacitor_rul,
            igbt_rul=igbt_rul,
            thermal_stress_metrics=stress_metrics,
            min_rul_days=min(cap_rul_days, igbt_rul_days),
        )

    def save_enhanced(self, path: Union[str, Path]) -> None:
        """Save enhanced thermal twin with RUL models."""
        if not self._is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)

        save_data = {
            "model": self.model,
            "thresholds": self.thresholds,
            "inverter_id": self.inverter_id,
            "rated_ac_power_kw": self.rated_ac_power_kw,
            "training_metrics": self.training_metrics,
            "feature_cols": self._feature_cols,
            "capacitor_config": self.capacitor_config,
            "igbt_config": self.igbt_config,
            "stress_config": self.stress_config,
            "stress_accumulator": self.stress_accumulator,
            "version": "1.5-enhanced",
        }

        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    @classmethod
    def load_enhanced(cls, path: Union[str, Path]) -> "EnhancedThermalTwin":
        """Load enhanced thermal twin from file."""
        path = Path(path)

        with open(path, "rb") as f:
            save_data = pickle.load(f)

        twin = cls(
            thresholds=save_data.get("thresholds"),
            inverter_id=save_data.get("inverter_id"),
            rated_ac_power_kw=save_data.get("rated_ac_power_kw"),
            capacitor_config=save_data.get("capacitor_config"),
            igbt_config=save_data.get("igbt_config"),
            thermal_stress_config=save_data.get("stress_config"),
        )

        twin.model = save_data["model"]
        twin.training_metrics = save_data.get("training_metrics")
        twin._feature_cols = save_data.get("feature_cols", cls.FEATURE_COLS)
        twin._is_trained = True
        twin.stress_accumulator = save_data.get("stress_accumulator", ThermalStressAccumulator(twin.stress_config))

        return twin
