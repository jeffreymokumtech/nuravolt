import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { Prisma } from '@prisma/client';
import { requireOrg } from '@/lib/api/tenant';
import { emitTicketEvent } from '@/lib/integrations/webhooks';
import { recordActivity } from '@/lib/activity';
import type {
  TicketFilters,
  TicketListResponse,
  TicketSummary,
  CreateTicketRequest,
  TicketStatus,
  TicketPriority,
  TicketTriggerType,
} from '@/types/tickets';

// GET /api/tickets - List tickets with filtering and pagination
export async function GET(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;

    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = Math.min(parseInt(searchParams.get('page_size') || '20', 10), 100);
    const skip = (page - 1) * pageSize;

    // Build filters
    const filters: TicketFilters = {
      status: searchParams.get('status')?.split(',') as TicketStatus[] | undefined,
      priority: searchParams.get('priority')?.split(',') as TicketPriority[] | undefined,
      trigger_type: searchParams.get('trigger_type')?.split(',') as TicketTriggerType[] | undefined,
      plant_id: searchParams.get('plant_id') || undefined,
      inverter_id: searchParams.get('inverter_id') || undefined,
      assigned_to_clerk_id: searchParams.get('assigned_to') || undefined,
      created_after: searchParams.get('created_after') || undefined,
      created_before: searchParams.get('created_before') || undefined,
      search: searchParams.get('search') || undefined,
    };

    // Build Prisma where clause
    const where: Prisma.TicketWhereInput = {
      org_clerk_id: authOrgId,
    };

    if (filters.status) {
      const statusArray = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statusArray.length > 0) {
        where.status = { in: statusArray };
      }
    }
    if (filters.priority) {
      const priorityArray = Array.isArray(filters.priority) ? filters.priority : [filters.priority];
      if (priorityArray.length > 0) {
        where.priority = { in: priorityArray };
      }
    }
    if (filters.trigger_type) {
      const triggerArray = Array.isArray(filters.trigger_type) ? filters.trigger_type : [filters.trigger_type];
      if (triggerArray.length > 0) {
        where.trigger_type = { in: triggerArray };
      }
    }
    if (filters.plant_id) {
      where.plant_id = filters.plant_id;
    }
    if (filters.inverter_id) {
      where.inverter_id = filters.inverter_id;
    }
    if (filters.assigned_to_clerk_id) {
      where.assigned_to_clerk_id = filters.assigned_to_clerk_id;
    }
    if (filters.created_after) {
      where.created_at = { ...where.created_at as object, gte: new Date(filters.created_after) };
    }
    if (filters.created_before) {
      where.created_at = { ...where.created_at as object, lte: new Date(filters.created_before) };
    }
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // Execute queries in parallel
    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [
          { priority: 'asc' }, // CRITICAL first
          { created_at: 'desc' },
        ],
        include: {
          plant: {
            select: {
              name: true,
            },
          },
          _count: {
            select: {
              comments: true,
            },
          },
        },
      }),
      prisma.ticket.count({ where }),
    ]);

    // Transform to response format
    const ticketSummaries: TicketSummary[] = tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status as TicketStatus,
      priority: ticket.priority as TicketPriority,
      trigger_type: ticket.trigger_type as TicketTriggerType,
      plant_id: ticket.plant_id,
      plant_name: ticket.plant.name || undefined,
      inverter_id: ticket.inverter_id,
      assigned_to_clerk_id: ticket.assigned_to_clerk_id,
      estimated_revenue_impact_eur: ticket.estimated_revenue_impact_eur
        ? parseFloat(ticket.estimated_revenue_impact_eur.toString())
        : null,
      estimated_energy_loss_kwh: ticket.estimated_energy_loss_kwh
        ? parseFloat(ticket.estimated_energy_loss_kwh.toString())
        : null,
      created_at: ticket.created_at.toISOString(),
      updated_at: ticket.updated_at.toISOString(),
      closed_at: ticket.closed_at?.toISOString() || null,
      comment_count: ticket._count.comments,
    }));

    const response: TicketListResponse = {
      tickets: ticketSummaries,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tickets' },
      { status: 500 }
    );
  }
}

// POST /api/tickets - Create a new ticket
export async function POST(request: NextRequest) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const body: CreateTicketRequest = await request.json();

    // Validate required fields
    if (!body.plant_id || !body.title || !body.trigger_type) {
      return NextResponse.json(
        { error: 'Missing required fields: plant_id, title, trigger_type' },
        { status: 400 }
      );
    }

    // Verify plant exists (skip validation for demo plant IDs)
    const isDemoPlant = body.plant_id.startsWith('demo_') || body.plant_id === 'alpha1_1';
    if (!isDemoPlant) {
      // Ticket.plant_id is a foreign key to Plant.id (see prisma schema). Try
      // Plant first; fall back to DiscoveredPlant for legacy callers that still
      // reference the discovered-plant id space.
      const [plant, discovered] = await Promise.all([
        prisma.plant.findUnique({ where: { id: body.plant_id } }),
        prisma.discoveredPlant.findUnique({ where: { id: body.plant_id } }),
      ]);

      if (!plant && !discovered) {
        return NextResponse.json(
          { error: 'Plant not found' },
          { status: 404 }
        );
      }
    }

    // Create ticket with initial history entry
    const ticket = await prisma.ticket.create({
      data: {
        org_clerk_id: authOrgId,
        plant_id: body.plant_id,
        inverter_id: body.inverter_id,
        title: body.title,
        description: body.description,
        priority: body.priority || 'MEDIUM',
        trigger_type: body.trigger_type,
        trigger_id: body.trigger_id,
        trigger_metadata: body.trigger_metadata as Prisma.JsonValue,
        estimated_revenue_impact_eur: body.estimated_revenue_impact_eur,
        estimated_energy_loss_kwh: body.estimated_energy_loss_kwh,
        history: {
          create: {
            new_status: 'NEW',
            new_priority: body.priority || 'MEDIUM',
            changed_by_clerk_id: userId,
            change_reason: 'Ticket created',
          },
        },
      },
      include: {
        plant: {
          select: {
            name: true,
            slug: true,
          },
        },
      },
    });

    // Outbound integrations: awaited (serverless kills orphan promises);
    // never fails the ticket write.
    await emitTicketEvent(authOrgId, 'ticket.created', {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      plant_slug: ticket.plant.slug,
      plant_name: ticket.plant.name,
      trigger_type: ticket.trigger_type,
      estimated_revenue_impact_eur: body.estimated_revenue_impact_eur ?? null,
      url: `/dashboard/tickets/${ticket.id}`,
    });

    recordActivity({
      orgClerkId: authOrgId,
      userId,
      action: 'ticket.created',
      targetType: 'ticket',
      targetId: ticket.id,
      plantId: body.plant_id,
      metadata: { title: ticket.title, priority: ticket.priority, trigger: ticket.trigger_type },
    });

    return NextResponse.json({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      trigger_type: ticket.trigger_type,
      plant_id: ticket.plant_id,
      plant_name: ticket.plant.name,
      created_at: ticket.created_at.toISOString(),
    }, { status: 201 });
  } catch (error) {
    console.error('Error creating ticket:', error);
    return NextResponse.json(
      { error: 'Failed to create ticket' },
      { status: 500 }
    );
  }
}
