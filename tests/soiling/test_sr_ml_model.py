"""Unit tests for the per-inverter SR model (nuravolt/soiling/sr_ml_model.py).

Includes a regression test for the save/load round-trip: the inherited base
load() reconstructed PerInverterSRModel with the wrong config type, so no
per-inverter model could ever be loaded back (AttributeError) — one reason
the trainer was never wired into serving.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.sr_ml_model import (
    PerInverterModelConfig,
    PerInverterSRModel,
    SoilingRatioModelConfig,
)

N_INV = 6
N_DAYS = 80


@pytest.fixture(scope='module')
def training_frame():
    """Tiny per-inverter training set with a learnable signal: SR decays with
    days since rain, and each inverter carries a stable offset."""
    rng = np.random.default_rng(5)
    dates = pd.date_range('2024-01-01', periods=N_DAYS, freq='D')
    days_since_rain = np.arange(N_DAYS) % 20
    inverters = [f'INV_01_{i + 1:03d}' for i in range(N_INV)]
    offsets = rng.normal(0, 0.004, N_INV)

    rows = []
    for d_idx, d in enumerate(dates):
        for i, inv in enumerate(inverters):
            sr = 0.99 - 0.001 * days_since_rain[d_idx] + offsets[i] + rng.normal(0, 0.001)
            rows.append({
                'date': d,
                'inverter_id': inv,
                'days_since_rain': days_since_rain[d_idx],
                'rainfall_sum_7d': float(days_since_rain[d_idx] < 3) * 8.0,
                'inverter_pr_deviation': offsets[i],
                'day_of_year': d.dayofyear,
                'sr': sr,
            })
    return pd.DataFrame(rows)


@pytest.fixture(scope='module')
def fitted_model(training_frame):
    config = PerInverterModelConfig(
        base_config=SoilingRatioModelConfig(iterations=60, learning_rate=0.1),
        variant='dustiq',
    )
    model = PerInverterSRModel(config)
    feature_cols = ['days_since_rain', 'rainfall_sum_7d', 'inverter_pr_deviation', 'day_of_year']
    model.fit_per_inverter(
        X_train=training_frame[feature_cols],
        y_train=training_frame['sr'],
        inverter_ids=training_frame['inverter_id'],
        plant_id='testplant',
        verbose=False,
    )
    return model, feature_cols


def test_predictions_in_sr_band(fitted_model, training_frame):
    model, feature_cols = fitted_model
    preds = model.predict(training_frame[feature_cols])
    assert preds.min() > 0.8
    assert preds.max() < 1.05


def test_predict_per_inverter_schema(fitted_model, training_frame):
    model, feature_cols = fitted_model
    out = model.predict_per_inverter(
        training_frame[feature_cols],
        training_frame['inverter_id'],
        training_frame['date'],
    )
    for col in ('inverter_id', 'date', 'sr_predicted', 'confidence'):
        assert col in out.columns, f'missing column {col}'
    assert len(out) == len(training_frame)
    assert out['confidence'].between(0, 1).all()


def test_save_load_round_trip_predicts_identically(fitted_model, training_frame, tmp_path):
    """Regression: PerInverterSRModel.load() must reconstruct the subclass
    (including the per-inverter config) and predict bit-identically."""
    model, feature_cols = fitted_model
    path = tmp_path / 'sr_model_dustiq_testplant.pkl'
    model.save(path)
    assert path.with_suffix('.json').exists(), 'metadata sidecar must be written'

    loaded = PerInverterSRModel.load(path)
    assert loaded.per_inverter_config.variant == 'dustiq'
    np.testing.assert_array_almost_equal(
        model.predict(training_frame[feature_cols]),
        loaded.predict(training_frame[feature_cols]),
        decimal=12,
    )


def test_validate_predictions_flags_out_of_range(fitted_model, training_frame):
    model, _ = fitted_model
    bad = pd.DataFrame({
        'date': training_frame['date'].iloc[:10].values,
        'inverter_id': training_frame['inverter_id'].iloc[:10].values,
        'sr_predicted': [1.2, 0.5] + [0.97] * 8,
        'confidence': [0.9] * 10,
        'is_anomaly': [False] * 10,
    })
    result = model.validate_predictions(bad)
    assert result['is_valid'] is False
    assert result['issues'], 'out-of-range SR must surface as an issue'


def test_to_json_output_contract(fitted_model, training_frame):
    model, feature_cols = fitted_model
    preds = model.predict_per_inverter(
        training_frame[feature_cols],
        training_frame['inverter_id'],
        training_frame['date'],
    )
    out = model.to_json_output(preds, 'testplant')
    assert out['metadata']['plant_id'] == 'testplant'
    assert len(out['inverters']) == N_INV
    sample = next(iter(out['inverters'].values()))
    for key in ('current_sr', 'sr_7d_avg', 'confidence', 'history'):
        assert key in sample
    assert sample['history'][0]['date'] >= sample['history'][-1]['date']
