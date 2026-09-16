'use client';

import Link from 'next/link';
import { ArrowRight, FileText } from 'lucide-react';
import type { ReactNode } from 'react';

interface KPI {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

interface SampleDashboard {
  id: string;
  title: string;
  plant: string;
  description: string;
  kpis: KPI[];
  thumbnail: ReactNode;
}

// -----------------------------------------------------------------------------
// Thumbnails, inline SVGs sized to a 16:9-ish card hero (320×140 viewBox).
// Data is illustrative but uses consistent shapes so the cards read as real
// snapshots rather than placeholders.
// -----------------------------------------------------------------------------

function HeliosThumbnail() {
  // Expected vs actual power over 30 days, actual dips below expected
  // mid-period (soiling event), then partially recovers.
  const expected = [
    72, 74, 75, 76, 77, 76, 75, 74, 73, 72, 71, 70, 70, 71, 72,
    73, 74, 75, 76, 77, 78, 77, 76, 75, 74, 73, 72, 71, 70, 69,
  ];
  const actual = [
    71, 73, 74, 74, 73, 71, 68, 65, 62, 60, 58, 56, 55, 54, 55,
    57, 60, 64, 67, 69, 71, 70, 69, 68, 67, 66, 65, 64, 63, 62,
  ];
  const W = 320;
  const H = 140;
  const PAD = 10;
  const xs = (i: number) => PAD + (i / (expected.length - 1)) * (W - 2 * PAD);
  const yMin = 50;
  const yMax = 80;
  const ys = (v: number) =>
    H - PAD - ((v - yMin) / (yMax - yMin)) * (H - 2 * PAD);
  const linePath = (data: number[]) =>
    data.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`).join(' ');
  const areaPath = `${linePath(actual)} L ${xs(actual.length - 1).toFixed(1)} ${H - PAD} L ${xs(0).toFixed(1)} ${H - PAD} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id="helios-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* horizontal guide */}
      <line x1={PAD} y1={ys(yMin + (yMax - yMin) / 2)} x2={W - PAD} y2={ys(yMin + (yMax - yMin) / 2)} stroke="#f3f4f6" strokeDasharray="2 3" />
      <path d={areaPath} fill="url(#helios-fill)" />
      <path d={linePath(expected)} fill="none" stroke="#9ca3af" strokeWidth="1.25" strokeDasharray="3 3" />
      <path d={linePath(actual)} fill="none" stroke="#2563eb" strokeWidth="1.75" strokeLinecap="round" />
      {/* anomaly markers, the three dips */}
      {[9, 13, 14].map((i) => (
        <circle key={i} cx={xs(i)} cy={ys(actual[i])} r="2.5" fill="#ef4444" stroke="white" strokeWidth="1" />
      ))}
    </svg>
  );
}

function ZephyrThumbnail() {
  // Availability heatmap, 10 turbines × 14 days. Mostly green, a couple of
  // amber/red cells to show the system is detecting issues.
  const TURBINES = 10;
  const DAYS = 14;
  // deterministic "score" per cell
  const score = (t: number, d: number): number => {
    const seed = (t * 31 + d * 17) % 100;
    if (t === 2 && d >= 8 && d <= 11) return 30; // failing turbine
    if (t === 6 && d === 12) return 40;
    if (t === 8 && d === 5) return 50;
    if (seed < 8) return 60 + (seed % 30);
    return 88 + (seed % 12);
  };
  const fill = (s: number) =>
    s >= 90 ? '#10b981' : s >= 75 ? '#34d399' : s >= 60 ? '#fbbf24' : s >= 40 ? '#f59e0b' : '#ef4444';
  const W = 320;
  const H = 140;
  const PAD_X = 12;
  const PAD_Y = 14;
  const cellW = (W - 2 * PAD_X) / DAYS;
  const cellH = (H - 2 * PAD_Y) / TURBINES;
  const cells: JSX.Element[] = [];
  for (let t = 0; t < TURBINES; t++) {
    for (let d = 0; d < DAYS; d++) {
      cells.push(
        <rect
          key={`${t}-${d}`}
          x={PAD_X + d * cellW + 0.5}
          y={PAD_Y + t * cellH + 0.5}
          width={cellW - 1}
          height={cellH - 1}
          rx={1.5}
          fill={fill(score(t, d))}
        />
      );
    }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" aria-hidden>
      {cells}
    </svg>
  );
}

