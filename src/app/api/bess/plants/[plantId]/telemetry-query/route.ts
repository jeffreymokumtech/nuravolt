import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { queryAnalysisResults, resolvePlantId, type AnalysisRow } from '@/lib/db/timeseries';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import {
  buildBessDeviceId,
  parseBessDeviceId,
  type BessDeviceGrain,
} from '@/lib/services/cloud-connector';

/**
 * GET /api/bess/plants/[plantId]/telemetry-query
 *
 * Per-device battery drill-down, the BESS counterpart of the PV twin's
 * ../digitaltwin/[plantId]/parquet-query route and deliberately the same
 * contract: query by device_id + metric + range, get back a series plus the
 * model_version that produced it so the UI can caption its provenance instead
 * of guessing.
 *
 * The rows come from `analysis_results` (domain='bess'), where
 * `nuravolt.lake.publish` lands the daily gold. Per-unit / per-rack / per-module
 * grain only exists there once the lake writes those device_ids; until then this
 * returns an honest empty series with the metric and device names that ARE
 * published, never a 500 and never fabricated points.
 *
 * Query params:
 *  - device_id (required) — canonical id, "BESS athi-1[.U-1[.R-2[.M-3[.C-4]]]]"
 *  - metric (required)    — gold metric name, e.g. "soc_avg", "throughput_mwh"
 *  - rollup               — "sum" to sum the immediate children of device_id
 *  - model_version        — pin a publish version (default: the newest present)
 *  - from / to = YYYY-MM-DD (default: last 30 days)
 */

export const dynamic = 'force-dynamic';

const DOMAIN = 'bess';

/**
 * Grain hierarchy, in order. The id convention itself lives in cloud-connector.ts.
 *
 * THE CELL BOUNDARY. `cell` is in this list because the parser resolves it and a
 * rollup has to know what a module's children are called. It is not a served
 * grain: there is no gold_bess_cell_daily, no per-cell metric in METRIC_UNITS
 * below, and no per-cell twin. Cell grain is addressable and deliberately
 * unbuilt, because ΔV = Vcell_max - Vcell_min is computable exactly from the two
 * extremes an OEM cloud actually publishes, at roughly 0.6% of the data volume
 * of a per-cell census. Per-cell buys culprit localisation, not detection. The
 * whole decision, including the parts of the evidence that are weak, is
 * docs/BESS_GRAIN_POLICY.md; it is pinned by tests/bess/test_grain_boundary.py.
 * A cell-grain request therefore returns an honest empty series, never a 404 and
 * never a fabricated point.
 */
const GRAIN_ORDER: BessDeviceGrain[] = ['asset', 'unit', 'rack', 'module', 'cell'];

/**
 * Unit per gold metric name. analysis_results carries no unit column, so this
 * is a static contract with the publisher (nuravolt/pipeline/bess_measured.py
 * holds the matching metric-name table for asset grain, and
 * dbt_project/models/gold/gold_bess_rack_daily.sql emits the rack-grain names).
 * An unknown metric returns a null unit rather than a guessed one.
 *
 * KNOWN UNIT INCONSISTENCY, DOCUMENTED RATHER THAN PAPERED OVER.
 * Rack-grain state of charge is a PERCENTAGE (`soc_mean_pct`, 0 to 100, straight
 * off the silver percent SoC that rack_samples.py converts to a fraction for its
 * own maths), while asset-grain state of charge is a FRACTION (`soc_avg`, 0 to
 * 1, the spelling FIELD_ALIASES has published since before the rack tables
 * existed). Two gold tables, two conventions, and this table is the only place
 * the difference is visible to a reader. Both entries stay, each with its true
 * unit. Silently coercing one into the other here would move the inconsistency
 * somewhere nobody is looking, and a chart axis labelled "fraction" over values
 * of 84 is how a reader learns to distrust the whole panel. Fixing it belongs in
 * the gold models, as one deliberate rename with a backfill, not in a serving
 * route's unit lookup.
 */
