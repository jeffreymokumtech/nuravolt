'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

interface TicketUpdateDraft {
  ticket_id: string;
  title: string;
  current_status: string;
  new_status: string;
  reason?: string | null;
}

/**
 * Draft-and-confirm card for proposeTicketUpdate. Confirming PATCHes the ticket
 * through the same /api/tickets/[id] route the kanban uses (transition guard,
 * history entry, webhook); nothing happens until the user clicks.
 */
export function DraftTicketUpdateCard({ draft }: { draft: TicketUpdateDraft }) {
  const isScripted = useIsScriptedThread();
  const [reason, setReason] = useState(draft.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(draft.ticket_id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: draft.new_status, change_reason: reason || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDone(true);
      toast.success(`Ticket moved to ${draft.new_status.replace('_', ' ')}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the ticket');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">Ticket updated</div>
        <div className="mt-1 text-gray-700">
          &ldquo;{draft.title}&rdquo; is now {draft.new_status.replace('_', ' ')}.
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-blue-700">
        Draft ticket update · review &amp; confirm
      </div>
      <div className="mb-2 text-gray-800">
        <span className="font-medium">{draft.title}</span>
      </div>
      <div className="mb-2 flex items-center gap-2 font-mono text-[11px]">
        <span className="rounded bg-white px-1.5 py-0.5 text-gray-600 ring-1 ring-gray-200">
          {draft.current_status}
        </span>
        <span className="text-gray-400">→</span>
        <span className="rounded bg-white px-1.5 py-0.5 text-blue-700 ring-1 ring-blue-200">
          {draft.new_status}
        </span>
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        disabled={isScripted}
        className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[11px]"
      />
      <div className="flex items-center justify-end gap-2">
        {isScripted && (
          <span className="mr-auto text-[10px] text-amber-700">Example session, actions disabled</span>
        )}
        <button
          type="button"
          onClick={apply}
          disabled={isScripted || busy}
          title={isScripted ? 'Example session' : undefined}
          className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Updating…' : `Move to ${draft.new_status.replace('_', ' ')}`}
        </button>
      </div>
    </div>
  );
}
