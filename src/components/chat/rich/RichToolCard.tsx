'use client';

import { useState, type ReactNode } from 'react';

/**
 * Shared shell for rich tool-result cards inside chat bubbles. Light chat
 * styling (gray/blue) on purpose — `.ops-legacy` retones it in the ops shell
 * including dark mode. Every rich card keeps the raw JSON reachable through
 * the "data" disclosure so the pretty view never hides the source of truth.
 */
export function RichToolCard({
  title,
  badge,
  badgeTone = 'info',
  children,
  raw,
}: {
  title: ReactNode;
  badge?: ReactNode;
  badgeTone?: 'ok' | 'warn' | 'alarm' | 'info';
  children: ReactNode;
  /** Raw tool output for the disclosure. */
  raw?: unknown;
}) {
  const [showRaw, setShowRaw] = useState(false);

  const badgeClass = {
    ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    warn: 'bg-amber-50 text-amber-700 ring-amber-200',
    alarm: 'bg-red-50 text-red-700 ring-red-200',
    info: 'bg-blue-50 text-blue-700 ring-blue-200',
  }[badgeTone];

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-200 bg-white text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2">
        <span className="font-medium text-gray-900">{title}</span>
        {badge && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${badgeClass}`}>
            {badge}
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">{children}</div>
      {raw != null && (
        <div className="border-t border-gray-100 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setShowRaw((s) => !s)}
            className="text-[10px] font-medium text-gray-400 hover:text-blue-600"
          >
            {showRaw ? 'hide data' : 'data'}
          </button>
          {showRaw && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-600">
              {JSON.stringify(raw, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Small stat cell used across rich cards. */
export function StatCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="font-mono text-[12px] font-semibold text-gray-900">{value}</div>
    </div>
  );
}
