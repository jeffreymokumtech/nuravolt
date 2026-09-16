'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OpsPanel from '@/components/ops/OpsPanel';
import OpsLineChart from '@/components/ops/charts/OpsLineChart';
import {
  buildBessDeviceId,
  parseBessDeviceId,
  type BessDeviceGrain,
} from '@/lib/services/cloud-connector';

/**
 * Per device battery drill-down over
 * /api/bess/plants/[plantId]/telemetry-query.
 *
 * Walks the canonical hierarchy asset > unit > rack > module using
 * parseBessDeviceId / buildBessDeviceId from src/lib/services/cloud-connector.ts.
 * The id convention is never re-derived here, exactly as the serving route
 * imports it rather than keeping its own regex.
 *
 * Rack grain leads. ΔV and ΔT per rack are the product tier, not a fallback for
 * plants without per-cell data: the two extremes an OEM cloud publishes give the
 * spread exactly, and per-cell buys culprit localisation rather than detection
 * (docs/BESS_GRAIN_POLICY.md). So the metric list opens on the voltage spread,
 * a rack carries a ΔV / ΔT headline strip, and the panel is named for racks.
 *
 * Three honesty rules, two inherited from the PV drill-down:
 *   - the model version that produced the rows is echoed into the caption, so a
 *     reader can tell a measured publish from a modelled one without asking, and
 *     a modelled publish additionally gets a persistent banner;
 *   - an empty series renders an empty state naming what IS published for the
 *     device, never a fabricated line;
 *   - the ΔV context bands are never printed without the sentence saying they
 *     come from a laboratory study and are not a limit on this asset.
 */

// ---------------------------------------------------------------------------
// Serving contract
// ---------------------------------------------------------------------------

export interface TelemetryQueryResponse {
  plantId?: string;
  deviceId?: string;
  metric?: string;
  grain?: BessDeviceGrain;
  unit?: string | null;
  rollup?: { mode: string; devices: string[] } | null;
  period?: { from: string; to: string };
  series?: Array<{ date: string; value: number }>;
  count?: number;
  modelVersion?: string | null;
  provenance?: string | null;
  telemetry?: { mode: string | null; firstMeasuredDate: string | null; source: string | null } | null;
  availableMetrics?: string[];
  availableDevices?: string[];
  _source?: string;
  error?: string;
}

/** Grain hierarchy, in order. Same list the serving route walks. */
const GRAIN_ORDER: BessDeviceGrain[] = ['asset', 'unit', 'rack', 'module', 'cell'];

export interface MetricChoice {
  key: string;
  label: string;
  /** Published spellings, most preferred first. */
  names: readonly string[];
  /** Grains this metric is actually published at. */
  grains: readonly BessDeviceGrain[];
}

/**
 * Metrics worth drilling into, each with its published alias spellings. The
 * aliases exist because the same quantity gets published under a couple of
 * names and a metric-name mismatch is the classic way a lake to serving seam
 * silently produces nothing.
 *
 * RACK GRAIN LEADS, AND THAT IS THE PRODUCT, NOT A FALLBACK.
 * ΔV = Vcell_max - Vcell_min is the primary early indicator of a developing
 * cell fault, and the two extremes an OEM cloud actually publishes give that
 * spread EXACTLY rather than approximately, at roughly 0.6% of the data volume
 * of a per-cell census (docs/BESS_GRAIN_POLICY.md). So ΔV and ΔT sit at the top
 * of this list and the asset-grain energy metrics follow them, which is the
 * reverse of the order this panel shipped with.
 *
 * The spread names come from gold_bess_rack_daily.sql and mean the
 * instantaneous spread of nuravolt/bess/imbalance.py SPREAD_DEFINITION,
 * aggregated over the day. The bare `voltage_spread_v` / `temp_spread_c`
 * spellings are the same quantity's OLD name, kept here only as trailing
 * aliases so a plant still carrying rows from the previous publish keeps
 * drawing; the alias retry in load() picks them up. Drop them one release on.
 */
// Cell extremes and their spreads are published at EVERY grain, not only at
// rack: a publisher that emits racks also rolls them up, taking the max across
// children because a spread does not average. So the worst ΔV in a unit, or in
// the whole asset, is a real published number and belongs in the picker there.
//
// Restricting them to 'rack' had a compounding failure. The asset view opened on
// an asset-family metric the rack publisher never emits, drew "no max
// temperature published", and then the child probe, which asks for the SAME
// metric, found no children and reported "requires unit level telemetry" about
// an asset whose two units were sitting right there in the table.
const SPREAD_GRAINS: readonly BessDeviceGrain[] = ['asset', 'unit', 'rack', 'module'];

