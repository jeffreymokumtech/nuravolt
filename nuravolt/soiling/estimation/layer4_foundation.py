"""
Layer 4: Foundation Model-based SR Estimation.

This layer uses a global model trained on ALL DustIQ-equipped plants
to provide baseline predictions for plants without nearby reference data.

Key features:
- Conservative bias: Prefers to overpredict soiling (safer for cleaning decisions)
- Location-invariant features: Uses relative environmental indicators
- Asymmetric loss: Penalizes underprediction 3x more than overprediction
- Post-hoc rain anchor calibration: Uses local rain events to ground predictions (NEW)
- Fleet CV features: Uniformity indicator for soiling vs fault detection (NEW)
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Optional, List

import numpy as np
import pandas as pd

from .base import (
    EstimationLayer,
    MethodAvailability,
    SREstimationResult,
    SREstimator,
    LAYER_CONFIDENCE,
)
from .layer1_dustiq import DEFAULT_DATA_DIR
from .calibration import (
    RainAnchorConfig,
    calibrate_with_rain_anchors,
    add_fleet_cv_to_features,
    FleetCVConfig,
)


# Import existing foundation model
try:
    from ..sr_foundation_model import SoilingFoundationModel, FoundationModelConfig
    FOUNDATION_MODEL_AVAILABLE = True
except ImportError:
    FOUNDATION_MODEL_AVAILABLE = False


# Minimum data requirements
MIN_WEATHER_DAYS = 14
MIN_AOD_DAYS = 7


class FoundationModelEstimator(SREstimator):
    """Layer 4: Global foundation model trained on all DustIQ plants.

    This estimator:
    1. Loads or trains a global foundation model
    2. Generates location-invariant features
    3. Applies conservative bias for safe predictions

    Attributes
    ----------
    data_dir : Path
        Directory containing plant soiling data
    model_dir : Path
        Directory for storing the foundation model
    conservative_bias : float
        Safety margin (0.02 = predict 2% dirtier)
    """

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        model_dir: Optional[Path] = None,
        conservative_bias: float = 0.02,
        enable_rain_calibration: bool = True,
        enable_fleet_cv: bool = True,
        rain_calibration_method: str = 'blend',
        rain_config: Optional[RainAnchorConfig] = None,
        fleet_cv_config: Optional[FleetCVConfig] = None,
    ):
        """Initialize Foundation Model estimator.

        Parameters
        ----------
        data_dir : Path, optional
            Directory containing plant soiling data.
        model_dir : Path, optional
            Directory for the foundation model.
        conservative_bias : float
            Safety margin to subtract from predictions (default 2%)
        enable_rain_calibration : bool
            Whether to apply post-hoc rain anchor calibration (default: True)
        enable_fleet_cv : bool
            Whether to include fleet CV in features (default: True)
        rain_calibration_method : str
            Rain calibration method: 'constrain', 'blend', or 'forward_simulate'
            Default 'blend' for foundation model (less aggressive than transfer)
        rain_config : RainAnchorConfig, optional
            Configuration for rain anchor calibration
        fleet_cv_config : FleetCVConfig, optional
            Configuration for fleet CV feature extraction
        """
        if not FOUNDATION_MODEL_AVAILABLE:
            raise ImportError("Foundation model not available. Check sr_foundation_model.py imports.")

        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self.model_dir = Path(model_dir) if model_dir else Path("backenddata/models/foundation")
        self.model_dir.mkdir(parents=True, exist_ok=True)

        self.conservative_bias = conservative_bias
        self._model = None
        self._feature_cache = {}

        # Calibration settings
        self.enable_rain_calibration = enable_rain_calibration
        self.enable_fleet_cv = enable_fleet_cv
        self.rain_calibration_method = rain_calibration_method
        self.rain_config = rain_config or RainAnchorConfig()
        self.fleet_cv_config = fleet_cv_config or FleetCVConfig()

    @property
    def layer(self) -> EstimationLayer:
        return EstimationLayer.FOUNDATION

    @property
    def method_name(self) -> str:
        return "foundation_model"

    def _load_weather_data(self, plant_id: str) -> Optional[pd.DataFrame]:
        """Load weather data for a plant."""
        weather_path = self.data_dir / plant_id / "weather_extended.json"
        if not weather_path.exists():
            return None

        try:
            with open(weather_path) as f:
                data = json.load(f)
            df = pd.DataFrame(data.get("daily_data", []))
            if len(df) == 0:
                return None
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()
            return df
        except Exception:
            return None

    def _load_aod_data(self, plant_id: str) -> Optional[pd.DataFrame]:
        """Load AOD data for a plant."""
        aod_path = self.data_dir / plant_id / "aod_history.json"
        if not aod_path.exists():
            return None

        try:
            with open(aod_path) as f:
                data = json.load(f)
            df = pd.DataFrame(data.get("daily_data", []))
            if len(df) == 0:
                return None
            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()
            return df
        except Exception:
            return None

    def _load_rain_data(self, plant_id: str) -> Optional[pd.DataFrame]:
        """Load rain history data for a plant.

        Tries multiple sources:
        1. rain_history.json (dedicated rain file)
        2. weather_extended.json (precipitation column)

        Returns
        -------
        pd.DataFrame or None
            Rain data with precipitation column
        """
        # Try rain_history.json first
        rain_path = self.data_dir / plant_id / "rain_history.json"
        if rain_path.exists():
            try:
                with open(rain_path) as f:
                    data = json.load(f)
                df = pd.DataFrame(data.get("daily_data", []))
                if len(df) > 0 and "date" in df.columns:
                    df["date"] = pd.to_datetime(df["date"])
                    df = df.set_index("date").sort_index()
                    return df
            except Exception:
                pass

        # Fall back to weather_extended.json
        df_weather = self._load_weather_data(plant_id)
        if df_weather is not None:
            for col in ["precipitation_mm", "rainfall_mm", "rain_mm", "precip", "precipitation"]:
                if col in df_weather.columns:
                    # Return as DataFrame with consistent column name
                    return pd.DataFrame({"precipitation_mm": df_weather[col].fillna(0)})

        return None

    def _generate_foundation_features(
        self,
        plant_id: str,
        df_weather: pd.DataFrame,
        df_aod: Optional[pd.DataFrame],
    ) -> pd.DataFrame:
        """Generate location-invariant features for foundation model.

        These features are designed to work across any plant globally.
        """
        features = pd.DataFrame(index=df_weather.index)

        # --- Rainfall features ---
        precip = df_weather.get("precipitation_mm", pd.Series(0, index=df_weather.index))
        precip = precip.fillna(0)

        features["rainfall_7d"] = precip.rolling(7, min_periods=1).sum()
        features["rainfall_14d"] = precip.rolling(14, min_periods=1).sum()
        features["rainfall_30d"] = precip.rolling(30, min_periods=1).sum()

        # Days since rain
        is_rain = (precip > 1.0).astype(int)
        features["days_since_rain"] = self._days_since_event(is_rain, max_days=30)

        # Heavy rain indicator
        features["is_heavy_rain"] = (precip > 10.0).astype(int)

        # --- Temperature features ---
        if "temperature_mean" in df_weather.columns:
            temp = df_weather["temperature_mean"].fillna(20)
            features["temperature_mean"] = temp
            features["temperature_7d"] = temp.rolling(7, min_periods=1).mean()

        # --- Humidity features ---
        if "relative_humidity_mean" in df_weather.columns:
            hum = df_weather["relative_humidity_mean"].fillna(50)
            features["humidity_mean"] = hum
            features["humidity_7d"] = hum.rolling(7, min_periods=1).mean()
            features["is_high_humidity"] = (hum > 70).astype(int)

        # --- Wind features ---
        if "wind_speed_mean" in df_weather.columns:
            wind = df_weather["wind_speed_mean"].fillna(0)
            features["wind_speed_mean"] = wind
            features["wind_speed_7d"] = wind.rolling(7, min_periods=1).mean()
            features["is_high_wind"] = (wind > 25).astype(int)

        # --- AOD features ---
        if df_aod is not None and len(df_aod) > 0:
            aod = df_aod.get("aod_550nm", pd.Series(0.15, index=df_aod.index))
            aod = aod.reindex(df_weather.index).fillna(0.15)
            features["aod_mean"] = aod
            features["aod_mean_7d"] = aod.rolling(7, min_periods=1).mean()
            features["aod_mean_14d"] = aod.rolling(14, min_periods=1).mean()
            features["is_high_aod"] = (aod > 0.25).astype(int)

            # Dust AOD
            if "dust_aod_550nm" in df_aod.columns:
                dust = df_aod["dust_aod_550nm"].reindex(df_weather.index).fillna(0)
                features["dust_aod_mean_7d"] = dust.rolling(7, min_periods=1).mean()

        # --- Seasonal features ---
        day_of_year = features.index.dayofyear
        features["day_of_year_sin"] = np.sin(2 * np.pi * day_of_year / 365)
        features["day_of_year_cos"] = np.cos(2 * np.pi * day_of_year / 365)

        month = features.index.month
        features["month_sin"] = np.sin(2 * np.pi * month / 12)
        features["month_cos"] = np.cos(2 * np.pi * month / 12)

        # Dry season (typically summer in Mediterranean)
        features["is_dry_season"] = month.isin([5, 6, 7, 8, 9]).astype(int)

        # Fill any remaining NaN values
        features = features.fillna(0)

        return features

    def _days_since_event(self, is_event: pd.Series, max_days: int = 30) -> np.ndarray:
        """Calculate days since last event, capped at max_days."""
        days_since = np.zeros(len(is_event))
        current_count = max_days

        for i in range(len(is_event)):
            if is_event.iloc[i]:
                current_count = 0
            else:
                current_count = min(current_count + 1, max_days)
            days_since[i] = current_count

        return days_since

    def _get_model(self) -> SoilingFoundationModel:
        """Get or load the foundation model."""
        if self._model is not None:
            return self._model

        model_path = self.model_dir / "foundation_model.pkl"

        # Try to load existing model
        if model_path.exists():
            try:
                import pickle
                with open(model_path, "rb") as f:
                    self._model = pickle.load(f)
                return self._model
            except Exception:
                pass

        # Create new model (not trained - would require running training pipeline)
        config = FoundationModelConfig(conservative_bias=self.conservative_bias)
        self._model = SoilingFoundationModel(config=config)
        return self._model

    def check_availability(self, plant_id: str) -> MethodAvailability:
        """Check if foundation model is available for this plant.

        Requires weather and ideally AOD data.
        """
        df_weather = self._load_weather_data(plant_id)

        if df_weather is None or len(df_weather) < MIN_WEATHER_DAYS:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"Insufficient weather data for {plant_id} "
                       f"(need at least {MIN_WEATHER_DAYS} days)",
                confidence=0,
                data_days_available=len(df_weather) if df_weather is not None else 0,
                data_days_required=MIN_WEATHER_DAYS,
            )

        # Check if foundation model is trained
        model_path = self.model_dir / "foundation_model.pkl"
        if not model_path.exists():
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason="Foundation model not trained. Run training pipeline first.",
                confidence=0,
                data_days_available=len(df_weather),
                data_days_required=MIN_WEATHER_DAYS,
            )

        # Check AOD availability (affects confidence)
        df_aod = self._load_aod_data(plant_id)
        has_aod = df_aod is not None and len(df_aod) >= MIN_AOD_DAYS

        base_conf = LAYER_CONFIDENCE[self.layer]
        confidence = base_conf if has_aod else base_conf - 10

        reason = f"Foundation model available ({len(df_weather)} days weather"
        if has_aod:
            reason += f", {len(df_aod)} days AOD)"
        else:
            reason += ", no AOD - reduced confidence)"

        return MethodAvailability(
            method=self.method_name,
            layer=self.layer,
            is_available=True,
            reason=reason,
            confidence=confidence,
            data_days_available=len(df_weather),
            data_days_required=MIN_WEATHER_DAYS,
        )

    def estimate(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> SREstimationResult:
        """Estimate SR using the foundation model.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        start_date : str, optional
            Start date (YYYY-MM-DD)
        end_date : str, optional
            End date (YYYY-MM-DD)

        Returns
        -------
        SREstimationResult
            Estimation results
        """
        avail = self.check_availability(plant_id)
        if not avail.is_available:
            raise ValueError(avail.reason)

        # Load data
        df_weather = self._load_weather_data(plant_id)
        df_aod = self._load_aod_data(plant_id)
        df_rain = self._load_rain_data(plant_id)

        # Generate features
        features = self._generate_foundation_features(plant_id, df_weather, df_aod)

        # Add fleet CV features if enabled
        if self.enable_fleet_cv:
            features = add_fleet_cv_to_features(
                features,
                plant_id,
                self.data_dir,
                self.fleet_cv_config,
            )

        # Filter by date range
        if start_date:
            features = features[features.index >= pd.Timestamp(start_date)]
        if end_date:
            features = features[features.index <= pd.Timestamp(end_date)]

        if len(features) == 0:
            raise ValueError(f"No data available for {plant_id} in specified date range")

        # Get model and predict
        model = self._get_model()

        if not model.is_trained:
            # Use simplified rule-based fallback if model not trained
            sr_pred = self._rule_based_estimate(features)
        else:
            # Align features with model expectations
            X = features.reindex(columns=model.feature_names, fill_value=0)
            X = X.fillna(0)
            sr_pred = model.predict(X.values)

        # Apply conservative bias
        sr_pred = sr_pred - self.conservative_bias
        sr_pred = np.clip(sr_pred, 0.75, 1.0)

        sr_series = pd.Series(sr_pred, index=features.index, name="sr")

        # Apply rain anchor calibration if enabled
        rain_calibration_applied = False
        confidence_adjustment = pd.Series(0.0, index=sr_series.index)
        n_rain_anchors = 0

        if self.enable_rain_calibration and df_rain is not None and len(df_rain) > 0:
            # Get rain series (DataFrame with precipitation_mm column)
            rain_series = df_rain.get("precipitation_mm", df_rain.iloc[:, 0]).fillna(0)

            if len(rain_series) > 0:
                sr_series, confidence_adjustment = calibrate_with_rain_anchors(
                    sr_series,
                    rain_series,
                    config=self.rain_config,
                    method=self.rain_calibration_method,
                )
                rain_calibration_applied = True
                # Count rain anchors
                heavy_mask = rain_series >= self.rain_config.heavy_rain_threshold_mm
                moderate_mask = rain_series >= self.rain_config.moderate_rain_threshold_mm
                n_rain_anchors = int(heavy_mask.sum() + (moderate_mask & ~heavy_mask).sum())

        # Calculate confidence
        base_conf = avail.confidence
        confidence = self._calculate_confidence(features, base_conf)

        # Apply confidence adjustment from rain calibration
        if rain_calibration_applied:
            confidence = confidence + confidence_adjustment
            confidence = confidence.clip(35, 80)  # Foundation model caps at 80% even with calibration

        return SREstimationResult(
            sr_values=sr_series,
            confidence=confidence,
            method=self.method_name,
            layer=self.layer,
            metadata={
                "plant_id": plant_id,
                "n_days": len(features),
                "conservative_bias": self.conservative_bias,
                "has_aod_data": df_aod is not None,
                "date_range": {
                    "start": features.index.min().strftime("%Y-%m-%d"),
                    "end": features.index.max().strftime("%Y-%m-%d"),
                },
                # New calibration metadata
                "rain_calibration_applied": rain_calibration_applied,
                "rain_calibration_method": self.rain_calibration_method if rain_calibration_applied else None,
                "n_rain_anchors": n_rain_anchors,
                "fleet_cv_enabled": self.enable_fleet_cv,
                "has_fleet_cv_data": 'fleet_cv' in features.columns,
            },
        )

    def _rule_based_estimate(self, features: pd.DataFrame) -> np.ndarray:
        """Simplified rule-based estimation when model not trained.

        Uses basic soiling physics:
        - Rain resets SR toward 1.0
        - Dry days accumulate soiling
        - High AOD accelerates soiling
        """
        n = len(features)
        sr = np.ones(n)

        # Base soiling rate per day
        base_rate = 0.001  # 0.1% per day

        for i in range(1, n):
            days_since_rain = features.iloc[i].get("days_since_rain", 10)
            is_heavy_rain = features.iloc[i].get("is_heavy_rain", 0)
            aod = features.iloc[i].get("aod_mean", 0.15)
            is_high_aod = features.iloc[i].get("is_high_aod", 0)

            # Rain cleaning
            if is_heavy_rain or days_since_rain == 0:
                sr[i] = 0.995  # Reset to near-clean
            else:
                # Accumulate soiling
                soiling_rate = base_rate * (1 + 2 * is_high_aod + aod * 3)
                sr[i] = max(0.85, sr[i-1] - soiling_rate)

        return sr

    def _calculate_confidence(
        self,
        features: pd.DataFrame,
        base_conf: int,
    ) -> pd.Series:
        """Calculate confidence based on feature completeness."""
        # Check key features
        key_features = ["rainfall_7d", "days_since_rain", "aod_mean_7d"]
        available = features[key_features].notna().sum(axis=1) / len(key_features)

        confidence = base_conf * (0.7 + 0.3 * available)
        confidence = np.clip(confidence, 40, 75)

        return pd.Series(confidence, index=features.index, name="confidence")