const METRIC_UNITS: Record<string, string> = {
  energy_charged_mwh: 'MWh',
  charge_energy_mwh: 'MWh',
  energy_discharged_mwh: 'MWh',
  discharge_energy_mwh: 'MWh',
  throughput_mwh: 'MWh',
  energy_throughput_mwh: 'MWh',
  energy_charged_kwh: 'kWh',
  charge_energy_kwh: 'kWh',
  energy_discharged_kwh: 'kWh',
  discharge_energy_kwh: 'kWh',
  throughput_kwh: 'kWh',
  equivalent_full_cycles: 'cycles',
  efc: 'cycles',
  round_trip_efficiency: 'fraction',
  rte: 'fraction',
  soc_avg: 'fraction',
  soc_max: 'fraction',
  soc_min: 'fraction',
  avg_soc: 'fraction',
  max_soc: 'fraction',
  min_soc: 'fraction',
  dod_avg: 'fraction',
  avg_dod: 'fraction',
  soh: 'fraction',
  state_of_health: 'fraction',
  temperature_avg_c: 'degC',
  temperature_max_c: 'degC',
  temperature_min_c: 'degC',
  temp_avg_c: 'degC',
  temp_max_c: 'degC',
  temp_min_c: 'degC',
  avg_temp_c: 'degC',
  max_temp_c: 'degC',
  min_temp_c: 'degC',
  c_rate_avg: 'C',
  c_rate_max: 'C',
  avg_c_rate: 'C',
  max_c_rate: 'C',
  soc_high_dwell_hours: 'h',
  soc_low_dwell_hours: 'h',
  temp_high_dwell_hours: 'h',
  high_soc_hours: 'h',
  low_soc_hours: 'h',
  high_temp_hours: 'h',
  availability_pct: '%',

  // -------------------------------------------------------------------------
  // Rack grain, from gold_bess_rack_daily.sql. This is the product tier: ΔV and
  // ΔT per rack are the primary imbalance indicators, and both are computable
  // from the two extremes an OEM cloud publishes.
  // -------------------------------------------------------------------------

  // ΔT. `*_spread_max/p95/mean` are the instantaneous spread of
  // nuravolt/bess/imbalance.py SPREAD_DEFINITION (max minus min across a rack's
  // members AT ONE INSTANT), aggregated over the day. `*_spread_envelope` is the
  // day envelope, a different question under a name that says so: on a rack
  // whose extremes never coincide the envelope over reads, measured at 4.5 C
  // against 0.5 C instantaneous on the parity fixture. The bare `temp_spread_c`
  // spelling is gone on purpose and is not re-added here.
  temp_cell_max_c: 'degC',
  temp_cell_min_c: 'degC',
  temp_spread_max_c: 'degC',
  temp_spread_p95_c: 'degC',
  temp_spread_mean_c: 'degC',
  temp_spread_envelope_c: 'degC',

  // ΔV, the primary imbalance indicator. Same instantaneous-versus-envelope
  // split as ΔT. voltage_pack_max_v is the series string, not a cell: it is kept
  // apart from the cell voltages rather than folded in, exactly as
  // rack_samples.py refuses to fold bess_voltage_pack into cell voltage.
  voltage_cell_max_v: 'V',
  voltage_cell_min_v: 'V',
  voltage_pack_max_v: 'V',
  voltage_spread_max_v: 'V',
  voltage_spread_p95_v: 'V',
  voltage_spread_mean_v: 'V',
  voltage_spread_envelope_v: 'V',

  // Rack-grain SoC, in percent. See the inconsistency note above: the
  // asset-grain `soc_avg` entry a few lines up is a fraction.
  // soc_divergence_from_sibling_median_pct is this rack minus the median of its
  // SIBLING racks (exclude-self, so a diverging rack cannot drag its own
  // reference), signed, at the instant of largest absolute divergence.
  soc_mean_pct: '%',
  soc_max_pct: '%',
  soc_min_pct: '%',
  soc_divergence_from_sibling_median_pct: '%',

  // Sample counts. `*_spread_instants` is how many instants carried at least two
  // members, so a p95 computed over three points is legible as such instead of
  // reading like a p95 over a day. Zero instants means the spread columns are
  // null: silence, not a zero spread.
  temp_spread_instants: 'count',
  voltage_spread_instants: 'count',
  hours_observed: 'h',
  devices: 'count',
  samples: 'count',

  // Deliberately absent: `spread_basis`. It is a label ('members', 'extremes',
  // 'mixed'), not a measurement, so it has no unit and is not published as a
  // metric row. It travels on the publish metadata stamp
  // (nuravolt/lake/publish.py --basis) and is rendered from the safety artifact.

  // LEGACY, DELETE WITH THE UI ALIASES ONE RELEASE ON. These two names are NOT
  // emitted by gold_bess_rack_daily.sql any more and must not be re-added to it:
  // they carried the DAY ENVELOPE under the instantaneous spread's name, which
  // over reads by up to a factor of nine (4.5 C against 0.5 C on the parity
  // fixture). They are here only so a plant still holding rows from the previous
  // publish gets a labelled axis instead of an unlabelled one while the UI's
  // trailing aliases still resolve them. The drill-down captions any series it
  // draws from these names as the envelope, so the number is never presented as
  // the spread.
  voltage_spread_v: 'V',
  temp_spread_c: 'degC',
};

