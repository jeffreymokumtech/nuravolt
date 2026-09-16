/**
 * The three-lane revenue ledger, as the UI shapes it.
 *
 * The load-bearing test in this file is "no shaper produces a cross-lane sum".
 * It encodes a product decision, not a bug class: every competitor renders one
 * confident revenue total, and this product deliberately refuses to, because a
 * battery discharging at 14:00 could be running wholesale arbitrage, delivering
 * an accepted balancing-mechanism offer, or answering a frequency event, and
 * the power trace is identical in all three cases. Adding a measured
 * settlement to a declared contract fee to a perfect-foresight benchmark
 * triple counts the same megawatt hour. If a future change makes any exported
 * shaper emit measured + declared + benchmark, that test must fail loudly.
 *
 * Pure functions only, no renderer.
 */

import { describe, expect, it } from 'vitest';

import {
  HATCH,
  formatMetric,
  groupServiceTotalsByLane,
  laneColumnsForDay,
  laneMarkProps,
  laneMetricRows,
  laneScaleMax,
  laneSubtotals,
  lanesPresent,
  ledgerChartSeries,
  metricClass,
  metricColor,
  metricLabel,
  normalizeRevenuePayload,
  periodsPerDay,
  type RevenueDay,
} from '@/hooks/useBESSData';
import {
  BESS_SERVICES,
  LANE_ORDER,
  LANE_STYLE,
  serviceMeta,
} from '@/lib/config/bessServices';

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Legacy showcase row: every column carries a `_gbp` suffix. */
const gbpDay: RevenueDay = {
  date: '2026-07-01',
  dynamic_containment_gbp: 1100,
  dynamic_moderation_gbp: 700,
  dynamic_regulation_gbp: 500,
  capacity_market_gbp: 300,
  balancing_mechanism_gbp: 1300,
  wholesale_arbitrage_gbp: 900,
  total_gbp: 4800,
  throughput_mwh: 31.4,
};

/** The same day as the chat tool writes it: no currency suffix at all. */
const bareDay: RevenueDay = {
  date: '2026-07-01',
  dynamic_containment: 1100,
  dynamic_moderation: 700,
  dynamic_regulation: 500,
  capacity_market: 300,
  balancing_mechanism: 1300,
  wholesale_arbitrage: 900,
  total: 4800,
};

/** The same day for a euro-zone plant. */
const eurDay: RevenueDay = {
  date: '2026-07-01',
  dynamic_containment_eur: 1100,
  dynamic_moderation_eur: 700,
  dynamic_regulation_eur: 500,
  capacity_market_eur: 300,
  balancing_mechanism_eur: 1300,
  wholesale_arbitrage_eur: 900,
  total_eur: 4800,
};

const DECLARED_DAY = 1100 + 700 + 500 + 300; // 2600
const MEASURED_DAY = 1300 + 900; // 2200
const DAY_GRAND_TOTAL = DECLARED_DAY + MEASURED_DAY; // 4800, never rendered

/**
 * A ledger payload in the route's own shape. Values are deliberately spread so
 * that no legitimate per-metric or per-lane figure collides with a cross-lane
 * sum.
 */
