import prisma from '@/libs/prisma';
import ImpersonateButton from '../_components/ImpersonateButton';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    include: {
      members: { include: { organization: { select: { name: true } } } },
      sessions: { orderBy: { updatedAt: 'desc' }, take: 1, select: { updatedAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        <p className="mt-1 text-sm text-gray-600">
          Everyone with an account. Impersonation lasts 1 hour and is banner-marked.
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2">User</th>
              <th className="px-4 py-2">Organizations</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2">Last seen</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">
                    {user.name}
                    {user.role === 'admin' && (
                      <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                        admin
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{user.email}</div>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  {user.members.length === 0
                    ? '—'
                    : user.members.map((m) => m.organization?.name).filter(Boolean).join(', ')}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {user.createdAt.toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {user.sessions[0]?.updatedAt
                    ? user.sessions[0].updatedAt.toISOString().slice(0, 10)
                    : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {user.role !== 'admin' && <ImpersonateButton userId={user.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
