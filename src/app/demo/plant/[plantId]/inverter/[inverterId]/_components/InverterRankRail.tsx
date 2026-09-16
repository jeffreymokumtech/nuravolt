'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

type Tier = 'ACUTE' | 'DEGRADED' | 'CHRONIC' | 'NORMAL';

interface InverterRow {
  inverterId: string;
  lossPct: number;
  rank: number;
  daysWithData: number;
  group: string;
  tier: Tier;
  tierReason: string;
  /** Latest PDS value (peer-group robust z-score on loss%). */
  latestPds: number;
}

interface RankHistoryPoint {
  date: string;
  percentile: number;
  pds: number;
}

interface Props {
  plantId: string;
  activeInverterId: string;
  /** Cap visible rows; the rail scrolls when there are more. */
  maxVisible?: number;
}

const TIER_PILL: Record<Tier, string> = {
  ACUTE: 'bg-signal-critical/10 text-signal-critical border-signal-critical/20',
  DEGRADED: 'bg-orange-100 text-orange-700 border-orange-200',
  CHRONIC: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  NORMAL: 'bg-signal-positive/10 text-signal-positive border-signal-positive/20',
};

const TIER_DOT: Record<Tier, string> = {
  ACUTE: 'bg-red-500',
  DEGRADED: 'bg-orange-500',
  CHRONIC: 'bg-yellow-500',
  NORMAL: 'bg-emerald-500',
};

const TIER_RANK: Record<Tier, number> = {
  ACUTE: 0,
  DEGRADED: 1,
  CHRONIC: 2,
  NORMAL: 3,
};

/**
 * Pure-SVG sparkline of PDS over time. PDS > 0 = above peer median = worse
 * than peers, so we draw the worse-than-peers region above the midline in
 * a redder hue to match the tier colour.
 */
