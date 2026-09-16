'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { RotateCcw, AlertTriangle, ShieldCheck, Calendar, TrendingUp } from 'lucide-react';
import AnimatedKpiCard from '@/components/ui/AnimatedKpiCard';
import { useScenarioState } from '@/hooks/useScenarioState';
import {
  runSandbox,
  SANDBOX_DEFAULTS,
  type SandboxParams,
} from '@/lib/bess/sandboxModel';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface SliderConfig {
  key: keyof SandboxParams;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  help: string;
}

const SLIDERS: SliderConfig[] = [
  { key: 'soc_min_pct', label: 'Min SoC', unit: '%', min: 5, max: 30, step: 1, help: 'Lower charge limit. Higher is gentler on cells.' },
  { key: 'soc_max_pct', label: 'Max SoC', unit: '%', min: 80, max: 100, step: 1, help: 'Upper charge limit. Lower extends calendar life.' },
  { key: 'max_daily_cycles', label: 'Daily cycles cap', unit: '×/day', min: 0.5, max: 3, step: 0.1, help: 'How hard the BESS is dispatched per day.' },
  { key: 'temp_ceiling_c', label: 'Cell temp ceiling', unit: '°C', min: 25, max: 45, step: 1, help: 'HVAC setpoint cap. Lower = more cooling cost.' },
  { key: 'dod_target_pct', label: 'DoD target', unit: '%', min: 40, max: 100, step: 5, help: 'Depth-of-discharge per cycle. Shallow cycles are gentler.' },
  { key: 'aggressiveness', label: 'Aggressiveness', unit: '', min: 0, max: 100, step: 5, help: '0 = life-max, 100 = revenue-max.' },
];

const LEVEL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  LOW: { bg: 'bg-signal-positive/10', text: 'text-signal-positive', border: 'border-signal-positive/20' },
  MODERATE: { bg: 'bg-signal-warning/10', text: 'text-signal-warning', border: 'border-signal-warning/20' },
  HIGH: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  CRITICAL: { bg: 'bg-signal-critical/10', text: 'text-signal-critical', border: 'border-signal-critical/20' },
};

