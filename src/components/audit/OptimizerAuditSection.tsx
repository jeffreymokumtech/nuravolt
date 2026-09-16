'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuditJson } from './useAuditData';
import AuditProvenanceBanner from './AuditProvenanceBanner';
import type { OptimizerAudit } from './types';
import { AuditCard, AuditPageHeader, KpiStat, fmtEur, fmtPct, fmtNum } from './AuditUi';
import DailyCaptureBars from './charts/DailyCaptureBars';
import SampleDayChart from './charts/SampleDayChart';
import SectionSkeleton from '@/components/SectionSkeleton';

type SampleKey = 'largest_gap' | 'median_gap';

/**
 * Optimizer performance audit: realized dispatch revenue vs a
 * perfect-foresight LP benchmark on identical prices and constraints.
 */
export default function OptimizerAuditSection() {
  const { data, provenance, source, loading } = useAuditJson<OptimizerAudit>('optimizer_audit.json');
  const [sampleKey, setSampleKey] = useState<SampleKey>('largest_gap');
  const params = useParams();
  const plantId = params.plantId as string;

  if (loading) return <SectionSkeleton title="Loading optimizer audit..." />;
  if (!data) {
    return (
      <AuditCard title="Optimizer audit not available">
        <p className="text-sm text-ink-2">No optimizer audit bundle is attached to this plant.</p>
      </AuditCard>
    );
  }

  const s = data.summary;
  const sample = data.sample_days[sampleKey];
  const okDays = data.daily.filter((d) => d.status === 'ok');

  return (
    <>
      <AuditPageHeader
        live={source === 'database'}
        eyebrow="NuraVolt Audit · Optimizer"
        title="Optimizer performance audit"
        subtitle={`${s.days_analyzed} days of dispatch for ${s.asset_name} benchmarked against a perfect-foresight optimum on ${s.price_source} day-ahead prices (zone ${s.zone}), with round-trip efficiency ${fmtPct(
          s.round_trip_efficiency, 0
        )} and the same power and energy limits the asset actually has.`}
      />

      <AuditProvenanceBanner provenance={provenance} />
      {source === 'database' && (
        <div className="mb-4">
          <a
            href={`/api/bess/plants/${plantId}/audit/pdf?file=optimizer`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-divider bg-white px-3 py-1.5 text-[12.5px] text-ink hover:bg-slate-50"
          >
            Download audit PDF (regenerated weekly)
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiStat
          label="Realized net revenue"
          value={fmtEur(s.realized_net_eur)}
          detail={`${s.days_analyzed} audited days (${s.days_skipped} skipped for coverage)`}
          tone="bess"
        />
        <KpiStat
          label="Optimal benchmark"
          value={fmtEur(s.optimal_net_eur)}
          detail="Perfect-foresight LP on the same prices and constraints"
        />
        <KpiStat
          label="Capture ratio"
          value={fmtPct(s.capture_ratio)}
          detail={`Gap ${fmtEur(s.revenue_gap_eur)} · annualized ${fmtEur(s.annualized_gap_eur)}`}
          tone={s.capture_ratio >= 0.8 ? 'positive' : 'warning'}
        />
        <KpiStat
          label="Cycling intensity"
          value={`${fmtNum(s.realized_efc_total)} EFC`}
          detail={`Optimal would have used ${fmtNum(s.optimal_efc_total)} EFC in the window`}
        />
      </div>

      <AuditCard
        title="Daily realized vs benchmark net revenue"
        meta={`${okDays.length} trading days · hover for detail`}
      >
        <DailyCaptureBars days={data.daily} />
      </AuditCard>

      <AuditCard
        title={sampleKey === 'largest_gap' ? 'Largest-gap day' : 'Median-gap day'}
        meta={
          <div className="flex items-center gap-2">
            <span>
              {sample.day} · gap {fmtEur(sample.gap_eur)}
            </span>
            <div className="inline-flex rounded-md border border-divider bg-gray-100 p-0.5">
              {(
                [
                  ['largest_gap', 'Largest gap'],
                  ['median_gap', 'Median gap'],
                ] as [SampleKey, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSampleKey(key)}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    sampleKey === key ? 'bg-white text-ink shadow-sm' : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <SampleDayChart sample={sample} />
        <p className="mt-3 text-xs text-ink-3">
          Where the violet line diverges from the dashed optimum, the strategy charged or
          discharged into the wrong price hours. The grey line is the day-ahead price the
          benchmark trades against.
        </p>
      </AuditCard>

      <AuditCard title="Daily register" meta="full audit window, one row per day">
        <div className="max-h-[420px] overflow-auto rounded-lg border border-divider">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="sticky top-0 bg-paper-2 font-mono text-[10px] uppercase tracking-wider text-ink-3">
              <tr>
                {['Day', 'Status', 'Realized €', 'Optimal €', 'Capture', 'EFC r/o', 'Spread r/o €/MWh', 'Coverage'].map(
                  (hdr) => (
                    <th key={hdr} className="whitespace-nowrap px-3 py-2 font-medium">
                      {hdr}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider">
              {data.daily.map((d) => (
                <tr key={d.day} className={d.status !== 'ok' ? 'text-ink-3' : 'text-ink-2'}>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">{d.day}</td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {d.status === 'ok' ? 'ok' : 'skipped'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {d.realized_net_eur.toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {d.optimal_net_eur.toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {d.capture_ratio != null ? fmtPct(d.capture_ratio) : 'n/a'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {d.realized_efc.toFixed(2)} / {d.optimal_efc.toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {d.realized_spread_eur_mwh != null && d.optimal_spread_eur_mwh != null
                      ? `${d.realized_spread_eur_mwh.toFixed(1)} / ${d.optimal_spread_eur_mwh.toFixed(1)}`
                      : 'n/a'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {fmtPct(d.coverage, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AuditCard>

      <AuditCard title="Methodology and data integrity" meta="reproducible by construction">
        <div className="grid grid-cols-1 gap-4 text-sm text-ink-2 md:grid-cols-2">
          <p>
            The benchmark is a linear program with perfect price foresight, constrained to the
            asset&apos;s real limits: {fmtNum(s.max_power_kw)} kW, {fmtNum(s.capacity_kwh)} kWh,
            round-trip efficiency {fmtPct(s.round_trip_efficiency, 0)}
            {s.degradation_cost_per_kwh != null
              ? `, and a degradation cost of €${s.degradation_cost_per_kwh.toFixed(3)}/kWh throughput`
              : ''}
            . It is an upper bound: no live trader hits it, which is why the headline metric is
            the capture ratio, not the absolute gap.
          </p>
          <p>
            Prices come from {s.price_source} for bidding zone {s.zone}. Days with insufficient
            telemetry coverage are excluded rather than interpolated ({s.days_skipped} skipped).
            The SoC ledger reconstructed from power flows deviates from the reported SoC by a
            mean absolute {fmtNum(s.soc_ledger_mismatch_mean_abs_kwh)} kWh, quoted so you can
            judge measurement quality yourself.
          </p>
        </div>
      </AuditCard>
    </>
  );
}
