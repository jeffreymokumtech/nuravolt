"""
Train hierarchical digital twins for PV plants.

Usage:
    python scripts/train_hierarchical_twins.py ribera
    python scripts/train_hierarchical_twins.py alpha

Trains 4 twin types per inverter:
  1. Power AC (HybridPhysicsMLModel)
  2. Inverter Temperature (LightGBM + NOCT physics)
  3. MPPT Voltage (LightGBM per MPPT group)
  4. String Current (StringTwinFactory)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
import uuid
import warnings
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import polars as pl
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv optional; rely on the parent shell to export env vars

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger("train_hierarchical_twins")

# Cap OpenMP/MKL threads to avoid thrashing when looping over 120 inverters
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")

# Ensure project root is on path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from tqdm import tqdm

from nuravolt.digitaltwin.hybrid_model import HybridPhysicsMLModel, HybridModelConfig
from nuravolt.digitaltwin.normal_data_filter import NormalDataFilter, FilterConfig
from nuravolt.digitaltwin.string_factory import StringTwinFactory, StringFactoryConfig

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False
    print("WARNING: lightgbm not available — Temperature and MPPT twins will be skipped")

# ---------------------------------------------------------------------------
# Plant configuration
# ---------------------------------------------------------------------------

PLANTS = {
    "ribera": {
        "parquet": "backenddata/scada/ribera/ribera_cleaned.parquet",
        "prefix": "Ribera (ES):",
        "plant_id": "eb47ddda-0961-40b8-965a-80271b41e33f",  # Plant.id from DB
    },
    "alpha": {
        "parquet": "backenddata/scada/alpha/alpha_cleaned.parquet",
        "prefix": "Alpha (ES):",
        "plant_id": "ee0f71ae-b431-4956-8ace-fa535d263151",  # Plant.id from DB
    },
}

TIMESTAMP_FMT = "%Y.%m.%d %H:%M"
BLEND_WEIGHT = 0.9
TRAINING_DAYS = 365
TEST_DAYS = 365
NOCT = 45.0  # degrees C


# ---------------------------------------------------------------------------
# Column resolution helpers
# ---------------------------------------------------------------------------

def find_col(columns: List[str], *substrings: str) -> Optional[str]:
    """Return first column containing all substrings (case-sensitive)."""
    for c in columns:
        if all(s in c for s in substrings):
            return c
    return None


def find_cols(columns: List[str], *substrings: str) -> List[str]:
    """Return all columns containing all substrings."""
    return [c for c in columns if all(s in c for s in substrings)]


def get_plant_columns(df_cols: List[str], prefix: str, inv_id: str) -> Dict[str, Any]:
    """Resolve all relevant columns for a given inverter."""
    inv_tag = f"INV {inv_id}"
    return {
        "power_ac": find_col(df_cols, inv_tag, "P_AC"),
        "temperature": find_col(df_cols, inv_tag, "Temperature"),
        "irradiance": find_col(df_cols, prefix, "Plant", "Irradiation_average"),
        "ambient": find_col(df_cols, prefix, "Meteo", "Ambient"),
        "module_temp": find_col(df_cols, prefix, "Meteo", "Module"),
        "wind": find_col(df_cols, prefix, "Plant", "Wetter_Windgeschwindigkeit"),
        "input_currents": [c for c in df_cols if inv_tag in c and "Input_current_" in c],
        "udc_cols": sorted([c for c in df_cols if inv_tag in c and "U_DC_" in c
                            and "kW" not in c]),
    }


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_and_parse(parquet_path: str) -> pl.DataFrame:
    """Load parquet, parse timestamp, return sorted polars DataFrame."""
    df = pl.read_parquet(parquet_path)
    df = df.with_columns(
        pl.col("timestamp")
        .str.strptime(pl.Datetime, TIMESTAMP_FMT, strict=False)
        .alias("ts")
    ).drop_nulls(subset=["ts"]).sort("ts")
    return df


def split_training_test(df: pl.DataFrame) -> Tuple[pl.DataFrame, pl.DataFrame]:
    """Split first 12 months as training, everything after as prediction/test."""
    df = df.sort("ts")
    ts_min = df["ts"].min()
    train_end = ts_min + timedelta(days=TRAINING_DAYS)
    train = df.filter(pl.col("ts") < train_end)
    test = df.filter(pl.col("ts") >= train_end)  # ALL data after training
    return train, test


def to_pandas_inverter(
    df_pl: pl.DataFrame,
    cols: Dict[str, Any],
) -> pd.DataFrame:
    """Extract inverter-specific columns into a tidy pandas DataFrame."""
    select = ["ts"]
    rename = {}

    def add(col_name: Optional[str], alias: str):
        if col_name and col_name in df_pl.columns:
            select.append(col_name)
            rename[col_name] = alias

    add(cols["power_ac"], "power")
    add(cols["irradiance"], "irradiance")
    add(cols["temperature"], "temperature")
    add(cols["ambient"], "temp_ambient")
    add(cols["module_temp"], "temp_module")
    add(cols["wind"], "wind_speed")

    # Average string currents
    curr_cols = [c for c in cols["input_currents"] if c in df_pl.columns]
    udc_cols = [c for c in cols["udc_cols"] if c in df_pl.columns]

    sub = df_pl.select(select).rename(rename).sort("ts")
    pdf = sub.to_pandas().rename(columns={"ts": "timestamp"})
    pdf = pdf.set_index("timestamp").sort_index()

    # Add per-string currents + average
    if curr_cols:
        curr_df = df_pl.select(curr_cols).to_pandas()
        pdf["current_dc_avg"] = curr_df.mean(axis=1).values
        # Also add individual string currents: string_1_current, string_2_current, ...
        for i, cc in enumerate(sorted(curr_cols), 1):
            pdf[f"string_{i}_current"] = curr_df[cc].values

    # Add per-MPPT averaged voltages: groups of 2 (1+2 → MPPT-1, 3+4 → MPPT-2, ...)
    if udc_cols:
        # Sort numerically
        def udc_num(c: str) -> int:
            m = re.search(r"U_DC_(\d+)", c)
            return int(m.group(1)) if m else 99
        udc_sorted = sorted(udc_cols, key=udc_num)
        udc_pdf = df_pl.select(udc_sorted).to_pandas()
        for g in range(6):
            idx_a, idx_b = g * 2, g * 2 + 1
            if idx_b < len(udc_sorted):
                cols_pair = [udc_sorted[idx_a], udc_sorted[idx_b]]
                pdf[f"mppt_{g+1}_voltage"] = udc_pdf[cols_pair].mean(axis=1).values
            elif idx_a < len(udc_sorted):
                pdf[f"mppt_{g+1}_voltage"] = udc_pdf[udc_sorted[idx_a]].values

    # Cast all numeric columns, drop strings
    for c in pdf.columns:
        pdf[c] = pd.to_numeric(pdf[c], errors="coerce")

    return pdf


# ---------------------------------------------------------------------------
# Feature helpers
# ---------------------------------------------------------------------------

def add_time_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add cyclic time features: daily (hour) + annual (day-of-year, month).

    The annual cycle is essential for voltage and current twins — without it
    LightGBM has no explicit knob for the winter/summer Vmpp swing or for
    season-driven irradiance/soiling patterns and predictions come out flat
    across the year.
    """
    idx = df.index
    hour = idx.hour + idx.minute / 60.0
    df["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    # Annual cycle — day-of-year covers the smooth seasonal trend.
    doy = idx.dayofyear + hour / 24.0
    df["day_of_year_sin"] = np.sin(2 * np.pi * doy / 365.25)
    df["day_of_year_cos"] = np.cos(2 * np.pi * doy / 365.25)
    # Coarser month bucket — helpful for tree models that prefer step-like splits.
    month = idx.month
    df["month_sin"] = np.sin(2 * np.pi * month / 12.0)
    df["month_cos"] = np.cos(2 * np.pi * month / 12.0)
    return df


# Convenience tuple — every ML twin should add these to its feature_cols.
SEASONAL_FEATURES = (
    "hour_sin", "hour_cos",
    "day_of_year_sin", "day_of_year_cos",
    "month_sin", "month_cos",
)


def compute_t_cell(df: pd.DataFrame) -> pd.Series:
    """NOCT-based cell temperature: T_cell = T_amb + (NOCT-20)/800 * irr + 0.01 * P."""
    t_amb = df.get("temp_ambient", pd.Series(25.0, index=df.index))
    irr = df.get("irradiance", pd.Series(0.0, index=df.index)).clip(lower=0)
    power = df.get("power", pd.Series(0.0, index=df.index)).clip(lower=0)
    return t_amb + (NOCT - 20) / 800.0 * irr + 0.01 * power


def lgb_train(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    feature_names: List[str],
    n_estimators: int = 400,
) -> Tuple[Any, Dict[str, float]]:
    """Train a LightGBM regressor and return model + metrics."""
    params = {
        "n_estimators": n_estimators,
        "learning_rate": 0.05,
        "num_leaves": 63,
        "min_child_samples": 20,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_alpha": 0.1,
        "reg_lambda": 0.1,
        "n_jobs": 4,  # Cap threads — avoid OMP thrashing across 120 inverters
        "verbose": -1,
    }
    model = lgb.LGBMRegressor(**params)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(period=-1)],
    )
    preds = model.predict(X_val)
    ss_res = np.sum((y_val - preds) ** 2)
    ss_tot = np.sum((y_val - y_val.mean()) ** 2)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    mae = float(np.mean(np.abs(y_val - preds)))
    fi = dict(zip(feature_names, model.feature_importances_.tolist()))
    return model, {"r2": float(r2), "mae": mae, "feature_importance": fi}


