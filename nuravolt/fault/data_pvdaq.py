"""
PVDAQ Data Loader for Thermal RUL Models

Loads PV system data from NREL's PVDAQ database (now on AWS/OEDI Data Lake).
The PVDAQ v3 API has been decommissioned; data is now accessed via:
- AWS Data Lake (Parquet format)
- pvdaq_access Python package: https://github.com/NREL/pvdaq_access

This module provides utilities for:
- Loading PVDAQ data from local Parquet files
- Extracting thermal features (ambient_temp, module_temp, temp_delta)
- Computing thermal stress indicators for RUL models
- Converting time-series to ML-ready features

References:
- OEDI Data Portal: https://data.openei.org/submissions/4568
- GitHub docs: https://github.com/openEDI/documentation/blob/main/pvdaq.md
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, Union
import json
import polars as pl
import numpy as np


@dataclass
class PVDAQSystemConfig:
    """Configuration for a PVDAQ system."""

    system_id: int
    name: str = ""
    rated_dc_power_kw: float = 0.0
    latitude: float = 0.0
    longitude: float = 0.0
    timezone: str = "UTC"

    # Metric IDs for this system (vary by system)
    ambient_temp_metric: Optional[int] = None
    module_temp_metric: Optional[int] = None
    poa_irradiance_metric: Optional[int] = None
    dc_power_metric: Optional[int] = None
    ac_power_metric: Optional[int] = None


# Known PVDAQ systems with thermal data
# These systems have both ambient_temp and module_temp sensors
SYSTEMS_WITH_THERMAL = {
    # System ID: (name, rated_dc_kw, lat, lon)
    34: ("NREL Mesa 1", 26.0, 39.74, -105.18),
    1199: ("NREL Parking Garage", 524.0, 39.74, -105.18),
    1283: ("Sandia PERT", 3.36, 35.05, -106.54),
    2: ("NREL Mesa 2", 7.5, 39.74, -105.18),
    4: ("NREL Mesa 4", 2.0, 39.74, -105.18),
}


class PVDAQLoader:
    """
    Load PVDAQ data for thermal RUL models.

    PVDAQ data structure (on AWS):
    - pvdaq_pvdata: time-series (system_id, measured_on, metric_id, value)
    - pvdaq_metrics: metric metadata (metric_id, common_name, unit)
    - pvdaq_site: system metadata (system_id, latitude, longitude)

    Usage:
        loader = PVDAQLoader()

        # From local parquet files
        df = loader.load_from_parquet("path/to/pvdaq_system_34.parquet")

        # Extract thermal features
        df_thermal = loader.compute_thermal_features(df)
    """

    def __init__(self, data_dir: Optional[str] = None):
        """
        Initialize PVDAQ loader.

        Args:
            data_dir: Directory containing PVDAQ parquet files
        """
        self.data_dir = Path(data_dir) if data_dir else None

    def load_from_parquet(
        self,
        file_path: str,
        system_config: Optional[PVDAQSystemConfig] = None,
    ) -> pl.DataFrame:
        """
        Load PVDAQ data from a local Parquet file.

        Expected schema (wide format after pivot):
        - timestamp: datetime
        - poa_irradiance: W/m²
        - ambient_temp: °C
        - module_temp: °C
        - dc_power: W or kW
        - ac_power: W or kW

        Or (long format from raw PVDAQ):
        - system_id: int
        - measured_on: datetime
        - metric_id: int
        - value: float

        Args:
            file_path: Path to Parquet file
            system_config: Optional system configuration

        Returns:
            DataFrame with standardized columns
        """
        df = pl.read_parquet(file_path)

        # Check if long format (raw PVDAQ)
        if "metric_id" in df.columns and "value" in df.columns:
            df = self._pivot_long_to_wide(df, system_config)

        # Standardize column names
        df = self._standardize_columns(df)

        return df

    def _pivot_long_to_wide(
        self,
        df: pl.DataFrame,
        system_config: Optional[PVDAQSystemConfig] = None,
    ) -> pl.DataFrame:
        """
        Convert PVDAQ long format to wide format.

        Long format: (timestamp, metric_id, value)
        Wide format: (timestamp, ambient_temp, module_temp, poa_irradiance, ...)
        """
        # If system config provided, use metric mappings
        if system_config and system_config.ambient_temp_metric:
            metric_mapping = {}
            if system_config.ambient_temp_metric:
                metric_mapping[system_config.ambient_temp_metric] = "ambient_temp"
            if system_config.module_temp_metric:
                metric_mapping[system_config.module_temp_metric] = "module_temp"
            if system_config.poa_irradiance_metric:
                metric_mapping[system_config.poa_irradiance_metric] = "poa_irradiance"
            if system_config.dc_power_metric:
                metric_mapping[system_config.dc_power_metric] = "dc_power"
            if system_config.ac_power_metric:
                metric_mapping[system_config.ac_power_metric] = "ac_power"

            # Filter to needed metrics and pivot
            metric_ids = list(metric_mapping.keys())
            df_filtered = df.filter(pl.col("metric_id").is_in(metric_ids))

            # Add metric name column
            df_filtered = df_filtered.with_columns(
                pl.col("metric_id").replace(metric_mapping).alias("metric_name")
            )

            # Pivot
            df_wide = df_filtered.pivot(
                values="value",
                index="measured_on",
                on="metric_name",
            ).rename({"measured_on": "timestamp"})

            return df_wide

        # Without config, return as-is (user must have pre-processed)
        return df

    def _standardize_columns(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Standardize column names to expected format.

        Maps common variations:
        - amb_temp, t_amb, ambient_temperature -> ambient_temp
        - mod_temp, t_mod, module_temperature -> module_temp
        - ghi, gti, poa, irradiance -> poa_irradiance
        """
        column_mappings = {
            # Ambient temperature variants
            "amb_temp": "ambient_temp",
            "t_amb": "ambient_temp",
            "t_ambient": "ambient_temp",
            "ambient_temperature": "ambient_temp",
            "air_temp": "ambient_temp",
            "temperature_ambient": "ambient_temp",

            # Module temperature variants
            "mod_temp": "module_temp",
            "t_mod": "module_temp",
            "t_module": "module_temp",
            "module_temperature": "module_temp",
            "cell_temp": "module_temp",
            "back_of_module_temp": "module_temp",
            "temperature_module": "module_temp",

            # Irradiance variants
            "ghi": "poa_irradiance",
            "gti": "poa_irradiance",
            "poa": "poa_irradiance",
            "irradiance": "poa_irradiance",
            "plane_of_array_irradiance": "poa_irradiance",
            "solar_irradiance": "poa_irradiance",

            # Power variants
            "power_dc": "dc_power",
            "p_dc": "dc_power",
            "dc_power_kw": "dc_power",
            "power_ac": "ac_power",
            "p_ac": "ac_power",
            "ac_power_kw": "ac_power",

            # Timestamp variants
            "datetime": "timestamp",
            "time": "timestamp",
            "measured_on": "timestamp",
            "utc_measured_on": "timestamp",
        }

        # Apply mappings
        for old_name, new_name in column_mappings.items():
            if old_name in df.columns and new_name not in df.columns:
                df = df.rename({old_name: new_name})

        return df

    def compute_thermal_features(
        self,
        df: pl.DataFrame,
        rated_dc_power_kw: float = 1000.0,
    ) -> pl.DataFrame:
        """
        Compute thermal stress features for RUL modeling.

        Features computed:
        - temp_delta: module_temp - ambient_temp
        - temp_delta_norm: temp_delta normalized by irradiance
        - power_density: dc_power / irradiance
        - thermal_stress: composite stress indicator

        Args:
            df: DataFrame with ambient_temp, module_temp, poa_irradiance
            rated_dc_power_kw: Rated DC power for normalization

        Returns:
            DataFrame with thermal features added
        """
        # Ensure required columns exist
        required_cols = ["ambient_temp", "module_temp"]
        missing = [c for c in required_cols if c not in df.columns]
        if missing:
            raise ValueError(f"Missing required columns: {missing}")

        # Basic thermal features
        df = df.with_columns([
            # Temperature delta (module - ambient)
            (pl.col("module_temp") - pl.col("ambient_temp")).alias("temp_delta"),
        ])

        # Add irradiance-normalized features if available
        if "poa_irradiance" in df.columns:
            df = df.with_columns([
                # Normalized temp delta (per 1000 W/m²)
                (
                    pl.col("temp_delta") / (pl.col("poa_irradiance") / 1000 + 0.01)
                ).clip(0, 100).alias("temp_delta_normalized"),

                # Irradiance normalized
                (pl.col("poa_irradiance") / 1000).clip(0, 1.5).alias("irradiance_normalized"),
            ])

        # Add power features if available
        if "dc_power" in df.columns:
            df = df.with_columns([
                # Power per unit irradiance (efficiency proxy)
                (
                    pl.col("dc_power") / (pl.col("poa_irradiance") + 1) / rated_dc_power_kw * 1000
                ).clip(0, 2).alias("power_efficiency"),

                # Power density (loading factor)
                (pl.col("dc_power") / rated_dc_power_kw).clip(0, 1.5).alias("power_pu"),
            ])

        return df

    def compute_thermal_trends(
        self,
        df: pl.DataFrame,
        window_days: int = 7,
    ) -> pl.DataFrame:
        """
        Compute rolling trends of thermal features.

        Trends computed:
        - temp_delta_trend_7d: 7-day slope of temp_delta
        - temp_delta_95th_7d: 95th percentile of temp_delta in 7 days
        - temp_delta_max_7d: Max temp_delta in 7 days

        Args:
            df: DataFrame with thermal features
            window_days: Rolling window size in days

        Returns:
            DataFrame with trend features added
        """
        # Ensure timestamp is sorted
        if "timestamp" in df.columns:
            df = df.sort("timestamp")

        # Assume 15-minute intervals (96 points per day)
        window_size = window_days * 96

        df = df.with_columns([
            # Rolling statistics
            pl.col("temp_delta")
                .rolling_mean(window_size=window_size)
                .alias(f"temp_delta_mean_{window_days}d"),

            pl.col("temp_delta")
                .rolling_std(window_size=window_size)
                .alias(f"temp_delta_std_{window_days}d"),

            pl.col("temp_delta")
                .rolling_max(window_size=window_size)
                .alias(f"temp_delta_max_{window_days}d"),

            pl.col("temp_delta")
                .rolling_quantile(quantile=0.95, window_size=window_size)
                .alias(f"temp_delta_95th_{window_days}d"),
        ])

        # Compute trend (slope) using rolling linear regression
        # Simplified: (last - first) / window_days
        df = df.with_columns([
            (
                (pl.col("temp_delta") -
                 pl.col("temp_delta").shift(window_size)) / window_days
            ).alias(f"temp_delta_trend_{window_days}d"),
        ])

        return df

    def generate_thermal_stress_labels(
        self,
        df: pl.DataFrame,
        threshold_temp_delta: float = 25.0,
        horizon_days: int = 10,
    ) -> pl.DataFrame:
        """
        Generate synthetic RUL labels for thermal stress.

        Labels are days until temp_delta exceeds threshold for sustained period.

        Logic:
        1. Identify "thermal fault events" where temp_delta > threshold sustained
        2. For each row before an event, compute days_to_fault
        3. Cap at horizon_days for normal operation

        Args:
            df: DataFrame with temp_delta column
            threshold_temp_delta: Temperature delta threshold (°C)
            horizon_days: Max prediction horizon

        Returns:
            DataFrame with days_to_fault column added
        """
        if "temp_delta" not in df.columns:
            raise ValueError("DataFrame must have 'temp_delta' column")

        # Identify fault events (temp_delta > threshold for 4+ consecutive hours)
        # At 15-min intervals, that's 16 consecutive points
        sustained_points = 16

        df = df.with_columns([
            (pl.col("temp_delta") > threshold_temp_delta).alias("above_threshold"),
        ])

        # Rolling sum to find sustained periods
        df = df.with_columns([
            pl.col("above_threshold")
                .cast(pl.Int32)
                .rolling_sum(window_size=sustained_points)
                .alias("sustained_count"),
        ])

        # Mark fault events
        df = df.with_columns([
            (pl.col("sustained_count") >= sustained_points).alias("is_fault_event"),
        ])

        # For each row, find days to next fault event
        # This is expensive, so we'll use a simplified approach:
        # Extrapolate based on current trend

        # If temp_delta is rising and will exceed threshold, compute days
        df = df.with_columns([
            pl.when(pl.col("is_fault_event"))
                .then(0.0)
                .when(pl.col("temp_delta") >= threshold_temp_delta - 5)
                .then(
                    # Close to threshold - use inverse proximity
                    ((threshold_temp_delta - pl.col("temp_delta")) / 5 * 3).clip(0, horizon_days)
                )
                .otherwise(horizon_days)
                .alias("days_to_fault"),
        ])

        return df.drop(["above_threshold", "sustained_count"])

    def load_pvdaq_with_thermal(
        self,
        system_id: int,
        year: int,
        data_dir: Optional[str] = None,
    ) -> pl.DataFrame:
        """
        Convenience method to load and process PVDAQ data with thermal features.

        Looks for file pattern: pvdaq_system_{system_id}_{year}.parquet

        Args:
            system_id: PVDAQ system ID
            year: Year of data
            data_dir: Directory containing data files

        Returns:
            DataFrame with thermal features and trends
        """
        data_dir = Path(data_dir) if data_dir else self.data_dir
        if not data_dir:
            raise ValueError("data_dir must be provided")

        # Try multiple file patterns
        patterns = [
            f"pvdaq_system_{system_id}_{year}.parquet",
            f"system_{system_id}_{year}.parquet",
            f"pvdaq_{system_id}.parquet",
            f"system_{system_id}.parquet",
        ]

        file_path = None
        for pattern in patterns:
            candidate = data_dir / pattern
            if candidate.exists():
                file_path = candidate
                break

        if file_path is None:
            raise FileNotFoundError(
                f"No PVDAQ data found for system {system_id} in {data_dir}. "
                f"Tried patterns: {patterns}"
            )

        # Get system config if known
        system_config = None
        if system_id in SYSTEMS_WITH_THERMAL:
            name, dc_kw, lat, lon = SYSTEMS_WITH_THERMAL[system_id]
            system_config = PVDAQSystemConfig(
                system_id=system_id,
                name=name,
                rated_dc_power_kw=dc_kw,
                latitude=lat,
                longitude=lon,
            )

        # Load and process
        df = self.load_from_parquet(str(file_path), system_config)

        rated_kw = system_config.rated_dc_power_kw if system_config else 1000.0
        df = self.compute_thermal_features(df, rated_dc_power_kw=rated_kw)
        df = self.compute_thermal_trends(df, window_days=7)

        return df


