"""
String-Level Performance Digital Twin

Hybrid physics-ML model for predicting expected string current and detecting
string-level anomalies (mismatch, degradation, shading, soiling).

Key Features:
- Per-string current prediction with physics baseline
- ML residual learning (CatBoost/LightGBM)
- Multi-type anomaly detection
- Configurable thresholds per anomaly type

Usage:
    # Create and train twin
    twin = StringPerformanceTwin(
        string_id="INV_01.001_string_1",
        inverter_id="INV_01.001",
        num_modules=20,
        module_imp=8.5,  # Module current at MPP (A)
    )

    metrics = twin.train(df_training)
    print(f"Training MAE: {metrics.mae:.2f} A, R²: {metrics.r2:.3f}")

    # Predict and detect anomalies
    df_result = twin.predict(df_new)
    anomalies = twin.detect_anomalies(df_result)

    # Save/load
    twin.save("string_twin.pkl")
    twin = StringPerformanceTwin.load("string_twin.pkl")
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Union, List
import pickle
import logging

import numpy as np
import polars as pl

logger = logging.getLogger(__name__)


class StringAnomalyType(Enum):
    """Types of string-level anomalies."""
    MISMATCH = "mismatch"  # One string underperforms vs neighbors
    DEGRADATION = "degradation"  # Gradual decline over time
    SHADING = "shading"  # Time-of-day patterns (partial shading)
    SOILING = "soiling"  # Uniform underperformance (dirty panels)
    OPEN_CIRCUIT = "open_circuit"  # Complete string failure


class StringAnomalySeverity(Enum):
    """Severity levels for string anomalies."""
    NORMAL = "normal"
    MINOR = "minor"  # <10% underperformance
    MODERATE = "moderate"  # 10-20% underperformance
    SEVERE = "severe"  # >20% underperformance
    CRITICAL = "critical"  # Complete failure


@dataclass
class StringAnomalyResult:
    """Result from string anomaly detection."""
    timestamp: datetime
    string_id: str
    inverter_id: str
    anomaly_type: StringAnomalyType
    severity: StringAnomalySeverity
    actual_current: float
    expected_current: float
    residual: float
    relative_residual_pct: float
    confidence: float = 1.0  # Detection confidence (0-1)

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat() if hasattr(self.timestamp, "isoformat") else str(self.timestamp),
            "string_id": self.string_id,
            "inverter_id": self.inverter_id,
            "anomaly_type": self.anomaly_type.value,
            "severity": self.severity.value,
            "actual_current": round(self.actual_current, 2),
            "expected_current": round(self.expected_current, 2),
            "residual": round(self.residual, 2),
            "relative_residual_pct": round(self.relative_residual_pct, 1),
            "confidence": round(self.confidence, 2),
        }


@dataclass
class StringTwinThresholds:
    """Thresholds for string anomaly detection."""

    # Mismatch detection (relative to expected)
    mismatch_minor_pct: float = 10.0  # 10% below expected
    mismatch_moderate_pct: float = 15.0  # 15% below expected
    mismatch_severe_pct: float = 20.0  # 20% below expected
    mismatch_duration_min: int = 30  # Sustained for 30+ minutes

    # Degradation detection (trend analysis)
    degradation_rate_pct_per_month: float = 0.5  # >0.5%/month decline
    degradation_lookback_days: int = 90  # Analyze last 90 days

    # Shading detection (morning/evening asymmetry)
    shading_asymmetry_pct: float = 15.0  # >15% AM vs PM difference
    shading_min_irradiance: float = 300.0  # W/m² minimum

    # Open circuit detection
    open_circuit_current_threshold: float = 0.1  # <0.1A
    open_circuit_duration_min: int = 15  # Sustained for 15+ minutes

    # Minimum irradiance for anomaly detection
    min_detection_irradiance: float = 200.0  # W/m²


@dataclass
class StringTwinMetrics:
    """Training metrics for string twin."""
    mae: float  # Mean Absolute Error (A)
    rmse: float  # Root Mean Square Error (A)
    r2: float  # R-squared
    mape: float  # Mean Absolute Percentage Error
    n_samples: int
    physics_mae: float = 0.0  # Physics model baseline MAE
    improvement_over_physics_pct: float = 0.0
    feature_importance: dict = field(default_factory=dict)
    training_time_s: float = 0.0


class StringPerformanceTwin:
    """
    Digital twin for string-level current prediction with anomaly detection.

    Hybrid approach:
    1. Physics baseline: I_expected = f(irradiance, temp, module_params)
    2. ML residual learning: I_predicted = I_physics + ML_residual(features)
    3. Anomaly detection: Analyze (I_actual - I_predicted) for patterns

    Features:
    - irradiance: POA irradiance (W/m²)
    - ambient_temp: Ambient temperature (°C)
    - module_temp: Module temperature (°C) if available
    - hour_of_day: Hour (0-23) for shading patterns
    - day_of_year: Day (1-365) for seasonal effects

    Target:
    - string_current: String DC current (A)
    """

    FEATURE_COLS = [
        "irradiance",
        "ambient_temp",
        "module_temp",
        "hour_of_day",
        "day_of_year",
        "hour_sin",
        "hour_cos",
        "doy_sin",
        "doy_cos",
    ]

    def __init__(
        self,
        string_id: str,
        inverter_id: str,
        num_modules: Optional[int] = None,
        module_imp: Optional[float] = None,  # Module current at MPP (A)
        module_temp_coeff: float = -0.004,  # Temperature coefficient (%/°C)
        thresholds: Optional[StringTwinThresholds] = None,
    ):
        """
        Initialize string performance twin.

        Args:
            string_id: Unique identifier (e.g., "INV_01.001_string_1")
            inverter_id: Parent inverter ID
            num_modules: Number of modules in series (for physics model)
            module_imp: Module current at MPP under STC (A)
            module_temp_coeff: Temperature coefficient (%/°C)
            thresholds: Anomaly detection thresholds
        """
        self.string_id = string_id
        self.inverter_id = inverter_id
        self.num_modules = num_modules
        self.module_imp = module_imp
        self.module_temp_coeff = module_temp_coeff
        self.thresholds = thresholds or StringTwinThresholds()

        self.model = None
        self.training_metrics: Optional[StringTwinMetrics] = None
        self._is_trained = False
        self._feature_cols = []

        # Column mapping for flexible input
        self._col_mapping = {
            "irradiance": ["irradiance", "poa_irradiance", "poa", "ghi", "irrad"],
            "ambient_temp": ["ambient_temp", "ambient_temperature", "t_amb", "temp_ambient"],
            "module_temp": ["module_temp", "module_temperature", "t_mod", "temp_module", "t_cell"],
            "string_current": ["string_current", "current", "i_string", "dc_current"],
        }

    def train(
        self,
        df: pl.DataFrame,
        target_col: Optional[str] = None,
        validation_split: float = 0.2,
        use_physics_baseline: bool = True,
        verbose: bool = True,
    ) -> StringTwinMetrics:
        """
        Train the string twin model.

        Args:
            df: Training data with features and target (string current)
            target_col: Name of target column (string current in A)
            validation_split: Fraction of data for validation
            use_physics_baseline: Use physics baseline + ML residual
            verbose: Print training progress

        Returns:
            StringTwinMetrics with training results
        """
        import time
        start_time = time.time()

        # Prepare features
        df_prepared = self._prepare_features(df)

        if df_prepared is None or len(df_prepared) == 0:
            raise ValueError("No valid training data after feature preparation")

        # Get feature columns present in data
        feature_cols = [c for c in self.FEATURE_COLS if c in df_prepared.columns]

        if len(feature_cols) < 2:
            raise ValueError(f"Insufficient features: {feature_cols}. Need at least irradiance + temp.")

        # Find target column
        target = target_col or self._find_column(df_prepared, self._col_mapping["string_current"])
        if target is None:
            raise ValueError("Could not find string current column")

        # Filter valid rows (no nulls, positive irradiance)
        valid_mask = (
            pl.all_horizontal([pl.col(c).is_not_null() for c in feature_cols + [target]]) &
            (pl.col("irradiance") > 0) &
            (pl.col(target) >= 0)
        )
        df_valid = df_prepared.filter(valid_mask)

        if len(df_valid) < 100:
            raise ValueError(f"Insufficient training data: {len(df_valid)} rows (need >= 100)")

        # Physics baseline if enabled
        physics_mae = 0.0
        if use_physics_baseline and self.module_imp and self.num_modules:
            df_valid = self._add_physics_baseline(df_valid)

            # Calculate physics MAE
            physics_residual = (df_valid[target] - df_valid["physics_current"]).to_numpy()
            physics_mae = float(np.mean(np.abs(physics_residual)))

            # Use physics residual as target for ML
            target_values = df_valid["physics_residual"].to_numpy()

            if verbose:
                print(f"Physics baseline MAE: {physics_mae:.3f} A")
        else:
            target_values = df_valid[target].to_numpy()

        # Convert features to numpy
        X = df_valid.select(feature_cols).to_numpy()
        y = target_values

        # Train/validation split (temporal)
        n_val = int(len(X) * validation_split)
        X_train, X_val = X[:-n_val], X[-n_val:]
        y_train, y_val = y[:-n_val], y[-n_val:]

        # Train model
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

        mae = float(np.mean(np.abs(y_val - y_pred_val)))
        rmse = float(np.sqrt(np.mean((y_val - y_pred_val) ** 2)))

        ss_res = np.sum((y_val - y_pred_val) ** 2)
        ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
        r2 = float(1 - (ss_res / ss_tot)) if ss_tot > 0 else 0

        # MAPE (excluding near-zero values)
        mask = np.abs(y_val) > 0.1
        if mask.any():
            mape = float(np.mean(np.abs((y_val[mask] - y_pred_val[mask]) / y_val[mask])))
        else:
            mape = 0.0

        # Feature importance
        if hasattr(self.model, "feature_importances_"):
            importance = dict(zip(feature_cols, self.model.feature_importances_))
        elif hasattr(self.model, "get_feature_importance"):
            importance = dict(zip(feature_cols, self.model.get_feature_importance()))
        else:
            importance = {}

        # Improvement over physics
        improvement_pct = 0.0
        if physics_mae > 0:
            improvement_pct = ((physics_mae - mae) / physics_mae) * 100

        self.training_metrics = StringTwinMetrics(
            mae=mae,
            rmse=rmse,
            r2=r2,
            mape=mape,
            n_samples=len(X_train),
            physics_mae=physics_mae,
            improvement_over_physics_pct=improvement_pct,
            feature_importance=importance,
            training_time_s=time.time() - start_time,
        )

        self._is_trained = True
        self._feature_cols = feature_cols
        self._use_physics = use_physics_baseline and self.module_imp and self.num_modules

        if verbose:
            print(f"String Twin trained: MAE={mae:.3f} A, RMSE={rmse:.3f} A, R²={r2:.3f}")
            if improvement_pct > 0:
                print(f"Improvement over physics: {improvement_pct:.1f}%")

        return self.training_metrics

    def predict(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Predict expected string current and calculate residuals.

        Args:
            df: Input data with feature columns

        Returns:
            DataFrame with added columns:
                - I_string_expected: Predicted current (A)
                - string_residual: Actual - Expected (A)
                - string_residual_pct: (Actual - Expected) / Expected * 100
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

        # Find actual current column
        current_col = self._find_column(df_prepared, self._col_mapping["string_current"])

        # Predict ML residual (or direct current if no physics)
        X = df_prepared.select(feature_cols).to_numpy()

        valid_mask = np.all(~np.isnan(X), axis=1)
        ml_predictions = np.full(len(X), np.nan)

        if np.any(valid_mask):
            ml_predictions[valid_mask] = self.model.predict(X[valid_mask])

        # Combine with physics if used
        if self._use_physics:
            df_prepared = self._add_physics_baseline(df_prepared)
            final_predictions = df_prepared["physics_current"].to_numpy() + ml_predictions
        else:
            final_predictions = ml_predictions

        # Clip to non-negative
        final_predictions = np.clip(final_predictions, 0, None)

        # Add predictions to dataframe
        df_result = df_prepared.with_columns([
            pl.Series("I_string_expected", final_predictions),
        ])

        # Calculate residuals if actual current available
        if current_col is not None:
            df_result = df_result.with_columns([
                (pl.col(current_col) - pl.col("I_string_expected")).alias("string_residual"),
            ])

            # Relative residual (percentage)
            df_result = df_result.with_columns([
                pl.when(pl.col("I_string_expected") > 0.1)
                .then((pl.col("string_residual") / pl.col("I_string_expected")) * 100)
                .otherwise(0.0)
                .alias("string_residual_pct"),
            ])

        return df_result

    def detect_anomalies(
        self,
        df: pl.DataFrame,
        current_col: Optional[str] = None,
    ) -> List[StringAnomalyResult]:
        """
        Detect string-level anomalies from prediction residuals.

        Args:
            df: DataFrame with string_residual column (from predict())
            current_col: Actual current column name

        Returns:
            List of StringAnomalyResult for detected anomalies
        """
        anomalies = []

        if "string_residual_pct" not in df.columns:
            raise ValueError("string_residual_pct column not found. Run predict() first.")

        # Find current column
        if current_col is None:
            current_col = self._find_column(df, self._col_mapping["string_current"])

        # Find timestamp column
        ts_col = self._find_column(df, ["timestamp", "datetime", "time"])

        # Filter to valid irradiance
        df_detect = df.filter(
            pl.col("irradiance") >= self.thresholds.min_detection_irradiance
        )

        if len(df_detect) == 0:
            return anomalies

        # Detect mismatch (sustained underperformance)
        anomalies.extend(self._detect_mismatch(df_detect, current_col, ts_col))

        # Detect open circuit (complete failure)
        anomalies.extend(self._detect_open_circuit(df_detect, current_col, ts_col))

        return anomalies

    def _detect_mismatch(
        self,
        df: pl.DataFrame,
        current_col: str,
        ts_col: Optional[str],
    ) -> List[StringAnomalyResult]:
        """Detect string mismatch (underperformance relative to expected)."""
        anomalies = []

        # Classify severity based on residual percentage
        df_classified = df.with_columns([
            pl.when(pl.col("string_residual_pct") < -self.thresholds.mismatch_severe_pct)
            .then(pl.lit("severe"))
            .when(pl.col("string_residual_pct") < -self.thresholds.mismatch_moderate_pct)
            .then(pl.lit("moderate"))
            .when(pl.col("string_residual_pct") < -self.thresholds.mismatch_minor_pct)
            .then(pl.lit("minor"))
            .otherwise(pl.lit("normal"))
            .alias("_mismatch_severity"),
        ])

        # Group consecutive anomalies
        anomaly_rows = df_classified.filter(pl.col("_mismatch_severity") != "normal")

        if len(anomaly_rows) >= self.thresholds.mismatch_duration_min / 15:  # Assuming 15-min data
            rows = anomaly_rows.to_dicts()

            for row in rows:
                severity_str = row.get("_mismatch_severity", "minor")
                severity = StringAnomalySeverity.MINOR
                if severity_str == "moderate":
                    severity = StringAnomalySeverity.MODERATE
                elif severity_str == "severe":
                    severity = StringAnomalySeverity.SEVERE

                ts = row.get(ts_col) if ts_col else datetime.now()

                anomalies.append(StringAnomalyResult(
                    timestamp=ts,
                    string_id=self.string_id,
                    inverter_id=self.inverter_id,
                    anomaly_type=StringAnomalyType.MISMATCH,
                    severity=severity,
                    actual_current=row.get(current_col, 0.0) if current_col else 0.0,
                    expected_current=row.get("I_string_expected", 0.0),
                    residual=row.get("string_residual", 0.0),
                    relative_residual_pct=row.get("string_residual_pct", 0.0),
                ))

        return anomalies

    def _detect_open_circuit(
        self,
        df: pl.DataFrame,
        current_col: str,
        ts_col: Optional[str],
    ) -> List[StringAnomalyResult]:
        """Detect open circuit (complete string failure)."""
        anomalies = []

        # Find rows with near-zero current but high irradiance
        open_circuit_rows = df.filter(
            (pl.col(current_col) < self.thresholds.open_circuit_current_threshold) &
            (pl.col("irradiance") >= self.thresholds.min_detection_irradiance)
        )

        if len(open_circuit_rows) >= self.thresholds.open_circuit_duration_min / 15:
            rows = open_circuit_rows.to_dicts()

            for row in rows:
                ts = row.get(ts_col) if ts_col else datetime.now()

                anomalies.append(StringAnomalyResult(
                    timestamp=ts,
                    string_id=self.string_id,
                    inverter_id=self.inverter_id,
                    anomaly_type=StringAnomalyType.OPEN_CIRCUIT,
                    severity=StringAnomalySeverity.CRITICAL,
                    actual_current=row.get(current_col, 0.0),
                    expected_current=row.get("I_string_expected", 0.0),
                    residual=row.get("string_residual", 0.0),
                    relative_residual_pct=row.get("string_residual_pct", 0.0),
                    confidence=1.0,
                ))

        return anomalies

    def save(self, path: Union[str, Path]) -> None:
        """Save trained model to file."""
        if not self._is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        save_data = {
            "model": self.model,
            "string_id": self.string_id,
            "inverter_id": self.inverter_id,
            "num_modules": self.num_modules,
            "module_imp": self.module_imp,
            "module_temp_coeff": self.module_temp_coeff,
            "thresholds": self.thresholds,
            "training_metrics": self.training_metrics,
            "feature_cols": self._feature_cols,
            "use_physics": self._use_physics,
            "version": "1.0",
        }

        with open(path, "wb") as f:
            pickle.dump(save_data, f)

        logger.info(f"Saved string twin to {path}")

    @classmethod
    def load(cls, path: Union[str, Path]) -> "StringPerformanceTwin":
        """Load trained model from file."""
        path = Path(path)

        with open(path, "rb") as f:
            save_data = pickle.load(f)

        twin = cls(
            string_id=save_data["string_id"],
            inverter_id=save_data["inverter_id"],
            num_modules=save_data.get("num_modules"),
            module_imp=save_data.get("module_imp"),
            module_temp_coeff=save_data.get("module_temp_coeff", -0.004),
            thresholds=save_data.get("thresholds"),
        )

        twin.model = save_data["model"]
        twin.training_metrics = save_data.get("training_metrics")
        twin._feature_cols = save_data.get("feature_cols", cls.FEATURE_COLS)
        twin._use_physics = save_data.get("use_physics", False)
        twin._is_trained = True

        logger.info(f"Loaded string twin from {path}")
        return twin

    def _add_physics_baseline(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Add physics-based current prediction.

        Simple model: I = I_mp * (G / 1000) * (1 + γ * (T_cell - 25))

        Where:
            I_mp: Module current at MPP (A) at STC
            G: Irradiance (W/m²)
            γ: Temperature coefficient (%/°C)
            T_cell: Cell temperature (°C)
        """
        if not self.module_imp:
            return df

        # Estimate cell temperature if not available
        if "module_temp" not in df.columns:
            # Rough estimate: T_cell ≈ T_amb + 0.03 * G
            df = df.with_columns([
                (pl.col("ambient_temp") + 0.03 * pl.col("irradiance")).alias("module_temp_est")
            ])
            temp_col = "module_temp_est"
        else:
            temp_col = "module_temp"

        # Physics current
        df = df.with_columns([
            (
                self.module_imp *
                (pl.col("irradiance") / 1000.0) *
                (1 + self.module_temp_coeff * (pl.col(temp_col) - 25))
            ).alias("physics_current")
        ])

        # Clip to non-negative
        df = df.with_columns([
            pl.col("physics_current").clip(0, None)
        ])

        # Calculate physics residual (if actual current available)
        current_col = self._find_column(df, self._col_mapping["string_current"])
        if current_col:
            df = df.with_columns([
                (pl.col(current_col) - pl.col("physics_current")).alias("physics_residual")
            ])

        return df

    def _prepare_features(self, df: pl.DataFrame) -> Optional[pl.DataFrame]:
        """Prepare feature columns for model."""
        result = df.clone()

        # Map irradiance
        irrad_col = self._find_column(df, self._col_mapping["irradiance"])
        if irrad_col and irrad_col != "irradiance":
            result = result.with_columns(pl.col(irrad_col).alias("irradiance"))

        # Map ambient temperature
        amb_col = self._find_column(df, self._col_mapping["ambient_temp"])
        if amb_col and amb_col != "ambient_temp":
            result = result.with_columns(pl.col(amb_col).alias("ambient_temp"))

        # Map module temperature
        mod_col = self._find_column(df, self._col_mapping["module_temp"])
        if mod_col and mod_col != "module_temp":
            result = result.with_columns(pl.col(mod_col).alias("module_temp"))

        # Extract temporal features from timestamp
        ts_col = self._find_column(df, ["timestamp", "datetime", "time"])
        if ts_col:
            try:
                # Hour of day
                if "hour_of_day" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.hour().alias("hour_of_day")
                    )

                # Day of year
                if "day_of_year" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.ordinal_day().alias("day_of_year")
                    )

                # Cyclical encoding
                if "hour_sin" not in result.columns:
                    result = result.with_columns([
                        (pl.col("hour_of_day") * 2 * np.pi / 24).sin().alias("hour_sin"),
                        (pl.col("hour_of_day") * 2 * np.pi / 24).cos().alias("hour_cos"),
                    ])

                if "doy_sin" not in result.columns:
                    result = result.with_columns([
                        (pl.col("day_of_year") * 2 * np.pi / 365).sin().alias("doy_sin"),
                        (pl.col("day_of_year") * 2 * np.pi / 365).cos().alias("doy_cos"),
                    ])
            except Exception as e:
                logger.warning(f"Failed to extract temporal features: {e}")

        return result

    def _find_column(self, df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
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

    def to_dict(self) -> dict:
        """Export summary as JSON-serializable dict."""
        return {
            "string_id": self.string_id,
            "inverter_id": self.inverter_id,
            "num_modules": self.num_modules,
            "module_imp": self.module_imp,
            "is_trained": self._is_trained,
            "metrics": {
                "mae": round(self.training_metrics.mae, 3),
                "rmse": round(self.training_metrics.rmse, 3),
                "r2": round(self.training_metrics.r2, 3),
                "mape": round(self.training_metrics.mape * 100, 2),
                "improvement_over_physics_pct": round(
                    self.training_metrics.improvement_over_physics_pct, 1
                ),
            } if self.training_metrics else None,
        }
