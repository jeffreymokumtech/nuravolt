# NuraVolt Soiling Intelligence Methodology

Technical documentation for the 365-day soiling forecasting and cleaning optimization system.

## Table of Contents

1. [Overview](#1-overview)
2. [Soiling Ratio Calculation](#2-soiling-ratio-calculation)
3. [365-Day Forecasting Model](#3-365-day-forecasting-model)
4. [Cleaning Schedule Optimization](#4-cleaning-schedule-optimization)
5. [IEA Loss Disaggregation](#5-iea-loss-disaggregation)
6. [Curtailment Data Integration](#6-curtailment-data-integration)
7. [References](#7-references)

---

## 1. Overview

The NuraVolt Soiling Intelligence system provides:

- **Physics-ML Hybrid Forecasting**: Combines physics-based soiling models with CatBoost machine learning
- **365-Day Predictions**: Full-year soiling ratio forecasts with uncertainty quantification
- **Cleaning Optimization**: Exhaustive scenario analysis to maximize cleaning ROI
- **IEA-Compliant Loss Disaggregation**: Separates 7 loss categories per IEA PVPS Task 13

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    NuraVolt Soiling Intelligence                │
├─────────────────────────────────────────────────────────────────┤
│  Data Input                                                     │
│  ├── Power measurements (15-min resolution)                     │
│  ├── Irradiance (POA + clearsky)                               │
│  ├── Weather (temperature, rainfall, wind)                      │
│  └── Curtailment data (DV/EVU, optional)                       │
├─────────────────────────────────────────────────────────────────┤
│  Processing Pipeline                                            │
│  ├── Soiling Ratio Calculation (POA method)                    │
│  ├── Feature Engineering (80+ features)                        │
│  ├── CatBoost ML Model Training                                │
│  └── Physics-ML Hybrid Forecasting                             │
├─────────────────────────────────────────────────────────────────┤
│  Optimization & Analysis                                        │
│  ├── Cleaning Schedule Optimization (1000+ scenarios)          │
│  ├── IEA Loss Disaggregation (7 categories)                    │
│  └── Financial Impact Analysis                                  │
├─────────────────────────────────────────────────────────────────┤
│  Outputs                                                        │
│  ├── 365-day SR forecast with uncertainty bands                │
│  ├── Optimal cleaning dates & ROI                              │
│  ├── Loss waterfall (Sankey + bar charts)                      │
│  └── PDF report + interactive dashboard                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Soiling Ratio Calculation

### 2.1 POA Ratio Method

Soiling Ratio (SR) is calculated using the Plane-of-Array (POA) ratio method:

```
SR = POA_actual / POA_clearsky
```

Where:
- `POA_actual`: Measured plane-of-array irradiance (W/m²)
- `POA_clearsky`: Theoretical clear-sky POA using Ineichen-Perez model

### 2.2 Clear-Sky Model

We use the **Ineichen-Perez clear-sky model** via pvlib:

```python
from pvlib.clearsky import ineichen

clearsky = location.get_clearsky(times, model='ineichen')
poa_clearsky = irradiance.get_total_irradiance(
    surface_tilt=tilt,
    surface_azimuth=azimuth,
    dni=clearsky['dni'],
    ghi=clearsky['ghi'],
    dhi=clearsky['dhi'],
    solar_zenith=solar_position['zenith'],
    solar_azimuth=solar_position['azimuth']
)['poa_global']
```

### 2.3 Smoothing & Filtering

Raw SR values are processed with:

1. **Bounds clipping**: SR clipped to [0.5, 1.05] to remove unrealistic values
2. **Rolling median**: 7-day centered rolling median for noise reduction
3. **Daytime filtering**: Only periods with irradiance > 50 W/m²

```python
# 7-day rolling median (15-min data = 4 samples/hour × 24h × 7 days)
window_samples = 7 * 24 * 4  # 672 samples
sr_smooth = sr_raw.rolling(window_samples, center=True).median()
```

### 2.4 Soiling Loss Percentage

```
Soiling_Loss_% = (1 - SR) × 100
```

Example: SR = 0.95 → 5% soiling loss

---

## 3. 365-Day Forecasting Model

### 3.1 Physics Baseline

The physics model provides an interpretable baseline:

```python
# Daily soiling rate (Andalusia climate)
base_rate = 0.0025  # 0.25%/day

# Seasonal modulation
if month in [5, 6, 7, 8, 9]:  # Dry season (May-Sept)
    seasonal_factor = 1.5  # Higher soiling
else:  # Wet season (Oct-Apr)
    seasonal_factor = 0.5  # Lower soiling

daily_soiling = base_rate * seasonal_factor

# Daily SR degradation
SR_day_n = SR_day_n-1 - daily_soiling
```

### 3.2 Rain Cleaning Effect

Rain events provide natural cleaning:

```python
if rainfall_mm > rain_threshold:  # Default: 10mm
    cleaning_effectiveness = min(0.95, rainfall_mm / 20.0)
    SR_after_rain = SR_before + (1.0 - SR_before) * cleaning_effectiveness
```

| Rainfall | Effectiveness | Example |
|----------|---------------|---------|
| 10 mm | 50% | SR: 0.90 → 0.95 |
| 15 mm | 75% | SR: 0.90 → 0.975 |
| 20+ mm | 95% | SR: 0.90 → 0.995 |

### 3.3 CatBoost ML Corrections

The ML model learns residual patterns not captured by physics:

**Features (80+):**
- Historical soiling patterns (7, 14, 30, 60, 90-day windows)
- Weather features (rainfall, temperature, humidity, wind)
- Temporal features (day of year, month, season flags)
- Physics features (solar geometry, air mass)

**Model Configuration:**
```python
from catboost import CatBoostRegressor

model = CatBoostRegressor(
    iterations=500,
    learning_rate=0.05,
    depth=6,
    l2_leaf_reg=3,
    random_seed=42,
    verbose=False
)
```

**Why CatBoost over LightGBM:**
- 4.9% lower MAE in our tests (0.0567 vs 0.0596)
- Better handling of categorical features
- More robust to overfitting on small datasets

### 3.4 Hybrid Prediction

Final prediction combines physics and ML:

```python
# First ~90 days: Use ML corrections
if horizon_days <= 90:
    sr_predicted = sr_physics + ml_correction
else:
    # Beyond 90 days: Physics only (ML uncertainty too high)
    sr_predicted = sr_physics

# Ensure realistic bounds
sr_predicted = np.clip(sr_predicted, 0.5, 1.0)
```

### 3.5 Uncertainty Quantification

Prediction intervals widen with forecast horizon:

```python
# Base uncertainty
base_uncertainty = 0.02  # 2%

# Horizon-dependent growth
horizon_factor = 1 + (horizon_days / 365) * 0.5

# Final bounds
sr_lower = sr_predicted - base_uncertainty * horizon_factor
sr_upper = sr_predicted + base_uncertainty * horizon_factor
```

---

## 4. Cleaning Schedule Optimization

### 4.1 Algorithm Overview

The system uses **exhaustive search with constraints**:

```
1. Generate candidate dates (52 per year)
   ├── Summer (May-Sept): every 7 days
   └── Winter (Oct-Apr): every 14 days

2. For each cleaning count (1-5):
   ├── Generate valid combinations (min 14 days apart)
   ├── Test up to 1,000 scenarios per count
   └── Calculate net benefit for each

3. Select optimal: Maximum net benefit
```

### 4.2 Scenario Evaluation

For each cleaning scenario:

```python
# Simulate cleaning effect
for clean_date in cleaning_dates:
    sr_before = forecast.loc[clean_date, 'sr_predicted']
    sr_after = sr_before + (1.0 - sr_before) * cleaning_effectiveness
    # Propagate improvement forward

# Calculate metrics
energy_recovered = sum(energy_if_clean - energy_with_soiling)
revenue_recovered = energy_recovered * electricity_rate
cleaning_cost = n_cleanings * cost_per_MW * capacity_MW
net_benefit = revenue_recovered - cleaning_cost
roi_pct = (net_benefit / cleaning_cost) * 100
```

### 4.3 Why 3 Cleanings is Optimal (Alpha1 9MW Example)

Analysis of cleaning comparison data:

| Cleanings | Net Benefit | ROI | Marginal Benefit |
|-----------|-------------|-----|------------------|
| 1 | €305,733 | 5662% | - |
| 2 | €353,036 | 3269% | +€47,303 |
| **3** | **€360,868** | **2228%** | **+€7,832** |
| 4 | €359,746 | 1665% | **-€1,122** |
| 5 | €356,489 | 1320% | -€3,257 |

**Key Insight:** The 4th cleaning has **negative marginal benefit** (-€1,122). This is because:

1. **Diminishing returns**: Each additional cleaning recovers less energy as the baseline SR is already higher
2. **Fixed costs**: Each cleaning costs €5,400 (€600/MW × 9MW) regardless of benefit
3. **Seasonal timing**: The 4th cleaning would likely fall in winter when energy production is lower

**Optimal dates for Alpha1:**
- November 5, 2025 (pre-winter)
- December 31, 2025 (mid-winter)
- February 11, 2026 (late winter)

Average spacing: 49 days

### 4.4 Summer Prioritization

Summer cleanings are weighted higher:

```python
# June-August cleanings recover ~1.5x more energy
# due to higher irradiance and longer days
summer_months = [6, 7, 8]
summer_weight = 1.5
```

---

## 5. IEA Loss Disaggregation

### 5.1 Sequential Subtraction Method

Following IEA PVPS Task 13 methodology:

```
Reference Energy (100%)
    │
    ├─► Temperature Loss ──────► L_temp
    │
    ├─► Spectral Loss ─────────► L_spectral
    │
    ├─► Soiling Loss ──────────► L_soiling (CONTROLLABLE)
    │
    ├─► Inverter Loss ─────────► L_inverter
    │
    ├─► Wiring/BOP Loss ───────► L_wiring
    │
    ├─► Degradation Loss ──────► L_degradation
    │
    └─► Curtailment Loss ──────► L_curtailment

    = Net Energy Output
```

### 5.2 Loss Calculation Formulas

#### Temperature Loss
```python
# Cell temperature using SAPM model
T_cell = T_ambient + (G_poa / 800) * (T_noct - 20)

# Temperature coefficient (mono-Si)
gamma = -0.004  # -0.4%/°C

# Temperature loss factor
L_temp = gamma * (T_cell - 25)  # Relative to STC (25°C)
```

#### Spectral Loss
```python
# IEC 61853-3 simplified model
def spectral_modifier(air_mass):
    if air_mass <= 1.5:
        return 1.0
    else:
        return 0.99 - 0.01 * min(air_mass - 1.5, 3.0)

L_spectral = 1 - spectral_modifier(AM)
```

#### Soiling Loss
```python
# From soiling ratio calculation
L_soiling = 1 - SR_smooth
```

#### Inverter Efficiency Loss
```python
# Efficiency curve by load fraction
EFFICIENCY_CURVE = {
    0.05: 0.88, 0.10: 0.92, 0.20: 0.96,
    0.30: 0.975, 0.50: 0.985, 0.75: 0.98, 1.00: 0.97
}

eta_inv = np.interp(load_fraction,
                    list(EFFICIENCY_CURVE.keys()),
                    list(EFFICIENCY_CURVE.values()))
L_inverter = 1 - eta_inv
```

#### Wiring/BOP Loss
```python
# Fixed system loss (cables, transformers, connections)
L_wiring = 0.02  # 2%
```

#### Degradation Loss
```python
# Annual degradation for crystalline silicon
degradation_rate = 0.005  # 0.5%/year
L_degradation = system_age_years * degradation_rate
```

#### Curtailment Loss
```python
# From DV/EVU data (100 = no curtailment)
L_curtailment = 1 - (dv_value / 100)
```

### 5.3 Loss Categories Summary

| Loss | Typical Range | Controllable | Mitigation |
|------|---------------|--------------|------------|
| Temperature | 2-8% | Partially | Improved ventilation |
| Spectral | 0.5-2% | No | None |
| **Soiling** | **3-10%** | **Yes** | **Cleaning** |
| Inverter | 1-3% | No | Proper sizing |
| Wiring/BOP | 1-3% | No | System design |
| Degradation | 0.5-1%/yr | No | Quality modules |
| Curtailment | 0-10% | External | Grid capacity |

---

## 6. Curtailment Data Integration

### 6.1 DV/EVU Data Format

Expected input format:

```csv
timestamp,dv_value,curtailment_type
2024-01-01 08:00:00,100,none
2024-01-01 12:00:00,80,grid_limit
2024-01-01 12:15:00,60,frequency_control
2024-01-01 12:30:00,100,none
```

| Column | Description |
|--------|-------------|
| `timestamp` | ISO 8601 datetime |
| `dv_value` | 0-100 (100 = no curtailment) |
| `curtailment_type` | Category: none, grid_limit, frequency_control, voltage_control |

### 6.2 Loading Curtailment Data

```python
from nuravolt.soiling.loss_disaggregation import CurtailmentLoader

loader = CurtailmentLoader()
df_curt = loader.load_curtailment_file(
    filepath='curtailment_data.csv',
    timestamp_col='timestamp',
    value_col='dv_value'
)

# Merge with production data
df_merged = loader.merge_with_production(
    df_production=df_power,
    df_curtailment=df_curt,
    method='nearest'  # Align timestamps
)
```

### 6.3 Curtailment Loss Calculation

```python
# Curtailment factor (0 = no loss, 1 = full curtailment)
curtailment_factor = 1 - (dv_value / 100)

# Example: DV = 80 → curtailment_factor = 0.20 (20% curtailed)
```

---

## 7. References

### Standards & Guidelines

1. **IEA PVPS Task 13** - Performance and Reliability of Photovoltaic Systems
   - Report T13-11:2021: Uncertainty in Yield Assessments and PV LCOE
   - Guidelines for loss disaggregation methodology

2. **IEC 61853** - Photovoltaic Module Performance Testing
   - Part 3: Energy rating of PV modules
   - Spectral response characterization

3. **SAPM** - Sandia Array Performance Model
   - Cell temperature modeling
   - King, D.L. et al., Sandia National Laboratories

### Software Libraries

- **pvlib-python**: Solar position, clear-sky models, irradiance calculations
- **CatBoost**: Gradient boosting for ML predictions
- **Polars**: High-performance data processing
- **Plotly**: Interactive visualizations

### Academic References

- Micheli, L. et al. (2017). "Correlating photovoltaic soiling losses to waveband and single-value transmittance measurements." Energy, 180, 376-386.
- Maghami, M.R. et al. (2016). "Power loss due to soiling on solar panel: A review." Renewable and Sustainable Energy Reviews, 59, 1307-1316.

---

## Appendix A: Module Configuration

### Site Configuration Parameters

```python
SITE_CONFIG = {
    'name': 'Alpha1 (ES)',
    'latitude': 38,
    'longitude': -4,
    'elevation': 450,  # meters
    'timezone': 'Europe/Madrid',
    'capacity_MW': 9.0,
    'tilt': 20,  # degrees
    'azimuth': 180,  # south-facing

    # Economics
    'cleaning_cost_per_MW': 600,  # €/MW
    'electricity_rate_per_MWh': 65,  # €/MWh

    # Soiling
    'expected_soiling_rate_per_day': 0.25,  # %/day
    'rain_cleaning_threshold_mm': 10,
}
```

### Feature List (Abbreviated)

| Category | Features |
|----------|----------|
| Historical Soiling | sr_mean_7d, sr_mean_14d, sr_std_30d, soiling_rate_7d |
| Weather | rainfall_sum_7d, temp_mean_14d, humidity_mean_7d |
| Temporal | month, day_of_year, is_dry_season, is_summer_peak |
| Physics | air_mass, solar_elevation, spectral_correction |

---

*Document Version: 1.0*
*Last Updated: November 2025*
*NuraVolt Soiling Intelligence System*
