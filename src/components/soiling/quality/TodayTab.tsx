'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Radar, Target } from 'lucide-react';
import QualityCard from './QualityCard';
import QualityEmptyState from './QualityEmptyState';
import QualitySkeleton from './QualitySkeleton';
import SlaBanner from './SlaBanner';
import FreshnessStrip from './FreshnessStrip';
import StreamHealthRow, {
  type DegradedStream,
  type StreamCurationState,
} from './StreamHealthRow';
import StreamDetailDrawer from './StreamDetailDrawer';
import ConfidenceBand from './ConfidenceBand';
import SatelliteFallbackBanner from './SatelliteFallbackBanner';
import CurationLogCard from './CurationLogCard';
import DigestCard from './DigestCard';
import OpenIncidentsCard from './OpenIncidentsCard';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  QUALITY_TONES,
  type QualityTone,
} from './constants';
import { useQualityToday } from '@/hooks/useQualityToday';

interface TodayTabProps {
  plantId: string;
}

interface Toast {
  id: number;
  message: string;
  tone: QualityTone;
}

function failureMessage(status: number | null, fallback: string): string {
  if (status === 401 || status === 403) return 'Sign-in required to curate streams';
  if (status !== null && status >= 500) return `${fallback} (queued, DB migration pending)`;
  return fallback;
}

/**
 * TodayTab — the operator's daily data-quality snapshot. Owns all curation
 * side-effects (acknowledge / exclude / incident + their undos) so the
 * stream rows and the detail drawer stay presentational and optimistic
 * state is consistent everywhere:
 *
 *   click → state flips immediately (row dims, chip appears, actions → Undo)
 *        → POST/DELETE runs in the background
 *        → failure reverts the state and reports why.
 */
