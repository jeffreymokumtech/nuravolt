import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getStripe } from '@/lib/billing/stripe';
import prisma from '@/libs/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/portal
 *
 * Opens the Stripe Billing Portal for the active organization's subscription
 * (self-serve cancel, payment-method changes, invoices).
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('redirect_url', '/dashboard/settings/billing');
    return NextResponse.redirect(signIn);
  }

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    return NextResponse.redirect(new URL('/create-organization', request.url));
  }

  const sub = await prisma.subscription.findUnique({ where: { org_id: orgId } });
  if (!sub?.stripe_customer_id) {
    return NextResponse.redirect(new URL('/pricing', request.url));
  }

  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: new URL('/dashboard/settings/billing', request.url).toString(),
  });

  return NextResponse.redirect(portal.url, { status: 303 });
}
