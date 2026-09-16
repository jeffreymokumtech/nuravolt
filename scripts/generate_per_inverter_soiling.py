#!/usr/bin/env python3
"""Regenerate the served per-inverter soiling artifacts from MEASURED data.

One idempotent entrypoint per plant. This replaces the placeholder chain
(fleet-mean fan-out + post-process jitter) that used to produce
all_inverters.json / per_inverter/*.json.

Methods (both fully measured, labelled in metadata.provenance):

- pr_daily plants (ribera, eta): each inverter's daily measured PR is
  self-normalized against its own rolling clean baseline (95th percentile,
  90 d) — removing fixed efficiency differences so the residual is
  soiling-attributable — then the fleet mean is calibrated per-day to the
  plant's measured DustIQ soiling ratio. Cross-inverter spread and ranking
  are measured; the absolute level is anchored to the reference sensor.
  (The trained LightGBM/DustIQ model is deliberately NOT the per-inverter
  source: it was fitted against the single plant-level DustIQ label, so it
  learned to ignore inverter features — max per-date fleet spread 0.002.)

- wide-SCADA plants (alpha/alpha1): PerInverterSoilingAnalyzer runs over the
  raw 15-min SCADA parquet (irradiance-normalized per-inverter SR, anomaly
  detection, fleet z-scores), then internal INV ids are mapped to the
  registered PV- external ids.

An anti-placeholder gate refuses to write when the fleet spread collapses or
the physics validation fails, so a regression back to broadcast values can
never silently ship.

Usage:
    python scripts/generate_per_inverter_soiling.py --plant ribera --history-days 120
    python scripts/generate_per_inverter_soiling.py --plant eta
    python scripts/generate_per_inverter_soiling.py --plant alpha
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))

from nuravolt.soiling.sr_validation import validate_sr_range, validate_rain_resets

DATA_DIR = Path('public/data/soiling')
PLANTS_DIR = Path('public/data/plants')

BASELINE_WINDOW_D = 90
BASELINE_QUANTILE = 0.95
STATS_WINDOW_D = 90  # trailing window for per-inverter stats / severity

PLANTS = {
    'ribera': {'kind': 'pr_daily', 'method': 'measured_pr_selfnorm_dustiq_calibrated'},
    'eta': {'kind': 'pr_daily', 'method': 'measured_pr_selfnorm_dustiq_calibrated'},
    'alpha': {
        'kind': 'scada_wide',
        'method': 'irradiance_normalized_scada',
        'scada_path': 'analyticsbackend_deprecated/data/alpha1/scada.parquet',
        # dict config on purpose: calculate_fleet_summary calls config.get()
        'site_config': {
            'name': 'Alpha Solar Plant', 'latitude': 37.45, 'longitude': -6.14,
            'timezone': 'Europe/Madrid', 'capacity_MW': 9.0, 'tilt': 25.0,
            'azimuth': 180.0, 'electricity_rate_per_MWh': 65.0,
            'cleaning_cost_per_MW': 600.0,
        },
    },
}


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

DEFAULT_PREFERENCES = {'irradianceSource': 'auto', 'soilingReference': 'auto'}


def _plant_preferences(plant: str) -> dict:
    """Operator source preferences from Plant.metadata.settings.dataSources.

    Read from the ops DB when DATABASE_URL is set (exact slug first, then
    slug-prefix so fixture short names like 'ribera' find 'ribera-solar').
    Defaults to auto/auto offline so the script stays runnable without a DB.
    """
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        return dict(DEFAULT_PREFERENCES)
    try:
        import psycopg2
        conn = psycopg2.connect(dsn)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT metadata FROM "Plant" WHERE slug = %s '
                    'UNION ALL '
                    'SELECT metadata FROM "Plant" WHERE slug LIKE %s AND slug != %s '
                    'LIMIT 1',
                    (plant, f'{plant}%', plant),
                )
                row = cur.fetchone()
        finally:
            conn.close()
    except Exception as exc:
        print(f"   ⚠️ preference lookup failed ({exc}) — using auto/auto")
        return dict(DEFAULT_PREFERENCES)

    meta = (row[0] if row else None) or {}
    stored = ((meta.get('settings') or {}).get('dataSources') or {})
    prefs = dict(DEFAULT_PREFERENCES)
    if stored.get('irradianceSource') in ('auto', 'onsite', 'open_meteo'):
        prefs['irradianceSource'] = stored['irradianceSource']
    if stored.get('soilingReference') in ('auto', 'dustiq', 'inferred'):
        prefs['soilingReference'] = stored['soilingReference']
    return prefs


def _load_json(path: Path):
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def _registered_ids(plant: str):
    """External inverter ids + groups from the plant registry, or None."""
    data = _load_json(PLANTS_DIR / plant / 'inverter_groups.json')
    if not data:
        return None
    groups = data.get('inverter_groups') if isinstance(data, dict) else data
    ids = {}
    for group in groups or []:
        gid = group.get('name') or group.get('external_id') or group.get('id')
        for inv in group.get('inverters', []):
            ext = inv.get('external_id') or inv.get('id')
            if ext:
                ids[ext] = gid or str(ext).split('.')[0]
    return ids or None


def _severity(deviation_pct: float, z: float, anomaly_days: int, sr_std: float) -> str:
    """The analyzer's multi-criteria severity, lowercased for the served files."""
    failed = 0
    if deviation_pct < -15:
        failed += 1
    if z < -2:
        failed += 1
    if anomaly_days > 5:
        failed += 1
    if sr_std > 0.05:
        failed += 1
    return {4: 'critical', 3: 'major', 2: 'minor'}.get(failed, 'normal')


