import Link from 'next/link';
import prisma from '@/libs/prisma';

/**
 * Founder-only usage analytics (gated by the /admin layout's double check:
 * User.role='admin' AND the email allowlist — org users never reach this).
 *
 * Per-org rollups over the last 30 days: activity events (the audit trail
 * written by recordActivity), sign-ins (Better Auth sessions), chat/LLM
 * usage and cost (LLMInteraction), plus a filterable recent-actions feed.
 */

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams?: { org?: string };
}) {
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const since7 = new Date(Date.now() - 7 * DAY_MS);
  const orgFilter = searchParams?.org || null;

  const [orgs, events30, events7, lastEvents, sessions30, llm30, feed] = await Promise.all([
    prisma.authOrganization.findMany({
      include: { members: { select: { userId: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.activityEvent.groupBy({
      by: ['org_clerk_id'],
      where: { created_at: { gte: since30 } },
      _count: { _all: true },
    }),
    prisma.activityEvent.groupBy({
      by: ['org_clerk_id'],
      where: { created_at: { gte: since7 } },
      _count: { _all: true },
    }),
    prisma.activityEvent.groupBy({
      by: ['org_clerk_id'],
      _max: { created_at: true },
    }),
    prisma.session.groupBy({
      by: ['activeOrganizationId'],
      where: { createdAt: { gte: since30 } },
      _count: { _all: true },
    }),
    prisma.lLMInteraction.groupBy({
      by: ['org_clerk_id'],
      where: { created_at: { gte: since30 } },
      _count: { _all: true },
      _sum: { cost_usd: true },
    }),
    prisma.activityEvent.findMany({
      where: orgFilter ? { org_clerk_id: orgFilter } : undefined,
      orderBy: { created_at: 'desc' },
      take: 100,
    }),
  ]);

  const e30 = new Map(events30.map((r) => [r.org_clerk_id, r._count._all]));
  const e7 = new Map(events7.map((r) => [r.org_clerk_id, r._count._all]));
  const lastByOrg = new Map(lastEvents.map((r) => [r.org_clerk_id, r._max.created_at]));
  const signins = new Map(
    sessions30.filter((r) => r.activeOrganizationId).map((r) => [r.activeOrganizationId!, r._count._all]),
  );
  const llmByOrg = new Map(
    llm30.filter((r) => r.org_clerk_id).map((r) => [
      r.org_clerk_id!,
      { count: r._count._all, cost: Number(r._sum.cost_usd ?? 0) },
    ]),
  );
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  // Per-org action breakdown for the filtered org (top actions, 30d).
  const actionBreakdown = orgFilter
    ? await prisma.activityEvent.groupBy({
        by: ['action'],
        where: { org_clerk_id: orgFilter, created_at: { gte: since30 } },
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 12,
      })
    : null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Usage</h1>
        <p className="mt-1 text-sm text-gray-600">
          Per-organization activity over the last 30 days. Actions come from the product audit
          trail, sign-ins from sessions, AI usage from the LLM interaction log. Visible only here.
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2">Organization</th>
              <th className="px-4 py-2 text-right">Members</th>
              <th className="px-4 py-2 text-right">Sign-ins 30d</th>
              <th className="px-4 py-2 text-right">Actions 7d</th>
              <th className="px-4 py-2 text-right">Actions 30d</th>
              <th className="px-4 py-2 text-right">AI calls 30d</th>
              <th className="px-4 py-2 text-right">AI cost 30d</th>
              <th className="px-4 py-2">Last action</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {orgs.map((org) => {
              const llm = llmByOrg.get(org.id);
              const last = lastByOrg.get(org.id);
              return (
                <tr key={org.id} className={orgFilter === org.id ? 'bg-blue-50/50' : undefined}>
                  <td className="px-4 py-2 font-medium text-gray-900">{org.name}</td>
                  <td className="px-4 py-2 text-right">{org.members.length}</td>
                  <td className="px-4 py-2 text-right">{signins.get(org.id) ?? 0}</td>
                  <td className="px-4 py-2 text-right">{e7.get(org.id) ?? 0}</td>
                  <td className="px-4 py-2 text-right">{e30.get(org.id) ?? 0}</td>
                  <td className="px-4 py-2 text-right">{llm?.count ?? 0}</td>
                  <td className="px-4 py-2 text-right">
                    {llm ? `$${llm.cost.toFixed(2)}` : '$0.00'}
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {last ? new Date(last).toISOString().slice(0, 16).replace('T', ' ') : 'never'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/admin/usage?org=${org.id}`}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      Filter
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {actionBreakdown && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">
            Action breakdown, 30d: {orgName.get(orgFilter!) ?? orgFilter}
            <Link href="/admin/usage" className="ml-3 text-xs font-medium text-blue-600 hover:underline">
              Clear filter
            </Link>
          </h2>
          <div className="flex flex-wrap gap-2">
            {actionBreakdown.map((a) => (
              <span
                key={a.action}
                className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700"
              >
                {a.action} · <span className="font-semibold">{a._count._all}</span>
              </span>
            ))}
            {actionBreakdown.length === 0 && (
              <span className="text-sm text-gray-500">No recorded actions in the last 30 days.</span>
            )}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
          Recent actions {orgFilter ? `· ${orgName.get(orgFilter) ?? orgFilter}` : '· all organizations'}
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {feed.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-gray-500">
                  {e.created_at.toISOString().slice(0, 16).replace('T', ' ')}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {orgName.get(e.org_clerk_id) ?? e.org_clerk_id.slice(0, 8)}
                </td>
                <td className="px-4 py-2 font-medium text-gray-900">{e.action}</td>
                <td className="px-4 py-2 text-gray-600">{e.user_label ?? '-'}</td>
                <td className="px-4 py-2 text-xs text-gray-500">
                  {e.plant_id ? `plant ${e.plant_id.slice(0, 8)}` : e.target_type ?? ''}
                </td>
                <td className="max-w-[280px] truncate px-4 py-2 text-xs text-gray-400">
                  {e.metadata ? JSON.stringify(e.metadata) : ''}
                </td>
              </tr>
            ))}
            {feed.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-gray-500" colSpan={6}>
                  No activity recorded yet. Events appear as accounts use the product.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
