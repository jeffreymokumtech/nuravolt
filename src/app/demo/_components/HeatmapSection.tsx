'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import MultiSelect from '@/components/ui/MultiSelect';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

// Dynamically import ECharts to avoid SSR issues
const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface InverterData {
  inverterId: string;
  groupId: string;
  powerLoss: number;
  powerLoss_digitaltwin?: number;
  performanceRatio?: number;
  soilingRatio: {
    mean: number;
    std: number;
  };
  fleetComparison: {
    severity: string;
    zScore: number;
  };
}

interface FleetSummary {
  plantInfo: {
    totalInverters: number;
    inverterGroups: string[];
  };
  fleetSoiling: {
    srMean: number;
    srStd: number;
  };
}

interface TimelineData {
  dates: string[];
  inverters: string[];
  data: (number | null)[][];
  metadata: {
    aggregation: string;
    total_inverters: number;
    total_dates: number;
    date_range?: {
      start: string;
      end: string;
    };
  };
}

export default function HeatmapSection() {
  const router = useRouter();
  const params = useParams();
  const plantId = params.plantId as string || 'alpha1';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fleetData, setFleetData] = useState<FleetSummary | null>(null);
  const [inverterData, setInverterData] = useState<InverterData[]>([]);
  const [useDigitalTwin, setUseDigitalTwin] = useState(false);
  const [timelineData, setTimelineData] = useState<{ daily: TimelineData; weekly: TimelineData } | null>(null);
  const [prTimelineData, setPrTimelineData] = useState<{ daily: TimelineData; weekly: TimelineData } | null>(null);
  const [timelineAggregation, setTimelineAggregation] = useState<'daily' | 'weekly'>('daily');
  const [powerLossView, setPowerLossView] = useState<'loss' | 'pr'>('loss');
  const [aggregationMode, setAggregationMode] = useState<'mean' | 'max' | 'median'>('mean');
  const [trainingTimesData, setTrainingTimesData] = useState<{ daily: TimelineData; weekly: TimelineData } | null>(null);
  const [trainingPeriod, setTrainingPeriod] = useState<{ start: string; end: string } | null>(null);

  // Heatmap filter states
  const [lossThreshold, setLossThreshold] = useState<number>(0); // Show cells with loss >= threshold
  const [showAnomaliesOnly, setShowAnomaliesOnly] = useState<boolean>(false); // Quick filter for >5%
  const [hideNormal, setHideNormal] = useState<boolean>(false); // Hide cells with loss <2%
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]); // Empty = all groups
  const [partialFailures, setPartialFailures] = useState<string[]>([]);
  const { groups: plantGroups, equipmentToGroup } = usePlantGroups(plantId);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  // Defer the heavy data load (timeline heatmap JSON is multi-MB) until the
  // section actually scrolls into view, so the faults page is interactive
  // before the heatmap starts downloading.
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || inView) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { rootMargin: '400px' }, // start loading shortly before it's visible
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [inView]);

  // Load data once visible.
  useEffect(() => {
    if (!inView) return;
    const loadData = async () => {
      try {
        const [fleetRes, invertersRes, timelineRes, prTimelineRes, trainingTimesRes] = await Promise.all([
          fetch(`${dataRoot}/soiling/${plantId}/fleet_summary.json`),
          fetch(`${dataRoot}/soiling/${plantId}/all_inverters.json`),
          fetch(`${dataRoot}/digitaltwin/${plantId}/timeline_heatmap_data.json`),
          fetch(`${dataRoot}/digitaltwin/${plantId}/pr_timeline_heatmap.json`),
          fetch(`${dataRoot}/digitaltwin/${plantId}/training_times_heatmap.json`),
        ]);

        if (!fleetRes.ok || !invertersRes.ok) {
          throw new Error('Failed to fetch data');
        }

        const fleet = await fleetRes.json();
        const allInverters = await invertersRes.json();

        setFleetData(fleet);
        setInverterData(allInverters.inverters || []);

        // Optional datasets, track failures explicitly so the UI can show
        // a banner instead of silently rendering a partial heatmap.
        const failures: string[] = [];

        if (timelineRes.ok) {
          setTimelineData(await timelineRes.json());
        } else {
          failures.push('power-loss timeline');
        }

        if (prTimelineRes.ok) {
          setPrTimelineData(await prTimelineRes.json());
        } else {
          failures.push('performance-ratio timeline');
        }

        if (trainingTimesRes.ok) {
          const trainingTimes = await trainingTimesRes.json();
          setTrainingTimesData(trainingTimes);
          if (trainingTimes.trainingPeriod) {
            setTrainingPeriod({
              start: trainingTimes.trainingPeriod.start || '2020-10-01',
              end: trainingTimes.trainingPeriod.end || '2022-09-30'
            });
          }
        } else {
          failures.push('training-times overlay');
        }

        setPartialFailures(failures);
        setLoading(false);
      } catch (err) {
        console.error('Error loading data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load data');
        setLoading(false);
      }
    };

    loadData();
  }, [plantId, inView, dataRoot]);

  // Digital twin stats
  const digitalTwinCount = inverterData.filter((inv) => inv.powerLoss_digitaltwin !== undefined).length;
  const hasDigitalTwinData = digitalTwinCount > 0;
  const digitalTwinPercent = inverterData.length > 0 ? Math.round((digitalTwinCount / inverterData.length) * 100) : 0;

  // Adaptive date label formatting
  const formatDateLabels = (
    dates: string[],
    start: number,
    end: number,
    aggregation: 'daily' | 'weekly'
  ) => {
    const visibleCount = Math.ceil((dates.length * (end - start)) / 100);

    return dates.map((date, i) => {
      const d = new Date(date);

      if (visibleCount > 365) {
        return i === 0 || (d.getMonth() === 0 && d.getDate() === 1)
          ? d.getFullYear().toString()
          : '';
      }

      if (visibleCount > 90) {
        return d.getDate() === 1 || i === 0
          ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
          : '';
      }

      if (visibleCount > 30) {
        return i % 7 === 0
          ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
      }

      return i % 3 === 0 ? date : '';
    });
  };

  // Timeline heatmap chart options
  const timelineChartOptions = useMemo(() => {
    const sourceData = powerLossView === 'pr' ? prTimelineData : timelineData;
    if (!sourceData) return {};

    const currentData = timelineAggregation === 'daily' ? sourceData.daily : sourceData.weekly;
    const { dates, inverters, data } = currentData;

    // Calculate effective threshold (showAnomaliesOnly overrides lossThreshold)
    const effectiveThreshold = showAnomaliesOnly ? 5 : lossThreshold;
    const effectiveHideNormal = hideNormal || showAnomaliesOnly;

    // Build filtered heatmap data
    const heatmapData: [number, number, number][] = [];
    let filteredCount = 0;
    let totalCount = 0;

    for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
      // Safety check: ensure data exists for this date
      if (!data[dateIdx]) continue;

      for (let invIdx = 0; invIdx < inverters.length; invIdx++) {
        const value = data[dateIdx][invIdx];
        if (value === null) continue;

        totalCount++;
        const invId = inverters[invIdx];

        // Apply group filter (if any groups selected)
        if (selectedGroups.length > 0) {
          const groupMapping = equipmentToGroup.get(invId);
          const groupKey = groupMapping ? groupMapping.groupName : invId.split('.')[0];
          if (!selectedGroups.includes(groupKey)) continue;
        }

        // Apply loss threshold filter (only for loss view, not PR)
        // Note: Only filter POSITIVE loss values - always show negative values (gains/overperformance)
        if (powerLossView === 'loss') {
          if (value >= 0 && value < effectiveThreshold) {
            filteredCount++;
            continue;
          }
          if (effectiveHideNormal && value >= 0 && value < 2) {
            filteredCount++;
            continue;
          }
        }

        heatmapData.push([dateIdx, invIdx, value]);
      }
    }

    const dateLabels = formatDateLabels(dates, 90, 100, timelineAggregation);

    const metricLabel = powerLossView === 'pr' ? 'PR' : 'Loss';
    const getColor = (value: number) => {
      if (powerLossView === 'pr') {
        return value > 85 ? '#22c55e' : value > 75 ? '#eab308' : value > 65 ? '#f97316' : '#ef4444';
      } else {
        // Blue for gain (negative loss), then green/yellow/orange/red for increasing loss
        return value < 0 ? '#3b82f6' : value > 20 ? '#ef4444' : value > 15 ? '#f97316' : value > 10 ? '#eab308' : '#22c55e';
      }
    };

    return {
      tooltip: {
        position: 'top',
        formatter: (params: any) => {
          if (!params.value || !Array.isArray(params.value)) return '';
          const [dateIdx, invIdx, value] = params.value;
          const date = dates[dateIdx];
          const invId = inverters[invIdx];

          const formulaNote = powerLossView === 'pr'
            ? '<div style="color: #64748b; font-size: 9px; margin-top: 2px; font-style: italic;">PR = (Power × 1000) / Irradiance</div>'
            : '';

          // Show "Gain" for negative values (outperforming), "Loss" for positive
          const displayLabel = powerLossView === 'pr' ? metricLabel : (value < 0 ? 'Gain' : 'Loss');
          const displayValue = powerLossView === 'pr' ? value.toFixed(1) : Math.abs(value).toFixed(1);
          const gainNote = value < 0 && powerLossView !== 'pr'
            ? '<div style="color: #3b82f6; font-size: 9px; margin-top: 2px; font-style: italic;">Outperforming expected</div>'
            : '';

          return `
            <div style="font-family: monospace;">
              <div style="font-weight: bold; margin-bottom: 4px;">${invId}</div>
              <div style="color: #6b7280;">${date}</div>
              <div style="color: ${getColor(value)}; font-weight: bold; margin-top: 4px;">
                ${displayLabel}: ${displayValue}%
              </div>
              ${gainNote}
              ${formulaNote}
              <div style="color: #64748b; font-size: 10px; margin-top: 2px;">
                Aggregation: ${aggregationMode}
              </div>
            </div>
          `;
        },
      },
      grid: {
        left: 100,
        right: 50,
        top: 30,
        bottom: 80,
      },
      xAxis: {
        type: 'category',
        data: dateLabels,
        name: timelineAggregation === 'daily' ? 'Date (Daily)' : 'Week Start (Weekly)',
        nameLocation: 'middle',
        nameGap: 50,
        axisLabel: {
          color: '#6b7280',
          rotate: 45,
          interval: 'auto',
        },
        splitArea: { show: true },
      },
      yAxis: {
        type: 'category',
        data: inverters,
        name: 'Inverter',
        axisLabel: {
          color: '#6b7280',
          fontSize: 9,
        },
        splitArea: { show: true },
      },
      visualMap: {
        type: 'piecewise',
        min: 0,
        max: 100,
        orient: 'vertical',
        right: 10,
        top: 'center',
        textStyle: { color: '#6b7280' },
        pieces: powerLossView === 'pr' ? [
          { min: 85, max: 100, color: '#22c55e', label: '>85%' },
          { min: 75, max: 85, color: '#eab308', label: '75-85%' },
          { min: 65, max: 75, color: '#f97316', label: '65-75%' },
          { min: 0, max: 65, color: '#ef4444', label: '<65%' },
        ] : [
          { min: -100, max: 0, color: '#3b82f6', label: 'Gain (>0)' },  // Blue for overperformance
          { min: 0, max: 10, color: '#22c55e', label: '0-10%' },
          { min: 10, max: 15, color: '#eab308', label: '10-15%' },
          { min: 15, max: 20, color: '#f97316', label: '15-20%' },
          { min: 20, max: 100, color: '#ef4444', label: '20%+' },
        ],
      },
      series: [
        {
          name: powerLossView === 'pr' ? 'Performance Ratio' : 'Power Loss',
          type: 'heatmap',
          data: heatmapData,
          emphasis: {
            itemStyle: {
              borderColor: '#fff',
              borderWidth: 2,
            },
          },
        },
        {
          type: 'scatter',
          data: [],
          markArea: {
            silent: true,
            itemStyle: {
              color: 'rgba(100, 200, 255, 0.08)',
              borderColor: 'rgba(100, 200, 255, 0.3)',
              borderWidth: 2,
              borderType: 'dashed',
            },
            data: trainingPeriod ? [[
              {
                xAxis: trainingPeriod.start,
                name: 'Training Period',
              },
              {
                xAxis: trainingPeriod.end,
              },
            ]] : [],
            label: {
              show: true,
              position: 'top',
              formatter: 'Training Period',
              fontSize: 11,
              color: '#60a5fa',
              fontWeight: 'bold',
            },
          },
        },
      ],
      dataZoom: [
        {
          type: 'slider',
          xAxisIndex: 0,
          start: 90,
          end: 100,
          bottom: 10,
          textStyle: { color: '#6b7280' },
        },
        {
          type: 'inside',
          xAxisIndex: 0,
        },
        {
          type: 'slider',
          yAxisIndex: 0,
          start: 0,
          end: 100,
          right: 40,
          width: 20,
          textStyle: { color: '#6b7280' },
        },
        {
          type: 'inside',
          yAxisIndex: 0,
        },
      ],
    };
  }, [timelineData, prTimelineData, timelineAggregation, powerLossView, aggregationMode, trainingPeriod, lossThreshold, showAnomaliesOnly, hideNormal, selectedGroups]);

  // Handle timeline chart click
  const onTimelineChartClick = (params: any) => {
    if (params.componentType === 'series' && params.value && Array.isArray(params.value)) {
      const [dateIdx, invIdx] = params.value;
      const currentData = timelineAggregation === 'daily' ? timelineData!.daily : timelineData!.weekly;
      const inverterId = currentData.inverters[invIdx];
      const clickedDate = currentData.dates[dateIdx];

      router.push(`${prefix}/plant/${plantId}/inverter/${inverterId}?date=${clickedDate}&aggregation=${timelineAggregation}`);
    }
  };

  // Training Times Heatmap chart options
  const trainingTimesChartOptions = useMemo(() => {
    if (!trainingTimesData) return {};

    const sourceData = powerLossView === 'pr' ? prTimelineData : timelineData;
    if (!sourceData) return {};

    const mainData = timelineAggregation === 'daily' ? sourceData.daily : sourceData.weekly;
    const mainDates = mainData.dates;
    const mainInverters = mainData.inverters;

    const currentData = timelineAggregation === 'daily' ? trainingTimesData.daily : trainingTimesData.weekly;
    const { dates: trainingDates, inverters: trainingInverters, data: trainingData } = currentData;

    const trainingDateMap = new Map<string, number>();
    trainingDates.forEach((date, idx) => {
      trainingDateMap.set(date, idx);
    });

    const trainingInverterMap = new Map<string, number>();
    trainingInverters.forEach((inv, idx) => {
      trainingInverterMap.set(inv, idx);
    });

    const heatmapData: [number, number, number][] = [];
    let maxCount = 0;

    for (let mainDateIdx = 0; mainDateIdx < mainDates.length; mainDateIdx++) {
      const mainDate = mainDates[mainDateIdx];
      const trainingDateIdx = trainingDateMap.get(mainDate);

      if (trainingDateIdx !== undefined && trainingData[trainingDateIdx]) {
        for (let mainInvIdx = 0; mainInvIdx < mainInverters.length; mainInvIdx++) {
          const mainInv = mainInverters[mainInvIdx];
          const trainingInvIdx = trainingInverterMap.get(mainInv);

          if (trainingInvIdx !== undefined) {
            const count = trainingData[trainingDateIdx][trainingInvIdx];
            if (count !== null && count > 0) {
              heatmapData.push([mainDateIdx, mainInvIdx, count]);
              if (count > maxCount) maxCount = count;
            }
          }
        }
      }
    }

    const dateLabels = formatDateLabels(mainDates, 90, 100, timelineAggregation);

    const trainingStartDate = '2020-10-01';
    const trainingEndDate = '2022-09-30';

    const startIdx = mainDates.findIndex(d => d >= trainingStartDate);
    const endIdx = mainDates.findIndex(d => d > trainingEndDate);

    const startPercent = startIdx >= 0 ? Math.max(0, (startIdx / mainDates.length) * 100) : 0;
    const endPercent = endIdx >= 0 ? Math.min(100, (endIdx / mainDates.length) * 100) : 100;

    return {
      tooltip: {
        position: 'top',
        formatter: (params: any) => {
          if (!params.value || !Array.isArray(params.value)) return '';
          const [dateIdx, invIdx, count] = params.value;
          const date = mainDates[dateIdx];
          const invId = mainInverters[invIdx];
          return `
            <div style="font-family: monospace;">
              <div style="font-weight: bold; margin-bottom: 4px;">${invId}</div>
              <div style="color: #6b7280;">${date}</div>
              <div style="color: #22c55e; font-weight: bold; margin-top: 4px;">
                Training Samples: ${count}
              </div>
            </div>
          `;
        },
      },
      grid: {
        left: 100,
        right: 50,
        top: 30,
        bottom: 80,
      },
      xAxis: {
        type: 'category',
        data: dateLabels,
        name: timelineAggregation === 'daily' ? 'Date (Daily)' : 'Week Start (Weekly)',
        nameLocation: 'middle',
        nameGap: 50,
        axisLabel: {
          color: '#6b7280',
          rotate: 45,
          interval: 'auto',
        },
        splitArea: { show: true },
      },
      yAxis: {
        type: 'category',
        data: mainInverters,
        name: 'Inverter',
        axisLabel: {
          color: '#6b7280',
          fontSize: 9,
        },
        splitArea: { show: true },
      },
      visualMap: {
        type: 'continuous',
        min: 0,
        max: maxCount,
        orient: 'vertical',
        right: 10,
        top: 'center',
        textStyle: { color: '#6b7280' },
        inRange: {
          color: ['#f0f9ff', '#0ea5e9', '#0369a1', '#075985', '#0c4a6e']
        },
        text: [`${maxCount}`, '0'],
      },
      series: [
        {
          name: 'Training Samples',
          type: 'heatmap',
          data: heatmapData,
          emphasis: {
            itemStyle: {
              borderColor: '#fff',
              borderWidth: 2,
            },
          },
        },
      ],
      dataZoom: [
        {
          type: 'slider',
          xAxisIndex: 0,
          start: startPercent,
          end: endPercent,
          bottom: 10,
          textStyle: { color: '#6b7280' },
          borderColor: '#0ea5e9',
          fillerColor: 'rgba(14, 165, 233, 0.1)',
          handleStyle: {
            color: '#0ea5e9',
            borderColor: '#38bdf8'
          }
        },
        {
          type: 'inside',
          xAxisIndex: 0,
        },
        {
          type: 'slider',
          yAxisIndex: 0,
          start: 0,
          end: 100,
          right: 40,
          width: 20,
          textStyle: { color: '#6b7280' },
        },
        {
          type: 'inside',
          yAxisIndex: 0,
        },
      ],
    };
  }, [trainingTimesData, timelineData, prTimelineData, timelineAggregation, powerLossView]);

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'Critical':
        return 'text-signal-critical bg-signal-critical/10 border-signal-critical/20';
      case 'Major':
        return 'text-orange-700 bg-orange-100 border-orange-200';
      case 'Minor':
        return 'text-yellow-700 bg-yellow-100 border-yellow-200';
      default:
        return 'text-signal-positive bg-signal-positive/10 border-signal-positive/20';
    }
  };

  // Pre-visibility / loading state, the ref must be attached so the
  // IntersectionObserver can trigger the deferred data load.
  if (loading) {
    return (
      <div ref={rootRef} className="min-h-[600px] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto" />
          <p className="text-ink-2 mt-4">
            {inView ? 'Loading heatmap data…' : 'Heatmap loads when scrolled into view…'}
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-[600px] flex items-center justify-center">
        <div className="text-center">
          <div className="text-signal-critical text-xl mb-2">Failed to load data</div>
          <p className="text-ink-2">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Partial-failure banner, visible instead of console-only warnings */}
      {partialFailures.length > 0 && (
        <div className="rounded-xl border border-signal-warning/20 bg-signal-warning/10 px-4 py-3 text-sm text-signal-warning">
          Some heatmap layers failed to load: {partialFailures.join(', ')}. The
          rest of the view renders with available data.
        </div>
      )}

      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-divider p-6">
        <div className="flex justify-between items-center flex-wrap gap-4">
          <div>
            <h2 className="text-2xl font-bold text-ink">Fleet Heatmap</h2>
            <p className="text-ink-2 mt-1">
              Power loss distribution across all {inverterData.length} inverters
            </p>
          </div>

          {/* Controls */}
          <div className="flex gap-3 items-center flex-wrap">
            {/* Digital Twin Status */}
            <div className="flex items-center gap-2 px-3 py-2 bg-paper border border-divider rounded-lg">
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${hasDigitalTwinData ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
                <span className="text-xs text-ink-2">Digital Twin:</span>
              </div>
              <span className={`text-sm font-mono ${hasDigitalTwinData ? 'text-signal-positive' : 'text-ink-3'}`}>
                {digitalTwinCount}/{inverterData.length}
              </span>
              {inverterData.length > 0 && (
                <div className="w-16 h-1.5 bg-divider rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${digitalTwinPercent === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                    style={{ width: `${digitalTwinPercent}%` }}
                  />
                </div>
              )}
              <span className="text-xs text-ink-3">{digitalTwinPercent}%</span>
            </div>

            {/* Digital Twin Toggle */}
            <button
              onClick={() => hasDigitalTwinData && setUseDigitalTwin(!useDigitalTwin)}
              disabled={!hasDigitalTwinData}
              className={`px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                !hasDigitalTwinData
                  ? 'bg-paper-2 text-ink-3 cursor-not-allowed border border-divider'
                  : useDigitalTwin
                    ? 'bg-blue-600 hover:bg-blue-500 text-white'
                    : 'bg-white hover:bg-gray-50 text-ink-2 border border-gray-300'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${
                !hasDigitalTwinData ? 'bg-gray-400' : useDigitalTwin ? 'bg-emerald-400' : 'bg-gray-400'
              }`} />
              {useDigitalTwin ? 'Digital Twin' : 'IEA PVPS'}
            </button>

            {/* Power Loss / PR Toggle */}
            <div className="flex items-center gap-2 bg-white border border-divider rounded-lg overflow-hidden">
              <button
                onClick={() => setPowerLossView('loss')}
                className={`px-4 py-2 text-sm transition-colors ${
                  powerLossView === 'loss'
                    ? 'bg-blue-600 text-white'
                    : 'bg-transparent text-ink-2 hover:text-gray-900'
                }`}
              >
                Power Loss
              </button>
              <button
                onClick={() => setPowerLossView('pr')}
                className={`px-4 py-2 text-sm transition-colors ${
                  powerLossView === 'pr'
                    ? 'bg-blue-600 text-white'
                    : 'bg-transparent text-ink-2 hover:text-gray-900'
                }`}
              >
                Performance Ratio
              </button>
            </div>

            {/* Training Period Info */}
            {trainingPeriod && (
              <div className="flex items-center gap-2 text-sm text-ink-2 bg-blue-50 px-3 py-2 rounded-lg border border-blue-200">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs">
                  Blue highlighted area shows training period where digital twin models learned baseline performance
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-sm items-center bg-white rounded-lg border border-divider p-4">
        <span className="text-xs text-ink-2 font-medium">
          {useDigitalTwin ? 'Digital Twin Scale:' : 'IEA PVPS Scale:'}
        </span>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-green-500" />
          <span className="text-ink-2">0% (Low)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-yellow-500" />
          <span className="text-ink-2">50% (Medium)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-red-500" />
          <span className="text-ink-2">100% (High)</span>
        </div>
      </div>

      {/* Timeline Heatmap */}
      {(timelineData || prTimelineData) && (
        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
            <h2 className="text-xl font-semibold text-ink">Fleet Timeline Heatmap</h2>

            <div className="flex gap-4 items-center flex-wrap">
              {/* Daily/Weekly Toggle */}
              <div className="flex gap-2 items-center">
                <span className="text-xs text-ink-2 font-medium">Period:</span>
                <button
                  onClick={() => setTimelineAggregation('daily')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    timelineAggregation === 'daily'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-ink-2 hover:bg-gray-50 border border-gray-300'
                  }`}
                >
                  Daily
                </button>
                <button
                  onClick={() => setTimelineAggregation('weekly')}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    timelineAggregation === 'weekly'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-ink-2 hover:bg-gray-50 border border-gray-300'
                  }`}
                >
                  Weekly
                </button>
              </div>

              {/* Aggregation Mode Selector */}
              <div className="flex gap-2 items-center">
                <span className="text-xs text-ink-2 font-medium">Aggregation:</span>
                <button
                  onClick={() => setAggregationMode('mean')}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    aggregationMode === 'mean'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-ink-2 hover:bg-gray-50 border border-gray-300'
                  }`}
                >
                  Mean
                </button>
                <button
                  onClick={() => setAggregationMode('max')}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    aggregationMode === 'max'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-ink-2 hover:bg-gray-50 border border-gray-300'
                  }`}
                >
                  Max
                </button>
                <button
                  onClick={() => setAggregationMode('median')}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    aggregationMode === 'median'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-ink-2 hover:bg-gray-50 border border-gray-300'
                  }`}
                >
                  Median
                </button>
              </div>
            </div>
          </div>

          {/* Filter Controls Row */}
          {powerLossView === 'loss' && (
            <div className="bg-paper border border-divider rounded-lg p-3 mb-4">
              <div className="flex flex-wrap gap-4 items-center">
                {/* Anomalies Only Toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showAnomaliesOnly}
                    onChange={(e) => setShowAnomaliesOnly(e.target.checked)}
                    className="w-4 h-4 text-signal-critical rounded focus:ring-red-500"
                  />
                  <span className="text-sm font-medium text-signal-critical">Show Anomalies Only (&gt;5%)</span>
                </label>

                {/* Loss Threshold Slider */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-ink-2">Min Loss:</span>
                  <input
                    type="range"
                    min="0"
                    max="20"
                    step="1"
                    value={lossThreshold}
                    onChange={(e) => setLossThreshold(Number(e.target.value))}
                    className="w-24 h-2 bg-divider rounded-lg appearance-none cursor-pointer"
                    disabled={showAnomaliesOnly}
                  />
                  <span className="text-sm font-mono text-ink-2 w-10">{lossThreshold}%</span>
                </div>

                {/* Hide Normal Toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hideNormal}
                    onChange={(e) => setHideNormal(e.target.checked)}
                    className="w-4 h-4 text-ink-2 rounded focus:ring-gray-500"
                    disabled={showAnomaliesOnly}
                  />
                  <span className="text-sm text-ink-2">Hide Normal (&lt;2%)</span>
                </label>

                {/* Inverter Group Filter */}
                <div className="w-48">
                  <MultiSelect
                    options={plantGroups.length > 0
                      ? plantGroups.map(g => g.name)
                      : ['PV-01', 'PV-02', 'PV-03', 'PV-04', 'PV-05']}
                    selected={selectedGroups}
                    onChange={setSelectedGroups}
                    placeholder="All Groups"
                    label="Groups"
                    maxDisplay={2}
                    searchable={false}
                  />
                </div>

                {/* Reset All Filters */}
                {(showAnomaliesOnly || lossThreshold > 0 || hideNormal || selectedGroups.length > 0) && (
                  <button
                    onClick={() => {
                      setShowAnomaliesOnly(false);
                      setLossThreshold(0);
                      setHideNormal(false);
                      setSelectedGroups([]);
                    }}
                    className="text-xs text-ink-3 hover:text-gray-700 underline"
                  >
                    Reset Filters
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="text-sm text-ink-2 mb-4">
            {(() => {
              const sourceData = powerLossView === 'pr' ? prTimelineData : timelineData;
              if (!sourceData) return null;
              const currentData = timelineAggregation === 'daily' ? sourceData.daily : sourceData.weekly;
              return (
                <>
                  Showing {currentData.metadata.total_dates} {timelineAggregation} periods
                  from {currentData.metadata.date_range?.start}
                  {' to '}
                  {currentData.metadata.date_range?.end}
                  {powerLossView === 'pr' && (
                    <span className="block mt-1 text-xs italic text-ink-3">
                      Performance Ratio calculated as: PR = (Normalized_Power_kW/kWp × 1000) / Irradiance_W/m²
                    </span>
                  )}
                </>
              );
            })()}
          </div>

          <ReactECharts
            option={timelineChartOptions}
            style={{ height: '700px', width: '100%' }}
            onEvents={{
              click: onTimelineChartClick,
            }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            lazyUpdate={false}
          />

          <div className="text-xs text-ink-3 text-center mt-2">
            Click on any cell to view inverter details. Use sliders or mouse wheel to zoom timeline and inverter list.
          </div>
        </div>
      )}

      {/* Training Times Heatmap */}
      {trainingTimesData && (
        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <h2 className="text-xl font-semibold text-ink mb-4">Digital Twin Training Times</h2>

          <div className="text-sm text-ink-2 mb-4">
            <p className="mb-2">
              Showing when digital twin models were trained across the entire plant and timeline.
              Brighter colors indicate more training samples collected during that period.
            </p>
            <p className="text-xs text-sky-700 bg-sky-50 border border-sky-200 rounded px-3 py-2 inline-block">
              ⓘ Training data period: Oct 2020 - Sep 2022 (zoomed by default). Scroll or drag the slider to view the full timeline.
            </p>
          </div>

          <ReactECharts
            option={trainingTimesChartOptions}
            style={{ height: '700px', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            lazyUpdate={false}
          />

          <div className="text-xs text-ink-3 text-center mt-2">
            Heatmap shows training sample counts for each inverter over time. Use the period toggle above to switch between daily and weekly views.
          </div>
        </div>
      )}

      {/* Summary Stats */}
      {fleetData && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-paper border border-divider rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-signal-positive">
              {inverterData.filter((d) => d.fleetComparison.severity === 'Normal').length}
            </div>
            <div className="text-xs text-ink-2 mt-1">Normal</div>
          </div>
          <div className="bg-paper border border-divider rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-signal-warning">
              {inverterData.filter((d) => d.fleetComparison.severity === 'Minor').length}
            </div>
            <div className="text-xs text-ink-2 mt-1">Minor Issues</div>
          </div>
          <div className="bg-paper border border-divider rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-orange-600">
              {inverterData.filter((d) => d.fleetComparison.severity === 'Major').length}
            </div>
            <div className="text-xs text-ink-2 mt-1">Major Issues</div>
          </div>
          <div className="bg-paper border border-divider rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-signal-critical">
              {inverterData.filter((d) => d.fleetComparison.severity === 'Critical').length}
            </div>
            <div className="text-xs text-ink-2 mt-1">Critical</div>
          </div>
        </div>
      )}
    </div>
  );
}
