import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantId, queryAnalysisResults } from '@/lib/db/timeseries';
import type { AnalysisRow } from '@/lib/db/timeseries';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { DEFAULT_TARIFF_EUR_PER_MWH } from '@/lib/config/economics';

/**
 * GET /api/soiling/plants/[plantId]/summary
 *
 * Returns comprehensive plant-level soiling intelligence summary including:
 * - Plant information and current status
 * - Fleet health distribution
 * - Economic impact analysis
 * - Next cleaning recommendation
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const { plantId } = params;

    // Tenancy: org-owned plants need a session + PlantAccess; demo/unaffiliated
    // plants stay publicly readable (showcase).
    const readAccess = await resolvePlantForRead(plantId);
    if (!readAccess.ok) return readAccess.response;

    // DB-first: try TimescaleDB, fallback to static JSON
    try {
      const plantUuid = await resolvePlantId(plantId);
      if (plantUuid) {
        // Bound the window to just past today so the 365-day forward forecast
        // series (soiling_ratio/loss/bounds are all future-dated) can't flood
        // the row limit ahead of today's single-row current-state metrics
        // (fleet_*_count, fleet_sr_mean, cleaning_*). Without this, the query
        // returned only future forecast rows and fleetHealth read as 0/0/0/0.
        // The small forward buffer tolerates current-state rows stamped at the
        // pipeline's canonical solar-noon timestamp (slightly ahead of now).
        const to = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
        const rows = await queryAnalysisResults({
          plantId: plantUuid,
          domain: 'soiling',
          metrics: [
            'soiling_ratio',
            'soiling_loss_pct',
            'fleet_sr_mean',
            'fleet_normal_count',
            'fleet_minor_issues_count',
            'fleet_major_issues_count',
            'fleet_critical_count',
            'ytd_energy_loss_mwh',
            'cleaning_roi_pct',
            'cleaning_net_benefit_eur',
            'cleaning_payback_days',
            'next_cleaning_date',
          ],
          to,
          limit: 2000,
        }) as AnalysisRow[];

        if (rows.length > 0) {
          // Group by metric, take the most recent value for each
          const latest = new Map<string, number>();
          const metadataByMetric = new Map<string, any>();
          for (const row of rows) {
            if (!latest.has(row.metric)) {
              latest.set(row.metric, row.value);
              metadataByMetric.set(row.metric, row.metadata);
            }
          }

          const avgSR = latest.get('fleet_sr_mean') ?? latest.get('soiling_ratio') ?? 0.95;
          const estimatedLossPct = Math.max(0, (1 - avgSR) * 100);
          const ytdEnergyLoss = latest.get('ytd_energy_loss_mwh') ?? 0;
          // Tariff: plant metadata wins over the shared default.
          const rowTariff = Number(metadataByMetric.get('ytd_energy_loss_mwh')?.eur_per_mwh);
          const tariff = Number.isFinite(rowTariff) && rowTariff > 0 ? rowTariff : DEFAULT_TARIFF_EUR_PER_MWH;
          const ytdRevenueLoss = ytdEnergyLoss * tariff;

          // Per-inverter fleet health only when the pipeline actually wrote
          // fleet_*_count metrics — an all-zero fabrication reads as "perfect
          // fleet" when it really means "not computed yet".
          const hasFleetCounts = [
            'fleet_normal_count',
            'fleet_minor_issues_count',
            'fleet_major_issues_count',
            'fleet_critical_count',
          ].some((m) => latest.has(m));

          const response = {
            plantInfo: {
              plantId,
              plantName: plantId,
              capacity_MW: null,
              totalInverters: null,
            },
            currentStatus: {
              avgSoilingRatio: avgSR,
              estimatedLossPct: parseFloat(estimatedLossPct.toFixed(2)),
              lastUpdateTime: new Date().toISOString(),
            },
            fleetHealth: hasFleetCounts
              ? {
                  normalInverters: latest.get('fleet_normal_count') ?? 0,
                  minorIssues: latest.get('fleet_minor_issues_count') ?? 0,
                  majorIssues: latest.get('fleet_major_issues_count') ?? 0,
                  critical: latest.get('fleet_critical_count') ?? 0,
                }
              : null,
            economicImpact: {
              ytdEnergyLoss_MWh: parseFloat(ytdEnergyLoss.toFixed(2)),
              ytdRevenueLoss_EUR: parseFloat(ytdRevenueLoss.toFixed(2)),
              tariff_eur_per_mwh: tariff,
              tariff_source: tariff === DEFAULT_TARIFF_EUR_PER_MWH && !Number.isFinite(rowTariff)
                ? 'default'
                : 'plant_metadata',
              nextCleaningRecommended: metadataByMetric.get('next_cleaning_date')?.date ?? null,
              estimatedROI_pct: latest.get('cleaning_roi_pct') ?? 0,
              expectedNetBenefit_EUR: latest.get('cleaning_net_benefit_eur') ?? 0,
              paybackDays: latest.get('cleaning_payback_days') ?? 0,
            },
            topPerformers: [],
            worstPerformers: [],
            _source: 'database',
          };

          return NextResponse.json(response);
        }
      }
    } catch (dbError) {
      console.warn('DB query failed for summary, falling back to JSON:', dbError);
    }

    // Fallback: Load fleet summary data from static JSON files
    const fleetSummaryPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'fleet_summary.json'
    );

    // Load operator proposal for economic impact
    const operatorProposalPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'operator_proposal.json'
    );

    // Check if files exist
    try {
      await fs.access(fleetSummaryPath);
    } catch {
      return NextResponse.json(
        { error: `Plant data not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    // Read data files (monthly_summary carries the plant's real tariff)
    const monthlySummaryPath = path.join(
      process.cwd(), 'public', 'data', 'soiling', plantId, 'monthly_summary.json'
    );
    const [fleetSummaryData, operatorProposalData, monthlySummaryData] = await Promise.all([
      fs.readFile(fleetSummaryPath, 'utf-8'),
      fs.readFile(operatorProposalPath, 'utf-8').catch(() => null),
      fs.readFile(monthlySummaryPath, 'utf-8').catch(() => null),
    ]);

    const fleetSummary = JSON.parse(fleetSummaryData);
    const operatorProposal = operatorProposalData ? JSON.parse(operatorProposalData) : null;
    const monthlySummary = monthlySummaryData ? JSON.parse(monthlySummaryData) : null;

    // Calculate current soiling loss percentage
    const avgSoilingRatio = fleetSummary.fleetSoiling.srMean;
    const estimatedLossPct = Math.max(0, (1 - avgSoilingRatio) * 100);

    // Calculate YTD losses — tariff from the plant's own artifact when present.
    const ytdEnergyLoss = fleetSummary.fleetLosses?.totalSoilingLoss_MWh || 0;
    const plantTariff = Number(monthlySummary?.metadata?.eur_per_mwh);
    const tariff = Number.isFinite(plantTariff) && plantTariff > 0 ? plantTariff : DEFAULT_TARIFF_EUR_PER_MWH;
    const tariffSource = Number.isFinite(plantTariff) && plantTariff > 0 ? 'plant_metadata' : 'default';
    const ytdRevenueLoss = ytdEnergyLoss * tariff;

    // Build response
    const response = {
      plantInfo: {
        plantId: fleetSummary.plantInfo.plantId,
        plantName: fleetSummary.plantInfo.plantName,
        capacity_MW: fleetSummary.plantInfo.capacity_MW,
        totalInverters: fleetSummary.plantInfo.totalInverters,
      },
      currentStatus: {
        avgSoilingRatio: avgSoilingRatio,
        estimatedLossPct: parseFloat(estimatedLossPct.toFixed(2)),
        lastUpdateTime: new Date().toISOString(),
      },
      // null (not fabricated zeros) when no per-inverter analysis exists yet.
      fleetHealth: fleetSummary.healthDistribution
        ? {
            normalInverters: fleetSummary.healthDistribution.normal,
            minorIssues: fleetSummary.healthDistribution.minorIssues,
            majorIssues: fleetSummary.healthDistribution.majorIssues,
            critical: fleetSummary.healthDistribution.critical,
          }
        : null,
      // Optimizer-derived fields only when the proposal is real optimizer
      // output (some plants carry a legacy cost-assumption file without an
      // optimal_schedule — those fields stay null, not fabricated).
      economicImpact: {
        ytdEnergyLoss_MWh: parseFloat(ytdEnergyLoss.toFixed(2)),
        ytdRevenueLoss_EUR: parseFloat(ytdRevenueLoss.toFixed(2)),
        tariff_eur_per_mwh: tariff,
        tariff_source: tariffSource,
        nextCleaningRecommended: operatorProposal?.optimal_schedule?.cleaning_dates?.[0] ?? null,
        estimatedROI_pct: operatorProposal?.executive_summary?.expected_roi_pct != null
          ? parseFloat(operatorProposal.executive_summary.expected_roi_pct.toFixed(2))
          : null,
        expectedNetBenefit_EUR: operatorProposal?.executive_summary?.expected_net_benefit_EUR != null
          ? parseFloat(operatorProposal.executive_summary.expected_net_benefit_EUR.toFixed(2))
          : null,
        paybackDays: operatorProposal?.financial_analysis?.payback_days != null
          ? parseFloat(operatorProposal.financial_analysis.payback_days.toFixed(1))
          : null,
      },
      topPerformers: fleetSummary.topPerformers?.slice(0, 5) || [],
      worstPerformers: fleetSummary.worstPerformers?.slice(0, 5) || [],
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/summary:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