function PortfolioThumbnail() {
  // Loss waterfall / revenue-at-risk by plant, 4 bars descending with a
  // running total ghost line behind. Restrained palette so it reads as data,
  // not decoration.
  const bars = [
    { label: 'Helios PV', value: 18.4, color: '#2563eb' },
    { label: 'Helios PV (BESS)', value: 6.2, color: '#60a5fa' },
    { label: 'Zephyr Wind', value: 9.5, color: '#0ea5e9' },
    { label: 'Reserve', value: 5.8, color: '#cbd5e1' },
  ];
  const W = 320;
  const H = 140;
  const PAD_X = 18;
  const PAD_Y_TOP = 14;
  const PAD_Y_BOT = 26;
  const max = Math.max(...bars.map((b) => b.value));
  const barWidth = (W - 2 * PAD_X) / bars.length - 8;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" aria-hidden>
      {/* baseline */}
      <line x1={PAD_X} y1={H - PAD_Y_BOT} x2={W - PAD_X} y2={H - PAD_Y_BOT} stroke="#e5e7eb" />
      {bars.map((b, i) => {
        const h = ((H - PAD_Y_TOP - PAD_Y_BOT) * b.value) / max;
        const x = PAD_X + i * ((W - 2 * PAD_X) / bars.length) + 4;
        const y = H - PAD_Y_BOT - h;
        return (
          <g key={b.label}>
            <rect x={x} y={y} width={barWidth} height={h} rx={2} fill={b.color} />
            <text
              x={x + barWidth / 2}
              y={y - 4}
              textAnchor="middle"
              fontSize="9"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fill="#475569"
            >
              €{b.value.toFixed(1)}k
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// -----------------------------------------------------------------------------

const SAMPLE_DASHBOARDS: SampleDashboard[] = [
  {
    id: 'helios-30d',
    title: 'Helios PV, Last 30 Days',
    plant: 'Helios PV · 45 MW',
    description:
      'Expected vs measured power with anomaly markers, loss disaggregation waterfall, fleet residual ranking.',
    kpis: [
      { label: 'PR', value: '94.1%', tone: 'good' },
      { label: 'Loss', value: '€12.4k', tone: 'warn' },
      { label: 'Anomalies', value: '3', tone: 'warn' },
    ],
    thumbnail: <HeliosThumbnail />,
  },
  {
    id: 'zephyr-fleet-health',
    title: 'Zephyr Wind, Fleet Health',
    plant: 'Zephyr Wind · 20 MW',
    description:
      'Turbine health scores, power curve drift, availability heatmap, and RUL across 10 turbines.',
    kpis: [
      { label: 'Avail', value: '96.8%', tone: 'good' },
      { label: 'Drifted', value: '2', tone: 'warn' },
      { label: 'Critical', value: '0', tone: 'good' },
    ],
    thumbnail: <ZephyrThumbnail />,
  },
  {
    id: 'portfolio-overview',
    title: 'Portfolio Overview',
    plant: 'All plants',
    description:
      'Cross-plant KPIs: revenue-at-risk by asset, budget deviation, composite risk, capacity-weighted PR.',
    kpis: [
      { label: 'Rev. at risk', value: '€28.1k', tone: 'warn' },
      { label: 'Plants', value: '2', tone: 'neutral' },
      { label: 'Composite risk', value: '18/100', tone: 'good' },
    ],
    thumbnail: <PortfolioThumbnail />,
  },
];

function KpiPill({ k }: { k: KPI }) {
  const tone = k.tone ?? 'neutral';
  const cls =
    tone === 'good'
      ? 'text-signal-positive'
      : tone === 'warn'
      ? 'text-signal-warning'
      : tone === 'bad'
      ? 'text-signal-critical'
      : 'text-ink-2';
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-bold uppercase tracking-wider text-ink-3">
        {k.label}
      </span>
      <span className={`text-sm font-semibold ${cls}`}>{k.value}</span>
    </div>
  );
}

export default function ShowcaseReportsHubPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-8">
      <div className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">Sample Reports</h1>
          <p className="text-sm text-ink-3 mt-1">
            Three hand-built dashboards · read-only · sharable links
          </p>
        </div>
        <Link
          href="/platform/reporting"
          className="text-sm text-blue-600 hover:text-blue-800 font-semibold hidden sm:inline"
        >
          How the reporter works →
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {SAMPLE_DASHBOARDS.map((d) => (
          <Link
            key={d.id}
            href={`/showcase/reports/${d.id}`}
            className="group flex flex-col rounded-xl bg-white border border-divider overflow-hidden hover:shadow-lg hover:border-blue-300 hover:-translate-y-0.5 transition-all duration-200"
          >
            {/* Chart thumbnail, replaces the saturated gradient band */}
            <div className="relative h-36 bg-gradient-to-b from-gray-50 to-white border-b border-divider">
              {d.thumbnail}
              <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-white/90 backdrop-blur px-2 py-0.5 text-[10px] font-semibold text-signal-positive border border-signal-positive/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Read-only
              </span>
            </div>

            <div className="flex flex-1 flex-col p-5">
              <div className="text-[11px] text-ink-3 font-semibold uppercase tracking-wider mb-1">
                {d.plant}
              </div>
              <h3 className="text-base font-bold text-ink group-hover:text-blue-600 transition-colors mb-2">
                {d.title}
              </h3>
              <p className="text-xs text-ink-2 leading-relaxed mb-4">
                {d.description}
              </p>

              <div className="mt-auto pt-3 border-t border-divider">
                <div className="grid grid-cols-3 gap-3 mb-3">
                  {d.kpis.map((k) => (
                    <KpiPill key={k.label} k={k} />
                  ))}
                </div>
                <div className="flex items-center justify-end text-sm">
                  <span className="text-blue-600 font-semibold inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                    Open <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-8 rounded-xl border border-blue-200 bg-blue-50 p-5 flex items-start gap-4">
        <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-blue-900 leading-relaxed">
          <strong>These are baked snapshots.</strong> In production, every dashboard is
          live, drag widgets, pick a time range, schedule a PDF delivery, or enable a
          shareable public URL in one click. See{' '}
          <Link href="/platform/reporting" className="underline font-semibold">
            the reporting page
          </Link>{' '}
          for the full workflow.
        </div>
      </div>
    </div>
  );
}
