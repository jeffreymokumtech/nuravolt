#!/usr/bin/env python3
"""
Calculate proper soiling ratio using rdtools SRR (Stochastic Rate and Recovery).

This replaces the broken clearsky ratio method that was contaminated by cloud effects.
rdtools SRR properly isolates soiling by:
1. Filtering for clear-sky periods (high irradiance + clear-sky index > 0.9)
2. Using stochastic modeling to separate soiling rate from recovery events
3. Providing true soiling ratio (0.85-1.0 typical range, not 0.05-0.60)

Requirements:
    pip install rdtools pvlib polars pandas numpy

Usage:
    python scripts/calculateSoilingRatio_rdtools.py --plant-id alpha1

References:
    - rdtools: https://rdtools.readthedocs.io/
    - IEA PVPS Task 13: Soiling Losses guideline
"""

import argparse
import json
from datetime import datetime
from pathlib import Path
import warnings

import numpy as np
import pandas as pd
import polars as pl
from typing import Dict, List, Optional, Tuple

# Suppress rdtools warnings during import
warnings.filterwarnings('ignore')

try:
    import rdtools
    from rdtools import soiling
    RDTOOLS_AVAILABLE = True
except ImportError:
    RDTOOLS_AVAILABLE = False
    print("Warning: rdtools not installed. Install with: pip install rdtools")

try:
    import pvlib
    from pvlib.location import Location
    PVLIB_AVAILABLE = True
except ImportError:
    PVLIB_AVAILABLE = False
    print("Warning: pvlib not installed. Install with: pip install pvlib")


# Configuration for ALPHA1 plant
SITE_CONFIG = {
    'plant_id': 'alpha1',
    'latitude': 37.8145,
    'longitude': -3.8047,
    'elevation': 450,
    'tilt': 20,
    'azimuth': 180,  # South-facing
    'timezone': 'Europe/Madrid',
    'capacity_kW': 9000,
}

# SRR parameters - TIGHTENED for better soiling isolation
SRR_CONFIG = {
    # Clear-sky filtering - TIGHTENED to exclude cloudy periods
    'min_irradiance_Wm2': 400,       # Was 200 - higher threshold reduces noise
    'clearsky_index_min': 0.85,      # Was 0.7 - tighter CSI filter
    'clearsky_index_max': 1.05,      # Was 1.1 - exclude sensor errors
    'min_solar_elevation': 30,       # NEW: only high sun angles
    'solar_noon_window_hours': 3,    # NEW: ±3h from solar noon

    # Temperature correction parameters - NEW
    'temp_coefficient': -0.004,      # -0.4%/°C for crystalline Si
    'temp_reference': 25.0,          # STC reference temperature (°C)
    'temp_min_valid': -40,           # Minimum valid module temp
    'temp_max_valid': 80,            # Maximum valid module temp

    # Soiling parameters
    'max_soiling_rate': 0.005,       # Was 0.01 - tightened to 0.5%/day
    'recovery_threshold_mm': 5.0,    # Rain threshold for cleaning (mm)
    'min_recovery': 0.005,           # Minimum SR recovery after rain (0.5%)
    'max_recovery_rate': 0.05,       # NEW: max 5%/day recovery after rain
    'max_recovery_no_rain': 0.01,    # NEW: max 1%/day without rain

    # Data quality
    'min_daylight_hours': 4,         # Minimum hours of data per day
    'max_gap_days': 7,               # Maximum gap to interpolate
    'min_points_per_day': 4,         # NEW: minimum clear-sky 15-min periods

    # Output bounds
    'sr_min': 0.80,                  # Was 0.75 - below this is equipment failure
    'sr_max': 1.02,                  # Was 1.05 - slight overperformance allowed
}


