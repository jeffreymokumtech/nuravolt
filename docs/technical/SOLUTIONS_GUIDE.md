# NuraVolt Energy Intelligence Solutions Guide

Comprehensive technical documentation for NuraVolt's physics-informed ML solutions across Solar PV, Battery Energy Storage Systems (BESS), and Wind.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Solar PV Analytics](#solar-pv-analytics)
   - [Soiling Intelligence](#soiling-intelligence)
   - [Digital Twin](#digital-twin-physics-ml-hybrid)
   - [Fault Detection](#fault-detection)
   - [RUL Prediction](#rul-remaining-useful-life-prediction)
4. [BESS Analytics](#bess-analytics)
   - [Dispatch Optimization](#dispatch-optimization)
   - [State of Health Estimation](#state-of-health-soh-estimation)
   - [Thermal Runaway Protection](#thermal-runaway-protection)
   - [Warranty Tracking](#warranty-tracking)
5. [Wind Analytics](#wind-analytics)
   - [Power Curve Analysis](#power-curve-analysis)
   - [Gearbox Predictive Maintenance](#gearbox-predictive-maintenance)
   - [Wake Effect Modeling](#wake-effect-modeling)
6. [ML vs Non-ML Decision Framework](#ml-vs-non-ml-decision-framework)
7. [Public Datasets Reference](#public-datasets-reference)
8. [Achievable Metrics on Public Data](#achievable-metrics-on-public-data)
9. [Implementation Examples](#implementation-examples)
10. [Integration Patterns](#integration-patterns)
11. [Business Value Sources](#business-value-sources)
12. [Troubleshooting Guide](#troubleshooting-guide)

---

## Executive Summary

NuraVolt provides physics-informed machine learning solutions for renewable energy asset monitoring and optimization. Our hybrid approach combines domain physics (PVLib, electrochemistry, aerodynamics) with ML models (LightGBM, CatBoost) for robust performance across diverse operating conditions.

### Platform Capabilities at a Glance

| Domain | Key Capabilities | Advance Warning | Primary Models |
|--------|------------------|-----------------|----------------|
| **Solar PV** | Soiling forecasting, fault detection, RUL prediction, digital twin | Days to weeks | LightGBM, CatBoost, PVWatts |
| **BESS** | SoH estimation, dispatch optimization, thermal protection, warranty | Minutes to months | LP/MILP, LightGBM, LSTM |
| **Wind** | Power curve analysis, gearbox PdM, wake modeling | 1-24 months | LightGBM NBM, Jensen model |

### Code Reuse Across Domains

The NuraVolt architecture enables 75-80% code reuse between domains:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Core Framework (shared)                       │
│  - Feature engineering patterns                                  │
│  - ML model architecture (LightGBM/CatBoost wrappers)           │
│  - Anomaly detection (Isolation Forest, residual analysis)       │
│  - Time series forecasting (LSTM, Prophet)                       │
│  - Schedule optimization (LP/MILP via cvxpy)                     │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │   PV     │        │   BESS   │        │   Wind   │
    │ nuravolt/│        │ nuravolt/│        │ nuravolt/│
    │ soiling/ │        │ bess/    │        │ wind/    │
    │ fault/   │        │          │        │          │
    │ digital- │        │          │        │          │
    │ twin/    │        │          │        │          │
    └──────────┘        └──────────┘        └──────────┘
```

---

## Architecture Overview

### Design Philosophy: Physics-ML Hybrid

All NuraVolt solutions follow a consistent hybrid architecture that combines the interpretability of physics models with the adaptability of machine learning:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Input Data Layer                             │
│  SCADA | Weather API | Satellite | BMS | SCADA | Anemometer     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Physics Model Layer                            │
│                                                                  │
│  Solar: PVWatts (irradiance → power)                            │
│  BESS: Electrochemical (Arrhenius degradation)                  │
│  Wind: Betz limit, power curve (wind → power)                   │
│                                                                  │
│  Output: Expected Value (P_physics)                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Residual Analysis                            │
│                                                                  │
│  Residual = Actual - P_physics                                  │
│                                                                  │
│  This residual captures:                                         │
│  - Site-specific effects (shading, micro-climate)               │
│  - Equipment degradation beyond physics model                    │
│  - Anomalies and faults                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ML Correction Layer                           │
│                                                                  │
│  Model: LightGBM / CatBoost                                     │
│  Input: Environmental features + residual history                │
│  Output: ML correction (ΔP_ml)                                  │
│                                                                  │
│  Final Prediction = P_physics + ΔP_ml                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Application Layer                             │
│                                                                  │
│  - Forecasting (365-day soiling, power, degradation)            │
│  - Anomaly Detection (z-score on residuals)                     │
│  - RUL Prediction (when will threshold be breached?)            │
│  - Schedule Optimization (LP/MILP)                              │
└─────────────────────────────────────────────────────────────────┘
```

### Why Physics-ML Hybrid?

| Aspect | Pure ML | Pure Physics | Hybrid (NuraVolt) |
|--------|---------|--------------|-------------------|
| **New plant deployment** | Requires 6+ months data | Immediate | Physics immediate, ML improves over time |
| **Interpretability** | Black box | Fully interpretable | Physics baseline + ML corrections |
| **Data efficiency** | Data hungry | No data needed | Works with limited data |
| **Edge case handling** | Extrapolates poorly | May miss real-world effects | Physics constrains, ML adapts |
| **Maintenance burden** | Needs retraining | Static equations | ML retrains, physics stable |

---

## Solar PV Analytics

### Module Structure

```
nuravolt/
├── soiling/                        # Soiling Intelligence
│   ├── sr_ml_model.py              # CatBoost soiling ratio model
│   ├── sr_ml_features.py           # 34 plant-agnostic features
│   ├── sr_transfer_learning.py     # Transfer from DustIQ plants
│   ├── schedule_optimizer.py       # LP-based cleaning optimization
│   ├── forecasting_longterm.py     # 365-day hybrid forecaster
│   ├── loss_disaggregation.py      # IEA loss decomposition
│   ├── event_detection.py          # Rain/cleaning event detection
│   └── per_inverter_analysis.py    # Fleet-wide SR analysis
│
├── digitaltwin/                    # Physics-ML Digital Twins
│   ├── hybrid_model.py             # PVWatts + LightGBM hybrid
│   ├── physics_model.py            # PVWatts implementation
│   ├── feature_engineering.py      # Physics-only features (NO power lags)
│   ├── anomaly_detector.py         # 24-hour smoothed anomaly detection
│   ├── plant_factory.py            # Plant-level model factory
│   └── string_twin.py              # String-level monitoring
│
├── fault/                          # Fault Detection & RUL
│   ├── rule_based.py               # 10+ fault type threshold rules
│   ├── rul_models.py               # 7 CatBoost RUL models
│   ├── pretraining.py              # Foundation model on PVDAQ
│   ├── digital_twins.py            # Thermal twins for inverters
│   └── maintenance_scheduler.py    # O&M scheduling & ticketing
```

---

### Soiling Intelligence

#### Overview

Soiling (dust/dirt accumulation) causes 2-7% annual yield loss in most climates, rising to 25%+ in desert environments ([IEA PVPS Task 13](https://iea-pvps.org/key-topics/soiling-losses-impact-on-performance-of-photovoltaic-power-plants/)). NuraVolt's soiling intelligence provides:

1. **Daily soiling ratio (SR) estimation** - Current cleanliness level
2. **365-day soiling forecasts** - Plan cleaning campaigns
3. **Optimal cleaning schedules** - Maximize ROI on cleaning
4. **Loss disaggregation** - Separate soiling from other losses

#### Soiling Ratio Estimation Methods

NuraVolt supports 5 tiers of soiling estimation, chosen automatically based on data availability:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tier 1: DustIQ Sensors                        │
│                                                                  │
│  Data: Direct SR measurement from optical sensor                 │
│  Accuracy: Ground truth (±1%)                                   │
│  Use: Training data for ML models, validation                    │
│  Cost: ~$5K per sensor                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if no DustIQ)
┌─────────────────────────────────────────────────────────────────┐
│              Tier 2: Same-Plant ML Model                         │
│                                                                  │
│  Data: 6+ months SCADA + weather + AOD                          │
│  Accuracy: MAE 1-3%                                             │
│  Method: Train CatBoost on rain-based pseudo-labels             │
│  Advantage: Learns site-specific patterns                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if <6 months data)
┌─────────────────────────────────────────────────────────────────┐
│              Tier 3: Transfer Learning                           │
│                                                                  │
│  Data: Weather + AOD only                                       │
│  Accuracy: MAE 3-5%                                             │
│  Method: Fine-tune foundation model from similar plants          │
│  Advantage: Works with zero historical data                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if no similar plants)
┌─────────────────────────────────────────────────────────────────┐
│              Tier 4: Foundation Model                            │
│                                                                  │
│  Data: Weather + AOD only                                       │
│  Accuracy: MAE 4-6%                                             │
│  Method: Pre-trained model on 20+ global plants                  │
│  Advantage: Universal, no training needed                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (fallback)
┌─────────────────────────────────────────────────────────────────┐
│              Tier 5: Loss Disaggregation (IEA)                   │
│                                                                  │
│  Data: SCADA only                                               │
│  Accuracy: MAE 5-8%                                             │
│  Method: Sequential subtraction (physics-based)                  │
│  Advantage: No external data needed                              │
└─────────────────────────────────────────────────────────────────┘
```

#### ML Model: SoilingRatioModel

**File**: `nuravolt/soiling/sr_ml_model.py`

**Algorithm**: CatBoost Regressor with quantile loss

```python
# Model configuration
class SoilingRatioModelConfig:
    iterations: int = 2000          # Training iterations
    learning_rate: float = 0.02     # Conservative learning rate
    depth: int = 6                  # Tree depth
    l2_leaf_reg: float = 3.0        # Regularization

    # Quantile loss biases toward lower values (catches soiling drops)
    loss_function: str = 'Quantile:alpha=0.3'

    # Physical constraints
    min_sr: float = 0.75            # 25% soiling is extreme
    max_sr: float = 1.0             # Clean panel
```

**Mathematical Formulation**:

The model predicts daily soiling ratio SR(t) as:

```
SR(t) = f_CatBoost(X_weather(t), X_aod(t), X_temporal(t), X_location)

where:
  X_weather = [precip, temp, humidity, wind] + rolling aggregations
  X_aod = [aod_550nm, dust_aod, pm10, pm2p5] + cumulative sums
  X_temporal = [day_of_year, month, season_sin, season_cos, is_dry_season]
  X_location = [latitude, longitude, climate_zone, distance_to_coast]
```

**Physical constraints enforced**:
- SR monotonically decreases between rain events (natural soiling accumulation)
- SR resets to ~0.99 after heavy rain (>5mm)
- SR bounded in [0.75, 1.0]

#### Complete Feature Set (34 features)

**File**: `nuravolt/soiling/sr_ml_features.py`

| Category | Feature | Description | Why It Matters |
|----------|---------|-------------|----------------|
| **Rainfall** | `precip_today` | Today's precipitation (mm) | Primary cleaning mechanism |
| | `precip_7d` | 7-day cumulative precipitation | Recent cleaning history |
| | `precip_14d` | 14-day cumulative precipitation | Medium-term cleaning |
| | `precip_30d` | 30-day cumulative precipitation | Long-term pattern |
| | `days_since_rain` | Days since last >1mm rain | Time since cleaning |
| | `heavy_rain_7d` | Count of >5mm rain days in 7d | Strong cleaning events |
| | `max_daily_precip_7d` | Max single-day precip in 7d | Cleaning intensity |
| **Temperature** | `temp_mean` | Daily mean temperature (°C) | Affects dew formation |
| | `temp_7d_avg` | 7-day average temperature | Temperature trend |
| | `temp_delta` | Daily temperature range | Thermal cycling |
| | `temp_range` | Max - min temperature | Condensation potential |
| **Humidity** | `humidity_mean` | Daily mean humidity (%) | Dust adhesion |
| | `humidity_7d` | 7-day average humidity | Humidity trend |
| | `high_humidity_hours` | Hours with humidity >80% | Cementation risk |
| **Wind** | `wind_speed` | Daily mean wind speed (m/s) | Dust transport |
| | `wind_7d` | 7-day average wind | Sustained wind effect |
| | `wind_gustiness` | Wind speed std deviation | Turbulent deposition |
| **Aerosol (AOD)** | `aod_550nm` | Aerosol optical depth at 550nm | Atmospheric dust load |
| | `dust_aod` | Dust-specific AOD | Desert dust contribution |
| | `pm10` | Particulate matter 10μm | Coarse dust particles |
| | `pm2p5` | Particulate matter 2.5μm | Fine dust particles |
| | `aod_7d_cum` | 7-day cumulative AOD | Recent dust exposure |
| | `aod_14d_cum` | 14-day cumulative AOD | Medium-term exposure |
| | `aod_30d_cum` | 30-day cumulative AOD | Long-term exposure |
| | `dust_event_flag` | AOD > 0.5 indicator | Dust storm detection |
| **Temporal** | `day_of_year` | Day of year (1-365) | Seasonal position |
| | `month` | Month (1-12) | Monthly patterns |
| | `is_dry_season` | Dry season indicator | Climate seasonality |
| | `season_sin` | sin(2π × doy/365) | Seasonal encoding |
| | `season_cos` | cos(2π × doy/365) | Seasonal encoding |
| | `days_in_dry_spell` | Consecutive dry days | Accumulation period |
| **Location** | `latitude` | Plant latitude | Solar geometry |
| | `climate_zone` | Climate classification | Soiling pattern type |
| | `distance_to_coast_km` | Distance to coast | Sea salt influence |

#### 365-Day Soiling Forecast

**File**: `nuravolt/soiling/forecasting_longterm.py`

**Algorithm**: Physics baseline + ML corrections

```python
def forecast_365d(
    current_sr: float,
    weather_forecast: pd.DataFrame,  # From Open-Meteo seasonal API
    cleaning_schedule: list,
    cleaning_efficiency: float = 0.98
) -> pd.DataFrame:
    """
    Generate 365-day soiling ratio forecast.

    Physics Model:
        SR(t+1) = SR(t) - soiling_rate(weather_t)

        soiling_rate = base_rate × (1 + dust_factor) × (1 - rain_factor)

        where:
          base_rate = 0.002/day (0.2%/day, typical)
          dust_factor = AOD / 0.3 - 1 (scaled by typical AOD)
          rain_factor = min(1, precip / 5mm) (>5mm = full cleaning)

    ML Correction:
        SR_corrected = SR_physics + ml_model.predict(features)
    """
    sr_trajectory = []
    sr = current_sr

    for day in range(365):
        # Physics: natural soiling accumulation
        weather = weather_forecast.iloc[day]

        # Base soiling rate (climate-adjusted)
        base_rate = get_base_soiling_rate(climate_zone)  # 0.1-0.5%/day

        # Dust factor from AOD
        dust_factor = max(0, weather['aod_550nm'] / 0.3 - 1)

        # Rain cleaning
        rain_factor = min(1.0, weather['precipitation'] / 5.0)

        # Net soiling rate
        soiling_rate = base_rate * (1 + dust_factor) * (1 - rain_factor)
        sr = sr - soiling_rate

        # ML correction (captures site-specific patterns)
        features = engineer_features(weather)
        ml_correction = ml_model.predict([features])[0]
        sr = sr + ml_correction

        # Scheduled cleaning events
        if day in cleaning_schedule:
            sr = min(1.0, sr + cleaning_efficiency)

        # Physical bounds
        sr = np.clip(sr, 0.75, 1.0)

        sr_trajectory.append({
            'date': start_date + timedelta(days=day),
            'soiling_ratio': sr,
            'soiling_loss_pct': (1 - sr) * 100
        })

    return pd.DataFrame(sr_trajectory)
```

#### Cleaning Schedule Optimization

**File**: `nuravolt/soiling/schedule_optimizer.py`

**Method**: Linear Programming (no ML required)

**Mathematical Formulation**:

```
Objective:
    max Σ[t=1 to T] (energy_recovered[t] × price - cleaning_cost[t] × clean[t])

where:
    energy_recovered[t] = plant_capacity × insolation[t] × ΔSR[t]
    ΔSR[t] = (SR_after_cleaning - SR_before_cleaning) × clean[t]

Subject to:
    clean[t] ∈ {0, 1}                       # Binary: clean or not
    Σ[t to t+min_interval] clean ≤ 1        # Minimum days between cleanings
    Σ clean ≤ max_cleanings                  # Budget constraint
    clean[t] = 0 if rain[t] > 5mm           # Don't clean before rain
    clean[t] = 0 if unavailable[t]          # Crew availability
```

**Implementation**:

```python
from nuravolt.soiling import CleaningScheduleOptimizer

optimizer = CleaningScheduleOptimizer(
    plant_capacity_kwp=10000,
    cleaning_cost_per_cleaning=500,  # USD
    electricity_price_per_kwh=0.08,   # USD
    min_days_between_cleanings=14,
)

schedule = optimizer.optimize(
    soiling_forecast=sr_forecast,     # From 365-day forecast
    insolation_forecast=insolation,   # kWh/kWp/day
    max_cleanings=24,                 # Budget for 24 cleanings/year
    blackout_dates=['2025-03-10', '2025-03-20'],  # Ramadan, etc.
)

print(f"Optimal cleaning dates: {schedule.dates}")
print(f"Expected energy recovery: {schedule.energy_recovered_mwh:.1f} MWh")
print(f"Total cost: ${schedule.total_cost:.0f}")
print(f"ROI: {schedule.roi:.1%}")
```

#### IEA Loss Disaggregation

**File**: `nuravolt/soiling/loss_disaggregation.py`

**Reference**: IEA PVPS Task 13, IEC 61853-3

**Method**: Sequential subtraction to separate loss components:

```
┌────────────────────────────────────────────────────────────────┐
│                     Reference Energy                            │
│     E_ref = Σ(GHI × Area × η_STC)                              │
└────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Temperature Loss   │ (weather-dependent)
                    │ L_temp = γ(T-25)   │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Spectral Loss      │ (weather-dependent)
                    │ L_spec ~ AM effect │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Soiling Loss       │ ← CONTROLLABLE
                    │ L_soil = 1 - SR    │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Inverter Loss      │ (equipment)
                    │ L_inv = 1 - η_inv  │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Wiring/BOP Loss    │ (fixed ~2%)
                    │ L_wiring = 2%      │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Degradation Loss   │ (time-dependent)
                    │ L_deg = 0.5%/year  │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Curtailment Loss   │ (external/grid)
                    │ L_curt = detected  │
                    └─────────┬─────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                      Net Energy                                 │
│     E_net = E_ref × (1-L_temp) × (1-L_spec) × ...             │
└────────────────────────────────────────────────────────────────┘
```

**Usage**:

```python
from nuravolt.soiling import IEALossDisaggregator

disaggregator = IEALossDisaggregator(
    plant_capacity_kwp=10000,
    installation_date='2020-01-01',
    module_type='mono-Si',
    gamma_pmax=-0.004,  # Temperature coefficient
)

losses = disaggregator.calculate(
    df_power=power_data,           # Measured AC power
    df_weather=weather_data,       # Temperature, irradiance
    df_curtailment=curtailment,    # Optional: known curtailment periods
)

print(losses.to_table())
# Output:
# | Loss Category      | Loss (%) | Energy Loss (MWh) |
# |--------------------|----------|-------------------|
# | Temperature        | 3.2      | 156.4             |
# | Spectral           | 1.1      | 53.8              |
# | Soiling            | 4.5      | 220.1             | ← Controllable
# | Inverter           | 2.8      | 137.0             |
# | Wiring/BOP         | 2.0      | 97.8              |
# | Degradation        | 2.5      | 122.3             |
# | Curtailment        | 0.8      | 39.1              |
# | TOTAL              | 16.9     | 826.5             |
```

---

### Digital Twin (Physics-ML Hybrid)

#### Overview

The digital twin predicts expected power output from environmental conditions, enabling:
- Real-time underperformance detection
- Anomaly localization (which inverter/string?)
- Long-term degradation tracking
- Commissioning validation

#### Architecture

**File**: `nuravolt/digitaltwin/hybrid_model.py`

```
┌─────────────────────────────────────────────────────────────────┐
│                    Input: Environmental Data                     │
│  GHI, Temperature, Wind Speed, Timestamp                        │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│    Physics Model        │     │     ML Model            │
│    (PVWatts)            │     │     (LightGBM)          │
│                         │     │                         │
│  P_physics = f(GHI,T,θ) │     │  ΔP = g(features)       │
│                         │     │                         │
│  Uses:                  │     │  Learns:                │
│  - Solar geometry       │     │  - Site-specific shade  │
│  - Temperature model    │     │  - Micro-climate        │
│  - Angle of incidence   │     │  - Equipment aging      │
└─────────────────────────┘     └─────────────────────────┘
              │                               │
              └───────────────┬───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           Hybrid Prediction: P_expected = P_physics + ΔP        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Anomaly Detection: |P_actual - P_expected| > 3σ    │
└─────────────────────────────────────────────────────────────────┘
```

#### Physics Model (PVWatts)

**File**: `nuravolt/digitaltwin/physics_model.py`

```python
class PVWattsPhysicsModel:
    """
    PVWatts-based physics model for expected power.

    P_dc = P_dc0 × (G_poa / G_stc) × (1 + γ(T_cell - T_stc))

    where:
      P_dc0 = Nameplate DC capacity
      G_poa = Plane-of-array irradiance
      G_stc = 1000 W/m² (Standard Test Conditions)
      γ = Temperature coefficient (-0.4%/°C typical)
      T_cell = Cell temperature (from NOCT model)
      T_stc = 25°C
    """

    def calculate_expected_power(
        self,
        ghi: float,
        ambient_temp: float,
        wind_speed: float,
        timestamp: datetime
    ) -> float:
        # 1. Calculate solar position
        solar_position = pvlib.solarposition.get_solarposition(
            timestamp, self.latitude, self.longitude
        )

        # 2. Transpose irradiance to plane of array
        poa = pvlib.irradiance.get_total_irradiance(
            surface_tilt=self.tilt,
            surface_azimuth=self.azimuth,
            solar_zenith=solar_position['apparent_zenith'],
            solar_azimuth=solar_position['azimuth'],
            ghi=ghi,
            # ... DNI, DHI from decomposition model
        )

        # 3. Calculate cell temperature (NOCT model)
        t_cell = pvlib.temperature.sapm_cell(
            poa['poa_global'],
            ambient_temp,
            wind_speed,
            a=-3.47, b=-0.0594, deltaT=3
        )

        # 4. Calculate DC power
        p_dc = self.capacity * (poa['poa_global'] / 1000) * \
               (1 + self.gamma_pdc * (t_cell - 25))

        # 5. Apply inverter efficiency
        p_ac = p_dc * self.inverter_efficiency(p_dc / self.capacity)

        return p_ac
```

#### Physics-Only Features (NO Power Lags)

**File**: `nuravolt/digitaltwin/feature_engineering.py`

**Critical Design Rule**: Features must NOT include power measurements to avoid data leakage.

| Category | Feature | Formula | Why Allowed |
|----------|---------|---------|-------------|
| **Solar Geometry** | `zenith` | θ_z from timestamp + location | Calculated |
| | `azimuth` | γ_s from timestamp + location | Calculated |
| | `air_mass` | AM = 1/cos(θ_z) | Calculated |
| | `elevation` | From solar position | Calculated |
| **Irradiance** | `ghi` | Measured | Environmental input |
| | `poa_global` | Transposed irradiance | Calculated from GHI |
| | `poa_direct` | Direct component | Calculated |
| | `poa_diffuse` | Diffuse component | Calculated |
| | `clearsky_index` | GHI / GHI_clearsky | Quality indicator |
| **Temperature** | `ambient_temp` | Measured | Environmental input |
| | `cell_temp` | NOCT model output | Calculated |
| | `temp_delta` | T_cell - T_ambient | Calculated |
| **Angle Effects** | `aoi` | Angle of incidence | Calculated |
| | `iam` | Incidence angle modifier | Physical factor |
| **Temporal** | `hour_sin` | sin(2π × hour/24) | Cyclical encoding |
| | `hour_cos` | cos(2π × hour/24) | Cyclical encoding |
| | `doy_sin` | sin(2π × doy/365) | Seasonal encoding |
| | `doy_cos` | cos(2π × doy/365) | Seasonal encoding |

**PROHIBITED Features** (cause data leakage):

```python
PROHIBITED_FEATURES = {
    'power_lag_1', 'power_lag_2', 'power_lag_3',  # Lagged power
    'power_rolling_mean', 'power_rolling_std',     # Rolling power stats
    'cumulative_energy',                            # Energy accumulation
    'performance_ratio',                            # Derived from power!
}
```

---

### Fault Detection

#### Rule-Based Detection (No ML)

**File**: `nuravolt/fault/rule_based.py`

10+ fault types detected via threshold rules:

| Fault Type | Rule | Severity | Response |
|------------|------|----------|----------|
| **Inverter Offline** | `status != running` for >5 min | CRITICAL | Immediate dispatch |
| **DC Overvoltage** | `v_dc > 1.1 × v_rated` | HIGH | Check strings, shade |
| **DC Undervoltage** | `v_dc < 0.8 × v_expected` | HIGH | Check connections |
| **String Mismatch** | `string_cv > 15%` | MEDIUM | Inspect underperformer |
| **Tracker Fault** | `position_error > 5°` for >30 min | MEDIUM | Check actuator |
| **Communication Loss** | No data for >15 min | HIGH | Check network |
| **Grid Fault** | `|freq - 50Hz| > 0.5` | CRITICAL | Grid operator issue |
| **Overcurrent** | `i_dc > 1.2 × i_rated` | HIGH | Check for shorts |
| **Underperformance** | `actual < 0.75 × expected` | MEDIUM | Multiple causes |
| **Ground Fault** | `riso < 40 MΩ/kWp` | HIGH | Insulation issue |
| **Thermal Alarm** | `t_inverter > 60°C` | HIGH | Cooling issue |

**Usage**:

```python
from nuravolt.fault import RuleBasedFaultDetector, FaultDetectionConfig

config = FaultDetectionConfig(
    inverter_thresholds=InverterThresholds(
        max_temperature=60.0,
        min_efficiency=0.90,
    ),
    string_thresholds=StringThresholds(
        max_current_cv=0.15,
        min_voltage_ratio=0.85,
    ),
)

detector = RuleBasedFaultDetector(config)
result = detector.detect_all(scada_df)

for alert in result.alerts:
    print(f"[{alert.severity}] {alert.fault_type}: {alert.message}")
    print(f"  Location: {alert.component_id}")
    print(f"  Recommended: {alert.recommended_action}")
```

---

### RUL (Remaining Useful Life) Prediction

#### Overview

RUL models predict "days until threshold breach" for various fault types, enabling proactive maintenance.

**File**: `nuravolt/fault/rul_models.py`

#### Available Models

| Model | Target | Threshold | Horizon | Algorithm |
|-------|--------|-----------|---------|-----------|
| `RULStringDegradationModel` | String current CV | >25% | 14 days | CatBoost |
| `RULInverterThermalModel` | Inverter temp | >65°C | 10 days | CatBoost |
| `RULModuleDegradationModel` | Performance ratio | <75% | 90 days | CatBoost |
| `RULThermalHotspotModel` | Cell temp delta | >25°C | 10 days | CatBoost |
| `RULMismatchModel` | Worst string ratio | <85% | 14 days | CatBoost |
| `RULBypassDiodeModel` | Hotspot count | >3 | 7 days | CatBoost |
| `RULInsulationModel` | Insulation resistance | <40 MΩ | 90 days | CatBoost |

#### Feature Sets by Model

**String Degradation Model**:

| Feature | Description | Source |
|---------|-------------|--------|
| `string_current_cv` | Coefficient of variation of string currents | SCADA |
| `string_cv_trend_7d` | 7-day rolling slope of CV | Calculated |
| `string_current_min_ratio` | Min string / mean string | SCADA |
| `string_current_max_ratio` | Max string / mean string | SCADA |
| `irradiance_normalized` | GHI / 1000 | SCADA |
| `module_temp` | Module temperature | SCADA |

**Inverter Thermal Model**:

| Feature | Description | Source |
|---------|-------------|--------|
| `temp_rise` | T_inverter - T_ambient | SCADA |
| `temp_rise_trend_7d` | 7-day rolling slope | Calculated |
| `ambient_temp` | Ambient temperature | SCADA |
| `ac_power_pu` | AC power / rated power | SCADA |
| `irradiance_normalized` | GHI / 1000 | SCADA |

#### RUL Algorithm

```python
def predict_rul(model, current_features: dict) -> RULPrediction:
    """
    Predict remaining useful life to threshold breach.

    Method:
    1. Predict current degradation level
    2. Extrapolate trend to threshold
    3. Apply confidence based on prediction uncertainty
    """

    # Current value prediction
    current_value = current_features[model.config.primary_feature]

    # Get trend from historical data
    trend = current_features[model.config.trend_feature]  # units/day

    # Calculate days to threshold
    if model.config.higher_is_worse:
        # Increasing metric (e.g., temperature)
        distance_to_threshold = model.config.threshold - current_value
        if trend <= 0:
            days_to_fault = float('inf')  # Improving, not degrading
        else:
            days_to_fault = distance_to_threshold / trend
    else:
        # Decreasing metric (e.g., PR)
        distance_to_threshold = current_value - model.config.threshold
        if trend >= 0:
            days_to_fault = float('inf')  # Improving
        else:
            days_to_fault = distance_to_threshold / abs(trend)

    # Cap at model horizon
    days_to_fault = min(days_to_fault, model.config.max_horizon_days)

    # Calculate confidence based on trend stability
    confidence = calculate_trend_confidence(trend_history)

    return RULPrediction(
        fault_type=model.config.fault_type,
        days_to_fault=days_to_fault,
        confidence=confidence,
        threshold=model.config.threshold,
        current_value=current_value,
        trend=trend,
        is_urgent=days_to_fault < 3
    )
```

---

## BESS Analytics

### Module Structure

```
nuravolt/bess/
├── dispatch_optimizer.py     # LP/MPC dispatch optimization
├── soh_estimator.py          # LightGBM SoH estimation
├── thermal_monitor.py        # 3-tier thermal protection
└── warranty_tracker.py       # Compliance tracking
```

---

### Dispatch Optimization

#### Overview

Optimal charge/discharge scheduling to maximize arbitrage revenue while managing degradation. **No ML required** - pure mathematical optimization.

**File**: `nuravolt/bess/dispatch_optimizer.py`

#### Mathematical Formulation

```
OBJECTIVE:
    max Σ[t=1 to T] (price[t] × (discharge[t] - charge[t]) × Δt - degradation_cost[t])

DECISION VARIABLES:
    charge[t] ≥ 0          # Charge power at time t (kW)
    discharge[t] ≥ 0       # Discharge power at time t (kW)
    soc[t] ≥ 0             # State of charge at time t (kWh)

CONSTRAINTS:
    # Power limits
    charge[t] ≤ P_max
    discharge[t] ≤ P_max

    # SoC limits
    SoC_min × Capacity ≤ soc[t] ≤ SoC_max × Capacity

    # Energy balance (with efficiency losses)
    soc[t+1] = soc[t] + charge[t] × √η × Δt - discharge[t] / √η × Δt

    # Initial condition
    soc[0] = initial_soc × Capacity

    # Optional: No simultaneous charge/discharge
    charge[t] × discharge[t] = 0  (requires binary variables for exact)

DEGRADATION MODEL:
    degradation_cost[t] = k_deg × (charge[t] + discharge[t]) × Δt

    where k_deg ≈ $0.01/kWh (varies by chemistry, depth of discharge)
```

#### Implementation

```python
from nuravolt.bess import BESSDispatchOptimizer

# Initialize optimizer
optimizer = BESSDispatchOptimizer(
    capacity_kwh=1000,              # 1 MWh battery
    max_power_kw=250,               # C/4 rate
    efficiency=0.90,                # 90% round-trip
    soc_min=0.10,                   # Don't discharge below 10%
    soc_max=0.90,                   # Don't charge above 90%
    degradation_cost_per_kwh=0.01,  # $0.01/kWh throughput
)

# Day-ahead optimization
prices = get_day_ahead_prices()  # 24-hour price forecast ($/kWh)
result = optimizer.optimize_day_ahead(
    prices=prices,
    initial_soc=0.5,
)

print(f"Revenue: ${result.revenue:.2f}")
print(f"Charge schedule: {result.charge_schedule}")
print(f"Discharge schedule: {result.discharge_schedule}")

# Visualization
import matplotlib.pyplot as plt

fig, axes = plt.subplots(3, 1, figsize=(12, 8))

# Price profile
axes[0].plot(prices, 'b-', label='Price')
axes[0].set_ylabel('Price ($/kWh)')
axes[0].legend()

# Charge/discharge
axes[1].bar(range(24), result.discharge_schedule, label='Discharge', alpha=0.7)
axes[1].bar(range(24), -result.charge_schedule, label='Charge', alpha=0.7)
axes[1].set_ylabel('Power (kW)')
axes[1].legend()

# SoC
axes[2].plot(result.soc_schedule / optimizer.capacity * 100, 'g-')
axes[2].axhline(y=10, color='r', linestyle='--', alpha=0.5)
axes[2].axhline(y=90, color='r', linestyle='--', alpha=0.5)
axes[2].set_ylabel('SoC (%)')
axes[2].set_xlabel('Hour')

plt.tight_layout()
```

#### MPC (Model Predictive Control)

For real-time operation with updated forecasts:

```python
from nuravolt.bess import MPCDispatcher

mpc = MPCDispatcher(optimizer, horizon=24)

# At each timestep
for hour in range(24):
    # Get updated price forecast
    price_forecast = get_updated_forecast(start_hour=hour)

    # Get action for current timestep
    charge_kw, discharge_kw = mpc.get_action(
        current_soc=current_soc,
        price_forecast=price_forecast,
    )

    # Execute action
    execute_dispatch(charge_kw, discharge_kw)

    # Update SoC
    current_soc = update_soc(current_soc, charge_kw, discharge_kw)
```

#### When to Add ML

| Scenario | ML Approach | Benefit |
|----------|-------------|---------|
| Volatile intraday prices | LightGBM price forecaster | 10-20% revenue improvement |
| Multi-market arbitrage | Deep RL (DQN/DDPG) | Learns complex market dynamics |
| Ancillary services stacking | Multi-agent RL | Optimizes across revenue streams |
| Unknown degradation curve | Transfer learning | Better warranty compliance |

---

### State of Health (SoH) Estimation

#### Overview

A LightGBM design for predicting battery capacity degradation from operational data.

**File**: `nuravolt/bess/soh_estimator.py`

**Honesty boundary**: this estimator has never been trained or loaded in production.
Every SoH number the platform serves today comes from the chemistry
`EmpiricalDegradationModel` in `nuravolt/bess/warranty_tracker.py`. Training the
estimator needs real measured capacity tests (`BessCapacityTest` rows of
`test_type` `standard` or `partial`, not the `estimated` points the twin writes);
fitting it on modelled SoH would launder the degradation model's own assumptions
back as if they were independent evidence. So `predict()` raises
`NotImplementedError` when no trained artifact is loaded, rather than returning a
number from an unfitted booster. The feature set and training code below are the
design that a real capacity-test dataset would activate.

#### Feature Set

| Feature | Description | Source | Why It Matters |
|---------|-------------|--------|----------------|
| `cycle_count` | Equivalent full cycles | Calculated | Primary aging indicator |
| `total_ah_throughput` | Cumulative amp-hours | BMS | Total usage metric |
| `avg_temperature` | Mean operating temp (°C) | BMS | Arrhenius degradation |
| `avg_c_rate` | Average charge/discharge rate | Calculated | Rate-dependent aging |
| `dod_variance` | Variance in depth of discharge | Calculated | Deep cycle stress |
| `rest_time_ratio` | Time at rest / total time | Calculated | Calendar aging indicator |
| `high_soc_hours` | Hours at SoC > 80% | Accumulated | High-SoC stress |
| `high_temp_hours` | Hours at temp > 35°C | Accumulated | Thermal stress |
| `calendar_days` | Days since installation | Calendar | Calendar aging |

#### Algorithm

```python
class SoHEstimator:
    """
    LightGBM-based SoH estimation with physics constraints.

    SoH = f(usage_features) + physics_correction

    Physics constraint: SoH monotonically decreases
    """

    def engineer_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Engineer features from cycle data.

        Input: Raw BMS data (voltage, current, temperature, SoC)
        Output: Feature matrix for SoH prediction
        """
        return df.with_columns([
            # Equivalent Full Cycles
            (pl.col('energy_throughput') / (2 * self.nominal_capacity))
                .alias('cycle_count'),

            # Temperature statistics
            pl.col('temperature').mean().alias('avg_temperature'),
            (pl.col('temperature') > 35).sum().alias('high_temp_hours'),

            # C-rate statistics
            (pl.col('current').abs() / self.nominal_capacity)
                .mean().alias('avg_c_rate'),

            # DoD variance
            (pl.col('soc').max() - pl.col('soc').min())
                .std().alias('dod_variance'),

            # Rest time
            ((pl.col('current').abs() < 0.01).sum() / pl.len())
                .alias('rest_time_ratio'),

            # High SoC time
            (pl.col('soc') > 0.8).sum().alias('high_soc_hours'),
        ])

    def train(self, features: pl.DataFrame, soh_targets: pl.Series):
        """
        Train LightGBM with physics constraints.
        """
        # Standard LightGBM training
        self.model = lgb.train(
            params={
                'objective': 'regression',
                'metric': 'mae',
                'learning_rate': 0.1,
                'max_depth': 6,
            },
            train_set=lgb.Dataset(features, soh_targets),
            num_boost_round=100,
        )

        # Store for physics correction
        self.last_soh = soh_targets.max()

    def predict(self, features: np.ndarray) -> np.ndarray:
        """
        Predict SoH from features.

        Raises NotImplementedError when no trained artifact is loaded, which
        is the production state today. Only once train() or load() has run on
        real capacity-test data does this return numbers: the booster output
        clipped to [min_soh, max_soh], optionally blended with a physics model
        at physics_weight.
        """
        if not self.is_fitted:
            raise NotImplementedError(
                "No trained SoH artifact is loaded, and none exists to load: "
                "SoH is served by the chemistry EmpiricalDegradationModel in "
                "nuravolt/bess/warranty_tracker.py, not by this estimator."
            )

        predictions = np.clip(
            self.model.predict(np.atleast_2d(features)),
            self.config.min_soh,
            self.config.max_soh,
        )
        if self.physics is not None:
            predictions = (
                (1 - self.config.physics_weight) * predictions
                + self.config.physics_weight * self.physics.predict(features)
            )
        return predictions
```

#### RUL Projection

`predict_rul` is independent of the booster: it extrapolates linearly from a SoH
value you hand it (in practice the `EmpiricalDegradationModel` number) to the
end-of-life threshold, and derives its own interval instead of asserting a
confidence.

```python
    def predict_rul(
        self,
        current_soh: float,
        usage_profile: dict,
        eol_threshold: float = 0.70,
        soh_history: Optional[Sequence[Tuple[float, float]]] = None,
    ) -> dict:
        """
        Project remaining useful life to the end-of-life threshold.

        soh_history is an optional sequence of (cumulative_cycles, soh)
        observations, for example real capacity tests. With three or more
        points that have spread in cycles, the degradation rate is the OLS
        slope of SoH on cumulative cycles and the 95 % interval on
        cycles-to-EOL is propagated from that slope's standard error (Student-t
        critical value, normal approximation beyond df=30). Without history the
        rate falls back to usage_profile['degradation_per_cycle'] (default
        0.0001), whose error is not derivable, so the bounds and confidence
        come back as None with a stated basis rather than an invented number.
        """
```

Returned keys:

| Key | Meaning |
|-----|---------|
| `rul_days`, `rul_cycles` | Point projection to `eol_threshold` |
| `rul_days_low/high`, `rul_cycles_low/high` | 95 % interval, or `None` without a fit |
| `degradation_per_cycle` | Rate actually used |
| `degradation_source` | `ols_fit`, `assumed`, or `observed_soh` when already at EOL |
| `n_observations`, `fit_r2` | Size and fit quality of the regression |
| `confidence` | `1 - relative half-width` of the interval, `None` when there is no fit, `0.0` when the slope is not distinguishable from zero at 95 % |
| `confidence_level` | `0.95` when derived, `None` otherwise |
| `confidence_basis` | Sentence stating what the confidence rests on |
| `status` | `eol_reached`, `degraded` (SoH <= 0.8), or `healthy` |

`cycles_per_day <= 0` and a non-positive degradation rate both raise
`ValueError` rather than projecting an infinite life.

#### Accuracy Reported in the Literature

These are published results for LightGBM-class SoH estimators on the NASA
Li-ion Battery Dataset. They are not NuraVolt measurements: the estimator has
not been trained, so we have no accuracy figure of our own.

| Metric | Value | Source |
|--------|-------|--------|
| MAPE | 0.1-0.9% | [MDPI 2023](https://www.mdpi.com/2076-3417/13/11/6540) |
| Accuracy | 90.69% | [SpringerLink 2024](https://link.springer.com/chapter/10.1007/978-981-97-8160-7_6) |
| RMSE | 1.2-2.5% | Literature |

---

### Thermal Runaway Protection

#### Overview

Multi-tier approach for battery thermal safety with increasing sophistication:

**File**: `nuravolt/bess/thermal_monitor.py`

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tier 3: Deep Learning                         │
│                                                                  │
│  Model: LSTM + Residual Analysis                                │
│  Warning: Hours ahead                                           │
│  Accuracy: 95%                                                  │
│  Requires: 3+ months training data                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if insufficient data)
┌─────────────────────────────────────────────────────────────────┐
│                Tier 2: Statistical Anomaly                       │
│                                                                  │
│  Model: Isolation Forest                                        │
│  Warning: Minutes-hours ahead                                   │
│  Accuracy: 90%                                                  │
│  Requires: 1+ month training data                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if no training data)
┌─────────────────────────────────────────────────────────────────┐
│               Tier 1: Rule-Based Thresholds                      │
│                                                                  │
│  Model: Configurable thresholds                                 │
│  Warning: Seconds-minutes                                       │
│  Accuracy: 80%                                                  │
│  Requires: No training data (immediate deployment)              │
└─────────────────────────────────────────────────────────────────┘
```

#### Tier 1: Rule-Based Monitoring

```python
from nuravolt.bess import ThermalRuleBasedMonitor, ThermalThresholds

thresholds = ThermalThresholds(
    temp_warning=45.0,        # °C - Warning level
    temp_critical=60.0,       # °C - Critical level
    temp_rate_warning=1.0,    # °C/min - Warning rate
    temp_rate_critical=5.0,   # °C/min - Critical rate
    temp_gradient=5.0,        # °C - Max cell-to-cell difference
    voltage_deviation=0.05,   # 5% from expected
)

monitor = ThermalRuleBasedMonitor(thresholds)

# Check single cell
cell_data = {
    'temperature': 55.0,
    'temp_rate': 0.8,
    'temp_gradient': 3.0,
    'voltage': 3.65,
    'expected_voltage': 3.70,
}

alert = monitor.check_cell(cell_data)
print(f"Level: {alert.level}")
print(f"Reasons: {alert.reasons}")
print(f"Action: {alert.recommended_action}")

# Check entire pack
pack_alerts = monitor.check_pack([cell_1, cell_2, cell_3, ...])
if pack_alerts['pack_level'] == 'critical':
    trigger_emergency_shutdown()
```

#### Tier 2: Statistical Anomaly Detection

```python
from nuravolt.bess import ThermalAnomalyDetector

detector = ThermalAnomalyDetector(contamination=0.01)

# Train on healthy operation data
# Features: [temp, temp_rate, voltage, current, temp_gradient]
healthy_data = get_healthy_operation_data()  # Shape: (n_samples, 5)
detector.fit_baseline(healthy_data)

# Monitor in production
current_data = get_current_readings()  # Shape: (5,)
result = detector.detect(current_data)

if result['is_anomaly']:
    print(f"ANOMALY DETECTED!")
    print(f"Anomaly score: {result['anomaly_score']:.2f}")
    print(f"Top contributor: {result['top_contributor']}")
    print(f"Z-scores: {result['z_scores']}")
```

#### Tier 3: LSTM Residual Analysis

```python
from nuravolt.bess import ThermalResidualMonitor

class ThermalResidualMonitor:
    """
    Train LSTM on normal operation, monitor for prediction residuals.
    Large residual = unexpected thermal behavior = potential runaway.
    """

    def __init__(self, lstm_model, threshold_sigma=3.0):
        self.model = lstm_model
        self.threshold = threshold_sigma
        self.residual_history = []

    def check(self, recent_window: np.ndarray, actual_temp: float) -> dict:
        """
        Compare LSTM prediction vs actual temperature.

        Args:
            recent_window: Last N timesteps of data (shape: (1, N, features))
            actual_temp: Current measured temperature
        """
        # Predict expected temperature
        predicted = self.model.predict(recent_window)[0, 0]

        # Calculate residual
        residual = actual_temp - predicted
        self.residual_history.append(residual)

        # Z-score on rolling window
        if len(self.residual_history) >= 100:
            mean_r = np.mean(self.residual_history[-100:])
            std_r = np.std(self.residual_history[-100:])
            z_score = (residual - mean_r) / (std_r + 1e-6)
        else:
            z_score = 0

        return {
            'predicted_temp': predicted,
            'actual_temp': actual_temp,
            'residual': residual,
            'z_score': z_score,
            'is_anomaly': abs(z_score) > self.threshold,
            'warning_level': (
                'critical' if z_score > 5 else
                'warning' if z_score > 3 else
                'normal'
            )
        }
```

---

### Warranty Tracking

#### Overview

Track battery usage against warranty terms to ensure compliance and forecast warranty dates.

**File**: `nuravolt/bess/warranty_tracker.py`

#### Typical Warranty Terms

| Warranty Type | Typical Terms | Analytics Needed |
|---------------|--------------|------------------|
| **Capacity** | ≥70-80% after 10-15 years | Track actual vs warranted capacity |
| **Cycles** | 3,000-10,000 equivalent full cycles | Count EFC accurately |
| **Throughput** | X MWh over lifetime | Track cumulative energy |
| **Availability** | ≥95-98% uptime | Track downtime causes |
| **Temperature** | Operating range 0-45°C | Track exceedances |

#### Implementation

```python
from nuravolt.bess import WarrantyTracker, WarrantyTerms

terms = WarrantyTerms(
    capacity_guarantee_pct=0.70,   # 70% after warranty period
    warranty_years=10,
    max_cycles=5000,
    max_throughput_mwh=5000,
    min_rte=0.85,
    max_avg_soc=0.80,
    max_operating_temp=35.0,
)

tracker = WarrantyTracker(terms, nominal_capacity_kwh=1000)

# Update from cycle data
for cycle in cycles:
    tracker.update_from_cycle({
        'energy_in_kwh': cycle.charge_energy,
        'energy_out_kwh': cycle.discharge_energy,
        'duration_hours': cycle.duration,
        'avg_soc': cycle.avg_soc,
        'max_soc': cycle.max_soc,
        'avg_temp': cycle.avg_temp,
        'max_temp': cycle.max_temp,
        'dod': cycle.depth_of_discharge,
    })

# Get warranty status
status = tracker.get_warranty_status()

print(f"Current SoH: {status['current_soh']:.1%}")
print(f"Warranty threshold: {status['warranty_soh_threshold']:.1%}")
print(f"SoH margin: {status['soh_margin']:.1%}")
print(f"Cycle usage: {status['cycle_usage_pct']:.1%}")
print(f"Cycles remaining: {status['cycles_remaining']:.0f}")
print(f"Risk factors: {status['risk_factors']}")
print(f"Recommendation: {status['recommendation']}")
```

#### Degradation Model

```python
from nuravolt.bess import EmpiricalDegradationModel

model = EmpiricalDegradationModel()

# Predict capacity loss
loss = model.predict_capacity_loss(
    cycles=1000,
    years=2,
    avg_temp=30.0,
    avg_dod=0.8,
)
print(f"Predicted capacity loss: {loss:.1%}")

# Forecast warranty date
forecast = model.forecast_warranty_date(
    current_soh=0.85,
    warranty_threshold=0.70,
    usage_profile={
        'cycles_per_year': 365,
        'avg_dod': 0.8,
        'avg_temp': 28.0,
    }
)
print(f"Years to warranty threshold: {forecast['years_to_warranty']:.1f}")
```

---

## Wind Analytics

### Module Structure

```
nuravolt/wind/
├── power_curve.py       # IEC 61400-12-1 power curve analysis
├── gearbox_monitor.py   # Normal Behavior Modeling for PdM
└── wake_model.py        # Jensen wake model for farm optimization
```

---

### Power Curve Analysis

#### Overview

Power curve analysis is the wind equivalent of Performance Ratio for solar. It compares actual power output against expected (from OEM power curve).

**File**: `nuravolt/wind/power_curve.py`

**Reference**: IEC 61400-12-1 standard

#### Concept

```
┌─────────────────────────────────────────────────────────────────┐
│                    OEM Power Curve                               │
│                                                                  │
│  Power                                                          │
│    ▲                              ┌─────────────────            │
│    │                         ╱────┘ Rated Power                 │
│    │                     ╱──┘                                   │
│    │                 ╱──┘                                       │
│    │             ╱──┘                                           │
│    │         ╱──┘                                               │
│    │     ╱──┘                                                   │
│    │ ╱──┘                                                       │
│    ├──────────────────────────────────────────────▶ Wind Speed  │
│    0  3   5   7   9  11  13  15  17  19  21  23  25             │
│       ↑                   ↑                    ↑                 │
│    Cut-in            Rated Speed           Cut-out              │
└─────────────────────────────────────────────────────────────────┘

Power Curve Efficiency = Actual Power / Expected Power (from curve)
```

#### Implementation

```python
from nuravolt.wind import PowerCurveAnalyzer, TurbineSpecs

# OEM power curve (from manufacturer data sheet)
oem_curve = {
    'wind_speed': [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 25],
    'power': [0, 0, 75, 180, 350, 600, 900, 1300, 1800, 2400, 2900, 3000, 3000, 3000, 3000]
}

specs = TurbineSpecs(
    rated_power_kw=3000,
    rotor_diameter_m=126,
    hub_height_m=90,
    cut_in_speed=3.0,
    cut_out_speed=25.0,
    rated_speed=12.0,
)

analyzer = PowerCurveAnalyzer(oem_curve, rated_power_kw=3000, specs=specs)

# Analyze single point
result = analyzer.analyze_point(
    wind_speed=10.0,
    actual_power=1650,
    air_density=1.20,  # Slightly lower than standard (1.225)
)

print(f"Expected power: {result.expected_power_kw:.0f} kW")
print(f"Actual power: {result.actual_power_kw:.0f} kW")
print(f"Efficiency: {result.efficiency:.1%}")
print(f"Power deficit: {result.power_deficit_kw:.0f} kW")
print(f"Underperforming: {result.is_underperforming}")
print(f"Cause category: {result.cause_category}")

# Batch analysis
df_analyzed = analyzer.analyze_dataframe(scada_df)
underperformers = df_analyzed.filter(pl.col('is_underperforming'))
```

#### Air Density Correction

Power output is proportional to air density:

```
P_corrected = P_oem × (ρ_actual / ρ_standard)

where:
  ρ_standard = 1.225 kg/m³
  ρ_actual = f(temperature, pressure, humidity)
```

#### Data Filtering

Remove invalid operating points before analysis:

```python
def filter_valid_data(df: pl.DataFrame, specs: TurbineSpecs) -> pl.DataFrame:
    """Remove curtailment, maintenance, etc."""
    return df.filter(
        # Wind speed in operational range
        (pl.col('wind_speed') >= specs.cut_in_speed) &
        (pl.col('wind_speed') <= specs.cut_out_speed) &

        # Not curtailed (power reasonable for wind speed)
        ~(
            (pl.col('wind_speed') > specs.rated_speed) &
            (pl.col('power') < 0.5 * specs.rated_power_kw)
        ) &

        # Turbine running
        (pl.col('rotor_speed') > 1.0) &

        # No fault codes
        (pl.col('status_code') == 0) &

        # Steady conditions (low turbulence)
        (pl.col('wind_speed_std') < 2.0)
    )
```

---

### Gearbox Predictive Maintenance

#### Overview

Normal Behavior Modeling (NBM) for drivetrain health monitoring. Train ML model on healthy operation, monitor for deviations.

**File**: `nuravolt/wind/gearbox_monitor.py`

**Reference**: Tautz-Weinert & Watson, 2017 - SCADA-based condition monitoring

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              Input: SCADA Data (healthy operation)               │
│                                                                  │
│  wind_speed, rotor_speed, power, ambient_temp, nacelle_temp,    │
│  generator_speed, pitch_angle                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LightGBM Model                                │
│                                                                  │
│  Learns: f(operational_conditions) → expected_temperature        │
│                                                                  │
│  Why LightGBM:                                                  │
│  - Fast training/inference                                       │
│  - Handles non-linear relationships                              │
│  - Good with operational SCADA ranges                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Residual Analysis                             │
│                                                                  │
│  Residual = T_actual - T_predicted                              │
│                                                                  │
│  Normal: Residual ~ N(μ, σ) with μ ≈ 0, σ ≈ 2-3°C              │
│  Anomaly: |Residual| > 3σ sustained over time                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Health Assessment                             │
│                                                                  │
│  Health Score = 100 - (anomaly_rate × 100) - (max_zscore × 10)  │
│                                                                  │
│  Score > 85: Normal operation                                   │
│  Score 70-85: Advisory - monitor closely                         │
│  Score 50-70: Warning - schedule inspection                      │
│  Score < 50: Critical - immediate action                         │
└─────────────────────────────────────────────────────────────────┘
```

#### Feature Set

| Feature | Description | Normal Range | Anomaly Indicator |
|---------|-------------|--------------|-------------------|
| `wind_speed` | Nacelle anemometer (m/s) | 3-25 | Input only |
| `rotor_speed` | Rotor RPM | 6-15 | Input only |
| `power` | Active power (kW) | 0-rated | Input only |
| `ambient_temp` | External temp (°C) | -20 to 40 | Input only |
| `nacelle_temp` | Nacelle internal (°C) | 10-50 | Input only |
| `generator_speed` | Generator RPM | 900-1800 | Input only |
| `pitch_angle` | Blade pitch (°) | 0-90 | Input only |

#### Target Temperatures

| Target | Normal Range | Warning | Critical |
|--------|--------------|---------|----------|
| `gearbox_bearing_temp` | Ambient + 30-50°C | >70°C | >80°C |
| `gearbox_oil_temp` | 40-70°C | >75°C | >85°C |
| `generator_bearing_de_temp` | Ambient + 40-60°C | >80°C | >90°C |
| `generator_bearing_nde_temp` | Ambient + 30-50°C | >70°C | >80°C |

#### Implementation

```python
from nuravolt.wind import GearboxNBMModel, MultiComponentMonitor, NBMConfig

# Configure model
config = NBMConfig(
    n_estimators=100,
    learning_rate=0.1,
    max_depth=6,
    zscore_warning=3.0,
    zscore_critical=5.0,
)

# Initialize NBM
nbm = GearboxNBMModel(config)

# Train on healthy historical data
healthy_data = get_healthy_scada(turbine_id='WTG-01', period='2023')
metrics = nbm.train(healthy_data, target='gearbox_bearing_temp')

print(f"Training MAE: {metrics['train_mae']:.2f}°C")
print(f"Validation MAE: {metrics['val_mae']:.2f}°C")
print(f"Residual std: {metrics['residual_std']:.2f}°C")

# Monitor in production
current_data = get_current_scada('WTG-01')
df_monitored = nbm.predict_and_detect(current_data, target='gearbox_bearing_temp')

# Check for anomalies
anomalies = df_monitored.filter(pl.col('gearbox_bearing_temp_anomaly'))
if len(anomalies) > 0:
    print(f"ANOMALY DETECTED at {anomalies['timestamp'][0]}")
    print(f"Z-score: {anomalies['gearbox_bearing_temp_zscore'][0]:.1f}")
```

#### Multi-Component Monitoring

```python
monitor = MultiComponentMonitor()

# Train all component models
train_metrics = monitor.train_all_components(healthy_data)

# Monitor fleet
for turbine_id in turbine_ids:
    current_data = get_current_scada(turbine_id)
    health_results = monitor.monitor(current_data)

    for health in health_results:
        if health.health_score < 70:
            print(f"[WARNING] {turbine_id}: {health.primary_indicator}")
            print(f"  Health score: {health.health_score:.0f}")
            print(f"  Recommendation: {health.recommendation}")
```

#### Business Value

- **Gearbox failure cost**: $200,000-500,000 per failure ([IET Research 2017](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248))
- **SCADA-based detection rate**: 67% ([IET Research 2017](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248))
- **Advance warning**: 1 month to 2 years before failure ([IET Research 2017](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248))

---

### Wake Effect Modeling

#### Overview

Upstream turbines create "wind shadows" that reduce output from downstream turbines. Wake modeling quantifies this loss for:
- Layout optimization
- Power forecasting
- O&M planning (wake-related fatigue)

**File**: `nuravolt/wind/wake_model.py`

#### Jensen/Park Wake Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    Jensen Wake Model                             │
│                                                                  │
│           Wind Direction →                                      │
│                                                                  │
│  Upstream    ══════════════════════════════╗     Downstream     │
│  Turbine     ║  Wake Zone (velocity deficit)║     Turbine       │
│     T1       ╚══════════════════════════════╝        T2         │
│     ●────────────────────────────────────────────────●          │
│              │←──── x_downstream ────→│                          │
│                                                                  │
│  Wake expansion: D_wake = D_rotor + 2 × k × x                   │
│  where k = 0.04 (offshore) to 0.075 (onshore)                   │
│                                                                  │
│  Velocity deficit: δ = (1 - √(1 - Ct)) × (D_rotor / D_wake)²   │
│                                                                  │
│  Wake speed: U_wake = U_freestream × (1 - δ)                    │
└─────────────────────────────────────────────────────────────────┘
```

#### Implementation

```python
from nuravolt.wind import WakeFarmModel, SimpleJensenWake, TurbinePosition

# Define turbine positions
positions = [
    TurbinePosition(x=0, y=0, hub_height=90, rotor_diameter=126),
    TurbinePosition(x=500, y=0, hub_height=90, rotor_diameter=126),
    TurbinePosition(x=1000, y=0, hub_height=90, rotor_diameter=126),
    TurbinePosition(x=0, y=500, hub_height=90, rotor_diameter=126),
    TurbinePosition(x=500, y=500, hub_height=90, rotor_diameter=126),
]

# Create farm model
farm = WakeFarmModel(positions, backend='simple')

# Power curve function
def power_curve(wind_speed):
    if wind_speed < 3:
        return 0
    elif wind_speed < 12:
        return 3000 * ((wind_speed - 3) / 9) ** 3
    elif wind_speed < 25:
        return 3000
    else:
        return 0

# Calculate farm power for given wind conditions
result = farm.calculate_farm_power(
    wind_speed=10.0,
    wind_direction=270,  # West wind
    turbine_power_curve=power_curve,
)

print(f"Total farm power: {result['total_power']:.0f} kW")
print(f"Wake losses: {result['wake_losses_pct']:.1f}%")
print(f"Individual turbine powers: {result['turbine_powers']}")
print(f"Effective wind speeds: {result['effective_wind_speeds']}")
```

#### Wake Superposition

For multiple upstream turbines:

```python
def calculate_combined_wake(upstream_deficits: list) -> float:
    """
    Sum-of-squares wake superposition (Katic, 1986).

    combined_deficit = √(Σ δᵢ²)
    """
    return np.sqrt(sum(d**2 for d in upstream_deficits))
```

#### When to Use More Sophisticated Models

| Model | Use Case | Accuracy | Compute |
|-------|----------|----------|---------|
| Jensen/Park | Quick O&M estimates | ±10% | Fast |
| Bastankhah (Gaussian) | Better near-wake | ±7% | Fast |
| FLORIS | Yaw optimization | ±5% | Medium |
| PyWake | Research, validation | ±5% | Medium |
| CFD (LES) | Layout optimization | ±2% | Very slow |

---

## ML vs Non-ML Decision Framework

### Decision Matrix

| Problem | Non-ML Approach | ML Approach | When to Use ML | ML Benefit |
|---------|-----------------|-------------|----------------|------------|
| **PV Soiling Estimation** | IEA loss disaggregation | LightGBM/CatBoost | 6+ months data available | MAE: 5-8% → 1-3% |
| **PV Expected Power** | PVWatts physics model | Hybrid (physics + ML) | Site-specific corrections needed | MAE: 8-12% → 4-6% |
| **PV Fault Detection** | Threshold rules (10+ types) | CatBoost classifier | Complex fault patterns | F1: 70% → 90%+ |
| **PV RUL Prediction** | Linear trend extrapolation | CatBoost regression | Non-linear degradation | Accuracy: 60% → 85% |
| **BESS Dispatch** | Linear Programming (LP) | Deep RL | Volatile intraday prices | Revenue: +10-20% |
| **BESS SoH** | Coulomb counting | LightGBM | Multi-factor degradation | MAPE: 3-5% → 0.1-0.9% |
| **BESS Thermal** | Threshold rules | Isolation Forest → LSTM | Early warning needed | Warning: minutes → hours |
| **BESS Warranty** | Empirical curves | None needed | - | Physics sufficient |
| **Wind Power Curve** | IEC 61400-12-1 bins | Isolation Forest | Anomaly detection | F1: 70% → 90%+ |
| **Wind Gearbox PdM** | Temperature thresholds | LightGBM NBM | Months-ahead prediction | Warning: days → months |
| **Wind Wake** | Jensen/Park analytical | Gaussian process | Farm optimization | AEP: ±10% → ±3% |

### Decision Rules

```
1. START with non-ML (physics/rules) for:
   - Interpretability requirements
   - Immediate deployment (no training data)
   - Simple threshold-based decisions
   - Regulatory/compliance use cases

2. ADD ML when:
   - 6+ months of quality data available
   - Non-ML accuracy is insufficient for business case
   - Site-specific adaptations are needed
   - Complex patterns exist (non-linear, multi-variate)

3. ALWAYS validate ML against physics baseline:
   - ML should IMPROVE on physics, not replace it
   - Physics provides bounds and sanity checks
   - Hybrid approach is most robust

4. AVOID pure ML when:
   - Extrapolation to new conditions required
   - Training data is sparse or biased
   - Decisions require regulatory justification
   - Simpler approach achieves business goals
```

---

## Public Datasets Reference

### Solar PV Datasets

| Dataset | Source | Size | Best For | Download |
|---------|--------|------|----------|----------|
| **NREL PVDAQ** | NREL | 70+ systems, 10+ years | Digital twin, fault detection | [pvdaq.nrel.gov](https://pvdaq.nrel.gov/) |
| **DKA Solar Centre** | DKA | 20+ systems, Australia | Desert environment validation | [dkasolarcentre.com.au](https://dkasolarcentre.com.au/) |
| **NIST Campus PV** | NIST | 1 system, high-res | Validation, research | [nist.gov](https://www.nist.gov/services-resources/software/nist-campus-photovoltaic-pv-arrays-dataset) |
| **PVGIS** | EU JRC | Global satellite | Irradiance reference | [pvgis.ec.europa.eu](https://re.jrc.ec.europa.eu/pvg_tools/en/) |

### BESS Datasets

| Dataset | Source | Size | Best For | Download |
|---------|--------|------|----------|----------|
| **NASA Li-ion Battery Aging** | NASA | 4 batteries, run-to-failure | SoH/RUL pretraining (gold standard) | [data.nasa.gov](https://data.nasa.gov/dataset/Li-ion-Battery-Aging-Datasets) |
| **NASA Randomized Battery** | NASA | 26 packs | Variable usage profiles | [data.nasa.gov](https://data.nasa.gov/dataset/Randomized-Battery-Usage-Data-Set) |
| **CALCE Battery Research** | UMD | Multiple chemistries | LFP, NMC, NCA validation | [calce.umd.edu](https://calce.umd.edu/battery-data) |
| **Multi-Stage Aging** | Nature 2024 | 279 cells, 71 conditions | State-of-art degradation | [nature.com](https://www.nature.com/articles/s41597-024-03394-5) |
| **Stanford Battery** | Stanford/MIT | 124 cells | Fast charging optimization | [data.matr.io](https://data.matr.io/1/) |

#### What BESS Operational Datasets Are Useful For

1. **NASA Li-ion Battery Aging Dataset**
   - **Use**: SoH model pretraining, RUL algorithm development
   - **Why**: Run-to-failure data with clear capacity fade curves
   - **Data**: Charge/discharge cycles, capacity, impedance, temperature
   - **Format**: CSV/MATLAB

2. **NASA Randomized Battery Dataset**
   - **Use**: Transfer learning, variable usage validation
   - **Why**: Realistic usage patterns (not constant cycling)
   - **Data**: 26 packs with varied charge/discharge profiles
   - **Format**: CSV

3. **CALCE Battery Research Data**
   - **Use**: Multi-chemistry model validation
   - **Why**: Includes LFP, NMC, NCA batteries
   - **Data**: Calendar aging, cyclic aging, EIS measurements
   - **Format**: CSV/Excel

4. **Stanford Battery Dataset**
   - **Use**: Dispatch validation, fast charging effects
   - **Why**: Contains varied charge protocols and degradation
   - **Data**: Full cycle data with capacity measurements
   - **Format**: HDF5/CSV

### Wind Datasets

| Dataset | Source | Size | Best For | Download |
|---------|--------|------|----------|----------|
| **NREL Wind Toolkit** | NREL | 126,000+ US sites, 7 years | Forecasting pretraining | [nrel.gov](https://www.nrel.gov/grid/wind-toolkit.html) |
| **OpenOA Power Curves** | NREL | OEM curves | Performance benchmarking | `pip install openoa` |
| **EDP Open Data** | EDP | Real SCADA, 10-min | Anomaly detection | [opendata.edp.com](https://opendata.edp.com/) |
| **NREL Gearbox Round Robin** | NREL | 25.6 kHz vibration | Premium gearbox PdM | [openei.org](https://openei.org/datasets/) |
| **Horns Rev / Lillgrund** | Academic | Wake measurements | Wake model validation | Academic request |

---

## Achievable Metrics on Public Data

### Solar PV

| Problem | Dataset | Model | Metric | Value | Notes |
|---------|---------|-------|--------|-------|-------|
| Soiling estimation | DustIQ validation | CatBoost | MAE | 1-3% | With 6+ months training |
| Soiling estimation | Transfer learning | CatBoost | MAE | 3-5% | No site-specific data |
| Expected power | PVDAQ | PVWatts + LightGBM | MAE | 4-6% | Hybrid approach |
| Fault classification | PVDAQ + synthetic | CatBoost | F1 | 85-92% | 22 fault classes |
| Inverter thermal RUL | PVDAQ | CatBoost | Accuracy | 70-85% | 10-day horizon |

### BESS

| Problem | Dataset | Model | Metric | Value | Source |
|---------|---------|-------|--------|-------|--------|
| SoH estimation | NASA Li-ion | LightGBM | MAPE | 0.1-0.9% | [MDPI 2023](https://www.mdpi.com/2076-3417/13/11/6540) |
| SoH estimation | NASA Li-ion | LightGBM | Accuracy | 90.69% | [SpringerLink 2024](https://link.springer.com/chapter/10.1007/978-981-97-8160-7_6) |
| RUL prediction | NASA Li-ion | LSTM | RMSE | 50-100 cycles | Literature |
| Dispatch optimization | Price data | LP/MILP | Cost savings | 33-95% | [Scientific Reports 2025](https://www.nature.com/articles/s41598-025-02690-9) |

### Wind

| Problem | Dataset | Model | Metric | Value | Notes |
|---------|---------|-------|--------|-------|-------|
| Power curve efficiency | EDP/OpenOA | IEC bins | MAE | ±3% | Standard method |
| Power curve anomaly | EDP | Isolation Forest | Precision | 85-95% | Unsupervised |
| Gearbox failure | SCADA | LightGBM NBM | Detection | 67% | [IET 2017](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248) |
| Gearbox RUL | Vibration | CNN | Accuracy | 90%+ | Premium tier |
| Wake loss | Horns Rev | Jensen | Error | ±10% | Simple model |

---

## Implementation Examples

### Quick Start: PV Soiling Analysis

```python
from nuravolt.soiling import (
    SoilingIntelligencePipeline,
    SoilingConfig,
    CleaningScheduleOptimizer,
)

# Initialize pipeline
config = SoilingConfig(
    plant_id='my_plant',
    latitude=25.0,
    longitude=55.0,
    capacity_kwp=10000,
    climate_zone='arid',
)
pipeline = SoilingIntelligencePipeline(config)

# Run analysis
results = pipeline.run(
    scada_data=scada_df,
    weather_data=weather_df,
    aod_data=aod_df,
)

print(f"Current SR: {results.current_sr:.2%}")
print(f"30-day forecast: {results.forecast_30d}")
print(f"Recommended cleaning: {results.next_cleaning_date}")

# Optimize cleaning schedule
optimizer = CleaningScheduleOptimizer(
    plant_capacity_kwp=10000,
    cleaning_cost=500,
    electricity_price=0.08,
)

schedule = optimizer.optimize(
    soiling_forecast=results.sr_forecast,
    insolation_forecast=insolation_df,
    max_cleanings=24,
)

print(f"Annual energy recovery: {schedule.energy_recovered_mwh:.0f} MWh")
print(f"ROI: {schedule.roi:.0%}")
```

### Quick Start: BESS Optimization

```python
from nuravolt.bess import (
    BESSDispatchOptimizer,
    SoHEstimator,
    ThermalRuleBasedMonitor,
    WarrantyTracker,
    WarrantyTerms,
)
import numpy as np

# 1. Dispatch Optimization
optimizer = BESSDispatchOptimizer(
    capacity_kwh=1000,
    max_power_kw=250,
    efficiency=0.90,
)

prices = np.array([0.05, 0.04, 0.03, 0.03, 0.04, 0.06,  # Night
                   0.10, 0.15, 0.12, 0.11, 0.10, 0.11,  # Morning
                   0.12, 0.14, 0.16, 0.18, 0.20, 0.25,  # Afternoon peak
                   0.22, 0.18, 0.14, 0.10, 0.07, 0.05]) # Evening

result = optimizer.optimize_day_ahead(prices)
print(f"Daily revenue: ${result.revenue:.2f}")

# 2. SoH Monitoring
# SoHEstimator.predict raises until a trained artifact exists, and none does
# today: production SoH comes from the chemistry EmpiricalDegradationModel.
# Only train() on real measured capacity tests unlocks predict().
soh_estimator = SoHEstimator()
soh_estimator.train(training_features, soh_labels)  # real capacity tests only
current_soh = soh_estimator.predict(current_features)[0]
print(f"Current SoH: {current_soh:.1%}")

# RUL projection works without the booster, and reports its own interval.
rul = soh_estimator.predict_rul(
    current_soh=0.92,
    usage_profile={'cycles_per_day': 1.2},
    soh_history=[(0, 1.00), (400, 0.965), (820, 0.933)],  # real capacity tests
)
print(rul['rul_days'], rul['rul_days_low'], rul['rul_days_high'])
print(rul['confidence_basis'])

# 3. Thermal Protection
monitor = ThermalRuleBasedMonitor()
for cell in cells:
    alert = monitor.check_cell(cell)
    if alert.level != 'normal':
        print(f"ALERT: {alert.level} - {alert.reasons}")

# 4. Warranty Tracking
tracker = WarrantyTracker(
    WarrantyTerms(capacity_guarantee_pct=0.70, warranty_years=10),
    nominal_capacity_kwh=1000,
)
status = tracker.get_warranty_status()
print(f"Warranty status: {status['recommendation']}")
```

### Quick Start: Wind Monitoring

```python
from nuravolt.wind import (
    PowerCurveAnalyzer,
    GearboxNBMModel,
    WakeFarmModel,
    TurbinePosition,
)

# 1. Power Curve Analysis
oem_curve = load_oem_power_curve('vestas_v126')
analyzer = PowerCurveAnalyzer(oem_curve, rated_power_kw=3000)

df_analyzed = analyzer.analyze_dataframe(scada_df)
underperformance = df_analyzed.filter(pl.col('efficiency') < 0.90)
print(f"Underperforming hours: {len(underperformance)}")

# 2. Gearbox Monitoring
nbm = GearboxNBMModel()
nbm.train(healthy_data, target='gearbox_bearing_temp')

df_monitored = nbm.predict_and_detect(current_data)
anomalies = df_monitored.filter(pl.col('gearbox_bearing_temp_anomaly'))
if len(anomalies) > 0:
    print(f"Gearbox anomaly detected! Z-score: {anomalies[0]['zscore']}")

# 3. Wake Analysis
positions = [TurbinePosition(x=i*500, y=j*500)
             for i in range(3) for j in range(3)]
farm = WakeFarmModel(positions)

result = farm.calculate_farm_power(wind_speed=10.0, wind_direction=270)
print(f"Total power: {result['total_power']:.0f} kW")
print(f"Wake losses: {result['wake_losses_pct']:.1f}%")
```

---

## Integration Patterns

### API Integration

```python
# Example: Next.js API route
# /api/soiling/plants/[plantId]/forecast

from nuravolt.soiling import PhysicsMLHybridForecaster

def get_soiling_forecast(plant_id: str, horizon_days: int = 365):
    # Load plant config
    config = load_plant_config(plant_id)

    # Initialize forecaster
    forecaster = PhysicsMLHybridForecaster(config)

    # Get current data
    current_sr = get_current_sr(plant_id)
    weather_forecast = fetch_weather_forecast(config.location)

    # Generate forecast
    forecast = forecaster.forecast(
        current_sr=current_sr,
        weather_forecast=weather_forecast,
        horizon_days=horizon_days,
    )

    return {
        'plant_id': plant_id,
        'current_sr': current_sr,
        'forecast': forecast.to_dict(),
        'generated_at': datetime.utcnow().isoformat(),
    }
```

### Streaming/Real-time

```python
# Example: Real-time anomaly detection

from nuravolt.digitaltwin import SmoothedAnomalyDetector

class RealtimeMonitor:
    def __init__(self, plant_config):
        self.detector = SmoothedAnomalyDetector(
            smoothing_window=24,  # 24-hour smoothing
            threshold_sigma=3.0,
        )

    async def process_reading(self, reading: dict):
        # Calculate expected power
        expected = self.physics_model.predict(reading)

        # Check for anomaly
        result = self.detector.check(
            actual=reading['power'],
            expected=expected,
            timestamp=reading['timestamp'],
        )

        if result.is_anomaly:
            await self.send_alert(result)
```

### Batch Processing

```python
# Example: Daily batch analysis

from nuravolt.soiling import PerInverterSoilingAnalyzer
from nuravolt.fault import PredictiveMaintenancePipeline

def daily_analysis(plant_id: str):
    # Load yesterday's data
    data = load_daily_data(plant_id)

    # Per-inverter soiling
    sr_analyzer = PerInverterSoilingAnalyzer()
    sr_results = sr_analyzer.analyze(data)

    # Fault detection + RUL
    pipeline = PredictiveMaintenancePipeline(config)
    maintenance = pipeline.analyze(data)

    # Store results
    store_results(plant_id, {
        'soiling': sr_results.to_dict(),
        'maintenance': maintenance.to_dict(),
        'analyzed_at': datetime.utcnow(),
    })

    # Generate tickets if needed
    for action in maintenance.urgent_actions:
        create_ticket(plant_id, action)
```

---

## Business Value Sources

All business value claims are sourced from peer-reviewed literature or industry reports:

| Claim | Value | Source | Year |
|-------|-------|--------|------|
| BESS dispatch optimization savings | 33-95% cost reduction | [Scientific Reports](https://www.nature.com/articles/s41598-025-02690-9) | 2025 |
| Wind gearbox failure cost | $200K-500K per failure | [IET Research](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248), GCube Insurance | 2017 |
| Wind gearbox SCADA detection rate | 67% | [IET Research](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248) | 2017 |
| Wind gearbox advance warning | 1 month to 2 years | [IET Research](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/iet-rpg.2016.0248) | 2017 |
| BESS SoH accuracy (LightGBM) | 0.1-0.9% MAPE | [MDPI Applied Sciences](https://www.mdpi.com/2076-3417/13/11/6540) | 2023 |
| BESS SoH accuracy (LightGBM) | 90.69% | [SpringerLink](https://link.springer.com/chapter/10.1007/978-981-97-8160-7_6) | 2024 |
| BESS thermal runaway market | $25B | McKinsey Energy Storage Report | 2024 |
| BESS revenue arbitrage gain | Up to 60% | NREL Grid Integration Studies | 2023 |
| PV soiling losses | 2-7% annual yield loss | [IEA PVPS Task 13](https://iea-pvps.org/key-topics/soiling-losses-impact-on-performance-of-photovoltaic-power-plants/) | 2022 |
| PV soiling (desert) | Up to 25% loss | [Nature Energy](https://www.nature.com/articles/s41560-020-0632-9) | 2020 |

---

## Troubleshooting Guide

### Common Issues

#### PV Soiling Model

| Issue | Cause | Solution |
|-------|-------|----------|
| High MAE (>5%) | Insufficient training data | Need 6+ months; use transfer learning |
| SR always ~0.95 | Model predicting mean | Check loss function (use quantile); verify labels |
| SR doesn't reset after rain | Rain threshold too high | Lower rain_cleaning_threshold to 3mm |
| Negative trend on clean days | AOD data quality | Verify CAMS AOD data; use backup source |

#### BESS Dispatch

| Issue | Cause | Solution |
|-------|-------|----------|
| "Infeasible" status | Constraints too tight | Relax SoC bounds; check initial_soc |
| Zero discharge | Prices too flat | Need price spread for arbitrage |
| High degradation cost | k_deg too high | Calibrate to actual battery chemistry |
| SoC hitting limits | Bounds too tight | Adjust soc_min/soc_max |

#### Wind Power Curve

| Issue | Cause | Solution |
|-------|-------|----------|
| Efficiency > 100% | OEM curve calibration | Adjust for site air density |
| Many curtailment flags | Threshold too sensitive | Increase curtailment detection threshold |
| Missing high wind data | Filtering too aggressive | Relax data quality filters |

#### Wind Gearbox NBM

| Issue | Cause | Solution |
|-------|-------|----------|
| High validation MAE (>5°C) | Training on mixed data | Filter to healthy operation only |
| Too many false positives | Threshold too tight | Increase zscore_warning to 4.0 |
| Missed failures | Model underfitting | Add more features; increase n_estimators |

### Performance Optimization

1. **Use Polars instead of Pandas** - 5-10x faster for large datasets
2. **Enable model caching** - Avoid retraining on each API call
3. **Batch predictions** - Process multiple timestamps together
4. **Use appropriate precision** - float32 sufficient for most features

---

## Appendix: Code Directory Reference

```
nuravolt/
├── __init__.py
├── soiling/                           # PV Soiling Intelligence
│   ├── __init__.py                    # Public API exports
│   ├── config.py                      # SoilingConfig, SITE_CONFIG
│   ├── sr_ml_model.py                 # SoilingRatioModel (CatBoost)
│   ├── sr_ml_features.py              # SoilingRatioFeatureEngineer (34 features)
│   ├── sr_transfer_learning.py        # PseudoLabelGenerator, transfer_model_to_plant
│   ├── schedule_optimizer.py          # CleaningScheduleOptimizer (LP)
│   ├── forecasting_longterm.py        # PhysicsMLHybridForecaster (365-day)
│   ├── loss_disaggregation.py         # IEALossDisaggregator
│   ├── event_detection.py             # detect_cleaning_events
│   ├── per_inverter_analysis.py       # PerInverterSoilingAnalyzer
│   ├── economics.py                   # ROI calculations
│   └── visualization.py               # Plotting utilities
│
├── digitaltwin/                       # PV Digital Twins
│   ├── __init__.py                    # Lazy-loaded exports
│   ├── hybrid_model.py                # HybridPhysicsMLModel
│   ├── physics_model.py               # PVWattsPhysicsModel
│   ├── feature_engineering.py         # PhysicsFeatureEngineer (NO power lags)
│   ├── anomaly_detector.py            # SmoothedAnomalyDetector
│   ├── plant_factory.py               # PlantLevelFactory
│   ├── string_twin.py                 # StringPerformanceTwin
│   ├── data_transformer.py            # WideToLongTransformer
│   └── validation.py                  # Model validation utilities
│
├── fault/                             # PV Fault Detection & RUL
│   ├── __init__.py                    # Public API exports
│   ├── config.py                      # FaultDetectionConfig, thresholds
│   ├── rule_based.py                  # RuleBasedFaultDetector (10+ types)
│   ├── rul_models.py                  # RUL*Model classes (7 models)
│   ├── rul_predictor.py               # RULPredictor, MaintenanceSchedule
│   ├── pretraining.py                 # FaultClassifier foundation model
│   ├── digital_twins.py               # InverterThermalTwin
│   ├── maintenance_scheduler.py       # MaintenanceScheduleOptimizer
│   └── features.py                    # PlantAgnosticFeatureEngine
│
├── bess/                              # Battery Energy Storage
│   ├── __init__.py                    # Public API exports
│   ├── dispatch_optimizer.py          # BESSDispatchOptimizer (LP/MPC)
│   ├── soh_estimator.py               # SoHEstimator (LightGBM)
│   ├── thermal_monitor.py             # 3-tier thermal protection
│   └── warranty_tracker.py            # WarrantyTracker, EmpiricalDegradationModel
│
├── wind/                              # Wind Analytics
│   ├── __init__.py                    # Public API exports
│   ├── power_curve.py                 # PowerCurveAnalyzer (IEC 61400-12-1)
│   ├── gearbox_monitor.py             # GearboxNBMModel (LightGBM)
│   └── wake_model.py                  # WakeFarmModel (Jensen)
│
└── utils/                             # Shared Utilities
    ├── __init__.py
    ├── onboarding.py                  # Plant onboarding utilities
    └── data_inspector.py              # Data quality inspection
```

---

*Document Version: 2.0*
*Generated: January 2025*
*NuraVolt Energy Intelligence Platform v1.6*
