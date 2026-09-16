'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import OpsPanel from '@/components/ops/OpsPanel';
import OpsTabs from '@/components/ops/OpsTabs';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import OpsFooter from '@/components/ops/OpsFooter';
import OpsTable from '@/components/ops/OpsTable';
import SrForecastChart from '@/components/ops/charts/SrForecastChart';
import ZoneHeatmap, { HeatLegend } from '@/components/ops/charts/ZoneHeatmap';
import OpsTimeRange, { type TimeRange } from '@/components/ops/OpsTimeRange';
import OpsBarChart from '@/components/ops/charts/OpsBarChart';
import { DEFAULT_TARIFF_EUR_PER_MWH } from '@/lib/config/economics';
import Abbr, { GLOSSARY } from '@/components/ui/AbbrTooltip';

// Phase 12B: bring back the legacy soiling tabs inside ops chrome.
// Full ops re-skin of these components' internals lands in a follow-up
// pass, for now the interactive functionality returns intact.
const DataExplorerChart = dynamic(
  () => import('@/components/soiling/DataExplorerChart'),
  { ssr: false }
);
const ZoneAnalysisTab = dynamic(
  () => import('@/components/soiling/ZoneAnalysisTab'),
  { ssr: false }
);
const CleaningOptimizerTab = dynamic(
  () => import('@/components/soiling/CleaningOptimizerTab'),
  { ssr: false }
);

/**
 * Soiling intelligence body, telemetry strip + 30-day SR forecast + zone
 * heatmap + per-zone cleaning ROI table + cleaning optimiser panel + freshness
 * footer.
 *
 * Every number on this surface traces to an on-disk artifact: the SR forecast
 * (ml_forecast_365d.json), monthly losses (monthly_summary.json), per-inverter
 * SR (all_inverters.json — rendered as measured only when its provenance says
 * measured_per_inverter), and the optimiser teaser (operator_proposal.json,
 * real optimizer output). Missing artifacts render explicit empty states —
 * nothing is synthesized client-side.
 */

interface OpsSoilingProps {
  plantId: string;
}

interface MlForecastJson {
  metadata: {
    plant_id: string;
    model_type?: string;
    model_version?: string;
    is_cold_start?: boolean;
    input_window_days?: number;
    generated_at?: string;
  };
  forecasts: Array<{
    date: string;
    sr_predicted: number;
    sr_lower_bound: number;
    sr_upper_bound: number;
    is_cleaning_needed: boolean;
    soiling_loss_pct: number;
  }>;
}

/** '3d ago' / '7mo ago' from an ISO stamp; '—' when the artifact is absent. */
function relativeAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return 'today';
  if (days < 60) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function isColdStartModel(modelType: string | undefined): boolean {
  if (!modelType) return false;
  // We accept both the prior chronos2 stub (legacy) and the new transfer
  // learning path. Anything starting with `ribera_foundation` or a model
  // type that explicitly names "transfer_learning" is cold-start.
  return (
    modelType.startsWith('chronos2') ||
    modelType.startsWith('ribera_foundation') ||
    modelType.toLowerCase().includes('transfer_learning')
  );
}

interface InverterDatum {
  inverterId: string;
  groupId?: string;
  soilingRatio: { mean: number; std: number };
}
interface AllInvertersJson {
  metadata?: {
    plant_id?: string;
    provenance?: { source?: string; method?: string; data_end?: string; generated_at?: string };
  };
  inverters: InverterDatum[];
}

/** Real cleaning-optimizer output written by the schedule optimizer. */
interface OperatorProposalJson {
  executive_summary?: { expected_net_benefit_EUR?: number; expected_roi_pct?: number };
  optimal_schedule?: {
    cleaning_dates?: string[];
    energy_recovered_MWh?: number;
    cleaning_cost_EUR?: number;
  };
  financial_analysis?: { payback_days?: number };
}

interface GroupDatum {
  id: string;
  name: string;
  slug: string;
  tilt: number;
  azimuth: number;
  inverter_model: string | null;
  inverter_nominal_power_kw: number | null;
  inverters: Array<{ external_id: string; nominal_power_kw: number | null }>;
}
interface InverterGroupsJson {
  inverter_groups: GroupDatum[];
}

interface MlPlantSummaryEconomics {
  economicImpact?: {
    ytdEnergyLoss_MWh?: number;
    ytdRevenueLoss_EUR?: number;
    estimatedROI_pct?: number;
    expectedNetBenefit_EUR?: number;
  };
  plantInfo?: { totalInverters?: number };
}

interface ZonalCell {
  id: string;
  value: number;
  sublabel: string;
  tooltipBody?: string;
}
interface ZonalGroupSection {
  groupName: string;
  slug: string;
  tilt: number;
  azimuth: number;
  invCount: number;
  meanSrPct: number;
  cells: ZonalCell[];
}
interface ZonalRoiRow {
  zone: string;
  sr: number;
  lossMwh: number;
  recoveredEur: number;
  cleanCostEur: number;
  roiPct: number;
}
interface ZonalData {
  groups: ZonalGroupSection[];
  zoneRoi: ZonalRoiRow[];
  fleetMinPct: number;
  fleetMaxPct: number;
  totalInverters: number;
  tariff_eur_per_mwh: number | null;
  /**
   * 'real' only when all_inverters.json declares measured_per_inverter
   * provenance; 'fallback' when a file exists but carries no measured
   * per-inverter signal (plant-mean only) — rendered as an honest label,
   * never as a heatmap spread.
   */
  source: 'real' | 'fallback' | 'unavailable';
}

