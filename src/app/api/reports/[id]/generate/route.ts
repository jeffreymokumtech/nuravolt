import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { generatePortfolioReportPdf } from '@/utils/portfolioReportPdf';
import { buildReportDataForReport } from '@/lib/reports/orgReportData';
import { appBaseUrl } from '@/lib/reports/appBaseUrl';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';

/**
 * Ownership rule: ScheduledReport has no organization column, so `created_by`
 * (stamped with the session user id on create) is the scoping column. Legacy
 * rows with created_by = null stay reachable in dev only. Note: the nightly
 * cron (api/cron/send-reports) renders reports in-process and never calls this
 * route, so no CRON_SECRET path is needed here.
 */
function ownsReport(report: { created_by: string | null }, userId: string): boolean {
  if (report.created_by === userId) return true;
  return process.env.NODE_ENV === 'development' && report.created_by === null;
}

// POST /api/reports/[id]/generate - Generate report PDF
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

    // When the scheduled report is bound to an interactive Dashboard, delegate
    // to the dashboard PDF exporter (headless Chrome on the public share URL).
    // A render failure degrades to the org-aware section PDF below — the
    // download button must never 502 just because Chrome had a bad day.
    if (report.dashboard_id) {
      const baseUrl = appBaseUrl(request);
      // Forward the caller's session cookie: export-pdf is org-guarded too and
      // this server-to-server fetch carries no cookies of its own.
      const cookie = request.headers.get('cookie');
      try {
        const exportRes = await fetch(
          `${baseUrl}/api/dashboards/${report.dashboard_id}/export-pdf`,
          { method: 'POST', headers: cookie ? { cookie } : undefined },
        );
        if (exportRes.ok) {
          const buf = Buffer.from(await exportRes.arrayBuffer());
          return new NextResponse(buf, {
            status: 200,
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="${report.name.replace(/\s+/g, '_')}.pdf"`,
            },
          });
        }
        console.warn(
          `[reports/generate] dashboard export failed (${exportRes.status}); falling back to section PDF`
        );
      } catch (e) {
        console.warn(
          `[reports/generate] dashboard export threw (${e instanceof Error ? e.message : e}); falling back to section PDF`
        );
      }
    }

    // Section PDF: the org's own data when the org has plants, the legacy
    // static portfolio otherwise (shared builder — see orgReportData.ts).
    const reportData = await buildReportDataForReport(report, ctx.authOrgId);
    const arrayBuffer = generatePortfolioReportPdf(reportData);

    return new NextResponse(Buffer.from(arrayBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${report.name.replace(/\s+/g, '_')}_report.pdf"`,
        ...(report.dashboard_id ? { 'X-Report-Fallback': 'sections' } : {}),
      },
    });
  } catch (error) {
    console.error('Error generating report:', error);
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 }
    );
  }
}