const ledgerPayload = {
  plant: { slug: 'gb-battery', name: 'GB Battery', rated_mw: 25, energy_capacity_mwh: 50 },
  window: { from: '2026-07-01', to: '2026-07-02', days: 2 },
  ledger: {
    measured: {
      series: [
        {
          date: '2026-07-01',
          revenue_measured_energy: 800,
          revenue_measured_bm: 400,
          revenue_measured_charge_cost: 130,
          measured_discharge_mwh: 7.5,
        },
        {
          date: '2026-07-02',
          revenue_measured_energy: 501,
          revenue_measured_bm: 307,
          revenue_measured_charge_cost: 81,
          measured_discharge_mwh: 5,
        },
      ],
      totals: {
        revenue_measured_energy: 1301,
        revenue_measured_bm: 707,
        revenue_measured_charge_cost: 211,
        measured_discharge_mwh: 12.5,
      },
      metrics: [
        'measured_discharge_mwh',
        'revenue_measured_bm',
        'revenue_measured_charge_cost',
        'revenue_measured_energy',
      ],
      notes: ['BM acceptances: 2 day(s) fetched, 0 day(s) from cache'] as string[],
    },
    declared: {
      series: [
        { date: '2026-07-01', revenue_declared_dynamic_containment: 251, revenue_declared_capacity_market: 50 },
        { date: '2026-07-02', revenue_declared_dynamic_containment: 252, revenue_declared_capacity_market: 51 },
      ],
      totals: {
        revenue_declared_dynamic_containment: 503,
        revenue_declared_capacity_market: 101,
      },
      metrics: ['revenue_declared_capacity_market', 'revenue_declared_dynamic_containment'],
      notes: [] as string[],
    },
    benchmark: {
      series: [
        {
          date: '2026-07-01',
          revenue_benchmark_arbitrage: 1200,
          revenue_realized_net: 670,
          revenue_gap: 530,
          capture_ratio: 0.5583,
        },
        {
          date: '2026-07-02',
          revenue_benchmark_arbitrage: 803,
          revenue_realized_net: 427,
          revenue_gap: 376,
          capture_ratio: 0.5318,
        },
      ],
      totals: {
        revenue_benchmark_arbitrage: 2003,
        revenue_realized_net: 1097,
        revenue_gap: 906,
        capture_ratio: 0.545,
      },
      metrics: ['capture_ratio', 'revenue_benchmark_arbitrage', 'revenue_gap', 'revenue_realized_net'],
      notes: [] as string[],
    },
  },
  provenance: {
    revenue_measured_energy: {
      lane: 'measured',
      model_version: 'bess_revenue_measured_v1',
      source: 'measurements x elexon_mid_apx',
      caption: 'Measured discharge valued at the published elexon_mid_apx price.',
    },
    revenue_measured_bm: {
      lane: 'measured',
      model_version: 'bess_revenue_measured_v1',
      source: 'elexon_bm_stack',
      caption:
        'Settled Balancing Mechanism revenue for BMU T_TEST-1, reconstructed from the published Elexon acceptance stacks as final price times NIV-adjusted volume.',
    },
    revenue_declared_dynamic_containment: {
      lane: 'declared',
      model_version: 'bess_revenue_declared_v1',
      source: 'contract:abc',
      caption: "Declared by contract 'DC tender' (BESS_ANCILLARY). Contracted, not measured.",
    },
    revenue_benchmark_arbitrage: {
      lane: 'benchmark',
      model_version: 'bess_revenue_benchmark_v1',
      source: 'optimizer_audit x elexon_mid_apx',
      caption: 'Perfect-foresight ceiling on the same published prices. Unreachable by construction.',
    },
    capture_ratio: {
      lane: 'benchmark',
      model_version: 'bess_revenue_benchmark_v1',
      source: 'optimizer_audit x elexon_mid_apx',
      caption:
        'Realized net over the perfect-foresight ceiling. The denominator is the arbitrage bound above, not a tuned constant.',
    },
  },
  kpis: {
    measured_energy_value: 1301,
    measured_charge_cost: 211,
    measured_bm_settled: 707,
    declared_contracted: 604,
    benchmark_arbitrage_ceiling: 2003,
    benchmark_ancillary: null as number | null,
    realized_net: 1097,
    revenue_gap: 906,
    capture_ratio: 0.545,
    capture_ratio_caption: 'Share of the perfect-foresight ceiling that was realized.',
  },
  currency: 'GBP',
  resolution_minutes: 30,
  zone: 'GB',
  price_source: 'elexon_mid_apx',
  notes: ['BM acceptances: 2 day(s) fetched'],
  coverage: 'ledger',
  generated_at: '2026-07-03T02:11:00Z',
};

// Lane revenue subtotals of the ledger fixture, kept apart on purpose.
const LEDGER_MEASURED = 1301 + 707; // 2008
const LEDGER_DECLARED = 503 + 101; // 604
const LEDGER_BENCHMARK = 2003;

/** Every cross-lane sum that must never appear anywhere in the UI shaping. */
const FORBIDDEN_SUMS = [
  LEDGER_MEASURED + LEDGER_DECLARED,
  LEDGER_MEASURED + LEDGER_BENCHMARK,
  LEDGER_DECLARED + LEDGER_BENCHMARK,
  LEDGER_MEASURED + LEDGER_DECLARED + LEDGER_BENCHMARK,
];

function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) numbersIn(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) numbersIn(v, out);
    return out;
  }
  return out;
}

const has = (haystack: number[], needle: number) =>
  haystack.some((v) => Math.abs(v - needle) < 1e-6);

// ── Lane splitting is currency-suffix agnostic ─────────────────────────────

