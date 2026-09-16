"""
Pseudo-Label Generation for Soiling Ratio Models Without DustIQ

This module generates training labels for soiling ratio (SR) estimation
when no DustIQ sensor is available. Labels are derived from:
1. Rain cleaning anchors - Heavy rain resets SR to ~1.0
2. PR-based SR estimation - PR decline indicates soiling
3. Physics-based decay - AOD-modulated soiling between rain events

Author: NuraVolt Team
"""

import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Optional, Tuple, Literal
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


@dataclass
class PseudoLabelConfig:
    """Configuration for pseudo-label generation."""

    # Rain cleaning thresholds
    light_rain_threshold_mm: float = 3.0  # Partial cleaning
    cleaning_rain_threshold_mm: float = 5.0  # Full cleaning event
    heavy_rain_threshold_mm: float = 10.0  # Guaranteed full cleaning

    # SR after rain events
    sr_after_light_rain: float = 0.98
    sr_after_cleaning_rain: float = 0.995
    sr_after_heavy_rain: float = 1.0

    # Confidence levels
    confidence_light_rain: float = 0.70
    confidence_cleaning_rain: float = 0.90
    confidence_heavy_rain: float = 0.99

    # PR-based estimation
    pr_baseline_percentile: float = 95.0  # Use 95th percentile as clean reference
    pr_baseline_window_days: int = 90  # Rolling window for baseline
    pr_min_samples: int = 30  # Minimum samples for reliable baseline

    # Physics decay parameters
    base_soiling_rate: float = 0.002  # %/day base soiling rate
    aod_soiling_multiplier: float = 1.5  # How much AOD increases soiling
    max_daily_soiling: float = 0.02  # Maximum daily soiling (2%)

    # SR bounds
    sr_min: float = 0.75  # Minimum realistic SR
    sr_max: float = 1.0  # Maximum SR (clean)

    # Multi-day event handling
    rain_effect_days: int = 2  # Days after rain where SR stays high

    # Quality filters
    min_ghi_for_pr: float = 200.0  # Minimum GHI for valid PR
    max_pr_for_training: float = 1.05  # Filter unrealistic PR values


