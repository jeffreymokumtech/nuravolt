'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ConnectionWizard from '@/components/data-hub/ConnectionWizard';
import { usePlanFeatures } from '@/lib/billing/use-plan';
import type { OnboardedPlant } from '@/types/onboarding';

/**
 * Authenticated plant onboarding: the full wizard (plant, equipment, data
 * sources, discovery, mappings) ending in a real Plant via POST /api/plants.
 * Honest errors (no demo fallback). On success, land on the plant's
 * onboarding-status tracker.
 *
 * ?connectionId=<id> pre-selects an existing DataConnection as a reused data
 * source (deep link from ConnectionsManager's "Onboard plant" action).
 */
function OnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const connectionId = searchParams.get('connectionId') ?? undefined;
  const { plan } = usePlanFeatures();

  // Residential orgs get the 3-step self-serve flow instead of the full
  // wizard (deep links with ?connectionId= only target business orgs).
  useEffect(() => {
    if (plan === 'residential' && !connectionId) {
      router.replace('/dashboard/onboarding/residential');
    }
  }, [plan, connectionId, router]);

  return (
    <ConnectionWizard
      mode="full-onboarding"
      initialConnectionId={connectionId}
      onClose={() => router.push('/dashboard')}
      onComplete={(plant?: OnboardedPlant) => {
        if (plant?.plantId) {
          router.push(`/dashboard/plant/${plant.plantId}/status`);
        } else {
          router.push('/dashboard');
        }
      }}
    />
  );
}

export default function DashboardOnboardingPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* useSearchParams requires a Suspense boundary in the app router */}
        <Suspense fallback={null}>
          <OnboardingWizard />
        </Suspense>
      </div>
    </div>
  );
}
