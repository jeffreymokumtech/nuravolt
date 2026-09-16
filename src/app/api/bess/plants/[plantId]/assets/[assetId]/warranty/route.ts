import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import type {
  WarrantyStatusResponse,
  WarrantyStatus,
  WarrantyHealthScore,
  WarrantyTerms,
  WarrantyRiskLevel,
} from '@/types/bess';
import { bessFixtureSubdir } from '@/app/api/bess/_showcase';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { bessTermsUpdateFromContract } from '@/lib/contracts/bess-sync';
import prisma from '@/libs/prisma';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const clampScore = (n: number): number => Math.max(0, Math.min(100, n));

/**
 * Where a warranty terms row's numbers came from.
 *
 *   contract          a confirmed BESS_WARRANTY contract is linked to the asset,
 *                     so syncContractToBessWarrantyTerms() wrote these columns
 *                     from the document (src/lib/contracts/bess-sync.ts)
 *   operator_declared some limits were typed in at setup, the rest defaulted
 *   chemistry_default nobody supplied anything; every limit is the chemistry
 *                     baseline from nuravolt/bess/config.py WarrantyTermsConfig
 *   unspecified       a terms row exists with no provenance recorded (seeded or
 *                     hand-written before provenance was tracked)
 */
type WarrantyTermsSource =
  | 'contract'
  | 'operator_declared'
  | 'chemistry_default'
  | 'unspecified';

