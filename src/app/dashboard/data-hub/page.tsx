import { redirect } from 'next/navigation';

/**
 * Legacy URL. Fleet connections live under org settings now
 * (/dashboard/settings/connections); the per-plant Data Hub is unchanged at
 * /dashboard/plant/[plantId]/datahub.
 */
export default function DataHubRedirect() {
  redirect('/dashboard/settings/connections');
}
