'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { X, ArrowUpRight, ShieldAlert } from 'lucide-react';
import AnimatedKpiCard from '@/components/ui/AnimatedKpiCard';
import SectionSkeleton from '@/components/SectionSkeleton';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

type Mode = 'soh_delta' | 'rte' | 'violations';

interface AssetSeries {
  plant: string;
  asset_name: string;
  days: string[];
  soh_pct: number[];
  soh_delta_pct: Array<number | null>;
  rte_pct: Array<number | null>;
  violations: number[];
  current_soh: number;
  violation_total: number;
  trend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
}

interface ApiResponse {
  days: number;
  window: { from: string; to: string };
  assets: AssetSeries[];
  kpis: {
    available_energy_gwh: number;
    fleet_avg_soh_pct: number;
    fleet_violations: number;
    fleet_health_score: number;
  };
}

interface CellSelection {
  plant: string;
  asset_name: string;
  day: string;
  soh_pct: number;
  soh_delta_pct: number | null;
  rte_pct: number | null;
  violations: number;
}

const MODES: Array<{ key: Mode; label: string; description: string }> = [
  { key: 'soh_delta', label: 'SoH Δ / day', description: 'Day-over-day SoH change (pp)' },
  { key: 'rte', label: 'Round-trip efficiency', description: 'Daily RTE %' },
  { key: 'violations', label: 'Violations', description: 'Count of warranty events starting that day' },
];

