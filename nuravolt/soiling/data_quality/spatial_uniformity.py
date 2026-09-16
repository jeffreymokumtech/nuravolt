"""
Spatial Uniformity Analysis for Solar PV Plants.

Detects non-uniform conditions across inverter zones by calculating
Coefficient of Variation (CV) of zone-level Performance Ratios.

CV = std(zone_PRs) / mean(zone_PRs)

Typical CV Interpretation:
- < 0.05: Highly uniform, single weather point is reliable
- 0.05-0.10: Normal variation, OK for analysis
- 0.10-0.20: Moderate non-uniformity, flag for review
- > 0.20: High non-uniformity, don't trust single weather point
"""

import re
import uuid
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import polars as pl


# Default zone configurations per plant
DEFAULT_ZONE_CONFIG = {
    'alpha1': {
        'zones': {
            'INV 01': {'pattern': r'INV\s*01\.', 'description': 'Northwest zone'},
            'INV 02': {'pattern': r'INV\s*02\.', 'description': 'Northeast zone'},
            'INV 03': {'pattern': r'INV\s*03\.', 'description': 'Center zone'},
            'INV 04': {'pattern': r'INV\s*04\.', 'description': 'Southwest zone'},
            'INV 05': {'pattern': r'INV\s*05\.', 'description': 'Southeast zone'},
        },
        'cv_threshold': 0.10,
    },
    'eta': {
        'zones': {
            'INV 01A': {'pattern': r'INV\s*01\.(00[1-9]|01[0-4])\b', 'description': 'First 14 inverters (001-014)'},
            'INV 01B': {'pattern': r'INV\s*01\.(01[5-9]|02[0-8])\b', 'description': 'Last 14 inverters (015-028)'},
        },
        'cv_threshold': 0.10,
    },
    'ribera': {
        'zones': {
            'INV 01': {'pattern': r'INV\s*01\.', 'description': 'Group 1 - 29 inverters'},
            'INV 02': {'pattern': r'INV\s*02\.', 'description': 'Group 2 - 31 inverters'},
            'INV 03': {'pattern': r'INV\s*03\.', 'description': 'Group 3 - 33 inverters'},
            'INV 04': {'pattern': r'INV\s*04\.', 'description': 'Group 4 - 27 inverters'},
        },
        'cv_threshold': 0.10,
    }
}

# Analysis parameters
ANALYSIS_CONFIG = {
    'min_irradiance_Wm2': 100,
    'min_inverters_per_zone': 5,
    'alert_duration_minutes': 30,
    'alert_cv_threshold': 0.15,
}


def get_zone_mapping(
    plant_id: str,
    custom_config: Optional[Dict] = None
) -> Tuple[Dict, float]:
    """
    Get zone configuration for a plant.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    custom_config : dict, optional
        Custom zone configuration

    Returns
    -------
    zones : dict
        Zone definitions with patterns and descriptions
    cv_threshold : float
        CV threshold for non-uniformity detection
    """
    if custom_config:
        return custom_config.get('zones', {}), custom_config.get('cv_threshold', 0.10)

    config = DEFAULT_ZONE_CONFIG.get(plant_id, DEFAULT_ZONE_CONFIG['alpha1'])
    return config['zones'], config['cv_threshold']


def identify_zone_columns(
    columns: List[str],
    zone_patterns: Dict[str, Dict]
) -> Dict[str, List[str]]:
    """
    Map column names to zones based on regex patterns.

    Parameters
    ----------
    columns : list
        List of column names
    zone_patterns : dict
        Zone definitions with 'pattern' keys

    Returns
    -------
    zone_columns : dict
        Mapping of zone names to list of column names
    """
    zone_columns = {zone: [] for zone in zone_patterns}

    for col in columns:
        for zone, config in zone_patterns.items():
            if re.search(config['pattern'], col):
                zone_columns[zone].append(col)
                break

    return zone_columns


