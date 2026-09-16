'use client';

/**
 * Real, persisted plant settings for /dashboard (the demo/showcase keep their
 * read-only mock). Four tabs:
 *   general       — asset identity (read-only facts + link to onboarding)
 *   alerts        — soiling / PR thresholds        → PUT /api/plants/[id]/settings
 *   notifications — email digests and criticals    → PUT /api/plants/[id]/settings
 *   access        — per-plant member grants        → /api/team/members/[userId]/plant-access
 *
 * The org-wide half of the old muddle (roles, seats, invites) lives at
 * /dashboard/settings/team; this panel cross-links there and vice versa.
 */

import { useCallback, useEffect, useState } from 'react';
import OpsTabs from '@/components/ops/OpsTabs';
import OpsPanel from '@/components/ops/OpsPanel';
import { useDemoPlants, assetTypeChip } from '@/contexts/DemoPlantContext';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

interface PlantSettings {
  alerts: { soilingLossPct: number; performanceRatioPct: number };
  notifications: { emailCritical: boolean; dailySummary: boolean; weeklyCleaning: boolean };
  dataSources: { irradianceSource: string; soilingReference: string };
}

interface SourceCandidate {
  id: string;
  label: string;
  available: boolean;
  disabledReason: string | null;
  health: 'ok' | 'stale' | 'missing';
  lastSampleAgeMinutes: number | null;
  confidence: number;
  description: string;
}

interface SourceCandidatesResponse {
  irradiance: SourceCandidate[];
  soilingReference: SourceCandidate[];
  recommendation: { irradiance: string | null; reason: string };
  selected: { irradianceSource: string; soilingReference: string };
  scope: string;
}

interface MemberRow {
  memberId: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  plantAccess: { plant_id: string; plant_slug: string | null; access_level: string }[];
}

const ACCESS_LEVELS = ['NONE', 'VIEW', 'OPERATE', 'MANAGE'] as const;
// Legacy roles that already grant org-wide MANAGE on every plant.
const ORG_WIDE_ROLES = new Set(['SUPER_ADMIN', 'ORG_ADMIN', 'MANAGER']);

