import prisma from '@/libs/prisma';
import { Users, Building2, Factory, CreditCard } from 'lucide-react';

export const dynamic = 'force-dynamic';

/** Rough MRR estimate per plan_id (EUR). Bands vary — labelled approximate. */
const PLAN_MRR: Record<string, number> = {
  residential: 9,
  business: 99, // S-band floor; bands M/L bill higher
  growth: 99,
  enterprise: 0, // custom-billed
};

export default async function AdminOverviewPage() {
  const [userCount, orgCount, plantCount, mwAgg, subs] = await Promise.all([
    prisma.user.count(),
    prisma.authOrganization.count(),
    prisma.plant.count(),
    prisma.plant.aggregate({ _sum: { capacity_mw: true } }),
    prisma.subscription.findMany({
      where: { sub_status: { in: ['active', 'trialing', 'past_due'] as any } },
      select: { plan_id: true, sub_status: true },
    }),
  ]);

  const totalMw = mwAgg._sum.capacity_mw ? Number(mwAgg._sum.capacity_mw) : 0;
  const byPlan = new Map<string, number>();
  for (const sub of subs) byPlan.set(sub.plan_id, (byPlan.get(sub.plan_id) ?? 0) + 1);
  const mrr = subs.reduce((acc, s) => acc + (PLAN_MRR[s.plan_id] ?? 0), 0);
  const trialing = subs.filter((s) => s.sub_status === ('trialing' as any)).length;

  const cards = [
    { icon: Users, label: 'Users', value: String(userCount) },
    { icon: Building2, label: 'Organizations', value: String(orgCount) },
    { icon: Factory, label: 'Plants', value: `${plantCount} · ${Math.round(totalMw * 10) / 10} MW` },
    {
      icon: CreditCard,
      label: 'Entitled subscriptions',
      value: `${subs.length}${trialing ? ` (${trialing} trialing)` : ''}`,
    },
  ];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Platform overview</h1>
        <p className="mt-1 text-sm text-gray-600">Cross-organization state, read-only.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Icon className="h-4 w-4" />
              {label}
            </div>
            <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Subscriptions by plan</h2>
        {subs.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No entitled subscriptions yet.</p>
        ) : (
          <div className="mt-3 space-y-1.5 text-sm">
            {Array.from(byPlan.entries()).map(([plan, count]) => (
              <div key={plan} className="flex justify-between">
                <span className="text-gray-600">{plan}</span>
                <span className="font-medium text-gray-900">{count}</span>
              </div>
            ))}
            <div className="mt-2 flex justify-between border-t border-gray-100 pt-2">
              <span className="text-gray-600">MRR (approximate, band floors)</span>
              <span className="font-semibold text-gray-900">€{mrr}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
