"""
Irradiance Quality Analysis for Solar PV Plants.

Compares on-site irradiance measurements with Open-Meteo satellite data
to detect sensor issues, calibration drift, and data quality problems.

Key Metrics:
- Correlation: Pearson r between on-site and Open-Meteo
- RMSE: Root Mean Square Error (W/m²)
- Bias: Mean difference (positive = on-site higher)
- R²: Coefficient of determination
"""

from datetime import datetime
from typing import Dict, List, Optional, Tuple
import requests

import numpy as np
import polars as pl


# Open-Meteo API endpoints
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Default irradiance column patterns
IRRADIANCE_PATTERNS = [
    "irradiancia",
    "poa_irradiance",
    "ghi",
    "global_horizontal",
    "irradiance",
    "radiation",
    "solar"
]


def fetch_open_meteo_irradiance(
    latitude: float,
    longitude: float,
    start_date: str,
    end_date: str,
    timezone: str = "UTC"
) -> Optional[pl.DataFrame]:
    """
    Fetch historical irradiance data from Open-Meteo Archive API.

    Parameters
    ----------
    latitude : float
        Site latitude
    longitude : float
        Site longitude
    start_date : str
        Start date (YYYY-MM-DD)
    end_date : str
        End date (YYYY-MM-DD)
    timezone : str
        Timezone for data

    Returns
    -------
    df : pl.DataFrame or None
        DataFrame with columns: timestamp, irradiance_openmeteo (W/m²)
    """
    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start_date,
        "end_date": end_date,
        "hourly": "shortwave_radiation,direct_radiation,diffuse_radiation",
        "timezone": timezone
    }

    try:
        response = requests.get(OPEN_METEO_ARCHIVE_URL, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as e:
        print(f"Error fetching Open-Meteo data: {e}")
        return None

    if "hourly" not in data:
        return None

    hourly = data["hourly"]

    df = pl.DataFrame({
        "timestamp": hourly["time"],
        "ghi_openmeteo": hourly.get("shortwave_radiation", [None] * len(hourly["time"])),
        "dni_openmeteo": hourly.get("direct_radiation", [None] * len(hourly["time"])),
        "dhi_openmeteo": hourly.get("diffuse_radiation", [None] * len(hourly["time"]))
    })

    df = df.with_columns(
        pl.col("timestamp").str.to_datetime("%Y-%m-%dT%H:%M").alias("timestamp")
    )

    df = df.with_columns(
        pl.col("ghi_openmeteo").alias("irradiance_openmeteo")
    )

    df = df.filter(pl.col("irradiance_openmeteo").is_not_null())

    return df


def load_onsite_irradiance(
    parquet_dir,
    irradiance_patterns: Optional[List[str]] = None
) -> Optional[pl.DataFrame]:
    """
    Load on-site irradiance measurements from parquet files.

    Parameters
    ----------
    parquet_dir : Path
        Directory containing parquet files
    irradiance_patterns : list, optional
        Column name patterns to search for irradiance

    Returns
    -------
    df : pl.DataFrame or None
        DataFrame with columns: timestamp, irradiance_onsite (W/m²)
    """
    from pathlib import Path

    parquet_dir = Path(parquet_dir)
    parquet_files = list(parquet_dir.glob("*.parquet"))

    if not parquet_files:
        return None

    patterns = irradiance_patterns or IRRADIANCE_PATTERNS
    all_data = []

    for parquet_file in parquet_files:
        try:
            df = pl.read_parquet(parquet_file)

            # Find timestamp column
            ts_col = None
            for col in ["timestamp", "Timestamp", "datetime", "DateTime", "time"]:
                if col in df.columns:
                    ts_col = col
                    break

            if ts_col is None:
                for col in df.columns:
                    if df[col].dtype == pl.Datetime:
                        ts_col = col
                        break

            if ts_col is None:
                continue

            # Find irradiance column
            irr_col = None
            for pattern in patterns:
                for col in df.columns:
                    if pattern.lower() in col.lower():
                        irr_col = col
                        break
                if irr_col:
                    break

            if irr_col is None:
                continue

            df_extracted = df.select([
                pl.col(ts_col).alias("timestamp"),
                pl.col(irr_col).cast(pl.Float64).alias("irradiance_onsite")
            ])

            if df_extracted["timestamp"].dtype != pl.Datetime:
                df_extracted = df_extracted.with_columns(
                    pl.col("timestamp").str.to_datetime().alias("timestamp")
                )

            all_data.append(df_extracted)

        except Exception:
            continue

    if not all_data:
        return None

    df_combined = pl.concat(all_data)
    df_combined = df_combined.unique(subset=["timestamp"]).sort("timestamp")
    df_combined = df_combined.filter(
        (pl.col("irradiance_onsite") >= 0) &
        (pl.col("irradiance_onsite") <= 1500)
    )

    return df_combined


def calculate_quality_metrics(
    onsite: np.ndarray,
    openmeteo: np.ndarray
) -> Dict[str, float]:
    """
    Calculate comparison metrics between on-site and Open-Meteo irradiance.

    Parameters
    ----------
    onsite : np.ndarray
        On-site irradiance values (W/m²)
    openmeteo : np.ndarray
        Open-Meteo irradiance values (W/m²)

    Returns
    -------
    metrics : dict
        Dictionary with correlation, rmse, mae, bias, biasPct, r_squared, sampleCount
    """
    # Remove NaN pairs
    mask = ~(np.isnan(onsite) | np.isnan(openmeteo))
    onsite_clean = onsite[mask]
    openmeteo_clean = openmeteo[mask]

    n = len(onsite_clean)
    if n < 10:
        return {
            "correlation": 0,
            "rmse": 0,
            "mae": 0,
            "bias": 0,
            "biasPct": 0,
            "r_squared": 0,
            "sampleCount": n
        }

    # Correlation
    correlation = np.corrcoef(onsite_clean, openmeteo_clean)[0, 1]

    # RMSE
    rmse = np.sqrt(np.mean((onsite_clean - openmeteo_clean) ** 2))

    # MAE
    mae = np.mean(np.abs(onsite_clean - openmeteo_clean))

    # Bias
    bias = np.mean(onsite_clean - openmeteo_clean)
    mean_openmeteo = np.mean(openmeteo_clean)
    bias_pct = (bias / mean_openmeteo * 100) if mean_openmeteo > 0 else 0

    # R-squared
    ss_res = np.sum((onsite_clean - openmeteo_clean) ** 2)
    ss_tot = np.sum((onsite_clean - np.mean(onsite_clean)) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

    return {
        "correlation": round(correlation, 4) if not np.isnan(correlation) else 0,
        "rmse": round(rmse, 2),
        "mae": round(mae, 2),
        "bias": round(bias, 2),
        "biasPct": round(bias_pct, 2),
        "r_squared": round(r_squared, 4) if not np.isnan(r_squared) else 0,
        "sampleCount": n
    }


def compare_irradiance_sources(
    df_onsite: pl.DataFrame,
    df_openmeteo: pl.DataFrame
) -> Tuple[pl.DataFrame, Dict]:
    """
    Compare on-site and Open-Meteo irradiance data.

    Parameters
    ----------
    df_onsite : pl.DataFrame
        On-site data with timestamp and irradiance_onsite columns
    df_openmeteo : pl.DataFrame
        Open-Meteo data with timestamp and irradiance_openmeteo columns

    Returns
    -------
    df_combined : pl.DataFrame
        Joined data with both irradiance columns
    overall_metrics : dict
        Overall comparison metrics
    """
    # Resample on-site to hourly
    df_onsite_hourly = df_onsite.with_columns(
        pl.col("timestamp").dt.truncate("1h").alias("timestamp_hour")
    ).group_by("timestamp_hour").agg(
        pl.col("irradiance_onsite").mean().alias("irradiance_onsite")
    ).rename({"timestamp_hour": "timestamp"})

    # Join datasets
    df_combined = df_onsite_hourly.join(
        df_openmeteo.select(["timestamp", "irradiance_openmeteo"]),
        on="timestamp",
        how="inner"
    )

    # Filter to daylight hours
    df_combined = df_combined.filter(
        (pl.col("irradiance_onsite") > 10) &
        (pl.col("irradiance_openmeteo") > 10)
    )

    if len(df_combined) < 100:
        return df_combined, calculate_quality_metrics(np.array([]), np.array([]))

    onsite_arr = df_combined["irradiance_onsite"].to_numpy()
    openmeteo_arr = df_combined["irradiance_openmeteo"].to_numpy()

    overall_metrics = calculate_quality_metrics(onsite_arr, openmeteo_arr)

    return df_combined, overall_metrics


def generate_monthly_metrics(df: pl.DataFrame) -> List[Dict]:
    """
    Calculate comparison metrics broken down by month.

    Parameters
    ----------
    df : pl.DataFrame
        Combined irradiance data

    Returns
    -------
    monthly_metrics : list
        List of monthly metric dictionaries
    """
    monthly_metrics = []

    df_with_month = df.with_columns(
        pl.col("timestamp").dt.strftime("%Y-%m").alias("month")
    )

    months = df_with_month.select("month").unique().sort("month")["month"].to_list()

    for month in months:
        df_month = df_with_month.filter(pl.col("month") == month)

        onsite = df_month["irradiance_onsite"].to_numpy()
        openmeteo = df_month["irradiance_openmeteo"].to_numpy()

        metrics = calculate_quality_metrics(onsite, openmeteo)

        monthly_metrics.append({
            "month": month,
            "metrics": metrics
        })

    return monthly_metrics


def generate_hourly_metrics(df: pl.DataFrame) -> List[Dict]:
    """
    Calculate comparison metrics broken down by hour of day.

    Parameters
    ----------
    df : pl.DataFrame
        Combined irradiance data

    Returns
    -------
    hourly_metrics : list
        List of hourly metric dictionaries
    """
    hourly_metrics = []

    df_with_hour = df.with_columns(
        pl.col("timestamp").dt.hour().alias("hour")
    )

    for hour in range(24):
        df_hour = df_with_hour.filter(pl.col("hour") == hour)

        if len(df_hour) < 10:
            continue

        onsite = df_hour["irradiance_onsite"].to_numpy()
        openmeteo = df_hour["irradiance_openmeteo"].to_numpy()

        metrics = calculate_quality_metrics(onsite, openmeteo)

        hourly_metrics.append({
            "hour": hour,
            "metrics": metrics
        })

    return hourly_metrics


def generate_irradiance_alerts(
    overall_metrics: Dict,
    monthly_metrics: List[Dict],
    hourly_metrics: List[Dict]
) -> List[Dict]:
    """
    Generate quality alerts based on comparison metrics.

    Parameters
    ----------
    overall_metrics : dict
        Overall comparison metrics
    monthly_metrics : list
        Monthly breakdown metrics
    hourly_metrics : list
        Hourly breakdown metrics

    Returns
    -------
    alerts : list
        List of alert dictionaries
    """
    alerts = []
    alert_id = 1

    # Check correlation
    if overall_metrics["correlation"] < 0.9:
        severity = "high" if overall_metrics["correlation"] < 0.8 else "medium"
        alerts.append({
            "id": f"alert_{alert_id}",
            "type": "low_correlation",
            "severity": severity,
            "message": f"Low correlation ({overall_metrics['correlation']:.3f}) between on-site and Open-Meteo",
            "recommendation": "Check sensor calibration or positioning"
        })
        alert_id += 1

    # Check bias
    if abs(overall_metrics["biasPct"]) > 5:
        severity = "high" if abs(overall_metrics["biasPct"]) > 10 else "medium"
        direction = "higher" if overall_metrics["bias"] > 0 else "lower"
        alerts.append({
            "id": f"alert_{alert_id}",
            "type": "high_bias",
            "severity": severity,
            "message": f"On-site sensor reads {abs(overall_metrics['biasPct']):.1f}% {direction} than Open-Meteo",
            "recommendation": "Verify sensor calibration"
        })
        alert_id += 1

    # Check seasonal drift
    if monthly_metrics:
        correlations = [m["metrics"]["correlation"] for m in monthly_metrics if m["metrics"]["sampleCount"] > 100]
        if len(correlations) > 3:
            corr_std = np.std(correlations)
            if corr_std > 0.05:
                alerts.append({
                    "id": f"alert_{alert_id}",
                    "type": "seasonal_drift",
                    "severity": "low",
                    "message": f"Seasonal variation in correlation (std: {corr_std:.3f})",
                    "recommendation": "Monitor sensor performance across seasons"
                })
                alert_id += 1

    # Check time-of-day bias
    if hourly_metrics:
        morning = [m["metrics"]["bias"] for m in hourly_metrics if 6 <= m["hour"] <= 10]
        evening = [m["metrics"]["bias"] for m in hourly_metrics if 15 <= m["hour"] <= 19]

        if morning and evening:
            morning_bias = np.mean(morning)
            evening_bias = np.mean(evening)

            if abs(morning_bias - evening_bias) > 30:
                alerts.append({
                    "id": f"alert_{alert_id}",
                    "type": "directional_bias",
                    "severity": "medium",
                    "message": f"Asymmetric bias between morning ({morning_bias:.1f}) and evening ({evening_bias:.1f})",
                    "recommendation": "Check sensor orientation"
                })
                alert_id += 1

    # Check RMSE
    if overall_metrics["rmse"] > 100:
        severity = "high" if overall_metrics["rmse"] > 150 else "medium"
        alerts.append({
            "id": f"alert_{alert_id}",
            "type": "high_rmse",
            "severity": severity,
            "message": f"High RMSE ({overall_metrics['rmse']:.1f} W/m²)",
            "recommendation": "Investigate sensor mounting and cleanliness"
        })
        alert_id += 1

    return alerts
