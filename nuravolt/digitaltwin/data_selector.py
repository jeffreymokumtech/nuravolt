"""
Training Data Selector for Digital Twin Models

Implements intelligent selection of high-quality training data:
- First 2-3 years of plant operation (before significant degradation)
- Performance Ratio > 10% (daylight hours, producing)
- Quality scoring and filtering
- Seasonal balance for robust models
- Physics-based normal operation filtering (no fault data)

The data selection process ensures only clean, representative,
physics-consistent data is used for model training.

Based on methodology from analyticsbackend/data/data_selector.py
Enhanced with multi-stage normal data filtering.
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime, timedelta
import logging
import re

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class SelectionCriteria:
    """Criteria for training data selection."""
    # Temporal criteria
    max_years: float = 3.0              # Maximum years of data to use (extended from 2.0)
    use_earliest: bool = True           # Use earliest data (before degradation)

    # Quality criteria
    min_pr: float = 0.10                # Minimum performance ratio (10%)
    min_irradiance: float = 50.0        # Minimum irradiance (W/m²) for daylight
    max_irradiance: float = 1500.0      # Maximum realistic irradiance

    # Data quality
    min_quality_score: float = 0.6      # Minimum composite quality score
    max_missing_pct: float = 20.0       # Maximum missing data percentage

    # Seasonal balance
    ensure_seasonal_balance: bool = True
    min_samples_per_month: int = 100


@dataclass
class SelectionResult:
    """Result of training data selection."""
    df: pd.DataFrame                    # Selected data
    n_samples: int                      # Number of samples
    date_range: Tuple[str, str]         # Start and end dates
    quality_score: float                # Average quality score
    seasonal_coverage: Dict[int, int]   # Samples per month
    selection_ratio: float              # Fraction of original data kept


class DigitalTwinDataSelector:
    """
    Intelligent selector for digital twin training data.

    Selects the best historical data for training models:
    - Uses first 2 years to avoid degradation effects
    - Filters for PR > 10% (producing, daylight hours)
    - Ensures seasonal balance for generalization
    """

    def __init__(
        self,
        criteria: Optional[SelectionCriteria] = None,
        nominal_power_kw: Optional[float] = None,
    ):
        """
        Initialize data selector.

        Parameters:
        -----------
        criteria : SelectionCriteria
            Selection criteria (uses defaults if None)
        nominal_power_kw : float
            Nominal inverter power for PR calculation
        """
        self.criteria = criteria or SelectionCriteria()
        self.nominal_power_kw = nominal_power_kw

    def select_training_data(
        self,
        df: pd.DataFrame,
        power_col: str,
        irradiance_col: str,
        timestamp_col: Optional[str] = None,
    ) -> SelectionResult:
        """
        Select optimal training data from historical dataset.

        Parameters:
        -----------
        df : pd.DataFrame
            Input data with power and irradiance
        power_col : str
            Column name for power output
        irradiance_col : str
            Column name for irradiance
        timestamp_col : str
            Column name for timestamp (uses index if None)

        Returns:
        --------
        SelectionResult
            Selected data with metadata
        """
        logger.info(f"Selecting training data from {len(df)} records")
        original_size = len(df)

        # Ensure datetime index
        df = df.copy()
        if timestamp_col and timestamp_col in df.columns:
            df = df.set_index(timestamp_col)
        if not isinstance(df.index, pd.DatetimeIndex):
            try:
                df.index = pd.to_datetime(df.index)
            except Exception as e:
                logger.warning(f"Could not parse datetime index: {e}")

        # Step 1: Select time period (first N years)
        df = self._select_time_period(df)
        logger.info(f"After time period filter: {len(df)} records")

        # Step 2: Filter for daylight hours (irradiance > threshold)
        df = self._filter_daylight(df, irradiance_col)
        logger.info(f"After daylight filter: {len(df)} records")

        # Step 3: Filter for PR > threshold
        df = self._filter_by_pr(df, power_col, irradiance_col)
        logger.info(f"After PR filter: {len(df)} records")

        # Step 4: Quality scoring
        df = self._apply_quality_scoring(df, power_col, irradiance_col)
        logger.info(f"After quality filter: {len(df)} records")

        # Step 5: Ensure seasonal balance (optional)
        if self.criteria.ensure_seasonal_balance:
            df = self._balance_seasons(df)
            logger.info(f"After seasonal balance: {len(df)} records")

        # Calculate result metrics
        result = SelectionResult(
            df=df,
            n_samples=len(df),
            date_range=(
                str(df.index.min())[:10] if len(df) > 0 else '',
                str(df.index.max())[:10] if len(df) > 0 else ''
            ),
            quality_score=df['quality_score'].mean() if 'quality_score' in df.columns else 0.5,
            seasonal_coverage=self._get_seasonal_coverage(df),
            selection_ratio=len(df) / original_size if original_size > 0 else 0,
        )

        logger.info(f"Selected {result.n_samples} samples ({result.selection_ratio:.1%} of original)")
        return result

    def _select_time_period(self, df: pd.DataFrame) -> pd.DataFrame:
        """Select first N years of data."""
        if not isinstance(df.index, pd.DatetimeIndex):
            return df

        start_date = df.index.min()
        cutoff_date = start_date + pd.DateOffset(years=self.criteria.max_years)

        if self.criteria.use_earliest:
            # Use earliest data (standard approach)
            mask = df.index <= cutoff_date
        else:
            # Use most recent data (alternative approach)
            end_date = df.index.max()
            mask = df.index >= (end_date - pd.DateOffset(years=self.criteria.max_years))

        return df[mask]

    def _filter_daylight(
        self,
        df: pd.DataFrame,
        irradiance_col: str
    ) -> pd.DataFrame:
        """Filter for daylight hours based on irradiance."""
        if irradiance_col not in df.columns:
            logger.warning(f"Irradiance column '{irradiance_col}' not found")
            return df

        mask = (
            (df[irradiance_col] >= self.criteria.min_irradiance) &
            (df[irradiance_col] <= self.criteria.max_irradiance)
        )

        return df[mask]

    def _filter_by_pr(
        self,
        df: pd.DataFrame,
        power_col: str,
        irradiance_col: str
    ) -> pd.DataFrame:
        """Filter for performance ratio > threshold."""
        if power_col not in df.columns or irradiance_col not in df.columns:
            logger.warning(f"Required columns not found for PR calculation")
            return df

        # Calculate PR if nominal power known
        if self.nominal_power_kw:
            # PR = (Power / Nominal) / (Irradiance / 1000)
            # Simplified: normalized power = Power / Nominal / (G / G_stc)
            g_stc = 1000.0  # Standard test conditions irradiance
            pr = (df[power_col] / self.nominal_power_kw) / (df[irradiance_col] / g_stc)
        else:
            # Use normalized power directly if available
            # Assume power column is already normalized (kW/kWp)
            pr = df[power_col]

        # Clip to reasonable range
        pr = pr.clip(0, 1.5)

        # Store PR for later use
        df = df.copy()
        df['calculated_pr'] = pr

        # Filter by minimum PR
        mask = pr >= self.criteria.min_pr

        return df[mask]

    def _apply_quality_scoring(
        self,
        df: pd.DataFrame,
        power_col: str,
        irradiance_col: str
    ) -> pd.DataFrame:
        """Apply composite quality scoring."""
        df = df.copy()

        # Initialize quality score
        quality = pd.Series(1.0, index=df.index)

        # Penalize missing values
        for col in [power_col, irradiance_col]:
            if col in df.columns:
                quality *= (~df[col].isna()).astype(float)

        # Penalize extreme values (likely sensor errors)
        if power_col in df.columns:
            power_zscore = np.abs(
                (df[power_col] - df[power_col].mean()) / df[power_col].std()
            )
            quality *= np.where(power_zscore > 3, 0.5, 1.0)

        if irradiance_col in df.columns:
            irr_zscore = np.abs(
                (df[irradiance_col] - df[irradiance_col].mean()) / df[irradiance_col].std()
            )
            quality *= np.where(irr_zscore > 3, 0.5, 1.0)

        # Penalize rapid changes (likely sensor glitches)
        if power_col in df.columns:
            power_diff = df[power_col].diff().abs()
            power_diff_pct = power_diff / (df[power_col].abs() + 0.01)
            quality *= np.where(power_diff_pct > 0.5, 0.7, 1.0)

        df['quality_score'] = quality

        # Filter by minimum quality
        mask = quality >= self.criteria.min_quality_score

        return df[mask]

    def _balance_seasons(self, df: pd.DataFrame) -> pd.DataFrame:
        """Ensure balanced seasonal representation."""
        if not isinstance(df.index, pd.DatetimeIndex):
            return df

        # Count samples per month
        monthly_counts = df.groupby(df.index.month).size()

        # Find minimum viable count (use min count or threshold)
        min_count = max(
            monthly_counts.min(),
            self.criteria.min_samples_per_month
        )

        # Sample equally from each month
        balanced_dfs = []
        for month in range(1, 13):
            month_df = df[df.index.month == month]
            if len(month_df) >= min_count:
                # Random sample to balance
                balanced_dfs.append(month_df.sample(n=min_count, random_state=42))
            elif len(month_df) > 0:
                # Keep all if below threshold
                balanced_dfs.append(month_df)

        if balanced_dfs:
            return pd.concat(balanced_dfs).sort_index()
        return df

    def _get_seasonal_coverage(self, df: pd.DataFrame) -> Dict[int, int]:
        """Get sample count per month."""
        if not isinstance(df.index, pd.DatetimeIndex):
            return {}

        return df.groupby(df.index.month).size().to_dict()

    def select_for_inverter(
        self,
        df: pd.DataFrame,
        inverter_col: str,
        irradiance_col: str,
        inverter_nominal_kw: Optional[float] = None,
    ) -> SelectionResult:
        """
        Select training data for a specific inverter.

        Parameters:
        -----------
        df : pd.DataFrame
            Full dataset
        inverter_col : str
            Column name for this inverter's power
        irradiance_col : str
            Column name for irradiance
        inverter_nominal_kw : float
            Nominal power for this inverter (for PR calculation)

        Returns:
        --------
        SelectionResult
            Selected data for this inverter
        """
        # Update nominal power for this inverter
        if inverter_nominal_kw:
            self.nominal_power_kw = inverter_nominal_kw

        return self.select_training_data(
            df=df,
            power_col=inverter_col,
            irradiance_col=irradiance_col,
        )


def identify_training_columns(
    df: pd.DataFrame,
    inverter_pattern: str = r'INV\s*\d+\.\d+'
) -> Dict[str, Any]:
    """
    Identify relevant columns for training from DataFrame.

    Parameters:
    -----------
    df : pd.DataFrame
        Input DataFrame
    inverter_pattern : str
        Regex pattern for inverter columns. Default matches:
        - "INV 01.001" (simplified)
        - "INV 01.001 / Power" (with suffix)
        - "INV01.001" (no space)

    Returns:
    --------
    Dict with identified column mappings
    """
    columns = df.columns.tolist()

    # Find inverter columns - match INV XX.XXX pattern (with or without Power suffix)
    inv_pattern = re.compile(inverter_pattern, re.IGNORECASE)
    inverter_cols = [col for col in columns if inv_pattern.search(col)]

    # Find irradiance column
    irr_patterns = ['Irradiation', 'irradiance', 'GHI', 'POA', 'Radiation']
    irradiance_col = None
    for pattern in irr_patterns:
        matches = [c for c in columns if pattern.lower() in c.lower() and 'INV' not in c]
        if matches:
            irradiance_col = matches[0]
            break

    # Find temperature columns
    temp_patterns = ['Ambient', 'Module', 'Temp']
    ambient_col = None
    module_col = None
    for col in columns:
        col_lower = col.lower()
        if 'ambient' in col_lower and 'temp' in col_lower:
            ambient_col = col
        elif 'module' in col_lower and 'temp' in col_lower:
            module_col = col

    # Find timestamp column
    timestamp_col = None
    for col in columns:
        if col.lower() in ['timestamp', 'datetime', 'time', 'date']:
            timestamp_col = col
            break

    return {
        'inverter_columns': inverter_cols,
        'irradiance_column': irradiance_col,
        'ambient_temp_column': ambient_col,
        'module_temp_column': module_col,
        'timestamp_column': timestamp_col,
        'total_columns': len(columns),
    }


def extract_inverter_id(col_name: str) -> Tuple[str, str]:
    """
    Extract inverter ID and group from column name.

    Parameters:
    -----------
    col_name : str
        Column name like "INV 04.104 / Power"

    Returns:
    --------
    Tuple[str, str]
        (inverter_id, group_id)
    """
    match = re.search(r'INV\s*(\d+)\.(\d+)', col_name)
    if match:
        group = f"INV {match.group(1).zfill(2)}"
        inv_id = f"INV {match.group(1).zfill(2)}.{match.group(2).zfill(3)}"
        return inv_id, group
    return col_name, "Unknown"


class EnhancedDataSelector(DigitalTwinDataSelector):
    """
    Enhanced data selector with multi-stage normal data filtering.

    Combines the original time-period and PR filtering with
    physics-based normal operation detection to remove fault data.
    """

    def __init__(
        self,
        criteria: Optional[SelectionCriteria] = None,
        nominal_power_kw: Optional[float] = None,
        apply_normal_filter: bool = True,
    ):
        """
        Initialize enhanced data selector.

        Parameters:
        -----------
        criteria : SelectionCriteria
            Selection criteria
        nominal_power_kw : float
            Nominal inverter power for PR calculation
        apply_normal_filter : bool
            Whether to apply physics-based normal data filtering
        """
        super().__init__(criteria, nominal_power_kw)
        self.apply_normal_filter = apply_normal_filter
        self._normal_filter = None

    def select_training_data(
        self,
        df: pd.DataFrame,
        power_col: str,
        irradiance_col: str,
        timestamp_col: Optional[str] = None,
        temperature_col: Optional[str] = None,
    ) -> SelectionResult:
        """
        Select optimal training data with enhanced filtering.

        Steps:
        1. Time period selection (first N years)
        2. Daylight filtering
        3. PR filtering
        4. Quality scoring
        5. Seasonal balancing
        6. Normal data filtering (physics-based)

        Parameters:
        -----------
        df : pd.DataFrame
            Input data
        power_col : str
            Power column name
        irradiance_col : str
            Irradiance column name
        timestamp_col : str
            Timestamp column name
        temperature_col : str
            Temperature column name (optional)

        Returns:
        --------
        SelectionResult
            Selected data with metadata
        """
        # Run base selection first
        result = super().select_training_data(
            df, power_col, irradiance_col, timestamp_col
        )

        # Apply normal data filtering if enabled
        if self.apply_normal_filter and len(result.df) > 100:
            try:
                from .normal_data_filter import NormalDataFilter, FilterConfig

                logger.info("Applying physics-based normal data filtering...")

                # Configure filter
                config = FilterConfig(
                    min_irradiance=self.criteria.min_irradiance,
                    pr_min=0.5,
                    pr_max=1.05,
                )

                self._normal_filter = NormalDataFilter(
                    config=config,
                    p_rated=self.nominal_power_kw,
                )

                # Apply multi-stage filtering
                filter_result = self._normal_filter.select_normal_training_data(
                    result.df,
                    irradiance_col=irradiance_col,
                    power_col=power_col,
                    temperature_col=temperature_col,
                    apply_variability=True,
                    apply_clustering=len(result.df) > 500,
                )

                # Update result with filtered data
                filtered_df = result.df[filter_result.mask]

                logger.info(
                    f"Normal filter: {len(filtered_df)}/{len(result.df)} samples kept "
                    f"({100*filter_result.retention_ratio:.1f}%)"
                )

                # Update result
                result = SelectionResult(
                    df=filtered_df,
                    n_samples=len(filtered_df),
                    date_range=(
                        str(filtered_df.index.min())[:10] if len(filtered_df) > 0 else '',
                        str(filtered_df.index.max())[:10] if len(filtered_df) > 0 else ''
                    ),
                    quality_score=filtered_df['quality_score'].mean() if 'quality_score' in filtered_df.columns else 0.5,
                    seasonal_coverage=self._get_seasonal_coverage(filtered_df),
                    selection_ratio=len(filtered_df) / len(df) if len(df) > 0 else 0,
                )

            except ImportError:
                logger.warning("Normal data filter not available, using base selection")
            except Exception as e:
                logger.warning(f"Normal data filtering failed: {e}")

        return result

    def validate_selection(
        self,
        df: pd.DataFrame,
        result: SelectionResult,
        power_col: str,
        irradiance_col: str,
    ) -> Dict[str, Any]:
        """
        Validate the data selection.

        Parameters:
        -----------
        df : pd.DataFrame
            Original data
        result : SelectionResult
            Selection result
        power_col : str
            Power column name
        irradiance_col : str
            Irradiance column name

        Returns:
        --------
        Dict
            Validation results
        """
        try:
            from .validation import NormalDataValidator

            validator = NormalDataValidator(p_rated=self.nominal_power_kw)

            # Create mask from result
            mask = df.index.isin(result.df.index)

            validation_result = validator.validate(
                df, mask, irradiance_col, power_col
            )

            return {
                'valid': validation_result.valid,
                'score': validation_result.score,
                'checks': validation_result.checks,
                'warnings': validation_result.warnings,
                'errors': validation_result.errors,
            }

        except ImportError:
            logger.warning("Validation module not available")
            return {'valid': True, 'score': 1.0, 'checks': {}, 'warnings': [], 'errors': []}


def create_enhanced_selector(
    nominal_power_kw: Optional[float] = None,
    max_years: float = 3.0,
    min_pr: float = 0.10,
    apply_normal_filter: bool = True,
) -> EnhancedDataSelector:
    """
    Create an enhanced data selector with sensible defaults.

    Parameters:
    -----------
    nominal_power_kw : float
        Nominal inverter power
    max_years : float
        Maximum years of data to use
    min_pr : float
        Minimum performance ratio
    apply_normal_filter : bool
        Whether to apply physics-based normal filtering

    Returns:
    --------
    EnhancedDataSelector
        Configured selector
    """
    criteria = SelectionCriteria(
        max_years=max_years,
        min_pr=min_pr,
    )

    return EnhancedDataSelector(
        criteria=criteria,
        nominal_power_kw=nominal_power_kw,
        apply_normal_filter=apply_normal_filter,
    )
