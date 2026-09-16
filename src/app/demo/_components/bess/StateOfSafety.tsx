'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import OpsPanel from '@/components/ops/OpsPanel';
import HealthRing from '@/components/ops/charts/HealthRing';
import StatusLed, { type StatusTone } from '@/components/ops/StatusLed';
import { useBESSData } from '@/hooks/useBESSData';

/**
 * State of safety, as computed by nuravolt.bess.pipeline.
 *
 * This panel used to invent its own eight-indicator weighted average out of
 * whatever the warranty and cycling routes happened to return. It now renders
 * the published computation instead: four sub indices (thermal margin,
 * imbalance, dwell exposure, protection status), each 0 to 100 with its own
 * inputs and its own scoring method, combined WORST-OF.
 *
 * Worst-of, not a weighted sum, because safety does not average. Under a
 * weighted sum three healthy sub indices dilute one critical thermal margin
 * into a comfortable looking number, which is exactly the failure mode that
 * gets people hurt. The weakest sub index is the answer and the panel names it.
 *
 * A sub index with no data is rendered as unavailable with its reason. It is
 * never scored 100 for lack of evidence, never drawn as a zero bar, and never
 * counted in the worst-of. Where the missing input is rack grain the wording is
 * the canonical "Requires rack level telemetry, connect your BMS to enable"
 * from nuravolt/bess/imbalance.py.
 *
 * The disclosure is non negotiable and renders on every state of this panel,
 * including the empty ones. Cloud poll cadence is 5 to 15 minutes and thermal
 * runaway propagates in seconds to minutes; saying so is what separates an
 * honest trend indicator from a safety claim nobody can make.
 */

// ---------------------------------------------------------------------------
// Published payload contract
// ---------------------------------------------------------------------------
// Mirrors StateOfSafety.to_dict() in nuravolt/bess/thermal_monitor.py, wrapped
// in the per-device envelope that src/lib/alerts/evaluate.ts already reads off
// the `bess_state_of_safety` artifact. Types are declared locally rather than
// imported from evaluate.ts: that module pulls in prisma and must not reach a
// client bundle.

export type SafetyBand = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export interface SafetySubIndexPayload {
  name: string;
  score?: number | null;
  band?: string | null;
  available?: boolean;
  reason?: string | null;
  method?: string | null;
  inputs?: Record<string, unknown> | null;
}

export interface SafetyReadingPayload {
  asset_id?: string;
  device_id?: string;
  device_label?: string;
  score?: number | null;
  band?: string | null;
  limiting_index?: string | null;
  unavailable?: string[];
  sub_indices?: SafetySubIndexPayload[];
  rubric?: SafetyRubric | null;
  computed_at?: string | null;
}

export interface SafetyRubric {
  combination?: string;
  combination_rationale?: string;
  bands?: Record<string, string>;
  sub_indices?: Record<string, string>;
  unavailable_handling?: string;
}

export interface SafetyArtifactPayload {
  evaluated_at?: string;
  interval_minutes?: number | null;
  disclosure?: string;
  rubric?: SafetyRubric | null;
  readings?: SafetyReadingPayload[];
}

/** Same bands as nuravolt.bess.thermal_monitor.SAFETY_BANDS. */
export const SAFETY_BANDS: ReadonlyArray<readonly [number, SafetyBand]> = [
  [80, 'LOW'],
  [60, 'MODERATE'],
  [40, 'HIGH'],
];

/** Canonical sub index order, matching the pipeline's own list. */
export const SUB_INDEX_ORDER = [
  'thermal_margin',
  'imbalance',
  'dwell_exposure',
  'protection_status',
] as const;

/** Sub indices that can only be read from sub asset (rack) telemetry. */
const SUB_ASSET_INDICES = new Set(['imbalance']);

/** nuravolt/bess/imbalance.py SUB_ASSET_UNAVAILABLE, word for word. */
export const SUB_ASSET_UNAVAILABLE =
  'Requires rack level telemetry, connect your BMS to enable';

