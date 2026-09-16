'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  BatteryCharging,
  CreditCard,
  Database,
  Droplets,
  FileCheck,
  Key,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  Menu,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Users,
  Webhook,
  X,
} from 'lucide-react';
import { cn } from '@/helpers/utils';
import StatusLed, { type StatusTone } from './StatusLed';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * Left navigation rail. Responsive behaviour:
 *   ≥1024px → 178px full rail (labels visible)
 *   ≥640px  → 56px icon-only rail (labels collapsed)
 *   <640px  → hamburger button + slide-in drawer
 *
 * Active item gets the panel-active background + an info-tone left bar +
 * icon stroke shifts to info. Hover state: row-hair bg + bright text.
 */

export interface NavItem {
  key: string;
  label: string;
  href: string;
  /** Lucide icon for the left side. */
  icon?: LucideIcon;
  /** Status dot tone (right side). */
  status?: StatusTone | null;
  /** Optional hover tooltip, falls back to label in compact mode. */
  tooltip?: string;
  /**
   * Only render on the authenticated dashboard surface. Used for entries whose
   * hrefs point behind the auth wall (e.g. org Team) so demo/showcase rails
   * never link visitors into a sign-in redirect.
   */
  dashboardOnly?: boolean;
  /** Render a thin group divider above this item. */
  topDivider?: boolean;
}

export const DEFAULT_NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', href: '', icon: LayoutDashboard },
  { key: 'financials', label: 'Financials', href: 'financials', icon: LineChart },
  { key: 'faults', label: 'Faults', href: 'faults', icon: AlertTriangle },
  { key: 'soiling', label: 'Soiling', href: 'soiling', icon: Droplets },
  // "BESS" everywhere the user sees it: the route is /bess, the API is
  // /api/bess and the marketing is /bess, so "Battery" was the odd one out.
  { key: 'battery', label: 'BESS', href: 'bess', icon: BatteryCharging },
  {
    key: 'quality',
    label: 'Data quality',
    href: 'quality',
    icon: ShieldCheck,
    tooltip: 'SLA, freshness, sensor health, provenance, connections',
  },
  { key: 'tickets', label: 'Tickets', href: 'tickets', icon: TicketCheck },
  {
    key: 'contracts',
    label: 'Contracts',
    href: 'contracts',
    icon: ScrollText,
    tooltip: 'PPAs, warranties, O&M SLAs — terms and obligation status',
  },
  {
    // Folded into the Data quality hub for asset types that have it; kept
    // as a standalone rail entry only where the quality hub is absent
    // (WIND / H2 — see navForAssetChip).
    key: 'datahub',
    label: 'Connections',
    href: 'datahub',
    icon: Database,
    tooltip: 'SCADA / InfluxDB / Modbus / CSV connections',
  },
  { key: 'settings', label: 'Settings', href: 'settings', icon: Settings },
  {
    // Shams, the AI agent — first-class app surface next to the dashboard.
    // NavList appends ?plant= so the agent opens scoped to the current plant.
    key: 'agent',
    label: 'Shams',
    href: '/chat',
    icon: Sparkles,
    tooltip: 'Your AI agent, on this plant’s live data',
    dashboardOnly: true,
    topDivider: true,
  },
  {
    // Org-level team management, surfaced on the plant rail so operators can
    // reach members/invites/plant access without hunting through org settings.
    key: 'team',
    label: 'Team',
    href: '/dashboard/settings/team',
    icon: Users,
    tooltip: 'Members, invitations, roles, per-plant access',
    dashboardOnly: true,
  },
];

/**
 * Org-scope rail (dashboard only): fleet home + the organization-level
 * settings surfaces. Hrefs are absolute — the rail passes them through
 * untouched instead of prefixing `/plant/{id}`.
 */
