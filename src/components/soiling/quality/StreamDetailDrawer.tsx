'use client';

import { useEffect } from 'react';
import { X, CheckCircle2, FileText, EyeOff, Undo2 } from 'lucide-react';
import StatusDot from './StatusDot';
import AttributionBadge from './AttributionBadge';
import {
  QUALITY_COLORS,
  QUALITY_MONO,
  QUALITY_TONES,
  type QualityTone,
} from './constants';
import type { DegradedStream, StreamCurationState } from './StreamHealthRow';

/**
 * StreamDetailDrawer — right-side drawer with the full picture of one
 * degraded stream: complete attribution narrative, affected KPIs, gap
 * details and the same curation actions as the row (shared handlers from
 * TodayTab, so optimistic state stays consistent between row and drawer).
 */

interface StreamDetailDrawerProps {
  stream: DegradedStream | null;
  state: StreamCurationState;
  snapshotMode?: boolean;
  onClose: () => void;
  onAcknowledge: (stream: DegradedStream) => void;
  onDraftTicket: (stream: DegradedStream) => void;
  onExclude: (stream: DegradedStream) => void;
  onUndo: (stream: DegradedStream) => void;
}

const SEVERITY_TONE: Record<DegradedStream['severity'], QualityTone> = {
  low: 'info',
  medium: 'warn',
  high: 'alarm',
};

function formatGapLong(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: QUALITY_COLORS.text.muted }}
      >
        {label}
      </div>
      <div className="mt-0.5 text-sm" style={{ color: QUALITY_COLORS.text.primary }}>
        {children}
      </div>
    </div>
  );
}

export default function StreamDetailDrawer({
  stream,
  state,
  snapshotMode,
  onClose,
  onAcknowledge,
  onDraftTicket,
  onExclude,
  onUndo,
}: StreamDetailDrawerProps) {
  // Esc closes the drawer.
  useEffect(() => {
    if (!stream) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stream, onClose]);

  if (!stream) return null;

  const tone = SEVERITY_TONE[stream.severity];
  const resolved = state !== 'open';

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close stream detail"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl">
        <div
          className="flex items-start justify-between gap-3 border-b p-5"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          <div>
            <div className="flex items-center gap-2">
              <StatusDot tone={resolved ? 'muted' : tone} size={9} pulse={!resolved && stream.severity === 'high'} />
              <h2 className="text-base font-bold" style={{ color: QUALITY_COLORS.text.primary }}>
                {stream.label}
              </h2>
            </div>
            <p
              className="mt-1 text-[11px]"
              style={{ fontFamily: QUALITY_MONO, color: QUALITY_COLORS.text.muted }}
            >
              {stream.stream_id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-gray-100"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 p-5">
          {/* Curation state */}
          {state === 'acknowledged' && (
            <div
              className="rounded-md border px-3 py-2 text-xs font-medium"
              style={{
                color: QUALITY_TONES.info.fg,
                background: QUALITY_TONES.info.bg,
                borderColor: QUALITY_TONES.info.border,
              }}
            >
              Acknowledged — this stream stays visible but is marked as reviewed.
            </div>
          )}
          {state === 'excluded' && (
            <div
              className="rounded-md border px-3 py-2 text-xs font-medium"
              style={{
                color: QUALITY_TONES.warn.fg,
                background: QUALITY_TONES.warn.bg,
                borderColor: QUALITY_TONES.warn.border,
              }}
            >
              Excluded from KPI rollups until re-included.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Severity">
              <span className="capitalize">{stream.severity}</span>
            </Field>
            <Field label="Category">
              <span className="capitalize">{stream.category.replace('_', ' ')}</span>
            </Field>
            <Field label={snapshotMode ? 'Gap at snapshot' : 'Data gap'}>
              {formatGapLong(stream.gap_minutes)}
            </Field>
            <Field label="Last good sample">
              <span style={{ fontFamily: QUALITY_MONO, fontSize: 12 }}>
                {stream.last_good_at}
              </span>
            </Field>
            {stream.last_value != null && (
              <Field label="Last value">
                <span style={{ fontFamily: QUALITY_MONO }}>{stream.last_value}</span>
              </Field>
            )}
          </div>

          <Field label="Attribution">
            <div className="mb-1.5">
              <AttributionBadge
                cause={stream.attribution_cause}
                tooltip={stream.attribution_narrative}
              />
            </div>
            <p className="text-xs leading-relaxed" style={{ color: QUALITY_COLORS.text.secondary }}>
              {stream.attribution_narrative}
            </p>
          </Field>

          {stream.affected_kpis.length > 0 && (
            <Field label="Affected KPIs">
              <div className="flex flex-wrap gap-1.5">
                {stream.affected_kpis.map((kpi) => (
                  <span
                    key={kpi}
                    className="rounded border px-1.5 py-0.5 text-[11px] font-medium"
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
            </Field>
          )}

          {stream.recommended_action && (
            <Field label="Recommended action">
              <p className="text-xs leading-relaxed" style={{ color: QUALITY_COLORS.text.secondary }}>
                {stream.recommended_action}
              </p>
            </Field>
          )}
        </div>

        {/* Actions */}
        <div
          className="flex flex-wrap gap-2 border-t p-5"
          style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
        >
          {resolved ? (
            <DrawerButton
              icon={<Undo2 className="h-3.5 w-3.5" />}
              label={state === 'excluded' ? 'Undo exclusion' : 'Undo acknowledge'}
              onClick={() => onUndo(stream)}
            />
          ) : (
            <>
              <DrawerButton
                icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                label="Acknowledge"
                onClick={() => onAcknowledge(stream)}
              />
              <DrawerButton
                icon={<FileText className="h-3.5 w-3.5" />}
                label="Draft Ticket"
                onClick={() => onDraftTicket(stream)}
                accent
              />
              <DrawerButton
                icon={<EyeOff className="h-3.5 w-3.5" />}
                label="Exclude from KPIs"
                onClick={() => onExclude(stream)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DrawerButton({
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
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-90"
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
