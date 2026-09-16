'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/helpers/utils';

/**
 * Small, consistent "back to parent" link for the standalone (non-ops-chrome)
 * authenticated pages — settings, data hub, chat, onboarding status. Ops-chrome
 * pages already get a clickable breadcrumb from OpsCommandBar / OpsBreadcrumb.
 * Defaults to the fleet home so no screen is ever a dead end.
 */
export default function BackLink({
  href = '/dashboard',
  label = 'Back to dashboard',
  className,
}: {
  href?: string;
  label?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900',
        className,
      )}
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </Link>
  );
}
