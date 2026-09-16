import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { auth } from '@/lib/auth';

/**
 * Platform admin area — founder-only, deliberately cross-org.
 *
 * Double gate: the session user must have User.role='admin' (Better Auth
 * admin plugin, set by hand in the DB) AND their email must be in the
 * PLATFORM_ADMIN_EMAILS env allow-list. The middleware's cookie check on the
 * /admin prefix is only the optimistic first line; this layout is the real
 * enforcement. All cross-org Prisma reads live in server components under
 * this layout only — the tenancy of normal API routes is untouched.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: headers() });

  const allowList = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const ok =
    session &&
    (session.user as any).role === 'admin' &&
    allowList.includes(session.user.email.toLowerCase());

  if (!ok) redirect('/dashboard');

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-gray-900 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-400" />
            <span className="font-semibold">NuraVolt Admin</span>
            <span className="ml-2 rounded-full bg-gray-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">
              platform
            </span>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/admin" className="text-gray-300 hover:text-white">
              Overview
            </Link>
            <Link href="/admin/orgs" className="text-gray-300 hover:text-white">
              Organizations
            </Link>
            <Link href="/admin/users" className="text-gray-300 hover:text-white">
              Users
            </Link>
            <Link href="/admin/usage" className="text-gray-300 hover:text-white">
              Usage
            </Link>
            <Link href="/dashboard" className="text-gray-400 hover:text-white">
              ← App
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