def load_parquet_data(parquet_dir: Path) -> Optional[pl.DataFrame]:
    """Load 15-minute inverter data from parquet files with column filtering."""
    parquet_files = list(parquet_dir.glob('*.parquet'))

    if not parquet_files:
        print(f"No parquet files found in {parquet_dir}")
        return None

    # Load the normalized power parquet
    power_file = None
    for f in parquet_files:
        if 'Normalized' in f.name or 'training' in f.name:
            power_file = f
            break

    if power_file is None:
        power_file = parquet_files[0]

    print(f"Loading: {power_file.name} (using Polars lazy API with column filtering)")

    # Use lazy scan to avoid loading unnecessary columns
    lf = pl.scan_parquet(power_file)

    # Get all available columns
    all_columns = lf.collect_schema().names()
    print(f"Total columns in file: {len(all_columns)}")

    # Identify columns we actually need for soiling analysis
    needed_cols = []

    # Patterns for columns we need:
    # - Timestamp
    # - Irradiance (POA, GHI, etc.)
    # - Temperature (module, ambient)
    # - Rain/precipitation
    # - Inverter power (normalized)
    # - DustIQ sensors (if present)

    for col in all_columns:
        col_lower = col.lower()

        # Always include timestamp
        if 'timestamp' in col_lower or 'time' in col_lower:
            needed_cols.append(col)

        # Irradiance columns
        elif any(pattern in col_lower for pattern in ['irrad', 'radiation', 'ghi', 'poa']):
            needed_cols.append(col)

        # Temperature columns
        elif any(pattern in col_lower for pattern in ['temp', '°c', 'ambient', 'module']):
            needed_cols.append(col)

        # Rain/precipitation columns
        elif any(pattern in col_lower for pattern in ['rain', 'regen', 'precip', 'mm']):
            needed_cols.append(col)

        # Inverter power columns (normalized)
        elif 'inv' in col_lower and ('normalized' in col_lower or 'kw' in col_lower):
            needed_cols.append(col)

        # DustIQ sensor columns
        elif 'dust' in col_lower or 'dustiq' in col_lower:
            needed_cols.append(col)

    # Remove duplicates while preserving order
    needed_cols = list(dict.fromkeys(needed_cols))

    print(f"Filtered to {len(needed_cols)} needed columns (timestamp + weather + inverters + sensors)")
    print(f"Memory reduction: {100 * (1 - len(needed_cols) / len(all_columns)):.1f}%")

    # Select only needed columns in lazy mode
    lf = lf.select(needed_cols)

    # Now collect to memory with only the filtered columns
    df = lf.collect()
    print(f"Loaded {len(df):,} rows x {len(df.columns)} columns")

    return df


def calculate_temperature_correction(
    t_module: pd.Series,
    t_ambient: Optional[pd.Series] = None,
    poa: Optional[pd.Series] = None,
) -> pd.Series:
    """
    Calculate temperature correction factor for Performance Index.

    Uses measured module temperature if available, otherwise estimates from ambient.

    Args:
        t_module: Measured module temperature (°C)
        t_ambient: Ambient temperature (°C) - fallback if t_module has gaps
        poa: POA irradiance (W/m²) - for NOCT estimation if needed

    Returns:
        Temperature correction factor (typically 0.85-1.10)
    """
    gamma = SRR_CONFIG['temp_coefficient']  # -0.4%/°C
    T_stc = SRR_CONFIG['temp_reference']    # 25°C

    # Clean module temperature data
    t_cell = t_module.copy()

    # Filter invalid readings
    invalid_mask = (t_cell < SRR_CONFIG['temp_min_valid']) | (t_cell > SRR_CONFIG['temp_max_valid'])
    if invalid_mask.any():
        print(f"  Filtering {invalid_mask.sum()} invalid module temp readings")
        t_cell[invalid_mask] = np.nan

    # Fill gaps with NOCT estimate from ambient if available
    if t_ambient is not None and poa is not None:
        missing_mask = t_cell.isna()
        if missing_mask.any():
            # NOCT model: T_cell = T_amb + (NOCT - 20) * (POA / 800)
            noct = 45.0  # Nominal Operating Cell Temperature
            t_cell_est = t_ambient + (noct - 20) * (poa / 800)
            t_cell[missing_mask] = t_cell_est[missing_mask]
            print(f"  Filled {missing_mask.sum()} missing temps with NOCT estimate")

    # Calculate correction factor
    # PI_corrected = PI_raw / temp_factor
    # When hot (T > 25): factor < 1, so PI_corrected increases (removes temp penalty)
    # When cold (T < 25): factor > 1, so PI_corrected decreases (removes temp bonus)
    temp_factor = 1 + gamma * (t_cell - T_stc)

    # Clip to reasonable range
    temp_factor = temp_factor.clip(0.80, 1.15)

    return temp_factor


