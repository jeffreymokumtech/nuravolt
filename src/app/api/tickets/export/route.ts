import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { requireFeature } from '@/lib/billing/gate';
import type {
  ValidationExportRecord,
  ValidationExportResponse,
  TicketStatus,
  TicketPriority,
  TicketTriggerType,
  TicketValidationAction,
} from '@/types/tickets';

// GET /api/tickets/export - Export validated tickets for ML training
export async function GET(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;
    const gate = await requireFeature(authOrgId, 'tickets:export');
    if (gate) return gate;

    const { searchParams } = new URL(request.url);

    // Parse date range (default: last 90 days)
    const endDate = searchParams.get('end_date')
      ? new Date(searchParams.get('end_date')!)
      : new Date();

    const startDate = searchParams.get('start_date')
      ? new Date(searchParams.get('start_date')!)
      : new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Optional filters
    const triggerType = searchParams.get('trigger_type') as TicketTriggerType | null;
    const includeOpen = searchParams.get('include_open') === 'true';
    const format = searchParams.get('format');

    // Training-tuples format — anonymised LLM-narration audit-trail for
    // downstream fine-tuning. Branches early because the query shape and
    // filtering rules are different from the validation export.
    if (format === 'training_tuples') {
      return exportTrainingTuples({ startDate, endDate, triggerType, authOrgId });
    }

    // Build where clause - only tickets that have been validated
    const where: Record<string, unknown> = {
      org_clerk_id: authOrgId,
      validated_at: {
        gte: startDate,
        lte: endDate,
      },
      validation_action: { not: null },
    };

    // Filter by trigger type if specified
    if (triggerType) {
      where.trigger_type = triggerType;
    }

    // By default, only export closed tickets
    if (!includeOpen) {
      where.status = { in: ['DONE', 'WONT_FIX'] };
    }

    const tickets = await prisma.ticket.findMany({
      where,
      include: {
        history: {
          where: {
            change_reason: { startsWith: 'Validated' },
          },
          orderBy: { changed_at: 'asc' },
          take: 1,
        },
      },
      orderBy: { validated_at: 'desc' },
    });

    // Transform to export format
    const records: ValidationExportRecord[] = tickets.map((ticket) => {
      const originalPriority = ticket.history[0]?.old_priority || ticket.priority;
      const validatedAt = ticket.validated_at!;
      const createdAt = ticket.created_at;
      const closedAt = ticket.closed_at;

      // Calculate time metrics
      const timeToValidationHours = Math.round(
        (validatedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60) * 10
      ) / 10;

      const resolutionTimeHours = closedAt
        ? Math.round(
            (closedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60) * 10
          ) / 10
        : null;

      // Determine if it was a false positive or adjusted
      const validationAction = ticket.validation_action as TicketValidationAction;
      const wasFalsePositive = validationAction?.startsWith('DISMISSED') ?? false;
      const wasAdjusted = validationAction === 'VALIDATED_ADJUSTED';

      return {
        ticket_id: ticket.id,
        trigger_type: ticket.trigger_type as TicketTriggerType,
        trigger_id: ticket.trigger_id,
        trigger_metadata: ticket.trigger_metadata as Record<string, unknown> | null,
        plant_id: ticket.plant_id,
        inverter_id: ticket.inverter_id,
        validation_action: validationAction,
        validation_notes: ticket.validation_notes,
        validated_at: validatedAt.toISOString(),
        validated_by_clerk_id: ticket.validated_by_clerk_id!,
        was_false_positive: wasFalsePositive,
        was_adjusted: wasAdjusted,
        original_priority: originalPriority as TicketPriority,
        final_priority: ticket.priority as TicketPriority,
        time_to_validation_hours: timeToValidationHours,
        resolution_time_hours: resolutionTimeHours,
        final_status: ticket.status as TicketStatus,
      };
    });

    const response: ValidationExportResponse = {
      records,
      total: records.length,
      export_date: new Date().toISOString(),
      date_range: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
    };

    // Set headers for file download if requested
    if (format === 'csv') {
      const csv = convertToCSV(records);
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="ticket_validations_${startDate.toISOString().slice(0, 10)}_${endDate.toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error exporting validation data:', error);
    return NextResponse.json(
      { error: 'Failed to export validation data' },
      { status: 500 }
    );
  }
}