export function bandForScore(score: number | null | undefined): SafetyBand {
  if (score == null || !Number.isFinite(score)) return 'UNKNOWN';
  for (const [floor, label] of SAFETY_BANDS) {
    if (score >= floor) return label;
  }
  return 'CRITICAL';
}

export function bandTone(band: SafetyBand): StatusTone {
  if (band === 'LOW') return 'ok';
  if (band === 'MODERATE') return 'warn';
  if (band === 'HIGH' || band === 'CRITICAL') return 'alarm';
  return 'muted';
}

/**
 * The canonical disclosure, with the measured poll cadence filled in. Mirrors
 * safety_disclosure() in nuravolt/bess/thermal_monitor.py and
 * bessSafetyDisclosure() in src/lib/alerts/evaluate.ts word for word, so the
 * console, the alert email and the PDF report never paraphrase each other.
 */
export function safetyDisclosure(intervalMinutes?: number | null): string {
  const interval =
    intervalMinutes != null && Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? `${intervalMinutes} minute`
      : 'periodic';
  return (
    `State of safety is a trend and margin indicator computed from ${interval} ` +
    'cloud telemetry. It is not a protection system and must not be relied on ' +
    'for emergency response. Your BMS and fire detection system are.'
  );
}

/** "thermal_margin" to "Thermal margin". Sentence case, never shouted. */
export function subIndexLabel(name: string): string {
  const words = String(name ?? '').replace(/_/g, ' ').trim();
  if (!words) return 'Sub index';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What to tell an operator about a sub index that could not be scored.
 * The publisher's own reason wins; a rack grain index with no reason falls back
 * to the connect your BMS wording rather than inventing an explanation.
 */
export function unavailableMessage(sub: SafetySubIndexPayload): string {
  const reason = typeof sub.reason === 'string' ? sub.reason.trim() : '';
  if (reason) return reason;
  if (SUB_ASSET_INDICES.has(sub.name)) return SUB_ASSET_UNAVAILABLE;
  return 'No input channel connected for this sub index';
}

export function isScored(sub: SafetySubIndexPayload): boolean {
  return sub.available !== false && sub.score != null && Number.isFinite(sub.score);
}

// ---------------------------------------------------------------------------
// The imbalance sub index's own inputs
// ---------------------------------------------------------------------------
// imbalance_index() in nuravolt/bess/imbalance.py publishes the within rack view
// alongside the score: the worst ΔV and ΔT any rack reached, how many racks were
// read, and on what basis. Rendering the score without the basis is the specific
// misreading this block exists to prevent: with a BMS reporting two edges the
// member count is 2, and "2 members" on a rack of several hundred cells reads as
// a rack with two modules reporting rather than a complete, exact spread.

export interface ImbalanceSpreadSummary {
  /** Worst within rack voltage spread, in millivolts. Null where no rack could measure it. */
  worstVoltageMv: number | null;
  /** Worst within rack temperature spread, in degrees. */
  worstTemperatureC: number | null;
  rackCount: number | null;
  /** 'members' | 'extremes' | 'mixed', as published. */
  basis: string | null;
  racksReportingExtremes: number | null;
}

/**
 * A number, or null. Deliberately NOT `Number(value)`: `Number(null)` is 0 and
 * `Number('')` is 0, so the lazy version turns "this rack could not measure a
 * spread" into a measured zero spread, which is the strongest possible claim
 * from no evidence. A published null stays null all the way to the caption.
 */
function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The within rack spread inputs of an imbalance sub index, or null when the
 * publisher sent none. Reads the inputs whether or not the sub index scored: a
 * rack count and a basis are worth showing even when the score could not be
 * computed, and they are often the reason it could not.
 */
export function imbalanceSpreadSummary(
  sub: SafetySubIndexPayload | null | undefined,
): ImbalanceSpreadSummary | null {
  if (!sub || sub.name !== 'imbalance') return null;
  const inputs = sub.inputs;
  if (!inputs || typeof inputs !== 'object') return null;

  const worst = (inputs as any).worst_within_rack_spread;
  const volts = worst && typeof worst === 'object' ? finiteOrNull((worst as any).voltage) : null;
  const degrees =
    worst && typeof worst === 'object' ? finiteOrNull((worst as any).temperature) : null;

  const basisRaw = (inputs as any).spread_basis;
  const summary: ImbalanceSpreadSummary = {
    // Millivolts: a cell spread is single digit to low hundreds of mV, and the
    // conversion happens once, here, rather than in the renderer.
    worstVoltageMv: volts == null ? null : volts * 1000,
    worstTemperatureC: degrees,
    rackCount: finiteOrNull((inputs as any).rack_count),
    basis: typeof basisRaw === 'string' && basisRaw.trim() ? basisRaw.trim() : null,
    racksReportingExtremes: finiteOrNull((inputs as any).racks_reporting_extremes),
  };

  const hasAnything =
    summary.worstVoltageMv != null ||
    summary.worstTemperatureC != null ||
    summary.rackCount != null ||
    summary.basis != null;
  return hasAnything ? summary : null;
}

/**
 * What the spread was computed from, said plainly.
 *
 * "Spread from reported extremes" is the whole point of the sentence: it is an
 * exact ΔV from the two edges the BMS publishes, not a sample of two modules out
 * of many. Neither over claiming a census nor apologising for the basis.
 */
export function spreadBasisLabel(summary: ImbalanceSpreadSummary | null): string | null {
  const basis = summary?.basis;
  if (!basis) return null;
  if (basis === 'extremes') return 'spread from reported extremes';
  if (basis === 'members') return 'spread across reporting members';
  if (basis === 'mixed') {
    const n = summary?.racksReportingExtremes ?? null;
    return n != null && n > 0
      ? `spread from members and reported extremes, ${n} rack${n === 1 ? '' : 's'} on extremes`
      : 'spread from members and reported extremes';
  }
  return `spread basis ${basis}`;
}

/** The headline spread line, or null when nothing was published to say. */
export function imbalanceSpreadLine(summary: ImbalanceSpreadSummary | null): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.worstVoltageMv != null) {
    const mv = summary.worstVoltageMv;
    parts.push(`worst ΔV ${Math.abs(mv) < 10 ? mv.toFixed(1) : Math.round(mv)} mV`);
  }
  if (summary.worstTemperatureC != null) {
    parts.push(`worst ΔT ${summary.worstTemperatureC.toFixed(2)} °C`);
  }
  // A rack count of zero says nothing the sub index's own reason does not
  // already say ("Requires rack level telemetry, connect your BMS to enable"),
  // and "0 racks" printed as a figure reads like a measurement of a pack with no
  // racks in it. An asset with no rack feed gets the reason, not a number.
  if (summary.rackCount != null && summary.rackCount > 0) {
    parts.push(`${summary.rackCount} rack${summary.rackCount === 1 ? '' : 's'}`);
  }
  const basis = spreadBasisLabel(summary);
  if (basis) parts.push(basis);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface WorstOfResult {
  score: number | null;
  band: SafetyBand;
  limitingIndex: string | null;
  scored: SafetySubIndexPayload[];
  unavailable: SafetySubIndexPayload[];
}

