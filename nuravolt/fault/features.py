"""
Plant-Agnostic Feature Engineering for Fault Detection

Creates normalized features that work across any plant configuration:
- Any capacity (1 kW to 500 MW)
- Any number of strings (2 to 1000+)
- Any inverter type/manufacturer
- Any geographic location

All features are ratio-based or normalized, eliminating scale dependencies.
"""

from dataclasses import dataclass, field
from typing import Optional
import numpy as np
import polars as pl


@dataclass
class PlantConfig:
    """
    Plant configuration for feature normalization.

    Only the essential parameters needed for normalization.
    """
    # Capacity (required for per-unit normalization)
    rated_dc_power_kw: float
    rated_ac_power_kw: float

    # Voltage/current at MPP (optional, for V/I normalization)
    vmp_expected: Optional[float] = None  # Voltage at max power point
    imp_expected: Optional[float] = None  # Current at max power point

    # String configuration (optional)
    n_strings: Optional[int] = None
    modules_per_string: Optional[int] = None

    # Module parameters (optional, for physics calculations)
    module_efficiency: float = 0.20  # Default 20%
    temp_coefficient: float = -0.004  # -0.4%/°C typical for Si

    # Location (optional, for solar position calculations)
    latitude: Optional[float] = None
    longitude: Optional[float] = None


@dataclass
class FeatureSet:
    """
    Defines which features to compute based on available data.

    Features are grouped by data requirements:
    - system_features: Require only system-level data (AC/DC power, irradiance)
    - string_features: Require string-level data (individual string V/I)
    - temporal_features: Require time-series data with sufficient history
    """
    # Always computed if basic data available
    system_features: list[str] = field(default_factory=lambda: [
        "dc_power_pu",
        "ac_power_pu",
        "power_ratio",
        "inverter_efficiency",
        "performance_ratio",
        "clearsky_ratio",
        "voltage_ratio",
        "current_ratio",
        "temp_rise",
        "temp_coefficient_factor",
        "irradiance_normalized",
    ])

    # Computed only if string data available
    string_features: list[str] = field(default_factory=lambda: [
        "string_current_mean_pu",
        "string_current_cv",
        "string_current_min_ratio",
        "string_current_max_ratio",
        "string_current_skew",
        "strings_underperforming_pct",
        "worst_string_zscore",
        "string_voltage_cv",
        "string_voltage_min_ratio",
    ])

    # Computed if sufficient time-series history
    temporal_features: list[str] = field(default_factory=lambda: [
        "power_roc_1h",
        "efficiency_trend_24h",
        "pr_rolling_mean_24h",
        "pr_rolling_std_24h",
        "pr_rolling_cv",
        "clearsky_ratio_zscore",
    ])

    # Extended temporal features for RUL prediction (require longer history)
    rul_temporal_features: list[str] = field(default_factory=lambda: [
        # 7-day trends (for short-term RUL: string degradation, thermal)
        "efficiency_trend_7d",
        "pr_trend_7d",
        "string_cv_trend_7d",
        "temp_rise_trend_7d",
        # 30-day trends (for long-term RUL: module degradation)
        "efficiency_trend_30d",
        "pr_trend_30d",
        # Degradation acceleration (2nd derivative - is degradation speeding up?)
        "pr_acceleration_7d",
        "efficiency_acceleration_7d",
    ])


