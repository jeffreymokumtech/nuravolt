import prisma from '@/libs/prisma';
import type { Subscription } from '@prisma/client';

/**
 * Tiers are boxed primarily by MW under management:
 *  - free: an org with NO plan (never subscribed / lapsed). Can sign in and
 *    browse, but cannot onboard plants or connections — the pricing page is
 *    the way out. This is the default for new orgs.
 *  - residential: €9/mo or €90/yr, 14-day trial. One rooftop (<= 100 kW).
 *  - business: paid, four fixed bands (S <= 2, M <= 8, L <= 20, XL <= 60
 *    equivalent MW). The purchased band's cap arrives via Stripe price metadata
 *    and is stored on Subscription.mw_cap; plan defaults below are the fallback
 *    for hand-granted orgs without a Stripe row.
 *  - enterprise: custom, unlimited.
 *
 * 'growth' is the legacy plan id for business — normalized in code, never
 * migrated in the DB. Hand-granting: set Organization.plan_type to
 * 'residential'|'growth'|'business'|'enterprise' (plan_type='free' grants
 * nothing — it's the org-creation default).
 */
export type Plan = 'free' | 'residential' | 'business' | 'enterprise';

export type Feature =
  | 'analytics:per_inverter_soiling'
  | 'analytics:cleaning_optimizer'
  | 'analytics:fault_detection'
  | 'analytics:bess'
  | 'analytics:hydrogen'
  | 'ai:insights'
  | 'ai:copilot'
  | 'reports:builder'
  | 'tickets:export'
  | 'integrations:webhooks'
  | 'mcp:api_keys'
  | 'mcp:oauth';

/** Statuses that grant paid-plan entitlements. past_due keeps access during dunning. */
const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'] as const;

export interface PlanLimits {
  /** Total fleet capacity cap, in equivalent MW (see equivalentMw). */
  mw: number;
  plants: number;
  seats: number;
  connections: number;
}

/**
 * Reference discharge duration for the storage side of the capacity meter.
 *
 * 4 hours is the reference duration used for capacity de-rating in both GB and
 * Iberia, so a 4-hour battery is priced identically on a power basis or an
 * energy basis. The meter therefore only bites on genuinely long-duration
 * assets, where rack count, warranty surface and analytics cost all scale with
 * energy rather than power.
 */
export const DURATION_REFERENCE_HOURS = 4;

/**
 * The billed size of one plant: `max(rated MW, MWh / 4)`.
 *
 * Properties this form is chosen for, all load-bearing:
 *  - PV and wind plants carry energy_capacity_mwh = NULL, so the energy term is
 *    0 and max() returns rated MW. No existing customer's bill moves. Do not
 *    break this.
 *  - A 2-hour battery still prices on its MW; only assets longer than the
 *    4-hour reference price on energy.
 *  - The result stays expressed in MW, so Subscription.mw_cap, the Stripe
 *    prices and every existing billing surface keep working unchanged.
 *
 * Nonsense inputs (negative, NaN) count as zero rather than throwing: this runs
 * inside the onboarding gate and must never take a plant-creation request down.
 */
export function equivalentMw(mw: number, mwh: number | null | undefined): number {
  const ratedMw = Number.isFinite(mw) && mw > 0 ? Number(mw) : 0;
  const energy = mwh == null ? 0 : Number(mwh);
  const energyMwh = Number.isFinite(energy) && energy > 0 ? energy : 0;
  return Math.max(ratedMw, energyMwh / DURATION_REFERENCE_HOURS);
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  // No plan: nothing can be onboarded; seats:1 keeps the org's owner sane.
  free: { mw: 0, plants: 0, seats: 1, connections: 0 },
  residential: { mw: 0.1, plants: 1, seats: 1, connections: 1 },
  // Default business cap = the L band; Stripe-purchased bands override via mw_cap.
  business: { mw: 20, plants: 25, seats: 10, connections: 10 },
  enterprise: {
    mw: Number.POSITIVE_INFINITY,
    plants: Number.POSITIVE_INFINITY,
    seats: Number.POSITIVE_INFINITY,
    connections: Number.POSITIVE_INFINITY,
  },
};

