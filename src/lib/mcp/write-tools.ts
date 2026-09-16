import prisma from '@/libs/prisma';
import { resolvePlantOrDeny, type ChatAccessContext } from '@/lib/ai/access-control';
import {
  createCleaningSchedule,
  deriveScheduleEconomics,
} from '@/lib/soiling/cleaningSchedules';

/**
 * Write-side MCP tools. Each function returns a JSON-serialisable result
 * plus optional side-effect ids (ticketId / cleaningScheduleId) so the
 * audit row can link to the row that was created.
 */

export interface WriteResult {
  result: Record<string, unknown>;
  ticketId?: string | null;
  cleaningScheduleId?: string | null;
}

function denied(reason: string, detail?: string): WriteResult {
  return {
    result: { error: reason, ...(detail ? { detail } : {}) },
    ticketId: null,
    cleaningScheduleId: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// nuravolt_create_ticket
// ─────────────────────────────────────────────────────────────────────────

export type TicketPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type TicketTrigger =
  | 'SOILING_FORECAST'
  | 'PERFORMANCE_ANOMALY'
  | 'THRESHOLD_ALERT'
  | 'SCHEDULED_MAINTENANCE'
  | 'MANUAL_CREATION';

export interface CreateTicketArgs {
  plantId: string;
  inverterId?: string;
  title: string;
  description: string;
  priority: TicketPriority;
  trigger_type: TicketTrigger;
  estimated_energy_loss_kwh?: number;
  estimated_revenue_impact_eur?: number;
}

export async function createTicket(
  ctx: ChatAccessContext,
  args: CreateTicketArgs,
): Promise<WriteResult> {
  const plant = resolvePlantOrDeny(ctx, args.plantId);
  if (!plant) return denied('access_denied', `No access to ${args.plantId}.`);

  const row = await prisma.ticket.create({
    data: {
      org_clerk_id: ctx.orgClerkId,
      plant_id: plant.id,
      inverter_id: args.inverterId ?? null,
      status: 'NEW',
      priority: args.priority,
      trigger_type: args.trigger_type,
      title: args.title,
      description: args.description,
      estimated_energy_loss_kwh:
        args.estimated_energy_loss_kwh != null ? args.estimated_energy_loss_kwh : null,
      estimated_revenue_impact_eur:
        args.estimated_revenue_impact_eur != null ? args.estimated_revenue_impact_eur : null,
      trigger_metadata: {
        source: 'mcp',
        created_by_user: ctx.userClerkId,
      },
    },
    select: { id: true, title: true, status: true, priority: true, created_at: true },
  });

  // Outbound integrations (awaited; never fails the write).
  const { emitTicketEvent } = await import('@/lib/integrations/webhooks');
  await emitTicketEvent(ctx.orgClerkId, 'ticket.created', {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    plant_slug: plant.slug,
    plant_name: plant.name,
    trigger_type: args.trigger_type,
    estimated_revenue_impact_eur: args.estimated_revenue_impact_eur ?? null,
    url: `/dashboard/tickets/${row.id}`,
  });

  return {
    result: {
      created: true,
      ticket: {
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        plant_slug: plant.slug,
        created_at: row.created_at.toISOString(),
      },
    },
    ticketId: row.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// nuravolt_update_ticket_status
// ─────────────────────────────────────────────────────────────────────────

export type TicketStatus =
  | 'NEW'
  | 'VALIDATED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'WONT_FIX';

const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['VALIDATED', 'WONT_FIX'],
  VALIDATED: ['ASSIGNED', 'IN_PROGRESS', 'WONT_FIX'],
  ASSIGNED: ['IN_PROGRESS', 'WONT_FIX'],
  IN_PROGRESS: ['DONE', 'WONT_FIX'],
  DONE: [],
  WONT_FIX: [],
};

export interface UpdateTicketStatusArgs {
  ticketId: string;
  newStatus: TicketStatus;
  reason?: string;
}

export async function updateTicketStatus(
  ctx: ChatAccessContext,
  args: UpdateTicketStatusArgs,
): Promise<WriteResult> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: args.ticketId },
    select: { id: true, org_clerk_id: true, status: true, priority: true, plant_id: true },
  });
  if (!ticket || ticket.org_clerk_id !== ctx.orgClerkId) {
    return denied('not_found', `Ticket ${args.ticketId} not found or not in your org.`);
  }
  if (!ctx.allowedPlantIds.has(ticket.plant_id)) {
    return denied('access_denied', `No access to plant ${ticket.plant_id}.`);
  }
  const allowed = ALLOWED_TRANSITIONS[ticket.status as TicketStatus] ?? [];
  if (!allowed.includes(args.newStatus)) {
    return denied(
      'invalid_transition',
      `Cannot transition ${ticket.status} → ${args.newStatus}. Allowed next: ${
        allowed.join(', ') || '(none)'
      }`,
    );
  }

  const [updated] = await prisma.$transaction([
    prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: args.newStatus,
        ...(args.newStatus === 'DONE' ? { closed_at: new Date() } : {}),
      },
      select: { id: true, status: true, updated_at: true },
    }),
    prisma.ticketHistory.create({
      data: {
        ticket_id: ticket.id,
        old_status: ticket.status,
        new_status: args.newStatus,
        changed_by_clerk_id: ctx.userClerkId,
        change_reason: args.reason ?? `via MCP (${ctx.userClerkId})`,
      },
    }),
  ]);

  {
    const { emitTicketEvent } = await import('@/lib/integrations/webhooks');
    const plant = await prisma.plant.findUnique({
      where: { id: ticket.plant_id },
      select: { slug: true, name: true },
    });
    await emitTicketEvent(ctx.orgClerkId, 'ticket.status_changed', {
      id: updated.id,
      status: updated.status,
      old_status: ticket.status,
      priority: ticket.priority,
      plant_slug: plant?.slug ?? null,
      plant_name: plant?.name ?? null,
      url: `/dashboard/tickets/${updated.id}`,
    });
  }

  return {
    result: {
      updated: true,
      ticket: {
        id: updated.id,
        status: updated.status,
        updated_at: updated.updated_at.toISOString(),
      },
    },
    ticketId: updated.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// nuravolt_comment_on_ticket
// ─────────────────────────────────────────────────────────────────────────

export interface CommentOnTicketArgs {
  ticketId: string;
  content: string;
}

export async function commentOnTicket(
  ctx: ChatAccessContext,
  args: CommentOnTicketArgs,
): Promise<WriteResult> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: args.ticketId },
    select: { id: true, org_clerk_id: true, plant_id: true },
  });
  if (!ticket || ticket.org_clerk_id !== ctx.orgClerkId) {
    return denied('not_found', `Ticket ${args.ticketId} not found or not in your org.`);
  }
  if (!ctx.allowedPlantIds.has(ticket.plant_id)) {
    return denied('access_denied', `No access to plant ${ticket.plant_id}.`);
  }
  const row = await prisma.ticketComment.create({
    data: {
      ticket_id: ticket.id,
      author_clerk_id: ctx.userClerkId,
      org_clerk_id: ctx.orgClerkId,
      content: args.content,
    },
    select: { id: true, created_at: true },
  });
  return {
    result: {
      created: true,
      comment: { id: row.id, ticket_id: ticket.id, created_at: row.created_at.toISOString() },
    },
    ticketId: ticket.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// nuravolt_approve_cleaning_schedule
// ─────────────────────────────────────────────────────────────────────────

export interface ApproveCleaningScheduleArgs {
  plantId: string;
  scheduleName: string;
  dates: string[]; // YYYY-MM-DD
  rationale: string;
  estimatedEnergyRecoveredMwh: number;
  estimatedRevenueRecoveredEur: number;
  estimatedCleaningCostEur: number;
  avgSrBaseline?: number;
  avgSrOptimized?: number;
  validFrom?: string;
  validTo?: string;
}

export async function approveCleaningSchedule(
  ctx: ChatAccessContext,
  args: ApproveCleaningScheduleArgs,
): Promise<WriteResult> {
  const plant = resolvePlantOrDeny(ctx, args.plantId);
  if (!plant) return denied('access_denied', `No access to ${args.plantId}.`);
  if (!args.dates.length) return denied('invalid_args', 'dates must not be empty.');

  if (args.estimatedCleaningCostEur <= 0) {
    return denied('invalid_args', 'estimatedCleaningCostEur must be > 0.');
  }

  // Shared adopt path (also used by the soiling UI and the chat draft card).
  const adopted = await createCleaningSchedule({
    plantId: plant.id,
    orgClerkId: ctx.orgClerkId,
    userId: ctx.userClerkId,
    scheduleName: args.scheduleName,
    dates: args.dates,
    estimatedEnergyRecoveredMwh: args.estimatedEnergyRecoveredMwh,
    estimatedRevenueRecoveredEur: args.estimatedRevenueRecoveredEur,
    estimatedCleaningCostEur: args.estimatedCleaningCostEur,
    avgSrBaseline: args.avgSrBaseline,
    avgSrOptimized: args.avgSrOptimized,
    validFrom: args.validFrom,
    validTo: args.validTo,
    createTickets: false,
  });
  const sortedDates = adopted.dates;
  const { validFrom, validTo, netBenefit, roiPct, paybackDays } =
    deriveScheduleEconomics({
      dates: args.dates,
      revenue: args.estimatedRevenueRecoveredEur,
      cleaningCost: args.estimatedCleaningCostEur,
      validFrom: args.validFrom,
      validTo: args.validTo,
    });
  const row = {
    id: adopted.id,
    created_at: new Date(adopted.createdAt),
    n_cleanings: adopted.nCleanings,
  };

  return {
    result: {
      created: true,
      schedule: {
        id: row.id,
        plant_slug: plant.slug,
        plant_name: plant.name,
        name: args.scheduleName,
        n_cleanings: row.n_cleanings,
        dates: sortedDates,
        rationale: args.rationale,
        net_benefit_eur: Number(netBenefit.toFixed(2)),
        roi_pct: Number(roiPct.toFixed(2)),
        payback_days: Number(paybackDays.toFixed(1)),
        valid_from: validFrom.toISOString().slice(0, 10),
        valid_to: validTo.toISOString().slice(0, 10),
        created_at: row.created_at.toISOString(),
      },
    },
    cleaningScheduleId: row.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// nuravolt_schedule_report
// ─────────────────────────────────────────────────────────────────────────

export interface ScheduleReportArgs {
  name: string;
  plantId?: string;
  schedule: 'weekly' | 'monthly';
  dayOfWeek?: number;
  dayOfMonth?: number;
  period: 'last_7d' | 'last_30d' | 'last_month';
  recipient_emails: string[];
  include_summary?: boolean;
  include_risk?: boolean;
  include_losses?: boolean;
}

export async function scheduleReport(
  ctx: ChatAccessContext,
  args: ScheduleReportArgs,
): Promise<WriteResult> {
  let plantSlug: string | null = null;
  if (args.plantId) {
    const plant = resolvePlantOrDeny(ctx, args.plantId);
    if (!plant) return denied('access_denied', `No access to ${args.plantId}.`);
    plantSlug = plant.slug;
  }
  if (!args.recipient_emails?.length) {
    return denied('invalid_args', 'recipient_emails must not be empty.');
  }

  const { computeNextRunAt } = await import('@/lib/reports/schedule');
  const sendDayOfWeek =
    args.schedule === 'weekly' ? (args.dayOfWeek && args.dayOfWeek >= 1 && args.dayOfWeek <= 7 ? args.dayOfWeek : 1) : null;
  const sendDayOfMonth =
    args.schedule === 'monthly' ? (args.dayOfMonth && args.dayOfMonth >= 1 && args.dayOfMonth <= 28 ? args.dayOfMonth : 1) : null;

  const row = await prisma.scheduledReport.create({
    data: {
      name: args.name,
      schedule: args.schedule,
      period: args.period,
      recipient_emails: args.recipient_emails,
      plant_ids: plantSlug ? [plantSlug] : [],
      report_type: 'portfolio',
      include_summary: args.include_summary ?? true,
      include_risk: args.include_risk ?? true,
      include_losses: args.include_losses ?? true,
      send_day_of_week: sendDayOfWeek,
      send_day_of_month: sendDayOfMonth,
      // Tenancy anchor (ScheduledReport has no org column).
      created_by: ctx.userClerkId,
      next_run_at: computeNextRunAt(args.schedule, sendDayOfWeek, sendDayOfMonth),
    },
    select: { id: true, name: true, next_run_at: true },
  });

  return {
    result: {
      created: true,
      report: {
        id: row.id,
        name: row.name,
        schedule: args.schedule,
        period: args.period,
        recipients: args.recipient_emails.length,
        plant_slug: plantSlug,
        next_run_at: row.next_run_at?.toISOString() ?? null,
        note: 'Sends as a portfolio PDF at 07:00 UTC on the scheduled day.',
      },
    },
  };
}
