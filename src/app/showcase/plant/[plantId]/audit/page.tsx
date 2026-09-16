'use client';

/**
 * Showcase audit overview, delegates to the /demo route body (the showcase
 * layout provides the showcase dataRoot + PlantPageChrome).
 */
import DemoPage from '@/app/demo/plant/[plantId]/audit/page';

export default function ShowcaseAuditOverviewPage() {
  return <DemoPage />;
}
