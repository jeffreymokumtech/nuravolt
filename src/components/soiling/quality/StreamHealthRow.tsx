'use client';

import { useState } from 'react';
import { CheckCircle2, FileText, EyeOff, Undo2, ChevronRight } from 'lucide-react';
import StatusDot from './StatusDot';
import AttributionBadge from './AttributionBadge';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  QUALITY_TONES,
  type QualityTone,
} from './constants';
import { cn } from '@/helpers/utils';

/**
 * StreamHealthRow — one degraded stream in the "Streams needing attention"
 * list. Presentational: all action side-effects (POST/DELETE, optimistic
 * state, undo, toasts) live in the parent (TodayTab), which passes the
 * current curation `state` back down. The only local UI state is the
 * inline confirm step for the destructive "Exclude from KPIs".
 */

export interface DegradedStream {
  stream_id: string;
  label: string;
  category: 'inverter' | 'met_sensor' | 'soiling_sensor' | 'scada' | 'other';
  severity: 'low' | 'medium' | 'high';
  last_good_at: string;
  last_value: number | null;
  gap_minutes: number;
  attribution_cause: string;
  attribution_narrative: string;
  affected_kpis: string[];
  recommended_action: string;
  /** Set by the API when an open acknowledgement/exclusion exists. */
  acknowledged?: boolean;
  excluded?: boolean;
}

export type StreamCurationState = 'open' | 'acknowledged' | 'excluded';

export interface StreamHealthRowProps {
  stream: DegradedStream;
  /** Current curation state (parent-owned; enables optimistic updates). */
  state?: StreamCurationState;
  /** True while a POST/DELETE for this stream is in flight. */
  pending?: boolean;
  /**
   * When the payload is a frozen fixture, gap_minutes is relative to the
   * fixture's snapshot instant — render "gap Xm at snapshot", never a
   * fake-live "Xm ago".
   */
  snapshotMode?: boolean;
  onAcknowledge: (stream: DegradedStream) => void;
  onDraftTicket: (stream: DegradedStream) => void;
  onExclude: (stream: DegradedStream) => void;
  /** Revert the current acknowledged/excluded state. */
  onUndo: (stream: DegradedStream) => void;
  /** Open the stream detail drawer. */
  onOpenDetail?: (stream: DegradedStream) => void;
}

const SEVERITY_TONE: Record<DegradedStream['severity'], QualityTone> = {
  low: 'info',
  medium: 'warn',
  high: 'alarm',
};

const CATEGORY_LABEL: Record<DegradedStream['category'], string> = {
  inverter: 'Inverter',
  met_sensor: 'Met sensor',
  soiling_sensor: 'Soiling sensor',
  scada: 'SCADA',
  other: 'Other',
};

