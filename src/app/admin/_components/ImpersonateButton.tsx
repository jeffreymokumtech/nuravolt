'use client';

import { useState } from 'react';
import { UserRoundSearch, Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

/**
 * Start impersonating a user (Better Auth admin plugin) and land on their
 * dashboard. Full page load so every provider refetches as the target user.
 * The impersonated session's activeOrganizationId is pinned to the target's
 * oldest membership by the session-create hook.
 */
export default function ImpersonateButton({ userId, label }: { userId: string; label?: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const { error } = await authClient.admin.impersonateUser({ userId });
        if (error) {
          alert(error.message || 'Impersonation failed');
          setBusy(false);
          return;
        }
        window.location.href = '/dashboard';
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
      title="Sign in as this user (1h impersonation session)"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRoundSearch className="h-3.5 w-3.5" />}
      {label ?? 'Impersonate'}
    </button>
  );
}
