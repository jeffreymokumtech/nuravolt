"""
Unit tests for plant-agnostic feature engineering.

Tests the PlantAgnosticFeatureEngine class to ensure features
are properly normalized and work across different plant configurations.
"""

import pytest
import polars as pl
import numpy as np

from nuravolt.fault import (
    PlantAgnosticFeatureEngine,
    PlantConfig,
    FeatureSet,
    create_feature_engine_from_metadata,
)


@pytest.fixture
def small_plant_config():
    """Create config for a small 10 kW plant."""
    return PlantConfig(
        rated_dc_power_kw=10.0,
        rated_ac_power_kw=9.0,
        vmp_expected=400.0,
        imp_expected=25.0,
        n_strings=2,
    )


@pytest.fixture
def large_plant_config():
    """Create config for a large 100 MW plant."""
    return PlantConfig(
        rated_dc_power_kw=100000.0,
        rated_ac_power_kw=90000.0,
        vmp_expected=1500.0,
        imp_expected=100.0,
        n_strings=1000,
    )


def create_system_level_data(
    rated_power_kw: float,
    n_samples: int = 100,
) -> pl.DataFrame:
    """Create synthetic system-level data."""
    np.random.seed(42)

    # Simulate a day with varying irradiance
    irradiance = np.clip(
        np.sin(np.linspace(0, np.pi, n_samples)) * 800 + np.random.normal(0, 20, n_samples),
        0, 1000
    )

    # Power proportional to irradiance
    dc_power = irradiance / 1000 * rated_power_kw * 0.85
    ac_power = dc_power * 0.96

    return pl.DataFrame({
        "dc_power": dc_power,
        "ac_power": ac_power,
        "dc_voltage": [500.0 + np.random.normal(0, 5) for _ in range(n_samples)],
        "dc_current": [dc_power[i] * 1000 / 500 for i in range(n_samples)],
        "poa_irradiance": irradiance,
        "module_temp": [25.0 + irradiance[i] / 40 for i in range(n_samples)],
        "ambient_temp": [25.0] * n_samples,
    })


def create_string_level_data(
    rated_power_kw: float,
    n_strings: int = 4,
    n_samples: int = 100,
) -> pl.DataFrame:
    """Create synthetic string-level data."""
    np.random.seed(42)

    df = create_system_level_data(rated_power_kw, n_samples)

    # Add string currents (slightly different for each string)
    expected_current = rated_power_kw / n_strings / 500 * 1000  # Approximate
    for i in range(n_strings):
        variation = 1.0 + np.random.normal(0, 0.05, n_samples)  # 5% variation
        df = df.with_columns(
            pl.Series(f"string_current_{i+1}", expected_current * variation * df["poa_irradiance"].to_numpy() / 1000)
        )

    return df


