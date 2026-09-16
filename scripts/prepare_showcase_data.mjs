#!/usr/bin/env node
/**
 * prepare_showcase_data.mjs
 *
 * One-shot (idempotent) data preparation for the public /showcase route.
 *
 * Copies canonical plant data from public/data/{soiling,digitaltwin,faults,bess,wind}/
 * into public/data/showcase/, renaming plant slugs and scrubbing any embedded
 * identifiers (ribera, alpha, Region A, Jutland, Denmark, Nordic Wind, …) so
 * the showcase can be published without leaking real plant identifiers.
 *
 * Sources used:
 *   - Ribera  → helios   (PV + co-located BESS)
 *   - Nordic Wind-1 → zephyr (wind)
 *
 * Binary files (.pkl, .parquet, .png, .jpg) are copied verbatim — they don't
 * contain text identifiers the UI reads.
 *
 * Text files (.json, .csv, .txt) are copied with string substitution applied.
 *
 * After copying, this script also writes:
 *   - public/data/showcase/plants.json      (2-plant metadata)
 *   - public/data/showcase/portfolio.json   (aggregated 2-plant overview)
 *
 * Safe to re-run — destination dirs are removed and rebuilt on each run.
 *
 * Usage:
 *   node scripts/prepare_showcase_data.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(DATA, 'showcase');

/**
 * The showcase keeps only 10 of Ribera's 120 inverters so the public demo
 * feels focused (and so data-heavy per-inverter files stay small). We pick a
 * spread across all 4 inverter groups. Deterministic — each run produces the
 * same set so URLs like /showcase/plant/helios/inverter/INV%2001.057 keep
 * working between runs.
 */
const HELIOS_KEEP_INVERTERS = [
  'INV 01.032',
  'INV 01.044',
  'INV 01.057',
  'INV 02.005',
  'INV 02.018',
  'INV 02.028',
  'INV 03.066',
  'INV 03.082',
  'INV 04.100',
  'INV 04.115',
];
const HELIOS_KEEP_SET = new Set(HELIOS_KEEP_INVERTERS);

// Source → destination mapping. Each entry copies a plant directory with
// substitutions applied.
const COPIES = [
  {
    src: path.join(DATA, 'soiling', 'ribera'),
    dest: path.join(OUT, 'soiling', 'helios'),
  },
  {
    src: path.join(DATA, 'digitaltwin', 'ribera'),
    dest: path.join(OUT, 'digitaltwin', 'helios'),
  },
  {
    src: path.join(DATA, 'faults', 'ribera'),
    dest: path.join(OUT, 'faults', 'helios'),
  },
  {
    src: path.join(DATA, 'bess', 'ribera'),
    dest: path.join(OUT, 'bess', 'helios'),
  },
  {
    src: path.join(DATA, 'wind', 'nordic-wind-1'),
    dest: path.join(OUT, 'wind', 'zephyr'),
  },
];

// String substitutions applied to text files + filenames.
// Order matters — longer strings first so they don't get partially rewritten.
const SUBSTITUTIONS = [
  // Full names first
  ['Nordic Wind Farm', 'Zephyr Wind Farm'],
  ['Nordic Wind', 'Zephyr Wind'],
  ['nordic-wind-1', 'zephyr'],
  ['nordic_wind_1', 'zephyr'],
  ['nordic_wind', 'zephyr'],
  ['NordicWind', 'ZephyrWind'],
  // Geography
  ['Southern Europe', 'Southern Europe'],
  ['Jutland, Denmark', 'Northern Europe'],
  ['Region A', 'Southern Europe'],
  ['Jutland', 'Northern Europe'],
  ['Denmark', 'Northern Europe'],
  // Plant slug variants (case-sensitive)
  ['Ribera', 'Helios'],
  ['RIBERA', 'HELIOS'],
  ['ribera', 'helios'],
  // Alpha may appear incidentally in cross-plant files
  ['Alpha', 'Alpha'],
  ['ALPHA', 'ALPHA'],
  ['alpha', 'alpha'],
];

// File extensions that get text substitution. Everything else is copied
// verbatim (binary).
const TEXT_EXTS = new Set(['.json', '.csv', '.txt', '.md', '.tsv']);

function substitute(input) {
  let out = input;
  for (const [from, to] of SUBSTITUTIONS) {
    out = out.split(from).join(to);
  }
  // Python's `json.dump` with allow_nan=True (the default) emits `NaN` /
  // `Infinity` literals which break JavaScript's JSON.parse. Normalise those
  // to `null` as we copy so the showcase API routes can serve the files.
  out = out.replace(/\bNaN\b/g, 'null');
  out = out.replace(/\bInfinity\b/g, 'null');
  out = out.replace(/\b-Infinity\b/g, 'null');
  return out;
}

async function rmDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyDir(src, dest) {
  let stat;
  try {
    stat = await fs.stat(src);
  } catch {
    console.warn(`  ⚠ source missing, skipping: ${src}`);
    return { files: 0, skipped: true };
  }
  if (!stat.isDirectory()) {
    console.warn(`  ⚠ source is not a directory, skipping: ${src}`);
    return { files: 0, skipped: true };
  }

  await mkdirp(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  let count = 0;

  for (const ent of entries) {
    const srcPath = path.join(src, ent.name);
    const outName = substitute(ent.name);
    const destPath = path.join(dest, outName);

    if (ent.isDirectory()) {
      const sub = await copyDir(srcPath, destPath);
      count += sub.files;
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        const content = await fs.readFile(srcPath, 'utf-8');
        await fs.writeFile(destPath, substitute(content), 'utf-8');
      } else {
        await fs.copyFile(srcPath, destPath);
      }
      count += 1;
    }
  }

  return { files: count, skipped: false };
}

