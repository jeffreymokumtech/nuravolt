# NuraVolt Fault Detection Catalog

Comprehensive reference for all fault types, detection methods, features, and prediction capabilities.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Rule-Based (Reactive) Faults](#rule-based-reactive-faults)
3. [Digital Twins](#digital-twins)
4. [ML Classification Faults](#ml-classification-faults)
5. [Predictive RUL Models](#predictive-rul-models)
6. [Feature Engineering](#feature-engineering)
7. [Evaluation Metrics](#evaluation-metrics)
8. [Real Detection Examples](#real-detection-examples)

---

## System Overview

NuraVolt's fault detection system uses a four-tier approach:

| Tier | Method | Latency | Use Case |
|------|--------|---------|----------|
| **Tier 1** | Rule-Based Thresholds | Real-time (<100ms) | Immediate reactive faults (32 types) |
| **Tier 2** | Digital Twins | Sub-second | Physics-ML anomaly detection |
| **Tier 3** | ML Classification | Sub-second | Complex fault patterns |
| **Tier 4** | RUL Prediction | Minutes | Predictive maintenance (7 models) |

### Plant-Agnostic Design

All features are normalized to work across:
- Any capacity (1 kW to 500+ MW)
- Any number of strings (2 to 1000+)
- Any inverter manufacturer
- Any geographic location
- **No retraining required for new plants**

---

## Rule-Based (Reactive) Faults

These faults are detected immediately using threshold-based rules. Designed for hourly batch processing with 5-minute resolution data. **v1.4 expanded from 13 to 32 fault types.**

### Inverter Faults

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `INVERTER_OFFLINE` | CRITICAL | AC power = 0 during daylight (POA > 100 W/m²) | `ac_power`, `poa_irradiance` |
| `INVERTER_CLIPPING` | INFO | AC power at rated capacity while DC > AC × 1.05 | `ac_power`, `dc_power`, `rated_capacity` |
| `INVERTER_OVERTEMPERATURE` | WARNING | Cabinet temperature > 65°C | `inverter_temperature` |
| `INVERTER_EFFICIENCY_DEGRADATION` | WARNING→CRITICAL | η < 92% (warning) or η < 88% (critical) at P > 20% | `ac_power`, `dc_power` |
| `INVERTER_COOLING_DEGRADATION` | WARNING | Thermal twin residual > 5°C for 3+ consecutive periods | `inverter_temp`, `ambient_temp`, `ac_power` |
| `DC_LINK_CAPACITOR_AGING` | WARNING | DC voltage std > 15V with frequent derating | `dc_voltage`, `ac_power` |

**Power Loss Factors:**
- Inverter Offline: 100% of inverter capacity
- Inverter Clipping: 0% (expected behavior)
- Overtemperature: 5-20% derating
- Efficiency Degradation: `rated_kw × (η_expected - η_actual)`

### String Faults

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `STRING_OPEN_CIRCUIT` | CRITICAL | One string current ≈ 0 while others > 0.5A | `string_currents[]` |
| `STRING_SHORT_CIRCUIT` | CRITICAL | String voltage < 70% of rolling median baseline | `string_voltage`, `baseline_voltage` |
| `STRING_MISMATCH_COARSE` | WARNING | Single MPPT < 85% of plant average | `mppt_power[]`, `poa_irradiance` |

**Power Loss Factors:**
- String Open: 1/n_strings of inverter capacity (e.g., 8.3% for 12 strings)
- String Short: Same as open circuit + potential safety hazard
- String Mismatch: `rated_kw × (1 - worst_ratio) / n_mppts`

### MPPT Faults (v1.4)

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `MPPT_IMBALANCE` | WARNING | MPPT power CV > 15% (warning) or > 25% (critical) | `mppt_power[]` |
| `MPPT_HUNTING` | WARNING | Voltage oscillations > ±5V more than 10× per hour | `dc_voltage`, `timestamp` |

**Power Loss Factors:**
- MPPT Imbalance: `rated_kw × (1 - worst_ratio) / n_mppts`
- MPPT Hunting: 1-3% efficiency loss during hunting

### DC Voltage Faults (v1.4)

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `DC_OVERVOLTAGE` | WARNING→CRITICAL | DC voltage > 95% of MPPT upper limit | `dc_voltage`, `mppt_voltage_max` |
| `DC_UNDERVOLTAGE` | WARNING→CRITICAL | DC voltage < 105% of MPPT lower limit | `dc_voltage`, `mppt_voltage_min` |

**Power Loss Factors:**
- DC Over/Undervoltage: Potential inverter trip (100% loss)

### Tracker Faults

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `TRACKER_STUCK` | WARNING | Angle std dev < 0.1° for 30+ minutes during daylight | `tracker_angle`, `poa_irradiance` |
| `TRACKER_MISALIGNED` | WARNING | Actual angle deviates > 10° from calculated optimal | `tracker_angle`, `solar_position` |

**Power Loss Factors:**
- Tracker Stuck: 2-15% depending on time of day
- Misaligned: 1-10% cosine loss

### Grid Faults

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `GRID_FREQUENCY_LOW` | CRITICAL | Frequency < 49.5 Hz (nominal 50 Hz) | `grid_frequency` |
| `GRID_FREQUENCY_HIGH` | CRITICAL | Frequency > 50.5 Hz | `grid_frequency` |
| `GRID_VOLTAGE_SAG` | WARNING | Voltage < 360V (90% of 400V nominal) | `grid_voltage` |
| `GRID_VOLTAGE_SWELL` | WARNING | Voltage > 440V (110% of nominal) | `grid_voltage` |
| `GRID_CURTAILMENT` | INFO | Frequency > 50.3 Hz triggering P-f response | `grid_frequency`, `ac_power` |
| `EXPORT_CAP_ACTIVE` | INFO | AC power at export limit < rated capacity | `ac_power`, `export_limit` |

**Power Loss Factors:**
- Frequency faults: Potential inverter trip (100% loss)
- Voltage faults: 0-100% depending on inverter response
- Curtailment: `rated_kw × curtailment_fraction`

### Module Health Faults (v1.4)

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `MODULE_OVERTEMPERATURE` | WARNING | Module temperature > 85°C | `module_temperature` |
| `MODULE_CURRENT_DEGRADATION` | WARNING | Module current trending downward | `module_current`, trend analysis |
| `MODULE_VOLTAGE_DROP` | WARNING | Module voltage below expected | `module_voltage` |
| `BYPASS_DIODE_ACTIVE` | WARNING | Voltage step 10-30V with power drop | `string_voltage`, `dc_power` |
| `INSULATION_RESISTANCE_LOW` | WARNING→CRITICAL | Riso < 1.0 MΩ (warning) or < 0.5 MΩ (critical) per IEC 62446 | `insulation_resistance` |

**Power Loss Factors:**
- Bypass Diode: `modules_bypassed × module_kw / 3`
- Insulation Low: Safety hazard, requires immediate attention

### Sensor & Communication Faults (v1.4)

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `COMMUNICATION_LOSS` | WARNING | Data gap > 15 minutes (complete loss) | `timestamp` |
| `COMMUNICATION_PARTIAL` | WARNING | > 20% null values in critical columns | Column null analysis |
| `SENSOR_FROZEN` | WARNING | Sensor std dev < 0.01 for 30+ minutes | Any sensor, `timestamp` |
| `IRRADIANCE_SENSOR_DRIFT` | WARNING | Clearsky ratio deviation > ±5% consistently | `poa_irradiance`, `clearsky_ghi` |

**Power Loss Factors:**
- Communication: 0% direct loss, but impacts monitoring and detection
- Sensor Frozen: Operational risk, may mask real issues

### Environmental Faults (v1.4)

| Fault Type | Severity | Detection Rule | Features Used |
|------------|----------|----------------|---------------|
| `SOILING_DETECTED` | INFO | PR < 95% AND clearsky_ratio ≈ 1.0 | `ac_power`, `poa_irradiance`, `clearsky_ghi` |
| `VEGETATION_SHADING` | WARNING | AM/PM asymmetry > 10% trending over 7 days | `ac_power`, `hour`, `solar_azimuth` |

**Power Loss Factors:**
- Soiling: `rated_kw × (1 - PR)` (typically 2-10%)
- Vegetation Shading: 5-15% during affected periods

---

## Digital Twins

Physics-ML hybrid models for anomaly detection through real-time expected vs. actual comparisons. **v1.4 introduces the Thermal Digital Twin.**

### Inverter Thermal Twin

Predicts expected inverter temperature based on operating conditions. Anomalies detected through residual analysis (actual - expected).

**Architecture:**
```
Inputs                    Model                    Outputs
───────────────────────────────────────────────────────────
ambient_temp      ─┐
ac_power_pu       ─┼─→ CatBoost Regressor ─→ T_inv_expected
poa_irradiance    ─┤                       ─→ temp_residual
hour_of_day       ─┘
```

**Anomaly Thresholds:**

| Status | Residual Range | Interpretation |
|--------|----------------|----------------|
| NORMAL | |residual| < 5°C | Cooling system operating normally |
| WARNING | 5°C ≤ |residual| < 10°C | Potential cooling degradation |
| CRITICAL | |residual| ≥ 10°C | Fan failure or blocked vents likely |

**Training Requirements:**
- Minimum 100 valid samples
- Features: `ambient_temp`, `ac_power_pu`, `poa_irradiance`, `hour_of_day`
- Target: `inverter_temperature`

**Model Fallbacks:**
1. CatBoost (primary) → 2. LightGBM (fallback) → 3. sklearn GradientBoosting (final)

**Usage Example:**
```python
from nuravolt.fault import InverterThermalTwin

# Train
twin = InverterThermalTwin(inverter_id="INV-01", rated_ac_power_kw=500)
metrics = twin.train(df_training)
print(f"Training MAE: {metrics.mae:.2f}°C")

# Detect anomalies
df_result = twin.predict(df_new)
anomalies = twin.detect_anomalies(df_result)

# Save/load
twin.save("thermal_twin_inv01.pkl")
loaded_twin = InverterThermalTwin.load("thermal_twin_inv01.pkl")
```

---

## ML Classification Faults

Two pretrained CatBoost classifiers trained on the Lazzaretti dataset (1.37M samples).

### System-Level Classifier

**Accuracy: 96.03% | F1 Macro: 92.47%**

Requires only system-level data (no string measurements needed).

| Class | Fault Type | Category | Description |
|-------|------------|----------|-------------|
| 0 | Normal | - | No fault detected |
| 4 | Partial Shading/Soiling | Predictive | Gradual performance degradation |
| 5 | Inverter Fault | Reactive | Inverter malfunction detected |
| 6 | Grid Fault | Reactive | Grid disturbance affecting output |
| 7 | Sensor/Controller Fault | Reactive | Measurement or control issue |

### String-Level Classifier

**Accuracy: 97.32% | F1 Macro: 91.46%**

Requires string-level current/voltage data for enhanced detection.

| Class | Fault Type | Category | Description |
|-------|------------|----------|-------------|
| 0 | Normal | - | No fault detected |
| 1 | String Open Circuit | Reactive | String disconnected or broken |
| 2 | String Short Circuit | Reactive | Bypass diode or wiring short |
| 3 | String Degradation | Predictive | Gradual string performance loss |
| 4 | Partial Shading/Soiling | Predictive | Localized shading or soiling |
| 5 | Inverter Fault | Reactive | Inverter malfunction |
| 6 | Grid Fault | Reactive | Grid disturbance |
| 7 | Sensor/Controller Fault | Reactive | Measurement issue |
| 8 | Array Fault | Reactive | DC array problem |

### Features Used for ML Classification

**Core System Features (11):**
```
dc_power_pu           - DC power normalized to rated capacity
ac_power_pu           - AC power normalized to rated capacity
power_ratio           - AC/DC power efficiency
inverter_efficiency   - Instantaneous inverter efficiency
performance_ratio     - PR normalized to clear-sky
clearsky_ratio        - Actual vs clear-sky irradiance
voltage_ratio         - Actual / expected voltage
current_ratio         - Actual / expected current
temp_rise             - Module temp - ambient temp
temp_coefficient      - Temperature derating factor
irradiance_normalized - POA irradiance normalized
```

**String Features (9):**
```
string_current_mean_pu    - Mean string current per-unit
string_current_cv         - Coefficient of variation (mismatch)
string_current_min_ratio  - Worst string / mean
string_current_max_ratio  - Best string / mean
string_current_skew       - Distribution asymmetry
strings_underperforming   - % strings below threshold
worst_string_zscore       - Z-score of worst performer
string_voltage_cv         - Voltage variation
string_voltage_min_ratio  - Voltage mismatch indicator
```

---

## Predictive RUL Models

Remaining Useful Life (RUL) models predict days until a fault condition is reached.

### Model Overview

| Model | Threshold Condition | Max Horizon | Target MAE | Within 3 Days |
|-------|---------------------|-------------|------------|---------------|
| **String Degradation** | String CV > 25% | 14 days | 2.0 days | 80% |
| **Inverter Thermal** | Inverter temp > 65°C | 10 days | 2.0 days | 80% |
| **Module Degradation** | PR < 75% | 90 days | 7.0 days | 50% |
| **Thermal Hotspot** | Temp delta > 25°C | 10 days | 1.0 days | 90% |
| **String Mismatch** | Worst string ratio < 85% | 14 days | 3.0 days | 70% |
| **Bypass Diode Stress** | Hotspot count > 3 | 7 days | 2.0 days | 80% |
| **Insulation Degradation** | Riso < 40 MΩ/kWp | 90 days | 7.0 days | 50% |

### Detailed Model Specifications

#### String Degradation RUL

**Threshold:** String coefficient of variation > 25%

**Features:**
- `string_current_cv` - Current mismatch level
- `string_current_min_ratio` - Worst string performance
- `string_current_max_ratio` - Best string performance
- `string_current_skew` - Distribution shape
- `poa_irradiance` - Operating condition
- `string_cv_trend_7d` - 7-day trend

**Urgency Mapping:**
| Days to Fault | Urgency Level |
|---------------|---------------|
| ≤ 3 days | URGENT |
| 4-7 days | SOON |
| 8-14 days | PLANNED |
| > 14 days | MONITORING |

#### Inverter Thermal RUL

**Threshold:** Inverter cabinet temperature > 65°C

**Features:**
- `inverter_temperature` - Current temperature
- `temp_rise` - Temperature above ambient
- `ambient_temperature` - Environmental baseline
- `ac_power_pu` - Load level
- `poa_irradiance` - Insolation
- `temp_rise_trend_7d` - Thermal trend

**Recommended Action:** Schedule fan inspection and air filter cleaning.

#### Module Degradation RUL

**Threshold:** Performance Ratio < 75%

**Features:**
- `performance_ratio` - Current PR
- `pr_trend_30d` - 30-day degradation rate
- `pr_acceleration_7d` - Is degradation speeding up?
- `efficiency_trend_7d` - Weekly efficiency trend
- `clearsky_ratio` - Environmental baseline

**Note:** Long-horizon prediction (up to 90 days) for maintenance planning.

#### Thermal Hotspot RUL

**Threshold:** Module-ambient temperature delta > 25°C

**Features:**
- `module_temperature` - Current module temp
- `ambient_temperature` - Ambient baseline
- `temp_delta` - Current delta
- `temp_delta_p95` - 95th percentile delta
- `ac_power_pu` - Load correlation
- `temp_delta_trend_7d` - Hotspot evolution

**Urgency:** Highest accuracy model (90% within 3 days target).

#### String Mismatch RUL

**Threshold:** Worst string power ratio < 85% of mean

**Features:**
- `string_power_cv` - Power variation
- `string_power_range` - Max-min spread
- `worst_string_ratio` - Weakest string
- `string_ratio_trend_7d` - Mismatch evolution

#### Bypass Diode Stress RUL

**Threshold:** > 3 thermal hotspots detected

**Features:**
- `hotspot_count` - Number of hotspots
- `cell_temp_variance` - Cell-level variation
- `max_cell_delta` - Maximum temperature gradient
- `hotspot_trend_7d` - Hotspot progression

#### Insulation Degradation RUL

**Threshold:** Insulation resistance < 40 MΩ/kWp

**Features:**
- `insulation_resistance` - Current Riso
- `humidity` - Moisture exposure
- `temp_cycles_30d` - Thermal stress count
- `plant_age_days` - System age
- `riso_trend_30d` - Degradation rate

---

## Feature Engineering

### Plant-Agnostic Normalization

All features are normalized to enable transfer learning across plants:

```python
# Power normalization
dc_power_pu = dc_power / rated_dc_power  # 0-1+ range
ac_power_pu = ac_power / rated_ac_power  # 0-1+ range

# String normalization
string_current_pu = string_current / (rated_dc_power / (n_strings * vmp))

# Temperature normalization
temp_rise = module_temp - ambient_temp  # Delta, not absolute
```

### Temporal Features

| Feature | Window | Purpose |
|---------|--------|---------|
| `power_roc_1h` | 1 hour | Short-term rate of change |
| `efficiency_trend_24h` | 24 hours | Daily efficiency pattern |
| `pr_rolling_mean_24h` | 24 hours | Smoothed performance |
| `pr_rolling_std_24h` | 24 hours | Performance volatility |
| `pr_trend_7d` | 7 days | Weekly degradation |
| `pr_trend_30d` | 30 days | Monthly degradation |
| `pr_acceleration_7d` | 7 days | 2nd derivative (acceleration) |

### Data Requirements

| Detection Type | Minimum Resolution | Historical Data Needed |
|----------------|-------------------|------------------------|
| Rule-based | 5 minutes | None (real-time) |
| ML Classification | 15 minutes | None (pretrained) |
| RUL Prediction | 15 minutes | 30+ days for trends |

---

## Evaluation Metrics

### Classification Metrics

| Metric | System-Level | String-Level |
|--------|--------------|--------------|
| Accuracy | 96.03% | 97.32% |
| F1 Macro | 92.47% | 91.46% |
| Training Samples | 1,373,798 | 1,373,798 |

### RUL Prediction Metrics

**Primary Metrics:**
- **MAE (Mean Absolute Error):** Average prediction error in days
- **RMSE:** Penalizes larger errors more heavily
- **Median AE:** Robust to outliers
- **Within_Xd:** Percentage of predictions within X days of actual

**Operational Metrics:**
- **Overestimate Rate:** Predictions > actual (dangerous - false safety)
- **Underestimate Rate:** Predictions < actual (conservative - early warnings)

### Multi-Horizon Evaluation

All RUL models are evaluated at multiple horizons:

| Horizon | Use Case | Target Accuracy |
|---------|----------|-----------------|
| 1 day | Urgent intervention | 50-70% |
| 3 days | Short-term planning | 70-90% |
| 7 days | Weekly maintenance | 80-95% |
| 14 days | Bi-weekly scheduling | 85-95% |
| 30 days | Monthly planning | 90-98% |

---

## Real Detection Examples

### Alpha Dataset Results

Detection run on Alpha solar plant data:

| Fault Type | Detections | Severity |
|------------|------------|----------|
| Communication Loss | 99,990 | WARNING |
| String Open Circuit | 82 | CRITICAL |
| Inverter Offline | 10 | CRITICAL |
| Inverter Overtemperature | 10 | WARNING |
| String Short Circuit | 10 | CRITICAL |

### Example Detection Event

```json
{
  "fault_type": "string_open_circuit",
  "severity": "critical",
  "equipment_id": "INV-03-S7",
  "equipment_name": "Inverter 03, String 7",
  "timestamp_start": "2024-09-21T10:30:00Z",
  "timestamp_end": null,
  "value": 0.0,
  "threshold": 0.5,
  "duration_minutes": 240,
  "power_loss_kw": 4.2,
  "energy_loss_kwh": 16.8,
  "message": "String current = 0A while peer strings producing 8.2A average"
}
```

### Example Predictive Fault

```json
{
  "fault_type": "inverter_thermal_degradation",
  "display_name": "Inverter Thermal Risk",
  "urgency": "urgent",
  "equipment_id": "INV-05",
  "equipment_name": "Inverter 05 (Block A)",
  "days_to_fault": 7,
  "confidence": 0.89,
  "current_value": 58,
  "threshold": 65,
  "unit": "°C",
  "recommended_action": "Schedule fan inspection and air filter cleaning within 7 days",
  "estimated_date": "2024-12-22",
  "projected_power_loss_kw": 450,
  "projected_energy_loss_kwh": 15750
}
```

---

## Power Loss Calculation

### Reactive Faults

| Fault Type | Power Loss Formula |
|------------|-------------------|
| Inverter Offline | `inverter_rated_kw × duration_hours` |
| String Open/Short | `(inverter_rated_kw / n_strings) × duration_hours` |
| Temperature Derating | `inverter_rated_kw × derating_factor × duration_hours` |
| Tracker Stuck | `cosine_loss × inverter_rated_kw × duration_hours` |

### Predictive Faults

| Fault Type | Projected Loss Formula |
|------------|------------------------|
| Inverter Thermal | `inverter_rated_kw × 5h/day × days_to_fault` |
| String Degradation | `string_rated_kw × 0.15 × 5h/day × days_to_fault` |
| Module Degradation | `plant_rated_kw × 0.25 × 5h/day × days_to_fault` |
| Thermal Hotspot | `module_rated_kw × n_affected × 5h/day × days_to_fault` |

---

## File Structure

```
nuravolt/fault/
├── __init__.py          # Public API exports (v1.4.0)
├── config.py            # Thresholds and configurations (9 dataclasses)
├── rule_based.py        # 32 rule-based fault types, 23 detectors
├── digital_twins.py     # Thermal digital twin (v1.4)
├── features.py          # Plant-agnostic feature engine
├── pretraining.py       # ML classifier training
├── rul_models.py        # 7 RUL model definitions
├── rul_training.py      # RUL training pipeline
├── rul_evaluation.py    # Multi-horizon evaluation
├── rul_labels.py        # RUL label generation
├── rul_predictor.py     # Production RUL inference
└── data_pvdaq.py        # PVDAQ data loader for thermal models

models/fault_detection/
├── system_classifier.pkl    # System-level (96% accuracy)
├── string_classifier.pkl    # String-level (97% accuracy)
└── thermal_twin_*.pkl       # Per-inverter thermal twins
```

---

## Configuration Reference (v1.4)

### Threshold Dataclasses

| Dataclass | Key Parameters |
|-----------|----------------|
| `InverterThresholds` | offline_duration_min, temp_warning, temp_critical |
| `StringThresholds` | open_circuit_current, short_circuit_ratio |
| `TrackerThresholds` | stuck_std_dev, misaligned_degrees |
| `GridThresholds` | freq_low/high_hz, voltage_sag/swell_v |
| `MPPTThresholds` | imbalance_cv_warning/critical, hunting_oscillation_threshold |
| `EfficiencyThresholds` | min_efficiency_warning/critical, efficiency_decline_rate |
| `ThermalTwinThresholds` | warning_residual, critical_residual, consecutive_anomalies |
| `SensorHealthThresholds` | frozen_std_threshold, frozen_duration_min |
| `SoilingThresholds` | pr_soiling_threshold, clearsky_ratio_tolerance |
| `CurtailmentThresholds` | frequency_curtailment_offset, export_cap_fraction |
| `ModuleHealthThresholds` | bypass_diode_voltage_step, insulation_resistance_warning/critical |
| `VegetationShadingThresholds` | asymmetry_threshold, trending_days |
| `DCVoltageThresholds` | upper_margin, lower_margin, fault_duration_min |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Dec 2024 | Initial rule-based detection (13 fault types) |
| 1.1 | Dec 2024 | Added ML classifiers (Lazzaretti) |
| 1.2 | Dec 2024 | Added RUL prediction framework (7 models) |
| 1.3 | Dec 2024 | Plant-agnostic feature normalization |
| **1.4** | **Dec 2024** | **+19 fault types (32 total), Thermal Digital Twin, UI sorting/filtering** |

### v1.4 Detailed Changelog

**New Fault Types (19):**
- Inverter: efficiency_degradation, cooling_degradation, dc_link_capacitor_aging
- DC Voltage: dc_overvoltage, dc_undervoltage
- MPPT: mppt_imbalance, mppt_hunting, string_mismatch_coarse
- Grid: grid_curtailment, export_cap_active
- Module: module_current_degradation, module_voltage_drop, bypass_diode_active, insulation_resistance_low
- Sensor: sensor_frozen, irradiance_sensor_drift, communication_partial
- Environmental: soiling_detected, vegetation_shading

**Digital Twins:**
- `InverterThermalTwin` with CatBoost regression and residual-based anomaly detection

**Frontend:**
- Sortable fault table columns (fault type, equipment, loss, date)
- Power loss range filter (min/max kWh)

---

*Document generated: December 2024*
*NuraVolt Fault Detection System v1.4*
