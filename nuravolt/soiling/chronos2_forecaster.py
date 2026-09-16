"""Chronos-2 zero-shot soiling forecaster for cold-start plants.

Wraps Amazon's Chronos foundation model (Chronos-2 / Chronos-Bolt) for the
specific case where a newly onboarded plant has too few DustIQ days to train
the LightGBM / CatBoost models.

The wrapper produces a DataFrame with the same column shape as
`PhysicsMLHybridForecaster.predict_365d_hybrid()` so the downstream JSON
emitter and schedule optimiser work unchanged.

torch / transformers / chronos-forecasting are heavy optional dependencies
(see pyproject.toml `[project.optional-dependencies] ml-foundation`). They are
imported lazily inside the constructor so the rest of nuravolt.soiling stays
importable when the extra is not installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Optional, Sequence

import numpy as np
import pandas as pd


# Default checkpoint chain — first one that loads wins. Chronos-2 is the
# successor naming; Chronos-Bolt is the GA fallback. Users can pin via
# Chronos2Config(model_id=...).
DEFAULT_MODEL_CANDIDATES: tuple[str, ...] = (
    "amazon/chronos-2-small",
    "amazon/chronos-bolt-small",
    "amazon/chronos-t5-small",
)

# Physical SR bounds — mirror SoilingRatioModel.
SR_MIN = 0.70
SR_MAX = 1.00

# Default cleaning threshold (matches existing pipeline default).
DEFAULT_CLEANING_THRESHOLD = 0.97


@dataclass
class Chronos2Config:
    model_id: Optional[str] = None
    device: str = "cpu"  # "cuda" only if available; CPU is fine at the planned QPS
    quantile_levels: Sequence[float] = field(default_factory=lambda: (0.05, 0.5, 0.95))
    cleaning_threshold: float = DEFAULT_CLEANING_THRESHOLD


class ChronosDependenciesMissing(ImportError):
    """Raised when the chronos-forecasting / torch stack is not installed."""


class Chronos2SoilingForecaster:
    """Zero-shot SR forecaster for cold-start plants.

    Usage::

        forecaster = Chronos2SoilingForecaster()
        df = forecaster.predict_sr_forecast(
            sr_history=pd.Series(...),       # daily SR for the last 30+ days
            last_date=pd.Timestamp("2026-06-17"),
            horizon_days=365,
        )

    `df` has the same columns as `PhysicsMLHybridForecaster.predict_365d_hybrid`:
    `sr_physics`, `sr_ml_correction`, `sr_predicted`, `soiling_loss_pct`,
    `is_cleaning_needed`, `sr_lower_bound`, `sr_upper_bound`. For Chronos-2 we
    populate `sr_physics` and `sr_ml_correction` with zero — the model is
    end-to-end, the physics/ML split does not apply — and the schedule
    optimiser only consumes `sr_predicted` + `soiling_loss_pct` so this is
    backwards-compatible.
    """

    def __init__(self, config: Optional[Chronos2Config] = None):
        self.config = config or Chronos2Config()
        self._pipeline = None
        self._model_id_loaded: Optional[str] = None

    # ----- model loading ----------------------------------------------------

    def _ensure_pipeline(self) -> None:
        if self._pipeline is not None:
            return

        try:
            # Lazy import — torch/chronos may not be installed.
            import torch  # noqa: F401  (used by chronos under the hood)
            from chronos import BaseChronosPipeline  # type: ignore[import-not-found]
        except ImportError as e:
            raise ChronosDependenciesMissing(
                "Chronos requires the ml-foundation extra. Install with: "
                "pip install -e .[ml-foundation] --extra-index-url "
                "https://download.pytorch.org/whl/cpu"
            ) from e

        candidates = (
            (self.config.model_id,) if self.config.model_id else DEFAULT_MODEL_CANDIDATES
        )

        last_err: Optional[Exception] = None
        for model_id in candidates:
            try:
                self._pipeline = BaseChronosPipeline.from_pretrained(
                    model_id,
                    device_map=self.config.device,
                )
                self._model_id_loaded = model_id
                return
            except Exception as e:  # noqa: BLE001 — model loading can fail for many reasons
                last_err = e
                continue

        raise RuntimeError(
            f"Failed to load any Chronos checkpoint from {candidates}: {last_err}"
        )

    @property
    def model_id(self) -> Optional[str]:
        """The model checkpoint that was successfully loaded, or None."""
        return self._model_id_loaded

    # ----- inference --------------------------------------------------------

    def predict_sr_forecast(
        self,
        sr_history: pd.Series,
        last_date: Optional[pd.Timestamp] = None,
        horizon_days: int = 365,
    ) -> pd.DataFrame:
        """Generate a zero-shot SR forecast for `horizon_days` ahead.

        Parameters
        ----------
        sr_history
            Daily soiling-ratio observations. Index is the date (or arbitrary
            ordering if `last_date` is provided separately). Values clipped to
            [SR_MIN, SR_MAX].
        last_date
            Date of the last observation. If None, taken from `sr_history.index[-1]`.
        horizon_days
            Number of days to forecast (default 365).
        """
        if len(sr_history) < 8:
            raise ValueError(
                f"Need at least 8 days of SR history for Chronos zero-shot; "
                f"got {len(sr_history)}."
            )

        if last_date is None:
            last_date = pd.Timestamp(sr_history.index[-1])

        self._ensure_pipeline()
        assert self._pipeline is not None  # for type checkers

        # Prepare the context series.
        import torch  # lazy

        context = torch.tensor(
            np.clip(sr_history.values.astype(np.float32), SR_MIN, SR_MAX)
        )

        # Chronos predicts quantiles for each horizon step. Result shape:
        # [num_quantiles, num_timesteps] (or [batch, num_quantiles, num_timesteps]
        # in newer API). We feed a single series so squeeze accordingly.
        quantile_levels = list(self.config.quantile_levels)
        forecast = self._pipeline.predict_quantiles(
            context=context,
            prediction_length=horizon_days,
            quantile_levels=quantile_levels,
        )

        # Normalise the various return shapes that BaseChronosPipeline
        # subclasses use.
        if isinstance(forecast, tuple):
            # Some pipelines return (samples, quantiles); take quantiles.
            forecast = forecast[1]
        arr = np.asarray(forecast.detach().cpu().numpy() if hasattr(forecast, "detach") else forecast)
        if arr.ndim == 3:
            # [batch, time, quantiles] or [batch, quantiles, time]
            arr = arr[0]
        if arr.shape[0] == horizon_days:
            # [time, quantiles] — transpose to [quantiles, time]
            arr = arr.T
        if arr.shape[1] != horizon_days:
            raise RuntimeError(
                f"Unexpected Chronos output shape {arr.shape}; expected (quantiles, {horizon_days})"
            )

        q05, q50, q95 = arr[0], arr[1], arr[2]
        q05 = np.clip(q05, SR_MIN, SR_MAX)
        q50 = np.clip(q50, SR_MIN, SR_MAX)
        q95 = np.clip(q95, SR_MIN, SR_MAX)

        forecast_dates = pd.date_range(
            start=last_date + timedelta(days=1),
            periods=horizon_days,
            freq="D",
        )

        soiling_loss_pct = (1.0 - q50) * 100.0
        is_cleaning_needed = q50 < self.config.cleaning_threshold

        df = pd.DataFrame(
            {
                "date": forecast_dates,
                "sr_physics": 0.0,            # Chronos is end-to-end; no physics/ML split
                "sr_ml_correction": 0.0,
                "sr_predicted": q50,
                "soiling_loss_pct": soiling_loss_pct,
                "is_cleaning_needed": is_cleaning_needed,
                "sr_lower_bound": q05,
                "sr_upper_bound": q95,
            }
        )
        df = df.set_index("date")
        return df


def is_chronos_available() -> bool:
    """Cheap availability check that doesn't actually load the model."""
    try:
        import torch  # noqa: F401
        import chronos  # noqa: F401  # type: ignore[import-not-found]
        return True
    except ImportError:
        return False