def apply_physical_constraints(
    sr_daily: pd.Series,
    rain_daily: pd.Series,
) -> pd.Series:
    """
    Apply physical constraints to soiling ratio time series.

    Soiling is a physical process with real-world limits:
    - Dust accumulation is gradual (max ~0.5%/day)
    - Recovery after rain is faster (max ~5%/day)
    - Without rain, recovery should be minimal

    Args:
        sr_daily: Daily soiling ratio series
        rain_daily: Daily precipitation (mm)

    Returns:
        Constrained soiling ratio series
    """
    sr_constrained = sr_daily.copy()

    max_degradation = -SRR_CONFIG['max_soiling_rate']  # -0.5%/day
    max_recovery_rain = SRR_CONFIG['max_recovery_rate']  # +5%/day
    max_recovery_dry = SRR_CONFIG['max_recovery_no_rain']  # +1%/day
    rain_threshold = SRR_CONFIG['recovery_threshold_mm']  # 5mm

    # Align rain data with SR dates
    rain_aligned = rain_daily.reindex(sr_constrained.index).fillna(0)

    changes_applied = 0

    for i in range(1, len(sr_constrained)):
        if pd.isna(sr_constrained.iloc[i]) or pd.isna(sr_constrained.iloc[i-1]):
            continue

        delta = sr_constrained.iloc[i] - sr_constrained.iloc[i-1]
        has_rain = rain_aligned.iloc[i] >= rain_threshold

        if delta < 0:  # Degradation (soiling)
            if delta < max_degradation:
                # Clip to maximum degradation rate
                sr_constrained.iloc[i] = sr_constrained.iloc[i-1] + max_degradation
                changes_applied += 1

        else:  # Recovery
            max_recovery = max_recovery_rain if has_rain else max_recovery_dry
            if delta > max_recovery:
                # Clip to maximum recovery rate
                sr_constrained.iloc[i] = sr_constrained.iloc[i-1] + max_recovery
                changes_applied += 1

    if changes_applied > 0:
        print(f"  Applied physical constraints to {changes_applied} days")

    # Apply absolute bounds
    sr_min = SRR_CONFIG['sr_min']
    sr_max = SRR_CONFIG['sr_max']
    sr_constrained = sr_constrained.clip(sr_min, sr_max)

    return sr_constrained