# ---------------------------------------------------------------------------
# Twin 1: Power AC (HybridPhysicsMLModel)
# ---------------------------------------------------------------------------

def train_power_twin(
    train_pdf: pd.DataFrame,
    inv_id: str,
) -> Tuple[Optional[HybridPhysicsMLModel], Optional[Dict], str]:
    """Train power AC twin. Returns (model, metrics, error_msg)."""
    try:
        # Filter: need power + irradiance
        needed = ["power", "irradiance"]
        for c in needed:
            if c not in train_pdf.columns:
                return None, None, f"Missing column: {c}"

        # Rated power: SUN 2000-60 KTL = 60 kW AC. Fallback to data estimate if no power col.
        p_rated = 60.0
        if "power" in train_pdf.columns:
            hi = train_pdf[train_pdf.get("irradiance", pd.Series(0)) > 600]
            if len(hi) > 10:
                # Use 95th pct if plausible, otherwise keep the nameplate
                est = float(hi["power"].quantile(0.95))
                if 30.0 <= est <= 80.0:
                    p_rated = est

        # Normal data filter with relaxed config + p_rated
        fconfig = FilterConfig(pr_min=0.2, pr_max=1.5, pr_sigma=3.0, outlier_iterations=1)
        ndf = NormalDataFilter(config=fconfig, p_rated=p_rated)
        result = ndf.select_normal_training_data(
            train_pdf,
            irradiance_col="irradiance",
            power_col="power",
            temperature_col="temperature" if "temperature" in train_pdf.columns else None,
            apply_variability=False,
            apply_clustering=False,
        )
        filtered = train_pdf[result.mask].copy()

        if len(filtered) < 200:
            return None, None, f"Insufficient normal data: {len(filtered)} rows"

        wind_col = "wind_speed" if "wind_speed" in filtered.columns else None

        lgb_params = {
            "objective": "regression",
            "metric": "rmse",
            "learning_rate": 0.05,
            "num_leaves": 31,
            "max_depth": 6,
            "n_estimators": 500,
            "early_stopping_rounds": 50,
            "verbose": -1,
            "random_state": 42,
            "n_jobs": 4,  # Cap threads — avoid OMP thrashing across 120 inverters
        }
        config = HybridModelConfig(
            use_catboost=False,  # use LightGBM for speed
            lightgbm_params=lgb_params,
            validation_split=0.2,
            min_training_samples=100,
        )
        model = HybridPhysicsMLModel(inverter_id=inv_id, config=config)
        metrics = model.train(
            filtered,
            power_col="power",
            irradiance_col="irradiance",
            temperature_col="temperature",
            wind_col=wind_col,
        )
        return model, {
            "r2": metrics.r2,
            "mae": metrics.mae,
            "physics_r2": metrics.physics_r2,
            "training_samples": metrics.training_samples,
        }, ""
    except Exception as e:
        return None, None, str(e)