export const METRIC_CHOICES: ReadonlyArray<MetricChoice> = [
  {
    key: 'voltage_spread',
    label: 'Cell voltage spread',
    names: ['voltage_spread_max_v', 'voltage_spread_v'],
    grains: SPREAD_GRAINS,
  },
  {
    key: 'temp_spread',
    label: 'Cell temperature spread',
    names: ['temp_spread_max_c', 'temp_spread_c'],
    grains: SPREAD_GRAINS,
  },
  { key: 'max_cell_voltage', label: 'Max cell voltage', names: ['voltage_cell_max_v'], grains: SPREAD_GRAINS },
  { key: 'min_cell_voltage', label: 'Min cell voltage', names: ['voltage_cell_min_v'], grains: SPREAD_GRAINS },
  { key: 'max_cell_temp', label: 'Max cell temperature', names: ['temp_cell_max_c'], grains: SPREAD_GRAINS },
  {
    key: 'soc_divergence',
    label: 'SoC divergence from siblings',
    names: ['soc_divergence_from_sibling_median_pct'],
    grains: SPREAD_GRAINS,
  },
  {
    key: 'max_temp',
    label: 'Max temperature',
    names: ['temperature_max_c', 'temp_max_c', 'max_temp_c'],
    grains: ['asset'],
  },
  {
    key: 'avg_temp',
    label: 'Average temperature',
    names: ['temperature_avg_c', 'temp_avg_c', 'avg_temp_c'],
    grains: ['asset'],
  },
  { key: 'avg_soc', label: 'Average state of charge', names: ['soc_avg', 'avg_soc'], grains: ['asset'] },
  {
    key: 'throughput',
    label: 'Throughput',
    names: ['throughput_mwh', 'energy_throughput_mwh', 'throughput_kwh'],
    grains: ['asset'],
  },
  { key: 'cycles', label: 'Equivalent full cycles', names: ['equivalent_full_cycles', 'efc'], grains: ['asset'] },
  { key: 'rte', label: 'Round trip efficiency', names: ['round_trip_efficiency', 'rte'], grains: ['asset'] },
];

/** The two headline spreads, by key, so the strip and the picker cannot drift. */
export const VOLTAGE_SPREAD_KEY = 'voltage_spread';
export const TEMP_SPREAD_KEY = 'temp_spread';

/**
 * The old spread spellings, and what replaced them.
 *
 * Keeping the aliases keeps a chart drawing across the rename, but the two are
 * not the same quantity: the old columns held the DAY ENVELOPE (max over all
 * members and all times minus min over all of them), which on a rack whose
 * extremes never coincide is systematically larger than the instantaneous
 * spread, measured at 4.5 C against 0.5 C for one rack-day on the parity
 * fixture. So a series drawn from a legacy name is captioned as the envelope
 * rather than presented as ΔV. Delete this map with the aliases.
 */
export const LEGACY_SPREAD_NAMES: Readonly<Record<string, string>> = {
  voltage_spread_v: 'voltage_spread_max_v',
  temp_spread_c: 'temp_spread_max_c',
};

/** Caption for a series served under a legacy spread name, or null. */
export function legacySpreadNote(metric: string | null | undefined): string | null {
  const name = typeof metric === 'string' ? metric.trim() : '';
  const replacement = LEGACY_SPREAD_NAMES[name];
  if (!replacement) return null;
  return (
    `Drawn from the legacy ${name} publish. That column carried the day envelope ` +
    'rather than the instantaneous spread, so it reads high: 4.5 °C against 0.5 °C ' +
    `for one rack day on the parity fixture. Re-publish the rack gold to get ${replacement}.`
  );
}

/**
 * Which published grain's vocabulary a device reads in.
 *
 * Only two gold tables exist: gold_bess_asset_daily and gold_bess_rack_daily. A
 * unit has no table of its own and reads in the asset vocabulary (state of
 * charge, throughput, cycles). A module reads in the rack vocabulary, one level
 * down. A cell reads in the rack vocabulary too, because a rack's ΔV is built
 * from exactly the quantity a cell reports; cell grain is addressable and
 * deliberately unbuilt (docs/BESS_GRAIN_POLICY.md), so it lands on a metric that
 * renders the honest empty state rather than on one that cannot exist at all.
 */
const GRAIN_METRIC_FAMILY: Record<BessDeviceGrain, BessDeviceGrain> = {
  asset: 'asset',
  unit: 'asset',
  rack: 'rack',
  module: 'rack',
  cell: 'rack',
};

/**
 * The metric to open on for a grain.
 *
 * Without this the panel opens on METRIC_CHOICES[0], which is now a rack-only
 * metric, so the root would paint an empty state on first load and read as a
 * broken panel. Pure and exported so the test can pin every grain.
 */
export function defaultMetricFor(grain: BessDeviceGrain | null | undefined): string {
  const family = (grain && GRAIN_METRIC_FAMILY[grain]) || 'asset';
  const hit = METRIC_CHOICES.find((m) => m.grains.includes(family));
  return (hit ?? METRIC_CHOICES[0]).key;
}

/**
 * Which spelling of a metric to ask for. Prefers the first alias, and switches
 * to whichever alias the device actually publishes once the route has told us.
 * Returns null when none of the aliases is published, which the caller renders
 * as an empty state rather than an empty chart.
 */
export function resolveMetricName(
  preferred: readonly string[],
  available: readonly string[] | null | undefined,
): string | null {
  if (!preferred.length) return null;
  const have = new Set(available ?? []);
  if (have.size === 0) return preferred[0];
  for (const name of preferred) {
    if (have.has(name)) return name;
  }
  return null;
}

/** Human label for one node, keyed on its deepest addressed level. */
export function deviceLabel(deviceId: string): string {
  const parsed = parseBessDeviceId(deviceId);
  if (!parsed) return deviceId;
  if (parsed.grain === 'cell') return `Cell ${parsed.cell}`;
  if (parsed.grain === 'module') return `Module ${parsed.module}`;
  if (parsed.grain === 'rack') return `Rack ${parsed.rack}`;
  if (parsed.grain === 'unit') return `Unit ${parsed.unit}`;
  return parsed.asset;
}

