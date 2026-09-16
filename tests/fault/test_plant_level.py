"""The cross-device entry point, and the silent-zero failures it must not have.

``detect_plant_level`` is the first code path in this package that can see more
than one device at once. Everything that used to be an absolute threshold at
inverter grain becomes expressible here as a peer statistic, so these tests pin
both that it fires when it should and -- more importantly -- that it cannot
return a clean result from no data.
"""

import datetime as dt

import polars as pl
import pytest

from nuravolt.fault.config import FaultDetectionConfig
from nuravolt.fault.rule_based import FaultType, RuleBasedFaultDetector
from nuravolt.fault.topology import parse_component_meta

N = 240


def _meta(n_inverters: int, prefix: str = "INV") -> str:
    head = ("plantId;plantName;componentName;componentLabel;componentType;"
            "componentTypeGroup;Bus;Installed P_DC;Location;Network Address;"
            "Nominal P_AC;Serial;source")
    rows = [head]
    for i in range(1, n_inverters + 1):
        name = f"{prefix} 01.{i:03d}"
        rows.append(f"00001;Fixture;{name};{name};SUN 2000 - 60 KTL;Inverter;"
                    f"2.1;84.48;A;{i};60;SN{i};nA")
    return "\n".join(rows)


def _frame(n_inverters: int, *, hot=None, weak=None, prefix="INV") -> pl.DataFrame:
    """A flat, healthy plant, optionally with one hot and one weak machine."""
    t0 = dt.datetime(2024, 6, 1, 6, 0)
    data = {"timestamp": [t0 + dt.timedelta(minutes=15 * i) for i in range(N)]}
    for i in range(1, n_inverters + 1):
        dev = f"{prefix} 01.{i:03d}"
        # A little dispersion, so the MAD is not degenerate.
        wobble = 0.01 * ((i % 3) - 1)
        power = 50.0 * (1.0 + wobble)
        temp = 40.0 + 2.0 * ((i % 3) - 1)
        if weak == i:
            power *= 0.7
        if hot == i:
            temp += 15.0
        data[f"Fixture: {dev} / P_AC (kW)"] = [power] * N
        data[f"Fixture: {dev} / Temperature (C)"] = [temp] * N
    return pl.DataFrame(data)


def _maps(df, topo, signal):
    from nuravolt.fault.topology import resolve_device_columns
    return resolve_device_columns(df.columns, topo, signal_match=signal)


@pytest.fixture
def detector():
    return RuleBasedFaultDetector(FaultDetectionConfig.for_eu_plant())


class TestPeerOvertemperature:
    def test_one_hot_machine_is_found_without_any_temperature_limit(self, detector):
        """No datasheet, no threshold: 55 C among peers at 40 C is the signal."""
        topo = parse_component_meta(_meta(8), "fixture")
        df = _frame(8, hot=3)
        alerts = detector.detect_plant_level(
            df, topo, temperature_for=_maps(df, topo, "/ Temperature"))
        hot = [a for a in alerts if a.fault_type is FaultType.INVERTER_OVERTEMPERATURE]
        assert hot, "a machine 15 C above its peers was not flagged"
        assert all("01.003" in (a.inverter_id or "") for a in hot)

    def test_a_uniformly_hot_plant_is_silent(self, detector):
        """August is not a fault. Every machine hot together must stay quiet.

        This is the property an absolute limit cannot have, and the reason the
        rule was moved here.
        """
        topo = parse_component_meta(_meta(8), "fixture")
        df = _frame(8)
        df = df.with_columns([
            (pl.col(c) + 35.0).alias(c) for c in df.columns if "Temperature" in c
        ])
        alerts = detector.detect_plant_level(
            df, topo, temperature_for=_maps(df, topo, "/ Temperature"))
        assert not [a for a in alerts
                    if a.fault_type is FaultType.INVERTER_OVERTEMPERATURE], (
            "a plant that is simply hot was reported as faulty"
        )


class TestPeerUnderperformance:
    def test_one_weak_machine_is_found(self, detector):
        topo = parse_component_meta(_meta(8), "fixture")
        df = _frame(8, weak=5)
        alerts = detector.detect_plant_level(
            df, topo,
            power_for=_maps(df, topo, "P_AC"),
            normalizers={d: m.kwp_dc for d, m in topo.devices.items() if m.kwp_dc},
        )
        weak = [a for a in alerts
                if a.fault_type is FaultType.INVERTER_UNDERPERFORMANCE_PEER]
        assert weak, "a machine at 70% of its peers was not flagged"
        assert all("01.005" in (a.inverter_id or "") for a in weak)

    def test_a_healthy_plant_is_silent(self, detector):
        topo = parse_component_meta(_meta(8), "fixture")
        df = _frame(8)
        alerts = detector.detect_plant_level(
            df, topo,
            power_for=_maps(df, topo, "P_AC"),
            normalizers={d: m.kwp_dc for d, m in topo.devices.items() if m.kwp_dc},
        )
        assert alerts == []


class TestSilentZero:
    """The failure mode that is indistinguishable from good news."""

    def test_name_mismatch_raises_rather_than_reporting_a_clean_plant(self):
        """eta's metadata says WR.01.001; its telemetry says INV 01.001.

        Digit-sequence matching reconciles them. When it cannot, the resolver
        must raise -- a peer detector that mapped no devices reports a perfectly
        healthy plant, which is the most dangerous output it could produce.
        """
        from nuravolt.fault.topology import resolve_device_columns

        topo = parse_component_meta(_meta(8, prefix="WR"), "fixture")
        df = _frame(8, prefix="INV")
        mapped = resolve_device_columns(df.columns, topo, signal_match="/ Temperature")
        assert len(mapped) == 8, "WR/INV reconciliation failed"

        with pytest.raises(LookupError):
            resolve_device_columns(df.columns, topo, signal_match="/ Nonexistent")

    def test_too_few_devices_is_not_scored(self, detector):
        """Three peers cannot support a median and a MAD; do not pretend."""
        topo = parse_component_meta(_meta(3), "fixture")
        df = _frame(3, hot=1)
        alerts = detector.detect_plant_level(
            df, topo, temperature_for=_maps(df, topo, "/ Temperature"))
        assert alerts == []
