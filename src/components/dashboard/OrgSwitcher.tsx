'use client';

import { Building2, ChevronDown } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

/**
 * Active-organization switcher for multi-org users. Renders as plain text
 * when the user belongs to at most one org. Switching calls
 * organization.setActive (persists on the session row) and reloads so every
 * provider refetches under the new org.
 */
export default function OrgSwitcher({ email }: { email?: string | null }) {
  const { data: organizations } = authClient.useListOrganizations();
  const { data: active } = authClient.useActiveOrganization();

  const switchable = (organizations?.length ?? 0) > 1;

  if (!switchable) {
    return (
      <p className="text-sm text-gray-500 flex items-center gap-1.5">
        <Building2 className="h-3.5 w-3.5" />
        {active?.name ?? 'No organization yet'}
        {email && <span className="text-gray-400">· {email}</span>}
      </p>
    );
  }

  return (
    <div className="text-sm text-gray-500 flex items-center gap-1.5">
      <Building2 className="h-3.5 w-3.5" />
      <span className="relative inline-flex items-center">
        <select
          value={active?.id ?? ''}
          onChange={async (e) => {
            await authClient.organization.setActive({ organizationId: e.target.value });
            window.location.reload();
          }}
          className="appearance-none rounded-md border border-gray-200 bg-white py-0.5 pl-2 pr-6 text-sm text-gray-700 hover:border-gray-300 focus:border-blue-500 focus:outline-none"
          aria-label="Switch organization"
        >
          {(organizations ?? []).map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 text-gray-400" />
      </span>
      {email && <span className="text-gray-400">· {email}</span>}
    </div>
  );
}
