"""
Soiling vs Degradation Separator

Separates the combined "soiling + degradation" residual from loss disaggregation
into distinct reversible (soiling) and irreversible (degradation) components.

Key Insight:
- Soiling: Reversible after rain/cleaning, accumulates over days/weeks
- Degradation: Irreversible, accumulates over months/years (0.5-1%/year typical)

Detection Approaches:
1. Rain Event Analysis: SR recovers after rain → soiling was present
2. Cleaning Event Detection: Sharp SR increase → manual cleaning
3. Year-over-Year Comparison: Systematic decline at same conditions → degradation
4. Post-Cleaning Baseline: SR after cleaning declines over years → degradation

Usage:
    from nuravolt.digitaltwin.soiling_degradation_separator import (
        SoilingDegradationSeparator,
        RecoveryEventDetector,
    )

    # Initialize
    separator = SoilingDegradationSeparator(plant_id="zeta")

    # Analyze SR time series
    results = separator.analyze(
        sr_daily=sr_series,           # Daily soiling ratio
        dates=date_series,            # Corresponding dates
        precipitation=precip_series,  # Optional: mm/day rainfall
    )

    # Results
    print(f"Soiling rate: {results['soiling_rate_pct_per_week']:.2f}%/week")
    print(f"Degradation rate: {results['degradation_rate_pct_per_year']:.2f}%/year")
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
import polars as pl

logger = logging.getLogger(__name__)


@dataclass
class RecoveryEvent:
    """A detected recovery event (rain or cleaning)."""
    date: datetime
    sr_before: float          # SR before event
    sr_after: float           # SR after event
    recovery_pct: float       # Recovery amount (sr_after - sr_before)
    event_type: str           # "rain", "cleaning", or "unknown"
    confidence: float         # 0-1 confidence in classification
    precipitation_mm: Optional[float] = None  # Rainfall if available

    def to_dict(self) -> dict:
        return {
            "date": self.date.isoformat() if hasattr(self.date, "isoformat") else str(self.date),
            "sr_before": round(self.sr_before, 4),
            "sr_after": round(self.sr_after, 4),
            "recovery_pct": round(self.recovery_pct, 4),
            "event_type": self.event_type,
            "confidence": round(self.confidence, 3),
            "precipitation_mm": self.precipitation_mm,
        }


@dataclass
class SoilingDegradationResult:
    """Results from soiling/degradation separation analysis."""

    # Rates
    soiling_rate_pct_per_day: float      # Average soiling accumulation rate
    soiling_rate_pct_per_week: float     # Weekly rate
    degradation_rate_pct_per_year: float # Annual degradation rate

    # Separated components (daily)
    dates: List[str]
    sr_total: List[float]           # Original SR (soiling + degradation combined)
    sr_soiling_component: List[float]    # Reversible soiling component
    sr_degradation_component: List[float] # Irreversible degradation component
    sr_clean_baseline: List[float]  # Estimated clean state (no soiling, with degradation)

    # Events
    recovery_events: List[RecoveryEvent]
    n_rain_events: int
    n_cleaning_events: int

    # Quality metrics
    confidence: float            # Overall confidence in separation
    n_years_analyzed: float      # Years of data used
    method_used: str             # "rain_recovery", "yoy_trend", "cleaning_baseline"

    def to_dict(self) -> dict:
        return {
            "soiling_rate_pct_per_day": round(self.soiling_rate_pct_per_day, 4),
            "soiling_rate_pct_per_week": round(self.soiling_rate_pct_per_week, 4),
            "degradation_rate_pct_per_year": round(self.degradation_rate_pct_per_year, 4),
            "n_rain_events": self.n_rain_events,
            "n_cleaning_events": self.n_cleaning_events,
            "confidence": round(self.confidence, 3),
            "n_years_analyzed": round(self.n_years_analyzed, 2),
            "method_used": self.method_used,
            "recovery_events": [e.to_dict() for e in self.recovery_events[:10]],  # First 10
        }


class RecoveryEventDetector:
    """
    Detects soiling recovery events from SR time series.

    Recovery events occur when:
    1. Rain washes away soiling
    2. Manual cleaning is performed

    Detection is based on sharp increases in SR that exceed normal variation.
    """

    def __init__(
        self,
        min_recovery_pct: float = 0.01,      # Minimum 1% recovery to count
        cleaning_threshold_pct: float = 0.03, # >3% recovery = likely cleaning
        rain_threshold_mm: float = 2.0,       # >2mm = significant rain
        lookback_days: int = 3,               # Days before event to measure SR
        lookahead_days: int = 2,              # Days after event to measure SR
    ):
        self.min_recovery_pct = min_recovery_pct
        self.cleaning_threshold_pct = cleaning_threshold_pct
        self.rain_threshold_mm = rain_threshold_mm
        self.lookback_days = lookback_days
        self.lookahead_days = lookahead_days

    def detect(
        self,
        sr_daily: np.ndarray,
        dates: np.ndarray,
        precipitation: Optional[np.ndarray] = None,
    ) -> List[RecoveryEvent]:
        """
        Detect recovery events from SR time series.

        Args:
            sr_daily: Daily soiling ratio values
            dates: Corresponding dates (datetime or string)
            precipitation: Optional daily precipitation (mm)

        Returns:
            List of RecoveryEvent objects
        """
        events = []
        n = len(sr_daily)

        if n < self.lookback_days + self.lookahead_days + 1:
            logger.warning("Insufficient data for recovery detection")
            return events

        # Calculate daily SR changes
        sr_diff = np.diff(sr_daily)

        # Calculate rolling statistics for anomaly detection
        # Use 14-day rolling std as baseline for "normal" variation
        window = min(14, n // 4)
        rolling_std = np.array([
            np.nanstd(sr_daily[max(0, i-window):i+1])
            for i in range(n)
        ])
        rolling_std = np.where(rolling_std < 0.005, 0.005, rolling_std)  # Floor

        # Detect significant positive jumps
        for i in range(self.lookback_days, n - self.lookahead_days):
            # SR before (average of lookback period)
            sr_before = np.nanmean(sr_daily[i - self.lookback_days:i])

            # SR after (average of lookahead period)
            sr_after = np.nanmean(sr_daily[i + 1:i + 1 + self.lookahead_days])

            recovery = sr_after - sr_before

            # Skip if recovery too small
            if recovery < self.min_recovery_pct:
                continue

            # Check if this is a significant recovery (> 2 std)
            if recovery < 2 * rolling_std[i]:
                continue

            # Classify event type
            precip = precipitation[i] if precipitation is not None else None

            if precip is not None and precip >= self.rain_threshold_mm:
                event_type = "rain"
                confidence = min(0.95, 0.7 + precip / 20)  # Higher rain = higher confidence
            elif recovery >= self.cleaning_threshold_pct:
                # Large recovery without rain = likely cleaning
                event_type = "cleaning"
                confidence = min(0.9, 0.5 + recovery / 0.1)
            else:
                # Moderate recovery, could be light rain or cleaning
                event_type = "unknown"
                confidence = 0.5

            # Convert date
            date = dates[i]
            if isinstance(date, str):
                try:
                    date = datetime.fromisoformat(date)
                except ValueError:
                    date = datetime.strptime(date, "%Y-%m-%d")

            events.append(RecoveryEvent(
                date=date,
                sr_before=float(sr_before),
                sr_after=float(sr_after),
                recovery_pct=float(recovery),
                event_type=event_type,
                confidence=confidence,
                precipitation_mm=float(precip) if precip is not None else None,
            ))

        # Remove duplicates (events within 3 days of each other)
        events = self._deduplicate_events(events)

        logger.info(f"Detected {len(events)} recovery events")
        return events

    def _deduplicate_events(
        self,
        events: List[RecoveryEvent],
        min_gap_days: int = 3,
    ) -> List[RecoveryEvent]:
        """Remove duplicate events that are too close together."""
        if not events:
            return events

        # Sort by date
        events = sorted(events, key=lambda e: e.date)

        # Keep only the largest recovery in each cluster
        deduplicated = []
        current_cluster = [events[0]]

        for i in range(1, len(events)):
            gap = (events[i].date - events[i-1].date).days

            if gap <= min_gap_days:
                current_cluster.append(events[i])
            else:
                # Close current cluster, keep largest recovery
                best = max(current_cluster, key=lambda e: e.recovery_pct)
                deduplicated.append(best)
                current_cluster = [events[i]]

        # Don't forget last cluster
        if current_cluster:
            best = max(current_cluster, key=lambda e: e.recovery_pct)
            deduplicated.append(best)

        return deduplicated


class SoilingDegradationSeparator:
    """
    Separates soiling and degradation components from combined SR time series.

    Uses multiple methods:
    1. Rain recovery analysis: Recovery after rain = soiling that was present
    2. Cleaning baseline tracking: SR after cleaning declines = degradation
    3. Year-over-year trending: Systematic annual decline = degradation
    """

    def __init__(
        self,
        plant_id: str,
        typical_degradation_rate: float = 0.005,  # 0.5%/year default
        max_degradation_rate: float = 0.02,       # 2%/year max reasonable
        min_soiling_rate: float = 0.0001,         # 0.01%/day minimum
        max_soiling_rate: float = 0.02,           # 2%/day maximum (extreme desert)
    ):
        self.plant_id = plant_id
        self.typical_degradation_rate = typical_degradation_rate
        self.max_degradation_rate = max_degradation_rate
        self.min_soiling_rate = min_soiling_rate
        self.max_soiling_rate = max_soiling_rate

        self.event_detector = RecoveryEventDetector()

    def analyze(
        self,
        sr_daily: Union[np.ndarray, List[float]],
        dates: Union[np.ndarray, List],
        precipitation: Optional[Union[np.ndarray, List[float]]] = None,
        cleaning_dates: Optional[List] = None,
    ) -> SoilingDegradationResult:
        """
        Analyze SR time series to separate soiling and degradation.

        Args:
            sr_daily: Daily soiling ratio values
            dates: Corresponding dates
            precipitation: Optional daily precipitation (mm)
            cleaning_dates: Optional known cleaning dates from O&M records

        Returns:
            SoilingDegradationResult with separated components
        """
        # Convert to numpy
        sr_daily = np.array(sr_daily, dtype=float)
        dates = np.array(dates)
        if precipitation is not None:
            precipitation = np.array(precipitation, dtype=float)

        n = len(sr_daily)
        n_years = n / 365.25

        logger.info(f"Analyzing {n} days ({n_years:.1f} years) of SR data")

        # Step 1: Detect recovery events
        events = self.event_detector.detect(sr_daily, dates, precipitation)

        # Add known cleaning dates if provided
        if cleaning_dates:
            events = self._add_cleaning_events(events, sr_daily, dates, cleaning_dates)

        n_rain = sum(1 for e in events if e.event_type == "rain")
        n_cleaning = sum(1 for e in events if e.event_type == "cleaning")

        logger.info(f"Found {n_rain} rain events, {n_cleaning} cleaning events")

        # Step 2: Estimate degradation rate
        degradation_rate, deg_confidence, deg_method = self._estimate_degradation_rate(
            sr_daily, dates, events
        )

        logger.info(f"Estimated degradation: {degradation_rate*100:.3f}%/year (method: {deg_method})")

        # Step 3: Estimate soiling accumulation rate
        soiling_rate, soil_confidence = self._estimate_soiling_rate(
            sr_daily, dates, events, degradation_rate
        )

        logger.info(f"Estimated soiling rate: {soiling_rate*100:.4f}%/day")

        # Step 4: Separate components
        sr_soiling, sr_degradation, sr_clean_baseline = self._separate_components(
            sr_daily, dates, events, degradation_rate, soiling_rate
        )

        # Convert dates to strings
        date_strs = [
            d.isoformat() if hasattr(d, "isoformat") else str(d)
            for d in dates
        ]

        # Overall confidence
        overall_confidence = (deg_confidence + soil_confidence) / 2
        if len(events) < 3:
            overall_confidence *= 0.7  # Lower confidence with few events
        if n_years < 1:
            overall_confidence *= 0.8  # Lower confidence with short data

        return SoilingDegradationResult(
            soiling_rate_pct_per_day=soiling_rate * 100,
            soiling_rate_pct_per_week=soiling_rate * 100 * 7,
            degradation_rate_pct_per_year=degradation_rate * 100,
            dates=date_strs,
            sr_total=sr_daily.tolist(),
            sr_soiling_component=sr_soiling.tolist(),
            sr_degradation_component=sr_degradation.tolist(),
            sr_clean_baseline=sr_clean_baseline.tolist(),
            recovery_events=events,
            n_rain_events=n_rain,
            n_cleaning_events=n_cleaning,
            confidence=overall_confidence,
            n_years_analyzed=n_years,
            method_used=deg_method,
        )

    def _add_cleaning_events(
        self,
        events: List[RecoveryEvent],
        sr_daily: np.ndarray,
        dates: np.ndarray,
        cleaning_dates: List,
    ) -> List[RecoveryEvent]:
        """Add known cleaning events from O&M records."""
        existing_dates = {e.date.date() if hasattr(e.date, 'date') else e.date for e in events}

        for clean_date in cleaning_dates:
            if isinstance(clean_date, str):
                clean_date = datetime.fromisoformat(clean_date)

            clean_date_only = clean_date.date() if hasattr(clean_date, 'date') else clean_date

            if clean_date_only in existing_dates:
                # Already detected, update type to cleaning
                for e in events:
                    e_date = e.date.date() if hasattr(e.date, 'date') else e.date
                    if e_date == clean_date_only:
                        e.event_type = "cleaning"
                        e.confidence = 0.99
            else:
                # Add new cleaning event
                # Find index in dates array
                for i, d in enumerate(dates):
                    d_cmp = d.date() if hasattr(d, 'date') else d
                    if isinstance(d, str):
                        d_cmp = datetime.fromisoformat(d).date()

                    if d_cmp == clean_date_only:
                        sr_before = np.nanmean(sr_daily[max(0, i-3):i])
                        sr_after = np.nanmean(sr_daily[i+1:min(len(sr_daily), i+3)])

                        events.append(RecoveryEvent(
                            date=clean_date,
                            sr_before=float(sr_before),
                            sr_after=float(sr_after),
                            recovery_pct=float(sr_after - sr_before),
                            event_type="cleaning",
                            confidence=0.99,
                        ))
                        break

        return sorted(events, key=lambda e: e.date)

    def _estimate_degradation_rate(
        self,
        sr_daily: np.ndarray,
        dates: np.ndarray,
        events: List[RecoveryEvent],
    ) -> Tuple[float, float, str]:
        """
        Estimate annual degradation rate.

        Uses multiple methods and returns the most reliable estimate.
        """
        estimates = []

        # Method 1: Year-over-year comparison
        yoy_rate, yoy_conf = self._degradation_yoy(sr_daily, dates)
        if yoy_rate is not None:
            estimates.append(("yoy_trend", yoy_rate, yoy_conf))

        # Method 2: Post-cleaning baseline trend
        if events:
            cleaning_events = [e for e in events if e.event_type == "cleaning"]
            if len(cleaning_events) >= 2:
                baseline_rate, baseline_conf = self._degradation_from_cleaning_baseline(
                    cleaning_events
                )
                if baseline_rate is not None:
                    estimates.append(("cleaning_baseline", baseline_rate, baseline_conf))

        # Method 3: Post-rain baseline trend
        if events:
            rain_events = [e for e in events if e.event_type == "rain"]
            if len(rain_events) >= 4:
                rain_rate, rain_conf = self._degradation_from_rain_baseline(rain_events)
                if rain_rate is not None:
                    estimates.append(("rain_baseline", rain_rate, rain_conf))

        # Select best estimate
        if not estimates:
            # Fall back to typical value
            return self.typical_degradation_rate, 0.3, "default"

        # Weight by confidence
        total_weight = sum(conf for _, _, conf in estimates)
        weighted_rate = sum(rate * conf for _, rate, conf in estimates) / total_weight
        best_method = max(estimates, key=lambda x: x[2])[0]
        avg_confidence = total_weight / len(estimates)

        # Clamp to reasonable range
        weighted_rate = np.clip(weighted_rate, 0, self.max_degradation_rate)

        return weighted_rate, avg_confidence, best_method

    def _degradation_yoy(
        self,
        sr_daily: np.ndarray,
        dates: np.ndarray,
    ) -> Tuple[Optional[float], float]:
        """
        Estimate degradation from year-over-year comparison.

        Compares SR at similar conditions across years.
        """
        # Parse dates to get year and day-of-year
        parsed_dates = []
        for d in dates:
            if isinstance(d, str):
                try:
                    d = datetime.fromisoformat(d)
                except ValueError:
                    d = datetime.strptime(d, "%Y-%m-%d")
            parsed_dates.append(d)

        years = np.array([d.year for d in parsed_dates])
        doys = np.array([d.timetuple().tm_yday for d in parsed_dates])

        unique_years = sorted(set(years))
        if len(unique_years) < 2:
            return None, 0.0

        # For each day-of-year, get average SR per year
        yearly_means = {}
        for year in unique_years:
            year_mask = years == year
            if np.sum(year_mask) < 30:  # Need at least 30 days
                continue
            yearly_means[year] = np.nanmean(sr_daily[year_mask])

        if len(yearly_means) < 2:
            return None, 0.0

        # Linear regression on yearly means
        years_list = sorted(yearly_means.keys())
        means_list = [yearly_means[y] for y in years_list]

        if len(years_list) >= 2:
            slope, intercept = np.polyfit(years_list, means_list, 1)
            # Slope is change per year (as SR, not percentage)
            # Negative slope = degradation
            degradation_rate = -slope  # Convert to positive rate

            # Confidence based on fit quality and number of years
            residuals = np.array(means_list) - (slope * np.array(years_list) + intercept)
            r2 = 1 - np.var(residuals) / np.var(means_list) if np.var(means_list) > 0 else 0
            confidence = min(0.9, r2 * 0.5 + len(years_list) * 0.1)

            return max(0, degradation_rate), confidence

        return None, 0.0

    def _degradation_from_cleaning_baseline(
        self,
        cleaning_events: List[RecoveryEvent],
    ) -> Tuple[Optional[float], float]:
        """
        Estimate degradation from post-cleaning SR values over time.

        The SR immediately after cleaning represents the "clean" state.
        Decline in this clean baseline over years = degradation.
        """
        if len(cleaning_events) < 2:
            return None, 0.0

        # Get post-cleaning SR values and dates
        clean_srs = [e.sr_after for e in cleaning_events]
        clean_dates = [e.date for e in cleaning_events]

        # Convert to days since first event
        first_date = min(clean_dates)
        days = [(d - first_date).days for d in clean_dates]

        if max(days) < 180:  # Need at least 6 months
            return None, 0.0

        # Linear regression
        slope, intercept = np.polyfit(days, clean_srs, 1)

        # Slope is SR change per day, convert to per year
        degradation_rate_per_year = -slope * 365.25

        # Confidence based on fit and span
        years_span = max(days) / 365.25
        confidence = min(0.85, 0.4 + years_span * 0.15 + len(cleaning_events) * 0.05)

        return max(0, degradation_rate_per_year), confidence

    def _degradation_from_rain_baseline(
        self,
        rain_events: List[RecoveryEvent],
    ) -> Tuple[Optional[float], float]:
        """
        Estimate degradation from post-rain SR values over time.

        Similar to cleaning baseline, but using rain recovery events.
        Less reliable than cleaning because rain may not fully clean.
        """
        if len(rain_events) < 4:
            return None, 0.0

        # Use top quartile of recovery events (most effective rain)
        sorted_events = sorted(rain_events, key=lambda e: e.recovery_pct, reverse=True)
        top_events = sorted_events[:max(2, len(sorted_events) // 4)]

        clean_srs = [e.sr_after for e in top_events]
        clean_dates = [e.date for e in top_events]

        first_date = min(clean_dates)
        days = [(d - first_date).days for d in clean_dates]

        if max(days) < 180:
            return None, 0.0

        slope, intercept = np.polyfit(days, clean_srs, 1)
        degradation_rate_per_year = -slope * 365.25

        # Lower confidence than cleaning baseline
        years_span = max(days) / 365.25
        confidence = min(0.7, 0.3 + years_span * 0.1 + len(top_events) * 0.03)

        return max(0, degradation_rate_per_year), confidence

    def _estimate_soiling_rate(
        self,
        sr_daily: np.ndarray,
        dates: np.ndarray,
        events: List[RecoveryEvent],
        degradation_rate: float,
    ) -> Tuple[float, float]:
        """
        Estimate soiling accumulation rate (%/day).

        Uses the rate of SR decline between recovery events,
        after removing the degradation component.
        """
        if len(events) < 2:
            # Fall back to recovery amount divided by typical cycle
            avg_recovery = np.mean([e.recovery_pct for e in events]) if events else 0.02
            # Assume 30-day soiling cycle
            soiling_rate = avg_recovery / 30
            return np.clip(soiling_rate, self.min_soiling_rate, self.max_soiling_rate), 0.4

        # Calculate soiling rate between consecutive events
        soiling_rates = []

        sorted_events = sorted(events, key=lambda e: e.date)

        for i in range(1, len(sorted_events)):
            prev_event = sorted_events[i - 1]
            curr_event = sorted_events[i]

            # Days between events
            days_between = (curr_event.date - prev_event.date).days

            if days_between < 3 or days_between > 120:
                continue  # Skip very short or very long gaps

            # SR decline = soiling + degradation
            # sr_before of current event is the soiled state
            # sr_after of previous event is the clean state
            total_decline = prev_event.sr_after - curr_event.sr_before

            # Remove degradation component
            degradation_component = degradation_rate * days_between / 365.25
            soiling_decline = total_decline - degradation_component

            if soiling_decline > 0:
                rate = soiling_decline / days_between
                soiling_rates.append(rate)

        if soiling_rates:
            # Use median to be robust to outliers
            median_rate = np.median(soiling_rates)
            confidence = min(0.9, 0.5 + len(soiling_rates) * 0.05)
            return np.clip(median_rate, self.min_soiling_rate, self.max_soiling_rate), confidence

        # Fallback
        return self.min_soiling_rate * 10, 0.3

    def _separate_components(
        self,
        sr_daily: np.ndarray,
        dates: np.ndarray,
        events: List[RecoveryEvent],
        degradation_rate: float,
        soiling_rate: float,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Separate SR into soiling and degradation components.

        Returns:
            sr_soiling: Reversible soiling component (loss from 1.0)
            sr_degradation: Irreversible degradation component (loss from 1.0)
            sr_clean_baseline: What SR would be with no soiling (1.0 - degradation)
        """
        n = len(sr_daily)

        # Parse dates
        parsed_dates = []
        for d in dates:
            if isinstance(d, str):
                try:
                    d = datetime.fromisoformat(d)
                except ValueError:
                    d = datetime.strptime(d, "%Y-%m-%d")
            parsed_dates.append(d)

        # Calculate degradation component (cumulative from start)
        first_date = parsed_dates[0]
        days_from_start = np.array([(d - first_date).days for d in parsed_dates])

        # Degradation grows linearly over time
        sr_degradation = degradation_rate * days_from_start / 365.25

        # Clean baseline = 1.0 - degradation
        # This is what SR would be if perfectly clean
        sr_clean_baseline = 1.0 - sr_degradation

        # Soiling component = clean_baseline - actual_sr
        # This is the reversible loss
        sr_soiling = sr_clean_baseline - sr_daily

        # Clamp to reasonable values
        sr_soiling = np.clip(sr_soiling, 0, 0.3)  # Max 30% soiling
        sr_degradation = np.clip(sr_degradation, 0, 0.2)  # Max 20% degradation

        # Verify: sr_daily ≈ 1 - sr_soiling - sr_degradation
        # Or: sr_daily = sr_clean_baseline - sr_soiling

        return sr_soiling, sr_degradation, sr_clean_baseline

    def generate_report(self, result: SoilingDegradationResult) -> str:
        """Generate a markdown report from the analysis results."""
        lines = []
        lines.append(f"# Soiling vs Degradation Analysis: {self.plant_id}\n")
        lines.append(f"*Analysis period: {result.n_years_analyzed:.1f} years*\n")

        lines.append("## Summary\n")
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| Soiling Rate | {result.soiling_rate_pct_per_week:.3f}%/week |")
        lines.append(f"| Degradation Rate | {result.degradation_rate_pct_per_year:.3f}%/year |")
        lines.append(f"| Rain Events Detected | {result.n_rain_events} |")
        lines.append(f"| Cleaning Events Detected | {result.n_cleaning_events} |")
        lines.append(f"| Confidence | {result.confidence:.1%} |")
        lines.append(f"| Method | {result.method_used} |")
        lines.append("")

        lines.append("## Interpretation\n")

        # Soiling interpretation
        weekly_soil = result.soiling_rate_pct_per_week
        if weekly_soil < 0.2:
            soil_desc = "Very low (clean environment or frequent rain)"
        elif weekly_soil < 0.5:
            soil_desc = "Low (typical temperate climate)"
        elif weekly_soil < 1.0:
            soil_desc = "Moderate (semi-arid or industrial area)"
        elif weekly_soil < 2.0:
            soil_desc = "High (arid climate)"
        else:
            soil_desc = "Very high (desert or heavily polluted)"

        lines.append(f"- **Soiling**: {soil_desc}")

        # Degradation interpretation
        yearly_deg = result.degradation_rate_pct_per_year
        if yearly_deg < 0.3:
            deg_desc = "Excellent (below industry average)"
        elif yearly_deg < 0.6:
            deg_desc = "Good (industry average: 0.5%/year)"
        elif yearly_deg < 1.0:
            deg_desc = "Moderate (slightly elevated)"
        else:
            deg_desc = "High (investigate potential issues)"

        lines.append(f"- **Degradation**: {deg_desc}")
        lines.append("")

        # Recovery events
        if result.recovery_events:
            lines.append("## Recovery Events (Top 10)\n")
            lines.append("| Date | Type | SR Before | SR After | Recovery |")
            lines.append("|------|------|-----------|----------|----------|")
            for e in result.recovery_events[:10]:
                date_str = e.date.strftime("%Y-%m-%d") if hasattr(e.date, 'strftime') else str(e.date)[:10]
                lines.append(f"| {date_str} | {e.event_type} | {e.sr_before:.3f} | {e.sr_after:.3f} | +{e.recovery_pct:.3f} |")
            lines.append("")

        return "\n".join(lines)
