"""Unit tests for PerInverterSoilingAnalyzer
(nuravolt/soiling/per_inverter_analysis.py) — the engine behind the alpha
per-inverter artifacts.

The fixture builds wide-SCADA data to the analyzer's own physics
(SR = normalized power / ((G/1000)·0.82)) with two engineered defects:
one inverter 8% dirtier and one with a sustained 12-day outage (the analyzer's
7-day median smoothing deliberately suppresses shorter blips). The tests
assert the analyzer's math finds exactly what was engineered.
"""

import numpy as np
import pandas as pd
import pytest

from nuravolt.soiling.per_inverter_analysis import PerInverterSoilingAnalyzer

N_INV = 6
N_DAYS = 45
DIRTY = 'INV 01.006'   # engineered 8% dirtier
OUTAGE = 'INV 01.005'  # engineered 12-day zero-power outage

SITE_CONFIG = {
    'name': 'Testplant', 'latitude': 39.0, 'longitude': -3.0,
    'timezone': 'Europe/Madrid', 'capacity_MW': 1.5, 'tilt': 25.0,
    'azimuth': 180.0, 'electricity_rate_per_MWh': 65.0,
    'cleaning_cost_per_MW': 600.0,
}


def _col(i: int) -> str:
    return f'Testplant (ES): INV 01.{i + 1:03d} / Inverter Power Normalized (kW / kWp)'


@pytest.fixture(scope='module')
def analyzer(tmp_path_factory):
    rng = np.random.default_rng(21)
    # 15-min stamps, daylight-heavy synthetic irradiance bell.
    stamps = pd.date_range('2024-03-01', periods=N_DAYS * 96, freq='15min')
    hours = (stamps.hour + stamps.minute / 60).to_numpy()
    irr = np.clip(np.sin((hours - 6) / 14 * np.pi), 0, None) * 900
    irr += rng.normal(0, 12, len(irr))
    irr = np.clip(irr, 0, None)

    sr_true = {f'INV 01.{i + 1:03d}': 0.98 for i in range(N_INV)}
    sr_true[DIRTY] = 0.90

    frame = {'timestamp': stamps, 'Meteo: Radiation Horizontal (W/m2)': irr,
             'Meteo: Ambient Temperature (C)': 18 + 8 * np.clip(np.sin((hours - 8) / 12 * np.pi), 0, None)}
    outage_mask = (stamps >= '2024-03-15') & (stamps < '2024-03-27')
    for i in range(N_INV):
        inv = f'INV 01.{i + 1:03d}'
        power = (irr / 1000.0) * 0.82 * sr_true[inv]
        power = np.clip(power + rng.normal(0, 0.004, len(irr)), 0, None)
        if inv == OUTAGE:
            power[outage_mask] = 0.0
        frame[_col(i)] = power

    parquet = tmp_path_factory.mktemp('scada') / 'scada.parquet'
    pd.DataFrame(frame).to_parquet(parquet, index=False)

    a = PerInverterSoilingAnalyzer(
        site_config=SITE_CONFIG,
        output_dir=str(tmp_path_factory.mktemp('out')),
    )
    a.load_data(str(parquet))
    a.analyze_all_inverters()
    return a


def test_column_detection_finds_exactly_the_fleet(analyzer):
    assert len(analyzer.inverter_columns) == N_INV
    assert analyzer.inverter_columns == sorted(
        analyzer.inverter_columns,
        key=lambda c: c,  # zero-padded ids sort lexically == numerically
    )
    assert analyzer.irradiance_col == 'Meteo: Radiation Horizontal (W/m2)'


def test_extract_inverter_id(analyzer):
    inv_id, group = analyzer._extract_inverter_id(_col(0))
    assert inv_id == 'INV 01.001'
    assert group == 'INV 01'


def test_sr_in_range_with_real_variance(analyzer):
    metrics = analyzer.inverter_metrics
    assert len(metrics) == N_INV
    means = [m.sr_mean for m in metrics.values()]
    assert all(0.0 <= v <= 1.05 for v in means)
    assert float(np.std(means)) > 0.01, 'engineered 8% spread must survive analysis'


def test_dirty_inverter_ranks_worst_of_the_healthy(analyzer):
    """The 12-day outage inverter legitimately loses the most energy overall;
    among the operating fleet the engineered-dirty inverter must rank worst."""
    metrics = analyzer.inverter_metrics
    healthy = {k: m for k, m in metrics.items() if k != OUTAGE}
    worst_healthy = min(healthy.values(), key=lambda m: m.sr_mean)
    assert worst_healthy.inverter_id == DIRTY
    assert metrics[DIRTY].fleet_rank >= N_INV - 1
    assert metrics[DIRTY].sr_mean < min(
        m.sr_mean for k, m in healthy.items() if k != DIRTY
    ) - 0.03, 'the engineered 8% soiling gap must be clearly resolved'


def test_outage_inverter_gets_anomalies(analyzer):
    assert analyzer.inverter_metrics[OUTAGE].anomaly_count > 0


def test_fleet_ranks_are_a_permutation(analyzer):
    ranks = sorted(m.fleet_rank for m in analyzer.inverter_metrics.values())
    assert ranks == list(range(1, N_INV + 1))
    zs = [m.z_score for m in analyzer.inverter_metrics.values()]
    assert abs(float(np.mean(zs))) < 0.5


def test_fleet_summary_partitions_and_names_performers(analyzer):
    fs = analyzer.calculate_fleet_summary()
    total = (fs.inverters_normal + fs.inverters_minor_issues
             + fs.inverters_major_issues + fs.inverters_critical)
    assert total == N_INV
    d = fs.to_dict()
    assert d['topPerformers'], 'top performers must be named'
    assert d['worstPerformers'], 'worst performers must be named'
    # top-5/bottom-5 overlap is unavoidable with a 6-unit fleet; what matters
    # is that both engineered defects land at the bottom and neither leads.
    worst_ids = {p['inverterId'] for p in d['worstPerformers'][:2]}
    assert worst_ids == {DIRTY, OUTAGE}
    assert d['topPerformers'][0]['inverterId'] not in (DIRTY, OUTAGE)
    assert d['economicImpact']['estimatedAnnualLoss_EUR'] >= 0