describe('laneColumnsForDay', () => {
  it('splits a day into measured and declared columns with per-lane subtotals', () => {
    const columns = laneColumnsForDay(gbpDay);
    expect(columns.map((c) => c.lane)).toEqual(['measured', 'declared']);
    expect(columns.find((c) => c.lane === 'measured')!.subtotal).toBe(MEASURED_DAY);
    expect(columns.find((c) => c.lane === 'declared')!.subtotal).toBe(DECLARED_DAY);
  });

  it('reads the same values whatever currency suffix the row was written with', () => {
    // This is why GB and Iberian plants share one component: the shapers go
    // through serviceValue rather than appending a hardcoded `_gbp`.
    expect(laneColumnsForDay(bareDay)).toEqual(laneColumnsForDay(gbpDay));
    expect(laneColumnsForDay(eurDay)).toEqual(laneColumnsForDay(gbpDay));
  });

  it('drops lanes and services with no value rather than drawing empty marks', () => {
    const onlyBm = { date: '2026-07-01', balancing_mechanism_gbp: 42 };
    const columns = laneColumnsForDay(onlyBm);
    expect(columns).toHaveLength(1);
    expect(columns[0].lane).toBe('measured');
    expect(columns[0].segments.map((s) => s.base)).toEqual(['balancing_mechanism']);
  });

  it('assigns every configured service to exactly one lane column', () => {
    const everyService = Object.fromEntries(
      BESS_SERVICES.map((s, i) => [`${s.base}_gbp`, 10 + i])
    );
    const columns = laneColumnsForDay({ date: '2026-07-01', ...everyService });
    const bases = columns.flatMap((c) => c.segments.map((s) => s.base));
    expect(new Set(bases).size).toBe(BESS_SERVICES.length);
    expect(bases).toHaveLength(BESS_SERVICES.length);
  });
});

describe('lane window aggregation', () => {
  const series = [gbpDay, { ...gbpDay, date: '2026-07-02' }];

  it('keeps lane subtotals in separate fields with no combined field', () => {
    const totals = laneSubtotals(series);
    expect(Object.keys(totals).sort()).toEqual(['benchmark', 'declared', 'measured']);
    expect(totals).not.toHaveProperty('total');
    expect(totals.measured).toBe(MEASURED_DAY * 2);
    expect(totals.declared).toBe(DECLARED_DAY * 2);
    expect(totals.benchmark).toBe(0);
  });

  it('scales the axis to the tallest lane column, never to a day total', () => {
    expect(laneScaleMax(series)).toBe(DECLARED_DAY);
    expect(laneScaleMax(series)).toBeLessThan(DAY_GRAND_TOTAL);
  });

  it('reports lanes in canonical order', () => {
    expect(lanesPresent(series)).toEqual(['measured', 'declared']);
    expect(lanesPresent([])).toEqual([]);
  });
});

// ── Lane marks and legend cannot drift ─────────────────────────────────────

describe('laneMarkProps', () => {
  it('derives opacity from LANE_STYLE for every lane', () => {
    for (const lane of LANE_ORDER) {
      const props = laneMarkProps(lane, '#0ea5e9', 'pat-1') as Record<string, unknown>;
      expect(props.opacity).toBe(LANE_STYLE[lane].opacity);
    }
  });

  it('paints hatch with the pattern, outline with a stroke, solid with the colour', () => {
    const byPattern = Object.fromEntries(
      LANE_ORDER.map((lane) => [
        LANE_STYLE[lane].pattern,
        laneMarkProps(lane, '#0ea5e9', 'pat-1') as Record<string, unknown>,
      ])
    );
    expect(byPattern.solid.fill).toBe('#0ea5e9');
    expect(byPattern.hatch.fill).toBe('url(#pat-1)');
    expect(byPattern.outline.stroke).toBe('#0ea5e9');
    expect(byPattern.outline.fillOpacity).toBeLessThan(1);
  });

  it('has hatch stripes narrower than their period, so the texture reads', () => {
    expect(HATCH.on).toBeGreaterThan(0);
    expect(HATCH.on).toBeLessThan(HATCH.period);
  });
});

// ── Per-service chat card ──────────────────────────────────────────────────

