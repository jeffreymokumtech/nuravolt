import { type ReactNode } from 'react';
import StatusLed from './StatusLed';

/**
 * SCADA-style status footer bar. Pulse indicator on the left, segmented
 * metric pairs on the right separated by 1px dividers. The metrics are
 * declared by the parent, keeps the footer reusable across screens
 * (overview gets availability/MTBF/MTTR/CO₂; BESS gets SoC/Vdc/Idc/Tmax;
 * faults gets active/queued; etc.).
 */

export interface FooterMetric {
  label: string;
  /** Value displayed in body text colour. */
  value: ReactNode;
  /** Unit suffix in muted colour. */
  unit?: string;
  /** Optional override colour (e.g. tonal warning). */
  valueColor?: string;
}

interface OpsFooterProps {
  pulseLabel: string;
  pulseTone?: 'ok' | 'warn' | 'alarm' | 'info';
  metrics: FooterMetric[];
  buildTag?: string;
}

const PULSE_VAR = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
  info: 'var(--ops-info)',
} as const;

export default function OpsFooter({
  pulseLabel,
  pulseTone = 'ok',
  metrics,
  buildTag,
}: OpsFooterProps) {
  const pulseColor = PULSE_VAR[pulseTone];
  return (
    <div
      className="mt-3 flex items-center justify-between rounded-md border px-3.5 py-2 font-mono text-[10.5px]"
      style={{
        background: 'var(--ops-panel)',
        borderColor: 'var(--ops-hair)',
        color: 'var(--ops-muted)',
      }}
    >
      <div className="flex items-center gap-2">
        <StatusLed tone={pulseTone} size={7} pulse />
        <span className="tracking-[0.06em]" style={{ color: pulseColor }}>
          {pulseLabel}
        </span>
      </div>
      <div className="flex items-center">
        {metrics.map((m, i) => (
          <span
            key={`${m.label}-${i}`}
            className="px-3"
            style={{
              borderLeft: i === 0 ? '1px solid var(--ops-hair)' : '1px solid var(--ops-hair)',
            }}
          >
            <span className="" style={{ color: 'var(--ops-label)' }}>
              {m.label}
            </span>{' '}
            <span style={{ color: m.valueColor ?? 'var(--ops-txt)' }}>{m.value}</span>
            {m.unit && <span style={{ color: 'var(--ops-dim)' }}>{m.unit}</span>}
          </span>
        ))}
        {buildTag && (
          <span
            className="pl-3"
            style={{
              borderLeft: '1px solid var(--ops-hair)',
              color: 'var(--ops-dim)',
            }}
          >
            {buildTag}
          </span>
        )}
      </div>
    </div>
  );
}
