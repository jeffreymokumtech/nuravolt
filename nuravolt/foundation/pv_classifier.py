"""Loader + predict API for the pre-trained PV fault classifier.

Wraps the LightGBM Booster saved by
``scripts/train_pv_foundation_lgbm.py`` so production code (cascade
Layer 3, validation harness) can call ``load_pv_foundation()`` and get
a ready-to-use classifier without dealing with file paths or
feature-engineering boilerplate.
"""

from __future__ import annotations

import json
import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import polars as pl

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_DIR = REPO_ROOT / "models" / "foundation"


@dataclass
class PvFoundationPrediction:
    label: str                   # e.g. "normal", "string_degradation"
    label_int: int               # original class index
    probabilities: Dict[str, float]   # per-class probability


class PvFoundationClassifier:
    """Wrap the saved LightGBM model + its metadata.

    Use ``load_pv_foundation()`` to construct; this class doesn't read
    files in __init__ to keep tests fast.
    """

    def __init__(self, model: Any, meta: Dict[str, Any]) -> None:
        self.model = model
        self.meta = meta
        self.feature_names: List[str] = meta["feature_names"]
        self.class_names: List[str] = meta["class_names"]
        self.class_idx_to_name: Dict[int, str] = {
            int(k): v for k, v in meta.get("class_index_to_name", {}).items()
        }
        if not self.class_idx_to_name:
            self.class_idx_to_name = dict(enumerate(self.class_names))

    @property
    def version(self) -> str:
        return self.meta.get("version", "unknown")

    @property
    def test_macro_f1(self) -> float:
        return float(self.meta.get("test_metrics", {}).get("macro_f1", 0.0))

    def engineer_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """Apply the same feature engineering used at training time.

        Caller passes a DataFrame with raw columns:
          poa_irradiance, module_temp, string_voltage_1, string_voltage_2,
          string_current_1, string_current_2.

        Returns a frame with only the model's expected feature columns.

        If the input already contains the engineered features (e.g. the
        router supplies pre-engineered data), short-circuit and just select
        the model's expected columns.
        """
        if all(f in df.columns for f in self.feature_names):
            return df.select(self.feature_names)
        engineered = df.with_columns([
            ((pl.col("string_current_1") + pl.col("string_current_2")) / 2).alias("i_mean"),
            ((pl.col("string_current_1") - pl.col("string_current_2")).abs() /
                ((pl.col("string_current_1") + pl.col("string_current_2")) / 2 + 1e-6)).alias("i_imbalance"),
            ((pl.col("string_voltage_1") - pl.col("string_voltage_2")).abs() /
                ((pl.col("string_voltage_1") + pl.col("string_voltage_2")) / 2 + 1e-6)).alias("v_imbalance"),
            ((pl.col("string_voltage_1").clip(0) + pl.col("string_voltage_2").clip(0)) / 2).alias("v_mean"),
            (((pl.col("string_current_1") + pl.col("string_current_2")) / 2) /
                (pl.col("poa_irradiance") * 0.009 + 1e-6)).alias("current_ratio"),
        ])
        return engineered.select(self.feature_names)

    def predict(self, signals: pl.DataFrame) -> List[PvFoundationPrediction]:
        """Predict class labels + per-class probabilities for each row."""
        feats = self.engineer_features(signals).to_pandas()
        proba = self.model.predict_proba(feats)
        preds_int = self.model.predict(feats)
        out: List[PvFoundationPrediction] = []
        for i, p_int in enumerate(preds_int):
            p_idx = int(p_int)
            probs = {
                self.class_idx_to_name.get(int(j), str(j)): float(proba[i, j])
                for j in range(proba.shape[1])
            }
            out.append(PvFoundationPrediction(
                label=self.class_idx_to_name.get(p_idx, str(p_idx)),
                label_int=p_idx,
                probabilities=probs,
            ))
        return out

    def predict_labels(self, signals: pl.DataFrame) -> List[str]:
        """Shortcut: just the labels, no probabilities."""
        feats = self.engineer_features(signals).to_pandas()
        preds_int = self.model.predict(feats)
        return [self.class_idx_to_name.get(int(p), str(p)) for p in preds_int]


def load_pv_foundation(
    version: str = "v1",
    model_dir: Path = DEFAULT_MODEL_DIR,
) -> PvFoundationClassifier:
    """Load the saved PV foundation classifier for the given version.

    Raises FileNotFoundError if the model hasn't been trained yet.
    """
    pkl_path = model_dir / f"pv_classifier_{version}.pkl"
    meta_path = model_dir / f"pv_classifier_{version}.meta.json"
    if not pkl_path.exists():
        raise FileNotFoundError(
            f"PV foundation model {version} not found at {pkl_path}.\n"
            f"  Train with: python scripts/train_pv_foundation_lgbm.py"
        )
    with open(pkl_path, "rb") as f:
        model = pickle.load(f)
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"version": version}
    return PvFoundationClassifier(model=model, meta=meta)
