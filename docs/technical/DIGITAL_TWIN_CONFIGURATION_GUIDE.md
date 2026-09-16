# Digital Twin Configuration Guide

Complete reference for configuring, experimenting with, and tuning NuraVolt digital twin models.

## Quick Start - Main Configuration File

**Primary Location**: `run_alpha1_analysis.py` (lines 57-138)

All key configuration values are now centralized in the `DIGITAL_TWIN_CONFIG` class at the top of the main script. This is the **easiest place** to make changes for quick trials.

```python
class DIGITAL_TWIN_CONFIG:
    # Modify these values directly for quick experimentation
    MAX_YEARS = 3.0
    MIN_PR = 0.10
    CATBOOST_LEARNING_RATE = 0.05
    # ... see file for complete list
```

## Current Feature List

### Core Features (Always Active)
Location: `run_alpha1_analysis.py:100-104` and `nuravolt/digitaltwin/catboost_model.py:70-74`

1. **`irradiance`** - POA irradiance (W/m²) - **MOST IMPORTANT FEATURE**
2. **`ambient_temp`** - Ambient temperature (°C)
3. **`module_temp`** - Module temperature (°C)

### Temporal Features
Location: `run_alpha1_analysis.py:107-111` and `nuravolt/digitaltwin/catboost_model.py:77-81`

4. **`day_of_year`** - Day 1-365 (captures seasonal effects)
5. **`hour_of_day`** - Hour 0-23 (captures daily patterns)
6. **`month`** - Month 1-12 (captures monthly trends)

### Solar Geometry Features
Location: `run_alpha1_analysis.py:114-118` and `nuravolt/digitaltwin/catboost_model.py:84-88`

7. **`solar_elevation`** - Sun elevation angle (degrees)
8. **`solar_azimuth`** - Sun azimuth angle (degrees)
9. **`air_mass`** - Atmospheric air mass factor (AM)

### Derived Features
Location: `run_alpha1_analysis.py:121-124` and `nuravolt/digitaltwin/catboost_model.py:91-94`

10. **`clearness_index`** - kt = GHI / extraterrestrial (sky clarity metric)
11. **`temp_delta`** - module_temp - ambient_temp (heat buildup indicator)

**Total Features**: 11 features used for prediction

---

## Configuration Categories

### 1. Data Filtering Parameters

**Location**: `run_alpha1_analysis.py:68-78`

Controls what historical data is used for training:

| Parameter | Default | Description | Quick Trial Suggestions |
|-----------|---------|-------------|------------------------|
| `MAX_YEARS` | 3.0 | Training period (first N years) | Try 2.0, 2.5, 3.5 |
| `MIN_PR` | 0.10 | Minimum Performance Ratio | Try 0.05 (more data), 0.15 (higher quality) |
| `MIN_IRRADIANCE` | 50.0 | Minimum irradiance (W/m²) | Try 100.0 (exclude cloudy), 25.0 (include more) |
| `MIN_TRAINING_SAMPLES` | 500 | Min samples per inverter | Try 300 (less strict), 1000 (more strict) |
| `VALIDATION_SPLIT` | 0.2 | Validation fraction | Try 0.15, 0.25 |
| `MIN_EXPECTED_POWER` | 0.1 | Export filter (kW/kWp) | Try 0.05, 0.15 |

**Impact**: These control training data quality vs. quantity tradeoff

### 2. CatBoost Hyperparameters

**Location**: `run_alpha1_analysis.py:81-88`

Core model training parameters:

| Parameter | Default | Description | Quick Trial Suggestions |
|-----------|---------|-------------|------------------------|
| `CATBOOST_ITERATIONS` | 1000 | Number of boosting rounds | Try 500 (faster), 1500 (more learning) |
| `CATBOOST_LEARNING_RATE` | 0.05 | Learning rate | Try 0.03 (more stable), 0.10 (faster) |
| `CATBOOST_DEPTH` | 6 | Tree depth | Try 4 (simpler), 8 (more complex) |
| `CATBOOST_L2_LEAF_REG` | 3 | L2 regularization | Try 1 (less reg), 5 (more reg) |
| `CATBOOST_EARLY_STOPPING` | 100 | Early stopping rounds | Try 50, 150 |

