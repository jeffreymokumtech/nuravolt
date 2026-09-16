"""BESS chemistry router — picks the right foundation RUL model per pack.

The portable BESS RUL story has three layers:

1. **Universal warranty rules** (always on, day 1) — already shipped
   via ``nuravolt/fault/bess_fault_detector.py`` ``BessFaultDetector``.
   Reactive only: fires when a manufacturer-specified threshold has
   been crossed (SoH < 80%, max temp dwell exceeded, etc).

2. **Chemistry-specific foundation prediction** (this module) — picks
   from a registry of pretrained models. Currently:
     - LFP cells → ``models/foundation/bess_lfp_v1.pkl`` (Severson 124
       cells via delta-Q + LightGBM, 17% MAPE LOO).
     - NMC cells → planned (would train on NASA + Multi-Stage BESS).
   Predictive: given cycles 10-100 of a cell's life, estimate EOL.

3. **LLM warranty extraction** (this module) — given a BESS contract /
   warranty PDF, ask Bedrock to extract per-deal thresholds (SoH cutoff,
   cycle cap, temp dwell limit, C-rate ceiling, throughput cap) and
   stash them in a per-asset config. Catches plant-specific terms the
   universal rules miss.

The router exposes ONE entry point — ``classify_and_predict(cell_meta,
features)`` — that:
  - inspects ``cell_meta.chemistry`` and routes to the matching model
  - falls back to universal warranty rules if no foundation model exists
    for the chemistry
  - gracefully degrades if the model file is missing
"""

from __future__ import annotations

import json
import pickle
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_DIR = REPO_ROOT / "models" / "foundation"

Chemistry = Literal["LFP", "NMC", "NCA", "LTO", "UNKNOWN"]


@dataclass
class NmcLinearExtrapolationModel:
    """NMC EOL predictor via linear extrapolation from early cycles.

    Lives here so pickle can resolve the class from any import path
    (the original training script defined it in __main__ which broke
    cross-process unpickling).
    """
    prediction_window: int = 50
    eol_threshold_ah: float = 1.4
    min_eol_cycles: int = 50
    max_eol_cycles: int = 2500

    def predict_eol(self, capacity_over_cycles: list) -> int:
        if not capacity_over_cycles:
            return 0
        early = capacity_over_cycles[: self.prediction_window]
        for i, c in enumerate(early):
            if c < self.eol_threshold_ah:
                return i
        n = len(early)
        if n < 3:
            return len(capacity_over_cycles)
        import numpy as _np
        xs = _np.arange(n, dtype=float)
        ys = _np.array(early, dtype=float)
        slope, intercept = _np.polyfit(xs, ys, 1)
        if slope >= 0:
            return self.max_eol_cycles
        predicted = (self.eol_threshold_ah - intercept) / slope
        return int(max(self.min_eol_cycles, min(self.max_eol_cycles, predicted)))


@dataclass
class CellMetadata:
    cell_id: str
    chemistry: Chemistry = "UNKNOWN"
    rated_capacity_ah: float = 1.0
    chamber_temp_c: float = 25.0


@dataclass
class BessRulPrediction:
    cell_id: str
    chemistry: Chemistry
    predicted_eol_cycle: int
    confidence: float
    method: str               # "lfp_foundation_v1", "universal_warranty", "no_model"
    physics_bounds: Dict[str, int]
    notes: List[str] = field(default_factory=list)


