#!/usr/bin/env python3
"""
DustIQ Data Quality & Correlation Analysis

Analyzes DustIQ soiling sensor data across all plants to:
1. Assess data quality and sensor reliability
2. Correlate soiling with rain, AOD, and engineered features
3. Identify best features for predicting soiling rate/ratio/loss
4. Prepare for transfer learning to plants without good soiling sensors

Usage:
    python scripts/analyze_dustiq_quality.py
    python scripts/analyze_dustiq_quality.py --skip-aod-download
    python scripts/analyze_dustiq_quality.py --plants alpha1 epsilon
"""

import argparse
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np
import polars as pl

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# =============================================================================
# Configuration
# =============================================================================

# Plant configurations with parquet file mappings
PLANT_CONFIG = {
    "alpha1": {
        "plant_id": "00461",
        "name": "Alpha1 (ES)",
        "lat": 37.818,
        "lon": -3.803,
        "parquet_pattern": "alpha/*training.parquet",  # alpha = alpha1
        # Plant-specific features for transfer learning
        "tilt": 30.0,  # Module tilt angle (degrees)
        "altitude": 500,  # Meters above sea level
        "is_coastal": False,  # Inland Andalusia (Region A region)
        "climate_zone": "mediterranean",  # Hot-summer Mediterranean
    },
    "epsilon": {
        "plant_id": "00048",
        "name": "Epsilon",
        "lat": 51.196,
        "lon": 14.509,
        "parquet_pattern": "epsilon/*training.parquet",
        "tilt": 30.0,
        "altitude": 150,
        "is_coastal": False,  # Inland Germany (Saxony)
        "climate_zone": "continental",  # Different soiling patterns!
    },
    "ribera": {
        "plant_id": "00460",
        "name": "Ribera (ES)",
        "lat": 37.927,
        "lon": -1.233,
        "parquet_pattern": "ribera/*training.parquet",
        "tilt": 30.0,
        "altitude": 50,
        "is_coastal": True,  # Near Region A coast
        "climate_zone": "mediterranean",
    },
    "gamma": {
        "plant_id": "00500",
        "name": "Gamma (ES)",
        "lat": 39.489,
        "lon": 2.916,
        "parquet_pattern": "gamma/*training.parquet",
        "tilt": 30.0,
        "altitude": 25,
        "is_coastal": True,  # Region B coast (note: coords suggest Balearics?)
        "climate_zone": "mediterranean",
    },
    "eta": {
        "plant_id": "00457",
        "name": "Eta (ES)",
        "lat": 38.663,
        "lon": -5.392,
        "parquet_pattern": "eta/*training.parquet",
        "tilt": 30.0,
        "altitude": 400,  # Region E highlands
        "is_coastal": False,
        "climate_zone": "mediterranean",
    },
    "delta": {
        "plant_id": "00497",
        "name": "Delta (ES)",
        "lat": 39.392,
        "lon": 2.415,
        "parquet_pattern": "delta/*training.parquet",
        "tilt": 30.0,
        "altitude": 50,
        "is_coastal": True,  # Region C island
        "climate_zone": "mediterranean",
    },
    "zeta": {
        "plant_id": "00549",
        "name": "Zeta (ES)",
        "lat": 39.525,
        "lon": 3.187,
        "parquet_pattern": "zeta/*training.parquet",
        "tilt": 30.0,
        "altitude": 50,
        "is_coastal": True,  # Region C island
        "climate_zone": "mediterranean",
    },
}

# Paths
SCADA_DIR = Path("backenddata/scada")
WEATHER_DIR = Path("backenddata/weather")
AOD_DIR = WEATHER_DIR / "cams_aod"
OUTPUT_DIR = Path("backenddata/outputs/dustiq_analysis")


# =============================================================================
# Data Loading Functions
# =============================================================================


def extract_digital_twin_features(plant_key: str) -> Optional[pl.DataFrame]:
    """
    Extract digital twin features from raw DC current/voltage data.

    Calculates:
    - current_cv: Coefficient of variation across DC channels (low = uniform soiling)
    - current_loss_pct: Estimated current loss from reference day
    - voltage_cv: Voltage coefficient of variation
    - temp_deviation: Difference from expected temperature
    - soiling_signature: Composite indicator (low CV + normal temp = likely soiling)

    Returns:
        DataFrame with daily twin features, or None if data not available
    """
    config = PLANT_CONFIG.get(plant_key)
    if not config:
        return None

    # Find parquet file
    pattern = config["parquet_pattern"]
    parquet_files = list(SCADA_DIR.glob(pattern))
    if not parquet_files:
        return None

    parquet_path = parquet_files[0]
    logger.info(f"  Extracting digital twin features for {plant_key}")

    # Scan parquet to find columns
    lf = pl.scan_parquet(parquet_path)
    schema = lf.collect_schema()
    all_cols = schema.names()

    # Find DC current columns (Input_current_XX pattern)
    current_cols = [c for c in all_cols if "Input_current" in c]
    voltage_cols = [c for c in all_cols if "U_DC_" in c and "(V)" in c]
    # Inverter temperature columns (exclude ambient/module temps)
    inv_temp_cols = [c for c in all_cols if "Temperature" in c and "Ambient" not in c and "Module" not in c]
    irrad_cols = [c for c in all_cols if "Irradiation" in c or "irradiance" in c.lower()]
    power_cols = [c for c in all_cols if "Inverter Power Normalized" in c]

    if not current_cols:
        logger.warning(f"    No DC current columns found for {plant_key}")
        return None

    # Select a representative inverter (first one with all data)
    # Get unique inverter IDs from current columns
    inv_pattern = r"(INV \d+\.\d+)"
    import re
    inverters = set()
    for c in current_cols:
        match = re.search(inv_pattern, c)
        if match:
            inverters.add(match.group(1))

    if not inverters:
        logger.warning(f"    Could not extract inverter IDs for {plant_key}")
        return None

    # Use first 3 inverters for averaging (more robust than single)
    selected_invs = sorted(list(inverters))[:3]
    logger.info(f"    Using inverters: {selected_invs}")

    # Find timestamp column
    timestamp_col = None
    for col in all_cols:
        if "timestamp" in col.lower() or col == "time":
            timestamp_col = col
            break
    if not timestamp_col:
        timestamp_col = all_cols[0]

    # Build columns to load
    cols_to_load = [timestamp_col]

    # Add current columns for selected inverters
    inv_current_cols = {}
    inv_voltage_cols = {}
    for inv in selected_invs:
        inv_current_cols[inv] = [c for c in current_cols if inv in c]
        inv_voltage_cols[inv] = [c for c in voltage_cols if inv in c]
        cols_to_load.extend(inv_current_cols[inv])
        cols_to_load.extend(inv_voltage_cols[inv])

    # Add irradiance (first one)
    if irrad_cols:
        cols_to_load.append(irrad_cols[0])

    # Add power columns for selected inverters
    inv_power_cols = [c for c in power_cols if any(inv in c for inv in selected_invs)]
    cols_to_load.extend(inv_power_cols)

    # Add inverter temperature columns for selected inverters
    selected_inv_temp_cols = [c for c in inv_temp_cols if any(inv in c for inv in selected_invs)]
    cols_to_load.extend(selected_inv_temp_cols)
    if selected_inv_temp_cols:
        logger.info(f"    Found {len(selected_inv_temp_cols)} inverter temperature columns")

    # Load data
    try:
        df = lf.select(cols_to_load).collect()
    except Exception as e:
        logger.warning(f"    Failed to load twin data: {e}")
        return None

    # Rename timestamp
    df = df.rename({timestamp_col: "timestamp"})

    # Parse timestamp
    if df["timestamp"].dtype == pl.String or df["timestamp"].dtype == pl.Utf8:
        try:
            df = df.with_columns(
                pl.col("timestamp").str.strptime(pl.Datetime, "%Y.%m.%d %H:%M")
            )
        except Exception:
            try:
                df = df.with_columns(
                    pl.col("timestamp").str.strptime(pl.Datetime, "%Y-%m-%d %H:%M:%S")
                )
            except Exception:
                logger.warning(f"    Failed to parse timestamp for {plant_key}")
                return None

    # First calculate mean current for each inverter (needed for CV calculation)
    for inv in selected_invs:
        if inv_current_cols.get(inv):
            df = df.with_columns(
                pl.concat_list([pl.col(c) for c in inv_current_cols[inv]])
                .list.mean()
                .alias(f"current_mean_{inv}")
            )

    # Calculate CV for each inverter at each timestamp
    # ONLY when mean current > 0.5A (daytime with meaningful generation)
    # CV = std / mean, but avoid division by zero
    cv_exprs = []
    for inv in selected_invs:
        if inv_current_cols.get(inv) and len(inv_current_cols[inv]) >= 3:
            mean_col = f"current_mean_{inv}"
            if mean_col in df.columns:
                # Stack current columns and calculate CV
                current_stack = pl.concat_list([pl.col(c) for c in inv_current_cols[inv]])
                # CV = std / mean, only when mean > threshold
                cv_exprs.append(
                    pl.when(pl.col(mean_col) > 0.5)  # Only compute CV when current > 0.5A
                    .then(
                        current_stack.list.eval(pl.element().std()).list.first() / pl.col(mean_col)
                    )
                    .otherwise(None)
                    .alias(f"current_cv_{inv}")
                )

    if cv_exprs:
        df = df.with_columns(cv_exprs)

    # Calculate voltage CV similarly
    # First compute voltage mean, then CV only when voltage > threshold
    for inv in selected_invs:
        if inv_voltage_cols.get(inv) and len(inv_voltage_cols[inv]) >= 3:
            df = df.with_columns(
                pl.concat_list([pl.col(c) for c in inv_voltage_cols[inv]])
                .list.mean()
                .alias(f"voltage_mean_{inv}")
            )

    voltage_cv_exprs = []
    for inv in selected_invs:
        if inv_voltage_cols.get(inv) and len(inv_voltage_cols[inv]) >= 3:
            mean_col = f"voltage_mean_{inv}"
            if mean_col in df.columns:
                voltage_stack = pl.concat_list([pl.col(c) for c in inv_voltage_cols[inv]])
                voltage_cv_exprs.append(
                    pl.when(pl.col(mean_col) > 100)  # Only compute CV when voltage > 100V
                    .then(
                        voltage_stack.list.eval(pl.element().std()).list.first() / pl.col(mean_col)
                    )
                    .otherwise(None)
                    .alias(f"voltage_cv_{inv}")
                )

    if voltage_cv_exprs:
        df = df.with_columns(voltage_cv_exprs)

    # Add date column
    df = df.with_columns(pl.col("timestamp").dt.date().alias("date"))

    # Aggregate to daily
    agg_exprs = [pl.col("date")]

    # Average CV across inverters
    current_cv_cols = [f"current_cv_{inv}" for inv in selected_invs if f"current_cv_{inv}" in df.columns]
    voltage_cv_cols = [f"voltage_cv_{inv}" for inv in selected_invs if f"voltage_cv_{inv}" in df.columns]
    current_mean_cols = [f"current_mean_{inv}" for inv in selected_invs if f"current_mean_{inv}" in df.columns]

    daily_agg = (
        df.group_by("date")
        .agg([
            # Current CV - already filtered at 15-min level, just take mean
            *[
                pl.col(c).mean().alias(c + "_daily")
                for c in current_cv_cols
            ],
            # Voltage CV
            *[
                pl.col(c).mean().alias(c + "_daily")
                for c in voltage_cv_cols
            ],
            # Current mean (for loss calculation) - filter for daytime values
            *[
                pl.when(pl.col(c) > 0.5).then(pl.col(c)).mean().alias(c + "_daily")
                for c in current_mean_cols
            ],
            # Count of valid readings
            pl.len().alias("twin_readings_count"),
        ])
        .sort("date")
    )

    # Calculate average across inverters
    if current_cv_cols:
        daily_agg = daily_agg.with_columns(
            pl.concat_list([pl.col(c + "_daily") for c in current_cv_cols])
            .list.mean()
            .alias("current_cv")
        )

    if voltage_cv_cols:
        daily_agg = daily_agg.with_columns(
            pl.concat_list([pl.col(c + "_daily") for c in voltage_cv_cols])
            .list.mean()
            .alias("voltage_cv")
        )

    if current_mean_cols:
        daily_agg = daily_agg.with_columns(
            pl.concat_list([pl.col(c + "_daily") for c in current_mean_cols])
            .list.mean()
            .alias("current_mean")
        )

    # Calculate current loss % relative to reference (max of rolling 30d)
    if "current_mean" in daily_agg.columns:
        daily_agg = daily_agg.with_columns(
            pl.col("current_mean").rolling_max(window_size=30).alias("current_ref")
        )
        daily_agg = daily_agg.with_columns(
            ((pl.col("current_ref") - pl.col("current_mean")) / pl.col("current_ref") * 100)
            .clip(0, 50)  # Cap at 50% loss
            .alias("current_loss_pct")
        )

    # Soiling signature: low CV + significant current = likely soiling (vs shading)
    if "current_cv" in daily_agg.columns and "current_mean" in daily_agg.columns:
        daily_agg = daily_agg.with_columns(
            pl.when(
                (pl.col("current_cv") < 0.05) & (pl.col("current_mean") > 1.0)
            )
            .then(1.0)  # Uniform current pattern = soiling signature
            .when(
                (pl.col("current_cv") > 0.10)
            )
            .then(0.0)  # High CV = likely shading/fault
            .otherwise(0.5)  # Ambiguous
            .alias("soiling_signature")
        )

    # Calculate inverter temperature (mean across selected inverters at daytime)
    # First need to go back to original df to get temp data
    if selected_inv_temp_cols:
        # Add temp columns to daily aggregation
        temp_daily = (
            df.group_by("date")
            .agg([
                pl.concat_list([pl.col(c) for c in selected_inv_temp_cols])
                .list.mean()
                .mean()  # Mean across all readings
                .alias("inv_temp_mean"),
                pl.concat_list([pl.col(c) for c in selected_inv_temp_cols])
                .list.max()
                .max()
                .alias("inv_temp_max"),
            ])
        )
        daily_agg = daily_agg.join(temp_daily, on="date", how="left")

    # Ensure all expected columns exist (add placeholders for missing ones)
    expected_float_cols = ["current_cv", "voltage_cv", "current_mean", "current_loss_pct",
                           "soiling_signature", "inv_temp_mean", "inv_temp_max"]
    for col in expected_float_cols:
        if col not in daily_agg.columns:
            daily_agg = daily_agg.with_columns(pl.lit(None).cast(pl.Float64).alias(col))

    if "twin_readings_count" not in daily_agg.columns:
        daily_agg = daily_agg.with_columns(pl.lit(0).cast(pl.UInt32).alias("twin_readings_count"))

    # Select final columns in consistent order
    final_cols = ["date", "current_cv", "voltage_cv", "current_mean", "current_loss_pct",
                  "soiling_signature", "inv_temp_mean", "inv_temp_max", "twin_readings_count"]

    result = daily_agg.select(final_cols)
    logger.info(f"    Extracted {result.height} days of twin features")

    return result


def find_dustiq_columns(df: pl.LazyFrame) -> list[str]:
    """Find DustIQ-related columns in the dataframe."""
    schema = df.collect_schema()
    dustiq_cols = []

    for col in schema.names():
        col_lower = col.lower()
        if "dustiq" in col_lower or "soiling" in col_lower:
            dustiq_cols.append(col)

    return dustiq_cols


def load_plant_parquet(plant_key: str) -> Optional[pl.DataFrame]:
    """Load parquet file for a plant and extract DustIQ data."""
    config = PLANT_CONFIG.get(plant_key)
    if not config:
        logger.error(f"Unknown plant: {plant_key}")
        return None

    # Find parquet file
    pattern = config["parquet_pattern"]
    parquet_files = list(SCADA_DIR.glob(pattern))

    if not parquet_files:
        logger.warning(f"No parquet file found for {plant_key} with pattern {pattern}")
        return None

    parquet_path = parquet_files[0]
    logger.info(f"Loading {plant_key} from {parquet_path.name}")

    # Load lazily first to find columns
    lf = pl.scan_parquet(parquet_path)
    dustiq_cols = find_dustiq_columns(lf)

    if not dustiq_cols:
        logger.warning(f"No DustIQ columns found in {plant_key}")
        return None

    logger.info(f"  Found DustIQ columns: {dustiq_cols}")

    # Find timestamp column
    schema = lf.collect_schema()
    timestamp_col = None
    for col in schema.names():
        if "timestamp" in col.lower() or "time" in col.lower() or "date" in col.lower():
            timestamp_col = col
            break

    if not timestamp_col:
        # Use first column if it looks like a datetime
        first_col = schema.names()[0]
        timestamp_col = first_col

    # Select only needed columns
    cols_to_load = [timestamp_col] + dustiq_cols
    df = lf.select(cols_to_load).collect()

    # Rename timestamp column
    df = df.rename({timestamp_col: "timestamp"})

    # Ensure timestamp is datetime
    if df["timestamp"].dtype == pl.String or df["timestamp"].dtype == pl.Utf8:
        # Try different datetime formats
        try:
            # Format: "2019.01.01 00:00"
            df = df.with_columns(
                pl.col("timestamp").str.strptime(pl.Datetime, "%Y.%m.%d %H:%M")
            )
        except Exception:
            try:
                # Format: "2019-01-01 00:00:00"
                df = df.with_columns(
                    pl.col("timestamp").str.strptime(pl.Datetime, "%Y-%m-%d %H:%M:%S")
                )
            except Exception:
                try:
                    # Format: "2019-01-01T00:00:00"
                    df = df.with_columns(
                        pl.col("timestamp").str.strptime(pl.Datetime, "%Y-%m-%dT%H:%M:%S")
                    )
                except Exception as e:
                    logger.error(f"Failed to parse timestamp: {e}")
                    return None
    elif df["timestamp"].dtype != pl.Datetime:
        df = df.with_columns(pl.col("timestamp").cast(pl.Datetime))

    return df


def extract_dustiq_daily(df: pl.DataFrame, plant_key: str) -> pl.DataFrame:
    """Extract and aggregate DustIQ data to daily resolution."""
    # Find soiling ratio columns (prefer ratio over loss)
    schema = df.columns
    sr_cols = [c for c in schema if "soiling_ratio" in c.lower()]
    sl_cols = [c for c in schema if "soiling_loss" in c.lower() and "soiling_ratio" not in c.lower()]

    # Use soiling ratio if available, otherwise convert from loss
    if sr_cols:
        # Average across sensors if multiple
        df = df.with_columns(
            pl.mean_horizontal([pl.col(c) for c in sr_cols]).alias("sr_raw")
        )
        # Convert from percentage (0-100) to ratio (0-1) if needed
        df = df.with_columns(
            pl.when(pl.col("sr_raw") > 1.5)
            .then(pl.col("sr_raw") / 100.0)
            .otherwise(pl.col("sr_raw"))
            .alias("sr_dustiq")
        )
    elif sl_cols:
        # Convert soiling loss to ratio: SR = 1 - (loss/100)
        df = df.with_columns(
            pl.mean_horizontal([pl.col(c) for c in sl_cols]).alias("sl_raw")
        )
        df = df.with_columns(
            (1.0 - pl.col("sl_raw") / 100.0).alias("sr_dustiq")
        )
    else:
        logger.warning(f"No soiling columns found for {plant_key}")
        return pl.DataFrame()

    # Extract date
    df = df.with_columns(pl.col("timestamp").dt.date().alias("date"))

    # Aggregate to daily
    daily = df.group_by("date").agg(
        pl.col("sr_dustiq").mean().alias("sr_dustiq"),
        pl.col("sr_dustiq").min().alias("sr_min"),
        pl.col("sr_dustiq").max().alias("sr_max"),
        pl.col("sr_dustiq").std().alias("sr_std"),
        pl.col("sr_dustiq").count().alias("measurement_count"),
    )

    # Add plant identifier
    daily = daily.with_columns(pl.lit(plant_key).alias("plant"))

    # Sort by date
    daily = daily.sort("date")

    return daily


# =============================================================================
# Weather Data Functions
# =============================================================================


def fetch_openmeteo_weather(
    lat: float, lon: float, start_date: str, end_date: str, max_retries: int = 3
) -> Optional[pl.DataFrame]:
    """Fetch weather data from Open-Meteo Archive API with retry logic."""
    import requests
    import time

    url = "https://archive-api.open-meteo.com/v1/archive"
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date,
        "end_date": end_date,
        "daily": [
            "temperature_2m_mean",
            "temperature_2m_max",
            "temperature_2m_min",
            "relative_humidity_2m_mean",
            "dewpoint_2m_mean",
            "precipitation_sum",
            "windspeed_10m_mean",
            "windspeed_10m_max",
            "shortwave_radiation_sum",
        ],
        "timezone": "UTC",
    }

    for attempt in range(max_retries):
        try:
            if attempt > 0:
                import time
                wait_time = 2 ** attempt  # Exponential backoff
                logger.info(f"  Retrying in {wait_time}s (attempt {attempt + 1}/{max_retries})")
                time.sleep(wait_time)

            response = requests.get(url, params=params, timeout=60)
            response.raise_for_status()
            data = response.json()

            daily = data.get("daily", {})
            if not daily:
                return None

            df = pl.DataFrame({
                "date": pl.Series(daily["time"]).str.to_date(),
                "temp_mean": daily.get("temperature_2m_mean"),
                "temp_max": daily.get("temperature_2m_max"),
                "temp_min": daily.get("temperature_2m_min"),
                "humidity_mean": daily.get("relative_humidity_2m_mean"),
                "dewpoint_mean": daily.get("dewpoint_2m_mean"),
                "precipitation": daily.get("precipitation_sum"),
                "wind_mean": daily.get("windspeed_10m_mean"),
                "wind_max": daily.get("windspeed_10m_max"),
                "radiation_sum": daily.get("shortwave_radiation_sum"),
            })

            return df

        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429 and attempt < max_retries - 1:
                continue  # Will retry with backoff
            logger.error(f"Error fetching Open-Meteo data: {e}")
            return None
        except Exception as e:
            logger.error(f"Error fetching Open-Meteo data: {e}")
            return None

    return None


def load_or_fetch_weather(plant_key: str, date_range: tuple) -> Optional[pl.DataFrame]:
    """Load cached weather or fetch from API."""
    config = PLANT_CONFIG[plant_key]
    cache_path = WEATHER_DIR / f"openmeteo_{plant_key}.parquet"

    start_date, end_date = date_range

    if cache_path.exists():
        logger.info(f"  Loading cached weather for {plant_key}")
        df = pl.read_parquet(cache_path)

        # Check if we need to extend the date range
        cached_start = df["date"].min()
        cached_end = df["date"].max()

        if cached_start <= start_date and cached_end >= end_date:
            return df

        logger.info(f"  Cache incomplete, fetching additional data")

    # Fetch from API
    logger.info(f"  Fetching weather for {plant_key} ({start_date} to {end_date})")
    df = fetch_openmeteo_weather(
        config["lat"], config["lon"],
        start_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d")
    )

    if df is not None:
        WEATHER_DIR.mkdir(parents=True, exist_ok=True)
        df.write_parquet(cache_path)
        logger.info(f"  Cached weather to {cache_path}")

    return df


