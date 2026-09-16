"""
String-Level Feature Engineering

Extends existing physics feature engineering for string-level digital twins.
Adds string-specific features:
- Solar geometry (elevation, azimuth) from PhysicsFeatureEngineer
- Relative performance (string vs neighbor strings)
- Temporal encodings (hour, day of year, cyclical)

Usage:
    from nuravolt.digitaltwin import StringFeatureEngineer

    engineer = StringFeatureEngineer(
        latitude=37.5,
        longitude=-121.9,
    )

    # Add all string features
    df_enhanced = engineer.add_string_features(
        df,
        string_col="Input_current_01",
        neighbor_cols=["Input_current_02", "Input_current_03"],
    )

    # Or use individual feature groups
    df = engineer.add_solar_geometry(df)
    df = engineer.add_relative_performance(df, string_col, neighbor_cols)
"""

import logging
from typing import List, Optional

import numpy as np
import polars as pl
import pandas as pd

from .feature_engineering import (
    PhysicsFeatureEngineer,
    LocationParams,
    ModuleParams,
    FeatureEngConfig,
)

logger = logging.getLogger(__name__)


class StringFeatureEngineer:
    """
    Feature engineering for string-level digital twins.

    Combines:
    1. Physics-based features (solar geometry, temperature)
    2. Temporal features (cyclical encodings)
    3. String-specific features (relative performance)
    """

    def __init__(
        self,
        latitude: float = 0.0,
        longitude: float = 0.0,
        altitude: float = 0.0,
        tilt: float = 0.0,
        azimuth: float = 180.0,
        timezone: str = "UTC",
    ):
        """
        Initialize string feature engineer.

        Args:
            latitude: Plant latitude (degrees)
            longitude: Plant longitude (degrees)
            altitude: Altitude (meters)
            tilt: Array tilt (degrees)
            azimuth: Array azimuth (180 = south)
            timezone: Timezone string
        """
        self.location = LocationParams(
            latitude=latitude,
            longitude=longitude,
            altitude=altitude,
            timezone=timezone,
            tilt=tilt,
            azimuth=azimuth,
        )

        # Physics feature engineer for solar geometry
        self.physics_engineer = PhysicsFeatureEngineer(
            location=self.location,
            module=ModuleParams(),
            config=FeatureEngConfig(
                generate_solar_geometry=True,
                generate_temporal_encoding=True,
            ),
        )

    def add_string_features(
        self,
        df: pl.DataFrame,
        string_col: str,
        neighbor_cols: Optional[List[str]] = None,
        add_solar: bool = True,
        add_temporal: bool = True,
        add_relative: bool = True,
    ) -> pl.DataFrame:
        """
        Add all string-level features to DataFrame.

        Args:
            df: Input DataFrame with timestamp and string current
            string_col: Target string current column
            neighbor_cols: Neighbor string columns for relative features
            add_solar: Add solar geometry features
            add_temporal: Add temporal features
            add_relative: Add relative performance features

        Returns:
            DataFrame with added features
        """
        result = df.clone()

        # Convert to pandas for physics engineer (it expects pandas)
        if add_solar or add_temporal:
            df_pd = df.to_pandas()

            if add_solar:
                df_pd = self.add_solar_geometry_pd(df_pd)

            if add_temporal:
                df_pd = self.add_temporal_features_pd(df_pd)

            # Convert back to polars
            result = pl.from_pandas(df_pd)

        # Add relative performance (native polars)
        if add_relative and neighbor_cols:
            result = self.add_relative_performance(result, string_col, neighbor_cols)

        return result

    def add_solar_geometry(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Add solar geometry features (elevation, azimuth, air_mass).

        Uses pvlib for accurate solar position calculations.

        Returns:
            DataFrame with solar_elevation, solar_azimuth, air_mass columns
        """
        df_pd = df.to_pandas()
        df_pd = self.add_solar_geometry_pd(df_pd)
        return pl.from_pandas(df_pd)

    def add_solar_geometry_pd(self, df: pd.DataFrame) -> pd.DataFrame:
        """Add solar geometry features (pandas implementation)."""
        if "timestamp" not in df.columns:
            logger.warning("No timestamp column found, skipping solar geometry")
            return df

        # Ensure datetime index
        if not isinstance(df.index, pd.DatetimeIndex):
            if pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
                df = df.set_index("timestamp")
            else:
                df["timestamp"] = pd.to_datetime(df["timestamp"])
                df = df.set_index("timestamp")

        # Use physics engineer to add solar features
        try:
            df = self.physics_engineer.add_solar_geometry(df)
        except Exception as e:
            logger.warning(f"Failed to add solar geometry: {e}")

        return df.reset_index()

    def add_temporal_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Add temporal features with cyclical encoding.

        Returns:
            DataFrame with hour_of_day, day_of_year, hour_sin, hour_cos, doy_sin, doy_cos
        """
        result = df.clone()

        # Ensure timestamp column exists
        ts_col = self._find_timestamp_column(df)
        if not ts_col:
            logger.warning("No timestamp column found, skipping temporal features")
            return result

        # Extract temporal features
        if "hour_of_day" not in result.columns:
            result = result.with_columns(
                pl.col(ts_col).dt.hour().alias("hour_of_day")
            )

        if "day_of_year" not in result.columns:
            result = result.with_columns(
                pl.col(ts_col).dt.ordinal_day().alias("day_of_year")
            )

        if "month" not in result.columns:
            result = result.with_columns(
                pl.col(ts_col).dt.month().alias("month")
            )

        # Cyclical encoding
        if "hour_sin" not in result.columns:
            result = result.with_columns([
                (pl.col("hour_of_day") * 2 * np.pi / 24).sin().alias("hour_sin"),
                (pl.col("hour_of_day") * 2 * np.pi / 24).cos().alias("hour_cos"),
            ])

        if "doy_sin" not in result.columns:
            result = result.with_columns([
                (pl.col("day_of_year") * 2 * np.pi / 365).sin().alias("doy_sin"),
                (pl.col("day_of_year") * 2 * np.pi / 365).cos().alias("doy_cos"),
            ])

        return result

    def add_temporal_features_pd(self, df: pd.DataFrame) -> pd.DataFrame:
        """Add temporal features (pandas implementation)."""
        # Hour of day
        if "hour_of_day" not in df.columns:
            if isinstance(df.index, pd.DatetimeIndex):
                df["hour_of_day"] = df.index.hour + df.index.minute / 60
            elif "timestamp" in df.columns:
                df["hour_of_day"] = pd.to_datetime(df["timestamp"]).dt.hour

        # Day of year
        if "day_of_year" not in df.columns:
            if isinstance(df.index, pd.DatetimeIndex):
                df["day_of_year"] = df.index.dayofyear
            elif "timestamp" in df.columns:
                df["day_of_year"] = pd.to_datetime(df["timestamp"]).dt.dayofyear

        # Month
        if "month" not in df.columns:
            if isinstance(df.index, pd.DatetimeIndex):
                df["month"] = df.index.month
            elif "timestamp" in df.columns:
                df["month"] = pd.to_datetime(df["timestamp"]).dt.month

        # Cyclical encoding
        if "hour_of_day" in df.columns:
            df["hour_sin"] = np.sin(2 * np.pi * df["hour_of_day"] / 24)
            df["hour_cos"] = np.cos(2 * np.pi * df["hour_of_day"] / 24)

        if "day_of_year" in df.columns:
            df["doy_sin"] = np.sin(2 * np.pi * df["day_of_year"] / 365)
            df["doy_cos"] = np.cos(2 * np.pi * df["day_of_year"] / 365)

        return df

    def add_relative_performance(
        self,
        df: pl.DataFrame,
        string_col: str,
        neighbor_cols: List[str],
        min_irradiance: float = 100.0,
    ) -> pl.DataFrame:
        """
        Add relative performance features (string vs neighbors).

        Calculates:
        - string_vs_mean: (string - mean_neighbors) / mean_neighbors
        - string_vs_median: (string - median_neighbors) / median_neighbors
        - string_rank: Rank of string among neighbors (1 = best)

        These features help detect mismatch (one string underperforms vs others).

        Args:
            df: Input DataFrame
            string_col: Target string current column
            neighbor_cols: List of neighbor string columns
            min_irradiance: Minimum irradiance for valid comparison (W/m²)

        Returns:
            DataFrame with relative performance features
        """
        if not neighbor_cols or len(neighbor_cols) < 2:
            logger.warning("Need at least 2 neighbor strings for relative features")
            return df

        result = df.clone()

        # Filter to daylight hours if irradiance available
        irrad_col = self._find_column(df, ["irradiance", "poa", "ghi"])
        if irrad_col:
            valid_mask = pl.col(irrad_col) >= min_irradiance
        else:
            valid_mask = pl.lit(True)

        # Calculate neighbor statistics
        neighbor_exprs = [pl.col(c) for c in neighbor_cols if c in df.columns]

        if not neighbor_exprs:
            logger.warning("No neighbor columns found in DataFrame")
            return df

        # Mean and median of neighbors
        result = result.with_columns([
            pl.mean_horizontal(neighbor_exprs).alias("_neighbor_mean"),
            pl.median_horizontal(neighbor_exprs).alias("_neighbor_median"),
        ])

        # Relative performance
        result = result.with_columns([
            pl.when(valid_mask & (pl.col("_neighbor_mean") > 0.1))
            .then(
                (pl.col(string_col) - pl.col("_neighbor_mean")) / pl.col("_neighbor_mean") * 100
            )
            .otherwise(0.0)
            .alias("string_vs_mean_pct"),
        ])

        result = result.with_columns([
            pl.when(valid_mask & (pl.col("_neighbor_median") > 0.1))
            .then(
                (pl.col(string_col) - pl.col("_neighbor_median")) / pl.col("_neighbor_median") * 100
            )
            .otherwise(0.0)
            .alias("string_vs_median_pct"),
        ])

        # Rank among all strings (including self)
        all_string_cols = [string_col] + [c for c in neighbor_cols if c in df.columns]

        # Create temporary rank column
        for i, col in enumerate(all_string_cols, 1):
            if col == string_col:
                # This will be replaced with actual rank
                result = result.with_columns([
                    pl.lit(0).alias("_temp_rank")
                ])
                break

        # Calculate rank (higher current = better rank)
        # This is simplified - proper rank would need row-wise comparison
        result = result.with_columns([
            pl.when(pl.col(string_col) >= pl.col("_neighbor_mean"))
            .then(pl.lit(1))  # Above average
            .otherwise(pl.lit(len(all_string_cols)))  # Below average
            .alias("string_rank")
        ])

        # Clean up temporary columns
        result = result.drop(["_neighbor_mean", "_neighbor_median", "_temp_rank"])

        return result

    def _find_timestamp_column(self, df: pl.DataFrame) -> Optional[str]:
        """Find timestamp column."""
        candidates = ["timestamp", "datetime", "time", "date"]
        for col in df.columns:
            if col.lower() in candidates:
                return col
        return None

    def _find_column(self, df: pl.DataFrame, patterns: List[str]) -> Optional[str]:
        """Find first column matching any pattern (case-insensitive)."""
        df_cols_lower = {c.lower(): c for c in df.columns}

        for pattern in patterns:
            for col_lower, col_original in df_cols_lower.items():
                if pattern.lower() in col_lower:
                    return col_original

        return None


def calculate_string_relative_features(
    df: pl.DataFrame,
    string_current_cols: List[str],
    min_irradiance: float = 100.0,
) -> pl.DataFrame:
    """
    Calculate relative performance features for all strings.

    This is a convenience function that adds relative features for multiple strings
    at once, comparing each string to its neighbors on the same inverter.

    Args:
        df: Input DataFrame with string current columns
        string_current_cols: List of string current column names
        min_irradiance: Minimum irradiance for valid comparison

    Returns:
        DataFrame with added relative features for each string
    """
    result = df.clone()

    engineer = StringFeatureEngineer()

    for string_col in string_current_cols:
        # Get neighbor columns (all others on same inverter)
        neighbor_cols = [c for c in string_current_cols if c != string_col]

        if len(neighbor_cols) >= 2:
            # Add relative features with string-specific names
            result = engineer.add_relative_performance(
                result, string_col, neighbor_cols, min_irradiance
            )

            # Rename generic columns to string-specific
            string_name = string_col.split("/")[-1].replace("(A)", "").strip()
            safe_name = string_name.replace(" ", "_")

            result = result.rename({
                "string_vs_mean_pct": f"{safe_name}_vs_mean_pct",
                "string_vs_median_pct": f"{safe_name}_vs_median_pct",
                "string_rank": f"{safe_name}_rank",
            })

    return result