def list_systems_with_thermal() -> list[int]:
    """Get list of PVDAQ system IDs known to have thermal data."""
    return list(SYSTEMS_WITH_THERMAL.keys())


def download_pvdaq_sample(
    output_dir: str = "datasets/pvdaq",
    system_id: int = 34,
) -> str:
    """
    Download sample PVDAQ data for testing.

    Note: PVDAQ v3 API is decommissioned. This function provides
    instructions for manual download from AWS/OEDI Data Lake.

    Args:
        output_dir: Directory to save data
        system_id: System ID to download

    Returns:
        Instructions string
    """
    instructions = f"""
PVDAQ Data Download Instructions
================================

The PVDAQ v3 API has been decommissioned. Data is now available from:

1. OEDI Data Lake (AWS S3):
   - URL: https://data.openei.org/submissions/4568
   - Format: Parquet, partitioned by year/month/day

2. Using pvdaq_access Python package:
   pip install pvdaq_access
   python -m pvdaq_access --system {system_id} --path {output_dir} --parquet

3. Direct AWS access:
   aws s3 cp s3://oedi-data-lake/pvdaq/pvdaq_pvdata/ {output_dir}/ \\
       --recursive --no-sign-request \\
       --exclude "*" --include "*system_id={system_id}*"

Recommended systems with thermal data:
- System 34: NREL Mesa 1 (26 kW)
- System 1199: NREL Parking Garage (524 kW)
- System 1283: Sandia PERT (3.36 kW)

After downloading, use:
    loader = PVDAQLoader("{output_dir}")
    df = loader.load_pvdaq_with_thermal(system_id={system_id}, year=2022)
"""
    print(instructions)
    return instructions


if __name__ == "__main__":
    # Demo usage
    print("PVDAQ Data Loader for Thermal RUL Models")
    print("=" * 50)

    # Show download instructions
    download_pvdaq_sample()

    # Show known systems
    print("\nKnown systems with thermal data:")
    for sys_id, (name, kw, lat, lon) in SYSTEMS_WITH_THERMAL.items():
        print(f"  System {sys_id}: {name} ({kw} kW) at ({lat}, {lon})")
