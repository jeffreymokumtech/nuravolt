import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { resendService } from '@/libs/resend';
import { generatePortfolioReportPdf } from '@/utils/portfolioReportPdf';
import { computeNextRunAt } from '@/lib/reports/schedule';
import { appBaseUrl } from '@/lib/reports/appBaseUrl';
import { renderDashboardPdf } from '@/lib/reports/renderDashboardPdf';
import { buildReportDataForReport } from '@/lib/reports/orgReportData';

function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `€${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `€${(value / 1_000).toFixed(0)}K`;
  return `€${value.toFixed(0)}`;
}

// ── GET /api/cron/send-reports ───────────────────────────────

export async function GET(request: NextRequest) {
  // Auth check: verify CRON_SECRET in production
  if (process.env.NODE_ENV === 'production') {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let sent = 0;
  let errors = 0;

  try {
    const dueReports = await prisma.scheduledReport.findMany({
      where: {
        is_active: true,
        next_run_at: { lte: new Date() },
      },
    });

    if (dueReports.length === 0) {
      return NextResponse.json({ sent: 0, errors: 0, message: 'No reports due' });
    }

    for (const report of dueReports) {
      try {
        // Org-aware section data: the creator's org resolves via Member →
        // Organization; orgs with plants render from their own database,
        // legacy demo rows keep the static portfolio (see orgReportData.ts).
        const reportData = await buildReportDataForReport(report, null);

        // Generate PDF. Dashboard-bound reports render the composed report
        // via headless Chrome; on serverless (no Chrome in the function
        // bundle) or any render failure we fall back to the legacy section
        // PDF so the scheduled email always goes out.
        let pdfBuffer: Buffer;
        if (report.dashboard_id) {
          const dash = await prisma.dashboard.findUnique({
            where: { id: report.dashboard_id },
          });
          const baseUrl = appBaseUrl(request);
          try {
            if (!dash) throw new Error('dashboard missing');
            pdfBuffer = await renderDashboardPdf(dash, baseUrl);
          } catch (e) {
            console.warn(
              `[send-reports] dashboard PDF render failed for ${report.id} (${
                e instanceof Error ? e.message : e
              }); falling back to section PDF. View the interactive report at /dashboard/reports/${report.dashboard_id}.`
            );
            pdfBuffer = Buffer.from(generatePortfolioReportPdf(reportData));
          }
        } else {
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

        // Update schedule
        await prisma.scheduledReport.update({
          where: { id: report.id },
          data: {
            last_sent_at: new Date(),
            next_run_at: computeNextRunAt(
              report.schedule as 'weekly' | 'monthly',
              report.send_day_of_week,
              report.send_day_of_month,
            ),
          },
        });

        sent++;
      } catch (err) {
        console.error(`Failed to send report ${report.id}:`, err);
        errors++;
      }
    }
  } catch (err) {
    console.error('Cron send-reports error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ sent, errors });
}
