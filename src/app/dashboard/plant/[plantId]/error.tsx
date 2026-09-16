'use client';

import { useEffect } from 'react';

/**
 * Segment-level error boundary for a plant screen. An uncaught throw in one
 * panel is contained here instead of escalating to the full-page root error and
 * blowing away the ops shell.
 */
export default function PlantSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[plant-segment] render error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h2 className="text-base font-semibold text-gray-900">This screen could not load</h2>
        <p className="mt-2 text-sm text-gray-500">
          Something went wrong rendering this panel. The rest of the app is unaffected. Try again,
          or switch to another screen from the navigation.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