export const ORG_NAV: NavItem[] = [
  { key: 'fleet', label: 'Fleet', href: '/dashboard', icon: LayoutDashboard },
  { key: 'agent', label: 'Shams', href: '/chat', icon: Sparkles, tooltip: 'Your AI agent, on your fleet data' },
  { key: 'reports', label: 'Reports', href: '/dashboard/reports', icon: LineChart },
  { key: 'org-settings', label: 'Settings', href: '/dashboard/settings', icon: Settings },
  { key: 'team', label: 'Team', href: '/dashboard/settings/team', icon: Users },
  { key: 'billing', label: 'Billing', href: '/dashboard/settings/billing', icon: CreditCard },
  { key: 'api-keys', label: 'API keys', href: '/dashboard/settings/api-keys', icon: Key },
  {
    key: 'connections',
    label: 'Connections',
    href: '/dashboard/settings/connections',
    icon: Database,
    tooltip: 'Fleet-wide data connections',
  },
  {
    key: 'integrations',
    label: 'Integrations',
    href: '/dashboard/settings/integrations',
    icon: Webhook,
    tooltip: 'Outbound webhooks to your O&M tools',
  },
];

/**
 * Asset-type-aware nav: PV plants don't show Battery; BESS plants don't show
 * Soiling/Faults but gain Revenue; hybrids see everything. `chip` is the
 * assetTypeChip() value from DemoPlantContext ('PV' | 'BESS' | 'PV+BESS' |
 * 'WIND' | 'OTHER').
 */
export function navForAssetChip(chip: string): NavItem[] {
  const drop = (keys: string[]) => DEFAULT_NAV.filter((i) => !keys.includes(i.key));
  const revenue: NavItem = { key: 'revenue', label: 'Revenue', href: 'revenue', icon: LineChart };
  const hybrid: NavItem = { key: 'hybrid', label: 'Hybrid', href: 'hybrid', icon: BatteryCharging };
  // The Audit product (optimizer performance, warranty evidence, grid-code
  // compliance packs) applies to battery assets only.
  const audit: NavItem = {
    key: 'audit',
    label: 'Audit',
    href: 'audit',
    icon: FileCheck,
    tooltip: 'Optimizer performance, warranty evidence, compliance packs',
  };

  const beforeSettings = (items: NavItem[], entry: NavItem) => {
    const at = items.findIndex((i) => i.key === 'settings');
    items.splice(at === -1 ? items.length : at, 0, entry);
    return items;
  };

  switch (chip) {
    case 'BESS': {
      // Connections live inside the Data quality hub — no standalone entry.
      const items = drop(['soiling', 'faults', 'datahub']);
      items.splice(1, 0, revenue);
      return beforeSettings(items, audit);
    }
    case 'PV+BESS': {
      const items = drop(['datahub']);
      items.splice(1, 0, revenue, hybrid);
      return beforeSettings(items, audit);
    }
    case 'WIND':
      // Quality is the PV sensor-health console; wind data quality lives in
      // the wind console's SCADA views. No quality hub → keep the standalone
      // Connections (datahub) entry.
      return drop(['soiling', 'battery', 'quality']);
    case 'H2':
      // Electrolyzer: production/economics/stack live in the overview
      // section; PV- and BESS-specific tabs don't apply. No quality hub →
      // keep the standalone Connections (datahub) entry.
      return drop(['soiling', 'battery', 'faults', 'quality', 'financials']);
    default:
      // PV / OTHER: no battery tab; connections live inside the quality hub.
      return drop(['battery', 'datahub']);
  }
}

interface OpsNavRailProps {
  /** Absent on org-scope rails (all items carry absolute hrefs). */
  plantId?: string;
  activeKey: string;
  items?: NavItem[];
  /** Overrides for status dots per nav key, driven by current health. */
  statusOverrides?: Partial<Record<string, StatusTone | null>>;
}