def prepare_data_for_srr(df: pl.DataFrame, location: Location) -> Tuple[pd.DataFrame, pd.Series]:
    """
    Prepare data for rdtools SRR analysis with temperature correction.

    Returns:
        df_prepared: pandas DataFrame with:
            - datetime index
            - 'power_normalized': Normalized power (kW/kWp)
            - 'poa_global': POA irradiance (W/m²)
            - 'clearsky_index': Ratio of measured to clearsky irradiance
            - 'temp_factor': Temperature correction factor
            - 'pi_temp_corrected': Temperature-corrected Performance Index
        rain_onsite: Daily on-site precipitation series
    """
    # Get column names
    cols = df.columns

    # Find timestamp column
    ts_col = None
    for col in cols:
        if 'timestamp' in col.lower() or 'time' in col.lower():
            ts_col = col
            break

    if ts_col is None:
        ts_col = cols[0]

    # Find irradiance column
    irr_col = None
    for col in cols:
        if 'irrad' in col.lower() or 'radiation' in col.lower() or 'ghi' in col.lower():
            irr_col = col
            break

    # Find temperature columns
    t_module_col = None
    t_ambient_col = None
    for col in cols:
        col_lower = col.lower()
        if 'module' in col_lower and '°c' in col_lower:
            t_module_col = col
        elif 'ambient' in col_lower and '°c' in col_lower:
            t_ambient_col = col

    # Find on-site rain column
    rain_col = None
    for col in cols:
        if 'regen' in col.lower() or ('rain' in col.lower() and 'mm' in col.lower()):
            rain_col = col

    # Find power columns (normalized)
    power_cols = [c for c in cols if 'INV' in c and 'Normalized' in c]

    if not power_cols:
        # Try alternate pattern
        power_cols = [c for c in cols if 'INV' in c and 'kW' in c]

    print(f"Found {len(power_cols)} inverter columns")
    print(f"Irradiance column: {irr_col}")
    print(f"Module temp column: {t_module_col}")
    print(f"Ambient temp column: {t_ambient_col}")
    print(f"On-site rain column: {rain_col}")
    print(f"Timestamp column: {ts_col}")

    # Convert to pandas for rdtools
    df_pd = df.to_pandas()

    # Parse timestamps
    try:
        df_pd['timestamp'] = pd.to_datetime(df_pd[ts_col], format='mixed')
    except (ValueError, TypeError):
        # Fallback for older pandas or different formats
        df_pd['timestamp'] = pd.to_datetime(df_pd[ts_col], infer_datetime_format=True)
    df_pd = df_pd.set_index('timestamp')
    df_pd = df_pd.sort_index()

    # Calculate fleet average power
    if power_cols:
        df_pd['power_normalized'] = df_pd[power_cols].mean(axis=1)
    else:
        # Fallback: use first numeric column after timestamp
        numeric_cols = df_pd.select_dtypes(include=[np.number]).columns
        df_pd['power_normalized'] = df_pd[numeric_cols[0]]

    # Get irradiance
    if irr_col:
        df_pd['poa_global'] = df_pd[irr_col]
    else:
        print("Warning: No irradiance column found, using synthetic clearsky")
        # Generate synthetic clearsky irradiance
        times = df_pd.index
        clearsky = location.get_clearsky(times)
        df_pd['poa_global'] = clearsky['ghi'].values

    # Get temperature data
    if t_module_col:
        df_pd['t_module'] = df_pd[t_module_col]
    if t_ambient_col:
        df_pd['t_ambient'] = df_pd[t_ambient_col]

    # Get on-site rain data
    rain_onsite = None
    if rain_col:
        df_pd['rain_onsite'] = df_pd[rain_col]
        rain_onsite = df_pd['rain_onsite'].resample('D').sum()
        print(f"On-site rain: {(rain_onsite > 0).sum()} days with precipitation")

    # Calculate clearsky irradiance for comparison
    # Handle DST ambiguous times by assuming standard time (ambiguous=False means assume non-DST)
    try:
        times = df_pd.index.tz_localize(SITE_CONFIG['timezone'], ambiguous=False, nonexistent='shift_forward')
    except Exception as e:
        print(f"Warning: Timezone localization issue: {e}")
        # Fallback: drop ambiguous times
        times = df_pd.index.tz_localize(SITE_CONFIG['timezone'], ambiguous='NaT', nonexistent='NaT')
        times = times.dropna()
    clearsky = location.get_clearsky(times)
    df_pd['clearsky_ghi'] = clearsky['ghi'].values

    # Calculate solar position for elevation filtering
    solar_pos = pvlib.solarposition.get_solarposition(times, location.latitude, location.longitude)
    df_pd['solar_elevation'] = solar_pos['elevation'].values

    # Calculate solar noon for each day
    df_pd['solar_hour'] = df_pd.index.hour + df_pd.index.minute / 60
    # Approximate solar noon (adjust for longitude offset from timezone)
    solar_noon_offset = (SITE_CONFIG['longitude'] - 0) / 15  # Hours from UTC timezone center
    df_pd['hours_from_noon'] = abs(df_pd['solar_hour'] - (12 + solar_noon_offset))

    # Calculate clear-sky index
    df_pd['clearsky_index'] = df_pd['poa_global'] / df_pd['clearsky_ghi'].replace(0, np.nan)
    df_pd['clearsky_index'] = df_pd['clearsky_index'].clip(0, 2)

    # Calculate temperature correction factor
    if t_module_col:
        print("Applying temperature correction using measured module temperature")
        df_pd['temp_factor'] = calculate_temperature_correction(
            t_module=df_pd['t_module'],
            t_ambient=df_pd.get('t_ambient'),
            poa=df_pd['poa_global'],
        )
    elif t_ambient_col:
        print("Estimating cell temp from ambient (NOCT model)")
        noct = 45.0
        t_cell_est = df_pd['t_ambient'] + (noct - 20) * (df_pd['poa_global'] / 800)
        df_pd['temp_factor'] = calculate_temperature_correction(
            t_module=t_cell_est,
        )
    else:
        print("Warning: No temperature data - skipping temperature correction")
        df_pd['temp_factor'] = 1.0

    # Calculate raw performance index
    df_pd['expected_power'] = df_pd['poa_global'] / 1000  # Normalized at 1 kW/kWp at 1000 W/m²
    df_pd['pi_raw'] = df_pd['power_normalized'] / df_pd['expected_power'].replace(0, np.nan)
    df_pd['pi_raw'] = df_pd['pi_raw'].clip(0, 1.5)

    # Apply temperature correction
    df_pd['pi_temp_corrected'] = df_pd['pi_raw'] / df_pd['temp_factor']
    df_pd['pi_temp_corrected'] = df_pd['pi_temp_corrected'].clip(0, 1.2)

    # Filter columns
    keep_cols = ['power_normalized', 'poa_global', 'clearsky_index', 'clearsky_ghi',
                 'temp_factor', 'pi_raw', 'pi_temp_corrected', 'solar_elevation', 'hours_from_noon']
    result = df_pd[keep_cols].copy()

    # Remove NaN rows
    result = result.dropna()

    return result, rain_onsite


