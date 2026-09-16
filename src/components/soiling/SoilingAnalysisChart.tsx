/**
 * SoilingAnalysisChart - Combined visualization of rain, soiling ratio, and soiling rate
 *
 * Features:
 * - Top subplot: Rain bars (precipitation events)
 * - Main chart: Dual Y-axis with Soiling Ratio (left) and Soiling Rate (right)
 * - Rain event highlighting (vertical bands on heavy rain days)
 * - Label markers for user annotations
 * - Interactive zoom, pan, and tooltips
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
  Brush,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { Droplets, Wind, Wrench, AlertTriangle, FileText, TrendingUp, TrendingDown, Info, Calendar } from 'lucide-react';
import type {
  RainDataPoint,
  DataLabel,
  MonthlySoilingRate,
} from '@/types/soiling';

// Label type configuration with colors and icons
const LABEL_COLORS: Record<string, { color: string; Icon: any; label: string }> = {
  rain_cleaning: { color: '#3B82F6', Icon: Droplets, label: 'Rain Cleaning' },
  dust_event: { color: '#92400E', Icon: Wind, label: 'Dust Event' },
  manual_cleaning: { color: '#10B981', Icon: Wrench, label: 'Manual Cleaning' },
  anomaly: { color: '#EF4444', Icon: AlertTriangle, label: 'Anomaly' },
  other: { color: '#6B7280', Icon: FileText, label: 'Other' },
};

interface SoilingDataPoint {
  date: string;
  soiling_ratio?: number;
  soiling_rate?: number; // %/day
}

interface ChartDataPoint {
  date: string;
  dateFormatted: string;
  precipitation_mm: number;
  is_cleaning_event: boolean;
  is_heavy_rain: boolean;
  soiling_ratio?: number;
  soiling_rate?: number;
  label?: DataLabel;
  hasLabel: boolean;
}

interface SoilingAnalysisChartProps {
  rainData: RainDataPoint[];
  soilingData?: SoilingDataPoint[];
  monthlySoilingRates?: MonthlySoilingRate[];
  labels: DataLabel[];
  onDateClick?: (date: string, event: React.MouseEvent) => void;
  onLabelClick?: (label: DataLabel) => void;
  height?: number;
  showBrush?: boolean;
  dateRange?: { start: string; end: string };
}

export function SoilingAnalysisChart({
  rainData,
  soilingData = [],
  monthlySoilingRates = [],
  labels,
  onDateClick,
  onLabelClick,
  height = 500,
  showBrush = true,
  dateRange,
}: SoilingAnalysisChartProps) {
  const [showRainBars, setShowRainBars] = useState(true);
  const [showSoilingRatio, setShowSoilingRatio] = useState(true);
  const [showSoilingRate, setShowSoilingRate] = useState(true);
  const [showLabels, setShowLabels] = useState(true);

  // Create label lookup map
  const labelMap = useMemo(() => {
    const map = new Map<string, DataLabel>();
    labels.forEach(label => map.set(label.date, label));
    return map;
  }, [labels]);

  // Create soiling data lookup map
  const soilingMap = useMemo(() => {
    const map = new Map<string, SoilingDataPoint>();
    soilingData.forEach(d => map.set(d.date, d));
    return map;
  }, [soilingData]);

  // Generate soiling rate from monthly rates if not provided directly
  const getSoilingRateForDate = useCallback((dateStr: string): number | undefined => {
    if (monthlySoilingRates.length === 0) return undefined;

    const date = parseISO(dateStr);
    // Format to YYYY-MM to match MonthlySoilingRate month format
    const monthStr = format(date, 'yyyy-MM');

    const monthRate = monthlySoilingRates.find(r => r.month === monthStr);
    return monthRate ? monthRate.soiling_rate_per_day * 100 : undefined; // Convert to %
  }, [monthlySoilingRates]);

  // Combine rain data with soiling data and labels
  const chartData: ChartDataPoint[] = useMemo(() => {
    let filteredRainData = rainData;

    // Apply date range filter if provided
    if (dateRange) {
      filteredRainData = rainData.filter(
        d => d.date >= dateRange.start && d.date <= dateRange.end
      );
    }

    return filteredRainData.map(rain => {
      const soiling = soilingMap.get(rain.date);
      const label = labelMap.get(rain.date);
      const rateFromMonthly = getSoilingRateForDate(rain.date);

      return {
        date: rain.date,
        dateFormatted: format(parseISO(rain.date), 'MMM d, yyyy'),
        precipitation_mm: rain.precipitation_mm,
        is_cleaning_event: rain.is_cleaning_event,
        is_heavy_rain: rain.is_heavy_rain,
        soiling_ratio: soiling?.soiling_ratio,
        soiling_rate: soiling?.soiling_rate ?? rateFromMonthly,
        label,
        hasLabel: !!label,
      };
    });
  }, [rainData, soilingMap, labelMap, dateRange, getSoilingRateForDate]);

  // Find heavy rain events for reference areas
  const heavyRainEvents = useMemo(() => {
    return chartData.filter(d => d.is_heavy_rain);
  }, [chartData]);

  // Calculate y-axis domains
  const maxRain = useMemo(() => {
    const max = Math.max(...chartData.map(d => d.precipitation_mm), 0);
    return Math.ceil(max / 10) * 10 + 10; // Round up to nearest 10 + buffer
  }, [chartData]);

  const srDomain = useMemo(() => {
    const values = chartData
      .filter(d => d.soiling_ratio !== undefined)
      .map(d => d.soiling_ratio as number);
    if (values.length === 0) return [0.7, 1.0];
    const min = Math.min(...values);
    const max = Math.max(...values);
    return [Math.floor(min * 10) / 10 - 0.05, Math.min(1.0, Math.ceil(max * 10) / 10)];
  }, [chartData]);

  const rateDomain = useMemo(() => {
    const values = chartData
      .filter(d => d.soiling_rate !== undefined)
      .map(d => d.soiling_rate as number);
    if (values.length === 0) return [0, 0.5];
    const max = Math.max(...values);
    return [0, Math.ceil(max * 10) / 10 + 0.1];
  }, [chartData]);

  // Custom tooltip component
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;

    const data = payload[0]?.payload as ChartDataPoint;
    if (!data) return null;

    return (
      <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-xl">
        <p className="font-black text-gray-900 mb-3 border-b border-gray-100 pb-2">{data.dateFormatted}</p>

        <div className="space-y-2 text-xs font-bold uppercase tracking-tight">
          {data.precipitation_mm > 0 && (
            <p className="text-blue-600 flex items-center gap-2">
              <Droplets className="w-3.5 h-3.5" />
              <span>
                Rain: {data.precipitation_mm.toFixed(1)}mm
                {data.is_heavy_rain && ' (Heavy)'}
                {data.is_cleaning_event && !data.is_heavy_rain && ' (Cleaning)'}
              </span>
            </p>
          )}

          {data.soiling_ratio !== undefined && (
            <p className="text-emerald-600 flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Soiling Ratio: <span className="text-gray-900">{(data.soiling_ratio * 100).toFixed(1)}%</span></span>
            </p>
          )}

          {data.soiling_rate !== undefined && (
            <p className="text-orange-600 flex items-center gap-2">
              <TrendingDown className="w-3.5 h-3.5" />
              <span>Soiling Rate: <span className="text-gray-900">{data.soiling_rate.toFixed(2)}%/day</span></span>
            </p>
          )}

          {data.label && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <p 
                className="flex items-center gap-2 font-black"
                style={{ color: LABEL_COLORS[data.label.type]?.color || '#6B7280' }}
              >
                {(() => {
                  const LabelIcon = LABEL_COLORS[data.label.type]?.Icon;
                  return LabelIcon ? <LabelIcon className="w-3.5 h-3.5" /> : null;
                })()}
                {data.label.label}
              </p>
              {data.label.notes && (
                <p className="text-gray-400 font-medium normal-case mt-1.5 leading-relaxed bg-gray-50 p-2 rounded-lg border border-gray-100 italic">
                  &ldquo;{data.label.notes}&rdquo;
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Handle chart click for adding labels
  const handleChartClick = useCallback((e: any) => {
    if (!onDateClick || !e?.activePayload?.[0]?.payload) return;
    const data = e.activePayload[0].payload as ChartDataPoint;

    // If clicking on an existing label, trigger label click instead
    if (data.label && onLabelClick) {
      onLabelClick(data.label);
      return;
    }

    onDateClick(data.date, e);
  }, [onDateClick, onLabelClick]);

  // Statistics summary
  const stats = useMemo(() => {
    const rainDays = chartData.filter(d => d.precipitation_mm > 0).length;
    const cleaningEvents = chartData.filter(d => d.is_cleaning_event).length;
    const heavyRainDays = chartData.filter(d => d.is_heavy_rain).length;
    const totalPrecip = chartData.reduce((sum, d) => sum + d.precipitation_mm, 0);
    const labelCount = labels.length;

    return { rainDays, cleaningEvents, heavyRainDays, totalPrecip, labelCount };
  }, [chartData, labels]);

  return (
    <div className="bg-white rounded-2xl p-6 border border-gray-200">
      {/* Header with toggles */}
      <div className="flex flex-wrap items-center justify-between gap-6 mb-8">
        <div>
          <h3 className="text-lg font-black text-gray-900 tracking-tight">
            SR Performance & Weather Events
          </h3>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mt-1">Correlation of precipitation and soiling recovery</p>
        </div>

        <div className="flex flex-wrap gap-4 p-1.5 bg-gray-50 rounded-xl border border-gray-100">
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white transition-all cursor-pointer">
            <input
              type="checkbox"
              checked={showRainBars}
              onChange={(e) => setShowRainBars(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest">Rain</span>
          </label>

          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white transition-all cursor-pointer">
            <input
              type="checkbox"
              checked={showSoilingRatio}
              onChange={(e) => setShowSoilingRatio(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Ratio</span>
          </label>

          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white transition-all cursor-pointer">
            <input
              type="checkbox"
              checked={showSoilingRate}
              onChange={(e) => setShowSoilingRate(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
            />
            <span className="text-[10px] font-black text-orange-600 uppercase tracking-widest">Rate</span>
          </label>

          <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white transition-all cursor-pointer">
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(e) => setShowLabels(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            <span className="text-[10px] font-black text-purple-600 uppercase tracking-widest">Labels ({labels.length})</span>
          </label>
        </div>
      </div>

      {/* Main chart */}
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart
            data={chartData}
            margin={{ top: 20, right: 60, left: 20, bottom: 20 }}
            onClick={handleChartClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />

            {/* X-Axis */}
            <XAxis
              dataKey="date"
              tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: '700' }}
              tickFormatter={(value) => format(parseISO(value), 'MMM yyyy')}
              interval="preserveStartEnd"
              axisLine={{ stroke: '#E2E8F0' }}
            />

            {/* Left Y-Axis: Soiling Ratio */}
            <YAxis
              yAxisId="left"
              domain={srDomain}
              tick={{ fill: '#10B981', fontSize: 10, fontWeight: '700' }}
              tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
              axisLine={false}
              tickLine={false}
              label={{
                value: 'Soiling Ratio (%)',
                angle: -90,
                position: 'insideLeft',
                fill: '#10B981',
                fontSize: 10,
                fontWeight: '900',
                textAnchor: 'middle',
                offset: -10,
              }}
            />

            {/* Right Y-Axis: Rain + Soiling Rate */}
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[0, Math.max(maxRain, rateDomain[1] * 100)]}
              tick={{ fill: '#3B82F6', fontSize: 10, fontWeight: '700' }}
              tickFormatter={(value) => `${value}`}
              axisLine={false}
              tickLine={false}
              label={{
                value: 'Rain (mm) / Rate (%/day×100)',
                angle: 90,
                position: 'insideRight',
                fill: '#64748b',
                fontSize: 10,
                fontWeight: '900',
                textAnchor: 'middle',
                offset: 10,
              }}
            />

            <Tooltip content={<CustomTooltip />} />

            <Legend
              verticalAlign="top"
              align="right"
              height={36}
              iconType="circle"
              iconSize={8}
              formatter={(value) => <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{value}</span>}
            />

            {/* Heavy rain reference areas (light blue background) */}
            {heavyRainEvents.map((event, idx) => (
              <ReferenceArea
                key={`heavy-rain-${idx}`}
                x1={event.date}
                x2={event.date}
                yAxisId="left"
                fill="#3B82F6"
                fillOpacity={0.05}
                stroke="#3B82F6"
                strokeOpacity={0.1}
              />
            ))}

            {/* Rain bars */}
            {showRainBars && (
              <Bar
                yAxisId="right"
                dataKey="precipitation_mm"
                name="Precipitation"
                fill="#3B82F6"
                opacity={0.6}
                maxBarSize={12}
                radius={[4, 4, 0, 0]}
              />
            )}

            {/* Soiling Ratio line */}
            {showSoilingRatio && (
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="soiling_ratio"
                name="Soiling Ratio"
                stroke="#10B981"
                strokeWidth={3}
                dot={false}
                connectNulls
                animationDuration={1500}
              />
            )}

            {/* Soiling Rate line */}
            {showSoilingRate && (
              <Line
                yAxisId="right"
                type="stepAfter"
                dataKey={(d: ChartDataPoint) =>
                  d.soiling_rate !== undefined ? d.soiling_rate * 100 : undefined
                }
                name="Soiling Rate"
                stroke="#F59E0B"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                connectNulls
              />
            )}

            {/* Label markers */}
            {showLabels && labels.map((label) => (
              <ReferenceLine
                key={label.id}
                x={label.date}
                yAxisId="left"
                stroke={LABEL_COLORS[label.type]?.color || '#6B7280'}
                strokeWidth={2}
                strokeDasharray="4 4"
                label={{
                  value: LABEL_COLORS[label.type]?.label || 'Label',
                  position: 'top',
                  fill: LABEL_COLORS[label.type]?.color || '#6B7280',
                  fontSize: 9,
                  fontWeight: '900',
                  textAnchor: 'middle',
                }}
              />
            ))}

            {/* Brush for zooming */}
            {showBrush && chartData.length > 60 && (
              <Brush
                dataKey="date"
                height={30}
                stroke="#E2E8F0"
                fill="#F8FAFC"
                tickFormatter={(value) => format(parseISO(value), 'MMM yy')}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend for label types */}
      {showLabels && labels.length > 0 && (
        <div className="mt-8 pt-6 border-t border-gray-100">
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-4">Annotated Label Types</p>
          <div className="flex flex-wrap gap-6">
            {Object.entries(LABEL_COLORS).map(([type, config]) => {
              const count = labels.filter(l => l.type === type).length;
              if (count === 0) return null;
              const Icon = config.Icon;
              return (
                <div
                  key={type}
                  className="flex items-center gap-2.5 group"
                >
                  <div className="p-1.5 rounded-lg bg-gray-50 group-hover:shadow-sm transition-all" style={{ color: config.color }}>
                    <Icon className="w-4 h-4" /> 
                  </div>
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-gray-900">{config.label}</span>
                    <span className="text-[10px] font-bold text-gray-400">{count} events</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Click hint */}
      {onDateClick && (
        <div className="mt-6 flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-300">
          <Info className="w-3.5 h-3.5" />
          <span>Click on chart timeline to add custom data labels</span>
        </div>
      )}
    </div>
  );
}

export default SoilingAnalysisChart;