/** The grain one level below this device, or null at the bottom. */
export function childGrain(deviceId: string): BessDeviceGrain | null {
  const parsed = parseBessDeviceId(deviceId);
  if (!parsed) return null;
  const depth = GRAIN_ORDER.indexOf(parsed.grain);
  if (depth < 0 || depth >= GRAIN_ORDER.length - 1) return null;
  return GRAIN_ORDER[depth + 1];
}

/**
 * Ancestors of a device, root first, including the device itself.
 * Rebuilt through buildBessDeviceId so a breadcrumb link can never address a
 * device id this codebase would not otherwise emit.
 */
export function ancestryOf(deviceId: string): Array<{ id: string; label: string }> {
  const parsed = parseBessDeviceId(deviceId);
  if (!parsed) return [];

  type LevelParts = { unit?: number; rack?: number; module?: number; cell?: number };
  const levels: LevelParts[] = [{}];
  if (parsed.unit !== undefined) levels.push({ unit: parsed.unit });
  if (parsed.rack !== undefined) levels.push({ unit: parsed.unit, rack: parsed.rack });
  if (parsed.module !== undefined) {
    levels.push({ unit: parsed.unit, rack: parsed.rack, module: parsed.module });
  }
  if (parsed.cell !== undefined) {
    levels.push({
      unit: parsed.unit,
      rack: parsed.rack,
      module: parsed.module,
      cell: parsed.cell,
    });
  }

  return levels.map((parts) => {
    const id = buildBessDeviceId({ asset: parsed.asset, ...parts });
    return { id, label: deviceLabel(id) };
  });
}

/** Children the route reported for this node, from the rollup probe. */
export function childrenFromResponse(res: TelemetryQueryResponse | null): string[] {
  const devices = res?.rollup?.devices;
  return Array.isArray(devices) ? [...devices].sort() : [];
}

/** True when `candidate` sits strictly below `parent` in the canonical id tree. */
function isDescendantOf(candidate: string, parentId: string): boolean {
  const parent = parseBessDeviceId(parentId);
  const child = parseBessDeviceId(candidate);
  if (!parent || !child) return false;
  if (child.asset !== parent.asset) return false;
  if (GRAIN_ORDER.indexOf(child.grain) <= GRAIN_ORDER.indexOf(parent.grain)) return false;
  if (parent.unit !== undefined && child.unit !== parent.unit) return false;
  if (parent.rack !== undefined && child.rack !== parent.rack) return false;
  if (parent.module !== undefined && child.module !== parent.module) return false;
  return true;
}

/**
 * The nearest published generation below a node, skipping empty ones.
 *
 * Without this the console has a dead end at exactly the tier it is built for.
 * A lake that publishes gold_bess_asset_daily and gold_bess_rack_daily and
 * nothing in between (which is every lake today, because no unit table exists)
 * leaves an asset whose immediate children are units, none of which are
 * published, so the panel reports "requires unit level telemetry" and the racks
 * sitting one level further down are unreachable. Offering the nearest generation
 * that IS published is not a guess: every id here came back from the route's own
 * list of published devices.
 *
 * Returns null when nothing below this node is published, which stays the
 * enablement message rather than becoming an empty list.
 */
export function nearestPublishedDescendants(
  parentId: string | null,
  published: readonly string[],
): { grain: BessDeviceGrain; ids: string[] } | null {
  if (!parentId) return null;
  const parent = parseBessDeviceId(parentId);
  if (!parent) return null;

  const byGrain = new Map<BessDeviceGrain, Set<string>>();
  for (const candidate of published) {
    if (!isDescendantOf(candidate, parentId)) continue;
    const grain = parseBessDeviceId(candidate)!.grain;
    if (!byGrain.has(grain)) byGrain.set(grain, new Set());
    byGrain.get(grain)!.add(candidate);
  }

  const start = GRAIN_ORDER.indexOf(parent.grain) + 1;
  for (let i = start; i < GRAIN_ORDER.length; i += 1) {
    const found = byGrain.get(GRAIN_ORDER[i]);
    if (found && found.size > 0) {
      return { grain: GRAIN_ORDER[i], ids: [...found].sort() };
    }
  }
  return null;
}

/** Plural label for a grain, for the "one level down" heading. */
export function grainGroupLabel(grain: BessDeviceGrain): string {
  if (grain === 'unit') return 'Units';
  if (grain === 'rack') return 'Racks';
  if (grain === 'module') return 'Modules';
  if (grain === 'cell') return 'Cells';
  return 'Devices';
}

/**
 * Provenance caption for a drill-down series, keyed on the publish model
 * version, exactly as twinProvenanceNote does for the PV MPPT drill-down.
 * The model version is always echoed: an unrecognised one still tells the
 * reader which publish they are looking at.
 */
export function bessProvenanceNote(
  modelVersion: string | null | undefined,
  provenance?: string | null,
): string | null {
  const mv = typeof modelVersion === 'string' ? modelVersion.trim() : '';
  if (!mv) return null;

  const source = typeof provenance === 'string' ? provenance.trim() : '';
  let basis = '';
  if (source === 'measured') {
    basis = 'Measured telemetry published to the lake.';
  } else if (source === 'modelled' || mv.startsWith('modelled')) {
    basis = 'Modelled dispatch twin, not measured hardware behaviour.';
  } else if (source) {
    basis = `Published as ${source}.`;
  }

  return `${basis ? `${basis} ` : ''}Model version ${mv}.`;
}

/**
 * The ΔV context caption, verbatim and in one place.
 *
 * Bands get quoted back at you. The moment a number like 0.05 V is printed next
 * to a live reading it starts being read as a limit, so the sentence that says
 * where it came from and what it is not travels with it, on the same surface, in
 * the same block. Five cells in a laboratory is not this asset and is not a
 * warranty term.
 */
