import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import { computeNextRunAt } from '@/lib/reports/schedule';

/**
 * Ownership rule: ScheduledReport has no organization column, so `created_by`
 * (stamped with the session user id on create) is the scoping column. Legacy
 * rows with created_by = null stay reachable in dev only. Mismatches return
 * 404 (not 403) to avoid existence leaks.
 */
function ownsReport(report: { created_by: string | null }, userId: string): boolean {
  if (report.created_by === userId) return true;
  return process.env.NODE_ENV === 'development' && report.created_by === null;
}

const VALID_PERIODS = [
  'last_7d',
  'last_14d',
  'last_30d',
  'last_month',
  'last_quarter',
  'year_to_date',
  'custom',
];

// GET /api/reports/[id] - Get a single scheduled report
export async function GET(
  _request: NextRequest,
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

    return NextResponse.json({ data: report });
  } catch (error) {
    console.error('Error fetching report:', error);
    return NextResponse.json(
      { error: 'Failed to fetch report' },
      { status: 500 }
    );
  }
}

// PUT /api/reports/[id] - Update a scheduled report
export async function PUT(
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
    const body = await request.json();

    // Check report exists and belongs to the caller
    const existing = await prisma.scheduledReport.findUnique({
      where: { id },
    });

    if (!existing || !ownsReport(existing, ctx.userId)) {
      return NextResponse.json(
        { error: 'Report not found' },
        { status: 404 }
      );
    }

    // Validate schedule if provided
    if (body.schedule && !['weekly', 'monthly'].includes(body.schedule)) {
      return NextResponse.json(
        { error: 'Invalid schedule. Must be "weekly" or "monthly"' },
        { status: 400 }
      );
    }

    // Validate period if provided (full ReportPeriod vocabulary)
    if (body.period && !VALID_PERIODS.includes(body.period)) {
      return NextResponse.json(
        { error: `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}` },
        { status: 400 }
      );
    }

    // Build update data
    const updateData: Record<string, unknown> = {};

    if (body.name !== undefined) updateData.name = body.name;
    if (body.schedule !== undefined) updateData.schedule = body.schedule;
    if (body.period !== undefined) updateData.period = body.period;
    if (body.recipient_emails !== undefined) updateData.recipient_emails = body.recipient_emails;
    if (body.plant_ids !== undefined) updateData.plant_ids = body.plant_ids;
    if (body.report_type !== undefined) updateData.report_type = body.report_type;
    if (body.report_sections !== undefined) updateData.report_sections = body.report_sections;
    if (body.include_summary !== undefined) updateData.include_summary = body.include_summary;
    if (body.include_risk !== undefined) updateData.include_risk = body.include_risk;
    if (body.include_losses !== undefined) updateData.include_losses = body.include_losses;
    if (body.is_active !== undefined) updateData.is_active = body.is_active;

    // Send-day knobs (ISO 1-7 / 1-28; null clears back to the default).
    if (body.send_day_of_week !== undefined) {
      updateData.send_day_of_week =
        Number.isInteger(body.send_day_of_week) &&
        body.send_day_of_week >= 1 &&
        body.send_day_of_week <= 7
          ? body.send_day_of_week
          : null;
    }
    if (body.send_day_of_month !== undefined) {
      updateData.send_day_of_month =
        Number.isInteger(body.send_day_of_month) &&
        body.send_day_of_month >= 1 &&
        body.send_day_of_month <= 28
          ? body.send_day_of_month
          : null;
    }
    if (body.send_time_utc !== undefined) {
      updateData.send_time_utc =
        typeof body.send_time_utc === 'string' && /^\d{2}:\d{2}$/.test(body.send_time_utc)
          ? body.send_time_utc
          : '07:00';
    }

    // Custom window (required as a pair when the period is custom).
    const nextPeriod = (body.period ?? existing.period) as string;
    if (body.custom_start !== undefined || body.custom_end !== undefined || nextPeriod === 'custom') {
      const start = body.custom_start !== undefined ? body.custom_start : existing.custom_start;
      const end = body.custom_end !== undefined ? body.custom_end : existing.custom_end;
      const startDate = start ? new Date(start) : null;
      const endDate = end ? new Date(end) : null;
      if (nextPeriod === 'custom') {
        if (
          !startDate ||
          !endDate ||
          Number.isNaN(startDate.getTime()) ||
          Number.isNaN(endDate.getTime()) ||
          startDate >= endDate
        ) {
          return NextResponse.json(
            { error: 'custom period requires valid custom_start < custom_end dates' },
            { status: 400 }
          );
        }
      }
      updateData.custom_start = startDate;
      updateData.custom_end = endDate;
    }

    // Dashboard linkage (ownership-checked like POST; null unlinks).
    if (body.dashboard_id !== undefined) {
      if (body.dashboard_id === null) {
        updateData.dashboard_id = null;
      } else {
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
        updateData.dashboard_id = dash.id;
      }
    }

    // Recompute next_run_at when the cadence or its day anchors change.
    const scheduleChanged = body.schedule && body.schedule !== existing.schedule;
    const dayChanged =
      body.send_day_of_week !== undefined || body.send_day_of_month !== undefined;
    if (scheduleChanged || dayChanged) {
      const nextSchedule = (body.schedule ?? existing.schedule) as 'weekly' | 'monthly';
      updateData.next_run_at = computeNextRunAt(
        nextSchedule,
        (updateData.send_day_of_week !== undefined
          ? updateData.send_day_of_week
          : existing.send_day_of_week) as number | null,
        (updateData.send_day_of_month !== undefined
          ? updateData.send_day_of_month
          : existing.send_day_of_month) as number | null
      );
    }

    const report = await prisma.scheduledReport.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ data: report });
  } catch (error) {
    console.error('Error updating report:', error);
    return NextResponse.json(
      { error: 'Failed to update report' },
      { status: 500 }
    );
  }
}

// DELETE /api/reports/[id] - Delete a scheduled report
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;
    const gate = await requireFeature(ctx.authOrgId, 'reports:builder');
    if (gate) return gate;

    const { id } = params;

    const existing = await prisma.scheduledReport.findUnique({
      where: { id },
    });

    if (!existing || !ownsReport(existing, ctx.userId)) {
      return NextResponse.json(
        { error: 'Report not found' },
        { status: 404 }
      );
    }

    await prisma.scheduledReport.delete({
      where: { id },
    });

    return NextResponse.json({ message: 'Report deleted' });
  } catch (error) {
    console.error('Error deleting report:', error);
    return NextResponse.json(
      { error: 'Failed to delete report' },
      { status: 500 }
    );
  }
}