function NavList({
  items,
  activeKey,
  plantId,
  statusOverrides,
  compact,
  onItemClick,
}: {
  items: NavItem[];
  activeKey: string;
  plantId?: string;
  statusOverrides?: Partial<Record<string, StatusTone | null>>;
  compact?: boolean;
  onItemClick?: () => void;
}) {
  const prefix = usePlantRoutePrefix();
  // Financials is fixture-driven (portfolio_financial.json) — demo/showcase
  // only until a DB-backed financials source ships. dashboardOnly entries link
  // behind the auth wall and are hidden everywhere else.
  const visibleItems = items.filter((i) => {
    if (prefix === '/dashboard') return i.key !== 'financials';
    return !i.dashboardOnly;
  });
  return (
    <>
      {visibleItems.map((item) => {
        const isActive = item.key === activeKey;
        // Absolute hrefs (org rail) pass through; plant-relative hrefs get
        // the surface prefix + plant segment. The agent entry carries the
        // current plant so Shams opens scoped to it.
        const href =
          item.key === 'agent' && plantId
            ? `/chat?plant=${plantId}`
            : item.href.startsWith('/')
              ? item.href
              : item.href === ''
                ? `${prefix}/plant/${plantId}`
                : `${prefix}/plant/${plantId}/${item.href}`;
        const status = statusOverrides?.[item.key] ?? item.status ?? null;
        const Icon = item.icon;
        return (
          <Link
            key={item.key}
            href={href}
            onClick={onItemClick}
            title={
              compact
                ? item.tooltip
                  ? `${item.label}, ${item.tooltip}`
                  : item.label
                : item.tooltip
            }
            className={cn(
              'ops-nav-item mx-2 flex items-center rounded-lg text-[12.5px] transition-colors',
              compact ? 'justify-center px-2 py-2.5' : 'gap-2.5 px-2 py-2.5',
              isActive && 'font-medium',
              item.topDivider && 'ops-nav-divided'
            )}
            style={{
              background: isActive ? 'var(--ops-nav-active-bg)' : 'transparent',
              color: isActive ? 'var(--ops-bright)' : 'var(--ops-txt)',
              borderLeft: isActive ? '2px solid var(--ops-info)' : '2px solid transparent',
            }}
          >
            {Icon && (
              <Icon
                size={14}
                strokeWidth={1.6}
                style={{
                  color: isActive ? 'var(--ops-info)' : 'var(--ops-muted)',
                  transition: 'color 120ms ease',
                  flexShrink: 0,
                }}
                aria-hidden
              />
            )}
            {!compact && (
              <>
                <span className="flex-1">{item.label}</span>
                {status && <StatusLed tone={status} size={6} />}
              </>
            )}
          </Link>
        );
      })}
    </>
  );
}

export default function OpsNavRail({
  plantId,
  activeKey,
  items = DEFAULT_NAV,
  statusOverrides,
}: OpsNavRailProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <style jsx>{`
        :global(.ops-nav-item):hover {
          background-color: var(--ops-row-hair) !important;
          color: var(--ops-bright) !important;
        }
        :global(.ops-nav-item):hover :global(svg) {
          color: var(--ops-bright) !important;
        }
      `}</style>
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="sm:hidden fixed top-2 left-2 z-30 inline-flex h-9 w-9 items-center justify-center rounded-md border"
        style={{
          background: 'var(--ops-panel)',
          borderColor: 'var(--ops-hair)',
          color: 'var(--ops-txt)',
        }}
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" />
      </button>

      <nav
        className={cn(
          'hidden sm:flex flex-shrink-0 flex-col gap-[2px] border-r py-2.5',
          'w-[56px] lg:w-[178px]'
        )}
        style={{
          background: 'var(--ops-panel-2)',
          borderColor: 'var(--ops-hair)',
          minHeight: '100%',
        }}
      >
        <div className="hidden lg:contents">
          <NavList
            items={items}
            activeKey={activeKey}
            plantId={plantId}
            statusOverrides={statusOverrides}
          />
        </div>
        <div className="contents lg:hidden">
          <NavList
            items={items}
            activeKey={activeKey}
            plantId={plantId}
            statusOverrides={statusOverrides}
            compact
          />
        </div>
      </nav>

      {drawerOpen && (
        <>
          <div
            className="fixed inset-0 z-40 sm:hidden"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            onClick={() => setDrawerOpen(false)}
          />
          <nav
            className="fixed inset-y-0 left-0 z-50 flex w-[200px] flex-col gap-[2px] border-r py-2.5 sm:hidden"
            style={{
              background: 'var(--ops-panel-2)',
              borderColor: 'var(--ops-hair)',
            }}
          >
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="self-end mr-2 mb-1 inline-flex h-7 w-7 items-center justify-center rounded-md"
              style={{ color: 'var(--ops-muted)' }}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
            <NavList
              items={items}
              activeKey={activeKey}
              plantId={plantId}
              statusOverrides={statusOverrides}
              onItemClick={() => setDrawerOpen(false)}
            />
          </nav>
        </>
      )}
    </>
  );
}
