import fs from 'fs/promises';
import path from 'path';
import prisma from '@/libs/prisma';
import type { Plant } from '@prisma/client';
import type {
  ReportData,
  ReportPlant,
  CompliancePlantSummary,
  ContractObligationRow,
} from '@/utils/portfolioReportPdf';
import type { BessReportData } from '@/utils/bessReportData';
import { getCompliancePack, applicableObligations } from '@/config/compliance';
import type { AssetType } from '@/config/compliance/types';
import { readArtifact } from '@/lib/analysis/artifacts';

/**
 * Report data assembly for scheduled reports.
 *
 * Two modes:
 * - db: the caller's org has Plant rows — every number comes from the org's
 *   own data (twin daily energy, soiling metrics, alerts, tickets, BESS
 *   dispatch economics, warranty dossier artifacts).
 * - legacy: the static portfolio_financial.json specimen, used by the /demo
 *   portfolio surfaces and legacy rows with created_by = null. Behaviour is
 *   unchanged from the previous inline builders in generate/send/cron (which
 *   carried three drifting copies of this logic).
 */

const TARIFF_EUR_PER_MWH = 65;

// ── Period windows ──────────────────────────────────────────────

export function periodWindow(
  period: string,
  customStart?: Date | null,
  customEnd?: Date | null,
  now: Date = new Date()
): { start: Date; end: Date; label: string } {
  const end = new Date(now);
  const day = 86_400_000;
  switch (period) {
    case 'last_7d':
      return { start: new Date(now.getTime() - 7 * day), end, label: 'Last 7 Days' };
    case 'last_14d':
      return { start: new Date(now.getTime() - 14 * day), end, label: 'Last 14 Days' };
    case 'last_30d':
      return { start: new Date(now.getTime() - 30 * day), end, label: 'Last 30 Days' };
    case 'last_month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start, end: monthEnd, label: 'Last Month' };
    }
    case 'last_quarter': {
      const q = Math.floor(now.getUTCMonth() / 3);
      const start = new Date(Date.UTC(now.getUTCFullYear(), (q - 1) * 3, 1));
      const qEnd = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      return { start, end: qEnd, label: 'Last Quarter' };
    }
    case 'year_to_date':
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        end,
        label: 'Year to Date',
      };
    case 'custom': {
      const start = customStart ?? new Date(now.getTime() - 30 * day);
      const cEnd = customEnd ?? end;
      return {
        start,
        end: cEnd,
        label: `${start.toISOString().slice(0, 10)} to ${cEnd.toISOString().slice(0, 10)}`,
      };
    }
    default:
      return { start: new Date(now.getTime() - 30 * day), end, label: period };
  }
}

// ── Mode resolution ─────────────────────────────────────────────

export type ReportPlantsResolution =
  | { mode: 'db'; plants: Plant[] }
  | { mode: 'legacy' };

/**
 * Decide whether a scheduled report renders from the org's own database or
 * from the legacy static portfolio. In-session callers pass the Better Auth
 * org id; the cron passes none and the org is resolved from the report's
 * creator (Member → Organization).
 */
export async function resolveReportPlants(
  report: { plant_ids: string[]; created_by: string | null },
  authOrgId?: string | null
): Promise<ReportPlantsResolution> {
  let orgAuthId = authOrgId ?? null;
  if (!orgAuthId && report.created_by) {
    const member = await prisma.member.findFirst({
      where: { userId: report.created_by },
      orderBy: { createdAt: 'asc' },
    });
    orgAuthId = member?.organizationId ?? null;
  }
  if (!orgAuthId) return { mode: 'legacy' };

  const org = await prisma.organization.findUnique({
    where: { clerk_org_id: orgAuthId },
  });
  if (!org) return { mode: 'legacy' };

  const orgPlants = await prisma.plant.findMany({
    where: { organization_id: org.id },
    orderBy: { name: 'asc' },
  });
  if (orgPlants.length === 0) return { mode: 'legacy' };

  // plant_ids may hold slugs (chat/report UI) or uuids; unknown ids are
  // ignored, and an empty match set falls back to the whole org fleet rather
  // than producing an empty PDF.
  const wanted = new Set(report.plant_ids ?? []);
  const filtered =
    wanted.size > 0
      ? orgPlants.filter((p) => wanted.has(p.slug ?? '') || wanted.has(p.id))
      : orgPlants;
  return { mode: 'db', plants: filtered.length > 0 ? filtered : orgPlants };
}

