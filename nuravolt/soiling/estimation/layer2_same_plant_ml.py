"""
Layer 2: Same-Plant ML-based SR Estimation.

This layer trains a ML model on the plant's own historical DustIQ data
combined with weather/AOD features. It requires minimum 90 days of
DustIQ history for training.

Wraps the existing SoilingRatioModel with the SREstimator interface.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import pandas as pd

from .base import (
    EstimationLayer,
    MethodAvailability,
    SREstimationResult,
    SREstimator,
    LAYER_CONFIDENCE,
    LAYER_DATA_REQUIREMENTS,
)
from .layer1_dustiq import DustIQEstimator, DEFAULT_DATA_DIR

# Import existing model components
try:
    from ..sr_ml_model import SoilingRatioModel, SoilingRatioModelConfig
    from ..sr_ml_features import SoilingRatioFeatureEngineer, PlantLocation
    ML_MODEL_AVAILABLE = True
except ImportError:
    ML_MODEL_AVAILABLE = False


# Minimum days of DustIQ data required for training
MIN_TRAINING_DAYS = 90
RECOMMENDED_TRAINING_DAYS = 365

# Plant coordinates for feature engineering
PLANT_LOCATIONS = {
    "epsilon": PlantLocation(latitude=51.195, longitude=14.509, elevation_m=150, climate_zone="temperate"),
    "zeta": PlantLocation(latitude=39.525, longitude=3.187, elevation_m=50, climate_zone="mediterranean", distance_to_coast_km=10),
    "ribera": PlantLocation(latitude=37.927, longitude=-1.233, elevation_m=100, climate_zone="mediterranean"),
    "delta": PlantLocation(latitude=39.6544, longitude=2.6978, elevation_m=30, climate_zone="mediterranean", distance_to_coast_km=5),
    "gamma": PlantLocation(latitude=39.489, longitude=2.916, elevation_m=40, climate_zone="mediterranean", distance_to_coast_km=15),
    "eta": PlantLocation(latitude=38.66, longitude=-5.39, elevation_m=400, climate_zone="mediterranean"),
    "alpha": PlantLocation(latitude=37.8145, longitude=-3.8047, elevation_m=200, climate_zone="mediterranean"),
}


class SamePlantMLEstimator(SREstimator):
    """Layer 2: ML model trained on plant's own DustIQ history.

    This estimator:
    1. Checks for sufficient DustIQ historical data (min 90 days)
    2. Trains a CatBoost model on DustIQ + weather/AOD features
    3. Predicts SR for dates with weather data available

    Attributes
    ----------
    data_dir : Path
        Directory containing plant soiling data
    model_dir : Path
        Directory for storing trained models
    """

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        model_dir: Optional[Path] = None,
    ):
        """Initialize Same-Plant ML estimator.

        Parameters
        ----------
        data_dir : Path, optional
            Directory containing plant soiling data.
        model_dir : Path, optional
            Directory for trained models. Defaults to backenddata/models/
        """
        if not ML_MODEL_AVAILABLE:
            raise ImportError("ML model components not available. Check sr_ml_model.py imports.")

        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self.model_dir = Path(model_dir) if model_dir else Path("backenddata/models/same_plant")
        self.model_dir.mkdir(parents=True, exist_ok=True)

        self._dustiq_estimator = DustIQEstimator(data_dir=self.data_dir)
        self._models = {}  # Cache for trained models
        self._feature_engineers = {}

    @property
    def layer(self) -> EstimationLayer:
        return EstimationLayer.SAME_PLANT_ML

    @property
    def method_name(self) -> str:
        return "same_plant_ml"

    def _get_plant_location(self, plant_id: str) -> PlantLocation:
        """Get plant location for feature engineering."""
        if plant_id in PLANT_LOCATIONS:
            return PLANT_LOCATIONS[plant_id]
        # Default location
        return PlantLocation(latitude=40.0, longitude=0.0, climate_zone="mediterranean")

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

            # Rename columns to expected format
            if "precipitation_mm" in df.columns:
                pass  # Already correct
            elif "precipitation" in df.columns:
                df["precipitation_mm"] = df["precipitation"]

            return df
        except Exception as e:
            print(f"Error loading weather data for {plant_id}: {e}")
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
        except Exception as e:
            print(f"Error loading AOD data for {plant_id}: {e}")
            return None

    def _prepare_features_and_targets(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Tuple[pd.DataFrame, pd.Series]:
        """Prepare features and targets for training/prediction.

        Returns
        -------
        tuple
            (features DataFrame, targets Series)
        """
        # Load DustIQ data
        dustiq_result = self._dustiq_estimator.estimate(plant_id, start_date, end_date)
        sr_dustiq = dustiq_result.sr_values

        # Load weather and AOD data
        df_weather = self._load_weather_data(plant_id)
        df_aod = self._load_aod_data(plant_id)

        if df_weather is None:
            raise ValueError(f"No weather data available for {plant_id}")

        # Get plant location
        location = self._get_plant_location(plant_id)

        # Create feature engineer
        if plant_id not in self._feature_engineers:
            self._feature_engineers[plant_id] = SoilingRatioFeatureEngineer(location)
        feature_eng = self._feature_engineers[plant_id]

        # Generate features
        features = feature_eng.generate_features(
            df_weather=df_weather,
            df_aod=df_aod,
        )

        # Align features with DustIQ targets
        common_dates = features.index.intersection(sr_dustiq.index)
        if len(common_dates) == 0:
            raise ValueError(f"No overlapping dates between features and DustIQ for {plant_id}")

        X = features.loc[common_dates]
        y = sr_dustiq.loc[common_dates]

        return X, y

    def _train_model(self, plant_id: str, verbose: bool = False) -> SoilingRatioModel:
        """Train a model for the given plant."""
        X, y = self._prepare_features_and_targets(plant_id)

        if len(X) < MIN_TRAINING_DAYS:
            raise ValueError(
                f"Insufficient data for {plant_id}: {len(X)} days "
                f"(minimum {MIN_TRAINING_DAYS} required)"
            )

        # Temporal train/val split (80/20)
        split_idx = int(len(X) * 0.8)
        X_train, X_val = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_val = y.iloc[:split_idx], y.iloc[split_idx:]

        # Configure and train model
        config = SoilingRatioModelConfig(
            iterations=1500,
            learning_rate=0.02,
            depth=5,
            early_stopping_rounds=100,
        )

        model = SoilingRatioModel(config)
        model.fit(
            X_train, y_train,
            X_val=X_val, y_val=y_val,
            plant_id=plant_id,
            verbose=verbose,
        )

        # Cache the model
        self._models[plant_id] = model

        # Save model
        model_path = self.model_dir / f"{plant_id}_same_plant.pkl"
        model.save(str(model_path))

        return model

    def _get_or_train_model(self, plant_id: str, retrain: bool = False) -> SoilingRatioModel:
        """Get cached model or train a new one."""
        if plant_id in self._models and not retrain:
            return self._models[plant_id]

        # Try to load from disk
        model_path = self.model_dir / f"{plant_id}_same_plant.pkl"
        if model_path.exists() and not retrain:
            try:
                model = SoilingRatioModel.load(str(model_path))
                self._models[plant_id] = model
                return model
            except Exception:
                pass

        # Train new model
        return self._train_model(plant_id, verbose=False)

    def check_availability(self, plant_id: str) -> MethodAvailability:
        """Check if Same-Plant ML is available for this plant.

        Requires minimum 90 days of DustIQ + weather data.
        """
        # First check DustIQ availability
        dustiq_avail = self._dustiq_estimator.check_availability(plant_id)
        if not dustiq_avail.is_available:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"No DustIQ data for {plant_id} (required for training)",
                confidence=0,
                data_days_available=0,
                data_days_required=MIN_TRAINING_DAYS,
            )

        # Check if we have enough data
        if dustiq_avail.data_days_available < MIN_TRAINING_DAYS:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"Insufficient DustIQ data: {dustiq_avail.data_days_available} days "
                       f"(minimum {MIN_TRAINING_DAYS} required)",
                confidence=0,
                data_days_available=dustiq_avail.data_days_available,
                data_days_required=MIN_TRAINING_DAYS,
            )

        # Check weather data
        df_weather = self._load_weather_data(plant_id)
        if df_weather is None or len(df_weather) < MIN_TRAINING_DAYS:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"Insufficient weather data for {plant_id}",
                confidence=0,
                data_days_available=len(df_weather) if df_weather is not None else 0,
                data_days_required=MIN_TRAINING_DAYS,
            )

        # Calculate confidence based on data quantity
        base_conf = LAYER_CONFIDENCE[self.layer]
        days = dustiq_avail.data_days_available

        if days >= RECOMMENDED_TRAINING_DAYS * 2:
            confidence = base_conf + 5
        elif days >= RECOMMENDED_TRAINING_DAYS:
            confidence = base_conf
        else:
            # Scale confidence linearly for data between MIN and RECOMMENDED
            ratio = (days - MIN_TRAINING_DAYS) / (RECOMMENDED_TRAINING_DAYS - MIN_TRAINING_DAYS)
            confidence = int(base_conf - 10 + ratio * 10)

        confidence = min(95, max(50, confidence))

        return MethodAvailability(
            method=self.method_name,
            layer=self.layer,
            is_available=True,
            reason=f"Same-Plant ML available ({days} days DustIQ, "
                   f"{len(df_weather)} days weather)",
            confidence=confidence,
            data_days_available=days,
            data_days_required=MIN_TRAINING_DAYS,
        )

    def estimate(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> SREstimationResult:
        """Estimate SR using Same-Plant ML model.

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

        # Get or train model
        model = self._get_or_train_model(plant_id)

        # Prepare features for prediction period
        X, y_actual = self._prepare_features_and_targets(plant_id, start_date, end_date)

        if len(X) == 0:
            raise ValueError(f"No data available for {plant_id} in specified date range")

        # Predict
        sr_pred = model.predict(X)
        sr_series = pd.Series(sr_pred, index=X.index, name="sr")

        # Calculate confidence based on feature completeness and model validation
        base_conf = avail.confidence
        confidence = self._calculate_prediction_confidence(X, base_conf)

        # Calculate validation metrics using actual DustIQ values
        errors = sr_pred - y_actual.values
        mae = float(np.abs(errors).mean())
        rmse = float(np.sqrt((errors ** 2).mean()))
        bias = float(errors.mean())
        ss_res = ((y_actual - sr_pred) ** 2).sum()
        ss_tot = ((y_actual - y_actual.mean()) ** 2).sum()
        r2 = float(1 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0

        return SREstimationResult(
            sr_values=sr_series,
            confidence=confidence,
            method=self.method_name,
            layer=self.layer,
            validation_mae=mae,
            validation_rmse=rmse,
            validation_r2=r2,
            validation_bias=bias,
            model_version=model.metadata.created_at if model.metadata else None,
            metadata={
                "plant_id": plant_id,
                "n_days": len(X),
                "training_samples": model.metadata.n_samples if model.metadata else 0,
                "feature_count": len(model.feature_names) if model.feature_names else 0,
                "date_range": {
                    "start": X.index.min().strftime("%Y-%m-%d"),
                    "end": X.index.max().strftime("%Y-%m-%d"),
                },
            },
        )

    def _calculate_prediction_confidence(
        self,
        X: pd.DataFrame,
        base_conf: int,
    ) -> pd.Series:
        """Calculate confidence based on feature completeness."""
        # Count non-null features per row
        non_null_ratio = X.notna().sum(axis=1) / X.shape[1]

        # Scale confidence by feature completeness
        confidence = base_conf * non_null_ratio
        confidence = np.clip(confidence, 50, 95)

        return pd.Series(confidence, index=X.index, name="confidence")

    def retrain(self, plant_id: str, verbose: bool = True) -> dict:
        """Force retrain the model for a plant.

        Returns
        -------
        dict
            Training metrics
        """
        model = self._train_model(plant_id, verbose=verbose)
        return {
            "plant_id": plant_id,
            "mae": model.metadata.validation_mae if model.metadata else None,
            "rmse": model.metadata.validation_rmse if model.metadata else None,
            "r2": model.metadata.validation_r2 if model.metadata else None,
            "n_samples": model.metadata.n_samples if model.metadata else 0,
        }
