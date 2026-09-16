'use client';

import { useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useAuditJson } from './useAuditData';
import AuditProvenanceBanner from './AuditProvenanceBanner';
import SoHSecondOpinion from './SoHSecondOpinion';
import type { WarrantyDossier } from './types';
import { AuditCard, AuditPageHeader, KpiStat, SeverityChip, fmtPct, fmtNum } from './AuditUi';
import WarrantyTracker, { type WarrantyRow } from '@/components/ops/charts/WarrantyTracker';
import SoHProjectionChart, { type SoHPoint } from '@/components/ops/charts/SoHProjectionChart';
import RainflowHistogram from '@/components/ops/charts/RainflowHistogram';
import SectionSkeleton from '@/components/SectionSkeleton';

const COMPONENT_LABELS: Record<string, string> = {
  soh: 'State of health',
  cycles: 'Cycle budget',
  time: 'Calendar age',
  efficiency: 'Round-trip efficiency',
  violations: 'Violations',
};

function toYearFraction(iso: string): number {
  const d = new Date(iso);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const end = Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return d.getUTCFullYear() + (d.getTime() - start) / (end - start);
}

/**
 * Warranty and degradation dossier: health score, warranty budget
 * consumption, SoH trajectory vs the contractual floor, rainflow cycle
 * accounting, and the violations register.
 */
