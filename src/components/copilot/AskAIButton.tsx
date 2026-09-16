'use client';

import { usePathname } from 'next/navigation';
import { useCopilotOptional, type PageContext } from '@/components/copilot/CopilotProvider';
import { usePlanFeatures } from '@/lib/billing/use-plan';

interface Props {
  /** Text that appears in the chat input when clicked. */
  seed: string | (() => string);
  /** Optional context override merged into the rail's pageContext for this seed only. */
  context?: Partial<PageContext>;
  /** "icon" = ✨, "pill" = "Ask Shams" pill. Default: pill. */
  variant?: 'icon' | 'pill';
  /** Custom label override (only honoured for pill). */
  label?: string;
  /** Extra class names for placement. */
  className?: string;
  /** Tooltip text. */
  title?: string;
}

/**
 * Drops onto any data surface to seed the Copilot rail with a context-aware
 * prompt. Renders nothing when no <CopilotProvider> is mounted (e.g. on
 * marketing routes), so it's always safe to embed in shared components.
 */
export function AskAIButton({
  seed,
  context,
  variant = 'pill',
  label,
  className = '',
  title,
}: Props) {
  const copilot = useCopilotOptional();
  const pathname = usePathname();
  const { features } = usePlanFeatures();
  if (!copilot) return null;

  // Demo/showcase surfaces stay fully unlocked; everywhere else the button
  // hides when the org's plan lacks the copilot. Renders while the plan is
  // loading (no flash) — the server-side 402 is the real enforcement.
  const demoSurface =
    pathname?.startsWith('/demo') || pathname?.startsWith('/showcase');
  if (!demoSurface && features['ai:copilot'] === false) return null;

  const handle = () => {
    const text = typeof seed === 'function' ? seed() : seed;
    copilot.seedNextMessage(text, context);
  };

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handle}
        title={title ?? 'Ask Shams'}
        aria-label={title ?? 'Ask Shams'}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 ${className}`}
      >
        <span aria-hidden>✨</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handle}
      title={title ?? 'Ask Shams about this'}
      className={`inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 ${className}`}
    >
      <span aria-hidden>✨</span>
      <span>{label ?? 'Ask Shams'}</span>
    </button>
  );
}