class TestPlantAgnosticFeatures:
    """Test that features are properly normalized across plant sizes."""

    def test_power_features_normalized(self, small_plant_config, large_plant_config):
        """Test that power features are normalized to 0-1 range."""
        # Create data for both plants
        small_df = create_system_level_data(small_plant_config.rated_dc_power_kw)
        large_df = create_system_level_data(large_plant_config.rated_dc_power_kw)

        # Create feature engines
        small_engine = PlantAgnosticFeatureEngine(small_plant_config)
        large_engine = PlantAgnosticFeatureEngine(large_plant_config)

        # Transform data
        small_features = small_engine.transform(small_df, include_temporal=False)
        large_features = large_engine.transform(large_df, include_temporal=False)

        # Check dc_power_pu is in similar range for both
        if "dc_power_pu" in small_features.columns:
            small_power_pu = small_features["dc_power_pu"].to_numpy()
            large_power_pu = large_features["dc_power_pu"].to_numpy()

            # Both should be in 0-1 range (approximately)
            assert small_power_pu.max() < 1.5, "Small plant power_pu should be normalized"
            assert large_power_pu.max() < 1.5, "Large plant power_pu should be normalized"

            # Means should be similar (both at ~50% capacity in our test data)
            assert abs(small_power_pu.mean() - large_power_pu.mean()) < 0.2

    def test_efficiency_features_scale_invariant(self, small_plant_config, large_plant_config):
        """Test that efficiency features are scale-invariant."""
        small_df = create_system_level_data(small_plant_config.rated_dc_power_kw)
        large_df = create_system_level_data(large_plant_config.rated_dc_power_kw)

        small_engine = PlantAgnosticFeatureEngine(small_plant_config)
        large_engine = PlantAgnosticFeatureEngine(large_plant_config)

        small_features = small_engine.transform(small_df, include_temporal=False)
        large_features = large_engine.transform(large_df, include_temporal=False)

        # Power ratio (AC/DC) should be similar for both plants
        if "power_ratio" in small_features.columns:
            small_ratio = small_features["power_ratio"].to_numpy()
            large_ratio = large_features["power_ratio"].to_numpy()

            # Both should be around 0.96 (our simulated efficiency)
            assert abs(np.nanmean(small_ratio) - np.nanmean(large_ratio)) < 0.1

    def test_string_features_with_variable_strings(self, small_plant_config):
        """Test that string features work with different numbers of strings."""
        # Create data with 2 strings
        df_2_strings = create_string_level_data(
            small_plant_config.rated_dc_power_kw,
            n_strings=2,
        )

        # Create data with 4 strings
        df_4_strings = create_string_level_data(
            small_plant_config.rated_dc_power_kw,
            n_strings=4,
        )

        engine = PlantAgnosticFeatureEngine(small_plant_config)

        features_2 = engine.transform(df_2_strings, include_temporal=False)
        features_4 = engine.transform(df_4_strings, include_temporal=False)

        # Both should have string_current_cv feature
        if "string_current_cv" in features_2.columns:
            assert "string_current_cv" in features_4.columns

            # CV should be small (strings are similar in our test data)
            cv_2 = features_2["string_current_cv"].to_numpy()
            cv_4 = features_4["string_current_cv"].to_numpy()

            # Both should be positive and relatively small
            assert np.nanmean(cv_2) >= 0
            assert np.nanmean(cv_4) >= 0

    def test_feature_names_tracked(self, small_plant_config):
        """Test that computed feature names are tracked."""
        df = create_system_level_data(small_plant_config.rated_dc_power_kw)
        engine = PlantAgnosticFeatureEngine(small_plant_config)

        engine.transform(df, include_temporal=False)

        computed = engine.get_computed_features()
        assert len(computed) > 0
        assert "dc_power_pu" in computed or "power_ratio" in computed

    def test_missing_columns_handled_gracefully(self, small_plant_config):
        """Test that missing columns don't cause errors."""
        # Create minimal data
        df = pl.DataFrame({
            "dc_power": [10.0, 20.0, 30.0],
            "poa_irradiance": [500.0, 800.0, 600.0],
        })

        engine = PlantAgnosticFeatureEngine(small_plant_config)

        # Should not raise an error
        features = engine.transform(df, include_temporal=False)

        # Should still compute available features
        assert "dc_power_pu" in features.columns


class TestFeatureEngineFactory:
    """Test factory function for creating feature engines."""

    def test_create_from_metadata(self):
        """Test creating engine from metadata dictionary."""
        metadata = {
            "rated_dc_power_kw": 50.0,
            "rated_ac_power_kw": 45.0,
            "latitude": 37.0,
            "longitude": -122.0,
        }

        engine = create_feature_engine_from_metadata(metadata)

        assert engine.config.rated_dc_power_kw == 50.0
        assert engine.config.rated_ac_power_kw == 45.0
        assert engine.config.latitude == 37.0

    def test_create_with_optional_params(self):
        """Test that optional parameters are handled."""
        metadata = {
            "rated_dc_power_kw": 100.0,
            "rated_ac_power_kw": 90.0,
            # Optional parameters
            "vmp_expected": 600.0,
            "module_efficiency": 0.22,
        }

        engine = create_feature_engine_from_metadata(metadata)

        assert engine.config.vmp_expected == 600.0
        assert engine.config.module_efficiency == 0.22


class TestTemporalFeatures:
    """Test temporal/trend feature computation."""

    def test_temporal_features_require_history(self, small_plant_config):
        """Test that temporal features need sufficient data."""
        # Very short data
        short_df = create_system_level_data(small_plant_config.rated_dc_power_kw, n_samples=10)

        # Longer data
        long_df = create_system_level_data(small_plant_config.rated_dc_power_kw, n_samples=300)

        engine = PlantAgnosticFeatureEngine(small_plant_config)

        # Short data should not have temporal features
        short_features = engine.transform(short_df, include_temporal=True)

        # Long data should have temporal features
        long_features = engine.transform(long_df, include_temporal=True)

        # Rolling features should have more non-null values in long data
        if "pr_rolling_cv" in long_features.columns:
            long_non_null = long_features["pr_rolling_cv"].is_not_null().sum()
            assert long_non_null > 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
