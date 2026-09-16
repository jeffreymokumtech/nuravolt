"""Peer-relative scoring: the properties that make it transfer across plants.

The central claim of tier A detection is that a peer-relative statistic carries
no portable constant, so it behaves identically on a 28-inverter plant and a
150-inverter one, in Spain or Georgia, on Huawei or SMA hardware. These tests
pin that claim rather than assert it.
"""

from __future__ import annotations

import datetime as dt

import numpy as np
import polars as pl
import pytest

from nuravolt.fault.peer_stats import (
    MAD_FLOOR_PU,
    MIN_PEERS,
    score_group,
    sustained_deficit_mask,
)
from nuravolt.fault.topology import ScoringGroup


def _fleet(n_devices: int, n_rows: int, *, deficit_on: int | None = None,
           deficit: float = 0.0, seed: int = 0, scale: float = 1.0):
    """A healthy fleet tracking a common diurnal profile, optionally with one bad device."""
    rng = np.random.default_rng(seed)
    t = np.linspace(0, np.pi, n_rows)
    common = np.sin(t) * 0.9                       # shared "weather"
    data = {"timestamp": [dt.datetime(2024, 6, 1, 6) + dt.timedelta(minutes=15 * i)
                          for i in range(n_rows)]}
    for d in range(n_devices):
        series = common * (1.0 + rng.normal(0, 0.01, n_rows))
        if deficit_on is not None and d == deficit_on:
            series = series * (1.0 - deficit)
        data[f"INV{d:02d}"] = np.clip(series, 0, None) * scale
    return pl.DataFrame(data)


def _group(n_devices: int):
    ids = [f"INV{d:02d}" for d in range(n_devices)]
    return ScoringGroup(key=("1.1", "model", 0), population=ids, scored=ids,
                        level="inverter_within_bus")


def _colmap(n_devices: int):
    return {f"INV{d:02d}": f"INV{d:02d}" for d in range(n_devices)}


class TestTransferProperties:
    @pytest.mark.parametrize("n_devices", [5, 28, 150])
    @pytest.mark.parametrize("scale", [1.0, 78.65, 1083.0])
    def test_scores_are_invariant_to_fleet_size_and_device_scale(self, n_devices, scale):
        """The same 20% deficit must score the same on any fleet size or nameplate.

        This is the whole tier A claim in one test: a 28-inverter Spanish plant
        of 78 kWp strings inverters and a 36-inverter German plant of 1,083 kWp
        centrals must produce the same number for the same physical fault.
        """
        df = _fleet(n_devices, 40, deficit_on=0, deficit=0.20, scale=scale)
        norms = {f"INV{d:02d}": scale for d in range(n_devices)}
        scores = score_group(df, _group(n_devices), _colmap(n_devices), normalizers=norms)
        assert scores is not None
        ratio = scores.frame["INV00__ratio"].drop_nulls()
        assert ratio.median() == pytest.approx(0.80, abs=0.02), (
            f"n={n_devices}, scale={scale}: expected ratio 0.80, got {ratio.median():.3f}"
        )

    def test_healthy_fleet_produces_no_deficit(self):
        df = _fleet(20, 40)
        scores = score_group(df, _group(20), _colmap(20))
        for d in scores.scored_devices:
            ratio = scores.frame[f"{d}__ratio"].drop_nulls()
            assert ratio.median() == pytest.approx(1.0, abs=0.02)


class TestRobustness:
    def test_catches_the_device_a_mean_std_rule_would_miss(self):
        """The reason median/MAD is load bearing rather than stylistic.

        A mean/std rule computes its dispersion from a population containing the
        outlier, so a badly failing device inflates the band that is supposed to
        catch it. Median and MAD have a 50 percent breakdown point.
        """
        df = _fleet(6, 30, deficit_on=0, deficit=0.60)
        cols = [f"INV{d:02d}" for d in range(6)]
        row = df.select(cols).row(15)
        values = np.array(row, dtype=float)

        classic = (values[0] - values.mean()) / values.std(ddof=1)
        scores = score_group(df, _group(6), _colmap(6))
        robust = scores.frame["INV00__z"].drop_nulls()[15]

        assert abs(classic) < 3.0, f"fixture broken: classic z already flags at {classic:.2f}"
        assert robust < -3.5, f"robust z should flag hard, got {robust:.2f}"

    def test_uniform_fleet_does_not_explode(self):
        """A perfectly uniform fleet has MAD near zero; the floor must hold."""
        n_rows = 30
        data = {"timestamp": [dt.datetime(2024, 6, 1, 6) + dt.timedelta(minutes=15 * i)
                              for i in range(n_rows)]}
        for d in range(8):
            data[f"INV{d:02d}"] = [0.8] * n_rows
        scores = score_group(pl.DataFrame(data), _group(8), _colmap(8))
        z = scores.frame["INV00__z"].drop_nulls()
        assert z.abs().max() < 1e-6, f"uniform fleet produced z={z.abs().max()}"

    def test_below_min_peers_returns_none_not_zeros(self):
        df = _fleet(MIN_PEERS - 1, 20)
        assert score_group(df, _group(MIN_PEERS - 1), _colmap(MIN_PEERS - 1)) is None

    def test_night_is_not_scored(self):
        """With the peer median below the generation gate, scores must be null."""
        n_rows = 20
        data = {"timestamp": [dt.datetime(2024, 6, 1, 0) + dt.timedelta(minutes=15 * i)
                              for i in range(n_rows)]}
        for d in range(8):
            data[f"INV{d:02d}"] = [0.001] * n_rows
        scores = score_group(pl.DataFrame(data), _group(8), _colmap(8))
        assert scores.frame["INV00__ratio"].drop_nulls().len() == 0


class TestSustainedDeficit:
    def test_a_single_sample_is_not_an_alert(self):
        df = _fleet(10, 40)
        arr = df["INV00"].to_list()
        arr[10] = arr[10] * 0.3               # one bad sample only
        df = df.with_columns(pl.Series("INV00", arr))
        scores = score_group(df, _group(10), _colmap(10))
        mask = sustained_deficit_mask(scores.frame, "INV00",
                                      ratio_max=0.90, z_max=-4.0, min_consecutive=8)
        assert not mask.any(), "a single sample must not raise"

    def test_a_sustained_deficit_does_alert(self):
        df = _fleet(10, 40, deficit_on=0, deficit=0.25)
        scores = score_group(df, _group(10), _colmap(10))
        mask = sustained_deficit_mask(scores.frame, "INV00",
                                      ratio_max=0.90, z_max=-4.0, min_consecutive=8)
        assert mask.any(), "a sustained 25% deficit must raise"
