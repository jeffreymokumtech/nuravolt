'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { DemoThread } from '@/fixtures/demo-conversations/types';
import { threadsForPlant, flagshipThreads } from '@/fixtures/demo-conversations/registry';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * "Example sessions" chip list for the rail's empty state. On the demo and
 * showcase surfaces it shows the current plant's threads; on the
 * authenticated dashboard it shows the curated flagship list (replayed
 * read-only over demo data — the honesty label says so). Threads are TS
 * fixtures loaded lazily — no network fetch.
 */
export function ExampleSessions({
  plantSlug,
  onOpen,
}: {
  plantSlug: string | null | undefined;
  onOpen: (threads: DemoThread[], thread: DemoThread) => void;
}) {
  const prefix = usePlantRoutePrefix();
  const [threads, setThreads] = useState<DemoThread[]>([]);

  const isDashboard = prefix === '/dashboard';
  const loader = isDashboard ? flagshipThreads : threadsForPlant(plantSlug);

  useEffect(() => {
    let alive = true;
    if (!loader) {
      setThreads([]);
      return;
    }
    loader().then((t) => {
      if (alive) setThreads(t);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantSlug, prefix]);

  if (!loader || threads.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
        <Sparkles className="h-3 w-3 text-amber-500" aria-hidden />
        {isDashboard ? 'See Shams in action (demo data)' : 'Example sessions'}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {threads.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpen(threads, t)}
            className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-[11px] font-medium text-gray-700 shadow-sm hover:border-amber-400 hover:text-amber-800"
          >
            {t.title}
          </button>
        ))}
      </div>
    </div>
  );
}
