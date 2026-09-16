"""Per-inverter feature engineering for soiling ratio ML prediction.

This module extends the plant-level feature engineering with inverter-specific
features, enabling per-inverter SR estimation using a shared model.

Features include:
- Inverter identification (group, position)
- Per-inverter Performance Ratio (PR)
- Inverter-specific anomaly history
- Fleet-relative performance metrics
"""

import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import json


@dataclass
class InverterMetadata:
    """Metadata for a single inverter."""
    inverter_id: str
    group_id: str
    position_in_group: int
    sr_baseline: float = 0.98
    anomaly_rate: float = 0.0
    performance_rank: int = 1
    z_score: float = 0.0


class PerInverterFeatureEngineer:
    """Feature engineering for per-inverter SR prediction.

    Extends plant-level features with inverter-specific data:
    - Inverter group encoding (categorical)
    - Position within group
    - Per-inverter PR (lagging soiling indicator)
    - Historical anomaly rate
    - Fleet-relative performance

    Design Principles:
    - All features are per-inverter per-day
    - Inverter features capture individual behavior patterns
    - Fleet comparison identifies relative soiling
    """

    # Inverter groups for ALPHA1 (can be extended for other plants)
    INVERTER_GROUPS = ['INV 01', 'INV 02', 'INV 03', 'INV 04', 'INV 05']

    def __init__(self, plant_id: str = "alpha1"):
        """
        Initialize per-inverter feature engineer.

        Parameters
        ----------
        plant_id : str
            Plant identifier for loading inverter metadata
        """
        self.plant_id = plant_id
        self.inverter_metadata: Dict[str, InverterMetadata] = {}
        self.feature_names: List[str] = []

    def load_inverter_metadata(
        self,
        inverters_dir: str = None,
        all_inverters_path: str = None
    ) -> None:
        """
        Load inverter metadata from JSON files.

        Parameters
        ----------
        inverters_dir : str, optional
            Path to directory containing individual inverter JSON files
        all_inverters_path : str, optional
            Path to all_inverters.json summary file
        """
        if all_inverters_path:
            with open(all_inverters_path, 'r') as f:
                data = json.load(f)

            for inv_data in data.get('inverters', []):
                inv_id = inv_data.get('inverterId', '').replace(' ', '_').replace('.', '_')
                group_id = inv_data.get('groupId', 'INV 01')

                # Extract position from ID (e.g., "INV 01.015" -> 15)
                position = 1
                if '.' in inv_data.get('inverterId', ''):
                    try:
                        position = int(inv_data['inverterId'].split('.')[-1])
                    except ValueError:
                        position = 1

                self.inverter_metadata[inv_id] = InverterMetadata(
                    inverter_id=inv_id,
                    group_id=group_id,
                    position_in_group=position,
                    sr_baseline=inv_data.get('soilingRatio', {}).get('median', 0.98),
                    anomaly_rate=inv_data.get('anomalyDetection', {}).get('anomalyRate_pct', 0.0),
                    performance_rank=inv_data.get('fleetComparison', {}).get('rank', 75),
                    z_score=inv_data.get('fleetComparison', {}).get('zScore', 0.0)
                )

    def expand_to_per_inverter(
        self,
        df_plant_features: pd.DataFrame,
        df_inverter_pr: pd.DataFrame,
        inverter_ids: Optional[List[str]] = None
    ) -> pd.DataFrame:
        """
        Expand plant-level features to per-inverter rows.

        Takes plant-level features (one row per day) and expands them
        to per-inverter features (N_inverters rows per day).

        Parameters
        ----------
        df_plant_features : pd.DataFrame
            Plant-level features from SoilingRatioFeatureEngineer
            Index: dates, Columns: feature values

        df_inverter_pr : pd.DataFrame
            Per-inverter daily PR data with columns:
            - date (index)
            - inverter_id
            - pr

        inverter_ids : List[str], optional
            List of inverter IDs to include. If None, uses all from metadata.

        Returns
        -------
        pd.DataFrame
            Expanded features with columns:
            - All plant-level features
            - inverter_id
            - inverter_group_encoded
            - inverter_position
            - inverter_pr_7d
            - inverter_pr_deviation
            - inverter_anomaly_rate
            - inverter_sr_baseline
        """
        if inverter_ids is None:
            inverter_ids = list(self.inverter_metadata.keys())

        if not inverter_ids:
            # Default to ALPHA1 inverters
            inverter_ids = [f"INV_{g:02d}_{i:03d}"
                           for g in range(1, 6)
                           for i in range(1, 31)]

        # Prepare PR data for lookup
        pr_lookup = self._prepare_pr_lookup(df_inverter_pr)

        # Calculate fleet PR statistics for deviation
        fleet_pr_stats = self._calculate_fleet_pr_stats(df_inverter_pr)

        # Expand rows
        expanded_rows = []
        dates = df_plant_features.index

        for date in dates:
            plant_row = df_plant_features.loc[date]

            for inv_id in inverter_ids:
                # Start with plant-level features
                row = plant_row.to_dict()

                # Add inverter identification
                row['inverter_id'] = inv_id
                row['date'] = date

                # Add inverter-specific features
                inv_features = self._create_inverter_features(
                    inv_id, date, pr_lookup, fleet_pr_stats
                )
                row.update(inv_features)

                expanded_rows.append(row)

        # Create DataFrame
        df_expanded = pd.DataFrame(expanded_rows)
        df_expanded = df_expanded.set_index(['date', 'inverter_id'])

        # Store feature names (excluding index columns)
        self.feature_names = [c for c in df_expanded.columns
                              if c not in ['date', 'inverter_id']]

        return df_expanded

    def _prepare_pr_lookup(
        self,
        df_inverter_pr: pd.DataFrame
    ) -> Dict[Tuple[str, str], Dict]:
        """
        Prepare PR data for efficient lookup.

        Returns dict: (date_str, inverter_id) -> {pr, pr_7d, pr_trend}
        """
        pr_lookup = {}

        if df_inverter_pr is None or len(df_inverter_pr) == 0:
            return pr_lookup

        # Ensure proper formatting
        if 'date' in df_inverter_pr.columns:
            df_inverter_pr = df_inverter_pr.copy()
            df_inverter_pr['date'] = pd.to_datetime(df_inverter_pr['date'])
        elif df_inverter_pr.index.name == 'date':
            df_inverter_pr = df_inverter_pr.reset_index()
            df_inverter_pr['date'] = pd.to_datetime(df_inverter_pr['date'])

        # Find PR column
        pr_col = None
        for col in ['pr', 'performance_ratio', 'PR', 'pr_mean', 'pr_daily']:
            if col in df_inverter_pr.columns:
                pr_col = col
                break

        if pr_col is None:
            return pr_lookup

        # Find inverter ID column
        inv_col = None
        for col in ['inverter_id', 'inverterId', 'inverter']:
            if col in df_inverter_pr.columns:
                inv_col = col
                break

        if inv_col is None:
            return pr_lookup

        # Calculate rolling PR per inverter
        for inv_id in df_inverter_pr[inv_col].unique():
            inv_data = df_inverter_pr[df_inverter_pr[inv_col] == inv_id].copy()
            inv_data = inv_data.sort_values('date')

            # Rolling 7-day PR
            inv_data['pr_7d'] = inv_data[pr_col].rolling(7, min_periods=1).mean()

            # PR trend (7-day)
            inv_data['pr_trend'] = inv_data[pr_col].diff(7) / 7

            # Store in lookup
            for _, row in inv_data.iterrows():
                date_str = row['date'].strftime('%Y-%m-%d')
                key = (date_str, inv_id)
                pr_lookup[key] = {
                    'pr': row[pr_col],
                    'pr_7d': row['pr_7d'],
                    'pr_trend': row['pr_trend'] if pd.notna(row['pr_trend']) else 0.0
                }

        return pr_lookup

    def _calculate_fleet_pr_stats(
        self,
        df_inverter_pr: pd.DataFrame
    ) -> Dict[str, Dict]:
        """
        Calculate fleet-level PR statistics per date.

        Returns dict: date_str -> {mean, std, median}
        """
        fleet_stats = {}

        if df_inverter_pr is None or len(df_inverter_pr) == 0:
            return fleet_stats

        # Find PR column
        pr_col = None
        for col in ['pr', 'performance_ratio', 'PR', 'pr_mean', 'pr_daily']:
            if col in df_inverter_pr.columns:
                pr_col = col
                break

        if pr_col is None:
            return fleet_stats

        # Ensure date column
        if 'date' in df_inverter_pr.columns:
            df = df_inverter_pr.copy()
            df['date'] = pd.to_datetime(df['date'])
        else:
            df = df_inverter_pr.reset_index()
            df['date'] = pd.to_datetime(df['date'])

        # Aggregate per date
        for date, group in df.groupby('date'):
            date_str = date.strftime('%Y-%m-%d')
            pr_values = group[pr_col].dropna()

            if len(pr_values) > 0:
                fleet_stats[date_str] = {
                    'mean': pr_values.mean(),
                    'std': pr_values.std() if len(pr_values) > 1 else 0.0,
                    'median': pr_values.median()
                }

        return fleet_stats

    def _create_inverter_features(
        self,
        inv_id: str,
        date: pd.Timestamp,
        pr_lookup: Dict,
        fleet_pr_stats: Dict
    ) -> Dict[str, float]:
        """
        Create inverter-specific features for a single row.

        Parameters
        ----------
        inv_id : str
            Inverter ID
        date : pd.Timestamp
            Date for the row
        pr_lookup : Dict
            Pre-computed PR data lookup
        fleet_pr_stats : Dict
            Pre-computed fleet PR statistics

        Returns
        -------
        Dict[str, float]
            Inverter feature values
        """
        features = {}
        date_str = date.strftime('%Y-%m-%d')

        # Get metadata (or use defaults)
        metadata = self.inverter_metadata.get(inv_id, InverterMetadata(
            inverter_id=inv_id,
            group_id=self._extract_group_id(inv_id),
            position_in_group=self._extract_position(inv_id)
        ))

        # 1. Group encoding (0-4 for INV 01-05)
        group_idx = self._encode_group(metadata.group_id)
        features['inverter_group_encoded'] = group_idx

        # 2. Position within group (1-30)
        features['inverter_position'] = metadata.position_in_group

        # 3. Per-inverter PR (7-day rolling)
        pr_data = pr_lookup.get((date_str, inv_id), {})
        features['inverter_pr_7d'] = pr_data.get('pr_7d', 0.85)

        # 4. PR deviation from fleet mean
        fleet_stats = fleet_pr_stats.get(date_str, {'mean': 0.85})
        inv_pr = pr_data.get('pr', 0.85)
        features['inverter_pr_deviation'] = inv_pr - fleet_stats['mean']

        # 5. PR trend (rate of change)
        features['inverter_pr_trend'] = pr_data.get('pr_trend', 0.0)

        # 6. Historical anomaly rate (static per inverter)
        features['inverter_anomaly_rate'] = metadata.anomaly_rate / 100.0

        # 7. Historical SR baseline (static per inverter)
        features['inverter_sr_baseline'] = metadata.sr_baseline

        # 8. Fleet relative performance (z-score, static)
        features['inverter_z_score'] = metadata.z_score

        return features

    def _encode_group(self, group_id: str) -> int:
        """Encode group ID as integer."""
        # Extract number from group ID (e.g., "INV 01" -> 0)
        try:
            if 'INV' in group_id:
                num = int(group_id.replace('INV', '').strip().split('.')[0])
                return num - 1  # 0-indexed
        except (ValueError, IndexError):
            pass
        return 0

    def _extract_group_id(self, inv_id: str) -> str:
        """Extract group ID from inverter ID."""
        # Handle formats like "INV_01_015" or "INV 01.015"
        parts = inv_id.replace('_', ' ').replace('.', ' ').split()
        if len(parts) >= 2:
            return f"INV {parts[1]}"
        return "INV 01"

    def _extract_position(self, inv_id: str) -> int:
        """Extract position from inverter ID."""
        # Handle formats like "INV_01_015" -> 15
        parts = inv_id.replace('_', '.').replace(' ', '.').split('.')
        if len(parts) >= 3:
            try:
                return int(parts[-1])
            except ValueError:
                pass
        return 1

    def get_feature_names(self) -> List[str]:
        """Return list of feature names after expansion."""
        return self.feature_names

    def get_inverter_feature_names(self) -> List[str]:
        """Return list of inverter-specific feature names."""
        return [
            'inverter_group_encoded',
            'inverter_position',
            'inverter_pr_7d',
            'inverter_pr_deviation',
            'inverter_pr_trend',
            'inverter_anomaly_rate',
            'inverter_sr_baseline',
            'inverter_z_score'
        ]


