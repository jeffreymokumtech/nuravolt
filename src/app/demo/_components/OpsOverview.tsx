'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { useDemoPlants } from '@/contexts/DemoPlantContext';
import { plantTzLabel } from '@/lib/plantTime';
import { useFaults } from '@/hooks/useFaults';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import OpsPanel from '@/components/ops/OpsPanel';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import AlarmStack from '@/components/ops/AlarmStack';
import FaultExplanationDrawer, {
  type FaultDetails,
} from '@/components/ops/FaultExplanationDrawer';
import { useRouter } from 'next/navigation';
import type { PredictiveAlarm } from '@/lib/tickets/createFromAlarm';
import OpsTable from '@/components/ops/OpsTable';
import OpsFooter from '@/components/ops/OpsFooter';
import LiveBadge from '@/components/ops/LiveBadge';
import OpsLineChart from '@/components/ops/charts/OpsLineChart';
import OpsWaterfallChart from '@/components/ops/charts/OpsWaterfallChart';
import HealthRing from '@/components/ops/charts/HealthRing';
import OpsTimeRange, { OpsBucketToggle } from '@/components/ops/OpsTimeRange';
import StatusLed, { type StatusTone } from '@/components/ops/StatusLed';
import AiInsightsCard from '@/components/ai/AiInsightsCard';
import { useChartRange } from '@/hooks/useChartRange';
import {
  useTwinWindow,
  useFetchJson,
  buildTwinSeries,
  type TwinWindowArgs,
  type TwinWindowResponse,
} from '@/hooks/useTwinWindow';
import { periodWindows } from '@/utils/timeBuckets';
import PeriodKpiStrip, { type PeriodKpi } from '@/components/ops/PeriodKpiStrip';

interface OpsOverviewProps {
  plantId: string;
  plantName: string;
  assetType: 'PV' | 'BESS' | 'PV+BESS' | 'WIND';
  capacityMW?: number;
}

interface MlPlantSummary {
  plantInfo: { plantId: string; plantName: string; capacity_MW: number; totalInverters: number; healthScore?: number };
  currentStatus: {
    avgSoilingRatio: number;
    estimatedLossPct: number;
    lastUpdateTime: string;
    /** Model-metrics sidecar. Two generations of key names exist in served
     *  fixtures: {mae, r_squared} and {validation_mae, validation_r2}. */
    validation?: {
      mae?: number;
      rmse?: number;
      r_squared?: number;
      validation_mae?: number;
      validation_rmse?: number;
      validation_r2?: number;
    };
  };
  fleetHealth: { normalInverters: number; minorIssues: number; majorIssues: number; critical: number };
  economicImpact: {
    ytdEnergyLoss_MWh: number;
    ytdRevenueLoss_EUR: number;
    nextCleaningRecommended?: string | null;
    estimatedROI_pct?: number;
    paybackDays?: number;
  };
  topPerformers: Array<{ inverterId: string; srMean: number; rank: number }>;
  worstPerformers: Array<{ inverterId: string; srMean: number; rank: number }>;
}

interface FleetSummary {
  fleetSoiling: { srMean: number; srStd: number; srMin: number; srMax: number };
  fleetLosses: {
    totalSoilingLoss_MWh: number;
    totalLoss_MWh: number;
    referenceEnergy_MWh: number;
    netEnergy_MWh: number;
    /** Per-fault-type YTD attribution from the classifier cascade. Optional, newer fixtures only. */
    faults_by_type?: Record<string, { ytd_mwh: number; count: number }>;
    /** DustIQ ground-truth soiling YTD (MWh). Null when DustIQ unavailable for this plant. */
    dustiq_soiling_ytd_mwh?: number | null;
    /** Provenance string describing the disaggregation method. */
    _method?: string;
    /** Window descriptor for DustIQ aggregation (e.g. "2025 (latest year)"). */
    dustiq_window?: string;
  };
}

interface DigitalTwinSummary {
  generatedAt: string;
  modelType: string;
  statistics: {
    totalInverters: number;
    successful: number;
    failed: number;
    avgR2: number;
    avgMAE_kW: number;
    plantModelR2: number;
    physicsOnlyR2: number;
  };
  trainingPeriod: { start: string; end: string };
}

interface FaultsEnhanced {
  health_score: { value: number; status: string; trend: string };
  urgency_summary: Record<string, { count: number; total_revenue_at_risk_eur: number }>;
  summary: {
    current_loss_kwh: number;
    projected_loss_kwh: number;
    critical_count: number;
    urgent_count: number;
    soon_count: number;
    planned_count: number;
    monitoring_count: number;
    reactive_count: number;
    predictive_count: number;
  };
  predictive_faults: Array<{
    id: string;
    fault_type: string;
    display_name: string;
    equipment_id: string;
    days_to_fault: number;
    urgency: string;
    projected_energy_loss_kwh: number;
    revenue_at_risk_eur: number;
    classification_layer?: 'RULE' | 'TWIN_RESIDUAL' | 'ML_CLASSIFIER' | 'AI_OVERRIDE';
    evidence?: string;
    winner_reason?: string;
    cascade_winning_confidence?: number;
  }>;
}

interface InverterRow {
  inverterId: string;
  groupId: string;
  powerLoss: number;
  performanceRatio: number;
  soilingRatio: { mean: number; std: number };
  fleetComparison: { severity: string; zScore: number };
}

const SEVERITY_TONE: Record<string, StatusTone> = {
  normal: 'ok',
  minor: 'info',
  major: 'warn',
  critical: 'alarm',
};