export default function TodayTab({ plantId }: TodayTabProps) {
  const { data, isLoading, hasError, refresh } = useQualityToday(plantId);

  const [digest, setDigest] = useState<{
    digest: string;
    generated_at: string;
    model: string;
    cache_hit: boolean;
  } | null>(null);
  const [digestLoading, setDigestLoading] = useState(false);

  // Curation state per stream_id — seeded from the payload's open-ack/
  // open-exclusion annotations, then owned optimistically by this tab.
  const [curation, setCuration] = useState<Record<string, StreamCurationState>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [detailStream, setDetailStream] = useState<DegradedStream | null>(null);
  const [curationRefresh, setCurationRefresh] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((message: string, tone: QualityTone = 'info') => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  // Seed curation state from the payload (server-side open acks/exclusions).
  useEffect(() => {
    if (!data) return;
    const seeded: Record<string, StreamCurationState> = {};
    for (const s of data.top_degraded ?? []) {
      if (s.excluded) seeded[s.stream_id] = 'excluded';
      else if (s.acknowledged) seeded[s.stream_id] = 'acknowledged';
    }
    setCuration(seeded);
  }, [data]);

  // After the today payload lands, fire the LLM digest. Skip when coverage is
  // not_yet_enabled (no SLA → no signal to summarise) or when the today
  // fetch failed. Re-runs only when the today payload content changes.
  useEffect(() => {
    if (!data || !data.sla || data.coverage === 'not_yet_enabled') {
      setDigest(null);
      setDigestLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setDigestLoading(true);

    (async () => {
      try {
        const res = await fetch('/api/llm/quality-digest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          digest: string;
          generated_at: string;
          model: string;
          cache_hit: boolean;
        };
        if (!cancelled) {
          setDigest(json);
          setDigestLoading(false);
        }
      } catch {
        if (!cancelled) {
          setDigest(null);
          setDigestLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [data]);

  // ---------------------------------------------------------------- actions

  const setPending = useCallback((streamId: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(streamId);
      else next.delete(streamId);
      return next;
    });
  }, []);

  /** Optimistic transition helper: flip state, run the request, revert on failure. */
  const runCuration = useCallback(
    async (
      stream: DegradedStream,
      nextState: StreamCurationState,
      request: () => Promise<Response>,
      successMsg: string,
      failMsg: string,
    ) => {
      const prevState = curation[stream.stream_id] ?? 'open';
      setCuration((c) => ({ ...c, [stream.stream_id]: nextState }));
      setPending(stream.stream_id, true);
      try {
        const res = await request();
        if (res.ok) {
          pushToast(successMsg, 'ok');
          setCurationRefresh((k) => k + 1);
        } else if (res.status >= 500) {
          // Persistence missing — keep the optimistic state (demo-friendly),
          // but say so honestly.
          pushToast(failureMessage(res.status, successMsg), 'warn');
        } else {
          setCuration((c) => ({ ...c, [stream.stream_id]: prevState }));
          pushToast(failureMessage(res.status, failMsg), 'alarm');
        }
      } catch {
        setCuration((c) => ({ ...c, [stream.stream_id]: prevState }));
        pushToast(failMsg, 'alarm');
      } finally {
        setPending(stream.stream_id, false);
      }
    },
    [curation, pushToast, setPending],
  );

  const encodedPlantId = encodeURIComponent(plantId);
  const streamUrl = (stream: DegradedStream, tail: string) =>
    `/api/quality/plants/${encodedPlantId}/streams/${encodeURIComponent(stream.stream_id)}/${tail}`;

  const handleAcknowledge = useCallback(
    (stream: DegradedStream) =>
      runCuration(
        stream,
        'acknowledged',
        () =>
          fetch(streamUrl(stream, 'acknowledge'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Acknowledged via DQ Hub' }),
          }),
        `${stream.label} acknowledged`,
        'Failed to acknowledge',
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runCuration, encodedPlantId],
  );

  const handleExclude = useCallback(
    (stream: DegradedStream) =>
      runCuration(
        stream,
        'excluded',
        () =>
          fetch(streamUrl(stream, 'exclude'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kpi_names: stream.affected_kpis,
              reason: 'Excluded via DQ Hub',
            }),
          }),
        `${stream.label} excluded from KPI rollups`,
        'Failed to exclude',
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runCuration, encodedPlantId],
  );

  const handleUndo = useCallback(
    (stream: DegradedStream) => {
      const current = curation[stream.stream_id];
      if (current !== 'acknowledged' && current !== 'excluded') return;
      const tail = current === 'acknowledged' ? 'acknowledge' : 'exclude';
      void runCuration(
        stream,
        'open',
        () => fetch(streamUrl(stream, tail), { method: 'DELETE' }),
        current === 'acknowledged'
          ? `Acknowledgement revoked for ${stream.label}`
          : `${stream.label} re-included in KPI rollups`,
        'Failed to undo',
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [curation, runCuration, encodedPlantId],
  );

  const handleDraftTicket = useCallback(
    async (stream: DegradedStream) => {
      setPending(stream.stream_id, true);
      try {
        const res = await fetch(`/api/quality/plants/${encodedPlantId}/incidents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: `DQ issue on ${stream.label}: ${stream.attribution_narrative}`,
            severity: stream.severity,
            create_linked_ticket: true,
          }),
        });
        if (res.ok) {
          pushToast(`Incident opened · ticket drafted for ${stream.label}`, 'ok');
          setCurationRefresh((k) => k + 1);
        } else {
          pushToast(failureMessage(res.status, 'Failed to draft ticket'), res.status >= 500 ? 'warn' : 'alarm');
        }
      } catch {
        pushToast('Failed to draft ticket', 'alarm');
      } finally {
        setPending(stream.stream_id, false);
      }
    },
    [encodedPlantId, pushToast, setPending],
  );

  // ---------------------------------------------------------------- render

  if (isLoading && !data) {
    return <QualitySkeleton title="Loading data quality snapshot…" />;
  }

  if (hasError || !data) {
    return (
      <QualityEmptyState
        icon={AlertTriangle}
        reason="The data quality snapshot could not be fetched."
        suggestion="This is usually transient. Retry, or check the plant's data connection if it persists."
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-gray-50"
            style={{
              background: '#FFFFFF',
              color: QUALITY_COLORS.text.primary,
              borderColor: QUALITY_COLORS.border.DEFAULT,
            }}
          >
            Retry
          </button>
        }
      />
    );
  }

  if (!data.sla) {
    return (
      <QualityEmptyState
        icon={Radar}
        reason="Data quality coverage not yet enabled for this plant"
        suggestion="Once telemetry instrumentation is enabled for this site, the daily SLA snapshot, degraded-stream attribution, and curation log will appear here."
      />
    );
  }

  const topDegraded = data.top_degraded ?? [];
  const isFixture = data._source === 'fixture';
  const kpiImpact = data.kpi_impact ?? [];
  const curationLog = data.curation_log_recent ?? [];
  const fallback = data.satellite_fallback_active;
  const detailState: StreamCurationState = detailStream
    ? (curation[detailStream.stream_id] ?? 'open')
    : 'open';

  return (
    <div className="relative space-y-5">
      {/* 0. LLM AM briefing (auto-fires after today.json lands) */}
      <DigestCard
        digest={digest?.digest}
        loading={digestLoading}
        generatedAt={digest?.generated_at}
        model={digest?.model}
      />

      {/* 0. Fixture provenance — a frozen snapshot must never read as live. */}
      {isFixture && (
        <div
          className="rounded-lg border px-3 py-1.5 text-[11px]"
          style={{
            fontFamily: QUALITY_MONO,
            background: QUALITY_TONES.warn.bg,
            borderColor: QUALITY_TONES.warn.border,
            color: QUALITY_TONES.warn.fg,
          }}
        >
          demo fixture · snapshot generated {data.generated_at?.slice(0, 10) ?? 'unknown'} — stream
          freshness is relative to that snapshot, not to now
        </div>
      )}

      {/* 1. SLA banner */}
      <SlaBanner
        contractPct={data.sla.contract_pct}
        contractSource={data.sla.contract_source}
        mtdPct={data.sla.mtd_pct}
        projectedEomPct={data.sla.projected_eom_pct}
        projectionMethod={data.sla.projection_method}
        daysRemaining={data.sla.days_remaining_in_month}
        iecReference={data.sla.iec_reference}
      />

      {/* 2. Stream freshness census (was computed but never rendered) */}
      {data.freshness_summary && <FreshnessStrip summary={data.freshness_summary} />}

      {/* 3. Satellite fallback banner (renders null when inactive) */}
      {fallback && (
        <SatelliteFallbackBanner
          active={fallback.active}
          fallbackSource={fallback.fallback_source}
          substitutingFor={fallback.substituting_for}
          ghiConfidenceBandPct={fallback.ghi_confidence_band_pct}
          engagedAt={fallback.engaged_at}
        />
      )}

      {/* 4. Top degraded streams */}
      <QualityCard title="Streams needing attention" icon={Radar}>
        {topDegraded.length === 0 ? (
          <p className="text-xs leading-relaxed" style={{ color: QUALITY_COLORS.text.secondary }}>
            No streams flagged — every input is fresh and within tolerance.
          </p>
        ) : (
          <div>
            {topDegraded.map((stream) => (
              <StreamHealthRow
                key={stream.stream_id}
                stream={stream}
                state={curation[stream.stream_id] ?? 'open'}
                pending={pendingIds.has(stream.stream_id)}
                snapshotMode={isFixture}
                onAcknowledge={handleAcknowledge}
                onDraftTicket={handleDraftTicket}
                onExclude={handleExclude}
                onUndo={handleUndo}
                onOpenDetail={setDetailStream}
              />
            ))}
          </div>
        )}
      </QualityCard>

      {/* 5. KPI impact band */}
      <QualityCard title="KPIs affected" icon={Target}>
        {kpiImpact.length === 0 ? (
          <p className="text-xs leading-relaxed" style={{ color: QUALITY_COLORS.text.secondary }}>
            No KPI confidence impact detected.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {kpiImpact.map((kpi) => (
              <ConfidenceBand
                key={kpi.kpi}
                label={kpi.kpi}
                nominal={kpi.nominal}
                bandLo={kpi.band_lo}
                bandHi={kpi.band_hi}
                degradedInputsPct={kpi.degraded_inputs_pct}
                reference={kpi.reference}
              />
            ))}
          </div>
        )}
      </QualityCard>

      {/* 6. Open incidents (renders nothing when empty / signed out). */}
      <OpenIncidentsCard
        plantId={plantId}
        refreshKey={curationRefresh}
        onClosed={(incident) => {
          pushToast(`Incident closed: ${incident.summary.slice(0, 60)}`, 'ok');
          setCurationRefresh((k) => k + 1);
        }}
        onError={(msg) => pushToast(msg, 'alarm')}
      />

      {/* 7. Curation log — live DB log first, fixture entries as fallback. */}
      <CurationLogCard
        plantId={plantId}
        fallbackEntries={curationLog}
        refreshKey={curationRefresh}
      />

      {/* Stream detail drawer */}
      <StreamDetailDrawer
        stream={detailStream}
        state={detailState}
        snapshotMode={isFixture}
        onClose={() => setDetailStream(null)}
        onAcknowledge={handleAcknowledge}
        onDraftTicket={handleDraftTicket}
        onExclude={handleExclude}
        onUndo={handleUndo}
      />

      {/* Toast stack */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2">
          {toasts.map((t) => {
            const tokens = QUALITY_TONES[t.tone];
            return (
              <div
                key={t.id}
                role="status"
                className="pointer-events-auto rounded-lg border bg-white px-3.5 py-2 text-xs font-medium shadow-lg"
                style={{ borderColor: tokens.border, color: tokens.fg }}
              >
                {t.message}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
