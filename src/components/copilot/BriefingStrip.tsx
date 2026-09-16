'use client';

import { useEffect, useState } from 'react';
import { useCopilot } from '@/components/copilot/CopilotProvider';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

interface Briefing {
  bullets: string[];
  generatedAt: string;
  scope: { plantId?: string | null; inverterId?: string | null };
}

const TTL_MS = 30 * 60 * 1000; // 30 min per asset

function cacheKey(plantId?: string, inverterId?: string): string {
  return `copilot_briefing:${plantId ?? '-'}:${inverterId ?? '-'}`;
}

function readCache(plantId?: string, inverterId?: string): Briefing | null {
  try {
    const raw = localStorage.getItem(cacheKey(plantId, inverterId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Briefing;
    if (Date.now() - new Date(parsed.generatedAt).getTime() > TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(b: Briefing) {
  try {
    localStorage.setItem(cacheKey(b.scope.plantId ?? undefined, b.scope.inverterId ?? undefined), JSON.stringify(b));
  } catch {}
}

export function BriefingStrip() {
  const { pageContext, seedNextMessage } = useCopilot();
  const { plantId, inverterId } = pageContext;
  const surface = usePlantRoutePrefix();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!plantId) {
      setBriefing(null);
      setError(null);
      return;
    }

    // Public showcase: the briefing API 401s for anonymous visitors, so the
    // strip reads authored fixture bullets instead (leak-lint: this /data
    // fetch only ever fires on the /showcase surface).
    if (surface === '/showcase') {
      setLoading(true);
      setError(null);
      fetch(`/data/showcase/briefings/${plantId}.json`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = (await r.json()) as Briefing;
          if (!Array.isArray(d.bullets) || d.bullets.length === 0) throw new Error('no bullets');
          // Stamp at render so the strip reads as fresh, not as a stale file.
          setBriefing({ ...d, generatedAt: new Date().toISOString() });
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'failed'))
        .finally(() => setLoading(false));
      return;
    }

    const cached = readCache(plantId, inverterId);
    if (cached) {
      setBriefing(cached);
      return;
    }

    setLoading(true);
    setError(null);
    fetch('/api/chat/briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: inverterId ? 'inverter' : 'plant',
        plantId,
        inverterId,
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!d.briefing) throw new Error('no briefing');
        setBriefing(d.briefing);
        writeCache(d.briefing);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed'))
      .finally(() => setLoading(false));
  }, [plantId, inverterId, surface]);

  if (!plantId) return null;

  if (loading) {
    return (
      <div className="border-b border-gray-200 bg-blue-50 px-4 py-2 text-[11px] text-blue-700">
        Generating briefing for this {inverterId ? 'inverter' : 'plant'}…
      </div>
    );
  }

  if (error || !briefing) {
    return null; // Silent: a briefing is a nice-to-have, not a blocker.
  }

  return (
    <div className="border-b border-gray-200 bg-blue-50/50 px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-blue-700">
        <span>Briefing · what to look at</span>
        <span className="text-gray-500">{new Date(briefing.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <ul className="space-y-1.5 text-xs text-gray-800">
        {briefing.bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-blue-500" />
            <button
              type="button"
              onClick={() => seedNextMessage(`Tell me more about: ${b}`)}
              className="flex-1 cursor-pointer text-left hover:text-blue-700"
              title="Discuss this in chat"
            >
              {b}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
