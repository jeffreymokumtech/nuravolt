'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Siren } from 'lucide-react';
import QualityCard from './QualityCard';
import StatusDot from './StatusDot';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  type QualityTone,
} from './constants';

/**
 * OpenIncidentsCard — the plant's open data-quality incidents with a Close
 * action (PATCH .../incidents/{id}), completing the incident lifecycle in
 * the UI. Renders nothing when the list is empty or the caller isn't
 * signed in (the incidents API is org-gated) — an incidents section that
 * can't load should not take up space with an error.
 */

interface Incident {
  id: string;
  summary: string;
  severity: 'low' | 'medium' | 'high' | string;
  opened_at: string;
  opened_by: string;
  ticket_id: string | null;
}

interface OpenIncidentsCardProps {
  plantId: string;
  /** Bump to refetch (e.g. after drafting a ticket). */
  refreshKey?: number;
  onClosed?: (incident: Incident) => void;
  onError?: (message: string) => void;
}

const SEVERITY_TONE: Record<string, QualityTone> = {
  low: 'info',
  medium: 'warn',
  high: 'alarm',
};

function formatRelative(ts: string): string {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function OpenIncidentsCard({
  plantId,
  refreshKey = 0,
  onClosed,
  onError,
}: OpenIncidentsCardProps) {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/quality/plants/${encodeURIComponent(plantId)}/incidents?status=open`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) setIncidents(null);
          return;
        }
        const json = (await res.json()) as { incidents?: Incident[] };
        if (!cancelled) setIncidents(json.incidents ?? []);
      } catch {
        if (!cancelled) setIncidents(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plantId, refreshKey]);

  const handleClose = useCallback(
    async (incident: Incident) => {
      setClosingIds((prev) => new Set(prev).add(incident.id));
      // Optimistic removal; restore on failure.
      setIncidents((list) => (list ? list.filter((i) => i.id !== incident.id) : list));
      try {
        const res = await fetch(
          `/api/quality/plants/${encodeURIComponent(plantId)}/incidents/${encodeURIComponent(incident.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolve_ticket: true }),
          },
        );
        if (res.ok) {
          onClosed?.(incident);
        } else {
          setIncidents((list) => (list ? [incident, ...list] : [incident]));
          onError?.('Failed to close incident');
        }
      } catch {
        setIncidents((list) => (list ? [incident, ...list] : [incident]));
        onError?.('Failed to close incident');
      } finally {
        setClosingIds((prev) => {
          const next = new Set(prev);
          next.delete(incident.id);
          return next;
        });
      }
    },
    [plantId, onClosed, onError],
  );

  if (!incidents || incidents.length === 0) return null;

  return (
    <QualityCard title="Open incidents" icon={Siren}>
      <div>
        {incidents.map((incident) => {
          const tone = SEVERITY_TONE[incident.severity] ?? 'warn';
          const closing = closingIds.has(incident.id);
          return (
            <div
              key={incident.id}
              className="flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0"
              style={{ borderColor: QUALITY_COLORS.border.light, opacity: closing ? 0.6 : 1 }}
            >
              <div className="shrink-0 pt-1">
                <StatusDot tone={tone} size={8} pulse={incident.severity === 'high'} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm" style={{ color: QUALITY_COLORS.text.primary }}>
                  {incident.summary}
                </p>
                <p
                  className="mt-0.5 text-[11px]"
                  style={{ color: QUALITY_COLORS.text.muted }}
                >
                  opened {formatRelative(incident.opened_at)} by{' '}
                  <span style={{ fontFamily: QUALITY_MONO }}>{incident.opened_by}</span>
                  {incident.ticket_id && (
                    <>
                      {' · '}
                      <span style={{ fontFamily: QUALITY_MONO }}>
                        ticket {incident.ticket_id.slice(0, 8)}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <button
                type="button"
                disabled={closing}
                onClick={() => void handleClose(incident)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border bg-white px-2 py-1 text-[11px] font-medium transition-colors hover:bg-gray-50 disabled:opacity-50"
                style={{
                  borderColor: QUALITY_COLORS.border.DEFAULT,
                  color: QUALITY_COLORS.text.primary,
                }}
                title="Close this incident (also resolves the linked ticket)"
              >
                <CheckCircle2 className="h-3 w-3" />
                Close
              </button>
            </div>
          );
        })}
      </div>
    </QualityCard>
  );
}
