'use client';

import { QUALITY_COLORS } from './constants';

/**
 * QualitySkeleton — light-system loading placeholder for DQ hub tabs.
 * Replaces the bare blue spinner so loading states share the card language.
 */

export default function QualitySkeleton({ title }: { title?: string }) {
  return (
    <div
      className="rounded-xl border bg-white p-5"
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
      aria-busy="true"
      aria-live="polite"
    >
      {title && (
        <p className="mb-4 text-xs" style={{ color: QUALITY_COLORS.text.muted }}>
          {title}
        </p>
      )}
      <div className="space-y-3">
        {[92, 78, 84, 60].map((w, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded"
            style={{
              width: `${w}%`,
              backgroundColor: QUALITY_COLORS.background.hover,
            }}
          />
        ))}
      </div>
    </div>
  );
}