/**
 * Worst-of over the sub indices that actually carried data.
 *
 * Two properties this has to keep, and that the tests pin:
 *   1. one critical sub index drives the composite even when every other sub
 *      index is perfect, and
 *   2. an unavailable sub index is excluded rather than treated as 100, so
 *      missing evidence can never raise the score.
 */
export function worstOf(subIndices: SafetySubIndexPayload[] | null | undefined): WorstOfResult {
  const all = Array.isArray(subIndices) ? subIndices : [];
  const scored = all.filter(isScored);
  const unavailable = all.filter((s) => !isScored(s));

  if (scored.length === 0) {
    return { score: null, band: 'UNKNOWN', limitingIndex: null, scored, unavailable };
  }

  let worst = scored[0];
  for (const sub of scored) {
    if ((sub.score as number) < (worst.score as number)) worst = sub;
  }
  const score = Math.round(worst.score as number);
  return {
    score,
    band: bandForScore(score),
    limitingIndex: worst.name ?? null,
    scored,
    unavailable,
  };
}

export interface ResolvedReading {
  reading: SafetyReadingPayload;
  /** 'asset' when the publisher wrote an asset grain row, else the worst device. */
  basis: 'asset' | 'worst-of-devices';
  deviceCount: number;
}

/** True for a device id at whole asset grain, e.g. "BESS athi-1". */
function isAssetGrain(deviceId: string | undefined): boolean {
  return typeof deviceId === 'string' && /^BESS [^.]+$/.test(deviceId.trim());
}

