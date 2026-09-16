'use client';

import { AuditCard } from './AuditUi';
import type { WarrantyDossier } from './types';

/**
 * Independent SoH second opinion: the platform's tracked SoH next to the
 * latest capacity-test result and the chemistry model's projection for
 * today, with the divergence in percentage points. Renders only when a real
 * capacity test exists — without one there is no second, independent number
 * to compare and the panel would be circular. When the platform estimate is
 * calibrated on those same tests the caption says so.
 */
export default function SoHSecondOpinion({ dossier }: { dossier: WarrantyDossier }) {
  const tests = dossier.soh_trajectory.capacity_tests ?? [];
  const usable = tests.filter((t) => ['standard', 'partial'].includes(t.test_type));
  if (!usable.length) return null;

  const latestTest = usable[usable.length - 1];
  const platformSoh = dossier.health_score.current_soh;

  // Model projection at the point nearest today.
  const now = Date.now();
  const nearest = [...dossier.soh_trajectory.points].sort(
    (a, b) => Math.abs(new Date(a.date).getTime() - now) - Math.abs(new Date(b.date).getTime() - now),
  )[0];

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const divergence = (a: number, b: number) => {
    const d = (a - b) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}pp`;
  };

  const columns = [
    {
      label: 'Platform estimate',
      value: pct(platformSoh),
      note: 'Warranty tracker state (calibrated on the capacity tests below)',
    },
    {
      label: `Capacity test (${latestTest.date.slice(0, 10)})`,
      value: pct(latestTest.soh),
      note: `${latestTest.test_type} test · ${Math.round(latestTest.measured_capacity_kwh).toLocaleString()} kWh measured`,
    },
    ...(nearest
      ? [
          {
            label: 'Chemistry model, today',
            value: pct(nearest.soh),
            note: `Empirical ${dossier.asset.chemistry.toUpperCase()} degradation model at current cycling and age`,
          },
        ]
      : []),
  ];

  return (
    <AuditCard title="SoH second opinion">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {columns.map((c) => (
          <div key={c.label} className="rounded-lg border border-divider p-3">
            <div className="text-[11px] uppercase tracking-wide text-ink-2">{c.label}</div>
            <div className="mt-1 font-mono text-xl text-ink">{c.value}</div>
            <div className="mt-1 text-[11.5px] leading-snug text-ink-2">{c.note}</div>
          </div>
        ))}
      </div>
      {nearest && (
        <p className="mt-3 text-[12px] text-ink-2">
          Model vs latest test: {divergence(nearest.soh, latestTest.soh)}. A model
          running ahead of the tests suggests harder-than-assumed duty; behind
          suggests conservative assumptions. The platform estimate is not fully
          independent of the capacity tests — an independent verification needs
          BMS or meter telemetry.
        </p>
      )}
    </AuditCard>
  );
}
