import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getStripe } from '@/lib/billing/stripe';
import { BUSINESS_BANDS, type BusinessBand } from '@/lib/billing/plan';

export const dynamic = 'force-dynamic';

/**
 * GET /api/checkout/business?band=S|M|L|XL
 *
 * Creates a Stripe Checkout session for the chosen Business band and
 * redirects to it. Each band's Stripe Price must carry metadata
 * `mw_cap=<number>` — the webhook persists it onto Subscription.mw_cap.
 * A band whose price env var is not populated yet answers 503, never a 500.
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });

  const bandParam = (request.nextUrl.searchParams.get('band') ?? 'S').toUpperCase();
  const band = (bandParam in BUSINESS_BANDS ? bandParam : 'S') as BusinessBand;

  if (!session) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('redirect_url', `/api/checkout/business?band=${band}`);
    return NextResponse.redirect(signIn);
  }

  const orgId = session.session.activeOrganizationId;
  if (!orgId) {
    return NextResponse.redirect(new URL('/create-organization', request.url));
  }

  const priceId = process.env[BUSINESS_BANDS[band].envPrice];
  if (!priceId) {
    return NextResponse.json(
      {
        error: 'billing_not_configured',
        message: `The ${band} capacity band is not open for self-serve checkout yet (${BUSINESS_BANDS[band].envPrice} is not set). Talk to us and we will set it up.`,
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
      metadata: { org_id: orgId, plan_id: 'business', band },
    },
    metadata: { org_id: orgId, plan_id: 'business', band },
    allow_promotion_codes: true,
    success_url: new URL('/dashboard/settings/billing?success=true', request.url).toString(),
    cancel_url: new URL('/pricing?canceled=true', request.url).toString(),
  });

  if (!checkout.url) {
    return NextResponse.json({ error: 'checkout_failed' }, { status: 500 });
  }

  return NextResponse.redirect(checkout.url, { status: 303 });
}
