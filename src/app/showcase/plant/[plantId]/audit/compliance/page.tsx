'use client';

/**
 * Showcase compliance evidence, delegates to the /demo route body (the
 * showcase layout provides the showcase dataRoot + PlantPageChrome).
 */
import DemoPage from '@/app/demo/plant/[plantId]/audit/compliance/page';

export default function ShowcaseComplianceEvidencePage() {
  return <DemoPage />;
}