describe('groupServiceTotalsByLane', () => {
  const services = {
    dynamic_containment: { total: 1100, share_pct: 22.9 },
    dynamic_moderation: { total: 700, share_pct: 14.6 },
    dynamic_regulation: { total: 500, share_pct: 10.4 },
    capacity_market: { total: 300, share_pct: 6.3 },
    balancing_mechanism: { total: 1300, share_pct: 27.1 },
    wholesale_arbitrage: { total: 900, share_pct: 18.8 },
  };

  it('groups into lanes in canonical order with per-lane subtotals', () => {
    const groups = groupServiceTotalsByLane(services);
    expect(groups.map((g) => g.lane)).toEqual(['measured', 'declared']);
    expect(groups[0].subtotal).toBe(MEASURED_DAY);
    expect(groups[1].subtotal).toBe(DECLARED_DAY);
  });

  it('recomputes share within the lane instead of reusing the cross-lane share', () => {
    const groups = groupServiceTotalsByLane(services);
    for (const group of groups) {
      const sum = group.rows.reduce((s, r) => s + r.shareInLanePct, 0);
      expect(sum).toBeCloseTo(100, 6);
    }
    // The tool's own share_pct is a share of the grand total and is ignored.
    const dc = groups[1].rows.find((r) => r.base === 'dynamic_containment')!;
    expect(dc.shareInLanePct).toBeCloseTo((1100 / DECLARED_DAY) * 100, 6);
    expect(dc.shareInLanePct).not.toBeCloseTo(services.dynamic_containment.share_pct, 1);
  });

  it('sorts each lane by value so the top earner is scoped to its own lane', () => {
    const groups = groupServiceTotalsByLane(services);
    expect(groups[0].rows[0].base).toBe('balancing_mechanism');
    expect(groups[1].rows[0].base).toBe('dynamic_containment');
  });

  it('returns nothing for missing or empty service maps', () => {
    expect(groupServiceTotalsByLane(null)).toEqual([]);
    expect(groupServiceTotalsByLane({})).toEqual([]);
    expect(groupServiceTotalsByLane({ dynamic_containment: { total: 0 } })).toEqual([]);
  });
});

// ── Payload normalisation ──────────────────────────────────────────────────

describe('periodsPerDay', () => {
  it('reads the settlement period from the payload rather than assuming 24', () => {
    expect(periodsPerDay(30)).toBe(48); // GB half-hourly
    expect(periodsPerDay(60)).toBe(24); // Iberian hourly
    expect(periodsPerDay(15)).toBe(96);
  });

  it('returns null rather than guessing when the period is absent or not a divisor', () => {
    expect(periodsPerDay(null)).toBeNull();
    expect(periodsPerDay(undefined)).toBeNull();
    expect(periodsPerDay(0)).toBeNull();
    expect(periodsPerDay(-30)).toBeNull();
    expect(periodsPerDay(7)).toBeNull();
  });
});

describe('normalizeRevenuePayload', () => {
  it('carries currency and settlement resolution from the payload', () => {
    const payload = normalizeRevenuePayload(ledgerPayload);
    expect(payload.currency).toBe('GBP');
    expect(payload.resolutionMinutes).toBe(30);
    expect(payload.periodsPerDay).toBe(48);
    expect(payload.zone).toBe('GB');
    expect(payload.priceSource).toBe('elexon_mid_apx');
    expect(payload.coverage).toBe('ledger');
  });

  it('leaves currency blank rather than claiming sterling when the payload omits it', () => {
    const payload = normalizeRevenuePayload({ ...ledgerPayload, currency: undefined });
    expect(payload.currency).toBe('');
    expect(formatMetric(1234, 'revenue', payload.currency)).toBe('1.2k');
  });

  it('yields three empty lanes for an empty payload without inventing a lane', () => {
    const payload = normalizeRevenuePayload({});
    for (const lane of LANE_ORDER) {
      expect(payload.ledger[lane].series).toEqual([]);
      expect(payload.ledger[lane].totals).toEqual({});
    }
    expect(payload.coverage).toBe('not_yet_enabled');
    expect(payload.periodsPerDay).toBeNull();
  });
});

// ── Metric vocabulary ──────────────────────────────────────────────────────

describe('metricClass', () => {
  it('separates revenue from cost, quantity, ratio and derived metrics', () => {
    expect(metricClass('revenue_measured_energy')).toBe('revenue');
    expect(metricClass('revenue_measured_bm')).toBe('revenue');
    expect(metricClass('revenue_benchmark_arbitrage')).toBe('revenue');
    expect(metricClass('revenue_modelled_dispatch_net')).toBe('revenue');
    expect(metricClass('revenue_measured_charge_cost')).toBe('cost');
    expect(metricClass('measured_discharge_mwh')).toBe('quantity');
    expect(metricClass('capture_ratio')).toBe('ratio');
    expect(metricClass('revenue_gap')).toBe('derived');
    expect(metricClass('revenue_realized_net')).toBe('derived');
  });
});

