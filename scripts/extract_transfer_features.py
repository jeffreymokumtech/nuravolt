#!/usr/bin/env python3
"""Extract enhanced transfer learning features for all plants.

This script loads all available environmental data for each plant and
creates a unified transfer_features.json file for display in the Data Explorer.

Output format:
{
    "metadata": {...},
    "feature_groups": {
        "rain_weather": ["rainfall_7d", "days_since_rain", ...],
        "aod_dust": ["aod_mean_7d", "pm10_mean_7d", ...],
        ...
    },
    "daily_data": [
        {"date": "2024-01-01", "rainfall_7d": 12.5, "aod_mean_7d": 0.15, ...},
        ...
    ]
}
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any

import numpy as np
import pandas as pd


# Plant configurations
PLANTS = [
    "alpha",
    "ribera",
    "eta",
    "delta",
    "zeta",
    "gamma",
    "epsilon",
]

PLANT_CONFIGS = {
    "epsilon": {"latitude": 51.195, "climate": "temperate", "is_coastal": False},
    "ribera": {"latitude": 37.927, "climate": "mediterranean", "is_coastal": False},
    "eta": {"latitude": 38.66, "climate": "mediterranean", "is_coastal": False},
    "delta": {"latitude": 39.6544, "climate": "mediterranean", "is_coastal": True},
    "zeta": {"latitude": 39.525, "climate": "mediterranean", "is_coastal": True},
    "gamma": {"latitude": 39.489, "climate": "mediterranean", "is_coastal": True},
    "alpha": {"latitude": 37.8145, "climate": "mediterranean", "is_coastal": False},
}

ROLLING_WINDOWS = [7, 14, 30]


def load_json_data(path: Path) -> Optional[Dict]:
    """Load JSON file if it exists."""
    if path.exists():
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"  Warning: Could not load {path.name}: {e}")
    return None


def find_column(columns: List[str], patterns: List[str]) -> Optional[str]:
    """Find column matching patterns."""
    for pattern in patterns:
        pattern_lower = pattern.lower()
        for col in columns:
            if pattern_lower in col.lower():
                return col
    return None


def calculate_days_since(is_event: pd.Series, max_days: int = 30) -> np.ndarray:
    """Calculate days since last event, capped at max_days."""
    days_since = np.zeros(len(is_event))
    current_count = max_days

    for i in range(len(is_event)):
        if is_event.iloc[i]:
            current_count = 0
        else:
            current_count = min(current_count + 1, max_days)
        days_since[i] = current_count

    return days_since


def extract_rain_weather_features(data_dir: Path, target_index: pd.DatetimeIndex, config: Dict) -> Dict[str, pd.Series]:
    """Extract rain and weather features."""
    features = {}

    # Try weather_extended.json first, then rain_history.json
    weather_data = load_json_data(data_dir / "weather_extended.json")
    if weather_data is None:
        weather_data = load_json_data(data_dir / "rain_history.json")

    if weather_data is None:
        return features

    df = pd.DataFrame(weather_data.get('daily_data', weather_data))
    if 'date' not in df.columns:
        return features

    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').reindex(target_index)

    # Precipitation
    precip_col = find_column(df.columns.tolist(), ['precipitation_mm', 'precipitation', 'rain_mm', 'rainfall'])
    if precip_col:
        precip = df[precip_col].fillna(0)
        for window in ROLLING_WINDOWS:
            features[f'rainfall_{window}d'] = precip.rolling(window, min_periods=1).sum()

        # Days since significant rain (≥5mm)
        is_cleaning_rain = precip >= 5.0
        features['days_since_rain'] = pd.Series(calculate_days_since(is_cleaning_rain), index=target_index)
        features['is_heavy_rain'] = (precip >= 10.0).astype(float)

    # Snow (for temperate climates)
    snow_col = find_column(df.columns.tolist(), ['snowfall_cm', 'snowfall', 'snow'])
    if snow_col:
        snow = df[snow_col].fillna(0)
        if snow.sum() > 0:  # Only if there's actual snow
            features['snowfall'] = snow
            features['snowfall_7d'] = snow.rolling(7, min_periods=1).sum()
            features['has_snow'] = (snow > 0).astype(float)
            is_snow_day = snow > 0.5
            features['days_since_snow'] = pd.Series(calculate_days_since(is_snow_day), index=target_index)

    # Snow depth
    snow_depth_col = find_column(df.columns.tolist(), ['snow_depth_cm', 'snow_depth'])
    if snow_depth_col:
        snow_depth = df[snow_depth_col].fillna(0)
        if snow_depth.sum() > 0:
            features['snow_depth'] = snow_depth
            features['is_snow_covered'] = (snow_depth > 1).astype(float)

    # Humidity
    humid_col = find_column(df.columns.tolist(), ['humidity', 'rh', 'relative_humidity'])
    if humid_col:
        humidity = df[humid_col].ffill().fillna(50)
        features['humidity'] = humidity
        features['humidity_mean_7d'] = humidity.rolling(7, min_periods=1).mean()
        features['is_high_humidity'] = (humidity > 70).astype(float)

    # Wind
    wind_col = find_column(df.columns.tolist(), ['wind_speed_mean', 'wind_speed', 'wind', 'ws'])
    if wind_col:
        wind = df[wind_col].ffill().fillna(3)
        features['wind_speed'] = wind
        features['wind_mean_7d'] = wind.rolling(7, min_periods=1).mean()
        features['is_strong_wind'] = (wind > 8).astype(float)

    # Dewpoint / Dew cleaning
    dewpoint_col = find_column(df.columns.tolist(), ['dewpoint_mean', 'dewpoint', 'dew_point'])
    temp_col = find_column(df.columns.tolist(), ['temperature_mean', 'temperature', 'temp', 'air_temp'])
    if dewpoint_col and temp_col:
        dewpoint = df[dewpoint_col].ffill()
        temp = df[temp_col].ffill()
        dew_diff = temp - dewpoint
        features['dew_cleaning_potential'] = np.clip(1 - dew_diff / 10, 0, 1)

    # Temperature
    if temp_col:
        temp = df[temp_col].ffill().fillna(20)
        features['temperature'] = temp
        features['temperature_mean_7d'] = temp.rolling(7, min_periods=1).mean()

    return features


def extract_aod_dust_features(data_dir: Path, target_index: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Extract AOD and dust features."""
    features = {}

    # Try dust_history.json first (old format), then aod_history.json (new format)
    dust_data = load_json_data(data_dir / "dust_history.json")
    if dust_data:
        df_dust = pd.DataFrame(dust_data.get('daily_data', []))
        if 'date' in df_dust.columns:
            df_dust['date'] = pd.to_datetime(df_dust['date'])
            df_dust = df_dust.set_index('date').reindex(target_index)

            # PM10
            pm10_col = find_column(df_dust.columns.tolist(), ['pm10', 'pm_10'])
            if pm10_col:
                pm10 = df_dust[pm10_col].ffill().fillna(20)
                features['pm10'] = pm10
                features['pm10_mean_7d'] = pm10.rolling(7, min_periods=1).mean()
                features['pm10_mean_14d'] = pm10.rolling(14, min_periods=1).mean()

            # PM2.5
            pm25_col = find_column(df_dust.columns.tolist(), ['pm2_5', 'pm25', 'pm2p5'])
            if pm25_col:
                pm25 = df_dust[pm25_col].ffill().fillna(10)
                features['pm2_5'] = pm25
                features['pm2p5_mean_7d'] = pm25.rolling(7, min_periods=1).mean()

            # Saharan dust
            dust_col = find_column(df_dust.columns.tolist(), ['dust', 'saharan_dust'])
            if dust_col:
                dust = df_dust[dust_col].ffill().fillna(0)
                features['saharan_dust'] = dust
                features['dust_mean_7d'] = dust.rolling(7, min_periods=1).mean()

    # Fallback to aod_history.json (new format with pm10_mean, pm2p5_mean, dust_mean)
    if 'pm10' not in features:
        aod_hist = load_json_data(data_dir / "aod_history.json")
        if aod_hist:
            df = pd.DataFrame(aod_hist.get('daily_data', []))
            if 'date' in df.columns:
                df['date'] = pd.to_datetime(df['date'])
                df = df.set_index('date').reindex(target_index)

                if 'pm10_mean' in df.columns:
                    pm10 = df['pm10_mean'].ffill().fillna(20)
                    features['pm10'] = pm10
                    features['pm10_mean_7d'] = pm10.rolling(7, min_periods=1).mean()
                    features['pm10_mean_14d'] = pm10.rolling(14, min_periods=1).mean()

                if 'pm2p5_mean' in df.columns:
                    pm25 = df['pm2p5_mean'].ffill().fillna(10)
                    features['pm2_5'] = pm25
                    features['pm2p5_mean_7d'] = pm25.rolling(7, min_periods=1).mean()

                if 'dust_mean' in df.columns:
                    dust = df['dust_mean'].ffill().fillna(0)
                    features['saharan_dust'] = dust
                    features['dust_mean_7d'] = dust.rolling(7, min_periods=1).mean()

    # Load AOD from aod_merged.json or cams_aod_history.json
    aod_data = load_json_data(data_dir / "aod_merged.json")
    if aod_data:
        df_aod = pd.DataFrame(aod_data.get('daily_data', []))
        if 'date' in df_aod.columns:
            df_aod['date'] = pd.to_datetime(df_aod['date'])
            df_aod = df_aod.set_index('date').reindex(target_index)

            aod_col = find_column(df_aod.columns.tolist(), ['aod_550nm', 'aod', 'total_aod'])
            if aod_col:
                aod = df_aod[aod_col].ffill().fillna(0.1)
                features['aod_550nm'] = aod
                features['aod_mean_7d'] = aod.rolling(7, min_periods=1).mean()
                features['aod_mean_14d'] = aod.rolling(14, min_periods=1).mean()
                features['is_high_aod'] = (aod > 0.3).astype(float)

    # Fallback to cams_aod_history.json
    if 'aod_550nm' not in features:
        cams_data = load_json_data(data_dir / "cams_aod_history.json")
        if cams_data:
            df_cams = pd.DataFrame(cams_data.get('data', []))
            if 'timestamp' in df_cams.columns:
                df_cams['date'] = pd.to_datetime(df_cams['timestamp'])
                df_cams = df_cams.set_index('date').reindex(target_index)

                if 'aod_550nm' in df_cams.columns:
                    aod = df_cams['aod_550nm'].ffill().fillna(0.1)
                    features['aod_550nm'] = aod
                    features['aod_mean_7d'] = aod.rolling(7, min_periods=1).mean()
                    features['aod_mean_14d'] = aod.rolling(14, min_periods=1).mean()
                    features['is_high_aod'] = (aod > 0.3).astype(float)

                # Dust AOD if available
                if 'dust_aod_550nm' in df_cams.columns:
                    dust_aod = df_cams['dust_aod_550nm'].ffill().fillna(0.05)
                    features['dust_aod'] = dust_aod
                    features['dust_aod_mean_7d'] = dust_aod.rolling(7, min_periods=1).mean()

    return features


