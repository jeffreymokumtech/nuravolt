"""Feature engineering for soiling forecasting."""

import numpy as np
import pandas as pd
import pvlib


def create_historical_soiling_features(df_daily):
    """
    Create rolling historical soiling features.

    Generates ~35 features from soiling ratio history using multiple time windows.

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily aggregated data with 'soiling_ratio_smooth' column

    Returns:
    --------
    df_features : pandas.DataFrame
        DataFrame with historical soiling features

    Features Generated:
    -------------------
    For each window (7, 14, 30, 60, 90 days):
    - sr_mean_{window}d: Mean soiling ratio
    - sr_std_{window}d: Standard deviation
    - sr_min_{window}d: Minimum value
    - sr_max_{window}d: Maximum value
    - sr_range_{window}d: Range (max - min)
    - soiling_rate_{window}d: Rate of SR change per day
    - cum_loss_{window}d: Cumulative soiling loss

    Plus:
    - days_since_cleaning: Days since last detected cleaning event
    """
    print("⚙️ Engineering historical soiling features...")

    # Rolling window periods (days)
    windows = [7, 14, 30, 60, 90]

    features = {}

    for window in windows:
        window_name = f'{window}d'

        # Rolling statistics of soiling ratio
        features[f'sr_mean_{window_name}'] = df_daily['soiling_ratio_smooth'].rolling(window).mean()
        features[f'sr_std_{window_name}'] = df_daily['soiling_ratio_smooth'].rolling(window).std()
        features[f'sr_min_{window_name}'] = df_daily['soiling_ratio_smooth'].rolling(window).min()
        features[f'sr_max_{window_name}'] = df_daily['soiling_ratio_smooth'].rolling(window).max()
        features[f'sr_range_{window_name}'] = features[f'sr_max_{window_name}'] - features[f'sr_min_{window_name}']

        # Soiling rate (change in SR)
        features[f'soiling_rate_{window_name}'] = df_daily['soiling_ratio_smooth'].diff(window) / window

        # Cumulative soiling loss
        features[f'cum_loss_{window_name}'] = (1 - df_daily['soiling_ratio_smooth']).rolling(window).sum()

    # Time since last cleaning (days)
    features['days_since_cleaning'] = np.zeros(len(df_daily))
    last_cleaning_timestamp = df_daily.index[0]  # Initialize with first timestamp

    for i, idx in enumerate(df_daily.index):
        if df_daily.loc[idx, 'is_manual_cleaning'] or df_daily.loc[idx, 'is_rain_cleaning']:
            last_cleaning_timestamp = idx
            features['days_since_cleaning'][i] = 0
        else:
            # Calculate days since last cleaning using pd.Timedelta
            time_diff = idx - last_cleaning_timestamp
            features['days_since_cleaning'][i] = time_diff.days

    # Convert to DataFrame
    df_features_soiling = pd.DataFrame(features, index=df_daily.index)

    print(f"✅ Historical soiling features: {len(df_features_soiling.columns)} features")
    print("\n📊 Sample features:")
    for col in df_features_soiling.columns[:10]:
        print(f"   - {col}")

    return df_features_soiling