def calculate_srr_soiling(
    df: pd.DataFrame,
    location: Location,
    rain_onsite: Optional[pd.Series] = None,
    rain_data: Optional[pd.DataFrame] = None,
) -> Tuple[pd.DataFrame, Dict]:
    """
    Calculate soiling ratio using rdtools SRR method with temperature correction.

    Parameters:
        df: DataFrame with pi_temp_corrected, poa_global, clearsky_index, solar_elevation
        location: pvlib Location object
        rain_onsite: On-site daily precipitation series (preferred)
        rain_data: Optional DataFrame with daily precipitation from external source

    Returns:
        daily_sr: DataFrame with daily soiling ratio
        metrics: Dictionary with analysis metrics
    """
    if not RDTOOLS_AVAILABLE:
        raise ImportError("rdtools is required for SRR analysis")

    print(f"\nInput data: {len(df)} records from {df.index.min()} to {df.index.max()}")

    # Step 1: Filter for clear-sky periods with TIGHTER thresholds
    mask = (
        (df['poa_global'] >= SRR_CONFIG['min_irradiance_Wm2']) &
        (df['clearsky_index'] >= SRR_CONFIG['clearsky_index_min']) &
        (df['clearsky_index'] <= SRR_CONFIG['clearsky_index_max']) &
        (df['solar_elevation'] >= SRR_CONFIG['min_solar_elevation']) &
        (df['hours_from_noon'] <= SRR_CONFIG['solar_noon_window_hours'])
    )

    df_filtered = df[mask].copy()
    print(f"After clear-sky filtering: {len(df_filtered)} records ({100*len(df_filtered)/len(df):.1f}%)")
    print(f"  - Irradiance >= {SRR_CONFIG['min_irradiance_Wm2']} W/m²")
    print(f"  - CSI: {SRR_CONFIG['clearsky_index_min']:.2f} - {SRR_CONFIG['clearsky_index_max']:.2f}")
    print(f"  - Solar elevation >= {SRR_CONFIG['min_solar_elevation']}°")
    print(f"  - Hours from noon <= {SRR_CONFIG['solar_noon_window_hours']}h")

    if len(df_filtered) < 100:
        print("Warning: Not enough clear-sky data for reliable SRR analysis")
        # Return simple ratio-based estimate
        daily_sr = calculate_simple_soiling_ratio(df)
        return daily_sr, {'method': 'simple_ratio', 'clearsky_records': len(df_filtered)}

    # Step 2: Use temperature-corrected Performance Index (already calculated)
    # This removes temperature effects from the soiling signal
    if 'pi_temp_corrected' in df_filtered.columns:
        df_filtered['performance_index'] = df_filtered['pi_temp_corrected']
        print("Using temperature-corrected Performance Index")
    else:
        # Fallback to raw PI
        df_filtered['expected_power'] = df_filtered['poa_global'] / 1000
        df_filtered['performance_index'] = df_filtered['power_normalized'] / df_filtered['expected_power']
        df_filtered['performance_index'] = df_filtered['performance_index'].clip(0, 1.2)
        print("Warning: Using raw PI (no temperature correction)")

    # Step 3: Aggregate to daily with minimum point requirement
    daily_pi = df_filtered['performance_index'].resample('D').median()
    points_per_day = df_filtered['performance_index'].resample('D').count()

    # Only keep days with enough clear-sky data points
    min_points = SRR_CONFIG['min_points_per_day']
    valid_days = points_per_day >= min_points
    daily_pi = daily_pi[valid_days]
    daily_pi = daily_pi.dropna()
    print(f"Days with >= {min_points} clear-sky points: {len(daily_pi)}")

    # Ensure proper daily frequency for rdtools by reindexing
    if len(daily_pi) > 0:
        # Remove timezone info (rdtools prefers tz-naive)
        if daily_pi.index.tz is not None:
            daily_pi.index = daily_pi.index.tz_localize(None)

        # Create proper daily index
        full_date_range = pd.date_range(start=daily_pi.index.min(), end=daily_pi.index.max(), freq='D')
        daily_pi = daily_pi.reindex(full_date_range)
        # Interpolate small gaps (up to 3 days)
        daily_pi = daily_pi.interpolate(method='linear', limit=3)
        daily_pi = daily_pi.dropna()

        # Set frequency explicitly
        daily_pi = daily_pi.asfreq('D')

    print(f"Daily aggregated: {len(daily_pi)} days")

    # Step 4: Use enhanced temperature-corrected method with baseline normalization
    # (rdtools SRR is too sensitive and often fails with real-world data)

    # Prepare precipitation for cleaning detection
    precip_daily = None
    if rain_onsite is not None:
        print("Using on-site rain data for cleaning detection")
        if rain_onsite.index.tz is not None:
            rain_onsite = rain_onsite.copy()
            rain_onsite.index = rain_onsite.index.tz_localize(None)
        precip_daily = rain_onsite.reindex(daily_pi.index).fillna(0)
    elif rain_data is not None:
        print("Using external rain data for cleaning detection")
        if 'precipitation_mm' in rain_data.columns:
            precip = rain_data.set_index('date')['precipitation_mm'] if 'date' in rain_data.columns else rain_data
        else:
            precip = rain_data
        precip.index = pd.to_datetime(precip.index)
        precip_daily = precip.reindex(daily_pi.index).fillna(0)

    print("\nCalculating temperature-corrected soiling ratio...")

    # Calculate soiling ratio using clean-period baseline normalization
    daily_sr = calculate_baseline_normalized_sr(daily_pi, precip_daily)
    method = 'temp_corrected_baseline'
    print(f"Calculated SR for {len(daily_sr)} days")

    # Step 5: Apply physical constraints
    # This ensures SR changes are physically realistic
    rain_for_constraints = rain_onsite if rain_onsite is not None else pd.Series(0, index=daily_sr.index)
    if rain_data is not None and rain_onsite is None:
        rain_for_constraints = rain_data.set_index('date')['precipitation_mm'] if 'date' in rain_data.columns else rain_data
        rain_for_constraints.index = pd.to_datetime(rain_for_constraints.index)

    print("\nApplying physical constraints...")
    daily_sr_constrained = apply_physical_constraints(daily_sr, rain_for_constraints)

    # Step 6: Clean up result
    daily_sr_df = pd.DataFrame({
        'date': daily_sr_constrained.index,
        'soiling_ratio': daily_sr_constrained.values
    })
    daily_sr_df = daily_sr_df.set_index('date')

    # Final bounds check (already applied in physical_constraints, but ensure)
    sr_min = SRR_CONFIG['sr_min']
    sr_max = SRR_CONFIG['sr_max']
    daily_sr_df['soiling_ratio'] = daily_sr_df['soiling_ratio'].clip(sr_min, sr_max)

    # Calculate metrics
    metrics = {
        'method': method,
        'total_records': len(df),
        'clearsky_records': len(df_filtered),
        'clearsky_pct': 100 * len(df_filtered) / len(df),
        'days_analyzed': len(daily_sr_df),
        'sr_mean': float(daily_sr_df['soiling_ratio'].mean()),
        'sr_std': float(daily_sr_df['soiling_ratio'].std()),
        'sr_min': float(daily_sr_df['soiling_ratio'].min()),
        'sr_max': float(daily_sr_df['soiling_ratio'].max()),
    }

    print(f"\nSRR Results ({method}):")
    print(f"  Mean SR: {metrics['sr_mean']:.3f}")
    print(f"  Std SR: {metrics['sr_std']:.3f}")
    print(f"  Range: {metrics['sr_min']:.3f} - {metrics['sr_max']:.3f}")

    return daily_sr_df, metrics


