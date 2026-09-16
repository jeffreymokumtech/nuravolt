"""Twin-based feature extraction for soiling ratio estimation.

Uses both physics and ML hybrid digital twin residuals as features for
transfer learning soiling models.

Key features:
- physics_residual: P_physics - P_actual (generalizable, primary signal)
- physics_residual_pct: Normalized physics residual
- ml_correction: P_hybrid - P_physics (site-specific learned patterns)
- ml_correction_pct: Normalized ML correction
- hybrid_residual: P_hybrid - P_actual (use with caution - data leakage risk)
- ml_explanation_ratio: How much of physics residual ML explains

The physics residual is the workhorse feature as it generalizes across plants.
ML correction provides context about site-specific patterns.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Dict, List, Any
import logging

import numpy as np
import polars as pl
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class TwinFeatureConfig:
    """Configuration for twin feature extraction."""

    # Minimum irradiance for valid features (W/m²)
    min_irradiance: float = 50.0

    # Minimum power for valid features (kW)
    min_power: float = 1.0

    # Clip physics residual percentage to avoid extreme values
    residual_pct_clip: float = 0.5  # ±50%

    # Whether to include hybrid features (requires hybrid model)
    include_hybrid: bool = True

    # Whether to include ratio features
    include_ratios: bool = True

    # Rolling window for smoothed features (days)
    rolling_window_days: int = 7


@dataclass
class TwinFeatures:
    """Extracted twin features for a single timestamp or aggregated period."""

    # Physics-based features (PRIMARY - always available)
    physics_residual: float  # P_physics - P_actual (kW)
    physics_residual_pct: float  # (P_physics - P_actual) / P_physics

    # ML-based features (SECONDARY - requires hybrid model)
    ml_correction: Optional[float] = None  # P_hybrid - P_physics
    ml_correction_pct: Optional[float] = None
    hybrid_residual: Optional[float] = None  # P_hybrid - P_actual
    hybrid_residual_pct: Optional[float] = None

    # Ratio features (derived)
    ml_explanation_ratio: Optional[float] = None  # ml_correction / physics_residual


class TwinFeatureExtractor:
    """Extract features from physics and hybrid twin models for soiling estimation.

    The physics residual (P_physics - P_actual) is the primary feature that
    generalizes across plants. It captures all deviations from ideal physics,
    including soiling.

    The ML correction (P_hybrid - P_physics) captures site-specific learned
    patterns that help distinguish normal site behavior from soiling.

    Example usage:
        extractor = TwinFeatureExtractor(plant_id="epsilon")
        df_features = extractor.extract_features(df_scada)
    """

    def __init__(
        self,
        plant_id: str,
        config: Optional[TwinFeatureConfig] = None,
        physics_model: Optional[Any] = None,
        hybrid_model: Optional[Any] = None,
    ):
        """Initialize feature extractor.

        Args:
            plant_id: Plant identifier
            config: Feature extraction configuration
            physics_model: Pre-loaded physics model (optional, will load if not provided)
            hybrid_model: Pre-loaded hybrid model (optional, will load if not provided)
        """
        self.plant_id = plant_id
        self.config = config or TwinFeatureConfig()
        self._physics_model = physics_model
        self._hybrid_model = hybrid_model
        self._models_loaded = False

    def _load_models(self) -> None:
        """Lazy load physics and hybrid models."""
        if self._models_loaded:
            return

        from nuravolt.digitaltwin.hybrid_model import HybridModel

        twin_path = Path(f"public/data/digitaltwin/{self.plant_id}/hybrid_model.pkl")

        if twin_path.exists() and self._hybrid_model is None:
            try:
                self._hybrid_model = HybridModel.load(twin_path)
                logger.info(f"Loaded HybridModel from {twin_path}")
            except Exception as e:
                logger.warning(f"Could not load hybrid model: {e}")

        self._models_loaded = True

    @property
    def has_hybrid_model(self) -> bool:
        """Check if hybrid model is available."""
        self._load_models()
        return self._hybrid_model is not None

    def extract_features(
        self,
        df: pl.DataFrame,
        power_col: str = "power_actual",
        irradiance_col: str = "irradiance",
        temp_col: str = "ambient_temp",
    ) -> pl.DataFrame:
        """Extract twin features from SCADA data.

        Args:
            df: Polars DataFrame with SCADA data
            power_col: Column name for actual power
            irradiance_col: Column name for irradiance
            temp_col: Column name for ambient temperature

        Returns:
            DataFrame with added twin feature columns
        """
        self._load_models()

        # Convert to pandas for model prediction (models expect pandas)
        df_pd = df.to_pandas() if isinstance(df, pl.DataFrame) else df.copy()

        # Get physics prediction
        if self._hybrid_model is not None:
            # Use physics component of hybrid model
            df_pd["P_physics"] = self._hybrid_model.predict_physics(df_pd)
        else:
            # Fallback: estimate physics power from simple model
            df_pd["P_physics"] = self._estimate_physics_power(
                df_pd, irradiance_col, temp_col
            )

        # Calculate physics residual
        df_pd["physics_residual"] = df_pd["P_physics"] - df_pd[power_col]

        # Normalized physics residual (clipped)
        with np.errstate(divide="ignore", invalid="ignore"):
            residual_pct = df_pd["physics_residual"] / df_pd["P_physics"].clip(lower=1)
            df_pd["physics_residual_pct"] = residual_pct.clip(
                -self.config.residual_pct_clip, self.config.residual_pct_clip
            )

        # Add ML-based features if hybrid model available
        if self.config.include_hybrid and self._hybrid_model is not None:
            df_pd["P_hybrid"] = self._hybrid_model.predict(df_pd)

            # ML correction (what the ML learned beyond physics)
            df_pd["ml_correction"] = df_pd["P_hybrid"] - df_pd["P_physics"]

            with np.errstate(divide="ignore", invalid="ignore"):
                df_pd["ml_correction_pct"] = (
                    df_pd["ml_correction"] / df_pd["P_physics"].clip(lower=1)
                ).clip(-0.3, 0.3)

            # Hybrid residual (use with caution)
            df_pd["hybrid_residual"] = df_pd["P_hybrid"] - df_pd[power_col]

            with np.errstate(divide="ignore", invalid="ignore"):
                df_pd["hybrid_residual_pct"] = (
                    df_pd["hybrid_residual"] / df_pd["P_hybrid"].clip(lower=1)
                ).clip(-self.config.residual_pct_clip, self.config.residual_pct_clip)

            # Ratio feature: how much does ML explain?
            if self.config.include_ratios:
                with np.errstate(divide="ignore", invalid="ignore"):
                    ratio = df_pd["ml_correction"] / df_pd["physics_residual"].clip(
                        lower=0.01
                    )
                    df_pd["ml_explanation_ratio"] = ratio.clip(-10, 10)

        # Filter invalid periods (low irradiance, low power)
        valid_mask = (df_pd[irradiance_col] >= self.config.min_irradiance) & (
            df_pd[power_col] >= self.config.min_power
        )
        df_pd.loc[~valid_mask, self._get_feature_columns()] = np.nan

        # Convert back to polars
        return pl.from_pandas(df_pd)

    def extract_daily_features(
        self,
        df: pl.DataFrame,
        power_col: str = "power_actual",
        irradiance_col: str = "irradiance",
        temp_col: str = "ambient_temp",
        date_col: str = "date",
    ) -> pl.DataFrame:
        """Extract daily aggregated twin features.

        Aggregates sub-daily features to daily level using energy-weighted means.

        Args:
            df: Polars DataFrame with SCADA data (sub-daily)
            power_col: Column name for actual power
            irradiance_col: Column name for irradiance
            temp_col: Column name for ambient temperature
            date_col: Column name for date (or will extract from timestamp)

        Returns:
            Daily aggregated DataFrame with twin features
        """
        # First extract raw features
        df_features = self.extract_features(df, power_col, irradiance_col, temp_col)

        # Ensure we have a date column
        if date_col not in df_features.columns:
            if "timestamp" in df_features.columns:
                df_features = df_features.with_columns(
                    pl.col("timestamp").dt.date().alias(date_col)
                )
            else:
                raise ValueError(f"No date column '{date_col}' or 'timestamp' found")

        # Aggregate to daily - use irradiance-weighted mean for residuals
        feature_cols = self._get_feature_columns()
        available_cols = [c for c in feature_cols if c in df_features.columns]

        # Create aggregation expressions
        agg_exprs = [
            pl.col(irradiance_col).sum().alias("daily_irradiance"),
            pl.col(power_col).sum().alias("daily_energy"),
        ]

        # Weighted mean for each feature
        for col in available_cols:
            # Weight by irradiance for better accuracy
            weighted = (pl.col(col) * pl.col(irradiance_col)).sum() / pl.col(
                irradiance_col
            ).sum()
            agg_exprs.append(weighted.alias(col))

        df_daily = df_features.group_by(date_col).agg(agg_exprs).sort(date_col)

        return df_daily

    def get_feature_names(self) -> List[str]:
        """Get list of feature column names that will be created."""
        return self._get_feature_columns()

    def _get_feature_columns(self) -> List[str]:
        """Get list of feature columns based on configuration."""
        cols = ["physics_residual", "physics_residual_pct"]

        if self.config.include_hybrid:
            cols.extend(
                [
                    "ml_correction",
                    "ml_correction_pct",
                    "hybrid_residual",
                    "hybrid_residual_pct",
                ]
            )

        if self.config.include_ratios:
            cols.append("ml_explanation_ratio")

        return cols

    def _estimate_physics_power(
        self,
        df: pd.DataFrame,
        irradiance_col: str,
        temp_col: str,
    ) -> pd.Series:
        """Simple physics power estimate when no model available.

        Uses basic PVWatts-style calculation:
        P = G/1000 * P_stc * (1 + gamma * (T_cell - 25))

        Args:
            df: DataFrame with irradiance and temperature
            irradiance_col: Irradiance column name
            temp_col: Temperature column name

        Returns:
            Estimated physics power series
        """
        # Estimate capacity from max observed power (rough approximation)
        capacity_kw = df.get("capacity_kw", df["power_actual"].quantile(0.99) * 1.1)
        if isinstance(capacity_kw, pd.Series):
            capacity_kw = capacity_kw.iloc[0]

        G_stc = 1000.0  # W/m²
        gamma = -0.004  # Temperature coefficient for mono-Si
        T_stc = 25.0  # STC temperature

        # Simple cell temperature estimate
        T_cell = df[temp_col] + df[irradiance_col] / 800 * 25

        # Temperature derating
        temp_factor = 1 + gamma * (T_cell - T_stc)

        # Physics power
        P_physics = (df[irradiance_col] / G_stc) * capacity_kw * temp_factor

        return P_physics.clip(lower=0)


def compute_transfer_features(
    source_plant_id: str,
    target_plant_id: str,
    df_target: pl.DataFrame,
    use_source_hybrid: bool = True,
) -> pl.DataFrame:
    """Compute transfer learning features for a target plant.

    Uses the source plant's hybrid model (if available) to extract features
    that transfer well to the target plant.

    Args:
        source_plant_id: Plant ID of the source (with DustIQ)
        target_plant_id: Plant ID of the target (without DustIQ)
        df_target: Target plant SCADA data
        use_source_hybrid: Whether to use source plant's hybrid model

    Returns:
        Target plant data with transfer learning features
    """
    # Load source plant's hybrid model for transfer
    source_hybrid = None
    if use_source_hybrid:
        from nuravolt.digitaltwin.hybrid_model import HybridModel

        source_path = Path(
            f"public/data/digitaltwin/{source_plant_id}/hybrid_model.pkl"
        )
        if source_path.exists():
            try:
                source_hybrid = HybridModel.load(source_path)
                logger.info(f"Using source hybrid model from {source_plant_id}")
            except Exception as e:
                logger.warning(f"Could not load source hybrid: {e}")

    # Create extractor for target plant
    extractor = TwinFeatureExtractor(
        plant_id=target_plant_id,
        config=TwinFeatureConfig(include_hybrid=source_hybrid is not None),
        hybrid_model=source_hybrid,
    )

    return extractor.extract_features(df_target)
