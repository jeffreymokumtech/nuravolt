import ResidentialOnboarding from '@/components/onboarding/ResidentialOnboarding';

/**
 * Residential self-serve onboarding: connect your inverter cloud, confirm
 * what we found, done — no manual plant data. Business orgs use the full
 * wizard at /dashboard/onboarding instead.
 */
export default function ResidentialOnboardingPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <ResidentialOnboarding />
    </div>
  );
}