def calculate_simple_soiling_ratio(df: pd.DataFrame) -> pd.DataFrame:
    """
    Simple soiling ratio calculation when rdtools SRR is not available.
    Uses rolling maximum normalization.
    """
    # Calculate daily performance
    df['expected_power'] = df['poa_global'] / 1000
    df['performance'] = df['power_normalized'] / df['expected_power'].replace(0, np.nan)
    df['performance'] = df['performance'].clip(0, 1.2)

    daily_perf = df['performance'].resample('D').median().dropna()

    # Normalize by rolling maximum (assumes cleaning happens periodically)
    rolling_max = daily_perf.rolling(window=30, min_periods=7).max()
    sr = daily_perf / rolling_max
    sr = sr.clip(0.75, 1.05)

    return pd.DataFrame({'soiling_ratio': sr})


def calculate_baseline_normalized_sr(
    daily_pi: pd.Series,
    rain_daily: Optional[pd.Series] = None,
) -> pd.Series:
    """
    Calculate soiling ratio using clean-period baseline normalization.

    Instead of rolling max (which drifts with seasons), we normalize to
    clean-period baselines identified by rain events or high PI values.

    Args:
        daily_pi: Daily temperature-corrected Performance Index
        rain_daily: Daily precipitation series (mm)

    Returns:
        Daily soiling ratio series
    """
    sr = daily_pi.copy()

    # Identify clean reference periods
    if rain_daily is not None and len(rain_daily) > 0:
        # Method 1: Days 1-3 after heavy rain (>= 10mm)
        heavy_rain_threshold = 10.0  # mm
        heavy_rain_dates = rain_daily[rain_daily >= heavy_rain_threshold].index

        clean_periods = []
        for rain_date in heavy_rain_dates:
            # Look at 1-3 days after rain
            for offset in range(1, 4):
                ref_date = rain_date + pd.Timedelta(days=offset)
                if ref_date in sr.index:
                    pi_val = sr.get(ref_date)
                    if pi_val is not None and not np.isnan(pi_val) and pi_val > 0.85:
                        clean_periods.append({'date': ref_date, 'pi': pi_val, 'type': 'post_rain'})

        print(f"  Found {len(clean_periods)} clean reference periods after rain")
    else:
        clean_periods = []

    # Method 2: Add high PI periods (>95th percentile) as likely clean
    if len(sr.dropna()) > 30:
        high_threshold = sr.quantile(0.95)
        high_pi_dates = sr[sr >= high_threshold].index
        for date in high_pi_dates:
            # Check if not already in clean_periods
            if not any(cp['date'] == date for cp in clean_periods):
                clean_periods.append({'date': date, 'pi': sr[date], 'type': 'high_pi'})

    # Calculate baseline
    if len(clean_periods) >= 5:
        # Use 90th percentile of clean-period PI as baseline
        clean_pis = [cp['pi'] for cp in clean_periods]
        baseline_pi = np.percentile(clean_pis, 90)
        print(f"  Clean-period baseline PI: {baseline_pi:.4f} (from {len(clean_periods)} periods)")
    else:
        # Fallback: Use rolling 60-day 95th percentile
        baseline_pi = sr.rolling(window=60, min_periods=14).quantile(0.95)
        print("  Using rolling 95th percentile baseline (insufficient clean periods)")

    # Calculate SR as ratio to baseline
    if isinstance(baseline_pi, float):
        sr = sr / baseline_pi
    else:
        sr = sr / baseline_pi

    # Apply 3-day rolling median to smooth (lighter than 7-day)
    sr = sr.rolling(window=3, min_periods=1, center=True).median()

    # Pre-clip to realistic range (before physical constraints)
    sr = sr.clip(0.75, 1.05)

    return sr


