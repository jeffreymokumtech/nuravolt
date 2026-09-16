"""
Data Transformer Module

Transforms wide-format data (one column per inverter) to long-format
(inverter_id as categorical column) for plant-level model training.

Wide format:
    timestamp | irradiance | temp | INV_01.001 | INV_01.002 | ...
    2024-01-01 12:00 | 800 | 25 | 0.85 | 0.83 | ...

Long format:
    timestamp | irradiance | temp | inverter_id | group_id | power
    2024-01-01 12:00 | 800 | 25 | INV 01.001 | INV 01 | 0.85
    2024-01-01 12:00 | 800 | 25 | INV 01.002 | INV 01 | 0.83

Usage:
    from nuravolt.digitaltwin import WideToLongTransformer, PlantConfig

    config = PlantConfig.from_yaml("plant_configs/alpha1.yaml")
    transformer = WideToLongTransformer(config)

    df_long = transformer.transform(df_wide)
    df_wide = transformer.inverse_transform(df_long)
"""

import re
from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from .plant_config import PlantConfig


@dataclass
class TransformResult:
    """Result of wide-to-long transformation."""
    df_long: pd.DataFrame
    inverter_ids: list[str]
    group_ids: list[str]
    feature_columns: list[str]
    n_timestamps: int
    n_inverters: int
    n_rows: int


