'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useBESSData } from '@/hooks/useBESSData';
import { GLOSSARY } from '@/components/ui/AbbrTooltip';
import OpsPanel from '@/components/ops/OpsPanel';
import OpsTabs from '@/components/ops/OpsTabs';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import OpsTable from '@/components/ops/OpsTable';
import OpsFooter from '@/components/ops/OpsFooter';
import OpsLineChart from '@/components/ops/charts/OpsLineChart';
import OpsTimeRange, { type TimeRange } from '@/components/ops/OpsTimeRange';
import OpsBarChart from '@/components/ops/charts/OpsBarChart';
import RainflowHistogram from '@/components/ops/charts/RainflowHistogram';
import { useChartRange } from '@/hooks/useChartRange';
import { bucketSeries } from '@/utils/timeBuckets';
import SoHProjectionChart from '@/components/ops/charts/SoHProjectionChart';
import WarrantyTracker from '@/components/ops/charts/WarrantyTracker';
import HealthRing from '@/components/ops/charts/HealthRing';
import StatusLed, { type StatusTone } from '@/components/ops/StatusLed';
import StateOfSafety from './bess/StateOfSafety';
import RackDrilldown from './bess/RackDrilldown';
import RiskHeroBanner, { bannerTone, type RiskIndicator } from './bess/RiskHeroBanner';
import BatteryResidualValue, { FLOOR_LABEL, type FloorSource } from './bess/BatteryResidualValue';
import EolDecommissioningPanel from './bess/EolDecommissioningPanel';
import FleetCohortComparison from './bess/FleetCohortComparison';
import type { CohortAsset } from '@/lib/bess/fleetCohortRanking';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

const INSTALLED_CAPEX_EUR_PER_KWH = 280;

interface OpsBatteryProps {
  plantId: string;
}

/**
 * The SoH a battery is generally considered to leave first-life service at.
 * It is an industry reference point, NOT this asset's contractual floor, and
 * is only ever fed to the two explicitly model-estimate panels (residual value
 * and decommissioning) when no warranty terms have been uploaded.
 */
const SECOND_LIFE_SOH = 0.7;

interface SoHPointRaw {
  date: string;
  soh: number;
  source: string;
  cumulative_cycles: number;
}

/** Warranty health, normalised from the API or a legacy fixture. All nullable. */
export interface WarrantyHealthView {
  score: number | null;
  risk_level: string | null;
  component_scores: {
    soh: number | null;
    cycles: number | null;
    time: number | null;
    efficiency: number | null;
    violations: number | null;
  };
  current_soh: number | null;
  warranty_threshold: number | null;
  soh_margin: number | null;
  cycles_used: number | null;
  cycles_remaining: number | null;
  years_remaining: number | null;
  recommendation: string | null;
}

/** Contractual warranty terms. Every clause is optional in the contract too. */
export interface WarrantyTermsView {
  capacity_guarantee_pct: number | null;
  warranty_years: number | null;
  max_cycles: number | null;
  max_throughput_mwh: number | null;
  min_rte: number | null;
  operating_temp_min_c: number | null;
  operating_temp_max_c: number | null;
  /**
   * Rated continuous C-rate. The only C-rate ceiling on this console that is a
   * limit: `cyclingMetrics.limits.maxCRate` is the highest rate the asset has
   * been observed at, which is a measurement, not a rating.
   */
  max_c_rate_continuous: number | null;
}

/**
 * Warranty risk vocabulary. The canonical levels are the four in
 * WarrantyRiskLevel (src/types/bess.ts) and in the Prisma enum: LOW, MODERATE,
 * HIGH, CRITICAL. MEDIUM is only ever seen in legacy fixture files and is kept
 * as an alias so an old demo JSON still colours correctly.
 */
const TIER_TONE: Record<string, StatusTone> = {
  LOW: 'ok',
  MODERATE: 'warn',
  MEDIUM: 'warn',
  HIGH: 'alarm',
  CRITICAL: 'alarm',
};

/**
 * Tone for a risk level. An unrecognised level reads muted, never `ok`: a level
 * this console does not understand is not evidence that the asset is healthy.
 */
export function tierTone(level: unknown): StatusTone {
  return TIER_TONE[String(level ?? '').toUpperCase()] ?? 'muted';
}

/** Chip colours. `muted` carries no -bg/-border token, so it borrows the panel chrome. */
function riskChipStyle(tone: StatusTone) {
  if (tone === 'muted') {
    return {
      color: 'var(--ops-muted)',
      background: 'var(--ops-panel-2)',
      borderColor: 'var(--ops-hair)',
    };
  }
  return {
    color: `var(--ops-${tone})`,
    background: `var(--ops-${tone}-bg)`,
    borderColor: `var(--ops-${tone}-border)`,
  };
}

/**
 * What a cell shows when the number it wants was never published. Every panel
 * on this page uses the same marker, so "no data" is never mistaken for a zero.
 */
export const NO_VALUE = 'n/a';