// ── Per-plant metric assembly (db mode) ─────────────────────────

interface PlantPeriodStats {
  expectedMwh: number;
  actualMwh: number;
  measuredDays: number;
  fleetSr: number | null;
  healthScore: number | null;
  criticalAlerts: number;
  warningAlerts: number;
  openTickets: number;
}

async function plantPeriodStats(
  plant: Plant,
  start: Date,
  end: Date
): Promise<PlantPeriodStats> {
  const energyRows = await prisma.$queryRaw<
    { metric: string; total_kwh: number | null; days: number | null }[]
  >`
    SELECT metric,
           sum(value) AS total_kwh,
           count(DISTINCT date_trunc('day', "time")) AS days
    FROM analysis_results
    WHERE plant_id = ${plant.id}::uuid
      AND domain = 'digitaltwin'
      AND device_id = 'PLANT'
      AND metric IN ('power_ac_predicted', 'power_ac_actual')
      AND "time" >= ${start} AND "time" < ${end}
    GROUP BY metric
  `.catch((): { metric: string; total_kwh: number | null; days: number | null }[] => []);

  let expectedMwh = 0;
  let actualMwh = 0;
  let measuredDays = 0;
  for (const row of energyRows) {
    const mwh = Number(row.total_kwh ?? 0) / 1000;
    if (row.metric === 'power_ac_predicted') expectedMwh = mwh;
    if (row.metric === 'power_ac_actual') {
      actualMwh = mwh;
      measuredDays = Number(row.days ?? 0);
    }
  }

  const srRow = await prisma.$queryRaw<{ value: number }[]>`
    SELECT value FROM analysis_results
    WHERE plant_id = ${plant.id}::uuid
      AND domain = 'soiling' AND metric = 'fleet_sr_mean'
      AND "time" < ${end}
    ORDER BY "time" DESC LIMIT 1
  `.catch((): { value: number }[] => []);
  const fleetSr = srRow.length ? Number(srRow[0].value) : null;

  let healthScore: number | null = null;
  try {
    const faults = await readArtifact<{
      health?: number;
      health_score?: number | { value?: number };
    }>(plant.id, 'faults_enhanced');
    const raw = faults?.payload?.health_score ?? faults?.payload?.health;
    const h = typeof raw === 'object' && raw !== null ? (raw as any).value : raw;
    healthScore = typeof h === 'number' ? Math.round(h) : null;
  } catch {
    healthScore = null;
  }

  const [criticalAlerts, warningAlerts, openTickets] = await Promise.all([
    prisma.plantAlert.count({
      where: { plant_id: plant.id, status: 'ACTIVE', severity: 'CRITICAL' },
    }),
    prisma.plantAlert.count({
      where: { plant_id: plant.id, status: 'ACTIVE', severity: 'WARNING' },
    }),
    prisma.ticket.count({
      where: { plant_id: plant.id, status: { notIn: ['DONE', 'WONT_FIX'] } },
    }),
  ]).catch(() => [0, 0, 0]);

  return {
    expectedMwh,
    actualMwh,
    measuredDays,
    fleetSr,
    healthScore,
    criticalAlerts,
    warningAlerts,
    openTickets,
  };
}

/** BESS plants have no PLANT power twin; the modelled dispatch is the plan
 *  AND the delivery, so energy fields describe discharged energy. */
async function bessPeriodEnergy(
  plant: Plant,
  start: Date,
  end: Date
): Promise<{ dischargedMwh: number; scheduleDays: number }> {
  const assets = await prisma.bessAsset.findMany({
    where: { plant_id: plant.id },
    select: { id: true },
  });
  if (assets.length === 0) return { dischargedMwh: 0, scheduleDays: 0 };
  const rows = await prisma.bessDispatchSchedule.findMany({
    where: {
      asset_id: { in: assets.map((a) => a.id) },
      schedule_date: { gte: start, lt: end },
    },
    select: { schedule_date: true, discharge_schedule_kw: true },
  });
  let dischargedKwh = 0;
  const days = new Set<string>();
  for (const r of rows) {
    days.add(r.schedule_date.toISOString().slice(0, 10));
    const arr = Array.isArray(r.discharge_schedule_kw)
      ? (r.discharge_schedule_kw as unknown[])
      : [];
    for (const v of arr) dischargedKwh += Math.max(0, Number(v) || 0);
  }
  return { dischargedMwh: dischargedKwh / 1000, scheduleDays: days.size };
}

