import type { ReportObligation } from '@/config/compliance/types';

interface Props {
  obligations: ReportObligation[];
  width?: number;
}

const CADENCE_ORDER = ['event_based', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;

const CADENCE_COLOR: Record<string, string> = {
  monthly: '#2563eb',
  quarterly: '#7c3aed',
  semi_annual: '#db2777',
  annual: '#b45309',
  event_based: '#047857',
};

/**
 * Timeline visualisation grouping obligations by cadence. Each row is a cadence
 * bucket; markers within a row correspond to the obligations due in that bucket.
 */
export default function ObligationTimeline({ obligations, width = 540 }: Props) {
  if (!obligations || obligations.length === 0) {
    return <p className="text-sm text-gray-500 italic">No reporting obligations in this pack.</p>;
  }

  const rowHeight = 38;
  const paddingLeft = 120;
  const plotWidth = width - paddingLeft - 10;
  const rowsUsed = CADENCE_ORDER.filter((c) => obligations.some((o) => o.cadence === c));
  const height = rowsUsed.length * rowHeight + 24;

  return (
    <figure className="compliance-viz">
      <svg width={width} height={height} role="img" style={{ maxWidth: '100%', height: 'auto' }}>
        {rowsUsed.map((cadence, rowIdx) => {
          const y = 12 + rowIdx * rowHeight;
          const rowObligations = obligations.filter((o) => o.cadence === cadence);
          return (
            <g key={cadence}>
              {/* Row label */}
              <text x={paddingLeft - 10} y={y + 16} fontSize="11" fill="#374151" textAnchor="end" fontWeight="600">
                {cadence.replace('_', ' ')}
              </text>
              {/* Row background */}
              <rect
                x={paddingLeft}
                y={y}
                width={plotWidth}
                height={rowHeight - 12}
                fill="#f8fafc"
                stroke="#e2e8f0"
              />
              {/* Chips */}
              {rowObligations.map((o, i) => {
                const chipW = Math.min(plotWidth / rowObligations.length - 6, 180);
                const chipX = paddingLeft + 4 + i * (chipW + 6);
                return (
                  <g key={o.id}>
                    <rect
                      x={chipX}
                      y={y + 3}
                      width={chipW}
                      height={rowHeight - 18}
                      rx={3}
                      fill={CADENCE_COLOR[cadence] || '#475569'}
                      fillOpacity="0.15"
                      stroke={CADENCE_COLOR[cadence] || '#475569'}
                      strokeWidth="1"
                    />
                    <text
                      x={chipX + 6}
                      y={y + 14}
                      fontSize="10"
                      fill="#0f172a"
                      fontWeight="600"
                    >
                      {truncate(o.name, 28)}
                    </text>
                    {/* An unset deadline means the pack has not verified it against the
                        source document, so say so instead of showing a day count. */}
                    <text x={chipX + 6} y={y + 24} fontSize="9" fill="#475569">
                      → {o.recipient} ·{' '}
                      {o.deadline_days_after_period != null
                        ? `${o.deadline_days_after_period}d`
                        : 'not verified'}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-gray-500 mt-1">
        Deadline shown in days after the end of each reporting period.
      </figcaption>
    </figure>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