async function writePlantsJson() {
  const plants = [
    {
      id: 'showcase-helios',
      slug: 'helios',
      name: 'Helios PV',
      asset_type: 'SOLAR',
      location_name: 'Southern Europe',
      latitude: 37.9,
      longitude: -1.1,
      altitude: 100,
      capacity_mw: 45.0,
      installed_mw: 45.0,
      timezone: 'Europe/Madrid',
      status: 'operational',
      has_weather_station: true,
      has_dustiq_sensor: true,
      inverter_count: HELIOS_KEEP_INVERTERS.length,
      inverter_group_count: 4,
      data_source_count: 3,
      country: 'ES',
      compliance_pack_version: '2024.1',
      created_at: '2023-01-15T00:00:00.000Z',
      updated_at: new Date().toISOString(),
    },
    {
      id: 'showcase-zephyr',
      slug: 'zephyr',
      name: 'Zephyr Wind',
      asset_type: 'WIND',
      location_name: 'Northern Europe',
      latitude: 56.0,
      longitude: 9.5,
      altitude: 30,
      capacity_mw: 20.0,
      installed_mw: 20.0,
      timezone: 'Europe/Copenhagen',
      status: 'operational',
      has_weather_station: true,
      has_dustiq_sensor: false,
      inverter_count: 0,
      inverter_group_count: 0,
      data_source_count: 2,
      country: 'PT',
      compliance_pack_version: '2024.1',
      created_at: '2023-03-01T00:00:00.000Z',
      updated_at: new Date().toISOString(),
    },
  ];

  const dest = path.join(OUT, 'plants.json');
  await fs.writeFile(dest, JSON.stringify({ data: plants }, null, 2), 'utf-8');
  return dest;
}

/**
 * Reads a JSON file, applies a mutator, writes it back pretty-printed.
 * No-ops (with a log) if the file doesn't exist.
 */
async function editJson(filePath, mutator) {
  try {
    await fs.access(filePath);
  } catch {
    return false;
  }
  const raw = await fs.readFile(filePath, 'utf-8');
  const json = JSON.parse(raw);
  const updated = mutator(json);
  await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  return true;
}

/**
 * Downsample helios from 120 inverters → HELIOS_KEEP_INVERTERS.
 *
 * Filters per-inverter arrays/dicts in all the JSON files the UI reads, and
 * deletes per-inverter binary artefacts (pkl, residuals CSV/parquet) for
 * inverters not in the keep-set. Also updates top-level counts.
 */
