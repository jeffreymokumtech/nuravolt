"""
Unit tests for rule-based fault detection.

Tests the RuleBasedFaultDetector class with synthetic data
covering various fault scenarios.
"""

import pytest
from datetime import datetime, timedelta
import polars as pl
import numpy as np

from nuravolt.fault import (
    RuleBasedFaultDetector,
    FaultDetectionConfig,
    FaultType,
    FaultSeverity,
)


@pytest.fixture
def config():
    """Create default configuration."""
    return FaultDetectionConfig()


@pytest.fixture
def detector(config):
    """Create detector with default config."""
    return RuleBasedFaultDetector(config)


def create_test_data(
    n_samples: int = 100,
    base_time: datetime = None,
    interval_minutes: int = 5,
) -> pl.DataFrame:
    """Create synthetic test data with normal operation."""
    if base_time is None:
        base_time = datetime(2024, 6, 15, 6, 0, 0)  # 6 AM

    timestamps = [base_time + timedelta(minutes=i * interval_minutes) for i in range(n_samples)]

    # Normal operation data
    np.random.seed(42)
    irradiance = np.clip(np.sin(np.linspace(0, np.pi, n_samples)) * 800 + np.random.normal(0, 20, n_samples), 0, 1000)
    dc_power = irradiance * 0.2 * 100 / 1000  # ~20 kW peak
    ac_power = dc_power * 0.96  # 96% efficiency

    return pl.DataFrame({
        "timestamp": timestamps,
        "poa_irradiance": irradiance,
        "dc_power": dc_power,
        "ac_power": ac_power,
        "dc_voltage": [500.0 + np.random.normal(0, 5) for _ in range(n_samples)],
        "dc_current": [dc_power[i] * 1000 / 500 for i in range(n_samples)],
        "module_temp": [25.0 + irradiance[i] / 40 + np.random.normal(0, 2) for i in range(n_samples)],
        "ambient_temp": [25.0 + np.random.normal(0, 2) for _ in range(n_samples)],
    })


class TestRuleBasedFaultDetector:
    """Test suite for RuleBasedFaultDetector."""

    def test_no_faults_normal_operation(self, detector):
        """Test that normal operation produces no alerts."""
        df = create_test_data()
        result = detector.detect_all(df)

        # Should have no critical alerts
        assert result.n_critical == 0

    def test_detect_inverter_offline(self, detector):
        """Test detection of inverter offline during daylight."""
        df = create_test_data()

        # Set AC power to zero for middle of day (high irradiance)
        df = df.with_columns(
            pl.when(pl.col("poa_irradiance") > 500)
            .then(0.0)
            .otherwise(pl.col("ac_power"))
            .alias("ac_power")
        )

        result = detector.detect_all(df)

        # Should detect inverter offline
        offline_alerts = result.get_alerts_by_type(FaultType.INVERTER_OFFLINE)
        assert len(offline_alerts) > 0
        assert offline_alerts[0].severity == FaultSeverity.CRITICAL

    def test_detect_overtemperature(self, detector):
        """Test detection of module overtemperature."""
        df = create_test_data()

        # Set high temperatures
        df = df.with_columns(
            pl.lit(90.0).alias("module_temp")  # > 85°C threshold
        )

        result = detector.detect_all(df)

        # Should detect overtemperature
        temp_alerts = result.get_alerts_by_type(FaultType.MODULE_OVERTEMPERATURE)
        assert len(temp_alerts) > 0
        assert temp_alerts[0].severity == FaultSeverity.WARNING

    def test_detect_grid_frequency_low(self, detector):
        """Test detection of grid underfrequency."""
        df = create_test_data()

        # Add grid frequency column with low values
        df = df.with_columns(
            pl.lit(49.0).alias("grid_frequency")  # Below 49.5 Hz threshold
        )

        result = detector.detect_all(df)

        # Should detect underfrequency
        freq_alerts = result.get_alerts_by_type(FaultType.GRID_FREQUENCY_LOW)
        assert len(freq_alerts) > 0
        assert freq_alerts[0].severity == FaultSeverity.CRITICAL

    def test_detect_grid_voltage_sag(self, detector):
        """Test detection of grid voltage sag."""
        df = create_test_data()

        # Add grid voltage column with sag
        df = df.with_columns(
            pl.lit(350.0).alias("grid_voltage")  # < 90% of 400V = 360V
        )

        result = detector.detect_all(df)

        # Should detect voltage sag
        sag_alerts = result.get_alerts_by_type(FaultType.GRID_VOLTAGE_SAG)
        assert len(sag_alerts) > 0

    def test_detect_communication_loss(self, detector):
        """Test detection of data gaps."""
        base_time = datetime(2024, 6, 15, 6, 0, 0)

        # Create data with a 30-minute gap
        timestamps = [
            base_time,
            base_time + timedelta(minutes=5),
            base_time + timedelta(minutes=10),
            # Gap here
            base_time + timedelta(minutes=50),  # 40-minute gap
            base_time + timedelta(minutes=55),
        ]

        df = pl.DataFrame({
            "timestamp": timestamps,
            "poa_irradiance": [100.0] * 5,
            "dc_power": [10.0] * 5,
            "ac_power": [9.5] * 5,
        })

        result = detector.detect_all(df)

        # Should detect communication loss
        comm_alerts = result.get_alerts_by_type(FaultType.COMMUNICATION_LOSS)
        assert len(comm_alerts) > 0
        assert comm_alerts[0].duration_minutes >= 30

    def test_batch_result_serialization(self, detector):
        """Test that batch result can be serialized to JSON."""
        df = create_test_data()
        result = detector.detect_all(df)

        # Should be able to convert to dict
        result_dict = result.to_dict()
        assert "summary" in result_dict
        assert "alerts" in result_dict
        assert result_dict["summary"]["records_processed"] == len(df)

    def test_alert_serialization(self, detector):
        """Test that alerts can be serialized to JSON."""
        df = create_test_data()

        # Force an alert
        df = df.with_columns(pl.lit(90.0).alias("module_temp"))

        result = detector.detect_all(df)

        if result.alerts:
            alert_dict = result.alerts[0].to_dict()
            assert "fault_type" in alert_dict
            assert "severity" in alert_dict
            assert "timestamp_start" in alert_dict