def extract_soil_moisture_features(data_dir: Path, target_index: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Extract soil moisture features."""
    features = {}

    soil_data = load_json_data(data_dir / "soil_moisture.json")
    if soil_data is None:
        return features

    df = pd.DataFrame(soil_data.get('daily_data', soil_data))
    if 'date' not in df.columns:
        return features

    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').reindex(target_index)

    sm_col = find_column(df.columns.tolist(), ['soil_moisture_0_7cm', 'swvl1', 'soil_moisture'])
    if sm_col:
        sm = df[sm_col].ffill().fillna(0.2)
        features['soil_moisture'] = sm
        features['soil_moisture_mean_7d'] = sm.rolling(7, min_periods=1).mean()
        features['is_dry_soil'] = (sm < 0.15).astype(float)
        features['dust_availability'] = np.clip(1 - sm.values / 0.3, 0, 1)

    return features


def extract_sea_salt_features(data_dir: Path, target_index: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Extract sea salt and aerosol speciation features."""
    features = {}

    speciation_data = load_json_data(data_dir / "cams_aerosol_speciation.json")
    if speciation_data is None:
        return features

    df = pd.DataFrame(speciation_data.get('daily_data', speciation_data))
    if 'date' not in df.columns:
        return features

    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').reindex(target_index)

    # Sea salt AOD
    ss_col = find_column(df.columns.tolist(), ['sea_salt_aod', 'ssaod550', 'sea_salt_aod_550nm'])
    if ss_col:
        ss_aod = df[ss_col].ffill().fillna(0.01)
        features['sea_salt_aod'] = ss_aod
        features['sea_salt_aod_mean_7d'] = ss_aod.rolling(7, min_periods=1).mean()
        features['is_high_sea_salt'] = (ss_aod > 0.05).astype(float)

    # Sea salt percentage
    if 'sea_salt_pct' in df.columns:
        features['sea_salt_pct'] = df['sea_salt_pct'].ffill().fillna(20)

    # Organic matter AOD
    om_col = find_column(df.columns.tolist(), ['organic_matter_aod', 'omaod550', 'organic_aod'])
    if om_col:
        om_aod = df[om_col].ffill().fillna(0.02)
        features['organic_aod'] = om_aod
        features['organic_aod_mean_7d'] = om_aod.rolling(7, min_periods=1).mean()

    # Sulphate AOD
    su_col = find_column(df.columns.tolist(), ['sulphate_aod', 'suaod550', 'sulfate_aod'])
    if su_col:
        su_aod = df[su_col].ffill().fillna(0.01)
        features['sulphate_aod'] = su_aod
        features['sulphate_aod_mean_7d'] = su_aod.rolling(7, min_periods=1).mean()

    # Black carbon AOD
    bc_col = find_column(df.columns.tolist(), ['black_carbon_aod', 'bcaod550'])
    if bc_col:
        bc_aod = df[bc_col].ffill().fillna(0.01)
        features['black_carbon_aod'] = bc_aod
        features['black_carbon_aod_mean_7d'] = bc_aod.rolling(7, min_periods=1).mean()

    return features


def extract_extinction_features(data_dir: Path, target_index: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Extract MERRA-2 surface extinction features."""
    features = {}

    extinction_data = load_json_data(data_dir / "merra2_extinction.json")
    if extinction_data is None:
        return features

    df = pd.DataFrame(extinction_data.get('daily_data', extinction_data))
    if 'date' not in df.columns:
        return features

    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').reindex(target_index)

    # Dust extinction
    dust_ext_col = find_column(df.columns.tolist(), ['dust_extinction', 'DUEXTTAU', 'duexttau'])
    if dust_ext_col:
        dust_ext = df[dust_ext_col].ffill().fillna(0.05)
        features['dust_extinction'] = dust_ext
        features['dust_extinction_mean_7d'] = dust_ext.rolling(7, min_periods=1).mean()
        features['is_dust_storm'] = (dust_ext > 0.3).astype(float)

    # Sea salt extinction
    ss_ext_col = find_column(df.columns.tolist(), ['seasalt_extinction', 'SSEXTTAU', 'ssexttau'])
    if ss_ext_col:
        ss_ext = df[ss_ext_col].ffill().fillna(0.02)
        features['seasalt_extinction'] = ss_ext
        features['seasalt_extinction_mean_7d'] = ss_ext.rolling(7, min_periods=1).mean()

    return features


def extract_dustiq_features(data_dir: Path, target_index: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Extract DustIQ sensor features."""
    features = {}

    dustiq_data = load_json_data(data_dir / "dustiq_history.json")
    if dustiq_data is None:
        return features

    df = pd.DataFrame(dustiq_data.get('daily_data', []))
    if 'date' not in df.columns:
        return features

    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date').reindex(target_index)

    if 'sr_dustiq' in df.columns:
        sr = df['sr_dustiq'].ffill()
        features['sr_dustiq'] = sr
        features['sr_dustiq_mean_7d'] = sr.rolling(7, min_periods=1).mean()

        # Soiling rate (daily change)
        features['soiling_rate_dustiq'] = sr.diff() * 100  # %/day

    return features


def create_temporal_features(target_index: pd.DatetimeIndex, config: Dict) -> Dict[str, pd.Series]:
    """Create temporal/seasonal features."""
    features = {}

    # Day of year (cyclical)
    doy = target_index.dayofyear
    features['day_of_year_sin'] = pd.Series(np.sin(2 * np.pi * doy / 365), index=target_index)
    features['day_of_year_cos'] = pd.Series(np.cos(2 * np.pi * doy / 365), index=target_index)

    # Month (cyclical)
    month = target_index.month
    features['month_sin'] = pd.Series(np.sin(2 * np.pi * month / 12), index=target_index)
    features['month_cos'] = pd.Series(np.cos(2 * np.pi * month / 12), index=target_index)

    # Dry season indicator
    climate = config.get('climate', 'mediterranean')
    if climate == "mediterranean":
        dry_months = [5, 6, 7, 8, 9]
    elif climate == "temperate":
        dry_months = [6, 7, 8]
    else:
        dry_months = list(range(1, 13))

    features['is_dry_season'] = pd.Series(np.isin(month, dry_months).astype(float), index=target_index)

    return features


def create_location_features(target_index: pd.DatetimeIndex, config: Dict) -> Dict[str, pd.Series]:
    """Create static location features."""
    n = len(target_index)
    features = {}

    features['latitude_abs'] = pd.Series(np.full(n, abs(config.get('latitude', 40))), index=target_index)
    features['is_coastal'] = pd.Series(np.full(n, float(config.get('is_coastal', False))), index=target_index)

    return features


def extract_features_for_plant(plant_id: str, data_dir: Path, config: Dict) -> Optional[Dict[str, Any]]:
    """Extract all features for a single plant."""
    print(f"\nProcessing {plant_id}...")

    # Determine date range from available data
    # Try to find a reference file with dates
    date_ranges = []

    for filename in ["weather_extended.json", "rain_history.json", "dustiq_history.json", "cams_aod_history.json"]:
        data = load_json_data(data_dir / filename)
        if data:
            if 'daily_data' in data:
                df = pd.DataFrame(data['daily_data'])
            elif 'data' in data:
                df = pd.DataFrame(data['data'])
            else:
                df = pd.DataFrame(data)

            if 'date' in df.columns:
                df['date'] = pd.to_datetime(df['date'])
                date_ranges.append((df['date'].min(), df['date'].max()))
            elif 'timestamp' in df.columns:
                df['timestamp'] = pd.to_datetime(df['timestamp'])
                date_ranges.append((df['timestamp'].min(), df['timestamp'].max()))

    if not date_ranges:
        print(f"  No date data found for {plant_id}")
        return None

    # Use the widest date range available
    start_date = min(dr[0] for dr in date_ranges)
    end_date = max(dr[1] for dr in date_ranges)

    print(f"  Date range: {start_date.date()} to {end_date.date()}")

    # Create target index
    target_index = pd.date_range(start=start_date, end=end_date, freq='D')

    # Extract all feature groups
    all_features = {}
    feature_groups = {}

    # 1. Rain/Weather
    rain_features = extract_rain_weather_features(data_dir, target_index, config)
    all_features.update(rain_features)
    feature_groups['rain_weather'] = list(rain_features.keys())
    print(f"  Rain/Weather: {len(rain_features)} features")

    # 2. AOD/Dust
    aod_features = extract_aod_dust_features(data_dir, target_index)
    all_features.update(aod_features)
    feature_groups['aod_dust'] = list(aod_features.keys())
    print(f"  AOD/Dust: {len(aod_features)} features")

    # 3. Soil Moisture
    soil_features = extract_soil_moisture_features(data_dir, target_index)
    all_features.update(soil_features)
    if soil_features:
        feature_groups['soil_moisture'] = list(soil_features.keys())
        print(f"  Soil Moisture: {len(soil_features)} features")

    # 4. Sea Salt / Aerosol Speciation
    seasalt_features = extract_sea_salt_features(data_dir, target_index)
    all_features.update(seasalt_features)
    if seasalt_features:
        feature_groups['sea_salt'] = list(seasalt_features.keys())
        print(f"  Sea Salt: {len(seasalt_features)} features")

    # 5. MERRA-2 Extinction
    extinction_features = extract_extinction_features(data_dir, target_index)
    all_features.update(extinction_features)
    if extinction_features:
        feature_groups['extinction'] = list(extinction_features.keys())
        print(f"  Extinction: {len(extinction_features)} features")

    # 6. DustIQ
    dustiq_features = extract_dustiq_features(data_dir, target_index)
    all_features.update(dustiq_features)
    if dustiq_features:
        feature_groups['dustiq'] = list(dustiq_features.keys())
        print(f"  DustIQ: {len(dustiq_features)} features")

    # 7. Temporal
    temporal_features = create_temporal_features(target_index, config)
    all_features.update(temporal_features)
    feature_groups['temporal'] = list(temporal_features.keys())
    print(f"  Temporal: {len(temporal_features)} features")

    # 8. Location
    location_features = create_location_features(target_index, config)
    all_features.update(location_features)
    feature_groups['location'] = list(location_features.keys())
    print(f"  Location: {len(location_features)} features")

    # Build DataFrame
    df_features = pd.DataFrame(all_features, index=target_index)
    df_features = df_features.ffill().bfill()

    # Convert to daily_data format
    daily_data = []
    for date, row in df_features.iterrows():
        record = {'date': date.strftime('%Y-%m-%d')}
        for col in df_features.columns:
            val = row[col]
            if pd.isna(val):
                record[col] = None
            elif isinstance(val, (np.floating, float)):
                record[col] = round(float(val), 4)
            elif isinstance(val, (np.integer, int)):
                record[col] = int(val)
            else:
                record[col] = val
        daily_data.append(record)

    print(f"  Total: {len(df_features.columns)} features, {len(daily_data)} days")

    return {
        'metadata': {
            'plant_id': plant_id,
            'generated_at': datetime.now().isoformat(),
            'date_range': {
                'start': start_date.strftime('%Y-%m-%d'),
                'end': end_date.strftime('%Y-%m-%d'),
            },
            'total_features': len(df_features.columns),
            'total_days': len(daily_data),
            'climate': config.get('climate', 'unknown'),
            'is_coastal': config.get('is_coastal', False),
        },
        'feature_groups': feature_groups,
        'daily_data': daily_data,
    }


def main():
    """Extract features for all plants."""
    base_dir = Path("public/data/soiling")

    print("=" * 60)
    print("Enhanced Transfer Feature Extraction")
    print("=" * 60)

    for plant_id in PLANTS:
        data_dir = base_dir / plant_id

        if not data_dir.exists():
            print(f"\nSkipping {plant_id}: directory not found")
            continue

        config = PLANT_CONFIGS.get(plant_id, {})
        result = extract_features_for_plant(plant_id, data_dir, config)

        if result:
            output_path = data_dir / "transfer_features.json"
            with open(output_path, 'w') as f:
                json.dump(result, f, indent=2)
            print(f"  Saved: {output_path}")

    print("\n" + "=" * 60)
    print("Feature extraction complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
