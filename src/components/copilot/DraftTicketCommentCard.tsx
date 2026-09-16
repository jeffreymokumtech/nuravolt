'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useIsScriptedThread } from '@/components/chat/demo/ScriptedThreadContext';

interface TicketCommentDraft {
  ticket_id: string;
  title: string;
  content: string;
}

/**
 * Draft-and-confirm card for proposeTicketComment. Confirming POSTs to
 * /api/tickets/[id]/comments; nothing happens until the user clicks.
 */
export function DraftTicketCommentCard({ draft }: { draft: TicketCommentDraft }) {
  const isScripted = useIsScriptedThread();
  const [content, setContent] = useState(draft.content);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(draft.ticket_id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setDone(true);
      toast.success('Comment added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add the comment');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="my-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs">
        <div className="font-medium text-emerald-700">Comment added</div>
        <div className="mt-1 text-gray-700">Added to &ldquo;{draft.title}&rdquo;.</div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-blue-700">
        Draft comment · review &amp; confirm
      </div>
      <div className="mb-2 text-gray-800">
        <span className="font-medium">{draft.title}</span>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        disabled={isScripted}
        className="mb-3 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[11px]"
      />
      <div className="flex items-center justify-end gap-2">
        {isScripted && (
          <span className="mr-auto text-[10px] text-amber-700">Example session, actions disabled</span>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={isScripted || busy || content.trim().length < 2}
          className="rounded bg-blue-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add comment'}
        </button>
      </div>
    </div>
  );
}