async function downsampleHelios() {
  const keep = HELIOS_KEEP_SET;
  const soilingDir = path.join(OUT, 'soiling', 'helios');
  const twinDir = path.join(OUT, 'digitaltwin', 'helios');

  // 1. all_inverters.json — filter the inverters array
  await editJson(path.join(soilingDir, 'all_inverters.json'), (j) => {
    j.inverters = (j.inverters || []).filter((inv) => keep.has(inv.inverterId));
    if (j.metadata) j.metadata.total_inverters = j.inverters.length;
    return j;
  });

  // 2. per_inverter/all_inverters.json (same shape)
  await editJson(path.join(soilingDir, 'per_inverter', 'all_inverters.json'), (j) => {
    j.inverters = (j.inverters || []).filter((inv) => keep.has(inv.inverterId));
    if (j.metadata) j.metadata.total_inverters = j.inverters.length;
    return j;
  });

  // 3. per_inverter/helios_per_inverter_sr.json — dict keyed by inverter id
  await editJson(path.join(soilingDir, 'per_inverter', 'helios_per_inverter_sr.json'), (j) => {
    if (j.inverters && typeof j.inverters === 'object') {
      const filtered = {};
      for (const k of Object.keys(j.inverters)) {
        if (keep.has(k)) filtered[k] = j.inverters[k];
      }
      j.inverters = filtered;
    }
    if (j.metadata) j.metadata.n_inverters = Object.keys(j.inverters || {}).length;
    return j;
  });

  // 4. fleet_summary.json — update counts, truncate top/worst performers
  await editJson(path.join(soilingDir, 'fleet_summary.json'), (j) => {
    if (j.plantInfo) {
      j.plantInfo.totalInverters = keep.size;
      j.plantInfo.plantName = 'Helios PV';
      j.plantInfo.capacity_MW = 45.0;
    }
    if (Array.isArray(j.topPerformers)) {
      j.topPerformers = j.topPerformers.filter((t) => keep.has(t.inverterId)).slice(0, 5);
    }
    if (Array.isArray(j.worstPerformers)) {
      j.worstPerformers = j.worstPerformers.filter((t) => keep.has(t.inverterId)).slice(0, 5);
    }
    if (j.healthDistribution) {
      // Rescale counts proportionally to the 10-inverter subset.
      const total = keep.size;
      const scale = total / 120;
      j.healthDistribution.normal = Math.max(0, Math.round((j.healthDistribution.normal ?? 0) * scale));
      j.healthDistribution.minorIssues = Math.max(0, Math.round((j.healthDistribution.minorIssues ?? 0) * scale));
      j.healthDistribution.majorIssues = Math.max(0, Math.round((j.healthDistribution.majorIssues ?? 0) * scale));
      j.healthDistribution.critical = Math.max(0, Math.round((j.healthDistribution.critical ?? 0) * scale));
      const sum =
        j.healthDistribution.normal +
        j.healthDistribution.minorIssues +
        j.healthDistribution.majorIssues +
        j.healthDistribution.critical;
      if (sum !== total) {
        j.healthDistribution.normal += total - sum; // absorb rounding residue
      }
    }
    return j;
  });

  // 5. ml_per_inverter_metrics.json — already small, just filter if present
  await editJson(path.join(soilingDir, 'ml_per_inverter_metrics.json'), (j) => {
    if (j.inverters && typeof j.inverters === 'object' && !Array.isArray(j.inverters)) {
      // Keyed by inverter id or short form ("INV01") — keep any entry whose
      // key matches a keep inverter's group prefix or full id.
      const filtered = {};
      for (const [k, v] of Object.entries(j.inverters)) {
        // Tolerate both full id and group-only keys.
        const matches = Array.from(keep).some(
          (full) => full === k || full.startsWith(k) || k.startsWith(full),
        );
        if (matches) filtered[k] = v;
      }
      if (Object.keys(filtered).length > 0) {
        j.inverters = filtered;
      }
    }
    return j;
  });

  // 6. digitaltwin/mppt_string_data.json — nested `inverters` dict
  await editJson(path.join(twinDir, 'mppt_string_data.json'), (j) => {
    if (j.inverters && typeof j.inverters === 'object') {
      const filtered = {};
      for (const k of Object.keys(j.inverters)) {
        if (keep.has(k)) filtered[k] = j.inverters[k];
      }
      j.inverters = filtered;
    }
    if (j.metadata) j.metadata.total_inverters = Object.keys(j.inverters || {}).length;
    return j;
  });

  // 7. digitaltwin/timeline_heatmap_data.json — inverters array + column-indexed data
  const filterTimeline = (j) => {
    for (const bucket of ['daily', 'weekly']) {
      const t = j[bucket];
      if (!t || !Array.isArray(t.inverters)) continue;
      const keepIdx = [];
      const newInverters = [];
      t.inverters.forEach((inv, i) => {
        if (keep.has(inv)) {
          keepIdx.push(i);
          newInverters.push(inv);
        }
      });
      t.inverters = newInverters;
      if (Array.isArray(t.data)) {
        // data[dateIdx][inverterIdx] — filter inner arrays
        t.data = t.data.map((row) =>
          Array.isArray(row) ? keepIdx.map((i) => row[i]) : row,
        );
      }
      if (t.metadata) {
        t.metadata.total_inverters = newInverters.length;
      }
    }
    return j;
  };
  await editJson(path.join(twinDir, 'timeline_heatmap_data.json'), filterTimeline);
  await editJson(path.join(twinDir, 'pr_timeline_heatmap.json'), filterTimeline);
  await editJson(path.join(twinDir, 'training_times_heatmap.json'), filterTimeline);

  // 8. digitaltwin/string_anomalies.json — array filtered by inverterId
  await editJson(path.join(twinDir, 'string_anomalies.json'), (j) => {
    if (Array.isArray(j.anomalies)) {
      j.anomalies = j.anomalies.filter((a) => keep.has(a.inverterId));
      j.totalAnomalies = j.anomalies.length;
    }
    return j;
  });

  // 9. digitaltwin/digital_twins_summary.json — per-inverter metrics dict
  await editJson(path.join(twinDir, 'digital_twins_summary.json'), (j) => {
    if (j.inverters && typeof j.inverters === 'object' && !Array.isArray(j.inverters)) {
      const filtered = {};
      for (const k of Object.keys(j.inverters)) {
        if (keep.has(k)) filtered[k] = j.inverters[k];
      }
      j.inverters = filtered;
    }
    if (j.statistics) {
      j.statistics.totalInverters = keep.size;
      j.statistics.successful = keep.size;
    }
    return j;
  });

  // 10. String anomalies — trim from ~120 to a focused 5 across kept inverters,
  // using the correct "INV xx.yyy" naming convention the drill-down URLs expect.
  const anomaliesPath = path.join(twinDir, 'string_anomalies.json');
  try {
    await fs.access(anomaliesPath);
    const anomalies = {
      plantId: 'helios',
      generatedAt: new Date().toISOString(),
      totalAnomalies: 5,
      anomalies: [
        {
          id: 'anom-1',
          inverterId: 'INV 01.032',
          mpptId: 'MPPT-1',
          stringId: 'STR-1.2',
          type: 'DEGRADATION',
          severity: 'warning',
          currentDrop_pct: 12.9,
          detectedAt: new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10),
          description:
            'Irradiance-normalised string current declining ~13%/month over 29 days',
        },
        {
          id: 'anom-2',
          inverterId: 'INV 02.018',
          mpptId: 'MPPT-2',
          stringId: 'STR-2.1',
          type: 'OPEN_CIRCUIT',
          severity: 'critical',
          currentDrop_pct: 68.4,
          detectedAt: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
          description: 'String current dropped to near zero — likely open circuit',
        },
        {
          id: 'anom-3',
          inverterId: 'INV 03.082',
          mpptId: 'MPPT-1',
          stringId: 'STR-1.3',
          type: 'MISMATCH',
          severity: 'warning',
          currentDrop_pct: 8.1,
          detectedAt: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
          description: 'Sustained ~8% current mismatch vs peer strings on same MPPT',
        },
        {
          id: 'anom-4',
          inverterId: 'INV 04.115',
          mpptId: 'MPPT-3',
          stringId: 'STR-3.4',
          type: 'SHADING',
          severity: 'info',
          currentDrop_pct: 4.3,
          detectedAt: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
          description:
            'Seasonal shading pattern detected — recurs between 08:00 and 10:00 local',
        },
        {
          id: 'anom-5',
          inverterId: 'INV 01.057',
          mpptId: 'MPPT-2',
          stringId: 'STR-2.2',
          type: 'DEGRADATION',
          severity: 'warning',
          currentDrop_pct: 6.7,
          detectedAt: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
          description: 'Gradual 7% decline over last 45 days, not explained by soiling',
        },
      ],
    };
    await fs.writeFile(anomaliesPath, JSON.stringify(anomalies, null, 2), 'utf-8');
  } catch {
    // File absent, skip
  }

  // 11. Helios faults — rewrite to a small, focused set referencing only the
  // 10 kept inverters, matching the ReactiveFault + PredictiveFault shapes in
  // src/types/faults.ts (the UI calls toLocaleString() on fields like
  // energy_loss_kwh / projected_energy_loss_kwh, so every required field must
  // be present or the fault menu crashes).
  const faultsPath = path.join(OUT, 'faults', 'helios', 'fault_detection_results.json');
  const nowIso = new Date().toISOString();
  const dayOffsetIso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const dateOnly = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  const reactive = [
    {
      id: 'hel-1',
      fault_type: 'inverter_efficiency_degradation',
      severity: 'critical',
      asset_type: 'pv',
      equipment_id: 'INV 03.082',
      equipment_name: 'INV 03.082',
      timestamp_start: dayOffsetIso(-4),
      timestamp_end: null,
      value: 0.62,
      threshold: 0.85,
      message:
        'Performance ratio 6.2% below fleet mean for 4 consecutive days — MPPT-1 current imbalance',
      duration_minutes: 5760,
      power_loss_kw: 85,
      energy_loss_kwh: 8160,
      detection_rule: 'PR below fleet mean by >5% for ≥72h',
    },
    {
      id: 'hel-2',
      fault_type: 'string_open_circuit',
      severity: 'high',
      asset_type: 'pv',
      equipment_id: 'INV 02.018',
      equipment_name: 'INV 02.018',
      timestamp_start: dayOffsetIso(-3),
      timestamp_end: null,
      value: 0.0,
      threshold: 1.0,
      message: 'MPPT-2 / STR-2.1 reading near zero current — inspect string fuse',
      duration_minutes: 4320,
      power_loss_kw: 18,
      energy_loss_kwh: 1296,
      detection_rule: 'String current < 5% of fleet median for ≥60 min',
    },
    {
      id: 'hel-3',
      fault_type: 'module_current_degradation',
      severity: 'medium',
      asset_type: 'pv',
      equipment_id: 'INV 01.044',
      equipment_name: 'INV 01.044',
      timestamp_start: dayOffsetIso(-18),
      timestamp_end: null,
      value: 0.901,
      threshold: 0.92,
      message:
        'Soiling ratio 9% below clean baseline for 18 days — schedule cleaning',
      duration_minutes: 25920,
      power_loss_kw: 35,
      energy_loss_kwh: 15120,
      detection_rule: 'SR below clean-baseline threshold for ≥14 days',
    },
  ];

  const predictive = [
    {
      id: 'hel-rul-1',
      fault_type: 'inverter_thermal',
      display_name: 'Inverter Thermal Degradation',
      urgency: 'planned',
      asset_type: 'pv',
      equipment_id: 'INV 04.100',
      equipment_name: 'INV 04.100',
      days_to_fault: 42,
      confidence: 0.78,
      current_value: 82.5,
      threshold: 85.0,
      unit: '°C',
      recommended_action:
        'Book preventive O&M slot within 6 weeks; order spare IGBT module.',
      estimated_date: dateOnly(42),
      projected_power_loss_kw: 60.0,
      projected_energy_loss_kwh: 3600.0,
    },
    {
      id: 'hel-rul-2',
      fault_type: 'string_degradation',
      display_name: 'String Current Degradation',
      urgency: 'monitoring',
      asset_type: 'pv',
      equipment_id: 'INV 01.032',
      equipment_name: 'INV 01.032',
      days_to_fault: 120,
      confidence: 0.65,
      current_value: 0.94,
      threshold: 0.90,
      unit: 'SR',
      recommended_action:
        'Re-inspect connector torque + IV curve test on STR-1.2 during next maintenance window.',
      estimated_date: dateOnly(120),
      projected_power_loss_kw: 12.0,
      projected_energy_loss_kwh: 1440.0,
    },
  ];

  const heliosFaults = {
    plant_id: 'helios',
    timestamp: new Date().toISOString(),
    summary: {
      current_loss_kwh: reactive.reduce((s, f) => s + (f.energy_loss_kwh || 0), 0),
      projected_loss_kwh: 4800,
      current_loss_value: Math.round(
        reactive.reduce((s, f) => s + (f.energy_loss_kwh || 0), 0) * 0.058,
      ),
      projected_loss_value: 278,
      currency: 'EUR',
      reactive_count: reactive.length,
      predictive_count: predictive.length,
      critical_count: reactive.filter((f) => f.severity === 'critical').length,
      urgent_count: reactive.filter(
        (f) => f.severity === 'critical' || f.severity === 'high',
      ).length,
    },
    reactive_faults: reactive,
    predictive_faults: predictive,
  };
  await fs.writeFile(faultsPath, JSON.stringify(heliosFaults, null, 2), 'utf-8');

  // Enhanced faults file (consumed by OverviewSection + FaultDetectionSection).
  // Shape must match EnhancedFaultData in src/types/faults.ts — specifically
  // `urgency_summary` is keyed by urgent|soon|planned|monitoring (NOT
  // severity), and `health_score` is a {value,status,...,trend} object.
  const enhancedPath = path.join(OUT, 'faults', 'helios', 'fault_detection_enhanced.json');
  const heliosEnhanced = {
    plant_id: 'helios',
    generated_at: new Date().toISOString(),
    summary: {
      current_loss_kwh: heliosFaults.summary.current_loss_kwh,
      projected_loss_kwh: heliosFaults.summary.projected_loss_kwh,
      current_loss_value: heliosFaults.summary.current_loss_value,
      projected_loss_value: heliosFaults.summary.projected_loss_value,
      currency: 'EUR',
      reactive_count: reactive.length,
      predictive_count: predictive.length,
      critical_count: 1,
      urgent_count: 1,
      soon_count: 1,
      planned_count: 2,
      monitoring_count: 1,
    },
    health_score: {
      value: 87,
      status: 'attention_needed',
      anomaly_penalty: 4,
      fault_penalty: 6,
      rul_penalty: 3,
      trend: 'stable',
    },
    urgency_summary: {
      urgent:     { count: 1, total_revenue_at_risk_eur: 2160 },
      soon:       { count: 1, total_revenue_at_risk_eur: 1440 },
      planned:    { count: 2, total_revenue_at_risk_eur: 1740 },
      monitoring: { count: 1, total_revenue_at_risk_eur: 950 },
    },
    rul_predictions: [
      {
        equipment_id: 'INV 04.100',
        component: 'inverter',
        rul_days: 42,
        confidence: 0.78,
        urgency: 'planned',
        revenue_at_risk_eur: 1200,
      },
      {
        equipment_id: 'INV 01.032',
        component: 'string_1.2',
        rul_days: 120,
        confidence: 0.65,
        urgency: 'monitoring',
        revenue_at_risk_eur: 380,
      },
      {
        equipment_id: 'INV 03.082',
        component: 'mppt_1',
        rul_days: 5,
        confidence: 0.72,
        urgency: 'soon',
        revenue_at_risk_eur: 1440,
      },
      {
        equipment_id: 'INV 02.018',
        component: 'string_2.1',
        rul_days: 2,
        confidence: 0.81,
        urgency: 'urgent',
        revenue_at_risk_eur: 2160,
      },
    ],
  };
  await fs.writeFile(enhancedPath, JSON.stringify(heliosEnhanced, null, 2), 'utf-8');

  // 12. Delete per-inverter binary files that aren't in the keep-set.
  const entries = await fs.readdir(twinDir, { withFileTypes: true });
  let deleted = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    // Parse patterns like:
    //   "INV 01.032_current_twin.pkl" → "INV 01.032"
    //   "residuals_INV_01_032.parquet" → "INV 01.032"
    let inferredId = null;
    const twinMatch = name.match(/^(INV \d+\.\d+)_(current|voltage|temp|factory)/);
    if (twinMatch) inferredId = twinMatch[1];
    const resMatch = name.match(/^residuals_INV_(\d+)_(\d+)\.(csv|parquet)$/);
    if (resMatch) inferredId = `INV ${resMatch[1]}.${resMatch[2]}`;
    if (inferredId && !keep.has(inferredId)) {
      await fs.unlink(path.join(twinDir, name));
      deleted += 1;
    }
  }
  return { kept: keep.size, deleted };
}

