"""
Bootstrap Pipeline for soiling ratio estimation on new plants.

This module provides a 90-day progressive improvement pipeline for plants
without DustIQ sensors and without nearby reference data.

Phases:
- Day 0-30:  Foundation model only + rain calibration anchors
- Day 30-60: Foundation calibrated using rain-reset SR=1.0 points
- Day 60-90: Build plant-specific residual model
- Day 90+:   Full hybrid (foundation + plant-specific + rain anchors)

Key features:
1. Rain calibration: Heavy rain events (>10mm) reset SR to ~1.0
2. Progressive improvement: Model accuracy improves as data accumulates
3. Conservative fallback: Always maintains negative MBE bias

Usage:
    from nuravolt.soiling.sr_bootstrap_pipeline import BootstrapPipeline

    pipeline = BootstrapPipeline(plant_id="new_plant")
    pipeline.initialize_with_foundation_model(foundation_model)

    # Daily update
    sr_estimate = pipeline.estimate_daily_sr(features, rainfall_mm)
    pipeline.update_with_observation(date, features, power_actual, power_expected)
"""

import pickle
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')


class BootstrapPhase(Enum):
    """Current phase of the bootstrap pipeline."""
    FOUNDATION_ONLY = "foundation_only"           # Day 0-30
    FOUNDATION_CALIBRATED = "foundation_calibrated"  # Day 30-60
    HYBRID_BUILDING = "hybrid_building"           # Day 60-90
    FULL_HYBRID = "full_hybrid"                   # Day 90+


@dataclass
class RainCalibrationPoint:
    """A rain event that serves as SR=1.0 anchor point."""
    date: datetime
    rainfall_mm: float
    days_since_rain: int = 0
    estimated_sr: float = 1.0
    confidence: float = 1.0


@dataclass
class BootstrapConfig:
    """Configuration for bootstrap pipeline."""
    # Phase thresholds (days)
    phase1_end: int = 30
    phase2_end: int = 60
    phase3_end: int = 90

    # Rain calibration
    heavy_rain_threshold_mm: float = 10.0  # mm for SR reset
    moderate_rain_threshold_mm: float = 5.0  # mm for partial reset
    rain_reset_sr: float = 0.995  # SR after heavy rain (not quite 1.0)
    rain_decay_rate: float = 0.002  # SR decay per day without rain

    # Conservative bias
    foundation_bias: float = 0.02  # 2% safety margin
    calibration_bias: float = 0.01  # 1% additional during calibration

    # Minimum data requirements
    min_rain_events_for_calibration: int = 3
    min_days_for_residual_model: int = 45


@dataclass
class DailyObservation:
    """Observed data for a single day (used for self-calibration)."""
    date: datetime
    features: np.ndarray
    power_actual: float  # Actual power produced
    power_expected: float  # Expected power (from digital twin)
    rainfall_mm: float = 0.0
    is_rain_day: bool = False
    performance_ratio: float = 1.0  # PR = actual/expected


