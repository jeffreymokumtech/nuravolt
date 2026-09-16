"""Clearsky POA irradiance calculations using pvlib."""

import pandas as pd
import pvlib
from pvlib.location import Location


def calculate_clearsky_poa(df_pd, location, tilt, azimuth):
    """
    Calculate clearsky POA irradiance using pvlib Ineichen model.

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        DataFrame with DatetimeIndex
    location : pvlib.Location
        Location object with lat/lon/elevation
    tilt : float
        Panel tilt angle in degrees
    azimuth : float
        Panel azimuth in degrees (180 = south)

    Returns:
    --------
    df_pd : pandas.DataFrame
        Input DataFrame with added 'poa_clearsky' column
    """
    print("⚙️ Calculating clearsky POA irradiance using pvlib Ineichen model...")

    # Get solar position
    solar_position = location.get_solarposition(df_pd.index)

    # Calculate clearsky GHI, DNI, DHI
    clearsky = location.get_clearsky(df_pd.index, model='ineichen')

    # Get DNI extra (extraterrestrial radiation)
    dni_extra = pvlib.irradiance.get_extra_radiation(df_pd.index)

    # Transpose to POA
    poa_components = pvlib.irradiance.get_total_irradiance(
        surface_tilt=tilt,
        surface_azimuth=azimuth,
        dni=clearsky['dni'],
        ghi=clearsky['ghi'],
        dhi=clearsky['dhi'],
        dni_extra=dni_extra,
        solar_zenith=solar_position['apparent_zenith'],
        solar_azimuth=solar_position['azimuth'],
        model='haydavies',
    )

    df_pd['poa_clearsky'] = poa_components['poa_global']

    # Filter low-sun conditions
    df_pd = df_pd[solar_position['elevation'] > 10]

    print(f"✅ Clearsky POA calculated for {len(df_pd):,} measurements")
    return df_pd