interface AodForecast {
  metadata: { source: string; bias_correction_applied?: number };
  daily_forecast: Array<{ date: string; aod_550nm_mean: number; aod_550nm_min: number; aod_550nm_max: number }>;
  statistics: { mean_aod: number; max_aod: number; forecast_days: number };
}

interface MonthlySummaryJson {
  monthly_data: Array<{
    date: string;
    energy_loss_mwh: number;
    energy_loss_pct: number;
    revenue_loss_eur: number;
  }>;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function OpsSoiling({ plantId }: OpsSoilingProps) {
  const router = useRouter();
  const [forecast, setForecast] = useState<MlForecastJson | null>(null);
  const [forecastErr, setForecastErr] = useState<string | null>(null);
  const [aodForecast, setAodForecast] = useState<AodForecast | null>(null);
  const [allInverters, setAllInverters] = useState<AllInvertersJson | null>(null);
  const [groupsJson, setGroupsJson] = useState<InverterGroupsJson | null>(null);
  const [mlSummary, setMlSummary] = useState<MlPlantSummaryEconomics | null>(null);
  const [proposal, setProposal] = useState<OperatorProposalJson | null>(null);
  // Adopted plan from the DB (Cleaning optimiser tab's Adopt button). When
  // present it supersedes the static operator_proposal.json specimen.
  const [adoptedProposal, setAdoptedProposal] = useState<OperatorProposalJson | null>(null);
  const displayProposal = adoptedProposal ?? proposal;
  const [zonalLoaded, setZonalLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'explorer' | 'zones' | 'cleaning'>('overview');
  const [forecastRange, setForecastRange] = useState<TimeRange>('30d');
  const [monthlyLoss, setMonthlyLoss] = useState<MonthlySummaryJson | null>(null);
  const [lossUnit, setLossUnit] = useState<'mwh' | 'eur'>('mwh');
  const [lossRange, setLossRange] = useState<TimeRange>('1y');

  useEffect(() => {
    let alive = true;
    fetch(`/data/soiling/${plantId}/ml_forecast_365d.json`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => alive && setForecast(j))
      .catch((e) => alive && setForecastErr(String(e)));
    fetch(`/data/soiling/${plantId}/aod_forecast.json`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j) => alive && j && setAodForecast(j))
      .catch(() => {});
    fetch(`/data/soiling/${plantId}/monthly_summary.json`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j) => alive && j?.monthly_data?.length && setMonthlyLoss(j))
      .catch(() => {});
    // Real optimizer output for the full-plant teaser panel.
    fetch(`/data/soiling/${plantId}/operator_proposal.json`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j) => alive && j && setProposal(j))
      .catch(() => {});
    // Adopted cleaning plan (DB) wins over the static specimen when present.
    fetch(`/api/soiling/plants/${plantId}/cleaning-schedules`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((j) => {
        const p = j?.data?.[0];
        if (!alive || !p) return;
        setAdoptedProposal({
          executive_summary: {
            expected_net_benefit_EUR: p.netBenefitEur,
            expected_roi_pct: p.roiPct,
          },
          optimal_schedule: {
            cleaning_dates: p.dates,
            energy_recovered_MWh: p.energyRecoveredMwh,
            cleaning_cost_EUR: p.cleaningCostEur,
          },
          financial_analysis: { payback_days: p.paybackDays },
        });
      })
      .catch(() => {});
    // Real per-inverter + group + economic data for the zone soiling map.
    // All three may be absent on freshly-onboarded plants, the component
    // falls back to an explicit "no zonal data yet" empty state then.
    Promise.all([
      fetch(`/data/soiling/${plantId}/all_inverters.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/data/plants/${plantId}/inverter_groups.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/data/soiling/${plantId}/ml_plant_summary.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([inv, grp, sum]) => {
      if (!alive) return;
      setAllInverters(inv);
      setGroupsJson(grp);
      setMlSummary(sum);
      setZonalLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [plantId]);

  const aodOverlay = useMemo(() => {
    if (!aodForecast?.daily_forecast?.length) return undefined;
    return aodForecast.daily_forecast.map((d) => ({ date: d.date, aod: d.aod_550nm_mean }));
  }, [aodForecast]);
  const aodDustEvents = useMemo(() => {
    if (!aodForecast?.daily_forecast) return 0;
    return aodForecast.daily_forecast.filter((d) => d.aod_550nm_mean >= 0.18).length;
  }, [aodForecast]);

  // Monthly soiling loss (precomputed daily SR x clean-energy integration in
  // monthly_summary.json), windowed by range, MWh or € view.
  const lossByMonth = useMemo(() => {
    const rows = monthlyLoss?.monthly_data ?? [];
    if (!rows.length) return null;
    const monthsToShow = lossRange === '90d' ? 3 : lossRange === '1y' ? 12 : rows.length;
    const windowed = rows.slice(-monthsToShow);
    const trailing12 = rows.slice(-12);
    return {
      bars: windowed.map((m) => {
        const d = new Date(m.date.length === 10 ? `${m.date}T00:00:00` : m.date);
        return {
          label: `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
          value: lossUnit === 'mwh' ? m.energy_loss_mwh : m.revenue_loss_eur,
          tone: 'warn' as const,
        };
      }),
      overlay: {
        label: 'Loss share',
        values: windowed.map((m) => m.energy_loss_pct),
        tone: 'muted' as const,
        format: (v: number) => `${v.toFixed(1)}%`,
      },
      totalMwh12: trailing12.reduce((s, m) => s + (m.energy_loss_mwh ?? 0), 0),
      totalEur12: trailing12.reduce((s, m) => s + (m.revenue_loss_eur ?? 0), 0),
    };
  }, [monthlyLoss, lossRange, lossUnit]);

  const data = useMemo(() => buildData(forecast), [forecast]);

  // Top KPI strip — every value traces to a real artifact; '—' when absent.
  const telemetry = useMemo<import('@/components/ops/TelemetryStrip').TelemetryCell[]>(() => {
    const pts = data.srForecast.points.slice(0, 30);
    const srMean = pts.length
      ? pts.reduce((s, p) => s + p.predicted, 0) / pts.length
      : null;
    // Soiling accumulation rate: mean magnitude of the forecast's dry-day SR
    // declines over the next 30 days (rain-recovery days excluded).
    const declines = pts
      .map((p, i) => (i > 0 ? pts[i - 1].predicted - p.predicted : 0))
      .filter((d) => d > 0);
    const soilingRate = declines.length
      ? (declines.reduce((s, d) => s + d, 0) / declines.length) * 100
      : null;
    const cleaningDue = data.srForecast.cleaningWindowIndex;
    return [
      {
        label: 'SOILING RATIO',
        value: srMean != null ? (srMean * 100).toFixed(1) : '—',
        unit: srMean != null ? '%' : undefined,
        tone: srMean == null ? 'neutral' : srMean > 0.94 ? 'ok' : 'warn',
        footer: srMean != null ? `${((1 - srMean) * 100).toFixed(1)}% energy loss` : 'no forecast fixture',
        tooltip: `${GLOSSARY.SR} Shown: 30-day forecast mean.`,
      },
      {
        label: 'ENERGY LOSS',
        value: lossByMonth ? lossByMonth.totalMwh12.toFixed(0) : '—',
        unit: lossByMonth ? 'MWh' : undefined,
        tone: lossByMonth ? 'warn' : 'neutral',
        footer: lossByMonth ? 'trailing 12 mo vs clean' : 'no monthly summary',
      },
      {
        label: 'REVENUE LOSS',
        value: lossByMonth ? `€${(lossByMonth.totalEur12 / 1000).toFixed(1)}` : '—',
        unit: lossByMonth ? 'k' : undefined,
        tone: lossByMonth ? 'warn' : 'neutral',
        footer: lossByMonth ? 'trailing 12 mo foregone' : 'no monthly summary',
      },
      {
        label: 'SOILING RATE',
        value: soilingRate != null ? soilingRate.toFixed(2) : '—',
        unit: soilingRate != null ? '%/d' : undefined,
        tone: 'neutral',
        footer: soilingRate != null ? 'forecast dry-day trend' : 'no forecast fixture',
        tooltip:
          'How fast soiling accumulates on dry days — mean daily SR decline over the next 30 forecast days, rain-recovery days excluded.',
      },
      {
        label: 'CLEANING DUE',
        value: cleaningDue != null ? String(Math.max(1, cleaningDue)) : '—',
        unit: cleaningDue != null ? 'days' : undefined,
        tone: cleaningDue == null ? 'neutral' : cleaningDue <= 7 ? 'warn' : 'ok',
        footer: cleaningDue != null ? 'first forecast flag' : 'none flagged',
      },
    ];
  }, [data.srForecast, lossByMonth]);

  // Per-group ("zonal") soiling + ROI computed entirely from on-disk data:
  //   - mean SR per group from all_inverters.json (per-inverter measurements)
  //   - cleaning cost back-derived from ml_plant_summary economic numbers so
  //     plant aggregate matches the existing fleet figures (no fabrication)
  //   - per-group recoverable revenue allocated by loss share so dirty groups
  //     show higher ROI% than clean ones
  const zonalData: ZonalData = useMemo(() => {
    const blank: ZonalData = {
      groups: [],
      zoneRoi: [],
      fleetMinPct: 0,
      fleetMaxPct: 100,
      totalInverters: 0,
      tariff_eur_per_mwh: null,
      source: 'unavailable',
    };
    if (!allInverters?.inverters?.length || !groupsJson?.inverter_groups?.length) {
      return blank;
    }
    // Honesty gate: render a per-inverter heatmap ONLY when the artifact
    // declares measured per-inverter provenance. A file without it is
    // plant-mean granularity — showing its "spread" would be the old
    // fabricated-jitter lie in new clothes.
    if (allInverters.metadata?.provenance?.source !== 'measured_per_inverter') {
      return { ...blank, source: 'fallback' };
    }
    // Index per-inverter SR by external_id (e.g. "INV 01.032").
    interface InvRecord { sr: number; severity?: string }
    const srByInv = new Map<string, InvRecord>();
    for (const r of allInverters.inverters) {
      if (r?.inverterId && r?.soilingRatio?.mean != null) {
        srByInv.set(r.inverterId, {
          sr: r.soilingRatio.mean,
          severity: (r as { fleetComparison?: { severity?: string } })?.fleetComparison?.severity,
        });
      }
    }
    // Aggregate by group AND build per-inverter cells per group.
    const groupRows = groupsJson.inverter_groups
      .map((g) => {
        const srs: number[] = [];
        let nominalKw = 0;
        const cells: ZonalCell[] = [];
        for (const inv of g.inverters ?? []) {
          const rec = srByInv.get(inv.external_id);
          if (rec) {
            srs.push(rec.sr);
            // Strip the group prefix so the tile label fits in a small grid
            // cell. "INV 01.032" → "032".
            const shortId = inv.external_id.replace(/^INV\s+\d+\.?/, '');
            cells.push({
              id: inv.external_id,
              value: rec.sr * 100,
              sublabel: shortId || inv.external_id,
              tooltipBody: `SR ${(rec.sr * 100).toFixed(1)}% · ${rec.severity ?? 'normal'}`,
            });
          }
          nominalKw += inv.nominal_power_kw ?? 0;
        }
        const srMean = srs.length > 0 ? srs.reduce((a, b) => a + b, 0) / srs.length : null;
        return {
          id: g.name,
          slug: g.slug,
          tilt: g.tilt,
          azimuth: g.azimuth,
          invCount: g.inverters?.length ?? 0,
          coveredCount: srs.length,
          nominalKw,
          srMean,
          cells,
        };
      })
      .filter((g) => g.srMean != null) as Array<{
        id: string;
        slug: string;
        tilt: number;
        azimuth: number;
        invCount: number;
        coveredCount: number;
        nominalKw: number;
        srMean: number;
        cells: ZonalCell[];
      }>;

    if (groupRows.length === 0) return blank;

    // Tariff derived from plant aggregate, falling back to the shared default.
    const econ = mlSummary?.economicImpact ?? {};
    const tariff =
      econ.ytdRevenueLoss_EUR != null && econ.ytdEnergyLoss_MWh != null && econ.ytdEnergyLoss_MWh > 0
        ? econ.ytdRevenueLoss_EUR / econ.ytdEnergyLoss_MWh
        : DEFAULT_TARIFF_EUR_PER_MWH;
    // Plant-level cleaning economics back-derived from estimatedROI_pct +
    // expectedNetBenefit so per-group numbers sum back to the existing plant
    // ROI shown elsewhere. netBenefit = recovered - cost = cost*(roi/100 - 1)
    //   → cost = netBenefit / (roi/100 - 1)
    //   → recovered = cost * roi/100
    const roiPct = econ.estimatedROI_pct ?? 200;
    const netBenefit = econ.expectedNetBenefit_EUR ?? 0;
    const plantCleanCost = roiPct > 100 ? netBenefit / (roiPct / 100 - 1) : 0;
    const plantRecovered = plantCleanCost * (roiPct / 100);

    // Allocate recovered revenue across groups by their loss share. Clean cost
    // splits by inverter count (uniform per-inverter cost assumption).
    const totalInv = groupRows.reduce((s, g) => s + g.invCount, 0) || 1;
    const lossWeights = groupRows.map((g) => (1 - g.srMean) * g.invCount);
    const totalLossWeight = lossWeights.reduce((s, w) => s + w, 0) || 1;
    const ytdEnergy = econ.ytdEnergyLoss_MWh ?? 0;

    // Fleet-wide SR range for the shared color ramp so tiles are comparable
    // across groups (a "yellow" tile means the same SR in INV 01 as in INV 04).
    const allValues = groupRows.flatMap((g) => g.cells.map((c) => c.value));
    const fleetMinPct = Math.floor(Math.min(...allValues));
    const fleetMaxPct = Math.ceil(Math.max(...allValues));

    const sections: ZonalGroupSection[] = groupRows.map((g) => ({
      groupName: g.id,
      slug: g.slug,
      tilt: g.tilt,
      azimuth: g.azimuth,
      invCount: g.invCount,
      meanSrPct: g.srMean * 100,
      cells: g.cells,
    }));

    const zoneRoi: ZonalRoiRow[] = groupRows
      .map((g, i) => {
        const cleanCost = plantCleanCost * (g.invCount / totalInv);
        const recovered = plantRecovered * (lossWeights[i]! / totalLossWeight);
        const lossMwh = ytdEnergy * (lossWeights[i]! / totalLossWeight);
        const groupRoiPct = cleanCost > 0 ? (recovered / cleanCost) * 100 : 0;
        return {
          zone: `${g.id} · ${g.tilt}°/${g.azimuth}°`,
          sr: g.srMean * 100,
          lossMwh,
          recoveredEur: recovered,
          cleanCostEur: cleanCost,
          roiPct: groupRoiPct,
        };
      })
      .sort((a, b) => b.roiPct - a.roiPct)
      .slice(0, 5);

    return {
      groups: sections,
      zoneRoi,
      fleetMinPct,
      fleetMaxPct,
      totalInverters: totalInv,
      tariff_eur_per_mwh: tariff,
      source: 'real',
    };
  }, [allInverters, groupsJson, mlSummary]);
  const isColdStart =
    Boolean(forecast?.metadata.is_cold_start) || isColdStartModel(forecast?.metadata.model_type);

  // Time-range-windowed forecast points (raw fixture-backed when available).
  const windowedForecast = useMemo(() => {
    const days =
      forecastRange === '24h' ? 1 :
      forecastRange === '7d' ? 7 :
      forecastRange === '30d' ? 30 :
      forecastRange === '90d' ? 90 :
      forecastRange === '1y' ? 365 : 365;
    if (forecast?.forecasts?.length) {
      const slice = forecast.forecasts.slice(0, days).map((f) => ({
        date: f.date,
        predicted: f.sr_predicted,
        lower: f.sr_lower_bound,
        upper: f.sr_upper_bound,
      }));
      const allSr = slice.flatMap((p) => [p.lower, p.upper]);
      const yMin = Math.min(...allSr) - 0.005;
      const yMax = Math.max(...allSr) + 0.005;
      const idx = forecast.forecasts.findIndex((f) => f.is_cleaning_needed);
      const cleanIdx = idx >= 0 && idx < days ? idx : null;
      const cleanDate = cleanIdx != null ? forecast.forecasts[cleanIdx]?.date.slice(5) : null;
      return {
        points: slice,
        yRange: [yMin, yMax] as [number, number],
        cleaningWindowIndex: cleanIdx,
        cleaningWindowLabel: cleanDate ? `clean rec · ${cleanDate}` : undefined,
      };
    }
    // Fallback to whatever buildData synthesised (30 days)
    return {
      points: data.srForecast.points,
      yRange: data.srForecast.yRange,
      cleaningWindowIndex: data.srForecast.cleaningWindowIndex,
      cleaningWindowLabel: data.srForecast.cleaningWindowLabel,
    };
  }, [forecast, forecastRange, data.srForecast]);

  return (
    <div className="space-y-3">
      <TelemetryStrip cells={telemetry} columns={5} />

      <OpsTabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'explorer', label: 'Data explorer' },
          { key: 'zones', label: 'Zone analysis' },
          { key: 'cleaning', label: 'Cleaning optimiser', statusTone: 'info' },
        ]}
        value={activeTab}
        onChange={(k) => setActiveTab(k as typeof activeTab)}
        syncToUrl
      />

      {activeTab === 'explorer' && (
        <OpsPanel
          label="Data explorer · history"
          meta={<span>precipitation · dust · SR · soiling rate · PR</span>}
          bodyClassName="ops-legacy"
        >
          <DataExplorerChart plantId={plantId} />
        </OpsPanel>
      )}

      {activeTab === 'zones' && (
        <OpsPanel label="Zone analysis" bodyClassName="ops-legacy">
          <ZoneAnalysisTab plantId={plantId} />
        </OpsPanel>
      )}

      {activeTab === 'cleaning' && (
        <OpsPanel
          label="Cleaning optimiser"
          meta={<span style={{ color: 'var(--ops-info)' }}>click trajectory to schedule · run optimiser</span>}
          bodyClassName="ops-legacy"
        >
          <CleaningOptimizerTab plantId={plantId} />
        </OpsPanel>
      )}

      {activeTab === 'overview' && (
        <>
      <OpsPanel
        label={`Soiling ratio forecast · ${windowedForecast.points.length}-day`}
        meta={
          <span className="inline-flex items-center gap-3">
            <span style={{ color: 'var(--ops-info)' }}>
              95% CI ·{' '}
              <Abbr
                term={isColdStart ? 'transfer-learning' : (forecast?.metadata.model_type ?? 'forecast')}
                def={
                  isColdStart
                    ? GLOSSARY['transfer-learning']
                    : 'Forecast model as labelled by the generator — see the footer for version and generation date.'
                }
              >
                {isColdStart
                  ? 'transfer-learning'
                  : (forecast?.metadata.model_type ?? 'forecast').replace(/_/g, ' ')}
              </Abbr>
            </span>
            {isColdStart && (
              <span
                className="rounded-sm border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.06em]"
                style={{
                  color: 'var(--ops-warn)',
                  background: 'var(--ops-warn-bg)',
                  borderColor: 'var(--ops-warn-border)',
                }}
                title="Cold-start: forecast uses a transfer-learning foundation model trained on a donor plant with DustIQ. The 95% PI narrows as you accumulate ground-truth data; full LightGBM kicks in at 90 days."
              >
                cold-start
              </span>
            )}
            <OpsTimeRange value={forecastRange} onChange={setForecastRange} options={['7d', '30d', '90d', '1y']} />
          </span>
        }
      >
        {windowedForecast.points.length > 0 ? (
          <SrForecastChart
            points={windowedForecast.points}
            cleaningWindowIndex={windowedForecast.cleaningWindowIndex}
            cleaningWindowLabel={windowedForecast.cleaningWindowLabel}
            aodOverlay={aodOverlay}
            yRange={windowedForecast.yRange}
          />
        ) : (
          <div
            className="flex h-40 items-center justify-center font-mono text-[11px] italic"
            style={{ color: 'var(--ops-muted)' }}
          >
            no forecast fixture for this plant · run the forecast generator
          </div>
        )}
        {aodForecast && (
          <div
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]"
            style={{ color: 'var(--ops-muted)' }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--ops-warn)', opacity: 0.4 }} />
              <Abbr term="CAMS">CAMS</Abbr> <Abbr term="AOD">AOD</Abbr> overlay
            </span>
            <span>·</span>
            <span>
              mean{' '}
              <span className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                {aodForecast.statistics.mean_aod.toFixed(3)}
              </span>
            </span>
            <span>·</span>
            <span>
              max{' '}
              <span className="ops-num" style={{ color: 'var(--ops-warn)' }}>
                {aodForecast.statistics.max_aod.toFixed(3)}
              </span>
            </span>
            {aodDustEvents > 0 && (
              <>
                <span>·</span>
                <span style={{ color: 'var(--ops-warn)' }}>
                  {aodDustEvents} dust event{aodDustEvents > 1 ? 's' : ''} ahead
                </span>
              </>
            )}
            <span>·</span>
            <span style={{ color: 'var(--ops-dim)' }}>{aodForecast.metadata.source}</span>
            <span>·</span>
            <span style={{ color: 'var(--ops-dim)' }}>
              overlay covers first {aodForecast.daily_forecast.length} days; SR-only beyond
            </span>
          </div>
        )}
      </OpsPanel>

      {lossByMonth && (
        <OpsPanel
          label="Soiling loss · by month"
          subtitle="Energy foregone to soiling vs a clean array, integrated from daily SR"
          meta={
            <span className="inline-flex items-center gap-3">
              <span style={{ color: 'var(--ops-muted)' }}>
                trailing 12 mo{' '}
                <span className="ops-num" style={{ color: 'var(--ops-warn)' }}>
                  {lossByMonth.totalMwh12.toFixed(0)}
                </span>{' '}
                MWh ·{' '}
                <span className="ops-num" style={{ color: 'var(--ops-warn)' }}>
                  €{(lossByMonth.totalEur12 / 1000).toFixed(1)}k
                </span>
              </span>
              <span
                className="relative inline-flex rounded-md border p-[2px] font-mono text-[10px]"
                style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel-2)' }}
              >
                {(['mwh', 'eur'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setLossUnit(u)}
                    aria-pressed={lossUnit === u}
                    className="rounded-sm px-2 py-[2px] tracking-wider transition-all"
                    style={{
                      background: lossUnit === u ? 'var(--ops-nav-active-bg)' : 'transparent',
                      color: lossUnit === u ? 'var(--ops-info)' : 'var(--ops-muted)',
                      fontWeight: lossUnit === u ? 600 : 400,
                    }}
                  >
                    {u === 'mwh' ? 'MWh' : '€'}
                  </button>
                ))}
              </span>
              <OpsTimeRange value={lossRange} onChange={setLossRange} options={['90d', '1y', 'all']} />
            </span>
          }
        >
          <OpsBarChart
            bars={lossByMonth.bars}
            valueLabel={lossUnit === 'mwh' ? 'Energy loss' : 'Revenue loss'}
            overlay={lossByMonth.overlay}
            yUnit={lossUnit === 'mwh' ? 'MWh' : '€'}
            defaultTone="warn"
            formatValue={(v) =>
              lossUnit === 'eur'
                ? v >= 10000
                  ? `€${(v / 1000).toFixed(1)}k`
                  : `€${Math.round(v)}`
                : v.toFixed(1)
            }
          />
        </OpsPanel>
      )}

      <OpsPanel
        label="Zone soiling map · per inverter"
        meta={
          zonalData.source === 'real' ? (
            <span className="inline-flex items-center gap-3">
              <span style={{ color: 'var(--ops-muted)' }}>
                {zonalData.totalInverters} inverters · {zonalData.groups.length} groups · click a tile for asset detail
              </span>
              <HeatLegend min={zonalData.fleetMinPct} max={zonalData.fleetMaxPct} unit="%" />
            </span>
          ) : (
            <span style={{ color: 'var(--ops-dim)' }}>per-inverter data unavailable</span>
          )
        }
      >
        {zonalData.source === 'real' && zonalData.groups.length > 0 ? (
          <div className="space-y-3">
            {zonalData.groups.map((g) => (
              <div key={g.slug}>
                <div className="mb-1.5 flex items-baseline justify-between font-mono text-[10.5px]">
                  <span style={{ color: 'var(--ops-txt)' }}>
                    {g.groupName}{' '}
                    <span style={{ color: 'var(--ops-muted)' }}>
                      · {g.invCount} inv · {g.tilt}°/{g.azimuth}°
                    </span>
                  </span>
                  <span className="ops-num" style={{ color: 'var(--ops-txt)' }}>
                    mean <Abbr term="SR">SR</Abbr>{' '}
                    <span style={{ color: 'var(--ops-bright)' }}>{g.meanSrPct.toFixed(1)}%</span>
                  </span>
                </div>
                <ZoneHeatmap
                  cells={g.cells}
                  columns={Math.min(g.cells.length, 10)}
                  valueMin={zonalData.fleetMinPct}
                  valueMax={zonalData.fleetMaxPct}
                  formatValue={(v) => `${Math.round(v)}`}
                  unit="%"
                  onCellClick={(id) =>
                    router.push(`/demo/plant/${plantId}/inverter/${encodeURIComponent(id)}`)
                  }
                />
              </div>
            ))}
          </div>
        ) : (
          <div
            className="flex h-32 items-center justify-center font-mono text-[11px] italic"
            style={{ color: 'var(--ops-muted)' }}
          >
            {!zonalLoaded
              ? 'loading per-inverter data…'
              : zonalData.source === 'fallback'
                ? 'plant-mean fallback · per-inverter inference unavailable for this plant'
                : 'no per-inverter soiling data yet · onboarding step'}
          </div>
        )}
      </OpsPanel>

      <div className="ops-grid-2">
        <OpsPanel
          label="Group summary"
          meta={
            zonalData.source === 'real' ? (
              <span style={{ color: 'var(--ops-muted)' }}>{zonalData.groups.length} groups · sorted by mean SR↑</span>
            ) : (
              <span style={{ color: 'var(--ops-dim)' }}>unavailable</span>
            )
          }
          flush
        >
          {zonalData.source === 'real' && zonalData.groups.length > 0 ? (
            <OpsTable
              columns={[
                { key: 'g', label: 'GROUP', render: (r) => r.groupName, weight: 1.0 },
                { key: 'n', label: 'INV', numeric: true, render: (r) => r.invCount },
                { key: 'tilt', label: 'TILT/AZ', render: (r) => `${r.tilt}°/${r.azimuth}°`, weight: 0.9 },
                { key: 'sr', label: 'MEAN SR%', numeric: true, render: (r) => r.meanSrPct.toFixed(1) },
              ]}
              rows={[...zonalData.groups].sort((a, b) => a.meanSrPct - b.meanSrPct)}
              status={(r) =>
                r.meanSrPct < zonalData.fleetMinPct + (zonalData.fleetMaxPct - zonalData.fleetMinPct) * 0.35
                  ? 'alarm'
                  : 'info'
              }
            />
          ) : (
            <div className="flex h-24 items-center justify-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
              no group data
            </div>
          )}
        </OpsPanel>

        <OpsPanel
          label="Cleaning ROI · by zone"
          meta={
            zonalData.source === 'real' ? (
              <span>
                top {zonalData.zoneRoi.length} · tariff{' '}
                <span style={{ color: 'var(--ops-txt)' }}>
                  €{Math.round(zonalData.tariff_eur_per_mwh ?? 0)}/MWh
                </span>
              </span>
            ) : (
              <span style={{ color: 'var(--ops-dim)' }}>economic numbers unavailable</span>
            )
          }
          flush
        >
          {zonalData.source === 'real' && zonalData.zoneRoi.length > 0 ? (
            <OpsTable
              columns={[
                { key: 'zone', label: 'ZONE', render: (r) => r.zone, weight: 1.4 },
                { key: 'sr', label: 'SR%', numeric: true, render: (r) => r.sr.toFixed(1) },
                {
                  key: 'loss',
                  label: 'LOSS MWh',
                  numeric: true,
                  render: (r) => r.lossMwh.toFixed(1),
                },
                {
                  key: 'rec',
                  label: 'RECOVER €',
                  numeric: true,
                  render: (r) => `€${Math.round(r.recoveredEur).toLocaleString()}`,
                },
                { key: 'roi', label: 'ROI%', numeric: true, render: (r) => r.roiPct.toFixed(0) },
              ]}
              rows={zonalData.zoneRoi}
              status={(r) => (r.roiPct > 200 ? 'ok' : r.roiPct > 120 ? 'warn' : 'muted')}
            />
          ) : (
            <div
              className="flex h-32 items-center justify-center font-mono text-[11px] italic"
              style={{ color: 'var(--ops-muted)' }}
            >
              {zonalLoaded ? 'no zonal ROI yet · awaiting plant economics' : 'loading economics…'}
            </div>
          )}
        </OpsPanel>
      </div>

      <OpsPanel
        label="Cleaning optimiser · full plant"
        meta={
          displayProposal?.financial_analysis?.payback_days != null ? (
            <span className="inline-flex items-center gap-3">
              <span style={{ color: 'var(--ops-ok)' }}>
                {adoptedProposal ? 'ADOPTED PLAN' : 'LAST SAVED RUN'} · payback in{' '}
                {Math.round(displayProposal.financial_analysis.payback_days)}d
              </span>
              <button
                type="button"
                onClick={() => setActiveTab('cleaning')}
                className="font-mono text-[10px] underline decoration-dotted underline-offset-2"
                style={{ color: 'var(--ops-info)' }}
              >
                open Cleaning optimiser →
              </button>
            </span>
          ) : (
            <span style={{ color: 'var(--ops-dim)' }}>no saved optimisation for this plant</span>
          )
        }
      >
        {displayProposal?.optimal_schedule ? (
          // Adopted DB plan when one exists, else the saved optimizer
          // specimen (operator_proposal.json) — same engine either way.
          <div className="grid grid-cols-5 gap-3">
            {[
              {
                label: 'FIRST CLEANING DATE',
                value: displayProposal.optimal_schedule.cleaning_dates?.[0] ?? '—',
                tone: 'neutral' as const,
              },
              {
                label: 'RECOVERED ENERGY',
                value:
                  displayProposal.optimal_schedule.energy_recovered_MWh != null
                    ? `${Math.round(displayProposal.optimal_schedule.energy_recovered_MWh)} MWh`
                    : '—',
                tone: 'neutral' as const,
              },
              {
                label: 'CLEAN COST',
                value:
                  displayProposal.optimal_schedule.cleaning_cost_EUR != null
                    ? `€${(displayProposal.optimal_schedule.cleaning_cost_EUR / 1000).toFixed(1)}k`
                    : '—',
                tone: 'neutral' as const,
              },
              {
                label: 'NET BENEFIT',
                value:
                  displayProposal.executive_summary?.expected_net_benefit_EUR != null
                    ? `€${(displayProposal.executive_summary.expected_net_benefit_EUR / 1000).toFixed(0)}k`
                    : '—',
                tone: 'ok' as const,
              },
              {
                label: 'ROI',
                value:
                  displayProposal.executive_summary?.expected_roi_pct != null
                    ? `${Math.round(displayProposal.executive_summary.expected_roi_pct)}%`
                    : '—',
                tone: 'ok' as const,
              },
            ].map((cell) => (
              <div key={cell.label} className="rounded-md border p-2.5" style={{ borderColor: 'var(--ops-hair)' }}>
                <div className="text-[9.5px]" style={{ color: 'var(--ops-dim)' }}>
                  {cell.label}
                </div>
                <div
                  className="mt-1 ops-num text-[18px]"
                  style={{ color: cell.tone === 'ok' ? 'var(--ops-ok)' : 'var(--ops-bright)' }}
                >
                  {cell.value}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="flex h-24 items-center justify-center font-mono text-[11px] italic"
            style={{ color: 'var(--ops-muted)' }}
          >
            run the optimiser to generate a plant-wide cleaning plan →{' '}
            <button
              type="button"
              onClick={() => setActiveTab('cleaning')}
              className="ml-1 underline decoration-dotted underline-offset-2 not-italic"
              style={{ color: 'var(--ops-info)' }}
            >
              Cleaning optimiser tab
            </button>
          </div>
        )}
      </OpsPanel>

        </>
      )}

      {/* Freshness from the artifacts themselves — no invented poll/DQ values. */}
      <OpsFooter
        pulseLabel="SOILING · FIXTURE-BACKED"
        metrics={[
          {
            label: 'GENERATED',
            value: relativeAge(data.footer.generatedAt),
            valueColor: 'var(--ops-txt)',
          },
          {
            label: 'DATA THROUGH',
            value: allInverters?.metadata?.provenance?.data_end ?? '—',
            valueColor: 'var(--ops-txt)',
          },
          {
            label: 'MODEL',
            value: data.footer.modelVersion,
            valueColor: 'var(--ops-info)',
          },
        ]}
        buildTag={forecast?.metadata.model_type ?? 'no fixture'}
      />

      {forecastErr && (
        <div className="px-1 font-mono text-[10px]" style={{ color: 'var(--ops-dim)' }}>
          forecast fixture not found ({forecastErr}); showing fallback.
        </div>
      )}
    </div>
  );
}

