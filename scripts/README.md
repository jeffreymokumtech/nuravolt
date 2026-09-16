# NuraVolt Script Architecture

Clear separation between Digital Twin training and Soiling Analysis workflows.

---

## Script Organization

### 🤖 Digital Twin Scripts (ML Models)

#### 1. `run_digital_twin_training.py` ⭐ **PRIMARY SCRIPT**
**Purpose**: Train CatBoost/LightGBM digital twin models for power loss prediction

**What it does**:
- Loads historical inverter data (parquet)
- Trains ML models per inverter (CatBoost/LightGBM)
- Validates model quality (R², MAE)
- Exports trained models + predictions JSON
- Updates dashboard data

**Configuration**: **THIS IS THE SINGLE SOURCE OF TRUTH**
- Location: Lines 57-156
- Class: `DIGITAL_TWIN_CONFIG`
- **Modify this file for ALL digital twin parameter changes**

**Usage**:
```bash
# Train all 150 inverters
python run_digital_twin_training.py

# Quick test (5 inverters)
python run_digital_twin_training.py --limit 5

# Train specific group
python run_digital_twin_training.py --group "INV 01"

# Custom workers and R² threshold
python run_digital_twin_training.py --workers 8 --min-r2 0.75
```

**Key Configuration Parameters** (all in this file):
- Data filtering: `MAX_YEARS`, `MIN_PR`, `MIN_IRRADIANCE`
- Hyperparameters: `CATBOOST_ITERATIONS`, `CATBOOST_LEARNING_RATE`, `CATBOOST_DEPTH`, `CATBOOST_L2_LEAF_REG`
- Features: `CORE_FEATURES`, `TEMPORAL_FEATURES`, `SOLAR_FEATURES`, `DERIVED_FEATURES`
- Quality thresholds: `MIN_R2`, `MAX_MAE_KW`

**Output**:
- `public/data/digitaltwin/alpha1/models/*.pkl` - Trained model files
- `public/data/digitaltwin/alpha1/predictions.json` - Latest predictions
- `public/data/digitaltwin/alpha1/quality_report.csv` - Training quality metrics

---

### 🧹 Soiling Analysis Scripts (Physics + Business Logic)

#### 2. `run_alpha1_365d_forecast.py` ⭐ **PRIMARY SCRIPT**
**Purpose**: 365-day soiling forecast with cleaning schedule optimization

