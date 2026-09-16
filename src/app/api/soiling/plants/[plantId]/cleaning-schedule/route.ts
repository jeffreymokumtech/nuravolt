import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePlantForRead } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * GET /api/soiling/plants/[plantId]/cleaning-schedule
 *
 * Returns optimal cleaning schedule with:
 * - Recommended cleaning dates
 * - Economic analysis (ROI, payback period, net benefit)
 * - Alternative scenarios comparison
 * - Detailed recommendations
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
    if (readAccess.access === 'org') {
      const gate = await requireFeature(readAccess.ctx.authOrgId, 'analytics:cleaning_optimizer');
      if (gate) return gate;
    }

    // Load operator proposal (optimal schedule)
    const operatorProposalPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'operator_proposal.json'
    );

    // Load cleaning comparison (alternative scenarios)
    const cleaningComparisonPath = path.join(
      process.cwd(),
      'public',
      'data',
      'soiling',
      plantId,
      'cleaning_comparison.json'
    );

    // Check if files exist
    try {
      await fs.access(operatorProposalPath);
    } catch {
      return NextResponse.json(
        { error: `Cleaning schedule not found for plantId: ${plantId}` },
        { status: 404 }
      );
    }

    // Read data files
    const [operatorProposalData, cleaningComparisonData] = await Promise.all([
      fs.readFile(operatorProposalPath, 'utf-8'),
      fs.readFile(cleaningComparisonPath, 'utf-8').catch(() => null),
    ]);

    const operatorProposal = JSON.parse(operatorProposalData);
    const cleaningComparison = cleaningComparisonData ? JSON.parse(cleaningComparisonData) : null;

    // Build optimal schedule response with null-safe access
    const optimal = {
      dates: operatorProposal.optimal_schedule?.cleaning_dates || [],
      nCleanings: operatorProposal.optimal_schedule?.n_cleanings || 0,
      netBenefit_EUR: operatorProposal.optimal_schedule?.net_benefit_EUR
        ? parseFloat(operatorProposal.optimal_schedule.net_benefit_EUR.toFixed(2))
        : 0,
      roi_pct: operatorProposal.optimal_schedule?.roi_pct
        ? parseFloat(operatorProposal.optimal_schedule.roi_pct.toFixed(2))
        : 0,
      paybackDays: operatorProposal.financial_analysis?.payback_days
        ? parseFloat(operatorProposal.financial_analysis.payback_days.toFixed(1))
        : 0,
      energyRecovered_MWh: operatorProposal.optimal_schedule?.energy_recovered_MWh
        ? parseFloat(operatorProposal.optimal_schedule.energy_recovered_MWh.toFixed(2))
        : 0,
      revenueRecovered_EUR: operatorProposal.optimal_schedule?.revenue_recovered_EUR
        ? parseFloat(operatorProposal.optimal_schedule.revenue_recovered_EUR.toFixed(2))
        : 0,
      cleaningCost_EUR: operatorProposal.optimal_schedule?.cleaning_cost_EUR || 0,
      avgSoilingRatio: operatorProposal.optimal_schedule?.avg_sr
        ? parseFloat(operatorProposal.optimal_schedule.avg_sr.toFixed(4))
        : 0,
    };

    // Build alternatives from cleaning comparison with null-safe access
    const alternatives = cleaningComparison?.scenarios
      ? cleaningComparison.scenarios
          .filter((s: any) => s.strategy !== optimal.nCleanings + ' cleaning(s)')
          .map((s: any) => ({
            scenario: s.strategy || 'Unknown',
            dates: s.dates ? s.dates.split(', ') : [],
            nCleanings: s.n_cleanings || parseInt(s.strategy) || 0,
            netBenefit_EUR: s.net_benefit_eur ? parseFloat(s.net_benefit_eur.toFixed(2)) : 0,
            roi_pct: s.roi__pct ? parseFloat(s.roi__pct.toFixed(2)) : 0,
            energyRecovered_MWh: s.energy_recovered_mwh ? parseFloat(s.energy_recovered_mwh.toFixed(2)) : 0,
            revenueRecovered_EUR: s.revenue_recovered_eur ? parseFloat(s.revenue_recovered_eur.toFixed(2)) : 0,
            cleaningCost_EUR: s.cleaning_cost_eur || 0,
          }))
      : [];

    // Build response
    const response = {
      plantId,
      validPeriod: {
        from: operatorProposal.executive_summary.forecast_period.split(' to ')[0],
        to: operatorProposal.executive_summary.forecast_period.split(' to ')[1],
      },
      optimal,
      alternatives,
      recommendations: operatorProposal.recommendations || [],
      technicalDetails: {
        avgSoilingRatioBaseline: operatorProposal.technical_details?.avg_soiling_ratio_baseline
          ? parseFloat(operatorProposal.technical_details.avg_soiling_ratio_baseline.toFixed(4))
          : 0,
        avgSoilingRatioOptimized: operatorProposal.technical_details?.avg_soiling_ratio_optimized
          ? parseFloat(operatorProposal.technical_details.avg_soiling_ratio_optimized.toFixed(4))
          : 0,
        avgLossBaseline_pct: operatorProposal.technical_details?.avg_soiling_loss_baseline_pct
          ? parseFloat(operatorProposal.technical_details.avg_soiling_loss_baseline_pct.toFixed(2))
          : 0,
        avgLossOptimized_pct: operatorProposal.technical_details?.avg_soiling_loss_optimized_pct
          ? parseFloat(operatorProposal.technical_details.avg_soiling_loss_optimized_pct.toFixed(2))
          : 0,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in /api/soiling/plants/[plantId]/cleaning-schedule:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