function formatEuro(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}€${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}€${(abs / 1_000).toFixed(0)}k`;
  return `${sign}€${abs.toFixed(0)}`;
}

export default function WarrantySandbox({ plantSlug, currentSohPct = 94 }: { plantSlug: string; currentSohPct?: number }) {
  const { params, setParam, reset, isDirty } = useScenarioState<SandboxParams>(
    SANDBOX_DEFAULTS,
    `bess.sandbox.${plantSlug}`
  );

  const result = useMemo(() => runSandbox(params, { currentSohPct }), [params, currentSohPct]);

  const sohChart = useMemo(() => {
    const years = result.soh_trajectory.map((p) => `Y${p.year}`);
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v.toFixed(1)}%` },
      legend: { data: ['Scenario', 'Baseline', 'Warranty floor'], top: 0 },
      grid: { left: 50, right: 30, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: 'SoH %', min: 50, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          name: 'Scenario',
          type: 'line',
          data: result.soh_trajectory.map((p) => p.soh_pct),
          smooth: true,
          lineStyle: { color: '#3b82f6', width: 2.5 },
          itemStyle: { color: '#3b82f6' },
          areaStyle: { opacity: 0.18, color: '#3b82f6' },
        },
        {
          name: 'Baseline',
          type: 'line',
          data: result.baseline_trajectory.map((p) => p.soh_pct),
          smooth: true,
          lineStyle: { color: '#94a3b8', width: 1.2, type: 'dashed' },
          itemStyle: { color: '#94a3b8' },
        },
        {
          name: 'Warranty floor',
          type: 'line',
          data: result.soh_trajectory.map(() => 70),
          symbol: 'none',
          lineStyle: { color: '#ef4444', width: 1, type: 'dotted' },
          itemStyle: { color: '#ef4444' },
        },
      ],
    } as any;
  }, [result]);

  const npvChart = useMemo(() => {
    const items = [
      { name: 'Revenue', value: result.npv.revenue_eur, color: '#10b981' },
      { name: 'Degradation', value: -result.npv.degradation_cost_eur, color: '#a855f7' },
      { name: 'HVAC', value: -result.npv.hvac_cost_eur, color: '#3b82f6' },
      { name: 'Warranty risk', value: -result.npv.warranty_risk_premium_eur, color: '#ef4444' },
    ];
    return {
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>${formatEuro(p.value)}` },
      grid: { left: 70, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: items.map((i) => i.name) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => formatEuro(v) } },
      series: [
        {
          type: 'bar',
          data: items.map((i) => ({ value: i.value, itemStyle: { color: i.color } })),
          barWidth: '60%',
          label: { show: true, position: 'top', formatter: (p: any) => formatEuro(p.value) },
        },
      ],
    } as any;
  }, [result]);

  const levelColors = LEVEL_COLORS[result.warranty_risk_level];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold text-ink">Warranty-aware dispatch sandbox</h2>
            <p className="text-sm text-ink-3 mt-0.5">
              Drag the sliders to model 10-year SoH, projected end-of-life, NPV, and warranty risk.
              Persists per plant in this browser.
            </p>
          </div>
          {isDirty && (
            <button
              type="button"
              onClick={reset}
              className="flex items-center gap-1.5 rounded-lg border border-divider bg-white px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-gray-50"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset to baseline
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Sliders */}
        <div className="bg-white rounded-xl border border-divider shadow-sm p-4 space-y-4 lg:col-span-1">
          <h3 className="text-xs font-bold text-ink-3 uppercase tracking-wider">Operating envelope</h3>
          {SLIDERS.map((s) => (
            <div key={s.key}>
              <div className="flex items-baseline justify-between mb-1">
                <label className="text-xs font-semibold text-ink-2">{s.label}</label>
                <span className="text-xs font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                  {params[s.key]} {s.unit}
                </span>
              </div>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={params[s.key]}
                onChange={(e) => setParam(s.key, Number(e.target.value))}
                className="w-full accent-blue-600"
              />
              <div className="text-[10px] text-ink-3 mt-0.5">{s.help}</div>
            </div>
          ))}
        </div>

        {/* Results */}
        <div className="lg:col-span-2 space-y-4">
          {/* KPI band */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className={`rounded-xl border p-4 ${levelColors.bg} ${levelColors.border}`}>
              <div className="text-[10px] uppercase font-bold tracking-wider text-ink-2 flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Projected EOL
              </div>
              <div className={`text-2xl font-black mt-1 ${levelColors.text}`}>
                {result.projected_eol_date}
              </div>
              <div className="text-[10px] text-ink-3 mt-1">
                ≈ {result.projected_eol_years} yrs to 70 % SoH
              </div>
            </div>
            <div className="rounded-xl border border-divider bg-white p-4">
              <div className="text-[10px] uppercase font-bold tracking-wider text-ink-2 flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> 10-yr net NPV
              </div>
              <div className={`text-2xl font-black mt-1 ${result.npv.net_eur < 0 ? 'text-signal-critical' : 'text-signal-positive'}`}>
                {formatEuro(result.npv.net_eur)}
              </div>
              <div className="text-[10px] text-ink-3 mt-1">
                Revenue {formatEuro(result.npv.revenue_eur)} − costs
              </div>
            </div>
            <div className={`rounded-xl border p-4 ${levelColors.bg} ${levelColors.border}`}>
              <div className="text-[10px] uppercase font-bold tracking-wider text-ink-2 flex items-center gap-1">
                {result.warranty_risk_level === 'LOW' ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                Warranty risk
              </div>
              <div className={`text-2xl font-black mt-1 ${levelColors.text}`}>
                {result.warranty_risk_score}
                <span className="text-sm font-semibold ml-1">/ 100</span>
              </div>
              <div className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${levelColors.bg} ${levelColors.text} ${levelColors.border} border`}>
                {result.warranty_risk_level}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
            <h3 className="text-sm font-semibold text-ink mb-2">10-year SoH trajectory</h3>
            <ReactECharts
              option={sohChart}
              style={{ height: 280, width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          </div>

          <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
            <h3 className="text-sm font-semibold text-ink mb-2">10-year NPV breakdown</h3>
            <ReactECharts
              option={npvChart}
              style={{ height: 240, width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          </div>
        </div>
      </div>
    </div>
  );
}