export const SPREAD_CONTEXT_CAPTION =
  'Context bands (0.05 / 0.08 / 0.1 V) are from a published five-cell laboratory ' +
  'module study, not from this asset and not a NuraVolt limit. Treat them as ' +
  'literature context for a healthy plateau, not as an alarm threshold.';

/** The same three bands in the unit the strip renders. A conversion, not a new claim. */
export const SPREAD_CONTEXT_BANDS_MV = '50 / 80 / 100 mV';

/** Banner text for rack channels that came out of the dispatch twin. */
export const MODELLED_RACK_BANNER =
  'Rack channels on this device are derived from the dispatch twin, not measured hardware.';

/**
 * Whether this publish is modelled, and so whether the banner shows.
 *
 * A footnote is the wrong shape for this. A reader who takes a screenshot of a
 * ΔV trend takes the chart, not the caption under it, and a modelled ΔV is a
 * shape the twin drew rather than a spread any hardware reported. So it renders
 * as a persistent banner above the chart. Prefix matching on `modelled` rather
 * than exactly `modelled-` on purpose: over warning costs a line of chrome,
 * under warning costs the claim.
 */
export function isModelledRackPublish(
  modelVersion: string | null | undefined,
  provenance?: string | null,
): boolean {
  const source = typeof provenance === 'string' ? provenance.trim().toLowerCase() : '';
  if (source === 'modelled') return true;
  const mv = typeof modelVersion === 'string' ? modelVersion.trim().toLowerCase() : '';
  return mv.startsWith('modelled');
}

export interface LatestPoint {
  date: string;
  value: number;
  unit: string | null;
  /** The metric name the route actually served, which may be a legacy alias. */
  metric: string | null;
}

/** The newest published point of a series, or null. Never the first point, and
 *  never a zero standing in for an absent one. */
export function latestPoint(res: TelemetryQueryResponse | null | undefined): LatestPoint | null {
  const points = Array.isArray(res?.series) ? res!.series! : [];
  let best: { date: string; value: number } | null = null;
  for (const p of points) {
    if (!p || typeof p.date !== 'string') continue;
    const value = Number(p.value);
    if (!Number.isFinite(value)) continue;
    if (!best || p.date > best.date) best = { date: p.date, value };
  }
  return best ? { ...best, unit: res?.unit ?? null, metric: res?.metric ?? null } : null;
}

/**
 * A spread, in the unit an operator reads it in. Millivolts for ΔV, because a
 * cell spread is single digit to low hundreds of millivolts and "0.042 V" is a
 * decimal place too far to scan. Degrees for ΔT, unchanged.
 */
export function formatSpread(point: LatestPoint | null): string {
  if (!point) return 'no data';
  if (point.unit === 'V') {
    const mv = point.value * 1000;
    return `${Math.abs(mv) < 10 ? mv.toFixed(1) : Math.round(mv)} mV`;
  }
  if (point.unit === 'degC') return `${point.value.toFixed(2)} °C`;
  return `${point.value.toFixed(2)}${point.unit ? ` ${point.unit}` : ''}`;
}

/** Regime caption for a mixed asset, so a split history is described, not blanket labelled. */
export function telemetryRegimeNote(
  telemetry: TelemetryQueryResponse['telemetry'],
): string | null {
  const mode = telemetry?.mode?.trim().toLowerCase();
  if (!mode) return null;
  const source = telemetry?.source?.trim();
  const from = telemetry?.firstMeasuredDate?.slice(0, 10);
  if (mode === 'measured') {
    return `Measured telemetry${source ? ` from ${source}` : ''}.`;
  }
  if (mode === 'mixed' && from) {
    return `Measured${source ? ` from ${source}` : ''} from ${from}, modelled before that date.`;
  }
  if (mode === 'modelled') {
    return 'Modelled twin, no telemetry connection on this asset.';
  }
  return null;
}

/**
 * Where a read has got to. Three outcomes, never two.
 *
 * THE BUG THIS TYPE EXISTS TO KILL. The panel used to hold one nullable
 * response and render "no cell voltage spread published for this device" plus
 * "nothing is published at this grain yet" whenever it was null. Null meant two
 * completely different things: nobody has asked yet, and we asked and the lake
 * has nothing. On ribera the asset-grain read takes several seconds (the child
 * probe walks every published device id, and React strict mode fires the effect
 * twice so the duplicate probe queues behind the first on the browser's cache
 * lock), and for that whole window the panel stated, in the content area, that
 * telemetry which does exist does not. The word "loading" in the corner does not
 * retract a sentence printed in the middle of the panel.
 *
 * A read failure is the third state and is NOT the same claim either. A 403 from
 * the billing gate or a 500 from the route used to be swallowed into the same
 * "nothing is published" sentence, which tells an operator to go connect a
 * telemetry source they already have connected.
 */
export type DrilldownStatus = 'reading' | 'ready' | 'error';

/**
 * What the chart area renders. Pure so the test can pin the one rule that
 * matters: a read in flight, or a read that failed, never renders the empty
 * state, because the empty state is a claim about the lake and neither of those
 * is evidence about the lake.
 */
export function seriesViewState(
  status: DrilldownStatus,
  pointCount: number,
): 'reading' | 'error' | 'chart' | 'empty' {
  if (status === 'reading') return 'reading';
  if (status === 'error') return 'error';
  return pointCount >= 2 ? 'chart' : 'empty';
}

