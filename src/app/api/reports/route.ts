import { NextRequest, NextResponse } from 'next/server';
import { recordActivity } from '@/lib/activity';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { computeNextRunAt } from '@/lib/reports/schedule';

/**
 * Tenancy note: ScheduledReport carries no organization column and its
 * plant_ids are loose portfolio ids (no Plant relation), so `created_by`
 * (stamped with the session user id on create) is the only scoping column the
 * schema supports. In dev, legacy rows with created_by = null stay visible so
 * /demo keeps working.
 */
function reportOwnerScope(userId: string) {
  const isDev = process.env.NODE_ENV === 'development';
  return isDev
    ? { OR: [{ created_by: userId }, { created_by: null }] }
    : { created_by: userId };
}

// GET /api/reports - List the caller's scheduled reports
export async function GET() {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const reports = await prisma.scheduledReport.findMany({
      where: reportOwnerScope(ctx.userId),
      orderBy: { created_at: 'desc' },
    });

    return NextResponse.json({ data: reports });
  } catch (error) {
    console.error('Error fetching reports:', error);
    return NextResponse.json(
      { error: 'Failed to fetch reports' },
      { status: 500 }
    );
  }
}

// POST /api/reports - Create a new scheduled report
export async function POST(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const body = await request.json();

    // Validate required fields
    if (!body.name || !body.schedule || !body.period || !body.recipient_emails) {
      return NextResponse.json(
        { error: 'Missing required fields: name, schedule, period, recipient_emails' },
        { status: 400 }
      );
    }

    // Validate schedule enum
    if (!['weekly', 'monthly'].includes(body.schedule)) {
      return NextResponse.json(
        { error: 'Invalid schedule. Must be "weekly" or "monthly"' },
        { status: 400 }
      );
    }

    // Validate period enum (full ReportPeriod vocabulary)
    const VALID_PERIODS = [
      'last_7d',
      'last_14d',
      'last_30d',
      'last_month',
      'last_quarter',
      'year_to_date',
      'custom',
    ];
    if (!VALID_PERIODS.includes(body.period)) {
      return NextResponse.json(
        { error: `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}` },
        { status: 400 }
      );
    }
    let customStart: Date | null = null;
    let customEnd: Date | null = null;
    if (body.period === 'custom') {
      customStart = body.custom_start ? new Date(body.custom_start) : null;
      customEnd = body.custom_end ? new Date(body.custom_end) : null;
      if (
        !customStart ||
        !customEnd ||
        Number.isNaN(customStart.getTime()) ||
        Number.isNaN(customEnd.getTime()) ||
        customStart >= customEnd
      ) {
        return NextResponse.json(
          { error: 'custom period requires valid custom_start < custom_end dates' },
          { status: 400 }
        );
      }
    }

    // Validate recipient_emails is a non-empty array
    if (!Array.isArray(body.recipient_emails) || body.recipient_emails.length === 0) {
      return NextResponse.json(
        { error: 'recipient_emails must be a non-empty array of email addresses' },
        { status: 400 }
      );
    }

    // Optional send-day knobs (the cron itself runs daily at 07:00 UTC, so
    // day of week / day of month are the only meaningful schedule controls).
    const sendDayOfWeek =
      Number.isInteger(body.send_day_of_week) &&
      body.send_day_of_week >= 1 &&
      body.send_day_of_week <= 7
        ? body.send_day_of_week
        : null;
    const sendDayOfMonth =
      Number.isInteger(body.send_day_of_month) &&
      body.send_day_of_month >= 1 &&
      body.send_day_of_month <= 28
        ? body.send_day_of_month
        : null;

    // Optional interactive-report linkage: dashboard-bound reports render
    // the dashboard PDF instead of the legacy section renderer.
    let dashboardId: string | null = null;
    if (body.dashboard_id) {
      const dash = await prisma.dashboard.findUnique({
        where: { id: body.dashboard_id },
        select: { id: true, organization_id: true, owner_id: true },
      });
      const owns =
        dash &&
        (dash.organization_id === ctx.authOrgId ||
          dash.owner_id === ctx.userId ||
          (process.env.NODE_ENV === 'development' &&
            dash.organization_id === null &&
            dash.owner_id === null));
      if (!owns) {
        return NextResponse.json({ error: 'Report dashboard not found' }, { status: 404 });
      }
      dashboardId = dash.id;
    }

    const next_run_at = computeNextRunAt(body.schedule, sendDayOfWeek, sendDayOfMonth);

    const report = await prisma.scheduledReport.create({
      data: {
        name: body.name,
        schedule: body.schedule,
        period: body.period,
        recipient_emails: body.recipient_emails,
        plant_ids: body.plant_ids || [],
        send_day_of_week: sendDayOfWeek,
        send_day_of_month: sendDayOfMonth,
        custom_start: customStart,
        custom_end: customEnd,
        dashboard_id: dashboardId,
        report_type: body.report_type || 'portfolio',
        report_sections: body.report_sections || [],
        include_summary: body.include_summary ?? true,
        include_risk: body.include_risk ?? true,
        include_losses: body.include_losses ?? true,
        // Tenancy anchor: always the session user, never the client-supplied id.
        created_by: ctx.userId,
        next_run_at,
      },
    });

    recordActivity({
      orgClerkId: ctx.authOrgId,
      userId: ctx.userId,
      action: 'report_schedule.created',
      targetType: 'scheduled_report',
      targetId: report.id,
      metadata: { name: report.name, schedule: report.schedule },
    });

    return NextResponse.json(
      { data: report, message: 'Report scheduled' },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating report:', error);
    return NextResponse.json(
      { error: 'Failed to create report' },
      { status: 500 }
    );
  }
}