# ---------------------------------------------------------------------------
# Twin 2: Inverter Temperature (LightGBM + NOCT physics)
# ---------------------------------------------------------------------------

def train_temperature_twin(
    train_pdf: pd.DataFrame,
    inv_id: str,
) -> Tuple[Optional[Any], Optional[Dict], str]:
    """Train inverter temperature twin with LightGBM."""
    if not HAS_LGB:
        return None, None, "lightgbm not available"
    try:
        needed = ["temperature", "irradiance", "temp_ambient"]
        missing = [c for c in needed if c not in train_pdf.columns]
        if missing:
            return None, None, f"Missing columns: {missing}"

        df = train_pdf.copy()
        df = add_time_features(df)
        df["t_cell_physics"] = compute_t_cell(df)

        feature_cols = [c for c in [
            "temp_ambient", "irradiance", "wind_speed", "power",
            "t_cell_physics", *SEASONAL_FEATURES,
        ] if c in df.columns]

        # Drop rows with NaN in target or features
        use_cols = feature_cols + ["temperature"]
        df_clean = df[use_cols].dropna()

        if len(df_clean) < 200:
            return None, None, f"Insufficient data after dropna: {len(df_clean)}"

        # Daytime only (irradiance > 20 W/m²)
        if "irradiance" in df_clean.columns:
            df_clean = df_clean[df_clean["irradiance"] > 20]

        if len(df_clean) < 200:
            return None, None, f"Insufficient daytime data: {len(df_clean)}"

        n_val = max(100, int(len(df_clean) * 0.2))
        df_train = df_clean.iloc[:-n_val]
        df_val = df_clean.iloc[-n_val:]

        X_tr = df_train[feature_cols].values
        y_tr = df_train["temperature"].values
        X_val = df_val[feature_cols].values
        y_val = df_val["temperature"].values

        model, metrics = lgb_train(X_tr, y_tr, X_val, y_val, feature_cols)
        metrics["training_samples"] = len(df_train)
        metrics["feature_cols"] = feature_cols

        return model, metrics, ""
    except Exception as e:
        return None, None, str(e)


# ---------------------------------------------------------------------------
# Twin 3: MPPT Voltage (LightGBM per MPPT group)
# ---------------------------------------------------------------------------

def train_mppt_twins(
    train_pdf: pd.DataFrame,
    inv_id: str,
) -> Dict[str, Tuple[Optional[Any], Optional[Dict], str]]:
    """Train one LightGBM per MPPT group (up to 6). Returns dict keyed by MPPT-N."""
    results = {}
    if not HAS_LGB:
        for g in range(1, 7):
            results[f"MPPT-{g}"] = (None, None, "lightgbm not available")
        return results

    df = train_pdf.copy()
    df = add_time_features(df)
    df["t_cell_physics"] = compute_t_cell(df)

    for g in range(1, 7):
        mppt_col = f"mppt_{g}_voltage"
        if mppt_col not in df.columns:
            continue
        try:
            # Physics baseline: V = Vmpp(25°C) * (1 - 0.003 * (T_cell - 25))
            # We predict the MPPT *operating* voltage (Vmpp), not Voc. An actively
            # tracking MPPT sits at ~0.75-0.85 of Voc, so observations here must
            # be filtered to "actively producing" rows — otherwise idle-state
            # samples at Voc bias the estimate 2× upward (observed in ribera
            # training v9 where voc_est ≈ 620 V vs actual Vmpp ≈ 330 V).
            t_cell = df["t_cell_physics"]
            irr_series = df.get("irradiance", pd.Series(0, index=df.index))
            # "Actively tracking" = above-threshold irradiance AND meaningful current.
            curr_series = df.get("current_dc_avg", pd.Series(0, index=df.index))
            operating = (irr_series > 600) & (curr_series > 1.0)
            if operating.sum() > 50:
                v_obs = df.loc[operating, mppt_col]
                t_obs = t_cell[operating]
                # Vmpp at STC = V_observed / (1 - 0.003*(T-25))
                vmpp_per_row = v_obs / (1 - 0.003 * (t_obs - 25)).clip(lower=0.5)
                # Use median to be robust to outliers (curtailment, transients)
                vmpp_est = float(vmpp_per_row.median())
            else:
                # Fallback: high-irradiance median (may include Voc samples; degraded but finite)
                high_irr = irr_series > 600
                if high_irr.sum() > 50:
                    vmpp_est = float(df.loc[high_irr, mppt_col].median())
                else:
                    vmpp_est = float(df[mppt_col].quantile(0.5))

            df[f"v_physics_{g}"] = vmpp_est * (1 - 0.003 * (t_cell - 25))

            feature_cols = [c for c in [
                "irradiance", "temp_module", "t_cell_physics",
                f"v_physics_{g}", "current_dc_avg",
                *SEASONAL_FEATURES,
            ] if c in df.columns]

            use_cols = feature_cols + [mppt_col]
            df_clean = df[use_cols].dropna()

            # Daytime only
            if "irradiance" in df_clean.columns:
                df_clean = df_clean[df_clean["irradiance"] > 20]

            if len(df_clean) < 200:
                results[f"MPPT-{g}"] = (None, None, f"Insufficient data: {len(df_clean)}")
                continue

            n_val = max(100, int(len(df_clean) * 0.2))
            df_tr = df_clean.iloc[:-n_val]
            df_vl = df_clean.iloc[-n_val:]

            model, metrics = lgb_train(
                df_tr[feature_cols].values, df_tr[mppt_col].values,
                df_vl[feature_cols].values, df_vl[mppt_col].values,
                feature_cols,
            )
            metrics["training_samples"] = len(df_tr)
            # Keep the key name "voc_estimate" for backward compatibility with the
            # downstream `make_predictions_mppt(..., voc_est)` signature — the
            # *variable* we compute above is now Vmpp, not Voc, but the prediction
            # code just needs the per-MPPT scale factor either way.
            metrics["voc_estimate"] = vmpp_est
            metrics["feature_cols"] = feature_cols

            results[f"MPPT-{g}"] = (model, metrics, "")
        except Exception as e:
            results[f"MPPT-{g}"] = (None, None, str(e))

    return results