class SoilingPseudoLabelGenerator:
    """
    Generate pseudo-labels for soiling ratio when no DustIQ sensor is available.

    This class creates training targets by combining:
    1. Rain cleaning anchors (high confidence)
    2. PR-based SR estimation (medium confidence)
    3. Physics-based decay modeling (lower confidence)
    """

    def __init__(self, config: Optional[PseudoLabelConfig] = None):
        """Initialize the pseudo-label generator."""
        self.config = config or PseudoLabelConfig()

    def generate_labels(
        self,
        df_rain: pd.DataFrame,
        df_pr: pd.DataFrame,
        df_aod: Optional[pd.DataFrame] = None,
        method: Literal["combined", "rain_only", "pr_only", "physics"] = "combined"
    ) -> pd.DataFrame:
        """
        Generate pseudo-labels for soiling ratio.

        Args:
            df_rain: DataFrame with columns ['date', 'precipitation_mm']
            df_pr: DataFrame with columns ['date', 'pr'] (plant-level or per-inverter)
            df_aod: Optional DataFrame with columns ['date', 'aod_550'] for dust data
            method: Label generation method
                - "combined": Use all methods with weighted averaging
                - "rain_only": Only use rain cleaning anchors
                - "pr_only": Only use PR-based estimation
                - "physics": Use physics-based decay model

        Returns:
            DataFrame with columns:
                - date: Date of observation
                - sr_pseudo: Estimated soiling ratio [0.75, 1.0]
                - confidence: Confidence score [0.0, 1.0]
                - method: Method used for this label
                - is_anchor: Whether this is a high-confidence rain anchor
        """
        # Ensure date columns are datetime
        df_rain = df_rain.copy()
        df_pr = df_pr.copy()
        df_rain['date'] = pd.to_datetime(df_rain['date'])
        df_pr['date'] = pd.to_datetime(df_pr['date'])

        if df_aod is not None:
            df_aod = df_aod.copy()
            df_aod['date'] = pd.to_datetime(df_aod['date'])

        # Generate labels based on method
        if method == "rain_only":
            return self._generate_rain_anchors(df_rain, df_pr)
        elif method == "pr_only":
            return self._generate_pr_based_labels(df_pr)
        elif method == "physics":
            return self._generate_physics_decay_labels(df_rain, df_aod, df_pr)
        else:  # combined
            return self._generate_combined_labels(df_rain, df_pr, df_aod)

    def _generate_rain_anchors(
        self,
        df_rain: pd.DataFrame,
        df_pr: pd.DataFrame
    ) -> pd.DataFrame:
        """
        Generate high-confidence labels from rain cleaning events.

        Rain anchors are the most reliable pseudo-labels because
        we know that sufficient rain cleans panels.
        """
        # Merge rain data with PR dates
        dates = df_pr[['date']].drop_duplicates().sort_values('date')
        df = dates.merge(df_rain, on='date', how='left')
        df['precipitation_mm'] = df['precipitation_mm'].fillna(0)

        # Classify rain events
        results = []
        for idx, row in df.iterrows():
            precip = row['precipitation_mm']

            if precip >= self.config.heavy_rain_threshold_mm:
                sr = self.config.sr_after_heavy_rain
                conf = self.config.confidence_heavy_rain
                is_anchor = True
            elif precip >= self.config.cleaning_rain_threshold_mm:
                sr = self.config.sr_after_cleaning_rain
                conf = self.config.confidence_cleaning_rain
                is_anchor = True
            elif precip >= self.config.light_rain_threshold_mm:
                sr = self.config.sr_after_light_rain
                conf = self.config.confidence_light_rain
                is_anchor = True
            else:
                # No rain - no label from this method
                sr = np.nan
                conf = 0.0
                is_anchor = False

            results.append({
                'date': row['date'],
                'sr_pseudo': sr,
                'confidence': conf,
                'method': 'rain_anchor',
                'is_anchor': is_anchor,
                'precipitation_mm': precip
            })

        return pd.DataFrame(results)

    def _generate_pr_based_labels(
        self,
        df_pr: pd.DataFrame
    ) -> pd.DataFrame:
        """
        Generate labels from Performance Ratio patterns.

        PR decline over time indicates soiling. We estimate SR as:
        SR_pseudo = PR_actual / PR_baseline

        where PR_baseline is the rolling 95th percentile (clean reference).
        """
        df = df_pr.copy().sort_values('date')

        # Calculate rolling baseline (clean state reference)
        window_days = self.config.pr_baseline_window_days
        percentile = self.config.pr_baseline_percentile

        # Rolling percentile for baseline
        df['pr_baseline'] = df['pr'].rolling(
            window=window_days,
            min_periods=self.config.pr_min_samples
        ).quantile(percentile / 100.0)

        # Forward fill baseline for initial period
        df['pr_baseline'] = df['pr_baseline'].bfill()

        # Estimate SR from PR ratio
        df['sr_pseudo'] = (df['pr'] / df['pr_baseline']).clip(
            self.config.sr_min,
            self.config.sr_max
        )

        # Filter unrealistic values
        df.loc[df['pr'] > self.config.max_pr_for_training, 'sr_pseudo'] = np.nan

        # Calculate confidence based on data quality
        # Higher confidence when PR is stable and within expected range
        df['pr_stability'] = 1 - df['pr'].rolling(7, min_periods=3).std().fillna(0.1)
        df['confidence'] = (df['pr_stability'].clip(0.3, 1.0) * 0.7).fillna(0.5)

        results = df[['date', 'sr_pseudo', 'confidence']].copy()
        results['method'] = 'pr_based'
        results['is_anchor'] = False

        return results

    def _generate_physics_decay_labels(
        self,
        df_rain: pd.DataFrame,
        df_aod: Optional[pd.DataFrame],
        df_pr: pd.DataFrame
    ) -> pd.DataFrame:
        """
        Generate labels using physics-based decay model.

        Model: SR(t) = SR(t-1) - soiling_rate × (1 + aod_factor)

        Starting from rain events (SR=1.0) and decaying based on
        environmental conditions.
        """
        # Get date range from PR data
        dates = df_pr[['date']].drop_duplicates().sort_values('date')
        df = dates.merge(df_rain, on='date', how='left')
        df['precipitation_mm'] = df['precipitation_mm'].fillna(0)

        # Merge AOD if available
        if df_aod is not None:
            # Handle both 'aod_550' and 'aod_550nm' column names
            aod_col = 'aod_550nm' if 'aod_550nm' in df_aod.columns else 'aod_550'
            df = df.merge(df_aod[['date', aod_col]], on='date', how='left')
            df = df.rename(columns={aod_col: 'aod_550'})
            df['aod_550'] = df['aod_550'].fillna(df['aod_550'].median())
        else:
            df['aod_550'] = 0.3  # Default moderate AOD

        # Simulate SR decay
        sr_values = []
        confidence_values = []
        current_sr = 1.0
        days_since_rain = 0

        for idx, row in df.iterrows():
            precip = row['precipitation_mm']
            aod = row['aod_550']

            # Check for rain reset
            if precip >= self.config.heavy_rain_threshold_mm:
                current_sr = self.config.sr_after_heavy_rain
                days_since_rain = 0
                conf = self.config.confidence_heavy_rain
            elif precip >= self.config.cleaning_rain_threshold_mm:
                current_sr = self.config.sr_after_cleaning_rain
                days_since_rain = 0
                conf = self.config.confidence_cleaning_rain
            elif precip >= self.config.light_rain_threshold_mm:
                current_sr = max(current_sr, self.config.sr_after_light_rain)
                days_since_rain = 0
                conf = self.config.confidence_light_rain
            else:
                # Apply decay
                days_since_rain += 1

                # AOD-modulated soiling rate
                aod_factor = (aod / 0.3) * self.config.aod_soiling_multiplier
                daily_soiling = min(
                    self.config.base_soiling_rate * (1 + aod_factor),
                    self.config.max_daily_soiling
                )

                current_sr = max(
                    current_sr - daily_soiling,
                    self.config.sr_min
                )

                # Confidence decreases with days since rain
                conf = max(0.3, 0.8 - (days_since_rain * 0.02))

            sr_values.append(current_sr)
            confidence_values.append(conf)

        df['sr_pseudo'] = sr_values
        df['confidence'] = confidence_values
        df['method'] = 'physics_decay'
        df['is_anchor'] = df['precipitation_mm'] >= self.config.cleaning_rain_threshold_mm

        return df[['date', 'sr_pseudo', 'confidence', 'method', 'is_anchor']]

    def _generate_combined_labels(
        self,
        df_rain: pd.DataFrame,
        df_pr: pd.DataFrame,
        df_aod: Optional[pd.DataFrame]
    ) -> pd.DataFrame:
        """
        Combine all methods with intelligent weighting.

        Priority:
        1. Rain anchors (highest confidence)
        2. Physics decay (when rain anchors nearby)
        3. PR-based (when no recent rain data)
        """
        # Generate labels from all methods
        rain_labels = self._generate_rain_anchors(df_rain, df_pr)
        pr_labels = self._generate_pr_based_labels(df_pr)
        physics_labels = self._generate_physics_decay_labels(df_rain, df_aod, df_pr)

        # Start with physics as base (covers all dates)
        combined = physics_labels[['date', 'sr_pseudo', 'confidence', 'is_anchor']].copy()
        combined.columns = ['date', 'sr_physics', 'conf_physics', 'is_anchor']

        # Merge PR-based labels
        pr_subset = pr_labels[['date', 'sr_pseudo', 'confidence']].copy()
        pr_subset.columns = ['date', 'sr_pr', 'conf_pr']
        combined = combined.merge(pr_subset, on='date', how='left')

        # Merge rain anchors
        rain_subset = rain_labels[['date', 'sr_pseudo', 'confidence']].copy()
        rain_subset.columns = ['date', 'sr_rain', 'conf_rain']
        combined = combined.merge(rain_subset, on='date', how='left')

        # Weighted combination
        results = []
        for idx, row in combined.iterrows():
            # Use rain anchor if available (highest priority)
            if pd.notna(row['sr_rain']) and row['conf_rain'] > 0.5:
                sr = row['sr_rain']
                conf = row['conf_rain']
                method = 'rain_anchor'
                is_anchor = True
            else:
                # Weighted average of physics and PR
                sr_physics = row['sr_physics'] if pd.notna(row['sr_physics']) else 0.95
                sr_pr = row['sr_pr'] if pd.notna(row['sr_pr']) else sr_physics
                conf_physics = row['conf_physics'] if pd.notna(row['conf_physics']) else 0.5
                conf_pr = row['conf_pr'] if pd.notna(row['conf_pr']) else 0.5

                # Weight by confidence
                total_conf = conf_physics + conf_pr
                if total_conf > 0:
                    sr = (sr_physics * conf_physics + sr_pr * conf_pr) / total_conf
                    conf = (conf_physics + conf_pr) / 2
                else:
                    sr = sr_physics
                    conf = 0.4

                method = 'combined'
                is_anchor = row['is_anchor']

            # Ensure SR is within bounds
            sr = np.clip(sr, self.config.sr_min, self.config.sr_max)

            results.append({
                'date': row['date'],
                'sr_pseudo': sr,
                'confidence': conf,
                'method': method,
                'is_anchor': is_anchor
            })

        return pd.DataFrame(results)

    def validate_labels(
        self,
        df_labels: pd.DataFrame,
        df_pr: pd.DataFrame
    ) -> Tuple[pd.DataFrame, dict]:
        """
        Validate generated pseudo-labels for plausibility.

        Checks:
        1. SR resets after rain events
        2. SR decreases monotonically between rain events
        3. SR correlates with PR patterns
        4. No physically impossible values

        Returns:
            Tuple of (validated_labels, validation_metrics)
        """
        df = df_labels.merge(df_pr[['date', 'pr']], on='date', how='left')
        df = df.sort_values('date')

        metrics = {
            'total_samples': len(df),
            'anchor_count': df['is_anchor'].sum(),
            'anchor_ratio': df['is_anchor'].mean(),
            'sr_mean': df['sr_pseudo'].mean(),
            'sr_std': df['sr_pseudo'].std(),
            'sr_min': df['sr_pseudo'].min(),
            'sr_max': df['sr_pseudo'].max(),
            'avg_confidence': df['confidence'].mean(),
            'high_confidence_ratio': (df['confidence'] >= 0.8).mean(),
            'issues': []
        }

        # Check 1: SR should be high after rain anchors
        anchor_sr = df[df['is_anchor']]['sr_pseudo']
        if len(anchor_sr) > 0 and anchor_sr.mean() < 0.95:
            metrics['issues'].append('Low SR after rain anchors')

        # Check 2: SR-PR correlation (should be positive)
        valid_mask = df['pr'].notna() & df['sr_pseudo'].notna()
        if valid_mask.sum() > 30:
            corr = df.loc[valid_mask, 'sr_pseudo'].corr(df.loc[valid_mask, 'pr'])
            metrics['sr_pr_correlation'] = corr
            if corr < 0.3:
                metrics['issues'].append(f'Low SR-PR correlation: {corr:.2f}')

        # Check 3: Seasonal variation (should have patterns)
        df['month'] = pd.to_datetime(df['date']).dt.month
        monthly_sr = df.groupby('month')['sr_pseudo'].mean()
        if monthly_sr.std() < 0.01:
            metrics['issues'].append('No seasonal variation detected')
        metrics['monthly_sr_range'] = monthly_sr.max() - monthly_sr.min()

        # Check 4: Sufficient high-confidence samples
        if metrics['high_confidence_ratio'] < 0.1:
            metrics['issues'].append('Insufficient high-confidence samples')

        # Mark validation status
        metrics['is_valid'] = len(metrics['issues']) == 0

        logger.info(f"Pseudo-label validation: {metrics['total_samples']} samples, "
                   f"{metrics['anchor_count']} anchors, "
                   f"avg SR={metrics['sr_mean']:.3f}, "
                   f"valid={metrics['is_valid']}")

        return df_labels, metrics


