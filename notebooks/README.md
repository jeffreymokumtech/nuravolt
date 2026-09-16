# NuraVolt Crash-Course Notebooks

Two long, runnable Jupyter notebooks that double as a course on the platform.

| Notebook | Audience | What's in it |
|----------|----------|--------------|
| `bess_analytics_crash_course.ipynb`   | Solar-fluent, battery-newbie | 20 chapters: BESS foundations → SoH / cycling / warranty / thermal / RUL / arbitrage → standalone vs hybrid PV+BESS → compliance → competitive landscape (TWAICE, ACCURE, Volytica, etc.). Real OMIE prices, NREL PVDAQ, repo data. |
| `pv_dt_pm_crash_course.ipynb`         | Full beginner               | 32 chapters: PV foundations → soiling intelligence (5-layer stack, IEA Task 13 disaggregation, 365-day forecasting, ROI optimisation) → digital twins (hybrid physics-ML, plant-level factory, multi-signal) → fault detection + 7 RUL models + predictive maintenance → SHAP explainability → competitive landscape (Power Factors, GreenPowerMonitor, Raptor Maps, etc.). |

Both notebooks share conventions: clickable TOC, provenance blocks before every data cell, `💼 Business value` callouts per analytics chapter, Plotly figures with the NuraVolt house palette.

## Quick start

Pick **one** of the three paths below.

### Path A — Conda (recommended, matches the maintainer's env)

```bash
# from the repo root
conda env create -f notebooks/environment.yml
conda activate nuravolt-notebooks
pip install -e .                                # install the nuravolt package itself
python -m ipykernel install --user --name nuravolt-notebooks --display-name "NuraVolt Notebooks"
jupyter lab notebooks/
```

To **update** an existing env after deps change:
```bash
conda env update -f notebooks/environment.yml --prune
```

### Path B — Existing `nuravolt` conda env (the maintainer's setup)

If you already have a `nuravolt` env running the production code, that env already has every dep these notebooks need except `shap`:

```bash
conda activate nuravolt
pip install shap                                # the one missing piece
jupyter lab notebooks/
```

### Path C — Pure pip / venv (no conda)

```bash
# from the repo root
python -m venv .venv
source .venv/bin/activate                       # macOS / Linux
# .venv\Scripts\activate                        # Windows PowerShell

pip install -r notebooks/requirements.txt
pip install -e .                                # install the nuravolt package itself
python -m ipykernel install --user --name nuravolt-notebooks --display-name "NuraVolt Notebooks"
jupyter lab notebooks/
```

In JupyterLab, open either notebook and choose the **NuraVolt Notebooks** kernel from the kernel-picker.

## Headless smoke test

To prove either notebook runs cold:

```bash
jupyter nbconvert --to notebook --execute \
    notebooks/bess_analytics_crash_course.ipynb \
    --output _executed_test.ipynb \
    --ExecutePreprocessor.timeout=300

jupyter nbconvert --to notebook --execute \
    notebooks/pv_dt_pm_crash_course.ipynb \
    --output _executed_test.ipynb \
    --ExecutePreprocessor.timeout=420
```

Both should finish with no errors. The `_cache/` folder will collect any live-downloaded data (OMIE prices, etc.). Both `_cache/` and the `_executed_test.ipynb` artefact are already gitignored.

## What each dependency is for

| Package | Used by |
|---------|---------|
| `numpy`, `pandas`, `polars`, `pyarrow` | All data wrangling |
| `plotly` | All figures |
| `matplotlib`, `seaborn` | Fallbacks / consistency with the rest of the platform |
| `pvlib` | Clearsky / transposition / solar position (PV notebook Ch 5, 16) |
| `scipy` | NASA `.mat` parsing (BESS notebook Ch 5) |
| `scikit-learn` | Hybrid twin demo (PV Ch 18), fault classifier (PV Ch 24) |
| `lightgbm` | NuraVolt's SoH estimator, fault classifier, soiling models |
| `catboost` | The pre-trained soiling foundation model |
| `shap` | SHAP explainability cell (PV Ch 28) |
| `ipywidgets` | Three interactive explorers in the BESS notebook |
| `requests` | Live OMIE / NASA / mirror downloads (all gated by `try / except`) |
| `jupyter`, `jupyterlab`, `ipykernel`, `nbconvert`, `nbformat` | Notebook runtime + headless verification |

## Offline / no-network behaviour

Both notebooks are designed to fall back gracefully when network calls fail:

- BESS Ch 5.4 (NASA B0005) tries 3 GitHub mirrors → falls back to the synthetic surrogate.
- BESS Ch 13 (OMIE prices) tries the OMIE direct URL → falls back to an embedded recent week.
- PV Ch 14 (365-day forecast) loads the pipeline-produced JSON → falls back to a stylised synthetic shape.

You will see provenance blocks in either case, but the "Acquired" field changes between live and fallback.
