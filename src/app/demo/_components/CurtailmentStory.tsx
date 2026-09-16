'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { X, Zap, Battery } from 'lucide-react';
import AnimatedKpiCard from '@/components/ui/AnimatedKpiCard';
import SectionSkeleton from '@/components/SectionSkeleton';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface SeriesPoint {
  time: string;
  pv_potential_kw: number;
  pv_actual_kw: number;
  pv_curtailed_kw: number;
  pv_to_bess_kw: number;
  bess_power_kw: number;
  bess_soc: number;
  price_eur_mwh: number;
}

interface CurtailmentEvent {
  start: string;
  end: string;
  duration_hours: number;
  clipped_mwh: number;
  recovered_mwh: number;
  recovered_eur: number;
  bess_soc_delta_pct: number;
  peak_clipped_kw: number;
}

interface ApiResponse {
  plant: { slug: string };
  no_pv?: boolean;
  window?: { from: string; to: string; days: number };
  summary?: {
    total_clipped_mwh: number;
    total_recovered_mwh: number;
    total_recovered_eur: number;
    recovery_rate_pct: number;
  };
  events?: CurtailmentEvent[];
  worst_inverters?: Array<{ id: string; clipped_mwh: number }>;
  series?: SeriesPoint[];
}

function fmtDay(iso: string): string {
  const d = new Date(iso + 'Z');
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fmtHour(iso: string): string {
  const d = new Date(iso + 'Z');
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

export default function CurtailmentStory({ plantSlug }: { plantSlug: string }) {
  const prefix = usePlantRoutePrefix();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CurtailmentEvent | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/bess/plants/${encodeURIComponent(plantSlug)}/curtailment?days=30`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((d: ApiResponse) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [plantSlug]);

  // Aggregate hourly series → daily stacked view for the hero chart.
  const dailyChart = useMemo(() => {
    if (!data?.series?.length) return null;
    const byDay = new Map<string, { potential: number; exported: number; curtailed: number; recovered: number }>();
    for (const p of data.series) {
      const day = p.time.slice(0, 10);
      const entry = byDay.get(day) ?? { potential: 0, exported: 0, curtailed: 0, recovered: 0 };
      entry.potential += p.pv_potential_kw / 1000; // MWh
      entry.exported += p.pv_actual_kw / 1000;
      entry.curtailed += (p.pv_curtailed_kw - p.pv_to_bess_kw) / 1000;
      entry.recovered += p.pv_to_bess_kw / 1000;
      byDay.set(day, entry);
    }
    const days = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b));
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['Exported to grid', 'Recovered to BESS', 'Lost to curtailment'], top: 0 },
      grid: { left: 60, right: 30, top: 40, bottom: 40 },
      xAxis: {
        type: 'category',
        data: days.map(([d]) => fmtDay(d)),
        axisLabel: { interval: Math.floor(days.length / 12) },
      },
      yAxis: {
        type: 'value',
        name: 'MWh / day',
        axisLabel: { formatter: (v: number) => v.toFixed(0) },
      },
      series: [
        {
          name: 'Exported to grid',
          type: 'bar',
          stack: 'pv',
          itemStyle: { color: '#3b82f6' },
          data: days.map(([, e]) => Math.round(e.exported * 10) / 10),
        },
        {
          name: 'Recovered to BESS',
          type: 'bar',
          stack: 'pv',
          itemStyle: { color: '#10b981' },
          data: days.map(([, e]) => Math.round(e.recovered * 100) / 100),
        },
        {
          name: 'Lost to curtailment',
          type: 'bar',
          stack: 'pv',
          itemStyle: { color: '#ef4444' },
          data: days.map(([, e]) => Math.round(e.curtailed * 100) / 100),
        },
      ],
    } as any;
  }, [data]);

  const worstInvertersChart = useMemo(() => {
    if (!data?.worst_inverters?.length) return null;
    return {
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>${p.value.toFixed(2)} MWh clipped` },
      grid: { left: 110, right: 10, top: 10, bottom: 10 },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => v.toFixed(1) } },
      yAxis: { type: 'category', data: data.worst_inverters.map((i) => i.id).reverse() },
      series: [
        {
          type: 'bar',
          data: data.worst_inverters.map((i) => i.clipped_mwh).reverse(),
          itemStyle: { color: '#ef4444' },
          barWidth: '60%',
        },
      ],
    } as any;
  }, [data]);

  const eventDrawerChart = useMemo(() => {
    if (!selectedEvent || !data) return null;
    const startT = new Date(selectedEvent.start + 'Z').getTime();
    const endT = new Date(selectedEvent.end + 'Z').getTime();
    const padMs = 3 * 3600 * 1000;
    const window = (data.series ?? []).filter((p) => {
      const t = new Date(p.time + 'Z').getTime();
      return t >= startT - padMs && t <= endT + padMs;
    });
    if (!window.length) return null;
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['PV potential', 'PV exported', 'BESS power', 'Price'], top: 0 },
      grid: { left: 60, right: 70, top: 40, bottom: 40 },
      xAxis: {
        type: 'category',
        data: window.map((p) => p.time.slice(11, 16)),
        axisLabel: { rotate: 30 },
      },
      yAxis: [
        { type: 'value', name: 'kW' },
        { type: 'value', name: '€/MWh', position: 'right' },
      ],
      series: [
        {
          name: 'PV potential',
          type: 'line',
          lineStyle: { color: '#f59e0b', type: 'dashed' },
          itemStyle: { color: '#f59e0b' },
          symbol: 'none',
          data: window.map((p) => p.pv_potential_kw),
        },
        {
          name: 'PV exported',
          type: 'line',
          areaStyle: { opacity: 0.3, color: '#3b82f6' },
          lineStyle: { color: '#3b82f6' },
          itemStyle: { color: '#3b82f6' },
          symbol: 'none',
          data: window.map((p) => p.pv_actual_kw),
        },
        {
          name: 'BESS power',
          type: 'bar',
          itemStyle: { color: '#10b981' },
          data: window.map((p) => p.bess_power_kw),
          barWidth: '50%',
        },
        {
          name: 'Price',
          type: 'line',
          yAxisIndex: 1,
          lineStyle: { color: '#ea580c', type: 'dashed' },
          itemStyle: { color: '#ea580c' },
          symbol: 'none',
          data: window.map((p) => p.price_eur_mwh),
        },
      ],
    } as any;
  }, [selectedEvent, data]);

  if (loading) return <SectionSkeleton title="Loading curtailment story…" />;
  if (error) return <div className="p-6 text-sm text-signal-critical bg-signal-critical/10 border border-signal-critical/20 rounded-lg">Error: {error}</div>;
  if (!data) return null;

  if (data.no_pv) {
    return (
      <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl p-8 text-center">
        <Battery className="h-10 w-10 text-blue-700 mx-auto" />
        <h2 className="mt-3 text-lg font-bold text-blue-900">No PV to curtail</h2>
        <p className="text-sm text-blue-800/80 mt-1 max-w-md mx-auto">
          {plantSlug} is a standalone merchant BESS, there is no on-site solar, so there is
          nothing to clip. The asset's revenue story lives in the ancillary stack instead.
        </p>
        <Link
          href={`${prefix}/plant/${encodeURIComponent(plantSlug)}/revenue`}
          className="inline-block mt-4 rounded-lg bg-blue-600 text-white text-sm font-semibold px-4 py-2 hover:bg-blue-700"
        >
          Open the Revenue Cockpit →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero header */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
        <h2 className="text-xl font-bold text-ink">Curtailment recovery</h2>
        <p className="text-sm text-ink-3 mt-0.5">
          PV that would have been clipped by the inverter / grid limit, and how much the BESS absorbed
          instead. Window: last {data.window.days} days.
        </p>
      </div>

      {/* Hero number band */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <AnimatedKpiCard
          title="Energy recovered"
          value={`${data.summary.total_recovered_mwh} MWh`}
          subtitle={`of ${data.summary.total_clipped_mwh} MWh clipped`}
          color="emerald"
          index={0}
        />
        <AnimatedKpiCard
          title="€ recovered"
          value={`€${data.summary.total_recovered_eur.toLocaleString('en-IE')}`}
          subtitle="At realised hourly spot prices"
          color="emerald"
          index={1}
        />
        <AnimatedKpiCard
          title="Recovery rate"
          value={`${data.summary.recovery_rate_pct}%`}
          subtitle="BESS coverage of clip volume"
          color="blue"
          index={2}
        />
        <AnimatedKpiCard
          title="Curtailment events"
          value={`${data.events.length}`}
          subtitle="Contiguous clip windows"
          color="amber"
          index={3}
        />
      </div>

      {/* Power-to-hydrogen opportunity: what the UNRECOVERED clip would be
          worth fed to an electrolyzer instead of thrown away. Constants match
          the hydrogen module (nuravolt/hydrogen/electrolyzer.py: ~52.5 kWh/kg
          system SEC; hydrogen_synth.py: €5.5/kg merchant green H2). */}
      {(() => {
        const unrecoveredMwh = Math.max(
          0,
          data.summary.total_clipped_mwh - data.summary.total_recovered_mwh
        );
        if (unrecoveredMwh < 0.5) return null;
        const SEC_KWH_PER_KG = 52.5;
        const H2_PRICE_EUR_PER_KG = 5.5;
        const kg = (unrecoveredMwh * 1000) / SEC_KWH_PER_KG;
        const eur = kg * H2_PRICE_EUR_PER_KG;
        return (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  Power-to-hydrogen opportunity
                </p>
                <p className="mt-0.5 text-xs text-emerald-800">
                  The {unrecoveredMwh.toFixed(1)} MWh still being thrown away would make{' '}
                  <span className="font-semibold">{Math.round(kg).toLocaleString()} kg of H2</span>{' '}
                  (~€{Math.round(eur).toLocaleString()} at €{H2_PRICE_EUR_PER_KG}/kg merchant
                  green hydrogen) through a PEM electrolyzer at ~{SEC_KWH_PER_KG} kWh/kg.
                </p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-emerald-700/70">
                  Illustrative · fixed SEC + merchant-price assumptions, not a sited quote
                </p>
              </div>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-lg font-bold text-emerald-800">
                ~€{Math.round(eur).toLocaleString()}
              </span>
            </div>
          </div>
        );
      })()}

      {/* Daily stacked story chart */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
        <h3 className="text-sm font-semibold text-ink mb-2">PV daily energy: exported / recovered / lost</h3>
        {dailyChart && (
          <ReactECharts
            option={dailyChart}
            style={{ height: 340, width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge
          />
        )}
      </div>

      {/* Events table + worst inverters */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-divider shadow-sm p-4 overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-ink">Top curtailment events</h3>
            <span className="text-[10px] text-ink-3 uppercase tracking-wider">Click a row for the 6h replay</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-ink-3 border-b border-divider">
                <tr>
                  <th className="text-left py-1.5 pr-2">When</th>
                  <th className="text-right py-1.5 pr-2">Hours</th>
                  <th className="text-right py-1.5 pr-2">Clipped MWh</th>
                  <th className="text-right py-1.5 pr-2">Recovered MWh</th>
                  <th className="text-right py-1.5 pr-2">€ Recovered</th>
                  <th className="text-right py-1.5 pr-2">Peak clip kW</th>
                  <th className="text-right py-1.5">SoC Δ</th>
                </tr>
              </thead>
              <tbody>
                {data.events.slice(0, 12).map((ev) => (
                  <tr
                    key={ev.start}
                    onClick={() => setSelectedEvent(ev)}
                    className="border-b border-gray-50 hover:bg-blue-50 cursor-pointer transition-colors"
                  >
                    <td className="py-1.5 pr-2 font-mono text-ink">{fmtHour(ev.start)}</td>
                    <td className="text-right pr-2 text-ink-2">{ev.duration_hours}</td>
                    <td className="text-right pr-2 text-signal-critical font-semibold">{ev.clipped_mwh.toFixed(2)}</td>
                    <td className="text-right pr-2 text-signal-positive font-semibold">{ev.recovered_mwh.toFixed(2)}</td>
                    <td className="text-right pr-2 text-signal-positive">€{ev.recovered_eur.toLocaleString('en-IE')}</td>
                    <td className="text-right pr-2 text-ink-2">{ev.peak_clipped_kw.toLocaleString('en-IE')}</td>
                    <td className="text-right text-ink-2">{ev.bess_soc_delta_pct >= 0 ? '+' : ''}{ev.bess_soc_delta_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.events.length && (
              <div className="py-8 text-center text-xs text-ink-3">
                No curtailment in this window, try a longer range or a higher-irradiance plant.
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
          <h3 className="text-sm font-semibold text-ink mb-1 flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-red-500" /> Worst clipped inverters
          </h3>
          <p className="text-[10px] text-ink-3 mb-2">Plant-level curtailment distributed by string position.</p>
          {worstInvertersChart && (
            <ReactECharts
              option={worstInvertersChart}
              style={{ height: 360, width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          )}
        </div>
      </div>

      {/* Event replay drawer */}
      {selectedEvent && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setSelectedEvent(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-3xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-base font-bold text-ink">Curtailment event replay</h3>
                <p className="text-xs text-ink-3 mt-0.5">
                  {fmtHour(selectedEvent.start)} → {fmtHour(selectedEvent.end)} · {selectedEvent.duration_hours}h
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                className="p-1.5 text-ink-3 hover:bg-gray-100 rounded-md"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
              <div className="bg-signal-critical/10 border border-signal-critical/20 rounded-lg p-2">
                <div className="text-[10px] uppercase text-signal-critical font-bold">Clipped</div>
                <div className="text-lg font-bold text-signal-critical">{selectedEvent.clipped_mwh.toFixed(2)} MWh</div>
              </div>
              <div className="bg-signal-positive/10 border border-signal-positive/20 rounded-lg p-2">
                <div className="text-[10px] uppercase text-signal-positive font-bold">Recovered</div>
                <div className="text-lg font-bold text-signal-positive">{selectedEvent.recovered_mwh.toFixed(2)} MWh · €{selectedEvent.recovered_eur.toLocaleString('en-IE')}</div>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-2">
                <div className="text-[10px] uppercase text-blue-700 font-bold">SoC change</div>
                <div className="text-lg font-bold text-blue-700">{selectedEvent.bess_soc_delta_pct >= 0 ? '+' : ''}{selectedEvent.bess_soc_delta_pct}%</div>
              </div>
            </div>
            {eventDrawerChart && (
              <ReactECharts
                option={eventDrawerChart}
                style={{ height: 320, width: '100%' }}
                opts={{ renderer: 'canvas' }}
                notMerge
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