class BessChemistryRouter:
    """Routes per-cell prediction to the right foundation model.

    Foundation models are loaded lazily on first request per chemistry.
    Missing models don't crash — we fall back to "no_model" with a
    notes message so the caller knows to surface the universal warranty
    rules instead.
    """

    def __init__(self, model_dir: Path = DEFAULT_MODEL_DIR) -> None:
        self.model_dir = model_dir
        self._cache: Dict[str, Any] = {}   # chemistry_version key -> (model, meta)

    def _load_model(self, chemistry: Chemistry, version: str = "v1") -> Optional[Any]:
        key = f"{chemistry.lower()}_{version}"
        if key in self._cache:
            return self._cache[key]
        pkl = self.model_dir / f"bess_{chemistry.lower()}_{version}.pkl"
        meta = self.model_dir / f"bess_{chemistry.lower()}_{version}.meta.json"
        if not pkl.exists():
            self._cache[key] = None
            return None
        with open(pkl, "rb") as f:
            model = pickle.load(f)
        m = json.loads(meta.read_text()) if meta.exists() else {"version": version}
        bundle = {"model": model, "meta": m}
        self._cache[key] = bundle
        return bundle

    def predict(
        self,
        cell_meta: CellMetadata,
        features: Dict[str, float],
    ) -> BessRulPrediction:
        """Predict EOL for one cell using its chemistry's foundation model.

        ``features`` must include every name in the model's metadata
        ``feature_names``. Caller is responsible for computing them — see
        ``nuravolt/validation/severson_delta_q.py`` for the reference
        delta-Q feature extractor.
        """
        bundle = self._load_model(cell_meta.chemistry)
        if bundle is None:
            return BessRulPrediction(
                cell_id=cell_meta.cell_id,
                chemistry=cell_meta.chemistry,
                predicted_eol_cycle=0,
                confidence=0.0,
                method="no_model",
                physics_bounds={"min_eol_cycles": 0, "max_eol_cycles": 0},
                notes=[
                    f"No foundation model for chemistry={cell_meta.chemistry}. "
                    f"Fall back to BessFaultDetector universal warranty rules."
                ],
            )

        model = bundle["model"]
        meta = bundle["meta"]
        feature_names: List[str] = meta["feature_names"]
        missing = [f for f in feature_names if f not in features]
        if missing:
            return BessRulPrediction(
                cell_id=cell_meta.cell_id,
                chemistry=cell_meta.chemistry,
                predicted_eol_cycle=0,
                confidence=0.0,
                method=f"{cell_meta.chemistry.lower()}_foundation_{meta.get('version','?')}",
                physics_bounds=meta.get("physics_bounds", {}),
                notes=[f"Missing features: {missing}"],
            )

        # Two model APIs supported:
        #   - LightGBM (LFP foundation): expects a numpy array of N features,
        #     predicts log10(EOL).
        #   - Linear-extrapolation (NMC foundation, NmcLinearExtrapolationModel):
        #     has a .predict_eol(list[float]) method, predicts raw EOL cycles.
        if hasattr(model, "predict_eol"):
            # NMC linear-extrapolation path — feature_names contains
            # 'capacity_over_cycles' which carries the full per-cycle series
            caps = features.get("capacity_over_cycles")
            if caps is None:
                return BessRulPrediction(
                    cell_id=cell_meta.cell_id,
                    chemistry=cell_meta.chemistry,
                    predicted_eol_cycle=0,
                    confidence=0.0,
                    method=f"{cell_meta.chemistry.lower()}_foundation_{meta.get('version','?')}",
                    physics_bounds=meta.get("physics_bounds", {}),
                    notes=["Missing capacity_over_cycles feature for linear extrapolation"],
                )
            eol = int(model.predict_eol(caps))
        else:
            X = np.array([[features[f] for f in feature_names]], dtype=float)
            y_pred_log = float(model.predict(X)[0])
            eol = int(10 ** y_pred_log)
        bounds = meta.get("physics_bounds", {"min_eol_cycles": 100, "max_eol_cycles": 2500})
        eol = max(bounds["min_eol_cycles"], min(bounds["max_eol_cycles"], eol))

        return BessRulPrediction(
            cell_id=cell_meta.cell_id,
            chemistry=cell_meta.chemistry,
            predicted_eol_cycle=eol,
            confidence=0.75,   # baseline foundation confidence; per-cell calibration is Phase 2
            method=f"{cell_meta.chemistry.lower()}_foundation_{meta.get('version','?')}",
            physics_bounds=bounds,
            notes=[
                f"Predicted from delta-Q + per-cycle capacity features. "
                f"LOO validation: {meta.get('validation','see meta')}"
            ],
        )

    def chemistries_available(self) -> List[Chemistry]:
        """List of chemistries that have a foundation model on disk."""
        out: List[Chemistry] = []
        for chem in ("LFP", "NMC", "NCA", "LTO"):
            if (self.model_dir / f"bess_{chem.lower()}_v1.pkl").exists():
                out.append(chem)
        return out


# Module-level default — instantiate once per process
_default_router: Optional[BessChemistryRouter] = None


def get_router() -> BessChemistryRouter:
    global _default_router
    if _default_router is None:
        _default_router = BessChemistryRouter()
    return _default_router
