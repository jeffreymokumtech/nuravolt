import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Legacy route: 'growth' was renamed to 'business'. Old links land on the
 * smallest business band.
 */
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/api/checkout/business?band=S', request.url), {
    status: 308,
  });
}
