'use client';

/**
 * Showcase curtailment, delegates to the /demo route body (showcase layout
 * provides the showcase dataRoot).
 */
import DemoPage from '@/app/demo/plant/[plantId]/curtailment/page';

export default function ShowcaseCurtailmentPage() {
  return <DemoPage />;
}
