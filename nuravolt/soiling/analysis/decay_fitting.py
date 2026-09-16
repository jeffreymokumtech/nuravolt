"""Piecewise soiling decay fitting between rain events.

Extracts site-specific soiling rates by fitting linear or exponential decay
models to SR timeseries segments between rain cleaning events.

Key concepts:
- Rain events act as natural "anchor points" where SR resets to ~1.0
- Between rain events, SR decays due to dust accumulation
- Decay rate varies by site, season, and dust conditions
- Fitting decay curves gives site-specific soiling rates for forecasting

Example usage:
    fitter = PiecewiseDecayFitter(rain_threshold_mm=5.0)
    segments = fitter.identify_segments(sr_series, rain_series)
    site_rate = fitter.get_site_soiling_rate(segments)
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import List, Optional, Tuple, Literal
import logging

import numpy as np
import pandas as pd
from scipy import stats
from scipy.optimize import curve_fit

logger = logging.getLogger(__name__)


@dataclass
class DecayFitConfig:
    """Configuration for decay fitting."""

    # Rain threshold for segment boundaries (mm)
    rain_threshold_mm: float = 5.0

    # Minimum segment length to fit (days)
    min_segment_days: int = 7

    # Maximum segment length (days) - longer may have multiple events
    max_segment_days: int = 60

    # Minimum R² for valid fit
    min_r2: float = 0.3

    # Decay model type
    model_type: Literal["linear", "exponential"] = "linear"

    # Minimum SR value (below this is likely data error)
    min_sr: float = 0.70

    # Maximum SR value (above this is likely data error)
    max_sr: float = 1.02


@dataclass
class SoilingSegment:
    """A segment of SR data between rain events for decay fitting."""

    start_date: date
    end_date: date
    start_sr: float
    end_sr: float
    days: int
    decay_rate_per_day: float  # %/day (positive = soiling, negative = cleaning)
    r2: float  # Fit quality (0-1)
    rmse: float  # Root mean squared error
    trigger: str  # 'rain_start' | 'cleaning_start' | 'manual'
    n_points: int  # Number of data points in segment
    model_type: str  # 'linear' | 'exponential'

    @property
    def is_valid(self) -> bool:
        """Check if segment has valid decay fit."""
        return self.r2 >= 0.3 and self.n_points >= 5

    @property
    def decay_pct_total(self) -> float:
        """Total decay percentage over segment."""
        return (self.start_sr - self.end_sr) * 100


class PiecewiseDecayFitter:
    """Fit soiling decay curves between rain events.

    This class identifies segments of SR data bounded by rain events
    and fits decay models to extract site-specific soiling rates.
    """

    def __init__(self, config: Optional[DecayFitConfig] = None):
        """Initialize fitter with configuration.

        Args:
            config: Decay fitting configuration
        """
        self.config = config or DecayFitConfig()

    def identify_segments(
        self,
        sr: pd.Series,
        rain: pd.Series,
        cleaning_events: Optional[pd.DatetimeIndex] = None,
    ) -> List[SoilingSegment]:
        """Split SR timeseries into decay segments at rain/cleaning events.

        Args:
            sr: Daily soiling ratio series (index=date, values=SR)
            rain: Daily rainfall series (index=date, values=mm)
            cleaning_events: Optional manual cleaning event dates

        Returns:
            List of SoilingSegment objects with fitted decay rates
        """
        # Ensure both series have date index
        sr = sr.copy()
        rain = rain.copy()

        if not isinstance(sr.index, pd.DatetimeIndex):
            sr.index = pd.to_datetime(sr.index)
        if not isinstance(rain.index, pd.DatetimeIndex):
            rain.index = pd.to_datetime(rain.index)

        # Filter SR to valid range
        sr = sr[(sr >= self.config.min_sr) & (sr <= self.config.max_sr)]

        # Align date ranges
        common_dates = sr.index.intersection(rain.index)
        sr = sr.loc[common_dates]
        rain = rain.loc[common_dates]

        # Find reset points (rain events and manual cleanings)
        rain_dates = rain[rain >= self.config.rain_threshold_mm].index.tolist()

        if cleaning_events is not None:
            all_resets = sorted(set(rain_dates) | set(cleaning_events))
        else:
            all_resets = sorted(rain_dates)

        if len(all_resets) < 2:
            logger.warning("Not enough reset events to identify segments")
            return []

        # Create segments between reset events
        segments = []

        for i in range(len(all_resets) - 1):
            # Segment starts day after reset event
            start = all_resets[i] + pd.Timedelta(days=1)
            # Segment ends day before next reset
            end = all_resets[i + 1] - pd.Timedelta(days=1)

            # Check segment length
            days = (end - start).days + 1
            if days < self.config.min_segment_days:
                continue
            if days > self.config.max_segment_days:
                # Skip very long segments - likely missing rain data
                continue

            # Extract segment SR data
            segment_sr = sr.loc[start:end].dropna()
            if len(segment_sr) < self.config.min_segment_days:
                continue

            # Determine trigger type
            if all_resets[i] in rain_dates:
                trigger = "rain_start"
            else:
                trigger = "cleaning_start"

            # Fit decay model
            segment = self._fit_segment(
                segment_sr=segment_sr,
                start_date=start.date(),
                end_date=end.date(),
                trigger=trigger,
            )

            if segment is not None:
                segments.append(segment)

        logger.info(f"Identified {len(segments)} decay segments")
        return segments

    def _fit_segment(
        self,
        segment_sr: pd.Series,
        start_date: date,
        end_date: date,
        trigger: str,
    ) -> Optional[SoilingSegment]:
        """Fit decay model to a single segment.

        Args:
            segment_sr: SR values for segment
            start_date: Segment start date
            end_date: Segment end date
            trigger: What triggered the segment start

        Returns:
            SoilingSegment with fitted parameters, or None if fit fails
        """
        try:
            # Convert to numpy arrays
            y = segment_sr.values
            x = np.arange(len(y))  # Days from start

            if self.config.model_type == "linear":
                slope, intercept, r_value, _, _ = stats.linregress(x, y)
                r2 = r_value**2

                # Decay rate in %/day (slope is in SR/day)
                decay_rate = -slope * 100

                # Calculate RMSE
                y_pred = intercept + slope * x
                rmse = np.sqrt(np.mean((y - y_pred) ** 2))

            else:  # exponential
                decay_rate, r2, rmse = self._fit_exponential(x, y)

            return SoilingSegment(
                start_date=start_date,
                end_date=end_date,
                start_sr=float(y[0]),
                end_sr=float(y[-1]),
                days=(end_date - start_date).days + 1,
                decay_rate_per_day=decay_rate,
                r2=r2,
                rmse=rmse,
                trigger=trigger,
                n_points=len(y),
                model_type=self.config.model_type,
            )

        except Exception as e:
            logger.debug(f"Failed to fit segment {start_date}-{end_date}: {e}")
            return None

    def _fit_exponential(
        self, x: np.ndarray, y: np.ndarray
    ) -> Tuple[float, float, float]:
        """Fit exponential decay model.

        Model: SR(t) = SR_0 * exp(-k * t) + SR_asymptote

        Args:
            x: Days from start
            y: SR values

        Returns:
            Tuple of (decay_rate, r2, rmse)
        """

        def exp_decay(t, sr0, k, sr_asymp):
            return sr0 * np.exp(-k * t) + sr_asymp

        try:
            # Initial guesses
            p0 = [y[0] - y[-1], 0.01, y[-1]]
            bounds = ([0, 0.0001, 0.5], [0.5, 0.5, 1.0])

            popt, _ = curve_fit(exp_decay, x, y, p0=p0, bounds=bounds, maxfev=1000)

            # Calculate predictions and metrics
            y_pred = exp_decay(x, *popt)
            ss_res = np.sum((y - y_pred) ** 2)
            ss_tot = np.sum((y - np.mean(y)) ** 2)
            r2 = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
            rmse = np.sqrt(np.mean((y - y_pred) ** 2))

            # Decay rate: k in %/day (at t=0)
            decay_rate = popt[1] * 100  # Convert to %/day

            return decay_rate, max(0, r2), rmse

        except Exception:
            # Fall back to linear
            return self._fit_linear_fallback(x, y)

    def _fit_linear_fallback(
        self, x: np.ndarray, y: np.ndarray
    ) -> Tuple[float, float, float]:
        """Linear fit fallback when exponential fails."""
        slope, intercept, r_value, _, _ = stats.linregress(x, y)
        r2 = r_value**2
        y_pred = intercept + slope * x
        rmse = np.sqrt(np.mean((y - y_pred) ** 2))
        decay_rate = -slope * 100
        return decay_rate, r2, rmse

    def get_site_soiling_rate(
        self,
        segments: List[SoilingSegment],
        method: Literal["median", "mean", "weighted"] = "median",
    ) -> float:
        """Compute site-level soiling rate from segments.

        Args:
            segments: List of fitted segments
            method: Aggregation method
                - median: Robust to outliers (recommended)
                - mean: Simple average
                - weighted: Weight by segment length and R²

        Returns:
            Site soiling rate in %/day (positive = soiling)
        """
        # Filter to valid segments
        valid_segments = [s for s in segments if s.is_valid]

        if not valid_segments:
            logger.warning("No valid segments for rate calculation, using default")
            return 0.2  # Default 0.2%/day

        rates = [s.decay_rate_per_day for s in valid_segments]

        if method == "median":
            return float(np.median(rates))
        elif method == "mean":
            return float(np.mean(rates))
        else:  # weighted
            weights = [s.days * s.r2 for s in valid_segments]
            return float(np.average(rates, weights=weights))

    def get_seasonal_rates(
        self,
        segments: List[SoilingSegment],
    ) -> dict:
        """Compute seasonal soiling rates.

        Args:
            segments: List of fitted segments

        Returns:
            Dict with seasonal rates: {'winter': 0.1, 'spring': 0.2, ...}
        """
        valid_segments = [s for s in segments if s.is_valid]

        seasonal_rates = {
            "winter": [],  # Dec, Jan, Feb
            "spring": [],  # Mar, Apr, May
            "summer": [],  # Jun, Jul, Aug
            "fall": [],  # Sep, Oct, Nov
        }

        for seg in valid_segments:
            month = seg.start_date.month
            if month in [12, 1, 2]:
                seasonal_rates["winter"].append(seg.decay_rate_per_day)
            elif month in [3, 4, 5]:
                seasonal_rates["spring"].append(seg.decay_rate_per_day)
            elif month in [6, 7, 8]:
                seasonal_rates["summer"].append(seg.decay_rate_per_day)
            else:
                seasonal_rates["fall"].append(seg.decay_rate_per_day)

        # Compute medians
        return {
            season: float(np.median(rates)) if rates else 0.2
            for season, rates in seasonal_rates.items()
        }

    def generate_report(self, segments: List[SoilingSegment]) -> dict:
        """Generate summary report of decay analysis.

        Args:
            segments: List of fitted segments

        Returns:
            Report dictionary with statistics
        """
        valid = [s for s in segments if s.is_valid]

        if not valid:
            return {
                "status": "insufficient_data",
                "total_segments": len(segments),
                "valid_segments": 0,
            }

        rates = [s.decay_rate_per_day for s in valid]
        r2_values = [s.r2 for s in valid]

        return {
            "status": "success",
            "total_segments": len(segments),
            "valid_segments": len(valid),
            "site_soiling_rate_pct_day": float(np.median(rates)),
            "rate_std": float(np.std(rates)),
            "rate_min": float(np.min(rates)),
            "rate_max": float(np.max(rates)),
            "avg_r2": float(np.mean(r2_values)),
            "avg_segment_days": float(np.mean([s.days for s in valid])),
            "seasonal_rates": self.get_seasonal_rates(valid),
            "model_type": self.config.model_type,
        }


def fit_plant_decay(
    plant_id: str,
    sr_source: Literal["dustiq", "estimated"] = "dustiq",
) -> dict:
    """Convenience function to fit decay rates for a plant.

    Args:
        plant_id: Plant identifier
        sr_source: Source of SR data

    Returns:
        Report dictionary with fitted rates
    """
    from nuravolt.soiling.estimation.layer1_dustiq import load_dustiq_history

    # Load SR data
    if sr_source == "dustiq":
        sr = load_dustiq_history(plant_id)
        if sr is None or sr.empty:
            return {"status": "no_dustiq_data"}
        sr = sr["sr_dustiq"]
    else:
        # Load from estimated SR
        raise NotImplementedError("Estimated SR not yet supported")

    # Load rain data
    rain_path = f"public/data/weather/{plant_id}/daily_weather.csv"
    try:
        rain_df = pd.read_csv(rain_path, parse_dates=["date"], index_col="date")
        rain = rain_df.get("precipitation_mm", rain_df.get("rain_mm"))
        if rain is None:
            return {"status": "no_rain_data"}
    except FileNotFoundError:
        return {"status": "no_rain_data"}

    # Fit decay
    fitter = PiecewiseDecayFitter()
    segments = fitter.identify_segments(sr, rain)

    return fitter.generate_report(segments)