def calculate_zone_pr(
    df: pl.DataFrame,
    zone_columns: Dict[str, List[str]],
    irr_col: str,
    ts_col: str,
    min_irradiance: float = 100
) -> pl.DataFrame:
    """
    Calculate zone-level Performance Ratio for each timestamp.

    PR = avg(normalized_power) / (irradiance / 1000)

    Parameters
    ----------
    df : pl.DataFrame
        Parquet data with inverter columns
    zone_columns : dict
        Mapping of zones to column names
    irr_col : str
        Irradiance column name
    ts_col : str
        Timestamp column name
    min_irradiance : float
        Minimum irradiance for valid measurements

    Returns
    -------
    df_zones : pl.DataFrame
        DataFrame with zone PRs and counts
    """
    zone_exprs = []

    for zone, cols in zone_columns.items():
        if not cols:
            continue

        # Zone average power
        zone_avg_expr = pl.mean_horizontal(*[pl.col(c) for c in cols]).alias(f'{zone}_power')
        zone_exprs.append(zone_avg_expr)

        # Count online inverters
        zone_count_expr = sum([
            pl.col(c).is_not_null().cast(pl.Int32) for c in cols
        ]).alias(f'{zone}_count')
        zone_exprs.append(zone_count_expr)

    # Select base columns and zone metrics
    df_zones = df.select([
        pl.col(ts_col).alias('timestamp'),
        pl.col(irr_col).alias('irradiance'),
        *zone_exprs
    ])

    # Calculate PR for each zone
    zones = [z for z in zone_columns.keys() if zone_columns[z]]
    pr_exprs = [
        (pl.col(f'{zone}_power') / (pl.col('irradiance') / 1000))
        .clip(0, 1.5)
        .alias(f'{zone}_pr')
        for zone in zones
    ]

    df_zones = df_zones.with_columns(pr_exprs)

    # Filter for valid daylight hours
    df_zones = df_zones.filter(pl.col('irradiance') >= min_irradiance)

    return df_zones


def calculate_spatial_uniformity(
    df_zones: pl.DataFrame,
    zones: List[str],
    cv_threshold: float = 0.10
) -> pl.DataFrame:
    """
    Calculate Coefficient of Variation (CV) and uniformity metrics.

    CV = std(zone_PRs) / mean(zone_PRs)

    Parameters
    ----------
    df_zones : pl.DataFrame
        DataFrame with zone PR columns
    zones : list
        List of zone names
    cv_threshold : float
        CV threshold for uniformity classification

    Returns
    -------
    df_cv : pl.DataFrame
        DataFrame with CV, uniformity flag, and spread metrics
    """
    pr_cols = [f'{zone}_pr' for zone in zones]

    # Calculate mean PR across zones
    df_cv = df_zones.with_columns([
        pl.mean_horizontal(*[pl.col(c) for c in pr_cols]).alias('mean_pr'),
    ])

    # Calculate variance -> std
    def calc_std_expr(cols, mean_col):
        squared_diffs = [(pl.col(c) - pl.col(mean_col)) ** 2 for c in cols]
        return pl.mean_horizontal(*squared_diffs).sqrt()

    df_cv = df_cv.with_columns([
        calc_std_expr(pr_cols, 'mean_pr').alias('std_pr')
    ])

    # Calculate CV and uniformity flag
    df_cv = df_cv.with_columns([
        (pl.col('std_pr') / pl.col('mean_pr')).alias('cv'),
        (pl.col('std_pr') / pl.col('mean_pr') < cv_threshold).alias('is_uniform'),
    ])

    # Calculate spread (max - min)
    df_cv = df_cv.with_columns([
        pl.max_horizontal(*[pl.col(f'{zone}_pr') for zone in zones]).alias('max_pr'),
        pl.min_horizontal(*[pl.col(f'{zone}_pr') for zone in zones]).alias('min_pr'),
    ])

    df_cv = df_cv.with_columns([
        (pl.col('max_pr') - pl.col('min_pr')).alias('spread'),
    ])

    return df_cv


def aggregate_to_daily(
    df_cv: pl.DataFrame,
    zones: List[str],
    cv_threshold: float = 0.10
) -> pl.DataFrame:
    """
    Aggregate CV metrics to daily values.

    Parameters
    ----------
    df_cv : pl.DataFrame
        15-minute CV data
    zones : list
        Zone names
    cv_threshold : float
        CV threshold for uniformity

    Returns
    -------
    df_daily : pl.DataFrame
        Daily aggregated metrics
    """
    # Parse timestamp and extract date
    df_daily = df_cv.with_columns([
        pl.col('timestamp').str.to_datetime().dt.date().alias('date')
    ])

    # Build aggregation expressions
    agg_exprs = [
        pl.col('cv').mean().alias('cv'),
        pl.col('cv').max().alias('cv_max'),
        pl.col('is_uniform').mean().alias('uniform_rate'),
        pl.col('spread').mean().alias('avg_spread'),
        pl.col('mean_pr').mean().alias('avg_pr'),
        pl.col('irradiance').sum().alias('total_irradiance'),
        pl.len().alias('n_measurements'),
    ]

    for zone in zones:
        agg_exprs.append(pl.col(f'{zone}_pr').mean().alias(f'{zone}_pr'))

    df_daily = df_daily.group_by('date').agg(agg_exprs).sort('date')

    # Recalculate uniformity based on daily CV
    df_daily = df_daily.with_columns([
        (pl.col('cv') < cv_threshold).alias('is_uniform')
    ])

    return df_daily