def _round(x, nd=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), nd)


# ---------------------------------------------------------------------------
# pr_daily path (ribera, eta)
# ---------------------------------------------------------------------------

def analyze_pr_daily(plant: str, soiling_reference: str = 'auto'):
    """Measured per-inverter SR from self-normalized PR, DustIQ-calibrated.

    soiling_reference (operator preference): 'auto' anchors to DustIQ when the
    history exists; 'dustiq' requires it (clear error otherwise); 'inferred'
    skips the anchor entirely (self-normalized, uncalibrated absolute level).

    Returns (sr_wide, conf_wide, pr_window_mean, anchored) where
    sr_wide/conf_wide are date x inverter DataFrames and anchored says whether
    the DustIQ calibration was applied.
    """
    plant_dir = DATA_DIR / plant
    df = pd.read_parquet(plant_dir / 'pr_daily.parquet')
    df['date'] = pd.to_datetime(df['date'])
    wide = df.pivot_table(index='date', columns='inverterId', values='pr').sort_index()

    # Per-inverter clean baseline: rolling P95 of own PR. Self-normalization
    # removes fixed efficiency offsets; what remains tracks soiling + faults.
    baseline = wide.rolling(f'{BASELINE_WINDOW_D}D', min_periods=30).quantile(BASELINE_QUANTILE)
    baseline = baseline.ffill().bfill()
    sr_raw = (wide / baseline).clip(0.5, 1.1)

    # Calibrate fleet mean to the measured DustIQ plant SR (absolute anchor).
    dustiq = _load_json(plant_dir / 'dustiq_history.json') or {}
    dustiq_daily = pd.Series({
        pd.Timestamp(row['date']): row['sr_dustiq']
        for row in dustiq.get('daily_data', [])
        if row.get('sr_dustiq') is not None
    }).sort_index()

    if soiling_reference == 'dustiq' and len(dustiq_daily) == 0:
        sys.exit(f"[{plant}] soiling reference preference is 'dustiq' but "
                 f"{plant_dir / 'dustiq_history.json'} has no usable data — "
                 "fix the sensor feed or switch the preference to auto/inferred.")

    anchored = len(dustiq_daily) > 0 and soiling_reference != 'inferred'
    if anchored:
        anchor = dustiq_daily.reindex(sr_raw.index).interpolate(limit=7).ffill().bfill()
        k = (anchor / sr_raw.mean(axis=1)).clip(0.85, 1.15)
    else:
        if soiling_reference == 'inferred' and len(dustiq_daily) > 0:
            print(f"   ⚙️ Operator preference: inferred — skipping the DustIQ anchor")
        k = pd.Series(1.0, index=sr_raw.index)
    sr_cal = sr_raw.mul(k, axis=0).clip(0.4, 1.05)

    # Confidence: measured-data completeness over the trailing 30 days.
    completeness = wide.notna().rolling('30D', min_periods=1).mean()
    conf = (0.3 + 0.65 * completeness).clip(0.3, 0.95)

    return sr_cal, conf, wide, anchored