def load_inverter_pr_from_parquet(
    parquet_path: str,
    inverter_ids: Optional[List[str]] = None
) -> pd.DataFrame:
    """
    Load per-inverter PR data from parquet file.

    Parameters
    ----------
    parquet_path : str
        Path to parquet file with per-inverter data
    inverter_ids : List[str], optional
        List of inverter IDs to load. If None, loads all.

    Returns
    -------
    pd.DataFrame
        Per-inverter daily PR data with columns:
        - date
        - inverter_id
        - pr
    """
    import pyarrow.parquet as pq

    # Read parquet
    df = pq.read_table(parquet_path).to_pandas()

    # Handle different column naming conventions
    date_col = None
    for col in ['date', 'timestamp', 'datetime', 'time']:
        if col in df.columns:
            date_col = col
            break

    if date_col and date_col != 'date':
        df = df.rename(columns={date_col: 'date'})

    # Ensure datetime
    if 'date' in df.columns:
        df['date'] = pd.to_datetime(df['date'])

    # Filter to specific inverters if requested
    if inverter_ids is not None:
        inv_col = None
        for col in ['inverter_id', 'inverterId', 'inverter']:
            if col in df.columns:
                inv_col = col
                break

        if inv_col:
            df = df[df[inv_col].isin(inverter_ids)]

    return df