# ---------------------------------------------------------------------------
# Twin 4: String Current (StringTwinFactory)
# ---------------------------------------------------------------------------

def train_string_twins(
    train_pl: pl.DataFrame,
    inv_id: str,
) -> Dict[str, Any]:
    """Train string current twins using StringTwinFactory.

    StringTwinFactory uses underscore format internally: INV_XX.XXX
    We pass the normalized form so it matches the column-parsing regex.
    """
    try:
        config = StringFactoryConfig(
            max_years=99,
            min_training_samples=500,
            save_models=False,
            save_residuals=False,
            save_json=False,
            verbose=False,
            max_workers=1,  # Sequential — avoids multiprocessing overhead per inverter
        )
        factory = StringTwinFactory(config=config)
        # Factory expects "INV_XX.XXX" format (underscore, no space)
        inv_id_factory = f"INV_{inv_id}"
        results = factory.create_all_twins(train_pl, inverter_ids=[inv_id_factory])
        return results
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Prediction helpers
# ---------------------------------------------------------------------------

def make_predictions_power(
    model: HybridPhysicsMLModel,
    test_pdf: pd.DataFrame,
) -> pd.DataFrame:
    """Generate power predictions from HybridPhysicsMLModel."""
    wind_col = "wind_speed" if "wind_speed" in test_pdf.columns else None
    preds = model.predict(
        test_pdf,
        irradiance_col="irradiance",
        temperature_col="temperature",
        wind_col=wind_col,
    )
    out = pd.DataFrame(index=test_pdf.index)
    out["power_ac_predicted"] = preds
    out["power_ac_actual"] = test_pdf.get("power", np.nan)
    out["power_ac_residual"] = out["power_ac_actual"] - out["power_ac_predicted"]
    return out


def make_predictions_temperature(
    model: Any,
    test_pdf: pd.DataFrame,
    feature_cols: List[str],
) -> pd.DataFrame:
    """Generate temperature predictions from LightGBM model."""
    df = test_pdf.copy()
    df = add_time_features(df)
    df["t_cell_physics"] = compute_t_cell(df)
    X = df[feature_cols].values
    preds = model.predict(X)
    out = pd.DataFrame(index=test_pdf.index)
    out["temperature_predicted"] = preds
    out["temperature_actual"] = test_pdf.get("temperature", np.nan)
    out["temperature_residual"] = out["temperature_actual"] - out["temperature_predicted"]
    return out


# ---------------------------------------------------------------------------
# Twin 4: String current (hybrid LightGBM + irradiance×I_ref baseline)
# ---------------------------------------------------------------------------

def train_string_current_twin(
    train_pdf: pd.DataFrame,
    str_col: str,
) -> Tuple[Optional[Any], Dict[str, Any], List[str], float, str]:
    """Train hybrid LightGBM model for one string current.

    Returns: (model, metrics, feature_cols, i_ref, error_msg)
    The physics baseline (irradiance / 1000) * i_ref is fed in as a feature so
    LightGBM only has to learn the residual (soiling drift, per-string skew,
    seasonality, temperature derate). The same predicted-≥-actual quality
    guard runs on the final output downstream.
    """
    if not HAS_LGB:
        return None, {}, [], 8.0, "lightgbm not available"
    try:
        if str_col not in train_pdf.columns or "irradiance" not in train_pdf.columns:
            return None, {}, [], 8.0, f"missing {str_col} or irradiance"

        df = train_pdf.copy()
        df = add_time_features(df)
        df["t_cell_physics"] = compute_t_cell(df)

        # Estimate I_ref from the cleanest portion of the training period.
        irr = df["irradiance"].values
        cur = df[str_col].values
        mask = (irr > 800) & np.isfinite(irr) & np.isfinite(cur) & (cur > 0.5)
        i_ref = 8.0
        if mask.sum() > 50:
            val = float(np.nanquantile(cur[mask], 0.9))
            if np.isfinite(val) and 3.0 <= val <= 15.0:
                i_ref = val
        df["i_physics"] = (df["irradiance"].clip(lower=0) / 1000.0) * i_ref

        feature_cols = [c for c in [
            "irradiance", "temp_module", "t_cell_physics", "i_physics",
            *SEASONAL_FEATURES,
        ] if c in df.columns]

        use_cols = feature_cols + [str_col]
        df_clean = df[use_cols].dropna()
        # Daytime only — no point fitting on dark-of-night zeros.
        df_clean = df_clean[df_clean["irradiance"] > 20]
        if len(df_clean) < 200:
            return None, {}, feature_cols, i_ref, f"insufficient data: {len(df_clean)}"

        n_val = max(100, int(len(df_clean) * 0.2))
        df_tr = df_clean.iloc[:-n_val]
        df_vl = df_clean.iloc[-n_val:]

        model, metrics = lgb_train(
            df_tr[feature_cols].values, df_tr[str_col].values,
            df_vl[feature_cols].values, df_vl[str_col].values,
            feature_cols,
        )
        metrics["training_samples"] = len(df_tr)
        metrics["i_ref"] = i_ref
        return model, metrics, feature_cols, i_ref, ""
    except Exception as e:
        return None, {}, [], 8.0, str(e)


def make_predictions_string_current(
    model: Any,
    test_pdf: pd.DataFrame,
    feature_cols: List[str],
    str_col: str,
    i_ref: float,
) -> pd.DataFrame:
    """Generate hybrid string-current predictions for the test window."""
    df = test_pdf.copy()
    df = add_time_features(df)
    df["t_cell_physics"] = compute_t_cell(df)
    df["i_physics"] = (df.get("irradiance", pd.Series(0.0, index=df.index)).clip(lower=0) / 1000.0) * i_ref
    X = df[feature_cols].values
    preds = model.predict(X)
    out = pd.DataFrame(index=test_pdf.index)
    out["current_dc_predicted"] = np.clip(preds, 0.0, None)
    out["current_dc_actual"] = test_pdf.get(str_col, np.nan).clip(lower=0)
    out["current_dc_residual"] = out["current_dc_actual"] - out["current_dc_predicted"]
    return out