function riskFromAlerts(critical: number, warning: number): { score: number; level: string } {
  if (critical > 0) return { score: 78, level: 'high' };
  if (warning >= 2) return { score: 55, level: 'medium' };
  if (warning === 1) return { score: 45, level: 'medium' };
  return { score: 22, level: 'low' };
}

// ── BESS report data (db mode) ──────────────────────────────────

/**
 * DB-backed BessReportData for the plant's PRIMARY asset (oldest created_at
 * — the same convention every BESS surface uses). Warranty numbers come from
 * the weekly bess_warranty_dossier artifact; dispatch economics from the
 * stored schedules' real expected/degradation figures.
 */
export async function fetchBessReportDataFromDb(
  plant: Plant,
  start: Date,
  end: Date
): Promise<BessReportData | null> {
  const asset = await prisma.bessAsset.findFirst({
    where: { plant_id: plant.id },
    orderBy: { created_at: 'asc' },
  });
  if (!asset) return null;

  const tests = await prisma.bessCapacityTest.findMany({
    where: { asset_id: asset.id },
    orderBy: { test_date: 'asc' },
  });
  const sohHistory = tests.map((t) => ({
    date: t.test_date.toISOString().slice(0, 10),
    soh: Number(t.soh_result),
  }));

  let dossier: any = null;
  try {
    dossier = (await readArtifact(plant.id, 'bess_warranty_dossier'))?.payload ?? null;
  } catch {
    dossier = null;
  }
  const health = dossier?.health_score ?? dossier?.warranty_health_score ?? {};
  const cycling = dossier?.cycling ?? {};

  // Degradation rate from the capacity-test span (falls back to 0 when the
  // history is too short to regress).
  let degradationRate = 0;
  if (sohHistory.length >= 2) {
    const first = sohHistory[0];
    const last = sohHistory[sohHistory.length - 1];
    const years =
      (new Date(last.date).getTime() - new Date(first.date).getTime()) /
      (365.25 * 86_400_000);
    if (years > 0.05) degradationRate = ((first.soh - last.soh) / years) * 100;
  }

  const dispatch = await prisma.bessDispatchSchedule.findMany({
    where: { asset_id: asset.id, schedule_date: { gte: start, lt: end } },
    select: {
      schedule_date: true,
      charge_schedule_kw: true,
      discharge_schedule_kw: true,
      expected_revenue_eur: true,
      degradation_cost_eur: true,
    },
  });
  let chargeKwh = 0;
  let dischargeKwh = 0;
  let revenue = 0;
  let degradationCost = 0;
  const days = new Set<string>();
  for (const r of dispatch) {
    days.add(r.schedule_date.toISOString().slice(0, 10));
    for (const v of (Array.isArray(r.charge_schedule_kw) ? r.charge_schedule_kw : []) as unknown[]) {
      chargeKwh += Math.abs(Number(v) || 0);
    }
    for (const v of (Array.isArray(r.discharge_schedule_kw)
      ? r.discharge_schedule_kw
      : []) as unknown[]) {
      dischargeKwh += Math.max(0, Number(v) || 0);
    }
    revenue += Number(r.expected_revenue_eur ?? 0);
    degradationCost += Number(r.degradation_cost_eur ?? 0);
  }
  const nDays = Math.max(1, days.size);
  const periodDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));

  return {
    assetName: asset.name,
    chemistry: asset.chemistry ?? 'LFP',
    capacityKwh: Number(asset.nominal_capacity_kwh),
    powerKw: Number(asset.nominal_power_kw),
    currentSoh: Number(asset.current_soh ?? 1),
    sohHistory,
    warrantyHealthScore:
      typeof health.score === 'number' ? health.score : Math.round(Number(asset.current_soh ?? 1) * 100),
    warrantyRiskLevel: String(health.risk_level ?? 'LOW'),
    equivalentCycles: Number(
      cycling.total_equivalent_cycles ?? cycling.equivalent_full_cycles ?? health.cycles_used ?? 0
    ),
    totalThroughputMwh: Number(cycling.total_throughput_mwh ?? 0),
    avgRte: Number(
      cycling.avg_round_trip_efficiency ?? cycling.avg_rte ?? cycling.average_rte ?? 1
    ),
    degradationRate: Math.max(0, Number(degradationRate.toFixed(2))),
    projectedEolDate: health.projected_eol_date ?? null,
    cyclesToEol:
      typeof health.cycles_remaining === 'number' ? Math.round(health.cycles_remaining) : null,
    recentRevenue: revenue,
    recentDegradationCost: degradationCost,
    avgDailyChargeMwh: chargeKwh / 1000 / nDays,
    avgDailyDischargeMwh: dischargeKwh / 1000 / nDays,
    rteLossMwh: Math.max(0, (chargeKwh - dischargeKwh) / 1000),
    availabilityPct: Math.min(100, (days.size / periodDays) * 100),
    violationCount: Array.isArray(dossier?.violations) ? dossier.violations.length : 0,
  };
}

