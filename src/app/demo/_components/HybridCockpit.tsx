'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Battery } from 'lucide-react';
import AnimatedKpiCard from '@/components/ui/AnimatedKpiCard';
import SectionSkeleton from '@/components/SectionSkeleton';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

type Range = '24h' | '7d' | '30d';

interface SeriesPoint {
  time: string;
  pv_potential_kw: number;
  pv_actual_kw: number;
  pv_curtailed_kw: number;
  pv_to_bess_kw: number;
  bess_power_kw: number;
  bess_soc: number;
  price_eur_mwh: number;
  site_load_kw: number;
  grid_available: boolean;
  genset_power_kw: number;
  fuel_lph: number;
  fuel_cum_day_l: number;
  bess_to_load_kw: number;
  unserved_kw: number;
}

interface GensetPostmortem {
  start: string;
  end: string;
  duration_min: number;
  load_kwh: number;
  pv_kwh: number;
  bess_kwh: number;
  genset_kwh: number;
  unserved_kwh: number;
  unserved_min: number;
  fuel_l: number;
  fuel_usd: number;
  bigger_battery: {
    factor: number;
    energy_kwh: number;
    fuel_saved_l: number;
    fuel_saved_usd: number;
  };
}

interface GensetBlock {
  config: {
    rating_kw: number;
    min_load_fraction: number;
    diesel_usd_per_l: number;
    site_load_base_kw: number;
    site_load_peak_kw: number;
  };
  runtime_h: number;
  starts: number;
  fuel_l: number;
  fuel_usd: number;
  genset_kwh: number;
  outages: { count: number; total_min: number };
  unserved_min: number;
  economics: {
    fuel_l: number;
    fuel_usd: number;
    avoided_usd: number;
    genset_usd_per_kwh: number | null;
    pv_bess_usd_per_kwh: number;
  };
  daily_fuel: { date: string; litres: number; usd: number }[];
  events: { time: string; type: 'start' | 'stop'; reason: string }[];
  postmortem: GensetPostmortem | null;
}

interface HybridResponse {
  plant: { slug: string; constants: { bess_energy_kwh: number; bess_power_kw: number; pv_nameplate_kw: number } };
  no_pv?: boolean;
  range?: Range;
  window?: { from: string; to: string };
  series?: SeriesPoint[];
  revenue?: {
    pv_baseline_eur: number;
    bess_arbitrage_eur: number;
    curtailment_recovery_eur: number;
    total_eur: number;
    pv_only_eur: number;
    uplift_vs_pv_only_eur: number;
  };
  kpis?: {
    pv_generation_mwh: number;
    bess_throughput_mwh: number;
    curtailment_recovered_mwh: number;
    total_revenue_eur: number;
    uplift_vs_pv_only_eur: number;
  };
  genset?: GensetBlock;
}

function formatEuro(n: number): string {
  if (Math.abs(n) >= 1000) return `€${(n / 1000).toFixed(1)}k`;
  return `€${n.toLocaleString('en-IE')}`;
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function formatLitres(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} L`;
}

function shortDayTime(iso: string): string {
  const d = new Date(iso + 'Z');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${mon} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

function shortTime(iso: string, range: Range): string {
  const d = new Date(iso + 'Z');
  if (range === '24h') {
    return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  }
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (range === '7d') {
    return `${day}/${mon} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
  }
  return `${day}/${mon}`;
}

