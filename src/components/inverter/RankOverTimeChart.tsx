'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface RankPoint {
  date: string;
  rank: number;
  total: number;
  percentile: number;
  lossPct: number;
  pds: number;
}

type Tier = 'ACUTE' | 'DEGRADED' | 'CHRONIC' | 'NORMAL';

interface ClassificationInfo {
  tier: Tier;
  reason: string;
}

interface AnomalyEvent {
  date: string;
  ticketId: string;
  title: string;
  severity: string;
  source: string;
}

interface Props {
  plantId: string;
  inverterId: string;
  days?: number;
}

const TIER_BADGE: Record<Tier, string> = {
  ACUTE: 'bg-red-100 text-red-700 border-red-200',
  DEGRADED: 'bg-orange-100 text-orange-700 border-orange-200',
  CHRONIC: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  NORMAL: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

/**
 * Compact "rank over time" chart that doubles as a sanity check on the
 * anomaly detector. Shows two stacked signals:
 *
 *  - **PDS (peer deviation score)**: robust z-score of the inverter's loss%
 *    against its inverter-group peer median + MAD. PDS > 0 = worse than peers,
 *    PDS > 1 conspicuous, PDS > 2 acute. This is the metric the persistence
 *    classifier (ACUTE / DEGRADED / CHRONIC) is built on.
 *
 *  - **Percentile rank** within the plant, kept for the old visual story
 *    ("how far down the bottom of the league table"), rendered on a second
 *    Y axis so the user can read both at once.
 *
 * Anomaly tickets overlay as dashed vertical markers. A confidence KPI then
 * reports what fraction of anomalies fired on days where PDS > 1, since a
 * "real" anomaly should align with the inverter being significantly below
 * peer baseline.
 */
export default function RankOverTimeChart({ plantId, inverterId, days = 90 }: Props) {
  const [series, setSeries] = useState<RankPoint[] | null>(null);
  const [classification, setClassification] = useState<ClassificationInfo | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const [rankRes, anomRes] = await Promise.all([
          fetch(
            `/api/digitaltwin/${plantId}/inverter-rank-history?days=${days}&inverter_id=${encodeURIComponent(
              inverterId,
            )}`,
          ),
          fetch(
            `/api/inverters/${encodeURIComponent(inverterId)}/anomalies?plant_id=${plantId}&days=${days}`,
          ),
        ]);
        if (rankRes.ok) {
          const j = await rankRes.json();
          const inv = j.inverters?.[inverterId];
          if (alive && inv) {
            setSeries(inv.series ?? []);
            setClassification(inv.classification ?? null);
            setGroup(inv.group ?? null);
          }
        }
        if (anomRes.ok) {
          const j = await anomRes.json();
          if (alive) setAnomalies(j.events ?? []);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [plantId, inverterId, days]);

  const options = useMemo(() => {
    if (!series || series.length === 0) return null;
    const dates = series.map((s) => s.date);
    const dateSet = new Set(dates);
    const pdsValues = series.map((s) => Math.round(s.pds * 100) / 100);
    const percentileValues = series.map((s) => s.percentile);
    const dateToRow = new Map(series.map((s) => [s.date, s]));

    const markerData = anomalies
      .filter((a) => dateSet.has(a.date))
      .map((a) => {
        const row = dateToRow.get(a.date);
        const isHighPds = row ? row.pds > 1 : false;
        return {
          name: a.title,
          xAxis: a.date,
          label: { show: false },
          lineStyle: {
            color: isHighPds ? '#ef4444' : '#f59e0b',
            width: 1.5,
            type: 'dashed' as const,
          },
        };
      });

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: any[]) => {
          const p = params?.[0];
          if (!p) return '';
          const row = series[p.dataIndex];
          const fired = anomalies.find((a) => a.date === row.date);
          const base = `<strong>${row.date}</strong><br/>` +
            `PDS: ${row.pds.toFixed(2)}σ (vs peer ${group ?? ''})<br/>` +
            `Rank: ${row.rank} / ${row.total} (P${String(row.percentile).padStart(2, '0')})<br/>` +
            `Loss: ${row.lossPct.toFixed(1)}%`;
          if (fired) {
            return `${base}<br/><br/><strong style="color:#ef4444">Anomaly fired:</strong><br/>${fired.title}<br/><span style="color:#6b7280">${fired.severity} · ${fired.source}</span>`;
          }
          return base;
        },
      },
      legend: {
        data: ['PDS (peer z-score)', 'Plant-wide percentile'],
        top: 0,
        textStyle: { fontSize: 11 },
      },
      grid: { left: 50, right: 50, top: 28, bottom: 40 },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 9, rotate: 45 } },
      yAxis: [
        {
          type: 'value',
          name: 'PDS (σ)',
          position: 'left',
          axisLine: { lineStyle: { color: '#3b82f6' } },
          splitLine: { lineStyle: { color: '#f3f4f6' } },
        },
        {
          type: 'value',
          name: 'Pctl',
          position: 'right',
          min: 0,
          max: 100,
          axisLine: { lineStyle: { color: '#94a3b8' } },
          axisLabel: { formatter: (v: number) => `P${String(v).padStart(2, '0')}`, fontSize: 9 },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'PDS (peer z-score)',
          type: 'line',
          data: pdsValues,
          symbol: 'none',
          yAxisIndex: 0,
          lineStyle: { color: '#3b82f6', width: 1.8 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59, 130, 246, 0.18)' },
                { offset: 1, color: 'rgba(59, 130, 246, 0.01)' },
              ],
            },
          },
          // Shade PDS > 1 (above peer baseline by 1σ) in light rose so the eye
          // can lock onto when the inverter slipped into worse-than-peer
          // territory without reading axis labels.
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(239, 68, 68, 0.06)' },
            data: [[{ yAxis: 1 }, { yAxis: 100 }]],
          },
          markLine: {
            silent: false,
            symbol: ['none', 'pin'],
            symbolSize: [10, 14],
            data: [
              { yAxis: 0, lineStyle: { color: '#94a3b8', type: 'solid', width: 1 }, label: { show: false } }, ...markerData,
            ],
          },
          z: 3,
        },
        {
          name: 'Plant-wide percentile',
          type: 'line',
          data: percentileValues,
          symbol: 'none',
          yAxisIndex: 1,
          lineStyle: { color: '#94a3b8', width: 1, type: 'dotted' as const },
          z: 1,
        },
      ],
    };
  }, [series, anomalies, group]);

  // Confidence KPI: how many anomalies fired when PDS > 1.
  const kpi = useMemo(() => {
    if (!series || anomalies.length === 0) return null;
    const dateToPds = new Map(series.map((s) => [s.date, s.pds]));
    let above = 0;
    let valid = 0;
    for (const a of anomalies) {
      const p = dateToPds.get(a.date);
      if (p == null) continue;
      valid += 1;
      if (p > 1) above += 1;
    }
    if (valid === 0) return null;
    return { above, valid, pct: Math.round((above / valid) * 100) };
  }, [series, anomalies]);

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div className="text-sm text-gray-400">Loading rank trajectory…</div>
      </div>
    );
  }
  if (!options) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
        <div className="text-sm text-gray-500 italic">
          No fleet rank history available for this inverter.
        </div>
      </div>
    );
  }
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
      <div className="flex items-start justify-between mb-1 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">
              Peer deviation over time
            </h3>
            {classification && (
              <span
                className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${TIER_BADGE[classification.tier]}`}
                title={classification.reason}
              >
                {classification.tier}
              </span>
            )}
            {group && (
              <span className="text-[10px] uppercase tracking-wide text-gray-400 font-mono">
                peer = {group}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            PDS = robust z-score of loss% vs same-group peers (1.4826·MAD).
            Above the red band (PDS &gt; 1) = worse than peers.
            {classification?.reason ? ` · ${classification.reason}.` : ''}
          </p>
        </div>
        {kpi && (
          <div
            className={`text-xs px-2 py-1 rounded border ${
              kpi.pct >= 70
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : kpi.pct >= 40
                ? 'bg-amber-50 border-amber-200 text-amber-700'
                : 'bg-rose-50 border-rose-200 text-rose-700'
            }`}
          >
            <strong>{kpi.above} of {kpi.valid}</strong> anomalies ({kpi.pct}%) fired with PDS &gt; 1
            <div className="text-[10px] opacity-80 mt-0.5">
              {kpi.pct >= 70
                ? 'detector aligned with peer deviation'
                : kpi.pct >= 40
                ? 'mixed signal, review individual events'
                : 'detector tripping inside peer baseline'}
            </div>
          </div>
        )}
      </div>
      <ReactECharts option={options} style={{ height: '200px', width: '100%' }} opts={{ renderer: 'canvas' }} />
    </div>
  );
}
