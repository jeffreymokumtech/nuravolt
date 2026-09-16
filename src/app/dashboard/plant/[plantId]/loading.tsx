/**
 * Segment-level loading skeleton for plant screens, shown during route
 * transitions so the shell does not sit blank while the next screen streams.
 */
export default function PlantSegmentLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-8">
      <div
        className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-500"
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}
