import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import prisma from '@/libs/prisma';
import { resendService } from '@/libs/resend';
import { generatePortfolioReportPdf } from '@/utils/portfolioReportPdf';
import { buildReportDataForReport } from '@/lib/reports/orgReportData';
import { renderDashboardPdf } from '@/lib/reports/renderDashboardPdf';
import { appBaseUrl } from '@/lib/reports/appBaseUrl';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * Ownership rule: ScheduledReport has no organization column, so `created_by`
 * (stamped with the session user id on create) is the scoping column. Legacy
 * rows with created_by = null stay reachable in dev only. Note: the nightly
 * cron (api/cron/send-reports) sends reports in-process and never calls this
 * route, so no CRON_SECRET path is needed here.
 */
function ownsReport(report: { created_by: string | null }, userId: string): boolean {
  if (report.created_by === userId) return true;
  return process.env.NODE_ENV === 'development' && report.created_by === null;
}

function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `€${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `€${(value / 1_000).toFixed(0)}K`;
  return `€${value.toFixed(0)}`;
}

// POST /api/reports/[id]/send - Generate and send report via email
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const { id } = params;

    const report = await prisma.scheduledReport.findUnique({
      where: { id },
    });

    if (!report || !ownsReport(report, ctx.userId)) {
      return NextResponse.json(
        { error: 'Report not found' },
        { status: 404 }
      );
    }

    if (report.recipient_emails.length === 0) {
      return NextResponse.json(
        { error: 'No recipients configured for this report' },
        { status: 400 }
      );
    }

    // Org-aware section data (shared builder; legacy static portfolio only
    // for orgs without plants / dev demo rows).
    const reportData = await buildReportDataForReport(report, ctx.authOrgId);

    // Dashboard-bound reports attach the rendered dashboard PDF, exactly like
    // the nightly cron; any render failure degrades to the section PDF so the
    // send-now button never hard-fails on Chrome.
    let pdfBuffer: Buffer | null = null;
    if (report.dashboard_id) {
      try {
        const dash = await prisma.dashboard.findUnique({
          where: { id: report.dashboard_id },
        });
        if (dash) {
          pdfBuffer = await renderDashboardPdf(dash, appBaseUrl(request));
        }
      } catch (e) {
        console.warn(
          `[reports/send] dashboard PDF render failed (${e instanceof Error ? e.message : e}); falling back to section PDF`
        );
      }
    }
    if (!pdfBuffer) {
      pdfBuffer = Buffer.from(generatePortfolioReportPdf(reportData));
    }

    // Send email
    await resendService.sendScheduledReport(
      report.recipient_emails,
      report.name,
      pdfBuffer,
      {
        period: reportData.period,
        totalPlants: reportData.summary.totalPlants,
        totalCapacity: `${reportData.summary.totalCapacity_MW.toFixed(1)} MW`,
        revenueAtRisk: formatCurrency(reportData.summary.totalRevenueAtRisk),
        riskLevel: reportData.summary.riskLevel,
      },
    );

    // Update last_sent_at
    await prisma.scheduledReport.update({
      where: { id },
      data: { last_sent_at: new Date() },
    });

    recordActivity({
      orgClerkId: ctx.authOrgId,
      userId: ctx.userId,
      action: 'report.sent',
      targetType: 'scheduled_report',
      targetId: report.id,
      metadata: { name: report.name, recipients: report.recipient_emails.length },
    });
    return NextResponse.json({
      message: 'Report sent successfully',
      report_id: id,
      recipients: report.recipient_emails.length,
    });
  } catch (error) {
    console.error('Error sending report:', error);
    return NextResponse.json(
      { error: 'Failed to send report' },
      { status: 500 }
    );
  }
}