interface BuiltData {
  srForecast: {
    points: import('@/components/ops/charts/SrForecastChart').SrForecastPoint[];
    cleaningWindowIndex: number | null;
    cleaningWindowLabel?: string;
    yRange: [number, number];
  };
  footer: { modelVersion: string; generatedAt: string | null };
}

/**
 * Fixture-only view model. No fixture -> empty points and an explicit empty
 * state in the panel; the previous sin/drift client-side synthesis is gone.
 */
function buildData(fixture: MlForecastJson | null): BuiltData {
  if (!fixture?.forecasts?.length) {
    return {
      srForecast: { points: [], cleaningWindowIndex: null, yRange: [0.9, 1.0] },
      footer: { modelVersion: '—', generatedAt: null },
    };
  }

  const points = fixture.forecasts.slice(0, 30).map((f) => ({
    date: f.date,
    predicted: f.sr_predicted,
    lower: f.sr_lower_bound,
    upper: f.sr_upper_bound,
  }));
  const idx = fixture.forecasts.findIndex((f) => f.is_cleaning_needed);
  const cleaningWindowIndex = idx >= 0 && idx < 30 ? idx : null;
  const cleaningDate =
    cleaningWindowIndex != null ? fixture.forecasts[cleaningWindowIndex]?.date : undefined;
  const allSr = points.flatMap((p) => [p.lower, p.upper]);

  return {
    srForecast: {
      points,
      cleaningWindowIndex,
      cleaningWindowLabel: cleaningDate ? `clean rec · ${cleaningDate.slice(5)}` : undefined,
      yRange: [Math.min(...allSr) - 0.005, Math.max(...allSr) + 0.005],
    },
    footer: {
      modelVersion: fixture.metadata.model_version ?? fixture.metadata.model_type ?? '—',
      generatedAt: fixture.metadata.generated_at ?? null,
    },
  };
}
