"""Unit tests for per-inverter feature engineering
(nuravolt/soiling/sr_per_inverter_features.py).

These pin the module's REAL calling contract — the contract the backfill
script violated for months without any test noticing (wrong kwargs, using the
None return value, raw-vs-underscored id mismatch).
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.sr_per_inverter_features import PerInverterFeatureEngineer

from .conftest import DIRTY_INVERTER


def _underscored(ext_id: str) -> str:
    return ext_id.replace(' ', '_').replace('.', '_')


@pytest.fixture()
def engineer(plant_dir):
    root = plant_dir('testplant')
    fe = PerInverterFeatureEngineer(plant_id='testplant')
    # Populates in place and returns None — that IS the contract.
    result = fe.load_inverter_metadata(
        all_inverters_path=str(root / 'per_inverter' / 'all_inverters.json')
    )
    assert result is None
    return fe


def test_load_inverter_metadata_populates_engineer(engineer, pr_daily_df):
    n_expected = pr_daily_df['inverterId'].nunique()
    assert len(engineer.inverter_metadata) == n_expected
    # Keys are the underscored id form.
    key = _underscored(DIRTY_INVERTER)
    assert key in engineer.inverter_metadata
    meta = engineer.inverter_metadata[key]
    assert meta.position_in_group == int(DIRTY_INVERTER.split('.')[-1])
    assert 0 < meta.sr_baseline <= 1.2
    assert meta.performance_rank >= 1


def test_expand_to_per_inverter_shapes_and_deviation(engineer, pr_daily_df):
    # Plant-level features: date-indexed frame (the real caller's shape).
    dates = pd.date_range('2024-03-01', periods=30, freq='D')
    plant_features = pd.DataFrame(
        {'rainfall_sum_7d': np.linspace(0, 12, len(dates)), 'month': dates.month},
        index=dates,
    )
    # PR frame with the module's expected inverter_id column (underscored to
    # match the metadata keys — the id-form mismatch the backfill tripped on).
    pr = pr_daily_df.copy()
    pr['inverter_id'] = pr['inverterId'].map(_underscored)

    expanded = engineer.expand_to_per_inverter(
        df_plant_features=plant_features,
        df_inverter_pr=pr,
        inverter_ids=list(engineer.inverter_metadata.keys()),
    ).reset_index()

    n_inv = len(engineer.inverter_metadata)
    assert len(expanded) == n_inv * len(dates)
    assert set(expanded['inverter_id'].unique()) == set(engineer.inverter_metadata)
    # Plant-level features are carried onto every per-inverter row.
    assert 'rainfall_sum_7d' in expanded.columns

    # Fleet-relative PR deviation: centred near 0 across the fleet, clearly
    # negative for the engineered dirty inverter.
    assert 'inverter_pr_deviation' in expanded.columns
    by_inv = expanded.groupby('inverter_id')['inverter_pr_deviation'].mean()
    assert abs(by_inv.mean()) < 0.02, 'fleet deviation must be centred near 0'
    dirty_key = _underscored(DIRTY_INVERTER)
    assert by_inv[dirty_key] < -0.03, (
        f'engineered dirty inverter deviation {by_inv[dirty_key]:.4f} '
        f'should be clearly negative'
    )
    assert by_inv[dirty_key] == by_inv.min()
