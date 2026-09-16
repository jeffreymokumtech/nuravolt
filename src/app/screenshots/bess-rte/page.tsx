'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Marketing screenshot: BESS Block 7 plant overview WITH the NuraVolt Copilot
// rail open on the right answering "why did RTE drop?". Mirrors the real
// product UX where CopilotRail is mounted on every /demo/* and /showcase/* page.
//
// Edit the SOURCE_OF_TRUTH constants below to swap in real Block 7 numbers.
// Route: /screenshots/bess-rte
// Recommended viewport: 1440 × 1100 (Chrome DevTools "Capture full size").
// ─────────────────────────────────────────────────────────────────────────────

import {
  User,
  Bot,
  ChevronDown,
  MessageSquare,
  Library,
  ExternalLink,
  X,
  Target,
  Battery,
  Bell,
  Settings,
  ChevronRight,
  Activity,
  TrendingDown,
  Zap,
  Search,
} from 'lucide-react';

const SOURCE_OF_TRUTH = {
  question: "Why did Block 7's round-trip efficiency drop?",

  plantName: 'Sapphire Ridge BESS',
  plantOwner: 'Pearl Energy Partners',
  plantLocation: 'Riverside County, CA',
  blockId: 'Block 7',
  blockSizeMWh: 100,
  blockRatingMW: 25,
  totalBlocks: 12,

  // Block-level signal
  rteBefore: 84.3,
  rteAfter: 82.5,
  rteWindowDays: 23,
  fleetMedianRte: 84.1,

  soh: 96.8,
  sohYearAgo: 98.1,
  throughput30d: 2_415, // MWh
  efc30d: 24,
  socNow: 62,

  // Rack decomposition
  totalRacks: 24,
  rackRangeLow: 81.7,
  rackRangeHigh: 86.2,
  rackTolerancePts: 0.4,
  offendingRackId: 'R-07-14',
  offendingRackRtePts: -2.9,

  // Thermal signal on the offending rack
  rackMeanTempC: 31.8,
  blockMedianTempC: 27.6,
  tempDeltaC: 4.2,
  driftStartDate: 'Apr 18',
  thermalAlarmThresholdC: 35,

  // Revenue impact
  energyLostPerCycleMWh: 1.8,
  cyclesPerYear: 365,
  annualRevenueLossUSD: 185_000,

  elapsedSeconds: 9,

  // Time range shown on the dashboard
  rangeLabel: 'Last 30 days',
};

const S = SOURCE_OF_TRUTH;

// Per-rack RTE for the heatmap. R-07-14 (index 13) is the outlier.
const RACK_RTE: number[] = [
  84.1, 84.5, 83.9, 84.3, 84.2, 84.7, 83.8, 84.4, 84.0, 84.6,
  83.7, 84.2, 84.5, 81.4, 84.1, 84.3, 84.8, 83.9, 84.2, 84.4,
  84.0, 84.6, 84.1, 84.3,
];

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard (left side)
// ─────────────────────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 text-xs font-bold text-white">
            N
          </div>
          <span className="text-sm font-semibold text-gray-900">NuraVolt</span>
        </div>
        <nav className="flex items-center gap-1 text-xs text-gray-600">
          <span className="rounded-md bg-blue-50 px-2.5 py-1 font-medium text-blue-700">
            Storage
          </span>
          <span className="rounded-md px-2.5 py-1">Solar</span>
          <span className="rounded-md px-2.5 py-1">Wind</span>
          <span className="rounded-md px-2.5 py-1">Hybrid</span>
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex w-64 items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-400">
          <Search className="h-3.5 w-3.5" />
          <span>Search assets, faults, tickets…</span>
        </div>
        <button className="relative rounded-md p-1.5 text-gray-500 hover:bg-gray-100">
          <Bell className="h-4 w-4" />
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500" />
        </button>
        <button className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100">
          <Settings className="h-4 w-4" />
        </button>
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-800 text-xs font-semibold text-white">
          JD
        </div>
      </div>
    </header>
  );
}

