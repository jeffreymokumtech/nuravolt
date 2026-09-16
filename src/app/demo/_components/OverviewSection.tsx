'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useFaults } from '@/hooks/useFaults';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import { useAnonymization } from '@/contexts/AnonymizationContext';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import PlantLossWaterfallChart, { PlantLossData } from '@/components/fault/PlantLossWaterfallChart';
import { getElectricityPrice, calculatePlantDegradation } from '@/config/electricity';
import CompactHeatmap from '@/components/heatmap/CompactHeatmap';
import type { EnhancedFaultData } from '@/types/faults';
import HealthScoreCard from './fault/HealthScoreCard';
import UrgencyCards from './fault/UrgencyCards';
import SimpleKpiCard from '@/components/ui/SimpleKpiCard';
import AnimatedChart from '@/components/ui/AnimatedChart';
import { FileText, AlertTriangle } from 'lucide-react';
import AiInsightsCard from '@/components/ai/AiInsightsCard';

// Dynamically import ECharts to avoid SSR issues
const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

interface FleetSummary {
  plantInfo: {
    plantName: string;
    capacity_MW: number;
    totalInverters: number;
    inverterGroups: string[];
  };
  analysisPeriod: {
    start: string;
    end: string;
    totalDays: number;
  };
  fleetSoiling: {
    srMean: number;
    srStd: number;
    srMin: number;
    srMax: number;
  };
  fleetLosses: {
    totalSoilingLoss_MWh: number;
    totalLoss_MWh: number;
    referenceEnergy_MWh: number;
    netEnergy_MWh: number;
  };
  healthDistribution: {
    normal: number;
    minorIssues: number;
    majorIssues: number;
    critical: number;
  };
  topPerformers: Array<{ inverterId: string; srMean: number; rank: number }>;
  worstPerformers: Array<{ inverterId: string; srMean: number; rank: number }>;
  economicImpact: {
    estimatedAnnualLoss_EUR: number;
    cleaningROIPotential_EUR: number;
  };
}

interface DigitalTwinSummary {
  generatedAt: string;
  plantId: string;
  plantName: string;
  modelType: string;
  statistics: {
    totalInverters: number;
    successful: number;
    failed: number;
    totalTime_s?: number;
    avgR2: number;
    avgMAE_kW: number;
    plantModelR2: number;
    physicsOnlyR2: number;
  };
  trainingPeriod: {
    start: string;
    end: string;
  };
  hybridConfig?: {
    modelType: string;
    physicsModel: string;
    mlModel: string;
  };
}

interface HeatmapData {
  dates: string[];
  inverters: string[];
  data: (number | null)[][];
  metadata: {
    aggregation: string;
    total_inverters: number;
    total_dates: number;
  };
}

interface CurtailmentEvent {
  date: string;
  affectedInverters: number;
  totalInverters: number;
  affectedPercent: number;
  avgLossPercent: number;
  estimatedLoss_kWh: number;
  type: 'detected' | 'fault_based';
}

interface PlantDailyPower {
  metadata: {
    plant_id: string;
    generated_at: string;
    data_start: string;
    data_end: string;
    days_shown: number;
    total_inverters: number;
  };
  summary: {
    total_expected_mwh: number;
    total_actual_mwh: number;
    total_loss_mwh: number;
    avg_loss_pct: number;
  };
  daily: Array<{
    date: string;
    actual_mwh: number;
    expected_mwh: number;
    residual_mwh: number;
    loss_pct: number;
    avg_irradiance: number;
    inverters_reporting: number;
  }>;
}

// KpiCard component replaced by AnimatedKpiCard from @/components/ui/AnimatedKpiCard

// Plant capacity lookup for energy estimation
const PLANT_CAPACITIES: Record<string, number> = {
  alpha1: 9.0,
  alpha: 9.0,
  ribera: 7.2,
  eta: 1.68,
};

const AVG_CAPACITY_FACTOR = 0.20;

