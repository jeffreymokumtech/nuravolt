'use client';

import { useEffect, useMemo, useState } from 'react';
import OpsPanel from '@/components/ops/OpsPanel';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import OpsTable from '@/components/ops/OpsTable';
import OpsFooter from '@/components/ops/OpsFooter';
import OpsLineChart from '@/components/ops/charts/OpsLineChart';
import OpsTimeRange, { type TimeRange } from '@/components/ops/OpsTimeRange';
import EmptyOpsPanel from '@/components/ops/EmptyOpsPanel';
import { useDataRoot } from '@/contexts/DataSourceContext';

interface OpsFinancialsProps {
  plantId: string;
}

interface PlantFinancials {
  ppa_price_per_MWh: number;
  budget_generation_MWh: number;
  actual_generation_MWh: number;
  budget_deviation_pct: number;
  annual_opex_eur: number;
  soiling_loss_eur: number;
  fault_loss_eur: number;
  degradation_loss_eur: number;
  curtailment_loss_eur: number;
  total_loss_eur: number;
  availability_pct: number;
  performance_ratio: number;
  revenue_at_risk_eur: number;
  annual_revenue_eur: number;
  ytd_revenue_eur: number;
}

interface MonthlyPoint {
  month: string;
  budget_MWh: number;
  actual_MWh: number;
  deviation_pct: number;
}

interface PortfolioFinancial {
  plants: Array<{
    plantId: string;
    plantName: string;
    financials: PlantFinancials;
    monthlyGeneration: MonthlyPoint[];
  }>;
}