function convertToCSV(records: ValidationExportRecord[]): string {
  if (records.length === 0) {
    return 'No records found';
  }

  // Define columns for ML training
  const columns = [
    'ticket_id',
    'trigger_type',
    'trigger_id',
    'plant_id',
    'inverter_id',
    'validation_action',
    'was_false_positive',
    'was_adjusted',
    'original_priority',
    'final_priority',
    'time_to_validation_hours',
    'resolution_time_hours',
    'final_status',
    'validated_at',
    'validation_notes',
    // Flatten common trigger metadata fields
    'soiling_loss_pct',
    'anomaly_severity',
    'threshold_exceeded_pct',
  ];

  const header = columns.join(',');

  const rows = records.map((record) => {
    const metadata = record.trigger_metadata || {};

    return [
      record.ticket_id,
      record.trigger_type,
      record.trigger_id || '',
      record.plant_id,
      record.inverter_id || '',
      record.validation_action,
      record.was_false_positive ? '1' : '0',
      record.was_adjusted ? '1' : '0',
      record.original_priority,
      record.final_priority,
      record.time_to_validation_hours,
      record.resolution_time_hours ?? '',
      record.final_status,
      record.validated_at,
      `"${(record.validation_notes || '').replace(/"/g, '""')}"`,
      // Flattened metadata
      (metadata as Record<string, number>).soiling_loss_pct ?? '',
      (metadata as Record<string, string>).severity ?? '',
      calculateExceededPct(metadata),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

function calculateExceededPct(metadata: Record<string, unknown>): string {
  const threshold = metadata.threshold_value as number | undefined;
  const actual = metadata.actual_value as number | undefined;

  if (threshold && actual && threshold > 0) {
    return ((actual - threshold) / threshold * 100).toFixed(2);
  }
  return '';
}

/**
 * Emit anonymised training tuples for downstream LLM fine-tuning. One row per
 * closed ticket that had an AI narration. Includes the trigger context, the
 * LLM draft, the operator-edited version, and resolution metrics so the
 * downstream pipeline can learn from operator corrections.
 *
 * PII handling: assigned_to_clerk_id is one-way hashed; org_clerk_id is
 * dropped entirely; plant_id is preserved (already opaque).
 */
async function exportTrainingTuples({
  startDate,
  endDate,
  triggerType,
  authOrgId,
}: {
  startDate: Date;
  endDate: Date;
  triggerType: TicketTriggerType | null;
  authOrgId: string;
}) {
  const where: Record<string, unknown> = {
    org_clerk_id: authOrgId,
    status: { in: ['DONE', 'WONT_FIX'] },
    ai_narration: { not: null },
    created_at: { gte: startDate, lte: endDate },
  };
  // Only include trigger types that produce narration. Currently just
  // PERFORMANCE_ANOMALY; widen as more types get LLM coverage.
  if (triggerType) {
    where.trigger_type = triggerType;
  } else {
    where.trigger_type = 'PERFORMANCE_ANOMALY';
  }

  const tickets = await prisma.ticket.findMany({
    where,
    select: {
      id: true,
      trigger_type: true,
      trigger_id: true,
      trigger_metadata: true,
      plant_id: true,
      inverter_id: true,
      ai_narration: true,
      ai_edited_narration: true,
      ai_prompt_variant: true,
      ai_model_used: true,
      ai_edited: true,
      ai_regeneration_count: true,
      ai_generated_at: true,
      ai_approved_at: true,
      validation_action: true,
      validation_notes: true,
      resolution_notes: true,
      assigned_to_clerk_id: true,
      created_at: true,
      closed_at: true,
      status: true,
    },
    orderBy: { closed_at: 'desc' },
  });

  const tuples = tickets.map((t) => {
    const resolutionTimeH =
      t.closed_at && t.created_at
        ? Math.round(
            ((t.closed_at.getTime() - t.created_at.getTime()) / 3_600_000) * 10
          ) / 10
        : null;

    return {
      ticket_id: t.id,
      anomaly_context: t.trigger_metadata as Record<string, unknown> | null,
      plant_id: t.plant_id,
      inverter_id: t.inverter_id,
      llm_draft: t.ai_narration,
      operator_edited_version: t.ai_edited_narration,
      was_edited: Boolean(t.ai_edited),
      prompt_variant: t.ai_prompt_variant,
      llm_model: t.ai_model_used,
      regeneration_count: t.ai_regeneration_count,
      operator_id_hash: anonymise(t.assigned_to_clerk_id),
      validation_action: t.validation_action,
      validation_notes: t.validation_notes,
      resolution_notes: t.resolution_notes,
      resolution_time_h: resolutionTimeH,
      final_status: t.status,
      generated_at: t.ai_generated_at?.toISOString() ?? null,
      approved_at: t.ai_approved_at?.toISOString() ?? null,
      closed_at: t.closed_at?.toISOString() ?? null,
    };
  });

  return NextResponse.json({
    tuples,
    total: tuples.length,
    schema_version: '1.0',
    export_date: new Date().toISOString(),
    date_range: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    note: 'PII removed: operator_id_hash is sha256(salt + clerk_id); org_clerk_id dropped.',
  });
}

/**
 * One-way hash for operator identifiers. The salt is process-scoped, so the
 * same operator will hash to the same value within a single training-tuples
 * export but cannot be reversed and is not stable across deploys.
 */
const ANON_SALT = crypto.randomBytes(16).toString('hex');
function anonymise(clerkId: string | null | undefined): string | null {
  if (!clerkId) return null;
  return crypto
    .createHash('sha256')
    .update(`${ANON_SALT}:${clerkId}`)
    .digest('hex')
    .slice(0, 16);
}
