'use client';

import { useEffect, useState, useMemo, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { PlantMpptData, MpptData } from '@/types/mppt';
import PlantBreadcrumb from '@/components/ui/PlantBreadcrumb';
import { Abbr } from '@/components/ui/AbbrTooltip';
import InverterAiDiagnosis from '@/components/ai/InverterAiDiagnosis';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { usePageContext } from '@/components/copilot/usePageContext';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { Battery, Wind, ArrowLeft } from 'lucide-react';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import StatusLed, { type StatusTone as OpsStatusTone } from '@/components/ops/StatusLed';

// Dynamically import ECharts to avoid SSR issues
const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });
const MpptOverviewGrid = dynamic(() => import('@/components/mppt/MpptOverviewGrid'), { ssr: false });
const TwinTimelineChart = dynamic(() => import('@/components/twin/TwinTimelineChart'), { ssr: false });
const InverterRankRail = dynamic(
  () => import('./_components/InverterRankRail'),
  { ssr: false },
);
const RankOverTimeChart = dynamic(
  () => import('@/components/inverter/RankOverTimeChart'),
  { ssr: false },
);
const StringVoltageSpread = dynamic(
  () => import('@/components/twin/StringVoltageSpread'),
  { ssr: false },
);
const StringFleetEnvelope = dynamic(
  () => import('@/components/mppt/StringFleetEnvelope'),
  { ssr: false },
);
const MaintenanceHorizonTile = dynamic(
  () => import('@/components/maintenance/MaintenanceHorizonTile'),
  { ssr: false },
);

interface InverterMetrics {
  inverterId: string;
  groupId: string;
  soilingRatio: {
    mean: number;
    median: number;
    min: number;
    max: number;
    std: number;
  } | null;
  lossDisaggregation: {
    percentages: {
      soiling: number;
      temperature: number;
      spectral: number;
      inverter: number;
      wiringBop: number;
      degradation: number;
      total: number;
    };
  } | null;
  performance: {
    performanceRatio: number;
    availability_pct: number | null;
  };
  fleetComparison: {
    rank: number;
    deviationFromMean_pct: number;
    zScore: number;
    severity: string;
  };
  twinMetrics?: {
    avgPredicted: number;
    avgActual: number;
    avgResidual: number;
    maeResidual?: number;
    lossPct: number;
    maePct?: number;
    daysWithData: number;
  };
  fleetStats?: {
    meanLossPct: number;
    stdLossPct: number;
    totalInverters: number;
  };
  metadata: {
    analysisStart: string;
    analysisEnd: string;
  };
  _source?: string;
}

interface TrainingMetadata {
  trainingPeriod: {
    start: string;
    end: string;
  };
  metrics?: {
    r2: number;
    mae_kW: number;
    trainingSamples: number;
  };
}

interface ResidualsData {
  timestamp: string;
  actual: number;
  expected: number;
  loss_pct: number;
}

function InverterDetailPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const plantId = params.plantId as string;
  const inverterId = decodeURIComponent(params.inverterId as string);
  const clickedDate = searchParams.get('date');
  const aggregationType = searchParams.get('aggregation');
  const [data, setData] = useState<InverterMetrics | null>(null);
  const [trainingMetadata, setTrainingMetadata] = useState<TrainingMetadata | null>(null);
  const [residualsData, setResidualsData] = useState<ResidualsData[]>([]);
  const [trainingTimestamps, setTrainingTimestamps] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [mpptData, setMpptData] = useState<MpptData[] | null>(null);
  const [mpptLoading, setMpptLoading] = useState(false);
  const [showMppt, setShowMppt] = useState(false);
  const [twinTimeseries, setTwinTimeseries] = useState<any>(null);
  const [tempTimeseries, setTempTimeseries] = useState<any>(null);
  const [currTimeseries, setCurrTimeseries] = useState<any>(null);
  const [voltTimeseries, setVoltTimeseries] = useState<any>(null);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();
  const { plants } = useDemoPlants();
  const currentPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const assetType = currentPlant?.asset_type;

  // Publish current page scope to the Copilot rail (plant + inverter, plus
  // the current visible date range when known).
  usePageContext({
    plantId,
    inverterId,
    range: dateRange
      ? { from: dateRange.start, to: dateRange.end }
      : undefined,
  });

  useEffect(() => {
    const loadInverterData = async () => {
      try {
        let json: any = null;

        // 1. Run the two independent DB queries in parallel:
        //   - inverter-metrics (twin results across the fleet)
        //   - /api/plants/{plantId} (only used to resolve groupId for the breadcrumb)
        // Sequential awaits stacked ~200-400ms of dead time before; parallel is
        // gated by the slower of the two.
        const [dbRes, plantRes] = await Promise.all([
          fetch(`/api/digitaltwin/${plantId}/inverter-metrics`).catch(() => null),
          fetch(`/api/plants/${plantId}`).catch(() => null),
        ]);

        if (dbRes?.ok) {
          const dbData = await dbRes.json();
          const dbInv = dbData.inverters?.find((inv: any) => inv.inverterId === inverterId);
          if (dbInv) {
            // Resolve groupId from the parent plant's inverter_groups. Convention
            // in both demo plants: "INV 01.057" → group #1, slug "pv-01".
            let derivedGroupId = '';
            if (plantRes?.ok) {
              try {
                const plantData = await plantRes.json();
                const groups = plantData.data?.inverter_groups || [];
                const m = dbInv.inverterId.match(/^INV\s+0*(\d+)\./);
                if (m) {
                  const idx = parseInt(m[1], 10);
                  const preferredSlug = `pv-${String(idx).padStart(2, '0')}`;
                  const match =
                    groups.find((g: any) => g.slug === preferredSlug) ||
                    groups.find((g: any) => g.slug === `pv-${idx}`) ||
                    groups[idx - 1];
                  if (match) derivedGroupId = match.slug;
                }
              } catch {
                // Non-fatal, breadcrumb just won't show the group link.
              }
            }
            json = {
              inverterId: dbInv.inverterId,
                groupId: derivedGroupId,
                soilingRatio: null,  // Not available from twin, show "N/A" in UI
                lossDisaggregation: null,  // Not available, twin only gives total loss
                performance: {
                  performanceRatio: dbInv.performanceRatio ?? 0,
                  availability_pct: null,  // Not tracked by twin
                },
                fleetComparison: {
                  rank: dbInv.rank ?? 0,
                  deviationFromMean_pct: dbInv.deviationFromMean_pct ?? 0,
                  zScore: dbInv.zScore ?? 0,
                  severity: dbInv.severity ?? 'normal',
                },
                twinMetrics: {
                  avgPredicted: dbInv.avgPredicted,
                  avgActual: dbInv.avgActual,
                  avgResidual: dbInv.avgResidual,
                  maeResidual: dbInv.maeResidual,
                  lossPct: dbInv.lossPct,
                  maePct: dbInv.maePct,
                  daysWithData: dbInv.daysWithData,
                },
                fleetStats: dbData.fleetStats,
                metadata: { analysisStart: dbData.period?.from?.split('T')[0] ?? '2021-10-01', analysisEnd: dbData.period?.to?.split('T')[0] ?? '2025-12-14' },
                _source: 'database',
            };
          }
        }

        // Static fixture fallbacks only exist for demo/showcase plants — on
        // /dashboard a real inverter with no DB row shows the empty state.
        const allowFixtures = prefix !== '/dashboard';

        // 2. Fallback: per-inverter static JSON
        if (!json && allowFixtures) {
          const filename = inverterId.replace(/ /g, '_').replace(/\./g, '_') + '.json';
          const res = await fetch(`${dataRoot}/soiling/${plantId}/inverters/${filename}`);
          if (res.ok) json = await res.json();
        }

        // 3. Fallback: all_inverters.json
        if (!json && allowFixtures) {
          const allRes = await fetch(`${dataRoot}/soiling/${plantId}/all_inverters.json`);
          if (allRes.ok) {
            const allData = await allRes.json();
            const found = allData.inverters?.find((inv: any) => inv.inverterId === inverterId);
            if (found) {
              const sr = typeof found.soilingRatio === 'object' ? found.soilingRatio : null;
              const srMean = sr?.mean ?? (typeof found.soilingRatio === 'number' ? found.soilingRatio : 0.86);
              const srStd = sr?.std ?? 0.03;
              const totalLoss = (found.powerLoss ?? 0.1) * 100;
              json = {
                inverterId: found.inverterId,
                groupId: found.groupId,
                soilingRatio: {
                  mean: srMean, median: srMean, min: srMean - srStd, max: srMean + srStd, std: srStd,
                },
                lossDisaggregation: {
                  percentages: {
                    soiling: totalLoss * 0.4, temperature: 2.5, spectral: 1.0,
                    inverter: 1.5, wiringBop: 0.8, degradation: totalLoss * 0.1, total: totalLoss,
                  },
                },
                performance: {
                  performanceRatio: found.performanceRatio ?? 0.86,
                  availability_pct: 99.5,
                },
                fleetComparison: {
                  rank: found.fleetComparison?.rank ?? 0,
                  deviationFromMean_pct: found.fleetComparison?.deviationFromMean_pct ?? 0,
                  zScore: found.fleetComparison?.zScore ?? 0,
                  severity: found.fleetComparison?.severity ?? 'normal',
                },
                metadata: { analysisStart: '2020-10-01', analysisEnd: '2025-12-14' },
              };
            }
          }
        }

        if (!json) throw new Error('Inverter not found');

        const pct = json.lossDisaggregation?.percentages ?? {};
        const inverterData: InverterMetrics = {
          inverterId: json.inverterId,
          groupId: json.groupId ?? '',
          soilingRatio: {
            mean: json.soilingRatio?.mean ?? 0.86,
            median: json.soilingRatio?.median ?? json.soilingRatio?.mean ?? 0.86,
            min: json.soilingRatio?.min ?? 0.8,
            max: json.soilingRatio?.max ?? 0.9,
            std: json.soilingRatio?.std ?? 0.03,
          },
          lossDisaggregation: {
            percentages: {
              soiling: pct.soiling ?? 0,
              temperature: pct.temperature ?? 0,
              spectral: pct.spectral ?? 0,
              inverter: pct.inverter ?? 0,
              wiringBop: pct.wiringBop ?? 0,
              degradation: pct.degradation ?? 0,
              total: pct.total ?? 0,
            },
          },
          performance: {
            performanceRatio: json.performance?.performanceRatio ?? 0.86,
            availability_pct: json.performance?.availability_pct ?? 99.5,
          },
          fleetComparison: {
            rank: json.fleetComparison?.rank ?? 0,
            deviationFromMean_pct: json.fleetComparison?.deviationFromMean_pct ?? 0,
            zScore: json.fleetComparison?.zScore ?? 0,
            severity: json.fleetComparison?.severity ?? 'normal',
          },
          metadata: {
            analysisStart: json.metadata?.analysisStart ?? '2020-10-01',
            analysisEnd: json.metadata?.analysisEnd ?? '2025-12-14',
          },
          // Pass through the twin metrics (DB-backed) so the telemetry strip
          // can surface AVG POWER (DT), MAE, etc. Without this they'd be
          // silently dropped and the strip would fall back to perf-ratio.
          twinMetrics: json.twinMetrics,
          fleetStats: json.fleetStats,
        };

        setData(inverterData);
        // Render the shell + telemetry strip + breadcrumb the moment the
        // cheap metrics arrive. The three twin timeseries (heavy: fleet
        // P10/P50/P90 bands) load in a sibling effect below, chart panels
        // own their loading skeletons.
        setLoading(false);
      } catch (err) {
        console.error('Error loading inverter data:', err);
        setData(null);
        setLoading(false);
      }
    };

    loadInverterData();
  }, [inverterId, plantId]);

  // Twin timeseries, fired AFTER the shell is rendered so the user sees the
  // page immediately. Bounded to the inverter's actual analysis window
  // (was 2020-2030; that's 10 years of API-side scanning per metric).
  useEffect(() => {
    if (!data) return;
    const from = data.metadata.analysisStart;
    const to = data.metadata.analysisEnd;
    const encId = encodeURIComponent(inverterId);
    const ctrl = new AbortController();
    let alive = true;

    const fire = async (metric: string, setter: (v: any) => void) => {
      try {
        const res = await fetch(
          `/api/digitaltwin/${plantId}/timeseries?device_id=${encId}&metric=${metric}&fleet=1&from=${from}&to=${to}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) return;
        const d = await res.json();
        if (alive && d.series?.length > 0) setter(d);
      } catch {
        // aborted or fetch failed, chart shows its own empty state
      }
    };

    void fire('power_ac', setTwinTimeseries);
    void fire('temperature', setTempTimeseries);
    void fire('current_dc', setCurrTimeseries);
    void fire('voltage_dc', setVoltTimeseries);

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [data, inverterId, plantId]);

  // LAZY: Load MPPT/string data only when user expands the section
  useEffect(() => {
    if (!showMppt || mpptData) return;
    // MPPT fixtures are static snapshots; org plants that have one (e.g. the
    // demo org's kilima-solar) get the section too, everyone else falls
    // through to the empty state on a clean 404.
    setMpptLoading(true);
    fetch(`${dataRoot}/digitaltwin/${plantId}/mppt_string_data.json`)
      .then(res => res.ok ? res.json() : null)
      .then((json: PlantMpptData | null) => {
        setMpptData(json?.inverters?.[inverterId]?.mppts ?? []);
        setMpptLoading(false);
      })
      .catch(() => setMpptLoading(false));
  }, [showMppt, plantId, inverterId, mpptData, prefix]);

  // Create Map for O(1) timestamp lookups
  const timestampToIndex = useMemo(() => {
    const map = new Map<string, number>();
    residualsData.forEach((r, idx) => {
      map.set(r.timestamp, idx);
    });
    return map;
  }, [residualsData]);

  // Power comparison chart options - Expected vs Measured
  const powerChartOptions = useMemo(() => {
    if (!data) return {};

    const timestamps: string[] = [];
    const expectedPower: (number | null)[] = [];
    const measuredPower: (number | null)[] = [];

    // Use real CSV data if available, otherwise generate synthetic data
    if (residualsData.length > 0) {
      // Use real historical data from CSV
      for (const row of residualsData) {
        // Parse timestamp and format for display
        const date = new Date(row.timestamp);
        const label = date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        }) + ' ' + date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });

        timestamps.push(label);
        expectedPower.push(row.expected);
        measuredPower.push(row.actual);
      }

      // Default zoom to last 7 days (168 hours)
      const totalHours = residualsData.length;
      const last7DaysHours = Math.min(168, totalHours);
      const startPercent = Math.max(0, Math.round(((totalHours - last7DaysHours) / totalHours) * 100));

    } else {
      // Fallback: Generate synthetic data for 30 days
      const baseDate = new Date('2024-11-18');
      const nameplateKW = 500;
      const lossPercent = data.lossDisaggregation.percentages.total / 100;

      for (let day = 0; day < 30; day++) {
        for (let hour = 0; hour < 24; hour++) {
          const date = new Date(baseDate);
          date.setDate(date.getDate() + day);
          date.setHours(hour, 0, 0, 0);

          const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
                       ' ' + String(hour).padStart(2, '0') + ':00';
          timestamps.push(label);

          const solarHour = hour - 6;
          let irradianceFactor = 0;
          if (hour >= 6 && hour <= 19) {
            irradianceFactor = Math.exp(-Math.pow((solarHour - 6) / 3.5, 2));
          }

          const dailyVariation = 0.85 + Math.random() * 0.15;
          const noise = 0.95 + Math.random() * 0.1;

          if (irradianceFactor > 0.01) {
            const expected = nameplateKW * irradianceFactor * dailyVariation;
            const measured = expected * (1 - lossPercent) * noise;
            expectedPower.push(Math.round(expected * 10) / 10);
            measuredPower.push(Math.round(measured * 10) / 10);
          } else {
            expectedPower.push(null);
            measuredPower.push(null);
          }
        }
      }
    }

    // Calculate zoom range - either centered on clicked date or default to last 7 days
    let startPercent = 0;
    let endPercent = 100;
    let clickedDateIndex = -1;
    let zoomTitle = '';

    if (clickedDate && residualsData.length > 0) {
      // Find the clicked date in the data
      clickedDateIndex = residualsData.findIndex(d => d.timestamp.startsWith(clickedDate));

      console.log('Click-through Debug:', {
        clickedDate,
        totalDataPoints: residualsData.length,
        clickedDateIndex,
        firstTimestamp: residualsData[0]?.timestamp,
        sampleTimestamp: residualsData[Math.floor(residualsData.length / 2)]?.timestamp,
        matchFound: clickedDateIndex >= 0
      });

      if (clickedDateIndex >= 0) {
        // Calculate ±3 days (72 hours) centered on clicked date
        const totalHours = residualsData.length;
        const halfWeekHours = 72; // 3 days * 24 hours
        const startHour = Math.max(0, clickedDateIndex - halfWeekHours);
        const endHour = Math.min(totalHours, clickedDateIndex + halfWeekHours);

        startPercent = Math.round((startHour / totalHours) * 100);
        endPercent = Math.round((endHour / totalHours) * 100);

        // Set zoom title to show the clicked date
        zoomTitle = `Zoomed to ${clickedDate} (±3 days)`;
      } else {
        console.warn(`Clicked date ${clickedDate} not found in residuals data`);
        zoomTitle = `Date ${clickedDate} not found - showing last 7 days`;
      }
    }

    if (!zoomTitle) {
      // Default zoom to last 7 days
      const totalDataPoints = timestamps.length;
      const last7DaysPoints = residualsData.length > 0 ? Math.min(168, totalDataPoints) : 168;
      startPercent = Math.max(0, Math.round(((totalDataPoints - last7DaysPoints) / totalDataPoints) * 100));
      endPercent = 100;
      zoomTitle = 'Last 7 Days';
    }

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || params.length === 0) return '';
          const time = params[0].name;
          let result = `<strong>${time}</strong><br/>`;
          params.forEach((p: any) => {
            if (p.value !== null) {
              result += `${p.marker} ${p.seriesName}: ${p.value} kW<br/>`;
            }
          });
          return result;
        },
      },
      legend: {
        data: ['Expected Power', 'Measured Power', 'Training Timestamps'],
        top: 0,
        textStyle: { color: '#374151' },
      },
      title: [
        // Training metadata in top-right
        ...(trainingMetadata ? [{
          text: `Digital Twin Training: ${trainingMetadata.trainingPeriod.start} to ${trainingMetadata.trainingPeriod.end}`,
          subtext: trainingMetadata.metrics ? `R²: ${trainingMetadata.metrics.r2.toFixed(3)}, MAE: ${trainingMetadata.metrics.mae_kW.toFixed(2)} kW` : '',
          right: 10,
          top: 5,
          textStyle: { color: '#6b7280', fontSize: 11 },
          subtextStyle: { color: '#9ca3af', fontSize: 10 },
        }] : []),
        // Zoom status in top-left
        {
          text: zoomTitle,
          left: 10,
          top: 5,
          textStyle: {
            color: clickedDateIndex >= 0 ? '#3b82f6' : '#6b7280',
            fontSize: 13,
            fontWeight: 'bold'
          },
        }
      ],
      grid: {
        left: 60,
        right: 30,
        top: 40,
        bottom: 100,
      },
      xAxis: {
        type: 'category',
        data: timestamps,
        axisLabel: {
          rotate: 45,
          color: '#6b7280',
          interval: 23, // Show one label per day
        },
        axisLine: { lineStyle: { color: '#d1d5db' } },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      yAxis: {
        type: 'value',
        name: 'Power (kW)',
        axisLabel: { color: '#6b7280' },
        nameTextStyle: { color: '#6b7280' },
        axisLine: { lineStyle: { color: '#d1d5db' } },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      dataZoom: [
        { type: 'inside', start: startPercent, end: endPercent },
        {
          type: 'slider',
          start: startPercent,
          end: endPercent,
          bottom: 20,
          height: 30,
          textStyle: { color: '#6b7280' },
          borderColor: '#d1d5db',
          fillerColor: 'rgba(59, 130, 246, 0.2)',
          handleStyle: {
            color: '#3b82f6',
            borderColor: '#60a5fa'
          },
          backgroundColor: '#f9fafb',
        },
      ],
      series: [
        {
          name: 'Expected Power',
          type: 'line',
          data: expectedPower,
          smooth: true,
          symbol: 'none',
          color: '#3b82f6',  // Blue for expected (baseline prediction)
          lineStyle: { color: '#3b82f6', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
                { offset: 1, color: 'rgba(59, 130, 246, 0.05)' },
              ],
            },
          },
          // Mark training period with subtle highlight
          ...(trainingMetadata && residualsData.length > 0 ? {
            markArea: {
              silent: true,
              itemStyle: {
                color: 'rgba(59, 130, 246, 0.08)',
                borderWidth: 1,
                borderColor: 'rgba(59, 130, 246, 0.3)',
              },
              label: {
                show: true,
                position: 'insideTop',
                formatter: 'Training Period',
                color: '#3b82f6',
                fontSize: 10,
              },
              data: [[
                {
                  xAxis: 0, // Start at beginning
                },
                {
                  // Find index where training ends
                  xAxis: residualsData.findIndex(d => new Date(d.timestamp) > new Date(trainingMetadata.trainingPeriod.end)),
                }
              ]]
            }
          } : {}),
          // Mark clicked date with vertical line
          ...(clickedDateIndex >= 0 ? {
            markLine: {
              silent: false,
              symbol: ['none', 'arrow'],
              lineStyle: {
                color: '#f59e0b', // Amber-500 (more visible)
                width: 3,
                type: 'dashed',
              },
              label: {
                show: true,
                position: 'insideEndTop',
                formatter: `Clicked: ${clickedDate}`,
                color: '#92400e',
                fontSize: 11,
                fontWeight: 'bold',
                backgroundColor: 'rgba(254, 243, 199, 0.95)',
                padding: [4, 8],
                borderRadius: 4,
              },
              data: [
                { xAxis: clickedDateIndex }
              ]
            }
          } : {}),
        },
        {
          name: 'Measured Power',
          type: 'line',
          data: measuredPower,
          smooth: true,
          symbol: 'none',
          color: '#22c55e', // Green for measured (actual production)
          lineStyle: { color: '#22c55e', width: 2 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(34, 197, 94, 0.3)' },
                { offset: 1, color: 'rgba(34, 197, 94, 0.05)' },
              ],
            },
          },
        },
        // Training timestamps scatter overlay
        ...(trainingTimestamps.length > 0 && residualsData.length > 0 ? [{
          name: 'Training Timestamps',
          type: 'scatter',
          data: trainingTimestamps.map(trainingTs => {
            // O(1) Map lookup instead of O(n) findIndex
            const index = timestampToIndex.get(trainingTs);
            if (index !== undefined && index < expectedPower.length) {
              return [index, expectedPower[index]];
            }
            return null;
          }).filter((point): point is [number, number | null] => point !== null),
          symbol: 'circle',
          symbolSize: 4,
          itemStyle: {
            color: '#60a5fa', // Blue-400 for training points
            opacity: 0.6,
          },
          tooltip: {
            formatter: (params: any) => {
              const idx = params.data[0];
              const ts = residualsData[idx]?.timestamp || '';
              return `<strong>Training Point</strong><br/>${ts}<br/>Expected: ${params.data[1]} kW`;
            },
          },
        }] : []),
      ],
    };
  }, [data, trainingMetadata, residualsData, trainingTimestamps, clickedDate, timestampToIndex]);

  // Fleet P10/P50/P90 envelopes are pulled from the same `?fleet=1` payloads
  // as the device's own predicted/actual series. Declared here so they can
  // be consumed by `twinDailyChartOptions` (below) without a temporal-dead-
  // zone error, useMemos hoist the function but not its dependencies.
  const powerFleetBand = useMemo(
    () => twinTimeseries?.fleet?.series ?? [],
    [twinTimeseries]
  );
  const tempFleetBand = useMemo(
    () => tempTimeseries?.fleet?.series ?? [],
    [tempTimeseries]
  );
  const currFleetBand = useMemo(
    () => currTimeseries?.fleet?.series ?? [],
    [currTimeseries]
  );
  const voltFleetBand = useMemo(
    () => voltTimeseries?.fleet?.series ?? [],
    [voltTimeseries]
  );
  // Honest provenance caption per channel, keyed on the twin's model_version:
  //  - multi-signal-v1: real measured actual vs physics-ML twin expectation, sourced
  //    from the bronze lakehouse (scripts/backfill_electrical_twins.py).
  //  - electrical-synth-*: fallback physics-synthesised channel for any plant not
  //    yet backfilled from bronze (scripts/synth_electrical_twins.py).
  const synthCaption = (ts: any) => {
    const mv = typeof ts?.modelVersion === 'string' ? ts.modelVersion : '';
    if (mv.startsWith('multi-signal')) return ' · measured vs physics-ML expected';
    if (mv.startsWith('electrical-synth')) return ' · physics-derived synthetic twin';
    return '';
  };

  // DB-backed twin chart (daily predicted vs actual from analysis_results),
  // now with an optional fleet P10,P90 envelope and a P50 median line so the
  // operator can see whether this inverter sits inside or outside the rest
  // of the plant for the same metric on the same day.
  const twinDailyChartOptions = useMemo(() => {
    if (!twinTimeseries?.series?.length) return null;
    const dates = twinTimeseries.series.map((s: any) => s.date?.split('T')[0] || s.date);
    const predicted = twinTimeseries.series.map((s: any) => s.predicted != null ? Math.round(s.predicted * 10) / 10 : null);
    const actual = twinTimeseries.series.map((s: any) => s.actual != null ? Math.round(s.actual * 10) / 10 : null);
    const residual = twinTimeseries.series.map((s: any) => s.residual != null ? Math.round(s.residual * 10) / 10 : null);

    const fleetMap = new Map<string, { p10: number; p50: number; p90: number }>();
    for (const f of powerFleetBand) {
      const d = f.date?.split('T')[0] || f.date;
      fleetMap.set(d, { p10: f.p10, p50: f.p50, p90: f.p90 });
    }
    const hasFleet = fleetMap.size > 0;
    const p10 = dates.map((d: string) => {
      const f = fleetMap.get(d);
      return f ? Math.round(f.p10 * 10) / 10 : null;
    });
    const p90minusP10 = dates.map((d: string) => {
      const f = fleetMap.get(d);
      return f ? Math.round((f.p90 - f.p10) * 10) / 10 : null;
    });
    const p50 = dates.map((d: string) => {
      const f = fleetMap.get(d);
      return f ? Math.round(f.p50 * 10) / 10 : null;
    });

    const fleetSeries = hasFleet
      ? [
          {
            name: 'Fleet P10',
            type: 'line',
            stack: 'fleet-band',
            data: p10,
            symbol: 'none',
            lineStyle: { width: 0, opacity: 0 },
            areaStyle: { color: 'transparent' },
            silent: true,
            z: 1,
            tooltip: { show: false },
          },
          {
            name: 'Fleet P10,P90',
            type: 'line',
            stack: 'fleet-band',
            data: p90minusP10,
            symbol: 'none',
            lineStyle: { width: 0, opacity: 0 },
            areaStyle: { color: 'rgba(100, 116, 139, 0.15)' },
            z: 1,
          },
          {
            name: 'Fleet median',
            type: 'line',
            data: p50,
            symbol: 'none',
            lineStyle: { color: '#64748b', width: 1, type: 'dashed' as const },
            itemStyle: { color: '#64748b' },
            z: 2,
          },
        ]
      : [];

    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: hasFleet
          ? ['Predicted (DT)', 'Actual', 'Residual', 'Fleet median', 'Fleet P10,P90']
          : ['Predicted (DT)', 'Actual', 'Residual'],
        top: 0,
      },
      grid: { left: 60, right: 20, top: 50, bottom: 80 },
      dataZoom: [{ type: 'slider', start: 90, end: 100 }],
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: [
        { type: 'value', name: 'Power (kW)', position: 'left' },
        { type: 'value', name: 'Residual (kW)', position: 'right', splitLine: { show: false } },
      ],
      color: ['#3b82f6', '#22c55e', '#f59e0b', '#64748b', '#94a3b8'],
      series: [
        ...fleetSeries,
        { name: 'Predicted (DT)', type: 'line', data: predicted, smooth: false, symbol: 'none', itemStyle: { color: '#3b82f6' }, lineStyle: { color: '#3b82f6', width: 1.5 }, z: 3 },
        { name: 'Actual', type: 'line', data: actual, smooth: false, symbol: 'none', itemStyle: { color: '#22c55e' }, lineStyle: { color: '#22c55e', width: 1.5 }, z: 3 },
        { name: 'Residual', type: 'bar', data: residual, yAxisIndex: 1, itemStyle: { color: (params: any) => (params.value ?? 0) < 0 ? '#ef4444' : '#f59e0b' }, barWidth: 2, opacity: 0.6, z: 4 },
      ],
    };
  }, [twinTimeseries, powerFleetBand]);

  // Temperature / Voltage / Current twin series, rendered via the shared
  // TwinTimelineChart component (consistent styling, legend-color parity with line).
  const tempSeries = useMemo(
    () => tempTimeseries?.series ?? [],
    [tempTimeseries]
  );
  const currSeries = useMemo(
    () => currTimeseries?.series ?? [],
    [currTimeseries]
  );
  const voltSeries = useMemo(
    () => voltTimeseries?.series ?? [],
    [voltTimeseries]
  );

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'Critical': return 'text-signal-critical bg-signal-critical/10 border-signal-critical/20';
      case 'Major': return 'text-orange-600 bg-orange-100 border-orange-200';
      case 'Minor': return 'text-signal-warning bg-yellow-100 border-yellow-200';
      default: return 'text-green-600 bg-green-100 border-green-200';
    }
  };

  const opsShellCommandBar = {
    section: data ? `INVERTER / ${data.inverterId}` : 'INVERTER',
    sectionTone: 'info' as const,
    plantLabel: (currentPlant?.name ?? plantId).toUpperCase(),
    // Clickable GROUP crumb between plant and section once the parent group
    // resolves, so back-navigation up the drill-down works from the trail.
    sectionCrumbs: data?.groupId
      ? [
          {
            label: `GROUP ${data.groupId}`,
            href: `${prefix}/plant/${plantId}/group/${encodeURIComponent(data.groupId)}`,
          },
        ]
      : undefined,
    assetChip: assetTypeChip(currentPlant?.asset_type),
    conn: 'ok' as const,
    pollSeconds: 2,
    userInitials: 'AM',
  };

  if (loading) {
    return (
      <OpsShell plantId={plantId} activeNavKey="overview" commandBar={opsShellCommandBar}>
        <div
          className="flex h-64 items-center justify-center font-mono text-[12px]"
          style={{ color: 'var(--ops-muted)' }}
        >
          loading inverter telemetry…
        </div>
      </OpsShell>
    );
  }

  if (!data) {
    return (
      <OpsShell plantId={plantId} activeNavKey="overview" commandBar={opsShellCommandBar}>
        <div
          className="flex h-64 flex-col items-center justify-center font-mono text-[12px]"
          style={{ color: 'var(--ops-alarm)' }}
        >
          <span>inverter not found</span>
          <Link
            href={`${prefix}/plant/${plantId}/faults#heatmap`}
            className="mt-3 font-mono text-[11px] uppercase tracking-wider"
            style={{ color: 'var(--ops-info)' }}
          >
            ← back to fault heatmap
          </Link>
        </div>
      </OpsShell>
    );
  }

  return (
    <OpsShell plantId={plantId} activeNavKey="overview" commandBar={opsShellCommandBar}>
    {/* Trail comes from the shell command bar (FLEET / plant / INVERTER / id) —
        no page-level breadcrumb; the group link lives next to the title. */}
    <div className="flex gap-6 items-start ops-legacy">
      <InverterRankRail plantId={plantId} activeInverterId={inverterId} />
      <div className="flex-1 min-w-0 space-y-3">
      {/* Header, ops style */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold font-mono ops-num" style={{ color: 'var(--ops-bright)' }}>
            {data.inverterId}
          </h1>
          {data.groupId ? (
            <Link
              href={`${prefix}/plant/${plantId}/group/${encodeURIComponent(data.groupId)}`}
              className="ops-eyebrow text-[10px] transition-colors hover:underline hover:[color:var(--ops-bright)]"
              style={{ letterSpacing: '0.08em', color: 'var(--ops-info)' }}
              title="Open group view"
            >
              GROUP {data.groupId}
            </Link>
          ) : null}
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
          style={{
            color: `var(--ops-${
              data.fleetComparison.severity === 'critical'
                ? 'alarm'
                : data.fleetComparison.severity === 'major'
                  ? 'warn'
                  : 'ok'
            })`,
            background: `var(--ops-${
              data.fleetComparison.severity === 'critical'
                ? 'alarm'
                : data.fleetComparison.severity === 'major'
                  ? 'warn'
                  : 'ok'
            }-bg)`,
            borderColor: `var(--ops-${
              data.fleetComparison.severity === 'critical'
                ? 'alarm'
                : data.fleetComparison.severity === 'major'
                  ? 'warn'
                  : 'ok'
            }-border)`,
          }}
        >
          <StatusLed
            tone={
              (data.fleetComparison.severity === 'critical'
                ? 'alarm'
                : data.fleetComparison.severity === 'major'
                  ? 'warn'
                  : 'ok') as OpsStatusTone
            }
            size={6}
            pulse={data.fleetComparison.severity === 'critical'}
          />
          {data.fleetComparison.severity}
        </span>
      </div>

      {/* Ops telemetry strip, replaces the 4 gradient KPI cards */}
      <TelemetryStrip
        columns={4}
        cells={[
          {
            label: 'TWIN MEAN BIAS',
            value: (data.twinMetrics?.lossPct ?? data.lossDisaggregation?.percentages?.total ?? 0).toFixed(1),
            unit: '%',
            tone:
              Math.abs(data.twinMetrics?.lossPct ?? 0) > 5
                ? 'alarm'
                : Math.abs(data.twinMetrics?.lossPct ?? 0) > 2
                  ? 'warn'
                  : 'ok',
            footer:
              data.twinMetrics?.maePct != null
                ? `MAE ${data.twinMetrics.maePct.toFixed(1)}% (±${(data.twinMetrics?.maeResidual ?? 0).toFixed(1)} kW)`
                : 'predicted vs actual',
            tooltip:
              'Average signed gap between the digital twin’s expected power and the measured power over the window (positive = underperforming vs the twin). MAE below is the mean absolute error, |measured − expected|.',
          },
          {
            label: 'FLEET RANK',
            value: data.fleetComparison.rank ? `#${data.fleetComparison.rank}` : ',',
            tone: 'bess',
            footer: `of ${data.fleetStats?.totalInverters ?? ','} inverters`,
            tooltip:
              'This inverter’s position among all inverters in the plant, ranked by twin loss (rank 1 = best performer).',
          },
          {
            label: 'AVG POWER (DT)',
            value:
              data.twinMetrics?.avgActual?.toFixed(1) ??
              ((data.performance.performanceRatio ?? 0) * 100).toFixed(1),
            unit: 'kW',
            tone: 'neutral',
            footer: data.twinMetrics?.avgPredicted
              ? `expected ${data.twinMetrics.avgPredicted.toFixed(1)} kW`
              : 'twin baseline',
            tooltip:
              'Average measured AC power over the window. “Expected” is the digital twin’s (DT) prediction for the same period — the gap between them is the loss.',
          },
          {
            label: 'DATA COVERAGE',
            value: (data.twinMetrics?.daysWithData ?? ',').toString(),
            unit: 'days',
            tone: 'ok',
            footer: 'twin training data',
            tooltip: 'Number of days with digital-twin data behind these figures.',
          },
        ]}
      />

      {/* Digital Twin: Daily Power Analysis (from DB, primary chart) */}
      {twinDailyChartOptions && (
        <OpsPanel
          label="Digital twin · predicted vs actual power"
          meta={
            <span>
              {twinTimeseries?.series?.length || 0} days · daily avg kW · twin model
            </span>
          }
        >
          <ReactECharts
            option={twinDailyChartOptions}
            style={{ height: '480px', width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />
        </OpsPanel>
      )}

      {/* Legacy CSV chart removed, DB twin chart above is the primary view */}

      {/* Temperature / DC Voltage spread / DC Current twin trio.
          The trained per-MPPT voltage twin was retired (its physics baseline
          drifted toward Voc — structural residual, not actionable). The DC
          voltage twin shown here is the physics-derived channel written by
          scripts/synth_electrical_twins.py (captioned as such); the
          string-voltage dispersion view remains the operational mismatch/
          shading/disconnection signal. */}
      <div className="ops-grid-2">
        {tempSeries.length > 0 && (
          <OpsPanel
            label="Temperature twin · predicted vs actual"
            meta={<span>{tempSeries.length} days · P10,P90 envelope{synthCaption(tempTimeseries)}</span>}
          >
            <TwinTimelineChart
              series={tempSeries}
              unit="°C"
              predictedColor="#f97316"
              actualColor="#ef4444"
              metric="temperature"
              metricLabel="temperature"
              inverterId={inverterId}
              plantId={plantId}
              fleetBand={tempFleetBand}
            />
          </OpsPanel>
        )}
        {voltSeries.length > 0 && (
          <OpsPanel
            label="DC voltage twin · predicted vs actual"
            meta={<span>{voltSeries.length} days · P10,P90 envelope{synthCaption(voltTimeseries)}</span>}
          >
            <TwinTimelineChart
              series={voltSeries}
              unit="V (DC)"
              predictedColor="#6366f1"
              actualColor="#4f46e5"
              metric="voltage_dc"
              metricLabel="DC voltage"
              inverterId={inverterId}
              plantId={plantId}
              fleetBand={voltFleetBand}
            />
          </OpsPanel>
        )}
        <OpsPanel
          label="String DC voltage spread"
          meta={<span>outliers = module mismatch / shading / disconnect</span>}
        >
          <StringVoltageSpread plantId={plantId} inverterId={inverterId} />
        </OpsPanel>
        {currSeries.length > 0 && (
          <OpsPanel
            label="DC current twin · sum across strings"
            meta={<span>{currSeries.length} days · P10,P90 envelope{synthCaption(currTimeseries)}</span>}
          >
            <TwinTimelineChart
              series={currSeries}
              unit="A (DC)"
              predictedColor="#10b981"
              actualColor="#059669"
              metric="current_dc"
              metricLabel="DC current"
              inverterId={inverterId}
              plantId={plantId}
              fleetBand={currFleetBand}
            />
          </OpsPanel>
        )}
      </div>

      {/* Fleet rank trajectory, sanity check for anomaly detection. */}
      <RankOverTimeChart plantId={plantId} inverterId={inverterId} />

      {/* Deterministic maintenance classifier, fuses PDS, twin residuals,
          soiling forecast, and RUL into a likely_cause + ETA + evidence
          bundle. Threads the rule output into the LLM diagnosis below. */}
      <MaintenanceHorizonTile plantId={plantId} inverterId={inverterId} />

      {/* AI Diagnostic Analysis, interprets twins + classifier + manual */}
      <div id="ai-diagnosis">
        <InverterAiDiagnosis plantId={plantId} inverterId={inverterId} />
      </div>

      {/* MPPT / String Overview, loaded on demand */}
      <div
        className="overflow-hidden rounded-md border"
        style={{ background: 'var(--ops-panel)', borderColor: 'var(--ops-hair)' }}
      >
        <button
          onClick={() => setShowMppt(!showMppt)}
          className="flex w-full items-center justify-between px-3.5 py-3 text-left transition-colors hover:brightness-105"
        >
          <div className="flex items-center gap-3">
            <span className="ops-eyebrow text-[11px]" style={{ letterSpacing: '0.06em' }}>
              MPPT_STRING.details
            </span>
            <span className="font-mono text-[10px]" style={{ color: 'var(--ops-muted)' }}>
              per-MPPT voltage · per-string current drill-down
            </span>
          </div>
          <svg
            className={`h-4 w-4 transition-transform ${showMppt ? 'rotate-180' : ''}`}
            style={{ color: 'var(--ops-muted)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showMppt && (
          <div className="border-t px-3.5 pb-3.5" style={{ borderColor: 'var(--ops-row-hair)' }}>
            {mpptLoading ? (
              <div
                className="flex items-center justify-center py-8 font-mono text-[11px]"
                style={{ color: 'var(--ops-muted)' }}
              >
                loading MPPT &amp; string data…
              </div>
            ) : mpptData && mpptData.length > 0 ? (
              <div className="space-y-3 pt-3">
                <div>
                  <div className="ops-eyebrow text-[10px] mb-1" style={{ letterSpacing: '0.06em' }}>
                    STRING_FLEET_ENVELOPE
                  </div>
                  <div className="mb-3 font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
                    every string vs inverter-wide P10,P90 band · outliers below = degraded modules / shading;
                    above = wiring or sensor issue
                  </div>
                  <StringFleetEnvelope plantId={plantId} inverterId={inverterId} mppts={mpptData} />
                </div>
                <div>
                  <div className="mb-3 font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
                    click an MPPT to drill into string-level data
                  </div>
                  <MpptOverviewGrid mppts={mpptData} plantId={plantId} inverterId={inverterId} />
                </div>
              </div>
            ) : (
              <div
                className="py-4 font-mono text-[11px] italic"
                style={{ color: 'var(--ops-muted)' }}
              >
                no MPPT snapshot data available for this inverter
              </div>
            )}
          </div>
        )}
      </div>

      {/* Loss-disaggregation donut removed: on real (DB) data every slice was 0
          (the twin only yields total loss), and on the demo fixtures the split
          was hardcoded synthetic constants — a placeholder either way. A genuine
          per-inverter breakdown (soiling / thermal / shading / equipment) needs
          the offline nuravolt/digitaltwin/loss_disaggregator.py run over the
          bronze per-string SCADA + trained pkls, materialised to the DB like the
          twins; that's a dedicated follow-up, not a fabricated ring. */}

      {/* Detailed Metrics, from actual twin + fleet data */}
      <OpsPanel label="Detailed metrics · twin + fleet">
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="ops-eyebrow text-[10px] mb-2" style={{ letterSpacing: '0.06em' }}>Digital twin · inverter performance</h3>
            <OpsMetricRows
              rows={[
                ['Avg predicted power', `${data.twinMetrics?.avgPredicted?.toFixed(2) ?? ','} kW`],
                ['Avg actual power', `${data.twinMetrics?.avgActual?.toFixed(2) ?? ','} kW`],
                ['Avg residual', `${data.twinMetrics?.avgResidual?.toFixed(2) ?? ','} kW`],
                ['Total loss', `${data.twinMetrics?.lossPct?.toFixed(2) ?? ','}%`],
                ['Data coverage', `${data.twinMetrics?.daysWithData ?? ','} days`],
              ]}
            />
          </div>
          <div>
            <h3 className="ops-eyebrow text-[10px] mb-2" style={{ letterSpacing: '0.06em' }}>
              FLEET_COMPARISON
            </h3>
            <OpsMetricRows
              rows={[
                ['Rank', `${data.fleetComparison.rank || ','} / ${data.fleetStats?.totalInverters ?? ','}`],
                [
                  'Deviation from mean',
                  `${data.fleetComparison.deviationFromMean_pct > 0 ? '+' : ''}${data.fleetComparison.deviationFromMean_pct?.toFixed(2) ?? ','}%`,
                ],
                [<Abbr key="z" term="z-score">Z-score</Abbr>, data.fleetComparison.zScore?.toFixed(2) ?? ','],
                ['Fleet mean loss', `${data.fleetStats?.meanLossPct?.toFixed(2) ?? ','}%`],
                ['Analysis period', `${data.metadata.analysisStart} → ${data.metadata.analysisEnd}`],
              ]}
            />
          </div>
        </div>
      </OpsPanel>
      </div>
    </div>
    </OpsShell>
  );
}

function OpsMetricRows({ rows }: { rows: Array<[ReactNode, string]> }) {
  return (
    <div className="space-y-1 font-mono text-[11.5px]">
      {rows.map(([label, value], i) => (
        <div
          key={`${label}-${i}`}
          className="flex items-baseline justify-between border-b py-1 last:border-0"
          style={{ borderColor: 'var(--ops-row-hair)' }}
        >
          <span style={{ color: 'var(--ops-muted)' }}>{label}</span>
          <span className="ops-num text-right" style={{ color: 'var(--ops-txt)' }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Route entry. The PV-only guard lives here, in a component with no other
 * hooks, so the inner page can call its hooks unconditionally.
 */
export default function InverterDetailPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const prefix = usePlantRoutePrefix();
  const { plants } = useDemoPlants();
  const currentPlant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const assetType = currentPlant?.asset_type;

  // Inverter drill-down is PV-only. BESS and wind plants reach this URL only
  // by typing it, show a soft empty state with a back link rather than
  // running the PV data-fetch pipeline against a missing inverter.
  if (assetType && assetType !== 'PV' && assetType !== 'SOLAR') {
    const Icon = assetType === 'BESS' ? Battery : Wind;
    const assetLabel = assetType === 'BESS' ? 'battery storage' : 'wind';
    return (
      <div className="max-w-2xl mx-auto py-12">
        <div className="bg-white rounded-xl shadow-sm border border-divider p-8 text-center">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4 ${
            assetType === 'BESS' ? 'bg-violet-50' : 'bg-cyan-50'
          }`}>
            <Icon className={`w-7 h-7 ${assetType === 'BESS' ? 'text-violet-600' : 'text-cyan-600'}`} />
          </div>
          <h2 className="text-xl font-semibold text-ink mb-2">
            Inverter view is not applicable here
          </h2>
          <p className="text-ink-2 max-w-md mx-auto mb-6">
            {currentPlant?.name} is a {assetLabel} plant. PV-style inverter
            drill-down doesn&apos;t apply, head back to the plant overview for
            the {assetType === 'BESS' ? 'warranty, cycling and dispatch' : 'turbine'} dashboard.
          </p>
          <Link
            href={`${prefix}/plant/${plantId}`}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {currentPlant?.name ?? 'plant'}
          </Link>
        </div>
      </div>
    );
  }

  return <InverterDetailPageInner />;
}
