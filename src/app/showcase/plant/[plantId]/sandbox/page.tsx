'use client';

/**
 * Showcase sandbox, delegates to the /demo route body (showcase layout
 * provides the showcase dataRoot).
 */
import DemoPage from '@/app/demo/plant/[plantId]/sandbox/page';

export default function ShowcaseSandboxPage() {
  return <DemoPage />;
}
