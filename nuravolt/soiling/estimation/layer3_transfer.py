"""
Layer 3: Transfer Learning-based SR Estimation.

This layer transfers a trained model from a similar DustIQ-equipped plant
to a target plant without DustIQ sensors. It uses climate similarity
scoring to select the best source plant.

Transfer learning approach:
1. Find most similar DustIQ plant (based on climate profile)
2. Train model on source plant's DustIQ data using ENHANCED features
3. Apply source model to target plant's enhanced features
4. Handle feature alignment between source and target
5. Apply post-hoc rain anchor calibration (NEW)
6. Use fleet CV as input feature for uniformity detection (NEW)

Enhanced features include:
- Environmental: rain, AOD, soil moisture, sea salt, extinction
- Temporal: seasonal patterns, day of year
- Location: latitude, altitude, coastal flag
- Fleet CV: uniformity indicator (NEW)

Post-hoc calibration:
- Rain Anchor: Heavy rain resets SR to ~0.995, constrains predictions
- Confidence boost near rain anchor points

Uses CatBoost with dirty-day weighting for better low-SR prediction.

Confidence is adjusted based on source-target similarity score.
"""

import json
import pickle
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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
from .layer2_same_plant_ml import SamePlantMLEstimator, PLANT_LOCATIONS
from .similarity import PlantSimilarityScorer, PLANT_PROFILES
from .calibration import (
    RainAnchorConfig,
    calibrate_with_rain_anchors,
    add_fleet_cv_to_features,
    FleetCVConfig,
)
from ..sr_transfer_features import EnhancedFeatureExtractor, PLANT_CONFIGS


# Minimum similarity score for transfer
MIN_SIMILARITY = 0.5
RECOMMENDED_SIMILARITY = 0.7


