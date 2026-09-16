"""
Zone Detection and Analysis for Solar PV Plants.

This module provides:
1. Auto-detection of inverter zones from column naming patterns
2. Zone-level soiling ratio estimation
3. Zone performance comparison
4. Recommendations for zone-based cleaning

Zone detection strategies:
- Prefix pattern: "INV 01.001" -> Zone "INV 01"
- Numeric grouping: Group by prefix before separator
- Geographic clustering: Based on column ordering if no clear pattern
"""

import re
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from pathlib import Path
import json

import numpy as np
import pandas as pd

# Try polars, fallback to None
try:
    import polars as pl
    HAS_POLARS = True
except ImportError:
    HAS_POLARS = False


@dataclass
class SoilingZone:
    """Definition of a soiling zone."""
    zone_id: str
    zone_name: str
    inverter_pattern: str  # Regex pattern to match inverters
    inverter_count: int
    inverters: List[str]
    description: Optional[str] = None
    avg_soiling_rate: Optional[float] = None
    avg_sr: Optional[float] = None


@dataclass
class ZonePerformance:
    """Zone-level performance metrics."""
    zone_id: str
    zone_name: str
    avg_sr: float
    min_sr: float
    max_sr: float
    std_sr: float
    avg_loss_pct: float
    inverter_count: int
    data_points: int
    health_score: float  # 0-100
    cleaning_priority: str  # 'low', 'medium', 'high', 'critical'
    recommendation: Optional[str] = None


@dataclass
class ZoneAnalysisResult:
    """Complete zone analysis result."""
    plant_id: str
    zones: List[SoilingZone]
    performance: List[ZonePerformance]
    zone_comparison: Dict[str, float]  # zone_id -> relative performance
    cleaning_recommendations: List[str]
    analyzed_at: str
    data_period: Dict[str, str]  # start, end


# Default zone patterns for known plants
DEFAULT_ZONE_PATTERNS = {
    'alpha1': [
        {'pattern': r'INV\s*01\.', 'name': 'Zone A (INV 01)', 'description': 'Northwest zone'},
        {'pattern': r'INV\s*02\.', 'name': 'Zone B (INV 02)', 'description': 'Northeast zone'},
        {'pattern': r'INV\s*03\.', 'name': 'Zone C (INV 03)', 'description': 'Center zone'},
        {'pattern': r'INV\s*04\.', 'name': 'Zone D (INV 04)', 'description': 'Southwest zone'},
        {'pattern': r'INV\s*05\.', 'name': 'Zone E (INV 05)', 'description': 'Southeast zone'},
    ],
    'ribera': [
        {'pattern': r'INV\s*01\.', 'name': 'Zone 1 (INV 01)', 'description': 'Group 1 - 29 inverters'},
        {'pattern': r'INV\s*02\.', 'name': 'Zone 2 (INV 02)', 'description': 'Group 2 - 31 inverters'},
        {'pattern': r'INV\s*03\.', 'name': 'Zone 3 (INV 03)', 'description': 'Group 3 - 33 inverters'},
        {'pattern': r'INV\s*04\.', 'name': 'Zone 4 (INV 04)', 'description': 'Group 4 - 27 inverters'},
    ],
    'eta': [
        {'pattern': r'INV\s*01\.(00[1-9]|01[0-4])\b', 'name': 'Zone A (INV 01.001-014)', 'description': 'First 14 inverters'},
        {'pattern': r'INV\s*01\.(01[5-9]|02[0-8])\b', 'name': 'Zone B (INV 01.015-028)', 'description': 'Last 14 inverters'},
    ],
}