def make_predictions_mppt(
    model: Any,
    test_pdf: pd.DataFrame,
    feature_cols: List[str],
    mppt_num: int,
    voc_est: float,
) -> pd.DataFrame:
    """Generate MPPT voltage predictions."""
    mppt_col = f"mppt_{mppt_num}_voltage"
    df = test_pdf.copy()
    df = add_time_features(df)
    df["t_cell_physics"] = compute_t_cell(df)
    df[f"v_physics_{mppt_num}"] = voc_est * (1 - 0.003 * (df["t_cell_physics"] - 25))
    X = df[feature_cols].values
    preds = model.predict(X)
    out = pd.DataFrame(index=test_pdf.index)
    out[f"mppt_{mppt_num}_voltage_predicted"] = preds
    out[f"mppt_{mppt_num}_voltage_actual"] = test_pdf.get(mppt_col, np.nan)
    out[f"mppt_{mppt_num}_voltage_residual"] = (
        out[f"mppt_{mppt_num}_voltage_actual"] - out[f"mppt_{mppt_num}_voltage_predicted"]
    )
    return out


# ---------------------------------------------------------------------------
# Output helpers — Tiered Storage (Parquet raw + PG aggregates)
# ---------------------------------------------------------------------------

TWINS_DIR = PROJECT_ROOT / "backenddata" / "twins"


def write_parquet_outputs(
    power_preds: Dict[str, pd.DataFrame],
    temp_preds: Dict[str, pd.DataFrame],
    mppt_preds: Dict[str, pd.DataFrame],
    string_preds: Dict[str, pd.DataFrame],
    plant_id: str,
):
    """Write full per-device hourly predictions to Parquet files.

    Each twin type gets its own Parquet file with columns:
      time, device_id, predicted, actual, residual
    Resampled to 1H for manageable file sizes (~50-100 MB per type).
    """
    out_dir = TWINS_DIR / plant_id
    out_dir.mkdir(parents=True, exist_ok=True)

    for twin_type, preds_dict in [
        ("power", power_preds),
        ("temperature", temp_preds),
        ("mppt_voltage", mppt_preds),
        ("string_current", string_preds),
    ]:
        if not preds_dict:
            continue
        rows = []
        for device_id, df in preds_dict.items():
            hourly = df.resample("1h").mean()
            for ts, row in hourly.iterrows():
                for col_name, val in row.items():
                    if pd.isna(val):
                        continue
                    rows.append({
                        "time": ts,
                        "device_id": device_id,
                        "metric": str(col_name),
                        "value": float(val),
                    })
        if rows:
            pq_df = pd.DataFrame(rows)
            path = out_dir / f"{twin_type}_hourly.parquet"
            pq_df.to_parquet(str(path), engine="pyarrow", compression="zstd", index=False)
            print(f"  Parquet: {path.name} — {len(pq_df):,} rows ({path.stat().st_size / 1e6:.1f} MB)")


def _enforce_predicted_ge_actual(df: pd.DataFrame, metric_base: str) -> pd.DataFrame:
    """Ensure predicted ≥ actual (twin represents IDEAL baseline; actual has losses).

    If predicted is systematically below actual (common when training data had soiling
    or model underfit), scale up predicted so that mean(predicted) ≥ mean(actual).
    Residual is recomputed. This is applied per-device before aggregation.
    """
    pred_col = f"{metric_base}_predicted"
    act_col = f"{metric_base}_actual"
    res_col = f"{metric_base}_residual"
    if pred_col not in df.columns or act_col not in df.columns:
        return df
    # Only consider daylight / active samples (actual > small threshold)
    active = df[act_col] > max(df[act_col].max() * 0.05, 0.1)
    if active.sum() < 30:
        return df
    mean_pred = df.loc[active, pred_col].mean(skipna=True)
    mean_act = df.loc[active, act_col].mean(skipna=True)
    if not (np.isfinite(mean_pred) and np.isfinite(mean_act)) or mean_pred <= 0:
        return df
    if mean_pred < mean_act * 0.95:
        # Scale predicted up to be ~5% above actual on average
        scale = (mean_act * 1.05) / mean_pred
        df = df.copy()
        df[pred_col] = df[pred_col] * scale
        df[res_col] = df[act_col] - df[pred_col]
    return df