class TransferLearningEstimator(SREstimator):
    """Layer 3: Transfer learning from similar DustIQ-equipped plant.

    This estimator:
    1. Uses climate similarity to find best source plant
    2. Applies source plant's trained model to target features
    3. Adjusts confidence based on similarity score

    Attributes
    ----------
    data_dir : Path
        Directory containing plant soiling data
    model_dir : Path
        Directory for storing models
    similarity_scorer : PlantSimilarityScorer
        Climate similarity calculator
    """

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        model_dir: Optional[Path] = None,
        source_plant_override: Optional[str] = None,
        enable_rain_calibration: bool = False,
        enable_fleet_cv: bool = True,
        rain_calibration_method: str = 'blend',
        rain_config: Optional[RainAnchorConfig] = None,
        fleet_cv_config: Optional[FleetCVConfig] = None,
    ):
        """Initialize Transfer Learning estimator.

        Parameters
        ----------
        data_dir : Path, optional
            Directory containing plant soiling data.
        model_dir : Path, optional
            Directory for trained models.
        source_plant_override : str, optional
            Manual override for source plant (skips auto-selection)
        enable_rain_calibration : bool
            Whether to apply post-hoc rain anchor calibration (default: False).
            Disabled by default because L3 Transfer predictions are already
            accurate and post-hoc calibration can hurt performance.
        enable_fleet_cv : bool
            Whether to include fleet CV as input feature (default: True)
        rain_calibration_method : str
            Rain calibration method: 'constrain', 'blend', or 'forward_simulate'.
            Default 'blend' is gentler than 'constrain' if calibration is enabled.
        rain_config : RainAnchorConfig, optional
            Configuration for rain anchor calibration
        fleet_cv_config : FleetCVConfig, optional
            Configuration for fleet CV feature extraction
        """
        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self.model_dir = Path(model_dir) if model_dir else Path("backenddata/models/transfer")
        self.model_dir.mkdir(parents=True, exist_ok=True)

        self.source_plant_override = source_plant_override
        self.similarity_scorer = PlantSimilarityScorer(profiles=PLANT_PROFILES)

        # Calibration settings
        self.enable_rain_calibration = enable_rain_calibration
        self.enable_fleet_cv = enable_fleet_cv
        self.rain_calibration_method = rain_calibration_method
        self.rain_config = rain_config or RainAnchorConfig()
        self.fleet_cv_config = fleet_cv_config or FleetCVConfig()

        # Same-plant estimator for source models
        self._same_plant_estimator = SamePlantMLEstimator(
            data_dir=self.data_dir,
            model_dir=self.model_dir.parent / "same_plant",
        )

        # Cache for transfer configs per plant
        self._transfer_configs = {}

    @property
    def layer(self) -> EstimationLayer:
        return EstimationLayer.TRANSFER

    @property
    def method_name(self) -> str:
        return "transfer_learning"

    def _get_source_plant(self, target_plant: str) -> Optional[Tuple[str, float]]:
        """Get source plant for transfer learning.

        Uses MAE-validated registry when available, falls back to similarity.

        Returns
        -------
        tuple or None
            (source_plant_id, similarity_score) or None if no source available
        """
        # Check for manual override
        if self.source_plant_override:
            score = self.similarity_scorer.calculate_similarity(
                target_plant, self.source_plant_override
            )
            return (self.source_plant_override, score)

        # Use validated source selection (uses registry with similarity fallback)
        result = self.similarity_scorer.get_validated_source(
            target_plant,
            min_similarity=MIN_SIMILARITY,
        )

        if result.get('source_plant') is None:
            return None

        return (result['source_plant'], result.get('similarity', 0.0))

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

    def _load_rain_data(self, plant_id: str) -> Optional[pd.Series]:
        """Load rain history data for a plant.

        Tries multiple sources:
        1. rain_history.json (dedicated rain file)
        2. weather_extended.json (precipitation_mm column)

        Returns
        -------
        pd.Series or None
            Daily rainfall in mm, indexed by date
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
                    # Find precipitation column
                    precip_col = None
                    for col in ["precipitation_mm", "rainfall_mm", "rain_mm", "precip"]:
                        if col in df.columns:
                            precip_col = col
                            break
                    if precip_col:
                        return df[precip_col].fillna(0)
            except Exception:
                pass

        # Fall back to weather_extended.json
        df_weather = self._load_weather_data(plant_id)
        if df_weather is not None:
            for col in ["precipitation_mm", "rainfall_mm", "rain_mm", "precip", "precipitation"]:
                if col in df_weather.columns:
                    return df_weather[col].fillna(0)

        return None

    def set_source_plant(self, target_plant: str, source_plant: str) -> float:
        """Manually set source plant for a target.

        Parameters
        ----------
        target_plant : str
            Target plant ID
        source_plant : str
            Source plant ID (must have DustIQ)

        Returns
        -------
        float
            Similarity score between plants
        """
        # Verify source has DustIQ
        source_profile = self.similarity_scorer.get_profile(source_plant)
        if source_profile is None or not source_profile.has_dustiq:
            raise ValueError(f"Source plant {source_plant} does not have DustIQ sensor")

        score = self.similarity_scorer.calculate_similarity(target_plant, source_plant)
        self._transfer_configs[target_plant] = {
            "source_plant": source_plant,
            "similarity_score": score,
            "configured_at": datetime.now().isoformat(),
        }
        return score

    def get_transfer_config(self, target_plant: str) -> Optional[dict]:
        """Get transfer configuration for a target plant.

        Returns full configuration including MAE and correlation when available.
        """
        if target_plant in self._transfer_configs:
            return self._transfer_configs[target_plant]

        # Use validated source selection for full config
        result = self.similarity_scorer.get_validated_source(
            target_plant,
            min_similarity=MIN_SIMILARITY,
        )

        if result.get('source_plant') is None:
            return None

        return {
            "source_plant": result['source_plant'],
            "similarity_score": result.get('similarity', 0.0),
            "mae": result.get('mae'),
            "correlation": result.get('correlation'),
            "method": result.get('method', 'similarity'),
            "confidence": result.get('confidence', 'low'),
            "reason": result.get('reason', ''),
            "auto_selected": True,
        }

    def check_availability(self, plant_id: str) -> MethodAvailability:
        """Check if transfer learning is available for this plant.

        Requires:
        - At least one DustIQ plant with sufficient similarity
        - Weather data for target plant
        """
        # Check if target already has DustIQ (should use Same-Plant ML instead)
        target_profile = self.similarity_scorer.get_profile(plant_id)
        if target_profile and target_profile.has_dustiq:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"{plant_id} has DustIQ - use Same-Plant ML (Layer 2) instead",
                confidence=0,
            )

        # Find best source plant
        source_result = self._get_source_plant(plant_id)
        if source_result is None:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"No similar DustIQ plant found for {plant_id} (min similarity: {MIN_SIMILARITY})",
                confidence=0,
            )

        source_plant, similarity = source_result

        # Check source plant has trained model
        source_avail = self._same_plant_estimator.check_availability(source_plant)
        if not source_avail.is_available:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"Source plant {source_plant} model not available: {source_avail.reason}",
                confidence=0,
                source_plant=source_plant,
                similarity_score=similarity,
            )

        # Check target plant has weather data
        df_weather = self._load_weather_data(plant_id)
        if df_weather is None or len(df_weather) < 30:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"Insufficient weather data for {plant_id}",
                confidence=0,
                source_plant=source_plant,
                similarity_score=similarity,
            )

        # Calculate confidence based on similarity
        base_conf = LAYER_CONFIDENCE[self.layer]
        # Scale confidence by similarity: 0.5 sim -> 65%, 1.0 sim -> 85%
        confidence = int(base_conf * (0.5 + 0.5 * similarity))
        confidence = min(85, max(50, confidence))

        return MethodAvailability(
            method=self.method_name,
            layer=self.layer,
            is_available=True,
            reason=f"Transfer from {source_plant} (similarity: {similarity:.2f})",
            confidence=confidence,
            source_plant=source_plant,
            similarity_score=similarity,
            data_days_available=len(df_weather),
            data_days_required=30,
        )

    def _load_scada_data(self, plant_id: str) -> Optional[pd.DataFrame]:
        """Load SCADA data for a plant."""
        scada_path = self.data_dir / plant_id / "scada_daily.csv"
        if not scada_path.exists():
            # Try alternative paths
            alt_paths = [
                self.data_dir / plant_id / "scada.csv",
                Path(f"public/data/soiling/{plant_id}/scada_daily.csv"),
                Path(f"public/data/digitaltwin/{plant_id}/scada_daily.csv"),
            ]
            for path in alt_paths:
                if path.exists():
                    scada_path = path
                    break
            else:
                return None

        try:
            df = pd.read_csv(scada_path)
            date_col = next(
                (c for c in df.columns if 'date' in c.lower() or 'time' in c.lower()),
                df.columns[0]
            )
            df[date_col] = pd.to_datetime(df[date_col])
            df = df.set_index(date_col).sort_index()
            return df
        except Exception:
            return None

    def _create_date_range_df(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> pd.DataFrame:
        """Create a minimal DataFrame with date range for feature extraction."""
        # Get date range from weather data
        df_weather = self._load_weather_data(plant_id)
        if df_weather is not None and len(df_weather) > 0:
            date_range = df_weather.index
        else:
            # Fallback: last 365 days
            end = pd.Timestamp.now()
            start = end - pd.Timedelta(days=365)
            date_range = pd.date_range(start=start, end=end, freq='D')

        # Filter by requested date range
        if start_date:
            date_range = date_range[date_range >= pd.Timestamp(start_date)]
        if end_date:
            date_range = date_range[date_range <= pd.Timestamp(end_date)]

        # Create minimal DataFrame with timestamps
        return pd.DataFrame({'timestamp': date_range}).set_index('timestamp')

    def estimate(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        skip_dustiq_check: bool = False,
    ) -> SREstimationResult:
        """Estimate SR using transfer learning from similar plant.

        Uses EnhancedFeatureExtractor with 30-35+ features including:
        - Environmental: rain, AOD, soil moisture, sea salt, extinction
        - Temporal: seasonal patterns, day of year
        - Location: latitude, altitude, coastal flag
        - Fleet CV: uniformity indicator (NEW)
        - Hybrid model features (if available)

        Post-processing:
        - Rain anchor calibration grounds predictions to local rain events

        Parameters
        ----------
        plant_id : str
            Plant identifier
        start_date : str, optional
            Start date (YYYY-MM-DD)
        end_date : str, optional
            End date (YYYY-MM-DD)
        skip_dustiq_check : bool
            If True, skip the check that prevents using transfer on DustIQ plants.
            Useful for cross-validation testing where we want to compare transfer
            predictions against actual DustIQ ground truth.

        Returns
        -------
        SREstimationResult
            Estimation results with enhanced feature-based predictions
        """
        # When source_plant_override is set and skip_dustiq_check is True,
        # bypass availability check to allow cross-validation testing
        if self.source_plant_override and skip_dustiq_check:
            source_plant = self.source_plant_override
            similarity = self.similarity_scorer.calculate_similarity(plant_id, source_plant)
        else:
            avail = self.check_availability(plant_id)
            if not avail.is_available:
                raise ValueError(avail.reason)
            source_plant = avail.source_plant
            similarity = avail.similarity_score

        # Ensure we have valid source info
        if source_plant is None:
            raise ValueError(f"No source plant available for {plant_id}")

        # Get or train source model with enhanced features
        source_model = self._get_or_train_transfer_model(source_plant)

        # Extract enhanced features for target plant
        feature_extractor = EnhancedFeatureExtractor(plant_id)

        # Try to load SCADA data, fall back to date range if not available
        df_scada = self._load_scada_data(plant_id)
        if df_scada is None or len(df_scada) == 0:
            df_scada = self._create_date_range_df(plant_id, start_date, end_date)

        # Extract features (hybrid model features only if SCADA data is available)
        has_real_scada = 'power' in df_scada.columns.str.lower() or 'p_ac' in df_scada.columns.str.lower()
        features = feature_extractor.extract_features(
            df_scada,
            hybrid_model=None,  # Don't use hybrid model for target (requires training)
            multi_signal_factory=None,  # Don't use digital twin for target
            include_hybrid=False,  # Skip hybrid features for target plant
            include_twin=False,  # Skip twin features for target plant
            include_environmental=True,  # Key features for transfer
        )

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

        # Align features with source model's expected features
        features = self._align_features(features, source_model)

        # Predict using source model
        sr_pred = source_model.predict(features)
        sr_series = pd.Series(sr_pred, index=features.index, name="sr")

        # Clip predictions to valid SR range [0.5, 1.0]
        sr_series = sr_series.clip(0.5, 1.0)

        # Apply rain anchor calibration if enabled
        rain_calibration_applied = False
        confidence_adjustment = pd.Series(0.0, index=sr_series.index)
        n_rain_anchors = 0

        if self.enable_rain_calibration:
            rain_series = self._load_rain_data(plant_id)
            if rain_series is not None and len(rain_series) > 0:
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

        # Calculate confidence adjusted by similarity and rain calibration
        # Base confidence: scale by similarity (0.5 sim -> 65%, 1.0 sim -> 85%)
        base_conf_raw = LAYER_CONFIDENCE[self.layer]
        base_conf = int(base_conf_raw * (0.5 + 0.5 * similarity))
        base_conf = min(85, max(50, base_conf))
        confidence = self._calculate_confidence(features, similarity, base_conf)

        # Apply confidence adjustment from rain calibration
        if rain_calibration_applied:
            confidence = confidence + confidence_adjustment
            confidence = confidence.clip(40, 90)  # Allow higher confidence with rain anchors

        return SREstimationResult(
            sr_values=sr_series,
            confidence=confidence,
            method=self.method_name,
            layer=self.layer,
            source_plant=source_plant,
            model_version=getattr(source_model, 'trained_at', None),
            metadata={
                "plant_id": plant_id,
                "source_plant": source_plant,
                "similarity_score": similarity,
                "n_days": len(features),
                "n_features": len(features.columns),
                "feature_groups": feature_extractor.get_feature_groups(),
                "date_range": {
                    "start": features.index.min().strftime("%Y-%m-%d"),
                    "end": features.index.max().strftime("%Y-%m-%d"),
                },
                "source_model_metrics": getattr(source_model, 'metrics', {}),
                # New calibration metadata
                "rain_calibration_applied": rain_calibration_applied,
                "rain_calibration_method": self.rain_calibration_method if rain_calibration_applied else None,
                "n_rain_anchors": n_rain_anchors,
                "fleet_cv_enabled": self.enable_fleet_cv,
                "has_fleet_cv_data": 'fleet_cv' in features.columns,
            },
        )

    def _get_or_train_transfer_model(self, source_plant: str):
        """Get or train a transfer learning model for a source plant.

        Uses CatBoost with dirty-day weighting for better low-SR prediction.
        """
        model_path = self.model_dir / f"transfer_{source_plant}.pkl"

        # Check for cached model
        if model_path.exists():
            try:
                with open(model_path, 'rb') as f:
                    return pickle.load(f)
            except Exception:
                pass

        # Train new model using source plant's DustIQ data
        return self._train_transfer_model(source_plant)

    def _train_transfer_model(self, source_plant: str):
        """Train a CatBoost model on source plant's enhanced features.

        Uses dirty-day weighting to improve low-SR prediction:
        - SR < 0.90: weight 10x (critical soiling)
        - SR 0.90-0.95: weight 5x (moderate soiling)
        - SR 0.95-0.98: weight 3x (light soiling)
        - SR 0.98-0.99: weight 2x (minimal soiling)
        - SR >= 0.99: weight 1x (clean)
        """
        try:
            from catboost import CatBoostRegressor
        except ImportError:
            # Fallback to LightGBM if CatBoost not available
            import lightgbm as lgb
            use_catboost = False
        else:
            use_catboost = True

        # Load source plant's DustIQ data - try multiple paths and formats
        dustiq_paths = [
            self.data_dir / source_plant / "dustiq_daily.csv",
            self.data_dir / source_plant / "dustiq_history.json",
            Path(f"public/data/soiling/{source_plant}/dustiq_daily.csv"),
            Path(f"public/data/soiling/{source_plant}/dustiq_history.json"),
        ]

        df_dustiq = None
        for dustiq_path in dustiq_paths:
            if not dustiq_path.exists():
                continue
            try:
                if dustiq_path.suffix == '.csv':
                    df_dustiq = pd.read_csv(dustiq_path)
                else:
                    # JSON format
                    with open(dustiq_path) as f:
                        data = json.load(f)
                    df_dustiq = pd.DataFrame(data.get("daily_data", []))

                if len(df_dustiq) > 0:
                    break
            except Exception:
                continue

        if df_dustiq is None or len(df_dustiq) == 0:
            raise ValueError(f"No DustIQ data found for source plant {source_plant}")

        # Find date column
        date_col = next(
            (c for c in df_dustiq.columns if 'date' in c.lower()),
            df_dustiq.columns[0]
        )
        df_dustiq[date_col] = pd.to_datetime(df_dustiq[date_col])
        df_dustiq = df_dustiq.set_index(date_col).sort_index()

        # Get SR column
        sr_col = next(
            (c for c in df_dustiq.columns if 'sr' in c.lower() or 'soiling' in c.lower()),
            None
        )
        if sr_col is None:
            raise ValueError(f"No SR column found in DustIQ data for {source_plant}")

        y = df_dustiq[sr_col].dropna()

        # Extract enhanced features for source plant
        feature_extractor = EnhancedFeatureExtractor(source_plant)

        # Load SCADA data for source plant
        df_scada = self._load_scada_data(source_plant)
        if df_scada is None:
            # Create date range from DustIQ data
            df_scada = pd.DataFrame({'timestamp': y.index}).set_index('timestamp')

        X = feature_extractor.extract_features(
            df_scada,
            include_hybrid=False,  # Train without hybrid for portability
            include_twin=False,
            include_environmental=True,
        )

        # Align X and y
        common_idx = X.index.intersection(y.index)
        X = X.loc[common_idx]
        y = y.loc[common_idx]

        if len(X) < 30:
            raise ValueError(f"Insufficient training data for {source_plant}: {len(X)} days")

        # Calculate sample weights (dirty-day weighting)
        sample_weights = np.ones(len(y))
        sample_weights[y < 0.90] = 10.0
        sample_weights[(y >= 0.90) & (y < 0.95)] = 5.0
        sample_weights[(y >= 0.95) & (y < 0.98)] = 3.0
        sample_weights[(y >= 0.98) & (y < 0.99)] = 2.0

        # Store feature names for alignment
        feature_names = X.columns.tolist()

        # Train model
        if use_catboost:
            model = CatBoostRegressor(
                iterations=500,
                learning_rate=0.05,
                depth=6,
                l2_leaf_reg=3,
                random_seed=42,
                verbose=False,
            )
            model.fit(X, y, sample_weight=sample_weights)
        else:
            model = lgb.LGBMRegressor(
                n_estimators=500,
                learning_rate=0.05,
                max_depth=6,
                random_state=42,
                verbose=-1,
            )
            model.fit(X, y, sample_weight=sample_weights)

        # Add metadata
        model.feature_names = feature_names
        model.trained_at = datetime.now().isoformat()
        model.source_plant = source_plant
        model.n_training_samples = len(X)
        model.metrics = {
            "training_samples": len(X),
            "feature_count": len(feature_names),
        }

        # Cache model
        self.model_dir.mkdir(parents=True, exist_ok=True)
        with open(self.model_dir / f"transfer_{source_plant}.pkl", 'wb') as f:
            pickle.dump(model, f)

        return model

    def _align_features(self, features: pd.DataFrame, model) -> pd.DataFrame:
        """Align target features with source model's expected features.

        Handles missing/extra features between source and target plants.
        """
        model_features = getattr(model, 'feature_names', None)
        if model_features is None:
            # Try to infer from model
            if hasattr(model, 'feature_names_'):
                model_features = model.feature_names_
            elif hasattr(model, 'feature_name_'):
                model_features = model.feature_name_()
            else:
                # Assume features are already aligned
                return features

        # Add missing features with default values
        for feat in model_features:
            if feat not in features.columns:
                # Use 0 for most features, but handle location features specially
                if 'latitude' in feat.lower():
                    config = PLANT_CONFIGS.get(features.index.name, None)
                    default = abs(config.latitude) if config else 40.0
                elif 'altitude' in feat.lower():
                    config = PLANT_CONFIGS.get(features.index.name, None)
                    default = config.altitude if config else 100.0
                elif 'coastal' in feat.lower():
                    config = PLANT_CONFIGS.get(features.index.name, None)
                    default = float(config.is_coastal) if config else 0.0
                else:
                    default = 0.0
                features[feat] = default

        # Select only model features in correct order
        return features[model_features]

    def _calculate_confidence(
        self,
        X: pd.DataFrame,
        similarity: float,
        base_conf: int,
    ) -> pd.Series:
        """Calculate confidence based on similarity and feature completeness."""
        # Feature completeness factor
        non_null_ratio = X.notna().sum(axis=1) / X.shape[1]

        # Similarity adjustment (0.5-1.0 range)
        sim_factor = 0.5 + 0.5 * similarity

        # Combined confidence
        confidence = base_conf * non_null_ratio * sim_factor
        confidence = np.clip(confidence, 40, 85)

        return pd.Series(confidence, index=X.index, name="confidence")

    def get_ranked_sources(self, target_plant: str, top_k: int = 3) -> list:
        """Get ranked list of potential source plants for a target.

        Returns
        -------
        list of dicts
            Ranked sources with availability info
        """
        ranked = self.similarity_scorer.get_ranked_transfer_sources(
            target_plant,
            dustiq_plants_only=True,
            top_k=top_k,
        )

        results = []
        for source_plant, similarity in ranked:
            source_avail = self._same_plant_estimator.check_availability(source_plant)
            results.append({
                "source_plant": source_plant,
                "similarity_score": similarity,
                "model_available": source_avail.is_available,
                "model_status": source_avail.reason,
                "estimated_confidence": int(LAYER_CONFIDENCE[self.layer] * (0.5 + 0.5 * similarity)),
            })

        return results