function Breadcrumb() {
  return (
    <div className="border-b border-gray-200 bg-white px-6 py-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span>Storage</span>
        <ChevronRight className="h-3 w-3" />
        <span>Fleet</span>
        <ChevronRight className="h-3 w-3" />
        <span>{S.plantName}</span>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-gray-900">{S.blockId}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <Battery className="h-5 w-5 text-blue-600" />
            {S.plantName} · {S.blockId}
          </h1>
          <p className="text-[11px] text-gray-500">
            {S.blockRatingMW} MW / {S.blockSizeMWh} MWh · {S.plantLocation} ·{' '}
            {S.plantOwner}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-600">
            <span className="text-gray-400">Range:</span>
            <span className="font-medium text-gray-800">{S.rangeLabel}</span>
            <ChevronDown className="h-3 w-3 text-gray-400" />
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Online · streaming
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  unit,
  color,
  trend,
  trendNeg,
}: {
  label: string;
  value: string;
  unit: string;
  color: string;
  trend?: string;
  trendNeg?: boolean;
}) {
  return (
    <div
      className="rounded-lg border border-gray-100 p-3.5"
      style={{ backgroundColor: `${color}10` }}
    >
      <div className="text-[11px] text-gray-600">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-bold" style={{ color }}>
          {value}
        </span>
        <span className="text-[11px] text-gray-500">{unit}</span>
      </div>
      {trend && (
        <div
          className={`mt-0.5 flex items-center gap-1 text-[10px] ${
            trendNeg ? 'text-red-600' : 'text-emerald-600'
          }`}
        >
          {trendNeg && <TrendingDown className="h-2.5 w-2.5" />}
          {trend}
        </div>
      )}
    </div>
  );
}

function KpiRow() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Block KPIs</h3>
        <span className="text-[10px] text-gray-500">{S.rangeLabel}</span>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <KpiTile
          label="Round-trip efficiency"
          value={S.rteAfter.toFixed(1)}
          unit="%"
          color="#F59E0B"
          trend={`−${(S.rteBefore - S.rteAfter).toFixed(1)} pts vs prior`}
          trendNeg
        />
        <KpiTile
          label="State of health"
          value={S.soh.toFixed(1)}
          unit="%"
          color="#3B82F6"
          trend={`−${(S.sohYearAgo - S.soh).toFixed(1)} pts YoY`}
          trendNeg
        />
        <KpiTile
          label="Throughput"
          value={S.throughput30d.toLocaleString()}
          unit="MWh"
          color="#8B5CF6"
          trend={`${S.efc30d} EFC`}
        />
        <KpiTile
          label="Current SoC"
          value={S.socNow.toString()}
          unit="%"
          color="#10B981"
          trend="charging at 0.4C"
        />
      </div>
    </div>
  );
}

function RteSparkline() {
  // 30 days of synthetic RTE history. Drop starts around day 7.
  const points: number[] = [];
  for (let i = 0; i < 30; i++) {
    const base = i < 7 ? 84.4 + (Math.sin(i) * 0.15) : 82.6 + (Math.sin(i) * 0.2);
    points.push(base);
  }
  const W = 540;
  const H = 110;
  const min = 81.5;
  const max = 85;
  const path = points
    .map((y, i) => {
      const x = (i / (points.length - 1)) * (W - 8) + 4;
      const py = H - ((y - min) / (max - min)) * (H - 16) - 8;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(' ');

  // Shaded "drift start" zone (last 23 days)
  const driftStartX = (7 / 29) * (W - 8) + 4;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-amber-500" />
          <h3 className="text-sm font-semibold text-gray-900">
            Block round-trip efficiency · daily
          </h3>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-500" />
            Block 7
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-gray-300" />
            Fleet median
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full">
        {/* Drift region shading */}
        <rect
          x={driftStartX}
          y={4}
          width={W - driftStartX - 4}
          height={H - 8}
          fill="#FEE2E2"
          opacity="0.45"
        />
        {/* Fleet median dashed line */}
        <line
          x1={4}
          x2={W - 4}
          y1={H - ((S.fleetMedianRte - min) / (max - min)) * (H - 16) - 8}
          y2={H - ((S.fleetMedianRte - min) / (max - min)) * (H - 16) - 8}
          stroke="#D1D5DB"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* Block 7 line */}
        <path d={path} fill="none" stroke="#F59E0B" strokeWidth={2} />
        {/* Last-point dot */}
        <circle
          cx={W - 4}
          cy={H - ((points[points.length - 1] - min) / (max - min)) * (H - 16) - 8}
          r={3}
          fill="#F59E0B"
        />
        {/* Drift annotation */}
        <text x={driftStartX + 6} y={18} fontSize={9} fill="#B91C1C">
          drift since {S.driftStartDate}
        </text>
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-400">
        <span>30d ago</span>
        <span>today</span>
      </div>
    </div>
  );
}

