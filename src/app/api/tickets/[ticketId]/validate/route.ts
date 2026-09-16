import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import type { ValidateTicketRequest, TicketValidationAction } from '@/types/tickets';
import { emitTicketEvent } from '@/lib/integrations/webhooks';

// POST /api/tickets/[ticketId]/validate - Validate or dismiss a ticket
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const { ticketId } = await params;
    const body: ValidateTicketRequest = await request.json();

    // Validate required fields
    if (!body.validation_action) {
      return NextResponse.json(
        { error: 'Missing required field: validation_action' },
        { status: 400 }
      );
    }

    // Get current ticket
    const currentTicket = await prisma.ticket.findFirst({
      where: {
        id: ticketId,
        org_clerk_id: authOrgId,
      },
    });

    if (!currentTicket) {
      return NextResponse.json(
        { error: 'Ticket not found' },
        { status: 404 }
      );
    }

    // Only NEW tickets can be validated
    if (currentTicket.status !== 'NEW') {
      return NextResponse.json(
        { error: 'Only tickets with status NEW can be validated' },
        { status: 400 }
      );
    }

    // Determine new status based on validation action
    let newStatus: 'VALIDATED' | 'WONT_FIX';
    const isDismissal = body.validation_action.startsWith('DISMISSED');

    if (isDismissal) {
      newStatus = 'WONT_FIX';
    } else {
      newStatus = 'VALIDATED';
    }

    // Build update data
    const updateData: Record<string, unknown> = {
      status: newStatus,
      validated_at: new Date(),
      validated_by_clerk_id: userId,
      validation_action: body.validation_action,
      validation_notes: body.validation_notes,
    };

    // Handle adjustments
    if (body.validation_action === 'VALIDATED_ADJUSTED') {
      if (body.adjusted_title) updateData.title = body.adjusted_title;
      if (body.adjusted_description !== undefined) updateData.description = body.adjusted_description;
      if (body.adjusted_priority) updateData.priority = body.adjusted_priority;
    }

    // Set closed_at if dismissing
    if (newStatus === 'WONT_FIX') {
      updateData.closed_at = new Date();
    }

    // Update ticket
    const updatedTicket = await prisma.ticket.update({
      where: { id: ticketId },
      data: updateData,
    });

    // Create history entry
    await prisma.ticketHistory.create({
      data: {
        ticket_id: ticketId,
        old_status: currentTicket.status,
        new_status: newStatus,
        old_priority: body.adjusted_priority ? currentTicket.priority : null,
        new_priority: body.adjusted_priority || null,
        changed_by_clerk_id: userId,
        change_reason: getValidationChangeReason(body.validation_action, body.validation_notes),
      },
    });

    {
      const plant = await prisma.plant.findUnique({
        where: { id: currentTicket.plant_id },
        select: { slug: true, name: true },
      });
      await emitTicketEvent(authOrgId, 'ticket.status_changed', {
        id: updatedTicket.id,
        title: updatedTicket.title,
        status: updatedTicket.status,
        old_status: currentTicket.status,
        priority: updatedTicket.priority,
        plant_slug: plant?.slug ?? null,
        plant_name: plant?.name ?? null,
        url: `/dashboard/tickets/${updatedTicket.id}`,
      });
    }

    return NextResponse.json({
      id: updatedTicket.id,
      status: updatedTicket.status,
      validation_action: updatedTicket.validation_action,
      validated_at: updatedTicket.validated_at?.toISOString(),
      message: isDismissal
        ? 'Ticket dismissed - feedback recorded for ML training'
        : 'Ticket validated - ready for assignment',
    });
  } catch (error) {
    console.error('Error validating ticket:', error);
    return NextResponse.json(
      { error: 'Failed to validate ticket' },
      { status: 500 }
    );
  }
}

function getValidationChangeReason(
  action: TicketValidationAction,
  notes?: string
): string {
  const actionDescriptions: Record<TicketValidationAction, string> = {
    VALIDATED_CORRECT: 'Validated as correct',
    VALIDATED_ADJUSTED: 'Validated with adjustments',
    DISMISSED_FALSE_POSITIVE: 'Dismissed: False positive',
    DISMISSED_DUPLICATE: 'Dismissed: Duplicate',
    DISMISSED_NOT_ACTIONABLE: 'Dismissed: Not actionable',
  };

  let reason = actionDescriptions[action];
  if (notes) {
    reason += ` - ${notes}`;
  }
  return reason;
}
