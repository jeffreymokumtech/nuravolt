"""Soiling ratio calculation and smoothing."""

import pandas as pd


def calculate_soiling_ratio(df_pd, window_days=7):
    """
    Calculate soiling ratio with rolling median smoothing.

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        DataFrame with 'poa_actual' and 'poa_clearsky' columns
    window_days : int
        Rolling window size in days (default: 7)

    Returns:
    --------
    df_pd : pandas.DataFrame
        Input DataFrame with added soiling ratio columns
    """
    # Calculate raw SR
    df_pd['soiling_ratio'] = df_pd['poa_actual'] / df_pd['poa_clearsky']

    # Clip unrealistic values
    df_pd['soiling_ratio'] = df_pd['soiling_ratio'].clip(0.5, 1.05)

    # Apply rolling median (15-min data, 4 samples/hour)
    window_samples = window_days * 24 * 4
    df_pd['soiling_ratio_smooth'] = df_pd['soiling_ratio'].rolling(
        window_samples,
        center=True
    ).median()

    # Calculate soiling loss percentage
    df_pd['soiling_loss_pct'] = (1 - df_pd['soiling_ratio_smooth']) * 100

    print(f"✅ Soiling ratio calculated")
    print(f"   SR mean: {df_pd['soiling_ratio_smooth'].mean():.3f}")
    print(f"   SR range: {df_pd['soiling_ratio_smooth'].min():.3f} - {df_pd['soiling_ratio_smooth'].max():.3f}")

    return df_pd
