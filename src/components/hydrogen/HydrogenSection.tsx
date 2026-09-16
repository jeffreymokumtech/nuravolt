/**
 * HydrogenSection - electrolyzer console (green hydrogen).
 *
 * Overview: asset card + KPI grid + daily production vs energy chart.
 * Economics: revenue / power cost / net margin per day + cumulative margin.
 * Stack health: SEC vs BOL, HHV efficiency, estimated stack RUL.
 *
 * Data is DB-first via useHydrogenData (rows written by real telemetry or
 * the hydrogen_synth provisional twin).
 */

'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Atom,
  Droplets,
  Euro,
  Gauge,
  HeartPulse,
  LayoutGrid,
  Timer,
} from 'lucide-react';
import { useHydrogenData } from '@/hooks/useHydrogenData';
import { usePageContext } from '@/components/copilot/usePageContext';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-4">
        <div>
          <p className="text-xs text-gray-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
        </div>
        <Icon className="h-5 w-5 text-emerald-600" />
      </CardContent>
    </Card>
  );
}

export function HydrogenSection({ plantId }: { plantId: string }) {
  const { asset, production, stackHealth, isLoading, error } = useHydrogenData(plantId);
  const [tab, setTab] = useState('overview');

  // Tab-aware copilot context for the electrolyzer console.
  usePageContext({
    plantId,
    plantName: asset?.name ?? undefined,
    section: `hydrogen:${tab}`,
    assetType: 'H2',
  });

  const kpis = useMemo(() => {
    if (!asset || production.length === 0) return null;
    const last30 = production.slice(-30);
    const kg = last30.reduce((s, d) => s + d.h2OutKg, 0);
    const margin = last30.reduce((s, d) => s + (d.netMarginEur ?? 0), 0);
    const secNow = asset.currentSecKwhPerKg ?? asset.secBolKwhPerKg;
    const health = stackHealth.at(-1) ?? null;
    return {
      kg30d: kg,
      margin30d: margin,
      secNow,
      effHhv: health?.efficiencyHhvPct ?? (100 * 39.4) / secNow,
      rulHours: health?.estRulHours ?? null,
      stackHours: asset.stackHours ?? null,
    };
  }, [asset, production, stackHealth]);

  const productionOption = useMemo(
    () => ({
      grid: { left: 55, right: 55, top: 30, bottom: 45 },
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, data: ['H2 produced (kg)', 'Energy in (MWh)'] },
      xAxis: { type: 'category', data: production.map((d) => d.date) },
      yAxis: [
        { type: 'value', name: 'kg', axisLabel: { fontSize: 10 } },
        { type: 'value', name: 'MWh', axisLabel: { fontSize: 10 } },
      ],
      series: [
        {
          name: 'H2 produced (kg)',
          type: 'bar',
          data: production.map((d) => d.h2OutKg),
          itemStyle: { color: '#10b981' },
        },
        {
          name: 'Energy in (MWh)',
          type: 'line',
          yAxisIndex: 1,
          data: production.map((d) => +(d.energyInKwh / 1000).toFixed(1)),
          itemStyle: { color: '#3b82f6' },
          smooth: true,
        },
      ],
    }),
    [production]
  );

  const economicsOption = useMemo(() => {
    let cum = 0;
    const cumSeries = production.map((d) => +(cum += d.netMarginEur ?? 0).toFixed(0));
    return {
      grid: { left: 55, right: 55, top: 30, bottom: 45 },
      tooltip: { trigger: 'axis' },
      legend: {
        bottom: 0,
        data: ['Revenue (€)', 'Power cost (€)', 'Net margin (€)', 'Cumulative margin (€)'],
      },
      xAxis: { type: 'category', data: production.map((d) => d.date) },
      yAxis: [
        { type: 'value', name: '€/day', axisLabel: { fontSize: 10 } },
        { type: 'value', name: '€ cum', axisLabel: { fontSize: 10 } },
      ],
      series: [
        {
          name: 'Revenue (€)',
          type: 'bar',
          stack: 'd',
          data: production.map((d) => d.revenueEur ?? 0),
          itemStyle: { color: '#10b981' },
        },
        {
          name: 'Power cost (€)',
          type: 'bar',
          stack: 'd',
          data: production.map((d) => -(d.powerCostEur ?? 0)),
          itemStyle: { color: '#f59e0b' },
        },
        {
          name: 'Net margin (€)',
          type: 'line',
          data: production.map((d) => d.netMarginEur ?? 0),
          itemStyle: { color: '#111827' },
        },
        {
          name: 'Cumulative margin (€)',
          type: 'line',
          yAxisIndex: 1,
          data: cumSeries,
          itemStyle: { color: '#6366f1' },
          areaStyle: { opacity: 0.08 },
          smooth: true,
        },
      ],
    };
  }, [production]);

  const secOption = useMemo(() => {
    if (!asset) return {};
    return {
      grid: { left: 55, right: 20, top: 30, bottom: 45 },
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, data: ['SEC (kWh/kg)', 'BOL SEC', 'EOL threshold'] },
      xAxis: { type: 'category', data: production.map((d) => d.date) },
      yAxis: { type: 'value', name: 'kWh/kg', min: 'dataMin', axisLabel: { fontSize: 10 } },
      series: [
        {
          name: 'SEC (kWh/kg)',
          type: 'line',
          data: production.map((d) => d.secKwhPerKg),
          itemStyle: { color: '#10b981' },
          smooth: true,
        },
        {
          name: 'BOL SEC',
          type: 'line',
          data: production.map(() => asset.secBolKwhPerKg),
          lineStyle: { type: 'dashed' },
          itemStyle: { color: '#9ca3af' },
          symbol: 'none',
        },
        {
          name: 'EOL threshold',
          type: 'line',
          data: production.map(() => +(asset.secBolKwhPerKg * 1.1).toFixed(1)),
          lineStyle: { type: 'dashed' },
          itemStyle: { color: '#ef4444' },
          symbol: 'none',
        },
      ],
    };
  }, [asset, production]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load hydrogen data: {error.message}</AlertDescription>
      </Alert>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (!asset || !kpis) {
    return (
      <Alert>
        <Atom className="h-4 w-4" />
        <AlertDescription>
          No electrolyzer asset is configured for this plant yet.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Asset header */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 p-4 text-sm">
          <span className="flex items-center gap-2 font-semibold text-gray-900">
            <Atom className="h-4 w-4 text-emerald-600" />
            {asset.name ?? 'Electrolyzer'}
          </span>
          <span className="text-gray-600">{asset.technology} · {(asset.ratedPowerKw / 1000).toFixed(1)} MW</span>
          <span className="text-gray-600">{asset.ratedKgPerH.toFixed(0)} kg/h rated</span>
          {asset.stackCount != null && <span className="text-gray-600">{asset.stackCount} stacks</span>}
          {kpis.stackHours != null && (
            <span className="text-gray-600">{Math.round(kpis.stackHours).toLocaleString()} stack hours</span>
          )}
        </CardContent>
      </Card>

      {/* KPI grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="H2 produced · 30d"
          value={`${(kpis.kg30d / 1000).toFixed(1)} t`}
          sub={`${Math.round(kpis.kg30d).toLocaleString()} kg`}
          icon={Droplets}
        />
        <KpiCard
          label="Net margin · 30d"
          value={`€${Math.round(kpis.margin30d).toLocaleString()}`}
          sub="revenue − power cost"
          icon={Euro}
        />
        <KpiCard
          label="Efficiency (HHV)"
          value={`${kpis.effHhv.toFixed(1)}%`}
          sub={`SEC ${kpis.secNow.toFixed(1)} kWh/kg`}
          icon={Gauge}
        />
        <KpiCard
          label="Stack RUL"
          value={kpis.rulHours != null ? `${Math.round(kpis.rulHours / 1000)}k h` : '—'}
          sub="to +10% SEC end-of-life"
          icon={Timer}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview" className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4" />
            Production
          </TabsTrigger>
          <TabsTrigger value="economics" className="flex items-center gap-2">
            <Euro className="h-4 w-4" />
            Economics
          </TabsTrigger>
          <TabsTrigger value="stack" className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4" />
            Stack health
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <Card>
            <CardHeader className="pb-0">
              <CardTitle className="text-base">Daily production</CardTitle>
              <p className="text-xs text-gray-500">
                Price-responsive operation: the electrolyzer runs the cheapest
                hours of each day-ahead curve.
              </p>
            </CardHeader>
            <CardContent>
              <ReactECharts option={productionOption} style={{ height: 360 }} notMerge />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="economics" className="mt-6">
          <Card>
            <CardHeader className="pb-0">
              <CardTitle className="text-base">Production economics</CardTitle>
              <p className="text-xs text-gray-500">
                Merchant green-H2 revenue vs the power bill, per day and cumulative.
              </p>
            </CardHeader>
            <CardContent>
              <ReactECharts option={economicsOption} style={{ height: 360 }} notMerge />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stack" className="mt-6">
          <Card>
            <CardHeader className="pb-0">
              <CardTitle className="text-base">Specific energy consumption</CardTitle>
              <p className="text-xs text-gray-500">
                SEC drifts up as the stack ages; end-of-life is +10% over
                beginning-of-life. Current stack RUL:{' '}
                {kpis.rulHours != null
                  ? `${Math.round(kpis.rulHours).toLocaleString()} h`
                  : 'n/a'}
                .
              </p>
            </CardHeader>
            <CardContent>
              <ReactECharts option={secOption} style={{ height: 360 }} notMerge />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default HydrogenSection;
