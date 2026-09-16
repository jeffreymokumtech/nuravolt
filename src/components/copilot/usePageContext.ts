'use client';

import { useEffect } from 'react';
import {
  useCopilotOptional,
  type PageContext,
} from '@/components/copilot/CopilotProvider';

/**
 * Page components call this in `useEffect` to publish what they're showing
 * into the Copilot rail. The provider stays in sync as the user navigates;
 * the chat request body and system prompt pick up the active context.
 *
 * No-op when no `<CopilotProvider>` is mounted (e.g. on /chat or marketing
 * routes), so it's safe to call from any client component.
 *
 * Pass a stable object reference (or memoize), useEffect deps compare each
 * field, not the object identity.
 */
export function usePageContext(ctx: PageContext) {
  const copilot = useCopilotOptional();

  const { plantId, plantName, inverterId, twin, section, assetType } = ctx;
  const rangeKey = ctx.range ? `${ctx.range.from}|${ctx.range.to}` : '';

  useEffect(() => {
    if (!copilot) return;
    copilot.setPageContext({
      plantId,
      plantName,
      inverterId,
      twin,
      range: ctx.range,
      section,
      assetType,
    });
    // Cleanup on unmount: clear the published context so a navigation to a
    // page that doesn't call this hook doesn't leave stale IDs around.
    return () => {
      copilot.setPageContext({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantId, plantName, inverterId, twin, rangeKey, section, assetType]);
}
