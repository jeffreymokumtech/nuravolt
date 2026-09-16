'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { usePlanFeatures } from '@/lib/billing/use-plan';
import type { Feature } from '@/lib/billing/plan';

/**
 * Client-side feature gate for dashboard sections. Renders children while the
 * plan is loading (no flash; the server 402 is the real barrier) and replaces
 * them with an upgrade panel when the org's plan lacks the feature.
 *
 * Neutral styling so it sits acceptably in both the ops chrome and light
 * settings pages.
 */
export default function UpgradeGate({
  feature,
  title,
  blurb,
  fullPage = false,
  children,
}: {
  feature: Feature;
  title?: string;
  blurb?: string;
  /** Render the lock as a standalone page (used when gating a whole route body). */
  fullPage?: boolean;
  children: React.ReactNode;
}) {
  const { features, loading } = usePlanFeatures();

  if (loading || features[feature] !== false) return <>{children}</>;

  const panel = (
    <div className="rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50">
        <Lock className="h-6 w-6 text-amber-600" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900">
        {title ?? 'Available on Business'}
      </h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-gray-600">
        {blurb ??
          'Upgrade your plan to unlock this feature for your fleet.'}
      </p>
      <div className="mt-5 flex items-center justify-center gap-3">
        <Link
          href="/pricing"
          className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          See plans
        </Link>
        {fullPage && (
          <Link
            href="/dashboard"
            className="inline-flex items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to dashboard
          </Link>
        )}
      </div>
    </div>
  );

  if (!fullPage) return panel;

  // Shell-friendly: fills the available flex column (ops shell, chat chrome)
  // instead of painting its own full-viewport gray page inside the chrome.
  return (
    <div className="flex min-h-[70vh] flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">{panel}</div>
    </div>
  );
}
