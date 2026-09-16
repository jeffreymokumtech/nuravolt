import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import { emitTicketEvent } from '@/lib/integrations/webhooks';
import { recordActivity } from '@/lib/activity';
import { resendService } from '@/libs/resend';
import type {
  TicketDetail,
  UpdateTicketRequest,
  TicketStatus,
  TicketPriority,
  TicketTriggerType,
  TicketValidationAction,
  AINarration,
} from '@/types/tickets';

// GET /api/tickets/[ticketId] - Get ticket detail
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;

    const { ticketId } = await params;

    const ticket = await prisma.ticket.findFirst({
      where: {
        id: ticketId,
        org_clerk_id: authOrgId,
      },
      include: {
        plant: {
          select: {
            name: true,
          },
        },
        comments: {
          orderBy: { created_at: 'desc' },
        },
        history: {
          orderBy: { changed_at: 'desc' },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json(
        { error: 'Ticket not found' },
        { status: 404 }
      );
    }

    const detail: TicketDetail = {
      id: ticket.id,
      org_clerk_id: ticket.org_clerk_id,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status as TicketStatus,
      priority: ticket.priority as TicketPriority,
      trigger_type: ticket.trigger_type as TicketTriggerType,
      trigger_id: ticket.trigger_id,
      trigger_metadata: ticket.trigger_metadata as Record<string, unknown> | null,
      plant_id: ticket.plant_id,
      plant_name: ticket.plant.name || undefined,
      inverter_id: ticket.inverter_id,
      assigned_to_clerk_id: ticket.assigned_to_clerk_id,
      assigned_at: ticket.assigned_at?.toISOString() || null,
      assigned_by_clerk_id: ticket.assigned_by_clerk_id,
      validated_at: ticket.validated_at?.toISOString() || null,
      validated_by_clerk_id: ticket.validated_by_clerk_id,
      validation_action: ticket.validation_action as TicketValidationAction | null,
      validation_notes: ticket.validation_notes,
      estimated_revenue_impact_eur: ticket.estimated_revenue_impact_eur
        ? parseFloat(ticket.estimated_revenue_impact_eur.toString())
        : null,
      estimated_energy_loss_kwh: ticket.estimated_energy_loss_kwh
        ? parseFloat(ticket.estimated_energy_loss_kwh.toString())
        : null,
      resolution_notes: ticket.resolution_notes,
      ai_narration: (ticket.ai_narration as unknown as AINarration | null) ?? null,
      ai_edited_narration:
        (ticket.ai_edited_narration as unknown as AINarration | null) ?? null,
      ai_model_used: ticket.ai_model_used,
      ai_generated_at: ticket.ai_generated_at?.toISOString() ?? null,
      ai_prompt_variant: ticket.ai_prompt_variant,
      ai_approved_by_clerk_id: ticket.ai_approved_by_clerk_id,
      ai_approved_at: ticket.ai_approved_at?.toISOString() ?? null,
      ai_edited: ticket.ai_edited,
      ai_regeneration_count: ticket.ai_regeneration_count,
      created_at: ticket.created_at.toISOString(),
      updated_at: ticket.updated_at.toISOString(),
      closed_at: ticket.closed_at?.toISOString() || null,
      comments: ticket.comments.map((c) => ({
        id: c.id,
        ticket_id: c.ticket_id,
        author_clerk_id: c.author_clerk_id,
        org_clerk_id: c.org_clerk_id,
        content: c.content,
        created_at: c.created_at.toISOString(),
        updated_at: c.updated_at.toISOString(),
      })),
      history: ticket.history.map((h) => ({
        id: h.id,
        ticket_id: h.ticket_id,
        old_status: h.old_status as TicketStatus | null,
        new_status: h.new_status as TicketStatus,
        old_priority: h.old_priority as TicketPriority | null,
        new_priority: h.new_priority as TicketPriority | null,
        changed_by_clerk_id: h.changed_by_clerk_id,
        change_reason: h.change_reason,
        changed_at: h.changed_at.toISOString(),
      })),
    };

    return NextResponse.json(detail);
  } catch (error) {
    console.error('Error fetching ticket:', error);
    return NextResponse.json(
      { error: 'Failed to fetch ticket' },
      { status: 500 }
    );
  }
}

// PATCH /api/tickets/[ticketId] - Update ticket
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const { ticketId } = await params;
    const body: UpdateTicketRequest = await request.json();

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

    // Determine if status or priority changed for history tracking
    const statusChanged = body.status && body.status !== currentTicket.status;
    const priorityChanged = body.priority && body.priority !== currentTicket.priority;

    // Build update data
    const updateData: Record<string, unknown> = {};

    if (body.title) updateData.title = body.title;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.status) updateData.status = body.status;
    if (body.priority) updateData.priority = body.priority;
    if (body.resolution_notes !== undefined) updateData.resolution_notes = body.resolution_notes;

    // Handle assignment
    if (body.assigned_to_clerk_id !== undefined) {
      updateData.assigned_to_clerk_id = body.assigned_to_clerk_id;
      if (body.assigned_to_clerk_id) {
        updateData.assigned_at = new Date();
        updateData.assigned_by_clerk_id = userId;
      } else {
        updateData.assigned_at = null;
        updateData.assigned_by_clerk_id = null;
      }
    }

    // Handle status transitions
    if (body.status === 'DONE' || body.status === 'WONT_FIX') {
      updateData.closed_at = new Date();
    } else if (currentTicket.status === 'DONE' || currentTicket.status === 'WONT_FIX') {
      // Reopening
      updateData.closed_at = null;
    }

    // Update ticket
    const updatedTicket = await prisma.ticket.update({
      where: { id: ticketId },
      data: updateData,
    });

    if (statusChanged || priorityChanged) {
      recordActivity({
        orgClerkId: authOrgId,
        userId,
        action: statusChanged ? 'ticket.status_changed' : 'ticket.priority_changed',
        targetType: 'ticket',
        targetId: ticketId,
        plantId: currentTicket.plant_id,
        metadata: {
          from: statusChanged ? currentTicket.status : currentTicket.priority,
          to: statusChanged ? body.status : body.priority,
        },
      });
    }

    // Create history entry if status or priority changed
    if (statusChanged || priorityChanged) {
      await prisma.ticketHistory.create({
        data: {
          ticket_id: ticketId,
          old_status: statusChanged ? currentTicket.status : null,
          new_status: body.status || currentTicket.status,
          old_priority: priorityChanged ? currentTicket.priority : null,
          new_priority: priorityChanged ? body.priority : null,
          changed_by_clerk_id: userId,
          change_reason: body.change_reason,
        },
      });
    }

    if (statusChanged) {
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

    // Tell a newly assigned operator by email. Awaited (so it runs on
    // serverless) but best-effort: never fails the request. Skips
    // self-assignment and demo orgs.
    const newAssignee = body.assigned_to_clerk_id;
    if (
      newAssignee &&
      newAssignee !== currentTicket.assigned_to_clerk_id &&
      newAssignee !== userId &&
      !authOrgId.startsWith('demo_')
    ) {
      try {
        const member = await prisma.member.findFirst({
          where: { organizationId: authOrgId, userId: newAssignee },
          include: { user: { select: { email: true } } },
        });
        const email = member?.user?.email;
        if (email) {
          const assignedPlant = await prisma.plant.findUnique({
            where: { id: currentTicket.plant_id },
            select: { name: true },
          });
          const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://nuravolt.com';
          await resendService.sendTicketAssignment(email, {
            ticketTitle: updatedTicket.title,
            plantName: assignedPlant?.name ?? 'your plant',
            priority: updatedTicket.priority,
            ticketUrl: `${base}/dashboard/tickets/${updatedTicket.id}`,
          });
        }
      } catch (e) {
        console.warn('[ticket] assignee notify failed:', e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({
      id: updatedTicket.id,
      status: updatedTicket.status,
      priority: updatedTicket.priority,
      updated_at: updatedTicket.updated_at.toISOString(),
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    return NextResponse.json(
      { error: 'Failed to update ticket' },
      { status: 500 }
    );
  }
}

// DELETE /api/tickets/[ticketId] - Delete ticket
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;

    const { ticketId } = await params;

    const ticket = await prisma.ticket.findFirst({
      where: {
        id: ticketId,
        org_clerk_id: authOrgId,
      },
    });

    if (!ticket) {
      return NextResponse.json(
        { error: 'Ticket not found' },
        { status: 404 }
      );
    }

    // Cascade delete will handle comments and history
    await prisma.ticket.delete({
      where: { id: ticketId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    return NextResponse.json(
      { error: 'Failed to delete ticket' },
      { status: 500 }
    );
  }
}
