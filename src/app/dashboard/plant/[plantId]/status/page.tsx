'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckCircle2, Circle, Loader2, AlertTriangle, RefreshCw, FlaskConical } from 'lucide-react';
import DocLink from '@/components/content/DocLink';

interface StatusStep {
  key: string;
  label: string;
  state: 'done' | 'active' | 'pending' | 'failed';
  hint: string;
}

interface OnboardingStatus {
  plant: { id: string; slug: string; name: string; status: string };
  steps: StatusStep[];
  latest_job: { status: string; error: string | null } | null;
}

function StepIcon({ state }: { state: StatusStep['state'] }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    case 'active':
      return <Loader2 className="h-5 w-5 text-blue-600 animate-spin" />;
    case 'failed':
      return <AlertTriangle className="h-5 w-5 text-red-600" />;
    default:
      return <Circle className="h-5 w-5 text-gray-300" />;
  }
}

export default function PlantOnboardingStatusPage() {
  const params = useParams<{ plantId: string }>();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sampleMsg, setSampleMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/plants/${params.plantId}/onboarding-status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    }
  }, [params.plantId]);

  const generateSample = useCallback(async () => {
    setGenerating(true);
    setSampleMsg(null);
    try {
      const res = await fetch(`/api/plants/${params.plantId}/sample-feed`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSampleMsg(
        `Sample feed generated (${data.device_count} inverters, ${data.rows_written} readings). Your dashboard will fill in shortly.`,
      );
      await load();
    } catch (e) {
      setSampleMsg(e instanceof Error ? e.message : 'Failed to generate sample data');
    } finally {
      setGenerating(false);
    }
  }, [params.plantId, load]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              {status?.plant.name ?? 'Plant onboarding'}
            </h1>
            <p className="text-sm text-gray-500">
              Getting your plant from connected to fully modeled.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-3">{error}</p>
        )}

        {!status && !error && (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          </div>
        )}

        {status && (
          <section className="bg-white rounded-xl border shadow-sm divide-y">
            {status.steps.map((step) => (
              <div key={step.key} className="flex items-start gap-3 p-4">
                <StepIcon state={step.state} />
                <div>
                  <p
                    className={`text-sm font-medium ${
                      step.state === 'pending' ? 'text-gray-400' : 'text-gray-900'
                    }`}
                  >
                    {step.label}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{step.hint}</p>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* No telemetry yet? Offer a one-click synthetic feed so the plant is
            never a dead end while a real source is still being wired up. */}
        {status && status.steps.find((s) => s.key === 'first_data')?.state !== 'done' && (
          <section className="bg-teal-50 border border-teal-200 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <FlaskConical className="h-5 w-5 text-teal-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h2 className="text-sm font-semibold text-teal-800">No data flowing yet?</h2>
                <p className="text-sm text-teal-700 mt-0.5">
                  Generate a realistic sample inverter feed to explore the full dashboard now — clearly
                  labelled as sample data, and replaceable by a real source anytime.
                </p>
                {sampleMsg && <p className="text-xs text-teal-800 mt-2">{sampleMsg}</p>}
                <button
                  type="button"
                  onClick={generateSample}
                  disabled={generating}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {generating ? (
                    <><Loader2 className="h-4 w-4 animate-spin" />Generating…</>
                  ) : (
                    <><FlaskConical className="h-4 w-4" />Generate sample data</>
                  )}
                </button>
              </div>
            </div>
          </section>
        )}

        <div className="flex items-center justify-between">
          <DocLink category="getting-started" slug="onboard-your-first-plant">
            What happens during onboarding
          </DocLink>
          <Link href="/dashboard" className="text-sm text-blue-600 hover:text-blue-800">
            Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
