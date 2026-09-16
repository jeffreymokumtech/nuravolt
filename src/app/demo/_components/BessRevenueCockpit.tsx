'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import SectionSkeleton from '@/components/SectionSkeleton';
import EmptyOpsPanel from '@/components/ops/EmptyOpsPanel';
import { HATCH } from '@/components/chat/rich/RevenueStackedBars';
import {
  LANE_ORDER,
  LANE_STYLE,
  formatMoney,
  type RevenueLane,
} from '@/lib/config/bessServices';
import {
  LANE_TONE,
  formatMetric,
  laneMetricRows,
  ledgerChartSeries,
  useBessRevenue,
  type LedgerMetricRow,
} from '@/hooks/useBESSData';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

/**
 * The three-lane revenue ledger.
 *
 * THERE IS NO GRAND TOTAL ON THIS PAGE, on purpose. Every competitor shows one
 * confident number. A battery discharging at 14:00 could be running wholesale
 * arbitrage, delivering an accepted balancing-mechanism offer, or answering a
 * frequency event under a response contract, and the power trace is identical
 * in all three cases, so a single total would be inventing an attribution and
 * would triple count the same megawatt hour. Instead:
 *
 *   measured   what the asset did, valued at a published price, plus settled
 *              balancing-mechanism revenue rebuilt from the public Elexon
 *              acceptance stacks. That reconstruction reconciles against the
 *              operator's own settlement statement from data they never gave
 *              us, so it gets its own panel rather than a table row.
 *   declared   what a contract says the asset is paid. Never presented as
 *              measured.
 *   benchmark  what perfect foresight would have earned on the same days and
 *              the same published prices. A ceiling, unreachable by
 *              construction.
 *
 * The one derived KPI is the gap versus that benchmark. The capture rate is
 * back after being deleted once, and it is only rendered when its denominator
 * is nameable: the panel prints the ceiling it divided by and the price source
 * that ceiling was solved from, which is exactly what the deleted version
 * could not do.
 */

// ── Lane marks. One source for the chart and the legend chips. ──────────────

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** ECharts itemStyle for a lane, derived only from LANE_STYLE. */
function laneItemStyle(lane: RevenueLane, color: string) {
  const style = LANE_STYLE[lane];
  if (style.pattern === 'hatch') {
    return {
      color: withAlpha(color, 0.32),
      opacity: style.opacity,
      decal: {
        symbol: 'rect',
        dashArrayX: [1, 0],
        dashArrayY: [HATCH.on, HATCH.period - HATCH.on],
        rotation: 0,
        color,
      },
    };
  }
  if (style.pattern === 'outline') {
    return {
      color: withAlpha(color, 0.16),
      borderColor: color,
      borderWidth: 1.25,
      opacity: style.opacity,
    };
  }
  return { color, opacity: style.opacity };
}

/** DOM swatch built from the same numbers the chart marks use. */
function LaneChip({ lane, color }: { lane: RevenueLane; color: string }) {
  const style = LANE_STYLE[lane];
  const base: React.CSSProperties = { width: 14, height: 10, borderRadius: 2, opacity: style.opacity };
  if (style.pattern === 'hatch') {
    base.background = `repeating-linear-gradient(0deg, ${color} 0 ${HATCH.on}px, ${withAlpha(
      color,
      0.32
    )} ${HATCH.on}px ${HATCH.period}px)`;
  } else if (style.pattern === 'outline') {
    base.background = withAlpha(color, 0.16);
    base.border = `1.25px solid ${color}`;
  } else {
    base.background = color;
  }
  return <span className="inline-block shrink-0" style={base} aria-hidden="true" />;
}

// ── Small pieces ───────────────────────────────────────────────────────────

