"""
Multi-Signal Digital Twins for DC-Side Monitoring

Provides digital twins for:
1. InverterTemperatureTwin - Predict expected inverter temperature
2. DCCurrentTwin - Predict expected DC currents and uniformity metrics
3. DCVoltageTwin - Predict expected DC voltages and stability metrics

Key outputs for soiling ML transfer learning:
- current_cv: DC current coefficient of variation (uniform soiling = low CV)
- temp_deviation: T_actual - T_expected (°C) - distinguishes thermal from soiling
- voltage_cv: DC voltage coefficient of variation (degradation indicator)
- current_loss_pct, voltage_loss_pct, power_loss_pct: Portable loss metrics

Training Data Selection:
    Uses NormalDataFilter (from normal_data_filter.py) for unified multi-stage
    filtering to ensure all twins train on the same clean, fault-free dataset:
    1. Physics bounds - Hard constraints (daytime, positive power, PR limits)
    2. PR envelope - Rolling PR within ±2σ of median
    3. Variability filtering - Remove cloud transients (CV-based)
    4. Iterative outliers - Isolation Forest on model residuals
    5. Clustering (optional) - DBSCAN for normal operation clusters

Usage:
    # Multi-signal factory (recommended)
    factory = MultiSignalTwinFactory(
        inverter_id="INV 01.001",
        p_rated=60.0,  # kW - needed for PR-based filtering
        n_dc_channels=12,
    )

    # Train all twins on unified filtered data
    metrics = factory.train(
        df_training,
        current_cols=["Input_current_01", ...],
        voltage_cols=["U_DC_1", ...],
        power_col="power_normalized",  # For PR-based filtering
    )

    # Access filtering statistics
    print(f"Retained {factory.filter_result.retention_ratio:.1%} of samples")

    # Predict and get features for soiling ML
    df_result = factory.predict(df_new)
    features = factory.get_soiling_features(df_result)
    # Returns: {"current_cv": ..., "temp_deviation": ..., "voltage_cv": ...,
    #           "current_loss_pct": ..., "voltage_loss_pct": ..., "power_loss_pct": ...}

    # Individual twins (for simple use cases)
    temp_twin = InverterTemperatureTwin(inverter_id="INV 01.001")
    temp_twin.train(df_training)
    df_result = temp_twin.predict(df_new)
    # Output: T_expected, temp_deviation
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, Union, List, Dict, Any
import pickle
import logging

import numpy as np
import pandas as pd
import polars as pl

# Import NormalDataFilter for unified training data selection
from .normal_data_filter import NormalDataFilter, FilterConfig, FilterResult

logger = logging.getLogger(__name__)


@dataclass
class TwinMetrics:
    """Training metrics for digital twins."""
    mae: float  # Mean Absolute Error
    rmse: float  # Root Mean Square Error
    r2: float  # R-squared
    n_samples: int
    physics_mae: float = 0.0
    improvement_over_physics_pct: float = 0.0
    feature_importance: dict = field(default_factory=dict)
    training_time_s: float = 0.0


@dataclass
class MultiSignalTwinOutput:
    """Output from multi-signal twin inference."""
    timestamp: datetime
    inverter_id: str

    # Temperature twin outputs
    temp_expected: Optional[float] = None
    temp_actual: Optional[float] = None
    temp_deviation: Optional[float] = None  # T_actual - T_expected

    # DC Current twin outputs
    current_cv: Optional[float] = None  # Coefficient of variation across channels
    current_imbalance_ratio: Optional[float] = None  # Max/Min ratio
    currents_expected: Optional[List[float]] = None
    currents_actual: Optional[List[float]] = None
    current_loss_pct: Optional[float] = None  # (I_exp - I_act) / I_exp * 100

    # DC Voltage twin outputs
    voltage_cv: Optional[float] = None  # Coefficient of variation across channels
    voltage_deviation: Optional[float] = None  # Average deviation from expected
    voltages_expected: Optional[List[float]] = None
    voltages_actual: Optional[List[float]] = None
    voltage_loss_pct: Optional[float] = None  # (V_exp - V_act) / V_exp * 100

    # Power loss (aggregate)
    power_loss_pct: Optional[float] = None  # Derived from P_actual / P_expected

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat() if hasattr(self.timestamp, "isoformat") else str(self.timestamp),
            "inverter_id": self.inverter_id,
            "temp_expected": round(self.temp_expected, 2) if self.temp_expected else None,
            "temp_actual": round(self.temp_actual, 2) if self.temp_actual else None,
            "temp_deviation": round(self.temp_deviation, 2) if self.temp_deviation else None,
            "current_cv": round(self.current_cv, 4) if self.current_cv else None,
            "current_imbalance_ratio": round(self.current_imbalance_ratio, 3) if self.current_imbalance_ratio else None,
            "current_loss_pct": round(self.current_loss_pct, 2) if self.current_loss_pct is not None else None,
            "voltage_cv": round(self.voltage_cv, 4) if self.voltage_cv else None,
            "voltage_deviation": round(self.voltage_deviation, 2) if self.voltage_deviation else None,
            "voltage_loss_pct": round(self.voltage_loss_pct, 2) if self.voltage_loss_pct is not None else None,
            "power_loss_pct": round(self.power_loss_pct, 2) if self.power_loss_pct is not None else None,
        }


class InverterTemperatureTwin:
    """
    Digital twin for inverter/module temperature prediction.

    Predicts expected temperature from irradiance and ambient temperature
    using the Sandia thermal model + ML residual learning.

    Physics baseline:
        T_cell = T_amb + G * (NOCT - 20) / 800

    Where:
        T_amb: Ambient temperature (°C)
        G: POA irradiance (W/m²)
        NOCT: Nominal Operating Cell Temperature (typically 45°C)

    The temperature deviation (T_actual - T_expected) helps distinguish:
    - Thermal issues (high deviation) from soiling (low deviation)
    - Inverter overheating from environmental effects

    Note: Inverter temperature is driven by power conversion losses, not just
    irradiance. The physics baseline approximates:
        T_inv ≈ T_ambient + k × P_out (heat from conversion losses)
    The ML learns the residual including efficiency curve effects.
    """

    FEATURE_COLS = [
        "irradiance",
        "ambient_temp",
        "power",  # Inverter power - key driver of inverter heat
        "hour_of_day",
        "day_of_year",
        "hour_sin",
        "hour_cos",
    ]

    def __init__(
        self,
        inverter_id: str,
        noct: float = 45.0,  # Nominal Operating Cell Temperature (for module temp baseline)
        thermal_coeff: float = 0.3,  # °C per kW of power (for inverter temp baseline)
        use_physics_baseline: bool = True,
    ):
        """
        Initialize temperature twin.

        Args:
            inverter_id: Inverter identifier
            noct: Nominal Operating Cell Temperature (°C) - for module temp baseline
            thermal_coeff: Temperature rise per kW of power (°C/kW) - for inverter temp baseline
            use_physics_baseline: Use physics baseline + ML residual
        """
        self.inverter_id = inverter_id
        self.noct = noct
        self.thermal_coeff = thermal_coeff
        self.use_physics_baseline = use_physics_baseline

        self.model = None
        self.training_metrics: Optional[TwinMetrics] = None
        self._is_trained = False
        self._feature_cols = []
        self._has_power = False  # Track if power feature is available

    def _calculate_physics_baseline(
        self,
        irradiance: np.ndarray,
        ambient_temp: np.ndarray,
        power: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """
        Calculate expected temperature using physics model.

        If power is available (inverter temperature):
            T_inv = T_amb + thermal_coeff × P_out
            (heat from power conversion losses)

        Otherwise fall back to NOCT model (module temperature):
            T_cell = T_amb + G × (NOCT - 20) / 800
        """
        if power is not None and self._has_power:
            # Inverter temperature model: heat from conversion losses
            return ambient_temp + self.thermal_coeff * power
        else:
            # Module temperature model: NOCT
            return ambient_temp + irradiance * (self.noct - 20) / 800

    def train(
        self,
        df: pl.DataFrame,
        target_col: str = "inverter_temp",
        irradiance_col: str = "irradiance",
        ambient_temp_col: str = "ambient_temp",
        power_col: Optional[str] = None,
        validation_split: float = 0.2,
        verbose: bool = True,
    ) -> TwinMetrics:
        """
        Train the temperature twin.

        Args:
            df: Training data
            target_col: Name of actual temperature column
            irradiance_col: Name of irradiance column
            ambient_temp_col: Name of ambient temperature column
            power_col: Name of inverter power column (improves inverter temp prediction)
            validation_split: Fraction for validation
            verbose: Print progress

        Returns:
            TwinMetrics with training results
        """
        import time
        start_time = time.time()

        # Prepare features
        df_prepared = self._prepare_features(df, irradiance_col, ambient_temp_col, power_col)

        if df_prepared is None or len(df_prepared) == 0:
            raise ValueError("No valid training data after preparation")

        # Check required columns
        if target_col not in df_prepared.columns:
            raise ValueError(f"Target column '{target_col}' not found")

        # Track if power is available for physics baseline
        self._has_power = "power" in df_prepared.columns

        # Get feature columns present in data
        feature_cols = [c for c in self.FEATURE_COLS if c in df_prepared.columns]

        if len(feature_cols) < 2:
            raise ValueError(f"Insufficient features: {feature_cols}")

        # Filter valid rows
        valid_mask = (
            pl.all_horizontal([pl.col(c).is_not_null() for c in feature_cols + [target_col]]) &
            (pl.col("irradiance") > 50)  # Minimum irradiance
        )
        df_valid = df_prepared.filter(valid_mask)

        if len(df_valid) < 100:
            raise ValueError(f"Insufficient training data: {len(df_valid)} rows")

        # Physics baseline
        physics_mae = 0.0
        if self.use_physics_baseline:
            irradiance = df_valid["irradiance"].to_numpy()
            ambient = df_valid["ambient_temp"].to_numpy()
            power = df_valid["power"].to_numpy() if self._has_power else None
            physics_pred = self._calculate_physics_baseline(irradiance, ambient, power)

            actual = df_valid[target_col].to_numpy()
            physics_residual = actual - physics_pred
            physics_mae = float(np.mean(np.abs(physics_residual)))

            # ML target is the residual
            target_values = physics_residual

            if verbose:
                baseline_type = "power-based" if self._has_power else "irradiance-based"
                print(f"Physics baseline ({baseline_type}) MAE: {physics_mae:.3f} °C")
        else:
            target_values = df_valid[target_col].to_numpy()

        # Train ML model
        X = df_valid.select(feature_cols).to_numpy()
        y = target_values

        n_val = int(len(X) * validation_split)
        X_train, X_val = X[:-n_val], X[-n_val:]
        y_train, y_val = y[:-n_val], y[-n_val:]

        # Use CatBoost or fallback
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
            self.model.fit(X_train, y_train, eval_set=(X_val, y_val), verbose=verbose)

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
                self.model.fit(X_train, y_train, eval_set=[(X_val, y_val)])

            except ImportError:
                from sklearn.ensemble import GradientBoostingRegressor

                self.model = GradientBoostingRegressor(
                    n_estimators=100, learning_rate=0.1, max_depth=5, random_state=42
                )
                self.model.fit(X_train, y_train)

        # Calculate metrics
        y_pred = self.model.predict(X_val)
        mae = float(np.mean(np.abs(y_val - y_pred)))
        rmse = float(np.sqrt(np.mean((y_val - y_pred) ** 2)))

        ss_res = np.sum((y_val - y_pred) ** 2)
        ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
        r2 = float(1 - (ss_res / ss_tot)) if ss_tot > 0 else 0

        # Feature importance
        if hasattr(self.model, "feature_importances_"):
            importance = dict(zip(feature_cols, self.model.feature_importances_))
        elif hasattr(self.model, "get_feature_importance"):
            importance = dict(zip(feature_cols, self.model.get_feature_importance()))
        else:
            importance = {}

        improvement_pct = ((physics_mae - mae) / physics_mae * 100) if physics_mae > 0 else 0

        self.training_metrics = TwinMetrics(
            mae=mae,
            rmse=rmse,
            r2=r2,
            n_samples=len(X_train),
            physics_mae=physics_mae,
            improvement_over_physics_pct=improvement_pct,
            feature_importance=importance,
            training_time_s=time.time() - start_time,
        )

        self._is_trained = True
        self._feature_cols = feature_cols

        if verbose:
            print(f"Temperature Twin trained: MAE={mae:.3f} °C, R²={r2:.3f}")
            if improvement_pct > 0:
                print(f"Improvement over physics: {improvement_pct:.1f}%")

        return self.training_metrics

    def predict(
        self,
        df: pl.DataFrame,
        actual_temp_col: Optional[str] = "inverter_temp",
        irradiance_col: str = "irradiance",
        ambient_temp_col: str = "ambient_temp",
        power_col: Optional[str] = None,
    ) -> pl.DataFrame:
        """
        Predict expected temperature and calculate deviation.

        Args:
            df: Input data
            actual_temp_col: Actual temperature column (optional)
            irradiance_col: Irradiance column
            ambient_temp_col: Ambient temperature column
            power_col: Power column (optional, improves inverter temp prediction)

        Returns:
            DataFrame with T_expected, temp_deviation columns
        """
        if not self._is_trained:
            raise RuntimeError("Model not trained. Call train() first.")

        df_prepared = self._prepare_features(df, irradiance_col, ambient_temp_col, power_col)

        if df_prepared is None:
            return df

        # Predict ML component
        feature_cols = [c for c in self._feature_cols if c in df_prepared.columns]
        X = df_prepared.select(feature_cols).to_numpy()

        valid_mask = np.all(~np.isnan(X), axis=1)
        ml_pred = np.full(len(X), np.nan)

        if np.any(valid_mask):
            ml_pred[valid_mask] = self.model.predict(X[valid_mask])

        # Add physics baseline (uses power if trained with power)
        if self.use_physics_baseline:
            irradiance = df_prepared["irradiance"].to_numpy()
            ambient = df_prepared["ambient_temp"].to_numpy()
            power = df_prepared["power"].to_numpy() if self._has_power and "power" in df_prepared.columns else None
            physics_pred = self._calculate_physics_baseline(irradiance, ambient, power)
            final_pred = physics_pred + ml_pred
        else:
            final_pred = ml_pred

        # Add predictions
        df_result = df_prepared.with_columns([
            pl.Series("T_expected", final_pred),
        ])

        # Calculate deviation if actual available
        if actual_temp_col and actual_temp_col in df_result.columns:
            df_result = df_result.with_columns([
                (pl.col(actual_temp_col) - pl.col("T_expected")).alias("temp_deviation"),
            ])

        return df_result

    def _prepare_features(
        self,
        df: pl.DataFrame,
        irradiance_col: str,
        ambient_temp_col: str,
        power_col: Optional[str] = None,
    ) -> Optional[pl.DataFrame]:
        """Prepare feature columns.

        Args:
            df: Input DataFrame
            irradiance_col: Name of irradiance column
            ambient_temp_col: Name of ambient temperature column
            power_col: Name of power column (optional, improves inverter temp prediction)
        """
        result = df.clone()

        # Map columns
        if irradiance_col != "irradiance" and irradiance_col in df.columns:
            result = result.with_columns(pl.col(irradiance_col).alias("irradiance"))

        if ambient_temp_col != "ambient_temp" and ambient_temp_col in df.columns:
            result = result.with_columns(pl.col(ambient_temp_col).alias("ambient_temp"))

        # Map power column if provided
        if power_col and power_col in df.columns and power_col != "power":
            result = result.with_columns(pl.col(power_col).alias("power"))

        # Check required columns
        if "irradiance" not in result.columns or "ambient_temp" not in result.columns:
            logger.warning("Missing required columns: irradiance or ambient_temp")
            return None

        # Extract temporal features
        ts_col = None
        for col in ["timestamp", "datetime", "time"]:
            if col in result.columns:
                ts_col = col
                break

        if ts_col:
            try:
                # Convert string timestamp to datetime if needed
                col_dtype = result[ts_col].dtype
                if col_dtype == pl.Utf8 or col_dtype == pl.String:
                    # Handle various date formats: "2022.01.01 00:00" or "2022-01-01 00:00"
                    result = result.with_columns(
                        pl.col(ts_col)
                        .str.replace_all(r"\.", "-")  # Convert dots to dashes
                        .str.to_datetime(format="%Y-%m-%d %H:%M", strict=False)
                        .alias(ts_col)
                    )

                if "hour_of_day" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.hour().alias("hour_of_day")
                    )
                if "day_of_year" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.ordinal_day().alias("day_of_year")
                    )
                if "hour_sin" not in result.columns:
                    result = result.with_columns([
                        (pl.col("hour_of_day") * 2 * np.pi / 24).sin().alias("hour_sin"),
                        (pl.col("hour_of_day") * 2 * np.pi / 24).cos().alias("hour_cos"),
                    ])
            except Exception as e:
                logger.warning(f"Failed to extract temporal features: {e}")

        return result

    def save(self, path: Union[str, Path]) -> None:
        """Save trained model."""
        if not self._is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        save_data = {
            "model": self.model,
            "inverter_id": self.inverter_id,
            "noct": self.noct,
            "thermal_coeff": self.thermal_coeff,
            "use_physics_baseline": self.use_physics_baseline,
            "training_metrics": self.training_metrics,
            "feature_cols": self._feature_cols,
            "has_power": self._has_power,
            "version": "1.1",  # Bumped for power feature
        }

        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "InverterTemperatureTwin":
        """Load trained model."""
        with open(path, "rb") as f:
            data = pickle.load(f)

        twin = cls(
            inverter_id=data["inverter_id"],
            noct=data.get("noct", 45.0),
            thermal_coeff=data.get("thermal_coeff", 0.3),
            use_physics_baseline=data.get("use_physics_baseline", True),
        )
        twin.model = data["model"]
        twin.training_metrics = data.get("training_metrics")
        twin._feature_cols = data.get("feature_cols", cls.FEATURE_COLS)
        twin._has_power = data.get("has_power", False)  # Default False for backward compat
        twin._is_trained = True

        return twin


class DCCurrentTwin:
    """
    Digital twin for DC current prediction and uniformity analysis.

    For soiling ML transfer learning, the key insight is:
    - Uniform soiling: All strings affected equally → LOW current CV
    - Partial shading: Some strings shadowed → HIGH current CV

    Physics baseline:
        I_expected = I_sc * (G / 1000) * (1 + alpha * (T - 25))

    Where:
        I_sc: Short-circuit current at STC (A)
        G: POA irradiance (W/m²)
        alpha: Temperature coefficient of current (+0.05%/°C typical)
        T: Cell temperature (°C)

    Outputs:
        - current_cv: Coefficient of variation across MPPT channels
        - current_imbalance_ratio: Max/Min current ratio
        - I_expected[]: Expected current per channel
    """

    FEATURE_COLS = [
        "irradiance",
        "ambient_temp",
        "module_temp",
        "hour_of_day",
        "day_of_year",
    ]

    def __init__(
        self,
        inverter_id: str,
        n_channels: int = 12,  # Number of MPPT/DC channels
        i_sc_ref: float = 10.0,  # Reference short-circuit current (A)
        alpha_isc: float = 0.0005,  # Temperature coefficient of Isc (%/°C)
    ):
        """
        Initialize DC current twin.

        Args:
            inverter_id: Inverter identifier
            n_channels: Number of MPPT/DC input channels
            i_sc_ref: Reference Isc at STC (A)
            alpha_isc: Temperature coefficient of Isc (+0.05%/°C typical)
        """
        self.inverter_id = inverter_id
        self.n_channels = n_channels
        self.i_sc_ref = i_sc_ref
        self.alpha_isc = alpha_isc

        self.model = None
        self.training_metrics: Optional[TwinMetrics] = None
        self._is_trained = False
        self._feature_cols = []
        self._mean_current = 0.0  # For normalization

    def _calculate_physics_baseline(
        self,
        irradiance: np.ndarray,
        temp: np.ndarray,
    ) -> np.ndarray:
        """
        Calculate expected current using physics model.

        I = I_sc * (G / 1000) * (1 + alpha * (T - 25))
        """
        return self.i_sc_ref * (irradiance / 1000) * (1 + self.alpha_isc * (temp - 25))

    def calculate_cv(
        self,
        df: pl.DataFrame,
        current_cols: List[str],
        i_expected: Optional[np.ndarray] = None,
    ) -> pl.DataFrame:
        """
        Calculate coefficient of variation and loss percentage across DC current channels.

        CV = std / mean (lower = more uniform = likely uniform soiling)
        Loss % = (I_expected - I_actual) / I_expected * 100

        Args:
            df: DataFrame with current columns
            current_cols: List of current column names
            i_expected: Optional array of expected currents (for loss calculation)

        Returns:
            DataFrame with current_cv, current_imbalance_ratio, current_loss_pct columns
        """
        # Extract current values
        currents = []
        for col in current_cols:
            if col in df.columns:
                currents.append(df[col].to_numpy())

        if len(currents) == 0:
            logger.warning("No current columns found")
            return df

        # Stack and calculate statistics
        current_array = np.column_stack(currents)  # Shape: (n_rows, n_channels)

        # Calculate CV for each row
        with np.errstate(divide='ignore', invalid='ignore'):
            mean_current = np.nanmean(current_array, axis=1)
            std_current = np.nanstd(current_array, axis=1)
            cv = np.where(mean_current > 0.1, std_current / mean_current, np.nan)

            # Imbalance ratio: max/min (excluding zeros)
            min_current = np.nanmin(np.where(current_array > 0.1, current_array, np.nan), axis=1)
            max_current = np.nanmax(current_array, axis=1)
            imbalance_ratio = np.where(min_current > 0, max_current / min_current, np.nan)

            # Total current (sum across all channels)
            total_current = np.nansum(current_array, axis=1)

        # Add to dataframe
        result = df.with_columns([
            pl.Series("current_cv", cv),
            pl.Series("current_imbalance_ratio", imbalance_ratio),
            pl.Series("current_mean", mean_current),
            pl.Series("current_total", total_current),
        ])

        # Calculate loss percentage if expected current provided
        if i_expected is not None:
            with np.errstate(divide='ignore', invalid='ignore'):
                # Expected total = I_expected * n_channels (assuming same for all)
                i_exp_total = i_expected * len(currents)
                # Loss % = (expected - actual) / expected * 100
                current_loss_pct = np.where(
                    i_exp_total > 0.1,
                    (i_exp_total - total_current) / i_exp_total * 100,
                    np.nan
                )
            result = result.with_columns([
                pl.Series("current_loss_pct", current_loss_pct),
            ])

        return result

    @staticmethod
    def detect_current_columns(
        df: pl.DataFrame,
        inverter_id: str,
        patterns: Optional[Dict[str, str]] = None,
    ) -> List[str]:
        """
        Detect DC current columns for an inverter.

        Handles multiple naming conventions:
        - Input_current_XX: String-level currents (12-18 channels)
        - I_MPPT_X: MPPT tracker currents (typically 9 channels)
        - I_DC_X: Generic DC current (less common)

        Args:
            df: DataFrame to search
            inverter_id: Inverter identifier (e.g., "INV 01.001")
            patterns: Optional dict with custom patterns

        Returns:
            List of current column names found
        """
        import re
        current_cols = []

        # Escape special chars in inverter_id for regex
        inv_escaped = re.escape(inverter_id)

        # Standard patterns to check
        check_patterns = [
            # Input_current_XX (most common) - e.g., "Plant: INV 01.001 / Input_current_01 (A)"
            rf".*{inv_escaped}.*Input_current_\d+.*",
            # I_MPPT_X - e.g., "Plant: INV 01.001 / I_MPPT_1 (A)"
            rf".*{inv_escaped}.*I_MPPT_\d+.*",
            # I_DC_X - less common
            rf".*{inv_escaped}.*I_DC_\d+.*",
            # I_DC_SUM - aggregated DC current (single channel)
            rf".*{inv_escaped}.*I_DC_SUM.*",
            # I_DC without number suffix (single channel plants like Epsilon)
            rf".*{inv_escaped}.*/\s*I_DC\s*\(.*",
        ]

        for col in df.columns:
            for pattern in check_patterns:
                if re.match(pattern, col, re.IGNORECASE):
                    current_cols.append(col)
                    break

        # Sort by channel number
        def extract_channel(col_name: str) -> int:
            match = re.search(r'(\d+)\s*(?:\([^)]*\))?$', col_name)
            return int(match.group(1)) if match else 0

        current_cols.sort(key=extract_channel)

        return current_cols

    def train(
        self,
        df: pl.DataFrame,
        current_cols: List[str],
        irradiance_col: str = "irradiance",
        temp_col: str = "module_temp",
        validation_split: float = 0.2,
        verbose: bool = True,
    ) -> TwinMetrics:
        """
        Train the DC current twin.

        Trains a model to predict mean current per inverter, then uses
        physics to estimate individual channel currents.

        Args:
            df: Training data
            current_cols: List of DC current column names
            irradiance_col: Irradiance column
            temp_col: Temperature column (module or ambient)
            validation_split: Fraction for validation
            verbose: Print progress

        Returns:
            TwinMetrics
        """
        import time
        start_time = time.time()

        # Calculate CV for training data
        df_cv = self.calculate_cv(df, current_cols)

        # Prepare features
        df_prepared = self._prepare_features(df_cv, irradiance_col, temp_col)

        if df_prepared is None or len(df_prepared) == 0:
            raise ValueError("No valid training data")

        # Filter valid rows
        # Note: Polars NaN comparison returns True (NaN > 0.5 = True), so we must
        # explicitly filter out NaN values using is_not_nan()
        feature_cols = [c for c in self.FEATURE_COLS if c in df_prepared.columns]
        valid_mask = (
            pl.all_horizontal([pl.col(c).is_not_null() for c in feature_cols]) &
            (pl.col("irradiance") > 50) &
            (pl.col("current_mean") > 0.1) &
            pl.col("current_mean").is_not_nan()
        )
        df_valid = df_prepared.filter(valid_mask)

        if len(df_valid) < 100:
            raise ValueError(f"Insufficient training data: {len(df_valid)} rows")

        # Physics baseline
        irradiance = df_valid["irradiance"].to_numpy()
        temp = df_valid["module_temp"].to_numpy() if "module_temp" in df_valid.columns else df_valid["ambient_temp"].to_numpy() + 20

        physics_pred = self._calculate_physics_baseline(irradiance, temp)
        actual = df_valid["current_mean"].to_numpy()

        physics_residual = actual - physics_pred
        physics_mae = float(np.mean(np.abs(physics_residual)))

        self._mean_current = float(np.mean(actual))

        if verbose:
            print(f"Physics baseline MAE: {physics_mae:.3f} A")

        # Train ML on residual
        X = df_valid.select(feature_cols).to_numpy()
        y = physics_residual

        n_val = int(len(X) * validation_split)
        X_train, X_val = X[:-n_val], X[-n_val:]
        y_train, y_val = y[:-n_val], y[-n_val:]

        try:
            from catboost import CatBoostRegressor

            self.model = CatBoostRegressor(
                iterations=300,
                learning_rate=0.05,
                depth=5,
                loss_function="RMSE",
                verbose=False,
                early_stopping_rounds=30,
                random_seed=42,
            )
            self.model.fit(X_train, y_train, eval_set=(X_val, y_val), verbose=verbose)

        except ImportError:
            from sklearn.ensemble import GradientBoostingRegressor

            self.model = GradientBoostingRegressor(
                n_estimators=100, learning_rate=0.1, max_depth=4, random_state=42
            )
            self.model.fit(X_train, y_train)

        # Metrics
        y_pred = self.model.predict(X_val)
        mae = float(np.mean(np.abs(y_val - y_pred)))
        rmse = float(np.sqrt(np.mean((y_val - y_pred) ** 2)))

        ss_res = np.sum((y_val - y_pred) ** 2)
        ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
        r2 = float(1 - (ss_res / ss_tot)) if ss_tot > 0 else 0

        improvement_pct = ((physics_mae - mae) / physics_mae * 100) if physics_mae > 0 else 0

        self.training_metrics = TwinMetrics(
            mae=mae,
            rmse=rmse,
            r2=r2,
            n_samples=len(X_train),
            physics_mae=physics_mae,
            improvement_over_physics_pct=improvement_pct,
            training_time_s=time.time() - start_time,
        )

        self._is_trained = True
        self._feature_cols = feature_cols

        if verbose:
            print(f"DC Current Twin trained: MAE={mae:.3f} A, R²={r2:.3f}")

        return self.training_metrics

    def predict(
        self,
        df: pl.DataFrame,
        current_cols: Optional[List[str]] = None,
        irradiance_col: str = "irradiance",
        temp_col: str = "module_temp",
    ) -> pl.DataFrame:
        """
        Predict expected DC currents and calculate CV and loss percentage.

        Args:
            df: Input data
            current_cols: Current column names (for CV calculation)
            irradiance_col: Irradiance column
            temp_col: Temperature column

        Returns:
            DataFrame with I_expected, current_cv, current_imbalance_ratio, current_loss_pct
        """
        if not self._is_trained:
            raise RuntimeError("Model not trained. Call train() first.")

        df_prepared = self._prepare_features(df, irradiance_col, temp_col)

        if df_prepared is None:
            return df

        # Predict expected current per channel
        feature_cols = [c for c in self._feature_cols if c in df_prepared.columns]
        X = df_prepared.select(feature_cols).to_numpy()

        valid_mask = np.all(~np.isnan(X), axis=1)
        ml_pred = np.full(len(X), np.nan)

        if np.any(valid_mask):
            ml_pred[valid_mask] = self.model.predict(X[valid_mask])

        # Add physics baseline
        irradiance = df_prepared["irradiance"].to_numpy()
        temp = df_prepared["module_temp"].to_numpy() if "module_temp" in df_prepared.columns else df_prepared["ambient_temp"].to_numpy() + 20

        physics_pred = self._calculate_physics_baseline(irradiance, temp)
        i_expected = np.clip(physics_pred + ml_pred, 0, None)

        df_result = df_prepared.with_columns([
            pl.Series("I_expected", i_expected),
        ])

        # Calculate CV and loss % if current columns provided
        if current_cols:
            df_result = self.calculate_cv(df_result, current_cols, i_expected=i_expected)

        return df_result

    def _prepare_features(
        self,
        df: pl.DataFrame,
        irradiance_col: str,
        temp_col: str,
    ) -> Optional[pl.DataFrame]:
        """Prepare feature columns."""
        result = df.clone()

        if irradiance_col != "irradiance" and irradiance_col in df.columns:
            result = result.with_columns(pl.col(irradiance_col).alias("irradiance"))

        if temp_col != "module_temp" and temp_col in df.columns:
            result = result.with_columns(pl.col(temp_col).alias("module_temp"))
        elif "ambient_temp" in df.columns and "module_temp" not in result.columns:
            # Estimate module temp from ambient
            result = result.with_columns(
                (pl.col("ambient_temp") + 20).alias("module_temp")
            )

        if "irradiance" not in result.columns:
            logger.warning("Missing irradiance column")
            return None

        # Temporal features
        ts_col = None
        for col in ["timestamp", "datetime", "time"]:
            if col in result.columns:
                ts_col = col
                break

        if ts_col:
            try:
                # Convert string timestamp to datetime if needed
                col_dtype = result[ts_col].dtype
                if col_dtype == pl.Utf8 or col_dtype == pl.String:
                    # Handle various date formats: "2022.01.01 00:00" or "2022-01-01 00:00"
                    result = result.with_columns(
                        pl.col(ts_col)
                        .str.replace_all(r"\.", "-")  # Convert dots to dashes
                        .str.to_datetime(format="%Y-%m-%d %H:%M", strict=False)
                        .alias(ts_col)
                    )

                if "hour_of_day" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.hour().alias("hour_of_day")
                    )
                if "day_of_year" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.ordinal_day().alias("day_of_year")
                    )
            except Exception as e:
                logger.warning(f"Failed to extract temporal features: {e}")

        return result

    def save(self, path: Union[str, Path]) -> None:
        """Save trained model."""
        if not self._is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        save_data = {
            "model": self.model,
            "inverter_id": self.inverter_id,
            "n_channels": self.n_channels,
            "i_sc_ref": self.i_sc_ref,
            "alpha_isc": self.alpha_isc,
            "mean_current": self._mean_current,
            "training_metrics": self.training_metrics,
            "feature_cols": self._feature_cols,
            "version": "1.0",
        }

        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "DCCurrentTwin":
        """Load trained model."""
        with open(path, "rb") as f:
            data = pickle.load(f)

        twin = cls(
            inverter_id=data["inverter_id"],
            n_channels=data.get("n_channels", 12),
            i_sc_ref=data.get("i_sc_ref", 10.0),
            alpha_isc=data.get("alpha_isc", 0.0005),
        )
        twin.model = data["model"]
        twin.training_metrics = data.get("training_metrics")
        twin._feature_cols = data.get("feature_cols", cls.FEATURE_COLS)
        twin._mean_current = data.get("mean_current", 0.0)
        twin._is_trained = True

        return twin


class DCVoltageTwin:
    """
    Digital twin for DC voltage prediction and stability analysis.

    Physics baseline:
        V_oc = V_oc_ref * (1 + beta * (T - 25)) * ln(G / G_ref + 1) / ln(2)

    Where:
        V_oc_ref: Open-circuit voltage at STC (V)
        beta: Temperature coefficient of voltage (-0.3%/°C typical)
        T: Cell temperature (°C)
        G: POA irradiance (W/m²)
        G_ref: Reference irradiance (1000 W/m²)

    Voltage deviations can indicate:
    - Cell degradation (lower voltage)
    - Hot spots (localized voltage drops)
    - PID (Potential Induced Degradation)

    Outputs:
        - voltage_cv: Coefficient of variation across channels
        - voltage_deviation: Average deviation from expected
    """

    FEATURE_COLS = [
        "irradiance",
        "ambient_temp",
        "module_temp",
        "hour_of_day",
        "day_of_year",
    ]

    def __init__(
        self,
        inverter_id: str,
        n_channels: int = 12,
        v_oc_ref: float = 600.0,  # Reference Voc at STC (V)
        beta_voc: float = -0.003,  # Temperature coefficient of Voc (%/°C)
    ):
        """
        Initialize DC voltage twin.

        Args:
            inverter_id: Inverter identifier
            n_channels: Number of MPPT/DC channels
            v_oc_ref: Reference Voc at STC (V)
            beta_voc: Temperature coefficient of Voc (-0.3%/°C typical)
        """
        self.inverter_id = inverter_id
        self.n_channels = n_channels
        self.v_oc_ref = v_oc_ref
        self.beta_voc = beta_voc

        self.model = None
        self.training_metrics: Optional[TwinMetrics] = None
        self._is_trained = False
        self._feature_cols = []
        self._mean_voltage = 0.0

    def _calculate_physics_baseline(
        self,
        irradiance: np.ndarray,
        temp: np.ndarray,
    ) -> np.ndarray:
        """
        Calculate expected voltage using simplified physics model.

        V = V_oc * (1 + beta * (T - 25)) * irradiance_factor
        """
        # Temperature correction
        temp_factor = 1 + self.beta_voc * (temp - 25)

        # Irradiance correction (logarithmic relationship)
        with np.errstate(divide='ignore', invalid='ignore'):
            irrad_factor = np.where(
                irradiance > 10,
                np.log(irradiance / 1000 + 1) / np.log(2),
                0.0
            )

        return self.v_oc_ref * temp_factor * np.clip(irrad_factor, 0, 1.2)

    def calculate_cv(
        self,
        df: pl.DataFrame,
        voltage_cols: List[str],
        v_expected: Optional[np.ndarray] = None,
    ) -> pl.DataFrame:
        """
        Calculate coefficient of variation and loss percentage across DC voltage channels.

        Args:
            df: DataFrame with voltage columns
            voltage_cols: List of voltage column names
            v_expected: Optional array of expected voltages (for loss calculation)

        Returns:
            DataFrame with voltage_cv, voltage_mean, voltage_loss_pct columns
        """
        voltages = []
        for col in voltage_cols:
            if col in df.columns:
                voltages.append(df[col].to_numpy())

        if len(voltages) == 0:
            logger.warning("No voltage columns found")
            return df

        voltage_array = np.column_stack(voltages)

        with np.errstate(divide='ignore', invalid='ignore'):
            mean_voltage = np.nanmean(voltage_array, axis=1)
            std_voltage = np.nanstd(voltage_array, axis=1)
            cv = np.where(mean_voltage > 10, std_voltage / mean_voltage, np.nan)

        result = df.with_columns([
            pl.Series("voltage_cv", cv),
            pl.Series("voltage_mean", mean_voltage),
        ])

        # Calculate loss percentage if expected voltage provided
        if v_expected is not None:
            with np.errstate(divide='ignore', invalid='ignore'):
                # Loss % = (expected - actual) / expected * 100
                voltage_loss_pct = np.where(
                    v_expected > 10,
                    (v_expected - mean_voltage) / v_expected * 100,
                    np.nan
                )
            result = result.with_columns([
                pl.Series("voltage_loss_pct", voltage_loss_pct),
            ])

        return result

    @staticmethod
    def detect_voltage_columns(
        df: pl.DataFrame,
        inverter_id: str,
        patterns: Optional[Dict[str, str]] = None,
    ) -> List[str]:
        """
        Detect DC voltage columns for an inverter.

        Handles multiple naming conventions:
        - U_DC_X: Standard DC voltage pattern (most plants)
        - U_MPPT_X: MPPT voltage pattern (Zeta)
        - V_DC_X: Alternative naming

        Args:
            df: DataFrame to search
            inverter_id: Inverter identifier (e.g., "INV 01.001")
            patterns: Optional dict with custom patterns

        Returns:
            List of voltage column names found
        """
        import re
        voltage_cols = []

        # Escape special chars in inverter_id for regex
        inv_escaped = re.escape(inverter_id)

        # Standard patterns to check
        check_patterns = [
            # U_DC_X - e.g., "Plant: INV 01.001 / U_DC_1 (V)"
            rf".*{inv_escaped}.*U_DC_\d+.*",
            # U_MPPT_X - e.g., "Plant: INV 01.001 / U_MPPT_1 (V)"
            rf".*{inv_escaped}.*U_MPPT_\d+.*",
            # V_DC_X - alternative
            rf".*{inv_escaped}.*V_DC_\d+.*",
            # U_DC without number suffix (single channel plants like Epsilon)
            rf".*{inv_escaped}.*/\s*U_DC\s*\(.*",
        ]

        for col in df.columns:
            for pattern in check_patterns:
                if re.match(pattern, col, re.IGNORECASE):
                    voltage_cols.append(col)
                    break

        # Sort by channel number
        def extract_channel(col_name: str) -> int:
            match = re.search(r'(\d+)\s*(?:\([^)]*\))?$', col_name)
            return int(match.group(1)) if match else 0

        voltage_cols.sort(key=extract_channel)

        return voltage_cols

    def train(
        self,
        df: pl.DataFrame,
        voltage_cols: List[str],
        irradiance_col: str = "irradiance",
        temp_col: str = "module_temp",
        validation_split: float = 0.2,
        verbose: bool = True,
    ) -> TwinMetrics:
        """
        Train the DC voltage twin.

        Args:
            df: Training data
            voltage_cols: List of DC voltage column names
            irradiance_col: Irradiance column
            temp_col: Temperature column
            validation_split: Fraction for validation
            verbose: Print progress

        Returns:
            TwinMetrics
        """
        import time
        start_time = time.time()

        # Calculate CV
        df_cv = self.calculate_cv(df, voltage_cols)

        df_prepared = self._prepare_features(df_cv, irradiance_col, temp_col)

        if df_prepared is None or len(df_prepared) == 0:
            raise ValueError("No valid training data")

        # Note: Polars NaN comparison returns True (NaN > 10 = True), so we must
        # explicitly filter out NaN values using is_not_nan()
        feature_cols = [c for c in self.FEATURE_COLS if c in df_prepared.columns]
        valid_mask = (
            pl.all_horizontal([pl.col(c).is_not_null() for c in feature_cols]) &
            (pl.col("irradiance") > 50) &
            (pl.col("voltage_mean") > 10) &
            pl.col("voltage_mean").is_not_nan()
        )
        df_valid = df_prepared.filter(valid_mask)

        if len(df_valid) < 100:
            raise ValueError(f"Insufficient training data: {len(df_valid)} rows")

        # Physics baseline
        irradiance = df_valid["irradiance"].to_numpy()
        temp = df_valid["module_temp"].to_numpy() if "module_temp" in df_valid.columns else df_valid["ambient_temp"].to_numpy() + 20

        physics_pred = self._calculate_physics_baseline(irradiance, temp)
        actual = df_valid["voltage_mean"].to_numpy()

        physics_residual = actual - physics_pred
        physics_mae = float(np.mean(np.abs(physics_residual)))

        self._mean_voltage = float(np.mean(actual))

        if verbose:
            print(f"Physics baseline MAE: {physics_mae:.2f} V")

        # Train ML on residual
        X = df_valid.select(feature_cols).to_numpy()
        y = physics_residual

        n_val = int(len(X) * validation_split)
        X_train, X_val = X[:-n_val], X[-n_val:]
        y_train, y_val = y[:-n_val], y[-n_val:]

        try:
            from catboost import CatBoostRegressor

            self.model = CatBoostRegressor(
                iterations=300,
                learning_rate=0.05,
                depth=5,
                loss_function="RMSE",
                verbose=False,
                early_stopping_rounds=30,
                random_seed=42,
            )
            self.model.fit(X_train, y_train, eval_set=(X_val, y_val), verbose=verbose)

        except ImportError:
            from sklearn.ensemble import GradientBoostingRegressor

            self.model = GradientBoostingRegressor(
                n_estimators=100, learning_rate=0.1, max_depth=4, random_state=42
            )
            self.model.fit(X_train, y_train)

        # Metrics
        y_pred = self.model.predict(X_val)
        mae = float(np.mean(np.abs(y_val - y_pred)))
        rmse = float(np.sqrt(np.mean((y_val - y_pred) ** 2)))

        ss_res = np.sum((y_val - y_pred) ** 2)
        ss_tot = np.sum((y_val - np.mean(y_val)) ** 2)
        r2 = float(1 - (ss_res / ss_tot)) if ss_tot > 0 else 0

        improvement_pct = ((physics_mae - mae) / physics_mae * 100) if physics_mae > 0 else 0

        self.training_metrics = TwinMetrics(
            mae=mae,
            rmse=rmse,
            r2=r2,
            n_samples=len(X_train),
            physics_mae=physics_mae,
            improvement_over_physics_pct=improvement_pct,
            training_time_s=time.time() - start_time,
        )

        self._is_trained = True
        self._feature_cols = feature_cols

        if verbose:
            print(f"DC Voltage Twin trained: MAE={mae:.2f} V, R²={r2:.3f}")

        return self.training_metrics

    def predict(
        self,
        df: pl.DataFrame,
        voltage_cols: Optional[List[str]] = None,
        irradiance_col: str = "irradiance",
        temp_col: str = "module_temp",
    ) -> pl.DataFrame:
        """
        Predict expected DC voltages and calculate CV and loss percentage.

        Args:
            df: Input data
            voltage_cols: Voltage column names (for CV calculation)
            irradiance_col: Irradiance column
            temp_col: Temperature column

        Returns:
            DataFrame with V_expected, voltage_cv, voltage_deviation, voltage_loss_pct
        """
        if not self._is_trained:
            raise RuntimeError("Model not trained. Call train() first.")

        df_prepared = self._prepare_features(df, irradiance_col, temp_col)

        if df_prepared is None:
            return df

        feature_cols = [c for c in self._feature_cols if c in df_prepared.columns]
        X = df_prepared.select(feature_cols).to_numpy()

        valid_mask = np.all(~np.isnan(X), axis=1)
        ml_pred = np.full(len(X), np.nan)

        if np.any(valid_mask):
            ml_pred[valid_mask] = self.model.predict(X[valid_mask])

        irradiance = df_prepared["irradiance"].to_numpy()
        temp = df_prepared["module_temp"].to_numpy() if "module_temp" in df_prepared.columns else df_prepared["ambient_temp"].to_numpy() + 20

        physics_pred = self._calculate_physics_baseline(irradiance, temp)
        v_expected = np.clip(physics_pred + ml_pred, 0, None)

        df_result = df_prepared.with_columns([
            pl.Series("V_expected", v_expected),
        ])

        # Calculate CV and loss % if voltage columns provided
        if voltage_cols:
            df_result = self.calculate_cv(df_result, voltage_cols, v_expected=v_expected)

        # Calculate voltage deviation if actual available
        if "voltage_mean" in df_result.columns:
            df_result = df_result.with_columns([
                (pl.col("voltage_mean") - pl.col("V_expected")).alias("voltage_deviation"),
            ])

        return df_result

    def _prepare_features(
        self,
        df: pl.DataFrame,
        irradiance_col: str,
        temp_col: str,
    ) -> Optional[pl.DataFrame]:
        """Prepare feature columns."""
        result = df.clone()

        if irradiance_col != "irradiance" and irradiance_col in df.columns:
            result = result.with_columns(pl.col(irradiance_col).alias("irradiance"))

        if temp_col != "module_temp" and temp_col in df.columns:
            result = result.with_columns(pl.col(temp_col).alias("module_temp"))
        elif "ambient_temp" in df.columns and "module_temp" not in result.columns:
            result = result.with_columns(
                (pl.col("ambient_temp") + 20).alias("module_temp")
            )

        if "irradiance" not in result.columns:
            logger.warning("Missing irradiance column")
            return None

        ts_col = None
        for col in ["timestamp", "datetime", "time"]:
            if col in result.columns:
                ts_col = col
                break

        if ts_col:
            try:
                # Convert string timestamp to datetime if needed
                col_dtype = result[ts_col].dtype
                if col_dtype == pl.Utf8 or col_dtype == pl.String:
                    # Handle various date formats: "2022.01.01 00:00" or "2022-01-01 00:00"
                    result = result.with_columns(
                        pl.col(ts_col)
                        .str.replace_all(r"\.", "-")  # Convert dots to dashes
                        .str.to_datetime(format="%Y-%m-%d %H:%M", strict=False)
                        .alias(ts_col)
                    )

                if "hour_of_day" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.hour().alias("hour_of_day")
                    )
                if "day_of_year" not in result.columns:
                    result = result.with_columns(
                        pl.col(ts_col).dt.ordinal_day().alias("day_of_year")
                    )
            except Exception as e:
                logger.warning(f"Failed to extract temporal features: {e}")

        return result

    def save(self, path: Union[str, Path]) -> None:
        """Save trained model."""
        if not self._is_trained:
            raise RuntimeError("Cannot save untrained model")

        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        save_data = {
            "model": self.model,
            "inverter_id": self.inverter_id,
            "n_channels": self.n_channels,
            "v_oc_ref": self.v_oc_ref,
            "beta_voc": self.beta_voc,
            "mean_voltage": self._mean_voltage,
            "training_metrics": self.training_metrics,
            "feature_cols": self._feature_cols,
            "version": "1.0",
        }

        with open(path, "wb") as f:
            pickle.dump(save_data, f)

    @classmethod
    def load(cls, path: Union[str, Path]) -> "DCVoltageTwin":
        """Load trained model."""
        with open(path, "rb") as f:
            data = pickle.load(f)

        twin = cls(
            inverter_id=data["inverter_id"],
            n_channels=data.get("n_channels", 12),
            v_oc_ref=data.get("v_oc_ref", 600.0),
            beta_voc=data.get("beta_voc", -0.003),
        )
        twin.model = data["model"]
        twin.training_metrics = data.get("training_metrics")
        twin._feature_cols = data.get("feature_cols", cls.FEATURE_COLS)
        twin._mean_voltage = data.get("mean_voltage", 0.0)
        twin._is_trained = True

        return twin


class MultiSignalTwinFactory:
    """
    Factory for creating and running multi-signal digital twins.

    Coordinates temperature, current, and voltage twins for an inverter.

    Usage:
        factory = MultiSignalTwinFactory(inverter_id="INV 01.001", config=plant_config)
        factory.train(df_training)
        outputs = factory.predict(df_new)

        # Get features for soiling ML
        features = factory.get_soiling_features(outputs)
        # Returns: {"current_cv": ..., "temp_deviation": ..., "voltage_cv": ...}
    """

    def __init__(
        self,
        inverter_id: str,
        config: Optional[Dict[str, Any]] = None,
        n_dc_channels: int = 12,
        p_rated: Optional[float] = None,
        filter_config: Optional[FilterConfig] = None,
        use_normal_filter: bool = True,
    ):
        """
        Initialize factory.

        Args:
            inverter_id: Inverter identifier
            config: Plant configuration dict
            n_dc_channels: Number of DC channels
            p_rated: Rated power capacity (kW) for PR-based filtering
            filter_config: Configuration for normal data filtering
            use_normal_filter: Whether to apply multi-stage filtering before training
        """
        self.inverter_id = inverter_id
        self.config = config or {}
        self.n_dc_channels = n_dc_channels
        self.p_rated = p_rated
        self.use_normal_filter = use_normal_filter

        # Initialize normal data filter for unified training data selection
        self.data_filter = NormalDataFilter(
            config=filter_config or FilterConfig(),
            p_rated=p_rated,
        )

        # Initialize twins
        self.temp_twin = InverterTemperatureTwin(inverter_id)
        self.current_twin = DCCurrentTwin(inverter_id, n_channels=n_dc_channels)
        self.voltage_twin = DCVoltageTwin(inverter_id, n_channels=n_dc_channels)

        self._is_trained = False
        self._filter_result: Optional[FilterResult] = None

    def _filter_training_data(
        self,
        df: pl.DataFrame,
        power_col: str = "power_normalized",
        irradiance_col: str = "irradiance",
        temperature_col: Optional[str] = "ambient_temp",
        apply_variability: bool = True,
        apply_clustering: bool = False,  # Disabled by default for speed
    ) -> tuple[pl.DataFrame, FilterResult]:
        """
        Apply unified multi-stage filtering for training data selection.

        Uses NormalDataFilter to ensure all twins train on the same clean dataset.
        This filters out:
        - Nighttime / low irradiance data
        - Periods with abnormal PR (faults, shading)
        - High variability periods (cloud transients)
        - Iterative outliers
        - Clustering-based anomalies (optional)

        Args:
            df: Input Polars DataFrame
            power_col: Power column name (for PR-based filtering)
            irradiance_col: Irradiance column name
            temperature_col: Temperature column name (optional)
            apply_variability: Whether to apply variability filter
            apply_clustering: Whether to apply clustering filter (slower)

        Returns:
            Tuple of (filtered Polars DataFrame, FilterResult with statistics)
        """
        if not self.use_normal_filter:
            # Return all data with dummy result
            dummy_result = FilterResult(
                mask=np.ones(len(df), dtype=bool),
                n_original=len(df),
                n_filtered=len(df),
                retention_ratio=1.0,
                method_stats={"skipped": True},
            )
            return df, dummy_result

        # Check for required columns
        required_cols = [irradiance_col]
        if power_col and power_col in df.columns:
            required_cols.append(power_col)
        else:
            # No power column - use simpler filtering
            logger.info("No power column found, using physics-only filtering")

        # Convert Polars to Pandas for NormalDataFilter
        # Select only necessary columns to reduce memory
        cols_to_select = list(df.columns)
        df_pd = df.to_pandas()

        # Ensure datetime index for rolling operations
        ts_col = None
        for col in ["timestamp", "datetime", "time"]:
            if col in df_pd.columns:
                ts_col = col
                break

        if ts_col:
            df_pd = df_pd.set_index(ts_col)
            if not isinstance(df_pd.index, pd.DatetimeIndex):
                try:
                    df_pd.index = pd.to_datetime(df_pd.index)
                except Exception as e:
                    logger.warning(f"Could not convert index to datetime: {e}")

        # Apply unified filtering
        try:
            filter_result = self.data_filter.select_normal_training_data(
                df=df_pd,
                irradiance_col=irradiance_col,
                power_col=power_col if power_col in df_pd.columns else None,
                temperature_col=temperature_col if temperature_col and temperature_col in df_pd.columns else None,
                apply_variability=apply_variability,
                apply_clustering=apply_clustering,
            )

            # Store result
            self._filter_result = filter_result

            # Log filtering statistics
            logger.info(
                f"Normal data filtering for {self.inverter_id}: "
                f"{filter_result.n_filtered}/{filter_result.n_original} samples kept "
                f"({filter_result.retention_ratio:.1%})"
            )

            # Apply mask to get filtered data
            mask = filter_result.mask

            # Convert back to Polars DataFrame
            if ts_col:
                df_pd = df_pd.reset_index()

            df_filtered_pd = df_pd[mask]
            df_filtered = pl.from_pandas(df_filtered_pd)

            return df_filtered, filter_result

        except Exception as e:
            logger.warning(f"Normal data filtering failed: {e}. Using all data.")
            dummy_result = FilterResult(
                mask=np.ones(len(df), dtype=bool),
                n_original=len(df),
                n_filtered=len(df),
                retention_ratio=1.0,
                method_stats={"error": str(e)},
            )
            return df, dummy_result

    @property
    def filter_result(self) -> Optional[FilterResult]:
        """Get the filtering result from training."""
        return self._filter_result

    def train(
        self,
        df: pl.DataFrame,
        temp_col: str = "inverter_temp",
        current_cols: Optional[List[str]] = None,
        voltage_cols: Optional[List[str]] = None,
        power_col: Optional[str] = "power_normalized",
        irradiance_col: str = "irradiance",
        ambient_temp_col: str = "ambient_temp",
        apply_variability_filter: bool = True,
        apply_clustering_filter: bool = False,
        verbose: bool = True,
    ) -> Dict[str, TwinMetrics]:
        """
        Train all twins sequentially on filtered training data.

        Applies unified multi-stage filtering (NormalDataFilter) to ensure
        all twins train on the same clean, fault-free dataset. This removes:
        - Nighttime / low irradiance data
        - Periods with abnormal PR (faults, shading)
        - High variability periods (cloud transients)
        - Iterative outliers
        - Clustering-based anomalies (optional)

        Args:
            df: Training data
            temp_col: Inverter temperature column
            current_cols: DC current column names
            voltage_cols: DC voltage column names
            power_col: Power column for PR-based filtering (optional)
            irradiance_col: Irradiance column
            ambient_temp_col: Ambient temperature column
            apply_variability_filter: Apply variability filtering
            apply_clustering_filter: Apply clustering filter (slower)
            verbose: Print progress

        Returns:
            Dict of training metrics for each twin, plus "filter" entry with
            filtering statistics
        """
        metrics = {}

        # Step 1: Apply unified multi-stage filtering for training data selection
        if verbose:
            print(f"\n=== Filtering Training Data for {self.inverter_id} ===")

        df_filtered, filter_result = self._filter_training_data(
            df=df,
            power_col=power_col,
            irradiance_col=irradiance_col,
            temperature_col=ambient_temp_col,
            apply_variability=apply_variability_filter,
            apply_clustering=apply_clustering_filter,
        )

        # Store filtering stats in metrics
        metrics["filter"] = {
            "n_original": filter_result.n_original,
            "n_filtered": filter_result.n_filtered,
            "retention_ratio": filter_result.retention_ratio,
            "method_stats": filter_result.method_stats,
        }

        if verbose:
            print(f"Training data: {filter_result.n_filtered}/{filter_result.n_original} samples "
                  f"({filter_result.retention_ratio:.1%} retained)")

        # Check minimum samples
        if filter_result.n_filtered < 100:
            logger.warning(f"Insufficient training samples after filtering: {filter_result.n_filtered}")
            if filter_result.n_original >= 100:
                logger.warning("Falling back to unfiltered data")
                df_filtered = df

        # Step 2: Train all twins on the same filtered dataset
        # Train temperature twin
        if temp_col in df_filtered.columns:
            if verbose:
                print(f"\n--- Training Temperature Twin for {self.inverter_id} ---")
            try:
                metrics["temperature"] = self.temp_twin.train(
                    df_filtered,
                    target_col=temp_col,
                    irradiance_col=irradiance_col,
                    ambient_temp_col=ambient_temp_col,
                    power_col=power_col,  # Power feature improves inverter temp prediction
                    verbose=verbose,
                )
            except Exception as e:
                logger.warning(f"Failed to train temperature twin: {e}")

        # Determine best temperature column for DC twins
        # Prefer module_temp if it has sufficient data, otherwise use ambient_temp
        dc_temp_col = ambient_temp_col
        if "module_temp" in df_filtered.columns:
            module_temp_valid = df_filtered["module_temp"].drop_nulls().len()
            if module_temp_valid > len(df_filtered) * 0.1:  # At least 10% non-null
                dc_temp_col = "module_temp"
            else:
                logger.info(f"module_temp has only {module_temp_valid}/{len(df_filtered)} valid values, using {ambient_temp_col} for DC twins")

        # Train current twin
        if current_cols:
            valid_cols = [c for c in current_cols if c in df_filtered.columns]
            if valid_cols:
                if verbose:
                    print(f"\n--- Training DC Current Twin for {self.inverter_id} ---")
                try:
                    metrics["current"] = self.current_twin.train(
                        df_filtered,
                        current_cols=valid_cols,
                        irradiance_col=irradiance_col,
                        temp_col=dc_temp_col,
                        verbose=verbose,
                    )
                except Exception as e:
                    logger.warning(f"Failed to train current twin: {e}")

        # Train voltage twin
        if voltage_cols:
            valid_cols = [c for c in voltage_cols if c in df_filtered.columns]
            if valid_cols:
                if verbose:
                    print(f"\n--- Training DC Voltage Twin for {self.inverter_id} ---")
                try:
                    metrics["voltage"] = self.voltage_twin.train(
                        df_filtered,
                        voltage_cols=valid_cols,
                        irradiance_col=irradiance_col,
                        temp_col=dc_temp_col,
                        verbose=verbose,
                    )
                except Exception as e:
                    logger.warning(f"Failed to train voltage twin: {e}")

        # Count successful twin trainings (exclude "filter" key)
        twin_metrics = {k: v for k, v in metrics.items() if k != "filter"}
        self._is_trained = len(twin_metrics) > 0

        return metrics

    def predict(
        self,
        df: pl.DataFrame,
        temp_col: str = "inverter_temp",
        current_cols: Optional[List[str]] = None,
        voltage_cols: Optional[List[str]] = None,
        power_col: Optional[str] = None,
        irradiance_col: str = "irradiance",
        ambient_temp_col: str = "ambient_temp",
        auto_detect_columns: bool = True,
    ) -> pl.DataFrame:
        """
        Run all twins and return combined outputs with loss percentages.

        Args:
            df: Input data
            temp_col: Inverter temperature column
            current_cols: DC current columns (auto-detected if None and auto_detect_columns=True)
            voltage_cols: DC voltage columns (auto-detected if None and auto_detect_columns=True)
            power_col: Power column for power loss calculation (optional)
            irradiance_col: Irradiance column
            ambient_temp_col: Ambient temperature column
            auto_detect_columns: Auto-detect current/voltage columns if not provided

        Returns:
            DataFrame with twin outputs:
                - T_expected, temp_deviation
                - current_cv, current_imbalance_ratio, I_expected, current_loss_pct
                - voltage_cv, voltage_deviation, V_expected, voltage_loss_pct
                - power_loss_pct (if power_col provided)
        """
        result = df.clone()

        # Auto-detect current/voltage columns if not provided
        if auto_detect_columns and current_cols is None:
            current_cols = DCCurrentTwin.detect_current_columns(df, self.inverter_id)
            if current_cols:
                logger.info(f"Auto-detected {len(current_cols)} current columns for {self.inverter_id}")

        if auto_detect_columns and voltage_cols is None:
            voltage_cols = DCVoltageTwin.detect_voltage_columns(df, self.inverter_id)
            if voltage_cols:
                logger.info(f"Auto-detected {len(voltage_cols)} voltage columns for {self.inverter_id}")

        # Temperature predictions
        if self.temp_twin._is_trained:
            try:
                temp_result = self.temp_twin.predict(
                    result,
                    actual_temp_col=temp_col,
                    irradiance_col=irradiance_col,
                    ambient_temp_col=ambient_temp_col,
                )
                # Copy new columns
                for col in ["T_expected", "temp_deviation"]:
                    if col in temp_result.columns:
                        result = result.with_columns(temp_result[col])
            except Exception as e:
                logger.warning(f"Temperature prediction failed: {e}")

        # Current predictions (with loss %)
        if self.current_twin._is_trained:
            try:
                current_result = self.current_twin.predict(
                    result,
                    current_cols=current_cols,
                    irradiance_col=irradiance_col,
                    temp_col="module_temp" if "module_temp" in result.columns else ambient_temp_col,
                )
                for col in ["current_cv", "current_imbalance_ratio", "current_mean",
                           "current_total", "I_expected", "current_loss_pct"]:
                    if col in current_result.columns:
                        result = result.with_columns(current_result[col])
            except Exception as e:
                logger.warning(f"Current prediction failed: {e}")

        # Voltage predictions (with loss %)
        if self.voltage_twin._is_trained:
            try:
                voltage_result = self.voltage_twin.predict(
                    result,
                    voltage_cols=voltage_cols,
                    irradiance_col=irradiance_col,
                    temp_col="module_temp" if "module_temp" in result.columns else ambient_temp_col,
                )
                for col in ["voltage_cv", "voltage_deviation", "voltage_mean",
                           "V_expected", "voltage_loss_pct"]:
                    if col in voltage_result.columns:
                        result = result.with_columns(voltage_result[col])
            except Exception as e:
                logger.warning(f"Voltage prediction failed: {e}")

        # Power loss calculation (if power column provided)
        if power_col:
            try:
                result = self.calculate_power_loss(
                    result,
                    power_col=power_col,
                    irradiance_col=irradiance_col,
                    temp_col="module_temp" if "module_temp" in result.columns else ambient_temp_col,
                )
            except Exception as e:
                logger.warning(f"Power loss calculation failed: {e}")

        return result

    def get_soiling_features(self, df: pl.DataFrame) -> Dict[str, np.ndarray]:
        """
        Extract features for soiling ML models.

        Args:
            df: DataFrame with twin outputs

        Returns:
            Dict with feature arrays:
                - current_cv: DC current coefficient of variation
                - temp_deviation: Temperature deviation from expected
                - voltage_cv: DC voltage coefficient of variation
                - current_imbalance_ratio: Max/min current ratio
                - current_loss_pct: Current loss as percentage
                - voltage_loss_pct: Voltage loss as percentage
                - power_loss_pct: Estimated power loss as percentage
        """
        features = {}

        # Uniformity features
        if "current_cv" in df.columns:
            features["current_cv"] = df["current_cv"].to_numpy()

        if "temp_deviation" in df.columns:
            features["temp_deviation"] = df["temp_deviation"].to_numpy()

        if "voltage_cv" in df.columns:
            features["voltage_cv"] = df["voltage_cv"].to_numpy()

        if "current_imbalance_ratio" in df.columns:
            features["current_imbalance_ratio"] = df["current_imbalance_ratio"].to_numpy()

        # Loss percentage features (portable across plants)
        if "current_loss_pct" in df.columns:
            features["current_loss_pct"] = df["current_loss_pct"].to_numpy()

        if "voltage_loss_pct" in df.columns:
            features["voltage_loss_pct"] = df["voltage_loss_pct"].to_numpy()

        if "power_loss_pct" in df.columns:
            features["power_loss_pct"] = df["power_loss_pct"].to_numpy()

        return features

    def calculate_power_loss(
        self,
        df: pl.DataFrame,
        power_col: str = "power_normalized",
        irradiance_col: str = "irradiance",
        temp_col: str = "module_temp",
    ) -> pl.DataFrame:
        """
        Calculate power loss percentage from expected power.

        Power loss % = (P_expected - P_actual) / P_expected * 100

        Uses a simple physics model:
        P_expected = G / 1000 * (1 + gamma * (T - 25))

        Where gamma is typically -0.004 for crystalline silicon.

        Args:
            df: DataFrame with power and environmental data
            power_col: Actual power column (normalized 0-1 preferred)
            irradiance_col: Irradiance column
            temp_col: Temperature column

        Returns:
            DataFrame with power_loss_pct column
        """
        if power_col not in df.columns:
            logger.warning(f"Power column '{power_col}' not found")
            return df

        if irradiance_col not in df.columns:
            logger.warning(f"Irradiance column '{irradiance_col}' not found")
            return df

        # Get arrays
        power_actual = df[power_col].to_numpy()
        irradiance = df[irradiance_col].to_numpy()

        # Temperature (use module temp or estimate from ambient)
        if temp_col in df.columns:
            temp = df[temp_col].to_numpy()
        elif "ambient_temp" in df.columns:
            temp = df["ambient_temp"].to_numpy() + 20  # Estimate module temp
        else:
            temp = np.full(len(df), 45)  # Default

        # Physics model for expected power (normalized 0-1)
        gamma = -0.004  # Temperature coefficient for power
        power_expected = (irradiance / 1000) * (1 + gamma * (temp - 25))
        power_expected = np.clip(power_expected, 0, 1.2)  # Reasonable bounds

        # Calculate loss percentage
        with np.errstate(divide='ignore', invalid='ignore'):
            power_loss_pct = np.where(
                power_expected > 0.05,
                (power_expected - power_actual) / power_expected * 100,
                np.nan
            )

        return df.with_columns([
            pl.Series("power_loss_pct", power_loss_pct),
            pl.Series("P_expected", power_expected),
        ])

    def save(self, base_path: Union[str, Path]) -> None:
        """Save all twins and factory metadata to directory."""
        base_path = Path(base_path)
        base_path.mkdir(parents=True, exist_ok=True)

        # Save factory metadata
        metadata = {
            "inverter_id": self.inverter_id,
            "n_dc_channels": self.n_dc_channels,
            "p_rated": self.p_rated,
            "use_normal_filter": self.use_normal_filter,
            "filter_config": {
                "min_irradiance": self.data_filter.config.min_irradiance,
                "power_margin": self.data_filter.config.power_margin,
                "pr_min": self.data_filter.config.pr_min,
                "pr_max": self.data_filter.config.pr_max,
                "pr_sigma": self.data_filter.config.pr_sigma,
            } if self.data_filter else None,
            "filter_result": {
                "n_original": self._filter_result.n_original,
                "n_filtered": self._filter_result.n_filtered,
                "retention_ratio": self._filter_result.retention_ratio,
                "method_stats": self._filter_result.method_stats,
            } if self._filter_result else None,
            "version": "2.0",  # Version bump for NormalDataFilter integration
        }

        with open(base_path / f"{self.inverter_id}_factory_meta.pkl", "wb") as f:
            pickle.dump(metadata, f)

        # Save individual twins
        if self.temp_twin._is_trained:
            self.temp_twin.save(base_path / f"{self.inverter_id}_temp_twin.pkl")

        if self.current_twin._is_trained:
            self.current_twin.save(base_path / f"{self.inverter_id}_current_twin.pkl")

        if self.voltage_twin._is_trained:
            self.voltage_twin.save(base_path / f"{self.inverter_id}_voltage_twin.pkl")

    @classmethod
    def load(
        cls,
        base_path: Union[str, Path],
        inverter_id: str,
        p_rated: Optional[float] = None,
    ) -> "MultiSignalTwinFactory":
        """Load all twins and factory metadata from directory."""
        base_path = Path(base_path)

        # Try to load metadata
        meta_path = base_path / f"{inverter_id}_factory_meta.pkl"
        if meta_path.exists():
            with open(meta_path, "rb") as f:
                metadata = pickle.load(f)
            n_dc_channels = metadata.get("n_dc_channels", 12)
            p_rated = metadata.get("p_rated") or p_rated
            use_normal_filter = metadata.get("use_normal_filter", True)

            # Restore filter config if available
            filter_config_dict = metadata.get("filter_config")
            if filter_config_dict:
                filter_config = FilterConfig(**filter_config_dict)
            else:
                filter_config = None
        else:
            n_dc_channels = 12
            use_normal_filter = True
            filter_config = None

        factory = cls(
            inverter_id=inverter_id,
            n_dc_channels=n_dc_channels,
            p_rated=p_rated,
            filter_config=filter_config,
            use_normal_filter=use_normal_filter,
        )

        # Load individual twins
        temp_path = base_path / f"{inverter_id}_temp_twin.pkl"
        if temp_path.exists():
            factory.temp_twin = InverterTemperatureTwin.load(temp_path)

        current_path = base_path / f"{inverter_id}_current_twin.pkl"
        if current_path.exists():
            factory.current_twin = DCCurrentTwin.load(current_path)

        voltage_path = base_path / f"{inverter_id}_voltage_twin.pkl"
        if voltage_path.exists():
            factory.voltage_twin = DCVoltageTwin.load(voltage_path)

        factory._is_trained = any([
            factory.temp_twin._is_trained,
            factory.current_twin._is_trained,
            factory.voltage_twin._is_trained,
        ])

        return factory
