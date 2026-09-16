import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getStripe } from '@/lib/billing/stripe';
import { RESIDENTIAL_PRICES, type ResidentialInterval } from '@/lib/billing/plan';

export const dynamic = 'force-dynamic';

/**
 * GET /api/checkout/residential?interval=month|year
 *
 * Creates a Stripe Checkout session for the Residential plan (€9/mo or
 * €90/yr) with a 14-day free trial. The card is collected upfront (Checkout's
 * default payment_method_collection) and the subscription auto-converts when
 * the trial ends; `trialing` counts as entitled (plan.ts ENTITLED_STATUSES).
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });

  const intervalParam = (request.nextUrl.searchParams.get('interval') ?? 'month').toLowerCase();
  const interval = (['month', 'year'].includes(intervalParam)
    ? intervalParam
    : 'month') as ResidentialInterval;

  if (!session) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('redirect_url', `/api/checkout/residential?interval=${interval}`);
    return NextResponse.redirect(signIn);
  }

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    return NextResponse.redirect(new URL('/create-organization', request.url));
  }

  const priceId = process.env[RESIDENTIAL_PRICES[interval]];
  if (!priceId) {
    return NextResponse.json(
      {
        error: 'billing_not_configured',
        message: `${RESIDENTIAL_PRICES[interval]} is not set`,
      },
      { status: 503 }
    );
  }

  const stripe = getStripe();
  const checkout = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: orgId,
    customer_email: session.user.email,
    subscription_data: {
      trial_period_days: 14,
      metadata: { org_id: orgId, plan_id: 'residential' },
    },
    metadata: { org_id: orgId, plan_id: 'residential' },
    allow_promotion_codes: true,
    success_url: new URL('/dashboard/settings/billing?success=true', request.url).toString(),
    cancel_url: new URL('/pricing?canceled=true', request.url).toString(),
  });

  if (!checkout.url) {
    return NextResponse.json({ error: 'checkout_failed' }, { status: 500 });
  }

  return NextResponse.redirect(checkout.url, { status: 303 });
}
