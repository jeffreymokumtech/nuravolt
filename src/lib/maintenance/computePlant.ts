import fs from 'fs/promises';
import path from 'path';
import prisma from '@/libs/prisma';
import { resolvePlantId } from '@/lib/db/timeseries';
import { classify } from '@/lib/maintenance/classify';
import type { Classification, Signals, Tier } from '@/lib/maintenance/types';

/**
 * Shared plant-wide maintenance classification.
 *
 * The single engine behind BOTH the Maintenance Horizon plant page
 * (/api/plants/[plantId]/classifications) and the per-inverter tile
 * (/api/inverters/[inverterId]/classification). One bulk SQL pass, one
 * fixture read, then classify() in a JS loop — computed once per plant and
 * cached, so a page of 149 tiles costs a single computation and the two
 * surfaces can never disagree.
 */

export interface PlantClassificationsPayload {
  plantId: string;
  not_applicable?: boolean;
  asset_type?: string;
  plant_name?: string;
  summary: {
    total: number;
    by_cause: Record<string, number>;
    by_tier: Record<string, number>;
    by_action: Record<string, number>;
  } | null;
  classifications: Classification[];
}

const CACHE_TTL_MS = 60_000;
// Stored on globalThis so the cache survives Next.js dev hot-reloads —
// otherwise every recompile wipes it and the next page hit pays the full
// multi-second cold start again (the "page doesn't work sometimes" report).
const g = globalThis as any;
if (!g.__classificationsCache) g.__classificationsCache = new Map<string, { at: number; value: any }>();
const cache: Map<string, { at: number; value: PlantClassificationsPayload }> = g.__classificationsCache;

const toScadaId = (e: string) => e.replace('_', ' ').replace('_', '.');

