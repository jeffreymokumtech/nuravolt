"""Enhanced feature extraction for soiling ratio transfer learning.

Combines all available data sources for improved SR prediction at plants
WITHOUT DustIQ sensors:

1. Digital Twin Features (MultiSignalTwin):
   - current_cv, voltage_cv, temp_deviation
   - power_loss_pct, current_loss_pct, voltage_loss_pct
   - soiling_signature_score (composite)

2. Hybrid Model Features (NEW):
   - P_physics: Physics baseline power prediction
   - P_hybrid: Physics + ML prediction
   - ml_residual: What ML learned about the site
   - physics_loss_pct: (P_physics - P_actual) / P_physics
   - hybrid_loss_pct: (P_hybrid - P_actual) / P_hybrid

3. Environmental Features:
   - Rain: days_since_rain, rainfall_7d/14d/30d
   - AOD/Dust: pm10, pm2p5, dust_aod, aod_7d_avg
   - Weather: humidity, wind, dewpoint, dew_cleaning
   - Soil Moisture (NEW): soil_moisture_0_7cm, is_dry_soil
   - Sea Salt (NEW): sea_salt_aod, sea_salt_pct
   - Surface Extinction (NEW): dust_extinction, seasalt_extinction

Target: 30-35 features for enhanced transfer learning.

Usage:
    from nuravolt.soiling.sr_transfer_features import EnhancedFeatureExtractor

    extractor = EnhancedFeatureExtractor(
        plant_id="gamma",
        latitude=39.489,
        longitude=2.916,
    )

    # Extract all features
    df_features = extractor.extract_features(
        df_scada,
        hybrid_model=hybrid_model,
        multi_signal_factory=factory,
    )
"""

import json
import pickle
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
import pandas as pd
import polars as pl


@dataclass
class PlantConfig:
    """Configuration for a plant."""
    plant_id: str
    latitude: float
    longitude: float
    altitude: float = 0.0
    p_rated: float = 60.0  # kW per inverter
    climate_zone: str = "mediterranean"
    distance_to_coast_km: float = 50.0
    is_coastal: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> "PlantConfig":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


# Plant configurations (matching train_hybrid_models.py)
PLANT_CONFIGS = {
    "epsilon": PlantConfig(
        plant_id="epsilon",
        latitude=51.195,
        longitude=14.509,
        altitude=150,
        p_rated=60.0,
        climate_zone="temperate",
        is_coastal=False,
    ),
    "ribera": PlantConfig(
        plant_id="ribera",
        latitude=37.927,
        longitude=-1.233,
        altitude=50,
        p_rated=60.0,
        climate_zone="mediterranean",
        is_coastal=True,
    ),
    "eta": PlantConfig(
        plant_id="eta",
        latitude=38.66,
        longitude=-5.39,
        altitude=400,
        p_rated=60.0,
        climate_zone="mediterranean",
        is_coastal=False,
    ),
    "delta": PlantConfig(
        plant_id="delta",
        latitude=39.6544,
        longitude=2.6978,
        altitude=50,
        p_rated=60.0,
        climate_zone="mediterranean",
        is_coastal=True,
    ),
    "zeta": PlantConfig(
        plant_id="zeta",
        latitude=39.525,
        longitude=3.187,
        altitude=50,
        p_rated=60.0,
        climate_zone="mediterranean",
        is_coastal=True,
    ),
    "gamma": PlantConfig(
        plant_id="gamma",
        latitude=39.489,
        longitude=2.916,
        altitude=25,
        p_rated=60.0,
        climate_zone="mediterranean",
        is_coastal=True,
    ),
    "alpha": PlantConfig(
        plant_id="alpha",
        latitude=37.8145,
        longitude=-3.8047,
        altitude=500,
        p_rated=60.0,
        climate_zone="mediterranean",
        is_coastal=False,
    ),
}