function RackHeatmap() {
  // Map rack RTE to a color from green (good) to red (bad).
  const colorFor = (rte: number) => {
    if (rte < 82.5) return { bg: '#FEE2E2', text: '#991B1B', ring: '#FCA5A5' };
    if (rte < 83.7) return { bg: '#FEF3C7', text: '#92400E', ring: '#FCD34D' };
    return { bg: '#D1FAE5', text: '#065F46', ring: '#A7F3D0' };
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Per-rack round-trip efficiency
        </h3>
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-emerald-200" />
            ≥83.7%
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-amber-200" />
            82.5-83.7%
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-red-200" />
            &lt;82.5%
          </span>
        </div>
      </div>
      <div className="grid grid-cols-8 gap-1.5">
        {RACK_RTE.map((rte, i) => {
          const id = `R-07-${(i + 1).toString().padStart(2, '0')}`;
          const isOutlier = id === S.offendingRackId;
          const c = colorFor(rte);
          return (
            <div
              key={id}
              className="relative flex flex-col items-center justify-center rounded-md py-2 text-[9px] font-medium"
              style={{
                backgroundColor: c.bg,
                color: c.text,
                boxShadow: isOutlier ? `0 0 0 2px ${c.ring}` : undefined,
              }}
            >
              <span className="font-mono">{id}</span>
              <span className="mt-0.5 font-semibold">{rte.toFixed(1)}%</span>
              {isOutlier && (
                <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-red-500 text-[7px] font-bold text-white shadow">
                  !
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
        <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          1 of {S.totalRacks} racks ({S.offendingRackId}) is{' '}
          {S.offendingRackRtePts.toFixed(1)} pts below the block median.
          Copilot identified the driver, see right.
        </span>
      </div>
    </div>
  );
}

function Dashboard() {
  return (
    <div className="flex-1 overflow-hidden bg-gray-50">
      <TopBar />
      <Breadcrumb />
      <div className="space-y-4 p-6">
        <KpiRow />
        <RteSparkline />
        <RackHeatmap />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Copilot rail (right side), mirrors CopilotRail.tsx
// ─────────────────────────────────────────────────────────────────────────────

function ToolStep({
  status,
  toolName,
  input,
  output,
  durationMs,
}: {
  status: 'done' | 'running';
  toolName: string;
  input: string;
  output: string;
  durationMs: number;
}) {
  return (
    <div className="my-2 rounded-md border border-gray-200 bg-gray-50 text-xs">
      <div className="flex w-full items-center gap-2 px-3 py-2 text-gray-700">
        <span
          className={`h-2 w-2 rounded-full ${
            status === 'done' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
          }`}
        />
        <span className="font-mono text-gray-900">{toolName}</span>
        <span className="ml-auto text-gray-500">
          {status === 'done' ? 'Done' : 'Running…'} · {durationMs} ms
        </span>
        <ChevronDown className="h-3 w-3 text-gray-400" />
      </div>
      <div className="space-y-2 border-t border-gray-200 px-3 py-2 font-mono text-[10px]">
        <div>
          <div className="mb-0.5 text-gray-500">input</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-gray-700">
            {input}
          </pre>
        </div>
        <div>
          <div className="mb-0.5 text-gray-500">output</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-gray-700">
            {output}
          </pre>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="group flex w-full flex-row-reverse gap-2 px-3 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm">
        <User className="h-3.5 w-3.5" />
      </div>
      <div className="relative max-w-[85%]">
        <div className="rounded-2xl rounded-tr-none bg-blue-600 px-3.5 py-2 text-xs leading-relaxed text-white shadow-sm">
          {text}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="group flex w-full flex-row gap-2 px-3 py-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-800 text-white shadow-sm">
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="relative w-full max-w-[88%]">
        <div className="rounded-2xl rounded-tl-none border border-gray-100 bg-white px-3.5 py-2 text-xs leading-relaxed text-gray-900 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}

function ConclusionCard() {
  const formatUSD = (n: number) =>
    n.toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <div className="my-2 rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-blue-700">
          Root cause · {S.blockId}
        </span>
        <span className="text-[10px] text-gray-500">
          {S.elapsedSeconds}s · 4 tools
        </span>
      </div>

      <div className="mb-2.5 text-xs font-medium leading-relaxed text-gray-900">
        Rack {S.offendingRackId} is running {S.tempDeltaC.toFixed(1)}°C hotter than
        its neighbors. It started drifting {S.driftStartDate} and is dragging
        block RTE down by {(S.rteBefore - S.rteAfter).toFixed(1)} points.
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-blue-200 pt-2.5">
        <div>
          <div className="text-[9px] uppercase tracking-wide text-gray-500">
            Rack
          </div>
          <div className="font-mono text-xs font-semibold text-gray-900">
            {S.offendingRackId}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-gray-500">
            Cell temp delta
          </div>
          <div className="text-xs font-semibold text-amber-600">
            +{S.tempDeltaC.toFixed(1)}°C
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-gray-500">
            Block RTE
          </div>
          <div className="text-xs font-semibold text-red-600">
            −{(S.rteBefore - S.rteAfter).toFixed(1)} pts
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-gray-500">
            Revenue at risk
          </div>
          <div className="text-xs font-semibold text-red-600">
            ~${formatUSD(S.annualRevenueLossUSD)}/yr
          </div>
        </div>
      </div>

      <div className="mt-2.5 border-t border-blue-200 pt-2 text-[11px] leading-snug text-gray-700">
        <span className="font-medium text-gray-900">Why no alarm tripped:</span>{' '}
        threshold is {S.thermalAlarmThresholdC}°C absolute. Rack is{' '}
        {(S.thermalAlarmThresholdC - S.rackMeanTempC).toFixed(1)}°C below it, a
        relative-deviation rule would catch this earlier.
      </div>

      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <button className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[10px] text-gray-700">
          Dismiss
        </button>
        <button className="rounded bg-blue-600 px-2 py-0.5 text-[10px] font-medium text-white">
          Create maintenance ticket
        </button>
      </div>
    </div>
  );
}

function CopilotRailMock() {
  return (
    <aside className="flex h-full w-[440px] shrink-0 flex-col border-l border-gray-200 bg-white">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-blue-50 p-1.5">
            <MessageSquare className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">NuraVolt Copilot</h2>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] font-medium text-gray-500">
                Plant copilot
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-lg p-2 text-gray-400">
            <Library className="h-4 w-4" />
          </button>
          <button className="rounded-lg p-2 text-gray-400">
            <ExternalLink className="h-4 w-4" />
          </button>
          <div className="mx-1 h-4 w-px bg-gray-200" />
          <button className="rounded-lg p-2 text-gray-400">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* AssetContextChip */}
      <div className="border-b border-gray-200 bg-gray-50/50 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 rounded-lg bg-blue-50 px-2 py-1 ring-1 ring-blue-100">
            <Target className="h-3 w-3 text-blue-700" />
            <span className="text-[10px] font-bold uppercase tracking-tight text-blue-700">
              Scope
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex flex-col">
              <span className="text-[8px] font-bold uppercase leading-none text-gray-400">
                Plant
              </span>
              <span className="text-[11px] font-semibold leading-tight text-gray-700">
                {S.plantName}
              </span>
            </div>
            <span className="text-[10px] text-gray-300">/</span>
            <div className="flex flex-col">
              <span className="text-[8px] font-bold uppercase leading-none text-gray-400">
                Block
              </span>
              <span className="text-[11px] font-semibold leading-tight text-gray-700">
                {S.blockId}
              </span>
            </div>
            <span className="text-[10px] text-gray-300">/</span>
            <div className="flex flex-col">
              <span className="text-[8px] font-bold uppercase leading-none text-gray-400">
                Range
              </span>
              <span className="text-[11px] font-semibold leading-tight text-gray-700">
                {S.rangeLabel}
              </span>
            </div>
          </div>
          <ChevronDown className="ml-auto h-3 w-3 text-gray-400" />
        </div>
      </div>

      {/* Briefing strip */}
      <div className="border-b border-gray-200 bg-blue-50/50 px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-blue-700">
          <span>Briefing · what to look at</span>
          <span className="text-gray-500">09:14</span>
        </div>
        <ul className="space-y-1.5 text-[11px] text-gray-800">
          {[
            `Block 7 RTE down 1.8 pts over last ${S.rteWindowDays} days, well below fleet median.`,
            `1 of ${S.totalRacks} racks is hotter than its neighbors; no alarm has tripped.`,
            `~1.8 MWh/cycle of throughput lost, investigate cooling-loop balance.`,
          ].map((b, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-blue-500" />
              <span className="flex-1">{b}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto py-2">
        <UserBubble text={S.question} />

        <AssistantBubble>
          <div className="mb-2 text-gray-700">
            Checking block-level KPIs first, then decomposing to rack level to
            find the source of the drop.
          </div>

          <ToolStep
            status="done"
            toolName="fetch_block_kpis"
            durationMs={840}
            input={JSON.stringify(
              { block_id: 'block-7', window: '30d', metric: 'rte' },
              null,
              2
            )}
            output={`rte_30d_avg: ${S.rteAfter}%
rte_prior_period: ${S.rteBefore}%
delta_pts: ${(S.rteAfter - S.rteBefore).toFixed(1)}
fleet_median_rte: ${S.fleetMedianRte}%
drift_window_days: ${S.rteWindowDays}`}
          />

          <ToolStep
            status="done"
            toolName="decompose_to_rack"
            durationMs={1_240}
            input={JSON.stringify(
              { block_id: 'block-7', metric: 'rte', window: '30d' },
              null,
              2
            )}
            output={`racks_total: ${S.totalRacks}
rte_range: [${S.rackRangeLow}%, ${S.rackRangeHigh}%]
within_tol: ${S.totalRacks - 1} racks (±${S.rackTolerancePts} pts)
outliers: 1
  └── ${S.offendingRackId}: ${S.offendingRackRtePts.toFixed(1)} pts vs median`}
          />

          <ToolStep
            status="done"
            toolName="fetch_rack_thermals"
            durationMs={2_180}
            input={JSON.stringify(
              { rack_id: S.offendingRackId, window: '30d', signal: 'cell_temp_mean' },
              null,
              2
            )}
            output={`rack_mean_cell_temp_c: ${S.rackMeanTempC}
block_median_cell_temp_c: ${S.blockMedianTempC}
delta_c: +${S.tempDeltaC}
drift_start: ${S.driftStartDate}
alarms_tripped: 0 (threshold ${S.thermalAlarmThresholdC}°C absolute)`}
          />

          <ToolStep
            status="done"
            toolName="quantify_revenue_impact"
            durationMs={4_010}
            input={JSON.stringify(
              {
                rack_id: S.offendingRackId,
                rte_loss_pts: +(S.rteBefore - S.rteAfter).toFixed(1),
                block_size_mwh: S.blockSizeMWh,
                cycles_per_year: S.cyclesPerYear,
              },
              null,
              2
            )}
            output={`energy_lost_per_cycle_mwh: ${S.energyLostPerCycleMWh}
cycles_per_year: ${S.cyclesPerYear}
annual_throughput_lost_mwh: ${(S.energyLostPerCycleMWh * S.cyclesPerYear).toLocaleString()}
revenue_loss_usd_per_year: ~${S.annualRevenueLossUSD.toLocaleString()}`}
          />

          <ConclusionCard />
        </AssistantBubble>
      </div>

      {/* Input field */}
      <div className="border-t border-gray-200 bg-gray-50 px-3 py-2.5">
        <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 shadow-sm">
          <input
            type="text"
            placeholder="Ask about a plant, block, or rack…"
            disabled
            className="flex-1 bg-transparent text-xs text-gray-400 outline-none"
          />
          <button className="rounded-md bg-blue-600 px-2.5 py-0.5 text-[11px] font-medium text-white opacity-70">
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function BessRteScreenshot() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50">
      <Dashboard />
      <CopilotRailMock />
    </div>
  );
}