class PlantAgnosticFeatureEngine:
    """
    Compute plant-agnostic features for fault detection.

    All features are normalized/ratio-based, allowing models trained
    on one plant to transfer to any other plant.

    Example usage:
        config = PlantConfig(
            rated_dc_power_kw=1000,
            rated_ac_power_kw=900,
        )
        engine = PlantAgnosticFeatureEngine(config)

        # Transform raw data to features
        features_df = engine.transform(raw_df)

        # Get feature names for model training
        feature_names = engine.get_feature_names()
    """

    def __init__(
        self,
        plant_config: PlantConfig,
        feature_set: Optional[FeatureSet] = None,
    ):
        """
        Initialize feature engine.

        Args:
            plant_config: Plant configuration for normalization
            feature_set: Which features to compute (default: all available)
        """
        self.config = plant_config
        self.feature_set = feature_set or FeatureSet()
        self._computed_features: list[str] = []

    def transform(
        self,
        df: pl.DataFrame,
        timestamp_col: str = "timestamp",
        include_temporal: bool = True,
        include_rul_features: bool = False,
    ) -> pl.DataFrame:
        """
        Transform raw sensor data to plant-agnostic features.

        Args:
            df: Input DataFrame with raw sensor data
            timestamp_col: Name of timestamp column
            include_temporal: Whether to compute temporal features (requires history)
            include_rul_features: Whether to compute extended RUL features (7-30 day trends)

        Returns:
            DataFrame with computed features
        """
        self._computed_features = []

        # Start with original data
        result = df.clone()

        # Compute system-level features
        result = self._add_power_features(result)
        result = self._add_efficiency_features(result)
        result = self._add_voltage_current_features(result)
        result = self._add_temperature_features(result)
        result = self._add_irradiance_features(result)

        # Compute string-level features if data available
        if self._has_string_data(df):
            result = self._add_string_features(result)

        # Compute temporal features if requested and data sufficient
        if include_temporal and len(df) >= 24:  # Need at least 24 records
            result = self._add_temporal_features(result, timestamp_col)

        # Compute extended RUL features if requested (requires 7+ days of data)
        if include_rul_features and len(df) >= 288 * 3:  # Need at least 3 days
            result = self._add_rul_temporal_features(result, timestamp_col)

        return result

    def get_feature_names(
        self, include_string: bool = True, include_rul: bool = False
    ) -> list[str]:
        """Get list of computed feature names."""
        features = list(self.feature_set.system_features)

        if include_string:
            features.extend(self.feature_set.string_features)

        features.extend(self.feature_set.temporal_features)

        if include_rul:
            features.extend(self.feature_set.rul_temporal_features)

        return features

    def get_computed_features(self) -> list[str]:
        """Get list of features actually computed in last transform."""
        return self._computed_features.copy()

    # Power features (per-unit normalization)

    def _add_power_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """Add normalized power features."""

        # DC power per-unit
        dc_col = self._find_col(df, ["dc_power", "power_dc", "dc_kw", "pdc"])
        if dc_col:
            df = df.with_columns(
                (pl.col(dc_col) / self.config.rated_dc_power_kw).alias("dc_power_pu")
            )
            self._computed_features.append("dc_power_pu")

        # AC power per-unit
        ac_col = self._find_col(df, ["ac_power", "power_ac", "ac_kw", "pac"])
        if ac_col:
            df = df.with_columns(
                (pl.col(ac_col) / self.config.rated_ac_power_kw).alias("ac_power_pu")
            )
            self._computed_features.append("ac_power_pu")

        # Power ratio (AC/DC) - indicates inverter efficiency
        if dc_col and ac_col:
            df = df.with_columns(
                (pl.col(ac_col) / (pl.col(dc_col) + 1e-6)).clip(0, 1.1).alias("power_ratio")
            )
            self._computed_features.append("power_ratio")

        return df

    def _add_efficiency_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """Add efficiency-related features."""

        dc_col = self._find_col(df, ["dc_power", "power_dc", "dc_kw"])
        ac_col = self._find_col(df, ["ac_power", "power_ac", "ac_kw"])
        irr_col = self._find_col(df, ["poa_irradiance", "irradiance", "ghi", "poa"])
        clearsky_col = self._find_col(df, ["clearsky_power", "clearsky_ghi", "ghi_clear"])

        # Inverter efficiency
        if dc_col and ac_col:
            df = df.with_columns(
                (pl.col(ac_col) / (pl.col(dc_col) + 1e-6))
                .clip(0.8, 1.0)
                .alias("inverter_efficiency")
            )
            self._computed_features.append("inverter_efficiency")

        # Performance ratio (actual / theoretical)
        if dc_col and irr_col:
            # Theoretical power = irradiance * capacity * efficiency / 1000
            theoretical = (
                pl.col(irr_col) * self.config.rated_dc_power_kw *
                self.config.module_efficiency / 1000
            )
            df = df.with_columns(
                (pl.col(dc_col) / (theoretical + 1e-6))
                .clip(0, 1.5)
                .alias("performance_ratio")
            )
            self._computed_features.append("performance_ratio")

        # Clearsky ratio (actual / clearsky expected)
        if dc_col and clearsky_col:
            df = df.with_columns(
                (pl.col(dc_col) / (pl.col(clearsky_col) + 1e-6))
                .clip(0, 1.5)
                .alias("clearsky_ratio")
            )
            self._computed_features.append("clearsky_ratio")
        elif dc_col and irr_col:
            # Approximate clearsky ratio using irradiance threshold
            # Clearsky ~ irradiance > 800 W/m2
            df = df.with_columns(
                pl.when(pl.col(irr_col) > 50)
                .then(pl.col(dc_col) / (self.config.rated_dc_power_kw * pl.col(irr_col) / 1000 + 1e-6))
                .otherwise(None)
                .clip(0, 1.5)
                .alias("clearsky_ratio")
            )
            self._computed_features.append("clearsky_ratio")

        return df

    def _add_voltage_current_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """Add voltage and current ratio features."""

        v_col = self._find_col(df, ["dc_voltage", "vdc", "voltage_dc", "vpv"])
        i_col = self._find_col(df, ["dc_current", "idc", "current_dc", "ipv"])

        # Voltage ratio (vs expected MPP voltage)
        if v_col and self.config.vmp_expected:
            df = df.with_columns(
                (pl.col(v_col) / self.config.vmp_expected).alias("voltage_ratio")
            )
            self._computed_features.append("voltage_ratio")
        elif v_col:
            # Normalize to rolling median if no expected value
            df = df.with_columns(
                (pl.col(v_col) / (pl.col(v_col).rolling_median(window_size=24) + 1e-6))
                .alias("voltage_ratio")
            )
            self._computed_features.append("voltage_ratio")

        # Current ratio (vs expected MPP current)
        if i_col and self.config.imp_expected:
            df = df.with_columns(
                (pl.col(i_col) / self.config.imp_expected).alias("current_ratio")
            )
            self._computed_features.append("current_ratio")
        elif i_col:
            # Normalize to rolling median
            df = df.with_columns(
                (pl.col(i_col) / (pl.col(i_col).rolling_median(window_size=24) + 1e-6))
                .alias("current_ratio")
            )
            self._computed_features.append("current_ratio")

        return df

    def _add_temperature_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """Add temperature-related features."""

        module_temp_col = self._find_col(df, ["module_temp", "cell_temp", "panel_temp"])
        ambient_temp_col = self._find_col(df, ["ambient_temp", "air_temp", "temperature"])

        # Temperature rise (module - ambient)
        if module_temp_col and ambient_temp_col:
            df = df.with_columns(
                (pl.col(module_temp_col) - pl.col(ambient_temp_col)).alias("temp_rise")
            )
            self._computed_features.append("temp_rise")

        # Temperature coefficient factor
        # Factor = 1 + gamma * (T_cell - T_stc)
        # where gamma is typically -0.004 for Si, T_stc = 25°C
        if module_temp_col:
            gamma = self.config.temp_coefficient
            df = df.with_columns(
                (1 + gamma * (pl.col(module_temp_col) - 25)).alias("temp_coefficient_factor")
            )
            self._computed_features.append("temp_coefficient_factor")

        return df

    def _add_irradiance_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """Add irradiance-related features."""

        irr_col = self._find_col(df, ["poa_irradiance", "irradiance", "ghi", "poa"])

        if irr_col:
            # Normalized irradiance (0-1 scale, 1000 W/m2 = 1.0)
            df = df.with_columns(
                (pl.col(irr_col) / 1000).clip(0, 1.5).alias("irradiance_normalized")
            )
            self._computed_features.append("irradiance_normalized")

        return df

    # String-level features (statistical aggregates)

    def _has_string_data(self, df: pl.DataFrame) -> bool:
        """Check if DataFrame has string-level data."""
        string_patterns = ["string_current", "string_voltage", "istring", "vstring", "i_string"]
        for col in df.columns:
            for pattern in string_patterns:
                if pattern.lower() in col.lower():
                    return True
        return False

    def _add_string_features(self, df: pl.DataFrame) -> pl.DataFrame:
        """
        Add string-level statistical features.

        These features aggregate variable-length string data into
        fixed-size features that work for any number of strings.
        """

        # Find string current columns
        current_cols = self._find_cols_matching(df, ["string_current", "istring", "i_string", "idc_"])
        voltage_cols = self._find_cols_matching(df, ["string_voltage", "vstring", "v_string", "vdc_"])

        if len(current_cols) >= 2:
            df = self._add_string_current_features(df, current_cols)

        if len(voltage_cols) >= 2:
            df = self._add_string_voltage_features(df, voltage_cols)

        return df

    def _add_string_current_features(self, df: pl.DataFrame, current_cols: list[str]) -> pl.DataFrame:
        """Add statistical features from string currents."""

        # Calculate row-wise statistics across all string columns
        # Mean
        df = df.with_columns(
            pl.mean_horizontal(current_cols).alias("_string_i_mean")
        )

        # For normalized features, we need to use expressions
        # Standard deviation (via horizontal operations)
        std_expr = (
            pl.sum_horizontal([(pl.col(c) - pl.col("_string_i_mean")).pow(2) for c in current_cols])
            / len(current_cols)
        ).sqrt()

        df = df.with_columns(std_expr.alias("_string_i_std"))

        # Mean per-unit (normalized to expected current)
        if self.config.imp_expected:
            df = df.with_columns(
                (pl.col("_string_i_mean") / self.config.imp_expected).alias("string_current_mean_pu")
            )
        else:
            # Normalize to rolling median of mean
            df = df.with_columns(
                (pl.col("_string_i_mean") / (pl.col("_string_i_mean").rolling_median(24) + 1e-6))
                .alias("string_current_mean_pu")
            )
        self._computed_features.append("string_current_mean_pu")

        # Coefficient of variation (CV = std/mean)
        df = df.with_columns(
            (pl.col("_string_i_std") / (pl.col("_string_i_mean") + 1e-6))
            .clip(0, 2)
            .alias("string_current_cv")
        )
        self._computed_features.append("string_current_cv")

        # Min/max ratios
        min_expr = pl.min_horizontal(current_cols)
        max_expr = pl.max_horizontal(current_cols)

        df = df.with_columns([
            (min_expr / (pl.col("_string_i_mean") + 1e-6)).alias("string_current_min_ratio"),
            (max_expr / (pl.col("_string_i_mean") + 1e-6)).alias("string_current_max_ratio"),
        ])
        self._computed_features.extend(["string_current_min_ratio", "string_current_max_ratio"])

        # Skewness approximation (using Pearson's median skewness)
        # Skew = 3 * (mean - median) / std
        median_expr = pl.concat_list(current_cols).list.eval(pl.element().median()).list.first()
        df = df.with_columns(median_expr.alias("_string_i_median"))

        df = df.with_columns(
            (3 * (pl.col("_string_i_mean") - pl.col("_string_i_median")) / (pl.col("_string_i_std") + 1e-6))
            .clip(-3, 3)
            .alias("string_current_skew")
        )
        self._computed_features.append("string_current_skew")

        # Percentage of underperforming strings (< 85% of mean)
        threshold = 0.85
        underperforming_exprs = [
            pl.when(pl.col(c) < pl.col("_string_i_mean") * threshold)
            .then(1)
            .otherwise(0)
            for c in current_cols
        ]

        df = df.with_columns(
            (pl.sum_horizontal(underperforming_exprs) / len(current_cols))
            .alias("strings_underperforming_pct")
        )
        self._computed_features.append("strings_underperforming_pct")

        # Worst string z-score
        df = df.with_columns(
            ((min_expr - pl.col("_string_i_mean")) / (pl.col("_string_i_std") + 1e-6))
            .alias("worst_string_zscore")
        )
        self._computed_features.append("worst_string_zscore")

        # Clean up temporary columns
        df = df.drop(["_string_i_mean", "_string_i_std", "_string_i_median"])

        return df

    def _add_string_voltage_features(self, df: pl.DataFrame, voltage_cols: list[str]) -> pl.DataFrame:
        """Add statistical features from string voltages."""

        # Mean and std
        df = df.with_columns(
            pl.mean_horizontal(voltage_cols).alias("_string_v_mean")
        )

        std_expr = (
            pl.sum_horizontal([(pl.col(c) - pl.col("_string_v_mean")).pow(2) for c in voltage_cols])
            / len(voltage_cols)
        ).sqrt()

        df = df.with_columns(std_expr.alias("_string_v_std"))

        # CV for voltage
        df = df.with_columns(
            (pl.col("_string_v_std") / (pl.col("_string_v_mean") + 1e-6))
            .clip(0, 1)
            .alias("string_voltage_cv")
        )
        self._computed_features.append("string_voltage_cv")

        # Min ratio
        min_expr = pl.min_horizontal(voltage_cols)
        df = df.with_columns(
            (min_expr / (pl.col("_string_v_mean") + 1e-6)).alias("string_voltage_min_ratio")
        )
        self._computed_features.append("string_voltage_min_ratio")

        # Clean up
        df = df.drop(["_string_v_mean", "_string_v_std"])

        return df

    # Temporal features (require time-series history)

    def _add_temporal_features(self, df: pl.DataFrame, timestamp_col: str) -> pl.DataFrame:
        """Add temporal/trend features."""

        # Ensure sorted by timestamp
        if timestamp_col in df.columns:
            df = df.sort(timestamp_col)

        # Power rate of change (1-hour)
        if "dc_power_pu" in df.columns:
            # Assuming 5-min resolution, 1 hour = 12 records
            df = df.with_columns(
                (pl.col("dc_power_pu") - pl.col("dc_power_pu").shift(12))
                .alias("power_roc_1h")
            )
            self._computed_features.append("power_roc_1h")

        # Performance ratio rolling statistics (24-hour window)
        if "performance_ratio" in df.columns:
            # 24 hours = 288 records at 5-min resolution
            window = min(288, len(df) // 2)  # Adapt to available data

            df = df.with_columns([
                pl.col("performance_ratio").rolling_mean(window_size=window).alias("pr_rolling_mean_24h"),
                pl.col("performance_ratio").rolling_std(window_size=window).alias("pr_rolling_std_24h"),
            ])

            # Rolling CV
            df = df.with_columns(
                (pl.col("pr_rolling_std_24h") / (pl.col("pr_rolling_mean_24h") + 1e-6))
                .alias("pr_rolling_cv")
            )

            self._computed_features.extend(["pr_rolling_mean_24h", "pr_rolling_std_24h", "pr_rolling_cv"])

        # Clearsky ratio z-score (deviation from recent norm)
        if "clearsky_ratio" in df.columns:
            window = min(288, len(df) // 2)

            df = df.with_columns([
                pl.col("clearsky_ratio").rolling_mean(window_size=window).alias("_csr_mean"),
                pl.col("clearsky_ratio").rolling_std(window_size=window).alias("_csr_std"),
            ])

            df = df.with_columns(
                ((pl.col("clearsky_ratio") - pl.col("_csr_mean")) / (pl.col("_csr_std") + 1e-6))
                .alias("clearsky_ratio_zscore")
            )

            df = df.drop(["_csr_mean", "_csr_std"])
            self._computed_features.append("clearsky_ratio_zscore")

        # Efficiency trend (linear regression slope over 24h)
        if "inverter_efficiency" in df.columns:
            # Approximate trend using difference of rolling means
            window = min(144, len(df) // 3)  # 12 hours

            df = df.with_columns([
                pl.col("inverter_efficiency").rolling_mean(window_size=window).alias("_eff_recent"),
                pl.col("inverter_efficiency").shift(window).rolling_mean(window_size=window).alias("_eff_past"),
            ])

            df = df.with_columns(
                (pl.col("_eff_recent") - pl.col("_eff_past")).alias("efficiency_trend_24h")
            )

            df = df.drop(["_eff_recent", "_eff_past"])
            self._computed_features.append("efficiency_trend_24h")

        return df

    def _add_rul_temporal_features(self, df: pl.DataFrame, timestamp_col: str) -> pl.DataFrame:
        """
        Add extended temporal features for RUL (Remaining Useful Life) prediction.

        These features require longer time history (7-30 days) and compute:
        - 7-day and 30-day degradation trends
        - String CV trending
        - Temperature rise trending
        - Degradation acceleration (2nd derivative)
        """
        # Assuming 5-min resolution: 1 day = 288, 7 days = 2016, 30 days = 8640
        RECORDS_PER_DAY = 288
        WINDOW_7D = min(7 * RECORDS_PER_DAY, len(df) // 3)
        WINDOW_30D = min(30 * RECORDS_PER_DAY, len(df) // 3)

        if WINDOW_7D < RECORDS_PER_DAY:
            # Not enough data for 7-day features
            return df

        # --- 7-Day Trends ---

        # Efficiency trend 7d (slope approximation)
        if "inverter_efficiency" in df.columns:
            half_window = WINDOW_7D // 2
            df = df.with_columns([
                pl.col("inverter_efficiency").rolling_mean(window_size=half_window).alias("_eff_recent_7d"),
                pl.col("inverter_efficiency").shift(half_window).rolling_mean(window_size=half_window).alias("_eff_past_7d"),
            ])
            df = df.with_columns(
                (pl.col("_eff_recent_7d") - pl.col("_eff_past_7d")).alias("efficiency_trend_7d")
            )
            df = df.drop(["_eff_recent_7d", "_eff_past_7d"])
            self._computed_features.append("efficiency_trend_7d")

        # Performance ratio trend 7d
        if "performance_ratio" in df.columns:
            half_window = WINDOW_7D // 2
            df = df.with_columns([
                pl.col("performance_ratio").rolling_mean(window_size=half_window).alias("_pr_recent_7d"),
                pl.col("performance_ratio").shift(half_window).rolling_mean(window_size=half_window).alias("_pr_past_7d"),
            ])
            df = df.with_columns(
                (pl.col("_pr_recent_7d") - pl.col("_pr_past_7d")).alias("pr_trend_7d")
            )
            df = df.drop(["_pr_recent_7d", "_pr_past_7d"])
            self._computed_features.append("pr_trend_7d")

        # String CV trend 7d (for string degradation RUL)
        if "string_current_cv" in df.columns:
            half_window = WINDOW_7D // 2
            df = df.with_columns([
                pl.col("string_current_cv").rolling_mean(window_size=half_window).alias("_cv_recent_7d"),
                pl.col("string_current_cv").shift(half_window).rolling_mean(window_size=half_window).alias("_cv_past_7d"),
            ])
            df = df.with_columns(
                (pl.col("_cv_recent_7d") - pl.col("_cv_past_7d")).alias("string_cv_trend_7d")
            )
            df = df.drop(["_cv_recent_7d", "_cv_past_7d"])
            self._computed_features.append("string_cv_trend_7d")

        # Temperature rise trend 7d (for inverter thermal RUL)
        if "temp_rise" in df.columns:
            half_window = WINDOW_7D // 2
            df = df.with_columns([
                pl.col("temp_rise").rolling_mean(window_size=half_window).alias("_tr_recent_7d"),
                pl.col("temp_rise").shift(half_window).rolling_mean(window_size=half_window).alias("_tr_past_7d"),
            ])
            df = df.with_columns(
                (pl.col("_tr_recent_7d") - pl.col("_tr_past_7d")).alias("temp_rise_trend_7d")
            )
            df = df.drop(["_tr_recent_7d", "_tr_past_7d"])
            self._computed_features.append("temp_rise_trend_7d")

        # --- 30-Day Trends (for long-term module degradation) ---

        if WINDOW_30D >= 7 * RECORDS_PER_DAY:
            # Efficiency trend 30d
            if "inverter_efficiency" in df.columns:
                half_window = WINDOW_30D // 2
                df = df.with_columns([
                    pl.col("inverter_efficiency").rolling_mean(window_size=half_window).alias("_eff_recent_30d"),
                    pl.col("inverter_efficiency").shift(half_window).rolling_mean(window_size=half_window).alias("_eff_past_30d"),
                ])
                df = df.with_columns(
                    (pl.col("_eff_recent_30d") - pl.col("_eff_past_30d")).alias("efficiency_trend_30d")
                )
                df = df.drop(["_eff_recent_30d", "_eff_past_30d"])
                self._computed_features.append("efficiency_trend_30d")

            # PR trend 30d
            if "performance_ratio" in df.columns:
                half_window = WINDOW_30D // 2
                df = df.with_columns([
                    pl.col("performance_ratio").rolling_mean(window_size=half_window).alias("_pr_recent_30d"),
                    pl.col("performance_ratio").shift(half_window).rolling_mean(window_size=half_window).alias("_pr_past_30d"),
                ])
                df = df.with_columns(
                    (pl.col("_pr_recent_30d") - pl.col("_pr_past_30d")).alias("pr_trend_30d")
                )
                df = df.drop(["_pr_recent_30d", "_pr_past_30d"])
                self._computed_features.append("pr_trend_30d")

        # --- Degradation Acceleration (2nd derivative) ---
        # Is degradation speeding up? Positive = accelerating degradation

        if "pr_trend_7d" in df.columns:
            # Acceleration = change in trend over time
            df = df.with_columns([
                pl.col("pr_trend_7d").rolling_mean(window_size=RECORDS_PER_DAY).alias("_pr_trend_recent"),
                pl.col("pr_trend_7d").shift(RECORDS_PER_DAY).rolling_mean(window_size=RECORDS_PER_DAY).alias("_pr_trend_past"),
            ])
            df = df.with_columns(
                (pl.col("_pr_trend_recent") - pl.col("_pr_trend_past")).alias("pr_acceleration_7d")
            )
            df = df.drop(["_pr_trend_recent", "_pr_trend_past"])
            self._computed_features.append("pr_acceleration_7d")

        if "efficiency_trend_7d" in df.columns:
            df = df.with_columns([
                pl.col("efficiency_trend_7d").rolling_mean(window_size=RECORDS_PER_DAY).alias("_eff_trend_recent"),
                pl.col("efficiency_trend_7d").shift(RECORDS_PER_DAY).rolling_mean(window_size=RECORDS_PER_DAY).alias("_eff_trend_past"),
            ])
            df = df.with_columns(
                (pl.col("_eff_trend_recent") - pl.col("_eff_trend_past")).alias("efficiency_acceleration_7d")
            )
            df = df.drop(["_eff_trend_recent", "_eff_trend_past"])
            self._computed_features.append("efficiency_acceleration_7d")

        return df

    # Helper methods

    def _find_col(self, df: pl.DataFrame, patterns: list[str]) -> Optional[str]:
        """Find first column matching any pattern (case-insensitive)."""
        df_cols_lower = {c.lower(): c for c in df.columns}

        for pattern in patterns:
            pattern_lower = pattern.lower()

            # Exact match first
            if pattern_lower in df_cols_lower:
                return df_cols_lower[pattern_lower]

            # Then partial match
            for col_lower, col_original in df_cols_lower.items():
                if pattern_lower in col_lower:
                    return col_original

        return None

    def _find_cols_matching(self, df: pl.DataFrame, patterns: list[str]) -> list[str]:
        """Find all columns matching any pattern."""
        matches = []

        for col in df.columns:
            col_lower = col.lower()
            for pattern in patterns:
                if pattern.lower() in col_lower:
                    matches.append(col)
                    break

        return matches


def create_feature_engine_from_metadata(metadata: dict) -> PlantAgnosticFeatureEngine:
    """
    Create feature engine from plant metadata dictionary.

    Args:
        metadata: Dictionary with plant configuration
            Required keys: rated_dc_power_kw, rated_ac_power_kw
            Optional keys: vmp_expected, imp_expected, latitude, longitude, etc.

    Returns:
        Configured PlantAgnosticFeatureEngine
    """
    config = PlantConfig(
        rated_dc_power_kw=metadata["rated_dc_power_kw"],
        rated_ac_power_kw=metadata["rated_ac_power_kw"],
        vmp_expected=metadata.get("vmp_expected"),
        imp_expected=metadata.get("imp_expected"),
        n_strings=metadata.get("n_strings"),
        modules_per_string=metadata.get("modules_per_string"),
        module_efficiency=metadata.get("module_efficiency", 0.20),
        temp_coefficient=metadata.get("temp_coefficient", -0.004),
        latitude=metadata.get("latitude"),
        longitude=metadata.get("longitude"),
    )

    return PlantAgnosticFeatureEngine(config)