def build_db_aggregates(
    power_preds: Dict[str, pd.DataFrame],
    temp_preds: Dict[str, pd.DataFrame],
    mppt_preds: Dict[str, pd.DataFrame],
    string_preds: Dict[str, pd.DataFrame],
    r2_map: Dict[str, float],
) -> List[Dict]:
    """Build pre-aggregated DB records — only what the UI needs.

    Before aggregation, enforces predicted ≥ actual per device (twin = ideal baseline).

    1. Plant-level hourly power (SUM across inverters)
    2. Per-inverter daily power (AVG per inverter)
    3. Per-inverter daily temperature (AVG per inverter)
    4. Per-inverter daily voltage (MEAN across MPPTs → inverter level)
    5. Per-inverter daily current (SUM across strings → inverter level)

    Returns list of dicts ready for TimeseriesWriter.write_analysis_results().
    """
    records: List[Dict] = []
    avg_r2 = np.mean(list(r2_map.values())) if r2_map else 0.0

    # Apply predicted ≥ actual correction per device (before aggregation).
    # Twin represents IDEAL baseline — actual should be ≤ predicted (losses, soiling).
    # Applied only to power and current (voltage can go either way due to temp coefficient;
    # temperature twin is not an "ideal" baseline).
    power_preds = {d: _enforce_predicted_ge_actual(df, "power_ac") for d, df in power_preds.items()}
    string_preds = {d: _enforce_predicted_ge_actual(df, "current_dc") for d, df in string_preds.items()}

    # === POWER: Plant-level hourly + per-inverter daily ===
    if power_preds:
        all_hourly: List[pd.DataFrame] = []
        for device_id, df in power_preds.items():
            hourly = df.resample("1h").mean().copy()
            hourly["device_id"] = device_id
            all_hourly.append(hourly)

        if all_hourly:
            combined = pd.concat(all_hourly)

            # Plant-level hourly (SUM across inverters)
            plant_hourly = combined.groupby(combined.index)[
                ["power_ac_predicted", "power_ac_actual", "power_ac_residual"]
            ].sum()
            for ts, row in plant_hourly.iterrows():
                for m in ["power_ac_predicted", "power_ac_actual", "power_ac_residual"]:
                    v = row.get(m, np.nan)
                    if pd.isna(v): continue
                    records.append({"time": ts.to_pydatetime(), "device_id": "PLANT", "metric": m,
                                    "value": float(v), "confidence": float(avg_r2),
                                    "metadata": {"aggregation": "plant_hourly_sum"}})

            # Per-inverter daily power
            combined["date"] = combined.index.date
            inv_daily = combined.groupby(["device_id", "date"])[
                ["power_ac_predicted", "power_ac_actual", "power_ac_residual"]
            ].mean()
            for (dev_id, date_val), row in inv_daily.iterrows():
                r2 = r2_map.get(dev_id, avg_r2)
                ts = pd.Timestamp(date_val)
                for m in ["power_ac_predicted", "power_ac_actual", "power_ac_residual"]:
                    v = row.get(m, np.nan)
                    if pd.isna(v): continue
                    records.append({"time": ts.to_pydatetime(), "device_id": dev_id, "metric": m,
                                    "value": float(v), "confidence": float(r2),
                                    "metadata": {"aggregation": "inverter_daily_avg"}})

    # === TEMPERATURE: Per-inverter daily ===
    if temp_preds:
        for device_id, df in temp_preds.items():
            daily = df.resample("1D").mean()
            for ts, row in daily.iterrows():
                for col in row.index:
                    v = row[col]
                    if pd.isna(v): continue
                    records.append({"time": ts.to_pydatetime(), "device_id": device_id,
                                    "metric": str(col), "value": float(v), "confidence": 0.0,
                                    "metadata": {"aggregation": "inverter_daily_avg"}})

    # === VOLTAGE: Mean across MPPTs → per-inverter daily ===
    if mppt_preds:
        # Group by parent inverter: "INV 01.032.MPPT-1" → "INV 01.032"
        inv_voltage_frames: Dict[str, List[pd.DataFrame]] = {}
        for mppt_device, df in mppt_preds.items():
            inv_id = mppt_device.rsplit(".", 1)[0]  # "INV 01.032"
            # Rename MPPT-specific columns to generic voltage columns
            renamed = pd.DataFrame(index=df.index)
            for col in df.columns:
                if "predicted" in col:
                    renamed["voltage_dc_predicted"] = df[col]
                elif "actual" in col:
                    renamed["voltage_dc_actual"] = df[col]
                elif "residual" in col:
                    renamed["voltage_dc_residual"] = df[col]
            if not renamed.empty:
                inv_voltage_frames.setdefault(inv_id, []).append(renamed)

        for inv_id, frames in inv_voltage_frames.items():
            # Mean across all MPPTs for this inverter
            combined_v = pd.concat(frames).groupby(level=0).mean()
            daily_v = combined_v.resample("1D").mean()
            for ts, row in daily_v.iterrows():
                for m in ["voltage_dc_predicted", "voltage_dc_actual", "voltage_dc_residual"]:
                    v = row.get(m, np.nan)
                    if pd.isna(v): continue
                    records.append({"time": ts.to_pydatetime(), "device_id": inv_id,
                                    "metric": m, "value": float(v), "confidence": 0.0,
                                    "metadata": {"aggregation": "inverter_daily_mppt_mean"}})

    # === CURRENT: Sum across strings → per-inverter daily ===
    if string_preds:
        inv_current_frames: Dict[str, List[pd.DataFrame]] = {}
        for str_device, df in string_preds.items():
            # "INV 01.032.string_1" or "INV 01.032.STR-1" → "INV 01.032"
            parts = str_device.split(".")
            inv_id = f"{parts[0]}.{parts[1]}" if len(parts) >= 3 else str_device
            inv_current_frames.setdefault(inv_id, []).append(df)

        for inv_id, frames in inv_current_frames.items():
            # Sum across strings per timestamp (total DC current into inverter)
            combined_c = pd.concat(frames).groupby(level=0).sum()
            daily_c = combined_c.resample("1D").mean()
            for ts, row in daily_c.iterrows():
                for m in ["current_dc_predicted", "current_dc_actual", "current_dc_residual"]:
                    v = row.get(m, np.nan)
                    if pd.isna(v):
                        continue
                    records.append({"time": ts.to_pydatetime(), "device_id": inv_id,
                                    "metric": m, "value": float(v), "confidence": 0.0,
                                    "metadata": {"aggregation": "inverter_daily_string_sum"}})

    return records


# ---------------------------------------------------------------------------
# Summary JSON
# ---------------------------------------------------------------------------

def save_summary(plant_id: str, summary: Dict):
    """Save training summary JSON."""
    out_dir = PROJECT_ROOT / "public" / "data" / "digitaltwin" / plant_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "training_summary_v2.json"
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"\nSummary written to {out_path}")


# ---------------------------------------------------------------------------
# Main training loop
# ---------------------------------------------------------------------------

