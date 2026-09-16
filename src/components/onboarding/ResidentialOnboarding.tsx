'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Cloud,
  FlaskConical,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronLeft,
  Sun,
} from 'lucide-react';
import BackLink from '@/components/ui/BackLink';

/**
 * Residential zero-touch onboarding — three steps, no manual plant data:
 *   1. pick your inverter brand
 *   2. enter its cloud credentials → we connect, test and discover
 *   3. confirm what we found → the plant is created from the vendor's own
 *      data (name, coordinates, kWp, inverters) and analytics start.
 *
 * Cloud vendors ride POST /api/connections → /test → /discover → /promote.
 * The sample path creates a small default plant + synthetic feed instead
 * (discovery doesn't apply to sample_api).
 */

type VendorId = 'huawei_api' | 'solaredge_api' | 'sample_api';

const VENDORS: Array<{
  id: VendorId;
  name: string;
  description: string;
  badge?: string;
}> = [
  {
    id: 'solaredge_api',
    name: 'SolarEdge',
    description: 'Monitoring API key from your SolarEdge portal',
  },
  {
    id: 'huawei_api',
    name: 'Huawei FusionSolar',
    description: 'Northbound API account (ask your installer)',
  },
  {
    id: 'sample_api',
    name: 'Try with sample data',
    description: 'Explore with a realistic synthetic rooftop — no credentials',
    badge: 'Sandbox',
  },
];

const HUAWEI_ENDPOINTS = [
  { label: 'Europe (Germany)', value: 'https://eu5.fusionsolar.huawei.com' },
  { label: 'Europe (Netherlands)', value: 'https://region01eu5.fusionsolar.huawei.com' },
  { label: 'Asia-Pacific', value: 'https://sg5.fusionsolar.huawei.com' },
  { label: 'Middle East & Africa', value: 'https://me5.fusionsolar.huawei.com' },
  { label: 'Latin America', value: 'https://la5.fusionsolar.huawei.com' },
];

interface DiscoveredPlant {
  id: string;
  name: string;
  location?: { lat?: number; lng?: number; address?: string };
  capacity_mw?: number;
  inverter_count?: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'error'; message: string; upgrade?: boolean };

