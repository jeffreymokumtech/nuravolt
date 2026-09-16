import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';
import { requireOrg } from '@/lib/api/tenant';
import type { TicketComment, AddCommentRequest } from '@/types/tickets';

// GET /api/tickets/[ticketId]/comments - List comments
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId } = orgResult.ctx;

    const { ticketId } = await params;

    // Verify ticket exists and belongs to org
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

    const comments = await prisma.ticketComment.findMany({
      where: { ticket_id: ticketId },
      orderBy: { created_at: 'desc' },
    });

    const formattedComments: TicketComment[] = comments.map((c) => ({
      id: c.id,
      ticket_id: c.ticket_id,
      author_clerk_id: c.author_clerk_id,
      org_clerk_id: c.org_clerk_id,
      content: c.content,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
    }));

    return NextResponse.json({
      comments: formattedComments,
      total: comments.length,
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    return NextResponse.json(
      { error: 'Failed to fetch comments' },
      { status: 500 }
    );
  }
}

// POST /api/tickets/[ticketId]/comments - Add comment
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    const orgResult = await requireOrg();
    if (!orgResult.ok) return orgResult.response;
    const { authOrgId, userId } = orgResult.ctx;

    const { ticketId } = await params;
    const body: AddCommentRequest = await request.json();

    // Validate required fields
    if (!body.content || body.content.trim().length === 0) {
      return NextResponse.json(
        { error: 'Comment content is required' },
        { status: 400 }
      );
    }

    // Verify ticket exists and belongs to org
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

    const comment = await prisma.ticketComment.create({
      data: {
        ticket_id: ticketId,
        author_clerk_id: userId,
        org_clerk_id: authOrgId,
        content: body.content.trim(),
      },
    });

    const formattedComment: TicketComment = {
      id: comment.id,
      ticket_id: comment.ticket_id,
      author_clerk_id: comment.author_clerk_id,
      org_clerk_id: comment.org_clerk_id,
      content: comment.content,
      created_at: comment.created_at.toISOString(),
      updated_at: comment.updated_at.toISOString(),
    };

    return NextResponse.json(formattedComment, { status: 201 });
  } catch (error) {
    console.error('Error adding comment:', error);
    return NextResponse.json(
      { error: 'Failed to add comment' },
      { status: 500 }
    );
  }
}