def create_weather_features(df_pd, df_daily):
    """
    Create weather and environmental features.

    Generates ~30+ features from weather data and CAMS aerosol data.

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        15-minute resolution data with weather columns
    df_daily : pandas.DataFrame
        Daily aggregated data

    Returns:
    --------
    df_features : pandas.DataFrame
        DataFrame with weather features

    Features Generated:
    -------------------
    Rainfall features (7, 14, 30 day windows):
    - rainfall_sum_{window}d: Total rainfall
    - rainfall_days_{window}d: Days with rain >1mm
    - rainfall_max_{window}d: Maximum daily rainfall
    - days_since_rain: Days since last significant rain

    Aerosol features (if CAMS data available):
    - aod_mean_{window}d: Mean Aerosol Optical Depth
    - aod_max_{window}d: Maximum AOD
    - dust_aod_mean_{window}d: Mean dust AOD
    - dust_aod_max_{window}d: Maximum dust AOD

    Temperature, humidity, wind features (7, 30 day windows)
    """
    print("⚙️ Engineering weather & environmental features...")

    weather_features = {}

    # Rainfall features (critical for soiling)
    for window in [7, 14, 30]:
        weather_features[f'rainfall_sum_{window}d'] = df_daily['rainfall'].rolling(window).sum()
        weather_features[f'rainfall_days_{window}d'] = (df_daily['rainfall'] > 1).rolling(window).sum()
        weather_features[f'rainfall_max_{window}d'] = df_daily['rainfall'].rolling(window).max()

    # Days since rain (cumulative count of dry days)
    weather_features['days_since_rain'] = (df_daily['rainfall'] < 1).cumsum()

    # If CAMS data available, add aerosol features
    if 'aod_550nm' in df_pd.columns:
        # Resample to daily
        df_daily_aod = df_pd.resample('1D')['aod_550nm'].mean()
        df_daily_dust = df_pd.resample('1D')['dust_aod_550nm'].mean()

        for window in [7, 14, 30]:
            weather_features[f'aod_mean_{window}d'] = df_daily_aod.rolling(window).mean()
            weather_features[f'aod_max_{window}d'] = df_daily_aod.rolling(window).max()
            weather_features[f'dust_aod_mean_{window}d'] = df_daily_dust.rolling(window).mean()
            weather_features[f'dust_aod_max_{window}d'] = df_daily_dust.rolling(window).max()

        # Enhanced AOD features for soiling rate prediction
        # Add other aerosol species if available
        df_daily_sea_salt = df_pd.resample('1D')['sea_salt_aod_550nm'].mean() if 'sea_salt_aod_550nm' in df_pd.columns else None
        df_daily_organic = df_pd.resample('1D')['organic_matter_aod_550nm'].mean() if 'organic_matter_aod_550nm' in df_pd.columns else None
        df_daily_sulfate = df_pd.resample('1D')['sulfate_aod_550nm'].mean() if 'sulfate_aod_550nm' in df_pd.columns else None

        # AOD trend features (soiling acceleration indicators)
        for window in [7, 14, 30]:
            # Rate of change in AOD (soiling rate predictor)
            weather_features[f'aod_trend_{window}d'] = df_daily_aod.diff(window) / window

            # Dust ratio (Sahara dust events have high dust/total ratio)
            dust_ratio = df_daily_dust / (df_daily_aod + 1e-6)  # Avoid division by zero
            weather_features[f'dust_ratio_{window}d'] = dust_ratio.rolling(window).mean()

            # Speciation features (if data available)
            if df_daily_sea_salt is not None:
                sea_salt_ratio = df_daily_sea_salt / (df_daily_aod + 1e-6)
                weather_features[f'sea_salt_ratio_{window}d'] = sea_salt_ratio.rolling(window).mean()

            if df_daily_organic is not None:
                organic_ratio = df_daily_organic / (df_daily_aod + 1e-6)
                weather_features[f'organic_ratio_{window}d'] = organic_ratio.rolling(window).mean()

        # Composite soiling risk score
        # Weighted by typical Andalusia aerosol composition
        # Dust: 45%, Sea salt: 30%, Organic: 20%, Sulfate: 5%
        soiling_risk = 0.45 * df_daily_dust
        if df_daily_sea_salt is not None:
            soiling_risk += 0.30 * df_daily_sea_salt
        if df_daily_organic is not None:
            soiling_risk += 0.20 * df_daily_organic
        if df_daily_sulfate is not None:
            soiling_risk += 0.05 * df_daily_sulfate

        weather_features['soiling_risk_score'] = soiling_risk
        weather_features['soiling_risk_7d'] = soiling_risk.rolling(7).mean()
        weather_features['soiling_risk_14d'] = soiling_risk.rolling(14).mean()

        # Sahara dust event detection (dust_aod spikes >0.3)
        dust_threshold = 0.3
        weather_features['is_dust_event'] = (df_daily_dust > dust_threshold).astype(int)
        weather_features['days_since_dust_event'] = (~weather_features['is_dust_event'].astype(bool)).cumsum()

        print("   ✅ CAMS aerosol features included (enhanced with soiling risk)")
    else:
        print("   ⚠️ CAMS data not available, skipping aerosol features")

    # Temperature features
    df_daily_temp = df_pd.resample('1D')['temperature'].mean()
    for window in [7, 30]:
        weather_features[f'temp_mean_{window}d'] = df_daily_temp.rolling(window).mean()
        weather_features[f'temp_std_{window}d'] = df_daily_temp.rolling(window).std()

    # Humidity features
    df_daily_humidity = df_pd.resample('1D')['humidity'].mean()
    for window in [7, 30]:
        weather_features[f'humidity_mean_{window}d'] = df_daily_humidity.rolling(window).mean()

    # Wind features (can re-suspend dust)
    df_daily_wind = df_pd.resample('1D')['wind_speed'].mean()
    for window in [7, 30]:
        weather_features[f'wind_mean_{window}d'] = df_daily_wind.rolling(window).mean()
        weather_features[f'wind_max_{window}d'] = df_daily_wind.rolling(window).max()

    # Convert to DataFrame
    df_features_weather = pd.DataFrame(weather_features, index=df_daily.index)

    print(f"✅ Weather features: {len(df_features_weather.columns)} features")
    print("\n📊 Sample features:")
    for col in df_features_weather.columns[:10]:
        print(f"   - {col}")

    return df_features_weather


