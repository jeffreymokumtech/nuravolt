"""
Data Source Correlation Analysis for Solar PV Plants.

Analyzes which irradiance data source (on-site vs Open-Meteo) correlates
better with each inverter zone's performance ratio.

Analysis Dimensions:
- Overall correlation per zone
- Uniform vs non-uniform periods
- Time-of-day patterns
- Seasonal patterns
"""

from typing import Dict, List, Optional

import numpy as np
import polars as pl


# Default configuration
CV_THRESHOLD = 0.10
MIN_SAMPLES = 50


def calculate_correlation(x: np.ndarray, y: np.ndarray, min_samples: int = 50) -> float:
    """
    Calculate Pearson correlation coefficient.

    Parameters
    ----------
    x : np.ndarray
        First array
    y : np.ndarray
        Second array
    min_samples : int
        Minimum samples for valid correlation

    Returns
    -------
    correlation : float
        Pearson correlation (0 if insufficient data)
    """
    mask = ~(np.isnan(x) | np.isnan(y))
    x_clean = x[mask]
    y_clean = y[mask]

    if len(x_clean) < min_samples:
        return 0.0

    corr = np.corrcoef(x_clean, y_clean)[0, 1]
    return round(corr, 4) if not np.isnan(corr) else 0.0


def calculate_zone_correlations(
    df_pr: pl.DataFrame,
    df_irr: pl.DataFrame,
    zones: List[str],
    min_samples: int = 50
) -> List[Dict]:
    """
    Calculate correlation of each zone's PR with both irradiance sources.

    Parameters
    ----------
    df_pr : pl.DataFrame
        Zone PR data with timestamp and pr_ZONE columns
    df_irr : pl.DataFrame
        Irradiance data with timestamp, irradiance_onsite, irradiance_openmeteo
    zones : list
        Zone names
    min_samples : int
        Minimum samples for valid correlation

    Returns
    -------
    zone_correlations : list
        List of zone correlation dictionaries
    """
    # Aggregate to daily
    df_pr_daily = df_pr.with_columns(
        pl.col("timestamp").dt.truncate("1d").alias("date")
    )

    df_irr_daily = df_irr.with_columns(
        pl.col("timestamp").dt.truncate("1d").alias("date")
    ).group_by("date").agg([
        pl.col("irradiance_onsite").mean().alias("irradiance_onsite"),
        pl.col("irradiance_openmeteo").mean().alias("irradiance_openmeteo")
    ])

    df_merged = df_pr_daily.join(df_irr_daily, on="date", how="inner")

    if len(df_merged) < min_samples:
        return []

    zone_correlations = []

    for zone in zones:
        pr_col = f"pr_{zone}"

        if pr_col not in df_merged.columns:
            continue

        pr_values = df_merged[pr_col].to_numpy()
        onsite_values = df_merged["irradiance_onsite"].to_numpy()
        openmeteo_values = df_merged["irradiance_openmeteo"].to_numpy()

        corr_onsite = calculate_correlation(pr_values, onsite_values, min_samples)
        corr_openmeteo = calculate_correlation(pr_values, openmeteo_values, min_samples)

        diff = corr_onsite - corr_openmeteo
        if abs(diff) < 0.02:
            better_source = "similar"
        elif diff > 0:
            better_source = "on_site"
        else:
            better_source = "open_meteo"

        zone_correlations.append({
            "zoneId": zone,
            "onSiteCorrelation": corr_onsite,
            "openMeteoCorrelation": corr_openmeteo,
            "betterSource": better_source,
            "correlationDifference": round(diff, 4),
            "sampleCount": int(np.sum(~np.isnan(pr_values)))
        })

    return zone_correlations