export default function OpsFinancials({ plantId }: OpsFinancialsProps) {
  const dataRoot = useDataRoot();
  const [data, setData] = useState<PortfolioFinancial | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState<TimeRange>('1y');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`${dataRoot}/portfolio_financial.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => alive && setData(j))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [dataRoot]);

  const plant = useMemo(() => {
    if (!data?.plants) return null;
    return (
      data.plants.find((p) => p.plantId === plantId) ||
      data.plants.find((p) => p.plantName.toLowerCase() === plantId.toLowerCase()) ||
      data.plants[0]
    );
  }, [data, plantId]);

  const monthsToShow = range === '1y' ? 12 : range === '90d' ? 3 : range === '30d' ? 1 : 12;
  const monthly = useMemo(() => plant?.monthlyGeneration?.slice(0, monthsToShow) ?? [], [plant, monthsToShow]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
        loading financial fixtures…
      </div>
    );
  }
  if (err || !plant) {
    return (
      <EmptyOpsPanel
        reason="Financial fixture not yet onboarded"
        suggestion="This plant isn't in the portfolio financial dataset yet"
      />
    );
  }

  const f = plant.financials;
  const ebitda = f.ytd_revenue_eur - f.annual_opex_eur * 0.5; // pro-rata half-year
  const losses = [
    { label: 'Soiling', amount: f.soiling_loss_eur, tone: 'warn' as const },
    { label: 'Faults', amount: f.fault_loss_eur, tone: 'alarm' as const },
    { label: 'Degradation', amount: f.degradation_loss_eur, tone: 'info' as const },
    { label: 'Curtailment', amount: f.curtailment_loss_eur, tone: 'info' as const },
  ].filter((l) => l.amount > 0);

  return (
    <div className="space-y-3">
      <TelemetryStrip
        columns={6}
        cells={[
          {
            label: 'YTD REVENUE',
            value: `€${(f.ytd_revenue_eur / 1000).toFixed(0)}`,
            unit: 'k',
            tone: 'ok',
            footer: `PPA €${f.ppa_price_per_MWh}/MWh`,
          },
          {
            label: 'ANNUAL REV',
            value: `€${(f.annual_revenue_eur / 1000).toFixed(0)}`,
            unit: 'k',
            tone: 'neutral',
            footer: 'projected',
          },
          {
            label: 'OPEX',
            value: `€${(f.annual_opex_eur / 1000).toFixed(0)}`,
            unit: 'k',
            tone: 'neutral',
            footer: 'annual',
          },
          {
            label: 'EBITDA YTD',
            value: `€${(ebitda / 1000).toFixed(0)}`,
            unit: 'k',
            tone: ebitda > 0 ? 'ok' : 'alarm',
            footer: `${((ebitda / f.ytd_revenue_eur) * 100).toFixed(0)}% margin`,
          },
          {
            label: 'BUDGET DEV',
            value: f.budget_deviation_pct > 0 ? `+${f.budget_deviation_pct}` : `${f.budget_deviation_pct}`,
            unit: '%',
            tone: f.budget_deviation_pct >= 0 ? 'ok' : 'alarm',
            footer: 'vs plan',
          },
          {
            label: 'REV AT RISK',
            value: `€${(f.revenue_at_risk_eur / 1000).toFixed(0)}`,
            unit: 'k',
            tone: 'warn',
            footer: '12m forward',
          },
        ]}
      />

      <div className="ops-grid-2">
        <OpsPanel
          label={`Monthly generation · budget vs actual`}
          meta={
            <span className="flex items-center gap-3">
              <span style={{ color: 'var(--ops-info)' }}>fixture-backed</span>
              <OpsTimeRange value={range} onChange={setRange} options={['30d', '90d', '1y']} />
            </span>
          }
        >
          {monthly.length >= 2 ? (
            <OpsLineChart
              series={[
                { key: 'actual', label: 'Actual', tone: 'ok', values: monthly.map((m) => m.actual_MWh) },
                { key: 'budget', label: 'Budget', tone: 'muted', dashed: true, values: monthly.map((m) => m.budget_MWh) },
              ]}
              xLabels={monthly.map((m) => m.month)}
              xTooltipLabels={monthly.map((m) => `${m.month} · Δ${m.deviation_pct >= 0 ? '+' : ''}${m.deviation_pct}%`)}
              formatValue={(v) => `${(v / 1000).toFixed(1)} GWh`}
            />
          ) : (
            <div className="flex h-32 items-center justify-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
              not enough monthly points
            </div>
          )}
        </OpsPanel>

        <OpsPanel label="Loss decomposition · YTD" meta={<span>YTD foregone €</span>}>
          {losses.length > 0 ? (
            <div className="space-y-2.5">
              {losses.map((l) => (
                <div key={l.label}>
                  <div className="mb-1 flex items-baseline justify-between font-mono text-[11.5px]">
                    <span style={{ color: 'var(--ops-muted)' }}>{l.label}</span>
                    <span className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                      €{l.amount.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-[7px] overflow-hidden rounded" style={{ background: 'var(--ops-row-hair)' }}>
                    <div
                      className="h-full"
                      style={{
                        width: `${(l.amount / f.total_loss_eur) * 100}%`,
                        background: `var(--ops-${l.tone})`,
                      }}
                    />
                  </div>
                </div>
              ))}
              <div className="mt-3 flex items-baseline justify-between border-t pt-2 font-mono text-[11.5px]" style={{ borderColor: 'var(--ops-row-hair)' }}>
                <span style={{ color: 'var(--ops-muted)' }}>Total foregone</span>
                <span className="ops-num" style={{ color: 'var(--ops-alarm)' }}>
                  €{f.total_loss_eur.toLocaleString()}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
              no measured losses · all categories at zero
            </div>
          )}
        </OpsPanel>
      </div>

      <OpsPanel
        label="Monthly deviation · this fiscal year"
        meta={<span>{monthly.length} months · sort by month↓</span>}
        flush
      >
        <OpsTable
          columns={[
            { key: 'm', label: 'MONTH', render: (r) => r.month, weight: 0.6 },
            { key: 'bud', label: 'BUDGET MWh', numeric: true, render: (r) => r.budget_MWh.toLocaleString() },
            { key: 'act', label: 'ACTUAL MWh', numeric: true, render: (r) => r.actual_MWh.toLocaleString() },
            { key: 'd', label: 'Δ MWh', numeric: true, render: (r) => (r.actual_MWh - r.budget_MWh).toLocaleString() },
            {
              key: 'pct',
              label: 'Δ%',
              numeric: true,
              render: (r) => (
                <span style={{ color: r.deviation_pct >= 0 ? 'var(--ops-ok)' : 'var(--ops-alarm)' }}>
                  {r.deviation_pct >= 0 ? '+' : ''}
                  {r.deviation_pct}%
                </span>
              ),
            },
          ]}
          rows={plant.monthlyGeneration}
          status={(r) => (r.deviation_pct >= 0 ? 'ok' : r.deviation_pct >= -5 ? 'warn' : 'alarm')}
        />
      </OpsPanel>

      <OpsFooter
        pulseLabel="FINANCIALS LIVE"
        metrics={[
          { label: 'PR', value: (f.performance_ratio * 100).toFixed(1), unit: '%' },
          { label: 'AVAIL', value: f.availability_pct.toFixed(1), unit: '%' },
          { label: 'PPA', value: `€${f.ppa_price_per_MWh}`, unit: '/MWh' },
          { label: 'GEN GAP', value: `${((f.actual_generation_MWh - f.budget_generation_MWh) / 1000).toFixed(1)}`, unit: 'GWh' },
        ]}
        buildTag="real fixture"
      />
    </div>
  );
}
