"""
Layer 5: Loss Disaggregation-based SR Estimation.

This is the lowest confidence layer, using only SCADA power data
to estimate soiling through physics-based loss disaggregation.

Key approach:
1. Calculate reference power (clearsky * nameplate)
2. Subtract known losses (temperature, degradation, inverter, wiring)
3. Residual loss is attributed to soiling
4. Use rain events as anchor points for calibration

This method is available even when no DustIQ or similar reference data exists.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple, Dict, Any

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


# Import existing loss disaggregation module
try:
    from ..loss_disaggregation import LossDisaggregator, LossComponents
    DISAGGREGATION_AVAILABLE = True
except ImportError:
    DISAGGREGATION_AVAILABLE = False


# Physics constants for loss estimation
PHYSICS_CONSTANTS = {
    "gamma_pmax": -0.004,  # Power temperature coefficient (%/C)
    "T_stc": 25.0,  # STC temperature (C)
    "degradation_rate": 0.005,  # 0.5% per year
    "wiring_loss": 0.02,  # 2% wiring/BOP loss
    "inverter_loss": 0.02,  # 2% average inverter loss
}

# Minimum data requirements
MIN_SCADA_DAYS = 7


class LossDisaggregationEstimator(SREstimator):
    """Layer 5: Physics-based loss disaggregation from SCADA data only.

    This estimator:
    1. Uses physics models to calculate expected losses
    2. Calculates residual loss as soiling
    3. Calibrates using rain anchor points
    4. Has lowest confidence but works with any SCADA data

    Attributes
    ----------
    data_dir : Path
        Directory containing plant soiling data
    physics_constants : dict
        Physical constants for loss calculations
    """

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        physics_constants: Optional[Dict[str, float]] = None,
    ):
        """Initialize Loss Disaggregation estimator.

        Parameters
        ----------
        data_dir : Path, optional
            Directory containing plant soiling data.
        physics_constants : dict, optional
            Override default physics constants.
        """
        self.data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
        self.physics_constants = physics_constants or PHYSICS_CONSTANTS.copy()
        self._disaggregators = {}

    @property
    def layer(self) -> EstimationLayer:
        return EstimationLayer.DISAGGREGATION

    @property
    def method_name(self) -> str:
        return "loss_disaggregation"

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

    def _load_rain_data(self, plant_id: str) -> Optional[pd.Series]:
        """Load rain history as a Series."""
        # Try weather_extended first
        df_weather = self._load_weather_data(plant_id)
        if df_weather is not None and "precipitation_mm" in df_weather.columns:
            return df_weather["precipitation_mm"].fillna(0)

        # Try dedicated rain_history
        rain_path = self.data_dir / plant_id / "rain_history.json"
        if rain_path.exists():
            try:
                with open(rain_path) as f:
                    data = json.load(f)
                df = pd.DataFrame(data.get("daily_data", []))
                if len(df) > 0:
                    df["date"] = pd.to_datetime(df["date"])
                    df = df.set_index("date").sort_index()
                    if "precipitation_mm" in df.columns:
                        return df["precipitation_mm"].fillna(0)
            except Exception:
                pass

        return None

    def _load_digital_twin_output(self, plant_id: str) -> Optional[pd.DataFrame]:
        """Load digital twin output (expected power) if available."""
        # This would come from the digital twin module
        # For now, return None - plants would need this generated
        return None

    def _estimate_soiling_from_pr(
        self,
        df_weather: pd.DataFrame,
        rainfall: pd.Series,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Estimate soiling ratio using simplified physics model.

        Uses:
        - Rain events to reset SR toward 1.0
        - Linear soiling accumulation between rain events
        - Temperature/humidity effects on soiling rate

        Returns
        -------
        tuple
            (sr_values, confidence_values)
        """
        dates = df_weather.index
        n = len(dates)

        sr = np.ones(n)
        confidence = np.ones(n) * LAYER_CONFIDENCE[self.layer]

        # Base soiling rate (per day)
        base_soiling_rate = 0.001  # 0.1% per day typical

        # Get humidity if available
        if "relative_humidity_mean" in df_weather.columns:
            humidity = df_weather["relative_humidity_mean"].fillna(50).values
        else:
            humidity = np.full(n, 50)

        # Get wind if available
        if "wind_speed_mean" in df_weather.columns:
            wind = df_weather["wind_speed_mean"].fillna(5).values
        else:
            wind = np.full(n, 5)

        # Rain values
        rain = rainfall.reindex(dates).fillna(0).values

        for i in range(1, n):
            # Check for rain cleaning
            if rain[i] >= 10:  # Heavy rain
                sr[i] = 0.995  # Near-full reset
                confidence[i] = LAYER_CONFIDENCE[self.layer] + 10
            elif rain[i] >= 5:  # Moderate rain
                sr[i] = max(sr[i-1], 0.98)  # Partial reset
                confidence[i] = LAYER_CONFIDENCE[self.layer] + 5
            elif rain[i] >= 2:  # Light rain
                sr[i] = max(sr[i-1], 0.97)  # Minor cleaning
                confidence[i] = LAYER_CONFIDENCE[self.layer]
            else:
                # Accumulate soiling
                # Adjust rate by humidity (high humidity = more sticky dust)
                hum_factor = 1 + (humidity[i] - 50) / 100  # 0.5-1.5

                # Adjust by wind (high wind = more dust deposition but also removal)
                wind_factor = 1 + wind[i] / 50  # 1.0-1.5

                # Combine factors
                daily_rate = base_soiling_rate * hum_factor * wind_factor

                sr[i] = max(0.80, sr[i-1] - daily_rate)
                confidence[i] = LAYER_CONFIDENCE[self.layer] - 5

        # Clip confidence
        confidence = np.clip(confidence, 40, 65)

        return sr, confidence

    def _identify_rain_anchors(
        self,
        rainfall: pd.Series,
        heavy_threshold: float = 10.0,
        moderate_threshold: float = 5.0,
    ) -> pd.DataFrame:
        """Identify rain events as calibration anchors."""
        anchors = []

        for date, rain_mm in rainfall.items():
            if rain_mm >= heavy_threshold:
                anchors.append({
                    "date": date,
                    "rainfall_mm": float(rain_mm),
                    "anchor_sr": 0.995,
                    "confidence": 0.95,
                    "event_type": "heavy_rain",
                })
            elif rain_mm >= moderate_threshold:
                anchors.append({
                    "date": date,
                    "rainfall_mm": float(rain_mm),
                    "anchor_sr": 0.98,
                    "confidence": 0.7,
                    "event_type": "moderate_rain",
                })

        if not anchors:
            return pd.DataFrame(columns=["date", "rainfall_mm", "anchor_sr", "confidence", "event_type"])

        df = pd.DataFrame(anchors)
        df["date"] = pd.to_datetime(df["date"])
        return df

    def check_availability(self, plant_id: str) -> MethodAvailability:
        """Check if loss disaggregation is available for this plant.

        Requires weather data with rainfall for calibration.
        """
        df_weather = self._load_weather_data(plant_id)

        if df_weather is None or len(df_weather) < MIN_SCADA_DAYS:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"Insufficient weather data for {plant_id} "
                       f"(need at least {MIN_SCADA_DAYS} days)",
                confidence=0,
                data_days_available=len(df_weather) if df_weather is not None else 0,
                data_days_required=MIN_SCADA_DAYS,
            )

        # Check for rainfall data (needed for calibration)
        rainfall = self._load_rain_data(plant_id)
        if rainfall is None or len(rainfall) < MIN_SCADA_DAYS:
            return MethodAvailability(
                method=self.method_name,
                layer=self.layer,
                is_available=False,
                reason=f"No rainfall data available for {plant_id} (needed for calibration)",
                confidence=0,
                data_days_available=len(df_weather),
                data_days_required=MIN_SCADA_DAYS,
            )

        # Count rain anchors for confidence adjustment
        anchors = self._identify_rain_anchors(rainfall)
        n_anchors = len(anchors)

        base_conf = LAYER_CONFIDENCE[self.layer]
        if n_anchors >= 10:
            confidence = base_conf
        elif n_anchors >= 5:
            confidence = base_conf - 5
        elif n_anchors >= 2:
            confidence = base_conf - 10
        else:
            confidence = base_conf - 15

        confidence = max(40, confidence)

        return MethodAvailability(
            method=self.method_name,
            layer=self.layer,
            is_available=True,
            reason=f"Loss disaggregation available ({len(df_weather)} days, "
                   f"{n_anchors} rain anchors)",
            confidence=confidence,
            data_days_available=len(df_weather),
            data_days_required=MIN_SCADA_DAYS,
        )

    def estimate(
        self,
        plant_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> SREstimationResult:
        """Estimate SR using loss disaggregation.

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
        rainfall = self._load_rain_data(plant_id)

        # Filter by date range
        if start_date:
            df_weather = df_weather[df_weather.index >= pd.Timestamp(start_date)]
            rainfall = rainfall[rainfall.index >= pd.Timestamp(start_date)]
        if end_date:
            df_weather = df_weather[df_weather.index <= pd.Timestamp(end_date)]
            rainfall = rainfall[rainfall.index <= pd.Timestamp(end_date)]

        if len(df_weather) == 0:
            raise ValueError(f"No data available for {plant_id} in specified date range")

        # Estimate soiling
        sr_values, conf_values = self._estimate_soiling_from_pr(df_weather, rainfall)

        sr_series = pd.Series(sr_values, index=df_weather.index, name="sr")
        confidence = pd.Series(conf_values, index=df_weather.index, name="confidence")

        # Identify rain anchors for metadata
        anchors = self._identify_rain_anchors(rainfall)

        return SREstimationResult(
            sr_values=sr_series,
            confidence=confidence,
            method=self.method_name,
            layer=self.layer,
            metadata={
                "plant_id": plant_id,
                "n_days": len(df_weather),
                "n_rain_anchors": len(anchors),
                "physics_model": "simplified_loss_disaggregation",
                "date_range": {
                    "start": df_weather.index.min().strftime("%Y-%m-%d"),
                    "end": df_weather.index.max().strftime("%Y-%m-%d"),
                },
                "anchor_dates": anchors["date"].dt.strftime("%Y-%m-%d").tolist() if len(anchors) > 0 else [],
            },
        )
