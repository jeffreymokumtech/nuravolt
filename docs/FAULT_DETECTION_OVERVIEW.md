# NuraVolt Fault Detection System Overview

## Detection Modes

| Mode | Method | Timing | Use Case |
|------|--------|--------|----------|
| **Reactive** | Rule-based thresholds | Real-time detection | Immediate alerts, fault already occurring |
| **Predictive** | ML regression | Forecast (1-90 days ahead) | Maintenance scheduling, prevent faults |

---

## Reactive Fault Detection (Rule-Based)

Detects faults **currently happening**. Power loss is **already occurring**.

| Fault Type | Detection Logic | Typical Power Loss | Severity |
|------------|-----------------|-------------------|----------|
| **Inverter Offline** | AC power = 0 while irradiance > 50 W/m² | 100% of inverter capacity | CRITICAL |
| **Inverter Clipping** | AC power at rated limit while DC headroom exists | 5-15% peak production | WARNING |
| **Inverter Overtemp** | Inverter temp > 65°C | 0% (derating) to 100% (shutdown) | CRITICAL |
| **String Open Circuit** | String current < 5% of expected | 100% of string (~8-12% of inverter) | CRITICAL |
| **String Short Circuit** | String voltage < 50% of Voc | 100% of string | CRITICAL |
| **Tracker Stuck** | Tracker angle constant > 30 min | 10-40% depending on time of day | WARNING |
| **Tracker Misaligned** | Tracker angle differs from calculated optimal by > 15° | 5-20% | WARNING |
| **Grid Frequency Low** | Frequency < 49.5 Hz (EU) / 59.5 Hz (US) | Risk of disconnect | WARNING |
| **Grid Frequency High** | Frequency > 50.5 Hz (EU) / 60.5 Hz (US) | Risk of disconnect | WARNING |
| **Grid Voltage Sag** | Voltage < 0.9 pu | Inverter may trip | WARNING |
| **Grid Voltage Swell** | Voltage > 1.1 pu | Inverter may trip | WARNING |
| **Module Overtemp** | Module temp > 85°C | 2-5% per 10°C above optimal | WARNING |
| **Communication Loss** | No data for > 15 min | 0% (monitoring only) | INFO |

### Power Loss Calculation (Reactive)

For reactive faults, calculate **current power loss**:

```python
# Example: String Open Circuit
power_loss_kw = (n_affected_strings / n_total_strings) * rated_dc_power_kw

# Example: Inverter Offline
power_loss_kw = inverter_rated_power_kw  # 100% of inverter

# Example: Tracker Stuck (afternoon)
cos_loss = cos(optimal_angle) - cos(actual_angle)
power_loss_fraction = cos_loss / cos(optimal_angle)
```

---

## Predictive Fault Detection (RUL Models)

Predicts **days until fault threshold is crossed**. Power loss is **future/potential**.

### Model Performance Summary

| Model | MAE | Within 1d | Within 3d | Within 7d | Dataset |
|-------|-----|-----------|-----------|-----------|---------|
| String Degradation | 0.44d | 92.2% | 97.6% | 99.7% | Lazzaretti |
| Module Degradation | 0.04d | 99.8% | 100% | 100% | Lazzaretti |
| Inverter Thermal | 0.02d | 99.9% | 100% | 100% | Alpha |
| Thermal Hotspot | 0.03d | 99.9% | 100% | 100% | PVDAQ |
| String Mismatch | 0.05d | 99.7% | 99.9% | 100% | PVDAQ |

### What Each Model Predicts

| Model | Predicting Time Until... | Threshold Event | Consequence When Threshold Crossed |
|-------|-------------------------|-----------------|-----------------------------------|
| **String Degradation** | String CV > 25% | Current imbalance between modules in string | 5-15% string underperformance |
| **Module Degradation** | PR < 75% | Performance ratio drops below warranty typical | Permanent 25%+ production loss |
| **Inverter Thermal** | Inverter temp > 65°C | Thermal shutdown imminent | 100% inverter shutdown |
| **Thermal Hotspot** | temp_delta > 25°C (sustained) | Localized overheating indicating cell/bypass diode issue | 5-30% module loss, fire risk |
| **String Mismatch** | worst_string_ratio < 0.85 | One string producing <85% of average | 15%+ loss on affected string |

### Power Loss Estimation (Predictive)

For predictive faults, calculate **projected future loss**:

```python
# String Degradation → Partial string loss
projected_loss_kw = string_rated_power_kw * (1 - 0.85)  # ~15% of string

# Module Degradation → Permanent efficiency loss
projected_loss_annual_kwh = rated_power_kw * capacity_factor * 8760 * 0.25  # 25% loss

# Inverter Thermal → Complete inverter shutdown
projected_loss_kw = inverter_rated_power_kw  # 100% during shutdown

# Thermal Hotspot → Module replacement needed
projected_loss_kw = module_rated_power_w / 1000 * n_affected_modules

# String Mismatch → String underperformance
projected_loss_kw = (1 - worst_string_ratio) * string_rated_power_kw
```

