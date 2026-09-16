import prisma from '@/libs/prisma';
import { normalizePlanId } from '@/lib/billing/plan';
import ImpersonateButton from '../_components/ImpersonateButton';

export const dynamic = 'force-dynamic';

export default async function AdminOrgsPage() {
  const [authOrgs, legacyOrgs, subs, plantAgg] = await Promise.all([
    prisma.authOrganization.findMany({
      include: {
        members: {
          include: { user: { select: { id: true, email: true, name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.organization.findMany(),
    prisma.subscription.findMany({
      where: { sub_status: { in: ['active', 'trialing', 'past_due'] as any } },
    }),
    prisma.plant.groupBy({
      by: ['organization_id'],
      _count: { _all: true },
      _sum: { capacity_mw: true },
    }),
  ]);

  const legacyByAuthId = new Map(legacyOrgs.map((o) => [o.clerk_org_id, o]));
  const subByOrg = new Map(subs.map((s) => [s.org_id, s]));
  const plantsByInternalId = new Map(plantAgg.map((p) => [p.organization_id, p]));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Organizations</h1>
        <p className="mt-1 text-sm text-gray-600">
          Every org on the platform. Impersonate the owner to see their exact view.
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2">Organization</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Plants</th>
              <th className="px-4 py-2">MW</th>
              <th className="px-4 py-2">Members</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {authOrgs.map((org) => {
              const legacy = legacyByAuthId.get(org.id);
              const sub = subByOrg.get(org.id);
              const plants = legacy ? plantsByInternalId.get(legacy.id) : undefined;
              const plan =
                normalizePlanId(sub?.plan_id) ??
                normalizePlanId(legacy?.plan_type) ??
                'free';
              const owner =
                org.members.find((m) => m.role === 'owner') ?? org.members[0];
              return (
                <tr key={org.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{org.name}</div>
                    <div className="text-xs text-gray-500">{org.slug}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        plan === 'enterprise'
                          ? 'bg-violet-50 text-violet-700'
                          : plan === 'business'
                            ? 'bg-blue-50 text-blue-700'
                            : plan === 'residential'
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {plan}
                      {sub?.sub_status === ('trialing' as any) ? ' · trial' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{plants?._count._all ?? 0}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {plants?._sum.capacity_mw ? Number(plants._sum.capacity_mw).toFixed(1) : '0'}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {org.members.length}
                    {owner?.user?.email && (
                      <span className="block text-xs text-gray-400">{owner.user.email}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {org.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {owner && owner.user?.role !== 'admin' && (
                      <ImpersonateButton userId={owner.userId} label="Impersonate owner" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
