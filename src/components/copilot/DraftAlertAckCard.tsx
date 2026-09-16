'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

interface AlertAckDraft {
  alert_id: string;
  plant_id: string;
  plant_slug?: string;
  plant_name?: string;
  alert_kind: string;
  severity: string;
  message: string;
  action: 'acknowledge' | 'resolve';
  already_acknowledged?: boolean;
}

/**
 * Draft-and-confirm card for proposeAlertAck. Confirming PATCHes the alert
 * lifecycle route (acknowledge keeps the alert active but marks it seen;
 * resolve closes it; a persisting condition raises a fresh alert).
 */
export function DraftAlertAckCard({ draft }: { draft: AlertAckDraft }) {
  const isScripted = useIsScriptedThread();
  const [busy, setBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const verb = draft.action === 'resolve' ? 'Resolve' : 'Acknowledge';
  const plantRef = draft.plant_slug ?? draft.plant_id;

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/plants/${encodeURIComponent(plantRef)}/alerts/${draft.alert_id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: draft.action }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDoneMsg(
        draft.action === 'resolve'
          ? 'Alert resolved. If the condition persists, the next evaluation raises a fresh alert.'
          : `Alert acknowledged by ${json.data?.acknowledged_by ?? 'you'}. It stays active until resolved.`,
      );
      toast.success(`Alert ${draft.action === 'resolve' ? 'resolved' : 'acknowledged'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (doneMsg) {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">{verb}d</div>
        <div className="mt-1 text-gray-700">{doneMsg}</div>
      </div>
    );
  }

  const critical = draft.severity === 'CRITICAL';

  return (
    <div className="my-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-amber-700">
          {verb} alert · review &amp; confirm
        </span>
        <span className="text-[10px] text-gray-500">
          {draft.plant_name ?? draft.plant_slug ?? draft.plant_id}
        </span>
      </div>

      <div className="mb-3 rounded border border-gray-300 bg-white px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase ${
              critical ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
            }`}
          >
            {draft.severity}
          </span>
          <span className="font-mono text-[10px] text-gray-500">{draft.alert_kind}</span>
        </div>
        <div className="mt-1 text-gray-800">{draft.message}</div>
        {draft.already_acknowledged && draft.action === 'acknowledge' && (
          <div className="mt-1 text-[10px] text-gray-500">
            Already acknowledged; confirming again is a no-op.
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {isScripted && (
          <span className="mr-auto text-[10px] text-amber-700">Example session, actions disabled</span>
        )}
        <button
          type="button"
          onClick={confirm}
          disabled={busy || isScripted}
          title={isScripted ? 'Example session' : undefined}
          className="rounded bg-amber-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Working…' : `${verb} alert`}
        </button>
      </div>
    </div>
  );
}