async function writeMonthlySoilingRates() {
  // Synthesise a monthly rate curve for Helios — consumed by
  // InteractiveCleaningSchedule.tsx at ${dataRoot}/soiling/{plantId}/monthly_soiling_rates.json.
  const months = [
    ['2026-01', 'January', 0.18, 0.244, 0.72, 'Wet season — reduced soiling'],
    ['2026-02', 'February', 0.19, 0.252, 0.76, 'Wet season — reduced soiling'],
    ['2026-03', 'March', 0.22, 0.276, 0.88, 'Transition — moderate soiling'],
    ['2026-04', 'April', 0.25, 0.3, 1.0, 'Transition — moderate soiling'],
    ['2026-05', 'May', 0.28, 0.324, 1.12, 'Dry season beginning'],
    ['2026-06', 'June', 0.32, 0.356, 1.28, 'Dry season peak — high soiling'],
    ['2026-07', 'July', 0.34, 0.372, 1.36, 'Dry season peak — high soiling'],
    ['2026-08', 'August', 0.33, 0.364, 1.32, 'Dry season peak — high soiling'],
    ['2026-09', 'September', 0.28, 0.324, 1.12, 'Dry season wane'],
    ['2026-10', 'October', 0.24, 0.292, 0.96, 'Transition — moderate soiling'],
    ['2026-11', 'November', 0.2, 0.26, 0.8, 'Wet season beginning'],
    ['2026-12', 'December', 0.17, 0.236, 0.68, 'Wet season — reduced soiling'],
  ];

  const payload = {
    metadata: {
      plant_id: 'helios',
      generated_at: new Date().toISOString(),
      data_source: 'CAMS climatology + site calibration',
      base_soiling_rate_per_day: 0.003,
      calibration_method: 'linear_regression_aod_correlation',
    },
    calibration: {
      intercept: 0.001,
      slope: 0.008,
      r_squared: 0.72,
      data_points: 24,
      calibration_date: new Date().toISOString(),
    },
    monthly_rates: months.map(([month, month_name, aod, rate_pct, seasonal, notes]) => ({
      month,
      month_name,
      aod_avg: aod,
      aod_dust_avg: +(aod * 0.5).toFixed(3),
      soiling_rate_per_day: +(rate_pct / 100).toFixed(5),
      soiling_rate_pct_per_day: rate_pct,
      seasonal_factor: seasonal,
      confidence: 0.8,
      notes,
    })),
  };

  const dest = path.join(OUT, 'soiling', 'helios', 'monthly_soiling_rates.json');
  await fs.writeFile(dest, JSON.stringify(payload, null, 2), 'utf-8');
  return dest;
}