function Sparkline({ points, tier }: { points: RankHistoryPoint[]; tier: Tier }) {
  if (!points || points.length < 2) {
    return <div className="h-4 w-16 rounded bg-paper-2" />;
  }
  const w = 64;
  const h = 16;
  const vals = points.map((p) => p.pds);
  // Pad bounds so the line never sits on the chart edge.
  const minV = Math.min(...vals, -1);
  const maxV = Math.max(...vals, 1);
  const range = maxV - minV || 1;
  const yFor = (v: number) => ((maxV - v) / range) * (h - 2) + 1;
  const stepX = w / (points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${yFor(p.pds).toFixed(1)}`)
    .join(' ');
  const stroke =
    tier === 'ACUTE'
      ? '#ef4444'
      : tier === 'DEGRADED'
      ? '#f97316'
      : tier === 'CHRONIC'
      ? '#eab308'
      : '#10b981';
  // Reference line at PDS = 0 (peer median).
  const yZero = yFor(0).toFixed(1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden>
      <line x1={0} y1={yZero} x2={w} y2={yZero} stroke="#cbd5e1" strokeWidth={0.5} strokeDasharray="2 2" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

const normaliseTier = (t: unknown): Tier => {
  if (t === 'ACUTE' || t === 'DEGRADED' || t === 'CHRONIC' || t === 'NORMAL') return t;
  return 'NORMAL';
};

export default function InverterRankRail({
  plantId,
  activeInverterId,
  maxVisible = 30,
}: Props) {
  const prefix = usePlantRoutePrefix();
  const [rows, setRows] = useState<InverterRow[] | null>(null);
  const [history, setHistory] = useState<Record<string, RankHistoryPoint[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const [metricsRes, historyRes] = await Promise.all([
          fetch(`/api/digitaltwin/${plantId}/inverter-metrics`),
          fetch(`/api/digitaltwin/${plantId}/inverter-rank-history?days=30`),
        ]);
        if (!metricsRes.ok || !historyRes.ok) return;
        const m = await metricsRes.json();
        const h = await historyRes.json();

        const trimmed: Record<string, RankHistoryPoint[]> = {};
        const tierMap = new Map<
          string,
          { tier: Tier; reason: string; group: string; latestPds: number }
        >();
        for (const [id, info] of Object.entries(h.inverters as Record<string, any>)) {
          const series: RankHistoryPoint[] = (info.series || []).map((s: any) => ({
            date: s.date,
            percentile: s.percentile,
            pds: s.pds,
          }));
          trimmed[id] = series.slice(-14);
          const latestPds = series.length > 0 ? series[series.length - 1].pds : 0;
          tierMap.set(id, {
            tier: normaliseTier(info?.classification?.tier),
            reason: info?.classification?.reason ?? '',
            group: info?.group ?? 'unknown',
            latestPds,
          });
        }

        const list: InverterRow[] = (m.inverters || []).map((inv: any) => {
          const meta = tierMap.get(inv.inverterId);
          return {
            inverterId: inv.inverterId,
            lossPct: inv.lossPct ?? 0,
            rank: inv.rank ?? 0,
            daysWithData: inv.daysWithData ?? 0,
            group: meta?.group ?? 'unknown',
            tier: meta?.tier ?? 'NORMAL',
            tierReason: meta?.reason ?? '',
            latestPds: meta?.latestPds ?? 0,
          };
        });

        // Sort: worst tier first, then highest loss within tier.
        list.sort((a, b) => {
          if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) {
            return TIER_RANK[a.tier] - TIER_RANK[b.tier];
          }
          return b.lossPct - a.lossPct;
        });

        if (!alive) return;
        setRows(list);
        setHistory(trimmed);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [plantId]);

  const visible = useMemo(() => (rows ? rows.slice(0, maxVisible) : []), [rows, maxVisible]);

  // Counts per tier for the header summary.
  const tierCounts = useMemo(() => {
    const c: Record<Tier, number> = { ACUTE: 0, DEGRADED: 0, CHRONIC: 0, NORMAL: 0 };
    rows?.forEach((r) => {
      c[r.tier] += 1;
    });
    return c;
  }, [rows]);

  if (loading) {
    return (
      <aside className="w-60 shrink-0 hidden lg:block">
        <div className="sticky top-4 bg-white border border-divider rounded-xl p-3 text-xs text-ink-3">
          Loading fleet ranking…
        </div>
      </aside>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <aside className="w-60 shrink-0 hidden lg:block">
        <div className="sticky top-4 bg-white border border-divider rounded-xl p-3 text-xs text-ink-3">
          No fleet data available.
        </div>
      </aside>
    );
  }
  if (rows.length === 1) {
    return (
      <aside className="w-60 shrink-0 hidden lg:block">
        <div className="sticky top-4 bg-white border border-divider rounded-xl p-3 text-xs text-ink-3 italic">
          Single inverter, no fleet to compare against.
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-60 shrink-0 hidden lg:block">
      <div className="sticky top-4 bg-white border border-divider rounded-xl shadow-sm overflow-hidden">
        <div className="px-3 py-2 border-b border-divider">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
            Peer-group ranking
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-3">
            {(['ACUTE', 'DEGRADED', 'CHRONIC', 'NORMAL'] as Tier[]).map((t) =>
              tierCounts[t] > 0 ? (
                <span key={t} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${TIER_PILL[t]}`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${TIER_DOT[t]}`} />
                  {tierCounts[t]}
                </span>
              ) : null,
            )}
          </div>
        </div>
        <div className="px-3 py-1 text-[10px] text-ink-3 border-b border-divider">
          Sparkline = 14d PDS (peer-group robust z-score). Dashed = peer median.
        </div>
        <ul className="max-h-[78vh] overflow-y-auto divide-y divide-gray-50">
          {visible.map((row) => {
            const isActive = row.inverterId === activeInverterId;
            const points = history[row.inverterId] || [];
            const lossSign = row.lossPct >= 0 ? '-' : '+';
            return (
              <li key={row.inverterId} className={isActive ? 'bg-blue-50/60' : ''}>
                <Link
                  href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(row.inverterId)}`}
                  className={`block px-3 py-2 hover:bg-gray-50 transition-colors ${
                    isActive ? 'border-l-2 border-blue-500' : 'border-l-2 border-transparent'
                  }`}
                  title={row.tierReason}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-[12px] text-ink truncate">
                      {row.inverterId}
                    </div>
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full ${TIER_DOT[row.tier]}`}
                      aria-hidden
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-semibold text-ink-2 tabular-nums">
                        {row.latestPds >= 0 ? '+' : ''}
                        {row.latestPds.toFixed(1)}σ
                      </span>
                      <Sparkline points={points} tier={row.tier} />
                    </div>
                    <div className="text-[11px] font-mono text-ink-2">
                      {lossSign}
                      {Math.abs(row.lossPct).toFixed(1)}%
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <span
                      className={`inline-block text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${TIER_PILL[row.tier]}`}
                    >
                      {row.tier}
                    </span>
                    <span className="text-[9px] uppercase tracking-wide text-ink-3 font-mono">
                      {row.group}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        {rows.length > maxVisible && (
          <div className="px-3 py-1.5 text-[10px] text-ink-3 border-t border-divider">
            Showing top {maxVisible} of {rows.length}, scroll for more.
          </div>
        )}
      </div>
    </aside>
  );
}
