'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, History, Search } from 'lucide-react';
import QualityCard from './QualityCard';
import QualitySkeleton from './QualitySkeleton';
import StatusDot from './StatusDot';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  type QualityTone,
} from './constants';

/**
 * CurationLogCard, audit-trail table for data-quality curation actions.
 *
 * Renders a chronological log of operator interventions (acknowledgements,
 * KPI exclusions, satellite fallbacks, sensor swaps, resets, etc.) against
 * specific data streams. Light-system table with client-side search, an
 * action filter and CSV export.
 *
 * Data: always fetches the live log (`/api/quality/plants/{plantId}/
 * curation-log`) when a plant is in scope; `fallbackEntries` (fixture data)
 * only render when the live log has nothing — otherwise real operator
 * actions would never appear.
 */

export interface CurationEntry {
  ts: string;
  actor: string;
  action:
    | 'acknowledge'
    | 'exclude_from_kpi'
    | 'satellite_fallback_engaged'
    | 'sensor_swapped'
    | 'reset'
    | 'incident_opened'
    | 'incident_closed'
    | string;
  stream_id: string;
  reason: string;
}

interface CurationLogCardProps {
  plantId?: string;
  maxRows?: number;
  /**
   * Fixture entries to show ONLY when the live curation-log fetch yields
   * nothing (demo plants / persistence not applied). The live route always
   * runs first — otherwise real operator acknowledge/exclude/incident
   * actions would never appear in the log.
   */
  fallbackEntries?: CurationEntry[];
  /** Bump to force a refetch (e.g. after an operator action). */
  refreshKey?: number;
}