class EnhancedFeatureExtractor:
    """Extract enhanced features for SR transfer learning.

    Combines digital twin, hybrid model, and environmental features
    for improved soiling ratio prediction at plants without DustIQ.
    """

    ROLLING_WINDOWS = [7, 14, 30]

    def __init__(
        self,
        plant_id: str,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        config: Optional[PlantConfig] = None,
    ):
        """Initialize feature extractor.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        latitude, longitude : float, optional
            Plant coordinates (can use PLANT_CONFIGS instead)
        config : PlantConfig, optional
            Full plant configuration
        """
        self.plant_id = plant_id

        # Get config from PLANT_CONFIGS or use provided values
        if config:
            self.config = config
        elif plant_id in PLANT_CONFIGS:
            self.config = PLANT_CONFIGS[plant_id]
        else:
            self.config = PlantConfig(
                plant_id=plant_id,
                latitude=latitude or 40.0,
                longitude=longitude or 0.0,
            )

        self.feature_names: List[str] = []

        # Data paths
        self.data_dir = Path(f"public/data/soiling/{plant_id}")
        self.digitaltwin_dir = Path(f"public/data/digitaltwin/{plant_id}")

    def extract_features(
        self,
        df_scada: pd.DataFrame,
        hybrid_model: Optional[object] = None,
        multi_signal_factory: Optional[object] = None,
        include_hybrid: bool = True,
        include_twin: bool = True,
        include_environmental: bool = True,
        include_soiling_twin: bool = True,
    ) -> pd.DataFrame:
        """Extract all features for SR prediction.

        Parameters
        ----------
        df_scada : pd.DataFrame
            SCADA data with columns:
            - timestamp (index or column)
            - irradiance
            - temperature (ambient)
            - power

        hybrid_model : HybridModel, optional
            Trained HybridModel for physics+ML predictions

        multi_signal_factory : MultiSignalTwinFactory, optional
            Trained digital twin factory

        include_hybrid : bool
            Include hybrid model features (P_physics, P_hybrid, ml_residual)

        include_twin : bool
            Include digital twin features (current_cv, voltage_cv, etc.)

        include_environmental : bool
            Include environmental features (rain, AOD, soil moisture, etc.)

        include_soiling_twin : bool
            Include soiling-aware twin features (sat_*). These are plant-specific
            and should be DISABLED for transfer learning to avoid feature mismatch.
            Default True for same-plant training.

        Returns
        -------
        pd.DataFrame
            Feature matrix with ~30-35 features
        """
        # Ensure datetime index
        if 'timestamp' in df_scada.columns:
            df_scada = df_scada.set_index('timestamp')
        df_scada.index = pd.to_datetime(df_scada.index)

        # Resample to daily if sub-daily
        if hasattr(df_scada.index, 'freq') and df_scada.index.freq != 'D':
            df_daily = self._resample_to_daily(df_scada)
        else:
            # Check if data is sub-daily by looking at median time difference
            time_diff = df_scada.index.to_series().diff().median()
            if time_diff < pd.Timedelta(hours=12):
                df_daily = self._resample_to_daily(df_scada)
            else:
                df_daily = df_scada.copy()

        features = {}

        # 1. Hybrid Model Features (P_physics, P_hybrid, ml_residual)
        # Extract at sub-daily, then resample to daily
        if include_hybrid and hybrid_model is not None:
            hybrid_features = self._extract_hybrid_features(df_scada, hybrid_model)
            hybrid_features = self._resample_features_to_daily(hybrid_features, df_scada.index, df_daily.index)
            features.update(hybrid_features)
        elif include_hybrid:
            # Try to load hybrid model from disk
            hybrid_model = self._load_hybrid_model()
            if hybrid_model is not None:
                hybrid_features = self._extract_hybrid_features(df_scada, hybrid_model)
                hybrid_features = self._resample_features_to_daily(hybrid_features, df_scada.index, df_daily.index)
                features.update(hybrid_features)

        # 1b. Soiling-Aware Twin Features (from pre-trained daily hybrid)
        # These have rain/AOD features baked in, so delta_ml correlates with soiling
        # NOTE: Disabled for transfer learning as SAT features are plant-specific
        if include_soiling_twin:
            soiling_twin_features = self._extract_soiling_aware_twin_features(df_daily.index)
            if soiling_twin_features:
                features.update(soiling_twin_features)

        # 2. Digital Twin Features
        if include_twin and multi_signal_factory is not None:
            features.update(self._extract_twin_features(df_scada, multi_signal_factory))

        # 3. Environmental Features (from JSON files)
        if include_environmental:
            features.update(self._extract_environmental_features(df_daily))

            # 3b. Physics-motivated interaction features
            # Derived from environmental data (no leakage)
            features.update(self._create_interaction_features(features, len(df_daily)))

        # 4. Temporal Features (always available)
        features.update(self._create_temporal_features(df_daily.index))

        # 5. Location Features (static)
        features.update(self._create_location_features(len(df_daily)))

        # Build DataFrame
        df_features = pd.DataFrame(features, index=df_daily.index)

        # Handle NaN values
        df_features = df_features.ffill().bfill()

        # Store feature names
        self.feature_names = df_features.columns.tolist()

        return df_features

    def _resample_to_daily(self, df: pd.DataFrame) -> pd.DataFrame:
        """Resample sub-daily data to daily."""
        numeric_cols = df.select_dtypes(include=[np.number]).columns

        # Handle case where DataFrame has no numeric columns
        if len(numeric_cols) == 0:
            # Just resample the index to get daily dates
            daily_index = df.resample('D').first().index
            return pd.DataFrame(index=daily_index)

        agg_dict = {}
        for col in numeric_cols:
            col_lower = col.lower()
            if 'power' in col_lower or 'energy' in col_lower:
                agg_dict[col] = 'sum'
            elif 'irradiance' in col_lower or 'ghi' in col_lower:
                agg_dict[col] = 'mean'
            elif 'temp' in col_lower:
                agg_dict[col] = 'mean'
            else:
                agg_dict[col] = 'mean'

        return df.resample('D').agg(agg_dict)

    def _resample_features_to_daily(
        self,
        features: Dict[str, np.ndarray],
        source_index: pd.DatetimeIndex,
        target_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Resample feature arrays from sub-daily to daily."""
        resampled = {}

        for name, values in features.items():
            if len(values) == len(source_index):
                # Create Series with source index, resample to daily
                series = pd.Series(values, index=source_index)
                daily = series.resample('D').mean()
                # Reindex to target daily index
                daily = daily.reindex(target_index)
                resampled[name] = daily.values
            elif len(values) == len(target_index):
                # Already at daily frequency
                resampled[name] = values
            else:
                # Skip mismatched lengths
                print(f"Warning: Skipping feature '{name}' - length mismatch: {len(values)} vs {len(source_index)}/{len(target_index)}")

        return resampled

    def _load_hybrid_model(self) -> Optional[object]:
        """Load HybridModel from disk."""
        model_path = self.digitaltwin_dir / "hybrid_model.pkl"
        if model_path.exists():
            try:
                with open(model_path, 'rb') as f:
                    return pickle.load(f)
            except Exception as e:
                print(f"Warning: Could not load hybrid model: {e}")
        return None

    def _extract_hybrid_features(
        self,
        df: pd.DataFrame,
        hybrid_model: object,
    ) -> Dict[str, np.ndarray]:
        """Extract features from HybridModel.

        Features:
        - P_physics: Physics baseline prediction
        - P_hybrid: Physics + ML prediction
        - ml_residual: What ML learned (delta)
        - physics_loss_pct: (P_physics - P_actual) / P_physics * 100
        - hybrid_loss_pct: (P_hybrid - P_actual) / P_hybrid * 100
        """
        features = {}

        try:
            # Get predictions from hybrid model with components
            result = hybrid_model.predict(df, return_components=True)

            # Handle different return formats
            if isinstance(result, dict):
                # return_components=True returns dict with p_expected, p_physics, delta_ml
                if 'p_physics' in result:
                    features['P_physics'] = result['p_physics']
                if 'p_expected' in result:
                    features['P_hybrid'] = result['p_expected']
                if 'delta_ml' in result:
                    features['ml_residual'] = result['delta_ml']
            elif isinstance(result, pd.DataFrame):
                if 'P_physics' in result.columns:
                    features['P_physics'] = result['P_physics'].values
                if 'P_hybrid' in result.columns:
                    features['P_hybrid'] = result['P_hybrid'].values
                if 'ml_residual' in result.columns:
                    features['ml_residual'] = result['ml_residual'].values
            elif isinstance(result, np.ndarray):
                # Assume it's hybrid prediction
                features['P_hybrid'] = result

            # Calculate loss percentages if we have power data
            power_col = self._find_column(df.columns, ['power', 'p_ac', 'power_kw'])
            if power_col and 'P_physics' in features:
                P_actual = df[power_col].values
                P_physics = features['P_physics']

                # Physics loss (vs actual)
                with np.errstate(divide='ignore', invalid='ignore'):
                    physics_loss = np.where(
                        P_physics > 0,
                        (P_physics - P_actual) / P_physics * 100,
                        0
                    )
                features['physics_loss_pct'] = np.clip(physics_loss, -50, 50)

                # Hybrid loss (vs actual)
                if 'P_hybrid' in features:
                    P_hybrid = features['P_hybrid']
                    with np.errstate(divide='ignore', invalid='ignore'):
                        hybrid_loss = np.where(
                            P_hybrid > 0,
                            (P_hybrid - P_actual) / P_hybrid * 100,
                            0
                        )
                    features['hybrid_loss_pct'] = np.clip(hybrid_loss, -50, 50)

            # Rolling statistics
            for key in ['physics_loss_pct', 'hybrid_loss_pct', 'ml_residual']:
                if key in features:
                    series = pd.Series(features[key])
                    for window in [7, 14]:
                        features[f'{key}_mean_{window}d'] = series.rolling(
                            window, min_periods=1
                        ).mean().values

                    # Trend
                    features[f'{key}_trend_7d'] = (series.diff(7) / 7).fillna(0).values

        except Exception as e:
            print(f"Warning: Could not extract hybrid features: {e}")

        return features

    def _extract_soiling_aware_twin_features(
        self,
        daily_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Extract features from pre-trained soiling-aware daily hybrid twin.

        These twins are trained with rain/AOD features, so delta_ml correlates with soiling.

        Features:
        - sat_p_physics: Physics baseline (clean expectation)
        - sat_p_hybrid: ML prediction with rain/AOD features
        - sat_delta_ml: P_hybrid - P_physics (soiling-correlated signal)
        - sat_sr_raw: P_actual / P_physics (raw soiling ratio estimate)
        - sat_days_since_rain: Days since significant rain
        """
        features = {}

        # Load pre-computed daily hybrid power
        hybrid_path = Path(f"backenddata/models/soiling_aware_twin/{self.plant_id}_daily_hybrid.parquet")

        if not hybrid_path.exists():
            return features

        try:
            df_hybrid = pd.read_parquet(hybrid_path)
            print(f"    Loaded soiling-aware twin: {len(df_hybrid)} days")

            # Align to target daily index
            df_aligned = df_hybrid.reindex(daily_index)

            # Add NORMALIZED SAT features for transfer learning compatibility
            # NOTE: Absolute power features (p_physics, p_hybrid) are NOT included
            # because they have different scales per plant and break transfer learning.
            # Instead, we use ratio-based and z-score normalized features.

            p_physics = df_aligned.get('p_physics', pd.Series(dtype=float)).clip(lower=1)
            p_actual = df_aligned.get('p_actual', pd.Series(dtype=float))

            # 1. Normalized delta_ml = (P_hybrid - P_physics) / P_physics
            # This is a ratio (-1 to +1 range) that's comparable across plants
            if 'delta_ml' in df_aligned.columns and 'p_physics' in df_aligned.columns:
                delta_ml = df_aligned['delta_ml']
                delta_ml_norm = delta_ml / p_physics  # Normalized by capacity
                features['sat_delta_ml_norm'] = delta_ml_norm.values

                # Z-score normalize for better transfer
                dm_mean = delta_ml_norm.mean()
                dm_std = delta_ml_norm.std()
                if dm_std > 0:
                    features['sat_delta_ml_zscore'] = ((delta_ml_norm - dm_mean) / dm_std).values

                # Rolling statistics for normalized delta_ml
                for window in [7, 14]:
                    features[f'sat_delta_ml_norm_mean_{window}d'] = delta_ml_norm.rolling(
                        window, min_periods=1
                    ).mean().values

                # Trend (change per day)
                features['sat_delta_ml_norm_trend_7d'] = (delta_ml_norm.diff(7) / 7).fillna(0).values

            # 2. Raw SR from hybrid = P_actual / P_physics (already a ratio)
            if len(p_actual) > 0 and len(p_physics) > 0:
                sr_raw = p_actual / p_physics
                features['sat_sr_raw'] = sr_raw.values

                # Z-score normalize SR for better transfer
                sr_mean = sr_raw.mean()
                sr_std = sr_raw.std()
                if sr_std > 0:
                    features['sat_sr_raw_zscore'] = ((sr_raw - sr_mean) / sr_std).values

                # Rolling SR
                for window in [7, 14]:
                    features[f'sat_sr_raw_mean_{window}d'] = sr_raw.rolling(
                        window, min_periods=1
                    ).mean().values

                # SR trend (soiling accumulation rate)
                features['sat_sr_trend_7d'] = (sr_raw.diff(7) / 7).fillna(0).values

            # Rain features
            if 'days_since_rain' in df_aligned.columns:
                features['sat_days_since_rain'] = df_aligned['days_since_rain'].values

            if 'rainfall' in df_aligned.columns:
                rain = df_aligned['rainfall']
                features['sat_rainfall'] = rain.values
                features['sat_rainfall_7d'] = rain.rolling(7, min_periods=1).sum().values

        except Exception as e:
            print(f"Warning: Could not extract soiling-aware twin features: {e}")

        return features

    def _extract_twin_features(
        self,
        df: pd.DataFrame,
        factory: object,
    ) -> Dict[str, np.ndarray]:
        """Extract features from MultiSignalTwinFactory.

        Features:
        - current_cv: DC current coefficient of variation
        - voltage_cv: DC voltage coefficient of variation
        - temp_deviation: T_actual - T_expected
        - current_loss_pct, voltage_loss_pct, power_loss_pct
        - soiling_signature_score (composite)
        """
        features = {}

        try:
            # Get predictions
            df_result = factory.predict(df)

            # Get soiling features
            soiling_features = factory.get_soiling_features(df_result)

            # Add each feature with rolling statistics
            for key, values in soiling_features.items():
                if isinstance(values, (pd.Series, np.ndarray)):
                    series = pd.Series(values)
                    features[key] = series.values

                    # Rolling statistics
                    for window in [7, 14]:
                        features[f'{key}_mean_{window}d'] = series.rolling(
                            window, min_periods=1
                        ).mean().values

                    # Trend
                    features[f'{key}_trend_7d'] = (series.diff(7) / 7).fillna(0).values

        except Exception as e:
            print(f"Warning: Could not extract twin features: {e}")

        return features

    def _extract_environmental_features(
        self,
        df_daily: pd.DataFrame,
    ) -> Dict[str, np.ndarray]:
        """Extract environmental features from JSON data files.

        Loads and processes:
        - Rain/weather data
        - AOD/dust data
        - Soil moisture (NEW)
        - Sea salt speciation (NEW)
        - MERRA-2 extinction (NEW)
        """
        features = {}
        target_index = df_daily.index

        # 1. Rain/Weather Features
        weather_features = self._load_weather_features(target_index)
        features.update(weather_features)

        # 2. AOD/Dust Features
        aod_features = self._load_aod_features(target_index)
        features.update(aod_features)

        # 3. Soil Moisture (NEW)
        soil_features = self._load_soil_moisture_features(target_index)
        features.update(soil_features)

        # 4. Sea Salt Speciation (NEW)
        seasalt_features = self._load_seasalt_features(target_index)
        features.update(seasalt_features)

        # 5. MERRA-2 Extinction (NEW)
        extinction_features = self._load_extinction_features(target_index)
        features.update(extinction_features)

        return features

    def _create_interaction_features(
        self,
        features: Dict[str, np.ndarray],
        n_samples: int,
    ) -> Dict[str, np.ndarray]:
        """Create physics-motivated interaction features from environmental data.

        These encode domain knowledge about soiling processes:
        - Dust accumulation depends on dust level, low humidity, and low wind
        - Dust transport depends on AOD and dry soil
        - Natural cleaning depends on humidity and wind
        - Soiling rate depends on time since rain and dust level

        All inputs are from external satellite/weather data — no leakage.
        """
        interaction = {}
        zeros = np.zeros(n_samples)

        dust_7d = features.get('dust_aod_mean_7d', zeros)
        aod_7d = features.get('aod_mean_7d', zeros)
        humidity_7d = features.get('humidity_mean_7d')
        wind_7d = features.get('wind_mean_7d')
        is_dry_soil = features.get('is_dry_soil', zeros)
        days_since_rain = features.get('days_since_rain', zeros)

        # 1. Dust accumulation: high dust + low humidity + low wind → fast soiling
        if humidity_7d is not None and wind_7d is not None:
            humidity_norm = np.clip(humidity_7d / 100.0, 0, 1)
            interaction['dust_accumulation'] = (
                dust_7d * (1 - humidity_norm) / (wind_7d + 0.1)
            )

        # 2. Dust transport: high AOD + dry soil → more airborne dust reaches panels
        interaction['dust_transport'] = aod_7d * is_dry_soil

        # 3. Natural cleaning: humidity + wind (dew and wind remove dust)
        if humidity_7d is not None and wind_7d is not None:
            interaction['natural_cleaning'] = (humidity_7d / 100.0) * wind_7d

        # 4. Soiling rate proxy: days since rain × dust level
        interaction['soiling_rate_proxy'] = days_since_rain * dust_7d

        return interaction

    def _load_weather_features(
        self,
        target_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Load rain/weather features including snow."""
        features = {}

        # Try multiple possible file paths - prefer extended weather
        weather_paths = [
            self.data_dir / "weather_extended.json",  # Best source with snow
            self.data_dir / "rain_history.json",
            self.data_dir / "weather.json",
            Path(f"public/data/soiling/{self.plant_id}/weather_extended.json"),
            Path(f"public/data/soiling/{self.plant_id}/rain_history.json"),
        ]

        df_weather = None
        for path in weather_paths:
            if path.exists():
                try:
                    with open(path, 'r') as f:
                        data = json.load(f)
                    df_weather = pd.DataFrame(data.get('daily_data', data))
                    df_weather['date'] = pd.to_datetime(df_weather['date'])
                    df_weather = df_weather.set_index('date')
                    break
                except Exception:
                    continue

        if df_weather is None:
            return features

        # Reindex to target
        df_weather = df_weather.reindex(target_index)

        # Precipitation column
        precip_col = self._find_column(
            df_weather.columns,
            ['precipitation_mm', 'precipitation', 'rain_mm', 'rainfall']
        )

        if precip_col:
            precip = df_weather[precip_col].fillna(0)

            # Rolling sums
            for window in self.ROLLING_WINDOWS:
                features[f'rainfall_{window}d'] = precip.rolling(
                    window, min_periods=1
                ).sum().values

            # Days since significant rain
            is_cleaning_rain = precip >= 5.0
            days_since_rain = self._calculate_days_since(is_cleaning_rain)
            features['days_since_rain'] = days_since_rain

            # Rain intensity indicators
            features['is_heavy_rain'] = (precip >= 10.0).astype(float).values

        # Snow features (only for plants that actually have snow - avoid useless constant columns)
        snow_col = self._find_column(df_weather.columns, ['snowfall_cm', 'snowfall', 'snow'])
        snow_depth_col = self._find_column(df_weather.columns, ['snow_depth_cm', 'snow_depth'])
        temp_col = self._find_column(df_weather.columns, ['temperature_mean', 'temperature', 'temp', 'air_temp'])

        if snow_col:
            snow = df_weather[snow_col].fillna(0)
            # Only add snow features if this location actually has snow
            if snow.sum() > 0:
                features['snowfall'] = snow.values
                features['snowfall_7d'] = snow.rolling(7, min_periods=1).sum().values
                features['has_snow'] = (snow > 0).astype(float).values

                # Days since snow (snow can persist and affect SR measurement)
                is_snow_day = snow > 0.5  # At least 0.5cm snowfall
                features['days_since_snow'] = self._calculate_days_since(is_snow_day)

        if snow_depth_col:
            snow_depth = df_weather[snow_depth_col].fillna(0)
            # Only add if there's actual snow depth data
            if snow_depth.sum() > 0:
                features['snow_depth'] = snow_depth.values
                features['is_snow_covered'] = (snow_depth > 1).astype(float).values  # >1cm cover

        # Estimate snow from temperature + precipitation if no direct snow data
        # Only for temperate climates (skip for Mediterranean plants)
        if snow_col is None and precip_col and temp_col:
            temp = df_weather[temp_col].fillna(10)
            precip = df_weather[precip_col].fillna(0)
            # Snow likely when T < 2°C and precipitation occurs
            estimated_snow = ((temp < 2) & (precip > 0)).astype(float)
            # Only add if there's any estimated snow
            if estimated_snow.sum() > 0:
                features['estimated_snow'] = estimated_snow.values
                features['estimated_snow_7d'] = estimated_snow.rolling(7, min_periods=1).sum().values

        # Humidity
        humid_col = self._find_column(df_weather.columns, ['humidity', 'rh', 'relative_humidity'])
        if humid_col:
            humidity = df_weather[humid_col].ffill().fillna(50)
            features['humidity_mean_7d'] = humidity.rolling(7, min_periods=1).mean().values
            features['is_high_humidity'] = (humidity > 70).astype(float).values

        # Wind
        wind_col = self._find_column(df_weather.columns, ['wind_speed_mean', 'wind_speed', 'wind', 'ws'])
        if wind_col:
            wind = df_weather[wind_col].ffill().fillna(3)
            features['wind_mean_7d'] = wind.rolling(7, min_periods=1).mean().values
            features['is_strong_wind'] = (wind > 8).astype(float).values

        # Dewpoint / Dew cleaning potential
        dewpoint_col = self._find_column(df_weather.columns, ['dewpoint_mean', 'dewpoint', 'dew_point'])
        if dewpoint_col and temp_col:
            dewpoint = df_weather[dewpoint_col].ffill()
            temp = df_weather[temp_col].ffill()
            # Dew forms when T approaches dewpoint
            dew_diff = temp - dewpoint
            features['dew_cleaning_potential'] = np.clip(1 - dew_diff / 10, 0, 1).values

        return features

    def _load_aod_features(
        self,
        target_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Load AOD/dust features."""
        features = {}

        aod_paths = [
            self.data_dir / "aod_history.json",
            self.data_dir / "cams_aerosol.json",
            Path(f"public/data/soiling/{self.plant_id}/aod_history.json"),
        ]

        df_aod = None
        for path in aod_paths:
            if path.exists():
                try:
                    with open(path, 'r') as f:
                        data = json.load(f)
                    df_aod = pd.DataFrame(data.get('daily_data', data))
                    df_aod['date'] = pd.to_datetime(df_aod['date'])
                    df_aod = df_aod.set_index('date')
                    break
                except Exception:
                    continue

        if df_aod is None:
            return features

        df_aod = df_aod.reindex(target_index)

        # Total AOD
        aod_col = self._find_column(df_aod.columns, ['aod_550nm', 'aod', 'total_aod'])
        if aod_col:
            aod = df_aod[aod_col].ffill().fillna(0.1)
            for window in [7, 14]:
                features[f'aod_mean_{window}d'] = aod.rolling(window, min_periods=1).mean().values
            features['is_high_aod'] = (aod > 0.3).astype(float).values

        # Dust AOD
        dust_col = self._find_column(df_aod.columns, ['dust_aod_550nm', 'dust_aod', 'dust'])
        if dust_col:
            dust = df_aod[dust_col].ffill().fillna(0.05)
            for window in [7, 14]:
                features[f'dust_aod_mean_{window}d'] = dust.rolling(window, min_periods=1).mean().values

        # PM10
        pm10_col = self._find_column(df_aod.columns, ['pm10', 'pm_10'])
        if pm10_col:
            pm10 = df_aod[pm10_col].ffill().fillna(20)
            features['pm10_mean_7d'] = pm10.rolling(7, min_periods=1).mean().values

        # PM2.5
        pm25_col = self._find_column(df_aod.columns, ['pm2p5', 'pm25', 'pm_2p5', 'pm_25'])
        if pm25_col:
            pm25 = df_aod[pm25_col].ffill().fillna(10)
            features['pm2p5_mean_7d'] = pm25.rolling(7, min_periods=1).mean().values

        return features

    def _load_soil_moisture_features(
        self,
        target_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Load soil moisture features (NEW).

        Soil moisture affects dust availability:
        - Dry soil = more dust available for transport
        - Wet soil = dust particles bound to ground
        """
        features = {}

        soil_path = self.data_dir / "soil_moisture.json"
        if not soil_path.exists():
            return features

        try:
            with open(soil_path, 'r') as f:
                data = json.load(f)
            df_soil = pd.DataFrame(data.get('daily_data', data))
            df_soil['date'] = pd.to_datetime(df_soil['date'])
            df_soil = df_soil.set_index('date')
            df_soil = df_soil.reindex(target_index)

            # Surface soil moisture (0-7cm)
            sm_col = self._find_column(
                df_soil.columns,
                ['soil_moisture_0_7cm', 'swvl1', 'soil_moisture']
            )
            if sm_col:
                sm = df_soil[sm_col].ffill().fillna(0.2)  # Default ~20% VWC

                features['soil_moisture'] = sm.values
                features['soil_moisture_mean_7d'] = sm.rolling(7, min_periods=1).mean().values

                # Dry soil indicator (< 0.15 m³/m³ = dry conditions)
                features['is_dry_soil'] = (sm < 0.15).astype(float).values

                # Inverse: dust availability score (higher = more dust available)
                features['dust_availability'] = np.clip(1 - sm.values / 0.3, 0, 1)

            # Is dry flag if present
            if 'is_dry_soil' in df_soil.columns:
                dry_days = df_soil['is_dry_soil'].fillna(False).astype(float)
                features['dry_days_7d'] = dry_days.rolling(7, min_periods=1).sum().values

        except Exception as e:
            print(f"Warning: Could not load soil moisture: {e}")

        return features

    def _load_seasalt_features(
        self,
        target_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Load sea salt aerosol features (NEW).

        Sea salt is a major soiling contributor for coastal plants (25-35% of events).
        Only relevant for coastal plants (delta, zeta, gamma, ribera).
        """
        features = {}

        seasalt_path = self.data_dir / "cams_aerosol_speciation.json"
        if not seasalt_path.exists():
            return features

        try:
            with open(seasalt_path, 'r') as f:
                data = json.load(f)
            df_ss = pd.DataFrame(data.get('daily_data', data))
            df_ss['date'] = pd.to_datetime(df_ss['date'])
            df_ss = df_ss.set_index('date')
            df_ss = df_ss.reindex(target_index)

            # Sea salt AOD
            ss_col = self._find_column(
                df_ss.columns,
                ['sea_salt_aod', 'ssaod550', 'sea_salt_aod_550nm']
            )
            if ss_col:
                ss_aod = df_ss[ss_col].ffill().fillna(0.01)

                features['sea_salt_aod'] = ss_aod.values
                features['sea_salt_aod_mean_7d'] = ss_aod.rolling(7, min_periods=1).mean().values

                # High sea salt indicator
                features['is_high_sea_salt'] = (ss_aod > 0.05).astype(float).values

            # Sea salt percentage of total AOD
            if 'sea_salt_pct' in df_ss.columns:
                ss_pct = df_ss['sea_salt_pct'].ffill().fillna(20)
                features['sea_salt_pct'] = ss_pct.values

            # Organic matter AOD (agricultural)
            om_col = self._find_column(
                df_ss.columns,
                ['organic_matter_aod', 'omaod550', 'organic_aod']
            )
            if om_col:
                om_aod = df_ss[om_col].ffill().fillna(0.02)
                features['organic_aod_mean_7d'] = om_aod.rolling(7, min_periods=1).mean().values

            # Sulphate AOD (industrial)
            su_col = self._find_column(
                df_ss.columns,
                ['sulphate_aod', 'suaod550', 'sulfate_aod']
            )
            if su_col:
                su_aod = df_ss[su_col].ffill().fillna(0.01)
                features['sulphate_aod_mean_7d'] = su_aod.rolling(7, min_periods=1).mean().values

        except Exception as e:
            print(f"Warning: Could not load sea salt data: {e}")

        return features

    def _load_extinction_features(
        self,
        target_index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Load MERRA-2 surface extinction features (NEW).

        Surface extinction is a direct measure of dust concentration at panel level,
        more relevant than column-integrated AOD.
        """
        features = {}

        extinction_path = self.data_dir / "merra2_extinction.json"
        if not extinction_path.exists():
            return features

        try:
            with open(extinction_path, 'r') as f:
                data = json.load(f)
            df_ext = pd.DataFrame(data.get('daily_data', data))
            df_ext['date'] = pd.to_datetime(df_ext['date'])
            df_ext = df_ext.set_index('date')
            df_ext = df_ext.reindex(target_index)

            # Dust extinction
            dust_ext_col = self._find_column(
                df_ext.columns,
                ['dust_extinction', 'DUEXTTAU', 'duexttau']
            )
            if dust_ext_col:
                dust_ext = df_ext[dust_ext_col].ffill().fillna(0.05)

                features['dust_extinction'] = dust_ext.values
                features['dust_extinction_mean_7d'] = dust_ext.rolling(7, min_periods=1).mean().values

                # High dust extinction indicator (dust storm)
                features['is_dust_storm'] = (dust_ext > 0.3).astype(float).values

            # Sea salt extinction (for coastal plants)
            ss_ext_col = self._find_column(
                df_ext.columns,
                ['seasalt_extinction', 'SSEXTTAU', 'ssexttau']
            )
            if ss_ext_col:
                ss_ext = df_ext[ss_ext_col].ffill().fillna(0.02)
                features['seasalt_extinction'] = ss_ext.values
                features['seasalt_extinction_mean_7d'] = ss_ext.rolling(7, min_periods=1).mean().values

            # PM2.5 dust extinction (fine particles)
            pm25_ext_col = self._find_column(
                df_ext.columns,
                ['dust_extinction_pm25', 'DUEXTT25']
            )
            if pm25_ext_col:
                pm25_ext = df_ext[pm25_ext_col].ffill().fillna(0.02)
                features['dust_extinction_pm25_mean_7d'] = pm25_ext.rolling(7, min_periods=1).mean().values

        except Exception as e:
            print(f"Warning: Could not load extinction data: {e}")

        return features

    def _create_temporal_features(
        self,
        index: pd.DatetimeIndex,
    ) -> Dict[str, np.ndarray]:
        """Create temporal/seasonal features."""
        features = {}

        # Day of year (cyclical encoding)
        doy = index.dayofyear
        features['day_of_year_sin'] = np.sin(2 * np.pi * doy / 365)
        features['day_of_year_cos'] = np.cos(2 * np.pi * doy / 365)

        # Month (cyclical encoding)
        month = index.month
        features['month_sin'] = np.sin(2 * np.pi * month / 12)
        features['month_cos'] = np.cos(2 * np.pi * month / 12)

        # Season indicators
        climate = self.config.climate_zone
        if climate == "mediterranean":
            dry_months = [5, 6, 7, 8, 9]
        elif climate == "arid":
            dry_months = list(range(1, 13))
        else:
            dry_months = [6, 7, 8]

        features['is_dry_season'] = np.isin(month, dry_months).astype(float)

        return features

    def _create_location_features(self, n_rows: int) -> Dict[str, np.ndarray]:
        """Create static location features."""
        features = {}

        features['latitude_abs'] = np.full(n_rows, abs(self.config.latitude))
        features['altitude_m'] = np.full(n_rows, self.config.altitude)
        features['is_coastal'] = np.full(n_rows, float(self.config.is_coastal))

        return features

    def _calculate_days_since(self, is_event: pd.Series, max_days: int = 30) -> np.ndarray:
        """Calculate days since last event, capped at max_days.

        The cap prevents creating a linear time trend when events are rare/absent,
        which would cause spurious correlations in the model.
        """
        days_since = np.zeros(len(is_event))
        current_count = max_days  # Default if no event found

        for i in range(len(is_event)):
            if is_event.iloc[i]:
                current_count = 0
            else:
                current_count = min(current_count + 1, max_days)  # Cap at max_days
            days_since[i] = current_count

        return days_since

    def _find_column(
        self,
        columns: Union[pd.Index, List[str]],
        patterns: List[str],
    ) -> Optional[str]:
        """Find column matching patterns."""
        for pattern in patterns:
            pattern_lower = pattern.lower()
            for col in columns:
                if pattern_lower in col.lower():
                    return col
        return None

    def get_feature_names(self) -> List[str]:
        """Return list of feature names after extract_features() has been called."""
        return self.feature_names

    def get_feature_groups(self) -> Dict[str, List[str]]:
        """Return features grouped by category."""
        groups = {
            'hybrid_model': [],
            'digital_twin': [],
            'rain_weather': [],
            'aod_dust': [],
            'soil_moisture': [],
            'sea_salt': [],
            'extinction': [],
            'temporal': [],
            'location': [],
        }

        for name in self.feature_names:
            name_lower = name.lower()

            if any(x in name_lower for x in ['p_physics', 'p_hybrid', 'ml_residual', 'physics_loss', 'hybrid_loss']):
                groups['hybrid_model'].append(name)
            elif any(x in name_lower for x in ['current_cv', 'voltage_cv', 'temp_deviation', 'soiling_signature']):
                groups['digital_twin'].append(name)
            elif any(x in name_lower for x in ['rain', 'precipitation', 'humidity', 'wind', 'dew']):
                groups['rain_weather'].append(name)
            elif any(x in name_lower for x in ['aod', 'dust_aod', 'pm10', 'pm2p5']):
                groups['aod_dust'].append(name)
            elif any(x in name_lower for x in ['soil_moisture', 'dry_soil', 'dust_availability']):
                groups['soil_moisture'].append(name)
            elif any(x in name_lower for x in ['sea_salt', 'organic_aod', 'sulphate']):
                groups['sea_salt'].append(name)
            elif any(x in name_lower for x in ['extinction']):
                groups['extinction'].append(name)
            elif any(x in name_lower for x in ['day_of_year', 'month', 'season']):
                groups['temporal'].append(name)
            elif any(x in name_lower for x in ['latitude', 'altitude', 'coastal']):
                groups['location'].append(name)

        return {k: v for k, v in groups.items() if v}


def extract_transfer_features(
    plant_id: str,
    df_scada: pd.DataFrame,
    hybrid_model: Optional[object] = None,
    multi_signal_factory: Optional[object] = None,
) -> pd.DataFrame:
    """Convenience function to extract transfer learning features.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    df_scada : pd.DataFrame
        SCADA data
    hybrid_model : HybridModel, optional
        Trained HybridModel
    multi_signal_factory : MultiSignalTwinFactory, optional
        Trained digital twin factory

    Returns
    -------
    pd.DataFrame
        Feature matrix for transfer learning
    """
    extractor = EnhancedFeatureExtractor(plant_id)
    return extractor.extract_features(
        df_scada,
        hybrid_model=hybrid_model,
        multi_signal_factory=multi_signal_factory,
    )