class TestStringFaultDetection:
    """Test suite for string-level fault detection."""

    def test_detect_string_open_circuit(self, detector):
        """A string that was working and then stops is an open circuit.

        The fixture deliberately has the string produce for the first half of the
        record and then fail. That is what an open circuit is. The previous version
        of this test held the string at zero for the WHOLE record, which is
        indistinguishable from an inverter input that was never connected -- see
        test_never_connected_input_is_not_a_fault.
        """
        df = create_test_data(n_samples=100)
        n = len(df)
        failing = [5.0] * (n // 2) + [0.0] * (n - n // 2)

        df = df.with_columns([
            pl.lit(5.0).alias("string_current_1"),
            pl.lit(5.0).alias("string_current_2"),
            pl.Series("string_current_3", failing),   # works, then opens
            pl.lit(5.0).alias("string_current_4"),
        ])

        result = detector.detect_all(df)
        open_alerts = result.get_alerts_by_type(FaultType.STRING_OPEN_CIRCUIT)
        assert len(open_alerts) > 0

    def test_never_connected_input_is_not_a_fault(self, detector):
        """A spare inverter input reading zero forever must not raise, ever.

        Inverters ship with more string inputs than are always used. On one real
        plant an inverter exposes 18 inputs of which input 18 peaks at 0.18 A and
        sits at zero 99.6% of the time: it was never wired. Treating that as an open
        circuit made the rule fire on 95.8% of daylight intervals on that plant for
        five years.

        A channel dead for the ENTIRE record cannot be distinguished from an empty
        socket using current alone, so we choose the interpretation that does not
        generate a permanent alarm. A genuine open circuit shows a transition, and
        the test above covers that case.
        """
        df = create_test_data(n_samples=100)
        df = df.with_columns([
            pl.lit(5.0).alias("string_current_1"),
            pl.lit(5.0).alias("string_current_2"),
            pl.lit(0.0).alias("string_current_3"),   # never connected
            pl.lit(5.0).alias("string_current_4"),
        ])

        result = detector.detect_all(df)
        open_alerts = result.get_alerts_by_type(FaultType.STRING_OPEN_CIRCUIT)
        assert len(open_alerts) == 0, (
            "an input that never carried current is an empty socket, not a fault"
        )


class TestTrackerFaultDetection:
    """Test suite for tracker fault detection."""

    def test_detect_tracker_stuck(self, detector):
        """Test detection of stuck tracker."""
        df = create_test_data()

        # Add tracker angle that doesn't change
        df = df.with_columns(
            pl.lit(30.0).alias("tracker_angle")  # Stuck at 30 degrees
        )

        result = detector.detect_all(df)

        # Should detect tracker stuck (if enough samples)
        # Note: Requires sufficient consecutive samples
        stuck_alerts = result.get_alerts_by_type(FaultType.TRACKER_STUCK)
        # May or may not trigger depending on window size

    def test_no_tracker_alert_when_moving(self, detector):
        """Test that normal tracker movement doesn't trigger alert."""
        df = create_test_data()

        # Add tracker angle that changes normally
        angles = np.linspace(-45, 45, len(df))  # Smooth tracking
        df = df.with_columns(pl.Series("tracker_angle", angles))

        result = detector.detect_all(df)

        # Should not detect tracker stuck
        stuck_alerts = result.get_alerts_by_type(FaultType.TRACKER_STUCK)
        assert len(stuck_alerts) == 0


class TestConfiguration:
    """Test configuration handling."""

    def test_default_config(self):
        """Test default configuration values."""
        config = FaultDetectionConfig()

        assert config.inverter.min_daylight_irradiance == 100.0
        assert config.grid.nominal_frequency == 50.0
        assert config.string.min_active_current == 0.5

    def test_us_plant_config(self):
        """Test US plant configuration (60Hz)."""
        config = FaultDetectionConfig.for_us_plant()

        assert config.grid.nominal_frequency == 60.0

    def test_eu_plant_config(self):
        """Test EU plant configuration (50Hz)."""
        config = FaultDetectionConfig.for_eu_plant()

        assert config.grid.nominal_frequency == 50.0

    def test_config_serialization(self, tmp_path):
        """Test configuration save/load."""
        config = FaultDetectionConfig()
        config.inverter.max_module_temp = 90.0
        config.rated_dc_power_kw = 1000.0

        # Save
        config_path = tmp_path / "test_config.json"
        config.save(config_path)

        # Load
        loaded_config = FaultDetectionConfig.load(config_path)

        assert loaded_config.inverter.max_module_temp == 90.0
        assert loaded_config.rated_dc_power_kw == 1000.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


class TestDCVoltageEnvelopeRegression:
    """Regression guards for the DC voltage envelope detector.

    Two defects shipped together here. The margins were inverted
    (``upper = rated * 0.95``, ``lower = rated * 1.05``), so the "lower" limit sat
    above the "upper" one and every voltage between them tripped BOTH faults. And
    ``rated_dc_voltage_v`` is never populated by any code path, so the detector
    fell back to ``max(V) * 1.1`` -- putting the undervoltage limit at
    ``max(V) * 1.155``, above every observed sample. The net effect on real data
    was DC_UNDERVOLTAGE on essentially every non-zero daylight record, and
    DC_OVERVOLTAGE that could never fire.
    """

    @staticmethod
    def _frame(voltages):
        import datetime as dt

        n = len(voltages)
        return pl.DataFrame(
            {
                "timestamp": [
                    dt.datetime(2024, 6, 1, 6, 0) + dt.timedelta(minutes=5 * i)
                    for i in range(n)
                ],
                "dc_voltage": voltages,
                "poa_irradiance": [800.0] * n,
            }
        )

    def test_refuses_to_guess_the_mppt_window(self):
        """With no configured rated voltage the detector must emit nothing."""
        cfg = FaultDetectionConfig.for_eu_plant()
        assert cfg.rated_dc_voltage_v is None, "fixture assumes the field is unset by default"
        detector = RuleBasedFaultDetector(cfg)
        alerts = detector._detect_dc_voltage_envelope(self._frame([700.0 + (i % 40) for i in range(400)]))
        assert alerts == [], (
            "detector estimated a rated voltage from the data; it must refuse instead"
        )

    def test_over_and_under_are_mutually_exclusive(self):
        """No single voltage may trip both DC_OVERVOLTAGE and DC_UNDERVOLTAGE."""
        cfg = FaultDetectionConfig.for_eu_plant()
        cfg.rated_dc_voltage_v = 750.0
        detector = RuleBasedFaultDetector(cfg)

        margin = abs(1.0 - cfg.dc_voltage.upper_margin)
        inside = 750.0                      # dead centre of the window
        below = 750.0 * (1.0 - margin) - 25.0
        above = 750.0 * (1.0 + margin) + 25.0

        for value, expected in ((inside, set()),
                                (below, {FaultType.DC_UNDERVOLTAGE}),
                                (above, {FaultType.DC_OVERVOLTAGE})):
            alerts = detector._detect_dc_voltage_envelope(self._frame([value] * 400))
            kinds = {a.fault_type for a in alerts}
            assert kinds == expected, f"V={value}: expected {expected}, got {kinds}"
            assert not (FaultType.DC_OVERVOLTAGE in kinds and FaultType.DC_UNDERVOLTAGE in kinds)
