"""Inverter selection for zone-representative transfer learning.

Selects the best inverter(s) per zone for training soiling models based on:
- Data completeness (>90% preferred)
- Anomaly rate (low is better)
- Position in array (middle positions preferred over edges)
- DustIQ correlation (for plants with sensors)

The goal is to select inverters whose performance best represents
the zone's actual soiling behavior, avoiding edge effects and data quality issues.

Example usage:
    selector = InverterSelector(plant_id="epsilon")
    best_per_zone = selector.select_best_per_zone()
    # {'zone_a': 'INV_003', 'zone_b': 'INV_012'}
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class InverterQuality:
    """Quality metrics for a single inverter."""

    inverter_id: str
    zone: Optional[str] = None

    # Data quality metrics (0-1 scale)
    data_completeness: float = 0.0  # Fraction of expected data points
    anomaly_rate: float = 0.0       # Fraction of anomalous readings

    # Performance metrics
    dustiq_correlation: Optional[float] = None  # Correlation with DustIQ (if available)
    twin_residual_std: Optional[float] = None   # Std of physics residual (lower is better)

    # Position metrics
    position_score: float = 1.0     # 1.0 for middle, lower for edges
    row_position: Optional[int] = None
    string_position: Optional[int] = None

    @property
    def overall_score(self) -> float:
        """Compute overall quality score (higher is better)."""
        score = 0.0

        # Data completeness (0-1, weight: 0.35)
        score += 0.35 * self.data_completeness

        # Low anomaly rate (0-1, weight: 0.25)
        score += 0.25 * (1 - self.anomaly_rate)

        # Position (0-1, weight: 0.15)
        score += 0.15 * self.position_score

        # DustIQ correlation (0-1, weight: 0.25 if available)
        if self.dustiq_correlation is not None:
            score += 0.25 * max(0, self.dustiq_correlation)  # Only positive correlation
        else:
            # Redistribute weight to other factors if no DustIQ
            score += 0.10 * self.data_completeness
            score += 0.10 * (1 - self.anomaly_rate)
            score += 0.05 * self.position_score

        return score

    def is_qualified(
        self,
        min_completeness: float = 0.90,
        max_anomaly_rate: float = 0.05,
    ) -> bool:
        """Check if inverter meets minimum quality thresholds."""
        return (
            self.data_completeness >= min_completeness
            and self.anomaly_rate <= max_anomaly_rate
        )


@dataclass
class ZoneConfig:
    """Configuration for a plant zone."""

    zone_id: str
    zone_name: str
    inverter_pattern: str  # Regex pattern for matching inverter IDs
    inverter_ids: List[str] = field(default_factory=list)
    capacity_kw: float = 0.0


class InverterSelector:
    """Select representative inverters per zone for training.

    Uses quality metrics to identify the best inverters for each zone:
    - Avoids edge inverters (more shading, different thermal behavior)
    - Prefers high data completeness (>90%)
    - Excludes high anomaly rate inverters (>5%)
    - Prioritizes DustIQ correlation when available

    Example:
        selector = InverterSelector("epsilon")
        quality = selector.compute_quality_metrics(df_scada)
        best = selector.select_best_per_zone(quality)
    """

    def __init__(
        self,
        plant_id: str,
        zones: Optional[List[ZoneConfig]] = None,
        min_completeness: float = 0.90,
        max_anomaly_rate: float = 0.05,
    ):
        """Initialize inverter selector.

        Args:
            plant_id: Plant identifier
            zones: Optional zone configuration (auto-detects if not provided)
            min_completeness: Minimum data completeness threshold
            max_anomaly_rate: Maximum anomaly rate threshold
        """
        self.plant_id = plant_id
        self.zones = zones
        self.min_completeness = min_completeness
        self.max_anomaly_rate = max_anomaly_rate
        self._quality_cache: Dict[str, InverterQuality] = {}

    def compute_quality_metrics(
        self,
        df_scada: pd.DataFrame,
        inverter_cols: List[str],
        expected_records: Optional[int] = None,
        dustiq_sr: Optional[pd.Series] = None,
    ) -> Dict[str, InverterQuality]:
        """Compute quality metrics for all inverters.

        Args:
            df_scada: SCADA DataFrame with inverter power columns
            inverter_cols: List of column names for inverter power
            expected_records: Expected number of records (for completeness calc)
            dustiq_sr: Optional DustIQ soiling ratio series for correlation

        Returns:
            Dict mapping inverter_id to InverterQuality
        """
        if expected_records is None:
            # Estimate from timestamp index
            if isinstance(df_scada.index, pd.DatetimeIndex):
                freq = pd.infer_freq(df_scada.index[:100])
                if freq and 'min' in str(freq).lower():
                    mins = int(''.join(filter(str.isdigit, str(freq))) or 15)
                    days = (df_scada.index.max() - df_scada.index.min()).days
                    expected_records = days * (24 * 60 // mins)
                else:
                    expected_records = len(df_scada)
            else:
                expected_records = len(df_scada)

        quality_metrics = {}

        for i, col in enumerate(inverter_cols):
            if col not in df_scada.columns:
                continue

            inv_data = df_scada[col]

            # Data completeness
            valid_count = inv_data.notna().sum()
            completeness = valid_count / expected_records

            # Anomaly rate (values outside reasonable range)
            if valid_count > 0:
                # Anomalies: negative power, extreme spikes, stuck values
                anomalies = (
                    (inv_data < 0).sum()
                    + (inv_data > inv_data.quantile(0.999) * 1.5).sum()
                    + self._count_stuck_values(inv_data)
                )
                anomaly_rate = anomalies / valid_count
            else:
                anomaly_rate = 1.0

            # Position score (assume inverters are numbered sequentially)
            n_inverters = len(inverter_cols)
            position_score = self._compute_position_score(i, n_inverters)

            # DustIQ correlation (if available)
            dustiq_corr = None
            if dustiq_sr is not None and valid_count > 100:
                # Compute PR-based SR proxy for this inverter
                inv_pr = self._compute_inverter_pr(df_scada, col)
                if inv_pr is not None:
                    # Align and correlate
                    aligned = pd.concat([inv_pr, dustiq_sr], axis=1).dropna()
                    if len(aligned) > 50:
                        dustiq_corr = aligned.iloc[:, 0].corr(aligned.iloc[:, 1])

            # Assign zone (simple heuristic based on naming)
            zone = self._infer_zone(col)

            quality_metrics[col] = InverterQuality(
                inverter_id=col,
                zone=zone,
                data_completeness=min(1.0, completeness),
                anomaly_rate=min(1.0, anomaly_rate),
                dustiq_correlation=dustiq_corr,
                position_score=position_score,
            )

        self._quality_cache = quality_metrics
        logger.info(f"Computed quality metrics for {len(quality_metrics)} inverters")

        return quality_metrics

    def select_best_per_zone(
        self,
        quality_metrics: Optional[Dict[str, InverterQuality]] = None,
        n_per_zone: int = 1,
    ) -> Dict[str, List[str]]:
        """Select best inverter(s) per zone.

        Args:
            quality_metrics: Quality metrics dict (uses cache if not provided)
            n_per_zone: Number of inverters to select per zone

        Returns:
            Dict mapping zone_name to list of selected inverter_ids
        """
        metrics = quality_metrics or self._quality_cache
        if not metrics:
            raise ValueError("No quality metrics available. Run compute_quality_metrics first.")

        # Group by zone
        zones: Dict[str, List[InverterQuality]] = {}
        for inv_qual in metrics.values():
            zone = inv_qual.zone or "default"
            if zone not in zones:
                zones[zone] = []
            zones[zone].append(inv_qual)

        selections = {}

        for zone_name, inverters in zones.items():
            # Filter to qualified inverters
            qualified = [
                inv for inv in inverters
                if inv.is_qualified(self.min_completeness, self.max_anomaly_rate)
            ]

            if not qualified:
                # Fallback: use best available even if below thresholds
                logger.warning(
                    f"No qualified inverters in zone {zone_name}, "
                    f"using best available"
                )
                qualified = inverters

            # Sort by overall score (descending)
            qualified.sort(key=lambda x: x.overall_score, reverse=True)

            # Select top N
            selected = [inv.inverter_id for inv in qualified[:n_per_zone]]
            selections[zone_name] = selected

            logger.info(
                f"Zone {zone_name}: selected {selected} "
                f"(score: {qualified[0].overall_score:.3f})"
            )

        return selections

    def select_for_transfer_learning(
        self,
        quality_metrics: Optional[Dict[str, InverterQuality]] = None,
        n_total: int = 3,
    ) -> List[str]:
        """Select best inverters for transfer learning (across all zones).

        Picks the top N inverters globally that:
        1. Represent different zones (if available)
        2. Have highest quality scores

        Args:
            quality_metrics: Quality metrics dict
            n_total: Total number of inverters to select

        Returns:
            List of selected inverter_ids
        """
        metrics = quality_metrics or self._quality_cache
        if not metrics:
            raise ValueError("No quality metrics available.")

        # First, select best per zone
        zone_selections = self.select_best_per_zone(metrics, n_per_zone=1)

        # Collect zone representatives
        zone_reps = []
        for zone, inverters in zone_selections.items():
            if inverters:
                zone_reps.append(inverters[0])

        # If we have enough zone representatives, use them
        if len(zone_reps) >= n_total:
            return zone_reps[:n_total]

        # Otherwise, fill with next best inverters
        all_inverters = sorted(
            metrics.values(),
            key=lambda x: x.overall_score,
            reverse=True
        )

        selected = zone_reps.copy()
        for inv in all_inverters:
            if inv.inverter_id not in selected:
                selected.append(inv.inverter_id)
                if len(selected) >= n_total:
                    break

        return selected

    def validate_against_dustiq(
        self,
        df_scada: pd.DataFrame,
        dustiq_sr: pd.Series,
        inverter_cols: List[str],
    ) -> pd.DataFrame:
        """Validate inverter selection against DustIQ measurements.

        For plants with DustIQ, compute correlation between each inverter's
        PR-based SR estimate and DustIQ measurements.

        Args:
            df_scada: SCADA DataFrame
            dustiq_sr: DustIQ soiling ratio series (daily)
            inverter_cols: List of inverter power column names

        Returns:
            DataFrame with inverter_id, correlation, and rank
        """
        results = []

        for col in inverter_cols:
            if col not in df_scada.columns:
                continue

            # Compute PR-based SR proxy
            inv_pr = self._compute_inverter_pr(df_scada, col)
            if inv_pr is None:
                continue

            # Daily average
            inv_pr_daily = inv_pr.resample('D').mean()

            # Align with DustIQ
            aligned = pd.concat([inv_pr_daily, dustiq_sr], axis=1).dropna()
            if len(aligned) < 30:
                continue

            # Compute correlations
            pearson = aligned.iloc[:, 0].corr(aligned.iloc[:, 1])
            spearman = aligned.iloc[:, 0].corr(aligned.iloc[:, 1], method='spearman')

            # Compute MAE if treated as SR estimate
            mae = (aligned.iloc[:, 0] - aligned.iloc[:, 1]).abs().mean()

            results.append({
                'inverter_id': col,
                'pearson_r': pearson,
                'spearman_rho': spearman,
                'mae': mae,
                'n_days': len(aligned),
            })

        if not results:
            return pd.DataFrame()

        df_results = pd.DataFrame(results)

        # Rank by correlation
        df_results['pearson_rank'] = df_results['pearson_r'].rank(ascending=False)
        df_results['spearman_rank'] = df_results['spearman_rho'].rank(ascending=False)
        df_results['mae_rank'] = df_results['mae'].rank(ascending=True)

        # Combined rank
        df_results['combined_rank'] = (
            df_results['pearson_rank']
            + df_results['spearman_rank']
            + df_results['mae_rank']
        ) / 3

        return df_results.sort_values('combined_rank')

    def get_quality_report(
        self,
        quality_metrics: Optional[Dict[str, InverterQuality]] = None,
    ) -> pd.DataFrame:
        """Generate quality report for all inverters.

        Args:
            quality_metrics: Quality metrics dict

        Returns:
            DataFrame with quality metrics per inverter
        """
        metrics = quality_metrics or self._quality_cache
        if not metrics:
            return pd.DataFrame()

        data = []
        for inv_id, qual in metrics.items():
            data.append({
                'inverter_id': inv_id,
                'zone': qual.zone,
                'data_completeness': qual.data_completeness,
                'anomaly_rate': qual.anomaly_rate,
                'position_score': qual.position_score,
                'dustiq_correlation': qual.dustiq_correlation,
                'overall_score': qual.overall_score,
                'is_qualified': qual.is_qualified(
                    self.min_completeness, self.max_anomaly_rate
                ),
            })

        return pd.DataFrame(data).sort_values('overall_score', ascending=False)

    def _count_stuck_values(
        self,
        series: pd.Series,
        min_stuck_length: int = 6,
    ) -> int:
        """Count readings that appear stuck (same value repeated)."""
        if len(series) < min_stuck_length:
            return 0

        # Find consecutive identical values
        diff = series.diff()
        is_same = (diff == 0) | diff.isna()

        # Count groups of min_stuck_length or more
        stuck_count = 0
        current_run = 0

        for same in is_same:
            if same:
                current_run += 1
            else:
                if current_run >= min_stuck_length:
                    stuck_count += current_run
                current_run = 0

        # Don't forget last run
        if current_run >= min_stuck_length:
            stuck_count += current_run

        return stuck_count

    def _compute_position_score(self, index: int, total: int) -> float:
        """Compute position score (1.0 for center, lower for edges)."""
        if total <= 1:
            return 1.0

        # Normalize to 0-1 range (0 = edge, 1 = center)
        center = (total - 1) / 2
        distance_from_center = abs(index - center)
        max_distance = center

        if max_distance == 0:
            return 1.0

        # Score: 1.0 at center, 0.5 at edges
        return 0.5 + 0.5 * (1 - distance_from_center / max_distance)

    def _infer_zone(self, inverter_id: str) -> str:
        """Infer zone from inverter naming convention."""
        # Common patterns: INV_A_001, INV_001_A, Zone1_INV001, etc.
        inv_id = inverter_id.upper()

        # Check for zone letter patterns
        for zone_letter in ['A', 'B', 'C', 'D', 'E', 'F']:
            if f'_{zone_letter}_' in inv_id or f'_{zone_letter}' == inv_id[-2:]:
                return f"zone_{zone_letter.lower()}"
            if f'ZONE{zone_letter}' in inv_id or f'ZONE_{zone_letter}' in inv_id:
                return f"zone_{zone_letter.lower()}"

        # Check for zone number patterns
        for zone_num in ['1', '2', '3', '4', '5']:
            if f'ZONE{zone_num}' in inv_id or f'ZONE_{zone_num}' in inv_id:
                return f"zone_{zone_num}"

        return "default"

    def _compute_inverter_pr(
        self,
        df: pd.DataFrame,
        power_col: str,
        irradiance_col: str = 'irradiance',
    ) -> Optional[pd.Series]:
        """Compute performance ratio for an inverter."""
        if power_col not in df.columns:
            return None

        if irradiance_col not in df.columns:
            # Try common alternatives
            for alt in ['poa', 'ghi', 'irradiance_wm2', 'poa_actual']:
                if alt in df.columns:
                    irradiance_col = alt
                    break
            else:
                return None

        # Filter valid data
        mask = (df[power_col] > 0) & (df[irradiance_col] > 50)
        if mask.sum() < 100:
            return None

        # Simple PR: power / (irradiance / 1000 * estimated_capacity)
        power = df.loc[mask, power_col]
        irradiance = df.loc[mask, irradiance_col]

        # Estimate capacity from max power
        capacity = power.quantile(0.99)
        if capacity <= 0:
            return None

        pr = power / (irradiance / 1000 * capacity)
        pr = pr.clip(0.5, 1.05)  # Reasonable PR range

        return pr
