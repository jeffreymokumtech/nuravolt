/**
 * OMIE Iberian day-ahead price loader.
 *
 * The CSV is committed at `public/data/prices/omie_es_2025-2026.csv` and
 * provides ~12 months of real hourly market prices (€/MWh) for both ES and
 * PT zones. It's small enough (~280 KB) to load into module memory once.
 *
 * Used by the BESS Hybrid Cockpit, Sandbox, and Curtailment-Recovery
 * features to ground revenue and dispatch demos in real prices.
 */

import fs from 'fs';
import path from 'path';

export interface PricePoint {
  /** ISO 8601, Iberia local time (naive — treated as wall-clock). */
  time: string;
  /** €/MWh, Spanish MIBEL day-ahead. */
  eur_per_mwh: number;
}

export type Zone = 'ES' | 'PT';

let _cache: { ES: PricePoint[]; PT: PricePoint[] } | null = null;

function loadCsv(): { ES: PricePoint[]; PT: PricePoint[] } {
  if (_cache) return _cache;
  const csvPath = path.join(process.cwd(), 'public/data/prices/omie_es_2025-2026.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n');
  const es: PricePoint[] = [];
  const pt: PricePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [time, esStr, ptStr] = line.split(',');
    const esVal = Number(esStr);
    const ptVal = Number(ptStr);
    if (!time || Number.isNaN(esVal)) continue;
    es.push({ time, eur_per_mwh: esVal });
    pt.push({ time, eur_per_mwh: ptVal });
  }
  _cache = { ES: es, PT: pt };
  return _cache;
}

/**
 * Return the hourly price curve between `from` (inclusive) and `to`
 * (exclusive). Bounds are ISO strings interpreted as naive Iberia time,
 * matching the CSV cadence. Returns the available subset — never throws on
 * out-of-range bounds.
 */
export function getPriceCurve(from: string, to: string, zone: Zone = 'ES'): PricePoint[] {
  const series = loadCsv()[zone];
  if (!series.length) return [];
  const fromT = from.slice(0, 19);
  const toT = to.slice(0, 19);
  // Series is already sorted; binary-search would be nicer for very large
  // ranges but linear is fine for 8.8K rows.
  return series.filter((p) => p.time >= fromT && p.time < toT);
}

/** Return the most recent N full days available in the dataset. */
export function getLastDays(days: number, zone: Zone = 'ES'): PricePoint[] {
  const series = loadCsv()[zone];
  if (!series.length) return [];
  const lastTime = series[series.length - 1].time;
  const lastDate = new Date(lastTime + 'Z'); // tolerate as UTC for arithmetic
  const cutoff = new Date(lastDate.getTime() - days * 24 * 3600 * 1000);
  const cutoffIso = cutoff.toISOString().slice(0, 19);
  return series.filter((p) => p.time >= cutoffIso);
}

/** Total hours available — useful for assertion checks in dev. */
export function getCoverage(zone: Zone = 'ES'): { hours: number; firstTime: string; lastTime: string } {
  const series = loadCsv()[zone];
  if (!series.length) return { hours: 0, firstTime: '', lastTime: '' };
  return { hours: series.length, firstTime: series[0].time, lastTime: series[series.length - 1].time };
}