/**
 * Pick the row this panel should headline for one asset.
 *
 * Prefers the publisher's asset grain row. With only sub asset rows the
 * headline is the worst of them, which is the same worst-of rule one level up,
 * and the panel says so instead of implying the number covers the whole asset.
 */
export function resolveReading(
  payload: SafetyArtifactPayload | null | undefined,
  opts: { assetId?: string | null; assetToken?: string | null } = {},
): ResolvedReading | null {
  const rows = Array.isArray(payload?.readings) ? payload!.readings! : [];
  if (rows.length === 0) return null;

  const assetId = opts.assetId?.trim() || null;
  const token = opts.assetToken?.trim() || null;

  const mine = rows.filter((r) => {
    if (!assetId && !token) return true;
    if (assetId && r.asset_id === assetId) return true;
    if (token && typeof r.device_id === 'string') {
      const parsed = /^BESS ([^.]+)/.exec(r.device_id.trim());
      if (parsed && parsed[1] === token) return true;
    }
    return false;
  });
  if (mine.length === 0) return null;

  const assetRow = mine.find((r) => isAssetGrain(r.device_id));
  if (assetRow) return { reading: assetRow, basis: 'asset', deviceCount: mine.length };

  const scoredRows = mine.filter((r) => r.score != null && Number.isFinite(r.score));
  if (scoredRows.length === 0) {
    return { reading: mine[0], basis: 'worst-of-devices', deviceCount: mine.length };
  }
  let worst = scoredRows[0];
  for (const row of scoredRows) {
    if ((row.score as number) < (worst.score as number)) worst = row;
  }
  return { reading: worst, basis: 'worst-of-devices', deviceCount: mine.length };
}

export interface SafetyView {
  score: number | null;
  band: SafetyBand;
  limitingIndex: string | null;
  subIndices: SafetySubIndexPayload[];
  scoredCount: number;
  unavailable: SafetySubIndexPayload[];
  disclosure: string;
  rubric: SafetyRubric | null;
  deviceLabel: string | null;
  computedAt: string | null;
  /** True when the headline was derived here from the published sub indices. */
  derived: boolean;
}

/**
 * Everything the panel renders, from one published reading.
 *
 * When sub indices are published the headline is derived from them, so the
 * number at the top and the breakdown underneath can never contradict each
 * other. Only when the publisher sent a bare score (the alert envelope shape,
 * which carries no sub indices) is the published score used directly.
 */
export function safetyView(
  resolved: ResolvedReading | null,
  payload: SafetyArtifactPayload | null | undefined,
): SafetyView | null {
  if (!resolved) return null;
  const reading = resolved.reading;

  const published = Array.isArray(reading.sub_indices) ? reading.sub_indices : [];
  const ordered = [...published].sort(
    (a, b) =>
      (SUB_INDEX_ORDER.indexOf(a.name as any) + 1 || 99) -
      (SUB_INDEX_ORDER.indexOf(b.name as any) + 1 || 99),
  );

  const disclosure =
    typeof payload?.disclosure === 'string' && payload.disclosure.trim()
      ? payload.disclosure.trim()
      : safetyDisclosure(payload?.interval_minutes ?? null);

  if (ordered.length > 0) {
    const w = worstOf(ordered);
    return {
      score: w.score,
      band: w.band,
      limitingIndex: w.limitingIndex,
      subIndices: ordered,
      scoredCount: w.scored.length,
      unavailable: w.unavailable,
      disclosure,
      rubric: reading.rubric ?? payload?.rubric ?? null,
      deviceLabel: reading.device_label ?? reading.device_id ?? null,
      computedAt: reading.computed_at ?? payload?.evaluated_at ?? null,
      derived: true,
    };
  }

  const score =
    reading.score != null && Number.isFinite(reading.score) ? Math.round(reading.score) : null;
  return {
    score,
    band: (reading.band as SafetyBand) ?? bandForScore(score),
    limitingIndex: reading.limiting_index ?? null,
    subIndices: [],
    scoredCount: score == null ? 0 : 1,
    unavailable: (reading.unavailable ?? []).map((name) => ({ name, available: false })),
    disclosure,
    rubric: reading.rubric ?? payload?.rubric ?? null,
    deviceLabel: reading.device_label ?? reading.device_id ?? null,
    computedAt: reading.computed_at ?? payload?.evaluated_at ?? null,
    derived: false,
  };
}

