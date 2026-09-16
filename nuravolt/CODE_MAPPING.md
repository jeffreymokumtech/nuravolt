# Code Extraction Mapping

## Extracted Cells

### Cell 0
```python
# Data processing
import polars as pl
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

# Solar physics
import pvlib
fr...
```

### Cell 1
```python
# Alpha1 9MW solar plant (Andalusia, Spain)
# Source: Plant_meta.csv (Plant ID: 461)
SITE_CONFIG = {
    'name': 'Alpha1 (ES)',
    'plant_id': 461,
    'latitude': 37.8145,      # Degrees north
 ...
```

### Cell 2
```python
# Load Alpha1 parquet file
data_path = Path('<repo>/demo_spain')
parquet_file = data_path / 'emsdt_650addffb0721062b19a6636_15_00461_Inverter_Inverter Power Normaliz...
```

### Cell 3
```python
# Create clean dataframe with standardized column names
df_clean = pd.DataFrame({
    'timestamp': pd.to_datetime(df_raw['timestamp'], format='%Y.%m.%d %H:%M'),
    
    # POA Irradiance (W/m²) - CRIT...
```

### Cell 4
```python
df_clean.timestamp.max()...
```

### Cell 5
```python
# Install required packages (run once)
# !pip install polars pvlib lightgbm plotly scikit-learn requests numpy pandas cdsapi boto3...
```

### Cell 6
```python
def download_cams_aerosol_data(latitude, longitude, start_date, end_date, api_key_file='~/.cdsapirc'):
    """
    Download CAMS aerosol data for Alpha1 location.

    Automatically splits large dat...
```

### Cell 7
```python
df_historical = download_cams_aerosol_data(
    latitude=37.5449,
    longitude=-5.6630,
    start_date='2022-01-01',
    end_date='2025-06-30'
)...
```

### Cell 8
```python
def download_nasa_power_weather(latitude, longitude, start_date, end_date):
    """
    Download NASA POWER weather data for Alpha1 location.
    
    Free data source (no API key required):
    htt...
```

### Cell 9
```python
# Merge CAMS aerosol data (if available)
df_cams = df_historical
if df_cams is not None:
    # Resample CAMS hourly to 15-min to match Alpha1 frequency
    df = df.join(
        df_cams,
        on=...
```