/** Copy for a read in flight. Says what is happening, claims nothing. */
export const READING_SERIES_COPY = 'Reading published telemetry for this device.';

/** Copy for the descendants block while the child probe is still out. */
export const READING_DEVICES_COPY = 'Reading the devices published below this one.';

/** Headline for a failed read. */
export const READ_FAILED_COPY = 'Could not read telemetry for this device.';

/**
 * The sentence that keeps a failure from being read as an absence. Without it
 * an operator treats a route outage as a missing publish and goes looking in
 * the lake for rows that are sitting there.
 */
export const READ_FAILED_DISTINCTION_COPY =
  'This is a failed read, not a statement about what is published. Retry before ' +
  'concluding anything about the data.';

/** Copy for the descendants block when the probe that lists them failed. */
export const READ_FAILED_DEVICES_COPY =
  'The device list could not be read, so what sits below this one is unknown.';

/**
 * One readable line for whatever came back out of a failed read.
 *
 * The route's own `error` field wins when it sent one, because "Failed to fetch
 * battery telemetry" from the handler is more use than "500". A rejected fetch
 * carries a browser string that means nothing to an operator, so it is replaced.
 */
export function telemetryErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const detail = raw.trim();
  // Anchored on purpose. The route's own wording starts "Failed to fetch
  // battery telemetry", and swallowing that into the generic line would throw
  // away the only sentence that says which read failed.
  if (!detail || /^(failed to fetch|load failed|networkerror\b.*)$/i.test(detail)) {
    return 'The telemetry service could not be reached.';
  }
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface RackDrilldownProps {
  plantId: string;
  /** Asset token used in canonical device ids, e.g. BessAsset.externalAssetId. */
  assetToken: string;
  /** Optional starting node; defaults to the whole asset. */
  initialDeviceId?: string;
}

