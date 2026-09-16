'use client';

import { useState } from 'react';
import { UserRoundSearch, Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';

/**
 * Fixed banner shown while a platform admin is impersonating another user
 * (session.impersonatedBy is set by the Better Auth admin plugin). Renders
 * nothing for normal sessions.
 */
export default function ImpersonationBanner() {
  const { data } = authClient.useSession();
  const [busy, setBusy] = useState(false);

  const impersonatedBy = (data?.session as any)?.impersonatedBy;
  if (!impersonatedBy) return null;

  return (
    <div className="sticky top-0 z-[60] flex items-center justify-center gap-3 bg-violet-700 px-4 py-1.5 text-sm text-white">
      <UserRoundSearch className="h-4 w-4" />
      <span>
        Impersonating <strong>{data?.user?.email}</strong>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await authClient.admin.stopImpersonating();
          window.location.href = '/admin/orgs';
        }}
        className="rounded-md bg-white/15 px-2.5 py-0.5 text-xs font-medium hover:bg-white/25 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Stop'}
      </button>
    </div>
  );
}