class BootstrapPipeline:
    """Progressive improvement pipeline for new plants without DustIQ."""

    def __init__(
        self,
        plant_id: str,
        config: Optional[BootstrapConfig] = None,
    ):
        """
        Parameters
        ----------
        plant_id : str
            Plant identifier
        config : BootstrapConfig, optional
            Pipeline configuration
        """
        self.plant_id = plant_id
        self.config = config or BootstrapConfig()

        # State
        self.foundation_model = None
        self.residual_model = None
        self.days_of_data: int = 0
        self.start_date: Optional[datetime] = None

        # History
        self.observations: List[DailyObservation] = []
        self.rain_anchors: List[RainCalibrationPoint] = []
        self.calibration_offset: float = 0.0

        # SR estimates
        self.sr_history: Dict[datetime, Dict] = {}

    @property
    def current_phase(self) -> BootstrapPhase:
        """Get current bootstrap phase based on days of data."""
        if self.days_of_data < self.config.phase1_end:
            return BootstrapPhase.FOUNDATION_ONLY
        elif self.days_of_data < self.config.phase2_end:
            return BootstrapPhase.FOUNDATION_CALIBRATED
        elif self.days_of_data < self.config.phase3_end:
            return BootstrapPhase.HYBRID_BUILDING
        else:
            return BootstrapPhase.FULL_HYBRID

    def initialize_with_foundation_model(self, foundation_model) -> None:
        """Initialize pipeline with pre-trained foundation model.

        Parameters
        ----------
        foundation_model : SoilingFoundationModel
            Pre-trained foundation model
        """
        self.foundation_model = foundation_model
        self.start_date = datetime.now()
        print(f"Pipeline initialized for {self.plant_id}")
        print(f"  Foundation model loaded: {foundation_model.is_trained}")
        print(f"  Conservative bias: {self.config.foundation_bias*100:.1f}%")

    def estimate_daily_sr(
        self,
        features: np.ndarray,
        rainfall_mm: float = 0.0,
        date: Optional[datetime] = None,
    ) -> Tuple[float, float, Dict]:
        """Estimate soiling ratio for a day.

        Parameters
        ----------
        features : np.ndarray
            Feature vector for the day
        rainfall_mm : float
            Daily rainfall (mm)
        date : datetime, optional
            Date of estimation

        Returns
        -------
        Tuple[float, float, Dict]
            (sr_estimate, confidence, metadata)
        """
        date = date or datetime.now()

        # Check for rain reset
        if rainfall_mm >= self.config.heavy_rain_threshold_mm:
            sr_estimate = self.config.rain_reset_sr
            confidence = 0.95  # High confidence in rain reset
            method = "rain_reset"

            # Add to rain anchors
            self.rain_anchors.append(RainCalibrationPoint(
                date=date,
                rainfall_mm=rainfall_mm,
                estimated_sr=sr_estimate,
            ))

        else:
            # Use phase-appropriate estimation
            phase = self.current_phase

            if phase == BootstrapPhase.FOUNDATION_ONLY:
                sr_estimate, confidence, method = self._estimate_foundation_only(features)

            elif phase == BootstrapPhase.FOUNDATION_CALIBRATED:
                sr_estimate, confidence, method = self._estimate_foundation_calibrated(features)

            elif phase == BootstrapPhase.HYBRID_BUILDING:
                sr_estimate, confidence, method = self._estimate_hybrid_building(features)

            else:  # FULL_HYBRID
                sr_estimate, confidence, method = self._estimate_full_hybrid(features)

            # Apply rain decay if recent rain
            sr_estimate = self._apply_rain_decay(sr_estimate, date)

        # Store in history
        self.sr_history[date] = {
            'sr_estimate': sr_estimate,
            'confidence': confidence,
            'method': method,
            'phase': self.current_phase.value,
            'rainfall_mm': rainfall_mm,
        }

        metadata = {
            'phase': self.current_phase.value,
            'method': method,
            'days_of_data': self.days_of_data,
            'calibration_offset': self.calibration_offset,
            'n_rain_anchors': len(self.rain_anchors),
        }

        return sr_estimate, confidence, metadata

    def _estimate_foundation_only(self, features: np.ndarray) -> Tuple[float, float, str]:
        """Phase 1: Foundation model prediction only."""
        if self.foundation_model is None:
            return 0.95, 0.5, "fallback"

        # Get foundation prediction (already has bias)
        pred = self.foundation_model.predict(
            features.reshape(1, -1),
            apply_bias=True,
        )[0]

        # Add extra conservative bias during early phase
        pred = pred - self.config.calibration_bias
        pred = np.clip(pred, 0.7, 1.0)

        return float(pred), 0.6, "foundation"

    def _estimate_foundation_calibrated(self, features: np.ndarray) -> Tuple[float, float, str]:
        """Phase 2: Foundation + rain calibration offset."""
        if self.foundation_model is None:
            return 0.95, 0.5, "fallback"

        # Get foundation prediction
        pred = self.foundation_model.predict(
            features.reshape(1, -1),
            apply_bias=True,
        )[0]

        # Apply calibration offset from rain anchors
        self._update_calibration_offset()
        pred = pred + self.calibration_offset

        pred = np.clip(pred, 0.7, 1.0)

        return float(pred), 0.7, "foundation_calibrated"

    def _estimate_hybrid_building(self, features: np.ndarray) -> Tuple[float, float, str]:
        """Phase 3: Foundation + calibration + building residual model."""
        # Start with calibrated foundation
        pred, _, _ = self._estimate_foundation_calibrated(features)

        # If we have enough data, add residual model prediction
        if self.residual_model is not None:
            try:
                residual = self.residual_model.predict(features.reshape(1, -1))[0]
                pred = pred + residual
                pred = np.clip(pred, 0.7, 1.0)
                return float(pred), 0.75, "hybrid_building"
            except Exception:
                pass

        return float(pred), 0.7, "foundation_calibrated"

    def _estimate_full_hybrid(self, features: np.ndarray) -> Tuple[float, float, str]:
        """Phase 4: Full hybrid model."""
        # Start with calibrated foundation
        foundation_pred = self.foundation_model.predict(
            features.reshape(1, -1),
            apply_bias=False,  # We'll manage bias ourselves
        )[0]

        # Apply calibration offset
        calibrated_pred = foundation_pred + self.calibration_offset

        # Add residual model correction
        if self.residual_model is not None:
            try:
                residual = self.residual_model.predict(features.reshape(1, -1))[0]
                hybrid_pred = calibrated_pred + residual
            except Exception:
                hybrid_pred = calibrated_pred
        else:
            hybrid_pred = calibrated_pred

        # Apply conservative bias
        final_pred = hybrid_pred - self.config.foundation_bias
        final_pred = np.clip(final_pred, 0.7, 1.0)

        return float(final_pred), 0.85, "full_hybrid"

    def _apply_rain_decay(self, sr_estimate: float, date: datetime) -> float:
        """Apply SR decay based on days since last rain."""
        if not self.rain_anchors:
            return sr_estimate

        # Find most recent rain
        recent_rain = max(self.rain_anchors, key=lambda x: x.date)
        days_since_rain = (date - recent_rain.date).days

        if days_since_rain <= 0:
            return sr_estimate

        # Decay from rain anchor
        decay = self.config.rain_decay_rate * days_since_rain
        decayed_sr = recent_rain.estimated_sr - decay

        # SR cannot be higher than decayed anchor value
        return min(sr_estimate, decayed_sr)

    def _update_calibration_offset(self) -> None:
        """Update calibration offset based on rain anchors and observations."""
        if len(self.rain_anchors) < self.config.min_rain_events_for_calibration:
            self.calibration_offset = 0.0
            return

        # Compare foundation predictions at rain anchor days with expected SR=1.0
        offsets = []

        for anchor in self.rain_anchors[-10:]:  # Use last 10 rain events
            # Find observation for this day
            obs = next(
                (o for o in self.observations if o.date == anchor.date),
                None
            )
            if obs is not None:
                # Foundation prediction at rain day
                foundation_pred = self.foundation_model.predict(
                    obs.features.reshape(1, -1),
                    apply_bias=False,
                )[0]

                # Offset = expected - predicted (should be ~0 if model is good)
                offset = anchor.estimated_sr - foundation_pred
                offsets.append(offset)

        if offsets:
            # Use median offset (robust to outliers)
            self.calibration_offset = float(np.median(offsets))

    def update_with_observation(
        self,
        date: datetime,
        features: np.ndarray,
        power_actual: float,
        power_expected: float,
        rainfall_mm: float = 0.0,
    ) -> None:
        """Update pipeline with new observation.

        This should be called daily as new data becomes available.

        Parameters
        ----------
        date : datetime
            Observation date
        features : np.ndarray
            Feature vector
        power_actual : float
            Actual power produced
        power_expected : float
            Expected power from digital twin
        rainfall_mm : float
            Daily rainfall
        """
        # Create observation
        pr = power_actual / power_expected if power_expected > 0 else 1.0
        obs = DailyObservation(
            date=date,
            features=features,
            power_actual=power_actual,
            power_expected=power_expected,
            rainfall_mm=rainfall_mm,
            is_rain_day=rainfall_mm >= self.config.moderate_rain_threshold_mm,
            performance_ratio=pr,
        )

        self.observations.append(obs)
        self.days_of_data = len(self.observations)

        # Check if heavy rain (add anchor)
        if rainfall_mm >= self.config.heavy_rain_threshold_mm:
            self.rain_anchors.append(RainCalibrationPoint(
                date=date,
                rainfall_mm=rainfall_mm,
            ))

        # Update calibration if we have enough rain events
        if self.current_phase in [
            BootstrapPhase.FOUNDATION_CALIBRATED,
            BootstrapPhase.HYBRID_BUILDING,
            BootstrapPhase.FULL_HYBRID,
        ]:
            self._update_calibration_offset()

        # Train residual model if in hybrid building phase
        if (self.current_phase == BootstrapPhase.HYBRID_BUILDING and
            self.days_of_data >= self.config.min_days_for_residual_model):
            self._train_residual_model()

    def _train_residual_model(self) -> None:
        """Train plant-specific residual model."""
        if len(self.observations) < self.config.min_days_for_residual_model:
            return

        try:
            from catboost import CatBoostRegressor

            # Prepare training data
            X = np.vstack([obs.features for obs in self.observations])
            y_pr = np.array([obs.performance_ratio for obs in self.observations])

            # Foundation predictions
            y_foundation = self.foundation_model.predict(X, apply_bias=False)

            # Residuals = observed PR - foundation prediction
            # (PR is similar to SR but derived from power)
            y_residual = y_pr - y_foundation

            # Train residual model (simpler than foundation)
            self.residual_model = CatBoostRegressor(
                iterations=100,
                learning_rate=0.05,
                depth=3,
                random_seed=42,
                verbose=False,
            )
            self.residual_model.fit(X, y_residual, verbose=False)

            print(f"Residual model trained on {len(X)} days")

        except Exception as e:
            print(f"Could not train residual model: {e}")

    def get_status(self) -> Dict:
        """Get current pipeline status."""
        return {
            'plant_id': self.plant_id,
            'phase': self.current_phase.value,
            'days_of_data': self.days_of_data,
            'n_observations': len(self.observations),
            'n_rain_anchors': len(self.rain_anchors),
            'calibration_offset': self.calibration_offset,
            'has_residual_model': self.residual_model is not None,
            'phase_progress': self._get_phase_progress(),
        }

    def _get_phase_progress(self) -> Dict:
        """Get progress through current phase."""
        phase = self.current_phase

        if phase == BootstrapPhase.FOUNDATION_ONLY:
            return {
                'current': self.days_of_data,
                'target': self.config.phase1_end,
                'percent': min(100, self.days_of_data / self.config.phase1_end * 100),
            }
        elif phase == BootstrapPhase.FOUNDATION_CALIBRATED:
            days_in_phase = self.days_of_data - self.config.phase1_end
            phase_length = self.config.phase2_end - self.config.phase1_end
            return {
                'current': days_in_phase,
                'target': phase_length,
                'percent': min(100, days_in_phase / phase_length * 100),
            }
        elif phase == BootstrapPhase.HYBRID_BUILDING:
            days_in_phase = self.days_of_data - self.config.phase2_end
            phase_length = self.config.phase3_end - self.config.phase2_end
            return {
                'current': days_in_phase,
                'target': phase_length,
                'percent': min(100, days_in_phase / phase_length * 100),
            }
        else:
            return {
                'current': self.days_of_data - self.config.phase3_end,
                'target': None,
                'percent': 100,
            }

    def save(self, path: Path) -> None:
        """Save pipeline state."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, 'wb') as f:
            pickle.dump({
                'plant_id': self.plant_id,
                'config': self.config,
                'foundation_model': self.foundation_model,
                'residual_model': self.residual_model,
                'days_of_data': self.days_of_data,
                'start_date': self.start_date,
                'observations': self.observations,
                'rain_anchors': self.rain_anchors,
                'calibration_offset': self.calibration_offset,
                'sr_history': self.sr_history,
            }, f)

    @classmethod
    def load(cls, path: Path) -> 'BootstrapPipeline':
        """Load pipeline state."""
        with open(path, 'rb') as f:
            data = pickle.load(f)

        instance = cls(data['plant_id'], data['config'])
        instance.foundation_model = data['foundation_model']
        instance.residual_model = data['residual_model']
        instance.days_of_data = data['days_of_data']
        instance.start_date = data['start_date']
        instance.observations = data['observations']
        instance.rain_anchors = data['rain_anchors']
        instance.calibration_offset = data['calibration_offset']
        instance.sr_history = data['sr_history']

        return instance


def simulate_bootstrap(
    plant_id: str,
    foundation_model,
    df_scada: pd.DataFrame,
    df_features: pd.DataFrame,
    sr_actual: pd.Series,
    rainfall: pd.Series,
) -> Tuple[BootstrapPipeline, pd.DataFrame]:
    """Simulate bootstrap pipeline on historical data.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    foundation_model : SoilingFoundationModel
        Pre-trained foundation model
    df_scada : pd.DataFrame
        SCADA data with power columns
    df_features : pd.DataFrame
        Feature matrix
    sr_actual : pd.Series
        Actual SR (for comparison)
    rainfall : pd.Series
        Daily rainfall (mm)

    Returns
    -------
    Tuple[BootstrapPipeline, pd.DataFrame]
        (pipeline, results_df)
    """
    # Initialize pipeline
    pipeline = BootstrapPipeline(plant_id)
    pipeline.initialize_with_foundation_model(foundation_model)

    results = []

    # Get common dates
    common_dates = df_features.index.intersection(sr_actual.index)

    for date in common_dates:
        features = df_features.loc[date].values
        rain_mm = rainfall.get(date, 0.0)
        sr_true = sr_actual.loc[date]

        # Estimate SR
        sr_est, confidence, meta = pipeline.estimate_daily_sr(
            features=features,
            rainfall_mm=rain_mm,
            date=date,
        )

        # Get power values for observation
        if 'power' in df_scada.columns:
            power_actual = df_scada.loc[date, 'power']
        else:
            power_actual = 1.0

        power_expected = power_actual / sr_true if sr_true > 0.5 else power_actual

        # Update pipeline
        pipeline.update_with_observation(
            date=date,
            features=features,
            power_actual=power_actual,
            power_expected=power_expected,
            rainfall_mm=rain_mm,
        )

        results.append({
            'date': date,
            'sr_actual': sr_true,
            'sr_estimated': sr_est,
            'confidence': confidence,
            'error': sr_est - sr_true,
            'phase': meta['phase'],
            'method': meta['method'],
            'rainfall_mm': rain_mm,
        })

    results_df = pd.DataFrame(results).set_index('date')

    return pipeline, results_df


if __name__ == "__main__":
    # Test simulation
    from nuravolt.soiling.sr_foundation_model import SoilingFoundationModel

    # Load or train foundation model
    model_path = Path("backenddata/models/soiling_foundation_model.pkl")
    if model_path.exists():
        foundation = SoilingFoundationModel.load(model_path)
    else:
        print("Training foundation model first...")
        foundation = SoilingFoundationModel()
        foundation.train_on_all_dustiq_plants()
        foundation.save(model_path)

    print(f"\nFoundation model loaded: {foundation.is_trained}")

    # Example: simulate on a held-out plant
    # This would require loading plant data
    print("\nBootstrap pipeline ready for use.")
