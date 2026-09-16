'use client';

import { useRef, useState } from 'react';
import { cn } from '@/helpers/utils';
import type { StatusTone } from '../StatusLed';
import OpsTooltip from './OpsTooltip';
import { AXIS_TEXT_CLASS, AXIS_TEXT_STYLE, TONE_VAR } from './chartTheme';

/**
 * Loss disaggregation waterfall. Each bar shows a signed contribution to a
 * running total; the start + end bars are full-height "anchor" bars.
 *
 * Interactive: per-bar hover highlight + tooltip with delta, running total,
 * and % of starting reference.
 */

export interface WaterfallDelta {
  label: string;
  value: number;
  tone: StatusTone;
  /** Optional provenance shown in the hover tooltip (e.g. "direct measurement"). */
  confidence?: string;
  /** Optional source / supporting count shown in the hover tooltip (e.g. "DustIQ", "3 faults"). */
  source?: string;
}

interface OpsWaterfallChartProps {
  start: { label: string; value: number };
  deltas: WaterfallDelta[];
  end: { label?: string };
  unit?: string;
  height?: number;
  formatValue?: (v: number) => string;
  className?: string;
}

export default function OpsWaterfallChart({
  start,
  deltas,
  end,
  unit,
  height = 200,
  formatValue = (v) => Math.round(v).toLocaleString(),
  className,
}: OpsWaterfallChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const runningTotals: number[] = [start.value];
  for (const d of deltas) {
    runningTotals.push(runningTotals[runningTotals.length - 1] + d.value);
  }
  const endValue = runningTotals[runningTotals.length - 1];

  const allValues = [start.value, endValue, ...runningTotals];
  const yMax = Math.max(...allValues) * 1.05;
  const yMin = 0;
  const range = yMax - yMin || 1;

  const barCount = deltas.length + 2;
  const labels = [start.label, ...deltas.map((d) => d.label), end.label ?? 'Net'];

  const yFor = (v: number) => height - 30 - ((v - yMin) / range) * (height - 50);
  const barWidth = `calc((100% - ${(barCount - 1) * 6}px) / ${barCount})`;

  const containerW = containerRef.current?.clientWidth ?? 1000;

  // Compose tooltip rows based on hovered index (0 = start, 1..N = deltas, N+1 = end)
  const tooltipRows: { key: string; label: string; value: string; tone?: StatusTone }[] = [];
  let tooltipHeader: string | undefined;
  if (hoverIdx != null) {
    if (hoverIdx === 0) {
      tooltipHeader = start.label;
      tooltipRows.push({
        key: 'val',
        label: 'reference',
        value: `${formatValue(start.value)}${unit ? ' ' + unit : ''}`,
        tone: 'info',
      });
    } else if (hoverIdx === labels.length - 1) {
      tooltipHeader = end.label ?? 'Net';
      tooltipRows.push({
        key: 'val',
        label: 'net total',
        value: `${formatValue(endValue)}${unit ? ' ' + unit : ''}`,
        tone: 'ok',
      });
      tooltipRows.push({
        key: 'pct',
        label: 'of ref',
        value: `${((endValue / start.value) * 100).toFixed(1)}%`,
        tone: 'muted',
      });
    } else {
      const d = deltas[hoverIdx - 1];
      const running = runningTotals[hoverIdx];
      tooltipHeader = d.label;
      tooltipRows.push({
        key: 'delta',
        label: 'delta',
        value: `${d.value > 0 ? '+' : ''}${formatValue(d.value)}${unit ? ' ' + unit : ''}`,
        tone: d.tone,
      });
      tooltipRows.push({
        key: 'total',
        label: 'running',
        value: `${formatValue(running)}${unit ? ' ' + unit : ''}`,
        tone: 'muted',
      });
      tooltipRows.push({
        key: 'pct',
        label: '% of ref',
        value: `${((d.value / start.value) * 100).toFixed(2)}%`,
        tone: 'muted',
      });
      if (d.confidence) {
        tooltipRows.push({
          key: 'confidence',
          label: 'attribution',
          value: d.confidence,
          tone: 'info',
        });
      }
      if (d.source) {
        tooltipRows.push({
          key: 'source',
          label: 'source',
          value: d.source,
          tone: 'muted',
        });
      }
    }
  }

  const onMove = (e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative', className)}
      style={{ minHeight: height }}
      onMouseMove={onMove}
    >
      <div className="flex items-end gap-1.5" style={{ height: height - 24 }}>
        <WaterfallBar
          label={start.label}
          topY={yFor(start.value)}
          bottomY={yFor(0)}
          tone="info"
          value={start.value}
          formatValue={formatValue}
          isAnchor
          width={barWidth}
          isHovered={hoverIdx === 0}
          dimmed={hoverIdx != null && hoverIdx !== 0}
          onEnter={() => setHoverIdx(0)}
          onLeave={() => setHoverIdx(null)}
        />
        {deltas.map((d, i) => {
          const prevTotal = runningTotals[i];
          const total = runningTotals[i + 1];
          const top = Math.min(prevTotal, total);
          const bottom = Math.max(prevTotal, total);
          return (
            <WaterfallBar
              key={`d-${i}-${d.label}`}
              label={d.label}
              topY={yFor(bottom)}
              bottomY={yFor(top)}
              tone={d.tone}
              value={d.value}
              formatValue={formatValue}
              width={barWidth}
              isHovered={hoverIdx === i + 1}
              dimmed={hoverIdx != null && hoverIdx !== i + 1}
              onEnter={() => setHoverIdx(i + 1)}
              onLeave={() => setHoverIdx(null)}
            />
          );
        })}
        <WaterfallBar
          label={end.label ?? 'Net'}
          topY={yFor(endValue)}
          bottomY={yFor(0)}
          tone="ok"
          value={endValue}
          formatValue={formatValue}
          isAnchor
          width={barWidth}
          isHovered={hoverIdx === labels.length - 1}
          dimmed={hoverIdx != null && hoverIdx !== labels.length - 1}
          onEnter={() => setHoverIdx(labels.length - 1)}
          onLeave={() => setHoverIdx(null)}
        />
      </div>
      <div className={cn('mt-1 flex gap-1.5', AXIS_TEXT_CLASS)} style={AXIS_TEXT_STYLE}>
        {labels.map((l, i) => (
          <span
            key={`l-${i}-${l}`}
            className="overflow-hidden text-ellipsis whitespace-nowrap text-center transition-colors"
            style={{
              width: barWidth,
              color: i === hoverIdx ? 'var(--ops-bright)' : undefined,
              fontWeight: i === hoverIdx ? 600 : undefined,
            }}
            title={l}
          >
            {l}
          </span>
        ))}
      </div>
      {hoverIdx != null && tooltipRows.length > 0 && (
        <OpsTooltip
          header={tooltipHeader}
          rows={tooltipRows}
          x={pointer.x}
          y={pointer.y}
          containerWidth={containerW}
          width={180}
          top="follow"
        />
      )}
    </div>
  );
}

