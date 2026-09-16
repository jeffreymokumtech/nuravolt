"""Cleaning event detection using semi-supervised approach."""

import pandas as pd


def detect_cleaning_events(df_daily, cleaning_threshold_sr=0.06, rain_threshold=10.0):
    """
    Detect manual and rain cleaning events using SR change analysis.

    This is a semi-supervised approach that identifies cleaning events based on:
    - Manual cleaning: Large SR jumps (>6%) with minimal rainfall
    - Rain cleaning: Moderate SR jumps (>2%) with significant rainfall

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily aggregated data with 'soiling_ratio_smooth' and 'rainfall' columns
    cleaning_threshold_sr : float
        SR change threshold for manual cleaning detection (default: 0.06 = 6%)
    rain_threshold : float
        Rainfall threshold in mm to distinguish rain vs manual cleaning (default: 10.0)

    Returns:
    --------
    df_daily : pandas.DataFrame
        Input DataFrame with added columns:
        - 'sr_change': Daily change in soiling ratio
        - 'is_manual_cleaning': Boolean flag for detected manual cleanings
        - 'is_rain_cleaning': Boolean flag for detected rain cleanings

    Examples:
    ---------
    >>> df_daily = detect_cleaning_events(df_daily)
    >>> n_manual = df_daily['is_manual_cleaning'].sum()
    >>> print(f"Detected {n_manual} manual cleaning events")
    """
    # Calculate SR change over 24 hours
    df_daily['sr_change'] = df_daily['soiling_ratio_smooth'].diff()

    # Identify manual cleaning events (SR jump >threshold AND rainfall <rain_threshold)
    df_daily['is_manual_cleaning'] = (
        (df_daily['sr_change'] > cleaning_threshold_sr) &
        (df_daily['rainfall'] < rain_threshold)
    )

    # Identify rain cleaning events (SR jump >0.02 AND rainfall >=rain_threshold)
    df_daily['is_rain_cleaning'] = (
        (df_daily['sr_change'] > 0.02) &
        (df_daily['rainfall'] >= rain_threshold)
    )

    # Count events
    n_manual_cleanings = df_daily['is_manual_cleaning'].sum()
    n_rain_cleanings = df_daily['is_rain_cleaning'].sum()

    print(f"✅ Cleaning events detected (semi-supervised):")
    print(f"   Manual cleanings: {n_manual_cleanings} events")
    print(f"   Rain cleanings: {n_rain_cleanings} events")
    print(f"   Total: {n_manual_cleanings + n_rain_cleanings} events")

    return df_daily


def detect_cleaning_events_power_based(df_pd, df_daily, power_jump_threshold_pct=8.0,
                                        rain_threshold=10.0):
    """
    Detect cleaning events using normalized power jump analysis.

    This method complements SR-based detection by using power data, which can be
    more reliable during:
    - Cloudy periods (when clearsky modeling is less accurate)
    - Periods with noisy irradiance sensors
    - Multi-day cleaning events (power increases even if SR calculation is affected)

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        15-minute data with 'power_inverter', 'power_janitza', 'poa_clearsky' columns
    df_daily : pandas.DataFrame
        Daily aggregated data with 'rainfall' column
    power_jump_threshold_pct : float
        Power increase threshold for manual cleaning detection (default: 8.0%)
    rain_threshold : float
        Rainfall threshold in mm (default: 10.0)

    Returns:
    --------
    df_daily : pandas.DataFrame
        Input DataFrame with added columns:
        - 'power_ratio_normalized': Daily average normalized power
        - 'power_change': Daily change in normalized power
        - 'is_manual_cleaning_power': Boolean flag for power-detected manual cleanings
        - 'is_rain_cleaning_power': Boolean flag for power-detected rain cleanings

    Notes:
    ------
    Normalized power is calculated as:
        power_ratio = (actual_power / clearsky_poa)
    This removes the influence of weather variations and isolates soiling effects.
    """
    import numpy as np

    # Calculate normalized power ratio (power per unit clearsky POA)
    # Use average of inverter and janitza power for robustness
    df_pd['power_actual'] = df_pd[['power_inverter', 'power_janitza']].mean(axis=1)

    # Normalize by clearsky POA (higher POA should produce more power when clean)
    # This removes weather effects and isolates soiling
    df_pd['power_ratio_normalized'] = np.where(
        df_pd['poa_clearsky'] > 100,  # Only for significant irradiance
        df_pd['power_actual'] / df_pd['poa_clearsky'],
        np.nan
    )

    # Aggregate to daily average normalized power
    df_daily['power_ratio_normalized'] = df_pd.resample('1D')['power_ratio_normalized'].mean()

    # Calculate daily change in normalized power
    df_daily['power_change'] = df_daily['power_ratio_normalized'].diff()

    # Calculate percentage change for better threshold interpretation
    df_daily['power_change_pct'] = (
        df_daily['power_change'] / df_daily['power_ratio_normalized'].shift(1) * 100
    )

    # Manual cleaning: Large power jump (>threshold%) with minimal rainfall
    df_daily['is_manual_cleaning_power'] = (
        (df_daily['power_change_pct'] > power_jump_threshold_pct) &
        (df_daily['rainfall'] < rain_threshold)
    )

    # Rain cleaning: Moderate power jump (>3%) with significant rainfall
    df_daily['is_rain_cleaning_power'] = (
        (df_daily['power_change_pct'] > 3.0) &
        (df_daily['rainfall'] >= rain_threshold)
    )

    # Count events
    n_manual_power = df_daily['is_manual_cleaning_power'].sum()
    n_rain_power = df_daily['is_rain_cleaning_power'].sum()

    print(f"✅ Cleaning events detected (power-based):")
    print(f"   Manual cleanings: {n_manual_power} events")
    print(f"   Rain cleanings: {n_rain_power} events")
    print(f"   Total: {n_manual_power + n_rain_power} events")

    return df_daily


