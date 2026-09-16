"""
Synthetic RUL (Remaining Useful Life) Label Generator

Generates time-to-failure labels from historical data for training
predictive maintenance models.

Since no public PV dataset has true RUL labels, we create them using:
1. Backward-looking from detected fault events
2. Threshold-based extrapolation
3. Severity-based assignment for degradation classes
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Literal
import numpy as np
import polars as pl


@dataclass
class RULLabelConfig:
    """Configuration for RUL label generation."""

    # Fault type to generate labels for
    fault_type: Literal[
        "string_degradation",
        "inverter_thermal",
        "module_degradation",
    ]

    # Threshold that defines "fault occurred"
    threshold: float

    # Maximum horizon in days (labels capped at this value)
    max_horizon_days: int = 90

    # Minimum samples before fault to include
    min_samples_before_fault: int = 288  # 1 day at 5-min resolution

    # Whether higher values indicate degradation (True) or health (False)
    higher_is_worse: bool = True


# Pre-defined configs for each fault type
STRING_DEGRADATION_CONFIG = RULLabelConfig(
    fault_type="string_degradation",
    threshold=0.25,  # CV > 25% = degraded
    max_horizon_days=14,
    higher_is_worse=True,
)

INVERTER_THERMAL_CONFIG = RULLabelConfig(
    fault_type="inverter_thermal",
    threshold=65.0,  # °C
    max_horizon_days=10,
    higher_is_worse=True,
)

MODULE_DEGRADATION_CONFIG = RULLabelConfig(
    fault_type="module_degradation",
    threshold=0.75,  # PR < 75% = degraded
    max_horizon_days=90,
    higher_is_worse=False,  # Lower PR is worse
)


class RULLabelGenerator:
    """
    Generate time-to-failure labels from historical data.

    Supports multiple strategies:
    1. From fault events: Look backwards from detected faults
    2. From thresholds: Extrapolate when metric will cross threshold
    3. From degradation class: Convert binary labels to RUL
    """

    def __init__(self, config: RULLabelConfig):
        self.config = config

    def generate_from_fault_events(
        self,
        df: pl.DataFrame,
        metric_col: str,
        timestamp_col: str = "timestamp",
        fault_events: Optional[list[datetime]] = None,
    ) -> pl.DataFrame:
        """
        Generate RUL labels by looking backwards from fault events.

        For each timestamp before a fault:
        days_to_fault = fault_timestamp - current_timestamp

        Args:
            df: DataFrame with time-series data
            metric_col: Column containing the metric to monitor
            timestamp_col: Column containing timestamps
            fault_events: List of fault event timestamps (if None, auto-detect)

        Returns:
            DataFrame with 'days_to_fault' column added
        """
        if metric_col not in df.columns:
            raise ValueError(f"Metric column '{metric_col}' not found in DataFrame")

        # Ensure sorted by timestamp
        df = df.sort(timestamp_col)

        # Auto-detect fault events if not provided
        if fault_events is None:
            fault_events = self._detect_fault_events(df, metric_col, timestamp_col)

        if not fault_events:
            # No faults detected - assign max horizon (censored data)
            return df.with_columns(
                pl.lit(float(self.config.max_horizon_days)).alias("days_to_fault")
            )

        # Convert timestamps to datetime if needed
        timestamps = df[timestamp_col].to_list()
        timestamps = [self._parse_timestamp(ts) for ts in timestamps]

        # Calculate days to nearest future fault for each record
        days_to_fault = []
        for ts in timestamps:
            if ts is None:
                days_to_fault.append(None)
                continue

            # Find nearest future fault
            future_faults = [f for f in fault_events if f > ts]
            if future_faults:
                nearest_fault = min(future_faults)
                delta = (nearest_fault - ts).total_seconds() / (24 * 3600)
                days_to_fault.append(min(delta, self.config.max_horizon_days))
            else:
                # No future faults - censored at max horizon
                days_to_fault.append(float(self.config.max_horizon_days))

        return df.with_columns(pl.Series("days_to_fault", days_to_fault))

    def generate_from_threshold(
        self,
        df: pl.DataFrame,
        metric_col: str,
        timestamp_col: str = "timestamp",
        trend_col: Optional[str] = None,
    ) -> pl.DataFrame:
        """
        Generate RUL labels by extrapolating when metric will cross threshold.

        Uses current value and trend to estimate time-to-threshold.

        Args:
            df: DataFrame with time-series data
            metric_col: Column containing the metric
            timestamp_col: Column containing timestamps
            trend_col: Column containing trend/slope (if None, compute from data)

        Returns:
            DataFrame with 'days_to_fault' column added
        """
        if metric_col not in df.columns:
            raise ValueError(f"Metric column '{metric_col}' not found")

        # Compute trend if not provided
        if trend_col is None or trend_col not in df.columns:
            # Use 7-day trend approximation
            window = min(288 * 7, len(df) // 3)  # 7 days or 1/3 of data
            if window < 288:  # Need at least 1 day
                # Can't compute trend - use heuristic
                return self._generate_heuristic_labels(df, metric_col)

            half_window = window // 2
            df = df.with_columns([
                pl.col(metric_col).rolling_mean(window_size=half_window).alias("_recent"),
                pl.col(metric_col).shift(half_window).rolling_mean(window_size=half_window).alias("_past"),
            ])
            df = df.with_columns(
                ((pl.col("_recent") - pl.col("_past")) / half_window * 288).alias("_trend_per_day")  # Daily trend
            )
            df = df.drop(["_recent", "_past"])
            trend_col = "_trend_per_day"

        # Extrapolate time to threshold
        threshold = self.config.threshold
        max_days = float(self.config.max_horizon_days)

        if self.config.higher_is_worse:
            # Metric increasing toward threshold (e.g., temperature, CV)
            df = df.with_columns(
                pl.when(pl.col(metric_col) >= threshold)
                .then(0.0)  # Already at/past threshold
                .when(pl.col(trend_col) <= 0)
                .then(max_days)  # Not degrading
                .otherwise(
                    ((threshold - pl.col(metric_col)) / pl.col(trend_col)).clip(0, max_days)
                )
                .alias("days_to_fault")
            )
        else:
            # Metric decreasing toward threshold (e.g., PR, efficiency)
            df = df.with_columns(
                pl.when(pl.col(metric_col) <= threshold)
                .then(0.0)  # Already at/past threshold
                .when(pl.col(trend_col) >= 0)
                .then(max_days)  # Not degrading
                .otherwise(
                    ((pl.col(metric_col) - threshold) / (-pl.col(trend_col))).clip(0, max_days)
                )
                .alias("days_to_fault")
            )

        # Clean up temp columns
        if "_trend_per_day" in df.columns:
            df = df.drop(["_trend_per_day"])

        return df

    def generate_from_degradation_class(
        self,
        df: pl.DataFrame,
        fault_class_col: str = "fault_class",
        degradation_class: int = 3,
    ) -> pl.DataFrame:
        """
        Convert binary degradation labels to synthetic RUL.

        Assigns RUL based on severity:
        - Non-degraded samples: max_horizon
        - Degraded samples: assign based on severity estimate

        For Lazzaretti dataset where degradation_class=3 is "degradation".

        Args:
            df: DataFrame with fault class labels
            fault_class_col: Column containing fault class
            degradation_class: Value representing degradation

        Returns:
            DataFrame with 'days_to_fault' column added
        """
        if fault_class_col not in df.columns:
            raise ValueError(f"Fault class column '{fault_class_col}' not found")

        max_days = float(self.config.max_horizon_days)

        # For degraded samples, estimate severity from available features
        # Simple heuristic: use random assignment within reasonable range
        # In production, this would use feature-based severity estimation

        np.random.seed(42)  # Reproducibility
        n_samples = len(df)

        # Generate severity-based RUL
        # Non-degraded: max horizon
        # Degraded: 1-14 days (weighted toward lower values for more urgency)
        rul_values = []

        fault_classes = df[fault_class_col].to_numpy()

        for fc in fault_classes:
            if fc == degradation_class:
                # Degraded - assign random RUL weighted toward urgency
                # Gamma distribution gives realistic degradation progression
                rul = np.random.gamma(shape=2, scale=3)  # Mean ~6 days
                rul = max(1.0, min(rul, max_days))
            else:
                # Not degraded - max horizon
                rul = max_days

            rul_values.append(rul)

        return df.with_columns(pl.Series("days_to_fault", rul_values))

    def generate_from_lazzaretti(
        self,
        df: pl.DataFrame,
        fault_class_col: str = "fault_class",
    ) -> pl.DataFrame:
        """
        Generate RUL labels specifically for Lazzaretti dataset.

        Lazzaretti fault classes:
        - 0: Normal
        - 1: Short circuit (reactive - instant)
        - 2: String degradation (predictable)
        - 3: Open circuit (reactive - instant)
        - 4: Partial shading (predictable)

        Args:
            df: Lazzaretti DataFrame
            fault_class_col: Fault class column name

        Returns:
            DataFrame with 'days_to_fault' column for each fault type
        """
        max_days = float(self.config.max_horizon_days)

        # Use severity estimation based on available metrics
        df = df.with_columns([
            pl.lit(max_days).alias("days_to_string_degradation"),
            pl.lit(max_days).alias("days_to_shading"),
        ])

        # For degradation class (2), estimate severity from string current CV
        if "string_current_cv" in df.columns:
            # Higher CV = closer to fault
            cv_col = pl.col("string_current_cv")
            df = df.with_columns(
                pl.when(pl.col(fault_class_col) == 3)  # Degradation (mapped as 3)
                .then(
                    # Estimate RUL inversely proportional to CV
                    # CV=0.1 -> 14 days, CV=0.25 -> 0 days
                    ((0.25 - cv_col.clip(0, 0.25)) / 0.15 * 14).clip(0, 14)
                )
                .otherwise(pl.col("days_to_string_degradation"))
                .alias("days_to_string_degradation")
            )

        # For shading class (4), estimate from irradiance patterns
        if "poa_irradiance" in df.columns:
            df = df.with_columns(
                pl.when(pl.col(fault_class_col) == 4)  # Shading
                .then(
                    # Shading is partially predictable (3-7 days)
                    pl.lit(np.random.uniform(3, 7, len(df))).cast(pl.Float64)
                )
                .otherwise(pl.col("days_to_shading"))
                .alias("days_to_shading")
            )

        return df

    # Private helper methods

    def _detect_fault_events(
        self,
        df: pl.DataFrame,
        metric_col: str,
        timestamp_col: str,
    ) -> list[datetime]:
        """Auto-detect fault events where metric crosses threshold."""
        threshold = self.config.threshold
        higher_is_worse = self.config.higher_is_worse

        # Find threshold crossings
        if higher_is_worse:
            # Fault when metric goes above threshold
            faults = df.filter(pl.col(metric_col) >= threshold)
        else:
            # Fault when metric goes below threshold
            faults = df.filter(pl.col(metric_col) <= threshold)

        if len(faults) == 0:
            return []

        # Get unique fault event timestamps (group nearby events)
        fault_times = [self._parse_timestamp(ts) for ts in faults[timestamp_col].to_list()]
        fault_times = [t for t in fault_times if t is not None]

        if not fault_times:
            return []

        # Deduplicate nearby events (within 1 hour = same event)
        fault_times.sort()
        deduped = [fault_times[0]]
        for t in fault_times[1:]:
            if (t - deduped[-1]).total_seconds() > 3600:
                deduped.append(t)

        return deduped

    def _generate_heuristic_labels(
        self,
        df: pl.DataFrame,
        metric_col: str,
    ) -> pl.DataFrame:
        """Generate labels using simple heuristics when trend unavailable."""
        threshold = self.config.threshold
        max_days = float(self.config.max_horizon_days)

        if self.config.higher_is_worse:
            # Distance from threshold (0 = at threshold, 1 = far from threshold)
            df = df.with_columns(
                ((threshold - pl.col(metric_col).clip(0, threshold)) / threshold * max_days)
                .clip(0, max_days)
                .alias("days_to_fault")
            )
        else:
            # Inverse for metrics where lower is worse
            df = df.with_columns(
                ((pl.col(metric_col).clip(threshold, 1.0) - threshold) / (1.0 - threshold) * max_days)
                .clip(0, max_days)
                .alias("days_to_fault")
            )

        return df

    def _parse_timestamp(self, ts) -> Optional[datetime]:
        """Parse various timestamp formats to datetime."""
        if ts is None:
            return None
        if isinstance(ts, datetime):
            return ts
        if hasattr(ts, "to_pydatetime"):
            return ts.to_pydatetime()
        if isinstance(ts, str):
            for fmt in [
                "%Y.%m.%d %H:%M",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M",
                "%Y/%m/%d %H:%M",
            ]:
                try:
                    return datetime.strptime(ts, fmt)
                except ValueError:
                    continue
        return None


def create_rul_labels_for_training(
    df: pl.DataFrame,
    fault_type: str,
    metric_col: str,
    timestamp_col: str = "timestamp",
) -> pl.DataFrame:
    """
    Convenience function to create RUL labels for a specific fault type.

    Args:
        df: Input DataFrame
        fault_type: One of "string_degradation", "inverter_thermal", "module_degradation"
        metric_col: Column containing the metric to monitor
        timestamp_col: Timestamp column

    Returns:
        DataFrame with 'days_to_fault' column
    """
    configs = {
        "string_degradation": STRING_DEGRADATION_CONFIG,
        "inverter_thermal": INVERTER_THERMAL_CONFIG,
        "module_degradation": MODULE_DEGRADATION_CONFIG,
    }

    if fault_type not in configs:
        raise ValueError(f"Unknown fault type: {fault_type}. Use one of {list(configs.keys())}")

    generator = RULLabelGenerator(configs[fault_type])
    return generator.generate_from_threshold(df, metric_col, timestamp_col)
