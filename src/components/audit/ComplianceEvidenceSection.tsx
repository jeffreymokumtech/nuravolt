'use client';

import { useParams } from 'next/navigation';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { getCompliancePack, applicableObligations } from '@/config/compliance';
import LvrtCurveChart from '@/components/compliance/LvrtCurveChart';
import FrequencyRangeBar from '@/components/compliance/FrequencyRangeBar';
import ObligationTimeline from '@/components/compliance/ObligationTimeline';
import PrintButton from '@/components/compliance/PrintButton';
import { useAuditJson } from './useAuditData';
import type { OptimizerAudit } from './types';
import { AuditCard, AuditPageHeader, fmtNum } from './AuditUi';

/**
 * Compliance evidence pack: the grid code envelope, reporting obligations,
 * and metering policy that apply to this asset, composed from the country
 * compliance pack bound to the audited market zone. Illustrative content on
 * the demo surfaces; a paid pack is bound to the plant's real registration.
 */
export default function ComplianceEvidenceSection() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);

  // Bind the pack to the market zone the optimizer audit was priced against;
  // fall back to the Spain pack for the specimen bundle.
  const { data: optimizer } = useAuditJson<OptimizerAudit>('optimizer_audit.json');
  const country = optimizer?.summary.zone ?? 'ES';
  const pack = getCompliancePack(country) ?? getCompliancePack('ES')!;

  const capacityMw = apiPlant?.capacity_mw ? Number(apiPlant.capacity_mw) : 100;
  const obligations = applicableObligations(pack, {
    capacity_mw: capacityMw,
    asset_type: 'BESS',
  });

  const gc = pack.grid_code;

  return (
    <>
      <AuditPageHeader
        eyebrow="NuraVolt Audit · Compliance"
        title="Compliance evidence pack"
        subtitle={`Grid code envelope, reporting obligations, and metering policy for a ${fmtNum(
          capacityMw,
          0
        )} MW BESS connected in ${pack.display_name} (${pack.regulator.name} / ${pack.grid_operator.name}), pack revision ${pack.version}. Every rule cites the authoritative source text.`}
        actions={<PrintButton />}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AuditCard title="Fault ride-through envelope" meta={gc.reference}>
          {gc.lvrt_curve && gc.lvrt_curve.length > 0 ? (
            <LvrtCurveChart curve={gc.lvrt_curve} country={pack.display_name} />
          ) : (
            <p className="text-sm text-ink-2">No ride-through curve published in this pack.</p>
          )}
        </AuditCard>

        <AuditCard title="Connection envelope" meta={`stay-connected limits at the PCC`}>
          {gc.frequency_range_hz && (
            <FrequencyRangeBar
              range={gc.frequency_range_hz}
              nominal={pack.country === 'SA' ? 60 : 50}
            />
          )}
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              gc.reactive_power_range
                ? ['Reactive power range', `${gc.reactive_power_range[0]} to ${gc.reactive_power_range[1]} pf`]
                : null,
              gc.active_power_ramp_pct_per_min != null
                ? ['Max active-power ramp', `${gc.active_power_ramp_pct_per_min}% nominal/min`]
                : null,
              gc.anti_islanding_standard
                ? ['Anti-islanding standard', gc.anti_islanding_standard]
                : null,
              ['Grid code reference', gc.reference],
            ]
              .filter((x): x is [string, string] => x != null)
              .map(([label, value]) => (
                <div key={label} className="rounded-lg border border-divider bg-paper p-2.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                    {label}
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-ink">{value}</div>
                </div>
              ))}
          </div>
          {gc.notes && <p className="mt-3 text-xs text-ink-3">{gc.notes}</p>}
        </AuditCard>
      </div>

      <AuditCard
        title="Reporting obligations"
        meta={`${obligations.length} obligations apply at ${fmtNum(capacityMw, 0)} MW · BESS`}
      >
        <ObligationTimeline obligations={obligations} width={860} />
        <div className="mt-4 max-h-[320px] overflow-auto rounded-lg border border-divider">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="sticky top-0 bg-paper-2 font-mono text-[10px] uppercase tracking-wider text-ink-3">
              <tr>
                {['Obligation', 'Recipient', 'Cadence', 'Deadline', 'Source'].map((hdr) => (
                  <th key={hdr} className="whitespace-nowrap px-3 py-2 font-medium">
                    {hdr}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-divider text-ink-2">
              {obligations.map((o) => (
                <tr key={o.id}>
                  <td className="min-w-[220px] px-3 py-1.5">
                    <div className="font-medium text-ink">{o.name}</div>
                    {o.description && <div className="mt-0.5 text-ink-3">{o.description}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">{o.recipient}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                    {o.cadence.replace('_', ' ')}
                  </td>
                  {o.deadline_days_after_period != null ? (
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">
                      +{o.deadline_days_after_period}d
                    </td>
                  ) : (
                    <td className="whitespace-nowrap px-3 py-1.5 text-ink-3">Not verified</td>
                  )}
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {o.source ? (
                      <a
                        href={o.source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {o.source.clause ?? 'source'}
                      </a>
                    ) : (
                      <span className="text-ink-3">n/a</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AuditCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AuditCard title="Metering and data retention" meta="drives ingest validation and archive policy">
          <div className="grid grid-cols-2 gap-2">
            {[
              // Fields the pack has not yet verified against the source document are left out
              // rather than shown with a placeholder value.
              pack.metering.meter_class ? ['Meter class', pack.metering.meter_class] : null,
              ['Sampling interval', `${pack.metering.interval_minutes} min`],
              pack.metering.retention_years != null
                ? ['Retention', `${pack.metering.retention_years} years`]
                : null,
              pack.metering.calibration_cadence_months != null
                ? ['Calibration cadence', `${pack.metering.calibration_cadence_months} months`]
                : null,
            ]
              .filter((x): x is [string, string] => x != null)
              .map(([label, value]) => (
                <div key={label} className="rounded-lg border border-divider bg-paper p-2.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                    {label}
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-ink">{value}</div>
                </div>
              ))}
          </div>
        </AuditCard>

        <AuditCard title="Source documents" meta="audit trail to the authoritative text">
          <ul className="space-y-2 text-sm">
            {pack.source_documents.slice(0, 6).map((doc) => (
              <li key={doc.url} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-asset-bess" />
                <span>
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-blue-600 hover:underline"
                  >
                    {doc.title}
                  </a>
                  {doc.clause && <span className="text-ink-3"> · {doc.clause}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-ink-3">
            Demo surfaces show the pack for the audited market zone as illustration. A paid
            compliance evidence pack is bound to the plant&apos;s actual registration, capacity
            band, and connection agreement.
          </p>
        </AuditCard>
      </div>
    </>
  );
}
