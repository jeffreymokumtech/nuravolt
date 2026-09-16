'use client';

import { useMemo } from 'react';
import { useChartHover } from '@/hooks/useChartHover';
import OpsTooltip, { type OpsTooltipRow } from '@/components/ops/charts/OpsTooltip';
import type { OptimizerSampleDay } from '../types';

/**
 * Intraday sample-day chart for the optimizer audit: day-ahead price (grey,
 * right axis) with realized vs modeled-optimal battery net power (left axis,
 * discharge positive / charge negative). Hand-rolled SVG in the same style
 * as SoHProjectionChart.
 */
export default function SampleDayChart({
  sample,
  height = 260,
}: {
  sample: OptimizerSampleDay;
  height?: number;
}) {
  const n = sample.timestamps.length;
  const hover = useChartHover(n);

  const w = 1000;
  const h = 280;
  const padTop = 14;
  const padBottom = 30;
  const padLeft = 50;
  const padRight = 54;
  const drawH = h - padTop - padBottom;
  const drawW = w - padLeft - padRight;

  const maxAbsKw = useMemo(
    () =>
      Math.max(
        ...sample.realized_net_kw.map((v) => Math.abs(v)),
        ...sample.optimal_net_kw.map((v) => Math.abs(v)),
        1
      ),
    [sample]
  );
  const priceMin = Math.min(...sample.price_eur_mwh);
  const priceMax = Math.max(...sample.price_eur_mwh);
  const priceRange = priceMax - priceMin || 1;

  const xAt = (i: number) => padLeft + (i / (n - 1 || 1)) * drawW;
  const yKw = (v: number) => padTop + drawH / 2 - (v / maxAbsKw) * (drawH / 2);
  const yPrice = (p: number) => padTop + drawH - ((p - priceMin) / priceRange) * drawH;

  const toPath = (values: number[], yFn: (v: number) => number) =>
    values
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yFn(v).toFixed(1)}`)
      .join(' ');

  const pricePath = useMemo(() => toPath(sample.price_eur_mwh, yPrice), [sample, n]);
  const realizedPath = useMemo(() => toPath(sample.realized_net_kw, yKw), [sample, n]);
  const optimalPath = useMemo(() => toPath(sample.optimal_net_kw, yKw), [sample, n]);

  const timeLabel = (i: number) => {
    const d = new Date(sample.timestamps[i]);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  };

  const idx = hover.hoverIdx;
  const containerW = hover.containerRef.current?.clientWidth ?? 1000;
  const tooltipRows: OpsTooltipRow[] =
    idx != null
      ? [
          {
            key: 'p',
            label: 'price',
            value: `€${sample.price_eur_mwh[idx].toFixed(1)}/MWh`,
            tone: 'muted',
          },
          {
            key: 'r',
            label: 'realized',
            value: `${Math.round(sample.realized_net_kw[idx])} kW`,
            tone: 'bess',
          },
          {
            key: 'o',
            label: 'optimal',
            value: `${Math.round(sample.optimal_net_kw[idx])} kW`,
            tone: 'ok',
          },
        ]
      : [];

  const kwTicks = [maxAbsKw, maxAbsKw / 2, 0, -maxAbsKw / 2, -maxAbsKw];
  const xTickIdx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];

  return (
    <div ref={hover.containerRef} className="relative">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block"
        onPointerMove={hover.onPointerMove}
        onPointerLeave={hover.onPointerLeave}
      >
        {kwTicks.map((v, i) => (
          <line
            key={`g-${i}`}
            x1={padLeft}
            x2={w - padRight}
            y1={yKw(v)}
            y2={yKw(v)}
            stroke="var(--ops-row-hair)"
            strokeWidth={v === 0 ? 1.6 : 1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path
          d={pricePath}
          fill="none"
          stroke="var(--ops-muted)"
          strokeWidth="1.4"
          opacity="0.8"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={optimalPath}
          fill="none"
          stroke="var(--ops-ok)"
          strokeWidth="1.6"
          strokeDasharray="5 4"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={realizedPath}
          fill="none"
          stroke="var(--ops-bess)"
          strokeWidth="2.2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {idx != null && (
          <line
            x1={xAt(idx)}
            x2={xAt(idx)}
            y1={padTop}
            y2={padTop + drawH}
            stroke="var(--ops-info)"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity="0.5"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}
      </svg>

      {/* Left axis: kW */}
      <div
        className="pointer-events-none absolute left-0 font-mono text-[9.5px] text-ink-3"
        style={{ top: 0, bottom: (padBottom / h) * 100 + '%', width: padLeft - 4 }}
      >
        {kwTicks.map((v, i) => (
          <span
            key={i}
            className="absolute right-1"
            style={{ top: (yKw(v) / h) * 100 + '%', transform: 'translateY(-50%)' }}
          >
            {Math.round(v)} kW
          </span>
        ))}
      </div>

      {/* Right axis: price */}
      <div
        className="pointer-events-none absolute right-0 font-mono text-[9.5px] text-ink-3"
        style={{ top: 0, bottom: (padBottom / h) * 100 + '%', width: padRight - 4 }}
      >
        {[priceMax, (priceMax + priceMin) / 2, priceMin].map((p, i) => (
          <span
            key={i}
            className="absolute left-1"
            style={{ top: (yPrice(p) / h) * 100 + '%', transform: 'translateY(-50%)' }}
          >
            €{Math.round(p)}
          </span>
        ))}
      </div>

      <div
        className="flex justify-between font-mono text-[9.5px] text-ink-3"
        style={{ paddingLeft: padLeft, paddingRight: padRight }}
      >
        {xTickIdx.map((i) => (
          <span key={i}>{timeLabel(i)}</span>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-4 font-mono text-[11px] text-ink-2" style={{ paddingLeft: padLeft }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: 'var(--ops-bess)' }} />
          Realized net power
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-4" style={{ borderTop: '2px dashed var(--ops-ok)', height: 0 }} />
          Optimal dispatch
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: 'var(--ops-muted)' }} />
          Day-ahead price
        </span>
      </div>

      {idx != null && (
        <OpsTooltip
          header={`${sample.day} · ${timeLabel(idx)} UTC`}
          rows={tooltipRows}
          x={hover.hoverX}
          containerWidth={containerW}
          width={190}
        />
      )}
    </div>
  );
}
