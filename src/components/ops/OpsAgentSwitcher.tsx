'use client';

import Link from 'next/link';
import { LayoutDashboard, Sparkles } from 'lucide-react';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * Dashboard ↔ Shams mode switcher in the command bar. The two first-class app
 * surfaces share one chrome; this control carries the current plant context
 * across the boundary (?plant= on the agent side, /plant/{id} on the
 * dashboard side).
 *
 * Renders only on authenticated surfaces (/dashboard and /chat both resolve
 * to the '/dashboard' prefix) — demo/showcase keep their rail-only agent.
 */
export default function OpsAgentSwitcher({
  active,
  plantId,
}: {
  active: 'dashboard' | 'agent';
  plantId?: string | null;
}) {
  const prefix = usePlantRoutePrefix();
  if (prefix !== '/dashboard') return null;

  const items = [
    {
      key: 'dashboard' as const,
      label: 'Dashboard',
      icon: LayoutDashboard,
      href: plantId ? `/dashboard/plant/${plantId}` : '/dashboard',
    },
    {
      key: 'agent' as const,
      label: 'Shams',
      icon: Sparkles,
      href: plantId ? `/chat?plant=${plantId}` : '/chat',
    },
  ];

  return (
    <span
      className="inline-flex items-center rounded-lg border p-[2px]"
      style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel)' }}
      role="group"
      aria-label="Switch between dashboard and agent"
    >
      {items.map((item) => {
        const isActive = item.key === active;
        const Icon = item.icon;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-[3px] text-[11px] transition-colors"
            style={{
              background: isActive ? 'var(--ops-nav-active-bg)' : 'transparent',
              color: isActive ? 'var(--ops-bright)' : 'var(--ops-muted)',
              fontWeight: isActive ? 550 : 450,
            }}
          >
            <Icon size={12} strokeWidth={1.8} aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </span>
  );
}
