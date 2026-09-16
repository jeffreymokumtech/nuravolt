"""PV classifier router — pick foundation model by client feature shape.

Two PV foundation models on disk:
  - `pv_classifier_v1` — trained on Lazzaretti (per-string voltage/current,
    irradiance, module temp). Features: poa_irradiance, module_temp, i_mean,
    i_imbalance, v_imbalance, v_mean, current_ratio.
  - `pv_classifier_gpvs_v1` — trained on GPVS (system-level 3-phase AC +
    DC bus). Features: Ipv, Vpv, Vdc, ac_current_imbalance,
    ac_voltage_imbalance, dc_ratio, pv_power.

This router inspects the client's incoming feature columns and dispatches
to whichever model's feature set is fully present. Some clients can use
both (rare — would need both per-string and 3-phase sensors). When
neither model's full feature set is present, returns `no_model` so the
caller falls back to the rule-based cascade.

The two models have DIFFERENT class taxonomies (Lazzaretti 5-class vs
GPVS 8-class) so the router's prediction object includes which model
fired + which taxonomy the label belongs to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

import polars as pl

from .pv_classifier import (
    DEFAULT_MODEL_DIR,
    PvFoundationClassifier,
    PvFoundationPrediction,
    load_pv_foundation,
)


PV_LAZZARETTI_FEATURES = [
    "poa_irradiance", "module_temp",
    "i_mean", "i_imbalance", "v_imbalance", "v_mean", "current_ratio",
]
PV_GPVS_FEATURES = [
    "Ipv", "Vpv", "Vdc",
    "ac_current_imbalance", "ac_voltage_imbalance",
    "dc_ratio", "pv_power",
]


@dataclass
class PvRouterPrediction:
    label: str
    label_taxonomy: Literal["lazzaretti_5", "gpvs_8", "none"]
    model_used: str          # "pv_classifier_v1" / "pv_classifier_gpvs_v1" / "no_model"
    confidence: float
    probabilities: Dict[str, float] = field(default_factory=dict)
    note: str = ""


class PvRouter:
    """Routes PV fault classification by available feature shape."""

    def __init__(self, model_dir=DEFAULT_MODEL_DIR) -> None:
        self.model_dir = model_dir
        self._lazzaretti: Optional[PvFoundationClassifier] = None
        self._gpvs = None     # raw LightGBM model + meta, no wrapper class for GPVS yet
        self._gpvs_meta = None
        self._try_load()

    def _try_load(self) -> None:
        try:
            self._lazzaretti = load_pv_foundation()
        except FileNotFoundError:
            self._lazzaretti = None
        # GPVS model is plain LightGBM — load via pickle since we have no wrapper
        import pickle
        import json
        gpvs_pkl = self.model_dir / "pv_classifier_gpvs_v1.pkl"
        gpvs_meta = self.model_dir / "pv_classifier_gpvs_v1.meta.json"
        if gpvs_pkl.exists():
            with open(gpvs_pkl, "rb") as f:
                self._gpvs = pickle.load(f)
            if gpvs_meta.exists():
                self._gpvs_meta = json.loads(gpvs_meta.read_text())

    def available_models(self) -> List[str]:
        out = []
        if self._lazzaretti is not None:
            out.append("pv_classifier_v1")
        if self._gpvs is not None:
            out.append("pv_classifier_gpvs_v1")
        return out

    def detect_shape(self, columns: List[str]) -> Literal["lazzaretti", "gpvs", "none"]:
        """Inspect column names → which model's full feature set is present?

        Returns "lazzaretti" if all per-string columns are there (i_mean,
        i_imbalance, etc — typically because the client engineered them
        from per-string voltage/current via PlantAgnosticFeatureEngine).
        Returns "gpvs" if the system-level 3-phase columns are present.
        Returns "none" if neither is fully present.
        """
        col_set = set(columns)
        has_lazzaretti = all(f in col_set for f in PV_LAZZARETTI_FEATURES)
        has_gpvs = all(f in col_set for f in PV_GPVS_FEATURES)
        if has_lazzaretti:
            return "lazzaretti"
        if has_gpvs:
            return "gpvs"
        return "none"

    def predict(self, signals: pl.DataFrame) -> List[PvRouterPrediction]:
        """Predict per-row using whichever model's features are present."""
        shape = self.detect_shape(signals.columns)
        if shape == "lazzaretti" and self._lazzaretti is not None:
            raw_preds = self._lazzaretti.predict(signals)
            return [
                PvRouterPrediction(
                    label=p.label,
                    label_taxonomy="lazzaretti_5",
                    model_used="pv_classifier_v1",
                    confidence=max(p.probabilities.values()),
                    probabilities=p.probabilities,
                )
                for p in raw_preds
            ]
        if shape == "gpvs" and self._gpvs is not None:
            from nuravolt.validation.adapters.gpvs_csv import GPVS_CLASS_TO_FAULT
            X = signals.select(PV_GPVS_FEATURES).to_pandas()
            proba = self._gpvs.predict_proba(X)
            preds_int = self._gpvs.predict(X)
            classes_in_order = (self._gpvs_meta or {}).get(
                "class_names",
                [GPVS_CLASS_TO_FAULT[f"F{i}"] for i in range(8)],
            )
            out = []
            for i, p_int in enumerate(preds_int):
                probs = {classes_in_order[j]: float(proba[i, j]) for j in range(proba.shape[1])}
                label = classes_in_order[int(p_int)]
                out.append(PvRouterPrediction(
                    label=label,
                    label_taxonomy="gpvs_8",
                    model_used="pv_classifier_gpvs_v1",
                    confidence=max(probs.values()),
                    probabilities=probs,
                ))
            return out
        # Neither shape detected → no_model
        return [
            PvRouterPrediction(
                label="unmapped",
                label_taxonomy="none",
                model_used="no_model",
                confidence=0.0,
                note=f"Feature set didn't match either model. Got cols: {list(signals.columns)[:8]}...",
            )
            for _ in range(len(signals))
        ]


_default_router: Optional[PvRouter] = None


def get_pv_router() -> PvRouter:
    global _default_router
    if _default_router is None:
        _default_router = PvRouter()
    return _default_router