// ── Compliance (shared by db + legacy modes) ────────────────────

export async function buildComplianceSummaries(
  plantNames: string[]
): Promise<CompliancePlantSummary[]> {
  const dbPlants = await prisma.plant.findMany({
    where: { name: { in: plantNames } },
    select: {
      name: true,
      country: true,
      compliance_pack_version: true,
      capacity_mw: true,
      asset_type: true,
    },
  });

  const mapAsset = (a: string): AssetType =>
    a === 'PV' ? 'SOLAR' : a === 'WIND' ? 'WIND' : 'BESS';

  return dbPlants
    .map((dp): CompliancePlantSummary | null => {
      const pack = getCompliancePack(dp.country);
      if (!pack) return null;
      const applicable = applicableObligations(pack, {
        capacity_mw: Number(dp.capacity_mw),
        asset_type: mapAsset(dp.asset_type),
      });
      return {
        plantName: dp.name,
        country: pack.country,
        packVersion: dp.compliance_pack_version || pack.version,
        regulator: pack.regulator.name,
        gridOperator: pack.grid_operator.name,
        gridCodeReference: pack.grid_code.reference,
        // Metering fields the pack has not verified against the source document are left out of
        // the summary line rather than printed as an empty or invented value.
        meterClass:
          [
            pack.metering.meter_class,
            `${pack.metering.interval_minutes}min`,
            pack.metering.retention_years != null
              ? `${pack.metering.retention_years}y retention`
              : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'Not verified',
        obligations: applicable.map((o) => ({
          name: o.name,
          recipient: o.recipient,
          cadence: o.cadence,
          deadlineDays: o.deadline_days_after_period,
        })),
      };
    })
    .filter((x): x is CompliancePlantSummary => x !== null);
}

// ── DB-mode ReportData ──────────────────────────────────────────

interface ScheduledReportLike {
  name: string;
  period: string;
  plant_ids: string[];
  report_sections: unknown;
  include_summary: boolean;
  include_risk: boolean;
  include_losses: boolean;
  custom_start?: Date | null;
  custom_end?: Date | null;
}

export async function buildOrgReportData(
  plants: Plant[],
  report: ScheduledReportLike
): Promise<ReportData> {
  const { start, end, label } = periodWindow(
    report.period,
    report.custom_start,
    report.custom_end
  );

  const sections: string[] = Array.isArray(report.report_sections)
    ? (report.report_sections as string[])
    : [];

  const rows: ReportPlant[] = [];
  let totalRevenue = 0;
  const bessData: BessReportData[] = [];

  const periodDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));

  for (const plant of plants) {
    const stats = await plantPeriodStats(plant, start, end);
    const isBess = plant.asset_type === 'BESS';

    let expected = stats.expectedMwh;
    let actual = stats.actualMwh;
    let coverageDays = stats.measuredDays;
    if (isBess && expected === 0) {
      const bess = await bessPeriodEnergy(plant, start, end);
      // Modelled dispatch: the schedule is both the plan and the delivery.
      expected = bess.dischargedMwh;
      actual = bess.dischargedMwh;
      coverageDays = bess.scheduleDays;
    }

    const lossMwh = Math.max(0, expected - actual);
    const soilingLossMwh =
      !isBess && stats.fleetSr != null ? Math.min(lossMwh, expected * (1 - stats.fleetSr)) : 0;
    const faultLossMwh = Math.max(0, lossMwh - soilingLossMwh);
    const risk = riskFromAlerts(stats.criticalAlerts, stats.warningAlerts);

    rows.push({
      plantName: plant.name,
      location: plant.location_name ?? plant.country ?? '',
      capacity_MW: Number(plant.capacity_mw ?? 0),
      healthScore: stats.healthScore,
      riskScore: risk.score,
      riskLevel: risk.level,
      revenueAtRisk: lossMwh * TARIFF_EUR_PER_MWH,
      budgetDeviation: expected > 0 ? ((actual - expected) / expected) * 100 : 0,
      soilingLoss: soilingLossMwh * TARIFF_EUR_PER_MWH,
      faultLoss: faultLossMwh * TARIFF_EUR_PER_MWH,
      availability: Math.min(100, (coverageDays / periodDays) * 100),
      performanceRatio: expected > 0 ? actual / expected : 0,
    });
    totalRevenue += actual * TARIFF_EUR_PER_MWH;

    if (isBess && sections.some((s) => s.startsWith('bess_'))) {
      const b = await fetchBessReportDataFromDb(plant, start, end);
      if (b) bessData.push(b);
    }
  }

  let complianceSummaries: CompliancePlantSummary[] | undefined;
  if (sections.includes('compliance_obligations')) {
    complianceSummaries = await buildComplianceSummaries(plants.map((p) => p.name));
  }

  // Live contract-obligation statuses from the hourly evaluation artifact.
  let contractRows: ContractObligationRow[] | undefined;
  if (sections.includes('contract_obligations')) {
    contractRows = [];
    for (const plant of plants) {
      try {
        const artifact = await readArtifact<{ obligations?: any[] }>(
          plant.id,
          'contract_obligations'
        );
        for (const o of artifact?.payload?.obligations ?? []) {
          contractRows.push({
            plantName: plant.name,
            contractType: String(o.contract_type ?? ''),
            field: String(o.field ?? '').replace(/_/g, ' '),
            status: String(o.status ?? 'unmonitored'),
            observed:
              o.observed_value != null
                ? `${Number(o.observed_value).toFixed(1)}${o.unit === '%' ? '%' : o.unit ? ` ${o.unit}` : ''}`
                : 'n/a',
            threshold:
              o.threshold != null
                ? `${Number(o.threshold)}${o.unit === '%' ? '%' : o.unit ? ` ${o.unit}` : ''}`
                : 'n/a',
          });
        }
      } catch {
        // no artifact for this plant — nothing to report
      }
    }
  }

  const totalRevenueAtRisk = rows.reduce((s, p) => s + p.revenueAtRisk, 0);
  const totalSoilingLoss = rows.reduce((s, p) => s + p.soilingLoss, 0);
  const totalFaultLoss = rows.reduce((s, p) => s + p.faultLoss, 0);
  const avgBudgetDev =
    rows.length > 0 ? rows.reduce((s, p) => s + p.budgetDeviation, 0) / rows.length : 0;
  const avgRisk =
    rows.length > 0 ? Math.round(rows.reduce((s, p) => s + p.riskScore, 0) / rows.length) : 0;
  const maxRiskLevel = rows.reduce((worst, p) => {
    const order: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    return (order[p.riskLevel] ?? 0) > (order[worst] ?? 0) ? p.riskLevel : worst;
  }, 'low');

  return {
    reportName: report.name,
    period: label,
    generatedAt: new Date().toISOString(),
    summary: {
      totalPlants: rows.length,
      totalCapacity_MW: rows.reduce((s, p) => s + p.capacity_MW, 0),
      totalRevenue,
      totalRevenueAtRisk,
      budgetDeviation: avgBudgetDev,
      riskScore: avgRisk,
      riskLevel: maxRiskLevel,
      totalSoilingLoss,
      totalFaultLoss,
    },
    plants: rows,
    includeSummary: report.include_summary,
    includeRisk: report.include_risk,
    includeLosses: report.include_losses,
    sections,
    bessData: bessData.length > 0 ? bessData : undefined,
    complianceSummaries,
    contractRows,
  };
}