async function writeZephyrFaults() {
  // Synthetic wind-specific faults for Zephyr. Shape matches the
  // fault_detection_results.json / fault_detection_enhanced.json that
  // OverviewSection + FaultDetectionSection consume.
  const faultDir = path.join(OUT, 'faults', 'zephyr');
  await mkdirp(faultDir);

  const baseAt = Date.now();
  const ago = (days) => new Date(baseAt - days * 86_400_000).toISOString();

  // Note: the type enums in src/types/faults.ts are PV-centric. Wind-specific
  // fault types aren't in the enum, so we piggyback on the closest PV analog
  // ("inverter_overtemperature" for generator overtemp, etc.) and use
  // descriptive `message` text. Keeps TypeScript happy + avoids the fault
  // table's toLocaleString() crash on missing required fields.
  const dayIso = (days) => new Date(Date.now() - Math.abs(days) * 86_400_000).toISOString();
  const fwd = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  const reactive = [
    {
      id: 'wtg8-gearbox',
      fault_type: 'inverter_overtemperature',
      severity: 'critical',
      asset_type: 'wind',
      equipment_id: 'WTG-08',
      equipment_name: 'Turbine 08',
      timestamp_start: dayIso(12),
      timestamp_end: null,
      value: 82,
      threshold: 60,
      message: 'Gearbox oil temperature elevated 18% above baseline for 12 days — vibration signature consistent with bearing wear',
      duration_minutes: 17280,
      power_loss_kw: 220,
      energy_loss_kwh: 33000,
      detection_rule: 'Oil temp >= baseline + 15% for ≥72h',
    },
    {
      id: 'wtg4-powercurve',
      fault_type: 'inverter_efficiency_degradation',
      severity: 'high',
      asset_type: 'wind',
      equipment_id: 'WTG-04',
      equipment_name: 'Turbine 04',
      timestamp_start: dayIso(8),
      timestamp_end: null,
      value: -3.7,
      threshold: -2.0,
      message: 'Measured power curve 3.7% below rated curve at 7–12 m/s band',
      duration_minutes: 11520,
      power_loss_kw: 65,
      energy_loss_kwh: 9360,
      detection_rule: 'Mean power curve deviation <= -2% for ≥7 days',
    },
    {
      id: 'wtg6-pitch',
      fault_type: 'tracker_stuck',
      severity: 'high',
      asset_type: 'wind',
      equipment_id: 'WTG-06',
      equipment_name: 'Turbine 06',
      timestamp_start: dayIso(3),
      timestamp_end: dayIso(1),
      value: 1,
      threshold: 0,
      message: 'Pitch motor current spike exceeded alarm band 4 times in 48h — actuator degradation likely',
      duration_minutes: 2880,
      power_loss_kw: 40,
      energy_loss_kwh: 1920,
      detection_rule: 'Pitch motor current > 2σ above baseline ≥3 times/24h',
    },
    {
      id: 'wtg3-gen-temp',
      fault_type: 'inverter_overtemperature',
      severity: 'medium',
      asset_type: 'wind',
      equipment_id: 'WTG-03',
      equipment_name: 'Turbine 03',
      timestamp_start: dayIso(6),
      timestamp_end: dayIso(4),
      value: 134,
      threshold: 130,
      message: 'Generator winding temperature briefly exceeded warning threshold',
      duration_minutes: 2880,
      power_loss_kw: 12,
      energy_loss_kwh: 576,
      detection_rule: 'Winding temp > threshold for ≥30 min',
    },
  ];

  const predictive = [
    {
      id: 'rul-wtg8-gearbox',
      fault_type: 'inverter_thermal',
      display_name: 'Gearbox RUL — Turbine 08',
      urgency: 'planned',
      asset_type: 'wind',
      equipment_id: 'WTG-08',
      equipment_name: 'Turbine 08 gearbox',
      days_to_fault: 85,
      confidence: 0.82,
      current_value: 82,
      threshold: 60,
      unit: '°C',
      recommended_action:
        'Book replacement gearbox and crane window within 2.5 months',
      estimated_date: fwd(85),
      projected_power_loss_kw: 220,
      projected_energy_loss_kwh: 40700,
    },
    {
      id: 'rul-wtg6-pitch',
      fault_type: 'inverter_thermal',
      display_name: 'Pitch Actuator RUL — Turbine 06',
      urgency: 'planned',
      asset_type: 'wind',
      equipment_id: 'WTG-06',
      equipment_name: 'Turbine 06 pitch actuator',
      days_to_fault: 140,
      confidence: 0.71,
      current_value: 12.5,
      threshold: 10.0,
      unit: 'A',
      recommended_action:
        'Inspect brush + cable on next maintenance visit; likely ~5-month replacement window',
      estimated_date: fwd(140),
      projected_power_loss_kw: 40,
      projected_energy_loss_kwh: 8200,
    },
  ];

  const results = {
    plant_id: 'zephyr',
    timestamp: new Date().toISOString(),
    summary: {
      current_loss_kwh: reactive.reduce((s, f) => s + (f.energy_loss_kwh || 0), 0),
      projected_loss_kwh: 12_400,
      current_loss_value: Math.round(
        reactive.reduce((s, f) => s + (f.energy_loss_kwh || 0), 0) * 0.045,
      ),
      projected_loss_value: 558,
      currency: 'EUR',
      reactive_count: reactive.length,
      predictive_count: predictive.length,
      critical_count: reactive.filter((f) => f.severity === 'critical').length,
      urgent_count: reactive.filter((f) => f.severity === 'critical' || f.severity === 'high').length,
    },
    reactive_faults: reactive,
    predictive_faults: predictive,
  };

  await fs.writeFile(
    path.join(faultDir, 'fault_detection_results.json'),
    JSON.stringify(results, null, 2),
    'utf-8',
  );

  // Enhanced file consumed by OverviewSection + FaultDetectionSection.
  // Shape must match EnhancedFaultData — urgency_summary keyed by
  // urgent|soon|planned|monitoring, health_score is an object with
  // {value,status,anomaly_penalty,fault_penalty,rul_penalty,trend}.
  const enhanced = {
    plant_id: 'zephyr',
    generated_at: new Date().toISOString(),
    summary: {
      current_loss_kwh: reactive.reduce((s, f) => s + (f.energy_loss_kwh || 0), 0),
      projected_loss_kwh: 12_400,
      current_loss_value: 558,
      projected_loss_value: 558,
      currency: 'EUR',
      reactive_count: reactive.length,
      predictive_count: predictive.length,
      critical_count: 1,
      urgent_count: 0,
      soon_count: 0,
      planned_count: 1,
      monitoring_count: 1,
    },
    health_score: {
      value: 78,
      status: 'attention_needed',
      anomaly_penalty: 7,
      fault_penalty: 10,
      rul_penalty: 5,
      trend: 'stable',
    },
    urgency_summary: {
      urgent:     { count: 0, total_revenue_at_risk_eur: 0 },
      soon:       { count: 0, total_revenue_at_risk_eur: 0 },
      planned:    { count: 1, total_revenue_at_risk_eur: 48_900 },
      monitoring: { count: 1, total_revenue_at_risk_eur: 14_800 },
    },
    rul_predictions: [
      { equipment_id: 'WTG-01', component: 'gearbox', rul_days: 1_140, confidence: 0.89, urgency: 'monitoring', revenue_at_risk_eur: 0 },
      { equipment_id: 'WTG-02', component: 'gearbox', rul_days: 1_260, confidence: 0.91, urgency: 'monitoring', revenue_at_risk_eur: 0 },
      { equipment_id: 'WTG-03', component: 'gearbox', rul_days: 870, confidence: 0.84, urgency: 'monitoring', revenue_at_risk_eur: 0 },
      { equipment_id: 'WTG-04', component: 'gearbox', rul_days: 540, confidence: 0.79, urgency: 'monitoring', revenue_at_risk_eur: 14_800 },
      { equipment_id: 'WTG-05', component: 'gearbox', rul_days: 1_350, confidence: 0.92, urgency: 'monitoring', revenue_at_risk_eur: 0 },
      { equipment_id: 'WTG-06', component: 'pitch_actuator', rul_days: 140, confidence: 0.71, urgency: 'planned', revenue_at_risk_eur: 8_200 },
      { equipment_id: 'WTG-07', component: 'gearbox', rul_days: 1_230, confidence: 0.88, urgency: 'monitoring', revenue_at_risk_eur: 0 },
      { equipment_id: 'WTG-08', component: 'gearbox', rul_days: 85, confidence: 0.82, urgency: 'planned', revenue_at_risk_eur: 40_700 },
      { equipment_id: 'WTG-09', component: 'gearbox', rul_days: 1_080, confidence: 0.87, urgency: 'monitoring', revenue_at_risk_eur: 0 },
      { equipment_id: 'WTG-10', component: 'gearbox', rul_days: 990, confidence: 0.86, urgency: 'monitoring', revenue_at_risk_eur: 0 },
    ],
  };

  await fs.writeFile(
    path.join(faultDir, 'fault_detection_enhanced.json'),
    JSON.stringify(enhanced, null, 2),
    'utf-8',
  );

  return faultDir;
}

