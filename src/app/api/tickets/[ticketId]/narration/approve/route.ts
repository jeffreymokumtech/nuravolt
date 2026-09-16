import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import { requireOrg } from '@/lib/api/tenant';
import type { InterpretedAlert } from '@/types/llm';
import type { TicketValidationAction } from '@/types/tickets';

const TRACKED_FIELDS = [
  'summary',
  'explanation',
  'likely_cause',
  'recommended_action',
  'urgency',
  'confidence',
] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

interface ApproveRequest {
  /** Optional edited narration. If present, fields that differ from the LLM
   *  draft are recorded as feedback rows. */
  edited_narration?: Partial<InterpretedAlert>;
  /** Free-text notes shown on the validation step. */
  validation_notes?: string;
}

/**
 * POST /api/tickets/[ticketId]/narration/approve
 *
 * Operator approves the LLM-drafted AI narration. If they edited anything,
 * each changed field becomes one TicketNarrationFeedback row (the A/B + the
 * fine-tune training signal).
 *
 * When the ticket is in `NEW`, this also transitions it to `VALIDATED` so the
 * operator hits one button rather than two. Validation action is set to
 * `VALIDATED_ADJUSTED` if anything was edited, otherwise `VALIDATED_CORRECT`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const { ticketId } = await params;
    const body: ApproveRequest = await request.json().catch(() => ({}));

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, org_clerk_id: authOrgId },
    });
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }
    if (!ticket.ai_narration) {
      return NextResponse.json(
        { error: 'Ticket has no AI narration to approve' },
        { status: 400 }
      );
    }
    if (ticket.ai_approved_at) {
      return NextResponse.json(
        { error: 'AI narration already approved' },
        { status: 400 }
      );
    }

    const aiDraft = ticket.ai_narration as unknown as InterpretedAlert;
    const edited = body.edited_narration ?? null;

    const changedFields: TrackedField[] = [];
    if (edited) {
      for (const field of TRACKED_FIELDS) {
        const aiVal = (aiDraft as Record<string, unknown>)[field];
        const newVal = (edited as Record<string, unknown>)[field];
        if (newVal !== undefined && newVal !== aiVal) {
          changedFields.push(field);
        }
      }
    }

    const wasEdited = changedFields.length > 0;
    const now = new Date();
    const variant = ticket.ai_prompt_variant ?? 'unknown';

    const isFromNew = ticket.status === 'NEW';
    const validationAction: TicketValidationAction = wasEdited
      ? 'VALIDATED_ADJUSTED'
      : 'VALIDATED_CORRECT';

    const updateData: Prisma.TicketUpdateInput = {
      ai_approved_by_clerk_id: userId,
      ai_approved_at: now,
      ai_edited: wasEdited,
    };

    if (wasEdited && edited) {
      // Merge: take the AI draft as the base, overlay each provided field.
      const mergedEdit: InterpretedAlert = { ...aiDraft };
      for (const field of TRACKED_FIELDS) {
        const newVal = (edited as Record<string, unknown>)[field];
        if (newVal !== undefined) {
          (mergedEdit as Record<string, unknown>)[field] = newVal;
        }
      }
      updateData.ai_edited_narration = mergedEdit as unknown as Prisma.InputJsonValue;
    }

    if (isFromNew) {
      updateData.status = 'VALIDATED';
      updateData.validated_at = now;
      updateData.validated_by_clerk_id = userId;
      updateData.validation_action = validationAction;
      if (body.validation_notes) {
        updateData.validation_notes = body.validation_notes;
      }
    }

    const updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: updateData,
    });

    // Feedback rows (one per changed field) — drives variant evaluation and
    // training-tuples export. Skip when nothing changed.
    if (changedFields.length > 0 && edited) {
      await prisma.ticketNarrationFeedback.createMany({
        data: changedFields.map((field) => ({
          ticket_id: ticketId,
          org_clerk_id: authOrgId,
          prompt_variant: String(variant),
          field_changed: field,
          ai_value: stringifyField((aiDraft as Record<string, unknown>)[field]),
          human_value: stringifyField((edited as Record<string, unknown>)[field]),
        })),
      });
    }

    if (isFromNew) {
      await prisma.ticketHistory.create({
        data: {
          ticket_id: ticketId,
          old_status: 'NEW',
          new_status: 'VALIDATED',
          changed_by_clerk_id: userId,
          change_reason: wasEdited
            ? `AI narration approved with ${changedFields.length} edit(s) (${changedFields.join(', ')})`
            : 'AI narration approved as-is',
        },
      });
    } else {
      await prisma.ticketHistory.create({
        data: {
          ticket_id: ticketId,
          new_status: ticket.status,
          changed_by_clerk_id: userId,
          change_reason: wasEdited
            ? `AI narration edits applied (${changedFields.join(', ')})`
            : 'AI narration approved',
        },
      });
    }

    return NextResponse.json({
      ticket_id: ticketId,
      status: updated.status,
      ai_edited: updated.ai_edited,
      ai_approved_at: updated.ai_approved_at?.toISOString() ?? null,
      validation_action: updated.validation_action,
      validated_at: updated.validated_at?.toISOString() ?? null,
      changed_fields: changedFields,
      message: wasEdited
        ? 'AI narration approved with edits'
        : 'AI narration approved as-is',
    });
  } catch (error) {
    console.error('Error approving narration:', error);
    return NextResponse.json(
      { error: 'Failed to approve narration' },
      { status: 500 }
    );
  }
}

function stringifyField(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
