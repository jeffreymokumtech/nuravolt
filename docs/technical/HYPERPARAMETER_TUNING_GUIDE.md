# Hyperparameter Tuning Guide

Complete guide for digital twin model selection and hyperparameter optimization.

---

## Quick Start

### Location
**File**: `run_digital_twin_training.py` (lines 98-151)

### Configuration Structure

```python
class DIGITAL_TWIN_CONFIG:
    # Model selection
    USE_CATBOOST = True                      # True = CatBoost, False = LightGBM
    ENABLE_HYPERPARAMETER_TUNING = False     # True = auto-tune, False = manual

    # CatBoost manual parameters (dict format)
    CATBOOST_PARAMS = {
        'iterations': 200,
        'learning_rate': 0.1,
        'depth': 20,
        'l2_leaf_reg': 0.1,
        'random_seed': 42,
        'early_stopping_rounds': 100,
        'verbose': False,
        'loss_function': 'RMSE',
        'eval_metric': 'RMSE',
    }

    # CatBoost tuning search space (for auto-tuning)
    CATBOOST_TUNING_SPACE = {
        'iterations': [100, 200, 500, 1000],
        'learning_rate': [0.01, 0.03, 0.05, 0.1],
        'depth': [4, 6, 8, 10, 15, 20],
        'l2_leaf_reg': [0.1, 1, 3, 5, 10],
    }

    # LightGBM manual parameters
    LIGHTGBM_PARAMS = {
        'objective': 'regression',
        'metric': 'rmse',
        'learning_rate': 0.05,
        'num_leaves': 31,
        'max_depth': 6,
        'n_estimators': 1000,
        'early_stopping_rounds': 100,
        'verbose': -1,
        'random_state': 42,
    }

    # LightGBM tuning search space
    LIGHTGBM_TUNING_SPACE = {
        'n_estimators': [500, 1000, 1500],
        'learning_rate': [0.01, 0.03, 0.05, 0.1],
        'num_leaves': [15, 31, 63, 127],
        'max_depth': [4, 6, 8, 10],
        'min_child_samples': [10, 20, 50],
    }
```

---

## Mode 1: Manual Hyperparameters (Default)

**When to use**: When you know what parameters work well, or for quick experiments.

### Configuration
```python
USE_CATBOOST = True
ENABLE_HYPERPARAMETER_TUNING = False  # Manual mode

# Edit parameters directly in the dict
CATBOOST_PARAMS = {
    'iterations': 200,
    'learning_rate': 0.1,
    'depth': 20,
    'l2_leaf_reg': 0.1,
    ...
}
```

### How it works
1. Script reads `CATBOOST_PARAMS` or `LIGHTGBM_PARAMS` dict
2. Creates model with exactly these parameters
3. No validation split needed (uses all training data)
4. Faster training (no hyperparameter search overhead)

### Quick trials
```bash
# 1. Edit run_digital_twin_training.py
#    Modify CATBOOST_PARAMS dict (lines 107-117)

# 2. Test on 5 inverters
python run_digital_twin_training.py --limit 5

# 3. Check quality_report.csv for R² scores

# 4. Try different parameters
#    Edit dict again, repeat steps 2-3
```

---

## Mode 2: Automatic Hyperparameter Tuning

**When to use**: When you want to find optimal parameters automatically.

### Configuration
```python
USE_CATBOOST = True
ENABLE_HYPERPARAMETER_TUNING = True   # Enable auto-tuning

# Define search space
CATBOOST_TUNING_SPACE = {
    'iterations': [100, 200, 500, 1000],
    'learning_rate': [0.01, 0.03, 0.05, 0.1],
    'depth': [4, 6, 8, 10, 15, 20],
    'l2_leaf_reg': [0.1, 1, 3, 5, 10],
}
```

### How it works
1. **Random search**: Tries random combinations from search space
2. **Validation split**: Uses `VALIDATION_SPLIT` (default 5%) from training data
3. **Best selection**: Picks parameters with highest validation R²
4. **Per inverter**: Each inverter gets individually tuned parameters

### Tuning algorithm (Random Search)
```python
# For each inverter:
for trial in range(20):  # 20 random trials
    1. Sample random params from search space
    2. Train model on 95% training data
    3. Evaluate on 5% validation data
    4. Track best R² score

# Use best parameters found for final model
```

### Important notes
- ⚠️ **Much slower**: ~20x longer training time (20 trials per inverter)
- ✅ **Better quality**: May find better parameters than manual tuning
- 💾 **More memory**: Keeps validation data in memory
- 📊 **Per inverter**: Each inverter optimized individually

