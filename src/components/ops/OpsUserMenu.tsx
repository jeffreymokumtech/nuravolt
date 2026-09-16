'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Building2,
  CreditCard,
  Database,
  Key,
  LayoutDashboard,
  LineChart,
  LogOut,
  Settings,
  Users,
} from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * The user chip on the far right of the command bar. On /demo and /showcase
 * it stays the static initials badge it always was. On /dashboard it becomes
 * a menu: org destinations (fleet, team, billing, API keys, connections, org
 * settings), an org switcher for multi-org users, and sign out — so every
 * org-level surface is reachable from ANY screen without losing your place.
 */

const ORG_LINKS = [
  { href: '/dashboard', label: 'Fleet home', icon: LayoutDashboard },
  { href: '/dashboard/reports', label: 'Reports & dashboards', icon: LineChart },
  { href: '/dashboard/settings', label: 'Org settings', icon: Settings },
  { href: '/dashboard/settings/team', label: 'Team', icon: Users },
  { href: '/dashboard/settings/billing', label: 'Billing & plan', icon: CreditCard },
  { href: '/dashboard/settings/api-keys', label: 'MCP API keys', icon: Key },
  { href: '/dashboard/settings/connections', label: 'Fleet connections', icon: Database },
];

function chipStyle() {
  return {
    background: 'var(--ops-info-bg)',
    borderColor: 'var(--ops-info-border)',
    color: 'var(--ops-info)',
  } as const;
}

function initialsFrom(nameOrEmail: string | null | undefined, fallback: string): string {
  if (!nameOrEmail) return fallback;
  const parts = nameOrEmail.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

function DashboardUserMenu({ fallbackInitials }: { fallbackInitials: string }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const { data: organizations } = authClient.useListOrganizations();
  const { data: activeOrg } = authClient.useActiveOrganization();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const initials = initialsFrom(
    session?.user?.name ?? session?.user?.email,
    fallbackInitials
  );
  const multiOrg = (organizations?.length ?? 0) > 1;

  return (
    <span className="relative inline-flex" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-[26px] w-[26px] items-center justify-center rounded border text-[10px] transition-opacity hover:opacity-80"
        style={chipStyle()}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Account & organization"
      >
        {initials}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-md border py-1 text-xs shadow-lg"
          style={{ background: 'var(--ops-panel)', borderColor: 'var(--ops-hair)' }}
        >
          <div className="px-3 py-2" style={{ color: 'var(--ops-muted)' }}>
            <div className="truncate" style={{ color: 'var(--ops-txt)' }}>
              {session?.user?.email ?? '—'}
            </div>
            <div className="mt-0.5 flex items-center gap-1 truncate">
              <Building2 size={10} aria-hidden />
              {activeOrg?.name ?? 'No organization'}
            </div>
          </div>

          {multiOrg && (
            <div className="border-t px-3 py-2" style={{ borderColor: 'var(--ops-hair)' }}>
              <div className="mb-1 text-[9.5px]" style={{ color: 'var(--ops-muted)' }}>
                Switch organization
              </div>
              {(organizations ?? []).map((org) => (
                <button
                  key={org.id}
                  type="button"
                  onClick={async () => {
                    await authClient.organization.setActive({ organizationId: org.id });
                    window.location.reload();
                  }}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:brightness-110"
                  style={{
                    color: org.id === activeOrg?.id ? 'var(--ops-bright)' : 'var(--ops-txt)',
                    background: org.id === activeOrg?.id ? 'var(--ops-nav-active-bg)' : 'transparent',
                  }}
                >
                  <span className="flex-1 truncate">{org.name}</span>
                  {org.id === activeOrg?.id && <span style={{ color: 'var(--ops-ok)' }}>●</span>}
                </button>
              ))}
            </div>
          )}

          <div className="border-t py-1" style={{ borderColor: 'var(--ops-hair)' }}>
            {ORG_LINKS.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-1.5 transition-colors hover:brightness-110"
                style={{ color: 'var(--ops-txt)' }}
              >
                <Icon size={12} style={{ color: 'var(--ops-muted)' }} aria-hidden />
                {label}
              </Link>
            ))}
          </div>

          <div className="border-t py-1" style={{ borderColor: 'var(--ops-hair)' }}>
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                await authClient.signOut();
                router.push('/');
                router.refresh();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:brightness-110"
              style={{ color: 'var(--ops-warn)' }}
            >
              <LogOut size={12} aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

export default function OpsUserMenu({ initials }: { initials?: string }) {
  const prefix = usePlantRoutePrefix();
  const fallback = initials ?? 'AM';

  // Demo/showcase keep the inert badge (no session fetch, no menu).
  if (prefix !== '/dashboard') {
    return (
      <span
        className="inline-flex h-[26px] w-[26px] items-center justify-center rounded border text-[10px]"
        style={chipStyle()}
      >
        {fallback}
      </span>
    );
  }

  return <DashboardUserMenu fallbackInitials={fallback} />;
}