function formatGap(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

export default function StreamHealthRow({
  stream,
  state = 'open',
  pending = false,
  snapshotMode,
  onAcknowledge,
  onDraftTicket,
  onExclude,
  onUndo,
  onOpenDetail,
}: StreamHealthRowProps) {
  const [confirmingExclude, setConfirmingExclude] = useState(false);
  const tone = SEVERITY_TONE[stream.severity];
  const resolved = state !== 'open';
  const toneTokens = QUALITY_TONES[tone];

  const handleExcludeClick = () => {
    if (confirmingExclude) return;
    setConfirmingExclude(true);
  };

  const confirmExclude = () => {
    setConfirmingExclude(false);
    onExclude(stream);
  };

  return (
    <div
      className={cn(
        'relative flex items-start gap-3 border-b px-3 py-3 transition-opacity',
        resolved && 'opacity-60',
        pending && 'pointer-events-none opacity-70',
      )}
      style={{ borderColor: QUALITY_COLORS.border.light }}
    >
      {/* Severity LED (muted once curated) */}
      <div className="shrink-0 pt-1.5">
        <StatusDot
          tone={resolved ? 'muted' : tone}
          size={9}
          pulse={!resolved && stream.severity === 'high'}
        />
      </div>

      {/* Main content */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {onOpenDetail ? (
            <button
              type="button"
              onClick={() => onOpenDetail(stream)}
              className="inline-flex items-center gap-0.5 truncate text-sm font-bold hover:underline"
              style={{ color: QUALITY_COLORS.text.primary }}
              title="Open stream detail"
            >
              {stream.label}
              <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: QUALITY_COLORS.text.muted }} />
            </button>
          ) : (
            <span
              className="truncate text-sm font-bold"
              style={{ color: QUALITY_COLORS.text.primary }}
            >
              {stream.label}
            </span>
          )}

          <span
            className="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              background: QUALITY_COLORS.background.section,
              color: QUALITY_COLORS.text.secondary,
              borderColor: QUALITY_COLORS.border.DEFAULT,
            }}
          >
            {CATEGORY_LABEL[stream.category]}
          </span>

          <span
            className="rounded px-1.5 py-0.5 text-[11px]"
            style={{
              fontFamily: QUALITY_MONO,
              background: toneTokens.bg,
              color: toneTokens.fg,
            }}
            title={`Last good: ${stream.last_good_at}`}
          >
            {snapshotMode
              ? `gap ${formatGap(stream.gap_minutes).replace(' ago', '')} at snapshot`
              : formatGap(stream.gap_minutes)}
          </span>

          <AttributionBadge
            cause={stream.attribution_cause}
            tooltip={stream.attribution_narrative}
          />

          {/* Curation state chip */}
          {state === 'acknowledged' && (
            <span
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: QUALITY_TONES.info.fg,
                background: QUALITY_TONES.info.bg,
                borderColor: QUALITY_TONES.info.border,
              }}
            >
              <CheckCircle2 className="h-3 w-3" /> Acknowledged
            </span>
          )}
          {state === 'excluded' && (
            <span
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: QUALITY_TONES.warn.fg,
                background: QUALITY_TONES.warn.bg,
                borderColor: QUALITY_TONES.warn.border,
              }}
            >
              <EyeOff className="h-3 w-3" /> Excluded from KPIs
            </span>
          )}

          <span
            className="ml-auto text-[10px]"
            style={{ fontFamily: QUALITY_MONO, color: QUALITY_COLORS.text.muted }}
          >
            {stream.stream_id}
          </span>
        </div>

        {/* Affected KPI badges */}
        {stream.affected_kpis.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              className="text-[10px] uppercase tracking-wider"
              style={{ color: QUALITY_COLORS.text.muted }}
            >
              Affects:
            </span>
            {stream.affected_kpis.map((kpi) => (
              <span
                key={kpi}
                className="rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  background: QUALITY_COLORS.background.section,
                  color: QUALITY_COLORS.text.secondary,
                  borderColor: QUALITY_COLORS.border.DEFAULT,
                }}
              >
                {kpi}
              </span>
            ))}
          </div>
        )}

        {/* Narrative, truncated, full on hover */}
        <p
          className="mt-1.5 line-clamp-2 cursor-help text-xs"
          style={{ color: QUALITY_COLORS.text.secondary }}
          title={stream.attribution_narrative}
        >
          {stream.attribution_narrative}
        </p>

        {stream.recommended_action && (
          <p className="mt-1 text-xs italic" style={{ color: QUALITY_COLORS.text.secondary }}>
            <span className="font-semibold not-italic">Action:</span>{' '}
            {stream.recommended_action}
          </p>
        )}

        {/* Inline confirm for the destructive exclude */}
        {confirmingExclude && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
            style={{
              background: QUALITY_TONES.warn.bg,
              borderColor: QUALITY_TONES.warn.border,
              color: QUALITY_TONES.warn.fg,
            }}
          >
            <span>
              Exclude this stream from{' '}
              {stream.affected_kpis.length > 0
                ? `${stream.affected_kpis.length} KPI rollup${stream.affected_kpis.length === 1 ? '' : 's'}`
                : 'all KPI rollups'}
              ? You can undo this afterwards.
            </span>
            <button
              type="button"
              onClick={confirmExclude}
              className="rounded border px-2 py-0.5 font-semibold"
              style={{
                background: '#FFFFFF',
                borderColor: QUALITY_TONES.warn.border,
                color: QUALITY_TONES.warn.fg,
              }}
            >
              Exclude
            </button>
            <button
              type="button"
              onClick={() => setConfirmingExclude(false)}
              className="px-1 py-0.5 underline-offset-2 hover:underline"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 flex-col gap-1 pt-0.5">
        {resolved ? (
          <ActionButton
            icon={<Undo2 className="h-3 w-3" />}
            label="Undo"
            onClick={() => onUndo(stream)}
          />
        ) : (
          <>
            <ActionButton
              icon={<CheckCircle2 className="h-3 w-3" />}
              label="Acknowledge"
              onClick={() => onAcknowledge(stream)}
            />
            <ActionButton
              icon={<FileText className="h-3 w-3" />}
              label="Draft Ticket"
              onClick={() => onDraftTicket(stream)}
              accent
            />
            <ActionButton
              icon={<EyeOff className="h-3 w-3" />}
              label="Exclude from KPIs"
              onClick={handleExcludeClick}
            />
          </>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-[11px] font-medium transition-colors',
        accent ? 'hover:opacity-90' : 'hover:bg-gray-50',
      )}
      style={{
        background: accent ? QUALITY_COLORS.primary.DEFAULT : '#FFFFFF',
        color: accent ? '#FFFFFF' : QUALITY_COLORS.text.primary,
        borderColor: accent ? QUALITY_COLORS.primary.DEFAULT : QUALITY_COLORS.border.DEFAULT,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
