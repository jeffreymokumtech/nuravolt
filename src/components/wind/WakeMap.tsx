/**
 * WakeMap - farm layout with per-turbine annual wake loss.
 *
 * Turbines are plotted at their true relative positions (meters east/north
 * of the farm centroid) and colored by frequency-weighted annual wake loss
 * from the Jensen model (nuravolt.wind.wake_model). An arrow marks the
 * prevailing wind direction; the side panel ranks turbines by loss so the
 * most wake-affected machines stand out.
 */

'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Waves } from 'lucide-react';

export interface WakeTurbine {
  id: string;
  x: number;
  y: number;
  annualWakeLossPct: number;
}

export interface WakeSector {
  sector: string;
  centerDeg: number;
  frequencyPct: number;
  farmLossPct: number;
  turbineLossPct: number[];
}

export interface WakeAnalysisData {
  model: string;
  windSource: string;
  farm: { annualWakeLossPct: number; farmEfficiencyPct: number; ratedPowerKw: number };
  turbines: WakeTurbine[];
  sectors: WakeSector[];
}

const W = 420;
const H = 300;
const PAD = 44;

function lossColor(pct: number, max: number): string {
  const t = max > 0 ? Math.min(1, pct / max) : 0;
  // green → amber → red
  if (t < 0.5) {
    const u = t / 0.5;
    return `rgb(${Math.round(34 + u * (245 - 34))}, ${Math.round(197 - u * (197 - 158))}, ${Math.round(94 - u * 83)})`;
  }
  const u = (t - 0.5) / 0.5;
  return `rgb(${Math.round(245 - u * 6)}, ${Math.round(158 - u * 90)}, ${Math.round(11 + u * 57)})`;
}

export default function WakeMap({ data }: { data: WakeAnalysisData }) {
  const { turbines, sectors, farm } = data;

  const scale = useMemo(() => {
    const xs = turbines.map((t) => t.x);
    const ys = turbines.map((t) => t.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 200);
    const spanY = Math.max(maxY - minY, 200);
    const s = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
    return {
      toPx: (t: WakeTurbine) => ({
        px: PAD + (t.x - minX) * s + ((W - 2 * PAD) - spanX * s) / 2,
        // SVG y grows downward; site y grows north.
        py: H - PAD - (t.y - minY) * s - ((H - 2 * PAD) - spanY * s) / 2,
      }),
    };
  }, [turbines]);

  const maxLoss = Math.max(...turbines.map((t) => t.annualWakeLossPct), 1);
  const prevailing = useMemo(
    () => [...sectors].sort((a, b) => b.frequencyPct - a.frequencyPct)[0],
    [sectors]
  );
  const ranked = useMemo(
    () => [...turbines].sort((a, b) => b.annualWakeLossPct - a.annualWakeLossPct),
    [turbines]
  );

  // Prevailing-wind arrow: points FROM the direction the wind comes from.
  const arrow = useMemo(() => {
    const rad = ((prevailing.centerDeg - 90) * Math.PI) / 180;
    const cx = W - 52, cy = 46, r = 20;
    return {
      x1: cx - r * Math.cos(rad),
      y1: cy - r * Math.sin(rad),
      x2: cx + r * Math.cos(rad),
      y2: cy + r * Math.sin(rad),
      cx,
      cy,
    };
  }, [prevailing]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Waves className="h-4 w-4 text-blue-600" />
          Wake losses
        </CardTitle>
        <p className="text-xs text-gray-500">
          {data.model} · farm efficiency{' '}
          <span className="font-semibold text-gray-900">{farm.farmEfficiencyPct}%</span> · annual
          wake loss <span className="font-semibold text-gray-900">{farm.annualWakeLossPct}%</span>
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 lg:flex-row">
        <svg viewBox={`0 0 ${W} ${H}`} className="min-w-0 flex-1 rounded-md border border-gray-100 bg-gray-50">
          <defs>
            <marker id="wake-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#6b7280" />
            </marker>
          </defs>
          {/* prevailing wind arrow */}
          <circle cx={arrow.cx} cy={arrow.cy} r={24} fill="white" stroke="#e5e7eb" />
          <line
            x1={arrow.x1}
            y1={arrow.y1}
            x2={arrow.x2}
            y2={arrow.y2}
            stroke="#6b7280"
            strokeWidth={1.5}
            markerEnd="url(#wake-arrow)"
          />
          <text x={arrow.cx} y={arrow.cy + 36} fontSize={9} fill="#6b7280" textAnchor="middle">
            {prevailing.sector} {prevailing.frequencyPct}%
          </text>

          {turbines.map((t) => {
            const { px, py } = scale.toPx(t);
            return (
              <g key={t.id}>
                <circle
                  cx={px}
                  cy={py}
                  r={11}
                  fill={lossColor(t.annualWakeLossPct, maxLoss)}
                  stroke="white"
                  strokeWidth={2}
                >
                  <title>{`${t.id} · annual wake loss ${t.annualWakeLossPct}%`}</title>
                </circle>
                <text x={px} y={py - 15} fontSize={9} fontWeight={600} fill="#374151" textAnchor="middle">
                  {t.id}
                </text>
                <text x={px} y={py + 3.5} fontSize={8} fontWeight={700} fill="white" textAnchor="middle">
                  {Math.round(t.annualWakeLossPct)}
                </text>
              </g>
            );
          })}
          <text x={10} y={H - 10} fontSize={8} fill="#9ca3af">
            true relative layout · labels show annual wake loss %
          </text>
        </svg>

        <div className="w-full space-y-1.5 lg:w-56">
          <p className="text-xs font-medium text-gray-900">Ranked by wake loss</p>
          {ranked.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs">
              <span className="w-9 font-mono text-gray-600">{t.id}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(t.annualWakeLossPct / maxLoss) * 100}%`,
                    background: lossColor(t.annualWakeLossPct, maxLoss),
                  }}
                />
              </div>
              <span className="w-11 text-right font-medium text-gray-900">
                {t.annualWakeLossPct}%
              </span>
            </div>
          ))}
          <p className="pt-2 text-[11px] leading-snug text-gray-400">
            Wake steering / layout review pays off where the red machines sit
            downwind of the prevailing sector.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
