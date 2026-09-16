'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

interface TicketDraft {
  plant_id: string;
  plant_slug?: string;
  plant_name?: string;
  inverter_id: string | null;
  title: string;
  description: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  trigger_type:
    | 'SOILING_FORECAST'
    | 'PERFORMANCE_ANOMALY'
    | 'THRESHOLD_ALERT'
    | 'SCHEDULED_MAINTENANCE'
    | 'MANUAL_CREATION';
  estimated_energy_loss_kwh?: number | null;
  estimated_revenue_impact_eur?: number | null;
}

interface Props {
  draft: TicketDraft;
}

type Status = 'draft' | 'creating' | 'created' | 'dismissed' | 'error';

export function DraftTicketCard({ draft }: Props) {
  const isScripted = useIsScriptedThread();
  const [status, setStatus] = useState<Status>('draft');
  const [editable, setEditable] = useState<TicketDraft>(draft);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const create = async () => {
    setStatus('creating');
    setError(null);
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plant_id: editable.plant_id,
          inverter_id: editable.inverter_id ?? undefined,
          title: editable.title,
          description: editable.description,
          priority: editable.priority,
          trigger_type: editable.trigger_type,
          estimated_energy_loss_kwh: editable.estimated_energy_loss_kwh ?? undefined,
          estimated_revenue_impact_eur:
            editable.estimated_revenue_impact_eur ?? undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      const created = await res.json();
      setCreatedId(created.id);
      setStatus('created');
      toast.success(`Ticket created · ${created.id?.slice(0, 8) ?? ''}`);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Failed to create ticket');
      toast.error('Could not create ticket');
    }
  };

  if (status === 'created') {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">Ticket created</div>
        <div className="mt-1 text-gray-700">
          {editable.title} · {editable.priority} · plant {draft.plant_name ?? draft.plant_slug ?? draft.plant_id}
          {createdId && (
            <span className="ml-2 text-gray-500">id: {createdId.slice(0, 8)}</span>
          )}
        </div>
      </div>
    );
  }

  if (status === 'dismissed') {
    return (
      <div className="my-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
        Draft dismissed.
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-blue-700">
          Draft ticket · review &amp; confirm
        </span>
        <span className="text-[10px] text-gray-500">
          {draft.plant_name ?? draft.plant_slug ?? draft.plant_id}
          {draft.inverter_id ? ` · ${draft.inverter_id}` : ''}
        </span>
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Title</span>
        <input
          value={editable.title}
          onChange={(e) => setEditable({ ...editable, title: e.target.value })}
          disabled={status === 'creating'}
          className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
        />
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Description</span>
        <textarea
          value={editable.description}
          onChange={(e) => setEditable({ ...editable, description: e.target.value })}
          disabled={status === 'creating'}
          rows={3}
          className="w-full resize-none rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
        />
      </label>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Priority</span>
          <select
            value={editable.priority}
            onChange={(e) =>
              setEditable({ ...editable, priority: e.target.value as TicketDraft['priority'] })
            }
            disabled={status === 'creating'}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
          >
            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">Trigger</span>
          <select
            value={editable.trigger_type}
            onChange={(e) =>
              setEditable({
                ...editable,
                trigger_type: e.target.value as TicketDraft['trigger_type'],
              })
            }
            disabled={status === 'creating'}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 disabled:opacity-50"
          >
            {(
              [
                'MANUAL_CREATION',
                'PERFORMANCE_ANOMALY',
                'THRESHOLD_ALERT',
                'SOILING_FORECAST',
                'SCHEDULED_MAINTENANCE',
              ] as const
            ).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mb-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {isScripted && (
          <span className="mr-auto text-[10px] text-amber-700">Example session, actions disabled</span>
        )}
        <button
          type="button"
          onClick={() => setStatus('dismissed')}
          disabled={status === 'creating' || isScripted}
          className="rounded border border-gray-300 bg-white px-3 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={create}
          disabled={status === 'creating' || !editable.title.trim() || isScripted}
          title={isScripted ? 'Example session' : undefined}
          className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'creating' ? 'Creating…' : 'Create ticket'}
        </button>
      </div>
    </div>
  );
}
