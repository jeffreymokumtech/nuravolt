# RUL Model Training Report

*Generated: 2025-12-27T08:30:39.529875*

## Summary

| Metric | Value |
|--------|-------|
| Data source | backenddata/datasets/lazzaretti/lazzaretti_faults.parquet |
| Total samples | 1,373,798 |
| Models trained | 7 |
| Models failed | 0 |

## Model Performance

| Model | MAE | W/3d | W/7d | W/30d | Status |
|-------|-----|------|------|-------|--------|
| String Degradation | 0.7d | 98% | 100% | 100% | ✅ Pass |
| Inverter Overtemperature | 0.5d | 100% | 100% | 100% | ✅ Pass |
| Module Degradation | 4.7d | 51% | 71% | 100% | ⚠️ Warn |
| Thermal Hotspot Risk | 0.5d | 100% | 100% | 100% | ✅ Pass |
| String Mismatch | 1.3d | 88% | 96% | 100% | ✅ Pass |
| Bypass Diode Stress | 0.4d | 100% | 100% | 100% | ✅ Pass |
| Insulation Degradation | 7.2d | 26% | 56% | 100% | ⚠️ Warn |

## String Degradation

- **Threshold**: 0.25 CV
- **Max horizon**: 14 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 21.6s
- **Model path**: `models/rul/rul_string_degradation.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 0.69 days |
| RMSE | 1.07 days |
| Median AE | 0.42 days |
| Overestimate rate | 49.9% |
| Underestimate rate | 50.0% |

### Feature Importance (Top 5)
- string_current_min_ratio: 36.9%
- string_current_cv: 28.7%
- string_cv_trend_7d: 26.8%
- string_current_max_ratio: 6.9%
- irradiance_normalized: 0.7%

## Inverter Overtemperature

- **Threshold**: 65.0 °C
- **Max horizon**: 10 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 10.7s
- **Model path**: `models/rul/rul_inverter_thermal.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 0.48 days |
| RMSE | 0.73 days |
| Median AE | 0.31 days |
| Overestimate rate | 50.0% |
| Underestimate rate | 50.0% |

### Feature Importance (Top 5)
- ac_power_pu: 42.1%
- temp_rise: 40.1%
- ambient_temp: 14.4%
- temp_rise_trend_7d: 3.3%

## Module Degradation

- **Threshold**: 0.75 PR
- **Max horizon**: 90 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 20.4s
- **Model path**: `models/rul/rul_module_degradation.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 4.75 days |
| RMSE | 7.25 days |
| Median AE | 2.81 days |
| Overestimate rate | 50.0% |
| Underestimate rate | 49.9% |

### Feature Importance (Top 5)
- performance_ratio: 66.1%
- irradiance_normalized: 18.5%
- module_temp: 15.2%
- pr_trend_30d: 0.1%
- efficiency_trend_30d: 0.1%

## Thermal Hotspot Risk

- **Threshold**: 25.0 °C
- **Max horizon**: 10 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 12.9s
- **Model path**: `models/rul/rul_thermal_hotspot.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 0.54 days |
| RMSE | 0.80 days |
| Median AE | 0.34 days |
| Overestimate rate | 49.8% |
| Underestimate rate | 50.2% |

### Feature Importance (Top 5)
- temp_delta: 49.8%
- irradiance_normalized: 41.1%
- power_pu: 4.4%
- temp_delta_95th_7d: 2.7%
- temp_delta_max_7d: 1.1%

## String Mismatch

- **Threshold**: 0.85 ratio
- **Max horizon**: 14 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 25.7s
- **Model path**: `models/rul/rul_mismatch.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 1.34 days |
| RMSE | 2.45 days |
| Median AE | 0.62 days |
| Overestimate rate | 50.2% |
| Underestimate rate | 49.7% |

### Feature Importance (Top 5)
- worst_string_ratio: 58.2%
- string_ratio_trend_7d: 41.8%

## Bypass Diode Stress

- **Threshold**: 3 count
- **Max horizon**: 7 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 20.3s
- **Model path**: `models/rul/rul_bypass_diode.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 0.35 days |
| RMSE | 0.55 days |
| Median AE | 0.18 days |
| Overestimate rate | 50.1% |
| Underestimate rate | 49.9% |

### Feature Importance (Top 5)
- hotspot_count: 98.7%
- hotspot_trend_7d: 1.3%

## Insulation Degradation

- **Threshold**: 40.0 MΩ/kWp
- **Max horizon**: 90 days
- **Training samples**: 989,134
- **Test samples**: 274,760
- **Training time**: 14.2s
- **Model path**: `models/rul/rul_insulation.pkl`

### Metrics
| Metric | Value |
|--------|-------|
| MAE | 7.18 days |
| RMSE | 8.99 days |
| Median AE | 6.07 days |
| Overestimate rate | 50.0% |
| Underestimate rate | 50.0% |

### Feature Importance (Top 5)
- riso_value: 99.3%
- humidity_avg_7d: 0.2%
- age_years: 0.1%
- riso_trend_30d: 0.1%
- temp_cycles_30d: 0.1%
