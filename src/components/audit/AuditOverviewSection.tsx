'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowRight, Gauge, FileCheck, Scale } from 'lucide-react';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { useAuditJson } from './useAuditData';
import type { OptimizerAudit, WarrantyDossier } from './types';
import { AuditCard, AuditPageHeader, KpiStat, fmtEur, fmtPct, fmtNum } from './AuditUi';
import SectionSkeleton from '@/components/SectionSkeleton';

/**
 * Audit overview: the landing page of the Audit product surface. Frames what
 * a paid audit engagement delivers and links into the two deep evidence
 * pages plus the compliance pack.
 */
export default function AuditOverviewSection() {
  const params = useParams();
  const plantId = params.plantId as string;
  const prefix = usePlantRoutePrefix();
  const base = `${prefix}/plant/${plantId}/audit`;

  const optimizer = useAuditJson<OptimizerAudit>('optimizer_audit.json');
  const dossier = useAuditJson<WarrantyDossier>('warranty_dossier.json');

  if (optimizer.loading || dossier.loading) {
    return <SectionSkeleton title="Loading audit bundle..." />;
  }
  if (!optimizer.data || !dossier.data) {
    return (
      <AuditCard title="Audit bundle not available">
        <p className="text-sm text-ink-2">
          No audit specimen is attached to this plant yet. Audit bundles are produced per
          engagement from the asset&apos;s own telemetry.
        </p>
      </AuditCard>
    );
  }

  const s = optimizer.data.summary;
  const hs = dossier.data.health_score;
  const violations = dossier.data.violations;
  const criticalCount = violations.filter((v) => v.severity.toLowerCase() === 'critical').length;

  return (
    <>
      <AuditPageHeader
        eyebrow="NuraVolt Audit"
        title="Audit overview"
        subtitle={`What a paid audit engagement delivers, shown here on a specimen bundle (${s.asset_name}, ${fmtNum(
          s.max_power_kw / 1000
        )} MW / ${fmtNum(s.capacity_kwh / 1000)} MWh). Every number below is reproducible from the asset's own telemetry: ${s.days_analyzed} days analyzed against ${s.price_source} day-ahead prices for zone ${s.zone}.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiStat
          label="Capture ratio"
          value={fmtPct(s.capture_ratio)}
          detail="Realized vs perfect-foresight optimal net revenue"
          tone={s.capture_ratio >= 0.8 ? 'positive' : 'warning'}
        />
        <KpiStat
          label="Annualized revenue gap"
          value={fmtEur(s.annualized_gap_eur)}
          detail={`${fmtEur(s.revenue_gap_eur)} left on the table over ${s.days_analyzed} audited days`}
          tone="negative"
        />
        <KpiStat
          label="Warranty health score"
          value={`${hs.score}/100`}
          detail={`Risk level ${hs.risk_level} · current SoH ${fmtPct(hs.current_soh)}`}
          tone={hs.score >= 80 ? 'positive' : 'warning'}
        />
        <KpiStat
          label="Warranty violations"
          value={String(violations.length)}
          detail={`${criticalCount} critical, ${violations.length - criticalCount} warning, in the audit window`}
          tone={criticalCount > 0 ? 'negative' : 'positive'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Link href={`${base}/optimizer`} className="group">
          <AuditCard className="h-full transition-colors group-hover:border-asset-bess/50">
            <div className="mb-3 inline-flex rounded-lg bg-violet-50 p-2.5">
              <Gauge className="h-5 w-5 text-asset-bess" />
            </div>
            <h3 className="text-base font-semibold text-ink">Optimizer performance audit</h3>
            <p className="mt-1.5 text-sm text-ink-2">
              Day-by-day realized revenue against a perfect-foresight LP benchmark on the same
              prices, efficiency, and power limits. Shows exactly where the trading strategy
              leaves money on the table.
            </p>
            <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-asset-bess">
              Open the audit <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </div>
          </AuditCard>
        </Link>

        <Link href={`${base}/warranty`} className="group">
          <AuditCard className="h-full transition-colors group-hover:border-asset-bess/50">
            <div className="mb-3 inline-flex rounded-lg bg-violet-50 p-2.5">
              <FileCheck className="h-5 w-5 text-asset-bess" />
            </div>
            <h3 className="text-base font-semibold text-ink">Warranty and degradation dossier</h3>
            <p className="mt-1.5 text-sm text-ink-2">
              Health score, rainflow cycle accounting, SoH trajectory against the contractual
              floor, and a violations register with timestamps and measured values. Evidence an
              OEM cannot wave away.
            </p>
            <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-asset-bess">
              Open the dossier <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </div>
          </AuditCard>
        </Link>

        <Link href={`${base}/compliance`} className="group">
          <AuditCard className="h-full transition-colors group-hover:border-asset-bess/50">
            <div className="mb-3 inline-flex rounded-lg bg-violet-50 p-2.5">
              <Scale className="h-5 w-5 text-asset-bess" />
            </div>
            <h3 className="text-base font-semibold text-ink">Compliance evidence pack</h3>
            <p className="mt-1.5 text-sm text-ink-2">
              Grid code envelope (ride-through, frequency window, ramp limits), the reporting
              obligations that apply to this asset, and the metering policy, ready to hand to a
              lender, buyer, or regulator.
            </p>
            <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-asset-bess">
              Open the pack <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </div>
          </AuditCard>
        </Link>
      </div>

      <AuditCard title="How an audit engagement works" meta="fixed scope · fixed price · reproducible">
        <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            [
              '1. Data handover',
              'One telemetry export (SCADA, BMS, or EMS) covering the audit window. No live integration required.',
            ],
            [
              '2. Independent reconstruction',
              'We rebuild cycles, SoC ledgers, and dispatch against market prices with published methodology, so every figure can be re-derived.',
            ],
            [
              '3. Evidence delivered',
              'You receive these pages plus a signed PDF dossier. Findings feed directly into operator negotiations, warranty claims, or financing packs.',
            ],
          ].map(([title, body]) => (
            <li key={title} className="rounded-lg border border-divider bg-paper p-4">
              <div className="text-sm font-semibold text-ink">{title}</div>
              <p className="mt-1 text-sm text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
      </AuditCard>
    </>
  );
}