**Impact**: These control model complexity and learning behavior

**For Advanced Hyperparameter Tuning**: Edit `nuravolt/digitaltwin/catboost_model.py:116-126`

### 3. Quality Thresholds

**Location**: `run_alpha1_analysis.py:127-130`

Model validation criteria:

| Parameter | Default | Description | Quick Trial Suggestions |
|-----------|---------|-------------|------------------------|
| `MIN_R2` | 0.70 | Minimum R² score | Try 0.60 (less strict), 0.80 (more strict) |
| `MAX_MAE_KW` | 50.0 | Maximum MAE (kW) | Try 30.0 (stricter), 75.0 (looser) |

**Impact**: Controls which models are accepted as "successful"

### 4. Processing Configuration

**Location**: `run_alpha1_analysis.py:133-138`

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_WORKERS` | 4 | Parallel CPU workers |
| `BATCH_SIZE` | 30 | Inverters per batch |
| `SAVE_MODELS` | True | Save model pickle files |
| `SAVE_JSON` | True | Export dashboard JSON |

---

## How to Modify Features

### Option 1: Quick Feature Enable/Disable (Recommended)

**Location**: `run_alpha1_analysis.py:97-124`

Simply comment out features you don't want:

```python
TEMPORAL_FEATURES = [
    'day_of_year',
    # 'hour_of_day',      # Disabled for testing
    'month',
]
```

### Option 2: Advanced Feature Configuration

**Location**: `nuravolt/digitaltwin/catboost_model.py:67-104`

Modify the `FeatureConfig` class directly:

```python
@dataclass
class FeatureConfig:
    core_features: List[str] = field(default_factory=lambda: [
        'irradiance',
        'ambient_temp',
        # Add/remove features here
    ])
```

**Warning**: Changes here require updating data preparation code if adding new features that need to be computed.

---

## Running Quick Trials

### Scenario 1: Test Different Learning Rates
```python
# In run_alpha1_analysis.py, modify line 84:
CATBOOST_LEARNING_RATE = 0.03  # Try 0.03, 0.05, 0.07, 0.10
```
```bash
python run_alpha1_analysis.py --limit 5 --digital-twins-only
```

### Scenario 2: Test Different Training Periods
```python
# In run_alpha1_analysis.py, modify line 70:
MAX_YEARS = 2.5  # Try 2.0, 2.5, 3.0, 3.5
```
```bash
python run_alpha1_analysis.py --group "INV 01" --digital-twins-only
```

### Scenario 3: Test Stricter Data Quality
```python
# In run_alpha1_analysis.py, modify:
MIN_PR = 0.15              # Line 71 (raise from 0.10)
MIN_IRRADIANCE = 100.0     # Line 72 (raise from 50.0)
```
```bash
python run_alpha1_analysis.py --limit 10 --digital-twins-only
```

### Scenario 4: Test Simpler Model (Less Overfitting Risk)
```python
# In run_alpha1_analysis.py, modify:
CATBOOST_DEPTH = 4           # Line 85 (reduce from 6)
CATBOOST_L2_LEAF_REG = 5     # Line 86 (increase from 3)
```
```bash
python run_alpha1_analysis.py --limit 5 --digital-twins-only
```

---

## Performance Impact Matrix

| Change | Training Time | Model Size | Prediction Accuracy | Overfitting Risk |
|--------|--------------|------------|--------------------|--------------------|
| ↑ MAX_YEARS | ↑ | ↔ | ↑ (more data) | ↓ (more diversity) |
| ↑ MIN_PR | ↓ | ↔ | ↑ (cleaner data) | ↑ (less data) |
| ↑ ITERATIONS | ↑ | ↔ | ↑ (more learning) | ↑ |
| ↑ LEARNING_RATE | ↓ | ↔ | ↓ (less stable) | ↑ |
| ↑ DEPTH | ↑ | ↑ | ↑ (more complex) | ↑↑ |
| ↑ L2_LEAF_REG | ↔ | ↔ | ↓ (more regularized) | ↓ |
| Remove features | ↓ | ↓ | ↓ (less info) | ↓ |

---

## Advanced: Custom Hyperparameter Grid Search

To systematically test multiple hyperparameter combinations:

1. **Create experiment script**:
```python
# experiments/hyperparam_search.py
from itertools import product