export default function RackDrilldown({
  plantId,
  assetToken,
  initialDeviceId,
}: RackDrilldownProps) {
  const rootId = useMemo(() => {
    try {
      return buildBessDeviceId({ asset: assetToken });
    } catch {
      return null;
    }
  }, [assetToken]);

  const startId = initialDeviceId ?? rootId;
  const startGrain = startId ? parseBessDeviceId(startId)?.grain ?? null : null;

  const [deviceId, setDeviceId] = useState<string | null>(startId);
  const [metricKey, setMetricKey] = useState<string>(() => defaultMetricFor(startGrain));
  const [series, setSeries] = useState<TelemetryQueryResponse | null>(null);
  const [headline, setHeadline] = useState<{
    voltage: LatestPoint | null;
    temperature: LatestPoint | null;
  } | null>(null);
  const [children, setChildren] = useState<string[]>([]);
  const [publishedDevices, setPublishedDevices] = useState<string[]>([]);
  // Starts at 'reading', not 'ready': the effect fires on mount, so the very
  // first frame is already a read in flight and must not claim an absence.
  const [status, setStatus] = useState<DrilldownStatus>('reading');
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setDeviceId(initialDeviceId ?? rootId);
  }, [initialDeviceId, rootId]);

  const grain = deviceId ? parseBessDeviceId(deviceId)?.grain ?? null : null;
  const family: BessDeviceGrain = (grain && GRAIN_METRIC_FAMILY[grain]) || 'asset';

  // Metrics offered at this grain. Moving between grains changes the vocabulary,
  // not just the node: ΔV is not published at asset grain and throughput is not
  // published at rack grain, so offering the whole list everywhere would invite a
  // reader to pick a metric that cannot exist here and then read the resulting
  // empty state as broken data.
  const offered = useMemo(() => METRIC_CHOICES.filter((m) => m.grains.includes(family)), [family]);

  // The user's last pick survives a walk down and back up: it is only overridden
  // while they are at a grain that does not publish it, and derived rather than
  // written back into state so nothing has to stay in sync.
  const picked = METRIC_CHOICES.find((m) => m.key === metricKey);
  const choice =
    picked && picked.grains.includes(family)
      ? picked
      : METRIC_CHOICES.find((m) => m.key === defaultMetricFor(grain)) ?? METRIC_CHOICES[0];

  // Request sequence guard: drilling two levels quickly fires overlapping
  // reads, and a slow response for the level you already left must not paint
  // over the level you are on.
  const seqRef = useRef(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!plantId || !deviceId) return;
      const seq = ++seqRef.current;
      const current = () => seqRef.current === seq && !signal.aborted;

      // Everything on screen describes the previous device and the previous
      // metric, and none of it is true of this read. A stale line under a fresh
      // label is a worse answer than no line at all, so the panel goes back to
      // saying it is reading rather than carrying the old answer forward.
      setStatus('reading');
      setFailure(null);
      setSeries(null);
      setHeadline(null);
      setChildren([]);
      setPublishedDevices([]);

      const base = `/api/bess/plants/${plantId}/telemetry-query`;
      const q = (params: Record<string, string>) =>
        `${base}?${new URLSearchParams(params).toString()}`;

      // A non-ok response is a FAILED READ and is thrown, never folded into a
      // null the render then prints as "nothing is published". A 403 from the
      // billing gate and an empty lake are opposite facts about a device.
      const read = async (params: Record<string, string>): Promise<TelemetryQueryResponse> => {
        const r = await fetch(q(params), { signal });
        if (!r.ok) {
          let detail = '';
          try {
            detail = String(((await r.json()) as TelemetryQueryResponse)?.error ?? '');
          } catch {
            detail = '';
          }
          throw new Error(detail || `The telemetry service answered ${r.status}.`);
        }
        return (await r.json()) as TelemetryQueryResponse;
      };

      // First pass with the preferred spelling; the route names what it has when
      // the series is empty, so a second pass can ask for the right alias. This
      // is also what carries the old `voltage_spread_v` / `temp_spread_c`
      // spellings for a plant still holding rows from the previous publish.
      const fetchSeries = async (names: readonly string[]): Promise<TelemetryQueryResponse> => {
        const res = await read({ device_id: deviceId, metric: names[0] });
        if ((res.series?.length ?? 0) === 0 && res.availableMetrics?.length) {
          const alias = resolveMetricName(names, res.availableMetrics);
          if (alias && alias !== names[0]) {
            return read({ device_id: deviceId, metric: alias });
          }
        }
        return res;
      };

      try {
        // The child probe and the series are independent reads, so they are
        // issued together. They used to run one after the other, which doubled
        // the window in which the panel claimed the data did not exist.
        //
        // The probe is rollup=sum: it reports the immediate children it summed,
        // and on a node with none it hands back the device ids that ARE
        // published, so a naming mismatch is one line to read.
        const [probe, res] = await Promise.all([
          read({ device_id: deviceId, metric: choice.names[0], rollup: 'sum' }),
          fetchSeries(choice.names),
        ]);

        // The ΔV / ΔT headline, at rack grain only, because that is the only
        // grain the spreads are published at. Read alongside whatever metric is
        // on the chart so the two indicators that matter are on screen even
        // while the reader is looking at something else. Reuses the series
        // already fetched when the chart happens to be showing one of them.
        let head: { voltage: LatestPoint | null; temperature: LatestPoint | null } | null = null;
        if (grain === 'rack') {
          const vChoice = METRIC_CHOICES.find((m) => m.key === VOLTAGE_SPREAD_KEY)!;
          const tChoice = METRIC_CHOICES.find((m) => m.key === TEMP_SPREAD_KEY)!;
          const [vRes, tRes] = await Promise.all([
            choice.key === VOLTAGE_SPREAD_KEY ? Promise.resolve(res) : fetchSeries(vChoice.names),
            choice.key === TEMP_SPREAD_KEY ? Promise.resolve(res) : fetchSeries(tChoice.names),
          ]);
          head = { voltage: latestPoint(vRes), temperature: latestPoint(tRes) };
        }

        // One commit, at the end, so the panel never shows a chart from this
        // read beside a device list from the last one.
        if (!current()) return;
        setChildren(childrenFromResponse(probe));
        const published = res.availableDevices ?? probe.availableDevices;
        if (Array.isArray(published)) setPublishedDevices(published);
        setSeries(res);
        setHeadline(head);
        setStatus('ready');
      } catch (err) {
        // A superseded or aborted read is not a failure, and must not paint an
        // error over the level the reader has already moved on to.
        if (!current()) return;
        setFailure(telemetryErrorMessage(err));
        setStatus('error');
      }
    },
    [plantId, deviceId, grain, choice],
  );

  useEffect(() => {
    // Aborting the superseded read is what stops strict mode's duplicate probe,
    // and a fast walk down the tree, from queueing behind a request whose answer
    // is already stale: both are the same URL, and a browser serialises
    // concurrent identical GETs on its cache lock, so the duplicate was costing
    // a full extra round trip of "nothing is published".
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!rootId) {
    return (
      <OpsPanel label="Rack drill-down">
        <div className="py-6 text-center text-[12px]" style={{ color: 'var(--ops-muted)' }}>
          This asset has no canonical device id, so its telemetry cannot be
          addressed per device.
        </div>
      </OpsPanel>
    );
  }

  const trail = deviceId ? ancestryOf(deviceId) : [];
  const nextGrain = deviceId ? childGrain(deviceId) : null;
  const points = series?.series ?? [];
  const view = seriesViewState(status, points.length);
  const note = bessProvenanceNote(series?.modelVersion, series?.provenance);
  const regime = telemetryRegimeNote(series?.telemetry);
  const unit = series?.unit ?? '';
  const modelled = isModelledRackPublish(series?.modelVersion, series?.provenance);
  const legacy = legacySpreadNote(series?.metric);
  // The rollup probe's immediate children are authoritative when it found any;
  // otherwise fall through to the nearest generation the plant actually publishes.
  const descendants =
    children.length > 0 && nextGrain
      ? { grain: nextGrain, ids: children }
      : nearestPublishedDescendants(deviceId, publishedDevices);

  return (
    <OpsPanel
      label="Rack drill-down"
      subtitle="Cell voltage and temperature spread per rack"
      meta={
        <span className="inline-flex flex-wrap items-center gap-2">
          {series?.period && (
            <span className="font-mono">
              {series.period.from} to {series.period.to}
            </span>
          )}
          {status === 'reading' && <span style={{ color: 'var(--ops-dim)' }}>reading</span>}
        </span>
      }
    >
      {/* A modelled publish gets a banner, not a footnote: a reader who
          screenshots a ΔV trend takes the chart and leaves the caption behind. */}
      {modelled && (
        <div
          className="mb-2 rounded-md border px-2.5 py-1.5 text-[11.5px] leading-relaxed"
          style={{
            background: 'var(--ops-warn-bg)',
            borderColor: 'var(--ops-warn-border)',
            color: 'var(--ops-txt)',
          }}
        >
          {MODELLED_RACK_BANNER}
        </div>
      )}

      {/* Breadcrumb, rebuilt through buildBessDeviceId at every level. */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px]">
        {trail.map((node, i) => (
          <span key={node.id} className="inline-flex items-center gap-1.5">
            {i > 0 && <span style={{ color: 'var(--ops-dim)' }}>/</span>}
            {node.id === deviceId ? (
              <span style={{ color: 'var(--ops-txt)' }}>{node.label}</span>
            ) : (
              <button
                type="button"
                onClick={() => setDeviceId(node.id)}
                className="underline underline-offset-2"
                style={{ color: 'var(--ops-info)' }}
              >
                {node.label}
              </button>
            )}
          </span>
        ))}
      </div>

      {/* ΔV and ΔT headline, rack grain only. These are the two indicators the
          tier exists for, so they stay on screen whatever the chart is showing. */}
      {grain === 'rack' && headline && (
        <SpreadHeadline voltage={headline.voltage} temperature={headline.temperature} />
      )}

      {/* Metric picker, filtered to what this grain publishes. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {offered.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMetricKey(m.key)}
            className="rounded-sm border px-1.5 py-0.5 text-[11px]"
            style={{
              color: m.key === choice.key ? 'var(--ops-bright)' : 'var(--ops-muted)',
              borderColor: m.key === choice.key ? 'var(--ops-bess)' : 'var(--ops-hair)',
              background: m.key === choice.key ? 'var(--ops-panel-2)' : 'transparent',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Four outcomes, and the difference between them is the whole point.
          A read in flight and a read that failed are NOT evidence about what the
          lake holds, so neither of them is allowed to render the empty state. */}
      {view === 'chart' ? (
        <OpsLineChart
          series={[
            {
              key: choice.key,
              label: choice.label,
              tone: 'bess',
              values: points.map((p) => p.value),
              format: (v: number) => `${v.toFixed(2)}${unit ? ` ${unit}` : ''}`,
            },
          ]}
          xLabels={
            points.length > 6
              ? points
                  .filter((_, i) => i % Math.ceil(points.length / 6) === 0)
                  .map((p) => p.date.slice(5))
              : points.map((p) => p.date.slice(5))
          }
          xTooltipLabels={points.map((p) => p.date)}
        />
      ) : view === 'reading' ? (
        <ReadingSeries deviceId={deviceId} />
      ) : view === 'error' ? (
        <FailedSeries deviceId={deviceId} detail={failure} />
      ) : (
        <EmptySeries
          deviceId={deviceId}
          metricLabel={choice.label}
          pointCount={points.length}
          availableMetrics={series?.availableMetrics ?? []}
          publishedDevices={publishedDevices}
        />
      )}

      {/* Provenance caption. Always echoes the model version that produced the
          rows, the same contract as the PV MPPT drill-down. */}
      {(note || regime || legacy) && (
        <div className="mt-2 space-y-0.5 text-[11px]" style={{ color: 'var(--ops-muted)' }}>
          {note && <div>{note}</div>}
          {regime && <div>{regime}</div>}
          {legacy && <div style={{ color: 'var(--ops-warn)' }}>{legacy}</div>}
        </div>
      )}

      {/* One level down, or the nearest generation that is actually published.
          The immediate children win when they exist; when the intermediate grain
          is empty the racks are still reachable rather than sitting behind a
          "requires unit level telemetry" message they will never satisfy. */}
      {nextGrain && (
        <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--ops-row-hair)' }}>
          <div className="mb-1.5 text-[12px]" style={{ color: 'var(--ops-txt)' }}>
            {grainGroupLabel(descendants ? descendants.grain : nextGrain)}
          </div>
          {status === 'reading' ? (
            // The enablement message is a claim that this plant has no telemetry
            // at that grain. Before the probe answers, that claim has no basis.
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--ops-muted)' }}>
              {READING_DEVICES_COPY}
            </div>
          ) : status === 'error' ? (
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--ops-warn)' }}>
              {READ_FAILED_DEVICES_COPY}
            </div>
          ) : descendants ? (
            <>
              {descendants.grain !== nextGrain && (
                <div
                  className="mb-1.5 text-[11px] leading-relaxed"
                  style={{ color: 'var(--ops-muted)' }}
                >
                  Nothing is published at {nextGrain} grain for this asset, so the{' '}
                  {descendants.grain}s below it are listed directly.
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {descendants.ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setDeviceId(id)}
                    className="rounded-sm border px-1.5 py-0.5 text-[11px]"
                    style={{
                      color: 'var(--ops-txt)',
                      borderColor: 'var(--ops-hair)',
                      background: 'var(--ops-panel-2)',
                    }}
                  >
                    {deviceLabel(id)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--ops-muted)' }}>
              Requires {nextGrain} level telemetry, connect your BMS to enable.
            </div>
          )}
        </div>
      )}
    </OpsPanel>
  );
}