/** Returns null when the plant doesn't exist. */
export async function getPlantClassifications(
  plantId: string,
): Promise<PlantClassificationsPayload | null> {
  const cached = cache.get(plantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  {
    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) return null;

    // Maintenance classification is inverter-based — for battery / wind
    // assets there is nothing to classify. Answer quickly and explicitly so
    // the UI can render a "not applicable" card instead of scanning for
    // inverters that don't exist (which previously hung for BESS plants).
    const plantMeta = await prisma.plant.findUnique({
      where: { id: plantUuid },
      select: { asset_type: true, name: true },
    });
    if (plantMeta && plantMeta.asset_type !== 'PV') {
      const payload: PlantClassificationsPayload = {
        plantId,
        not_applicable: true,
        asset_type: plantMeta.asset_type,
        plant_name: plantMeta.name,
        summary: null,
        classifications: [],
      };
      cache.set(plantId, { at: Date.now(), value: payload });
      return payload;
    }

    // ── Anchor on the latest available bucket ─────────────────────────────
    const latestRow = await prisma.$queryRawUnsafe<any[]>(
      `SELECT MAX(bucket) AS latest FROM analysis_daily
         WHERE plant_id = $1::uuid AND domain = 'digitaltwin'
           AND device_id LIKE 'INV%'
           AND metric IN ('power_ac_predicted', 'power_ac_actual')`,
      plantUuid,
    );
    const latest = latestRow?.[0]?.latest ? new Date(latestRow[0].latest) : new Date();
    const fromDate = new Date(latest.getTime() - 30 * 24 * 60 * 60 * 1000);

    // ── All inverter ↔ group affiliations in one shot ─────────────────────
    const groupRows = await prisma.$queryRawUnsafe<
      { external_id: string; group_slug: string }[]
    >(
      `SELECT i.external_id, g.slug AS group_slug
       FROM "Inverter" i
       JOIN "InverterGroup" g ON g.id = i.group_id
       WHERE g.plant_id = $1`,
      plantUuid,
    );
    const groupByScadaId = new Map<string, string>();
    const peersByGroup = new Map<string, Set<string>>();
    for (const r of groupRows) {
      const scadaId = toScadaId(r.external_id);
      groupByScadaId.set(scadaId, r.group_slug);
      if (!peersByGroup.has(r.group_slug)) peersByGroup.set(r.group_slug, new Set());
      peersByGroup.get(r.group_slug)!.add(scadaId);
    }

    // ── All daily series for every inverter, single query ────────────────
    const dailyRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT bucket::date AS day, device_id, metric, avg_value
         FROM analysis_daily
        WHERE plant_id = $1::uuid AND domain = 'digitaltwin'
          AND device_id LIKE 'INV%'
          AND metric IN ('power_ac_predicted', 'power_ac_actual',
                         'temperature_predicted', 'temperature_actual',
                         'voltage_dc_residual', 'voltage_dc_actual')
          AND bucket >= $2 AND bucket <= $3`,
      plantUuid,
      fromDate,
      latest,
    );

    // Per-inverter daily map.
    interface DayRec {
      power_pred?: number;
      power_act?: number;
      temp_pred?: number;
      temp_act?: number;
      volt_res?: number;
      volt_act?: number;
    }
    const perInvDays = new Map<string, Map<string, DayRec>>();
    for (const r of dailyRows) {
      const day = new Date(r.day).toISOString().split('T')[0];
      const inv = r.device_id as string;
      if (!perInvDays.has(inv)) perInvDays.set(inv, new Map());
      const dm = perInvDays.get(inv)!;
      if (!dm.has(day)) dm.set(day, {});
      const slot = dm.get(day)!;
      const v = Number(r.avg_value);
      switch (r.metric) {
        case 'power_ac_predicted': slot.power_pred = v; break;
        case 'power_ac_actual': slot.power_act = v; break;
        case 'temperature_predicted': slot.temp_pred = v; break;
        case 'temperature_actual': slot.temp_act = v; break;
        case 'voltage_dc_residual': slot.volt_res = v; break;
        case 'voltage_dc_actual': slot.volt_act = v; break;
      }
    }

    // ── Per-day, per-group peer median + MAD for PDS ─────────────────────
    // Build a (group, day) → list of losses, then derive median/MAD per
    // (group, day). Single linear sweep.
    const lossByGroupDay = new Map<string, Map<string, number[]>>();
    for (const [inv, days] of perInvDays) {
      const group = groupByScadaId.get(inv);
      if (!group) continue;
      for (const [day, rec] of days) {
        if (rec.power_pred && rec.power_pred > 0 && rec.power_act != null) {
          const loss = ((rec.power_pred - rec.power_act) / rec.power_pred) * 100;
          if (!lossByGroupDay.has(group)) lossByGroupDay.set(group, new Map());
          const gm = lossByGroupDay.get(group)!;
          if (!gm.has(day)) gm.set(day, []);
          gm.get(day)!.push(loss);
        }
      }
    }
    const statsByGroupDay = new Map<string, Map<string, { med: number; sigma: number }>>();
    for (const [g, gm] of lossByGroupDay) {
      const out = new Map<string, { med: number; sigma: number }>();
      for (const [day, xs] of gm) {
        if (xs.length < 3) continue;
        const sorted = [...xs].sort((a, b) => a - b);
        const med = quantile(sorted, 0.5);
        const madRaw = quantile(
          sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b),
          0.5,
        );
        out.set(day, { med, sigma: Math.max(0.5, 1.4826 * madRaw) });
      }
      statsByGroupDay.set(g, out);
    }

    // ── Soiling forecast — plant-level ML forecast JSON, sliced to the 30
    // days following the analysis-window anchor (NOT the wall clock: the
    // demo dataset is anchored on its own timeline). The SoilingForecast
    // Prisma table is empty, so the JSON files the soiling page uses are
    // the single source of truth here too.
    const SHOWCASE_PLANTS = new Set(['helios', 'zephyr']);
    const soilingDir = SHOWCASE_PLANTS.has(plantId) ? 'showcase/soiling' : 'soiling';
    let plantSoilingForecast: Signals['soilingForecast'] = null;
    try {
      const fcPath = path.join(
        process.cwd(), 'public', 'data', soilingDir, plantId, 'ml_forecast_365d.json',
      );
      const fc = JSON.parse(await fs.readFile(fcPath, 'utf-8'));
      const anchorIso = latest.toISOString().split('T')[0];
      const window = (fc.forecasts ?? [])
        .filter((d: any) => d.date >= anchorIso)
        .slice(0, 30);
      if (window.length > 0) {
        let peakLoss = 0, peakDate: string | null = null, recoveryDate: string | null = null;
        let daysToCleaning: number | null = null, bandSum = 0;
        for (let i = 0; i < window.length; i++) {
          const d = window[i];
          const loss = Number(d.soiling_loss_pct ?? (1 - d.sr_predicted) * 100);
          if (loss > peakLoss) { peakLoss = loss; peakDate = d.date; }
          if (recoveryDate === null && i > 0 && loss <= 1) recoveryDate = d.date;
          if (daysToCleaning === null && d.is_cleaning_needed) daysToCleaning = i;
          bandSum += Math.max(0, Number(d.sr_upper_bound ?? 0) - Number(d.sr_lower_bound ?? 0));
        }
        // Narrower forecast band → higher confidence in the forecast itself.
        const meanBand = bandSum / window.length;
        const fcConfidence = Math.max(0.3, Math.min(0.9, 1 - meanBand * 5));
        plantSoilingForecast = {
          peakLossPct: Math.round(peakLoss * 100) / 100,
          peakDate,
          recoveryDate,
          confidence: Math.round(fcConfidence * 100) / 100,
          cleaningPriority: daysToCleaning,
        };
      }
    } catch {
      // No forecast file — leave null.
    }

    // ── Rain forecast (7 days from anchor, plant-level) ─────────────────
    let rainForecast7d = false;
    try {
      const rfPath = path.join(
        process.cwd(), 'public', 'data', soilingDir, plantId, 'rain_forecast.json',
      );
      const rf = JSON.parse(await fs.readFile(rfPath, 'utf-8'));
      const daily = rf.daily_data ?? [];
      const total7 = daily
        .slice(0, 7)
        .reduce((acc: number, d: any) => acc + Number(d.precipitation_mm ?? 0), 0);
      rainForecast7d = total7 >= 5;
    } catch {}

    // ── Fault detection RUL — single fixture read ────────────────────────
    const rulByInverter = new Map<string, Signals['rulDays']>();
    try {
      const faultsPath = path.join(
        process.cwd(),
        'public',
        'data',
        'faults',
        plantId,
        'fault_detection_enhanced.json',
      );
      const raw = await fs.readFile(faultsPath, 'utf-8');
      const j = JSON.parse(raw);
      for (const pf of j.predictive_faults || []) {
        const equipId = pf.equipment_id as string;
        const scadaId = equipId.replace(/^PV-/, 'INV ');
        const kind = mapFaultType(pf.fault_type);
        if (!kind) continue;
        if (!rulByInverter.has(scadaId)) rulByInverter.set(scadaId, {});
        rulByInverter.get(scadaId)![kind] = {
          days: pf.days_to_fault,
          confidence: pf.confidence,
          projectedEnergyLossKwh: pf.projected_energy_loss_kwh,
        };
      }
      for (const rp of j.rul_predictions || []) {
        const equipId = rp.inverter_id as string;
        const scadaId = equipId.replace(/^PV-/, 'INV ');
        const kind = mapFaultType(rp.fault_type);
        if (!kind) continue;
        const existing = rulByInverter.get(scadaId) || {};
        if (existing[kind]) continue;
        existing[kind] = { days: rp.days_to_fault, confidence: rp.confidence };
        rulByInverter.set(scadaId, existing);
      }
    } catch {
      // No fault file — leave rulByInverter empty.
    }

    // ── Rain step (plant-wide) ───────────────────────────────────────────
    let recentRainStep = false;
    try {
      const rainPath = path.join(
        process.cwd(),
        'public',
        'data',
        'soiling',
        plantId,
        'rain_history.json',
      );
      const raw = await fs.readFile(rainPath, 'utf-8');
      const rj = JSON.parse(raw);
      const arr: any[] = Array.isArray(rj) ? rj : rj.daily_data ?? rj.entries ?? rj.data ?? [];
      // "Recent" means within 14 days of the analysis anchor, not the last
      // 14 file entries — the history file can end before the anchor.
      const cutoff = new Date(latest.getTime() - 14 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
      recentRainStep = arr.some(
        (row: any) =>
          row?.date >= cutoff &&
          (row?.precipitation_mm ?? row?.rain_mm ?? 0) > 5,
      );
    } catch {}

    // ── Pass 1: per-inverter aggregates over the 30-day window ───────────
    interface InvAgg {
      group: string;
      lossPct: number;        // trailing 14d mean loss vs twin
      tempDeviation: number;  // trailing 14d mean temperature residual
      voltDevRawPct: number | null; // trailing 14d mean voltage residual, % of V_dc
      pdsSeries: { date: string; pds: number }[]; // full 30d
    }
    const aggs = new Map<string, InvAgg>();
    for (const [inverterId, days] of perInvDays) {
      const group = groupByScadaId.get(inverterId);
      if (!group) continue;
      const sortedDays = Array.from(days.keys()).sort();
      const tail14 = new Set(sortedDays.slice(-14));
      const dailyGroupStats = statsByGroupDay.get(group) ?? new Map();

      let lossSum = 0, lossN = 0, tempDevSum = 0, tempDevN = 0;
      let voltResSum = 0, voltActSum = 0, voltN = 0;
      const pdsSeries: { date: string; pds: number }[] = [];

      for (const day of sortedDays) {
        const rec = days.get(day)!;
        // PDS over the full 30-day window (CHRONIC needs ≥21/30).
        if (rec.power_pred && rec.power_pred > 0 && rec.power_act != null) {
          const loss = ((rec.power_pred - rec.power_act) / rec.power_pred) * 100;
          const stats = dailyGroupStats.get(day);
          if (stats) pdsSeries.push({ date: day, pds: (loss - stats.med) / stats.sigma });
          if (tail14.has(day)) { lossSum += loss; lossN += 1; }
        }
        // Trailing-14d means for the remaining signals.
        if (!tail14.has(day)) continue;
        if (rec.temp_act != null && rec.temp_pred != null) {
          tempDevSum += rec.temp_act - rec.temp_pred;
          tempDevN += 1;
        }
        if (rec.volt_res != null && rec.volt_act != null && rec.volt_act > 0) {
          voltResSum += rec.volt_res;
          voltActSum += rec.volt_act;
          voltN += 1;
        }
      }

      aggs.set(inverterId, {
        group,
        lossPct: lossN > 0 ? lossSum / lossN : 0,
        tempDeviation: tempDevN > 0 ? tempDevSum / tempDevN : 0,
        voltDevRawPct: voltN > 0 ? (100 * voltResSum) / voltActSum : null,
        pdsSeries,
      });
    }

    // ── Pass 2: group medians (loss + raw voltage deviation) ─────────────
    // Subtracting the group-median voltage deviation cancels the twin's
    // systematic voltage bias, leaving a true peer-relative signature.
    const lossByGroup = new Map<string, number[]>();
    const voltByGroup = new Map<string, number[]>();
    for (const a of aggs.values()) {
      if (!lossByGroup.has(a.group)) { lossByGroup.set(a.group, []); voltByGroup.set(a.group, []); }
      lossByGroup.get(a.group)!.push(a.lossPct);
      if (a.voltDevRawPct != null) voltByGroup.get(a.group)!.push(a.voltDevRawPct);
    }
    const groupMedianLoss = new Map<string, number>();
    const groupMedianVolt = new Map<string, number>();
    for (const [grp, xs] of lossByGroup) {
      groupMedianLoss.set(grp, quantile([...xs].sort((a, b) => a - b), 0.5));
    }
    for (const [grp, xs] of voltByGroup) {
      if (xs.length >= 3) {
        groupMedianVolt.set(grp, quantile([...xs].sort((a, b) => a - b), 0.5));
      }
    }

    // ── Pass 3: Signals + Classification per inverter ─────────────────────
    const results: Classification[] = [];
    for (const [inverterId, a] of aggs) {
      const { pdsSeries } = a;
      const last3 = pdsSeries.slice(-3);
      const last14 = pdsSeries.slice(-14);
      const latestPds = pdsSeries.at(-1)?.pds ?? 0;
      const pdsAbove1d14 = last14.filter((p) => p.pds > 1).length;
      const pdsAbove05d30 = pdsSeries.filter((p) => p.pds > 0.5).length;
      const pdsSlope14d = slope(last14.map((p, i) => ({ x: i, y: p.pds })));

      let pdsTier: Tier = 'NORMAL';
      if (last3.filter((p) => p.pds > 2).length >= 2 && last3.length >= 2) pdsTier = 'ACUTE';
      else if (pdsAbove1d14 >= 7) pdsTier = 'DEGRADED';
      else if (pdsAbove05d30 >= 21) pdsTier = 'CHRONIC';

      const groupVoltMed = groupMedianVolt.get(a.group);
      const voltageDevPct =
        a.voltDevRawPct != null && groupVoltMed != null
          ? a.voltDevRawPct - groupVoltMed
          : 0;

      const signals: Signals = {
        inverterId,
        plantId,
        group: a.group,
        pdsTier,
        latestPds,
        pdsSlope14d,
        pdsAbove1d14,
        pdsAbove05d30,
        lossPct: a.lossPct,
        groupMedianLossPct: groupMedianLoss.get(a.group) ?? 0,
        tempDeviation: a.tempDeviation,
        voltageDevPct,
        diurnalPatternPct: null,
        soilingForecast: plantSoilingForecast,
        rulDays: rulByInverter.get(inverterId) ?? {},
        rainForecast7d,
        recentRainStep,
      };
      results.push(classify(signals));
    }

    // Sort by recommended_action priority then by ETA ascending (nulls last).
    const ACTION_RANK: Record<string, number> = {
      REPLACEMENT: 0, INSPECTION: 1, CLEANING: 2, MONITOR: 3,
    };
    results.sort((a, b) => {
      if (ACTION_RANK[a.recommendedAction] !== ACTION_RANK[b.recommendedAction]) {
        return ACTION_RANK[a.recommendedAction] - ACTION_RANK[b.recommendedAction];
      }
      const ea = a.etaDays ?? Number.POSITIVE_INFINITY;
      const eb = b.etaDays ?? Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;
      return b.confidence - a.confidence;
    });

    const summary = {
      total: results.length,
      by_cause: countBy(results, (r) => r.likelyCause),
      by_tier: countBy(results, (r) => r.tier),
      by_action: countBy(results, (r) => r.recommendedAction),
    };

    const payload: PlantClassificationsPayload = { plantId, summary, classifications: results };
    cache.set(plantId, { at: Date.now(), value: payload });
    return payload;
  }
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function slope(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function mapFaultType(t: string): keyof Signals['rulDays'] | null {
  if (t === 'bypass_diode') return 'bypass_diode';
  if (t === 'inverter_thermal' || t === 'thermal') return 'inverter_thermal';
  if (t === 'string_degradation') return 'string_degradation';
  if (t === 'module_degradation') return 'module_degradation';
  return null;
}

function countBy<T>(arr: T[], fn: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) {
    const k = fn(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