export default function WarrantyEvidenceSection() {
  const { data, provenance, source, loading } = useAuditJson<WarrantyDossier>('warranty_dossier.json');
  const params = useParams();
  const plantId = params.plantId as string;

  const sohPoints: SoHPoint[] = useMemo(() => {
    if (!data) return [];
    const asOf = new Date(data.generated_at ?? data.evidence.telemetry_profile.end).getTime();
    return data.soh_trajectory.points.map((p) => ({
      year: toYearFraction(p.date),
      soh: p.soh,
      measured: new Date(p.date).getTime() <= asOf,
    }));
  }, [data]);

  if (loading) return <SectionSkeleton title="Loading warranty dossier..." />;
  if (!data) {
    return (
      <AuditCard title="Warranty dossier not available">
        <p className="text-sm text-ink-2">No warranty dossier is attached to this plant.</p>
      </AuditCard>
    );
  }

  const { asset, warranty_terms: terms, health_score: hs, cycling, soh_trajectory: soh } = data;
  const violations = data.violations;
  const criticalCount = violations.filter((v) => v.severity.toLowerCase() === 'critical').length;
  const yearsElapsed = terms.warranty_years - hs.years_remaining;
  const rteMarginUsed = Math.max(
    0,
    Math.min(1, 1 - (cycling.avg_round_trip_efficiency - terms.min_rte) / 0.1)
  );

  const trackerRows: WarrantyRow[] = [
    {
      label: 'Capacity guarantee',
      value: `${fmtPct(hs.current_soh)} vs ${fmtPct(terms.capacity_guarantee_pct, 0)} floor`,
      fraction: (1 - hs.current_soh) / (1 - terms.capacity_guarantee_pct),
      tone: hs.soh_margin > 0.1 ? 'ok' : 'warn',
      tooltip: [
        { label: 'current SoH', value: fmtPct(hs.current_soh) },
        { label: 'contract floor', value: fmtPct(terms.capacity_guarantee_pct, 0) },
        { label: 'margin', value: `${(hs.soh_margin * 100).toFixed(1)}pp` },
      ],
    },
    {
      label: 'Cycle budget',
      value: `${fmtNum(hs.cycles_used)} / ${fmtNum(terms.max_cycles, 0)} EFC`,
      fraction: hs.cycles_used / terms.max_cycles,
      tone: 'ok',
      tooltip: [
        { label: 'used', value: `${fmtNum(hs.cycles_used)} EFC` },
        { label: 'remaining', value: `${fmtNum(hs.cycles_remaining)} EFC` },
      ],
    },
    {
      label: 'Calendar term',
      value: `${yearsElapsed.toFixed(1)} / ${terms.warranty_years} yr`,
      fraction: yearsElapsed / terms.warranty_years,
      tone: 'bess',
      tooltip: [
        { label: 'elapsed', value: `${yearsElapsed.toFixed(1)} yr` },
        { label: 'remaining', value: `${hs.years_remaining.toFixed(1)} yr` },
      ],
    },
    {
      label: 'Round-trip efficiency',
      value: `${fmtPct(cycling.avg_round_trip_efficiency)} vs ${fmtPct(terms.min_rte, 0)} min`,
      fraction: rteMarginUsed,
      tone: rteMarginUsed > 0.6 ? 'warn' : 'ok',
      tooltip: [
        { label: 'measured avg', value: fmtPct(cycling.avg_round_trip_efficiency) },
        { label: 'warranty minimum', value: fmtPct(terms.min_rte, 0) },
      ],
    },
  ];

  return (
    <>
      <AuditPageHeader
        live={source === 'database'}
        eyebrow="NuraVolt Audit · Warranty"
        title="Warranty and degradation dossier"
        subtitle={`${asset.name} · ${asset.chemistry.toUpperCase()} · ${fmtNum(
          asset.nominal_power_kw / 1000
        )} MW / ${fmtNum(asset.nominal_capacity_kwh / 1000)} MWh${
          asset.installation_date ? `, in service since ${asset.installation_date.slice(0, 10)}` : ''
        }. Cycle counts, SoH trajectory, and violations reconstructed independently from telemetry, so every claim in this dossier can be re-derived.`}
      />

      <AuditProvenanceBanner provenance={provenance} />
      {source === 'database' && (
        <div className="mb-4">
          <a
            href={`/api/bess/plants/${plantId}/audit/pdf?file=dossier`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-divider bg-white px-3 py-1.5 text-[12.5px] text-ink hover:bg-slate-50"
          >
            Download dossier PDF (regenerated weekly)
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiStat
          label="Warranty health score"
          value={`${hs.score}/100`}
          detail={hs.recommendation}
          tone={hs.score >= 80 ? 'positive' : 'warning'}
        />
        <KpiStat
          label="Current SoH"
          value={fmtPct(hs.current_soh)}
          detail={`${(hs.soh_margin * 100).toFixed(1)}pp above the ${fmtPct(
            terms.capacity_guarantee_pct,
            0
          )} contractual floor`}
          tone="bess"
        />
        <KpiStat
          label="Equivalent full cycles"
          value={fmtNum(cycling.total_equivalent_cycles)}
          detail={`${fmtNum(cycling.total_throughput_mwh)} MWh throughput in the audit window`}
        />
        <KpiStat
          label="Violations"
          value={String(violations.length)}
          detail={`${criticalCount} critical against contractual operating limits`}
          tone={criticalCount > 0 ? 'negative' : 'positive'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AuditCard title="Warranty budget consumption" meta="hover rows for detail">
          <WarrantyTracker
            rows={trackerRows}
            projectedBreach={
              <>
                <span>Projected floor crossing</span>
                <span className="ops-num">
                  {soh.projected_threshold_crossing
                    ? soh.projected_threshold_crossing.slice(0, 10)
                    : 'none within warranty term'}
                </span>
              </>
            }
          />
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(hs.component_scores).map(([key, score]) => (
              <div key={key} className="rounded-lg border border-divider bg-paper p-2.5">
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                  {COMPONENT_LABELS[key] ?? key}
                </div>
                <div
                  className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
                    score >= 80 ? 'text-signal-positive' : score >= 50 ? 'text-signal-warning' : 'text-red-600'
                  }`}
                >
                  {score}/100
                </div>
              </div>
            ))}
          </div>
        </AuditCard>

        <AuditCard
          title="Cycle-depth distribution (rainflow)"
          meta={`ASTM E1049 on SoC · ${fmtNum(cycling.total_equivalent_cycles)} EFC total`}
        >
          <RainflowHistogram
            bars={cycling.rainflow_histogram.map((b) => ({ label: b.dod_bin, count: b.cycles }))}
            height={180}
          />
          <p className="mt-3 text-xs text-ink-3">
            Shallow cycling dominates: most counted cycles sit below 20% depth of discharge,
            which is consistent with the low equivalent-cycle consumption above.
          </p>
        </AuditCard>
      </div>

      <AuditCard
        title="SoH trajectory vs warranty floor"
        meta={`semi-empirical fade model · capacity tests override model values`}
      >
        <SoHProjectionChart
          points={sohPoints}
          warrantyFloor={soh.warranty_threshold}
          yRange={[soh.warranty_threshold, 1.0]}
          yLabels={['100%', '90%', '80%', `${Math.round(soh.warranty_threshold * 100)}%`]}
          height={260}
        />
        {soh.capacity_tests.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Capacity test</th>
                  <th className="px-3 py-1.5 font-medium">Date</th>
                  <th className="px-3 py-1.5 font-medium">Measured capacity</th>
                  <th className="px-3 py-1.5 font-medium">SoH</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider text-ink-2">
                {soh.capacity_tests.map((tst) => (
                  <tr key={tst.date}>
                    <td className="px-3 py-1.5">{tst.test_type.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-1.5 font-mono">{tst.date.slice(0, 10)}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">
                      {fmtNum(tst.measured_capacity_kwh, 0)} kWh
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">{fmtPct(tst.soh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-ink-3">
          Model assumptions: {fmtNum(soh.assumptions.cycles_per_year, 0)} cycles/yr, average cell
          temperature {soh.assumptions.avg_temp_c.toFixed(1)}°C, average depth of discharge{' '}
          {fmtPct(soh.assumptions.avg_dod, 0)}.
        </p>
      </AuditCard>

      <SoHSecondOpinion dossier={data} />

      <AuditCard
        title="Violations register"
        meta={`${violations.length} events against contractual operating limits`}
      >
        <div className="max-h-[420px] overflow-auto rounded-lg border border-divider">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="sticky top-0 bg-paper-2 font-mono text-[10px] uppercase tracking-wider text-ink-3">
              <tr>
                {['Started', 'Type', 'Severity', 'Duration', 'Measured', 'Limit', 'Description'].map((hdr) => (
                  <th key={hdr} className="whitespace-nowrap px-3 py-2 font-medium">
                    {hdr}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider text-ink-2">
              {violations.map((v, i) => (
                <tr key={`${v.started_at}-${i}`}>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                    {v.started_at.replace('T', ' ').slice(0, 16)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                    {v.type.replace(/_/g, ' ').toLowerCase()}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    <SeverityChip severity={v.severity} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {v.duration_minutes >= 60
                      ? `${(v.duration_minutes / 60).toFixed(1)} h`
                      : `${v.duration_minutes} min`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {fmtNum(v.measured_value)} {v.unit}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                    {fmtNum(v.threshold_value)} {v.unit}
                  </td>
                  <td className="min-w-[260px] px-3 py-1.5">{v.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AuditCard>

      <AuditCard title="Evidence base and methodology" meta="what this dossier stands on">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Telemetry rows', fmtNum(data.evidence.telemetry_profile.rows, 0)],
            ['Window start', data.evidence.telemetry_profile.start.slice(0, 10)],
            ['Window end', data.evidence.telemetry_profile.end.slice(0, 10)],
            ['Interval', `${Math.round(data.evidence.telemetry_profile.median_interval_seconds / 60)} min`],
            ['Gaps', fmtNum(data.evidence.telemetry_profile.gap_count, 0)],
            ['Coverage', fmtPct(data.evidence.telemetry_profile.coverage, 1)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-divider bg-paper p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-ink">{value}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-ink-2">{data.evidence.methodology}</p>
      </AuditCard>
    </>
  );
}