def detect_non_uniform_periods(
    df_cv: pl.DataFrame,
    zones: List[str],
    cv_threshold: float = 0.15,
    min_duration_minutes: int = 30
) -> List[Dict]:
    """
    Detect non-uniformity alerts when CV exceeds threshold.

    Parameters
    ----------
    df_cv : pl.DataFrame
        CV time series data
    zones : list
        Zone names
    cv_threshold : float
        CV threshold for alerts
    min_duration_minutes : int
        Minimum duration for alert

    Returns
    -------
    alerts : list
        List of alert dictionaries
    """
    alerts = []

    # Filter non-uniform periods
    df_non_uniform = df_cv.filter(pl.col('cv') > cv_threshold)

    if len(df_non_uniform) == 0:
        return alerts

    # Convert to pandas for grouping
    df_nu = df_non_uniform.to_pandas()
    df_nu['timestamp'] = pd.to_datetime(df_nu['timestamp'])
    df_nu = df_nu.sort_values('timestamp')

    # Group consecutive periods
    df_nu['time_diff'] = df_nu['timestamp'].diff()
    df_nu['group'] = (df_nu['time_diff'] > pd.Timedelta(minutes=30)).cumsum()

    for group_id, group_df in df_nu.groupby('group'):
        if len(group_df) < 2:
            continue

        start_time = group_df['timestamp'].min()
        end_time = group_df['timestamp'].max()
        duration = (end_time - start_time).total_seconds() / 60

        if duration < min_duration_minutes:
            continue

        avg_cv = group_df['cv'].mean()
        max_cv = group_df['cv'].max()

        # Find affected zones
        affected_zones = []
        for zone in zones:
            zone_pr = group_df[f'{zone}_pr'].mean()
            mean_pr = group_df['mean_pr'].mean()
            if abs(zone_pr - mean_pr) / mean_pr > 0.1:
                affected_zones.append(zone)

        # Classify cause
        hour = start_time.hour
        avg_spread = group_df['spread'].mean()

        if len(affected_zones) >= 3:
            likely_cause = 'partial_cloud'
        elif avg_spread > 0.15 and len(affected_zones) == 1:
            likely_cause = 'sensor_issue'
        elif 10 <= hour <= 16 and avg_spread > 0.1:
            likely_cause = 'partial_cloud'
        else:
            likely_cause = 'unknown'

        # Severity
        if max_cv > 0.25:
            severity = 'high'
        elif max_cv > 0.18:
            severity = 'medium'
        else:
            severity = 'low'

        alert = {
            'id': str(uuid.uuid4())[:8],
            'startTime': start_time.isoformat(),
            'endTime': end_time.isoformat(),
            'durationMinutes': int(duration),
            'avgCV': round(float(avg_cv), 4),
            'maxCV': round(float(max_cv), 4),
            'affectedZones': affected_zones if affected_zones else zones[:2],
            'likelyCause': likely_cause,
            'severity': severity,
            'description': f"Non-uniform conditions ({likely_cause.replace('_', ' ')}) affecting {', '.join(affected_zones) if affected_zones else 'multiple zones'}",
        }

        alerts.append(alert)

    return alerts[:50]


def calculate_zone_statistics(
    df_daily: pl.DataFrame,
    zones: List[str]
) -> Dict[str, Dict]:
    """
    Calculate aggregate statistics per zone.

    Parameters
    ----------
    df_daily : pl.DataFrame
        Daily aggregated data
    zones : list
        Zone names

    Returns
    -------
    stats : dict
        Per-zone statistics
    """
    stats = {}
    df_pd = df_daily.to_pandas()

    zone_pr_cols = [f'{z}_pr' for z in zones]
    df_pd['max_zone'] = df_pd[zone_pr_cols].idxmax(axis=1)
    df_pd['min_zone'] = df_pd[zone_pr_cols].idxmin(axis=1)

    for zone in zones:
        pr_col = f'{zone}_pr'
        pr_values = df_pd[pr_col].dropna()

        high_pct = (df_pd['max_zone'] == pr_col).sum() / len(df_pd) * 100
        low_pct = (df_pd['min_zone'] == pr_col).sum() / len(df_pd) * 100

        stats[zone] = {
            'avgPR': round(float(pr_values.mean()), 4),
            'stdPR': round(float(pr_values.std()), 4),
            'minPR': round(float(pr_values.min()), 4),
            'maxPR': round(float(pr_values.max()), 4),
            'highPerformancePct': round(float(high_pct), 1),
            'lowPerformancePct': round(float(low_pct), 1),
        }

    return stats