def detect_cleaning_events_hybrid(df_pd, df_daily,
                                   sr_threshold=0.06,
                                   power_threshold=8.0,
                                   rain_threshold=10.0):
    """
    Hybrid cleaning detection combining SR-based and power-based methods.

    Uses both methods to maximize detection coverage and add confidence scoring:
    - High confidence: Both methods detect the same event
    - Medium confidence: Only one method detects the event

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        15-minute data with power and irradiance columns
    df_daily : pandas.DataFrame
        Daily data with SR and rainfall columns
    sr_threshold : float
        SR change threshold (default: 0.06 = 6%)
    power_threshold : float
        Power change threshold (default: 8.0%)
    rain_threshold : float
        Rainfall threshold in mm (default: 10.0)

    Returns:
    --------
    df_daily : pandas.DataFrame
        DataFrame with hybrid detection results and confidence scores
    """
    # Run both detection methods
    df_daily = detect_cleaning_events(df_daily, sr_threshold, rain_threshold)
    df_daily = detect_cleaning_events_power_based(df_pd, df_daily, power_threshold, rain_threshold)

    # Combine results with logical OR (detected by either method)
    df_daily['is_manual_cleaning_hybrid'] = (
        df_daily['is_manual_cleaning'] |
        df_daily['is_manual_cleaning_power']
    )

    df_daily['is_rain_cleaning_hybrid'] = (
        df_daily['is_rain_cleaning'] |
        df_daily['is_rain_cleaning_power']
    )

    # Add confidence scoring
    # High confidence = both methods agree, Medium = one method only
    df_daily['manual_cleaning_confidence'] = 'none'
    df_daily.loc[df_daily['is_manual_cleaning'] & df_daily['is_manual_cleaning_power'],
                 'manual_cleaning_confidence'] = 'high'
    df_daily.loc[df_daily['is_manual_cleaning'] ^ df_daily['is_manual_cleaning_power'],
                 'manual_cleaning_confidence'] = 'medium'

    # Summary statistics
    n_hybrid_manual = df_daily['is_manual_cleaning_hybrid'].sum()
    n_hybrid_rain = df_daily['is_rain_cleaning_hybrid'].sum()
    n_high_conf = (df_daily['manual_cleaning_confidence'] == 'high').sum()
    n_medium_conf = (df_daily['manual_cleaning_confidence'] == 'medium').sum()

    print(f"\n✅ Hybrid detection summary:")
    print(f"   Total manual cleanings: {n_hybrid_manual} events")
    print(f"   Total rain cleanings: {n_hybrid_rain} events")
    print(f"   High confidence (both methods): {n_high_conf} events")
    print(f"   Medium confidence (one method): {n_medium_conf} events")

    return df_daily


def get_cleaning_dates(df_daily, event_type='manual', max_results=10):
    """
    Get list of detected cleaning event dates with details.

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily data with cleaning event flags
    event_type : str
        Type of cleaning events to retrieve: 'manual', 'rain', or 'all'
    max_results : int
        Maximum number of events to return (default: 10)

    Returns:
    --------
    list of dict
        List of cleaning events with date, SR before/after, and gain
    """
    if event_type == 'manual':
        events_df = df_daily[df_daily['is_manual_cleaning']]
    elif event_type == 'rain':
        events_df = df_daily[df_daily['is_rain_cleaning']]
    else:  # 'all'
        events_df = df_daily[
            df_daily['is_manual_cleaning'] | df_daily['is_rain_cleaning']
        ]

    cleaning_events = []
    for date in events_df.index[:max_results]:
        try:
            sr_before = df_daily.loc[date - pd.Timedelta(days=1), 'soiling_ratio_smooth']
            sr_after = df_daily.loc[date, 'soiling_ratio_smooth']
            sr_gain = (sr_after - sr_before) * 100

            cleaning_events.append({
                'date': date,
                'sr_before': sr_before,
                'sr_after': sr_after,
                'sr_gain_pct': sr_gain,
            })
        except KeyError:
            # Skip if previous day not available
            continue

    return cleaning_events


def print_cleaning_summary(df_daily, max_events=10):
    """
    Print a formatted summary of detected cleaning events.

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily data with cleaning event flags
    max_events : int
        Maximum number of events to display
    """
    events = get_cleaning_dates(df_daily, event_type='manual', max_results=max_events)

    print(f"\n📅 Detected manual cleaning dates (first {min(len(events), max_events)}):")
    for i, event in enumerate(events, 1):
        # Check detection method
        date = event['date']
        method = ''
        if 'is_manual_cleaning' in df_daily.columns and 'is_manual_cleaning_power' in df_daily.columns:
            sr_detected = df_daily.loc[date, 'is_manual_cleaning']
            power_detected = df_daily.loc[date, 'is_manual_cleaning_power']
            if sr_detected and power_detected:
                method = ' [SR+Power]'
            elif sr_detected:
                method = ' [SR only]'
            elif power_detected:
                method = ' [Power only]'

        print(f"   {i}. {date.strftime('%Y-%m-%d')}: "
              f"SR {event['sr_before']:.3f} → {event['sr_after']:.3f} "
              f"(+{event['sr_gain_pct']:.1f}%){method}")