def records_from_pr_daily(plant: str, sr_cal: pd.DataFrame, conf: pd.DataFrame,
                          pr_wide: pd.DataFrame, registered: dict):
    """Per-inverter stat records over the trailing STATS_WINDOW_D."""
    end = sr_cal.index.max()
    window = sr_cal.loc[sr_cal.index >= end - pd.Timedelta(days=STATS_WINDOW_D)]
    pr_window = pr_wide.loc[pr_wide.index >= end - pd.Timedelta(days=STATS_WINDOW_D)]

    sr_means = window.mean()
    fleet_mean = float(sr_means.mean())
    fleet_std = float(sr_means.std(ddof=0)) or 1e-9

    # Anomaly days: relative deviation below the fleet daily mean > 15%.
    rel_dev = window.div(window.mean(axis=1), axis=0) - 1.0
    anomaly_days = (rel_dev < -0.15).sum()

    ranks = sr_means.rank(ascending=False, method='first').astype(int)
    records = []
    for inv in sr_means.index:
        sr_mean = float(sr_means[inv])
        dev_pct = (sr_mean - fleet_mean) / fleet_mean * 100
        z = (sr_mean - fleet_mean) / fleet_std
        sr_std = float(window[inv].std(ddof=0))
        records.append({
            'inverterId': inv,
            'groupId': (registered or {}).get(inv) or inv.split('.')[0],
            'sr_mean': sr_mean,
            'sr_median': float(window[inv].median()),
            'sr_min': float(window[inv].min()),
            'sr_max': float(window[inv].max()),
            'sr_std': sr_std,
            'pr_mean': float(pr_window[inv].mean()),
            'anomaly_days': int(anomaly_days[inv]),
            'rank': int(ranks[inv]),
            'deviation_pct': dev_pct,
            'z_score': z,
            'severity': _severity(dev_pct, z, int(anomaly_days[inv]), sr_std),
            'data_completeness_pct': float(pr_window[inv].notna().mean() * 100),
        })
    return records, {
        'fleet_mean': fleet_mean, 'fleet_std': fleet_std,
        'sr_min': float(window.min().min()), 'sr_max': float(window.max().max()),
        'window_start': str(window.index.min().date()),
        'window_end': str(window.index.max().date()),
        'data_start': str(sr_cal.index.min().date()),
        'data_end': str(sr_cal.index.max().date()),
    }


# ---------------------------------------------------------------------------
# wide-SCADA path (alpha)
# ---------------------------------------------------------------------------

def map_internal_to_external(inv_id: str) -> str:
    """'INV 01.001' -> 'PV-01.001' (alpha registry convention)."""
    return inv_id.replace('INV ', 'PV-')


def analyze_scada(plant: str, cfg: dict, registered: dict):
    """Run the real analyzer over raw SCADA; return (records, fleet, sr_hist).

    sr_hist: {external_id: pd.Series of daily SR} for the served history.
    """
    from nuravolt.soiling.per_inverter_analysis import PerInverterSoilingAnalyzer

    analyzer = PerInverterSoilingAnalyzer(
        site_config=cfg['site_config'],
        output_dir=str(DATA_DIR / plant / '_analyzer_scratch'),
    )
    analyzer.load_data(cfg['scada_path'])
    metrics = analyzer.analyze_all_inverters()

    # Daily per-inverter SR history for the serving file.
    per_inverter_sr = analyzer.calculate_per_inverter_sr()
    sr_hist = {}
    for col, sr_df in per_inverter_sr.items():
        inv_clean, _group = analyzer._extract_inverter_id(col)
        ext = map_internal_to_external(inv_clean)
        daily = sr_df['sr_smooth'].resample('D').mean().dropna().clip(0.4, 1.05)
        sr_hist[ext] = daily

    records = []
    sr_means = {}
    for inv_id, m in metrics.items():
        ext = map_internal_to_external(inv_id)
        sr_means[ext] = m.sr_mean
        records.append({
            'inverterId': ext,
            'groupId': (registered or {}).get(ext) or map_internal_to_external(m.group_id),
            'sr_mean': float(m.sr_mean),
            'sr_median': float(m.sr_median),
            'sr_min': float(m.sr_min),
            'sr_max': float(m.sr_max),
            'sr_std': float(m.sr_std),
            'pr_mean': float(m.performance_ratio),
            'anomaly_days': int(m.anomaly_count),
            'rank': int(m.fleet_rank),
            'deviation_pct': float(m.deviation_from_fleet_mean_pct),
            'z_score': float(m.z_score),
            'severity': m.severity.lower(),
            'data_completeness_pct': float(m.data_completeness_pct),
        })
    vals = np.array(list(sr_means.values()))
    first = next(iter(metrics.values()))
    weather = dict(analyzer.weather_provenance or {})
    if analyzer.irradiance_source and 'source' not in weather:
        weather['source'] = analyzer.irradiance_source
    return records, {
        'fleet_mean': float(vals.mean()), 'fleet_std': float(vals.std()),
        'sr_min': float(min(m.sr_min for m in metrics.values())),
        'sr_max': float(max(m.sr_max for m in metrics.values())),
        'window_start': first.analysis_start, 'window_end': first.analysis_end,
        'data_start': first.analysis_start, 'data_end': first.analysis_end,
    }, sr_hist, weather