/**
 * Immediate children of a canonical BESS device id, one grain down.
 *
 * Mirrors childStringIds() in the PV drill-down, with one deliberate
 * difference: PV assumes a fixed strings-per-MPPT count, while a battery's
 * racks-per-unit and modules-per-rack vary by product, so the children are
 * discovered from the device ids actually published and then rebuilt through
 * buildBessDeviceId. The grain convention is never re-derived here; both
 * helpers are imported from src/lib/services/cloud-connector.ts.
 *
 * Not exported: an App Router route module may only export its handlers and the
 * route config, so this stays local exactly as childStringIds does.
 */
function childBessDeviceIds(parentId: string, candidates: string[]): string[] {
  const parent = parseBessDeviceId(parentId);
  if (!parent) return [];

  const depth = GRAIN_ORDER.indexOf(parent.grain);
  if (depth < 0 || depth >= GRAIN_ORDER.length - 1) return [];
  const childGrain = GRAIN_ORDER[depth + 1];

  const out = new Set<string>();
  for (const candidate of candidates) {
    const child = parseBessDeviceId(candidate);
    if (!child || child.grain !== childGrain) continue;
    if (child.asset !== parent.asset) continue;
    if (parent.unit !== undefined && child.unit !== parent.unit) continue;
    if (parent.rack !== undefined && child.rack !== parent.rack) continue;
    if (parent.module !== undefined && child.module !== parent.module) continue;
    out.add(
      buildBessDeviceId({
        asset: child.asset,
        unit: child.unit,
        rack: child.rack,
        module: child.module,
        cell: child.cell,
      }),
    );
  }
  return [...out].sort();
}

/** Distinct BESS device ids published for this plant. */
async function publishedDeviceIds(plantUuid: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ device_id: string | null }[]>(
    `SELECT DISTINCT device_id FROM analysis_results
     WHERE plant_id = $1::uuid AND domain = $2 AND device_id IS NOT NULL
     LIMIT 500`,
    plantUuid,
    DOMAIN,
  );
  return rows.map((r) => r.device_id!).filter(Boolean).sort();
}

/** Distinct metric names published for one device. The diagnostic that turns a
 *  metric-name mismatch from a silent empty chart into one readable line. */
async function publishedMetrics(plantUuid: string, deviceId: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ metric: string }[]>(
    `SELECT DISTINCT metric FROM analysis_results
     WHERE plant_id = $1::uuid AND domain = $2 AND device_id = $3
     LIMIT 200`,
    plantUuid,
    DOMAIN,
    deviceId,
  );
  return rows.map((r) => r.metric).sort();
}

/** The asset's telemetry regime, so the UI can caption a mixed asset honestly. */
async function telemetryRegime(plantUuid: string) {
  const asset = await prisma.bessAsset.findFirst({
    where: { plant_id: plantUuid },
    select: { metadata: true },
  });
  const block = (asset?.metadata as any)?.telemetry;
  if (!block || typeof block !== 'object') return null;
  return {
    mode: (block.mode as string) ?? null,
    firstMeasuredDate: (block.first_measured_date as string) ?? null,
    source: (block.source as string) ?? null,
  };
}

