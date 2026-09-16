'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

interface ScheduleDraft {
  plant_id: string;
  plant_slug?: string;
  plant_name?: string;
  dates: string[];
  rationale: string;
  estimated_energy_recovered_mwh?: number;
  estimated_revenue_recovered_eur?: number;
  estimated_cleaning_cost_eur?: number;
}

/**
 * Draft-and-confirm card for proposeCleaningSchedule. Confirming persists the
 * plan through the same adopt API the soiling page's optimizer tab uses
 * (CleaningSchedule row, optional maintenance tickets); nothing happens until
 * the user clicks.
 */
export function DraftScheduleCard({ draft }: { draft: ScheduleDraft }) {
  const isScripted = useIsScriptedThread();
  const [dates, setDates] = useState<string[]>(draft.dates);
  const [withTickets, setWithTickets] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adoptedMsg, setAdoptedMsg] = useState<string | null>(null);

  const removeDate = (i: number) => setDates(dates.filter((_, idx) => idx !== i));
  const plantRef = draft.plant_slug ?? draft.plant_id;

  const adopt = async () => {
    setBusy(true);
    try {
      // Cost fallback: the API requires a positive cost; without economics in
      // the draft, assume the optimizer defaults (150 EUR/MW on a 5 MW plant).
      const cost =
        draft.estimated_cleaning_cost_eur && draft.estimated_cleaning_cost_eur > 0
          ? draft.estimated_cleaning_cost_eur
          : dates.length * 750;
      const res = await fetch(
        `/api/soiling/plants/${encodeURIComponent(plantRef)}/cleaning-schedules`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scheduleName: 'Shams recommended plan',
            dates,
            estimatedEnergyRecoveredMwh: draft.estimated_energy_recovered_mwh ?? 0,
            estimatedRevenueRecoveredEur: draft.estimated_revenue_recovered_eur ?? 0,
            estimatedCleaningCostEur: cost,
            createTickets: withTickets,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const nTickets = json.data?.ticketIds?.length ?? 0;
      setAdoptedMsg(
        withTickets && nTickets
          ? `Plan adopted with ${nTickets} maintenance tickets.`
          : 'Plan adopted.',
      );
      toast.success('Cleaning plan adopted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not adopt the plan');
    } finally {
      setBusy(false);
    }
  };

  const copyDates = async () => {
    try {
      await navigator.clipboard.writeText(dates.join('\n'));
      toast.success('Dates copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  if (adoptedMsg) {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">Cleaning plan adopted</div>
        <div className="mt-1 text-gray-700">
          {adoptedMsg} See it on the soiling page under Cleaning optimiser.
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-purple-300 bg-purple-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-purple-700">
          Draft cleaning schedule · review &amp; confirm
        </span>
        <span className="text-[10px] text-gray-500">
          {draft.plant_name ?? draft.plant_slug ?? draft.plant_id}
        </span>
      </div>

      <ul className="mb-3 space-y-1">
        {dates.map((d, i) => (
          <li
            key={i}
            className="flex items-center justify-between rounded border border-gray-300 bg-white px-2 py-1"
          >
            <span className="font-mono text-gray-900">{d}</span>
            <button
              onClick={() => removeDate(i)}
              className="text-[10px] text-gray-500 hover:text-red-600"
              title="Remove"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <p className="mb-3 text-[11px] leading-relaxed text-gray-600">
        <span className="font-medium text-gray-800">Rationale:</span> {draft.rationale}
      </p>

      <div className="flex items-center justify-end gap-2">
        {isScripted && (
          <span className="mr-auto text-[10px] text-amber-700">Example session, actions disabled</span>
        )}
        <label className="flex items-center gap-1 text-[10px] text-gray-600">
          <input
            type="checkbox"
            checked={withTickets}
            onChange={(e) => setWithTickets(e.target.checked)}
            disabled={isScripted}
            className="h-3 w-3 rounded border-gray-300"
          />
          Create tickets
        </label>
        <button
          type="button"
          onClick={copyDates}
          disabled={dates.length === 0}
          className="rounded border border-purple-300 bg-white px-2.5 py-1 text-[11px] font-medium text-purple-700 hover:bg-purple-100 disabled:opacity-50"
        >
          Copy dates
        </button>
        <button
          type="button"
          onClick={adopt}
          disabled={dates.length === 0 || isScripted || busy}
          title={isScripted ? 'Example session' : undefined}
          className="rounded bg-purple-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Adopting…' : `Adopt ${dates.length} cleanings`}
        </button>
      </div>
    </div>
  );
}