def create_temporal_physics_features(df_daily, df_pd, location):
    """
    Create temporal and physics-based features.

    Generates ~15 features from temporal patterns and solar physics.

    Parameters:
    -----------
    df_daily : pandas.DataFrame
        Daily aggregated data
    df_pd : pandas.DataFrame
        15-minute resolution data for physics calculations
    location : pvlib.Location
        Location object for solar position calculations

    Returns:
    --------
    df_features : pandas.DataFrame
        DataFrame with temporal and physics features

    Features Generated:
    -------------------
    Temporal:
    - day_of_year, month, season
    - day_of_year_sin, day_of_year_cos (cyclical encoding)
    - is_dry_season, is_wet_season (climate-specific)

    Physics:
    - clearsky_index: Ratio of actual to clearsky irradiance
    - solar_elevation, solar_azimuth: Solar position
    - air_mass: Atmospheric air mass
    """
    print("⚙️ Engineering temporal & physics features...")

    temporal_physics_features = {}

    # Temporal features
    temporal_physics_features['day_of_year'] = df_daily.index.dayofyear
    temporal_physics_features['month'] = df_daily.index.month
    temporal_physics_features['season'] = (df_daily.index.month % 12 // 3 + 1)  # 1=winter, 2=spring, 3=summer, 4=fall

    # Seasonal encoding (sin/cos for cyclical nature)
    temporal_physics_features['day_of_year_sin'] = np.sin(2 * np.pi * df_daily.index.dayofyear / 365)
    temporal_physics_features['day_of_year_cos'] = np.cos(2 * np.pi * df_daily.index.dayofyear / 365)

    # Soiling season indicators (Andalusia climate - adjust for location)
    # Dry season (May-Sept): Higher soiling
    # Wet season (Oct-Apr): More rain cleaning
    temporal_physics_features['is_dry_season'] = df_daily.index.month.isin([5, 6, 7, 8, 9]).astype(int)
    temporal_physics_features['is_wet_season'] = df_daily.index.month.isin([10, 11, 12, 1, 2, 3, 4]).astype(int)

    # Physics features (from clearsky model)
    # Clearsky index
    df_daily_poa_actual = df_pd.resample('1D')['poa_actual'].mean()
    df_daily_poa_clearsky = df_pd.resample('1D')['poa_clearsky'].mean()
    temporal_physics_features['clearsky_index'] = df_daily_poa_actual / df_daily_poa_clearsky

    # Solar position features (daily average at noon)
    solar_position_daily = location.get_solarposition(df_daily.index + pd.Timedelta(hours=12))
    temporal_physics_features['solar_elevation'] = solar_position_daily['elevation']
    temporal_physics_features['solar_azimuth'] = solar_position_daily['azimuth']
    temporal_physics_features['air_mass'] = pvlib.atmosphere.get_relative_airmass(solar_position_daily['apparent_zenith'])

    # Convert to DataFrame
    df_features_temporal = pd.DataFrame(temporal_physics_features, index=df_daily.index)

    print(f"✅ Temporal & physics features: {len(df_features_temporal.columns)} features")

    return df_features_temporal


def create_all_features(df_pd, df_daily, location):
    """
    Create complete feature set for soiling forecasting.

    Combines historical soiling, weather, and temporal/physics features.

    Parameters:
    -----------
    df_pd : pandas.DataFrame
        15-minute resolution data
    df_daily : pandas.DataFrame
        Daily aggregated data with cleaning event flags
    location : pvlib.Location
        Location object for solar calculations

    Returns:
    --------
    df_features_all : pandas.DataFrame
        Complete feature set (~80+ features)

    Feature Breakdown:
    ------------------
    - Historical soiling: ~35 features
    - Weather: ~30+ features
    - Temporal & physics: ~15 features
    """
    # Create feature groups
    df_features_soiling = create_historical_soiling_features(df_daily)
    df_features_weather = create_weather_features(df_pd, df_daily)
    df_features_temporal = create_temporal_physics_features(df_daily, df_pd, location)

    # Combine all feature groups
    df_features_all = pd.concat([
        df_features_soiling,
        df_features_weather,
        df_features_temporal,
    ], axis=1)

    print(f"\n🎯 Total engineered features: {len(df_features_all.columns)} features")
    print("\n📊 Feature breakdown:")
    print(f"   Historical soiling: {len(df_features_soiling.columns)}")
    print(f"   Weather: {len(df_features_weather.columns)}")
    print(f"   Temporal & physics: {len(df_features_temporal.columns)}")

    return df_features_all