async function writePortfolioFinancialJson() {
  // Richer shape consumed by PlantFinancialSection / EnhancedPortfolioData.
  // This is what /demo/portfolio and the plant-detail financial card expect.
  const monthly = (budgetStart, budgetFactor = 1.0) => {
    const months = [
      ['Jan', 2851],
      ['Feb', 3694],
      ['Mar', 5119],
      ['Apr', 6091],
      ['May', 7063],
      ['Jun', 7970],
      ['Jul', 8294],
      ['Aug', 7646],
      ['Sep', 6286],
      ['Oct', 4800],
      ['Nov', 3500],
      ['Dec', 2900],
    ];
    return months.map(([month, budget]) => {
      const budget_MWh = Math.round(budget * budgetFactor);
      const dev = -5 - Math.floor(Math.random() * 6);
      return {
        month,
        budget_MWh,
        actual_MWh: Math.round(budget_MWh * (1 + dev / 100)),
        deviation_pct: dev,
      };
    });
  };

  const helios = {
    plantId: 'helios',
    plantName: 'Helios PV',
    assetType: 'SOLAR',
    location: 'Southern Europe',
    capacity_MW: 45.0,
    totalInverters: HELIOS_KEEP_INVERTERS.length,
    inverterGroups: ['INV 01', 'INV 02', 'INV 03', 'INV 04'],
    status: 'operational',
    healthDistribution: {
      normal: 104,
      minorIssues: 11,
      majorIssues: 4,
      critical: 1,
    },
    metrics: {
      avgR2: 0.932,
      avgMAE_kW: 3.1,
      soilingRatio: 0.962,
      healthScore: 87,
    },
    dataRange: {
      start: '2024-01-01',
      end: new Date().toISOString().slice(0, 10),
    },
    lastUpdated: new Date().toISOString(),
    financials: {
      ppa_price_per_MWh: 58,
      budget_generation_MWh: 66400,
      actual_generation_MWh: 66400 * 0.987,
      budget_deviation_pct: -1.2,
      annual_opex_eur: 810000,
      soiling_loss_eur: 68200,
      fault_loss_eur: 74300,
      degradation_loss_eur: 18500,
      curtailment_loss_eur: 0,
      total_loss_eur: 161000,
      availability_pct: 99.2,
      performance_ratio: 0.839,
      revenue_at_risk_eur: 142500,
      annual_revenue_eur: 3850000,
      ytd_revenue_eur: 1480000,
    },
    riskScore: {
      overall: 34,
      components: {
        health: 22,
        soiling: 35,
        fault_frequency: 52,
        budget_deviation: 10,
        availability: 8,
      },
      trend: 'stable',
      level: 'medium',
    },
    monthlyGeneration: monthly(2851, 45 / 9),
  };

  const zephyr = {
    plantId: 'zephyr',
    plantName: 'Zephyr Wind',
    assetType: 'WIND',
    location: 'Northern Europe',
    capacity_MW: 20.0,
    totalInverters: 0,
    turbineCount: 10,
    turbineModel: 'Generic 2.0 MW onshore',
    status: 'operational',
    healthDistribution: {
      normal: 8,
      minorIssues: 1,
      majorIssues: 1,
      critical: 0,
    },
    metrics: {
      soilingRatio: null,
      healthScore: 92,
      availability: 97.8,
      capacityFactor: 0.36,
    },
    dataRange: {
      start: '2024-01-01',
      end: new Date().toISOString().slice(0, 10),
    },
    lastUpdated: new Date().toISOString(),
    financials: {
      ppa_price_per_MWh: 45,
      budget_generation_MWh: 63100,
      actual_generation_MWh: 61700,
      budget_deviation_pct: 0.8,
      annual_opex_eur: 420000,
      soiling_loss_eur: 0,
      fault_loss_eur: 48900,
      degradation_loss_eur: 6200,
      curtailment_loss_eur: 12400,
      total_loss_eur: 67500,
      availability_pct: 97.8,
      performance_ratio: 0.912,
      revenue_at_risk_eur: 48900,
      annual_revenue_eur: 2100000,
      ytd_revenue_eur: 810000,
    },
    riskScore: {
      overall: 22,
      components: {
        health: 12,
        soiling: 0,
        fault_frequency: 38,
        budget_deviation: 5,
        availability: 22,
      },
      trend: 'stable',
      level: 'low',
    },
    monthlyGeneration: monthly(2851, 20 / 9),
  };

  const plants = [helios, zephyr];

  const summary = {
    totalPlants: plants.length,
    operationalPlants: plants.filter((p) => p.status === 'operational').length,
    totalCapacity_MW: plants.reduce((s, p) => s + p.capacity_MW, 0),
    byAssetType: plants.reduce((acc, p) => {
      acc[p.assetType] = (acc[p.assetType] ?? 0) + 1;
      return acc;
    }, {}),
    totalInverters: plants.reduce((s, p) => s + (p.totalInverters ?? 0), 0),
    totalTurbines: plants.reduce((s, p) => s + (p.turbineCount ?? 0), 0),
    criticalIssues: plants.reduce((s, p) => s + p.healthDistribution.critical, 0),
    majorIssues: plants.reduce((s, p) => s + p.healthDistribution.majorIssues, 0),
    topPerformers: ['Zephyr Wind'],
    needsAttention: ['Helios PV'],
    financials: {
      total_capacity_MW: plants.reduce((s, p) => s + p.capacity_MW, 0),
      total_budget_generation_MWh: plants.reduce(
        (s, p) => s + p.financials.budget_generation_MWh,
        0,
      ),
      total_actual_generation_MWh: plants.reduce(
        (s, p) => s + p.financials.actual_generation_MWh,
        0,
      ),
      overall_budget_deviation_pct: -0.5,
      total_annual_revenue_eur: plants.reduce(
        (s, p) => s + p.financials.annual_revenue_eur,
        0,
      ),
      total_ytd_revenue_eur: plants.reduce(
        (s, p) => s + p.financials.ytd_revenue_eur,
        0,
      ),
      total_revenue_at_risk_eur: plants.reduce(
        (s, p) => s + p.financials.revenue_at_risk_eur,
        0,
      ),
      total_soiling_loss_eur: plants.reduce(
        (s, p) => s + p.financials.soiling_loss_eur,
        0,
      ),
      total_fault_loss_eur: plants.reduce(
        (s, p) => s + p.financials.fault_loss_eur,
        0,
      ),
      total_degradation_loss_eur: plants.reduce(
        (s, p) => s + p.financials.degradation_loss_eur,
        0,
      ),
      total_curtailment_loss_eur: plants.reduce(
        (s, p) => s + p.financials.curtailment_loss_eur,
        0,
      ),
      total_opex_eur: plants.reduce((s, p) => s + p.financials.annual_opex_eur, 0),
      portfolio_risk_score: 28,
      portfolio_risk_level: 'medium',
    },
  };

  const dest = path.join(OUT, 'portfolio_financial.json');
  await fs.writeFile(
    dest,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), plants, summary },
      null,
      2,
    ),
    'utf-8',
  );
  return dest;
}

