'use client';

/**
 * Authenticated fleet home: the org's real plants (org-scoped /api/plants via
 * DemoPlantContext), capacity usage against the plan band, open work, and
 * quick actions. Each plant card opens the live plant overview.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient } from '@/lib/auth-client';
import OpsOrgShell from '@/components/ops/OpsOrgShell';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import DocLink from '@/components/content/DocLink';
import {
  Atom, Database, Key, MessageSquare, Loader2, Sun, Zap,
  BatteryCharging, Wind, MapPin, ArrowRight, TicketCheck,
} from 'lucide-react';

const ASSET_ICON: Record<string, any> = {
  PV: Sun,
  BESS: BatteryCharging,
  'PV+BESS': Zap,
  WIND: Wind,
  H2: Atom,
  OTHER: Sun,
};

const STATUS_STYLE: Record<string, string> = {
  OPERATIONAL: 'bg-green-100 text-green-800',
  TRAINING: 'bg-blue-100 text-blue-800',
  ONBOARDING: 'bg-amber-100 text-amber-800',
  CONFIGURING: 'bg-amber-100 text-amber-800',
  SUSPENDED: 'bg-gray-200 text-gray-600',
};

interface Usage {
  plan: string;
  limits: { mw: number | null; plants: number | null };
  usage: { mw: number; plants: number };
}

interface AlertPlantGroup {
  slug: string;
  name: string;
  critical: number;
  warning: number;
  alerts: { id: string; kind: string; severity: string; message: string }[];
}

/** Group order + labels for the fleet grid. */
const GROUP_ORDER: { chips: string[]; label: string; icon: any }[] = [
  { chips: ['PV', 'PV+BESS'], label: 'Solar', icon: Sun },
  { chips: ['WIND'], label: 'Wind', icon: Wind },
  { chips: ['BESS'], label: 'Storage', icon: BatteryCharging },
  { chips: ['H2'], label: 'Hydrogen', icon: Atom },
  { chips: ['OTHER'], label: 'Other', icon: Sun },
];

