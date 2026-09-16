"""
Plant Climate Similarity Scoring for Transfer Learning.

This module calculates climate similarity between plants to determine
the best source plant for transfer learning. Plants with similar climate
characteristics will have similar soiling patterns.

Similarity factors:
- Latitude (30%): Solar angle patterns
- Humidity (25%): Dust adhesion behavior
- AOD levels (25%): Dust exposure intensity
- Coastal proximity (10%): Marine aerosol influence
- Altitude (10%): Climate effects on soiling
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any

import numpy as np
import pandas as pd

from .transfer_performance_registry import (
    TransferPerformanceRegistry,
    get_registry,
    get_best_transfer_source,
)


@dataclass
class PlantClimateProfile:
    """Climate profile for a plant used in similarity scoring."""

    plant_id: str
    latitude: float
    longitude: float
    altitude_m: float = 0.0
    is_coastal: bool = False
    distance_to_coast_km: float = 100.0

    # Aggregated climate metrics (from weather data)
    avg_humidity: float = 50.0  # Annual average humidity %
    avg_aod: float = 0.15  # Annual average AOD
    avg_temperature: float = 20.0  # Annual average temperature C
    annual_rainfall_mm: float = 500.0

    # Has DustIQ sensor
    has_dustiq: bool = False

    def to_dict(self) -> dict:
        return {
            "plant_id": self.plant_id,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "altitude_m": self.altitude_m,
            "is_coastal": self.is_coastal,
            "distance_to_coast_km": self.distance_to_coast_km,
            "avg_humidity": self.avg_humidity,
            "avg_aod": self.avg_aod,
            "avg_temperature": self.avg_temperature,
            "annual_rainfall_mm": self.annual_rainfall_mm,
            "has_dustiq": self.has_dustiq,
        }


# Known plant climate profiles
# These are pre-computed from weather/AOD data
# Note: All plants in the current portfolio have DustIQ sensors
PLANT_PROFILES = {
    "epsilon": PlantClimateProfile(
        plant_id="epsilon",
        latitude=51,
        longitude=14.5,
        altitude_m=150,
        is_coastal=False,
        distance_to_coast_km=500,
        avg_humidity=70,
        avg_aod=0.12,
        avg_temperature=10,
        annual_rainfall_mm=600,
        has_dustiq=True,
    ),
    "zeta": PlantClimateProfile(
        plant_id="zeta",
        latitude=39.5,
        longitude=3,
        altitude_m=50,
        is_coastal=True,
        distance_to_coast_km=10,
        avg_humidity=65,
        avg_aod=0.15,
        avg_temperature=18,
        annual_rainfall_mm=450,
        has_dustiq=True,
    ),
    "ribera": PlantClimateProfile(
        plant_id="ribera",
        latitude=38,
        longitude=-1,
        altitude_m=100,
        is_coastal=False,
        distance_to_coast_km=50,
        avg_humidity=55,
        avg_aod=0.18,
        avg_temperature=18,
        annual_rainfall_mm=300,
        has_dustiq=True,
    ),
    "delta": PlantClimateProfile(
        plant_id="delta",
        latitude=39.5,
        longitude=2.5,
        altitude_m=30,
        is_coastal=True,
        distance_to_coast_km=5,
        avg_humidity=68,
        avg_aod=0.14,
        avg_temperature=17,
        annual_rainfall_mm=400,
        has_dustiq=True,
    ),
    "gamma": PlantClimateProfile(
        plant_id="gamma",
        latitude=39.5,
        longitude=3,
        altitude_m=40,
        is_coastal=True,
        distance_to_coast_km=15,
        avg_humidity=65,
        avg_aod=0.15,
        avg_temperature=17,
        annual_rainfall_mm=420,
        has_dustiq=True,
    ),
    "eta": PlantClimateProfile(
        plant_id="eta",
        latitude=38.5,
        longitude=-5.5,
        altitude_m=400,
        is_coastal=False,
        distance_to_coast_km=200,
        avg_humidity=50,
        avg_aod=0.20,
        avg_temperature=16,
        annual_rainfall_mm=450,
        has_dustiq=True,
    ),
    "alpha": PlantClimateProfile(
        plant_id="alpha",
        latitude=38,
        longitude=-4,
        altitude_m=200,
        is_coastal=False,
        distance_to_coast_km=150,
        avg_humidity=52,
        avg_aod=0.19,
        avg_temperature=17,
        annual_rainfall_mm=350,
        has_dustiq=True,
    ),
}


class PlantSimilarityScorer:
    """Calculate climate similarity between plants for transfer learning.

    Similarity is calculated using weighted factors:
    - Latitude (30%): Solar angle patterns
    - Humidity (25%): Dust adhesion behavior
    - AOD levels (25%): Dust exposure intensity
    - Coastal proximity (10%): Marine aerosol influence
    - Altitude (10%): Climate effects on soiling

    Attributes
    ----------
    weights : dict
        Factor weights for similarity calculation
    profiles : dict
        Plant climate profiles
    """

    DEFAULT_WEIGHTS = {
        "latitude": 0.5,
        "humidity": 0.25,
        "aod": 0.25,
        "coastal": 0.10,
        "altitude": 0.10,
    }

    # Normalization ranges for each factor
    NORM_RANGES = {
        "latitude": 20.0,  # degrees (e.g., 35-55)
        "humidity": 40.0,  # % (e.g., 40-80)
        "aod": 0.20,  # units (e.g., 0.05-0.25)
        "altitude": 500.0,  # meters (e.g., 0-500)
        "distance_to_coast": 200.0,  # km
    }

    def __init__(
        self,
        weights: Optional[Dict[str, float]] = None,
        profiles: Optional[Dict[str, PlantClimateProfile]] = None,
    ):
        """Initialize similarity scorer.

        Parameters
        ----------
        weights : dict, optional
            Custom factor weights (must sum to 1.0)
        profiles : dict, optional
            Plant climate profiles (uses defaults if None)
        """
        self.weights = weights or self.DEFAULT_WEIGHTS.copy()
        self.profiles = profiles or PLANT_PROFILES.copy()

        # Validate weights
        total = sum(self.weights.values())
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"Weights must sum to 1.0, got {total}")

    def get_profile(self, plant_id: str) -> Optional[PlantClimateProfile]:
        """Get climate profile for a plant."""
        return self.profiles.get(plant_id)

    def add_profile(self, profile: PlantClimateProfile) -> None:
        """Add or update a plant profile."""
        self.profiles[profile.plant_id] = profile

    def calculate_similarity(
        self,
        plant_a: str,
        plant_b: str,
    ) -> float:
        """Calculate similarity score between two plants.

        Parameters
        ----------
        plant_a : str
            First plant ID
        plant_b : str
            Second plant ID

        Returns
        -------
        float
            Similarity score (0-1, where 1 = identical climate)
        """
        if plant_a == plant_b:
            return 1.0

        profile_a = self.profiles.get(plant_a)
        profile_b = self.profiles.get(plant_b)

        if profile_a is None or profile_b is None:
            return 0.0

        # Calculate normalized differences for each factor
        lat_diff = abs(profile_a.latitude - profile_b.latitude) / self.NORM_RANGES["latitude"]
        hum_diff = abs(profile_a.avg_humidity - profile_b.avg_humidity) / self.NORM_RANGES["humidity"]
        aod_diff = abs(profile_a.avg_aod - profile_b.avg_aod) / self.NORM_RANGES["aod"]
        alt_diff = abs(profile_a.altitude_m - profile_b.altitude_m) / self.NORM_RANGES["altitude"]

        # Coastal similarity (binary comparison + distance)
        if profile_a.is_coastal == profile_b.is_coastal:
            coastal_diff = 0.0
        else:
            # If one is coastal and one is not, calculate based on distance
            coastal_diff = 0.5  # Base difference for coastal mismatch

        # Convert differences to similarities (1 - diff, clamped to [0, 1])
        lat_sim = max(0, 1 - lat_diff)
        hum_sim = max(0, 1 - hum_diff)
        aod_sim = max(0, 1 - aod_diff)
        alt_sim = max(0, 1 - alt_diff)
        coastal_sim = 1 - coastal_diff

        # Weighted combination
        similarity = (
            self.weights["latitude"] * lat_sim +
            self.weights["humidity"] * hum_sim +
            self.weights["aod"] * aod_sim +
            self.weights["altitude"] * alt_sim +
            self.weights["coastal"] * coastal_sim
        )

        return float(np.clip(similarity, 0, 1))

    def get_similarity_matrix(
        self,
        plant_ids: Optional[List[str]] = None,
    ) -> pd.DataFrame:
        """Calculate pairwise similarity matrix for all plants.

        Parameters
        ----------
        plant_ids : list, optional
            Plant IDs to include (uses all known plants if None)

        Returns
        -------
        pd.DataFrame
            Symmetric similarity matrix
        """
        if plant_ids is None:
            plant_ids = list(self.profiles.keys())

        n = len(plant_ids)
        matrix = np.zeros((n, n))

        for i, plant_a in enumerate(plant_ids):
            for j, plant_b in enumerate(plant_ids):
                if i == j:
                    matrix[i, j] = 1.0
                elif i < j:
                    sim = self.calculate_similarity(plant_a, plant_b)
                    matrix[i, j] = sim
                    matrix[j, i] = sim

        return pd.DataFrame(matrix, index=plant_ids, columns=plant_ids)

    def get_best_transfer_source(
        self,
        target_plant: str,
        dustiq_plants_only: bool = True,
        min_similarity: float = 0.0,
    ) -> Optional[Tuple[str, float]]:
        """Find the best source plant for transfer learning.

        Parameters
        ----------
        target_plant : str
            Target plant that needs SR estimation
        dustiq_plants_only : bool
            Only consider plants with DustIQ sensors as sources
        min_similarity : float
            Minimum similarity threshold (default 0)

        Returns
        -------
        tuple or None
            (source_plant_id, similarity_score) or None if no suitable source
        """
        best_source = None
        best_score = min_similarity

        for plant_id, profile in self.profiles.items():
            if plant_id == target_plant:
                continue

            if dustiq_plants_only and not profile.has_dustiq:
                continue

            score = self.calculate_similarity(target_plant, plant_id)
            if score > best_score:
                best_score = score
                best_source = plant_id

        if best_source is None:
            return None

        return (best_source, best_score)

    def get_ranked_transfer_sources(
        self,
        target_plant: str,
        dustiq_plants_only: bool = True,
        top_k: int = 5,
    ) -> List[Tuple[str, float]]:
        """Get ranked list of potential transfer source plants.

        Parameters
        ----------
        target_plant : str
            Target plant
        dustiq_plants_only : bool
            Only consider DustIQ-equipped plants
        top_k : int
            Number of top sources to return

        Returns
        -------
        list of tuples
            [(plant_id, similarity_score), ...] sorted by similarity descending
        """
        candidates = []

        for plant_id, profile in self.profiles.items():
            if plant_id == target_plant:
                continue

            if dustiq_plants_only and not profile.has_dustiq:
                continue

            score = self.calculate_similarity(target_plant, plant_id)
            candidates.append((plant_id, score))

        # Sort by similarity descending
        candidates.sort(key=lambda x: x[1], reverse=True)

        return candidates[:top_k]

    def get_dustiq_plants(self) -> List[str]:
        """Get list of plants with DustIQ sensors."""
        return [
            plant_id
            for plant_id, profile in self.profiles.items()
            if profile.has_dustiq
        ]

    def update_profile_from_data(
        self,
        plant_id: str,
        data_dir: Path,
    ) -> Optional[PlantClimateProfile]:
        """Update plant profile from actual weather/AOD data files.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        data_dir : Path
            Directory containing plant data files

        Returns
        -------
        PlantClimateProfile or None
            Updated profile, or None if data not available
        """
        weather_path = data_dir / plant_id / "weather_extended.json"
        aod_path = data_dir / plant_id / "aod_history.json"

        if not weather_path.exists():
            return None

        # Get existing profile or create new one
        profile = self.profiles.get(plant_id)
        if profile is None:
            # Create with placeholder values
            profile = PlantClimateProfile(
                plant_id=plant_id,
                latitude=40.0,  # Will be updated from data
                longitude=0.0,
            )

        try:
            # Update from weather data
            with open(weather_path) as f:
                weather = json.load(f)

            daily = weather.get("daily_data", [])
            if daily:
                df_weather = pd.DataFrame(daily)
                if "relative_humidity_mean" in df_weather.columns:
                    profile.avg_humidity = float(df_weather["relative_humidity_mean"].mean())
                if "precipitation_mm" in df_weather.columns:
                    profile.annual_rainfall_mm = float(df_weather["precipitation_mm"].sum())
                if "temperature_mean" in df_weather.columns:
                    profile.avg_temperature = float(df_weather["temperature_mean"].mean())

            # Update from AOD data
            if aod_path.exists():
                with open(aod_path) as f:
                    aod = json.load(f)
                daily_aod = aod.get("daily_data", [])
                if daily_aod:
                    df_aod = pd.DataFrame(daily_aod)
                    if "aod_550nm" in df_aod.columns:
                        profile.avg_aod = float(df_aod["aod_550nm"].mean())

            # Update profile in cache
            self.profiles[plant_id] = profile
            return profile

        except Exception as e:
            print(f"Error updating profile for {plant_id}: {e}")
            return None

    def get_validated_source(
        self,
        target_plant: str,
        min_similarity: float = 0.5,
        max_mae: float = 0.02,
    ) -> Dict[str, Any]:
        """
        Get the best transfer source using MAE-validated results with similarity fallback.

        This is the recommended method for production source selection.

        Strategy:
        1. First, check for validated MAE results (cross-validated on DustIQ data)
        2. If validated result exists, use source with best MAE
        3. If no validated result, fall back to climate similarity scoring

        Parameters
        ----------
        target_plant : str
            Target plant ID
        min_similarity : float
            Minimum similarity threshold for fallback (default 0.5)
        max_mae : float
            Maximum acceptable MAE for validated results (default 2%)

        Returns
        -------
        dict
            {
                'source_plant': str,
                'method': 'validated' | 'similarity',
                'mae': float or None (if similarity-based),
                'similarity': float,
                'confidence': str ('high' | 'medium' | 'low'),
                'reason': str
            }
        """
        registry = get_registry()

        # Try MAE-validated source first (prioritizes correlation over MAE)
        validated = registry.get_best_source(target_plant)

        if validated:
            source, mae, corr, method = validated

            # Also compute similarity for display
            similarity = self.calculate_similarity(target_plant, source)

            # Confidence based on correlation (pattern tracking)
            if corr >= 0.7:
                confidence = 'high'
            elif corr >= 0.5:
                confidence = 'medium'
            else:
                confidence = 'low'

            return {
                'source_plant': source,
                'method': 'validated',
                'mae': mae,
                'correlation': corr,
                'similarity': similarity,
                'confidence': confidence,
                'reason': f"Validated: MAE={mae*100:.2f}%, ρ={corr:.2f} (cross-validated)",
            }

        # Fall back to similarity-based selection
        best_source = self.get_best_transfer_source(
            target_plant,
            dustiq_plants_only=True,
            min_similarity=min_similarity,
        )

        if best_source:
            source, similarity = best_source

            return {
                'source_plant': source,
                'method': 'similarity',
                'mae': None,  # Unknown without validation
                'correlation': None,  # Unknown without validation
                'similarity': similarity,
                'confidence': 'medium' if similarity >= 0.7 else 'low',
                'reason': f"Climate similarity: {similarity*100:.0f}% (no validated MAE available)",
            }

        # No suitable source found
        return {
            'source_plant': None,
            'method': 'none',
            'mae': None,
            'correlation': None,
            'similarity': 0.0,
            'confidence': 'none',
            'reason': "No suitable transfer source found. Consider foundation model.",
        }

    def select_source_for_new_plant(
        self,
        latitude: float,
        is_coastal: bool,
        region: str = 'unknown',
    ) -> Dict[str, Any]:
        """
        Select best transfer source for a NEW plant without DustIQ.

        Based on validated cross-validation results, this method uses geographic
        and climate heuristics to select the most reliable source plant.

        Universal sources (work for most targets):
        - ALPHA: 83% success rate, works for coastal and inland
        - DELTA: Best for Balearic Islands (ρ≈0.83)

        Parameters
        ----------
        latitude : float
            Target plant latitude
        is_coastal : bool
            Whether target is coastal
        region : str
            Region hint: 'balearic', 'spain_southeast', 'spain', 'europe', 'unknown'

        Returns
        -------
        dict
            {
                'source_plant': str,
                'expected_correlation': float,
                'confidence': str,
                'reason': str,
            }
        """
        # Special case: Balearic Islands
        if region == 'balearic' or (39.0 < latitude < 40.0 and is_coastal):
            return {
                'source_plant': 'delta',
                'expected_correlation': 0.83,
                'confidence': 'high',
                'reason': 'Balearic Islands microclimate (validated ρ=0.83)',
            }

        # Special case: Southeast Spain inland
        if latitude < 38.5 and not is_coastal and region in ('spain_southeast', 'spain', 'unknown'):
            return {
                'source_plant': 'gamma',
                'expected_correlation': 0.80,
                'confidence': 'high',
                'reason': 'Southeast Spain inland (validated ρ=0.80 for ribera)',
            }

        # Coastal Mediterranean Spain
        if is_coastal and 36 < latitude < 42:
            return {
                'source_plant': 'alpha',
                'expected_correlation': 0.58,
                'confidence': 'medium',
                'reason': 'Coastal Mediterranean - alpha is universal (ρ≈0.55-0.61)',
            }

        # Inland Spain
        if not is_coastal and 36 < latitude < 42:
            return {
                'source_plant': 'alpha',
                'expected_correlation': 0.60,
                'confidence': 'medium',
                'reason': 'Inland Spain - alpha is universal (ρ≈0.50-0.70)',
            }

        # Central/Northern Europe
        if latitude > 45:
            return {
                'source_plant': 'alpha',
                'expected_correlation': 0.51,
                'confidence': 'low',
                'reason': 'Central Europe - alpha only reliable option (ρ≈0.51)',
            }

        # Default fallback: ALPHA (83% success rate)
        return {
            'source_plant': 'alpha',
            'expected_correlation': 0.55,
            'confidence': 'medium',
            'reason': 'Default: alpha has 83% success rate across all targets',
        }


# Thresholds for source selection quality
MIN_SIMILARITY = 0.5  # Minimum acceptable climate similarity
RECOMMENDED_SIMILARITY = 0.7  # Recommended for good transfer
MAX_ACCEPTABLE_MAE = 0.02  # 2% maximum acceptable transfer MAE


def get_validated_transfer_source(
    target_plant: str,
    min_similarity: float = MIN_SIMILARITY,
) -> Dict[str, Any]:
    """
    Get the best transfer source for a target plant.

    Convenience function that uses MAE-validated results with similarity fallback.

    Parameters
    ----------
    target_plant : str
        Target plant ID

    Returns
    -------
    dict
        Source selection result with method, MAE, similarity, and confidence
    """
    scorer = PlantSimilarityScorer()
    return scorer.get_validated_source(target_plant, min_similarity)