class ZoneDetector:
    """
    Auto-detect and analyze inverter zones in a solar plant.
    """

    def __init__(self, plant_id: str, custom_patterns: Optional[List[Dict]] = None):
        """
        Initialize zone detector.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        custom_patterns : list, optional
            Custom zone patterns [{'pattern': regex, 'name': str, 'description': str}, ...]
        """
        self.plant_id = plant_id
        self.custom_patterns = custom_patterns
        self.zones: List[SoilingZone] = []

    def detect_zones(self, inverter_columns: List[str]) -> List[SoilingZone]:
        """
        Auto-detect zones from inverter column names.

        Parameters
        ----------
        inverter_columns : list
            List of inverter column names (e.g., ["INV 01.001", "INV 01.002", ...])

        Returns
        -------
        zones : list
            List of detected SoilingZone objects
        """
        # First try custom patterns
        if self.custom_patterns:
            self.zones = self._detect_from_patterns(inverter_columns, self.custom_patterns)
            if self.zones:
                return self.zones

        # Then try known plant patterns
        if self.plant_id in DEFAULT_ZONE_PATTERNS:
            self.zones = self._detect_from_patterns(
                inverter_columns,
                DEFAULT_ZONE_PATTERNS[self.plant_id]
            )
            if self.zones:
                return self.zones

        # Finally, auto-detect from naming patterns
        self.zones = self._auto_detect_zones(inverter_columns)
        return self.zones

    def _detect_from_patterns(
        self,
        columns: List[str],
        patterns: List[Dict]
    ) -> List[SoilingZone]:
        """Detect zones using explicit patterns."""
        zones = []

        for i, pat in enumerate(patterns):
            regex = re.compile(pat['pattern'])
            matched_inverters = [c for c in columns if regex.search(c)]

            if matched_inverters:
                zones.append(SoilingZone(
                    zone_id=f"zone_{i+1}",
                    zone_name=pat.get('name', f'Zone {i+1}'),
                    inverter_pattern=pat['pattern'],
                    inverter_count=len(matched_inverters),
                    inverters=matched_inverters,
                    description=pat.get('description'),
                ))

        return zones

    def _auto_detect_zones(self, columns: List[str]) -> List[SoilingZone]:
        """
        Auto-detect zones from column naming patterns.

        Strategies:
        1. Extract prefix before separator (e.g., "INV 01" from "INV 01.001")
        2. Group by common prefix
        3. Create zones from groups with 3+ inverters
        """
        # Try common separators
        separators = ['.', '_', '-', ' ']
        best_groups = None
        best_sep = None

        for sep in separators:
            groups = self._group_by_prefix(columns, sep)
            if len(groups) > 1 and all(len(g) >= 2 for g in groups.values()):
                if best_groups is None or len(groups) > len(best_groups):
                    best_groups = groups
                    best_sep = sep

        if best_groups and len(best_groups) >= 2:
            zones = []
            for i, (prefix, inverters) in enumerate(sorted(best_groups.items())):
                escaped_prefix = re.escape(prefix)
                pattern = f"{escaped_prefix}\\{best_sep}" if best_sep else escaped_prefix

                zones.append(SoilingZone(
                    zone_id=f"zone_{i+1}",
                    zone_name=f"Zone {prefix}",
                    inverter_pattern=pattern,
                    inverter_count=len(inverters),
                    inverters=inverters,
                    description=f"Auto-detected zone with {len(inverters)} inverters",
                ))
            return zones

        # Fallback: single zone with all inverters
        return [SoilingZone(
            zone_id="zone_1",
            zone_name="All Inverters",
            inverter_pattern=".*",
            inverter_count=len(columns),
            inverters=columns,
            description="Single zone (no grouping pattern detected)",
        )]

    def _group_by_prefix(self, columns: List[str], separator: str) -> Dict[str, List[str]]:
        """Group columns by prefix before separator."""
        groups = defaultdict(list)

        for col in columns:
            if separator in col:
                prefix = col.split(separator)[0]
                groups[prefix].append(col)
            else:
                groups[col].append(col)

        return dict(groups)

    def get_zone_config(self) -> Dict:
        """
        Get zone configuration in JSON-serializable format.

        Returns
        -------
        config : dict
            Zone configuration for storage/API
        """
        return {
            'plant_id': self.plant_id,
            'zones': [asdict(z) for z in self.zones],
            'detected_at': datetime.now().isoformat(),
        }