async function writePortfolioJson() {
  // Mirrors the shape of public/data/portfolio_financial.json so the portfolio
  // UI can consume it with minimal branching.
  const portfolio = {
    as_of: new Date().toISOString(),
    total_capacity_mw: 65.0,
    total_plants: 2,
    plants: [
      {
        plantId: 'helios',
        plantName: 'Helios PV',
        location: 'Southern Europe',
        asset_type: 'SOLAR',
        capacity_MW: 45.0,
        metrics: {
          healthScore: 87,
          availability_pct: 99.2,
          performance_ratio: 0.839,
        },
        financials: {
          annual_revenue_eur: 3_850_000,
          revenue_at_risk_eur: 142_500,
          budget_deviation_pct: -1.2,
          soiling_loss_eur: 68_200,
          fault_loss_eur: 74_300,
          availability_pct: 99.2,
          performance_ratio: 0.839,
        },
        riskScore: {
          overall: 34,
          level: 'medium',
        },
      },
      {
        plantId: 'zephyr',
        plantName: 'Zephyr Wind',
        location: 'Northern Europe',
        asset_type: 'WIND',
        capacity_MW: 20.0,
        metrics: {
          healthScore: 92,
          availability_pct: 97.8,
          performance_ratio: 0.912,
        },
        financials: {
          annual_revenue_eur: 2_100_000,
          revenue_at_risk_eur: 48_900,
          budget_deviation_pct: 0.8,
          soiling_loss_eur: 0,
          fault_loss_eur: 48_900,
          availability_pct: 97.8,
          performance_ratio: 0.912,
        },
        riskScore: {
          overall: 22,
          level: 'low',
        },
      },
    ],
  };

  const dest = path.join(OUT, 'portfolio.json');
  await fs.writeFile(dest, JSON.stringify(portfolio, null, 2), 'utf-8');
  return dest;
}