learning_rates = [0.03, 0.05, 0.07]
depths = [4, 6, 8]
l2_regs = [1, 3, 5]

for lr, depth, l2 in product(learning_rates, depths, l2_regs):
    # Update DIGITAL_TWIN_CONFIG
    # Run training
    # Log results
```

2. **Use command-line overrides** (requires adding argparse options):
```bash
python run_alpha1_analysis.py --lr 0.03 --depth 4 --l2 3
```

---

## File Reference Quick Guide

| What to Modify | Primary Location | Alternative Location |
|----------------|------------------|---------------------|
| **All filters & hyperparams** | `run_alpha1_analysis.py:57-138` | - |
| **Feature list** | `run_alpha1_analysis.py:97-124` | `nuravolt/digitaltwin/catboost_model.py:67-104` |
| **CatBoost params** | `run_alpha1_analysis.py:81-94` | `nuravolt/digitaltwin/catboost_model.py:116-139` |
| **Data selection logic** | `nuravolt/digitaltwin/data_selector.py` | - |
| **Model training** | `nuravolt/digitaltwin/catboost_model.py` | - |
| **Factory orchestration** | `nuravolt/digitaltwin/factory.py` | - |

---

## Common Tuning Scenarios

### Scenario: Models Overfitting (Training R² >> Validation R²)
**Solutions**:
- ↑ `CATBOOST_L2_LEAF_REG` (3 → 5)
- ↓ `CATBOOST_DEPTH` (6 → 4)
- ↑ `MIN_TRAINING_SAMPLES` (500 → 1000)
- ↓ `CATBOOST_ITERATIONS` (1000 → 500)

### Scenario: Models Underfitting (Low R² on both train/val)
**Solutions**:
- ↑ `CATBOOST_DEPTH` (6 → 8)
- ↑ `CATBOOST_ITERATIONS` (1000 → 1500)
- ↓ `MIN_PR` (0.10 → 0.05) for more training data
- Add more features (check if derived features are computed)

### Scenario: Training Takes Too Long
**Solutions**:
- ↓ `MAX_YEARS` (3.0 → 2.0)
- ↓ `CATBOOST_ITERATIONS` (1000 → 500)
- ↑ `MIN_IRRADIANCE` (50 → 100) to filter more data
- ↓ `MAX_WORKERS` (4 → 2) to reduce CPU load

### Scenario: Not Enough Training Data
**Solutions**:
- ↓ `MIN_PR` (0.10 → 0.05)
- ↓ `MIN_IRRADIANCE` (50 → 25)
- ↓ `MIN_TRAINING_SAMPLES` (500 → 300)
- ↑ `MAX_YEARS` (3.0 → 3.5)

---

## Tips for Experimentation

1. **Start Small**: Use `--limit 5` flag to test on 5 inverters first
2. **One Change at a Time**: Modify one parameter per trial to isolate effects
3. **Log Everything**: Check `alpha1_analysis.log` for detailed metrics
4. **Compare Results**: Use quality_report.csv to compare experiments
5. **Use Full Timeline**: Add `--full-timeline` flag to see predictions across all years

---

## Questions?

**What features are most important?**
Check feature importance in saved models or logs. Typically: irradiance > module_temp > solar_elevation

**Should I add more features?**
Only if you have the data available. More features = more complexity = higher overfitting risk without enough training data.

**What's a good R² score?**
- R² > 0.90: Excellent
- R² > 0.80: Good
- R² > 0.70: Acceptable
- R² < 0.70: Consider model not useful

**How do I know if my changes improved the model?**
Compare:
1. Average R² score across all inverters
2. MAE (mean absolute error) - lower is better
3. Visual inspection of predictions vs actuals in heatmap

---

**Last Updated**: 2025-01-27
**NuraVolt Version**: 0.2.0
