'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Battery, Wind, ArrowLeft } from 'lucide-react';
import { usePlantGroups } from '@/hooks/usePlantGroups';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { useDataRoot } from '@/contexts/DataSourceContext';
import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import OpsTable from '@/components/ops/OpsTable';
import OpsFooter from '@/components/ops/OpsFooter';
import OpsSparkline from '@/components/ops/charts/OpsSparkline';
import type { StatusTone } from '@/components/ops/StatusLed';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

interface InverterMetric {
  inverterId: string;
  groupId?: string;
  performanceRatio: number;
  powerLoss: number; // fraction
  soilingRatio: { mean: number; std: number } | number;
  fleetComparison: { severity: string; zScore: number };
  daysWithData?: number;
  avgPredicted?: number;
  avgActual?: number;
  rank?: number;
  zScore?: number;
}

const SEV_TO_TONE: Record<string, StatusTone> = {
  normal: 'ok',
  minor: 'info',
  major: 'warn',
  critical: 'alarm',
};

export default function GroupDetailPage() {
  const params = useParams();
  const plantId = params.plantId as string;
  const groupId = decodeURIComponent(params.groupId as string);

  const { plants } = useDemoPlants();
  const { groups } = usePlantGroups(plantId);
  const [allInverters, setAllInverters] = useState<InverterMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();

  const plant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const group = groups.find((g) => g.slug === groupId || g.name === groupId);
  const assetType = plant?.asset_type;

  useEffect(() => {
    setLoading(true);
    // Static fixtures only exist for demo/showcase plants; on /dashboard a real
    // plant with no inverter-metrics just shows the empty state (no /data 404).
    const loadStatic = () => {
      if (prefix === '/dashboard') {
        setLoading(false);
        return;
      }
      return fetch(`${dataRoot}/soiling/${plantId}/all_inverters.json`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (json?.inverters) setAllInverters(json.inverters);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    };

    fetch(`/api/digitaltwin/${plantId}/inverter-metrics?spark=7`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.inverters?.length) {
          setAllInverters(
            json.inverters.map((inv: any) => ({
              inverterId: inv.inverterId,
              groupId: '',
              performanceRatio: inv.performanceRatio ?? 0.86,
              powerLoss: (inv.lossPct ?? 0) / 100,
              soilingRatio: { mean: inv.performanceRatio ?? 0.86, std: 0.03 },
              fleetComparison: {
                severity: inv.severity ?? 'normal',
                zScore: inv.zScore ?? 0,
              },
              daysWithData: inv.daysWithData,
              avgPredicted: inv.avgPredicted,
              avgActual: inv.avgActual,
              rank: inv.rank,
              spark: inv.spark,
            }))
          );
          setLoading(false);
        } else {
          return loadStatic();
        }
      })
      .catch(() => loadStatic());
  }, [plantId, dataRoot, prefix]);

  const groupInverters = useMemo(() => {
    if (!group || allInverters.length === 0) return [];
    const inverterSet = new Set(group.inverterIds);
    return allInverters
      .filter((inv) => inverterSet.has(inv.inverterId))
      .sort((a, b) => a.inverterId.localeCompare(b.inverterId));
  }, [group, allInverters]);

  const kpis = useMemo(() => {
    if (groupInverters.length === 0) return null;
    const prs = groupInverters.map((i) => i.performanceRatio).filter((v) => v != null);
    const losses = groupInverters.map((i) => i.powerLoss).filter((v) => v != null);
    const avgPR = prs.length > 0 ? prs.reduce((a, b) => a + b, 0) / prs.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const critical = groupInverters.filter((i) => i.fleetComparison?.severity === 'critical').length;
    const major = groupInverters.filter((i) => i.fleetComparison?.severity === 'major').length;
    const minor = groupInverters.filter((i) => i.fleetComparison?.severity === 'minor').length;
    const srMean =
      groupInverters
        .map((i) => (typeof i.soilingRatio === 'number' ? i.soilingRatio : i.soilingRatio.mean))
        .reduce((a, b) => a + b, 0) / groupInverters.length;
    return { avgPR, avgLoss, critical, major, minor, srMean, total: groupInverters.length };
  }, [groupInverters]);

  // Soft empty state for BESS/wind plants
  if (assetType && assetType !== 'PV' && assetType !== 'SOLAR') {
    const Icon = assetType === 'BESS' ? Battery : Wind;
    const assetLabel = assetType === 'BESS' ? 'battery storage' : 'wind';
    return (
      <OpsShell
        plantId={plantId}
        activeNavKey="overview"
        commandBar={{
          section: 'GROUP',
          sectionTone: 'muted',
          plantLabel: (plant?.name ?? plantId).toUpperCase(),
          assetChip: assetType,
          conn: 'ok',
          pollSeconds: 2,
          userInitials: 'AM',
        }}
      >
        <OpsPanel label="Group data unavailable">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Icon className="mb-4 h-10 w-10" style={{ color: 'var(--ops-muted)' }} />
            <div className="font-mono text-[12px]" style={{ color: 'var(--ops-bright)' }}>
              Inverter group view is not applicable here
            </div>
            <div className="mt-2 max-w-md font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
              {plant?.name} is a {assetLabel} plant, it doesn&apos;t use inverter groups.
            </div>
            <Link
              href={`${prefix}/plant/${plantId}`}
              className="mt-5 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-[11px]"
              style={{
                color: 'var(--ops-info)',
                background: 'var(--ops-ack-bg)',
                borderColor: 'var(--ops-ack-border)',
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to {plant?.name ?? 'plant'}
            </Link>
          </div>
        </OpsPanel>
      </OpsShell>
    );
  }

  const plantLabel = (plant?.name ?? plantId).toUpperCase();
  const groupName = group?.name ?? groupId;

  return (
    <OpsShell
      plantId={plantId}
      activeNavKey="overview"
      commandBar={{
        section: `GROUP / ${groupName.toUpperCase()}`,
        sectionTone: 'info',
        plantLabel,
        assetChip: assetTypeChip(plant?.asset_type),
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      {/* Trail comes from the shell command bar (FLEET / plant / GROUP / name) —
          no page-level breadcrumb needed. */}
      <div className="space-y-3">
        {/* Group telemetry strip */}
        <TelemetryStrip
          columns={6}
          cells={[
            {
              label: 'INVERTERS',
              value: kpis?.total.toString() ?? ',',
              tone: 'neutral',
              footer: group?.inverter_model ?? '',
            },
            {
              label: 'AVG PR',
              value: kpis ? (kpis.avgPR * 100).toFixed(1) : ',',
              unit: '%',
              tone: kpis && kpis.avgPR > 0.85 ? 'ok' : 'warn',
              footer: 'rolling 30-day',
            },
            {
              label: 'AVG LOSS',
              value: kpis ? (kpis.avgLoss * 100).toFixed(1) : ',',
              unit: '%',
              tone: kpis && kpis.avgLoss > 0.05 ? 'warn' : 'neutral',
              footer: 'twin disagreement',
            },
            {
              label: 'MEAN SR',
              value: kpis ? (kpis.srMean * 100).toFixed(1) : ',',
              unit: '%',
              tone: 'neutral',
              footer: 'soiling',
            },
            {
              label: 'CRITICAL',
              value: kpis?.critical.toString() ?? ',',
              tone: kpis && kpis.critical > 0 ? 'alarm' : 'ok',
              footer: 'needs attention',
            },
            {
              label: 'TILT / AZIMUTH',
              value: group ? `${group.tilt}° / ${group.azimuth}°` : ',',
              tone: 'neutral',
              footer: group?.inverter_nominal_power_kw ? `${group.inverter_nominal_power_kw} kW` : '',
            },
          ]}
        />

        {/* Inverter telemetry table, click into inverter detail */}
        <OpsPanel
          label={
            <>
              GROUP.inverter_telemetry{' '}
              <span style={{ color: 'var(--ops-dim)' }}>· {groupInverters.length} units</span>
            </>
          }
          meta={<span>sort: alphabetical · click row → inverter detail</span>}
          flush
        >
          {loading ? (
            <div
              className="flex h-32 items-center justify-center font-mono text-[11px] italic"
              style={{ color: 'var(--ops-muted)' }}
            >
              loading inverter metrics…
            </div>
          ) : groupInverters.length > 0 ? (
            <OpsTable
              columns={[
                {
                  key: 'unit',
                  label: 'UNIT',
                  render: (r) => <span className="ops-num">{r.inverterId}</span>,
                  weight: 1.4,
                },
                {
                  key: 'pr',
                  label: 'PR%',
                  numeric: true,
                  render: (r) => (r.performanceRatio * 100).toFixed(1),
                },
                {
                  key: 'loss',
                  label: 'LOSS%',
                  numeric: true,
                  render: (r) => (r.powerLoss * 100).toFixed(1),
                },
                {
                  key: 'sr',
                  label: 'SR%',
                  numeric: true,
                  render: (r) =>
                    (
                      (typeof r.soilingRatio === 'number'
                        ? r.soilingRatio
                        : r.soilingRatio.mean) * 100
                    ).toFixed(1),
                },
                {
                  key: 'rank',
                  label: 'RANK',
                  numeric: true,
                  render: (r) => r.rank ?? ',',
                },
                {
                  key: 'z',
                  label: 'Z',
                  numeric: true,
                  render: (r) => (r.fleetComparison.zScore ?? 0).toFixed(2),
                },
                {
                  key: 'trend',
                  label: '7d',
                  // Real last-7-day power trend from the daily aggregates;
                  // fixture-only plants have no per-inverter daily series, so
                  // show a dash rather than fake data.
                  render: (r) =>
                    (r as any).spark?.length >= 2 ? (
                      <OpsSparkline values={(r as any).spark} tone="info" height={14} />
                    ) : (
                      <span style={{ color: 'var(--ops-dim)' }}>—</span>
                    ),
                  weight: 0.8,
                },
              ]}
              rows={groupInverters}
              status={(r) => SEV_TO_TONE[r.fleetComparison.severity] ?? 'info'}
              rowHref={(r) => `${prefix}/plant/${plantId}/inverter/${encodeURIComponent(r.inverterId)}`}
            />
          ) : (
            <div
              className="flex h-32 items-center justify-center font-mono text-[11px] italic"
              style={{ color: 'var(--ops-muted)' }}
            >
              no inverter metrics available for this group
            </div>
          )}
        </OpsPanel>

        <OpsFooter
          pulseLabel="GROUP NOMINAL"
          metrics={[
            { label: 'UNITS', value: kpis?.total ?? ',' },
            {
              label: 'CRITICAL',
              value: kpis?.critical ?? ',',
              valueColor: 'var(--ops-alarm)',
            },
            { label: 'MAJOR', value: kpis?.major ?? ',', valueColor: 'var(--ops-warn)' },
            { label: 'MINOR', value: kpis?.minor ?? ',', valueColor: 'var(--ops-info)' },
            { label: 'AVG PR', value: kpis ? `${(kpis.avgPR * 100).toFixed(1)}` : ',', unit: '%' },
          ]}
          buildTag="v2.4.1"
        />
      </div>
    </OpsShell>
  );
}
