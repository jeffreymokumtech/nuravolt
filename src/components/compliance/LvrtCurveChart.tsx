import type { LVRTPoint } from '@/config/compliance/types';

interface Props {
  curve: LVRTPoint[];
  /** Plant country, used only for the title. */
  country: string;
  width?: number;
  height?: number;
}

/**
 * Inline SVG chart of the LVRT envelope.
 *
 *   u (pu)                        t_max = last point
 *    1.0 ┤
 *        │         ╭──────
 *    0.5 ┤    ╭────╯
 *        │    │
 *    0.0 ┤────╯
 *        └──────────────────▶ t (ms)
 *
 * The shaded area above the curve is the "must stay connected" region.
 */
export default function LvrtCurveChart({ curve, country, width = 520, height = 220 }: Props) {
  if (!curve || curve.length === 0) return null;

  const padding = { top: 16, right: 16, bottom: 34, left: 42 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const tMax = Math.max(...curve.map((p) => p.t_ms), 3000);
  const uMax = 1.0;

  const x = (t: number) => padding.left + (t / tMax) * plotW;
  const y = (u: number) => padding.top + (1 - u / uMax) * plotH;

  // Build the polyline
  const pathPoints = curve.map((p) => `${x(p.t_ms)},${y(p.u_pu)}`).join(' ');

  // Build the "must stay connected" region: above the curve up to u=1.0
  const regionPath = [
    `M ${x(curve[0].t_ms)},${y(curve[0].u_pu)}`,
    ...curve.slice(1).map((p) => `L ${x(p.t_ms)},${y(p.u_pu)}`),
    `L ${x(tMax)},${y(uMax)}`,
    `L ${x(curve[0].t_ms)},${y(uMax)}`,
    'Z',
  ].join(' ');

  // Y grid
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
  // X grid (ms): choose human ticks
  const xTicks = [0, 500, 1000, 1500, 2000, 2500, 3000].filter((t) => t <= tMax);

  return (
    <figure className="compliance-viz">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`LVRT ride-through envelope for ${country}`}
        style={{ maxWidth: '100%', height: 'auto' }}
      >
        {/* Y grid */}
        {yTicks.map((u) => (
          <g key={`y-${u}`}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(u)}
              y2={y(u)}
              stroke="#e5e7eb"
              strokeDasharray="2 3"
            />
            <text
              x={padding.left - 6}
              y={y(u) + 3}
              fontSize="10"
              fill="#6b7280"
              textAnchor="end"
            >
              {u.toFixed(2)}
            </text>
          </g>
        ))}
        {/* X grid */}
        {xTicks.map((t) => (
          <g key={`x-${t}`}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={padding.top}
              y2={height - padding.bottom}
              stroke="#f1f5f9"
            />
            <text
              x={x(t)}
              y={height - padding.bottom + 14}
              fontSize="10"
              fill="#6b7280"
              textAnchor="middle"
            >
              {t} ms
            </text>
          </g>
        ))}

        {/* Must-stay-connected region */}
        <path d={regionPath} fill="#bfdbfe" fillOpacity="0.45" />

        {/* Curve itself */}
        <polyline
          points={pathPoints}
          fill="none"
          stroke="#1d4ed8"
          strokeWidth="2"
        />

        {/* Point markers */}
        {curve.map((p, i) => (
          <circle
            key={i}
            cx={x(p.t_ms)}
            cy={y(p.u_pu)}
            r="3"
            fill="#1d4ed8"
          />
        ))}

        {/* Axis labels */}
        <text
          x={padding.left + plotW / 2}
          y={height - 4}
          fontSize="10"
          fill="#374151"
          textAnchor="middle"
          fontWeight="600"
        >
          Time after fault (ms)
        </text>
        <text
          x={10}
          y={padding.top + plotH / 2}
          fontSize="10"
          fill="#374151"
          textAnchor="middle"
          fontWeight="600"
          transform={`rotate(-90 10 ${padding.top + plotH / 2})`}
        >
          Voltage (p.u.)
        </text>

        {/* Legend */}
        <g transform={`translate(${width - padding.right - 140}, ${padding.top + 4})`}>
          <rect width="10" height="10" fill="#bfdbfe" fillOpacity="0.55" />
          <text x="14" y="9" fontSize="10" fill="#374151">
            Must stay connected
          </text>
        </g>
      </svg>
      <figcaption className="text-xs text-gray-500 mt-1">
        Voltage dips on or above the blue line: the plant must ride through without tripping. Dips below the line: disconnection permitted.
      </figcaption>
    </figure>
  );
}