async function main() {
  console.log('Preparing /showcase data …');
  console.log(`  Destination: ${OUT}`);

  // Wipe the top-level showcase dir (except dashboards/ which is hand-curated).
  // We wipe the content directories only; dashboards/ files are committed
  // separately and not regenerated by this script.
  for (const subdir of ['soiling', 'digitaltwin', 'faults', 'bess', 'wind']) {
    await rmDir(path.join(OUT, subdir));
  }

  let total = 0;
  for (const { src, dest } of COPIES) {
    const rel = path.relative(ROOT, src);
    console.log(`  • ${rel}`);
    const r = await copyDir(src, dest);
    if (!r.skipped) {
      console.log(`    ↳ ${r.files} files copied → ${path.relative(ROOT, dest)}`);
      total += r.files;
    }
  }

  // Downsample Helios to a focused 10-inverter slice
  console.log('\n  Downsampling Helios to 10 inverters…');
  const ds = await downsampleHelios();
  console.log(`    ↳ kept ${ds.kept} inverters, deleted ${ds.deleted} per-inverter files`);

  const msr = await writeMonthlySoilingRates();
  console.log(`  • wrote ${path.relative(ROOT, msr)}`);

  const pp = await writePlantsJson();
  console.log(`  • wrote ${path.relative(ROOT, pp)}`);
  const po = await writePortfolioJson();
  console.log(`  • wrote ${path.relative(ROOT, po)}`);
  const pf = await writePortfolioFinancialJson();
  console.log(`  • wrote ${path.relative(ROOT, pf)}`);
  const zf = await writeZephyrFaults();
  console.log(`  • wrote ${path.relative(ROOT, zf)}/*.json`);

  console.log(`\n✓ Done. ${total} files copied. Run a grep for 'ribera' to verify scrubbing.`);
}

main().catch((err) => {
  console.error('Showcase data prep failed:', err);
  process.exit(1);
});