export default function OverviewSection() {
  const params = useParams();
  const plantId = params.plantId as string || 'alpha1';
  const { anonName } = useAnonymization();
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();
  const { groups: plantGroups } = usePlantGroups(plantId);

  const [data, setData] = useState<FleetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Digital twin model metrics
  const [dtSummary, setDtSummary] = useState<DigitalTwinSummary | null>(null);
  const [dtLoading, setDtLoading] = useState(true);

  // Heatmap data for curtailment detection
  const [heatmapData, setHeatmapData] = useState<HeatmapData | null>(null);

  // Plant-level power data (digital twin output)
  const [plantPowerData, setPlantPowerData] = useState<PlantDailyPower | null>(null);
  const [powerLoading, setPowerLoading] = useState(true);

  // Enhanced fault data (RUL, health score, urgency)
  const [enhancedFaultData, setEnhancedFaultData] = useState<EnhancedFaultData | null>(null);
  const [enhancedFaultLoading, setEnhancedFaultLoading] = useState(true);

  // Fetch fault data for loss waterfall and fault breakdown
  const {
    summary: faultSummary,
    reactiveFaults,
    loading: faultsLoading,
  } = useFaults(plantId, {
    currency: 'EUR',
    autoRefresh: false,
  });

  // Fetch fleet summary
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${dataRoot}/soiling/${plantId}/fleet_summary.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load data');
        return res.json();
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [plantId]);

  // Fetch digital twin summary
  useEffect(() => {
    setDtLoading(true);
    fetch(`${dataRoot}/digitaltwin/${plantId}/digital_twins_summary.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load digital twin data');
        return res.json();
      })
      .then((json) => {
        setDtSummary(json);
        setDtLoading(false);
      })
      .catch(() => {
        setDtSummary(null);
        setDtLoading(false);
      });
  }, [plantId]);

  // Fetch heatmap data for curtailment detection
  useEffect(() => {
    fetch(`${dataRoot}/digitaltwin/${plantId}/timeline_heatmap_data.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load heatmap data');
        return res.json();
      })
      .then((json) => {
        setHeatmapData(json.daily || json);
      })
      .catch(() => {
        setHeatmapData(null);
      });
  }, [plantId]);

  // Fetch plant-level power data (digital twin output)
  useEffect(() => {
    setPowerLoading(true);
    fetch(`${dataRoot}/digitaltwin/${plantId}/plant_daily_power.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load plant power data');
        return res.json();
      })
      .then((json: PlantDailyPower) => {
        setPlantPowerData(json);
        setPowerLoading(false);
      })
      .catch(() => {
        setPlantPowerData(null);
        setPowerLoading(false);
      });
  }, [plantId]);

  // Fetch enhanced fault data (RUL predictions, health score, urgency)
  useEffect(() => {
    setEnhancedFaultLoading(true);
    fetch(`${dataRoot}/faults/${plantId}/fault_detection_enhanced.json`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load enhanced fault data');
        return res.json();
      })
      .then((json: EnhancedFaultData) => {
        setEnhancedFaultData(json);
        setEnhancedFaultLoading(false);
      })
      .catch(() => {
        setEnhancedFaultData(null);
        setEnhancedFaultLoading(false);
      });
  }, [plantId]);

  // Plant power chart options (Digital Twin: Expected vs Actual)
  const plantPowerChartOptions = useMemo(() => {
    if (!plantPowerData || plantPowerData.daily.length === 0) return {};

    const dates: string[] = [];
    const expectedPower: number[] = [];
    const actualPower: number[] = [];

    // Use all data (3-hourly resolution for last 10 days)
    // Convert energy (MWh per interval) to average power (MW) for the chart
    const INTERVAL_HOURS = 3;
    plantPowerData.daily.forEach((point) => {
      dates.push(point.date);
      expectedPower.push(point.expected_mwh / INTERVAL_HOURS);
      actualPower.push(point.actual_mwh / INTERVAL_HOURS);
    });

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!params || params.length === 0) return '';
          const dateStr = params[0].name;
          const d = new Date(dateStr);
          const formattedDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          let result = `<strong>${formattedDate}</strong><br/>`;
          params.forEach((p: any) => {
            if (p.value !== null && p.value !== undefined) {
              result += `${p.marker} ${p.seriesName}: ${(p.value * 1000).toFixed(0)} kW<br/>`;
            }
          });
          return result;
        },
      },
      legend: {
        data: ['Expected Power (DT)', 'Actual Power'],
        top: 0,
        textStyle: { color: '#374151' },
      },
      grid: { left: 60, right: 20, top: 50, bottom: 70 },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: {
          rotate: 45,
          color: '#6b7280',
          interval: 7, // Show every 8th label (~1 per day)
          formatter: (value: string) => {
            const d = new Date(value);
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
        },
        axisLine: { lineStyle: { color: '#d1d5db' } },
      },
      yAxis: {
        type: 'value',
        name: 'Power (MW)',
        axisLabel: { color: '#6b7280' },
        nameTextStyle: { color: '#6b7280' },
        splitLine: { lineStyle: { color: '#e5e7eb' } },
      },
      series: [
        { name: 'Expected Power (DT)', type: 'line', data: expectedPower, smooth: false, symbol: 'none', lineStyle: { color: '#3b82f6', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(59, 130, 246, 0.3)' }, { offset: 1, color: 'rgba(59, 130, 246, 0.05)' }] } } },
        { name: 'Actual Power', type: 'line', data: actualPower, smooth: false, symbol: 'none', lineStyle: { color: '#22c55e', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(34, 197, 94, 0.3)' }, { offset: 1, color: 'rgba(34, 197, 94, 0.05)' }] } } },
      ],
    };
  }, [plantPowerData]);

  // Plant power summary metrics
  const powerMetrics = useMemo(() => {
    if (!plantPowerData || plantPowerData.daily.length === 0) return null;

    // Use summary from the JSON (already calculated for the period)
    const { summary, metadata } = plantPowerData;

    return {
      totalExpected: summary.total_expected_mwh.toFixed(1),
      totalActual: summary.total_actual_mwh.toFixed(1),
      totalLoss: summary.total_loss_mwh.toFixed(1),
      avgLossPct: summary.avg_loss_pct.toFixed(2),
      inverters: metadata.total_inverters,
      daysShown: metadata.days_shown,
    };
  }, [plantPowerData]);

  // Detect curtailment events from heatmap data
  const curtailmentEvents = useMemo((): CurtailmentEvent[] => {
    if (!heatmapData || !data) return [];
    const events: CurtailmentEvent[] = [];
    const { dates, inverters, data: heatData } = heatmapData;
    const totalInverters = inverters.length;
    const plantCapacity_kW = (data.plantInfo.capacity_MW || 1) * 1000;
    const avgDailyHours = 5;
    const curtailmentThreshold = 20;
    const affectedThreshold = 0.80;

    dates.forEach((date, dateIdx) => {
      let affectedCount = 0;
      let totalLoss = 0;
      let validCount = 0;

      inverters.forEach((_, invIdx) => {
        const loss = heatData?.[dateIdx]?.[invIdx];
        if (loss !== null && loss !== undefined) {
          validCount++;
          if (loss >= curtailmentThreshold) {
            affectedCount++;
            totalLoss += loss;
          }
        }
      });

      if (validCount > 0 && (affectedCount / validCount) >= affectedThreshold) {
        const avgLoss = totalLoss / (affectedCount || 1);
        const estimatedLoss_kWh = plantCapacity_kW * avgDailyHours * (avgLoss / 100) * (affectedCount / validCount);
        events.push({
          date,
          affectedInverters: affectedCount,
          totalInverters: validCount,
          affectedPercent: (affectedCount / validCount) * 100,
          avgLossPercent: avgLoss,
          estimatedLoss_kWh,
          type: 'detected',
        });
      }
    });

    return events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 10);
  }, [heatmapData, data]);

  const totalDetectedCurtailment_kWh = useMemo(() => {
    return curtailmentEvents.reduce((sum, e) => sum + e.estimatedLoss_kWh, 0);
  }, [curtailmentEvents]);

  // Loss data for waterfall chart
  const lossData = useMemo((): PlantLossData | null => {
    if (!data) return null;
    const refEnergy = data.fleetLosses.referenceEnergy_MWh * 1000;
    const netEnergy = data.fleetLosses.netEnergy_MWh * 1000;
    const soilingLoss = data.fleetLosses.totalSoilingLoss_MWh * 1000;

    const curtailmentFaultTypes = ['grid_curtailment', 'export_cap_active', 'inverter_clipping'];
    const curtailmentFromFaults = reactiveFaults
      .filter((f) => curtailmentFaultTypes.includes(f.fault_type))
      .reduce((sum, f) => sum + f.energy_loss_kwh, 0);
    const detectedCurtailment = Math.max(curtailmentFromFaults, totalDetectedCurtailment_kWh);

    const totalLoss = data.fleetLosses.totalLoss_MWh * 1000;

    // Calculate degradation based on plant age (always visible, independent of other losses)
    // Industry standard: 0.5-0.8% degradation per year for c-Si modules
    const plantDegradationPct = calculatePlantDegradation(plantId);
    const degradationLoss = refEnergy * (plantDegradationPct / 100);

    // Subtract degradation and attributed losses from total
    const attributedLoss = soilingLoss + detectedCurtailment + degradationLoss;
    const remainingLoss = Math.max(0, totalLoss - attributedLoss);

    // Distribute remaining losses among other categories
    const temperatureLoss = remainingLoss * 0.55; // Temperature is typically largest remaining factor
    const inverterLoss = remainingLoss * 0.30;    // Inverter efficiency losses
    const otherCurtailment = remainingLoss * 0.15; // Additional curtailment/clipping
    const totalCurtailment = detectedCurtailment + otherCurtailment;

    return {
      referenceEnergy_kWh: refEnergy,
      netEnergy_kWh: netEnergy,
      losses: {
        soiling_kWh: soilingLoss,
        soiling_pct: (soilingLoss / refEnergy) * 100,
        curtailment_kWh: totalCurtailment,
        curtailment_pct: (totalCurtailment / refEnergy) * 100,
        degradation_kWh: degradationLoss,
        degradation_pct: plantDegradationPct, // Use actual plant age-based degradation
        temperature_kWh: temperatureLoss,
        temperature_pct: (temperatureLoss / refEnergy) * 100,
        inverter_kWh: inverterLoss,
        inverter_pct: (inverterLoss / refEnergy) * 100,
        faults_reactive_kWh: faultSummary?.current_loss_kwh || 0,
        faults_reactive_pct: faultSummary ? (faultSummary.current_loss_kwh / refEnergy) * 100 : 0,
        faults_predictive_kWh: faultSummary?.projected_loss_kwh || 0,
        faults_predictive_pct: faultSummary ? (faultSummary.projected_loss_kwh / refEnergy) * 100 : 0,
      },
    };
  }, [data, faultSummary, reactiveFaults, totalDetectedCurtailment_kWh, plantId]);

  // Fault breakdown
  const faultBreakdown = useMemo(() => {
    const electricityPrice = getElectricityPrice(plantId);
    const byType: Record<string, { count: number; loss_kwh: number; loss_eur: number; severity: string }> = {};

    reactiveFaults.forEach((fault) => {
      if (!byType[fault.fault_type]) {
        byType[fault.fault_type] = { count: 0, loss_kwh: 0, loss_eur: 0, severity: 'info' };
      }
      byType[fault.fault_type].count++;
      byType[fault.fault_type].loss_kwh += fault.energy_loss_kwh;
      byType[fault.fault_type].loss_eur += fault.energy_loss_kwh * electricityPrice;
      if (fault.severity === 'critical' || byType[fault.fault_type].severity !== 'critical') {
        if (fault.severity === 'warning' || byType[fault.fault_type].severity === 'info') {
          byType[fault.fault_type].severity = fault.severity;
        }
      }
    });

    const sorted = Object.entries(byType)
      .map(([type, d]) => ({ type, ...d }))
      .sort((a, b) => b.loss_eur - a.loss_eur)
      .slice(0, 5);

    return {
      topFaults: sorted,
      totalCount: reactiveFaults.length,
      totalLossEur: faultSummary?.current_loss_value || 0,
      criticalCount: faultSummary?.critical_count || 0,
    };
  }, [reactiveFaults, faultSummary, plantId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-signal-critical/10 border border-signal-critical/30 rounded-xl p-6 text-center">
        <div className="text-signal-critical font-semibold">Error loading dashboard data</div>
        <div className="text-signal-critical text-sm mt-2">{error}</div>
      </div>
    );
  }

  const efficiency = ((data.fleetLosses.netEnergy_MWh / data.fleetLosses.referenceEnergy_MWh) * 100).toFixed(1);
  const soilingLossPct = ((data.fleetLosses.totalSoilingLoss_MWh / data.fleetLosses.referenceEnergy_MWh) * 100).toFixed(2);

  // Count affected inverters from hardware faults only (exclude soft faults like soiling/DT residuals)
  const SOFT_FAULT_TYPES = new Set(['soiling_detected', 'unclassified_performance_loss', 'vegetation_shading']);
  const hardwareFaults = reactiveFaults.filter(f => !SOFT_FAULT_TYPES.has(f.fault_type));
  const affectedInverterIds = new Set(hardwareFaults.map(f => f.equipment_id));
  const affectedInvertersCount = affectedInverterIds.size;
  const healthyInvertersCount = data.plantInfo.totalInverters - affectedInvertersCount;
  const healthyPct = ((healthyInvertersCount / data.plantInfo.totalInverters) * 100).toFixed(0);

  // Total issues = reactive + predictive faults
  const totalIssues = (faultSummary?.reactive_count || 0) + (faultSummary?.predictive_count || 0);
  const criticalIssues = faultSummary?.critical_count || 0;

  // Annual impact from faults (current + projected losses)
  const annualImpactFromFaults = (faultSummary?.current_loss_value || 0) + (faultSummary?.projected_loss_value || 0);

  // Annualize soiling losses (already in the data as annual estimate)
  const annualSoilingLoss = data.economicImpact.estimatedAnnualLoss_EUR;

  // Total annual impact = faults + soiling
  const totalAnnualImpact = annualImpactFromFaults + annualSoilingLoss;

  // Categorize inverters by severity, use hardwareFaults so distribution sums to totalInverters
  const criticalInverters = new Set(hardwareFaults.filter(f => f.severity === 'critical').map(f => f.equipment_id));
  const warningInverters = new Set(hardwareFaults.filter(f => f.severity === 'warning' && !criticalInverters.has(f.equipment_id)).map(f => f.equipment_id));
  const infoInverters = new Set(hardwareFaults.filter(f => f.severity === 'info' && !criticalInverters.has(f.equipment_id) && !warningInverters.has(f.equipment_id)).map(f => f.equipment_id));

  const healthDistribution = {
    normal: healthyInvertersCount,
    minorIssues: infoInverters.size,
    majorIssues: warningInverters.size,
    critical: criticalInverters.size,
  };


  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-bold text-ink">Plant Overview</h2>
          <p className="text-ink-2 mt-1">
            {anonName(data.plantInfo.plantName)} - Real-time monitoring and performance analysis
          </p>
        </div>
      </div>

      {/* Digital Twin Power Section */}
      <div data-tour="digital-twin-chart" className="bg-paper border border-divider rounded-xl p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-semibold text-ink">Digital Twin: Expected vs Actual Power</h3>
            <p className="text-sm text-ink-2 mt-1">Plant-level aggregation of all {powerMetrics?.inverters || 0} inverter models (last {powerMetrics?.daysShown || 10} days, 3-hourly)</p>
          </div>
          {powerMetrics && (
            <div className="grid grid-cols-3 gap-4 text-right">
              <div>
                <div className="text-xs text-ink-3">Expected</div>
                <div className="text-lg font-bold text-blue-600">{powerMetrics.totalExpected} MWh</div>
              </div>
              <div>
                <div className="text-xs text-ink-3">Actual</div>
                <div className="text-lg font-bold text-signal-positive">{powerMetrics.totalActual} MWh</div>
              </div>
              <div>
                <div className="text-xs text-ink-3">Loss</div>
                <div className={`text-lg font-bold ${Number(powerMetrics.avgLossPct) > 0 ? 'text-signal-critical' : 'text-signal-positive'}`}>
                  {powerMetrics.totalLoss} MWh ({powerMetrics.avgLossPct}%)
                </div>
              </div>
            </div>
          )}
        </div>
        {powerLoading ? (
          <div className="h-64 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
          </div>
        ) : plantPowerData && plantPowerData.daily.length > 0 ? (
          <AnimatedChart delay={0.1}>
            <ReactECharts option={plantPowerChartOptions} style={{ height: '300px', width: '100%' }} opts={{ renderer: 'canvas' }} />
          </AnimatedChart>
        ) : (
          <div className="h-64 flex items-center justify-center text-ink-3">No digital twin power data available</div>
        )}
      </div>

      {/* KPI Grid */}
      <div data-tour="kpi-grid" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <SimpleKpiCard title="Performance Ratio (PR)" value={`${efficiency}%`} subtitle={`${data.fleetLosses.netEnergy_MWh.toFixed(0)} / ${data.fleetLosses.referenceEnergy_MWh.toFixed(0)} MWh`} color="blue" index={0} />
        <SimpleKpiCard title="Total Inverters" value={data.plantInfo.totalInverters} subtitle={`${data.plantInfo.inverterGroups.length} groups`} color="purple" index={1} />
        <SimpleKpiCard title="Healthy" value={healthyInvertersCount} subtitle={`${healthyPct}% of fleet`} color="green" index={2} />
        <SimpleKpiCard title="Issues Detected" value={totalIssues} subtitle={`${criticalIssues} critical`} color={criticalIssues > 0 ? 'red' : totalIssues > 0 ? 'yellow' : 'green'} index={3} />
        <SimpleKpiCard title="Soiling Loss" value={`${data.fleetLosses.totalSoilingLoss_MWh.toFixed(0)} MWh`} subtitle={`${soilingLossPct}% of potential`} color="yellow" index={4} />
        <SimpleKpiCard title="Annual Impact" value={`€${totalAnnualImpact.toFixed(0)}`} subtitle="Faults + soiling" color="red" index={5} />
      </div>

      {/* Inverter Groups, drilldown */}
      {plantGroups.length > 0 && (
        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-ink">Inverter Groups</h3>
            <span className="text-xs text-ink-3">Click a group to drill into per-inverter performance</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {plantGroups.map((g) => (
              <Link
                key={g.id}
                href={`${prefix}/plant/${plantId}/group/${g.slug}`}
                className="block rounded-lg border border-divider hover:border-blue-500 hover:shadow-md transition p-4 group"
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="font-semibold text-ink">{g.name}</span>
                  <span className="text-blue-600 text-sm group-hover:translate-x-0.5 transition-transform">→</span>
                </div>
                <div className="text-xs text-ink-3 space-y-0.5">
                  <div>{g.inverterCount} inverter{g.inverterCount === 1 ? '' : 's'}</div>
                  {g.inverterModel && <div className="truncate" title={g.inverterModel}>{g.inverterModel}</div>}
                  <div>Tilt {g.tilt}° · Az {g.azimuth}°</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* AI Insights */}
      <AiInsightsCard
        plantId={plantId}
        plantData={{
          plantName: data.plantInfo.plantName,
          capacity_MW: data.plantInfo.capacity_MW,
          fleetSoiling: data.fleetSoiling,
          fleetLosses: data.fleetLosses,
          healthDistribution: data.healthDistribution,
          economicImpact: data.economicImpact,
        }}
      />

      {/* Health Score & Urgency Summary */}
      <div className="grid lg:grid-cols-4 gap-6">
        <div data-tour="health-score">
        <HealthScoreCard
          healthScore={enhancedFaultData?.health_score}
          loading={enhancedFaultLoading}
        />
        </div>
        <div className="lg:col-span-3">
          <UrgencyCards
            urgencySummary={enhancedFaultData?.urgency_summary}
            loading={enhancedFaultLoading}
          />
        </div>
      </div>

      {/* Digital Twin Model Metrics */}
      {dtSummary && !dtLoading && (
        <div className="bg-paper border border-divider rounded-xl p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-lg font-semibold text-ink">Digital Twin Model</h3>
              <p className="text-sm text-ink-2 mt-1">{dtSummary.hybridConfig?.modelType || dtSummary.modelType}</p>
            </div>
            <div className="text-right text-xs text-ink-3">
              <div>Training: {dtSummary.trainingPeriod.start.split(' ')[0]}</div>
              <div>to {dtSummary.trainingPeriod.end.split(' ')[0]}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg p-3 border border-divider shadow-sm">
              <div className="text-xs text-ink-3 uppercase tracking-wide">Model R²</div>
              <div className="text-2xl font-bold text-indigo-700">{(dtSummary.statistics.plantModelR2 * 100).toFixed(2)}%</div>
              <div className="text-xs text-ink-3">Prediction accuracy</div>
            </div>
            <div className="bg-white rounded-lg p-3 border border-divider shadow-sm">
              <div className="text-xs text-ink-3 uppercase tracking-wide">Physics R²</div>
              <div className="text-2xl font-bold text-purple-700">{(dtSummary.statistics.physicsOnlyR2 * 100).toFixed(2)}%</div>
              <div className="text-xs text-ink-3">Baseline (PVWatts)</div>
            </div>
            <div className="bg-white rounded-lg p-3 border border-divider shadow-sm">
              <div className="text-xs text-ink-3 uppercase tracking-wide">ML Improvement</div>
              <div className="text-2xl font-bold text-signal-positive">+{((dtSummary.statistics.plantModelR2 - dtSummary.statistics.physicsOnlyR2) * 100).toFixed(2)}%</div>
              <div className="text-xs text-ink-3">Over physics model</div>
            </div>
            <div className="bg-white rounded-lg p-3 border border-divider shadow-sm">
              <div className="text-xs text-ink-3 uppercase tracking-wide">MAE</div>
              <div className="text-2xl font-bold text-ink-2">{(dtSummary.statistics.avgMAE_kW * 100).toFixed(2)}%</div>
              <div className="text-xs text-ink-3">kW/kWp error</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-ink-3 text-center">
            {dtSummary.statistics.successful}/{dtSummary.statistics.totalInverters} inverter models trained successfully
          </div>
        </div>
      )}

      {/* Heatmap */}
      <CompactHeatmap plantId={plantId} daysToShow={0} height={420} />

      {/* Loss Disaggregation Waterfall */}
      <PlantLossWaterfallChart
        lossData={lossData}
        faultSummary={faultSummary}
        title="Loss Disaggregation"
        subtitle={`Analysis Period: ${data.analysisPeriod.start} to ${data.analysisPeriod.end}`}
        loading={loading || faultsLoading}
        height={400}
        showPieChart={true}
      />

      {/* Health Distribution & Fault Breakdown */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <h3 className="text-lg font-semibold text-ink mb-4">Health Distribution</h3>
          <div className="space-y-4">
            {[
              { label: 'Normal', value: healthDistribution.normal, color: 'bg-emerald-500', textColor: 'text-signal-positive' },
              { label: 'Minor Issues', value: healthDistribution.minorIssues, color: 'bg-yellow-500', textColor: 'text-signal-warning' },
              { label: 'Major Issues', value: healthDistribution.majorIssues, color: 'bg-orange-500', textColor: 'text-orange-600' },
              { label: 'Critical', value: healthDistribution.critical, color: 'bg-red-500', textColor: 'text-signal-critical' },
            ].map((item) => (
              <div key={item.label}>
                <div className="flex justify-between text-sm mb-1">
                  <span className={`${item.textColor} font-medium`}>{item.label}</span>
                  <span className="text-ink-2">{item.value} inverters</span>
                </div>
                <div className="h-3 bg-divider rounded-full overflow-hidden">
                  <div className={`h-full ${item.color} rounded-full transition-all`} style={{ width: `${(item.value / data.plantInfo.totalInverters) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-lg font-semibold text-ink">Fault Classification</h3>
              <p className="text-xs text-ink-3 mt-0.5">Active faults by type and loss impact</p>
            </div>
            <Link href={`/demo/plant/${plantId}/faults`} className="text-sm text-blue-600 hover:text-blue-700 font-medium">View All →</Link>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-paper rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-ink">{faultBreakdown.totalCount}</div>
              <div className="text-xs text-ink-3">Active Faults</div>
            </div>
            <div className="bg-signal-critical/10 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-signal-critical">{faultBreakdown.criticalCount}</div>
              <div className="text-xs text-ink-3">Critical</div>
            </div>
            <div className="bg-signal-warning/10 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-signal-warning">€{Math.round(faultBreakdown.totalLossEur).toLocaleString()}</div>
              <div className="text-xs text-ink-3">Total Loss</div>
            </div>
          </div>
          {faultBreakdown.topFaults.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-ink-3 uppercase tracking-wide">Top Fault Types by Loss</div>
              {faultBreakdown.topFaults.map((fault) => (
                <div key={fault.type} className="flex items-center justify-between py-2 border-b border-divider last:border-0">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${fault.severity === 'critical' ? 'bg-red-500' : fault.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                    <span className="text-sm text-ink-2">{fault.type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}</span>
                    <span className="text-xs text-ink-3">({fault.count})</span>
                  </div>
                  <span className="text-sm font-medium text-ink">€{Math.round(fault.loss_eur).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-ink-3 text-sm">No active faults detected</div>
          )}
        </div>
      </div>

      {/* Curtailment Events */}
      {curtailmentEvents.length > 0 && (
        <div className="bg-paper border border-divider rounded-xl p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-lg font-semibold text-ink flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                Detected Curtailment Events
              </h3>
              <p className="text-xs text-ink-3 mt-1">Plant-wide power loss events (≥80% inverters affected, ≥20% loss)</p>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-orange-600">{curtailmentEvents.length}</div>
              <div className="text-xs text-ink-3">Events detected</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-white rounded-lg p-3 text-center border border-divider shadow-sm">
              <div className="text-lg font-bold text-ink">{Math.round(totalDetectedCurtailment_kWh / 1000)} MWh</div>
              <div className="text-xs text-ink-3">Est. Energy Loss</div>
            </div>
            <div className="bg-white rounded-lg p-3 text-center border border-divider shadow-sm">
              <div className="text-lg font-bold text-orange-600">€{Math.round(totalDetectedCurtailment_kWh * getElectricityPrice(plantId)).toLocaleString()}</div>
              <div className="text-xs text-ink-3">Est. Revenue Impact</div>
            </div>
            <div className="bg-white rounded-lg p-3 text-center border border-divider shadow-sm">
              <div className="text-lg font-bold text-ink-2">{curtailmentEvents.length > 0 ? Math.round(curtailmentEvents.reduce((sum, e) => sum + e.avgLossPercent, 0) / curtailmentEvents.length) : 0}%</div>
              <div className="text-xs text-ink-3">Avg. Loss Severity</div>
            </div>
          </div>
        </div>
      )}

      {/* Top & Worst Performers */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <h3 className="text-lg font-semibold text-ink mb-4 flex items-center gap-2">
            <span className="text-signal-positive">↑</span> Top 5 Performers
          </h3>
          <div className="space-y-2">
            {data.topPerformers.map((inv) => (
              <Link
                key={inv.inverterId}
                href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inv.inverterId)}`}
                className="flex justify-between items-center py-2 border-b border-divider last:border-0 hover:bg-emerald-50 -mx-2 px-2 rounded transition"
              >
                <span className="text-ink-2 font-mono text-sm">{inv.inverterId}</span>
                <span className="text-signal-positive font-medium">{(inv.srMean * 100).toFixed(2)}%</span>
              </Link>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-lg border border-divider p-6">
          <h3 className="text-lg font-semibold text-ink mb-4 flex items-center gap-2">
            <span className="text-signal-critical">↓</span> Bottom 5 Performers
          </h3>
          <div className="space-y-2">
            {data.worstPerformers.map((inv) => (
              <Link
                key={inv.inverterId}
                href={`${prefix}/plant/${plantId}/inverter/${encodeURIComponent(inv.inverterId)}`}
                className="flex justify-between items-center py-2 border-b border-divider last:border-0 hover:bg-amber-50 -mx-2 px-2 rounded transition"
              >
                <span className="text-ink-2 font-mono text-sm">{inv.inverterId}</span>
                <span className="text-signal-warning font-medium">{(inv.srMean * 100).toFixed(2)}%</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Analysis Period Info */}
      <div className="bg-white border border-divider rounded-lg p-4 text-center text-ink-2 text-sm">
        Analysis Period: {data.analysisPeriod.start} to {data.analysisPeriod.end} ({data.analysisPeriod.totalDays} days)
      </div>
    </div>
  );
}