### Running with tuning
```bash
# 1. Enable in config
#    Set ENABLE_HYPERPARAMETER_TUNING = True

# 2. Test on 1-2 inverters first (it's slow!)
python run_digital_twin_training.py --limit 2

# 3. Check logs for "Best hyperparameters" messages

# 4. If results are good, run on more inverters
python run_digital_twin_training.py --group "INV 01"
```

---

## Model Selection: CatBoost vs LightGBM

### Switch models
```python
# CatBoost (default, recommended for solar)
USE_CATBOOST = True

# LightGBM (faster, less memory)
USE_CATBOOST = False
```

### Comparison

| Feature | CatBoost | LightGBM |
|---------|----------|----------|
| **Speed** | Slower | Faster |
| **Memory** | More | Less |
| **Accuracy** | Slightly better | Slightly worse |
| **Robustness** | Better with outliers | More sensitive |
| **Recommendation** | Solar data (default) | Large datasets |

### When to use LightGBM
- Very large datasets (>100K samples per inverter)
- Memory constrained systems
- Need faster training
- Acceptable slight accuracy loss

---

## Hyperparameter Tuning Search Spaces

### How to customize search space

**Add more values to try**:
```python
CATBOOST_TUNING_SPACE = {
    'iterations': [100, 200, 500, 1000, 1500, 2000],  # More options
    'learning_rate': [0.01, 0.03, 0.05, 0.07, 0.1, 0.15],
    'depth': [4, 6, 8, 10, 12, 15, 20],
    'l2_leaf_reg': [0.1, 0.5, 1, 3, 5, 10],
}
```

**Reduce for faster tuning**:
```python
CATBOOST_TUNING_SPACE = {
    'iterations': [100, 500],          # Fewer options
    'learning_rate': [0.05, 0.1],
    'depth': [6, 10],
    'l2_leaf_reg': [1, 3],
}
```

### Number of trials
**Location**: `run_digital_twin_training.py:211`

```python
def tune_hyperparameters(..., n_trials: int = 20):
    # Change this to control trials per inverter
    # More trials = better results but slower
```

**Recommendations**:
- **Quick test**: 5-10 trials
- **Standard**: 20 trials (default)
- **Thorough**: 50-100 trials

---

## Dashboard JSON Refresh

### JSON output files
```bash
public/data/digitaltwin/alpha1/
├── predictions.json              # Latest 24h predictions (dashboard uses this)
├── digital_twins.json            # Model metadata (dashboard uses this)
├── digital_twins_results.json    # Training results
├── digital_twins_summary.json    # Summary statistics
└── models/*.pkl                  # Trained model files
```

### Refresh mechanism
1. **Training completes** → Exports new JSON files
2. **Dashboard loads** → Fetches `/data/digitaltwin/alpha1/*.json`
3. **Automatic refresh** → Next dashboard load sees new data

### Verify refresh
```bash
# Check file timestamps (should match recent training)
ls -lht public/data/digitaltwin/alpha1/*.json | head -5

# Check predictions timestamp in JSON
cat public/data/digitaltwin/alpha1/predictions.json | grep generatedAt
```

### Dashboard pages that use data
- `/demo/inverter/[inverterId]` - Uses `digital_twins.json`
- `/demo/heatmap` - Uses residual CSVs and timeline heatmap
- Dashboard should auto-refresh on page reload

---

## Complete Workflow Examples

### Example 1: Quick Manual Tuning
```bash
# 1. Edit hyperparameters
vim run_digital_twin_training.py
# Modify CATBOOST_PARAMS dict (line 107)

# 2. Test on 5 inverters
python run_digital_twin_training.py --limit 5

# 3. Check results
cat public/data/digitaltwin/alpha1/quality_report.csv

# 4. Iterate: Edit params → Test → Check
```

### Example 2: Auto-tuning Search
```bash
# 1. Enable tuning
vim run_digital_twin_training.py
# Set ENABLE_HYPERPARAMETER_TUNING = True (line 102)

# 2. Test on 2 inverters (slow!)
python run_digital_twin_training.py --limit 2

# 3. Review tuning logs
tail -f digital_twin_training.log | grep "Best hyperparameters"

# 4. If good, expand to group
python run_digital_twin_training.py --group "INV 01"
```