export default function HybridCockpit({ plantSlug }: { plantSlug: string }) {
  const prefix = usePlantRoutePrefix();
  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<HybridResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/bess/plants/${encodeURIComponent(plantSlug)}/hybrid?range=${range}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((d: HybridResponse) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [plantSlug, range]);

  const chartOption = useMemo(() => {
    if (!data?.series?.length || !data.range) return null;
    const labels = data.series.map((p) => shortTime(p.time, data.range!));
    const pvActual = data.series.map((p) => p.pv_actual_kw);
    const pvPotential = data.series.map((p) => p.pv_potential_kw);
    const bessCharge = data.series.map((p) => (p.bess_power_kw > 0 ? p.bess_power_kw : 0));
    const bessDischarge = data.series.map((p) => (p.bess_power_kw < 0 ? p.bess_power_kw : 0));
    const soc = data.series.map((p) => Math.round(p.bess_soc * 1000) / 10);
    const price = data.series.map((p) => p.price_eur_mwh);

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: {
        data: ['PV actual', 'PV potential', 'BESS charge', 'BESS discharge', 'SoC %', 'Price €/MWh'],
        top: 0,
        type: 'scroll',
      },
      grid: { left: 60, right: 70, top: 50, bottom: 60 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          rotate: data.range === '7d' || data.range === '30d' ? 30 : 0,
          interval: data.range === '30d' ? Math.floor(labels.length / 12) : 'auto',
        },
      },
      yAxis: [
        { type: 'value', name: 'kW', position: 'left', axisLabel: { formatter: (v: number) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : v) } },
        { type: 'value', name: 'SoC %', position: 'right', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
        { type: 'value', name: '€/MWh', position: 'right', offset: 60 },
      ],
      series: [
        {
          name: 'PV actual',
          type: 'line',
          areaStyle: { opacity: 0.25, color: '#3b82f6' },
          lineStyle: { color: '#3b82f6', width: 1.5 },
          itemStyle: { color: '#3b82f6' },
          symbol: 'none',
          data: pvActual,
        },
        {
          name: 'PV potential',
          type: 'line',
          lineStyle: { color: '#f59e0b', type: 'dashed', width: 1.5 },
          itemStyle: { color: '#f59e0b' },
          symbol: 'none',
          data: pvPotential,
        },
        {
          name: 'BESS charge',
          type: 'bar',
          stack: 'bess',
          itemStyle: { color: '#10b981' },
          data: bessCharge,
          barWidth: '60%',
        },
        {
          name: 'BESS discharge',
          type: 'bar',
          stack: 'bess',
          itemStyle: { color: '#a855f7' },
          data: bessDischarge,
          barWidth: '60%',
        },
        {
          name: 'SoC %',
          type: 'line',
          yAxisIndex: 1,
          lineStyle: { color: '#64748b', width: 1.2 },
          itemStyle: { color: '#64748b' },
          symbol: 'none',
          data: soc,
        },
        {
          name: 'Price €/MWh',
          type: 'line',
          yAxisIndex: 2,
          lineStyle: { color: '#ea580c', type: 'dashed', width: 1.2 },
          itemStyle: { color: '#ea580c' },
          symbol: 'none',
          data: price,
        },
      ],
    } as any;
  }, [data]);

  const gensetChartOption = useMemo(() => {
    if (!data?.series?.length || !data.range) return null;
    const labels = data.series.map((p) => shortTime(p.time, data.range!));
    const load = data.series.map((p) => p.site_load_kw ?? 0);
    const genset = data.series.map((p) => p.genset_power_kw ?? 0);
    const fuel = data.series.map((p) => p.fuel_lph ?? 0);

    // Contiguous grid-outage windows as markArea index pairs.
    const outageAreas: { xAxis: number }[][] = [];
    let start: number | null = null;
    data.series.forEach((p, i) => {
      const isOut = p.grid_available === false;
      if (isOut && start === null) start = i;
      if (!isOut && start !== null) {
        outageAreas.push([{ xAxis: start }, { xAxis: i - 1 }]);
        start = null;
      }
    });
    if (start !== null) outageAreas.push([{ xAxis: start }, { xAxis: data.series.length - 1 }]);

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: {
        data: ['Site load', 'Genset power', 'Fuel l/h'],
        top: 0,
        type: 'scroll',
      },
      grid: { left: 60, right: 70, top: 40, bottom: 60 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          rotate: data.range === '7d' || data.range === '30d' ? 30 : 0,
          interval: data.range === '30d' ? Math.floor(labels.length / 12) : 'auto',
        },
      },
      yAxis: [
        { type: 'value', name: 'kW', position: 'left', axisLabel: { formatter: (v: number) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : v) } },
        { type: 'value', name: 'l/h', position: 'right' },
      ],
      series: [
        {
          name: 'Genset power',
          type: 'bar',
          itemStyle: { color: '#dc2626' },
          data: genset,
          barWidth: '60%',
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(220, 38, 38, 0.08)' },
            data: outageAreas,
          },
        },
        {
          name: 'Site load',
          type: 'line',
          lineStyle: { color: '#334155', width: 1.5 },
          itemStyle: { color: '#334155' },
          symbol: 'none',
          data: load,
        },
        {
          name: 'Fuel l/h',
          type: 'line',
          yAxisIndex: 1,
          lineStyle: { color: '#b45309', type: 'dashed', width: 1.2 },
          itemStyle: { color: '#b45309' },
          symbol: 'none',
          data: fuel,
        },
      ],
    } as any;
  }, [data]);

  const revenueBarOption = useMemo(() => {
    if (!data?.revenue) return null;
    const items = [
      { name: 'PV baseline', value: data.revenue.pv_baseline_eur, color: '#3b82f6' },
      { name: 'BESS arbitrage', value: data.revenue.bess_arbitrage_eur, color: '#a855f7' },
      { name: 'Curtailment recovery', value: data.revenue.curtailment_recovery_eur, color: '#10b981' },
    ];
    return {
      tooltip: { trigger: 'item', formatter: (p: any) => `${p.name}<br/>${formatEuro(p.value)}` },
      grid: { left: 50, right: 30, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: items.map((i) => i.name) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => formatEuro(v) } },
      series: [
        {
          type: 'bar',
          data: items.map((i) => ({ value: i.value, itemStyle: { color: i.color } })),
          barWidth: '50%',
          label: { show: true, position: 'top', formatter: (p: any) => formatEuro(p.value) },
        },
      ],
    } as any;
  }, [data]);

  if (loading) return <SectionSkeleton title="Loading hybrid cockpit…" />;
  if (error) return <div className="p-6 text-sm text-signal-critical bg-signal-critical/10 border border-signal-critical/20 rounded-lg">Error: {error}</div>;
  if (!data) return null;

  if (data.no_pv) {
    return (
      <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-xl p-8 text-center">
        <Battery className="h-10 w-10 text-blue-700 mx-auto" />
        <h2 className="mt-3 text-lg font-bold text-blue-900">No co-located PV on this asset</h2>
        <p className="text-sm text-blue-800/80 mt-1 max-w-md mx-auto">
          {plantSlug} is a standalone merchant BESS, there's no on-site solar to pair with the
          battery. The revenue story for this asset is the multi-market ancillary stack instead.
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
      {/* Hero header + range toggle */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold text-ink">Hybrid PV + BESS + Genset Dispatch Cockpit</h2>
            <p className="text-sm text-ink-3 mt-0.5">
              Joint generation, storage, genset dispatch, market price and revenue. {data.window.from.slice(0, 10)} → {data.window.to.slice(0, 10)}.
            </p>
          </div>
          <div className="inline-flex rounded-lg bg-paper-2 p-1 text-xs">
            {(['24h', '7d', '30d'] as Range[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={[
                  'px-3 py-1.5 rounded-md font-semibold transition-colors',
                  r === range ? 'bg-white text-blue-700 shadow-sm' : 'text-ink-2 hover:text-gray-900',
                ].join(' ')}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <AnimatedKpiCard
          title="PV generated"
          value={`${data.kpis.pv_generation_mwh} MWh`}
          subtitle={`${range} window`}
          color="blue"
          index={0}
        />
        <AnimatedKpiCard
          title="BESS throughput"
          value={`${data.kpis.bess_throughput_mwh} MWh`}
          subtitle={`${Math.round((data.kpis.bess_throughput_mwh * 1000) / data.plant.constants.bess_energy_kwh * 10) / 10}× capacity cycled`}
          color="purple"
          index={1}
        />
        <AnimatedKpiCard
          title="Curtailment recovered"
          value={`${data.kpis.curtailment_recovered_mwh} MWh`}
          subtitle="Stored to BESS"
          color="emerald"
          index={2}
        />
        <AnimatedKpiCard
          title="Uplift vs PV-only"
          value={`€${data.kpis.uplift_vs_pv_only_eur.toLocaleString('en-IE')}`}
          subtitle={`Total revenue €${data.kpis.total_revenue_eur.toLocaleString('en-IE')}`}
          color="emerald"
          index={3}
        />
      </div>

      {/* Main combo chart */}
      <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
        <h3 className="text-sm font-semibold text-ink mb-2">PV generation, BESS dispatch, market price</h3>
        {chartOption && (
          <ReactECharts
            option={chartOption}
            style={{ height: 460, width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge
          />
        )}
      </div>

      {/* Genset lane: power + fuel strip aligned with the PV/BESS lanes */}
      {data.genset && (
        <div className="bg-white rounded-xl border border-divider shadow-sm p-4">
          <h3 className="text-sm font-semibold text-ink mb-1">Genset lane: site load, DG power, fuel burn</h3>
          <p className="text-xs text-ink-3 mb-2">
            Shaded bands are grid outage windows. The genset starts only when PV plus the BESS bridge
            cannot carry the site load, and never runs below {Math.round(data.genset.config.min_load_fraction * 100)}%
            of its {data.genset.config.rating_kw.toLocaleString('en-US')} kW rating.
          </p>
          {gensetChartOption && (
            <ReactECharts
              option={gensetChartOption}
              style={{ height: 300, width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          )}
        </div>
      )}

      {/* Genset counters */}
      {data.genset && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <AnimatedKpiCard
            title="DG runtime"
            value={`${data.genset.runtime_h} h`}
            subtitle={`${data.genset.outages.count} outage${data.genset.outages.count === 1 ? '' : 's'}, ${Math.round(data.genset.outages.total_min / 60)} h off grid`}
            color="red"
            index={0}
          />
          <AnimatedKpiCard
            title="DG starts"
            value={data.genset.starts}
            subtitle={`${range} window`}
            color="red"
            index={1}
          />
          <AnimatedKpiCard
            title="Fuel burned"
            value={`${Math.round(data.genset.fuel_l).toLocaleString('en-US')} L`}
            subtitle={`Diesel at $${data.genset.config.diesel_usd_per_l.toFixed(2)}/L`}
            color="amber"
            index={2}
          />
          <AnimatedKpiCard
            title="Fuel cost"
            value={formatUsd(data.genset.fuel_usd)}
            subtitle={`${data.genset.genset_kwh.toLocaleString('en-US')} kWh generated`}
            color="amber"
            index={3}
          />
        </div>
      )}

      {/* Fuel economics + blackout post-mortem */}
      {data.genset && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
            <h3 className="text-sm font-semibold text-ink">Fuel vs solar economics</h3>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Fuel burned this period</span>
                <span className="font-semibold text-ink">
                  {formatLitres(data.genset.economics.fuel_l)} ({formatUsd(data.genset.economics.fuel_usd)})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Avoided by PV + BESS displacing DG runtime</span>
                <span className="font-semibold text-signal-positive">{formatUsd(data.genset.economics.avoided_usd)}</span>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-divider">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Effective cost per kWh</div>
              <div className="mt-2 space-y-2">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-ink-2">Genset energy</span>
                    <span className="font-semibold text-red-600">
                      {data.genset.economics.genset_usd_per_kwh !== null
                        ? `$${data.genset.economics.genset_usd_per_kwh.toFixed(2)}/kWh`
                        : 'No DG runtime in window'}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-paper-2 overflow-hidden">
                    <div className="h-full rounded-full bg-red-500" style={{ width: '100%' }} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-ink-2">PV + BESS energy</span>
                    <span className="font-semibold text-emerald-600">
                      ${data.genset.economics.pv_bess_usd_per_kwh.toFixed(2)}/kWh
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-paper-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{
                        width: `${Math.max(
                          4,
                          Math.min(
                            100,
                            (data.genset.economics.pv_bess_usd_per_kwh /
                              (data.genset.economics.genset_usd_per_kwh || data.genset.economics.pv_bess_usd_per_kwh)) * 100
                          )
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
              {data.genset.economics.genset_usd_per_kwh !== null &&
                data.genset.economics.pv_bess_usd_per_kwh > 0 && (
                  <p className="text-xs text-ink-3 mt-3">
                    Every genset kWh costs{' '}
                    <strong>
                      {(data.genset.economics.genset_usd_per_kwh / data.genset.economics.pv_bess_usd_per_kwh).toFixed(1)}x
                    </strong>{' '}
                    what the same kWh costs from PV + BESS on this site.
                  </p>
                )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-divider shadow-sm p-5">
            <h3 className="text-sm font-semibold text-ink">Blackout post-mortem</h3>
            {data.genset.postmortem ? (
              <div className="mt-3">
                <div className="text-xs text-ink-3">
                  Most recent outage: {shortDayTime(data.genset.postmortem.start)} to{' '}
                  {shortDayTime(data.genset.postmortem.end)} ({data.genset.postmortem.duration_min} min)
                </div>
                {(() => {
                  const pm = data.genset!.postmortem!;
                  const total = Math.max(1, pm.pv_kwh + pm.bess_kwh + pm.genset_kwh + pm.unserved_kwh);
                  const seg = (v: number) => `${Math.max(0, (v / total) * 100)}%`;
                  return (
                    <>
                      <div className="mt-3 h-4 rounded-full overflow-hidden flex bg-paper-2">
                        <div className="h-full bg-blue-500" style={{ width: seg(pm.pv_kwh) }} title="PV direct" />
                        <div className="h-full bg-purple-500" style={{ width: seg(pm.bess_kwh) }} title="BESS bridge" />
                        <div className="h-full bg-red-500" style={{ width: seg(pm.genset_kwh) }} title="Genset takeover" />
                        <div className="h-full bg-gray-400" style={{ width: seg(pm.unserved_kwh) }} title="Unserved" />
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500" />
                          <span className="text-ink-3">PV direct</span>
                          <span className="ml-auto font-semibold text-ink">{pm.pv_kwh.toLocaleString('en-US')} kWh</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-purple-500" />
                          <span className="text-ink-3">BESS bridge</span>
                          <span className="ml-auto font-semibold text-ink">{pm.bess_kwh.toLocaleString('en-US')} kWh</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500" />
                          <span className="text-ink-3">Genset takeover</span>
                          <span className="ml-auto font-semibold text-ink">{pm.genset_kwh.toLocaleString('en-US')} kWh</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-400" />
                          <span className="text-ink-3">Unserved</span>
                          <span className="ml-auto font-semibold text-ink">
                            {pm.unserved_kwh.toLocaleString('en-US')} kWh ({pm.unserved_min} min)
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t border-divider text-xs text-ink-2">
                        Fuel burned in this outage: <strong>{formatLitres(pm.fuel_l)}</strong> ({formatUsd(pm.fuel_usd)}).
                      </div>
                      <div className="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
                        A {pm.bigger_battery.factor}x battery ({(pm.bigger_battery.energy_kwh / 1000).toFixed(1)} MWh) would
                        have saved <strong>{formatLitres(pm.bigger_battery.fuel_saved_l)}</strong> (
                        {formatUsd(pm.bigger_battery.fuel_saved_usd)}) of diesel in this outage.
                      </div>
                    </>
                  );
                })()}
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-3">
                No grid outage in this window. Widen the range to see the most recent blackout post-mortem.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Revenue stack */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-divider shadow-sm p-4">
          <h3 className="text-sm font-semibold text-ink mb-2">Revenue attribution</h3>
          {revenueBarOption && (
            <ReactECharts
              option={revenueBarOption}
              style={{ height: 280, width: '100%' }}
              opts={{ renderer: 'canvas' }}
              notMerge
            />
          )}
        </div>
        <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 rounded-xl border border-signal-positive/20 p-5 flex flex-col justify-center">
          <div className="text-xs uppercase tracking-wider text-signal-positive font-bold">
            + vs PV-only
          </div>
          <div className="text-4xl font-black text-signal-positive mt-1">
            €{data.kpis.uplift_vs_pv_only_eur.toLocaleString('en-IE')}
          </div>
          <div className="text-xs text-emerald-700/80 mt-2">
            Storage adds <strong>{data.revenue.curtailment_recovery_eur > 0 ? formatEuro(data.revenue.curtailment_recovery_eur) : '€0'}</strong> from
            curtailment recovery and <strong>{formatEuro(data.revenue.bess_arbitrage_eur)}</strong> from arbitrage over this window.
          </div>
        </div>
      </div>
    </div>
  );
}
