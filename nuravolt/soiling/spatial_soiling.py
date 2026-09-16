"""
Spatial soiling model - accounts for non-uniform soiling across a plant.

Soiling is NOT uniform due to:
- Wind patterns (edges vs center)
- Proximity to dust sources (roads, construction)
- Row position (first rows catch more dust)
- Tilt angle variations
- Microclimate effects (dew patterns)

This module provides:
1. Zone detection based on soiling correlation
2. Spatial interpolation for inverters without DustIQ
3. Per-inverter SR estimation with spatial smoothing
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from pathlib import Path
import json

import numpy as np
import pandas as pd
from scipy import spatial
from scipy.interpolate import griddata


@dataclass
class SoilingZone:
    """A zone of inverters with similar soiling behavior."""
    zone_id: str
    inverter_ids: List[str]
    centroid_row: float
    centroid_col: float
    avg_soiling_rate: float  # %/day
    correlation_with_dustiq: Optional[float] = None
    is_edge_zone: bool = False
    is_high_dust_zone: bool = False


@dataclass
class SpatialSoilingConfig:
    """Configuration for spatial soiling model."""
    # Zone detection
    min_correlation_for_zone: float = 0.7  # Inverters with r > 0.7 are in same zone
    max_inverters_per_zone: int = 20

    # Spatial smoothing
    smoothing_radius_meters: float = 50.0  # Spatial smoothing kernel
    edge_penalty_factor: float = 1.2  # Edge inverters soil 20% faster

    # Gradient detection
    detect_wind_gradient: bool = True
    detect_row_gradient: bool = True


class SpatialSoilingModel:
    """Model non-uniform soiling across a plant.

    Example:
        model = SpatialSoilingModel(plant_id="epsilon")
        zones = model.detect_zones(df_all_inverters)
        sr_spatial = model.estimate_spatial_sr(df_all_inverters, sr_reference)
    """

    def __init__(
        self,
        plant_id: str,
        config: Optional[SpatialSoilingConfig] = None,
        inverter_positions: Optional[Dict[str, Tuple[float, float]]] = None,
    ):
        """Initialize spatial soiling model.

        Args:
            plant_id: Plant identifier
            config: Spatial soiling configuration
            inverter_positions: Dict mapping inverter_id to (row, col) position
        """
        self.plant_id = plant_id
        self.config = config or SpatialSoilingConfig()
        self.inverter_positions = inverter_positions or {}
        self.zones: List[SoilingZone] = []

    def set_inverter_positions(self, positions: Dict[str, Tuple[float, float]]):
        """Set inverter physical positions."""
        self.inverter_positions = positions

    def infer_positions_from_ids(self, inverter_ids: List[str]):
        """Infer row/column positions from inverter IDs.

        Assumes naming convention: INV XX.YYY where XX=row, YYY=column
        """
        positions = {}
        for inv_id in inverter_ids:
            try:
                # Parse "INV 01.052" format
                parts = inv_id.replace("INV ", "").split(".")
                if len(parts) == 2:
                    row = int(parts[0])
                    col = int(parts[1])
                    positions[inv_id] = (row, col)
            except:
                continue

        self.inverter_positions = positions
        return positions

    def detect_zones(
        self,
        df: pd.DataFrame,
        power_col: str = "power_actual",
        inverter_col: str = "inverter_id",
        date_col: str = "date",
    ) -> List[SoilingZone]:
        """Detect soiling zones based on correlation clustering.

        Inverters with highly correlated daily power patterns are in the same zone.

        Args:
            df: DataFrame with all inverters' power data
            power_col: Power column name
            inverter_col: Inverter ID column
            date_col: Date column

        Returns:
            List of detected soiling zones
        """
        # Pivot to get power by inverter by day
        if date_col not in df.columns:
            if "timestamp" in df.columns:
                df = df.copy()
                df[date_col] = pd.to_datetime(df["timestamp"]).dt.date

        daily = df.groupby([date_col, inverter_col])[power_col].sum().reset_index()
        pivot = daily.pivot(index=date_col, columns=inverter_col, values=power_col)

        # Compute correlation matrix
        corr_matrix = pivot.corr()

        # Cluster inverters by correlation
        # Simple approach: hierarchical grouping by correlation threshold
        inverter_ids = list(pivot.columns)
        if not self.inverter_positions:
            self.infer_positions_from_ids(inverter_ids)

        assigned = set()
        zones = []

        for inv_id in inverter_ids:
            if inv_id in assigned:
                continue

            # Find all inverters highly correlated with this one
            correlations = corr_matrix[inv_id]
            zone_members = correlations[
                correlations >= self.config.min_correlation_for_zone
            ].index.tolist()

            # Limit zone size
            zone_members = [m for m in zone_members if m not in assigned]
            zone_members = zone_members[:self.config.max_inverters_per_zone]

            if not zone_members:
                continue

            # Compute zone centroid
            positions = [
                self.inverter_positions.get(m, (0, 0))
                for m in zone_members
            ]
            centroid_row = np.mean([p[0] for p in positions])
            centroid_col = np.mean([p[1] for p in positions])

            # Determine if edge zone
            all_rows = [self.inverter_positions.get(m, (0, 0))[0] for m in inverter_ids]
            all_cols = [self.inverter_positions.get(m, (0, 0))[1] for m in inverter_ids]
            row_range = max(all_rows) - min(all_rows) if all_rows else 1
            col_range = max(all_cols) - min(all_cols) if all_cols else 1

            is_edge = (
                centroid_row <= min(all_rows) + 0.1 * row_range or
                centroid_row >= max(all_rows) - 0.1 * row_range or
                centroid_col <= min(all_cols) + 0.1 * col_range or
                centroid_col >= max(all_cols) - 0.1 * col_range
            )

            zone = SoilingZone(
                zone_id=f"zone_{len(zones)+1}",
                inverter_ids=zone_members,
                centroid_row=centroid_row,
                centroid_col=centroid_col,
                avg_soiling_rate=0.0,  # Will be computed later
                is_edge_zone=is_edge,
            )

            zones.append(zone)
            assigned.update(zone_members)

        self.zones = zones
        return zones

    def compute_spatial_soiling_rates(
        self,
        df: pd.DataFrame,
        sr_reference: pd.Series,
        power_col: str = "power_actual",
        inverter_col: str = "inverter_id",
    ) -> Dict[str, float]:
        """Compute soiling rate per inverter using spatial correlation.

        Uses reference SR (e.g., DustIQ) and inverter correlation to estimate
        per-inverter soiling rates.

        Args:
            df: DataFrame with all inverters' power
            sr_reference: Reference SR time series (e.g., from DustIQ)
            power_col: Power column name
            inverter_col: Inverter ID column

        Returns:
            Dict mapping inverter_id to estimated soiling rate (%/day)
        """
        # Compute daily normalized power per inverter
        if "date" not in df.columns:
            df = df.copy()
            df["date"] = pd.to_datetime(df.get("timestamp", df.index)).dt.date

        daily = df.groupby(["date", inverter_col])[power_col].sum().reset_index()

        # Normalize by each inverter's max
        inv_max = daily.groupby(inverter_col)[power_col].max()
        daily["power_norm"] = daily.apply(
            lambda r: r[power_col] / inv_max[r[inverter_col]] if inv_max[r[inverter_col]] > 0 else 0,
            axis=1
        )

        # Align with reference SR
        daily["date"] = pd.to_datetime(daily["date"])
        sr_ref = sr_reference.copy()
        if not isinstance(sr_ref.index, pd.DatetimeIndex):
            sr_ref.index = pd.to_datetime(sr_ref.index)

        rates = {}

        for inv_id in daily[inverter_col].unique():
            inv_data = daily[daily[inverter_col] == inv_id].set_index("date")

            # Compute correlation with reference SR
            common = inv_data.index.intersection(sr_ref.index)
            if len(common) < 30:
                continue

            inv_sr = inv_data.loc[common, "power_norm"]
            ref_sr = sr_ref.loc[common]

            corr = np.corrcoef(inv_sr, ref_sr)[0, 1]

            # Compute soiling rate from SR decay
            # Rate = -slope of SR over time
            sr_diff = ref_sr.diff()
            decay_rate = -sr_diff[sr_diff < 0].mean()  # Average daily decay

            # Adjust by correlation and edge factor
            inv_pos = self.inverter_positions.get(inv_id, (0, 0))
            is_edge = self._is_edge_position(inv_pos)
            edge_factor = self.config.edge_penalty_factor if is_edge else 1.0

            # Scale rate by correlation (higher corr = more similar to reference)
            # If negative correlation, this inverter behaves differently
            scaled_rate = decay_rate * edge_factor * max(0.5, corr)

            rates[inv_id] = float(scaled_rate * 100) if not np.isnan(scaled_rate) else 0.2

        return rates

    def estimate_spatial_sr(
        self,
        df: pd.DataFrame,
        sr_reference: pd.Series,
        power_col: str = "power_actual",
        inverter_col: str = "inverter_id",
        method: str = "correlation_weighted",
    ) -> pd.DataFrame:
        """Estimate SR per inverter using spatial interpolation.

        Methods:
        - "correlation_weighted": Weight reference SR by inverter correlation
        - "gradient": Apply detected spatial gradient to reference SR
        - "zone_based": Use zone-level SR estimates

        Args:
            df: DataFrame with all inverters' power
            sr_reference: Reference SR (e.g., from DustIQ or plant-level model)
            power_col: Power column
            inverter_col: Inverter ID column
            method: Interpolation method

        Returns:
            DataFrame with per-inverter SR estimates
        """
        if "date" not in df.columns:
            df = df.copy()
            df["date"] = pd.to_datetime(df.get("timestamp", df.index)).dt.date

        daily = df.groupby(["date", inverter_col])[power_col].sum().reset_index()

        # Compute per-inverter normalized power
        inv_max = daily.groupby(inverter_col)[power_col].max()
        daily["power_norm"] = daily.apply(
            lambda r: r[power_col] / inv_max[r[inverter_col]] if inv_max[r[inverter_col]] > 0 else 0,
            axis=1
        )

        # Compute correlation of each inverter with reference
        inverter_ids = daily[inverter_col].unique()
        correlations = {}

        sr_ref = sr_reference.copy()
        if not isinstance(sr_ref.index, pd.DatetimeIndex):
            sr_ref.index = pd.to_datetime(sr_ref.index)

        for inv_id in inverter_ids:
            inv_data = daily[daily[inverter_col] == inv_id].set_index("date")
            inv_data.index = pd.to_datetime(inv_data.index)

            common = inv_data.index.intersection(sr_ref.index)
            if len(common) < 30:
                correlations[inv_id] = 0.5  # Default moderate correlation
                continue

            corr = np.corrcoef(inv_data.loc[common, "power_norm"], sr_ref.loc[common])[0, 1]
            correlations[inv_id] = corr if not np.isnan(corr) else 0.5

        # Estimate SR per inverter per day
        results = []

        for date in daily["date"].unique():
            date_ts = pd.Timestamp(date)
            ref_sr_today = sr_ref.get(date_ts, sr_ref.get(date, np.nan))

            if np.isnan(ref_sr_today):
                continue

            for inv_id in inverter_ids:
                inv_data = daily[(daily["date"] == date) & (daily[inverter_col] == inv_id)]
                if inv_data.empty:
                    continue

                power_norm = inv_data["power_norm"].iloc[0]
                corr = correlations.get(inv_id, 0.5)

                if method == "correlation_weighted":
                    # Blend reference SR with inverter's normalized power
                    # High correlation: trust reference more
                    # Low correlation: trust inverter's own power pattern more
                    weight = max(0.3, min(0.9, corr))
                    sr_inv = weight * ref_sr_today + (1 - weight) * power_norm

                elif method == "gradient":
                    # Apply spatial gradient based on position
                    inv_pos = self.inverter_positions.get(inv_id, (0, 0))
                    gradient_factor = self._compute_gradient_factor(inv_pos)
                    sr_inv = ref_sr_today * gradient_factor

                elif method == "zone_based":
                    # Use zone-level adjustment
                    zone = self._get_zone_for_inverter(inv_id)
                    if zone and zone.avg_soiling_rate > 0:
                        zone_factor = 1 - zone.avg_soiling_rate / 100
                        sr_inv = ref_sr_today * zone_factor
                    else:
                        sr_inv = ref_sr_today
                else:
                    sr_inv = ref_sr_today

                # Apply edge penalty
                inv_pos = self.inverter_positions.get(inv_id, (0, 0))
                if self._is_edge_position(inv_pos):
                    sr_inv *= (2 - self.config.edge_penalty_factor)  # Edge soils more

                sr_inv = float(np.clip(sr_inv, 0.7, 1.0))

                results.append({
                    "date": date,
                    "inverter_id": inv_id,
                    "sr_estimated": sr_inv,
                    "correlation": corr,
                    "method": method,
                })

        return pd.DataFrame(results)

    def _is_edge_position(self, position: Tuple[float, float]) -> bool:
        """Check if position is on the edge of the plant."""
        if not self.inverter_positions:
            return False

        all_rows = [p[0] for p in self.inverter_positions.values()]
        all_cols = [p[1] for p in self.inverter_positions.values()]

        row, col = position
        row_range = max(all_rows) - min(all_rows) if all_rows else 1
        col_range = max(all_cols) - min(all_cols) if all_cols else 1

        return (
            row <= min(all_rows) + 0.1 * row_range or
            row >= max(all_rows) - 0.1 * row_range or
            col <= min(all_cols) + 0.1 * col_range or
            col >= max(all_cols) - 0.1 * col_range
        )

    def _compute_gradient_factor(self, position: Tuple[float, float]) -> float:
        """Compute gradient factor for a position."""
        # Simple linear gradient from edge to center
        # Center = 1.0 (cleanest), edges = lower
        if not self.inverter_positions:
            return 1.0

        all_rows = [p[0] for p in self.inverter_positions.values()]
        all_cols = [p[1] for p in self.inverter_positions.values()]

        center_row = np.mean(all_rows)
        center_col = np.mean(all_cols)
        max_dist = np.sqrt((max(all_rows) - center_row)**2 + (max(all_cols) - center_col)**2)

        if max_dist == 0:
            return 1.0

        row, col = position
        dist = np.sqrt((row - center_row)**2 + (col - center_col)**2)

        # Gradient: center=1.0, edge=0.95
        factor = 1.0 - 0.05 * (dist / max_dist)

        return float(factor)

    def _get_zone_for_inverter(self, inverter_id: str) -> Optional[SoilingZone]:
        """Get the zone containing an inverter."""
        for zone in self.zones:
            if inverter_id in zone.inverter_ids:
                return zone
        return None