# =============================================================================
# AOD Data Functions
# =============================================================================


def fetch_cams_aod_openmeteo(
    lat: float, lon: float, start_date: str, end_date: str
) -> Optional[pl.DataFrame]:
    """
    Fetch AOD data from Open-Meteo Air Quality API.

    Note: This uses Open-Meteo's air quality API which provides CAMS data.
    For more detailed AOD components, use the CAMS ADS API directly.
    """
    import requests

    url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date,
        "end_date": end_date,
        "hourly": [
            "pm10",
            "pm2_5",
            "dust",
            "aerosol_optical_depth",
        ],
        "timezone": "UTC",
    }

    try:
        response = requests.get(url, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()

        hourly = data.get("hourly", {})
        if not hourly:
            return None

        # Create hourly dataframe
        df = pl.DataFrame({
            "timestamp": pl.Series(hourly["time"]).str.to_datetime(),
            "pm10": hourly.get("pm10"),
            "pm25": hourly.get("pm2_5"),
            "dust": hourly.get("dust"),
            "aod_total": hourly.get("aerosol_optical_depth"),
        })

        # Aggregate to daily
        df = df.with_columns(pl.col("timestamp").dt.date().alias("date"))
        daily = df.group_by("date").agg(
            pl.col("pm10").mean().alias("pm10"),
            pl.col("pm25").mean().alias("pm25"),
            pl.col("dust").mean().alias("dust"),
            pl.col("aod_total").mean().alias("aod_total"),
        )

        return daily.sort("date")

    except Exception as e:
        logger.error(f"Error fetching Open-Meteo AOD data: {e}")
        return None


def load_or_fetch_aod(plant_key: str, date_range: tuple) -> Optional[pl.DataFrame]:
    """Load cached AOD or fetch from API."""
    config = PLANT_CONFIG[plant_key]
    AOD_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = AOD_DIR / f"{plant_key}_aod.parquet"

    start_date, end_date = date_range

    if cache_path.exists():
        logger.info(f"  Loading cached AOD for {plant_key}")
        df = pl.read_parquet(cache_path)
        return df

    # Fetch from Open-Meteo Air Quality API
    logger.info(f"  Fetching AOD for {plant_key} ({start_date} to {end_date})")
    df = fetch_cams_aod_openmeteo(
        config["lat"], config["lon"],
        start_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d")
    )

    if df is not None:
        df.write_parquet(cache_path)
        logger.info(f"  Cached AOD to {cache_path}")

    return df


# =============================================================================
# Cleaning Event Detection
# =============================================================================


def detect_cleaning_events(df: pl.DataFrame, sr_col: str = "sr_dustiq") -> pl.DataFrame:
    """
    Detect cleaning events based on sudden SR increases.

    Cleaning indicators:
    - Large positive SR jump (>1-2% in one day)
    - SR recovery after period of decline
    - Often coincides with rain but can be manual cleaning

    Returns dataframe with cleaning event flags and cleaned soiling periods.
    """
    df = df.sort("date")

    if sr_col not in df.columns:
        return df

    # Calculate daily SR change
    df = df.with_columns([
        pl.col(sr_col).diff().alias("sr_change"),
        pl.col(sr_col).shift(1).alias("sr_prev"),
        pl.col(sr_col).shift(-1).alias("sr_next"),
    ])

    # Detect cleaning events
    # Threshold: SR jump > 1% (0.01) in one day is likely cleaning
    cleaning_threshold = 0.01

    # Also check for rain-based cleaning (SR increase after rain)
    has_rain = "precipitation" in df.columns

    if has_rain:
        df = df.with_columns([
            # Cleaning event: SR increased significantly
            (pl.col("sr_change") > cleaning_threshold).alias("is_cleaning_event"),
            # Rain-based cleaning: SR increase + recent rain
            ((pl.col("sr_change") > 0.005) & (pl.col("precipitation") > 1.0)).alias("is_rain_cleaning"),
            # Manual cleaning: SR increase without rain
            ((pl.col("sr_change") > cleaning_threshold) & (pl.col("precipitation") < 1.0)).alias("is_manual_cleaning"),
        ])
    else:
        df = df.with_columns([
            (pl.col("sr_change") > cleaning_threshold).alias("is_cleaning_event"),
            pl.lit(False).alias("is_rain_cleaning"),
            (pl.col("sr_change") > cleaning_threshold).alias("is_manual_cleaning"),
        ])

    # Create soiling periods (segments between cleaning events)
    df = df.with_columns(
        pl.col("is_cleaning_event").cast(pl.Int32).cum_sum().alias("soiling_period_id")
    )

    # Calculate days within each soiling period
    df = df.with_columns(
        pl.arange(0, pl.len()).over("soiling_period_id").alias("days_in_soiling_period")
    )

    # Mark soiling trend within each period
    df = df.with_columns([
        # Sustained soiling: SR declining for 3+ days
        (pl.col("sr_change").rolling_mean(window_size=3) < -0.001).alias("is_soiling_trend"),
        # Stable: little change
        (pl.col("sr_change").abs().rolling_mean(window_size=3) < 0.002).alias("is_stable_trend"),
    ])

    return df


def summarize_cleaning_events(df: pl.DataFrame, plant_key: str) -> dict:
    """Summarize cleaning events for a plant."""
    if "is_cleaning_event" not in df.columns:
        return {}

    total_days = df.height
    cleaning_events = df.filter(pl.col("is_cleaning_event")).height
    rain_cleanings = df.filter(pl.col("is_rain_cleaning")).height if "is_rain_cleaning" in df.columns else 0
    manual_cleanings = df.filter(pl.col("is_manual_cleaning")).height if "is_manual_cleaning" in df.columns else 0

    # Average SR before and after cleaning
    cleaning_df = df.filter(pl.col("is_cleaning_event"))
    avg_sr_before = cleaning_df["sr_prev"].mean() if "sr_prev" in cleaning_df.columns else None
    avg_sr_after = cleaning_df["sr_dustiq"].mean() if cleaning_df.height > 0 else None
    avg_sr_recovery = (avg_sr_after - avg_sr_before) if (avg_sr_before and avg_sr_after) else None

    # Soiling period statistics
    period_stats = df.group_by("soiling_period_id").agg([
        pl.len().alias("period_days"),
        (pl.col("sr_dustiq").first() - pl.col("sr_dustiq").last()).alias("sr_loss"),
    ])

    avg_period_days = period_stats["period_days"].mean() if period_stats.height > 0 else None
    avg_sr_loss_per_period = period_stats["sr_loss"].mean() if period_stats.height > 0 else None

    return {
        "plant": plant_key,
        "total_days": total_days,
        "cleaning_events": cleaning_events,
        "cleaning_rate_per_year": round(cleaning_events / (total_days / 365), 1) if total_days > 0 else 0,
        "rain_cleanings": rain_cleanings,
        "manual_cleanings": manual_cleanings,
        "avg_sr_before_cleaning": round(avg_sr_before, 4) if avg_sr_before else None,
        "avg_sr_after_cleaning": round(avg_sr_after, 4) if avg_sr_after else None,
        "avg_sr_recovery": round(avg_sr_recovery, 4) if avg_sr_recovery else None,
        "avg_soiling_period_days": round(avg_period_days, 1) if avg_period_days else None,
        "avg_sr_loss_per_period": round(avg_sr_loss_per_period, 4) if avg_sr_loss_per_period else None,
        "num_soiling_periods": period_stats.height,
    }


# =============================================================================
# Feature Engineering
# =============================================================================


def engineer_features(df: pl.DataFrame) -> pl.DataFrame:
    """Engineer all features for correlation analysis."""

    # Ensure sorted by date
    df = df.sort("date")

    # -------------------------------------------------------------------------
    # Rainfall features (only if precipitation column exists)
    # -------------------------------------------------------------------------
    if "precipitation" in df.columns:
        df = df.with_columns([
            # Rolling precipitation
            pl.col("precipitation").rolling_sum(window_size=7).alias("precip_7d"),
            pl.col("precipitation").rolling_sum(window_size=14).alias("precip_14d"),
            pl.col("precipitation").rolling_sum(window_size=30).alias("precip_30d"),

            # Max rain in window
            pl.col("precipitation").rolling_max(window_size=7).alias("rain_max_7d"),

            # Rain events count
            (pl.col("precipitation") > 1.0).cast(pl.Int32).rolling_sum(window_size=30).alias("rain_events_30d"),
        ])

        # Days since rain (requires iteration, use cumsum trick)
        rain_mask = (pl.col("precipitation") > 1.0).cast(pl.Int32)
        df = df.with_columns(rain_mask.alias("is_rain_day"))

        # Calculate days since rain using cumsum grouping
        df = df.with_columns(
            pl.col("is_rain_day").cum_sum().alias("rain_group")
        )
        df = df.with_columns(
            pl.arange(0, pl.len()).over("rain_group").alias("days_since_rain_1mm")
        )

        # Days since significant rain (>5mm)
        sig_rain_mask = (pl.col("precipitation") > 5.0).cast(pl.Int32)
        df = df.with_columns(sig_rain_mask.cum_sum().alias("sig_rain_group"))
        df = df.with_columns(
            pl.arange(0, pl.len()).over("sig_rain_group").alias("days_since_rain_5mm")
        )

    # -------------------------------------------------------------------------
    # Temperature features (only if temp columns exist)
    # -------------------------------------------------------------------------
    if "temp_mean" in df.columns:
        df = df.with_columns([
            pl.col("temp_mean").rolling_mean(window_size=7).alias("temp_mean_7d"),
        ])

    if "temp_max" in df.columns and "temp_min" in df.columns:
        df = df.with_columns([
            (pl.col("temp_max") - pl.col("temp_min")).alias("temp_range"),
            (pl.col("temp_max") - pl.col("temp_min")).rolling_mean(window_size=7).alias("temp_range_7d"),
        ])

    # Dew potential: days where temp is close to dewpoint
    if "dewpoint_mean" in df.columns and "temp_min" in df.columns:
        df = df.with_columns(
            ((pl.col("temp_min") - pl.col("dewpoint_mean")).abs() < 3.0)
            .cast(pl.Int32)
            .rolling_sum(window_size=7)
            .alias("dew_potential_7d")
        )

    # -------------------------------------------------------------------------
    # Humidity features (only if humidity column exists)
    # -------------------------------------------------------------------------
    if "humidity_mean" in df.columns:
        df = df.with_columns([
            pl.col("humidity_mean").rolling_mean(window_size=7).alias("humidity_mean_7d"),
        ])

    # -------------------------------------------------------------------------
    # Wind features (only if wind columns exist)
    # -------------------------------------------------------------------------
    if "wind_mean" in df.columns:
        df = df.with_columns([
            pl.col("wind_mean").rolling_mean(window_size=7).alias("wind_mean_7d"),
        ])
    if "wind_max" in df.columns:
        df = df.with_columns([
            pl.col("wind_max").rolling_max(window_size=7).alias("wind_max_7d"),
        ])

    # -------------------------------------------------------------------------
    # AOD features (if available)
    # -------------------------------------------------------------------------
    if "aod_total" in df.columns:
        df = df.with_columns([
            pl.col("aod_total").rolling_mean(window_size=7).alias("aod_total_7d"),
            pl.col("aod_total").rolling_mean(window_size=14).alias("aod_total_14d"),
        ])

        # AOD accumulated since rain
        df = df.with_columns(
            pl.col("aod_total").cum_sum().over("rain_group").alias("aod_accum_since_rain")
        )

    if "dust" in df.columns:
        df = df.with_columns([
            pl.col("dust").rolling_mean(window_size=7).alias("dust_7d"),
            pl.col("dust").rolling_mean(window_size=14).alias("dust_14d"),
        ])

    if "pm10" in df.columns:
        df = df.with_columns([
            pl.col("pm10").rolling_mean(window_size=7).alias("pm10_7d"),
        ])

    if "pm25" in df.columns:
        df = df.with_columns([
            pl.col("pm25").rolling_mean(window_size=7).alias("pm25_7d"),
        ])

    # -------------------------------------------------------------------------
    # Interaction features
    # -------------------------------------------------------------------------
    if "aod_total_7d" in df.columns and "humidity_mean_7d" in df.columns:
        df = df.with_columns(
            (pl.col("aod_total_7d") * pl.col("humidity_mean_7d") / 100.0).alias("aod_x_humidity")
        )

    if "aod_total_7d" in df.columns and "days_since_rain_1mm" in df.columns:
        df = df.with_columns(
            (pl.col("aod_total_7d") * pl.col("days_since_rain_1mm")).alias("aod_x_no_rain_days")
        )

    if "dust_7d" in df.columns and "wind_mean_7d" in df.columns:
        df = df.with_columns(
            (pl.col("dust_7d") * pl.col("wind_mean_7d")).alias("wind_x_dust")
        )

    # -------------------------------------------------------------------------
    # Temporal features
    # -------------------------------------------------------------------------
    df = df.with_columns([
        pl.col("date").dt.ordinal_day().alias("day_of_year"),
        pl.col("date").dt.month().alias("month"),
    ])

    # Season (DJF=0, MAM=1, JJA=2, SON=3)
    df = df.with_columns(
        ((pl.col("month") % 12) // 3).alias("season")
    )

    # Dry season (May-Sep for Mediterranean)
    df = df.with_columns(
        ((pl.col("month") >= 5) & (pl.col("month") <= 9)).cast(pl.Int32).alias("is_dry_season")
    )

    # -------------------------------------------------------------------------
    # Target variables
    # -------------------------------------------------------------------------
    df = df.with_columns([
        # Soiling loss percentage
        ((1.0 - pl.col("sr_dustiq")) * 100.0).alias("soiling_loss_pct"),

        # Daily soiling rate (change from previous day)
        pl.col("sr_dustiq").diff().alias("soiling_rate"),

        # 7-day soiling change
        (pl.col("sr_dustiq") - pl.col("sr_dustiq").shift(7)).alias("sr_7d_change"),
    ])

    # Clean up temporary columns (only if they exist)
    cols_to_drop = ["is_rain_day", "rain_group", "sig_rain_group"]
    cols_to_drop = [c for c in cols_to_drop if c in df.columns]
    if cols_to_drop:
        df = df.drop(cols_to_drop)

    return df


# =============================================================================
# Quality Assessment
# =============================================================================


def calculate_quality_metrics(df: pl.DataFrame, plant_key: str) -> dict:
    """Calculate quality metrics for a plant's DustIQ data."""

    # Basic stats
    total_days = df.height
    non_null_days = df.filter(pl.col("sr_dustiq").is_not_null()).height
    coverage_pct = (non_null_days / total_days * 100) if total_days > 0 else 0

    # Value statistics
    sr_stats = df.select([
        pl.col("sr_dustiq").mean().alias("mean"),
        pl.col("sr_dustiq").std().alias("std"),
        pl.col("sr_dustiq").min().alias("min"),
        pl.col("sr_dustiq").max().alias("max"),
    ]).to_dicts()[0]

    # Outlier detection (outside [0.7, 1.02])
    outlier_count = df.filter(
        (pl.col("sr_dustiq") < 0.7) | (pl.col("sr_dustiq") > 1.02)
    ).height
    outlier_pct = (outlier_count / non_null_days * 100) if non_null_days > 0 else 0

    # Gap analysis
    df_with_gaps = df.with_columns(
        pl.col("sr_dustiq").is_null().cast(pl.Int32).alias("is_gap")
    )

    # Find max consecutive gap
    df_with_gaps = df_with_gaps.with_columns(
        pl.col("is_gap").cum_sum().alias("gap_group")
    )
    gap_lengths = df_with_gaps.filter(pl.col("is_gap") == 1).group_by("gap_group").agg(
        pl.len().alias("gap_length")
    )
    max_gap = gap_lengths["gap_length"].max() if gap_lengths.height > 0 else 0

    # Seasonal coverage (only if season column exists)
    seasonal_coverage = {}
    if "season" in df.columns:
        season_names = {0: "DJF", 1: "MAM", 2: "JJA", 3: "SON"}
        for season_num, season_name in season_names.items():
            season_data = df.filter(pl.col("season") == season_num)
            if season_data.height > 0:
                season_non_null = season_data.filter(pl.col("sr_dustiq").is_not_null()).height
                seasonal_coverage[season_name] = round(season_non_null / season_data.height * 100, 1)
            else:
                seasonal_coverage[season_name] = 0.0

    # Date range
    date_range = (
        df["date"].min().strftime("%Y-%m-%d") if df["date"].min() else None,
        df["date"].max().strftime("%Y-%m-%d") if df["date"].max() else None,
    )

    # Sensor agreement (if we have min/max from multiple sensors)
    sensor_agreement = None
    if "sr_min" in df.columns and "sr_max" in df.columns:
        # Use correlation between min and max as proxy for sensor agreement
        valid_data = df.filter(
            pl.col("sr_min").is_not_null() & pl.col("sr_max").is_not_null()
        )
        if valid_data.height > 10:
            sensor_agreement = valid_data.select(
                pl.corr("sr_min", "sr_max")
            ).item()

    return {
        "plant": plant_key,
        "plant_name": PLANT_CONFIG[plant_key]["name"],
        "total_days": total_days,
        "non_null_days": non_null_days,
        "coverage_pct": round(coverage_pct, 1),
        "mean_sr": round(sr_stats["mean"], 4) if sr_stats["mean"] else None,
        "std_sr": round(sr_stats["std"], 4) if sr_stats["std"] else None,
        "min_sr": round(sr_stats["min"], 4) if sr_stats["min"] else None,
        "max_sr": round(sr_stats["max"], 4) if sr_stats["max"] else None,
        "outlier_pct": round(outlier_pct, 1),
        "max_gap_days": int(max_gap) if max_gap else 0,
        "seasonal_coverage": seasonal_coverage,
        "date_range": date_range,
        "sensor_agreement": round(sensor_agreement, 3) if sensor_agreement else None,
    }


# =============================================================================
# Correlation Analysis
# =============================================================================


def calculate_correlations(df: pl.DataFrame, plant_key: str) -> dict:
    """Calculate correlations between SR and features."""

    # Features to correlate with SR
    feature_cols = [
        # Rain features
        "precip_7d", "precip_14d", "precip_30d", "rain_max_7d", "rain_events_30d",
        "days_since_rain_1mm", "days_since_rain_5mm",
        # Temperature features
        "temp_mean_7d", "temp_range_7d",
        # Humidity features
        "humidity_mean_7d",
        # Wind features
        "wind_mean_7d", "wind_max_7d",
        # AOD features
        "aod_total_7d", "aod_total_14d", "dust_7d", "dust_14d", "pm10_7d", "pm25_7d",
        "aod_accum_since_rain",
        # Interaction features
        "aod_x_humidity", "aod_x_no_rain_days", "wind_x_dust",
        # Temporal features
        "day_of_year", "month", "is_dry_season",
    ]

    # Filter to available columns
    available_cols = [c for c in feature_cols if c in df.columns]

    correlations = {"plant": plant_key}

    # Calculate Pearson correlation with SR
    for col in available_cols:
        valid_data = df.filter(
            pl.col("sr_dustiq").is_not_null() & pl.col(col).is_not_null()
        )
        if valid_data.height > 30:
            corr = valid_data.select(pl.corr("sr_dustiq", col)).item()
            correlations[f"{col}_pearson"] = round(corr, 4) if corr else None

    # Calculate correlation with soiling rate (daily change)
    for col in available_cols:
        valid_data = df.filter(
            pl.col("soiling_rate").is_not_null() & pl.col(col).is_not_null()
        )
        if valid_data.height > 30:
            corr = valid_data.select(pl.corr("soiling_rate", col)).item()
            correlations[f"{col}_rate_corr"] = round(corr, 4) if corr else None

    return correlations


def calculate_lagged_correlations(df: pl.DataFrame, plant_key: str) -> dict:
    """Calculate lagged correlations (rain effect delay)."""

    lagged_corrs = {"plant": plant_key}

    # Rain effect on SR change with different lags
    for lag in range(0, 8):
        # Shift precipitation by lag days
        df_lagged = df.with_columns(
            pl.col("precipitation").shift(lag).alias(f"precip_lag{lag}")
        )

        valid_data = df_lagged.filter(
            pl.col("soiling_rate").is_not_null() &
            pl.col(f"precip_lag{lag}").is_not_null()
        )

        if valid_data.height > 30:
            corr = valid_data.select(
                pl.corr("soiling_rate", f"precip_lag{lag}")
            ).item()
            lagged_corrs[f"precip_lag{lag}_rate_corr"] = round(corr, 4) if corr else None

    return lagged_corrs


# =============================================================================
# Feature Importance (LightGBM)
# =============================================================================


# =============================================================================
# Visualization Functions
# =============================================================================


def generate_visualizations(
    results: dict,
    all_plant_data: list[pl.DataFrame],
    output_dir: Path,
) -> None:
    """Generate all visualization plots."""
    try:
        import matplotlib.pyplot as plt
        import matplotlib
        matplotlib.use('Agg')  # Non-interactive backend
    except ImportError:
        logger.warning("Matplotlib not available, skipping visualizations")
        return

    plots_dir = output_dir / "plots"
    plots_dir.mkdir(parents=True, exist_ok=True)

    logger.info("\nGenerating visualizations...")

    # 1. Quality heatmap
    try:
        generate_quality_heatmap(results["quality_metrics"], plots_dir)
        logger.info("  ✓ Quality heatmap generated")
    except Exception as e:
        logger.warning(f"  ✗ Quality heatmap failed: {e}")

    # 2. Correlation by plant
    try:
        generate_correlation_plot(results["correlations"], plots_dir)
        logger.info("  ✓ Correlation plot generated")
    except Exception as e:
        logger.warning(f"  ✗ Correlation plot failed: {e}")

    # 3. Feature importance
    try:
        if results["feature_importance"].get("feature_importance"):
            generate_feature_importance_plot(results["feature_importance"], plots_dir)
            logger.info("  ✓ Feature importance plot generated")
    except Exception as e:
        logger.warning(f"  ✗ Feature importance plot failed: {e}")

    # 4. SR timeseries by plant
    try:
        generate_sr_timeseries_plot(all_plant_data, plots_dir)
        logger.info("  ✓ SR timeseries plot generated")
    except Exception as e:
        logger.warning(f"  ✗ SR timeseries plot failed: {e}")

    # 5. Model metrics matrix
    try:
        if results.get("model_metrics", {}).get("per_plant"):
            generate_model_metrics_plot(results["model_metrics"], plots_dir)
            logger.info("  ✓ Model metrics plot generated")
    except Exception as e:
        logger.warning(f"  ✗ Model metrics plot failed: {e}")


def generate_quality_heatmap(quality_metrics: list[dict], plots_dir: Path) -> None:
    """Generate heatmap of quality metrics across plants."""
    import matplotlib.pyplot as plt
    import numpy as np

    fig, ax = plt.subplots(figsize=(12, 8))

    # Extract metrics for heatmap
    plants = [q["plant"] for q in quality_metrics]
    metrics = ["coverage_pct", "outlier_pct", "max_gap_days"]
    metric_labels = ["Coverage (%)", "Outlier (%)", "Max Gap (days)"]

    # Build data matrix
    data = []
    for q in quality_metrics:
        row = [
            q.get("coverage_pct", 0),
            q.get("outlier_pct", 0),
            min(q.get("max_gap_days", 0), 100),  # Cap for visualization
        ]
        data.append(row)

    data = np.array(data)

    # Normalize each column for heatmap (0-1 scale)
    data_normalized = np.zeros_like(data)
    for i in range(data.shape[1]):
        col_min, col_max = data[:, i].min(), data[:, i].max()
        if col_max > col_min:
            data_normalized[:, i] = (data[:, i] - col_min) / (col_max - col_min)
        else:
            data_normalized[:, i] = 0.5

    # Create heatmap
    im = ax.imshow(data_normalized.T, cmap="RdYlGn_r", aspect="auto")

    # Set ticks
    ax.set_xticks(np.arange(len(plants)))
    ax.set_yticks(np.arange(len(metric_labels)))
    ax.set_xticklabels(plants, rotation=45, ha="right")
    ax.set_yticklabels(metric_labels)

    # Add text annotations with actual values
    for i in range(len(metric_labels)):
        for j in range(len(plants)):
            val = data[j, i]
            text_color = "white" if data_normalized[j, i] > 0.5 else "black"
            ax.text(j, i, f"{val:.1f}", ha="center", va="center", color=text_color, fontsize=10)

    # Seasonal coverage subplot
    ax2 = fig.add_axes([0.1, -0.35, 0.8, 0.25])  # Below main plot

    seasons = ["DJF", "MAM", "JJA", "SON"]
    season_data = []
    for q in quality_metrics:
        row = [q.get("seasonal_coverage", {}).get(s, 0) for s in seasons]
        season_data.append(row)

    season_data = np.array(season_data)

    x = np.arange(len(plants))
    width = 0.2

    for i, season in enumerate(seasons):
        ax2.bar(x + i * width, season_data[:, i], width, label=season, alpha=0.8)

    ax2.set_xlabel("Plant")
    ax2.set_ylabel("Coverage (%)")
    ax2.set_title("Seasonal Coverage by Plant")
    ax2.set_xticks(x + width * 1.5)
    ax2.set_xticklabels(plants, rotation=45, ha="right")
    ax2.legend(loc="upper right")
    ax2.set_ylim(0, 100)

    ax.set_title("DustIQ Data Quality Metrics by Plant", fontsize=14, fontweight="bold")

    plt.tight_layout()
    plt.savefig(plots_dir / "quality_heatmap.png", dpi=150, bbox_inches="tight")
    plt.close()


def generate_correlation_plot(correlations: list[dict], plots_dir: Path) -> None:
    """Generate correlation comparison plot across plants."""
    import matplotlib.pyplot as plt
    import numpy as np

    # Key features to show
    key_features = [
        "precip_7d", "days_since_rain_1mm",
        "temp_mean_7d", "humidity_mean_7d",
        "aod_total_7d", "aod_accum_since_rain",
        "aod_x_no_rain_days", "is_dry_season",
    ]

    # Extract correlations
    plants = [c["plant"] for c in correlations]
    n_plants = len(plants)
    n_features = len(key_features)

    # Build correlation matrix
    corr_matrix = np.zeros((n_plants, n_features))
    for i, c in enumerate(correlations):
        for j, feat in enumerate(key_features):
            key = f"{feat}_pearson"
            corr_matrix[i, j] = c.get(key, np.nan)

    fig, ax = plt.subplots(figsize=(14, 8))

    # Create heatmap with diverging colormap
    im = ax.imshow(corr_matrix.T, cmap="RdBu_r", aspect="auto", vmin=-0.6, vmax=0.6)

    # Set ticks
    ax.set_xticks(np.arange(n_plants))
    ax.set_yticks(np.arange(n_features))
    ax.set_xticklabels(plants, rotation=45, ha="right")
    ax.set_yticklabels([f.replace("_", " ").title() for f in key_features])

    # Add correlation values as text
    for i in range(n_features):
        for j in range(n_plants):
            val = corr_matrix[j, i]
            if not np.isnan(val):
                text_color = "white" if abs(val) > 0.3 else "black"
                ax.text(j, i, f"{val:.2f}", ha="center", va="center",
                       color=text_color, fontsize=9)

    # Colorbar
    cbar = plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label("Pearson Correlation with Soiling Ratio")

    ax.set_title("Feature Correlations with Soiling Ratio by Plant", fontsize=14, fontweight="bold")
    ax.set_xlabel("Plant")
    ax.set_ylabel("Feature")

    plt.tight_layout()
    plt.savefig(plots_dir / "correlation_by_plant.png", dpi=150, bbox_inches="tight")
    plt.close()


def generate_feature_importance_plot(feature_importance: dict, plots_dir: Path) -> None:
    """Generate feature importance bar plot."""
    import matplotlib.pyplot as plt
    import numpy as np

    importance = feature_importance.get("feature_importance", {})
    if not importance:
        return

    # Get top 15 features
    sorted_features = list(importance.items())[:15]
    features = [f[0] for f in sorted_features]
    values = [f[1] for f in sorted_features]

    fig, ax = plt.subplots(figsize=(12, 8))

    # Color by category
    colors = []
    for f in features:
        if "precip" in f or "rain" in f:
            colors.append("#3498db")  # Blue for rain
        elif "aod" in f or "dust" in f or "pm" in f:
            colors.append("#e67e22")  # Orange for AOD/dust
        elif "temp" in f or "humidity" in f or "dew" in f:
            colors.append("#2ecc71")  # Green for climate
        elif "wind" in f:
            colors.append("#9b59b6")  # Purple for wind
        else:
            colors.append("#95a5a6")  # Gray for others

    y_pos = np.arange(len(features))
    ax.barh(y_pos, values, color=colors, alpha=0.8)

    # Labels
    ax.set_yticks(y_pos)
    ax.set_yticklabels([f.replace("_", " ").title() for f in features])
    ax.invert_yaxis()  # Highest at top
    ax.set_xlabel("Feature Importance (LightGBM)")
    ax.set_title(
        f"Feature Importance for Soiling Ratio Prediction\n"
        f"Model R²={feature_importance['model_r2']:.4f}, "
        f"RMSE={feature_importance['model_rmse']:.6f}",
        fontsize=14, fontweight="bold"
    )

    # Legend
    from matplotlib.patches import Patch
    legend_elements = [
        Patch(facecolor="#3498db", label="Rainfall"),
        Patch(facecolor="#e67e22", label="AOD/Dust"),
        Patch(facecolor="#2ecc71", label="Climate"),
        Patch(facecolor="#9b59b6", label="Wind"),
        Patch(facecolor="#95a5a6", label="Other"),
    ]
    ax.legend(handles=legend_elements, loc="lower right")

    plt.tight_layout()
    plt.savefig(plots_dir / "feature_importance.png", dpi=150, bbox_inches="tight")
    plt.close()


def generate_model_metrics_plot(model_metrics: dict, plots_dir: Path) -> None:
    """Generate comprehensive model metrics comparison plot."""
    import matplotlib.pyplot as plt
    import numpy as np

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    per_plant = model_metrics.get("per_plant", {})
    cross_val = model_metrics.get("cross_plant_validation", {})
    combined = model_metrics.get("combined", {})

    plants = list(per_plant.keys())
    n_plants = len(plants)

    if n_plants == 0:
        plt.close()
        return

    # 1. R² Comparison (Per-plant vs Transfer)
    ax1 = axes[0, 0]
    x = np.arange(n_plants)
    width = 0.35

    r2_per_plant = [per_plant[p]["overall"]["r2"] for p in plants]
    r2_transfer = [cross_val.get(p, {}).get("overall", {}).get("r2", 0) for p in plants]

    bars1 = ax1.bar(x - width/2, r2_per_plant, width, label="Per-Plant Model", color="#2ecc71", alpha=0.8)
    bars2 = ax1.bar(x + width/2, r2_transfer, width, label="Transfer Model", color="#e74c3c", alpha=0.8)

    ax1.set_ylabel("R²")
    ax1.set_title("Model R² Comparison: Per-Plant vs Transfer Learning", fontweight="bold")
    ax1.set_xticks(x)
    ax1.set_xticklabels(plants, rotation=45, ha="right")
    ax1.legend()
    ax1.set_ylim(0, 1)
    ax1.axhline(y=0.5, color="gray", linestyle="--", alpha=0.5, label="R²=0.5")
    ax1.grid(True, alpha=0.3)

    # Add value labels
    for bar in bars1:
        height = bar.get_height()
        ax1.annotate(f'{height:.2f}', xy=(bar.get_x() + bar.get_width()/2, height),
                    xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', fontsize=8)
    for bar in bars2:
        height = bar.get_height()
        ax1.annotate(f'{height:.2f}', xy=(bar.get_x() + bar.get_width()/2, height),
                    xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', fontsize=8)

    # 2. MAE Comparison (Per-plant vs Transfer)
    ax2 = axes[0, 1]

    mae_per_plant = [per_plant[p]["overall"]["mae"] for p in plants]
    mae_transfer = [cross_val.get(p, {}).get("overall", {}).get("mae", 0) for p in plants]

    bars1 = ax2.bar(x - width/2, mae_per_plant, width, label="Per-Plant Model", color="#2ecc71", alpha=0.8)
    bars2 = ax2.bar(x + width/2, mae_transfer, width, label="Transfer Model", color="#e74c3c", alpha=0.8)

    ax2.set_ylabel("MAE")
    ax2.set_title("Model MAE Comparison: Per-Plant vs Transfer Learning", fontweight="bold")
    ax2.set_xticks(x)
    ax2.set_xticklabels(plants, rotation=45, ha="right")
    ax2.legend()
    ax2.grid(True, alpha=0.3)

    # 3. Segmented MAE (Soiling vs Recovery vs Stable)
    ax3 = axes[1, 0]
    width = 0.25

    mae_soiling = [per_plant[p].get("soiling", {}).get("mae", 0) or 0 for p in plants]
    mae_recovery = [per_plant[p].get("recovery", {}).get("mae", 0) or 0 for p in plants]
    mae_stable = [per_plant[p].get("stable", {}).get("mae", 0) or 0 for p in plants]

    ax3.bar(x - width, mae_soiling, width, label="Soiling (↓)", color="#e74c3c", alpha=0.8)
    ax3.bar(x, mae_recovery, width, label="Recovery (↑)", color="#2ecc71", alpha=0.8)
    ax3.bar(x + width, mae_stable, width, label="Stable (→)", color="#3498db", alpha=0.8)

    ax3.set_ylabel("MAE")
    ax3.set_title("Per-Plant MAE by SR Direction", fontweight="bold")
    ax3.set_xticks(x)
    ax3.set_xticklabels(plants, rotation=45, ha="right")
    ax3.legend()
    ax3.grid(True, alpha=0.3)

    # 4. Data distribution by SR direction
    ax4 = axes[1, 1]

    pct_soiling = [per_plant[p].get("soiling", {}).get("pct_of_data", 0) for p in plants]
    pct_recovery = [per_plant[p].get("recovery", {}).get("pct_of_data", 0) for p in plants]
    pct_stable = [per_plant[p].get("stable", {}).get("pct_of_data", 0) for p in plants]

    ax4.bar(x, pct_soiling, width=0.6, label="Soiling (↓)", color="#e74c3c", alpha=0.8)
    ax4.bar(x, pct_recovery, width=0.6, bottom=pct_soiling, label="Recovery (↑)", color="#2ecc71", alpha=0.8)
    ax4.bar(x, pct_stable, width=0.6, bottom=[s+r for s,r in zip(pct_soiling, pct_recovery)],
            label="Stable (→)", color="#3498db", alpha=0.8)

    ax4.set_ylabel("% of Data")
    ax4.set_title("Data Distribution by SR Direction", fontweight="bold")
    ax4.set_xticks(x)
    ax4.set_xticklabels(plants, rotation=45, ha="right")
    ax4.legend(loc="upper right")
    ax4.set_ylim(0, 100)
    ax4.grid(True, alpha=0.3)

    # Add combined model annotation
    if combined:
        fig.text(0.5, 0.02,
                f"Combined Model: R²={combined['overall']['r2']:.4f}, MAE={combined['overall']['mae']:.6f}",
                ha="center", fontsize=12, style="italic")

    fig.suptitle("Comprehensive Model Metrics Analysis", fontsize=16, fontweight="bold", y=1.02)
    plt.tight_layout()
    plt.savefig(plots_dir / "model_metrics_matrix.png", dpi=150, bbox_inches="tight")
    plt.close()


def generate_sr_timeseries_plot(all_plant_data: list[pl.DataFrame], plots_dir: Path) -> None:
    """Generate soiling ratio timeseries plot for all plants."""
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates

    if not all_plant_data:
        return

    fig, axes = plt.subplots(len(all_plant_data), 1, figsize=(14, 3 * len(all_plant_data)),
                             sharex=True)

    if len(all_plant_data) == 1:
        axes = [axes]

    colors = plt.cm.tab10(np.linspace(0, 1, len(all_plant_data)))

    for i, (df, color) in enumerate(zip(all_plant_data, colors)):
        ax = axes[i]
        plant = df["plant"][0] if "plant" in df.columns else f"Plant {i+1}"

        # Convert date to datetime for plotting
        dates = df["date"].to_list()
        sr_values = df["sr_dustiq"].to_list()

        ax.plot(dates, sr_values, color=color, linewidth=0.8, alpha=0.8, label="Daily SR")

        # Add rolling mean
        if len(sr_values) > 7:
            sr_series = df["sr_dustiq"].rolling_mean(window_size=7).to_list()
            ax.plot(dates, sr_series, color="red", linewidth=1.5, alpha=0.9, label="7-day MA")

        # Reference lines
        ax.axhline(y=1.0, color="green", linestyle="--", alpha=0.5, label="Clean (SR=1.0)")
        ax.axhline(y=0.95, color="orange", linestyle="--", alpha=0.5, label="5% loss")

        ax.set_ylabel("Soiling Ratio")
        ax.set_title(f"{PLANT_CONFIG.get(plant, {}).get('name', plant)}", fontsize=11)
        ax.set_ylim(0.8, 1.05)
        ax.legend(loc="lower left", fontsize=8)
        ax.grid(True, alpha=0.3)

    axes[-1].set_xlabel("Date")
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m"))
    axes[-1].xaxis.set_major_locator(mdates.MonthLocator(interval=3))

    fig.suptitle("Soiling Ratio Timeseries by Plant (DustIQ)", fontsize=14, fontweight="bold")
    plt.tight_layout()
    plt.savefig(plots_dir / "sr_timeseries_by_plant.png", dpi=150, bbox_inches="tight")
    plt.close()


def calculate_improved_transfer_learning(
    all_plant_data: list[pl.DataFrame],
) -> dict:
    """
    Improved transfer learning approaches:
    1. Normalized SR (z-score per plant) - removes plant-specific bias
    2. Soiling Rate prediction - predict change, not absolute value
    3. Physics-only features - only transferable features
    4. Power-based features - if available
    """
    try:
        import lightgbm as lgb
        from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error
    except ImportError:
        logger.warning("LightGBM/sklearn not available")
        return {}

    results = {
        "approaches": {},
        "summary": {},
    }

    # Physics-based transferable features (no plant-specific patterns)
    physics_features = [
        # Rain features (universal cleaning mechanism)
        "precip_7d", "precip_14d", "precip_30d",
        "days_since_rain_1mm", "days_since_rain_5mm",
        "rain_events_30d",
        # AOD features (dust deposition)
        "aod_total_7d", "aod_total_14d",
        "aod_accum_since_rain",
        "pm10_7d", "pm25_7d", "dust_7d",
        # Interactions (physics-based)
        "aod_x_no_rain_days",
        # Temporal (seasonal patterns)
        "is_dry_season",
    ]

    params = {
        "objective": "regression",
        "metric": "rmse",
        "verbosity": -1,
        "n_estimators": 100,
        "max_depth": 5,
        "learning_rate": 0.1,
    }

    def evaluate_model(y_true, y_pred, name):
        return {
            "r2": round(r2_score(y_true, y_pred), 4),
            "rmse": round(np.sqrt(mean_squared_error(y_true, y_pred)), 6),
            "mae": round(mean_absolute_error(y_true, y_pred), 6),
            "n_samples": len(y_true),
        }

    # =========================================================================
    # Approach 1: Normalized SR (Z-score per plant)
    # =========================================================================
    logger.info("\n--- Approach 1: Normalized SR (Z-score) ---")

    approach1_results = {"per_plant": {}, "transfer": {}}

    # Normalize SR per plant
    normalized_dfs = []
    for df in all_plant_data:
        plant = df["plant"][0]
        sr_mean = df["sr_dustiq"].mean()
        sr_std = df["sr_dustiq"].std()
        if sr_std and sr_std > 0:
            df_norm = df.with_columns(
                ((pl.col("sr_dustiq") - sr_mean) / sr_std).alias("sr_normalized")
            )
            df_norm = df_norm.with_columns([
                pl.lit(sr_mean).alias("sr_plant_mean"),
                pl.lit(sr_std).alias("sr_plant_std"),
            ])
            normalized_dfs.append(df_norm)
            logger.info(f"  {plant}: mean={sr_mean:.4f}, std={sr_std:.4f}")

    # Leave-one-out cross-validation with normalized SR
    all_features = physics_features + ["temp_mean_7d", "humidity_mean_7d", "wind_mean_7d"]

    for test_idx, test_df in enumerate(normalized_dfs):
        test_plant = test_df["plant"][0]
        train_dfs = [df for i, df in enumerate(normalized_dfs) if i != test_idx]

        if not train_dfs:
            continue

        train_df = pl.concat(train_dfs)
        available_cols = [c for c in all_features if c in train_df.columns and c in test_df.columns]

        train_clean = train_df.select(["sr_normalized"] + available_cols).drop_nulls()
        test_clean = test_df.select(["sr_normalized", "sr_plant_mean", "sr_plant_std"] + available_cols).drop_nulls()

        if train_clean.height < 50 or test_clean.height < 30:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_normalized"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_normalized"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred_norm = model.predict(X_test)

        # Metrics on normalized scale
        metrics_norm = evaluate_model(y_test, y_pred_norm, f"{test_plant}_normalized")

        # Convert back to original scale for comparison
        sr_mean = test_clean["sr_plant_mean"][0]
        sr_std = test_clean["sr_plant_std"][0]
        y_test_orig = y_test * sr_std + sr_mean
        y_pred_orig = y_pred_norm * sr_std + sr_mean
        metrics_orig = evaluate_model(y_test_orig, y_pred_orig, f"{test_plant}_original")

        # Get train plants for documentation
        train_plants = [df["plant"][0] for df in train_dfs]

        approach1_results["transfer"][test_plant] = {
            "normalized_metrics": metrics_norm,
            "original_scale_metrics": metrics_orig,
            "train_plants": train_plants,
            "train_samples": train_clean.height,
            "test_samples": test_clean.height,
        }
        logger.info(f"  {test_plant}: R²(norm)={metrics_norm['r2']:.4f}, R²(orig)={metrics_orig['r2']:.4f}, MAE(orig)={metrics_orig['mae']:.6f}")

    results["approaches"]["normalized_sr"] = approach1_results

    # =========================================================================
    # Approach 2: Soiling Rate Prediction (daily SR change)
    # =========================================================================
    logger.info("\n--- Approach 2: Soiling Rate Prediction ---")

    approach2_results = {"transfer": {}}

    for test_idx, test_df in enumerate(all_plant_data):
        test_plant = test_df["plant"][0]
        train_dfs = [df for i, df in enumerate(all_plant_data) if i != test_idx]

        if not train_dfs:
            continue

        train_df = pl.concat(train_dfs)
        available_cols = [c for c in all_features if c in train_df.columns and c in test_df.columns]

        # Use soiling_rate as target (daily SR change)
        train_clean = train_df.select(["soiling_rate"] + available_cols).drop_nulls()
        test_clean = test_df.select(["soiling_rate"] + available_cols).drop_nulls()

        if train_clean.height < 50 or test_clean.height < 30:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["soiling_rate"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["soiling_rate"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        metrics = evaluate_model(y_test, y_pred, f"{test_plant}_rate")
        train_plants = [df["plant"][0] for df in train_dfs]

        approach2_results["transfer"][test_plant] = {
            "metrics": metrics,
            "train_plants": train_plants,
            "train_samples": train_clean.height,
            "test_samples": test_clean.height,
            "rate_mean": float(y_test.mean()),
            "rate_std": float(y_test.std()),
        }
        logger.info(f"  {test_plant}: R²={metrics['r2']:.4f}, MAE={metrics['mae']:.6f}")

    results["approaches"]["soiling_rate"] = approach2_results

    # =========================================================================
    # Approach 3: Physics-Only Features (most transferable)
    # =========================================================================
    logger.info("\n--- Approach 3: Physics-Only Features ---")

    approach3_results = {"transfer": {}}

    # Strictly physics-based features
    strict_physics = [
        "aod_accum_since_rain",  # Key physics: dust accumulated since cleaning
        "days_since_rain_1mm",   # Days without cleaning
        "aod_total_7d",          # Recent dust load
        "is_dry_season",         # Seasonal soiling pattern
        "precip_7d",             # Recent cleaning
    ]

    for test_idx, test_df in enumerate(all_plant_data):
        test_plant = test_df["plant"][0]
        train_dfs = [df for i, df in enumerate(all_plant_data) if i != test_idx]

        if not train_dfs:
            continue

        train_df = pl.concat(train_dfs)
        available_cols = [c for c in strict_physics if c in train_df.columns and c in test_df.columns]

        if len(available_cols) < 3:
            logger.warning(f"  {test_plant}: Not enough physics features available")
            continue

        # Predict soiling_loss_pct (more interpretable than SR)
        train_clean = train_df.select(["soiling_loss_pct"] + available_cols).drop_nulls()
        test_clean = test_df.select(["soiling_loss_pct"] + available_cols).drop_nulls()

        if train_clean.height < 50 or test_clean.height < 30:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["soiling_loss_pct"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["soiling_loss_pct"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        metrics = evaluate_model(y_test, y_pred, f"{test_plant}_physics")
        train_plants = [df["plant"][0] for df in train_dfs]

        approach3_results["transfer"][test_plant] = {
            "metrics": metrics,
            "features_used": available_cols,
            "train_plants": train_plants,
            "train_samples": train_clean.height,
            "test_samples": test_clean.height,
        }
        logger.info(f"  {test_plant}: R²={metrics['r2']:.4f}, MAE={metrics['mae']:.6f} (features: {len(available_cols)})")

    results["approaches"]["physics_only"] = approach3_results

    # =========================================================================
    # Summary comparison
    # =========================================================================
    logger.info("\n--- Transfer Learning Summary ---")

    summary = {
        "original_baseline": {},
        "normalized_sr": {},
        "soiling_rate": {},
        "physics_only": {},
    }

    for plant in [df["plant"][0] for df in all_plant_data]:
        # Original approach (from previous run - use placeholder)
        summary["original_baseline"][plant] = "negative R² (failed)"

        if plant in results["approaches"].get("normalized_sr", {}).get("transfer", {}):
            m = results["approaches"]["normalized_sr"]["transfer"][plant]["original_scale_metrics"]
            summary["normalized_sr"][plant] = f"R²={m['r2']:.4f}, MAE={m['mae']:.6f}"

        if plant in results["approaches"].get("soiling_rate", {}).get("transfer", {}):
            m = results["approaches"]["soiling_rate"]["transfer"][plant]["metrics"]
            summary["soiling_rate"][plant] = f"R²={m['r2']:.4f}, MAE={m['mae']:.6f}"

        if plant in results["approaches"].get("physics_only", {}).get("transfer", {}):
            m = results["approaches"]["physics_only"]["transfer"][plant]["metrics"]
            summary["physics_only"][plant] = f"R²={m['r2']:.4f}, MAE={m['mae']:.6f}"

    results["summary"] = summary

    return results


def calculate_regional_transfer_experiments(
    all_plant_data: list[pl.DataFrame],
) -> dict:
    """
    Smarter transfer learning experiments:
    1. Clean data (remove SR > 1.0, exclude bad plants)
    2. Regional clustering (Spanish Mediterranean only)
    3. Weekly/monthly aggregations to reduce noise
    4. Clear train→test documentation
    """
    try:
        import lightgbm as lgb
        from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error
    except ImportError:
        logger.warning("LightGBM/sklearn not available")
        return {}

    results = {
        "data_cleaning": {},
        "regional_daily": {},
        "regional_weekly": {},
        "regional_monthly": {},
        "pairwise_experiments": [],
    }

    # =========================================================================
    # Step 1: Data Cleaning & Plant Selection
    # =========================================================================
    logger.info("\n--- Step 1: Data Cleaning & Plant Selection ---")

    # Plants to use (exclude alpha1/Alpha - bad data)
    good_plants = ["ribera", "gamma", "eta", "delta", "zeta"]
    # Epsilon is German, different climate - keep separate

    cleaned_dfs = {}
    for df in all_plant_data:
        plant = df["plant"][0]

        # Skip alpha1 (bad data quality)
        if plant == "alpha1":
            logger.info(f"  {plant}: EXCLUDED (known data quality issues)")
            results["data_cleaning"][plant] = {"status": "excluded", "reason": "bad data quality"}
            continue

        # Skip Epsilon (different climate region)
        if plant == "epsilon":
            logger.info(f"  {plant}: EXCLUDED from Spanish regional experiments (German plant)")
            results["data_cleaning"][plant] = {"status": "excluded_regional", "reason": "different climate region"}
            continue

        # Clean gamma (remove SR > 1.0)
        original_count = df.height
        if plant == "gamma":
            df_clean = df.filter(pl.col("sr_dustiq") <= 1.02)  # Allow small margin
            removed = original_count - df_clean.height
            logger.info(f"  {plant}: Removed {removed} rows with SR > 1.02 ({removed/original_count*100:.1f}%)")
            results["data_cleaning"][plant] = {
                "status": "cleaned",
                "original_rows": original_count,
                "cleaned_rows": df_clean.height,
                "removed_pct": round(removed/original_count*100, 1),
            }
        else:
            # For other plants, just filter out any extreme outliers
            df_clean = df.filter((pl.col("sr_dustiq") >= 0.7) & (pl.col("sr_dustiq") <= 1.02))
            removed = original_count - df_clean.height
            if removed > 0:
                logger.info(f"  {plant}: Removed {removed} outlier rows ({removed/original_count*100:.1f}%)")
            else:
                logger.info(f"  {plant}: No outliers removed, {df_clean.height} rows")
            results["data_cleaning"][plant] = {
                "status": "ok" if removed == 0 else "minor_cleaning",
                "original_rows": original_count,
                "cleaned_rows": df_clean.height,
                "removed_pct": round(removed/original_count*100, 1),
            }

        if df_clean.height >= 100:
            cleaned_dfs[plant] = df_clean

    logger.info(f"\n  Using {len(cleaned_dfs)} Spanish Mediterranean plants: {list(cleaned_dfs.keys())}")

    if len(cleaned_dfs) < 2:
        logger.warning("Not enough plants for transfer learning experiments")
        return results

    # =========================================================================
    # Step 2: Create Weekly and Monthly Aggregations
    # =========================================================================
    logger.info("\n--- Step 2: Creating Weekly/Monthly Aggregations ---")

    weekly_dfs = {}
    monthly_dfs = {}

    # Features to aggregate
    feature_cols = [
        # Weather features
        "precip_7d", "precip_14d", "precip_30d",
        "days_since_rain_1mm", "days_since_rain_5mm",
        "temp_mean_7d", "temp_range_7d", "humidity_mean_7d",
        "wind_mean_7d", "wind_max_7d",
        # AOD features
        "aod_total_7d", "aod_total_14d", "dust_7d", "pm10_7d", "pm25_7d",
        "aod_accum_since_rain", "aod_x_no_rain_days",
        "is_dry_season",
        # Digital twin features (DC current/voltage analysis)
        "current_cv",  # Current coefficient of variation (low = uniform soiling)
        "voltage_cv",  # Voltage coefficient of variation
        "current_loss_pct",  # Estimated current loss %
        "soiling_signature",  # Composite: low CV + good current = soiling
        # Inverter temperature features
        "inv_temp_mean",  # Average inverter temperature (high temp = stressed panels)
        "inv_temp_max",   # Max inverter temperature
    ]

    for plant, df in cleaned_dfs.items():
        # Weekly aggregation
        available_cols = [c for c in feature_cols if c in df.columns]
        agg_exprs = [pl.col(c).mean().alias(c) for c in available_cols]
        agg_exprs.append(pl.col("sr_dustiq").mean().alias("sr_dustiq"))
        agg_exprs.append(pl.col("soiling_rate").mean().alias("soiling_rate"))
        agg_exprs.append(pl.lit(plant).alias("plant"))

        weekly = df.with_columns(
            pl.col("date").dt.truncate("1w").alias("week")
        ).group_by("week").agg(agg_exprs).sort("week")

        weekly_dfs[plant] = weekly
        logger.info(f"  {plant}: {df.height} daily → {weekly.height} weekly rows")

        # Monthly aggregation
        monthly = df.with_columns(
            pl.col("date").dt.truncate("1mo").alias("month")
        ).group_by("month").agg(agg_exprs).sort("month")

        monthly_dfs[plant] = monthly
        logger.info(f"  {plant}: {df.height} daily → {monthly.height} monthly rows")

    # =========================================================================
    # Step 3: Pairwise Transfer Learning Experiments
    # =========================================================================
    logger.info("\n--- Step 3: Pairwise Transfer Experiments ---")

    params = {
        "objective": "regression",
        "metric": "rmse",
        "verbosity": -1,
        "n_estimators": 100,
        "max_depth": 5,
        "learning_rate": 0.1,
    }

    def run_transfer_experiment(train_df, test_df, train_plant, test_plant, resolution):
        """Run a single transfer learning experiment."""
        available_cols = [c for c in feature_cols if c in train_df.columns and c in test_df.columns]

        train_clean = train_df.select(["sr_dustiq"] + available_cols).drop_nulls()
        test_clean = test_df.select(["sr_dustiq"] + available_cols).drop_nulls()

        if train_clean.height < 30 or test_clean.height < 20:
            return None

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_dustiq"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_dustiq"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        # Calculate MAE by trend direction
        actual_diff = np.diff(y_test)
        threshold = 0.002
        downward_mask = actual_diff < -threshold
        upward_mask = actual_diff > threshold
        stable_mask = (actual_diff >= -threshold) & (actual_diff <= threshold)

        errors = np.abs(y_test - y_pred)
        errors_for_diff = errors[1:]

        mae_downward = float(np.mean(errors_for_diff[downward_mask])) if np.sum(downward_mask) > 2 else None
        mae_upward = float(np.mean(errors_for_diff[upward_mask])) if np.sum(upward_mask) > 2 else None
        mae_stable = float(np.mean(errors_for_diff[stable_mask])) if np.sum(stable_mask) > 2 else None

        # Direction accuracy
        pred_diff = np.diff(y_pred)
        direction_match = np.sign(actual_diff) == np.sign(pred_diff)
        direction_accuracy = float(np.mean(direction_match)) if len(direction_match) > 0 else None

        return {
            "train_plant": train_plant,
            "test_plant": test_plant,
            "resolution": resolution,
            "r2": round(r2_score(y_test, y_pred), 4),
            "rmse": round(np.sqrt(mean_squared_error(y_test, y_pred)), 6),
            "mae": round(mean_absolute_error(y_test, y_pred), 6),
            "mae_downward": round(mae_downward, 6) if mae_downward else None,
            "mae_upward": round(mae_upward, 6) if mae_upward else None,
            "mae_stable": round(mae_stable, 6) if mae_stable else None,
            "n_downward": int(np.sum(downward_mask)),
            "n_upward": int(np.sum(upward_mask)),
            "n_stable": int(np.sum(stable_mask)),
            "direction_accuracy": round(direction_accuracy, 4) if direction_accuracy else None,
            "train_samples": train_clean.height,
            "test_samples": test_clean.height,
        }

    # Run pairwise experiments for each resolution
    plants = list(cleaned_dfs.keys())
    for resolution, dfs in [("daily", cleaned_dfs), ("weekly", weekly_dfs), ("monthly", monthly_dfs)]:
        logger.info(f"\n  Running {resolution} experiments...")

        resolution_results = {}
        for test_plant in plants:
            # Train on ALL other plants combined
            train_plants = [p for p in plants if p != test_plant]
            train_df = pl.concat([dfs[p] for p in train_plants])

            result = run_transfer_experiment(
                train_df, dfs[test_plant],
                train_plants, test_plant, resolution
            )
            if result:
                resolution_results[test_plant] = result
                logger.info(f"    Train: {train_plants} → Test: {test_plant}: R²={result['r2']:.4f}, MAE={result['mae']:.6f}")

        if resolution == "daily":
            results["regional_daily"] = resolution_results
        elif resolution == "weekly":
            results["regional_weekly"] = resolution_results
        else:
            results["regional_monthly"] = resolution_results

    # =========================================================================
    # Step 4: Individual Pair Experiments (for detailed analysis)
    # =========================================================================
    logger.info("\n--- Step 4: Individual Pair Experiments (Weekly) ---")

    for train_plant in plants:
        for test_plant in plants:
            if train_plant == test_plant:
                continue

            result = run_transfer_experiment(
                weekly_dfs[train_plant], weekly_dfs[test_plant],
                train_plant, test_plant, "weekly"
            )
            if result:
                results["pairwise_experiments"].append(result)
                status = "✅" if result["r2"] > 0.3 else "⚠️" if result["r2"] > 0 else "❌"
                logger.info(f"    {status} {train_plant} → {test_plant}: R²={result['r2']:.4f}")

    return results


def calculate_physics_informed_evaluation(
    all_plant_data: list[pl.DataFrame],
) -> dict:
    """
    Comprehensive evaluation with:
    1. Multiple metrics (R², Spearman, MAE, direction accuracy)
    2. Physics-based soiling model as baseline
    3. Power loss features from actual data
    4. Physics estimate as ML feature
    """
    try:
        import lightgbm as lgb
        from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error
        from scipy.stats import spearmanr, pearsonr
    except ImportError:
        logger.warning("Required packages not available")
        return {}

    results = {
        "metrics_comparison": {},
        "physics_baseline": {},
        "physics_as_feature": {},
        "power_loss_features": {},
        "summary": {},
    }

    # =========================================================================
    # Step 1: Clean data (same as regional experiments)
    # =========================================================================
    logger.info("\n--- Step 1: Preparing Clean Data ---")

    cleaned_dfs = {}
    for df in all_plant_data:
        plant = df["plant"][0]
        if plant in ["alpha1", "epsilon"]:  # Skip bad/different climate
            continue

        original_count = df.height
        if plant == "gamma":
            df_clean = df.filter(pl.col("sr_dustiq") <= 1.02)
        else:
            df_clean = df.filter((pl.col("sr_dustiq") >= 0.7) & (pl.col("sr_dustiq") <= 1.02))

        if df_clean.height >= 100:
            cleaned_dfs[plant] = df_clean
            logger.info(f"  {plant}: {df_clean.height} rows")

    if len(cleaned_dfs) < 2:
        return results

    # =========================================================================
    # Step 2: Create Physics-Based Soiling Model
    # =========================================================================
    logger.info("\n--- Step 2: Physics-Based Soiling Model ---")

    def physics_soiling_estimate(df: pl.DataFrame) -> np.ndarray:
        """
        Simple physics-based soiling model:
        - Soiling accumulates during dry periods (proportional to AOD)
        - Rain cleans panels (recovery)
        - Base soiling rate during dry season
        """
        n = df.height

        # Get features
        days_since_rain = df["days_since_rain_1mm"].to_numpy() if "days_since_rain_1mm" in df.columns else np.zeros(n)
        aod = df["aod_total_7d"].to_numpy() if "aod_total_7d" in df.columns else np.ones(n) * 0.1
        is_dry = df["is_dry_season"].to_numpy() if "is_dry_season" in df.columns else np.zeros(n)
        precip_7d = df["precip_7d"].to_numpy() if "precip_7d" in df.columns else np.zeros(n)

        # Handle NaNs
        days_since_rain = np.nan_to_num(days_since_rain, nan=0)
        aod = np.nan_to_num(aod, nan=0.1)
        is_dry = np.nan_to_num(is_dry, nan=0)
        precip_7d = np.nan_to_num(precip_7d, nan=0)

        # Physics model parameters (tunable)
        base_soiling_rate = 0.001  # 0.1% per day baseline
        aod_factor = 0.005  # AOD contribution
        dry_season_factor = 1.5  # 50% more soiling in dry season
        rain_recovery = 0.02  # 2% recovery per mm of rain

        # Calculate soiling loss estimate
        soiling_loss = np.zeros(n)
        for i in range(n):
            # Accumulation component
            accumulation = days_since_rain[i] * (base_soiling_rate + aod[i] * aod_factor)
            if is_dry[i]:
                accumulation *= dry_season_factor

            # Cap at reasonable max
            accumulation = min(accumulation, 0.15)  # Max 15% loss

            # Recovery from recent rain
            recovery = min(precip_7d[i] * rain_recovery, accumulation)

            soiling_loss[i] = max(0, accumulation - recovery)

        # Convert to soiling ratio (1 - loss)
        sr_estimate = 1.0 - soiling_loss

        return sr_estimate

    # Apply physics model to each plant
    for plant, df in cleaned_dfs.items():
        sr_physics = physics_soiling_estimate(df)
        sr_actual = df["sr_dustiq"].to_numpy()

        # Filter valid pairs
        valid = ~np.isnan(sr_actual) & ~np.isnan(sr_physics)
        sr_actual_v = sr_actual[valid]
        sr_physics_v = sr_physics[valid]

        if len(sr_actual_v) < 50:
            continue

        # Calculate metrics
        r2 = r2_score(sr_actual_v, sr_physics_v)
        mae = mean_absolute_error(sr_actual_v, sr_physics_v)
        spearman_corr, _ = spearmanr(sr_actual_v, sr_physics_v)
        pearson_corr, _ = pearsonr(sr_actual_v, sr_physics_v)

        # Direction accuracy (does model predict soiling/recovery correctly?)
        actual_diff = np.diff(sr_actual_v)
        physics_diff = np.diff(sr_physics_v)
        direction_match = np.sign(actual_diff) == np.sign(physics_diff)
        direction_accuracy = np.mean(direction_match)

        # MAE by trend direction (using actual SR changes)
        # Downward = soiling (SR decreasing), Upward = recovery (SR increasing), Stable = little change
        threshold = 0.002  # 0.2% change threshold
        downward_mask = actual_diff < -threshold  # Getting dirtier
        upward_mask = actual_diff > threshold     # Recovering/cleaning
        stable_mask = (actual_diff >= -threshold) & (actual_diff <= threshold)

        # Calculate MAE for each segment (use indices offset by 1 since diff reduces length by 1)
        errors = np.abs(sr_actual_v - sr_physics_v)
        errors_for_diff = errors[1:]  # Align with diff indices

        mae_downward = float(np.mean(errors_for_diff[downward_mask])) if np.sum(downward_mask) > 5 else None
        mae_upward = float(np.mean(errors_for_diff[upward_mask])) if np.sum(upward_mask) > 5 else None
        mae_stable = float(np.mean(errors_for_diff[stable_mask])) if np.sum(stable_mask) > 5 else None

        results["physics_baseline"][plant] = {
            "r2": round(r2, 4),
            "mae": round(mae, 6),
            "mae_downward": round(mae_downward, 6) if mae_downward else None,
            "mae_upward": round(mae_upward, 6) if mae_upward else None,
            "mae_stable": round(mae_stable, 6) if mae_stable else None,
            "n_downward": int(np.sum(downward_mask)),
            "n_upward": int(np.sum(upward_mask)),
            "n_stable": int(np.sum(stable_mask)),
            "spearman": round(spearman_corr, 4),
            "pearson": round(pearson_corr, 4),
            "direction_accuracy": round(direction_accuracy, 4),
            "n_samples": len(sr_actual_v),
        }
        logger.info(f"  {plant}: R²={r2:.4f}, Spearman={spearman_corr:.4f}, DirAcc={direction_accuracy:.4f}")

    # =========================================================================
    # Step 3: Multi-Metric Transfer Learning Evaluation
    # =========================================================================
    logger.info("\n--- Step 3: Multi-Metric Transfer Learning Evaluation ---")

    feature_cols = [
        # Weather features
        "precip_7d", "precip_14d", "precip_30d",
        "days_since_rain_1mm", "days_since_rain_5mm",
        "temp_mean_7d", "humidity_mean_7d",
        "wind_mean_7d",
        # AOD features
        "aod_total_7d", "aod_total_14d", "dust_7d", "pm10_7d",
        "aod_accum_since_rain", "aod_x_no_rain_days",
        "is_dry_season",
        # Digital twin features (DC current/voltage analysis)
        "current_cv",  # Current coefficient of variation (low = uniform soiling)
        "voltage_cv",  # Voltage coefficient of variation
        "current_loss_pct",  # Estimated current loss %
        "soiling_signature",  # Composite: low CV + good current = soiling
        # Inverter temperature features
        "inv_temp_mean",  # Average inverter temperature (high temp = stressed panels)
        "inv_temp_max",   # Max inverter temperature
    ]

    params = {
        "objective": "regression",
        "metric": "rmse",
        "verbosity": -1,
        "n_estimators": 100,
        "max_depth": 5,
        "learning_rate": 0.1,
    }

    plants = list(cleaned_dfs.keys())

    # Weekly aggregation
    weekly_dfs = {}
    for plant, df in cleaned_dfs.items():
        available_cols = [c for c in feature_cols if c in df.columns]
        agg_exprs = [pl.col(c).mean().alias(c) for c in available_cols]
        agg_exprs.append(pl.col("sr_dustiq").mean().alias("sr_dustiq"))
        agg_exprs.append(pl.col("soiling_rate").mean().alias("soiling_rate"))
        agg_exprs.append(pl.lit(plant).alias("plant"))

        weekly = df.with_columns(
            pl.col("date").dt.truncate("1w").alias("week")
        ).group_by("week").agg(agg_exprs).sort("week")

        weekly_dfs[plant] = weekly

    # Leave-one-out evaluation with multiple metrics
    for test_plant in plants:
        train_plants = [p for p in plants if p != test_plant]
        train_df = pl.concat([weekly_dfs[p] for p in train_plants])
        test_df = weekly_dfs[test_plant]

        # ONLY include columns with actual data (not all-null placeholders)
        available_cols = []
        for c in feature_cols:
            if c in train_df.columns and c in test_df.columns:
                train_non_null = train_df[c].drop_nulls().len()
                test_non_null = test_df[c].drop_nulls().len()
                if train_non_null > 0 and test_non_null > 0:
                    available_cols.append(c)

        train_clean = train_df.select(["sr_dustiq", "soiling_rate"] + available_cols).drop_nulls()
        test_clean = test_df.select(["sr_dustiq", "soiling_rate"] + available_cols).drop_nulls()

        if train_clean.height < 30 or test_clean.height < 20:
            print(f"  ⚠️ Skipping {test_plant}: train={train_clean.height}, test={test_clean.height}")
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_dustiq"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_dustiq"].to_numpy()
        soiling_rate_test = test_clean["soiling_rate"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        # Calculate comprehensive metrics
        r2 = r2_score(y_test, y_pred)
        mae = mean_absolute_error(y_test, y_pred)
        spearman_corr, _ = spearmanr(y_test, y_pred)
        pearson_corr, _ = pearsonr(y_test, y_pred)

        # Direction accuracy
        actual_diff = np.diff(y_test)
        pred_diff = np.diff(y_pred)
        direction_match = np.sign(actual_diff) == np.sign(pred_diff)
        direction_accuracy = np.mean(direction_match)

        # MAE by trend direction (using actual SR changes)
        threshold = 0.002  # 0.2% change threshold
        downward_mask = actual_diff < -threshold  # Getting dirtier
        upward_mask = actual_diff > threshold     # Recovering/cleaning
        stable_mask = (actual_diff >= -threshold) & (actual_diff <= threshold)

        # Calculate MAE for each segment
        errors = np.abs(y_test - y_pred)
        errors_for_diff = errors[1:]  # Align with diff indices

        mae_downward = float(np.mean(errors_for_diff[downward_mask])) if np.sum(downward_mask) > 3 else None
        mae_upward = float(np.mean(errors_for_diff[upward_mask])) if np.sum(upward_mask) > 3 else None
        mae_stable = float(np.mean(errors_for_diff[stable_mask])) if np.sum(stable_mask) > 3 else None

        results["metrics_comparison"][test_plant] = {
            "ml_transfer": {
                "r2": round(r2, 4),
                "mae": round(mae, 6),
                "mae_downward": round(mae_downward, 6) if mae_downward else None,
                "mae_upward": round(mae_upward, 6) if mae_upward else None,
                "mae_stable": round(mae_stable, 6) if mae_stable else None,
                "n_downward": int(np.sum(downward_mask)),
                "n_upward": int(np.sum(upward_mask)),
                "n_stable": int(np.sum(stable_mask)),
                "spearman": round(spearman_corr, 4),
                "pearson": round(pearson_corr, 4),
                "direction_accuracy": round(direction_accuracy, 4),
            },
            "train_plants": train_plants,
            "n_test": test_clean.height,
        }
        logger.info(f"  {test_plant} ML: R²={r2:.4f}, Spearman={spearman_corr:.4f}, DirAcc={direction_accuracy:.4f}")

    # =========================================================================
    # Step 4: Physics Estimate as ML Feature
    # =========================================================================
    logger.info("\n--- Step 4: Physics Estimate as ML Feature ---")

    # Add physics estimate to data
    for plant, df in cleaned_dfs.items():
        sr_physics = physics_soiling_estimate(df)
        cleaned_dfs[plant] = df.with_columns(
            pl.Series("sr_physics_estimate", sr_physics)
        )

    # Re-aggregate with physics estimate
    weekly_dfs_physics = {}
    for plant, df in cleaned_dfs.items():
        available_cols = [c for c in feature_cols if c in df.columns]
        agg_exprs = [pl.col(c).mean().alias(c) for c in available_cols]
        agg_exprs.append(pl.col("sr_dustiq").mean().alias("sr_dustiq"))
        agg_exprs.append(pl.col("sr_physics_estimate").mean().alias("sr_physics_estimate"))
        agg_exprs.append(pl.lit(plant).alias("plant"))

        weekly = df.with_columns(
            pl.col("date").dt.truncate("1w").alias("week")
        ).group_by("week").agg(agg_exprs).sort("week")
        weekly_dfs_physics[plant] = weekly

    # Evaluate with physics as feature
    feature_cols_with_physics = feature_cols + ["sr_physics_estimate"]

    for test_plant in plants:
        train_plants = [p for p in plants if p != test_plant]
        train_df = pl.concat([weekly_dfs_physics[p] for p in train_plants])
        test_df = weekly_dfs_physics[test_plant]

        available_cols = [c for c in feature_cols_with_physics if c in train_df.columns and c in test_df.columns]

        train_clean = train_df.select(["sr_dustiq"] + available_cols).drop_nulls()
        test_clean = test_df.select(["sr_dustiq"] + available_cols).drop_nulls()

        if train_clean.height < 30 or test_clean.height < 20:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_dustiq"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_dustiq"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        # Metrics
        r2 = r2_score(y_test, y_pred)
        mae = mean_absolute_error(y_test, y_pred)
        spearman_corr, _ = spearmanr(y_test, y_pred)

        # Direction accuracy
        actual_diff = np.diff(y_test)
        pred_diff = np.diff(y_pred)
        direction_accuracy = np.mean(np.sign(actual_diff) == np.sign(pred_diff))

        # Feature importance for physics estimate
        physics_importance = 0
        if "sr_physics_estimate" in available_cols:
            physics_idx = available_cols.index("sr_physics_estimate")
            physics_importance = model.feature_importances_[physics_idx]

        results["physics_as_feature"][test_plant] = {
            "r2": round(r2, 4),
            "mae": round(mae, 6),
            "spearman": round(spearman_corr, 4),
            "direction_accuracy": round(direction_accuracy, 4),
            "physics_feature_importance": round(physics_importance, 1),
        }
        logger.info(f"  {test_plant} ML+Physics: R²={r2:.4f}, Spearman={spearman_corr:.4f}, PhysicsImp={physics_importance:.1f}")

    # =========================================================================
    # Step 5: Summary Comparison
    # =========================================================================
    logger.info("\n--- Step 5: Summary ---")

    for plant in plants:
        physics = results["physics_baseline"].get(plant, {})
        ml = results["metrics_comparison"].get(plant, {}).get("ml_transfer", {})
        ml_physics = results["physics_as_feature"].get(plant, {})

        results["summary"][plant] = {
            "physics_only": {
                "r2": physics.get("r2", None),
                "spearman": physics.get("spearman", None),
                "direction_accuracy": physics.get("direction_accuracy", None),
            },
            "ml_transfer": {
                "r2": ml.get("r2", None),
                "spearman": ml.get("spearman", None),
                "direction_accuracy": ml.get("direction_accuracy", None),
            },
            "ml_with_physics": {
                "r2": ml_physics.get("r2", None),
                "spearman": ml_physics.get("spearman", None),
                "direction_accuracy": ml_physics.get("direction_accuracy", None),
            },
        }

    # =========================================================================
    # Step 6: Threshold-Based Practical Evaluation
    # =========================================================================
    logger.info("\n--- Step 6: Threshold-Based Practical Evaluation ---")
    logger.info("  Evaluating: Can we correctly identify when panels need cleaning?")

    results["threshold_evaluation"] = {}

    # Thresholds to evaluate: at what SR level should we trigger cleaning?
    thresholds = [0.99, 0.98, 0.97, 0.96, 0.95]

    for test_plant in plants:
        train_plants = [p for p in plants if p != test_plant]
        train_df = pl.concat([weekly_dfs[p] for p in train_plants])
        test_df = weekly_dfs[test_plant]

        available_cols = [c for c in feature_cols if c in train_df.columns and c in test_df.columns]

        train_clean = train_df.select(["sr_dustiq"] + available_cols).drop_nulls()
        test_clean = test_df.select(["sr_dustiq"] + available_cols).drop_nulls()

        if train_clean.height < 30 or test_clean.height < 20:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_dustiq"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_dustiq"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        threshold_metrics = {}
        for thresh in thresholds:
            # Actual: is the panel dirty (SR < threshold)?
            actual_dirty = y_test < thresh
            # Predicted: would we flag it as dirty?
            pred_dirty = y_pred < thresh

            # Also check with 1% buffer (predict dirty if SR < threshold + 0.01)
            pred_dirty_buffered = y_pred < (thresh + 0.01)

            n_actual_dirty = np.sum(actual_dirty)
            n_pred_dirty = np.sum(pred_dirty)
            n_pred_dirty_buf = np.sum(pred_dirty_buffered)

            # True positives: actually dirty AND predicted dirty
            tp = np.sum(actual_dirty & pred_dirty)
            tp_buf = np.sum(actual_dirty & pred_dirty_buffered)
            # False positives: not dirty but predicted dirty
            fp = np.sum(~actual_dirty & pred_dirty)
            fp_buf = np.sum(~actual_dirty & pred_dirty_buffered)
            # False negatives: dirty but not predicted dirty
            fn = np.sum(actual_dirty & ~pred_dirty)
            fn_buf = np.sum(actual_dirty & ~pred_dirty_buffered)
            # True negatives: not dirty and not predicted dirty
            tn = np.sum(~actual_dirty & ~pred_dirty)

            # Metrics
            precision = tp / (tp + fp) if (tp + fp) > 0 else 0
            recall = tp / (tp + fn) if (tp + fn) > 0 else 0
            accuracy = (tp + tn) / len(y_test) if len(y_test) > 0 else 0

            # With buffer
            precision_buf = tp_buf / (tp_buf + fp_buf) if (tp_buf + fp_buf) > 0 else 0
            recall_buf = tp_buf / (tp_buf + fn_buf) if (tp_buf + fn_buf) > 0 else 0

            threshold_metrics[thresh] = {
                "n_actual_dirty": int(n_actual_dirty),
                "n_total": len(y_test),
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "accuracy": round(accuracy, 4),
                "precision_buffered": round(precision_buf, 4),
                "recall_buffered": round(recall_buf, 4),
            }

        results["threshold_evaluation"][test_plant] = threshold_metrics
        logger.info(f"  {test_plant}: Threshold evaluation complete")

    # =========================================================================
    # Step 7: Weighted Training to Fix Bias Toward "Clean" Predictions
    # =========================================================================
    logger.info("\n--- Step 7: Weighted Training (Emphasize Dirty Samples) ---")
    logger.info("  Testing: Can sample weighting improve detection of dirty panels?")

    results["weighted_training"] = {}

    # Weighting strategies to test
    def get_sample_weights(y, strategy: str):
        """Calculate sample weights based on strategy."""
        if strategy == "uniform":
            return np.ones(len(y))

        elif strategy == "inverse_sr":
            # Weight = 1/SR, so SR=0.95 gets ~1.05x, SR=0.90 gets ~1.11x
            return 1.0 / np.clip(y, 0.8, 1.0)

        elif strategy == "exponential":
            # Weight = exp(k * (1 - SR)), k=10 means SR=0.95 gets ~1.6x, SR=0.90 gets ~2.7x
            k = 10
            return np.exp(k * (1 - y))

        elif strategy == "threshold_98":
            # 5x weight for samples with SR < 0.98
            weights = np.ones(len(y))
            weights[y < 0.98] = 5.0
            return weights

        elif strategy == "threshold_97":
            # 10x weight for samples with SR < 0.97
            weights = np.ones(len(y))
            weights[y < 0.97] = 10.0
            return weights

        elif strategy == "progressive":
            # Progressive weighting: more weight as SR decreases
            # SR >= 1.00: weight = 1
            # SR = 0.98: weight = 3
            # SR = 0.96: weight = 5
            # SR = 0.94: weight = 7
            weights = 1 + 2 * np.maximum(0, (1.0 - y) / 0.01)
            return np.clip(weights, 1, 20)

        elif strategy == "squared":
            # Weight = (1 + (1-SR)*10)^2 - quadratic emphasis on dirty
            return (1 + 10 * np.maximum(0, 1 - y)) ** 2

        else:
            return np.ones(len(y))

    strategies = ["uniform", "exponential", "threshold_98", "progressive", "squared"]

    for test_plant in plants:
        train_plants = [p for p in plants if p != test_plant]
        train_df = pl.concat([weekly_dfs[p] for p in train_plants])
        test_df = weekly_dfs[test_plant]

        available_cols = [c for c in feature_cols if c in train_df.columns and c in test_df.columns]

        train_clean = train_df.select(["sr_dustiq"] + available_cols).drop_nulls()
        test_clean = test_df.select(["sr_dustiq"] + available_cols).drop_nulls()

        if train_clean.height < 30 or test_clean.height < 20:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_dustiq"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_dustiq"].to_numpy()

        strategy_results = {}

        for strategy in strategies:
            weights = get_sample_weights(y_train, strategy)

            # Train with sample weights
            model = lgb.LGBMRegressor(**params)
            model.fit(X_train, y_train, sample_weight=weights)
            y_pred = model.predict(X_test)

            # Calculate metrics at different thresholds
            thresh_results = {}
            for thresh in [0.99, 0.98, 0.97]:
                actual_dirty = y_test < thresh
                pred_dirty = y_pred < thresh
                pred_dirty_buf = y_pred < (thresh + 0.01)

                n_dirty = np.sum(actual_dirty)
                if n_dirty == 0:
                    thresh_results[thresh] = {"n_dirty": 0, "recall": None, "precision": None}
                    continue

                tp = np.sum(actual_dirty & pred_dirty)
                tp_buf = np.sum(actual_dirty & pred_dirty_buf)
                fp = np.sum(~actual_dirty & pred_dirty)
                fp_buf = np.sum(~actual_dirty & pred_dirty_buf)
                fn = np.sum(actual_dirty & ~pred_dirty)
                fn_buf = np.sum(actual_dirty & ~pred_dirty_buf)

                precision = tp / (tp + fp) if (tp + fp) > 0 else 0
                recall = tp / (tp + fn) if (tp + fn) > 0 else 0
                precision_buf = tp_buf / (tp_buf + fp_buf) if (tp_buf + fp_buf) > 0 else 0
                recall_buf = tp_buf / (tp_buf + fn_buf) if (tp_buf + fn_buf) > 0 else 0

                thresh_results[thresh] = {
                    "n_dirty": int(n_dirty),
                    "precision": round(precision, 4),
                    "recall": round(recall, 4),
                    "precision_buf": round(precision_buf, 4),
                    "recall_buf": round(recall_buf, 4),
                }

            # Overall metrics
            r2 = r2_score(y_test, y_pred)
            mae = mean_absolute_error(y_test, y_pred)

            # Prediction distribution stats
            pred_mean = np.mean(y_pred)
            pred_std = np.std(y_pred)
            pred_min = np.min(y_pred)
            pred_below_98 = np.mean(y_pred < 0.98) * 100

            strategy_results[strategy] = {
                "r2": round(r2, 4),
                "mae": round(mae, 6),
                "pred_mean": round(pred_mean, 4),
                "pred_std": round(pred_std, 4),
                "pred_min": round(pred_min, 4),
                "pred_below_98_pct": round(pred_below_98, 1),
                "thresholds": thresh_results,
            }

        results["weighted_training"][test_plant] = strategy_results
        logger.info(f"  {test_plant}: Tested {len(strategies)} weighting strategies")

    # =========================================================================
    # Step 8: CatBoost with Physics Hybrid & Quantile Regression
    # =========================================================================
    logger.info("\n--- Step 8: CatBoost + Physics Hybrid + Quantile Regression ---")

    try:
        from catboost import CatBoostRegressor
        CATBOOST_AVAILABLE = True
    except ImportError:
        logger.warning("CatBoost not available, skipping Step 8")
        CATBOOST_AVAILABLE = False

    if CATBOOST_AVAILABLE:
        results["catboost_advanced"] = {}

        # CatBoost regularization configs (simple tuning as requested)
        catboost_configs = {
            "baseline": {"depth": 6, "l2_leaf_reg": 3.0, "iterations": 500},
            "regularized": {"depth": 4, "l2_leaf_reg": 10.0, "iterations": 300},
            "conservative": {"depth": 3, "l2_leaf_reg": 30.0, "iterations": 200},
        }

        for test_plant in plants:
            train_plants = [p for p in plants if p != test_plant]

            # Get data (use weekly from earlier)
            train_df = pl.concat([weekly_dfs[p] for p in train_plants])
            test_df = weekly_dfs[test_plant]

            # Get physics predictions for test data (for hybrid)
            test_physics_sr = physics_soiling_estimate(test_df)

            # Prepare features - ONLY include columns with actual data (not all-null)
            # This fixes the issue where placeholder columns (DC twins, inv temp) cause all rows to drop
            available_cols = []
            for c in feature_cols:
                if c in train_df.columns and c in test_df.columns:
                    # Check if column has any non-null values in BOTH train and test
                    train_non_null = train_df[c].drop_nulls().len()
                    test_non_null = test_df[c].drop_nulls().len()
                    if train_non_null > 0 and test_non_null > 0:
                        available_cols.append(c)

            train_clean = train_df.select(["sr_dustiq"] + available_cols).drop_nulls()
            test_clean = test_df.select(["sr_dustiq"] + available_cols).drop_nulls()

            if train_clean.height < 30 or test_clean.height < 15:
                print(f"  ⚠️ Skipping {test_plant}: train={train_clean.height}, test={test_clean.height} rows after drop_nulls")
                continue

            X_train = train_clean.select(available_cols).to_numpy()
            y_train = train_clean["sr_dustiq"].to_numpy()
            X_test = test_clean.select(available_cols).to_numpy()
            y_test = test_clean["sr_dustiq"].to_numpy()

            # Validation on 20% of TARGET plant for hyperparameter selection
            n_val = max(5, int(len(y_test) * 0.2))
            X_test_val, X_test_final = X_test[:n_val], X_test[n_val:]
            y_test_val, y_test_final = y_test[:n_val], y_test[n_val:]
            physics_val, physics_final = test_physics_sr[:n_val], test_physics_sr[n_val:]

            if len(y_test_final) < 10:
                # Not enough for split - use all as test
                X_test_final, y_test_final = X_test, y_test
                physics_final = test_physics_sr
                use_validation = False
            else:
                use_validation = True

            plant_results = {
                "source_plants": train_plants,
                "target_plant": test_plant,
                "n_train": len(y_train),
                "n_test": len(y_test_final),
                "n_validation": n_val if use_validation else 0,
                "configs": {},
            }

            best_val_mae = float("inf")
            best_config_name = "baseline"

            # Weighting strategies (same as Step 7 - these worked well)
            def get_weights(y, strategy):
                if strategy == "none":
                    return None
                elif strategy == "exponential":
                    k = 10
                    return np.exp(k * (1 - y))
                elif strategy == "progressive":
                    weights = 1 + 2 * np.maximum(0, (1.0 - y) / 0.01)
                    return np.clip(weights, 1, 20)
                return None

            for config_name, config in catboost_configs.items():
                config_results = {}

                # Test with different weighting strategies
                for weight_strategy in ["none", "exponential", "progressive"]:
                    sample_weights = get_weights(y_train, weight_strategy)

                    # Standard regression with weighting
                    model_reg = CatBoostRegressor(
                        depth=config["depth"],
                        l2_leaf_reg=config["l2_leaf_reg"],
                        iterations=config["iterations"],
                        learning_rate=0.05,
                        random_seed=42,
                        verbose=False,
                    )
                    model_reg.fit(X_train, y_train, sample_weight=sample_weights)
                    pred_reg = model_reg.predict(X_test_final)

                    # Quantile regression (predict 25th percentile = conservative)
                    model_q25 = CatBoostRegressor(
                        depth=config["depth"],
                        l2_leaf_reg=config["l2_leaf_reg"],
                        iterations=config["iterations"],
                        learning_rate=0.05,
                        random_seed=42,
                        verbose=False,
                        loss_function="Quantile:alpha=0.25",
                    )
                    model_q25.fit(X_train, y_train, sample_weight=sample_weights)
                    pred_q25 = model_q25.predict(X_test_final)

                    # Physics hybrid: average of ML and physics predictions
                    pred_hybrid = 0.5 * pred_reg + 0.5 * physics_final[:len(pred_reg)]

                    # Calculate metrics for each approach
                    approaches = {
                        f"reg_{weight_strategy}": pred_reg,
                        f"q25_{weight_strategy}": pred_q25,
                        f"hybrid_{weight_strategy}": pred_hybrid,
                    }

                    for approach_name, preds in approaches.items():
                        valid_mask = ~np.isnan(y_test_final[:len(preds)]) & ~np.isnan(preds)
                        if np.sum(valid_mask) < 5:
                            continue

                        y_true = y_test_final[:len(preds)][valid_mask]
                        y_pred = preds[valid_mask]

                        r2 = r2_score(y_true, y_pred)
                        mae = mean_absolute_error(y_true, y_pred)
                        spearman_corr, _ = spearmanr(y_true, y_pred)

                        # Threshold metrics (with buffer: predict dirty if pred < 0.99)
                        dirty_actual = y_true < 0.98
                        dirty_pred_buf = y_pred < 0.99  # 1% buffer
                        precision = np.sum(dirty_actual & dirty_pred_buf) / max(1, np.sum(dirty_pred_buf))
                        recall = np.sum(dirty_actual & dirty_pred_buf) / max(1, np.sum(dirty_actual))

                        # 2-week consecutive detection: require 2+ consecutive weeks predicted dirty
                        # This reduces false positives at the cost of delayed detection
                        dirty_pred_2wk = np.zeros_like(dirty_pred_buf)
                        for i in range(1, len(dirty_pred_buf)):
                            if dirty_pred_buf[i] and dirty_pred_buf[i-1]:
                                dirty_pred_2wk[i] = True
                                dirty_pred_2wk[i-1] = True
                        precision_2wk = np.sum(dirty_actual & dirty_pred_2wk) / max(1, np.sum(dirty_pred_2wk))
                        recall_2wk = np.sum(dirty_actual & dirty_pred_2wk) / max(1, np.sum(dirty_actual))

                        config_results[approach_name] = {
                            "r2": round(r2, 4),
                            "mae": round(mae, 6),
                            "spearman": round(spearman_corr, 4),
                            "precision_98": round(precision, 4),
                            "recall_98": round(recall, 4),
                            "precision_2wk": round(precision_2wk, 4),
                            "recall_2wk": round(recall_2wk, 4),
                            "pred_mean": round(float(np.mean(y_pred)), 4),
                            "pred_below_98_pct": round(100 * np.mean(y_pred < 0.98), 1),
                        }

                # Validation on target plant (if available) to select best config
                if use_validation:
                    # Use exponential weighting for validation (best from Step 7)
                    exp_weights = get_weights(y_train, "exponential")
                    model_val = CatBoostRegressor(
                        depth=config["depth"],
                        l2_leaf_reg=config["l2_leaf_reg"],
                        iterations=config["iterations"],
                        learning_rate=0.05,
                        random_seed=42,
                        verbose=False,
                    )
                    model_val.fit(X_train, y_train, sample_weight=exp_weights)
                    pred_val = model_val.predict(X_test_val)
                    val_mae = mean_absolute_error(y_test_val, pred_val)
                    config_results["validation_mae"] = round(val_mae, 6)

                    if val_mae < best_val_mae:
                        best_val_mae = val_mae
                        best_config_name = config_name

                plant_results["configs"][config_name] = config_results

            plant_results["best_config"] = best_config_name
            plant_results["best_validation_mae"] = round(best_val_mae, 6) if use_validation else None

            results["catboost_advanced"][test_plant] = plant_results
            logger.info(f"  {test_plant} (from {train_plants}): Best config = {best_config_name}")

    return results


def print_physics_evaluation_results(physics_results: dict):
    """Print comprehensive physics-informed evaluation results."""

    if not physics_results:
        return

    print("\n" + "="*120)
    print("🔬 PHYSICS-INFORMED EVALUATION (Better Metrics + Physics Baseline)")
    print("="*120)

    # Physics baseline
    physics = physics_results.get("physics_baseline", {})
    if physics:
        print("\n📐 PHYSICS-ONLY MODEL (Simple accumulation + rain cleaning):")
        print("-"*120)
        print("Model: SR = 1 - (days_dry × (base_rate + AOD×factor) × season_mult - rain_recovery)")
        print()
        print("┌──────────────┬────────┬──────────┬──────────┬──────────┬────────────────┐")
        print("│    Plant     │   R²   │   MAE    │ Spearman │ Pearson  │ Direction Acc  │")
        print("├──────────────┼────────┼──────────┼──────────┼──────────┼────────────────┤")

        for plant, m in physics.items():
            r2_status = "✅" if m["r2"] > 0.3 else "⚠️" if m["r2"] > 0 else "❌"
            print(f"│ {plant:<12} │ {r2_status}{m['r2']:>5.3f} │ {m['mae']:.6f} │ {m['spearman']:>8.4f} │ {m['pearson']:>8.4f} │ {m['direction_accuracy']*100:>12.1f}% │")

        print("└──────────────┴────────┴──────────┴──────────┴──────────┴────────────────┘")

        # MAE by Trend Direction table
        print()
        print("📊 MAE BY SOILING TREND (Physics-Only):")
        print("  Downward = soiling (SR↓), Upward = recovery (SR↑), Stable = |ΔSR| < 0.2%")
        print()
        print("┌──────────────┬────────────────────────────────┬────────────────────────────────┬────────────────────────────────┐")
        print("│    Plant     │     MAE DOWNWARD (soiling)     │     MAE UPWARD (recovery)      │       MAE STABLE               │")
        print("│              ├──────────┬─────────────────────┼──────────┬─────────────────────┼──────────┬─────────────────────┤")
        print("│              │   MAE    │         n           │   MAE    │         n           │   MAE    │         n           │")
        print("├──────────────┼──────────┼─────────────────────┼──────────┼─────────────────────┼──────────┼─────────────────────┤")

        for plant, m in physics.items():
            mae_d = f"{m.get('mae_downward', 0):.6f}" if m.get('mae_downward') else "    N/A   "
            mae_u = f"{m.get('mae_upward', 0):.6f}" if m.get('mae_upward') else "    N/A   "
            mae_s = f"{m.get('mae_stable', 0):.6f}" if m.get('mae_stable') else "    N/A   "
            n_d = f"{m.get('n_downward', 0):>5}"
            n_u = f"{m.get('n_upward', 0):>5}"
            n_s = f"{m.get('n_stable', 0):>5}"
            print(f"│ {plant:<12} │ {mae_d} │ {n_d:>19} │ {mae_u} │ {n_u:>19} │ {mae_s} │ {n_s:>19} │")

        print("└──────────────┴──────────┴─────────────────────┴──────────┴─────────────────────┴──────────┴─────────────────────┘")

    # Multi-metric comparison
    metrics = physics_results.get("metrics_comparison", {})
    if metrics:
        print("\n📊 ML TRANSFER LEARNING (Multiple Metrics):")
        print("-"*120)
        print("Weekly aggregation, Leave-one-plant-out cross-validation")
        print()
        print("┌──────────────┬────────┬──────────┬──────────┬────────────────┬─────────────────────────┐")
        print("│  Test Plant  │   R²   │   MAE    │ Spearman │ Direction Acc  │      Train Plants       │")
        print("├──────────────┼────────┼──────────┼──────────┼────────────────┼─────────────────────────┤")

        for plant, data in metrics.items():
            m = data.get("ml_transfer", {})
            train = ", ".join(data.get("train_plants", []))[:23]
            r2_status = "✅" if m.get("r2", -1) > 0.3 else "⚠️" if m.get("r2", -1) > 0 else "❌"
            print(f"│ {plant:<12} │ {r2_status}{m.get('r2', 0):>5.3f} │ {m.get('mae', 0):.6f} │ {m.get('spearman', 0):>8.4f} │ {m.get('direction_accuracy', 0)*100:>12.1f}% │ {train:<23} │")

        print("└──────────────┴────────┴──────────┴──────────┴────────────────┴─────────────────────────┘")

        # MAE by Trend Direction table for ML
        print()
        print("📊 MAE BY SOILING TREND (ML Transfer):")
        print("  Downward = soiling (SR↓), Upward = recovery (SR↑), Stable = |ΔSR| < 0.2%")
        print()
        print("┌──────────────┬────────────────────────────────┬────────────────────────────────┬────────────────────────────────┐")
        print("│  Test Plant  │     MAE DOWNWARD (soiling)     │     MAE UPWARD (recovery)      │       MAE STABLE               │")
        print("│              ├──────────┬─────────────────────┼──────────┬─────────────────────┼──────────┬─────────────────────┤")
        print("│              │   MAE    │         n           │   MAE    │         n           │   MAE    │         n           │")
        print("├──────────────┼──────────┼─────────────────────┼──────────┼─────────────────────┼──────────┼─────────────────────┤")

        for plant, data in metrics.items():
            m = data.get("ml_transfer", {})
            mae_d = f"{m.get('mae_downward', 0):.6f}" if m.get('mae_downward') else "    N/A   "
            mae_u = f"{m.get('mae_upward', 0):.6f}" if m.get('mae_upward') else "    N/A   "
            mae_s = f"{m.get('mae_stable', 0):.6f}" if m.get('mae_stable') else "    N/A   "
            n_d = f"{m.get('n_downward', 0):>5}"
            n_u = f"{m.get('n_upward', 0):>5}"
            n_s = f"{m.get('n_stable', 0):>5}"
            print(f"│ {plant:<12} │ {mae_d} │ {n_d:>19} │ {mae_u} │ {n_u:>19} │ {mae_s} │ {n_s:>19} │")

        print("└──────────────┴──────────┴─────────────────────┴──────────┴─────────────────────┴──────────┴─────────────────────┘")

    # ML with physics feature
    ml_physics = physics_results.get("physics_as_feature", {})
    if ml_physics:
        print("\n🧪 ML + PHYSICS ESTIMATE AS FEATURE:")
        print("-"*100)
        print("Using physics model estimate as additional input feature for ML")
        print()
        print("┌──────────────┬────────┬──────────┬──────────┬────────────────┬────────────────────┐")
        print("│  Test Plant  │   R²   │   MAE    │ Spearman │ Direction Acc  │ Physics Importance │")
        print("├──────────────┼────────┼──────────┼──────────┼────────────────┼────────────────────┤")

        for plant, m in ml_physics.items():
            r2_status = "✅" if m["r2"] > 0.3 else "⚠️" if m["r2"] > 0 else "❌"
            print(f"│ {plant:<12} │ {r2_status}{m['r2']:>5.3f} │ {m['mae']:.6f} │ {m['spearman']:>8.4f} │ {m['direction_accuracy']*100:>12.1f}% │ {m['physics_feature_importance']:>16.1f}  │")

        print("└──────────────┴────────┴──────────┴──────────┴────────────────┴────────────────────┘")

    # Summary comparison
    summary = physics_results.get("summary", {})
    if summary:
        print("\n" + "-"*100)
        print("📈 APPROACH COMPARISON SUMMARY")
        print("-"*100)
        print()
        print("┌──────────────┬───────────────────────────┬───────────────────────────┬───────────────────────────┐")
        print("│              │      PHYSICS-ONLY         │      ML TRANSFER          │     ML + PHYSICS          │")
        print("│  Plant       ├────────┬────────┬─────────┼────────┬────────┬─────────┼────────┬────────┬─────────┤")
        print("│              │   R²   │ Spear. │ DirAcc  │   R²   │ Spear. │ DirAcc  │   R²   │ Spear. │ DirAcc  │")
        print("├──────────────┼────────┼────────┼─────────┼────────┼────────┼─────────┼────────┼────────┼─────────┤")

        for plant, data in summary.items():
            p = data.get("physics_only", {})
            m = data.get("ml_transfer", {})
            mp = data.get("ml_with_physics", {})

            def fmt(v):
                return f"{v:>6.3f}" if v is not None else "   N/A"

            def fmt_pct(v):
                return f"{v*100:>5.1f}%" if v is not None else "   N/A"

            print(f"│ {plant:<12} │ {fmt(p.get('r2'))} │ {fmt(p.get('spearman'))} │ {fmt_pct(p.get('direction_accuracy'))} │ "
                  f"{fmt(m.get('r2'))} │ {fmt(m.get('spearman'))} │ {fmt_pct(m.get('direction_accuracy'))} │ "
                  f"{fmt(mp.get('r2'))} │ {fmt(mp.get('spearman'))} │ {fmt_pct(mp.get('direction_accuracy'))} │")

        print("└──────────────┴────────┴────────┴─────────┴────────┴────────┴─────────┴────────┴────────┴─────────┘")

    # Key insights
    print("\n" + "-"*100)
    print("💡 KEY INSIGHTS")
    print("-"*100)

    # Calculate averages
    physics_r2s = [v.get("r2", 0) for v in physics.values() if v.get("r2") is not None]
    physics_spear = [v.get("spearman", 0) for v in physics.values() if v.get("spearman") is not None]
    physics_dir = [v.get("direction_accuracy", 0) for v in physics.values() if v.get("direction_accuracy") is not None]

    ml_r2s = [v.get("ml_transfer", {}).get("r2", 0) for v in metrics.values()]
    ml_spear = [v.get("ml_transfer", {}).get("spearman", 0) for v in metrics.values()]
    ml_dir = [v.get("ml_transfer", {}).get("direction_accuracy", 0) for v in metrics.values()]

    mlp_r2s = [v.get("r2", 0) for v in ml_physics.values()]
    mlp_spear = [v.get("spearman", 0) for v in ml_physics.values()]
    mlp_dir = [v.get("direction_accuracy", 0) for v in ml_physics.values()]

    if physics_r2s:
        print(f"\n  Physics-Only:     Avg R²={np.mean(physics_r2s):>6.3f} | Avg Spearman={np.mean(physics_spear):>6.3f} | Avg DirAcc={np.mean(physics_dir)*100:>5.1f}%")
    if ml_r2s:
        print(f"  ML Transfer:      Avg R²={np.mean(ml_r2s):>6.3f} | Avg Spearman={np.mean(ml_spear):>6.3f} | Avg DirAcc={np.mean(ml_dir)*100:>5.1f}%")
    if mlp_r2s:
        print(f"  ML + Physics:     Avg R²={np.mean(mlp_r2s):>6.3f} | Avg Spearman={np.mean(mlp_spear):>6.3f} | Avg DirAcc={np.mean(mlp_dir)*100:>5.1f}%")

    # Recommendations
    print("\n  📋 RECOMMENDATIONS:")
    if physics_spear and ml_spear:
        if np.mean(physics_spear) > np.mean(ml_spear):
            print("  ✅ Physics model has BETTER correlation than ML transfer - use physics for new plants!")
        else:
            print("  ⚠️ ML has better correlation but still weak - consider hybrid approach")

    if physics_dir:
        avg_dir = np.mean(physics_dir)
        if avg_dir > 0.6:
            print(f"  ✅ Physics model predicts soiling/recovery DIRECTION correctly {avg_dir*100:.0f}% of the time")
        else:
            print(f"  ⚠️ Direction prediction is only {avg_dir*100:.0f}% - near random")

    # Threshold-based evaluation (practical usability for scheduling)
    threshold_eval = physics_results.get("threshold_evaluation", {})
    if threshold_eval:
        print("\n" + "="*120)
        print("🎯 THRESHOLD-BASED EVALUATION: Can Models Detect Dirty Panels?")
        print("="*120)
        print("\nQuestion: If MAE ~1%, can we still reliably detect when SR drops below cleaning threshold?")
        print("This is the PRACTICAL metric for scheduling - precision/recall for 'needs cleaning' classification.")
        print()

        # Create summary table header
        thresholds = [0.99, 0.98, 0.97, 0.96, 0.95]
        print("┌──────────────┬" + "┬".join(["─"*24 for _ in thresholds]) + "┐")
        header = "│  Test Plant  │" + "│".join([f"    SR < {t:.2f} (dirty)    " for t in thresholds]) + "│"
        print(header)
        print("│              │" + "│".join(["  Prec   Recall   Acc   " for _ in thresholds]) + "│")
        print("├──────────────┼" + "┼".join(["─"*24 for _ in thresholds]) + "┤")

        for plant, metrics in threshold_eval.items():
            row = f"│ {plant:<12} │"
            for thresh in thresholds:
                m = metrics.get(thresh, {})
                prec = m.get("precision", 0)
                recall = m.get("recall", 0)
                acc = m.get("accuracy", 0)
                # Color code: ✅ if recall > 0.7, ⚠️ if > 0.5, ❌ otherwise
                status = "✅" if recall > 0.7 else "⚠️" if recall > 0.5 else "  "
                row += f" {status}{prec:.2f}   {recall:.2f}   {acc:.2f}  │"
            print(row)

        print("└──────────────┴" + "┴".join(["─"*24 for _ in thresholds]) + "┘")
        print("\nLegend: Precision = TP/(TP+FP), Recall = TP/(TP+FN), ✅ = Recall > 70%")
        print("  High Recall = we catch most dirty panels; High Precision = few false alarms")

        # With buffered predictions (allowing 1% margin)
        print("\n📊 WITH 1% BUFFER (predict dirty if SR < threshold + 0.01):")
        print("┌──────────────┬" + "┬".join(["─"*24 for _ in thresholds]) + "┐")
        header = "│  Test Plant  │" + "│".join([f"    SR < {t:.2f} (dirty)    " for t in thresholds]) + "│"
        print(header)
        print("│              │" + "│".join(["  Prec   Recall   n     " for _ in thresholds]) + "│")
        print("├──────────────┼" + "┼".join(["─"*24 for _ in thresholds]) + "┤")

        for plant, metrics in threshold_eval.items():
            row = f"│ {plant:<12} │"
            for thresh in thresholds:
                m = metrics.get(thresh, {})
                prec = m.get("precision_buffered", 0)
                recall = m.get("recall_buffered", 0)
                n = m.get("n_actual_dirty", 0)
                status = "✅" if recall > 0.8 else "⚠️" if recall > 0.6 else "  "
                row += f" {status}{prec:.2f}   {recall:.2f}   {n:>4}  │"
            print(row)

        print("└──────────────┴" + "┴".join(["─"*24 for _ in thresholds]) + "┘")

        # Summary and interpretation
        print("\n" + "-"*100)
        print("💡 PRACTICAL INTERPRETATION FOR CLEANING SCHEDULING:")
        print("-"*100)

        # Calculate average metrics across plants
        avg_recall_98 = np.mean([m.get(0.98, {}).get("recall_buffered", 0) for m in threshold_eval.values()])
        avg_recall_97 = np.mean([m.get(0.97, {}).get("recall_buffered", 0) for m in threshold_eval.values()])
        avg_prec_98 = np.mean([m.get(0.98, {}).get("precision_buffered", 0) for m in threshold_eval.values()])

        print(f"\n  At SR < 0.98 (2% soiling loss) with buffer:")
        print(f"    • Average Recall = {avg_recall_98:.1%} → We catch {avg_recall_98:.0%} of dirty panels")
        print(f"    • Average Precision = {avg_prec_98:.1%} → {(1-avg_prec_98):.0%} false alarms")

        if avg_recall_98 > 0.7:
            print(f"\n  ✅ CONCLUSION: Despite ~1% MAE, models ARE usable for cleaning scheduling!")
            print(f"     The MAE spreads predictions around the true value, but threshold-based")
            print(f"     classification still catches {avg_recall_98:.0%} of panels needing cleaning.")
            print(f"     Use SR < 0.98 threshold + 1% buffer for practical scheduling.")
        elif avg_recall_98 > 0.5:
            print(f"\n  ⚠️ CONCLUSION: Models have moderate utility for scheduling")
            print(f"     Consider using a more aggressive threshold (SR < 0.97) or")
            print(f"     combining with physical inspection for critical periods.")
        else:
            print(f"\n  ❌ CONCLUSION: Models need improvement for practical scheduling")
            print(f"     Consider per-plant models or additional features.")

    # Weighted training results
    weighted = physics_results.get("weighted_training", {})
    if weighted:
        print("\n" + "="*120)
        print("⚖️ WEIGHTED TRAINING: Emphasizing Dirty Samples to Fix Bias")
        print("="*120)
        print("\nStrategies tested:")
        print("  • uniform: No weighting (baseline)")
        print("  • exponential: weight = exp(10 × (1-SR)) - SR=0.95 gets 1.6x, SR=0.90 gets 2.7x")
        print("  • threshold_98: 5x weight for samples with SR < 0.98")
        print("  • progressive: Linear increase as SR drops (SR=0.98→3x, SR=0.96→5x)")
        print("  • squared: Quadratic emphasis on dirty samples")
        print()

        # Table 1: Prediction distribution by strategy
        print("📊 PREDICTION DISTRIBUTION BY STRATEGY:")
        print("  Does weighting shift predictions toward detecting dirty panels?")
        print()
        print("┌──────────────┬────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐")
        print("│  Test Plant  │  Strategy  │ Pred Mean│ Pred Std │ Pred Min │ Pred<98% │   MAE    │")
        print("├──────────────┼────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤")

        for plant, strategies in weighted.items():
            for i, (strategy, data) in enumerate(strategies.items()):
                plant_col = plant if i == 0 else ""
                pred_below_98 = data.get("pred_below_98_pct", 0)
                status = "✅" if pred_below_98 > 10 else "⚠️" if pred_below_98 > 5 else "  "
                print(f"│ {plant_col:<12} │ {strategy:<10} │ {data['pred_mean']:.4f}   │ {data['pred_std']:.4f}   │ {data['pred_min']:.4f}   │ {status}{pred_below_98:>5.1f}%  │ {data['mae']:.6f} │")
            print("├──────────────┼────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤")

        print("└──────────────┴────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘")
        print("  ✅ = >10% predictions below 0.98 (good spread), ⚠️ = 5-10%")

        # Table 2: Recall at different thresholds by strategy
        print("\n📊 RECALL BY STRATEGY AT SR < 0.98 THRESHOLD (with 1% buffer):")
        print("  How many dirty panels does each strategy catch?")
        print()
        print("┌──────────────┬────────────┬────────────────────────────┬────────────────────────────┐")
        print("│  Test Plant  │  Strategy  │   SR < 0.99 (1% dirty)     │   SR < 0.98 (2% dirty)     │")
        print("│              │            │  Prec   Recall   n_dirty   │  Prec   Recall   n_dirty   │")
        print("├──────────────┼────────────┼────────────────────────────┼────────────────────────────┤")

        for plant, strategies in weighted.items():
            for i, (strategy, data) in enumerate(strategies.items()):
                plant_col = plant if i == 0 else ""
                t99 = data.get("thresholds", {}).get(0.99, {})
                t98 = data.get("thresholds", {}).get(0.98, {})

                r99 = t99.get("recall_buf", 0) or 0
                p99 = t99.get("precision_buf", 0) or 0
                n99 = t99.get("n_dirty", 0)
                r98 = t98.get("recall_buf", 0) or 0
                p98 = t98.get("precision_buf", 0) or 0
                n98 = t98.get("n_dirty", 0)

                status_99 = "✅" if r99 > 0.7 else "⚠️" if r99 > 0.4 else "  "
                status_98 = "✅" if r98 > 0.5 else "⚠️" if r98 > 0.2 else "  "

                print(f"│ {plant_col:<12} │ {strategy:<10} │ {status_99}{p99:.2f}   {r99:.2f}      {n99:>4}   │ {status_98}{p98:.2f}   {r98:.2f}      {n98:>4}   │")
            print("├──────────────┼────────────┼────────────────────────────┼────────────────────────────┤")

        print("└──────────────┴────────────┴────────────────────────────┴────────────────────────────┘")

        # Summary: Best strategy per plant
        print("\n📋 BEST STRATEGY PER PLANT (by Recall at SR < 0.98):")
        print("-"*80)

        for plant, strategies in weighted.items():
            best_strategy = None
            best_recall = 0
            for strategy, data in strategies.items():
                t98 = data.get("thresholds", {}).get(0.98, {})
                recall = t98.get("recall_buf", 0) or 0
                if recall > best_recall:
                    best_recall = recall
                    best_strategy = strategy

            if best_recall > 0.3:
                print(f"  ✅ {plant}: {best_strategy} achieves {best_recall:.0%} recall at SR < 0.98")
            elif best_recall > 0:
                print(f"  ⚠️ {plant}: {best_strategy} achieves {best_recall:.0%} recall (still low)")
            else:
                print(f"  ❌ {plant}: No strategy achieves meaningful recall at SR < 0.98")

    # CatBoost Advanced Results
    catboost = physics_results.get("catboost_advanced", {})
    if catboost:
        print("\n" + "="*120)
        print("🐱 CATBOOST ADVANCED: Sample Weighting + Physics Hybrid + Quantile Regression")
        print("="*120)
        print("Approach naming: {model}_{weighting}")
        print("  Models:    reg = regression, q25 = quantile 25%, hybrid = 50% ML + 50% physics")
        print("  Weighting: none = uniform, exponential = exp(10×(1-SR)), progressive = linear increase")
        print("  Recall uses 1% buffer: predict dirty if SR < 0.99 to catch SR < 0.98 actual")
        print("  2-week: require 2 consecutive weeks flagged (reduces false positives)")
        print()

        for plant, data in catboost.items():
            source_str = ", ".join(data.get("source_plants", ["?"]))
            print(f"\n📊 {plant.upper()} (trained from: {source_str})")
            print(f"   Train: {data.get('n_train', 0)} samples | Test: {data.get('n_test', 0)} samples | "
                  f"Validation: {data.get('n_validation', 0)} samples")
            print(f"   Best config (by val MAE): {data.get('best_config', 'N/A')}")
            print("-"*120)

            configs = data.get("configs", {})
            if not configs:
                print("   No results available")
                continue

            # Print header (with 2-week columns)
            print("┌────────────┬────────────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐")
            print("│   Config   │    Approach    │   R²   │   MAE    │ Spearman │ Rec@98   │ Prec@98  │ Rec_2wk  │ Prec_2wk │")
            print("├────────────┼────────────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤")

            for config_name, config_data in configs.items():
                for approach, metrics in config_data.items():
                    if approach == "validation_mae":
                        continue
                    if not isinstance(metrics, dict):
                        continue

                    r2 = metrics.get("r2", 0)
                    mae = metrics.get("mae", 0)
                    spearman = metrics.get("spearman", 0)
                    prec = metrics.get("precision_98", 0)
                    recall = metrics.get("recall_98", 0)
                    prec_2wk = metrics.get("precision_2wk", 0)
                    recall_2wk = metrics.get("recall_2wk", 0)

                    r2_status = "✅" if r2 > 0.3 else "⚠️" if r2 > 0 else "❌"
                    rec_status = "✅" if recall > 0.3 else "⚠️" if recall > 0.1 else "  "
                    rec_2wk_status = "✅" if recall_2wk > 0.3 else "⚠️" if recall_2wk > 0.1 else "  "

                    print(f"│ {config_name:<10} │ {approach:<14} │{r2_status}{r2:>5.3f} │ {mae:.6f} │ {spearman:>8.4f} │{rec_status}{recall:>6.2%} │ {prec:>8.4f} │{rec_2wk_status}{recall_2wk:>6.2%} │ {prec_2wk:>8.4f} │")

                print("├────────────┼────────────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤")

            print("└────────────┴────────────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘")

        # Summary comparing standard vs 2-week detection
        print("\n📋 SUMMARY: Standard vs 2-Week Consecutive Detection")
        print("-"*100)
        print("  2-week requires 2 consecutive dirty predictions - reduces false positives but may miss short events")
        print()

        for plant, data in catboost.items():
            source_str = ", ".join(data.get("source_plants", ["?"]))
            configs = data.get("configs", {})
            best_approach = None
            best_recall = 0
            best_prec = 0
            best_recall_2wk = 0
            best_prec_2wk = 0
            best_config = None

            for config_name, config_data in configs.items():
                for approach, metrics in config_data.items():
                    if approach == "validation_mae" or not isinstance(metrics, dict):
                        continue
                    recall = metrics.get("recall_98", 0)
                    if recall > best_recall:
                        best_recall = recall
                        best_prec = metrics.get("precision_98", 0)
                        best_recall_2wk = metrics.get("recall_2wk", 0)
                        best_prec_2wk = metrics.get("precision_2wk", 0)
                        best_approach = approach
                        best_config = config_name

            if best_recall > 0:
                # Compare precision improvement
                prec_improvement = (best_prec_2wk - best_prec) / max(0.001, best_prec) * 100
                rec_loss = (best_recall - best_recall_2wk) / max(0.001, best_recall) * 100
                print(f"  {plant}: {best_config}/{best_approach}")
                print(f"    Standard:  Recall={best_recall:.0%}, Precision={best_prec:.2f}")
                print(f"    2-Week:    Recall={best_recall_2wk:.0%}, Precision={best_prec_2wk:.2f} (Prec {'+' if prec_improvement >= 0 else ''}{prec_improvement:.0f}%, Rec {'-' if rec_loss >= 0 else '+'}{abs(rec_loss):.0f}%)")
            else:
                print(f"  {plant}: No approach detects dirty panels")


def print_regional_transfer_results(regional_results: dict):
    """Print regional transfer learning experiment results."""

    if not regional_results:
        return

    print("\n" + "="*120)
    print("🌍 REGIONAL TRANSFER LEARNING EXPERIMENTS (Spanish Mediterranean Plants Only)")
    print("="*120)
    print("\nExcluded: alpha1 (bad data quality), epsilon (different climate region - Germany)")

    # Data cleaning summary
    cleaning = regional_results.get("data_cleaning", {})
    if cleaning:
        print("\n📋 DATA CLEANING:")
        print("-"*80)
        for plant, info in cleaning.items():
            status = info.get("status", "unknown")
            if status == "excluded":
                print(f"  ❌ {plant}: EXCLUDED - {info.get('reason', 'unknown')}")
            elif status == "excluded_regional":
                print(f"  ⚪ {plant}: Not used - {info.get('reason', 'unknown')}")
            elif status == "cleaned":
                print(f"  🧹 {plant}: Cleaned - removed {info.get('removed_pct', 0):.1f}% ({info.get('original_rows', 0)} → {info.get('cleaned_rows', 0)} rows)")
            else:
                print(f"  ✅ {plant}: OK - {info.get('cleaned_rows', 0)} rows")

    # Resolution comparison
    print("\n" + "-"*100)
    print("📊 TRANSFER LEARNING BY RESOLUTION (Train on ALL other Spanish plants → Test on THIS plant)")
    print("-"*100)
    print("┌──────────────┬────────────────────────────┬────────────────────────────┬────────────────────────────┐")
    print("│   Test Plant │         DAILY              │         WEEKLY             │         MONTHLY            │")
    print("│              ├────────┬─────────┬─────────┼────────┬─────────┬─────────┼────────┬─────────┬─────────┤")
    print("│              │   R²   │   MAE   │    n    │   R²   │   MAE   │    n    │   R²   │   MAE   │    n    │")
    print("├──────────────┼────────┼─────────┼─────────┼────────┼─────────┼─────────┼────────┼─────────┼─────────┤")

    daily = regional_results.get("regional_daily", {})
    weekly = regional_results.get("regional_weekly", {})
    monthly = regional_results.get("regional_monthly", {})

    all_plants = set(daily.keys()) | set(weekly.keys()) | set(monthly.keys())
    for plant in sorted(all_plants):
        d = daily.get(plant, {})
        w = weekly.get(plant, {})
        m = monthly.get(plant, {})

        d_r2 = f"{d.get('r2', 0):>6.4f}" if d else "   N/A"
        d_mae = f"{d.get('mae', 0):>7.4f}" if d else "    N/A"
        d_n = f"{d.get('test_samples', 0):>5}" if d else "  N/A"

        w_r2 = f"{w.get('r2', 0):>6.4f}" if w else "   N/A"
        w_mae = f"{w.get('mae', 0):>7.4f}" if w else "    N/A"
        w_n = f"{w.get('test_samples', 0):>5}" if w else "  N/A"

        m_r2 = f"{m.get('r2', 0):>6.4f}" if m else "   N/A"
        m_mae = f"{m.get('mae', 0):>7.4f}" if m else "    N/A"
        m_n = f"{m.get('test_samples', 0):>5}" if m else "  N/A"

        print(f"│ {plant:<12} │ {d_r2} │ {d_mae} │ {d_n} │ {w_r2} │ {w_mae} │ {w_n} │ {m_r2} │ {m_mae} │ {m_n} │")

    print("└──────────────┴────────┴─────────┴─────────┴────────┴─────────┴─────────┴────────┴─────────┴─────────┘")

    # Pairwise experiments
    pairwise = regional_results.get("pairwise_experiments", [])
    if pairwise:
        print("\n" + "-"*100)
        print("🔄 PAIRWISE TRANSFER (Weekly Resolution): Train on ONE plant → Test on ANOTHER")
        print("-"*100)

        # Group by test plant
        by_test = {}
        for exp in pairwise:
            test = exp["test_plant"]
            if test not in by_test:
                by_test[test] = []
            by_test[test].append(exp)

        # Create matrix header for R²
        train_plants = sorted(set(exp["train_plant"] for exp in pairwise))
        header = "│ Test \\ Train │" + "│".join(f" {p:^10} " for p in train_plants) + "│"
        separator = "├" + "─"*14 + "┼" + "┼".join("─"*12 for _ in train_plants) + "┤"

        print("┌" + "─"*14 + "┬" + "┬".join("─"*12 for _ in train_plants) + "┐")
        print(header)
        print(separator)

        for test_plant in sorted(by_test.keys()):
            row = f"│ {test_plant:<12} │"
            for train_plant in train_plants:
                if train_plant == test_plant:
                    row += "     -      │"
                else:
                    # Find this pair
                    pair = next((e for e in by_test[test_plant] if e["train_plant"] == train_plant), None)
                    if pair:
                        r2 = pair["r2"]
                        status = "✅" if r2 > 0.3 else "⚠️" if r2 > 0 else "❌"
                        row += f" {status}{r2:>6.3f}   │"
                    else:
                        row += "     N/A    │"
            print(row)

        print("└" + "─"*14 + "┴" + "┴".join("─"*12 for _ in train_plants) + "┘")
        print("\nLegend: ✅ R² > 0.3 (good) | ⚠️ R² > 0 (weak) | ❌ R² < 0 (fails)")

        # Detailed pairwise table with MAE breakdown
        print("\n" + "-"*140)
        print("📊 DETAILED PAIRWISE TRANSFER WITH MAE BY TREND:")
        print("-"*140)
        print("┌─────────────────────────────┬────────┬──────────┬──────────┬──────────┬──────────┬────────────────┐")
        print("│ Source → Target             │   R²   │ MAE Tot  │  MAE ↓   │  MAE ↑   │ MAE Stab │ Direction Acc  │")
        print("├─────────────────────────────┼────────┼──────────┼──────────┼──────────┼──────────┼────────────────┤")

        # Sort by R² descending
        sorted_pairs = sorted(pairwise, key=lambda x: x["r2"], reverse=True)
        for exp in sorted_pairs:
            source = exp["train_plant"]
            target = exp["test_plant"]
            r2 = exp["r2"]
            mae = exp["mae"]
            mae_d = exp.get("mae_downward")
            mae_u = exp.get("mae_upward")
            mae_s = exp.get("mae_stable")
            dir_acc = exp.get("direction_accuracy")

            r2_status = "✅" if r2 > 0.3 else "⚠️" if r2 > 0 else "❌"
            mae_d_str = f"{mae_d:.6f}" if mae_d else "   N/A   "
            mae_u_str = f"{mae_u:.6f}" if mae_u else "   N/A   "
            mae_s_str = f"{mae_s:.6f}" if mae_s else "   N/A   "
            dir_acc_str = f"{dir_acc*100:>12.1f}%" if dir_acc else "      N/A     "

            print(f"│ {source:<12} → {target:<12} │ {r2_status}{r2:>5.3f} │ {mae:.6f} │ {mae_d_str} │ {mae_u_str} │ {mae_s_str} │ {dir_acc_str} │")

        print("└─────────────────────────────┴────────┴──────────┴──────────┴──────────┴──────────┴────────────────┘")
        print("  ↓ = Soiling (SR decreasing) | ↑ = Recovery (SR increasing) | Stab = Stable (|ΔSR| < 0.2%)")

    # Summary statistics
    print("\n" + "-"*100)
    print("📈 SUMMARY")
    print("-"*100)

    for resolution, data in [("Daily", daily), ("Weekly", weekly), ("Monthly", monthly)]:
        if data:
            r2s = [v["r2"] for v in data.values()]
            maes = [v["mae"] for v in data.values()]
            positive_r2 = sum(1 for r2 in r2s if r2 > 0)
            print(f"  {resolution:8}: Avg R² = {np.mean(r2s):>7.4f} | Avg MAE = {np.mean(maes):>7.4f} | Positive R²: {positive_r2}/{len(r2s)} plants")

    # Best pairs
    if pairwise:
        best = sorted(pairwise, key=lambda x: x["r2"], reverse=True)[:5]
        print("\n  🏆 Best transfer pairs (weekly):")
        for exp in best:
            status = "✅" if exp["r2"] > 0.3 else "⚠️" if exp["r2"] > 0 else "❌"
            print(f"    {status} {exp['train_plant']} → {exp['test_plant']}: R²={exp['r2']:.4f}, MAE={exp['mae']:.6f}")


def calculate_per_plant_model_metrics(
    all_plant_data: list[pl.DataFrame],
) -> dict:
    """
    Calculate comprehensive model metrics per plant and combined.

    Includes:
    - Overall metrics (R², RMSE, MAE)
    - Segmented metrics by SR direction (soiling, recovery, stable)
    """
    try:
        import lightgbm as lgb
        from sklearn.metrics import r2_score, mean_squared_error, mean_absolute_error
    except ImportError:
        logger.warning("LightGBM/sklearn not available, skipping per-plant metrics")
        return {}

    # Features to use
    feature_cols = [
        "precip_7d", "precip_14d", "precip_30d", "rain_max_7d", "rain_events_30d",
        "days_since_rain_1mm", "days_since_rain_5mm",
        "temp_mean_7d", "temp_range_7d",
        "humidity_mean_7d",
        "wind_mean_7d", "wind_max_7d",
        "aod_total_7d", "aod_total_14d", "dust_7d", "pm10_7d", "pm25_7d",
        "aod_accum_since_rain",
        "aod_x_humidity", "aod_x_no_rain_days", "wind_x_dust",
        "day_of_year", "is_dry_season",
        "dew_potential_7d",
    ]

    results = {
        "per_plant": {},
        "combined": {},
        "cross_plant_validation": {},
    }

    # LightGBM parameters
    params = {
        "objective": "regression",
        "metric": "rmse",
        "verbosity": -1,
        "n_estimators": 100,
        "max_depth": 5,
        "learning_rate": 0.1,
    }

    def calculate_segmented_metrics(y_true, y_pred, soiling_rate):
        """Calculate metrics segmented by SR direction."""
        metrics = {}

        # Overall metrics
        metrics["overall"] = {
            "r2": round(r2_score(y_true, y_pred), 4),
            "rmse": round(np.sqrt(mean_squared_error(y_true, y_pred)), 6),
            "mae": round(mean_absolute_error(y_true, y_pred), 6),
            "n_samples": len(y_true),
        }

        # Define thresholds for SR direction
        # Soiling: SR decreasing (negative rate) - dust accumulating
        # Recovery: SR increasing (positive rate) - rain cleaning
        # Stable: SR roughly constant
        stable_threshold = 0.002  # ~0.2% daily change

        soiling_mask = soiling_rate < -stable_threshold
        recovery_mask = soiling_rate > stable_threshold
        stable_mask = np.abs(soiling_rate) <= stable_threshold

        for name, mask in [("soiling", soiling_mask), ("recovery", recovery_mask), ("stable", stable_mask)]:
            if mask.sum() > 10:
                y_t = y_true[mask]
                y_p = y_pred[mask]
                metrics[name] = {
                    "r2": round(r2_score(y_t, y_p), 4) if len(np.unique(y_t)) > 1 else None,
                    "rmse": round(np.sqrt(mean_squared_error(y_t, y_p)), 6),
                    "mae": round(mean_absolute_error(y_t, y_p), 6),
                    "n_samples": int(mask.sum()),
                    "pct_of_data": round(mask.sum() / len(y_true) * 100, 1),
                }
            else:
                metrics[name] = {"n_samples": int(mask.sum()), "pct_of_data": round(mask.sum() / len(y_true) * 100, 1)}

        return metrics

    # Per-plant models
    logger.info("\nTraining per-plant models...")
    for df in all_plant_data:
        plant = df["plant"][0] if "plant" in df.columns else "unknown"

        # Filter to available columns
        available_cols = [c for c in feature_cols if c in df.columns]

        # Prepare data
        df_clean = df.select(["sr_dustiq", "soiling_rate"] + available_cols).drop_nulls()

        if df_clean.height < 50:
            logger.warning(f"  {plant}: Not enough data ({df_clean.height} samples)")
            continue

        X = df_clean.select(available_cols).to_numpy()
        y = df_clean["sr_dustiq"].to_numpy()
        soiling_rate = df_clean["soiling_rate"].to_numpy()

        # Train model
        model = lgb.LGBMRegressor(**params)
        model.fit(X, y)
        y_pred = model.predict(X)

        # Calculate segmented metrics
        metrics = calculate_segmented_metrics(y, y_pred, soiling_rate)
        metrics["plant_name"] = PLANT_CONFIG.get(plant, {}).get("name", plant)
        metrics["features_used"] = len(available_cols)
        metrics["has_aod"] = any("aod" in c or "dust" in c or "pm" in c for c in available_cols)

        results["per_plant"][plant] = metrics
        logger.info(f"  {plant}: R²={metrics['overall']['r2']:.4f}, MAE={metrics['overall']['mae']:.6f}")

    # Combined model (all plants)
    logger.info("\nTraining combined model...")
    combined_df = pl.concat(all_plant_data)
    available_cols = [c for c in feature_cols if c in combined_df.columns]
    df_clean = combined_df.select(["sr_dustiq", "soiling_rate", "plant"] + available_cols).drop_nulls()

    if df_clean.height >= 100:
        X = df_clean.select(available_cols).to_numpy()
        y = df_clean["sr_dustiq"].to_numpy()
        soiling_rate = df_clean["soiling_rate"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X, y)
        y_pred = model.predict(X)

        results["combined"] = calculate_segmented_metrics(y, y_pred, soiling_rate)
        results["combined"]["features_used"] = len(available_cols)
        logger.info(f"  Combined: R²={results['combined']['overall']['r2']:.4f}, MAE={results['combined']['overall']['mae']:.6f}")

    # Leave-one-plant-out cross-validation (transfer learning readiness)
    logger.info("\nRunning leave-one-plant-out cross-validation...")
    for test_plant_df in all_plant_data:
        test_plant = test_plant_df["plant"][0] if "plant" in test_plant_df.columns else "unknown"

        # Train on all other plants
        train_dfs = [df for df in all_plant_data if df["plant"][0] != test_plant]
        if not train_dfs:
            continue

        train_df = pl.concat(train_dfs)
        available_cols = [c for c in feature_cols if c in train_df.columns and c in test_plant_df.columns]

        train_clean = train_df.select(["sr_dustiq", "soiling_rate"] + available_cols).drop_nulls()
        test_clean = test_plant_df.select(["sr_dustiq", "soiling_rate"] + available_cols).drop_nulls()

        if train_clean.height < 50 or test_clean.height < 30:
            continue

        X_train = train_clean.select(available_cols).to_numpy()
        y_train = train_clean["sr_dustiq"].to_numpy()
        X_test = test_clean.select(available_cols).to_numpy()
        y_test = test_clean["sr_dustiq"].to_numpy()
        soiling_rate_test = test_clean["soiling_rate"].to_numpy()

        model = lgb.LGBMRegressor(**params)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        metrics = calculate_segmented_metrics(y_test, y_pred, soiling_rate_test)
        results["cross_plant_validation"][test_plant] = metrics
        logger.info(f"  {test_plant} (transfer): R²={metrics['overall']['r2']:.4f}, MAE={metrics['overall']['mae']:.6f}")

    return results


def calculate_feature_importance(all_data: pl.DataFrame) -> dict:
    """Train LightGBM model and extract feature importance."""
    try:
        import lightgbm as lgb
    except ImportError:
        logger.warning("LightGBM not available, skipping feature importance")
        return {}

    # Features to use
    feature_cols = [
        "precip_7d", "precip_14d", "precip_30d", "rain_max_7d", "rain_events_30d",
        "days_since_rain_1mm", "days_since_rain_5mm",
        "temp_mean_7d", "temp_range_7d",
        "humidity_mean_7d",
        "wind_mean_7d", "wind_max_7d",
        "aod_total_7d", "aod_total_14d", "dust_7d", "pm10_7d", "pm25_7d",
        "aod_accum_since_rain",
        "aod_x_humidity", "aod_x_no_rain_days", "wind_x_dust",
        "day_of_year", "is_dry_season",
        # Digital twin features (DC current/voltage analysis)
        "current_cv",  # Current coefficient of variation (low = uniform soiling)
        "voltage_cv",  # Voltage coefficient of variation
        "current_loss_pct",  # Estimated current loss %
        "soiling_signature",  # Composite: low CV + good current = soiling
        # Inverter temperature features
        "inv_temp_mean",  # Average inverter temperature
        "inv_temp_max",   # Max inverter temperature
    ]

    # Filter to available columns
    available_cols = [c for c in feature_cols if c in all_data.columns]

    # Prepare data
    df = all_data.select(["sr_dustiq"] + available_cols).drop_nulls()

    if df.height < 100:
        logger.warning("Not enough data for feature importance analysis")
        return {}

    X = df.select(available_cols).to_numpy()
    y = df["sr_dustiq"].to_numpy()

    # Train model
    params = {
        "objective": "regression",
        "metric": "rmse",
        "verbosity": -1,
        "n_estimators": 100,
        "max_depth": 5,
        "learning_rate": 0.1,
    }

    model = lgb.LGBMRegressor(**params)
    model.fit(X, y)

    # Extract importance
    importance = dict(zip(available_cols, model.feature_importances_.tolist()))

    # Sort by importance
    importance = dict(sorted(importance.items(), key=lambda x: x[1], reverse=True))

    # Calculate R² score
    from sklearn.metrics import r2_score, mean_squared_error
    y_pred = model.predict(X)
    r2 = r2_score(y, y_pred)
    rmse = np.sqrt(mean_squared_error(y, y_pred))

    return {
        "feature_importance": importance,
        "model_r2": round(r2, 4),
        "model_rmse": round(rmse, 6),
        "n_samples": df.height,
        "n_features": len(available_cols),
    }


# =============================================================================
# Main Analysis Pipeline
# =============================================================================


def run_analysis(
    plants: Optional[list[str]] = None,
    skip_aod_download: bool = False,
) -> dict:
    """Run the full DustIQ quality and correlation analysis."""

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if plants is None:
        plants = list(PLANT_CONFIG.keys())

    logger.info(f"Analyzing {len(plants)} plants: {plants}")

    # Collect results
    quality_results = []
    correlation_results = []
    lagged_correlation_results = []
    cleaning_summaries = []  # NEW: Cleaning event detection
    all_plant_data = []

    for plant_key in plants:
        logger.info(f"\n{'='*60}")
        logger.info(f"Processing {plant_key}")
        logger.info(f"{'='*60}")

        # Load parquet data
        df = load_plant_parquet(plant_key)
        if df is None or df.height == 0:
            logger.warning(f"Skipping {plant_key} - no data")
            continue

        # Extract daily DustIQ
        daily_df = extract_dustiq_daily(df, plant_key)
        if daily_df.height == 0:
            logger.warning(f"Skipping {plant_key} - no DustIQ data extracted")
            continue

        logger.info(f"  Extracted {daily_df.height} daily records")

        # Get date range for weather/AOD fetching
        date_range = (daily_df["date"].min(), daily_df["date"].max())
        logger.info(f"  Date range: {date_range[0]} to {date_range[1]}")

        # Fetch weather data (with delay to avoid rate limiting)
        import time
        weather_df = load_or_fetch_weather(plant_key, date_range)
        time.sleep(0.5)  # Delay between API calls

        # Fetch AOD data (try cache first, then fetch if not skipping)
        aod_df = None
        cache_path = AOD_DIR / f"{plant_key}_aod.parquet"
        if cache_path.exists():
            logger.info(f"  Loading cached AOD for {plant_key}")
            aod_df = pl.read_parquet(cache_path)
        elif not skip_aod_download:
            aod_df = load_or_fetch_aod(plant_key, date_range)

        # Merge data
        merged_df = daily_df

        if weather_df is not None:
            merged_df = merged_df.join(weather_df, on="date", how="left")
            logger.info(f"  Merged weather data")
        else:
            logger.warning(f"  No weather data available for {plant_key}")

        if aod_df is not None:
            merged_df = merged_df.join(aod_df, on="date", how="left")
            logger.info(f"  Merged AOD data")
        else:
            logger.warning(f"  No AOD data available for {plant_key}")

        # Extract digital twin features (DC current/voltage CV, loss %)
        twin_df = extract_digital_twin_features(plant_key)
        if twin_df is not None:
            merged_df = merged_df.join(twin_df, on="date", how="left")
            logger.info(f"  Merged digital twin features ({len(twin_df.columns)-1} features)")
        else:
            # Add placeholder columns for missing twin features (to ensure consistent schema)
            logger.info(f"  No digital twin features available for {plant_key} - adding placeholders")
            # Float64 columns (including inverter temperature)
            float_cols = ["current_cv", "voltage_cv", "current_mean", "current_loss_pct",
                         "soiling_signature", "inv_temp_mean", "inv_temp_max"]
            for col in float_cols:
                merged_df = merged_df.with_columns(pl.lit(None).cast(pl.Float64).alias(col))
            # UInt32 column for count
            merged_df = merged_df.with_columns(pl.lit(None).cast(pl.UInt32).alias("twin_readings_count"))

        # Engineer features
        merged_df = engineer_features(merged_df)
        logger.info(f"  Engineered {len(merged_df.columns)} features")

        # Detect cleaning events (rain/manual cleaning)
        merged_df = detect_cleaning_events(merged_df)
        cleaning_summary = summarize_cleaning_events(merged_df, plant_key)
        cleaning_summaries.append(cleaning_summary)
        if cleaning_summary.get("cleaning_events", 0) > 0:
            logger.info(f"  Detected {cleaning_summary['cleaning_events']} cleaning events "
                       f"({cleaning_summary['rain_cleanings']} rain, {cleaning_summary['manual_cleanings']} manual)")
            logger.info(f"  Avg soiling period: {cleaning_summary.get('avg_soiling_period_days', 'N/A')} days")

        # Calculate quality metrics
        quality = calculate_quality_metrics(merged_df, plant_key)
        quality_results.append(quality)
        logger.info(f"  Quality: {quality['coverage_pct']:.1f}% coverage, "
                   f"mean SR={quality['mean_sr']:.4f}")

        # Calculate correlations
        correlations = calculate_correlations(merged_df, plant_key)
        correlation_results.append(correlations)

        # Calculate lagged correlations
        lagged_corrs = calculate_lagged_correlations(merged_df, plant_key)
        lagged_correlation_results.append(lagged_corrs)

        # Store for combined analysis
        all_plant_data.append(merged_df)

    # Combine all data for feature importance
    logger.info(f"\n{'='*60}")
    logger.info("Computing feature importance across all plants")
    logger.info(f"{'='*60}")

    if all_plant_data:
        combined_df = pl.concat(all_plant_data)
        feature_importance = calculate_feature_importance(combined_df)
    else:
        feature_importance = {}

    # Calculate comprehensive per-plant model metrics
    logger.info(f"\n{'='*60}")
    logger.info("Computing comprehensive model metrics per plant")
    logger.info(f"{'='*60}")

    if all_plant_data:
        model_metrics = calculate_per_plant_model_metrics(all_plant_data)
    else:
        model_metrics = {}

    # Calculate improved transfer learning approaches
    logger.info(f"\n{'='*60}")
    logger.info("Computing IMPROVED transfer learning approaches")
    logger.info(f"{'='*60}")

    if all_plant_data:
        improved_transfer = calculate_improved_transfer_learning(all_plant_data)
    else:
        improved_transfer = {}

    # Calculate regional transfer experiments (Spanish plants only, cleaned data)
    logger.info(f"\n{'='*60}")
    logger.info("Computing REGIONAL transfer experiments (Spanish plants, cleaned)")
    logger.info(f"{'='*60}")

    if all_plant_data:
        regional_transfer = calculate_regional_transfer_experiments(all_plant_data)
    else:
        regional_transfer = {}

    # Calculate physics-informed evaluation with better metrics
    logger.info(f"\n{'='*60}")
    logger.info("Computing PHYSICS-INFORMED evaluation (Better Metrics)")
    logger.info(f"{'='*60}")

    if all_plant_data:
        physics_evaluation = calculate_physics_informed_evaluation(all_plant_data)
    else:
        physics_evaluation = {}

    # Prepare output
    results = {
        "analysis_timestamp": datetime.now().isoformat(),
        "plants_analyzed": plants,
        "quality_metrics": quality_results,
        "correlations": correlation_results,
        "lagged_correlations": lagged_correlation_results,
        "cleaning_events": cleaning_summaries,  # NEW: Cleaning detection
        "feature_importance": feature_importance,
        "model_metrics": model_metrics,
        "improved_transfer_learning": improved_transfer,
        "regional_transfer_experiments": regional_transfer,
        "physics_evaluation": physics_evaluation,
    }

    # Save results
    output_path = OUTPUT_DIR / "dustiq_quality_report.json"
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2, default=str)
    logger.info(f"\nResults saved to {output_path}")

    # Save correlation matrix as CSV
    if correlation_results:
        corr_df = pl.DataFrame(correlation_results)
        corr_path = OUTPUT_DIR / "dustiq_correlation_matrix.csv"
        corr_df.write_csv(corr_path)
        logger.info(f"Correlation matrix saved to {corr_path}")

    # Generate visualizations
    generate_visualizations(results, all_plant_data, OUTPUT_DIR)

    # Print summary
    print_summary(results)

    return results


def print_cleaning_events_summary(cleaning_events: list):
    """Print summary of cleaning event detection across all plants."""

    print("\n" + "="*120)
    print("🧹 CLEANING EVENT DETECTION SUMMARY")
    print("="*120)
    print("\nDetecting cleaning events based on sudden SR increases (>1% jump in one day).")
    print("This helps identify soiling periods for better model training and validation.")
    print()

    print("┌──────────────┬──────────┬────────────┬────────────┬────────────┬──────────────┬───────────────┬───────────────┐")
    print("│    Plant     │  Total   │  Cleaning  │ Rain-Based │   Manual   │ Avg Period   │ SR Before    │ SR After      │")
    print("│              │  Days    │   Events   │  Cleanings │  Cleanings │   (days)     │ Cleaning     │ Cleaning      │")
    print("├──────────────┼──────────┼────────────┼────────────┼────────────┼──────────────┼───────────────┼───────────────┤")

    for ce in cleaning_events:
        if not ce:
            continue
        plant = ce.get("plant", "unknown")
        total = ce.get("total_days", 0)
        events = ce.get("cleaning_events", 0)
        rain = ce.get("rain_cleanings", 0)
        manual = ce.get("manual_cleanings", 0)
        period = ce.get("avg_soiling_period_days")
        sr_before = ce.get("avg_sr_before_cleaning")
        sr_after = ce.get("avg_sr_after_cleaning")

        period_str = f"{period:.1f}" if period else "N/A"
        sr_before_str = f"{sr_before:.4f}" if sr_before else "N/A"
        sr_after_str = f"{sr_after:.4f}" if sr_after else "N/A"

        print(f"│ {plant:<12} │ {total:>8} │ {events:>10} │ {rain:>10} │ {manual:>10} │ {period_str:>12} │ {sr_before_str:>13} │ {sr_after_str:>13} │")

    print("└──────────────┴──────────┴────────────┴────────────┴────────────┴──────────────┴───────────────┴───────────────┘")

    # Summary stats
    total_events = sum(ce.get("cleaning_events", 0) for ce in cleaning_events if ce)
    total_rain = sum(ce.get("rain_cleanings", 0) for ce in cleaning_events if ce)
    total_manual = sum(ce.get("manual_cleanings", 0) for ce in cleaning_events if ce)
    avg_periods = [ce.get("avg_soiling_period_days") for ce in cleaning_events if ce and ce.get("avg_soiling_period_days")]

    print(f"\n  Total cleaning events detected: {total_events}")
    print(f"  Rain-based cleanings: {total_rain} ({total_rain/total_events*100:.0f}%)" if total_events > 0 else "")
    print(f"  Manual cleanings: {total_manual} ({total_manual/total_events*100:.0f}%)" if total_events > 0 else "")
    if avg_periods:
        print(f"  Average soiling period: {np.mean(avg_periods):.1f} days across all plants")

    print("\n💡 IMPLICATIONS FOR TRANSFER LEARNING:")
    print("  • Longer soiling periods → more predictable soiling rates")
    print("  • Frequent rain cleanings → need to consider rain impact in model")
    print("  • Manual cleanings → introduces scheduling bias in data")


def print_summary(results: dict):
    """Print a summary of the analysis results."""

    print("\n" + "="*100)
    print("DUSTIQ QUALITY ANALYSIS SUMMARY")
    print("="*100)

    # Quality summary
    print("\n📊 DATA QUALITY BY PLANT:")
    print("-" * 60)
    print(f"{'Plant':<15} {'Coverage':<10} {'Mean SR':<10} {'Outliers':<10} {'Max Gap':<10}")
    print("-" * 60)

    for q in results["quality_metrics"]:
        print(f"{q['plant']:<15} {q['coverage_pct']:>7.1f}% {q['mean_sr']:>9.4f} "
              f"{q['outlier_pct']:>8.1f}% {q['max_gap_days']:>7} days")

    # Top correlations
    if results["correlations"]:
        print("\n📈 TOP CORRELATIONS WITH SOILING RATIO:")
        print("-" * 60)

        # Aggregate correlations across plants
        all_corrs = {}
        for plant_corr in results["correlations"]:
            for key, val in plant_corr.items():
                if key != "plant" and val is not None and "_pearson" in key:
                    feature = key.replace("_pearson", "")
                    if feature not in all_corrs:
                        all_corrs[feature] = []
                    all_corrs[feature].append(val)

        # Calculate mean absolute correlation
        mean_corrs = {k: np.mean(np.abs(v)) for k, v in all_corrs.items()}
        sorted_corrs = sorted(mean_corrs.items(), key=lambda x: x[1], reverse=True)[:10]

        for feature, corr in sorted_corrs:
            print(f"  {feature:<30} {corr:>8.4f}")

    # Feature importance
    if results["feature_importance"].get("feature_importance"):
        print("\n🎯 TOP FEATURE IMPORTANCE (LightGBM):")
        print("-" * 60)

        importance = results["feature_importance"]["feature_importance"]
        for i, (feature, imp) in enumerate(list(importance.items())[:10]):
            print(f"  {i+1:>2}. {feature:<30} {imp:>8.1f}")

        print(f"\n  Model R²: {results['feature_importance']['model_r2']:.4f}")
        print(f"  Model RMSE: {results['feature_importance']['model_rmse']:.6f}")

    # Cleaning Event Detection Summary
    if results.get("cleaning_events"):
        print_cleaning_events_summary(results["cleaning_events"])

    # Comprehensive Model Metrics Matrix
    if results.get("model_metrics", {}).get("per_plant"):
        print_model_metrics_matrix(results["model_metrics"])

    # Improved Transfer Learning
    if results.get("improved_transfer_learning"):
        print_improved_transfer_learning(results["improved_transfer_learning"])

    # Regional Transfer Experiments (Spanish plants, cleaned data)
    if results.get("regional_transfer_experiments"):
        print_regional_transfer_results(results["regional_transfer_experiments"])

    # Physics-informed evaluation with better metrics
    if results.get("physics_evaluation"):
        print_physics_evaluation_results(results["physics_evaluation"])

    print("\n" + "="*100)


def print_model_metrics_matrix(model_metrics: dict):
    """Print comprehensive model metrics matrix."""

    print("\n" + "="*100)
    print("📊 COMPREHENSIVE MODEL METRICS MATRIX")
    print("="*100)

    # Per-plant metrics table
    print("\n┌─────────────────────────────────────────────────────────────────────────────────────────────────┐")
    print("│                              PER-PLANT MODEL PERFORMANCE (Train on Same Plant)                  │")
    print("├──────────────┬────────┬──────────┬──────────┬─────────────────────────────────────────────────────┤")
    print("│              │        │          │          │           SEGMENTED BY SR DIRECTION                │")
    print("│    Plant     │   R²   │   RMSE   │   MAE    ├─────────────────┬─────────────────┬─────────────────┤")
    print("│              │        │          │          │ SOILING (↓)     │ RECOVERY (↑)    │ STABLE (→)      │")
    print("├──────────────┼────────┼──────────┼──────────┼─────────────────┼─────────────────┼─────────────────┤")

    for plant, metrics in model_metrics.get("per_plant", {}).items():
        overall = metrics.get("overall", {})
        soiling = metrics.get("soiling", {})
        recovery = metrics.get("recovery", {})
        stable = metrics.get("stable", {})

        # Format segmented metrics
        def fmt_segment(seg):
            if seg.get("mae") is not None:
                return f"MAE:{seg['mae']:.4f} ({seg.get('pct_of_data', 0):.0f}%)"
            return f"n={seg.get('n_samples', 0)} ({seg.get('pct_of_data', 0):.0f}%)"

        print(f"│ {plant:<12} │ {overall.get('r2', 0):.4f} │ {overall.get('rmse', 0):.6f} │ {overall.get('mae', 0):.6f} │ {fmt_segment(soiling):<15} │ {fmt_segment(recovery):<15} │ {fmt_segment(stable):<15} │")

    print("└──────────────┴────────┴──────────┴──────────┴─────────────────┴─────────────────┴─────────────────┘")

    # Combined model metrics
    combined = model_metrics.get("combined", {})
    if combined:
        print("\n┌─────────────────────────────────────────────────────────────────────────────────────────────────┐")
        print("│                              COMBINED MODEL (All Plants Together)                               │")
        print("├──────────────┬────────┬──────────┬──────────┬─────────────────┬─────────────────┬─────────────────┤")
        overall = combined.get("overall", {})
        soiling = combined.get("soiling", {})
        recovery = combined.get("recovery", {})
        stable = combined.get("stable", {})

        def fmt_segment(seg):
            if seg.get("mae") is not None:
                return f"MAE:{seg['mae']:.4f} ({seg.get('pct_of_data', 0):.0f}%)"
            return f"n={seg.get('n_samples', 0)}"

        print(f"│ {'COMBINED':<12} │ {overall.get('r2', 0):.4f} │ {overall.get('rmse', 0):.6f} │ {overall.get('mae', 0):.6f} │ {fmt_segment(soiling):<15} │ {fmt_segment(recovery):<15} │ {fmt_segment(stable):<15} │")
        print("└──────────────┴────────┴──────────┴──────────┴─────────────────┴─────────────────┴─────────────────┘")

    # Transfer learning (leave-one-plant-out) metrics
    cross_val = model_metrics.get("cross_plant_validation", {})
    if cross_val:
        print("\n┌─────────────────────────────────────────────────────────────────────────────────────────────────┐")
        print("│                    TRANSFER LEARNING (Leave-One-Plant-Out Cross-Validation)                    │")
        print("│                         Train on OTHER plants, Test on THIS plant                              │")
        print("├──────────────┬────────┬──────────┬──────────┬─────────────────┬─────────────────┬─────────────────┤")
        print("│   Test Plant │   R²   │   RMSE   │   MAE    │ SOILING (↓)     │ RECOVERY (↑)    │ STABLE (→)      │")
        print("├──────────────┼────────┼──────────┼──────────┼─────────────────┼─────────────────┼─────────────────┤")

        for plant, metrics in cross_val.items():
            overall = metrics.get("overall", {})
            soiling = metrics.get("soiling", {})
            recovery = metrics.get("recovery", {})
            stable = metrics.get("stable", {})

            def fmt_segment(seg):
                if seg.get("mae") is not None:
                    return f"MAE:{seg['mae']:.4f} ({seg.get('pct_of_data', 0):.0f}%)"
                return f"n={seg.get('n_samples', 0)} ({seg.get('pct_of_data', 0):.0f}%)"

            print(f"│ {plant:<12} │ {overall.get('r2', 0):.4f} │ {overall.get('rmse', 0):.6f} │ {overall.get('mae', 0):.6f} │ {fmt_segment(soiling):<15} │ {fmt_segment(recovery):<15} │ {fmt_segment(stable):<15} │")

        print("└──────────────┴────────┴──────────┴──────────┴─────────────────┴─────────────────┴─────────────────┘")

    # Summary statistics
    print("\n📋 SUMMARY:")
    print("-" * 60)

    if model_metrics.get("per_plant"):
        per_plant = model_metrics["per_plant"]
        avg_r2 = np.mean([m["overall"]["r2"] for m in per_plant.values() if m.get("overall", {}).get("r2")])
        avg_mae = np.mean([m["overall"]["mae"] for m in per_plant.values() if m.get("overall", {}).get("mae")])
        print(f"  Per-Plant Avg R²:  {avg_r2:.4f}")
        print(f"  Per-Plant Avg MAE: {avg_mae:.6f}")

    if cross_val:
        avg_r2_transfer = np.mean([m["overall"]["r2"] for m in cross_val.values() if m.get("overall", {}).get("r2")])
        avg_mae_transfer = np.mean([m["overall"]["mae"] for m in cross_val.values() if m.get("overall", {}).get("mae")])
        print(f"  Transfer Avg R²:   {avg_r2_transfer:.4f}")
        print(f"  Transfer Avg MAE:  {avg_mae_transfer:.6f}")

        # R² degradation from per-plant to transfer
        if model_metrics.get("per_plant"):
            r2_degradation = avg_r2 - avg_r2_transfer
            print(f"  R² Degradation (transfer vs per-plant): {r2_degradation:.4f} ({r2_degradation/avg_r2*100:.1f}%)")


def print_improved_transfer_learning(improved_transfer: dict):
    """Print improved transfer learning results with clear train/test documentation."""

    if not improved_transfer or not improved_transfer.get("approaches"):
        return

    print("\n" + "="*120)
    print("🔬 IMPROVED TRANSFER LEARNING APPROACHES")
    print("="*120)
    print("\nObjective: Train on OTHER plants → Predict on THIS plant (leave-one-plant-out)")

    # =========================================================================
    # Approach 1: Normalized SR (Z-score)
    # =========================================================================
    norm_sr = improved_transfer.get("approaches", {}).get("normalized_sr", {})
    if norm_sr.get("transfer"):
        print("\n" + "-"*100)
        print("📊 APPROACH 1: NORMALIZED SOILING RATIO (Z-score per plant)")
        print("-"*100)
        print("Method: Convert SR to z-scores (mean=0, std=1) per plant to remove plant-specific bias.")
        print("Target: Predict normalized SR, then convert back to original scale.")
        print()
        print("┌──────────────┬─────────────────────────────────┬──────────────────────────────────────────────────────┐")
        print("│   Test Plant │        Normalized Metrics       │              Original Scale Metrics                  │")
        print("│              ├────────┬──────────┬─────────────┼────────┬──────────┬─────────────┬────────────────────┤")
        print("│              │   R²   │   RMSE   │     MAE     │   R²   │   RMSE   │     MAE     │  Train Plants      │")
        print("├──────────────┼────────┼──────────┼─────────────┼────────┼──────────┼─────────────┼────────────────────┤")

        for plant, data in norm_sr["transfer"].items():
            norm_m = data.get("normalized_metrics", {})
            orig_m = data.get("original_scale_metrics", {})
            train_plants = ", ".join(data.get("train_plants", []))[:18]

            print(f"│ {plant:<12} │ {norm_m.get('r2', 0):>6.4f} │ {norm_m.get('rmse', 0):>8.6f} │ {norm_m.get('mae', 0):>11.6f} │ "
                  f"{orig_m.get('r2', 0):>6.4f} │ {orig_m.get('rmse', 0):>8.6f} │ {orig_m.get('mae', 0):>11.6f} │ {train_plants:<18} │")

        print("└──────────────┴────────┴──────────┴─────────────┴────────┴──────────┴─────────────┴────────────────────┘")

        # Summary stats
        orig_r2s = [d["original_scale_metrics"]["r2"] for d in norm_sr["transfer"].values() if d.get("original_scale_metrics")]
        if orig_r2s:
            print(f"\n  📈 Average Original R²: {np.mean(orig_r2s):.4f} (vs baseline transfer: negative R²)")

    # =========================================================================
    # Approach 2: Soiling Rate Prediction
    # =========================================================================
    soiling_rate = improved_transfer.get("approaches", {}).get("soiling_rate", {})
    if soiling_rate.get("transfer"):
        print("\n" + "-"*100)
        print("📊 APPROACH 2: SOILING RATE PREDICTION (daily SR change)")
        print("-"*100)
        print("Method: Predict daily SR change (soiling_rate = today's SR - yesterday's SR) instead of absolute SR.")
        print("Target: Soiling rate (negative = dust accumulation, positive = rain cleaning)")
        print()
        print("┌──────────────┬────────┬──────────┬─────────────┬───────────────┬───────────────┬────────────────────┐")
        print("│   Test Plant │   R²   │   RMSE   │     MAE     │   Rate Mean   │   Rate Std    │  Train Plants      │")
        print("├──────────────┼────────┼──────────┼─────────────┼───────────────┼───────────────┼────────────────────┤")

        for plant, data in soiling_rate["transfer"].items():
            m = data.get("metrics", {})
            train_plants = ", ".join(data.get("train_plants", []))[:18]

            print(f"│ {plant:<12} │ {m.get('r2', 0):>6.4f} │ {m.get('rmse', 0):>8.6f} │ {m.get('mae', 0):>11.6f} │ "
                  f"{data.get('rate_mean', 0):>13.6f} │ {data.get('rate_std', 0):>13.6f} │ {train_plants:<18} │")

        print("└──────────────┴────────┴──────────┴─────────────┴───────────────┴───────────────┴────────────────────┘")

        # Summary stats
        r2s = [d["metrics"]["r2"] for d in soiling_rate["transfer"].values() if d.get("metrics")]
        if r2s:
            print(f"\n  📈 Average R²: {np.mean(r2s):.4f}")

    # =========================================================================
    # Approach 3: Physics-Only Features
    # =========================================================================
    physics = improved_transfer.get("approaches", {}).get("physics_only", {})
    if physics.get("transfer"):
        print("\n" + "-"*100)
        print("📊 APPROACH 3: PHYSICS-ONLY FEATURES (most transferable)")
        print("-"*100)
        print("Method: Use only physics-based features that should transfer across locations.")
        print("Features: aod_accum_since_rain, days_since_rain, aod_total, is_dry_season, precip")
        print("Target: Soiling loss percentage ((1 - SR) × 100)")
        print()
        print("┌──────────────┬────────┬──────────┬─────────────┬──────────────────────────────────────────────────────┐")
        print("│   Test Plant │   R²   │   RMSE   │     MAE     │                   Training Details                   │")
        print("├──────────────┼────────┼──────────┼─────────────┼──────────────────────────────────────────────────────┤")

        for plant, data in physics["transfer"].items():
            m = data.get("metrics", {})
            train_plants = ", ".join(data.get("train_plants", []))
            n_features = len(data.get("features_used", []))
            train_info = f"{n_features} features, train: {train_plants[:35]}"

            print(f"│ {plant:<12} │ {m.get('r2', 0):>6.4f} │ {m.get('rmse', 0):>8.6f} │ {m.get('mae', 0):>11.6f} │ {train_info:<52} │")

        print("└──────────────┴────────┴──────────┴─────────────┴──────────────────────────────────────────────────────┘")

        # Summary stats
        r2s = [d["metrics"]["r2"] for d in physics["transfer"].values() if d.get("metrics")]
        if r2s:
            print(f"\n  📈 Average R²: {np.mean(r2s):.4f}")

    # =========================================================================
    # Comparison Summary
    # =========================================================================
    print("\n" + "-"*100)
    print("📋 APPROACH COMPARISON SUMMARY")
    print("-"*100)
    print("┌──────────────┬───────────────────┬───────────────────┬───────────────────┬───────────────────┐")
    print("│   Test Plant │  Baseline (orig)  │  Normalized SR    │   Soiling Rate    │  Physics-Only     │")
    print("├──────────────┼───────────────────┼───────────────────┼───────────────────┼───────────────────┤")

    summary = improved_transfer.get("summary", {})
    for plant in summary.get("original_baseline", {}).keys():
        baseline = summary.get("original_baseline", {}).get(plant, "N/A")[:16]
        norm = summary.get("normalized_sr", {}).get(plant, "N/A")[:16]
        rate = summary.get("soiling_rate", {}).get(plant, "N/A")[:16]
        phys = summary.get("physics_only", {}).get(plant, "N/A")[:16]

        print(f"│ {plant:<12} │ {baseline:<17} │ {norm:<17} │ {rate:<17} │ {phys:<17} │")

    print("└──────────────┴───────────────────┴───────────────────┴───────────────────┴───────────────────┘")

    # Final recommendations
    print("\n" + "-"*100)
    print("💡 KEY INSIGHTS")
    print("-"*100)

    # Calculate best approach per plant
    best_approaches = {}
    for plant in summary.get("original_baseline", {}).keys():
        best_r2 = -999
        best_name = "none"

        if norm_sr.get("transfer", {}).get(plant):
            r2 = norm_sr["transfer"][plant].get("original_scale_metrics", {}).get("r2", -999)
            if r2 > best_r2:
                best_r2 = r2
                best_name = "Normalized SR"

        if soiling_rate.get("transfer", {}).get(plant):
            r2 = soiling_rate["transfer"][plant].get("metrics", {}).get("r2", -999)
            if r2 > best_r2:
                best_r2 = r2
                best_name = "Soiling Rate"

        if physics.get("transfer", {}).get(plant):
            r2 = physics["transfer"][plant].get("metrics", {}).get("r2", -999)
            if r2 > best_r2:
                best_r2 = r2
                best_name = "Physics-Only"

        if best_r2 > -999:
            best_approaches[plant] = (best_name, best_r2)

    for plant, (approach, r2) in best_approaches.items():
        status = "✅" if r2 > 0.3 else "⚠️" if r2 > 0 else "❌"
        print(f"  {status} {plant}: Best approach = {approach} (R²={r2:.4f})")

    # Overall summary
    if best_approaches:
        avg_best_r2 = np.mean([r2 for _, r2 in best_approaches.values()])
        print(f"\n  📊 Average Best R² across plants: {avg_best_r2:.4f}")

        if avg_best_r2 > 0.2:
            print("  ✅ Transfer learning is FEASIBLE with improved approaches!")
        elif avg_best_r2 > 0:
            print("  ⚠️ Transfer learning shows some potential but needs refinement.")
        else:
            print("  ❌ Transfer learning still fails - consider plant-specific models only.")


# =============================================================================
# CLI Entry Point
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Analyze DustIQ data quality and correlations across plants"
    )
    parser.add_argument(
        "--plants",
        nargs="+",
        choices=list(PLANT_CONFIG.keys()),
        help="Plants to analyze (default: all)",
    )
    parser.add_argument(
        "--skip-aod-download",
        action="store_true",
        help="Skip AOD data download (use cached only)",
    )

    args = parser.parse_args()

    run_analysis(
        plants=args.plants,
        skip_aod_download=args.skip_aod_download,
    )


if __name__ == "__main__":
    main()