def analyze_data_source_correlation(
    df_pr: pl.DataFrame,
    df_irr: pl.DataFrame,
    zones: List[str],
    cv_threshold: float = 0.10,
    min_samples: int = 50
) -> Dict:
    """
    Analyze correlations for uniform vs non-uniform periods.

    Parameters
    ----------
    df_pr : pl.DataFrame
        Zone PR data with isUniform column
    df_irr : pl.DataFrame
        Irradiance comparison data
    zones : list
        Zone names
    cv_threshold : float
        CV threshold for uniformity
    min_samples : int
        Minimum samples for valid correlation

    Returns
    -------
    analysis : dict
        Overall analysis with uniform and non-uniform period correlations
    """
    if "isUniform" not in df_pr.columns:
        return {
            "uniformPeriods": {"count": 0, "zoneCorrelations": []},
            "nonUniformPeriods": {"count": 0, "zoneCorrelations": []}
        }

    df_uniform = df_pr.filter(pl.col("isUniform") == True)
    df_non_uniform = df_pr.filter(pl.col("isUniform") == False)

    return {
        "uniformPeriods": {
            "count": len(df_uniform),
            "zoneCorrelations": calculate_zone_correlations(
                df_uniform, df_irr, zones, min_samples
            ) if len(df_uniform) > min_samples else []
        },
        "nonUniformPeriods": {
            "count": len(df_non_uniform),
            "zoneCorrelations": calculate_zone_correlations(
                df_non_uniform, df_irr, zones, min_samples
            ) if len(df_non_uniform) > min_samples else []
        }
    }


def analyze_time_patterns(
    df_pr: pl.DataFrame,
    df_irr: pl.DataFrame,
    zones: List[str],
    min_samples: int = 50
) -> List[Dict]:
    """
    Analyze correlation patterns by time of day.

    Parameters
    ----------
    df_pr : pl.DataFrame
        Zone PR data
    df_irr : pl.DataFrame
        Irradiance data
    zones : list
        Zone names
    min_samples : int
        Minimum samples for valid analysis

    Returns
    -------
    patterns : list
        Time-of-day correlation patterns
    """
    patterns = []

    df_pr_hourly = df_pr.with_columns(
        pl.col("timestamp").dt.hour().alias("hour")
    )

    df_irr_hourly = df_irr.with_columns(
        pl.col("timestamp").dt.hour().alias("hour")
    )

    time_periods = [
        ("morning", 6, 10),
        ("midday", 10, 14),
        ("afternoon", 14, 18)
    ]

    for period_name, start_hour, end_hour in time_periods:
        df_pr_period = df_pr_hourly.filter(
            (pl.col("hour") >= start_hour) & (pl.col("hour") < end_hour)
        )
        df_irr_period = df_irr_hourly.filter(
            (pl.col("hour") >= start_hour) & (pl.col("hour") < end_hour)
        )

        if len(df_pr_period) < min_samples or len(df_irr_period) < min_samples:
            continue

        zone_corrs = calculate_zone_correlations(df_pr_period, df_irr_period, zones, min_samples)

        if zone_corrs:
            openmeteo_better = [z for z in zone_corrs if z["betterSource"] == "open_meteo"]

            if openmeteo_better:
                patterns.append({
                    "pattern": f"Zones {', '.join([z['zoneId'] for z in openmeteo_better])} correlate better with Open-Meteo during {period_name}",
                    "period": period_name,
                    "affectedZones": [z["zoneId"] for z in openmeteo_better],
                    "frequency": len(openmeteo_better) / len(zone_corrs),
                    "confidence": np.mean([abs(z["correlationDifference"]) for z in openmeteo_better])
                })

    return patterns


