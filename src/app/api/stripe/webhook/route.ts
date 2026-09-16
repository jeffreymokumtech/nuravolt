import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/billing/stripe';
import prisma from '@/libs/prisma';
import { normalizePlanId, PLAN_LLM_BUDGETS } from '@/lib/billing/plan';

export const dynamic = 'force-dynamic';

type SubStatus = 'active' | 'inactive' | 'trialing' | 'past_due' | 'canceled' | 'unpaid';

function mapStripeStatus(status: Stripe.Subscription.Status): SubStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'unpaid':
      return 'unpaid';
    default:
      // incomplete / incomplete_expired / paused
      return 'inactive';
  }
}

/** Paid statuses keep the legacy Organization row's plan flags in sync. */
function isEntitled(status: SubStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

async function syncLegacyOrgPlan(orgId: string, planId: string, entitled: boolean) {
  const caps =
    planId === 'business' || planId === 'growth'
      ? { max_plants: 25, max_users: 10 }
      : planId === 'enterprise'
        ? { max_plants: 100000, max_users: 100000 }
        : { max_plants: 1, max_users: 1 }; // residential
  await prisma.organization
    .update({
      where: { clerk_org_id: orgId },
      data: entitled
        ? { plan_type: planId, ...caps }
        : // 'free' = no plan: normalizePlanId('free') → null, grants nothing.
          { plan_type: 'free', max_plants: 5, max_users: 5 },
    })
    .catch(() => {
      // Legacy row may not exist yet (org created pre-sync); not fatal.
    });
}

/** Keep the org's AI cost caps in step with its tier (plan.ts PLAN_LLM_BUDGETS).
 *  Trade-off: manually raised caps are reset on subscription lifecycle events. */
async function syncLLMBudget(orgId: string, planId: string) {
  const caps = PLAN_LLM_BUDGETS[normalizePlanId(planId) ?? 'free'];
  await prisma.orgLLMBudget
    .upsert({
      where: { org_clerk_id: orgId },
      update: { daily_cap_usd: caps.dailyUsd, monthly_cap_usd: caps.monthlyUsd },
      create: {
        org_clerk_id: orgId,
        daily_cap_usd: caps.dailyUsd,
        monthly_cap_usd: caps.monthlyUsd,
      },
    })
    .catch(() => {});
}

async function upsertFromSubscription(
  sub: Stripe.Subscription,
  fallback: { orgId?: string; email?: string; checkoutSessionId?: string }
) {
  const orgId = sub.metadata?.org_id ?? fallback.orgId;
  if (!orgId) {
    console.error('[stripe/webhook] subscription without org_id metadata:', sub.id);
    return;
  }

  const planId = sub.metadata?.plan_id ?? 'business';
  const status = mapStripeStatus(sub.status);
  const item = sub.items.data[0];
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // Business bands carry their MW cap on the Stripe Price metadata.
  const rawMwCap = item?.price?.metadata?.mw_cap;
  const mwCap = rawMwCap ? Number(rawMwCap) : null;

  const shared = {
    sub_status: status as any,
    sub_type: planId,
    plan_id: planId,
    stripe_price_id: item?.price.id ?? null,
    sub_stripe_id: sub.id,
    current_period_end: new Date(sub.current_period_end * 1000),
    cancel_at_period_end: sub.cancel_at_period_end,
    quantity: item?.quantity ?? 1,
    mw_cap: mwCap && Number.isFinite(mwCap) ? mwCap : null,
  };

  await prisma.subscription.upsert({
    where: { org_id: orgId },
    update: {
      ...shared,
      stripe_customer_id: customerId,
      ...(fallback.checkoutSessionId ? { last_stripe_cs_id: fallback.checkoutSessionId } : {}),
    },
    create: {
      ...shared,
      org_id: orgId,
      user_email: fallback.email ?? `org-${orgId}@unknown.invalid`,
      user_clerk_id: sub.metadata?.user_id ?? `org:${orgId}`,
      stripe_customer_id: customerId,
      last_stripe_cs_id: fallback.checkoutSessionId ?? `sub:${sub.id}`,
    },
  });

  await syncLegacyOrgPlan(orgId, planId, isEntitled(status));
  await syncLLMBudget(orgId, planId);
}

/**
 * POST /api/stripe/webhook
 *
 * Stripe subscription lifecycle → Subscription rows (org-keyed) + legacy
 * Organization.plan_type sync. vercel.json reserves 60s for this route.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }

  const stripe = getStripe();
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err: any) {
    console.error('[stripe/webhook] signature verification failed:', err?.message);
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const cs = event.data.object as Stripe.Checkout.Session;
        if (cs.mode !== 'subscription' || !cs.subscription) break;
        const sub = await stripe.subscriptions.retrieve(
          typeof cs.subscription === 'string' ? cs.subscription : cs.subscription.id
        );
        await upsertFromSubscription(sub, {
          orgId: cs.client_reference_id ?? undefined,
          email: cs.customer_details?.email ?? undefined,
          checkoutSessionId: cs.id,
        });
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await upsertFromSubscription(sub, {});
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId =
          typeof invoice.subscription === 'string'
            ? invoice.subscription
            : invoice.subscription?.id;
        if (subId) {
          await prisma.subscription
            .updateMany({
              where: { sub_stripe_id: subId },
              data: { sub_status: 'past_due' as any },
            })
            .catch(() => {});
        }
        break;
      }

      default:
        break;
    }
  } catch (err: any) {
    console.error(`[stripe/webhook] handler failed for ${event.type}:`, err?.message);
    // 500 → Stripe retries with backoff.
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