/** A payload only counts as published state of safety if it carries readings. */
export function isSafetyPayload(body: unknown): body is SafetyArtifactPayload {
  return !!body && typeof body === 'object' && Array.isArray((body as any).readings);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BAND_LABEL: Record<SafetyBand, string> = {
  LOW: 'low risk',
  MODERATE: 'monitor',
  HIGH: 'attention',
  CRITICAL: 'urgent',
  UNKNOWN: 'not scored',
};

/** Chip colours. `muted` has no -bg/-border token in ops-theme, so it falls
 *  back to the panel chrome rather than rendering an invisible chip. */
function chipStyle(tone: StatusTone) {
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

export default function StateOfSafety({ plantId: plantIdProp }: { plantId?: string } = {}) {
  const params = useParams();
  const plantId = plantIdProp ?? (params?.plantId as string);
  const bess = useBESSData(plantId);

  const [payload, setPayload] = useState<SafetyArtifactPayload | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!plantId) return;
    let alive = true;
    setLoaded(false);

    // The published `bess_state_of_safety` artifact, in serving-route order.
    // Any body without a `readings` array counts as not published, which is
    // also how a route that does not exist yet reads. An unpublished asset gets
    // the enablement state below, never a number this console made up.
    const urls = [
      `/api/bess/plants/${plantId}/safety`,
      `/api/bess/plants/${plantId}/audit?file=safety`,
    ];

    (async () => {
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const body = await res.json();
          if (!alive) return;
          if (isSafetyPayload(body)) {
            setPayload(body);
            setLoaded(true);
            return;
          }
        } catch {
          // fall through to the next candidate
        }
      }
      if (alive) {
        setPayload(null);
        setLoaded(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, [plantId]);

  const asset = bess.selectedAsset;

  const view = useMemo(
    () =>
      safetyView(
        resolveReading(payload, {
          assetId: asset?.id ?? null,
          assetToken: asset?.externalAssetId ?? null,
        }),
        payload,
      ),
    [payload, asset],
  );

  const disclosure = view?.disclosure ?? safetyDisclosure(payload?.interval_minutes ?? null);

  if (!asset) {
    return (
      <OpsPanel
        label="State of safety"
        meta={<span style={{ color: 'var(--ops-muted)' }}>select an asset</span>}
      >
        <div
          className="flex h-24 items-center justify-center text-[12px] italic"
          style={{ color: 'var(--ops-muted)' }}
        >
          Waiting for a battery asset.
        </div>
        <Disclosure text={disclosure} />
      </OpsPanel>
    );
  }

  // Not published yet. An empty panel with a clear enablement message beats a
  // populated panel pretending a modelled number was measured.
  if (loaded && !view) {
    return (
      <OpsPanel
        label="State of safety"
        meta={<span style={{ color: 'var(--ops-muted)' }}>not published</span>}
      >
        <div className="py-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--ops-txt)' }}>
          State of safety has not been published for this asset.
          <div className="mt-1 text-[12px]" style={{ color: 'var(--ops-muted)' }}>
            It is computed by the BESS pipeline from connected telemetry: pack
            temperature and rate of change, rack level spread, time outside the
            safe operating envelope, and HVAC and alarm status. Connect a
            telemetry source to enable it.
          </div>
        </div>
        <Disclosure text={disclosure} />
      </OpsPanel>
    );
  }

  if (!loaded || !view) {
    return (
      <OpsPanel label="State of safety">
        <div
          className="flex h-24 items-center justify-center text-[12px] italic"
          style={{ color: 'var(--ops-muted)' }}
        >
          Reading published safety indices.
        </div>
        <Disclosure text={disclosure} />
      </OpsPanel>
    );
  }

  const tone = bandTone(view.band);
  const limitingLabel = view.limitingIndex ? subIndexLabel(view.limitingIndex) : null;

  return (
    <OpsPanel
      label="State of safety"
      meta={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span style={{ color: 'var(--ops-dim)' }}>
            {view.derived
              ? `worst of ${view.scoredCount} of ${view.subIndices.length} sub indices`
              : 'published composite'}
          </span>
          <span
            className="rounded-sm border px-1.5 py-px text-[10px] uppercase tracking-wider"
            style={chipStyle(tone)}
          >
            {BAND_LABEL[view.band]}
          </span>
        </span>
      }
    >
      <div className="flex flex-col items-start gap-5 lg:flex-row lg:items-center">
        {view.score != null ? (
          <div className="shrink-0">
            <HealthRing score={view.score} tone={tone} subtitle="safety" size={100} />
            {limitingLabel && (
              <div
                className="mt-1 max-w-[112px] text-center text-[11px] leading-tight"
                style={{ color: 'var(--ops-muted)' }}
              >
                set by {limitingLabel.toLowerCase()}
              </div>
            )}
          </div>
        ) : (
          <div
            className="flex h-[100px] w-[100px] shrink-0 items-center justify-center rounded-full border text-center text-[11px] leading-tight"
            style={{ borderColor: 'var(--ops-hair)', color: 'var(--ops-muted)' }}
          >
            not scored
          </div>
        )}

        <div className="grid w-full flex-1 grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2">
          {view.subIndices.length > 0 ? (
            view.subIndices.map((sub) => (
              <SubIndexRow
                key={sub.name}
                sub={sub}
                limiting={sub.name === view.limitingIndex}
              />
            ))
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--ops-muted)' }}>
              The publisher sent a composite without its breakdown. Score{' '}
              {view.score ?? 'not available'}
              {limitingLabel ? `, set by ${limitingLabel.toLowerCase()}` : ''}.
            </div>
          )}
        </div>
      </div>

      {view.score == null && (
        <div className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--ops-muted)' }}>
          No sub index had data, so there is no composite. A missing sub index is
          never scored 100 for lack of evidence.
        </div>
      )}

      <Rubric rubric={view.rubric} />
      <Disclosure text={view.disclosure} />

      {(view.deviceLabel || view.computedAt) && (
        <div className="mt-2 text-[10.5px]" style={{ color: 'var(--ops-dim)' }}>
          {view.deviceLabel && <span className="font-mono">{view.deviceLabel}</span>}
          {view.deviceLabel && view.computedAt && (
            <span style={{ color: 'var(--ops-dim)' }}> · </span>
          )}
          {view.computedAt && (
            <span>
              computed <span className="font-mono">{view.computedAt.slice(0, 16).replace('T', ' ')}</span>
            </span>
          )}
        </div>
      )}
    </OpsPanel>
  );
}