describe('metricLabel', () => {
  it('maps service-suffixed metrics onto the shared service palette labels', () => {
    expect(metricLabel('revenue_declared_dynamic_containment')).toBe('Dynamic containment');
    expect(metricLabel('revenue_measured_wholesale_arbitrage')).toBe('Wholesale arbitrage');
    expect(metricColor('revenue_declared_dynamic_containment', 'declared')).toBe(
      serviceMeta('dynamic_containment')!.color
    );
  });

  it('captions the benchmark as a ceiling and never as measured', () => {
    expect(metricLabel('revenue_benchmark_arbitrage')).toMatch(/ceiling/i);
    expect(metricLabel('revenue_benchmark_arbitrage')).not.toMatch(/measured/i);
    expect(LANE_STYLE.benchmark.hint).toMatch(/perfect foresight/i);
  });

  it('humanises unknown metrics without crashing', () => {
    expect(metricLabel('revenue_measured_some_new_thing')).toBe('Some new thing');
    expect(metricLabel('measured_charge_mwh')).toBe('Charging energy');
  });
});

describe('formatMetric', () => {
  it('formats ratios as percentages, quantities as MWh and money in the ledger currency', () => {
    expect(formatMetric(0.545, 'ratio', 'GBP')).toBe('54.5%');
    expect(formatMetric(12.5, 'quantity', 'GBP')).toBe('12.5 MWh');
    expect(formatMetric(2003, 'revenue', 'GBP')).toBe('£2.0k');
    expect(formatMetric(2003, 'revenue', 'EUR')).toBe('€2.0k');
    expect(formatMetric(-906, 'revenue', 'GBP')).toBe('-£906');
    expect(formatMetric(null, 'revenue', 'GBP')).toBe('n/a');
  });
});

// ── Ledger shaping ─────────────────────────────────────────────────────────

describe('laneMetricRows', () => {
  const payload = normalizeRevenuePayload(ledgerPayload);

  it('returns one row per metric with its own window total and provenance', () => {
    const rows = laneMetricRows(payload, 'measured');
    expect(rows.map((r) => r.metric)).toEqual([
      'revenue_measured_energy',
      'revenue_measured_bm',
      'revenue_measured_charge_cost',
      'measured_discharge_mwh',
    ]);
    const bm = rows.find((r) => r.metric === 'revenue_measured_bm')!;
    expect(bm.total).toBe(707);
    expect(bm.provenance?.source).toBe('elexon_bm_stack');
    expect(bm.provenance?.model_version).toBe('bess_revenue_measured_v1');
  });

  it('never synthesises a lane total row', () => {
    for (const lane of LANE_ORDER) {
      const rows = laneMetricRows(payload, lane);
      for (const row of rows) {
        expect(row.metric).not.toMatch(/^lane_/);
        expect(row.label.toLowerCase()).not.toContain('total');
      }
    }
  });

  it('tags every row with the lane it was read from', () => {
    for (const lane of LANE_ORDER) {
      for (const row of laneMetricRows(payload, lane)) expect(row.lane).toBe(lane);
    }
  });
});

describe('ledgerChartSeries', () => {
  const payload = normalizeRevenuePayload(ledgerPayload);
  const chart = ledgerChartSeries(payload);

  it('stacks only revenue metrics and leaves costs, quantities and ratios out', () => {
    const metrics = chart.series.map((s) => s.metric);
    expect(metrics).toContain('revenue_measured_energy');
    expect(metrics).toContain('revenue_measured_bm');
    expect(metrics).toContain('revenue_benchmark_arbitrage');
    expect(metrics).not.toContain('revenue_measured_charge_cost');
    expect(metrics).not.toContain('measured_discharge_mwh');
    expect(metrics).not.toContain('capture_ratio');
    expect(metrics).not.toContain('revenue_gap');
    expect(metrics).not.toContain('revenue_realized_net');
  });

  it('tags every series with its lane so the renderer stacks within a lane only', () => {
    for (const s of chart.series) {
      expect(LANE_ORDER).toContain(s.lane);
      expect(metricClass(s.metric)).toBe('revenue');
    }
    expect(chart.lanes).toEqual(['measured', 'declared', 'benchmark']);
  });

  it('aligns every series to one sorted date axis, padding with null not zero', () => {
    expect(chart.dates).toEqual(['2026-07-01', '2026-07-02']);
    for (const s of chart.series) expect(s.data).toHaveLength(chart.dates.length);
    const sparse = ledgerChartSeries(
      normalizeRevenuePayload({
        ...ledgerPayload,
        ledger: {
          ...ledgerPayload.ledger,
          declared: {
            ...ledgerPayload.ledger.declared,
            series: [{ date: '2026-07-02', revenue_declared_capacity_market: 51 }],
          },
        },
      })
    );
    const cm = sparse.series.find((s) => s.metric === 'revenue_declared_capacity_market')!;
    expect(cm.data[0]).toBeNull();
    expect(cm.data[1]).toBe(51);
  });
});