def analyze_seasonal_patterns(
    df_pr: pl.DataFrame,
    df_irr: pl.DataFrame,
    zones: List[str],
    min_samples: int = 50
) -> List[Dict]:
    """
    Analyze correlation patterns by season.

    Parameters
    ----------
    df_pr : pl.DataFrame
        Zone PR data
    df_irr : pl.DataFrame
        Irradiance data
    zones : list
        Zone names
    min_samples : int
        Minimum samples for valid analysis

    Returns
    -------
    patterns : list
        Seasonal correlation patterns
    """
    patterns = []

    df_pr_seasonal = df_pr.with_columns(
        pl.col("timestamp").dt.month().alias("month")
    ).with_columns(
        pl.when(pl.col("month").is_in([12, 1, 2])).then(pl.lit("winter"))
        .when(pl.col("month").is_in([3, 4, 5])).then(pl.lit("spring"))
        .when(pl.col("month").is_in([6, 7, 8])).then(pl.lit("summer"))
        .otherwise(pl.lit("autumn")).alias("season")
    )

    df_irr_seasonal = df_irr.with_columns(
        pl.col("timestamp").dt.month().alias("month")
    ).with_columns(
        pl.when(pl.col("month").is_in([12, 1, 2])).then(pl.lit("winter"))
        .when(pl.col("month").is_in([3, 4, 5])).then(pl.lit("spring"))
        .when(pl.col("month").is_in([6, 7, 8])).then(pl.lit("summer"))
        .otherwise(pl.lit("autumn")).alias("season")
    )

    for season in ["winter", "spring", "summer", "autumn"]:
        df_pr_season = df_pr_seasonal.filter(pl.col("season") == season)
        df_irr_season = df_irr_seasonal.filter(pl.col("season") == season)

        if len(df_pr_season) < min_samples or len(df_irr_season) < min_samples:
            continue

        zone_corrs = calculate_zone_correlations(df_pr_season, df_irr_season, zones, min_samples)

        if zone_corrs:
            for zc in zone_corrs:
                if abs(zc["correlationDifference"]) > 0.05:
                    better = "Open-Meteo" if zc["betterSource"] == "open_meteo" else "on-site"
                    patterns.append({
                        "pattern": f"{zc['zoneId']} correlates better with {better} during {season}",
                        "season": season,
                        "affectedZones": [zc["zoneId"]],
                        "frequency": 0.25,
                        "confidence": abs(zc["correlationDifference"])
                    })

    return patterns


def generate_recommendations(
    overall_analysis: Dict,
    time_patterns: List[Dict],
    seasonal_patterns: List[Dict]
) -> List[str]:
    """
    Generate actionable recommendations based on correlation analysis.

    Parameters
    ----------
    overall_analysis : dict
        Uniform/non-uniform period analysis
    time_patterns : list
        Time-of-day patterns
    seasonal_patterns : list
        Seasonal patterns

    Returns
    -------
    recommendations : list
        List of recommendation strings
    """
    recommendations = []

    uniform_corrs = overall_analysis.get("uniformPeriods", {}).get("zoneCorrelations", [])
    non_uniform_corrs = overall_analysis.get("nonUniformPeriods", {}).get("zoneCorrelations", [])

    if uniform_corrs:
        avg_onsite = np.mean([z["onSiteCorrelation"] for z in uniform_corrs])
        avg_openmeteo = np.mean([z["openMeteoCorrelation"] for z in uniform_corrs])

        if avg_onsite < 0.8:
            recommendations.append(
                "On-site irradiance sensor shows low correlation with zone performance. "
                "Consider sensor calibration or repositioning."
            )

        if avg_openmeteo > avg_onsite + 0.05:
            recommendations.append(
                "Open-Meteo data correlates better during uniform conditions. "
                "Consider using Open-Meteo as backup data source."
            )

    if non_uniform_corrs:
        zones_prefer_openmeteo = [z["zoneId"] for z in non_uniform_corrs if z["betterSource"] == "open_meteo"]

        if zones_prefer_openmeteo:
            recommendations.append(
                f"During non-uniform conditions, zones {', '.join(zones_prefer_openmeteo)} "
                "correlate better with Open-Meteo."
            )

    if time_patterns:
        afternoon_issues = [p for p in time_patterns if p.get("period") == "afternoon"]
        if afternoon_issues:
            recommendations.append(
                "Afternoon correlations differ between data sources. "
                "Check for sensor thermal effects or late-day shading."
            )

    if seasonal_patterns:
        winter_issues = [p for p in seasonal_patterns if p.get("season") == "winter"]
        if winter_issues:
            recommendations.append(
                "Winter correlations differ between data sources. "
                "Low sun angle may cause sensor-specific biases."
            )

    if not recommendations:
        recommendations.append(
            "Data sources show consistent correlation with zone performance. "
            "On-site sensor appears well-calibrated."
        )

    return recommendations