/**
 * The two headline spreads for one rack, with the literature caption they are
 * never printed without.
 *
 * No colour scale and no band highlighting on the values on purpose. Colouring a
 * ΔV against 0.05 V would turn a five-cell laboratory figure into this asset's
 * alarm threshold in one design decision, which is exactly what the caption says
 * not to do. An absent spread reads "no data", never zero: a zero spread is a
 * claim of a perfectly balanced rack from no evidence at all.
 */
function SpreadHeadline({
  voltage,
  temperature,
}: {
  voltage: LatestPoint | null;
  temperature: LatestPoint | null;
}) {
  const asOf = voltage?.date ?? temperature?.date ?? null;
  const legacy = legacySpreadNote(voltage?.metric) ?? legacySpreadNote(temperature?.metric);

  return (
    <div
      className="mb-3 rounded-md border p-2.5"
      style={{ background: 'var(--ops-panel-2)', borderColor: 'var(--ops-row-hair)' }}
    >
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
        <div>
          <div className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>
            ΔV, cell voltage spread
          </div>
          <div
            className="ops-num font-mono text-[19px] leading-tight"
            style={{ color: voltage ? 'var(--ops-bright)' : 'var(--ops-dim)' }}
          >
            {formatSpread(voltage)}
          </div>
          <div className="text-[10.5px]" style={{ color: 'var(--ops-dim)' }}>
            context {SPREAD_CONTEXT_BANDS_MV}
          </div>
        </div>

        <div>
          <div className="text-[11px]" style={{ color: 'var(--ops-muted)' }}>
            ΔT, cell temperature spread
          </div>
          <div
            className="ops-num font-mono text-[19px] leading-tight"
            style={{ color: temperature ? 'var(--ops-bright)' : 'var(--ops-dim)' }}
          >
            {formatSpread(temperature)}
          </div>
          {asOf && (
            <div className="text-[10.5px]" style={{ color: 'var(--ops-dim)' }}>
              as of <span className="font-mono">{asOf}</span>
            </div>
          )}
        </div>
      </div>

      {legacy && (
        <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--ops-warn)' }}>
          {legacy}
        </div>
      )}

      <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--ops-muted)' }}>
        {SPREAD_CONTEXT_CAPTION}
      </div>
    </div>
  );
}