interface WarrantyTermsProvenance {
  source: WarrantyTermsSource;
  /** True only when a confirmed warranty contract is on file for this asset. */
  isContractDerived: boolean;
  /** One sentence the UI can print under the tracker. Sentence case, no markup. */
  label: string;
  /** Columns someone supplied explicitly, when that was recorded. */
  declaredFields: string[];
  /** Columns filled from the chemistry baseline, when that was recorded. */
  defaultedFields: string[];
  /** What the defaults were mirrored from, when recorded. */
  basis: string | null;
  contract: {
    id: string;
    title: string;
    counterparty: string | null;
    effectiveFrom: string | null;
  } | null;
  recordedAt: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Caption a terms row honestly.
 *
 * A linked confirmed contract wins over whatever the setup script recorded,
 * because the contract sync overwrites the columns it can map. It does not
 * necessarily map all of them, and it does not rewrite manufacturer_terms, so
 * the recorded defaulted-field list goes stale the moment a contract lands.
 * bessTermsUpdateFromContract() is the same pure mapper the confirm route
 * runs, so replaying it here says exactly which columns the contract set and
 * which are still chemistry defaults. A contract on file does not turn a
 * defaulted C-rate limit into a contractual one.
 */
function describeWarrantyTerms(
  manufacturerTerms: unknown,
  contract: {
    id: string;
    title: string;
    counterparty: string | null;
    effective_from: Date | null;
    terms: Array<{ field: string; value_numeric: unknown; status: string }>;
  } | null,
  existing: { warrantyYears: number | null; maxCycles: number | null } = {
    warrantyYears: null,
    maxCycles: null,
  }
): WarrantyTermsProvenance {
  const recorded = asRecord(asRecord(manufacturerTerms).provenance);
  const declaredFields = asStringArray(recorded.declared_fields);
  const defaultedFields = asStringArray(recorded.defaulted_fields);
  const basis = typeof recorded.basis === 'string' ? recorded.basis : null;
  const recordedAt = typeof recorded.recorded_at === 'string' ? recorded.recorded_at : null;

  if (contract) {
    const { update } = bessTermsUpdateFromContract(
      contract.terms.map((t) => ({
        field: t.field,
        value_numeric: t.value_numeric == null ? null : Number(t.value_numeric),
        status: t.status,
      })),
      { existingWarrantyYears: existing.warrantyYears, existingMaxCycles: existing.maxCycles }
    );
    const fromContract = new Set(Object.keys(update));
    const stillDefaulted = defaultedFields.filter((f) => !fromContract.has(f));
    return {
      source: 'contract',
      isContractDerived: true,
      label: stillDefaulted.length
        ? `Terms from the warranty contract on file. ${stillDefaulted.length} limits the contract did not set are still chemistry defaults.`
        : 'Terms from the warranty contract on file.',
      declaredFields: Array.from(fromContract),
      defaultedFields: stillDefaulted,
      basis,
      contract: {
        id: contract.id,
        title: contract.title,
        counterparty: contract.counterparty,
        effectiveFrom: contract.effective_from ? isoDay(contract.effective_from) : null,
      },
      recordedAt,
    };
  }

  const recordedSource = recorded.source;
  if (recordedSource === 'chemistry_default' || recordedSource === 'operator_declared') {
    let label: string;
    if (recordedSource === 'chemistry_default') {
      label =
        'Chemistry defaults, not the warranty document for this asset. Upload the warranty to replace them.';
    } else if (defaultedFields.length) {
      label =
        'Some limits were entered at setup and the rest are chemistry defaults. No warranty document has been read for this asset.';
    } else {
      label =
        'Every limit was entered at setup. No warranty document has been read for this asset.';
    }
    return {
      source: recordedSource,
      isContractDerived: false,
      label,
      declaredFields,
      defaultedFields,
      basis,
      contract: null,
      recordedAt,
    };
  }

  return {
    source: 'unspecified',
    isContractDerived: false,
    label: 'No warranty document is on file for this asset, and the source of these limits was not recorded.',
    declaredFields,
    defaultedFields,
    basis,
    contract: null,
    recordedAt,
  };
}

/**
 * GET /api/bess/plants/[plantId]/assets/[assetId]/warranty
 *
 * Returns warranty status, health score, and terms.
 * DB-first: plants with BessAsset rows are served from Postgres
 * (BessWarrantyStatus + BessWarrantyTerms). A real asset without warranty
 * rows is a valid state and gets an honest empty payload, never fixtures.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string; assetId: string } }
) {
  try {
    const { plantId, assetId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:bess');
      if (gate) return gate;
    }

    // Database branch.
    if (readAccess.plant) {
      const dbAsset =
        (await prisma.bessAsset.findFirst({
          where: {
            plant_id: readAccess.plant.id,
            OR: [{ id: assetId }, { external_asset_id: assetId }],
          },
        })) ??
        (await prisma.bessAsset.findFirst({
          where: { plant_id: readAccess.plant.id },
          orderBy: { created_at: 'asc' },
        }));

      if (dbAsset) {
        const [termsRow, statusRows, warrantyContract] = await Promise.all([
          prisma.bessWarrantyTerms.findUnique({
            where: { asset_id: dbAsset.id },
          }),
          prisma.bessWarrantyStatus.findMany({
            where: { asset_id: dbAsset.id },
            orderBy: { snapshot_date: 'asc' },
          }),
          // A confirmed warranty document for this asset. DRAFT is excluded:
          // its terms are unreviewed extractions and the confirm route has not
          // synced them into BessWarrantyTerms yet.
          prisma.contract.findFirst({
            where: {
              plant_id: readAccess.plant.id,
              bess_asset_id: dbAsset.id,
              contract_type: 'BESS_WARRANTY',
              status: { in: ['ACTIVE', 'EXPIRED'] },
            },
            orderBy: { effective_from: 'desc' },
            select: {
              id: true,
              title: true,
              counterparty: true,
              effective_from: true,
              terms: { select: { field: true, value_numeric: true, status: true } },
            },
          }),
        ]);
        const latest = statusRows.length
          ? statusRows[statusRows.length - 1]
          : null;

        let status: WarrantyStatus;
        if (latest) {
          status = {
            id: latest.id,
            assetId: dbAsset.id,
            snapshotDate: isoDay(latest.snapshot_date),
            currentSoh: Number(latest.current_soh),
            warrantyThreshold: Number(latest.warranty_threshold),
            sohMargin: Number(latest.soh_margin),
            equivalentFullCycles: Number(latest.equivalent_full_cycles),
            totalThroughputMwh: Number(latest.total_throughput_mwh),
            cycleUsagePct: Number(latest.cycle_usage_pct),
            timeUsagePct: Number(latest.time_usage_pct),
            yearsRemaining: Number(latest.years_remaining),
            avgRte30d: numOrNull(latest.avg_rte_30d),
            warrantyHealthScore: Number(latest.warranty_health_score),
            riskLevel: latest.risk_level as WarrantyRiskLevel,
            projectedEolDate: latest.projected_eol_date
              ? isoDay(latest.projected_eol_date)
              : null,
            projectedCyclesToEol: latest.projected_cycles_to_eol,
            activeViolations: latest.active_violations,
          };
        } else {
          // No warranty snapshots yet — honest empty/derived state from the
          // asset row and (optional) contract terms.
          const currentSoh =
            dbAsset.current_soh == null ? 0 : Number(dbAsset.current_soh);
          const threshold = termsRow
            ? Number(termsRow.capacity_guarantee_pct)
            : 0;
          const warrantyYears = termsRow ? termsRow.warranty_years : 0;
          const elapsedYears = dbAsset.installation_date
            ? (Date.now() - dbAsset.installation_date.getTime()) /
              (365.25 * 24 * 3600 * 1000)
            : 0;
          const yearsRemaining = warrantyYears
            ? Math.max(0, Math.round((warrantyYears - elapsedYears) * 10) / 10)
            : 0;
          status = {
            id: `ws-${dbAsset.id}`,
            assetId: dbAsset.id,
            snapshotDate: isoDay(new Date()),
            currentSoh,
            warrantyThreshold: threshold,
            sohMargin: currentSoh - threshold,
            equivalentFullCycles: 0,
            totalThroughputMwh: 0,
            cycleUsagePct: 0,
            timeUsagePct: warrantyYears
              ? Math.min(1, elapsedYears / warrantyYears)
              : 0,
            yearsRemaining,
            avgRte30d: null,
            warrantyHealthScore: 0,
            riskLevel: 'LOW',
            projectedEolDate: null,
            projectedCyclesToEol: null,
            activeViolations: 0,
          };
        }

        // Component breakdown: the DB stores only the composite score, so
        // each component is a simple view over the underlying snapshot
        // metrics (nothing fabricated).
        const cyclesRemaining =
          termsRow?.max_cycles != null
            ? Math.max(
                0,
                Math.round(termsRow.max_cycles - status.equivalentFullCycles)
              )
            : status.projectedCyclesToEol ?? 0;
        const healthScore: WarrantyHealthScore = {
          score: status.warrantyHealthScore,
          riskLevel: status.riskLevel,
          components: latest
            ? {
                sohScore: clampScore(Math.round(status.currentSoh * 100)),
                cycleScore: clampScore(
                  Math.round((1 - status.cycleUsagePct) * 100)
                ),
                timeScore: clampScore(
                  Math.round((1 - status.timeUsagePct) * 100)
                ),
                efficiencyScore:
                  status.avgRte30d == null
                    ? 0
                    : clampScore(Math.round(status.avgRte30d * 100)),
                violationsScore: clampScore(
                  100 - status.activeViolations * 20
                ),
              }
            : {
                sohScore: 0,
                cycleScore: 0,
                timeScore: 0,
                efficiencyScore: 0,
                violationsScore: 0,
              },
          metrics: {
            currentSoh: status.currentSoh,
            warrantyThreshold: status.warrantyThreshold,
            sohMargin: status.sohMargin,
            cyclesUsed: status.equivalentFullCycles,
            cyclesRemaining,
            yearsRemaining: status.yearsRemaining,
          },
          projections: {
            projectedEolDate: status.projectedEolDate,
            estimatedCyclesToEol: status.projectedCyclesToEol,
          },
          riskFactors: [],
          recommendation: latest
            ? 'Monitor operating conditions.'
            : 'No warranty telemetry recorded for this asset yet.',
        };

        const terms: WarrantyTerms | null = termsRow
          ? {
              id: termsRow.id,
              assetId: dbAsset.id,
              capacityGuaranteePct: Number(termsRow.capacity_guarantee_pct),
              warrantyYears: termsRow.warranty_years,
              maxCycles: termsRow.max_cycles,
              maxThroughputMwh: numOrNull(termsRow.max_throughput_mwh),
              minRte: numOrNull(termsRow.min_rte),
              maxAvgSoc: numOrNull(termsRow.max_avg_soc),
              minSoc: numOrNull(termsRow.min_soc),
              socHoldLimitHours: termsRow.soc_hold_limit_hours,
              operatingTempMinC: numOrNull(termsRow.operating_temp_min_c),
              operatingTempMaxC: numOrNull(termsRow.operating_temp_max_c),
              tempViolationMinutes: termsRow.temp_violation_minutes,
              maxCRateContinuous: numOrNull(termsRow.max_c_rate_continuous),
              maxCRatePeak: numOrNull(termsRow.max_c_rate_peak),
              peakDurationMinutes: termsRow.peak_duration_minutes,
              cellVoltageMinV: numOrNull(termsRow.cell_voltage_min_v),
              cellVoltageMaxV: numOrNull(termsRow.cell_voltage_max_v),
              effectiveFrom: isoDay(termsRow.effective_from),
            }
          : null;

        const history = statusRows.slice(-12).map((r) => ({
          date: isoDay(r.snapshot_date),
          healthScore: Math.round(Number(r.warranty_health_score)),
          soh: Number(r.current_soh),
          cyclesUsed: Math.round(Number(r.equivalent_full_cycles)),
        }));

        // Additive field: existing consumers (useBESSData, OpsBattery) read
        // `terms` and ignore what they do not know. Null when there is nothing
        // to caption.
        const response: WarrantyStatusResponse & {
          _source: string;
          termsProvenance: WarrantyTermsProvenance | null;
        } = {
          assetId: dbAsset.id,
          status,
          healthScore,
          terms,
          history,
          metadata: {
            generatedAt: new Date().toISOString(),
          },
          termsProvenance: termsRow
            ? describeWarrantyTerms(termsRow.manufacturer_terms, warrantyContract, {
                warrantyYears: termsRow.warranty_years,
                maxCycles: termsRow.max_cycles == null ? null : Number(termsRow.max_cycles),
              })
            : null,
          _source: 'database',
        };
        return NextResponse.json(response);
      }
    }

    const baseSubdir = bessFixtureSubdir(plantId);
    const basePath = path.join(process.cwd(), 'public', 'data', baseSubdir, plantId);

    // Load warranty and SoH history data
    const [warrantyData, sohHistoryData] = await Promise.all([
      fs.readFile(path.join(basePath, 'warranty_status.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(basePath, 'soh_history.json'), 'utf-8').catch(() => null),
    ]);

    if (!warrantyData) {
      return NextResponse.json(
        { error: `Warranty data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    const warrantyInfo = JSON.parse(warrantyData);
    const sohHistory = sohHistoryData ? JSON.parse(sohHistoryData) : [];
    const wh = warrantyInfo.warranty_health;
    const wt = warrantyInfo.warranty_terms;

    // Build warranty status
    const status: WarrantyStatus = {
      id: `ws-${plantId}`,
      assetId: warrantyInfo.asset_id,
      snapshotDate: warrantyInfo.snapshot_date,
      currentSoh: wh.current_soh,
      warrantyThreshold: wh.warranty_threshold,
      sohMargin: wh.soh_margin,
      equivalentFullCycles: wh.cycles_used,
      totalThroughputMwh: wh.cycles_used * 4, // Estimate based on cycles
      cycleUsagePct: wh.cycles_used / (wh.cycles_used + wh.cycles_remaining),
      timeUsagePct: 1 - (wh.years_remaining / (wt?.warranty_years || 10)),
      yearsRemaining: wh.years_remaining,
      avgRte30d: 0.88,
      warrantyHealthScore: wh.score,
      riskLevel: wh.risk_level as WarrantyRiskLevel,
      projectedEolDate: null,
      projectedCyclesToEol: wh.cycles_remaining,
      activeViolations: 0,
    };

    // Build health score breakdown
    const healthScore: WarrantyHealthScore = {
      score: wh.score,
      riskLevel: wh.risk_level as WarrantyRiskLevel,
      components: {
        sohScore: wh.component_scores?.soh || 80,
        cycleScore: wh.component_scores?.cycles || 75,
        timeScore: wh.component_scores?.time || 85,
        efficiencyScore: wh.component_scores?.efficiency || 85,
        violationsScore: wh.component_scores?.violations || 100,
      },
      metrics: {
        currentSoh: wh.current_soh,
        warrantyThreshold: wh.warranty_threshold,
        sohMargin: wh.soh_margin,
        cyclesUsed: wh.cycles_used,
        cyclesRemaining: wh.cycles_remaining,
        yearsRemaining: wh.years_remaining,
      },
      projections: {
        projectedEolDate: null,
        estimatedCyclesToEol: wh.cycles_remaining,
      },
      riskFactors: wh.risk_factors || [],
      recommendation: wh.recommendation || 'Monitor operating conditions.',
    };

    // Build warranty terms
    const terms: WarrantyTerms | null = wt ? {
      id: `wt-${plantId}`,
      assetId: warrantyInfo.asset_id,
      capacityGuaranteePct: wt.capacity_guarantee_pct,
      warrantyYears: wt.warranty_years,
      maxCycles: wt.max_cycles,
      maxThroughputMwh: wt.max_throughput_mwh,
      minRte: wt.min_rte,
      maxAvgSoc: wt.max_avg_soc || 0.95,
      minSoc: wt.min_soc || 0.10,
      socHoldLimitHours: wt.soc_hold_limit_hours || 168,
      operatingTempMinC: wt.operating_temp_min_c,
      operatingTempMaxC: wt.operating_temp_max_c,
      tempViolationMinutes: wt.temp_violation_minutes || 30,
      maxCRateContinuous: wt.max_c_rate_continuous || 1.0,
      maxCRatePeak: wt.max_c_rate_peak || 1.2,
      peakDurationMinutes: wt.peak_duration_minutes || 15,
      cellVoltageMinV: wt.cell_voltage_min_v || 2.8,
      cellVoltageMaxV: wt.cell_voltage_max_v || 3.65,
      effectiveFrom: warrantyInfo.snapshot_date,
    } : null;

    // Build history from SoH data
    const history = sohHistory.map((point: any) => ({
      date: point.date,
      healthScore: Math.round(point.soh * 100), // Simplified health score from SoH
      soh: point.soh,
      cyclesUsed: point.cumulative_cycles || 0,
    }));

    // Fixture-backed showcase plants carry no provenance record, so the
    // caption says exactly that rather than implying a contract.
    const response: WarrantyStatusResponse & {
      termsProvenance: WarrantyTermsProvenance | null;
    } = {
      assetId: warrantyInfo.asset_id,
      status,
      healthScore,
      terms,
      history: history.slice(-12), // Last 12 data points
      metadata: {
        generatedAt: new Date().toISOString(),
      },
      termsProvenance: terms ? describeWarrantyTerms(null, null) : null,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/bess/plants/[plantId]/assets/[assetId]/warranty:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