export default function BessFleetHeatmap() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('soh_delta');
  const [selected, setSelected] = useState<CellSelection | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/bess/fleet/health?days=90')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((d: ApiResponse) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const chartOption = useMemo(() => {
    if (!data?.assets.length) return null;
    const days = data.assets[0].days;
    const cells: Array<[number, number, number | null]> = [];
    for (let r = 0; r < data.assets.length; r++) {
      const series =
        mode === 'soh_delta'
          ? data.assets[r].soh_delta_pct
          : mode === 'rte'
          ? data.assets[r].rte_pct
          : data.assets[r].violations.map((v) => v || null);
      for (let c = 0; c < days.length; c++) {
        cells.push([c, r, series[c] ?? null]);
      }
    }

    const visualMap =
      mode === 'soh_delta'
        ? { min: -0.05, max: 0.05, inRange: { color: ['#dc2626', '#f59e0b', '#fafafa', '#86efac', '#10b981'] } }
        : mode === 'rte'
        ? { min: 80, max: 92, inRange: { color: ['#dc2626', '#f59e0b', '#fbbf24', '#86efac', '#10b981'] } }
        : { min: 0, max: 3, inRange: { color: ['#fafafa', '#fde68a', '#fb923c', '#dc2626'] } };

    return {
      tooltip: {
        formatter: (p: any) => {
          const [x, y, val] = p.value;
          const asset = data.assets[y];
          const day = data.assets[0].days[x];
          if (val === null || val === undefined) return `${asset.asset_name}<br/>${day}<br/>,`;
          const unit = mode === 'soh_delta' ? ' pp' : mode === 'rte' ? '%' : '';
          return `<strong>${asset.asset_name}</strong><br/>${day}<br/>${typeof val === 'number' ? val.toFixed(mode === 'violations' ? 0 : 2) : val}${unit}`;
        },
      },
      grid: { left: 130, right: 30, top: 20, bottom: 50 },
      xAxis: {
        type: 'category',
        data: days,
        splitArea: { show: false },
        axisLabel: {
          interval: Math.floor(days.length / 12),
          rotate: 35,
          fontSize: 9,
        },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'category',
        data: data.assets.map((a) => a.asset_name),
        splitArea: { show: false },
        axisLabel: { fontSize: 11, fontWeight: 600 },
      },
      visualMap: {
        ...visualMap,
        show: true,
        bottom: 8,
        orient: 'horizontal',
        itemWidth: 12,
        itemHeight: 90,
        textStyle: { fontSize: 10 },
        calculable: true,
      },
      series: [
        {
          type: 'heatmap',
          data: cells,
          itemStyle: {
            borderColor: '#fff',
            borderWidth: 0.5,
          },
          emphasis: {
            itemStyle: {
              borderColor: '#1f2937',
              borderWidth: 1.5,
            },
          },
        },
      ],
    } as any;
  }, [data, mode]);

  const onChartClick = (params: any) => {
    if (!data || !params?.value) return;
    const [x, y] = params.value;
    const asset = data.assets[y];
    const day = data.assets[0].days[x];
    setSelected({
      plant: asset.plant,
      asset_name: asset.asset_name,
      day,
      soh_pct: asset.soh_pct[x],
      soh_delta_pct: asset.soh_delta_pct[x] ?? null,
      rte_pct: asset.rte_pct[x] ?? null,
      violations: asset.violations[x],
    });
  };

  if (loading) return <SectionSkeleton title="Loading fleet health…" />;
  if (error) return <div className="p-6 text-sm text-signal-critical bg-signal-critical/10 border border-signal-critical/20 rounded-lg">Error: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
        <h2 className="text-xl font-bold text-ink">Fleet BESS health heatmap</h2>
        <p className="text-sm text-ink-3 mt-0.5">
          Per-asset health over the last {data.days} days. {data.window.from} → {data.window.to}.
          Click any cell to drill into that day.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <AnimatedKpiCard
          title="Available energy"
          value={`${data.kpis.available_energy_gwh.toFixed(3)} GWh`}
          subtitle={`${data.assets.length} BESS assets`}
          color="blue"
          index={0}
        />
        <AnimatedKpiCard
          title="Fleet avg SoH"
          value={`${data.kpis.fleet_avg_soh_pct}%`}
          subtitle="Weighted by equal capacity"
          color="emerald"
          index={1}
        />
        <AnimatedKpiCard
          title="Active violations"
          value={`${data.kpis.fleet_violations}`}
          subtitle="Last 90 days, fleet-wide"
          color={data.kpis.fleet_violations > 0 ? 'amber' : 'green'}
          index={2}
        />
        <AnimatedKpiCard
          title="Fleet health score"
          value={`${data.kpis.fleet_health_score} / 100`}
          subtitle={
            data.kpis.fleet_health_score >= 85 ? 'Healthy' :
            data.kpis.fleet_health_score >= 70 ? 'Watch' :
            data.kpis.fleet_health_score >= 50 ? 'At risk' : 'Critical'
          }
          color={
            data.kpis.fleet_health_score >= 85 ? 'emerald' :
            data.kpis.fleet_health_score >= 70 ? 'amber' : 'red'
          }
          index={3}
        />
      </div>

      {/* Mode toggle + heatmap */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
        <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-ink">{MODES.find((m) => m.key === mode)!.label}</h3>
            <p className="text-[11px] text-ink-3">{MODES.find((m) => m.key === mode)!.description}</p>
          </div>
          <div className="inline-flex rounded-lg bg-paper-2 p-1 text-xs">
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className={[
                  'px-3 py-1.5 rounded-md font-semibold transition-colors',
                  m.key === mode ? 'bg-white text-blue-700 shadow-sm' : 'text-ink-2 hover:text-gray-900',
                ].join(' ')}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {chartOption && (
          <ReactECharts
            option={chartOption}
            style={{ height: 280, width: '100%' }}
            opts={{ renderer: 'canvas' }}
            onEvents={{ click: onChartClick }}
            notMerge
          />
        )}
      </div>

      {/* Asset list */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
        <h3 className="text-sm font-semibold text-ink mb-2">Assets ranked by current SoH</h3>
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase text-ink-3 border-b border-divider">
            <tr>
              <th className="text-left py-1.5 pr-2">Asset</th>
              <th className="text-right py-1.5 pr-2">SoH</th>
              <th className="text-right py-1.5 pr-2">Trend</th>
              <th className="text-right py-1.5 pr-2">Violations</th>
              <th className="text-right py-1.5">Quick links</th>
            </tr>
          </thead>
          <tbody>
            {data.assets.map((a) => (
              <tr key={a.plant} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="py-2 pr-2 font-semibold text-ink">{a.asset_name}</td>
                <td className="text-right pr-2 font-mono">{a.current_soh.toFixed(2)}%</td>
                <td className="text-right pr-2">
                  <span className={[
                    'inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase',
                    a.trend === 'DEGRADING' ? 'bg-signal-critical/10 text-signal-critical' :
                    a.trend === 'IMPROVING' ? 'bg-signal-positive/10 text-signal-positive' :
                    'bg-paper-2 text-ink-2',
                  ].join(' ')}>{a.trend}</span>
                </td>
                <td className="text-right pr-2">
                  {a.violation_total > 0 ? (
                    <span className="inline-flex items-center gap-1 text-signal-warning font-bold">
                      <ShieldAlert className="h-3 w-3" />{a.violation_total}
                    </span>
                  ) : (
                    <span className="text-ink-3">,</span>
                  )}
                </td>
                <td className="text-right space-x-2">
                  <Link
                    href={`/demo/plant/${a.plant}/hybrid`}
                    className="inline-flex items-center gap-0.5 text-[10px] text-blue-700 hover:underline"
                  >
                    Cockpit <ArrowUpRight className="h-2.5 w-2.5" />
                  </Link>
                  <Link
                    href={`/demo/plant/${a.plant}/sandbox`}
                    className="inline-flex items-center gap-0.5 text-[10px] text-blue-700 hover:underline"
                  >
                    Sandbox <ArrowUpRight className="h-2.5 w-2.5" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Drilldown drawer */}
      {selected && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-base font-bold text-ink">{selected.asset_name}</h3>
                <p className="text-xs text-ink-3 mt-0.5">{selected.day}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="p-1.5 text-ink-3 hover:bg-gray-100 rounded-md"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-paper rounded-lg p-2">
                <div className="text-[10px] uppercase text-ink-3 font-bold">SoH</div>
                <div className="text-base font-bold text-ink">{selected.soh_pct.toFixed(2)}%</div>
              </div>
              <div className="bg-paper rounded-lg p-2">
                <div className="text-[10px] uppercase text-ink-3 font-bold">SoH Δ vs prev day</div>
                <div className={`text-base font-bold ${selected.soh_delta_pct && selected.soh_delta_pct < 0 ? 'text-signal-critical' : 'text-signal-positive'}`}>
                  {selected.soh_delta_pct === null ? ',' : `${selected.soh_delta_pct >= 0 ? '+' : ''}${selected.soh_delta_pct.toFixed(2)} pp`}
                </div>
              </div>
              <div className="bg-paper rounded-lg p-2">
                <div className="text-[10px] uppercase text-ink-3 font-bold">RTE</div>
                <div className="text-base font-bold text-ink">
                  {selected.rte_pct === null ? ',' : `${selected.rte_pct.toFixed(1)}%`}
                </div>
              </div>
              <div className="bg-paper rounded-lg p-2">
                <div className="text-[10px] uppercase text-ink-3 font-bold">Violations</div>
                <div className={`text-base font-bold ${selected.violations > 0 ? 'text-signal-warning' : 'text-ink-3'}`}>
                  {selected.violations}
                </div>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Link
                href={`/demo/plant/${selected.plant}/hybrid`}
                className="flex-1 text-center rounded-lg bg-blue-600 text-white text-xs font-semibold py-2 hover:bg-blue-700"
              >
                Open cockpit
              </Link>
              <Link
                href={`/demo/plant/${selected.plant}/sandbox`}
                className="flex-1 text-center rounded-lg bg-gray-900 text-white text-xs font-semibold py-2 hover:bg-gray-800"
              >
                Open sandbox
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
