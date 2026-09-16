"""
Forecast-Driven Cleaning Schedule Optimization (Python Backend)

Smart optimization system that uses:
- ML predictions as primary soiling forecast (replaces physics simulation)
- AOD trends for dust exposure risk scoring
- Rain forecasts for deferral logic and natural cleaning

Mirrors TypeScript implementation for cross-platform consistency.
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta

# ============================================================
# Core Algorithm Constants
# ============================================================

CLEANING_RECOVERY_SR = 1.0         # Clean panels return to 100% SR — matches frontend whatif.ts
MIN_SR_FLOOR = 0.80                # Physical floor for heavily soiled panels
DECAY_TIME_CONSTANT = 30.0         # Days to decay toward ML prediction

# AOD adjustment constants
AOD_SENSITIVITY = 0.20             # ±20% soiling rate per 0.10 AOD deviation
AOD_DEVIATION_UNIT = 0.10          # Base AOD deviation unit
AOD_ADJUSTMENT_MIN = 0.50          # Minimum adjustment factor (50%)
AOD_ADJUSTMENT_MAX = 1.50          # Maximum adjustment factor (150%)

# Rain deferral constants
RAIN_LARGE_MM = 5.0                # Large rain event threshold
RAIN_MEDIUM_MM = 2.0               # Medium rain event threshold
RAIN_LARGE_PROB_THRESHOLD = 60     # Probability threshold for large rain (cumulative %)
RAIN_MEDIUM_PROB_THRESHOLD = 40    # Probability threshold for medium rain (cumulative %)
RAIN_DEFERRAL_PENALTY_LARGE = -100 # Penalty for cleaning before large rain
RAIN_DEFERRAL_PENALTY_MEDIUM = -50 # Penalty for cleaning before medium rain

# Natural rain cleaning constants
RAIN_CLEANING_THRESHOLD = 5.0      # Rain amount for natural cleaning (mm)
RAIN_CLEANING_MAX_BOOST = 0.05     # Maximum SR boost from rain cleaning


# ============================================================
# Main Entry Point
# ============================================================

def calculate_forecast_driven_cost_benefit(
    cleaning_dates: List[str],
    df_ml_forecast: pd.DataFrame,
    df_aod_forecast: Optional[pd.DataFrame],
    df_rain_forecast: Optional[pd.DataFrame],
    parameters: Dict
) -> Dict:
    """
    Calculate cost/benefit using forecast-driven algorithm.

    Algorithm steps:
    1. Build SR timeline using ML predictions (not linear decay)
    2. Apply AOD dynamic adjustments (if forecast available)
    3. Apply rain deferrals and natural cleaning (if forecast available)
    4. Calculate energy metrics
    5. Calculate financial metrics

    Parameters:
    -----------
    cleaning_dates : List[str]
        Cleaning dates in YYYY-MM-DD format
    df_ml_forecast : pd.DataFrame
        365-day ML forecast with columns: date, sr_predicted, energy_if_clean_MWh, etc.
        Index should be datetime
    df_aod_forecast : pd.DataFrame, optional
        5-day AOD forecast with columns: date, aod_550nm_mean
    df_rain_forecast : pd.DataFrame, optional
        16-day rain forecast with columns: date, precipitation_mm, precipitation_probability
    parameters : dict
        Economic and operational parameters

    Returns:
    --------
    dict
        Cost/benefit result with keys:
        - cleaning_dates, n_cleanings
        - energy_recovered_MWh, revenue_recovered_EUR
        - cleaning_cost_EUR, net_benefit_EUR, roi_pct
        - avg_sr_with_cleaning, avg_sr_without_cleaning
        - calculation_method
    """
    # Validate inputs
    if df_ml_forecast is None or len(df_ml_forecast) == 0:
        raise ValueError('ML forecast data is required for forecast-driven calculation')

    # Build SR timeline using ML predictions
    df_sr_timeline = build_ml_sr_timeline(df_ml_forecast, cleaning_dates)

    # Calculate baseline AOD for adjustments
    baseline_aod = None
    if df_aod_forecast is not None and len(df_aod_forecast) > 0:
        baseline_aod = calculate_historical_aod_baseline(df_ml_forecast)

    # Apply AOD adjustments if forecast available
    if df_aod_forecast is not None and len(df_aod_forecast) > 0 and baseline_aod is not None:
        apply_aod_dynamic_adjustments(df_sr_timeline, df_aod_forecast, baseline_aod)

    # Apply rain deferrals and natural cleaning if forecast available
    if df_rain_forecast is not None and len(df_rain_forecast) > 0:
        apply_rain_deferrals(df_sr_timeline, df_rain_forecast, cleaning_dates)

    # Calculate energy and financial metrics
    result = calculate_metrics(df_sr_timeline, df_ml_forecast, cleaning_dates, parameters)

    # Add calculation method metadata
    has_aod = df_aod_forecast is not None and len(df_aod_forecast) > 0
    has_rain = df_rain_forecast is not None and len(df_rain_forecast) > 0

    if has_aod and has_rain:
        result['calculation_method'] = 'forecast-driven-full'
    elif has_aod or has_rain:
        result['calculation_method'] = 'forecast-driven-partial'
    else:
        result['calculation_method'] = 'forecast-driven-ml-only'

    return result


# ============================================================
# ML-Based SR Timeline Builder
# ============================================================

def build_ml_sr_timeline(
    df_ml_forecast: pd.DataFrame,
    cleaning_dates: List[str]
) -> pd.DataFrame:
    """
    Build soiling ratio timeline using ML predictions.

    Key innovation: Decay TOWARD ML prediction (not linear decay)
    - Cleaning day: SR = 1.0 (restore to 100%)
    - Normal day: Decay from current SR toward ML prediction with confidence weighting

    Parameters:
    -----------
    df_ml_forecast : pd.DataFrame
        365-day ML forecast with sr_predicted column
    cleaning_dates : List[str]
        Cleaning date strings (YYYY-MM-DD)

    Returns:
    --------
    pd.DataFrame
        SR timeline with columns:
        - sr: current soiling ratio
        - ml_baseline: ML predicted SR
        - is_cleaning: boolean
        - aod_adjustment, dust_risk, rain_deferral_penalty, etc. (initialized)
    """
    df_timeline = df_ml_forecast.copy()

    # Convert cleaning dates to set for O(1) lookup
    cleaning_set = set(pd.to_datetime(cleaning_dates))

    # Check if cleaning occurs for each day
    df_timeline['is_cleaning'] = df_timeline.index.isin(cleaning_set)

    # Initialize ML baseline and other columns
    df_timeline['ml_baseline'] = df_timeline['sr_predicted']
    df_timeline['aod_adjustment'] = None
    df_timeline['dust_risk'] = None
    df_timeline['rain_deferral_penalty'] = None
    df_timeline['rain_recommendation'] = None
    df_timeline['rain_cleaning'] = False

    # Build SR timeline iteratively (confidence-weighted decay)
    current_sr = 1.0  # Start perfectly clean
    sr_values = []

    for idx, row in df_timeline.iterrows():
        if row['is_cleaning']:
            # Cleaning day: restore to 95%
            current_sr = CLEANING_RECOVERY_SR
        else:
            # Normal day: decay toward ML prediction
            ml_sr = row['sr_predicted']
            confidence = row.get('confidence', 1.0)

            # Calculate decay rate based on distance to ML prediction
            decay_rate = (current_sr - ml_sr) / DECAY_TIME_CONSTANT * confidence
            current_sr = max(current_sr - decay_rate, MIN_SR_FLOOR)

        sr_values.append(current_sr)

    df_timeline['sr'] = sr_values

    return df_timeline


# ============================================================
# AOD Dynamic Adjustments
# ============================================================

def calculate_historical_aod_baseline(df_ml_forecast: pd.DataFrame) -> float:
    """
    Calculate historical AOD baseline from ML forecast data.

    Uses average of first 30 days as representative baseline.

    Parameters:
    -----------
    df_ml_forecast : pd.DataFrame
        365-day ML forecast

    Returns:
    --------
    float
        Baseline AOD value
    """
    # Use first 30 days as historical baseline
    historical_period = df_ml_forecast.iloc[:min(30, len(df_ml_forecast))]

    # Estimate baseline from soiling loss (higher loss = higher AOD)
    avg_soiling_loss = historical_period['soiling_loss_pct'].mean()

    # Typical AOD range: 0.05 (clean) to 0.30 (dusty)
    # Map soiling loss (2-10%) to AOD (0.05-0.25)
    estimated_baseline = 0.05 + (avg_soiling_loss / 10.0) * 0.20

    return estimated_baseline


def apply_aod_dynamic_adjustments(
    df_sr_timeline: pd.DataFrame,
    df_aod_forecast: pd.DataFrame,
    baseline_aod: float
) -> None:
    """
    Apply AOD-based dynamic adjustments to soiling rates (in-place).

    Logic:
    - Calculate AOD deviation from baseline
    - Adjust soiling rate by ±20% per 0.10 AOD deviation (capped ±50%)
    - Classify dust risk level for UI display

    Parameters:
    -----------
    df_sr_timeline : pd.DataFrame
        SR timeline to modify in-place
    df_aod_forecast : pd.DataFrame
        5-day AOD forecast with aod_550nm_mean column
    baseline_aod : float
        Historical baseline AOD
    """
    # Create date lookup for AOD values
    aod_by_date = df_aod_forecast.set_index(df_aod_forecast.index)['aod_550nm_mean'].to_dict()

    # Apply adjustments to each day in forecast window
    for idx in df_sr_timeline.index:
        if idx in aod_by_date and not df_sr_timeline.loc[idx, 'is_cleaning']:
            current_aod = aod_by_date[idx]
            if pd.isna(current_aod):
                continue

            aod_deviation = current_aod - baseline_aod

            # Calculate adjustment factor
            adjustment_factor = 1.0 + (aod_deviation / AOD_DEVIATION_UNIT) * AOD_SENSITIVITY
            capped_factor = np.clip(adjustment_factor, AOD_ADJUSTMENT_MIN, AOD_ADJUSTMENT_MAX)

            # Apply adjustment (increases soiling if high dust)
            soiling_rate = 1 - df_sr_timeline.loc[idx, 'sr']
            adjusted_sr = 1 - (soiling_rate * capped_factor)
            df_sr_timeline.loc[idx, 'sr'] = max(adjusted_sr, MIN_SR_FLOOR)
            df_sr_timeline.loc[idx, 'aod_adjustment'] = capped_factor
            df_sr_timeline.loc[idx, 'dust_risk'] = classify_dust_risk(aod_deviation)


def classify_dust_risk(aod_deviation: float) -> str:
    """
    Classify dust risk level based on AOD deviation.

    Parameters:
    -----------
    aod_deviation : float
        Deviation from baseline AOD

    Returns:
    --------
    str
        Dust risk level: 'low', 'normal', 'elevated', 'high'
    """
    if aod_deviation < -0.05:
        return 'low'
    elif aod_deviation < 0.05:
        return 'normal'
    elif aod_deviation < 0.15:
        return 'elevated'
    else:
        return 'high'


# ============================================================
# Rain Deferral Logic
# ============================================================

def apply_rain_deferrals(
    df_sr_timeline: pd.DataFrame,
    df_rain_forecast: pd.DataFrame,
    cleaning_dates: List[str]
) -> None:
    """
    Apply rain-based deferral logic and natural cleaning (in-place).

    Logic:
    1. For each cleaning date, check 3-7 day window for rain
    2. Apply penalty if significant rain expected (defer cleaning)
    3. Apply natural rain cleaning boost for heavy rain events

    Parameters:
    -----------
    df_sr_timeline : pd.DataFrame
        SR timeline to modify in-place
    df_rain_forecast : pd.DataFrame
        16-day rain forecast with precipitation_mm, precipitation_probability columns
    cleaning_dates : List[str]
        Cleaning date strings
    """
    # Create date lookup for rain values
    rain_by_date = df_rain_forecast.set_index(df_rain_forecast.index).to_dict('index')

    # Check each cleaning date for rain in 3-7 day window
    for cleaning_date_str in cleaning_dates:
        cleaning_date = pd.to_datetime(cleaning_date_str)

        # Check 3-7 day window after cleaning
        window_start = cleaning_date + timedelta(days=3)
        window_end = cleaning_date + timedelta(days=7)

        rain_window = []
        current_date = window_start
        while current_date <= window_end:
            if current_date in rain_by_date:
                rain_window.append(rain_by_date[current_date])
            current_date += timedelta(days=1)

        if rain_window:
            total_rain_prob = sum(r['precipitation_probability'] for r in rain_window)
            max_rain_mm = max(r['precipitation_mm'] for r in rain_window)

            if cleaning_date in df_sr_timeline.index:
                # Apply deferral penalty based on rain intensity and probability
                if max_rain_mm > RAIN_LARGE_MM and total_rain_prob > RAIN_LARGE_PROB_THRESHOLD:
                    df_sr_timeline.loc[cleaning_date, 'rain_deferral_penalty'] = RAIN_DEFERRAL_PENALTY_LARGE
                    df_sr_timeline.loc[cleaning_date, 'rain_recommendation'] = (
                        f'DEFER: {max_rain_mm:.1f}mm rain expected ({total_rain_prob:.0f}% cumulative probability)'
                    )
                elif max_rain_mm > RAIN_MEDIUM_MM and total_rain_prob > RAIN_MEDIUM_PROB_THRESHOLD:
                    df_sr_timeline.loc[cleaning_date, 'rain_deferral_penalty'] = RAIN_DEFERRAL_PENALTY_MEDIUM
                    df_sr_timeline.loc[cleaning_date, 'rain_recommendation'] = (
                        f'CONSIDER DEFERRING: {max_rain_mm:.1f}mm rain possible ({total_rain_prob:.0f}% probability)'
                    )

    # Apply natural rain cleaning boosts
    for rain_date, rain_data in rain_by_date.items():
        if rain_data['precipitation_mm'] > RAIN_CLEANING_THRESHOLD:
            if rain_date in df_sr_timeline.index and not df_sr_timeline.loc[rain_date, 'is_cleaning']:
                # Natural rain cleaning boost (up to 5% SR improvement)
                cleaning_boost = min(RAIN_CLEANING_MAX_BOOST, rain_data['precipitation_mm'] / 100)
                current_sr = df_sr_timeline.loc[rain_date, 'sr']
                df_sr_timeline.loc[rain_date, 'sr'] = min(current_sr + cleaning_boost, 1.0)
                df_sr_timeline.loc[rain_date, 'rain_cleaning'] = True


# ============================================================
# Energy & Financial Metrics Calculation
# ============================================================

def calculate_metrics(
    df_sr_timeline: pd.DataFrame,
    df_ml_forecast: pd.DataFrame,
    cleaning_dates: List[str],
    parameters: Dict
) -> Dict:
    """
    Calculate energy and financial metrics from SR timeline.

    Parameters:
    -----------
    df_sr_timeline : pd.DataFrame
        SR timeline with sr column
    df_ml_forecast : pd.DataFrame
        ML forecast (for energy calculations)
    cleaning_dates : List[str]
        Cleaning dates
    parameters : dict
        Economic parameters (capacity_MW, cleaning_cost_per_MW, electricity_rate_per_MWh)

    Returns:
    --------
    dict
        Cost/benefit result
    """
    # Calculate energy recovery for each day
    energy_with_cleaning = df_ml_forecast['energy_if_clean_MWh'] * df_sr_timeline['sr']
    energy_without_cleaning = df_ml_forecast['energy_with_soiling_MWh']

    energy_recovered = (energy_with_cleaning - energy_without_cleaning).clip(lower=0).sum()

    # Calculate averages
    avg_sr_with_cleaning = df_sr_timeline['sr'].mean()
    avg_sr_without_cleaning = df_ml_forecast['sr_predicted'].mean()

    # Calculate financial metrics
    total_cost = len(cleaning_dates) * parameters['capacity_MW'] * parameters['cleaning_cost_per_MW']
    revenue_recovered = energy_recovered * parameters['electricity_rate_per_MWh']
    net_benefit = revenue_recovered - total_cost
    roi_pct = (net_benefit / total_cost * 100) if total_cost > 0 else 0

    return {
        'cleaning_dates': cleaning_dates,
        'n_cleanings': len(cleaning_dates),
        'cleaning_cost_EUR': round(total_cost, 2),
        'energy_recovered_MWh': round(energy_recovered, 3),
        'revenue_recovered_EUR': round(revenue_recovered, 2),
        'net_benefit_EUR': round(net_benefit, 2),
        'roi_pct': round(roi_pct, 1),
        'avg_sr_with_cleaning': round(avg_sr_with_cleaning, 4),
        'avg_sr_without_cleaning': round(avg_sr_without_cleaning, 4),
    }