/**
 * Business bands (also encoded in Stripe price metadata as mw_cap). Caps are in
 * equivalent MW.
 *
 * XL exists because a single grid-scale battery (say 50 MW / 200 MWh) used to
 * fall straight off the end of the L band into "Talk to us", with no self-serve
 * path at all. The 60 MW cap and its price point are a founder decision and can
 * be retuned; STRIPE_PRICE_BUSINESS_XL_MONTHLY must be created in Stripe (with
 * `mw_cap=60` price metadata) before the band is purchasable. Until then the
 * checkout route answers 503 billing_not_configured rather than failing.
 */
export const BUSINESS_BANDS = {
  S: { mwCap: 2, envPrice: 'STRIPE_PRICE_BUSINESS_S_MONTHLY' },
  M: { mwCap: 8, envPrice: 'STRIPE_PRICE_BUSINESS_M_MONTHLY' },
  L: { mwCap: 20, envPrice: 'STRIPE_PRICE_BUSINESS_L_MONTHLY' },
  XL: { mwCap: 60, envPrice: 'STRIPE_PRICE_BUSINESS_XL_MONTHLY' },
} as const;

export type BusinessBand = keyof typeof BUSINESS_BANDS;

/** Residential prices (env var names holding the Stripe price ids). */
export const RESIDENTIAL_PRICES = {
  month: 'STRIPE_PRICE_RESIDENTIAL_MONTHLY',
  year: 'STRIPE_PRICE_RESIDENTIAL_YEARLY',
} as const;

export type ResidentialInterval = keyof typeof RESIDENTIAL_PRICES;

/**
 * The feature ↔ tier matrix. This is THE source of truth for yes/no feature
 * availability — server routes enforce it via requireFeature()
 * (src/lib/billing/gate.ts), the UI reads it through /api/billing/plan.
 * docs/billing.ts and the pricing page mirror it — update together.
 */
export const FEATURE_MATRIX: Record<Feature, Plan[]> = {
  'analytics:per_inverter_soiling': ['business', 'enterprise'],
  'analytics:cleaning_optimizer': ['business', 'enterprise'],
  'analytics:fault_detection': ['business', 'enterprise'],
  'analytics:bess': ['business', 'enterprise'],
  'analytics:hydrogen': ['business', 'enterprise'],
  'ai:insights': ['business', 'enterprise'],
  'ai:copilot': ['business', 'enterprise'],
  'reports:builder': ['business', 'enterprise'],
  'tickets:export': ['business', 'enterprise'],
  'integrations:webhooks': ['business', 'enterprise'],
  'mcp:api_keys': ['business', 'enterprise'],
  'mcp:oauth': ['enterprise'],
};

/**
 * Per-tier AI cost caps (USD), applied to OrgLLMBudget on subscription events.
 * Fair-use ceilings, not price levers: at real Qwen rates ($0.15/$1.20 per 1M
 * tokens) a heavy agent turn (~5K in / 1K out) costs ~$0.002, so business
 * $5/day ≈ 2,500 turns. Note the 2026-07 cost-recording fix (rows were priced
 * as Haiku, ~6x high) deliberately loosens effective enforcement by the same
 * factor — tighten these caps, never the fixed plan prices, if abuse appears.
 */
export const PLAN_LLM_BUDGETS: Record<Plan, { dailyUsd: number; monthlyUsd: number }> = {
  free: { dailyUsd: 1, monthlyUsd: 10 },
  residential: { dailyUsd: 1, monthlyUsd: 10 },
  business: { dailyUsd: 5, monthlyUsd: 100 },
  enterprise: { dailyUsd: 20, monthlyUsd: 400 },
};

/** Map raw plan ids (Subscription.plan_id / Organization.plan_type) to a Plan. */
export function normalizePlanId(raw: string | null | undefined): Plan | null {
  switch (raw) {
    case 'residential':
      return 'residential';
    case 'business':
    case 'growth': // legacy id — presentation-level rename only
      return 'business';
    case 'enterprise':
      return 'enterprise';
    default:
      // Note: 'free' (the org-creation default plan_type) intentionally maps
      // to null — it must not hand-grant anything.
      return null;
  }
}