// ── Legacy static-portfolio ReportData ──────────────────────────

interface PortfolioPlantJson {
  plantId: string;
  plantName: string;
  location: string;
  capacity_MW: number;
  metrics: { healthScore: number | null };
  financials: {
    revenue_at_risk_eur: number;
    budget_deviation_pct: number;
    soiling_loss_eur: number;
    fault_loss_eur: number;
    availability_pct: number;
    performance_ratio: number;
    annual_revenue_eur: number;
  };
  riskScore: { overall: number; level: string };
}

function mapLegacyPlant(p: PortfolioPlantJson): ReportPlant {
  return {
    plantName: p.plantName,
    location: p.location,
    capacity_MW: p.capacity_MW,
    healthScore: p.metrics?.healthScore ?? null,
    riskScore: p.riskScore?.overall ?? 0,
    riskLevel: p.riskScore?.level ?? 'unknown',
    revenueAtRisk: p.financials?.revenue_at_risk_eur ?? 0,
    budgetDeviation: p.financials?.budget_deviation_pct ?? 0,
    soilingLoss: p.financials?.soiling_loss_eur ?? 0,
    faultLoss: p.financials?.fault_loss_eur ?? 0,
    availability: p.financials?.availability_pct ?? 0,
    performanceRatio: p.financials?.performance_ratio ?? 0,
  };
}