# ---------------------------------------------------------------------------
# Anti-placeholder gate
# ---------------------------------------------------------------------------

def gate_or_die(plant: str, records: list, sr_fleet_daily: pd.Series, plant_dir: Path):
    """Refuse to write artifacts that look like a broadcast placeholder."""
    sr_means = [r['sr_mean'] for r in records]
    spread = float(np.std(sr_means))
    if spread <= 0.002:
        sys.exit(f"GATE FAILED [{plant}]: fleet SR-mean std {spread:.5f} <= 0.002 — "
                 f"per-inverter signal collapsed to a broadcast; refusing to write.")
    if len(set(np.round(sr_means, 6))) < max(3, len(sr_means) // 10):
        sys.exit(f"GATE FAILED [{plant}]: SR means are near-uniform; refusing to write.")
    zs = [r['z_score'] for r in records]
    if all(abs(z) < 1e-9 for z in zs):
        sys.exit(f"GATE FAILED [{plant}]: all z-scores are zero; refusing to write.")

    # Physics: served fleet SR must be in range and reset after heavy rain.
    n_viol, viol_rate = validate_sr_range(sr_fleet_daily, sr_min=0.4, sr_max=1.05)
    if viol_rate > 0.02:
        sys.exit(f"GATE FAILED [{plant}]: {n_viol} SR range violations "
                 f"({viol_rate:.1%}); refusing to write.")
    rain_csv = plant_dir / 'rain_history.csv'
    if rain_csv.exists():
        rain = pd.read_csv(rain_csv, parse_dates=['date']).set_index('date')
        n_events, n_ok, score = validate_rain_resets(
            sr_fleet_daily.copy(), rain, reset_threshold_sr=0.95)
        if n_events >= 3 and score < 0.5:
            sys.exit(f"GATE FAILED [{plant}]: SR resets after only {n_ok}/{n_events} "
                     f"heavy-rain events; series is not physically plausible.")
    print(f"   gate ok: spread={spread:.4f}, inverters={len(records)}")


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

# Set by generate() so every writer's provenance_block carries the run's
# operator preferences + effective weather source without changing four
# writer signatures.
PROVENANCE_EXTRAS: dict = {'preferences': None, 'weather': None}


def provenance_block(method: str, fleet: dict, preferences: dict | None = None,
                     weather: dict | None = None) -> dict:
    preferences = preferences if preferences is not None else PROVENANCE_EXTRAS['preferences']
    weather = weather if weather is not None else PROVENANCE_EXTRAS['weather']
    block = {
        'source': 'measured_per_inverter',
        'method': method,
        'data_start': fleet['data_start'],
        'data_end': fleet['data_end'],
        'stats_window': {'start': fleet['window_start'], 'end': fleet['window_end']},
        'generated_at': datetime.now().isoformat(),
    }
    if preferences:
        block['preferences'] = dict(preferences)
    if weather:
        # ensure_irradiance provenance: source/confidence/plane (+ forced /
        # fallback_reason keys when a preference overrode the auto pick).
        block['weather'] = {
            k: weather[k]
            for k in ('source', 'confidence', 'irradiance_plane', 'forced',
                      'requested', 'fallback_reason', 'skipped_onsite_column')
            if k in weather
        }
    return block


def write_all_inverters(plant: str, records: list, fleet: dict, method: str):
    payload = {
        'metadata': {
            'plant_id': plant,
            'generated_at': datetime.now().isoformat(),
            'total_inverters': len(records),
            'provenance': provenance_block(method, fleet),
        },
        'inverters': [
            {
                'inverterId': r['inverterId'],
                'groupId': r['groupId'],
                'powerLoss': _round(1 - r['sr_mean']),
                'performanceRatio': _round(r['pr_mean']),
                'soilingRatio': {
                    'mean': _round(r['sr_mean']),
                    'median': _round(r['sr_median']),
                    'min': _round(r['sr_min']),
                    'max': _round(r['sr_max']),
                    'std': _round(r['sr_std']),
                },
                'anomalyDetection': {
                    'anomalyRate_pct': _round(r['anomaly_days'] / max(STATS_WINDOW_D, 1) * 100, 2),
                },
                'fleetComparison': {
                    'severity': r['severity'],
                    'zScore': _round(r['z_score'], 2),
                    'rank': r['rank'],
                    'deviationPct': _round(r['deviation_pct'], 2),
                },
                'dataCompleteness_pct': _round(r['data_completeness_pct'], 1),
            }
            for r in sorted(records, key=lambda r: r['inverterId'])
        ],
    }
    for path in (DATA_DIR / plant / 'all_inverters.json',
                 DATA_DIR / plant / 'per_inverter' / 'all_inverters.json'):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(payload, f, indent=1, sort_keys=True)
        print(f"   wrote {path}")


def write_per_inverter_sr(plant: str, sr_hist: dict, conf_hist, fleet: dict,
                          method: str, history_days: int):
    """per_inverter/{plant}_per_inverter_sr.json — the sr-estimate route contract."""
    plant_dir = DATA_DIR / plant
    inverters = {}
    for ext, series in sorted(sr_hist.items()):
        recent = series.dropna().sort_index(ascending=False).head(history_days)
        if recent.empty:
            continue
        conf_series = None
        if conf_hist is not None and ext in conf_hist:
            conf_series = conf_hist[ext]
        history = []
        for d, sr in recent.items():
            c = float(conf_series.get(d, 0.7)) if conf_series is not None else 0.7
            history.append({'date': str(d.date()), 'sr': round(float(sr), 4),
                            'confidence': round(c, 3)})
        vals = [h['sr'] for h in history]
        inverters[ext] = {
            'current_sr': vals[0],
            'sr_7d_avg': round(float(np.mean(vals[:7])), 4) if len(vals) >= 7 else None,
            'confidence': history[0]['confidence'],
            'history': history,
        }

    # Real model metrics when a trained sidecar exists (context, not the source).
    metrics = None
    for cand in sorted((plant_dir / 'models').glob('sr_model_*.json')) if (plant_dir / 'models').exists() else []:
        meta = _load_json(cand) or {}
        metrics = meta.get('metrics', meta) or None
        break

    payload = {
        'metadata': {
            'plant_id': plant,
            'model_variant': method,
            'generated_at': datetime.now().isoformat(),
            'n_inverters': len(inverters),
            'provenance': provenance_block(method, fleet),
            **({'reference_model_metrics': metrics} if metrics else {}),
        },
        'inverters': inverters,
    }
    out = plant_dir / 'per_inverter' / f'{plant}_per_inverter_sr.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'w') as f:
        json.dump(payload, f, separators=(',', ':'), sort_keys=True)
    print(f"   wrote {out} ({out.stat().st_size / 1e6:.2f} MB)")

    # Remove stale donor-id files (e.g. alpha/alpha1_per_inverter_sr.json).
    for stale in out.parent.glob('*_per_inverter_sr.json'):
        if stale.name != out.name:
            stale.unlink()
            print(f"   removed stale {stale}")


def write_fleet_summary(plant: str, records: list, fleet: dict, method: str):
    """Update the fleet-level fields; preserve loss/economics blocks that other
    (real) pipelines own."""
    path = DATA_DIR / plant / 'fleet_summary.json'
    existing = _load_json(path) or {}
    by_sev = {'normal': 0, 'minor': 0, 'major': 0, 'critical': 0}
    for r in records:
        by_sev[r['severity']] = by_sev.get(r['severity'], 0) + 1
    ranked = sorted(records, key=lambda r: r['sr_mean'], reverse=True)
    existing.update({
        'analysisPeriod': {
            'start': fleet['window_start'], 'end': fleet['window_end'],
            'totalDays': STATS_WINDOW_D,
        },
        'fleetSoiling': {
            'srMean': _round(fleet['fleet_mean']),
            'srStd': _round(fleet['fleet_std']),
            'srMin': _round(fleet['sr_min']),
            'srMax': _round(fleet['sr_max']),
        },
        'healthDistribution': {
            'normal': by_sev['normal'],
            'minorIssues': by_sev['minor'],
            'majorIssues': by_sev['major'],
            'critical': by_sev['critical'],
        },
        'topPerformers': [
            {'inverterId': r['inverterId'], 'srMean': _round(r['sr_mean']), 'rank': i + 1}
            for i, r in enumerate(ranked[:5])
        ],
        'worstPerformers': [
            {'inverterId': r['inverterId'], 'srMean': _round(r['sr_mean']), 'rank': len(ranked) - i}
            for i, r in enumerate(ranked[-5:][::-1])
        ],
        'provenance': provenance_block(method, fleet),
    })
    pi = existing.setdefault('plantInfo', {})
    pi.setdefault('plantName', plant.title())
    pi['totalInverters'] = len(records)
    with open(path, 'w') as f:
        json.dump(existing, f, indent=1, sort_keys=True)
    print(f"   wrote {path}")


def write_ml_plant_summary(plant: str, records: list, fleet: dict, method: str):
    """Honest plant summary: measured fleet state + real optimizer economics.

    Replaces the old hardcoded block (ROI 250%, payback 45 d, mae 0.0138).
    Fields the UI reads but no real source exists for are null/omitted.
    """
    plant_dir = DATA_DIR / plant
    fleet_summary = _load_json(plant_dir / 'fleet_summary.json') or {}
    monthly = _load_json(plant_dir / 'monthly_summary.json') or {}
    proposal = _load_json(plant_dir / 'operator_proposal.json') or {}

    by_sev = {'normal': 0, 'minor': 0, 'major': 0, 'critical': 0}
    for r in records:
        by_sev[r['severity']] += 1
    total = len(records) or 1
    health_score = round(
        (by_sev['normal'] + 0.66 * by_sev['minor'] + 0.33 * by_sev['major']) / total * 100
    )

    # YTD losses: current-year rows of the (real) monthly summary.
    year = str(fleet['data_end'])[:4]
    ytd_energy = ytd_revenue = 0.0
    for row in monthly.get('months', monthly.get('monthly', [])) or []:
        if str(row.get('month', '')).startswith(year):
            ytd_energy += float(row.get('energy_loss_mwh', 0) or 0)
            ytd_revenue += float(row.get('revenue_loss_eur', 0) or 0)

    exec_summary = proposal.get('executive_summary', {})
    fin = proposal.get('financial_analysis', {})
    schedule = proposal.get('optimal_schedule', {})

    # Real trained-model metrics if a sidecar exists (reference context).
    validation = None
    models_dir = plant_dir / 'models'
    if models_dir.exists():
        for cand in sorted(models_dir.glob('sr_model_*.json')):
            meta = _load_json(cand) or {}
            m = meta.get('metrics', meta)
            if isinstance(m, dict) and any(k in m for k in ('mae', 'validation_mae')):
                validation = m
                break

    payload = {
        'plantInfo': {
            'plantId': plant,
            'plantName': fleet_summary.get('plantInfo', {}).get('plantName', plant.title()),
            'capacity_MW': fleet_summary.get('plantInfo', {}).get('capacity_MW'),
            'totalInverters': len(records),
            'healthScore': health_score,
        },
        'currentStatus': {
            'avgSoilingRatio': _round(fleet['fleet_mean']),
            'estimatedLossPct': _round(max(0.0, (1 - fleet['fleet_mean']) * 100), 2),
            'lastUpdateTime': datetime.now().isoformat(),
            'dataSource': method,
            **({'validation': validation} if validation else {}),
            'healthScore': health_score,
        },
        'fleetHealth': {
            'normalInverters': by_sev['normal'],
            'minorIssues': by_sev['minor'],
            'majorIssues': by_sev['major'],
            'critical': by_sev['critical'],
        },
        'economicImpact': {
            'ytdEnergyLoss_MWh': _round(ytd_energy, 2),
            'ytdRevenueLoss_EUR': _round(ytd_revenue, 2),
            'nextCleaningRecommended': (schedule.get('cleaning_dates') or [None])[0],
            'estimatedROI_pct': _round(exec_summary.get('expected_roi_pct'), 2),
            'expectedNetBenefit_EUR': _round(exec_summary.get('expected_net_benefit_EUR'), 2),
            'paybackDays': _round(fin.get('payback_days'), 1),
        },
        'topPerformers': [
            {'inverterId': r['inverterId'], 'srMean': _round(r['sr_mean']), 'rank': i + 1}
            for i, r in enumerate(sorted(records, key=lambda r: r['sr_mean'], reverse=True)[:5])
        ],
        'worstPerformers': [
            {'inverterId': r['inverterId'], 'srMean': _round(r['sr_mean']), 'rank': len(records) - i}
            for i, r in enumerate(sorted(records, key=lambda r: r['sr_mean'])[:5])
        ],
        'provenance': provenance_block(method, fleet),
    }
    path = plant_dir / 'ml_plant_summary.json'
    with open(path, 'w') as f:
        json.dump(payload, f, indent=1, sort_keys=True)
    print(f"   wrote {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def generate(plant: str, history_days: int):
    cfg = PLANTS[plant]
    plant_dir = DATA_DIR / plant
    registered = _registered_ids(plant)
    prefs = _plant_preferences(plant)
    if prefs != DEFAULT_PREFERENCES:
        print(f"   ⚙️ operator source preferences: irradiance={prefs['irradianceSource']}, "
              f"soiling reference={prefs['soilingReference']}")
    print(f"== {plant} ({cfg['kind']}, {cfg['method']}) ==")

    method = cfg['method']
    weather = None
    if cfg['kind'] == 'pr_daily':
        sr_cal, conf, pr_wide, anchored = analyze_pr_daily(
            plant, soiling_reference=prefs['soilingReference'])
        if not anchored:
            # Self-normalized but not anchored to the DustIQ absolute level —
            # label the method honestly so served artifacts say so.
            method = 'measured_pr_selfnorm_uncalibrated'
        records, fleet = records_from_pr_daily(plant, sr_cal, conf, pr_wide, registered)
        sr_hist = {inv: sr_cal[inv] for inv in sr_cal.columns}
        conf_hist = {inv: conf[inv] for inv in conf.columns}
        sr_fleet_daily = sr_cal.mean(axis=1)
    else:
        # The analyzer reads the irradiance preference from site_config via
        # _config_value('preferred_irradiance_source').
        cfg['site_config']['preferred_irradiance_source'] = prefs['irradianceSource']
        records, fleet, sr_hist, weather = analyze_scada(plant, cfg, registered)
        conf_hist = None
        sr_fleet_daily = pd.concat(sr_hist.values(), axis=1).mean(axis=1)

    PROVENANCE_EXTRAS['preferences'] = prefs
    PROVENANCE_EXTRAS['weather'] = weather

    if registered is not None and len(records) != len(registered):
        sys.exit(f"GATE FAILED [{plant}]: analysis produced {len(records)} inverters "
                 f"but the registry has {len(registered)} — id mapping is broken.")

    gate_or_die(plant, records, sr_fleet_daily, plant_dir)
    write_all_inverters(plant, records, fleet, method)
    write_per_inverter_sr(plant, sr_hist, conf_hist, fleet, method, history_days)
    write_fleet_summary(plant, records, fleet, method)
    write_ml_plant_summary(plant, records, fleet, method)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--plant', required=True, choices=sorted(PLANTS))
    parser.add_argument('--history-days', type=int, default=120,
                        help='Trailing days of per-inverter history to serve (default 120)')
    args = parser.parse_args()
    generate(args.plant, args.history_days)


if __name__ == '__main__':
    main()