export interface OrgBilling {
  plan: Plan;
  /** Entitled Stripe subscription row, when one exists. */
  subscription: Subscription | null;
  /** Effective limits: plan defaults overridden by the purchased band's mw_cap. */
  limits: PlanLimits;
}

/**
 * Resolve an organization's plan + effective limits. orgId is the Better Auth
 * organization id (stored as clerk_org_id on the legacy Organization row).
 *
 * Priority: entitled Stripe subscription → legacy Organization.plan_type
 * (hand-granting) → 'free' (no plan: locked out of onboarding).
 */
export async function getOrgBilling(orgId: string | null | undefined): Promise<OrgBilling> {
  if (!orgId) {
    return { plan: 'free', subscription: null, limits: PLAN_LIMITS.free };
  }

  // Dev demo fallback identity: keep every local demo surface fully unlocked
  // (same convention as llm-budget.ts).
  if (orgId.startsWith('demo_')) {
    return { plan: 'enterprise', subscription: null, limits: { ...PLAN_LIMITS.enterprise } };
  }

  const sub = await prisma.subscription.findFirst({
    where: {
      org_id: orgId,
      sub_status: { in: ENTITLED_STATUSES as unknown as any },
    },
    orderBy: { updatedAt: 'desc' },
  });

  let plan = normalizePlanId(sub?.plan_id ?? null);

  if (!plan || plan === 'residential') {
    const org = await prisma.organization.findUnique({
      where: { clerk_org_id: orgId },
    });
    plan = normalizePlanId(org?.plan_type) ?? plan;
  }

  plan ??= 'free';

  const limits: PlanLimits = { ...PLAN_LIMITS[plan] };
  const mwCap = sub?.mw_cap ? Number(sub.mw_cap) : null;
  if (plan === 'business' && mwCap && mwCap > 0) {
    limits.mw = mwCap;
  }

  return { plan, subscription: sub ?? null, limits };
}

export async function getOrgPlan(orgId: string | null | undefined): Promise<Plan> {
  const { plan } = await getOrgBilling(orgId);
  return plan;
}

export interface OrgCapacityUsage {
  /** Sum of rated capacity (MW) across the org's plants. */
  mw: number;
  /** Sum of declared storage energy capacity (MWh). 0 for a fleet with no storage. */
  mwh: number;
  /** Sum of each plant's equivalentMw. This is what the plan cap is measured against. */
  equivalentMw: number;
}

/**
 * Current capacity under management. Takes the INTERNAL Organization.id (the
 * uuid Plant.organization_id references), not the Better Auth org id.
 *
 * equivalentMw is summed per plant, not derived from the fleet totals: a 1 MW /
 * 8 MWh battery next to a 10 MW PV site is 12 equivalent MW, and collapsing to
 * fleet totals first would hide it.
 */
export async function getOrgCapacityUsage(internalOrgId: string): Promise<OrgCapacityUsage> {
  const plants = await prisma.plant.findMany({
    where: { organization_id: internalOrgId },
    select: { capacity_mw: true, energy_capacity_mwh: true },
  });

  let mw = 0;
  let mwh = 0;
  let equivalent = 0;
  for (const plant of plants) {
    const ratedMw = plant.capacity_mw ? Number(plant.capacity_mw) : 0;
    const energyMwh = plant.energy_capacity_mwh ? Number(plant.energy_capacity_mwh) : 0;
    mw += ratedMw;
    mwh += energyMwh;
    equivalent += equivalentMw(ratedMw, energyMwh);
  }

  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { mw: round(mw), mwh: round(mwh), equivalentMw: round(equivalent) };
}

/**
 * @deprecated Use getOrgCapacityUsage — it also reports the MWh behind the
 * number. Kept as an alias because the cap is still expressed in MW.
 */
export async function getOrgMwUsage(internalOrgId: string): Promise<number> {
  const { equivalentMw: used } = await getOrgCapacityUsage(internalOrgId);
  return used;
}

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return FEATURE_MATRIX[feature].includes(plan);
}

export function plantLimit(plan: Plan): number {
  return PLAN_LIMITS[plan].plants;
}

export function seatLimit(plan: Plan): number {
  return PLAN_LIMITS[plan].seats;
}
