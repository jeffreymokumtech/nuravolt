'use client';

import { useRef, useState } from 'react';
import { cn } from '@/helpers/utils';
import OpsTooltip from './OpsTooltip';

/**
 * 24h dispatch profile bars, height encodes magnitude, tone encodes
 * direction (charge = bess solid, discharge = bess muted). The design uses
 * a 12-bar simplification of a 24h profile (2h buckets).
 *
 * Interactive: per-bar hover with tooltip showing hour, direction,
 * magnitude, and optional price/action.
 */

export interface DispatchBar {
  /** Hour label, e.g. "09" or "0-2h". */
  hour: string;
  /** Magnitude as fraction of max [0, 1]. */
  magnitude: number;
  /** charge: positive (bess strong); discharge: negative (bess soft). */
  direction: 'charge' | 'discharge' | 'idle';
  /** Optional raw kW value for the tooltip. */
  kw?: number;
  /** Optional spot price for the tooltip. */
  priceEurMwh?: number;
  /** Optional action label (e.g. "arbitrage", "peak shave"). */
  action?: string;
}

interface DispatchBarsProps {
  bars: DispatchBar[];
  height?: number;
  className?: string;
}

const DIRECTION_TONE: Record<DispatchBar['direction'], 'bess' | 'muted'> = {
  charge: 'bess',
  discharge: 'bess',
  idle: 'muted',
};

export default function DispatchBars({ bars, height = 120, className }: DispatchBarsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const containerW = containerRef.current?.clientWidth ?? 200;
  const hoverBar = hoverIdx != null ? bars[hoverIdx] : null;

  return (
    <div ref={containerRef} className={cn('relative flex items-end gap-1', className)} style={{ height }}>
      {bars.map((bar, i) => {
        const color =
          bar.direction === 'charge'
            ? 'var(--ops-bess)'
            : bar.direction === 'discharge'
              ? 'color-mix(in srgb, var(--ops-bess) 45%, transparent)'
              : 'var(--ops-dim)';
        const isHover = i === hoverIdx;
        return (
          <div
            key={`${bar.hour}-${i}`}
            className="flex-1 rounded transition-all"
            style={{
              height: `${Math.max(bar.magnitude * 100, 4)}%`,
              background: color,
              opacity: isHover ? 1 : hoverIdx == null ? 1 : 0.45,
              boxShadow: isHover ? '0 0 0 1px var(--ops-bright)' : undefined,
              transform: isHover ? 'translateY(-2px)' : undefined,
            }}
            onMouseEnter={(e) => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              setHoverIdx(i);
            }}
            onMouseMove={(e) => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
            }}
            onMouseLeave={() => setHoverIdx(null)}
          />
        );
      })}
      {hoverBar && (
        <OpsTooltip
          header={`Hour ${hoverBar.hour}`}
          rows={[
            {
              key: 'dir',
              label: 'action',
              value: hoverBar.action ?? hoverBar.direction,
              tone: DIRECTION_TONE[hoverBar.direction],
            }, ...(hoverBar.kw != null
              ? [
                  {
                    key: 'kw',
                    label: hoverBar.direction === 'charge' ? 'charge' : 'discharge',
                    value: `${Math.round(hoverBar.kw)} kW`,
                    tone: 'bess' as const,
                  },
                ]
              : [{ key: 'mag', label: 'magnitude', value: `${(hoverBar.magnitude * 100).toFixed(0)}%` }]), ...(hoverBar.priceEurMwh != null
              ? [
                  {
                    key: 'price',
                    label: 'price',
                    value: `€${hoverBar.priceEurMwh.toFixed(0)}/MWh`,
                    tone: 'info' as const,
                  },
                ]
              : []),
          ]}
          x={pointer.x}
          y={pointer.y}
          containerWidth={containerW}
          width={170}
          top="follow"
        />
      )}
    </div>
  );
}
