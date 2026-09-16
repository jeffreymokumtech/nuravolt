'use client';

import type { ReactNode } from 'react';
import StatusLed from './StatusLed';

/**
 * List view of active alarms. Each row: severity LED (pulse for critical),
 * asset identifier, short message (truncated), age, ACK button.
 *
 * Designed to live inside an OpsPanel, that's where the label and active
 * counts go. The stack itself is just rows + an optional empty state.
 *
 * Interactive: when `onAlarmClick` is provided, each row becomes clickable
 * (pointer cursor + hover bg tint). The ACK button stops propagation so it
 * doesn't double-fire.
 */

export type AlarmSeverity = 'critical' | 'warning' | 'info';

export type ClassificationLayer = 'RULE' | 'TWIN_RESIDUAL' | 'ML_CLASSIFIER' | 'AI_OVERRIDE';

export interface AlarmRow {
  id: string;
  /** Asset identifier or fault code, e.g. INV-3-014 */
  asset: string;
  /** Short message, displayed mono. */
  message: string;
  /** Age string (e.g. "6d 04h", "14h"). */
  age: string;
  severity: AlarmSeverity;
  /** If true, the ACK button is rendered. */
  ackable?: boolean;
  /** Raw alarm record for click-through (passed back to onAlarmClick). */
  raw?: unknown;
  /** Cascade fields surfaced as a small chip + hover tooltip. */
  classificationLayer?: ClassificationLayer;
  evidence?: string;
  winnerReason?: string;
  confidence?: number;
}

const SEV_TONE = {
  critical: 'alarm',
  warning: 'warn',
  info: 'info',
} as const;

const LAYER_LABEL: Record<ClassificationLayer, string> = {
  RULE: 'RULE',
  TWIN_RESIDUAL: 'TWIN',
  ML_CLASSIFIER: 'ML',
  AI_OVERRIDE: 'AI',
};

const LAYER_TONE: Record<ClassificationLayer, { fg: string; bg: string; border: string }> = {
  RULE: { fg: 'var(--ops-info)', bg: 'var(--ops-info-bg)', border: 'var(--ops-info-border)' },
  TWIN_RESIDUAL: { fg: 'var(--ops-info)', bg: 'var(--ops-info-bg)', border: 'var(--ops-info-border)' },
  ML_CLASSIFIER: { fg: 'var(--ops-warn)', bg: 'var(--ops-warn-bg)', border: 'var(--ops-warn-border)' },
  AI_OVERRIDE: { fg: 'var(--ops-bess)', bg: 'var(--ops-bess-bg)', border: 'var(--ops-bess-border)' },
};

interface AlarmStackProps {
  alarms: AlarmRow[];
  /** Called when ACK is clicked, parent decides what to do. */
  onAck?: (alarmId: string) => void;
  /** Called when the row body is clicked. Routes to ticket detail. */
  onAlarmClick?: (alarm: AlarmRow) => void;
  /** Empty state node. */
  empty?: ReactNode;
  /** Compact: removes ACK + halves vertical padding for dense layouts. */
  compact?: boolean;
}

export default function AlarmStack({
  alarms,
  onAck,
  onAlarmClick,
  empty,
  compact,
}: AlarmStackProps) {
  if (alarms.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center px-3 font-mono text-[11px]"
        style={{ color: 'var(--ops-muted)' }}
      >
        {empty ?? <>No active alarms · all systems nominal</>}
      </div>
    );
  }

  return (
    <div className="ops-hairline-y">
      {alarms.map((a) => {
        const interactive = !!onAlarmClick;
        return (
          <div
            key={a.id}
            className="ops-alarm-row grid items-center gap-2 px-3.5"
            style={{
              gridTemplateColumns: '14px 1fr 2fr 64px auto',
              padding: compact ? '6px 14px' : '10px 14px',
              color: 'var(--ops-txt)',
              cursor: interactive ? 'pointer' : 'default',
              transition: 'background-color 120ms ease',
            }}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={interactive ? () => onAlarmClick(a) : undefined}
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onAlarmClick(a);
                    }
                  }
                : undefined
            }
            onMouseEnter={
              interactive
                ? (e) => (e.currentTarget.style.backgroundColor = 'var(--ops-row-hair)')
                : undefined
            }
            onMouseLeave={
              interactive
                ? (e) => (e.currentTarget.style.backgroundColor = 'transparent')
                : undefined
            }
          >
            <StatusLed tone={SEV_TONE[a.severity]} size={6} pulse={a.severity === 'critical'} />
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span className="ops-num text-[12px] truncate" style={{ color: 'var(--ops-txt)' }}>
                {a.asset}
              </span>
              {a.classificationLayer && (
                <span
                  className="inline-flex items-center rounded-sm border px-1 py-px font-mono text-[8.5px] uppercase tracking-wider"
                  style={{
                    color: LAYER_TONE[a.classificationLayer].fg,
                    background: LAYER_TONE[a.classificationLayer].bg,
                    borderColor: LAYER_TONE[a.classificationLayer].border,
                    flexShrink: 0,
                  }}
                  title={
                    a.evidence
                      ? `${a.evidence}${a.winnerReason ? `\n\n${a.winnerReason}` : ''}${
                          a.confidence !== undefined ? `\n\nConfidence: ${(a.confidence * 100).toFixed(0)}%` : ''
                        }`
                      : LAYER_LABEL[a.classificationLayer]
                  }
                >
                  {LAYER_LABEL[a.classificationLayer]}
                </span>
              )}
            </span>
            <span
              className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px]"
              style={{ color: 'var(--ops-muted)' }}
            >
              {a.message}
            </span>
            <span
              className="ops-num text-[10.5px] text-right"
              style={{ color: 'var(--ops-label)' }}
            >
              {a.age}
            </span>
            {a.ackable && !compact && onAck ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAck(a.id);
                }}
                className="rounded-sm border px-1.5 py-px font-mono text-[10px] tracking-wider transition-colors hover:brightness-95"
                style={{
                  color: 'var(--ops-info)',
                  background: 'var(--ops-ack-bg)',
                  borderColor: 'var(--ops-ack-border)',
                }}
              >
                ACK
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}
