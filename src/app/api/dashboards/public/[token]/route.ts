import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/libs/prisma';

// GET /api/dashboards/public/[token] — unauthenticated read for /r/[token]
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } },
) {
  try {
    const d = await prisma.dashboard.findFirst({
      where: { share_token: params.token },
    });
    if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (d.share_expires_at && d.share_expires_at < new Date()) {
      return NextResponse.json({ error: 'Link expired' }, { status: 410 });
    }
    // Do not leak owner_id / organization_id over the public endpoint.
    return NextResponse.json({
      data: {
        id: d.id,
        slug: d.slug,
        title: d.title,
        description: d.description,
        scope_plant_ids: d.scope_plant_ids,
        scope_device_ids: d.scope_device_ids,
        default_range: d.default_range,
        default_from: d.default_from,
        default_to: d.default_to,
        widgets: d.widgets,
      },
    });
  } catch (error) {
    console.error('Public dashboard fetch failed:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