def create_per_inverter_training_data(
    df_plant_features: pd.DataFrame,
    df_inverter_pr: pd.DataFrame,
    df_targets: pd.DataFrame,
    plant_id: str = "alpha1",
    all_inverters_path: str = None
) -> Tuple[pd.DataFrame, pd.Series]:
    """
    Create per-inverter training data for SR model.

    Convenience function that combines plant features with inverter features
    and aligns with targets.

    Parameters
    ----------
    df_plant_features : pd.DataFrame
        Plant-level features from SoilingRatioFeatureEngineer
    df_inverter_pr : pd.DataFrame
        Per-inverter daily PR data
    df_targets : pd.DataFrame
        SR targets with columns: date, inverter_id, sr_target
    plant_id : str
        Plant identifier
    all_inverters_path : str, optional
        Path to all_inverters.json for metadata

    Returns
    -------
    X : pd.DataFrame
        Per-inverter feature matrix
    y : pd.Series
        Per-inverter SR targets
    """
    # Initialize feature engineer
    engineer = PerInverterFeatureEngineer(plant_id)

    # Load metadata if available
    if all_inverters_path:
        engineer.load_inverter_metadata(all_inverters_path=all_inverters_path)

    # Get inverter IDs from targets
    inv_col = None
    for col in ['inverter_id', 'inverterId']:
        if col in df_targets.columns:
            inv_col = col
            break

    inverter_ids = df_targets[inv_col].unique().tolist() if inv_col else None

    # Expand features
    X = engineer.expand_to_per_inverter(
        df_plant_features,
        df_inverter_pr,
        inverter_ids
    )

    # Prepare targets
    if 'date' in df_targets.columns:
        df_targets = df_targets.copy()
        df_targets['date'] = pd.to_datetime(df_targets['date'])
        df_targets = df_targets.set_index(['date', inv_col])

    # Get target column
    target_col = None
    for col in ['sr_target', 'sr', 'soiling_ratio', 'sr_dustiq', 'sr_pseudo']:
        if col in df_targets.columns:
            target_col = col
            break

    if target_col is None:
        raise ValueError("No target column found in df_targets")

    y = df_targets[target_col]

    # Align X and y
    common_idx = X.index.intersection(y.index)
    X = X.loc[common_idx]
    y = y.loc[common_idx]

    return X, y