function LedgerKpi({
  title,
  value,
  subtitle,
  caption,
  tone = 'neutral',
}: {
  title: string;
  value: string;
  subtitle?: string;
  caption?: string;
  tone?: 'neutral' | 'headline';
}) {
  return (
    <div className="rounded-xl border border-divider bg-white p-4 shadow-sm">
      <div className="text-xs text-ink-3">{title}</div>
      <div
        className={`mt-1 font-mono font-bold text-ink ${tone === 'headline' ? 'text-2xl' : 'text-xl'}`}
      >
        {value}
      </div>
      {subtitle && <div className="mt-1 text-[11px] text-ink-2">{subtitle}</div>}
      {caption && <div className="mt-1.5 text-[10px] leading-snug text-ink-3">{caption}</div>}
    </div>
  );
}

function ProvenanceChips({ row }: { row: LedgerMetricRow }) {
  if (!row.provenance) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1">
      <span className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
        {row.provenance.source}
      </span>
      <span className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
        {row.provenance.model_version}
      </span>
    </div>
  );
}

const COVERAGE_LABEL: Record<string, string> = {
  ledger: 'Nightly ledger',
  dispatch_only: 'Modelled dispatch only',
  fixture: 'Showcase fixture',
  not_yet_enabled: 'Not yet enabled',
};

// ── Component ──────────────────────────────────────────────────────────────