export default function ResidentialOnboarding() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [vendor, setVendor] = useState<VendorId | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Credentials (per vendor)
  const [apiKey, setApiKey] = useState('');
  const [siteId, setSiteId] = useState('');
  const [huaweiUser, setHuaweiUser] = useState('');
  const [huaweiPass, setHuaweiPass] = useState('');
  const [huaweiEndpoint, setHuaweiEndpoint] = useState(HUAWEI_ENDPOINTS[0].value);

  // Discovery result
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [plants, setPlants] = useState<DiscoveredPlant[]>([]);
  const [selectedPlant, setSelectedPlant] = useState<string | null>(null);
  const [plantName, setPlantName] = useState('');
  // 422 discovery_incomplete → the vendor omitted these; user fills them in.
  const [missing, setMissing] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const fail = (message: string, upgrade = false) =>
    setPhase({ kind: 'error', message, upgrade });

  async function jsonOrNull(res: Response) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Step 2 → connect + test + discover in one go. */
  async function connect() {
    if (!vendor) return;
    setPhase({ kind: 'busy', label: 'Creating connection…' });

    const config =
      vendor === 'solaredge_api'
        ? { api_key: apiKey, site_id: siteId || undefined }
        : vendor === 'huawei_api'
          ? {
              huawei_username: huaweiUser,
              huawei_password: huaweiPass,
              huawei_endpoint: huaweiEndpoint,
              // Canonical keys the backend/connector read (mirrors the full
              // wizard's normalizeConfigForApi).
              username: huaweiUser,
              password: huaweiPass,
              baseUrl: huaweiEndpoint,
            }
          : { sample: true };

    const createRes = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${VENDORS.find((v) => v.id === vendor)!.name} — home`,
        type: vendor,
        config,
      }),
    });
    const created = await jsonOrNull(createRes);
    if (!createRes.ok) {
      return fail(
        created?.detail ?? created?.error ?? `Failed to create the connection (HTTP ${createRes.status})`,
        createRes.status === 402,
      );
    }
    const connId: string = created.data.id;
    setConnectionId(connId);

    setPhase({ kind: 'busy', label: 'Checking your credentials…' });
    const testRes = await fetch(`/api/connections/${connId}/test`, { method: 'POST' });
    const test = await jsonOrNull(testRes);
    if (!(test?.data?.success ?? false)) {
      return fail(test?.data?.message ?? test?.error ?? 'Connection test failed — check the credentials.');
    }

    setPhase({ kind: 'busy', label: 'Finding your system…' });
    const discRes = await fetch(`/api/connections/${connId}/discover`, { method: 'POST' });
    const disc = await jsonOrNull(discRes);
    const found: DiscoveredPlant[] = disc?.data?.plants ?? [];
    if (disc?.data?.status !== 'completed' || found.length === 0) {
      return fail(disc?.data?.error ?? 'We could not find a system on this account.');
    }

    setPlants(found);
    setSelectedPlant(found[0].id);
    setPlantName(found[0].name ?? '');
    setPhase({ kind: 'idle' });
    setStep(3);
  }

  /** Sample path: no discovery — create a small default plant + synthetic feed. */
  async function createSamplePlant() {
    setPhase({ kind: 'busy', label: 'Creating your sample rooftop…' });
    const createRes = await fetch('/api/plants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: plantName.trim() || 'My rooftop (sample)',
        latitude: 40.42,
        longitude: -3.7,
        capacity_mw: 0.05,
        timezone: 'Europe/Madrid',
        country: 'ES',
      }),
    });
    const created = await jsonOrNull(createRes);
    if (!createRes.ok) {
      return fail(created?.detail ?? created?.error ?? 'Failed to create the plant', createRes.status === 402);
    }
    const slug: string = created.data.slug;

    setPhase({ kind: 'busy', label: 'Generating the sample feed…' });
    await fetch(`/api/plants/${slug}/sample-feed`, { method: 'POST' }).catch(() => {});
    router.push(`/dashboard/plant/${slug}/status`);
  }

  /** Step 3 → promote the discovered plant into a real one. */
  async function createPlant() {
    if (vendor === 'sample_api') return createSamplePlant();
    if (!connectionId || !selectedPlant) return;

    setPhase({ kind: 'busy', label: 'Creating your plant…' });
    const numericOverrides: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (value.trim() !== '') numericOverrides[key] = key === 'timezone' ? value : Number(value);
    }
    const res = await fetch(`/api/connections/${connectionId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_plant_id: selectedPlant,
        overrides: { name: plantName.trim() || undefined, ...numericOverrides },
      }),
    });
    const json = await jsonOrNull(res);

    if (res.status === 422 && Array.isArray(json?.missing)) {
      setMissing(json.missing);
      return setPhase({
        kind: 'error',
        message: 'The vendor did not report everything we need — fill in the missing values below.',
      });
    }
    if (!res.ok) {
      return fail(json?.detail ?? json?.error ?? `Failed to create the plant (HTTP ${res.status})`, res.status === 402);
    }
    router.push(`/dashboard/plant/${json.data.slug}/status`);
  }

  const busy = phase.kind === 'busy';
  const selected = plants.find((p) => p.id === selectedPlant);

  return (
    <div className="mx-auto max-w-xl space-y-6 p-6">
      <BackLink />
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
          <Sun className="h-6 w-6 text-amber-500" />
          Connect your solar system
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Three steps, about two minutes — we read everything else from your inverter&apos;s cloud.
        </p>
      </header>

      {/* Step dots */}
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
        {['Brand', 'Connect', 'Confirm'].map((label, i) => (
          <span
            key={label}
            className={`rounded-full px-3 py-1 ${
              step === i + 1 ? 'bg-blue-600 text-white' : step > i + 1 ? 'bg-green-100 text-green-700' : 'bg-gray-100'
            }`}
          >
            {i + 1}. {label}
          </span>
        ))}
      </div>

      {phase.kind === 'error' && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {phase.message}{' '}
            {phase.upgrade && (
              <a href="/pricing" className="font-medium underline">
                See plans
              </a>
            )}
          </span>
        </div>
      )}

      {/* Step 1 — brand */}
      {step === 1 && (
        <div className="space-y-3">
          {VENDORS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                setVendor(v.id);
                setPhase({ kind: 'idle' });
                setStep(2);
              }}
              className="flex w-full items-center gap-3 rounded-xl border-2 border-gray-200 bg-white p-4 text-left transition hover:border-blue-400 hover:bg-blue-50"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50">
                {v.id === 'sample_api' ? (
                  <FlaskConical className="h-5 w-5 text-teal-600" />
                ) : (
                  <Cloud className="h-5 w-5 text-blue-600" />
                )}
              </span>
              <span className="flex-1">
                <span className="flex items-center gap-2 font-medium text-gray-900">
                  {v.name}
                  {v.badge && (
                    <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-teal-700">
                      {v.badge}
                    </span>
                  )}
                </span>
                <span className="block text-xs text-gray-500">{v.description}</span>
              </span>
            </button>
          ))}
          <div className="flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 p-4 opacity-60">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">
              <Cloud className="h-5 w-5 text-gray-400" />
            </span>
            <span className="flex-1">
              <span className="font-medium text-gray-500">
                Enphase, Growatt, GoodWe, SolaX + 20 more brands
              </span>
              <span className="block text-xs text-gray-400">Available on request</span>
            </span>
          </div>
        </div>
      )}

      {/* Step 2 — credentials */}
      {step === 2 && vendor && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          {vendor === 'solaredge_api' && (
            <>
              <p className="text-sm text-gray-600">
                Generate an API key in your SolarEdge monitoring portal under{' '}
                <span className="font-medium">Admin → Site Access → API Access</span>.
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-700">API key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Site ID <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </>
          )}

          {vendor === 'huawei_api' && (
            <>
              <p className="text-sm text-gray-600">
                Northbound API credentials — your installer can create them in FusionSolar under{' '}
                <span className="font-medium">System → Northbound Management</span>.
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-700">Region</label>
                <select
                  value={huaweiEndpoint}
                  onChange={(e) => setHuaweiEndpoint(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  {HUAWEI_ENDPOINTS.map((ep) => (
                    <option key={ep.value} value={ep.value}>
                      {ep.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Username</label>
                <input
                  type="text"
                  value={huaweiUser}
                  onChange={(e) => setHuaweiUser(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">Password</label>
                <input
                  type="password"
                  value={huaweiPass}
                  onChange={(e) => setHuaweiPass(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </>
          )}

          {vendor === 'sample_api' && (
            <>
              <p className="text-sm text-gray-600">
                No credentials needed — we&apos;ll create a realistic 50 kWp sample rooftop so you
                can explore everything. Replace it with your real system anytime.
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-700">Name your system</label>
                <input
                  type="text"
                  value={plantName}
                  onChange={(e) => setPlantName(e.target.value)}
                  placeholder="My rooftop"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>
            </>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setPhase({ kind: 'idle' });
              }}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
            <button
              type="button"
              disabled={
                busy ||
                (vendor === 'solaredge_api' && !apiKey.trim()) ||
                (vendor === 'huawei_api' && (!huaweiUser.trim() || !huaweiPass.trim()))
              }
              onClick={() => (vendor === 'sample_api' ? createSamplePlant() : connect())}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {phase.kind === 'busy' ? phase.label : 'Working…'}
                </>
              ) : vendor === 'sample_api' ? (
                'Create sample rooftop'
              ) : (
                'Connect'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — confirm */}
      {step === 3 && selected && (
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-start gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              We found <strong>{selected.name}</strong>
              {selected.capacity_mw != null && <> — {Math.round(selected.capacity_mw * 1000)} kWp</>}
              {selected.inverter_count ? <>, {selected.inverter_count} inverter{selected.inverter_count === 1 ? '' : 's'}</> : null}
              {selected.location?.address ? <>, {selected.location.address}</> : null}.
            </span>
          </div>

          {plants.length > 1 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-gray-700">Multiple systems on this account — pick yours:</p>
              {plants.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="radio"
                    checked={selectedPlant === p.id}
                    onChange={() => {
                      setSelectedPlant(p.id);
                      setPlantName(p.name ?? '');
                    }}
                  />
                  {p.name}
                  {p.capacity_mw != null && (
                    <span className="text-xs text-gray-500">({Math.round(p.capacity_mw * 1000)} kWp)</span>
                  )}
                </label>
              ))}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700">Plant name</label>
            <input
              type="text"
              value={plantName}
              onChange={(e) => setPlantName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          {missing.length > 0 && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-medium text-amber-800">
                Your vendor didn&apos;t report these — fill them in:
              </p>
              {missing.map((field) => (
                <div key={field}>
                  <label className="block text-xs font-medium text-gray-700">
                    {field === 'capacity_mw' ? 'Capacity (MW, e.g. 0.008 for 8 kWp)' : field}
                  </label>
                  <input
                    type="text"
                    value={overrides[field] ?? ''}
                    onChange={(e) => setOverrides((o) => ({ ...o, [field]: e.target.value }))}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => {
                setStep(2);
                setPhase({ kind: 'idle' });
              }}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={createPlant}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {phase.kind === 'busy' ? phase.label : 'Working…'}
                </>
              ) : (
                'Create my plant'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