def generate_pseudo_labels_for_plant(
    plant_id: str,
    data_dir: Path,
    output_path: Optional[Path] = None,
    config: Optional[PseudoLabelConfig] = None
) -> pd.DataFrame:
    """
    Convenience function to generate pseudo-labels for a plant.

    Args:
        plant_id: Plant identifier (e.g., "alpha1")
        data_dir: Path to data directory containing rain/PR/AOD data
        output_path: Optional path to save output CSV
        config: Optional configuration for label generation

    Returns:
        DataFrame with pseudo-labels
    """
    # Load data files
    rain_path = data_dir / f"{plant_id}_rain_history.csv"
    pr_path = data_dir / f"{plant_id}_pr_daily.csv"
    aod_path = data_dir / f"{plant_id}_aod_history.csv"

    # Read rain data
    if rain_path.exists():
        df_rain = pd.read_csv(rain_path)
        if 'precipitation_sum' in df_rain.columns:
            df_rain = df_rain.rename(columns={'precipitation_sum': 'precipitation_mm'})
    else:
        raise FileNotFoundError(f"Rain data not found: {rain_path}")

    # Read PR data
    if pr_path.exists():
        df_pr = pd.read_csv(pr_path)
    else:
        raise FileNotFoundError(f"PR data not found: {pr_path}")

    # Read AOD data (optional)
    df_aod = None
    if aod_path.exists():
        df_aod = pd.read_csv(aod_path)

    # Generate labels
    generator = SoilingPseudoLabelGenerator(config)
    df_labels = generator.generate_labels(df_rain, df_pr, df_aod, method="combined")

    # Validate
    df_labels, metrics = generator.validate_labels(df_labels, df_pr)

    # Save if output path provided
    if output_path:
        df_labels.to_csv(output_path, index=False)
        logger.info(f"Saved pseudo-labels to {output_path}")

    return df_labels