interface WaterfallBarProps {
  label: string;
  topY: number;
  bottomY: number;
  tone: StatusTone;
  value: number;
  formatValue: (v: number) => string;
  isAnchor?: boolean;
  width: string;
  isHovered: boolean;
  dimmed: boolean;
  onEnter: () => void;
  onLeave: () => void;
}

function WaterfallBar({
  topY,
  bottomY,
  tone,
  value,
  formatValue,
  isAnchor,
  width,
  isHovered,
  dimmed,
  onEnter,
  onLeave,
}: WaterfallBarProps) {
  const h = Math.max(bottomY - topY, 2);
  return (
    <div
      className="relative"
      style={{ width, height: '100%' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div
        className="absolute rounded transition-all"
        style={{
          top: topY,
          height: h,
          left: 0,
          right: 0,
          background: TONE_VAR[tone],
          opacity: isHovered ? 1 : dimmed ? 0.4 : isAnchor ? 1 : 0.9,
          boxShadow: isHovered ? '0 0 0 1px var(--ops-bright)' : undefined,
          transform: isHovered ? 'translateY(-1px)' : undefined,
        }}
      />
      <div
        className="absolute -top-3.5 left-0 right-0 text-center text-[9.5px] ops-num transition-colors"
        style={{
          top: topY - 14,
          color:
            isHovered
              ? 'var(--ops-bright)'
              : tone === 'alarm' || tone === 'warn'
              ? TONE_VAR[tone]
              : 'var(--ops-bright)',
        }}
      >
        {value > 0 && !isAnchor ? '+' : ''}
        {formatValue(value)}
      </div>
    </div>
  );
}