class ZoneAnalyzer:
    """
    Analyze zone-level performance and soiling.
    """

    def __init__(self, plant_id: str, zones: List[SoilingZone]):
        """
        Initialize zone analyzer.

        Parameters
        ----------
        plant_id : str
            Plant identifier
        zones : list
            List of SoilingZone objects
        """
        self.plant_id = plant_id
        self.zones = zones

    def analyze_zone_performance(
        self,
        sr_data: pd.DataFrame,
        date_col: str = 'date',
    ) -> List[ZonePerformance]:
        """
        Analyze soiling performance per zone.

        Parameters
        ----------
        sr_data : pd.DataFrame
            DataFrame with date and SR columns per inverter
        date_col : str
            Date column name

        Returns
        -------
        performance : list
            List of ZonePerformance objects
        """
        results = []

        for zone in self.zones:
            # Find matching columns
            zone_cols = [c for c in sr_data.columns
                        if c != date_col and any(inv in c for inv in zone.inverters)]

            if not zone_cols:
                # Try regex matching
                pattern = re.compile(zone.inverter_pattern)
                zone_cols = [c for c in sr_data.columns
                            if c != date_col and pattern.search(c)]

            if not zone_cols:
                continue

            # Calculate zone metrics
            zone_sr = sr_data[zone_cols].mean(axis=1)
            valid_sr = zone_sr.dropna()

            if len(valid_sr) == 0:
                continue

            avg_sr = float(valid_sr.mean())
            min_sr = float(valid_sr.min())
            max_sr = float(valid_sr.max())
            std_sr = float(valid_sr.std())
            avg_loss = (1 - avg_sr) * 100

            # Calculate health score (0-100)
            health_score = self._calculate_health_score(avg_sr, std_sr)

            # Determine cleaning priority
            priority = self._get_cleaning_priority(avg_sr, health_score)

            # Generate recommendation
            recommendation = self._get_recommendation(zone.zone_name, avg_sr, priority)

            results.append(ZonePerformance(
                zone_id=zone.zone_id,
                zone_name=zone.zone_name,
                avg_sr=round(avg_sr, 4),
                min_sr=round(min_sr, 4),
                max_sr=round(max_sr, 4),
                std_sr=round(std_sr, 4),
                avg_loss_pct=round(avg_loss, 2),
                inverter_count=len(zone_cols),
                data_points=len(valid_sr),
                health_score=round(health_score, 1),
                cleaning_priority=priority,
                recommendation=recommendation,
            ))

        return results

    def _calculate_health_score(self, avg_sr: float, std_sr: float) -> float:
        """
        Calculate zone health score (0-100).

        Score based on:
        - Average SR (higher is better)
        - Consistency (lower std is better)
        """
        # SR contribution (0-80 points)
        sr_score = min(80, (avg_sr - 0.7) / 0.3 * 80)

        # Consistency contribution (0-20 points)
        consistency_score = max(0, 20 - (std_sr * 100))

        return max(0, min(100, sr_score + consistency_score))

    def _get_cleaning_priority(self, avg_sr: float, health_score: float) -> str:
        """Determine cleaning priority level."""
        if avg_sr < 0.85 or health_score < 40:
            return 'critical'
        elif avg_sr < 0.90 or health_score < 60:
            return 'high'
        elif avg_sr < 0.95 or health_score < 80:
            return 'medium'
        else:
            return 'low'

    def _get_recommendation(self, zone_name: str, avg_sr: float, priority: str) -> str:
        """Generate cleaning recommendation."""
        if priority == 'critical':
            return f"{zone_name} requires immediate cleaning (SR: {avg_sr:.1%})"
        elif priority == 'high':
            return f"{zone_name} should be prioritized for next cleaning"
        elif priority == 'medium':
            return f"{zone_name} can be cleaned in regular cycle"
        else:
            return f"{zone_name} is clean, no action needed"

    def compare_zones(self, performance: List[ZonePerformance]) -> Dict[str, float]:
        """
        Compare zone performance relative to fleet average.

        Returns
        -------
        comparison : dict
            zone_id -> relative performance (1.0 = average, >1 = better, <1 = worse)
        """
        if not performance:
            return {}

        fleet_avg = np.mean([p.avg_sr for p in performance])

        return {
            p.zone_id: round(p.avg_sr / fleet_avg, 4)
            for p in performance
        }

    def get_cleaning_recommendations(self, performance: List[ZonePerformance]) -> List[str]:
        """
        Generate cleaning recommendations based on zone analysis.

        Returns
        -------
        recommendations : list
            Prioritized list of recommendations
        """
        recommendations = []

        # Sort by priority
        priority_order = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3}
        sorted_perf = sorted(performance, key=lambda p: priority_order[p.cleaning_priority])

        critical = [p for p in sorted_perf if p.cleaning_priority == 'critical']
        high = [p for p in sorted_perf if p.cleaning_priority == 'high']

        if critical:
            zones = ', '.join(p.zone_name for p in critical)
            recommendations.append(f"URGENT: {len(critical)} zone(s) require immediate cleaning: {zones}")

        if high:
            zones = ', '.join(p.zone_name for p in high)
            recommendations.append(f"Schedule priority cleaning for {len(high)} zone(s): {zones}")

        # Zone-specific cleaning optimization
        if len(performance) > 1:
            sr_range = max(p.avg_sr for p in performance) - min(p.avg_sr for p in performance)
            if sr_range > 0.05:
                recommendations.append(
                    f"Consider zone-based cleaning schedule (SR variation: {sr_range:.1%})"
                )

        return recommendations

    def run_analysis(
        self,
        sr_data: pd.DataFrame,
        date_col: str = 'date',
    ) -> ZoneAnalysisResult:
        """
        Run complete zone analysis.

        Parameters
        ----------
        sr_data : pd.DataFrame
            Soiling ratio data
        date_col : str
            Date column name

        Returns
        -------
        result : ZoneAnalysisResult
            Complete analysis result
        """
        performance = self.analyze_zone_performance(sr_data, date_col)
        comparison = self.compare_zones(performance)
        recommendations = self.get_cleaning_recommendations(performance)

        # Determine data period
        if date_col in sr_data.columns:
            dates = pd.to_datetime(sr_data[date_col])
            period = {
                'start': dates.min().strftime('%Y-%m-%d'),
                'end': dates.max().strftime('%Y-%m-%d'),
            }
        else:
            period = {'start': 'unknown', 'end': 'unknown'}

        return ZoneAnalysisResult(
            plant_id=self.plant_id,
            zones=self.zones,
            performance=performance,
            zone_comparison=comparison,
            cleaning_recommendations=recommendations,
            analyzed_at=datetime.now().isoformat(),
            data_period=period,
        )


def detect_and_analyze_zones(
    plant_id: str,
    sr_data: pd.DataFrame,
    inverter_columns: Optional[List[str]] = None,
    custom_patterns: Optional[List[Dict]] = None,
) -> ZoneAnalysisResult:
    """
    Convenience function to detect zones and run analysis.

    Parameters
    ----------
    plant_id : str
        Plant identifier
    sr_data : pd.DataFrame
        Soiling ratio data with inverter columns
    inverter_columns : list, optional
        Inverter column names (auto-detected if not provided)
    custom_patterns : list, optional
        Custom zone patterns

    Returns
    -------
    result : ZoneAnalysisResult
        Complete zone analysis
    """
    # Auto-detect inverter columns if not provided
    if inverter_columns is None:
        inverter_columns = [c for c in sr_data.columns
                          if c not in ['date', 'timestamp', 'Date', 'Timestamp']]

    # Detect zones
    detector = ZoneDetector(plant_id, custom_patterns)
    zones = detector.detect_zones(inverter_columns)

    # Run analysis
    analyzer = ZoneAnalyzer(plant_id, zones)
    result = analyzer.run_analysis(sr_data)

    return result