/**
 * A read in flight. Occupies the chart's slot so the panel does not jump, and
 * says only what is true: we are reading. It names no metric and lists nothing,
 * because at this point nothing is known about either.
 */
function ReadingSeries({ deviceId }: { deviceId: string | null }) {
  return (
    <div
      className="rounded-md border border-dashed px-3 py-6 text-center"
      style={{ borderColor: 'var(--ops-hair)' }}
    >
      <div className="text-[12.5px]" style={{ color: 'var(--ops-muted)' }}>
        {READING_SERIES_COPY}
      </div>
      {deviceId && (
        <div className="mt-1 font-mono text-[11px]" style={{ color: 'var(--ops-dim)' }}>
          {deviceId}
        </div>
      )}
    </div>
  );
}

/**
 * A failed read, rendered as a failure.
 *
 * This is a different panel from EmptySeries on purpose, and the two must never
 * converge. "Nothing is published" sends an operator to their telemetry
 * connection; "the read failed" sends them to retry. Printing the first when
 * the second happened costs an afternoon.
 */
function FailedSeries({ deviceId, detail }: { deviceId: string | null; detail: string | null }) {
  return (
    <div
      className="rounded-md border px-3 py-5 text-center"
      style={{ borderColor: 'var(--ops-warn-border)', background: 'var(--ops-warn-bg)' }}
    >
      <div className="text-[12.5px]" style={{ color: 'var(--ops-txt)' }}>
        {READ_FAILED_COPY}
      </div>
      {detail && (
        <div className="mt-1 text-[11.5px]" style={{ color: 'var(--ops-txt)' }}>
          {detail}
        </div>
      )}
      {deviceId && (
        <div className="mt-1 font-mono text-[11px]" style={{ color: 'var(--ops-dim)' }}>
          {deviceId}
        </div>
      )}
      <div
        className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed"
        style={{ color: 'var(--ops-muted)' }}
      >
        {READ_FAILED_DISTINCTION_COPY}
      </div>
    </div>
  );
}

function EmptySeries({
  deviceId,
  metricLabel,
  pointCount,
  availableMetrics,
  publishedDevices,
}: {
  deviceId: string | null;
  metricLabel: string;
  pointCount: number;
  availableMetrics: string[];
  publishedDevices: string[];
}) {
  return (
    <div
      className="rounded-md border border-dashed px-3 py-6 text-center"
      style={{ borderColor: 'var(--ops-hair)' }}
    >
      <div className="text-[12.5px]" style={{ color: 'var(--ops-txt)' }}>
        {pointCount === 1
          ? `Only one published point for ${metricLabel} on this device, not enough to draw a trend.`
          : `No ${metricLabel.toLowerCase()} published for this device.`}
      </div>
      {deviceId && (
        <div className="mt-1 font-mono text-[11px]" style={{ color: 'var(--ops-dim)' }}>
          {deviceId}
        </div>
      )}
      {availableMetrics.length > 0 && (
        <div className="mt-2 text-[11.5px]" style={{ color: 'var(--ops-muted)' }}>
          Published for this device:{' '}
          <span className="font-mono">{availableMetrics.join(', ')}</span>
        </div>
      )}
      {availableMetrics.length === 0 && publishedDevices.length > 0 && (
        <div className="mt-2 text-[11.5px]" style={{ color: 'var(--ops-muted)' }}>
          Published devices on this plant:{' '}
          <span className="font-mono">{publishedDevices.slice(0, 8).join(', ')}</span>
          {publishedDevices.length > 8 && <span> and {publishedDevices.length - 8} more</span>}
        </div>
      )}
      {availableMetrics.length === 0 && publishedDevices.length === 0 && (
        <div className="mt-2 text-[11.5px]" style={{ color: 'var(--ops-muted)' }}>
          Nothing is published at this grain yet. Connect a telemetry source to
          enable per device drill-down.
        </div>
      )}
    </div>
  );
}
