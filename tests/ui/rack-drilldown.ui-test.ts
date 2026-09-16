/**
 * Rack drill-down logic.
 *
 * What is worth pinning here:
 *   - an empty series stays an empty state, never a fabricated line;
 *   - the provenance caption echoes the model version that produced the rows,
 *     the same contract the PV MPPT drill-down keeps, and a modelled publish
 *     additionally raises a banner;
 *   - ΔV leads the metric list, because rack grain is the product tier rather
 *     than a fallback, and every grain opens on a metric that grain publishes;
 *   - the ΔV context bands never appear without the sentence that says they are
 *     laboratory literature and not a limit on this asset.
 *
 * The imbalance spread block at the bottom exercises helpers that live in
 * StateOfSafety.tsx. It is here rather than in state-of-safety.ui-test.ts only
 * because both surfaces render the same rack spread contract and that file was
 * being edited elsewhere in this arc; moving it is a tidy-up, not a fix.
 *
 * Run: npx vitest run --config tests/ui/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import {
  METRIC_CHOICES,
  MODELLED_RACK_BANNER,
  READ_FAILED_COPY,
  READ_FAILED_DEVICES_COPY,
  READ_FAILED_DISTINCTION_COPY,
  READING_DEVICES_COPY,
  READING_SERIES_COPY,
  SPREAD_CONTEXT_CAPTION,
  TEMP_SPREAD_KEY,
  VOLTAGE_SPREAD_KEY,
  ancestryOf,
  bessProvenanceNote,
  childGrain,
  childrenFromResponse,
  defaultMetricFor,
  deviceLabel,
  formatSpread,
  isModelledRackPublish,
  latestPoint,
  legacySpreadNote,
  nearestPublishedDescendants,
  resolveMetricName,
  seriesViewState,
  telemetryErrorMessage,
  telemetryRegimeNote,
  type TelemetryQueryResponse,
} from '@/app/demo/_components/bess/RackDrilldown';
import {
  imbalanceSpreadLine,
  imbalanceSpreadSummary,
  spreadBasisLabel,
  type ImbalanceSpreadSummary,
} from '@/app/demo/_components/bess/StateOfSafety';
import type { BessDeviceGrain } from '@/lib/services/cloud-connector';

describe('hierarchy walk', () => {
  it('labels each grain by the level it addresses', () => {
    expect(deviceLabel('BESS athi-1')).toBe('athi-1');
    expect(deviceLabel('BESS athi-1.U-1')).toBe('Unit 1');
    expect(deviceLabel('BESS athi-1.U-1.R-2')).toBe('Rack 2');
    expect(deviceLabel('BESS athi-1.U-1.R-2.M-3')).toBe('Module 3');
    expect(deviceLabel('BESS athi-1.U-1.R-2.M-3.C-4')).toBe('Cell 4');
  });

  it('leaves an id it cannot parse untouched rather than guessing', () => {
    expect(deviceLabel('INV 01.032')).toBe('INV 01.032');
  });

  it('reports the next grain down, and nothing below a cell', () => {
    expect(childGrain('BESS athi-1')).toBe('unit');
    expect(childGrain('BESS athi-1.U-1')).toBe('rack');
    expect(childGrain('BESS athi-1.U-1.R-2')).toBe('module');
    expect(childGrain('BESS athi-1.U-1.R-2.M-3')).toBe('cell');
    expect(childGrain('BESS athi-1.U-1.R-2.M-3.C-4')).toBeNull();
  });

  it('rebuilds every ancestor through the canonical id builder', () => {
    expect(ancestryOf('BESS athi-1.U-1.R-2.M-3').map((n) => n.id)).toEqual([
      'BESS athi-1',
      'BESS athi-1.U-1',
      'BESS athi-1.U-1.R-2',
      'BESS athi-1.U-1.R-2.M-3',
    ]);
    expect(ancestryOf('BESS athi-1').map((n) => n.label)).toEqual(['athi-1']);
    expect(ancestryOf('not a battery id')).toEqual([]);
  });
});

describe('childrenFromResponse', () => {
  it('reads the children the rollup actually summed', () => {
    const res: TelemetryQueryResponse = {
      rollup: { mode: 'sum', devices: ['BESS a.U-1.R-2', 'BESS a.U-1.R-1'] },
    };
    expect(childrenFromResponse(res)).toEqual(['BESS a.U-1.R-1', 'BESS a.U-1.R-2']);
  });

  it('reports no children rather than inventing them', () => {
    expect(childrenFromResponse({ series: [], rollup: null })).toEqual([]);
    expect(childrenFromResponse(null)).toEqual([]);
  });
});

describe('nearestPublishedDescendants', () => {
  // Every lake today publishes gold_bess_asset_daily and gold_bess_rack_daily
  // and nothing between them, so an asset's immediate children (units) are
  // empty while its racks exist. Walking only to the immediate child grain
  // leaves the product tier unreachable behind an enablement message.
  const published = [
    'BESS ribera.U-1.R-1',
    'BESS ribera.U-1.R-2',
    'BESS ribera.U-2.R-1',
    'BESS ribera',
  ];

  it('skips an unpublished generation to reach the racks', () => {
    expect(nearestPublishedDescendants('BESS ribera', published)).toEqual({
      grain: 'rack',
      ids: ['BESS ribera.U-1.R-1', 'BESS ribera.U-1.R-2', 'BESS ribera.U-2.R-1'],
    });
  });

  it('stays inside the subtree it was asked about', () => {
    expect(nearestPublishedDescendants('BESS ribera.U-1', published)).toEqual({
      grain: 'rack',
      ids: ['BESS ribera.U-1.R-1', 'BESS ribera.U-1.R-2'],
    });
  });

  it('never offers a sibling, an ancestor or another asset', () => {
    expect(
      nearestPublishedDescendants('BESS ribera.U-1.R-1', [...published, 'BESS other.U-1.R-1']),
    ).toBeNull();
    expect(nearestPublishedDescendants('BESS ribera', ['BESS other.U-1.R-1'])).toBeNull();
    expect(nearestPublishedDescendants(null, published)).toBeNull();
  });

  it('prefers the shallowest published generation', () => {
    expect(
      nearestPublishedDescendants('BESS ribera', [
        'BESS ribera.U-1',
        'BESS ribera.U-1.R-1',
      ]),
    ).toEqual({ grain: 'unit', ids: ['BESS ribera.U-1'] });
  });
});

describe('rack grain leads the metric list', () => {
  it('opens on ΔV: the cell voltage spread is the first choice', () => {
    expect(METRIC_CHOICES[0].key).toBe(VOLTAGE_SPREAD_KEY);
    expect(METRIC_CHOICES[0].names[0]).toBe('voltage_spread_max_v');
    expect(METRIC_CHOICES[1].key).toBe(TEMP_SPREAD_KEY);
    expect(METRIC_CHOICES[1].names[0]).toBe('temp_spread_max_c');
  });

  it('never asks for the bare spread names as the preferred spelling', () => {
    // gold_bess_rack_daily.sql dropped `voltage_spread_v` / `temp_spread_c`
    // because they carried the day envelope under the instantaneous spread's
    // name. They survive only as trailing aliases for one release.
    for (const choice of METRIC_CHOICES) {
      expect(choice.names[0]).not.toBe('voltage_spread_v');
      expect(choice.names[0]).not.toBe('temp_spread_c');
    }
    expect(METRIC_CHOICES[0].names).toContain('voltage_spread_v');
    expect(METRIC_CHOICES[1].names).toContain('temp_spread_c');
  });

  it('carries the spreads before any asset-only metric', () => {
    // Compared against asset-ONLY metrics, not against everything published at
    // asset grain. The spreads are published at every grain, because a
    // publisher that emits racks also rolls them up by taking the max across
    // children, so the worst ΔV in a unit or in the whole asset is a real
    // published number. This assertion used to read `grains.includes('asset')`
    // and so contradicted that on its own, while the ordering it was actually
    // written to protect, spreads above throughput and cycles, still holds.
    const firstAssetOnly = METRIC_CHOICES.findIndex(
      (m) => m.grains.length === 1 && m.grains[0] === 'asset',
    );
    const lastSpread = METRIC_CHOICES.map((m) => m.grains.includes('rack')).lastIndexOf(true);
    expect(firstAssetOnly).toBeGreaterThan(-1);
    expect(lastSpread).toBeLessThan(firstAssetOnly);
  });
});

describe('defaultMetricFor', () => {
  const grains: BessDeviceGrain[] = ['asset', 'unit', 'rack', 'module', 'cell'];

  it('returns a metric that exists at every grain it is asked about', () => {
    // Without this the root opens on a rack-only metric and paints an empty
    // state on first load, which reads as broken data rather than as a grain
    // that does not publish the quantity.
    const family: Record<BessDeviceGrain, BessDeviceGrain> = {
      asset: 'asset',
      unit: 'asset',
      rack: 'rack',
      module: 'rack',
      cell: 'rack',
    };
    for (const grain of grains) {
      const key = defaultMetricFor(grain);
      const choice = METRIC_CHOICES.find((m) => m.key === key);
      expect(choice, `no choice for grain ${grain}`).toBeTruthy();
      expect(choice!.grains).toContain(family[grain]);
    }
  });

  it('defaults rack and module to the voltage spread', () => {
    expect(defaultMetricFor('rack')).toBe(VOLTAGE_SPREAD_KEY);
    expect(defaultMetricFor('module')).toBe(VOLTAGE_SPREAD_KEY);
  });

  it('defaults the asset and its units to something that grain publishes', () => {
    // The invariant is that the root never opens on a metric its own grain
    // cannot serve, which is what painted an empty state on first load. It is
    // NOT that the default has to be a rack-free metric: the spreads are rolled
    // up to unit and asset and are the right thing to open on there too.
    for (const grain of ['asset', 'unit'] as BessDeviceGrain[]) {
      const choice = METRIC_CHOICES.find((m) => m.key === defaultMetricFor(grain))!;
      expect(choice.grains).toContain('asset');
    }
  });

  it('falls back to an asset grain metric when the grain is unknown', () => {
    const choice = METRIC_CHOICES.find((m) => m.key === defaultMetricFor(null))!;
    expect(choice.grains).toContain('asset');
  });
});

describe('resolveMetricName', () => {
  const temps = METRIC_CHOICES.find((m) => m.key === 'max_temp')!.names;

  it('asks for the preferred spelling before the route has told us anything', () => {
    expect(resolveMetricName(temps, null)).toBe('temperature_max_c');
    expect(resolveMetricName(temps, [])).toBe('temperature_max_c');
  });

  it('switches to whichever alias the device actually publishes', () => {
    expect(resolveMetricName(temps, ['max_temp_c', 'soc_avg'])).toBe('max_temp_c');
  });

  it('returns null when none of the aliases is published, so the UI can say so', () => {
    expect(resolveMetricName(temps, ['soc_avg', 'throughput_mwh'])).toBeNull();
  });

  it('falls back to the old spread spelling on a plant still carrying it', () => {
    // The alias retry in load() is what keeps a rack drawing across the publish
    // that renamed voltage_spread_v to voltage_spread_max_v.
    const spread = METRIC_CHOICES[0].names;
    expect(resolveMetricName(spread, ['voltage_spread_v', 'soc_mean_pct'])).toBe(
      'voltage_spread_v',
    );
    expect(resolveMetricName(spread, ['voltage_spread_max_v', 'voltage_spread_v'])).toBe(
      'voltage_spread_max_v',
    );
  });
});

describe('the ΔV / ΔT headline', () => {
  it('reads the newest published point, not the first one', () => {
    const res: TelemetryQueryResponse = {
      unit: 'V',
      metric: 'voltage_spread_max_v',
      series: [
        { date: '2026-07-01', value: 0.021 },
        { date: '2026-07-03', value: 0.042 },
        { date: '2026-07-02', value: 0.03 },
      ],
    };
    expect(latestPoint(res)).toEqual({
      date: '2026-07-03',
      value: 0.042,
      unit: 'V',
      metric: 'voltage_spread_max_v',
    });
  });

  it('reports nothing rather than a zero when no point is published', () => {
    expect(latestPoint({ unit: 'V', series: [] })).toBeNull();
    expect(latestPoint(null)).toBeNull();
    expect(formatSpread(null)).toBe('no data');
  });

  it('renders a voltage spread in millivolts and a temperature spread in degrees', () => {
    const at = (value: number, unit: string) => ({
      date: '2026-07-03',
      value,
      unit,
      metric: null,
    });
    expect(formatSpread(at(0.042, 'V'))).toBe('42 mV');
    expect(formatSpread(at(0.0042, 'V'))).toBe('4.2 mV');
    expect(formatSpread(at(0.9, 'degC'))).toBe('0.90 °C');
  });

  it('captions a legacy spread series as the envelope rather than as ΔV', () => {
    // The old columns held the day envelope under the instantaneous spread's
    // name. Drawing one silently would over read by up to a factor of nine.
    const note = legacySpreadNote('voltage_spread_v');
    expect(note).toContain('day envelope');
    expect(note).toContain('voltage_spread_max_v');
    expect(legacySpreadNote('temp_spread_c')).toContain('temp_spread_max_c');
    expect(legacySpreadNote('voltage_spread_max_v')).toBeNull();
    expect(legacySpreadNote(null)).toBeNull();
  });

  it('prints the literature caption verbatim, bands and disclaimer together', () => {
    expect(SPREAD_CONTEXT_CAPTION).toBe(
      'Context bands (0.05 / 0.08 / 0.1 V) are from a published five-cell laboratory ' +
        'module study, not from this asset and not a NuraVolt limit. Treat them as ' +
        'literature context for a healthy plateau, not as an alarm threshold.',
    );
    // The two halves must never be separated: a band without its provenance is
    // read as a limit within a week.
    expect(SPREAD_CONTEXT_CAPTION).toContain('0.05 / 0.08 / 0.1 V');
    expect(SPREAD_CONTEXT_CAPTION).toContain('not a NuraVolt limit');
    expect(SPREAD_CONTEXT_CAPTION).toContain('not as an alarm threshold');
  });
});

describe('isModelledRackPublish', () => {
  it('banners a modelled publish', () => {
    expect(isModelledRackPublish('modelled-dispatch-v2')).toBe(true);
    expect(isModelledRackPublish('modelled-dispatch-v2', null)).toBe(true);
    expect(isModelledRackPublish('bess-measured-v1', 'modelled')).toBe(true);
  });

  it('leaves a measured publish alone', () => {
    expect(isModelledRackPublish('bess-measured-v1')).toBe(false);
    expect(isModelledRackPublish('bess-measured-v1', 'measured')).toBe(false);
    expect(isModelledRackPublish(null)).toBe(false);
    expect(isModelledRackPublish('  ')).toBe(false);
  });

  it('says what a modelled rack channel is, without hedging', () => {
    expect(MODELLED_RACK_BANNER).toContain('dispatch twin');
    expect(MODELLED_RACK_BANNER).toContain('not measured hardware');
  });
});

describe('bessProvenanceNote', () => {
  it('always echoes the model version that produced the rows', () => {
    expect(bessProvenanceNote('bess-measured-v1', 'measured')).toBe(
      'Measured telemetry published to the lake. Model version bess-measured-v1.',
    );
    expect(bessProvenanceNote('modelled-dispatch-v2', null)).toBe(
      'Modelled dispatch twin, not measured hardware behaviour. Model version modelled-dispatch-v2.',
    );
    // Unrecognised publish: still name it rather than claim a basis.
    expect(bessProvenanceNote('experiment-7', null)).toBe('Model version experiment-7.');
  });

  it('claims nothing when there is no model version to cite', () => {
    expect(bessProvenanceNote(null)).toBeNull();
    expect(bessProvenanceNote('  ')).toBeNull();
  });
});

describe('telemetryRegimeNote', () => {
  it('describes a mixed asset by its cutover instead of blanket labelling it', () => {
    expect(
      telemetryRegimeNote({ mode: 'mixed', firstMeasuredDate: '2026-03-01', source: 'huawei_cloud' }),
    ).toBe('Measured from huawei_cloud from 2026-03-01, modelled before that date.');
  });

  it('names a modelled asset as modelled', () => {
    expect(telemetryRegimeNote({ mode: 'modelled', firstMeasuredDate: null, source: null })).toBe(
      'Modelled twin, no telemetry connection on this asset.',
    );
  });

  it('says nothing when the regime is unknown', () => {
    expect(telemetryRegimeNote(null)).toBeNull();
    expect(telemetryRegimeNote({ mode: null, firstMeasuredDate: null, source: null })).toBeNull();
  });
});

describe('a read in flight never claims an absence', () => {
  // The bug this pins. The panel held one nullable response and rendered "no
  // cell voltage spread published for this device" plus "nothing is published
  // at this grain yet" whenever it was null, so for the whole several seconds
  // of the asset-grain read it stated in the content area that telemetry which
  // does exist does not. The word "reading" in the panel corner does not
  // retract a sentence printed in the middle of the panel.
  it('renders the reading state, not the empty state, while the read is out', () => {
    expect(seriesViewState('reading', 0)).toBe('reading');
    expect(seriesViewState('reading', 1)).toBe('reading');
    expect(seriesViewState('reading', 30)).toBe('reading');
  });

  it('renders the empty state only once a read has settled with nothing', () => {
    expect(seriesViewState('ready', 0)).toBe('empty');
    // One point is still not a trend, and that stays its own sentence.
    expect(seriesViewState('ready', 1)).toBe('empty');
    expect(seriesViewState('ready', 2)).toBe('chart');
    expect(seriesViewState('ready', 30)).toBe('chart');
  });

  it('renders a failed read as a failure, never as an absence', () => {
    // A 403 from the billing gate and an empty lake are opposite facts. The
    // panel used to fold both into "connect a telemetry source to enable".
    expect(seriesViewState('error', 0)).toBe('error');
    expect(seriesViewState('error', 30)).toBe('error');
  });

  it('keeps the reading and failure copy free of any claim about the lake', () => {
    for (const copy of [READING_SERIES_COPY, READING_DEVICES_COPY]) {
      expect(copy).not.toMatch(/nothing is published|no .* published|connect/i);
    }
    expect(READ_FAILED_COPY).toMatch(/could not read/i);
    expect(READ_FAILED_COPY).not.toMatch(/published/i);
    expect(READ_FAILED_DEVICES_COPY).toMatch(/unknown/i);
    // The sentence that stops a route outage being read as a missing publish.
    expect(READ_FAILED_DISTINCTION_COPY).toMatch(/not a statement about what is published/i);
  });
});

describe('telemetryErrorMessage', () => {
  it('prefers what the route said over the status code', () => {
    expect(telemetryErrorMessage(new Error('Failed to fetch battery telemetry'))).toBe(
      'Failed to fetch battery telemetry.',
    );
    expect(telemetryErrorMessage(new Error('The telemetry service answered 403.'))).toBe(
      'The telemetry service answered 403.',
    );
  });

  it('replaces a browser transport string an operator cannot act on', () => {
    for (const raw of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch']) {
      expect(telemetryErrorMessage(new Error(raw))).toBe(
        'The telemetry service could not be reached.',
      );
    }
    expect(telemetryErrorMessage(null)).toBe('The telemetry service could not be reached.');
  });
});

describe('imbalance spread inputs, as the safety panel renders them', () => {
  const sub = (inputs: Record<string, unknown>) => ({ name: 'imbalance', inputs });
  const base: ImbalanceSpreadSummary = {
    worstVoltageMv: null,
    worstTemperatureC: null,
    rackCount: null,
    basis: null,
    racksReportingExtremes: null,
  };

  it('reads the worst within rack spread, the rack count and the basis', () => {
    const summary = imbalanceSpreadSummary(
      sub({
        rack_count: 6,
        worst_within_rack_spread: { voltage: 0.042, temperature: 0.9 },
        spread_basis: 'extremes',
        racks_reporting_extremes: 6,
      }),
    );
    expect(summary).toEqual({
      worstVoltageMv: 42,
      worstTemperatureC: 0.9,
      rackCount: 6,
      basis: 'extremes',
      racksReportingExtremes: 6,
    });
    expect(imbalanceSpreadLine(summary)).toBe(
      'worst ΔV 42 mV · worst ΔT 0.90 °C · 6 racks · spread from reported extremes',
    );
  });

  it('says the spread came from reported extremes, so 2 members is not read as 2 modules', () => {
    // The whole point of publishing the basis: a BMS reporting Vmax and Vmin
    // gives an EXACT spread from two members, on a rack of several hundred
    // cells. Without the label a reader sees a sample of two.
    expect(spreadBasisLabel({ ...base, basis: 'extremes' })).toBe('spread from reported extremes');
    expect(spreadBasisLabel({ ...base, basis: 'members' })).toBe(
      'spread across reporting members',
    );
    expect(spreadBasisLabel({ ...base, basis: 'mixed', racksReportingExtremes: 2 })).toBe(
      'spread from members and reported extremes, 2 racks on extremes',
    );
    expect(spreadBasisLabel({ ...base, basis: null })).toBeNull();
  });

  it('reports an unmeasurable spread as absent, never as zero', () => {
    const summary = imbalanceSpreadSummary(
      sub({
        rack_count: 1,
        worst_within_rack_spread: { voltage: null, temperature: null },
        spread_basis: null,
      }),
    );
    expect(summary?.worstVoltageMv).toBeNull();
    expect(summary?.worstTemperatureC).toBeNull();
    expect(imbalanceSpreadLine(summary)).toBe('1 rack');
  });

  it('says nothing at all for an asset with no rack feed', () => {
    // The older published artifacts carry rack_count 0 with the connect your BMS
    // reason. "0 racks" printed beside that reason reads like a measurement of a
    // pack with no racks in it.
    const summary = imbalanceSpreadSummary(
      sub({ rack_count: 0, dwell_minutes: 30, inter_rack_spread: {} }),
    );
    expect(imbalanceSpreadLine(summary)).toBeNull();
  });

  it('claims nothing for a sub index that is not imbalance, or that published no inputs', () => {
    expect(imbalanceSpreadSummary({ name: 'thermal_margin', inputs: { rack_count: 4 } })).toBeNull();
    expect(imbalanceSpreadSummary({ name: 'imbalance', inputs: null })).toBeNull();
    expect(imbalanceSpreadSummary({ name: 'imbalance', inputs: { dwell_minutes: 30 } })).toBeNull();
    expect(imbalanceSpreadLine(null)).toBeNull();
  });
});