function SubIndexRow({
  sub,
  limiting,
}: {
  sub: SafetySubIndexPayload;
  limiting: boolean;
}) {
  const scored = isScored(sub);
  const band = scored ? bandForScore(sub.score as number) : 'UNKNOWN';
  const tone = bandTone(band);
  const spreadLine = imbalanceSpreadLine(imbalanceSpreadSummary(sub));

  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ops-muted)' }}>
          <StatusLed tone={tone} size={6} /> {subIndexLabel(sub.name)}
          {limiting && (
            <span
              className="rounded-sm border px-1 py-px text-[9.5px] uppercase tracking-wide"
              style={{
                color: `var(--ops-${tone})`,
                borderColor: `var(--ops-${tone}-border)`,
              }}
            >
              drives the score
            </span>
          )}
        </span>
        <span className="ops-num font-mono" style={{ color: scored ? 'var(--ops-bright)' : 'var(--ops-dim)' }}>
          {scored ? `${Math.round(sub.score as number)}/100` : 'no data'}
        </span>
      </div>

      {/* No bar for an unavailable sub index. A zero-width bar reads as a
          measured zero, which is the opposite of "we cannot see this". */}
      {scored ? (
        <div className="h-1.5 overflow-hidden rounded" style={{ background: 'var(--ops-row-hair)' }}>
          <div
            className="h-full"
            style={{ width: `${Math.max(0, Math.min(100, sub.score as number))}%`, background: `var(--ops-${tone})` }}
          />
        </div>
      ) : (
        <div
          className="rounded border border-dashed px-1.5 py-1 text-[11px] leading-snug"
          style={{ borderColor: 'var(--ops-hair)', color: 'var(--ops-muted)' }}
        >
          {unavailableMessage(sub)}
        </div>
      )}

      {/* The within rack numbers behind an imbalance score. Rendered whether or
          not the sub index scored, because a rack count and a basis explain a
          missing score as often as they qualify a present one. */}
      {spreadLine && (
        <div className="mt-0.5 text-[10.5px] leading-snug" style={{ color: 'var(--ops-muted)' }}>
          {spreadLine}
        </div>
      )}

      {scored && sub.method && (
        <div className="mt-0.5 text-[10.5px] leading-snug" style={{ color: 'var(--ops-dim)' }}>
          {sub.method}
        </div>
      )}
    </div>
  );
}