export default function OpsOverview({ plantId, plantName, assetType, capacityMW }: OpsOverviewProps) {
  const dataRoot = useDataRoot();
  const { plants } = useDemoPlants();
  const plantTz = plants.find((p) => p.slug === plantId || p.id === plantId)?.timezone ?? null;

  // Presets anchor to the plant's last day with data (fixtures are pinned in
  // time); the first response tells us where that is.
  const [dataEnd, setDataEnd] = useState<string | null>(null);
  const twinCtl = useChartRange('7d', { dataEnd });
  const twinWindow = useTwinWindow(plantId, dataRoot, {
    from: twinCtl.from,
    to: twinCtl.to,
    spanDays: twinCtl.spanDays,
    bucket: twinCtl.bucket,
    bucketOverride: twinCtl.bucketOverride,
  });
  useEffect(() => {
    const end = twinWindow.data?.metadata?.data_end;
    if (end) setDataEnd((prev) => prev ?? end);
  }, [twinWindow.data]);

  // Year-to-date window (anchored to data end) closes the loss waterfall and
  // feeds the period KPI aggregates.
  const ytdArgs = useMemo<TwinWindowArgs | null>(() => {
    if (!dataEnd) return null;
    return {
      from: `${dataEnd.slice(0, 4)}-01-01`,
      to: dataEnd,
      spanDays: 365,
      bucket: 'day',
      bucketOverride: 'day',
    };
  }, [dataEnd]);
  const ytdWindow = useTwinWindow(plantId, dataRoot, ytdArgs);

  const summary = useFetchJson<MlPlantSummary>(
    `${dataRoot}/soiling/${plantId}/ml_plant_summary.json`
  );
  const fleet = useFetchJson<FleetSummary>(
    `${dataRoot}/soiling/${plantId}/fleet_summary.json`
  );
  const monthlySummary = useFetchJson<{ monthly_data?: Array<{ energy_loss_mwh?: number; revenue_loss_eur?: number }> }>(
    `${dataRoot}/soiling/${plantId}/monthly_summary.json`
  );

  // Period-scoped loss KPIs (today / 7d / MTD / YTD), integrated from the
  // YTD daily series and priced at the plant's implied €/MWh.
  const periodKpis = useMemo<PeriodKpi[]>(() => {
    const rows = ytdWindow.data?.daily;
    if (!rows?.length || !dataEnd) return [];
    // Implied price from the soiling monthly summary; the summary route's
    // documented flat €65/MWh when the plant ships no monthly file.
    let eurPerMwh = 65;
    const md = monthlySummary.data?.monthly_data;
    if (md?.length) {
      const e = md.reduce((s, m) => s + (m.energy_loss_mwh ?? 0), 0);
      const r = md.reduce((s, m) => s + (m.revenue_loss_eur ?? 0), 0);
      if (e > 1 && r > 0) eurPerMwh = r / e;
    }
    return periodWindows(dataEnd).map((w) => {
      const inWindow = rows.filter((r) => {
        const d = r.date.slice(0, 10);
        return d >= w.from && d <= w.to && r.actual_mwh != null;
      });
      const loss = inWindow.length
        ? inWindow.reduce((s, r) => s + ((r.predicted_mwh ?? 0) - (r.actual_mwh ?? 0)), 0)
        : null;
      return {
        key: w.key,
        // "Total" distinguishes the twin's all-cause loss from the top
        // strip's soiling-only YTD figure.
        label: `Total loss · ${w.label.toLowerCase()}`,
        lossMwh: loss,
        lossEur: loss != null ? loss * eurPerMwh : null,
        anchorNote: w.key === 'today' ? dataEnd : undefined,
      };
    });
  }, [ytdWindow.data, dataEnd, monthlySummary.data]);
  const twin = useFetchJson<DigitalTwinSummary>(
    `${dataRoot}/digitaltwin/${plantId}/digital_twins_summary.json`
  );
  const faultsJson = useFetchJson<FaultsEnhanced>(
    `${dataRoot}/faults/${plantId}/fault_detection_enhanced.json`
  );
  const inverters = useFetchJson<{ inverters: InverterRow[] }>(
    `${dataRoot}/soiling/${plantId}/all_inverters.json`
  );

  const faults = useFaults(plantId);
  const { groups, loading: groupsLoading } = usePlantGroups(plantId);

  const showBess = assetType !== 'PV' && assetType !== 'WIND';

  const telemetry = buildTelemetry(summary.data, fleet.data, capacityMW);
  const twinSeries = buildTwinSeries(twinWindow.data, plantTz);
  // Keep the previous window rendered while a new one loads, so range
  // changes don't flash an empty panel.
  const lastTwinSeries = useRef(twinSeries);
  if (twinSeries) lastTwinSeries.current = twinSeries;
  const displayTwinSeries = twinSeries ?? (twinWindow.loading ? lastTwinSeries.current : null);
  const alarms = buildAlarms(faultsJson.data);
  const topWorst = buildTopWorst(summary.data, inverters.data);

  const handleTwinBrush = (a: number, b: number) => {
    const rows = twinWindow.data?.daily;
    if (!rows || !rows[a] || !rows[b]) return;
    const from = rows[a].date.slice(0, 10);
    const to = rows[b].date.slice(0, 10);
    if (from >= to) return;
    twinCtl.setCustomRange({ from, to });
  };

  // Toggle reflects what the server actually returned (an hourly request past
  // the intraday tail downgrades to daily and should read that way).
  const effectiveTwinBucket = (
    {
      hourly: 'hour',
      daily: 'day',
      weekly: 'week',
      monthly: 'month',
    } as const
  )[(twinWindow.data?._resolution as 'hourly' | 'daily' | 'weekly' | 'monthly') ?? 'daily'];

  const router = useRouter();

  // Open the same FaultExplanationDrawer as the Faults page, single source of
  // truth for fault narratives so a click from Overview and a click from
  // Faults never disagree on the same fault's likely cause.
  const [drawerFault, setDrawerFault] = useState<FaultDetails | null>(null);
  const handleAlarmClick = (alarm: import('@/components/ops/AlarmStack').AlarmRow) => {
    const raw = alarm.raw as PredictiveAlarm | undefined;
    if (!raw) return;
    const pf = faultsJson.data?.predictive_faults.find((f) => f.id === raw.id);
    if (!pf) return;
    const sev: FaultDetails['severity'] =
      pf.urgency === 'critical' || pf.urgency === 'urgent'
        ? 'critical'
        : pf.urgency === 'soon'
          ? 'medium'
          : 'low';
    setDrawerFault({
      fault_type: pf.fault_type,
      display_name: pf.display_name,
      classification_layer: pf.classification_layer ?? 'RULE',
      cascade_winning_confidence: pf.cascade_winning_confidence ?? 0,
      evidence:
        pf.evidence ?? pf.winner_reason ?? '',
      layer_chain: pf.classification_layer
        ? [{
            layer: pf.classification_layer,
            confidence: pf.cascade_winning_confidence ?? 0,
            evidence: pf.evidence ?? pf.winner_reason ?? '',
          }]
        : undefined,
      asset_id: pf.equipment_id,
      severity: sev,
      eta_days: pf.days_to_fault,
    });
  };
  // Keep the original "create ticket and route there" path available via the
  // drawer's Draft-ticket button (the drawer handles that internally).
  void router;
  const lossWaterfall = buildLossWaterfall(fleet.data, faultsJson.data, ytdWindow.data);

  const aiPlantData = useMemo(() => {
    if (!summary.data || !fleet.data) return null;
    return {
      plantName,
      capacity_MW: summary.data.plantInfo.capacity_MW,
      fleetSoiling: {
        srMean: fleet.data.fleetSoiling.srMean,
        srMin: fleet.data.fleetSoiling.srMin,
        srMax: fleet.data.fleetSoiling.srMax,
      },
      fleetLosses: {
        totalSoilingLoss_MWh: fleet.data.fleetLosses.totalSoilingLoss_MWh,
        totalLoss_MWh: fleet.data.fleetLosses.totalLoss_MWh,
      },
      healthDistribution: summary.data.fleetHealth,
      economicImpact: {
        estimatedAnnualLoss_EUR: summary.data.economicImpact.ytdRevenueLoss_EUR,
        cleaningROIPotential_EUR: 0,
      },
    };
  }, [summary.data, fleet.data, plantName]);

  return (
    <div className="space-y-3">
      {/* Telemetry strip, fleet KPIs from ml_plant_summary + fleet_summary */}
      <TelemetryStrip cells={telemetry} />

      {/* Period-scoped power losses, integrated from the twin daily series */}
      {periodKpis.length > 0 && <PeriodKpiStrip items={periodKpis} />}

      {/* Digital twin chart + Active alarms */}
      <div className="ops-grid-2 ops-grid-2-wide">
        <OpsPanel
          label="Digital twin · predicted vs actual power"
          subtitle={
            twinWindow.data
              ? `${twinWindow.data.daily[0]?.date.slice(0, 10)} → ${twinWindow.data.daily[twinWindow.data.daily.length - 1]?.date.slice(0, 10)}${twinCtl.isCustom ? ' · custom' : ''} · drag to zoom`
              : undefined
          }
          meta={
            <span className="flex items-center gap-3">
              <span style={{ color: 'var(--ops-dim)' }}>{plantTzLabel(plantTz)}</span>
              <LiveBadge />
              {twinWindow.data && (
                <>
                  <span>
                    EXP <span style={{ color: 'var(--ops-txt)' }}>{twinWindow.data.summary.total_predicted_mwh.toFixed(1)}</span>MWh
                  </span>
                  <span>
                    ACT <span style={{ color: 'var(--ops-ok)' }}>{twinWindow.data.summary.total_actual_mwh.toFixed(1)}</span>MWh
                  </span>
                  <span>
                    Δ <span style={{ color: 'var(--ops-alarm)' }}>{twinWindow.data.summary.avg_loss_pct.toFixed(1)}%</span>
                  </span>
                </>
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
          {displayTwinSeries ? (
            <div style={{ opacity: twinWindow.loading ? 0.55 : 1, transition: 'opacity 150ms' }}>
              <OpsLineChart
                series={[
                  { key: 'expected', label: 'Expected', tone: 'muted', dashed: true, values: displayTwinSeries.expected },
                  { key: 'actual', label: 'Actual', tone: 'ok', values: displayTwinSeries.actual },
                ]}
                xLabels={displayTwinSeries.xLabels}
                xTooltipLabels={displayTwinSeries.xTooltipLabels}
                yLabels={displayTwinSeries.yLabels}
                formatValue={displayTwinSeries.formatValue}
                onBrush={handleTwinBrush}
              />
            </div>
          ) : twinWindow.loading ? (
            <EmptyState message="loading digital twin trajectory…" />
          ) : (
            <EmptyState message={`no digital twin data for ${plantId}`} />
          )}
          {/* One-line model fit summary, deep metrics live in the
              collapsible "Model diagnostics" panel at the bottom. */}
          {twin.data && <ModelFitSummary twin={twin.data} />}
        </OpsPanel>

        <OpsPanel
          label="Active alarms"
          meta={
            faultsJson.data ? (
              <span style={{ color: 'var(--ops-alarm)' }}>
                {faultsJson.data.summary.critical_count} CRIT · {faultsJson.data.summary.urgent_count} URG ·{' '}
                {faultsJson.data.summary.soon_count} SOON
              </span>
            ) : (
              <span style={{ color: 'var(--ops-muted)' }}>loading…</span>
            )
          }
          flush
        >
          {faultsJson.loading ? (
            <EmptyState message="loading faults…" />
          ) : alarms.length > 0 ? (
            <AlarmStack alarms={alarms} compact onAlarmClick={handleAlarmClick} />
          ) : (
            <EmptyState message="No active alarms · all systems nominal" />
          )}
        </OpsPanel>
      </div>

      {/* Inverter groups grid, real groups + click-through to /group/[slug] */}
      <OpsPanel
        label={
          <>
            Inverter groups{' '}
            <span style={{ color: 'var(--ops-dim)' }}>· {groups?.length ?? 0} groups</span>
          </>
        }
        subtitle="Drill into a group, then an inverter, for per-device twins"
        meta={<span>click into a group →</span>}
      >
        {groupsLoading ? (
          <EmptyState message="loading groups…" />
        ) : groups && groups.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {groups.map((g) => (
              <Link
                key={g.id}
                href={`/demo/plant/${plantId}/group/${g.slug}`}
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
                <div className="mt-2 flex items-center justify-end text-[10px]" style={{ color: 'var(--ops-info)' }}>
                  view group <ArrowRight className="ml-1 h-3 w-3" />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState message={`no inverter groups configured for ${plantId}`} />
        )}
      </OpsPanel>

      {/* Fleet health, single source of truth for per-inverter severity.
          Replaces the prior Plant Health donut, whose urgency-bucket counts
          (3 active faults) collided with this panel's fleet-wide severity
          counts (120 inverters) under the same "Critical" label. Active-alarm
          urgency now lives only in the Alarm Stack below. */}
      {summary.data && (
        <OpsPanel
          label="Fleet health"
          meta={
            <span className="inline-flex items-center gap-3">
              <span>{summary.data.plantInfo.totalInverters} inverters</span>
              <Link
                href={`/demo/plant/${plantId}/faults`}
                className="inline-flex items-center gap-1 text-[11px]"
                style={{ color: 'var(--ops-info)' }}
              >
                View faults <ArrowRight className="h-3 w-3" />
              </Link>
            </span>
          }
        >
          <div className="flex items-center gap-6">
            <HealthRing
              score={deriveFleetHealthScore(summary.data.fleetHealth)}
              subtitle="health"
            />
            <div className="flex-1">
              <HealthDistribution data={summary.data.fleetHealth} />
            </div>
          </div>
        </OpsPanel>
      )}

      {/* Loss disaggregation waterfall */}
      {lossWaterfall && (
        <OpsPanel
          label={
            <span
              className="inline-flex items-center gap-1.5"
              title={LOSS_ATTRIBUTION_BLURB}
            >
              Loss disaggregation · YTD
              <span
                aria-hidden
                className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border text-[9px] font-mono"
                style={{
                  borderColor: 'var(--ops-row-hair)',
                  color: 'var(--ops-muted)',
                }}
              >
                i
              </span>
            </span>
          }
          meta={
            <span>
              Reference{' '}
              <span style={{ color: 'var(--ops-txt)' }}>
                {Math.round(lossWaterfall.referenceMwh).toLocaleString()}
              </span>{' '}
              MWh → Net{' '}
              <span style={{ color: 'var(--ops-ok)' }}>
                {Math.round(lossWaterfall.netMwh).toLocaleString()}
              </span>{' '}
              MWh
            </span>
          }
        >
          <OpsWaterfallChart
            start={{ label: 'Reference', value: lossWaterfall.referenceMwh }}
            deltas={lossWaterfall.deltas}
            end={{ label: 'Net' }}
            unit="MWh"
          />
          <div
            className="mt-2 font-mono text-[10px] leading-snug"
            style={{ color: 'var(--ops-muted)' }}
          >
            {LOSS_ATTRIBUTION_BLURB}
          </div>
        </OpsPanel>
      )}

      {/* Predictive faults, its own row now that Fleet health absorbed the
          Health Distribution panel and the Plant Health donut is gone. */}
      {faultsJson.data?.predictive_faults?.length ? (
        <OpsPanel
          label="Predictive faults · top by revenue at risk"
          meta={
            <Link
              href={`/demo/plant/${plantId}/faults`}
              className="inline-flex items-center gap-1 text-[11px]"
              style={{ color: 'var(--ops-info)' }}
            >
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          }
          flush
        >
          <OpsTable
            columns={[
              { key: 'asset', label: 'Asset', render: (r) => <span className="ops-num">{r.equipment_id}</span>, weight: 1 },
              { key: 'type', label: 'Fault', render: (r) => r.display_name, weight: 1.5 },
              { key: 'days', label: 'Days', numeric: true, render: (r) => r.days_to_fault },
              { key: 'rev', label: '€ RISK', numeric: true, render: (r) =>
                `€${Math.round(r.revenue_at_risk_eur).toLocaleString()}` },
            ]}
            rows={faultsJson.data.predictive_faults?.slice(0, 5) ?? []}
            status={(r) => urgencyTone(r.urgency)}
          />
        </OpsPanel>
      ) : (
        <OpsPanel label="Predictive faults">
          <EmptyState message="no predictive faults detected" />
        </OpsPanel>
      )}

      {/* Top / Worst performers, click through to inverter detail */}
      <div className="ops-grid-2">
        <OpsPanel label="Top performers · soiling" flush>
          {topWorst.top.length > 0 ? (
            <OpsTable
              columns={[
                { key: 'rank', label: '#', render: (r, i) => i + 1, weight: 0.3 },
                {
                  key: 'inv',
                  label: 'Inverter',
                  render: (r) => <span className="ops-num">{r.inverterId}</span>,
                  weight: 1.4,
                },
                { key: 'sr', label: 'SR %', numeric: true, render: (r) => `${(r.sr * 100).toFixed(1)}` },
                { key: 'loss', label: 'Loss %', numeric: true, render: (r) => `${(r.loss * 100).toFixed(1)}` },
              ]}
              rows={topWorst.top}
              status={() => 'ok'}
              rowHref={(r) => `/demo/plant/${plantId}/inverter/${encodeURIComponent(r.inverterId)}`}
            />
          ) : (
            <EmptyState message="No per-inverter data available for this plant" />
          )}
        </OpsPanel>

        <OpsPanel label="Worst performers · soiling" flush>
          {topWorst.worst.length > 0 ? (
            <OpsTable
              columns={[
                { key: 'rank', label: '#', render: (r, i) => i + 1, weight: 0.3 },
                {
                  key: 'inv',
                  label: 'Inverter',
                  render: (r) => <span className="ops-num">{r.inverterId}</span>,
                  weight: 1.4,
                },
                { key: 'sr', label: 'SR %', numeric: true, render: (r) => `${(r.sr * 100).toFixed(1)}` },
                { key: 'loss', label: 'Loss %', numeric: true, render: (r) => `${(r.loss * 100).toFixed(1)}` },
              ]}
              rows={topWorst.worst}
              status={(r) => (r.severity === 'critical' ? 'alarm' : r.severity === 'major' ? 'warn' : 'info')}
              rowHref={(r) => `/demo/plant/${plantId}/inverter/${encodeURIComponent(r.inverterId)}`}
            />
          ) : (
            <EmptyState message="No per-inverter data available for this plant" />
          )}
        </OpsPanel>
      </div>

      {/* AI Insights card */}
      {aiPlantData && <AiInsightsCard plantId={plantId} plantData={aiPlantData} />}

      {/* Deep model diagnostics, collapsed by default. */}
      {twin.data && <ModelDiagnosticsPanel twin={twin.data} />}

      <OpsFooter
        pulseLabel="SCADA nominal"
        metrics={[
          {
            label: 'YTD loss',
            value: summary.data
              ? `${Math.round(summary.data.economicImpact.ytdEnergyLoss_MWh).toLocaleString()}`
              : ',',
            unit: 'MWh',
          },
          {
            label: 'YTD €',
            value: summary.data
              ? `€${Math.round(summary.data.economicImpact.ytdRevenueLoss_EUR / 1000)}k`
              : ',',
          },
          {
            label: 'Last sync',
            value: summary.data
              ? new Date(summary.data.currentStatus.lastUpdateTime).toLocaleDateString()
              : ',',
            valueColor: 'var(--ops-txt)',
          },
        ]}
        buildTag={twin.data ? `model v${twin.data.statistics.plantModelR2.toFixed(2)}` : 'v2.4.1'}
      />
      <FaultExplanationDrawer
        fault={drawerFault}
        plantId={plantId}
        open={!!drawerFault}
        onClose={() => setDrawerFault(null)}
      />
    </div>
  );
}

// ============================ Constants

const LOSS_ATTRIBUTION_BLURB =
  "Loss attribution: digital-twin residual decomposed by fault classifier. Soiling shown when DustIQ provides ground truth; otherwise rolled into model gap. We don't fabricate categories from textbook losses.";

// ============================ Helpers + small components

function EmptyState({ message }: { message: string }) {
  return (
    <div
      className="flex h-32 items-center justify-center px-3 text-center font-mono text-[11px] italic"
      style={{ color: 'var(--ops-muted)' }}
    >
      {message}
    </div>
  );
}

/**
 * One-line model fit summary shown directly beneath the twin chart.
 * Surfaces the headline R² and a plain-English tracking band; defers
 * deep metrics (Physics R², ML uplift, MAE) to ModelDiagnosticsPanel.
 */
function ModelFitSummary({ twin }: { twin: DigitalTwinSummary }) {
  const r2 = twin.statistics.plantModelR2;
  // Loose mapping from R² to a tracking band, keeps it readable for
  // operators without misrepresenting the metric.
  const pct = Math.max(0, Math.min(100, r2 * 100));
  const within = r2 >= 0.95 ? '5%' : r2 >= 0.9 ? '10%' : r2 >= 0.8 ? '20%' : '>20%';
  return (
    <div
      className="mt-3 flex items-center justify-between rounded-sm border px-3 py-2 font-mono text-[11px]"
      style={{
        borderColor: 'var(--ops-row-hair)',
        background: 'var(--ops-panel-2)',
        color: 'var(--ops-txt)',
      }}
    >
      <span>
        Twin tracking actual to within{' '}
        <span className="ops-num" style={{ color: 'var(--ops-ok)' }}>
          {within}
        </span>
      </span>
      <span style={{ color: 'var(--ops-muted)' }}>
        R² <span className="ops-num" style={{ color: 'var(--ops-bright)' }}>{r2.toFixed(3)}</span>{' '}
        <span style={{ color: 'var(--ops-dim)' }}>({pct.toFixed(1)}%)</span>
      </span>
    </div>
  );
}

/**
 * Collapsible deep-diagnostics panel. Default collapsed; toggles via
 * lucide ChevronDown/ChevronUp. Hosts the existing ModelMetricsBand
 * plus training period + ensemble counts.
 */
function ModelDiagnosticsPanel({ twin }: { twin: DigitalTwinSummary }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div
      className="rounded-sm border"
      style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-[11.5px]"
        style={{ color: 'var(--ops-label)' }}
        aria-expanded={open}
      >
        <span>Model diagnostics</span>
        <span className="flex items-center gap-1" style={{ color: 'var(--ops-muted)' }}>
          {open ? 'hide' : 'show'}
          <Chevron size={14} strokeWidth={1.6} aria-hidden />
        </span>
      </button>
      {open && (
        <div
          className="border-t px-3 pb-3 pt-2"
          style={{ borderColor: 'var(--ops-row-hair)' }}
        >
          <ModelMetricsBand twin={twin} />
          <div
            className="mt-2 grid grid-cols-2 gap-3 font-mono text-[10.5px] sm:grid-cols-4"
            style={{ color: 'var(--ops-muted)' }}
          >
            <div>
              <div style={{ color: 'var(--ops-label)' }}>Model type</div>
              <div className="ops-num" style={{ color: 'var(--ops-txt)' }}>{twin.modelType}</div>
            </div>
            <div>
              <div style={{ color: 'var(--ops-label)' }}>Inverters</div>
              <div className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                {twin.statistics.successful}/{twin.statistics.totalInverters}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--ops-label)' }}>Training start</div>
              <div className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                {new Date(twin.trainingPeriod.start).toLocaleDateString()}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--ops-label)' }}>Training end</div>
              <div className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                {new Date(twin.trainingPeriod.end).toLocaleDateString()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelMetricsBand({ twin }: { twin: DigitalTwinSummary }) {
  return (
    <div
      className="mt-3 grid grid-cols-4 gap-2 rounded-sm border p-2 font-mono text-[10.5px]"
      style={{ borderColor: 'var(--ops-row-hair)', background: 'var(--ops-panel-2)' }}
    >
      <Metric label="Plant R²" value={twin.statistics.plantModelR2.toFixed(3)} tone="ok" />
      <Metric label="Physics R²" value={twin.statistics.physicsOnlyR2.toFixed(3)} />
      <Metric
        label="ML uplift"
        value={`+${((twin.statistics.plantModelR2 - twin.statistics.physicsOnlyR2) * 100).toFixed(1)}%`}
        tone="info"
      />
      <Metric label="MAE" value={`${twin.statistics.avgMAE_kW.toFixed(3)} kW`} />
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: StatusTone }) {
  return (
    <div>
      <div style={{ color: 'var(--ops-label)' }}>{label}</div>
      <div
        className="ops-num text-[14px]"
        style={{
          color: tone === 'ok' ? 'var(--ops-ok)' : tone === 'info' ? 'var(--ops-info)' : 'var(--ops-bright)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Derive a 0-100 health score from the same fleetHealth bucket counts the
 * distribution chart renders, so the donut ring and the bars can never tell
 * conflicting stories. Each severity bucket carries a weighted deduction.
 */
export function deriveFleetHealthScore(data: {
  normalInverters: number;
  minorIssues: number;
  majorIssues: number;
  critical: number;
}): number {
  const total =
    data.normalInverters + data.minorIssues + data.majorIssues + data.critical;
  if (total <= 0) return 100;
  const deduction =
    (data.critical * 0.5 + data.majorIssues * 0.1 + data.minorIssues * 0.05) *
    (100 / total);
  return Math.max(0, Math.min(100, Math.round(100 - deduction)));
}

function HealthDistribution({
  data,
}: {
  data: { normalInverters: number; minorIssues: number; majorIssues: number; critical: number };
}) {
  const total = data.normalInverters + data.minorIssues + data.majorIssues + data.critical || 1;
  const rows: Array<{ label: string; count: number; tone: StatusTone }> = [
    { label: 'Normal', count: data.normalInverters, tone: 'ok' },
    { label: 'Minor', count: data.minorIssues, tone: 'info' },
    { label: 'Major', count: data.majorIssues, tone: 'warn' },
    { label: 'Critical', count: data.critical, tone: 'alarm' },
  ];
  const TONE_VAR: Record<StatusTone, string> = {
    ok: 'var(--ops-ok)',
    warn: 'var(--ops-warn)',
    alarm: 'var(--ops-alarm)',
    info: 'var(--ops-info)',
    bess: 'var(--ops-bess)',
    muted: 'var(--ops-muted)',
  };
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-baseline justify-between font-mono text-[11.5px]">
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ops-muted)' }}>
              <StatusLed tone={r.tone} size={6} /> {r.label}
            </span>
            <span className="ops-num" style={{ color: 'var(--ops-txt)' }}>
              {r.count} <span style={{ color: 'var(--ops-dim)' }}>· {((r.count / total) * 100).toFixed(1)}%</span>
            </span>
          </div>
          <div className="h-[7px] overflow-hidden rounded" style={{ background: 'var(--ops-row-hair)' }}>
            <div className="h-full" style={{ width: `${(r.count / total) * 100}%`, background: TONE_VAR[r.tone] }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================ Data builders

function buildTelemetry(
  summary: MlPlantSummary | null,
  fleet: FleetSummary | null,
  capacityMW?: number
): import('@/components/ops/TelemetryStrip').TelemetryCell[] {
  const cap = summary?.plantInfo.capacity_MW ?? capacityMW ?? 0;
  const sr = summary?.currentStatus.avgSoilingRatio;
  const lossPct = summary?.currentStatus.estimatedLossPct;
  const validation = summary?.currentStatus.validation;
  const mlMae = validation?.mae ?? validation?.validation_mae;
  const mlR2 = validation?.r_squared ?? validation?.validation_r2;
  return [
    {
      label: 'Capacity',
      value: cap.toFixed(1),
      unit: 'MW',
      tone: 'neutral',
      footer: summary ? `${summary.plantInfo.totalInverters} inverters` : '',
    },
    {
      label: 'Soiling ratio',
      value: sr != null ? (sr * 100).toFixed(1) : ',',
      unit: '%',
      tone: sr != null && sr > 0.94 ? 'ok' : 'warn',
      footer: lossPct != null ? `${lossPct.toFixed(2)}% loss` : '',
    },
    {
      label: 'Fleet SR mean',
      value: fleet ? (fleet.fleetSoiling.srMean * 100).toFixed(1) : ',',
      unit: '%',
      tone: 'neutral',
      footer: fleet ? `std ${(fleet.fleetSoiling.srStd * 100).toFixed(1)}%` : '',
    },
    {
      label: 'Fleet SR min',
      value: fleet ? (fleet.fleetSoiling.srMin * 100).toFixed(1) : ',',
      unit: '%',
      tone: 'warn',
      footer: fleet ? `max ${(fleet.fleetSoiling.srMax * 100).toFixed(1)}%` : '',
    },
    {
      label: 'YTD energy loss',
      value: summary ? Math.round(summary.economicImpact.ytdEnergyLoss_MWh).toLocaleString() : ',',
      unit: 'MWh',
      tone: 'warn',
      footer: 'vs reference',
    },
    {
      label: 'YTD revenue loss',
      value: summary ? `€${Math.round(summary.economicImpact.ytdRevenueLoss_EUR / 1000)}` : ',',
      unit: 'k',
      tone: 'alarm',
      footer: 'foregone',
    },
    {
      label: 'ML MAE',
      value: mlMae != null ? (mlMae * 100).toFixed(2) : ',',
      unit: '%',
      tone: mlMae != null && mlMae < 0.02 ? 'ok' : 'warn',
      footer: mlR2 != null ? `R² ${mlR2.toFixed(3)}` : '',
    },
    {
      label: 'Payback',
      value: summary?.economicImpact.paybackDays?.toString() ?? ',',
      unit: 'd',
      tone: 'neutral',
      footer: summary?.economicImpact.estimatedROI_pct
        ? `ROI ${summary.economicImpact.estimatedROI_pct.toFixed(0)}%`
        : '',
    },
  ];
}

function buildAlarms(
  faults: FaultsEnhanced | null
): import('@/components/ops/AlarmStack').AlarmRow[] {
  if (!faults?.predictive_faults) return [];
  return faults.predictive_faults.slice(0, 8).map((f) => {
    const raw: PredictiveAlarm = {
      id: f.id,
      fault_type: f.fault_type,
      display_name: f.display_name,
      equipment_id: f.equipment_id,
      days_to_fault: f.days_to_fault,
      urgency: f.urgency,
      revenue_at_risk_eur: f.revenue_at_risk_eur,
      projected_energy_loss_kwh: f.projected_energy_loss_kwh,
      classification_layer: f.classification_layer,
      evidence: f.evidence,
      winner_reason: f.winner_reason,
    };
    return {
      id: f.id,
      asset: f.equipment_id,
      message: f.display_name,
      age: `${Math.max(0, f.days_to_fault)}d`,
      severity:
        f.urgency === 'critical'
          ? 'critical'
          : f.urgency === 'urgent' || f.urgency === 'soon'
            ? 'warning'
            : 'info',
      ackable: true,
      raw,
      classificationLayer: f.classification_layer,
      evidence: f.evidence,
      winnerReason: f.winner_reason,
      confidence: f.cascade_winning_confidence,
    };
  });
}

function buildTopWorst(
  summary: MlPlantSummary | null,
  inverters: { inverters: InverterRow[] } | null
): {
  top: Array<{ inverterId: string; sr: number; loss: number; severity: string }>;
  worst: Array<{ inverterId: string; sr: number; loss: number; severity: string }>;
} {
  // Prefer summary-supplied rankings when present.
  // Drop entries with non-finite SR (e.g. plants whose summary JSON lacks the
  // expected schema) so we surface an empty state instead of "NaN%" rows.
  if (summary?.topPerformers?.length || summary?.worstPerformers?.length) {
    // Accept both fixture shapes:
    //   canonical: { inverterId, srMean, rank }
    //   legacy:    { id, sr, loss_pct }
    //, gamma/delta/zeta/epsilon still ship the legacy shape.
    const normalize = (p: any) => {
      const inverterId = p?.inverterId ?? p?.id;
      const sr = typeof p?.srMean === 'number' ? p.srMean : typeof p?.sr === 'number' ? p.sr : NaN;
      if (!inverterId || !Number.isFinite(sr)) return null;
      const loss =
        typeof p?.loss_pct === 'number' ? p.loss_pct / 100 : 1 - sr;
      return { inverterId, sr, loss, severity: 'normal' };
    };
    const top = (summary.topPerformers ?? [])
      .slice(0, 5)
      .map(normalize)
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const worst = (summary.worstPerformers ?? [])
      .slice(0, 5)
      .map(normalize)
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (top.length || worst.length) return { top, worst };
    // fall through to per-inverter computation if every summary row was invalid
  }
  // Compute from per-inverter data
  if (!inverters?.inverters?.length) return { top: [], worst: [] };
  const sorted = [...inverters.inverters].sort((a, b) => b.soilingRatio.mean - a.soilingRatio.mean);
  const top = sorted.slice(0, 5).map((inv) => ({
    inverterId: inv.inverterId,
    sr: inv.soilingRatio.mean,
    loss: inv.powerLoss,
    severity: inv.fleetComparison.severity,
  }));
  const worst = sorted
    .slice(-5)
    .reverse()
    .map((inv) => ({
      inverterId: inv.inverterId,
      sr: inv.soilingRatio.mean,
      loss: inv.powerLoss,
      severity: inv.fleetComparison.severity,
    }));
  return { top, worst };
}

function buildLossWaterfall(
  fleet: FleetSummary | null,
  faults: FaultsEnhanced | null,
  ytdWindow: TwinWindowResponse | null,
): { referenceMwh: number; netMwh: number; deltas: import('@/components/ops/charts/OpsWaterfallChart').WaterfallDelta[] } | null {
  if (!fleet) return null;
  const ref = fleet.fleetLosses.referenceEnergy_MWh;

  // True measured residual = reference − actual measured net (from SCADA via
  // the digital-twin YTD window, anchored to the plant's data end). This is
  // what the waterfall must close to. Fall back to fleet.totalLoss_MWh when
  // twin data is absent.
  const measuredResidual =
    ytdWindow && ytdWindow.summary.measured_days > 0
      ? ytdWindow.summary.total_loss_mwh
      : fleet.fleetLosses.totalLoss_MWh;

  const deltas: import('@/components/ops/charts/OpsWaterfallChart').WaterfallDelta[] = [];
  const faultsByType = fleet.fleetLosses.faults_by_type;
  const dustiqMwh = fleet.fleetLosses.dustiq_soiling_ytd_mwh;
  const hasEnrichedAttribution =
    (faultsByType && Object.keys(faultsByType).length > 0) || dustiqMwh != null;

  if (hasEnrichedAttribution) {
    // New twin-residual + classifier attribution path.
    let sumAttributed = 0;

    // DustIQ ground-truth soiling first, when measured.
    if (dustiqMwh != null && dustiqMwh > 0) {
      deltas.push({
        label: 'Soiling (DustIQ)',
        value: -dustiqMwh,
        tone: 'warn',
        confidence: 'direct measurement',
        source: 'DustIQ',
      });
      sumAttributed += dustiqMwh;
    }

    // Per-fault-type classifier attributions, sorted desc by MWh, top 6.
    // When DustIQ provides ground-truth soiling, drop any soiling-shaped
    // classifier rows to prevent the same physical loss being counted twice
    // (once via DustIQ, once via the fault-classifier event roll-up).
    if (faultsByType) {
      // When DustIQ provides ANY measurement (including negative, modules
      // cleaner than reference after rain), it is the canonical soiling source.
      // The classifier's soiling_detected events are noisy reactive fault
      // counts; drop them to avoid double-counting against the DustIQ bar.
      const dropSoilingDup = dustiqMwh != null && Number.isFinite(dustiqMwh);
      const sortedFaults = Object.entries(faultsByType)
        .filter(([key, v]) => v && v.ytd_mwh > 0 && !(dropSoilingDup && /soiling/i.test(key)))
        .sort((a, b) => b[1].ytd_mwh - a[1].ytd_mwh)
        .slice(0, 6);
      for (const [faultType, info] of sortedFaults) {
        deltas.push({
          label: prettify(faultType),
          value: -info.ytd_mwh,
          tone: severityFor(faultType),
          confidence: 'classifier attribution',
          source: `${info.count} fault${info.count === 1 ? '' : 's'}`,
        });
        sumAttributed += info.ytd_mwh;
      }
    }

    // Closing residual = whatever the twin says we lost minus what we attributed.
    // Only show when positive, never invent a fake "gain" bar.
    const modelGap = measuredResidual - sumAttributed;
    if (modelGap > 0.5) {
      deltas.push({
        label: 'Model gap',
        value: -modelGap,
        tone: 'muted',
        confidence: 'residual',
        source: 'unexplained',
      });
    }
  } else {
    // Backwards compat: legacy 3-bar behavior for fixtures without the new
    // attribution fields (e.g. gamma, delta, zeta, epsilon).
    const soiling = fleet.fleetLosses.totalSoilingLoss_MWh;
    const faultLossMwh = faults ? faults.summary.current_loss_kwh / 1000 : 0;
    const attributed = soiling + faultLossMwh;
    const unexplained = Math.max(0, measuredResidual - attributed);

    if (soiling > 0) deltas.push({ label: 'Soiling', value: -soiling, tone: 'warn' });
    if (faultLossMwh > 0) deltas.push({ label: 'Faults (curr)', value: -faultLossMwh, tone: 'alarm' });
    if (unexplained > 0.5) {
      deltas.push({ label: 'Model error / Unexplained', value: -unexplained, tone: 'muted' });
    }
  }

  const netMwh = ref - measuredResidual;
  return { referenceMwh: ref, netMwh, deltas };
}

/**
 * Convert a snake_case fault type into a human label.
 *   "string_degradation" → "String degradation"
 *   "inverter_overtemperature" → "Inverter overtemperature"
 */
function prettify(faultType: string): string {
  if (!faultType) return 'Unknown';
  const spaced = faultType.replace(/_/g, ' ').trim();
  if (!spaced.length) return 'Unknown';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Map fault types to ops tones. Critical electrical/safety failures → alarm,
 * degradations and protection-actions → warn, soiling-flavoured → warn,
 * everything else falls back to info.
 */
function severityFor(faultType: string): StatusTone {
  const k = (faultType || '').toLowerCase();
  if (
    k.includes('failure') ||
    k.includes('short') ||
    k.includes('arc') ||
    k.includes('ground_fault') ||
    k.includes('insulation')
  ) {
    return 'alarm';
  }
  if (
    k.includes('overtemperature') ||
    k.includes('overtemp') ||
    k.includes('degradation') ||
    k.includes('bypass_diode') ||
    k.includes('mismatch') ||
    k.includes('underperform')
  ) {
    return 'warn';
  }
  if (k.includes('soiling') || k.includes('dust')) {
    return 'warn';
  }
  return 'info';
}

function urgencyTone(urgency: string): StatusTone {
  switch (urgency) {
    case 'critical':
      return 'alarm';
    case 'urgent':
    case 'soon':
      return 'warn';
    case 'planned':
      return 'info';
    case 'monitoring':
      return 'muted';
    default:
      return 'info';
  }
}
