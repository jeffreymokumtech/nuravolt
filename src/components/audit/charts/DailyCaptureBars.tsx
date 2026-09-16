'use client';

import { useRef, useState } from 'react';
import OpsTooltip from '@/components/ops/charts/OpsTooltip';
import type { OptimizerAuditDay } from '../types';
import { fmtEur } from '../AuditUi';

/**
 * Daily realized vs benchmark revenue bars, one column per audited day.
 * The muted background bar is the modeled optimal net revenue; the violet
 * foreground bar is what the asset actually captured. Hand-rolled div bars,
 * same interaction pattern as DispatchBars / RainflowHistogram.
 */
export default function DailyCaptureBars({
  days,
  height = 160,
}: {
  days: OptimizerAuditDay[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const maxVal = Math.max(...days.map((d) => Math.max(d.optimal_net_eur, d.realized_net_eur)), 1);
  const containerW = containerRef.current?.clientWidth ?? 600;
  const hoverDay = hoverIdx != null ? days[hoverIdx] : null;

  const trackPointer = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div className="relative">
      <div ref={containerRef} className="relative flex items-end gap-px" style={{ height }}>
        {days.map((d, i) => {
          const skipped = d.status !== 'ok';
          const optPct = Math.max((d.optimal_net_eur / maxVal) * 100, 2);
          const realPct = Math.max((d.realized_net_eur / maxVal) * 100, 2);
          const isHover = i === hoverIdx;
          return (
            <div
              key={d.day}
              className="relative flex-1"
              style={{ height: '100%', opacity: isHover || hoverIdx == null ? 1 : 0.45 }}
              onMouseEnter={(e) => {
                trackPointer(e);
                setHoverIdx(i);
              }}
              onMouseMove={trackPointer}
              onMouseLeave={() => setHoverIdx(null)}
            >
              {skipped ? (
                <div
                  className="absolute bottom-0 w-full rounded-sm"
                  style={{ height: '6%', background: 'var(--ops-dim)' }}
                />
              ) : (
                <>
                  <div
                    className="absolute bottom-0 w-full rounded-sm"
                    style={{ height: `${optPct}%`, background: 'rgba(155, 123, 224, 0.22)' }}
                  />
                  <div
                    className="absolute bottom-0 w-full rounded-sm transition-all"
                    style={{
                      height: `${realPct}%`,
                      background: 'var(--ops-bess)',
                      boxShadow: isHover ? '0 0 0 1px var(--ops-bright)' : undefined,
                    }}
                  />
                </>
              )}
            </div>
          );
        })}
        {hoverDay && (
          <OpsTooltip
            header={hoverDay.day}
            rows={
              hoverDay.status !== 'ok'
                ? [{ key: 's', label: 'status', value: 'skipped (coverage)', tone: 'muted' }]
                : [
                    {
                      key: 'r',
                      label: 'realized net',
                      value: fmtEur(hoverDay.realized_net_eur),
                      tone: 'bess',
                    },
                    {
                      key: 'o',
                      label: 'optimal net',
                      value: fmtEur(hoverDay.optimal_net_eur),
                      tone: 'muted',
                    },
                    {
                      key: 'c',
                      label: 'capture',
                      value:
                        hoverDay.capture_ratio != null
                          ? `${(hoverDay.capture_ratio * 100).toFixed(1)}%`
                          : 'n/a',
                      tone:
                        hoverDay.capture_ratio != null && hoverDay.capture_ratio >= 0.8
                          ? 'ok'
                          : 'warn',
                    },
                  ]
            }
            x={pointer.x}
            y={pointer.y}
            containerWidth={containerW}
            width={190}
            top="follow"
          />
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-ink-3">
        <span>{days[0]?.day}</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 font-mono text-[11px] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: 'var(--ops-bess)' }} />
          Realized net revenue
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm"
            style={{ background: 'rgba(155, 123, 224, 0.22)' }}
          />
          Modeled optimal (perfect foresight benchmark)
        </span>
      </div>
    </div>
  );
}
