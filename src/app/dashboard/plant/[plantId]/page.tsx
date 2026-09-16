'use client';

/**
 * Plant overview for the authenticated app. Unlike the demo overview (static
 * fixtures), everything here reads the live org-scoped APIs:
 *   /api/plants/[id]/live                 latest device readings
 *   /api/digitaltwin/[id]/summary         expected vs actual (physics twin)
 *   /api/soiling/plants/[id]/summary      fleet soiling status + economics
 *   /api/soiling/plants/[id]/forecast     SR forecast curve
 *   /api/tickets/stats?plant_id=          open work
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowRight } from 'lucide-react';
import { useParams } from 'next/navigation';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import StatusLed from '@/components/ops/StatusLed';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import OpsLineChart, { type Series } from '@/components/ops/charts/OpsLineChart';
import OpsTimeRange, { OpsBucketToggle } from '@/components/ops/OpsTimeRange';
import { useChartRange } from '@/hooks/useChartRange';
import { useTwinWindow, buildTwinSeries, type TwinWindowArgs } from '@/hooks/useTwinWindow';
import { formatPlantTime, plantTzLabel } from '@/lib/plantTime';
import SrForecastChart, { type SrForecastPoint } from '@/components/ops/charts/SrForecastChart';
import KPIReadout from '@/components/ui/KPIReadout';
import AiInsightsCard from '@/components/ai/AiInsightsCard';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { usePageContext } from '@/components/copilot/usePageContext';
import PlantAlertStrip from '@/components/alerts/PlantAlertStrip';
import type { CommandBarMeta } from '@/components/ops/OpsCommandBar';

// Wind + hydrogen consoles (same bodies the demo surface uses). Loaded lazily
// so PV/BESS plants never pay for them.
const WindSection = dynamic(
  () => import('@/components/wind/WindSection').then((m) => m.WindSection),
  { ssr: false }
);
const HydrogenSection = dynamic(
  () => import('@/components/hydrogen/HydrogenSection').then((m) => m.HydrogenSection),
  { ssr: false }
);

interface LivePayload {
  live: boolean;
  total_power_kw: number | null;
  today_energy_kwh: number | null;
  stale_minutes: number | null;
}

interface SoilingSummary {
  _source?: string;
  currentStatus?: { avgSoilingRatio: number; estimatedLossPct: number };
  fleetHealth?: { normalInverters: number; minorIssues: number; majorIssues: number; critical: number };
  economicImpact?: { nextCleaningRecommended: string | null; expectedNetBenefit_EUR: number };
}

interface PowerForecastData {
  hourly?: { time: string; kw: number }[];
  daily?: { date: string; kwh: number }[];
  irradiance?: { time: string; ghi?: number; poa?: number }[];
  _source?: string;
}

interface BessAssetsPayload {
  assets?: {
    name: string;
    chemistry: string | null;
    nominalCapacityKwh: number | null;
    nominalPowerKw: number | null;
    currentSoh: number | null;
    currentSoc: number | null;
  }[];
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default function DashboardPlantOverviewPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const { plants, loading: plantsLoading } = useDemoPlants();
  const apiPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  usePageContext({ plantId, plantName: apiPlant?.name });

  const [live, setLive] = useState<LivePayload | null>(null);
  const [soiling, setSoiling] = useState<SoilingSummary | null>(null);
  const [forecast, setForecast] = useState<SrForecastPoint[]>([]);
  const [openTickets, setOpenTickets] = useState<number | null>(null);
  const [powerForecast, setPowerForecast] = useState<PowerForecastData | null>(null);
  const [bess, setBess] = useState<BessAssetsPayload | null>(null);
  const [faults, setFaults] = useState<any>(null);
  const { groups, loading: groupsLoading } = usePlantGroups(plantId);

  const plantLabel = (apiPlant?.name ?? plantId).toUpperCase();
  const chip: CommandBarMeta['assetChip'] = apiPlant ? assetTypeChip(apiPlant.asset_type) : 'PV';
  const isBess = chip === 'BESS';
  // Only PV/hybrid plants get soiling + twin panels; WIND/OTHER show neither
  // (their nav rail hides Soiling too, so the body must match). Guard on
  // apiPlant so we don't fire PV fetches while the asset type is still loading
  // (chip defaults to 'PV' before apiPlant resolves — would 404 on a BESS plant).
  const hasPv = apiPlant ? chip === 'PV' || chip === 'PV+BESS' : false;
  const hasBattery = apiPlant ? chip === 'BESS' || chip === 'PV+BESS' : false;

  useEffect(() => {
    if (!plantId) return;
    getJSON<LivePayload>(`/api/plants/${plantId}/live`).then(setLive);
  }, [plantId]);

  // Per-plant open-ticket count. Scope by the plant UUID (tickets store
  // Plant.id, not the slug) and trust the route's open_count (NEW+VALIDATED+
  // ASSIGNED+IN_PROGRESS; excludes DONE and WONT_FIX).
  useEffect(() => {
    if (!apiPlant?.id) return;
    getJSON<any>(`/api/tickets/stats?plant_id=${encodeURIComponent(apiPlant.id)}`).then((s) => {
      setOpenTickets(typeof s?.open_count === 'number' ? s.open_count : null);
    });
  }, [apiPlant?.id]);

  // Digital twin window: preset/custom/brush-driven, presets anchored to the
  // plant's last day with data.
  const [dataEnd, setDataEnd] = useState<string | null>(null);
  const twinCtl = useChartRange('7d', { dataEnd });
  const twinArgs: TwinWindowArgs | null = hasPv
    ? {
        from: twinCtl.from,
        to: twinCtl.to,
        spanDays: twinCtl.spanDays,
        bucket: twinCtl.bucket,
        bucketOverride: twinCtl.bucketOverride,
      }
    : null;
  const twinWindow = useTwinWindow(plantId, '/data', twinArgs);
  const twin = twinWindow.data;
  useEffect(() => {
    const end = twin?.metadata?.data_end;
    if (end) setDataEnd((prev) => prev ?? end);
  }, [twin]);

  // PV analytics only apply to plants with panels; a pure BESS plant would 404.
  useEffect(() => {
    if (!plantId || !hasPv) return;
    getJSON<SoilingSummary>(`/api/soiling/plants/${plantId}/summary`).then(setSoiling);
    getJSON<any>(`/api/soiling/plants/${plantId}/forecast?days=60`).then((d) => {
      const pts = (d?.forecasts ?? [])
        .map((f: any) => ({
          date: f.date,
          predicted: f.soilingRatio,
          lower: f.lowerBound,
          upper: f.upperBound,
        }))
        .filter((p: SrForecastPoint) => typeof p.predicted === 'number');
      setForecast(pts);
    });
    getJSON<any>(`/api/faults?plantId=${encodeURIComponent(plantId)}&enhanced=1`).then((d) => setFaults(d?.enhanced ?? null));
    getJSON<{ data?: PowerForecastData }>(`/api/plants/${plantId}/power-forecast`).then((d) =>
      setPowerForecast(d?.data ?? null)
    );
  }, [plantId, hasPv]);

  useEffect(() => {
    if (!plantId || !hasBattery) return;
    getJSON<BessAssetsPayload>(`/api/bess/plants/${plantId}`).then(setBess);
  }, [plantId, hasBattery]);
  const isOnboarding =
    apiPlant && ['ONBOARDING', 'CONFIGURING'].includes(String(apiPlant.status));

  const plantTz = apiPlant?.timezone ?? null;
  const twinChart = useMemo(() => buildTwinSeries(twin, plantTz), [twin, plantTz]);
  const twinSeries: Series[] = useMemo(() => {
    if (!twinChart) return [];
    return [
      {
        key: 'expected',
        label: 'Expected (twin)',
        values: twinChart.expected,
        tone: 'info',
        dashed: true,
        format: twinChart.formatValue,
      },
      {
        key: 'actual',
        label: 'Actual',
        values: twinChart.actual,
        tone: 'ok',
        format: twinChart.formatValue,
      },
    ];
  }, [twinChart]);

  const handleTwinBrush = (a: number, b: number) => {
    const rows = twin?.daily;
    if (!rows || !rows[a] || !rows[b]) return;
    const from = rows[a].date.slice(0, 10);
    const to = rows[b].date.slice(0, 10);
    if (from >= to) return;
    twinCtl.setCustomRange({ from, to });
  };

  // Toggle reflects what the server actually returned (an hourly request past
  // the intraday tail downgrades to daily and should read that way).
  const effectiveTwinBucket = (
    { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month' } as const
  )[(twin?._resolution as 'hourly' | 'daily' | 'weekly' | 'monthly') ?? 'daily'];

  // Power forecast: 48h expected-kW line + 7-day daily-kWh strip, with a
  // W/m² irradiance view (the location-based "what sun will I get" ask).
  const [pfMode, setPfMode] = useState<'power' | 'irradiance'>('power');
  const pfHourly = useMemo(() => (powerForecast?.hourly ?? []).slice(0, 48), [powerForecast]);
  const pfDaily = useMemo(() => (powerForecast?.daily ?? []).slice(0, 7), [powerForecast]);
  const pfIrradiance = useMemo(
    () => (powerForecast?.irradiance ?? []).slice(0, 48),
    [powerForecast]
  );

  const pfSeries: Series[] = useMemo(() => {
    if (pfMode === 'irradiance' && pfIrradiance.length) {
      return [
        {
          key: 'poa_wm2',
          label: 'Plane-of-array',
          values: pfIrradiance.map((p) => p.poa ?? 0),
          tone: 'warn',
          dashed: true,
          format: (v) => `${v.toFixed(0)} W/m²`,
        },
        {
          key: 'ghi_wm2',
          label: 'GHI',
          values: pfIrradiance.map((p) => p.ghi ?? 0),
          tone: 'info',
          format: (v) => `${v.toFixed(0)} W/m²`,
        },
      ];
    }
    if (!pfHourly.length) return [];
    return [
      {
        key: 'expected_kw',
        label: 'Expected power',
        values: pfHourly.map((p) => p.kw),
        tone: 'info',
        dashed: true,
        format: (v) => `${v.toFixed(0)} kW`,
      },
    ];
  }, [pfMode, pfHourly, pfIrradiance]);

  // Axis/tooltip labels in the PLANT's zone (named in the panel meta) — not
  // silently the viewer's browser zone.
  const pfXLabels = useMemo(
    () =>
      pfHourly
        .filter((_, i) => i % 12 === 0)
        .map((p) => `${formatPlantTime(p.time, plantTz, 'axis-day')} ${formatPlantTime(p.time, plantTz, 'axis-hour')}`),
    [pfHourly, plantTz]
  );

  const pfTooltipLabels = useMemo(
    () => pfHourly.map((p) => formatPlantTime(p.time, plantTz, 'tooltip')),
    [pfHourly, plantTz]
  );

  const fmtDailyKwh = (kwh: number) =>
    kwh >= 10000 ? `${(kwh / 1000).toFixed(1)} MWh` : `${Math.round(kwh).toLocaleString()} kWh`;

  const sr = soiling?.currentStatus?.avgSoilingRatio ?? null;
  const cleaningDate = soiling?.economicImpact?.nextCleaningRecommended ?? null;

  // Wind and hydrogen plants get their dedicated consoles (the same bodies
  // the demo surface renders) — the PV live/twin/soiling panels below don't
  // apply and would show an empty shell. Placed after all hooks.
  if (apiPlant && (chip === 'WIND' || chip === 'H2')) {
    return (
      <OpsShell
        plantId={plantId}
        activeNavKey="overview"
        commandBar={{
          section: 'OVERVIEW',
          sectionTone: 'info',
          plantLabel,
          assetChip: chip,
          userInitials: 'OP',
        }}
      >
        <div className="ops-legacy">
          {chip === 'WIND' ? (
            <WindSection plantId={plantId} />
          ) : (
            <HydrogenSection plantId={plantId} />
          )}
        </div>
      </OpsShell>
    );
  }

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="overview"
      commandBar={{
        section: 'OVERVIEW',
        sectionTone: 'info',
        plantLabel,
        assetChip: chip,
        conn: live?.live ? 'ok' : 'warn',
        pollSeconds: 900,
        userInitials: 'OP',
      }}
    >
      <div className="space-y-3.5">
        <PlantAlertStrip plantId={plantId} />
        {isOnboarding && (
          <OpsPanel label="Onboarding · in progress">
            <p className="text-sm" style={{ color: 'var(--ops-txt)' }}>
              This plant is still onboarding. Analytics appear automatically once data
              starts flowing.{' '}
              <Link
                href={`/dashboard/plant/${plantId}/status`}
                className="underline"
                style={{ color: 'var(--ops-info)' }}
              >
                Track onboarding progress
              </Link>
            </p>
          </OpsPanel>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-5">
          <OpsPanel>
            <KPIReadout
              label="Live power"
              value={live?.total_power_kw != null ? `${live.total_power_kw} kW` : '–'}
              signal={live?.live ? 'positive' : undefined}
            />
          </OpsPanel>
          <OpsPanel>
            <KPIReadout
              label="Energy today"
              value={live?.today_energy_kwh != null ? `${(live.today_energy_kwh / 1000).toFixed(2)} MWh` : '–'}
            />
          </OpsPanel>
          {isBess ? (
            <>
              <OpsPanel>
                <KPIReadout
                  label="State of health"
                  value={
                    bess?.assets?.[0]?.currentSoh != null
                      ? `${(bess.assets[0].currentSoh * 100).toFixed(1)}%`
                      : '–'
                  }
                  signal={
                    bess?.assets?.[0]?.currentSoh != null && bess.assets[0].currentSoh < 0.9
                      ? 'warning'
                      : 'positive'
                  }
                />
              </OpsPanel>
              <OpsPanel>
                <KPIReadout
                  label="Usable capacity"
                  value={
                    bess?.assets?.[0]?.nominalCapacityKwh != null
                      ? `${(
                          (bess.assets[0].nominalCapacityKwh * (bess.assets[0].currentSoh ?? 1)) /
                          1000
                        ).toFixed(2)} MWh`
                      : '–'
                  }
                />
              </OpsPanel>
            </>
          ) : hasPv ? (
            <>
              <OpsPanel>
                <KPIReadout
                  label={`Twin loss (${twinCtl.isCustom ? 'window' : twinCtl.range})`}
                  value={
                    twin?.summary?.avg_loss_pct != null
                      ? `${twin.summary.avg_loss_pct.toFixed(1)}%`
                      : '–'
                  }
                  signal={twin?.summary && twin.summary.avg_loss_pct > 8 ? 'warning' : undefined}
                />
              </OpsPanel>
              <OpsPanel>
                <KPIReadout
                  label="Soiling ratio"
                  value={sr != null ? sr.toFixed(3) : '–'}
                  signal={sr != null && sr < 0.93 ? 'warning' : undefined}
                />
              </OpsPanel>
            </>
          ) : null}
          <OpsPanel>
            <KPIReadout
              label="Open tickets"
              value={openTickets != null ? String(openTickets) : '–'}
              signal={openTickets ? 'warning' : undefined}
            />
          </OpsPanel>
        </div>

        {/* BESS: battery snapshot + pointers instead of PV analytics */}
        {isBess && (
          <OpsPanel
            label="Battery · asset snapshot"
            subtitle="Asset snapshot from the battery model, dispatch and revenue live in their own sections"
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KPIReadout
                label="Chemistry"
                value={bess?.assets?.[0]?.chemistry ?? '–'}
              />
              <KPIReadout
                label="Rated power"
                value={
                  bess?.assets?.[0]?.nominalPowerKw != null
                    ? `${(bess.assets[0].nominalPowerKw / 1000).toFixed(1)} MW`
                    : '–'
                }
              />
              <KPIReadout
                label="Rated energy"
                value={
                  bess?.assets?.[0]?.nominalCapacityKwh != null
                    ? `${(bess.assets[0].nominalCapacityKwh / 1000).toFixed(1)} MWh`
                    : '–'
                }
              />
              <KPIReadout
                label="State of charge"
                value={
                  bess?.assets?.[0]?.currentSoc != null
                    ? `${(bess.assets[0].currentSoc * 100).toFixed(0)}%`
                    : '–'
                }
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <Link
                href={`/dashboard/plant/${plantId}/bess`}
                className="underline"
                style={{ color: 'var(--ops-info)' }}
              >
                Battery health →
              </Link>
              <Link
                href={`/dashboard/plant/${plantId}/revenue`}
                className="underline"
                style={{ color: 'var(--ops-info)' }}
              >
                Dispatch revenue →
              </Link>
            </div>
          </OpsPanel>
        )}

        {/* Expected vs actual */}
        {hasPv && (
        <OpsPanel
          label="Digital twin · predicted vs actual power"
          subtitle={
            twin?.daily?.length
              ? `Digital twin against measured production · ${formatPlantTime(twin.daily[0].date, plantTz, 'stamp').slice(0, 10)} → ${formatPlantTime(twin.daily[twin.daily.length - 1].date, plantTz, 'stamp').slice(0, 10)}${twinCtl.isCustom ? ' · custom' : ''} · drag to zoom`
              : 'Digital twin prediction against measured production'
          }
          meta={
            <span className="flex items-center gap-3">
              <span style={{ color: 'var(--ops-dim)' }}>{plantTzLabel(plantTz)}</span>
              {twin?._source === 'database' ? (
                <span style={{ color: 'var(--ops-muted)' }}>
                  live · {twin.modelVersions?.length ? twin.modelVersions.join(' + ') : (twin.modelVersion ?? 'twin')}
                </span>
              ) : (
                <span style={{ color: 'var(--ops-muted)' }}>no twin data yet</span>
              )}
              <OpsBucketToggle
                value={twinCtl.bucketOverride}
                effective={effectiveTwinBucket}
                onChange={twinCtl.setBucket}
                options={
                  twinCtl.spanDays <= 120
                    ? ['hour', 'day', 'week', 'month']
                    : ['day', 'week', 'month']
                }
              />
              <OpsTimeRange
                value={twinCtl.range}
                onChange={twinCtl.setRange}
                options={['7d', '14d', '30d', '90d', '1y', 'all']}
                onCustomRange={twinCtl.setCustomRange}
              />
            </span>
          }
        >
          {twinSeries.length && twinChart ? (
            <OpsLineChart
              series={twinSeries}
              xLabels={twinChart.xLabels}
              xTooltipLabels={twinChart.xTooltipLabels}
              yLabels={twinChart.yLabels}
              formatValue={twinChart.formatValue}
              onBrush={handleTwinBrush}
              height={230}
            />
          ) : (
            <p className="py-8 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>
              Twin data appears within a day of your first data landing.
            </p>
          )}
        </OpsPanel>
        )}

        {/* Inverter groups drill-down: click a group to reach its inverter
            table, and from there any inverter's per-device twins. */}
        {hasPv && (
          <OpsPanel
            label={
              <>
                Inverter groups{' '}
                <span style={{ color: 'var(--ops-dim)' }}>· {groups?.length ?? 0} groups</span>
              </>
            }
            subtitle="Drill into a group, then an inverter, for per-device power / temperature / voltage / current twins"
            meta={<span style={{ color: 'var(--ops-muted)' }}>click into a group →</span>}
          >
            {groupsLoading ? (
              <p className="py-6 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>
                Loading groups…
              </p>
            ) : groups && groups.length > 0 ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {groups.map((g) => (
                  <Link
                    key={g.id}
                    href={`/dashboard/plant/${plantId}/group/${g.slug}`}
                    className="rounded-md border p-3 transition-colors hover:brightness-105"
                    style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="ops-num text-[13px]" style={{ color: 'var(--ops-bright)' }}>
                        {g.name}
                      </span>
                      <StatusLed tone="ok" size={6} />
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: 'var(--ops-muted)' }}>
                      {g.inverterCount ?? 0} inverters · {g.tilt}°/{g.azimuth}°
                    </div>
                    {g.inverter_model && (
                      <div
                        className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-[10px]"
                        style={{ color: 'var(--ops-dim)' }}
                        title={g.inverter_model}
                      >
                        {g.inverter_model}
                      </div>
                    )}
                    <div
                      className="mt-2 flex items-center justify-end text-[10px]"
                      style={{ color: 'var(--ops-info)' }}
                    >
                      view group <ArrowRight className="ml-1 h-3 w-3" />
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>
                No inverter groups configured yet.
              </p>
            )}
          </OpsPanel>
        )}

        {/* Forward power forecast (physics twin on Open-Meteo forecast weather).
            Hidden entirely when the pipeline hasn't written forecast rows yet
            (demo-safe: no empty-state panel). */}
        {hasPv && pfHourly.length > 0 && (
        <OpsPanel
          label="Power forecast · next 48 hours"
          subtitle="Physics forecast on Open-Meteo weather — next 48 hours, plus 7-day expected energy"
          meta={
            <span className="flex items-center gap-2">
              <span style={{ color: 'var(--ops-dim)' }}>{plantTzLabel(plantTz)}</span>
              {pfIrradiance.length > 0 && (
                <span className="flex gap-1">
                  {(['power', 'irradiance'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPfMode(mode)}
                      className="rounded border px-1.5 py-px text-[10px] transition-opacity hover:opacity-80"
                      style={{
                        color: pfMode === mode ? 'var(--ops-info)' : 'var(--ops-muted)',
                        background: pfMode === mode ? 'var(--ops-info-bg)' : 'transparent',
                        borderColor:
                          pfMode === mode ? 'var(--ops-info-border)' : 'var(--ops-hair)',
                      }}
                    >
                      {mode === 'power' ? 'kW' : 'W/m²'}
                    </button>
                  ))}
                </span>
              )}
              <span style={{ color: 'var(--ops-muted)' }}>forecast-physics-v1</span>
            </span>
          }
        >
          <OpsLineChart
            series={pfSeries}
            xLabels={pfXLabels}
            xTooltipLabels={pfTooltipLabels}
            height={220}
          />
          {pfDaily.length > 0 && (
            <div
              className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t pt-3"
              style={{ borderColor: 'var(--ops-row-hair)' }}
            >
              {pfDaily.map((d) => (
                <div key={d.date} className="font-mono">
                  <div className="text-[10px] uppercase" style={{ color: 'var(--ops-muted)' }}>
                    {d.date.slice(5)}
                  </div>
                  <div className="ops-num text-[13px]" style={{ color: 'var(--ops-txt)' }}>
                    {fmtDailyKwh(d.kwh)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </OpsPanel>
        )}

        {/* Soiling forecast + fleet health */}
        {hasPv && (
        <>
        <div className="grid gap-3.5 lg:grid-cols-3">
          <OpsPanel
            className="lg:col-span-2"
            label="Soiling forecast · next 60 days"
            subtitle="Provisional climate-transfer forecast until plant-trained models take over"
            meta={
              cleaningDate ? (
                <span style={{ color: 'var(--ops-warn)' }}>clean rec · {cleaningDate}</span>
              ) : undefined
            }
          >
            {forecast.length ? (
              <SrForecastChart
                points={forecast}
                yRange={[
                  Math.min(0.9, ...forecast.map((p) => p.lower)) - 0.01,
                  1.0,
                ]}
                height={220}
              />
            ) : (
              <p className="py-8 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>
                Forecast appears after onboarding analytics complete.
              </p>
            )}
          </OpsPanel>
          <OpsPanel
            label="Inverter soiling health · latest run"
            subtitle="Per-inverter soiling classification"
            meta={
              (soiling as any)?.currentStatus?.lastUpdateTime ? (
                <span style={{ color: 'var(--ops-dim)' }}>
                  as of {formatPlantTime((soiling as any).currentStatus.lastUpdateTime, plantTz, 'stamp')}
                </span>
              ) : undefined
            }
          >
            {soiling?.fleetHealth ? (
              <div className="grid grid-cols-2 gap-3">
                <KPIReadout label="Normal" value={soiling.fleetHealth.normalInverters} signal="positive" />
                <KPIReadout label="Minor" value={soiling.fleetHealth.minorIssues} />
                <KPIReadout label="Major" value={soiling.fleetHealth.majorIssues} signal={soiling.fleetHealth.majorIssues ? 'warning' : undefined} />
                <KPIReadout label="Critical" value={soiling.fleetHealth.critical} signal={soiling.fleetHealth.critical ? 'critical' : undefined} />
              </div>
            ) : (
              <p className="py-6 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>
                {plantsLoading ? 'Loading…' : 'No fleet data yet.'}
              </p>
            )}
          </OpsPanel>
        </div>

        {/* Predictive faults + AI insights */}
        <div className="grid gap-3.5 lg:grid-cols-3">
          <OpsPanel
            className="lg:col-span-2"
            label="Predictive fault queue · by days-to-fault"
            subtitle="Earliest predicted faults by days-to-fault"
            meta={
              faults?.health_score ? (
                <span style={{ color: faults.health_score.value >= 85 ? 'var(--ops-ok)' : faults.health_score.value >= 60 ? 'var(--ops-warn)' : 'var(--ops-alarm)' }}>
                  health {faults.health_score.value}/100
                </span>
              ) : undefined
            }
          >
            {faults?.predictive_faults?.length ? (
              <div className="space-y-1.5">
                {faults.predictive_faults
                  .slice()
                  .sort((a: any, b: any) => a.days_to_fault - b.days_to_fault)
                  .slice(0, 5)
                  .map((f: any) => (
                    <div key={f.id} className="flex items-center justify-between gap-3 font-mono text-[12px]" style={{ color: 'var(--ops-txt)' }}>
                      <span className="ops-num" style={{ minWidth: 64 }}>{f.equipment_id}</span>
                      <span className="flex-1 truncate" style={{ color: 'var(--ops-muted)' }}>{f.display_name}</span>
                      <span style={{ color: f.urgency === 'critical' || f.urgency === 'urgent' ? 'var(--ops-alarm)' : f.urgency === 'soon' ? 'var(--ops-warn)' : 'var(--ops-muted)' }}>
                        {f.days_to_fault <= 0 ? 'due' : `${f.days_to_fault}d`}
                      </span>
                      <span style={{ color: 'var(--ops-info)', minWidth: 90, textAlign: 'right' }}>
                        €{Math.round(f.revenue_at_risk_eur ?? 0).toLocaleString()}
                      </span>
                    </div>
                  ))}
                <Link href={`/dashboard/plant/${plantId}/faults`} className="mt-2 inline-block text-[11px] underline" style={{ color: 'var(--ops-info)' }}>
                  View all faults →
                </Link>
              </div>
            ) : (
              <p className="py-6 text-center text-sm" style={{ color: 'var(--ops-muted)' }}>
                No predictive faults — the queue is clean.
              </p>
            )}
          </OpsPanel>
          <AiInsightsCard
            plantId={plantId}
            plantData={{
              plantName: apiPlant?.name,
              capacity_MW: apiPlant?.capacity_mw,
              fleetSoiling: sr != null ? { srMean: sr, srMin: sr - 0.03, srMax: Math.min(1, sr + 0.02) } : undefined,
              healthDistribution: soiling?.fleetHealth
                ? {
                    normal: soiling.fleetHealth.normalInverters,
                    minorIssues: soiling.fleetHealth.minorIssues,
                    majorIssues: soiling.fleetHealth.majorIssues,
                    critical: soiling.fleetHealth.critical,
                  }
                : undefined,
              economicImpact: soiling?.economicImpact?.expectedNetBenefit_EUR != null
                ? { estimatedAnnualLoss_EUR: Math.round(soiling.economicImpact.expectedNetBenefit_EUR) }
                : undefined,
            }}
          />
        </div>
        </>
        )}
      </div>
    </OpsShell>
  );
}