**What it does**:
- Uses existing digital twin models (doesn't train new ones)
- Generates 365-day soiling ratio forecast (physics-ML hybrid)
- Calculates financial impact (energy loss, revenue loss)
- Optimizes cleaning schedule (1-5 cleanings/year)
- Generates operator proposal with recommendations

**Configuration**:
- Location: `nuravolt/soiling/config.py`
- Class: `SoilingConfig`, `SITE_CONFIG`
- Soiling-specific parameters only

**Usage**:
```bash
# Run full 365-day forecast with optimization
python run_alpha1_365d_forecast.py
```

**Output**:
- `outputs_alpha1_365d/` - Forecast plots, CSVs, recommendations
- `public/data/soiling/alpha1/` - Dashboard JSON data

---

### 🔄 Unified Orchestrator (Convenience Wrapper)

#### 3. `run_alpha1_analysis.py`
**Purpose**: Run BOTH digital twins + soiling in one command

**What it does**:
- Orchestrates sequential execution:
  1. Phase 1: Train digital twins (calls digital twin code)
  2. Phase 2: Run soiling forecast (calls soiling code)
  3. Phase 3: Generate dashboard data
- Convenience wrapper for complete end-to-end workflow

**Configuration**: **IMPORTS from run_digital_twin_training.py**
- Does NOT have its own config
- Uses `DIGITAL_TWIN_CONFIG` from `run_digital_twin_training.py`
- For digital twin params: **Edit `run_digital_twin_training.py`**

**Usage**:
```bash
# Run everything (twins + soiling)
python run_alpha1_analysis.py

# Digital twins only
python run_alpha1_analysis.py --digital-twins-only

# Soiling only (uses existing models)
python run_alpha1_analysis.py --soiling-only

# Full timeline predictions (for heatmaps)
python run_alpha1_analysis.py --full-timeline
```

**When to use**:
- ✅ Need complete workflow (training + forecasting)
- ✅ Production pipeline automation
- ❌ Experimenting with digital twin parameters (use `run_digital_twin_training.py` instead)

---

## Configuration Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│  run_digital_twin_training.py                               │
│  ────────────────────────────────                           │
│  DIGITAL_TWIN_CONFIG (SINGLE SOURCE OF TRUTH)              │
│  • Data filtering (MAX_YEARS, MIN_PR, etc.)                │
│  • CatBoost hyperparameters (iterations, learning rate)    │
│  • Features (core, temporal, solar, derived)               │
│  • Quality thresholds (MIN_R2, MAX_MAE_KW)                 │
└─────────────────────────────────────────────────────────────┘
                         ▲
                         │ imports DIGITAL_TWIN_CONFIG
                         │
┌─────────────────────────────────────────────────────────────┐
│  run_alpha1_analysis.py                                   │
│  ────────────────────────────                               │
│  Orchestrator (uses imported config)                        │
│  • NO digital twin config here                             │
│  • Imports from run_digital_twin_training.py              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  run_alpha1_365d_forecast.py                              │
│  ────────────────────────────────────────────────────────── │
│  Separate config: nuravolt/soiling/config.py               │
│  • Site configuration (capacity, PPA rate, cleaning cost)   │
│  • Soiling-specific parameters only                         │
│  • NO digital twin parameters                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Decision Tree

### "I want to modify digital twin hyperparameters"
→ Edit `run_digital_twin_training.py` (lines 57-156)

### "I want to train digital twin models"
→ Run `python run_digital_twin_training.py`

### "I want to run soiling forecast (with existing models)"
→ Run `python run_alpha1_365d_forecast.py`

### "I want to do everything end-to-end"
→ Run `python run_alpha1_analysis.py`

### "I want to modify soiling parameters (cleaning costs, PPA rates)"
→ Edit `nuravolt/soiling/config.py`

---

## Feature Lists

### Digital Twin Features (11 total)
**Location**: `run_digital_twin_training.py:117-142`

**Core Environmental** (3):
- `irradiance` - POA irradiance (W/m²)
- `ambient_temp` - Ambient temperature (°C)
- `module_temp` - Module temperature (°C)

**Temporal** (3):
- `day_of_year` - 1-365
- `hour_of_day` - 0-23
- `month` - 1-12

**Solar Geometry** (3):
- `solar_elevation` - Sun elevation (°)
- `solar_azimuth` - Sun azimuth (°)
- `air_mass` - Atmospheric air mass

**Derived** (2):
- `clearness_index` - Sky clarity
- `temp_delta` - Heat buildup (module - ambient)

**To modify**: Comment/uncomment lines in `run_digital_twin_training.py:117-142`

---

## Data Flow

```
┌──────────────────┐
│ Historical Data  │
│   (parquet)      │
└────────┬─────────┘
         │
         ▼
┌─────────────────────────────────────┐
│ run_digital_twin_training.py        │
│ • Train CatBoost models             │
│ • Validate quality                  │
│ • Export models + predictions       │
└──────────┬──────────────────────────┘
           │
           │ outputs: *.pkl models, predictions.json
           │
           ▼
┌─────────────────────────────────────┐
│ run_alpha1_365d_forecast.py       │
│ • Load trained models               │
│ • Generate 365-day forecast         │
│ • Optimize cleaning schedule        │
│ • Calculate financial impact        │
└──────────┬──────────────────────────┘
           │
           │ outputs: forecast CSVs, plots, recommendations
           │
           ▼
┌─────────────────────────────────────┐
│ Dashboard (Next.js frontend)        │
│ /demo/heatmap                       │
│ /demo/soiling                       │
└─────────────────────────────────────┘
```

---

## Common Workflows

### Workflow 1: Quick Hyperparameter Tuning
```bash
# 1. Edit hyperparameters
vim run_digital_twin_training.py  # Modify CATBOOST_LEARNING_RATE, DEPTH, etc.

# 2. Test on 5 inverters
python run_digital_twin_training.py --limit 5

# 3. Check quality_report.csv for R² scores

# 4. If satisfied, train all inverters
python run_digital_twin_training.py
```

### Workflow 2: Full Production Pipeline
```bash
# Option A: Run everything at once
python run_alpha1_analysis.py

# Option B: Run separately (more control)
python run_digital_twin_training.py
python run_alpha1_365d_forecast.py
```

### Workflow 3: Update Soiling Forecast Only
```bash
# Use existing digital twin models, just update forecast
python run_alpha1_365d_forecast.py
# OR
python run_alpha1_analysis.py --soiling-only
```

---

## File Reference

| File | Purpose | Configuration Location | Size |
|------|---------|----------------------|------|
| `run_digital_twin_training.py` | **Train ML models** | Lines 57-156 ⭐ | 11KB |
| `run_alpha1_365d_forecast.py` | **Soiling forecast** | `nuravolt/soiling/config.py` | 15KB |
| `run_alpha1_analysis.py` | **Orchestrator** | Imports from above | 25KB |
| `nuravolt/digitaltwin/` | Digital twin library | - | - |
| `nuravolt/soiling/` | Soiling analysis library | - | - |

---

## Key Takeaways

1. **Single Source of Truth**: `run_digital_twin_training.py` has ALL digital twin parameters
2. **Separation of Concerns**: Digital twins ≠ Soiling analysis
3. **Orchestrator is Optional**: Use for convenience, not for configuration
4. **Independent Scripts**: Can run digital twin training without soiling, and vice versa
5. **Configuration Hierarchy**: Always edit the primary script, not the orchestrator

---

**Last Updated**: 2025-01-27
**NuraVolt Version**: 0.2.0