class WideToLongTransformer:
    """
    Transform wide-format inverter data to long-format for plant-level modeling.

    The long format enables training a single CatBoost model with inverter_id
    as a categorical feature, rather than 150 separate models.

    Attributes:
        config: PlantConfig with column mappings and component hierarchy
        feature_columns: List of non-inverter feature column names
        inverter_columns: List of inverter power column names
    """

    def __init__(self, config: PlantConfig):
        """
        Initialize transformer with plant configuration.

        Args:
            config: PlantConfig instance with column mappings
        """
        self.config = config
        self.feature_columns: list[str] = []
        self.inverter_columns: list[str] = []
        self._inverter_pattern = re.compile(config.data.inverter_pattern)

    def identify_columns(self, df: pd.DataFrame) -> tuple[list[str], list[str]]:
        """
        Identify feature columns vs inverter power columns.

        Args:
            df: Input DataFrame with mixed columns

        Returns:
            Tuple of (feature_columns, inverter_columns)
        """
        feature_cols = []
        inverter_cols = []

        for col in df.columns:
            # Skip timestamp/index
            if col == self.config.data.timestamp_column or col == "timestamp":
                continue

            # Check if column matches inverter pattern
            match = self._inverter_pattern.search(col)
            if match:
                inverter_cols.append(col)
            else:
                feature_cols.append(col)

        self.feature_columns = feature_cols
        self.inverter_columns = sorted(inverter_cols)

        return feature_cols, inverter_cols

    def extract_inverter_id(self, column_name: str) -> Optional[str]:
        """
        Extract inverter ID from column name using configured pattern.

        Args:
            column_name: Original column name (e.g., "Alpha1 (ES): INV 01.001 / ...")

        Returns:
            Extracted inverter ID (e.g., "INV 01.001") or None
        """
        match = self._inverter_pattern.search(column_name)
        if match:
            return match.group(1)
        return None

    def get_group_id(self, inverter_id: str) -> str:
        """
        Get group ID for an inverter from component hierarchy.

        Args:
            inverter_id: Inverter identifier (e.g., "INV 01.001")

        Returns:
            Group ID (e.g., "INV 01") or derived from inverter_id
        """
        # Try config hierarchy first
        group_id = self.config.components.get_group_for_inverter(inverter_id)
        if group_id:
            return group_id

        # Fallback: derive from inverter_id pattern (e.g., "INV 01.001" -> "INV 01")
        parts = inverter_id.rsplit(".", 1)
        if len(parts) == 2:
            return parts[0]

        return "default"

    def transform(self, df_wide: pd.DataFrame) -> TransformResult:
        """
        Transform wide-format DataFrame to long-format using Polars for memory efficiency.

        Wide format has one column per inverter:
            timestamp | irradiance | temp | INV_01.001 | INV_01.002 | ...

        Long format has inverter_id as a column:
            timestamp | irradiance | temp | inverter_id | group_id | power

        Args:
            df_wide: Wide-format DataFrame with inverter columns

        Returns:
            TransformResult with long-format DataFrame and metadata
        """
        import polars as pl

        # Identify columns
        feature_cols, inverter_cols = self.identify_columns(df_wide)

        if not inverter_cols:
            raise ValueError("No inverter columns found matching pattern: "
                           f"{self.config.data.inverter_pattern}")

        # Build mapping: original_column -> inverter_id
        col_to_inverter = {}
        for col in inverter_cols:
            inv_id = self.extract_inverter_id(col)
            if inv_id:
                col_to_inverter[col] = inv_id

        # Convert to Polars for memory-efficient melt operation
        df_pl = pl.from_pandas(df_wide)

        # Ensure timestamp is a column
        if "timestamp" not in df_pl.columns:
            df_pl = df_pl.with_columns(pl.col("index").alias("timestamp"))

        # Rename inverter columns to clean IDs
        rename_map = {col: inv_id for col, inv_id in col_to_inverter.items()}
        df_pl = df_pl.rename(rename_map)

        # Get clean inverter IDs
        inverter_ids = list(col_to_inverter.values())

        # Identify id vars
        id_vars = ["timestamp"] + [c for c in feature_cols if c in df_pl.columns]

        # Melt using Polars (much more memory efficient than pandas)
        df_long_pl = df_pl.melt(
            id_vars=id_vars,
            value_vars=inverter_ids,
            variable_name="inverter_id",
            value_name="power",
        )

        # Add group_id column
        group_mapping = {inv_id: self.get_group_id(inv_id) for inv_id in inverter_ids}
        df_long_pl = df_long_pl.with_columns(
            pl.col("inverter_id").replace(group_mapping, default=None).alias("group_id")
        )

        # Sort for consistent ordering
        df_long_pl = df_long_pl.sort(["timestamp", "inverter_id"])

        # Convert back to pandas for downstream compatibility
        df_long = df_long_pl.to_pandas()

        # Convert to categorical for CatBoost
        df_long["inverter_id"] = pd.Categorical(df_long["inverter_id"])
        df_long["group_id"] = pd.Categorical(df_long["group_id"])

        # Get unique values
        unique_inverters = sorted(df_long["inverter_id"].unique())
        unique_groups = sorted(df_long["group_id"].unique())

        return TransformResult(
            df_long=df_long,
            inverter_ids=unique_inverters,
            group_ids=unique_groups,
            feature_columns=feature_cols,
            n_timestamps=df_wide.shape[0],
            n_inverters=len(unique_inverters),
            n_rows=len(df_long),
        )

    def inverse_transform(
        self,
        df_long: pd.DataFrame,
        value_column: str = "power",
    ) -> pd.DataFrame:
        """
        Transform long-format DataFrame back to wide-format.

        Args:
            df_long: Long-format DataFrame with inverter_id column
            value_column: Column containing values to pivot (default: "power")

        Returns:
            Wide-format DataFrame with one column per inverter
        """
        # Identify feature columns (everything except inverter_id, group_id, value)
        exclude_cols = {"inverter_id", "group_id", value_column}
        id_cols = [c for c in df_long.columns if c not in exclude_cols]

        # Pivot: long to wide
        df_wide = df_long.pivot_table(
            index=id_cols,
            columns="inverter_id",
            values=value_column,
            aggfunc="first",  # Should be unique per timestamp+inverter
        ).reset_index()

        # Flatten column names if MultiIndex
        if isinstance(df_wide.columns, pd.MultiIndex):
            df_wide.columns = [
                f"{a}_{b}" if b else a for a, b in df_wide.columns
            ]

        return df_wide