export default function BessRevenueCockpit({ plantSlug }: { plantSlug: string }) {
  const { data, isLoading, error } = useBessRevenue(plantSlug, { days: 30 });

  const chart = useMemo(() => (data ? ledgerChartSeries(data) : null), [data]);

  const laneRows = useMemo(() => {
    if (!data) return null;
    return LANE_ORDER.reduce(
      (acc, lane) => {
        acc[lane] = laneMetricRows(data, lane);
        return acc;
      },
      {} as Record<RevenueLane, LedgerMetricRow[]>
    );
  }, [data]);

  const chartOption = useMemo(() => {
    if (!data || !chart || !chart.series.length) return null;
    const cur = data.currency;
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v: number) => (v == null ? 'n/a' : formatMetric(v, 'revenue', cur)),
      },
      legend: { top: 0, type: 'scroll', textStyle: { fontSize: 11 } },
      grid: { left: 76, right: 24, top: 54, bottom: 52 },
      xAxis: {
        type: 'category',
        data: chart.dates.map((d) => d.slice(5)),
        axisLabel: { rotate: 35, interval: 'auto', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        name: `${data.currency || 'value'} per day, per lane`,
        nameTextStyle: { fontSize: 10, align: 'left' },
        nameGap: 14,
        axisLabel: { formatter: (v: number) => formatMoney(v, cur), fontSize: 10 },
      },
      series: chart.series.map((s) => ({
        name: s.label,
        type: 'bar',
        // stack id = lane. Stacks WITHIN a lane, groups ACROSS lanes, so the
        // three lanes stand side by side and never pile into one column.
        stack: s.lane,
        barMaxWidth: 22,
        itemStyle: laneItemStyle(s.lane, s.color),
        data: s.data,
      })),
    } as any;
  }, [data, chart]);

  if (isLoading) return <SectionSkeleton title="Loading revenue ledger…" />;
  if (error) {
    return (
      <div className="rounded-lg border border-signal-critical/20 bg-signal-critical/10 p-6 text-sm text-signal-critical">
        Error: {error.message}
      </div>
    );
  }
  if (!data) return null;

  const anyRows = LANE_ORDER.some((lane) => (laneRows?.[lane]?.length ?? 0) > 0);
  if (data.coverage === 'not_yet_enabled' || !anyRows) {
    return (
      <EmptyOpsPanel
        reason="Revenue ledger not yet available for this plant"
        suggestion="The nightly revenue assurance job writes the measured, declared and benchmark lanes once a BESS asset has telemetry or a dispatch history. Nothing is estimated in the meantime."
      />
    );
  }

  const { kpis, provenance, currency } = data;
  const bmProvenance = provenance['revenue_measured_bm'] ?? null;
  const bmTotal = data.ledger.measured.totals['revenue_measured_bm'] ?? null;
  const ceiling = kpis.benchmark_arbitrage_ceiling;
  const periodLabel =
    data.resolutionMinutes != null && data.periodsPerDay != null
      ? `${data.periodsPerDay} settlement periods per day (${data.resolutionMinutes} min)`
      : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-divider bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-ink">Revenue ledger</h2>
            <p className="mt-0.5 text-sm text-ink-3">
              {data.plant.name ?? data.plant.slug ?? plantSlug}
              {data.plant.ratedMw != null && ` · ${data.plant.ratedMw} MW`}
              {data.plant.energyCapacityMwh != null && ` · ${data.plant.energyCapacityMwh} MWh`}
              {data.window.from && ` · ${data.window.from} to ${data.window.to}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-paper-2 px-2 py-0.5 font-mono text-[10px] text-ink-2">
              {COVERAGE_LABEL[data.coverage] ?? data.coverage}
            </span>
            {currency && (
              <span className="rounded-full bg-paper-2 px-2 py-0.5 font-mono text-[10px] text-ink-2">
                {currency}
              </span>
            )}
            {data.zone && (
              <span className="rounded-full bg-paper-2 px-2 py-0.5 font-mono text-[10px] text-ink-2">
                {data.zone}
              </span>
            )}
            {data.priceSource && (
              <span className="rounded-full bg-paper-2 px-2 py-0.5 font-mono text-[10px] text-ink-2">
                {data.priceSource}
              </span>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          Three lanes of one ledger. They are shown side by side and are never added into a single
          number: the same megawatt hour can sit behind a measured settlement and a contracted
          availability payment, so a combined total would count it twice. The only derived figure
          here is the gap versus the benchmark.
        </p>
        {periodLabel && <p className="mt-1 text-[11px] text-ink-3">{periodLabel}</p>}
      </div>

      {/* KPI band. Gap first, then per-lane figures. No grand total. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <LedgerKpi
          tone="headline"
          title="Revenue gap versus benchmark"
          value={formatMetric(kpis.revenue_gap, 'revenue', currency)}
          subtitle={
            kpis.realized_net != null
              ? `Realized net ${formatMetric(kpis.realized_net, 'revenue', currency)}`
              : undefined
          }
          caption={
            provenance['revenue_gap']?.caption ??
            'Perfect foresight ceiling minus realized net, on the same days and prices.'
          }
        />
        {kpis.capture_ratio != null && ceiling != null && (
          <LedgerKpi
            title="Capture rate"
            value={formatMetric(kpis.capture_ratio, 'ratio', currency)}
            subtitle={`Denominator ${formatMetric(ceiling, 'revenue', currency)}${
              data.priceSource ? `, solved from ${data.priceSource}` : ''
            }`}
            caption={
              kpis.capture_ratio_caption ??
              'Share of the perfect foresight ceiling that was realized. The ceiling is unreachable by construction.'
            }
          />
        )}
        {kpis.measured_energy_value != null && (
          <LedgerKpi
            title="Measured lane, discharge energy value"
            value={formatMetric(kpis.measured_energy_value, 'revenue', currency)}
            subtitle={
              kpis.measured_charge_cost != null
                ? `Charging cost ${formatMetric(kpis.measured_charge_cost, 'revenue', currency)}`
                : undefined
            }
            caption={provenance['revenue_measured_energy']?.caption}
          />
        )}
        {kpis.declared_contracted != null && (
          <LedgerKpi
            title="Declared lane, contracted"
            value={formatMetric(kpis.declared_contracted, 'revenue', currency)}
            subtitle="From the contract layer"
            caption="What the contracts say this asset is paid over the window. Contracted, not measured."
          />
        )}
      </div>

      {/* The credibility artifact: BM revenue rebuilt from public settlement data. */}
      {bmProvenance && (
        <div className="rounded-xl border border-divider bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">
                Balancing mechanism, rebuilt from public settlement data
              </h3>
              <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-ink-2">
                {bmProvenance.caption}
              </p>
              <p className="mt-1.5 max-w-[70ch] text-[11px] leading-relaxed text-ink-3">
                Nothing about this line came from the operator. It is the published Elexon
                acceptance stack for the declared BMU, priced and summed the way settlement does,
                so it can be held against their own settlement statement line by line.
              </p>
            </div>
            {bmTotal != null && (
              <div className="text-right">
                <div className="font-mono text-2xl font-bold text-ink">
                  {formatMetric(bmTotal, 'revenue', currency)}
                </div>
                <div className="mt-0.5 flex justify-end gap-1">
                  <span className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
                    {bmProvenance.source}
                  </span>
                  <span className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
                    {bmProvenance.model_version}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Daily ledger chart */}
      {chartOption && (
        <div className="rounded-xl border border-divider bg-white p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">Daily ledger by lane</h3>
            <div className="flex flex-wrap items-center gap-3">
              {(chart?.lanes ?? []).map((lane) => (
                <span
                  key={lane}
                  className="inline-flex items-center gap-1.5 text-[11px] text-ink-2"
                  title={LANE_STYLE[lane].hint}
                >
                  <LaneChip lane={lane} color={LANE_TONE[lane]} />
                  {LANE_STYLE[lane].label}
                </span>
              ))}
            </div>
          </div>
          <ReactECharts
            option={chartOption}
            style={{ height: 360, width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge
          />
          <p className="mt-1.5 text-[10px] leading-snug text-ink-3">
            One column per lane per day. Bars stack inside a lane only. Costs, energy volumes and
            ratios stay out of the stack and are listed below instead.
          </p>
        </div>
      )}

      {/* Lane ledger with provenance */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {LANE_ORDER.map((lane) => {
          const rows = laneRows?.[lane] ?? [];
          const laneNotes = data.ledger[lane]?.notes ?? [];
          return (
            <div key={lane} className="rounded-xl border border-divider bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <LaneChip lane={lane} color={LANE_TONE[lane]} />
                <h3 className="text-sm font-semibold text-ink">{LANE_STYLE[lane].label}</h3>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-ink-3">{LANE_STYLE[lane].hint}</p>

              {rows.length === 0 ? (
                <p className="mt-3 text-xs text-ink-3">
                  {laneNotes[0] ?? 'No rows in this lane for the window.'}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {rows.map((row) => (
                    <div key={row.metric}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="h-2 w-2 shrink-0 rounded-sm"
                            style={{ background: row.color }}
                          />
                          <span className="truncate text-[11.5px] text-ink-2" title={row.label}>
                            {row.label}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-[12px] font-semibold text-ink">
                          {formatMetric(row.total, row.klass, currency)}
                        </span>
                      </div>
                      {row.provenance?.caption && (
                        <p className="mt-0.5 text-[10px] leading-snug text-ink-3">
                          {row.provenance.caption}
                        </p>
                      )}
                      <ProvenanceChips row={row} />
                    </div>
                  ))}
                </div>
              )}

              {rows.length > 0 && laneNotes.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-divider pt-2">
                  {laneNotes.map((note, i) => (
                    <li key={i} className="text-[10px] leading-snug text-ink-3">
                      {note}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* Run notes */}
      {data.notes.length > 0 && (
        <div className="rounded-xl border border-divider bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-ink">Ledger notes</h3>
          <ul className="space-y-1">
            {data.notes.map((note, i) => (
              <li key={i} className="text-[11px] leading-snug text-ink-2">
                {note}
              </li>
            ))}
          </ul>
          {data.generatedAt && (
            <p className="mt-2 font-mono text-[10px] text-ink-3">Generated {data.generatedAt}</p>
          )}
        </div>
      )}
    </div>
  );
}