export default function DashboardFleetHome() {
  const { isPending } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const { plants, loading: plantsLoading } = useDemoPlants();

  const [usage, setUsage] = useState<Usage | null>(null);
  const [openTickets, setOpenTickets] = useState<number | null>(null);
  const [alertGroups, setAlertGroups] = useState<AlertPlantGroup[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/billing/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then(setUsage)
      .catch(() => {});
    fetch('/api/tickets/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        // open_count = NEW+VALIDATED+ASSIGNED+IN_PROGRESS (excludes DONE and
        // WONT_FIX). Recomputing from by_status would over-count WONT_FIX.
        if (typeof s?.open_count === 'number') setOpenTickets(s.open_count);
      })
      .catch(() => {});
    fetch('/api/alerts?status=active')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAlertGroups(d?.plants ?? []))
      .catch(() => {});
  }, []);

  const alertsBySlug = new Map(alertGroups.map((g) => [g.slug, g]));
  const visiblePlants = filter
    ? plants.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : plants;

  if (isPending) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const mwPct =
    usage?.limits.mw && usage.limits.mw > 0
      ? Math.min(100, Math.round((usage.usage.mw / usage.limits.mw) * 100))
      : null;

  return (
    <OpsOrgShell activeNavKey="fleet" section="OVERVIEW">
      <main className="max-w-6xl mx-auto px-4 py-5 space-y-8">
        {!organization && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3">
            <p className="text-sm text-blue-900">
              You&apos;re not part of an organization yet — create one to start onboarding plants.
            </p>
            <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700 text-white shrink-0">
              <Link href="/create-organization">Create organization</Link>
            </Button>
          </div>
        )}
        {/* No-plan lock: plants/connections can't be onboarded until a plan is picked. */}
        {usage?.plan === 'free' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-900">
              <span className="font-semibold">Your organization doesn&apos;t have a plan yet.</span>{' '}
              Start a 14-day Residential trial (€9/mo after) or pick a Business band to
              onboard plants.
            </p>
            <Button asChild size="sm" className="bg-amber-600 hover:bg-amber-700 text-white shrink-0">
              <Link href="/pricing">Choose a plan</Link>
            </Button>
          </div>
        )}

        {/* Needs attention: plants with open alerts, worst first */}
        {alertGroups.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900">
              <TicketCheck className="h-4 w-4 text-red-600" />
              Needs attention
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {alertGroups.slice(0, 6).map((g) => (
                <Link
                  key={g.slug}
                  href={`/dashboard/plant/${g.slug}`}
                  className={`rounded-lg border p-3 transition-shadow hover:shadow ${
                    g.critical > 0 ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-900">{g.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        g.critical > 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {g.critical > 0 ? `${g.critical} critical` : `${g.warning} warning`}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-600">
                    {g.alerts[0]?.message ?? ''}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* KPI strip */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="bg-white">
            <CardHeader className="pb-2">
              <CardDescription>Capacity under management</CardDescription>
              <CardTitle className="text-2xl">
                {usage ? `${usage.usage.mw} MW` : '–'}
                {usage?.limits.mw != null && (
                  <span className="text-sm font-normal text-gray-500"> / {usage.limits.mw} MW</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {mwPct != null && (
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${mwPct >= 90 ? 'bg-red-500' : mwPct >= 70 ? 'bg-amber-500' : 'bg-blue-600'}`}
                    style={{ width: `${mwPct}%` }}
                  />
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="bg-white">
            <CardHeader className="pb-2">
              <CardDescription>Plants</CardDescription>
              <CardTitle className="text-2xl">
                {plants.length}
                {usage?.limits.plants != null && (
                  <span className="text-sm font-normal text-gray-500"> / {usage.limits.plants}</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent />
          </Card>
          <Card className="bg-white">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5">
                <TicketCheck className="h-3.5 w-3.5" /> Open tickets
              </CardDescription>
              <CardTitle className="text-2xl">{openTickets ?? '–'}</CardTitle>
            </CardHeader>
            <CardContent />
          </Card>
        </div>

        {/* Fleet grid */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Your plants</h2>
            <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
              <Link
                href={
                  usage?.plan === 'free'
                    ? '/pricing'
                    : usage?.plan === 'residential'
                      ? '/dashboard/onboarding/residential'
                      : '/dashboard/onboarding'
                }
              >
                {usage?.plan === 'free'
                  ? 'Choose a plan'
                  : usage?.plan === 'residential'
                    ? 'Connect your system'
                    : 'Onboard a plant'}
              </Link>
            </Button>
          </div>

          {plantsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
            </div>
          ) : plants.length === 0 ? (
            <Card className="bg-white">
              <CardContent className="py-12 text-center">
                <Sun className="h-10 w-10 text-amber-400 mx-auto mb-3" />
                <p className="font-medium text-gray-900">No plants yet</p>
                <p className="text-sm text-gray-600 mt-1 mb-4">
                  {usage?.plan === 'free'
                    ? 'Pick a plan first — then connect your inverter cloud or SCADA and your first plant is live in minutes.'
                    : usage?.plan === 'residential'
                      ? 'Connect your inverter brand and your system appears fully configured in about two minutes.'
                      : 'Connect your inverter cloud or SCADA and your first plant is live in minutes.'}
                </p>
                <Button asChild className="bg-blue-600 hover:bg-blue-700 text-white">
                  <Link
                    href={
                      usage?.plan === 'free'
                        ? '/pricing'
                        : usage?.plan === 'residential'
                          ? '/dashboard/onboarding/residential'
                          : '/dashboard/onboarding'
                    }
                  >
                    {usage?.plan === 'free'
                      ? 'Choose a plan'
                      : usage?.plan === 'residential'
                        ? 'Connect your system'
                        : 'Start onboarding'}
                  </Link>
                </Button>
                <div className="mt-3">
                  <DocLink category="getting-started" slug="onboard-your-first-plant">
                    How onboarding works
                  </DocLink>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              {plants.length > 8 && (
                <div className="mb-4">
                  <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter plants…"
                    className="w-full max-w-xs rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              )}
              {GROUP_ORDER.map(({ chips, label, icon: GroupIcon }) => {
                const group = visiblePlants.filter((p) =>
                  chips.includes(assetTypeChip(p.asset_type))
                );
                if (group.length === 0) return null;
                const totalMw = group.reduce(
                  (acc, p) => acc + (p.capacity_mw != null ? Number(p.capacity_mw) : 0),
                  0
                );
                return (
                  <div key={label} className="mb-6">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <GroupIcon className="h-4 w-4 text-blue-600" />
                      {label}
                      <span className="font-normal normal-case">
                        {group.length} plant{group.length === 1 ? '' : 's'} · {totalMw.toFixed(1)} MW
                      </span>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {group.map((plant) => {
                        const chip = assetTypeChip(plant.asset_type);
                        const Icon = ASSET_ICON[chip] ?? Sun;
                        const statusStyle =
                          STATUS_STYLE[String(plant.status)] ?? 'bg-gray-100 text-gray-700';
                        const plantAlerts = alertsBySlug.get(plant.slug);
                        return (
                          <Link key={plant.id} href={`/dashboard/plant/${plant.slug}`} className="group">
                            <Card className="bg-white h-full transition-shadow group-hover:shadow-md">
                              <CardHeader className="pb-2">
                                <div className="flex items-start justify-between">
                                  <Icon className="h-5 w-5 text-blue-600" />
                                  <span className="flex items-center gap-1.5">
                                    {plantAlerts && (plantAlerts.critical > 0 || plantAlerts.warning > 0) && (
                                      <span
                                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                          plantAlerts.critical > 0
                                            ? 'bg-red-100 text-red-700'
                                            : 'bg-amber-100 text-amber-700'
                                        }`}
                                        title={`${plantAlerts.critical} critical, ${plantAlerts.warning} warning alerts`}
                                      >
                                        {plantAlerts.critical + plantAlerts.warning} alert
                                        {plantAlerts.critical + plantAlerts.warning === 1 ? '' : 's'}
                                      </span>
                                    )}
                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusStyle}`}>
                                      {String(plant.status).toLowerCase()}
                                    </span>
                                  </span>
                                </div>
                                <CardTitle className="text-base mt-1">{plant.name}</CardTitle>
                                <CardDescription className="flex items-center gap-1">
                                  <MapPin className="h-3 w-3" />
                                  {plant.location_name ?? plant.country ?? '–'}
                                </CardDescription>
                              </CardHeader>
                              <CardContent className="flex items-center justify-between text-sm text-gray-600">
                                <span>
                                  {plant.capacity_mw != null ? `${Number(plant.capacity_mw)} MW` : '–'} · {chip}
                                </span>
                                <ArrowRight className="h-4 w-4 opacity-40 group-hover:translate-x-0.5 group-hover:opacity-80 transition-all" />
                              </CardContent>
                            </Card>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </section>

        {/* Quick actions */}
        <section className="grid gap-4 md:grid-cols-3">
          {[
            { title: 'Fleet connections', desc: 'Connections and polling health.', href: '/dashboard/settings/connections', icon: Database },
            { title: 'MCP API keys', desc: 'Keys for AI assistants.', href: '/dashboard/settings/api-keys', icon: Key },
            { title: 'Ask Shams', desc: 'Your AI agent, on your fleet data.', href: '/chat', icon: MessageSquare },
          ].map(({ title, desc, href, icon: Icon }) => (
            <Link key={href} href={href} className="group">
              <Card className="bg-white h-full transition-shadow group-hover:shadow-md">
                <CardHeader>
                  <Icon className="h-5 w-5 text-blue-600 mb-1" />
                  <CardTitle className="text-sm">{title}</CardTitle>
                  <CardDescription>{desc}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </section>
      </main>
    </OpsOrgShell>
  );
}