### Example 3: Compare CatBoost vs LightGBM
```bash
# 1. Train with CatBoost
vim run_digital_twin_training.py
# Set USE_CATBOOST = True
python run_digital_twin_training.py --limit 10
mv public/data/digitaltwin/alpha1/quality_report.csv quality_catboost.csv

# 2. Train with LightGBM
vim run_digital_twin_training.py
# Set USE_CATBOOST = False
python run_digital_twin_training.py --limit 10
mv public/data/digitaltwin/alpha1/quality_report.csv quality_lightgbm.csv

# 3. Compare results
python -c "
import pandas as pd
cat = pd.read_csv('quality_catboost.csv')
lgb = pd.read_csv('quality_lightgbm.csv')
print('CatBoost avg R²:', cat['r2'].mean())
print('LightGBM avg R²:', lgb['r2'].mean())
"
```

---

## Advanced: Custom Tuning Algorithm

### Current implementation
- **Algorithm**: Random search (20 trials)
- **Location**: `run_digital_twin_training.py:205-284`

### Modify tuning algorithm
```python
# Change from random search to grid search
def tune_hyperparameters(...):
    from itertools import product

    # Generate all combinations
    search_space = DIGITAL_TWIN_CONFIG.CATBOOST_TUNING_SPACE
    param_names = search_space.keys()
    param_values = search_space.values()

    for trial, combo in enumerate(product(*param_values)):
        trial_params = dict(zip(param_names, combo))
        # ... train and evaluate ...
```

### Use Optuna for Bayesian optimization
```python
def tune_hyperparameters(...):
    import optuna

    def objective(trial):
        params = {
            'iterations': trial.suggest_int('iterations', 100, 1000),
            'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.1),
            'depth': trial.suggest_int('depth', 4, 20),
            'l2_leaf_reg': trial.suggest_float('l2_leaf_reg', 0.1, 10.0),
        }
        # ... train and evaluate ...
        return validation_r2

    study = optuna.create_study(direction='maximize')
    study.optimize(objective, n_trials=50)
    return study.best_params
```

---

## Troubleshooting

### Issue: Tuning takes too long
**Solutions**:
- Reduce `n_trials` (line 211): 20 → 10
- Reduce search space options
- Test on fewer inverters (`--limit 2`)
- Use faster model (set `USE_CATBOOST = False`)

### Issue: Out of memory during tuning
**Solutions**:
- Reduce `VALIDATION_SPLIT`: 0.2 → 0.1 or 0.05
- Reduce `MAX_WORKERS`: 4 → 2
- Reduce `max_depth` or `num_leaves` in search space
- Process fewer inverters in parallel

### Issue: Tuning finds bad parameters
**Solutions**:
- Increase `n_trials`: 20 → 50
- Narrow search space around known good values
- Check validation split is representative (increase to 0.2)
- Ensure enough training data (`MIN_TRAINING_SAMPLES`)

### Issue: Dashboard not showing new predictions
**Solutions**:
```bash
# Check JSON file timestamps
ls -lht public/data/digitaltwin/alpha1/*.json

# Verify training completed successfully
tail digital_twin_training.log

# Check JSON content
cat public/data/digitaltwin/alpha1/predictions.json | jq '.generatedAt'

# Hard refresh dashboard (Cmd+Shift+R / Ctrl+Shift+R)
```

---

## Configuration Reference

### Full parameter list

**CatBoost parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `iterations` | int | 200 | Number of boosting rounds |
| `learning_rate` | float | 0.1 | Step size for gradient descent |
| `depth` | int | 20 | Max tree depth |
| `l2_leaf_reg` | float | 0.1 | L2 regularization strength |
| `random_seed` | int | 42 | Random seed for reproducibility |
| `early_stopping_rounds` | int | 100 | Stop if no improvement |

**LightGBM parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `n_estimators` | int | 1000 | Number of boosting rounds |
| `learning_rate` | float | 0.05 | Step size for gradient descent |
| `num_leaves` | int | 31 | Max leaves per tree |
| `max_depth` | int | 6 | Max tree depth |
| `min_child_samples` | int | 20 | Min samples in leaf |

---

## Best Practices

1. **Start manual**: Use manual params until familiar with model behavior
2. **Test small**: Always use `--limit 5` for quick tests
3. **Tune selectively**: Only enable tuning when manual params plateau
4. **Monitor logs**: Watch for "Best hyperparameters" messages
5. **Compare results**: Always compare R² before/after parameter changes
6. **Document**: Note which parameters work well for future reference

---

**Last Updated**: 2025-01-27
**NuraVolt Version**: 0.2.0