/** A finite number, or null. Null, undefined, NaN and Infinity are all absent. */
export function fin(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fixed-decimal render of a possibly absent number. */
export function fmt(v: unknown, digits = 0, suffix = ''): string {
  const n = fin(v);
  return n == null ? NO_VALUE : `${n.toFixed(digits)}${suffix}`;
}

/**
 * Warranty health, normalised from the live route shape (camelCase, under
 * `healthScore`) or a legacy fixture (snake_case, under `warranty_health`).
 *
 * Every field comes back nullable. A battery onboarded an hour ago has a
 * warranty row with almost nothing in it, and a zero rendered where a
 * measurement is missing reads as a catastrophic score rather than as "not
 * measured yet".
 */
export function normalizeWarrantyHealth(raw: any): WarrantyHealthView | null {
  if (!raw) return null;

  if (raw.healthScore) {
    const hs = raw.healthScore;
    const m = raw.status ?? hs.metrics;
    return {
      score: fin(hs.score),
      risk_level: hs.riskLevel ?? raw.status?.riskLevel ?? null,
      component_scores: {
        soh: fin(hs.components?.sohScore),
        cycles: fin(hs.components?.cycleScore),
        time: fin(hs.components?.timeScore),
        efficiency: fin(hs.components?.efficiencyScore),
        violations: fin(hs.components?.violationsScore),
      },
      current_soh: fin(hs.metrics?.currentSoh ?? m?.currentSoh),
      warranty_threshold: fin(hs.metrics?.warrantyThreshold ?? m?.warrantyThreshold),
      soh_margin: fin(m?.sohMargin),
      cycles_used: fin(hs.metrics?.cyclesUsed ?? m?.equivalentFullCycles),
      cycles_remaining: fin(hs.metrics?.cyclesRemaining),
      years_remaining: fin(hs.metrics?.yearsRemaining ?? m?.yearsRemaining),
      recommendation: trimmedOrNull(hs.recommendation),
    };
  }

  const legacy = raw.warranty_health;
  if (!legacy) return null;
  const c = legacy.component_scores ?? {};
  return {
    score: fin(legacy.score),
    risk_level: legacy.risk_level ?? null,
    component_scores: {
      soh: fin(c.soh),
      cycles: fin(c.cycles),
      time: fin(c.time),
      efficiency: fin(c.efficiency),
      violations: fin(c.violations),
    },
    current_soh: fin(legacy.current_soh),
    warranty_threshold: fin(legacy.warranty_threshold),
    soh_margin: fin(legacy.soh_margin),
    cycles_used: fin(legacy.cycles_used),
    cycles_remaining: fin(legacy.cycles_remaining),
    years_remaining: fin(legacy.years_remaining),
    recommendation: trimmedOrNull(legacy.recommendation),
  };
}

function trimmedOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Contractual warranty terms, or null when no BessWarrantyTerms row exists.
 *
 * Null is the normal state for a freshly onboarded battery: the terms come off
 * the supply contract, which nobody has uploaded yet. This is the function that
 * used to hand back a fully populated object of industry-typical defaults
 * (0.7 capacity floor, 10 years, 6000 cycles, 0.85 RTE, 15 to 45 C) whenever a
 * clause was missing, which put invented contract numbers on screen under the
 * heading "contractual". It returns null now, and the panels that need terms
 * render an empty state naming what to upload.
 */
export function normalizeWarrantyTerms(raw: any): WarrantyTermsView | null {
  if (!raw) return null;
  const t = raw.terms ?? raw.warranty_terms;
  if (!t) return null;
  return {
    capacity_guarantee_pct: fin(t.capacityGuaranteePct ?? t.capacity_guarantee_pct),
    warranty_years: fin(t.warrantyYears ?? t.warranty_years),
    max_cycles: fin(t.maxCycles ?? t.max_cycles),
    max_throughput_mwh: fin(t.maxThroughputMwh ?? t.max_throughput_mwh),
    min_rte: fin(t.minRte ?? t.min_rte),
    operating_temp_min_c: fin(t.operatingTempMinC ?? t.operating_temp_min_c),
    operating_temp_max_c: fin(t.operatingTempMaxC ?? t.operating_temp_max_c),
    max_c_rate_continuous: fin(t.maxCRateContinuous ?? t.max_c_rate_continuous),
  };
}

/**
 * Where the capacity guarantee on screen came from.
 *
 * Reads the per-field provenance the warranty route publishes, so a terms row
 * that mixes declared and defaulted clauses is judged on the one clause that
 * matters here. A payload with no provenance block returns 'unknown': silence
 * is not a contract.
 */
export function floorProvenance(termsProvenance: any): FloorSource {
  if (!termsProvenance) return 'unknown';
  const field = 'capacity_guarantee_pct';
  if (Array.isArray(termsProvenance.defaultedFields) && termsProvenance.defaultedFields.includes(field)) {
    return 'default';
  }
  if (Array.isArray(termsProvenance.declaredFields) && termsProvenance.declaredFields.includes(field)) {
    return 'declared';
  }
  if (termsProvenance.isContractDerived === true) return 'contract';
  if (termsProvenance.source === 'operator_declared') return 'declared';
  if (termsProvenance.isContractDerived === false) return 'default';
  return 'unknown';
}

export interface WarrantyBudgetRow {
  label: string;
  value: string;
  fraction: number;
  tone: 'ok' | 'warn';
}

/**
 * One row per warranty axis that has BOTH a contractual limit and a
 * measurement.
 *
 * An axis missing either input is dropped, never drawn at zero: an empty
 * progress bar reads as "nothing consumed", which is the opposite of "we have
 * no clause for this". With no terms at all the list is empty and the caller
 * renders the enablement state.
 */
export function warrantyBudgetRows(
  wh: WarrantyHealthView | null,
  wt: WarrantyTermsView | null,
): WarrantyBudgetRow[] {
  const tone = (score: number | null): 'ok' | 'warn' =>
    score != null && score >= 80 ? 'ok' : 'warn';
  const floor = wt?.capacity_guarantee_pct ?? null;
  const rows: WarrantyBudgetRow[] = [];

  if (wh?.current_soh != null && floor != null && floor < 1) {
    rows.push({
      label: 'Capacity guarantee',
      value: `${(wh.current_soh * 100).toFixed(1)}% / ${(floor * 100).toFixed(0)}%${
        wt?.warranty_years != null ? ` @${wt.warranty_years}yr` : ''
      }`,
      fraction: (1 - wh.current_soh) / (1 - floor),
      tone: tone(wh.component_scores.soh),
    });
  }
  if (wh?.cycles_used != null && wt?.max_cycles != null && wt.max_cycles > 0) {
    rows.push({
      label: 'Cycle budget',
      value: `${wh.cycles_used.toFixed(0)} / ${wt.max_cycles.toLocaleString()}`,
      fraction: wh.cycles_used / wt.max_cycles,
      tone: tone(wh.component_scores.cycles),
    });
  }
  if (wh?.years_remaining != null && wt?.warranty_years != null && wt.warranty_years > 0) {
    rows.push({
      label: 'Calendar age',
      value: `${(wt.warranty_years - wh.years_remaining).toFixed(1)} / ${wt.warranty_years} yr`,
      fraction: (wt.warranty_years - wh.years_remaining) / wt.warranty_years,
      tone: tone(wh.component_scores.time),
    });
  }
  // Efficiency is scored by the route rather than capped by a clause, so it is
  // the one axis that stands without terms.
  if (wh?.component_scores.efficiency != null) {
    rows.push({
      label: 'Efficiency',
      value: `${wh.component_scores.efficiency}/100`,
      fraction: 1 - wh.component_scores.efficiency / 100,
      tone: tone(wh.component_scores.efficiency),
    });
  }
  return rows;
}

export default function OpsBattery({ plantId }: OpsBatteryProps) {
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();
  const bess = useBESSData(plantId);
  const [activeTab, setActiveTab] = useState<
    'overview' | 'warranty' | 'cycling' | 'dispatch' | 'drilldown'
  >('overview');
  const [sohRange, setSohRange] = useState<TimeRange>('1y');

  // SoH measurement series: the cycling API carries it (DB-sourced for real
  // plants); the raw fixture file is only a fallback for legacy demo data.
  const [sohHistory, setSohHistory] = useState<SoHPointRaw[] | null>(null);
  const apiSohHistory = (bess.cyclingMetrics as any)?.sohHistory as SoHPointRaw[] | undefined;
  useEffect(() => {
    if (!bess.selectedAsset) return;
    if (apiSohHistory?.length) {
      setSohHistory(apiSohHistory);
      return;
    }
    if (bess.isLoading) return; // wait for the API before falling back to fixtures
    // The raw fixture only exists for demo/showcase plants; a real /dashboard
    // BESS with no capacity tests just shows the empty state (no /data 404).
    if (prefix === '/dashboard') return;
    let alive = true;
    fetch(`${dataRoot}/bess/${plantId}/soh_history.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && Array.isArray(j) && setSohHistory(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bess.selectedAsset, bess.isLoading, apiSohHistory, plantId, dataRoot, prefix]);

  const asset = bess.selectedAsset;
  // The API returns warrantyStatus = { status, healthScore, terms }, all camelCase
  //, older fixtures used snake_case (warranty_health / warranty_terms). Map both.
  const rawWarranty = bess.warrantyStatus as any;
  const wh = useMemo(() => normalizeWarrantyHealth(rawWarranty), [rawWarranty]);
  const wt = useMemo(() => normalizeWarrantyTerms(rawWarranty), [rawWarranty]);
  // Served by the warranty route. Absent on older fixtures, which is why every
  // read here is an explicit `=== false` rather than a truthiness check: unknown
  // provenance must not silently claim the terms are contractual.
  const termsProvenance = rawWarranty?.termsProvenance ?? null;
  // cyclingMetrics from API is camelCase under `metrics`; from old fixture it's flat.
  const cycling = (bess.cyclingMetrics as any)?.metrics ?? null;
  const violations = (bess.violations as any)?.violations ?? [];
  const dispatch = bess.dispatchSchedule;

  const sohWindow = useMemo(() => {
    if (!sohHistory?.length) return null;
    const days =
      sohRange === '1y' ? 365 : sohRange === '90d' ? 90 : sohRange === '30d' ? 30 : sohRange === 'all' ? 99999 : 365;
    // Anchor to the last measurement, not wall-clock now: fixture histories
    // are pinned in time and a wall-clock cutoff empties the window.
    const anchor = new Date(sohHistory[sohHistory.length - 1].date).getTime();
    const cutoff = anchor - days * 86400000;
    return sohHistory.filter((p) => new Date(p.date).getTime() >= cutoff);
  }, [sohHistory, sohRange]);

  // Month-over-month capacity fade from the SoH measurements, normalized by
  // the actual gap between points so sparse capacity tests don't read as a
  // multi-month fade cliff.
  const fadeByMonth = useMemo(() => {
    if (!sohHistory || sohHistory.length < 3) return null;
    const pts = [...sohHistory].sort((a, b) => a.date.localeCompare(b.date));
    const bars: Array<{ label: string; value: number }> = [];
    for (let i = 1; i < pts.length; i++) {
      const gapDays =
        (new Date(pts[i].date).getTime() - new Date(pts[i - 1].date).getTime()) / 86400000;
      if (gapDays < 5) continue;
      const fadePp30 = (pts[i - 1].soh - pts[i].soh) * 100 * (30 / gapDays);
      const d = new Date(pts[i].date);
      bars.push({
        label: `${d.toLocaleString('en', { month: 'short' })} ${String(d.getFullYear()).slice(2)}`,
        value: fadePp30,
      });
    }
    if (!bars.length) return null;
    const windowed = bars.slice(-13);
    const avg = windowed.reduce((s, b) => s + b.value, 0) / windowed.length;
    const last = pts[pts.length - 1];
    // No contractual floor, no distance to it. The fade bars still stand on
    // their own; only the "floor in N years" caption drops out.
    const floor = wt?.capacity_guarantee_pct ?? null;
    const yearsToFloor =
      floor != null && avg > 0.005 ? ((last.soh - floor) * 100) / (avg * 12) : null;
    return {
      bars: windowed.map((b) => ({
        ...b,
        tone: (b.value > avg * 1.6 ? 'warn' : 'bess') as 'warn' | 'bess',
      })),
      avg,
      yearsToFloor,
    };
  }, [sohHistory, wt]);

  // Monthly cycling rollup + RTE window over the daily cycling records.
  const dailyCyclingAll = useMemo(
    () => (((bess.cyclingMetrics as any)?.metrics?.dailyRecords ?? []) as any[]),
    [bess.cyclingMetrics]
  );
  const cyclingMonthly = useMemo(() => {
    if (dailyCyclingAll.length < 28) return null;
    const buckets = bucketSeries(
      dailyCyclingAll,
      (r) => r.date,
      (r) => ({ cycles: r.equivalentCycles, mwh: (r.throughputKwh ?? 0) / 1000 }),
      { bucket: 'month', reduce: 'sum' }
    ).slice(-13);
    return {
      bars: buckets.map((b) => ({ label: b.label, value: b.values.cycles ?? null })),
      overlay: {
        label: 'Throughput',
        values: buckets.map((b) => b.values.mwh ?? null),
        tone: 'muted' as const,
        format: (v: number) => `${v.toFixed(0)} MWh`,
      },
    };
  }, [dailyCyclingAll]);

  const rteDataEnd = dailyCyclingAll.length
    ? dailyCyclingAll[dailyCyclingAll.length - 1].date
    : null;
  const rteCtl = useChartRange('90d', { dataEnd: rteDataEnd });
  const rteDaily = useMemo(
    () =>
      dailyCyclingAll.filter(
        (r) =>
          Number(r.roundTripEfficiency) > 0 && r.date >= rteCtl.from && r.date <= rteCtl.to
      ),
    [dailyCyclingAll, rteCtl.from, rteCtl.to]
  );
  const handleRteBrush = (a: number, b: number) => {
    if (!rteDaily[a] || !rteDaily[b]) return;
    const from = rteDaily[a].date;
    const to = rteDaily[b].date;
    if (from < to) rteCtl.setCustomRange({ from, to });
  };

  // SoH projection: extend measured curve linearly to forecast when warranty
  // floor is breached. Uses real cycling rate from cycling_metrics.
  const projection = useMemo(() => {
    const floor = wt?.capacity_guarantee_pct ?? null;
    // The whole point of the projection is the date the CONTRACTUAL floor is
    // crossed. Without terms there is no floor to cross, so there is no
    // projection, and the panel says so rather than projecting to a guess.
    if (!sohHistory?.length || floor == null || !cycling) return null;
    const measured = sohHistory.map((p) => ({
      year: new Date(p.date).getFullYear() + new Date(p.date).getMonth() / 12,
      soh: p.soh,
      measured: true,
    }));
    const last = sohHistory[sohHistory.length - 1];
    const fadeRate =
      sohHistory.length >= 2
        ? (sohHistory[0].soh - last.soh) /
          Math.max(0.1, (new Date(last.date).getTime() - new Date(sohHistory[0].date).getTime()) / (365 * 86400000))
        : 0.02;
    const lastYear = new Date(last.date).getFullYear() + new Date(last.date).getMonth() / 12;
    const projected: typeof measured = [];
    const yearsToFloor = (last.soh - floor) / Math.max(0.005, fadeRate);
    const endYear = lastYear + Math.max(2, Math.min(15, yearsToFloor + 1));
    for (let y = lastYear + 0.25; y <= endYear; y += 0.5) {
      projected.push({
        year: y,
        soh: Math.max(0.5, last.soh - fadeRate * (y - lastYear)),
        measured: false,
      });
    }
    return {
      points: [...measured, ...projected],
      eolYear: Math.round(lastYear + yearsToFloor),
      fadeRatePctPerYr: fadeRate * 100,
    };
  }, [sohHistory, wt, cycling]);

  // Rainflow DoD histogram — the REAL ASTM E1049 distribution served by the
  // cycling route from BessCycleRecord.rainflow_data (was fixed synthetic
  // fractions). Empty when no rainflow data exists (honest empty state).
  const rainflowBars = useMemo(() => {
    const dist = (bess.cyclingMetrics as any)?.rainflowAnalysis?.dodDistribution as
      | Array<{ dodRange: string; count: number }>
      | undefined;
    if (!dist?.length) return [];
    const bars = dist.map((d) => ({ label: d.dodRange, count: Math.round(d.count) }));
    return bars.some((b) => b.count > 0) ? bars : [];
  }, [bess.cyclingMetrics]);

  // Summary of the histogram, from the bars the histogram itself draws.
  //
  // This panel used to be captioned with `averages.dod`, which is the mean
  // daily depth across every day in the window, idle days included. On this
  // asset that is 5%, printed as the caption of a chart whose own mass sits in
  // the 40 to 80% buckets. Two numbers for one quantity, and the wrong one had
  // the prominent position.
  const rainflowSummary = useMemo(() => {
    const total = rainflowBars.reduce((s, b) => s + b.count, 0);
    if (!total) return null;
    const deep = rainflowBars
      .filter((b) => (parseInt(b.label, 10) || 0) >= 60)
      .reduce((s, b) => s + b.count, 0);
    return { total, deepPct: (deep / total) * 100 };
  }, [rainflowBars]);

  if (bess.isLoading && !asset) {
    return (
      <div className="flex h-32 items-center justify-center font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
        loading BESS telemetry…
      </div>
    );
  }
  if (!asset) {
    return (
      <OpsPanel label="Battery telemetry unavailable">
        <div className="flex h-32 items-center justify-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
          no BESS assets configured for {plantId}
        </div>
      </OpsPanel>
    );
  }

  const sohFrac = fin(asset.currentSoh);
  const socFrac = fin(asset.currentSoc);
  const sohPct = sohFrac == null ? null : sohFrac * 100;
  const socPct = socFrac == null ? null : socFrac * 100;
  const capacityMwh = fin(asset.nominalCapacityKwh) == null ? null : fin(asset.nominalCapacityKwh)! / 1000;
  const powerMw = fin(asset.nominalPowerKw) == null ? null : fin(asset.nominalPowerKw)! / 1000;
  const rte = fin(cycling?.averages?.roundTripEfficiency);
  // Efficiency is judged against the contractual minimum when one is on file.
  // The 0.88 that used to sit here was an invented pass mark, and it read as a
  // spec on an asset whose contract says 0.85.
  const minRte = wt?.min_rte ?? null;
  const cyclingDays = fin(cycling?.period?.days);
  const windowSuffix = cyclingDays == null ? '' : `, ${cyclingDays.toFixed(0)}d window`;

  return (
    <div className="space-y-3">
      {/* Asset selector + ID strip */}
      <OpsPanel
        label={
          <span className="inline-flex items-center gap-2">
            <span style={{ color: 'var(--ops-bess)' }}>BESS</span>
            <span>{asset.name}</span>
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-2 text-[10px]">
            <span>{asset.chemistry}</span>
            <span style={{ color: 'var(--ops-dim)' }}>·</span>
            <span>{fmt(capacityMwh, 1)} MWh / {fmt(powerMw, 1)} MW</span>
            <span style={{ color: 'var(--ops-dim)' }}>·</span>
            <span>{[asset.manufacturer, asset.model].filter(Boolean).join(' ') || NO_VALUE}</span>
            <span style={{ color: 'var(--ops-dim)' }}>·</span>
            <span>COD <span style={{ color: 'var(--ops-txt)' }}>{asset.installationDate ?? NO_VALUE}</span></span>
            {bess.assets && bess.assets.length > 1 && (
              <>
                <span style={{ color: 'var(--ops-dim)' }}>·</span>
                {/* The hook exposes the resolved asset, not a bare id; reading
                    a non-existent `selectedAssetId` left the picker showing the
                    first option regardless of which asset was loaded. */}
                <select
                  value={bess.selectedAsset?.id ?? ''}
                  onChange={(e) => bess.selectAsset(e.target.value)}
                  className="rounded-sm border px-1 py-0.5 font-mono text-[10px]"
                  style={{
                    background: 'var(--ops-panel-2)',
                    borderColor: 'var(--ops-hair)',
                    color: 'var(--ops-txt)',
                  }}
                >
                  {bess.assets.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </>
            )}
          </span>
        }
      >
        <StateOfSafety plantId={plantId} />
      </OpsPanel>

      <TelemetryStrip
        columns={8}
        cells={[
          {
            label: 'SoH',
            value: fmt(sohPct, 1),
            unit: '%',
            tone: sohPct == null ? 'neutral' : sohPct >= 90 ? 'ok' : sohPct >= 75 ? 'warn' : 'alarm',
            footer: 'state of health',
            tooltip: GLOSSARY.SoH,
          },
          {
            label: 'SoC',
            value: fmt(socPct, 0),
            unit: '%',
            tone: 'bess',
            footer: 'state of charge',
            tooltip: GLOSSARY.SoC,
          },
          {
            label: 'CYCLES',
            value: fmt(wh?.cycles_used, 0),
            tone: 'neutral',
            footer: wt?.max_cycles != null ? `of ${wt.max_cycles.toLocaleString()}` : 'no cycle cap on file',
            tooltip: GLOSSARY.EFC,
          },
          {
            label: 'THROUGHPUT',
            value: fmt(cycling?.totals?.throughputMwh, 0),
            unit: 'MWh',
            tone: 'neutral',
            // The route serves cumulative_throughput_kwh, which is lifetime to
            // date, not a trailing window. Labelling it "30d window" put a
            // lifetime number next to a 30 day one: on a 10 MWh asset it read as
            // 4,230 MWh in 30 days, which is 14 full cycles a day, and it sat
            // beside a cycle count of 102.
            footer: 'cumulative to date',
            tooltip:
              'Total energy moved through the battery (charge plus discharge) since records begin.',
          },
          {
            label: 'RTE',
            value: rte == null ? NO_VALUE : (rte * 100).toFixed(1),
            unit: '%',
            tone: rte == null || minRte == null ? 'neutral' : rte >= minRte ? 'ok' : 'warn',
            footer:
              minRte == null
                ? `round-trip${windowSuffix}`
                : `vs ${(minRte * 100).toFixed(0)}% warranty min`,
            tooltip: GLOSSARY.RTE,
          },
          {
            label: 'AVG DOD',
            value:
              fin(cycling?.averages?.dod) == null
                ? NO_VALUE
                : (fin(cycling?.averages?.dod)! * 100).toFixed(0),
            unit: '%',
            tone: 'neutral',
            // The route averages the DAILY mean depth over every day in the
            // window, idle days included, so this is not the depth of a
            // typical cycle. Calling it "cycle depth" put it in conflict with
            // the dispatch tab's avg DoD and with the rainflow histogram.
            footer: `daily mean${windowSuffix}`,
            tooltip:
              'Mean daily depth of discharge across every day in the window, including days the battery did not cycle. For the depth of the cycles themselves, read the rainflow distribution.',
          },
          {
            // Sourced from warranty_years minus elapsed years, so it is the
            // calendar warranty term left, NOT the time to the state-of-health
            // floor. The two differ by a decade on this asset: the projection
            // panel puts the floor breach around 2045.
            label: 'WARRANTY TERM',
            value: fmt(wh?.years_remaining, 1),
            unit: 'yr left',
            tone: 'neutral',
            footer: wt?.warranty_years == null ? 'calendar term' : `of ${wt.warranty_years} yr term`,
            tooltip:
              'Calendar years left on the warranty term, from the commissioning date and the contract length. This is not the time to the state-of-health floor, which the projection chart estimates separately.',
          },
          {
            label: 'WARRANTY',
            value: fmt(wh?.score, 0),
            unit: '/100',
            tone: wh?.score == null ? 'neutral' : tierTone(wh.risk_level),
            footer: wh?.risk_level ?? '',
            tooltip:
              'Composite warranty health score (0 to 100) from SoH margin, cycle usage, time, efficiency, and violations.',
          },
        ]}
      />

      <OpsTabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'warranty', label: 'Warranty', badge: violations.length > 0 ? violations.length : undefined, statusTone: violations.length > 0 ? 'warn' : undefined },
          { key: 'cycling', label: 'Cycling' },
          { key: 'dispatch', label: 'Dispatch' },
          // Named for the grain, not the gesture. Rack grain is the product tier
          // (ΔV and ΔT per rack), so it is visible from the tab strip rather than
          // two clicks into something called "drill-down". Badged with the
          // asset's own rack count when it carries one; no count, no badge,
          // never a placeholder number.
          { key: 'drilldown', label: 'Racks', badge: asset.rackCount || undefined },
        ]}
        value={activeTab}
        onChange={(k) => setActiveTab(k as typeof activeTab)}
        syncToUrl
      />

      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (() => {
        const capacityKwh = fin(asset.nominalCapacityKwh);
        const installValueEur =
          capacityKwh == null ? null : capacityKwh * INSTALLED_CAPEX_EUR_PER_KWH;
        // Contractual floor, or null. Never a stand-in number: "70%" printed
        // next to "warranty" is a claim about this asset's supply contract.
        const warrantyFloor = wt?.capacity_guarantee_pct ?? null;
        const floorSource = floorProvenance(termsProvenance);
        const currentSoh = fin(asset.currentSoh) ?? wh?.current_soh ?? null;
        const cycleUsage =
          wh?.cycles_used != null && wt?.max_cycles != null && wt.max_cycles > 0
            ? wh.cycles_used / wt.max_cycles
            : null;
        // Cohort membership needs a real score per peer; a peer with none is
        // left out rather than joining the ranking on an invented 80.
        const cohortMembers: CohortAsset[] = (bess.assets ?? [])
          .map((a) => {
            const peerScore = fin((a as any).warrantyHealthScore) ?? (a.id === asset.id ? wh?.score : null);
            const peerSoh = fin(a.currentSoh);
            if (peerScore == null || peerSoh == null) return null;
            return {
              id: a.id,
              name: a.name,
              warrantyHealthScore: peerScore,
              currentSoh: peerSoh,
              chemistry: a.chemistry,
            } as CohortAsset;
          })
          .filter((a): a is CohortAsset => a != null);
        // Fleet cohort compares this asset only against the org's OTHER real BESS
        // assets. The old code synthesised 5 fake peers (sin/cos) when the fleet
        // was small; removed, and the panel is gated on a real fleet below.
        const targetCohortMember: CohortAsset | null =
          wh?.score != null && currentSoh != null
            ? {
                id: asset.id,
                name: asset.name,
                warrantyHealthScore: wh.score,
                currentSoh,
                chemistry: asset.chemistry,
              }
            : null;

        // An absent indicator reads `muted`, never `ok`. Green on a number
        // nobody measured is the banner asserting health it cannot see, and it
        // used to pull the whole tier towards NOMINAL.
        const indicators: RiskIndicator[] = [
          {
            label: 'WARRANTY',
            value: wh?.score == null ? NO_VALUE : `${wh.score}/100`,
            tone:
              wh?.score == null ? 'muted' : wh.score >= 80 ? 'ok' : wh.score >= 60 ? 'warn' : 'alarm',
          },
          {
            label: 'SoH',
            value: currentSoh == null ? NO_VALUE : `${(currentSoh * 100).toFixed(1)}%`,
            tone:
              currentSoh == null
                ? 'muted'
                : currentSoh >= 0.9
                  ? 'ok'
                  : currentSoh >= 0.8
                    ? 'warn'
                    : 'alarm',
          },
          {
            label: 'CYCLE BUDGET',
            value: cycleUsage == null ? NO_VALUE : `${(cycleUsage * 100).toFixed(0)}% used`,
            tone:
              cycleUsage == null
                ? 'muted'
                : cycleUsage < 0.5
                  ? 'ok'
                  : cycleUsage < 0.8
                    ? 'warn'
                    : 'alarm',
          },
          {
            // Same source, same meaning as the KPI cell: calendar warranty
            // term left, not time to the state-of-health floor.
            label: 'WARRANTY TERM',
            value: wh?.years_remaining == null ? NO_VALUE : `${wh.years_remaining.toFixed(1)} yr left`,
            tone:
              wh?.years_remaining == null
                ? 'muted'
                : wh.years_remaining >= 5
                  ? 'ok'
                  : wh.years_remaining >= 2
                    ? 'warn'
                    : 'alarm',
          },
        ];
        const { tone: overallTone, tier: tierLabel } = bannerTone(indicators);

        const warrantyRows = warrantyBudgetRows(wh, wt);

        return (
          <div className="space-y-3">
            <RiskHeroBanner
              tier={tierLabel}
              tone={overallTone}
              indicators={indicators}
              summary={
                <>
                  {asset.name} · {asset.chemistry} · {fmt(capacityMwh, 1)} MWh
                </>
              }
            />

            <div className="ops-grid-2 ops-grid-2-wide">
          <OpsPanel
            label="State of health · measured + projected fade"
            subtitle="State-of-health projection"
            meta={
              <span className="flex items-center gap-3">
                {projection && (
                  <span style={{ color: 'var(--ops-bess)' }}>
                    fade {projection.fadeRatePctPerYr.toFixed(1)}%/yr
                  </span>
                )}
                <OpsTimeRange value={sohRange} onChange={setSohRange} options={['90d', '1y', 'all']} />
              </span>
            }
          >
            {projection && warrantyFloor != null ? (
              <SoHProjectionChart
                points={projection.points}
                warrantyFloor={warrantyFloor}
                eolYear={projection.eolYear}
              />
            ) : (
              <EmptyState message={sohProjectionGap(sohHistory, warrantyFloor, cycling)} />
            )}
          </OpsPanel>

          <OpsPanel
            label="Warranty tracker · 4-axis budget"
            meta={
              wh?.risk_level && (
                <span
                  className="rounded-sm border px-1.5 py-px text-[10px]"
                  style={riskChipStyle(tierTone(wh.risk_level))}
                >
                  {wh.risk_level} RISK
                </span>
              )
            }
          >
            {warrantyRows.length > 0 ? (
              <WarrantyTracker
                rows={warrantyRows}
                projectedBreach={
                  projection || wh?.recommendation ? (
                    <>
                      <span>Projected floor breach</span>
                      <span style={{ color: 'var(--ops-txt)', fontWeight: 600 }}>
                        {projection ? `~${projection.eolYear}` : ''}
                        {projection && wh?.recommendation ? ' · ' : ''}
                        {wh?.recommendation?.split(':')[0] ?? ''}
                      </span>
                    </>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                message={
                  wt
                    ? 'no warranty measurements recorded for this asset yet'
                    : 'no warranty terms on file, so there is no budget to track'
                }
              />
            )}
          </OpsPanel>
            </div>

            <div className="ops-grid-2 ops-grid-2-wide">
              {currentSoh != null && capacityKwh != null && installValueEur != null ? (
                <BatteryResidualValue
                  currentSoh={currentSoh}
                  warrantyFloor={warrantyFloor}
                  warrantyFloorSource={floorSource}
                  secondLifeFloor={SECOND_LIFE_SOH}
                  installValueEur={installValueEur}
                  installValueSource={`${Math.round(capacityKwh).toLocaleString('en-GB')} kWh × €${INSTALLED_CAPEX_EUR_PER_KWH}/kWh assumed installed cost`}
                />
              ) : (
                <OpsPanel label="Residual value · projection">
                  <EmptyState message="needs a state of health reading and a nameplate capacity for this asset" />
                </OpsPanel>
              )}
              {targetCohortMember && cohortMembers.length >= 2 ? (
                <FleetCohortComparison target={targetCohortMember} cohort={cohortMembers} />
              ) : (
                <OpsPanel label="Fleet cohort" subtitle="Peer comparison">
                  <EmptyState message="fleet comparison needs 2 or more scored BESS assets in this account" />
                </OpsPanel>
              )}
            </div>

            <div className="ops-grid-2 ops-grid-2-wide">
              <OpsPanel
                label="Cycle-depth distribution · rainflow, full history"
                subtitle="ASTM E1049 rainflow"
                meta={
                  <span style={{ color: 'var(--ops-muted)' }}>
                    {rainflowSummary
                      ? `${rainflowSummary.total.toLocaleString()} cycles counted`
                      : 'cycle-depth buckets'}
                  </span>
                }
              >
                {rainflowBars.length > 0 ? (
                  <RainflowHistogram bars={rainflowBars} />
                ) : (
                  <EmptyState message="rainflow data unavailable" />
                )}
              </OpsPanel>
              {capacityKwh != null ? (
                <EolDecommissioningPanel
                  capacityKwh={capacityKwh}
                  chemistry={asset.chemistry}
                  endOfLifeSoh={warrantyFloor ?? SECOND_LIFE_SOH}
                  // This used to read "contractual capacity guarantee" for any
                  // non-null floor, which on an asset carrying chemistry
                  // defaults is a claim about a contract nobody uploaded.
                  endOfLifeSohSource={
                    warrantyFloor != null
                      ? FLOOR_LABEL[floorSource]
                      : `assumed end of life, no warranty terms on file`
                  }
                />
              ) : (
                <OpsPanel label="End-of-life decommissioning · cost projection">
                  <EmptyState message="needs a nameplate capacity for this asset" />
                </OpsPanel>
              )}
            </div>
          </div>
        );
      })()}

      {/* WARRANTY TAB */}
      {activeTab === 'warranty' && (
        <div className="space-y-3">
          <div className="ops-grid-2">
            <OpsPanel label="Warranty health · composite score" meta={<span style={{ color: 'var(--ops-info)' }}>5-dim score</span>}>
              {wh ? (
                <>
                  <div className="flex items-center gap-5">
                    {wh.score != null ? (
                      <HealthRing
                        score={wh.score}
                        tone={tierTone(wh.risk_level)}
                        subtitle="health"
                        size={92}
                      />
                    ) : (
                      <div
                        className="flex h-[92px] w-[92px] shrink-0 items-center justify-center rounded-full border text-center text-[11px] leading-tight"
                        style={{ borderColor: 'var(--ops-hair)', color: 'var(--ops-muted)' }}
                      >
                        not scored
                      </div>
                    )}
                    <div className="flex-1 space-y-2">
                      {Object.entries(wh.component_scores).map(([k, v]) => {
                        const tone: StatusTone =
                          v == null ? 'muted' : v >= 80 ? 'ok' : v >= 60 ? 'warn' : 'alarm';
                        return (
                          <div key={k}>
                            <div className="mb-0.5 flex items-baseline justify-between font-mono text-[11.5px]">
                              <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ops-muted)' }}>
                                <StatusLed tone={tone} size={6} /> {k}
                              </span>
                              <span
                                className="ops-num"
                                style={{ color: v == null ? 'var(--ops-dim)' : 'var(--ops-bright)' }}
                              >
                                {v == null ? 'no data' : `${v}/100`}
                              </span>
                            </div>
                            {/* No bar for a component with no score. A zero-width
                                bar reads as a measured zero. */}
                            {v != null && (
                              <div className="h-1.5 overflow-hidden rounded" style={{ background: 'var(--ops-row-hair)' }}>
                                <div
                                  className="h-full"
                                  style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: `var(--ops-${tone})` }}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {wh.recommendation && (
                    <div
                      className="mt-3 rounded-md border p-2 font-mono text-[10.5px]"
                      style={{
                        background: 'var(--ops-panel-2)',
                        borderColor: 'var(--ops-row-hair)',
                        color: 'var(--ops-muted)',
                      }}
                    >
                      {wh.recommendation}
                    </div>
                  )}
                </>
              ) : (
                <EmptyState message="no warranty status published for this asset yet" />
              )}
            </OpsPanel>

            {/* Terms come off the supply contract. A battery onboarded without
                one has no terms row, which is a normal state, not an error, and
                certainly not a reason to substitute industry-typical clauses. */}
            <OpsPanel
              label={
                termsProvenance?.isContractDerived === false
                  ? 'Warranty terms · not from a contract'
                  : 'Warranty terms · contractual'
              }
              meta={
                !wt ? (
                  <span style={{ color: 'var(--ops-muted)' }}>not on file</span>
                ) : termsProvenance?.isContractDerived === false ? (
                  // A chemistry default under a heading reading "contractual" is
                  // the kind of number an operator would quote to an OEM.
                  <span style={{ color: 'var(--ops-muted)' }}>
                    {termsProvenance.source === 'operator_declared'
                      ? 'operator declared'
                      : 'chemistry defaults'}
                  </span>
                ) : null
              }
            >
              {wt ? (
                <div className="space-y-2 font-mono text-[11.5px]">
                  {[
                    ['Capacity guarantee', fmt(wt.capacity_guarantee_pct == null ? null : wt.capacity_guarantee_pct * 100, 0, '%')],
                    ['Warranty years', wt.warranty_years == null ? NO_VALUE : `${wt.warranty_years} yr`],
                    ['Max cycles', wt.max_cycles?.toLocaleString() ?? NO_VALUE],
                    ['Max throughput', wt.max_throughput_mwh == null ? NO_VALUE : `${wt.max_throughput_mwh} MWh`],
                    ['Min RTE', fmt(wt.min_rte == null ? null : wt.min_rte * 100, 0, '%')],
                    [
                      'Operating temp',
                      wt.operating_temp_min_c == null && wt.operating_temp_max_c == null
                        ? NO_VALUE
                        : `${fmt(wt.operating_temp_min_c, 0)} to ${fmt(wt.operating_temp_max_c, 0)} °C`,
                    ],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between border-b py-1 last:border-0" style={{ borderColor: 'var(--ops-row-hair)' }}>
                      <span style={{ color: 'var(--ops-muted)' }}>{label}</span>
                      <span className="ops-num" style={{ color: 'var(--ops-txt)' }}>{value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--ops-txt)' }}>
                  No warranty terms are on file for this battery.
                  <div className="mt-1 text-[12px]" style={{ color: 'var(--ops-muted)' }}>
                    Capacity guarantee, cycle cap, throughput cap, minimum
                    round-trip efficiency and the operating temperature window
                    all come from the supply contract. Upload it under Contracts,
                    or enter the clauses in plant settings, and the warranty
                    budget, the projected floor breach and the violation
                    thresholds all start working.
                  </div>
                </div>
              )}
            </OpsPanel>
          </div>

          <OpsPanel
            label="Warranty violations · log"
            meta={
              <span style={{ color: violations.length > 0 ? 'var(--ops-warn)' : 'var(--ops-muted)' }}>
                {violations.length} {violations.length === 1 ? 'event' : 'events'}
              </span>
            }
            flush
          >
            {violations.length > 0 ? (
              <OpsTable
                columns={[
                  {
                    // The route serves `startedAt`; `detectedAt` is the older
                    // fixture spelling. Reading only the fixture key left every
                    // row's date blank against the live payload.
                    key: 'date',
                    label: 'DATE',
                    render: (r: any) =>
                      (r.startedAt ?? r.started_at ?? r.detectedAt ?? r.detected_at)?.slice(0, 10) ??
                      NO_VALUE,
                    weight: 1,
                  },
                  {
                    key: 'type',
                    label: 'TYPE',
                    render: (r: any) => r.violationType ?? r.violation_type ?? NO_VALUE,
                    weight: 1.5,
                  },
                  { key: 'sev', label: 'SEVERITY', render: (r: any) => r.severity ?? NO_VALUE, weight: 0.8 },
                  { key: 'desc', label: 'DESCRIPTION', render: (r: any) => r.description ?? NO_VALUE, weight: 2 },
                  {
                    key: 'res',
                    label: 'STATUS',
                    render: (r: any) => ((r.resolvedAt ?? r.resolved_at) ? 'resolved' : 'open'),
                    weight: 0.8,
                  },
                ]}
                rows={violations}
                status={(r: any) =>
                  (r.resolvedAt ?? r.resolved_at) ? 'ok' : r.severity === 'critical' ? 'alarm' : 'warn'
                }
              />
            ) : (
              <div
                className="flex h-24 items-center justify-center font-mono text-[11px] italic"
                style={{ color: 'var(--ops-muted)' }}
              >
                no warranty violations on record · operating within all contractual limits
              </div>
            )}
          </OpsPanel>
        </div>
      )}

      {/* CYCLING TAB */}
      {activeTab === 'cycling' && (
        <div className="space-y-3">
          {cycling && (() => {
            const efc = fin(cycling.totals?.equivalentFullCycles);
            const cRate = fin(cycling.averages?.cRate);
            // `limits.maxCRate` is the highest rate OBSERVED over the window,
            // not a rating, so it cannot be the thing an average is judged
            // against. The rated ceiling, when a contract carries one, is
            // max_c_rate_continuous.
            const peakCRate = fin(cycling.limits?.maxCRate);
            const ratedCRate = wt?.max_c_rate_continuous ?? null;
            const stress = fin(cycling.stressMetrics?.stressWeightedCycles);
            // Stress uplift needs a non-zero raw cycle count to divide by; a
            // battery that has not completed a cycle yet has no uplift to show.
            const uplift =
              stress != null && efc != null && efc > 0 ? ((stress - efc) / efc) * 100 : null;
            const windowLabel = cycling.period?.days ? `${cycling.period.days}d` : 'window';
            return (
              <TelemetryStrip
                columns={6}
                cells={[
                  { label: 'TOTAL CYCLES', value: fmt(efc, 0), tone: 'neutral', footer: 'equivalent full' },
                  { label: 'CHARGED', value: fmt(cycling.totals?.energyChargedMwh, 0), unit: 'MWh', tone: 'info', footer: windowLabel },
                  { label: 'DISCHARGED', value: fmt(cycling.totals?.energyDischargedMwh, 0), unit: 'MWh', tone: 'bess', footer: windowLabel },
                  { label: 'DAILY CYC', value: fmt(cycling.averages?.dailyCycles, 2), tone: 'neutral', footer: 'avg' },
                  {
                    label: 'C-RATE',
                    value: fmt(cRate, 2),
                    unit: 'C',
                    tone:
                      cRate == null || ratedCRate == null
                        ? 'neutral'
                        : cRate > ratedCRate * 0.8
                          ? 'warn'
                          : 'ok',
                    footer:
                      peakCRate == null
                        ? 'average over the window'
                        : `avg, peak observed ${peakCRate.toFixed(2)} C`,
                    tooltip:
                      ratedCRate == null
                        ? 'Average charge or discharge rate as a multiple of nameplate capacity. No rated continuous C-rate is on file for this asset, so there is nothing to judge it against.'
                        : `Average charge or discharge rate as a multiple of nameplate capacity, against a rated continuous ${ratedCRate} C.`,
                  },
                  {
                    label: 'STRESS CYC',
                    value: fmt(stress, 0),
                    // Below the raw count means the stress model found the duty
                    // gentler than nominal, which is not a warning.
                    tone: uplift == null ? 'neutral' : uplift > 0 ? 'warn' : 'neutral',
                    footer:
                      uplift == null
                        ? 'vs raw'
                        : `${uplift >= 0 ? '+' : '−'}${Math.abs(uplift).toFixed(0)}% vs raw`,
                  },
                ]}
              />
            );
          })()}

          <div className="ops-grid-2 ops-grid-2-wide">
            <OpsPanel
              label="State of health history · measured points"
              subtitle="State-of-health history"
              meta={
                <span className="flex items-center gap-3">
                  {sohHistory && <span>{sohHistory.length} measurements</span>}
                  <OpsTimeRange value={sohRange} onChange={setSohRange} options={['90d', '1y', 'all']} />
                </span>
              }
            >
              {sohWindow && sohWindow.length >= 2 ? (
                <OpsLineChart
                  series={[
                    {
                      key: 'soh',
                      label: 'SoH',
                      tone: 'bess',
                      values: sohWindow.map((p) => p.soh * 100),
                      format: (v) => `${v.toFixed(2)}%`,
                    },
                  ]}
                  xLabels={
                    sohWindow.length > 6
                      ? sohWindow
                          .filter((_, i) => i % Math.ceil(sohWindow.length / 6) === 0)
                          .map((p) => p.date.slice(0, 7))
                      : sohWindow.map((p) => p.date.slice(0, 7))
                  }
                  xTooltipLabels={sohWindow.map((p) => `${p.date} · ${p.source} · ${Math.round(p.cumulative_cycles)} cyc`)}
                  yRange={[Math.max(50, Math.floor(Math.min(...sohWindow.map((p) => p.soh)) * 100) - 2), 100]}
                />
              ) : (
                <EmptyState message="not enough SoH history points in window" />
              )}
            </OpsPanel>

            <OpsPanel
              label="Cycle depth · rainflow distribution"
              meta={
                rainflowSummary && (
                  <span style={{ color: 'var(--ops-muted)' }}>
                    {rainflowSummary.total.toLocaleString()} cycles counted ·{' '}
                    {rainflowSummary.deepPct.toFixed(0)}% deeper than 60%
                  </span>
                )
              }
            >
              {rainflowBars.length > 0 ? <RainflowHistogram bars={rainflowBars} /> : <EmptyState message="no cycling data" />}
            </OpsPanel>
          </div>

          {/* Monthly aggregates: capacity fade + cycling rollups. */}
          {(fadeByMonth || cyclingMonthly) && (
            <div className="ops-grid-2 ops-grid-2-wide">
              {fadeByMonth && (
                <OpsPanel
                  label="Capacity fade · per month"
                  subtitle="SoH lost per 30 days, from measured points"
                  meta={
                    <span style={{ color: 'var(--ops-muted)' }}>
                      avg{' '}
                      <span className="ops-num" style={{ color: 'var(--ops-bess)' }}>
                        {fadeByMonth.avg.toFixed(2)}
                      </span>{' '}
                      pp/mo
                      {fadeByMonth.yearsToFloor != null && (
                        <>
                          {' '}
                          · floor in ≈{' '}
                          <span className="ops-num" style={{ color: 'var(--ops-warn)' }}>
                            {fadeByMonth.yearsToFloor.toFixed(1)}
                          </span>{' '}
                          yr
                        </>
                      )}
                    </span>
                  }
                >
                  <OpsBarChart
                    bars={fadeByMonth.bars}
                    valueLabel="Capacity fade"
                    defaultTone="bess"
                    formatValue={(v) => `${v.toFixed(2)} pp`}
                    yUnit="pp/mo"
                    height={180}
                  />
                </OpsPanel>
              )}
              {cyclingMonthly && (
                <OpsPanel
                  label="Cycling · monthly"
                  subtitle="Equivalent full cycles per month, throughput overlay"
                  meta={<span style={{ color: 'var(--ops-muted)' }}>{cyclingMonthly.bars.length} months</span>}
                >
                  <OpsBarChart
                    bars={cyclingMonthly.bars}
                    valueLabel="Cycles"
                    overlay={cyclingMonthly.overlay}
                    defaultTone="bess"
                    formatValue={(v) => v.toFixed(1)}
                    yUnit="cyc"
                    height={180}
                  />
                </OpsPanel>
              )}
            </div>
          )}

          {/* RTE over time — recorded on every cycle, an early-warning signal
              for cell/thermal drift. Range-windowed + drag-to-zoom. */}
          {rteDaily.length >= 2 && (() => {
            const minRte = wt?.min_rte ?? null;
            return (
              <OpsPanel
                label="Round-trip efficiency · trend"
                subtitle={`Daily round-trip efficiency vs warranty floor · ${rteDaily[0].date} → ${rteDaily[rteDaily.length - 1].date} · drag to zoom`}
                meta={
                  <span className="flex items-center gap-3">
                    {minRte && (
                      <span style={{ color: 'var(--ops-muted)' }}>
                        warranty min {(minRte * 100).toFixed(0)}%
                      </span>
                    )}
                    <OpsTimeRange
                      value={rteCtl.range}
                      onChange={rteCtl.setRange}
                      options={['30d', '90d', '1y', 'all']}
                      onCustomRange={rteCtl.setCustomRange}
                    />
                  </span>
                }
              >
                <OpsLineChart
                  series={[
                    {
                      key: 'rte',
                      label: 'RTE',
                      tone: 'ok',
                      values: rteDaily.map((r: any) => r.roundTripEfficiency * 100),
                      format: (v: number) => `${v.toFixed(1)}%`,
                    },
                    ...(minRte
                      ? [
                          {
                            key: 'floor',
                            label: 'Warranty min',
                            tone: 'alarm' as const,
                            values: rteDaily.map(() => minRte * 100),
                            format: (v: number) => `${v.toFixed(0)}%`,
                          },
                        ]
                      : []),
                  ]}
                  xLabels={
                    rteDaily.length > 6
                      ? rteDaily
                          .filter((_: any, i: number) => i % Math.ceil(rteDaily.length / 6) === 0)
                          .map((r: any) => r.date.slice(5))
                      : rteDaily.map((r: any) => r.date.slice(5))
                  }
                  xTooltipLabels={rteDaily.map((r: any) => r.date)}
                  onBrush={handleRteBrush}
                  yRange={[
                    Math.floor(
                      Math.min(
                        ...rteDaily.map((r: any) => r.roundTripEfficiency * 100),
                        (minRte ?? 1) * 100
                      ) - 2
                    ),
                    100,
                  ]}
                />
              </OpsPanel>
            );
          })()}
        </div>
      )}

      {/* DISPATCH TAB */}
      {activeTab === 'dispatch' && (
        <div className="space-y-3">
          {dispatch && (dispatch as any).schedule && (() => {
            const s = (dispatch as any).schedule;
            const avgDod = fin(s.avgDod);
            const scheduleDate = typeof s.scheduleDate === 'string' ? s.scheduleDate.slice(0, 10) : null;
            const dayLabel = scheduleDate ?? 'scheduled day';
            return (
              <TelemetryStrip
                columns={5}
                cells={[
                  { label: 'EXP REVENUE', value: eur(s.expectedRevenueEur), tone: 'ok', footer: dayLabel },
                  { label: 'DEGRADE COST', value: eur(s.degradationCostEur), tone: 'warn', footer: dayLabel },
                  { label: 'NET', value: eur(s.netRevenueEur), tone: 'ok', footer: 'revenue less degradation' },
                  {
                    label: 'EXP CYCLES',
                    value: fmt(s.expectedCycles, 2),
                    tone: 'neutral',
                    // The schedule's own depth of discharge, which is the depth
                    // of one planned cycle and is not comparable with the KPI
                    // row's daily mean across the whole history.
                    footer: avgDod == null ? 'avg DoD n/a' : `planned DoD ${(avgDod * 100).toFixed(0)}%`,
                  },
                  {
                    label: 'OPTIMIZER',
                    value: s.optimizerType ?? NO_VALUE,
                    tone: 'info',
                    footer: s.status ?? '',
                  },
                ]}
              />
            );
          })()}
          <OpsPanel
            label="Dispatch schedule · 24h"
            meta={dispatch && <span style={{ color: 'var(--ops-info)' }}>{(dispatch as any).slots?.length ?? 0} slots</span>}
            flush
          >
            {dispatch && (dispatch as any).slots?.length > 0 ? (
              <OpsTable
                columns={[
                  { key: 'h', label: 'HOUR', render: (r: any) => `${String(r.hour).padStart(2, '0')}:00`, weight: 0.6 },
                  {
                    key: 'mode',
                    label: 'MODE',
                    render: (r: any) => (r.action ?? 'idle').toUpperCase(),
                    weight: 0.7,
                  },
                  {
                    key: 'pwr',
                    label: 'POWER kW',
                    numeric: true,
                    render: (r: any) => {
                      const charge = fin(r.chargeKw);
                      const discharge = fin(r.dischargeKw);
                      if (charge == null && discharge == null) return NO_VALUE;
                      const v =
                        (charge ?? 0) > 0 ? charge! : (discharge ?? 0) > 0 ? -discharge! : 0;
                      return v.toFixed(0);
                    },
                  },
                  {
                    key: 'soc',
                    label: 'SoC%',
                    numeric: true,
                    render: (r: any) =>
                      fin(r.soc) == null ? NO_VALUE : (fin(r.soc)! * 100).toFixed(0),
                  },
                  {
                    key: 'p',
                    label: '€/MWh',
                    numeric: true,
                    render: (r: any) =>
                      fin(r.priceEurMwh) == null ? NO_VALUE : `€${fin(r.priceEurMwh)!.toFixed(0)}`,
                  },
                ]}
                rows={(dispatch as any).slots}
                status={(r: any) =>
                  r.action === 'charge' ? 'info' : r.action === 'discharge' ? 'bess' : 'muted'
                }
              />
            ) : (
              <EmptyState message="no dispatch schedule available for this asset" />
            )}
          </OpsPanel>

          {dispatch && (dispatch as any).arbitrageOpportunities?.length > 0 && (
            <OpsPanel
              label="Arbitrage opportunities"
              meta={<span>{(dispatch as any).arbitrageOpportunities.length} windows</span>}
              flush
            >
              {/* Column keys follow the shape the dispatch route actually
                  serves (charge/discharge windows plus a spread), with the
                  older flat fixture keys kept as a fallback so a legacy demo
                  JSON still reads. Times are UTC, and the header says so,
                  because the window objects carry no plant-local hour. */}
              <OpsTable
                columns={[
                  {
                    key: 'charge',
                    label: 'CHARGE UTC',
                    render: (r: any) => utcWindow(r.chargeWindow) ?? legacyWindow(r),
                    weight: 1,
                  },
                  {
                    key: 'discharge',
                    label: 'DISCHARGE UTC',
                    render: (r: any) => utcWindow(r.dischargeWindow) ?? NO_VALUE,
                    weight: 1,
                  },
                  {
                    key: 'spread',
                    label: 'SPREAD',
                    numeric: true,
                    render: (r: any) => eur(r.spread ?? r.priceSpreadEurMwh),
                  },
                  {
                    key: 'rev',
                    label: 'EXP REV',
                    numeric: true,
                    render: (r: any) => eur(r.expectedRevenueEur),
                  },
                  {
                    key: 'deg',
                    label: 'DEGRADE',
                    numeric: true,
                    render: (r: any) => eur(r.degradationCostEur),
                  },
                  {
                    key: 'net',
                    label: 'NET',
                    numeric: true,
                    render: (r: any) => eur(r.netRevenueEur ?? r.netEur),
                  },
                ]}
                rows={(dispatch as any).arbitrageOpportunities}
                status={() => 'ok'}
              />
            </OpsPanel>
          )}
        </div>
      )}

      {/* DRILL-DOWN TAB */}
      {activeTab === 'drilldown' && (
        <div className="space-y-3">
          {asset.externalAssetId ? (
            <RackDrilldown plantId={plantId} assetToken={asset.externalAssetId} />
          ) : (
            <OpsPanel label="Device drill-down">
              <EmptyState message="this asset carries no external id, so its devices cannot be addressed" />
            </OpsPanel>
          )}
        </div>
      )}

      {/* The pulse label used to read "BMS NOMINAL", which is a claim about a
          protection system this console is not connected to. It now names what
          the footer actually summarises. */}
      <OpsFooter
        pulseLabel="BATTERY ANALYTICS"
        pulseTone="info"
        metrics={[
          { label: 'SoC', value: fmt(socPct, 0), unit: '%' },
          { label: 'SoH', value: fmt(sohPct, 1), unit: '%' },
          ...(fin(cycling?.limits?.maxTemp) != null
            ? [
                {
                  // Observed peak, not a rating. It used to be painted warn
                  // unconditionally, so 27.5 °C inside a 15 to 35 °C
                  // contractual window read as a live thermal alert.
                  label: 'PEAK TEMP',
                  value: fmt(cycling.limits.maxTemp, 1),
                  unit: '°C',
                  valueColor:
                    wt?.operating_temp_max_c != null &&
                    fin(cycling.limits.maxTemp)! > wt.operating_temp_max_c
                      ? 'var(--ops-warn)'
                      : 'var(--ops-txt)',
                },
              ]
            : []),
          ...(fin(cycling?.averages?.temperature) != null
            ? [{ label: 'TEMP AVG', value: fmt(cycling.averages.temperature, 1), unit: '°C' }]
            : []),
          {
            label: 'LAST UPDATE',
            value:
              typeof asset.lastUpdated === 'string' && asset.lastUpdated.length >= 16
                ? asset.lastUpdated.slice(11, 16)
                : NO_VALUE,
            valueColor: 'var(--ops-txt)',
          },
        ]}
        buildTag="real API"
      />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      className="flex h-32 items-center justify-center px-4 text-center font-mono text-[11px] italic"
      style={{ color: 'var(--ops-muted)' }}
    >
      {message}
    </div>
  );
}

/** Euro amount, or the shared no-data marker. Never a substituted zero. */
export function eur(v: unknown): string {
  const n = fin(v);
  return n == null ? NO_VALUE : `€${n.toFixed(0)}`;
}

/**
 * "HH:MM to HH:MM" in UTC for an arbitrage window. UTC because the window
 * objects carry only instants, with no plant-local hour to read them in, and
 * a silently mislabelled local time is worse than an explicit UTC one.
 */
export function utcWindow(w: unknown): string | null {
  const win = w as { start?: string; end?: string } | null | undefined;
  if (!win?.start && !win?.end) return null;
  const hm = (iso?: string) => {
    if (!iso) return NO_VALUE;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NO_VALUE;
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  return `${hm(win.start)} to ${hm(win.end)}`;
}

/** Older flat fixture shape for an arbitrage row: plain start/end hours. */
export function legacyWindow(r: any): string {
  const start = fin(r?.startHour);
  const end = fin(r?.endHour);
  if (start == null && end == null) return NO_VALUE;
  return `${start == null ? NO_VALUE : `${start}h`} to ${end == null ? NO_VALUE : `${end}h`}`;
}

/**
 * Why the state-of-health projection could not be drawn. Naming the missing
 * input is the difference between a panel an operator can act on and one that
 * just says "unavailable".
 */
export function sohProjectionGap(
  history: SoHPointRaw[] | null,
  warrantyFloor: number | null,
  cycling: any,
): string {
  if (!history?.length) return 'no state of health measurements recorded for this battery yet';
  if (warrantyFloor == null) {
    return 'no capacity guarantee on file, so there is no floor to project a breach against';
  }
  if (!cycling) return 'no cycling record for this battery yet, so the fade rate cannot be anchored';
  return 'not enough state of health history to project a fade curve';
}
