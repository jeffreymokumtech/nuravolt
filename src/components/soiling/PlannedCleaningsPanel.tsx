'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format, parseISO } from 'date-fns';
import { CalendarCheck2, Trash2 } from 'lucide-react';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * The adopted cleaning plan for a plant: dates, economics, linked tickets.
 * Fed by GET /api/soiling/plants/[plantId]/cleaning-schedules; the newest
 * row is the active plan. Renders nothing when no plan has been adopted.
 */

interface PlanRow {
  id: string;
  scheduleName: string;
  dates: string[];
  nCleanings: number;
  netBenefitEur: number;
  roiPct: number;
  paybackDays: number;
  createdAt: string;
  tickets: { id: string; title: string; status: string }[];
}

export default function PlannedCleaningsPanel({
  plantId,
  refreshKey = 0,
  canManage = true,
}: {
  plantId: string;
  refreshKey?: number;
  canManage?: boolean;
}) {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [busy, setBusy] = useState(false);
  const prefix = usePlantRoutePrefix();

  const load = () =>
    fetch(`/api/soiling/plants/${encodeURIComponent(plantId)}/cleaning-schedules`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setPlans(json?.data ?? []))
      .catch(() => setPlans([]));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantId, refreshKey]);

  if (!plans.length) return null;
  const active = plans[0];
  const today = new Date().toISOString().slice(0, 10);

  const remove = async () => {
    if (!window.confirm('Remove the adopted plan? Linked tickets stay open.')) return;
    setBusy(true);
    await fetch(
      `/api/soiling/plants/${encodeURIComponent(plantId)}/cleaning-schedules?scheduleId=${active.id}`,
      { method: 'DELETE' },
    ).catch(() => null);
    setBusy(false);
    void load();
  };

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarCheck2 className="h-4 w-4 text-emerald-600" />
          <div>
            <div className="text-sm font-semibold text-gray-900">
              Adopted plan: {active.scheduleName}
            </div>
            <div className="text-xs text-gray-600">
              {active.nCleanings} cleanings · net{' '}
              {active.netBenefitEur.toLocaleString('en-US', { maximumFractionDigits: 0 })} EUR ·
              ROI {active.roiPct.toFixed(0)}% · adopted{' '}
              {format(parseISO(active.createdAt), 'MMM d, yyyy')}
            </div>
          </div>
        </div>
        {canManage && (
          <button
            onClick={remove}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
            title="Remove adopted plan"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {active.dates.map((d) => {
          const past = d < today;
          return (
            <span
              key={d}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                past
                  ? 'border-gray-200 bg-white text-gray-400 line-through'
                  : 'border-emerald-300 bg-white text-emerald-800'
              }`}
            >
              {format(parseISO(d), 'MMM d, yyyy')}
            </span>
          );
        })}
      </div>
      {active.tickets.length > 0 && (
        <div className="mt-2 text-xs text-gray-600">
          {active.tickets.length} linked ticket{active.tickets.length === 1 ? '' : 's'}:{' '}
          <Link
            href={`${prefix}/plant/${plantId}/tickets`}
            className="font-medium text-emerald-700 underline-offset-2 hover:underline"
          >
            view on the ticket board
          </Link>
        </div>
      )}
    </div>
  );
}
