import Link from 'next/link';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import prisma from '@/libs/prisma';
import {
  DURATION_REFERENCE_HOURS,
  getOrgBilling,
  getOrgCapacityUsage,
  PLAN_LLM_BUDGETS,
} from '@/lib/billing/plan';
import { CheckCircle2, CreditCard, ArrowUpRight } from 'lucide-react';
import OpsOrgShell from '@/components/ops/OpsOrgShell';

export const dynamic = 'force-dynamic';

const PLAN_LABELS: Record<string, string> = {
  free: 'No plan',
  residential: 'Residential',
  business: 'Business',
  enterprise: 'Enterprise',
};

function UsageBar({
  label,
  used,
  cap,
  unit,
}: {
  label: string;
  used: number;
  cap: number | null;
  unit?: string;
}) {
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-blue-600';
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-gray-600">{label}</span>
        <span className="text-gray-900 font-medium">
          {used}
          {unit ? ` ${unit}` : ''}
          {cap !== null ? ` / ${cap}${unit ? ` ${unit}` : ''}` : ' (unlimited)'}
        </span>
      </div>
      {cap !== null && (
        <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams?: { success?: string };
}) {
  const session = await auth.api.getSession({ headers: headers() });
  const orgId = session?.session.activeOrganizationId ?? null;

  const billing = await getOrgBilling(orgId);
  const { plan, subscription, limits } = billing;

  const org = orgId
    ? await prisma.organization.findUnique({ where: { clerk_org_id: orgId } })
    : null;

  const [capacity, plantCount, memberCount] = org
    ? await Promise.all([
        getOrgCapacityUsage(org.id),
        prisma.plant.count({ where: { organization_id: org.id } }),
        orgId
          ? prisma.member.count({ where: { organizationId: orgId } }).catch(() => 1)
          : Promise.resolve(1),
      ])
    : [{ mw: 0, mwh: 0, equivalentMw: 0 }, 0, 1];
  const hasStorage = capacity.mwh > 0;

  // Shams / AI spend this calendar month (real Bedrock costs from
  // LLMInteraction). Fair-use context for the fixed-price promise.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  let aiCostMonth: number | null = null;
  let aiCallsMonth = 0;
  if (orgId) {
    try {
      const aiUsage = await prisma.lLMInteraction.aggregate({
        where: { org_clerk_id: orgId, created_at: { gte: monthStart } },
        _sum: { cost_usd: true },
        _count: { _all: true },
      });
      aiCostMonth = Number(aiUsage._sum.cost_usd ?? 0);
      aiCallsMonth = aiUsage._count._all;
    } catch {
      // Spend readout is informational — never break the billing page.
    }
  }
  const aiMonthlyCapUsd = PLAN_LLM_BUDGETS[plan]?.monthlyUsd ?? null;

  const periodEnd = subscription?.current_period_end
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(
        subscription.current_period_end
      )
    : null;

  const finite = (n: number) => (Number.isFinite(n) ? n : null);

  return (
    <OpsOrgShell activeNavKey="billing" section="BILLING">
      <header className="max-w-3xl mx-auto px-4 pt-6">
        <h1 className="text-xl font-bold text-gray-900">Billing</h1>
        <p className="text-sm text-gray-500">
          Plan, capacity and payment settings for your organization.
        </p>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {searchParams?.success === 'true' && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-green-50 border border-green-200 text-green-800 px-4 py-3 text-sm">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Payment complete. Your plan updates within a few seconds once Stripe confirms.
            </span>
            {plan === 'residential' && (
              <Link
                href="/dashboard/onboarding/residential"
                className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
              >
                Connect your inverter →
              </Link>
            )}
          </div>
        )}

        <section className="bg-white rounded-xl border shadow-sm p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-gray-500">Current plan</p>
              <p className="text-2xl font-bold text-gray-900 mt-0.5">
                {PLAN_LABELS[plan] ?? plan}
              </p>
              {plan === 'business' && Number.isFinite(limits.mw) && (
                <p className="text-sm text-gray-600 mt-1">
                  Capacity band: up to {limits.mw} {hasStorage ? 'equivalent ' : ''}MW under
                  management.
                </p>
              )}
              {subscription?.sub_status === 'trialing' && periodEnd && (
                <p className="text-sm text-blue-700 mt-2">
                  Free trial — converts to paid on {periodEnd}. Cancel anytime before then.
                </p>
              )}
              {periodEnd && subscription?.sub_status !== 'trialing' && (
                <p className="text-sm text-gray-600 mt-2">
                  {subscription?.cancel_at_period_end
                    ? `Cancels on ${periodEnd}.`
                    : `Renews on ${periodEnd}.`}
                </p>
              )}
              {subscription?.sub_status && (
                <p className="text-xs text-gray-400 mt-1 uppercase tracking-wide">
                  Status: {subscription.sub_status}
                </p>
              )}
            </div>
            <CreditCard className="h-6 w-6 text-gray-300" />
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            {subscription?.stripe_customer_id ? (
              <a
                href="/api/billing/portal"
                className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium px-4 py-2"
              >
                Manage subscription
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            ) : plan === 'free' ? (
              <>
                <a
                  href="/api/checkout/residential?interval=month"
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2"
                >
                  Start Residential trial
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
                <a
                  href="/api/checkout/business?band=S"
                  className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium px-4 py-2"
                >
                  Upgrade to Business
                </a>
              </>
            ) : plan === 'business' || plan === 'enterprise' ? (
              // Already on the tier the checkout link sells — point at the
              // next step (Enterprise conversation) instead of "Upgrade to
              // Business" on a Business org.
              <a
                href="/pricing#enterprise"
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2"
              >
                {plan === 'business' ? 'Talk to us about Enterprise' : 'Contact your account manager'}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            ) : (
              <a
                href="/api/checkout/business?band=S"
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2"
              >
                Upgrade to Business
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            )}
            <Link
              href="/pricing"
              className="inline-flex items-center rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium px-4 py-2"
            >
              Compare plans
            </Link>
          </div>
        </section>

        <section className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Usage</h2>
          <UsageBar
            label={hasStorage ? 'Equivalent capacity under management' : 'Capacity under management'}
            used={capacity.equivalentMw}
            cap={finite(limits.mw)}
            unit="MW"
          />
          {hasStorage && (
            <p className="text-xs text-gray-500">
              {capacity.mw} MW rated and {capacity.mwh} MWh of storage. Equivalent MW is the
              larger of a plant&apos;s rated MW and its storage MWh divided by{' '}
              {DURATION_REFERENCE_HOURS}.
            </p>
          )}
          <UsageBar label="Plants" used={plantCount} cap={finite(limits.plants)} />
          <UsageBar label="Seats" used={memberCount} cap={finite(limits.seats)} />
          <p className="text-xs text-gray-500">
            <Link href="/dashboard/settings/team" className="underline">
              Manage team members →
            </Link>
          </p>
          {plan === 'business' && (
            <p className="text-xs text-gray-500">
              Need a bigger capacity band? Upgrade from the{' '}
              <Link href="/pricing" className="underline">
                pricing page
              </Link>{' '}
              or talk to us about Enterprise.
            </p>
          )}
        </section>

        {aiCostMonth != null && (
          <section className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">Shams and AI usage</h2>
            <UsageBar
              label="AI spend this month (fair use)"
              used={Math.round(aiCostMonth * 100) / 100}
              cap={aiMonthlyCapUsd}
              unit="USD"
            />
            <p className="text-xs text-gray-500">
              {aiCallsMonth} AI calls this calendar month. Your plan price is fixed; this
              fair-use budget only throttles extreme usage, it is never billed per token.
            </p>
          </section>
        )}

        {plan === 'free' && (
          <p className="text-sm text-gray-500">
            Your organization has no plan yet, so plants and data connections can&apos;t be
            added. Residential is €9/month (or €90/year) with a 14-day free trial and
            covers one rooftop system up to 100 kW.
          </p>
        )}
        {plan === 'residential' && (
          <p className="text-sm text-gray-500">
            The Residential plan covers one rooftop system up to 100 kW with 1 seat.
            Business adds per-inverter soiling intelligence, the cleaning optimizer,
            fault detection, reports and MCP API keys — with fleet capacity bands, 25
            plants and 10 seats.
          </p>
        )}
      </main>
    </OpsOrgShell>
  );
}
