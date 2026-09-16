'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { QUALITY_COLORS } from './constants';

/**
 * QualityEmptyState — light-system empty/error surface for the DQ hub
 * (the light equivalent of EmptyOpsPanel). States the reason plainly and,
 * when useful, what would make data appear.
 */

interface QualityEmptyStateProps {
  reason: string;
  suggestion?: string;
  icon?: LucideIcon;
  /** Optional action slot (e.g. a Retry button). */
  action?: ReactNode;
}

export default function QualityEmptyState({
  reason,
  suggestion,
  icon: Icon = Inbox,
  action,
}: QualityEmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border bg-white px-6 py-10 text-center"
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
    >
      <Icon
        className="mb-3 h-8 w-8"
        style={{ color: QUALITY_COLORS.text.muted }}
        aria-hidden="true"
      />
      <p className="text-sm font-medium" style={{ color: QUALITY_COLORS.text.primary }}>
        {reason}
      </p>
      {suggestion && (
        <p
          className="mt-1.5 max-w-md text-xs leading-relaxed"
          style={{ color: QUALITY_COLORS.text.secondary }}
        >
          {suggestion}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
