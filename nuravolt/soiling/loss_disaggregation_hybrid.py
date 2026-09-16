"""
Hybrid loss disaggregation combining IEA physics with ML corrections.

This module provides a hybrid approach to loss disaggregation that:
1. Uses IEA PVPS physics as an interpretable baseline
2. Applies ML corrections trained on digital twin residuals
3. Enforces energy conservation constraints
4. Provides fallback to physics-only when ML unavailable

Approach ensures:
- Interpretable physics baseline (always available)
- Improved accuracy through ML corrections (when trained)
- Energy conservation (losses sum to total within 0.1%)
- Graceful degradation if ML models unavailable
"""

from typing import Dict, Optional, Any
import logging

import numpy as np
import pandas as pd

from .loss_disaggregation import IEALossDisaggregator, LossComponents
from .loss_ml_corrector import LossMLCorrector, LossCorrectionModel

logger = logging.getLogger(__name__)


class HybridLossDisaggregator:
    """
    Combine IEA physics baseline with ML corrections for improved accuracy.

    This class wraps IEALossDisaggregator and optionally applies ML corrections
    while ensuring energy conservation and providing interpretable results.
    """

    def __init__(self,
                 site_config: Any,
                 system_age_years: float = 1.0,
                 module_type: str = 'mono-Si',
                 curtailment_data: Optional[pd.DataFrame] = None,
                 ml_corrector: Optional[LossMLCorrector] = None,
                 use_ml_corrections: bool = True,
                 energy_conservation_tolerance: float = 0.001):
        """
        Initialize hybrid loss disaggregator.

        Args:
            site_config: Site configuration with capacity, location, etc.
            system_age_years: Age of the system in years
            module_type: Module technology type
            curtailment_data: Optional curtailment data
            ml_corrector: Optional trained ML corrector
            use_ml_corrections: Whether to apply ML corrections (default True)
            energy_conservation_tolerance: Max allowed energy conservation error (default 0.1%)
        """
        # Initialize IEA physics baseline
        self.iea = IEALossDisaggregator(
            site_config=site_config,
            system_age_years=system_age_years,
            module_type=module_type,
            curtailment_data=curtailment_data
        )

        # ML correction layer
        self.ml_corrector = ml_corrector
        self.use_ml_corrections = use_ml_corrections and ml_corrector is not None
        self.energy_conservation_tolerance = energy_conservation_tolerance

        # Mode tracking
        self.mode = 'hybrid' if self.use_ml_corrections else 'physics_only'

        logger.info(f"Initialized HybridLossDisaggregator in {self.mode} mode")

    def calculate_all_losses(self,
                            df: pd.DataFrame,
                            poa_col: str = 'poa_actual',
                            poa_clearsky_col: str = 'poa_clearsky',
                            t_ambient_col: str = 'temperature',
                            t_module_col: Optional[str] = None,
                            power_col: Optional[str] = None,
                            sr_col: str = 'soiling_ratio_smooth',
                            air_mass_col: Optional[str] = None,
                            wind_col: Optional[str] = None,
                            enforce_conservation: bool = True) -> pd.DataFrame:
        """
        Calculate all losses using hybrid physics-ML approach.

        Process:
        1. Calculate IEA physics baseline
        2. Apply ML corrections if available
        3. Enforce energy conservation
        4. Return hybrid results with metadata

        Args:
            df: Input DataFrame with required columns
            poa_col: POA irradiance column
            poa_clearsky_col: Clear-sky POA column
            t_ambient_col: Ambient temperature column
            t_module_col: Module temperature column (optional)
            power_col: Actual power output column (optional)
            sr_col: Soiling ratio column
            air_mass_col: Air mass column (optional)
            wind_col: Wind speed column (optional)
            enforce_conservation: Whether to enforce energy conservation (default True)

        Returns:
            DataFrame with loss calculations and metadata
        """
        logger.info(f"Calculating losses in {self.mode} mode...")

        # Step 1: Calculate IEA physics baseline
        df_losses = self.iea.calculate_all_losses(
            df=df,
            poa_col=poa_col,
            poa_clearsky_col=poa_clearsky_col,
            t_ambient_col=t_ambient_col,
            t_module_col=t_module_col,
            power_col=power_col,
            sr_col=sr_col,
            air_mass_col=air_mass_col,
            wind_col=wind_col
        )

        # Add baseline metadata
        df_losses['loss_method'] = 'physics_baseline'
        df_losses['energy_conservation_error_pct'] = 0.0  # No error in physics-only

        # Step 2: Apply ML corrections if available
        if self.use_ml_corrections and self.ml_corrector is not None:
            logger.info("Applying ML corrections...")
            df_corrected = self.ml_corrector.apply_corrections(df_losses)

            # Update loss values with ML corrections
            df_corrected = self._update_with_ml_corrections(df_corrected)

            # Update metadata
            df_corrected['loss_method'] = 'hybrid_physics_ml'

            df_losses = df_corrected

        # Step 3: Enforce energy conservation
        if enforce_conservation:
            logger.info("Enforcing energy conservation...")
            df_losses = self._enforce_energy_conservation(df_losses)

        # Step 4: Calculate final metrics
        df_losses = self._calculate_final_metrics(df_losses)

        logger.info("Loss calculation complete")
        return df_losses

    def _update_with_ml_corrections(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Update loss values with ML corrections.

        Args:
            df: DataFrame with both physics and ML-corrected losses

        Returns:
            DataFrame with updated loss columns
        """
        df_result = df.copy()

        # Update loss columns with ML corrections where available
        ml_loss_cols = {
            'soiling_energy_loss': 'soiling_energy_loss_ml_corrected',
            'temp_energy_loss': 'temp_energy_loss_ml_corrected',
            'spectral_energy_loss': 'spectral_energy_loss_ml_corrected',
            'inverter_energy_loss': 'inverter_energy_loss_ml_corrected'
        }

        for physics_col, ml_col in ml_loss_cols.items():
            if ml_col in df_result.columns:
                # Keep physics baseline in separate column
                df_result[f'{physics_col}_physics'] = df_result[physics_col].copy()
                # Update with ML correction
                df_result[physics_col] = df_result[ml_col]

        return df_result

    def _enforce_energy_conservation(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Ensure sum of losses equals total loss.

        Method: Proportional adjustment of ML corrections to maintain conservation.

        Energy conservation equation:
        total_loss = sum(all_loss_components)

        If violated after ML corrections, proportionally adjust corrected losses.

        Args:
            df: DataFrame with loss calculations

        Returns:
            DataFrame with energy-conserving losses
        """
        df_result = df.copy()

        # Total loss from reference to net
        if 'net_power_kw' in df_result.columns:
            total_loss_actual = df_result['reference_power_kw'] - df_result['net_power_kw']
        else:
            # Calculate from sequential losses
            total_loss_actual = df_result['total_loss_kw']

        # Sum of individual loss components
        loss_cols = [
            'soiling_energy_loss',
            'temp_energy_loss',
            'spectral_energy_loss',
            'inverter_energy_loss',
            'wiring_energy_loss',
            'degradation_energy_loss',
            'curtailment_energy_loss'
        ]

        # Only adjust ML-corrected losses
        ml_corrected_cols = [col for col in loss_cols if f'{col}_physics' in df_result.columns]
        non_corrected_cols = [col for col in loss_cols if col not in ml_corrected_cols]

        if len(ml_corrected_cols) == 0:
            # No ML corrections, already conserving from physics
            return df_result

        # Calculate current sum
        loss_sum_current = df_result[loss_cols].sum(axis=1)

        # Calculate conservation error
        conservation_error = (total_loss_actual - loss_sum_current).abs()
        conservation_error_pct = conservation_error / (total_loss_actual.abs() + 1e-6)

        # Check if adjustment needed
        needs_adjustment = conservation_error_pct > self.energy_conservation_tolerance

        if needs_adjustment.sum() > 0:
            logger.info(f"Adjusting {needs_adjustment.sum()} timestamps for energy conservation")

            # Proportional adjustment factor
            adjustment_factor = total_loss_actual / (loss_sum_current + 1e-6)

            # Apply adjustment only to ML-corrected losses
            for col in ml_corrected_cols:
                df_result.loc[needs_adjustment, col] = (
                    df_result.loc[needs_adjustment, col] * adjustment_factor[needs_adjustment]
                )

            # Recalculate sum
            loss_sum_adjusted = df_result[loss_cols].sum(axis=1)
            final_error_pct = (
                (total_loss_actual - loss_sum_adjusted).abs() /
                (total_loss_actual.abs() + 1e-6)
            )

            logger.info(f"Energy conservation error: "
                       f"mean={final_error_pct.mean():.4%}, "
                       f"max={final_error_pct.max():.4%}")

        # Store conservation metadata
        df_result['energy_conservation_error_pct'] = conservation_error_pct

        return df_result

    def _calculate_final_metrics(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate final aggregate metrics.

        Args:
            df: DataFrame with loss calculations

        Returns:
            DataFrame with added metric columns
        """
        df_result = df.copy()

        # Total loss
        loss_cols = [
            'soiling_energy_loss',
            'temp_energy_loss',
            'spectral_energy_loss',
            'inverter_energy_loss',
            'wiring_energy_loss',
            'degradation_energy_loss',
            'curtailment_energy_loss'
        ]

        df_result['total_loss_kw'] = df_result[loss_cols].sum(axis=1)

        # Loss percentages
        ref_power = df_result['reference_power_kw'] + 1e-6
        for col in loss_cols:
            df_result[f'{col}_pct'] = (df_result[col] / ref_power) * 100

        # Controllable vs uncontrollable
        df_result['controllable_loss_kw'] = df_result['soiling_energy_loss']
        df_result['uncontrollable_loss_kw'] = df_result['total_loss_kw'] - df_result['controllable_loss_kw']

        # Net power
        df_result['net_power_kw'] = df_result['reference_power_kw'] - df_result['total_loss_kw']

        return df_result

    def get_loss_summary(self,
                        df_losses: pd.DataFrame,
                        aggregation_period: str = 'annual') -> LossComponents:
        """
        Get aggregated loss summary.

        Args:
            df_losses: DataFrame with loss calculations
            aggregation_period: Aggregation period ('annual', 'monthly', etc.)

        Returns:
            LossComponents summary object
        """
        # Calculate totals
        reference_energy = df_losses['reference_power_kw'].sum()
        net_energy = df_losses['net_power_kw'].sum()
        total_loss = reference_energy - net_energy

        # Individual losses
        soiling_loss = df_losses['soiling_energy_loss'].sum()
        temp_loss = df_losses['temp_energy_loss'].sum()
        spectral_loss = df_losses['spectral_energy_loss'].sum()
        inverter_loss = df_losses['inverter_energy_loss'].sum()
        wiring_loss = df_losses['wiring_energy_loss'].sum()
        degradation_loss = df_losses['degradation_energy_loss'].sum()
        curtailment_loss = df_losses['curtailment_energy_loss'].sum()

        # Get date range
        if 'timestamp' in df_losses.columns:
            start_date = str(pd.to_datetime(df_losses['timestamp']).min())
            end_date = str(pd.to_datetime(df_losses['timestamp']).max())
        else:
            start_date = None
            end_date = None

        return LossComponents(
            soiling_loss_pct=soiling_loss / reference_energy,
            temperature_loss_pct=temp_loss / reference_energy,
            spectral_loss_pct=spectral_loss / reference_energy,
            inverter_loss_pct=inverter_loss / reference_energy,
            wiring_bop_loss_pct=wiring_loss / reference_energy,
            degradation_loss_pct=degradation_loss / reference_energy,
            curtailment_loss_pct=curtailment_loss / reference_energy,
            reference_energy=reference_energy,
            net_energy=net_energy,
            soiling_energy_loss=soiling_loss,
            temperature_energy_loss=temp_loss,
            spectral_energy_loss=spectral_loss,
            inverter_energy_loss=inverter_loss,
            wiring_bop_energy_loss=wiring_loss,
            degradation_energy_loss=degradation_loss,
            curtailment_energy_loss=curtailment_loss,
            aggregation_period=aggregation_period,
            start_date=start_date,
            end_date=end_date
        )

    def compare_physics_vs_hybrid(self, df_losses: pd.DataFrame) -> pd.DataFrame:
        """
        Compare physics baseline vs hybrid ML corrections.

        Args:
            df_losses: DataFrame with both physics and hybrid losses

        Returns:
            DataFrame with comparison metrics
        """
        if self.mode == 'physics_only':
            logger.warning("No ML corrections available for comparison")
            return pd.DataFrame()

        comparison_data = []

        loss_types = ['soiling', 'temp', 'spectral', 'inverter']

        for loss_type in loss_types:
            physics_col = f'{loss_type}_energy_loss_physics'
            hybrid_col = f'{loss_type}_energy_loss'

            if physics_col not in df_losses.columns:
                continue

            physics_total = df_losses[physics_col].sum()
            hybrid_total = df_losses[hybrid_col].sum()
            correction_total = df_losses.get(f'{loss_type}_energy_loss_ml_correction', pd.Series(0)).sum()

            comparison_data.append({
                'loss_type': loss_type,
                'physics_total_kWh': physics_total,
                'hybrid_total_kWh': hybrid_total,
                'ml_correction_kWh': correction_total,
                'correction_pct': (correction_total / physics_total * 100) if physics_total != 0 else 0,
                'hybrid_vs_physics_pct': ((hybrid_total - physics_total) / physics_total * 100) if physics_total != 0 else 0
            })

        return pd.DataFrame(comparison_data)

    def enable_ml_corrections(self):
        """Enable ML corrections if corrector is available."""
        if self.ml_corrector is None:
            logger.warning("No ML corrector available")
            return

        self.use_ml_corrections = True
        self.mode = 'hybrid'
        logger.info("ML corrections enabled - mode: hybrid")

    def disable_ml_corrections(self):
        """Disable ML corrections, fallback to physics only."""
        self.use_ml_corrections = False
        self.mode = 'physics_only'
        logger.info("ML corrections disabled - mode: physics_only")

    def set_ml_corrector(self, ml_corrector: LossMLCorrector):
        """
        Set or update ML corrector.

        Args:
            ml_corrector: Trained ML corrector instance
        """
        self.ml_corrector = ml_corrector
        self.use_ml_corrections = True
        self.mode = 'hybrid'
        logger.info(f"ML corrector updated with {len(ml_corrector.correction_models)} models")
