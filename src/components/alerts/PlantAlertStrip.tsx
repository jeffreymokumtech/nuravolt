'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, BookOpen, Check, OctagonAlert, X } from 'lucide-react';

/**
 * Active-alert strip for the plant overview: one row per open PlantAlert,
 * red for CRITICAL, amber for WARNING, each deep-linking to the section
 * that explains it. Acknowledge and resolve persist through
 * PATCH /api/plants/[plantId]/alerts/[alertId]; acknowledged alerts render
 * dimmed with the acknowledger's name. Renders nothing while loading or
 * when all clear. Alerts enriched by the doc agent carry a "per the manual"
 * action line with its documentation source.
 */

interface AlertRow {
  id: string;
  kind: string;
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  triggered_at: string;
  acknowledged_at?: string | null;
  acknowledged_by?: string | null;
  manual_guidance?: {
    text: string;
    source_title: string;
    source_section: string;
    source_url?: string | null;
  } | null;
}

const KIND_LINK: Record<string, string> = {
  SOILING_LOSS: '/soiling',
  PERFORMANCE_RATIO: '',
  DATA_STALE: '/datahub',
  CRITICAL_FAULT: '/faults',
  CONTRACT_OBLIGATION: '/contracts',
};

export default function PlantAlertStrip({ plantId }: { plantId: string }) {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/plants/${plantId}/alerts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAlerts(d?.active ?? []))
      .catch(() => {});
  }, [plantId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (alertId: string, action: 'acknowledge' | 'resolve') => {
    setBusyId(alertId);
    // Optimistic: ack dims in place, resolve drops the row.
    setAlerts((prev) =>
      action === 'resolve'
        ? prev.filter((a) => a.id !== alertId)
        : prev.map((a) =>
            a.id === alertId
              ? { ...a, acknowledged_at: new Date().toISOString(), acknowledged_by: 'you' }
              : a,
          ),
    );
    try {
      const res = await fetch(`/api/plants/${plantId}/alerts/${alertId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) load(); // roll back optimistic state on failure
      else if (action === 'acknowledge') load(); // pick up the real "ack by" name
    } catch {
      load();
    } finally {
      setBusyId(null);
    }
  };

  if (alerts.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {alerts.map((a) => {
        const critical = a.severity === 'CRITICAL';
        const acked = Boolean(a.acknowledged_at);
        const Icon = critical ? OctagonAlert : AlertTriangle;
        return (
          <div
            key={a.id}
            className="rounded-md border px-3 py-2 font-mono text-[12px]"
            style={{
              background: critical ? 'var(--ops-alarm-bg, #fef2f2)' : 'var(--ops-warn-bg, #fffbeb)',
              borderColor: critical ? 'var(--ops-alarm-border, #fecaca)' : 'var(--ops-warn-border, #fde68a)',
              color: critical ? 'var(--ops-alarm, #dc2626)' : 'var(--ops-warn, #d97706)',
              opacity: acked ? 0.6 : 1,
            }}
          >
            <span className="flex items-center gap-2.5">
              <Icon size={14} aria-hidden />
              <Link
                href={`/dashboard/plant/${plantId}${KIND_LINK[a.kind] ?? ''}`}
                className="flex-1 transition-opacity hover:opacity-80"
              >
                {a.message}
              </Link>
              <span className="text-[10px] uppercase tracking-wider opacity-70">
                {acked
                  ? `ack by ${a.acknowledged_by ?? 'operator'}`
                  : `since ${new Date(a.triggered_at).toLocaleDateString()}`}
              </span>
              {!acked && (
                <button
                  type="button"
                  onClick={() => act(a.id, 'acknowledge')}
                  disabled={busyId === a.id}
                  title="Acknowledge: mark as seen, keeps the alert active"
                  className="inline-flex items-center gap-1 rounded border bg-white/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-opacity hover:opacity-80 disabled:opacity-40"
                  style={{ borderColor: 'currentColor' }}
                >
                  <Check size={10} aria-hidden /> Ack
                </button>
              )}
              <button
                type="button"
                onClick={() => act(a.id, 'resolve')}
                disabled={busyId === a.id}
                title="Resolve: closes this alert; a persisting condition raises a new one"
                className="inline-flex items-center gap-1 rounded border bg-white/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ borderColor: 'currentColor' }}
              >
                <X size={10} aria-hidden /> Resolve
              </button>
            </span>
            {a.manual_guidance ? (
              <span
                className="mt-1.5 flex items-start gap-2 border-t pt-1.5 text-[11px] leading-snug"
                style={{
                  borderColor: critical
                    ? 'var(--ops-alarm-border, #fecaca)'
                    : 'var(--ops-warn-border, #fde68a)',
                  color: 'var(--ops-ink-soft, #475569)',
                }}
              >
                <BookOpen size={12} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  {a.manual_guidance.text}{' '}
                  <span className="opacity-60">({a.manual_guidance.source_section})</span>
                </span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
