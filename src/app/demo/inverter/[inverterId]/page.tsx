'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';

// Dynamically import ECharts to avoid SSR issues
const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface InverterMetrics {
  inverterId: string;
  groupId: string;
  soilingRatio: {
    mean: number;
    median: number;
    min: number;
    max: number;
    std: number;
  };
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
  };
  performance: {
    performanceRatio: number;
    availability_pct: number;
  };
  fleetComparison: {
    rank: number;
    deviationFromMean_pct: number;
    zScore: number;
    severity: string;
  };
  metadata: {
    analysisStart: string;
    analysisEnd: string;
  };
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

export default function InverterDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const inverterId = decodeURIComponent(params.inverterId as string);
  const clickedDate = searchParams.get('date');
  const aggregationType = searchParams.get('aggregation');
  const [data, setData] = useState<InverterMetrics | null>(null);
  const [trainingMetadata, setTrainingMetadata] = useState<TrainingMetadata | null>(null);
  const [residualsData, setResidualsData] = useState<ResidualsData[]>([]);
  const [trainingTimestamps, setTrainingTimestamps] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadInverterData = async () => {
      try {
        // Convert inverterId format: "INV 01.001" -> "INV_01_001"
        const filename = inverterId.replace(/ /g, '_').replace(/\./g, '_') + '.json';
        const res = await fetch(`/data/soiling/alpha1/inverters/${filename}`);

        if (!res.ok) {
          throw new Error('Inverter not found');
        }

        const json = await res.json();

        const inverterData: InverterMetrics = {
          inverterId: json.inverterId,
          groupId: json.groupId,
          soilingRatio: {
            mean: json.soilingRatio.mean,
            median: json.soilingRatio.median,
            min: json.soilingRatio.min,
            max: json.soilingRatio.max,
            std: json.soilingRatio.std,
          },
          lossDisaggregation: {
            percentages: {
              soiling: json.lossDisaggregation.percentages.soiling,
              temperature: json.lossDisaggregation.percentages.temperature,
              spectral: json.lossDisaggregation.percentages.spectral,
              inverter: json.lossDisaggregation.percentages.inverter,
              wiringBop: json.lossDisaggregation.percentages.wiringBop,
              degradation: json.lossDisaggregation.percentages.degradation,
              total: json.lossDisaggregation.percentages.total,
            },
          },
          performance: {
            performanceRatio: json.performance.performanceRatio,
            availability_pct: json.performance.availability_pct,
          },
          fleetComparison: {
            rank: json.fleetComparison.rank,
            deviationFromMean_pct: json.fleetComparison.deviationFromMean_pct,
            zScore: json.fleetComparison.zScore,
            severity: json.fleetComparison.severity,
          },
          metadata: {
            analysisStart: json.metadata.analysisStart,
            analysisEnd: json.metadata.analysisEnd,
          },
        };

        setData(inverterData);

        // PHASE 1.1: Parallel data fetches for improved performance
        const csvFilename = inverterId.replace(/ /g, '_').replace(/\./g, '_');

        const [trainingRes, csvRes, timestampsRes] = await Promise.all([
          fetch('/data/digitaltwin/alpha1/digital_twins.json').catch((err): null => null),
          fetch(`/data/digitaltwin/alpha1/residuals_${csvFilename}.csv`).catch((err): null => null),
          fetch(`/data/digitaltwin/alpha1/training_timestamps_${csvFilename}.csv`).catch((err): null => null)
        ]);

        // Load training metadata
        try {
          if (trainingRes && trainingRes.ok) {
            const trainingData = await trainingRes.json();
            const inverterTraining = trainingData.inverters[inverterId];
            if (inverterTraining && inverterTraining.success) {
              setTrainingMetadata({
                trainingPeriod: inverterTraining.trainingPeriod,
                metrics: inverterTraining.metrics
              });
            } else {
              // Use global training period if inverter-specific not found
              setTrainingMetadata({
                trainingPeriod: trainingData.trainingPeriod
              });
            }
          }
        } catch (err) {
          console.warn('Training metadata not available:', err);
        }

        // Load residuals CSV data
        try {
          if (csvRes && csvRes.ok) {
            const csvText = await csvRes.text();
            const lines = csvText.split('\n').slice(1); // Skip header

            // Parse CSV and filter to hourly data during daylight hours
            const parsedData: ResidualsData[] = [];

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              const [timestamp, actual, expected, residual, loss_pct] = line.split(',');

              // Only include hourly data (00:00, 01:00, etc.) to reduce data points
              const hour = timestamp.split(' ')[1];
              if (hour && hour.endsWith(':00:00')) {
                const actualNum = parseFloat(actual);
                const expectedNum = parseFloat(expected);
                const lossPct = parseFloat(loss_pct);

                // Skip nighttime data where loss is 100%
                if (!isNaN(lossPct) && lossPct < 100) {
                  parsedData.push({
                    timestamp,
                    actual: actualNum,
                    expected: expectedNum,
                    loss_pct: lossPct
                  });
                }
              }
            }

            setResidualsData(parsedData);

            // PHASE 1.3: Optimize Date operations - use first/last rows instead of min/max
            if (parsedData.length > 0) {
              const minDate = new Date(parsedData[0].timestamp);
              const maxDate = new Date(parsedData[parsedData.length - 1].timestamp);
              setDateRange({
                start: minDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
                end: maxDate.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
              });
            }

            console.log(`Loaded ${parsedData.length} hourly data points for ${inverterId}`);
          } else {
            console.warn('Residuals CSV not available, using synthetic data');
          }
        } catch (err) {
          console.warn('Error loading residuals CSV:', err);
        }

        // Load training timestamps CSV
        try {
          if (timestampsRes && timestampsRes.ok) {
            const csvText = await timestampsRes.text();
            const lines = csvText.split('\n').slice(1); // Skip header

            const timestamps: string[] = [];
            for (const line of lines) {
              const timestamp = line.trim();
              if (timestamp) {
                timestamps.push(timestamp);
              }
            }

            setTrainingTimestamps(timestamps);
            console.log(`Loaded ${timestamps.length} training timestamps for ${inverterId}`);
          } else {
            console.warn('Training timestamps CSV not available');
          }
        } catch (err) {
          console.warn('Error loading training timestamps CSV:', err);
        }

      } catch (err) {
        console.error('Error loading inverter data:', err);
        setData(null);
      } finally {
        setLoading(false);
      }
    };

    loadInverterData();
  }, [inverterId]);

  // Loss breakdown pie chart options
  const pieChartOptions = useMemo(() => {
    if (!data) return {};

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c}%',
      },
      series: [
        {
          type: 'pie',
          radius: ['40%', '70%'],
          avoidLabelOverlap: false,
          label: {
            show: true,
            formatter: '{b}\n{c}%',
            color: '#94a3b8',
          },
          data: [
            { value: data.lossDisaggregation.percentages.soiling.toFixed(1), name: 'Soiling', itemStyle: { color: '#ef4444' } },
            { value: data.lossDisaggregation.percentages.temperature.toFixed(1), name: 'Temperature', itemStyle: { color: '#f97316' } },
            { value: data.lossDisaggregation.percentages.spectral.toFixed(1), name: 'Spectral', itemStyle: { color: '#eab308' } },
            { value: data.lossDisaggregation.percentages.inverter.toFixed(1), name: 'Inverter', itemStyle: { color: '#22c55e' } },
            { value: data.lossDisaggregation.percentages.wiringBop.toFixed(1), name: 'Wiring/BOP', itemStyle: { color: '#3b82f6' } },
            { value: data.lossDisaggregation.percentages.degradation.toFixed(1), name: 'Degradation', itemStyle: { color: '#8b5cf6' } },
          ],
        },
      ],
    };
  }, [data]);

  // PHASE 1.2: Create Map for O(1) timestamp lookups (replaces O(n*m) findIndex)
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
        textStyle: { color: '#94a3b8' },
      },
      title: [
        // Training metadata in top-right
        ...(trainingMetadata ? [{
          text: `Digital Twin Training: ${trainingMetadata.trainingPeriod.start} to ${trainingMetadata.trainingPeriod.end}`,
          subtext: trainingMetadata.metrics ? `R²: ${trainingMetadata.metrics.r2.toFixed(3)}, MAE: ${trainingMetadata.metrics.mae_kW.toFixed(2)} kW` : '',
          right: 10,
          top: 5,
          textStyle: { color: '#94a3b8', fontSize: 11 },
          subtextStyle: { color: '#64748b', fontSize: 10 },
        }] : []),
        // Zoom status in top-left
        {
          text: zoomTitle,
          left: 10,
          top: 5,
          textStyle: {
            color: clickedDateIndex >= 0 ? '#3b82f6' : '#94a3b8',
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
          color: '#94a3b8',
          interval: 23, // Show one label per day
        },
      },
      yAxis: {
        type: 'value',
        name: 'Power (kW)',
        axisLabel: { color: '#94a3b8' },
        nameTextStyle: { color: '#94a3b8' },
      },
      dataZoom: [
        { type: 'inside', start: startPercent, end: endPercent },
        {
          type: 'slider',
          start: startPercent,
          end: endPercent,
          bottom: 20,
          height: 30,
          textStyle: { color: '#94a3b8' },
          borderColor: '#475569',
          fillerColor: 'rgba(59, 130, 246, 0.2)',
          handleStyle: {
            color: '#3b82f6',
            borderColor: '#60a5fa'
          }
        },
      ],
      // Match legend-dot color to the series lineStyle.color, without this,
      // ECharts picks marker color from its default palette, making the legend
      // look inconsistent with the actual plotted lines.
      color: ['#22c55e', '#3b82f6'],
      series: [
        {
          name: 'Expected Power',
          type: 'line',
          data: expectedPower,
          smooth: true,
          symbol: 'none',
          itemStyle: { color: '#22c55e' },
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
          // Mark training period with subtle highlight
          ...(trainingMetadata && residualsData.length > 0 ? {
            markArea: {
              silent: true,
              itemStyle: {
                color: 'rgba(34, 197, 94, 0.08)',
                borderWidth: 1,
                borderColor: 'rgba(34, 197, 94, 0.3)',
              },
              label: {
                show: true,
                position: 'insideTop',
                formatter: 'Training Period',
                color: '#22c55e',
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
                color: '#f59e0b',
                fontSize: 11,
                fontWeight: 'bold',
                backgroundColor: 'rgba(0, 0, 0, 0.7)',
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
          itemStyle: { color: '#3b82f6' },
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
        },
        // Training timestamps scatter overlay
        ...(trainingTimestamps.length > 0 && residualsData.length > 0 ? [{
          name: 'Training Timestamps',
          type: 'scatter',
          data: trainingTimestamps.map(trainingTs => {
            // PHASE 1.2: O(1) Map lookup instead of O(n) findIndex (117M comparisons → 14K lookups!)
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
  }, [data, trainingMetadata, residualsData, trainingTimestamps, clickedDate]);

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'Critical': return 'text-red-400 bg-red-500/20 border-red-500/30';
      case 'Major': return 'text-orange-400 bg-orange-500/20 border-orange-500/30';
      case 'Minor': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30';
      default: return 'text-green-400 bg-green-500/20 border-green-500/30';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <div className="text-red-400 text-lg">Inverter not found</div>
        <Link href="/demo/heatmap" className="text-blue-400 hover:text-blue-300 mt-4 inline-block">
          &larr; Back to Heatmap
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/demo/heatmap" className="text-blue-400 hover:text-blue-300 text-sm mb-2 inline-block">
            &larr; Back to Heatmap
          </Link>
          <h1 className="text-2xl font-bold text-white font-mono">{data.inverterId}</h1>
          <p className="text-ink-3 mt-1">Group: {data.groupId}</p>
        </div>
        <span className={`px-4 py-2 rounded-lg border ${getSeverityColor(data.fleetComparison.severity)}`}>
          {data.fleetComparison.severity}
        </span>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-ink-3 uppercase tracking-wide">Power Loss</div>
          <div className="text-3xl font-bold text-red-400 mt-1">
            {data.lossDisaggregation.percentages.total.toFixed(1)}%
          </div>
          <div className="text-xs text-ink-3 mt-1">vs expected</div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-ink-3 uppercase tracking-wide">Fleet Rank</div>
          <div className="text-3xl font-bold text-purple-400 mt-1">
            #{data.fleetComparison.rank}
          </div>
          <div className="text-xs text-ink-3 mt-1">of 150 inverters</div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-ink-3 uppercase tracking-wide">Soiling Ratio</div>
          <div className="text-3xl font-bold text-blue-400 mt-1">
            {(data.soilingRatio.mean * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-ink-3 mt-1">
            ±{(data.soilingRatio.std * 100).toFixed(2)}%
          </div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-ink-3 uppercase tracking-wide">Availability</div>
          <div className="text-3xl font-bold text-emerald-400 mt-1">
            {data.performance.availability_pct.toFixed(1)}%
          </div>
          <div className="text-xs text-ink-3 mt-1">uptime</div>
        </div>
      </div>

      {/* Power Comparison - Full Width */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Expected vs Measured Power</h2>
        <ReactECharts
          option={powerChartOptions}
          style={{ height: '500px', width: '100%' }}
          theme="dark"
          opts={{ renderer: 'canvas' }}
        />
        <div className="text-xs text-ink-3 mt-2 text-center">
          {residualsData.length > 0 ? (
            <>
              Default: Last 7 days. Scroll or use slider to view full history ({Math.round(residualsData.length / 24)} days, {residualsData.length} hourly points available)
              {dateRange && (
                <div className="text-xs text-ink-3 mt-1">
                  Data range: {dateRange.start} to {dateRange.end}
                </div>
              )}
            </>
          ) : (
            'Default: Last 7 days. Scroll or use slider to view history (30 days available)'
          )}
        </div>
      </div>

      {/* Loss Breakdown */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Loss Disaggregation</h2>
        <ReactECharts
          option={pieChartOptions}
          style={{ height: '400px', width: '100%' }}
          theme="dark"
          opts={{ renderer: 'canvas' }}
        />
      </div>

      {/* Detailed Metrics */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Detailed Metrics</h2>
        <div className="grid md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-sm font-medium text-ink-3 mb-3">Soiling Ratio Statistics</h3>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Mean</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {(data.soilingRatio.mean * 100).toFixed(2)}%
                  </td>
                </tr>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Median</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {(data.soilingRatio.median * 100).toFixed(2)}%
                  </td>
                </tr>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Min</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {(data.soilingRatio.min * 100).toFixed(2)}%
                  </td>
                </tr>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Max</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {(data.soilingRatio.max * 100).toFixed(2)}%
                  </td>
                </tr>
                <tr>
                  <td className="py-2 text-ink-3">Std Dev</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {(data.soilingRatio.std * 100).toFixed(2)}%
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink-3 mb-3">Fleet Comparison</h3>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Rank</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {data.fleetComparison.rank} / 150
                  </td>
                </tr>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Deviation from Mean</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {data.fleetComparison.deviationFromMean_pct > 0 ? '+' : ''}
                    {data.fleetComparison.deviationFromMean_pct.toFixed(2)}%
                  </td>
                </tr>
                <tr className="border-b border-slate-700/50">
                  <td className="py-2 text-ink-3">Z-Score</td>
                  <td className="py-2 text-right text-slate-200 font-mono">
                    {data.fleetComparison.zScore.toFixed(2)}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 text-ink-3">Analysis Period</td>
                  <td className="py-2 text-right text-slate-200 text-xs">
                    {data.metadata.analysisStart} to {data.metadata.analysisEnd}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