interface CurationLogResponse {
  plant_id: string;
  generated_at: string;
  entries: CurationEntry[];
  coverage?: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const PERSISTENCE_FALLBACK_MESSAGE =
  'Curation log will populate once the persistence layer migration is applied.';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Compute a compact relative timestamp ("2h ago", "3d ago"). Falls back to
 * the raw ISO string if parsing fails so the operator can still see *some*
 * trace of the event time.
 */
function formatRelative(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;

  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';

  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;

  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;

  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;

  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

interface ActionStyle {
  tone: QualityTone;
  label: string;
}

/**
 * Map known curation actions to a tone + display label. Unknown actions
 * default to "muted" so the table never throws and unfamiliar actions remain
 * legible.
 */
function getActionStyle(action: string): ActionStyle {
  switch (action) {
    case 'acknowledge':
      return { tone: 'info', label: 'ACK' };
    case 'exclude_from_kpi':
      return { tone: 'warn', label: 'EXCLUDE' };
    case 'satellite_fallback_engaged':
      return { tone: 'info', label: 'SAT FALLBACK' };
    case 'sensor_swapped':
      return { tone: 'warn', label: 'SENSOR SWAP' };
    case 'reset':
      return { tone: 'muted', label: 'RESET' };
    case 'incident_opened':
      return { tone: 'warn', label: 'INCIDENT OPEN' };
    case 'incident_closed':
      return { tone: 'info', label: 'INCIDENT CLOSED' };
    default:
      return { tone: 'muted', label: action.replace(/_/g, ' ').toUpperCase() };
  }
}

const TONE_TEXT: Record<QualityTone, string> = {
  ok: '#047857',
  warn: '#B45309',
  alarm: '#B91C1C',
  info: '#1D4ED8',
  muted: '#6B7280',
};

/** Escape a value for a CSV cell. */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function exportCsv(entries: CurationEntry[], plantId: string | undefined) {
  const header = 'timestamp,actor,action,stream_id,reason';
  const lines = entries.map((e) =>
    [e.ts, e.actor, e.action, e.stream_id, e.reason ?? ''].map(csvCell).join(','),
  );
  const blob = new Blob([`${header}\n${lines.join('\n')}\n`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `curation-log-${plantId ?? 'plant'}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

const STREAM_MAX = 32;
const REASON_MAX = 80;

const ACTION_FILTERS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'acknowledge', label: 'Acks' },
  { id: 'exclude_from_kpi', label: 'Exclusions' },
  { id: 'incident', label: 'Incidents' },
];

export default function CurationLogCard({
  plantId,
  maxRows,
  fallbackEntries,
  refreshKey = 0,
}: CurationLogCardProps) {
  // Always fetch the live log when a plant is in scope. (A previous version
  // skipped the fetch whenever the caller passed entries — and the only
  // caller always did, so real DB-backed curation actions were never shown.)
  const shouldFetch = Boolean(plantId);

  const [fetchedEntries, setFetchedEntries] = useState<CurationEntry[] | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(shouldFetch);
  const [persistenceFallback, setPersistenceFallback] =
    useState<boolean>(false);
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('all');

  useEffect(() => {
    if (!shouldFetch || !plantId) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    let cancelled = false;
    setIsLoading(true);
    setPersistenceFallback(false);

    const limit = maxRows ?? 50;
    const url = `/api/quality/plants/${encodeURIComponent(
      plantId,
    )}/curation-log?days=30&limit=${limit}`;

    (async () => {
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          cache: 'no-store',
        });

        // 500 → treat as persistence-not-applied fallback.
        if (res.status === 500) {
          if (!cancelled) {
            setFetchedEntries([]);
            setPersistenceFallback(true);
            setIsLoading(false);
          }
          return;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const json = (await res.json()) as CurationLogResponse;
        if (cancelled) return;

        if (json.coverage === 'persistence_not_yet_applied') {
          setFetchedEntries([]);
          setPersistenceFallback(true);
        } else {
          setFetchedEntries(json.entries ?? []);
          setPersistenceFallback(false);
        }
        setIsLoading(false);
      } catch {
        if (!cancelled) {
          // Network / abort / parse failure, degrade to empty + persistence
          // fallback message so the surface always shows something useful.
          setFetchedEntries([]);
          setPersistenceFallback(true);
          setIsLoading(false);
        }
      } finally {
        window.clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [shouldFetch, plantId, maxRows, refreshKey]);

  // Live entries win; fixture fallback only when the live log has nothing.
  const usingFallback =
    (!fetchedEntries || fetchedEntries.length === 0) &&
    Boolean(fallbackEntries?.length);
  const sourceEntries: CurationEntry[] | null =
    fetchedEntries && fetchedEntries.length > 0
      ? fetchedEntries
      : fallbackEntries?.length
        ? fallbackEntries
        : fetchedEntries;

  const rows = useMemo<CurationEntry[]>(() => {
    if (!sourceEntries) return [];
    // Sort newest-first; copy first to avoid mutating the caller's array.
    const sorted = [...sourceEntries].sort((a, b) => {
      const ta = Date.parse(a.ts);
      const tb = Date.parse(b.ts);
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
    const capped =
      typeof maxRows === 'number' ? sorted.slice(0, maxRows) : sorted;

    const q = query.trim().toLowerCase();
    return capped.filter((r) => {
      if (actionFilter === 'incident') {
        if (!r.action.startsWith('incident')) return false;
      } else if (actionFilter !== 'all' && r.action !== actionFilter) {
        return false;
      }
      if (!q) return true;
      return (
        r.stream_id.toLowerCase().includes(q) ||
        r.actor.toLowerCase().includes(q) ||
        (r.reason ?? '').toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q)
      );
    });
  }, [sourceEntries, maxRows, query, actionFilter]);

  // Loading state, only when we're actually fetching and have nothing yet.
  if (isLoading && !sourceEntries) {
    return <QualitySkeleton title="Loading curation log…" />;
  }

  // Persistence-fallback message: only when persistence is missing AND we
  // have no entries to fall back on (no fixture passed via `entries`).
  if (persistenceFallback && rows.length === 0 && !query && actionFilter === 'all') {
    return (
      <div
        className="rounded-xl border bg-white p-4 text-xs leading-relaxed"
        style={{
          borderColor: QUALITY_COLORS.border.DEFAULT,
          color: QUALITY_COLORS.text.secondary,
        }}
      >
        {PERSISTENCE_FALLBACK_MESSAGE}
      </div>
    );
  }

  const hasAnyEntries = (sourceEntries?.length ?? 0) > 0;

  return (
    <QualityCard
      title="Curation log · last 30 days"
      icon={History}
      headerRight={
        hasAnyEntries ? (
          <>
            {usingFallback && (
              <span
                className="rounded border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider"
                style={{
                  color: QUALITY_COLORS.text.secondary,
                  background: QUALITY_COLORS.background.section,
                  borderColor: QUALITY_COLORS.border.DEFAULT,
                }}
              >
                demo fixture
              </span>
            )}
            <div
              className="flex items-center gap-1 rounded-md border px-2 py-1"
              style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
            >
              <Search className="h-3 w-3" style={{ color: QUALITY_COLORS.text.muted }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search stream, actor, reason"
                className="w-40 bg-transparent text-[11px] outline-none placeholder:text-gray-400"
                style={{ color: QUALITY_COLORS.text.primary }}
              />
            </div>
            <div className="flex items-center gap-0.5">
              {ACTION_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setActionFilter(f.id)}
                  className="rounded px-1.5 py-1 text-[10px] font-medium"
                  style={{
                    background:
                      actionFilter === f.id
                        ? QUALITY_COLORS.primary.light
                        : 'transparent',
                    color:
                      actionFilter === f.id
                        ? QUALITY_COLORS.primary.dark
                        : QUALITY_COLORS.text.secondary,
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => exportCsv(rows, plantId)}
              title="Export the filtered log as CSV"
              className="inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] font-medium hover:bg-gray-50"
              style={{
                borderColor: QUALITY_COLORS.border.DEFAULT,
                color: QUALITY_COLORS.text.secondary,
              }}
            >
              <Download className="h-3 w-3" /> CSV
            </button>
          </>
        ) : undefined
      }
      padded
    >
      {rows.length === 0 ? (
        <p className="py-2 text-xs" style={{ color: QUALITY_COLORS.text.secondary }}>
          {hasAnyEntries
            ? 'No entries match the current filter.'
            : 'No curation actions in the last 30 days.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {['', 'WHEN', 'ACTOR', 'ACTION', 'STREAM', 'REASON'].map((h, i) => (
                  <th
                    key={i}
                    className="border-b px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                    style={{
                      color: QUALITY_COLORS.text.muted,
                      borderColor: QUALITY_COLORS.border.DEFAULT,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const style = getActionStyle(r.action);
                return (
                  <tr key={`${r.ts}-${r.stream_id}-${idx}`} className="hover:bg-gray-50">
                    <td
                      className="border-b px-2 py-1.5"
                      style={{ borderColor: QUALITY_COLORS.border.light, width: 18 }}
                    >
                      <StatusDot tone={style.tone} size={7} />
                    </td>
                    <td
                      className="whitespace-nowrap border-b px-2 py-1.5 text-[11px]"
                      style={{
                        borderColor: QUALITY_COLORS.border.light,
                        color: QUALITY_COLORS.text.muted,
                      }}
                      title={r.ts}
                    >
                      {formatRelative(r.ts)}
                    </td>
                    <td
                      className="border-b px-2 py-1.5"
                      style={{ borderColor: QUALITY_COLORS.border.light }}
                    >
                      <span
                        className="inline-block rounded border px-1.5 py-[1px] text-[11px]"
                        style={{
                          fontFamily: QUALITY_MONO,
                          background: QUALITY_COLORS.background.section,
                          color: QUALITY_COLORS.text.primary,
                          borderColor: QUALITY_COLORS.border.DEFAULT,
                        }}
                        title={r.actor}
                      >
                        {r.actor}
                      </span>
                    </td>
                    <td
                      className="whitespace-nowrap border-b px-2 py-1.5 text-[11px] uppercase tracking-[0.04em]"
                      style={{
                        fontFamily: QUALITY_MONO,
                        borderColor: QUALITY_COLORS.border.light,
                        color: TONE_TEXT[style.tone],
                      }}
                      title={r.action}
                    >
                      {style.label}
                    </td>
                    <td
                      className="border-b px-2 py-1.5 text-[11px]"
                      style={{
                        fontFamily: QUALITY_MONO,
                        borderColor: QUALITY_COLORS.border.light,
                        color: QUALITY_COLORS.text.primary,
                      }}
                      title={r.stream_id}
                    >
                      {truncate(r.stream_id, STREAM_MAX)}
                    </td>
                    <td
                      className="border-b px-2 py-1.5 text-xs"
                      style={{
                        borderColor: QUALITY_COLORS.border.light,
                        color: QUALITY_COLORS.text.primary,
                      }}
                      title={r.reason}
                    >
                      {truncate(r.reason ?? '', REASON_MAX)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </QualityCard>
  );
}