def rename_columns_for_training(
    df: pd.DataFrame,
    config: PlantConfig,
) -> pd.DataFrame:
    """
    Rename raw data columns to standardized names for training.

    Args:
        df: Raw DataFrame with original column names
        config: PlantConfig with column mappings

    Returns:
        DataFrame with standardized column names
    """
    rename_map = {}

    # Map configured columns
    col_mapping = config.data.columns
    if col_mapping.irradiance:
        rename_map[col_mapping.irradiance] = "irradiance"
    if col_mapping.ambient_temp:
        rename_map[col_mapping.ambient_temp] = "ambient_temp"
    if col_mapping.module_temp:
        rename_map[col_mapping.module_temp] = "module_temp"
    if col_mapping.wind_speed:
        rename_map[col_mapping.wind_speed] = "wind_speed"
    if col_mapping.solar_elevation:
        rename_map[col_mapping.solar_elevation] = "solar_elevation"
    if col_mapping.solar_azimuth:
        rename_map[col_mapping.solar_azimuth] = "solar_azimuth"
    if col_mapping.humidity:
        rename_map[col_mapping.humidity] = "humidity"

    return df.rename(columns=rename_map)


def load_and_transform(
    config: PlantConfig,
    limit_rows: Optional[int] = None,
) -> TransformResult:
    """
    Load data from configured source and transform to long format.

    Args:
        config: PlantConfig with data source and column mappings
        limit_rows: Optional row limit for testing

    Returns:
        TransformResult with long-format DataFrame
    """
    from pathlib import Path

    # Load data
    source_path = Path(config.data.source_path)
    if not source_path.exists():
        raise FileNotFoundError(f"Data file not found: {source_path}")

    df = pd.read_parquet(source_path)

    if limit_rows:
        df = df.head(limit_rows)

    # Rename columns
    df = rename_columns_for_training(df, config)

    # Parse timestamp
    ts_col = config.data.timestamp_column
    if ts_col in df.columns:
        if config.data.timestamp_format:
            df[ts_col] = pd.to_datetime(df[ts_col], format=config.data.timestamp_format)
        else:
            df[ts_col] = pd.to_datetime(df[ts_col])

    # Transform to long format
    transformer = WideToLongTransformer(config)
    return transformer.transform(df)


def filter_training_period(
    df_long: pd.DataFrame,
    max_years: Optional[float],
) -> pd.DataFrame:
    """
    Filter data to training period (first N years).

    Args:
        df_long: Long-format DataFrame with timestamp column
        max_years: Maximum years of data to use (None = use all data)

    Returns:
        Filtered DataFrame
    """
    if "timestamp" not in df_long.columns:
        return df_long

    # None means use all available data
    if max_years is None:
        return df_long

    start_date = df_long["timestamp"].min()
    end_date = start_date + pd.Timedelta(days=int(max_years * 365))

    return df_long[df_long["timestamp"] <= end_date].copy()


def add_temporal_features(df_long: pd.DataFrame) -> pd.DataFrame:
    """
    Add temporal features for model training.

    Args:
        df_long: Long-format DataFrame with timestamp column

    Returns:
        DataFrame with added temporal features
    """
    df = df_long.copy()

    if "timestamp" not in df.columns:
        return df

    ts = pd.to_datetime(df["timestamp"])

    # Time-based features
    df["hour"] = ts.dt.hour
    df["day_of_year"] = ts.dt.dayofyear
    df["month"] = ts.dt.month

    # Cyclical encoding for hour (captures daily pattern)
    df["hour_sin"] = np.sin(2 * np.pi * df["hour"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour"] / 24)

    # Cyclical encoding for day of year (captures seasonal pattern)
    df["doy_sin"] = np.sin(2 * np.pi * df["day_of_year"] / 365)
    df["doy_cos"] = np.cos(2 * np.pi * df["day_of_year"] / 365)

    return df
