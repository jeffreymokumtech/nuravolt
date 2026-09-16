'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import NuraVoltLogo from '@/components/NuraVoltLogo';
import StatusLed from './StatusLed';
import ThemeToggle from './ThemeToggle';
import OpsPlantSwitcher from './OpsPlantSwitcher';
import OpsUserMenu from './OpsUserMenu';
import OpsAgentSwitcher from './OpsAgentSwitcher';
import HelpButton from './HelpButton';
import NotificationBell from './NotificationBell';
import { usePlantRoutePrefix, homeHrefFor } from '@/utils/routePrefix';

/**
 * Top status bar. Three logical groups:
 *   left, brand pulse + breadcrumb (PORTFOLIO / <plant> / <page>)
 *   chip, asset-type tag (PV + BESS, PV, BESS, WIND)
 *   right, theme toggle, CONN/LAT/POLL/DQ, clock, user avatar
 *
 * The clock self-updates every second (UTC tick). Connection meta is passed
 * in by the parent so each page can show the same chrome with different
 * source telemetry.
 */

export type AssetChip = 'PV' | 'BESS' | 'PV+BESS' | 'WIND' | 'HYBRID' | string;

export interface CommandBarMeta {
  /** Section being viewed, colours the rightmost breadcrumb crumb. */
  section: string;
  sectionTone?: 'info' | 'bess' | 'warn' | 'ok' | 'alarm';
  /**
   * Optional intermediate crumbs between the plant and the section (e.g. the
   * parent GROUP on an inverter page). Crumbs with href render as links.
   */
  sectionCrumbs?: Array<{ label: string; href?: string }>;
  /**
   * Plant label between PORTFOLIO and section. Omit for org-scope screens
   * (fleet home, org settings): the breadcrumb collapses to HOME / SECTION
   * and the plant telemetry group is hidden.
   */
  plantLabel?: string;
  /** Optional href for the plant crumb. Set by OpsShell; otherwise non-clickable. */
  plantHref?: string;
  /** Asset-type chip. Use null to hide. */
  assetChip?: AssetChip | null;
  /** Connection state, driven by data source health. */
  conn?: 'ok' | 'degraded' | 'down';
  /** Round-trip latency in ms (numeric). */
  latencyMs?: number;
  /** Polling interval in seconds. */
  pollSeconds?: number;
  /** Data quality 0-100. */
  dataQualityPct?: number;
  /** Optional extra meta items appended after DQ (e.g. manufacturer line). */
  extras?: ReactNode;
  /** User initials. */
  userInitials?: string;
  /**
   * Plant id for the Dashboard↔Shams switcher so mode switches keep the
   * current plant context. The switcher renders on authenticated surfaces
   * only (it self-gates on the route prefix).
   */
  plantId?: string | null;
  /** Which app mode this bar chromes. Default 'dashboard'. */
  mode?: 'dashboard' | 'agent';
  /**
   * Screen-help catalog key (usually the active nav key, set by OpsShell).
   * Renders the Help button; falls back to `section` when omitted.
   */
  helpKey?: string;
}

const SECTION_TONE: Record<NonNullable<CommandBarMeta['sectionTone']>, string> = {
  info: 'var(--ops-info)',
  bess: 'var(--ops-bess)',
  warn: 'var(--ops-warn)',
  ok: 'var(--ops-ok)',
  alarm: 'var(--ops-alarm)',
};

const CONN_LABEL = { ok: 'CONN OK', degraded: 'CONN DEGRADED', down: 'CONN DOWN' } as const;
const CONN_TONE = { ok: 'ok', degraded: 'warn', down: 'alarm' } as const;