/** The rubric, published the way the warranty health score publishes its own. */
function Rubric({ rubric }: { rubric: SafetyRubric | null }) {
  if (!rubric) return null;
  const bands = rubric.bands ?? {};
  const methods = rubric.sub_indices ?? {};

  return (
    <details
      className="mt-3 rounded-md border p-2.5 text-[11.5px] leading-relaxed"
      style={{
        background: 'var(--ops-panel-2)',
        borderColor: 'var(--ops-row-hair)',
        color: 'var(--ops-muted)',
      }}
    >
      <summary className="cursor-pointer" style={{ color: 'var(--ops-txt)' }}>
        How this is scored
      </summary>
      <div className="mt-2 space-y-2">
        {rubric.combination_rationale && <p>{rubric.combination_rationale}</p>}
        {Object.keys(bands).length > 0 && (
          <div>
            <div style={{ color: 'var(--ops-txt)' }}>Bands</div>
            <ul className="mt-0.5 space-y-0.5">
              {Object.entries(bands).map(([band, rule]) => (
                <li key={band} className="flex items-baseline justify-between gap-3">
                  <span>{band.toLowerCase()}</span>
                  <span className="font-mono" style={{ color: 'var(--ops-dim)' }}>
                    {rule}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {Object.keys(methods).length > 0 && (
          <div>
            <div style={{ color: 'var(--ops-txt)' }}>Sub indices</div>
            <ul className="mt-0.5 space-y-1">
              {Object.entries(methods).map(([name, method]) => (
                <li key={name}>
                  <span style={{ color: 'var(--ops-txt)' }}>{subIndexLabel(name)}. </span>
                  {method}
                </li>
              ))}
            </ul>
          </div>
        )}
        {rubric.unavailable_handling && <p>{rubric.unavailable_handling}</p>}
      </div>
    </details>
  );
}

/** Non negotiable. Renders on every state of this panel, including the empty ones. */
function Disclosure({ text }: { text: string }) {
  return (
    <div
      className="mt-3 rounded-md border p-2.5 text-[11.5px] leading-relaxed"
      style={{
        background: 'var(--ops-warn-bg)',
        borderColor: 'var(--ops-warn-border)',
        color: 'var(--ops-txt)',
      }}
    >
      {text}
    </div>
  );
}