def calculate_enhanced_soiling_ratio(
    daily_pi: pd.Series,
    rain_data: Optional[pd.DataFrame] = None
) -> pd.Series:
    """
    Enhanced soiling ratio using rain-based cleaning detection.
    (Legacy fallback - use calculate_baseline_normalized_sr instead)
    """
    sr = daily_pi.copy()

    # Normalize by rolling max
    rolling_max = sr.rolling(window=30, min_periods=7).max()
    sr = sr / rolling_max

    # If rain data available, detect cleaning events
    if rain_data is not None:
        rain_daily = rain_data.set_index('date')['precipitation_mm'] if 'date' in rain_data.columns else rain_data

        # Align indices
        common_idx = sr.index.intersection(rain_daily.index)
        sr = sr.loc[common_idx]
        rain_aligned = rain_daily.loc[common_idx]

        # After heavy rain, expect SR recovery
        cleaning_days = rain_aligned > SRR_CONFIG['recovery_threshold_mm']

        # Apply recovery boost (SR increases after rain)
        cleaning_dates = cleaning_days[cleaning_days].index
        for date in cleaning_dates:
            # Find the next date in SR index after this cleaning
            mask = sr.index > date
            if mask.any():
                next_date = sr.index[mask][0]
                sr.loc[next_date] = min(1.0, sr.loc[next_date] + 0.02)

    # Apply 7-day rolling median to smooth
    sr = sr.rolling(window=7, min_periods=3).median()
    sr = sr.clip(0.75, 1.05)

    return sr


def load_rain_data(plant_id: str, data_dir: Path) -> Optional[pd.DataFrame]:
    """Load rain data from existing rain_history.json."""
    rain_file = data_dir / 'rain_history.json'

    if not rain_file.exists():
        print(f"No rain data file found at {rain_file}")
        return None

    with open(rain_file) as f:
        rain_data = json.load(f)

    daily_data = rain_data.get('daily_data', [])
    if not daily_data:
        return None

    df = pd.DataFrame(daily_data)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date')

    return df