function useUtcTick(): string {
  // Render an empty placeholder during SSR so the server and client agree
  // (the clock value differs by definition between render time and hydrate).
  const [now, setNow] = useState<string>('');
  useEffect(() => {
    setNow(formatNow(new Date()));
    const id = setInterval(() => setNow(formatNow(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Pages historically author crumbs in ALL CAPS ('OVERVIEW', plant names via
 * .toUpperCase()). Normalize fully-uppercase strings to title case for display
 * here rather than editing every call site; mixed-case strings pass through.
 */
const CRUMB_ACRONYMS = /\b(Pv|Bess|Scada|Ytd|Mtd|Kpi|Api|Sr|Rul|Ac|Dc)\b/g;

function friendlyCrumb(s: string): string {
  if (!s || /[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s/·(+-])(\S)/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(CRUMB_ACRONYMS, (m) => m.toUpperCase());
}

function formatNow(d: Date): string {
  // 14:32:08 CET, locale-independent HH:MM:SS using local TZ for demo.
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tz = d
    .toLocaleTimeString('en-US', { timeZoneName: 'short' })
    .split(' ')
    .pop();
  return `${hh}:${mm}:${ss} ${tz ?? ''}`;
}

export default function OpsCommandBar({ meta }: { meta: CommandBarMeta }) {
  const clock = useUtcTick();
  const conn = meta.conn ?? 'ok';
  const sectionColor = meta.sectionTone ? SECTION_TONE[meta.sectionTone] : 'var(--ops-info)';
  const prefix = usePlantRoutePrefix();
  const homeHref = homeHrefFor(prefix);
  const homeLabel = prefix === '/dashboard' ? 'Fleet' : 'Portfolio';
  // Org-scope screens (no plant crumb) skip the plant telemetry group.
  const isOrgScope = !meta.plantLabel;

  return (
    <div
      className="flex min-h-[46px] flex-wrap items-center justify-between gap-y-1 border-b px-4 py-1 pl-12 sm:pl-4 text-[11px]"
      style={{ background: 'var(--ops-panel-2)', borderColor: 'var(--ops-hair)' }}
    >
      {/* Left group: brand + breadcrumb + chip */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
        <Link
          href={homeHref}
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
          title="Back to fleet overview"
        >
          <span style={{ pointerEvents: 'none' }} className="block">
            <NuraVoltLogo width={120} height={30} showTagline={false} />
          </span>
          <span
            className="flex items-center gap-1 rounded border px-1.5 py-px text-[10px]"
            style={{
              color: 'var(--ops-ok)',
              background: 'var(--ops-ok-bg)',
              borderColor: 'var(--ops-ok-border)',
            }}
          >
            <StatusLed tone="ok" size={5} pulse />
            Ops
          </span>
        </Link>
        <span className="h-[18px] w-px" style={{ background: 'var(--ops-hair)' }} />
        <div className="text-[12px]">
          <Link
            href={homeHref}
            className="transition-colors hover:underline"
            style={{ color: 'var(--ops-label)' }}
          >
            {homeLabel}
          </Link>
          {meta.plantLabel && (
            <>
              <span className="mx-1" style={{ color: 'var(--ops-dim)' }}>/</span>
              <OpsPlantSwitcher label={friendlyCrumb(meta.plantLabel)} plantHref={meta.plantHref} />
            </>
          )}
          {meta.sectionCrumbs?.map((crumb, i) => (
            <span key={`${crumb.label}-${i}`}>
              <span className="mx-1" style={{ color: 'var(--ops-dim)' }}>/</span>
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="transition-colors hover:underline"
                  style={{ color: 'var(--ops-label)' }}
                >
                  {friendlyCrumb(crumb.label)}
                </Link>
              ) : (
                <span style={{ color: 'var(--ops-label)' }}>{friendlyCrumb(crumb.label)}</span>
              )}
            </span>
          ))}
          <span className="mx-1" style={{ color: 'var(--ops-dim)' }}>/</span>
          <span style={{ color: sectionColor }}>{friendlyCrumb(meta.section)}</span>
        </div>
        {meta.assetChip != null && meta.assetChip !== '' && (
          <span
            className="rounded-sm border px-1.5 py-px text-[10px]"
            style={{
              color: 'var(--ops-info)',
              background: 'var(--ops-info-bg)',
              borderColor: 'var(--ops-info-border)',
            }}
          >
            {meta.assetChip}
          </span>
        )}
      </div>

      {/* Right group — telemetry readouts stay mono/tabular (they are data) */}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1" style={{ color: 'var(--ops-muted)' }}>
        <OpsAgentSwitcher active={meta.mode ?? 'dashboard'} plantId={meta.plantId} />
        <NotificationBell />
        <HelpButton helpKey={meta.helpKey ?? meta.section} />
        <ThemeToggle />
        {!isOrgScope && (
          <span className="font-mono">
            <StatusLed tone={CONN_TONE[conn]} size={6} className="mr-1.5" />
            {CONN_LABEL[conn]}
          </span>
        )}
        {!isOrgScope && meta.latencyMs !== undefined && (
          <span className="font-mono">
            LAT <span style={{ color: 'var(--ops-txt)' }}>{meta.latencyMs}</span>ms
          </span>
        )}
        {!isOrgScope && meta.pollSeconds !== undefined && (
          <span className="font-mono">
            POLL <span style={{ color: 'var(--ops-txt)' }}>{meta.pollSeconds.toFixed(1)}</span>s
          </span>
        )}
        {!isOrgScope && meta.dataQualityPct !== undefined && (
          <span className="font-mono">
            DQ{' '}
            <span style={{ color: meta.dataQualityPct >= 95 ? 'var(--ops-ok)' : 'var(--ops-warn)' }}>
              {meta.dataQualityPct.toFixed(1)}
            </span>
            %
          </span>
        )}
        {meta.extras}
        <span className="font-mono" style={{ color: 'var(--ops-txt)' }}>{clock}</span>
        <OpsUserMenu initials={meta.userInitials} />
      </div>
    </div>
  );
}
