/**
 * Contract tests for the scripted Shams example sessions
 * (src/fixtures/demo-conversations/*). No server needed — these are pure
 * module checks:
 *   1. Forbidden strings: internal plant names, em/en dashes, emoji never
 *      ship in demo threads or showcase briefings.
 *   2. Structure: every tool part is finished ('output-available', non-error
 *      output), every thread opens with its prompt, cite tokens parse.
 *   3. Tool outputs equal an independent recomputation from the shipped
 *      fixture JSON through the shared shapers (drift fails loudly).
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import riberaThreads from '@/fixtures/demo-conversations/ribera';
import heliosThreads from '@/fixtures/demo-conversations/helios';
import nimbusThreads from '@/fixtures/demo-conversations/nimbus';
import portfolioThreads from '@/fixtures/demo-conversations/portfolio';
import type { DemoThread } from '@/fixtures/demo-conversations/types';
import {
  buildReportScheduleDraft,
  shapeBessRevenueOutput,
  shapeIrradianceQualityOutput,
  shapeSoilingForecastOutput,
  soilingRowsFromFixture,
} from '@/lib/ai/tool-shapes';
import { computeNextRunAt } from '@/lib/reports/schedule';
import { wantsReportSchedule } from '@/lib/ai/tool-shapes';
import { parseCiteBody, splitOnCites } from '@/lib/ai/cite';

const ALL: Array<[string, DemoThread[]]> = [
  ['ribera', riberaThreads],
  ['helios', heliosThreads],
  ['nimbus', nimbusThreads],
  ['portfolio', portfolioThreads],
];

const FORBIDDEN = [/redacted_donor_plant/i, /redacted_legacy_code/i, /—/, /–/, /[\u{1F300}-\u{1FAFF}]/u];

const toolParts = (t: DemoThread) =>
  t.messages.flatMap((m) => m.parts.filter((p: any) => p.type?.startsWith('tool-'))) as any[];

describe('scripted demo threads', () => {
  it.each(ALL)('%s threads carry no forbidden strings', (_slug, threads) => {
    const serialized = JSON.stringify(threads);
    for (const re of FORBIDDEN) {
      expect(serialized).not.toMatch(re);
    }
  });

  it.each(ALL)('%s threads are structurally complete', (_slug, threads) => {
    expect(threads.length).toBeGreaterThan(0);
    for (const t of threads) {
      expect(t.surface).toMatch(/^(demo|showcase)$/);
      // Opening user message is the prompt.
      const first = t.messages[0] as any;
      expect(first.role).toBe('user');
      expect(first.parts[0].text).toBe(t.prompt);
      // Every tool part is finished with a non-error output.
      const tools = toolParts(t);
      expect(tools.length).toBeGreaterThan(0);
      for (const p of tools) {
        expect(p.state).toBe('output-available');
        expect(p.output).toBeTruthy();
        expect((p.output as any).error).toBeUndefined();
      }
      // Cite tokens (if any) parse to known kinds.
      for (const m of t.messages) {
        for (const part of m.parts as any[]) {
          if (part.type !== 'text') continue;
          for (const seg of splitOnCites(part.text)) {
            if (seg.type === 'cite') {
              expect(seg.cite.kind).toMatch(/^(chart|plant|ticket|revenue|kb)$/);
            }
          }
        }
      }
    }
  });

  it('soiling thread outputs equal recomputation from the shipped fixtures', () => {
    const cases = [
      {
        threads: riberaThreads,
        json: 'public/data/soiling/ribera/sr_forecast.json',
        plant: { id: 'ribera', slug: 'ribera', name: 'Ribera Solar Park' },
      },
      {
        threads: heliosThreads,
        json: 'public/data/showcase/soiling/helios/sr_forecast.json',
        plant: { id: 'showcase-helios', slug: 'helios', name: 'Helios PV' },
      },
    ];
    for (const c of cases) {
      const fixture = JSON.parse(fs.readFileSync(path.resolve(c.json), 'utf8'));
      const rows = soilingRowsFromFixture(
        fixture.forecast.daily,
        fixture.forecast.summary.cleaning_recommendation
      );
      const expected = shapeSoilingForecastOutput(rows, c.plant, rows.length, 'ml_forecast', null);
      const thread = c.threads.find((t) => t.id.endsWith('cleaning-roi'))!;
      const part = toolParts(thread).find((p) => p.type === 'tool-getSoilingForecast')!;
      expect(part.output).toEqual(expected);
    }
  });

  it('irradiance quality outputs equal recomputation from the shipped fixtures', () => {
    const cases = [
      {
        threads: riberaThreads,
        json: 'public/data/soiling/ribera/quality/irradiance_comparison.json',
        plant: { id: 'ribera', slug: 'ribera', name: 'Ribera Solar Park' },
      },
      {
        threads: heliosThreads,
        json: 'public/data/showcase/soiling/helios/quality/irradiance_comparison.json',
        plant: { id: 'showcase-helios', slug: 'helios', name: 'Helios PV' },
      },
    ];
    for (const c of cases) {
      const fixture = JSON.parse(fs.readFileSync(path.resolve(c.json), 'utf8'));
      const expected = shapeIrradianceQualityOutput(fixture, c.plant);
      const thread = c.threads.find((t) => t.id.endsWith('irradiance-quality'))!;
      const part = toolParts(thread).find((p) => p.type === 'tool-getIrradianceQuality')!;
      expect(part.output).toEqual(expected);
      // The comparison must be honestly labeled sensor-vs-model.
      expect((part.output as any).reference).toMatch(/^Open-Meteo/);
      expect((part.output as any).overall.sample_count).toBeGreaterThan(0);
    }
  });

  it('ribera report-schedule draft equals recomputation and stays honest', () => {
    const expected = buildReportScheduleDraft({
      name: null,
      plant: { id: 'ribera', slug: 'ribera', name: 'Ribera Solar Park' },
      schedule: 'weekly',
      dayOfWeek: 1,
      period: 'last_7d',
      recipients: ['you@yourcompany.com'],
    });
    const thread = riberaThreads.find((t) => t.id === 'ribera-weekly-report')!;
    const part = toolParts(thread).find((p) => p.type === 'tool-proposeReportSchedule')!;
    expect(part.output).toEqual(expected);
    // Draft honesty: never a real email, always the 07:00 UTC send time.
    expect((part.output as any).draft.recipient_emails).toEqual(['you@yourcompany.com']);
    expect((part.output as any).draft.cadence_label).toContain('07:00 UTC');
    expect((part.output as any).note).toMatch(/DRAFT/);
  });

  it('portfolio triage thread numbers come from portfolio_financial.json', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.resolve('public/data/portfolio_financial.json'), 'utf8')
    );
    const plants: any[] = fixture.plants;
    const thread = portfolioThreads.find((t) => t.id === 'portfolio-morning-triage')!;

    // The plants table is a 1:1 mapping of the fixture rows.
    const listPart = toolParts(thread).find((p) => p.type === 'tool-listPlants')!;
    expect(listPart.output.count).toBe(plants.length);
    expect(listPart.output.plants.map((p: any) => p.slug)).toEqual(
      plants.map((p) => p.plantId)
    );
    expect(listPart.output.plants.map((p: any) => p.capacity_mw)).toEqual(
      plants.map((p) => p.capacity_MW)
    );

    // The drafted ticket targets the fixture's worst-risk plant with its
    // actual revenue-at-risk figure.
    const worst = [...plants].sort(
      (a, b) => b.riskScore.overall - a.riskScore.overall
    )[0];
    const ticketPart = toolParts(thread).find((p) => p.type === 'tool-proposeTicket')!;
    expect(ticketPart.output.draft.plant_slug).toBe(worst.plantId);
    expect(ticketPart.output.draft.estimated_revenue_impact_eur).toBe(
      Math.round(worst.financials.revenue_at_risk_eur)
    );

    // Prose totals recompute from the fixture.
    const totalAtRisk = plants.reduce(
      (s, p) => s + (p.financials?.revenue_at_risk_eur ?? 0),
      0
    );
    const prose = thread.messages
      .flatMap((m) => m.parts)
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    expect(prose).toContain(`${Math.round(totalAtRisk / 1000)}k EUR`);
    expect(prose).toContain(String(worst.riskScore.overall));
  });

  it('manuals thread excerpts are verbatim slices of the shipped seed manual', async () => {
    const { SOP_TITLE, SOP_EXCERPT_ROI, SOP_EXCERPT_WATER } = await import(
      '@/fixtures/demo-conversations/manualsThread'
    );
    const sop = fs.readFileSync(
      path.resolve('public/data/manuals/seed/synthetic/soiling-cleaning-sop.md'),
      'utf8'
    );
    expect(sop).toContain(`title: ${SOP_TITLE}`);
    expect(sop).toContain(SOP_EXCERPT_ROI);
    expect(sop).toContain(SOP_EXCERPT_WATER);

    const thread = riberaThreads.find((t) => t.id === 'ribera-manuals-sop')!;
    const part = toolParts(thread).find((p) => p.type === 'tool-searchKnowledgeBase')!;
    for (const r of part.output.results) {
      expect(sop).toContain(r.excerpt);
      expect(r.document_title).toBe(SOP_TITLE);
    }
  });

  it('money-leaks thread euro figures sum from portfolio_financial.json', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.resolve('public/data/portfolio_financial.json'), 'utf8')
    );
    const plants: any[] = fixture.plants;
    const soil = plants.reduce((s, p) => s + (p.financials?.soiling_loss_eur ?? 0), 0);
    const fault = plants.reduce((s, p) => s + (p.financials?.fault_loss_eur ?? 0), 0);
    const risk = plants.reduce((s, p) => s + (p.financials?.revenue_at_risk_eur ?? 0), 0);

    const thread = portfolioThreads.find((t) => t.id === 'portfolio-money-leaks')!;
    const prose = thread.messages
      .flatMap((m) => m.parts)
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    for (const total of [soil, fault, risk]) {
      expect(prose).toContain(`${Math.round(total / 1000)}k EUR`);
    }
    // The closing report draft is the shared builder's exact output.
    const part = toolParts(thread).find((p) => p.type === 'tool-proposeReportSchedule')!;
    expect(part.output.draft.schedule).toBe('monthly');
    expect(part.output.draft.recipient_emails).toEqual(['you@yourcompany.com']);
    expect(part.output.draft.cadence_label).toContain('07:00 UTC');
  });

  it('nimbus revenue outputs equal recomputation from the shipped fixture', () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.resolve('public/data/showcase/bess/nimbus/ancillary_revenue_30d.json'), 'utf8')
    );
    const plant = { id: 'showcase-nimbus', slug: 'nimbus', name: 'Nimbus Storage' };
    const thread = nimbusThreads[0];
    const parts = toolParts(thread).filter((p) => p.type === 'tool-getBessRevenue');
    expect(parts).toHaveLength(2);
    expect(parts[0].output).toEqual(shapeBessRevenueOutput(fixture, plant, 7, 'service'));
    expect(parts[1].output).toEqual(shapeBessRevenueOutput(fixture, plant, 14, 'day'));
  });
});

describe('showcase briefing fixtures', () => {
  const dir = path.resolve('public/data/showcase/briefings');
  const slugs = ['helios', 'nimbus', 'zephyr'];

  it.each(slugs)('%s briefing has the Briefing shape and clean copy', (slug) => {
    const raw = fs.readFileSync(path.join(dir, `${slug}.json`), 'utf8');
    for (const re of FORBIDDEN) {
      expect(raw).not.toMatch(re);
    }
    const b = JSON.parse(raw);
    expect(Array.isArray(b.bullets)).toBe(true);
    expect(b.bullets.length).toBeGreaterThanOrEqual(2);
    expect(b.scope?.plantId).toBe(slug);
  });
});

describe('chart output shaper', () => {
  it('downsamples, computes stats, and emits a ready widget config', async () => {
    const { shapeChartOutput } = await import('@/lib/ai/tool-shapes');
    const points = Array.from({ length: 200 }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      actual: 100 + i,
      predicted: 100 + i + 5,
    }));
    const out: any = shapeChartOutput(points, {
      plant: { id: 'p1', slug: 'smoke-park-one', name: 'Smoke Park One' },
      metric: 'power_ac',
      unit: 'kW',
      label: 'AC power',
      deviceId: 'INV-01',
      range: 'last_30d',
    });
    expect(out.series.dates.length).toBeLessThanOrEqual(90);
    expect(out.series.predicted.length).toBe(out.series.dates.length);
    expect(out.stats.min).toBe(100);
    expect(out.stats.max).toBe(299);
    expect(out.stats.latest).toBe(299);
    expect(out.sample_size).toBe(200);
    expect(out.widget_config).toEqual({
      type: 'chart.timeseries',
      config: {
        deviceIds: ['INV-01'],
        plantIds: ['smoke-park-one'],
        range: 'last_30d',
        options: { metric: 'power_ac' },
      },
    });
    expect(out.series.note).toMatch(/Do not enumerate/);
  });

  it('measured-only points omit the predicted column', async () => {
    const { shapeChartOutput } = await import('@/lib/ai/tool-shapes');
    const out: any = shapeChartOutput(
      [
        { date: '2026-07-01', actual: 1.2, predicted: null },
        { date: '2026-07-02', actual: 1.4, predicted: null },
      ],
      {
        plant: { id: 'p1', slug: 's', name: 'S' },
        metric: 'energy_daily',
        unit: 'kWh',
        label: 'Daily energy',
        range: 'last_7d',
      }
    );
    expect(out.series.predicted).toBeUndefined();
    expect(out.widget_config.config.deviceIds).toBeUndefined();
  });
});

describe('report composition shapers', () => {
  it('compose-report thread outputs equal shaper recomputation', async () => {
    const { shapeReportSummary, buildReportScheduleDraft } = await import('@/lib/ai/tool-shapes');
    const thread = riberaThreads.find((t) => t.id === 'ribera-compose-report')!;
    const parts = toolParts(thread);

    const add = parts.find((p) => p.type === 'tool-addReportChart')!;
    expect(add.output.widget_count).toBe(1);
    expect(add.output.widgets[0]).toMatchObject({
      type: 'chart.timeseries',
      metric: 'power_ac',
      plant: 'ribera',
      range: 'last_30d',
    });
    // Deterministic recompute of the same summary.
    const recomputed = shapeReportSummary({
      id: 'seed-report-ribera-monthly',
      slug: 'ribera-monthly-ops',
      title: 'Ribera Solar Park monthly ops report',
      scope_plant_ids: ['ribera'],
      default_range: 'last_30d',
      widgets: [
        {
          id: 'w_demo_pwr1',
          type: 'chart.timeseries',
          x: 0,
          y: 0,
          w: 8,
          h: 6,
          config: {
            title: 'Plant AC power, predicted vs actual',
            plantIds: ['ribera'],
            range: 'last_30d',
            options: { metric: 'power_ac' },
          },
        },
      ],
    });
    expect(add.output).toEqual(recomputed);

    const sched = parts.find((p) => p.type === 'tool-proposeReportSchedule')!;
    expect(sched.output.draft.dashboard_id).toBe('seed-report-ribera-monthly');
    expect(sched.output.draft.schedule).toBe('monthly');
    expect(sched.output.draft.cadence_label).toContain('07:00 UTC');
    expect(sched.output).toEqual(
      buildReportScheduleDraft({
        name: null,
        plant: null,
        dashboard: { id: 'seed-report-ribera-monthly', title: 'Ribera Solar Park monthly ops report' },
        schedule: 'monthly',
        dayOfMonth: 1,
        period: 'last_month',
        recipients: ['you@yourcompany.com'],
      })
    );
  });

  it('alarm draft clamps and diffs against current values', async () => {
    const { buildAlarmDraft } = await import('@/lib/ai/tool-shapes');
    const out: any = buildAlarmDraft({
      plant: { id: 'p1', slug: 's', name: 'S' },
      current: { soilingLossPct: 5, performanceRatioPct: 75, emailCritical: true },
      soilingLossPct: 99, // clamped to 50
      performanceRatioPct: null,
      emailCritical: null,
    });
    expect(out.kind).toBe('alarm_draft');
    expect(out.draft.proposed.soilingLossPct).toBe(50);
    expect(out.draft.proposed.performanceRatioPct).toBe(75);
    expect(out.draft.proposed.emailCritical).toBe(true);
    expect(out.note).toMatch(/no per-inverter/i);
  });
});

describe('report schedule computation', () => {
  const wed = new Date('2026-07-22T10:00:00Z'); // a Wednesday

  it('weekly honors the chosen ISO day of week', () => {
    expect(computeNextRunAt('weekly', 5, null, wed).toISOString()).toBe(
      '2026-07-24T07:00:00.000Z' // Friday
    );
    expect(computeNextRunAt('weekly', 1, null, wed).toISOString()).toBe(
      '2026-07-27T07:00:00.000Z' // next Monday
    );
    // Same weekday rolls a full week forward.
    expect(computeNextRunAt('weekly', 3, null, wed).toISOString()).toBe(
      '2026-07-29T07:00:00.000Z'
    );
  });

  it('monthly honors the chosen day of month', () => {
    expect(computeNextRunAt('monthly', null, 25, wed).toISOString()).toBe(
      '2026-07-25T07:00:00.000Z' // still ahead this month
    );
    expect(computeNextRunAt('monthly', null, 1, wed).toISOString()).toBe(
      '2026-08-01T07:00:00.000Z' // already passed, next month
    );
  });

  it('defaults are Monday and the 1st', () => {
    expect(computeNextRunAt('weekly', null, null, wed).getUTCDay()).toBe(1);
    expect(computeNextRunAt('monthly', null, null, wed).getUTCDate()).toBe(1);
  });
});

describe('report-schedule intent detection', () => {
  it('matches unambiguous recurring-report asks', () => {
    expect(wantsReportSchedule('Email me a weekly performance report every Friday')).toBe(true);
    expect(wantsReportSchedule('Send the team a monthly report on the 15th')).toBe(true);
    expect(wantsReportSchedule('can I get a recurring report by mail?')).toBe(true);
  });

  it('ignores one-off and unrelated asks', () => {
    expect(wantsReportSchedule('show me the fault report for INV-01')).toBe(false);
    expect(wantsReportSchedule('email me the ticket details')).toBe(false);
    expect(wantsReportSchedule('what plants do I have?')).toBe(false);
    expect(wantsReportSchedule('clean every Monday')).toBe(false);
  });
});

describe('cite grammar sanity', () => {
  it('parses a chart cite', () => {
    const cite = parseCiteBody('chart|plant=helios|inverter=INV 01|metric=power_ac');
    expect(cite?.kind).toBe('chart');
    expect(cite?.params.plant).toBe('helios');
  });
});
