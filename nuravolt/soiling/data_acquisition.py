"""External data acquisition from CAMS and NASA POWER with caching."""

import pandas as pd
import polars as pl
import cdsapi
import requests
import certifi
import os
import numpy as np
from datetime import datetime, timedelta
from pathlib import Path
import hashlib


def _get_cache_dir():
    """Get or create cache directory for downloaded data."""
    cache_dir = Path.home() / '.nuravolt' / 'cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _get_cache_key(prefix, **kwargs):
    """Generate cache key from parameters."""
    key_str = f"{prefix}_" + "_".join(f"{k}={v}" for k, v in sorted(kwargs.items()))
    return hashlib.md5(key_str.encode()).hexdigest()


def download_cams_aerosol_data(latitude, longitude, start_date, end_date,
                                 api_key_file='~/.cdsapirc', use_cache=True):
    """
    Download CAMS aerosol data for Alpha1 location.

    Automatically splits large date ranges into 1-year chunks to avoid API timeouts.
    Concatenates all chunks into a single Polars DataFrame.

    Free data source: https://ads.atmosphere.copernicus.eu/
    API key required (free): https://cds.climate.copernicus.eu/user/register

    Variables downloaded (7 total):
    - Total AOD at 550nm (all aerosols)
    - Dust AOD at 550nm (Sahara dust events)
    - Sea Salt AOD at 550nm (coastal influence ~70km from Atlantic)
    - Organic Matter AOD at 550nm (agricultural/biomass sources)
    - Sulfate AOD at 550nm (industrial/ship emissions)
    - PM2.5 concentrations (fine particles, high adhesion)
    - PM10 concentrations (coarse particles, dust-dominated)

    Aerosol coverage for Alpha1, Andalusia:
    - Sahara dust: 40-50% of soiling events (captured by dust_aod)
    - Sea salt: 25-35% of soiling events (captured by sea_salt_aod)
    - Agricultural organic: 15-20% of soiling events (captured by organic_matter_aod)
    - Industrial/traffic: 5-10% of soiling events (captured by sulfate_aod)
    Total coverage: >90% of soiling causes

    Parameters:
    -----------
    use_cache : bool
        If True, cache downloaded data and reuse if available (default: True)
    """
    # Check cache first
    if use_cache:
        cache_dir = _get_cache_dir()
        cache_key = _get_cache_key(
            'cams',
            lat=round(latitude, 4),
            lon=round(longitude, 4),
            start=start_date,
            end=end_date
        )
        cache_file = cache_dir / f"{cache_key}.parquet"

        if cache_file.exists():
            print(f"✅ Loading CAMS data from cache: {cache_file.name}")
            return pl.read_parquet(cache_file)

    try:
        from datetime import datetime, timedelta
        import os

        # Fix SSL certificate verification issue on macOS
        os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
        os.environ['SSL_CERT_FILE'] = certifi.where()

        # Initialize CAMS API client
        c = cdsapi.Client()

        # Parse dates
        start_dt = pd.to_datetime(start_date)
        end_dt = pd.to_datetime(end_date)

        # Calculate number of years and create chunks
        total_days = (end_dt - start_dt).days
        num_chunks = (total_days // 365) + 1

        print(f"📥 Downloading CAMS aerosol data (7 variables)...")
        print(f"   Location: {latitude:.4f}°N, {longitude:.4f}°W")
        print(f"   Date range: {start_date} to {end_date} ({total_days} days)")
        print(f"   Split into {num_chunks} chunk(s) (max 1 year per chunk)")
        print(f"   Variables: Total AOD, Dust AOD, Sea Salt AOD, Organic AOD, Sulfate AOD, PM2.5, PM10")
        print(f"   Coverage: >90% of soiling causes (Sahara dust, sea salt, agricultural, industrial)")
        print()

        # Store all chunks
        all_chunks = []

        # Download data in 1-year chunks
        current_start = start_dt
        chunk_num = 1

        while current_start <= end_dt:
            # Calculate chunk end date (1 year or remaining days)
            chunk_end = min(current_start + timedelta(days=364), end_dt)  # 364 days = ~1 year

            chunk_start_str = current_start.strftime('%Y-%m-%d')
            chunk_end_str = chunk_end.strftime('%Y-%m-%d')

            print(f"   📦 Chunk {chunk_num}/{num_chunks}: {chunk_start_str} to {chunk_end_str}")

            # Request data from CAMS Global Reanalysis (EAC4)
            request = {
                'variable': [
                    # Core aerosol metrics
                    'total_aerosol_optical_depth_550nm',
                    'dust_aerosol_optical_depth_550nm',
                    'particulate_matter_2.5um',
                    'particulate_matter_10um',

                    # HIGH PRIORITY: Aerosol speciation for soiling source identification
                    'sea_salt_aerosol_optical_depth_550nm',       # Coastal influence (25-35% of events)
                    'organic_matter_aerosol_optical_depth_550nm',  # Agricultural sources (15-20% of events)
                    'sulphate_aerosol_optical_depth_550nm',       # Industrial emissions (5-10% of events)
                ],
                'date': f'{chunk_start_str}/{chunk_end_str}',
                'time': [f'{h:02d}:00' for h in range(24)],  # 3-hourly (00:00, 03:00, 06:00, ...)
                'area': [latitude+0.5, longitude-0.5, latitude-0.5, longitude+0.5],  # Small box around site
                'format': 'netcdf',
            }

            output_file = f'/tmp/cams_alpha1_chunk{chunk_num}.nc'
            print(f"      Requesting from CAMS server (may take 2-5 min)...")

            c.retrieve('cams-global-reanalysis-eac4', request, output_file)

            # Load NetCDF and convert to DataFrame
            import xarray as xr
            ds = xr.open_dataset(output_file)

            # Extract nearest grid point
            ds_point = ds.sel(latitude=latitude, longitude=longitude, method='nearest')

            # Get time coordinate (could be 'time' or 'valid_time')
            time_coord = 'valid_time' if 'valid_time' in ds_point.coords else 'time'

            # Convert to pandas DataFrame
            df_chunk = pd.DataFrame({
                'timestamp': ds_point[time_coord].values,
                'aod_550nm': ds_point['aod550'].values,
                'dust_aod_550nm': ds_point['duaod550'].values,
                'pm2p5': ds_point['pm2p5'].values,
                'pm10': ds_point['pm10'].values,

                # NEW: Aerosol speciation for source identification
                'sea_salt_aod_550nm': ds_point['ssaod550'].values,
                'organic_matter_aod_550nm': ds_point['omaod550'].values,
                'sulfate_aod_550nm': ds_point['suaod550'].values,
            })

            df_chunk['timestamp'] = pd.to_datetime(df_chunk['timestamp'])

            print(f"      ✅ Chunk {chunk_num} downloaded: {len(df_chunk):,} records")

            # Store chunk
            all_chunks.append(df_chunk)

            # Clean up NetCDF file
            ds.close()
            os.remove(output_file)

            # Move to next chunk
            current_start = chunk_end + timedelta(days=1)
            chunk_num += 1

        # Concatenate all chunks
        print(f"\n   🔗 Concatenating {len(all_chunks)} chunk(s)...")
        df_cams = pd.concat(all_chunks, ignore_index=True)

        # Sort by timestamp
        df_cams = df_cams.sort_values('timestamp').reset_index(drop=True)

        print(f"\n✅ CAMS data downloaded: {len(df_cams):,} 3-hourly records")
        print(f"   Total AOD range: {df_cams['aod_550nm'].min():.3f} - {df_cams['aod_550nm'].max():.3f}")
        print(f"   Dust AOD range: {df_cams['dust_aod_550nm'].min():.3f} - {df_cams['dust_aod_550nm'].max():.3f}")
        print(f"   Sea Salt AOD range: {df_cams['sea_salt_aod_550nm'].min():.3f} - {df_cams['sea_salt_aod_550nm'].max():.3f}")
        print(f"   Organic Matter AOD range: {df_cams['organic_matter_aod_550nm'].min():.3f} - {df_cams['organic_matter_aod_550nm'].max():.3f}")
        print(f"   Sulfate AOD range: {df_cams['sulfate_aod_550nm'].min():.3f} - {df_cams['sulfate_aod_550nm'].max():.3f}")

        # Convert to Polars
        df_cams_pl = pl.from_pandas(df_cams)

        # Save to cache
        if use_cache:
            cache_dir = _get_cache_dir()
            cache_key = _get_cache_key(
                'cams',
                lat=round(latitude, 4),
                lon=round(longitude, 4),
                start=start_date,
                end=end_date
            )
            cache_file = cache_dir / f"{cache_key}.parquet"
            df_cams_pl.write_parquet(cache_file)
            print(f"💾 Saved CAMS data to cache: {cache_file.name}")

        return df_cams_pl

    except Exception as e:
        print(f"⚠️ CAMS download failed: {e}")
        print(f"   Continuing without CAMS data (will use Alpha1 weather sensors only)")
        return None

def download_nasa_power_weather(latitude, longitude, start_date, end_date, use_cache=True):
    """
    Download NASA POWER weather data for Alpha1 location.

    Free data source (no API key required):
    https://power.larc.nasa.gov/

    Variables:
    - Precipitation (mm)
    - Temperature (°C)
    - Relative humidity (%)
    - Wind speed (m/s)

    Parameters:
    -----------
    use_cache : bool
        If True, cache downloaded data and reuse if available (default: True)
    """
    # Check cache first
    if use_cache:
        cache_dir = _get_cache_dir()
        cache_key = _get_cache_key(
            'nasa',
            lat=round(latitude, 4),
            lon=round(longitude, 4),
            start=start_date,
            end=end_date
        )
        cache_file = cache_dir / f"{cache_key}.parquet"

        if cache_file.exists():
            print(f"✅ Loading NASA POWER data from cache: {cache_file.name}")
            return pl.read_parquet(cache_file)

    base_url = "https://power.larc.nasa.gov/api/temporal/daily/point"
    
    params = {
        'parameters': 'PRECTOTCORR,T2M,RH2M,WS2M',
        'community': 'RE',
        'longitude': longitude,
        'latitude': latitude,
        'start': start_date.replace('-', ''),  # Format: YYYYMMDD
        'end': end_date.replace('-', ''),
        'format': 'JSON',
    }
    
    print(f"📥 Downloading NASA POWER weather data...")
    print(f"   Location: {latitude:.4f}°N, {longitude:.4f}°W")
    print(f"   Date range: {start_date} to {end_date}")
    print()
    
    try:
        response = requests.get(base_url, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()
        
        # Extract parameters
        params_data = data['properties']['parameter']
        
        # Convert to DataFrame
        df_nasa = pd.DataFrame({
            'date': pd.to_datetime(list(params_data['PRECTOTCORR'].keys())),
            'precipitation_nasa': list(params_data['PRECTOTCORR'].values()),
            'temperature_nasa': list(params_data['T2M'].values()),
            'humidity_nasa': list(params_data['RH2M'].values()),
            'wind_speed_nasa': list(params_data['WS2M'].values()),
        })
        
        # Remove fill values (-999)
        df_nasa = df_nasa.replace(-999, np.nan)
        
        print(f"✅ NASA POWER data downloaded: {len(df_nasa):,} daily records")
        print(f"   Precipitation days: {(df_nasa['precipitation_nasa'] > 0).sum()}")
        print(f"   Temperature range: {df_nasa['temperature_nasa'].min():.1f}°C - {df_nasa['temperature_nasa'].max():.1f}°C")

        # Convert to Polars
        df_nasa_pl = pl.from_pandas(df_nasa)

        # Save to cache
        if use_cache:
            cache_dir = _get_cache_dir()
            cache_key = _get_cache_key(
                'nasa',
                lat=round(latitude, 4),
                lon=round(longitude, 4),
                start=start_date,
                end=end_date
            )
            cache_file = cache_dir / f"{cache_key}.parquet"
            df_nasa_pl.write_parquet(cache_file)
            print(f"💾 Saved NASA POWER data to cache: {cache_file.name}")

        return df_nasa_pl

    except Exception as e:
        print(f"⚠️ NASA POWER download failed: {e}")
        print(f"   Continuing without NASA POWER data")
        return None
