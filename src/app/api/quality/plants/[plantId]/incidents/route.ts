import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import type { Prisma } from '@prisma/client';
import { requireOrg } from '@/lib/api/tenant';

type IncidentSeverity = 'low' | 'medium' | 'high';

interface CreateIncidentRequest {
  summary: string;
  severity?: IncidentSeverity;
  opened_by?: string;
  create_linked_ticket?: boolean;
}

// Map incident severity (low|medium|high) to ticket priority enum used by /api/tickets
function severityToTicketPriority(severity: IncidentSeverity): 'LOW' | 'MEDIUM' | 'HIGH' {
  switch (severity) {
    case 'low':
      return 'LOW';
    case 'high':
      return 'HIGH';
    case 'medium':
    default:
      return 'MEDIUM';
  }
}

// GET /api/quality/plants/[plantId]/incidents?status=open|closed|all
// List data-quality incidents for a plant (newest first, capped at 50).
export async function GET(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const status = request.nextUrl.searchParams.get('status') ?? 'open';
    const where: Record<string, unknown> = {
      org_clerk_id: ctx.authOrgId,
      plant_id: params.plantId,
    };
    if (status === 'open') where.closed_at = null;
    else if (status === 'closed') where.closed_at = { not: null };

    const incidents = await prisma.dataQualityIncident.findMany({
      where,
      orderBy: { opened_at: 'desc' },
      take: 50,
    });

    return NextResponse.json({ plant_id: params.plantId, incidents });
  } catch (error) {
    console.error('Error listing data quality incidents:', error);
    return NextResponse.json(
      { error: 'Failed to list data quality incidents' },
      { status: 500 }
    );
  }
}

// POST /api/quality/plants/[plantId]/incidents
// Body: { summary, severity?, opened_by?, create_linked_ticket? }
export async function POST(
  request: NextRequest,
  { params }: { params: { plantId: string } }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { plantId } = params;
    if (!plantId) {
      return NextResponse.json(
        { error: 'Missing plantId in route' },
        { status: 400 }
      );
    }

    const body = (await request.json()) as CreateIncidentRequest;

    if (!body.summary || typeof body.summary !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: summary' },
        { status: 400 }
      );
    }

    const severity: IncidentSeverity = body.severity || 'medium';
    if (!['low', 'medium', 'high'].includes(severity)) {
      return NextResponse.json(
        { error: 'Invalid severity. Must be low | medium | high' },
        { status: 400 }
      );
    }

    // Attribute the incident to the real signed-in user unless the caller
    // explicitly names an actor (automation may pass its own identity).
    const openedBy = body.opened_by || ctx.userId || 'system';

    // 1. Create the incident row first (no ticket linkage yet)
    const incident = await prisma.dataQualityIncident.create({
      data: {
        org_clerk_id: ctx.authOrgId,
        plant_id: plantId,
        summary: body.summary,
        severity,
        opened_by: openedBy,
      },
    });

    // 2. Optionally create a linked Ticket using the same prisma.ticket.create()
    //    shape as /api/tickets POST handler.
    let ticket: Awaited<ReturnType<typeof prisma.ticket.create>> | null = null;
    if (body.create_linked_ticket) {
      const ticketPriority = severityToTicketPriority(severity);

      // Ticket.plant_id is a real FK to Plant.id (UUID) — unlike the DQ
      // tables, which are slug-keyed with no FK. The route param is usually
      // the slug, so resolve it; without this the FK violated and the
      // linked ticket was silently never created.
      const plantRow = await prisma.plant.findFirst({
        where: { OR: [{ id: plantId }, { slug: plantId }] },
        select: { id: true },
      });
      if (!plantRow) {
        return NextResponse.json(
          { incident, ticket: null, ticket_error: 'plant not found for ticket linkage' },
          { status: 201 }
        );
      }

      ticket = await prisma.ticket.create({
        data: {
          org_clerk_id: ctx.authOrgId,
          plant_id: plantRow.id,
          title: body.summary,
          description: `Data quality incident: ${body.summary}`,
          priority: ticketPriority,
          // MANUAL_CREATION is the enum value; the previous 'MANUAL' failed
          // Prisma validation at runtime, so "Draft Ticket" opened the
          // incident but never actually created the linked ticket.
          trigger_type: 'MANUAL_CREATION',
          trigger_id: incident.id,
          trigger_metadata: {
            source: 'data_quality_incident',
            incident_id: incident.id,
            severity,
          } as Prisma.JsonValue,
          history: {
            create: {
              new_status: 'NEW',
              new_priority: ticketPriority,
              changed_by_clerk_id: openedBy,
              change_reason: 'Ticket created from data quality incident',
            },
          },
        },
        include: {
          plant: {
            select: { name: true },
          },
        },
      });

      // 3. Link the ticket back to the incident
      await prisma.dataQualityIncident.update({
        where: { id: incident.id },
        data: { ticket_id: ticket.id },
      });
    }

    // Return final incident (re-read so ticket_id reflects update)
    const finalIncident = body.create_linked_ticket
      ? await prisma.dataQualityIncident.findUnique({ where: { id: incident.id } })
      : incident;

    return NextResponse.json(
      {
        incident: finalIncident,
        ticket: ticket,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating data quality incident:', error);
    return NextResponse.json(
      { error: 'Failed to create data quality incident' },
      { status: 500 }
    );
  }
}