export default function PlantSettingsPanel({ plantId }: { plantId: string }) {
  const { plants } = useDemoPlants();
  const plant = plants.find((p) => p.slug === plantId || p.id === plantId);

  const [tab, setTab] = useState('general');
  const [settings, setSettings] = useState<PlantSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/plants/${plantId}/settings`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setSettings(d.settings))
      .catch((e) => setLoadError(e.message));
  }, [plantId]);

  const save = useCallback(
    async (next: PlantSettings) => {
      setSettings(next);
      setSaving(true);
      setSaved(false);
      try {
        const res = await fetch(`/api/plants/${plantId}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        if (res.ok) {
          const d = await res.json();
          setSettings(d.settings);
          setSaved(true);
          setTimeout(() => setSaved(false), 2500);
        }
      } finally {
        setSaving(false);
      }
    },
    [plantId]
  );

  return (
    <div className="space-y-3">
      <OpsTabs
        tabs={[
          { key: 'general', label: 'General' },
          { key: 'data-sources', label: 'Data sources' },
          { key: 'alerts', label: 'Alerts' },
          { key: 'notifications', label: 'Notifications' },
          { key: 'access', label: 'Access' },
        ]}
        value={tab}
        onChange={setTab}
        syncToUrl
      />

      {(saving || saved) && (
        <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>
          {saving ? 'Saving…' : 'Saved.'}
        </p>
      )}

      {tab === 'general' && (
        <OpsPanel label="Plant settings · general" subtitle="Asset identity" bodyClassName="ops-legacy">
          {plant ? (
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-gray-500">Name</dt>
                <dd className="font-medium text-gray-900">{plant.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Asset type</dt>
                <dd className="font-medium text-gray-900">{assetTypeChip(plant.asset_type)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Capacity</dt>
                <dd className="font-medium text-gray-900">
                  {plant.capacity_mw != null ? `${Number(plant.capacity_mw)} MW` : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Location</dt>
                <dd className="font-medium text-gray-900">
                  {plant.location_name ?? plant.country ?? '—'}
                </dd>
              </div>
              <div className="sm:col-span-2 pt-2 text-xs text-gray-500">
                Structural changes (inverter layout, coordinates, capacity) go through
                re-onboarding so the digital twin stays calibrated — contact support or
                re-run discovery from{' '}
                <Link href="/dashboard/settings/connections" className="text-blue-600 hover:underline">
                  Fleet connections
                </Link>
                .
              </div>
            </dl>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          )}
        </OpsPanel>
      )}

      {tab === 'alerts' && (
        <OpsPanel
          label="Plant settings · alert thresholds"
          subtitle="Thresholds that raise alerts and drive cleaning recommendations"
          bodyClassName="ops-legacy"
        >
          {loadError ? (
            <p className="text-sm text-red-600">Failed to load settings: {loadError}</p>
          ) : !settings ? (
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-gray-700">Soiling loss alert (%)</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={settings.alerts.soilingLossPct}
                  onChange={(e) =>
                    save({
                      ...settings,
                      alerts: { ...settings.alerts, soilingLossPct: Number(e.target.value) },
                    })
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                />
                <span className="mt-1 block text-xs text-gray-500">
                  Alert when estimated soiling loss exceeds this share of production.
                </span>
              </label>
              <label className="block text-sm">
                <span className="text-gray-700">Performance ratio alert (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={settings.alerts.performanceRatioPct}
                  onChange={(e) =>
                    save({
                      ...settings,
                      alerts: { ...settings.alerts, performanceRatioPct: Number(e.target.value) },
                    })
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2"
                />
                <span className="mt-1 block text-xs text-gray-500">
                  Alert when the plant PR drops below this floor.
                </span>
              </label>
            </div>
          )}
        </OpsPanel>
      )}

      {tab === 'notifications' && (
        <OpsPanel label="Plant settings · notifications" subtitle="Who hears about it, and when" bodyClassName="ops-legacy">
          {!settings ? (
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          ) : (
            <div className="space-y-3 text-sm">
              {(
                [
                  ['emailCritical', 'Email alerts for critical issues'],
                  ['dailySummary', 'Daily performance summary'],
                  ['weeklyCleaning', 'Weekly cleaning recommendations'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={settings.notifications[key]}
                    onChange={(e) =>
                      save({
                        ...settings,
                        notifications: { ...settings.notifications, [key]: e.target.checked },
                      })
                    }
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-gray-700">{label}</span>
                </label>
              ))}
            </div>
          )}
        </OpsPanel>
      )}

      {tab === 'data-sources' && (
        <DataSourcesTab plantId={plantId} settings={settings} save={save} />
      )}

      {tab === 'access' && <PlantAccessTab plantId={plantId} />}
    </div>
  );
}

/**
 * Source picker: which irradiance source and soiling reference the soiling
 * analytics should use. Persists via the settings PUT; live availability and
 * health come from /api/plants/[id]/source-candidates. Unavailable options
 * render disabled with the reason — never hidden, never silently ignored.
 */
function DataSourcesTab({
  plantId,
  settings,
  save,
}: {
  plantId: string;
  settings: PlantSettings | null;
  save: (next: PlantSettings) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<SourceCandidatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/plants/${plantId}/source-candidates`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCandidates)
      .catch((e) => setError(e.message));
  }, [plantId]);

  if (error) {
    return (
      <OpsPanel label="Plant settings · data sources" bodyClassName="ops-legacy">
        <p className="text-sm text-red-600">Failed to load source candidates: {error}</p>
      </OpsPanel>
    );
  }
  if (!candidates || !settings) {
    return (
      <OpsPanel label="Plant settings · data sources" bodyClassName="ops-legacy">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </OpsPanel>
    );
  }

  const pick = (field: 'irradianceSource' | 'soilingReference', value: string) =>
    save({ ...settings, dataSources: { ...settings.dataSources, [field]: value } });

  return (
    <div className="space-y-3">
      <OpsPanel
        label="Data sources · irradiance"
        subtitle="Which irradiance signal the soiling analytics trust"
        bodyClassName="ops-legacy"
      >
        <SourceGroup
          field="irradianceSource"
          selected={settings.dataSources.irradianceSource}
          candidates={candidates.irradiance}
          autoHint={candidates.recommendation.reason}
          onPick={(v) => pick('irradianceSource', v)}
        />
      </OpsPanel>

      <OpsPanel
        label="Data sources · soiling reference"
        subtitle="What anchors the per-inverter soiling estimates"
        bodyClassName="ops-legacy"
      >
        <SourceGroup
          field="soilingReference"
          selected={settings.dataSources.soilingReference}
          candidates={candidates.soilingReference}
          autoHint="Uses the sensor when one exists, otherwise the inferred estimate."
          onPick={(v) => pick('soilingReference', v)}
        />
      </OpsPanel>

      <p className="px-1 text-xs" style={{ color: 'var(--ops-muted)' }}>
        {candidates.scope}
      </p>
    </div>
  );
}

const HEALTH_DOT: Record<SourceCandidate['health'], string> = {
  ok: '#2E7D52',
  stale: '#B07D2B',
  missing: '#9CA3AF',
};

function SourceGroup({
  field,
  selected,
  candidates,
  autoHint,
  onPick,
}: {
  field: string;
  selected: string;
  candidates: SourceCandidate[];
  autoHint: string;
  onPick: (value: string) => void;
}) {
  const options: Array<{
    id: string;
    label: string;
    description: string;
    available: boolean;
    disabledReason: string | null;
    health?: SourceCandidate['health'];
    ageMinutes?: number | null;
    confidence?: number;
  }> = [
    {
      id: 'auto',
      label: 'Auto (recommended)',
      description: autoHint,
      available: true,
      disabledReason: null,
    },
    ...candidates.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      available: c.available,
      disabledReason: c.disabledReason,
      health: c.health,
      ageMinutes: c.lastSampleAgeMinutes,
      confidence: c.confidence,
    })),
  ];

  return (
    <div className="grid gap-2 lg:grid-cols-3">
      {options.map((opt) => {
        const isActive = selected === opt.id;
        const disabled = !opt.available;
        return (
          <label
            key={opt.id}
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition ${
              isActive ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'
            } ${disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-blue-300'}`}
            title={opt.disabledReason ?? undefined}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={field}
                checked={isActive}
                disabled={disabled}
                onChange={() => onPick(opt.id)}
                className="h-4 w-4 border-gray-300 text-blue-600"
              />
              <span className="font-medium text-gray-900">{opt.label}</span>
              {opt.health && (
                <span
                  className="ml-auto inline-block h-2 w-2 rounded-full"
                  style={{ background: HEALTH_DOT[opt.health] }}
                  title={`Signal ${opt.health}`}
                />
              )}
            </span>
            <span className="text-xs text-gray-500">{opt.description}</span>
            <span className="text-xs text-gray-400">
              {disabled
                ? opt.disabledReason
                : [
                    opt.confidence != null ? `confidence ${Math.round(opt.confidence * 100)}%` : null,
                    opt.ageMinutes != null
                      ? `last sample ${opt.ageMinutes < 90 ? `${opt.ageMinutes} min` : `${Math.round(opt.ageMinutes / 60)} h`} ago`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Per-plant access matrix: every org member × their level on THIS plant.
 * Reuses the same grant/revoke endpoints as the (org-level) team page.
 */
function PlantAccessTab({ plantId }: { plantId: string }) {
  const { plants } = useDemoPlants();
  const plant = plants.find((p) => p.slug === plantId || p.id === plantId);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/team/members');
    if (!res.ok) return;
    const d = await res.json();
    setMembers(d.members ?? []);
    setCanManage(d.canManage ?? false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const levelFor = (m: MemberRow): string => {
    if (ORG_WIDE_ROLES.has(m.role)) return 'ORG-WIDE';
    const grant = m.plantAccess.find(
      (a) => a.plant_id === plant?.id || a.plant_slug === plantId
    );
    return grant?.access_level ?? 'NONE';
  };

  const setLevel = async (m: MemberRow, level: string) => {
    if (!plant) return;
    setBusy(m.userId);
    try {
      if (level === 'NONE') {
        await fetch(`/api/team/members/${m.userId}/plant-access?plant_id=${plant.id}`, {
          method: 'DELETE',
        });
      } else {
        await fetch(`/api/team/members/${m.userId}/plant-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plant_id: plant.id, access_level: level }),
        });
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <OpsPanel
      label="Plant settings · access"
      subtitle="Which teammates can see or operate this plant"
      meta={
        <Link href="/dashboard/settings/team" className="hover:underline" style={{ color: 'var(--ops-info)' }}>
          Manage org roles →
        </Link>
      }
      bodyClassName="ops-legacy"
    >
      {!members ? (
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="py-2 pr-4">Member</th>
              <th className="py-2 pr-4">Org role</th>
              <th className="py-2">Access to this plant</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const level = levelFor(m);
              const orgWide = level === 'ORG-WIDE';
              return (
                <tr key={m.userId} className={`border-b border-gray-100 ${busy === m.userId ? 'opacity-50' : ''}`}>
                  <td className="py-2.5 pr-4">
                    <span className="font-medium text-gray-900">{m.name ?? m.email}</span>
                    {m.name && <span className="ml-2 text-xs text-gray-500">{m.email}</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-gray-600">{m.role}</td>
                  <td className="py-2.5">
                    {orgWide ? (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                        Org-wide manage
                      </span>
                    ) : (
                      <select
                        value={level}
                        disabled={!canManage || busy === m.userId}
                        onChange={(e) => setLevel(m, e.target.value)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                      >
                        {ACCESS_LEVELS.map((l) => (
                          <option key={l} value={l}>
                            {l === 'NONE' ? 'No access' : l.charAt(0) + l.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </OpsPanel>
  );
}