// ── The product decision ───────────────────────────────────────────────────

describe('the three lanes are never summed into one number', () => {
  const payload = normalizeRevenuePayload(ledgerPayload);

  it('emits every lane subtotal and no cross-lane sum, across every shaper', () => {
    const shaped = {
      chart: ledgerChartSeries(payload),
      rows: LANE_ORDER.map((lane) => laneMetricRows(payload, lane)),
      kpis: payload.kpis,
      barSubtotals: laneSubtotals([gbpDay]),
      barColumns: laneColumnsForDay(gbpDay),
      barMax: laneScaleMax([gbpDay]),
      serviceGroups: groupServiceTotalsByLane({
        dynamic_containment: { total: 1100 },
        dynamic_moderation: { total: 700 },
        dynamic_regulation: { total: 500 },
        capacity_market: { total: 300 },
        balancing_mechanism: { total: 1300 },
        wholesale_arbitrage: { total: 900 },
      }),
    };

    const produced = numbersIn(shaped);

    // Control: prove the detector is not vacuous. If any shaper ever did add
    // the lanes together, this is the number that would show up.
    expect(has(numbersIn({ grandTotal: LEDGER_MEASURED + LEDGER_DECLARED + LEDGER_BENCHMARK }), 4615))
      .toBe(true);

    // The lanes ARE each represented, so this test cannot pass by emitting
    // nothing at all.
    expect(has(produced, 707)).toBe(true); // measured, BM settled
    expect(has(produced, 503)).toBe(true); // declared, DC contracted
    expect(has(produced, 2003)).toBe(true); // benchmark ceiling
    expect(has(produced, MEASURED_DAY)).toBe(true);
    expect(has(produced, DECLARED_DAY)).toBe(true);

    // No combination of lanes is ever added together.
    for (const forbidden of FORBIDDEN_SUMS) {
      expect(has(produced, forbidden)).toBe(false);
    }
    // Nor the legacy per-day grand total column, which the shapers ignore.
    expect(has(produced, DAY_GRAND_TOTAL)).toBe(false);
  });

  it('offers no shaper whose output shape has a grand-total field', () => {
    const subtotals = laneSubtotals([gbpDay]);
    expect(Object.keys(subtotals)).toEqual(expect.arrayContaining(LANE_ORDER));
    expect(Object.keys(subtotals)).toHaveLength(LANE_ORDER.length);

    for (const group of groupServiceTotalsByLane({
      balancing_mechanism: { total: 1300 },
      dynamic_containment: { total: 1100 },
    })) {
      expect(Object.keys(group).sort()).toEqual(['lane', 'rows', 'subtotal']);
    }

    // The ledger's only cross-lane arithmetic is the gap, and it is a
    // subtraction against the benchmark, not a sum of lanes.
    expect(payload.kpis.revenue_gap).toBe(
      ledgerPayload.kpis.benchmark_arbitrage_ceiling - ledgerPayload.kpis.realized_net
    );
  });

  it('keeps the capture rate denominator nameable, which is why it exists again', () => {
    // The deleted version of this KPI divided by a hand-tuned constant. The
    // payload now carries the real denominator and its price source, and the
    // cockpit only renders the KPI when both are present.
    expect(payload.kpis.benchmark_arbitrage_ceiling).toBe(2003);
    expect(payload.priceSource).toBe('elexon_mid_apx');
    expect(payload.provenance['capture_ratio'].caption).toMatch(/not a tuned constant/i);

    // The window ratio is the mean of the daily ratios, not a ratio of window
    // totals, because a summed ratio grows with the length of the window.
    const daily = ledgerPayload.ledger.benchmark.series.map((d) => d.capture_ratio as number);
    expect(payload.kpis.capture_ratio).toBeCloseTo(
      daily.reduce((s, v) => s + v, 0) / daily.length,
      3
    );
    // And it still lands where a real denominator would put it.
    expect(payload.kpis.capture_ratio).toBeCloseTo(
      payload.kpis.realized_net! / payload.kpis.benchmark_arbitrage_ceiling!,
      2
    );
  });
});
