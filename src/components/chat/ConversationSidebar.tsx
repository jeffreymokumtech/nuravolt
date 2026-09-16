'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';

interface Conv {
  id: string;
  title: string;
  pinned: boolean;
  plant_id: string | null;
  updated_at: string;
}

export function ConversationSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [conversations, setConversations] = useState<Conv[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/chat/conversations')
      .then((r) => r.json())
      .then((d) => setConversations(d.conversations ?? []))
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
  }, [pathname]);

  const newChat = async () => {
    const r = await fetch('/api/chat/conversations', { method: 'POST' });
    const d = await r.json();
    if (d.conversation?.id) router.push(`/chat/${d.conversation.id}`);
  };

  return (
    <aside className="flex h-full w-64 flex-col border-r border-gray-200 bg-gray-50">
      <div className="border-b border-gray-200 p-3">
        <button
          onClick={newChat}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          + New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-xs text-gray-500">Loading…</div>
        ) : conversations.length === 0 ? (
          <div className="p-3 text-xs text-gray-500">No conversations yet.</div>
        ) : (
          <ul className="space-y-0.5 p-2">
            {conversations.map((c) => {
              const active = pathname === `/chat/${c.id}`;
              return (
                <li key={c.id}>
                  <Link
                    href={`/chat/${c.id}`}
                    className={[
                      'block truncate rounded-md px-3 py-2 text-sm',
                      active
                        ? 'bg-white text-gray-900 shadow-sm border border-gray-200'
                        : 'text-gray-700 hover:bg-white',
                    ].join(' ')}
                    title={c.title}
                  >
                    {c.pinned && (
                      <span className="mr-1 text-amber-500">★</span>
                    )}
                    {c.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
