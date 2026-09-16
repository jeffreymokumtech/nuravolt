"""End-to-end test for scripts/backfill_per_inverter_sr.py.

Runs the real PerInverterBackfiller over the synthetic plant_dir layout with a
tiny trained PerInverterSRModel, and asserts the SERVED JSON contract: slug
filename, per-inverter distinctness, capped history, provenance metadata.
This is the harness that was missing when the script shipped with kwargs that
didn't exist on the feature engineer.
"""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.sr_ml_model import (
    PerInverterModelConfig,
    PerInverterSRModel,
    SoilingRatioModelConfig,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_backfill_module():
    spec = importlib.util.spec_from_file_location(
        'backfill_per_inverter_sr', REPO_ROOT / 'scripts' / 'backfill_per_inverter_sr.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _train_tiny_model(out_path: Path):
    """Fit a minimal model whose features exist on the backfill's feature
    path (extras are reindex-filled with 0), with real per-inverter signal
    via inverter_pr_deviation."""
    rng = np.random.default_rng(9)
    n = 600
    frame = pd.DataFrame({
        'rainfall_sum_7d': rng.uniform(0, 20, n),
        'day_of_year_sin': rng.uniform(-1, 1, n),
        'inverter_pr_deviation': rng.normal(0, 0.02, n),
    })
    y = 0.98 - 0.001 * frame['rainfall_sum_7d'] + 0.8 * frame['inverter_pr_deviation']
    model = PerInverterSRModel(PerInverterModelConfig(
        base_config=SoilingRatioModelConfig(iterations=50, learning_rate=0.1),
        variant='dustiq',
    ))
    model.fit_per_inverter(
        X_train=frame,
        y_train=y,
        inverter_ids=pd.Series([f'INV_01_{(i % 10) + 1:03d}' for i in range(n)]),
        plant_id='testplant',
        verbose=False,
    )
    model.save(out_path)


@pytest.fixture()
def backfilled(plant_dir, tmp_path):
    root = plant_dir('testplant')
    model_path = root / 'models' / 'sr_model_dustiq_testplant.pkl'
    _train_tiny_model(model_path)

    module = _load_backfill_module()
    backfiller = module.PerInverterBackfiller(
        plant_id='testplant',
        model_path=model_path,
        data_dir=root.parent,           # plant_dir factory rooted the plant here
        output_dir=root / 'per_inverter',
        history_days=45,
    )
    predictions = backfiller.backfill(verbose=False)
    output = json.loads((root / 'per_inverter' / 'testplant_per_inverter_sr.json').read_text())
    return predictions, output


def test_backfill_serves_slug_named_contract(backfilled, pr_daily_df):
    _, output = backfilled
    assert output['metadata']['plant_id'] == 'testplant'
    # External ids (with spaces/dots), not the internal underscored form.
    ids = set(output['inverters'])
    assert ids == set(pr_daily_df['inverterId'].unique())


def test_backfill_per_inverter_values_are_distinct(backfilled):
    _, output = backfilled
    current = [v['current_sr'] for v in output['inverters'].values()]
    assert len(set(np.round(current, 6))) > 1, 'current_sr must differ across the fleet'
    assert float(np.std(current)) > 0
    histories = {
        inv: tuple(h['sr'] for h in v['history'][:20])
        for inv, v in output['inverters'].items()
    }
    assert len(set(histories.values())) > 1, 'histories must not be clones'


def test_backfill_history_cap_and_provenance(backfilled):
    _, output = backfilled
    for v in output['inverters'].values():
        assert len(v['history']) <= 45
    prov = output['metadata']['provenance']
    assert prov['source'] == 'measured_per_inverter'
    assert prov['method'].startswith('lightgbm_')
    assert 'validation' in output


def test_backfill_predictions_frame_sane(backfilled):
    predictions, _ = backfilled
    assert predictions['sr_predicted'].between(0.5, 1.1).all()
    assert predictions['confidence'].between(0, 1).all()
    # One row per inverter per day inside the covered range.
    per_day = predictions.groupby('date')['inverter_id'].nunique()
    assert per_day.max() == predictions['inverter_id'].nunique()