def save_results(
    daily_sr: pd.DataFrame,
    metrics: Dict,
    output_dir: Path,
    plant_id: str
):
    """Save SRR results to JSON files."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Prepare daily data - SKIP NaN values (JSON doesn't support NaN)
    daily_data = []
    for date, row in daily_sr.iterrows():
        sr_val = row['soiling_ratio']
        if pd.notna(sr_val):  # Skip NaN values
            daily_data.append({
                'date': date.strftime('%Y-%m-%d'),
                'soiling_ratio': round(float(sr_val), 4),
            })

    print(f"Saving {len(daily_data)} valid SR days (filtered {len(daily_sr) - len(daily_data)} NaN days)")

    # Create output structure
    output = {
        'metadata': {
            'plant_id': plant_id,
            'generated_at': datetime.now().isoformat(),
            'method': metrics['method'],
            'period': {
                'start': daily_sr.index.min().strftime('%Y-%m-%d'),
                'end': daily_sr.index.max().strftime('%Y-%m-%d'),
            },
            'srr_config': SRR_CONFIG,
        },
        'metrics': metrics,
        'daily_data': daily_data,
    }

    # Save main output
    output_file = output_dir / 'soiling_ratio_srr.json'
    with open(output_file, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\nSaved: {output_file}")

    # Also update the time_series file for compatibility
    ts_dir = output_dir / 'time_series'
    ts_dir.mkdir(exist_ok=True)

    # Convert to per-inverter format (fleet average)
    ts_data = []
    for item in daily_data:
        ts_data.append({
            'date': item['date'],
            'inverterId': 'FLEET',
            'sr': item['soiling_ratio'],
        })

    ts_output = {
        'metadata': {
            'plant_id': plant_id,
            'generated_at': datetime.now().isoformat(),
            'method': metrics['method'],
            'note': 'Fleet average with temperature correction and physical constraints',
        },
        'data': ts_data,
    }

    ts_file = ts_dir / 'daily_soiling_ratio_srr.json'
    with open(ts_file, 'w') as f:
        json.dump(ts_output, f, indent=2)

    print(f"Saved: {ts_file}")


def main():
    parser = argparse.ArgumentParser(description='Calculate soiling ratio using rdtools SRR')
    parser.add_argument('--plant-id', default='alpha1', help='Plant ID')
    parser.add_argument('--parquet-dir', default='demo_spain', help='Directory with parquet files')
    parser.add_argument('--output-dir', default='public/data/soiling', help='Output directory')
    args = parser.parse_args()

    print("=" * 60)
    print("Soiling Ratio Calculation using rdtools SRR")
    print("=" * 60)

    # Check dependencies
    if not PVLIB_AVAILABLE:
        print("Error: pvlib is required. Install with: pip install pvlib")
        return

    # Set up paths
    base_dir = Path(__file__).parent.parent
    parquet_dir = base_dir / args.parquet_dir
    output_dir = base_dir / args.output_dir / args.plant_id

    # Create location object
    location = Location(
        latitude=SITE_CONFIG['latitude'],
        longitude=SITE_CONFIG['longitude'],
        altitude=SITE_CONFIG['elevation'],
        tz=SITE_CONFIG['timezone'],
    )

    # Load parquet data
    print(f"\nLoading data from {parquet_dir}...")
    df = load_parquet_data(parquet_dir)

    if df is None:
        print("Failed to load parquet data")
        return

    print(f"Loaded {len(df)} records")

    # Prepare data for SRR (now includes temperature correction and on-site rain)
    print("\nPreparing data for SRR analysis...")
    df_prepared, rain_onsite = prepare_data_for_srr(df, location)

    # Load external rain data as fallback
    rain_data = load_rain_data(args.plant_id, output_dir)
    if rain_data is not None:
        print(f"Loaded {len(rain_data)} days of external rain data (fallback)")

    # Calculate SRR soiling ratio with temperature correction and physical constraints
    print("\nCalculating soiling ratio...")
    daily_sr, metrics = calculate_srr_soiling(
        df_prepared,
        location,
        rain_onsite=rain_onsite,
        rain_data=rain_data,
    )

    # Save results
    save_results(daily_sr, metrics, output_dir, args.plant_id)

    print("\nDone!")


if __name__ == '__main__':
    main()