---

## Fault-to-Power-Loss Mapping

### Digital Twin Integration

```python
@dataclass
class FaultPowerImpact:
    """Power impact from detected fault."""

    fault_type: str
    mode: Literal["reactive", "predictive"]

    # For reactive: current loss
    # For predictive: projected loss when fault occurs
    power_loss_kw: float

    # Only for predictive
    days_to_fault: Optional[float] = None
    confidence: Optional[float] = None

    # Energy impact
    @property
    def daily_energy_loss_kwh(self) -> float:
        """Estimated daily energy loss (assuming 5 peak sun hours)."""
        return self.power_loss_kw * 5.0

    @property
    def annual_energy_loss_kwh(self) -> float:
        """Estimated annual energy loss."""
        return self.daily_energy_loss_kwh * 365 * 0.8  # 80% availability factor
```

### Loss Factors by Fault Type

| Fault Type | Scope | Loss Factor | Calculation |
|------------|-------|-------------|-------------|
| Inverter Offline | Per inverter | 100% | `inverter_rated_kw` |
| Inverter Thermal | Per inverter | 100% | `inverter_rated_kw` |
| String Open | Per string | 100% | `inverter_rated_kw / n_strings` |
| String Degradation | Per string | 15% | `string_rated_kw * 0.15` |
| String Mismatch | Per string | 15% | `(1 - ratio) * string_rated_kw` |
| Module Degradation | Per plant | 25% | `plant_rated_kw * 0.25` |
| Thermal Hotspot | Per module | 100% | `module_rated_kw * n_modules` |
| Tracker Stuck | Per tracker | 20% | `tracker_rated_kw * cos_loss` |

---

## Example Output Structure

### Maintenance Schedule with Power Impact

```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "reactive_faults": [
    {
      "fault_type": "string_open_circuit",
      "inverter_id": "INV-05",
      "string_id": "S3",
      "current_power_loss_kw": 28.5,
      "severity": "critical",
      "detected_at": "2025-01-15T10:15:00Z"
    }
  ],
  "predictive_faults": [
    {
      "fault_type": "inverter_thermal",
      "inverter_id": "INV-12",
      "days_to_fault": 2.3,
      "confidence": 0.87,
      "projected_power_loss_kw": 333.0,
      "threshold": "65°C",
      "current_value": "58°C",
      "recommended_action": "Check cooling system, clean vents"
    },
    {
      "fault_type": "string_mismatch",
      "inverter_id": "INV-08",
      "days_to_fault": 8.1,
      "confidence": 0.92,
      "projected_power_loss_kw": 42.0,
      "threshold": "85% ratio",
      "current_value": "89% ratio",
      "recommended_action": "Inspect string connectors"
    }
  ],
  "summary": {
    "total_current_loss_kw": 28.5,
    "total_projected_loss_kw": 375.0,
    "urgent_actions": 2,
    "planned_actions": 1
  }
}
```

---

## Not Yet Implemented

| Model | Reason | Required Data |
|-------|--------|---------------|
| **Bypass Diode** | Requires thermal imaging | IR camera images |
| **Insulation (Riso)** | No public Riso dataset | Ground fault detector logs |
| **PID Detection** | Complex electrochemical process | Long-term efficiency curves |
| **Soiling RUL** | Need soiling station data | Soiling ratio time series |

---

## Accuracy Summary

### Reactive Detection Accuracy

| Fault Type | Precision | Recall | F1 Score |
|------------|-----------|--------|----------|
| Inverter Offline | 99%+ | 99%+ | 99%+ |
| String Open Circuit | 95% | 90% | 92% |
| Overtemperature | 98% | 95% | 96% |

*Rule-based detection is deterministic when data quality is good.*

### Predictive Detection Accuracy

| Horizon | String Deg. | Module Deg. | Inv. Thermal | Hotspot | Mismatch |
|---------|-------------|-------------|--------------|---------|----------|
| 1 day | 92.2% | 99.8% | 99.9% | 99.9% | 99.7% |
| 3 days | 97.6% | 100% | 100% | 100% | 99.9% |
| 7 days | 99.7% | 100% | 100% | 100% | 100% |
| 14 days | 99.9% | 100% | 100% | 100% | 100% |
| 30 days | 100% | 100% | 100% | 100% | 100% |

---

## Usage Example

```python
from nuravolt.fault import (
    RuleBasedFaultDetector,
    FaultDetectionConfig,
    RULPredictor,
    create_predictor,
)

# 1. Reactive detection (what's broken NOW)
detector = RuleBasedFaultDetector(FaultDetectionConfig())
reactive_result = detector.detect_all(df)

# 2. Predictive detection (what WILL break)
predictor = create_predictor("models/rul")
schedule = predictor.get_maintenance_schedule(df, plant_config)

# 3. Combined power loss report
total_current_loss = sum(f.power_loss_kw for f in reactive_result.alerts)
total_projected_loss = sum(
    estimate_power_loss(f.fault_type, plant_config)
    for f in schedule.urgent + schedule.soon
)
```