export async function buildLegacyReportData(
  report: ScheduledReportLike
): Promise<ReportData> {
  const filePath = path.join(process.cwd(), 'public', 'data', 'portfolio_financial.json');
  const raw = await fs.readFile(filePath, 'utf-8');
  const allPlants = (JSON.parse(raw).plants ?? []) as PortfolioPlantJson[];

  const plants =
    report.plant_ids.length > 0
      ? allPlants.filter((p) => report.plant_ids.includes(p.plantId))
      : allPlants;
  const mapped = plants.map(mapLegacyPlant);

  const sections: string[] = Array.isArray(report.report_sections)
    ? (report.report_sections as string[])
    : [];

  // BESS fixtures (demo specimens). Normalized to the array the PDF renderer
  // consumes — the previous per-plant Record shape silently disabled every
  // BESS section (Record has no .length).
  let bessData: BessReportData[] | undefined;
  if (sections.some((s) => s.startsWith('bess_'))) {
    try {
      const { fetchBessReportDataMulti } = await import('@/utils/bessReportData');
      const ids =
        report.plant_ids.length > 0 ? report.plant_ids : plants.map((p) => p.plantId);
      bessData = await fetchBessReportDataMulti(ids);
    } catch (err) {
      console.warn('BESS fixture data unavailable, skipping BESS sections:', err);
    }
  }

  let complianceSummaries: CompliancePlantSummary[] | undefined;
  if (sections.includes('compliance_obligations')) {
    complianceSummaries = await buildComplianceSummaries(plants.map((p) => p.plantName));
  }

  const totalRevenue = plants.reduce(
    (s, p) => s + (p.financials?.annual_revenue_eur ?? 0),
    0
  );
  const totalRevenueAtRisk = mapped.reduce((s, p) => s + p.revenueAtRisk, 0);
  const totalSoilingLoss = mapped.reduce((s, p) => s + p.soilingLoss, 0);
  const totalFaultLoss = mapped.reduce((s, p) => s + p.faultLoss, 0);
  const avgBudgetDev =
    mapped.length > 0 ? mapped.reduce((s, p) => s + p.budgetDeviation, 0) / mapped.length : 0;
  const avgRisk =
    mapped.length > 0
      ? Math.round(mapped.reduce((s, p) => s + p.riskScore, 0) / mapped.length)
      : 0;
  const maxRiskLevel = mapped.reduce((worst, p) => {
    const order: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    return (order[p.riskLevel] ?? 0) > (order[worst] ?? 0) ? p.riskLevel : worst;
  }, 'low');

  const { label } = periodWindow(report.period, report.custom_start, report.custom_end);

  return {
    reportName: report.name,
    period: label,
    generatedAt: new Date().toISOString(),
    summary: {
      totalPlants: mapped.length,
      totalCapacity_MW: mapped.reduce((s, p) => s + p.capacity_MW, 0),
      totalRevenue,
      totalRevenueAtRisk,
      budgetDeviation: avgBudgetDev,
      riskScore: avgRisk,
      riskLevel: maxRiskLevel,
      totalSoilingLoss,
      totalFaultLoss,
    },
    plants: mapped,
    includeSummary: report.include_summary,
    includeRisk: report.include_risk,
    includeLosses: report.include_losses,
    sections,
    bessData,
    complianceSummaries,
  };
}

/** One-call assembly: resolve mode, build the matching ReportData. */
export async function buildReportDataForReport(
  report: ScheduledReportLike & { created_by: string | null },
  authOrgId?: string | null
): Promise<ReportData> {
  const resolution = await resolveReportPlants(report, authOrgId);
  return resolution.mode === 'db'
    ? buildOrgReportData(resolution.plants, report)
    : buildLegacyReportData(report);
}