export async function GET(request: NextRequest, { params }: { params: { plantId: string } }) {
  const { plantId } = params;
  const { searchParams } = new URL(request.url);

  const deviceId = searchParams.get('device_id');
  const metric = searchParams.get('metric');
  const rollup = searchParams.get('rollup');
  const pinnedVersion = searchParams.get('model_version');

  if (!deviceId) {
    return NextResponse.json({ error: 'device_id is required', series: [] }, { status: 400 });
  }
  if (!metric) {
    return NextResponse.json({ error: 'metric is required', series: [] }, { status: 400 });
  }
  const parsed = parseBessDeviceId(deviceId);
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          'device_id must be a canonical battery id, for example "BESS athi-1" or "BESS athi-1.U-1.R-2"',
        series: [],
      },
      { status: 400 },
    );
  }

  const toDate = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date();
  const fromDate = searchParams.get('from')
    ? new Date(searchParams.get('from')!)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }

    const plantUuid = await resolvePlantId(plantId);
    if (!plantUuid) {
      return NextResponse.json({ error: 'Plant not found', series: [] }, { status: 404 });
    }

    // Which device ids to read. `rollup=sum` sums the immediate children, the
    // battery equivalent of summing an MPPT's strings.
    let deviceIds = [deviceId];
    if (rollup === 'sum') {
      const published = await publishedDeviceIds(plantUuid);
      deviceIds = childBessDeviceIds(deviceId, published);
      if (deviceIds.length === 0) {
        return NextResponse.json({
          plantId,
          deviceId,
          metric,
          grain: parsed.grain,
          unit: METRIC_UNITS[metric] ?? null,
          period: {
            from: fromDate.toISOString().split('T')[0],
            to: toDate.toISOString().split('T')[0],
          },
          series: [],
          count: 0,
          modelVersion: null,
          provenance: null,
          telemetry: await telemetryRegime(plantUuid),
          availableDevices: published,
          _source: 'empty',
        });
      }
    }

    // Read analysis_results directly, with `resolution` left UNSET on purpose.
    // Two reasons, both of which have bitten before:
    //  1. `analysis_daily` is a continuous aggregate with
    //     end_offset => INTERVAL '1 day', so today is never visible in it. A
    //     drill-down that silently stops a day short looks like missing data.
    //  2. The published gold is already daily grain, so there is nothing left
    //     to aggregate; bucketing it again would only add a lag.
    // Do not "helpfully" add resolution: 'daily' here.
    const rows: AnalysisRow[] = [];
    for (const id of deviceIds) {
      const deviceRows = (await queryAnalysisResults({
        plantId: plantUuid,
        domain: DOMAIN,
        metrics: [metric],
        deviceId: id,
        from: fromDate,
        to: toDate,
        limit: 5000,
      })) as AnalysisRow[];
      rows.push(...deviceRows);
    }

    // One publish version at a time: a plant can carry rows from an older
    // publish alongside the current one, and averaging across them would be a
    // chart of two different models. Newest wins unless the caller pins one.
    const modelVersion =
      pinnedVersion ??
      rows
        .slice()
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0]?.model_version ??
      null;
    const kept = rows.filter((r) => (r.model_version ?? null) === modelVersion);

    const byDate = new Map<string, number>();
    for (const row of kept) {
      const date = new Date(row.time).toISOString().split('T')[0];
      const value = Number(row.value);
      if (!Number.isFinite(value)) continue;
      byDate.set(date, (byDate.get(date) ?? 0) + value);
    }
    const series = [...byDate.entries()]
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Provenance as published, never inferred. The lake writer tags each row;
    // an untagged row reports null and the UI falls back to the model version.
    const newestKept = kept
      .slice()
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0];
    const provenance = (newestKept?.metadata as any)?.provenance ?? null;

    return NextResponse.json({
      plantId,
      deviceId,
      metric,
      grain: parsed.grain,
      unit: METRIC_UNITS[metric] ?? null,
      rollup: rollup === 'sum' ? { mode: 'sum', devices: deviceIds } : null,
      period: {
        from: fromDate.toISOString().split('T')[0],
        to: toDate.toISOString().split('T')[0],
      },
      series,
      count: series.length,
      modelVersion,
      provenance,
      telemetry: await telemetryRegime(plantUuid),
      // Only on an empty result, and only then: what IS published for this
      // device, so a metric-name mismatch is one line to read instead of a
      // day of digging through the publisher.
      ...(series.length === 0
        ? {
            availableMetrics: await publishedMetrics(plantUuid, deviceIds[0]),
            availableDevices: await publishedDeviceIds(plantUuid),
          }
        : {}),
      _source: series.length > 0 ? 'database' : 'empty',
    });
  } catch (error) {
    console.error('bess telemetry-query failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch battery telemetry', series: [] },
      { status: 500 },
    );
  }
}