def train_plant(plant_name: str):
    cfg = PLANTS[plant_name]
    parquet_path = str(PROJECT_ROOT / cfg["parquet"])
    plant_id = cfg["plant_id"]
    prefix = cfg["prefix"]

    print(f"\n{'='*60}")
    print(f"Training hierarchical twins for: {plant_name.upper()}")
    print(f"{'='*60}")

    # Load data
    print("Loading parquet data...")
    t0 = time.time()
    df_pl = load_and_parse(parquet_path)
    print(f"  Loaded {len(df_pl):,} rows x {len(df_pl.columns)} columns in {time.time()-t0:.1f}s")

    # Split
    train_pl, test_pl = split_training_test(df_pl)
    print(f"  Training period: {train_pl['ts'].min()} → {train_pl['ts'].max()} ({len(train_pl):,} rows)")
    print(f"  Test period:     {test_pl['ts'].min()} → {test_pl['ts'].max()} ({len(test_pl):,} rows)")

    # Discover inverter IDs
    pac_cols = [c for c in df_pl.columns if "P_AC" in c and "INV" in c]
    inv_ids = sorted(set(
        re.search(r"INV (\d+\.\d+)", c).group(1)
        for c in pac_cols
        if re.search(r"INV (\d+\.\d+)", c)
    ))
    print(f"  Found {len(inv_ids)} inverters")

    # DB writer setup
    db_url = os.environ.get("DATABASE_URL", "")
    db_writer = None
    if db_url:
        try:
            from nuravolt.db.writer import TimeseriesWriter
            db_writer = TimeseriesWriter(dsn=db_url)
            # analysis_results is a compressed TimescaleDB hypertable.
            # 1) Raise the session-level decompression limit so the writer can
            #    touch compressed chunks without tripping the default cap.
            # 2) Wipe the plant's existing digitaltwin rows up-front so the
            #    downstream INSERT has no conflicts to UPDATE against — a plain
            #    INSERT into a compressed chunk is supported, UPDATE is not.
            with db_writer.conn.cursor() as _cur:
                # analysis_results is a compressed TimescaleDB hypertable.
                # Raise the per-DML decompression limit (default 100k) so we
                # can DELETE + INSERT across multiple compressed chunks in one
                # go. The writer will auto-decompress affected chunks on demand.
                _cur.execute("SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0;")
                # Wipe stale rows for this plant so the subsequent INSERT has
                # no conflicts to UPDATE against (plain INSERT into a
                # compressed chunk works; UPDATE does not).
                _cur.execute(
                    "DELETE FROM analysis_results WHERE plant_id = %s::uuid AND domain = 'digitaltwin';",
                    (plant_id,),
                )
                deleted = _cur.rowcount
                db_writer.conn.commit()
                print(f"  DB writer connected · wiped {deleted:,} stale digitaltwin rows for {plant_name}")
        except Exception as e:
            print(f"  WARNING: DB writer failed: {e} — will skip DB writes")
            db_writer = None
    else:
        print("  WARNING: DATABASE_URL not set — DB writes will be skipped")

    run_id = str(uuid.uuid4())
    model_version = "hybrid_v2"

    # Counters
    stats = {
        "total_inverters": len(inv_ids),
        "power_trained": 0, "power_failed": 0,
        "temp_trained": 0, "temp_failed": 0,
        "mppt_trained": 0, "mppt_failed": 0,
        "string_trained": 0, "string_failed": 0,
        "db_rows_written": 0,
        "inverter_details": {},
    }

    # Accumulate per-device prediction DataFrames for Parquet + aggregation
    power_preds: Dict[str, pd.DataFrame] = {}   # device_id → pred DataFrame
    temp_preds: Dict[str, pd.DataFrame] = {}
    mppt_preds: Dict[str, pd.DataFrame] = {}
    string_preds: Dict[str, pd.DataFrame] = {}  # device_id → pred DataFrame (current)
    power_r2_map: Dict[str, float] = {}          # device_id → R²

    for i_idx, inv_id in enumerate(tqdm(inv_ids, desc="Inverters", ncols=80)):
        inv_stats = {
            "power": {"status": "skipped", "r2": None},
            "temperature": {"status": "skipped", "r2": None},
            "mppt": {},
            "strings": {},
        }

        cols = get_plant_columns(df_pl.columns, prefix, inv_id)

        # Build pandas DataFrames
        try:
            train_pdf = to_pandas_inverter(train_pl, cols)
            test_pdf = to_pandas_inverter(test_pl, cols)
        except Exception as e:
            tqdm.write(f"  [{inv_id}] Data extraction failed: {e}")
            stats["power_failed"] += 1
            continue

        device_inv = f"INV {inv_id}"
        base_meta = {"blend_weight": BLEND_WEIGHT, "training_days": TRAINING_DAYS}

        # --- Twin 1: Power AC ---
        try:
            model_p, metrics_p, err_p = train_power_twin(train_pdf, inv_id)
            if model_p is not None:
                stats["power_trained"] += 1
                inv_stats["power"] = {"status": "ok", "r2": round(metrics_p["r2"], 4)}

                # Predictions on test set
                if "power" in test_pdf.columns and "irradiance" in test_pdf.columns:
                    pred_df = make_predictions_power(model_p, test_pdf)
                    power_preds[device_inv] = pred_df
                    power_r2_map[device_inv] = metrics_p["r2"]
            else:
                stats["power_failed"] += 1
                inv_stats["power"] = {"status": "failed", "error": err_p}
                tqdm.write(f"  [{inv_id}] Power twin failed: {err_p}")
        except Exception as e:
            stats["power_failed"] += 1
            inv_stats["power"] = {"status": "error", "error": str(e)}
            tqdm.write(f"  [{inv_id}] Power twin error: {e}")

        # --- Twin 2: Inverter Temperature ---
        try:
            model_t, metrics_t, err_t = train_temperature_twin(train_pdf, inv_id)
            if model_t is not None:
                stats["temp_trained"] += 1
                inv_stats["temperature"] = {"status": "ok", "r2": round(metrics_t["r2"], 4)}

                if "temperature" in test_pdf.columns:
                    feat_cols = metrics_t["feature_cols"]
                    pred_df_t = make_predictions_temperature(model_t, test_pdf, feat_cols)
                    temp_preds[device_inv] = pred_df_t
            else:
                stats["temp_failed"] += 1
                inv_stats["temperature"] = {"status": "failed", "error": err_t}
        except Exception as e:
            stats["temp_failed"] += 1
            inv_stats["temperature"] = {"status": "error", "error": str(e)}
            tqdm.write(f"  [{inv_id}] Temp twin error: {e}")

        # --- Twin 3: MPPT Voltage ---
        try:
            mppt_results = train_mppt_twins(train_pdf, inv_id)
            for mppt_name, (m_mppt, met_mppt, err_mppt) in mppt_results.items():
                mppt_num = int(mppt_name.split("-")[1])
                if m_mppt is not None:
                    stats["mppt_trained"] += 1
                    inv_stats["mppt"][mppt_name] = {"status": "ok", "r2": round(met_mppt["r2"], 4)}
                    device_mppt = f"INV {inv_id}.{mppt_name}"
                    feat_cols_m = met_mppt["feature_cols"]
                    voc_est = met_mppt.get("voc_estimate", 500.0)
                    pred_df_m = make_predictions_mppt(
                        m_mppt, test_pdf, feat_cols_m, mppt_num, voc_est
                    )
                    mppt_preds[device_mppt] = pred_df_m
                else:
                    stats["mppt_failed"] += 1
                    inv_stats["mppt"][mppt_name] = {"status": "failed", "error": err_mppt}
        except Exception as e:
            stats["mppt_failed"] += 1
            tqdm.write(f"  [{inv_id}] MPPT twin error: {e}")

        # --- Twin 4: String Current (hybrid LightGBM + irradiance baseline) ---
        # ML residual on top of (irradiance/1000)*I_ref so the model captures
        # soiling drift, per-string skew, seasonality and temperature derate
        # rather than just irradiance scaling.
        try:
            str_current_cols = [c for c in test_pdf.columns if c.startswith("string_") and c.endswith("_current")]
            for sc in str_current_cols:
                str_num = sc.replace("string_", "").replace("_current", "")
                device_str = f"INV {inv_id}.STR-{str_num}"

                model_s, m_metrics, s_features, i_ref, err = train_string_current_twin(train_pdf, sc)
                if model_s is None:
                    stats["string_failed"] += 1
                    inv_stats["strings"][device_str] = {"status": "failed", "error": err}
                    # Physics-only fallback so we always have a series to plot.
                    irr = test_pdf.get("irradiance", pd.Series(0.0, index=test_pdf.index))
                    actual = test_pdf[sc].clip(lower=0)
                    predicted = (irr.clip(lower=0) / 1000.0) * i_ref
                    pdf_str = pd.DataFrame({
                        "current_dc_predicted": predicted.values,
                        "current_dc_actual": actual.values,
                        "current_dc_residual": (actual - predicted).values,
                    }, index=test_pdf.index)
                else:
                    stats["string_trained"] += 1
                    inv_stats["strings"][device_str] = {
                        "status": "ok",
                        "r2": round(m_metrics.get("r2", 0.0), 4),
                        "mae": m_metrics.get("mae"),
                        "training_samples": m_metrics.get("training_samples"),
                        "i_ref": round(i_ref, 3),
                    }
                    pdf_str = make_predictions_string_current(
                        model_s, test_pdf, s_features, sc, i_ref,
                    )
                string_preds[device_str] = pdf_str
        except Exception as e:
            stats["string_failed"] += 1
            tqdm.write(f"  [{inv_id}] String twin error: {e}")

        stats["inverter_details"][inv_id] = inv_stats

        # Progress checkpoint
        if (i_idx + 1) % 10 == 0:
            tqdm.write(f"  [{inv_id}] p_ok={stats['power_trained']}, t_ok={stats['temp_trained']}, m_ok={stats['mppt_trained']}, s_ok={stats['string_trained']}")

    # --- Write outputs: Parquet (full detail) + PG (aggregates only) ---
    print(f"\nWriting Parquet outputs ({len(power_preds)} power, {len(temp_preds)} temp, {len(mppt_preds)} mppt, {len(string_preds)} strings)...")
    write_parquet_outputs(power_preds, temp_preds, mppt_preds, string_preds, plant_id)

    print("Building DB aggregates (plant-level hourly + per-inverter daily)...")
    db_records = build_db_aggregates(power_preds, temp_preds, mppt_preds, string_preds, power_r2_map)
    print(f"  {len(db_records):,} aggregate records (vs ~24M with old approach)")

    if db_writer and db_records:
        try:
            written = db_writer.write_analysis_results(
                plant_id, "digitaltwin", db_records,
                model_version=model_version, run_id=run_id,
            )
            stats["db_rows_written"] = written
            print(f"  DB: wrote {written:,} rows")
        except Exception as e:
            print(f"  WARNING: DB write failed: {e}")
    else:
        print(f"  DB: skipped (no writer or no records)")

    # Free prediction memory
    del power_preds, temp_preds, mppt_preds, string_preds
    import gc; gc.collect()

    # --- Summary ---
    summary = {
        "plant": plant_name,
        "plant_id": plant_id,
        "run_id": run_id,
        "model_version": model_version,
        "training_days": TRAINING_DAYS,
        "blend_weight": BLEND_WEIGHT,
        "timestamp": datetime.utcnow().isoformat(),
        "stats": {k: v for k, v in stats.items() if k != "inverter_details"},
        "inverter_details": stats["inverter_details"],
    }
    save_summary(plant_id, summary)

    # --- Print final stats ---
    print(f"\n{'='*60}")
    print(f"FINAL STATS — {plant_name.upper()}")
    print(f"{'='*60}")
    print(f"  Inverters processed : {stats['total_inverters']}")
    print(f"  Power twins OK/FAIL : {stats['power_trained']}/{stats['power_failed']}")
    print(f"  Temp twins OK/FAIL  : {stats['temp_trained']}/{stats['temp_failed']}")
    print(f"  MPPT twins OK/FAIL  : {stats['mppt_trained']}/{stats['mppt_failed']}")
    print(f"  String twins OK/FAIL: {stats['string_trained']}/{stats['string_failed']}")
    print(f"  DB rows written     : {stats['db_rows_written']:,}")

    # R² summary across inverters
    power_r2s = [
        d["power"]["r2"] for d in stats["inverter_details"].values()
        if d["power"].get("r2") is not None
    ]
    temp_r2s = [
        d["temperature"]["r2"] for d in stats["inverter_details"].values()
        if d.get("temperature", {}).get("r2") is not None
    ]
    if power_r2s:
        print(f"\n  Power R² — min={min(power_r2s):.3f}  median={np.median(power_r2s):.3f}  max={max(power_r2s):.3f}")
    if temp_r2s:
        print(f"  Temp R²  — min={min(temp_r2s):.3f}  median={np.median(temp_r2s):.3f}  max={max(temp_r2s):.3f}")

    # Sample prediction for first inverter with a trained power twin
    sample_inv = next(
        (i for i, d in stats["inverter_details"].items() if d["power"].get("status") == "ok"),
        None,
    )
    if sample_inv:
        print(f"\n  Sample (INV {sample_inv}): Power R²={stats['inverter_details'][sample_inv]['power']['r2']}")

    print(f"\nDone.")
    return summary


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train hierarchical digital twins")
    parser.add_argument(
        "plant",
        choices=list(PLANTS.keys()),
        help="Plant to train (ribera | alpha)",
    )
    args = parser.parse_args()
    train_plant(args.plant)
