import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';

export const runtime = 'nodejs';

interface RouteParams {
  params: {
    plantId: string;
    incidentId: string;
  };
}

// PATCH /api/quality/plants/[plantId]/incidents/[incidentId]
// Close a data-quality incident (sets closed_at = now()). The incident
// lifecycle used to be one-way: `closed_at` existed in the schema and the
// curation log already renders `incident_closed`, but nothing could set it.
// Optionally resolves the linked ticket (body: { resolve_ticket?: true }).
// Idempotent: closing an already-closed incident is a no-op 200.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { ctx } = orgResult;

    const { plantId, incidentId } = params;

    let resolveTicket = false;
    try {
      const raw = await request.text();
      if (raw) {
        const body = JSON.parse(raw) as { resolve_ticket?: boolean };
        resolveTicket = body.resolve_ticket === true;
      }
    } catch {
      // Empty/invalid body → defaults.
    }

    const incident = await prisma.dataQualityIncident.findFirst({
      where: {
        id: incidentId,
        org_clerk_id: ctx.authOrgId,
        plant_id: plantId,
      },
    });
    if (!incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    if (incident.closed_at) {
      return NextResponse.json({ incident, already_closed: true });
    }

    const now = new Date();
    const updated = await prisma.dataQualityIncident.update({
      where: { id: incident.id },
      data: { closed_at: now },
    });

    if (resolveTicket && incident.ticket_id) {
      try {
        await prisma.ticket.update({
          where: { id: incident.ticket_id },
          data: {
            status: 'DONE',
            history: {
              create: {
                new_status: 'DONE',
                changed_by_clerk_id: ctx.userId ?? 'system',
                change_reason: 'Linked data-quality incident closed',
              },
            },
          },
        });
      } catch (e) {
        // The incident close already succeeded; a ticket update failure
        // should surface in the payload, not roll back the close.
        console.warn('Incident closed but linked ticket update failed:', e);
        return NextResponse.json({ incident: updated, ticket_resolved: false });
      }
      return NextResponse.json({ incident: updated, ticket_resolved: true });
    }

    return NextResponse.json({ incident: updated });
  } catch (error) {
    console.error('Error closing data quality incident:', error);
    return NextResponse.json(
      { error: 'Failed to close data quality incident' },
      { status: 500 }
    );
  }
}
