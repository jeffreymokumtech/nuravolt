/**
 * WindRose - 16-sector polar wind rose from one year of hourly site wind.
 *
 * Each sector is a stacked radial bar: segment length = frequency of that
 * speed class, colored light→dark with increasing wind speed. Radius is
 * proportional to sector frequency, so the prevailing direction reads at a
 * glance. Data comes from /api/wind/plants/[id]/site (ERA5 100 m wind).
 */

'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Compass } from 'lucide-react';

export interface WindRoseSector {
  sector: string;
  centerDeg: number;
  frequencyPct: number;
  meanSpeedMs: number;
  speedClassesPct: number[];
}

export interface WindRoseData {
  source: string;
  sampleHours: number;
  meanSpeedMs: number;
  speedClasses: string[];
  sectors: WindRoseSector[];
}

const SPEED_COLORS = ['#bfdbfe', '#60a5fa', '#2563eb', '#1e40af', '#172554'];

const SIZE = 320;
const CENTER = SIZE / 2;
const MAX_R = SIZE / 2 - 34;

function polar(deg: number, r: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [CENTER + r * Math.cos(rad), CENTER + r * Math.sin(rad)];
}

function sectorPath(centerDeg: number, r0: number, r1: number, widthDeg: number): string {
  const a0 = centerDeg - widthDeg / 2;
  const a1 = centerDeg + widthDeg / 2;
  const [x0, y0] = polar(a0, r0);
  const [x1, y1] = polar(a0, r1);
  const [x2, y2] = polar(a1, r1);
  const [x3, y3] = polar(a1, r0);
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0} Z`;
}

export default function WindRose({ data }: { data: WindRoseData }) {
  const maxFreq = useMemo(
    () => Math.max(...data.sectors.map((s) => s.frequencyPct), 1),
    [data]
  );
  const rings = [0.25, 0.5, 0.75, 1];
  const prevailing = useMemo(
    () => [...data.sectors].sort((a, b) => b.frequencyPct - a.frequencyPct)[0],
    [data]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Compass className="h-4 w-4 text-blue-600" />
          Wind rose
        </CardTitle>
        <p className="text-xs text-gray-500">
          {data.source} · mean {data.meanSpeedMs} m/s · prevailing {prevailing.sector} (
          {prevailing.frequencyPct}%)
        </p>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="max-w-[320px] flex-1">
          {rings.map((f) => (
            <circle
              key={f}
              cx={CENTER}
              cy={CENTER}
              r={MAX_R * f}
              fill="none"
              stroke="#e5e7eb"
              strokeWidth={1}
            />
          ))}
          {rings.map((f) => (
            <text
              key={`t${f}`}
              x={CENTER + 3}
              y={CENTER - MAX_R * f - 2}
              fontSize={8}
              fill="#9ca3af"
            >
              {(maxFreq * f).toFixed(0)}%
            </text>
          ))}
          {data.sectors.map((s) => {
            const total = s.frequencyPct;
            const rTotal = (total / maxFreq) * MAX_R;
            let acc = 0;
            return (
              <g key={s.sector}>
                {s.speedClassesPct.map((pct, ci) => {
                  if (pct <= 0) return null;
                  const r0 = (acc / total) * rTotal || 0;
                  acc += pct;
                  const r1 = (acc / total) * rTotal;
                  return (
                    <path
                      key={ci}
                      d={sectorPath(s.centerDeg, r0, r1, 360 / data.sectors.length - 3)}
                      fill={SPEED_COLORS[ci] ?? SPEED_COLORS[SPEED_COLORS.length - 1]}
                    >
                      <title>{`${s.sector} · ${data.speedClasses[ci]} · ${pct}% of hours`}</title>
                    </path>
                  );
                })}
              </g>
            );
          })}
          {['N', 'E', 'S', 'W'].map((label, i) => {
            const [x, y] = polar(i * 90, MAX_R + 16);
            return (
              <text
                key={label}
                x={x}
                y={y}
                fontSize={11}
                fontWeight={600}
                fill="#4b5563"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {label}
              </text>
            );
          })}
        </svg>
        <div className="space-y-1 text-xs text-gray-600">
          <p className="font-medium text-gray-900">Wind speed at 100 m</p>
          {data.speedClasses.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 rounded-sm"
                style={{ background: SPEED_COLORS[i] }}
              />
              {label}
            </div>
          ))}
          <p className="pt-2 text-gray-400">{data.sampleHours.toLocaleString()} hours sampled</p>
        </div>
      </CardContent>
    </Card>
  );
}
