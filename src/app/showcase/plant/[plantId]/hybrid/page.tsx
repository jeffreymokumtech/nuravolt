'use client';

/**
 * Showcase hybrid, delegates to the /demo route body (showcase layout
 * provides the showcase dataRoot).
 */
import DemoPage from '@/app/demo/plant/[plantId]/hybrid/page';

export default function ShowcaseHybridPage() {
  return <DemoPage />;
}
