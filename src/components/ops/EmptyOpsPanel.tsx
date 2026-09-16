import Link from 'next/link';
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

/**
 * Shared empty-state panel for fixture-bound routes.
 * Renders a centered vertical stack: icon + reason (mono) + suggestion + optional CTA.
 */

interface EmptyOpsPanelProps {
  reason: string;
  suggestion?: string;
  icon?: ReactNode;
  cta?: { label: string; href: string };
}

export default function EmptyOpsPanel({
  reason,
  suggestion,
  icon,
  cta,
}: EmptyOpsPanelProps) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-md border px-6 py-10 text-center"
      style={{
        background: 'var(--ops-panel)',
        borderColor: 'var(--ops-hair)',
        minHeight: 280,
      }}
    >
      <div
        className="mb-4 flex items-center justify-center"
        style={{ color: 'var(--ops-muted)' }}
        aria-hidden="true"
      >
        {icon ?? <Inbox size={48} strokeWidth={1.25} />}
      </div>
      <div
        className="font-mono text-sm"
        style={{ color: 'var(--ops-bright)' }}
      >
        {reason}
      </div>
      {suggestion && (
        <div
          className="mt-2 max-w-md text-xs leading-relaxed"
          style={{ color: 'var(--ops-muted)' }}
        >
          {suggestion}
        </div>
      )}
      {cta && (
        <Link
          href={cta.href}
          className="mt-5 font-mono text-xs underline underline-offset-4 transition-opacity hover:opacity-80"
          style={{ color: 'var(--ops-info)' }}
        >
          {cta.label}
        </Link>
      )}
    </div>
  );
}
