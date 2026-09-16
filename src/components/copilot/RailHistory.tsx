'use client';

import { useEffect, useState } from 'react';
import { History, Pin, Plus, Trash2, X } from 'lucide-react';

/**
 * Conversation history panel for the Shams rail. Lists the user's recent
 * conversations (same API the /chat sidebar uses); selecting one swaps the
 * rail onto that thread with its messages hydrated.
 */

export interface RailConversation {
  id: string;
  title: string;
  plant_id: string | null;
  pinned: boolean;
  updated_at: string;
}

export function RailHistory({
  activeId,
  onSelect,
  onNew,
  onClose,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [conversations, setConversations] = useState<RailConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await fetch('/api/chat/conversations');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setConversations(Array.isArray(data.conversations) ? data.conversations : []);
    } catch {
      setConversations([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const archive = async (id: string) => {
    try {
      await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
    } catch {}
    setConversations((cs) => cs.filter((c) => c.id !== id));
    if (id === activeId) onNew();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">
          <History className="h-3.5 w-3.5" /> History
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onNew}
            className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700"
          >
            <Plus className="h-3 w-3" /> New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:text-gray-600"
            aria-label="Close history"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="px-2 py-4 text-center text-xs text-gray-400">Loading history…</div>
        ) : conversations.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-gray-400">
            No conversations yet. Ask Shams something and it will appear here.
          </div>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={[
                    'w-full rounded-md px-2.5 py-2 text-left hover:bg-gray-50',
                    c.id === activeId ? 'bg-blue-50 ring-1 ring-blue-200' : '',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-1.5">
                    {c.pinned && <Pin className="h-3 w-3 shrink-0 text-amber-500" />}
                    <span className="truncate text-xs font-medium text-gray-800">
                      {c.title || 'Conversation'}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[10px] text-gray-400">
                    {c.plant_id ? `${c.plant_id} · ` : ''}
                    {new Date(c.updated_at).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => archive(c.id)}
                  className="absolute right-1.5 top-1.5 hidden rounded p-1 text-gray-300 hover:text-red-500 group-hover:block"
                  title="Archive conversation"
                  aria-label="Archive conversation"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
